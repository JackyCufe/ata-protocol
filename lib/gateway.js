/**
 * ATA Protocol — OpenClaw Gateway Forwarder
 *
 * Received ATA tasks are forwarded to the local OpenClaw gateway
 * via /rpc/send-message so the local agent can execute them.
 */

'use strict';

const { postJson } = require('./http');

/**
 * Forward a received ATA task to the local OpenClaw gateway.
 *
 * @param {object} opts
 * @param {string} opts.gatewayUrl    e.g. "http://localhost:18789"
 * @param {string} opts.gatewayToken  Bearer token for gateway auth
 * @param {string} opts.localAgentId  Target agent ID (e.g. "main")
 * @param {object} opts.task          Full ATA task-request object
 * @returns {Promise<{ accepted: boolean, message?: string }>}
 */
async function forwardToGateway({ gatewayUrl, gatewayToken, localAgentId, task }) {
  const url = new URL('/rpc/send-message', gatewayUrl).toString();
  const agentId = localAgentId || 'main';

  const headers = gatewayToken ? { Authorization: `Bearer ${gatewayToken}` } : {};
  const { status, data } = await postJson(
    url,
    { agentId, message: buildInstructions(task) },
    headers,
  );

  const accepted = status >= 200 && status < 300;
  const message = accepted
    ? (typeof data === 'string' ? data : JSON.stringify(data))
    : `Gateway returned ${status}: ${JSON.stringify(data)}`;

  return { accepted, message };
}

/**
 * Build a human-readable instruction string for the local agent.
 */
function buildInstructions(task) {
  const { from, payload, callbackUrl, taskId } = task;
  const action = payload?.action || 'unknown';
  const content = payload?.content ? `\n\nContent:\n${payload.content}` : '';

  return [
    `[ATA Task from ${from}]`,
    `Task ID: ${taskId}`,
    `Action: ${action}${content}`,
    '',
    `When complete, POST your result to: ${callbackUrl}`,
    `Result format: { "taskId": "${taskId}", "status": "completed", "result": { ... } }`,
  ].join('\n');
}

module.exports = { forwardToGateway };
