(() => {
  const form = document.getElementById("resolve-form");
  const submitBtn = document.getElementById("submit-btn");
  const statusEl = document.getElementById("status");
  const resultEl = document.getElementById("result");
  const titleEl = document.getElementById("title");
  const subEl = document.getElementById("sub");
  const thumbEl = document.getElementById("thumb");
  const optionsEl = document.getElementById("options");
  const noteEl = document.getElementById("note");
  const qualityGroup = document.getElementById("quality-group");
  const primaryDownload = document.getElementById("primary-download");
  const moreWrap = document.getElementById("more-wrap");
  const urlInput = document.getElementById("url");
  const proxyInput = document.getElementById("proxy");
  const clearProxyBtn = document.getElementById("clear-proxy");
  const PROXY_KEY = "wanyong_proxy";

  const mediaInputs = form.querySelectorAll('input[name="media"]');

  function getProxy() {
    return (proxyInput?.value || "").trim();
  }

  function saveProxy(value) {
    const v = String(value || "").trim();
    if (v) localStorage.setItem(PROXY_KEY, v);
    else localStorage.removeItem(PROXY_KEY);
  }

  if (proxyInput) {
    proxyInput.value = localStorage.getItem(PROXY_KEY) || "";
    proxyInput.addEventListener("change", () => saveProxy(proxyInput.value));
    proxyInput.addEventListener("blur", () => saveProxy(proxyInput.value));
  }
  if (clearProxyBtn) {
    clearProxyBtn.addEventListener("click", () => {
      if (proxyInput) proxyInput.value = "";
      saveProxy("");
      setStatus("已清除代理設定。");
    });
  }

  function setStatus(message, isError = false) {
    statusEl.textContent = message || "";
    statusEl.classList.toggle("is-error", Boolean(isError && message));
  }

  function formatDuration(seconds) {
    if (!seconds && seconds !== 0) return null;
    const s = Math.floor(Number(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
    return `${m}:${String(r).padStart(2, "0")}`;
  }

  function formatBytes(bytes) {
    if (!bytes) return null;
    const units = ["B", "KB", "MB", "GB"];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i += 1;
    }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function syncQualityVisibility() {
    const media = form.querySelector('input[name="media"]:checked')?.value;
    qualityGroup.hidden = media === "audio";
  }

  mediaInputs.forEach((input) => {
    input.addEventListener("change", syncQualityVisibility);
  });
  syncQualityVisibility();

  urlInput.addEventListener("paste", () => {
    setTimeout(() => {
      urlInput.value = urlInput.value.trim();
    }, 0);
  });

  function renderResult(data) {
    resultEl.hidden = false;
    titleEl.textContent = data.title || "未命名影片";

    const bits = [];
    if (data.extractor) bits.push(data.extractor);
    const dur = formatDuration(data.duration);
    if (dur) bits.push(`長度 ${dur}`);
    bits.push(data.media === "audio" ? "聲音檔" : "影片檔");
    subEl.textContent = bits.join(" · ");

    if (data.thumbnail) {
      thumbEl.hidden = false;
      thumbEl.src = data.thumbnail;
      thumbEl.alt = data.title || "";
    } else {
      thumbEl.hidden = true;
      thumbEl.removeAttribute("src");
    }

    const options = data.options || [];
    const best = options[0];

    if (best) {
      primaryDownload.hidden = false;
      primaryDownload.href = best.url;
      primaryDownload.dataset.via = best.via || "direct";
      primaryDownload.dataset.filename = `${data.filename || "download"}.${best.ext || "mp4"}`;
      if (best.via === "server") {
        primaryDownload.removeAttribute("download");
        primaryDownload.removeAttribute("target");
      } else {
        primaryDownload.download = primaryDownload.dataset.filename;
        primaryDownload.target = "_blank";
        primaryDownload.rel = "noopener noreferrer";
      }
      primaryDownload.textContent =
        best.via === "server"
          ? data.media === "audio"
            ? "立刻下載聲音（含處理）"
            : "立刻下載影片（含聲音）"
          : data.media === "audio"
            ? "立刻下載聲音"
            : "立刻下載影片";
    } else {
      primaryDownload.hidden = true;
      delete primaryDownload.dataset.via;
    }

    optionsEl.innerHTML = "";
    if (options.length > 1) {
      moreWrap.hidden = false;
      options.slice(1).forEach((opt, index) => {
        const li = document.createElement("li");
        const info = document.createElement("div");
        const label = document.createElement("span");
        label.className = "label";
        label.textContent = opt.label || `其他選項 ${index + 1}`;

        const meta = document.createElement("span");
        meta.className = "meta";
        const metaBits = [];
        if (opt.ext) metaBits.push(opt.ext.toUpperCase());
        const size = formatBytes(opt.filesize);
        if (size) metaBits.push(size);
        if (opt.has_audio === false) metaBits.push("只有畫面沒聲音");
        meta.textContent = metaBits.join(" · ") || "備用格式";

        info.append(label, meta);

        const a = document.createElement("a");
        a.className = "link-btn";
        a.href = opt.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.download = `${data.filename || "download"}.${opt.ext || "mp4"}`;
        a.textContent = "下載";

        li.append(info, a);
        optionsEl.append(li);
      });
    } else {
      moreWrap.hidden = true;
    }

    noteEl.textContent =
      data.note || "本站只轉換連結；下載直連影片來源，流量不經過本站。";
    resultEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  primaryDownload.addEventListener("click", async (event) => {
    if (primaryDownload.dataset.via !== "server") return;
    event.preventDefault();
    const href = primaryDownload.getAttribute("href");
    if (!href) return;

    setStatus("正在下載中，請稍候（可能要 30 秒以上）…");
    primaryDownload.setAttribute("aria-disabled", "true");
    const oldText = primaryDownload.textContent;
    primaryDownload.textContent = "下載中…";

    try {
      const headers = {};
      if (getProxy()) headers["x-download-proxy"] = getProxy();
      const res = await fetch(href, { headers });
      const type = res.headers.get("content-type") || "";
      if (!res.ok) {
        const payload = type.includes("json") ? await res.json().catch(() => ({})) : {};
        throw new Error(payload.detail || `下載失敗（${res.status}）`);
      }
      if (type.includes("json")) {
        const payload = await res.json();
        throw new Error(payload.detail || "下載失敗");
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = primaryDownload.dataset.filename || "download.mp4";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
      setStatus("已開始下載到你的裝置。");
    } catch (err) {
      setStatus(err.message || "下載失敗", true);
    } finally {
      primaryDownload.textContent = oldText;
      primaryDownload.removeAttribute("aria-disabled");
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = urlInput.value.trim();
    const media = form.querySelector('input[name="media"]:checked')?.value || "video";
    const quality = form.querySelector('input[name="quality"]:checked')?.value || "best";

    if (!/^https?:\/\//i.test(url)) {
      setStatus("請貼上完整網址（要有 https:// 開頭）", true);
      return;
    }

    resultEl.hidden = true;
    optionsEl.innerHTML = "";
    primaryDownload.hidden = true;
    moreWrap.hidden = true;
    setStatus("正在幫你轉換下載連結…");
    submitBtn.disabled = true;
    submitBtn.textContent = "轉換中…";

    try {
      saveProxy(getProxy());
      const res = await fetch("/api/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          media,
          quality,
          proxy: getProxy() || undefined,
        }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = payload.detail || "轉換失敗，請換一個公開影片連結再試";
        throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
      }

      renderResult(payload);
      setStatus(
        payload.usedProxy
          ? "轉換成功（已走代理 IP）！按下面大按鈕下載。"
          : "轉換成功！按下面大按鈕就能下載。"
      );
    } catch (err) {
      setStatus(err.message || "發生錯誤，請稍後再試", true);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "一鍵下載";
    }
  });
})();
