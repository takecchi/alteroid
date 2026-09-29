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
 * ## 引数は素の `--` を除いて全部素通し
 *
 * `process.argv.slice(2)` を `vitest run` の後ろへ渡す。ただし素の `--`
 * （文字列としてちょうど `'--'` の要素）だけは、渡す前に
 * `test-guard-core.mjs` の `dropBareDashDash` で落とす。
 *
 * **なぜ落とすのか。** pnpm は `pnpm test -- --maxWorkers=4 a.test.ts` と
 * 打つと `--` をそのままここへ渡してくる。落とさずに足すと vitest 側は
 * `vitest run -- --maxWorkers=4 a.test.ts` を受け取るが、**vitest は `--`
 * より後ろをフィルタとしても option としても読まない**ため絞り込みが1つも
 * 効かず、スイート全体が走る（実測 2026-09-24T01:05:57Z、`pnpm test --
 * --maxWorkers=4 <4ファイル>` で `Test Files 343 passed (343)` が出た。343
 * は絞ったつもりの4ファイルではなく当時のリポジトリ全体の件数）。
 * `pnpm verify` はこの形を `verify-core.mjs` の `splitVerifyArgs` で既に
 * 塞いでいる（`grep -Fn -- "arg === '--'" scripts/verify-core.mjs`）ので、
 * ここも同じ規則に揃える。
 *
 * **`--` 以外は変えない。** `pnpm test --maxWorkers=4` も
 * `pnpm test <パスの一部>` も `pnpm test --reporter=verbose` も、
 * `pnpm test -- --maxWorkers=4 a.test.ts`（`--` を落とした残り）も、
 * これまでどおり動く。
 *
 * ## パッケージの範囲は named 引数（`--scope`）で受け取る（#1691）
 *
 * 各ワークスペースの `test` script（例: `apps/cli`）は
 * `node ../../scripts/test.mjs --root=../.. --scope=apps/cli/src` の形で、
 * パッケージの範囲を**named 引数**として渡す。**以前は範囲を位置引数として
 * 渡していた**（`node ../../scripts/test.mjs --root=../.. apps/cli/src`）。
 * vitest の位置引数は **OR** で効くため、利用者が `pnpm test -- <file>` で
 * 足した位置引数と範囲の位置引数が両方フィルタとして働き、範囲（＝パッケージ
 * 全体）のほうが常に一致してスイート全体が走っていた（`cd apps/cli && pnpm
 * test -- src/interrupt.test.ts` が1本ではなくパッケージ全体を走らせる形。
 * Issue #1691）。
 *
 * `test-guard-core.mjs` の `resolveScopedArgs` がこの分岐を持つ——`--scope` が
 * 無ければ何もしない（root の `pnpm test <パスの一部>` は影響を受けない）。
 * `--scope` は在るが利用者の位置引数が無ければ、範囲そのものが唯一のフィルタ
 * になる（旧来の既定と同じ、パッケージ全体を走らせる）。**両方在れば**、
 * 各位置引数を、範囲の中のテストファイル一覧に対する**部分一致**で解決する
 * （vitest の位置引数自体が「パス」ではなく部分一致だから——`path.resolve` で
 * パスとして直すだけでは `pnpm test -- manager-detail` のような部分一致の
 * 打ち方を範囲外として誤って断ってしまう。実測は PR 本文）。一致が0件なら、
 * 黙って全体を走らせたり0本で緑を名乗ったりせず断る（打ったものが `cwd` の
 * 外を明らかに指しているか、`cwd` の中だが範囲に一致が無いか、で理由を書き
 * 分ける）。詳細と実測（`INIT_CWD` ではなく `process.cwd()` を基準にする理由
 * も含む）は `matchScopedPositionals` / `resolveScopedArgs` の doc に在る。
 *
 * ## exit code（10値。混ぜない）
 *
 * | 出所                                | 意味                                             |
 * | ----------------------------------- | ------------------------------------------------ |
 * | vitest 自身の exit code             | **飲み込まない。そのまま返す**（`code !== 0`）    |
 * | `EXIT_ZERO_PASSED`（2）             | 歯A: 集計行はあるが passed が0                    |
 * | `EXIT_UNKNOWN`（3）                 | 歯A: 集計行そのものが出ていない（判定できない）    |
 * | `EXIT_STATIC_SKIP`（4）             | 歯B: 無条件の静的 skip を検出                      |
 * | `EXIT_SCAN_EMPTY`（5）              | 歯B/歯C: 走査対象が0ファイル（判定できない）       |
 * | `EXIT_OBSERVATION_UNDECLARED`（6）  | 歯C: 観測用テストの終了条件／見直し期限が無い、または書式が壊れている |
 * | `EXIT_OBSERVATION_DUE`（7）         | 歯C: 観測用テストの見直し期限を過ぎた              |
 * | `EXIT_SCOPE_VIOLATION`（8）         | `--scope` の範囲外を指す位置引数、または範囲の中に部分一致するテストが無い位置引数を検出（#1691） |
 * | `EXIT_BAD_DEADLINE`（9）            | `--deadline-seconds` の値が不正（1以上の整数でない） |
 * | `EXIT_DEADLINE`（10）               | `--deadline-seconds` の締め切りに達し、vitest を打ち切った |
 *
 * `EXIT_SCOPE_VIOLATION` / `EXIT_BAD_DEADLINE` は vitest を起こす**前**に判定する
 * （範囲外・一致無しのパスや、不正な締め切りの値を vitest へ渡してもエラーには
 * ならず静かに空振りするだけなので、vitest 側の判定に委ねられない）。歯A/歯B/歯Cは
 * vitest が exit 0 を返した後にしか判定しない。**vitest が非0で落ちたら、ラッパの
 * 検査は一切走らせず、その exit code をそのまま返す**（「自分の検査は通った」で
 * 上書きしない）。**締め切りに達して打ち切った回（`EXIT_DEADLINE`）も同じ扱い**——
 * 歯A/歯B/歯Cの判定は一切走らせない（下の「締め切り」節）。
 * **ラッパ自身が例外で落ちたときも exit 0 にはならない**（末尾の
 * `main().catch(...)` が exit code 1 で拾う。緑を名乗る経路を1本も作らない）。
 *
 * ## 既定の reporter（`CLAUDECODE`——Claude Code の Bash ツール経由——のときだけ dot）
 *
 * **なぜ足すか。** 作業者（AI）がテストを回すと、vitest 既定の reporter
 * （`default`）の出力が大きくなり、道具が「大きな出力は保存ファイルへ回す」形へ
 * 落とすことがある。作業者がその保存ファイルを読もうとして拒否で止まる、という
 * 事故が実際に複数回起きた（AGENTS.md には書かない——道具の癖であってこの
 * スクリプトの正本はここ）。**`--reporter=dot` は `Test Files` / `Tests` の
 * 集計行と、落ちたテストの詳細（どのテストがなぜ落ちたか）はそのまま出しつつ、
 * 通ったテスト1本ごとの行を出さない**ので、出力が小さくなる。
 *
 * **⚠️ 最初の版（TTY でない・CI 未設定の2条件）は狙った相手に効かなかった。**
 * この器（Claude Code の Bash ツール）は非TTY のまま `CI=true` を既定で
 * 環境に持つ（実測、観測 2026-09-29）ため、作業者がこの Bash ツール経由で
 * 打つ `pnpm test` こそが CI 判定で毎回弾かれていた。**条件は
 * `CLAUDECODE`（Claude Code が子プロセスへ注ぐ環境変数）が設定されている
 * ことへ変えた**——人間が端末で直接打つときにも、GitHub Actions の
 * runner にも無い（詳細・実測は `test-guard-core.mjs` の
 * `resolveReporterArgs` の doc）。
 *
 * **足す条件は2つとも揃ったときだけ**（`test-guard-core.mjs` の
 * `resolveReporterArgs`）——利用者が `--reporter` を明示していない・
 * `CLAUDECODE` が設定されている。**人間が端末で直接打つときと GitHub
 * Actions は、いままでどおり vitest 既定の reporter のまま**——見た目を
 * 変えるのは「Claude Code の Bash ツール経由の実行」だけに絞ってある。
 *
 * **変異試験ハーネスは影響を受けない。** `.claude/skills/mutation-testing/
 * mutate-core.mjs` は `pnpm test` を呼ぶときに `--reporter=default` を明示するので
 * `hasReporterFlag` が真になり、この歯は素通りする。
 *
 * 判定は `resolveScopedArgs` の**後**に掛ける——`--scope` の位置引数判定に
 * `--reporter=dot` を混ぜないため（この歯が足す形も `--reporter` も、どちらも
 * 位置引数としては読まれない `VALUE_TAKING_FLAGS` 対応の形なので、実害は無いが、
 * 順序を固定して依存の向きを明示する）。
 *
 * ## `--deadline-seconds=<n>`（外側の `timeout` に頼らない締め切り）
 *
 * **なぜ足すか（実測、マネージャーが2026-09-29T07:0xZ にこの器で確認した）**。
 * GNU coreutils 9.7 の `timeout` は、時間切れのときに**パイプの読み手にも
 * SIGTERM を送る**:
 *
 * ```
 * $ timeout 3 sleep 10 | (trap 'echo "reader got TERM" >> .scratch/reader.log' TERM; cat; echo "reader EOF ok" >> .scratch/reader.log; echo visible); echo "EXIT:${PIPESTATUS[*]}"
 * Terminated
 * visible
 * EXIT:124 0
 * （.scratch/reader.log: reader got TERM / reader EOF ok）
 * $ timeout 3 sleep 10 | cat; echo "EXIT:${PIPESTATUS[*]}"
 * Terminated
 * EXIT:124 143
 * $ timeout --foreground 3 sleep 10 | (cat; echo "reader-alive-after-eof"); echo "EXIT:${PIPESTATUS[0]}"
 * reader-alive-after-eof
 * EXIT:124
 * ```
 *
 * ⟹ 作業者がよく打つ `timeout 590 pnpm test … 2>&1 | grep -E 'Test Files|…'` は、
 * 打ち切られると `grep` ごと殺され、それまでの出力も「打ち切られた」ことも
 * 1行も残らない（無出力のまま `EXIT:124` だけが返る）。`--foreground` を足せば
 * パイプの読み手は生き残るが、それは呼び出し側が毎回 `timeout` の引数を選び
 * 直すことに賭ける形であって、`test.mjs` の側では直せない。
 *
 * **だから `test.mjs` 自身が締め切りを持ち、打ち切ったことを（パイプの読み手を
 * 巻き込む前に）自分の stdout へ1行書き切ってから終わる。**
 *
 * ### 使い方
 *
 * ```
 * pnpm test -- --deadline-seconds=300 --maxWorkers=2 --reporter=dot
 * ```
 *
 * 値は1以上の整数（秒）。`--deadline-seconds=<n>`（`=` 形）・
 * `--deadline-seconds <n>`（空白区切り）のどちらでも受け付ける
 * （`test-guard-core.mjs` の `extractDeadlineSeconds`）。**vitest へは渡さない**
 * ——vitest 自身はこの引数を知らない。値が不正（0・負・小数・非数）なら
 * vitest を起こす**前**に `EXIT_BAD_DEADLINE`（9）で断る。
 *
 * ### 打ち切りの形
 *
 * 締め切りがあるときだけ、vitest を**自分のプロセスグループのリーダー**として
 * 起こす（`detached: true`）。締め切りに達したら、まず子の**プロセスグループ
 * 全体**へ `SIGTERM`（`process.kill(-child.pid, 'SIGTERM')`）を送り、
 * `DEADLINE_KILL_GRACE_MS` だけ待ってもまだ生きていれば `SIGKILL` を送る。
 * **子1つだけ（`child.pid`）に送らない**——vitest がさらに fork した worker
 * まで含めて止めるには、グループ全体へ送る必要がある。
 *
 * **締め切りが無いときの挙動は1文字も変えない。** `detached` にはしない
 * （人間が Ctrl-C を打ったときの効き方が変わってしまう——`detached: true` で
 * 起こすと子は自分だけの新しいプロセスグループに移り、端末が送る Ctrl-C の
 * `SIGINT` は元のプロセスグループにしか届かず、子が置き去りになる）。
 * **締め切りがあるときだけ**、ラッパ自身が受けた `SIGINT` / `SIGTERM` を
 * 子のプロセスグループへ転送する（`detached` にしたことで生まれた「Ctrl-C が
 * 子に届かない」穴を、締め切りがある回に限って埋め合わせる）。
 *
 * 打ち切ったら、**歯A/歯B/歯Cの判定は一切走らせない**（vitest が0以外で
 * 終わった回と同じ扱い——集計行が「出ていない」のか「途中で切れて壊れている」
 * のかを判定できないため）。stdout に必ず1行出す
 * （`test-guard-core.mjs` の `formatDeadlineMessage`）:
 *
 * ```
 * test-guard: --deadline-seconds=5 で打ち切った（vitest が 5 秒で終わらなかった）。
 * 集計行は出ていない——通ったのでも落ちたのでもない。分けて回す: .claude/skills/test-in-chunks/SKILL.md
 * ```
 *
 * exit code は `EXIT_DEADLINE`（10）。
 *
 * `--scope` の位置引数判定より前に締め切りを取り除く（`main()` の順序）——
 * `--deadline-seconds 300`（空白区切り）の値 `300` が、範囲判定の側で
 * 利用者の位置引数と取り違えられないようにするため。
 */

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

/** SIGTERM を送ってから、まだプロセスグループが生きていれば SIGKILL するまでの
 * 猶予（ms）。締め切りがあるとき（`deadlineSeconds` が指定されたとき）だけ使う。 */
const DEADLINE_KILL_GRACE_MS = 3000;

/** vitest を起こし、標準出力・標準エラーを素通ししながら溜める。
 *
 * `deadlineSeconds` を渡したときだけ、締め切りの機構を有効にする
 * （`test.mjs` 冒頭の doc「`--deadline-seconds=<n>`」を見よ）——
 * `detached: true` で起こし、締め切りに達したら子のプロセスグループ全体へ
 * `SIGTERM` を送り、`DEADLINE_KILL_GRACE_MS` 待って生きていれば `SIGKILL`。
 * ラッパ自身が受けた `SIGINT`/`SIGTERM` も同じグループへ転送する。
 *
 * `deadlineSeconds` が `undefined`（＝ `--deadline-seconds` 未指定）のときは、
 * 締め切り導入前と1文字も違わない——`detached` を付けず、シグナルの転送も
 * 一切しない（人間の Ctrl-C の効き方を変えないため）。
 */
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

    /** グループ全体へ送る。子（またはそのグループ）が既に居なければ無視する
     * （`ESRCH`）——打ち切りの最中に子が自然終了する競合は珍しくない。 */
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
      clearDeadlineTimers();
      stopForwardingSignals();
      resolve({ code, signal, combined, deadlineHit });
    });
  });
}

async function main() {
  const rawArgs = dropBareDashDash(process.argv.slice(2));

  // `--deadline-seconds` は `--scope` の位置引数判定より前に取り除く——
  // 空白区切りの値（例: `--deadline-seconds 300` の `300`）が範囲判定の側で
  // 利用者の位置引数と取り違えられないようにするため（冒頭の doc）。
  const deadline = extractDeadlineSeconds(rawArgs);
  if (!deadline.ok) {
    process.stderr.write(`\n${deadline.message}\n`);
    process.exitCode = deadline.exitCode;
    return;
  }
  const args = deadline.rest;

  // #1691: `--scope` の範囲外・範囲内に部分一致するテストが無い位置引数は、
  // vitest へ渡す前に断る（渡すと「一致なし」で静かに空振りするだけで、
  // 範囲外だと分かる材料が出ない）。
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
    // 打ち切った回は、vitest が非0で終わった回と同じ扱い——歯A/歯B/歯Cの
    // 判定は一切走らせない（直下の `code !== 0` の分岐と同じ理由）。
    process.stdout.write(`\n${formatDeadlineMessage(deadline.deadlineSeconds)}\n`);
    process.exitCode = EXIT_DEADLINE;
    return;
  }

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

  // 歯C: 観測用テストの見直し期限（#396）。走査対象0ファイル／申告不備／
  // 期限超過／合格の4値。today はここでだけ現在時刻から作る（既定引数）。
  const observationJudgement = await runObservationGuard(ROOT);
  if (!observationJudgement.ok) {
    process.stderr.write(`\n${observationJudgement.message}\n`);
    process.exitCode = observationJudgement.exitCode;
    return;
  }

  process.exitCode = 0;
}

main().catch((err) => {
  // ラッパ自身がここで何を起こしても、緑（exit 0）を名乗る経路を作らない。
  process.stderr.write(`test-guard: ラッパ自身が例外で落ちた: ${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
