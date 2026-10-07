import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { HELP_EXAMPLES } from './help-examples.js';

const { program } = await import('./index.js');

function walk(command: Command, path: string[] = []): { path: string[]; command: Command }[] {
  return command.commands.flatMap((child) => [
    { path: [...path, child.name()], command: child },
    ...walk(child, [...path, child.name()]),
  ]);
}

function afterText(command: Command): string {
  let text = '';
  command.configureOutput({
    writeOut: (s) => {
      text += s;
    },
    writeErr: (s) => {
      text += s;
    },
  });
  command.outputHelp();
  return text;
}

describe('help の例（#2857）', () => {
  const all = walk(program);

  it('どの例も、いずれかのコマンドの --help の末尾に「例:」として出る', () => {
    for (const [key, example] of Object.entries(HELP_EXAMPLES)) {
      const owners = all.filter(({ command }) => afterText(command).includes(example));
      expect(owners.length, key).toBeGreaterThanOrEqual(1);
      expect(example, key).toContain('例:');
    }
  });

  it('例の中の alteroid コマンドとオプション名は、登録されているものだけ', () => {
    const lines = Object.values(HELP_EXAMPLES)
      .flatMap((example) => example.split('\n'))
      .map((line) => line.trim())
      .filter((line) => /^(cat .*\| )?alteroid /.test(line));
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      const words = line
        .replace(/#.*$/, '')
        .replace(/^cat \S+ \| /, '')
        .trim()
        .split(/\s+/)
        .slice(1);
      let current: Command = program;
      let rest = words;
      while (rest.length > 0) {
        const next = current.commands.find((c) => c.name() === rest[0]);
        if (next === undefined) break;
        current = next;
        rest = rest.slice(1);
      }
      expect(current, line).not.toBe(program);
      const known = new Set(
        current.options.flatMap((o) =>
          [o.long, o.short].filter((f): f is string => f !== undefined),
        ),
      );
      for (const word of rest.filter((w) => /^--?[a-zA-Z]/.test(w))) {
        expect(known.has(word), `${line} の ${word}`).toBe(true);
      }
    }
  });
});
