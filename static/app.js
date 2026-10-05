"use strict";

const LS_SETTINGS = "mimo-asr-settings";
const LS_HISTORY = "mimo-asr-history";
const MAX_HISTORY = 50;

const DEFAULTS = {
  baseUrl: "https://api.xiaomimimo.com",
  apiKey: "",
  model: "mimo-v2.5-asr",
  language: "auto",
  stream: true,
};

const state = {
  file: null,
  duration: null,
  busy: false,
  currentText: "",
  currentUsage: null,
  statusBase: "",
  statusType: "",
  lastActivity: 0,
  startedAt: 0,
  ticker: null,
  abort: null,
};

const $ = (id) => document.getElementById(id);

const els = {
  settingsToggle: $("settingsToggle"),
  settingsPanel: $("settingsPanel"),
  baseUrl: $("baseUrl"),
  apiKey: $("apiKey"),
  modelId: $("modelId"),
  language: $("language"),
  streamMode: $("streamMode"),
  saveSettings: $("saveSettings"),
  dropZone: $("dropZone"),
  fileInput: $("fileInput"),
  fileInfo: $("fileInfo"),
  dzInner: $("dzInner"),
  fileName: $("fileName"),
  fileMeta: $("fileMeta"),
  transcribeBtn: $("transcribeBtn"),
  cancelBtn: $("cancelBtn"),
  clearBtn: $("clearBtn"),
  status: $("status"),
  resultText: $("resultText"),
  usage: $("usage"),
  copyBtn: $("copyBtn"),
  exportTxt: $("exportTxt"),
  exportSrt: $("exportSrt"),
  exportJson: $("exportJson"),
  historyList: $("historyList"),
  historyEmpty: $("historyEmpty"),
  clearHistory: $("clearHistory"),
};

/* ---------- settings ---------- */

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS_SETTINGS) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

function applySettingsToForm(s) {
  els.baseUrl.value = s.baseUrl;
  els.apiKey.value = s.apiKey;
  els.modelId.value = s.model;
  els.language.value = s.language;
  els.streamMode.checked = !!s.stream;
}

function readSettingsFromForm() {
  return {
    baseUrl: els.baseUrl.value.trim() || DEFAULTS.baseUrl,
    apiKey: els.apiKey.value.trim(),
    model: els.modelId.value.trim() || DEFAULTS.model,
    language: els.language.value,
    stream: els.streamMode.checked,
  };
}

function saveSettings(showFeedback = true) {
  const s = readSettingsFromForm();
  localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
  if (showFeedback) setStatus("设置已保存", "ok");
  return s;
}

/* ---------- status / usage ---------- */

function setStatus(msg, type = "") {
  state.statusBase = msg;
  state.statusType = type;
  state.lastActivity = Date.now();
  els.status.textContent = msg;
  els.status.className = "status" + (type ? " " + type : "");
}

function touchActivity() {
  state.lastActivity = Date.now();
}

function startTicker() {
  state.startedAt = Date.now();
  state.lastActivity = Date.now();
  stopTicker();
  state.ticker = setInterval(() => {
    if (!state.busy) return;
    const total = Math.round((Date.now() - state.startedAt) / 1000);
    const idle = Math.round((Date.now() - state.lastActivity) / 1000);
    let text = `${state.statusBase} · ${total}s`;
    if (idle >= 5) text += `（已等待 ${idle}s）`;
    els.status.textContent = text;
  }, 1000);
}

function stopTicker() {
  if (state.ticker) {
    clearInterval(state.ticker);
    state.ticker = null;
  }
}

function renderUsage(usage, extra = "") {
  if (!usage && !extra) {
    els.usage.textContent = "";
    return;
  }
  const parts = [];
  if (extra) parts.push(extra);
  if (usage) {
    if (usage.seconds != null) parts.push(`音频 ${usage.seconds}s`);
    if (usage.total_tokens != null) parts.push(`tokens ${usage.total_tokens}`);
  }
  els.usage.textContent = parts.join(" · ");
}

/* ---------- file handling ---------- */

function getDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (val) => {
      URL.revokeObjectURL(url);
      resolve(val);
    };
    audio.preload = "metadata";
    audio.onloadedmetadata = () => done(isFinite(audio.duration) ? audio.duration : null);
    audio.onerror = () => done(null);
    setTimeout(() => done(null), 5000);
    audio.src = url;
  });
}

function formatDuration(sec) {
  if (sec == null || !isFinite(sec)) return "--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

async function handleFile(file) {
  if (!file) return;
  state.file = file;
  state.duration = null;
  els.dropZone.classList.add("has-file");
  els.dzInner.classList.add("hidden");
  els.fileInfo.classList.remove("hidden");
  els.fileName.textContent = file.name;
  els.fileMeta.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB · 读取时长中…`;
  els.transcribeBtn.disabled = false;
  setStatus("解析音频…");

  const duration = await getDuration(file);
  state.duration = duration;
  els.fileMeta.textContent = [
    `${(file.size / 1024 / 1024).toFixed(2)} MB`,
    `时长 ${formatDuration(duration)}`,
  ].join(" · ");
  if (!state.busy && els.status.textContent === "解析音频…") {
    setStatus("音频就绪，点击「开始识别」", "ok");
  }
}

function resetFile() {
  state.file = null;
  state.duration = null;
  els.fileInput.value = "";
  els.dropZone.classList.remove("has-file", "dragover");
  els.dzInner.classList.remove("hidden");
  els.fileInfo.classList.add("hidden");
  els.transcribeBtn.disabled = true;
}

/* ---------- transcription ---------- */

async function parseSseStream(response, onDelta, onSegment, onInfo) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage = null;

  const handleData = (data) => {
    if (!data || data === "[DONE]") return;
    let obj;
    try {
      obj = JSON.parse(data);
    } catch {
      return;
    }
    touchActivity();
    if (obj.error) {
      const msg =
        typeof obj.error.message === "string"
          ? obj.error.message
          : JSON.stringify(obj.error.message || obj.error);
      throw new Error(msg);
    }
    if (obj.prepare && onInfo) onInfo(obj.prepare);
    if (obj.prepared && onInfo)
      onInfo(`分段完成（${obj.prepared.segments} 段，耗时 ${obj.prepared.elapsed}s），开始识别`);
    if (obj.split && onInfo)
      onInfo(`第 ${obj.split.index} 段连接异常，已自动拆分重试（共 ${obj.split.total} 段）`);
    if (obj.segment_index && onSegment) onSegment(obj.segment_index, obj.segment_total);
    if (obj.usage) usage = obj.usage;
    const delta = obj.choices && obj.choices[0] && obj.choices[0].delta;
    if (delta && delta.content) {
      text += delta.content;
      onDelta(text);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) handleData(trimmed.slice(5).trim());
    }
  }
  if (buffer.trim().startsWith("data:")) handleData(buffer.trim().slice(5).trim());

  return { text, usage };
}

async function transcribe() {
  if (state.busy || !state.file) return;
  const settings = saveSettings(false);

  if (!settings.apiKey) {
    els.settingsPanel.classList.remove("hidden");
    setStatus("请先在「API 设置」中填写 API Key", "error");
    els.apiKey.focus();
    return;
  }

  state.busy = true;
  els.transcribeBtn.disabled = true;
  els.transcribeBtn.textContent = "识别中…";
  els.cancelBtn.classList.remove("hidden");
  els.resultText.textContent = "";
  state.currentText = "";
  state.currentUsage = null;
  renderUsage(null, "识别中…");
  setStatus(settings.stream ? "流式识别中…" : "识别中…");
  startTicker();

  const fd = new FormData();
  fd.append("base_url", settings.baseUrl);
  fd.append("api_key", settings.apiKey);
  fd.append("model", settings.model);
  fd.append("language", settings.language);
  fd.append("stream", settings.stream ? "true" : "false");
  fd.append("file", state.file, state.file.name);

  const started = performance.now();
  const controller = new AbortController();
  state.abort = controller;

  try {
    const res = await fetch("/api/transcribe", {
      method: "POST",
      body: fd,
      signal: controller.signal,
    });
    touchActivity();

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const err = await res.json();
        const d = err.detail;
        detail =
          typeof d === "string"
            ? d
            : d && d.message
              ? `${d.message}${d.status ? ` (HTTP ${d.status})` : ""}`
              : JSON.stringify(d || err, null, 2);
      } catch {
        /* ignore */
      }
      throw new Error(detail);
    }

    let text = "";
    let usage = null;

    if (settings.stream && res.body) {
      const result = await parseSseStream(
        res,
        (partial) => {
          touchActivity();
          els.resultText.textContent = partial;
          els.resultText.scrollTop = els.resultText.scrollHeight;
        },
        (idx, total) => {
          if (total > 1) setStatus(`流式识别中… 分段 ${idx}/${total}`);
        },
        (msg) => setStatus(msg)
      );
      text = result.text;
      usage = result.usage;
    } else {
      const json = await res.json();
      touchActivity();
      if (json.error) throw new Error(JSON.stringify(json.error));
      text = (json.choices && json.choices[0] && json.choices[0].message.content) || "";
      usage = json.usage || null;
    }

    const elapsed = ((performance.now() - started) / 1000).toFixed(1);
    state.currentText = text;
    state.currentUsage = usage;
    els.resultText.textContent = text;
    renderUsage(usage, `耗时 ${elapsed}s`);

    if (!text.trim()) {
      setStatus("识别完成，但未返回文本", "error");
    } else {
      setStatus("识别完成", "ok");
      addHistory({
        fileName: state.file ? state.file.name : "未知文件",
        language: settings.language,
        model: settings.model,
        text,
        usage,
        duration: state.duration,
      });
    }
  } catch (err) {
    if (err && err.name === "AbortError") {
      setStatus(state.file ? "已取消" : "等待上传音频", "");
    } else {
      setStatus(`识别失败: ${err.message || err}`, "error");
    }
  } finally {
    stopTicker();
    state.busy = false;
    state.abort = null;
    els.cancelBtn.classList.add("hidden");
    els.transcribeBtn.disabled = !state.file;
    els.transcribeBtn.textContent = "开始识别";
  }
}

/* ---------- export ---------- */

function currentResultText() {
  return (els.resultText.innerText || state.currentText || "").trim();
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function baseFileName() {
  const name = state.file ? state.file.name.replace(/\.[^.]+$/, "") : "asr-result";
  return name;
}

function toSrtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const f = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(f, 3)}`;
}

function splitForSrt(text) {
  const sentences = text
    .split(/(?<=[。！？；!?;\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks = [];
  for (let s of sentences) {
    while (s.length > 40) {
      chunks.push(s.slice(0, 40));
      s = s.slice(40);
    }
    if (s) chunks.push(s);
  }
  if (!chunks.length && text) chunks.push(text);
  return chunks;
}

function buildSrt(text) {
  const chunks = splitForSrt(text);
  const totalChars = chunks.reduce((n, c) => n + c.length, 0) || 1;
  const totalSec =
    (state.currentUsage && state.currentUsage.seconds) ||
    state.duration ||
    totalChars * 0.28;

  let cursor = 0;
  const blocks = chunks.map((chunk, i) => {
    const start = (cursor / totalChars) * totalSec;
    cursor += chunk.length;
    const end = (cursor / totalChars) * totalSec;
    return `${i + 1}\n${toSrtTime(start)} --> ${toSrtTime(end)}\n${chunk}\n`;
  });
  return blocks.join("\n");
}

async function copyResult() {
  const text = currentResultText();
  if (!text) return setStatus("没有可复制的内容", "error");
  try {
    await navigator.clipboard.writeText(text);
    setStatus("已复制到剪贴板", "ok");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    setStatus("已复制到剪贴板", "ok");
  }
}

/* ---------- history ---------- */

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(LS_HISTORY) || "[]");
  } catch {
    return [];
  }
}

function saveHistory(list) {
  localStorage.setItem(LS_HISTORY, JSON.stringify(list.slice(0, MAX_HISTORY)));
}

function addHistory(entry) {
  const list = loadHistory();
  list.unshift({ id: Date.now(), time: Date.now(), ...entry });
  saveHistory(list);
  renderHistory();
}

function renderHistory() {
  const list = loadHistory();
  els.historyList.innerHTML = "";
  els.historyEmpty.classList.toggle("hidden", list.length > 0);

  for (const item of list) {
    const li = document.createElement("li");
    li.className = "history-item";

    const main = document.createElement("div");
    main.className = "history-main";
    const title = document.createElement("div");
    title.className = "history-title";
    title.textContent = item.fileName;
    const preview = document.createElement("div");
    preview.className = "history-preview";
    preview.textContent = (item.text || "").slice(0, 120);
    const meta = document.createElement("div");
    meta.className = "history-meta";
    const langMap = { auto: "自动", zh: "中文", en: "English" };
    meta.textContent = `${new Date(item.time).toLocaleString()} · ${
      langMap[item.language] || item.language
    } · ${item.model || ""}`;
    main.append(title, preview, meta);

    const open = document.createElement("button");
    open.className = "btn ghost small";
    open.type = "button";
    open.textContent = "载入";
    open.addEventListener("click", () => {
      state.currentText = item.text || "";
      state.currentUsage = item.usage || null;
      els.resultText.textContent = state.currentText;
      renderUsage(item.usage, item.fileName);
      setStatus("已载入历史记录", "ok");
      els.resultText.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    const del = document.createElement("button");
    del.className = "btn ghost small";
    del.type = "button";
    del.textContent = "删除";
    del.addEventListener("click", () => {
      saveHistory(loadHistory().filter((x) => x.id !== item.id));
      renderHistory();
    });

    li.append(main, open, del);
    els.historyList.appendChild(li);
  }
}

/* ---------- events ---------- */

els.settingsToggle.addEventListener("click", () => {
  els.settingsPanel.classList.toggle("hidden");
});

els.saveSettings.addEventListener("click", () => saveSettings(true));

els.dropZone.addEventListener("click", () => els.fileInput.click());
els.dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    els.fileInput.click();
  }
});
els.fileInput.addEventListener("change", () => handleFile(els.fileInput.files[0]));

["dragenter", "dragover"].forEach((ev) =>
  els.dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.dropZone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  els.dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.dropZone.classList.remove("dragover");
  })
);
els.dropZone.addEventListener("drop", (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handleFile(file);
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

els.transcribeBtn.addEventListener("click", transcribe);

els.cancelBtn.addEventListener("click", () => {
  if (state.abort) state.abort.abort();
});

els.clearBtn.addEventListener("click", () => {
  if (state.abort) state.abort.abort();
  resetFile();
  els.resultText.textContent = "";
  state.currentText = "";
  state.currentUsage = null;
  renderUsage(null);
  setStatus("等待上传音频");
});

els.copyBtn.addEventListener("click", copyResult);

els.exportTxt.addEventListener("click", () => {
  const text = currentResultText();
  if (!text) return setStatus("没有可导出的内容", "error");
  downloadBlob(text, `${baseFileName()}.txt`, "text/plain;charset=utf-8");
  setStatus("已导出 TXT", "ok");
});

els.exportSrt.addEventListener("click", () => {
  const text = currentResultText();
  if (!text) return setStatus("没有可导出的内容", "error");
  downloadBlob(buildSrt(text), `${baseFileName()}.srt`, "application/x-subrip;charset=utf-8");
  setStatus("已导出 SRT（时间轴为估算）", "ok");
});

els.exportJson.addEventListener("click", () => {
  const text = currentResultText();
  if (!text) return setStatus("没有可导出的内容", "error");
  const data = {
    file: state.file ? state.file.name : null,
    model: loadSettings().model,
    language: loadSettings().language,
    exported_at: new Date().toISOString(),
    text,
    usage: state.currentUsage,
  };
  downloadBlob(JSON.stringify(data, null, 2), `${baseFileName()}.json`, "application/json;charset=utf-8");
  setStatus("已导出 JSON", "ok");
});

els.clearHistory.addEventListener("click", () => {
  if (!loadHistory().length) return;
  if (confirm("确定清空全部历史记录？")) {
    localStorage.removeItem(LS_HISTORY);
    renderHistory();
    setStatus("历史已清空", "ok");
  }
});

/* ---------- init ---------- */

applySettingsToForm(loadSettings());
renderHistory();
setStatus("等待上传音频");
