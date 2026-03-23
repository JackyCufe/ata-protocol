/**
 * ATA Protocol - OpenClaw Gateway Forwarder
 *
 * When this ATA server receives a task from a remote agent,
 * it forwards it to the local OpenClaw gateway for processing.
 *
 * The gateway responds via the callback URL once done.
 */

'use strict';

const http = require('http');
const https = require('https');

/**
 * Forward a received ATA task to the local OpenClaw gateway.
 * The gateway is expected to POST its result to callbackUrl.
 *
 * @param {object} opts
 * @param {string} opts.gatewayUrl   e.g. "http://localhost:3000"
 * @param {string} opts.gatewayToken Bearer token for gateway auth
 * @param {object} opts.task         Full ATA task-request object
 * @returns {Promise<{ accepted: boolean, message?: string }>}
 */
async function forwardToGateway({ gatewayUrl, gatewayToken, task, localAgentId }) {
  // Use OpenClaw gateway RPC: POST /rpc/send-message to deliver task to local agent
  const url = new URL('/rpc/send-message', gatewayUrl);

  const instructions = buildInstructions(task);
  const agentId = localAgentId || 'main';

  const body = JSON.stringify({
    agentId,
    message: instructions,
  });

  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(gatewayToken ? { Authorization: `Bearer ${gatewayToken}` } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ accepted: true, message: data });
          } else {
            resolve({ accepted: false, message: `Gateway returned ${res.statusCode}: ${data}` });
          }
        });
      },
    );

    req.on('error', (err) => reject(err));
    req.write(body);
    req.end();
  });
}

/**
 * Build a human-readable instruction string for the local agent.
 * This is what shows up as the "task" for the local OpenClaw session.
 */
function buildInstructions(task) {
  const { from, payload, callbackUrl, taskId } = task;
  const action = payload?.action || 'unknown';
  const content = payload?.content ? `\n\nContent:\n${payload.content}` : '';

  return (
    `[ATA Task from ${from}]\n` +
    `Task ID: ${taskId}\n` +
    `Action: ${action}${content}\n\n` +
    `When complete, POST your result to:\n${callbackUrl}\n\n` +
    `Result format: { "taskId": "${taskId}", "status": "completed", "result": { ... } }`
  );
}

/**
 * Simple HTTP POST helper for sending callbacks.
 * @param {string} url
 * @param {object} payload
 * @returns {Promise<void>}
 */
async function postJson(url, payload) {
  const parsed = new URL(url);
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(
      parsed,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume(); // drain
        res.on('end', resolve);
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { forwardToGateway, postJson };
