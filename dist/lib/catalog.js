/**
 * Cursor model catalog: SDK discovery, parameter normalization, and model
 * selection.
 *
 * The Cursor catalog describes selectable values through `parameters` and
 * `variants`. DSH only understands a base model id plus native reasoning
 * efforts and a context budget, so this module is the single place that turns
 * one into the other. No network call happens here unless the caller asks for
 * a refresh through {@link CatalogCache}.
 *
 * @module dsh-cursor/lib/catalog
 */
import { createHash } from 'node:crypto';
import { bounded, mapSdkError, ProviderError } from './errors.js';
/** Context parameter id used by Cursor's parameterized models. */
export const CONTEXT_PARAM = 'context';
/** Fast-tier parameter id used by Cursor's parameterized models. */
export const FAST_PARAM = 'fast';
/** Reasoning parameter ids, in preference order. */
export const REASONING_PARAMS = Object.freeze(['reasoning_effort', 'effort', 'reasoning']);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/**
 * Parse a catalog token-count value such as `250K`, `1M`, `500000`, or `1.5m`.
 * @param {unknown} value raw catalog value.
 * @returns {number|undefined} token count, or undefined for an unknown shape.
 */
export function parseTokenCount(value) {
    if (typeof value === 'number')
        return Number.isSafeInteger(value) && value > 0 ? value : undefined;
    if (typeof value !== 'string')
        return undefined;
    const match = /^\s*(\d+(?:\.\d+)?)\s*([km])?\s*$/i.exec(value);
    if (match === null)
        return undefined;
    const factor = match[2] === undefined ? 1 : match[2].toLowerCase() === 'k' ? 1_000 : 1_000_000;
    const tokens = Number(match[1]) * factor;
    return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}
/**
 * Merge `parameters` and variant parameters into one definition list.
 * @param {object} model SDK model list item.
 * @returns {Array<{id:string, displayName?:string, values:Array<{value:string, displayName?:string}>}>} merged parameters.
 */
export function parameterDefinitions(model) {
    const byId = new Map();
    const add = (id, value, displayName) => {
        if (typeof id !== 'string' || typeof value !== 'string')
            return;
        let definition = byId.get(id);
        if (definition === undefined) {
            definition = { id, values: [] };
            byId.set(id, definition);
        }
        if (!definition.values.some(item => item.value === value)) {
            definition.values.push({ value, ...(typeof displayName === 'string' ? { displayName } : {}) });
        }
    };
    for (const parameter of Array.isArray(model?.parameters) ? model.parameters : []) {
        if (!isRecord(parameter) || typeof parameter.id !== 'string')
            continue;
        const definition = { id: parameter.id, values: [] };
        if (typeof parameter.displayName === 'string')
            definition.displayName = parameter.displayName;
        byId.set(parameter.id, definition);
        for (const value of Array.isArray(parameter.values) ? parameter.values : []) {
            if (!isRecord(value) || typeof value.value !== 'string')
                continue;
            add(parameter.id, value.value, value.displayName);
        }
    }
    for (const variant of Array.isArray(model?.variants) ? model.variants : []) {
        if (!isRecord(variant) || !Array.isArray(variant.params))
            continue;
        for (const param of variant.params) {
            if (!isRecord(param) || typeof param.id !== 'string' || typeof param.value !== 'string')
                continue;
            add(param.id, param.value);
        }
    }
    return [...byId.values()];
}
/**
 * Context tiers declared by a model, sorted ascending by token count.
 * @param {Array<{id:string,values:Array<{value:string}>}>} parameters merged parameters.
 * @returns {Array<{value:string, tokens:number}>} valid tiers.
 */
export function contextChoices(parameters) {
    const definition = parameters.find(parameter => parameter.id === CONTEXT_PARAM);
    if (definition === undefined)
        return [];
    const choices = [];
    for (const item of definition.values) {
        const tokens = parseTokenCount(item.value);
        if (tokens !== undefined)
            choices.push({ value: item.value, tokens });
    }
    return choices.sort((left, right) => left.tokens - right.tokens);
}
/**
 * Reasoning definition for one model.
 * @param {Array<{id:string,values:Array<{value:string,displayName?:string}>}>} parameters merged parameters.
 * @returns {object|undefined} the reasoning parameter definition.
 */
export function reasoningDefinition(parameters) {
    for (const id of REASONING_PARAMS) {
        const definition = parameters.find(parameter => parameter.id === id);
        if (definition !== undefined)
            return definition;
    }
    return undefined;
}
/**
 * Fast-tier definition for one model.
 * @param {Array<{id:string,values:Array<{value:string}>}>} parameters merged parameters.
 * @returns {object|undefined} the fast parameter.
 */
export function fastDefinition(parameters) {
    return parameters.find(parameter => parameter.id === FAST_PARAM);
}
/**
 * Whether a model exposes both Fast values.
 * @param {Array<{id:string,values:Array<{value:string}>}>} parameters merged parameters.
 * @returns {boolean} true when Fast can be toggled.
 */
export function fastSwitchable(parameters) {
    const definition = fastDefinition(parameters);
    if (definition === undefined)
        return false;
    const values = new Set(definition.values.map(item => item.value));
    return values.has('false') && values.has('true');
}
/**
 * Default variant declared by the catalog, when present.
 * @param {object} model SDK model item.
 * @returns {object|undefined} the default variant.
 */
export function defaultVariant(model) {
    return (Array.isArray(model?.variants) ? model.variants : []).find(variant => variant?.isDefault === true);
}
const paramOf = (variant, id) => {
    const param = (Array.isArray(variant?.params) ? variant.params : []).find(item => item?.id === id);
    return typeof param?.value === 'string' ? param.value : undefined;
};
/**
 * Normalize one SDK catalog item into the provider's internal shape.
 * @param {object} model SDK model item.
 * @returns {object|null} normalized model, or null for an unusable entry.
 */
export function normalizeModel(model) {
    if (!isRecord(model) || typeof model.id !== 'string' || model.id.trim() === '')
        return null;
    const parameters = parameterDefinitions(model);
    const variants = Array.isArray(model.variants) ? model.variants : [];
    const fallback = defaultVariant(model);
    const reasoning = reasoningDefinition(parameters);
    const contextTier = fallback === undefined ? undefined : paramOf(fallback, CONTEXT_PARAM);
    const defaultEffort = fallback === undefined || reasoning === undefined ? undefined : paramOf(fallback, reasoning.id);
    const defaultFast = fallback === undefined ? undefined : paramOf(fallback, FAST_PARAM);
    const catalogName = typeof model.displayName === 'string' && model.displayName.trim() !== ''
        ? model.displayName.trim()
        : model.id;
    return {
        id: model.id,
        catalogName,
        description: typeof model.description === 'string' ? model.description : undefined,
        aliases: Array.isArray(model.aliases) ? model.aliases.filter(alias => typeof alias === 'string') : [],
        parameters,
        variants,
        contextTiers: contextChoices(parameters),
        defaultContext: contextTier,
        efforts: (reasoning?.values ?? []).map(item => ({
            id: item.value,
            name: typeof item.displayName === 'string' && item.displayName.trim() !== '' ? item.displayName : item.value,
        })),
        defaultEffort,
        fastSwitchable: fastSwitchable(parameters),
        defaultFast,
    };
}
/**
 * Normalize a whole SDK catalog, preserving order and dropping unusable entries.
 * @param {unknown} models SDK catalog.
 * @returns {object[]} normalized models.
 */
export function normalizeCatalog(models) {
    if (!Array.isArray(models))
        return [];
    const seen = new Set();
    const result = [];
    for (const item of models) {
        const model = normalizeModel(item);
        if (model === null || seen.has(model.id))
            continue;
        seen.add(model.id);
        result.push(model);
    }
    return result;
}
/**
 * Find one normalized model by exact id.
 * @param {readonly object[]} catalog normalized models.
 * @param {string} id model id.
 * @returns {object|undefined} the model.
 */
export function findModel(catalog, id) {
    return catalog.find(model => model.id === id);
}
export function buildModelSelection({ id, catalog, reasoningEffort, fast, contextBudget }) {
    const model = findModel(catalog, id);
    if (model === undefined)
        throw new ProviderError('UNKNOWN_MODEL', 'Model is absent from the Cursor account catalog');
    const params = new Map();
    if (fast === true) {
        if (!model.fastSwitchable)
            throw new ProviderError('INVALID_PARAMETER', 'Model declares no switchable Fast parameter');
        params.set(FAST_PARAM, 'true');
    }
    else if (fast === false && model.fastSwitchable) {
        params.set(FAST_PARAM, 'false');
    }
    if (contextBudget !== undefined) {
        if (!Number.isSafeInteger(contextBudget) || contextBudget <= 0) {
            throw new ProviderError('INVALID_PARAMETER', 'Context budget must be a positive integer');
        }
        const choice = model.contextTiers.find(tier => tier.tokens >= contextBudget);
        if (choice === undefined) {
            throw new ProviderError('INVALID_PARAMETER', 'Context budget exceeds the largest declared Cursor context window');
        }
        params.set(CONTEXT_PARAM, choice.value);
    }
    if (reasoningEffort !== undefined) {
        if (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0) {
            throw new ProviderError('INVALID_PARAMETER', 'Reasoning effort must be a non-empty string');
        }
        const parameter = reasoningDefinition(model.parameters);
        if (parameter === undefined)
            throw new ProviderError('INVALID_PARAMETER', 'Model declares no reasoning effort parameter');
        if (!parameter.values.some(value => value.value === reasoningEffort)) {
            throw new ProviderError('INVALID_PARAMETER', 'Reasoning effort is not declared by this model');
        }
        params.set(parameter.id, reasoningEffort);
    }
    const selected = [...params.entries()].map(([paramId, value]) => ({ id: paramId, value }));
    let maxMode;
    if (model.variants.length > 0 && selected.length > 0) {
        const compatible = model.variants.filter(variant => selected.every(param => paramOf(variant, param.id) === param.value));
        if (compatible.length === 0) {
            throw new ProviderError('INVALID_PARAMETER', 'This parameter combination is not offered by the model');
        }
        if (compatible.every(variant => variant.isMaxMode === true))
            maxMode = true;
    }
    return { id, params: selected, ...(maxMode === true ? { maxMode: true } : {}) };
}
/**
 * Effective context window for a selection.
 * @param {object} model normalized model.
 * @param {{params?:Array<{id:string,value:string}>}} [selection] built selection.
 * @returns {number|undefined} context window.
 */
export function selectedContextWindow(model, selection) {
    const value = selection?.params?.find(param => param.id === CONTEXT_PARAM)?.value ?? model.defaultContext;
    if (typeof value !== 'string')
        return undefined;
    return model.contextTiers.find(tier => tier.value === value)?.tokens;
}
/**
 * Default display name for a catalog model.
 * @param {object} model normalized model.
 * @returns {string} display name.
 */
export function defaultModelName(model) {
    const name = model.catalogName;
    return /^cursor(?:\s|$)/i.test(name) ? name : `Cursor ${name}`;
}
export function resolvedModelInfo({ provider, model, row }) {
    const selection = row?.contextBudget === undefined ? undefined : buildModelSelection({
        id: model.id,
        catalog: [model],
        contextBudget: row.contextBudget,
    });
    const contextWindow = selectedContextWindow(model, selection);
    const efforts = model.efforts;
    return {
        provider,
        id: model.id,
        name: row?.name ?? defaultModelName(model),
        ...(model.description === undefined ? {} : { description: model.description }),
        inputModalities: row?.inputModalities ?? ['text'],
        ...(contextWindow === undefined ? {} : { context: { contextWindow } }),
        ...(efforts.length === 0
            ? {}
            : {
                reasoning: {
                    efforts: efforts.map(effort => ({ id: effort.id, name: effort.name })),
                    ...(model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort }),
                },
            }),
    };
}
export function catalogRows({ catalog, settings }) {
    const rows = [];
    for (const model of catalog) {
        const saved = settings?.models?.[model.id];
        rows.push({
            id: model.id,
            catalogName: model.catalogName,
            ...(model.description === undefined ? {} : { description: model.description }),
            selected: saved?.enabled ?? false,
            name: saved?.name ?? defaultModelName(model),
            ...(saved?.contextBudget === undefined ? {} : { contextBudget: saved.contextBudget }),
            fast: saved?.fast === true,
            fastSwitchable: model.fastSwitchable,
            inputModalities: saved?.inputModalities ?? ['text'],
            contextTiers: model.contextTiers,
            efforts: model.efforts,
            ...(model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort }),
        });
    }
    for (const id of Object.keys(settings?.models ?? {})) {
        if (catalog.some(model => model.id === id))
            continue;
        const saved = settings.models[id];
        rows.push({
            id,
            catalogName: id,
            selected: saved.enabled !== false,
            name: saved.name ?? id,
            fast: saved.fast === true,
            fastSwitchable: false,
            inputModalities: saved.inputModalities ?? ['text'],
            contextTiers: [],
            efforts: [],
            missing: true,
        });
    }
    return rows;
}
/**
 * Hash an API key for cache identity. The key itself never becomes a map key.
 * @param {string} apiKey secret.
 * @returns {string} hex digest.
 */
export function catalogKey(apiKey) {
    return createHash('sha256').update(apiKey).digest('hex');
}
/**
 * Cached SDK catalog loader with in-flight deduplication.
 */
export class CatalogCache {
    #ttlMs;
    #max;
    #loadSdk;
    #logger;
    #entries = new Map();
    #inflight = new Map();
    #last;
    /**
     * @param {{loadSdk:()=>Promise<object>, ttlMs?:number, max?:number, logger?:object}} options cache options.
     */
    constructor({ loadSdk, ttlMs = 300_000, max = 8, logger, } = {}) {
        if (typeof loadSdk !== 'function')
            throw new TypeError('loadSdk is required');
        this.#loadSdk = loadSdk;
        this.#ttlMs = ttlMs;
        this.#max = max;
        this.#logger = logger;
    }
    /** Last successful normalized catalog, if any. */
    peek() {
        return this.#last;
    }
    /** Drop every cached catalog. */
    clear() {
        this.#entries.clear();
        this.#last = undefined;
    }
    /**
     * Read one account's catalog.
     * @param {string} apiKey Cursor API key.
     * @param {{signal?:AbortSignal, refresh?:boolean, timeoutMs?:number}} [options] read options.
     * @returns {Promise<object[]>} normalized catalog.
     */
    async get(apiKey, { signal, refresh = false, timeoutMs = 30_000 } = {}) {
        if (typeof apiKey !== 'string' || apiKey.trim() === '') {
            throw new ProviderError('MISSING_CREDENTIAL', 'An explicit Cursor credential is required');
        }
        if (signal?.aborted)
            throw new ProviderError('ABORTED', 'Request cancelled');
        const key = catalogKey(apiKey);
        const now = Date.now();
        const cached = this.#entries.get(key);
        if (!refresh && cached !== undefined && cached.expires > now) {
            this.#last = { models: structuredClone(cached.models), updatedAt: cached.updatedAt };
            return structuredClone(cached.models);
        }
        const pending = this.#inflight.get(key);
        if (pending !== undefined)
            return pending;
        const task = this.#fetch(apiKey, key, timeoutMs, signal);
        this.#inflight.set(key, task);
        try {
            return await task;
        }
        finally {
            if (this.#inflight.get(key) === task)
                this.#inflight.delete(key);
        }
    }
    async #fetch(apiKey, key, timeoutMs, signal) {
        try {
            const sdk = await this.#loadSdk();
            if (sdk?.Cursor?.models?.list === undefined) {
                throw new ProviderError('SDK_UNAVAILABLE', 'Cursor SDK model discovery is unavailable');
            }
            const models = await bounded(() => sdk.Cursor.models.list({ apiKey }), {
                signal,
                timeoutMs,
            });
            const normalized = normalizeCatalog(models);
            const updatedAt = Date.now();
            this.#entries.set(key, { models: normalized, updatedAt, expires: updatedAt + this.#ttlMs });
            while (this.#entries.size > this.#max) {
                const oldest = this.#entries.keys().next().value;
                this.#entries.delete(oldest);
            }
            this.#last = { models: structuredClone(normalized), updatedAt };
            return structuredClone(normalized);
        }
        catch (error) {
            const mapped = mapSdkError(error, signal);
            if (this.#last !== undefined) {
                this.#logger?.warn?.(`cursor catalog refresh failed: ${mapped.message}`);
            }
            throw mapped;
        }
    }
}
