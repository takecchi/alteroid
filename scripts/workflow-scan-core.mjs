// `extractJobBlock` / `extractJobIf` / `extractPullRequestTypes` / `isInsideYamlComment` は共有しない: 要らない側まで共有すると、片方の都合で他方が壊れる依存を作るため。

import { readdirSync } from 'node:fs';

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
