/**
 * **「manager_start で起こし直す前に確かめろ」という向きの助言が、生成元1箇所の
 * 外で書かれていないかを見る**（Issue #1287）。
 *
 * ## 何を直そうとしているか
 *
 * PR #1286（Issue #1175）は「世代ずれなら起こし直**せ**」という助言を1箇所へ
 * 畳んだ。この検査が見るのは**逆向き**——「`lost` / 失敗で終わったターンでは、
 * 確かめる前に `manager_start` で起こし直す**な**」——である。#1175 はこちらを
 * 意図して射程から外していたが、2026-09-23 時点でここにも同じ病（1箇所ずつ
 * 触ると必ず割れる）が実際に出ていた。
 *
 * `main` = `a6f201c` 時点の実測: 逐語 `manager_start で起こし直さないこと` は
 * `packages/core/src/tools.ts` に**8箇所**、字面が2種類に割れていた
 * （`先に manager_start で起こし直さないこと` が7箇所、`確かめる前に
 * manager_start で起こし直さないこと` が1箇所）。加えて `packages/core/src/
 * situation.ts` の `LOST_NOTICE` に、バッククォート付き（`` `manager_start` ``）
 * の9箇所目が在った——バッククォートがあるので上の逐語には当たらず、別に数える
 * 必要があった。
 *
 * ⟹ 助言を `RESTART_BEFORE_CHECK_ADVICE` / `RESTART_BEFORE_CHECK_ADVICE_CODE_SPAN`
 * （`packages/core/src/usage-limits.ts`）へ畳んだ。**この検査は、10箇所目が
 * 別の文言・古い文言で生えることを止める歯である。**
 *
 * ## 3つの文言を見る（どれも「割れの始まり」の印である）
 *
 * 1. `先に manager_start で起こし直さないこと` —— 旧字面（#1287 で統一する前の
 *    多数派）。復活を止める
 * 2. `確かめる前に manager_start で起こし直さないこと` —— 統一後の字面
 *    （バッククォート無し）。生成元定数を使わず直接書かれていれば、それは
 *    2つ目の口である
 * 3. `確かめる前に \`manager_start\` で起こし直さないこと` —— 統一後の字面
 *    （バッククォート有り、`situation.ts` の慣習）。同じく直接書かれていれば
 *    2つ目の口である
 *
 * ## 何を免除しているか（そして、なぜ）
 *
 * - **生成元のファイル自身**（{@link GENERATOR_PATH}）。定数の本体も、経緯を
 *   説明する doc の中の引用も、ここに在るのが正しい
 * - **`*.test.ts`**。`tools.test.ts` / `situation.test.ts` の歯は、生成された
 *   本文に助言の字面が実際に含まれることを引いて測っている。⟹ **テストは
 *   生成元の出力を当てる側**であって、クローンへ配られる文章を作る側ではない
 * - **この検査自身の core**（{@link CHECKER_CORE_PATH}）。**探す字面を定義して
 *   いるファイルなので、必ず全部の字面を含む。**免除しないと、門は生えた瞬間
 *   から自分自身を指して赤くなり続ける（`check-stale-token-restart-advice-core.mjs`
 *   が最初に踏んだのと同じ形。PR #1286 の doc を見よ）
 *
 * ## この検査が言えないこと（範囲を広げて読まないこと）
 *
 * - **言い換えは捕まえられない。** 部分文字列一致にできるのは、畳んだ字面を
 *   そのまま持つ形だけである
 * - **`manager.ts` の言い換えの族（「新しく起こし直さないこと」「ここで
 *   起こし直さないこと」）は見ていない。** 場面が違う（貸し出しの関門）ので、
 *   この生成元の射程に含めていない（Issue #1287 のコメントの実測）
 * - **同じ向きの助言が言い換えでもう1つ生えたら、これは捕まえない。** ここで
 *   捕まえられるのは、畳んだ3つの字面そのものの再出現だけである
 */

/** 助言の唯一の生成元。ここだけは字面を持ってよい。 */
export const GENERATOR_PATH = 'packages/core/src/usage-limits.ts';

/**
 * 生成元の外に在ってはいけない字面。
 *
 * **`why` は人間向けの説明であって判定には使わない**——判定は `text` の
 * 部分文字列一致だけである（`check-stale-token-restart-advice-core.mjs` と
 * 同じ割り切り）。
 */
export const BANNED_PHRASES = [
  {
    id: 'old',
    text: '先に manager_start で起こし直さないこと',
    why:
      '旧字面（#1287 で統一する前）。生成元 RESTART_BEFORE_CHECK_ADVICE / ' +
      'RESTART_BEFORE_CHECK_ADVICE_CODE_SPAN に揃えること',
  },
  {
    id: 'unified-plain',
    text: '確かめる前に manager_start で起こし直さないこと',
    why: '統一後の字面（バッククォート無し）。生成元定数 RESTART_BEFORE_CHECK_ADVICE を使わず直接書かれている',
  },
  {
    id: 'unified-code',
    text: '確かめる前に `manager_start` で起こし直さないこと',
    why:
      '統一後の字面（バッククォート有り）。生成元定数 RESTART_BEFORE_CHECK_ADVICE_CODE_SPAN を' +
      '使わず直接書かれている',
  },
];

/**
 * この検査自身の core。**探す字面の定義そのものを持つので、必ず全部を含む。**
 * ⟹ {@link GENERATOR_PATH} と同じ理由で免除する（字面が在るのが正しい場所である）。
 */
export const CHECKER_CORE_PATH = 'scripts/check-restart-before-check-advice-core.mjs';

/** そのパスが免除されるか（生成元自身か、この検査自身の core か、テストか）。 */
export function isExempt(path) {
  return path === GENERATOR_PATH || path === CHECKER_CORE_PATH || path.endsWith('.test.ts');
}

/**
 * 渡されたファイル群から違反を集める。**純粋関数**（読み込みは呼び出し側）。
 *
 * @param files `{ path, content }` の配列
 * @returns `{ path, id, text, why, line }` の配列（見つからなければ空）
 */
export function findRestartBeforeCheckAdviceHits(files) {
  const hits = [];
  for (const file of files) {
    if (isExempt(file.path)) continue;
    const lines = file.content.split('\n');
    for (const phrase of BANNED_PHRASES) {
      lines.forEach((text, index) => {
        if (!text.includes(phrase.text)) return;
        hits.push({
          path: file.path,
          id: phrase.id,
          text: phrase.text,
          why: phrase.why,
          line: index + 1,
        });
      });
    }
  }
  return hits;
}
