import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenAICompatibleProvider } from '../src/providers/openai.js';
import { SYSTEM_INSTRUCTION } from '../src/cognition/decide.js';
import { calculatorDefinition } from '../src/tools/calculator.js';
import type { GenerationRequest } from '../src/providers/types.js';

const config = {
  baseUrl: 'https://provider.example/v1',
  apiKey: 'test-placeholder',
  model: 'demo-placeholder',
};
const request: GenerationRequest = {
  system: SYSTEM_INSTRUCTION,
  message: 'What is 843 * 27?',
  context: [],
  memories: [],
  tool: calculatorDefinition,
  signal: new AbortController().signal,
};

test('optional provider uses a fixed endpoint and passes only a validated proposal', async (t) => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              kind: 'tool',
              name: 'calculator',
              input: { left: 843, operator: '*', right: 27 },
            }),
          },
        },
      ],
    });
  });
  const result = await new OpenAICompatibleProvider(config).generate(request);
  assert.equal(capturedUrl, 'https://provider.example/v1/chat/completions');
  assert.equal(capturedInit?.redirect, 'error');
  assert.equal(capturedInit?.signal, request.signal);
  assert.deepEqual(result, {
    kind: 'tool',
    name: 'calculator',
    input: { left: 843, operator: '*', right: 27 },
  });
});

test('optional provider rejects HTTP failure, malformed results, extra capabilities and large bodies', async (t) => {
  let next = Response.json({}, { status: 401 });
  t.mock.method(globalThis, 'fetch', async () => next);
  const provider = new OpenAICompatibleProvider(config);
  await assert.rejects(() => provider.generate(request), /Provider request failed/);
  next = Response.json({ choices: [{ message: { content: '{' } }] });
  await assert.rejects(() => provider.generate(request));
  next = Response.json({
    choices: [
      {
        message: {
          content: JSON.stringify({
            kind: 'response',
            text: 'Hi',
            memoryWrite: { key: 'bad', value: 'bad' },
          }),
        },
      },
    ],
  });
  await assert.rejects(() => provider.generate(request));
  next = new Response('x'.repeat(65537));
  await assert.rejects(() => provider.generate(request), /too large/);
});

test('optional provider configuration cannot include credentials in URLs or plaintext HTTP', () => {
  for (const baseUrl of [
    'http://provider.example/v1',
    'https://user:pass@provider.example/v1',
    'https://provider.example/v1?key=bad',
  ]) {
    assert.throws(() => new OpenAICompatibleProvider({ ...config, baseUrl }));
  }
  assert.throws(() => new OpenAICompatibleProvider({ ...config, apiKey: '' }));
});
