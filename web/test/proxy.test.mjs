import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { onRequestPost, joinUpstream } from "../functions/api/proxy.js";

let upstream;
let received = null;

before(async () => {
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received = {
        path: req.url,
        auth: req.headers.authorization,
        apiKey: req.headers["api-key"],
        body: JSON.parse(body || "{}"),
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  upstream.port = upstream.address().port;
});

after(() => upstream.close());

function makeRequest(body) {
  return new Request("https://example.workers.dev/api/proxy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("joinUpstream 兼容带/不带 /v1", () => {
  assert.equal(joinUpstream("https://api.xiaomimimo.com"), "https://api.xiaomimimo.com/v1/chat/completions");
  assert.equal(joinUpstream("https://x.example.com/v1"), "https://x.example.com/v1/chat/completions");
  assert.equal(joinUpstream("https://x.example.com/v1/"), "https://x.example.com/v1/chat/completions");
  assert.equal(joinUpstream("https://x.example.com/v1/chat/completions"), "https://x.example.com/v1/chat/completions");
  assert.equal(joinUpstream("https://x.example.com/gw/v2"), "https://x.example.com/gw/v2/chat/completions");
});

test("缺字段 → 400", async () => {
  const res = await onRequestPost({ request: makeRequest({ base_url: "https://api.xiaomimimo.com" }), env: {} });
  assert.equal(res.status, 400);
  const j = await res.json();
  assert.match(j.error, /缺少/);
});

test("非 JSON → 400", async () => {
  const req = new Request("https://x/api/proxy", { method: "POST", body: "not-json" });
  const res = await onRequestPost({ request: req, env: {} });
  assert.equal(res.status, 400);
});

test("主机不在白名单 → 403", async () => {
  const res = await onRequestPost({
    request: makeRequest({
      base_url: "https://evil.example.net",
      api_key: "k",
      payload: { model: "m" },
    }),
    env: {},
  });
  assert.equal(res.status, 403);
  const j = await res.json();
  assert.match(j.error, /白名单/);
});

test("ALLOWED_HOSTS 环境变量可覆盖白名单", async () => {
  const res = await onRequestPost({
    request: makeRequest({
      base_url: `http://127.0.0.1:${upstream.port}`,
      api_key: "k",
      payload: { model: "m" },
    }),
    env: { ALLOWED_HOSTS: "127.0.0.1" },
  });
  assert.equal(res.status, 200);
});

test("转发成功：路径拼接、鉴权头、payload 原样、SSE 透传", async () => {
  received = null;
  const payload = {
    model: "mimo-v2.5-asr",
    messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "data:audio/wav;base64,AAAA" } }] }],
    asr_options: { language: "zh" },
    stream: true,
  };
  const res = await onRequestPost({
    request: makeRequest({
      base_url: `http://127.0.0.1:${upstream.port}/v1`,
      api_key: "secret-key",
      payload,
    }),
    env: { ALLOWED_HOSTS: "127.0.0.1" },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /event-stream/);
  const text = await res.text();
  assert.match(text, /"content":"ok"/);
  assert.match(text, /\[DONE\]/);

  assert.equal(received.path, "/v1/chat/completions");
  assert.equal(received.auth, "Bearer secret-key");
  assert.equal(received.apiKey, "secret-key");
  assert.deepEqual(received.body, payload);
});
