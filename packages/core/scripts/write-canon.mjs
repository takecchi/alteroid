#!/usr/bin/env node
/**
 * 正典（`docs/*.md`）を core のビルド成果物へ焼き込む。
 *
 * **なぜ焼き込むのか。** クローンが自分自身を把握するための出所は正典だけである
 * （AGENTS.md「まず読む」）。ここで要約を手書きすると docs と二重管理になり、
 * 必ずずれる — ずれた瞬間、クローンは「自分について間違ったことを確信している」
 * 状態になる。だから写すのは要約ではなく**全文**であり、写す作業は人間ではなく
 * ビルドがやる。
 *
 * **なぜ実行時に `docs/` を読まないのか。** runtime イメージには `dist/` しか
 * 入らない（Dockerfile）。実行時読みにすると「コンテナだと自分のことが分からない」
 * が生まれる＝実質のデグレードである（north_star 禁止1）。
 *
 * 生成物は `src/generated/canon.ts`。**コミットしない** — 正典から機械的に落ちる
 * だけのものなので、ずれを検出できる場所は docs 側にしか無い
 * （`packages/api-client/src/generated/` と同じ扱い）。
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
// グローバルの `process` に頼らない（apps/daemon/scripts/write-openapi.mjs と同じ理由 —
// この形の素の Node スクリプトは lint の環境定義から外れている）。
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const docsDir = join(repoRoot, 'docs');
const outDir = resolve(here, '../src/generated');
const outFile = join(outDir, 'canon.ts');

/**
 * 正典の順序。**上が勝つ**（AGENTS.md「これらの文書とコードが矛盾したら、
 * バグなのはコードである（優先順位は番号順）」）。並び順そのものが情報なので、
 * ディレクトリの列挙順に任せない。
 */
const CANON = [
  {
    name: 'north_star',
    file: 'north_star.md',
    summary: '正典。プロダクトの全判断の基準。2つの禁止と、立ち戻るための問い',
  },
  { name: 'prd', file: 'PRD.md', summary: '正典から導出された要件' },
  { name: 'architecture', file: 'architecture.md', summary: '設計。プロセスモデルと境界' },
];

/** 先頭の `# ` 見出し。無ければファイル名で代用する。 */
function titleOf(markdown, fallback) {
  for (const line of markdown.split('\n')) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) return match[1];
  }
  return fallback;
}

/**
 * 焼き込んだ時点のリビジョンと、その出所。
 *
 * **分からないことを隠さない。** イメージのビルドでは `.git` が無いので
 * （`.dockerignore`）、`ALTEROID_BUILD_REV` を渡さない限り両方とも空になる。
 * 空のときクローンには「リビジョンは不明」と伝わり、コードの最新が要る場面で
 * リポジトリを見に行く判断ができる。ここで嘘の値を埋めると、その判断が狂う。
 *
 * **フル sha を返す。** 短縮 sha だけだと、依頼者が `gh api .../compare` で
 * 「main から何コミット遅れているか」を突き合わせる材料にならない。表示用の
 * 短縮は読む側（`packages/core/src/revision.ts` の `describeBuildRevision`）が
 * 別に作る。
 *
 * **出所も一緒に運ぶ。** `'build'` は `ALTEROID_BUILD_REV`（人間 / CI が明示的に
 * 渡した値）、`'workspace'` はビルド時の git 作業ツリーから拾った値、`''` は
 * どちらも取れなかったことを意味する。値だけでは「本当にこのイメージの中身の
 * sha か、単にビルド環境に置いてあった値か」が読む側から区別できない。
 */
function revision() {
  const fromEnv = (process.env.ALTEROID_BUILD_REV ?? '').trim();
  if (fromEnv.length > 0) return { value: fromEnv, source: 'build' };
  try {
    const value = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return { value, source: 'workspace' };
  } catch {
    return { value: '', source: '' };
  }
}

/**
 * **`docs/` に増えた正典を黙って落とさない。**
 *
 * 上の一覧は手書きである（順序と一行説明はファイルシステムに無い情報なので、
 * 自動では起こせない）。放っておくと5本目の正典を足した人は何の合図も受け取れず、
 * クローンだけがそれを知らないまま走る — 気づける場所がどこにも無いので、
 * ここで落とす。足す作業は1行で済む。
 */
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
  // 読めなければ**落とす**。黙って欠けた正典を配ると、クローンは「自分について
  // 知るべきことは全部知っている」つもりのまま一部を失う。
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
].join('\n');

await mkdir(outDir, { recursive: true });
await writeFile(outFile, banner, 'utf8');

process.stdout.write(
  `write-canon: ${documents.length} 件の正典を焼き込みました（${documents
    .map((doc) => doc.name)
    .join(', ')}）\n`,
);
