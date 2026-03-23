/**
 * ATA Protocol — OpenClaw Gateway Forwarder
 *
 * Delivers a received ATA task to the local OpenClaw agent via the
 * Gateway's /tools/invoke HTTP endpoint (POST).
 *
 * Docs: openclaw/docs/gateway/tools-invoke-http-api.md
 * Tool used: `sessions_send` (injects message into a target session)
 *
 * Note: sessions_send is on the gateway default deny list.
 * The operator must explicitly allow it:
 *   gateway.tools.allow: ["sessions_send"]
 */

'use strict';

const { postJson } = require('./http');

/**
 * Forward a received ATA task to the local OpenClaw agent.
 *
 * @param {object} opts
 * @param {string} opts.gatewayUrl    e.g. "http://localhost:18789"
 * @param {string} opts.gatewayToken  Bearer token (gateway.auth.token)
 * @param {string} opts.localAgentId  Target session key, e.g. "main" or "coding"
 * @param {object} opts.task          Full ATA task-request object
 * @returns {Promise<{ accepted: boolean, message?: string }>}
 */
async function forwardToGateway({ gatewayUrl, gatewayToken, localAgentId, task }) {
  const url = new URL('/tools/invoke', gatewayUrl).toString();
  const agentId = localAgentId || 'main';

  const payload = {
    tool: 'sessions_send',
    args: {
      sessionKey: agentId,
      message: buildInstructions(task),
    },
  };

  const headers = gatewayToken ? { Authorization: `Bearer ${gatewayToken}` } : {};
  const { status, data } = await postJson(url, payload, headers);

  const accepted = status === 200 && data?.ok === true;
  const message = accepted
    ? 'forwarded to agent via sessions_send'
    : `Gateway /tools/invoke failed (${status}): ${JSON.stringify(data)}`;

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
