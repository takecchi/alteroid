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

// フィクスチャの制御は引数ではなく env で行う: `--deadline-seconds` の argv 解析にフィクスチャ制御用の引数を紛れ込ませないため。
// 子の env は `PATH` とフィクスチャ専用の3変数だけにする: 親の環境の機微な変数を子へ渡さないため。
describe('scripts/test.mjs --deadline-seconds（統合: 偽の vitest を子として起こす）', () => {
  const ROOT_DIR = join(import.meta.dirname, '..');
  const TEST_MJS_PATH = join(import.meta.dirname, 'test.mjs');

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

  function isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

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
        // 'inherit' にしない: vitest.setup.ts の歯が本物の stdout への直書きを赤にするため、必ず 'pipe' で受ける。
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 15000,
      });

      let heartbeatPid: number | undefined;
      try {
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

        expect(result.status, result.stdout + '\n---stderr---\n' + result.stderr).toBe(
          EXIT_DEADLINE,
        );

        expect(result.stdout).toContain(formatDeadlineMessage(1));

        const died = await waitUntilPidDead(heartbeatPid, 1000);
        expect(
          died,
          `孫プロセス（pid=${heartbeatPid}）が締め切り後も生きている——` +
            'プロセスグループ全体ではなく、子1つだけを kill している疑いがある',
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
        timeout: 15000,
      });

      let heartbeatPid: number | undefined;
      try {
        heartbeatPid = Number(await readFile(pidFile, 'utf8'));
        expect(Number.isInteger(heartbeatPid)).toBe(true);
        expect(result.status, result.stdout + '\n---stderr---\n' + result.stderr).toBe(
          EXIT_DEADLINE,
        );
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
        FAKE_VITEST_EXIT_CODE: '37',
      },
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 15000,
    });

    expect(result.status, result.stdout + '\n---stderr---\n' + result.stderr).toBe(37);
    expect(result.stdout).not.toContain('test-guard: --deadline-seconds');
  });

  it('不正な --deadline-seconds は vitest を起こす前に断る（EXIT_BAD_DEADLINE）', async () => {
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
    expect(existsSync(pidFile)).toBe(false);
  });
});
