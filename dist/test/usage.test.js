import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authFileCandidates, fetchUsage, jwtExpiry, onDemandUsage, parsePlan, parseUsage, resolveCliToken, UsageCache, } from '../lib/usage.js';
const jwt = exp => `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.sig`;
test('authFileCandidates includes the native CLI path per platform', () => {
    const darwin = authFileCandidates({ platform: 'darwin', home: '/Users/me', env: {} });
    assert.ok(darwin.includes('/Users/me/.cursor/auth.json'));
    const linux = authFileCandidates({ platform: 'linux', home: '/home/me', env: {} });
    assert.ok(linux.includes('/home/me/.config/cursor/auth.json'));
    const win = authFileCandidates({ platform: 'win32', home: 'C:\\Users\\me', env: { APPDATA: 'C:\\AppData' } });
    assert.ok(win.some(path => path.includes('Cursor') && path.endsWith('auth.json')));
});
test('jwtExpiry reads exp without verifying', () => {
    assert.equal(jwtExpiry(jwt(1234)), 1_234_000);
    assert.equal(jwtExpiry('not-a-jwt'), undefined);
});
test('resolveCliToken prefers the environment and reports expiry', async () => {
    const resolved = await resolveCliToken({
        env: { CURSOR_AUTH_TOKEN: jwt(1) },
        platform: 'darwin',
        home: '/none',
    });
    assert.equal(resolved?.source, 'env');
    assert.equal(resolved?.expired, true);
});
test('resolveCliToken reads the macOS auth file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cursor-usage-'));
    try {
        const path = join(dir, '.cursor', 'auth.json');
        const { mkdir } = await import('node:fs/promises');
        await mkdir(join(dir, '.cursor'), { recursive: true });
        await writeFile(path, JSON.stringify({ accessToken: jwt(9_999_999_999) }));
        const resolved = await resolveCliToken({ env: {}, platform: 'darwin', home: dir });
        assert.equal(resolved?.source, 'file');
        assert.equal(resolved?.path, path);
        assert.equal(resolved?.expired, false);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test('parseUsage reads the three plan windows', () => {
    const parsed = parseUsage({
        billingCycleEnd: 1_700_000_000_000,
        displayMessage: 'Pro plan',
        planUsage: {
            totalPercentUsed: 12.5,
            autoPercentUsed: 0,
            apiPercentUsed: 101,
        },
    });
    assert.equal(parsed.supported, true);
    assert.equal(parsed.note, 'Pro plan');
    assert.equal(parsed.windows.length, 3);
    assert.equal(parsed.windows[0].usedPercent, 12.5);
    assert.equal(parsed.windows[1].usedPercent, 0);
    assert.equal(parsed.windows[2].usedPercent, 100);
    assert.equal(parsed.windows[0].resetsAt, 1_700_000_000_000);
});
test('parseUsage reports missing or malformed usage without inventing zero', () => {
    assert.equal(parseUsage({}).supported, false);
    assert.equal(parseUsage({ planUsage: {} }).reason, 'no-windows');
    assert.equal(parseUsage({ planUsage: { totalPercentUsed: -1 } }).supported, false);
});
test('parseUsage reads the monthly on-demand limit in dollars', () => {
    const parsed = parseUsage({
        planUsage: { autoPercentUsed: 4, apiPercentUsed: 28 },
        spendLimitUsage: { individualLimit: 200, individualRemaining: 150, limitType: 'user' },
    });
    assert.deepEqual(parsed.onDemand, { limit: 2, used: 0.5 });
    assert.equal(parseUsage({ planUsage: { autoPercentUsed: 4 }, spendLimitUsage: { individualLimit: 0 } }).onDemand, undefined);
    assert.equal(onDemandUsage(undefined), undefined);
});
test('parsePlan reads the plan name and price', () => {
    assert.deepEqual(parsePlan({ planInfo: { planName: ' Ultra ', price: '$200/mo' } }), { name: 'Ultra', price: '$200/mo' });
    assert.deepEqual(parsePlan({ planInfo: { planName: 'Pro' } }), { name: 'Pro' });
    assert.equal(parsePlan({}), undefined);
    assert.equal(parsePlan({ planInfo: { planName: '' } }), undefined);
});
test('fetchUsage sends the Connect request and rejects auth failures', async () => {
    let seen;
    const payload = { planUsage: { totalPercentUsed: 1, autoPercentUsed: 2, apiPercentUsed: 3 } };
    const json = await fetchUsage('token', {
        fetch: async (url, init) => {
            seen = { url, init };
            return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
        },
    });
    assert.deepEqual(json, payload);
    assert.equal(seen.url, 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage');
    assert.equal(seen.init.headers.Authorization, 'Bearer token');
    assert.equal(seen.init.headers['Connect-Protocol-Version'], '1');
    assert.equal(seen.init.body, '{}');
    await assert.rejects(() => fetchUsage('token', {
        fetch: async () => new Response('no', { status: 401 }),
    }), /rejected/);
});
test('UsageCache caches, forces, and degrades to a stale snapshot', async () => {
    let now = 1_000;
    let fail = false;
    let fetches = 0;
    const cache = new UsageCache({
        now: () => now,
        ttlMs: 1_000,
        resolveToken: async () => ({ token: 't', source: 'file', expired: false }),
        fetchUsage: async () => {
            fetches += 1;
            if (fail)
                throw new Error('network');
            return {
                planUsage: { totalPercentUsed: 10, autoPercentUsed: 20, apiPercentUsed: 30 },
                billingCycleEnd: 5000,
            };
        },
        fetchPlan: async () => ({ planInfo: { planName: 'Ultra', price: '$200/mo' } }),
    });
    const first = await cache.get();
    assert.equal(first.supported, true);
    assert.deepEqual(first.plan, { name: 'Ultra', price: '$200/mo' });
    assert.equal(first.resetsAt, 5_000_000);
    assert.equal(fetches, 1);
    now = 1_500;
    await cache.get();
    assert.equal(fetches, 1);
    now = 3_000;
    await cache.get();
    assert.equal(fetches, 2);
    fail = true;
    now = 10_000;
    const stale = await cache.get({ force: true });
    assert.equal(stale.stale, true);
    assert.equal(stale.windows.length, 3);
});
test('UsageCache reports missing and expired CLI sessions', async () => {
    const missing = new UsageCache({ resolveToken: async () => undefined });
    assert.equal((await missing.get()).reason, 'cli-not-connected');
    const expired = new UsageCache({
        resolveToken: async () => ({ token: 't', source: 'file', expired: true }),
        fetchUsage: async () => {
            throw new Error('should not be called');
        },
    });
    assert.equal((await expired.get()).reason, 'cli-token-expired');
});
test('UsageCache labels an explicit Keychain attempt', async () => {
    const cache = new UsageCache({ resolveToken: async () => undefined });
    const result = await cache.get({ keychain: true });
    assert.equal(result.reason, 'keychain-unavailable');
});
