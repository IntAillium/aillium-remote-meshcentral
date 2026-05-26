'use strict';

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_SESSIONS = 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000; // 1 minute

class SessionManager {
    /**
     * @param {object} [options]
     * @param {number} [options.ttlMs=1800000] - Session TTL in milliseconds
     * @param {number} [options.maxSessions=1000] - Maximum concurrent sessions
     * @param {number} [options.sweepIntervalMs=60000] - Interval between TTL sweeps
     */
    constructor(options = {}) {
        this._ttlMs = options.ttlMs || DEFAULT_TTL_MS;
        this._maxSessions = options.maxSessions || DEFAULT_MAX_SESSIONS;
        this._sessions = new Map();
        this._sweepTimer = null;

        if (options.sweepIntervalMs !== 0) {
            const interval = options.sweepIntervalMs || DEFAULT_SWEEP_INTERVAL_MS;
            this._sweepTimer = setInterval(() => this.sweep(), interval);
            if (this._sweepTimer.unref) this._sweepTimer.unref();
        }
    }

    get size() {
        return this._sessions.size;
    }

    has(sessionId) {
        const entry = this._sessions.get(sessionId);
        if (!entry) return false;
        if (Date.now() > entry.expiresAt) {
            this._sessions.delete(sessionId);
            return false;
        }
        return true;
    }

    get(sessionId) {
        const entry = this._sessions.get(sessionId);
        if (!entry) return undefined;
        if (Date.now() > entry.expiresAt) {
            this._sessions.delete(sessionId);
            return undefined;
        }
        entry.expiresAt = Date.now() + this._ttlMs;
        return entry.data;
    }

    set(sessionId, data) {
        if (this._sessions.size >= this._maxSessions && !this._sessions.has(sessionId)) {
            this._evictOldest();
        }
        this._sessions.set(sessionId, {
            data,
            createdAt: Date.now(),
            expiresAt: Date.now() + this._ttlMs
        });
    }

    delete(sessionId) {
        return this._sessions.delete(sessionId);
    }

    sweep() {
        const now = Date.now();
        for (const [id, entry] of this._sessions) {
            if (now > entry.expiresAt) {
                this._sessions.delete(id);
            }
        }
    }

    _evictOldest() {
        let oldestId = null;
        let oldestTime = Infinity;
        for (const [id, entry] of this._sessions) {
            if (entry.createdAt < oldestTime) {
                oldestTime = entry.createdAt;
                oldestId = id;
            }
        }
        if (oldestId != null) {
            this._sessions.delete(oldestId);
        }
    }

    destroy() {
        if (this._sweepTimer) {
            clearInterval(this._sweepTimer);
            this._sweepTimer = null;
        }
        this._sessions.clear();
    }
}

module.exports = { SessionManager };
