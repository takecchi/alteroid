import { beforeEach, describe, expect, it } from 'vitest';

import { cellWidth } from './wrap.js';

import {
  cachedLogRowCount,
  clearLogLinesCache,
  logLines,
  logWindow,
  MAX_CACHED_ROWS,
  pageStep,
  scrollDown,
  scrollUp,
  streamLines,
  type LogEntry,
} from './log.js';

const entry = (seq: number, kind: LogEntry['kind'], text: string): LogEntry => ({
  seq,
  kind,
  text,
});

beforeEach(() => clearLogLinesCache());

describe('logLines（エントリ → 物理行）', () => {
  it('先頭行に prefix、継続行に同じ幅の字下げが付き、幅を超えない', () => {
    const rows = logLines([entry(1, 'user', 'あいうえおかきくけこ')], 10);
    expect(rows.map((r) => r.text)).toEqual(['❯ あいうえ', '  おかきく', '  けこ']);
    expect(rows.map((r) => r.key)).toEqual(['1:0', '1:1', '1:2']);
  });

  it('応答は Markdown として整形され、装飾付きの span を持つ', () => {
    const [row] = logLines([entry(1, 'assistant', '**強調**')], 40);
    expect(row?.text).toBe('  強調');
    expect(row?.spans?.some((s) => s.bold === true && s.text === '強調')).toBe(true);
  });

  it('応答以外（user・tool・error）は整形しない（記号がそのまま出る）', () => {
    const [row] = logLines([entry(1, 'user', '**そのまま**')], 40);
    expect(row?.text).toBe('❯ **そのまま**');
    expect(row?.spans).toBeUndefined();
  });

  it('改行を含むエントリは論理行ごとに折り返す', () => {
    const rows = logLines([entry(1, 'system', 'a\nb')], 40);
    expect(rows.map((r) => r.text)).toEqual(['  ! a', '    b']);
  });

  it('同じエントリ・同じ幅なら同じ行オブジェクトを返す（再展開しない）', () => {
    const e = entry(1, 'user', 'hi');
    const a = logLines([e], 20);
    const b = logLines([e], 20);
    expect(b[0]).toBe(a[0]);
    expect(logLines([e], 30)[0]).not.toBe(a[0]); // 幅が変われば作り直す
  });

  it('展開済みの行を覚える量には上限がある（使い終わった分から追い出す）', () => {
    for (let i = 0; i < 300; i += 1) {
      const entries = Array.from({ length: 100 }, (_, j) => entry(i * 100 + j, 'user', 'x'));
      logLines(entries, 20);
    }
    // 1 回の呼び出しで使った行は追い出さないので、上限に 1 回ぶん（100 行）を足した範囲に収まる。
    expect(cachedLogRowCount()).toBeLessThanOrEqual(MAX_CACHED_ROWS + 100);
  });
});

describe('streamLines（確定前の本文）', () => {
  it('整形せず、末尾から cap 行ぶんだけを返す', () => {
    const text = Array.from({ length: 50 }, (_, i) => `行${String(i)}`).join('\n');
    const rows = streamLines(text, 20, 3);
    expect(rows.map((r) => r.text.trim())).toEqual(['行47', '行48', '行49']);
    expect(rows.every((r) => r.spans === undefined)).toBe(true);
  });

  it('末尾の空行は数えない（改行が来た瞬間に画面が跳ねない）', () => {
    expect(streamLines('abc\n\n\n', 20, 5).map((r) => r.text)).toEqual(['  abc']);
  });

  it('既存の行の key は本文が伸びても変わらない', () => {
    const a = streamLines('abc', 20, 5);
    const b = streamLines('abc\ndef', 20, 5);
    expect(b[0]?.key).toBe(a[0]?.key);
  });
});

describe('logWindow / scroll', () => {
  const lines = Array.from({ length: 100 }, (_, i) => i);

  it('末尾追従は最後の rows 行', () => {
    const w = logWindow(lines, 10, 'bottom');
    expect(w.entries).toEqual(lines.slice(90));
    expect(w).toMatchObject({ hiddenAbove: 90, hiddenBelow: 0, atBottom: true });
  });

  it('数値のアンカーは終端を固定する（追記があっても見ている場所がずれない）', () => {
    const before = logWindow(lines, 10, 50);
    const after = logWindow([...lines, 100, 101], 10, 50);
    expect(after.entries).toEqual(before.entries);
    expect(after.hiddenBelow).toBe(before.hiddenBelow + 2);
    expect(before.atBottom).toBe(false);
  });

  it('窓は rows を超えない（Yoga が溢れた子を縮めて行が欠けるのを防ぐ）', () => {
    expect(logWindow(lines, 7, 3).entries).toHaveLength(7); // 先頭付近でも 1 画面ぶん埋まる
    expect(logWindow(lines, 7, 'bottom').entries).toHaveLength(7);
  });

  it('PgUp で上へ、PgDn で戻り、末尾へ届いたら追従へ戻る', () => {
    const step = pageStep(10);
    expect(step).toBe(5);
    const up = scrollUp('bottom', 100, 10, step);
    expect(up).toBe(95);
    expect(scrollUp(up, 100, 10, step)).toBe(90);
    expect(scrollDown(95, 100, 10, step)).toBe('bottom');
    expect(scrollDown(80, 100, 10, step)).toBe(85);
    expect(scrollDown('bottom', 100, 10)).toBe('bottom');
  });

  it('一番上より上へは行かない。全部が 1 画面に収まるなら動かない', () => {
    expect(scrollUp(12, 100, 10, 50)).toBe(10);
    expect(scrollUp('bottom', 8, 10)).toBe('bottom');
  });
});

describe('本文のタブ（#3407）', () => {
  it('logLines は、タブを空白へ展開してから折り返す（行末の文字が欠けず、幅を超えない）', () => {
    clearLogLinesCache();
    const entries: LogEntry[] = [
      { seq: 1, kind: 'system', text: 'a\tb\tc\td END' },
      {
        seq: 2,
        kind: 'assistant',
        text: '```go\nfunc main() {\n\tfmt.Println("hello world") // ENDMARK\n}\n```',
      },
    ];
    const rows = logLines(entries, 40);
    const joined = rows.map((r) => r.text).join('\n');
    expect(joined).not.toContain('\t');
    expect(joined).toContain('END');
    // 折り返されても欠けない（行をまたぐので、行頭の字下げを除いて繋げて見る）。
    expect(rows.map((r) => r.text.trim()).join('')).toContain('ENDMARK');
    for (const row of rows) expect(cellWidth(row.text)).toBeLessThanOrEqual(40);
  });

  it('streamLines（ストリーミング中）も展開する', () => {
    const rows = streamLines('x\ty\tz', 40, 10);
    expect(rows.map((r) => r.text).join('')).not.toContain('\t');
  });
});
