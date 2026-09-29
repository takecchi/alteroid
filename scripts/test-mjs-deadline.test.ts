import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../vitest.tmpdir.js';

import {
  EXIT_BAD_DEADLINE,
  EXIT_DEADLINE,
  formatDeadlineMessage,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない test-guard の中核）を読む
} from './test-guard-core.mjs';

/**
 * `scripts/test.mjs` の `--deadline-seconds`（外側の `timeout` に頼らない締め切り。
 * `test.mjs` 冒頭の doc、および `scripts/test-guard-core.mjs` の
 * `extractDeadlineSeconds` の doc）の**統合**の歯。
 *
 * 純粋関数（`extractDeadlineSeconds` / `formatDeadlineMessage`）の歯は
 * `scripts/test-guard-core.test.ts` に別に置いてある——ここで測るのは、
 * それらが実際の子プロセスの生死（SIGTERM/SIGKILL・プロセスグループ）と
 * どう配線されているかで、プロセスを実際に起こさないと測れない。
 *
 * ## 偽の vitest（1個のフィクスチャで4つの測定を賄う）
 *
 * `PATH` の先頭に置く偽の `vitest`（`#!/usr/bin/env node` の実行可能スクリプト）は、
 * 環境変数 `FAKE_VITEST_EXIT_CODE` の有無で2つの形に分岐する:
 *
 * - **未設定（既定）**: 孫プロセスを1つ起こす（`heartbeat.cjs`。50ms 間隔で
 *   心拍ファイルへ1行ずつ追記し続け、自分では終わらない）。その pid を
 *   `FAKE_VITEST_PIDFILE` へ書いたあと、**自分（偽の vitest）も終わらない**
 *   ——`child_process.spawn` が返す `ChildProcess` への参照を持ったままにする
 *   ことで、孫が生きている限り自分の event loop も回り続ける（`unref()` しない）。
 *   `--deadline-seconds` を指定した回（(a)(b)(c)）で使う——締め切りに殺されるまで
 *   本物のハングした vitest と同じ形で生き続ける固定具である。
 * - **設定されている**: 孫を起こさず、即座にその値を exit code として終了する。
 *   締め切りを指定しない回（(d)）で使う——`--deadline-seconds` が無ければ
 *   ラッパは vitest の exit code をそのまま返すはず、という測定を、ハングする
 *   フィクスチャを使わずに数秒で終わらせるための分岐である。
 *
 * どちらの形も同じ1つのスクリプトファイルが担う——「同じ偽の vitest を使う」
 * という設計そのものは1つに保ちつつ、分岐は引数ではなく env（`mutate-cli-child-env.ts`
 * / `verify-core.test.ts` の `FAKE_PNPM_LOG` と同じ「フィクスチャの制御は env 経由」
 * という repo の既存の作法）で行う——`--deadline-seconds` の argv 解析
 * （`extractDeadlineSeconds` / `resolveScopedArgs`）に、フィクスチャ制御用の
 * 引数を紛れ込ませないため。
 *
 * ## 子の env は `PATH` と、このフィクスチャ専用の3変数だけ
 *
 * `mutateCliChildEnv`（`scripts/mutate-cli-child-env.ts`）と同じ理由——親の
 * 環境にある機微な変数を子（`node scripts/test.mjs …`）へ渡さない。この
 * フィクスチャが読む3変数（`FAKE_VITEST_EXIT_CODE` / `FAKE_VITEST_HEARTBEAT_FILE`
 * / `FAKE_VITEST_PIDFILE`）は、渡さなければフィクスチャ自身が動かないので、
 * `PATH` に加えて明示的に足す（`verify-core.test.ts` の `buildRunVerifyEnv` が
 * `FAKE_PNPM_LOG` を足しているのと同じ形）。
 *
 * ## 後始末（孫が生き残る変異のときも、テスト自体は孫を残さない）
 *
 * 「グループへの kill を子の pid だけへの kill に変える」変異を当てると、
 * 偽の vitest 自身は死ぬが孫（心拍プロセス）は生き残る——それがこの歯の
 * 狙いそのものである（(c) が赤くなる）。**その生き残りをテストの外まで
 * 持ち出さない**——`finally` で孫の pid を直接 `SIGKILL` する（生きていなければ
 * `ESRCH` を無視するだけ）。共有の器でプロセスが際限なく積み上がらないため。
 */
describe('scripts/test.mjs --deadline-seconds（統合: 偽の vitest を子として起こす）', () => {
  const ROOT_DIR = join(import.meta.dirname, '..');
  const TEST_MJS_PATH = join(import.meta.dirname, 'test.mjs');

  /** 偽の `vitest` 実行ファイルと、その孫が書く心拍スクリプトを一時ディレクトリへ作る。 */
  async function makeFakeVitestBin(): Promise<{ binDir: string }> {
    const toolsDir = await makeTempDir('test-mjs-deadline-tools-');
    const binDir = join(toolsDir, 'bin');
    await mkdir(binDir, { recursive: true });

    const heartbeatScriptPath = join(toolsDir, 'heartbeat.cjs');
    await writeFile(
      heartbeatScriptPath,
      [
        "const fs = require('node:fs');",
        'const file = process.argv[2];',
        '// FAKE_HEARTBEAT_IGNORE_TERM が在れば SIGTERM を無視する（SIGKILL でしか止まらない孫）。',
        "if (process.env.FAKE_HEARTBEAT_IGNORE_TERM) process.on('SIGTERM', () => {});",
        'setInterval(() => {',
        "  fs.appendFileSync(file, 'x\\n');",
        '}, 50);',
        '',
      ].join('\n'),
    );

    const fakeVitestPath = join(binDir, 'vitest');
    await writeFile(
      fakeVitestPath,
      [
        '#!/usr/bin/env node',
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        '',
        '// 分岐(1): FAKE_VITEST_EXIT_CODE が在れば、孫を起こさず即座に終わる。',
        'const fakeExitCode = process.env.FAKE_VITEST_EXIT_CODE;',
        'if (fakeExitCode !== undefined) {',
        '  process.exit(Number(fakeExitCode));',
        '}',
        '',
        '// 分岐(2): 孫を1つ起こし、自分も孫も意図して終わらない。',
        'const heartbeatFile = process.env.FAKE_VITEST_HEARTBEAT_FILE;',
        'const pidFile = process.env.FAKE_VITEST_PIDFILE;',
        `const child = spawn(process.execPath, [${JSON.stringify(heartbeatScriptPath)}, heartbeatFile], { stdio: 'ignore' });`,
        'if (pidFile) fs.writeFileSync(pidFile, String(child.pid));',
        '// process.exit を呼ばない — 締め切りに殺されるまで生き続ける固定具である。',
      ].join('\n'),
    );
    await chmod(fakeVitestPath, 0o755);

    return { binDir };
  }

  /** `pid` が生きているか。`kill(pid, 0)` はシグナルを送らず存在確認だけする。 */
  function isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

  /** `pid` が死ぬまで最大 `timeoutMs` だけ短い間隔でポーリングする。 */
  async function waitUntilPidDead(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isPidAlive(pid)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return !isPidAlive(pid);
  }

  it(
    '(a)(b)(c): --deadline-seconds=1 で打ち切る — 専用の exit code・stdout の1行・孫プロセスの死、を' +
      '1回の呼び出しでまとめて測る',
    async () => {
      const { binDir } = await makeFakeVitestBin();
      const heartbeatFile = join(binDir, '..', 'heartbeat.log');
      const pidFile = join(binDir, '..', 'heartbeat.pid');

      const result = spawnSync('node', [TEST_MJS_PATH, '--deadline-seconds=1'], {
        cwd: ROOT_DIR,
        env: {
          PATH: binDir + ':' + (process.env.PATH ?? ''),
          FAKE_VITEST_HEARTBEAT_FILE: heartbeatFile,
          FAKE_VITEST_PIDFILE: pidFile,
        },
        // ⛔ 'inherit' にしないこと — vitest.setup.ts の歯（本物の stdout へ
        // 直書きしたテストを赤にする）を避けるため、必ず 'pipe' で受ける
        // （`verify-core.test.ts` の `runVerify` と同じ理由）。
        stdio: 'pipe',
        encoding: 'utf8',
        // 締め切り(1s) + 猶予(DEADLINE_KILL_GRACE_MS=3s) + 余裕。これを超えて
        // 返ってこなければ実装のどこかが本当にハングしている——テスト自身が
        // 無期限に待たないための安全弁（このテストファイル全体が「数秒に
        // 収める」という依頼の枷を守るための保険で、通常経路では発火しない）。
        timeout: 15000,
      });

      let heartbeatPid: number | undefined;
      try {
        // 前提: 孫は実際に起動して心拍を書いていた（起きてすらいなければ、
        // 後段の「死んでいる」判定は「もともと動いていなかった」を
        // 「殺せた」と取り違える）。
        const pidRaw = await readFile(pidFile, 'utf8');
        heartbeatPid = Number(pidRaw);
        expect(Number.isInteger(heartbeatPid), `pidファイルの中身: ${JSON.stringify(pidRaw)}`).toBe(
          true,
        );
        const heartbeatLines = (await readFile(heartbeatFile, 'utf8')).split('\n').filter(Boolean);
        expect(
          heartbeatLines.length,
          '孫プロセスが心拍を1行も書いていない——起動していなかった疑いがある',
        ).toBeGreaterThan(0);

        // (a) 専用の exit code。
        expect(result.status, result.stdout + '\n---stderr---\n' + result.stderr).toBe(
          EXIT_DEADLINE,
        );

        // (b) stdout に必ず1行——`formatDeadlineMessage` の文面と一致すること
        // まで確かめる（`test-guard:` を含むだけでなく、この歯が名指しした
        // 関数が実際に呼ばれていることを見る）。
        expect(result.stdout).toContain(formatDeadlineMessage(1));

        // (c) 孫（心拍プロセス）も止まっている。SIGTERM は基本的に即座に効くが、
        // 短い猶予（1s）だけポーリングして確かめる——「グループへの kill を
        // 子の pid だけへの kill に変える」変異を当てると、この孫は死なずに
        // 心拍を書き続け、この assertion が赤くなる。
        const died = await waitUntilPidDead(heartbeatPid, 1000);
        expect(
          died,
          `孫プロセス（pid=${heartbeatPid}）が締め切り後も生きている——` +
            'プロセスグループ全体ではなく、子1つだけを kill している疑いがある',
        ).toBe(true);
      } finally {
        // 後始末: 孫が生き残っていたら（変異の下での実測を含め）確実に消す。
        if (heartbeatPid !== undefined && isPidAlive(heartbeatPid)) {
          try {
            process.kill(heartbeatPid, 'SIGKILL');
          } catch {
            // 既に居ない。何もしない。
          }
        }
      }
    },
  );

  it(
    '(e): SIGTERM を無視する孫も、猶予（DEADLINE_KILL_GRACE_MS）の後の SIGKILL で止まる——' +
      '直接の子（偽の vitest）が SIGTERM で先に閉じても、SIGKILL を取り消さない',
    async () => {
      const { binDir } = await makeFakeVitestBin();
      const heartbeatFile = join(binDir, '..', 'heartbeat.log');
      const pidFile = join(binDir, '..', 'heartbeat.pid');

      const result = spawnSync('node', [TEST_MJS_PATH, '--deadline-seconds=1'], {
        cwd: ROOT_DIR,
        env: {
          PATH: binDir + ':' + (process.env.PATH ?? ''),
          FAKE_VITEST_HEARTBEAT_FILE: heartbeatFile,
          FAKE_VITEST_PIDFILE: pidFile,
          FAKE_HEARTBEAT_IGNORE_TERM: '1',
        },
        stdio: 'pipe',
        encoding: 'utf8',
        // 締め切り(1s) + 猶予(3s) + 余裕。
        timeout: 15000,
      });

      let heartbeatPid: number | undefined;
      try {
        heartbeatPid = Number(await readFile(pidFile, 'utf8'));
        expect(Number.isInteger(heartbeatPid)).toBe(true);
        expect(result.status, result.stdout + '\n---stderr---\n' + result.stderr).toBe(
          EXIT_DEADLINE,
        );
        // 偽の vitest（直接の子）は SIGTERM で即座に死ぬので、`close` は猶予より前に来る。
        // そこで SIGKILL のタイマーを取り消すと、SIGTERM を無視した孫が生き残る。
        const died = await waitUntilPidDead(heartbeatPid, 1000);
        expect(
          died,
          `SIGTERM を無視する孫（pid=${heartbeatPid}）が、猶予の後も生きている——` +
            '直接の子が閉じた時点で SIGKILL を取り消している疑いがある',
        ).toBe(true);
      } finally {
        if (heartbeatPid !== undefined && isPidAlive(heartbeatPid)) {
          try {
            process.kill(heartbeatPid, 'SIGKILL');
          } catch {
            // 既に居ない。何もしない。
          }
        }
      }
    },
  );

  it('(d): --deadline-seconds を指定しなければ、偽の vitest の exit code がそのまま返る', async () => {
    const { binDir } = await makeFakeVitestBin();

    const result = spawnSync('node', [TEST_MJS_PATH], {
      cwd: ROOT_DIR,
      env: {
        PATH: binDir + ':' + (process.env.PATH ?? ''),
        // 孫を起こさせず、即座にこの値で終わらせる（分岐(1)）。
        FAKE_VITEST_EXIT_CODE: '37',
      },
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 15000,
    });

    expect(result.status, result.stdout + '\n---stderr---\n' + result.stderr).toBe(37);
    // 打ち切りの1行は出ない——締め切りが無いのでその経路自体を通らない。
    expect(result.stdout).not.toContain('test-guard: --deadline-seconds');
  });

  it('不正な --deadline-seconds は vitest を起こす前に断る（EXIT_BAD_DEADLINE）', async () => {
    // 偽の vitest すら要らない——`extractDeadlineSeconds` が argv だけで断る
    // 経路を、実際のラッパ呼び出しとして確かめる（純粋関数の歯は
    // test-guard-core.test.ts に既にあるが、ここでは「vitest を1回も
    // 起こしていない」ところまで見る）。
    const { binDir } = await makeFakeVitestBin();
    const heartbeatFile = join(binDir, '..', 'heartbeat-unused.log');
    const pidFile = join(binDir, '..', 'heartbeat-unused.pid');

    const result = spawnSync('node', [TEST_MJS_PATH, '--deadline-seconds=0'], {
      cwd: ROOT_DIR,
      env: {
        PATH: binDir + ':' + (process.env.PATH ?? ''),
        FAKE_VITEST_HEARTBEAT_FILE: heartbeatFile,
        FAKE_VITEST_PIDFILE: pidFile,
      },
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 15000,
    });

    expect(result.status).toBe(EXIT_BAD_DEADLINE);
    // vitest（偽物）は1回も起こされていない ⟹ pid ファイルが作られていない。
    expect(existsSync(pidFile)).toBe(false);
  });
});
