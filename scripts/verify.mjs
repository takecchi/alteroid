#!/usr/bin/env node
// 3（テスト0本）と 4（走ったか判定できない）を混ぜない: 3 は並列度を下げて取り直す助言が効くが、4 は原因が混雑ではなく同じ助言では無駄に繰り返させるため。
// 指紋が一致する再呼び出しは何も走らせず返す: 一式を通した後に手を入れて通し直さない失敗を、警告ではなく打ち直しを選択でなくすことで防ぐため。
// 指紋は `git ls-files -co --exclude-standard` の全ファイルのパス・モード・中身と `HEAD` の sha: 人が手で直したときに変わるものを、別枠で数え上げずに git の状態として全部取るため。
// 絞り込んだ実行は全体の成功として記録しない: 次の `pnpm verify` を必ず走らせるため。
// 指紋が一致しても記録した日（UTC）が今日と違えば走る側へ倒す: スイートの内側の日付依存テストは外側から数え切れず、個々の検査を数え上げずに「記録した日」と「いま」を突き合わせるため。
// 並列度は build へ引数として渡さず環境変数 `PNPM_CONFIG_WORKSPACE_CONCURRENCY` で渡す: `pnpm build -- <フラグ>` は各パッケージの build スクリプトの引数になり、`apps/web` の `react-router build` が落ちるため。
// `pnpm install --frozen-lockfile` は走らせない: 手元の `node_modules` を勝手に作り替えないため。

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  classifyTest,
  classifyTestScope,
  decideRecord,
  decideSkip,
  envForStep,
  fingerprint,
  recordFor,
  recordPathFor,
  splitVerifyArgs,
  STEPS,
  writeTreeFor,
} from './verify-core.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

// 記録の置き場は git 自身に聞く（`<repo>/.git` を組み立てない）: `git worktree` では `.git` がファイルで、一式が全部通った後に `ENOTDIR` で落ちるため。
const RECORD = recordPathFor(REPO);

// 一式（`STEPS`）は `verify-core.mjs` に置く: 「build の手順にだけ `PNPM_CONFIG_WORKSPACE_CONCURRENCY` が渡る」を手順の実物と突き合わせて測るには、定義が import できる側に無ければならないため。

const argv = process.argv.slice(2);
const force = argv.includes('--force');

// 並列度の既定を数で固定しない: 適切な数は器ごとに違い、固定した数は腐るため。
// 素の `--` は落とす: pnpm が `--` ごと渡し、そのまま足すと `--maxWorkers=4` が vitest へ届かないため。
let split;
try {
  split = splitVerifyArgs(argv);
} catch (error) {
  process.stdout.write('\n!! ' + error.message + '\n');
  process.exit(1);
}
const { workspaceConcurrency, passthrough } = split;

// テスト以外の手順は素通し（`inherit`）で溜めない: 全部溜める形では、この器で `pnpm build` が SIGABRT（exit 134）で落ちた（直接打つと通るのに、この口から呼ぶと落ちる）ため。
// env に足した分は見出しに書く: 出力に出ないと、渡した並列度が効いたかを確かめる手段が無いため。
function run(step) {
  const env = envForStep(step, { workspaceConcurrency, baseEnv: process.env });
  const note =
    env === process.env
      ? ''
      : ' [env PNPM_CONFIG_WORKSPACE_CONCURRENCY=' + env.PNPM_CONFIG_WORKSPACE_CONCURRENCY + ']';
  process.stdout.write(
    '\n=== ' + step.name + ': ' + step.cmd + ' ' + step.args.join(' ') + note + '\n',
  );
  const r = spawnSync(step.cmd, step.args, { cwd: REPO, stdio: 'inherit', env });
  if (r.error !== undefined && r.error !== null) {
    return { code: 1, startError: r.error };
  }
  // signal で殺されて `status` が null のときは 0 へ倒さない。
  return { code: r.status ?? 1 };
}

// `spawnSync` の `maxBuffer` に頼らない: 超えると出力を打ち切ってプロセスを殺し、末尾の `Test Files` / `Tests` の行が消えて、走って落ちたものが exit 3 になるため。
// stdout と stderr は別々に溜める: 同じ文字列へ足すと、改行で終わらない書き込みの直後に他方が続いて1行に融合するため。
// `testRan` に渡すのは stdout だけにする: vitest の集計行は常に stdout 側に出るため。
function runTest(step) {
  const args = [...step.args, ...passthrough];
  process.stdout.write('\n=== ' + step.name + ': ' + step.cmd + ' ' + args.join(' ') + '\n');
  return new Promise((resolve) => {
    const child = spawn(step.cmd, args, { cwd: REPO, stdio: ['inherit', 'pipe', 'pipe'] });
    let stdoutText = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdoutText += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      process.stdout.write(chunk.toString('utf8'));
    });
    child.on('error', (error) =>
      resolve({ output: stdoutText, status: null, signal: null, startError: error }),
    );
    child.on('close', (status, signal) => resolve({ output: stdoutText, status, signal }));
  });
}

const decided = decideSkip({ repo: REPO, recordPath: RECORD, force });

if (decided.skip) {
  // 無料で返したときも必ず1行残す: 畳んだことが記録に残らないと、実走かキャッシュ命中かを読み分けられないため。
  process.stdout.write(
    'verify: skipped (tree unchanged since ' +
      decided.fingerprint.slice(0, 12) +
      ', verified at ' +
      decided.at +
      ')\n  走らせ直すなら `pnpm verify --force`\n',
  );
  process.exit(0);
}

// `stale-day` も1行出す: 指紋が一致しているので、黙っていると、なぜこの回はキャッシュが効かないのかを確かめる手段が無いため。
if (decided.reason === 'stale-day') {
  process.stdout.write(
    'verify: 記録はあるが検証した日が今日ではないので畳まない' +
      '（記録された日=' +
      (decided.day ?? '(旧形式の記録。day を持たない)') +
      ', 今日=' +
      decided.today +
      '）。実行する。\n',
  );
}

const results = [];
for (const step of STEPS) {
  if (!step.isTest) {
    const { code, startError } = run(step);
    if (startError !== undefined) {
      process.stdout.write(
        '\n!! ' + step.name + ' を起動できなかった: ' + startError.message + '\n',
      );
      process.exit(1);
    }
    if (code !== 0) {
      const rest = STEPS.slice(STEPS.indexOf(step) + 1).map((x) => x.name);
      process.stdout.write(
        '\n!! ' +
          step.name +
          ' が落ちた（exit ' +
          code +
          '）' +
          (step.hint === undefined ? '' : ' — ' + step.hint) +
          '\n' +
          (rest.length === 0
            ? ''
            : '   ここで止める。以降は走らせていない: ' + rest.join(' / ') + '\n'),
      );
      process.exit(1);
    }
    results.push(step.name);
    continue;
  }

  const { output, status, signal, startError } = await runTest(step);
  if (startError !== undefined) {
    process.stdout.write('\n!! ' + step.name + ' を起動できなかった: ' + startError.message + '\n');
    process.exit(1);
  }

  const verdict = classifyTest({ status, signal, output });

  if (verdict.state === 'not-run') {
    process.stdout.write(
      '\n!! ' +
        step.name +
        ': **走っていない**（落ちたのではない）。`Test Files` / `Tests` の行が出ていない。\n' +
        '   器が混んでいる可能性が高い。並列度を下げて取り直すこと: `pnpm verify -- --maxWorkers=4`\n' +
        '   **この結果を「落ちた」と読まないこと** — 存在しない失敗を直しに行くことになる。\n',
    );
    process.exit(3);
  }

  if (verdict.state === 'undecidable') {
    process.stdout.write(
      '\n!! ' +
        step.name +
        ': **走ったかどうか判定できない**（' +
        verdict.reason +
        (verdict.signal === undefined || verdict.signal === null ? '' : ' ' + verdict.signal) +
        '）。\n' +
        '   要約の行は' +
        (verdict.ran ? '出ている' : '出ていない') +
        'が、プロセスが正常に終わっていないので結末が読めない。\n' +
        '   **「落ちた」とも「走っていない」とも読まないこと。** 並列度を下げても直らない\n' +
        '   （原因が混雑ではない）ので、まず何が殺したのかを見ること。\n',
    );
    process.exit(4);
  }

  if (verdict.state === 'failed') {
    process.stdout.write('\n!! ' + step.name + ' が落ちた（exit ' + verdict.code + '）\n');
    process.exit(1);
  }

  results.push(step.name);
}

// 指紋は走る前のものと突き合わせ、動いていたら記録しない: 走り終わった時点の指紋だけを書くと、走行中に誰かが直した分を「検証済み」として記録し、次の `pnpm verify` が畳んでしまうため。
const after = fingerprint(REPO);
const moved = after === null || after !== decided.fingerprint;

const scope = classifyTestScope(passthrough);
const recordDecision = decideRecord({ scope, moved, recordPath: RECORD });

if (recordDecision.record) {
  // `after`（指紋）を取った直後に tree の sha を取る: 間が空くほど、動かされた分を拾い損ねる窓が広がるため。
  // 取れなければ（`null`）記録から tree を落とす: 古い形式として書き、`pnpm check:verified-head` に「判定できない」と読ませる（「一致」へは倒さない）ため。
  const verifiedTree = writeTreeFor(REPO) ?? undefined;

  // 記録の失敗で一式を落とさない: 検証は全部通っており、記録は次回を速くするためのものなので、書けなかったと言って 0 で返す。
  try {
    writeFileSync(
      RECORD,
      JSON.stringify(recordFor(after, new Date(), verifiedTree), null, 2) + '\n',
    );
  } catch (error) {
    process.stdout.write('（指紋を記録できなかった: ' + error.message + '。次も必ず走る）\n');
  }
}

process.stdout.write(
  '\n=== 検証一式: 全部通った（' +
    results.join(' / ') +
    '）\n' +
    (recordDecision.reason === 'tree-moved'
      ? '⚠️ 走行中にツリーが動いたので記録していない（次も必ず走る）。\n' +
        '   **通ったのは走り始めた時点のツリーである。** いまのツリーは検証されていない。\n'
      : recordDecision.reason === 'narrowed'
        ? '⚠️ 実行範囲を絞ったので、全体の成功として記録していない（次も必ず走る）。\n' +
          '   絞り込みと判定した引数: ' +
          recordDecision.narrowing.join(' ') +
          '\n' +
          '   **通ったのはこの範囲だけである。** 通常の `pnpm verify` は全部を走らせる。\n'
        : recordDecision.reason === 'no-record-path'
          ? '（記録の置き場を取れなかったので記録していない。次も必ず走る）\n'
          : 'verify: recorded (' + after.slice(0, 12) + ')\n'),
);
