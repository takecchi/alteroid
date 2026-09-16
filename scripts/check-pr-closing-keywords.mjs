#!/usr/bin/env node
/**
 * この PR のタイトル・本文・全コミットメッセージのどれにも、GitHub に解釈される
 * 「閉じるキーワード＋参照」の組が、意図せず閉じる形で残っていないことを確かめる
 * （`pnpm check:pr-closing-keywords`。Issue #1109）。
 *
 * **判定ロジックはここに置かない。** `check-pr-closing-keywords-core.mjs` が
 * 正本で、なぜ fail-closed にするのか・キーワードと参照の形・通す形／落とす形の
 * 5分類・優先順位の根拠・公式 doc で確認できたこと/できなかったことは、あちらの
 * doc に書いてある。ここはネットワーク（`gh pr view`）を持ち、結果を出力し、
 * 終了コードを決めるだけの薄い層（`check-no-attribution-trailers.mjs` /
 * `check-pr-title-type.mjs` と同じ分け方）。
 *
 * ## この道具が言えること・言えないこと
 *
 * - **言えること**: 呼ばれた時点の PR のタイトル・本文・全コミットメッセージの
 *   どれにも、この門が定義する意味での「閉じるキーワード＋参照」が意図せず
 *   閉じる形で無いか。
 * - **言えないこと**: **この判定の後にタイトル・本文・コミットが変わらない
 *   という保証。** タイトル・本文の編集だけでは新しい workflow run が起きない
 *   ので（`ci.yml` の `pull_request.types` に `edited` を含めていない）、この門を
 *   起こす workflow（`.github/workflows/pr-closing-keywords.yml`）は `edited` を
 *   含む（`pr-title.yml` と同じ理由）。
 * - **書き換えない。** 読むだけである。
 *
 * ## 入力（環境変数。手元で叩くための `--pr` / `--repo` 引数でも上書きできる）
 *
 * | 引数 | 既定の環境変数 | 意味 |
 * |---|---|---|
 * | `--pr` | `PR_CLOSING_KEYWORDS_PR_NUMBER` | 検査する PR 番号 |
 * | `--repo` | `GITHUB_REPOSITORY` | `owner/repo` |
 *
 * どちらか1つでも欠けたら、**黙って緑にしない**（`unreadable` ではなく
 * 「呼び方の誤り」として終了コード1。`check-no-attribution-trailers.mjs` と
 * 同じ理由——`unreadable` は「読もうとしたが読めなかった」用の値であって、
 * 読みに行くための情報が最初から無いのとは別の失敗である）。
 *
 * ## 終了コード
 *
 * | verdict | コード |
 * |---|---|
 * | `ok` | 0 |
 * | `found` | 1 |
 * | `unreadable` | 1 |
 * | （引数不足） | 1 |
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';

// **`commitFullMessage` は `check-no-attribution-trailers-core.mjs` の export を
// そのまま使い回す。** 同じ形の関数をここに書き写さない——`gh pr view --json
// commits` が返す `messageHeadline` / `messageBody` を素のコミットメッセージの形
// （1行目・空行・以降）へ組み立てる合成は、この門でも同じ形が要るが、既に
// export されている以上、重複させる理由が無い。
import { commitFullMessage } from './check-no-attribution-trailers-core.mjs';
import { evaluatePrClosingKeywords, formatVerdict } from './check-pr-closing-keywords-core.mjs';

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

/** `--flag value` と `--flag=value` の両方を受ける（`check-no-attribution-trailers.mjs` と同じ）。 */
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
 * `gh pr view <N> --json title,body,commits` を叩く。**1回で3つとも取る**
 * （`AGENTS.md`「静かに失敗する道具」——`gh issue view --comments` が本文を
 * 落とす罠と同じ形を、複数回に分けないことで避ける）。
 *
 * 例外は握り潰すが、中身（stderr）は捨てない（`check-no-attribution-trailers.mjs`
 * の `fetchPr` と同じ形）。
 */
function fetchPr(prNumber, repo) {
  try {
    const stdout = execFileSync(
      'gh',
      ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'title,body,commits'],
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

  const prRaw = args.pr || process.env.PR_CLOSING_KEYWORDS_PR_NUMBER || '';
  const repo = args.repo || process.env.GITHUB_REPOSITORY || '';

  if (!/^\d+$/.test(prRaw) || repo === '') {
    logError(
      'check-pr-closing-keywords: 呼び方の誤り — --pr/--repo（または ' +
        'PR_CLOSING_KEYWORDS_PR_NUMBER/GITHUB_REPOSITORY）が要る。' +
        'PR の文脈でのみ呼ぶこと（ワークフロー側の trigger が担保する）。',
    );
    process.exitCode = 1;
    return;
  }

  const { data, error } = fetchPr(prRaw, repo);

  let title = null;
  let body = null;
  let commits = null;
  const fetchErrors = [];

  if (data === null) {
    fetchErrors.push(`gh pr view が失敗した: ${error}`);
  } else {
    // GitHub は空のタイトルを許さないので、`title` が文字列でなければ取得の失敗
    // として扱う（`check-pr-title-type.mjs` と同じ判断）。
    if (typeof data.title === 'string') {
      title = data.title;
    } else {
      fetchErrors.push('gh pr view の応答に title が無い（応答の形が想定と違う）');
    }

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

  const result = evaluatePrClosingKeywords({ title, body, commits });
  const text = formatVerdict(prRaw, result);

  if (result.verdict === 'ok') {
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
