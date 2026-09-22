/**
 * **「世代ずれなら起こし直せ」の助言が、生成元1箇所の外で書かれていないかを見る**
 * （Issue #1175）。
 *
 * ## 何を直そうとしているか
 *
 * この助言は 2026-09-22 時点で**6箇所**に散っていた。#1175 の本文は「3箇所」、
 * そのコメントは「4箇所目が在る」と言っていたが、**どちらも過小だった**——
 * `grep` の当て方が「起こし直せ」の言い換えを全部拾えていなかったためである。
 *
 * そして危険なのは数ではなく**守りが揃っていなかったこと**である。#914 の
 * 2026-09-15T21:01:54Z が「**失われるものを過小に言っている**」と名指しした危険に
 * 答えていたのは6箇所のうち1箇所だけで、残り5箇所は「ただし会話は失われる」と
 * だけ言っていた。**実害は観測済み**（2026-09-16 JST、走行中の委譲3本がこの助言
 * どおり止められ、うち1本は未 push の実装を抱えていた）。
 *
 * ⟹ 助言を `STALE_TOKEN_RESTART_ADVICE` 1箇所へ畳んだ。**この検査は、7箇所目が
 * 別の文言で生えることを止める歯である。**
 *
 * ## 2つの文言を見る（どちらも「割れの始まり」の印である）
 *
 * 1. `manager_stop → manager_start で起こし直すこと` —— 助言の行動そのもの。
 *    生成元の外に在れば、それは2つ目の口である
 * 2. `会話は失われる` —— #914 が名指しした過小な言い方。**復活を止める。**
 *    畳んだ後の文言は「失われるのは会話だけではない」であり、この部分文字列を
 *    含まない（`会話は失われる` ではなく `失われるのは会話だけ` である）
 *
 * ## 何を免除しているか（そして、なぜ）
 *
 * - **生成元のファイル自身**（{@link GENERATOR_PATH}）。定数の本体も、経緯を
 *   説明する doc の中の引用も、ここに在るのが正しい
 * - **`*.test.ts`**。順序の歯（`tools.test.ts`）は助言の字面を引いて「前提が
 *   助言より前に在る」ことを測っている。⟹ **テストは生成元の出力を当てる側**で
 *   あって、クローンへ配られる文章を作る側ではない
 * - **この検査自身の core**（{@link CHECKER_CORE_PATH}）。**探す字面を定義して
 *   いるファイルなので、必ず両方の字面を含む。**免除しないと、門は生えた瞬間から
 *   自分自身を指して赤くなり続ける（実際にそうなっていた——`ci` の
 *   `check:stale-token-restart-advice` が6件すべてこのファイルを挙げて落ちた）。
 *   ⚠ **`why` の文も判定に掛かる**ことに注意——判定は `text` の部分文字列一致
 *   だけだが、`why` は説明のために同じ字面を引くので、同じファイルに二重に現れる
 *
 * ## この検査が言えないこと（範囲を広げて読まないこと）
 *
 * - **言い換えは捕まえられない。** 「manager_stop してから manager_start して」と
 *   書けば通る。**部分文字列一致にできるのは、畳んだ字面をそのまま持つ形だけ**
 *   である（`check-sdk-quotes-core.mjs` の同種の断りと同じ形）
 * - **逆向きの助言（起こし直す「な」）は見ていない。** あちらは条件が違い
 *   （`lost` / 失敗で終わったターン）、2026-09-22 時点で8箇所・2種類の字面に
 *   割れていることまでは測ったが、畳む判断は別に分けた
 * - **`lost` の委譲向けの「確かめてから起こし直せ」**（`tools.ts` の `manager.status
 *   === 'lost'` の行）は別の助言である。⟹ 1 の判定に `manager_stop → ` を含めて
 *   あるのは、あれを誤って捕まえないためである
 */

/** 助言の唯一の生成元。ここだけは字面を持ってよい。 */
export const GENERATOR_PATH = 'packages/core/src/usage-limits.ts';

/**
 * 生成元の外に在ってはいけない字面。
 *
 * **`why` は人間向けの説明であって判定には使わない**——判定は `text` の
 * 部分文字列一致だけである（`check-sdk-quotes-core.mjs` と同じ割り切り）。
 */
export const BANNED_PHRASES = [
  {
    id: 'advice',
    text: 'manager_stop → manager_start で起こし直すこと',
    why: '助言の行動そのもの。生成元 STALE_TOKEN_RESTART_ADVICE を参照すること',
  },
  {
    id: 'understatement',
    text: '会話は失われる',
    why: '#914 が「失われるものを過小に言っている」と名指しした言い方。進行中の作業も失われる',
  },
];

/**
 * この検査自身の core。**探す字面の定義そのものを持つので、必ず両方を含む。**
 * ⟹ {@link GENERATOR_PATH} と同じ理由で免除する（字面が在るのが正しい場所である）。
 */
export const CHECKER_CORE_PATH = 'scripts/check-stale-token-restart-advice-core.mjs';

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
export function findStaleTokenAdviceHits(files) {
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
