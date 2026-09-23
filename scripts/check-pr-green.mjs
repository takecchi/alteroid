#!/usr/bin/env node
/**
 * 指定した sha の CI が「本当に緑か」を判定する（Issue #933）。
 *
 * **判定ロジックはここに置かない。** `check-pr-green-core.mjs` が正本で、
 * なぜ `check-runs`（世代の順序を決めるキーが無い）を経由せず `actions/runs`
 * から降りるのかは、あちらの doc に書いてある。ここはネットワーク（`gh api`）
 * を持ち、結果を出力し、終了コードを決めるだけの薄い層
 * （`check-required-status-checks.mjs` / `check-base-overlap.mjs` と同じ分け方）。
 *
 * ## この道具が言えること・言えないこと
 *
 * - **言えること**: 指定した sha について、workflow 名ごとに最新の run を選び、
 *   その run の jobs がすべて `success` か。**success でないときは、赤
 *   （`red`）・中断（`cancelled`）・対象外（`out-of-scope`。PR の run が
 *   無く、`pull_request` 専用 job が設計どおり skip されただけ）・draft 由来の
 *   疑いが在る skip（`skipped`）を区別して名乗る**（Issue #1197。従来は
 *   この4つを同じ「NG」に丸めていた）。
 * - **言えないこと**: **これが最後の世代だという保証。** 呼んだ直後にもう1本
 *   run が作られうる（`gh pr ready` が新しい run を起こす、再実行される、
 *   等）。緑は「いま見た時点でそうだった」だけを言う。
 * - **測っていないこと**: 再実行（`rerun`）で3世代目が生える sha、`pull_request`
 *   と `workflow_dispatch` が混ざる sha は実測していない（同じ名前で `push` と
 *   `schedule` が混ざる sha は Issue #1225 で実測し、対処した。
 *   `check-pr-green-core.mjs` の doc）。
 * - **書き換えない。** 読むだけである。
 *
 * ## 使い方
 *
 *     node ./scripts/check-pr-green.mjs <sha> [--repo owner/repo]
 *
 * `--repo` の既定は `takecchi/alteroid`。
 *
 * ## 終了コード
 *
 * | verdict | コード |
 * |---|---|
 * | green | 0 |
 * | out-of-scope | 2 |
 * | red / cancelled / skipped / pending / unmeasurable / no-runs | 1 |
 *
 * **`pending`（まだ走行中）・`red`（赤）・`cancelled`（中断）・`skipped`
 * （draft 由来の疑い）を同じ 1 にしてあるが、出力の文言は別である。** どれも
 * 「緑と確定していない」ことが要点なので終了コードは分けず、**何が起きたかは
 * 必ず1行目で名乗る**（`AGENTS.md`「静かに失敗する道具」）。
 *
 * **`out-of-scope` だけは 0（green）でも 1（それ以外を丸めた NG）でもない
 * 第3の値 2 にする**（Issue #1197）。`out-of-scope` は「緑」でも「壊れて
 * いる」でもなく「この道具が答えるべき問いではなかった」を意味する——対象
 * sha が PR の run を持たず（push・schedule 等）、`pull_request` 専用の job
 * （`base-overlap` 等）が設計どおり skip されているだけである。ここを他の
 * NG 系と同じ 1 に丸めると、呼び出し側が「1 = NG = 壊れている」と早合点する
 * 事故がそのまま再発する——それが #1197 で実際に起きたことである
 * （マージ直後の main を検算して `NG` を見た担当が「マージで main を壊した」
 * と読みかけた）。
 *
 * ## なぜ `judgeSha` を export しているか（Issue #1207 の (3)）
 *
 * `.github/scripts/record-release-prod-ci.mjs`（`release/prod` へ夜間反映した
 * sha の CI を記録するだけの道具。止める門ではない）が、**この道具とまったく
 * 同じ判定器を使うため。** 判定ロジックを2箇所に持つと、世代選び（workflow名＋
 * event の組・`created_at`/`id` のtiebreak）や `red`/`cancelled`/`out-of-scope`
 * の切り分けが2つの実装でじわじわずれていく——実際 `check-pr-green-core.mjs`
 * はこの世代選びだけで3回直っている（#933 → #1225）。⟹ ネットワーク層（`gh api`
 * の呼び出しと結果の取りまとめ）を `judgeSha({ sha, repo })` として切り出し、
 * `main()` もこれを呼ぶ形に寄せた。**CLI としての出力・終了コードは1文字も
 * 変えていない**——`main()` は `import.meta.url` が直接起動されたときの
 * エントリポイントと一致するときだけ呼ぶ（`node:url` の `pathToFileURL` で
 * 比較する。import されただけでは走らない）。
 *
 * ## 追記: `events` という任意の絞り口を足した（自己参照バグの修正）
 *
 * `record-release-prod-ci.mjs` が `judgeSha` をそのまま呼ぶと、自分自身が
 * 走っている `release-prod.yml` の run が判定対象に混ざり、構造的に
 * `pending` を返し続ける欠陥があった。塞ぐには「どの run を含めるか」を
 * 絞る口が要るが、**CLI（`main()`）や他の既存の呼び出し元の挙動は変えたく
 * ない**。⟹ `judgeSha({ sha, repo, events })` に任意の第3引数 `events` を
 * 足し、渡さなければ（`undefined`）これまでどおり絞らない。`events` の
 * 中身と絞る理由は `check-pr-green-core.mjs` の `filterRunsByEvent` を見よ。
 *
 * ## 追記: required なのに run が1本も無い門も名乗る（Issue #1290）
 *
 * 2026-09-22、必須チェックを出す workflow（`pr-title.yml`）が GitHub 上で
 * `disabled_manually` にされ、**その門の check-run が永久に生成されなく
 * なった。** `evaluatePrGreen` は観測できた job だけを見るので、生成されな
 * かった門は「存在しない行」として判定から静かに抜け落ち、残った job が
 * 全部 `success` なら `green`（exit=0）を返し続けていた。**「緑になった
 * のにマージできない」——いちばん判断を誤らせる形。**
 *
 * ⟹ `judgeSha` は `evaluatePrGreen` に加えて
 * `findMissingRequiredGates`（`check-pr-green-core.mjs`）も呼び、
 * `.github/required-status-checks.json` の `contexts`（required の**宣言**。
 * ⚠️ branch protection そのものではない）に対し、job として1本も観測され
 * なかった名前を列挙する。**`evaluatePrGreen` の8値の switch には混ぜない**
 * ——別の軸なので、判定結果は `missingRequiredGates` という別のフィールドで
 * 返し、`main()` が両方を並べて報告する。詳しい設計理由（不活性にする条件・
 * `skipped` を「在る」側として扱う理由）は `check-pr-green-core.mjs` の
 * `findMissingRequiredGates` の doc を見よ。**追加のネットワーク呼び出しは
 * しない**——読むのはローカルの宣言ファイルだけである。
 *
 * ⚠️ **`--repo` で既定（`takecchi/alteroid`）以外を指定した呼び出しでは、
 * この検査を不活性にする。** 読んでいる宣言ファイルはこのチェックアウトの
 * `takecchi/alteroid` のものであり、他の repo の required contexts では
 * ない——黙って当てると「他の repo に在る門」を「無い」と誤判定する。
 *
 * ⚠️ **`main()` は `formatMissingRequiredGates` に `evaluatePrGreen` の結果を
 * 渡し、`formatVerdict` をそのまま並べて出さない。** 「required なのに run
 * が無い」と名乗った直後に `check-pr-green(sha): OK —— …` という、道具名
 * から始まり単独の判定として読める行が出ると、`OK` で grep する読み手が
 * その行だけを見て緑だと誤読する（exit code は 1 だが、テキストを読む経路
 * には乗らない）。詳しくは `check-pr-green-core.mjs` の
 * `subordinateEvaluateClause` の doc を見よ。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  evaluatePrGreen,
  filterRunsByEvent,
  findMissingRequiredGates,
  formatMissingRequiredGates,
  formatVerdict,
  isFullCommitSha,
  pickLatestRunPerWorkflow,
} from './check-pr-green-core.mjs';

// `.github/required-status-checks.json` の `contexts`——required contexts の
// **宣言**（`check-required-status-checks.mjs` と同じ読み方・同じファイル）。
// ⚠️ これは branch protection そのものではない。ずれていないかは
// `pnpm check:required-status-checks` が見る（読むには administration 権限の
// あるトークンが要るため、こちらとは別コマンドになっている）。ここでは
// **追加のネットワーク呼び出しをせず**、ローカルのファイルを読むだけである。
const DECLARATION_PATH = join(import.meta.dirname, '..', '.github', 'required-status-checks.json');

// この宣言ファイルは `takecchi/alteroid` の required contexts であって、
// 他の repo の required contexts ではない（INV7）。`--repo` で既定以外を
// 指定した呼び出しでは `findMissingRequiredGates` を不活性にする根拠として
// 使う（`judgeSha` を見よ）。
const DEFAULT_REPO = 'takecchi/alteroid';

/** 宣言ファイルを読む。読めなければ `{ contexts: null, error }` を返す。 */
function loadRequiredContexts() {
  try {
    const raw = JSON.parse(readFileSync(DECLARATION_PATH, 'utf8'));
    if (!Array.isArray(raw.contexts) || raw.contexts.some((name) => typeof name !== 'string')) {
      return {
        contexts: null,
        error: `${DECLARATION_PATH} の contexts が文字列の配列でない`,
      };
    }
    return { contexts: raw.contexts, error: null };
  } catch (error) {
    return { contexts: null, error: `${DECLARATION_PATH} を読めない: ${String(error)}` };
  }
}

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

function parseArgs(argv) {
  let sha = null;
  let repo = DEFAULT_REPO;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') {
      repo = argv[++i];
    } else if (arg.startsWith('--repo=')) {
      repo = arg.slice('--repo='.length);
    } else if (!arg.startsWith('-') && sha === null) {
      sha = arg;
    }
  }
  return { sha, repo };
}

/** `gh api` を呼び、JSON を返す。失敗したら `{ error }` を返す（例外を投げない）。 */
function ghApiJson(path) {
  try {
    const stdout = execFileSync('gh', ['api', path], {
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

/**
 * `judgeSha` はこの道具のネットワーク層＋判定を1つにまとめたものである。
 * **例外を投げない**——`gh api` が読めなかったときは `result: null` と
 * `error`（人が読める文字列）を返す。呼び出し側（`main()` と
 * `record-release-prod-ci.mjs`）はここから先を自分の出力形式へ整形する。
 *
 * ## `events`（任意。Issue #1207 の (3) の自己参照バグ対策）
 *
 * `head_sha` だけで引くと、その sha を名乗るあらゆる event の run
 * （`push` / `schedule` / `workflow_dispatch` / `workflow_run` …）が
 * 一緒に返る。**既定（`events` を渡さない）ではこれまでどおり絞らない**
 * ——CLI（`main()`）を含む既存の呼び出し元の挙動は1ミリも変えない。
 * `events` に配列（例: `['push']`）を渡した呼び出し元だけ、対応する
 * event の run だけを判定に含める。絞り込みの理由と、なぜ
 * `GITHUB_RUN_ID` で自分1本だけを除く案では足りないかは
 * `check-pr-green-core.mjs` の `filterRunsByEvent` の doc を見よ。
 *
 * @param {{ sha: string, repo: string, events?: string[] }} input
 * @returns {{
 *   result: import('./check-pr-green-core.mjs').EvaluatePrGreenResult | null,
 *   latestRuns: object[],
 *   jobsByRunId: Record<number, object[]>,
 *   error: string | null,
 *   missingRequiredGates:
 *     | import('./check-pr-green-core.mjs').FindMissingRequiredGatesResult
 *     | { status: 'error', reason: string }
 *     | null,
 * }}
 */
export function judgeSha({ sha, repo, events }) {
  // ⭐ 略記の sha を弾く（Issue #1192 の N5 の具体形）。
  // `actions/runs?head_sha=` は略記を渡すと**エラーではなく空の一覧**を返すため、
  // ここで拒まないと「run が1つも無い」（= no-runs）に化け、**赤いコミットが
  // 「CI が走っていない」として読まれる。** 理由と実測は
  // `check-pr-green-core.mjs` の `isFullCommitSha` の doc を見よ。
  if (!isFullCommitSha(sha)) {
    return {
      result: null,
      latestRuns: [],
      jobsByRunId: {},
      missingRequiredGates: null,
      error:
        `完全な40文字のコミット sha を渡すこと（受け取った値: ${String(sha)}）。` +
        '略記を渡すと actions/runs は空の一覧を返し、run が1つも無いのか、' +
        '引けない sha だったのかを区別できない。',
    };
  }

  const runsPath = `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`;
  const { data: runsData, error: runsError } = ghApiJson(runsPath);
  if (runsData === null) {
    return {
      result: null,
      latestRuns: [],
      jobsByRunId: {},
      missingRequiredGates: null,
      error: `run 一覧を読めない\n  gh の出力: ${runsError}`,
    };
  }

  const runs = Array.isArray(runsData.workflow_runs) ? runsData.workflow_runs : [];
  const scopedRuns = filterRunsByEvent(runs, events);
  const latestRuns = pickLatestRunPerWorkflow(scopedRuns);

  const jobsByRunId = {};
  for (const run of latestRuns) {
    if (run.status !== 'completed') continue; // まだ終わっていない run の jobs は問い合わせるだけ無駄
    const { data: jobsData, error: jobsError } = ghApiJson(
      `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
    );
    if (jobsData === null) {
      return {
        result: null,
        latestRuns,
        jobsByRunId,
        missingRequiredGates: null,
        error: `run ${run.id} の jobs を読めない\n  gh の出力: ${jobsError}`,
      };
    }
    jobsByRunId[run.id] = Array.isArray(jobsData.jobs) ? jobsData.jobs : [];
  }

  const result = evaluatePrGreen(latestRuns, jobsByRunId);

  // `events` を渡した呼び出し（record-release-prod-ci.mjs 等）では
  // `findMissingRequiredGates` を構造的に不活性にする（INV2。`scoped` が
  // その入力になる）——絞り込みは pull_request 専用の run を意図的に
  // 落とすので、そのまま当てると真の欠落でない門を誤検知する。
  const scoped = events !== undefined && events !== null;
  // `--repo` で既定（`takecchi/alteroid`）以外を指定した呼び出しも同様に
  // 不活性にする（INV7）——`loadRequiredContexts()` が読むのはこのチェック
  // アウトの `.github/required-status-checks.json`（`takecchi/alteroid` の
  // 宣言）であって、他の repo の required contexts ではない。黙って当てると
  // 「他の repo に在る門」を「無い」と誤判定する。
  const crossRepo = repo !== DEFAULT_REPO;
  const { contexts: requiredContexts, error: declarationError } = loadRequiredContexts();
  const missingRequiredGates =
    requiredContexts === null
      ? { status: 'error', reason: declarationError }
      : findMissingRequiredGates({
          requiredContexts,
          verdict: result.verdict,
          scoped,
          crossRepo,
          latestRuns,
          jobsByRunId,
        });

  return { result, latestRuns, jobsByRunId, error: null, missingRequiredGates };
}

function main() {
  const { sha, repo } = parseArgs(process.argv.slice(2));
  if (sha === null || sha.trim() === '') {
    logError('check-pr-green: 使い方: node ./scripts/check-pr-green.mjs <sha> [--repo owner/repo]');
    process.exitCode = 1;
    return;
  }

  const { result, error, missingRequiredGates } = judgeSha({ sha, repo });
  if (result === null) {
    logError(`check-pr-green(${sha}): 判定できなかった —— ${error}`);
    process.exitCode = 1;
    return;
  }

  // required なのに宣言ファイルが読めず、判定できなかった（Issue #1290）。
  // ⚠️ これは「required な job が観測できた」ことを何も言っていないので、
  // 黙って green のまま抜けない——ただし declaration の読み込み失敗は
  // evaluatePrGreen の判定そのものとは独立の軸なので、終了コードは
  // evaluatePrGreen の verdict にまかせる（AGENTS.md「静かに失敗する道具」）。
  if (missingRequiredGates?.status === 'error') {
    logError(
      `check-pr-green(${sha}): required contexts の宣言を読めなかった —— 「required なのに run が無い門」の検査は今回スキップされた: ${missingRequiredGates.reason}`,
    );
  }

  // Issue #1290: evaluatePrGreen が green でも、required なのに run が
  // 1本も無い門が在れば緑を名乗らない（INV1）。8値の switch には混ぜず、
  // 別の軸として先に名指しする。
  //
  // ⚠️ INV6: `formatVerdict(sha, result)` をこの下にそのまま並べない。
  // それは「check-pr-green(sha): OK —— …」という、単独の判定として読める
  // 行を作ってしまい、`OK` で grep する読み手が NG の直後の行だけを見て
  // 緑だと誤読する（exit code は 1 だが、テキストを読む経路には乗らない）。
  // `formatMissingRequiredGates` に `result` を渡すと、evaluatePrGreen 側の
  // 判定を単独の判定としては読めない従属節へ畳んで一緒に返す。
  if (missingRequiredGates?.status === 'checked' && missingRequiredGates.missing.length > 0) {
    logError(formatMissingRequiredGates(sha, missingRequiredGates.missing, result));
    process.exitCode = 1;
    return;
  }

  const text = formatVerdict(sha, result);

  if (result.verdict === 'green') {
    log(text);
    return;
  }
  logError(text);
  process.exitCode = result.verdict === 'out-of-scope' ? 2 : 1;
}

// 直接起動されたときだけ走る。import されたとき（`record-release-prod-ci.mjs`
// からの `judgeSha` 利用や、将来のテスト）に副作用として CLI が起きないように
// するため（`node:url` の `pathToFileURL` で自分自身の URL と argv[1] を比べる）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
