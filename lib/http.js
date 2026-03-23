/**
 * ATA Protocol — Shared HTTP utilities
 * Single source of truth for raw HTTP request / JSON helpers.
 */

'use strict';

const http = require('http');
const https = require('https');

/**
 * Low-level HTTP request.
 * @param {string} url
 * @param {{ method?: string, headers?: object }} options
 * @param {string|Buffer|null} body
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
function request(url, options = {}, body = null) {
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
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      );
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * GET and parse JSON.
 * @param {string} url
 * @returns {Promise<object>}
 */
async function getJson(url) {
  const res = await request(url, { method: 'GET', headers: { Accept: 'application/json' } });
  if (res.status !== 200) throw new Error(`GET ${url} → ${res.status}: ${res.body}`);
  return JSON.parse(res.body);
}

/**
 * POST JSON and return parsed response.
 * @param {string} url
 * @param {object} payload
 * @param {object} [extraHeaders]
 * @returns {Promise<{ status: number, data: object|string }>}
 */
async function postJson(url, payload, extraHeaders = {}) {
  const bodyStr = JSON.stringify(payload, null, 2);
  const res = await request(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...extraHeaders,
      },
    },
    bodyStr,
  );

  let data;
  try { data = JSON.parse(res.body); } catch { data = res.body; }

  return { status: res.status, data };
}

module.exports = { request, getJson, postJson };
