/**
 * ATA Protocol — OpenClaw Gateway Forwarder
 *
 * Strategy:
 *   1. PREFERRED: sessions_spawn — spawns a dedicated isolated subagent
 *      for each ATA task. The subagent processes the task and POSTs the
 *      callback result automatically via exec curl. Fully autonomous.
 *      Requires: gateway.tools.allow = ["sessions_spawn"] in openclaw.json.
 *
 *   2. FALLBACK: sessions_send — injects the task into an existing session.
 *      The existing agent must manually handle the callback.
 *      Requires: gateway.tools.allow = ["sessions_send"] in openclaw.json.
 *
 * Config keys in .env:
 *   ATA_GATEWAY_URL       e.g. http://127.0.0.1:18789
 *   ATA_GATEWAY_TOKEN     Bearer token for gateway auth
 *   ATA_LOCAL_AGENT_ID    Fallback session key for sessions_send
 */

'use strict';

const { postJson } = require('./http');

/**
 * Forward a received ATA task to the local OpenClaw gateway.
 *
 * @param {object} opts
 * @param {string} opts.gatewayUrl
 * @param {string} opts.gatewayToken
 * @param {string} opts.localAgentId  Fallback session key for sessions_send
 * @param {object} opts.task
 * @returns {Promise<{ accepted: boolean, message: string }>}
 */
async function forwardToGateway({ gatewayUrl, gatewayToken, localAgentId, task }) {
  // Strategy 1: sessions_spawn (preferred — isolated subagent per task)
  const spawnResult = await trySessionsSpawn({ gatewayUrl, gatewayToken, task });
  if (spawnResult.accepted) return spawnResult;

  // Strategy 2: fallback to sessions_send
  console.warn('[ATA] sessions_spawn unavailable, falling back to sessions_send');
  return trySessionsSend({ gatewayUrl, gatewayToken, localAgentId, task });
}

// ── Strategy 1: sessions_spawn (isolated subagent, fully autonomous) ──────────
//
// Spawns a dedicated subagent for each incoming ATA task.
// The subagent receives a system prompt that instructs it to:
//   1. Process the task
//   2. exec curl to POST the result to callbackUrl
//   3. Exit
//
// This is the correct ATA pattern: each task gets its own AI reasoning session.

async function trySessionsSpawn({ gatewayUrl, gatewayToken, task }) {
  const url = new URL('/tools/invoke', gatewayUrl).toString();
  const headers = gatewayToken ? { Authorization: `Bearer ${gatewayToken}` } : {};

  const { status, data } = await postJson(url, {
    tool: 'sessions_spawn',
    args: {
      task: buildSpawnTask(task),
      mode: 'run',
      runtime: 'subagent',
      timeoutSeconds: 120,
    },
  }, headers);

  const accepted = status === 200 && data?.ok === true;
  const childKey = data?.result?.details?.childSessionKey || 'unknown';
  const message = accepted
    ? `spawned isolated subagent (${childKey})`
    : `sessions_spawn failed (${status}): ${JSON.stringify(data)}`;

  return { accepted, message };
}

// ── Strategy 2: sessions_send (inject into existing session) ─────────────────

async function trySessionsSend({ gatewayUrl, gatewayToken, localAgentId, task }) {
  const url = new URL('/tools/invoke', gatewayUrl).toString();
  const headers = gatewayToken ? { Authorization: `Bearer ${gatewayToken}` } : {};

  const { status, data } = await postJson(url, {
    tool: 'sessions_send',
    args: { sessionKey: localAgentId || 'main', message: buildInstructions(task) },
  }, headers);

  const accepted = status === 200 && data?.ok === true;
  const message = accepted
    ? 'delivered via sessions_send (direct injection)'
    : `sessions_send failed (${status}): ${JSON.stringify(data)}`;

  return { accepted, message };
}

// ── Task builders ─────────────────────────────────────────────────────────────

/**
 * Build the task string for sessions_spawn.
 * The subagent sees this as its sole instruction and must close the loop.
 */
function buildSpawnTask(task) {
  const { from, payload, callbackUrl, taskId } = task;
  const action = payload?.action || 'unknown';
  const content = payload?.content || '';

  return [
    `You are an ATA (Agent-to-Agent) task executor. Process the following task and POST the result to the callback URL.`,
    ``,
    `From: ${from}`,
    `Task ID: ${taskId}`,
    `Action: ${action}`,
    content ? `Content: ${content}` : '',
    ``,
    `Instructions:`,
    `1. Think about the task and produce a result.`,
    `2. Run the following exec command to deliver your result (replace YOUR_ANSWER with your actual response — plain text, no quotes inside):`,
    ``,
    `exec: curl -s -X POST '${callbackUrl}' -H 'Content-Type: application/json' -d '{"taskId":"${taskId}","status":"completed","result":{"answer":"YOUR_ANSWER"}}'`,
    ``,
    `3. After the curl succeeds (returns {"received":true}), reply with only: DONE`,
    ``,
    `Do NOT skip the curl. The task is only complete when the callback is delivered.`,
  ].filter(Boolean).join('\n');
}

/**
 * Build fallback instructions for sessions_send (existing session injection).
 */
function buildInstructions(task) {
  const { from, payload, callbackUrl, taskId } = task;
  const action = payload?.action || 'unknown';
  const content = payload?.content ? `\n\nContent:\n${payload.content}` : '';

  const curlCmd = [
    `curl -s -X POST '${callbackUrl}'`,
    `  -H 'Content-Type: application/json'`,
    `  -d '{"taskId":"${taskId}","status":"completed","result":{"answer":"YOUR_ANSWER"}}'`,
  ].join(' \\\n');

  return [
    `[ATA Task from ${from}]`,
    `Task ID: ${taskId}`,
    `Action: ${action}${content}`,
    ``,
    `⚠️ Automated inter-agent task. Process it and run this curl via exec:`,
    ``,
    curlCmd,
  ].join('\n');
}

module.exports = { forwardToGateway };
