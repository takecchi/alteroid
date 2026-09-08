/**
 * npm へ出す4パッケージと、**その publish 順序**を持つ唯一の定義（ADR 0060 決定1・ADR 0066）。
 *
 * **なぜ順序まで持つか**: ADR 0060 が「引き受けた負債」として
 * 「publish の順序は依存の向きで決まる（`core` → `testkit` / `openai` → `postgres`）。
 * **これを守らせる仕掛けはまだ無い**——順序を誤ると使う側が E404 を見る」と書いた。
 * この配列の順序がその仕掛けである。`scripts/pack-publish-targets.mjs` はこの順に tarball を並べ、
 * `.github/workflows/publish.yml` はその順に `npm publish` を打つ。
 *
 * 順序が依存の向きと整合していること（各パッケージの `@mnemora/*` 依存が自分より前に在ること）は
 * `scripts/__tests__/publish-targets.test.mjs` が機械的に検査する——**手で並べた順序を、
 * 手で確かめない。**
 *
 * **対象は固定リストである（動的に発見しない）。** publish 対象と非対象
 * （ルートの `mnemora` / `@mnemora/example-chat`）を分ける機械的な目印は無い
 * （`scripts/check-publish-pack.mjs` 冒頭の議論を見ること）。**新しい publish 対象が
 * 増えたら、ここに手で足す必要がある**——見落としを機械的には検知できない。
 */

/** @type {{ name: string; dir: string }[]} */
export const PUBLISH_TARGETS = [
  { name: "@mnemora/core", dir: "packages/core" },
  { name: "@mnemora/testkit", dir: "packages/testkit" },
  { name: "@mnemora/openai", dir: "packages/openai" },
  { name: "@mnemora/postgres", dir: "packages/postgres" },
];
