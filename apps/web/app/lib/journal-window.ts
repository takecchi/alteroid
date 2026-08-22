/**
 * 日誌の双方向スクロールを支える純粋なロジック。**virtua にも DOM にも触れない。**
 *
 * ここを切り出したのは「テストが書けない構造は、テストが無いのと同じ」
 * （`AGENTS.md`「テストを弱めずに直す」）に当たると判断したため。`virtua` は
 * jsdom では要素の実寸を測れず（`ResizeObserver` を呼んでも `offsetParent` が
 * 常に `null` なので測定コールバックが一度も来ない）、日誌の行を1行も描画
 * しない。カーソル送り（次に投げるクエリの組み立て・`id` での重複除去・
 * 停止条件）を DOM 描画から切り離しておけば、**virtua が描けるかどうかと
 * 無関係に**このロジックの正しさを測れる。
 *
 * **出力・挙動は元の `journal.tsx`（`useMemo` で `recent` を履歴へ重ねていた
 * 部分）と1文字も変えていない** — `id` で重複を除く／新しい順を保つ、という
 * 規則をそのまま関数に切り出しただけである。変わったのは「誰が呼ぶか」で
 * あって「何をするか」ではない。
 */
import type { JournalEntry } from '~/lib/types';

/** ページ（1回の `GET /journal` 応答）を、既にある一覧の**先頭**へ差し込む。 */
export interface MergeResult {
  /** マージ後の一覧（新しい順を保つ）。 */
  entries: JournalEntry[];
  /** 重複除去の後に残った、本当に新しい件数。 */
  freshCount: number;
}

/**
 * 先頭（新着側）へ差し込む。SSE の `recent` を重ねるときも、`since` で
 * 取りこぼしを埋めるときも、**この1つの関数を通る** — 「先頭に足す」という
 * 操作が1箇所にまとまっていることが、`shift` を立てる条件（先頭へ足すときだけ
 * true にする）を取り違えないための前提になる。
 */
export function mergeFront(existing: JournalEntry[], incoming: JournalEntry[]): MergeResult {
  if (incoming.length === 0) return { entries: existing, freshCount: 0 };
  const known = new Set(existing.map((entry) => entry.id));
  const fresh = incoming.filter((entry) => !known.has(entry.id));
  return {
    entries: fresh.length === 0 ? existing : [...fresh, ...existing],
    freshCount: fresh.length,
  };
}

/** 末尾（過去側）へ差し込む。`until` で遡ったページをここへ通す。 */
export function mergeBack(existing: JournalEntry[], incoming: JournalEntry[]): MergeResult {
  if (incoming.length === 0) return { entries: existing, freshCount: 0 };
  const known = new Set(existing.map((entry) => entry.id));
  const fresh = incoming.filter((entry) => !known.has(entry.id));
  return {
    entries: fresh.length === 0 ? existing : [...existing, ...fresh],
    freshCount: fresh.length,
  };
}

/**
 * サーバの `limit` の上限（`apps/daemon/src/app.ts` の `journalQuery`:
 * `z.coerce.number().int().min(1).max(1000)`）。**手で書き写した値**である
 * — `apps/web` は daemon の zod スキーマに依存しない設計（`AGENTS.md`
 * 「実装の前提」）なので、ここに定数として持つ。daemon 側が上限を変えたら
 * ここも直すこと。
 */
export const JOURNAL_MAX_LIMIT = 1000;

/**
 * ページを撃った結果、次に何をすべきか。
 *
 * **`since`/`until` は inclusive**（`apps/daemon/src/app.ts` の `journalQuery`
 * doc、fs 実装は `packages/storage-fs/src/journal.ts` の `<`/`>` 比較）。境界の
 * 1件は毎回必ず再度返るので、「新規0件」だけでは撃ち続けてしまう
 * （`packages/storage-fs/src/journal.ts` の `#chain` が示すとおり、同一ミリ秒の
 * 複数追記が起こりうるため、境界と同じ `at` を持つエントリが1ページを埋め
 * 尽くすと `until`/`since` を動かしても1件も進まない）。
 *
 * - `freshCount > 0` → **`'progress'`**。前進できた。まだ続けてよい
 * - `freshCount === 0` かつ応答が `limit` に満たない → **`'end'`（本当の終端）**。
 *   サーバの `list()` は取れるだけ取ってから返すので、`limit` 未満で返った
 *   時点で「探しうる範囲を全部見た」ことが確定する
 * - `freshCount === 0` かつ応答が `limit` ちょうど かつ `limit < maxLimit` →
 *   **`'retryLarger'`（詰まっている疑い）**。ページが1件も進んでいないのに
 *   `limit` を使い切っているので、境界と同じ `at` を持つエントリが `limit`
 *   件を超えて並んでいて隠れている可能性がある。**ここで黙って終端扱いに
 *   しないこと** — `limit` を上げて同じ境界を撃ち直せば前進できるかもしれない
 *   （`GET /commitments` 等と違い `GET /journal` は `scanned` のような
 *   「遡り切れていない」印を返さないので、ここで判定を持つ）
 * - `freshCount === 0` かつ応答が `limit` ちょうど かつ `limit >= maxLimit` →
 *   **`'blocked'`**。サーバが許す上限まで上げても1件も進まない＝同一 `at` を
 *   持つエントリが `maxLimit` 件を超えて並んでいる。**これは「終端」でも
 *   「空」でもない、`GET /journal` の `scanned` を持たない設計から来る
 *   本物の限界**なので、`Empty` や「これより古い記録は無い」と同じ顔で
 *   出さない（`apps/daemon/src/app.ts` の `conversationsQuery` の doc
 *   「黙って打ち切らない」と同じ理由）
 */
export type PageOutcome = 'progress' | 'end' | 'retryLarger' | 'blocked';

export function pageOutcome(
  pageLength: number,
  limit: number,
  freshCount: number,
  maxLimit: number = JOURNAL_MAX_LIMIT,
): PageOutcome {
  if (freshCount > 0) return 'progress';
  if (pageLength < limit) return 'end';
  return limit < maxLimit ? 'retryLarger' : 'blocked';
}

/** 次に `until` へ渡す値（一覧の末尾＝最古のエントリの `at`）。 */
export function oldestAt(entries: JournalEntry[]): string | undefined {
  return entries.at(-1)?.at;
}

/** 次に `since` へ渡す値（一覧の先頭＝最新のエントリの `at`）。 */
export function newestAt(entries: JournalEntry[]): string | undefined {
  return entries[0]?.at;
}

export interface PageApplication {
  entries: JournalEntry[];
  outcome: PageOutcome;
  freshCount: number;
}

/**
 * `until` で撃った1ページを末尾へ適用する（マージ＋判定を1回で行う）。
 * `use-journal-window.ts` が使う、フック側の複雑さを減らすための合成。
 */
export function applyOlderPage(
  existing: JournalEntry[],
  page: JournalEntry[],
  limit: number,
  maxLimit: number = JOURNAL_MAX_LIMIT,
): PageApplication {
  const merged = mergeBack(existing, page);
  return {
    entries: merged.entries,
    outcome: pageOutcome(page.length, limit, merged.freshCount, maxLimit),
    freshCount: merged.freshCount,
  };
}

/** `since` で撃った1ページ、または SSE の `recent` を先頭へ適用する。 */
export function applyNewerPage(
  existing: JournalEntry[],
  page: JournalEntry[],
  limit: number,
  maxLimit: number = JOURNAL_MAX_LIMIT,
): PageApplication {
  const merged = mergeFront(existing, page);
  return {
    entries: merged.entries,
    outcome: pageOutcome(page.length, limit, merged.freshCount, maxLimit),
    freshCount: merged.freshCount,
  };
}

/**
 * 種別チップの選択を `recent`（SSE で届いた生の受信）へも掛け直す。
 *
 * `useJournal` はサーバへ絞り込みを投げるが、`recent` は絞られていない生の
 * 受信なので、ここで同じ条件を掛け直さないと絞り込んでいるはずの画面に
 * 無関係な種別が混ざる（元の `journal.tsx` の `useMemo` の doc をそのまま
 * 移設）。
 */
export function filterByType(
  entries: JournalEntry[],
  selected: readonly JournalEntry['type'][],
): JournalEntry[] {
  return selected.length === 0 ? entries : entries.filter((entry) => selected.includes(entry.type));
}

/**
 * 先頭に何か足された（`wasPrepend`）とき、virtua の `shift` に何を渡すか。
 *
 * **人間の判断（2026-08-23）: 新着は自動で先頭に積む形を保つ。** 「貯めて
 * ボタンを押させたら流す」形（一部の SNS クライアントに見られる cuculus 式）
 * は採らない — 日誌は可観測性の画面で、押さないと最新が見えない形にすると
 * 画面の役目そのものが削れる（north_star 禁止1に触れる）。そのうえで:
 *
 * - 利用者が **上端に居る**（新着をそのまま見ている） → `shift: false`。
 *   新着がそのまま視界に増える。**これは仮想化する前の挙動と同じ**
 * - 利用者が **下へ遡って読んでいる** → `shift: true`。読んでいる行が
 *   新着の追加でずれない（virtua の doc: 「useful for reverse infinite
 *   scrolling」）
 *
 * **`atTop` の判定そのもの（何 px 以内を「上端」と見るか）はここの責務では
 * ない**（呼び出し側の `journal.tsx` が持つ）。ここが持つのは
 * 「`wasPrepend`/`atTop` の組がどの `shift` に落ちるか」という決定表だけ
 * ——**この決定はここで測れる**（jsdom でも、DOM が無くても、純粋な値の
 * 対応として検証できる）。**測れないのはこの先** — `shift: true` を渡した
 * あと virtua が実際にスクロール位置を保つかどうかは、jsdom が layout を
 * 持たないため測れない（`journal.test.tsx` 冒頭のコメント）。
 */
export function shiftForPrepend(wasPrepend: boolean, atTop: boolean): boolean {
  return wasPrepend && !atTop;
}
