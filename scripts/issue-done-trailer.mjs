#!/usr/bin/env node
/**
 * マージされた PR の本文から `Alteroid-Issue-Done` trailer を読み、指定された
 * Issue を閉じる（Issue #1134。判定ロジックは `issue-done-trailer-core.mjs` が
 * 正本——trailer の書式・名前をキーワードから外した理由・降りる口の設計は
 * あちらの doc）。ここはネットワーク（`gh`）を持つ薄い層
 * （`check-pr-closing-keywords.mjs` と同じ分け方）。
 *
 * ## 既定は dry-run。実際に閉じるのは明示したときだけ
 *
 * 環境変数 `ISSUE_DONE_TRAILER_APPLY=1`（または `--apply`）が無い限り、
 * `gh issue close` は一切呼ばない——判定と「閉じるならこうする」というログ
 * だけを出す。**手元で `pnpm issue-done-trailer` を誤って叩いても何も閉じない。**
 * 実際に閉じるのは `.github/workflows/issue-done-trailer.yml` が
 * `ISSUE_DONE_TRAILER_APPLY=1` を渡す run だけである。
 *
 * ## 何を読むか — PR 本文だけ（コミットメッセージも `main` の履歴も読まない）
 *
 * 入口を2つ持つと挙動が2つになる——`check-pr-closing-keywords-core.mjs` は
 * タイトル・本文・コミットメッセージの3箇所を読むが、あれは「キーワードが
 * どこかに紛れ込んでいないか」を探す門で、**見逃しを最小化する**側に倒す
 * 理由がある。この道具は逆に**実際に Issue を閉じる**操作をするので、
 * 読む場所を1箇所（PR 本文）に固定し、どの記述が根拠だったかを一意に
 * 追えるようにする。
 *
 * ## 安全側の作り（5点。すべてここに実装がある）
 *
 * 1. **既定は dry-run**（上記）。
 * 2. **閉じた理由が run の出力に残る。** 番号ごとに「どの trailer 行
 *    （逐語）を読んで／どの PR の／いつのマージで／なぜ閉じる・閉じないか」
 *    を1行で出す（`describeDecision`）。
 * 3. **閉じるときは Issue 側にも根拠コメントを残す**（`gh issue close <N>
 *    --comment`）。PR 番号・マージ時刻（ISO）・読んだ trailer 行の逐語を含む。
 * 4. **閉じる前に対象を検証する**——(a) 同じ repo の Issue であること
 *    （PR 番号ではないこと。`gh api repos/<repo>/issues/<N>` の応答に
 *    `pull_request` キーが在れば PR なので拒否する）、(b) いま `OPEN` で
 *    あること（既に closed なら閉じずに skip して出力に残す。赤にしない）。
 * 5. **失敗は黙って緑にしない。** API エラー・番号が存在しない等は出力に
 *    残して終了コード1で終わる。
 *
 * ⛔ **本番の Issue を実際に閉じる実験はしない。** 動作確認は
 * `issue-done-trailer.test.ts`（vitest、core の純粋関数だけを検査）と
 * dry-run（`--apply` を渡さない実行）だけで行う。
 *
 * ## 入力
 *
 * | 引数 | 既定の環境変数 | 意味 |
 * |---|---|---|
 * | `--pr` | `ISSUE_DONE_TRAILER_PR_NUMBER` | 対象の PR 番号 |
 * | `--repo` | `GITHUB_REPOSITORY` | `owner/repo` |
 * | `--apply` | `ISSUE_DONE_TRAILER_APPLY`（`1`/`true`） | 実際に close するなら指定 |
 *
 * `--pr` / `--repo` が欠けたら「呼び方の誤り」として終了コード1
 * （`check-pr-closing-keywords.mjs` と同じ理由——読みに行くための情報が
 * 最初から無いのは `unreadable` とは別の失敗である）。
 *
 * ## この道具が言えること・言えないこと
 *
 * - **言えること**: 呼ばれた時点の PR 本文が、この门が定義する意味での
 *   `Alteroid-Issue-Done` trailer をどう書いていたか、そしてそれに従って
 *   何を閉じた／閉じなかったか。
 * - **言えないこと**: fork からの PR でこの workflow が同じように動くか
 *   （`pull_request` イベントに write トークンが渡らない制限がある。
 *   `pull_request_target` は安全でないので採らない）。**測っていない** —
 *   この repo はいまのところ単独運用なので当面問題にならない、という
 *   判断のうえで先送りしている。
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';

import { evaluateIssueDoneTrailer, formatEvaluation } from './issue-done-trailer-core.mjs';

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

/** `--flag value` と `--flag=value` の両方を受ける（既存の check-*.mjs と同じ）。 */
function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      result[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      result[key] = next;
      i++;
    } else {
      result[key] = '';
    }
  }
  return result;
}

function isApplyRequested(args) {
  if ('apply' in args) return true;
  const envValue = process.env.ISSUE_DONE_TRAILER_APPLY;
  return envValue === '1' || envValue === 'true';
}

/** `gh pr view <N> --json number,body,mergedAt,mergeCommit,baseRefName` を叩く。 */
function fetchPr(prNumber, repo) {
  try {
    const stdout = execFileSync(
      'gh',
      [
        'pr',
        'view',
        String(prNumber),
        '--repo',
        repo,
        '--json',
        'number,body,mergedAt,mergeCommit,baseRefName',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { data: JSON.parse(stdout), error: null };
  } catch (error) {
    const detail =
      error !== null && typeof error === 'object' && 'stderr' in error && error.stderr
        ? String(error.stderr).trim()
        : String(error);
    return { data: null, error: detail };
  }
}

/**
 * `gh api repos/<repo>/issues/<N>` を叩く。GitHub は PR も「issue」として
 * 返す（`pull_request` キーの有無で区別する）ので、ここで PR 番号を弾く。
 */
function fetchIssue(issueNumber, repo) {
  try {
    const stdout = execFileSync('gh', ['api', `repos/${repo}/issues/${issueNumber}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { data: JSON.parse(stdout), error: null };
  } catch (error) {
    const detail =
      error !== null && typeof error === 'object' && 'stderr' in error && error.stderr
        ? String(error.stderr).trim()
        : String(error);
    return { data: null, error: detail };
  }
}

function closeIssue(issueNumber, repo, comment) {
  try {
    execFileSync(
      'gh',
      ['issue', 'close', String(issueNumber), '--repo', repo, '--comment', comment],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { ok: true, error: null };
  } catch (error) {
    const detail =
      error !== null && typeof error === 'object' && 'stderr' in error && error.stderr
        ? String(error.stderr).trim()
        : String(error);
    return { ok: false, error: detail };
  }
}

function buildCloseComment({ prNumber, mergedAt, sourceLine }) {
  return [
    `Alteroid-Issue-Done trailer により、PR #${prNumber} のマージ（${mergedAt}）を受けて自動で close した。`,
    '',
    '読んだ trailer 行（逐語）:',
    '',
    '```',
    sourceLine,
    '```',
  ].join('\n');
}

/**
 * 1件の Issue 番号を処理する。dry-run なら何も書き込まず、判定だけを返す。
 *
 * @returns {{ number: number, action: 'would-close'|'closed'|'skipped-not-open'|'skipped-not-issue'|'error', detail: string }}
 */
function processIssue(issue, { repo, prNumber, mergedAt, apply }) {
  const { number, sourceLine } = issue;

  const { data, error } = fetchIssue(number, repo);
  if (data === null) {
    return { number, action: 'error', detail: `gh api で Issue を読めなかった: ${error}` };
  }

  if (typeof data.pull_request === 'object' && data.pull_request !== null) {
    return {
      number,
      action: 'skipped-not-issue',
      detail: `#${number} は Issue ではなく PR である。trailer の値を見直すこと`,
    };
  }

  const state = typeof data.state === 'string' ? data.state.toUpperCase() : null;
  if (state !== 'OPEN') {
    return {
      number,
      action: 'skipped-not-open',
      detail: `#${number} は既に ${state ?? '(state不明)'} である。閉じる必要が無い`,
    };
  }

  if (!apply) {
    return {
      number,
      action: 'would-close',
      detail: `#${number} は OPEN。--apply が無いので閉じない（dry-run）`,
    };
  }

  const comment = buildCloseComment({ prNumber, mergedAt, sourceLine });
  const { ok, error: closeError } = closeIssue(number, repo, comment);
  if (!ok) {
    return { number, action: 'error', detail: `gh issue close が失敗した: ${closeError}` };
  }
  return { number, action: 'closed', detail: `#${number} を close した（根拠コメント付き）` };
}

/**
 * 番号ごとに「どの trailer 行を読んで／どの PR の／いつのマージで／なぜ
 * 閉じる・閉じないか」を1行で読める形に畳む（安全側の作りの2番目）。
 */
function describeDecision(prNumber, mergedAt, outcome, sourceLine) {
  return (
    `issue-done-trailer(#${prNumber}, merged ${mergedAt}): ` +
    `trailer行="${sourceLine}" -> #${outcome.number} [${outcome.action}] ${outcome.detail}`
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const prRaw = args.pr || process.env.ISSUE_DONE_TRAILER_PR_NUMBER || '';
  const repo = args.repo || process.env.GITHUB_REPOSITORY || '';
  const apply = isApplyRequested(args);

  if (!/^\d+$/.test(prRaw) || repo === '') {
    logError(
      'issue-done-trailer: 呼び方の誤り — --pr/--repo（または ' +
        'ISSUE_DONE_TRAILER_PR_NUMBER/GITHUB_REPOSITORY）が要る。' +
        'マージ済み PR の文脈でのみ呼ぶこと（ワークフロー側の trigger が担保する）。',
    );
    process.exitCode = 1;
    return;
  }

  log(
    apply
      ? '=== APPLY モード: 実際に close する ==='
      : '=== DRY RUN（既定）: 実際には close しない ===',
  );

  const { data, error } = fetchPr(prRaw, repo);
  if (data === null) {
    logError(`issue-done-trailer(#${prRaw}): gh pr view が失敗した: ${error}`);
    process.exitCode = 1;
    return;
  }

  if (typeof data.mergedAt !== 'string' || data.mergedAt === null) {
    logError(
      `issue-done-trailer(#${prRaw}): この PR はマージされていない（mergedAt が無い）。` +
        'この道具はマージ後にのみ呼ぶこと。',
    );
    process.exitCode = 1;
    return;
  }

  const body = typeof data.body === 'string' ? data.body : '';
  const mergedAt = data.mergedAt;
  const baseRefName = typeof data.baseRefName === 'string' ? data.baseRefName : '(不明)';

  log(`PR #${prRaw} / base=${baseRefName} / mergedAt=${mergedAt}`);

  const result = evaluateIssueDoneTrailer(body);
  log(formatEvaluation(result));

  if (result.verdict !== 'close') {
    // absent / none —— 何も閉じない。エラーではないので exit 0。
    return;
  }

  let hadError = false;
  for (const issue of result.issues) {
    const outcome = processIssue(issue, { repo, prNumber: prRaw, mergedAt, apply });
    log(describeDecision(prRaw, mergedAt, outcome, issue.sourceLine));
    if (outcome.action === 'error') hadError = true;
  }

  if (hadError) {
    process.exitCode = 1;
  }
}

main();
