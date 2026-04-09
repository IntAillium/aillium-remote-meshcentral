'use strict';

const { MeshCentralApiClient } = require('./meshcentralApiClient');

const TENANT_GROUP_PREFIX = 'tenant-';

class TenantGroupManager {
  constructor(apiClient = null) {
    this.api = apiClient || new MeshCentralApiClient();
    this._groupCache = new Map();
    this._cacheTtl = 5 * 60 * 1000; // 5 minutes
  }

  _tenantGroupName(tenantId) {
    return `${TENANT_GROUP_PREFIX}${tenantId}`;
  }

  _isCacheValid(tenantId) {
    const entry = this._groupCache.get(tenantId);
    return entry && (Date.now() - entry.timestamp) < this._cacheTtl;
  }

  async ensureTenantGroup(tenantId) {
    if (this._isCacheValid(tenantId)) {
      return this._groupCache.get(tenantId).groupId;
    }

    const groupName = this._tenantGroupName(tenantId);
    const groups = await this.api.listDeviceGroups();
    if (!groups || typeof groups !== 'object') {
      // Cannot list groups, fall through to create
    }

    let existing = null;
    if (groups && typeof groups === 'object') {
      const groupList = Array.isArray(groups) ? groups : Object.values(groups);
      existing = groupList.find(g => g.name === groupName || g.meshname === groupName);
    }

    if (existing) {
      const groupId = existing._id || existing.meshid || existing.id;
      this._groupCache.set(tenantId, { groupId, timestamp: Date.now() });
      return groupId;
    }

    const created = await this.api.createDeviceGroup(
      groupName,
      `Aillium tenant group for ${tenantId}`
    );

    const groupId = created._id || created.meshid || created.id;
    this._groupCache.set(tenantId, { groupId, timestamp: Date.now() });

    console.log(`[TenantGroupManager] Created group "${groupName}" => ${groupId}`);
    return groupId;
  }

  async addDeviceToTenantGroup(tenantId, deviceNodeId) {
    const groupId = await this.ensureTenantGroup(tenantId);
    await this.api.addDeviceToGroup(deviceNodeId, groupId);
    console.log(`[TenantGroupManager] Added device ${deviceNodeId} to tenant ${tenantId} group`);
    return { tenantId, groupId, deviceNodeId };
  }

  async removeDeviceFromTenantGroup(tenantId, deviceNodeId) {
    // MeshCentral doesn't have a direct "remove from group" - move to unassigned
    // For now log the intent and return
    console.log(`[TenantGroupManager] Remove device ${deviceNodeId} from tenant ${tenantId} (deferred - requires MeshCentral group reassignment)`);
    return { tenantId, deviceNodeId, status: 'removal_requested' };
  }

  async listTenantDevices(tenantId) {
    const groupId = await this.ensureTenantGroup(tenantId);
    const devices = await this.api.listDevices(groupId);
    return Array.isArray(devices) ? devices : [];
  }

  async getTenantGroupId(tenantId) {
    return this.ensureTenantGroup(tenantId);
  }

  clearCache(tenantId = null) {
    if (tenantId) {
      this._groupCache.delete(tenantId);
    } else {
      this._groupCache.clear();
    }
  }
}

module.exports = { TenantGroupManager, TENANT_GROUP_PREFIX };
