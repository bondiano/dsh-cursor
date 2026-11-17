import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { emptySettings, normalizeDocument, normalizeRows, SettingsStore, settingsPath, } from '../lib/settings.js';
async function tempDir() {
    return mkdtemp(join(tmpdir(), 'dsh-cursor-settings-'));
}
test('settingsPath stays under the harness home', () => {
    assert.equal(settingsPath('/tmp/home'), join('/tmp/home', 'plugins', 'cursor', 'settings.json'));
});
test('normalizeRows accepts a complete row and preserves order', () => {
    const document = normalizeRows([
        { id: 'a', enabled: true, name: ' Alpha ', contextBudget: 500000, fast: true, inputModalities: ['text', 'image'] },
        { id: 'b', enabled: false },
    ]);
    assert.deepEqual(document.order, ['a', 'b']);
    assert.equal(document.models.a.name, 'Alpha');
    assert.equal(document.models.a.contextBudget, 500000);
    assert.equal(document.models.a.fast, true);
    assert.deepEqual(document.models.a.inputModalities, ['text', 'image']);
    assert.equal(document.models.b.enabled, false);
    assert.deepEqual(document.models.b.inputModalities, ['text']);
});
test('normalizeRows rejects duplicate, unknown, and invalid rows', () => {
    assert.throws(() => normalizeRows([{ id: 'a' }, { id: 'a' }]), /duplicate/);
    assert.throws(() => normalizeRows([{ id: 'a' }], ['b']), /not present/);
    assert.throws(() => normalizeRows([{ id: 'a', contextBudget: -1 }]), /positive integer/);
    assert.throws(() => normalizeRows([{ id: 'a', name: 'x'.repeat(121) }]), /120/);
    assert.throws(() => normalizeRows([{ id: 'a', inputModalities: [] }]), /non-empty/);
    assert.throws(() => normalizeRows([{ id: 'a', inputModalities: ['audio'] }]), /unknown input modality/);
    assert.throws(() => normalizeRows({ id: 'a' }), /array/);
});
test('normalizeDocument tolerates order omissions and unknown rows', () => {
    const document = normalizeDocument({
        version: 1,
        order: ['b'],
        models: {
            a: { id: 'a', enabled: true },
            b: { id: 'b', enabled: false },
        },
        updatedAt: 42,
    });
    assert.deepEqual(document.order, ['b', 'a']);
    assert.equal(document.updatedAt, 42);
});
test('normalizeDocument rejects an unsupported version', () => {
    assert.throws(() => normalizeDocument({ version: 2, models: {} }), /unsupported/);
});
test('SettingsStore round-trips atomically and writes owner-only permissions', async () => {
    const dir = await tempDir();
    try {
        const file = join(dir, 'settings.json');
        const store = new SettingsStore({ file });
        assert.deepEqual(store.snapshot(), emptySettings());
        await store.save([{ id: 'a', enabled: true, name: 'Alpha' }]);
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        assert.equal(parsed.models.a.name, 'Alpha');
        const mode = (await import('node:fs/promises')).stat(file).then(info => info.mode & 0o777);
        assert.equal(await mode, 0o600);
        const second = new SettingsStore({ file });
        await second.load();
        assert.equal(second.snapshot().models.a.name, 'Alpha');
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test('SettingsStore degrades a corrupt file to empty settings', async () => {
    const dir = await tempDir();
    try {
        const file = join(dir, 'settings.json');
        await writeFile(file, '{not json');
        const store = new SettingsStore({ file });
        await store.load();
        assert.deepEqual(store.snapshot(), emptySettings());
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test('SettingsStore serializes concurrent writes', async () => {
    const dir = await tempDir();
    try {
        const file = join(dir, 'settings.json');
        const store = new SettingsStore({ file });
        await Promise.all([
            store.save([{ id: 'a' }]),
            store.save([{ id: 'b' }]),
        ]);
        assert.deepEqual(store.snapshot().order, ['b']);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test('load returns the current snapshot after an in-process save', async () => {
    const dir = await tempDir();
    try {
        const file = join(dir, 'settings.json');
        const store = new SettingsStore({ file });
        const first = await store.load();
        assert.deepEqual(first.order, []);
        await store.save([{ id: 'a', enabled: false }, { id: 'b', enabled: true }]);
        const second = await store.load();
        assert.deepEqual(second.order, ['a', 'b']);
        assert.equal(second.models.a.enabled, false);
        assert.equal(second.models.b.enabled, true);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
