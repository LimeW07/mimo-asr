#!/usr/bin/env bash
# macOS / Linux 原生一键启动
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v python3 >/dev/null 2>&1; then
  echo "[错误] 未找到 python3，请先安装 Python 3.10+" >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[警告] 未找到 ffmpeg：超过 10MB 或非 mp3/wav 的音频将无法转码分段" >&2
  echo "       macOS: brew install ffmpeg   |   Debian/Ubuntu: sudo apt install ffmpeg" >&2
fi

if [ ! -d .venv ]; then
  echo "[1/2] 创建虚拟环境 ..."
  python3 -m venv .venv
fi
if ! .venv/bin/python -c "import fastapi" >/dev/null 2>&1; then
  echo "[2/2] 安装依赖 ..."
  .venv/bin/pip install -q -r requirements.txt
fi

PORT="${ASR_PORT:-8000}"
echo "启动 MiMo ASR -> http://127.0.0.1:${PORT}"
exec .venv/bin/python main.py
