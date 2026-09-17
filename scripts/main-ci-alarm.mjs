#!/usr/bin/env node
/**
 * `main` で失敗した workflow run を、この repo の Issue として知らせる（Issue #1207）。
 *
 * **判定ロジックはここに置かない。** `main-ci-alarm-core.mjs` が正本で、なぜ鍵が
 * 「workflow 名 ＋ head_sha」なのか、なぜ自動で閉じないのか、なぜ宛先を Issue 1つに
 * 絞ったのかは、あちらの doc に書いてある。ここはネットワーク（`gh`）を持ち、結果を
 * 出力し、終了コードを決めるだけの薄い層（`issue-done-trailer.mjs` と同じ分け方）。
 *
 * ## 既定は dry-run。実際に書くのは明示したときだけ
 *
 * 環境変数 `MAIN_CI_ALARM_APPLY=1`（または `--apply`）が無い限り、`gh issue create` も
 * `gh issue comment` も呼ばない —— 判定と「書くならこうする」というログだけを出す。
 * **手元で `pnpm main-ci-alarm` を誤って叩いても Issue は1本も生えない。** 実際に書く
 * のは `.github/workflows/main-ci-alarm.yml` が `MAIN_CI_ALARM_APPLY=1` を渡す run
 * だけである（`issue-done-trailer.mjs` と同じ形）。
 *
 * ## 入力
 *
 * | 引数 | 既定の環境変数 | 意味 |
 * |---|---|---|
 * | `--repo` | `GITHUB_REPOSITORY` | `owner/repo` |
 * | `--workflow` | `MAIN_CI_ALARM_WORKFLOW_NAME` | 落ちた workflow の名前 |
 * | `--sha` | `MAIN_CI_ALARM_HEAD_SHA` | その run の head_sha |
 * | `--run-id` | `MAIN_CI_ALARM_RUN_ID` | その run の id |
 * | `--run-url` | `MAIN_CI_ALARM_RUN_URL` | その run の URL |
 * | `--conclusion` | `MAIN_CI_ALARM_CONCLUSION` | その run の conclusion |
 * | `--head-branch` | `MAIN_CI_ALARM_HEAD_BRANCH` | その run の head_branch |
 * | `--default-branch` | `MAIN_CI_ALARM_DEFAULT_BRANCH` | repo の default branch |
 * | `--apply` | `MAIN_CI_ALARM_APPLY`（`1`/`true`） | 実際に書くなら指定 |
 *
 * 欠けている入力が在れば「呼び方の誤り」として終了コード1で終わる
 * （`issue-done-trailer.mjs` と同じ理由 —— 読みに行くための情報が最初から無いのは
 * 判定の失敗とは別である）。
 *
 * ## ⚠️ この道具が言えること・言えないこと
 *
 * - **言えること**: 渡された run について、警報 Issue を立てた／既存へ足した／
 *   既に書かれていたので何もしなかった、のどれをしたか
 * - ⛔ **言えないこと: `main` がいま赤いかどうか。** これは1つの run の事後報告
 *   であって、現在地を測っていない。現在地を見て振る舞うのは夜の反映側の門
 *   （`.github/scripts/reflect-release-prod.sh`）であり、あちらは毎晩読み直す
 * - ⛔ **言えないこと: 誰かがこの Issue を読んだか。** 警報は「人が見ていれば効く」
 *   歯である。**誰も見ていなくても効く歯は門のほうである**
 *
 * ## 失敗の扱い
 *
 * **黙って緑にしない。** Issue 一覧が読めない・`gh issue create` が失敗した等は
 * 出力に残して終了コード1で終わる。⚠️ ただし**この workflow が赤くなっても、それを
 * 知らせる経路は無い**（警報の警報は置いていない）—— ここは意図的に1段で止めてある。
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';

import {
  alarmKey,
  alarmMarker,
  buildCommentBody,
  buildIssueBody,
  buildIssueTitle,
  decideAlarmAction,
  findOpenAlarmIssue,
  shouldAlarm,
} from './main-ci-alarm-core.mjs';

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      out.apply = true;
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq === -1) {
        out[arg.slice(2)] = argv[++i];
      } else {
        out[arg.slice(2, eq)] = arg.slice(eq + 1);
      }
    }
  }
  return out;
}

function isApplyRequested(args) {
  if (args.apply === true) return true;
  const envValue = process.env.MAIN_CI_ALARM_APPLY;
  return envValue === '1' || envValue === 'true';
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

/**
 * open な Issue を全部読む。
 *
 * **`gh search` を使わない。** 検索インデックスは反映が遅れることが在り、立てた直後の
 * Issue が見つからないと**同じ鍵で2本目が生える**。一覧は遅れない。
 *
 * ⚠️ `repos/{repo}/issues` は **Pull Request も混ぜて返す**（落とすのは core の
 * `findOpenAlarmIssue`）。`--paginate` を付けてあるので open が100本を超えても拾える。
 */
function fetchOpenIssues(repo) {
  const { stdout, error } = gh([
    'api',
    '--paginate',
    `repos/${repo}/issues?state=open&per_page=100`,
  ]);
  if (stdout === null) return { issues: null, error };
  try {
    // `--paginate` は JSON 配列を連結して1つの配列として返す（gh が畳んでくれる）。
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;

  const repo = args.repo || env.GITHUB_REPOSITORY || '';
  const workflowName = args.workflow || env.MAIN_CI_ALARM_WORKFLOW_NAME || '';
  const headSha = args.sha || env.MAIN_CI_ALARM_HEAD_SHA || '';
  const runId = args['run-id'] || env.MAIN_CI_ALARM_RUN_ID || '';
  const runUrl = args['run-url'] || env.MAIN_CI_ALARM_RUN_URL || '';
  const conclusion = args.conclusion || env.MAIN_CI_ALARM_CONCLUSION || '';
  const headBranch = args['head-branch'] || env.MAIN_CI_ALARM_HEAD_BRANCH || '';
  const defaultBranch = args['default-branch'] || env.MAIN_CI_ALARM_DEFAULT_BRANCH || '';

  const missing = Object.entries({
    repo,
    workflow: workflowName,
    sha: headSha,
    'run-id': runId,
    'run-url': runUrl,
    conclusion,
    'head-branch': headBranch,
    'default-branch': defaultBranch,
  })
    .filter(([, value]) => value === '')
    .map(([name]) => name);
  if (missing.length > 0) {
    logError(`main-ci-alarm: 呼び方の誤り —— 次の入力が無い: ${missing.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const apply = isApplyRequested(args);
  log(apply ? '=== APPLY モード: 実際に Issue へ書く ===' : '=== dry-run: 何も書かない ===');

  const verdict = shouldAlarm({ conclusion, headBranch, defaultBranch });
  if (!verdict.alarm) {
    log(`main-ci-alarm: 警報を出さない —— ${verdict.reason}`);
    return;
  }
  log(`main-ci-alarm: 警報を出す —— ${verdict.reason}`);

  const key = alarmKey(workflowName, headSha);
  const marker = alarmMarker(key);

  const { issues, error: issuesError } = fetchOpenIssues(repo);
  if (issues === null) {
    logError('main-ci-alarm: open な Issue の一覧を読めなかった');
    logError(`  gh の出力: ${issuesError}`);
    process.exitCode = 1;
    return;
  }

  const existing = findOpenAlarmIssue(issues, marker);
  let commentBodies = [];
  if (existing !== null) {
    const { comments, error: commentsError } = fetchIssueComments(repo, existing.number);
    if (comments === null) {
      logError(`main-ci-alarm: #${existing.number} のコメントを読めなかった`);
      logError(`  gh の出力: ${commentsError}`);
      process.exitCode = 1;
      return;
    }
    commentBodies = comments.map((c) => c.body ?? '');
  }

  const action = decideAlarmAction({ issue: existing, commentBodies, runId });
  log(`main-ci-alarm: 鍵 ${key} ⟹ ${action.kind}（${action.reason}）`);

  if (action.kind === 'skip') return;

  if (action.kind === 'create') {
    const title = buildIssueTitle({ workflowName, headSha });
    const body = buildIssueBody({ workflowName, headSha, runId, runUrl, key });
    if (!apply) {
      log(`  立てる Issue のタイトル: ${title}`);
      log('  --- 本文 ---');
      log(body);
      return;
    }
    const { stdout, error } = gh(
      ['issue', 'create', '--repo', repo, '--title', title, '--body-file', '-'],
      { input: body },
    );
    if (stdout === null) {
      logError('main-ci-alarm: gh issue create が失敗した');
      logError(`  gh の出力: ${error}`);
      process.exitCode = 1;
      return;
    }
    log(`main-ci-alarm: 立てた ${stdout.trim()}`);
    return;
  }

  const comment = buildCommentBody({ workflowName, headSha, runId, runUrl });
  if (!apply) {
    log(`  #${action.issueNumber} へ足すコメント:`);
    log(comment);
    return;
  }
  const { stdout, error } = gh(
    ['issue', 'comment', String(action.issueNumber), '--repo', repo, '--body-file', '-'],
    { input: comment },
  );
  if (stdout === null) {
    logError(`main-ci-alarm: gh issue comment が失敗した（#${action.issueNumber}）`);
    logError(`  gh の出力: ${error}`);
    process.exitCode = 1;
    return;
  }
  log(`main-ci-alarm: 足した ${stdout.trim()}`);
}

main();
