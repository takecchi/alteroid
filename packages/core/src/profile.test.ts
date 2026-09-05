import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * 実物の bash に `BASH_ENV` として読ませて、1行を出させる。
 *
 * **スクリプトファイルとして起こす。** ここで見たいのは「読まれたときに後始末が
 * 効くか」なので、読まれる形で起こす。**`bash -c` でも読まれる**（読まないのは
 * 対話シェルだけ。下の `describe('BASH_ENV が読まれる条件')` が実物で測っている）
 * — かつてここには「`bash -c` は stdin が端末でないと読まない」と書いてあったが、
 * 実物は逆である。
 */
function viaBashEnv(dir: string, script: string, profilePath: string): string {
  const runner = join(dir, `run-${randomUUID().slice(0, 8)}.sh`);
  writeFileSync(runner, `${script}\n`);
  return execFileSync('/bin/bash', [runner], {
    encoding: 'utf8',
    env: { BASH_ENV: profilePath },
  }).trim();
}

describe('器に置く形', () => {
  it('本文を関数に閉じ込め、その呼び出しの後で伏せる鍵を落とす', () => {
    const rendered = renderProfileFile('export FOO=1', ['ALTEROID_DATABASE_URL']);

    expect(rendered).toContain('export FOO=1');
    expect(rendered).toContain(PROFILE_SOURCED_ENV_KEY);
    // 本文 → 関数の呼び出し → `unset` の順に並んでいること。**この順序が要件である。**
    const body = rendered.indexOf('export FOO=1');
    const call = rendered.indexOf('__alteroid_profile_body "$@"');
    const cleanup = rendered.indexOf('unset ALTEROID_DATABASE_URL');
    expect(body).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(body);
    expect(cleanup).toBeGreaterThan(call);
  });

  /**
   * **本文の `return` で後始末を飛ばせないこと。**
   *
   * source されたファイルの中の `return` は、`if` から抜けるのではなく
   * **そのファイルの読み込みそのもの**から戻る。本文を直に置いていた頃は、
   * `[ -f ~/.foo ] || return 0` のような普通の早期リターン1つで末尾の `unset` に
   * 到達しなくなり、伏せるはずの鍵が `BASH_ENV` 経由でそのまま残っていた。
   *
   * **実物のシェルに読ませて確かめる。** Node 側の評価だけを見ていたせいで、
   * 「検査は通るのに実物は漏れている」を見逃した（そちらには Node のフィルタが
   * あり、`BASH_ENV` の経路には無い）。
   */
  it('本文の return で、伏せる鍵の unset を飛ばせない', async () => {
    const path = join(dir, 'profile.sh');
    const vessel = createProfileVessel({ path, withheldEnvKeys: ['ALTEROID_DATABASE_URL'] });
    await vessel.set('export ALTEROID_DATABASE_URL=postgres://injected\nreturn 0');

    // ① `BASH_ENV` として読まれた場合
    expect(viaBashEnv(dir, 'echo "[${ALTEROID_DATABASE_URL:-}]"', path)).toBe('[]');
    // ② `gh` のシムと評価が通る経路（sh の source）
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

    // `return` より前は効き、後は走らない ＝ 人間が普通に期待する挙動
    expect(viaBashEnv(dir, 'echo "${BEFORE:-none} ${AFTER:-none}"', path)).toBe('1 none');
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

/**
 * **`BASH_ENV` が読まれる条件を、実物の bash で測る。**
 *
 * この repo は長らく「`bash -c`（stdin が端末でない）では `BASH_ENV` を読まない」と
 * 書いていた。**実物の挙動は逆である。読まないのは対話シェルだけ**で、`bash -c` も
 * `bash -lc` も読む。「stdin が端末でない」という条件は、bash の実際の挙動とは
 * **逆向き**である（端末でないほうが読む側である）。
 *
 * **この誤りは事故になった**（2026-09-05）。委譲先が対照実験のために
 * `env -u <鍵> …` で鍵を外して走らせたが、入れ子の `bash -c` が `BASH_ENV` から
 * プロファイルを読み直して鍵を再 `export` したため、**外れないまま本物の API を
 * 叩いた。** 外れなかったことは**エラーにならない** — 鍵が在るので動いてしまう。
 *
 * **コメントは実行されないが、歯は実行される。** 誤った記述は6箇所に分かれて
 * 3週間以上残り、そのどれも赤くならなかった。ここが赤くなったら、**記述のほうを
 * 実物に合わせ直すこと**（この歯を緩めるのではなく）。
 */
describe('BASH_ENV が読まれる条件', () => {
  /**
   * 実物の bash を、**器の環境を1つも継がずに**起こす（`env -i` に当たる）。
   *
   * 継ぐと、測っているものが器の状態に依存するうえ、**器が配っている本物の鍵が
   * 測定対象に混ざる。** この歯が触ってよいのはダミーだけである。
   */
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

  /**
   * **帰結。これが事故の形そのものである。**
   *
   * `env -u <名前>` が作るのは「その名前を持たない env」である。そこに `BASH_ENV`
   * が残っていると、起きた bash がプロファイルを読み直して**同じ名前を入れ直す。**
   * 外したい側は **`BASH_ENV` も一緒に外す**必要がある。
   *
   * 値はダミーである。**実物の鍵をこの歯に持ち込まないこと。**
   */
  it('env から名前を外しても、BASH_ENV が残っていればプロファイルが入れ直す', async () => {
    const vessel = createProfileVessel({ path });
    await vessel.set('export ALTEROID_PROFILE_TEST_MARKER=read');

    // `env -u ALTEROID_PROFILE_TEST_MARKER` に当たる env（その名前を持たない）
    expect(marker(['-c'], path)).toBe('read');
    // `BASH_ENV` も一緒に外した場合だけ、外したものが外れたままになる
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

  /**
   * **器と OS が勝手に足した env を、プロファイルの仕業として報告しない。**
   *
   * macOS では CoreFoundation が `__CF_USER_TEXT_ENCODING` を**どの子へも**注ぐので、
   * `export SOME_API_TOKEN=...` だけのプロファイルが
   * `names: ['SOME_API_TOKEN', '__CF_USER_TEXT_ENCODING']` を返していた。
   * Linux では注がれないため CI は緑で、**手元でだけ落ちる**形だった（＝「たまたま
   * 踏まなかった」側であって、直っていたわけではない）。
   *
   * **ここで OS の注入をあてにしない。** `__CF_USER_TEXT_ENCODING` を直接見る形にすると
   * Linux では何も起きない ＝ CI に歯が無いままになる。だから env を吐かせる node を
   * 「先に1つ export してから本物へ渡すラッパ」に差し替えて、**注ぐ側と同じ条件**を
   * どの OS でも作る。ベースライン計測を外すとこのテストは Linux でも落ちる。
   */
  it('器と OS が足した env は差分に混ぜない（本文が置いた分だけを報告する）', async () => {
    const path = join(dir, 'profile.sh');
    const vessel = createProfileVessel({ path });
    await vessel.set('export FROM_PROFILE=1');

    // 本物の node の手前で1つ export する ＝ CoreFoundation が注ぐのと同じ形。
    // 本文を読む側にも読まない側にも等しく現れるので、打ち消えるのが正しい。
    const wrapper = join(dir, 'node-with-noise.sh');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nINJECTED_BY_VESSEL=platform-noise; export INJECTED_BY_VESSEL\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
      { mode: 0o755 },
    );

    const result = await evaluateProfile({ path, baseEnv: {}, nodePath: wrapper });

    expect(result.error).toBeUndefined();
    // 本文が置いた分は載る（打ち消しが行きすぎて全部消えたのではない）
    expect(result.env.FROM_PROFILE).toBe('1');
    // 器が注いだ分は載らない
    expect(result.env.INJECTED_BY_VESSEL).toBeUndefined();
    expect(Object.keys(result.env)).toEqual(['FROM_PROFILE']);
  });

  /**
   * 上のテストの**実物での立会人**。macOS でだけ意味を持つ（Linux には注ぐ主体が
   * 居ないので素通りする）。歯を持っているのは上のラッパ版で、こちらは
   * 「報告された症状そのもの」を実物で1度押さえておくためにある。
   */
  it('macOS が注ぐ __CF_USER_TEXT_ENCODING を差分に混ぜない', async () => {
    const path = join(dir, 'profile.sh');
    const vessel = createProfileVessel({ path });
    await vessel.set('export FROM_PROFILE=1');

    const result = await evaluateProfile({ path, baseEnv: {} });

    expect(result.error).toBeUndefined();
    expect(Object.keys(result.env)).toEqual(['FROM_PROFILE']);
  });

  it('後始末が飛ばされていたら、それを検出して報告する', async () => {
    // **抜け道を数え上げて弾く形にしない。** 数え忘れた1つがそのまま穴になる
    // （実際に `return` を数え忘れた）。ここでは「器が `unset` を書かなかった」
    // 状況をそのまま作り、**実測で気づけること**だけを固定する。
    const path = join(dir, 'profile.sh');
    const vessel = createProfileVessel({ path }); // ← withheld を渡さない = unset が出ない
    await vessel.set('export ALTEROID_DATABASE_URL=postgres://injected');

    const result = await evaluateProfile({
      path,
      baseEnv: {},
      withheldEnvKeys: ['ALTEROID_DATABASE_URL'],
    });

    expect(result.leaked).toEqual(['ALTEROID_DATABASE_URL']);
    // 配る env からは落ちている（黙って配らない）。それでも「落としたから良し」に
    // しないのが要点で、実際に効く BASH_ENV の経路にこのフィルタは無い。
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

  it('後始末が飛ばされたプロファイルは保存も配布もしない', async () => {
    const path = join(dir, 'profile.sh');
    const applier = createProfileApplier({
      // 器が `unset` を書かない状況（＝後始末が飛ばされたのと同じ結果）を作る
      vessel: createProfileVessel({ path }),
      baseEnv: () => ({}),
      withheldEnvKeys: ['ALTEROID_DATABASE_URL'],
    });

    await applier.apply('export OK=1');
    const bad = await applier.apply('export ALTEROID_DATABASE_URL=postgres://injected');

    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('ALTEROID_DATABASE_URL');
    // 前のものが残っている ＝ 置いていない
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
    // 何が増えたかは見える（届いているかの確認に要る）。値は見えない。
    expect(result.names).toContain('SOME_API_TOKEN');
  });
});
