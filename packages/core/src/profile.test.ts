import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createProfileApplier,
  createProfileVessel,
  evaluateProfile,
  renderProfileFile,
  PROFILE_SOURCED_ENV_KEY,
} from './profile.js';

/**
 * 実行環境プロファイル（`.zprofile` 相当）。
 *
 * ここで固定しているのは4つ。
 *
 * 1. **人間が書いた1本のスクリプトで環境が増やせる**（実装を直さずに済む）
 * 2. **上（記憶）へ到達する鍵は、本文が何を書いても配らない**
 * 3. **壊れたものは置かない**（置くと以後すべてのコマンドが壊れた環境で走る）
 * 4. **入れ子の bash で無限再帰しない**（`BASH_ENV` は継承される）
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alteroid-profile-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('器に置く形', () => {
  it('本文の外側に、再入の番人と伏せる鍵の unset を足す', () => {
    const rendered = renderProfileFile('export FOO=1', ['ALTEROID_DATABASE_URL']);

    expect(rendered).toContain('export FOO=1');
    expect(rendered).toContain(PROFILE_SOURCED_ENV_KEY);
    // **`unset` は番人の外。** 本文が `return` で抜けても必ず到達させる。
    const guardEnd = rendered.lastIndexOf('fi');
    expect(rendered.indexOf('unset ALTEROID_DATABASE_URL')).toBeGreaterThan(guardEnd);
  });

  it('入れ子のシェルで本文を二度読まない（無限再帰しない）', () => {
    const path = join(dir, 'profile.sh');
    const vessel = createProfileVessel({ path });
    // 本文がコマンドを走らせる形。番人が無いと、`BASH_ENV` を継承した内側の
    // シェルが同じ本文をまた読み、そのまま無限に降りていく。
    return vessel.set('COUNT="${COUNT:-0}"; COUNT=$((COUNT + 1)); export COUNT').then(() => {
      const out = execFileSync('/bin/sh', ['-c', `. "$0"; . "$0"; printf %s "$COUNT"`, path], {
        encoding: 'utf8',
      });
      expect(out).toBe('1');
    });
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
    // 器が書いた `unset` と、評価側の削除の二重。どちらか片方でも通る。
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

    // **前のものがそのまま効いている。** 壊れたものを置くと、以後すべての
    // コマンドが毎回エラーを吐く環境で走る。
    expect(applier.env().OK).toBe('1');
    expect(readFileSync(path, 'utf8')).toContain('export OK=1');
    // 仮置きも残さない
    expect(existsSync(`${path}.tmp`)).toBe(false);
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
    // 何が増えたかは見える（届いているかの確認に要る）。値は見えない。
    expect(result.names).toContain('SOME_API_TOKEN');
  });
});
