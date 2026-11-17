/**
 * Conversation projection for the Cursor SDK.
 *
 * DSH owns the conversation and its tools; the SDK receives the history as
 * structured conversation data plus a stable instruction that tool execution
 * belongs to DSH. Images are attached through the SDK's image channel and
 * referenced by an occurrence index in that JSON, so a text-only history path
 * never invents image bytes.
 *
 * @module dsh-cursor/lib/prompt
 */
import { createHash } from 'node:crypto';
import { ProviderError } from './errors.js';
/** Stable first paragraph of every prompt; changing it changes session identity. */
export const PROMPT_INSTRUCTIONS = 'Use registered native tools for actions, never prose tool envelopes. DSH owns tool execution and approval. ' +
    'The following JSON is conversation data in role order.';
const CONTENT_TYPES = new Set(['text', 'reasoning', 'image', 'tool-call']);
/**
 * Whether one user message is a plugin-sourced runtime-context snapshot.
 * @param {object} message DSH message.
 * @returns {boolean} true when the message is not part of the model-visible prefix identity.
 */
export function isRuntimeContext(message) {
    return (message?.role === 'user' &&
        message?.source?.kind === 'runtime-context' &&
        message?.source?.form === 'snapshot');
}
/**
 * Whether one user message was injected by a plugin rather than typed by a
 * human. A native continuation carries only tool results, so these messages
 * ride along inside the first tool result instead of failing the run; that
 * covers runtime-context snapshots and rendered instruction files such as the
 * `agent-instructions` projections of AGENTS.md, which appear mid-turn.
 * @param {object} message DSH message.
 * @returns {boolean} true when the harness, not the human, authored it.
 */
export function isInjectedContext(message) {
    if (message?.role !== 'user')
        return false;
    const kind = message?.source?.kind;
    return kind === 'runtime-context' || kind === 'agent-instructions';
}
/**
 * Remove runtime-context snapshots for prefix identity and suffix delivery.
 * @param {readonly object[]} messages conversation messages.
 * @returns {object[]} stable messages.
 */
export function stableHistory(messages) {
    return messages.filter(message => !isRuntimeContext(message));
}
/**
 * Canonical identity of a message prefix.
 * @param {readonly object[]} messages messages.
 * @returns {string} hex digest.
 */
export function historyIdentity(messages) {
    const projection = messages.map(({ role, content, toolCallId, isError }) => ({
        role,
        content,
        toolCallId,
        isError,
    }));
    return createHash('sha256').update(JSON.stringify(projection)).digest('hex');
}
/**
 * Stable identity of the provider-side conversation configuration.
 * @param {{apiKeyHash:string, model:object, tools:readonly object[], sessionId?:string, system?:string, purpose?:string, toolHistory?:object}} input identity input.
 * @returns {string} hex digest.
 */
export function bridgeIdentity({ apiKeyHash, model, tools, sessionId, system, purpose, toolHistory }) {
    return createHash('sha256')
        .update(JSON.stringify({ apiKeyHash, model, tools, sessionId, system, purpose, toolHistory }))
        .digest('hex');
}
/**
 * Validate the block kinds the provider can carry.
 * @param {readonly object[]} messages conversation messages.
 * @returns {void}
 */
export function validateContent(messages) {
    for (const message of messages) {
        if (!Array.isArray(message?.content)) {
            throw new ProviderError('UNSUPPORTED_CONTENT', 'Every Cursor message must carry a content array');
        }
        for (const block of message.content) {
            if (!CONTENT_TYPES.has(block?.type)) {
                throw new ProviderError('UNSUPPORTED_CONTENT', 'Unsupported Cursor conversation content');
            }
        }
    }
}
const placeholderFor = (block, offloadedImageText) => {
    if (typeof offloadedImageText === 'function') {
        try {
            const text = offloadedImageText(block.attachment);
            if (typeof text === 'string' && text.length > 0)
                return text;
        }
        catch {
            /* Fall back to the local placeholder. */
        }
    }
    const name = block?.attachment?.name;
    return `[image omitted${typeof name === 'string' ? `: ${name}` : ''}]`;
};
/**
 * Project DSH history into SDK-bound messages and image attachments.
 *
 * The returned messages replace every image block with
 * `{type:'image', sdkImage:<1-based occurrence>}`; the image list is sent on
 * the same `send()` as the text prompt.
 *
 * @param {{messages:readonly object[], signal?:AbortSignal}} options request.
 * @param {{attachments?:object, offloadedImageText?:Function}} services DSH services.
 * @returns {Promise<{messages:object[], images:object[]}>} projection.
 */
export async function projectImages(options, { attachments, offloadedImageText, } = {}) {
    const images = [];
    const messages = [];
    const stored = new Map();
    for (const message of options.messages) {
        const content = [];
        for (const block of message.content) {
            if (options.signal?.aborted)
                throw new ProviderError('ABORTED', 'Request cancelled');
            if (block?.type !== 'image') {
                content.push(block);
                continue;
            }
            if (block.offloaded === true) {
                content.push({ type: 'text', text: placeholderFor(block, offloadedImageText) });
                continue;
            }
            const ref = block.attachment;
            if (ref === undefined || typeof ref.attachmentId !== 'string') {
                throw new ProviderError('IMAGE_STORE_UNAVAILABLE', 'Image block has no durable attachment reference');
            }
            if (attachments === undefined || typeof attachments.readImage !== 'function') {
                throw new ProviderError('IMAGE_STORE_UNAVAILABLE', 'DSH attachment service is required to send images');
            }
            let image = stored.get(ref.attachmentId);
            if (image === undefined) {
                try {
                    image = await attachments.readImage(ref, options.signal);
                }
                catch {
                    throw new ProviderError(options.signal?.aborted ? 'ABORTED' : 'IMAGE_READ_FAILED', 'Could not read and verify the DSH image attachment');
                }
                stored.set(ref.attachmentId, image);
            }
            if (options.signal?.aborted)
                throw new ProviderError('ABORTED', 'Request cancelled');
            images.push({
                data: Buffer.from(image.data).toString('base64'),
                mimeType: ref.mediaType,
                dimension: { width: ref.width, height: ref.height },
            });
            content.push({ type: 'image', sdkImage: images.length });
        }
        messages.push({ ...message, content });
    }
    return { messages, images };
}
/**
 * Build the SDK prompt for a fresh conversation or a reused one.
 *
 * @param {{system?:string, messages:readonly object[], toolHistory?:object, images?:readonly object[]}} input prompt input.
 * @returns {string|{text:string, images:object[]}} SDK send payload.
 */
export function buildPrompt({ system, messages, toolHistory, images = [] }) {
    const payload = {
        ...(typeof system === 'string' ? { system } : {}),
        messages,
        toolHistory,
    };
    const imageNote = images.length === 0
        ? '\n'
        : '\nImages attached to this request are numbered from 1 in occurrence order. ' +
            'Each JSON image block sdkImage value identifies its attached image; respect its owning message role and position.\n';
    const text = `${PROMPT_INSTRUCTIONS}${imageNote}${JSON.stringify(payload)}`;
    return images.length === 0 ? text : { text, images: [...images] };
}
/**
 * Build the prompt for messages appended to an already committed SDK agent.
 * @param {readonly object[]} messages appended user messages.
 * @returns {string} SDK send payload.
 */
export function buildSuffixPrompt(messages) {
    const projection = messages.map(({ role, content }) => ({ role, content }));
    return ('Continue the existing conversation. Only these new messages are appended, in role order:\n' +
        JSON.stringify(projection));
}
