/**
 * ATA Protocol — Task Executor (framework-agnostic)
 *
 * Replaces lib/gateway.js. When an ATA task arrives, this module decides
 * how to actually run it — no OpenClaw required.
 *
 * Default strategy: in-process handler registry.
 * Drop-in replacements for other backends: HTTP, queue, subprocess — see examples below.
 */

'use strict';

// ── Handler Registry ──────────────────────────────────────────────────────────
// Register your own action handlers here.
// Each handler receives (task) and returns { result: any } or throws.

const handlers = {
  ping: async (task) => {
    return { result: { pong: true, from: task.from, taskId: task.taskId } };
  },

  echo: async (task) => {
    return { result: { echo: task.payload?.content || '' } };
  },

  // Add your own:
  // content_review: async (task) => {
  //   const review = await callYourLLM(task.payload.content);
  //   return { result: { review } };
  // },
};

/**
 * Execute a received ATA task.
 *
 * @param {object} opts
 * @param {object} opts.task   Full ATA task object
 * @param {string} opts.callbackUrl  Where to POST the result
 * @returns {Promise<{ accepted: boolean, message: string }>}
 */
async function executeTask({ task, callbackUrl }) {
  const action = task.payload?.action;
  const handler = handlers[action];

  if (!handler) {
    console.warn(`[ATA] No handler for action "${action}" — skipping execution`);
    await sendCallback(callbackUrl, {
      taskId: task.taskId,
      status: 'failed',
      result: { error: `No handler registered for action: ${action}` },
    });
    return { accepted: false, message: `No handler for action: ${action}` };
  }

  // Run handler async, send callback when done
  setImmediate(async () => {
    try {
      console.log(`[ATA] Executing action "${action}" for task ${task.taskId}`);
      const { result } = await handler(task);
      await sendCallback(callbackUrl, { taskId: task.taskId, status: 'completed', result });
      console.log(`[ATA] Task ${task.taskId} completed`);
    } catch (err) {
      console.error(`[ATA] Handler error for task ${task.taskId}: ${err.message}`);
      await sendCallback(callbackUrl, {
        taskId: task.taskId,
        status: 'failed',
        result: { error: err.message },
      });
    }
  });

  return { accepted: true, message: `handler "${action}" scheduled` };
}

/**
 * POST result back to the caller's callback URL.
 */
async function sendCallback(url, payload) {
  if (!url) return;
  const { postJson } = require('./http');
  try {
    const { status } = await postJson(url, payload);
    console.log(`[ATA] Callback → ${url} (${status})`);
  } catch (err) {
    console.warn(`[ATA] Callback failed: ${err.message}`);
  }
}

/**
 * Register a custom handler at runtime.
 * @param {string} action
 * @param {function} fn  async (task) => { result: any }
 */
function registerHandler(action, fn) {
  handlers[action] = fn;
}

module.exports = { executeTask, registerHandler };
