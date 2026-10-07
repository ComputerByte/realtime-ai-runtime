import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { WebSocket } from 'ws';
import { createApp } from '../src/server/app.js';
import { MemoryStore } from '../src/memory/store.js';
import { FakeProvider } from '../src/providers/fake.js';
import { Runtime, type RuntimePacket } from '../src/runtime/runtime.js';

async function fixture() {
  const store = new MemoryStore(':memory:');
  const app = createApp(new Runtime(store, new FakeProvider(), undefined, () => {}));
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as AddressInfo).port;
  return {
    ...app,
    store,
    port,
    async dispose() {
      await app.close();
      store.close();
    },
  };
}

function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const packets: RuntimePacket[] = [];
  const waiters = new Set<() => void>();
  ws.on('message', (data) => {
    packets.push(JSON.parse(data.toString()) as RuntimePacket);
    for (const wake of waiters) wake();
  });
  const wait = (predicate: (packet: RuntimePacket) => boolean): Promise<RuntimePacket> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error('Packet timeout'));
      }, 2000);
      const check = () => {
        const found = packets.find(predicate);
        if (found) {
          clearTimeout(timer);
          waiters.delete(check);
          resolve(found);
        }
      };
      waiters.add(check);
      check();
    });
  return { ws, packets, wait };
}

test('WebSocket conversation, tool events, reset and durable recall work through real frames', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const client = connect(f.port);
  const first = await client.wait(
    (packet) => packet.type === 'event' && packet.event.type === 'session.started',
  );
  assert.equal(first.type, 'event');
  client.ws.send(JSON.stringify({ type: 'chat', text: 'What is 843 * 27?' }));
  const response = await client.wait((packet) => packet.type === 'response');
  assert.equal((response as { text: string }).text, 'The result is 22761.');
  client.packets.length = 0;
  client.ws.send(
    JSON.stringify({ type: 'chat', text: 'Remember that the project codename is Orion.' }),
  );
  await client.wait((packet) => packet.type === 'response');
  client.packets.length = 0;
  client.ws.send(JSON.stringify({ type: 'session.reset' }));
  const next = await client.wait(
    (packet) => packet.type === 'event' && packet.event.type === 'session.started',
  );
  assert.ok(first.type === 'event' && next.type === 'event');
  assert.notEqual(first.event.sessionId, next.event.sessionId);
  const memory = await client.wait((packet) => packet.type === 'memory');
  assert.ok(memory.type === 'memory');
  assert.equal(memory.facts[0]?.value, 'Orion');
  client.ws.send(JSON.stringify({ type: 'chat', text: 'What is the project codename?' }));
  const recall = await client.wait((packet) => packet.type === 'response');
  assert.equal((recall as { text: string }).text, 'The project codename is Orion.');
  const events = f.store.events(first.event.sessionId);
  assert.ok(events.some((event) => event.type === 'tool.completed'));
  assert.deepEqual(
    f.store.events(next.event.sessionId).map((event) => event.type),
    [
      'session.started',
      'chat.received',
      'cognition.started',
      'memory.read',
      'cognition.completed',
      'response.completed',
    ],
  );
});

test('malformed, binary, oversized text and unknown client actions are rejected without cognition', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const client = connect(f.port);
  const start = await client.wait(
    (packet) => packet.type === 'event' && packet.event.type === 'session.started',
  );
  for (const message of [
    '{',
    JSON.stringify({ type: 'chat', text: '' }),
    JSON.stringify({ type: 'chat', text: 'x'.repeat(2001) }),
    JSON.stringify({ type: 'shell' }),
    JSON.stringify({ type: 'chat', text: 'hello', extra: true }),
    Buffer.from('binary'),
  ]) {
    client.packets.length = 0;
    client.ws.send(message);
    assert.deepEqual(await client.wait((packet) => packet.type === 'error'), {
      type: 'error',
      code: 'INVALID_MESSAGE',
    });
  }
  assert.ok(start.type === 'event');
  assert.ok(
    !f.store.events(start.event.sessionId).some((event) => event.type === 'cognition.started'),
  );
});

test('cross-origin WebSocket and non-local Host are denied; health is sanitized', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const health = await fetch(`http://127.0.0.1:${f.port}/health`);
  assert.deepEqual(await health.json(), { status: 'ok', provider: 'fake' });
  // Use http.request: Node's fetch normalizes Host to the destination.
  const deniedStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      `http://127.0.0.1:${f.port}/health`,
      { headers: { Host: 'attacker.example' } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    req.once('error', reject);
    req.end();
  });
  assert.equal(deniedStatus, 403);
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}/ws`, { origin: 'https://attacker.example' });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => reject(new Error('Unexpected origin accepted')));
    ws.once('error', (error) => {
      assert.match(error.message, /403/);
      resolve();
    });
  });
});

test('frame-size and message-rate limits close clients', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  for (const scenario of ['size', 'rate']) {
    const client = connect(f.port);
    await client.wait(
      (packet) => packet.type === 'event' && packet.event.type === 'session.started',
    );
    const closed = new Promise<number>((resolve) =>
      client.ws.once('close', (code) => resolve(code)),
    );
    if (scenario === 'size') client.ws.send('x'.repeat(9000));
    else for (let i = 0; i < 21; i++) client.ws.send(JSON.stringify({ type: 'invalid' }));
    assert.equal(await closed, scenario === 'size' ? 1009 : 1008);
  }
});
