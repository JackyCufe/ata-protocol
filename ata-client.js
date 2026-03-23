#!/usr/bin/env node
/**
 * ATA Protocol Client
 *
 * Sends a task request to a remote ATA server and waits for the result.
 *
 * Usage:
 *   node ata-client.js --to <endpoint> --task '{"action":"ping"}'
 *   node ata-client.js --to https://peer.example.com/ata/v1 \
 *                      --task '{"action":"review_tweet","content":"Hello world"}' \
 *                      --from "agent://jacky-cufe/main"
 *
 * Options:
 *   --to         Remote ATA endpoint (required)
 *   --task       JSON payload (required)
 *   --from       Sender agent ID (default: from .env / config)
 *   --secret     HMAC secret (default: ATA_SHARED_SECRET env var)
 *   --callback   Your callback URL (default: derived from ATA_PUBLIC_URL)
 *   --wait       Wait for result via polling (default: true)
 *   --timeout    Poll timeout in ms (default: 30000)
 */

'use strict';

require('./lib/env');

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { loadConfig } = require('./lib/config');
const { sign } = require('./lib/crypto');

// ── CLI argument parsing ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function request(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const req = client.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, body: text });
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getJson(url) {
  const res = await request(url, { method: 'GET', headers: { Accept: 'application/json' } });
  if (res.status !== 200) throw new Error(`GET ${url} → ${res.status}: ${res.body}`);
  return JSON.parse(res.body);
}

async function postJson(url, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  const res = await request(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...extraHeaders,
      },
    },
    body,
  );
  return { status: res.status, data: res.body ? (() => { try { return JSON.parse(res.body); } catch { return res.body; } })() : null };
}

// ── Fetch peer agent card ─────────────────────────────────────────────────────

async function fetchAgentCard(endpoint) {
  const url = endpoint.replace(/\/$/, '') + '/agent-card';
  console.log(`[ATA Client] Fetching agent card from ${url}`);
  return getJson(url);
}

// ── Build & sign task request ─────────────────────────────────────────────────

function buildTaskRequest({ taskId, from, to, payload, callbackUrl, secret }) {
  const timestamp = Date.now();

  const task = {
    from,
    to,
    taskId,
    type: 'task_request',
    payload,
    callbackUrl,
    timestamp,
    signature: '',
  };

  // Sign after all fields are final
  const bodyForSigning = JSON.stringify({ ...task, signature: '' }, null, 2);
  task.signature = secret
    ? sign(secret, taskId, timestamp, Buffer.from(bodyForSigning))
    : 'unsigned';

  return task;
}

// ── Poll for result ───────────────────────────────────────────────────────────

async function pollForResult(statusUrl, { timeoutMs, intervalMs }) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    try {
      const res = await getJson(statusUrl);
      if (res.status === 'completed' || res.status === 'failed' || res.status === 'rejected') {
        return res;
      }
      process.stdout.write(`\r[ATA Client] Waiting for result... (${res.status}, attempt ${attempt})`);
    } catch (err) {
      process.stdout.write(`\r[ATA Client] Poll error: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for task result`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  // Validate required args
  if (!args.to) {
    console.error('Error: --to <endpoint> is required');
    console.error('Example: node ata-client.js --to https://peer.example.com/ata/v1 --task \'{"action":"ping"}\'');
    process.exit(1);
  }
  if (!args.task) {
    console.error('Error: --task <json> is required');
    process.exit(1);
  }

  // Parse task payload
  let payload;
  try {
    payload = JSON.parse(args.task);
  } catch (e) {
    console.error(`Error: --task must be valid JSON: ${e.message}`);
    process.exit(1);
  }

  const endpoint = args.to.replace(/\/$/, '');
  const secret = args.secret || config.sharedSecret;
  const fromId = args.from || config.agentId;
  const shouldWait = args.wait !== 'false';
  const timeoutMs = parseInt(args.timeout || config.pollTimeoutMs, 10);
  const intervalMs = config.pollIntervalMs;

  // Step 1: Fetch peer agent card to learn their identity
  let peerCard = null;
  try {
    peerCard = await fetchAgentCard(endpoint);
    console.log(`[ATA Client] Connected to: ${peerCard.id} (${peerCard.name})`);
    console.log(`[ATA Client] Capabilities: ${peerCard.capabilities.join(', ')}`);
  } catch (err) {
    console.warn(`[ATA Client] Could not fetch agent card: ${err.message}`);
    console.warn('[ATA Client] Proceeding without card verification...');
  }

  // Step 2: Generate taskId first, build callback URL, sign once — no double-sign
  const taskId = crypto.randomUUID();
  const callbackUrl = args.callback || `${config.publicUrl}/ata/v1/callback/${taskId}`;

  const task = buildTaskRequest({
    taskId,
    from: fromId,
    to: peerCard?.id || endpoint,
    payload,
    callbackUrl,
    secret,
  });

  console.log(`[ATA Client] Sending task ${task.taskId}`);
  console.log(`[ATA Client] Action: ${payload.action}`);
  console.log(`[ATA Client] Callback: ${callbackUrl}`);

  // Step 4: POST task to peer
  const postUrl = endpoint + '/task';
  const response = await postJson(postUrl, task);

  if (response.status !== 202 && response.status !== 200) {
    console.error(`\n[ATA Client] Task rejected: HTTP ${response.status}`);
    console.error(JSON.stringify(response.data, null, 2));
    process.exit(1);
  }

  console.log(`[ATA Client] ✓ Task accepted by peer (HTTP ${response.status})`);
  console.log(`[ATA Client] Task ID: ${task.taskId}`);

  if (!shouldWait) {
    console.log('[ATA Client] Not waiting for result (--wait=false)');
    console.log(`[ATA Client] Poll manually: GET ${endpoint}/task/${task.taskId}/status`);
    return;
  }

  // Step 5: Poll peer's status endpoint for result
  const statusUrl = `${endpoint}/task/${task.taskId}/status`;
  console.log(`[ATA Client] Polling ${statusUrl} (timeout: ${timeoutMs}ms)...`);

  try {
    const result = await pollForResult(statusUrl, { timeoutMs, intervalMs });
    console.log('\n');
    console.log('╔══════════════════════════════════════╗');
    console.log('║           Task Result                ║');
    console.log('╚══════════════════════════════════════╝');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`\n[ATA Client] ${err.message}`);
    console.error(`[ATA Client] You can still check result later:`);
    console.error(`  curl ${statusUrl}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[ATA Client] Fatal:', err.message);
  process.exit(1);
});
