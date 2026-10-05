/**
 * `inbox_remove_many` の1回あたりの件数の既定と上限（issue #2860）。
 *
 * 値の正本。`tools.ts`（ツール本体）はここから再 export し、CLI は軽い口
 * （`@alteroid/core/cli-light`）経由でこの2つを読む。定数2つのために
 * `tools.ts`（SDK・zod を引く）を評価しないよう、実行時の依存を持たない
 * ファイルへ分けた。説明は `tools.ts` の再 export 側の doc を見よ。
 */
export const REMOVE_MANY_LIMIT_DEFAULT = 500;
export const REMOVE_MANY_LIMIT_MAX = 2_000;
