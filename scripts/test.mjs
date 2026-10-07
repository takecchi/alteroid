#!/usr/bin/env node
// vitest の外で走らせる: 判別器を vitest のテストや `setupFiles` に置くと、`.skip` で判別器自身が黙らされるため。
// 出力は data イベントのたびに素通しで書く: 最後にまとめて出すと、変異試験ハーネスが `spawnSync` で待つ形と食い合わさって壊れやすいため。
// 素の `--` は `dropBareDashDash` で落とす: pnpm が `--` ごと渡し、vitest は `--` より後ろを読まないため、絞り込みが効かずスイート全体が走るため。
// 範囲は位置引数ではなく named 引数（`--scope`）で渡す: vitest の位置引数は OR で効き、利用者が足した位置引数と範囲の両方がフィルタになってパッケージ全体が走るため。
//
// 使い方: `pnpm test -- --deadline-seconds=<n> ...`（1以上の整数の秒。vitest へは渡さない）
// 締め切りは外側の `timeout` に頼らず自前で持つ: GNU `timeout` は時間切れでパイプの読み手（`| grep` 等）にも SIGTERM を送り、出力も「打ち切られた」ことも残らないため。
// 締め切りがあるときだけ `detached: true` にする: 締め切りが無い回で `detached` にすると、子が新しいプロセスグループに移り、Ctrl-C の SIGINT が子に届かなくなるため。
// 打ち切りの SIGTERM は子1つ（`child.pid`）ではなくプロセスグループ全体へ送る: vitest が fork した worker まで止めるため。

import { spawn } from 'node:child_process';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

import {
  EXIT_DEADLINE,
  ROOT,
  dropBareDashDash,
  extractDeadlineSeconds,
  formatDeadlineMessage,
  judgeExecution,
  resolveReporterArgs,
  resolveScopedArgs,
  runObservationGuard,
  runStaticSkipGuard,
} from './test-guard-core.mjs';

const DEADLINE_KILL_GRACE_MS = 3000;

function runVitest(args, { deadlineSeconds } = {}) {
  return new Promise((resolve, reject) => {
    const hasDeadline = deadlineSeconds !== undefined;
    const spawnOptions = {
      cwd: process.cwd(),
      stdio: ['inherit', 'pipe', 'pipe'],
    };
    if (hasDeadline) {
      spawnOptions.detached = true;
    }

    const child = spawn('vitest', ['run', ...args], spawnOptions);

    let combined = '';
    let deadlineHit = false;
    let deadlineTimer;
    let killTimer;
    let forwardSignal;

    const clearDeadlineTimers = () => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };

    const stopForwardingSignals = () => {
      if (forwardSignal === undefined) return;
      process.removeListener('SIGINT', forwardSignal);
      process.removeListener('SIGTERM', forwardSignal);
    };

    const killGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // 既に居ない。何もしない。
      }
    };

    if (hasDeadline) {
      deadlineTimer = setTimeout(() => {
        deadlineHit = true;
        killGroup('SIGTERM');
        killTimer = setTimeout(() => {
          killGroup('SIGKILL');
        }, DEADLINE_KILL_GRACE_MS);
      }, deadlineSeconds * 1000);

      forwardSignal = (signal) => killGroup(signal);
      process.on('SIGINT', forwardSignal);
      process.on('SIGTERM', forwardSignal);
    }

    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      combined += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      combined += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearDeadlineTimers();
      stopForwardingSignals();
      reject(err);
    });
    child.on('close', (code, signal) => {
      // 打ち切った回は `SIGKILL` のタイマーを取り消さない: `SIGTERM` を無視する孫が残っていると、猶予の後の `SIGKILL` でしか止まらないため。
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (!deadlineHit && killTimer !== undefined) clearTimeout(killTimer);
      stopForwardingSignals();
      resolve({ code, signal, combined, deadlineHit });
    });
  });
}

async function main() {
  const rawArgs = dropBareDashDash(process.argv.slice(2));

  // `--deadline-seconds` は `--scope` の位置引数判定より前に取り除く: 空白区切りの値（`300` など）が利用者の位置引数と取り違えられないため。
  const deadline = extractDeadlineSeconds(rawArgs);
  if (!deadline.ok) {
    process.stderr.write(`\n${deadline.message}\n`);
    process.exitCode = deadline.exitCode;
    return;
  }
  const args = deadline.rest;

  // 範囲外・範囲内に一致が無い位置引数は vitest へ渡す前に断る: 渡すと「一致なし」で静かに空振りするだけで、範囲外だと分かる材料が出ないため。
  const scoped = await resolveScopedArgs(args, { cwd: process.cwd(), repoRoot: ROOT });
  if (!scoped.ok) {
    process.stderr.write(`\n${scoped.message}\n`);
    process.exitCode = scoped.exitCode;
    return;
  }

  const reportedArgs = resolveReporterArgs(scoped.args, {
    CLAUDECODE: process.env.CLAUDECODE,
  });
  const { code, combined, deadlineHit } = await runVitest(reportedArgs, {
    deadlineSeconds: deadline.deadlineSeconds,
  });

  if (deadlineHit) {
    process.stdout.write(`\n${formatDeadlineMessage(deadline.deadlineSeconds)}\n`);
    process.exitCode = EXIT_DEADLINE;
    return;
  }

  if (code !== 0) {
    // vitest の exit code をそのまま返す: 歯A/歯Bの exit code と混ざらないため。signal で殺されて `code` が null のときも 0 にしない。
    process.exitCode = code ?? 1;
    return;
  }

  const executionJudgement = judgeExecution(combined);
  if (!executionJudgement.ok) {
    process.stderr.write(`\n${executionJudgement.message}\n`);
    process.exitCode = executionJudgement.exitCode;
    return;
  }

  const staticJudgement = await runStaticSkipGuard(ROOT);
  if (!staticJudgement.ok) {
    process.stderr.write(`\n${staticJudgement.message}\n`);
    process.exitCode = staticJudgement.exitCode;
    return;
  }

  const observationJudgement = await runObservationGuard(ROOT);
  if (!observationJudgement.ok) {
    process.stderr.write(`\n${observationJudgement.message}\n`);
    process.exitCode = observationJudgement.exitCode;
    return;
  }

  process.exitCode = 0;
}

main().catch((err) => {
  process.stderr.write(`test-guard: ラッパ自身が例外で落ちた: ${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
