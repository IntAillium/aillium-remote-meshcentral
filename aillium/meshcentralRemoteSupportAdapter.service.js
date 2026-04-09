'use strict';

const { MeshCentralApiClient } = require('./meshcentralApiClient');
const { TenantGroupManager } = require('./tenantGroupManager');
const { SessionManager } = require('./sessionManager');
const { EvidenceCollector } = require('./evidenceCollector');
const { HealthProbe } = require('./healthProbe');

class DeferredIntegrationError extends Error {
    constructor(operationName) {
        super('MeshCentral live integration for operation "' + operationName + '" is deferred.');
        this.name = 'DeferredIntegrationError';
        this.code = 'MESH_ADAPTER_DEFERRED_INTEGRATION';
        this.operationName = operationName;
    }
}

function buildEnvelope(operation, request, result = null) {
    return {
        adapter: 'aillium-remote-meshcentral',
        contractFamily: 'meshcentral-remote-support',
        operation,
        request,
        integrationStatus: result ? 'live' : 'deferred',
        result,
        timestamp: new Date().toISOString(),
    };
}

function createMeshCentralRemoteSupportAdapter(options = {}) {
    const apiClient = new MeshCentralApiClient(options);
    const tenantGroupManager = new TenantGroupManager(apiClient);
    const sessionManager = new SessionManager(apiClient);
    const evidenceCollector = new EvidenceCollector(options);
    const healthProbe = new HealthProbe(apiClient);

    return {
        async resolveDeviceTarget(request) {
            const { tenant_id, hostname, mesh_device_id } = request;

            try {
                const groupId = await tenantGroupManager.ensureTenantGroup(tenant_id);

                let device = null;
                if (mesh_device_id) {
                    device = await apiClient.getDevice(mesh_device_id);
                } else if (hostname) {
                    device = await apiClient.findDeviceByHostname(hostname, groupId);
                }

                if (!device) {
                    return buildEnvelope('resolveDeviceTarget', request, {
                        resolved: false,
                        error: 'Device not found in tenant group',
                    });
                }

                const nodeId = device._id || device.nodeid || device.id;
                return buildEnvelope('resolveDeviceTarget', request, {
                    resolved: true,
                    node_id: nodeId,
                    group_id: groupId,
                    device_name: device.name,
                    device_os: device.osdesc || device.os,
                    online: device.conn ? true : false,
                });
            } catch (err) {
                return buildEnvelope('resolveDeviceTarget', request, {
                    resolved: false,
                    error: err.message,
                });
            }
        },

        async createSupportSession(request) {
            const { tenant_id, operator_id, device_node_id, session_type, capabilities } = request;

            try {
                const session = await sessionManager.createSession(
                    tenant_id,
                    operator_id,
                    device_node_id,
                    session_type || 'remote_desktop',
                    capabilities || []
                );

                return buildEnvelope('createSupportSession', request, {
                    session_id: session.session_id,
                    status: session.status,
                    mesh_session: session.mesh_session,
                    started_at: session.started_at,
                });
            } catch (err) {
                return buildEnvelope('createSupportSession', request, {
                    session_id: null,
                    status: 'failed',
                    error: err.message,
                });
            }
        },

        async handoffSessionControl(request) {
            const { session_id, from_operator_id, to_operator_id } = request;

            try {
                const session = await sessionManager.transferSession(
                    session_id,
                    from_operator_id,
                    to_operator_id
                );

                return buildEnvelope('handoffSessionControl', request, {
                    session_id: session.session_id,
                    new_operator_id: session.operator_id,
                    status: 'transferred',
                });
            } catch (err) {
                return buildEnvelope('handoffSessionControl', request, {
                    session_id: request.session_id,
                    status: 'failed',
                    error: err.message,
                });
            }
        },

        async captureSessionEvidence(request) {
            const { tenant_id, session_id, evidence_type, data } = request;

            try {
                let evidence;
                switch (evidence_type) {
                    case 'screenshot':
                        evidence = await evidenceCollector.captureScreenshot(
                            tenant_id, session_id, data.buffer || Buffer.alloc(0), data.metadata
                        );
                        break;
                    case 'log_capture':
                        evidence = await evidenceCollector.collectSessionLog(
                            tenant_id, session_id, data.entries || []
                        );
                        break;
                    case 'command_output':
                        evidence = await evidenceCollector.collectCommandOutput(
                            tenant_id, session_id, data.command || '', data.output || ''
                        );
                        break;
                    case 'config_snapshot':
                        evidence = await evidenceCollector.collectConfigSnapshot(
                            tenant_id, session_id, data.config || {}
                        );
                        break;
                    default:
                        evidence = evidenceCollector.normalizeEvidence({
                            evidence_type,
                            ...data,
                        });
                }

                // Also record in session
                await sessionManager.addEvidence(session_id, evidence);

                return buildEnvelope('captureSessionEvidence', request, {
                    evidence_id: evidence.id || null,
                    evidence_type: evidence.evidence_type,
                    storage_uri: evidence.storage_uri,
                    hash: evidence.hash,
                    captured_at: evidence.captured_at,
                });
            } catch (err) {
                return buildEnvelope('captureSessionEvidence', request, {
                    evidence_id: null,
                    status: 'failed',
                    error: err.message,
                });
            }
        },

        async mapDeviceToTenantGroup(request) {
            const { tenant_id, device_node_id } = request;

            try {
                const mapping = await tenantGroupManager.addDeviceToTenantGroup(
                    tenant_id,
                    device_node_id
                );

                return buildEnvelope('mapDeviceToTenantGroup', request, {
                    tenant_id: mapping.tenantId,
                    group_id: mapping.groupId,
                    device_node_id: mapping.deviceNodeId,
                    status: 'mapped',
                });
            } catch (err) {
                return buildEnvelope('mapDeviceToTenantGroup', request, {
                    status: 'failed',
                    error: err.message,
                });
            }
        },

        // Additional operations

        async endSession(request) {
            const { session_id } = request;
            try {
                const session = await sessionManager.endSession(session_id);
                return buildEnvelope('endSession', request, {
                    session_id: session.session_id,
                    status: session.status,
                    ended_at: session.ended_at,
                });
            } catch (err) {
                return buildEnvelope('endSession', request, {
                    status: 'failed',
                    error: err.message,
                });
            }
        },

        async listActiveSessions(request) {
            const { tenant_id } = request;
            const sessions = await sessionManager.listActiveSessions(tenant_id);
            return buildEnvelope('listActiveSessions', request, {
                sessions: sessions.map(s => ({
                    session_id: s.session_id,
                    operator_id: s.operator_id,
                    device_node_id: s.device_node_id,
                    session_type: s.session_type,
                    status: s.status,
                    started_at: s.started_at,
                })),
                count: sessions.length,
            });
        },

        async getHealth() {
            return healthProbe.getAdapterStatus();
        },

        // Access sub-managers for advanced use
        _apiClient: apiClient,
        _tenantGroupManager: tenantGroupManager,
        _sessionManager: sessionManager,
        _evidenceCollector: evidenceCollector,
        _healthProbe: healthProbe,
    };
}

module.exports = {
    DeferredIntegrationError,
    createMeshCentralRemoteSupportAdapter,
};
