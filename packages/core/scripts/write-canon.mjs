#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const docsDir = join(repoRoot, 'docs');
const outDir = resolve(here, '../src/generated');
const outFile = join(outDir, 'canon.ts');

// ディレクトリの列挙順に任せない: 並び順が優先順位（上が勝つ）という情報だから
const CANON = [
  {
    name: 'north_star',
    file: 'north_star.md',
    summary: '正典。プロダクトの全判断の基準。2つの禁止と、立ち戻るための問い',
  },
  { name: 'prd', file: 'PRD.md', summary: '正典から導出された要件' },
  { name: 'architecture', file: 'architecture.md', summary: '設計。プロセスモデルと境界' },
];

function titleOf(markdown, fallback) {
  for (const line of markdown.split('\n')) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) return match[1];
  }
  return fallback;
}

function revision() {
  const fromEnv = (process.env.ALTEROID_BUILD_REV ?? '').trim();
  if (fromEnv.length > 0) return { value: fromEnv, source: 'build' };
  try {
    const value = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      // 親を天井にする: `.git` が無いとき祖先の別 repo の HEAD を拾ってしまうため
      env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(repoRoot) },
    }).trim();
    return { value, source: 'workspace' };
  } catch {
    return { value: '', source: '' };
  }
}

function builtAt() {
  return new Date().toISOString();
}

const onDisk = (await readdir(docsDir)).filter((name) => name.endsWith('.md')).sort();
const listed = new Set(CANON.map((entry) => entry.file));
const missing = onDisk.filter((name) => !listed.has(name));
if (missing.length > 0) {
  throw new Error(
    `docs/ に一覧へ載っていない正典があります: ${missing.join(', ')}。` +
      'packages/core/scripts/write-canon.mjs の CANON に、優先順位の位置と一行説明を添えて足してください' +
      '（載せないとクローンだけがその文書を知らないまま走ります）。',
  );
}

const documents = [];
for (const entry of CANON) {
  const path = `docs/${entry.file}`;
  const content = await readFile(join(docsDir, entry.file), 'utf8');
  documents.push({
    name: entry.name,
    title: titleOf(content, entry.file),
    path,
    summary: entry.summary,
    content: content.trimEnd(),
  });
}

const rev = revision();
const builtAtValue = builtAt();

const banner = [
  '// 生成物 — 手で書き換えない（次のビルドで消える）。',
  '// 出所は docs/*.md（正典）。作るのは packages/core/scripts/write-canon.mjs。',
  '',
  '/** 正典の1文書。全文をそのまま持つ（要約すると docs と二重管理になる）。 */',
  'export interface CanonDocument {',
  '  /** `self_read` に渡す名前。 */',
  '  name: string;',
  '  /** 文書の見出し。 */',
  '  title: string;',
  '  /** リポジトリ内の位置。 */',
  '  path: string;',
  '  /** 一行の説明（何が書いてあるか）。 */',
  '  summary: string;',
  '  /** Markdown 全文。 */',
  '  content: string;',
  '}',
  '',
  '/** 優先順位の順（上が勝つ）。 */',
  `export const CANON_DOCUMENTS: CanonDocument[] = ${JSON.stringify(documents, null, 2)};`,
  '',
  '/** 焼き込んだ時点のリビジョン（フル sha）。分からなければ空文字。 */',
  `export const CANON_REVISION = ${JSON.stringify(rev.value)};`,
  '',
  "/** `CANON_REVISION` の出所（'build' / 'workspace' / ''）。実行時の解決は `packages/core/src/revision.ts` が持つ。 */",
  `export const CANON_REVISION_SOURCE = ${JSON.stringify(rev.source)};`,
  '',
  '/**',
  ' * このイメージが**焼かれた**時刻（ISO8601 UTC）。コミットの時刻でも本番へ出た',
  ' * 時刻でもない——詳しくは write-canon.mjs の `builtAt()` の doc。実行時の解決は',
  ' * `packages/core/src/revision.ts` の `resolveBuildTime` が持つ。',
  ' */',
  `export const CANON_BUILT_AT = ${JSON.stringify(builtAtValue)};`,
  '',
].join('\n');

await mkdir(outDir, { recursive: true });
await writeFile(outFile, banner, 'utf8');

process.stdout.write(
  `write-canon: ${documents.length} 件の正典を焼き込みました（${documents
    .map((doc) => doc.name)
    .join(', ')}）\n`,
);
