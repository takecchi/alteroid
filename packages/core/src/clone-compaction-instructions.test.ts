import { describe, expect, it } from 'vitest';

import { CLONE_COMPACTION_INSTRUCTIONS } from './clone-compaction-instructions.js';

// 同梱 CLI が PreCompact の出力から受け取る上限（sdk 0.3.318 の `_0e` = 10,000 字）
const SDK_PRE_COMPACT_OUTPUT_LIMIT = 10_000;

describe('クローンの自動要約への指示', () => {
  it('SDK の上限より十分に短い（超えると末尾が黙って切れ、残す側が落ちる）', () => {
    expect(CLONE_COMPACTION_INSTRUCTIONS.length).toBeLessThan(SDK_PRE_COMPACT_OUTPUT_LIMIT / 2);
  });

  it('残すものの5種を名指しする', () => {
    for (const keep of [
      '逐語',
      '答えを得ていない問い',
      '未完了の task',
      '判断とその根拠',
      'PR 番号',
    ]) {
      expect(CLONE_COMPACTION_INSTRUCTIONS).toContain(keep);
    }
  });

  it('捨てるものの3種を名指しする', () => {
    for (const drop of [
      '道具の生の出力',
      '繰り返し注入される定型の知らせ',
      '済んだ委譲の途中経過',
    ]) {
      expect(CLONE_COMPACTION_INSTRUCTIONS).toContain(drop);
    }
  });

  it('捨てる側には、取り戻せる先を添える（取り戻せないものは捨てさせない）', () => {
    expect(CLONE_COMPACTION_INSTRUCTIONS).toContain('conversation_read');
    expect(CLONE_COMPACTION_INSTRUCTIONS).toContain('memory_read');
  });
});
