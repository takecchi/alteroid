import { describe, expect, it } from 'vitest';

import {
  MAX_TRANSCRIPT_ENTRIES,
  TEXT_LIMIT,
  TOOL_RESULT_EXCERPT,
  parseTranscript,
} from './managers-transcript.js';

const line = (value: unknown): string => JSON.stringify(value);

describe('parseTranscript', () => {
  it('user / assistant の発言は全文、道具の呼び出しと結果は 1 行の抜粋にする', () => {
    const body = [
      line({ type: 'user', message: { role: 'user', content: '依頼です' } }),
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '内心' },
            { type: 'text', text: '読みます' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts' } },
          ],
        },
      }),
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'x'.repeat(5000) }] },
      }),
    ].join('\n');
    const entries = parseTranscript(body);
    expect(entries.map((e) => e.kind)).toEqual(['user', 'assistant', 'tool', 'tool']);
    expect(entries[0]?.text).toBe('依頼です');
    expect(entries[2]?.text).toContain('Read');
    expect(entries[2]?.text).toContain('/a/b.ts');
    const result = entries[3]?.text ?? '';
    expect(result.length).toBeLessThan(TOOL_RESULT_EXCERPT + 60);
    expect(result).toContain('全 5000 字のうち先頭だけ');
    expect(entries.some((e) => e.text.includes('内心'))).toBe(false);
  });

  it('読めない行・知らない種類の行は捨てずに system の行として残す', () => {
    const entries = parseTranscript(
      ['壊れた行', line({ type: 'result', subtype: 'success' }), '', line([1])].join('\n'),
    );
    expect(entries.map((e) => e.kind)).toEqual(['system', 'system', 'system']);
    expect(entries[0]?.text).toContain('JSON として読めない行');
    expect(entries[1]?.text).toContain('[result]');
    expect(entries[2]?.text).toContain('オブジェクトでない行');
  });

  it('巨大な発言は上限で切って、字数を言う', () => {
    const entries = parseTranscript(
      line({ type: 'assistant', message: { content: 'あ'.repeat(TEXT_LIMIT + 100) } }),
    );
    expect(entries[0]?.text).toContain(`全 ${String(TEXT_LIMIT + 100)} 字のうち先頭`);
  });

  it('件数が上限を超えたら古い側を捨て、先頭の 1 行でそう言う', () => {
    const body = Array.from({ length: MAX_TRANSCRIPT_ENTRIES + 10 }, (_, i) =>
      line({ type: 'assistant', message: { content: `発言${String(i)}` } }),
    ).join('\n');
    const entries = parseTranscript(body);
    expect(entries).toHaveLength(MAX_TRANSCRIPT_ENTRIES + 1);
    expect(entries[0]?.text).toContain('古い 10 件は省略');
    expect(entries.at(-1)?.text).toBe(`発言${String(MAX_TRANSCRIPT_ENTRIES + 9)}`);
  });

  it('取り直しでは中身が同じエントリの参照を使い回す（折り返しのキャッシュが効く）', () => {
    const a = line({ type: 'assistant', message: { content: 'いち' } });
    const b = line({ type: 'assistant', message: { content: 'に' } });
    const first = parseTranscript(a);
    const second = parseTranscript([a, b].join('\n'), first);
    expect(second[0]).toBe(first[0]);
    expect(second).toHaveLength(2);
    const seqs = new Set(second.map((e) => e.seq));
    expect(seqs.size).toBe(2);
  });
});

describe('切り詰めはサロゲートペアを割らない（#2592）', () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
  const emoji = (n: number): string => `a${'😀'.repeat(n)}`;

  it('発言の全文の予算切り', () => {
    const body = line({ type: 'user', message: { content: emoji(TEXT_LIMIT) } });
    const entries = parseTranscript(body);
    expect(entries[0]?.text).not.toMatch(lone);
  });

  it('道具の結果の抜粋', () => {
    const body = line({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: emoji(TOOL_RESULT_EXCERPT) }] },
    });
    const entries = parseTranscript(body);
    expect(entries[0]?.text).toContain('先頭だけ');
    expect(entries[0]?.text).not.toMatch(lone);
  });
});
