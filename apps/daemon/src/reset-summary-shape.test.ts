import { createMemoryStores, resetWorkspaceState } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { resetResponseSchema } from './openapi.js';

/**
 * `POST /reset` の応答の形が、`WorkspaceResetSummary` の全部を運ぶことを測る。
 *
 * ## ⭐ なぜこの歯が要るのか（変異試験で穴が実測された）
 *
 * `app.ts` は `resetResponseSchema.parse({ cleared })` を通して応答を返す。
 * **zod は既定で未知のキーを黙って捨てる。** ⟹ 器を1つ足して
 * `WorkspaceResetSummary` に欄が増えたとき、**この schema へ足し忘れると
 * 「消したのに申告に出ない」が完成する** —— HTTP は 200、CLI も画面も何も
 * 言わない。
 *
 * #1055 段3（やり方の器）の作業中に、この形を変異として当てて確かめた:
 * `resetResponseSchema` から `practices` の1行を消しても、**当時あった歯は
 * 1本も赤くならなかった**（`auth.test.ts` の `POST /reset` は状態コードしか
 * 見ていない）。⟹ 歯は在ったが、この軸は測っていなかった。
 *
 * ## 測り方
 *
 * 特定の欄を名指ししない。**実物の `resetWorkspaceState` が返す鍵の集合**と
 * schema の鍵の集合を比べる —— こうしておけば、次に器が増えたときも
 * 名指しを足さずに赤くなる。
 */
describe('POST /reset の応答の形', () => {
  it('⭐ `WorkspaceResetSummary` の欄が1つでも schema から落ちていたら赤くなる', async () => {
    const summary = await resetWorkspaceState(createMemoryStores());
    const schemaKeys = Object.keys(resetResponseSchema.shape.cleared.shape).sort();
    // `sessionLog` は pg 構成でだけ付く（`WorkspaceResetSummary.sessionLog` の doc）。
    // インメモリの器では出ないので、突き合わせる側から外す。
    const expected = [...Object.keys(summary), 'sessionLog'].sort();
    expect(schemaKeys).toEqual(expected);
  });

  it('⭐ 実際に parse を通しても欄が落ちない（zod が黙って捨てる経路そのもの）', async () => {
    const cleared = await resetWorkspaceState(createMemoryStores());
    const parsed = resetResponseSchema.parse({ cleared });
    expect(Object.keys(parsed.cleared).sort()).toEqual(Object.keys(cleared).sort());
  });
});
