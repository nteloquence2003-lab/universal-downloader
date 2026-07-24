/**
 * 萬用下載器 — 後端（Node）
 * 多數平台：只轉直連（流量不經本站）
 * Bilibili／需合併影音／雲端 IP 被擋：本站代抓
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const cors = require("cors");
const youtubeDl = require("youtube-dl-exec");
const ffmpegPath = require("ffmpeg-static");
const { Innertube, UniversalCache } = require("youtubei.js");

const ROOT = __dirname;
const STATIC = path.join(ROOT, "static");
const PORT = Number(process.env.PORT) || 8787;
const TMP_ROOT = path.join(os.tmpdir(), "wanyong-dl");
const APP_VERSION = "2026-07-24-yt3";

let youtubeClientPromise = null;
function getYouTubeClient() {
  if (!youtubeClientPromise) {
    const opts = {
      cache: new UniversalCache(false),
      retrieve_player: true,
      generate_session_locally: true,
    };
    // 可在 Render → Environment 設定 YT_COOKIE（瀏覽器 Cookie 字串）
    if (process.env.YT_COOKIE) {
      opts.cookie = process.env.YT_COOKIE;
    }
    youtubeClientPromise = Innertube.create(opts);
  }
  return youtubeClientPromise;
}

const SUPPORTED_HINTS = [
  "YouTube",
  "Facebook",
  "TikTok",
  "抖音",
  "Bilibili",
  "小紅書",
  "Instagram",
  "X / Twitter",
  "Vimeo",
];

const QUALITY_PRESETS = {
  best: "最佳畫質",
  1080: "1080p",
  720: "720p",
  480: "480p",
};

const app = express();
app.use(cors());
app.use(express.json({ limit: "32kb" }));
app.use("/static", express.static(STATIC));

fs.mkdirSync(TMP_ROOT, { recursive: true });

function normalizeUrl(raw) {
  const url = String(raw || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("請輸入以 http:// 或 https:// 開頭的完整連結");
  }
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("連結格式不正確");
  }
  if (!host) throw new Error("連結格式不正確");
  return url;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function isYouTube(url) {
  const h = hostOf(url);
  return h === "youtu.be" || /(^|\.)youtube\.com$/i.test(h) || /(^|\.)youtube-nocookie\.com$/i.test(h);
}

function isBilibili(url) {
  const h = hostOf(url);
  return (
    h === "b23.tv" ||
    h === "bili2233.cn" ||
    /(^|\.)bilibili\.(com|tv|cn)$/i.test(h)
  );
}

/** 這些平台在雲端常需本站代抓（影音分離或防爬） */
function needsServerDownload(url) {
  return isBilibili(url) || isYouTube(url);
}

function heightOf(fmt) {
  if (typeof fmt.height === "number" && fmt.height > 0) return fmt.height;
  const note = String(fmt.format_note || "");
  const m = note.match(/(\d{3,4})p/i);
  return m ? Number(m[1]) : 0;
}

function extOf(fmt) {
  return String(fmt.ext || "mp4").toLowerCase();
}

function filesizeOf(fmt) {
  for (const key of ["filesize", "filesize_approx"]) {
    const size = fmt[key];
    if (typeof size === "number" && size > 0) return Math.floor(size);
  }
  return null;
}

function labelVideo(fmt, height, hasAudio) {
  const parts = [];
  if (height) parts.push(`${height}p`);
  else parts.push(String(fmt.format_note || fmt.format_id || "video"));
  parts.push(extOf(fmt).toUpperCase());
  if (!hasAudio) parts.push("無音訊");
  return parts.join(" · ");
}

function labelAudio(abr, ext) {
  if (typeof abr === "number" && abr > 0) {
    return `${Math.floor(abr)} kbps · ${ext.toUpperCase()}`;
  }
  return `音訊 · ${ext.toUpperCase()}`;
}

function pickVideoFormats(formats, quality) {
  const candidates = [];
  for (const f of formats) {
    if (!f.url) continue;
    const vcodec = f.vcodec || "none";
    const acodec = f.acodec || "none";
    if (vcodec === "none") continue;
    const height = heightOf(f);
    if (quality !== "best") {
      const target = Number(quality);
      if (height && height > target) continue;
    }
    const hasAudio = acodec !== "none";
    candidates.push({
      format_id: String(f.format_id),
      ext: extOf(f),
      height: height || null,
      fps: f.fps ?? null,
      vcodec,
      acodec,
      has_audio: hasAudio,
      filesize: filesizeOf(f),
      url: f.url,
      label: labelVideo(f, height, hasAudio),
    });
  }

  const withAudio = candidates.filter((c) => c.has_audio);
  const pool = withAudio.length ? withAudio : candidates;

  const target = quality === "best" ? 10000 : Number(quality);
  pool.sort((a, b) => {
    const ha = a.height || 0;
    const hb = b.height || 0;
    const dist = Math.abs(target - ha) - Math.abs(target - hb);
    if (dist) return dist;
    return (b.filesize || 0) - (a.filesize || 0);
  });
  return pool;
}

function pickAudioFormats(formats) {
  const candidates = [];
  for (const f of formats) {
    if (!f.url) continue;
    const vcodec = f.vcodec || "none";
    const acodec = f.acodec || "none";
    if (vcodec !== "none" || acodec === "none") continue;
    const abr = f.abr || f.tbr || null;
    const ext = extOf(f);
    candidates.push({
      format_id: String(f.format_id),
      ext,
      abr,
      acodec,
      filesize: filesizeOf(f),
      url: f.url,
      label: labelAudio(abr, ext),
    });
  }
  candidates.sort((a, b) => (b.abr || 0) - (a.abr || 0));
  return candidates;
}

function safeFilename(title) {
  const cleaned = String(title || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  return (cleaned || "download").slice(0, 120);
}

function uniqueOptions(options, limit = 8) {
  const seen = new Set();
  const out = [];
  for (const opt of options) {
    if (seen.has(opt.url)) continue;
    seen.add(opt.url);
    out.push(opt);
    if (out.length >= limit) break;
  }
  return out;
}

function refererFor(url) {
  if (isBilibili(url)) return "https://www.bilibili.com/";
  if (isYouTube(url)) return "https://www.youtube.com/";
  try {
    return new URL(url).origin + "/";
  } catch {
    return "https://www.youtube.com/";
  }
}

function ytdlBaseOpts(url) {
  const opts = {
    noWarnings: true,
    noCheckCertificates: true,
    noPlaylist: true,
    addHeader: [
      "User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      `Referer:${refererFor(url)}`,
      "Accept-Language:zh-TW,zh;q=0.9,en;q=0.8",
    ],
  };
  if (ffmpegPath) opts.ffmpegLocation = ffmpegPath;

  // 雲端 IP 常被 YouTube 擋：改用較不易觸發登入牆的客戶端
  if (isYouTube(url)) {
    opts.extractorArgs = "youtube:player_client=android,web";
  }

  // 可選：在 Render 設定環境變數 COOKIES_FILE（Netscape cookies.txt 內容路徑）
  const cookiesFile = process.env.COOKIES_FILE;
  if (cookiesFile && fs.existsSync(cookiesFile)) {
    opts.cookies = cookiesFile;
  }

  return opts;
}

function formatSelector(media, quality) {
  if (media === "audio") {
    return "ba/bestaudio/best";
  }
  if (quality === "best") {
    return "bv*+ba/b";
  }
  const h = Number(quality);
  return `bv*[height<=${h}]+ba/b[height<=${h}]/wv*+ba/w`;
}

function youtubeVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.replace(/^www\./, "") === "youtu.be") {
      return u.pathname.replace(/^\//, "").split("/")[0] || null;
    }
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.findIndex((p) => ["shorts", "embed", "live", "v"].includes(p));
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  } catch {
    /* ignore */
  }
  return null;
}

function mapQualityToYoutubei(quality) {
  if (quality === "1080") return "1080p";
  if (quality === "720") return "720p";
  if (quality === "480") return "480p";
  return "best";
}

async function extractYouTubeInfo(url) {
  const id = youtubeVideoId(url);
  if (!id) throw new Error("無法辨識 YouTube 影片 ID");
  const yt = await getYouTubeClient();
  const info = await yt.getBasicInfo(id);
  const basic = info.basic_info || {};
  return {
    id,
    title: basic.title || "YouTube 影片",
    thumbnail: basic.thumbnail?.[0]?.url || basic.thumbnails?.[0]?.url || null,
    duration: basic.duration || null,
    extractor: "youtubei",
    webpage_url: url,
  };
}

async function downloadYouTubeToFile(url, media, quality, outPath) {
  const id = youtubeVideoId(url);
  if (!id) throw new Error("無法辨識 YouTube 影片 ID");
  const yt = await getYouTubeClient();
  const q = mapQualityToYoutubei(quality);
  const clients = ["ANDROID", "IOS", "TV_EMBEDDED", "TV", "MWEB", "WEB"];
  let lastErr = null;

  for (const client of clients) {
    try {
      const stream = await yt.download(id, {
        type: media === "audio" ? "audio" : "video+audio",
        quality: q,
        format: media === "audio" ? "any" : "mp4",
        client,
      });
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(outPath);
        stream.on("error", reject);
        ws.on("error", reject);
        ws.on("finish", resolve);
        if (typeof stream.pipe === "function") {
          stream.pipe(ws);
        } else {
          (async () => {
            try {
              for await (const chunk of stream) {
                if (!ws.write(Buffer.from(chunk))) {
                  await new Promise((r) => ws.once("drain", r));
                }
              }
              ws.end();
            } catch (e) {
              reject(e);
            }
          })();
        }
      });
      const size = fs.statSync(outPath).size;
      if (size < 1024) throw new Error("下載檔案過小，可能失敗");
      return;
    } catch (err) {
      lastErr = err;
      try {
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      } catch {
        /* ignore */
      }
    }
  }

  try {
    const outTemplate = outPath.replace(/\.[^.]+$/, ".%(ext)s");
    await youtubeDl(url, {
      ...ytdlBaseOpts(url),
      format: formatSelector(media, quality),
      output: outTemplate,
      mergeOutputFormat: media === "audio" ? "m4a" : "mp4",
      restrictFilenames: true,
      extractorArgs: "youtube:player_client=android,web",
    });
    const dir = path.dirname(outPath);
    const files = fs.readdirSync(dir).filter((n) => n.startsWith("file."));
    if (files.length) {
      const found = path.join(dir, files[0]);
      if (found !== outPath) fs.renameSync(found, outPath);
      if (fs.statSync(outPath).size >= 1024) return;
    }
  } catch (err) {
    lastErr = err;
  }

  const raw = String(lastErr?.message || lastErr || "");
  if (/sign in|bot|login|cookie/i.test(raw)) {
    throw new Error(
      "YouTube 擋住雲端主機（防機器人）。請改用本機 npm start，或到 Render → Environment 設定 YT_COOKIE 後再部署。"
    );
  }
  throw lastErr || new Error("YouTube 下載失敗");
}

async function extractInfo(url) {
  if (isYouTube(url)) {
    return extractYouTubeInfo(url);
  }
  const info = await youtubeDl(url, {
    ...ytdlBaseOpts(url),
    dumpSingleJson: true,
    skipDownload: true,
    preferFreeFormats: true,
  });
  if (!info) throw new Error("無法解析此連結");
  if (info._type === "playlist" && Array.isArray(info.entries)) {
    const entry = info.entries.find(Boolean);
    if (!entry) throw new Error("播放清單為空");
    return entry;
  }
  return info;
}

function friendlyError(err) {
  const raw = String(err?.stderr || err?.message || err);
  if (/YouTube 擋住雲端主機/i.test(raw)) {
    return raw;
  }
  if (/Sign in to confirm|confirm you.?re not a bot|not a bot|bot check/i.test(raw)) {
    return "YouTube 擋住雲端主機（防機器人）。請改用本機下載，或設定 YT_COOKIE。";
  }
  if (/geo-restricted|VPN|proxy/i.test(raw)) {
    return "此影片有地區限制，目前雲端網路無法取得。可換公開影片再試。";
  }
  if (/members only|付费|付費|會員專屬/i.test(raw)) {
    return "此影片需要會員才能下載。";
  }
  if (/private video|Private video|非公開|私人/i.test(raw)) {
    return "這是私人／非公開影片，無法下載。";
  }
  if (/Unsupported URL|No video/i.test(raw)) {
    return "無法辨識此連結，請確認是完整的公開影片網址。";
  }
  if (/HTTP Error 403|403: Forbidden/i.test(raw)) {
    return "來源拒絕存取（403）。雲端 IP 可能被擋，請換公開短影音或本機下載。";
  }
  if (/\bcookies?\b.*(?:required|needed)|login required|請先登入/i.test(raw)) {
    return "YouTube 要求登入驗證。雲端常被擋：請本機下載，或在 Render 設定 YT_COOKIE。";
  }
  return raw.slice(0, 400);
}

function buildServerOption(pageUrl, media, quality, label) {
  const qs = new URLSearchParams({
    url: pageUrl,
    media,
    quality,
  });
  return {
    format_id: "server",
    ext: media === "audio" ? "m4a" : "mp4",
    height: quality === "best" ? null : Number(quality),
    has_audio: true,
    filesize: null,
    url: `/api/download?${qs.toString()}`,
    label,
    via: "server",
  };
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    supported: SUPPORTED_HINTS,
    qualities: QUALITY_PRESETS,
    ffmpeg: Boolean(ffmpegPath),
  });
});

app.post("/api/resolve", async (req, res) => {
  try {
    const media = req.body?.media === "audio" ? "audio" : "video";
    const quality = ["best", "1080", "720", "480"].includes(req.body?.quality)
      ? req.body.quality
      : "best";
    const url = normalizeUrl(req.body?.url);

    // YouTube：改走 youtubei（雲端較不易被當成機器人）
    if (isYouTube(url)) {
      const info = await extractYouTubeInfo(url);
      return res.json({
        title: info.title,
        filename: safeFilename(info.title),
        thumbnail: info.thumbnail,
        duration: info.duration,
        extractor: info.extractor,
        webpage_url: url,
        media,
        quality,
        options: [
          buildServerOption(
            url,
            media,
            quality,
            media === "audio" ? "下載聲音（YouTube 代抓）" : "下載影片含聲音（YouTube 代抓）"
          ),
        ],
        note: "YouTube 由本站代抓後給你下載（雲端防爬較嚴）。",
        version: APP_VERSION,
      });
    }

    const relay = needsServerDownload(url);

    if (relay) {
      let title = "影片";
      let thumbnail = null;
      let duration = null;
      let extractor = "unknown";
      try {
        const info = await extractInfo(url);
        title = info.title || title;
        thumbnail = info.thumbnail || null;
        duration = info.duration ?? null;
        extractor = info.extractor_key || info.extractor || extractor;
      } catch (previewErr) {
        console.warn("preview:", friendlyError(previewErr));
      }

      return res.json({
        title,
        filename: safeFilename(title),
        thumbnail,
        duration,
        extractor,
        webpage_url: url,
        media,
        quality,
        options: [
          buildServerOption(
            url,
            media,
            quality,
            media === "audio" ? "下載聲音（本站代抓）" : "下載影片含聲音（本站代抓）"
          ),
        ],
        note: isBilibili(url)
          ? "Bilibili 影音通常分開，且直連會被擋。此平台改由本站代抓並合併後給你下載。"
          : "此平台在雲端改由本站代抓，較穩定。",
        version: APP_VERSION,
      });
    }

    const info = await extractInfo(url);
    const formats = info.formats || [];
    const title = info.title || "未命名";

    let options;
    if (media === "audio") {
      options = pickAudioFormats(formats);
      if (!options.length) {
        options = pickVideoFormats(formats, "best")
          .filter((o) => o.has_audio)
          .slice(0, 5)
          .map((o) => ({
            ...o,
            label: `${o.label}（含影像，請另轉 MP3）`,
          }));
      }
    } else {
      options = pickVideoFormats(formats, quality);
    }

    const usable = options.filter((o) => o.has_audio !== false);
    if (!usable.length) {
      return res.json({
        title,
        filename: safeFilename(title),
        thumbnail: info.thumbnail || null,
        duration: info.duration ?? null,
        extractor: info.extractor_key || info.extractor || "unknown",
        webpage_url: info.webpage_url || url,
        media,
        quality,
        options: [
          buildServerOption(
            url,
            media,
            quality,
            media === "audio" ? "下載聲音（本站代抓）" : "下載影片含聲音（本站代抓）"
          ),
        ],
        note: "此平台沒有可直連的合併檔，已改由本站代抓並合併影音。",
        version: APP_VERSION,
      });
    }

    const unique = uniqueOptions(usable);
    res.json({
      title,
      filename: safeFilename(title),
      thumbnail: info.thumbnail || null,
      duration: info.duration ?? null,
      extractor: info.extractor_key || info.extractor || "unknown",
      webpage_url: info.webpage_url || url,
      media,
      quality,
      options: unique,
      note: "本站只轉換連結；下載直連影片來源，流量不經過本站。",
      version: APP_VERSION,
    });
  } catch (err) {
    res.status(400).json({ detail: `解析失敗：${friendlyError(err)}`, version: APP_VERSION });
  }
});

app.get("/api/download", async (req, res) => {
  let workDir = null;
  try {
    const media = req.query?.media === "audio" ? "audio" : "video";
    const quality = ["best", "1080", "720", "480"].includes(req.query?.quality)
      ? String(req.query.quality)
      : "best";
    const url = normalizeUrl(req.query?.url);

    workDir = fs.mkdtempSync(path.join(TMP_ROOT, "job-"));
    const ext = media === "audio" ? "m4a" : "mp4";
    const filePath = path.join(workDir, `file.${ext}`);

    if (isYouTube(url)) {
      await downloadYouTubeToFile(url, media, quality, filePath);
    } else {
      const outTemplate = path.join(workDir, "file.%(ext)s");
      await youtubeDl(url, {
        ...ytdlBaseOpts(url),
        format: formatSelector(media, quality),
        output: outTemplate,
        mergeOutputFormat: media === "audio" ? "m4a" : "mp4",
        restrictFilenames: true,
      });
      const files = fs.readdirSync(workDir).filter((n) => !n.endsWith(".part"));
      if (!files.length) throw new Error("下載完成但找不到檔案");
      const found = path.join(workDir, files[0]);
      if (found !== filePath) {
        fs.renameSync(found, filePath);
      }
    }

    const downloadName = `download_${Date.now()}.${ext}`;
    res.download(filePath, downloadName, (err) => {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      if (err && !res.headersSent) {
        res.status(500).json({ detail: "傳送檔案失敗" });
      }
    });
  } catch (err) {
    if (workDir) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    if (!res.headersSent) {
      res.status(400).json({ detail: `下載失敗：${friendlyError(err)}`, version: APP_VERSION });
    }
  }
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(STATIC, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`萬用下載器 → http://127.0.0.1:${PORT}`);
});
