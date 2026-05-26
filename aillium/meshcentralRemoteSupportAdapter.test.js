'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMeshCentralRemoteSupportAdapter } = require('./meshcentralRemoteSupportAdapter.service.js');

// Fake client that mimics the MeshCentralClient interface
function makeFakeClient(responses) {
    const calls = [];
    return {
        calls,
        async request(payload) {
            calls.push(payload);
            if (typeof responses === 'function') return responses(payload);
            return responses;
        },
        close() {}
    };
}

test('resolveDeviceTarget returns deferred when MESHCENTRAL_URL is not set', async () => {
    const adapter = createMeshCentralRemoteSupportAdapter({ env: {} });
    const result = await adapter.resolveDeviceTarget({ device_id: 'dev-1' });
    assert.equal(result.integrationStatus, 'deferred');
    assert.equal(result.error.code, 'MESH_ADAPTER_DEFERRED_INTEGRATION');
});

test('resolveDeviceTarget returns matched node when device_id matches by _id', async () => {
    const fakeClient = makeFakeClient({
        nodes: {
            'mesh-A': [{ _id: 'node-xyz', name: 'laptop-1' }]
        }
    });
    const adapter = createMeshCentralRemoteSupportAdapter({ client: fakeClient });
    const result = await adapter.resolveDeviceTarget({ device_id: 'node-xyz' });
    assert.equal(result.integrationStatus, 'ok');
    assert.deepEqual(result.result, { node_id: 'node-xyz', mesh_id: 'mesh-A', name: 'laptop-1' });
    assert.equal(fakeClient.calls.length, 1);
    assert.equal(fakeClient.calls[0].action, 'nodes');
});

test('resolveDeviceTarget matches by node name as fallback', async () => {
    const fakeClient = makeFakeClient({
        nodes: { 'mesh-A': [{ _id: 'node-1', name: 'laptop-1' }] }
    });
    const adapter = createMeshCentralRemoteSupportAdapter({ client: fakeClient });
    const result = await adapter.resolveDeviceTarget({ device_id: 'laptop-1' });
    assert.equal(result.integrationStatus, 'ok');
    assert.equal(result.result.node_id, 'node-1');
});

test('resolveDeviceTarget reports DEVICE_NOT_FOUND when no match', async () => {
    const fakeClient = makeFakeClient({ nodes: { 'mesh-A': [{ _id: 'other' }] } });
    const adapter = createMeshCentralRemoteSupportAdapter({ client: fakeClient });
    const result = await adapter.resolveDeviceTarget({ device_id: 'missing' });
    assert.equal(result.integrationStatus, 'failed');
    assert.equal(result.error.code, 'DEVICE_NOT_FOUND');
});

test('resolveDeviceTarget surfaces client errors as MESH_REQUEST_FAILED', async () => {
    const fakeClient = {
        async request() { throw new Error('connection refused'); },
        close() {}
    };
    const adapter = createMeshCentralRemoteSupportAdapter({ client: fakeClient });
    const result = await adapter.resolveDeviceTarget({ device_id: 'x' });
    assert.equal(result.integrationStatus, 'error');
    assert.equal(result.error.code, 'MESH_REQUEST_FAILED');
    assert.match(result.error.message, /connection refused/);
});

test('other operations remain deferred (will be implemented incrementally)', () => {
    const adapter = createMeshCentralRemoteSupportAdapter({ env: {} });
    for (const op of ['createSupportSession', 'handoffSessionControl', 'captureSessionEvidence', 'mapDeviceToTenantGroup']) {
        const result = adapter[op]({});
        assert.equal(result.integrationStatus, 'deferred');
    }
});
