import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { captureStderr } from './testing.js';
import { installUncaughtNet } from './uncaught-net.js';

const run = promisify(execFile);

/**
 * ここで固定するのは2つで、**2つ目のほうが重い。**
 *
 * 1. 跡が出ること・**その跡に本文が乗らないこと**（`dropped-record.test.ts` と同じ線）
 * 2. **⭐ 網を張っても、未捕捉の例外でプロセスが今日どおり死ぬこと**
 *
 * 2つ目が無いと、この設計は次に触る人が壊せる。`uncaughtExceptionMonitor` を
 * `uncaughtException` へ書き換えるのは1語の変更だが、**その瞬間に既定の終了が
 * 止まり、器が「壊れた」と判定できる唯一の材料（プロセスの終了）が消える**
 * （`railway/*.json` に `healthcheckPath` は無い）。1つ目のテストはその書き換えでも
 * 緑のままなので、**歯として効かない。**
 */
describe('未捕捉の例外の網（#438）', () => {
  const secret = 'ghp_000000000000000000000000000000000000';

  it('出所（origin）ごとに違う文言で、接頭辞つきの1行だけ残す', async () => {
    const uninstall = installUncaughtNet('alteroidd');
    try {
      const lines = await captureStderr(() => {
        process.emit(
          'uncaughtExceptionMonitor',
          new Error(`鍵は ${secret} だった`),
          'uncaughtException',
        );
        process.emit(
          'uncaughtExceptionMonitor',
          new Error(`鍵は ${secret} だった`),
          'unhandledRejection',
        );
      });

      expect(lines).toHaveLength(2);
      const [thrown, rejected] = lines as [string, string];

      // 接頭辞が付く。**Node 既定のスタックには付かないので、これが grep の当たりになる。**
      expect(thrown.startsWith('alteroidd: ')).toBe(true);
      expect(rejected.startsWith('alteroidd: ')).toBe(true);

      // **origin ごとに違う文言。** 同じ文を当てると跡そのものが取り違えさせる。
      expect(thrown).toContain('未捕捉の例外を観測しました');
      expect(rejected).toContain('未処理の Promise 拒否を観測しました');
      expect(thrown).not.toContain('未処理の Promise 拒否');
      expect(rejected).not.toContain('未捕捉の例外');

      for (const line of lines) {
        expect(line.endsWith('\n')).toBe(true);
      }

      // **「落ちます」と書かない。** monitor は、誰かが `uncaughtException` を
      // 登録していれば落ちないまま発火する（`dropped-record.ts` の doc）。
      for (const line of lines) {
        expect(line).not.toContain('落ち');
      }
    } finally {
      uninstall();
    }
  });

  /**
   * **`reasonOf` が実際に持っている守りを固定する。**
   *
   * 「本文を出さない」という言い方はここでは正しくない —— 例外の `message` その
   * ものが理由なので、`reasonOf` はそれを出す（`dropped-record.ts` の doc）。
   * **効いているのは「1行目だけ」と「200字」の2つ**で、1つ目はドライバが**次の行**へ
   * 添えてくる束縛パラメータを落とす（`reasonOf` の doc に実測が在る）。**そこが
   * 落ちることを見る。**
   */
  it('理由は1行目だけ・200字で切る（2行目に添えられた値は跡へ出さない）', async () => {
    const uninstall = installUncaughtNet('alteroidd');
    try {
      const lines = await captureStderr(() => {
        process.emit(
          'uncaughtExceptionMonitor',
          new Error(`Failed query: select 1\nparams: ${secret}`),
          'uncaughtException',
        );
        process.emit('uncaughtExceptionMonitor', new Error('x'.repeat(500)), 'uncaughtException');
      });

      const [twoLine, long] = lines as [string, string];
      // 2行目に添えられた値は跡へ出ない。
      expect(twoLine).toContain('Failed query: select 1');
      expect(twoLine).not.toContain(secret);
      // 1行に収まる（跡の口は1行である）。
      expect(twoLine.trimEnd()).not.toContain('\n');
      // 200字で切られている。
      expect(long).toContain('…');
      expect(long.length).toBeLessThan(400);
    } finally {
      uninstall();
    }
  });

  it('外す関数を呼べば listener が残らない', () => {
    const before = process.listenerCount('uncaughtExceptionMonitor');
    const uninstall = installUncaughtNet('alteroidd');
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(before + 1);
    uninstall();
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(before);
  });

  /**
   * **子プロセスで本物の未捕捉例外を起こす。**
   *
   * `dist` を読むのは、素の node に `.ts` を食わせられないからである（Node の
   * 型剥がしは `./x.js` の指定を `./x.ts` へ読み替えない）。**この repo は
   * build → typecheck → test の順が前提**（`scripts/verify-core.mjs` の `STEPS`、
   * `AGENTS.md`「開発手順」）なので、テストの時点で `dist` は在る。
   *
   * **⚠️ ここが見ているのは `dist` である。** `src` だけを直して build せずに
   * このテストだけ回すと、**古い `dist` に対して緑が出る。** 一式（`pnpm verify`）
   * を通すこと。
   */
  it('網を張っても、未捕捉の例外では今日どおりプロセスが死ぬ（既定のスタックごと）', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const entry = join(here, '..', 'dist', 'index.js');
    const child = [
      `import { installUncaughtNet } from ${JSON.stringify(entry)};`,
      `installUncaughtNet('alteroidd');`,
      `setImmediate(() => { throw new Error('boom-from-child'); });`,
    ].join('\n');

    const failure = await run(process.execPath, ['--input-type=module', '-e', child]).then(
      () => null,
      (error: unknown) => error as { code?: number; stderr?: string },
    );

    // (a) 死ぬ。**`null` ではなく数の 0 以外**であること（signal で殺された形と混ぜない）。
    expect(failure).not.toBeNull();
    expect(failure?.code).toBe(1);

    const stderr = failure?.stderr ?? '';
    // (b) Node 既定のスタックがそのまま出ている（この網はそれを止めない）。
    expect(stderr).toContain('Error: boom-from-child');
    expect(stderr).toMatch(/\n\s+at /u);
    // (c) こちらの1行も出ている。
    expect(stderr).toContain('alteroidd: ');
    expect(stderr).toContain('未捕捉の例外を観測しました');
  });
});
