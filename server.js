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
const ytdlExec = require("youtube-dl-exec");
const ffmpegPath = require("ffmpeg-static");
const { Innertube, UniversalCache } = require("youtubei.js");

const ROOT = __dirname;
const STATIC = path.join(ROOT, "static");
const PORT = Number(process.env.PORT) || 8787;
const TMP_ROOT = path.join(os.tmpdir(), "wanyong-dl");
const APP_VERSION = "2026-07-24-pot1";

function resolveYoutubeDl() {
  const candidates = [
    process.env.YT_DLP_BIN,
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
  ].filter(Boolean);
  for (const bin of candidates) {
    try {
      if (fs.existsSync(bin)) return ytdlExec.create(bin);
    } catch {
      /* ignore */
    }
  }
  return ytdlExec;
}

const youtubeDl = resolveYoutubeDl();

function isPotEnabled() {
  return String(process.env.YT_DLP_POT_ENABLED || "1") !== "0";
}

function potBaseUrl() {
  return String(process.env.YT_DLP_POT_BASE_URL || "http://127.0.0.1:4416").replace(/\/$/, "");
}

/** 公開 Piped／Invidious：用別人的出口碰 YouTube，再把直連回給使用者 */
const PIPED_APIS = String(
  process.env.PIPED_APIS ||
    [
      "https://pipedapi.kavin.rocks",
      "https://pipedapi.leptons.xyz",
      "https://pipedapi.nosebs.ru",
      "https://pipedapi-libre.kavin.rocks",
      "https://api.piped.private.coffee",
      "https://pipedapi.darkness.services",
      "https://pipedapi.reallyaweso.me",
    ].join(",")
)
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

const INVIDIOUS_APIS = String(
  process.env.INVIDIOUS_APIS ||
    [
      "https://inv.nadeko.net",
      "https://yewtu.be",
      "https://invidious.nerdvpn.de",
      "https://vid.puffyan.us",
    ].join(",")
)
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

function createYouTubeClient() {
  return Innertube.create({
    cache: new UniversalCache(false),
    retrieve_player: true,
    generate_session_locally: true,
  });
}

function normalizeProxy(raw) {
  const p = String(raw || "").trim();
  if (!p) return "";
  if (!/^(https?|socks5h?|socks4a?):\/\//i.test(p)) {
    throw new Error("代理格式錯誤。請用：http://帳號:密碼@主機:埠 或 socks5://主機:埠");
  }
  // 禁止明顯內網／本機，降低被拿去掃內網風險
  try {
    const u = new URL(p);
    const host = (u.hostname || "").toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.endsWith(".local") ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      throw new Error("不可使用本機或內網代理位址");
    }
  } catch (e) {
    if (/代理格式|不可使用/.test(e.message)) throw e;
    throw new Error("代理網址無法解析，請檢查格式");
  }
  return p;
}

function pickRequestProxy(req) {
  const fromBody = req.body?.proxy;
  const fromQuery = req.query?.proxy;
  const fromHeader = req.get("x-download-proxy");
  const fromEnv = process.env.DOWNLOAD_PROXY;
  return normalizeProxy(fromBody || fromQuery || fromHeader || fromEnv || "");
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

function ytdlBaseOpts(url, proxy = "") {
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

  if (isYouTube(url)) {
    // PO Token + 多客戶端輪替（參考 yt-dlp wiki / yt-dlp-rescue）
    const args = [
      "youtube:player_client=web,android,ios,tv_embedded;player_skip=webpage",
    ];
    if (isPotEnabled()) {
      args.push(`youtubepot-bgutilhttp:base_url=${potBaseUrl()}`);
    }
    opts.extractorArgs = args;
  }

  const p = String(proxy || process.env.DOWNLOAD_PROXY || "").trim();
  if (p) opts.proxy = p;

  const cookiesFile = process.env.COOKIES_FILE;
  if (cookiesFile && fs.existsSync(cookiesFile)) {
    opts.cookies = cookiesFile;
  }

  return opts;
}

async function runYtDlpDownload(url, media, quality, outPath, proxy = "") {
  await youtubeDl(url, {
    ...ytdlBaseOpts(url, proxy),
    format: formatSelector(media, quality),
    output: outPath.replace(/\.[^.]+$/, ".%(ext)s"),
    mergeOutputFormat: media === "audio" ? "m4a" : "mp4",
    restrictFilenames: true,
  });
  const dir = path.dirname(outPath);
  const files = fs.readdirSync(dir).filter((n) => n.startsWith("file."));
  if (!files.length) throw new Error("yt-dlp 完成但找不到檔案");
  const found = path.join(dir, files[0]);
  if (found !== outPath) fs.renameSync(found, outPath);
  if (fs.statSync(outPath).size < 1024) throw new Error("下載檔案過小，可能失敗");
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

async function fetchJson(url, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function heightFromLabel(q) {
  const m = String(q || "").match(/(\d{3,4})/);
  return m ? Number(m[1]) : 0;
}

function pickByQuality(items, quality, getHeight) {
  if (!items.length) return [];
  if (quality === "best") {
    return [...items].sort((a, b) => getHeight(b) - getHeight(a));
  }
  const target = Number(quality);
  return [...items]
    .filter((x) => {
      const h = getHeight(x);
      return !h || h <= target;
    })
    .sort((a, b) => getHeight(b) - getHeight(a));
}

function optionsFromPiped(data, media, quality) {
  if (media === "audio") {
    const audios = Array.isArray(data.audioStreams) ? data.audioStreams : [];
    return audios
      .filter((s) => s?.url)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
      .slice(0, 6)
      .map((s, i) => {
        const ext = String(s.format || "m4a").toLowerCase().includes("webm") ? "webm" : "m4a";
        const kbps = s.bitrate ? Math.round(Number(s.bitrate) / 1000) : null;
        return {
          format_id: `piped-a-${i}`,
          ext,
          height: null,
          has_audio: true,
          filesize: null,
          url: s.url,
          label: kbps ? `${kbps} kbps · ${ext.toUpperCase()}` : `音訊 · ${ext.toUpperCase()}`,
          via: "direct",
        };
      });
  }

  const videos = (Array.isArray(data.videoStreams) ? data.videoStreams : []).filter((s) => s?.url);
  // 優先有聲音的（非 videoOnly），使用者才能一鍵下到完整檔
  const muxed = videos.filter((s) => !s.videoOnly);
  const pool = muxed.length ? muxed : videos;
  const ranked = pickByQuality(pool, quality, (s) => heightFromLabel(s.quality || s.qualityLabel));

  return ranked.slice(0, 8).map((s, i) => {
    const height = heightFromLabel(s.quality || s.qualityLabel) || null;
    const ext = String(s.format || "mp4").toLowerCase().includes("webm") ? "webm" : "mp4";
    const hasAudio = !s.videoOnly;
    return {
      format_id: `piped-v-${i}`,
      ext,
      height,
      has_audio: hasAudio,
      filesize: null,
      url: s.url,
      label: labelVideo({ format_note: s.quality, format_id: `p${i}`, ext }, height, hasAudio),
      via: "direct",
    };
  });
}

function optionsFromInvidious(data, media, quality) {
  if (media === "audio") {
    const adaptive = Array.isArray(data.adaptiveFormats) ? data.adaptiveFormats : [];
    return adaptive
      .filter((f) => f?.url && String(f.type || "").startsWith("audio/"))
      .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))
      .slice(0, 6)
      .map((f, i) => {
        const ext = String(f.container || f.type || "m4a").includes("webm") ? "webm" : "m4a";
        const kbps = f.bitrate ? Math.round(Number(f.bitrate) / 1000) : null;
        return {
          format_id: `inv-a-${i}`,
          ext,
          height: null,
          has_audio: true,
          filesize: null,
          url: f.url,
          label: kbps ? `${kbps} kbps · ${ext.toUpperCase()}` : `音訊 · ${ext.toUpperCase()}`,
          via: "direct",
        };
      });
  }

  const muxed = (Array.isArray(data.formatStreams) ? data.formatStreams : []).filter((f) => f?.url);
  const ranked = pickByQuality(muxed, quality, (f) => heightFromLabel(f.qualityLabel || f.quality));
  return ranked.slice(0, 8).map((f, i) => {
    const height = heightFromLabel(f.qualityLabel || f.quality) || null;
    const ext = String(f.container || "mp4").toLowerCase().includes("webm") ? "webm" : "mp4";
    return {
      format_id: `inv-v-${i}`,
      ext,
      height,
      has_audio: true,
      filesize: null,
      url: f.url,
      label: labelVideo({ format_note: f.qualityLabel, format_id: `i${i}`, ext }, height, true),
      via: "direct",
    };
  });
}

/** 後端自動換「出口」：詢問 Piped／Invidious，回傳可直連的下載網址 */
async function resolveYouTubeViaFrontends(id, media, quality) {
  const errors = [];

  for (const base of PIPED_APIS) {
    try {
      const data = await fetchJson(`${base}/streams/${encodeURIComponent(id)}`);
      const options = optionsFromPiped(data, media, quality);
      if (!options.length) {
        errors.push(`${base}: no streams`);
        continue;
      }
      let host = base;
      try {
        host = new URL(base).hostname;
      } catch {
        /* ignore */
      }
      return {
        title: data.title || "YouTube 影片",
        thumbnail: data.thumbnailUrl || null,
        duration: data.duration ?? null,
        extractor: `piped:${host}`,
        options,
        note: "後端已自動處理，按下方按鈕即可下載。",
      };
    } catch (err) {
      errors.push(`${base}: ${err.message || err}`);
    }
  }

  for (const base of INVIDIOUS_APIS) {
    try {
      const data = await fetchJson(`${base}/api/v1/videos/${encodeURIComponent(id)}`);
      const options = optionsFromInvidious(data, media, quality);
      if (!options.length) {
        errors.push(`${base}: no streams`);
        continue;
      }
      let host = base;
      try {
        host = new URL(base).hostname;
      } catch {
        /* ignore */
      }
      return {
        title: data.title || "YouTube 影片",
        thumbnail: data.videoThumbnails?.[0]?.url || data.thumbnail || null,
        duration: data.lengthSeconds ?? null,
        extractor: `invidious:${host}`,
        options,
        note: "後端已自動處理，按下方按鈕即可下載。",
      };
    } catch (err) {
      errors.push(`${base}: ${err.message || err}`);
    }
  }

  throw new Error(`前端鏡像皆失敗：${errors.slice(0, 3).join(" | ")}`);
}

async function downloadUrlToFile(fileUrl, outPath) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  try {
    const res = await fetch(fileUrl, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Referer: "https://www.youtube.com/",
      },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`串流 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) throw new Error("下載檔案過小");
    fs.writeFileSync(outPath, buf);
  } finally {
    clearTimeout(timer);
  }
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
  const yt = await createYouTubeClient();
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

async function downloadYouTubeToFile(url, media, quality, outPath, proxy = "") {
  const id = youtubeVideoId(url);
  if (!id) throw new Error("無法辨識 YouTube 影片 ID");
  let lastErr = null;

  // 1) 有代理：yt-dlp
  if (proxy) {
    try {
      await runYtDlpDownload(url, media, quality, outPath, proxy);
      return;
    } catch (err) {
      lastErr = err;
    }
  }

  // 2) PO Token + 系統 yt-dlp（GitHub 主流雲端解法）
  try {
    await runYtDlpDownload(url, media, quality, outPath, proxy);
    return;
  } catch (err) {
    lastErr = err;
    console.warn("yt-dlp+POT failed:", err.message || err);
  }

  // 3) Piped／Invidious 自動改道
  try {
    const front = await resolveYouTubeViaFrontends(id, media, quality);
    const best = (front.options || []).find((o) => o.url && (media === "audio" || o.has_audio !== false));
    if (best?.url) {
      await downloadUrlToFile(best.url, outPath);
      return;
    }
  } catch (err) {
    lastErr = err;
  }

  // 4) youtubei.js 客戶端輪替
  const yt = await createYouTubeClient();
  const q = mapQualityToYoutubei(quality);
  const clients = ["ANDROID", "IOS", "TV_EMBEDDED", "TV", "MWEB", "WEB"];

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

  const raw = String(lastErr?.message || lastErr || "");
  if (/Sign in to confirm|not a bot|LOGIN_REQUIRED|blocked|前端鏡像|PO Token|bot/i.test(raw)) {
    throw new Error(
      proxy
        ? "即使使用代理仍被擋，請確認是住宅代理且未失效。"
        : "YouTube 下載失敗（PO Token 自動改道仍無法取得）。請改用本機 npm start。"
    );
  }
  throw lastErr || new Error("YouTube 下載失敗");
}

async function extractInfo(url, proxy = "") {
  // 有 PO Token 時 YouTube 也走 yt-dlp（不再只用 youtubei 基本資訊）
  if (isYouTube(url) && !proxy && !isPotEnabled()) {
    return extractYouTubeInfo(url);
  }
  const info = await youtubeDl(url, {
    ...ytdlBaseOpts(url, proxy),
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

function platformLabel(url) {
  const h = hostOf(url);
  if (!h) return "此平台";
  if (isYouTube(url)) return "YouTube";
  if (isBilibili(url)) return "Bilibili";
  if (/(^|\.)tiktok\.com$|(^|\.)douyin\.com$/i.test(h)) return "TikTok／抖音";
  if (/(^|\.)instagram\.com$/i.test(h)) return "Instagram";
  if (/(^|\.)facebook\.com$|(^|\.)fb\.watch$/i.test(h)) return "Facebook";
  if (/(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(h)) return "X／Twitter";
  if (/(^|\.)vimeo\.com$/i.test(h)) return "Vimeo";
  if (/(^|\.)xiaohongshu\.com$|(^|\.)xhslink\.com$/i.test(h)) return "小紅書";
  return h;
}

function friendlyError(err, url = "") {
  const raw = String(err?.stderr || err?.message || err);
  const name = platformLabel(url);

  if (/Your IP address is blocked|IP address is blocked|blocked from accessing/i.test(raw)) {
    return `${name} 封鎖了雲端主機 IP。這是免費機房常見限制，請改用本機 npm start。`;
  }
  if (/Sign in to confirm|confirm you.?re not a bot|LOGIN_REQUIRED/i.test(raw)) {
    return `${name} 擋住雲端主機（防機器人）。線上免費主機常失敗，請改用本機下載。`;
  }
  if (/Failed to fetch.*OAuth|401: Unauthorized/i.test(raw)) {
    return `${name} 拒絕雲端主機存取（401）。請改用本機 npm start。`;
  }
  if (/geo-restricted|VPN|proxy server/i.test(raw)) {
    return `${name} 有地區限制，目前雲端網路無法取得。`;
  }
  if (/members only|付费|付費|會員專屬/i.test(raw)) {
    return `${name}：此影片需要會員才能下載。`;
  }
  if (/private video|Private video|非公開|私人/i.test(raw)) {
    return `${name}：這是私人／非公開內容，無法下載。`;
  }
  if (/Unsupported URL|No video/i.test(raw)) {
    return `${name}：無法辨識此連結，請確認是完整公開網址。`;
  }
  if (/HTTP Error 403|403: Forbidden/i.test(raw)) {
    return `${name} 拒絕存取（403），多半是雲端 IP 被擋。請改用本機。`;
  }
  // 注意：不可再寫成「去設 YT_COOKIE」——會讓所有平台錯誤看起來都一樣
  if (/login required|Please log in|requires login|需要登入/i.test(raw)) {
    return `${name} 要求登入才能抓取，雲端主機通常無法通過。請改用本機下載。`;
  }
  // 保留平台名 + 原始錯誤摘要，方便對照
  const brief = raw.replace(/\s+/g, " ").slice(0, 220);
  return `${name} 下載失敗：${brief}`;
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
    youtubeAutoReroute: true,
    potEnabled: isPotEnabled(),
    potBaseUrl: potBaseUrl(),
    ytDlpBin: process.env.YT_DLP_BIN || "bundled",
    pipedApis: PIPED_APIS.length,
    invidiousApis: INVIDIOUS_APIS.length,
  });
});

app.post("/api/resolve", async (req, res) => {
  try {
    const media = req.body?.media === "audio" ? "audio" : "video";
    const quality = ["best", "1080", "720", "480"].includes(req.body?.quality)
      ? req.body.quality
      : "best";
    const url = normalizeUrl(req.body?.url);
    const proxy = pickRequestProxy(req);

    // 有代理：統一走 yt-dlp（可換出口 IP）
    if (proxy || !isYouTube(url)) {
      if (isYouTube(url) && proxy) {
        const info = await extractInfo(url, proxy);
        return res.json({
          title: info.title || "YouTube 影片",
          filename: safeFilename(info.title || "youtube"),
          thumbnail: info.thumbnail || null,
          duration: info.duration ?? null,
          extractor: info.extractor_key || info.extractor || "youtube",
          webpage_url: info.webpage_url || url,
          media,
          quality,
          options: [
            buildServerOption(
              url,
              media,
              quality,
              media === "audio" ? "下載聲音（經代理）" : "下載影片含聲音（經代理）"
            ),
          ],
          note: "已使用你提供的代理 IP 解析。",
          version: APP_VERSION,
          usedProxy: true,
        });
      }

      if (!isYouTube(url) && needsServerDownload(url)) {
        let title = "影片";
        let thumbnail = null;
        let duration = null;
        let extractor = "unknown";
        try {
          const info = await extractInfo(url, proxy);
          title = info.title || title;
          thumbnail = info.thumbnail || null;
          duration = info.duration ?? null;
          extractor = info.extractor_key || info.extractor || extractor;
        } catch (previewErr) {
          console.warn("preview:", friendlyError(previewErr, url));
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
              proxy
                ? "下載（經代理）"
                : media === "audio"
                  ? "下載聲音（本站代抓）"
                  : "下載影片含聲音（本站代抓）"
            ),
          ],
          note: proxy
            ? "已使用你提供的代理 IP。"
            : "若失敗，請改用本機 npm start，或請站長設定 DOWNLOAD_PROXY。",
          version: APP_VERSION,
          usedProxy: Boolean(proxy),
        });
      }

      if (!isYouTube(url)) {
        const info = await extractInfo(url, proxy);
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
                proxy ? "下載（經代理）" : "下載影片含聲音（本站代抓）"
              ),
            ],
            note: proxy ? "已使用代理。" : "此平台改由本站代抓。",
            version: APP_VERSION,
            usedProxy: Boolean(proxy),
          });
        }

        return res.json({
          title,
          filename: safeFilename(title),
          thumbnail: info.thumbnail || null,
          duration: info.duration ?? null,
          extractor: info.extractor_key || info.extractor || "unknown",
          webpage_url: info.webpage_url || url,
          media,
          quality,
          options: uniqueOptions(usable),
          note: proxy
            ? "已使用代理解析；若點下載仍失敗，請改用本站代抓。"
            : "本站只轉換連結；下載直連影片來源，流量不經過本站。",
          version: APP_VERSION,
          usedProxy: Boolean(proxy),
        });
      }
    }

    // YouTube 無代理：PO Token yt-dlp → Piped／Invidious → 代抓按鈕
    const id = youtubeVideoId(url);
    if (!id) throw new Error("無法辨識 YouTube 影片 ID");

    if (isPotEnabled()) {
      try {
        const info = await extractInfo(url, "");
        return res.json({
          title: info.title || "YouTube 影片",
          filename: safeFilename(info.title || "youtube"),
          thumbnail: info.thumbnail || null,
          duration: info.duration ?? null,
          extractor: info.extractor_key || info.extractor || "youtube-pot",
          webpage_url: info.webpage_url || url,
          media,
          quality,
          options: [
            buildServerOption(
              url,
              media,
              quality,
              media === "audio" ? "立刻下載聲音" : "立刻下載影片（含聲音）"
            ),
          ],
          note: "後端已啟用 PO Token，按下方按鈕即可下載。",
          version: APP_VERSION,
          usedProxy: false,
          pot: true,
        });
      } catch (potErr) {
        console.warn("youtube pot resolve:", potErr.message || potErr);
      }
    }

    try {
      const front = await resolveYouTubeViaFrontends(id, media, quality);
      const usable = uniqueOptions(
        (front.options || []).filter((o) => media === "audio" || o.has_audio !== false)
      );
      if (usable.length) {
        // 直連為主；再附一個後端代抓備援，前端只要按下載即可
        usable.push(
          buildServerOption(
            url,
            media,
            quality,
            media === "audio" ? "備援：本站代抓聲音" : "備援：本站代抓影片"
          )
        );
        return res.json({
          title: front.title,
          filename: safeFilename(front.title),
          thumbnail: front.thumbnail,
          duration: front.duration,
          extractor: front.extractor,
          webpage_url: url,
          media,
          quality,
          options: usable,
          note: "後端已自動處理，按下方按鈕即可下載。",
          version: APP_VERSION,
          usedProxy: false,
          autoReroute: true,
        });
      }
    } catch (frontErr) {
      console.warn("youtube auto-reroute:", frontErr.message || frontErr);
    }

    // 改道失敗：仍回傳代抓按鈕，下載時後端會再試一次改道
    let title = "YouTube 影片";
    let thumbnail = null;
    let duration = null;
    try {
      const info = await extractYouTubeInfo(url);
      title = info.title || title;
      thumbnail = info.thumbnail;
      duration = info.duration;
    } catch {
      /* ignore — 標題拿不到仍可嘗試代抓 */
    }

    return res.json({
      title,
      filename: safeFilename(title),
      thumbnail,
      duration,
      extractor: "youtube",
      webpage_url: url,
      media,
      quality,
      options: [
        buildServerOption(
          url,
          media,
          quality,
          media === "audio" ? "立刻下載聲音" : "立刻下載影片（含聲音）"
        ),
      ],
      note: "後端會自動嘗試取得檔案，請直接按下載。",
      version: APP_VERSION,
      usedProxy: false,
    });
  } catch (err) {
    let url = "";
    try {
      url = normalizeUrl(req.body?.url);
    } catch {
      /* ignore */
    }
    res.status(400).json({ detail: `解析失敗：${friendlyError(err, url)}`, version: APP_VERSION });
  }
});

app.get("/api/download", async (req, res) => {
  let workDir = null;
  let url = "";
  try {
    const media = req.query?.media === "audio" ? "audio" : "video";
    const quality = ["best", "1080", "720", "480"].includes(req.query?.quality)
      ? String(req.query.quality)
      : "best";
    url = normalizeUrl(req.query?.url);
    const proxy = pickRequestProxy(req);

    workDir = fs.mkdtempSync(path.join(TMP_ROOT, "job-"));
    const ext = media === "audio" ? "m4a" : "mp4";
    const filePath = path.join(workDir, `file.${ext}`);

    if (isYouTube(url)) {
      await downloadYouTubeToFile(url, media, quality, filePath, proxy);
    } else {
      const outTemplate = path.join(workDir, "file.%(ext)s");
      await youtubeDl(url, {
        ...ytdlBaseOpts(url, proxy),
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
      res.status(400).json({ detail: `下載失敗：${friendlyError(err, url)}`, version: APP_VERSION });
    }
  }
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(STATIC, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`萬用下載器 → http://127.0.0.1:${PORT}`);
});
