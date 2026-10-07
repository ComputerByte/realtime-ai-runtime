import { z } from 'zod';
import type { Fact } from '../memory/store.js';
import type { calculatorDefinition } from '../tools/calculator.js';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}
export interface GenerationRequest {
  system: string;
  message: string;
  context: readonly Message[];
  memories: readonly Fact[];
  tool: typeof calculatorDefinition;
  signal: AbortSignal;
}
export const generationResult = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('response'), text: z.string().trim().min(1).max(4000) }),
  z.strictObject({ kind: z.literal('tool'), name: z.string().max(64), input: z.unknown() }),
]);
export type GenerationResult = z.infer<typeof generationResult>;
export interface LLMProvider {
  readonly name: string;
  generate(request: GenerationRequest): Promise<GenerationResult>;
}
