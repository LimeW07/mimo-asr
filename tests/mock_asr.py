"""本地模拟 MiMo ASR 上游，用于测试（不依赖真实 API Key）。

路由:
  POST /v1/chat/completions              正常返回（校验 payload 结构与 10MB base64 限制）
  POST /fail/v1/chat/completions         前 2 次 500 空响应，之后成功（测重试）
  POST /alwaysfail/v1/chat/completions   恒定 502 空响应（测错误透传）
  POST /toobig/v1/chat/completions       base64 > 600KB 返回 413（测自动拆分）
  GET  /reset                            重置计数与日志
"""

import asyncio
import json

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

LOG = "/tmp/mock_asr_requests.log"
MAX_B64 = 10_000_000

fail_counter = {"n": 0}


def log_request(b64_len: int, language: str, stream: bool):
    with open(LOG, "a") as f:
        f.write(
            json.dumps(
                {"b64_chars": b64_len, "language": language, "stream": stream}
            )
            + "\n"
        )


@app.get("/reset")
async def reset():
    fail_counter["n"] = 0
    open(LOG, "w").close()
    return {"ok": True}


@app.post("/v1/chat/completions")
async def completions(request: Request):
    body = await request.json()
    assert body["model"] == "mimo-v2.5-asr", body["model"]
    assert body["asr_options"]["language"] in ("auto", "zh", "en"), body["asr_options"]
    content = body["messages"][0]["content"][0]
    assert content["type"] == "input_audio"
    data = content["input_audio"]["data"]
    assert data.startswith("data:"), "data url required"
    assert ";base64," in data
    b64 = data.split(";base64,", 1)[1]
    b64_len = len(b64)
    language = body["asr_options"]["language"]
    stream = bool(body.get("stream"))
    log_request(b64_len, language, stream)

    if b64_len > MAX_B64:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": f"base64 too long: {b64_len}", "code": "400"}},
        )

    usage = {"completion_tokens": 10, "prompt_tokens": 5, "total_tokens": 15, "seconds": 4}
    content_text = f"b64={b64_len}"

    if stream:
        async def gen():
            for piece in [content_text[:6], content_text[6:]]:
                if not piece:
                    continue
                chunk = {
                    "id": "c1",
                    "object": "chat.completion.chunk",
                    "model": body["model"],
                    "choices": [{"index": 0, "delta": {"content": piece}, "finish_reason": None}],
                }
                yield f"data: {json.dumps(chunk)}\n\n".encode()
                await asyncio.sleep(0.02)
            final = {
                "id": "c1",
                "object": "chat.completion.chunk",
                "model": body["model"],
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                "usage": usage,
            }
            yield f"data: {json.dumps(final)}\n\n".encode()
            yield b"data: [DONE]\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream")

    return {
        "id": "c2",
        "object": "chat.completion",
        "model": body["model"],
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": content_text},
            }
        ],
        "usage": usage,
    }


@app.post("/fail/v1/chat/completions")
async def fail_then_ok(request: Request):
    fail_counter["n"] += 1
    if fail_counter["n"] <= 2:
        return Response(status_code=500, content=b"", media_type="text/plain")
    return await completions(request)


@app.post("/alwaysfail/v1/chat/completions")
async def always_fail(request: Request):
    return Response(status_code=502, content=b"", media_type="text/plain")


@app.post("/toobig/v1/chat/completions")
async def too_big(request: Request):
    body = await request.json()
    data = body["messages"][0]["content"][0]["input_audio"]["data"]
    b64 = data.split(";base64,", 1)[1] if ";base64," in data else ""
    if len(b64) > 600_000:
        return Response(status_code=413, content=b"", media_type="text/plain")
    return await completions(request)
