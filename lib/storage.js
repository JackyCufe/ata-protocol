/**
 * ATA Protocol - Local JSON File Storage
 *
 * Stores task state as individual JSON files under dataDir/tasks/<taskId>.json
 * Simple, no DB dependency, survives process restarts.
 */

'use strict';

const fs = require('fs');
const path = require('path');

class TaskStorage {
  /**
   * @param {string} dataDir  Absolute path to storage root
   */
  constructor(dataDir) {
    this.tasksDir = path.join(dataDir, 'tasks');
    this._ensureDir(this.tasksDir);
  }

  _ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _taskPath(taskId) {
    // Sanitize to prevent path traversal
    const safe = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.tasksDir, `${safe}.json`);
  }

  /**
   * Save a new task record.
   * @param {object} task  Must include { taskId, ... }
   */
  save(task) {
    const filePath = this._taskPath(task.taskId);
    fs.writeFileSync(filePath, JSON.stringify(task, null, 2), 'utf8');
    return task;
  }

  /**
   * Load a task by ID. Returns null if not found.
   * @param {string} taskId
   * @returns {object|null}
   */
  get(taskId) {
    const filePath = this._taskPath(taskId);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Update fields on an existing task.
   * @param {string} taskId
   * @param {object} updates
   * @returns {object|null} updated task or null if not found
   */
  update(taskId, updates) {
    const existing = this.get(taskId);
    if (!existing) return null;
    const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
    this.save(updated);
    return updated;
  }

  /**
   * List all tasks (optionally filtered by status).
   * @param {{ status?: string }} opts
   * @returns {object[]}
   */
  list(opts = {}) {
    const files = fs.readdirSync(this.tasksDir).filter((f) => f.endsWith('.json'));
    const tasks = files.map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(this.tasksDir, f), 'utf8'));
      } catch {
        return null;
      }
    }).filter(Boolean);

    if (opts.status) {
      return tasks.filter((t) => t.status === opts.status);
    }
    return tasks;
  }

  /**
   * Delete tasks older than ttlMs that are in a terminal state.
   * @param {number} ttlMs
   * @returns {number} number of deleted tasks
   */
  purgeExpired(ttlMs) {
    const now = Date.now();
    const terminalStatuses = new Set(['completed', 'failed', 'rejected']);
    let count = 0;

    for (const task of this.list()) {
      if (!terminalStatuses.has(task.status)) continue;
      const ts = new Date(task.updatedAt || task.createdAt).getTime();
      if (now - ts > ttlMs) {
        try {
          fs.unlinkSync(this._taskPath(task.taskId));
          count++;
        } catch {
          // ignore
        }
      }
    }
    return count;
  }
}

module.exports = { TaskStorage };
