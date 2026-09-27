/**
 * `node .claude/skills/mutation-testing/mutate.mjs …` をテストの中で子として
 * 起こすときに渡す共通の環境（#1854。#1832 / PR #1840 の `configInputChildEnv`
 * と同じ作法 —— 親からの allowlist を絞る）。
 *
 * `scripts/mutate-*.test.ts` の複数ファイルが、同じ形（`spawnSync('node', […])`
 * / `execFileSync('node', […])` で `mutate.mjs` を起こす、または `mutate.mjs`
 * が読む定数を組み立てるためだけの短命な `node -e`）で `env` を渡さずに子を
 * 起こしていた——既定では spawn の親（テストを走らせているプロセス）の環境を
 * 丸ごと継承する。
 *
 * **子（`mutate.mjs` / `mutate-core.mjs` / `mutate-selftest.mjs`）が実際に必要
 * とするのは `PATH`（`node` 自身、および子がさらに起こす `git` を見つけるため）
 * だけである。** 根拠（コードを読んで判断した。環境を実行して調べてはいない）:
 *
 * - `mutate-core.mjs` / `mutate-selftest.mjs` が読む `process.env` の鍵は
 *   `CLAUDE_SESSION_ID` / `ALTEROID_SESSION_ID`（`?? null` で既定値つき。
 *   `judge` の記録にしか使わない）だけで、他には無い
 *   （`grep -Fn -- 'process.env' .claude/skills/mutation-testing/*.mjs`）
 * - 子がさらに起こす `git`（`execFileSync('git', …)`）・`pnpm`（`spawnSync('pnpm', …)`）
 *   はどれも `env` を指定していないので、この関数が組んだ環境をそのまま
 *   継承する。`git` は対象のツリーに `user.email` / `user.name` をローカル
 *   設定してから使う形（このファイルの利用元を見よ）なので `HOME` は要らない
 * - `scripts/mutate-*.test.ts` からこの関数を使う呼び出しは、`apply` / `restore`
 *   / `status` / `selftest`（印が既にあって即座に止まる回）のいずれも
 *   `spec.target: null` で `pnpm build` を経由しない
 *   （`applyMutation` / `restoreMutation` は `target` が無ければビルドを起こさない）
 */
export function mutateCliChildEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '' };
}
