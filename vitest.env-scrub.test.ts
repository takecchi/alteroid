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
