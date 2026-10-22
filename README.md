# DayFrame

相機商品網站，含訂購、訂單管理、CSV匯入、FAQ及售後案件服務。

## 檔案

- `index.html`：完整前台及管理介面，CSS、JavaScript與必要媒體已嵌入。
- `assets/`：圖片與廣告影片備援檔案。
- `dayframe-admin/server.cjs`：Node.js HTTP及訂單服務。
- `dayframe-admin/support.cjs`：FAQ、售後與案件服務。
- `package.json`：Node.js版本與啟動指令。

## 本機執行

需要Node.js 24，執行 `npm start`，開啟 `http://127.0.0.1:4318/`。
這份上傳版不包含預設帳密，新的本機資料庫需先在 `/#admin` 建立管理員。
原有電腦的帳號、訂單、案件與附件不包含在此儲存庫。

## 公開部署

這是從現有本機專案整理的程式碼上傳包，尚未調整為雲端部署版本。
服務目前綁定127.0.0.1並驗證本機來源；上傳GitHub不會自動公開完整網站。
正式部署還需設定公開來源、服務監聽、HTTPS、管理員初始化與持久資料庫。
GitHub Pages只能提供靜態內容，無法執行本專案Node.js與SQLite後端。

請勿上傳資料庫、顧客附件、備份、測試資料、密鑰或管理員初始帳密檔。
