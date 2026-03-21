'use strict';

class DeferredIntegrationError extends Error {
    constructor(operationName) {
        super('MeshCentral live integration for operation "' + operationName + '" is deferred.');
        this.name = 'DeferredIntegrationError';
        this.code = 'MESH_ADAPTER_DEFERRED_INTEGRATION';
        this.operationName = operationName;
    }
}

function buildEnvelope(operation, request) {
    return {
        adapter: 'aillium-remote-meshcentral',
        contractFamily: 'meshcentral-remote-support',
        operation,
        request,
        integrationStatus: 'deferred'
    };
}

function deferred(operation, request) {
    const envelope = buildEnvelope(operation, request);
    envelope.error = {
        code: 'MESH_ADAPTER_DEFERRED_INTEGRATION',
        message: 'Live MeshCentral API integration is not yet implemented for this operation.'
    };
    return envelope;
}

function createMeshCentralRemoteSupportAdapter() {
    return {
        resolveDeviceTarget(request) {
            return deferred('resolveDeviceTarget', request);
        },

        createSupportSession(request) {
            return deferred('createSupportSession', request);
        },

        handoffSessionControl(request) {
            return deferred('handoffSessionControl', request);
        },

        captureSessionEvidence(request) {
            return deferred('captureSessionEvidence', request);
        },

        mapDeviceToTenantGroup(request) {
            return deferred('mapDeviceToTenantGroup', request);
        },

        assertLiveIntegration(operationName) {
            throw new DeferredIntegrationError(operationName);
        }
    };
}

module.exports = {
    DeferredIntegrationError,
    createMeshCentralRemoteSupportAdapter
};
