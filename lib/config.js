/**
 * ATA Protocol - Configuration Loader
 * Reads from environment variables with sensible defaults.
 */

'use strict';

const path = require('path');

function loadConfig() {
  return {
    // Server identity
    agentId: process.env.ATA_AGENT_ID || 'agent://unknown/assistant',
    agentName: process.env.ATA_AGENT_NAME || 'Assistant',
    agentOwner: process.env.ATA_AGENT_OWNER || 'unknown',
    agentVersion: process.env.ATA_AGENT_VERSION || '0.1.0',

    // Capabilities this agent exposes
    capabilities: (process.env.ATA_CAPABILITIES || 'ping')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean),

    // HTTP server settings
    port: parseInt(process.env.ATA_PORT || '4242', 10),
    host: process.env.ATA_HOST || '0.0.0.0',

    // Public-facing URL (used in callback URLs and agent card)
    publicUrl: process.env.ATA_PUBLIC_URL || 'http://localhost:4242',

    // HMAC shared secret (must match between sender and receiver)
    sharedSecret: process.env.ATA_SHARED_SECRET || '',

    // OpenClaw gateway for forwarding tasks locally
    gatewayUrl: process.env.ATA_GATEWAY_URL || 'http://localhost:3000',
    gatewayToken: process.env.ATA_GATEWAY_TOKEN || '',

    // Local data directory for task state
    dataDir: process.env.ATA_DATA_DIR || path.join(__dirname, '..', 'data'),

    // How long (ms) to keep completed tasks in state
    taskTtlMs: parseInt(process.env.ATA_TASK_TTL_MS || String(24 * 60 * 60 * 1000), 10),

    // Client: how long to poll for results (ms)
    pollTimeoutMs: parseInt(process.env.ATA_POLL_TIMEOUT_MS || '30000', 10),
    pollIntervalMs: parseInt(process.env.ATA_POLL_INTERVAL_MS || '1000', 10),
  };
}

module.exports = { loadConfig };
