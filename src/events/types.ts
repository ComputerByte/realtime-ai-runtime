export interface EventPayloads {
  'session.started': { provider: string };
  'chat.received': { characters: number };
  'cognition.started': { contextMessages: number };
  'memory.read': { count: number };
  'memory.written': { count: number };
  'cognition.completed': { providerLatencyMs: number; action: 'response' | 'tool' };
  'tool.requested': { tool: 'calculator' | 'unknown' };
  'tool.completed': {
    tool: 'calculator' | 'unknown';
    outcome: 'success' | 'error';
    code?: string;
    result?: number;
  };
  'response.completed': { characters: number };
  'runtime.error': { code: string };
}

export type EventType = keyof EventPayloads;
export type RuntimeEvent = {
  [K in EventType]: {
    id: string;
    type: K;
    timestamp: string;
    sessionId: string;
    correlationId: string;
    payload: EventPayloads[K];
  };
}[EventType];
