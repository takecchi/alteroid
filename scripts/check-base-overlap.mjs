#!/usr/bin/env node
/**
 * PR の base が古く、かつ merge base 以降に main へ入った変更が、この PR と
 * 同じファイルを触っているときだけ赤くする（Issue #838）。
 *
 * **判定ロジックはここに置かない。** `check-base-overlap-core.mjs` が正本で、
 * compare API の向きの実測・4値の verdict・300件打ち切りの扱い・PR番号抽出の
 * 理由はあちらの doc に書いてある。ここはネットワーク（`gh api`）を叩き、
 * 結果を出力し、終了コードを決めるだけの薄い層。
 *
 * ## この道具が言えること・言えないこと
 *
 * - **言えること**: いま呼ばれた時点の `base`/`head`/main の状態から、
 *   「base 以降に main へ入った変更」と「この PR が触るファイル」が重なって
 *   いるか。重なっていれば、どの main 側コミットが原因かも（拾えた範囲で）。
 * - **言えないこと**: **将来 main が進んだ後もこの判定が有効か。** `main` の
 *   ブランチ保護は `strict=false`（2026-09-12実測）なので、この判定の直後にも
 *   main は進みうる。⟹ 緑は「いま測った時点で重ならなかった」だけを言う。
 * - **書き換えない。** 読むだけである。
 *
 * ## 入力
 *
 * 環境変数を既定にし、コマンドライン引数（`--flag value` / `--flag=value`）で
 * 上書きできる（手元で叩けるようにするため）。
 *
 * | 引数 | 既定の環境変数 | 意味 |
 * |---|---|---|
 * | `--repo` | `GITHUB_REPOSITORY` | `owner/repo` |
 * | `--base` | `GITHUB_BASE_REF` | PR の base ブランチ名（例: `main`） |
 * | `--head` | `BASE_OVERLAP_HEAD_SHA` | PR の head の sha。**このスクリプトが決めた名前**——`GITHUB_SHA` は pull_request イベントでは merge commit の sha であって head そのものではないため、ワークフロー側で `github.event.pull_request.head.sha` を明示的にこの名前で渡す |
 * | `--pr` | `BASE_OVERLAP_PR_NUMBER` | PR 番号（メッセージに出すだけ。任意） |
 *
 * `--repo` / `--base` / `--head` が1つでも欠けたら、**黙って緑にしない。**
 * これは「PR の文脈で呼ばれなかった」ではなく「呼び方が誤っている」として
 * 扱う（終了コード1、`unmeasurable` にはしない——`unmeasurable` は「読もうと
 * したが読めなかった」用の値で、こちらは「読みに行くための情報が最初から
 * 無い」なので別の失敗として扱うほうが筋が良い）。**「PR 以外では走らせない」
 * のはワークフロー側の `if:` が担保する**（`ci.yml` の `base-overlap` ジョブの
 * doc）。
 *
 * ## 終了コード
 *
 * | verdict | コード |
 * |---|---|
 * | `fresh` | 0 |
 * | `no-overlap` | 0 |
 * | `overlap` | 1 |
 * | `unmeasurable` | 1 |
 * | （引数不足） | 1 |
 *
 * `overlap` と `unmeasurable` は同じ1だが、出力の文言は別である
 * （`check-required-status-checks.mjs` と同じ方針）。
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';

import { attributeOverlapFiles, decideVerdict, formatResult } from './check-base-overlap-core.mjs';

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

/** `--flag value` と `--flag=value` の両方を受ける、この用途に足るだけの簡易パーサ。 */
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
 * `gh api repos/{repo}/compare/{a}...{b}` を叩き、判定に要る形へ畳む。
 *
 * **例外は握り潰すが、中身（stderr）は捨てない**（`check-required-status-checks.mjs`
 * の `fetchProtection()` と同じ形）。読めなかった理由（401/403/ネットワーク/
 * 存在しない ref）は、次の一手を決める材料そのものである。
 */
function fetchCompare(repo, a, b) {
  try {
    const stdout = execFileSync('gh', ['api', `repos/${repo}/compare/${a}...${b}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const json = JSON.parse(stdout);
    const files = Array.isArray(json.files) ? json.files.map((f) => f.filename) : [];
    const commits = Array.isArray(json.commits)
      ? json.commits.map((c) => ({ sha: c.sha, message: c.commit?.message ?? '' }))
      : [];
    const mergeBase = json.merge_base_commit?.sha ?? null;
    return {
      data: { behindBy: json.behind_by, files, mergeBase, commits },
      error: null,
    };
  } catch (error) {
    const detail =
      error !== null && typeof error === 'object' && 'stderr' in error && error.stderr
        ? String(error.stderr).trim()
        : String(error);
    return { data: null, error: detail };
  }
}

/** `gh api repos/{repo}/commits/{sha}` からその1コミットが触ったファイル名一覧を取る。 */
function fetchCommitFiles(repo, sha) {
  try {
    const stdout = execFileSync('gh', ['api', `repos/${repo}/commits/${sha}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const json = JSON.parse(stdout);
    return Array.isArray(json.files) ? json.files.map((f) => f.filename) : [];
  } catch {
    // 読めなかった1コミットは「そのコミットは無かったことにする」——帰属が
    // 付かないファイルは `attributeOverlapFiles` 側で `(帰属不明)` になる。
    return null;
  }
}

/**
 * overlap したファイルの持ち主を、main 側コミットを新しい順に1件ずつ引きながら
 * 探す。**必要な分だけ叩く**——overlap 済みファイル全部の帰属が付いた時点で
 * 打ち切る（behind_by が大きいほど commits も多くなりうるので、無条件に
 * 全件を引かない）。
 *
 * `commits` は `compare/{mergeBase}...{base}` の応答順（古い→新しいが実測での
 * 既定）を前提に、ここで新しい順へ並べ替えてから使う。
 */
function attributeLazily(repo, overlapFiles, commits) {
  const remaining = new Set(overlapFiles);
  const commitsWithFiles = [];
  const newestFirst = [...commits].reverse();
  for (const commit of newestFirst) {
    if (remaining.size === 0) break;
    const files = fetchCommitFiles(repo, commit.sha);
    if (files === null) continue;
    commitsWithFiles.push({ sha: commit.sha, message: commit.message, files });
    for (const path of files) remaining.delete(path);
  }
  return attributeOverlapFiles(overlapFiles, commitsWithFiles);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const repo = args.repo || process.env.GITHUB_REPOSITORY || '';
  const base = args.base || process.env.GITHUB_BASE_REF || '';
  const head = args.head || process.env.BASE_OVERLAP_HEAD_SHA || '';
  const prRaw = args.pr || process.env.BASE_OVERLAP_PR_NUMBER || '';
  const pr = /^\d+$/.test(prRaw) ? Number(prRaw) : null;

  if (repo === '' || base === '' || head === '') {
    logError(
      'check-base-overlap: 呼び方の誤り — --repo/--base/--head（または ' +
        'GITHUB_REPOSITORY/GITHUB_BASE_REF/BASE_OVERLAP_HEAD_SHA）が要る。' +
        'PR の文脈でのみ呼ぶこと（ワークフロー側の if: が担保する）。',
    );
    process.exitCode = 1;
    return;
  }

  const context = { repo, base, head, pr };

  const firstRaw = fetchCompare(repo, base, head);
  const first = firstRaw.data;

  let secondRaw = null;
  let second = null;
  if (first !== null && first.behindBy !== 0) {
    secondRaw = fetchCompare(repo, first.mergeBase, base);
    second = secondRaw.data;
  }

  const result = decideVerdict({ first, second });

  let attributions = null;
  if (result.verdict === 'overlap') {
    attributions = attributeLazily(repo, result.overlap, second.commits);
  }

  const text = formatResult(result, context, attributions);

  if (result.verdict === 'fresh' || result.verdict === 'no-overlap') {
    log(text);
    return;
  }

  logError(text);
  if (result.reason === 'unreadable-head' && firstRaw.error !== null) {
    logError(`  gh の出力 (compare/${base}...${head}): ${firstRaw.error}`);
  }
  if (result.reason === 'unreadable-main' && secondRaw !== null && secondRaw.error !== null) {
    logError(`  gh の出力 (compare/${first.mergeBase}...${base}): ${secondRaw.error}`);
  }
  process.exitCode = 1;
}

main();
