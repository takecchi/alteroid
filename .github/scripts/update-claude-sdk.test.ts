/**
 * `.github/scripts/update-claude-sdk.sh` と `.github/scripts/open-claude-sdk-pr.sh` を固定する。
 *
 * **本物の git を使う。偽物は pnpm と gh の2つだけ**（`reflect-release-prod.test.ts` と
 * 同じ方針）。git 自体が対象ではないので偽物にしない。
 *
 * **偽の pnpm / gh は「呼ばれた引数を記録するだけ」の記録係にしてある。**
 * pnpm 自身が持つ版比較・レジストリ照会のロジックは一切持たない。ファイルを
 * どう書き換えるか（catalog を書き換える／catalog と minimumReleaseAgeExclude を
 * 両方書き換える／lockfile だけ書き換える／何もしない）は `FAKE_PNPM_ACTION` で
 * テスト側が明示的に指定する。`pnpm view` に対して返す版は `FAKE_PNPM_VIEW_VERSION`
 * （未設定なら空＝レジストリを引けなかった扱い）。gh 側も同様に、`pr list` に対して
 * 返す番号は `FAKE_GH_PR_NUMBER`、`pr create` をわざと失敗させるかは
 * `FAKE_GH_FAIL_CREATE` でテストが指定するだけで、pnpm・gh の実際の判断ロジックは
 * 一切持たない。
 *
 * push が実際に起きたかどうかの観測は `reflect-release-prod.test.ts` と同じ手法
 * （ローカルの bare リポジトリの `hooks/pre-receive` に1行記録させる）を使う。
 *
 * git の呼び出しには毎回 `-c user.email` / `-c user.name` を渡す
 * （この環境にグローバル設定が無いため）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const UPDATE_SCRIPT = join(SCRIPTS_DIR, 'update-claude-sdk.sh');
const PR_SCRIPT = join(SCRIPTS_DIR, 'open-claude-sdk-pr.sh');

/** この環境にグローバル設定（`~/.gitconfig`）が無い前提で、テスト側の git 操作には
 * `-c user.email=...` / `-c user.name=...` を明示で渡している。
 * スクリプト自身（open-claude-sdk-pr.sh）は commit 前に自分で
 * `git config user.name/email` を設定するので、スクリプト実行そのものには不要。 */
const GIT_IDENTITY = ['-c', 'user.email=sdk-test@example.com', '-c', 'user.name=SDK Test'];

/** git の author/committer identity を決める環境変数。**`-c user.email=...` /
 * `-c user.name=...` より優先順位が高い**（git のドキュメント通り、
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env は `-c` 経由の `user.*` config を上書きする）。
 *
 * この器では `GIT_AUTHOR_EMAIL` などが既に設定されており（人間のコミッター用途）、
 * `execFileSync` へ `env` を明示しないと Node が親（このテストプロセス）の
 * `process.env` をそのまま子へ継承する。その結果、`-c user.email=...` で
 * 意図した identity が握りつぶされ、`pushExistingBranch` が「bot」「human」を
 * 指定したつもりの commit がどちらも別の1つの identity になってしまい、
 * force push 前の「bot 以外のコミットが無いか」チェックのテストが環境依存で
 * 壊れていた（`GIT_AUTHOR_EMAIL` 未設定の器だけで通っていた）。
 *
 * 対策はテスト側で明示的に隔離すること。器の環境変数そのものは変えない
 * （それは実行環境の持ち主が置いたものである）。ここで4つの env を落として、
 * どの器で走っても `-c user.email=...` が唯一の情報源になる形にする。 */
const GIT_IDENTITY_ENV_KEYS = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const;

/** `process.env` から git identity 系の env を落としたコピーを返す。
 * `-c user.email=...` / `-c user.name=...` による明示指定だけが effective に
 * なるようにするための隔離で、この4つ以外の env（PATH など）はそのまま通す。 */
function gitIsolatedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of GIT_IDENTITY_ENV_KEYS) delete env[key];
  return env;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    env: gitIsolatedEnv(),
  });
}

type Result = { exitCode: number; stdout: string; stderr: string };

/** 対象スクリプトを走らせ、終了状態と出力を返す。失敗を握り潰さない
 * （`allowFailure` を渡さない限り、非0終了は原因の stderr ごと投げる）。
 *
 * **`spawnSync` を使う（`execFileSync` ではなく）。** `execFileSync` は成功したとき
 * 戻り値が stdout の文字列そのものになり、stderr を読む手段が無い。exit 0 でも
 * stderr に意味のある出力があるケース（後述の「必須の環境変数が無いとき」の
 * バグ）を確かめるには、成功・失敗どちらでも stdout/stderr の両方を均等に
 * 取れる `spawnSync` が要る。 */
function runScript(
  script: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: { allowFailure?: boolean } = {},
): Result {
  const proc = spawnSync(script, [], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (proc.error) {
    throw proc.error;
  }
  const exitCode = proc.status ?? 1;
  const stdout = proc.stdout ?? '';
  const stderr = proc.stderr ?? '';
  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(`${script} が ${exitCode} で終わった\n${stderr}`);
  }
  return { exitCode, stdout, stderr };
}

/** `$GITHUB_OUTPUT` に書かれた `key=value` 行を Record にする。ファイルが無ければ
 * 空オブジェクト（＝1行も書かれなかったことを呼び出し側が区別できる）。 */
function parseGithubOutput(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

// ============================================================================
// update-claude-sdk.sh
// ============================================================================

describe('update-claude-sdk.sh', () => {
  const WORKSPACE_YAML_WITH_SDK = "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.237\n";
  const WORKSPACE_YAML_WITHOUT_SDK = 'catalog:\n  other-package: ^1.0.0\n';
  // `minimumReleaseAgeExclude` の監視テスト用。既存の SDK 行に加えて
  // その除外リストも持たせる（本物の pnpm-workspace.yaml の形を模す）。
  const WORKSPACE_YAML_WITH_EXCLUDE =
    "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.237\n" +
    "\nminimumReleaseAgeExclude:\n  - '@anthropic-ai/claude-agent-sdk*'\n";
  const LOCKFILE_INITIAL = "lockfileVersion: '9.0'\n";

  /**
   * 偽の pnpm。呼ばれた引数を `FAKE_PNPM_LOG` へ記録するだけ。ファイルの書き換えは
   * `FAKE_PNPM_ACTION`（`catalog` / `catalog-and-exclude` / `lockfile` /
   * 未指定＝何もしない）でテストが明示した1アクションだけを行う。pnpm 自体が持つ
   * 版比較・レジストリ照会のロジックは一切持たない。
   *
   * **`view` サブコマンドだけは別扱い。** `$PNPM view <pkg> version` が呼ばれたときは
   * `FAKE_PNPM_ACTION` を無視し、`FAKE_PNPM_VIEW_VERSION` が設定されていればその
   * 文字列を、未設定なら何も出力しない（＝レジストリを引けなかった場合を模す。
   * 実際のテストの大半はこれを設定しないので、この既定の「空」が前提のまま通る）。
   */
  function writeFakePnpm(path: string): void {
    writeFileSync(
      path,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "\${FAKE_PNPM_LOG:?FAKE_PNPM_LOG が要る}"
if [ "\${1:-}" = 'view' ]; then
  if [ -n "\${FAKE_PNPM_VIEW_VERSION:-}" ]; then
    printf '%s' "$FAKE_PNPM_VIEW_VERSION"
  fi
  exit 0
fi
case "\${FAKE_PNPM_ACTION:-none}" in
  catalog)
    node -e "
      const fs = require('fs');
      let s = fs.readFileSync('pnpm-workspace.yaml', 'utf8');
      s = s.replace(process.env.FAKE_PNPM_OLD_VERSION, process.env.FAKE_PNPM_NEW_VERSION);
      fs.writeFileSync('pnpm-workspace.yaml', s);
    "
    ;;
  catalog-and-exclude)
    node -e "
      const fs = require('fs');
      let s = fs.readFileSync('pnpm-workspace.yaml', 'utf8');
      s = s.replace(process.env.FAKE_PNPM_OLD_VERSION, process.env.FAKE_PNPM_NEW_VERSION);
      s = s.replace(/^minimumReleaseAgeExclude:\\n/m, \\"minimumReleaseAgeExclude:\\n  - 'some-immature-pkg'\\n\\");
      fs.writeFileSync('pnpm-workspace.yaml', s);
    "
    ;;
  lockfile)
    printf '\\n# bumped by fake pnpm\\n' >> pnpm-lock.yaml
    ;;
  none)
    ;;
esac
`,
    );
    chmodSync(path, 0o755);
  }

  function initRepo(root: string, workspaceYaml: string): string {
    const repoPath = join(root, 'repo');
    mkdirSync(repoPath);
    git(repoPath, ['init', '-q']);
    writeFileSync(join(repoPath, 'pnpm-workspace.yaml'), workspaceYaml);
    writeFileSync(join(repoPath, 'pnpm-lock.yaml'), LOCKFILE_INITIAL);
    writeFileSync(join(repoPath, 'other.txt'), 'original\n');
    git(repoPath, ['add', '.']);
    git(repoPath, ['commit', '-q', '-m', 'init']);
    return repoPath;
  }

  function setup(workspaceYaml = WORKSPACE_YAML_WITH_SDK) {
    const root = mkdtempSync(join(tmpdir(), 'update-claude-sdk-test.'));
    const repoPath = initRepo(root, workspaceYaml);
    const fakePnpm = join(root, 'fake-pnpm.sh');
    writeFakePnpm(fakePnpm);
    const pnpmLog = join(root, 'pnpm-calls.log');
    const outputFile = join(root, 'github-output.txt');
    return { root, repoPath, fakePnpm, pnpmLog, outputFile };
  }

  function run(
    s: ReturnType<typeof setup>,
    extraEnv: NodeJS.ProcessEnv = {},
    options: { allowFailure?: boolean } = {},
  ): Result {
    return runScript(
      UPDATE_SCRIPT,
      s.repoPath,
      {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        GITHUB_OUTPUT: s.outputFile,
        PNPM: s.fakePnpm,
        FAKE_PNPM_LOG: s.pnpmLog,
        ...extraEnv,
      },
      options,
    );
  }

  it('作業ツリーに追跡下の差分があるとき、pnpm を1度も呼ばずに非0で落ちる', () => {
    const s = setup();
    writeFileSync(join(s.repoPath, 'other.txt'), 'dirty\n');

    const result = run(s, {}, { allowFailure: true });

    expect(result.exitCode).not.toBe(0);
    // 呼ばれていればこのログファイルができるはずだが、そもそも存在しない
    expect(existsSync(s.pnpmLog)).toBe(false);
  });

  it('catalog 行が書き換わったとき changed=true と before/after が正しく出る', () => {
    const s = setup();

    const result = run(s, {
      FAKE_PNPM_ACTION: 'catalog',
      FAKE_PNPM_OLD_VERSION: '0.3.237',
      FAKE_PNPM_NEW_VERSION: '0.3.238',
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(s.pnpmLog)).toBe(true);
    const out = parseGithubOutput(s.outputFile);
    expect(out.changed).toBe('true');
    expect(out.before).toBe('0.3.237');
    expect(out.after).toBe('0.3.238');
  });

  it('何も変わらなかったとき changed=false で before と after が同じ', () => {
    const s = setup();

    const result = run(s);

    expect(result.exitCode).toBe(0);
    const out = parseGithubOutput(s.outputFile);
    expect(out.changed).toBe('false');
    expect(out.before).toBe('0.3.237');
    expect(out.after).toBe('0.3.237');
    expect(out.before).toBe(out.after);
  });

  it('catalog に対象行が無い pnpm-workspace.yaml では非0で落ちる（空文字を出力して成功に見せない）', () => {
    const s = setup(WORKSPACE_YAML_WITHOUT_SDK);

    const result = run(s, {}, { allowFailure: true });

    expect(result.exitCode).not.toBe(0);
    // read_version が最初の呼び出し（before側）で落ちるので、pnpm にはまだ到達しない
    expect(existsSync(s.pnpmLog)).toBe(false);
    // 出力ファイルへは1行も書かれない
    // （"changed=" を伴わない・空の before/after を出す中途半端な成功に見せない）
    expect(existsSync(s.outputFile)).toBe(false);
  });

  it('catalog が動かず lockfile だけ動いても changed=true になる（版文字列ではなく差分で判定している証拠）', () => {
    const s = setup();

    const result = run(s, { FAKE_PNPM_ACTION: 'lockfile' });

    expect(result.exitCode).toBe(0);
    const out = parseGithubOutput(s.outputFile);
    expect(out.before).toBe(out.after);
    expect(out.changed).toBe('true');
  });

  describe('minimumReleaseAgeExclude の監視', () => {
    // pnpm 11 の loose mode は、公開24時間以内の依存を引くと自分で
    // `minimumReleaseAgeExclude` へその名前を書き足す。SDK を上げる PR にこれが
    // 黙って混ざると、「除外リストは SDK のためのもの」という
    // pnpm-workspace.yaml 自身の方針が機械の手で崩れる。update 前後でこのリストを
    // 比べ、動いていたら changed を出力せず非0で止まることを確かめる。
    it('update の前後で minimumReleaseAgeExclude が変わったとき、非0で止まり changed が出力されない', () => {
      const s = setup(WORKSPACE_YAML_WITH_EXCLUDE);

      const result = run(
        s,
        {
          FAKE_PNPM_ACTION: 'catalog-and-exclude',
          FAKE_PNPM_OLD_VERSION: '0.3.237',
          FAKE_PNPM_NEW_VERSION: '0.3.238',
        },
        { allowFailure: true },
      );

      expect(result.exitCode).not.toBe(0);
      const out = parseGithubOutput(s.outputFile);
      // catalog/lockfile の diff を見るより前に止まっているので、
      // changed はもちろん before/after も出力されていない
      expect(out.changed).toBeUndefined();
      expect(result.stderr).toContain('minimumReleaseAgeExclude');
    });

    it('minimumReleaseAgeExclude が変わらなければ（既存の catalog 更新）通る', () => {
      const s = setup(WORKSPACE_YAML_WITH_EXCLUDE);

      const result = run(s, {
        FAKE_PNPM_ACTION: 'catalog',
        FAKE_PNPM_OLD_VERSION: '0.3.237',
        FAKE_PNPM_NEW_VERSION: '0.3.238',
      });

      expect(result.exitCode).toBe(0);
      const out = parseGithubOutput(s.outputFile);
      expect(out.changed).toBe('true');
    });
  });

  describe('レジストリ最新版との突き合わせ', () => {
    // 既存の5テストは `FAKE_PNPM_VIEW_VERSION` を設定していないので、
    // `pnpm view` は空を返す＝「レジストリを引けなかった」経路を通っている。
    // ここではそれ以外の3分岐（一致／不一致+changed=true／不一致+changed=false）
    // を明示的に確かめる。

    it('レジストリ最新と after が一致するとき、成功する', () => {
      const s = setup();

      const result = run(s, {
        FAKE_PNPM_ACTION: 'catalog',
        FAKE_PNPM_OLD_VERSION: '0.3.237',
        FAKE_PNPM_NEW_VERSION: '0.3.238',
        FAKE_PNPM_VIEW_VERSION: '0.3.238',
      });

      expect(result.exitCode).toBe(0);
      const out = parseGithubOutput(s.outputFile);
      expect(out.changed).toBe('true');
      expect(out.after).toBe('0.3.238');
    });

    it('レジストリ最新と after が食い違っても changed=true なら警告のみで成功する', () => {
      const s = setup();

      const result = run(s, {
        FAKE_PNPM_ACTION: 'catalog',
        FAKE_PNPM_OLD_VERSION: '0.3.237',
        FAKE_PNPM_NEW_VERSION: '0.3.238',
        FAKE_PNPM_VIEW_VERSION: '0.3.239',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('::warning::');
    });

    it('レジストリ最新と after が食い違い、かつ changed=false のとき非0で止まる（update が効いていない証拠）', () => {
      const s = setup();

      // FAKE_PNPM_ACTION を指定しない＝何も変えない（changed=false, after=before）
      const result = run(s, { FAKE_PNPM_VIEW_VERSION: '0.3.999' }, { allowFailure: true });

      expect(result.exitCode).not.toBe(0);
      const out = parseGithubOutput(s.outputFile);
      // changed=false 自体は既に書き出されている（この判定は view の後に来るため）
      expect(out.changed).toBe('false');
      expect(result.stderr).toContain('効いていない');
    });
  });
});

// ============================================================================
// open-claude-sdk-pr.sh
// ============================================================================

describe('open-claude-sdk-pr.sh', () => {
  const WORKSPACE_INITIAL = "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.237\n";
  const LOCKFILE_INITIAL = "lockfileVersion: '9.0'\n";
  const OPENAPI_INITIAL = '{"openapi":"3.1.0"}\n';
  const BRANCH = 'automation/claude-agent-sdk-test';
  const SDK_VERSION = '0.3.238';
  const TITLE = `chore: @anthropic-ai/claude-agent-sdk を ${SDK_VERSION} へ上げる`;
  // スクリプトの既定 bot（`GIT_AUTHOR_EMAIL` 未設定時の既定値）と同じ文字列。
  // force push 前の「bot 以外のコミットが無いか」チェックのテストで使う。
  const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
  const BOT_NAME = 'github-actions[bot]';

  /** `reflect-release-prod.test.ts` と同じ手法：push が来たら1行記録するだけの
   * bare origin。ネットワークには一切触らない。 */
  function initOrigin(root: string): string {
    const originPath = join(root, 'origin.git');
    git(root, ['init', '--bare', '-q', originPath]);
    const hooksDir = join(originPath, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const hook = join(hooksDir, 'pre-receive');
    writeFileSync(hook, '#!/usr/bin/env bash\necho pushed >> "${PUSH_LOG:-/dev/null}"\n');
    chmodSync(hook, 0o755);
    return originPath;
  }

  function initSeed(root: string): string {
    const seedPath = join(root, 'seed');
    mkdirSync(seedPath);
    git(seedPath, ['init', '-q']);
    git(seedPath, ['checkout', '-q', '-b', 'main']);
    writeFileSync(join(seedPath, 'pnpm-workspace.yaml'), WORKSPACE_INITIAL);
    writeFileSync(join(seedPath, 'pnpm-lock.yaml'), LOCKFILE_INITIAL);
    mkdirSync(join(seedPath, 'apps', 'daemon'), { recursive: true });
    writeFileSync(join(seedPath, 'apps', 'daemon', 'openapi.json'), OPENAPI_INITIAL);
    writeFileSync(join(seedPath, 'other.txt'), 'original\n');
    git(seedPath, ['add', '.']);
    git(seedPath, ['commit', '-q', '-m', 'init']);
    return seedPath;
  }

  function cloneRepo(originPath: string, root: string): string {
    const workdir = join(root, 'work');
    // **`--branch main` を明示する。** bare origin の HEAD は `init.defaultBranch`
    // 次第で `master` を指すことがあり、そちらは存在しないため
    // 「remote HEAD refers to nonexistent ref, unable to checkout」で作業ツリーが
    // 空のまま clone が終わる（`reflect-release-prod.test.ts` の `cloneShallow` と
    // 同じ理由でここも明示する）。
    git(root, ['clone', '-q', '--branch', 'main', originPath, workdir]);
    return workdir;
  }

  /** 偽の gh。呼ばれた引数を `FAKE_GH_LOG` へ、1呼び出し1ブロック（引数1行ずつ、
   * `---CALL---` 区切り）で記録するだけ。`pr list` に対してだけ、テストが指定した
   * 番号（`FAKE_GH_PR_NUMBER`。無ければ空文字）を返す。`FAKE_GH_FAIL_CREATE=true`
   * のときだけ `pr create` を exit 1 で失敗させる（`gh pr create` が
   * `GITHUB_TOKEN` の権限不足などで落ちるケースを模す）。どちらも記録は必ず先に
   * 行う。gh 自体の検索・作成ロジックは持たない。 */
  function writeFakeGh(path: string): void {
    writeFileSync(
      path,
      `#!/usr/bin/env bash
set -euo pipefail
{
  for arg in "$@"; do
    printf '%s\\n' "$arg"
  done
  printf -- '---CALL---\\n'
} >> "\${FAKE_GH_LOG:?FAKE_GH_LOG が要る}"

if [ "\${1:-}" = 'pr' ] && [ "\${2:-}" = 'list' ]; then
  printf '%s' "\${FAKE_GH_PR_NUMBER:-}"
  exit 0
fi

if [ "\${1:-}" = 'pr' ] && [ "\${2:-}" = 'create' ] && [ "\${FAKE_GH_FAIL_CREATE:-}" = 'true' ]; then
  exit 1
fi
`,
    );
    chmodSync(path, 0o755);
  }

  /** ログを呼び出し単位（引数配列の配列）へ分ける。 */
  function parseGhCalls(logPath: string): string[][] {
    if (!existsSync(logPath)) return [];
    const content = readFileSync(logPath, 'utf8');
    return content
      .split('---CALL---\n')
      .map((chunk) => chunk.split('\n').filter((l) => l.length > 0))
      .filter((call) => call.length > 0);
  }

  function remoteRef(originPath: string, ref: string): string {
    try {
      return execFileSync('git', ['--git-dir', originPath, 'rev-parse', ref], {
        encoding: 'utf8',
      }).trim();
    } catch {
      return '';
    }
  }

  /** push.log に記録された「pushed」行の数。フックが実際に何回起きたかを比較で
   * 見るための素朴なカウンタ（存在チェックだけだと、テスト側の準備で既に
   * push している場合と区別が付かない）。 */
  function pushCount(pushLog: string): number {
    if (!existsSync(pushLog)) return 0;
    return readFileSync(pushLog, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0).length;
  }

  /**
   * `seedPath`（main が既にある作業ツリー）から `BRANCH` を切って1コミット積み、
   * 指定した作者で origin へ push する。「PR ブランチに既にコミットが載っている」
   * 状態を作るためのテスト専用ヘルパーで、force push 前の「bot 以外の作者が
   * いないか」チェック（人間の作業を消さないための歯）を確かめるのに使う。
   * 共有の `git()`（固定の GIT_IDENTITY）は使わず、作者を都度指定する。
   */
  function pushExistingBranch(seedPath: string, authorEmail: string, authorName: string): void {
    git(seedPath, ['checkout', '-q', '-B', BRANCH]);
    writeFileSync(
      join(seedPath, 'pnpm-workspace.yaml'),
      "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.238\n",
    );
    const identity = ['-c', `user.email=${authorEmail}`, '-c', `user.name=${authorName}`];
    // **`env: gitIsolatedEnv()` が要る。** `GIT_AUTHOR_EMAIL` 等が既に環境にあると
    // 上の `-c user.email=...` より優先されてしまい、"bot" のつもりで積んだ
    // コミットが実際には環境変数の author になる（`gitIsolatedEnv` のコメント参照）。
    execFileSync('git', [...identity, 'add', '.'], { cwd: seedPath, env: gitIsolatedEnv() });
    execFileSync('git', [...identity, 'commit', '-q', '-m', 'existing branch commit'], {
      cwd: seedPath,
      env: gitIsolatedEnv(),
    });
    git(seedPath, ['push', '-q', 'origin', `${BRANCH}:refs/heads/${BRANCH}`]);
    git(seedPath, ['checkout', '-q', 'main']);
  }

  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'open-claude-sdk-pr-test.'));
    const originPath = initOrigin(root);
    const seedPath = initSeed(root);
    git(seedPath, ['remote', 'add', 'origin', originPath]);
    git(seedPath, ['push', '-q', 'origin', 'main']);
    const workdir = cloneRepo(originPath, root);
    const fakeGh = join(root, 'fake-gh.sh');
    writeFakeGh(fakeGh);
    const ghLog = join(root, 'gh-calls.log');
    const bodyFile = join(root, 'body.md');
    writeFileSync(bodyFile, '本文\n');
    const pushLog = join(root, 'push.log');
    // **HOME を隔離する。** 本物の HOME をそのまま渡すと、手元の `~/.gitconfig` の
    // 設定（例: commit の署名）を script-under-test の `git commit` が引き継いでしまい、
    // この環境に無い ssh-agent ソケットを探しに行って落ちる。`.gitconfig` の無い
    // 空のディレクトリを HOME にして、スクリプトが自分で設定する
    // `user.name` / `user.email`（リポジトリローカル）だけで完結させる。
    const fakeHome = join(root, 'home');
    mkdirSync(fakeHome);
    return { root, originPath, seedPath, workdir, fakeGh, ghLog, bodyFile, pushLog, fakeHome };
  }

  function run(
    s: ReturnType<typeof setup>,
    extraEnv: NodeJS.ProcessEnv = {},
    options: { allowFailure?: boolean } = {},
  ): Result {
    return runScript(
      PR_SCRIPT,
      s.workdir,
      {
        PATH: process.env.PATH ?? '',
        HOME: s.fakeHome,
        GH: s.fakeGh,
        FAKE_GH_LOG: s.ghLog,
        SDK_BRANCH: BRANCH,
        SDK_VERSION,
        SDK_PR_BODY: s.bodyFile,
        PUSH_LOG: s.pushLog,
        ...extraEnv,
      },
      options,
    );
  }

  it('3ファイル（catalog・lockfile・openapi.json）だけの差分ならコミットして push が実際に起きる', () => {
    const s = setup();
    writeFileSync(
      join(s.workdir, 'pnpm-workspace.yaml'),
      "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.238\n",
    );
    writeFileSync(join(s.workdir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n# bumped\n");
    writeFileSync(join(s.workdir, 'apps', 'daemon', 'openapi.json'), '{"openapi":"3.1.1"}\n');

    const result = run(s, { FAKE_GH_PR_NUMBER: '', SDK_VERIFY_OK: 'true' });

    expect(result.exitCode).toBe(0);
    // push が実際に起きたことを、pre-receive フックの記録で確かめる
    // （フックの実行そのものは前段の reflect-release-prod.test.ts が対照実験済み）
    expect(existsSync(s.pushLog)).toBe(true);
    expect(remoteRef(s.originPath, `refs/heads/${BRANCH}`)).not.toBe('');
  });

  it('3ファイル以外の追跡下ファイルにも差分があるとき、commit も push も PR もせず非0で落ちる', () => {
    const s = setup();
    // 想定内の1ファイルも直しておく（想定外だけが原因で止まることを確かめるため）
    writeFileSync(
      join(s.workdir, 'pnpm-workspace.yaml'),
      "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.238\n",
    );
    // 想定外: 3ファイルに含まれない追跡下ファイルを直す
    writeFileSync(join(s.workdir, 'other.txt'), 'unexpected change\n');

    const result = run(s, { FAKE_GH_PR_NUMBER: '', SDK_VERIFY_OK: 'true' }, { allowFailure: true });

    expect(result.exitCode).not.toBe(0);
    expect(existsSync(s.pushLog)).toBe(false);
    expect(existsSync(s.ghLog)).toBe(false);
    expect(remoteRef(s.originPath, `refs/heads/${BRANCH}`)).toBe('');
  });

  it('未追跡ファイルが残っていても止まらない', () => {
    const s = setup();
    writeFileSync(
      join(s.workdir, 'pnpm-workspace.yaml'),
      "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.238\n",
    );
    // packages/core/src/generated/x.ts のような、build が作る未追跡ファイル
    mkdirSync(join(s.workdir, 'packages', 'core', 'src', 'generated'), { recursive: true });
    writeFileSync(join(s.workdir, 'packages', 'core', 'src', 'generated', 'x.ts'), 'export {};\n');

    const result = run(s, { FAKE_GH_PR_NUMBER: '', SDK_VERIFY_OK: 'true' });

    expect(result.exitCode).toBe(0);
    expect(existsSync(s.pushLog)).toBe(true);
    // 未追跡ファイルは add されず、そのまま未追跡のまま残る
    const status = git(s.workdir, [
      'status',
      '--porcelain',
      join('packages', 'core', 'src', 'generated', 'x.ts'),
    ]).trim();
    expect(status.startsWith('??')).toBe(true);
  });

  it('開いている PR が無く SDK_VERIFY_OK=true のとき、gh pr create に --draft が付かない', () => {
    const s = setup();
    writeFileSync(
      join(s.workdir, 'pnpm-workspace.yaml'),
      "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.238\n",
    );

    const result = run(s, { FAKE_GH_PR_NUMBER: '', SDK_VERIFY_OK: 'true' });

    expect(result.exitCode).toBe(0);
    const calls = parseGhCalls(s.ghLog);
    expect(calls[0]).toEqual([
      'pr',
      'list',
      '--head',
      BRANCH,
      '--state',
      'open',
      '--json',
      'number',
      '--jq',
      '.[0].number // empty',
    ]);
    expect(calls[1]).toEqual([
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      BRANCH,
      '--title',
      TITLE,
      '--body-file',
      s.bodyFile,
    ]);
    expect(calls[1]).not.toContain('--draft');
  });

  it('開いている PR が無く SDK_VERIFY_OK が true 以外（空文字含む）のとき、gh pr create に --draft が付く', () => {
    const s = setup();
    writeFileSync(
      join(s.workdir, 'pnpm-workspace.yaml'),
      "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.238\n",
    );

    const result = run(s, { FAKE_GH_PR_NUMBER: '', SDK_VERIFY_OK: '' });

    expect(result.exitCode).toBe(0);
    const calls = parseGhCalls(s.ghLog);
    expect(calls[1]).toEqual([
      'pr',
      'create',
      '--draft',
      '--base',
      'main',
      '--head',
      BRANCH,
      '--title',
      TITLE,
      '--body-file',
      s.bodyFile,
    ]);
  });

  it('開いている PR があるとき gh pr edit が呼ばれ、SDK_VERIFY_OK=true なら gh pr ready が呼ばれる', () => {
    const s = setup();
    writeFileSync(
      join(s.workdir, 'pnpm-workspace.yaml'),
      "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.238\n",
    );

    const result = run(s, { FAKE_GH_PR_NUMBER: '42', SDK_VERIFY_OK: 'true' });

    expect(result.exitCode).toBe(0);
    const calls = parseGhCalls(s.ghLog);
    expect(calls[1]).toEqual(['pr', 'edit', '42', '--title', TITLE, '--body-file', s.bodyFile]);
    expect(calls[2]).toEqual(['pr', 'ready', '42']);
  });

  it('開いている PR があり SDK_VERIFY_OK が true 以外のとき gh pr ready --undo が呼ばれる', () => {
    const s = setup();
    writeFileSync(
      join(s.workdir, 'pnpm-workspace.yaml'),
      "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.238\n",
    );

    const result = run(s, { FAKE_GH_PR_NUMBER: '42', SDK_VERIFY_OK: '' });

    expect(result.exitCode).toBe(0);
    const calls = parseGhCalls(s.ghLog);
    expect(calls[1]).toEqual(['pr', 'edit', '42', '--title', TITLE, '--body-file', s.bodyFile]);
    expect(calls[2]).toEqual(['pr', 'ready', '--undo', '42']);
  });

  describe('SDK_VERSION_BEFORE によるタイトルの出し分け', () => {
    it('SDK_VERSION_BEFORE が SDK_VERSION と同じとき、タイトルが「lockfile を更新する」形になり、コミットメッセージにも同じ文言が載る', () => {
      const s = setup();
      writeFileSync(join(s.workdir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n# bumped\n");
      const lockfileOnlyTitle = `chore: @anthropic-ai/claude-agent-sdk 周辺の lockfile を更新する（版は ${SDK_VERSION} のまま）`;

      const result = run(s, {
        FAKE_GH_PR_NUMBER: '',
        SDK_VERIFY_OK: 'true',
        SDK_VERSION_BEFORE: SDK_VERSION,
      });

      expect(result.exitCode).toBe(0);
      const calls = parseGhCalls(s.ghLog);
      expect(calls[1]).toContain('--title');
      expect(calls[1][calls[1].indexOf('--title') + 1]).toBe(lockfileOnlyTitle);
      // commit message にも同じタイトルが載る
      const subject = git(s.workdir, ['log', '-1', '--format=%s']).trim();
      expect(subject).toBe(lockfileOnlyTitle);
    });

    it('SDK_VERSION_BEFORE が SDK_VERSION と異なるとき、従来どおり「へ上げる」タイトルになる', () => {
      const s = setup();
      writeFileSync(
        join(s.workdir, 'pnpm-workspace.yaml'),
        "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.238\n",
      );

      const result = run(s, {
        FAKE_GH_PR_NUMBER: '',
        SDK_VERIFY_OK: 'true',
        SDK_VERSION_BEFORE: '0.3.237',
      });

      expect(result.exitCode).toBe(0);
      const calls = parseGhCalls(s.ghLog);
      expect(calls[1][calls[1].indexOf('--title') + 1]).toBe(TITLE);
      const subject = git(s.workdir, ['log', '-1', '--format=%s']).trim();
      expect(subject).toBe(TITLE);
    });
  });

  describe('force push 前の「bot 以外のコミットが無いか」チェック', () => {
    it('リモートに当該ブランチがまだ無いとき（初回）、従来どおり push が起きる', () => {
      const s = setup();
      writeFileSync(
        join(s.workdir, 'pnpm-workspace.yaml'),
        "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.238\n",
      );
      const before = remoteRef(s.originPath, `refs/heads/${BRANCH}`);
      expect(before).toBe('');

      const result = run(s, { FAKE_GH_PR_NUMBER: '', SDK_VERIFY_OK: 'true' });

      expect(result.exitCode).toBe(0);
      expect(remoteRef(s.originPath, `refs/heads/${BRANCH}`)).not.toBe('');
    });

    it('リモートの当該ブランチが bot のコミットだけのとき、通って force push される', () => {
      const s = setup();
      pushExistingBranch(s.seedPath, BOT_EMAIL, BOT_NAME);
      const beforeSha = remoteRef(s.originPath, `refs/heads/${BRANCH}`);
      expect(beforeSha).not.toBe('');
      const beforeCount = pushCount(s.pushLog);

      writeFileSync(
        join(s.workdir, 'pnpm-workspace.yaml'),
        "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.239\n",
      );
      const result = run(s, { FAKE_GH_PR_NUMBER: '', SDK_VERIFY_OK: 'true' });

      expect(result.exitCode).toBe(0);
      // 直前の bot コミットを force で上書きした新しいコミットへ進んでいる
      expect(remoteRef(s.originPath, `refs/heads/${BRANCH}`)).not.toBe(beforeSha);
      expect(pushCount(s.pushLog)).toBeGreaterThan(beforeCount);
    });

    it('リモートの当該ブランチに人間のコミットがあるとき、push が起きず非0で止まる', () => {
      const s = setup();
      pushExistingBranch(s.seedPath, 'human@example.com', 'A Human');
      const beforeSha = remoteRef(s.originPath, `refs/heads/${BRANCH}`);
      expect(beforeSha).not.toBe('');
      const beforeCount = pushCount(s.pushLog);

      writeFileSync(
        join(s.workdir, 'pnpm-workspace.yaml'),
        "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.239\n",
      );
      const result = run(
        s,
        { FAKE_GH_PR_NUMBER: '', SDK_VERIFY_OK: 'true' },
        { allowFailure: true },
      );

      expect(result.exitCode).not.toBe(0);
      // リモートは一切書き換わっておらず、push 回数も増えていない
      // （増えていない、で見る —— セットアップ自体が1回 push しているので、
      // 存在チェックだけでは script 側の push と区別できない）
      expect(remoteRef(s.originPath, `refs/heads/${BRANCH}`)).toBe(beforeSha);
      expect(pushCount(s.pushLog)).toBe(beforeCount);
      expect(existsSync(s.ghLog)).toBe(false);
      expect(result.stderr).toContain('human@example.com');
    });
  });

  describe('gh pr create が失敗したとき', () => {
    it('案内メッセージを stderr に出して非0で終わる', () => {
      const s = setup();
      writeFileSync(
        join(s.workdir, 'pnpm-workspace.yaml'),
        "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.238\n",
      );

      const result = run(
        s,
        { FAKE_GH_PR_NUMBER: '', SDK_VERIFY_OK: 'true', FAKE_GH_FAIL_CREATE: 'true' },
        { allowFailure: true },
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Allow GitHub Actions to create and approve pull requests');
      // commit・push 自体は create の手前まで進んでいる
      expect(existsSync(s.pushLog)).toBe(true);
    });
  });

  describe('必須の環境変数が無いとき', () => {
    // **依頼は「非0で落ちる」だったが、現物はそうならない（バグ報告。直していない）。**
    //
    // `${SDK_BRANCH:?...}` のような bash の `:?` 展開は、変数が無ければその場で
    // シェルを異常終了させる。ところがこのスクリプトは `trap '...' EXIT` を張っており
    // （`reflect-release-prod.sh` と同じ「必ず1行出す」ための仕掛け）、実測すると
    // **この trap の中の `printf` が成功で終わるせいで、スクリプト全体の終了コードが
    // 0 へ上書きされる**（`git commit` 失敗など、`:?` を経由しない通常のエラーでは
    // この上書きは起きない。`:?` によるシェルの異常終了だけがこの経路を通る）。
    //
    // 手元での再現（`set -euo pipefail` + 同じ trap パターンの最小再現）:
    //   bash -c 'set -euo pipefail; trap "printf x" EXIT; : "${MISSING:?required}"'
    //   → 標準エラーに "MISSING: required" と出るが、echo $? は 0
    // 実機（このリポジトリの `open-claude-sdk-pr.sh`）でも同様に、
    // SDK_BRANCH / SDK_VERSION / SDK_PR_BODY のどれを欠かしても exit 0 だった
    // （2026-08-20T09:40Z 手元で確認。3つとも同じ結果）。
    //
    // したがってここでは「落ちるべき」という期待値ではなく、**実際に起きること**
    // （exit 0 だが、何も commit / push / gh 呼び出しをしていないこと）を固定する。
    // 「落ちること」を主張する意味のテストが書けない状態そのものが、この発見の証拠である。
    //
    // ---
    // **反転（2026-08-20 追記）。** スクリプト側が `${VAR:?...}` をやめ、
    // `require_env()`（`if [ -z "$2" ]; then ...; exit 1; fi` という明示検査）に
    // 置き換えたと連絡を受けた。この形は EXIT trap と衝突しない
    // （`update-claude-sdk.sh` の `minimumReleaseAgeExclude` チェックと同じ
    // `if [ -z … ]; then … exit 1; fi` の素朴な形で、`:?` の異常終了を経由しない
    // ため、上の「trap の printf が終了コードを 0 へ上書きする」経路そのものを
    // 通らない）。実測（下の変更後のテスト）で、3変数ともいまは非0終了する。
    //
    // 何を変えたか: 期待値を「exit 0（バグ）」から「非0で落ちる（依頼どおり）」へ
    // 反転した。何が必要になったか: スクリプト側の修正を受けて、テストが現物と
    // 食い違ったままでは「テストを弱めずに直す」の逆（実際より弱い保証を書いたまま
    // 放置する）になるため。保証が弱くなっていない根拠: 反転後も
    // 「commit・push・gh 呼び出しが一切起きていないこと」は変わらず確認しており、
    // かつ「非0で終わる」がその上に乗るので、保証は反転前より広がっている
    // （バグ時代は「副作用が無いこと」しか言えなかった）。
    it.each(['SDK_BRANCH', 'SDK_VERSION', 'SDK_PR_BODY'] as const)(
      '%s が無いとき、非0で終了し、commit・push・gh 呼び出しのいずれも起きない',
      (missingKey) => {
        const s = setup();
        writeFileSync(
          join(s.workdir, 'pnpm-workspace.yaml'),
          "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.238\n",
        );
        const env: NodeJS.ProcessEnv = {
          PATH: process.env.PATH ?? '',
          HOME: s.fakeHome,
          GH: s.fakeGh,
          FAKE_GH_LOG: s.ghLog,
          FAKE_GH_PR_NUMBER: '',
          SDK_VERIFY_OK: 'true',
          SDK_BRANCH: BRANCH,
          SDK_VERSION,
          SDK_PR_BODY: s.bodyFile,
          PUSH_LOG: s.pushLog,
        };
        delete env[missingKey];

        const result = runScript(PR_SCRIPT, s.workdir, env, { allowFailure: true });

        // 反転後の実際の挙動: 非0終了
        expect(result.exitCode).not.toBe(0);
        // 副作用は無い —— commit も push も gh 呼び出しも起きていない
        expect(existsSync(s.pushLog)).toBe(false);
        expect(existsSync(s.ghLog)).toBe(false);
        expect(result.stderr).toContain(`${missingKey}`);
      },
    );
  });
});
