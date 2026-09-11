import { describe, expect, it } from 'vitest';

import { formatOriginMarker, ORIGIN_HUMAN, ORIGIN_MARKER_NAME } from './origin-marker.js';
import { CLONE_ACTOR_ID } from './usage.js';

describe('formatOriginMarker', () => {
  it('HTML コメント1行を組み立てる', () => {
    expect(formatOriginMarker('mgr-abc123')).toBe('<!-- alteroid-origin: mgr-abc123 -->');
  });

  it('刻印の名前は ORIGIN_MARKER_NAME と一致する（手書きの文字列に分かれていない）', () => {
    expect(formatOriginMarker('mgr-abc123')).toContain(ORIGIN_MARKER_NAME);
  });

  it('human を渡すと ORIGIN_HUMAN の刻印になる', () => {
    expect(formatOriginMarker(ORIGIN_HUMAN)).toBe('<!-- alteroid-origin: human -->');
  });

  /**
   * **`CLONE_ACTOR_ID` と刻印の値が同じ出所であることを測る歯。**
   *
   * `origin-marker.ts` は `CLONE_ACTOR_ID` を新しく書き写さず `usage.ts` から
   * import して使う、という約束を守っていることを確かめる——片方（例えば
   * `usage.ts` 側で `'clone'` から別の値へ改名した）だけが変わると、この歯が
   * 落ちる。**両方を書き換えて初めて緑に戻る**形にすることで、台帳の actor と
   * 刻印の値が別々の語彙へ分岐する事故を機械的に塞ぐ。
   */
  it('CLONE_ACTOR_ID の値がそのまま刻印に現れる（台帳と刻印の語彙がずれていないこと）', () => {
    expect(formatOriginMarker(CLONE_ACTOR_ID)).toBe(`<!-- alteroid-origin: ${CLONE_ACTOR_ID} -->`);
    expect(CLONE_ACTOR_ID).toBe('clone');
  });
});
