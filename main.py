import asyncio
import base64
import binascii
import json
import logging
import os
import random
import re
import shutil
import socket
import subprocess
import tempfile
import time
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote_to_bytes

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

DEFAULT_BASE_URL = "https://api.xiaomimimo.com"
DEFAULT_MODEL = "mimo-v2.5-asr"
APP_VERSION = "1.4.0"

MAX_B64_CHARS = 10_000_000  # 官方限制：base64 字符串 <= 10MB
RAW_LIMIT = (MAX_B64_CHARS - 8) * 3 // 4
SEGMENT_SECONDS = 300
SEGMENT_BITRATE = "64k"
MAX_ATTEMPTS = 4
MIN_SPLIT_BYTES = 400_000  # 连接持续失败时自动把段拆到该大小以下
RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}
FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
TIMEOUT = httpx.Timeout(connect=15.0, read=120.0, write=180.0, pool=15.0)

FMT_MIME = {"wav": "audio/wav", "mp3": "audio/mpeg"}
MIME_EXT = {
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/mp4": ".m4a",
    "audio/aac": ".aac",
    "audio/ogg": ".ogg",
    "audio/flac": ".flac",
    "audio/webm": ".webm",
}

logger = logging.getLogger("asr")
logger.setLevel(logging.INFO)
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(_handler)
    logger.propagate = False

async def loop_lag_monitor():
    loop = asyncio.get_running_loop()
    last = loop.time()
    while True:
        await asyncio.sleep(2.0)
        now = loop.time()
        lag = (now - last) - 2.0
        last = now
        if lag > 1.0:
            logger.warning("event loop lagged %.1fs (server was blocked)", lag)


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(loop_lag_monitor())
    yield
    task.cancel()


app = FastAPI(title="MiMo ASR", version=APP_VERSION, lifespan=lifespan)


class AudioPayload(BaseModel):
    data_url: str


class TranscribeRequest(BaseModel):
    base_url: str = DEFAULT_BASE_URL
    api_key: str = ""
    model: str = DEFAULT_MODEL
    language: str = "auto"
    stream: bool = False
    audio: AudioPayload


class UpstreamError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message
        super().__init__(message)


class UpstreamConnError(UpstreamError):
    """连接层失败（超时/断开），可通过拆小分段重试。"""


@dataclass
class Segment:
    data: bytes
    mime: str


@dataclass
class Job:
    base_url: str
    api_key: str
    model: str
    language: str
    stream: bool
    path: str
    filename: str | None
    mime: str | None


def as_bool(value) -> bool:
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def remove_quiet(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def upstream_url(job: Job) -> str:
    base = job.base_url.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    if re.search(r"/v\d+(\.\d+)?$", base):
        return base + "/chat/completions"
    return base + "/v1/chat/completions"


def dns_hint(url: str) -> str:
    try:
        host = httpx.URL(url).host
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
        ips = sorted({i[4][0] for i in infos})
        return ",".join(ips[:8])
    except Exception:
        return "?"


def upstream_headers(job: Job) -> dict:
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {job.api_key}",
        "api-key": job.api_key,
    }


def exc_text(exc: BaseException) -> str:
    detail = str(exc).strip()
    return f"{type(exc).__name__}: {detail}" if detail else type(exc).__name__


def detect_format(path: str) -> str | None:
    try:
        with open(path, "rb") as f:
            head = f.read(12)
    except OSError:
        return None
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "wav"
    if head[:3] == b"ID3":
        return "mp3"
    if len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0:
        return "mp3"
    return None


def ffmpeg_segments(path: str) -> list[Segment]:
    if not FFMPEG:
        raise HTTPException(
            status_code=501,
            detail="音频超过 10MB 或不是 mp3/wav，需要 ffmpeg 转码分段，但服务器未安装 ffmpeg",
        )
    t0 = time.monotonic()
    with tempfile.TemporaryDirectory() as td:
        pattern = os.path.join(td, "seg_%03d.mp3")
        cmd = [
            FFMPEG, "-y", "-v", "error", "-vn",
            "-i", path,
            "-f", "segment",
            "-segment_time", str(SEGMENT_SECONDS),
            "-c:a", "libmp3lame",
            "-b:a", SEGMENT_BITRATE,
            "-ac", "1",
            "-ar", "16000",
            pattern,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            logger.error("ffmpeg failed in %.1fs: %s", time.monotonic() - t0, proc.stderr.strip()[-500:])
            raise HTTPException(
                status_code=422,
                detail=f"音频转码失败: {proc.stderr.strip()[-800:]}",
            )
        files = sorted(Path(td).glob("seg_*.mp3"))
        if not files:
            raise HTTPException(status_code=422, detail="音频转码失败：未生成任何音频分段")
        segments = []
        for fp in files:
            data = fp.read_bytes()
            if len(base64.b64encode(data)) > MAX_B64_CHARS:
                raise HTTPException(status_code=422, detail="音频分段后仍超过 10MB 限制")
            segments.append(Segment(data=data, mime="audio/mpeg"))
        logger.info(
            "ffmpeg segmented %s -> %d parts in %.1fs (segment=%ss, bitrate=%s)",
            os.path.basename(path), len(segments), time.monotonic() - t0, SEGMENT_SECONDS, SEGMENT_BITRATE,
        )
        return segments


def build_segments(path: str) -> list[Segment]:
    size = os.path.getsize(path)
    fmt = detect_format(path)
    logger.info("build_segments: file=%d bytes, sniffed=%s", size, fmt)
    if fmt and size <= RAW_LIMIT:
        segs = [Segment(data=Path(path).read_bytes(), mime=FMT_MIME[fmt])]
        logger.info("build_segments: pass-through single segment (%d bytes)", size)
        return segs
    return ffmpeg_segments(path)


def probe_duration(path: str) -> float | None:
    if not FFPROBE:
        return None
    proc = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True,
    )
    try:
        return float(proc.stdout.strip())
    except ValueError:
        return None


def _split_segment_sync(segment: Segment) -> list[Segment]:
    suffix = ".wav" if segment.mime == "audio/wav" else ".mp3"
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "src" + suffix)
        Path(src).write_bytes(segment.data)
        duration = probe_duration(src)
        if not duration or duration < 4:
            return []
        pattern = os.path.join(td, "out_%03d.mp3")
        cmd = [
            FFMPEG, "-y", "-v", "error", "-vn",
            "-i", src,
            "-f", "segment",
            "-segment_time", f"{duration / 2:.3f}",
            "-c:a", "libmp3lame",
            "-b:a", SEGMENT_BITRATE,
            "-ac", "1",
            "-ar", "16000",
            pattern,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            logger.error("split ffmpeg failed: %s", proc.stderr.strip()[-400:])
            return []
        out = []
        for fp in sorted(Path(td).glob("out_*.mp3")):
            data = fp.read_bytes()
            if len(base64.b64encode(data)) > MAX_B64_CHARS:
                return []
            out.append(Segment(data=data, mime="audio/mpeg"))
        return out if len(out) >= 2 else []


async def split_segment(segment: Segment) -> list[Segment]:
    if not FFMPEG:
        return []
    return await asyncio.to_thread(_split_segment_sync, segment)


def decode_data_url(data_url: str) -> tuple[bytes, str | None]:
    m = re.match(r"^data:([^;,]*)(;base64)?,(.*)$", data_url, re.S)
    if not m:
        raise HTTPException(status_code=400, detail="audio.data_url 格式错误")
    mime, is_b64, payload = m.group(1), bool(m.group(2)), m.group(3)
    try:
        data = base64.b64decode(payload) if is_b64 else unquote_to_bytes(payload)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"音频 base64 解码失败: {exc}")
    return data, (mime or None)


def write_temp(data: bytes, filename: str | None) -> str:
    suffix = os.path.splitext(filename or "")[1]
    fd, path = tempfile.mkstemp(prefix="asr_", suffix=suffix)
    with os.fdopen(fd, "wb") as out:
        out.write(data)
    return path


async def parse_job(request: Request) -> Job:
    ctype = (request.headers.get("content-type") or "").lower()

    if ctype.startswith("multipart/form-data"):
        form = await request.form()
        upload = form.get("file")
        if upload is None or not hasattr(upload, "read"):
            raise HTTPException(status_code=400, detail="缺少音频文件字段 file")
        filename = getattr(upload, "filename", None) or None
        mime = getattr(upload, "content_type", None) or None
        suffix = os.path.splitext(filename or "")[1]
        fd, path = tempfile.mkstemp(prefix="asr_", suffix=suffix)
        os.close(fd)

        def _spool() -> None:
            with open(path, "wb") as out:
                upload.file.seek(0)
                shutil.copyfileobj(upload.file, out)

        await asyncio.to_thread(_spool)
        logger.info(
            "upload received: name=%s size=%.1fMB -> %s",
            filename, os.path.getsize(path) / 1048576, path,
        )
        return Job(
            base_url=str(form.get("base_url") or DEFAULT_BASE_URL).strip(),
            api_key=str(form.get("api_key") or "").strip(),
            model=str(form.get("model") or DEFAULT_MODEL).strip(),
            language=str(form.get("language") or "auto").strip(),
            stream=as_bool(form.get("stream")),
            path=path,
            filename=filename,
            mime=mime,
        )

    try:
        body = await request.json()
        req = TranscribeRequest(**body)
    except Exception:
        raise HTTPException(status_code=400, detail="请求体必须是 JSON 或 multipart/form-data")

    if not req.audio.data_url.startswith("data:"):
        raise HTTPException(status_code=400, detail="audio.data_url must be a data URL")
    data, mime = decode_data_url(req.audio.data_url)
    filename = "audio" + MIME_EXT.get(mime or "", "")
    path = write_temp(data, filename)
    logger.info("json received: name=%s size=%.1fMB", filename, len(data) / 1048576)
    return Job(
        base_url=req.base_url.strip() or DEFAULT_BASE_URL,
        api_key=req.api_key.strip(),
        model=req.model.strip() or DEFAULT_MODEL,
        language=req.language.strip() or "auto",
        stream=req.stream,
        path=path,
        filename=filename,
        mime=mime,
    )


def build_payload(job: Job, segment: Segment, stream: bool) -> dict:
    b64 = base64.b64encode(segment.data).decode("ascii")
    return {
        "model": job.model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_audio",
                        "input_audio": {"data": f"data:{segment.mime};base64,{b64}"},
                    }
                ],
            }
        ],
        "asr_options": {"language": job.language},
        "stream": stream,
    }


def merge_usage(a, b):
    if not b:
        return a
    if not a:
        return b
    out = {}
    for key in set(a) | set(b):
        va, vb = a.get(key), b.get(key)
        if isinstance(va, dict) or isinstance(vb, dict):
            merged = merge_usage(va if isinstance(va, dict) else None, vb if isinstance(vb, dict) else None)
            out[key] = merged if merged is not None else (va if va is not None else vb)
        elif isinstance(va, (int, float)) and isinstance(vb, (int, float)):
            out[key] = va + vb
        else:
            out[key] = va if va is not None else vb
    return out


def error_event(status_code, message) -> bytes:
    payload = {"error": {"status_code": status_code, "message": message}}
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()


def info_event(payload: dict) -> bytes:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()


async def call_nonstream(client, job, payload, idx, total) -> dict:
    url = upstream_url(job)
    headers = upstream_headers(job)
    dns = dns_hint(url)
    last_status = 502
    last_detail = "unknown"
    last_conn_exc = None

    for attempt in range(1, MAX_ATTEMPTS + 1):
        t0 = time.monotonic()
        try:
            response = await client.post(url, json=payload, headers=headers)
        except httpx.HTTPError as exc:
            last_status = 502
            last_detail = exc_text(exc)
            last_conn_exc = exc
            logger.warning(
                "segment %d/%d attempt %d/%d exception[send/wait-headers] after %.1fs: %r (dns=%s)",
                idx, total, attempt, MAX_ATTEMPTS, time.monotonic() - t0, repr(exc), dns,
            )
            data_url = payload["messages"][0]["content"][0]["input_audio"]["data"]
            too_big_to_keep_retrying = len(data_url) * 3 // 4 > MIN_SPLIT_BYTES and attempt >= 2
            if too_big_to_keep_retrying:
                break
            if attempt < MAX_ATTEMPTS:
                await asyncio.sleep(min(2 ** (attempt - 1), 8) + random.random() * 2)
                continue
            break

        elapsed = time.monotonic() - t0
        if response.status_code == 200:
            logger.info("segment %d/%d ok in %.1fs (attempt %d)", idx, total, elapsed, attempt)
            return response.json()

        body = response.text.strip()[:500]
        last_status = response.status_code
        last_detail = body or "(空响应体)"
        last_conn_exc = None
        logger.warning(
            "segment %d/%d attempt %d/%d -> HTTP %d in %.1fs body=%r (dns=%s)",
            idx, total, attempt, MAX_ATTEMPTS, response.status_code, elapsed, body, dns,
        )
        if response.status_code == 413:
            break
        if response.status_code in RETRYABLE_STATUS and attempt < MAX_ATTEMPTS:
            await asyncio.sleep(min(2 ** (attempt - 1), 8) + random.random() * 2)
            continue
        break

    msg = f"第 {idx}/{total} 段失败: HTTP {last_status}: {last_detail}"
    if last_conn_exc is not None:
        raise UpstreamConnError(last_status, msg)
    raise UpstreamError(last_status, msg)


def can_split(exc: UpstreamError, segment: Segment) -> bool:
    if len(segment.data) <= MIN_SPLIT_BYTES:
        return False
    if isinstance(exc, UpstreamConnError):
        return True
    return exc.status in RETRYABLE_STATUS or exc.status == 413


async def run_nonstream(job: Job, segments: list[Segment]) -> dict:
    texts: list[str] = []
    usage = None
    pending = deque(segments)
    total = len(segments)
    idx = 0
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        while pending:
            segment = pending.popleft()
            idx += 1
            payload = build_payload(job, segment, stream=False)
            try:
                data = await call_nonstream(client, job, payload, idx, total)
            except UpstreamError as exc:
                if can_split(exc, segment):
                    parts = await split_segment(segment)
                    if parts:
                        total += len(parts) - 1
                        logger.warning(
                            "segment %d/%d split into %d parts after failure: %s (total now %d)",
                            idx, total, len(parts), exc.message, total,
                        )
                        pending.extendleft(reversed(parts))
                        idx -= 1
                        continue
                raise
            if data.get("error"):
                raise UpstreamError(502, f"第 {idx}/{total} 段失败: {json.dumps(data['error'], ensure_ascii=False)}")
            choices = data.get("choices") or []
            texts.append((choices[0].get("message") or {}).get("content") or "")
            usage = merge_usage(usage, data.get("usage"))

    return {
        "id": f"asr-{int(time.time() * 1000)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": job.model,
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": "\n".join(texts)},
            }
        ],
        "usage": usage,
        "segment_count": total,
    }


def extract_usage(line: bytes, usage):
    text = line.strip()
    if not text.startswith(b"data:"):
        return usage
    text = text[5:].strip()
    if not text or text == b"[DONE]":
        return usage
    try:
        obj = json.loads(text)
    except Exception:
        return usage
    return merge_usage(usage, obj.get("usage"))


async def stream_segments(job: Job, segments: list[Segment]):
    pending = deque(segments)
    total = len(segments)
    finished = 0
    usage = None
    url = upstream_url(job)
    headers = upstream_headers(job)
    dns = dns_hint(url)
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        while pending:
            segment = pending.popleft()
            finished += 1
            if finished > 1:
                yield b'data: {"choices":[{"index":0,"delta":{"content":"\\n"}}]}\n\n'
            yield info_event({"segment_index": finished, "segment_total": total})

            payload = build_payload(job, segment, stream=True)
            upstream = None
            last_status = 502
            last_detail = "unknown"
            last_conn_exc = None

            for attempt in range(1, MAX_ATTEMPTS + 1):
                t0 = time.monotonic()
                try:
                    request = client.build_request("POST", url, json=payload, headers=headers)
                    response = await client.send(request, stream=True)
                except httpx.HTTPError as exc:
                    last_status = 502
                    last_detail = exc_text(exc)
                    last_conn_exc = exc
                    logger.warning(
                        "segment %d/%d attempt %d/%d exception[send/wait-headers] after %.1fs: %r (dns=%s)",
                        finished, total, attempt, MAX_ATTEMPTS, time.monotonic() - t0, repr(exc), dns,
                    )
                    if len(segment.data) > MIN_SPLIT_BYTES and attempt >= 2:
                        break
                    if attempt < MAX_ATTEMPTS:
                        await asyncio.sleep(min(2 ** (attempt - 1), 8) + random.random() * 2)
                        continue
                    break

                if response.status_code == 200:
                    logger.info(
                        "segment %d/%d headers in %.1fs (attempt %d) payload=%dB (dns=%s)",
                        finished, total, time.monotonic() - t0, attempt, len(segment.data), dns,
                    )
                    upstream = response
                    break

                body = (await response.aread()).decode("utf-8", errors="replace").strip()[:500]
                await response.aclose()
                last_status = response.status_code
                last_detail = body or "(空响应体)"
                last_conn_exc = None
                logger.warning(
                    "segment %d/%d attempt %d/%d -> HTTP %d in %.1fs body=%r (dns=%s)",
                    finished, total, attempt, MAX_ATTEMPTS, response.status_code, time.monotonic() - t0, body, dns,
                )
                if response.status_code == 413:
                    break
                if response.status_code in RETRYABLE_STATUS and attempt < MAX_ATTEMPTS:
                    await asyncio.sleep(min(2 ** (attempt - 1), 8) + random.random() * 2)
                    continue
                break

            if upstream is None:
                msg = f"第 {finished}/{total} 段失败: HTTP {last_status}: {last_detail}"
                splittable_status = last_status in RETRYABLE_STATUS or last_status == 413
                if len(segment.data) > MIN_SPLIT_BYTES and (last_conn_exc is not None or splittable_status):
                    parts = await split_segment(segment)
                    if parts:
                        total += len(parts) - 1
                        logger.warning(
                            "segment %d split into %d parts after failure: %s (total now %d)",
                            finished, len(parts), msg, total,
                        )
                        yield info_event({"split": {"index": finished, "parts": len(parts), "total": total}})
                        pending.extendleft(reversed(parts))
                        continue
                yield error_event(last_status, msg)
                return

            try:
                t0 = time.monotonic()
                first_byte_logged = False
                buffer = b""
                async for chunk in upstream.aiter_bytes():
                    if not first_byte_logged:
                        logger.info("segment %d/%d first byte after %.1fs", finished, total, time.monotonic() - t0)
                        first_byte_logged = True
                    yield chunk
                    buffer += chunk
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        usage = extract_usage(line, usage)
                usage = extract_usage(buffer, usage)
                logger.info("segment %d/%d stream done in %.1fs", finished, total, time.monotonic() - t0)
            except httpx.HTTPError as exc:
                logger.warning(
                    "segment %d/%d relay failed after %.1fs: %r",
                    finished, total, time.monotonic() - t0, repr(exc),
                )
                yield error_event(502, f"第 {finished}/{total} 段流中断: {exc_text(exc)}")
                return
            finally:
                await upstream.aclose()

    if usage is not None:
        yield info_event({"usage": usage, "segment_count": total})
    yield b"data: [DONE]\n\n"


async def run_stream(job: Job):
    try:
        yield info_event({"prepare": "服务端转码分段中…"})
        t0 = time.monotonic()
        try:
            segments = await asyncio.to_thread(build_segments, job.path)
        except HTTPException as exc:
            yield error_event(exc.status_code, exc.detail if isinstance(exc.detail, str) else json.dumps(exc.detail, ensure_ascii=False))
            return
        yield info_event({"prepared": {"segments": len(segments), "elapsed": round(time.monotonic() - t0, 1)}})
        async for chunk in stream_segments(job, segments):
            yield chunk
    except Exception as exc:
        logger.exception("stream aborted")
        yield error_event(500, f"服务端异常: {exc_text(exc)}")
    finally:
        remove_quiet(job.path)


@app.post("/api/transcribe")
async def transcribe(request: Request):
    job = await parse_job(request)
    if not job.api_key:
        remove_quiet(job.path)
        raise HTTPException(status_code=401, detail="api_key 不能为空，请在设置中填写 API Key")

    if job.stream:
        return StreamingResponse(
            run_stream(job),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    try:
        segments = await asyncio.to_thread(build_segments, job.path)
    except HTTPException:
        remove_quiet(job.path)
        raise
    except Exception as exc:
        remove_quiet(job.path)
        raise HTTPException(status_code=500, detail=f"音频分段失败: {exc_text(exc)}")
    remove_quiet(job.path)

    try:
        return await run_nonstream(job, segments)
    except UpstreamError as exc:
        raise HTTPException(status_code=exc.status if 400 <= exc.status < 600 else 502, detail=exc.message)


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": APP_VERSION, "ffmpeg": bool(FFMPEG)}


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("ASR_HOST", "127.0.0.1")
    port = int(os.environ.get("ASR_PORT", "8000"))
    uvicorn.run(app, host=host, port=port)
