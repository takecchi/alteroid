import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isSecretEnvName, scrubSecretEnv } from './vitest.env-scrub.js';

/**
 * `vitest.env-scrub.ts` の歯。**値はすべて偽物である**（`FAKE-…`）。
 *
 * 単体の歯は名前の規則を測る。統合の歯は、`vitest.setup.ts` が本当にテストの
 * 前に外しているかを、偽の値を環境に入れて起こした入れ子の vitest の中から測る
 * （`vitest.tmpdir.test.ts` の統合の歯と同じ形）。**`vitest.setup.ts` の
 * `scrubSecretEnv(process.env)` の1行を外すと、統合の歯が赤になる。**
 */

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));

const FAKE_SECRETS: Record<string, string> = {
  GH_TOKEN: 'FAKE-gh-token-env-scrub',
  GITHUB_TOKEN: 'FAKE-github-token-env-scrub',
  CLAUDE_CODE_MESSAGING_TOKEN: 'FAKE-claude-messaging-env-scrub',
  CLAUDE_CODE_OAUTH_TOKEN: 'FAKE-claude-oauth-env-scrub',
  ANTHROPIC_API_KEY: 'FAKE-anthropic-env-scrub',
  SOME_SERVICE_SECRET: 'FAKE-service-secret-env-scrub',
  DB_PASSWORD: 'FAKE-db-password-env-scrub',
  // 16回目の横断レビューで、最初の規則から漏れていた名前（下の単体の歯の説明を見よ）
  PGPASSWORD: 'FAKE-pgpassword-env-scrub',
  ALTEROID_DATABASE_URL: 'postgres://alteroid:FAKE-pw-env-scrub@db:5432/alteroid',
};

describe('isSecretEnvName / scrubSecretEnv（単体）', () => {
  it('秘密の名前はすべて外す側に判定する', () => {
    for (const name of Object.keys(FAKE_SECRETS)) {
      expect(isSecretEnvName(name), name).toBe(true);
    }
    expect(isSecretEnvName('DATABASE_URL')).toBe(true);
    expect(isSecretEnvName('gh_token')).toBe(true);
  });

  it('秘密でない名前は残す（外しすぎない対照）', () => {
    for (const name of ['PATH', 'HOME', 'TZ', 'CI', 'NODE_ENV', 'ALTEROID_HOME', 'LANG']) {
      expect(isSecretEnvName(name), name).toBe(false);
    }
  });

  /**
   * 16回目の横断レビューで、#1815 の最初の規則（末尾一致）から漏れていた名前。
   * どれも、この repo のコードか設定が実際に資格として扱っている（`WITHHELD_ENV_KEYS`、
   * `manager.test.ts` の「記憶ストアの接続情報を子プロセスへ渡さない」、`ci.yml` の
   * `PGPASSWORD`）。
   */
  it('語の後ろに何かが付いた名前・区切りの無い名前・接続文字列も外す（#1815 の漏れ）', () => {
    for (const name of [
      'ALTEROID_DATABASE_URL',
      'PGPASSWORD',
      'ALTEROID_RUNNER_TOKEN_SHA256',
      'ALTEROID_GH_TOKEN_FILE',
      'MCP_CLIENT_PRIVATE_KEY_PEM',
      'SENTRY_DSN',
      'NPMTOKEN',
    ]) {
      expect(isSecretEnvName(name), name).toBe(true);
    }
  });

  it('秘密の語を部分に含むだけの語は巻き込まない（語の単位で見る対照）', () => {
    for (const name of [
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'KEYBOARD_LAYOUT',
      'PASSTHROUGH_MODE',
    ]) {
      expect(isSecretEnvName(name), name).toBe(false);
    }
  });

  /**
   * **製品が子プロセスから隠す名前（`WITHHELD_ENV_KEYS`）は、テストからも隠れているか、
   * 資格ではないと明示してあるかの、どちらかでなければならない。** 規則とこの一覧は
   * 別々に手で書くので、製品の側に資格の名前を足しても、規則に足し忘れると漏れる
   * （16回目の横断レビューの `ALTEROID_DATABASE_URL` がその形だった）。ここで
   * 突き合わせれば、足し忘れは赤になる。
   *
   * `WITHHELD_ENV_KEYS` は、ソースの文字列から読む（`@alteroid/core` を import すると
   * build の順序に縛られるため）。
   */
  it('WITHHELD_ENV_KEYS の名前は、規則で外れるか、資格ではないと明示してある', () => {
    const source = readFileSync(join(REPO_ROOT, 'packages/core/src/runner.ts'), 'utf8');
    const block = /export const WITHHELD_ENV_KEYS = \[([\s\S]*?)\] as const;/.exec(source);
    expect(block, 'WITHHELD_ENV_KEYS の定義が見つからない（形が変わった）').not.toBeNull();
    const withheld = [...(block?.[1] ?? '').matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]!);
    expect(withheld.length).toBeGreaterThan(0);
    // 資格ではないが、別の理由（子プロセスの隔離）で隠している名前。足すときは理由を書く。
    const NOT_SECRET = new Set([
      'ALTEROID_HOME', // 状態の置き場所（パス）
      'ALTEROID_PORT', // デーモンのポート番号
      'ALTEROID_RUNNER_SOCKET', // Unix ソケットのパス（接続権はファイルの権限で守る）
    ]);
    const unclassified = withheld.filter((name) => !isSecretEnvName(name) && !NOT_SECRET.has(name));
    // 【赤の意味】製品が隠している名前が、テストの中では外れていない。規則
    // （SECRET_ENV_NAME_PATTERNS / SECRET_ENV_NAME_WORDS）に足すか、資格でないなら
    // NOT_SECRET に理由つきで足すこと。
    expect(unclassified).toEqual([]);
  });

  it('scrubSecretEnv は秘密の欄だけを消し、消した名前だけを返す（値は返さない）', () => {
    const env: NodeJS.ProcessEnv = { ...FAKE_SECRETS, PATH: '/usr/bin', TZ: 'UTC' };
    const removed = scrubSecretEnv(env);
    expect(env).toEqual({ PATH: '/usr/bin', TZ: 'UTC' });
    expect(removed.sort()).toEqual(Object.keys(FAKE_SECRETS).sort());
    for (const value of Object.values(FAKE_SECRETS)) {
      expect(JSON.stringify(removed)).not.toContain(value);
    }
  });
});

describe('vitest.setup.ts はテストの前に秘密を環境から外す（統合）', () => {
  let scratchRoot = '';

  beforeAll(() => {
    scratchRoot = join(REPO_ROOT, `.vitest-env-scrub-itest-${randomUUID()}`);
    mkdirSync(scratchRoot, { recursive: true });
  });

  afterAll(() => {
    if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
  });

  it('偽の秘密を環境に入れて起こした vitest の中で、テストの process.env と子プロセスの環境に、その値が残らない', () => {
    const manifest = join(scratchRoot, 'manifest.json');
    writeFileSync(join(scratchRoot, 'probe.test.ts'), buildProbe(manifest));
    writeFileSync(join(scratchRoot, 'vitest.config.ts'), buildProbeConfig());

    const vitestBin = join(REPO_ROOT, 'node_modules', '.bin', 'vitest');
    // 外側のこのプロセスの環境は、既に vitest.setup.ts で外されている。ここで
    // 偽の値だけを足して子へ渡す（本物の値は、この歯のどこにも出てこない）。
    execFileSync(vitestBin, ['run', '--root', scratchRoot], {
      cwd: scratchRoot,
      stdio: 'pipe',
      timeout: 60_000,
      env: { ...process.env, ...FAKE_SECRETS },
    });

    const seen = JSON.parse(readFileSync(manifest, 'utf8')) as {
      inTest: string[];
      inChild: string[];
    };
    // 【赤の意味】vitest.setup.ts が秘密を外していない。テストの中の process.env
    // （と、そこから起こした子プロセス）に、偽の秘密の名前が残っている。
    expect(seen.inTest).toEqual([]);
    expect(seen.inChild).toEqual([]);
  });
});

/**
 * 入れ子の vitest で走るテスト。テストの中の `process.env` と、そこから起こした
 * 子プロセスの環境の両方で、偽の秘密の名前がまだ在るかを記録する（値は書かない）。
 */
function buildProbe(manifest: string): string {
  const names = JSON.stringify(Object.keys(FAKE_SECRETS));
  return [
    "import { execFileSync } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "import { it } from 'vitest';",
    '',
    `const NAMES: string[] = ${names};`,
    '',
    "it('環境を記録する', () => {",
    '  const inTest = NAMES.filter((name) => process.env[name] !== undefined);',
    '  const childEnv = JSON.parse(',
    "    execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'], {",
    "      encoding: 'utf8',",
    '    }),',
    '  ) as string[];',
    '  const inChild = NAMES.filter((name) => childEnv.includes(name));',
    `  writeFileSync(${JSON.stringify(manifest)}, JSON.stringify({ inTest, inChild }));`,
    '});',
    '',
  ].join('\n');
}

/** 本物の `vitest.setup.ts` だけを setupFiles に持つ、最小の構成。 */
function buildProbeConfig(): string {
  const setupPath = join(REPO_ROOT, 'vitest.setup.ts').replace(/\\/g, '/');
  return [
    "import { defineConfig } from 'vitest/config';",
    '',
    'export default defineConfig({',
    '  test: {',
    `    setupFiles: [${JSON.stringify(setupPath)}],`,
    "    include: ['*.test.ts'],",
    '  },',
    '});',
    '',
  ].join('\n');
}
