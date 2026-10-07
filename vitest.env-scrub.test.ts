import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isSecretEnvName, scrubSecretEnv } from './vitest.env-scrub.js';


const REPO_ROOT = dirname(fileURLToPath(import.meta.url));

const FAKE_SECRETS: Record<string, string> = {
  GH_TOKEN: 'FAKE-gh-token-env-scrub',
  GITHUB_TOKEN: 'FAKE-github-token-env-scrub',
  CLAUDE_CODE_MESSAGING_TOKEN: 'FAKE-claude-messaging-env-scrub',
  CLAUDE_CODE_OAUTH_TOKEN: 'FAKE-claude-oauth-env-scrub',
  ANTHROPIC_API_KEY: 'FAKE-anthropic-env-scrub',
  SOME_SERVICE_SECRET: 'FAKE-service-secret-env-scrub',
  DB_PASSWORD: 'FAKE-db-password-env-scrub',
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

  it('語の後ろに何かが付いた名前・区切りの無い名前・接続文字列も外す（#1815 の漏れ）', () => {
    for (const name of [
      'ALTEROID_DATABASE_URL',
      'PGPASSWORD',
      'ALTEROID_RUNNER_TOKEN_SHA256',
      'ALTEROID_GH_TOKEN_FILE',
      'MCP_CLIENT_PRIVATE_KEY_PEM',
      'SENTRY_DSN',
      'NPMTOKEN',
      'ALTEROID_GOOGLE_CLIENT_ID',
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

  // 動的 import は歯の本体ではなく hook の寿命で払わせる: 器の混雑で伸び、混んだ時に既定の 5000ms を超えるため。
  const SOURCES: readonly { file: string; exportName: string }[] = [
    { file: 'packages/core/src/runner.ts', exportName: 'WITHHELD_ENV_KEYS' },
    { file: 'apps/daemon/src/auth.ts', exportName: 'AUTH_WITHHELD_ENV_KEYS' },
  ];
  const loaded: { file: string; exportName: string; mod: Record<string, unknown> }[] = [];
  beforeAll(async () => {
    for (const { file, exportName } of SOURCES) {
      const modulePath: string = pathToFileURL(join(REPO_ROOT, file)).href;
      loaded.push({ file, exportName, mod: (await import(modulePath)) as Record<string, unknown> });
    }
  }, 30_000);

  // 一覧はソースの文字列ではなく実際に import した値で読む: 正規表現で読むとスプレッド（`...OTHER_KEYS`）で混ぜた名前が見えず、黙って緑になるため。一覧を増やしたらここの `SOURCES` に足す。
  // import の先を変数にする: `tsconfig.vitest.json` の型検査が製品のコードまで降りないようにするため。
  it('製品が子プロセスから隠す名前は、規則で外れるか、資格ではないと明示してある', () => {
    const withheld: string[] = [];
    for (const { file, exportName, mod } of loaded) {
      const keys = mod[exportName];
      expect(Array.isArray(keys), `${file} の ${exportName} が配列として読めない`).toBe(true);
      expect((keys as unknown[]).length, `${file} の ${exportName} が空`).toBeGreaterThan(0);
      for (const key of keys as unknown[]) {
        expect(typeof key, `${file} の ${exportName} に文字列でない値がある`).toBe('string');
        withheld.push(key as string);
      }
    }
    // 資格ではないが、別の理由（子プロセスの隔離）で隠している名前。足すときは理由を書く。
    const NOT_SECRET = new Set([
      'ALTEROID_HOME',
      'ALTEROID_PORT',
      'ALTEROID_RUNNER_SOCKET',
    ]);
    const unclassified = withheld.filter((name) => !isSecretEnvName(name) && !NOT_SECRET.has(name));
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
    // 根の直下ではなく `.scratch/` の下に作る: `probe.test.ts` は env 無しの子プロセスを起こすので、根の直下に置くと、同時に走る `check-no-env-passthrough` が拾って落ちるため。
    scratchRoot = join(REPO_ROOT, '.scratch', `vitest-env-scrub-itest-${randomUUID()}`);
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
    expect(seen.inTest).toEqual([]);
    expect(seen.inChild).toEqual([]);
  });
});

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
