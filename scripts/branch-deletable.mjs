#!/usr/bin/env node
// 使い方: pnpm branch:deletable -- <枝名> [<枝名> ...]
// `main` を fetch しない: 呼び出し前に `git fetch origin main` を済ませておく。
// `check:` で始まる名前にしない: check-scripts-wired が CI からの呼び出しを要求するが、この道具は枝を消すときに手で打つものだから。

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

function checkA(branchName) {
  const { stdout, error } = runCapture('git', ['grep', '-n', '-F', '--', branchName, MAIN_REV]);
  if (error !== null) {
    return { matches: [], errors: [`git grep が失敗した: ${error}`] };
  }
  return { matches: parseGitGrepMatches(stdout ?? '', MAIN_REV), errors: [] };
}

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
