'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { FenceStoreError, lineageKey } = require('./fencedGateway.store');

const EFFECT_ROUTES = new Set([
    '/GetScreenSize',
    '/TakeScreenshot',
    '/TypeText',
    '/PressKey',
    '/ClickMouse',
    '/DragMouse',
    '/Scroll'
]);

const IDENTITY_HEADERS = {
    operationId: 'x-aillium-operation-id',
    tenantId: 'x-aillium-tenant-id',
    workOrderId: 'x-aillium-work-order-id',
    authorityType: 'x-aillium-authority-type',
    authorityId: 'x-aillium-authority-id',
    runId: 'x-aillium-run-id',
    runStepId: 'x-aillium-run-step-id',
    desktopSessionId: 'x-aillium-desktop-session-id',
    attempt: 'x-aillium-attempt',
    executorId: 'x-aillium-executor-id',
    fenceToken: 'x-aillium-fence-token',
    cancellationGeneration: 'x-aillium-cancellation-generation'
};

class GatewayError extends Error {
    constructor(message, code, statusCode) {
        super(message);
        this.name = 'GatewayError';
        this.code = code;
        this.statusCode = statusCode;
    }
}

function decodeBase64Url(value) {
    return Buffer.from(value, 'base64url');
}

function claim(payload, snake, camel) {
    return payload[snake] ?? payload[camel];
}

function verifyCoreToken(token, publicKeyPem, nowSeconds) {
    const segments = String(token || '').split('.');
    if (segments.length !== 3) throw new GatewayError('Signed Core token is required', 'MESH_CORE_TOKEN_INVALID', 401);
    let header;
    let payload;
    try {
        header = JSON.parse(decodeBase64Url(segments[0]).toString('utf8'));
        payload = JSON.parse(decodeBase64Url(segments[1]).toString('utf8'));
    } catch {
        throw new GatewayError('Signed Core token is malformed', 'MESH_CORE_TOKEN_INVALID', 401);
    }
    if (header.alg !== 'EdDSA') throw new GatewayError('Core token algorithm is invalid', 'MESH_CORE_TOKEN_INVALID', 401);
    const valid = crypto.verify(
        null,
        Buffer.from(segments[0] + '.' + segments[1]),
        crypto.createPublicKey(publicKeyPem),
        decodeBase64Url(segments[2])
    );
    const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!valid || payload.iss !== 'aillium-core' || !audience.includes('aillium-desktop') || payload.purpose !== 'desktop-control') {
        throw new GatewayError('Core token signature or scope is invalid', 'MESH_CORE_TOKEN_INVALID', 401);
    }
    if (!Number.isInteger(payload.exp) || payload.exp <= nowSeconds) {
        throw new GatewayError('Core token has expired', 'MESH_CORE_TOKEN_EXPIRED', 401);
    }
    const identity = {
        tenantId: claim(payload, 'tenant_id', 'tenantId'),
        workOrderId: claim(payload, 'work_order_id', 'workOrderId'),
        authorityType: claim(payload, 'authority_type', 'authorityType'),
        authorityId: claim(payload, 'authority_id', 'authorityId'),
        runId: claim(payload, 'run_id', 'runId'),
        runStepId: claim(payload, 'run_step_id', 'runStepId'),
        desktopSessionId: claim(payload, 'desktop_session_id', 'desktopSessionId'),
        attempt: payload.attempt,
        executorId: claim(payload, 'executor_id', 'executorId'),
        fenceToken: String(claim(payload, 'fence_token', 'fenceToken') ?? ''),
        cancellationGeneration: claim(payload, 'cancellation_generation', 'cancellationGeneration')
    };
    if (
        !identity.tenantId || !identity.workOrderId ||
        !['user', 'agent'].includes(identity.authorityType) || !identity.authorityId ||
        !identity.runId || !identity.runStepId || !identity.desktopSessionId ||
        !Number.isInteger(identity.attempt) || identity.attempt < 1 || !identity.executorId ||
        !/^(0|[1-9]\d*)$/.test(identity.fenceToken) ||
        !Number.isInteger(identity.cancellationGeneration) || identity.cancellationGeneration < 0
    ) {
        throw new GatewayError('Core token execution scope is incomplete', 'MESH_CORE_TOKEN_INVALID', 401);
    }
    return identity;
}

function canonicalJson(value) {
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    if (value && typeof value === 'object') {
        return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
}

function effectDigest(path, payload) {
    return crypto.createHash('sha256').update(canonicalJson({ path, payload })).digest('hex');
}

function headerValue(headers, name) {
    const value = headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
}

function authenticate(headers, body, publicKeyPem, nowSeconds) {
    const token = headerValue(headers, 'x-aillium-desktop-control');
    const identity = verifyCoreToken(token, publicKeyPem, nowSeconds);
    const operationId = headerValue(headers, IDENTITY_HEADERS.operationId);
    if (!operationId || headerValue(headers, 'idempotency-key') !== operationId) {
        throw new GatewayError('Exact operation idempotency identity is required', 'MESH_IDEMPOTENCY_REQUIRED', 400);
    }
    const execution = body && body._ailliumExecution;
    const expected = { operationId, ...identity };
    for (const [field, expectedValue] of Object.entries(expected)) {
        const headerName = IDENTITY_HEADERS[field];
        const header = headerName ? headerValue(headers, headerName) : undefined;
        if ((headerName && String(header) !== String(expectedValue)) || String(execution?.[field]) !== String(expectedValue)) {
            throw new GatewayError('Token, header, and body execution identity mismatch: ' + field, 'MESH_EXECUTION_IDENTITY_MISMATCH', 403);
        }
    }
    return { identity, operationId };
}

function acknowledgementHeaders(operationId, identity, digest) {
    const values = { operationId, ...identity };
    const headers = { 'Idempotency-Key': operationId };
    if (digest !== undefined) headers['X-Aillium-Effect-Digest'] = digest;
    for (const [field, name] of Object.entries(IDENTITY_HEADERS)) headers[name] = String(values[field]);
    return headers;
}

function deferred() {
    let resolve;
    const promise = new Promise((settle) => { resolve = settle; });
    return { promise, resolve };
}

function createFencedGateway(options) {
    const { corePublicKeyPem, store, executeMeshAction } = options;
    const now = options.now || (() => Date.now());
    const lineageQueues = new Map();
    const activeEffects = new Map();
    if (!corePublicKeyPem) throw new Error('corePublicKeyPem is required');

    function withLineage(identity, action) {
        const key = lineageKey(identity);
        const previous = lineageQueues.get(key) || Promise.resolve();
        const run = previous.catch(() => undefined).then(action);
        const tail = run.catch(() => undefined);
        lineageQueues.set(key, tail);
        return run.finally(() => {
            if (lineageQueues.get(key) === tail) lineageQueues.delete(key);
        });
    }

    async function abortActiveEffect(active, reason) {
        if (!active.controller.signal.aborted) active.controller.abort(reason);
        await active.settled;
    }

    function linkAbortSignal(source, target) {
        if (!source) return () => undefined;
        const abort = () => {
            if (!target.signal.aborted) target.abort(source.reason || new Error('Desktop client disconnected'));
        };
        if (source.aborted) abort();
        else source.addEventListener('abort', abort, { once: true });
        return () => source.removeEventListener('abort', abort);
    }

    async function dispatch(request) {
        const nowMs = now();
        const auth = authenticate(request.headers, request.body, corePublicKeyPem, Math.floor(nowMs / 1000));
        if (request.path === '/_aillium/fence/cancel') {
            const result = await withLineage(auth.identity, async () => {
                const inspected = await store.inspectCancellation(auth.identity, auth.operationId);
                if (inspected.replay) return inspected;
                if (inspected.relation !== 'newer') {
                    throw new GatewayError(
                        'Cancellation must advance attempt, fence, or cancellation generation',
                        'MESH_CANCELLATION_NOT_NEWER',
                        409
                    );
                }
                const active = activeEffects.get(lineageKey(auth.identity));
                if (active) {
                    await abortActiveEffect(
                        active,
                        new GatewayError('Effect superseded by newer cancellation authority', 'MESH_EFFECT_ABORTED', 409)
                    );
                }
                const completedAt = new Date(now()).toISOString();
                const proof = {
                    operationId: auth.operationId,
                    identity: auth.identity,
                    completedAt,
                    status: 'cancelled'
                };
                return store.completeCancellation(
                    auth.identity,
                    auth.operationId,
                    active ? active.operationId : null,
                    proof,
                    completedAt
                );
            });
            const operation = result.operation;
            return {
                statusCode: 200,
                headers: acknowledgementHeaders(auth.operationId, auth.identity),
                body: {
                    ...operation.result,
                    _ailliumProof: operation.proof,
                    _ailliumReplay: result.replay
                }
            };
        }
        if (request.path === '/_aillium/fence/verify') {
            const effect = request.body.effect;
            if (!effect || !EFFECT_ROUTES.has(effect.path) || !effect.payload || typeof effect.payload !== 'object') {
                throw new GatewayError('A supported effect is required for reservation', 'MESH_EFFECT_UNSUPPORTED', 400);
            }
            const digest = effectDigest(effect.path, effect.payload);
            if (headerValue(request.headers, 'x-aillium-effect-digest') !== digest) {
                throw new GatewayError('Effect digest does not match reservation', 'MESH_EFFECT_DIGEST_MISMATCH', 403);
            }
            const reservation = await withLineage(auth.identity, async () => {
                const relation = await store.assertCanAdvance(auth.identity);
                const active = activeEffects.get(lineageKey(auth.identity));
                if (active && relation === 'newer') {
                    await abortActiveEffect(
                        active,
                        new GatewayError('Effect superseded by newer execution authority', 'MESH_EFFECT_ABORTED', 409)
                    );
                }
                return store.reserve(auth.identity, auth.operationId, digest, new Date(now()).toISOString());
            });
            return {
                statusCode: 200,
                headers: acknowledgementHeaders(auth.operationId, auth.identity, digest),
                body: { accepted: true, status: reservation.status, operationId: auth.operationId, digest }
            };
        }

        if (!EFFECT_ROUTES.has(request.path)) {
            throw new GatewayError('Gateway route is not an allowlisted Mesh effect', 'MESH_EFFECT_UNSUPPORTED', 404);
        }
        const payload = { ...request.body };
        delete payload._ailliumExecution;
        const digest = effectDigest(request.path, payload);
        if (headerValue(request.headers, 'x-aillium-effect-digest') !== digest) {
            throw new GatewayError('Effect digest does not match request', 'MESH_EFFECT_DIGEST_MISMATCH', 403);
        }
        let active;
        const claimResult = await withLineage(auth.identity, async () => {
            if (activeEffects.has(lineageKey(auth.identity))) {
                throw new GatewayError('Another effect owns this execution lineage', 'MESH_LINEAGE_BUSY', 409);
            }
            const claimed = await store.begin(auth.identity, auth.operationId, digest, new Date(now()).toISOString());
            if (!claimed.replay) {
                const completion = deferred();
                active = {
                    operationId: auth.operationId,
                    identity: auth.identity,
                    controller: new AbortController(),
                    settled: completion.promise,
                    settle: completion.resolve
                };
                activeEffects.set(lineageKey(auth.identity), active);
            }
            return claimed;
        });
        if (claimResult.replay) {
            return {
                statusCode: 200,
                headers: acknowledgementHeaders(auth.operationId, auth.identity, digest),
                body: { ...claimResult.operation.result, _ailliumProof: claimResult.operation.proof, _ailliumReplay: true }
            };
        }
        const unlinkRequestAbort = linkAbortSignal(request.signal, active.controller);
        try {
            const result = await executeMeshAction(request.path, payload, request.headers, active.controller.signal);
            if (active.controller.signal.aborted) {
                throw active.controller.signal.reason || new GatewayError('Effect was aborted', 'MESH_EFFECT_ABORTED', 409);
            }
            const proof = {
                operationId: auth.operationId,
                digest,
                identity: auth.identity,
                completedAt: new Date(now()).toISOString(),
                status: 'completed'
            };
            await store.complete(auth.identity, auth.operationId, digest, result, proof);
            return {
                statusCode: 200,
                headers: acknowledgementHeaders(auth.operationId, auth.identity, digest),
                body: { ...result, _ailliumProof: proof, _ailliumReplay: false }
            };
        } catch (error) {
            const aborted = active.controller.signal.aborted;
            await store.markUnknown(
                auth.identity,
                auth.operationId,
                digest,
                aborted ? 'effect-aborted-before-durable-completion' : 'upstream-error-before-durable-completion',
                new Date(now()).toISOString()
            );
            if (aborted) {
                throw new GatewayError('Mesh effect was aborted before completion', 'MESH_EFFECT_ABORTED', 409);
            }
            throw error;
        } finally {
            unlinkRequestAbort();
            if (activeEffects.get(lineageKey(auth.identity)) === active) activeEffects.delete(lineageKey(auth.identity));
            active.settle();
        }
    }

    async function handler(req, res) {
        const requestAbort = new AbortController();
        const abortRequest = () => {
            if (!requestAbort.signal.aborted) requestAbort.abort(new Error('Desktop client disconnected'));
        };
        req.once('aborted', abortRequest);
        res.once('close', () => {
            if (!res.writableEnded) abortRequest();
        });
        try {
            if (req.method !== 'POST') throw new GatewayError('Method Not Allowed', 'METHOD_NOT_ALLOWED', 405);
            const chunks = [];
            let size = 0;
            for await (const chunk of req) {
                size += chunk.length;
                if (size > 1024 * 1024) throw new GatewayError('Request body is too large', 'BODY_TOO_LARGE', 413);
                chunks.push(chunk);
            }
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            const result = await dispatch({
                method: req.method,
                path: req.url.split('?')[0],
                headers: req.headers,
                body,
                signal: requestAbort.signal
            });
            if (requestAbort.signal.aborted || res.destroyed) return;
            res.writeHead(result.statusCode, { 'Content-Type': 'application/json', ...result.headers });
            res.end(JSON.stringify(result.body));
        } catch (error) {
            if (requestAbort.signal.aborted || res.destroyed) return;
            const known = error instanceof GatewayError || error instanceof FenceStoreError;
            res.writeHead(known ? error.statusCode : 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message, code: known ? error.code : 'MESH_GATEWAY_ERROR' }));
        }
    }

    async function close() {
        const effects = Array.from(activeEffects.values());
        for (const active of effects) {
            if (!active.controller.signal.aborted) active.controller.abort(new Error('Gateway is closing'));
        }
        await Promise.all(effects.map((active) => active.settled));
        await store.close();
    }

    return { close, dispatch, handler, createServer: () => http.createServer(handler) };
}

async function defaultMeshExecutor(upstreamUrl, route, payload, headers, signal) {
    const body = Buffer.from(JSON.stringify(payload));
    const target = new URL(upstreamUrl.replace(/\/$/, '') + route);
    return new Promise((resolve, reject) => {
        const request = (target.protocol === 'https:' ? https : http).request(target, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': String(body.length),
                Authorization: headerValue(headers, 'authorization') || '',
                'X-Device-Id': headerValue(headers, 'x-device-id') || '',
                'X-Timestamp': headerValue(headers, 'x-timestamp') || ''
            }
        }, (response) => {
            const chunks = [];
            let size = 0;
            response.on('data', (chunk) => {
                size += chunk.length;
                if (size > 10 * 1024 * 1024) {
                    request.destroy(new GatewayError('Mesh upstream response is too large', 'MESH_UPSTREAM_FAILED', 502));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => {
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    reject(new GatewayError(
                        'Mesh upstream failed with status ' + response.statusCode,
                        'MESH_UPSTREAM_FAILED',
                        502
                    ));
                    return;
                }
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
                } catch {
                    reject(new GatewayError('Mesh upstream returned invalid JSON', 'MESH_UPSTREAM_FAILED', 502));
                }
            });
        });
        request.setTimeout(30000, () => request.destroy(new Error('Mesh upstream timed out')));
        const abort = () => request.destroy(signal.reason || new Error('Mesh effect aborted'));
        if (signal) {
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
        }
        request.on('error', (error) => {
            reject(error instanceof GatewayError ? error : new GatewayError(error.message, 'MESH_UPSTREAM_FAILED', 502));
        });
        request.on('close', () => {
            if (signal) signal.removeEventListener('abort', abort);
        });
        request.end(body);
    });
}

module.exports = {
    EFFECT_ROUTES,
    GatewayError,
    acknowledgementHeaders,
    canonicalJson,
    createFencedGateway,
    defaultMeshExecutor,
    effectDigest,
    verifyCoreToken
};
