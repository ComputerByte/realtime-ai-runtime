import type { MemoryStore } from '../memory/store.js';
import {
  generationResult,
  type GenerationResult,
  type LLMProvider,
  type Message,
} from '../providers/types.js';
import { calculatorDefinition } from '../tools/calculator.js';

export const SYSTEM_INSTRUCTION =
  'Nova is a concise demo assistant used to demonstrate a realtime AI runtime.';
export const CONTEXT_LIMIT = 12;

// Explicit, deterministic application behavior; provider output cannot write memory.
export function explicitFact(message: string): { key: string; value: string } | undefined {
  const match = /^remember that (?:the )?([a-z][a-z0-9 ]{0,79}?) is (.{1,200}?)\.?$/i.exec(
    message.trim(),
  );
  if (!match) return undefined;
  return { key: match[1]!.trim().toLowerCase(), value: match[2]!.trim() };
}

export async function decide(
  provider: LLMProvider,
  store: MemoryStore,
  message: string,
  context: readonly Message[],
  signal: AbortSignal,
): Promise<GenerationResult> {
  return generationResult.parse(
    await provider.generate({
      system: SYSTEM_INSTRUCTION,
      message,
      context: context.slice(-CONTEXT_LIMIT),
      memories: store.list(),
      tool: calculatorDefinition,
      signal,
    }),
  );
}
