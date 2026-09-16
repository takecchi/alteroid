#!/usr/bin/env node
/**
 * この PR の**タイトル**が規約の型（`<type>: <description>`）を持つことを
 * 確かめる（`pnpm check:pr-title-type`。Issue #1097）。
 *
 * **判定ロジックはここに置かない。** `check-pr-title-type-core.mjs` が正本で、
 * なぜ fail-closed にするのか・なぜ `(scope)` と先頭の `[…]` を許して `!` を
 * 許さないのか（根拠はどれも `main` の実測）はあちらの doc に書いてある。
 * ここはネットワーク（`gh pr view`）を持ち、結果を出力し、終了コードを決める
 * だけの薄い層（`check-no-attribution-trailers.mjs` / `check-pr-green.mjs` と
 * 同じ分け方）。
 *
 * ## この道具が言えること・言えないこと
 *
 * - **言えること**: 呼ばれた時点の PR のタイトルが型を持つか。
 * - **言えないこと**: **この判定の後にタイトルが変わらないという保証。**
 *   ⚠️ だからこの門を起こす workflow（`.github/workflows/pr-title.yml`）は
 *   `pull_request.types` に **`edited` を含む。** `ci.yml` 側は含まないので
 *   （`grep -Fn -- 'types: [opened, synchronize, reopened, ready_for_review]' .github/workflows/ci.yml`）、
 *   あちらへ相乗りしていたら「タイトルを後から書き換える」という**いちばん通り
 *   やすい経路**が素通りしていた。
 * - **書き換えない。** 読むだけである。タイトルを直すのは書き手の仕事で、門が
 *   勝手に直すと「規約を守った」という記録だけが残って中身が伴わなくなる。
 *
 * ## タイトルを event payload からではなく `gh pr view` で取る理由
 *
 * `github.event.pull_request.title` は**そのイベントが起きた時点の**値である。
 * `synchronize` で起きた run が持つのは push 時点のタイトルなので、直前の編集と
 * 競合すると古い値で判定しうる。**`gh pr view` は呼んだ瞬間の現物を返す**ので、
 * 判定と実物のずれが小さい側へ倒す（fail-closed と同じ向き）。
 *
 * ## 入力（環境変数。手元で叩くための `--pr` / `--repo` 引数でも上書きできる）
 *
 * | 引数 | 既定の環境変数 | 意味 |
 * |---|---|---|
 * | `--pr` | `PR_TITLE_TYPE_PR_NUMBER` | 検査する PR 番号 |
 * | `--repo` | `GITHUB_REPOSITORY` | `owner/repo` |
 *
 * どちらか1つでも欠けたら、**黙って緑にしない**（`unreadable` ではなく「呼び方の
 * 誤り」として終了コード1。`check-no-attribution-trailers.mjs` と同じ理由——
 * `unreadable` は「読もうとしたが読めなかった」用の値であって、読みに行くための
 * 情報が最初から無いのとは別の失敗である）。
 *
 * ## 終了コード
 *
 * | verdict | コード |
 * |---|---|
 * | `ok` | 0 |
 * | `missing-type` | 1 |
 * | `unreadable` | 1 |
 * | （引数不足） | 1 |
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';

import { evaluatePrTitleType, formatVerdict } from './check-pr-title-type-core.mjs';

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
 * `gh pr view <N> --json title` を叩く。例外は握り潰すが、中身（stderr）は
 * 捨てない（`check-no-attribution-trailers.mjs` の `fetchPr` と同じ形）。
 */
function fetchTitle(prNumber, repo) {
  try {
    const stdout = execFileSync(
      'gh',
      ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'title'],
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

  const prRaw = args.pr || process.env.PR_TITLE_TYPE_PR_NUMBER || '';
  const repo = args.repo || process.env.GITHUB_REPOSITORY || '';

  if (!/^\d+$/.test(prRaw) || repo === '') {
    logError(
      'check-pr-title-type: 呼び方の誤り — --pr/--repo（または ' +
        'PR_TITLE_TYPE_PR_NUMBER/GITHUB_REPOSITORY）が要る。' +
        'PR の文脈でのみ呼ぶこと（ワークフロー側の if: が担保する）。',
    );
    process.exitCode = 1;
    return;
  }

  const { data, error } = fetchTitle(prRaw, repo);

  const fetchErrors = [];
  // `title` が文字列でなければ `null` を渡して `unreadable` へ倒す——GitHub は
  // 空のタイトルを許さないので、「取れたが文字列でない」は取得の失敗である。
  let title = null;

  if (data === null) {
    fetchErrors.push(`gh pr view が失敗した: ${error}`);
  } else if (typeof data.title === 'string') {
    title = data.title;
  } else {
    fetchErrors.push('gh pr view の応答に title が無い（応答の形が想定と違う）');
  }

  const result = evaluatePrTitleType({ title });
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
