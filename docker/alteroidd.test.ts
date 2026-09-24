/**
 * `docker/alteroidd`（デーモンを起こすシム）のうち、**V8 のヒープ上限の既定を
 * 上げる応急処置**（#1283 系列。オーナーからの指摘を受けて追加）を固定する。
 *
 * **根治（大きすぎるセッションは resume しない）とは別物。** こちらは根治が
 * 入るまでの時間を買うための応急処置で、`docker/alteroidd` の doc に算術と
 * 「暫定値。オーナーが決めること」が書いてある。
 *
 * **本物の `node` にも本物の `setpriv` にも（可能な範囲で）触れない。** PATH の
 * 先頭に偽の `node` を置き、渡された引数とその時点の `NODE_OPTIONS` を観測する。
 * `entry`（`/app/apps/daemon/dist/index.js`）は本番のコンテナにしか無いパスだが、
 * 偽の `node` は entry を読みに行かず引数として受け取るだけなので、存在しなくても
 * 実行できる。
 *
 * ⚠️ **`setpriv` の分岐（root で起きたとき）そのものの実行は、この環境では
 * 確かめていない。** `setpriv --reuid=... --init-groups` は実際に特権操作（他
 * ユーザーへの実効 uid/gid の切り替えに伴う initgroups(3)）を要求し、この
 * テスト実行環境は root ではないため（`unshare --user --map-root-user` も
 * `Permission denied` で拒否された）、実行できない。**代わりに次の2つで補う**——
 * (1) 下の「NODE_OPTIONS の分岐は setpriv の枝より前に置いてある」で、静的な
 * 位置関係を固定する（構造上、両方の分岐に必ず効く） (2) 手元で
 * `setpriv --reuid=<自分の uid> --regid=<自分の gid> --keep-groups env`
 * （`--init-groups` の代わりに `--keep-groups` を使う——後者は root が要らない）
 * を実行し、`NODE_OPTIONS` が子プロセスの環境にそのまま残ることを確認した
 * （`setpriv` が reuid/regid の切り替え自体では環境変数を落とさないことの、
 * 権限を要らない形での確認）。この手動確認はテストとしては固定していない
 * （`setpriv` 自体の挙動であって `alteroidd` の分岐ではないため）。
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'alteroidd');
const SCRIPT_SOURCE = readFileSync(SCRIPT, 'utf8');

type Result = { exitCode: number; stdout: string; stderr: string };

function mktemp(): string {
  return mkdtempSync(join(tmpdir(), 'alteroidd-test-'));
}

/**
 * 偽の `node` を1本用意する。**entry を読みに行かない**——受け取った引数と、
 * その時点の `NODE_OPTIONS` を1行 JSON で吐くだけである。これで、本番にしか
 * 無い `entry`（`/app/apps/daemon/dist/index.js`）が存在しなくても実行できる。
 */
function setupFakeNode(root: string): void {
  const bin = join(root, 'node');
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      // ここでの `node` は PATH 上で自分自身を指してしまうので、実体（envvar
      // `ALTEROIDD_TEST_REAL_NODE`）を明示的に使う。`"$@"` で引数をそのまま
      // 引き継ぐ（中間変数に入れて再展開すると単語分割で壊れる）。
      '"$ALTEROIDD_TEST_REAL_NODE" -e \'',
      'console.log(JSON.stringify({',
      '  args: process.argv.slice(1),',
      '  NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,',
      '}));',
      '\' -- "$@"',
      '',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
}

/**
 * もう1本の偽の `node`。こちらは**本物の V8 のヒープ上限を実測して返す**
 * （陽性対照——文字列operationだけでなく、実際に V8 の挙動が変わることを見る）。
 * entry には触れない（`-e` で直接測るだけ）。
 */
function setupHeapProbeNode(root: string): void {
  const bin = join(root, 'node');
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      '"$ALTEROIDD_TEST_REAL_NODE" -e \'',
      'console.log(require("v8").getHeapStatistics().heap_size_limit/1024/1024);',
      "'",
      '',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
}

function run(
  args: string[],
  env: Record<string, string> = {},
  node: 'echo' | 'heap' = 'echo',
): Result {
  const root = mktemp();
  if (node === 'echo') setupFakeNode(root);
  else setupHeapProbeNode(root);

  const fullEnv: Record<string, string> = {
    PATH: `${root}:/usr/bin:/bin`,
    HOME: root,
    // 偽の `node` の中から本物の node を呼べるようにする（PATH 経由だと
    // 自分自身＝偽の node を再帰的に呼んでしまうため）。
    ALTEROIDD_TEST_REAL_NODE: process.execPath,
    ...env,
  };

  try {
    const stdout = execFileSync(SCRIPT, args, { env: fullEnv, encoding: 'utf8' });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout?.toString('utf8') ?? '',
      stderr: e.stderr?.toString('utf8') ?? '',
    };
  } finally {
    // 呼び出し側は out.args / out.NODE_OPTIONS しか見ず、root 配下のファイルを
    // 読み戻すことはない（`readFileSync` で root 配下を読み直す呼び出しは無い）
    // ので、execFileSync が終わった時点で消してよい。
    rmSync(root, { recursive: true, force: true });
  }
}

describe('docker/alteroidd — V8 ヒープ上限の既定（応急処置。#1283 系列）', () => {
  it('NODE_OPTIONS が無いとき、既定の --max-old-space-size=12288 を足す', () => {
    const result = run(['--foo']);
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.args).toEqual(['/app/apps/daemon/dist/index.js', '--foo']);
    expect(out.NODE_OPTIONS).toContain('--max-old-space-size=12288');
  });

  it('外から --max-old-space-size が来ていれば、値を変えず1文字も触らない', () => {
    const result = run(['--foo'], { NODE_OPTIONS: '--max-old-space-size=2048' });
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    // **足さないだけでなく、値そのものも書き換えていない**——「大きいほうを選ぶ」
    // ような賢い上書きもしないことを見る（コマンドライン引数の実測と同じ理由で、
    // 外の指定は無条件に尊重する）。
    expect(out.NODE_OPTIONS).toBe('--max-old-space-size=2048');
  });

  it('他のフラグと共存する（既存のフラグを消さない）', () => {
    const result = run(['--foo'], { NODE_OPTIONS: '--trace-warnings' });
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.NODE_OPTIONS).toContain('--trace-warnings');
    expect(out.NODE_OPTIONS).toContain('--max-old-space-size=12288');
  });

  /**
   * ⭐ 陽性対照。**文字列としての `NODE_OPTIONS` ではなく、V8 が実際に読んだ
   * ヒープ上限そのもの**を実測する。`node -e 'require("v8").getHeapStatistics()…'`
   * で測る（依頼者が要求した3点のうち、下の2点をここで固定する）。
   *
   * **既定（4,144 MB 相当）との比較は入れない。** 素の V8 の既定値は器の
   * 実メモリで変わりうる（CI と手元で違いうる）ので、固定すると器の違いで
   * 壊れる歯になる。ここで確かめるのは「明らかに大きい値（既定より遥かに
   * 大きい下限）になっている」ことと「外から来た値のときは、その値の近傍に
   * 留まり 12288 には寄らない」ことの2点——どちらも器のメモリ量に依存しない。
   */
  it('⭐ ヒープ上限が実際に変わる（本物の V8 で実測）', () => {
    const withoutExternal = run([], {}, 'heap');
    expect(withoutExternal.exitCode).toBe(0);
    const bytesWithoutExternal = Number(withoutExternal.stdout.trim());
    // 12288 ちょうどにはならない（V8 が固定の overhead を足す。実測では
    // 12288 → 12336 の +48）。**近傍**であることだけを見る。
    expect(bytesWithoutExternal).toBeGreaterThanOrEqual(12288);
    expect(bytesWithoutExternal).toBeLessThan(12288 + 500);

    const withExternal = run([], { NODE_OPTIONS: '--max-old-space-size=2048' }, 'heap');
    expect(withExternal.exitCode).toBe(0);
    const bytesWithExternal = Number(withExternal.stdout.trim());
    expect(bytesWithExternal).toBeGreaterThanOrEqual(2048);
    expect(bytesWithExternal).toBeLessThan(2048 + 500);
    // **12288 の近傍ではない**——外の値を無効化していないことの直接の証拠。
    expect(bytesWithExternal).toBeLessThan(12288);
  });

  /**
   * ⚠️ **構造の確認であって、`setpriv` の枝の実行そのものではない**
   * （ファイル冒頭の doc）。`NODE_OPTIONS` を決める `case` 文が
   * `if [ "$(id -u)" = '0' ]` より**前**に置かれていることを見る——前に
   * 置かれていれば、`export` された `NODE_OPTIONS` は root 分岐
   * （`exec setpriv …`）にも非 root 分岐（`exec node …`）にも同じ1つの
   * シェルプロセスの環境として渡る。
   */
  it('NODE_OPTIONS の分岐は id -u の判定より前に置いてある（root・非 root どちらの枝にも効く）', () => {
    const caseIndex = SCRIPT_SOURCE.indexOf('max-old-space-size=12288');
    const idCheckIndex = SCRIPT_SOURCE.indexOf(`if [ "$(id -u)" = '0' ]`);
    expect(caseIndex).toBeGreaterThan(-1);
    expect(idCheckIndex).toBeGreaterThan(-1);
    expect(caseIndex).toBeLessThan(idCheckIndex);
  });
});
