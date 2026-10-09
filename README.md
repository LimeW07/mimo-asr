# MiMo ASR 语音识别

基于小米 **MiMo-V2.5-ASR**（OpenAI 兼容接口）的语音识别 Web 服务：拖拽/选择音频上传，流式输出识别结果，
长录音自动分段、失败自动重试与拆分，支持导出与历史记录。

- 版本：`1.4.0`（见 `/api/health`）
- 纯静态网页版（GitHub Pages / Cloudflare Pages）已独立为 **[mimo-asr-web](https://github.com/LimeW07/mimo-asr-web)**
- 运行要求：Python 3.10+（原生部署）或 Docker；处理 >10MB / 非 mp3/wav 音频需要 **ffmpeg**

---

## 一键部署

### 方式一：Docker（推荐，任意 Linux / macOS / Windows）

```bash
docker build -t mimo-asr:1.4.0 .
docker run -d --name mimo-asr -p 8000:8000 --restart unless-stopped mimo-asr:1.4.0
```

打开 http://127.0.0.1:8000

### 方式二：docker compose

```bash
docker compose up -d          # 构建并启动
docker compose down           # 停止
ASR_PUBLISHED_PORT=9000 docker compose up -d   # 换端口
```

### 方式三：离线包（无网络构建环境）

`dist/` 内提供分架构镜像包，目标机器只需安装 Docker：

```bash
docker load -i dist/mimo-asr-1.4.0-amd64.tar   # x86_64 服务器
docker load -i dist/mimo-asr-1.4.0-arm64.tar   # ARM 服务器 / Apple Silicon
docker run -d -p 8000:8000 mimo-asr:1.4.0
```

另有 `dist/images-1.4.0.tar`（OCI 布局，含双平台，可用于 podman/skopeo 等）。

### 方式四：GitHub Actions 自动发布多架构镜像

`.github/workflows/docker-publish.yml` 会在 push / 打 `v*` 标签时构建
`linux/amd64` + `linux/arm64` 并推送到 GHCR：

```bash
docker pull ghcr.io/<owner>/<repo>:latest
docker run -d -p 8000:8000 ghcr.io/<owner>/<repo>:latest
```

### 方式五：原生一键脚本

```bash
./scripts/run.sh        # macOS / Linux（自动创建 venv、装依赖、启动）
scripts\run.bat         # Windows（需 Python 3.10+）
```

或手动：

```bash
make install   # 创建 venv 并安装依赖
make run       # 启动
```

---

## 对外接口（预留）

```
POST /api/transcribe
```

- **multipart（推荐，任意大文件）**：`file` + 表单字段 `base_url` / `api_key` / `model` / `language` / `stream`
- **JSON（兼容）**：`{"base_url","api_key","model","language","stream","audio":{"data_url":"data:...;base64,..."}}`
- `stream=false` → OpenAI 风格 `chat.completion`（多段 `\n` 拼接，usage 聚合，含 `segment_count`）
- `stream=true` → `text/event-stream`：`prepare/prepared` 转码进度、`segment_index/total` 分段进度、
  `split` 自动拆分通知、delta 文本、聚合 `usage`、错误 `data: {"error": {...}}`、`[DONE]`
- `GET /api/health` → `{"status":"ok","version":"1.4.0","ffmpeg":true}`

## 测试

```bash
# 后端冒烟（11 项：分段/重试/拆分/URL 兼容/JSON 接口…）
# 需先启动服务与 mock：  .venv/bin/python main.py  和  .venv/bin/python -m uvicorn tests.mock_asr:app --port 9000
LIVE_TEST=1 bash tests/smoke.sh        # LIVE_TEST=1 附带真实主机 URL 兼容校验

# 浏览器端到端（需本机 Chrome 开启 CDP: --remote-debugging-port=9222）
node tests/cdp_test.mjs
```

## 日志

```bash
tail -f /tmp/mimo-asr.log     # 原生启动
docker logs -f mimo-asr       # Docker
```

## 说明与限制

- 官方接口仅接受单段音频、base64 ≤ 10MB、不返回时间戳，SRT 时间轴为按字符估算值
- 分段转码为有损重编码（64kbps 单声道 16kHz），对语音识别精度无影响
- API Key 仅随请求转发给本机后端，服务端不保存；容器以非 root 用户运行

## 目录结构

```
├── main.py               # FastAPI 服务（代理 / 分段 / 重试 / 拆分）
├── static/               # 本地版前端（Python 服务托管）
├── tests/                # mock 上游 + 冒烟 + 浏览器 e2e
├── scripts/run.sh|run.bat# 原生一键启动
├── Dockerfile            # 多平台镜像（含 ffmpeg，非 root）
├── docker-compose.yml
├── Makefile
├── .github/workflows/    # 多架构镜像发布（GHCR）
└── dist/                 # 离线镜像包（构建产物，不入库）
```
