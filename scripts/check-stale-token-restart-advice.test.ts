import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// ⚠ **1行に畳んである。** `@ts-expect-error` は次の1行にしか効かないので、
// 多行 import にすると `from` の行（実際に TS7016 が出る場所）へ届かない。
// prettier-ignore
// @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
import { BANNED_PHRASES, CHECKER_CORE_PATH, GENERATOR_PATH, findStaleTokenAdviceHits, isExempt } from './check-stale-token-restart-advice-core.mjs';

type Hit = { path: string; id: string; text: string; why: string; line: number };
type Phrase = { id: string; text: string; why: string };

/**
 * **門が空振りしないことを、毎回当て直す**（Issue #1175）。
 *
 * ⚠ 作った日に手で1回「赤くなった」を見ただけでは、**明日それが空振りへ戻っても
 * 誰も気づかない**。⟹ 陰性対照そのものをテストにして残す（#1220 で同じ形を採った）。
 *
 * ここで測るのは4つ:
 *
 * 1. 生成元の外に字面が在れば**赤くなる**（空振りしない）
 * 2. 生成元のファイル自身は**免除される**（定数の本体と、経緯を説明する doc の引用）
 * 3. `*.test.ts` は**免除される**（順序の歯は助言の字面を引いて当てる側である）
 * 4. ⭐ `lost` 向けの別の助言を**誤って捕まえない**（偽陽性の歯）
 */
describe('check-stale-token-restart-advice', () => {
  const advice = (BANNED_PHRASES as Phrase[]).find((p) => p.id === 'advice');
  const understatement = (BANNED_PHRASES as Phrase[]).find((p) => p.id === 'understatement');

  it('2つの字面（助言そのもの・過小な言い方）を見ている', () => {
    expect(advice?.text).toBe('manager_stop → manager_start で起こし直すこと');
    expect(understatement?.text).toBe('会話は失われる');
  });

  it('生成元の外に助言の字面が在れば捕まえる（＝空振りしない）', () => {
    const hits = findStaleTokenAdviceHits([
      {
        path: 'packages/core/src/tools.ts',
        content: `const x = '429 が続くなら ${advice?.text}（新しい鍵で走る）。';`,
      },
    ]) as Hit[];

    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe('advice');
    expect(hits[0]?.line).toBe(1);
  });

  it('過小な言い方（#914 が名指しした「会話は失われる」）の復活も捕まえる', () => {
    const hits = findStaleTokenAdviceHits([
      {
        path: 'packages/core/src/manager.ts',
        content: `// 起こし直す（${understatement?.text}）。`,
      },
    ]) as Hit[];

    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe('understatement');
  });

  it('生成元のファイル自身は免除される（定数も、経緯の doc の引用も、そこに在るのが正しい）', () => {
    expect(isExempt(GENERATOR_PATH)).toBe(true);

    const hits = findStaleTokenAdviceHits([
      { path: GENERATOR_PATH, content: `export const A = '${advice?.text}';` },
    ]) as Hit[];

    expect(hits).toEqual([]);
  });

  it('テストは免除される（助言の字面を引いて当てる側であって、配る側ではない）', () => {
    const hits = findStaleTokenAdviceHits([
      {
        path: 'packages/core/src/tools.test.ts',
        content: `expect(reply).toContain('${advice?.text}');`,
      },
    ]) as Hit[];

    expect(hits).toEqual([]);
  });

  /**
   * ⭐ **偽陽性の歯。** `lost` の委譲向けの助言（「まずそこを確かめ、続きが要ると
   * 判断したときだけ manager_start で起こし直すこと」）は**別の助言**であり、
   * 独自の前提を既に持っている。⟹ これを捕まえる形にすると、門は「無関係な行を
   * 赤くする道具」になり、次の人が免除表へ逃がして**本物の割れを見逃す**側へ倒れる。
   *
   * 判定の字面に `manager_stop → ` を含めてあるのは、まさにこれを外すためである。
   */
  /**
   * ⭐ **門が自分自身を指して落ちないこと。** このファイル（検査の core）は
   * **探す字面の定義そのもの**を持つので、必ず両方の字面を含む。免除が無いと、
   * 門は生えた瞬間から赤くなり続ける——**実際にそうなっていた**（PR #1286 の
   * `ci` が、6件すべてこの core を挙げて落ちた）。
   */
  it('⭐ この検査自身の core は免除される（探す字面の定義を持つので、必ず両方を含む）', () => {
    expect(isExempt(CHECKER_CORE_PATH)).toBe(true);

    const hits = findStaleTokenAdviceHits([
      {
        path: CHECKER_CORE_PATH,
        content: `text: '${advice?.text}', why: '${understatement?.text}'`,
      },
    ]) as Hit[];

    expect(hits).toEqual([]);
  });

  /**
   * ⚠ **免除が空振りしていないことを、実物で当て直す。** 上の歯は「その
   * パスなら免除される」しか言わない——**core のファイル名が変われば
   * `CHECKER_CORE_PATH` は実在しないパスを指したまま緑を返し、門はまた
   * 自分自身で赤くなる。** ⟹ 定数が指す先が実在し、実際に両方の字面を
   * 含むことまで見る。
   */
  it('⭐ CHECKER_CORE_PATH は実在し、実際に両方の字面を含む（免除が空振りしていない）', () => {
    const content = readFileSync(new URL(`../${CHECKER_CORE_PATH}`, import.meta.url), 'utf8');

    expect(content).toContain(advice?.text);
    expect(content).toContain(understatement?.text);
  });

  it('lost 向けの別の助言は捕まえない（偽陽性で門を腐らせない）', () => {
    const hits = findStaleTokenAdviceHits([
      {
        path: 'packages/core/src/tools.ts',
        content:
          "const y = 'まずそこを確かめ、続きが要ると判断したときだけ manager_start で起こし直すこと。';",
      },
    ]) as Hit[];

    expect(hits).toEqual([]);
  });
});
