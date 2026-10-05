/**
 * 纯静态 Web 版浏览器端到端测试（直连 mock，验证浏览器端分段）。
 * 前置：
 *   1. python3 -m http.server 8080 --directory web     （静态站）
 *   2. uvicorn tests.mock_asr:app --port 9000           （mock 上游，已开 CORS）
 *   3. Chrome --headless --remote-debugging-port=9222
 * 运行：
 *   APP_URL=http://127.0.0.1:8080 MOCK_URL=http://127.0.0.1:9000 node tests/cdp_web_test.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_URL = process.env.APP_URL || "http://127.0.0.1:8080";
const MOCK_URL = process.env.MOCK_URL || "http://127.0.0.1:9000";
const DEBUG = `http://127.0.0.1:${process.env.CDP_PORT || "9222"}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function ensureFixtures() {
  const dir = join(root, "web", "test", "fixtures");
  mkdirSync(dir, { recursive: true });
  const mp3 = join(dir, "big600.mp3");
  if (!existsSync(mp3)) {
    execFileSync("ffmpeg", [
      "-y", "-v", "error", "-f", "lavfi", "-i", "anoisesrc=d=600",
      "-c:a", "libmp3lame", "-b:a", "128k", mp3,
    ], { stdio: "pipe" });
  }
  return { mp3Fixture: "/test/fixtures/big600.mp3" };
}

async function newTarget() {
  const res = await fetch(`${DEBUG}/json/new?${encodeURIComponent(APP_URL)}`, { method: "PUT" });
  return res.json();
}

function makeWavJs(seconds) {
  return `
    (() => {
      const sr = 16000, n = sr * ${seconds};
      const buf = new ArrayBuffer(44 + n * 2);
      const v = new DataView(buf);
      const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      ws(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
      v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      ws(36, 'data'); v.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i / sr * 2 * Math.PI * 440) * 3000), true);
      const file = new File([buf], 'web-' + ${seconds} + 's.wav', { type: 'audio/wav' });
      const dt = new DataTransfer(); dt.items.add(file);
      document.getElementById('dropZone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return 'dropped';
    })()
  `;
}

async function main() {
  const fixtures = ensureFixtures();
  const target = await newTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const exceptions = [];

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method === "Runtime.exceptionThrown") {
      exceptions.push(msg.params.exceptionDetails.text || "exception");
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
    }
    return r.result.value;
  };
  await send("Runtime.enable");

  for (let i = 0; i < 50; i++) {
    if (await evalJs("document.readyState === 'complete' && !!document.getElementById('transcribeBtn')")) break;
    await sleep(200);
  }

  const failures = [];
  const check = (label, ok, info = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${info ? "  [" + info + "]" : ""}`);
    if (!ok) failures.push(label);
  };

  const waitFor = async (expr, tries = 240, gap = 250) => {
    let v = "";
    for (let i = 0; i < tries; i++) {
      v = await evalJs(expr);
      if (v) break;
      await sleep(gap);
    }
    return v;
  };

  // 1. 设置（直连 mock）
  await evalJs(`
    localStorage.removeItem('mimo-asr-history');
    document.getElementById('settingsToggle').click();
    document.getElementById('baseUrl').value = '${MOCK_URL}';
    document.getElementById('apiKey').value = 'test-key';
    document.getElementById('modelId').value = 'mimo-v2.5-asr';
    document.getElementById('apiMode').value = 'direct';
    document.getElementById('language').value = 'auto';
    document.getElementById('streamMode').checked = true;
    document.getElementById('saveSettings').click();
    JSON.parse(localStorage.getItem('mimo-asr-settings')).mode
  `).then((v) => check("settings saved (direct mode)", v === "direct", String(v)));

  // 2. 小 wav 直传
  await evalJs(makeWavJs(1));
  await waitFor(`!document.getElementById('transcribeBtn').disabled`);
  await evalJs(`document.getElementById('transcribeBtn').click(); 'x'`);
  let st = await waitFor(`(() => { const s = document.getElementById('status').textContent; return s === '识别完成' || s.startsWith('识别失败') ? s : ''; })()`);
  check("small wav direct success", st === "识别完成", st);
  let text = await evalJs(`document.getElementById('resultText').textContent`);
  check("small wav result format", /^b64=\d+$/.test(text.trim()), JSON.stringify(text.slice(0, 80)));

  // 3. 大 wav（720s，浏览器端分段 4 段）
  await evalJs(makeWavJs(720));
  await waitFor(`!document.getElementById('transcribeBtn').disabled`);
  await evalJs(`document.getElementById('transcribeBtn').click(); 'x'`);
  st = await waitFor(`(() => { const s = document.getElementById('status').textContent; return s === '识别完成' || s.startsWith('识别失败') ? s : ''; })()`);
  text = await evalJs(`document.getElementById('resultText').textContent`);
  const parts = [...text.matchAll(/b64=(\d+)/g)].map((m) => Number(m[1]));
  check("big wav status", st === "识别完成", st);
  check("big wav client-side 4 segments", parts.length === 4, JSON.stringify(parts));
  check("big wav segments <= 10MB b64", parts.length === 4 && parts.every((n) => n <= 10_000_000), JSON.stringify(parts));
  const nl = (text.match(/\n/g) || []).length;
  check("newlines between segments", nl === 3, String(nl));
  const usage2 = await evalJs(`document.getElementById('usage').textContent`);
  check("usage aggregated (16s / 60 tokens)", usage2.includes("音频 16s") && usage2.includes("tokens 60"), usage2);

  // 4. 大 mp3（600s CBR fixture，帧边界分段）
  const mp3Drop = `
    (async () => {
      const res = await fetch('${fixtures.mp3Fixture}');
      const blob = await res.blob();
      const file = new File([blob], 'big600.mp3', { type: 'audio/mpeg' });
      const dt = new DataTransfer(); dt.items.add(file);
      document.getElementById('dropZone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return 'dropped';
    })()
  `;
  await evalJs(mp3Drop);
  await waitFor(`!document.getElementById('transcribeBtn').disabled`);
  await evalJs(`document.getElementById('transcribeBtn').click(); 'x'`);
  st = await waitFor(`(() => { const s = document.getElementById('status').textContent; return s === '识别完成' || s.startsWith('识别失败') ? s : ''; })()`);
  text = await evalJs(`document.getElementById('resultText').textContent`);
  const mp3Parts = [...text.matchAll(/b64=(\d+)/g)].map((m) => Number(m[1]));
  check("big mp3 status", st === "识别完成", st);
  check("big mp3 segmented", mp3Parts.length >= 2, JSON.stringify(mp3Parts));
  check("big mp3 segments <= 10MB b64", mp3Parts.every((n) => n <= 10_000_000), JSON.stringify(mp3Parts));

  // 5. 历史 3 条
  const history = await evalJs(`JSON.parse(localStorage.getItem('mimo-asr-history') || '[]').length`);
  check("history 3 entries", history === 3, String(history));

  // 6. 代理模式（无 function 的静态服务器 → 应报错而非静默）
  await evalJs(`
    (() => {
      document.getElementById('apiMode').value = 'proxy';
      document.getElementById('saveSettings').click();
      return 'ok';
    })()
  `);
  await evalJs(makeWavJs(1));
  await waitFor(`!document.getElementById('transcribeBtn').disabled`);
  await evalJs(`document.getElementById('transcribeBtn').click(); 'x'`);
  st = await waitFor(`(() => { const s = document.getElementById('status').textContent; return s.startsWith('识别失败') || s === '识别完成' ? s : ''; })()`, 40);
  check("proxy mode without function reports error", st.startsWith("识别失败"), st);
  await evalJs(`document.getElementById('apiMode').value = 'direct'; document.getElementById('saveSettings').click(); 'ok'`);

  check("no uncaught page exceptions", exceptions.length === 0, exceptions.join("; "));

  ws.close();
  console.log(failures.length ? `\n${failures.length} FAILURES` : "\nALL PASS");
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error("TEST ERROR:", e);
  process.exit(1);
});
