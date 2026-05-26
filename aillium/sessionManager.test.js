'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionManager } = require('./sessionManager.js');

test('set and get a session', () => {
    const mgr = new SessionManager({ sweepIntervalMs: 0 });
    mgr.set('s1', { user: 'alice' });
    assert.deepEqual(mgr.get('s1'), { user: 'alice' });
    assert.equal(mgr.size, 1);
    mgr.destroy();
});

test('get returns undefined for missing session', () => {
    const mgr = new SessionManager({ sweepIntervalMs: 0 });
    assert.equal(mgr.get('nope'), undefined);
    mgr.destroy();
});

test('expired sessions are evicted on access', () => {
    const mgr = new SessionManager({ ttlMs: 1, sweepIntervalMs: 0 });
    mgr.set('s1', { user: 'bob' });
    // Force expiry by manipulating the entry
    mgr._sessions.get('s1').expiresAt = Date.now() - 1;
    assert.equal(mgr.get('s1'), undefined);
    assert.equal(mgr.size, 0);
    mgr.destroy();
});

test('has returns false for expired sessions', () => {
    const mgr = new SessionManager({ ttlMs: 1, sweepIntervalMs: 0 });
    mgr.set('s1', {});
    mgr._sessions.get('s1').expiresAt = Date.now() - 1;
    assert.equal(mgr.has('s1'), false);
    mgr.destroy();
});

test('maxSessions evicts oldest when full', () => {
    const mgr = new SessionManager({ maxSessions: 2, sweepIntervalMs: 0 });
    mgr.set('s1', { n: 1 });
    mgr.set('s2', { n: 2 });
    mgr.set('s3', { n: 3 }); // should evict s1
    assert.equal(mgr.size, 2);
    assert.equal(mgr.has('s1'), false);
    assert.equal(mgr.get('s2'), undefined === undefined ? mgr.get('s2') : undefined);
    assert.deepEqual(mgr.get('s3'), { n: 3 });
    mgr.destroy();
});

test('sweep removes all expired entries', () => {
    const mgr = new SessionManager({ ttlMs: 1, sweepIntervalMs: 0 });
    mgr.set('s1', {});
    mgr.set('s2', {});
    mgr.set('s3', {});
    for (const [, entry] of mgr._sessions) {
        entry.expiresAt = Date.now() - 1;
    }
    mgr.sweep();
    assert.equal(mgr.size, 0);
    mgr.destroy();
});

test('delete removes a session', () => {
    const mgr = new SessionManager({ sweepIntervalMs: 0 });
    mgr.set('s1', {});
    assert.equal(mgr.delete('s1'), true);
    assert.equal(mgr.size, 0);
    mgr.destroy();
});

test('get refreshes TTL on access', () => {
    const mgr = new SessionManager({ ttlMs: 100000, sweepIntervalMs: 0 });
    mgr.set('s1', { v: 1 });
    const firstExpiry = mgr._sessions.get('s1').expiresAt;
    // Simulate time passing
    mgr._sessions.get('s1').expiresAt = Date.now() + 500;
    mgr.get('s1'); // should refresh
    const newExpiry = mgr._sessions.get('s1').expiresAt;
    assert.ok(newExpiry > firstExpiry - 100000 + 500); // refreshed to ~100s from now
    mgr.destroy();
});

test('destroy clears everything', () => {
    const mgr = new SessionManager();
    mgr.set('s1', {});
    mgr.set('s2', {});
    mgr.destroy();
    assert.equal(mgr.size, 0);
});
