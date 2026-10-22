'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const ROOT=path.resolve(__dirname,'..'),DATA=process.env.DAYFRAME_DATA?path.resolve(process.env.DAYFRAME_DATA):path.join(__dirname,'data');
const PORT=Number(process.env.DAYFRAME_PORT||4318),ORIGIN=`http://127.0.0.1:${PORT}`;
fs.mkdirSync(DATA,{recursive:true});
const db=new DatabaseSync(path.join(DATA,'dayframe.sqlite'));
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS users(username TEXT PRIMARY KEY,salt TEXT NOT NULL,hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS records(kind TEXT,id TEXT,data TEXT,version INTEGER NOT NULL DEFAULT 1,updated TEXT NOT NULL,PRIMARY KEY(kind,id));');
db.exec('CREATE TABLE IF NOT EXISTS checkout_requests(token TEXT PRIMARY KEY,expires INTEGER NOT NULL,order_id TEXT,payload_hash TEXT)');
if(!db.prepare('SELECT username FROM users LIMIT 1').get()){
 const accountFile=path.join(__dirname,'initial-account.json');
 if(fs.existsSync(accountFile)){const a=JSON.parse(fs.readFileSync(accountFile,'utf8'));db.prepare('INSERT INTO users(username,salt,hash) VALUES(?,?,?)').run(a.username,a.salt,a.hash)}
}
const sessions=new Map(),attempts=new Map(),previews=new Map();
const lists={payment_status:['未付款','已付款','已退款'],order_status:['待處理','備貨中','已出貨','已完成','已取消'],category:['商品問題','物流問題','退換貨','付款問題','其他'],priority:['一般','高','緊急'],status:['待處理','處理中','待客戶回覆','已結案']};
const fields={orders:['order_id','customer_name','email','phone','product','quantity','unit_price','payment_status','order_status','order_date','note'],complaints:['complaint_id','order_id','customer_name','category','description','priority','status','reply']};
const labels={order_id:'訂單編號',customer_name:'顧客姓名',email:'Email',phone:'電話',product:'商品',quantity:'數量',unit_price:'單價',payment_status:'付款狀態',order_status:'訂單狀態',order_date:'訂單日期',note:'備註',complaint_id:'客訴編號',category:'問題類型',description:'問題描述',priority:'優先程度',status:'處理狀態',reply:'處理紀錄'};
class AppError extends Error{constructor(message,status=400){super(message);this.status=status}}
function fail(message,status){throw new AppError(message,status)}
function all(kind){return db.prepare('SELECT data,version,updated FROM records WHERE kind=? ORDER BY updated DESC,id').all(kind).map(r=>({...JSON.parse(r.data),version:r.version,updated:r.updated}))}
function exists(kind,id){return db.prepare('SELECT version FROM records WHERE kind=? AND id=?').get(kind,id)}
function normalize(kind,row){
 if(!fields[kind])fail('不支援的資料類型');
 const x={};for(const key of fields[kind]){x[key]=String(row[key]??'').trim();if(x[key].length>(['description','reply','note'].includes(key)?4000:200))fail(`${labels[key]}過長`)}
 const required=kind==='orders'?['order_id','customer_name','product']:['complaint_id','customer_name','description'];
 for(const key of required)if(!x[key])fail(`請填寫${labels[key]}`);
 const id=kind==='orders'?x.order_id:x.complaint_id;
 if(!/^[\p{L}\p{N}_-]{1,60}$/u.test(id))fail('編號限60字以內的文字、數字、底線或連字號');
 if(kind==='orders'){
  if(!/^\d+$/.test(x.quantity)||Number(x.quantity)<1||Number(x.quantity)>9999)fail('數量須為1至9999的整數');
  if(!/^\d+(\.\d{1,2})?$/.test(x.unit_price)||Number(x.unit_price)>10000000)fail('單價須為0至10000000，最多兩位小數');
  x.quantity=Number(x.quantity);x.unit_price=Number(x.unit_price);
  if(x.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.email))fail('Email格式不正確');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(x.order_date)||!Number.isFinite(Date.parse(x.order_date))||new Date(x.order_date).toISOString().slice(0,10)!==x.order_date)fail('訂單日期須為有效的YYYY-MM-DD');
  for(const key of ['payment_status','order_status'])if(!lists[key].includes(x[key]))fail(`${labels[key]}選項不正確`);
 }else{
  if(x.order_id&&!exists('orders',x.order_id))fail('找不到關聯訂單，請先建立或匯入訂單');
  for(const key of ['category','priority','status'])if(!lists[key].includes(x[key]))fail(`${labels[key]}選項不正確`);
 }
 return x;
}
function save(kind,row,version){
 const x=normalize(kind,row),id=kind==='orders'?x.order_id:x.complaint_id,found=exists(kind,id),now=new Date().toISOString();
 if(found){if(!Number.isInteger(version)||found.version!==version)fail('資料已變更或編號重複，請重新整理後再操作',409);db.prepare('UPDATE records SET data=?,version=version+1,updated=? WHERE kind=? AND id=?').run(JSON.stringify(x),now,kind,id)}
 else{if(version)fail('資料不存在',404);db.prepare('INSERT INTO records(kind,id,data,updated) VALUES(?,?,?,?)').run(kind,id,JSON.stringify(x),now)}
 return x;
}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value))}
async function body(req,limit=3*1024*1024){if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))fail('請使用JSON格式',415);let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>limit)fail('資料超過上傳大小限制',413);chunks.push(chunk)}try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))fail('資料格式錯誤');return value}catch{fail('資料格式錯誤')}}
function auth(req){const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('df_session='))?.slice(11),s=sessions.get(token);if(!s||s.expires<Date.now()){sessions.delete(token);fail('請重新登入',401)}return {token,...s}}
function newSession(res,username){const token=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomBytes(24).toString('hex');sessions.set(token,{username,csrf,expires:Date.now()+8*3600000});res.setHeader('Set-Cookie',`df_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);return {username,csrf}}
const support=require('./support.cjs')({db,auth,body,json,fail,origin:ORIGIN});
const server=http.createServer(async(req,res)=>{
 try{
  if(req.headers.host!==`127.0.0.1:${PORT}`)fail('請從本機127.0.0.1開啟',403);
  const url=new URL(req.url,ORIGIN),p=url.pathname;
  if(p.startsWith('/api/')){
   if(req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&req.headers.origin!==ORIGIN))fail('來源不允許',403);
   if(req.method!=='GET'&&!req.headers.origin)fail('缺少來源驗證',403);
   if(await support(req,res,url))return;
   if(p==='/api/checkout'&&req.method==='GET'){
    db.prepare('DELETE FROM checkout_requests WHERE expires<? AND order_id IS NULL').run(Date.now());
    const token=crypto.randomBytes(32).toString('hex');db.prepare('INSERT INTO checkout_requests(token,expires) VALUES(?,?)').run(token,Date.now()+30*60000);
    return json(res,200,{token,product:'DayFrame Pocket 01 奶油粉入門套裝',unit_price:3990,max_quantity:10});
   }
   if(p==='/api/checkout'&&req.method==='POST'){
    const b=await body(req);if(typeof b.token!=='string'||b.token.length!==64)fail('訂購頁已過期，請重新載入');
    const intent=db.prepare('SELECT * FROM checkout_requests WHERE token=?').get(b.token);if(!intent)fail('訂購頁已過期，請重新載入');
    const x={};for(const key of ['customer_name','phone','email','address','note']){x[key]=String(b[key]??'').trim();if(x[key].length>(key==='note'?1500:200))fail('填寫內容過長')}
    if(!x.customer_name)fail('請填寫收件人姓名');if(!/^[0-9+()\-\s]{8,25}$/.test(x.phone))fail('請填寫有效聯絡電話');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.email))fail('請填寫有效Email');if(x.address.length<6)fail('請填寫完整收件地址');
    const quantity=Number(b.quantity);if(!Number.isInteger(quantity)||quantity<1||quantity>10)fail('每筆訂單數量限1至10台');if(b.consent!==true)fail('請同意將訂購資料送交訂單管理');
    const digest=crypto.createHash('sha256').update(JSON.stringify({...x,quantity})).digest('hex');
    if(intent.order_id){if(intent.payload_hash!==digest)fail('此訂購已送出，請重新開始一筆訂購',409);return json(res,200,{order_id:intent.order_id,quantity,unit_price:3990,total:quantity*3990,payment_status:'未付款'})}
    if(intent.expires<Date.now())fail('訂購頁已過期，請重新載入');
    const order_id='DF-'+new Date().toISOString().slice(0,10).replaceAll('-','')+'-'+crypto.randomBytes(5).toString('hex').toUpperCase();
    const order_date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei'}).format(new Date());
    db.exec('BEGIN IMMEDIATE');try{
     save('orders',{order_id,customer_name:x.customer_name,email:x.email,phone:x.phone,product:'DayFrame Pocket 01 奶油粉入門套裝',quantity,unit_price:3990,payment_status:'未付款',order_status:'待處理',order_date,note:`【網站訂購】\n收件地址：${x.address}\n付款方式：待聯繫確認\n顧客備註：${x.note||'無'}`});
     db.prepare('UPDATE checkout_requests SET order_id=?,payload_hash=? WHERE token=?').run(order_id,digest,b.token);db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e}
    return json(res,201,{order_id,quantity,unit_price:3990,total:quantity*3990,payment_status:'未付款'});
   }
   if(p==='/api/session'&&req.method==='GET'){
    const setup=!db.prepare('SELECT username FROM users LIMIT 1').get();try{const s=auth(req);return json(res,200,{setup,username:s.username,csrf:s.csrf,lists,fields,labels})}catch{return json(res,200,{setup,username:null})}
   }
   if((p==='/api/setup'||p==='/api/login')&&req.method==='POST'){
    const b=await body(req);const username=String(b.username||'').trim(),password=String(b.password||'');
    if(p==='/api/setup'){
     if(db.prepare('SELECT username FROM users LIMIT 1').get())fail('管理員已建立，請登入',409);
     if(!/^[a-zA-Z0-9_-]{3,32}$/.test(username))fail('帳號請使用3至32位英數字、底線或連字號');
     if(password.length<12||password.length>128)fail('密碼長度須為12至128字');
     const salt=crypto.randomBytes(16).toString('hex'),hash=crypto.scryptSync(password,salt,64).toString('hex');db.prepare('INSERT INTO users(username,salt,hash) VALUES(?,?,?)').run(username,salt,hash);
    }else{
     const now=Date.now(),a=attempts.get('local')||{n:0,until:now+900000};if(a.until<now){a.n=0;a.until=now+900000}if(a.n>=5)fail('登入失敗次數過多，請15分鐘後重試',429);
     const user=db.prepare('SELECT * FROM users WHERE username=?').get(username),salt=user?.salt||'invalid-salt';
     const hash=crypto.scryptSync(password.slice(0,128),salt,64),expected=user?Buffer.from(user.hash,'hex'):Buffer.alloc(64);
     if(!user||password.length>128||!crypto.timingSafeEqual(hash,expected)){a.n++;attempts.set('local',a);fail('帳號或密碼不正確',401)}attempts.delete('local');
    }
    return json(res,200,newSession(res,username));
   }
   const session=auth(req);
   if(req.method!=='GET'&&req.headers['x-csrf-token']!==session.csrf)fail('操作驗證已失效，請重新登入',403);
   if(p==='/api/logout'&&req.method==='POST'){sessions.delete(session.token);res.setHeader('Set-Cookie','df_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return json(res,200,{ok:true})}
   if(p==='/api/data'&&req.method==='GET')return json(res,200,{orders:all('orders'),complaints:all('complaints')});
   if(p==='/api/save'&&req.method==='POST'){const b=await body(req);save(b.kind,b.row,b.version);return json(res,200,{ok:true})}
   if(p==='/api/import/preview'&&req.method==='POST'){
    const b=await body(req);if(!fields[b.kind]||!Array.isArray(b.rows)||!b.rows.length||b.rows.length>1000)fail('每次請匯入1至1000筆');
    const seen=new Set(),rows=b.rows.map((r,i)=>{try{const x=normalize(b.kind,r),id=b.kind==='orders'?x.order_id:x.complaint_id;if(seen.has(id))fail('CSV內編號重複');seen.add(id);return {line:i+2,state:exists(b.kind,id)?'略過':'可匯入',row:x,message:exists(b.kind,id)?'編號已存在，不覆蓋原資料':''}}catch(e){return {line:i+2,state:'錯誤',row:r,message:e.message}}});
    const token=crypto.randomBytes(24).toString('hex');previews.set(token,{session:session.token,kind:b.kind,rows,expires:Date.now()+600000});return json(res,200,{token,rows});
   }
   if(p==='/api/import/commit'&&req.method==='POST'){
    const b=await body(req),v=previews.get(b.token);if(!v||v.session!==session.token||v.expires<Date.now())fail('預覽已過期，請重新上傳');if(v.rows.some(r=>r.state==='錯誤'))fail('請先修正CSV的所有錯誤');
    let imported=0,skipped=0;db.exec('BEGIN IMMEDIATE');try{for(const r of v.rows){const id=v.kind==='orders'?r.row.order_id:r.row.complaint_id;if(exists(v.kind,id)){skipped++;continue}save(v.kind,r.row);imported++}db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}previews.delete(b.token);return json(res,200,{imported,skipped});
   }
   fail('找不到此功能',404);
  }
  if(!['GET','HEAD'].includes(req.method))fail('不支援此操作',405);
  let target;if(p==='/'||p==='/index.html')target=path.join(ROOT,'index.html');
  else if(/^\/assets\/(camera\.png|campus\.png|user-video-poster\.png|campus\.mp4)$/.test(p)){target=path.join(ROOT,p.slice(1));if(!fs.existsSync(target))target=path.join(ROOT,'DayFrame_圖片修正版',p.slice(1))}
  else fail('找不到檔案',404);
  if(!fs.existsSync(target))fail('找不到檔案',404);
  const type={'.html':'text/html; charset=utf-8','.png':'image/png','.mp4':'video/mp4'}[path.extname(target)];
  res.writeHead(200,{'Content-Type':type,'Content-Length':fs.statSync(target).size,'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','X-Frame-Options':'DENY','Cache-Control':'no-store'});if(req.method==='HEAD')res.end();else fs.createReadStream(target).pipe(res);
 }catch(e){if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'系統暫時無法處理，請查看服務視窗'});else res.end();if(!e.status)console.error(e)}
});
setInterval(()=>{for(const [k,v] of sessions)if(v.expires<Date.now())sessions.delete(k);for(const[k,v]of previews)if(v.expires<Date.now()||!sessions.has(v.session))previews.delete(k)},60000).unref();
server.listen(PORT,'127.0.0.1',()=>{console.log(`DAY FRAME: ${ORIGIN}/#admin\nData: ${DATA}\nPress Ctrl+C to stop.`);if(process.argv.includes('--open'))require('node:child_process').spawn('cmd.exe',['/c','start','',`${ORIGIN}/#admin`],{windowsHide:true,stdio:'ignore'})});
server.on('error',e=>{if(e.code==='EADDRINUSE'&&process.argv.includes('--open')){console.log(`Opening running workspace: ${ORIGIN}/#admin`);require('node:child_process').spawn('cmd.exe',['/c','start','',`${ORIGIN}/#admin`],{windowsHide:true,stdio:'ignore'});db.close();return}console.error(e.code==='EADDRINUSE'?`Port ${PORT} is in use. Open ${ORIGIN}/#admin or stop the other service.`:e);process.exitCode=1});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{db.close();process.exit(0)}));
