@echo off
rem Windows 原生一键启动（需 Python 3.10+，可选 ffmpeg）
setlocal
cd /d "%~dp0.."

where python >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 python，请先安装 Python 3.10+ 并加入 PATH
  exit /b 1
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo [警告] 未找到 ffmpeg：超过 10MB 或非 mp3/wav 的音频将无法转码分段
  echo        可通过 https://ffmpeg.org/download.html 下载并加入 PATH
)

if not exist .venv (
  echo [1/2] 创建虚拟环境 ...
  python -m venv .venv
)
.venv\Scripts\python -c "import fastapi" >nul 2>nul
if errorlevel 1 (
  echo [2/2] 安装依赖 ...
  .venv\Scripts\pip install -q -r requirements.txt
)

echo 启动 MiMo ASR -^> http://127.0.0.1:8000
.venv\Scripts\python main.py
endlocal
