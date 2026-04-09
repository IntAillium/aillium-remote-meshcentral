'use strict';

const crypto = require('crypto');
const { MeshCentralApiClient } = require('./meshcentralApiClient');

class SessionManager {
  constructor(apiClient = null) {
    this.api = apiClient || new MeshCentralApiClient();
    this._sessions = new Map();
  }

  _generateSessionId() {
    return `ra-session-${crypto.randomUUID()}`;
  }

  async createSession(tenantId, operatorId, deviceNodeId, sessionType, capabilities = []) {
    const sessionId = this._generateSessionId();
    const now = new Date().toISOString();

    let meshResult = null;
    try {
      if (sessionType === 'remote_desktop') {
        meshResult = await this.api.initiateRemoteDesktop(deviceNodeId);
      } else if (sessionType === 'terminal') {
        meshResult = await this.api.initiateTerminal(deviceNodeId);
      } else if (sessionType === 'diagnostics') {
        // Diagnostics don't require a live MeshCentral session
        meshResult = { type: 'diagnostics', nodeId: deviceNodeId };
      }
    } catch (err) {
      console.error(`[SessionManager] Failed to initiate MeshCentral session: ${err.message}`);
      return {
        session_id: sessionId,
        tenant_id: tenantId,
        operator_id: operatorId,
        device_node_id: deviceNodeId,
        session_type: sessionType,
        status: 'failed',
        error: err.message,
        started_at: now,
      };
    }

    const session = {
      session_id: sessionId,
      tenant_id: tenantId,
      operator_id: operatorId,
      device_node_id: deviceNodeId,
      session_type: sessionType,
      capabilities,
      status: 'active',
      mesh_session: meshResult,
      started_at: now,
      ended_at: null,
      actions: [],
      evidence: [],
    };

    this._sessions.set(sessionId, session);
    console.log(`[SessionManager] Session ${sessionId} created for tenant ${tenantId}`);
    return session;
  }

  async getSession(sessionId) {
    return this._sessions.get(sessionId) || null;
  }

  async endSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    session.status = 'ended';
    session.ended_at = new Date().toISOString();

    // Try to terminate MeshCentral session if applicable
    if (session.mesh_session && session.mesh_session.sessionid) {
      try {
        await this.api.terminateSession(session.mesh_session.sessionid);
      } catch (err) {
        console.warn(`[SessionManager] Failed to terminate MeshCentral session: ${err.message}`);
      }
    }

    console.log(`[SessionManager] Session ${sessionId} ended`);
    return session;
  }

  async transferSession(sessionId, fromOperatorId, toOperatorId) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (session.operator_id !== fromOperatorId) {
      throw new Error(`Session ${sessionId} is not owned by operator ${fromOperatorId}`);
    }

    const previousOperator = session.operator_id;
    session.operator_id = toOperatorId;

    session.actions.push({
      action_type: 'session_transfer',
      from_operator: previousOperator,
      to_operator: toOperatorId,
      timestamp: new Date().toISOString(),
    });

    console.log(`[SessionManager] Session ${sessionId} transferred from ${fromOperatorId} to ${toOperatorId}`);
    return session;
  }

  async listActiveSessions(tenantId = null) {
    const sessions = Array.from(this._sessions.values());
    const active = sessions.filter(s => s.status === 'active');
    if (tenantId) {
      return active.filter(s => s.tenant_id === tenantId);
    }
    return active;
  }

  async logAction(sessionId, action) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const record = {
      ...action,
      timestamp: new Date().toISOString(),
    };
    session.actions.push(record);
    return record;
  }

  async addEvidence(sessionId, evidence) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const record = {
      id: crypto.randomUUID(),
      ...evidence,
      captured_at: new Date().toISOString(),
    };
    session.evidence.push(record);
    return record;
  }
}

module.exports = { SessionManager };
