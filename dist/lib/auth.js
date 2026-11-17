/**
 * Cursor account authentication for the provider.
 *
 * A browser sign-in mints a named, expiring Cursor user API key. The key is
 * stored as a DSH credential record (the sanctioned place for in-app sign-in
 * results), never in configuration, logs, RPC responses, or replay state.
 * `CURSOR_API_KEY` remains a headless fallback.
 *
 * @module dsh-cursor/lib/auth
 */
import { bounded, mapSdkError, ProviderError } from './errors.js';
/** Longest accepted API key, matching the Cursor dashboard's practical shape. */
const MAX_KEY_LENGTH = 4096;
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/**
 * Remove obvious secret material from a third-party error message.
 * @param {unknown} error error.
 * @returns {string} safe message.
 */
export function sanitizeMessage(error) {
    const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    const text = raw.replace(/\s+/g, ' ').trim();
    if (text.length === 0)
        return 'Cursor sign-in failed';
    return text
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
        .replace(/(api[-_ ]?key|cursor[-_ ]?auth[-_ ]?token)\s*[:=]\s*\S+/gi, '$1=[redacted]')
        .replace(/\b[A-Za-z0-9_-]{80,}\b/g, '[redacted]')
        .slice(0, 300);
}
/**
 * Account state and browser login for one Cursor credential record.
 */
export class CursorAuth {
    #credentials;
    #recordKey;
    #loadSdk;
    #logger;
    #env;
    #now;
    #onChange;
    #record;
    #login;
    #lastError;
    /**
     * @param {{credentials?:object, recordKey?:string, loadSdk:()=>Promise<object>, logger?:object, env?:object, now?:()=>number, onChange?:(reason:string)=>void}} options auth options.
     */
    constructor({ credentials, recordKey = 'dsh-cursor/default', loadSdk, logger, env = process.env, now = Date.now, onChange, }) {
        if (typeof loadSdk !== 'function')
            throw new TypeError('loadSdk is required');
        this.#credentials = credentials;
        this.#recordKey = recordKey;
        this.#loadSdk = loadSdk;
        this.#logger = logger;
        this.#env = env;
        this.#now = now;
        this.#onChange = onChange;
        this.#record = undefined;
        this.#login = null;
        this.#lastError = null;
    }
    /** @returns {string} credential record key. */
    get recordKey() {
        return this.#recordKey;
    }
    /**
     * Read the stored record once.
     * @returns {Promise<void>} load completion.
     */
    #store() {
        return typeof this.#credentials === 'function' ? this.#credentials() : this.#credentials;
    }
    async load() {
        const store = this.#store();
        if (store === undefined || store === null) {
            this.#record = undefined;
            return;
        }
        try {
            const record = await store.readRecord(this.#recordKey);
            this.#record = this.#parseRecord(record);
        }
        catch (error) {
            this.#logger?.warn?.(`cursor credential record could not be read: ${sanitizeMessage(error)}`);
            this.#record = undefined;
        }
    }
    #parseRecord(record) {
        if (!isRecord(record) || record.kind !== 'grant' || !isRecord(record.payload))
            return undefined;
        const payload = record.payload;
        if (payload.v !== 1)
            return undefined;
        if (typeof payload.apiKey !== 'string' || payload.apiKey.length === 0)
            return undefined;
        return {
            v: 1,
            apiKey: payload.apiKey,
            source: payload.source === 'manual' ? 'manual' : 'login',
            ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
            ...(Number.isSafeInteger(payload.expiresAt) ? { expiresAt: payload.expiresAt } : {}),
            ...(typeof payload.backendUrl === 'string' ? { backendUrl: payload.backendUrl } : {}),
            createdAt: Number.isSafeInteger(payload.createdAt) ? payload.createdAt : this.#now(),
        };
    }
    #expired(record = this.#record) {
        return record?.expiresAt !== undefined && record.expiresAt <= this.#now();
    }
    /**
     * Resolve the key to use for the next call.
     * @returns {Promise<{apiKey:string, source:'login'|'manual'|'env', email?:string, expiresAt?:number}|undefined>} credential.
     */
    async resolveKey() {
        await this.load();
        return this.#resolved();
    }
    #resolved() {
        if (this.#record !== undefined && !this.#expired()) {
            return {
                apiKey: this.#record.apiKey,
                source: this.#record.source,
                ...(this.#record.email === undefined ? {} : { email: this.#record.email }),
                ...(this.#record.expiresAt === undefined ? {} : { expiresAt: this.#record.expiresAt }),
            };
        }
        const envKey = this.#env?.CURSOR_API_KEY;
        if (typeof envKey === 'string' && envKey.trim() !== '') {
            return { apiKey: envKey.trim(), source: 'env' };
        }
        return undefined;
    }
    /**
     * UI-safe account state.
     * @returns {Promise<object>} status without any secret.
     */
    async status() {
        await this.load();
        const resolved = this.#resolved();
        const source = resolved?.source ?? (this.#record !== undefined ? this.#record.source : undefined);
        return {
            configured: resolved !== undefined,
            ...(source === undefined ? {} : { source }),
            ...(this.#record?.email === undefined ? {} : { email: this.#record.email }),
            ...(this.#record?.expiresAt === undefined ? {} : { expiresAt: this.#record.expiresAt }),
            expired: this.#record !== undefined && this.#expired(),
            login: this.loginStatus(),
        };
    }
    /** @returns {{state:'idle'|'pending'|'error', url?:string, error?:string}} current login attempt. */
    loginStatus() {
        if (this.#login === null)
            return this.#lastError === null ? { state: 'idle' } : { state: 'error', error: this.#lastError };
        if (this.#login.state === 'error')
            return { state: 'error', error: this.#login.error };
        if (this.#login.state === 'done')
            return { state: 'idle' };
        return { state: 'pending', ...(this.#login.url === undefined ? {} : { url: this.#login.url }) };
    }
    /**
     * Start a browser sign-in and return as soon as the URL is available.
     * @returns {Promise<{state:'pending'|'error', url?:string, error?:string}>} start result.
     */
    async startLogin() {
        if (this.#login?.state === 'pending' && this.#login.url !== undefined) {
            return { state: 'pending', url: this.#login.url };
        }
        if (this.#login?.state === 'pending')
            return { state: 'pending' };
        const controller = new AbortController();
        const state = {
            state: 'pending',
            url: undefined,
            error: undefined,
            controller,
            resolveUrl: undefined,
            rejectUrl: undefined,
            urlReady: new Promise((resolve, reject) => {
                state.resolveUrl = resolve;
                state.rejectUrl = reject;
            }),
        };
        state.urlReady.catch(() => { });
        this.#login = state;
        this.#lastError = null;
        state.task = (async () => {
            try {
                const sdk = await this.#loadSdk();
                if (sdk?.Cursor?.auth?.login === undefined) {
                    throw new ProviderError('SDK_UNAVAILABLE', 'Cursor SDK sign-in is unavailable');
                }
                const result = await sdk.Cursor.auth.login({
                    store: null,
                    openBrowser: false,
                    apiKeyName: 'DeepSeek Harness',
                    signal: controller.signal,
                    onLoginUrl: url => {
                        if (typeof url !== 'string' || url.length === 0)
                            return;
                        state.url = url;
                        state.resolveUrl?.(url);
                    },
                });
                if (controller.signal.aborted)
                    return;
                if (!isRecord(result) || typeof result.apiKey !== 'string' || result.apiKey.length === 0) {
                    throw new ProviderError('LOGIN_FAILED', 'Cursor sign-in returned no usable API key');
                }
                await this.#write({
                    source: 'login',
                    apiKey: result.apiKey,
                    ...(typeof result.email === 'string' && result.email.length > 0 ? { email: result.email } : {}),
                    ...(Number.isSafeInteger(result.apiKeyExpiresAtMs) ? { expiresAt: result.apiKeyExpiresAtMs } : {}),
                });
                state.state = 'done';
                this.#login = null;
                this.#lastError = null;
                this.#onChange?.('login');
            }
            catch (error) {
                if (controller.signal.aborted) {
                    state.state = 'idle';
                    if (this.#login === state)
                        this.#login = null;
                    return;
                }
                const message = sanitizeMessage(error);
                state.state = 'error';
                state.error = message;
                this.#lastError = message;
                state.rejectUrl?.(error);
            }
        })();
        await Promise.race([
            state.urlReady,
            new Promise(resolve => {
                const timer = setTimeout(resolve, 10_000);
                timer.unref?.();
            }),
        ]).catch(() => { });
        if (state.state === 'error')
            return { state: 'error', error: state.error };
        if (state.url === undefined) {
            return {
                state: 'pending',
                error: 'Cursor did not provide a sign-in URL yet; retry in a moment',
            };
        }
        return { state: 'pending', url: state.url };
    }
    /** Cancel a pending browser sign-in. */
    cancelLogin() {
        this.#login?.controller?.abort();
        this.#login = null;
        this.#lastError = null;
    }
    /**
     * Store a manually supplied API key after validating it against the account.
     * @param {unknown} value API key.
     * @returns {Promise<{email?:string}>} account hint.
     */
    async setManualKey(value) {
        if (typeof value !== 'string')
            throw new ProviderError('INVALID_CREDENTIAL', 'API key must be a string');
        const apiKey = value.trim();
        if (apiKey.length === 0 || apiKey.length > MAX_KEY_LENGTH || !PRINTABLE_ASCII.test(apiKey)) {
            throw new ProviderError('INVALID_CREDENTIAL', 'API key must be printable ASCII without spaces');
        }
        const sdk = await this.#loadSdk();
        if (sdk?.Cursor?.me === undefined)
            throw new ProviderError('SDK_UNAVAILABLE', 'Cursor SDK account lookup is unavailable');
        let me;
        try {
            me = await bounded(() => sdk.Cursor.me({ apiKey }), { timeoutMs: 20_000 });
        }
        catch (error) {
            throw mapSdkError(error);
        }
        const email = isRecord(me) && typeof me.userEmail === 'string' && me.userEmail.length > 0 ? me.userEmail : undefined;
        await this.#write({ source: 'manual', apiKey, ...(email === undefined ? {} : { email }) });
        this.#onChange?.('manual');
        return email === undefined ? {} : { email };
    }
    /** Forget the stored credential (the key itself remains valid upstream). */
    async logout() {
        this.cancelLogin();
        this.#record = undefined;
        this.#lastError = null;
        const store = this.#store();
        if (store !== undefined && store !== null) {
            try {
                await store.deleteRecord(this.#recordKey);
            }
            catch (error) {
                this.#logger?.warn?.(`cursor credential record could not be removed: ${sanitizeMessage(error)}`);
            }
        }
        this.#onChange?.('logout');
    }
    /** Release any pending login poll. */
    dispose() {
        this.cancelLogin();
    }
    async #write({ source, apiKey, email, expiresAt, backendUrl }) {
        const payload = {
            v: 1,
            source,
            apiKey,
            ...(email === undefined ? {} : { email }),
            ...(expiresAt === undefined ? {} : { expiresAt }),
            ...(backendUrl === undefined ? {} : { backendUrl }),
            createdAt: this.#now(),
        };
        const store = this.#store();
        if (store === undefined || store === null) {
            throw new ProviderError('CREDENTIAL_STORE_UNAVAILABLE', 'DSH credential storage is unavailable');
        }
        try {
            await store.modifyRecord(this.#recordKey, async () => ({ kind: 'grant', payload }));
        }
        catch (error) {
            this.#logger?.warn?.(`cursor credential record could not be stored: ${sanitizeMessage(error)}`);
            throw new ProviderError('CREDENTIAL_WRITE_FAILED', 'Cursor credential could not be stored');
        }
        this.#record = { v: 1, source, apiKey, ...(email === undefined ? {} : { email }), ...(expiresAt === undefined ? {} : { expiresAt }), ...(backendUrl === undefined ? {} : { backendUrl }), createdAt: payload.createdAt };
    }
}
