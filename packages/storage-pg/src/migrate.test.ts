import { describe, expect, it } from 'vitest';

import { STATEMENTS } from './migrate.js';

/**
 * **`migrate` の配列そのものを構造で見る歯。**
 *
 * `migrate` は起動のたびにこの配列を頭から通す。だから「作ってから、同じ配列の
 * 後ろで drop する」索引が1つでもあると、**2周目はその create が本当に走る**
 * （`if not exists` が名前で一致しないため）。そして2周目が走るころには、新しい
 * 鍵が許した行 — 古い鍵から見れば重複 — が積まれている。
 * `could not create unique index … is duplicated` で `migrate` が落ち、
 * **デーモンが2度と起動できなくなる**（実際に起きた。2026-08-25、
 * `usage_daily_key_idx`）。
 *
 * **振る舞いの歯（`usage.test.ts` の「起動を2回通す」）だけでは足りない。**
 * あちらは `usage_daily` の1件を見るもので、**別のテーブルで同じ形を作ったら
 * 何も言わない。** ここは配列の全体を1つの規則で見るので、次に誰かが
 * `drop index` を足したときに、その場で落ちる。
 */
describe('migrate の配列（起動のたびに頭から通るもの）', () => {
  /** `create [unique] index if not exists <名前>` の名前。 */
  function createdIndexNames(statement: string): string[] {
    return [
      ...statement.matchAll(/create\s+(?:unique\s+)?index\s+if\s+not\s+exists\s+(\w+)/gi),
    ].map((match) => match[1] as string);
  }

  /** `drop index if exists <名前>` の名前。 */
  function droppedIndexNames(statement: string): string[] {
    return [...statement.matchAll(/drop\s+index\s+(?:if\s+exists\s+)?(\w+)/gi)].map(
      (match) => match[1] as string,
    );
  }

  it('drop する索引を、同じ配列のどこかで create していない（2周目が作りに戻らない）', () => {
    const dropped = new Set(STATEMENTS.flatMap(droppedIndexNames));
    const created = new Set(STATEMENTS.flatMap(createdIndexNames));

    // **前後は問わない。** create が drop より前でも後でも、配列は毎回頭から
    // 通るので同じ事故になる（後ろに置けば「作って残す」つもりが drop され、
    // 前に置けば「消したはずのものを作りに戻る」）。名前が両方に出た時点で誤り。
    const both = [...dropped].filter((name) => created.has(name));
    expect(both).toEqual([]);
  });

  /**
   * 上のテストが**測れていることの確認ではない**（それは変異試験の仕事）。
   * ここが見るのは「この歯が空振りしていないか」— drop も create も1つも
   * 拾えていない正規表現なら、上は常に緑になる。
   */
  it('歯が実際に文を拾えている（正規表現が空振りしていない）', () => {
    expect(STATEMENTS.flatMap(droppedIndexNames)).toContain('usage_daily_key_idx');
    expect(STATEMENTS.flatMap(createdIndexNames)).toContain('usage_daily_token_key_idx');
  });
});
