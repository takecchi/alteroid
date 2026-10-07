// 偽物は pnpm と gh だけにし、git は本物を使う: 偽の pnpm / gh は呼ばれた引数を記録するだけで、版比較・レジストリ照会などの実際の判断ロジックは持たない。
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../vitest.tmpdir.js';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const UPDATE_SCRIPT = join(SCRIPTS_DIR, 'update-claude-sdk.sh');
const PR_SCRIPT = join(SCRIPTS_DIR, 'open-claude-sdk-pr.sh');

// git 操作に `-c user.*` を明示で渡す: この環境にグローバル設定（`~/.gitconfig`）が無いため。
const GIT_IDENTITY = ['-c', 'user.email=sdk-test@example.com', '-c', 'user.name=SDK Test'];

// `GIT_AUTHOR_*` / `GIT_COMMITTER_*` の env を子へ渡さない: `-c user.*` より優先され、器で設定済みだと意図した identity が握りつぶされて、「bot 以外のコミットが無いか」のテストが環境依存で壊れるため。器の環境変数そのものは変えない。
const GIT_IDENTITY_ENV_KEYS = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const;

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

// `spawnSync` を使う（`execFileSync` ではなく）: `execFileSync` は成功時に stderr を読む手段が無く、exit 0 でも stderr に意味のある出力があるケースを確かめられないため。
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

describe('update-claude-sdk.sh', () => {
  const WORKSPACE_YAML_WITH_SDK = "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.237\n";
  const WORKSPACE_YAML_WITHOUT_SDK = 'catalog:\n  other-package: ^1.0.0\n';
  const WORKSPACE_YAML_WITH_EXCLUDE =
    "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.237\n" +
    "\nminimumReleaseAgeExclude:\n  - '@anthropic-ai/claude-agent-sdk*'\n";
  const LOCKFILE_INITIAL = "lockfileVersion: '9.0'\n";

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
    const root = makeTempDirSync('update-claude-sdk-test.');
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
    expect(existsSync(s.pnpmLog)).toBe(false);
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

      const result = run(s, { FAKE_PNPM_VIEW_VERSION: '0.3.999' }, { allowFailure: true });

      expect(result.exitCode).not.toBe(0);
      const out = parseGithubOutput(s.outputFile);
      expect(out.changed).toBe('false');
      expect(result.stderr).toContain('効いていない');
    });
  });
});

describe('open-claude-sdk-pr.sh', () => {
  const WORKSPACE_INITIAL = "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.237\n";
  const LOCKFILE_INITIAL = "lockfileVersion: '9.0'\n";
  const OPENAPI_INITIAL = '{"openapi":"3.1.0"}\n';
  const BRANCH = 'automation/claude-agent-sdk-test';
  const SDK_VERSION = '0.3.238';
  const TITLE = `chore: @anthropic-ai/claude-agent-sdk を ${SDK_VERSION} へ上げる`;
  const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
  const BOT_NAME = 'github-actions[bot]';
  const WARNING_MARK = '> [!WARNING]';

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
    // `--branch main` を明示する: bare origin の HEAD は `init.defaultBranch` 次第で存在しない `master` を指し、作業ツリーが空のまま clone が終わるため。
    git(root, ['clone', '-q', '--branch', 'main', originPath, workdir]);
    return workdir;
  }

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

  function parseGhCalls(logPath: string): string[][] {
    if (!existsSync(logPath)) return [];
    const content = readFileSync(logPath, 'utf8');
    return content
      .split('---CALL---\n')
      .map((chunk) => chunk.split('\n').filter((l) => l.length > 0))
      .filter((call) => call.length > 0);
  }

  function at<T>(arr: readonly T[], index: number): T {
    const value = arr[index];
    if (value === undefined) {
      throw new Error(`index ${index} が範囲外（長さ: ${arr.length}）`);
    }
    return value;
  }

  function titleArgOf(call: readonly string[]): string {
    return at(call, call.indexOf('--title') + 1);
  }

  function remoteRef(originPath: string, ref: string): string {
    try {
      return execFileSync('git', ['--git-dir', originPath, 'rev-parse', ref], {
        encoding: 'utf8',
        // `env: gitIsolatedEnv()` を渡す: 無いと親の `process.env` を丸ごと継承し、ファイル内で env の作り方が2通りになるため。
        env: gitIsolatedEnv(),
      }).trim();
    } catch {
      return '';
    }
  }

  function pushCount(pushLog: string): number {
    if (!existsSync(pushLog)) return 0;
    return readFileSync(pushLog, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0).length;
  }

  function pushExistingBranch(seedPath: string, authorEmail: string, authorName: string): void {
    git(seedPath, ['checkout', '-q', '-B', BRANCH]);
    writeFileSync(
      join(seedPath, 'pnpm-workspace.yaml'),
      "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.238\n",
    );
    const identity = ['-c', `user.email=${authorEmail}`, '-c', `user.name=${authorName}`];
    // `env: gitIsolatedEnv()` を渡す: `GIT_AUTHOR_EMAIL` 等が環境にあると上の `-c user.email=...` より優先され、積んだコミットの author が環境変数のものになるため。
    execFileSync('git', [...identity, 'add', '.'], { cwd: seedPath, env: gitIsolatedEnv() });
    execFileSync('git', [...identity, 'commit', '-q', '-m', 'existing branch commit'], {
      cwd: seedPath,
      env: gitIsolatedEnv(),
    });
    git(seedPath, ['push', '-q', 'origin', `${BRANCH}:refs/heads/${BRANCH}`]);
    git(seedPath, ['checkout', '-q', 'main']);
  }

  function setup() {
    const root = makeTempDirSync('open-claude-sdk-pr-test.');
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
    // HOME を隔離する: 本物の HOME だと手元の `~/.gitconfig`（commit の署名など）を `git commit` が引き継ぎ、この環境に無い ssh-agent ソケットを探しに行って落ちるため。
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
        SDK_CI_TRIGGERED: 'true',
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
    expect(existsSync(s.pushLog)).toBe(true);
    expect(remoteRef(s.originPath, `refs/heads/${BRANCH}`)).not.toBe('');
  });

  it('3ファイル以外の追跡下ファイルにも差分があるとき、commit も push も PR もせず非0で落ちる', () => {
    const s = setup();
    writeFileSync(
      join(s.workdir, 'pnpm-workspace.yaml'),
      "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.238\n",
    );
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
    mkdirSync(join(s.workdir, 'packages', 'core', 'src', 'generated'), { recursive: true });
    writeFileSync(join(s.workdir, 'packages', 'core', 'src', 'generated', 'x.ts'), 'export {};\n');

    const result = run(s, { FAKE_GH_PR_NUMBER: '', SDK_VERIFY_OK: 'true' });

    expect(result.exitCode).toBe(0);
    expect(existsSync(s.pushLog)).toBe(true);
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
      expect(titleArgOf(at(calls, 1))).toBe(lockfileOnlyTitle);
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
      expect(titleArgOf(at(calls, 1))).toBe(TITLE);
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
      expect(remoteRef(s.originPath, `refs/heads/${BRANCH}`)).toBe(beforeSha);
      expect(pushCount(s.pushLog)).toBe(beforeCount);
      expect(existsSync(s.ghLog)).toBe(true);
      const calls = parseGhCalls(s.ghLog);
      expect(calls.some((c) => c[0] === 'pr' && c[1] === 'create')).toBe(false);
      expect(calls.some((c) => c[0] === 'pr' && c[1] === 'edit')).toBe(false);
      expect(calls.some((c) => c[0] === 'pr' && c[1] === 'ready')).toBe(false);
      expect(result.stderr).toContain('human@example.com');
    });
  });

  describe('リモートに人間のコミットがあって止まったとき、開いている PR へ通知する（#991）', () => {
    it('開いている PR が在るとき、その PR 番号へ gh pr comment が呼ばれ、本文に作者と #991 が含まれる', () => {
      const s = setup();
      pushExistingBranch(s.seedPath, 'human@example.com', 'A Human');

      writeFileSync(
        join(s.workdir, 'pnpm-workspace.yaml'),
        "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.239\n",
      );
      const result = run(
        s,
        { FAKE_GH_PR_NUMBER: '77', SDK_VERIFY_OK: 'true' },
        { allowFailure: true },
      );

      expect(result.exitCode).not.toBe(0);
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
      const commentCall = calls.find((c) => c[0] === 'pr' && c[1] === 'comment');
      expect(commentCall).toBeDefined();
      expect(commentCall).toEqual(expect.arrayContaining(['pr', 'comment', '77', '--body-file']));
      const bodyFileArgIndex = commentCall!.indexOf('--body-file') + 1;
      const commentBodyPath = at(commentCall!, bodyFileArgIndex);
      const commentBody = readFileSync(commentBodyPath, 'utf8');
      expect(commentBody).toContain('human@example.com');
      expect(commentBody).toContain('#991');
      expect(calls.some((c) => c[0] === 'pr' && c[1] === 'create')).toBe(false);
      expect(calls.some((c) => c[0] === 'pr' && c[1] === 'edit')).toBe(false);
      expect(calls.some((c) => c[0] === 'pr' && c[1] === 'ready')).toBe(false);
    });

    it('開いている PR が無いとき、gh pr list は呼ぶが gh pr comment は呼ばれない（既知の隙間。詳細は #991）', () => {
      const s = setup();
      pushExistingBranch(s.seedPath, 'human@example.com', 'A Human');

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
      const calls = parseGhCalls(s.ghLog);
      expect(calls).toHaveLength(1);
      expect(at(calls, 0)[0]).toBe('pr');
      expect(at(calls, 0)[1]).toBe('list');
      expect(calls.some((c) => c[0] === 'pr' && c[1] === 'comment')).toBe(false);
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
      expect(existsSync(s.pushLog)).toBe(true);
    });
  });

  describe('必須の環境変数が無いとき', () => {
    // 必須の環境変数は `${VAR:?...}` ではなく明示検査（`require_env()`）で見る: `:?` の異常終了は EXIT trap の `printf` が成功で終わるせいで終了コードが 0 へ上書きされるため。
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

        expect(result.exitCode).not.toBe(0);
        expect(existsSync(s.pushLog)).toBe(false);
        expect(existsSync(s.ghLog)).toBe(false);
        expect(result.stderr).toContain(`${missingKey}`);
      },
    );
  });

  describe('SDK_CI_TRIGGERED による CI未起動の通知（#867）', () => {
    const PREFIXED_TITLE = `[CI未起動] ${TITLE}`;

    function writeCatalogDiff(s: ReturnType<typeof setup>): void {
      writeFileSync(
        join(s.workdir, 'pnpm-workspace.yaml'),
        "catalog:\n  '@anthropic-ai/claude-agent-sdk': ^0.3.238\n",
      );
    }

    describe('新規作成の経路（gh pr create）', () => {
      it('陽性: SDK_CI_TRIGGERED=false のとき、本文の先頭に警告が付きタイトルに接頭が付き ::warning:: annotation が出る', () => {
        const s = setup();
        writeCatalogDiff(s);

        const result = run(s, {
          FAKE_GH_PR_NUMBER: '',
          SDK_VERIFY_OK: 'true',
          SDK_CI_TRIGGERED: 'false',
        });

        expect(result.exitCode).toBe(0);
        const body = readFileSync(s.bodyFile, 'utf8');
        expect(body.startsWith(WARNING_MARK)).toBe(true);
        expect(body).toContain('#867');
        expect(body).toContain('本文');
        expect(body.indexOf(WARNING_MARK)).toBeLessThan(body.indexOf('本文'));
        const calls = parseGhCalls(s.ghLog);
        expect(titleArgOf(at(calls, 1))).toBe(PREFIXED_TITLE);
        expect(result.stderr).toContain('::warning::');
      });

      it('🔴 陰性対照: SDK_CI_TRIGGERED=true のとき、警告の文言が本文のどこにも1文字も出ずタイトルに接頭も付かず annotation も出ない', () => {
        const s = setup();
        writeCatalogDiff(s);

        const result = run(s, {
          FAKE_GH_PR_NUMBER: '',
          SDK_VERIFY_OK: 'true',
          SDK_CI_TRIGGERED: 'true',
        });

        expect(result.exitCode).toBe(0);
        const body = readFileSync(s.bodyFile, 'utf8');
        expect(body).not.toContain('WARNING');
        expect(body).not.toContain('CI が付かない');
        expect(body).not.toContain('#867');
        expect(body).toBe('本文\n');
        const calls = parseGhCalls(s.ghLog);
        expect(titleArgOf(at(calls, 1))).toBe(TITLE);
        expect(calls[1]).not.toContain(PREFIXED_TITLE);
        expect(result.stderr).not.toContain('::warning::');
      });

      it('空文字は「起きない」側へ倒れる（陽性側と同じ扱い）', () => {
        const s = setup();
        writeCatalogDiff(s);

        const result = run(s, {
          FAKE_GH_PR_NUMBER: '',
          SDK_VERIFY_OK: 'true',
          SDK_CI_TRIGGERED: '',
        });

        expect(result.exitCode).toBe(0);
        const body = readFileSync(s.bodyFile, 'utf8');
        expect(body.startsWith(WARNING_MARK)).toBe(true);
        const calls = parseGhCalls(s.ghLog);
        expect(titleArgOf(at(calls, 1))).toBe(PREFIXED_TITLE);
      });

      it('未設定（キー自体が無い）も「起きない」側へ倒れる（陽性側と同じ扱い）', () => {
        // `run()` を経由せず env を自前で組む: `run()` の既定は SDK_CI_TRIGGERED='true' を足すので、「キーが無い」を作れないため。
        const s = setup();
        writeCatalogDiff(s);
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
        expect('SDK_CI_TRIGGERED' in env).toBe(false);

        const result = runScript(PR_SCRIPT, s.workdir, env);

        expect(result.exitCode).toBe(0);
        const body = readFileSync(s.bodyFile, 'utf8');
        expect(body.startsWith(WARNING_MARK)).toBe(true);
        const calls = parseGhCalls(s.ghLog);
        expect(titleArgOf(at(calls, 1))).toBe(PREFIXED_TITLE);
      });
    });

    describe('既存 PR の書き換え経路（gh pr edit）', () => {
      it('陽性: SDK_CI_TRIGGERED=false のとき、本文の先頭に警告が付きタイトルに接頭が付く', () => {
        const s = setup();
        writeCatalogDiff(s);

        const result = run(s, {
          FAKE_GH_PR_NUMBER: '42',
          SDK_VERIFY_OK: 'true',
          SDK_CI_TRIGGERED: 'false',
        });

        expect(result.exitCode).toBe(0);
        const calls = parseGhCalls(s.ghLog);
        expect(calls[1]).toEqual([
          'pr',
          'edit',
          '42',
          '--title',
          PREFIXED_TITLE,
          '--body-file',
          s.bodyFile,
        ]);
        const body = readFileSync(s.bodyFile, 'utf8');
        expect(body.startsWith(WARNING_MARK)).toBe(true);
      });

      it('🔴 陰性対照: SDK_CI_TRIGGERED=true のとき、警告もタイトル接頭も出ない', () => {
        const s = setup();
        writeCatalogDiff(s);

        const result = run(s, {
          FAKE_GH_PR_NUMBER: '42',
          SDK_VERIFY_OK: 'true',
          SDK_CI_TRIGGERED: 'true',
        });

        expect(result.exitCode).toBe(0);
        const calls = parseGhCalls(s.ghLog);
        expect(calls[1]).toEqual(['pr', 'edit', '42', '--title', TITLE, '--body-file', s.bodyFile]);
        const body = readFileSync(s.bodyFile, 'utf8');
        expect(body).not.toContain('WARNING');
        expect(body).toBe('本文\n');
      });

      it('前夜に付いた接頭・警告は、CI が回復した回では残らない（本文はワークフローが毎回作り直す前提で確かめる）', () => {
        const s = setup();
        writeCatalogDiff(s);

        const first = run(s, {
          FAKE_GH_PR_NUMBER: '42',
          SDK_VERIFY_OK: 'true',
          SDK_CI_TRIGGERED: 'false',
        });
        expect(first.exitCode).toBe(0);
        expect(readFileSync(s.bodyFile, 'utf8').startsWith(WARNING_MARK)).toBe(true);

        writeFileSync(s.bodyFile, '本文\n');
        // 2回目にも commit する差分を `pnpm-lock.yaml` 側に作る: 1回目と同じ内容だと「commit するものが無い」で落ち、タイトルの版表示（SDK_VERSION）には影響させたくないため。
        writeFileSync(join(s.workdir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n# night 2\n");
        const second = run(s, {
          FAKE_GH_PR_NUMBER: '42',
          SDK_VERIFY_OK: 'true',
          SDK_CI_TRIGGERED: 'true',
        });
        expect(second.exitCode).toBe(0);

        const calls = parseGhCalls(s.ghLog);
        const editCalls = calls.filter((c) => c[0] === 'pr' && c[1] === 'edit');
        expect(editCalls).toHaveLength(2);
        const lastEdit = at(editCalls, 1);
        expect(titleArgOf(lastEdit)).toBe(TITLE);
        const bodyAfterSecond = readFileSync(s.bodyFile, 'utf8');
        expect(bodyAfterSecond).not.toContain('WARNING');
        expect(bodyAfterSecond).toBe('本文\n');
      });
    });
  });
});
