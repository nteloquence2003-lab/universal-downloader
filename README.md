# 萬用下載器

貼上網址取得下載。本機使用較完整；免費雲端常被平台封鎖機房 IP。

## 本機啟動（建議）

```bash
npm install
npm start
```

開啟：http://127.0.0.1:8787

## YouTube 自動改道

線上版不會要求使用者填代理。後端會依序嘗試：

1. **Piped** 公開 API
2. **Invidious** 公開 API  
3. youtubei／yt-dlp（本站代抓）

成功時回傳直連下載網址，流量多半不經本站機房碰 YouTube。

可用環境變數自訂節點（逗號分隔）：

```text
PIPED_APIS=https://pipedapi.kavin.rocks,https://pipedapi.leptons.xyz
INVIDIOUS_APIS=https://inv.nadeko.net,https://yewtu.be
```

可選：站長自己設住宅代理給整站用（使用者不用填）：

```text
DOWNLOAD_PROXY=http://帳號:密碼@主機:埠
```

公開鏡像可能不穩或被限速，這不是「破解 YouTube」，只是換出口詢問。

## GitHub

https://github.com/nteloquence2003-lab/universal-downloader
