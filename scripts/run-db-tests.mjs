#!/usr/bin/env node
/**
 * ルートの `test` 門の、DB を要求する段。
 *
 * **なぜこの段が要るか**
 *
 * `packages/postgres` と `examples/chat` の検査は本物の Postgres + pgvector を要求する
 * （擬似物へ黙ってフォールバックしない）。そのためスクリプト名は `test` ではなく
 * `test:db` に分けてあり、`pnpm -r --if-present run test` の対象から外れる——
 * **DB を持たない環境でもルートの門が通るように、意図してそうしてある**（PR #3）。
 *
 * その意図は保つ。壊れていたのは別のところで、**「DB テストが通った」と
 * 「DB テストを走らせていない」が、どちらも同じ緑だった**ことである。
 * 落ちたことすら手元では見えなかった。
 *
 * この段はその区別だけを回復する:
 *
 * | 状態 | 終了コード | 出力 |
 * |---|---|---|
 * | `DATABASE_URL` 未設定 | 0 | **「実行していない」と明示する**（緑だが、通ったのとは区別が付く） |
 * | `DATABASE_URL` 設定済み・DB テストが通った | 0 | 実行したことを明示する |
 * | `DATABASE_URL` 設定済み・DB テストが落ちた | **非 0** | pnpm の出力そのまま |
 *
 * `test:db` 自体の意味は変えていない。`DATABASE_URL` 無しで直接呼べば、これまで通り
 * 即エラーになる（`packages/postgres/src/__tests__/test-db.ts` の `requireDatabaseUrl`）。
 *
 * **なぜ `test:db` を1本ずつ `pnpm --filter <name> run test:db` で順に呼ぶか
 * （`pnpm --recursive --if-present run test:db` の一発呼びに戻さないこと）**
 *
 * 以前はここで `pnpm --recursive --if-present run test:db` を一度呼ぶだけだった。
 * それで `packages/postgres` → `examples/chat` の順に**直列に**走っていたのは事実だが、
 * それは「この段が排他を持っていたから」ではなく、**`examples/chat` が
 * `@mnemora/postgres` に `workspace:*` で依存しており、pnpm の既定（`--sort`、
 * 依存パッケージを先に実行する）がその2つをたまたま直列にしていただけ**である
 * （`--workspace-concurrency` の既定値は 4 で、依存関係の無いパッケージ同士は
 * 並行に走る。実測して確認した）。
 *
 * つまり、依存関係を持たない `test:db` パッケージが3つ目として増えた瞬間、
 * それは既存の2つと**並行に**走り出す。`resetTestDatabase()`
 * （`packages/postgres/src/__tests__/test-db.ts` /
 * `examples/chat/src/__tests__/test-db.ts`）は同じ `DATABASE_URL` の同じ7テーブル
 * （`memories` / `observations` / `memory_events` / `recalls` / `recall_usages` /
 * `outbox` / `tenant_settings`。埋め込み空間ごとのテーブルはパッケージごとに別だが、
 * この7つはテナント横断・スイート横断で完全に共有される）に対して
 * `TRUNCATE ... RESTART IDENTITY CASCADE` を撃つ。`tenant_id` によるテナント分離は
 * クエリの `WHERE` 句にしか無く、`TRUNCATE` には一切効かない。
 * 実測（一時的に `@mnemora/postgres` へ依存しない3つ目のパッケージを足し、
 * 同じ7テーブルへ200ms間隔で `TRUNCATE` を撃たせた）:
 *
 * - 並行に走らせた10試行すべてで `packages/postgres` の `test:db` が赤くなった
 *   （外部キー違反・「作ったはずの行が無い」というアサーション失敗・
 *   統計情報の激変によるクエリプラン変化など、壊れ方は試行ごとに違った——
 *   非決定的である）
 * - 同じ手順から並行だけを外した対照（5試行）はすべて緑だった
 *
 * **落ちたときの原因が「並行アクセス」であることは実測で切り分けたが、
 * どの行がどの瞬間に消えたかは再現するたび違う**——だから、この段は
 * 「依存グラフがたまたま守ってくれること」に頼らず、**この段自身のコードで
 * 一度に1パッケージしか `test:db` を起動しない**ことを約束する。
 * `--workspace-concurrency=1` を pnpm に渡すのではなく明示のループにしたのは、
 * (1) 排他が pnpm のフラグの意味ではなくこの門のコード自身に載ること、
 * (2) pnpm の `--bail`（既定で有効）は最初の失敗で**新しいパッケージの起動を
 * 止めるだけで、既に起動済みの兄弟プロセスを殺さない**ことを実測で確認しており
 * （失敗後もハンマー役のプロセスが生き残って DB を触り続けた）、
 * 一度に1本しか起動しなければこの穴がそもそも構造的に生じないこと、
 * (3) どのパッケージで落ちたかをこの段自身が名指しで言えること、の3点のため。
 *
 * **専用データベースは採らなかった**（ADR 0016）。CI の3ジョブ
 * （`postgres` / `example-chat` / `root-gate-db-stage`）はいずれも
 * `mnemora_ci` という同じ DB 名の独立した service container を持っており、
 * ジョブをまたいだ競合はそもそも起きない。危険の実体は
 * 「同一プロセス群が同一 DB を共有すること」であり、パッケージごとに DB を
 * 分ける変更は移行・CI 双方に広く手を入れる割に、この段だけの排他より
 * 過剰である。
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describeDatabaseServer, formatServerLines } from "./db-server-description.mjs";

const DB_SCRIPT = "test:db";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const BANNER = "─".repeat(72);

/**
 * `test:db` を持つワークスペースパッケージを、**依存関係を先に**という順序で列挙する。
 *
 * 名前を直書きせず pnpm に問い合わせるのは、**あとから `test:db` を足した
 * パッケージが黙って門から漏れるのを防ぐため**。この段の目的が
 * 「走っていないものが見えること」である以上、一覧そのものがずれてはいけない。
 *
 * 順序は、対象パッケージの `package.json` の `dependencies` / `devDependencies` に
 * 対象パッケージ同士の依存が無いか自前で見て、位相ソートする（`examples/chat` が
 * `@mnemora/postgres` に依存する、という既存の順序を保つため）。依存関係の無い
 * 組同士の順序は名前順に固定するだけで、どちらが先でも安全でなければならない
 * ——安全でないなら、それはこのスクリプトではなく各パッケージの `test:db` 側の
 * 独立性が壊れている。
 */
function findDbTestPackages() {
  const listed = spawnSync("pnpm", ["list", "--recursive", "--depth", "-1", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (listed.status !== 0) {
    throw new Error(
      `ワークスペースの一覧取得に失敗しました (pnpm list, exit ${listed.status}):\n${listed.stderr ?? ""}`,
    );
  }
  /** @type {{ name: string; path: string }[]} */
  const projects = JSON.parse(listed.stdout);
  const candidates = projects
    .filter((project) => project.path !== repoRoot.replace(/\/$/, ""))
    .map((project) => {
      try {
        const manifest = JSON.parse(readFileSync(`${project.path}/package.json`, "utf8"));
        return { name: project.name, manifest };
      } catch {
        return null;
      }
    })
    .filter((project) => project !== null && Boolean(project.manifest.scripts?.[DB_SCRIPT]));

  const names = new Set(candidates.map((c) => c.name));
  /** @type {Map<string, Set<string>>} 各パッケージ名 → 対象内で依存している名前の集合 */
  const dependsOn = new Map(candidates.map((c) => [c.name, new Set()]));
  for (const c of candidates) {
    const deps = { ...c.manifest.dependencies, ...c.manifest.devDependencies };
    for (const depName of Object.keys(deps ?? {})) {
      if (names.has(depName)) {
        dependsOn.get(c.name).add(depName);
      }
    }
  }

  const sorted = [];
  const visited = new Set();
  function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);
    for (const dep of dependsOn.get(name)) visit(dep);
    sorted.push(name);
  }
  for (const name of [...names].sort()) visit(name);
  return sorted;
}

const packages = findDbTestPackages();

if (packages.length === 0) {
  // `test:db` を持つパッケージが1つも無い。黙って通す（隠すものが無い）。
  process.exit(0);
}

const listing = packages.map((name) => `    - ${name} (${DB_SCRIPT})`).join("\n");

if (!process.env.DATABASE_URL) {
  console.log(
    [
      "",
      BANNER,
      "⚠ DB テストは実行していません（DATABASE_URL が未設定）",
      "",
      "  実行しなかったもの:",
      listing,
      "",
      "  この門が緑であることは、DB 側を見たことになりません。",
      "  DB 側も通すには、本物の Postgres + pgvector を指してから同じ門を実行すること:",
      "",
      "    DATABASE_URL=postgresql://... pnpm run test",
      "",
      BANNER,
      "",
    ].join("\n"),
  );
  process.exit(0);
}

// 接続先が何であるかを必ず1行出す。**歯は1本も弱めない**——出すだけである。
// 理由と、取れなかったときも黙らない理由は scripts/db-server-description.mjs の冒頭を見ること。
const serverLines = formatServerLines(
  describeDatabaseServer(process.env.DATABASE_URL, `${repoRoot}packages/postgres`),
);

console.log(
  [
    "",
    BANNER,
    "DATABASE_URL が設定されているため、DB テストを実行します",
    "",
    ...serverLines,
    "",
    "  対象:",
    listing,
    "",
    BANNER,
    "",
  ].join("\n"),
);

// 一発の `pnpm --recursive --if-present run test:db` には戻さない。1パッケージずつ
// `pnpm --filter <name> run test:db` を直列に呼び、常に「今どれが走っているか」を
// この段自身が把握した状態にする（理由は冒頭のコメントを参照）。
for (const name of packages) {
  const run = spawnSync("pnpm", ["--filter", name, "run", DB_SCRIPT], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (run.status !== 0) {
    console.log(["", BANNER, `✗ DB テストが落ちました（${name}）。`, BANNER, ""].join("\n"));
    process.exit(run.status === null ? 1 : run.status);
  }
}

console.log(["", BANNER, "✔ DB テストも実行し、通りました。", BANNER, ""].join("\n"));
