import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemoryStore } from '../memory/store.js';
import { FakeProvider } from '../providers/fake.js';
import { OpenAICompatibleProvider } from '../providers/openai.js';
import { Runtime } from '../runtime/runtime.js';
import { createApp } from './app.js';

try {
  // Node 24 loads the optional local .env; inherited variables take precedence.
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
    throw new Error('Unable to load local configuration', { cause: error });
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const kind = process.env.PROVIDER ?? 'fake';
  if (kind !== 'fake' && kind !== 'openai') throw new Error('Invalid provider');
  const provider =
    kind === 'fake'
      ? new FakeProvider()
      : new OpenAICompatibleProvider({
          baseUrl: process.env.OPENAI_BASE_URL ?? '',
          apiKey: process.env.OPENAI_API_KEY ?? '',
          model: process.env.OPENAI_MODEL ?? '',
        });
  const path = process.env.DATABASE_PATH ?? './data/runtime.sqlite';
  mkdirSync(dirname(path), { recursive: true });
  const store = new MemoryStore(path);
  const app = createApp(new Runtime(store, provider));
  await new Promise<void>((done, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, '127.0.0.1', () => done());
  });
  process.stdout.write(
    `${JSON.stringify({ type: 'server.started', timestamp: new Date().toISOString(), port, provider: provider.name })}\n`,
  );
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close();
    store.close();
  };
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
}

void main().catch(() => {
  process.stderr.write(`${JSON.stringify({ type: 'runtime.error', code: 'STARTUP_FAILED' })}\n`);
  process.exitCode = 1;
});
