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
 * `check-pr-vanished-footprint.mjs` と同じ分け方）。
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
 *   含む（`no-attribution-trailers.yml` と同じ理由）。
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
 *
 * ## この道具は #1134 の案3（散文の閉じる意思のヒント）もここから配線する
 *
 * この门（#1109）と #1134 は根が同じ（GitHub の閉じるキーワードパーサに閉じる
 * 意思を預けたときの2つの倒れ方）だが、**判定は完全に独立している。**
 * `issue-intent-hint-core.mjs`（正本）が「日本語の散文＋参照＋trailer 無し」を
 * 見て `evaluateIssueIntentHint` を返す。ここでは新しい workflow も新しい
 * `check:*` script も足していない——この runner が既に `gh pr view --json
 * title,body,commits` で必要なものを1回で取っており、呼び出し元の workflow
 * （`.github/workflows/pr-closing-keywords.yml`）は既に `edited` でも起きるので、
 * 配線の追加費用がゼロだった。
 *
 * **⛔ このヒントは上の終了コードの表を1文字も変えない。** `hint` が出ても
 * 常に exit 0（`ok` の場合）または 1（`found`/`unreadable`/引数不足の場合。
 * ただしその1はヒントが理由ではなく元の verdict が理由）のままである
 * ——#1134 が「PR を落とすのではなく警告して trailer を促す」「门は hard
 * fail にせず降りられる口を必ず付けること」と明記しているため。
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
// **`issue-intent-hint-core.mjs`（Issue #1134 の案3）をここから配線する。**
// 新しい workflow も新しい `check:*` script も足さない——この runner は既に
// `gh pr view --json title,body,commits` で title/body を1回で取っており、
// 呼び出し元の workflow（`pr-closing-keywords.yml`）は `edited` でも起きるので、
// 配線の追加費用がゼロである。**このヒントは終了コードに一切関わらない**
// （下の `main` の呼び出し箇所を見よ——`process.exitCode` は既存の
// `evaluatePrClosingKeywords` の verdict だけで決まる）。
import {
  evaluateIssueIntentHint,
  formatIssueIntentHintEvaluation,
} from './issue-intent-hint-core.mjs';

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

/**
 * `issue-intent-hint-core.mjs` の判定を出力する。**終了コードには関わらない**
 * （呼び出し側で `process.exitCode` を一切書かない）。
 *
 * Actions の上（`GITHUB_ACTIONS` が真）では GitHub の警告注釈
 * （`::warning::` 形式）でも出す。`::warning::` は改行をそのまま扱えない
 * ため、注釈は1行に畳んだ要約にし、詳細（各文の逐語）は通常の出力にも
 * 別に印字する——注釈だけを見た人にも「詳細は下のログにある」ことが
 * 分かるようにする。手元（`GITHUB_ACTIONS` が無い）では素のテキストだけを
 * 出す。
 */
function logIssueIntentHint(result) {
  if (result.verdict !== 'hint') return;

  const text = formatIssueIntentHintEvaluation(result);

  if (process.env.GITHUB_ACTIONS === 'true') {
    const summary = result.findings
      .map((f) => `${f.source}「${f.sentence}」`)
      .join(' / ')
      .replace(/\r?\n/g, ' ');
    log(
      `::warning::issue-intent-hint: 閉じる意思の文が見つかったが Alteroid-Issue-Done ` +
        `trailer が無い（${result.findings.length}件。詳細は下のログ）: ${summary}`,
    );
  }

  log(text);
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
    // として扱う（かつて存在した `check-pr-title-type.mjs`。2026-09-22 廃止、と
    // 同じ判断）。
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

  // **ここは既存の判定・出力・終了コードを一切変えない。** `found` の時も
  // ヒントは出してよいが（#1134）、`ok` / `found` / `unreadable` の分岐と
  // `process.exitCode` の決め方は変えていない——ヒントは常にこの分岐の外
  // （下の `logIssueIntentHint` 呼び出し）で、分岐のどのパスでも同じ形で足す。
  const intentHint = evaluateIssueIntentHint({ title, body });

  if (result.verdict === 'ok') {
    log(text);
    logIssueIntentHint(intentHint);
    return;
  }

  logError(text);
  if (result.verdict === 'unreadable') {
    for (const detail of fetchErrors) logError(`  ${detail}`);
  }
  logIssueIntentHint(intentHint);
  process.exitCode = 1;
}

main();
