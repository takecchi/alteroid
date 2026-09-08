/**
 * `.github/workflows/publish.yml` が「予行（--dry-run）か本番か」を決める判定関数。
 *
 * **直す前の shell 条件式（逐語）**:
 * ```sh
 * DRY=""
 * if [ "${{ github.event_name }}" = "workflow_dispatch" ] && [ "${{ inputs.dry_run }}" = "true" ]; then
 *   DRY="--dry-run"
 *   echo "予行（--dry-run）です。registry へは何も上がりません。"
 * fi
 * ```
 *
 * **欠陥（fail-open）**: `dry_run` が文字列 `"true"` と一致しない*どんな値*でも
 * `DRY` は空になる ⟹ **本番の publish**。`workflow_dispatch` の `inputs` は
 * `type: boolean` と宣言していても、`${{ }}` 展開後は常に文字列（`"true"` / `"false"`）に
 * なる——が、それ以外の値（空文字・未定義・`"TRUE"`・`"1"` 等）が絶対に来ないことを
 * 保証する仕組みは無い（API 経由の `workflow_dispatch` 呼び出しや GitHub 側の将来の
 * 変更を含む）。この判定は「安全と明示されたときだけ予行」という向きだったため、
 * 想定外の入力は黙って「安全でない側」（本番）へ倒れていた。
 *
 * **直した向き**: 「危険と明示されたときだけ本番」へ反転する。想定外の値は
 * **黙って**安全側へ倒すのではなく、`warnings` にその旨を積んで呼び出し側
 * （`scripts/decide-publish-dry-run.mjs`）に `::warning::` を出させる。
 *
 * | event_name | dry_run（展開後の文字列） | 結果 | 警告 |
 * |---|---|---|---|
 * | `release` | 何であっても関係ない（無視する） | 本番 | 無し |
 * | `workflow_dispatch` | `"true"` | 予行 | 無し |
 * | `workflow_dispatch` | `"false"` | 本番 | 無し |
 * | `workflow_dispatch` | それ以外（空文字・未定義・`"TRUE"`・`"1"` 等） | **予行**（安全側） | **在り** |
 * | それ以外（`release` でも `workflow_dispatch` でもない） | — | 予行（安全側） | 在り |
 *
 * この関数は副作用（`console.log` / `process.env` の読み取り / `process.exit`）を持たない。
 * CLI としての入口は `scripts/decide-publish-dry-run.mjs` にある——`publish-pack-checks.mjs` /
 * `check-publish-pack.mjs` と同じ「判定関数と実行部を別ファイルに分ける」形に揃えた
 * （歯が副作用無しに判定表を直接検査できるようにするため）。
 *
 * @param {{ eventName: string, dryRunInput: string | undefined }} params
 * @returns {{ dryRun: boolean, warnings: string[] }}
 */
export function decideDryRun({ eventName, dryRunInput }) {
  if (eventName === "release") {
    // Release の publish を予行にしてはならない。dry_run の値は
    // workflow_dispatch 専用の入力欄であり、release イベントでは意味を持たない
    // ので無視する。
    return { dryRun: false, warnings: [] };
  }

  if (eventName === "workflow_dispatch") {
    if (dryRunInput === "true") {
      return { dryRun: true, warnings: [] };
    }
    if (dryRunInput === "false") {
      return { dryRun: false, warnings: [] };
    }
    return {
      dryRun: true,
      warnings: [
        `workflow_dispatch の dry_run が "true"/"false" のどちらでもない値でした` +
          `（${JSON.stringify(dryRunInput)}）。安全側の予行（--dry-run）として扱います。`,
      ],
    };
  }

  // publish.yml の `on:` は release と workflow_dispatch しか宣言していないので、
  // ここに来ることは無いはずである。それでも「万一」に備えて安全側へ倒す
  // ——来ないはずの契機で黙って本番へ倒れるのが一番まずい。
  return {
    dryRun: true,
    warnings: [
      `想定外の event_name でした（${JSON.stringify(eventName)}）。` +
        `安全側の予行（--dry-run）として扱います。`,
    ],
  };
}
