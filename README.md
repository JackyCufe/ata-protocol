# ATA Protocol — Agent-to-Agent Cross-Instance Communication

> **ATA** is what ACP is not: cross-ownership agent collaboration.
> 
> ACP = your agents talking to your agents  
> ATA = your agent talking to *someone else's* agent

---

## Why This Exists

OpenClaw's ACP protocol lets your agents collaborate within your own instance. But what if you want your `socializing` agent to delegate a task to *another person's* agent — without either human being in the loop?

That's ATA. It's the missing layer between "AI assistant" and "AI economy."

```
Without ATA:  Human A → Agent A → ... → Human A → Human B → Agent B
With ATA:     Human A → Agent A ──────────────────────────→ Agent B
```

---

## How It Works

Each participant runs an ATA server that:
1. Publishes an **Agent Card** (`GET /ata/v1/agent-card`) — who am I, what can I do
2. Accepts **task requests** (`POST /ata/v1/task`) — signed with HMAC
3. Forwards tasks to the local **OpenClaw gateway** for execution
4. Sends results back via **callback URL**

```
[Agent A]                          [Agent B]
  │                                    │
  ├─ GET /ata/v1/agent-card ──────────>│  (discover capabilities)
  │<────────────── agent-card.json ────┤
  │                                    │
  ├─ POST /ata/v1/task ───────────────>│  (delegate task, signed)
  │                                    ├─ verify signature
  │                                    ├─ forward to OpenClaw gateway
  │                                    ├─ agent executes task
  │<── POST /callback/:taskId ─────────┤  (send result back)
```

---

## Quick Start

### 1. Setup

```bash
cd projects/ata-protocol
cp .env.example .env
# Edit .env with your details
npm install  # (uses built-in node modules, no install needed)
```

### 2. Start the server

```bash
node ata-server.js
# → ATA server running on port 3740
# → Agent card: http://localhost:3740/ata/v1/agent-card
```

### 3. Send a task to another agent

```bash
# Simple ping
node ata-client.js \
  --to https://peer.example.com/ata/v1 \
  --task '{"action":"ping"}'

# Review a tweet
node ata-client.js \
  --to https://peer.example.com/ata/v1 \
  --task '{"action":"review_tweet","content":"My tweet draft here"}'
```

### 4. Local demo (two terminals)

```bash
# Terminal 1 — simulate "Agent B"
ATA_PORT=3741 ATA_AGENT_ID=agent://bob/assistant node ata-server.js

# Terminal 2 — send from "Agent A"
node ata-client.js \
  --to http://localhost:3741/ata/v1 \
  --task '{"action":"ping"}' \
  --secret change-this-to-a-random-secret
```

---

## Agent Card Format

```json
{
  "id": "agent://jacky-cufe/socializing",
  "name": "Socializing",
  "owner": "jacky-cufe",
  "capabilities": ["twitter_post", "fb_dm", "content_review"],
  "endpoint": "https://your-domain.com/ata/v1",
  "version": "0.1.0"
}
```

---

## Security Model

- **HMAC-SHA256 signatures** on every request (timestamp + payload)
- Replay protection via 5-minute timestamp window
- No blockchain, no PKI — just a shared secret per peer pair
- Future: asymmetric keys (Ed25519) for trustless discovery

---

## vs. Existing Protocols

| Protocol | Cross-ownership? | Discovery? | Trust model |
|----------|-----------------|------------|-------------|
| OpenClaw ACP | ❌ Same instance | Internal | Internal |
| Google A2A | ⚠️ Enterprise only | Agent Cards | OAuth/OIDC |
| MCP | ❌ Tool calls only | No | No |
| **ATA (this)** | ✅ | Agent Cards | HMAC → Ed25519 |

---

## Roadmap

- [x] Agent Card format
- [x] Task request/callback protocol  
- [x] HMAC signature verification
- [x] OpenClaw gateway forwarding
- [ ] Agent Card registry (public discovery)
- [ ] Ed25519 asymmetric signing
- [ ] Capability negotiation
- [ ] Rate limiting & quota

---

## Built on OpenClaw

This project extends [OpenClaw](https://github.com/openclaw/openclaw)'s multi-agent architecture to cross-instance communication. It's designed to work alongside ACP, not replace it.

*Made by [@Jacky_cufe](https://x.com/Jacky_cufe) — building in public.*
