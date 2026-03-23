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

## Framework Compatibility

### The protocol is universal. The execution adapter is not.

ATA has two distinct layers:

```
┌─────────────────────────────────────────────────────┐
│  Protocol layer (framework-agnostic)                │
│  Agent Card · Task signing · Callback · Status poll │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Execution adapter (framework-specific)             │
│  How does the receiving agent actually run the task?│
└─────────────────────────────────────────────────────┘
```

**The protocol layer works with any agent, any framework.**
Anyone who can run an HTTP server and verify HMAC can participate — Python agents, Go agents, another person's OpenClaw, a fully custom agent runtime.

**The execution adapter (`lib/gateway.js`) is currently OpenClaw-specific.**
When a task arrives, the server forwards it to a local OpenClaw gateway via `POST /tools/invoke`. This is an OpenClaw API.

### Can I use ATA without OpenClaw?

Yes — with one change. Replace `lib/gateway.js` with your own adapter:

```js
// lib/gateway.js — replace this function body
async function forwardToGateway({ task }) {
  // Option A: HTTP call to your agent's own API
  await fetch('http://localhost:8080/run', {
    method: 'POST',
    body: JSON.stringify({ taskId: task.taskId, action: task.payload.action }),
  });

  // Option B: Write to a queue (Redis, SQS, etc.)
  await queue.push(task);

  // Option C: Spawn a subprocess
  spawn('python', ['agent.py', '--task', JSON.stringify(task)]);

  return { accepted: true, message: 'forwarded' };
}
```

The rest of the server (`ata-server.js`, `lib/crypto.js`, `lib/storage.js`) is pure Node.js with no framework dependency.

### Summary

| Component | OpenClaw required? |
|-----------|-------------------|
| Protocol (signing, cards, callbacks) | ❌ No |
| Sending tasks (`ata-client.js`) | ❌ No |
| Receiving tasks (`ata-server.js`) | ❌ No |
| Executing tasks (`lib/gateway.js`) | ⚠️ Default yes, swap to remove |

---

## Built with OpenClaw in mind

This project was designed alongside [OpenClaw](https://github.com/openclaw/openclaw)'s multi-agent architecture. The default execution adapter targets OpenClaw's gateway, but the protocol itself is an open spec — any agent runtime can implement it.

*Made by [@Jacky_cufe](https://x.com/Jacky_cufe) — building in public.*
