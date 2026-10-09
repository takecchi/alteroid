import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import {
  createProfileApplier,
  createProfileVessel,
  evaluateProfile,
  renderProfileFile,
  PROFILE_SOURCED_ENV_KEY,
} from './profile.js';

let dir: string;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-profile-');
});

function viaBashEnv(dir: string, script: string, profilePath: string): string {
  const runner = join(dir, `run-${randomUUID().slice(0, 8)}.sh`);
  writeFileSync(runner, `${script}\n`);
  return execFileSync('/bin/bash', [runner], {
    encoding: 'utf8',
    env: { BASH_ENV: profilePath },
  }).trim();
}

/**
 * 器の番人を継承しないよう env を明示する: 継承すると（機序は `profile.ts` の module doc）
 * 本文が一度も走らず空文字が返り、「無限再帰しない」の歯が呼び出し経路のせいで赤くなる。
 */
function sourceTwiceAndCount(profilePath: string): string {
  return execFileSync('/bin/sh', ['-c', `. "$0"; . "$0"; printf %s "$COUNT"`, profilePath], {
    encoding: 'utf8',
    env: {},
  });
}

describe('器に置く形', () => {
  it('本文を関数に閉じ込め、その呼び出しの後で伏せる鍵を落とす', () => {
    const rendered = renderProfileFile('export FOO=1', ['ALTEROID_DATABASE_URL']);

    expect(rendered).toContain('export FOO=1');
    expect(rendered).toContain(PROFILE_SOURCED_ENV_KEY);
    const body = rendered.indexOf('export FOO=1');
    const call = rendered.indexOf('__alteroid_profile_body "$@"');
    const cleanup = rendered.indexOf('unset ALTEROID_DATABASE_URL');
    expect(body).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(body);
    expect(cleanup).toBeGreaterThan(call);
  });

  it('本文の return で、伏せる鍵の unset を飛ばせない', async () => {
    const path = join(dir, 'profile.sh');
    const vessel = createProfileVessel({ path, withheldEnvKeys: ['ALTEROID_DATABASE_URL'] });
    await vessel.set('export ALTEROID_DATABASE_URL=postgres://injected\nreturn 0');

    expect(viaBashEnv(dir, 'echo "[${ALTEROID_DATABASE_URL:-}]"', path)).toBe('[]');
    expect(
      execFileSync('/bin/sh', ['-c', `. "$0"; echo "[\${ALTEROID_DATABASE_URL:-}]"`, path], {
        encoding: 'utf8',
        env: {},
      }).trim(),
    ).toBe('[]');
  });

  it('早期リターンは本文の書き方としてそのまま効く（能力は削らない）', async () => {
    const path = join(dir, 'profile.sh');
    const vessel = createProfileVessel({ path });
    await vessel.set('export BEFORE=1\n[ -f /nonexistent ] || return 0\nexport AFTER=1');

    expect(viaBashEnv(dir, 'echo "${BEFORE:-none} ${AFTER:-none}"', path)).toBe('1 none');
  });

  it('入れ子のシェルで本文を二度読まない（無限再帰しない）', () => {
    const path = join(dir, 'profile.sh');
    const vessel = createProfileVessel({ path });
    return vessel.set('COUNT="${COUNT:-0}"; COUNT=$((COUNT + 1)); export COUNT').then(() => {
      expect(sourceTwiceAndCount(path)).toBe('1');
    });
  });

  // 直上の歯は親に番人が立っていないと密閉が外れても緑のままなので、親に番人を立てて捕まえる。
  // `afterEach` へ置かない: 書いた場所と戻す場所を離すと戻し忘れが別の編集で生まれる。
  it('親の環境に器の番人が立っていても同じ結果になる（密閉が外れたら赤くなる）', async () => {
    const path = join(dir, 'profile.sh');
    const vessel = createProfileVessel({ path });
    await vessel.set('COUNT="${COUNT:-0}"; COUNT=$((COUNT + 1)); export COUNT');
    const previousGuard = process.env[PROFILE_SOURCED_ENV_KEY];
    process.env[PROFILE_SOURCED_ENV_KEY] = '1';
    try {
      expect(
        sourceTwiceAndCount(path),
        'この呼び出しが親の env を継承している（`sourceTwiceAndCount` の `env` の明示が' +
          '外れた）。器は BASH_ENV にプロファイルを指しているので、入れ子の bash 越しに' +
          ' pnpm test を起こすと ALTEROID_PROFILE_SOURCED が立って vitest の fork ワーカー' +
          'まで降り、本文が一度も走らずに空文字が返る。機序と実測は profile.ts の' +
          ' module doc（PR #749 / #759 が実際に踏んだ）。',
      ).toBe('1');
    } finally {
      if (previousGuard === undefined) delete process.env[PROFILE_SOURCED_ENV_KEY];
      else process.env[PROFILE_SOURCED_ENV_KEY] = previousGuard;
    }
  });
});

describe('BASH_ENV が読まれる条件', () => {
  // 器の環境を継がない: 測定が器の状態に依存し、器が配っている本物の鍵が混ざる。
  const marker = (args: readonly string[], profilePath: string): string =>
    execFileSync('/bin/bash', [...args, 'printf %s "${ALTEROID_PROFILE_TEST_MARKER:-none}"'], {
      encoding: 'utf8',
      env: { BASH_ENV: profilePath },
      stdio: ['ignore', 'pipe', 'ignore'],
    });

  let path: string;

  beforeEach(() => {
    path = join(dir, 'profile.sh');
    writeFileSync(path, 'export ALTEROID_PROFILE_TEST_MARKER=read\n');
  });

  it('bash -c は BASH_ENV を読む', () => {
    expect(marker(['-c'], path)).toBe('read');
  });

  it('非対話のログインシェル（bash -lc）も読む', () => {
    expect(marker(['-lc'], path)).toBe('read');
  });

  it('読まないのは対話シェル（bash -ic）だけである', () => {
    expect(marker(['-ic'], path)).toBe('none');
  });

  it('env から名前を外しても、BASH_ENV が残っていればプロファイルが入れ直す', async () => {
    const vessel = createProfileVessel({ path });
    await vessel.set('export ALTEROID_PROFILE_TEST_MARKER=read');

    expect(marker(['-c'], path)).toBe('read');
    expect(
      execFileSync('/bin/bash', ['-c', 'printf %s "${ALTEROID_PROFILE_TEST_MARKER:-none}"'], {
        encoding: 'utf8',
        env: {},
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    ).toBe('none');
  });
});

describe('評価', () => {
  it('本文が export したものが env の差分として返る', async () => {
    const path = join(dir, 'profile.sh');
    const vessel = createProfileVessel({ path });
    await vessel.set('export SOME_API_TOKEN=abc123\nexport PATH="/opt/bin:$PATH"');

    const result = await evaluateProfile({ path, baseEnv: { PATH: '/usr/bin' } });

    expect(result.error).toBeUndefined();
    expect(result.env.SOME_API_TOKEN).toBe('abc123');
    expect(result.env.PATH).toBe('/opt/bin:/usr/bin');
  });

  it('器と OS が足した env は差分に混ぜない（本文が置いた分だけを報告する）', async () => {
    const path = join(dir, 'profile.sh');
    const vessel = createProfileVessel({ path });
    await vessel.set('export FROM_PROFILE=1');

    // OS の注入（macOS の CoreFoundation）をあてにすると Linux の CI に歯が無くなるので、ラッパで同じ条件を作る。
    const wrapper = join(dir, 'node-with-noise.sh');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nINJECTED_BY_VESSEL=platform-noise; export INJECTED_BY_VESSEL\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
      { mode: 0o755 },
    );

    const result = await evaluateProfile({ path, baseEnv: {}, nodePath: wrapper });

    expect(result.error).toBeUndefined();
    expect(result.env.FROM_PROFILE).toBe('1');
    expect(result.env.INJECTED_BY_VESSEL).toBeUndefined();
    expect(Object.keys(result.env)).toEqual(['FROM_PROFILE']);
  });

  it('macOS が注ぐ __CF_USER_TEXT_ENCODING を差分に混ぜない', async () => {
    const path = join(dir, 'profile.sh');
    const vessel = createProfileVessel({ path });
    await vessel.set('export FROM_PROFILE=1');

    const result = await evaluateProfile({ path, baseEnv: {} });

    expect(result.error).toBeUndefined();
    expect(Object.keys(result.env)).toEqual(['FROM_PROFILE']);
  });

  describe.each(['/bin/sh', '/bin/bash'])('失敗の output に鍵の値を出さない（%s）', (shell) => {
    const FAKE = 'FAKE_SECRET_VALUE_2429';

    it('構文エラーが入力の行を引用しても、値は伏せ、診断の文は残る', async () => {
      const path = join(dir, 'profile.sh');
      writeFileSync(path, `export OK=1\nexport GH_TOKEN=${FAKE} )\n`);

      const result = await evaluateProfile({ path, baseEnv: {}, shell });

      expect(result.error).toBeDefined();
      expect(result.output).not.toContain(FAKE);
      expect(result.error ?? '').not.toContain(FAKE);
      expect(result.output).toMatch(/syntax error|unexpected/i);
      expect(result.output).toMatch(/line 2|:\s*2:/);
    });

    it('set -x の "+ export NAME=値" も、値は伏せる', async () => {
      const path = join(dir, 'profile.sh');
      writeFileSync(path, `set -x\nexport GH_TOKEN=${FAKE}\nreturn 1\n`);

      const result = await evaluateProfile({ path, baseEnv: {}, shell });

      expect(result.error).toBeDefined();
      expect(result.output).not.toContain(FAKE);
      expect(result.output).toContain('export GH_TOKEN=');
    });

    it('環境変数にある値は、名前の形に合わない行に出ても伏せる', async () => {
      const path = join(dir, 'profile.sh');
      writeFileSync(path, `echo "using ${FAKE}" >&2\nreturn 1\n`);

      const result = await evaluateProfile({
        path,
        baseEnv: { DEPLOY_API_TOKEN: FAKE },
        shell,
      });

      expect(result.output).toContain('using');
      expect(result.output).not.toContain(FAKE);
    });

    it('長い stderr は末尾4000字に切る。値は切り口をまたいでも残らない', async () => {
      const path = join(dir, 'profile.sh');
      // 値の途中を切り口に当てる: 先に切ると、割れた断片が伏せ字に合わず残る。
      const body = `echo "${'x'.repeat(10)} ${FAKE} ${'y'.repeat(3_987)}" >&2\nreturn 1\n`;
      writeFileSync(path, body);

      const result = await evaluateProfile({
        path,
        baseEnv: { DEPLOY_API_TOKEN: FAKE },
        shell,
      });

      expect(result.output.length).toBeLessThanOrEqual(4_000 + '…（前略）\n'.length);
      expect(result.output).not.toContain(FAKE);
      expect(result.output).not.toContain('FAKE_SECRET');
      expect(result.output).not.toContain('_2429');
    });
  });

  it('後始末が飛ばされていたら、それを検出して報告する', async () => {
    // 抜け道を数え上げて弾く形にしない: 数え忘れた1つがそのまま穴になる。
    const path = join(dir, 'profile.sh');
    const vessel = createProfileVessel({ path });
    await vessel.set('export ALTEROID_DATABASE_URL=postgres://injected');

    const result = await evaluateProfile({
      path,
      baseEnv: {},
      withheldEnvKeys: ['ALTEROID_DATABASE_URL'],
    });

    expect(result.leaked).toEqual(['ALTEROID_DATABASE_URL']);
    expect(result.env.ALTEROID_DATABASE_URL).toBeUndefined();
  });

  it('上（記憶）へ到達する鍵は、本文が export しても配らない', async () => {
    const path = join(dir, 'profile.sh');
    const vessel = createProfileVessel({ path, withheldEnvKeys: ['ALTEROID_DATABASE_URL'] });
    await vessel.set('export ALTEROID_DATABASE_URL=postgres://stolen\nexport OK=1');

    const result = await evaluateProfile({
      path,
      baseEnv: {},
      withheldEnvKeys: ['ALTEROID_DATABASE_URL'],
    });

    expect(result.env.OK).toBe('1');
    expect(result.env.ALTEROID_DATABASE_URL).toBeUndefined();
  });

  it('読めない本文は理由つきで失敗する（黙って空を返さない）', async () => {
    const path = join(dir, 'profile.sh');
    const vessel = createProfileVessel({ path });
    await vessel.set('if [ ; then\n  echo broken\n');

    const result = await evaluateProfile({ path, baseEnv: {} });

    expect(result.error).toBeDefined();
    expect(result.env).toEqual({});
  });

  it('返ってこない本文で永久に待たない', async () => {
    const path = join(dir, 'profile.sh');
    const vessel = createProfileVessel({ path });
    await vessel.set('sleep 30');

    const result = await evaluateProfile({ path, baseEnv: {}, timeoutMs: 300 });

    expect(result.error).toContain('300ms');
  });

  it('本文の標準出力は捨てず、評価結果にも混ぜない', async () => {
    const path = join(dir, 'profile.sh');
    const vessel = createProfileVessel({ path });
    await vessel.set('echo "これは人間へのメッセージ"\nexport OK=1');

    const result = await evaluateProfile({ path, baseEnv: {} });

    expect(result.error).toBeUndefined();
    expect(result.env.OK).toBe('1');
    expect(result.output).toContain('これは人間へのメッセージ');
  });
});

describe('置き換え', () => {
  it('壊れた本文は置かない（前のものが残る）', async () => {
    const path = join(dir, 'profile.sh');
    const applier = createProfileApplier({
      vessel: createProfileVessel({ path }),
      baseEnv: () => ({}),
    });

    const good = await applier.apply('export OK=1');
    expect(good.ok).toBe(true);
    expect(applier.env().OK).toBe('1');
    expect(applier.env().BASH_ENV).toBe(path);

    const bad = await applier.apply('if [ ; then');
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeDefined();

    expect(applier.env().OK).toBe('1');
    expect(readFileSync(path, 'utf8')).toContain('export OK=1');
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('後始末が飛ばされたプロファイルは保存も配布もしない', async () => {
    const path = join(dir, 'profile.sh');
    const applier = createProfileApplier({
      vessel: createProfileVessel({ path }),
      baseEnv: () => ({}),
      withheldEnvKeys: ['ALTEROID_DATABASE_URL'],
    });

    await applier.apply('export OK=1');
    const bad = await applier.apply('export ALTEROID_DATABASE_URL=postgres://injected');

    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('ALTEROID_DATABASE_URL');
    expect(applier.env().OK).toBe('1');
    expect(readFileSync(path, 'utf8')).toContain('export OK=1');
  });

  it('空文字で外せる', async () => {
    const path = join(dir, 'profile.sh');
    const applier = createProfileApplier({
      vessel: createProfileVessel({ path }),
      baseEnv: () => ({}),
    });

    await applier.apply('export OK=1');
    const cleared = await applier.apply('');

    expect(cleared.ok).toBe(true);
    expect(applier.env()).toEqual({});
    expect(applier.fingerprint()).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  it('指紋は出すが、本文の中身は出さない', async () => {
    const applier = createProfileApplier({
      vessel: createProfileVessel({ path: join(dir, 'profile.sh') }),
      baseEnv: () => ({}),
    });

    const result = await applier.apply('export SOME_API_TOKEN=super-secret');

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('super-secret');
    expect(result.names).toContain('SOME_API_TOKEN');
  });
});
