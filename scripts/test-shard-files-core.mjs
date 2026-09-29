/**
 * `pnpm test:shard-files` の中核（純関数）。**vitest の `--shard=<i>/<n>` がどのテスト
 * ファイルを割り当てるかを、テストを走らせずに一覧する**ための道具。
 *
 * ## なぜ要るか
 *
 * `vitest list --shard=<i>/<n> --filesOnly` は、vitest 5.0.1 では `--shard` を**黙って
 * 無視して**範囲の全ファイルを返す（実測 2026-09-29T06:5xZ、`packages/storage-pg/src`
 * で `--shard=1/3` も `--shard=3/3` も 43 件）。`--help` には `--shard` が載っている
 * ので、打った側からは効いたように見える。作業者が「3/3 に何が入るか」を確かめようと
 * して取り違え、重いファイルを特定するのに1ファイルずつ回し直した（#2063 の実測）。
 *
 * ## どう一覧するか
 *
 * `vitest run <scope> --shard=<i>/<n> -t <どのテストにも当たらない名前>` を
 * `--reporter=json` で起こす。**テストは1本も走らず（全部 skip）**、JSON の
 * `testResults[].name` に、その shard が割り当てたファイルが並ぶ。割り当ての規則を
 * 書き写さない（vitest 自身の `--shard` をそのまま使う）ので、vitest の版が上がって
 * 規則が変わっても、ここは古くならない。
 *
 * ⚠️ ファイルの import（モジュールの最上位）は走る。重いのは各テストの本文と
 * `beforeEach` なので、`packages/storage-pg/src` の 3/3 でも数秒で返る（実測 約8秒）。
 */

/** どのテスト名にも当たらない `-t` の値。テストの名前にこの文字列を使わないこと。 */
export const NO_MATCH_TEST_NAME = '__alteroid_test_shard_files_matches_no_test__';

export const USAGE =
  '使い方: pnpm test:shard-files <scope> <i>/<n>\n' +
  '  例: pnpm test:shard-files packages/storage-pg/src 3/3\n' +
  '  <scope> は repo の根からの相対パス（vitest の位置引数と同じ部分一致）。';

/**
 * 引数を読む。`{ ok: true, scope, shard }` か `{ ok: false, message }`。
 * `<i>/<n>` は 1 ≤ i ≤ n の整数に限る（vitest に渡す前に断る——vitest は範囲外の
 * index を黙って空の shard にすることがある）。
 */
export function parseShardFilesArgs(argv) {
  const args = argv.filter((a) => a !== '--');
  if (args.length !== 2) return { ok: false, message: USAGE };
  const [scope, shard] = args;
  const m = /^(\d+)\/(\d+)$/.exec(shard);
  if (scope.startsWith('-') || m === null) return { ok: false, message: USAGE };
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (index < 1 || count < 1 || index > count) {
    return {
      ok: false,
      message: `<i>/<n> は 1 ≤ i ≤ n の整数で渡すこと（実際: ${shard}）。\n${USAGE}`,
    };
  }
  return { ok: true, scope, shard: `${index}/${count}` };
}

/** vitest に渡す引数（`run` の後ろ）。 */
export function buildShardFilesVitestArgs({ scope, shard, outputFile }) {
  return [
    'run',
    scope,
    `--shard=${shard}`,
    '-t',
    NO_MATCH_TEST_NAME,
    '--reporter=json',
    `--outputFile=${outputFile}`,
  ];
}

/**
 * vitest の JSON レポートから、repo の根からの相対パス（`/` 区切り）を並べ替えて返す。
 * `testResults` が無い・配列でないなら `null`（判定できない。0件と取り違えない）。
 */
export function filesFromJsonReport(report, root) {
  if (report === null || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    return null;
  }
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return report.testResults
    .map((r) => (typeof r?.name === 'string' ? r.name : null))
    .filter((name) => name !== null)
    .map((name) => (name.startsWith(prefix) ? name.slice(prefix.length) : name))
    .sort();
}
