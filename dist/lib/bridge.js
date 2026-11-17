/**
 * Host-owned tool bridge for the Cursor SDK.
 *
 * The SDK never executes a DSH tool. Every custom tool callback parks here, the
 * adapter emits a normal DSH tool-call, and the next DSH request resumes the
 * same SDK run with the already-approved result. Continuations are single-use
 * and require the exact call and result; a rewritten history invalidates them.
 *
 * @module dsh-cursor/lib/bridge
 */
import { randomUUID } from 'node:crypto';
import { ProviderError } from './errors.js';
import { isInjectedContext } from './prompt.js';
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/**
 * One in-memory tool handoff batch.
 */
export class NativeBridge {
    #tools;
    #pending = new Map();
    #closed = false;
    #validate;
    #notify;
    /** SDK custom-tool callbacks parked until DSH resumes them with results. */
    customTools;
    /**
     * @param {{tools:readonly object[], validate?:(schema:object,args:object)=>boolean, notify:(event:object)=>void}} options bridge options.
     */
    constructor({ tools, validate, notify }) {
        if (!Array.isArray(tools))
            throw new TypeError('tools must be an array');
        if (new Set(tools.map(tool => tool.name)).size !== tools.length) {
            throw new ProviderError('INVALID_TOOLS', 'Native tool names must be unique');
        }
        this.#tools = tools;
        this.#validate = validate ?? (() => true);
        this.#notify = notify;
        this.customTools = Object.fromEntries(tools.map(tool => [
            tool.name,
            {
                description: `${tool.name}: ${tool.description ?? ''}`,
                inputSchema: tool.parameters,
                execute: (args, context) => this.#request(tool, args, context),
            },
        ]));
    }
    /** @returns {readonly object[]} bridged tool schemas. */
    get tools() {
        return this.#tools;
    }
    /** @returns {number} pending callback count. */
    get pendingCount() {
        return this.#pending.size;
    }
    #request(tool, args, context) {
        if (this.#closed)
            return Promise.reject(new ProviderError('ABORTED', 'Tool bridge closed'));
        if (!isRecord(args) || this.#validate(tool.parameters, args) !== true) {
            const error = new ProviderError('INVALID_ARGUMENTS', 'Native tool arguments do not match the active schema');
            this.#notify({ type: 'failure', error });
            return Promise.reject(error);
        }
        const id = randomUUID();
        const encoded = JSON.stringify(args);
        return new Promise((resolve, reject) => {
            this.#pending.set(id, { resolve, reject, name: tool.name, arguments: encoded, sdkId: context?.toolCallId });
            this.#notify({ type: 'tool-call', id, name: tool.name, arguments: encoded });
        });
    }
    /**
     * Match the exact DSH tool result for every pending call.
     * @param {readonly object[]} messages DSH conversation.
     * @param {readonly string[]} ids pending call ids in delivery order.
     * @returns {Array<[string, object, object]>} id, pending entry, result message.
     */
    results(messages, ids = [...this.#pending.keys()]) {
        const owner = messages.findLastIndex(message => message.role === 'assistant' &&
            Array.isArray(message.content) &&
            message.content.some(block => block.type === 'tool-call' && this.#pending.has(block.id)));
        const tail = owner < 0 ? [] : messages.slice(owner + 1);
        if (owner < 0 || tail.some(message => message.role !== 'tool' && !isInjectedContext(message))) {
            throw new ProviderError('TOOL_RESULT_MISMATCH', 'Native continuation requires matching tool results and sourced runtime context');
        }
        if (tail.some(message => message.role === 'tool' && !ids.includes(message.toolCallId))) {
            throw new ProviderError('TOOL_RESULT_MISMATCH', 'Unexpected native tool result');
        }
        const updates = messages.filter(isInjectedContext).map(({ role, content }) => ({ role, content }));
        return ids.map((id, index) => {
            const pending = this.#pending.get(id);
            if (pending === undefined)
                throw new ProviderError('TOOL_RESULT_MISMATCH', 'Native callback is no longer pending');
            const matches = tail.filter(message => message.role === 'tool' && message.toolCallId === id);
            const result = matches.length === 1 ? matches[0] : undefined;
            const call = messages
                .flatMap(message => (message.role === 'assistant' ? message.content : []))
                .find(block => block.type === 'tool-call' && block.id === id);
            if (result === undefined || call === undefined || call.name !== pending.name || call.arguments !== pending.arguments) {
                throw new ProviderError('TOOL_RESULT_MISMATCH', 'Pending native tool calls require their exact DSH call and result');
            }
            return [
                id,
                pending,
                index === 0 && updates.length > 0
                    ? {
                        ...result,
                        content: [
                            ...result.content,
                            {
                                type: 'text',
                                text: 'DSH runtime-context and instruction updates after this tool call (conversation data, not tool output):\n' +
                                    JSON.stringify(updates),
                            },
                        ],
                    }
                    : result,
            ];
        });
    }
    /**
     * Resolve every pending callback with its exact DSH tool result.
     * @param {readonly object[]} messages DSH conversation.
     * @param {readonly string[]} ids pending ids.
     * @returns {void}
     */
    resume(messages, ids) {
        for (const [id, pending, result] of this.results(messages, ids)) {
            this.#pending.delete(id);
            pending.resolve({
                content: result.content.map(block => {
                    if (block.type === 'text')
                        return { type: 'text', text: block.text };
                    if (block.type === 'image' && block.sdkData !== undefined) {
                        return { type: 'image', data: block.sdkData.data, mimeType: block.sdkData.mimeType };
                    }
                    if (block.type === 'image')
                        return { type: 'text', text: '[image tool result omitted]' };
                    return { type: 'text', text: JSON.stringify(block) };
                }),
                isError: result.isError === true,
            });
        }
    }
    /** Reject every pending callback and refuse new ones. */
    close() {
        this.#closed = true;
        for (const pending of this.#pending.values()) {
            pending.reject(new ProviderError('ABORTED', 'Tool bridge cancelled'));
        }
        this.#pending.clear();
    }
}
