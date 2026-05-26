'use strict';

const crypto = require('node:crypto');
const { createMeshCentralRemoteSupportAdapter } = require('./meshcentralRemoteSupportAdapter.service.js');

const MAX_BODY_BYTES = 64 * 1024; // 64 KB

function timingSafeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) {
        crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                req.destroy();
                reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (size === 0) { resolve({}); return; }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (_e) {
                reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
    });
    res.end(payload);
}

/**
 * Creates an HTTP request handler for Aillium adapter operations.
 *
 * @param {object} options
 * @param {string} options.token - Required bearer token. Server refuses to start without it.
 * @param {object} [options.adapterOptions] - Passed to createMeshCentralRemoteSupportAdapter.
 * @returns {function(req, res): void}
 */
function createHttpApi(options = {}) {
    if (!options.token || typeof options.token !== 'string' || options.token.length < 16) {
        throw new Error(
            'AILLIUM_ADAPTER_TOKEN is required and must be >= 16 characters. ' +
            'Refusing to start without a valid API token.'
        );
    }

    const expectedToken = options.token;
    const adapter = createMeshCentralRemoteSupportAdapter(options.adapterOptions || {});

    const routes = {
        '/aillium/resolve-device-target': 'resolveDeviceTarget',
        '/aillium/create-support-session': 'createSupportSession',
        '/aillium/handoff-session-control': 'handoffSessionControl',
        '/aillium/capture-session-evidence': 'captureSessionEvidence',
        '/aillium/map-device-to-tenant-group': 'mapDeviceToTenantGroup'
    };

    return async function handleRequest(req, res) {
        if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'Method not allowed' });
            return;
        }

        const authHeader = req.headers['authorization'] || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (!token || !timingSafeEqual(token, expectedToken)) {
            sendJson(res, 401, { error: 'Unauthorized' });
            return;
        }

        const url = new URL(req.url, 'http://localhost');
        const operationName = routes[url.pathname];
        if (!operationName) {
            sendJson(res, 404, { error: 'Not found' });
            return;
        }

        let body;
        try {
            body = await parseJsonBody(req);
        } catch (err) {
            sendJson(res, err.statusCode || 400, { error: err.message });
            return;
        }

        try {
            const result = await adapter[operationName](body);
            const status = result.integrationStatus === 'ok' ? 200
                : result.integrationStatus === 'deferred' ? 501
                : result.integrationStatus === 'failed' ? 422
                : 502;
            sendJson(res, status, result);
        } catch (err) {
            sendJson(res, 500, {
                adapter: 'aillium-remote-meshcentral',
                operation: operationName,
                integrationStatus: 'error',
                error: { code: 'INTERNAL_ERROR', message: 'Internal server error' }
            });
        }
    };
}

module.exports = { createHttpApi, timingSafeEqual };
