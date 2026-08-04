'use strict';

const path = require('node:path');
const { FileFenceStore } = require('./fencedGateway.store');
const { createFencedGateway, defaultMeshExecutor } = require('./fencedGateway.service');

function readCorePublicKey() {
    const encoded = String(process.env.AILLIUM_DESKTOP_AUTHORITY_PUBLIC_KEY_BASE64 || '').trim();
    if (!encoded) throw new Error('AILLIUM_DESKTOP_AUTHORITY_PUBLIC_KEY_BASE64 is required');
    return Buffer.from(encoded, 'base64').toString('utf8');
}

async function startFencedGateway() {
    const upstreamUrl = String(process.env.AILLIUM_MESH_UPSTREAM_URL || '').trim();
    if (!upstreamUrl) throw new Error('AILLIUM_MESH_UPSTREAM_URL is required');
    const corePublicKeyPem = readCorePublicKey();
    const host = process.env.AILLIUM_MESH_FENCED_GATEWAY_HOST || '127.0.0.1';
    const port = Number(process.env.AILLIUM_MESH_FENCED_GATEWAY_PORT || 47910);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('AILLIUM_MESH_FENCED_GATEWAY_PORT must be a valid TCP port');
    }
    const storePath = process.env.AILLIUM_MESH_FENCE_STORE_PATH || path.join(process.cwd(), 'meshcentral-data', 'aillium-fences.json');
    const store = new FileFenceStore(storePath);
    await store.initialize();
    const gateway = createFencedGateway({
        corePublicKeyPem,
        store,
        executeMeshAction: (route, payload, headers, signal) =>
            defaultMeshExecutor(upstreamUrl, route, payload, headers, signal)
    });
    const server = gateway.createServer();
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, host, resolve);
        });
    } catch (error) {
        await gateway.close();
        throw error;
    }
    console.log('[aillium-fenced-mesh-gateway] listening on http://' + host + ':' + port);
    return { gateway, server };
}

if (require.main === module) {
    startFencedGateway().then(({ gateway, server }) => {
        const shutdown = () => {
            server.close(() => {
                gateway.close().then(() => process.exit(0), (error) => {
                    console.error(error);
                    process.exit(1);
                });
            });
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
    }).catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { startFencedGateway };
