import { describe, expect, it } from 'vitest';
import { journalBytesChange } from './journal-bytes.js';

// 3 か所（clone-tools-journal / digest / logic の journal-summary）に在った元の式
type Entry = { bytesBefore?: unknown; bytesAfter?: unknown };
function original(entry: Entry): string | undefined {
  return entry.bytesBefore === undefined || entry.bytesAfter === undefined
    ? undefined
    : `${entry.bytesBefore}→${entry.bytesAfter}`;
}

describe('journalBytesChange', () => {
  it('新形式は 前→後 を返す（0 も値として出す）', () => {
    expect(journalBytesChange({ bytesBefore: 10, bytesAfter: 25 })).toBe('10→25');
    expect(journalBytesChange({ bytesBefore: 0, bytesAfter: 0 })).toBe('0→0');
  });

  it('旧形式（欄が無い・片方だけ）は undefined', () => {
    expect(journalBytesChange({})).toBeUndefined();
    expect(journalBytesChange({ bytesBefore: 1 })).toBeUndefined();
    expect(journalBytesChange({ bytesAfter: 1 })).toBeUndefined();
    expect(journalBytesChange({ bytesBefore: undefined, bytesAfter: 3 })).toBeUndefined();
  });

  it('元の式と同じ結果を返す（型違いの入力を含む）', () => {
    const cases: Entry[] = [
      {},
      { bytesBefore: 1 },
      { bytesAfter: 1 },
      { bytesBefore: 1, bytesAfter: 2 },
      { bytesBefore: 0, bytesAfter: 0 },
      { bytesBefore: null, bytesAfter: 2 },
      { bytesBefore: '3', bytesAfter: '4' },
      { bytesBefore: Number.NaN, bytesAfter: 1 },
    ];
    for (const c of cases) {
      expect(journalBytesChange(c as never)).toBe(original(c));
    }
  });
});
