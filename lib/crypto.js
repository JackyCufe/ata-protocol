/**
 * ATA Protocol - HMAC-SHA256 Signing & Verification
 *
 * Signing strategy:
 *   signature = HMAC-SHA256(secret, `${taskId}:${timestamp}:${bodyHex}`)
 *
 * Where bodyHex = hex of the raw request body bytes.
 * This prevents replay attacks (timestamp) and body tampering.
 */

'use strict';

const crypto = require('crypto');

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Build the signing payload string.
 * @param {string} taskId
 * @param {number} timestamp  Unix epoch ms
 * @param {Buffer|string} body  Raw request body
 * @returns {string}
 */
function buildSigningPayload(taskId, timestamp, body) {
  const bodyHex = Buffer.isBuffer(body) ? body.toString('hex') : Buffer.from(body).toString('hex');
  return `${taskId}:${timestamp}:${bodyHex}`;
}

/**
 * Sign a task request body.
 * @param {string} secret      Shared HMAC secret
 * @param {string} taskId
 * @param {number} timestamp   Unix epoch ms
 * @param {Buffer|string} body Raw body bytes
 * @returns {string} hex signature
 */
function sign(secret, taskId, timestamp, body) {
  if (!secret) throw new Error('ATA_SHARED_SECRET is required for signing');
  const payload = buildSigningPayload(taskId, timestamp, body);
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Verify a signature from an incoming request.
 * @param {string} secret
 * @param {string} taskId
 * @param {number} timestamp
 * @param {Buffer|string} body
 * @param {string} receivedSig  hex signature from request
 * @returns {{ ok: boolean, reason?: string }}
 */
function verify(secret, taskId, timestamp, body, receivedSig) {
  if (!secret) {
    // If no secret configured, skip verification (dev / open mode)
    return { ok: true, reason: 'no_secret_configured' };
  }

  // Replay protection: reject requests older than tolerance window
  const now = Date.now();
  if (Math.abs(now - timestamp) > TIMESTAMP_TOLERANCE_MS) {
    return { ok: false, reason: `timestamp_out_of_range (delta ${now - timestamp}ms)` };
  }

  const expected = sign(secret, taskId, timestamp, body);
  const receivedBuf = Buffer.from(receivedSig || '', 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');

  if (receivedBuf.length !== expectedBuf.length) {
    return { ok: false, reason: 'signature_length_mismatch' };
  }

  const match = crypto.timingSafeEqual(receivedBuf, expectedBuf);
  return match ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}

module.exports = { sign, verify, buildSigningPayload };
