/**
 * Cloudflare Pages Function：同源代理（可选）。
 * 前端「同源代理」模式 POST /api/proxy，本函数转发到 MiMo 兼容上游。
 * 安全：主机白名单（环境变量 ALLOWED_HOSTS，默认 xiaomimimo.com），防止被当作任意代理。
 */

const DEFAULT_ALLOWLIST = "xiaomimimo.com";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function joinUpstream(base) {
  const b = String(base).replace(/\/+$/, "");
  if (b.endsWith("/chat/completions")) return b;
  if (/\/v\d+(\.\d+)?$/.test(b)) return b + "/chat/completions";
  return b + "/v1/chat/completions";
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求体必须是 JSON" }, 400);
  }

  const { base_url, api_key, payload } = body || {};
  if (!base_url || !api_key || !payload) {
    return json({ error: "缺少 base_url / api_key / payload 字段" }, 400);
  }

  let hostname;
  let displayHost;
  try {
    const u = new URL(base_url);
    hostname = u.hostname.toLowerCase();
    displayHost = u.host;
  } catch {
    return json({ error: "base_url 不是合法 URL" }, 400);
  }

  const allow = String(env?.ALLOWED_HOSTS || DEFAULT_ALLOWLIST)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allow.some((h) => hostname === h || hostname.endsWith("." + h))) {
    return json(
      { error: `上游主机不在白名单: ${displayHost}（可用环境变量 ALLOWED_HOSTS 配置，逗号分隔）` },
      403
    );
  }

  let upstream;
  try {
    upstream = await fetch(joinUpstream(base_url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${api_key}`,
        "api-key": api_key,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return json({ error: `上游请求失败: ${err?.message || err}` }, 502);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-cache",
    },
  });
}
