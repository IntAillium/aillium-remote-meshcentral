'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const EVIDENCE_BASE_PATH = process.env.EVIDENCE_STORAGE_PATH || '/opt/meshcentral/meshcentral-data/evidence';

class EvidenceCollector {
  constructor(options = {}) {
    this.basePath = options.basePath || EVIDENCE_BASE_PATH;
  }

  _sanitizePathSegment(segment) {
    if (!segment || typeof segment !== 'string') return 'unknown';
    return segment.replace(/[^a-zA-Z0-9_\-]/g, '_');
  }

  _tenantPath(tenantId, sessionId) {
    const safeTenant = this._sanitizePathSegment(tenantId);
    const safeSession = this._sanitizePathSegment(sessionId);
    const resolved = path.join(this.basePath, safeTenant, safeSession);
    // Ensure the resolved path stays within basePath
    if (!resolved.startsWith(path.resolve(this.basePath))) {
      throw new Error('Invalid evidence path: directory traversal detected');
    }
    return resolved;
  }

  _ensureDir(dirPath) {
    try {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
    } catch (err) {
      throw new Error(`Failed to create evidence directory: ${err.message}`);
    }
  }

  _computeHash(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  async captureScreenshot(tenantId, sessionId, screenshotBuffer, metadata = {}) {
    const dir = this._tenantPath(tenantId, sessionId);
    this._ensureDir(dir);

    const timestamp = Date.now();
    const filename = `screenshot-${timestamp}.png`;
    const filepath = path.join(dir, filename);

    const buffer = Buffer.isBuffer(screenshotBuffer) ? screenshotBuffer : Buffer.from(screenshotBuffer);
    try {
      fs.writeFileSync(filepath, buffer);
    } catch (err) {
      throw new Error(`Failed to write evidence file ${filename}: ${err.message}`);
    }

    const hash = this._computeHash(buffer);

    return {
      evidence_type: 'screenshot',
      storage_uri: filepath,
      hash,
      file_name: filename,
      file_size: buffer.length,
      metadata,
      captured_at: new Date().toISOString(),
    };
  }

  async collectSessionLog(tenantId, sessionId, logEntries) {
    const dir = this._tenantPath(tenantId, sessionId);
    this._ensureDir(dir);

    const timestamp = Date.now();
    const filename = `session-log-${timestamp}.json`;
    const filepath = path.join(dir, filename);

    const content = JSON.stringify({
      session_id: sessionId,
      tenant_id: tenantId,
      entries: logEntries,
      exported_at: new Date().toISOString(),
    }, null, 2);

    try {
      fs.writeFileSync(filepath, content, 'utf-8');
    } catch (err) {
      throw new Error(`Failed to write evidence file ${filename}: ${err.message}`);
    }
    const hash = this._computeHash(Buffer.from(content));

    return {
      evidence_type: 'log_capture',
      storage_uri: filepath,
      hash,
      file_name: filename,
      entry_count: Array.isArray(logEntries) ? logEntries.length : 0,
      captured_at: new Date().toISOString(),
    };
  }

  async collectCommandOutput(tenantId, sessionId, command, output) {
    const dir = this._tenantPath(tenantId, sessionId);
    this._ensureDir(dir);

    const timestamp = Date.now();
    const filename = `command-output-${timestamp}.json`;
    const filepath = path.join(dir, filename);

    const content = JSON.stringify({
      session_id: sessionId,
      tenant_id: tenantId,
      command,
      output,
      captured_at: new Date().toISOString(),
    }, null, 2);

    try {
      fs.writeFileSync(filepath, content, 'utf-8');
    } catch (err) {
      throw new Error(`Failed to write evidence file ${filename}: ${err.message}`);
    }
    const hash = this._computeHash(Buffer.from(content));

    return {
      evidence_type: 'command_output',
      storage_uri: filepath,
      hash,
      file_name: filename,
      captured_at: new Date().toISOString(),
    };
  }

  async collectConfigSnapshot(tenantId, sessionId, configData) {
    const dir = this._tenantPath(tenantId, sessionId);
    this._ensureDir(dir);

    const timestamp = Date.now();
    const filename = `config-snapshot-${timestamp}.json`;
    const filepath = path.join(dir, filename);

    const content = JSON.stringify({
      session_id: sessionId,
      tenant_id: tenantId,
      config: configData,
      captured_at: new Date().toISOString(),
    }, null, 2);

    try {
      fs.writeFileSync(filepath, content, 'utf-8');
    } catch (err) {
      throw new Error(`Failed to write evidence file ${filename}: ${err.message}`);
    }
    const hash = this._computeHash(Buffer.from(content));

    return {
      evidence_type: 'config_snapshot',
      storage_uri: filepath,
      hash,
      file_name: filename,
      captured_at: new Date().toISOString(),
    };
  }

  normalizeEvidence(rawEvidence) {
    return {
      evidence_type: rawEvidence.evidence_type || 'unknown',
      storage_uri: rawEvidence.storage_uri || rawEvidence.filepath || rawEvidence.path || '',
      hash: rawEvidence.hash || rawEvidence.sha256 || null,
      file_name: rawEvidence.file_name || rawEvidence.filename || null,
      captured_at: rawEvidence.captured_at || rawEvidence.timestamp || new Date().toISOString(),
      metadata: rawEvidence.metadata || {},
    };
  }

  async listEvidence(tenantId, sessionId) {
    const dir = this._tenantPath(tenantId, sessionId);
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir);
    return files.map(f => ({
      file_name: f,
      storage_uri: path.join(dir, f),
      size: fs.statSync(path.join(dir, f)).size,
    }));
  }
}

module.exports = { EvidenceCollector };
