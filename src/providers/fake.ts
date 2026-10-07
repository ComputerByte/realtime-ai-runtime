import type { GenerationRequest, GenerationResult, LLMProvider } from './types.js';

/** A deterministic demo, not a general language model. No clock, randomness or network. */
export class FakeProvider implements LLMProvider {
  readonly name = 'fake';

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const message = request.message.trim();
    const arithmetic =
      /^(?:what is\s+|calculate\s+)?(-?\d+(?:\.\d+)?)\s*([+*/-])\s*(-?\d+(?:\.\d+)?)\s*\??$/i.exec(
        message,
      );
    if (arithmetic) {
      return {
        kind: 'tool',
        name: 'calculator',
        input: {
          left: Number(arithmetic[1]),
          operator: arithmetic[2],
          right: Number(arithmetic[3]),
        },
      };
    }
    if (/project codename/i.test(message)) {
      const fact = request.memories.find((item) => item.key === 'project codename');
      return {
        kind: 'response',
        text: fact
          ? `The project codename is ${fact.value}.`
          : 'No project codename is stored. Try: Remember that the project codename is Orion.',
      };
    }
    if (/what (?:did i|was my) (?:just )?(?:say|last message)/i.test(message)) {
      const previous = request.context.findLast((item) => item.role === 'user');
      return {
        kind: 'response',
        text: previous
          ? `Your previous message was: ${previous.content}`
          : 'This session has no previous messages.',
      };
    }
    return {
      kind: 'response',
      text: 'I demonstrate realtime events, explicit SQLite memory, and a bounded calculator. Try “Remember that the project codename is Orion.”, then start a new session and ask for it. Or ask “What is 843 * 27?”',
    };
  }
}
