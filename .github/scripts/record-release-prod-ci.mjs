#!/usr/bin/env node
/**
 * `release/prod` へ夜間反映した sha の CI を記録する（Issue #1207 の (3)）。
 *
 * **判定ロジックはここに置かない。** 組み立て（記録行・人が読む説明・赤の晩の
 * コメント本文）は `record-release-prod-ci-core.mjs` が正本で、なぜ止める門を
 * 作らずに記録だけにしたのか、`out-of-scope` がなぜ「異常なし」なのか、
 * 赤のときのコメントがなぜ警報 Issue の鍵を再利用するのかは、あちらの doc に
 * 書いてある。**CI が本当に緑かの判定ロジックも自分では持たない**——
 * `scripts/check-pr-green.mjs` の `judgeSha` をそのまま呼ぶ。ここはネット
 * ワーク（`git` / `gh`）を持ち、結果を出力し、赤の晩だけ Issue へ書く、という
 * 薄い層である。
 *
 * ## ⛔ この道具は門ではない——`process.exitCode` をどの経路でも立てない
 *
 * **常に 0 で終わる。** 記録に失敗しても、赤いままでも、反映の成否に一切
 * 影響してはならない（`.github/workflows/release-prod.yml` の記録 step が
 * `continue-on-error: true` を付けているのも同じ理由の二重の保証）。
 * ただし**黙って成功したふりはしない**——失敗は必ず1行で名乗る
 * （`AGENTS.md`「静かに失敗する道具」）。
 *
 * ## 既定は dry-run。実際に Issue へ書くのは明示したときだけ
 *
 * 環境変数 `RECORD_RELEASE_PROD_CI_APPLY=1` が無い限り、`gh issue comment` は
 * 呼ばない——判定と記録行の出力、「書くならこの内容」というログだけを出す
 * （`main-ci-alarm.mjs` の `MAIN_CI_ALARM_APPLY` と同じ作法）。**新しい Issue は
 * どちらのモードでも絶対に立てない**——書く先は既存の警報 Issue だけである。
 *
 * ## 入力（環境変数）
 *
 * | 変数 | 既定 | 意味 |
 * |---|---|---|
 * | `GITHUB_REPOSITORY` | `takecchi/alteroid` | `owner/repo` |
 * | `RECORD_RELEASE_PROD_CI_APPLY` | 未設定（dry-run） | `1`/`true` で実際に Issue へ書く |
 * | `RECORD_REFLECT_OUTCOME` | `(unknown)` | 記録行の `reflect=` に入れる（`steps.reflect.outcome`） |
 * | `RECORD_RELEASE_PROD_CI_SHA` | 未設定（`git ls-remote` で取得） | 判定する sha を上書きする（確かめるための口） |
 * | `GITHUB_RUN_ID` | 空 | この反映 run の id。記録コメントの印と重複防止に使う |
 * | `GITHUB_SERVER_URL` | `https://github.com` | run URL の組み立てに使う |
 * | `GH_TOKEN` | — | `gh` が読む。workflow 側の `github.token` を渡す |
 *
 * ## 出力
 *
 * **必ず1行、機械可読な記録行を出す**（stdout と `$GITHUB_STEP_SUMMARY` の
 * 両方）。形は `record-release-prod-ci-core.mjs` の `buildRecordLine` を見よ。
 * `judgeSha` が判定できたときは `formatVerdict` の全文も stdout に出す。
 *
 * ## 後からどう数えるか
 *
 * ### 毎晩の記録（run のログ。90日で消える）
 *
 *     gh run list --repo takecchi/alteroid --workflow=release-prod.yml \
 *       --limit 100 --json databaseId,createdAt,event
 *     # 各 run について:
 *     gh run view <id> --repo takecchi/alteroid --log \
 *       | grep -F 'release-prod-ci-record:'
 *
 * ### 期限の無い記録（赤の晩だけ。警報 Issue のコメント）
 *
 * 警報 Issue のコメントに埋めた印 `alteroid:release-prod-ci-record` を検索する
 * 形になる。**⚠️ この検索が実際に当たるかは、本物の赤い晩を経ないと試せない
 * ——未確認。** `gh search issues` / `gh api search/issues` がコメント本文の
 * HTML コメントまで拾うかは、実際に赤い晩が来て記録コメントが付くまで確認
 * できない。確認できたら、ここに実測のコマンドを追記すること。
 *
 * ### なぜ run のログだけでなく Issue 側にも残すのか
 *
 * `gh run view --log` が読む記録は GitHub の既定の保持期間（90日）で消える。
 * **赤の晩だけ**、消えない場所（警報 Issue のコメント）にも同じ情報を残して
 * おけば、90日を過ぎても辿れる。緑の晩まで全部 Issue へ書かないのは、
 * 警報 Issue が無い（＝赤くない）ところに書く先が無い——新しい Issue を
 * 立てることは、この道具が明示的に禁じている。
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import process from 'node:process';

import { judgeSha } from '../../scripts/check-pr-green.mjs';
import { formatVerdict } from '../../scripts/check-pr-green-core.mjs';
import {
  alarmKey,
  alarmMarker,
  findOpenAlarmIssue,
  runAlreadyMentioned,
  runMention,
} from '../../scripts/main-ci-alarm-core.mjs';
import {
  buildRecordComment,
  buildRecordLine,
  describeVerdict,
  redWorkflowNames,
} from './record-release-prod-ci-core.mjs';

function log(text) {
  process.stdout.write(text + '\n');
}

/** `$GITHUB_STEP_SUMMARY` が無い（手元で叩いた等）ときは黙って何もしない。 */
function logStepSummary(text) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, text + '\n');
  } catch (error) {
    log(`record-release-prod-ci: GITHUB_STEP_SUMMARY へ書けなかった —— ${String(error)}`);
  }
}

function emitRecordLine(fields) {
  const line = buildRecordLine(fields);
  log(line);
  logStepSummary(line);
  return line;
}

function gitRevParseHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (error) {
    return { error: String(error) };
  }
}

function lsRemoteProdSha() {
  try {
    const out = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/release/prod'], {
      encoding: 'utf8',
    });
    // タブ区切りの1列目が sha。ref がまだ無ければ出力自体が空文字。
    const sha = out.split('\t')[0]?.trim() ?? '';
    return sha;
  } catch (error) {
    return { error: String(error) };
  }
}

/** `gh` を呼ぶ。失敗したら `{ error }` を返す（例外を投げない）。 */
function gh(argv, { input } = {}) {
  try {
    const stdout = execFileSync('gh', argv, {
      encoding: 'utf8',
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    return { stdout, error: null };
  } catch (error) {
    const detail =
      error !== null && typeof error === 'object' && 'stderr' in error && error.stderr
        ? String(error.stderr).trim()
        : String(error);
    return { stdout: null, error: detail };
  }
}

function fetchOpenIssues(repo) {
  const { stdout, error } = gh([
    'api',
    '--paginate',
    `repos/${repo}/issues?state=open&per_page=100`,
  ]);
  if (stdout === null) return { issues: null, error };
  try {
    const parsed = JSON.parse(stdout);
    return { issues: Array.isArray(parsed) ? parsed : [], error: null };
  } catch (e) {
    return { issues: null, error: `応答を JSON として読めなかった: ${String(e)}` };
  }
}

function fetchIssueComments(repo, issueNumber) {
  const { stdout, error } = gh([
    'api',
    '--paginate',
    `repos/${repo}/issues/${issueNumber}/comments?per_page=100`,
  ]);
  if (stdout === null) return { comments: null, error };
  try {
    const parsed = JSON.parse(stdout);
    return { comments: Array.isArray(parsed) ? parsed : [], error: null };
  } catch (e) {
    return { comments: null, error: `応答を JSON として読めなかった: ${String(e)}` };
  }
}

function isApplyRequested() {
  const v = process.env.RECORD_RELEASE_PROD_CI_APPLY;
  return v === '1' || v === 'true';
}

/**
 * 赤のときだけ呼ぶ。落ちていた workflow ごとに、対応する main-ci-alarm の
 * 警報 Issue を探し、open で在ればコメントを足す。**見つからなければ何も
 * 作らない**（新しい Issue は立てない）。
 */
function recordRedToAlarmIssue({
  repo,
  prodSha,
  mainSha,
  verdict,
  reflectOutcome,
  observedAt,
  judged,
}) {
  const names = redWorkflowNames(judged.latestRuns);
  if (names.length === 0) {
    log(
      'record-release-prod-ci: verdict=red だが、赤い workflow 名を latestRuns から特定できなかった —— コメントを付けられない',
    );
    return;
  }

  const apply = isApplyRequested();
  log(apply ? '=== APPLY モード: 実際に Issue へ書く ===' : '=== dry-run: 何も書かない ===');

  const runId = process.env.GITHUB_RUN_ID || '';
  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const runUrl = runId ? `${serverUrl}/${repo}/actions/runs/${runId}` : '(unknown run)';

  let wroteAny = false;
  for (const workflowName of names) {
    const key = alarmKey(workflowName, prodSha);
    const marker = alarmMarker(key);

    const { issues, error: issuesError } = fetchOpenIssues(repo);
    if (issues === null) {
      log(
        `record-release-prod-ci: open な Issue の一覧を読めなかった（鍵 ${key}）—— ${issuesError}`,
      );
      continue;
    }

    const existing = findOpenAlarmIssue(issues, marker);
    if (existing === null) {
      log(
        `record-release-prod-ci: 鍵 ${key} の警報 Issue が open で見つからない —— durable な記録を付けられなかった`,
      );
      continue;
    }

    const { comments, error: commentsError } = fetchIssueComments(repo, existing.number);
    if (comments === null) {
      log(
        `record-release-prod-ci: #${existing.number} のコメントを読めなかった —— ${commentsError}`,
      );
      continue;
    }

    const texts = [existing.body ?? '', ...comments.map((c) => c.body ?? '')];
    if (runId !== '' && runAlreadyMentioned(texts, runId)) {
      log(
        `record-release-prod-ci: #${existing.number} に ${runMention(runId)} が既に書かれている —— 足さない`,
      );
      wroteAny = true;
      continue;
    }

    const body = buildRecordComment({
      sha: prodSha,
      runId: runId || '(unknown)',
      runUrl,
      verdict,
      redWorkflows: names,
      mainSha,
      reflectOutcome,
      observedAt,
    });

    if (!apply) {
      log(`record-release-prod-ci: [dry-run] #${existing.number} へ足すコメント:`);
      log(body);
      wroteAny = true;
      continue;
    }

    const { stdout, error } = gh(
      ['issue', 'comment', String(existing.number), '--repo', repo, '--body-file', '-'],
      { input: body },
    );
    if (stdout === null) {
      log(`record-release-prod-ci: #${existing.number} へのコメントに失敗した —— ${error}`);
      continue;
    }
    log(`record-release-prod-ci: #${existing.number} へ足した ${stdout.trim()}`);
    wroteAny = true;
  }

  if (!wroteAny) {
    log('record-release-prod-ci: durable な記録を付けられなかった');
  }
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY || 'takecchi/alteroid';
  const reflectOutcome = process.env.RECORD_REFLECT_OUTCOME || '(unknown)';
  const observedAt = new Date().toISOString();

  const mainSha = gitRevParseHead();
  if (typeof mainSha !== 'string') {
    log(
      `record-release-prod-ci: main_sha を取得できなかった（git rev-parse HEAD 失敗）—— ${mainSha.error}`,
    );
    emitRecordLine({
      verdict: 'unknown',
      prodSha: '(unknown)',
      mainSha: '(unknown)',
      reflectOutcome,
      observedAt,
    });
    return;
  }

  const prodShaInput = process.env.RECORD_RELEASE_PROD_CI_SHA || lsRemoteProdSha();
  if (typeof prodShaInput !== 'string') {
    log(
      `record-release-prod-ci: prod_sha を取得できなかった（git ls-remote 失敗）—— ${prodShaInput.error}`,
    );
    emitRecordLine({
      verdict: 'unknown',
      prodSha: '(unknown)',
      mainSha,
      reflectOutcome,
      observedAt,
    });
    return;
  }
  if (prodShaInput === '') {
    log('record-release-prod-ci: prod_sha が空 —— release/prod がまだ無い（初回反映前）');
    emitRecordLine({ verdict: 'unknown', prodSha: '(none)', mainSha, reflectOutcome, observedAt });
    return;
  }
  const prodSha = prodShaInput;

  const judged = judgeSha({ sha: prodSha, repo });
  if (judged.result === null) {
    log(`record-release-prod-ci: 判定できなかった —— ${judged.error}`);
    emitRecordLine({ verdict: 'unknown', prodSha, mainSha, reflectOutcome, observedAt });
    return;
  }

  const verdict = judged.result.verdict;
  emitRecordLine({ verdict, prodSha, mainSha, reflectOutcome, observedAt });
  log(formatVerdict(prodSha, judged.result));
  log(`record-release-prod-ci: ${describeVerdict(verdict)}`);

  if (verdict !== 'red') return;

  recordRedToAlarmIssue({ repo, prodSha, mainSha, verdict, reflectOutcome, observedAt, judged });
}

try {
  main();
} catch (error) {
  // ⛔ ここでも exitCode は立てない——記録の失敗が反映を止めてはならない。
  // ただし黙って終わらない（AGENTS.md「静かに失敗する道具」）。
  log(`record-release-prod-ci: 予期しない例外で終わった —— ${String(error)}`);
}
