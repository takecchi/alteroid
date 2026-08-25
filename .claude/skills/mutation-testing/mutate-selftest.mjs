// mutate-selftest.mjs — 自己検証（受け入れ条件そのもの）。
//
// ここは `mutate-core.mjs`（純粋な層）の関数を**直接呼ぶ**。サブプロセスを
// 起こしたり、まして殺したりしない — 実プロセスの kill はこの器で他人を撃つ
// 形に近づくし、テストとして不安定になる（マネージャーからの差し戻し）。
//
// 「中断」は、手順を順番どおり呼んで、その先を単に呼ばないことで表現する。
// 同じ理由で、誤った順序（変異→印）を再現する関数もここにだけ置く —
// `mutate-core.mjs` 本体に `if (順序フラグ)` のような分岐を作らない。
// 抜け道は次の穴になる。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  ROOT,
  absPath,
  applyMutation,
  buildAndCheckArtifact,
  gitStatusPorcelainFor,
  HarnessError,
  judge,
  log,
  markerExists,
  md5,
  readMarkerVerified,
  readRepoFile,
  restoreMutation,
  runTests,
  section,
  writeRepoFile,
} from './mutate-core.mjs';

export const SELFTEST_SCENARIOS = [
  'backup-corruption',
  'weak-tooth',
  'interrupted',
  'interrupted-wrong-order',
  'delivery',
  'judgement-id-integrity',
  'rebuild-failure',
  'spec-validation',
  'judgement-forbidden-word-boundary',
  'restore-status-comparison',
  'judgement-undelivered-gate',
  'all',
];

const FIXTURE_REL = '.claude/skills/mutation-testing/selftest-fixture.txt';
const FIXTURE_ORIGINAL = 'LINE-ONE\nLINE-TWO\nLINE-THREE\n';

function ensureFixtureClean() {
  const content = fs.existsSync(absPath(FIXTURE_REL)) ? readRepoFile(FIXTURE_REL) : null;
  if (content !== FIXTURE_ORIGINAL) {
    throw new HarnessError(
      `selftest 用の固定ファイル (${FIXTURE_REL}) が想定の中身になっていない。` +
        '前回の selftest が途中で終わっている疑いがある。手で復元してから再実行すること。',
    );
  }
}

function requireNoMarker(scenarioName) {
  if (markerExists()) {
    throw new HarnessError(
      `${scenarioName}: 印が既にある。selftest は印が無い状態からしか始められない。先に片付けること。`,
    );
  }
}

// ── 1. 控えの汚染 ───────────────────────────────────────────────────
//
// 受け入れ条件: 照合2が復元を止めること。止めたあと印が残っていること、
// ファイルが変異したままであること（＝黙って壊れた原文を書き戻していないこと）
// も示す。そのうえで、印に埋め込んだ原文からは `--restore-from-marker` で
// 正しく戻せることも示す（控えが信用できない場合の材料は印の側にもある、
// という設計の裏取り）。
function scenarioBackupCorruption() {
  section('selftest: 1. 控えの汚染');
  requireNoMarker('backup-corruption');
  ensureFixtureClean();

  const spec = {
    id: 'selftest-backup-corruption',
    file: FIXTURE_REL,
    from: 'LINE-TWO',
    to: 'LINE-TWO-MUTATED',
    expect: 1,
    target: null,
  };

  log('-- 1a. 通常どおり変異を当てる --');
  const ctx = applyMutation(spec);

  log('');
  log('-- 1b. ここから selftest による意図的な注入。ハーネスの通常動作ではない --');
  log('控えを、変異後の中身へ差し替える（＝控えが汚染されていた、という状況を再現する）。');
  const mutatedContent = readRepoFile(FIXTURE_REL);
  fs.writeFileSync(ctx.backupPath, mutatedContent);
  log(`控えを上書きした: ${path.relative(ROOT, ctx.backupPath)}`);
  log(`控えの md5 (汚染後): ${md5(mutatedContent)} / md5Pre (正しい原文): ${ctx.md5Pre}`);

  log('');
  log('-- 1c. この状態で restore（既定・フラグなし）を呼ぶ --');
  let refusalMessage = null;
  try {
    restoreMutation();
    log('⚠ restore が例外を投げずに終わった（想定外）');
  } catch (err) {
    refusalMessage = err.message;
    log(`restore は例外で止まった（想定どおり）:\n${err.message}`);
  }

  log('');
  log('-- 1d. 止めた後の状態を確認する --');
  const markerStillThere = markerExists();
  const fileStillMutated = readRepoFile(FIXTURE_REL).includes('LINE-TWO-MUTATED');
  log(`印はまだ在るか: ${markerStillThere}`);
  log(`ファイルはまだ変異したままか（＝黙って書き戻していない）: ${fileStillMutated}`);

  log('');
  log('-- 1e. 印に埋め込まれた原文から、明示フラグで復元する --');
  const { selfConsistent } = readMarkerVerified();
  log(`印内の原文の自己整合性（md5Pre と一致）: ${selfConsistent}`);
  const restoreResult = restoreMutation({ fromMarker: true });
  log(`復元元: ${restoreResult.restoredFrom}`);

  const finalContent = readRepoFile(FIXTURE_REL);
  const restoredCorrectly = finalContent === FIXTURE_ORIGINAL;
  const statusAfter = gitStatusPorcelainFor(FIXTURE_REL);
  log(`復元後の中身が原文と一致: ${restoredCorrectly}`);
  log(`復元後の git status --porcelain: ${JSON.stringify(statusAfter)}`);
  log(`復元後、印は残っているか（無いはず）: ${markerExists()}`);

  return {
    scenario: 'backup-corruption',
    defaultRestoreRefused: refusalMessage !== null,
    markerStillThereAfterRefusal: markerStillThere,
    fileStillMutatedAfterRefusal: fileStillMutated,
    recoveredViaMarkerFlag: restoreResult.restoredFrom === 'marker',
    restoredCorrectly,
    cleanAfterward: statusAfter.trim() === '' && !markerExists(),
  };
}

// ── 2. 歯が弱い ─────────────────────────────────────────────────────
//
// 実在の関数: apps/cli/src/conversations.ts の renderConversationDetail。
// 複数行の message.text をそのまま出す ——「全文」と「1行目＋継続行」は
// 行へ潰すと区別が消える構造である。
//
// target: null — apps/cli 自身のテストは同じパッケージの source を直接
// import しており（`./conversations.js` → `conversations.ts`）、dist 境界を
// 跨がない。だからこの demo では build/artifact 検査は「対象外」になる
// （本番でパッケージ境界を跨ぐ変異には spec.target を必ず設定すること）。
function scenarioWeakTooth() {
  section('selftest: 2. 歯が弱い（apps/cli/src/conversations.ts の renderConversationDetail）');
  requireNoMarker('weak-tooth');

  const spec = {
    id: 'selftest-weak-strong-tooth',
    file: 'apps/cli/src/conversations.ts',
    from: '${message.text}`);',
    to: "${message.text.split('\\n')[0]}`);",
    expect: 1,
    target: null,
  };

  const cases = [
    {
      label: '弱い歯',
      testRel: 'apps/cli/src/conversations.selftest-weak.test.ts',
      body: `import { describe, expect, it } from 'vitest';
import { renderConversationDetail } from './conversations.js';

// selftest 用の一時テスト（mutation-testing ハーネスの自己検証）。実行後に削除する。
// 弱い歯: 出力を split('\\n') した「1行目」の存在だけを見る。
// 「全文」と「1行目＋継続行」を区別できないので、継続行が消える変異を通す。
describe('弱い歯（selftest）', () => {
  it('1行目が出ていることだけを見る', () => {
    const rendered = renderConversationDetail(
      'conv-1',
      [
        {
          id: 'm1',
          at: '2026-01-01T00:00:00.000Z',
          role: 'inbound',
          text: '1行目\\n2行目\\n3行目',
        },
      ],
      1,
      true,
    );
    const lines = rendered.split('\\n');
    expect(lines.some((l) => l.includes('1行目'))).toBe(true);
  });
});
`,
    },
    {
      label: '強い歯',
      testRel: 'apps/cli/src/conversations.selftest-strong.test.ts',
      body: `import { describe, expect, it } from 'vitest';
import { renderConversationDetail } from './conversations.js';

// selftest 用の一時テスト（mutation-testing ハーネスの自己検証）。実行後に削除する。
// 強い歯: 全文を1つの文字列として突き合わせる。継続行が消えれば必ず落ちる。
describe('強い歯（selftest）', () => {
  it('全文（継続行を含む）を突き合わせる', () => {
    const rendered = renderConversationDetail(
      'conv-1',
      [
        {
          id: 'm1',
          at: '2026-01-01T00:00:00.000Z',
          role: 'inbound',
          text: '1行目\\n2行目\\n3行目',
        },
      ],
      1,
      true,
    );
    expect(rendered).toBe(
      [
        '── 会話 conv-1 ──',
        '  [2026-01-01T00:00:00.000Z] 人間: 1行目',
        '2行目',
        '3行目',
        '',
        '（日誌を 1 件遡り、この会話の先頭まで届いた）',
      ].join('\\n'),
    );
  });
});
`,
    },
  ];

  const outcomes = {};
  for (const { label, testRel, body } of cases) {
    log('');
    log(`== ${label}: ${testRel} を書いて、この変異だけを当てて run する ==`);
    writeRepoFile(testRel, body);
    try {
      const thisSpec = {
        ...spec,
        id: `${spec.id}-${label}`,
        testFilter: testRel.replace(/\.ts$/, ''),
      };
      applyMutation(thisSpec);
      const artifactResult = buildAndCheckArtifact(thisSpec);
      const testResult = runTests([thisSpec.testFilter]);
      log('--- test 生ログ ここから ---');
      log(testResult.raw);
      log('--- test 生ログ ここまで ---');
      let judgement;
      let judgementError = null;
      try {
        judgement = judge(thisSpec, artifactResult, testResult);
      } catch (err) {
        judgementError = err.message;
      }
      log('');
      log(
        `判定 (${label}): ${judgementError ? `判定を出せない: ${judgementError}` : judgement.text}`,
      );
      outcomes[label] = {
        category: judgementError ? null : judgement.category,
        judgement: judgementError ? `判定を出せない: ${judgementError}` : judgement.text,
        // 判定行に thisSpec.id が正しく載っているかを、選び取りではなく
        // 文字列としてここで確かめる。id の取り違えを機械的に捕まえる口
        // （この確認自体は「歯が弱い」自己検証とは別の、ハーネス自身の回帰確認）。
        judgementMentionsCorrectId: judgementError ? null : judgement.text.includes(thisSpec.id),
        testsLine: testResult.testsLine,
        filesLine: testResult.filesLine,
      };
      restoreMutation();
    } finally {
      fs.rmSync(absPath(testRel), { force: true });
    }
  }

  return { scenario: 'weak-tooth', outcomes };
}

// ── 3. 中断 ─────────────────────────────────────────────────────────
//
// マネージャーの差し戻し: 実プロセスの kill は使わない。「変異を書いた後・
// 復元の前で処理が終わった状態」を、`applyMutation` を呼んでその先を単に
// 呼ばないことで作る。確認するのは3点だけ:
//   - 印が残る
//   - 印から原文が復元できる（このシナリオでは控えもわざと使えなくして、
//     マーカー単独での復元を裏取りする）
//   - 印が残った状態では、測定を始めずに落ちる（baseline/run の入口チェック）
function scenarioInterrupted() {
  section('selftest: 3. 中断（正しい順序: 印 → 変異）');
  requireNoMarker('interrupted');
  ensureFixtureClean();

  const spec = {
    id: 'selftest-interrupted',
    file: FIXTURE_REL,
    from: 'LINE-TWO',
    to: 'LINE-TWO-INTERRUPTED',
    expect: 1,
    target: null,
  };

  log(
    '-- 3a. 変異を当てる。ここで「セッションが終わった」ことにする（この先の build/test/restore を単に呼ばない） --',
  );
  const ctx = applyMutation(spec);

  const markerPresent = markerExists();
  log(`印が残っているか: ${markerPresent}`);
  log(`ファイルは変異したままか: ${readRepoFile(FIXTURE_REL).includes('LINE-TWO-INTERRUPTED')}`);

  log('');
  log(
    '-- 3b. 次に来た人の視点: 実プロセスとして `mutate.mjs status` を呼ぶ（kill はしていない。単に別の起動） --',
  );
  // status は印がある間 exit 2 を返す（想定どおりの非0）。execFileSync は非0を
  // 例外で表すので、ここでは正しく拾って中身を読む。
  let statusResult;
  let statusExitCode;
  try {
    statusResult = execFileSync(
      'node',
      [path.join(ROOT, '.claude/skills/mutation-testing/mutate.mjs'), 'status'],
      { cwd: ROOT, encoding: 'utf8' },
    ).toString();
    statusExitCode = 0;
  } catch (err) {
    statusResult = err.stdout?.toString() ?? '';
    statusExitCode = err.status;
  }
  log(`status の exit code: ${statusExitCode}`);
  log(statusResult);

  log('');
  log('-- 3c. 印が残った状態で `baseline` を呼ぶと、測定を始めずに落ちることを確認する --');
  let baselineBlocked = false;
  try {
    execFileSync(
      'node',
      [path.join(ROOT, '.claude/skills/mutation-testing/mutate.mjs'), 'baseline'],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' },
    );
  } catch (err) {
    baselineBlocked = true;
    log('baseline は測定を始めずに落ちた（想定どおり）。stdout:');
    log(err.stdout?.toString() ?? '');
  }

  log('');
  log('-- 3d. 控えも失われた状況を作り、印だけから復元できることを裏取りする --');
  fs.rmSync(ctx.backupPath, { force: true });
  log(`控えを削除した: ${path.relative(ROOT, ctx.backupPath)}（存在しない状態にした）`);
  let recoveredFromMarkerOnly = false;
  try {
    restoreMutation({ fromMarker: true });
    recoveredFromMarkerOnly = true;
  } catch (err) {
    log(`--restore-from-marker でも失敗した（想定外）: ${err.message}`);
  }
  const finalContent = fs.existsSync(absPath(FIXTURE_REL)) ? readRepoFile(FIXTURE_REL) : null;
  const restoredCorrectly = finalContent === FIXTURE_ORIGINAL;
  log(`印だけから復元できたか: ${recoveredFromMarkerOnly}`);
  log(`復元後の中身が原文と一致: ${restoredCorrectly}`);
  log(`復元後、印は残っているか（無いはず）: ${markerExists()}`);

  return {
    scenario: 'interrupted',
    order: 'correct',
    markerPresentAfterInterruption: markerPresent,
    statusReportedProblem: /変異が当たったまま/.test(statusResult),
    baselineBlockedWhileMarkerPresent: baselineBlocked,
    recoveredFromMarkerOnly,
    restoredCorrectly,
  };
}

// ── 3'. 中断（誤った順序との対比） ──────────────────────────────────
//
// **これはハーネス本体の手順ではない。** `mutate-core.mjs` の `applyMutation`
// を呼ばず、ここだけで直線的に「変異を先に書き、印はまだ置かない」という
// 誤った順序を再現する。本体に順序を切り替えるフラグは無い — 抜け道は
// 次の穴になるので置かない。
function scenarioInterruptedWrongOrder() {
  section('selftest: 3´. 中断との対比（誤った順序: 変異 → 印。ハーネス本体には存在しない経路）');
  requireNoMarker('interrupted-wrong-order');
  ensureFixtureClean();

  log('-- ここで「変異だけ書いて、印を置く前にセッションが終わった」ことにする --');
  const original = readRepoFile(FIXTURE_REL);
  const mutated = original.split('LINE-TWO').join('LINE-TWO-WRONGORDER');
  writeRepoFile(FIXTURE_REL, mutated);
  // 印は書かない。誤った順序ではここまでで「終わった」ことになる。

  const markerPresent = markerExists();
  log(`印が残っているか: ${markerPresent}（正しい順序では true だった）`);
  log(`ファイルは変異したままか: ${readRepoFile(FIXTURE_REL).includes('LINE-TWO-WRONGORDER')}`);

  log('');
  log('-- `mutate.mjs status` を呼ぶ --');
  const statusResult = execFileSync(
    'node',
    [path.join(ROOT, '.claude/skills/mutation-testing/mutate.mjs'), 'status'],
    { cwd: ROOT, encoding: 'utf8' },
  ).toString();
  log(statusResult);

  log('');
  log('-- selftest による後始末（印が無いので、既知の原文へ直接戻す。ハーネスの通常経路の外） --');
  writeRepoFile(FIXTURE_REL, FIXTURE_ORIGINAL);
  const statusAfterCleanup = gitStatusPorcelainFor(FIXTURE_REL);
  log(`cleanup 後の git status --porcelain: ${JSON.stringify(statusAfterCleanup)}`);

  return {
    scenario: 'interrupted-wrong-order',
    order: 'wrong',
    markerPresentAfterInterruption: markerPresent,
    statusReportedNoProblem: /印は無い/.test(statusResult),
  };
}

// ── 4. 変異が成果物へ届いたか ────────────────────────────────────────
function scenarioDelivery() {
  section('selftest: 4. 変異が成果物へ届いたか（packages/core/src/excerpt.ts）');
  requireNoMarker('delivery');

  const spec = {
    id: 'selftest-delivery',
    file: 'packages/core/src/excerpt.ts',
    from: '文字省略。全',
    to: 'SELFTEST_MUTATED。全',
    expect: 1,
    target: '@alteroid/core',
    artifact: { file: 'packages/core/dist/index.js', contains: 'SELFTEST_MUTATED' },
  };

  log('-- 4a. 変異前: いま dist に SELFTEST_MUTATED が無いことを確認する（当然） --');
  const distAbs = absPath(spec.artifact.file);
  const before = fs.existsSync(distAbs) ? fs.readFileSync(distAbs, 'utf8') : '';
  log(`build 前の dist に含まれるか: ${before.includes('SELFTEST_MUTATED')}`);

  log('');
  log('-- 4b. 変異を当てる（build はまだ呼ばない） --');
  applyMutation(spec);

  log('');
  log('-- 4c. build をまだ呼ばずに、いまの dist をもう一度読む --');
  const distAfterMutationNoBuild = fs.existsSync(distAbs) ? fs.readFileSync(distAbs, 'utf8') : '';
  const deliveredBeforeBuild = distAfterMutationNoBuild.includes('SELFTEST_MUTATED');
  log(`build 前（ソースは変異済み）の dist に含まれるか: ${deliveredBeforeBuild}`);
  log(
    'この時点で参照できる「直近の build の exit code」は、前回 (baseline 相当) の 0 のままである。',
  );

  log('');
  log('-- 4d. build する --');
  const artifactResult = buildAndCheckArtifact(spec);

  log('');
  log(
    `対比: build 前 exit=0(前回分) / 届いた=${deliveredBeforeBuild} — ` +
      `build 後 exit=${artifactResult.buildExitCode} / 届いた=${artifactResult.artifactState === 'delivered'}。` +
      'exit code はどちらも 0 でありうるが、届いたかどうかは dist を実際に読まないと分からない。',
  );

  log('');
  log(
    '-- 4e. 復元する。dist の再 build と検証は restoreMutation 自身が後始末として行う（手動では呼ばない） --',
  );
  const { rebuildCheck } = restoreMutation();
  log(`restoreMutation が自動で行った後始末: ${rebuildCheck.reason}`);
  const distAfterRestore = fs.readFileSync(distAbs, 'utf8');
  const distMatchesRestoredSource = !distAfterRestore.includes('SELFTEST_MUTATED');
  log(`後始末後、dist に変異が残っていないか（残っていないはず）: ${distMatchesRestoredSource}`);

  return {
    scenario: 'delivery',
    deliveredBeforeBuild,
    deliveredAfterBuild: artifactResult.artifactState === 'delivered',
    buildExitCodeBeforeBuild: 0,
    buildExitCodeAfterBuild: artifactResult.buildExitCode,
    postRestoreRebuildOk: rebuildCheck.ok,
    postRestoreRebuildReason: rebuildCheck.reason,
    distCleanAfterRestore: distMatchesRestoredSource,
  };
}

// ── 5. 判定行の id 取り違えを検出する確認 ───────────────────────────
//
// マネージャーが実測で見つけた欠陥（判定行が固定の `M1:`/`M2:`/`M3:` を焼き込み、
// 変異の実際の id と無関係な種別番号を名乗っていた）の回帰確認。
//
// `M4` は生存想定・`M6` は検出想定にしてある（マネージャーの実測がこの2つの
// 番号を例に挙げたのに合わせた。番号そのものに意味は無い）。判定行が
// `spec.id` を正しく名乗っていることを確認し、さらに「旧実装（id を無視して
// 固定の M1/M2/M3 を返す版）を模した関数」でも同じ確認を通し、**旧実装では
// この確認が通らないこと**（＝この選択が実際に取り違えを捕まえる形になって
// いること）を示す。
function scenarioJudgementIdIntegrity() {
  section('selftest: 5. 判定行の id 取り違えを検出する確認（マネージャーの実測の回帰確認）');
  requireNoMarker('judgement-id-integrity');
  ensureFixtureClean();

  // M4: どこからも参照されない固定ファイルを変異させる → 生存想定。
  const survivingSpec = {
    id: 'M4',
    file: FIXTURE_REL,
    from: 'LINE-TWO',
    to: 'LINE-TWO-M4',
    expect: 1,
    target: null,
    testFilter: 'apps/cli/src/conversations',
  };
  // M6: 既存の実テスト（conversations.test.ts の
  // `expect(read()).toContain('会話はまだありません')`）が捕まえる実在の文言を
  // 変異させる → 検出想定。
  const detectedSpec = {
    id: 'M6',
    file: 'apps/cli/src/conversations.ts',
    from: '会話はまだありません。',
    to: 'M6_MUTATED。',
    expect: 1,
    target: null,
    testFilter: 'apps/cli/src/conversations',
  };

  const results = {};
  for (const spec of [survivingSpec, detectedSpec]) {
    log('');
    log(`== spec.id=${spec.id} を通す（testFilter=${spec.testFilter}） ==`);
    applyMutation(spec);
    // **投げる箇所が複数ある（判定失敗／spec.id の型検査／id 取り違え）。**
    // 復元せずに投げると、ソースが変異したまま・印も残ったまま次の spec・
    // 次の scenario へ進み、本当の原因（ここでの assertion）が後続の
    // `requireNoMarker(...)`（「印が既にある」）の失敗に化ける——これは
    // 依頼者から「setup の失敗に本題が隠れる形に自分で入るな」と渡された
    // ものと同じ形である（マネージャーの指摘、2026-08-23。以前はここだけ
    // `restoreMutation()` を通さず投げていた）。`applyMutation` の後を
    // まるごと try/finally で包み、`restoreMutation()` を finally で1回だけ
    // 呼ぶ形に統一する——投げても投げなくても、次のイテレーション・次の
    // scenario へ変異したツリーを持ち越さない。
    try {
      const artifactResult = buildAndCheckArtifact(spec);
      const testResult = runTests([spec.testFilter]);
      log('--- test 生ログ ここから ---');
      log(testResult.raw);
      log('--- test 生ログ ここまで ---');
      let judgement;
      try {
        judgement = judge(spec, artifactResult, testResult);
      } catch (err) {
        throw new HarnessError(`spec.id=${spec.id} の判定に失敗した: ${err.message}`);
      }
      log(`判定行: ${judgement.text}`);
      // **この比較を書くときの一般形の注意（#301 で見つかった）**: 両側が同じ
      // 経路で同じ文字列へ強制されると、比較そのものが恒真になる。
      // `judgement.text` 側は `formatJudgement` が `spec.id` をテンプレート
      // リテラルへ差し込む（`${mutationId}` → 非文字列も `String()` で強制）。
      // もし `spec.id` の型を確かめずに `.includes(spec.id)` を呼べば、`.includes`
      // に渡す引数も同じ強制を受ける。`spec.id` が `undefined` のとき、差し込む
      // 側は文字列 `"undefined"` になり、比べる側の引数も `"undefined"` へ
      // 強制されるので、**両側が一致してしまう**。この歯は「id 取り違えの回帰」
      // を捕まえるために在るのに、**いちばん名前が壊れている場合（id が無い）に
      // だけ鳴らない**という形になる——見た目は歯があるのに、最悪のケースで
      // だけ穴が開く。#301 の後は `applyMutation` の入り口（`validateSpec`）が
      // 非文字列・空文字の `id` を弾くので `judgement.text` 側にはもう
      // `undefined` は来ないはずだが、この歯自身も強制に頼らない形にしておく
      // ——次にここを触る人が、確認済みのはずの前提を静かに壊さないように。
      if (typeof spec.id !== 'string' || spec.id.length === 0) {
        throw new HarnessError(
          `spec.id が非空文字列でない（実際: ${JSON.stringify(spec.id)}）。この歯は文字列比較を` +
            '前提にしており、型を確かめずに includes へ渡すと強制に頼った恒真比較になる。',
        );
      }
      const mentionsOwnId = judgement.text.includes(spec.id);
      log(`判定行が spec.id (${spec.id}) を正しく名乗っているか: ${mentionsOwnId}`);
      if (!mentionsOwnId) {
        // この確認自体が回帰を検出する口である。ここで投げれば selftest 全体が
        // 非0で終わり、取り違えが起きていることが exit code からも分かる。
        throw new HarnessError(
          `判定行が spec.id を名乗っていない（id 取り違えの回帰）: ${judgement.text}`,
        );
      }
      results[spec.id] = { category: judgement.category, text: judgement.text, mentionsOwnId };
    } finally {
      restoreMutation();
    }
  }

  log('');
  log('-- 対照: 旧実装（id を無視して固定の M1/M2/M3 を返す版）を模した関数でも同じ確認を通す --');
  // マネージャーが実測した、修正前の実装をそのまま模したもの。spec.id を
  // 一切受け取らない。`mutate-core.mjs` 本体は書き換えない — ここだけの対照。
  function oldBuggyFormatJudgement(category) {
    if (category === '生存') return 'M2: 生存 — この歯はこの変異を検出できない';
    if (category === '検出') return 'M1: 検出 — この歯はこの変異を捕まえた';
    return 'M3: 不明 — 変異が成果物へ届いていない（生存ではない）';
  }
  const oldTextForM4 = oldBuggyFormatJudgement(results.M4.category);
  const oldTextForM6 = oldBuggyFormatJudgement(results.M6.category);
  const oldWouldMentionM4 = oldTextForM4.includes('M4');
  const oldWouldMentionM6 = oldTextForM6.includes('M6');
  log(`旧実装が M4 を名乗るか: ${oldWouldMentionM4}（旧実装が返す文言: "${oldTextForM4}"）`);
  log(`旧実装が M6 を名乗るか: ${oldWouldMentionM6}（旧実装が返す文言: "${oldTextForM6}"）`);
  log(
    `つまり、この確認を旧実装に対して行っていたら: ${
      !oldWouldMentionM4 || !oldWouldMentionM6
        ? '落ちていた（取り違えを捕まえる）'
        : '通っていた（捕まえない）'
    }`,
  );

  return {
    scenario: 'judgement-id-integrity',
    M4: results.M4,
    M6: results.M6,
    oldImplementationWouldHaveFailedThisCheck: !oldWouldMentionM4 || !oldWouldMentionM6,
  };
}

// ── 6. 後始末（dist 再 build）が失敗したとき、静かに終わらないことの確認 ──
//
// マネージャーの実測で見つかった欠陥: 復元後の再 build が落ちても、印は消え、
// `git status` は clean になり、`status` は「変異は無い」と言い切っていた
// （`dist` には変異が残ったまま）。`pnpm` が必ず失敗する PATH を用意し、
// **実プロセスとして** `mutate.mjs restore` を起こして確かめる
// （マネージャーが使ったのと同じ手 — PATH に exit 1 する擬似 `pnpm` を置く。
// `mutate-core.mjs` 本体には一切手を入れない。抜け道は本体ではなく外側に置く）。
function scenarioRebuildFailure() {
  section('selftest: 6. 後始末の build が落ちても、印が残り status が知らせることの確認');
  requireNoMarker('rebuild-failure');

  const spec = {
    id: 'selftest-rebuild-failure',
    file: 'packages/core/src/excerpt.ts',
    from: '文字省略。全',
    to: 'REBUILDCHECK_MUTATED。全',
    expect: 1,
    target: '@alteroid/core',
    artifact: { file: 'packages/core/dist/index.js', contains: 'REBUILDCHECK_MUTATED' },
  };

  log('-- 6a. 変異を当てる --');
  applyMutation(spec);

  const fakeBinDir = path.join(ROOT, '.mutation-testing', 'selftest-fake-bin');
  fs.mkdirSync(fakeBinDir, { recursive: true });
  const fakePnpmPath = path.join(fakeBinDir, 'pnpm');
  fs.writeFileSync(fakePnpmPath, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(fakePnpmPath, 0o755);
  log(`擬似 pnpm を用意した（常に exit 1）: ${fakePnpmPath}`);

  log('');
  log('-- 6b. この PATH で、実プロセスとして `mutate.mjs restore` を起こす --');
  const poisonedEnv = { ...process.env, PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}` };
  const restoreResult = spawnSync(
    'node',
    [path.join(ROOT, '.claude/skills/mutation-testing/mutate.mjs'), 'restore'],
    { cwd: ROOT, env: poisonedEnv, encoding: 'utf8' },
  );
  log(`restore の exit code: ${restoreResult.status}`);
  log(restoreResult.stdout ?? '');
  log(restoreResult.stderr ?? '');

  const markerLeft = markerExists();
  const artifactAbs = absPath(spec.artifact.file);
  const distStillHasMutation = fs
    .readFileSync(artifactAbs, 'utf8')
    .includes('REBUILDCHECK_MUTATED');
  log(`restore が非0 で終わったか: ${restoreResult.status !== 0}`);
  log(`印が残っているか: ${markerLeft}`);
  log(`dist に変異がまだ残っているか: ${distStillHasMutation}`);

  log('');
  log('-- 6c. 実プロセスとして `mutate.mjs status`（通常の PATH）を起こす --');
  let statusOut;
  let statusExit;
  try {
    statusOut = execFileSync(
      'node',
      [path.join(ROOT, '.claude/skills/mutation-testing/mutate.mjs'), 'status'],
      { cwd: ROOT, encoding: 'utf8' },
    ).toString();
    statusExit = 0;
  } catch (err) {
    statusOut = err.stdout?.toString() ?? '';
    statusExit = err.status;
  }
  log(`status の exit code: ${statusExit}`);
  log(statusOut);
  const statusReportedProblem = /変異が当たったまま/.test(statusOut);

  // **段階の区別が出ているかを確かめる。** マネージャーの2回目の実測: 後始末が
  // 落ちた時点でソース（git 管理下）は既に復元済みなのに、直さないと
  // `status` は「ソースが変異したまま」という説明（cp/md5sum を主経路とする
  // 手順）を出していた。次に来た人がその手順どおり cp して md5 が一致する
  // のを見ると「直った」と誤解し、dist の変異が残ったまま印を消しかねない。
  // ここでは、実際に dist だけが問題である段階では「ソースは既に復元済み」
  // と明示され、cp を主経路として出していないことを確認する。
  const statusMentionsDistStage = /ソース（git 管理下）は既に復元済みである/.test(statusOut);
  const statusShowsCpAsPrimary =
    /ハーネスを使わない復元手順:/.test(statusOut) && /\$ cp '/.test(statusOut);
  log(
    `status が「ソースは復元済み・dist 未確認」の段階だと明示しているか: ${statusMentionsDistStage}`,
  );
  log(`status が cp 手順を主経路として出しているか（出ていないはず）: ${statusShowsCpAsPrimary}`);

  log('');
  log('-- 6d. 擬似 pnpm を片付け、本物の pnpm で復元する --');
  fs.rmSync(fakeBinDir, { recursive: true, force: true });
  const finalRestore = restoreMutation();
  log(`後始末（本物の pnpm）: ${finalRestore.rebuildCheck.reason}`);
  const distCleanAfterRealRestore = !fs
    .readFileSync(artifactAbs, 'utf8')
    .includes('REBUILDCHECK_MUTATED');
  const gitStatusAfter = gitStatusPorcelainFor(spec.file);

  // ツリーは既にクリーンな状態まで戻したので、ここで投げても安全である。
  if (!statusMentionsDistStage || statusShowsCpAsPrimary) {
    throw new HarnessError(
      'status が段階を正しく伝えていない（ソースは復元済み・dist 未確認、のはずなのに cp を' +
        '主経路として出す、または段階の明示が無い）。マネージャーの2回目の実測が再現した。',
    );
  }

  return {
    scenario: 'rebuild-failure',
    restoreExitCodeWasNonZero: restoreResult.status !== 0,
    markerLeftAfterFailedRebuild: markerLeft,
    statusExitCodeAfterFailedRebuild: statusExit,
    statusReportedProblemAfterFailedRebuild: statusReportedProblem,
    distStillHadMutationRightAfterFailedRebuild: distStillHasMutation,
    statusMentionsDistStage,
    statusShowsCpAsPrimary,
    finalCleanupOk: finalRestore.rebuildCheck.ok,
    distCleanAfterRealRestore,
    gitCleanAfterRealRestore: gitStatusAfter.trim() === '',
  };
}

// ── 7. spec の形の検査（#301） ───────────────────────────────────────
//
// 受け入れ条件: id / file / from / to / expect が欠けている・型が違う・
// （id については）パス区切りや .. を含む spec は、すべて applyMutation の
// 入口（validateSpec）で拒否されること。**そして「落ちたこと」だけでなく
// 「何も書かれていないこと」も見る** — 拒否のたびに、控えディレクトリの
// ファイル数・印の有無・対象ファイルの md5 が変化していないことを確認する。
// 最後に、正しい spec は変わらず通ることも確認する（検査が過剰でないこと）。
function scenarioSpecValidation() {
  section('selftest: 7. spec の形の検査（#301）');
  requireNoMarker('spec-validation');
  ensureFixtureClean();

  const baseValid = {
    id: 'selftest-spec-validation',
    file: FIXTURE_REL,
    from: 'LINE-TWO',
    to: 'LINE-TWO-SPECVALID',
    expect: 1,
    target: null,
  };

  const invalidCases = [
    { label: 'id が無い', spec: { ...baseValid, id: undefined } },
    { label: 'id が空文字', spec: { ...baseValid, id: '' } },
    { label: 'id が非文字列（数値）', spec: { ...baseValid, id: 42 } },
    {
      label: 'id にパス区切り(/)と..を含む（BACKUP_DIR 脱出を試みる）',
      spec: { ...baseValid, id: '../escape' },
    },
    { label: 'id にパス区切り(\\)を含む', spec: { ...baseValid, id: 'a\\b' } },
    { label: 'id に .. を含む（区切りなし）', spec: { ...baseValid, id: 'a..b' } },
    { label: 'file が無い', spec: { ...baseValid, file: undefined } },
    { label: 'file が空文字', spec: { ...baseValid, file: '' } },
    { label: 'from が無い', spec: { ...baseValid, from: undefined } },
    { label: 'from が空文字', spec: { ...baseValid, from: '' } },
    { label: 'to が無い（非文字列）', spec: { ...baseValid, to: undefined } },
    { label: 'to が非文字列（数値0）', spec: { ...baseValid, to: 0 } },
    { label: 'expect が無い', spec: { ...baseValid, expect: undefined } },
    { label: 'expect が0', spec: { ...baseValid, expect: 0 } },
    { label: 'expect が非整数（1.5）', spec: { ...baseValid, expect: 1.5 } },
    { label: 'spec が null', spec: null },
    { label: 'spec が配列', spec: [] },
  ];

  const preMd5 = md5(readRepoFile(FIXTURE_REL));
  const backupDir = path.join(ROOT, '.mutation-testing', 'backups');
  const preBackupCount = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).length : 0;

  const results = [];
  for (const { label, spec } of invalidCases) {
    let rejected = false;
    let message = null;
    try {
      applyMutation(spec);
      // 拒否されなかった場合（想定外）、後始末しないと次のケースが
      // 「印が既にある」で失敗し、本当の原因が分からなくなる。
      restoreMutation();
    } catch (err) {
      rejected = err instanceof HarnessError;
      message = err.message;
    }
    const markerAfter = markerExists();
    const backupCountAfter = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).length : 0;
    const fileMd5After = md5(readRepoFile(FIXTURE_REL));
    const nothingWritten =
      !markerAfter && backupCountAfter === preBackupCount && fileMd5After === preMd5;
    log(
      `[${label}] 拒否=${rejected} / 何も書かれていない=${nothingWritten}` +
        (message ? ` / メッセージ冒頭: ${message.slice(0, 50).replace(/\n/g, ' ')}...` : ''),
    );
    results.push({ label, rejected, nothingWritten });
  }

  log('');
  log('-- 対照: 正しい spec は変わらず通ることを確認する（検査が過剰になっていないか） --');
  applyMutation(baseValid);
  const appliedOk = readRepoFile(FIXTURE_REL).includes('LINE-TWO-SPECVALID');
  restoreMutation();
  const cleanAfterward = gitStatusPorcelainFor(FIXTURE_REL).trim() === '' && !markerExists();

  const allRejectedAndClean = results.every((r) => r.rejected && r.nothingWritten);
  if (!allRejectedAndClean) {
    throw new HarnessError(
      `spec 検査の回帰: 拒否されるべき spec が通った、または拒否時に何かが書かれた。詳細: ${JSON.stringify(
        results.filter((r) => !r.rejected || !r.nothingWritten),
      )}`,
    );
  }
  if (!appliedOk) {
    throw new HarnessError('spec 検査が過剰: 正しい spec まで拒否している。');
  }
  // **`cleanAfterward` も、上の2つと同じく落とす口を持たせる。** 実質は
  // no-op の歯である——ここへ来た時点で `restoreMutation()` 自身の歯4
  // （復元後 md5 の照合）・照合2（12c: 復元後の git status --porcelain）が
  // 先に投げているはずなので、まず鳴らない。それでも assert せずに値だけ
  // 返す形にすると、結果に並ぶ真偽値のうち「確かめた値」と「計算しただけの
  // 値」が見分けられず、読み手は隣にある判定を実測として読んでしまう
  // （マネージャーの指摘、2026-08-23。AGENTS.md「報告の形」の同じ形）。
  // no-op の歯は安い——ここに置く。
  if (!cleanAfterward) {
    throw new HarnessError(
      '対照ケース（正しい spec）の後始末でツリーが汚れたまま、または印が残ったまま終わった。' +
        'restoreMutation() 自身の歯（md5照合・git status 照合）が先に投げているはずなので、' +
        'ここへ到達すること自体が別の回帰の疑いがある。',
    );
  }

  return {
    scenario: 'spec-validation',
    allRejectedAndClean,
    cases: results,
    validSpecStillWorks: appliedOk,
    cleanAfterward,
  };
}

// ── 8. 判定の禁止語検査が id の部分文字列に当たらないこと（#348） ─────
//
// 実測（#348 本文）: `bypass` の中の `pass`、`broken` の中の `ok`、`lookup` の
// 中の `ok` が禁止語判定に当たり、ごく自然な変異 id が `judge()` で拒否
// されていた。**検査そのものを外してはいけない**（Issue に明記）ので、
// 両方向を確認する:
//   (a) bypass を含む自然な id は通ること（#348 の回帰確認そのもの）
//   (b) `ok` / `pass` が単独の語として現れる id（`m1-ok` のような、`-` や
//       端で区切られた形）は、依然として拒否されること
// (b) が無いと、この歯は「検査を弱めて壊す」方向の回帰（例: 検査を丸ごと
// 外す）を検出できない——(a) だけでは「常に通る」実装でも緑になってしまう。
function scenarioJudgementForbiddenWordBoundary() {
  section('selftest: 8. 判定の禁止語検査が id の部分文字列に当たらないこと（#348）');
  requireNoMarker('judgement-forbidden-word-boundary');
  ensureFixtureClean();

  function runJudgementFor(id) {
    const spec = {
      id,
      file: 'apps/cli/src/conversations.ts',
      from: '会話はまだありません。',
      to: `SELFTEST_348_${id.replace(/[^A-Za-z0-9]/g, '_')}_MUTATED。`,
      expect: 1,
      target: null,
      testFilter: 'apps/cli/src/conversations',
    };
    log('');
    log(`== id="${id}" を通す ==`);
    applyMutation(spec);
    try {
      const artifactResult = buildAndCheckArtifact(spec);
      const testResult = runTests([spec.testFilter]);
      log('--- test 生ログ ここから ---');
      log(testResult.raw);
      log('--- test 生ログ ここまで ---');
      try {
        const judgement = judge(spec, artifactResult, testResult);
        log(`judge() が例外を投げずに終わった: ${judgement.text}`);
        return { threw: false, category: judgement.category, text: judgement.text };
      } catch (err) {
        log(`judge() が例外で拒否した: ${err.message}`);
        return { threw: true, message: err.message };
      }
    } finally {
      restoreMutation();
    }
  }

  // (a) 自然な id — bypass / broken / lookup を部分文字列に含むが、
  //     禁止語（ok / pass）は英数字に挟まれている。通るはず。
  const naturalIds = ['m318a-01-guard-bypass', 'm-broken-guard', 'lookup-drop'];
  const naturalResults = {};
  for (const id of naturalIds) {
    naturalResults[id] = runJudgementFor(id);
  }

  // (b) 単独の語として ok / pass が現れる id — `-` や文字列の端で区切られて
  //     いる。禁止語検査が生きているなら拒否されるはず。
  const boundaryIds = ['token-ok', 'm1-ok'];
  const boundaryResults = {};
  for (const id of boundaryIds) {
    boundaryResults[id] = runJudgementFor(id);
  }

  for (const id of naturalIds) {
    if (naturalResults[id].threw) {
      throw new HarnessError(
        `id="${id}"（自然な変異名。bypass/broken/lookup を含む）が禁止語検査で拒否された` +
          `（#348 の回帰）: ${naturalResults[id].message}`,
      );
    }
  }
  for (const id of boundaryIds) {
    const result = boundaryResults[id];
    if (!result.threw) {
      throw new HarnessError(
        `id="${id}"（ok/pass が単独の語として現れる）が禁止語検査を素通りした` +
          '（検査を外す方向の回帰。#348 は検査を外してはいけないと明示している）',
      );
    }
    // 拒否メッセージが id 由来と分かる形になっているか（#348 の要求）。
    if (!result.message.includes(id)) {
      throw new HarnessError(
        `id="${id}" の拒否メッセージが id 由来と分かる形になっていない: ${result.message}`,
      );
    }
  }

  return {
    scenario: 'judgement-forbidden-word-boundary',
    naturalIds: Object.fromEntries(
      naturalIds.map((id) => [
        id,
        { passed: !naturalResults[id].threw, category: naturalResults[id].category },
      ]),
    ),
    boundaryIds: Object.fromEntries(
      boundaryIds.map((id) => [
        id,
        {
          rejected: boundaryResults[id].threw,
          messageMentionsId: boundaryResults[id].message?.includes(id) ?? false,
        },
      ]),
    ),
  };
}

// ── 9. restore の12c: 変異前の git status と比較する（HEAD ではない）（#321） ──
//
// 受け入れ条件:
//   (a) 対象ファイル自身に、変異とは無関係な正当な未コミット変更が在っても、
//       復元は完全に成功し、印は消える（#321 の症状そのものの回帰確認。
//       直す前はここで印が `stage: 'source-mutated'` のまま残っていた）
//   (b) 12c が本当に落ちるべきとき（復元後に対象ファイルの git 管理状態が
//       変異前と食い違ったとき）には、依然として落ちること。塞ぎすぎて
//       検査が死んでいないことの裏取り。このとき印は
//       `stage: 'dist-unverified'` を名乗っていること（12b の直後に印を
//       進めるようにした、この PR のもう一つの変更点の確認）——
//       `stage: 'source-mutated'` のままだと、次に来た人が #321 と同じ形で
//       誤読する
function scenarioRestoreStatusComparison() {
  section('selftest: 9. restore の12cが変異前の git status と比較すること（#321）');
  requireNoMarker('restore-status-comparison');
  ensureFixtureClean();

  // (a) 対象ファイル自身に無関係な未コミット変更を先に作る。
  const foreignChangeContent = `${FIXTURE_ORIGINAL}// SELFTEST-321-FOREIGN-UNCOMMITTED-CHANGE\n`;
  writeRepoFile(FIXTURE_REL, foreignChangeContent);
  const statusWithForeignChange = gitStatusPorcelainFor(FIXTURE_REL);
  log(
    `-- 9a. 変異とは無関係な未コミット変更を入れた。git status: ${JSON.stringify(statusWithForeignChange)} --`,
  );
  if (statusWithForeignChange.trim() === '') {
    throw new HarnessError(
      'selftest の前提が崩れている: 未コミット変更を入れたのに git status --porcelain が空。' +
        '.gitignore や fixture の場所を確認すること。',
    );
  }

  const spec = {
    id: 'selftest-321-foreign-change',
    file: FIXTURE_REL,
    from: 'LINE-TWO',
    to: 'LINE-TWO-321TEST',
    expect: 1,
    target: null,
  };
  applyMutation(spec);
  log('-- 9b. apply → restore を通す。対象ファイルへの無関係な変更があっても復元は成功するはず --');
  restoreMutation();
  const contentAfterRestore = readRepoFile(FIXTURE_REL);
  const restoredWithForeignChangeIntact = contentAfterRestore === foreignChangeContent;
  const markerGoneAfterRestore = !markerExists();
  log(
    `復元後、無関係な未コミット変更が残っているか（残るはず）: ${restoredWithForeignChangeIntact}`,
  );
  log(`復元後、印は消えているか（消えるはず）: ${markerGoneAfterRestore}`);

  // 後始末: selftest 用の無関係な変更を取り除き、fixture を元に戻す。
  writeRepoFile(FIXTURE_REL, FIXTURE_ORIGINAL);
  const statusAfterCleanupA = gitStatusPorcelainFor(FIXTURE_REL);
  log(`selftest 後始末後の git status: ${JSON.stringify(statusAfterCleanupA)}`);

  if (!restoredWithForeignChangeIntact || !markerGoneAfterRestore) {
    throw new HarnessError(
      '対象ファイルに正当な未コミット変更が在ると、復元が完全に成功しても印が残る（#321 の回帰）。',
    );
  }

  // (b) 対比: 12c が本当に落ちるべきときに落ちることを確認する。復元の
  //     「最中」に対象ファイルの git 管理状態を外から変える（`git add`）
  //     ——`restoreMutation` はワークツリーの中身を常に原文へ書き戻すので、
  //     この介入は「復元後に、そのファイルの git 管理状態が変異前と食い
  //     違った」という状況を作る（SKILL.md「同じツリーで HEAD を動かすのも
  //     汚染に見える」と同型の、ファイルの staging 版）。
  ensureFixtureClean();
  applyMutation(spec);
  log('');
  log(
    '-- 9c. 対比: 変異が当たっている最中に、外から対象ファイルを git add する（意図的な注入） --',
  );
  execFileSync('git', ['add', '--', FIXTURE_REL], { cwd: ROOT });
  const statusAfterForeignAdd = gitStatusPorcelainFor(FIXTURE_REL);
  log(`git add 直後の git status: ${JSON.stringify(statusAfterForeignAdd)}`);

  let restoreThrew = false;
  let restoreErrorMessage = null;
  try {
    restoreMutation();
    log('⚠ restore が例外を投げずに終わった（想定外）');
  } catch (err) {
    restoreThrew = true;
    restoreErrorMessage = err.message;
    log(`restore は12cで例外を投げた（想定どおり）:\n${err.message}`);
  }

  // このとき印は残るが、`stage` が `dist-unverified` を名乗っているはず
  // （12b の直後に進めるようにしたため）。`source-mutated` のままだと
  // #321 と同じ形で「変異が当たったまま」と誤読される。
  let stageAfterFailure = null;
  if (markerExists()) {
    const marker = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'MUTATION-IN-PROGRESS.json'), 'utf8'),
    );
    stageAfterFailure = marker.stage ?? 'source-mutated';
  }
  log(`12cで落ちた後、印の stage: ${stageAfterFailure}`);
  log(
    `12cで落ちた後、対象ファイルの内容は既に原文に戻っているはず（md5照合はこの前に通っている）: ` +
      `${readRepoFile(FIXTURE_REL) === FIXTURE_ORIGINAL}`,
  );

  // 片付ける: 外から加えた git add を取り消し、正しい状態で restore を
  // やり直す（rebuildAndVerify は target: null なので即 ok。べき等性の確認
  // でもある）。
  execFileSync('git', ['restore', '--staged', '--', FIXTURE_REL], { cwd: ROOT });
  const statusAfterUnstage = gitStatusPorcelainFor(FIXTURE_REL);
  log('');
  log(`-- 9d. git add を取り消した。git status: ${JSON.stringify(statusAfterUnstage)} --`);
  const retryResult = restoreMutation();
  const cleanAfterRetry = gitStatusPorcelainFor(FIXTURE_REL).trim() === '' && !markerExists();
  log(`やり直した restore の後始末: ${retryResult.rebuildCheck.reason}`);
  log(`最終的にツリーはクリーンか: ${cleanAfterRetry}`);

  if (!restoreThrew) {
    throw new HarnessError(
      '12cが本当に落ちるべき状況（復元後に対象ファイルの git 管理状態が変異前と食い違った）で' +
        '落ちなかった。塞ぎすぎて検査が死んでいる疑いがある。',
    );
  }
  if (stageAfterFailure !== 'dist-unverified') {
    throw new HarnessError(
      `12cで落ちたとき、印の stage が 'dist-unverified' を名乗っていない（実際: ${stageAfterFailure}）。` +
        'ソース復元（12b）は成功しているのに、印が古い段階のままだと #321 と同じ誤読が起きる。',
    );
  }
  if (!cleanAfterRetry) {
    throw new HarnessError('片付け後の再 restore でツリーが完全にクリーンにならなかった。');
  }

  return {
    scenario: 'restore-status-comparison',
    foreignUncommittedChange: {
      restoredWithForeignChangeIntact,
      markerGoneAfterRestore,
    },
    legitimateFailure: {
      restoreThrew,
      stageAfterFailure,
      messageIncludes12c: restoreErrorMessage?.includes('[12c]') ?? false,
      cleanAfterRetry,
    },
  };
}

// ── 10. undelivered の gate（#444） ──────────────────────────────────
//
// 受け入れ条件: `undelivered` を「テスト結果に委ねてよいか」で狭く gate する
// 分かれ方と、**gate を通ったときに警告の注記が実際に生成されて判定行に載る
// こと**。併せて、gate が `testsRanCleanly` の検査より*前*に効くこと。
//
// **なぜ build を1度も回さないか。** `judge()` は `spec` / `artifactResult` /
// `testResult` を受け取るだけで、ファイルもプロセスも触らない。⟹ 合成した
// `artifactResult` を渡せば、gate に関わる分岐を表で測れる。この器は資源が
// 細く、build を挟むシナリオは pids が尽きて落ちうるので、**純関数として
// 測れるものに build を挟まない**（`spec-validation` と同じ方針。あちらは
// fixture を書くが、ここはファイルを1つも触らない）。
//
// **⚠️ ここが測るのは `judge()` であって、`artifactResult` を作る側ではない。**
// 実際のツリーから `buildAndCheckArtifact` が `artifactState` /
// `buildExitCode` / `artifactFileExists` を正しく作ることは範囲外である
// （成果物検査そのものは `delivery` シナリオが実 build で見る）。
//
// **⚠️ 注記は「全文」で測る。部分文字列のマーカーでは足りない。** 最初の版は
// 「この判定はテスト結果に委ねている」「spec 側の誤りの可能性がある」の2句が
// 在ることだけを見ていたが、それでは**その間に挟まった「変異がこの成果物へ
// 本当に届いたことまでは確認できていない」を丸ごと消しても緑のまま**になる
// （レビューの指摘）。注記の存在理由はその一文なので、全文を受け入れ条件に
// 置く。文言を変えるときはここも一緒に変えること — それは回帰ではなく契約の
// 変更である。
//
// **⚠️ 「注記が在るか」ではなく「末尾が期待どおりか」で見る。** `includes` だけ
// だと、`formatJudgement` の追記が `if (context.gateNote)` から
// `if (context.gateNote !== undefined)` へ変わって `null` が混ざり、末尾に
// 空行が生えても素通りする（`join('\n')` が `null` を空文字へ畳むため）。
// `endsWith` で末尾そのものを固定すればこれが鳴る。
//
// **⚠️ 「注記が0件だった」で緑にしない。** 期待が「注記が出ない」行ばかりでも
// 表は全部通る。だから「gate を通った行で注記が実際に生成された」件数を別に
// 数えて、0なら落とす。測った0は「入らない」を保証しない。

const GATE_TESTS_RED = {
  exitCode: 1,
  raw: 'Test Files  1 failed | 152 passed (153)\nTests  1 failed | 3094 passed (3095)\n',
  filesLine: 'Test Files  1 failed | 152 passed (153)',
  testsLine: 'Tests  1 failed | 3094 passed (3095)',
};

const GATE_TESTS_GREEN = {
  exitCode: 0,
  raw: 'Test Files  153 passed (153)\nTests  3095 passed (3095)\n',
  filesLine: 'Test Files  153 passed (153)',
  testsLine: 'Tests  3095 passed (3095)',
};

// 集計行が取れなかった状態（「落ちた」のか「1本も走らなかった」のか区別
// できない）。`decideJudgementCategory` はここで `HarnessError` を投げる。
const GATE_TESTS_UNREADABLE = {
  exitCode: 1,
  raw: '（集計行が出ないまま終わった）\n',
  filesLine: null,
  testsLine: null,
};

// gate を通ったときに判定行の末尾へ付く注記の**全文**。
// 生成側（`describeUndeliveredTestResultGate`）から実際の出力を取り出して
// 置いたものであって、生成側の式をここで組み立て直してはいない——両側を
// 同じ経路で作ると比較が恒真になる（`SKILL.md`「比較の両側が同じ経路で
// 同じ値へ強制されると、比較そのものが恒真になる」）。
const GATE_NOTE_TEXT =
  '⚠️ build は exit 0 で終わり、対象ファイルの存在も確認できたが、' +
  'spec.artifact.contains の照合だけが外れたため、この判定はテスト結果に委ねている（#444）。' +
  '変異がこの成果物へ本当に届いたことまでは確認できていない。' +
  'spec.artifact.contains の誤字・死コード除去等、spec 側の誤りの可能性がある。';

function scenarioJudgementUndeliveredGate() {
  section('selftest: 10. undelivered の gate と、その警告の注記（#444）');
  requireNoMarker('judgement-undelivered-gate');

  const gatePassing = {
    artifactState: 'undelivered',
    buildExitCode: 0,
    artifactFileExists: true,
  };

  const cases = [
    {
      id: 'selftest-gate-open-red',
      label: '3条件を全部満たす（build exit 0 / ファイル実在 / 照合だけ外れ）+ テストが赤',
      artifactResult: gatePassing,
      testResult: GATE_TESTS_RED,
      expectCategory: '検出',
      expectGateNote: true,
    },
    {
      id: 'selftest-gate-open-green',
      label: '3条件を全部満たす + テストが緑',
      artifactResult: gatePassing,
      testResult: GATE_TESTS_GREEN,
      expectCategory: '生存',
      expectGateNote: true,
    },
    {
      // **build が落ちたときに成果物ファイルが残っているかを、コードは保証して
      // いない**（tsup の clean が先に走るので実際は消えることが多い、という
      // だけ）。だからここは `artifactFileExists: true` のまま build だけを
      // 落として、`buildExitCode` が独立した安全弁として効くことを測る。
      id: 'selftest-gate-build-failed',
      label: 'build が失敗（buildExitCode !== 0）— テストが赤でも不明のまま',
      artifactResult: { artifactState: 'undelivered', buildExitCode: 1, artifactFileExists: true },
      testResult: GATE_TESTS_RED,
      expectCategory: '不明',
      expectGateNote: false,
    },
    {
      id: 'selftest-gate-file-missing',
      label: '成果物ファイルが存在しない（artifactFileExists === false）— テストが赤でも不明のまま',
      artifactResult: { artifactState: 'undelivered', buildExitCode: 0, artifactFileExists: false },
      testResult: GATE_TESTS_RED,
      expectCategory: '不明',
      expectGateNote: false,
    },
    // ── 対照: `undelivered` 以外は gate に触れない（検査が過剰でないこと） ──
    {
      id: 'selftest-gate-delivered-red',
      label: '対照: delivered（届いたと確認できた）+ テストが赤',
      artifactResult: { artifactState: 'delivered', buildExitCode: 0, artifactFileExists: true },
      testResult: GATE_TESTS_RED,
      expectCategory: '検出',
      expectGateNote: false,
    },
    {
      id: 'selftest-gate-delivered-green',
      label: '対照: delivered + テストが緑',
      artifactResult: { artifactState: 'delivered', buildExitCode: 0, artifactFileExists: true },
      testResult: GATE_TESTS_GREEN,
      expectCategory: '生存',
      expectGateNote: false,
    },
    {
      id: 'selftest-gate-not-checked',
      label: '対照: not-checked（spec.artifact 未指定で build の成否しか見ていない）+ テストが赤',
      artifactResult: { artifactState: 'not-checked', buildExitCode: 0 },
      testResult: GATE_TESTS_RED,
      expectCategory: '検出',
      expectGateNote: false,
    },
    {
      id: 'selftest-gate-not-applicable',
      label: '対照: not-applicable（target が無く build を飛ばした）+ テストが緑',
      artifactResult: { artifactState: 'not-applicable', buildSkipped: true },
      testResult: GATE_TESTS_GREEN,
      expectCategory: '生存',
      expectGateNote: false,
    },
    // ── 集計行が読めないとき（gate と `testsRanCleanly` の前後関係） ──
    {
      // gate を通った先は共通ロジックなので、集計行が読めなければ
      // 「判定を出さない」（投げる）まで含めて共通である。**委ねた先で
      // 黙って緑にしない**ことをここで固定する。
      id: 'selftest-gate-open-unreadable',
      label: 'gate を通ったが集計行が読めない — 判定を出さずに投げる',
      artifactResult: gatePassing,
      testResult: GATE_TESTS_UNREADABLE,
      expectError: true,
    },
    {
      id: 'selftest-gate-delivered-unreadable',
      label: '対照: delivered で集計行が読めない — 同じく投げる',
      artifactResult: { artifactState: 'delivered', buildExitCode: 0, artifactFileExists: true },
      testResult: GATE_TESTS_UNREADABLE,
      expectError: true,
    },
    {
      // **gate は `testsRanCleanly` の検査より前に効く。** gate を通らない
      // `undelivered` は、集計行が読めなくても投げずに `不明` を返す
      // （テスト結果を一切見ないため）。順序が入れ替わるとここが鳴る。
      id: 'selftest-gate-blocked-unreadable',
      label: 'gate を通らない undelivered は、集計行が読めなくても投げずに不明',
      artifactResult: { artifactState: 'undelivered', buildExitCode: 1, artifactFileExists: false },
      testResult: GATE_TESTS_UNREADABLE,
      expectCategory: '不明',
      expectGateNote: false,
    },
  ];

  const results = [];
  for (const c of cases) {
    let category = null;
    let text = null;
    let error = null;
    try {
      const judgement = judge({ id: c.id }, c.artifactResult, c.testResult);
      category = judgement.category;
      text = judgement.text;
    } catch (err) {
      error = err.message;
    }

    // 判定行の**末尾**を固定する。`includes` ではなく `endsWith` なのは、
    // 追記部に余計なものが生えたことを見るため（上の doc）。
    const expectedTail = c.expectGateNote
      ? `artifactState: ${c.artifactResult.artifactState}\n${GATE_NOTE_TEXT}`
      : `artifactState: ${c.artifactResult.artifactState}`;

    const threw = error !== null;
    const errorOk = c.expectError === true ? threw && error.includes('テストの集計行') : !threw;
    const categoryOk = c.expectError === true ? category === null : category === c.expectCategory;
    const tailOk = c.expectError === true ? null : text !== null && text.endsWith(expectedTail);
    const hasGateNote = text === null ? null : text.includes(GATE_NOTE_TEXT);
    const gateNoteOk = c.expectError === true ? null : hasGateNote === c.expectGateNote;

    log(
      `[${c.label}] 判定=${category ?? `(投げた)`} 期待=${c.expectCategory ?? '(投げること)'} ` +
        `/ 末尾が期待どおり=${tailOk} / 注記=${hasGateNote} 期待=${c.expectGateNote ?? '—'} ` +
        `/ 投げ方=${errorOk}`,
    );
    results.push({
      id: c.id,
      label: c.label,
      category,
      expectCategory: c.expectCategory ?? null,
      expectError: c.expectError === true,
      categoryOk,
      tailOk,
      hasGateNote,
      expectGateNote: c.expectGateNote ?? null,
      gateNoteOk,
      errorOk,
      error,
    });
  }

  const bad = results.filter(
    (r) =>
      !r.categoryOk ||
      !r.errorOk ||
      (r.expectError ? false : r.tailOk !== true || r.gateNoteOk !== true),
  );
  if (bad.length > 0) {
    throw new HarnessError(
      `undelivered の gate の回帰: ${bad.length}/${results.length} 件が期待と違う。` +
        `詳細: ${JSON.stringify(bad)}`,
    );
  }

  // **この表が「何も測っていない」形に退化していないことを、別に測る。**
  // 期待が「注記が出ない」行だけになったり、注記の生成側が黙って `null` を
  // 返すようになったりしても、上の照合だけなら全部通ってしまう。
  const gateNoteGeneratedCount = results.filter((r) => r.hasGateNote === true).length;
  if (gateNoteGeneratedCount === 0) {
    throw new HarnessError(
      '警告の注記が一度も生成されなかった。gate を通る行が表から消えたか、' +
        'describeUndeliveredTestResultGate が黙って null を返している。' +
        '「注記が0件」を緑にしないための歯である。',
    );
  }

  // 同じ理由で、投げる経路が表から消えていないことも数える。
  const throwCasesCount = results.filter((r) => r.expectError && r.errorOk).length;
  if (throwCasesCount === 0) {
    throw new HarnessError(
      '集計行が読めないときに投げる経路が一度も踏まれなかった。表からその行が消えている。',
    );
  }

  // このシナリオはファイルを1つも触らない。no-op の歯だが安いので置く
  // （`spec-validation` の `cleanAfterward` と同じ理由 — 確かめた値と
  // 計算しただけの値を、読み手が見分けられるようにする）。
  const markerAfter = markerExists();
  if (markerAfter) {
    throw new HarnessError(
      'このシナリオはファイルを1つも触らないはずなのに、印が生まれた。' +
        'judge() が副作用を持つようになった疑いがある。',
    );
  }

  return {
    scenario: 'judgement-undelivered-gate',
    cases: results,
    gateNoteGeneratedCount,
    throwCasesCount,
    markerAfter,
  };
}

const SCENARIO_FNS = {
  'backup-corruption': scenarioBackupCorruption,
  'weak-tooth': scenarioWeakTooth,
  interrupted: scenarioInterrupted,
  'interrupted-wrong-order': scenarioInterruptedWrongOrder,
  delivery: scenarioDelivery,
  'judgement-id-integrity': scenarioJudgementIdIntegrity,
  'rebuild-failure': scenarioRebuildFailure,
  'spec-validation': scenarioSpecValidation,
  'judgement-forbidden-word-boundary': scenarioJudgementForbiddenWordBoundary,
  'restore-status-comparison': scenarioRestoreStatusComparison,
  'judgement-undelivered-gate': scenarioJudgementUndeliveredGate,
};

export function runSelftestScenario(scenario) {
  const names = scenario === 'all' ? Object.keys(SCENARIO_FNS) : [scenario];
  const results = [];
  for (const name of names) {
    results.push(SCENARIO_FNS[name]());
  }
  return results;
}
