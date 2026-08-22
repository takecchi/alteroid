/**
 * 記憶をクローンの文脈へ載せる形（＝1つの文字列にする）を決める場所。
 *
 * **ここが器（fs / pg / インメモリ）の側にあってはならない。** 載せ方はクローンの
 * 文脈の設計であって保存形式ではない。器ごとに書いていた結果、実際に食い違った —
 * `FsPersonaStore` と `PgPersonaStore` は `<!-- memory: slug.md -->` の見出しを
 * 付けていたのに、テストのインメモリ実装だけが本文をただ連結していた。**見出しが
 * 無い形でテストが緑になっていた**ので、「どの文書が変わったか」を見出しで指す
 * 実装をテストで確かめられない状態だった（AGENTS.md「固定値を返すスタブは
 * テストを緑にしたまま分岐を殺す」と同じ形である）。
 *
 * 見出しを付ける理由そのものは2つある。
 *
 * 1. 人間が開くのは `~/.alteroid/memory/*.md` という**別々のファイル**である。
 *    連結してしまうと、クローンは「どのファイルに書いてあったか」を言えなくなる。
 * 2. 走行中に変わった文書だけを載せ直せる（`clone.ts` の `#withFreshMemory`）。
 *    システムプロンプトに載っている塊と同じ見出しで指せるので、クローンは
 *    「どれが差し替わったか」を自分で対応付けられる。
 */

import type { MemoryProtectionStatus } from './schema.js';

/** 記憶を載せるときの1文書ぶんの単位。`MemoryDocument` はこれを満たす。 */
export interface MemoryPart {
  slug: string;
  content: string;
}

// ---------------------------------------------------------------------------
// 記憶の保護状態（human guard）— 判定と描画
// ---------------------------------------------------------------------------

/**
 * `MemoryProtectionStatus`（`schema.ts`）の3状態を網羅していることを型で強制する。
 *
 * **状態を1つ足したら、この関数を呼んでいる `switch` の `default` 節で
 * `never` への代入ができなくなり `tsc` が落ちる。** 分岐を書き足し忘れて
 * 未知の状態が黙って `unknown` 側へ倒れる実装を防ぐための、唯一の網羅性
 * チェックである。実行時にここへ来るのは型で弾かれたはずの値が渡ったときだけ
 * なので、投げて構わない。
 */
export function assertNeverMemoryProtectionStatus(status: never): never {
  throw new Error(`未知の記憶保護状態: ${JSON.stringify(status)}`);
}

/**
 * `distill`（統合の走行）からの全文置換・削除を許すか。
 *
 * **量（文字数の減少率）では判定しない。** 蒸留は正当な運用として大きく畳む
 * ことがあるので、判定軸は「保護状態 × 書き手」だけである（書き手側の判定は
 * `tools.ts` が持つ）。ここは保護状態の側だけを見る。
 *
 * - `human` / `unknown` → 断る（`unknown` は守る側へ倒す）
 * - `clone-only` → 通す
 */
export function memoryProtectionAllowsFullReplace(status: MemoryProtectionStatus): boolean {
  switch (status.kind) {
    case 'human':
      return false;
    case 'unknown':
      return false;
    case 'clone-only':
      return true;
    default:
      return assertNeverMemoryProtectionStatus(status);
  }
}

/** 保護状態を人間可読な一言にする（歯が断るときの返答に使う）。 */
export function describeMemoryProtectionStatus(status: MemoryProtectionStatus): string {
  switch (status.kind) {
    case 'human':
      return '人間が過去に書いた記憶（human）';
    case 'clone-only':
      return 'クローンだけが書いてきた記憶（clone-only）';
    case 'unknown':
      return '履歴が無い、または外から書き換えられた可能性がある記憶（unknown。守る側の既定）';
    default:
      return assertNeverMemoryProtectionStatus(status);
  }
}

/**
 * 1文書ぶん。見出しは人間が開くファイル名と同じ形にする（`slug.md`）。
 *
 * 末尾の空白行だけ落とす。**先頭や本文には触らない** — 人間の手書きの記述を
 * 整形の都合で書き換えないこと（`prompt.ts` の「記憶」の節と同じ約束）。
 */
export function renderMemoryDocument({ slug, content }: MemoryPart): string {
  return `<!-- memory: ${slug}.md -->\n${content.trimEnd()}`;
}

/** 記憶の全文。文書の順序は呼び手（ストア）が決めた順そのままである。 */
export function renderMemoryDocuments(documents: readonly MemoryPart[]): string {
  return documents.map(renderMemoryDocument).join('\n\n');
}
