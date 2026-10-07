// `vitest list --shard` を使わない: vitest 5.0.1 では `--shard` を黙って無視して範囲の全ファイルを返すため。割り当ての規則は書き写さず、`vitest run --shard` に `-t <どのテストにも当たらない名前>` を付けて JSON で読む。
// どのテスト名にも当たらない `-t` の値: テストの名前にこの文字列を使わない。
export const NO_MATCH_TEST_NAME = '__alteroid_test_shard_files_matches_no_test__';

export const USAGE =
  '使い方: pnpm test:shard-files <scope> <i>/<n>\n' +
  '  例: pnpm test:shard-files packages/storage-pg/src 3/3\n' +
  '  <scope> は repo の根からの相対パス（vitest の位置引数と同じ部分一致）。';

// `<i>/<n>` は 1 ≤ i ≤ n の整数に限り、vitest に渡す前に断る: vitest は範囲外の index を黙って空の shard にすることがあるため。
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
