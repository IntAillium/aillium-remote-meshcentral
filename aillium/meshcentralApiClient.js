'use strict';

const https = require('https');
const http = require('http');

const MESHCENTRAL_HOST = process.env.MESHCENTRAL_HOST || 'localhost';
const MESHCENTRAL_PORT = parseInt(process.env.MESHCENTRAL_PORT || '4430', 10);
const MESHCENTRAL_ADMIN_USER = process.env.MESHCENTRAL_ADMIN_USER || 'admin';
const MESHCENTRAL_ADMIN_PASS = process.env.MESHCENTRAL_ADMIN_PASS || '';
const MESHCENTRAL_PROTOCOL = process.env.MESHCENTRAL_PROTOCOL || 'https';
const MESHCENTRAL_REJECT_UNAUTHORIZED = process.env.MESHCENTRAL_REJECT_UNAUTHORIZED !== 'false';

class MeshCentralApiClient {
  constructor(options = {}) {
    this.host = options.host || MESHCENTRAL_HOST;
    this.port = options.port || MESHCENTRAL_PORT;
    this.username = options.username || MESHCENTRAL_ADMIN_USER;
    this.password = options.password || MESHCENTRAL_ADMIN_PASS;
    this.protocol = options.protocol || MESHCENTRAL_PROTOCOL;
    this.rejectUnauthorized = options.rejectUnauthorized ?? MESHCENTRAL_REJECT_UNAUTHORIZED;
    this.authToken = null;
    this.tokenExpiry = null;
  }

  async _request(method, path, body = null) {
    // Auto-refresh expired token
    if (this.authToken && this.tokenExpiry && Date.now() > this.tokenExpiry) {
      this.authToken = null;
      this.tokenExpiry = null;
    }

    const transport = this.protocol === 'https' ? https : http;
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    if (this.authToken) {
      headers['x-meshcentral-logintoken'] = this.authToken;
    } else {
      const credentials = Buffer.from(`${this.username}:${this.password}`).toString('base64');
      headers['Authorization'] = `Basic ${credentials}`;
    }

    const payload = body ? JSON.stringify(body) : null;
    if (payload) {
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    return new Promise((resolve, reject) => {
      const opts = {
        hostname: this.host,
        port: this.port,
        path,
        method,
        headers,
        rejectUnauthorized: this.rejectUnauthorized,
      };

      const req = transport.request(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = data ? JSON.parse(data) : null;
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              const err = new Error(`MeshCentral API error: ${res.statusCode}`);
              err.statusCode = res.statusCode;
              err.body = parsed;
              reject(err);
            }
          } catch (e) {
            reject(new Error(`Failed to parse MeshCentral response: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(30000, () => {
        req.destroy(new Error('MeshCentral API request timeout'));
      });

      if (payload) req.write(payload);
      req.end();
    });
  }

  async authenticate() {
    const result = await this._request('POST', '/api/login', {
      username: this.username,
      password: this.password,
    });
    if (result && result.token) {
      this.authToken = result.token;
      this.tokenExpiry = Date.now() + (3600 * 1000);
    }
    return result;
  }

  // Device Group Management

  async listDeviceGroups() {
    return this._request('GET', '/api/meshes');
  }

  async createDeviceGroup(name, description = '') {
    return this._request('POST', '/api/createmesh', {
      meshname: name,
      meshtype: 2,
      desc: description,
    });
  }

  async deleteDeviceGroup(meshId) {
    return this._request('POST', '/api/deletemesh', { meshid: meshId });
  }

  async addDeviceToGroup(nodeId, meshId) {
    return this._request('POST', '/api/changedevicemesh', {
      nodeids: [nodeId],
      meshid: meshId,
    });
  }

  // Device Queries

  async listDevices(groupId = null) {
    const path = groupId ? `/api/nodes?meshid=${encodeURIComponent(groupId)}` : '/api/nodes';
    return this._request('GET', path);
  }

  async getDevice(nodeId) {
    return this._request('GET', `/api/nodes?id=${encodeURIComponent(nodeId)}`);
  }

  async findDeviceByHostname(hostname, groupId = null) {
    const devices = await this.listDevices(groupId);
    if (!devices || !Array.isArray(devices)) return null;
    return devices.find(d => d.name && d.name.toLowerCase() === hostname.toLowerCase()) || null;
  }

  // Session Management

  async initiateRemoteDesktop(nodeId) {
    return this._request('POST', '/api/remotedesktop', { nodeid: nodeId });
  }

  async initiateTerminal(nodeId) {
    return this._request('POST', '/api/remoteterminal', { nodeid: nodeId });
  }

  async listActiveSessions() {
    return this._request('GET', '/api/sessions');
  }

  async terminateSession(sessionId) {
    return this._request('POST', '/api/closesession', { sessionid: sessionId });
  }

  // Device Actions

  async runCommand(nodeId, command, runAsUser = false) {
    return this._request('POST', '/api/runcommand', {
      nodeids: [nodeId],
      command,
      runAsUser: runAsUser ? 1 : 0,
    });
  }

  async wakeDevice(nodeId) {
    return this._request('POST', '/api/wake', { nodeids: [nodeId] });
  }

  async rebootDevice(nodeId) {
    return this._request('POST', '/api/reboot', { nodeids: [nodeId] });
  }

  // Power & Connectivity

  async getDevicePowerState(nodeId) {
    return this._request('GET', `/api/powertimeline?id=${encodeURIComponent(nodeId)}`);
  }

  // Health Check

  async checkConnectivity() {
    try {
      const result = await this._request('GET', '/api/serverinfo');
      return { connected: true, serverInfo: result };
    } catch (err) {
      return { connected: false, error: err.message };
    }
  }
}

module.exports = { MeshCentralApiClient };
