/**
 * `.github/workflows/` 配下の workflow ファイルを走査し、ジョブ名から「そのジョブが
 * 定義されている workflow ファイル名」を引くための最小の部品。
 *
 * ## なぜ切り出したか
 *
 * `listWorkflowFiles` / `extractJobsSection` / `extractJobNames` の3つは、もともと
 * `scripts/ci-draft-gating.test.ts` が自分の中だけに持っていた（`ALL_WORKFLOW_JOBS`
 * を組み立てる下ごしらえ）。`scripts/check-required-gate-workflows.mjs`（Issue #1290）
 * も「required context 名 → それを出す workflow ファイル」を引く必要があり、同じ
 * 走査をもう1本書けば二重管理になる——片方だけ直して、もう片方を直し忘れる回が
 * 生まれる。だから**両方が要る最小の部分**だけをここへ出す。
 *
 * **意図して出していないもの**: `extractJobBlock` / `extractJobIf` /
 * `extractPullRequestTypes` / `isInsideYamlComment`。これらは
 * `ci-draft-gating.test.ts` が「draft のあいだ skip する条件」を測るために使う
 * もので、`check-required-gate-workflows` は `if:` も `pull_request.types` も
 * 見ない（見るのは workflow の GitHub 上の `state` だけ）。要らない側まで無理に
 * 共有すると、片方の都合で他方が壊れる依存を作ることになるので、ここには置かない。
 *
 * ## 重複ジョブ名の扱いを呼び出し側へ委ねる
 *
 * `buildJobToWorkflowFiles` は `Map<ジョブ名, 定義されている workflow ファイル名の配列>`
 * を返す。**配列にしてあるのは、同じジョブ名が2つの workflow に在る状態を例外で
 * 落とさず値として表すため**——`ci-draft-gating.test.ts` はその状態を「決められ
 * ないので fail-closed（例外を投げる）」で扱っているが、`check-required-gate-workflows`
 * は CI の1ジョブとして毎回落ちてよいものではなく、「決められない」を `orphan`
 * （対応が引けない）という判定の1つとして扱いたい。⟹ ここでは投げずに配列で返し、
 * 呼び出し側がそれぞれの流儀で決める。
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** `.github/workflows/` 配下の workflow ファイル名（`.yml` / `.yaml`）を昇順で返す。 */
export function listWorkflowFiles(workflowsDir) {
  return readdirSync(workflowsDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
}

/** `jobs:` セクションの生テキスト（`jobs:` 自身の行は含まない）を返す。 */
export function extractJobsSection(workflowYamlText) {
  const marker = '\njobs:\n';
  const idx = workflowYamlText.indexOf(marker);
  if (idx === -1) throw new Error('workflow に "jobs:" セクションが見つからない');
  return workflowYamlText.slice(idx + marker.length);
}

/** `jobs:` 直下のジョブ名（2-space インデントの見出し）を全部返す。 */
export function extractJobNames(jobsSection) {
  return [...jobsSection.matchAll(/^ {2}([A-Za-z0-9_-]+):/gm)].map((m) => m[1]);
}

/**
 * `.github/workflows/` 配下の全ファイルを走査し、ジョブ名 → 定義されている
 * workflow ファイル名の配列、を返す。同じジョブ名が複数ファイルに在れば、その
 * 配列は複数要素を持つ（＝曖昧である、という事実がそのまま値に残る）。
 */
export function buildJobToWorkflowFiles(workflowsDir) {
  const map = new Map();
  for (const file of listWorkflowFiles(workflowsDir)) {
    const text = readFileSync(path.join(workflowsDir, file), 'utf8');
    const section = extractJobsSection(text);
    for (const name of extractJobNames(section)) {
      const existing = map.get(name) ?? [];
      map.set(name, [...existing, file]);
    }
  }
  return map;
}
