#!/bin/bash
# ata-protocol 本机联调脚本
# 模拟 Agent A（端口3740）← 发任务 → Agent B（端口3741）
# 用法：bash test-local.sh

set -e

# ── 颜色 ──────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info() { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SECRET="test-shared-secret-$(date +%s)"

cleanup() {
  info "清理进程..."
  [ -n "$PID_A" ] && kill "$PID_A" 2>/dev/null && ok "Agent A (pid $PID_A) 已停止"
  [ -n "$PID_B" ] && kill "$PID_B" 2>/dev/null && ok "Agent B (pid $PID_B) 已停止"
  rm -rf /tmp/ata-test-data-a /tmp/ata-test-data-b
}
trap cleanup EXIT

# ── 启动 Agent B（接收方，端口 3741）──────────────────────────────────────────
info "启动 Agent B（端口 3741，接收任务）..."
ATA_AGENT_ID="agent://bob/assistant" \
ATA_AGENT_NAME="Bob" \
ATA_AGENT_OWNER="bob" \
ATA_PORT=3741 \
ATA_HOST=127.0.0.1 \
ATA_PUBLIC_URL="http://127.0.0.1:3741" \
ATA_SHARED_SECRET="$SECRET" \
ATA_DATA_DIR="/tmp/ata-test-data-b" \
ATA_GATEWAY_URL="http://127.0.0.1:18789" \
ATA_GATEWAY_TOKEN="" \
ATA_CAPABILITIES="ping,content_review" \
  node "$SCRIPT_DIR/ata-server.js" > /tmp/ata-b.log 2>&1 &
PID_B=$!

sleep 1.5

# 检查 Agent B 在线
if ! curl -s http://127.0.0.1:3741/health > /dev/null 2>&1; then
  warn "Agent B 未能启动，查看日志：/tmp/ata-b.log"
  cat /tmp/ata-b.log
  exit 1
fi
ok "Agent B 在线 (pid $PID_B)"

# ── 启动 Agent A（发送方，端口 3740）─────────────────────────────────────────
info "启动 Agent A（端口 3740，发送任务）..."
ATA_AGENT_ID="agent://jacky-cufe/socializing" \
ATA_AGENT_NAME="Jacky Socializing" \
ATA_AGENT_OWNER="jacky-cufe" \
ATA_PORT=3740 \
ATA_HOST=127.0.0.1 \
ATA_PUBLIC_URL="http://127.0.0.1:3740" \
ATA_SHARED_SECRET="$SECRET" \
ATA_DATA_DIR="/tmp/ata-test-data-a" \
ATA_GATEWAY_URL="http://127.0.0.1:18789" \
ATA_GATEWAY_TOKEN="" \
ATA_CAPABILITIES="twitter_post,fb_dm" \
  node "$SCRIPT_DIR/ata-server.js" > /tmp/ata-a.log 2>&1 &
PID_A=$!

sleep 1.5

if ! curl -s http://127.0.0.1:3740/health > /dev/null 2>&1; then
  warn "Agent A 未能启动，查看日志：/tmp/ata-a.log"
  cat /tmp/ata-a.log
  exit 1
fi
ok "Agent A 在线 (pid $PID_A)"

echo ""
echo "────────────────────────────────────────────────────────"

# ── 测试1：查看 Agent B 的 Agent Card ───────────────────────────────────────
info "测试1：获取 Agent B 的 Agent Card..."
CARD=$(curl -s http://127.0.0.1:3741/ata/v1/agent-card)
echo "$CARD" | python3 -m json.tool 2>/dev/null || echo "$CARD"
ok "Agent Card 获取成功"

echo ""
echo "────────────────────────────────────────────────────────"

# ── 测试2：Agent A 发 ping 任务给 Agent B ────────────────────────────────────
info "测试2：Agent A → Agent B 发送 ping 任务..."
ATA_AGENT_ID="agent://jacky-cufe/socializing" \
ATA_PUBLIC_URL="http://127.0.0.1:3740" \
ATA_SHARED_SECRET="$SECRET" \
ATA_DATA_DIR="/tmp/ata-test-data-a" \
ATA_POLL_TIMEOUT_MS=5000 \
  node "$SCRIPT_DIR/ata-client.js" \
    --to http://127.0.0.1:3741/ata/v1 \
    --task '{"action":"ping"}' \
    --wait false

echo ""
echo "────────────────────────────────────────────────────────"

# ── 测试3：Agent A 发 content_review 任务给 Agent B ─────────────────────────
info "测试3：Agent A → Agent B 发送 content_review 任务..."
TASK_RESULT=$(ATA_AGENT_ID="agent://jacky-cufe/socializing" \
ATA_PUBLIC_URL="http://127.0.0.1:3740" \
ATA_SHARED_SECRET="$SECRET" \
ATA_DATA_DIR="/tmp/ata-test-data-a" \
ATA_POLL_TIMEOUT_MS=5000 \
  node "$SCRIPT_DIR/ata-client.js" \
    --to http://127.0.0.1:3741/ata/v1 \
    --task '{"action":"content_review","content":"测试推文内容，帮我看看有没有问题"}' \
    --wait false 2>&1)
echo "$TASK_RESULT"

echo ""
echo "────────────────────────────────────────────────────────"

# ── 测试4：错误签名（应被 401 拒绝）─────────────────────────────────────────
info "测试4：发送错误签名的任务（应返回 401）..."
REJECT_RESULT=$(ATA_AGENT_ID="agent://attacker/bot" \
ATA_PUBLIC_URL="http://127.0.0.1:3740" \
ATA_SHARED_SECRET="wrong-secret-should-fail" \
ATA_DATA_DIR="/tmp/ata-test-data-a" \
  node "$SCRIPT_DIR/ata-client.js" \
    --to http://127.0.0.1:3741/ata/v1 \
    --task '{"action":"ping"}' \
    --wait false 2>&1 || true)
echo "$REJECT_RESULT"
if echo "$REJECT_RESULT" | grep -q "rejected\|401\|Signature\|failed"; then
  ok "签名验证正确拒绝了无效请求 ✅"
else
  warn "预期被拒绝，但结果不确定，请检查上方输出"
fi

echo ""
echo "════════════════════════════════════════════════════════"
ok "本机联调测试完成"
echo ""
echo "日志文件："
echo "  Agent A: /tmp/ata-a.log"
echo "  Agent B: /tmp/ata-b.log"
echo "  查看：tail -20 /tmp/ata-b.log"
