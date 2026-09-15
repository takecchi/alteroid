#!/usr/bin/env node
/**
 * この PR の本文と、この PR のコミットメッセージのどちらにも、AI 生成の
 * 帰属を示すトレーラ（`Co-Authored-By:` / `🤖 Generated with`）が残っていない
 * ことを確かめる（`pnpm check:no-attribution-trailers`。Issue #1020）。
 *
 * **判定ロジックはここに置かない。** `check-no-attribution-trailers-core.mjs`
 * が正本で、なぜ fail-closed にするのか・なぜ repo のファイルを走査しないのか
 * （#785 と同じ自己参照の族）・なぜ大小文字を無視するのかはあちらの doc に
 * 書いてある。ここはネットワーク（`gh pr view`）を持ち、結果を出力し、
 * 終了コードを決めるだけの薄い層（`check-pr-green.mjs` / `check-base-overlap.mjs`
 * と同じ分け方）。
 *
 * ## この道具が言えること・言えないこと
 *
 * - **言えること**: 呼ばれた時点の PR 本文と全コミットメッセージのどちらにも
 *   印が無いか。
 * - **言えないこと**: **この判定の後に本文やコミットが変わらないという保証。**
 *   PR 本文の編集だけでは新しい workflow run が起きない（`ci.yml` の
 *   `pull_request.types` に `edited` を含めていない）ので、push を挟まずに
 *   本文だけ書き換えると、この門は古い本文のまま緑を名乗り続ける。
 * - **書き換えない。** 読むだけである。
 *
 * ## 入力（環境変数。手元で叩くための `--pr` / `--repo` 引数でも上書きできる）
 *
 * | 引数 | 既定の環境変数 | 意味 |
 * |---|---|---|
 * | `--pr` | `NO_ATTRIBUTION_TRAILERS_PR_NUMBER` | 検査する PR 番号 |
 * | `--repo` | `GITHUB_REPOSITORY` | `owner/repo` |
 *
 * どちらか1つでも欠けたら、**黙って緑にしない**（`unreadable` ではなく
 * 「呼び方の誤り」として終了コード1。`check-base-overlap.mjs` と同じ理由——
 * `unreadable` は「読もうとしたが読めなかった」用の値であって、読みに行く
 * ための情報が最初から無いのとは別の失敗である）。
 *
 * ## 終了コード
 *
 * | verdict | コード |
 * |---|---|
 * | `clean` | 0 |
 * | `found` | 1 |
 * | `unreadable` | 1 |
 * | （引数不足） | 1 |
 *
 * `found` / `unreadable` は同じ1だが、出力の文言は別である
 * （`check-pr-green.mjs` と同じ方針）。
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';

import {
  commitFullMessage,
  evaluateNoAttributionTrailers,
  formatVerdict,
} from './check-no-attribution-trailers-core.mjs';

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

/** `--flag value` と `--flag=value` の両方を受ける（`check-base-overlap.mjs` と同じ）。 */
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

/**
 * `gh pr view <N> --json body,commits` を叩く。**1回で両方取る**
 * （`AGENTS.md`「静かに失敗する道具」——`gh issue view --comments` が本文を
 * 落とす罠と同じ形を、2回に分けないことで避ける）。
 *
 * 例外は握り潰すが、中身（stderr）は捨てない（`check-pr-green.mjs` /
 * `check-base-overlap.mjs` の `fetch*` と同じ形）。
 */
function fetchPr(prNumber, repo) {
  try {
    const stdout = execFileSync(
      'gh',
      ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'body,commits'],
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

function main() {
  const args = parseArgs(process.argv.slice(2));

  const prRaw = args.pr || process.env.NO_ATTRIBUTION_TRAILERS_PR_NUMBER || '';
  const repo = args.repo || process.env.GITHUB_REPOSITORY || '';

  if (!/^\d+$/.test(prRaw) || repo === '') {
    logError(
      'check-no-attribution-trailers: 呼び方の誤り — --pr/--repo（または ' +
        'NO_ATTRIBUTION_TRAILERS_PR_NUMBER/GITHUB_REPOSITORY）が要る。' +
        'PR の文脈でのみ呼ぶこと（ワークフロー側の if: が担保する）。',
    );
    process.exitCode = 1;
    return;
  }

  const { data, error } = fetchPr(prRaw, repo);

  let body = null;
  let commits = null;
  const fetchErrors = [];

  if (data === null) {
    fetchErrors.push(`gh pr view が失敗した: ${error}`);
  } else {
    // `body` が無い（空の PR 本文）ことと「取得に失敗した」ことは区別する——
    // 前者は空文字として扱い、正常に「読めた」結果にする。
    body = typeof data.body === 'string' ? data.body : '';

    if (Array.isArray(data.commits)) {
      commits = data.commits.map((c) => ({
        oid: typeof c?.oid === 'string' ? c.oid : null,
        headline: typeof c?.messageHeadline === 'string' ? c.messageHeadline : '',
        message: commitFullMessage(c?.messageHeadline, c?.messageBody),
      }));
    } else {
      fetchErrors.push('gh pr view の応答に commits 配列が無い（応答の形が想定と違う）');
    }
  }

  const result = evaluateNoAttributionTrailers({ body, commits });
  const text = formatVerdict(prRaw, result);

  if (result.verdict === 'clean') {
    log(text);
    return;
  }

  logError(text);
  if (result.verdict === 'unreadable') {
    for (const detail of fetchErrors) logError(`  ${detail}`);
  }
  process.exitCode = 1;
}

main();
