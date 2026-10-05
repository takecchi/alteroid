/**
 * マネージャーの生ログ（`GET /managers/{id}/transcript` の JSONL）を、段階 1 のログビュー
 * （`log.ts` の `LogEntry`）で読める形にする。純粋（I/O 無し）。
 *
 * **要約ではなく整形である。** 発言（user / assistant）は全文を残し、道具の呼び出しと結果は
 * 1 行の抜粋にする（結果は数万字になりうる — 可視窓だけ描く設計でも、行数が桁違いになると
 * 折り返しの計算が重い）。抜粋にしたものは省いた字数を言う。読めない行・知らない種類の行は
 * 捨てずに `system` の行として残す（生ログは「日誌で足りないときの最後の拠り所」）。
 * `thinking` ブロックだけは出さない（後述の PR 本文の表に書く）。
 */
import { codePointBoundary } from '@alteroid/core/cli-light';

import { redactBody } from '../redact.js';
import type { LogEntry, LogKind } from './log.js';

/** 抜粋の長さ。道具の入力。 */
export const TOOL_INPUT_EXCERPT = 200;
/** 抜粋の長さ。道具の結果。 */
export const TOOL_RESULT_EXCERPT = 300;
/** 発言 1 件の上限（超えたら末尾を省いて字数を言う。巨大な貼り付けで画面が埋まらないように）。 */
export const TEXT_LIMIT = 6_000;
/** 持つエントリの上限。超えた古い側は捨てて、その旨を先頭の 1 行で言う。 */
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
        const name = typeof block['name'] === 'string' ? block['name'] : '(道具名なし)';
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
        // `thinking` など。出さない。
        break;
    }
  }
  return out;
}

/** 1 行 → ログの行（0 個以上）。 */
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
  // user / assistant 以外（result・system・summary など）。種類名と抜粋を残す。
  const rest = excerpt(redactBody(line), TOOL_INPUT_EXCERPT);
  return [{ kind: 'system', text: `[${typeof type === 'string' ? type : '種類なし'}] ${rest}` }];
}

/**
 * JSONL 全体 → エントリ列。`previous` に同じ `seq` で中身が同じエントリがあれば、その
 * オブジェクトを使い回す（`log.ts` の展開キャッシュはエントリの参照で引くので、取り直しの
 * たびに全行を折り返し直さずに済む）。`seq` は行番号から作る（取り直しても安定）。
 */
export function parseTranscript(body: string, previous: readonly LogEntry[] = []): LogEntry[] {
  const known = new Map<number, LogEntry>();
  for (const entry of previous) known.set(entry.seq, entry);
  const out: LogEntry[] = [];
  const lines = body.split('\n');
  lines.forEach((line, index) => {
    if (line.trim().length === 0) return;
    transcriptLinePieces(line).forEach((piece, n) => {
      // 1 行から複数のエントリが出るので、seq は (行番号, 何番目) から一意に作る。
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
