import { describe, expect, it } from 'vitest';

import { CLONE_COMPACTION_INSTRUCTIONS } from './clone-compaction-instructions.js';
import { MANAGER_COMPACTION_INSTRUCTIONS } from './manager-compaction-instructions.js';

// 同梱 CLI が PreCompact の出力から受け取る上限（sdk 0.3.318 の `_0e` = 10,000 字。`clone-compaction-instructions.test.ts` と同じ）
const SDK_PRE_COMPACT_OUTPUT_LIMIT = 10_000;

describe('マネージャーの自動要約への指示', () => {
  it('SDK の上限より十分に短い（超えると末尾が黙って切れ、残す側が落ちる）', () => {
    expect(MANAGER_COMPACTION_INSTRUCTIONS.length).toBeLessThan(SDK_PRE_COMPACT_OUTPUT_LIMIT / 2);
  });

  it('依頼の決まり（最初の依頼文・あとから届いた指示・確認の答え）を逐語で残させる', () => {
    for (const keep of [
      '必ず逐語で残すこと',
      '最初の依頼文の全文',
      'あとから届いた指示の全文',
      'manager_send',
      '確認への答えの全文',
      'allow / deny',
    ]) {
      expect(MANAGER_COMPACTION_INSTRUCTIONS).toContain(keep);
    }
  });

  it('禁止や条件の例を名指しし、言い換えを禁じる', () => {
    for (const rule of [
      '本番に触らない',
      'マージしない',
      '試験の上限を上げない',
      'workflow を手で起動しない',
    ]) {
      expect(MANAGER_COMPACTION_INSTRUCTIONS).toContain(rule);
    }
    expect(MANAGER_COMPACTION_INSTRUCTIONS).toContain('一字も変えずに');
  });

  it('作業の状態（PR・sha・枝・作業ツリー・作業者・済んでいない手順）を残させる', () => {
    for (const keep of [
      'PR の番号',
      'head の sha',
      '枝の名前',
      '作業ツリーの絶対パス',
      '走っている作業者',
      'まだ済んでいない手順',
    ]) {
      expect(MANAGER_COMPACTION_INSTRUCTIONS).toContain(keep);
    }
  });

  it('試した結果の数字は、前後と出どころを一緒に残させる', () => {
    expect(MANAGER_COMPACTION_INSTRUCTIONS).toContain('測った前と後の両方');
    expect(MANAGER_COMPACTION_INSTRUCTIONS).toContain('出どころ');
  });

  it('クローンの指示とは別物である（取り違えると、依頼の決まりを逐語で残す指示が載らない）', () => {
    expect(MANAGER_COMPACTION_INSTRUCTIONS).not.toBe(CLONE_COMPACTION_INSTRUCTIONS);
    expect(MANAGER_COMPACTION_INSTRUCTIONS).toContain('マネージャー');
    expect(CLONE_COMPACTION_INSTRUCTIONS).not.toContain('最初の依頼文の全文');
    // クローンの取り戻し先は、マネージャーには無い（その道具を持たない）
    expect(MANAGER_COMPACTION_INSTRUCTIONS).not.toContain('conversation_read');
  });
});
