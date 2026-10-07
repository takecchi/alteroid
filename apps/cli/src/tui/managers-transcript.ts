// 道具の結果を全文で出さない: 数万字になりうり、行数が桁違いになると折り返しの計算が重いため
// 読めない行・知らない種類の行を捨てない: 生ログは「日誌で足りないときの最後の拠り所」のため
import { codePointBoundary } from '@alteroid/core/cli-light';

import { redactBody, sanitizeForTerminal } from '../redact.js';
import type { LogEntry, LogKind } from './log.js';

export const TOOL_INPUT_EXCERPT = 200;
export const TOOL_RESULT_EXCERPT = 300;
// 発言 1 件に上限を置く: 巨大な貼り付けで画面が埋まらないように
export const TEXT_LIMIT = 6_000;
export const MAX_TRANSCRIPT_ENTRIES = 1_500;

function excerpt(text: string, limit: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > limit
    ? `${single.slice(0, codePointBoundary(single, limit))}…（全 ${String(single.length)} 字のうち先頭だけ）`
    : single;
}

function capText(text: string): string {
  return text.length > TEXT_LIMIT
    ? `${text.slice(0, codePointBoundary(text, TEXT_LIMIT))}\n…（全 ${String(text.length)} 字のうち先頭 ${String(TEXT_LIMIT)} 字だけ）`
    : text;
}

type Piece = { kind: LogKind; text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part['text'] === 'string' ? part['text'] : ''))
      .filter((text) => text.length > 0)
      .join(' ');
  }
  return '';
}

function blocksToPieces(role: 'user' | 'assistant', content: unknown): Piece[] {
  const textKind: LogKind = role === 'user' ? 'user' : 'assistant';
  if (typeof content === 'string') {
    return content.trim().length > 0
      ? [{ kind: textKind, text: capText(redactBody(content.trim())) }]
      : [];
  }
  if (!Array.isArray(content)) return [];
  const out: Piece[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    switch (block['type']) {
      case 'text':
        if (typeof block['text'] === 'string' && block['text'].trim().length > 0) {
          out.push({ kind: textKind, text: capText(redactBody(block['text'].trim())) });
        }
        break;
      case 'tool_use': {
        const name =
          typeof block['name'] === 'string' ? sanitizeForTerminal(block['name']) : '(道具名なし)';
        const input = block['input'] === undefined ? '' : JSON.stringify(block['input']);
        out.push({
          kind: 'tool',
          text: `${name} ${excerpt(redactBody(input), TOOL_INPUT_EXCERPT)}`.trim(),
        });
        break;
      }
      case 'tool_result': {
        const body = excerpt(redactBody(resultText(block['content'])), TOOL_RESULT_EXCERPT);
        out.push({ kind: 'tool', text: `↳ ${body.length > 0 ? body : '(結果なし)'}` });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

export function transcriptLinePieces(line: string): Piece[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [
      {
        kind: 'system',
        text: `(JSON として読めない行) ${excerpt(redactBody(line), TOOL_RESULT_EXCERPT)}`,
      },
    ];
  }
  if (!isRecord(parsed)) {
    return [
      {
        kind: 'system',
        text: `(オブジェクトでない行) ${excerpt(redactBody(line), TOOL_INPUT_EXCERPT)}`,
      },
    ];
  }
  const type = parsed['type'];
  const message = parsed['message'];
  if ((type === 'user' || type === 'assistant') && isRecord(message)) {
    return blocksToPieces(type, message['content']);
  }
  const rest = excerpt(redactBody(line), TOOL_INPUT_EXCERPT);
  return [
    {
      kind: 'system',
      text: `[${typeof type === 'string' ? sanitizeForTerminal(type) : '種類なし'}] ${rest}`,
    },
  ];
}

// 同じ `seq` で中身が同じエントリは使い回す: `log.ts` の展開キャッシュがエントリの参照で引くため、取り直しのたびに全行を折り返し直さずに済む
export function parseTranscript(body: string, previous: readonly LogEntry[] = []): LogEntry[] {
  const known = new Map<number, LogEntry>();
  for (const entry of previous) known.set(entry.seq, entry);
  const out: LogEntry[] = [];
  const lines = body.split('\n');
  lines.forEach((line, index) => {
    if (line.trim().length === 0) return;
    transcriptLinePieces(line).forEach((piece, n) => {
      const seq = (index + 1) * 1000 + n;
      const hit = known.get(seq);
      out.push(
        hit !== undefined && hit.kind === piece.kind && hit.text === piece.text
          ? hit
          : { seq, kind: piece.kind, text: piece.text },
      );
    });
  });
  if (out.length <= MAX_TRANSCRIPT_ENTRIES) return out;
  const dropped = out.length - MAX_TRANSCRIPT_ENTRIES;
  return [
    {
      seq: 0,
      kind: 'system',
      text: `古い ${String(dropped)} 件は省略（全 ${String(out.length)} 件のうち新しい ${String(MAX_TRANSCRIPT_ENTRIES)} 件だけ持っている。全文は Web か alteroid chat の /manager）`,
    },
    ...out.slice(dropped),
  ];
}
