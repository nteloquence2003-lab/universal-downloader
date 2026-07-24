# AI爆款短影音實戰班

貼上網址取得下載。本機使用較完整；免費雲端常被平台封鎖機房 IP。

## 本機啟動（建議）

**最簡單：** 雙擊 `啟動下載器.bat`  
會自動 `npm start` 並打開瀏覽器。

或手動：

```bash
npm install
npm start
```

本機啟動時會自動開啟：http://127.0.0.1:8787  
（雲端／Docker 不會自動開瀏覽器）

若不要自動開網頁：`set OPEN_BROWSER=0` 再執行 `npm start`。

## YouTube 自動改道

線上版不會要求使用者填代理。後端會依序嘗試：

1. **PO Token**（[bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)）+ yt-dlp
2. **Piped** 公開 API
3. **Invidious** 公開 API  
4. youtubei.js

成功時回傳下載按鈕；技術細節都在後端。

Docker 會同時啟動 PO Token 服務（`:4416`）。環境變數：

```text
YT_DLP_POT_ENABLED=1
YT_DLP_POT_BASE_URL=http://127.0.0.1:4416
YT_DLP_BIN=/usr/local/bin/yt-dlp
PIPED_APIS=https://pipedapi.kavin.rocks,...
INVIDIOUS_APIS=https://inv.nadeko.net,...
DOWNLOAD_PROXY=http://帳號:密碼@主機:埠
```

PO Token **不保證**一定過 YouTube 機房封鎖；若仍失敗請用本機 `npm start`。

## GitHub

https://github.com/nteloquence2003-lab/universal-downloader
