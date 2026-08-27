import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/** Everything the CLI prints goes to stderr, keeping stdout free for machine-readable output. */
export const out = {
  line(message = ''): void {
    process.stderr.write(`${message}\n`);
  },
  step(message: string): void {
    process.stderr.write(`\n${message}\n`);
  },
  ok(message: string): void {
    process.stderr.write(`✓ ${message}\n`);
  },
  warn(message: string): void {
    process.stderr.write(`! ${message}\n`);
  },
  error(message: string): void {
    process.stderr.write(`✗ ${message}\n`);
  },
};

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, fallback = true): Promise<boolean> {
  const hint = fallback ? 'Y/n' : 'y/N';
  const answer = (await ask(`${question} [${hint}] `)).toLowerCase();
  if (answer === '') return fallback;
  return answer.startsWith('y');
}

export async function choose<T>(
  question: string,
  options: Array<{ label: string; value: T }>,
): Promise<T> {
  const first = options[0];
  if (options.length === 1 && first) return first.value;

  out.line(question);
  options.forEach((option, index) => out.line(`  ${index + 1}. ${option.label}`));

  for (;;) {
    const answer = await ask(`Choose 1-${options.length}: `);
    const index = Number.parseInt(answer, 10) - 1;
    const chosen = options[index];
    if (chosen) return chosen.value;
    out.warn('Not a valid choice.');
  }
}
