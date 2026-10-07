import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTEXT_LIMIT, explicitFact, SYSTEM_INSTRUCTION } from '../src/cognition/decide.js';
import { MemoryStore } from '../src/memory/store.js';
import { FakeProvider } from '../src/providers/fake.js';
import type { GenerationRequest, LLMProvider } from '../src/providers/types.js';
import { Runtime, type RuntimePacket } from '../src/runtime/runtime.js';
import { calculatorDefinition } from '../src/tools/calculator.js';

function fixture(provider: LLMProvider = new FakeProvider(), timeout = 10000) {
  const store = new MemoryStore(':memory:');
  const packets: RuntimePacket[] = [];
  const logs: unknown[] = [];
  const runtime = new Runtime(store, provider, undefined, (event) => logs.push(event), timeout);
  const publish = (packet: RuntimePacket) => {
    packets.push(packet);
  };
  const session = runtime.start(publish);
  return { store, runtime, packets, logs, publish, session };
}

test('FakeProvider is deterministic for the complete demo with no credentials', async () => {
  const provider = new FakeProvider();
  const base: GenerationRequest = {
    system: SYSTEM_INSTRUCTION,
    message: '',
    context: [],
    memories: [],
    tool: calculatorDefinition,
    signal: new AbortController().signal,
  };
  for (const message of [
    'What can this runtime do?',
    'What is 843 * 27?',
    'What is the project codename?',
  ]) {
    const request = {
      ...base,
      message,
      memories: [
        { id: '1', key: 'project codename', value: 'Orion', createdAt: '', updatedAt: '' },
      ],
    };
    assert.deepEqual(await provider.generate(request), await provider.generate(request));
  }
  assert.deepEqual(await provider.generate({ ...base, message: 'What is 843 * 27?' }), {
    kind: 'tool',
    name: 'calculator',
    input: { left: 843, operator: '*', right: 27 },
  });
  assert.deepEqual(await provider.generate({ ...base, message: 'What is the project codename?' }), {
    kind: 'response',
    text: 'No project codename is stored. Try: Remember that the project codename is Orion.',
  });
});

test('integration: cognition → validated calculator → response → durable ordered events', async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  await f.runtime.chat(f.session, 'What is 843 * 27?', f.publish);
  const events = f.store.events(f.session.id);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'session.started',
      'chat.received',
      'cognition.started',
      'memory.read',
      'cognition.completed',
      'tool.requested',
      'tool.completed',
      'response.completed',
    ],
  );
  const turn = events.slice(1);
  assert.equal(new Set(turn.map((event) => event.correlationId)).size, 1);
  assert.equal(new Set(events.map((event) => event.id)).size, events.length);
  assert.ok(events.every((event) => event.sessionId === f.session.id));
  assert.deepEqual(turn.find((event) => event.type === 'tool.completed')?.payload, {
    tool: 'calculator',
    outcome: 'success',
    result: 22761,
  });
  assert.equal(f.packets.at(-1)?.type, 'response');
  assert.deepEqual(f.packets.at(-1), {
    type: 'response',
    correlationId: turn[0]!.correlationId,
    text: 'The result is 22761.',
  });
  assert.deepEqual(
    events,
    f.packets.filter((packet) => packet.type === 'event').map((packet) => packet.event),
  );
});

test('integration: explicit memory write → new session → recall, then database reopen', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-reference-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'memory.sqlite');
  let store = new MemoryStore(path);
  const packets: RuntimePacket[] = [];
  const publish = (packet: RuntimePacket) => {
    packets.push(packet);
  };
  let runtime = new Runtime(store, new FakeProvider(), undefined, () => {});
  const first = runtime.start(publish);
  await runtime.chat(first, 'Remember that the project codename is Orion.', publish);
  assert.equal(store.list()[0]?.value, 'Orion');
  const savedEventId = store.events(first.id).at(-1)!.id;
  const second = runtime.start(publish);
  assert.notEqual(first.id, second.id);
  assert.equal(second.context.length, 0);
  await runtime.chat(second, 'What is the project codename?', publish);
  assert.equal((packets.at(-1) as { text: string }).text, 'The project codename is Orion.');
  store.close();
  store = new MemoryStore(path);
  t.after(() => store.close());
  assert.equal(store.events(first.id).at(-1)?.id, savedEventId);
  runtime = new Runtime(store, new FakeProvider(), undefined, () => {});
  const third = runtime.start(publish);
  await runtime.chat(third, 'What is the project codename?', publish);
  assert.equal((packets.at(-1) as { text: string }).text, 'The project codename is Orion.');
});

test('bounded recent context contains at most twelve prior messages and no current-message duplication', async (t) => {
  const requests: GenerationRequest[] = [];
  const f = fixture({
    name: 'test',
    async generate(request) {
      requests.push({ ...request, context: [...request.context] });
      return { kind: 'response', text: 'Acknowledged.' };
    },
  });
  t.after(() => f.store.close());
  for (let i = 0; i < 10; i++) await f.runtime.chat(f.session, `Message ${i}`, f.publish);
  assert.equal(f.session.context.length, CONTEXT_LIMIT);
  const last = requests.at(-1)!;
  assert.equal(last.context.length, CONTEXT_LIMIT);
  assert.equal(last.context[0]?.content, 'Message 3');
  assert.equal(last.context.at(-2)?.content, 'Message 8');
  assert.ok(!last.context.some((message) => message.content === 'Message 9'));
  assert.deepEqual(last.memories, []);
});

test('provider failure is sanitized, unlocks session, and never stores failed conversation', async (t) => {
  const f = fixture({
    name: 'test',
    async generate() {
      throw new Error('secret-provider-key https://private.example');
    },
  });
  t.after(() => f.store.close());
  await f.runtime.chat(f.session, 'private user text', f.publish);
  assert.equal(f.session.busy, false);
  assert.deepEqual(f.session.context, []);
  assert.deepEqual(f.packets.at(-1), { type: 'error', code: 'REQUEST_FAILED' });
  for (const output of [f.logs, f.store.events(f.session.id)]) {
    assert.doesNotMatch(
      JSON.stringify(output),
      /secret-provider-key|private\.example|private user text/,
    );
  }
});

test('provider deadline also bounds an adapter that ignores cancellation', async (t) => {
  let signal: AbortSignal | undefined;
  const f = fixture(
    {
      name: 'test',
      generate(request) {
        signal = request.signal;
        return new Promise(() => {});
      },
    },
    5,
  );
  t.after(() => f.store.close());
  await f.runtime.chat(f.session, 'hello', f.publish);
  assert.equal(signal?.aborted, true);
  assert.equal(f.session.busy, false);
  assert.deepEqual(f.packets.at(-1), { type: 'error', code: 'REQUEST_FAILED' });
});

test('concurrent requests are rejected without interleaving cognition', async (t) => {
  let complete!: () => void;
  const f = fixture({
    name: 'test',
    async generate() {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return { kind: 'response', text: 'Done.' };
    },
  });
  t.after(() => f.store.close());
  const first = f.runtime.chat(f.session, 'first', f.publish);
  await f.runtime.chat(f.session, 'second', f.publish);
  assert.deepEqual(f.packets.at(-1), { type: 'error', code: 'BUSY' });
  complete();
  await first;
  assert.deepEqual(
    f.session.context.map((message) => message.content),
    ['first', 'Done.'],
  );
});

test('explicit memory grammar is small, upserts preserve identity, and facts are bounded', (t) => {
  assert.deepEqual(explicitFact('Remember that the project codename is Orion.'), {
    key: 'project codename',
    value: 'Orion',
  });
  assert.equal(explicitFact('Please infer a memory from this message'), undefined);
  const f = fixture();
  t.after(() => f.store.close());
  f.store.write('project codename', "Orion'; DROP TABLE facts;--");
  const before = f.store.list()[0]!;
  f.store.write('project codename', 'Atlas');
  assert.equal(f.store.list()[0]?.id, before.id);
  assert.equal(f.store.list()[0]?.createdAt, before.createdAt);
  assert.equal(f.store.list()[0]?.value, 'Atlas');
  assert.throws(() => f.store.write('key', 'x'.repeat(201)));
  for (let i = 0; i < 31; i++) f.store.write(`fact ${i}`, `${i}`);
  assert.throws(() => f.store.write('extra', 'value'), /Memory limit/);
  f.store.write('project codename', 'Orion');
  assert.equal(f.store.list().length, 32);
});

test('provider cannot write memory or expose unknown tool names through events', async (t) => {
  const f = fixture({
    name: 'test',
    async generate() {
      return { kind: 'tool', name: 'secret-shell-name', input: { command: 'secret' } };
    },
  });
  t.after(() => f.store.close());
  await f.runtime.chat(f.session, 'hello', f.publish);
  assert.deepEqual(f.store.list(), []);
  assert.doesNotMatch(JSON.stringify(f.logs), /secret-shell-name|command/);
  assert.deepEqual(
    f.store.events(f.session.id).find((event) => event.type === 'tool.completed')?.payload,
    {
      tool: 'unknown',
      outcome: 'error',
      code: 'UNKNOWN_TOOL',
    },
  );
});
