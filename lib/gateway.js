/**
 * ATA Protocol — OpenClaw Gateway Forwarder
 *
 * Inspired by the "Lobster Post Office" pattern in OpenClaw:
 * tasks arrive as messages and flow through the same queue + routing pipeline
 * as any other inbound message — no special backdoors.
 *
 * Strategy:
 *   1. PREFERRED: inbound HTTP webhook (tasks enter as real inbound messages,
 *      get queued, deduplicated, and routed by bindings like any channel message).
 *      Requires: gateway.webhooks config in openclaw.json.
 *
 *   2. FALLBACK: tools/invoke with sessions_send (direct injection).
 *      Simpler but bypasses the message queue and binding rules.
 *      Requires: gateway.tools.allow = ["sessions_send"] in openclaw.json.
 *
 * Docs:
 *   openclaw/docs/gateway/tools-invoke-http-api.md
 *   openclaw/docs/concepts/queue.md
 *   openclaw/docs/concepts/multi-agent.md (bindings)
 */

'use strict';

const { postJson } = require('./http');

/**
 * Forward a received ATA task to the local OpenClaw gateway.
 *
 * @param {object} opts
 * @param {string} opts.gatewayUrl
 * @param {string} opts.gatewayToken
 * @param {string} opts.localAgentId  Session key, e.g. "coding" or "main"
 * @param {object} opts.task
 * @returns {Promise<{ accepted: boolean, message: string }>}
 */
async function forwardToGateway({ gatewayUrl, gatewayToken, localAgentId, task }) {
  // Strategy 1: webhook (preferred — tasks enter the normal message queue)
  const webhookResult = await tryWebhook({ gatewayUrl, gatewayToken, localAgentId, task });
  if (webhookResult.accepted) return webhookResult;

  // Strategy 2: fallback to direct sessions_send
  console.warn('[ATA] Webhook unavailable, falling back to sessions_send');
  return trySessionsSend({ gatewayUrl, gatewayToken, localAgentId, task });
}

// ── Strategy 1: Webhook (queue-aware, respects bindings) ─────────────────────
//
// Tasks arrive as real inbound messages.
// They get queued, deduplicated, and routed by OpenClaw bindings —
// exactly like WhatsApp or Telegram messages.
//
// To enable: add to openclaw.json:
//   "webhooks": {
//     "ata": {
//       "enabled": true,
//       "path": "/webhooks/ata",
//       "secret": "<same as ATA_GATEWAY_TOKEN>",
//       "targetAgent": "main"
//     }
//   }

async function tryWebhook({ gatewayUrl, gatewayToken, localAgentId, task }) {
  const url = new URL('/webhooks/ata', gatewayUrl).toString();
  const headers = gatewayToken ? { Authorization: `Bearer ${gatewayToken}` } : {};

  const payload = {
    from: task.from,
    taskId: task.taskId,
    action: task.payload?.action,
    message: buildInstructions(task),
    agentId: localAgentId || 'main',
    _meta: { ataTask: true, callbackUrl: task.callbackUrl },
  };

  try {
    const { status, data } = await postJson(url, payload, headers);
    if (status === 200 || status === 202) {
      return { accepted: true, message: 'delivered via webhook (queue-aware)' };
    }
    return { accepted: false, message: `Webhook rejected: ${status}` };
  } catch (err) {
    return { accepted: false, message: `Webhook unavailable: ${err.message}` };
  }
}

// ── Strategy 2: sessions_send (direct injection, bypasses queue) ─────────────
//
// Simple and reliable, but bypasses OpenClaw's message queue and binding rules.
// The task is injected directly into the target session.
//
// To enable: add to openclaw.json:
//   "gateway": { "tools": { "allow": ["sessions_send"] } }

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

// ── Instruction builder ───────────────────────────────────────────────────────

function buildInstructions(task) {
  const { from, payload, callbackUrl, taskId } = task;
  const action = payload?.action || 'unknown';
  const content = payload?.content ? `\n\nContent:\n${payload.content}` : '';

  return [
    `[ATA Task from ${from}]`,
    `Task ID: ${taskId}`,
    `Action: ${action}${content}`,
    '',
    `When complete, POST result to: ${callbackUrl}`,
    `Format: { "taskId": "${taskId}", "status": "completed", "result": { ... } }`,
  ].join('\n');
}

module.exports = { forwardToGateway };
