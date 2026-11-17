import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildPrompt,
  buildSuffixPrompt,
  historyIdentity,
  projectImages,
  PROMPT_INSTRUCTIONS,
} from '../lib/prompt.js'

const userMessage = content => ({ role: 'user', content })

/** Built prompts are doubles of the SDK payload; assertions read either shape. */
const asPrompt = (value: string | object): string & { text: string; images: object[] } =>
  value as unknown as string & { text: string; images: object[] }

test('buildPrompt embeds system, messages, and tool history as conversation data', () => {
  const prompt = asPrompt(buildPrompt({
    system: 'Be brief',
    messages: [userMessage([{ type: 'text', text: 'hello' }])],
    toolHistory: { tools: [] },
  }))
  assert.ok(prompt.startsWith(PROMPT_INSTRUCTIONS))
  assert.match(prompt, /"system":"Be brief"/)
  assert.match(prompt, /"text":"hello"/)
})

test('buildPrompt returns an SDK image payload when images exist', () => {
  const prompt = asPrompt(buildPrompt({
    messages: [userMessage([{ type: 'image', sdkImage: 1 }])],
    images: [{ data: 'abc', mimeType: 'image/png', dimension: { width: 1, height: 1 } }],
  }))
  assert.equal(typeof prompt, 'object')
  assert.equal(prompt.images.length, 1)
  assert.match(prompt.text, /numbered from 1/)
})

test('projectImages replaces image blocks with occurrence indexes', async () => {
  const attachments = {
    async readImage(ref) {
      return { data: Buffer.from('bytes') }
    },
  }
  const result = await projectImages(
    {
      messages: [userMessage([
        { type: 'text', text: 'look' },
        { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', width: 2, height: 3 } },
        { type: 'image', attachment: { attachmentId: 'a2', mediaType: 'image/jpeg', width: 2, height: 3 } },
      ])],
    },
    { attachments },
  )
  assert.equal(result.images.length, 2)
  assert.equal(result.images[0].data, Buffer.from('bytes').toString('base64'))
  assert.deepEqual(result.messages[0].content[1], { type: 'image', sdkImage: 1 })
  assert.deepEqual(result.messages[0].content[2], { type: 'image', sdkImage: 2 })
})

test('projectImages replaces offloaded images with text', async () => {
  const result = await projectImages(
    {
      messages: [userMessage([{ type: 'image', offloaded: true, attachment: { attachmentId: 'a', name: 'a.png' } }])],
    },
    { offloadedImageText: () => '[offloaded image]' },
  )
  assert.deepEqual(result.messages[0].content[0], { type: 'text', text: '[offloaded image]' })
})

test('projectImages refuses images without an attachment service', async () => {
  await assert.rejects(
    () =>
      projectImages(
        {
          messages: [userMessage([{ type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', width: 1, height: 1 } }])],
        },
        {},
      ),
    /attachment service/,
  )
})

test('historyIdentity is stable and ignores runtime context', () => {
  const a = [userMessage([{ type: 'text', text: 'x' }])]
  const b = [userMessage([{ type: 'text', text: 'x' }])]
  assert.equal(historyIdentity(a), historyIdentity(b))
})

test('buildSuffixPrompt lists only appended messages', () => {
  const suffix = buildSuffixPrompt([
    { role: 'user', content: [{ type: 'text', text: 'again' }] },
  ])
  assert.match(suffix, /Continue the existing conversation/)
  assert.match(suffix, /again/)
})
