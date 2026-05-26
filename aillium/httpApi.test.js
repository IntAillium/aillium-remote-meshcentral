'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHttpApi, timingSafeEqual } = require('./httpApi.js');

const VALID_TOKEN = 'test-token-at-least-16-chars';

function makeRequest(server, path, options = {}) {
    return new Promise((resolve, reject) => {
        const addr = server.address();
        const reqOptions = {
            hostname: '127.0.0.1',
            port: addr.port,
            path,
            method: options.method || 'POST',
            headers: {
                'Authorization': options.token !== undefined ? `Bearer ${options.token}` : `Bearer ${VALID_TOKEN}`,
                'Content-Type': 'application/json',
                ...options.headers
            }
        };
        const req = http.request(reqOptions, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
                catch (_) { resolve({ status: res.statusCode, body }); }
            });
        });
        req.on('error', reject);
        if (options.body) req.write(JSON.stringify(options.body));
        req.end();
    });
}

function startServer(handler) {
    return new Promise((resolve) => {
        const srv = http.createServer(handler);
        srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
}

test('createHttpApi throws without a token', () => {
    assert.throws(() => createHttpApi(), /AILLIUM_ADAPTER_TOKEN is required/);
    assert.throws(() => createHttpApi({ token: 'short' }), />= 16 characters/);
});

test('rejects requests without auth', async () => {
    const handler = createHttpApi({
        token: VALID_TOKEN,
        adapterOptions: { env: {} }
    });
    const server = await startServer(handler);
    try {
        const res = await makeRequest(server, '/aillium/resolve-device-target', {
            token: '', body: { device_id: 'x' }
        });
        assert.equal(res.status, 401);
    } finally {
        server.close();
    }
});

test('rejects requests with wrong token (timing-safe)', async () => {
    const handler = createHttpApi({
        token: VALID_TOKEN,
        adapterOptions: { env: {} }
    });
    const server = await startServer(handler);
    try {
        const res = await makeRequest(server, '/aillium/resolve-device-target', {
            token: 'wrong-token-but-same-len!', body: { device_id: 'x' }
        });
        assert.equal(res.status, 401);
    } finally {
        server.close();
    }
});

test('rejects non-POST methods', async () => {
    const handler = createHttpApi({
        token: VALID_TOKEN,
        adapterOptions: { env: {} }
    });
    const server = await startServer(handler);
    try {
        const res = await makeRequest(server, '/aillium/resolve-device-target', {
            method: 'GET'
        });
        assert.equal(res.status, 405);
    } finally {
        server.close();
    }
});

test('returns 404 for unknown routes', async () => {
    const handler = createHttpApi({
        token: VALID_TOKEN,
        adapterOptions: { env: {} }
    });
    const server = await startServer(handler);
    try {
        const res = await makeRequest(server, '/unknown', { body: {} });
        assert.equal(res.status, 404);
    } finally {
        server.close();
    }
});

test('returns 501 for deferred operations', async () => {
    const handler = createHttpApi({
        token: VALID_TOKEN,
        adapterOptions: { env: {} }
    });
    const server = await startServer(handler);
    try {
        const res = await makeRequest(server, '/aillium/resolve-device-target', {
            body: { device_id: 'dev-1' }
        });
        assert.equal(res.status, 501);
        assert.equal(res.body.integrationStatus, 'deferred');
    } finally {
        server.close();
    }
});

test('timingSafeEqual returns true for matching strings', () => {
    assert.equal(timingSafeEqual('abc', 'abc'), true);
});

test('timingSafeEqual returns false for non-matching strings', () => {
    assert.equal(timingSafeEqual('abc', 'xyz'), false);
});

test('timingSafeEqual returns false for different-length strings', () => {
    assert.equal(timingSafeEqual('short', 'longer-string'), false);
});
