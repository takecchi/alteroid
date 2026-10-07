// 配色の考え方は takecchi/codiva（MIT）`src/ui/theme.ts` から借りた
import type { LogKind } from './log.js';
import type { MarkdownTone } from './markdown.js';

export const theme = {
  accent: '#137a7f',
  dim: '#8b98a5',
  warn: 'yellow',
  error: '#f0524b',
  ok: '#35c46b',
} as const;

export const logColor: Record<LogKind, string | undefined> = {
  user: 'cyan',
  assistant: undefined,
  tool: theme.accent,
  system: theme.warn,
  ask: '#e12885',
  error: theme.error,
};

export const toneColor: Record<MarkdownTone, string> = {
  heading: 'cyan',
  code: 'green',
  link: 'blue',
  quote: 'gray',
  marker: 'gray',
};

export const glyph = { caret: '❯', bar: '─' } as const;
