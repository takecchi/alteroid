#!/usr/bin/env node
/**
 * required contexts（`.github/required-status-checks.json`）が出るジョブを
 * 載せている workflow ファイルが、GitHub 上で `active` かを見る（Issue #1290）。
 *
 * **判定ロジックはここに置かない。** `check-required-gate-workflows-core.mjs` が
 * 正本で、なぜこれが `check:required-status-checks` とは別の道具なのか（権限の
 * 境界 —— こちらは `actions: read` だけで足り、あちらは administration 相当が
 * 要るので CI に配線できない）もあちらの doc に書いてある。
 *
 * ## この道具が言えること・言えないこと
 *
 * - **言えること**: 宣言（`.github/required-status-checks.json`）が指す
 *   context それぞれについて、対応する workflow ファイルが GitHub 上で
 *   `active` か。
 * - **言えないこと**: **宣言そのものが実際のブランチ保護と一致しているか。**
 *   それは `pnpm check:required-status-checks` の仕事——2本合わさって初めて
 *   「required の門は宣言どおり存在し、かつ生きている」まで言える。
 * - **書き換えない。** 読むだけである。
 *
 * ## 終了コード
 *
 * | verdict      | コード |
 * |--------------|--------|
 * | `ok`         | 0      |
 * | `disabled`   | 1      |
 * | `orphan`     | 1      |
 * | `unreadable` | 1      |
 *
 * **どれも「緑ではない」ことが要点なので終了コードは分けず、何が起きたかは
 * 必ず1行目で名乗る**（AGENTS.md「静かに失敗する道具」）。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
  evaluateRequiredGateWorkflows,
  formatResult,
} from './check-required-gate-workflows-core.mjs';
import { buildJobToWorkflowFiles } from './workflow-scan-core.mjs';

const ROOT = join(import.meta.dirname, '..');
const DECLARATION_PATH = join(ROOT, '.github', 'required-status-checks.json');
const WORKFLOWS_DIR = join(ROOT, '.github', 'workflows');
// `per_page=100` で足りる規模である（実測 2026-09-23: この repo の workflow は
// 10本）。既定の per_page（30）でも今は足りるが、将来増えても1ページで収まる
// 余裕を持たせてある。
const WORKFLOWS_API_PATH = 'repos/takecchi/alteroid/actions/workflows?per_page=100';

// `console` に頼らない理由は他の check スクリプトと同じ（`scripts/verify.mjs` に
// 揃えて `process.std{out,err}.write` を使う）。
function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

// GitHub API の `path` はリポジトリ根からの相対パス（`.github/workflows/ci.yml`）
// で返るが、`buildJobToWorkflowFiles`（`workflow-scan-core.mjs`）はディレクトリ
// を持たないファイル名（`ci.yml`）で扱っている（`ci-draft-gating.test.ts` の
// `ALL_WORKFLOW_JOBS` と同じ流儀）。**ここで揃えないと、実在する workflow が
// 全部「一覧に無い」＝ orphan に化ける** —— 実際に最初の実装がこれで踏んだ
// （手元での実行で `ci` / `image` / `no-attribution-trailers` の全件が誤って
// orphan と判定された。`.github/workflows/` 配下にサブディレクトリを持つ
// workflow はこの repo に無いので、単純な前方一致の除去で足りる）。
const WORKFLOWS_PATH_PREFIX = '.github/workflows/';

/**
 * `gh api repos/…/actions/workflows` を読み、各 workflow の `path`
 * （ファイル名だけに正規化したもの）と `state` を取り出す。読めなければ
 * `states: null` を返す。
 *
 * **例外を握り潰すが、握り潰した中身は捨てない** —— 読めなかった理由
 * （401 / 403 / ネットワーク）は次の一手を決める材料そのものである
 * （`check-required-status-checks.mjs` の `fetchProtection` と同じ作法）。
 */
function fetchWorkflowStates() {
  try {
    const stdout = execFileSync('gh', ['api', WORKFLOWS_API_PATH], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed.workflows)) {
      return { states: null, error: '応答に workflows 配列が無い' };
    }
    const states = parsed.workflows
      .map((w) => (w !== null && typeof w === 'object' ? { path: w.path, state: w.state } : null))
      .filter((w) => w !== null && typeof w.path === 'string' && typeof w.state === 'string')
      .map((w) => ({
        path: w.path.startsWith(WORKFLOWS_PATH_PREFIX)
          ? w.path.slice(WORKFLOWS_PATH_PREFIX.length)
          : w.path,
        state: w.state,
      }));
    return { states, error: null };
  } catch (error) {
    const detail =
      error !== null && typeof error === 'object' && 'stderr' in error && error.stderr
        ? String(error.stderr).trim()
        : String(error);
    return { states: null, error: detail };
  }
}

function main() {
  let declared;
  try {
    const raw = JSON.parse(readFileSync(DECLARATION_PATH, 'utf8'));
    if (!Array.isArray(raw.contexts) || raw.contexts.some((n) => typeof n !== 'string')) {
      logError(
        `check-required-gate-workflows: ${DECLARATION_PATH} の contexts が文字列の配列でない`,
      );
      process.exitCode = 1;
      return;
    }
    declared = raw.contexts;
  } catch (error) {
    logError(`check-required-gate-workflows: ${DECLARATION_PATH} を読めない: ${error}`);
    process.exitCode = 1;
    return;
  }

  let jobToWorkflowFiles;
  try {
    jobToWorkflowFiles = Object.fromEntries(buildJobToWorkflowFiles(WORKFLOWS_DIR));
  } catch (error) {
    logError(`check-required-gate-workflows: ${WORKFLOWS_DIR} を走査できない: ${error}`);
    process.exitCode = 1;
    return;
  }

  const { states, error } = fetchWorkflowStates();
  const result = evaluateRequiredGateWorkflows({
    declaredContexts: declared,
    jobToWorkflowFiles,
    workflowStates: states,
  });

  if (result.verdict === 'ok') {
    log(formatResult(result));
    return;
  }

  logError(formatResult(result));
  // **読めなかった理由は必ず添える。** 「読めなかった」だけだと、権限の問題なのか
  // ネットワークなのかが分からず、次の一手が決まらない。
  if (result.verdict === 'unreadable' && error !== null) {
    logError(`  gh の出力: ${error}`);
  }
  process.exitCode = 1;
}

main();
