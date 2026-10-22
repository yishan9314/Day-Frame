# DayFrame 網站程式與後台資料快照

此包依專案擁有者要求包含目前後台業務資料；原本電腦上的程式、帳號與資料庫沒有變更。

## 上傳項目

將解壓後的 `index.html`、`assets/`、`dayframe-admin/`、`package.json`、`README.md`、`.gitignore` 上傳至儲存庫根目錄，保留資料夾結構。

`dayframe-admin/data/dayframe.sqlite` 為可供原有服務讀取的完整業務資料庫快照。
`dayframe-admin/data/business-data.json` 為可在GitHub檢視的業務資料匯出；附件（若有）以Base64表示，不含案件驗證雜湊。
`snapshot-manifest.json` 記錄各資料表筆數、時間與資料庫SHA-256。

## 資料範圍

包含訂單、舊客訴紀錄、售後案件、公開回覆、內部備註、附件、FAQ、政策、稽核及通知歷程。

- records: 1
- support_cases: 1
- support_events: 2
- support_files: 0
- support_faq: 16
- support_policies: 3
- support_audit: 3
- support_outbox: 0

管理員帳號、密碼雜湊、初始帳密檔、暫時結帳權杖、環境密鑰、執行中工作階段、日誌、PID、WAL/SHM與測試資料均已排除。SQLite快照保留既有案件驗證雜湊以維持既有案件驗證相容性；原文私人查詢金鑰沒有保存或匯出。

公開儲存庫或以GitHub Pages發布這個資料夾時，這些業務資料（包括內部備註及附件）也可能被任何人下載。本包依你的要求保留實際業務內容，沒有改成虛構資料。

## 本機執行與登入

需要Node.js 24，執行 `npm start` 後開啟 `http://127.0.0.1:4318/`。
此快照已移除管理員登入資料。在這份複本第一次執行時，請從 `/#admin` 自行建立新的管理員帳號與至少12字密碼；原電腦帳密維持原樣。

## GitHub與部署

上傳資料庫只保存這次匯出的快照，不會自動同步原電腦後續新增或修改的資料。JSON匯出與SQLite亦是同一時間點的兩種表示；修改JSON不會更新SQLite。
GitHub Pages無法執行目前的Node.js與SQLite後台。此程式仍為本機架構，正式上線還需調整公開來源、主機監聽、HTTPS、管理員初始化及永久儲存設定。
