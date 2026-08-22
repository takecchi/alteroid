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
import type { JournalStore } from './store.js';

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

// ---------------------------------------------------------------------------
// 記憶の保護状態（human guard）— 索引の組み直し
// ---------------------------------------------------------------------------

/**
 * 日誌全体から、slug ごとの「最後に `cause:'human'`（`action !== 'remove'`）で
 * 書かれた時刻」を導出する。
 *
 * **判定基準の単一の実装である。** 呼ぶのは3か所——`apps/daemon/src/storage.ts`
 * の起動時 backfill、`FsPersonaStore` / `PgPersonaStore` の索引の組み直し
 * （読み出し時に索引を失っていたと分かったとき）。3か所が別々に基準を書くと、
 * 片方だけ直して残りが古い基準のまま、という穴ができる。
 *
 * **`action:'remove'` は含めない。** 人間による削除は「将来この slug に書かれる
 * 新しい内容」を無条件に保護する理由にはならない
 * （`apps/daemon/src/app.ts` の `DELETE /memory/:slug` ハンドラの doc と同じ判断。
 * `markHumanTouched` を呼ぶのが `PUT` だけで `DELETE` では呼ばないのもこれに揃えた
 * ためである）。
 *
 * `journal.list({ types: ['memory_update'] })` は新しい順に返るので、先に
 * 見つかった（＝新しい）ほうを残す。
 */
export async function deriveHumanTouchedAtFromJournal(
  journal: Pick<JournalStore, 'list'>,
): Promise<Map<string, string>> {
  const entries = await journal.list({ types: ['memory_update'] });
  const result = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== 'memory_update') continue;
    if (entry.cause !== 'human') continue;
    if (entry.action === 'remove') continue;
    if (!result.has(entry.slug)) result.set(entry.slug, entry.at);
  }
  return result;
}

/**
 * 保護状態の索引（派生値）を日誌から組み直したことを記録する日誌エントリの本文。
 *
 * **`memory_update` は使わない。** 記憶（本文）は変わっていない。変わったのは
 * 派生値だけである。**新しい `JournalEntryType` も足さない** — 既存の `decision`
 * で表現できる（`apps/daemon/src/app.ts` は daemon 内部の判断でも同じ型を使う）。
 * 種別を新設すると `apps/web` とクローンの道具（`journal_read` の整形）が
 * 型で落ちる形になっているはずなので、そちらを直す作業が要る
 * （PR #140「日誌の種別を足したときに web の2か所が型で落ちるようにする」）。
 *
 * **この組み直しが何を失い、何を失わないかをここに書く。** `humanTouchedAt`
 * （人間が書いたという保護の信号そのもの）は日誌から完全に復元できるので、
 * **保護は失われない**。失われるのは**外部編集の検出の履歴**だけである——
 * ハッシュは日誌に無いので、組み直す瞬間の本文の値で新しく基準化する
 * （「ここから先を見張る」）。**組み直し以前に外部編集があったとしても、
 * この組み直しはそれを「無かったこと」にする。** これを「外部編集が無かった
 * 証拠」として読まないこと——単に、組み直し以前の履歴は失われただけである。
 */
export function memoryProtectionRebuildDecision(counts: {
  humanRestored: number;
  hashesBaselined: number;
}): { decision: string; grounds: string } {
  return {
    decision:
      '記憶の保護状態の索引（派生値）を日誌から組み直した' +
      `（human 印 ${counts.humanRestored} 件を復元、本文のハッシュ ${counts.hashesBaselined} 件を` +
      '現在の値で基準化）。',
    grounds:
      '索引が読めなかった（無い・壊れている・スキーマが合わない）ため、次の読み出しでその場で' +
      '組み直した。cause:human の記録は日誌が持つので保護（human 印）は失われていないが、' +
      'この組み直しより前に外部から本文が書き換えられていたとしても、それはもう検出できない' +
      '（ハッシュは日誌に無いので、組み直す瞬間の本文の値で新しく基準化するため）。',
  };
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
