# 萬用下載器

貼上網址取得下載。本機使用較完整；免費雲端（如 Render）常被 YouTube／TikTok／IG 等封鎖機房 IP。

## 本機啟動（建議）

```bash
npm install
npm start
```

開啟：http://127.0.0.1:8787

## 線上版限制

Render 等免費雲端使用機房 IP，各大平台會擋，**線上版可能全部下不了**。  
這不是網站壞掉，而是平台防爬政策。

## 改 IP（代理）

網頁可展開「改 IP」填住宅代理，例如：

```text
http://帳號:密碼@主機:埠
```

也可在主機環境變數設定：

```text
DOWNLOAD_PROXY=http://帳號:密碼@主機:埠
```

免費公開代理通常無效。

## GitHub

https://github.com/nteloquence2003-lab/universal-downloader
