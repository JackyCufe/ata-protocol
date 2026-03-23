#!/usr/bin/env node
/**
 * ATA Protocol Client
 *
 * Sends a task request to a remote ATA server and optionally polls for the result.
 *
 * Usage:
 *   node ata-client.js --to <endpoint> --task '{"action":"ping"}'
 *   node ata-client.js --to https://peer.example.com/ata/v1 \
 *                      --task '{"action":"review_tweet","content":"Hello world"}'
 *
 * Options:
 *   --to         Remote ATA endpoint (required)
 *   --task       JSON payload (required)
 *   --from       Sender agent ID (default: ATA_AGENT_ID)
 *   --secret     HMAC secret (default: ATA_SHARED_SECRET)
 *   --callback   Your callback URL (default: derived from ATA_PUBLIC_URL)
 *   --wait       Wait for result via polling (default: true)
 *   --timeout    Poll timeout in ms (default: 30000)
 */

'use strict';

require('./lib/env');

const crypto = require('crypto');
const { loadConfig } = require('./lib/config');
const { sign } = require('./lib/crypto');
const { getJson, postJson } = require('./lib/http');

// ── CLI arg parsing ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    args[key] = (next && !next.startsWith('--')) ? (i++, next) : true;
  }
  return args;
}

// ── Task building & signing ───────────────────────────────────────────────────

function buildTaskRequest({ taskId, from, to, payload, callbackUrl, secret }) {
  const timestamp = Date.now();
  const task = { from, to, taskId, type: 'task_request', payload, callbackUrl, timestamp, signature: '' };
  const bodyForSigning = JSON.stringify({ ...task, signature: '' }, null, 2);
  task.signature = secret ? sign(secret, taskId, timestamp, Buffer.from(bodyForSigning)) : 'unsigned';
  return task;
}

// ── Result polling ────────────────────────────────────────────────────────────

async function pollForResult(statusUrl, { timeoutMs, intervalMs }) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    try {
      const res = await getJson(statusUrl);
      if (['completed', 'failed', 'rejected'].includes(res.status)) return res;
      process.stdout.write(`\r[ATA] Waiting... (${res.status}, attempt ${attempt})`);
    } catch (err) {
      process.stdout.write(`\r[ATA] Poll error: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for task result`);
}

// ── Peer discovery ────────────────────────────────────────────────────────────

async function fetchAgentCard(endpoint) {
  const url = endpoint.replace(/\/$/, '') + '/agent-card';
  console.log(`[ATA] Fetching agent card from ${url}`);
  return getJson(url);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  if (!args.to) {
    console.error('Error: --to <endpoint> is required');
    process.exit(1);
  }
  if (!args.task) {
    console.error('Error: --task <json> is required');
    process.exit(1);
  }

  let payload;
  try { payload = JSON.parse(args.task); }
  catch (e) { console.error(`Error: --task must be valid JSON: ${e.message}`); process.exit(1); }

  const endpoint = args.to.replace(/\/$/, '');
  const secret = args.secret || config.sharedSecret;
  const fromId = args.from || config.agentId;
  const shouldWait = args.wait !== 'false';
  const timeoutMs = parseInt(args.timeout || config.pollTimeoutMs, 10);

  // Discover peer
  let peerCard = null;
  try {
    peerCard = await fetchAgentCard(endpoint);
    console.log(`[ATA] Connected to: ${peerCard.id} (${peerCard.name})`);
    console.log(`[ATA] Capabilities: ${peerCard.capabilities.join(', ')}`);
  } catch (err) {
    console.warn(`[ATA] Could not fetch agent card: ${err.message}`);
    console.warn('[ATA] Proceeding without card verification...');
  }

  // Build task with stable taskId
  const taskId = crypto.randomUUID();
  const callbackUrl = args.callback || `${config.publicUrl}/ata/v1/callback/${taskId}`;
  const task = buildTaskRequest({ taskId, from: fromId, to: peerCard?.id || endpoint, payload, callbackUrl, secret });

  console.log(`[ATA] Sending task ${task.taskId}`);
  console.log(`[ATA] Action: ${payload.action}`);
  console.log(`[ATA] Callback: ${callbackUrl}`);

  // Send task
  const { status, data } = await postJson(endpoint + '/task', task);

  if (status !== 202 && status !== 200) {
    console.error(`\n[ATA] Task rejected: HTTP ${status}`);
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log(`[ATA] ✓ Task accepted (HTTP ${status})`);
  console.log(`[ATA] Task ID: ${task.taskId}`);

  if (!shouldWait) {
    console.log('[ATA] Not waiting for result (--wait=false)');
    console.log(`[ATA] Poll: GET ${endpoint}/task/${task.taskId}/status`);
    return;
  }

  // Poll for result
  const statusUrl = `${endpoint}/task/${task.taskId}/status`;
  console.log(`[ATA] Polling ${statusUrl} (timeout: ${timeoutMs}ms)...`);

  try {
    const result = await pollForResult(statusUrl, { timeoutMs, intervalMs: config.pollIntervalMs });
    console.log('\n');
    console.log('╔══════════════════════════════════════╗');
    console.log('║           Task Result                ║');
    console.log('╚══════════════════════════════════════╝');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`\n[ATA] ${err.message}`);
    console.error(`[ATA] Check result later: curl ${statusUrl}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[ATA] Fatal:', err.message);
  process.exit(1);
});
