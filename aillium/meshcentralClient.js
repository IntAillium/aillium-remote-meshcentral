'use strict';

const WebSocket = require('ws');

class MeshCentralClient {
  /**
   * @param {object} config
   * @param {string} config.url - Base WSS URL (e.g. wss://meshcentral.example.com:443)
   * @param {string} [config.loginKey] - Optional login key for ?key=... auth
   * @param {string} [config.username] - Username (with --user/--pass auth)
   * @param {string} [config.password] - Password
   * @param {number} [config.timeoutMs=15000] - Request timeout
   */
  constructor(config) {
    if (!config || !config.url) {
      throw new Error('MeshCentralClient requires a url');
    }
    this.config = { timeoutMs: 15000, ...config };
    this._ws = null;
    this._nextRequestId = 1;
    this._pending = new Map(); // requestId -> { resolve, reject, timer }
  }

  async connect() {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) return;
    return new Promise((resolve, reject) => {
      let url = this.config.url;
      if (!url.endsWith('/')) url += '/';
      url += 'control.ashx';
      if (this.config.loginKey) {
        url += (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(this.config.loginKey);
      }
      const headers = {};
      if (this.config.username && this.config.password) {
        const auth = Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64');
        headers['Authorization'] = `Basic ${auth}`;
      }
      const ws = new WebSocket(url, { headers });
      ws.on('open', () => { this._ws = ws; resolve(); });
      ws.on('message', (data) => this._handleMessage(data));
      ws.on('error', (err) => {
        // Reject all pending if not yet connected
        if (!this._ws) reject(err);
        else this._failAllPending(err);
      });
      ws.on('close', () => { this._ws = null; this._failAllPending(new Error('connection closed')); });
    });
  }

  _handleMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); }
    catch (_e) { return; }
    if (msg && msg.responseid != null && this._pending.has(msg.responseid)) {
      const entry = this._pending.get(msg.responseid);
      this._pending.delete(msg.responseid);
      clearTimeout(entry.timer);
      entry.resolve(msg);
    }
  }

  _failAllPending(err) {
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this._pending.clear();
  }

  /**
   * Send a request and wait for a matching response (correlated by responseid).
   */
  async request(payload) {
    await this.connect();
    const requestId = this._nextRequestId++;
    const message = { ...payload, responseid: requestId };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(requestId);
        reject(new Error('MeshCentral request timeout'));
      }, this.config.timeoutMs);
      this._pending.set(requestId, { resolve, reject, timer });
      this._ws.send(JSON.stringify(message), (err) => {
        if (err) {
          clearTimeout(timer);
          this._pending.delete(requestId);
          reject(err);
        }
      });
    });
  }

  close() {
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._failAllPending(new Error('client closed'));
  }
}

module.exports = { MeshCentralClient };
