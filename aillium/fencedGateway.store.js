'use strict';

const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');

class FenceStoreError extends Error {
    constructor(message, code, statusCode) {
        super(message);
        this.name = 'FenceStoreError';
        this.code = code;
        this.statusCode = statusCode;
    }
}

function compareUnsignedInteger(left, right) {
    const l = BigInt(left);
    const r = BigInt(right);
    return l < r ? -1 : l > r ? 1 : 0;
}

function lineageKey(identity) {
    return [
        identity.tenantId,
        identity.workOrderId,
        identity.authorityType,
        identity.authorityId,
        identity.runId,
        identity.runStepId,
        identity.desktopSessionId
    ].join('\u001f');
}

function operationKey(identity, operationId) {
    return identity.tenantId + '\u001f' + operationId;
}

function identitiesMatch(left, right) {
    return [
        'tenantId',
        'workOrderId',
        'authorityType',
        'authorityId',
        'runId',
        'runStepId',
        'desktopSessionId',
        'attempt',
        'executorId',
        'fenceToken',
        'cancellationGeneration'
    ].every((field) => String(left[field]) === String(right[field]));
}

function authorityRelation(current, identity) {
    if (!current) return 'newer';
    if (
        identity.attempt < current.attempt ||
        compareUnsignedInteger(identity.fenceToken, current.fenceToken) < 0 ||
        identity.cancellationGeneration < current.cancellationGeneration
    ) {
        throw new FenceStoreError('Execution authority is stale', 'MESH_STALE_FENCE', 409);
    }
    const same = identity.attempt === current.attempt &&
        compareUnsignedInteger(identity.fenceToken, current.fenceToken) === 0 &&
        identity.cancellationGeneration === current.cancellationGeneration;
    if (same && current.executorId && current.executorId !== identity.executorId) {
        throw new FenceStoreError('Execution fence belongs to another executor', 'MESH_EXECUTOR_CONFLICT', 409);
    }
    return same ? 'same' : 'newer';
}

function assertCurrentFence(state, identity) {
    if (authorityRelation(state.lineages[lineageKey(identity)], identity) !== 'same') {
        throw new FenceStoreError('Execution authority is stale', 'MESH_STALE_FENCE', 409);
    }
}

function assertOperationIdentity(operation, identity) {
    if (!identitiesMatch(operation.identity, identity)) {
        throw new FenceStoreError(
            'Idempotency key belongs to another execution identity',
            'MESH_OPERATION_SCOPE_CONFLICT',
            409
        );
    }
}

function syncDirectory(directory) {
    let descriptor;
    try {
        descriptor = fsSync.openSync(directory, 'r');
        fsSync.fsyncSync(descriptor);
    } finally {
        if (descriptor !== undefined) fsSync.closeSync(descriptor);
    }
}

function writeLockFile(lockPath, owner) {
    const descriptor = fsSync.openSync(lockPath, 'wx', 0o600);
    try {
        fsSync.writeFileSync(descriptor, JSON.stringify(owner));
        fsSync.fsyncSync(descriptor);
    } finally {
        fsSync.closeSync(descriptor);
    }
    syncDirectory(path.dirname(lockPath));
}

function readLockOwner(lockPath) {
    try {
        return JSON.parse(fsSync.readFileSync(lockPath, 'utf8'));
    } catch {
        return null;
    }
}

function lockedError() {
    return new FenceStoreError(
        'Fence store already has an active or unrecoverable writer owner',
        'MESH_STORE_LOCKED',
        503
    );
}

function resolveLeasePort(filePath, configuredPort) {
    const rawPort = configuredPort ?? process.env.AILLIUM_MESH_FENCE_STORE_LOCK_PORT;
    if (rawPort !== undefined && rawPort !== null && String(rawPort).trim()) {
        const port = Number(rawPort);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
            throw new FenceStoreError(
                'Fence store lock port must be an integer from 1024 through 65535',
                'MESH_STORE_LOCK_PORT_INVALID',
                500
            );
        }
        return port;
    }
    const digest = crypto.createHash('sha256').update(path.resolve(filePath)).digest();
    return 20000 + (digest.readUInt16BE(0) % 10000);
}

function acquireProcessLease(filePath, configuredPort) {
    const host = '127.0.0.1';
    const port = resolveLeasePort(filePath, configuredPort);
    return new Promise((resolve, reject) => {
        const server = net.createServer((socket) => socket.destroy());
        const onError = () => {
            server.close(() => undefined);
            reject(lockedError());
        };
        server.once('error', onError);
        server.listen({ host, port, exclusive: true }, () => {
            server.off('error', onError);
            server.on('error', () => undefined);
            resolve({ server, host, port });
        });
    });
}

function releaseProcessLease(lease) {
    if (!lease || !lease.server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
        lease.server.close((error) => error ? reject(error) : resolve());
    });
}

function acquireWriterAudit(filePath, leasePort) {
    const directory = path.dirname(filePath);
    fsSync.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lockPath = filePath + '.writer.lock';
    const recoveryPath = lockPath + '.recovery';
    const owner = {
        pid: process.pid,
        nonce: crypto.randomUUID(),
        leaseHost: '127.0.0.1',
        leasePort,
        createdAt: new Date().toISOString()
    };
    // The kernel-held loopback lease is the ownership authority. These files
    // are durable audit metadata only, so the sole lease holder may safely
    // remove records orphaned by any prior crash without a pathname CAS race.
    for (const stalePath of [recoveryPath, lockPath]) {
        try {
            fsSync.unlinkSync(stalePath);
        } catch (error) {
            if (!error || error.code !== 'ENOENT') throw error;
        }
    }
    syncDirectory(directory);
    writeLockFile(lockPath, owner);
    return { lockPath, owner };
}

class FileFenceStore {
    constructor(filePath, options = {}) {
        this.filePath = filePath;
        this.queue = Promise.resolve();
        this.closed = false;
        this.lockPath = null;
        this.lockOwner = null;
        this.processLease = null;
        this.ready = this.acquireOwnershipAndRecover(options.lockPort);
    }

    async acquireOwnershipAndRecover(configuredPort) {
        this.processLease = await acquireProcessLease(this.filePath, configuredPort);
        try {
            const lock = acquireWriterAudit(this.filePath, this.processLease.port);
            this.lockPath = lock.lockPath;
            this.lockOwner = lock.owner;
            await this.recoverExecutingOperations();
        } catch (error) {
            if (this.lockPath) {
                try {
                    this.releaseWriterLock();
                } catch {
                    // Preserve the initialization failure; the kernel lease is
                    // still released below and the audit file is non-authoritative.
                }
            }
            await releaseProcessLease(this.processLease);
            this.processLease = null;
            throw error;
        }
    }

    async initialize() {
        await this.ready;
        return this;
    }

    transaction(action) {
        if (this.closed) {
            return Promise.reject(new FenceStoreError('Fence store is closed', 'MESH_STORE_CLOSED', 503));
        }
        const run = this.queue.then(async () => {
            await this.ready;
            const state = await this.read();
            const result = await action(state);
            if (result.write) await this.write(state);
            return result.value;
        });
        this.queue = run.catch(() => undefined);
        return run;
    }

    async recoverExecutingOperations() {
        const state = await this.read();
        let changed = false;
        const recoveredAt = new Date().toISOString();
        for (const operation of Object.values(state.operations)) {
            if (operation.status === 'executing') {
                operation.status = 'unknown';
                operation.unknownAt = recoveredAt;
                operation.unknownReason = 'gateway-restart-during-effect';
                const lineage = state.lineages[lineageKey(operation.identity)];
                if (lineage) {
                    lineage.unknownOperationId = operation.operationId;
                    lineage.unknownAt = recoveredAt;
                }
                changed = true;
            }
        }
        if (changed) await this.write(state);
    }

    async read() {
        try {
            return JSON.parse(await fs.readFile(this.filePath, 'utf8'));
        } catch (error) {
            if (error && error.code === 'ENOENT') {
                return { version: 1, lineages: {}, operations: {} };
            }
            throw error;
        }
    }

    async write(state) {
        const directory = path.dirname(this.filePath);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = this.filePath + '.tmp-' + process.pid + '-' + crypto.randomUUID();
        let handle;
        let renamed = false;
        try {
            handle = await fs.open(temporary, 'wx', 0o600);
            await handle.writeFile(JSON.stringify(state));
            await handle.sync();
            await handle.close();
            handle = null;
            await fs.rename(temporary, this.filePath);
            renamed = true;
            const directoryHandle = await fs.open(directory, 'r');
            try {
                await directoryHandle.sync();
            } finally {
                await directoryHandle.close();
            }
        } finally {
            if (handle) await handle.close().catch(() => undefined);
            if (!renamed) await fs.unlink(temporary).catch((error) => {
                if (!error || error.code !== 'ENOENT') throw error;
            });
        }
    }

    assertCanAdvance(identity) {
        return this.transaction((state) => ({
            write: false,
            value: authorityRelation(state.lineages[lineageKey(identity)], identity)
        }));
    }

    advance(identity, now) {
        return this.transaction((state) => {
            const key = lineageKey(identity);
            const relation = authorityRelation(state.lineages[key], identity);
            state.lineages[key] = {
                attempt: identity.attempt,
                fenceToken: identity.fenceToken,
                cancellationGeneration: identity.cancellationGeneration,
                executorId: identity.executorId,
                updatedAt: now
            };
            return { write: relation === 'newer', value: relation };
        });
    }

    inspectCancellation(identity, operationId) {
        return this.transaction((state) => {
            const existing = state.operations[operationKey(identity, operationId)];
            if (existing) {
                assertOperationIdentity(existing, identity);
                if (existing.kind !== 'cancellation' || existing.status !== 'completed') {
                    throw new FenceStoreError(
                        'Cancellation idempotency key conflicts with another operation',
                        'MESH_IDEMPOTENCY_CONFLICT',
                        409
                    );
                }
                return { write: false, value: { replay: true, operation: existing } };
            }
            return {
                write: false,
                value: {
                    replay: false,
                    relation: authorityRelation(state.lineages[lineageKey(identity)], identity)
                }
            };
        });
    }

    completeCancellation(identity, operationId, cancelledOperationId, proof, now) {
        return this.transaction((state) => {
            const opKey = operationKey(identity, operationId);
            const existing = state.operations[opKey];
            if (existing) {
                assertOperationIdentity(existing, identity);
                if (existing.kind !== 'cancellation' || existing.status !== 'completed') {
                    throw new FenceStoreError(
                        'Cancellation idempotency key conflicts with another operation',
                        'MESH_IDEMPOTENCY_CONFLICT',
                        409
                    );
                }
                return { write: false, value: { replay: true, operation: existing } };
            }
            const key = lineageKey(identity);
            if (authorityRelation(state.lineages[key], identity) !== 'newer') {
                throw new FenceStoreError(
                    'Cancellation authority did not advance the execution lineage',
                    'MESH_CANCELLATION_NOT_NEWER',
                    409
                );
            }
            state.lineages[key] = {
                attempt: identity.attempt,
                fenceToken: identity.fenceToken,
                cancellationGeneration: identity.cancellationGeneration,
                executorId: identity.executorId,
                updatedAt: now
            };
            const operation = {
                kind: 'cancellation',
                operationId,
                identity,
                status: 'completed',
                cancelledOperationId,
                result: { accepted: true, operationId, cancelledOperationId },
                proof,
                completedAt: proof.completedAt
            };
            state.operations[opKey] = operation;
            return { write: true, value: { replay: false, operation } };
        });
    }

    reserve(identity, operationId, digest, now) {
        return this.transaction((state) => {
            const opKey = operationKey(identity, operationId);
            const existing = state.operations[opKey];
            if (existing) {
                assertOperationIdentity(existing, identity);
                if (existing.digest !== digest) {
                    throw new FenceStoreError('Idempotency key conflicts with another effect', 'MESH_IDEMPOTENCY_CONFLICT', 409);
                }
                assertCurrentFence(state, identity);
                return { write: false, value: { status: existing.status, operation: existing } };
            }

            const key = lineageKey(identity);
            const current = state.lineages[key];
            const relation = authorityRelation(current, identity);
            if (relation === 'same' && current.unknownOperationId) {
                throw new FenceStoreError(
                    'Execution lineage has an unresolved indeterminate effect',
                    'MESH_LINEAGE_INDETERMINATE',
                    409
                );
            }
            state.lineages[key] = {
                attempt: identity.attempt,
                fenceToken: identity.fenceToken,
                cancellationGeneration: identity.cancellationGeneration,
                executorId: identity.executorId,
                updatedAt: now
            };
            const operation = {
                operationId,
                digest,
                identity,
                status: 'reserved',
                reservedAt: now,
                result: null,
                proof: null
            };
            state.operations[opKey] = operation;
            return { write: true, value: { status: 'reserved', operation } };
        });
    }

    begin(identity, operationId, digest, now) {
        return this.transaction((state) => {
            const operation = state.operations[operationKey(identity, operationId)];
            if (!operation || operation.digest !== digest) {
                throw new FenceStoreError('Effect has no matching durable reservation', 'MESH_RESERVATION_REQUIRED', 409);
            }
            assertOperationIdentity(operation, identity);
            assertCurrentFence(state, identity);
            const current = state.lineages[lineageKey(identity)];
            if (current.unknownOperationId && current.unknownOperationId !== operationId) {
                throw new FenceStoreError(
                    'Execution lineage has an unresolved indeterminate effect',
                    'MESH_LINEAGE_INDETERMINATE',
                    409
                );
            }
            if (operation.status === 'completed') {
                return { write: false, value: { replay: true, operation } };
            }
            if (operation.status !== 'reserved') {
                throw new FenceStoreError('Effect state is indeterminate and cannot be replayed', 'MESH_OPERATION_INDETERMINATE', 409);
            }
            operation.status = 'executing';
            operation.startedAt = now;
            return { write: true, value: { replay: false, operation } };
        });
    }

    markUnknown(identity, operationId, digest, reason, now) {
        return this.transaction((state) => {
            const operation = state.operations[operationKey(identity, operationId)];
            if (!operation || operation.digest !== digest || operation.status !== 'executing') {
                throw new FenceStoreError('Unknown effect does not match an executing reservation', 'MESH_COMPLETION_CONFLICT', 409);
            }
            assertOperationIdentity(operation, identity);
            assertCurrentFence(state, identity);
            operation.status = 'unknown';
            operation.unknownAt = now;
            operation.unknownReason = reason;
            state.lineages[lineageKey(identity)].unknownOperationId = operationId;
            state.lineages[lineageKey(identity)].unknownAt = now;
            return { write: true, value: operation };
        });
    }

    complete(identity, operationId, digest, result, proof) {
        return this.transaction((state) => {
            const operation = state.operations[operationKey(identity, operationId)];
            if (!operation || operation.digest !== digest || operation.status !== 'executing') {
                throw new FenceStoreError('Effect completion does not match its reservation', 'MESH_COMPLETION_CONFLICT', 409);
            }
            assertOperationIdentity(operation, identity);
            assertCurrentFence(state, identity);
            operation.status = 'completed';
            operation.result = result;
            operation.proof = proof;
            operation.completedAt = proof.completedAt;
            return { write: true, value: operation };
        });
    }

    async close() {
        if (this.closed) return;
        this.closed = true;
        try {
            await this.ready;
            await this.queue;
            this.releaseWriterLock();
        } finally {
            await releaseProcessLease(this.processLease);
            this.processLease = null;
        }
    }

    releaseWriterLock() {
        if (!this.lockPath) return;
        const owner = readLockOwner(this.lockPath);
        if (!owner || !this.lockOwner || owner.nonce !== this.lockOwner.nonce) {
            throw new FenceStoreError('Fence store writer ownership was lost', 'MESH_STORE_LOCK_LOST', 503);
        }
        fsSync.unlinkSync(this.lockPath);
        syncDirectory(path.dirname(this.lockPath));
        this.lockPath = null;
        this.lockOwner = null;
    }
}

module.exports = {
    FenceStoreError,
    FileFenceStore,
    authorityRelation,
    identitiesMatch,
    lineageKey,
    operationKey
};
