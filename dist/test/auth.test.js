import assert from 'node:assert/strict';
import test from 'node:test';
import { CursorAuth } from '../lib/auth.js';
function credentials() {
    const records = new Map();
    return {
        records,
        async readRecord(key) {
            return records.get(key);
        },
        async modifyRecord(key, mutate) {
            const next = await mutate(records.get(key));
            if (next !== undefined)
                records.set(key, next);
        },
        async deleteRecord(key) {
            records.delete(key);
        },
    };
}
function sdk({ login, me, } = {}) {
    return {
        Cursor: {
            auth: {
                login: login ?? (async (options) => {
                    options.onLoginUrl?.('https://cursor.test/login');
                    return { apiKey: 'key-1', email: 'user@example.com', apiKeyExpiresAtMs: Date.now() + 60_000 };
                }),
                logout: async () => { },
                status: async () => ({ status: 'logged-in' }),
            },
            me: me ?? (async () => ({ userEmail: 'user@example.com' })),
        },
    };
}
const waitFor = async (predicate) => {
    for (let index = 0; index < 100; index += 1) {
        const value = await predicate();
        if (value)
            return value;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('condition not met');
};
test('auth reports signed-out and env fallback without a record', async () => {
    const store = credentials();
    const auth = new CursorAuth({ credentials: store, loadSdk: async () => sdk(), env: { CURSOR_API_KEY: 'env-key' } });
    const status = await auth.status();
    assert.equal(status.configured, true);
    assert.equal(status.source, 'env');
    const key = await auth.resolveKey();
    assert.equal(key?.apiKey, 'env-key');
});
test('auth login captures the URL, stores a grant, and exposes no key', async () => {
    const store = credentials();
    const auth = new CursorAuth({ credentials: store, loadSdk: async () => sdk() });
    const started = await auth.startLogin();
    assert.equal(started.state, 'pending');
    assert.equal(started.url, 'https://cursor.test/login');
    await waitFor(async () => (await auth.status()).configured);
    const status = await auth.status();
    assert.equal(status.source, 'login');
    assert.equal(status.email, 'user@example.com');
    assert.equal(JSON.stringify(status).includes('key-1'), false);
    assert.equal(store.records.get('dsh-cursor/default').kind, 'grant');
});
test('auth logout removes the record and reports signed out', async () => {
    const store = credentials();
    const auth = new CursorAuth({ credentials: store, loadSdk: async () => sdk() });
    const started = await auth.startLogin();
    assert.equal(started.state, 'pending');
    await waitFor(async () => (await auth.status()).configured);
    await auth.logout();
    const status = await auth.status();
    assert.equal(status.configured, false);
    assert.equal(store.records.has('dsh-cursor/default'), false);
});
test('auth cancel aborts a pending login', async () => {
    const store = credentials();
    let signal;
    const auth = new CursorAuth({
        credentials: store,
        loadSdk: async () => sdk({
            login: options => {
                signal = options.signal;
                options.onLoginUrl?.('https://cursor.test/login');
                return new Promise((resolve, reject) => {
                    options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                });
            },
        }),
    });
    await auth.startLogin();
    auth.cancelLogin();
    assert.equal(signal.aborted, true);
});
test('auth maps a failed login without leaking the error', async () => {
    const store = credentials();
    const auth = new CursorAuth({
        credentials: store,
        loadSdk: async () => sdk({
            login: options => {
                options.onLoginUrl?.('https://cursor.test/login');
                return Promise.reject(new Error('Bearer secret-token was rejected'));
            },
        }),
    });
    const started = await auth.startLogin();
    assert.ok(['pending', 'error'].includes(started.state));
    await waitFor(async () => (await auth.status()).login.state === 'error');
    const status = await auth.status();
    assert.match(status.login.error, /redacted/);
    assert.equal(JSON.stringify(status).includes('secret-token'), false);
});
test('auth accepts a manual key after validating it', async () => {
    const store = credentials();
    const auth = new CursorAuth({ credentials: store, loadSdk: async () => sdk() });
    const result = await auth.setManualKey('manual-key');
    assert.equal(result.email, 'user@example.com');
    const status = await auth.status();
    assert.equal(status.source, 'manual');
    const key = await auth.resolveKey();
    assert.equal(key?.apiKey, 'manual-key');
});
test('auth rejects malformed manual keys', async () => {
    const store = credentials();
    const auth = new CursorAuth({ credentials: store, loadSdk: async () => sdk() });
    await assert.rejects(() => auth.setManualKey('has space'), /printable/);
    await assert.rejects(() => auth.setManualKey(''), /printable|non-empty/);
});
test('auth treats an expired record as unavailable but reports it', async () => {
    const store = credentials();
    store.records.set('dsh-cursor/default', {
        kind: 'grant',
        payload: { v: 1, source: 'login', apiKey: 'old', expiresAt: 1, createdAt: 0 },
    });
    const auth = new CursorAuth({ credentials: store, loadSdk: async () => sdk(), env: {} });
    const status = await auth.status();
    assert.equal(status.configured, false);
    assert.equal(status.expired, true);
});
test('auth fails a login when the credential store is unavailable', async () => {
    const auth = new CursorAuth({ loadSdk: async () => sdk(), env: {} });
    const started = await auth.startLogin();
    assert.ok(['pending', 'error'].includes(started.state));
    await waitFor(async () => (await auth.status()).login.state === 'error');
});
test('auth reads a lazily mounted credential store and notices a later record', async () => {
    let store;
    const auth = new CursorAuth({ credentials: () => store, loadSdk: async () => sdk(), env: {} });
    assert.equal((await auth.status()).configured, false);
    store = credentials();
    store.records.set('dsh-cursor/default', {
        kind: 'grant',
        payload: { v: 1, source: 'login', apiKey: 'later-key', email: 'later@example.com', createdAt: 0 },
    });
    const status = await auth.status();
    assert.equal(status.configured, true);
    assert.equal(status.email, 'later@example.com');
});
