import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildModelSelection,
  catalogRows,
  CatalogCache,
  contextChoices,
  defaultModelName,
  normalizeCatalog,
  normalizeModel,
  parseTokenCount,
  resolvedModelInfo,
} from '../lib/catalog.js'

export const MODEL = {
  id: 'grok-4.7',
  displayName: 'Grok 4.7',
  description: 'A test model',
  parameters: [
    { id: 'context', values: [{ value: '250K' }, { value: '500K' }] },
    { id: 'reasoning_effort', values: [{ value: 'low', displayName: 'Low' }, { value: 'high', displayName: 'High' }] },
    { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] },
  ],
  variants: [
    {
      params: [
        { id: 'context', value: '250K' },
        { id: 'reasoning_effort', value: 'low' },
        { id: 'fast', value: 'false' },
      ],
      displayName: 'Default',
      isDefault: true,
    },
    {
      params: [
        { id: 'context', value: '500K' },
        { id: 'reasoning_effort', value: 'high' },
        { id: 'fast', value: 'true' },
      ],
      displayName: 'Max',
      isMaxMode: true,
    },
  ],
}

test('parseTokenCount handles K/M and plain numbers', () => {
  assert.equal(parseTokenCount('250K'), 250_000)
  assert.equal(parseTokenCount('1m'), 1_000_000)
  assert.equal(parseTokenCount('1.5M'), 1_500_000)
  assert.equal(parseTokenCount(1234), 1234)
  assert.equal(parseTokenCount('nope'), undefined)
  assert.equal(parseTokenCount(0), undefined)
})

test('normalizeModel derives tiers, efforts, fast, and defaults', () => {
  const model = normalizeModel(MODEL)
  assert.deepEqual(model.contextTiers, [
    { value: '250K', tokens: 250_000 },
    { value: '500K', tokens: 500_000 },
  ])
  assert.deepEqual(model.efforts, [
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
  ])
  assert.equal(model.defaultContext, '250K')
  assert.equal(model.defaultEffort, 'low')
  assert.equal(model.fastSwitchable, true)
  assert.equal(defaultModelName(model), 'Cursor Grok 4.7')
})

test('normalizeCatalog drops duplicates and unusable entries', () => {
  const catalog = normalizeCatalog([MODEL, MODEL, { displayName: 'no id' }, null])
  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].id, 'grok-4.7')
})

test('contextChoices sorts by token count', () => {
  const choices = contextChoices([
    { id: 'context', values: [{ value: '1M' }, { value: '250K' }] },
  ])
  assert.deepEqual(choices.map(choice => choice.value), ['250K', '1M'])
})

test('buildModelSelection selects the smallest covering context tier and Fast', () => {
  const catalog = normalizeCatalog([MODEL])
  const selection = buildModelSelection({
    id: 'grok-4.7',
    catalog,
    reasoningEffort: 'high',
    fast: true,
    contextBudget: 350_000,
  })
  assert.deepEqual(selection.params, [
    { id: 'fast', value: 'true' },
    { id: 'context', value: '500K' },
    { id: 'reasoning_effort', value: 'high' },
  ])
  assert.equal(selection.maxMode, true)
})

test('buildModelSelection rejects unknown models, efforts, budgets, and Fast', () => {
  const catalog = normalizeCatalog([MODEL])
  assert.throws(() => buildModelSelection({ id: 'none', catalog }), /absent/)
  assert.throws(() => buildModelSelection({ id: 'grok-4.7', catalog, reasoningEffort: 'max' }), /not declared/)
  assert.throws(() => buildModelSelection({ id: 'grok-4.7', catalog, contextBudget: 2_000_000 }), /largest/)
  const noFast = normalizeCatalog([{ ...MODEL, parameters: [{ id: 'context', values: [{ value: '250K' }] }], variants: [] }])
  assert.throws(() => buildModelSelection({ id: 'grok-4.7', catalog: noFast, fast: true }), /Fast/)
})

test('buildModelSelection rejects a parameter combination with no variant', () => {
  const catalog = normalizeCatalog([
    {
      id: 'm',
      parameters: [
        { id: 'reasoning_effort', values: [{ value: 'low' }, { value: 'high' }] },
        { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] },
      ],
      variants: [
        {
          params: [
            { id: 'reasoning_effort', value: 'low' },
            { id: 'fast', value: 'false' },
          ],
          displayName: 'only',
        },
      ],
    },
  ])
  // Both values are individually declared, but the model offers no such variant.
  assert.throws(
    () => buildModelSelection({ id: 'm', catalog, reasoningEffort: 'high', fast: true }),
    /parameter combination/,
  )
})

test('resolvedModelInfo exposes native effort metadata and context', () => {
  const [model] = normalizeCatalog([MODEL])
  const info = resolvedModelInfo({
    provider: 'cursor',
    model,
    row: { name: 'My Grok', contextBudget: 350_000, inputModalities: ['text', 'image'] },
  })
  assert.equal(info.provider, 'cursor')
  assert.equal(info.id, 'grok-4.7')
  assert.equal(info.name, 'My Grok')
  assert.equal(info.context.contextWindow, 500_000)
  assert.deepEqual(info.reasoning.efforts.map(effort => effort.id), ['low', 'high'])
  assert.equal(info.reasoning.defaultEffort, 'low')
  assert.deepEqual(info.inputModalities, ['text', 'image'])
})

test('catalogRows merges saved rows and reports missing saved ids', () => {
  const [model] = normalizeCatalog([MODEL])
  const rows = catalogRows({
    catalog: [model],
    settings: {
      models: {
        'grok-4.7': { id: 'grok-4.7', enabled: false, name: 'Saved' },
        gone: { id: 'gone', enabled: true, name: 'Gone', inputModalities: ['text'] },
      },
    },
  })
  assert.equal(rows[0].selected, false)
  assert.equal(rows[0].name, 'Saved')
  assert.equal(rows[0].fastSwitchable, true)
  assert.equal(rows[1].id, 'gone')
  assert.equal(rows[1].missing, true)
})

test('CatalogCache caches by key hash and supports refresh', async () => {
  let calls = 0
  const cache = new CatalogCache({
    loadSdk: async () => ({
      Cursor: {
        models: {
          list: async () => {
            calls += 1
            return [MODEL]
          },
        },
      },
    }),
    ttlMs: 60_000,
  })
  const first = await cache.get('secret-key')
  const second = await cache.get('secret-key')
  assert.equal(calls, 1)
  assert.equal(first.length, 1)
  assert.equal(second[0].id, 'grok-4.7')
  await cache.get('secret-key', { refresh: true })
  assert.equal(calls, 2)
  assert.equal(cache.peek().models[0].id, 'grok-4.7')
})

test('CatalogCache maps an auth failure', async () => {
  const cache = new CatalogCache({
    loadSdk: async () => ({
      Cursor: {
        models: {
          list: async () => {
            const error = new Error('nope')
            error.status = 401
            throw error
          },
        },
      },
    }),
  })
  await assert.rejects(() => cache.get('k'), /authentication/i)
})
