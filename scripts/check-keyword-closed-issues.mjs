#!/usr/bin/env node
/**
 * 「閉じるキーワードで閉じた疑いのある Issue」を一覧する（`pnpm
 * check:keyword-closed-issues`。Issue #1128）。
 *
 * **判定ロジックはここに置かない。** `check-keyword-closed-issues-core.mjs` が
 * 正本で、なぜタイミングだけで判定するのか・閾値をどう決めたか（実測）・
 * `commit_id` 一致とタイミング一致の使い分けは、あちらの doc に書いてある。
 * ここはネットワーク（`gh`）を持ち、結果を出力するだけの薄い層
 * （`check-pr-closing-keywords.mjs` / `check-pr-green.mjs` と同じ分け方）。
 *
 * ## ⛔ これは門ではない
 *
 * required contexts には入れない。CI からも呼ばない。**赤くする基準（閾値の
 * 確からしさ）を確定させる機構が無いため**——`check-pr-closing-keywords` が
 * required に入っていないのと同じ理由（#1109）。**手で（またはエージェントが
 * 手元で）走らせる報告ツールである。** `package.json` への配線は
 * `check-scripts-wired.test.ts` の `EXEMPT`（`check:pr-green` と同じ形）で行う。
 *
 * ## この道具が言えること・言えないこと
 *
 * - **言えること**: 呼ばれた時点で、`main` にマージ済みの PR のマージ時刻と
 *   Issue の `closed` イベントを突き合わせ、「閉じるキーワードで閉じた」と
 *   推測できる組を一覧する。
 * - **言えないこと**: **意図した閉じ方か事故かの区別。** timeline のデータ
 *   だけからはこの2つを区別できない（#1128）。出力にもその区別を書かない。
 * - **書き換えない。** 読むだけである。Issue にも PR にもコメントしない。
 *
 * ## 使い方
 *
 *     node ./scripts/check-keyword-closed-issues.mjs [--repo owner/repo] [--threshold N]
 *
 * `--repo` の既定は `takecchi/alteroid`。`--threshold` の既定は
 * `DEFAULT_THRESHOLD_SECONDS`（10秒。根拠は core の doc）。
 *
 * ## 終了コード
 *
 * **候補が1件以上在っても失敗にしない**（門ではないので「見つかった」ことは
 * 異常ではない）。`gh` の呼び出し自体が失敗したときだけ 1 を返す。
 *
 * | 状況 | コード |
 * |---|---|
 * | 一覧を作れた（候補0件・N件どちらでも） | 0 |
 * | `gh` の呼び出しが失敗した | 1 |
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';

import {
  DEFAULT_THRESHOLD_SECONDS,
  findKeywordClosedCandidates,
  formatReport,
} from './check-keyword-closed-issues-core.mjs';

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

function parseArgs(argv) {
  let repo = 'takecchi/alteroid';
  let threshold = DEFAULT_THRESHOLD_SECONDS;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') {
      repo = argv[++i];
    } else if (arg.startsWith('--repo=')) {
      repo = arg.slice('--repo='.length);
    } else if (arg === '--threshold') {
      threshold = Number(argv[++i]);
    } else if (arg.startsWith('--threshold=')) {
      threshold = Number(arg.slice('--threshold='.length));
    }
  }
  return { repo, threshold };
}

/** `gh` を呼び、stdout を返す。失敗したら `{ error }` を返す（例外を投げない）。 */
function ghRun(args) {
  try {
    const stdout = execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
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
 * マージ済み PR の一覧を取る。**`--state all` は要らない**（`merged` 専用の
 * state が既にある）が、`--limit` は「静かに取りこぼす」道具なので
 * `AGENTS.md`「静かに失敗する道具」どおり明示的に大きい値を渡す。
 */
function fetchMergedPRs(repo) {
  const { stdout, error } = ghRun([
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'merged',
    '--limit',
    '1000',
    '--json',
    'number,mergedAt,mergeCommit',
  ]);
  if (stdout === null) return { data: null, error };
  const parsed = JSON.parse(stdout);
  return {
    data: parsed
      .filter((p) => typeof p.mergedAt === 'string')
      .map((p) => ({
        number: p.number,
        mergedAt: p.mergedAt,
        mergeCommitOid: typeof p.mergeCommit?.oid === 'string' ? p.mergeCommit.oid : null,
      })),
    error: null,
  };
}

/**
 * Issue（PR を除く）の `closed` イベント全件を取る。
 *
 * `gh issue list --state closed` ではなく `/repos/<repo>/issues/events` を使う
 * ——前者は「いま CLOSED である」状態しか見えず、**reopen された分の過去の
 * close イベントを取りこぼす**（#993 は2回閉じて2回とも reopen されており、
 * `gh issue list` では2回目までしか見えない）。後者は状態に関係なく、過去に
 * 起きた `closed` イベント全件を時系列で返す。
 *
 * `--paginate` は使うが `--slurp` とは併用しない（`AGENTS.md`「静かに失敗する
 * 道具」: `gh api --paginate --slurp` は `--jq` と併用できない。`--slurp` を
 * 使わなければ `--jq` はページごとに適用され、`--paginate` と共存できる）。
 *
 * `.issue.pull_request` が在れば PR 自身の closed イベントなので除外する
 * （このエンドポイントは Issue と PR の両方の events を返す——GitHub の内部
 * モデルで PR は Issue の一種であるため）。
 */
function fetchIssueCloseEvents(repo) {
  const { stdout, error } = ghRun([
    'api',
    `repos/${repo}/issues/events`,
    '--paginate',
    '--jq',
    '.[] | select(.event=="closed") | {number: .issue.number, is_pr: (.issue.pull_request != null), created_at, commit_id, actor: .actor.login}',
  ]);
  if (stdout === null) return { data: null, error };

  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  const data = [];
  for (const line of lines) {
    const ev = JSON.parse(line);
    if (ev.is_pr) continue; // PR 自身の closed イベントは対象外
    data.push({
      issueNumber: ev.number,
      closedAt: ev.created_at,
      commitId: typeof ev.commit_id === 'string' && ev.commit_id.length > 0 ? ev.commit_id : null,
      actor: typeof ev.actor === 'string' ? ev.actor : null,
    });
  }
  return { data, error: null };
}

function main() {
  const { repo, threshold } = parseArgs(process.argv.slice(2));

  if (!Number.isFinite(threshold) || threshold < 0) {
    logError(
      `check-keyword-closed-issues: --threshold は0以上の数でなければならない: ${threshold}`,
    );
    process.exitCode = 1;
    return;
  }

  const { data: mergedPRs, error: prError } = fetchMergedPRs(repo);
  if (mergedPRs === null) {
    logError('check-keyword-closed-issues: 判定できなかった —— マージ済み PR の一覧を読めない');
    logError(`  gh の出力: ${prError}`);
    process.exitCode = 1;
    return;
  }

  const { data: closeEvents, error: eventsError } = fetchIssueCloseEvents(repo);
  if (closeEvents === null) {
    logError(
      'check-keyword-closed-issues: 判定できなかった —— Issue の closed イベント一覧を読めない',
    );
    logError(`  gh の出力: ${eventsError}`);
    process.exitCode = 1;
    return;
  }

  const candidates = findKeywordClosedCandidates({
    mergedPRs,
    closeEvents,
    thresholdSeconds: threshold,
  });
  log(formatReport(candidates, threshold));
}

main();
