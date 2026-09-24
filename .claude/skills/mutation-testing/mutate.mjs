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
//   baseline [--max-workers <n>]    ベースラインが緑であることを確かめる。
//   apply --spec <file.json>        段階実行: 1つの変異を当てて印を置くところまで。
//   restore [--restore-from-marker] 段階実行: 印を読んで復元する。
//   run --plan <file.json> [--max-workers <n>]  本番: 複数の変異を順に回す。
//   selftest --scenario <name>      自己検証（受け入れ条件とレビューで見つかった欠陥の回帰確認）。
//                                    本数と内訳は数えない — 省略した出力が名乗る一覧
//                                    （`mutate-selftest.mjs` の SELFTEST_SCENARIOS）が本籍である。
//
// `baseline` / `run` は、印が残っている状態では測定を始めずに落ちる（既定）。
// 中断されたツリーで新しい測定を始めると、生存も検出も意味を失うため。
// 逃げ道は `--allow-existing-marker` の1つに限る。
//
// `run` は対照を**2種類**取る。混ぜないこと:
//   1. **印なし・無変異の baseline**（先頭）。緑でなければ run を中止する。
//   2. **印だけ・無変異の足場対照**（`makeScaffoldControlCache`。走行範囲ごとに
//      1回）。**このハーネス自身が足場として置く印に反応して赤くなる歯が実在する**
//      ので、その集合を測って判定から差し引く。差し引く集合の出所はこの実測だけ
//      であり、CLI のフラグも plan / spec の項目も無い（人が「これは既知の失敗
//      です」と宣言できる形を作らない）。詳細は `mutate-core.mjs` の
//      `measureScaffoldControl` / `decideJudgementCategory` の doc。
//
// `--max-workers <n>` / `--max-workers=<n>`（#331）: 器が混んでいて並列度を
// 下げるよう指示されている場面向け。**どちらの形も受け付ける**（vitest 本体の
// フラグが `--maxWorkers=4` という `=` の形なので、その形で打っても届く必要が
// ある。読む実装は `mutate-core.mjs` の `readMaxWorkers`）。省略時は
// `mutate-core.mjs` の `DEFAULT_MAX_WORKERS`（＝これまでどおり `4`）のまま。
// `run` に渡すと、baseline の確認と各変異ごとのテスト実行の両方に効く。
//
// `--root <path>`: 対象ツリー（ROOT）を明示的に上書きする。全コマンド共通。
// 省略時は `mutate-core.mjs` の `DEFAULT_ROOT`（＝これまでどおり、このスクリプト
// 自身の位置から3階層上）のまま — 既定の挙動は変えていない。
//
// **なぜ足したか。** `ROOT` はこのスクリプト自身の位置から決まり、上書きする
// 引数が無かった。別の repo（例: 他のチェックアウト）の中に立ってこの clone の
// `mutate.mjs status` を呼ぶと、エラーにならず「このツリーに変異が当たった
// ままの状態は無い」と答える——その「このツリー」が呼び出し元ではなくこの
// clone であることが、出力からは分からなかった。`--root` を足しただけでは
// 半分で、**どの ROOT について答えているかを毎回出力に出す**（下記）ことで、
// 対象の取り違えを「そうと分かる形」にする。
//
// **環境変数ではなく引数にした理由**: `mutate-core.mjs` 冒頭に「ここに
// テスト用の抜け道（環境変数で分岐する類）を作らない」とある。この CLI 層が
// argv を読んで `mutate-core.mjs` の `setRootOverride` を呼ぶ——分岐は
// argv 解析であって、環境変数による分岐ではない。
//
// 実効の ROOT（既定か上書きかを含む）は、コマンドの実行結果を出す前に必ず
// 1行出す（`main()` の冒頭）。`status` が「無い」と答えるとき、それがどの
// ツリーについてのことかを読めば分かるようにするためである。

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_ROOT,
  HarnessError,
  ROOT,
  SCAFFOLD_CONTROL_STAGE,
  applyMutation,
  assertAggregateBlocksUnambiguous,
  assertNoUnhandledErrorsLine,
  buildAndCheckArtifact,
  checkJudgementVocabulary,
  describeRunScope,
  formatDeclaredTargetReport,
  formatScaffoldSubtractionReport,
  judge,
  markerExists,
  measureScaffoldControl,
  readMarkerVerified,
  readMaxWorkers,
  readRootArg,
  restoreMutation,
  runTests,
  section,
  setRootOverride,
  testsAllPassed,
  testsRanCleanly,
  log,
} from './mutate-core.mjs';
import {
  collectKnownSelftestScaffoldNotices,
  findLeftoverDeliveryScaffold,
  formatLeftoverDeliveryScaffoldNotice,
  runSelftestScenario,
  SELFTEST_SCENARIOS,
} from './mutate-selftest.mjs';

const __filename = fileURLToPath(import.meta.url);

function cmdStatus() {
  checkJudgementVocabulary();
  if (!markerExists()) {
    // **#1262 案B。** ここまでは「印が無ければ何も見ずに exit 0」だった。
    // それでも selftest が signal 等で中断すると、印を1度も作らない区間・
    // 印を解除した後の区間のどちらでも、既知の selftest 足場（barrel の
    // 一時参照ブロック・`mutation-selftest-*` の使い捨てファイル）だけが
    // 印を経由せずに取り残されうる（Issue #1262 の2026-09-23 の実測と、
    // 同日の決定コメント「次に手を入れるなら案B」）。
    //
    // ⚠️ **代償は2点、詫びずに書く（PR 本文にも同じものを置く）。**
    // (a) 汎用の `status` が、selftest 固有のパス（barrel のブロック・
    //     `mutation-selftest-*` の固定ファイル）を知る結合を持つ
    //     （`collectKnownSelftestScaffoldNotices` が exports として持ち込む）。
    // (b) **「印は無い」の意味が変わる。** 従来は `exit 0 ⟺ 印が無い` だった。
    //     これからは `exit 0 ⟺ 印が無い かつ 既知の足場も無い`。印が無くても
    //     既知の足場が在れば `exit 2` で終わる——「印は無い」という1行自体は
    //     印について嘘をついていない（字義どおり正しい）が、この1行だけを
    //     読んで「このツリーは何もかも無事」と結論することはもうできない。
    //     exit code まで含めて読む必要がある。
    const scaffoldNotices = collectKnownSelftestScaffoldNotices();
    log('印は無い。このツリーに変異が当たったままの状態は無い。');
    if (scaffoldNotices.length === 0) {
      process.exit(0);
    }
    log('');
    log(
      '⚠ ただし、selftest が置き去りにした既知の足場が残っている' +
        '（印とは無関係——足場は印を使わずに残ることがある）。',
    );
    for (const notice of scaffoldNotices) {
      log('');
      log(notice);
    }
    process.exit(2);
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

  // **段階に応じて説明を変える。** 「ソースが変異したまま」（stage:
  // 'source-mutated'。旧い印にはこのフィールドが無いので、その場合もここに
  // 倒す — 後方互換）と「ソースは復元済みで dist の確認が取れていない」
  // （stage: 'dist-unverified'）は別の状態であり、次にやることが違う。
  // 同じ「印が残っている」でも、後者で cp/md5sum を主経路として出すと、
  // 次に来た人はソースの復元をやり直し、md5 が一致するのを見て「直った」と
  // 誤解する — 実際に残っているのは dist であって、cp では直らない。
  const stage = marker.stage ?? 'source-mutated';

  // **足場対照の印は「変異が当たったまま」ではない。** 先に分岐する ——
  // 下の共通の説明（`manualRestore.command` で cp して md5 を照合する）は
  // 復元する対象が在る前提であり、この印には `manualRestore` が無い
  // （読み取ると TypeError で落ちる）。そして何より、次に来た人へ
  // 「ソースが変異したまま」と伝えると、**在りもしない変異を探すことになる。**
  if (stage === SCAFFOLD_CONTROL_STAGE) {
    log('⚠ このツリーには足場対照の印が残っている（変異は当たっていない）。');
    log('');
    log(`変異 id: ${marker.mutationId}`);
    log(`いつ: ${marker.startedAt}`);
    log(`セッション: ${marker.sessionId ?? '(不明)'} / pid=${marker.pid ?? '(不明)'}`);
    log(`印内の原文の自己整合性: ${selfConsistent ? '一致（信頼できる）' : '不一致'}`);
    log('');
    log(`印が名乗っている内容: ${marker.note ?? '(無い)'}`);
    log('');
    log('段階: 足場対照（印だけ置いて、変異を当てずに1回走らせる）の途中で止まった。');
    log('ソースは1バイトも変わっていない。復元すべきものは無い。');
    log('');
    log('次にやること:');
    log(`  ${marker.howToClear ?? 'rm MUTATION-IN-PROGRESS.json'}`);
    log(
      '（`restore` は使わない —— 復元する対象が無いので拒否する。' +
        'これは印を黙って消さないためである）',
    );
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

  if (stage === 'dist-unverified') {
    log(
      '段階: ソース（git 管理下）は既に復元済みである。残っているのは dist の確認が取れていないことである。',
    );
    log(
      `（参考: ソースの md5 は既に ${marker.md5Pre} と一致しているはずである。ソースの cp による復元は不要 — それをやり直しても dist は直らない）`,
    );
    log('');
    log(`対象パッケージ: ${marker.target ?? '(不明)'}`);
    if (marker.artifact) {
      log(
        `成果物: ${marker.artifact.file}（"${marker.artifact.contains}" が消えていることを確認できていない）`,
      );
    } else {
      log('成果物検査の設定が無いため、build の成功だけを根拠にする（内容までは確認できない）。');
    }
    log('');
    log('次にやること（ソース側は何もしなくてよい。dist を作り直すこと）:');
    log(`  $ pnpm --filter ${marker.target ?? '<target>'} build`);
    log(
      `  $ node ${path.relative(ROOT, __filename)} restore   # べき等。再度呼べば dist を検証し、通れば印を消す`,
    );
  } else {
    log('段階: ソースが変異したまま（まだ復元されていない）。');
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
  }
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
  const maxWorkers = readMaxWorkers(args);
  section('baseline');
  // `runTests` の第2引数は既定で `DEFAULT_MAX_WORKERS` を持つので、`undefined` を
  // そのまま渡せば呼び出し元の既定が効く（`maxWorkers` で分岐する必要が無い）。
  const result = runTests([], maxWorkers);
  log(result.raw);
  // 判定の入口3箇所のうちの1つ（他の2つは mutate-core.mjs の
  // decideJudgementCategory / cmdRun の baseline 確認）。生ログは1行上で既に
  // 出ている。
  assertAggregateBlocksUnambiguous(result.raw, 'baseline');
  // 門2 相当（4つの呼び出し元のうちの1つ。他の3つは decideJudgementCategory /
  // 足場対照 / cmdRun の baseline 確認——assertAggregateBlocksUnambiguous と同じ
  // 4箇所）。集計行が緑のままでも `Errors` 行（未処理の例外/rejection）が
  // 出ていれば、ここで「ベースライン成立。」と名乗る前に止める——exitCode を
  // 見ない設計なので、ここで拒まないと壊れた走行の上に以降の段が全部載る。
  assertNoUnhandledErrorsLine(result.raw, 'baseline');
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
  let result;
  try {
    result = restoreMutation({ fromMarker });
  } catch (err) {
    // **#1358 の限界を塞ぐ。** #1358 が足した「`restore` 成功後の名指し」は、
    // 印が作られる前の区間（barrel に足場が入った直後・フィクスチャの変異前）
    // で中断した回には届かない——その回は `restoreMutation` が
    // `readMarkerVerified` の入口で HarnessError('印が無い。') を投げ、この
    // catch より下の成功経路（名指しを足す側）へ一度も到達しないためである。
    // ここではその区間に限って、例外メッセージの後ろへ足場の名指しを足す。
    //
    // **`err instanceof HarnessError` を条件にしているのは型を保つため。**
    // `main()` の catch は `instanceof HarnessError` のときだけ
    // `エラー: ${message}` を出して exit 1 にし、それ以外は素通しして
    // スタックトレースごと投げ直す。ここで組み立て直す例外も
    // `new HarnessError(...)` にすることで、その分岐を変えない——
    // 元が HarnessError でない例外（想定外のバグ）まで HarnessError に
    // 化けさせて exit 1 の顔で隠さないよう、条件を懸けてある。
    //
    // **見るのは印の有無だけで、印が在るのに `restoreMutation` が失敗した
    // 回（印を残す回。例: 控えが汚染されている）には触らない。** `status` が
    // 印の段階から理由を説明できるので、汎用の `restore` へさらに selftest
    // 固有の知識を足す理由が無い——#1358 が案B（`status` に足場を教える案）を
    // 見送った理由と同じである。足場の検出そのものは #1358 で既に
    // 切り出してある（`findLeftoverDeliveryScaffold` /
    // `formatLeftoverDeliveryScaffoldNotice`）ので、ここでは呼ぶだけで、
    // 新しい結合は増やさない。
    if (err instanceof HarnessError && !markerExists()) {
      const leftoverDeliveryScaffold = findLeftoverDeliveryScaffold();
      const notice = formatLeftoverDeliveryScaffoldNotice(leftoverDeliveryScaffold, 'no-marker');
      // 足場が無ければ、例外をそのまま投げ直す（出力は1文字も変えない）。
      if (notice !== null) {
        throw new HarnessError(`${err.message}\n\n${notice}`);
      }
    }
    throw err;
  }
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
  // **#1262 追加測定。** ここまでで `restoreMutation` は成功しており（例外を
  // 投げた経路はこの行へ来ない）、印の解除も書き戻しも既に終わっている——
  // ここで足すのは出力だけで、`restoreMutation` の書き戻し・印の解除には
  // 一切触らない。delivery の barrel 足場・フィクスチャ本体が残っていれば
  // 名指しする。無ければ何も出さない（出力は1文字も増えない）。
  const leftoverDeliveryScaffold = findLeftoverDeliveryScaffold();
  const leftoverDeliveryScaffoldNotice =
    formatLeftoverDeliveryScaffoldNotice(leftoverDeliveryScaffold);
  if (leftoverDeliveryScaffoldNotice !== null) {
    log('');
    log(leftoverDeliveryScaffoldNotice);
  }
}

function runOneMutation(spec, maxWorkers, scaffoldControlFor) {
  section(
    `変異 ${spec.id} (${spec.file}: ${JSON.stringify(spec.from)} → ${JSON.stringify(spec.to)})`,
  );

  // **足場対照は変異を当てる前に取る。** 印だけが在る状態を作って測るもの
  // なので、変異を当てた後では「印 + 変異」の結果になり対照にならない。
  // **走行範囲はこの変異の走行と揃える**（`spec.testFilter`）。
  const extraArgs = spec.testFilter ? [spec.testFilter] : [];
  let scaffoldControl;
  try {
    scaffoldControl = scaffoldControlFor(extraArgs);
  } catch (err) {
    log(`足場対照を取れなかったので、この変異の判定は出せない: ${err.message}`);
    return { id: spec.id, outcome: 'scaffold-control-failed', error: err.message };
  }

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
    // `maxWorkers` が `undefined` でも `runTests` の既定引数がそのまま効く。
    testResult = runTests(extraArgs, maxWorkers);
    log('--- test 生ログ ここから ---');
    log(testResult.raw);
    log('--- test 生ログ ここまで ---');
    // **差し引いた名前は、判定より前に出す。** 判定が拒まれても証跡が残る
    // （歯7「加工前の証跡」と同じ順序。`assertAggregateBlocksUnambiguous` の
    // 生ログの扱いに揃えてある）。
    log('--- 足場対照との差し引き ここから ---');
    log(formatScaffoldSubtractionReport(testResult, scaffoldControl));
    log('--- 足場対照との差し引き ここまで ---');
    // #993 段2: 宣言した歯（mustFail）と census 上の状態を、判定より前に証跡として
    // 出す（段1 の積み残し「判定行に宣言した歯の名前そのものを載せる」）。判定行
    // 自身（禁止語検査を通る）には外から来た名前を混ぜられないので、ここに置く
    // （`formatDeclaredTargetReport` の doc）。
    log('--- 宣言した歯 (mustFail) ここから ---');
    log(formatDeclaredTargetReport(spec.mustFail, testResult));
    log('--- 宣言した歯 (mustFail) ここまで ---');
    judgement = judge(spec, artifactResult, testResult, scaffoldControl);
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

/**
 * 足場対照（印だけ・無変異の1回の走行）を、**走行範囲ごとに1回だけ**測る。
 *
 * **キーは `extraArgs`（＝`spec.testFilter`）である。** 絞り込んだ走行の対照を
 * 全件で取ると、絞り込みでは走らない歯まで差し引いてしまう。逆に全件の走行の
 * 対照を絞り込みで取ると、印に起因する赤を差し引き損ねる（＝偽の「検出」が
 * 残る）。**測る側と揃えるのが唯一正しい取り方なので、範囲ごとに持つ。**
 *
 * **同じ範囲では測り直さない。** 全件の走行は1回で数分かかるので、plan の
 * 変異の本数だけ測ると現実的な時間で終わらない。**その代わり、対照を取った
 * 時刻から離れるほど「揺れの分布が変わった」可能性が上がる —— これは測って
 * いない。** 差し引いた名前を毎回列挙することと、対照で赤かったのにその走行で
 * 赤くならなかった歯を毎回出すこと（`formatScaffoldSubtractionReport`）で、
 * 読む側が気づける形にしてある。
 */
function makeScaffoldControlCache(maxWorkers) {
  const cache = new Map();
  return function scaffoldControlFor(extraArgs) {
    const key = JSON.stringify(extraArgs);
    if (!cache.has(key)) {
      section(`足場対照（${describeRunScope(extraArgs)}）: 印だけ置いて、変異を当てずに1回測る`);
      log(
        'なぜ取るか: このハーネスは足場として ROOT 直下へ印を置く。その印そのものに反応して' +
          '赤くなる歯が実在するので、赤い歯が在るだけでは「変異が検出された」と言えない。' +
          '差し引く集合をここで測る（人が宣言できる経路は無い）。',
      );
      const control = measureScaffoldControl({ extraArgs, maxWorkers });
      log('--- 足場対照 生ログ ここから ---');
      log(control.raw);
      log('--- 足場対照 生ログ ここまで ---');
      log(`抽出した行: ${control.filesLine} / ${control.testsLine}`);
      log(control.reason);
      for (const n of control.failedNames) log(`  [対照] ${n}`);
      cache.set(key, control);
    }
    return cache.get(key);
  };
}

function cmdRun(args) {
  checkJudgementVocabulary();
  assertNoBlockingMarker('run', args);
  const maxWorkers = readMaxWorkers(args);
  const { data: plan } = readJsonArg('--plan', args);

  section('run: baseline を先に確かめる');
  const baseline = runTests([], maxWorkers);
  log(baseline.raw);
  // 判定の入口3箇所のうちの1つ（他の2つは mutate-core.mjs の
  // decideJudgementCategory / cmdBaseline）。生ログは1行上で既に出ている。
  assertAggregateBlocksUnambiguous(baseline.raw, 'run: baseline');
  // 門2 相当（4つの呼び出し元のうちの1つ。他の3つは decideJudgementCategory /
  // 足場対照 / cmdBaseline）。`testsAllPassed` は集計行の文字列しか見ないので、
  // `Errors` 行が出ていても素通りしてしまう——ここで先に拒む。
  assertNoUnhandledErrorsLine(baseline.raw, 'run: baseline');
  if (!testsRanCleanly(baseline) || !testsAllPassed(baseline)) {
    log('ベースラインが緑ではない。run を中止する。');
    process.exit(1);
  }
  log(`抽出した行: ${baseline.filesLine} / ${baseline.testsLine}`);
  log(
    '（この対照は「印なし・無変異」である。緑でなければ run を中止する形は変えていない ——' +
      '断続的な揺れがここで出れば fail-closed で止まる。印が在る状態の対照は、変異ごとに' +
      '走行範囲を揃えて別に取る。下の「足場対照」）',
  );

  const scaffoldControlFor = makeScaffoldControlCache(maxWorkers);
  const results = [];
  for (const spec of plan) {
    results.push(runOneMutation(spec, maxWorkers, scaffoldControlFor));
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

/**
 * `--root` を解釈し、実効の ROOT を出力へ1行出す。
 *
 * **対象の取り違えを「そうと分かる形」にする本体はここである。** `--root` の
 * 上書きの有無に関わらず、どの ROOT について以降の出力が答えているのかを
 * 先頭で明示する。`status` が「印は無い」と答えるとき、それが呼び出し元の
 * ツリーではなくこの ROOT についてのことだと、ここを読めば分かる。
 */
function applyRootArgAndAnnounce(rest) {
  const rootArg = readRootArg(rest);
  if (rootArg !== undefined) {
    setRootOverride(rootArg);
    log(`ROOT: ${ROOT}（--root で上書き。既定は ${DEFAULT_ROOT}）`);
  } else {
    log(`ROOT: ${ROOT}（既定。--root は渡されていない）`);
  }
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  try {
    applyRootArgAndAnnounce(rest);
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
