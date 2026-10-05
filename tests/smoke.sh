#!/usr/bin/env bash
# 后端冒烟测试：依赖本地服务 (8000) + mock 上游 (9000)
#   用法: bash tests/smoke.sh
#   可选: LIVE_TEST=1 同时验证真实 MiMo 主机的 URL 兼容(需外网, 无效 key 预期 401)
set -u
BASE="${BASE:-http://127.0.0.1:8000}"
# MOCK: 被测服务访问 mock 的地址（容器内可用 http://host.docker.internal:9000）
# MOCK_LOCAL: 本机 curl 访问 mock 的地址（/reset）
MOCK="${MOCK:-http://127.0.0.1:9000}"
MOCK_LOCAL="${MOCK_LOCAL:-$MOCK}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then echo "PASS  $1"; PASS=$((PASS+1));
  else echo "FAIL  $1 (got: $2, want: $3)"; FAIL=$((FAIL+1)); fi
}

command -v ffmpeg >/dev/null || { echo "ffmpeg required"; exit 1; }
ffmpeg -y -v error -f lavfi -i "sine=frequency=440:duration=1" -ar 16000 -ac 1 "$WORK/small.wav"
ffmpeg -y -v error -f lavfi -i "sine=frequency=440:duration=750" -ar 16000 -ac 1 "$WORK/long.wav"
curl -sf "$MOCK_LOCAL/reset" >/dev/null

# 1. health
curl -sf "$BASE/api/health" | grep -q '"status"' && check "health ok" ok ok || check "health ok" "bad" ok

# 2. 小文件 非流式
out=$(curl -s --max-time 60 -X POST "$BASE/api/transcribe" \
  -F base_url="$MOCK" -F api_key=test-key -F model=mimo-v2.5-asr \
  -F language=zh -F stream=false -F "file=@$WORK/small.wav")
echo "$out" | grep -q '"b64=' && check "small non-stream" ok ok || check "small non-stream" "$out" ok

# 3. 长文件 流式: 3 段 + 聚合 usage
out=$(curl -sN --max-time 120 -X POST "$BASE/api/transcribe" \
  -F base_url="$MOCK" -F api_key=test-key -F model=mimo-v2.5-asr \
  -F language=auto -F stream=true -F "file=@$WORK/long.wav")
segs=$(echo "$out" | grep -o '"segment_index": [0-9]*' | wc -l | tr -d ' ')
check "long stream 3 segments" "$segs" "3"
echo "$out" | grep -q '"seconds": 12' && check "usage aggregated" ok ok || check "usage aggregated" "$out" "seconds:12"
echo "$out" | grep -q '"segment_total": 3' || true
b64max=$(echo "$out" | grep -o '"delta": {"content": "[^"]*' | grep -o '[0-9]\{7,\}' | sort -rn | head -1)
[ -z "$b64max" ] || [ "$b64max" -le 10000000 ] && check "segment b64 <= 10MB" ok ok || check "segment b64 <= 10MB" "$b64max" ok

# 4. 重试: 500x2 后成功
out=$(curl -sN --max-time 60 -X POST "$BASE/api/transcribe" \
  -F base_url="$MOCK/fail" -F api_key=test-key -F model=mimo-v2.5-asr \
  -F language=auto -F stream=true -F "file=@$WORK/small.wav")
echo "$out" | grep -q '"b64=' && check "retry after 500x2" ok ok || check "retry after 500x2" "$out" ok

# 5. 413 自动拆分
out=$(curl -sN --max-time 300 -X POST "$BASE/api/transcribe" \
  -F base_url="$MOCK/toobig" -F api_key=test-key -F model=mimo-v2.5-asr \
  -F language=auto -F stream=true -F "file=@$WORK/long.wav")
splits=$(echo "$out" | grep -c '"split"')
[ "$splits" -ge 1 ] && check "auto-split on 413" ok ok || check "auto-split on 413" "splits=$splits" ">=1"
echo "$out" | grep -q '"error"' && check "no error after split" "$out" ok || check "no error after split" ok ok

# 6. 持续失败: 错误带状态码
out=$(curl -sN --max-time 60 -X POST "$BASE/api/transcribe" \
  -F base_url="$MOCK/alwaysfail" -F api_key=test-key -F model=mimo-v2.5-asr \
  -F language=auto -F stream=true -F "file=@$WORK/small.wav")
echo "$out" | grep -q 'HTTP 502' && check "error carries status" ok ok || check "error carries status" "$out" "HTTP 502"

# 7. JSON 兼容接口
b64=$(base64 -i "$WORK/small.wav" | tr -d '\n')
out=$(curl -s --max-time 60 -X POST "$BASE/api/transcribe" -H 'Content-Type: application/json' \
  -d "{\"base_url\":\"$MOCK\",\"api_key\":\"test-key\",\"model\":\"mimo-v2.5-asr\",\"language\":\"en\",\"stream\":false,\"audio\":{\"data_url\":\"data:audio/wav;base64,$b64\"}}")
echo "$out" | grep -q '"b64=' && check "json compat api" ok ok || check "json compat api" "$out" ok

# 8. 可选: 真实主机 URL 兼容（base 带 /v1）
if [ "${LIVE_TEST:-0}" = "1" ]; then
  out=$(curl -s --max-time 60 -o /dev/null -w "%{http_code}" -X POST "$BASE/api/transcribe" \
    -F "base_url=https://token-plan-cn.xiaomimimo.com/v1" -F api_key=sk-invalid \
    -F model=mimo-v2.5-asr -F language=auto -F stream=false -F "file=@$WORK/small.wav")
  check "live host base_url with /v1 -> 401" "$out" "401"
fi

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
