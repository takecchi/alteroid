/**
 * `lastSystemError`（Node が構造として持つ失敗の分類 `code`/`errno`/`syscall`）
 * を人が読む一文へ整形する、**唯一の定義元**（#713 段3。切り出しは横断
 * レビュー指摘——クローンの一覧（`tools.ts`）と Web UI の診断欄
 * （`apps/web/app/routes/manager-detail.tsx`）が、同じ文言を別々に複製して
 * いた）。
 *
 * **`mask-url.ts` / `job-status-running.ts` と同じ形。** ブラウザのバンドルへ
 * 入る軽い口（`@alteroid/core/system-error-format`。`tsup.config.ts` の
 * `entry` の doc）にするため、**import を1つも持たない。**
 *
 * ## なぜ手で複製した型を使うか（`system-error.ts` を import しない）
 *
 * `system-error.ts` は `systemErrorFactsSchema`（zod）を同じファイルに持ち、
 * zod は実行時の依存になる——`job-status-running.ts` の同じ doc と同じ理由で、
 * ここから型を取ると zod ごとブラウザバンドルへ入る。構造的に一致すること
 * は `schema.ts` の `_AssertSystemErrorFactsMatchesLikeType` が保証する。
 *
 * ## D（判定できなかった）の文言は、末尾だけ呼び出し元で変わる
 *
 * クローン向け（`tools.ts` / `system-error.ts` の `SYSTEM_ERROR_UNKNOWN_NOTE`）
 * と Web UI 向け（`manager-detail.tsx`）は、末尾の「次にどこを見ればよいか」の
 * 指し先が違う——クローン向けは欄名 `lastFailure` を直接指すが、Web はその欄を
 * 画面に出していないので、代わりに画面上の該当セクションの見出しを指す
 * （移設前の `manager-detail.tsx` の doc に同じ理由が書いてあった）。
 * **これは文言のずれではなく意図した分岐なので、末尾だけ引数
 * （{@link formatSystemErrorUnknownNote} の `pointer`）にして、共通部分
 * （枠 429 と判定不能を混同しないという本文）だけを1箇所にまとめた。**
 * 呼び出し側は自分の指し先を渡すだけで、共通部分の字面が割れる余地が無くなる。
 *
 * ## 元の場所（`system-error.ts`）との関係
 *
 * `system-error.ts` はこの2つ（{@link formatSystemErrorFacts} と、クローン向けの
 * 指し先で固定した `SYSTEM_ERROR_UNKNOWN_NOTE`）をここから import して
 * re-export する——既存の import 元（`tools.ts` / 各 `*.test.ts`）を1つも
 * 書き換えないため。**文言・ロジックは1文字も変えていない**（移しただけ）。
 */

/**
 * `formatSystemErrorFacts` が受ける入力の構造的な型。`SystemErrorFacts`
 * （`system-error.ts` の `z.infer<typeof systemErrorFactsSchema>`）と同じ形を
 * 手で複製したもの——理由は上の doc。
 */
export interface SystemErrorFactsLike {
  readonly code: string;
  readonly errno?: number;
  readonly syscall?: string;
}

/**
 * `code=... errno=... syscall=...` の形に整形する。B（器の資源で落ちた）の
 * 事実を出す全箇所（受信箱の `withSystemErrorNote` と `tools.ts` の
 * `manager_list` / `manager_report`、Web UI の診断欄）で共有し、値の言い換えが
 * 起きないようにする。
 */
export function formatSystemErrorFacts(systemError: SystemErrorFactsLike): string {
  const facts = [`code=${systemError.code}`];
  if (systemError.errno !== undefined) facts.push(`errno=${systemError.errno}`);
  if (systemError.syscall !== undefined) facts.push(`syscall=${systemError.syscall}`);
  return facts.join(' ');
}

/**
 * D（この軸では判定できなかった）の核となる一文を組む。**共通部分（本文が
 * 「器の資源による落ち方かどうかは、この欄では判定できなかった」ことと、
 * A（枠 429）・C（セッション切断）はこの欄の対象外であること）を1箇所へ
 * まとめ、「次にどこを見ればよいか」の指し先だけを `pointer` として呼び出し
 * 元に委ねる。**
 *
 * `pointer` は「本文と」の直後に続く形で渡す——クローン向けは
 * `' lastFailure を見ること'`、Web UI 向けは
 * `'、上の「直近のターンは報告ではなく失敗で終わっている」の注記を見ること'`
 * のように、読点や助詞ごと呼び出し元が決める（`system-error.ts` /
 * `manager-detail.tsx` の doc）。
 */
export function formatSystemErrorUnknownNote(pointer: string): string {
  return (
    '器の資源による落ち方かどうかは、この欄では判定できなかった。' +
    '枠に当たった場合・セッションが切れた場合もこの欄には出ない —— ' +
    `本文と${pointer}`
  );
}
