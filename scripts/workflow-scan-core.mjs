// `extractJobBlock` / `extractJobIf` / `extractPullRequestTypes` / `isInsideYamlComment` は共有しない: 要らない側まで共有すると、片方の都合で他方が壊れる依存を作るため。
// `buildJobToWorkflowFiles` は配列で返す: 同じジョブ名が2つの workflow に在る状態を例外で落とさず値として表し、呼び出し側に委ねるため。

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function listWorkflowFiles(workflowsDir) {
  return readdirSync(workflowsDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
}

export function extractJobsSection(workflowYamlText) {
  const marker = '\njobs:\n';
  const idx = workflowYamlText.indexOf(marker);
  if (idx === -1) throw new Error('workflow に "jobs:" セクションが見つからない');
  return workflowYamlText.slice(idx + marker.length);
}

export function extractJobNames(jobsSection) {
  return [...jobsSection.matchAll(/^ {2}([A-Za-z0-9_-]+):/gm)].map((m) => m[1]);
}

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
