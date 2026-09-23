import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import {
  CLONE_TOOL_NAMES,
  createCloneTools,
  cloneToolJournalsItself,
  qualifiedToolName,
  SELF_JOURNALING_CLONE_TOOLS,
  TRACELESS_CLONE_TOOLS,
} from './tools.js';
import type { Stores } from './store.js';

/**
 * `practice_*`（#1055 段3②）——クローンが「仕事のやり方」を読み書きする道具。
 *
 * **`tools.test.ts` の重い `harness()`（`ManagerPool` 一式のスタブ）を持ち込まない。**
 * `practice_*` は `stores.practices` と `stores.journal` しか触らないので、
 * `ToolContext` の必須欄（`stores` / `emit` / `conversationId` / `memoryCause`）
 * だけを満たす最小の器で足りる——`tool-arguments.test.ts` の `connect()` が
 * 同じ最小形を使っているのと同じ判断である。
 */
interface Harness {
  stores: Stores;
  call(name: string, args: Record<string, unknown>): Promise<string>;
}

function harness(): Harness {
  const stores = createMemoryStores();
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
  });
  return {
    stores,
    async call(name, args) {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`ツール ${name} が無い`);
      const result = await found.handler(args as never, {});
      return (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
    },
  };
}

describe('practice_* — 仕事のやり方を器に持つ道具（#1055 段3②）', () => {
  // --- 設計の固定 -----------------------------------------------------------

  it('5本だけが在り、"適用する/強制する" 道具は無い（#1309 で practice_history が増えた）', () => {
    const names = CLONE_TOOL_NAMES.filter((name) => name.startsWith('practice_'));
    expect(names.sort()).toEqual([
      'practice_history',
      'practice_list',
      'practice_read',
      'practice_remove',
      'practice_write',
    ]);
    // ⛔ これらを足すと北極星が壊れる（`PracticeStore` の doc）。足したくなったら
    // ここが赤くなって思い出させるためだけの歯。
    expect(CLONE_TOOL_NAMES).not.toContain('practice_apply');
    expect(CLONE_TOOL_NAMES).not.toContain('practice_enforce');
  });

  it('読む3本は traceless、書く2本は自前で日誌へ残す側に分類されている', () => {
    expect(TRACELESS_CLONE_TOOLS).toContain('practice_list');
    expect(TRACELESS_CLONE_TOOLS).toContain('practice_read');
    expect(TRACELESS_CLONE_TOOLS).toContain('practice_history');
    expect(SELF_JOURNALING_CLONE_TOOLS).toContain('practice_write');
    expect(SELF_JOURNALING_CLONE_TOOLS).toContain('practice_remove');
    expect(cloneToolJournalsItself(qualifiedToolName('practice_write'))).toBe(true);
    expect(cloneToolJournalsItself(qualifiedToolName('practice_remove'))).toBe(true);
    expect(cloneToolJournalsItself(qualifiedToolName('practice_list'))).toBe(false);
    expect(cloneToolJournalsItself(qualifiedToolName('practice_read'))).toBe(false);
    expect(cloneToolJournalsItself(qualifiedToolName('practice_history'))).toBe(false);
  });

  it('道具の説明文が「適用する」道具の不在を明言している（apply/enforce の代わり）', () => {
    const h = harness();
    const tools = createCloneTools({
      stores: h.stores,
      emit: () => undefined,
      conversationId: () => undefined,
      memoryCause: () => 'clone',
    });
    const write = tools.find((entry) => entry.name === 'practice_write');
    expect(write?.description ?? '').toContain('従わせる道具はここには無い');
  });

  // --- practice_list ---------------------------------------------------------

  it('⭐ 空のときは「正常な状態」だと言う（異常や未設定とは言わない）', async () => {
    const h = harness();
    const body = await h.call('practice_list', {});
    expect(body).toContain('正常な状態');
    expect(body).not.toContain('未設定');
    expect(body).not.toMatch(/エラー|異常です|失敗/);
  });

  it('一覧は本文を含まず、meta（slug・kind・title・chars・作成/更新）だけを出す', async () => {
    const h = harness();
    await h.call('practice_write', {
      slug: 'review',
      kind: 'レビュー',
      title: 'レビューのやり方',
      content: '# 秘密の本文\n\nここには一覧から辿り着けないはずの文がある。',
    });

    const body = await h.call('practice_list', {});
    expect(body).toContain('review');
    expect(body).toContain('[レビュー]');
    expect(body).toContain('レビューのやり方');
    expect(body).toMatch(/作成: .* \/ 更新: /);
    // 本文は載らない。
    expect(body).not.toContain('秘密の本文');
    expect(body).not.toContain('ここには一覧から辿り着けない');
  });

  it('一覧は slug の昇順で並ぶ', async () => {
    const h = harness();
    await h.call('practice_write', { slug: 'c-doc', kind: '日報', title: 'C', content: 'c' });
    await h.call('practice_write', { slug: 'a-doc', kind: '実装', title: 'A', content: 'a' });
    await h.call('practice_write', { slug: 'b-doc', kind: '調査', title: 'B', content: 'b' });

    const body = await h.call('practice_list', {});
    const order = ['a-doc', 'b-doc', 'c-doc'].map((slug) => body.indexOf(slug));
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(order[0]!).toBeLessThan(order[1]!);
    expect(order[1]!).toBeLessThan(order[2]!);
  });

  it('予算を超えたら、続きを取る口が無いと正直に言う（cursor を騙らない）', async () => {
    const h = harness();
    // 1件で予算(8,000字)を超えさせる——長い本文ではなく長い title で嵩上げする
    // （list はメタしか出さないので、本文の長さは list の出力量に効かない）。
    const longTitle = 'あ'.repeat(9_000);
    await h.call('practice_write', {
      slug: 'huge',
      kind: '実装',
      title: longTitle,
      content: 'x',
    });
    await h.call('practice_write', {
      slug: 'small',
      kind: '調査',
      title: '小さい方',
      content: 'y',
    });

    const body = await h.call('practice_list', {});
    expect(body).toContain('省略');
    // **cursor という語を出していないこと。** 口が無いのに口があるかのような
    // 案内をすると、呼び手は存在しない継続点を組み立てようとする。
    expect(body).not.toContain('cursor');
    expect(body).toContain('practice_read');
  });

  // --- practice_read ---------------------------------------------------------

  it('無い slug は例外を投げず、「無い」と分かる文を返す', async () => {
    const h = harness();
    const body = await h.call('practice_read', { slug: 'nothing-here' });
    expect(body).toContain('nothing-here');
    expect(body).toContain('無い');
    expect(body).toContain('practice_write');
  });

  it('在る slug は本文まで返す', async () => {
    const h = harness();
    await h.call('practice_write', {
      slug: 'investigate',
      kind: '調査',
      title: '調べもののやり方',
      content: '# 調べもの\n\n一次情報に当たる',
    });

    const body = await h.call('practice_read', { slug: 'investigate' });
    expect(body).toContain('investigate');
    expect(body).toContain('調査');
    expect(body).toContain('調べもののやり方');
    expect(body).toContain('一次情報に当たる');
  });

  // --- practice_write ----------------------------------------------------

  it('新規作成すると「新しく作った」と言い、日誌に decision を残す', async () => {
    const h = harness();
    const body = await h.call('practice_write', {
      slug: 'daily',
      kind: '日報',
      title: '日報のやり方',
      content: '毎日夕方に書く',
    });
    expect(body).toContain('新しく作った');

    const stored = await h.stores.practices.read('daily');
    expect(stored?.content).toBe('毎日夕方に書く\n');

    const [entry] = await h.stores.journal.list({ types: ['decision'] });
    expect(entry).toMatchObject({ type: 'decision' });
    if (entry?.type !== 'decision') throw new Error('unreachable');
    expect(entry.decision).toContain('daily');
    expect(entry.decision).toContain('作った');
    expect(entry.grounds).toContain('新しい');
  });

  it('既存の slug に書くと「書き直した」と言う（いまの本文は全文置換だが、前の本文は版に残る）', async () => {
    const h = harness();
    await h.call('practice_write', { slug: 'daily', kind: '日報', title: '旧', content: '旧本文' });
    const body = await h.call('practice_write', {
      slug: 'daily',
      kind: '日報',
      title: '新',
      content: '新本文',
    });
    expect(body).toContain('書き直した');
    expect(body).toContain('practice_history');

    const stored = await h.stores.practices.read('daily');
    expect(stored?.content).toBe('新本文\n');
    // **いまの本文の読み口（read）からは前の本文は消える**——それでも
    // 版の履歴（listVersions/readVersion）には残ることを下のブロックで測る。
    expect(stored?.content).not.toContain('旧本文');
  });

  // ⭐ 変異試験で見つかった穴（#1055 段3②）。上のテストは応答本文の
  // 「書き直した」しか見ておらず、日誌の decision 側の同じ三項演算子は
  // どのテストも見ていなかった——`before === null ? '作った' : '書き直した'`
  // を常に「作った」へ潰す変異を当てても、既存の歯は1本も赤くならなかった
  // （手で確かめた。壊した箇所は元に戻し、この歯だけを新設した）。
  it('既存の slug に書いたときの日誌 decision も「書き直した」と言う（応答本文とは別の歯）', async () => {
    const h = harness();
    await h.call('practice_write', { slug: 'daily', kind: '日報', title: '旧', content: '旧本文' });
    await h.call('practice_write', {
      slug: 'daily',
      kind: '日報',
      title: '新',
      content: '新本文',
    });

    const [entry] = await h.stores.journal.list({ types: ['decision'] });
    expect(entry).toMatchObject({ type: 'decision' });
    if (entry?.type !== 'decision') throw new Error('unreachable');
    expect(entry.decision).toContain('書き直した');
    expect(entry.decision).not.toContain('作った');
    expect(entry.grounds).toContain('書き直した');
  });

  it('kind は自由文字列——知らない種類を弾かない', async () => {
    const h = harness();
    const body = await h.call('practice_write', {
      slug: 'weird',
      kind: 'まだ名前の無い何か',
      title: 'X',
      content: 'x',
    });
    expect(body).toContain('新しく作った');
    expect((await h.stores.practices.read('weird'))?.kind).toBe('まだ名前の無い何か');
  });

  // --- practice_history / practice_read version=（#1309）--------------------

  it('write のたびに版が増える。版番号は1始まりの連番', async () => {
    const h = harness();
    await h.call('practice_write', { slug: 'daily', kind: '日報', title: '旧', content: '旧本文' });
    const afterFirst = await h.call('practice_history', { slug: 'daily' });
    expect(afterFirst).toContain('版1');

    await h.call('practice_write', { slug: 'daily', kind: '日報', title: '新', content: '新本文' });
    const afterSecond = await h.call('practice_history', { slug: 'daily' });
    expect(afterSecond).toContain('版1');
    expect(afterSecond).toContain('版2');
  });

  it('practice_history は本文を含まない（一覧に本文を全文で載せない、地雷表の禁止）', async () => {
    const h = harness();
    await h.call('practice_write', {
      slug: 'daily',
      kind: '日報',
      title: '題',
      content: '# 秘密の本文\n\nここには一覧から辿り着けないはずの文がある。',
    });
    const body = await h.call('practice_history', { slug: 'daily' });
    expect(body).toContain('版1');
    expect(body).not.toContain('秘密の本文');
    expect(body).not.toContain('ここには一覧から辿り着けない');
  });

  it('practice_read に version を指定すると過去の版の本文まで読める', async () => {
    const h = harness();
    await h.call('practice_write', { slug: 'daily', kind: '日報', title: '旧', content: '旧本文' });
    await h.call('practice_write', { slug: 'daily', kind: '日報', title: '新', content: '新本文' });

    const v1 = await h.call('practice_read', { slug: 'daily', version: 1 });
    expect(v1).toContain('旧本文');
    expect(v1).not.toContain('新本文');

    const v2 = await h.call('practice_read', { slug: 'daily', version: 2 });
    expect(v2).toContain('新本文');

    // version を省くと、いまの本文（＝最後に書いた版）が返る。
    const current = await h.call('practice_read', { slug: 'daily' });
    expect(current).toContain('新本文');
  });

  it('無い版を指定すると、例外を投げず「無い」と分かる文を返す', async () => {
    const h = harness();
    await h.call('practice_write', { slug: 'daily', kind: '日報', title: '題', content: '本文' });
    const body = await h.call('practice_read', { slug: 'daily', version: 99 });
    expect(body).toContain('無い');
    expect(body).toContain('practice_history');
  });

  it('remove の後も版は読める（版は消えない。#1309 の主題そのもの）', async () => {
    const h = harness();
    await h.call('practice_write', { slug: 'daily', kind: '日報', title: '題', content: '本文' });
    await h.call('practice_remove', { slug: 'daily' });

    const history = await h.call('practice_history', { slug: 'daily' });
    expect(history).toContain('版1');

    const version = await h.call('practice_read', { slug: 'daily', version: 1 });
    expect(version).toContain('本文');
  });

  it('remove した slug を同じ名前で作り直すと、版番号は1へ戻らず続きから振られる', async () => {
    const h = harness();
    await h.call('practice_write', { slug: 'daily', kind: '日報', title: '題1', content: '本文1' });
    await h.call('practice_remove', { slug: 'daily' });
    await h.call('practice_write', { slug: 'daily', kind: '日報', title: '題2', content: '本文2' });

    const history = await h.call('practice_history', { slug: 'daily' });
    expect(history).toContain('版1');
    expect(history).toContain('版2');
    expect(history).not.toContain('版3');

    const v2 = await h.call('practice_read', { slug: 'daily', version: 2 });
    expect(v2).toContain('本文2');
  });

  it('版が1つも無い slug は「無い」と分かる文を返す（例外を投げない）', async () => {
    const h = harness();
    const body = await h.call('practice_history', { slug: 'nothing-here' });
    expect(body).toContain('無い');
  });

  // --- practice_remove -----------------------------------------------------

  it('在る slug を消すと日誌に decision を残す', async () => {
    const h = harness();
    await h.call('practice_write', { slug: 'daily', kind: '日報', title: '日報', content: 'x' });

    const body = await h.call('practice_remove', { slug: 'daily' });
    expect(body).toContain('消した');
    expect(await h.stores.practices.read('daily')).toBeNull();

    const [entry] = await h.stores.journal.list({ types: ['decision'] });
    expect(entry).toMatchObject({ type: 'decision' });
    if (entry?.type !== 'decision') throw new Error('unreachable');
    expect(entry.decision).toContain('daily');
    expect(entry.decision).toContain('消した');
  });

  it('無い slug を消しても冪等——失敗せず、日誌も汚さない', async () => {
    const h = harness();
    const body = await h.call('practice_remove', { slug: 'ghost' });
    expect(body).toContain('もともと無かった');

    const entries = await h.stores.journal.list({ types: ['decision'] });
    expect(entries).toEqual([]);

    // 二度目も落ちない。
    const again = await h.call('practice_remove', { slug: 'ghost' });
    expect(again).toContain('もともと無かった');
  });
});
