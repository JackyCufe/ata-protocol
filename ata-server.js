#!/usr/bin/env node
/**
 * ATA Protocol Server
 *
 * Exposes three endpoints:
 *   GET  /ata/v1/agent-card          — Publish this agent's card
 *   POST /ata/v1/task                 — Receive task from remote agent
 *   POST /ata/v1/callback/:taskId     — Receive result callback
 *
 * Usage:
 *   cp .env.example .env && vi .env
 *   node ata-server.js
 */

'use strict';

require('./lib/env');          // load .env if present

const http = require('http');
const crypto = require('crypto');
const { loadConfig } = require('./lib/config');
const { verify } = require('./lib/crypto');
const { TaskStorage } = require('./lib/storage');
const { forwardToGateway } = require('./lib/gateway');

const config = loadConfig();
const storage = new TaskStorage(config.dataDir);

// ── Agent Card ────────────────────────────────────────────────────────────────

function buildAgentCard() {
  return {
    id: config.agentId,
    name: config.agentName,
    owner: config.agentOwner,
    capabilities: config.capabilities,
    endpoint: `${config.publicUrl}/ata/v1`,
    // In production replace with real RSA/Ed25519 public key.
    // For MVP we advertise a fingerprint of the shared secret so peers can
    // verify they're talking to the right instance without exposing the secret.
    publicKey: derivePublicFingerprint(config.sharedSecret),
    version: config.agentVersion,
    protocol: 'ata/0.1',
  };
}

function derivePublicFingerprint(secret) {
  if (!secret) return 'no-secret-configured';
  return 'sha256:' + crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

// ── Request helpers ───────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function parseJson(buf) {
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleAgentCard(req, res) {
  sendJson(res, 200, buildAgentCard());
}

async function handleIncomingTask(req, res, rawBody) {
  const parsed = parseJson(rawBody);
  if (!parsed.ok) {
    return sendJson(res, 400, { error: 'Invalid JSON', detail: parsed.error });
  }

  const task = parsed.value;

  // Basic schema validation
  const missing = ['from', 'to', 'taskId', 'type', 'payload', 'callbackUrl'].filter(
    (f) => !task[f],
  );
  if (missing.length) {
    return sendJson(res, 400, { error: 'Missing required fields', fields: missing });
  }

  if (task.type !== 'task_request') {
    return sendJson(res, 400, { error: `Unexpected type: ${task.type}` });
  }

  // Signature verification
  const timestamp = task.timestamp || 0;
  const sigResult = verify(config.sharedSecret, task.taskId, timestamp, rawBody, task.signature);
  if (!sigResult.ok) {
    console.warn(`[ATA] Signature rejected for task ${task.taskId}: ${sigResult.reason}`);
    return sendJson(res, 401, { error: 'Signature verification failed', reason: sigResult.reason });
  }

  // Idempotency: reject duplicate task IDs
  const existing = storage.get(task.taskId);
  if (existing) {
    return sendJson(res, 409, { error: 'Task already exists', taskId: task.taskId });
  }

  // Persist task
  const record = storage.save({
    ...task,
    status: 'received',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  console.log(`[ATA] ← Received task ${task.taskId} from ${task.from} (action: ${task.payload?.action})`);

  // Forward to local OpenClaw gateway (fire-and-forget)
  forwardToGateway({
    gatewayUrl: config.gatewayUrl,
    gatewayToken: config.gatewayToken,
    task: record,
    localAgentId: config.localAgentId,
  }).then(({ accepted, message }) => {
    const status = accepted ? 'forwarded' : 'gateway_error';
    storage.update(task.taskId, { status, gatewayMessage: message });
    console.log(`[ATA] Gateway forward: ${status} — ${message}`);
  }).catch((err) => {
    storage.update(task.taskId, { status: 'gateway_error', gatewayError: err.message });
    console.error(`[ATA] Gateway forward error: ${err.message}`);
  });

  sendJson(res, 202, {
    accepted: true,
    taskId: task.taskId,
    message: 'Task received and queued for processing',
  });
}

async function handleCallback(req, res, taskId, rawBody) {
  const parsed = parseJson(rawBody);
  if (!parsed.ok) {
    return sendJson(res, 400, { error: 'Invalid JSON', detail: parsed.error });
  }

  const result = parsed.value;

  const existing = storage.get(taskId);
  if (!existing) {
    // Accept the callback anyway — the client may poll this endpoint
    storage.save({
      taskId,
      status: result.status || 'completed',
      result: result.result,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      _orphanCallback: true,
    });
    console.log(`[ATA] ← Callback for unknown task ${taskId} — stored as orphan`);
    return sendJson(res, 200, { stored: true });
  }

  const updated = storage.update(taskId, {
    status: result.status || 'completed',
    result: result.result,
    completedAt: new Date().toISOString(),
  });

  console.log(`[ATA] ← Callback for task ${taskId}: status=${updated.status}`);
  sendJson(res, 200, { received: true, taskId });
}

async function handleStatusCheck(req, res, taskId) {
  const task = storage.get(taskId);
  if (!task) {
    return sendJson(res, 404, { error: 'Task not found', taskId });
  }
  sendJson(res, 200, {
    taskId: task.taskId,
    status: task.status,
    result: task.result || null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  });
}

// ── Router ────────────────────────────────────────────────────────────────────

const TASK_CALLBACK_RE = /^\/ata\/v1\/callback\/([^/?]+)$/;
const TASK_STATUS_RE   = /^\/ata\/v1\/task\/([^/?]+)\/status$/;

async function router(req, res) {
  const url = req.url.split('?')[0];
  const method = req.method.toUpperCase();

  try {
    // GET /ata/v1/agent-card
    if (method === 'GET' && url === '/ata/v1/agent-card') {
      return await handleAgentCard(req, res);
    }

    // POST /ata/v1/task
    if (method === 'POST' && url === '/ata/v1/task') {
      const body = await readBody(req);
      return await handleIncomingTask(req, res, body);
    }

    // POST /ata/v1/callback/:taskId
    const callbackMatch = TASK_CALLBACK_RE.exec(url);
    if (method === 'POST' && callbackMatch) {
      const body = await readBody(req);
      return await handleCallback(req, res, callbackMatch[1], body);
    }

    // GET /ata/v1/task/:taskId/status  (polling endpoint)
    const statusMatch = TASK_STATUS_RE.exec(url);
    if (method === 'GET' && statusMatch) {
      return await handleStatusCheck(req, res, statusMatch[1]);
    }

    // Health check
    if (method === 'GET' && url === '/health') {
      return sendJson(res, 200, { ok: true, agent: config.agentId });
    }

    sendJson(res, 404, { error: 'Not found', path: url });
  } catch (err) {
    console.error('[ATA] Unhandled error:', err);
    sendJson(res, 500, { error: 'Internal server error', message: err.message });
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

const server = http.createServer(router);

server.listen(config.port, config.host, () => {
  const card = buildAgentCard();
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║           ATA Protocol Server  v0.1             ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Agent  : ${card.id}`);
  console.log(`  Listen : http://${config.host}:${config.port}`);
  console.log(`  Public : ${config.publicUrl}`);
  console.log(`  Key    : ${card.publicKey}`);
  console.log('');
  console.log('  Endpoints:');
  console.log(`    GET  ${config.publicUrl}/ata/v1/agent-card`);
  console.log(`    POST ${config.publicUrl}/ata/v1/task`);
  console.log(`    POST ${config.publicUrl}/ata/v1/callback/:taskId`);
  console.log(`    GET  ${config.publicUrl}/ata/v1/task/:taskId/status`);
  console.log('');
});

// Periodic cleanup of expired tasks
setInterval(() => {
  const deleted = storage.purgeExpired(config.taskTtlMs);
  if (deleted > 0) console.log(`[ATA] Purged ${deleted} expired task(s)`);
}, 60 * 60 * 1000); // every hour

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });
