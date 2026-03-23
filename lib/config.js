/**
 * ATA Protocol — Configuration Loader (standalone, no OpenClaw dependency)
 */

'use strict';

const path = require('path');

function loadConfig() {
  return {
    // Server identity
    agentId:      process.env.ATA_AGENT_ID      || 'agent://unknown/assistant',
    agentName:    process.env.ATA_AGENT_NAME     || 'Assistant',
    agentOwner:   process.env.ATA_AGENT_OWNER    || 'unknown',
    agentVersion: process.env.ATA_AGENT_VERSION  || '0.1.0',

    // Capabilities this agent exposes (comma-separated)
    capabilities: (process.env.ATA_CAPABILITIES || 'ping')
      .split(',').map((c) => c.trim()).filter(Boolean),

    // HTTP server
    port: parseInt(process.env.ATA_PORT || '3740', 10),
    host: process.env.ATA_HOST || '0.0.0.0',

    // Public-facing URL (used in agent card and callback URLs)
    publicUrl: process.env.ATA_PUBLIC_URL || 'http://localhost:3740',

    // HMAC shared secret
    sharedSecret: process.env.ATA_SHARED_SECRET || '',

    // Task state storage
    dataDir: process.env.ATA_DATA_DIR || path.join(__dirname, '..', 'data'),

    // Task TTL
    taskTtlMs: parseInt(process.env.ATA_TASK_TTL_MS || String(24 * 60 * 60 * 1000), 10),

    // Client polling
    pollTimeoutMs:  parseInt(process.env.ATA_POLL_TIMEOUT_MS  || '30000', 10),
    pollIntervalMs: parseInt(process.env.ATA_POLL_INTERVAL_MS || '1000',  10),
  };
}

module.exports = { loadConfig };
