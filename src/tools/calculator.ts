import { z } from 'zod';

export const calculatorInput = z.strictObject({
  left: z.number().finite().min(-1e12).max(1e12),
  operator: z.enum(['+', '-', '*', '/']),
  right: z.number().finite().min(-1e12).max(1e12),
});
export type CalculatorInput = z.infer<typeof calculatorInput>;
export type ToolResult =
  | { ok: true; value: number }
  | { ok: false; code: 'UNKNOWN_TOOL' | 'INVALID_INPUT' | 'TIMEOUT' | 'EXECUTION_FAILED' };

export const calculatorDefinition = {
  name: 'calculator',
  description: 'Compute one arithmetic operation on two finite numbers between -1e12 and 1e12.',
  timeoutMs: 100,
  inputSchema: z.toJSONSchema(calculatorInput),
} as const;

export async function calculate(input: CalculatorInput): Promise<number> {
  const { left, operator, right } = input;
  if (operator === '/' && right === 0) throw new Error('Division by zero');
  const value =
    operator === '+'
      ? left + right
      : operator === '-'
        ? left - right
        : operator === '*'
          ? left * right
          : left / right;
  if (!Number.isFinite(value)) throw new Error('Non-finite result');
  return value;
}

// The injected executor is a test seam; production always uses the single calculator.
export class ToolExecutor {
  constructor(
    private readonly execute: (input: CalculatorInput) => Promise<number> = calculate,
    private readonly timeoutMs: number = calculatorDefinition.timeoutMs,
  ) {}

  async run(name: string, input: unknown): Promise<ToolResult> {
    if (name !== calculatorDefinition.name) return { ok: false, code: 'UNKNOWN_TOOL' };
    const parsed = calculatorInput.safeParse(input);
    if (!parsed.success) return { ok: false, code: 'INVALID_INPUT' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve()
          .then(() => this.execute(parsed.data))
          .then((value) => {
            if (!Number.isFinite(value)) throw new Error('Non-finite result');
            return { ok: true, value } as const;
          }),
        new Promise<ToolResult>((resolve) => {
          timer = setTimeout(() => resolve({ ok: false, code: 'TIMEOUT' }), this.timeoutMs);
        }),
      ]);
      return result;
    } catch {
      return { ok: false, code: 'EXECUTION_FAILED' };
    } finally {
      clearTimeout(timer);
    }
  }
}
