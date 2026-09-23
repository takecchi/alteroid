#!/usr/bin/env node
/**
 * 枝を消す前に「必ず見るべきもの」を機械で集める道具
 * （`pnpm branch:deletable -- <枝名> [<枝名> ...]`）。
 *
 * **判定ロジックはここに置かない。** `branch-deletable-core.mjs` が正本で、
 * なぜこの道具を作ったか（2026-09-20 の一括削除で、削除前から保持の言明が
 * 在った9本が削除リストに紛れ込んでいた）・検査Bがなぜ定型句ではなく
 * 「枝／ブランチ」＋保持語の同居で判定するのか（狭いパターンだと静かに
 * 取りこぼす実測）・誤検出が仕様である理由はあちらの doc に書いてある。
 * ここは `git grep` と `gh` を呼び、結果を渡し、出力して終了コードを決める
 * だけの薄い層（`check-no-attribution-trailers.mjs` と同じ分け方）。
 *
 * ## ⚠️ この道具が言えること・言えないこと
 *
 * - **言えること**: 呼ばれた時点の `origin/main` の追跡ファイルにその枝名が
 *   現れるか、その枝を head とする PR（state を問わない）の本文・コメントに
 *   「枝／ブランチ」と保持語が同居する箇所が在るか。
 * - **言えないこと（重要）**: **これは判定ではない。** 「消してよい」とも
 *   「消してはいけない」とも出力しない。検査Bは誤検出を含む（同じ理由で
 *   本物を取りこぼさないため、語の組をゆるく取っている）。当たった箇所は
 *   必ず人が読んで判断すること。
 * - **`main` を fetch しない。** 呼び出し前に `git fetch origin main` を自分で
 *   済ませておくこと（このスクリプトが検査する `origin/main` は、呼ばれた
 *   時点のローカルの ref である）。
 *
 * ## なぜ `check:` という名前にしないか
 *
 * `scripts/check-scripts-wired.test.ts` は `package.json` の `check:*` を
 * 導出し、`verify-core.mjs` の `STEPS` か `.github/workflows/` のどこかから
 * 呼ばれているかを測る。この道具は CI で走らせる意味が無い——PR の時点では
 * 何も判定できず、枝を消すときに人間／AI が手で打つものである。⟹ 名前は
 * `branch:deletable`（`check:` で始めない）。
 *
 * ## 検査Aで使う `<owner>/<repo>` の決め方
 *
 * `--repo` 引数 → `GITHUB_REPOSITORY` 環境変数 → `git remote get-url origin`
 * から解釈、の順で決める（手元で叩くときに何も指定しなくても動くように）。
 *
 * ## 終了コード
 *
 * 渡した枝のどれか1本でも、検査A・検査Bのどちらかに1件でも当たれば 1。
 * 全枝が0件なら 0。
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';

import {
  buildReport,
  evaluateRetentionSources,
  parseGitGrepMatches,
} from './branch-deletable-core.mjs';

const MAIN_REV = 'origin/main';

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

/** `--flag value` / `--flag=value` を引数から抜き取り、残りを位置引数として返す。 */
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = '';
    }
  }
  return { flags, positional };
}

function runCapture(cmd, args) {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { stdout, error: null };
  } catch (error) {
    // `git grep` は「該当なし」を exit 1 で返す。stdout は空のはず——
    // それとエラー（コマンドが無い・rev が無い等）を区別する
    // （`AGENTS.md`「静かに失敗する道具」— 件数と終了コードは別のこと）。
    const status = error && typeof error === 'object' && 'status' in error ? error.status : null;
    const stdout =
      error && typeof error === 'object' && 'stdout' in error ? String(error.stdout ?? '') : '';
    if (cmd === 'git' && status === 1) {
      return { stdout, error: null };
    }
    const detail =
      error !== null && typeof error === 'object' && 'stderr' in error && error.stderr
        ? String(error.stderr).trim()
        : String(error);
    return { stdout: null, error: detail };
  }
}

function resolveRepo(flags) {
  if (flags.repo) return flags.repo;
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const { stdout } = runCapture('git', ['remote', 'get-url', 'origin']);
  if (typeof stdout === 'string') {
    const m = stdout.trim().match(/[:/]([^/]+\/[^/]+?)(\.git)?$/);
    if (m) return m[1];
  }
  return null;
}

/** 検査A: `git grep -n -F -- '<枝名>' origin/main` を打ち、構造化して返す。 */
function checkA(branchName) {
  const { stdout, error } = runCapture('git', ['grep', '-n', '-F', '--', branchName, MAIN_REV]);
  if (error !== null) {
    return { matches: [], errors: [`git grep が失敗した: ${error}`] };
  }
  return { matches: parseGitGrepMatches(stdout ?? '', MAIN_REV), errors: [] };
}

/** その枝を head とする PR（state 問わず）の番号一覧を取る。 */
function listPrs(branchName, repo) {
  const { stdout, error } = runCapture('gh', [
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'all',
    '--head',
    branchName,
    '--json',
    'number',
  ]);
  if (error !== null) return { numbers: [], error: `gh pr list が失敗した: ${error}` };
  try {
    const parsed = JSON.parse(stdout ?? '[]');
    return { numbers: parsed.map((p) => p.number), error: null };
  } catch {
    return { numbers: [], error: 'gh pr list の応答が JSON として読めなかった' };
  }
}

/** 1件の PR の本文と全コメントを、検査Bへ渡す `sources` の形に組み立てる。 */
function collectPrSources(prNumber, repo) {
  const errors = [];
  const sources = [];

  const bodyResult = runCapture('gh', [
    'pr',
    'view',
    String(prNumber),
    '--repo',
    repo,
    '--json',
    'body',
  ]);
  if (bodyResult.error !== null) {
    errors.push(`PR #${prNumber}: gh pr view が失敗した: ${bodyResult.error}`);
  } else {
    try {
      const parsed = JSON.parse(bodyResult.stdout ?? '{}');
      sources.push({
        prNumber,
        source: '本文',
        text: typeof parsed.body === 'string' ? parsed.body : '',
      });
    } catch {
      errors.push(`PR #${prNumber}: gh pr view の応答が JSON として読めなかった`);
    }
  }

  const commentsResult = runCapture('gh', [
    'api',
    `repos/${repo}/issues/${prNumber}/comments`,
    '--paginate',
  ]);
  if (commentsResult.error !== null) {
    errors.push(`PR #${prNumber}: gh api .../comments が失敗した: ${commentsResult.error}`);
  } else {
    try {
      // `gh api --paginate` は、応答が JSON 配列のエンドポイントでは複数ページを
      // 自動で1本の配列へ連結して出す（実測、この道具で確認済み）。
      const raw = (commentsResult.stdout ?? '').trim();
      const parsed = raw.length === 0 ? [] : JSON.parse(raw);
      for (const c of parsed) {
        sources.push({
          prNumber,
          source: `コメント(id ${c?.id ?? '不明'})`,
          text: typeof c?.body === 'string' ? c.body : '',
        });
      }
    } catch {
      errors.push(`PR #${prNumber}: gh api .../comments の応答が JSON として読めなかった`);
    }
  }

  return { sources, errors };
}

function checkB(branchName, repo) {
  const { numbers, error } = listPrs(branchName, repo);
  if (error !== null) {
    return { hits: [], errors: [error] };
  }
  const allSources = [];
  const errors = [];
  for (const prNumber of numbers) {
    const { sources, errors: prErrors } = collectPrSources(prNumber, repo);
    allSources.push(...sources);
    errors.push(...prErrors);
  }
  const hits = evaluateRetentionSources(allSources);
  return { hits, errors };
}

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));

  if (positional.length === 0) {
    logError('branch-deletable: 枝名を1つ以上渡すこと（例: pnpm branch:deletable -- fix/foo）');
    process.exitCode = 1;
    return;
  }

  const repo = resolveRepo(flags);
  if (!repo) {
    logError(
      'branch-deletable: owner/repo を決められなかった —— --repo か GITHUB_REPOSITORY を渡すこと' +
        '（git remote get-url origin からの解釈にも失敗した）。',
    );
    process.exitCode = 1;
    return;
  }

  const branchResults = [];
  for (const branchName of positional) {
    const a = checkA(branchName);
    const b = checkB(branchName, repo);
    branchResults.push({
      branch: branchName,
      checkAMatches: a.matches,
      checkBHits: b.hits,
      errors: [...a.errors, ...b.errors],
    });
  }

  const { text, exitCode } = buildReport(branchResults);
  log(text);
  process.exitCode = exitCode;
}

main();
