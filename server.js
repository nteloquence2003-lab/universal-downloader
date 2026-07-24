/**
 * 萬用下載器 — 後端（Node）
 * 多數平台：只轉直連（流量不經本站）
 * Bilibili 等：需本站代抓並合併影音（否則常無法下載／無聲音）
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const cors = require("cors");
const youtubeDl = require("youtube-dl-exec");
const ffmpegPath = require("ffmpeg-static");

const ROOT = __dirname;
const STATIC = path.join(ROOT, "static");
const PORT = Number(process.env.PORT) || 8787;
const TMP_ROOT = path.join(os.tmpdir(), "wanyong-dl");

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

/** Bilibili 直連常缺 Referer／影音分離，需本站代下 */
function needsServerDownload(url) {
  const h = hostOf(url);
  return (
    h === "b23.tv" ||
    h === "bili2233.cn" ||
    /(^|\.)bilibili\.(com|tv|cn)$/i.test(h)
  );
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

function ytdlBaseOpts() {
  const opts = {
    noWarnings: true,
    noCheckCertificates: true,
    noPlaylist: true,
    addHeader: [
      "User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Referer:https://www.bilibili.com/",
    ],
  };
  if (ffmpegPath) opts.ffmpegLocation = ffmpegPath;
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

async function extractInfo(url) {
  const info = await youtubeDl(url, {
    ...ytdlBaseOpts(),
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
  if (/geo-restricted|VPN|proxy/i.test(raw)) {
    return "此 Bilibili 影片有地區限制，目前網路無法取得。可換公開影片，或稍後用可連線的網路再試。";
  }
  if (/login|cookie|members only|付费|登錄|登录/i.test(raw)) {
    return "此影片需要登入或會員才能下載。";
  }
  if (/Unsupported URL|No video/i.test(raw)) {
    return "無法辨識此連結，請確認是完整的公開影片網址。";
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
    const relay = needsServerDownload(url);

    // Bilibili：直接給本站代下（影音合併），避免直連失敗／無聲音
    if (relay) {
      let title = "Bilibili 影片";
      let thumbnail = null;
      let duration = null;
      let extractor = "BiliBili";
      try {
        const info = await extractInfo(url);
        title = info.title || title;
        thumbnail = info.thumbnail || null;
        duration = info.duration ?? null;
        extractor = info.extractor_key || info.extractor || extractor;
      } catch (previewErr) {
        // 仍提供下載入口；真正失敗會在 /api/download 顯示
        console.warn("bilibili preview:", friendlyError(previewErr));
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
        note: "Bilibili 影音通常分開，且直連會被擋。此平台改由本站代抓並合併後給你下載。",
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

    // 沒有「畫面+聲音」合併檔時，改走本站代下
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
    });
  } catch (err) {
    res.status(400).json({ detail: `解析失敗：${friendlyError(err)}` });
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
    const outTemplate = path.join(workDir, "file.%(ext)s");

    await youtubeDl(url, {
      ...ytdlBaseOpts(),
      format: formatSelector(media, quality),
      output: outTemplate,
      mergeOutputFormat: media === "audio" ? "m4a" : "mp4",
      restrictFilenames: true,
    });

    const files = fs.readdirSync(workDir).filter((n) => !n.endsWith(".part"));
    if (!files.length) {
      throw new Error("下載完成但找不到檔案");
    }
    const filePath = path.join(workDir, files[0]);
    const ext = path.extname(files[0]).replace(".", "") || (media === "audio" ? "m4a" : "mp4");
    const downloadName = `bilibili_${Date.now()}.${ext}`;

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
      res.status(400).json({ detail: `Bilibili 下載失敗：${friendlyError(err)}` });
    }
  }
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(STATIC, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`萬用下載器 → http://127.0.0.1:${PORT}`);
});
