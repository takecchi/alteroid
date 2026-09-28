import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

import { gitChildEnv } from './git-child-env.js';
import { mutateCliChildEnv } from './mutate-cli-child-env.js';
import {
  BACKUP_DIR,
  DEFAULT_ROOT,
  HarnessError,
  MARKER_PATH,
  readRootArg,
  ROOT,
  setRootOverride,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない変異試験ハーネス）を読む
} from '../.claude/skills/mutation-testing/mutate-core.mjs';

/**
 * ROOT の対象取り違え（マネージャーの依頼の本題）を塞ぐ歯。
 *
 * **欠陥**: `mutate-core.mjs` の `ROOT` はスクリプト自身の位置から決まり、
 * 上書きする引数も環境変数も無かった。別の repo の中に立ってこの clone の
 * `mutate.mjs status` を呼ぶと、エラーにならず「このツリーに変異が当たった
 * ままの状態は無い」と答える——その「このツリー」が呼び出し元ではなく
 * この clone であることが、出力からは分からなかった。
 *
 * **直し方**: `--root <path>` で上書きできるようにし（CLI 層の `mutate.mjs`
 * が argv を読んで `mutate-core.mjs` の `setRootOverride` を呼ぶ。環境変数
 * ではない — `mutate-core.mjs` 冒頭「ここにテスト用の抜け道（環境変数で
 * 分岐する類）を作らない」）、上書きの有無に関わらず実効の ROOT を毎回
 * 出力へ1行出す。
 *
 * **ここに置く理由（CI で走らせるため）**: （当時）`mutate-selftest.mjs` の
 * `SELFTEST_SCENARIOS` を CI から呼ぶ箇所は無かった（`.github/workflows/*.yml` /
 * `package.json` / `scripts/` を `grep -rFn` で全走査して確認済み——ゼロ件）。
 * `mutate-selftest.mjs` だけに歯を置くと CI では1本も走らなかった。
 * `vitest.config.ts` の `include` に `scripts` 配下の `*.test.ts` を拾うパターンが在り、
 * `scripts/mutate-max-workers.test.ts` / `scripts/mutate-core-strip-ansi.test.ts`
 * が先例（同じ「素の .mjs を plain import する」形）なので、それに揃える。
 *
 * **⚠️ 2026-09-16（#1096）に前提が1つ変わった —— `SELFTEST_SCENARIOS` は
 * CI から呼ばれるようになった**（`.github/workflows/ci.yml` の
 * `node .claude/skills/mutation-testing/mutate.mjs selftest --scenario all`）。
 * **それでもこの歯をここから動かさない。** 理由は2つ: (a) `scripts/*.test.ts` は
 * `pnpm test` で走るので、selftest の重い走行を待たずに赤が出る (b) selftest は
 * シナリオ（端から端まで）を回すもので、ここが測っているのは `--root` の
 * 上書きという**部品**である。**測っている粒度が違う。**
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MUTATE_CLI = path.join(REPO_ROOT, '.claude/skills/mutation-testing/mutate.mjs');

function runCli(args: string[]) {
  return spawnSync('node', [MUTATE_CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: mutateCliChildEnv(),
  });
}

/** git 管理下の使い捨てツリーを作る（apply/restore が gitHead() 等を呼ぶため）。 */
function makeTmpGitRepo(): string {
  const dir = makeTempDirSync('mutate-root-override-');
  execFileSync('git', ['init', '-q'], { cwd: dir, env: gitChildEnv() });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: dir,
    env: gitChildEnv(),
  });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, env: gitChildEnv() });
  fs.writeFileSync(path.join(dir, 'target.txt'), 'hello world\n');
  execFileSync('git', ['add', 'target.txt'], { cwd: dir, env: gitChildEnv() });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env: gitChildEnv() });
  return dir;
}

/**
 * #1705 のやり直し（PR #1712 の続き）。
 *
 * **PR #1712 は「開始時と終わりの `existsSync` の差分で見る」形に直したが、
 * 2回の `existsSync` の間の窓は残っていた。** REPO_ROOT（このチェックアウト）
 * は共有資源で、外部（同じ clone で `mutate.mjs apply`/`restore` を打つ人や
 * 別のプロセス）がその窓の中で印を置いたり消したりすれば、このテストは
 * 自分が何も壊していないのに落ちる——TOCTOU そのものは直っていなかった。
 *
 * **直し方**: 本物の REPO_ROOT を見るのをやめる。ハーネスの `.mjs` 3ファイル
 * （同ディレクトリの `import` はこの3つだけ——
 * `grep -Fn -- '^import' .claude/skills/mutation-testing/*.mjs` で確認済み。
 * `mutate-selftest.mjs` 内の `'./mutation-selftest-render.js'` は実体のある
 * import ではなく、selftest が生成するフィクスチャのソース文字列の中の
 * 相対パスである——`grep -Fn -- 'mutation-selftest-render' .claude/skills/mutation-testing/mutate-selftest.mjs`
 * で該当箇所が `body:` テンプレート文字列の中であることを確認できる）を、
 * このテスト専用の使い捨てツリーへ丸ごと写し、**そのコピー側の CLI** を
 * `--root <tmp>` 付きで起こす。
 *
 * このコピーの既定 ROOT（`mutate-core.mjs` の `DEFAULT_ROOT` — スクリプト
 * 自身の位置から3階層上）は、コピー先のディレクトリそのものになる。そして
 * `--root` を渡す限り、`applyRootArgAndAnnounce`（`mutate.mjs`）が `main()` の
 * 最初で `ROOT`/`MARKER_PATH`/`BACKUP_DIR`（module scope の可変 export）を
 * 上書きし、以降の全処理（`markerExists`/`writeMarkerFile`/`clearMarker` 等）は
 * この可変な `ROOT` だけを経由する——`DEFAULT_ROOT` を直接参照する経路は無い
 * （`grep -Fn -- 'DEFAULT_ROOT' .claude/skills/mutation-testing/mutate-core.mjs`
 * が返すのは定義行と `setRootOverride` 内の一時比較だけ）。`process.cwd()` にも
 * 依存しない（`grep -Fn -- 'process.cwd()' .claude/skills/mutation-testing/*.mjs`
 * はゼロ件）。⟹ コピー先自身の既定 ROOT は、このテストの呼び出し以外の
 * 何者にも触られない専用ツリーであり、そこに対する「印が増えていない・
 * 減っていない」という主張は外部干渉の入り込む窓を持たない。
 */
function makeIsolatedHarnessCopy(prefix: string) {
  const harnessRoot = makeTempDirSync(prefix);
  const srcDir = path.join(REPO_ROOT, '.claude/skills/mutation-testing');
  const destDir = path.join(harnessRoot, '.claude/skills/mutation-testing');
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of ['mutate.mjs', 'mutate-core.mjs', 'mutate-selftest.mjs']) {
    fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
  }
  return {
    harnessRoot,
    cli: path.join(destDir, 'mutate.mjs'),
    /** このコピー自身の既定 ROOT（DEFAULT_ROOT）の下に来る印のパス。 */
    markerPath: path.join(harnessRoot, 'MUTATION-IN-PROGRESS.json'),
  };
}

/** ハーネスのコピー（`makeIsolatedHarnessCopy` の戻り値）を実プロセスとして起こす。 */
function runIsolatedCli(harness: { cli: string; harnessRoot: string }, args: string[]) {
  return spawnSync('node', [harness.cli, ...args], {
    cwd: harness.harnessRoot,
    encoding: 'utf8',
    env: mutateCliChildEnv(),
  });
}

// ── 純粋な層: readRootArg（argv 解析。副作用なし） ──────────────────

describe('mutate-core: readRootArg（--root の argv 解析）', () => {
  it('--root が無ければ undefined を返す（呼び出し側は override しない）', () => {
    expect(readRootArg([])).toBeUndefined();
    expect(readRootArg(['--spec', 'x.json'])).toBeUndefined();
  });

  it('--root <path> を読む', () => {
    expect(readRootArg(['--root', '/tmp/probe'])).toBe('/tmp/probe');
  });

  it('他の引数と混ざっていても読める', () => {
    expect(readRootArg(['--spec', 'x.json', '--root', '/tmp/probe'])).toBe('/tmp/probe');
  });

  it('--root に値が無ければ HarnessError（読む前に落ちる。何も上書きしない）', () => {
    expect(() => readRootArg(['--root'])).toThrow(HarnessError);
  });
});

// ── 純粋な層: setRootOverride の fail-closed 検証 ────────────────────
//
// **ここで確かめるのは失敗系だけである。** 成功系（3つの値をまとめて
// 差し替える）は、この直後の describe が1本だけ持つ——`ROOT` は module
// scope の可変状態なので、同一ファイル内で先に成功させると以降のテストが
// その上書き後の値を見てしまう。失敗系は ROOT を書き換えないことそのものが
// 主張なので、この順で置いても汚染しない。

describe('mutate-core: setRootOverride は不正な --root を fail-closed で拒否する', () => {
  it('空文字を拒否し、ROOT/MARKER_PATH/BACKUP_DIR のどれも書き換えない', () => {
    expect(() => setRootOverride('')).toThrow(HarnessError);
    expect(ROOT).toBe(DEFAULT_ROOT);
    expect(MARKER_PATH).toBe(path.join(DEFAULT_ROOT, 'MUTATION-IN-PROGRESS.json'));
    expect(BACKUP_DIR).toBe(path.join(DEFAULT_ROOT, '.mutation-testing', 'backups'));
  });

  it('存在しないパスを拒否する', () => {
    expect(() => setRootOverride('/nonexistent/mutate-root-override-probe')).toThrow(/存在しない/);
    expect(ROOT).toBe(DEFAULT_ROOT);
  });

  it('ディレクトリでないパス（このテストファイル自身）を拒否する', () => {
    expect(() => setRootOverride(__filename)).toThrow(/ディレクトリでない/);
    expect(ROOT).toBe(DEFAULT_ROOT);
  });
});

// ── 純粋な層: setRootOverride の成功系（3つ全部が変わることを名指しする） ──
//
// **歯1の核心**: ROOT だけでなく MARKER_PATH / BACKUP_DIR も同じ新しい ROOT
// から作り直されていることを、3つとも個別に検査する。ROOT だけを見る歯では、
// 「ROOT は新しい値を見て、印や控えは古い ROOT のまま」という欠陥（この PR が
// 名指しで潰そうとしている形）を見逃す。

describe('mutate-core: setRootOverride は ROOT/MARKER_PATH/BACKUP_DIR の3つをまとめて差し替える', () => {
  it('成功すると3つとも新しい ROOT から作り直される', () => {
    const tmp = makeTempDirSync('mutate-root-override-pure-');
    const result = setRootOverride(tmp);
    const resolvedTmp = path.resolve(tmp);

    expect(ROOT).toBe(resolvedTmp);
    expect(MARKER_PATH).toBe(path.join(resolvedTmp, 'MUTATION-IN-PROGRESS.json'));
    expect(BACKUP_DIR).toBe(path.join(resolvedTmp, '.mutation-testing', 'backups'));

    // 戻り値でも同じ3つを確認できる（呼び出し側が個別に import し直さなくてよい）。
    expect(result).toEqual({
      root: resolvedTmp,
      markerPath: path.join(resolvedTmp, 'MUTATION-IN-PROGRESS.json'),
      backupDir: path.join(resolvedTmp, '.mutation-testing', 'backups'),
    });

    // 既定（DEFAULT_ROOT）は変えていないことも確認する——上書きは
    // 「既定を書き換える」のではなく「別の値を指すようにする」である。
    expect(DEFAULT_ROOT).toBe(REPO_ROOT);
    expect(ROOT).not.toBe(DEFAULT_ROOT);
  });
});

// ── CLI 層（mutate.mjs）を実プロセスとして起こす統合の歯 ─────────────
//
// **プロセスを分ける理由**: `mutate.mjs` はモジュール末尾で無条件に `main()`
// を呼ぶ（`mutate-core.mjs` の `readMaxWorkers` の doc と同じ理由）ので、
// plain import すると `process.argv` 次第でテストプロセスごと `exit()` する。
// `mutate-selftest.mjs` が実プロセスとして `mutate.mjs status` 等を起こす
// のと同じ形（execFileSync/spawnSync）に揃える。

describe('mutate.mjs CLI: --root（回帰・上書き・fail-closed・実効 ROOT の出力）', () => {
  it('歯2（回帰）: --root を渡さないと、既定の ROOT（このリポジトリ）のまま動く', () => {
    const result = runCli(['status']);
    expect(result.status === 0 || result.status === 2).toBe(true); // 印の有無どちらでも通る
    expect(result.stdout).toContain(`ROOT: ${REPO_ROOT}`);
    expect(result.stdout).toContain('既定。--root は渡されていない');
  });

  it('歯4: --root を渡さないときも実効 ROOT が出力に出る（既定であることが読める）', () => {
    const result = runCli(['status']);
    expect(result.stdout).toMatch(/^ROOT: /m);
  });

  it('歯4: --root を渡すと、実効 ROOT がその上書き先として出力に出る', () => {
    const tmp = makeTempDirSync('mutate-root-override-cli-');
    const result = runCli(['status', '--root', tmp]);
    const resolvedTmp = path.resolve(tmp);
    expect(result.stdout).toContain(`ROOT: ${resolvedTmp}`);
    expect(result.stdout).toContain('--root で上書き');
    expect(result.stdout).toContain(`既定は ${REPO_ROOT}`);
  });

  it('歯3: 存在しない --root は fail-closed になる（exit 非0）', () => {
    const result = runCli(['status', '--root', '/nonexistent/mutate-root-override-cli-probe']);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('存在しない');
  });

  it('歯3: ディレクトリでない --root は fail-closed になる（exit 非0）', () => {
    const result = runCli(['status', '--root', __filename]);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('ディレクトリでない');
  });

  it('歯1: --root <path> を渡すと apply/restore が MARKER_PATH / BACKUP_DIR も含めてそのツリーを使う', () => {
    // 元の注記（#1705 最初の直し・PR #1712）: 「実 ROOT に印が絶対に無い」
    // ではなく「このテストの --root tmp 呼び出しが実 ROOT の印の状態を
    // 変えていない」を見る形にした。実 ROOT で（--root を付けずに）
    // `mutate.mjs apply` を動かすのは、このハーネスの主要な使い方そのもの
    // （SKILL.md 本文の大半がその手順を説明している）なので、並行して
    // 誰か（人・別のエージェント）が実際にそれをしていれば印は最初から在る。
    // それを「無い」と決め打つと、このテストが触ってすらいない外部の状態で
    // 誤って赤くなる——#1705 で実測済み: 実 ROOT へ `mutate.mjs apply`
    // （--root なし）で印を置いた状態でこのファイルだけを走らせると、直後の
    // `toBe(false)` の行だけが `AssertionError: expected true to be false`
    // で落ちた（他の全アサーションは通っていた）。
    //
    // **#1705 のやり直し（この続き）**: 上の「開始時と終わりの差分」でも
    // TOCTOU の窓（2回の `existsSync` の間）は残っていた。実 ROOT は共有
    // 資源なので、その窓の中で外部が印を置いたり消したりすれば、やはり
    // このテストは自分が何も壊していないのに落ちうる。この歯が測りたいのは
    // 「対象の取り違え」（tmp のはずが別の ROOT に漏れる）であって「実 ROOT が
    // 絶対的に空か」でも「実 ROOT が開始時から変わっていないか」でもないので、
    // 実 ROOT そのものを見るのをやめ、このテスト専用の使い捨てツリー
    // （`makeIsolatedHarnessCopy` の戻り値）へハーネスを丸ごと写し、その
    // コピー自身の既定 ROOT（他の誰にも触られない）が変わっていないかを見る
    // （理由の全文は `makeIsolatedHarnessCopy` の doc）。
    const harness = makeIsolatedHarnessCopy('mutate-root-override-harness-');
    const tmp = makeTmpGitRepo();
    const specPath = path.join(tmp, 'spec.json');
    fs.writeFileSync(
      specPath,
      JSON.stringify({
        id: 'root-override-probe',
        file: 'target.txt',
        from: 'hello',
        to: 'HELLO',
        expect: 1,
        target: null,
        // #993: validateSpec は mustFail（狙いの歯の宣言）を必須にした。
        // この歯は apply/restore が --root のツリーを正しく使うかだけを
        // 測っていて、judge（検出/身代わりの判定）はここでは呼ばない
        // ——この tmp リポジトリに実テストは無い。だから中身は判定に使われず、
        // validateSpec を通すためのプレースホルダでよい。
        mustFail: ['root-override-probe はこの歯で judge を呼ばない（apply/restore のみを測る）'],
      }),
    );

    const applyResult = runIsolatedCli(harness, ['apply', '--spec', specPath, '--root', tmp]);
    expect(applyResult.status).toBe(0);

    // ROOT: target.txt がこのツリーの中で実際に書き換わっている。
    expect(fs.readFileSync(path.join(tmp, 'target.txt'), 'utf8')).toBe('HELLO world\n');
    // MARKER_PATH: 印がこのツリーの直下に置かれている。
    expect(fs.existsSync(path.join(tmp, 'MUTATION-IN-PROGRESS.json'))).toBe(true);
    // BACKUP_DIR: 控えがこのツリーの .mutation-testing/backups の下に置かれている。
    expect(
      fs.existsSync(path.join(tmp, '.mutation-testing', 'backups', 'root-override-probe.bak')),
    ).toBe(true);

    // このハーネスのコピー自身の既定 ROOT には何も漏れていないこと
    // （対象の取り違えが起きていないこと）。harness.harnessRoot はこの
    // テストの呼び出し以外に触られないので、外部干渉の窓を持たずに
    // 「増えていない」を言い切れる。
    expect(fs.existsSync(harness.markerPath)).toBe(false);

    const restoreResult = runIsolatedCli(harness, ['restore', '--root', tmp]);
    expect(restoreResult.status).toBe(0);
    expect(fs.readFileSync(path.join(tmp, 'target.txt'), 'utf8')).toBe('hello world\n');
    expect(fs.existsSync(path.join(tmp, 'MUTATION-IN-PROGRESS.json'))).toBe(false);

    // restore の後も、このコピー自身の既定 ROOT はやはり触られていない。
    expect(fs.existsSync(harness.markerPath)).toBe(false);
  });

  it('歯1b（#1705 追加、消される向き）: このコピーの既定 ROOT にあらかじめ印の形のファイルが在っても、--root <tmp> の apply/restore はそれへ1バイトも触れない', () => {
    // **前の形（開始時に印が無い状態から始める）は「消される向き」を測れて
    // いなかった** —— 何も無い場所から「無い」ままでは、誰かが印を消して
    // しまう欠陥があっても観測にすら現れない。ここでは既定 ROOT に印の形の
    // ファイルをあらかじめ置き、apply/restore の前後でそれが1バイトも
    // 変わらないことを見る。
    //
    // **拒否されないことの確認（コードを読んで判断）**: `applyMutation` /
    // `restoreMutation` が呼ぶ `markerExists()`（`mutate-core.mjs`）は
    // `fs.existsSync(MARKER_PATH)` で、`MARKER_PATH` は `--root` の上書き後は
    // 常に上書き先（tmp）を指す可変 export である（`setRootOverride` が
    // `ROOT`/`MARKER_PATH`/`BACKUP_DIR` を同時に書き換える）。`--root` の
    // 解釈は `main()` の最初（`applyRootArgAndAnnounce`）で終わっているので、
    // 以降のどの処理も `DEFAULT_ROOT`（＝このハーネスのコピー自身の既定 ROOT）
    // 側の印を読み書きしない。⟹ ここに印を置いても apply/restore は起動を
    // 拒否しない（`assertNoBlockingMarker` も `baseline`/`run` からしか
    // 呼ばれず、`apply`/`restore` の経路には無い——`grep -Fn -- 'assertNoBlockingMarker' .claude/skills/mutation-testing/mutate.mjs`）。
    const harness = makeIsolatedHarnessCopy('mutate-root-override-harness-erase-');
    const preplacedMarkerContent = '{"probe":"mutate-root-override-preexisting-marker"}\n';
    fs.writeFileSync(harness.markerPath, preplacedMarkerContent);

    const tmp = makeTmpGitRepo();
    const specPath = path.join(tmp, 'spec.json');
    fs.writeFileSync(
      specPath,
      JSON.stringify({
        id: 'root-override-erase-probe',
        file: 'target.txt',
        from: 'hello',
        to: 'HELLO',
        expect: 1,
        target: null,
        mustFail: [
          'root-override-erase-probe はこの歯で judge を呼ばない（apply/restore のみを測る）',
        ],
      }),
    );

    const applyResult = runIsolatedCli(harness, ['apply', '--spec', specPath, '--root', tmp]);
    expect(applyResult.status).toBe(0);
    expect(fs.readFileSync(harness.markerPath, 'utf8')).toBe(preplacedMarkerContent);

    const restoreResult = runIsolatedCli(harness, ['restore', '--root', tmp]);
    expect(restoreResult.status).toBe(0);
    expect(fs.readFileSync(harness.markerPath, 'utf8')).toBe(preplacedMarkerContent);
  });
});
