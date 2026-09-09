/**
 * DB 段が接続する先の Postgres が「何であるか」を、門の出力に出すための小さな道具。
 *
 * **なぜ要るか**
 *
 * この repo の歯には、**プランナがどちらの経路を選ぶか**を assert しているものが
 * いくつも在る（`Index Scan` が出ること / `Seq Scan` が出ないこと、等）。
 * **プランナの選択は Postgres のメジャー版・統計・データ分布に依存する。**
 * 実際、`packages/postgres/src/__tests__/count-over-window.test.ts` の分岐B
 * （ADR 0011）は **PostgreSQL 16.15 では赤くなる**——`count(*) OVER ()` を足しても
 * HNSW が捨てられず、`Index Scan using idx_memory_embeddings_hnsw_...` が出るためである
 * （実測。CI の PostgreSQL 17 では緑）。
 *
 * **⟹ 歯が赤くなったとき、「自分の変更が壊した」のか「版が違う」のかが、
 * 出力からは一切分からなかった。**切り分けるには `origin/main` を別 worktree に
 * 取り出して対照を取るしかなく、それは毎回発生する。
 *
 * **この道具は歯を1本も弱めない。skip も入れない。**出力に接続先を1行足すだけである
 * ——赤くなった人が、対照を取る前に「版が違う」に気づけるように。
 *
 * **⚠ 取れなかったときも必ず何かを出す。**「PostgreSQL 16.15 / pgvector 0.8.6」と
 * 「（版を取得できませんでした）」は**どちらも情報**であり、前者だけを出す形にすると
 * 取れなかったときに**何も無かったように見える**（ADR 0008「無いには種類がある」の、
 * この文脈への適用）。
 */
import { spawnSync } from "node:child_process";

/**
 * この repo の歯が前提にしている Postgres。**「検証済み」の意味は次のとおり:**
 *
 * - `17` — CI（`.github/workflows/ci.yml` の service container `pgvector/pgvector:pg17`）が
 *   毎回この版で全ての DB テストを緑にしている。
 * - `18` — [ADR 0011](../docs/decisions/0011-no-window-count-in-ann-stage.md) の実測環境
 *   （PostgreSQL 18.6 + pgvector 0.8.6）。`count-over-window.test.ts` の主張はここで測られた。
 *
 * **⚠ この一覧は「他の版では動かない」という主張ではない。**
 * 「**ここに無い版は、誰も確かめていない**」という主張である。
 */
export const VERIFIED_MAJOR_VERSIONS = Object.freeze([17, 18]);

/**
 * 接続先の Postgres と pgvector の版を問い合わせる。
 *
 * **`pg` はルートの依存に無い**ため、`packages/postgres`（`pg` を持つ唯一の
 * ワークスペース）を `cwd` にした子プロセスから問い合わせる。
 * **⟹ この道具のためにルートへ依存を1つも足していない。**
 *
 * @param {string} databaseUrl
 * @param {string} postgresPackageDir `packages/postgres` の絶対パス
 * @returns {{ ok: true, serverVersion: string, vectorVersion: string | null }
 *          | { ok: false, reason: string }}
 */
export function describeDatabaseServer(databaseUrl, postgresPackageDir) {
  const probe = [
    "import('pg').then(async (pg) => {",
    "  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });",
    "  await client.connect();",
    "  try {",
    "    const version = await client.query(\"select current_setting('server_version') as sv\");",
    "    const vector = await client.query(\"select extversion from pg_extension where extname = 'vector'\");",
    "    console.log(JSON.stringify({",
    "      serverVersion: version.rows[0].sv,",
    "      vectorVersion: vector.rows[0] ? vector.rows[0].extversion : null,",
    "    }));",
    "  } finally { await client.end(); }",
    "}).catch((err) => {",
    "  console.error(String(err && err.message ? err.message : err));",
    "  process.exit(1);",
    "});",
  ].join("\n");

  const result = spawnSync(process.execPath, ["-e", probe], {
    cwd: postgresPackageDir,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 15_000,
  });

  if (result.status !== 0) {
    const reason = (result.stderr || "").trim() || `exit ${result.status ?? "signal"}`;
    return { ok: false, reason: reason.split("\n")[0] };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return {
      ok: true,
      serverVersion: String(parsed.serverVersion),
      vectorVersion: parsed.vectorVersion === null ? null : String(parsed.vectorVersion),
    };
  } catch (error) {
    return { ok: false, reason: `応答を読めませんでした: ${String(error.message ?? error)}` };
  }
}

/**
 * `describeDatabaseServer` の結果から、`server_version` のメジャー番号を取り出す。
 * 取り出せなければ `null`（**推測しない**）。
 *
 * @param {string} serverVersion 例: `"16.15 (Debian 16.15-1.pgdg12+2)"`
 * @returns {number | null}
 */
export function majorVersionOf(serverVersion) {
  const matched = /^\s*(\d+)/.exec(serverVersion);
  return matched ? Number(matched[1]) : null;
}

/**
 * 門の出力に出す行を組み立てる。**純関数**（DB にも子プロセスにも触らない）。
 *
 * **3つの状態を、どれも黙って落とさない:**
 * 1. 取れた・**検証済みの版** — 版を出すだけ。
 * 2. 取れた・**検証されていない版** — 版に加えて**警告と、次の一手**を出す。
 * 3. **取れなかった** — 何が起きたかを出す（黙らない）。
 *
 * @param {{ ok: true, serverVersion: string, vectorVersion: string | null }
 *        | { ok: false, reason: string }} description
 * @returns {string[]}
 */
export function formatServerLines(description) {
  if (!description.ok) {
    return [
      `  接続先: （版を取得できませんでした: ${description.reason}）`,
      "  ⚠ 接続先が何であるかを、この門は言えていません。",
    ];
  }

  const vector =
    description.vectorVersion === null
      ? "pgvector（拡張が入っていません）"
      : `pgvector ${description.vectorVersion}`;
  const lines = [`  接続先: PostgreSQL ${description.serverVersion} / ${vector}`];

  const major = majorVersionOf(description.serverVersion);
  if (major === null) {
    lines.push("  ⚠ メジャー版を読み取れませんでした（版の検証済み一覧と突き合わせていません）。");
    return lines;
  }
  if (VERIFIED_MAJOR_VERSIONS.includes(major)) {
    return lines;
  }

  return lines.concat([
    `  ⚠ PostgreSQL ${major} は、この repo で検証されていない版です`,
    `    （検証済み: ${VERIFIED_MAJOR_VERSIONS.join(" / ")}。CI は 17、ADR 0011 の実測は 18.6）。`,
    "    この repo の歯には、プランナがどちらの経路を選ぶかを assert しているものが在ります。",
    "    ⟹ 赤くなったら、まず origin/main で対照を取ること（自分の変更のせいとは限りません）:",
    "",
    "      git worktree add ../main-control origin/main",
    "      cd ../main-control && pnpm install",
    "      DATABASE_URL=... pnpm --filter @mnemora/postgres exec vitest run <落ちたファイル>",
    "",
    "    ⟹ main でも同じ壊れ方をするなら、それは版であって、あなたの変更ではありません。",
  ]);
}
