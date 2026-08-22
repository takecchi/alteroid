#!/usr/bin/env node
// mutate.mjs — 変異試験ハーネスの CLI 層（薄い）。
//
// `.claude/skills/mutation-testing/SKILL.md` に書いてある手順を機械が実行する形に
// 落としたものである。手順そのもの（7つの歯）は `mutate-core.mjs` に在り、
// ここは argv を読んで呼び出し、exit code を出すだけの層である。
//
// 単一ファイル・依存なしという制約は、CLI 層・純粋な層・自己検証層の3ファイルに
// 分けたことで崩れているが、node_modules には一切依存しない（同ディレクトリの
// 素の `import` だけ）。ビルドは要らない — 壊れているときにも使える必要がある。
//
// コマンド:
//   status                          印の有無を報告する。誰でも引数なしで打てる。
//   baseline                        ベースラインが緑であることを確かめる。
//   apply --spec <file.json>        段階実行: 1つの変異を当てて印を置くところまで。
//   restore [--restore-from-marker] 段階実行: 印を読んで復元する。
//   run --plan <file.json>          本番: 複数の変異を順に回す。
//   selftest --scenario <name>      自己検証（受け入れ条件の3つ+1に加え、レビューで見つかった欠陥2件の回帰確認）。省略で一覧を出す。
//
// `baseline` / `run` は、印が残っている状態では測定を始めずに落ちる（既定）。
// 中断されたツリーで新しい測定を始めると、生存も検出も意味を失うため。
// 逃げ道は `--allow-existing-marker` の1つに限る。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  HarnessError,
  ROOT,
  applyMutation,
  buildAndCheckArtifact,
  checkJudgementVocabulary,
  judge,
  markerExists,
  readMarkerVerified,
  restoreMutation,
  runTests,
  section,
  testsAllPassed,
  testsRanCleanly,
  log,
} from './mutate-core.mjs';
import { runSelftestScenario, SELFTEST_SCENARIOS } from './mutate-selftest.mjs';

const __filename = fileURLToPath(import.meta.url);

function cmdStatus() {
  checkJudgementVocabulary();
  if (!markerExists()) {
    log('印は無い。このツリーに変異が当たったままの状態は無い。');
    process.exit(0);
  }
  let marker;
  let selfConsistent;
  try {
    ({ marker, selfConsistent } = readMarkerVerified());
  } catch (err) {
    log('⚠ 印はあるが、読めない／壊れている:');
    log(err.message);
    process.exit(2);
  }
  log('⚠ このツリーには変異が当たったままである。');
  log('');
  log(`ファイル: ${marker.file}`);
  log(`変異 id: ${marker.mutationId}`);
  log(`from: ${JSON.stringify(marker.from)}`);
  log(`to:   ${JSON.stringify(marker.to)}`);
  log(`いつ: ${marker.startedAt}`);
  log(`セッション: ${marker.sessionId ?? '(不明)'} / pid=${marker.pid ?? '(不明)'}`);
  log(`控え: ${marker.backupPath}`);
  log(`md5Pre: ${marker.md5Pre}`);
  log(
    `印内の原文の自己整合性: ${selfConsistent ? '一致（信頼できる）' : '不一致（印自体が壊れている疑い）'}`,
  );
  log('');
  log('ハーネスを使わない復元手順:');
  log(`  $ ${marker.manualRestore.command}`);
  log(
    `  $ ${marker.manualRestore.verifyMd5Command}   # ${marker.manualRestore.expectedMd5} と一致するはず`,
  );
  log('');
  log(`前提つきの代替: ${marker.alternativeWithCaveat}`);
  log('');
  log(`もしくは: node ${path.relative(ROOT, __filename)} restore`);
  process.exit(2);
}

function assertNoBlockingMarker(commandName, args) {
  const bypass = args.includes('--allow-existing-marker');
  if (markerExists() && !bypass) {
    throw new HarnessError(
      `${commandName}: 印が残っている。中断されたツリーで新しい測定を始めると、何を測っているか` +
        '分からなくなる（前の変異が残ったまま新しい変異を当てる形は、生存も検出も意味を失う）。' +
        '`status` で確認し、復元してから再実行すること。どうしても続けるなら `--allow-existing-marker` ' +
        'を明示する（既定は拒否）。',
    );
  }
}

function cmdBaseline(args) {
  checkJudgementVocabulary();
  assertNoBlockingMarker('baseline', args);
  section('baseline');
  const result = runTests([]);
  log(result.raw);
  if (!testsRanCleanly(result)) {
    log('');
    log(
      'ベースライン不成立: `Test Files` / `Tests` の行が両方揃っていない。' +
        '「落ちた」と「1本も走らなかった」はどちらも exit 1 である。',
    );
    process.exit(1);
  }
  const passed = testsAllPassed(result);
  log('');
  log(`抽出した行: ${result.filesLine} / ${result.testsLine}`);
  if (!passed) {
    log('ベースライン不成立: 緑ではない。');
    process.exit(1);
  }
  log('ベースライン成立。');
  process.exit(0);
}

function readJsonArg(flagName, args) {
  const idx = args.indexOf(flagName);
  if (idx === -1 || args[idx + 1] === undefined) {
    throw new HarnessError(`${flagName} <path> が要る`);
  }
  const p = args[idx + 1];
  return { path: p, data: JSON.parse(fs.readFileSync(p, 'utf8')) };
}

function cmdApply(args) {
  checkJudgementVocabulary();
  const { data: spec } = readJsonArg('--spec', args);
  section(`apply: ${spec.id}`);
  applyMutation(spec);
  log('');
  log('印を置いたまま終了する（段階実行）。次は build/test を手で回すか、`restore` で戻す。');
}

function cmdRestore(args) {
  checkJudgementVocabulary();
  section('restore');
  const fromMarker = args.includes('--restore-from-marker');
  const result = restoreMutation({ fromMarker });
  // **戻り値を読む。** `rebuildCheck` を捨てると、後始末の build が落ちて
  // いても `restore` が exit 0 で終わったように見えかねない（マネージャーの
  // 実測で見つかった欠陥）。`restoreMutation` は後始末の検証が失敗すれば
  // 例外を投げて印を残すので、ここに到達する時点では既に検証済みだが、
  // その事実を CLI の出力でも明示する。
  log('');
  log(
    `復元元: ${result.restoredFrom} / 後始末: ${result.rebuildCheck.reason}` +
      `（build exit=${result.rebuildCheck.buildExitCode ?? 'N/A'}）`,
  );
}

function runOneMutation(spec) {
  section(
    `変異 ${spec.id} (${spec.file}: ${JSON.stringify(spec.from)} → ${JSON.stringify(spec.to)})`,
  );
  try {
    applyMutation(spec);
  } catch (err) {
    log(`適用を中止した: ${err.message}`);
    return { id: spec.id, outcome: 'apply-aborted', error: err.message };
  }

  let artifactResult;
  let testResult;
  let judgement; // { category, text } | undefined
  let judgeError = null;
  try {
    artifactResult = buildAndCheckArtifact(spec);
    testResult = runTests(spec.testFilter ? [spec.testFilter] : []);
    log('--- test 生ログ ここから ---');
    log(testResult.raw);
    log('--- test 生ログ ここまで ---');
    judgement = judge(spec, artifactResult, testResult);
  } catch (err) {
    judgeError = err.message;
  }

  log('');
  if (judgeError) {
    log(`判定を出せない: ${judgeError}`);
  } else {
    log(judgement.text);
  }

  section(`変異 ${spec.id}: 復元`);
  let restoreResult;
  try {
    restoreResult = restoreMutation();
  } catch (err) {
    log(`復元に失敗した: ${err.message}`);
    log('印を残したまま停止する。この状態でさらに変異を重ねてはいけない。');
    throw err;
  }
  // 戻り値を読む（cmdRestore と同じ理由）。後始末が「対象外」なのか
  // 「build 成功のみで判定した」のか「dist を読み直して確認した」のかを、
  // ここでも出す — `run` を通した経路でも黙って読み捨てない。
  log(`後始末: ${restoreResult.rebuildCheck.reason}`);

  // **まとめ行は「種別」を持つ** — `judged` のような中身の無い語ではなく、
  // 実際の判定（検出/生存/不明）そのものを出す。id とは別軸なので、
  // まとめ側で id と種別を並べて出せば、判定行と食い違えばすぐ分かる。
  return {
    id: spec.id,
    outcome: judgeError ? 'judge-error' : judgement.category,
    judgementText: judgeError ? null : judgement.text,
    judgeError,
  };
}

function cmdRun(args) {
  checkJudgementVocabulary();
  assertNoBlockingMarker('run', args);
  const { data: plan } = readJsonArg('--plan', args);

  section('run: baseline を先に確かめる');
  const baseline = runTests([]);
  log(baseline.raw);
  if (!testsRanCleanly(baseline) || !testsAllPassed(baseline)) {
    log('ベースラインが緑ではない。run を中止する。');
    process.exit(1);
  }
  log(`抽出した行: ${baseline.filesLine} / ${baseline.testsLine}`);

  const results = [];
  for (const spec of plan) {
    results.push(runOneMutation(spec));
  }

  section('run: まとめ');
  for (const r of results) log(`変異 ${r.id}: ${r.outcome}`);
}

function cmdSelftest(args) {
  checkJudgementVocabulary();
  const idx = args.indexOf('--scenario');
  const scenario = idx === -1 ? null : args[idx + 1];
  if (!scenario || !SELFTEST_SCENARIOS.includes(scenario)) {
    log('--scenario を指定すること。使えるもの:');
    for (const k of SELFTEST_SCENARIOS) log(`  - ${k}`);
    process.exit(scenario ? 1 : 0);
  }
  const results = runSelftestScenario(scenario);
  section('selftest: まとめ（自分の判定であって、上の生ログそのものではない）');
  for (const r of results) log(JSON.stringify(r));
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  try {
    switch (cmd) {
      case 'status':
        cmdStatus();
        break;
      case 'baseline':
        cmdBaseline(rest);
        break;
      case 'apply':
        cmdApply(rest);
        break;
      case 'restore':
        cmdRestore(rest);
        break;
      case 'run':
        cmdRun(rest);
        break;
      case 'selftest':
        cmdSelftest(rest);
        break;
      default:
        log('使い方: node mutate.mjs <status|baseline|apply|restore|run|selftest> [...]');
        process.exit(cmd ? 1 : 0);
    }
  } catch (err) {
    if (err instanceof HarnessError) {
      log(`エラー: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

main();
