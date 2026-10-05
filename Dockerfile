# MiMo ASR — 多阶段构建，含 ffmpeg，非 root 运行
FROM python:3.12-slim-bookworm

ARG VERSION=dev
LABEL org.opencontainers.image.title="mimo-asr" \
      org.opencontainers.image.description="MiMo-V2.5-ASR speech recognition web service" \
      org.opencontainers.image.version="${VERSION}"

ENV ASR_HOST=0.0.0.0 \
    ASR_PORT=8000 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY main.py .
COPY static/ ./static/

RUN useradd --create-home --uid 10001 asr \
    && chown -R asr:asr /app
USER asr

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request,sys; r=urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4); sys.exit(0 if r.status==200 else 1)"

CMD ["python", "main.py"]
