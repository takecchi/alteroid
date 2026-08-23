#!/usr/bin/env node
/**
 * `pnpm test` / `pnpm --filter <pkg> test` の入り口。**vitest を直呼びしない
 * ラッパ**（#311）。
 *
 * 判定そのものは `test-guard-core.mjs` に置く。ここは「vitest を起こし、出力を
 * 素通しし、判定を呼んで exit code を決める」だけの薄い層（`verify.mjs` /
 * `verify-core.mjs` と同じ分け方）。
 *
 * ## なぜ vitest の外に置くのか
 *
 * `describe.skip` / `it.skip` は vitest の**中**の仕組みである。判別器を
 * vitest のテストや `setupFiles` に置くと、判別器自身が `.skip` で黙らされ
 * うる。ここ（`scripts/test.mjs`）は vitest の外側で走る素の node プロセス
 * なので、`.skip` は届かない。
 *
 * ## 出力は素通し（stream する。最後にまとめて出さない）
 *
 * 変異試験ハーネス（`.claude/skills/mutation-testing/mutate-core.mjs` の
 * `runTests`）は `pnpm test --maxWorkers=<n>` を呼び、その出力から
 * `Test Files` / `Tests` の行を読む。ここでまとめて出す（バッファに溜めて
 * 最後に一括 write する）と、途中経過が消えるだけでなく、ハーネス側が
 * `spawnSync` で待つ形と食い合わさったときに壊れやすい。**data イベントの
 * たびにそのまま `process.stdout` / `process.stderr` へ書く。**
 *
 * ## 引数は全部素通し
 *
 * `process.argv.slice(2)` をそのまま `vitest run` の後ろへ渡す。
 * `pnpm test --maxWorkers=4` も `pnpm test <パスの一部>` も
 * `pnpm test --reporter=verbose` も、これまでどおり動く。
 *
 * ## exit code（5値。混ぜない）
 *
 * | 出所                      | 意味                                             |
 * | ------------------------- | ------------------------------------------------ |
 * | vitest 自身の exit code   | **飲み込まない。そのまま返す**（`code !== 0`）    |
 * | `EXIT_ZERO_PASSED`（2）   | 歯A: 集計行はあるが passed が0                    |
 * | `EXIT_UNKNOWN`（3）       | 歯A: 集計行そのものが出ていない（判定できない）    |
 * | `EXIT_STATIC_SKIP`（4）   | 歯B: 無条件の静的 skip を検出                      |
 * | `EXIT_SCAN_EMPTY`（5）    | 歯B: 走査対象が0ファイル（判定できない）           |
 *
 * 歯A/歯Bは vitest が exit 0 を返した後にしか判定しない。**vitest が非0で
 * 落ちたら、ラッパの検査は一切走らせず、その exit code をそのまま返す**
 * （「自分の検査は通った」で上書きしない）。**ラッパ自身が例外で落ちたときも
 * exit 0 にはならない**（末尾の `main().catch(...)` が exit code 1 で拾う。
 * 緑を名乗る経路を1本も作らない）。
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

import { ROOT, judgeExecution, runStaticSkipGuard } from './test-guard-core.mjs';

/** vitest を起こし、標準出力・標準エラーを素通ししながら溜める。 */
function runVitest(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('vitest', ['run', ...args], {
      cwd: process.cwd(),
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let combined = '';

    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      combined += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      combined += chunk.toString('utf8');
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code, signal) => {
      resolve({ code, signal, combined });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const { code, combined } = await runVitest(args);

  if (code !== 0) {
    // vitest 自身が落ちた（signal で殺された場合 code は null になる。その場合も
    // 「自分の検査は通った」で上書きせず、非0（1）を返す — signal は正常終了
    // ではない）。歯A/歯Bの exit code と混ざらないよう、vitest の判定をそのまま返す。
    process.exitCode = code ?? 1;
    return;
  }

  // ここから先は vitest が exit 0 を返した後だけ ＝ 歯A→歯Bの出番。
  const executionJudgement = judgeExecution(combined);
  if (!executionJudgement.ok) {
    process.stderr.write(`\n${executionJudgement.message}\n`);
    process.exitCode = executionJudgement.exitCode;
    return;
  }

  // 歯B: 走査対象0ファイル／無条件skip検出／合格の3値。ROOT からの
  // フルスキャンなので、どの絞り込みで pnpm test を打っても同じ判定になる。
  const staticJudgement = await runStaticSkipGuard(ROOT);
  if (!staticJudgement.ok) {
    process.stderr.write(`\n${staticJudgement.message}\n`);
    process.exitCode = staticJudgement.exitCode;
    return;
  }

  process.exitCode = 0;
}

main().catch((err) => {
  // ラッパ自身がここで何を起こしても、緑（exit 0）を名乗る経路を作らない。
  process.stderr.write(`test-guard: ラッパ自身が例外で落ちた: ${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
