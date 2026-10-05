# MiMo ASR 语音识别

基于小米 **MiMo-V2.5-ASR**（OpenAI 兼容接口）的语音识别 Web 服务：拖拽/选择音频上传，流式输出识别结果，
长录音自动分段、失败自动重试与拆分，支持导出与历史记录。

- 版本：`1.4.0`（见 `/api/health`）
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

## 静态网页版（GitHub Pages / Cloudflare Pages）

`web/` 目录是**纯静态**版本：无 Python、无 ffmpeg、无常驻服务，可托管在任意静态平台。

- **浏览器端分段**：WAV 按 PCM 块切片（`file.slice` 流式读取，800MB 也不会整块进内存）、
  MP3 按帧边界切分，满足官方 base64 ≤10MB 限制；失败同样自动对半拆分重试
- **直连模式（默认）**：MiMo 官方主机已开放 CORS（`access-control-allow-origin: *`），浏览器直接调用
- **同源代理模式（可选）**：Cloudflare Pages Function `/api/proxy` 转发（主机白名单 `ALLOWED_HOSTS`，
  默认仅 `xiaomimimo.com`），适用于不支持 CORS 的自定义网关
- 限制：仅支持 **mp3 / wav**（其他格式请用本地版）；历史/导出/取消/流式与本地版一致

```bash
# GitHub Pages：push 后由 .github/workflows/pages.yml 自动发布
# Cloudflare Pages：
npx wrangler pages deploy web --project-name mimo-asr

# 本地开发与测试
cd web && npm test          # 16 项单测（分段器 + 代理函数）
python3 -m http.server 8080 --directory web   # 静态预览
```


---

## 使用

1. 打开页面，点右上角「API 设置」填写：

   | 字段 | 默认值 | 说明 |
   | --- | --- | --- |
   | API 接口地址 | `https://api.xiaomimimo.com` | 可填任意兼容网关，**带不带 `/v1` 均可** |
   | API Key | （必填） | 存浏览器 localStorage，不落服务端 |
   | 模型 ID | `mimo-v2.5-asr` | |
   | 识别语言 | 自动 / 中文 / English | `asr_options.language` |
   | 流式输出 | 开 | SSE 边识别边显示 |

2. 拖拽或点击上传音频（mp3/wav 直传；m4a/ogg/flac 等自动转码）
3. 点「开始识别」；长录音会显示分段进度、可随时「取消」

## 核心行为

- **10MB 限制**：官方要求 base64 ≤ 10MB，超过时服务端按 **300 秒/段**（64kbps 单声道 16kHz MP3，
  每段 ≈3.2MB base64）自动分段，逐段调用后拼接文本、聚合 usage
- **自适应拆分**：某段遇到连接失败 / 413 / 5xx 时自动把该段**对半拆分重试**（适配慢速上行网络）
- **重试**：每段最多 4 次（429/5xx/超时/断连，指数退避 + 抖动；大段连接失败 2 次即转入拆分）
- **超时**：connect 15s / read 120s / write 180s
- **可观测**：服务端日志带时间戳，逐段记录分段耗时、上游响应头耗时、首字节耗时、重试状态码与 DNS 候选

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ASR_HOST` | `127.0.0.1`（镜像内 `0.0.0.0`） | 监听地址 |
| `ASR_PORT` | `8000` | 监听端口 |

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
├── web/                  # 静态网页版（GitHub/Cloudflare Pages）
│   ├── app.js / segmenter.js      # 浏览器端分段 + 双模式请求
│   └── functions/api/proxy.js     # Cloudflare Pages Function 代理
├── tests/                # mock 上游 + 冒烟 + 浏览器 e2e（本地版/Web 版）
├── scripts/run.sh|run.bat# 原生一键启动
├── Dockerfile            # 多平台镜像（含 ffmpeg，非 root）
├── docker-compose.yml
├── Makefile
├── .github/workflows/    # 镜像发布(GHCR) / GH Pages / Cloudflare Pages
└── dist/                 # 离线镜像包（构建产物，不入库）
```
