'use strict';

const { MeshCentralApiClient } = require('./meshcentralApiClient');

class HealthProbe {
  constructor(apiClient = null) {
    this.api = apiClient || new MeshCentralApiClient();
  }

  async checkMeshCentralConnectivity() {
    try {
      const result = await this.api.checkConnectivity();
      return {
        status: result.connected ? 'healthy' : 'unhealthy',
        connected: result.connected,
        server_info: result.serverInfo || null,
        error: result.error || null,
        checked_at: new Date().toISOString(),
      };
    } catch (err) {
      return {
        status: 'unhealthy',
        connected: false,
        error: err.message,
        checked_at: new Date().toISOString(),
      };
    }
  }

  async getAdapterStatus() {
    const meshHealth = await this.checkMeshCentralConnectivity();

    return {
      adapter: 'aillium-remote-meshcentral',
      version: '1.1.0',
      status: meshHealth.connected ? 'operational' : 'degraded',
      components: {
        meshcentral: meshHealth,
      },
      checked_at: new Date().toISOString(),
    };
  }
}

module.exports = { HealthProbe };
