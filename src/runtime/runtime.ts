import { randomUUID } from 'node:crypto';
import { CONTEXT_LIMIT, decide, explicitFact } from '../cognition/decide.js';
import type { EventPayloads, EventType, RuntimeEvent } from '../events/types.js';
import type { Fact, MemoryStore } from '../memory/store.js';
import type { LLMProvider, Message } from '../providers/types.js';
import { ToolExecutor } from '../tools/calculator.js';

export interface Session {
  id: string;
  context: Message[];
  busy: boolean;
}
export type RuntimePacket =
  | { type: 'event'; event: RuntimeEvent }
  | { type: 'response'; correlationId: string; text: string }
  | { type: 'memory'; facts: Fact[] }
  | { type: 'error'; code: string };
export type Publish = (packet: RuntimePacket) => void;

export class Runtime {
  constructor(
    readonly store: MemoryStore,
    readonly provider: LLMProvider,
    private readonly tools = new ToolExecutor(),
    private readonly log: (event: RuntimeEvent) => void = (event) =>
      process.stdout.write(`${JSON.stringify(event)}\n`),
    private readonly providerTimeoutMs = 10000,
  ) {}

  private emit<K extends EventType>(
    session: Session,
    correlationId: string,
    type: K,
    payload: EventPayloads[K],
    publish: Publish,
  ): void {
    const event = {
      id: randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      correlationId,
      payload,
    } as RuntimeEvent;
    this.store.appendEvent(event); // durable order before publication
    this.log(event);
    publish({ type: 'event', event });
  }

  start(publish: Publish): Session {
    const session: Session = { id: randomUUID(), context: [], busy: false };
    this.emit(session, randomUUID(), 'session.started', { provider: this.provider.name }, publish);
    publish({ type: 'memory', facts: this.store.list() });
    return session;
  }

  reject(session: Session, code: string, publish: Publish): void {
    this.emit(session, randomUUID(), 'runtime.error', { code }, publish);
    publish({ type: 'error', code });
  }

  async chat(session: Session, message: string, publish: Publish): Promise<void> {
    if (session.busy) {
      this.reject(session, 'BUSY', publish);
      return;
    }
    session.busy = true;
    const correlationId = randomUUID();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.emit(session, correlationId, 'chat.received', { characters: message.length }, publish);
      this.emit(
        session,
        correlationId,
        'cognition.started',
        { contextMessages: session.context.length },
        publish,
      );
      this.emit(
        session,
        correlationId,
        'memory.read',
        { count: this.store.list().length },
        publish,
      );
      const started = performance.now();
      const fact = explicitFact(message);
      let text: string;
      if (fact) {
        this.store.write(fact.key, fact.value);
        this.emit(
          session,
          correlationId,
          'memory.written',
          { count: this.store.list().length },
          publish,
        );
        publish({ type: 'memory', facts: this.store.list() });
        this.emit(
          session,
          correlationId,
          'cognition.completed',
          { providerLatencyMs: 0, action: 'response' },
          publish,
        );
        text = `Remembered: ${fact.key} is ${fact.value}. This fact survives a new session and application restart.`;
      } else {
        const result = await Promise.race([
          decide(this.provider, this.store, message, session.context, controller.signal),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error('Provider timeout'));
            }, this.providerTimeoutMs);
          }),
        ]);
        clearTimeout(timer);
        this.emit(
          session,
          correlationId,
          'cognition.completed',
          {
            providerLatencyMs: Math.round(performance.now() - started),
            action: result.kind,
          },
          publish,
        );
        if (result.kind === 'tool') {
          const tool = result.name === 'calculator' ? 'calculator' : 'unknown';
          this.emit(session, correlationId, 'tool.requested', { tool }, publish);
          const outcome = await this.tools.run(result.name, result.input);
          this.emit(
            session,
            correlationId,
            'tool.completed',
            outcome.ok
              ? { tool, outcome: 'success', result: outcome.value }
              : { tool, outcome: 'error', code: outcome.code },
            publish,
          );
          // One tool maximum, no recursive model loop. Result is rendered deterministically.
          text = outcome.ok
            ? `The result is ${outcome.value}.`
            : `The calculator could not complete that request (${outcome.code}).`;
        } else text = result.text;
      }
      session.context.push(
        { role: 'user', content: message },
        { role: 'assistant', content: text },
      );
      session.context.splice(0, Math.max(0, session.context.length - CONTEXT_LIMIT));
      this.emit(session, correlationId, 'response.completed', { characters: text.length }, publish);
      publish({ type: 'response', correlationId, text });
    } catch {
      // Never expose provider errors, URLs, credentials, prompts or stack traces.
      this.emit(session, correlationId, 'runtime.error', { code: 'REQUEST_FAILED' }, publish);
      publish({ type: 'error', code: 'REQUEST_FAILED' });
    } finally {
      clearTimeout(timer);
      controller.abort();
      session.busy = false;
    }
  }
}
