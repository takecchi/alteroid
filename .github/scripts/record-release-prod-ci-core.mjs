/**
 * `record-release-prod-ci.mjs` の組み立てだけを切り出したもの（Issue #1207 の (3)）。
 * **ネットワークを持たない、純粋な関数だけを置く。**
 *
 * ## これは何を解決するために在るか
 *
 * `release/prod` への夜間反映（`.github/workflows/release-prod.yml` →
 * `.github/scripts/reflect-release-prod.sh`）は、`main` の CI を一切見ていない。
 * その反映先の中核は逐語で「**SHA が違えば push する。それだけである。**」
 * （`grep -Fn -- 'SHA が違えば push する。それだけである。' .github/scripts/reflect-release-prod.sh`）
 * ——ここに手を入れない、というのがこの変更全体の前提である。
 *
 * ## ⛔ 決定は「止めない。記録するだけ」である（候補B。teto の決定）
 *
 * 「赤なら止める」門は**作らない**。実測が全部不利だからである（Issue #1207 の
 * 調査。観測期間 2026-08-18〜09-17 の28日）:
 *
 * - 門が発動する場面（`main` の post-merge CI が赤い状態で夜間反映が走る）は
 *   **28日で0回**——赤い区間と反映の時刻が一度も重ならなかった
 * - 「もし発動していたら」を仮に数えても、赤くなった6件のうち**5件は flaky
 *   による誤停止**で、翌日には自然に緑へ戻っている
 * - **唯一の本物の障害（Issue #734）は、この門では拾えない**——CI 自体は緑の
 *   まま本番だけが壊れた事例で、CI の赤を見る門は最初から対象外だった
 * - 仮に発動したとすると、反映は夜1回しか無いので**止まった場合の空白は最長で
 *   丸1日**になる——デプロイが止まる損失のほうが、拾えなかった1件の障害より
 *   高くつく
 *
 * ⟹ **やるのは記録だけ。** 毎晩、実際に `release/prod` へ出た sha の CI 判定を
 * 機械可読な1行として残し、赤いときだけ既存の警報 Issue（後述）へ「この赤は
 * 本番へ出た」という一言を足す。**新しい停止機構は増やさない。**
 *
 * ## 判定器は再利用する。再実装しない
 *
 * CI が「本当に緑か」を sha から判定するロジックは `scripts/check-pr-green.mjs`
 * の `judgeSha` を**そのまま呼ぶ**（Issue #1227 で世代選びと4値化が直っている
 * 実装）。ここで2本目の判定器を書くと、世代選び（workflow名＋event の組・
 * `created_at`/`id` の tiebreak）が2箇所でじわじわずれる——
 * `check-pr-green-core.mjs` 自身がこの手の食い違いで複数回直っている
 * （#933 → #1225）。
 *
 * ## `out-of-scope` は「異常なし」である——ここが誤読しやすい
 *
 * `judgeSha` が判定する sha は、夜間反映で実際に `release/prod` へ出た sha
 * （＝ `main` への `push` イベントで作られた run）である。**`push` の run では
 * `pull_request` 専用 job（`base-overlap` / `pr-origin` 等）が設計どおり
 * skip される**ので、健全な `main` HEAD であっても `green` にはならず
 * `out-of-scope` になる（`check-pr-green-core.mjs` の `evaluatePrGreen` を
 * 参照）。⟹ **`out-of-scope` は赤でも判定不能でもなく「異常なし」の意味で
 * ある。** ここを他の非 green と同列に扱うと、毎晩ほぼ確実に鳴る偽の赤を
 * 作ることになる。
 *
 * 実測（このリポジトリの実際の sha で確認済み）:
 *
 * - 健全な main HEAD `ecd1674e09c72b245db21b225f56ac590fd336af` ⟹ `out-of-scope`
 * - 本物の赤 `3ca63973b7dae66b48b033a962a92e19c7e73e63` ⟹ `red`
 *   （`main-ci-alarm.test.ts` が使っている実測固定値と同じ sha。#1207 の表に
 *   在る、赤い区間が最長だった回）
 *
 * ## 記録行は grep で数える前提の形にしてある
 *
 * `buildRecordLine` が組み立てる1行は **`release-prod-ci-record: ` で始まる**。
 * 後からこの文字列で探す（数える手順は `record-release-prod-ci.mjs` の doc に
 * 具体的なコマンドで書いてある）。**この接頭辞を変えると、過去の記録が
 * grep から見えなくなる。**
 *
 * ## 赤のときのコメントは main-ci-alarm の鍵をそのまま使う
 *
 * `main-ci-alarm.mjs`（Issue #1207 の (1)）が `main` の post-merge CI の赤を
 * 見つけて Issue を立てる。その Issue の鍵は「workflow名 ＋ head_sha」
 * （`scripts/main-ci-alarm-core.mjs` の `alarmKey` / `alarmMarker`）——ここでは
 * その**鍵の作り方を写さず import して使う**。写すと鍵の形が2箇所でずれ、
 * 同じ sha なのに別の鍵を作って「見つからない」が起きる。
 *
 * **新しい Issue は立てない。** 見つかった警報 Issue が open で在るときだけ
 * コメントを足す。無ければ「durable な記録を付けられなかった」と1行出して
 * 終わる（門ではないので、記録できなかったこと自体は反映を止めない）。
 *
 * ## なぜ Issue 側にも残すか——run のログは90日で消える
 *
 * `gh run view --log` で読める記録は、GitHub の既定の保持期間（90日）で
 * 消える。**赤の晩だけ**、消えない場所（Issue のコメント）にも同じ情報を
 * 残しておけば、90日を過ぎても「いつ・どの赤が本番へ出たか」を Issue の
 * 検索だけで辿れる。緑の晩まで全部 Issue へ書かないのは、警報 Issue が
 * 無いところに書く先が無い（＝新しい Issue を立てることになり、それは
 * この変更が禁じている）のと、**そもそも毎晩の記録は run のログという
 * 安価な場所で足りる**ため。
 */

/** 記録行の接頭辞。**この文字列で探す。** 変えると過去の記録が grep から見えなくなる。 */
export const RECORD_LINE_PREFIX = 'release-prod-ci-record:';

/**
 * verdict を「健全さ」の3値へ畳む。
 *
 * ## なぜ verdict と別にこの欄が要るか（実測された誤読が2段ある）
 *
 * `out-of-scope` は**異常なし**である（上の doc 節「`out-of-scope` は
 * 「異常なし」である」）。ところが記録行に出るのは `verdict=out-of-scope`
 * という文字列だけで、**その意味は別の行（`describeVerdict`）にしか無い。**
 *
 * ⟹ 実測（2026-09-20）: マネージャー層が `verdict=out-of-scope` を
 * 「判定できなかった」と読み、**「健全な夜の記録が1件も積まれていない」と
 * 報告した。** クローン層はそれを前提に「候補 B は半分しか着地していない」と
 * 判断を1つ下した。⛔ **注意書き（上の doc 節）は既に在ったのに、2段とも
 * 防げていない。**
 *
 * ⟹ ⭐ **技術的に正しい文字列が読み手を偽へ導く**形であり、
 * `check-pr-green` が略記 sha を `no-runs` と言っていた欠陥（PR #1260）と
 * 同じ型である。⟹ **記録行そのものに健全さを載せる。**
 *
 * ## 3値にする理由
 *
 * `ok` / `bad` の2値にすると、「判定に至れなかった」を `bad` か `ok` の
 * どちらかへ畳むことになり、**取れない軸に値を作る**ことになる
 * （`AGENTS.md`「取れない軸に 0 の行を作らない」/「『判定できない』という
 * 3つ目の状態を持つ」）。⟹ `unknown` を独立した値として持つ。
 *
 * | health | verdict | 意味 |
 * | --- | --- | --- |
 * | `ok` | `green` / `out-of-scope` | 異常なし。⭐ **健全な夜はこちら** |
 * | `bad` | `red` | 赤い main が本番へ出た |
 * | `unknown` | それ以外（`cancelled` / `skipped` / `unmeasurable` / `no-runs` / `pending` / `unknown`） | 判定に至れなかった |
 *
 * ⛔ **警報の分岐は `verdict === 'red'` のままで、この関数を使っていない。**
 * 健全さの表示を足しただけで、**本番へ出る振る舞いは1つも変えていない。**
 *
 * @param {string} verdict
 * @returns {'ok' | 'bad' | 'unknown'}
 */
export function healthOf(verdict) {
  if (verdict === 'green' || verdict === 'out-of-scope') return 'ok';
  if (verdict === 'red') return 'bad';
  return 'unknown';
}

/**
 * 機械可読な記録行を1つ組み立てる。
 *
 * 形: `release-prod-ci-record: verdict=<verdict> health=<ok|bad|unknown> prod_sha=<40桁> main_sha=<40桁> reflect=<outcome> observed_at=<ISO8601 UTC>`
 *
 * ⚠ `health=` は後から足した欄である（実測された誤読2段への対処。`healthOf` の
 * doc を見よ）。⟹ **この欄を持たない行は、足す前の古い形式である。**
 * `verdict=` の値そのものは1文字も変えていないので、過去の記録の grep は壊れない。
 *
 * @param {{ verdict: string, prodSha: string, mainSha: string, reflectOutcome: string, observedAt: string }} input
 */
export function buildRecordLine({ verdict, prodSha, mainSha, reflectOutcome, observedAt }) {
  return (
    `${RECORD_LINE_PREFIX} verdict=${verdict} health=${healthOf(verdict)} ` +
    `prod_sha=${prodSha} main_sha=${mainSha} reflect=${reflectOutcome} observed_at=${observedAt}`
  );
}

/**
 * verdict ごとの意味を、人が読んで次の一手が分かる1文にする。
 *
 * `judgeSha` が返す8値（green / red / cancelled / out-of-scope / skipped /
 * pending / unmeasurable / no-runs）に加えて、`judgeSha` 自体が失敗したときの
 * `unknown`（gh api を読めなかった・prod_sha や main_sha を取得できなかった等、
 * この道具の側の都合で判定に至れなかった状態）を持つ。
 */
export function describeVerdict(verdict) {
  switch (verdict) {
    case 'green':
      return '緑 —— 反映した sha の最新世代の job がすべて success だった';
    case 'red':
      return '赤 —— success ではない job が在った。赤い main が本番へ出た';
    case 'cancelled':
      return '中断 —— 赤ではないが、走り切っていない job が在った（判定不能。門ではないので反映は止めていない）';
    case 'out-of-scope':
      return (
        '異常なし —— push の run なので pull_request 専用 job（base-overlap / pr-origin 等）が' +
        '設計どおり skip されただけ。健全な main HEAD でも green にはならずこの verdict になる' +
        '（実測: 健全な main HEAD ecd1674e09c72b245db21b225f56ac590fd336af = out-of-scope）'
      );
    case 'skipped':
      return 'draft 由来の skip の疑いが在る job が見つかった（本来 push の run では起きないはずの形。要確認）';
    case 'unmeasurable':
      return '判定できない —— jobs が0件の run が在る、または job がすべて skipped で success と言える job が無い';
    case 'no-runs':
      return '判定できない —— この sha に workflow run が1つも無い';
    case 'pending':
      return '判定できない —— まだ完了していない run が在る（反映直後に判定を試みた等）';
    case 'unknown':
      return '判定できない —— gh api を読めなかった、または main_sha / prod_sha を取得できなかった';
    default:
      return `未知の verdict: ${verdict}`;
  }
}

/**
 * `judgeSha` が選んだ最新 run 群のうち、`conclusion === 'failure'` のものの
 * workflow 名を返す（重複除去）。
 *
 * **detail 文字列（job 単位の "name（workflow=..., run=...）= conclusion" の
 * 並び）を parse しない。** `evaluatePrGreen` の戻り値には run 自体の
 * `conclusion` がそのまま乗っているので、そちらから直接取るほうが壊れにくい
 * （detail の文言が変わっても影響を受けない）。
 *
 * @param {{name:string, conclusion:string|null}[]} latestRuns
 * @returns {string[]}
 */
export function redWorkflowNames(latestRuns) {
  const names = new Set();
  for (const run of latestRuns) {
    if (run.conclusion === 'failure') names.add(run.name);
  }
  return [...names];
}

/**
 * 赤の晩に警報 Issue へ足すコメントの印。
 *
 * `<!-- alteroid:release-prod-ci-record sha=<sha> run=<この反映 run の id> -->`
 *
 * `main-ci-alarm-core.mjs` の `alarmMarker`（`<!-- alteroid:main-ci-alarm
 * key=... -->`）とは別物——あちらは「どの警報 Issue を探すか」の鍵、こちらは
 * 「この記録コメントを重複して足さないか」を確かめるための印である。
 * `run` は落ちた CI の run ではなく、**この記録コメントを書いた
 * `release-prod.yml` 自身の反映 run の id**（`GITHUB_RUN_ID`）にする——
 * 同じ夜間反映の run が再実行されても、この印があれば二重に足さない。
 */
export function recordCommentMarker({ sha, runId }) {
  return `<!-- alteroid:release-prod-ci-record sha=${sha} run=${runId} -->`;
}

/**
 * 赤の晩に、既存の警報 Issue へ足すコメント本文を組み立てる。
 *
 * @param {{
 *   sha: string,
 *   runId: string | number,
 *   runUrl: string,
 *   verdict: string,
 *   redWorkflows: string[],
 *   mainSha: string,
 *   reflectOutcome: string,
 *   observedAt: string,
 * }} input
 */
export function buildRecordComment({
  sha,
  runId,
  runUrl,
  verdict,
  redWorkflows,
  mainSha,
  reflectOutcome,
  observedAt,
}) {
  return [
    '**この赤は本番へ出た。**',
    '',
    `\`release/prod\` への夜間反映（\`.github/workflows/release-prod.yml\`）が` +
      ` \`${sha}\`（main \`${mainSha}\`）を反映したあと、その sha の CI 判定は` +
      ` \`${verdict}\` だった。`,
    '',
    `- run ${runId}: ${runUrl}`,
    `- 落ちていた workflow: ${redWorkflows.length > 0 ? redWorkflows.join(', ') : '(不明)'}`,
    `- reflect の結果: ${reflectOutcome}`,
    `- 観測時刻: ${observedAt}`,
    '',
    buildRecordLine({ verdict, prodSha: sha, mainSha, reflectOutcome, observedAt }),
    '',
    'この記録は門ではない——赤くても反映は止めていない（Issue #1207 の (3)。',
    '決定と根拠は `.github/scripts/record-release-prod-ci-core.mjs` の doc を見よ）。',
    '',
    recordCommentMarker({ sha, runId }),
  ].join('\n');
}
