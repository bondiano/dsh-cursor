/**
 * Cursor subscription quota telemetry.
 *
 * Model calls use the SDK's minted API key; the quota dashboard accepts the
 * local Cursor CLI session token instead. This module reads that token from
 * the environment, the CLI's auth file, or (explicitly) the macOS Keychain, and
 * asks Cursor's dashboard for the current period usage. The token never leaves
 * this process and never reaches the browser.
 *
 * @module dsh-cursor/lib/usage
 */

import { execFile } from 'node:child_process'
import { readFile as readFileDefault } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ProviderError } from './errors.js'

/** Cursor dashboard quota endpoint. */
export const USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage'

/** Keychain account/service names used by the Cursor Agent CLI. */
export const KEYCHAIN_ACCOUNT = 'cursor-user'
export const KEYCHAIN_ACCESS_TOKEN_SERVICE = 'cursor-access-token'

const execFileAsync = promisify(execFile)
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Candidate CLI auth files, most specific first.
 * @param {{platform?:string, home?:string, env?:object}} [options] resolution options.
 * @returns {string[]} absolute paths.
 */
export function authFileCandidates({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  const paths = []
  if (platform === 'darwin') paths.push(join(home, '.cursor', 'auth.json'))
  if (platform === 'win32') {
    const appData = env.APPDATA || join(home, 'AppData', 'Roaming')
    paths.push(join(appData, 'Cursor', 'auth.json'))
  }
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config')
  paths.push(join(configHome, 'cursor', 'auth.json'))
  paths.push(join(configHome, 'Cursor', 'auth.json'))
  // Compatibility with tools that only look at the unix config path.
  paths.push(join(home, '.config', 'cursor', 'auth.json'))
  return [...new Set(paths)]
}

/**
 * Decode a JWT expiry without verifying it. Verification is the server's job;
 * this is only a UI hint that the local CLI session is stale.
 * @param {string} token token.
 * @returns {number|undefined} epoch milliseconds.
 */
export function jwtExpiry(token) {
  const parts = typeof token === 'string' ? token.split('.') : []
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return isRecord(payload) && Number.isFinite(payload.exp) ? payload.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/**
 * Read a `{accessToken}` document.
 * @param {string} path file path.
 * @param {{readFile?:Function}} [options] IO override.
 * @returns {Promise<string|undefined>} token.
 */
export async function readAuthFileToken(path, { readFile = readFileDefault } = {}) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return isRecord(parsed) && typeof parsed.accessToken === 'string' && parsed.accessToken.trim() !== ''
      ? parsed.accessToken.trim()
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Read the Cursor CLI access token from the macOS Keychain.
 *
 * This may show a Keychain access prompt; callers must only invoke it after an
 * explicit user action.
 *
 * @param {{execFileAsync?:Function}} [options] process override for tests.
 * @returns {Promise<string|undefined>} token.
 */
export async function readKeychainToken({ execFileAsync: run = execFileAsync } = {}) {
  if (process.platform !== 'darwin') return undefined
  try {
    const { stdout } = await run(
      '/usr/bin/security',
      ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_ACCESS_TOKEN_SERVICE, '-w'],
      { timeout: 3000, maxBuffer: 64 * 1024 },
    )
    const token = String(stdout).trim()
    return token.length > 0 ? token : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve one local Cursor CLI token.
 * @param {{env?:object, platform?:string, home?:string, readFile?:Function, keychain?:boolean, execFileAsync?:Function}} [options] resolution options.
 * @returns {Promise<{token:string, source:'env'|'file'|'keychain', path?:string, expired:boolean}|undefined>} token.
 */
export async function resolveCliToken({
  env = process.env,
  platform = process.platform,
  home = homedir(),
  readFile = readFileDefault,
  keychain = false,
  execFileAsync: run,
} = {}) {
  const fromEnv = env.CURSOR_AUTH_TOKEN
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    const token = fromEnv.trim()
    const expiry = jwtExpiry(token)
    return { token, source: 'env', expired: expiry !== undefined && expiry <= Date.now() }
  }
  for (const path of authFileCandidates({ platform, home, env })) {
    const token = await readAuthFileToken(path, { readFile })
    if (token !== undefined) {
      const expiry = jwtExpiry(token)
      return { token, source: 'file', path, expired: expiry !== undefined && expiry <= Date.now() }
    }
  }
  if (keychain) {
    const token = await readKeychainToken({ execFileAsync: run })
    if (token !== undefined) {
      const expiry = jwtExpiry(token)
      return { token, source: 'keychain', expired: expiry !== undefined && expiry <= Date.now() }
    }
  }
  return undefined
}

const percent = value => {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) return undefined
  return Math.min(100, number)
}

const timestamp = value => {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) return undefined
  return number > 1e12 ? Math.floor(number) : Math.floor(number * 1000)
}

/**
 * Parse `GetCurrentPeriodUsage` JSON.
 * @param {unknown} payload response.
 * @returns {{supported:boolean, windows:Array<{key:string,usedPercent:number,resetsAt?:number}>, plan?:string, reason?:string}} parsed usage.
 */
export function parseUsage(payload) {
  const body = isRecord(payload) ? payload : {}
  const planUsage = isRecord(body.planUsage) ? body.planUsage : undefined
  if (planUsage === undefined) return { supported: false, windows: [], reason: 'no-plan-usage' }
  const resetsAt = timestamp(body.billingCycleEnd)
  const windows = []
  for (const [key, field] of [
    ['total', 'totalPercentUsed'],
    ['auto', 'autoPercentUsed'],
    ['api', 'apiPercentUsed'],
  ]) {
    const usedPercent = percent(planUsage[field])
    if (usedPercent === undefined) continue
    windows.push({ key, usedPercent, ...(resetsAt === undefined ? {} : { resetsAt }) })
  }
  if (windows.length === 0) return { supported: false, windows: [], reason: 'no-windows' }
  const note = typeof body.displayMessage === 'string' && body.displayMessage.trim() !== '' ? body.displayMessage.trim() : undefined
  return { supported: true, windows, ...(note === undefined ? {} : { note }) }
}

/**
 * Ask Cursor for current usage.
 * @param {string} token CLI access token.
 * @param {{fetch?:Function, timeoutMs?:number, signal?:AbortSignal}} [options] request options.
 * @returns {Promise<unknown>} parsed JSON.
 */
export async function fetchUsage(token, { fetch: fetchFn = globalThis.fetch, timeoutMs = 10_000, signal } = {}) {
  if (typeof token !== 'string' || token.length === 0) throw new ProviderError('USAGE_TOKEN_MISSING', 'No Cursor CLI token')
  if (typeof fetchFn !== 'function') throw new ProviderError('USAGE_UNAVAILABLE', 'HTTP client is unavailable')
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  let response
  try {
    response = await fetchFn(USAGE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
      },
      body: '{}',
      signal: controller.signal,
      redirect: 'error',
    })
  } catch (error) {
    if (signal?.aborted) throw new ProviderError('ABORTED', 'Usage request cancelled')
    if (controller.signal.aborted) throw new ProviderError('USAGE_TIMEOUT', 'Cursor usage request timed out')
    throw new ProviderError('USAGE_UNREACHABLE', 'Cursor usage endpoint is unreachable')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    if (response.status === 401 || response.status === 403) {
      throw new ProviderError('USAGE_AUTH_REJECTED', 'Cursor CLI session was rejected; run `agent login` again')
    }
    if (response.status === 429) throw new ProviderError('USAGE_RATE_LIMITED', 'Cursor usage endpoint is rate limited')
    throw new ProviderError(`HTTP_${response.status}`, 'Cursor usage endpoint returned an error')
  }
  try {
    return await response.json()
  } catch {
    throw new ProviderError('USAGE_INVALID', 'Cursor usage endpoint returned invalid JSON')
  }
}

const emptyResult = (reason, source = 'none') => ({ supported: false, source, windows: [], reason })

/**
 * Cached quota reader shared by the Settings card and the composer pill.
 */
export class UsageCache {
  #resolveToken
  #fetchUsage
  #now
  #ttlMs
  #timeoutMs
  #logger
  #cached
  #lastAttempt = 0

  /**
   * @param {{resolveToken?:Function, fetchUsage?:Function, now?:Function, ttlMs?:number, timeoutMs?:number, logger?:object}} [options] cache options.
   */
  constructor({ resolveToken = resolveCliToken, fetchUsage: fetchFn = fetchUsage, now = Date.now, ttlMs = 60_000, timeoutMs = 10_000, logger } = {}) {
    this.#resolveToken = resolveToken
    this.#fetchUsage = fetchFn
    this.#now = now
    this.#ttlMs = ttlMs
    this.#timeoutMs = timeoutMs
    this.#logger = logger
  }

  /** Last result, if any. */
  peek() {
    return this.#cached?.value
  }

  /** Drop the cached snapshot. */
  clear() {
    this.#cached = undefined
    this.#lastAttempt = 0
  }

  /**
   * Read usage, reusing a fresh snapshot.
   * @param {{force?:boolean, keychain?:boolean, signal?:AbortSignal}} [options] read options.
   * @returns {Promise<object>} UI-safe usage result.
   */
  async get({ force = false, keychain = false, signal } = {}) {
    const now = this.#now()
    if (!force && this.#cached !== undefined && now - this.#cached.at < this.#ttlMs) {
      return structuredClone(this.#cached.value)
    }
    if (force && this.#cached !== undefined && now - this.#lastAttempt < 2_000) {
      return structuredClone(this.#cached.value)
    }
    this.#lastAttempt = now
    let resolved
    try {
      resolved = await this.#resolveToken({ keychain })
    } catch (error) {
      this.#logger?.warn?.(`cursor CLI token lookup failed: ${error instanceof Error ? error.message : String(error)}`)
      resolved = undefined
    }
    if (resolved === undefined) {
      return emptyResult(keychain ? 'keychain-unavailable' : 'cli-not-connected')
    }
    if (resolved.expired) {
      const result = { supported: false, source: 'cursor-cli', windows: [], reason: 'cli-token-expired' }
      this.#cached = { at: now, value: result }
      return result
    }
    try {
      const payload = await this.#fetchUsage(resolved.token, { timeoutMs: this.#timeoutMs, signal })
      const parsed = parseUsage(payload)
      const result = {
        ...parsed,
        source: 'cursor-cli',
        fetchedAt: now,
        stale: false,
      }
      this.#cached = { at: now, value: result }
      return structuredClone(result)
    } catch (error) {
      const code = error instanceof ProviderError ? error.code : 'USAGE_UNAVAILABLE'
      if (this.#cached !== undefined) {
        const stale = { ...structuredClone(this.#cached.value), stale: true, reason: code.toLowerCase() }
        return stale
      }
      return { supported: false, source: 'cursor-cli', windows: [], reason: code.toLowerCase() }
    }
  }
}
