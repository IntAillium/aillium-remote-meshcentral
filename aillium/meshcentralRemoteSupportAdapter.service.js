'use strict';

const { MeshCentralClient } = require('./meshcentralClient.js');

// MeshCentral siteadmin bitmask for full site administrator. The adapter's
// service account should NOT be a full siteadmin in production — see
// SECURITY.AILLIUM.md §5.1 for required per-operation rights.
const SITEADMIN_FULL = 0xFFFFFFFF;

class DeferredIntegrationError extends Error {
    constructor(operationName) {
        super('MeshCentral live integration for operation "' + operationName + '" is deferred.');
        this.name = 'DeferredIntegrationError';
        this.code = 'MESH_ADAPTER_DEFERRED_INTEGRATION';
        this.operationName = operationName;
    }
}

function buildEnvelope(operation, request, extra) {
    return Object.assign({
        adapter: 'aillium-remote-meshcentral',
        contractFamily: 'meshcentral-remote-support',
        operation,
        request
    }, extra);
}

function deferred(operation, request) {
    return buildEnvelope(operation, request, {
        integrationStatus: 'deferred',
        error: {
            code: 'MESH_ADAPTER_DEFERRED_INTEGRATION',
            message: 'Live MeshCentral API integration is not yet implemented for this operation.'
        }
    });
}

/**
 * @param {object} [options]
 * @param {MeshCentralClient} [options.client] - Pre-configured client (overrides env-based config)
 * @param {object} [options.env] - Env-like object for testing (defaults to process.env)
 */
function createMeshCentralRemoteSupportAdapter(options = {}) {
    const env = options.env || process.env;

    function getClient() {
        if (options.client) return options.client;
        if (!env.MESHCENTRAL_URL) return null;
        return new MeshCentralClient({
            url: env.MESHCENTRAL_URL,
            loginKey: env.MESHCENTRAL_LOGIN_KEY,
            username: env.MESHCENTRAL_USERNAME,
            password: env.MESHCENTRAL_PASSWORD,
            timeoutMs: env.MESHCENTRAL_TIMEOUT_MS ? Number.parseInt(env.MESHCENTRAL_TIMEOUT_MS, 10) : undefined
        });
    }

    return {
        async resolveDeviceTarget(request) {
            const client = getClient();
            if (!client) {
                return deferred('resolveDeviceTarget', request);
            }
            try {
                // MeshCentral 'nodes' action returns all nodes the user can see.
                // We filter to find the requested device by device_id.
                const response = await client.request({ action: 'nodes' });
                const nodes = response && (response.nodes || response.devices) || {};
                let matched = null;
                for (const meshid of Object.keys(nodes)) {
                    const list = Array.isArray(nodes[meshid]) ? nodes[meshid] : [];
                    for (const node of list) {
                        if (node._id === request.device_id || node.name === request.device_id) {
                            matched = { node_id: node._id, mesh_id: meshid, name: node.name };
                            break;
                        }
                    }
                    if (matched) break;
                }
                if (!matched) {
                    return buildEnvelope('resolveDeviceTarget', request, {
                        integrationStatus: 'failed',
                        error: { code: 'DEVICE_NOT_FOUND', message: `No MeshCentral node matches device_id "${request.device_id}"` }
                    });
                }
                return buildEnvelope('resolveDeviceTarget', request, {
                    integrationStatus: 'ok',
                    result: matched
                });
            } catch (err) {
                return buildEnvelope('resolveDeviceTarget', request, {
                    integrationStatus: 'error',
                    error: { code: 'MESH_REQUEST_FAILED', message: err && err.message ? err.message : String(err) }
                });
            }
        },

        // TODO: Implement against MeshCentralClient following the resolveDeviceTarget pattern.
        // Required MeshCentral actions: see meshctrl.js for the protocol (createSession, etc.).
        createSupportSession(request) { return deferred('createSupportSession', request); },
        handoffSessionControl(request) { return deferred('handoffSessionControl', request); },
        captureSessionEvidence(request) { return deferred('captureSessionEvidence', request); },
        mapDeviceToTenantGroup(request) { return deferred('mapDeviceToTenantGroup', request); },

        /**
         * Probes the configured MeshCentral service account and returns its
         * privilege level. Callers (ops health checks, startup probes) should
         * fail or warn loudly if `isFullSiteAdmin` is true — see
         * SECURITY.AILLIUM.md §5.1 for the principle of least privilege.
         *
         * @returns {Promise<{
         *   ok: boolean,
         *   isFullSiteAdmin?: boolean,
         *   siteadmin?: number,
         *   username?: string,
         *   error?: { code: string, message: string }
         * }>}
         */
        async probeAccountPrivileges() {
            const client = getClient();
            if (!client) {
                return { ok: false, error: { code: 'MESH_CLIENT_NOT_CONFIGURED', message: 'MESHCENTRAL_URL is not set' } };
            }
            try {
                const response = await client.request({ action: 'userinfo' });
                const user = (response && response.userinfo) || response || {};
                const siteadmin = typeof user.siteadmin === 'number' ? user.siteadmin : 0;
                return {
                    ok: true,
                    isFullSiteAdmin: siteadmin === SITEADMIN_FULL,
                    siteadmin,
                    username: user.name || user._id || null
                };
            } catch (err) {
                return {
                    ok: false,
                    error: { code: 'MESH_REQUEST_FAILED', message: err && err.message ? err.message : String(err) }
                };
            }
        },

        assertLiveIntegration(operationName) {
            throw new DeferredIntegrationError(operationName);
        }
    };
}

module.exports = {
    DeferredIntegrationError,
    createMeshCentralRemoteSupportAdapter,
    MeshCentralClient
};
