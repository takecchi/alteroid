import { describe, expect, it } from 'vitest';

import { reportExcerpt } from './report-excerpt.js';

describe('reportExcerpt', () => {
  it('行頭の記法と強調の記号を落とし、1行に並べる（語は言い換えない）', () => {
    const body = '## 今日やったこと\n\n- **稼働の地図**を足した\n1. `SSE` の再接続\n> 引用です';
    expect(reportExcerpt(body)).toBe('今日やったこと 稼働の地図を足した SSE の再接続 引用です');
  });

  it('リンクは文字だけ、区切り線・空行は落とす', () => {
    expect(reportExcerpt('[PR #1](https://example.com/1) を見た\n\n---\n次')).toBe(
      'PR #1 を見た 次',
    );
  });

  it('上限を越えたら … を付けて切る。ちょうど上限なら付けない', () => {
    expect(reportExcerpt('あいうえお', 5)).toBe('あいうえお');
    expect(reportExcerpt('あいうえおか', 5)).toBe('あいうえお…');
  });

  it('サロゲートペアを割らない', () => {
    expect(reportExcerpt('😀😀😀', 2)).toBe('😀😀…');
  });

  it('空の本文は空', () => {
    expect(reportExcerpt('')).toBe('');
  });
});
