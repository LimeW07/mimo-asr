/**
 * 浏览器端到端测试（需要本机 Chrome 与已启动的 mock 上游）:
 *   MOCK_PORT=9000 APP_URL=http://127.0.0.1:8000 CDP_PORT=9222 node tests/cdp_test.mjs
 */
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8000";
const MOCK_PORT = process.env.MOCK_PORT || "9000";
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;
const DEBUG = `http://127.0.0.1:${process.env.CDP_PORT || "9222"}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      const file = new File([buf], 'long-' + ${seconds} + 's.wav', { type: 'audio/wav' });
      const dt = new DataTransfer();
      dt.items.add(file);
      document.getElementById('dropZone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return 'dropped';
    })()
  `;
}

async function main() {
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
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || "")
      );
    }
    return r.result.value;
  };

  await send("Runtime.enable");

  for (let i = 0; i < 50; i++) {
    const ready = await evalJs(
      "document.readyState === 'complete' && !!document.getElementById('transcribeBtn')"
    );
    if (ready) break;
    await sleep(200);
  }

  const failures = [];
  const check = (label, ok, info = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${info ? "  [" + info + "]" : ""}`);
    if (!ok) failures.push(label);
  };

  // 1. 设置
  await evalJs(`
    localStorage.removeItem('mimo-asr-history');
    document.getElementById('settingsToggle').click();
    document.getElementById('baseUrl').value = '${MOCK_URL}';
    document.getElementById('apiKey').value = 'test-key';
    document.getElementById('modelId').value = 'mimo-v2.5-asr';
    document.getElementById('language').value = 'auto';
    document.getElementById('streamMode').checked = true;
    document.getElementById('saveSettings').click();
    JSON.parse(localStorage.getItem('mimo-asr-settings')).baseUrl
  `).then((v) => check("settings saved", v === MOCK_URL, String(v)));

  // 2. 小文件拖拽（multipart 直传）
  await evalJs(`
    (() => {
      const sr = 16000, n = sr;
      const buf = new ArrayBuffer(44 + n * 2);
      const v = new DataView(buf);
      const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      ws(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
      v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      ws(36, 'data'); v.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i / sr * 2 * Math.PI * 440) * 3000), true);
      const file = new File([buf], 'demo.wav', { type: 'audio/wav' });
      const dt = new DataTransfer(); dt.items.add(file);
      document.getElementById('dropZone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return 'dropped';
    })()
  `);
  let ready = false;
  for (let i = 0; i < 50; i++) {
    ready = await evalJs("!document.getElementById('transcribeBtn').disabled");
    if (ready) break;
    await sleep(200);
  }
  check("small file ready, button enabled", ready);
  check(
    "file info shown",
    (await evalJs(`document.getElementById('fileName').textContent`)) === "demo.wav"
  );

  // 3. 流式识别小文件
  await evalJs(`document.getElementById('transcribeBtn').click(); 'clicked'`);
  let text = "";
  for (let i = 0; i < 60; i++) {
    text = await evalJs(`document.getElementById('resultText').textContent`);
    if (text.includes("b64=")) break;
    await sleep(250);
  }
  const smallMatch = /^b64=(\d+)$/.exec(text.trim());
  check("small stream result", !!smallMatch, JSON.stringify(text));
  if (smallMatch) check("small b64 within 10MB", Number(smallMatch[1]) <= 10_000_000, smallMatch[1]);
  let st = "";
  for (let i = 0; i < 120; i++) {
    st = await evalJs(`document.getElementById('status').textContent`);
    if (st === "识别完成" || st.startsWith("识别失败")) break;
    await sleep(250);
  }
  check("status success", st === "识别完成", st);
  const usage1 = await evalJs(`document.getElementById('usage').textContent`);
  check("usage rendered", usage1.includes("tokens 15") && usage1.includes("耗时"), usage1);

  // 4. 长文件（12 分钟 > 10MB base64 → 服务端分段，300s/段 = 3 段）
  await evalJs(makeWavJs(720));
  ready = false;
  for (let i = 0; i < 50; i++) {
    ready = await evalJs("!document.getElementById('transcribeBtn').disabled");
    if (ready) break;
    await sleep(200);
  }
  check("long file ready", ready);
  let meta = "";
  for (let i = 0; i < 50; i++) {
    meta = await evalJs(`document.getElementById('fileMeta').textContent`);
    if (meta.includes("时长 ")) break;
    await sleep(200);
  }
  check("long file duration shown", meta.includes("时长 12分0秒"), meta);

  await evalJs(`document.getElementById('transcribeBtn').click(); 'clicked'`);
  let st2 = "";
  for (let i = 0; i < 240; i++) {
    st2 = await evalJs(`document.getElementById('status').textContent`);
    if (st2 === "识别完成" || st2.startsWith("识别失败")) break;
    await sleep(250);
  }
  text = await evalJs(`document.getElementById('resultText').textContent`);
  const longParts = [...text.matchAll(/b64=(\d+)/g)].map((m) => Number(m[1]));
  check("long file segmented into 3 chunks", longParts.length === 3, JSON.stringify(longParts));
  check(
    "all segments within 10MB",
    longParts.length === 3 && longParts.every((n) => n <= 10_000_000),
    JSON.stringify(longParts)
  );
  const newlines = (text.match(/\n/g) || []).length;
  check("newline injected between segments", newlines === 2, JSON.stringify(text));
  check("long file status success", st2 === "识别完成", st2);
  const usage2 = await evalJs(`document.getElementById('usage').textContent`);
  check(
    "aggregated usage across segments",
    usage2.includes("音频 12s") && usage2.includes("tokens 45"),
    usage2
  );

  // 5. 历史记录 2 条
  const historyCount = await evalJs(
    `JSON.parse(localStorage.getItem('mimo-asr-history') || '[]').length`
  );
  check("history saved 2 entries", historyCount === 2, `count=${historyCount}`);

  // 6. 导出
  const srtOk = await evalJs(
    `(() => { document.getElementById('exportSrt').click(); return document.getElementById('status').textContent; })()`
  );
  check("srt export", srtOk.includes("已导出 SRT"), srtOk);

  // 7. 缺少 API Key 的处理
  await evalJs(`
    (() => {
      document.getElementById('clearBtn').click();
      document.getElementById('apiKey').value = '';
      document.getElementById('saveSettings').click();
      return 'ok';
    })()
  `);
  await evalJs(makeWavJs(1));
  for (let i = 0; i < 50; i++) {
    if (await evalJs(`!document.getElementById('transcribeBtn').disabled`)) break;
    await sleep(200);
  }
  await evalJs(`document.getElementById('transcribeBtn').click(); 'x'`);
  await sleep(800);
  const errStatus = await evalJs(`document.getElementById('status').textContent`);
  check("empty api key handled", errStatus.includes("API Key"), errStatus);

  check("no uncaught page exceptions", exceptions.length === 0, exceptions.join("; "));

  ws.close();
  console.log(failures.length ? `\n${failures.length} FAILURES` : "\nALL PASS");
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error("TEST ERROR:", e);
  process.exit(1);
});
