'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');
const {
    FencedGatewayClientError,
    buildHeaders,
    cancelFencedLineage,
    executeFencedEffect,
    postJson
} = require('./fencedGateway.client');
const { createFencedGateway, effectDigest } = require('./fencedGateway.service');
const { FileFenceStore } = require('./fencedGateway.store');

const execFileAsync = promisify(execFile);

const keys = crypto.generateKeyPairSync('ed25519');
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });

function identity(overrides) {
    return {
        tenantId: 'tenant-a',
        workOrderId: 'work-1',
        authorityType: 'agent',
        authorityId: 'department-finance',
        runId: 'run-1',
        runStepId: 'step-1',
        desktopSessionId: 'desktop-1',
        attempt: 1,
        executorId: 'desktop-executor-1',
        fenceToken: '1',
        cancellationGeneration: 0,
        ...overrides
    };
}

function signToken(executionIdentity, overrides) {
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        iss: 'aillium-core',
        aud: 'aillium-desktop',
        purpose: 'desktop-control',
        exp: Math.floor(Date.now() / 1000) + 300,
        tenant_id: executionIdentity.tenantId,
        work_order_id: executionIdentity.workOrderId,
        authority_type: executionIdentity.authorityType,
        authority_id: executionIdentity.authorityId,
        run_id: executionIdentity.runId,
        run_step_id: executionIdentity.runStepId,
        desktop_session_id: executionIdentity.desktopSessionId,
        attempt: executionIdentity.attempt,
        executor_id: executionIdentity.executorId,
        fence_token: executionIdentity.fenceToken,
        cancellation_generation: executionIdentity.cancellationGeneration,
        ...overrides
    })).toString('base64url');
    const signature = crypto.sign(null, Buffer.from(header + '.' + payload), keys.privateKey).toString('base64url');
    return header + '.' + payload + '.' + signature;
}

async function closeServer(server) {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await server.ailliumGateway.close();
}

async function startGateway(options) {
    const directory = options.directory || await fs.mkdtemp(path.join(os.tmpdir(), 'aillium-fence-test-'));
    const storePath = path.join(directory, 'fences.json');
    const store = new FileFenceStore(storePath);
    const gateway = createFencedGateway({
        corePublicKeyPem: publicKeyPem,
        store,
        executeMeshAction: options.executeMeshAction
    });
    const server = gateway.createServer();
    server.ailliumGateway = gateway;
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    return { directory, storePath, gateway, server, store, url: 'http://127.0.0.1:' + address.port };
}

function operation(overrides) {
    const executionIdentity = identity(overrides && overrides.identity);
    return {
        identity: executionIdentity,
        token: signToken(executionIdentity),
        operationId: overrides && overrides.operationId || crypto.randomUUID(),
        path: overrides && overrides.path || '/ClickMouse',
        payload: overrides && overrides.payload || { InstanceId: 'device-1', x: 12, y: 34 }
    };
}

async function rawEffectRequest(url, op, pathOverride, payloadOverride) {
    const effectPath = pathOverride || op.path;
    const payload = payloadOverride || op.payload;
    const digest = effectDigest(effectPath, payload);
    return postJson(
        url + effectPath,
        { ...payload, _ailliumExecution: { operationId: op.operationId, ...op.identity } },
        buildHeaders(op.token, op.operationId, op.identity, digest)
    );
}

async function rawPreflightRequest(url, op) {
    const digest = effectDigest(op.path, op.payload);
    return postJson(
        url + '/_aillium/fence/verify',
        {
            _ailliumExecution: { operationId: op.operationId, ...op.identity },
            effect: { path: op.path, payload: op.payload }
        },
        buildHeaders(op.token, op.operationId, op.identity, digest)
    );
}

test('failed preflight prevents every Mesh effect', async (t) => {
    let effects = 0;
    const context = await startGateway({ executeMeshAction: async () => { effects += 1; return { ok: true }; } });
    t.after(async () => { await closeServer(context.server); await fs.rm(context.directory, { recursive: true }); });
    const op = operation();
    let requests = 0;
    const corruptPreflight = async (url, body, headers) => {
        requests += 1;
        return postJson(url, body, { ...headers, 'X-Aillium-Effect-Digest': '0'.repeat(64) });
    };

    await assert.rejects(
        executeFencedEffect({ gatewayUrl: context.url, ...op, request: corruptPreflight }),
        (error) => error instanceof FencedGatewayClientError && error.code === 'MESH_PREFLIGHT_FAILED'
    );
    assert.equal(requests, 1);
    assert.equal(effects, 0);

    const unreserved = await rawEffectRequest(context.url, operation());
    assert.equal(unreserved.statusCode, 409);
    assert.equal(unreserved.body.code, 'MESH_RESERVATION_REQUIRED');
    assert.equal(effects, 0);
});

test('client and server enforce exact token, header, body, acknowledgement, and proof identity', async (t) => {
    const observed = [];
    const context = await startGateway({
        executeMeshAction: async (route, payload, headers) => {
            observed.push({ route, payload, headers });
            return { Result: 'clicked' };
        }
    });
    t.after(async () => { await closeServer(context.server); await fs.rm(context.directory, { recursive: true }); });
    const op = operation();
    const clientRequests = [];
    const recordingRequest = async (url, body, headers) => {
        clientRequests.push({ url, body, headers });
        return postJson(url, body, headers);
    };
    const result = await executeFencedEffect({ gatewayUrl: context.url, ...op, request: recordingRequest });

    assert.equal(clientRequests.length, 2);
    for (const request of clientRequests) {
        assert.equal(request.headers['X-Aillium-Desktop-Control'], op.token);
        assert.deepEqual(request.body._ailliumExecution, { operationId: op.operationId, ...op.identity });
    }
    assert.equal(observed.length, 1);
    assert.equal(observed[0].route, op.path);
    assert.deepEqual(observed[0].payload, op.payload);
    assert.equal(result.Result, 'clicked');
    assert.equal(result._ailliumProof.operationId, op.operationId);
    assert.deepEqual(result._ailliumProof.identity, op.identity);
});

test('identity mismatch and cross-tenant substitution are rejected before effect', async (t) => {
    let effects = 0;
    const context = await startGateway({ executeMeshAction: async () => { effects += 1; return { ok: true }; } });
    t.after(async () => { await closeServer(context.server); await fs.rm(context.directory, { recursive: true }); });
    const op = operation();
    const digest = effectDigest(op.path, op.payload);
    const substituted = identity({ tenantId: 'tenant-b' });
    const response = await postJson(
        context.url + '/_aillium/fence/verify',
        {
            _ailliumExecution: { operationId: op.operationId, ...substituted },
            effect: { path: op.path, payload: op.payload }
        },
        buildHeaders(op.token, op.operationId, substituted, digest)
    );
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.code, 'MESH_EXECUTION_IDENTITY_MISMATCH');
    assert.equal(effects, 0);
});

test('invalid signatures and expired Core capabilities are rejected before reservation', async (t) => {
    let effects = 0;
    const context = await startGateway({ executeMeshAction: async () => { effects += 1; return { ok: true }; } });
    t.after(async () => { await closeServer(context.server); await fs.rm(context.directory, { recursive: true }); });
    const op = operation();
    const digest = effectDigest(op.path, op.payload);
    const body = {
        _ailliumExecution: { operationId: op.operationId, ...op.identity },
        effect: { path: op.path, payload: op.payload }
    };
    const invalidSegments = op.token.split('.');
    invalidSegments[2] = Buffer.alloc(64).toString('base64url');
    const invalidSignature = await postJson(
        context.url + '/_aillium/fence/verify',
        body,
        buildHeaders(invalidSegments.join('.'), op.operationId, op.identity, digest)
    );
    assert.equal(invalidSignature.statusCode, 401);
    assert.equal(invalidSignature.body.code, 'MESH_CORE_TOKEN_INVALID');

    const expired = await postJson(
        context.url + '/_aillium/fence/verify',
        body,
        buildHeaders(
            signToken(op.identity, { exp: Math.floor(Date.now() / 1000) - 1 }),
            op.operationId,
            op.identity,
            digest
        )
    );
    assert.equal(expired.statusCode, 401);
    assert.equal(expired.body.code, 'MESH_CORE_TOKEN_EXPIRED');
    assert.equal(effects, 0);
    await assert.rejects(fs.readFile(context.storePath, 'utf8'), (error) => error.code === 'ENOENT');
});

test('client rejects stale or mismatched acknowledgement at preflight and effect boundaries', async (t) => {
    let effects = 0;
    const context = await startGateway({ executeMeshAction: async () => { effects += 1; return { ok: true }; } });
    t.after(async () => { await closeServer(context.server); await fs.rm(context.directory, { recursive: true }); });
    const op = operation();
    let calls = 0;
    const tamperingRequest = async (url, body, headers) => {
        calls += 1;
        const response = await postJson(url, body, headers);
        response.headers['x-aillium-fence-token'] = '0';
        return response;
    };
    await assert.rejects(
        executeFencedEffect({ gatewayUrl: context.url, ...op, request: tamperingRequest }),
        (error) => error.code === 'MESH_ACKNOWLEDGEMENT_MISMATCH'
    );
    assert.equal(calls, 1);
    assert.equal(effects, 0);

    const effectAckOperation = operation();
    const tamperEffectAcknowledgement = async (url, body, headers) => {
        const response = await postJson(url, body, headers);
        if (!url.endsWith('/_aillium/fence/verify')) response.headers['idempotency-key'] = 'another-operation';
        return response;
    };
    await assert.rejects(
        executeFencedEffect({
            gatewayUrl: context.url,
            ...effectAckOperation,
            request: tamperEffectAcknowledgement
        }),
        (error) => error.code === 'MESH_ACKNOWLEDGEMENT_MISMATCH'
    );
    assert.equal(effects, 1);
});

test('completed result and correlated proof replay without repeating the effect', async (t) => {
    let effects = 0;
    const context = await startGateway({
        executeMeshAction: async () => { effects += 1; return { Result: 'once', sequence: effects }; }
    });
    t.after(async () => { await closeServer(context.server); await fs.rm(context.directory, { recursive: true }); });
    const op = operation();
    const first = await executeFencedEffect({ gatewayUrl: context.url, ...op });
    const second = await executeFencedEffect({ gatewayUrl: context.url, ...op });
    assert.equal(effects, 1);
    assert.equal(first._ailliumReplay, false);
    assert.equal(second._ailliumReplay, true);
    assert.equal(second.sequence, 1);
    assert.deepEqual(second._ailliumProof, first._ailliumProof);

    const durable = JSON.parse(await fs.readFile(context.storePath, 'utf8'));
    const stored = durable.operations['tenant-a\u001f' + op.operationId];
    assert.equal(stored.operationId, op.operationId);
    assert.equal(stored.digest, effectDigest(op.path, op.payload));
    assert.equal(stored.status, 'completed');
    assert.equal(stored.result.sequence, 1);
    assert.deepEqual(stored.proof, first._ailliumProof);

    const conflict = { ...op, payload: { ...op.payload, x: 999 } };
    await assert.rejects(
        executeFencedEffect({ gatewayUrl: context.url, ...conflict }),
        (error) => error.code === 'MESH_PREFLIGHT_FAILED' && error.statusCode === 409
    );
    assert.equal(effects, 1);
});

test('durable replay survives gateway restart', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aillium-fence-restart-'));
    let effects = 0;
    const firstGateway = await startGateway({
        directory,
        executeMeshAction: async () => { effects += 1; return { Result: 'durable', sequence: effects }; }
    });
    const op = operation();
    await executeFencedEffect({ gatewayUrl: firstGateway.url, ...op });
    await closeServer(firstGateway.server);

    const restarted = await startGateway({
        directory,
        executeMeshAction: async () => { throw new Error('durable replay executed the effect twice'); }
    });
    t.after(async () => { await closeServer(restarted.server); await fs.rm(directory, { recursive: true }); });
    const replay = await executeFencedEffect({ gatewayUrl: restarted.url, ...op });
    assert.equal(effects, 1);
    assert.equal(replay.Result, 'durable');
    assert.equal(replay._ailliumReplay, true);
});

test('newer attempt, fence, and cancellation generation atomically make older work stale', async (t) => {
    let effects = 0;
    const context = await startGateway({ executeMeshAction: async () => { effects += 1; return { ok: true }; } });
    t.after(async () => { await closeServer(context.server); await fs.rm(context.directory, { recursive: true }); });
    const current = operation({ identity: { attempt: 2, fenceToken: '8', cancellationGeneration: 3 } });
    await executeFencedEffect({ gatewayUrl: context.url, ...current });

    for (const staleIdentity of [
        { attempt: 1, fenceToken: '8', cancellationGeneration: 3 },
        { attempt: 2, fenceToken: '7', cancellationGeneration: 3 },
        { attempt: 2, fenceToken: '8', cancellationGeneration: 2 }
    ]) {
        const stale = operation({ identity: staleIdentity });
        await assert.rejects(
            executeFencedEffect({ gatewayUrl: context.url, ...stale }),
            (error) => error.code === 'MESH_PREFLIGHT_FAILED' && error.statusCode === 409
        );
    }
    assert.equal(effects, 1);
});

test('concurrent store transactions cannot overwrite a newer monotonic fence', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aillium-fence-atomic-'));
    const storePath = path.join(directory, 'fences.json');
    const store = new FileFenceStore(storePath);
    t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true }); });
    const newer = identity({ attempt: 7, fenceToken: '99', cancellationGeneration: 4 });
    const older = identity({ attempt: 6, fenceToken: '98', cancellationGeneration: 3 });
    const outcomes = await Promise.allSettled([
        store.reserve(newer, 'newer-operation', 'digest-newer', new Date().toISOString()),
        store.reserve(older, 'older-operation', 'digest-older', new Date().toISOString())
    ]);
    assert.equal(outcomes[0].status, 'fulfilled');
    assert.equal(outcomes[1].status, 'rejected');
    assert.equal(outcomes[1].reason.code, 'MESH_STALE_FENCE');
    const durable = JSON.parse(await fs.readFile(storePath, 'utf8'));
    const lineage = Object.values(durable.lineages)[0];
    assert.equal(lineage.attempt, 7);
    assert.equal(lineage.fenceToken, '99');
    assert.equal(lineage.cancellationGeneration, 4);
    assert.equal(Object.keys(durable.operations).length, 1);
});

test('newer cancellation aborts and settles older upstream I/O before advancing its fence', async (t) => {
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    let upstreamAborted = false;
    let effectApplied = 0;
    const context = await startGateway({
        executeMeshAction: async (_route, _payload, _headers, signal) => {
            startedResolve();
            await new Promise((resolve, reject) => {
                const apply = () => { effectApplied += 1; resolve(); };
                const timer = setTimeout(apply, 5000);
                signal.addEventListener('abort', () => {
                    clearTimeout(timer);
                    upstreamAborted = true;
                    reject(signal.reason);
                }, { once: true });
            });
            return { ok: true };
        }
    });
    t.after(async () => { await closeServer(context.server); await fs.rm(context.directory, { recursive: true }); });
    const old = operation();
    assert.equal((await rawPreflightRequest(context.url, old)).statusCode, 200);
    const oldEffect = rawEffectRequest(context.url, old);
    await started;

    const cancellation = operation({
        identity: { cancellationGeneration: 1 },
        operationId: 'cancel-' + crypto.randomUUID()
    });
    const cancellationResponse = await cancelFencedLineage({ gatewayUrl: context.url, ...cancellation });
    assert.equal(cancellationResponse.cancelledOperationId, old.operationId);
    assert.equal(upstreamAborted, true);
    assert.equal(effectApplied, 0);

    const oldResponse = await oldEffect;
    assert.equal(oldResponse.statusCode, 409);
    assert.equal(oldResponse.body.code, 'MESH_EFFECT_ABORTED');
    const durable = JSON.parse(await fs.readFile(context.storePath, 'utf8'));
    assert.equal(durable.operations['tenant-a\u001f' + old.operationId].status, 'unknown');
    const durableCancellation = durable.operations['tenant-a\u001f' + cancellation.operationId];
    assert.equal(durableCancellation.kind, 'cancellation');
    assert.equal(durableCancellation.status, 'completed');
    assert.equal(durableCancellation.proof.status, 'cancelled');
    const current = Object.values(durable.lineages)[0];
    assert.equal(current.cancellationGeneration, 1);
    const replayedCancellation = await cancelFencedLineage({ gatewayUrl: context.url, ...cancellation });
    assert.equal(replayedCancellation._ailliumReplay, true);
    assert.equal(replayedCancellation.cancelledOperationId, old.operationId);
});

test('completed effect lineage still requires and durably records a newer cancellation', async (t) => {
    let effects = 0;
    const context = await startGateway({
        executeMeshAction: async () => { effects += 1; return { ok: true }; }
    });
    t.after(async () => { await closeServer(context.server); await fs.rm(context.directory, { recursive: true }); });
    const completed = operation();
    await executeFencedEffect({ gatewayUrl: context.url, ...completed });
    const cancellation = operation({
        identity: { cancellationGeneration: 1 },
        operationId: 'cancel-completed-' + crypto.randomUUID()
    });
    const proof = await cancelFencedLineage({ gatewayUrl: context.url, ...cancellation });
    assert.equal(proof.cancelledOperationId, null);
    assert.equal(proof._ailliumProof.status, 'cancelled');
    const durable = JSON.parse(await fs.readFile(context.storePath, 'utf8'));
    assert.equal(durable.operations['tenant-a\u001f' + cancellation.operationId].kind, 'cancellation');
    assert.equal(durable.operations['tenant-a\u001f' + cancellation.operationId].status, 'completed');
    assert.equal(Object.values(durable.lineages)[0].cancellationGeneration, 1);
    assert.equal(effects, 1);
});

test('closing the desktop client connection aborts upstream I/O and leaves UNKNOWN, not replayable', async (t) => {
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    let abortedResolve;
    const aborted = new Promise((resolve) => { abortedResolve = resolve; });
    let effectApplied = 0;
    const context = await startGateway({
        executeMeshAction: async (_route, _payload, _headers, signal) => {
            startedResolve();
            await new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => {
                    abortedResolve();
                    reject(signal.reason);
                }, { once: true });
            });
            effectApplied += 1;
            return { ok: true };
        }
    });
    t.after(async () => { await closeServer(context.server); await fs.rm(context.directory, { recursive: true }); });
    const op = operation();
    assert.equal((await rawPreflightRequest(context.url, op)).statusCode, 200);
    const digest = effectDigest(op.path, op.payload);
    const requestBody = Buffer.from(JSON.stringify({
        ...op.payload,
        _ailliumExecution: { operationId: op.operationId, ...op.identity }
    }));
    const target = new URL(context.url + op.path);
    const request = http.request(target, {
        method: 'POST',
        headers: {
            ...buildHeaders(op.token, op.operationId, op.identity, digest),
            'Content-Length': String(requestBody.length)
        }
    });
    request.on('error', () => undefined);
    request.end(requestBody);
    await started;
    request.destroy();
    await aborted;

    let stored;
    for (let attempt = 0; attempt < 50; attempt += 1) {
        stored = (await context.store.read()).operations['tenant-a\u001f' + op.operationId];
        if (stored && stored.status === 'unknown') break;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(stored.status, 'unknown');
    assert.equal(effectApplied, 0);
    let replay;
    for (let attempt = 0; attempt < 50; attempt += 1) {
        replay = await rawEffectRequest(context.url, op);
        if (replay.body.code !== 'MESH_LINEAGE_BUSY') break;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(replay.statusCode, 409);
    assert.equal(replay.body.code, 'MESH_OPERATION_INDETERMINATE');
    const nextSameFence = operation();
    await assert.rejects(
        executeFencedEffect({ gatewayUrl: context.url, ...nextSameFence }),
        (error) => error.code === 'MESH_PREFLIGHT_FAILED' && error.statusCode === 409
    );
});

test('a reservation itself becomes stale before execution when a newer fence is issued', async (t) => {
    let effects = 0;
    const context = await startGateway({ executeMeshAction: async () => { effects += 1; return { ok: true }; } });
    t.after(async () => { await closeServer(context.server); await fs.rm(context.directory, { recursive: true }); });
    const old = operation({ identity: { attempt: 1, fenceToken: '1', cancellationGeneration: 0 } });
    const oldDigest = effectDigest(old.path, old.payload);
    const oldExecution = { operationId: old.operationId, ...old.identity };
    const reserved = await postJson(
        context.url + '/_aillium/fence/verify',
        { _ailliumExecution: oldExecution, effect: { path: old.path, payload: old.payload } },
        buildHeaders(old.token, old.operationId, old.identity, oldDigest)
    );
    assert.equal(reserved.statusCode, 200);

    const newer = operation({ identity: { attempt: 2, fenceToken: '2', cancellationGeneration: 1 } });
    await executeFencedEffect({ gatewayUrl: context.url, ...newer });
    const staleEffect = await rawEffectRequest(context.url, old);
    assert.equal(staleEffect.statusCode, 409);
    assert.equal(staleEffect.body.code, 'MESH_STALE_FENCE');
    assert.equal(effects, 1);
});

test('file store enforces one writer across instances and processes', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aillium-fence-owner-'));
    t.after(async () => { await fs.rm(directory, { recursive: true }); });
    const storePath = path.join(directory, 'fences.json');
    const first = new FileFenceStore(storePath);
    await first.initialize();
    const inProcessContender = new FileFenceStore(storePath);
    await assert.rejects(
        inProcessContender.initialize(),
        (error) => error.code === 'MESH_STORE_LOCKED'
    );

    const modulePath = require.resolve('./fencedGateway.store');
    const contenderScript = `
        const { FileFenceStore } = require(process.argv[1]);
        (async () => {
            try {
                const store = new FileFenceStore(process.argv[2]);
                await store.initialize();
                await store.close();
                process.stdout.write('ACQUIRED');
            } catch (error) {
                process.stdout.write(error.code || error.message);
            }
        })();
    `;
    const blocked = await execFileAsync(process.execPath, ['-e', contenderScript, modulePath, storePath]);
    assert.equal(blocked.stdout, 'MESH_STORE_LOCKED');
    await first.close();
    const acquired = await execFileAsync(process.execPath, ['-e', contenderScript, modulePath, storePath]);
    assert.equal(acquired.stdout, 'ACQUIRED');
});

test('kernel lease admits one simultaneous writer and one successor after holder crash', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aillium-fence-lease-race-'));
    t.after(async () => { await fs.rm(directory, { recursive: true }); });
    const storePath = path.join(directory, 'fences.json');
    const modulePath = require.resolve('./fencedGateway.store');
    const contenderScript = `
        const fs = require('node:fs');
        const { FileFenceStore } = require(process.argv[1]);
        const barrier = process.argv[3];
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        (async () => {
            while (!fs.existsSync(barrier)) await wait(2);
            const store = new FileFenceStore(process.argv[2]);
            await store.initialize();
            process.stdout.write('ACQUIRED');
            await wait(300);
            await store.close();
        })().catch((error) => process.stdout.write(error.code || error.message));
    `;
    const race = async (barrierName) => {
        const barrier = path.join(directory, barrierName);
        const left = execFileAsync(process.execPath, [
            '-e',
            contenderScript,
            modulePath,
            storePath,
            barrier
        ]);
        const right = execFileAsync(process.execPath, [
            '-e',
            contenderScript,
            modulePath,
            storePath,
            barrier
        ]);
        await fs.writeFile(barrier, 'go', { flag: 'wx' });
        const outputs = (await Promise.all([left, right]))
            .map((result) => result.stdout)
            .sort();
        assert.deepEqual(outputs, ['ACQUIRED', 'MESH_STORE_LOCKED']);
    };

    await race('first-race');

    const crashHolderScript = `
        const { FileFenceStore } = require(process.argv[1]);
        (async () => {
            const store = new FileFenceStore(process.argv[2]);
            await store.initialize();
            process.stdout.write('CRASHED', () => process.exit(0));
        })().catch((error) => { console.error(error); process.exit(1); });
    `;
    const crashed = await execFileAsync(process.execPath, [
        '-e',
        crashHolderScript,
        modulePath,
        storePath
    ]);
    assert.equal(crashed.stdout, 'CRASHED');

    await race('successor-race');
});

test('file store reclaims dead main and recovery owners after recovery-process crash', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aillium-fence-recovery-crash-'));
    t.after(async () => { await fs.rm(directory, { recursive: true }); });
    const storePath = path.join(directory, 'fences.json');
    const crashDuringRecoveryScript = `
        const fs = require('node:fs');
        const crypto = require('node:crypto');
        const lockPath = process.argv[1] + '.writer.lock';
        const recoveryPath = lockPath + '.recovery';
        const mainOwner = {
            pid: process.pid,
            nonce: crypto.randomUUID(),
            createdAt: new Date().toISOString()
        };
        const recoveryOwner = {
            pid: process.pid,
            nonce: crypto.randomUUID(),
            createdAt: new Date().toISOString()
        };
        fs.writeFileSync(lockPath, JSON.stringify(mainOwner), { flag: 'wx', mode: 0o600 });
        fs.writeFileSync(recoveryPath, JSON.stringify(recoveryOwner), { flag: 'wx', mode: 0o600 });
        process.exit(0);
    `;
    await execFileAsync(process.execPath, ['-e', crashDuringRecoveryScript, storePath]);

    const recovered = new FileFenceStore(storePath);
    await recovered.initialize();
    await recovered.close();

    const files = await fs.readdir(directory);
    assert.equal(files.some((name) => name.endsWith('.writer.lock')), false);
    assert.equal(files.some((name) => name.endsWith('.writer.lock.recovery')), false);
});

test('crash restart recovers EXECUTING as UNKNOWN with no replay or temp-file loss', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aillium-fence-crash-'));
    t.after(async () => { await fs.rm(directory, { recursive: true }); });
    const storePath = path.join(directory, 'fences.json');
    const executionIdentity = identity();
    const modulePath = require.resolve('./fencedGateway.store');
    const crashScript = `
        const { FileFenceStore } = require(process.argv[1]);
        (async () => {
            const store = new FileFenceStore(process.argv[2]);
            const identity = JSON.parse(process.argv[3]);
            await store.initialize();
            await store.reserve(identity, 'crashed-operation', 'crashed-digest', new Date().toISOString());
            await store.begin(identity, 'crashed-operation', 'crashed-digest', new Date().toISOString());
            process.exit(0);
        })().catch((error) => { console.error(error); process.exit(1); });
    `;
    await execFileAsync(process.execPath, [
        '-e',
        crashScript,
        modulePath,
        storePath,
        JSON.stringify(executionIdentity)
    ]);

    const recovered = new FileFenceStore(storePath);
    await recovered.initialize();
    const durable = await recovered.read();
    const operation = durable.operations['tenant-a\u001fcrashed-operation'];
    assert.equal(operation.status, 'unknown');
    assert.equal(operation.unknownReason, 'gateway-restart-during-effect');
    await assert.rejects(
        recovered.begin(executionIdentity, 'crashed-operation', 'crashed-digest', new Date().toISOString()),
        (error) => error.code === 'MESH_OPERATION_INDETERMINATE'
    );
    const files = await fs.readdir(directory);
    assert.equal(files.some((name) => name.includes('.tmp-')), false);
    assert.equal(files.some((name) => name.endsWith('.recovery')), false);
    await recovered.close();
});

test('high-level HTTP action bridges are rejected even with valid signed identity', async (t) => {
    let effects = 0;
    const context = await startGateway({ executeMeshAction: async () => { effects += 1; return { ok: true }; } });
    t.after(async () => { await closeServer(context.server); await fs.rm(context.directory, { recursive: true }); });
    const op = operation({ path: '/agent.run', payload: { InstanceId: 'device-1', instruction: 'open payroll' } });
    const response = await rawEffectRequest(context.url, op);
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.code, 'MESH_EFFECT_UNSUPPORTED');
    assert.equal(effects, 0);
});
