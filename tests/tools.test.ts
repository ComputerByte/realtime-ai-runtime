import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolExecutor } from '../src/tools/calculator.js';

test('calculator computes four finite operations without an expression evaluator', async () => {
  const tools = new ToolExecutor();
  for (const [operator, value] of [
    ['+', 9],
    ['-', 3],
    ['*', 18],
    ['/', 2],
  ] as const) {
    assert.deepEqual(await tools.run('calculator', { left: 6, operator, right: 3 }), {
      ok: true,
      value,
    });
  }
});

test('unknown capabilities and malformed inputs never execute', async () => {
  let executed = false;
  const tools = new ToolExecutor(async () => {
    executed = true;
    return 1;
  });
  assert.deepEqual(await tools.run('shell', {}), { ok: false, code: 'UNKNOWN_TOOL' });
  for (const input of [
    null,
    '1 + 2',
    {},
    { left: '1', operator: '+', right: 2 },
    { left: Infinity, operator: '+', right: 2 },
    { left: 1e13, operator: '+', right: 2 },
    { left: 1, operator: '**', right: 2 },
    { left: 1, operator: '+', right: 2, script: 'bad' },
  ]) {
    assert.deepEqual(await tools.run('calculator', input), { ok: false, code: 'INVALID_INPUT' });
  }
  assert.equal(executed, false);
});

test('division by zero and executor failure return structured errors', async () => {
  assert.deepEqual(
    await new ToolExecutor().run('calculator', { left: 1, operator: '/', right: 0 }),
    { ok: false, code: 'EXECUTION_FAILED' },
  );
  for (const executor of [
    async () => {
      throw new Error('secret');
    },
    async () => NaN,
  ]) {
    assert.deepEqual(
      await new ToolExecutor(executor).run('calculator', { left: 1, operator: '+', right: 2 }),
      { ok: false, code: 'EXECUTION_FAILED' },
    );
  }
});

test('tool timeout returns without waiting for a pending executor', async () => {
  const tools = new ToolExecutor(() => new Promise(() => {}), 5);
  assert.deepEqual(await tools.run('calculator', { left: 1, operator: '+', right: 2 }), {
    ok: false,
    code: 'TIMEOUT',
  });
});
