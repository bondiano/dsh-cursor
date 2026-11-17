/**
 * Durable, non-secret model preferences for the Cursor provider.
 *
 * The file lives under the harness home (`plugins/cursor/settings.json`), is
 * written atomically with owner-only permissions, and is independent of the
 * profile's `cordis.patch.yml`: the Settings page owns these rows, while the
 * patch owns only deployment tuning.
 *
 * @module dsh-cursor/lib/settings
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Current document version. */
export const SETTINGS_VERSION = 1

/** Longest accepted user-supplied model name. */
export const MAX_MODEL_NAME = 120

const MODALITIES = new Set(['text', 'image'])

/** Invalid settings input; surfaced to the RPC caller as a bad request. */
export class SettingsError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SettingsError'
  }
}

/**
 * Absolute path of the settings document for one harness home.
 * @param {string} home resolved harness home (`~/.dsh` by default).
 * @returns {string} absolute path.
 */
export function settingsPath(home) {
  return join(home, 'plugins', 'cursor', 'settings.json')
}

/**
 * Empty document.
 * @returns {SettingsDocument} a fresh document.
 */
/** One saved model preference row. */
export interface ModelRow {
  id: string
  enabled: boolean
  name?: string
  contextBudget?: number
  fast?: boolean
  inputModalities?: string[]
}

/** The whole durable settings document. */
export interface SettingsDocument {
  version: number
  order: string[]
  models: Record<string, ModelRow>
  updatedAt: number
}

export function emptySettings(): SettingsDocument {
  return { version: SETTINGS_VERSION, order: [], models: {}, updatedAt: 0 }
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function normalizeBudget(value) {
  if (value === undefined || value === null || value === '') return undefined
  const number = typeof value === 'string' ? Number(value.replace(/[,_\s]/g, '')) : value
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new SettingsError('contextBudget must be a positive integer number of tokens')
  }
  return number
}

function normalizeName(value, id) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new SettingsError(`name for model ${id} must be a string`)
  const name = value.trim().replace(/\s+/g, ' ')
  if (name.length === 0) return undefined
  if (name.length > MAX_MODEL_NAME) {
    throw new SettingsError(`name for model ${id} must be at most ${MAX_MODEL_NAME} characters`)
  }
  return name
}

function normalizeModalities(value, id) {
  if (value === undefined) return ['text']
  if (!Array.isArray(value) || value.length === 0) {
    throw new SettingsError(`inputModalities for model ${id} must be a non-empty array`)
  }
  const unique = [...new Set(value)]
  for (const item of unique) {
    if (!MODALITIES.has(item)) throw new SettingsError(`unknown input modality "${item}" for model ${id}`)
  }
  return unique
}

/**
 * Normalize and validate one model row.
 * @param {unknown} value candidate row.
 * @param {string} id model id it must carry.
 * @param {Iterable<string>|undefined} known ids from the last catalog, when available.
 * @returns {object} normalized row.
 */
export function normalizeRow(value, id, known) {
  if (!isRecord(value)) throw new SettingsError(`model ${id} must be an object`)
  if (value.id !== id) throw new SettingsError(`model row id mismatch for ${id}`)
  if (known !== undefined && !known.has(id)) {
    throw new SettingsError(`model ${id} is not present in the current Cursor catalog`)
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new SettingsError(`enabled for model ${id} must be a boolean`)
  }
  if (value.fast !== undefined && typeof value.fast !== 'boolean') {
    throw new SettingsError(`fast for model ${id} must be a boolean`)
  }
  return {
    id,
    enabled: value.enabled !== false,
    ...(normalizeName(value.name, id) === undefined ? {} : { name: normalizeName(value.name, id) }),
    ...(normalizeBudget(value.contextBudget) === undefined
      ? {}
      : { contextBudget: normalizeBudget(value.contextBudget) }),
    fast: value.fast === true,
    inputModalities: normalizeModalities(value.inputModalities, id),
  }
}

/**
 * Validate a list of rows into a complete settings document.
 * @param {unknown} rows candidate rows (array).
 * @param {Iterable<string>|undefined} knownIds ids from the last catalog.
 * @returns {SettingsDocument} normalized document.
 */
export function normalizeRows(rows, knownIds?: Iterable<string>): SettingsDocument {
  if (!Array.isArray(rows)) throw new SettingsError('models must be an array')
  const known = knownIds === undefined ? undefined : new Set(knownIds)
  const order: string[] = []
  const models: Record<string, ModelRow> = {}
  for (const value of rows) {
    if (!isRecord(value)) throw new SettingsError('every model row must be an object')
    const id = value.id
    if (typeof id !== 'string' || id.trim() === '') throw new SettingsError('every model row needs a non-empty id')
    if (Object.hasOwn(models, id)) throw new SettingsError(`duplicate model id "${id}"`)
    const row = normalizeRow(value, id, known)
    order.push(id)
    models[id] = row
  }
  return { version: SETTINGS_VERSION, order, models, updatedAt: Date.now() }
}

/**
 * Validate a persisted document without trusting its bytes.
 * @param {unknown} value parsed JSON.
 * @returns {SettingsDocument} normalized document.
 */
export function normalizeDocument(value): SettingsDocument {
  if (!isRecord(value)) throw new SettingsError('settings document must be an object')
  if (value.version !== SETTINGS_VERSION) throw new SettingsError('unsupported settings version')
  if (!isRecord(value.models)) throw new SettingsError('models must be an object')
  const rows: unknown[] = []
  const seen = new Set<unknown>()
  const order = Array.isArray(value.order) ? value.order : Object.keys(value.models)
  for (const id of order) {
    if (typeof id !== 'string' || !Object.hasOwn(value.models, id) || seen.has(id)) continue
    rows.push(value.models[id])
    seen.add(id)
  }
  for (const [id, row] of Object.entries(value.models)) {
    if (seen.has(id)) continue
    if (isRecord(row)) rows.push(row)
    seen.add(id)
  }
  const normalized = normalizeRows(rows)
  normalized.updatedAt = Number.isSafeInteger(value.updatedAt) ? value.updatedAt : 0
  return normalized
}

/**
 * Serialized, atomic store. Reads once; every write replaces the in-memory
 * snapshot only after the file rename succeeds.
 */
export class SettingsStore {
  #file
  #logger
  #current = emptySettings()
  #loaded
  #writeChain: Promise<unknown> = Promise.resolve()

  /**
   * @param {{file:string, logger?:{warn?:(message:string)=>void}}} options store options.
   */
  constructor({ file, logger }: { file: string; logger?: { warn?: (message: string) => void } }) {
    if (typeof file !== 'string' || file.length === 0) throw new TypeError('settings file path is required')
    this.#file = file
    this.#logger = logger
  }

  /** @returns {string} absolute settings path. */
  get path() {
    return this.#file
  }

  /**
   * Load once; corruption degrades to an empty document instead of failing the plugin.
   * @returns {Promise<object>} current snapshot.
   */
  async load() {
    this.#loaded ??= this.#readFile()
    await this.#loaded
    return this.snapshot()
  }

  async #readFile() {
    try {
      const text = await readFile(this.#file, 'utf8')
      this.#current = normalizeDocument(JSON.parse(text))
    } catch (error) {
      if (!(error instanceof Object && 'code' in error && error.code === 'ENOENT')) {
        this.#logger?.warn?.(`cursor settings ignored: ${error instanceof Error ? error.message : String(error)}`)
      }
      this.#current = emptySettings()
    }
    return this.snapshot()
  }

  /** @returns {object} detached snapshot. */
  snapshot() {
    return structuredClone(this.#current)
  }

  /**
   * Replace every model row atomically.
   * @param {unknown} rows candidate rows.
   * @param {Iterable<string>|undefined} knownIds ids from the last catalog.
   * @returns {Promise<object>} saved snapshot.
   */
  save(rows, knownIds?: Iterable<string>) {
    const document = normalizeRows(rows, knownIds)
    const run = this.#writeChain.then(async () => {
      await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 })
      const temporary = `${this.#file}.${process.pid}.${Date.now()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(document, null, 2), { mode: 0o600 })
        await chmod(temporary, 0o600)
        await rename(temporary, this.#file)
      } finally {
        await rm(temporary, { force: true }).catch(() => {})
      }
      this.#current = document
      return this.snapshot()
    })
    this.#writeChain = run.catch(() => {})
    return run
  }
}
