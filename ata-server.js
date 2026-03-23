#!/usr/bin/env node
/**
 * ATA Protocol Server
 *
 * Endpoints:
 *   GET  /ata/v1/agent-card          — Publish this agent's capabilities
 *   POST /ata/v1/task                 — Receive task from remote agent
 *   POST /ata/v1/callback/:taskId     — Receive result callback
 *   GET  /ata/v1/task/:taskId/status  — Poll task status
 *   GET  /health                      — Health check
 *
 * Usage:
 *   cp .env.example .env && vi .env
 *   node ata-server.js
 */

'use strict';

require('./lib/env');

const http = require('http');
const crypto = require('crypto');
const { loadConfig } = require('./lib/config');
const { verify } = require('./lib/crypto');
const { TaskStorage } = require('./lib/storage');
const { executeTask } = require('./lib/executor');

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
  try { return { ok: true, value: JSON.parse(buf.toString('utf8')) }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateTaskSchema(task) {
  const required = ['from', 'to', 'taskId', 'type', 'payload', 'callbackUrl'];
  const missing = required.filter((f) => !task[f]);
  if (missing.length) return { ok: false, error: 'Missing required fields', fields: missing };
  if (task.type !== 'task_request') return { ok: false, error: `Unexpected type: ${task.type}` };
  return { ok: true };
}

function verifyTaskSignature(task, rawBody) {
  const bodyForVerify = Buffer.from(JSON.stringify({ ...task, signature: '' }, null, 2));
  return verify(config.sharedSecret, task.taskId, task.timestamp || 0, bodyForVerify, task.signature);
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleAgentCard(_req, res) {
  sendJson(res, 200, buildAgentCard());
}

async function handleIncomingTask(req, res, rawBody) {
  const parsed = parseJson(rawBody);
  if (!parsed.ok) return sendJson(res, 400, { error: 'Invalid JSON', detail: parsed.error });

  const task = parsed.value;

  const schemaCheck = validateTaskSchema(task);
  if (!schemaCheck.ok) return sendJson(res, 400, schemaCheck);

  const sigResult = verifyTaskSignature(task, rawBody);
  if (!sigResult.ok) {
    console.warn(`[ATA] Signature rejected for task ${task.taskId}: ${sigResult.reason}`);
    return sendJson(res, 401, { error: 'Signature verification failed', reason: sigResult.reason });
  }

  if (storage.get(task.taskId)) {
    return sendJson(res, 409, { error: 'Task already exists', taskId: task.taskId });
  }

  const record = storage.save({
    ...task,
    status: 'received',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  console.log(`[ATA] ← task ${task.taskId} from ${task.from} (action: ${task.payload?.action})`);
  sendJson(res, 202, { accepted: true, taskId: task.taskId, message: 'Task received and queued' });

  // Fire-and-forget: execute task in-process and POST result to callbackUrl
  executeTask({ task: record, callbackUrl: record.callbackUrl })
    .then(({ accepted, message }) => {
      storage.update(task.taskId, { status: accepted ? 'executing' : 'failed', executorMessage: message });
      console.log(`[ATA] Executor: ${message}`);
    })
    .catch((err) => {
      storage.update(task.taskId, { status: 'failed', executorError: err.message });
      console.error(`[ATA] Executor error: ${err.message}`);
    });
}

async function handleCallback(req, res, taskId, rawBody) {
  const parsed = parseJson(rawBody);
  if (!parsed.ok) return sendJson(res, 400, { error: 'Invalid JSON', detail: parsed.error });

  const result = parsed.value;
  const existing = storage.get(taskId);

  if (!existing) {
    storage.save({ taskId, status: result.status || 'completed', result: result.result,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), _orphanCallback: true });
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
  if (!task) return sendJson(res, 404, { error: 'Task not found', taskId });
  sendJson(res, 200, { taskId: task.taskId, status: task.status, result: task.result || null,
    createdAt: task.createdAt, updatedAt: task.updatedAt });
}

// ── Router ────────────────────────────────────────────────────────────────────

const ROUTES = [
  { method: 'GET',  pattern: /^\/ata\/v1\/agent-card$/, handler: (req, res) => handleAgentCard(req, res) },
  { method: 'GET',  pattern: /^\/health$/,              handler: (req, res) => sendJson(res, 200, { ok: true, agent: config.agentId }) },
  { method: 'POST', pattern: /^\/ata\/v1\/task$/,       handler: (req, res, body) => handleIncomingTask(req, res, body) },
  { method: 'POST', pattern: /^\/ata\/v1\/callback\/([^/?]+)$/, handler: (req, res, body, m) => handleCallback(req, res, m[1], body) },
  { method: 'GET',  pattern: /^\/ata\/v1\/task\/([^/?]+)\/status$/, handler: (req, res, _b, m) => handleStatusCheck(req, res, m[1]) },
];

async function router(req, res) {
  const url = req.url.split('?')[0];
  const method = req.method.toUpperCase();

  try {
    for (const route of ROUTES) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(url);
      if (!match) continue;
      const body = (method === 'POST') ? await readBody(req) : null;
      return await route.handler(req, res, body, match);
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
  console.log(`  GET  ${config.publicUrl}/ata/v1/agent-card`);
  console.log(`  POST ${config.publicUrl}/ata/v1/task`);
  console.log(`  POST ${config.publicUrl}/ata/v1/callback/:taskId`);
  console.log('');
});

setInterval(() => {
  const n = storage.purgeExpired(config.taskTtlMs);
  if (n > 0) console.log(`[ATA] Purged ${n} expired task(s)`);
}, 60 * 60 * 1000);

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
