import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../vitest.tmpdir.js';

import { gitChildEnv } from './git-child-env.js';
import {
  listGitScannableFiles,
  // @ts-expect-error -- 素の .mjs
} from './git-scannable-files-core.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export type ProseLine = { line: number; text: string };

export type FenceBlock = { open: number; close: number | null; lines: number };
export type FenceCoverage = {
  total: number;
  prose: number;
  dropped: number;
  ratio: number;
  blocks: FenceBlock[];
};

// ``` `...` ``` のようにバッククォートが続く行はフェンスの開きにしない: CommonMark はバッククォートのフェンスの info string にバッククォートを許さず、コードスパンになるため。
// 先頭空白に上限（3個など）を入れない: JSDoc の 4 個以上の字下げがフェンスの開きとして認識されなくなるため。
export function proseLinesWithFenceState(markdown: string): {
  lines: ProseLine[];
  unterminated: boolean;
  coverage: FenceCoverage;
  droppedLines: ProseLine[];
} {
  const out: ProseLine[] = [];
  const droppedLines: ProseLine[] = [];
  let inFence = false;
  let fenceChar: '`' | '~' | null = null;
  let fenceLen = 0;
  let blockOpen: number | null = null;
  const blocks: FenceBlock[] = [];
  const lines = markdown.split('\n');

  const prefixRe = /^\s*(?:\/\/+|\*)?\s*/;
  const openRe = /^(`{3,}|~{3,})(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? '';
    const prefixMatch = prefixRe.exec(text);
    const content = text.slice(prefixMatch ? prefixMatch[0].length : 0);

    if (!inFence) {
      const m = openRe.exec(content);
      if (!m) {
        out.push({ line: i + 1, text });
        continue;
      }
      const marker = m[1];
      const rest = m[2];
      if (marker === undefined || rest === undefined) {
        out.push({ line: i + 1, text });
        continue;
      }
      const markerChar = marker[0] as '`' | '~';
      if (markerChar === '`' && rest.includes('`')) {
        out.push({ line: i + 1, text });
        continue;
      }
      inFence = true;
      fenceChar = markerChar;
      fenceLen = marker.length;
      blockOpen = i + 1;
      continue;
    }

    if (fenceChar !== null && new RegExp(`^${fenceChar}{${fenceLen},}\\s*$`).test(content)) {
      inFence = false;
      fenceChar = null;
      fenceLen = 0;
      if (blockOpen !== null) {
        blocks.push({ open: blockOpen, close: i + 1, lines: i + 1 - blockOpen + 1 });
        blockOpen = null;
      }
    } else {
      droppedLines.push({ line: i + 1, text });
    }
  }

  if (inFence && blockOpen !== null) {
    blocks.push({ open: blockOpen, close: null, lines: lines.length - blockOpen + 1 });
  }

  const total = lines.length;
  const prose = out.length;
  // `total - prose` を使わない: `prose + dropped === total` の歯が別経路の一致を確かめるため。
  const dropped = blocks.reduce((sum, b) => sum + b.lines, 0);
  const ratio = total === 0 ? 0 : dropped / total;

  return {
    lines: out,
    unterminated: inFence,
    coverage: { total, prose, dropped, ratio, blocks },
    droppedLines,
  };
}

export function proseLines(markdown: string): ProseLine[] {
  return proseLinesWithFenceState(markdown).lines;
}

export interface FenceCoverageExemption {
  readonly file: string;
  readonly why: string;
}

export interface FenceCoverageLimits {
  readonly maxDroppedRatio: number;
  readonly minDroppedLines: number;
}

export type FenceCoverageViolation = {
  file: string;
  total: number;
  prose: number;
  dropped: number;
  ratio: number;
  blocks: FenceBlock[];
};

function exceedsFenceCoverageLimits(coverage: FenceCoverage, limits: FenceCoverageLimits): boolean {
  // 割合と行数の両方を超えたときだけ違反にする: 片方だけだと、正当な小さいファイルか大きいファイルのどちらかで誤爆するため。
  return coverage.ratio > limits.maxDroppedRatio && coverage.dropped >= limits.minDroppedLines;
}

export function findFenceCoverageViolations(
  entries: readonly { file: string; text: string }[],
  exemptions: readonly FenceCoverageExemption[],
  limits: FenceCoverageLimits,
): FenceCoverageViolation[] {
  const exemptFiles = new Set(exemptions.map((e) => e.file));
  const out: FenceCoverageViolation[] = [];
  for (const { file, text } of entries) {
    const { coverage } = proseLinesWithFenceState(text);
    if (!exceedsFenceCoverageLimits(coverage, limits)) continue;
    if (exemptFiles.has(file)) continue;
    out.push({
      file,
      total: coverage.total,
      prose: coverage.prose,
      dropped: coverage.dropped,
      ratio: coverage.ratio,
      blocks: coverage.blocks,
    });
  }
  return out;
}

export function findGhostFenceCoverageExemptions(
  entries: readonly { file: string; text: string }[],
  exemptions: readonly FenceCoverageExemption[],
  limits: FenceCoverageLimits,
): string[] {
  const violatingFiles = new Set<string>();
  for (const { file, text } of entries) {
    const { coverage } = proseLinesWithFenceState(text);
    if (exceedsFenceCoverageLimits(coverage, limits)) violatingFiles.add(file);
  }
  return exemptions.filter((e) => !violatingFiles.has(e.file)).map((e) => e.file);
}

const FENCE_COVERAGE_MAX_BLOCKS_SHOWN = 5;

export function formatFenceCoverageViolation(v: FenceCoverageViolation): string {
  const percent = (v.ratio * 100).toFixed(1);
  const sortedBlocks = [...v.blocks].sort((a, b) => b.lines - a.lines);
  const shown = sortedBlocks.slice(0, FENCE_COVERAGE_MAX_BLOCKS_SHOWN);
  const restCount = sortedBlocks.length - shown.length;
  const ranges = shown.map((b) => `${b.open}-${b.close === null ? '末尾' : b.close}`).join(', ');
  const rangesLine = restCount > 0 ? `${ranges}, 他 ${restCount} 件` : ranges;

  return [
    `${v.file}: 落とした行数 ${v.dropped}/${v.total} (${percent}%)。検査した行数 ${v.prose}。`,
    `落とした区間（長い順）: ${rangesLine}`,
    'この歯は「フェンスの中＝生の出力なので出典として数えない」として行を落とす。',
    'ここまで大きく落ちているときの原因は2つしか無い:',
    '(a) フェンスの対応がずれている（#786 の形）: コメントの中のインライン ``` が' +
      '「開き」と誤読され、そこから次のフェンス記号までが丸ごと無検査になる。' +
      '⟹ 落とした区間の開始行を開いて、その行が本当にコードブロックの開きかを見ること。',
    '(b) このファイルが正当に長い生の出力を持つ: ⟹ FENCE_COVERAGE_EXEMPTIONS へ理由つきで足すこと。',
    '⚠ (a) のとき、残った行が全部正しければ他の歯は全部緑のまま通る。この歯だけがそれを捕まえる。',
  ].join('\n');
}

export const FENCE_COVERAGE_MAX_DROPPED_RATIO = 0.4;

export const FENCE_COVERAGE_MIN_DROPPED_LINES = 40;

export const FENCE_COVERAGE_EXEMPTIONS: readonly FenceCoverageExemption[] = [
  {
    file: '.claude/skills/grep-counting/SKILL.md',
    why: 'AGENTS.md「grep が静かに取りこぼす形は6つある」を逐語で移設した先（2026-09-17）。6形のうち5形が shim / GNU grep / rg の出力を並べて見せる形なので、本文がフェンスで占められる。フェンス記号10本＝5対で対応は揃っており、落とした区間の開始行はすべて開きフェンスである（(a) の形ではない）。',
  },
];

export function proseLinesLegacyToggle(markdown: string): ProseLine[] {
  const out: ProseLine[] = [];
  let inFence = false;
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? '';
    if (/^\s*(?:\/\/+|\*)?\s*(```|~~~)/.test(text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    out.push({ line: i + 1, text });
  }
  return out;
}

export type FenceRuleDivergence = {
  file: string;
  current: number;
  legacy: number;
};

export function findFenceRuleDivergences(
  entries: readonly { file: string; text: string }[],
): FenceRuleDivergence[] {
  const out: FenceRuleDivergence[] = [];
  for (const { file, text } of entries) {
    const current = proseLinesWithFenceState(text).lines.length;
    const legacy = proseLinesLegacyToggle(text).length;
    if (current !== legacy) {
      out.push({ file, current, legacy });
    }
  }
  return out;
}

export interface FenceRuleDivergenceFile {
  readonly file: string;
  readonly why: string;
}

export const FENCE_RULE_DIVERGENCE_FILES: readonly FenceRuleDivergenceFile[] = [
  {
    file: 'scripts/agents-md-references.test.ts',
    why: '#786 の欠陥そのものを再現する合成 fixture と、フェンス記号を含む doc を持つ唯一のファイル。旧実装ではここだけが 933 行中 704 行（75.46%）を無検査にしていた（2026-09-12 実測、main = 77e6088）。',
  },
];

export type LineNumberCitation = { line: number; token: string; target: string };

export function findLineNumberCitations(
  lines: readonly ProseLine[],
  isRepoFile: (candidate: string) => boolean,
): LineNumberCitation[] {
  const out: LineNumberCitation[] = [];
  const pattern = /([A-Za-z0-9_@.][A-Za-z0-9_./@-]*):(\d+)(?:-(\d+))?/g;
  for (const { line, text } of lines) {
    for (const m of text.matchAll(pattern)) {
      const target = m[1] ?? '';
      if (!isRepoFile(target)) continue;
      out.push({ line, token: m[0], target });
    }
  }
  return out;
}

export function collectWidenedLineNumberCitations(
  entries: readonly { file: string; text: string }[],
  isRepoFileLike: (candidate: string) => boolean,
  skipped: readonly { file: string; token: string }[],
): string[] {
  const out: string[] = [];
  for (const { file, text } of entries) {
    const lines = proseLines(text);
    for (const c of findLineNumberCitations(lines, isRepoFileLike)) {
      const isSkipped = skipped.some((s) => s.file === file && s.token === c.token);
      if (isSkipped) continue;
      out.push(`${file}:${c.line} ${c.token}`);
    }
  }
  return out;
}

export function collectFencedLineNumberCitations(
  entries: readonly { file: string; text: string }[],
  isRepoFileLike: (candidate: string) => boolean,
  skipped: readonly { file: string; token: string }[],
): string[] {
  const out: string[] = [];
  for (const { file, text } of entries) {
    const { droppedLines } = proseLinesWithFenceState(text);
    for (const c of findLineNumberCitations(droppedLines, isRepoFileLike)) {
      const isSkipped = skipped.some((s) => s.file === file && s.token === c.token);
      if (isSkipped) continue;
      out.push(`${file}:${c.line} ${c.token}`);
    }
  }
  return out;
}

export interface FencedLineNumberCitationExemption {
  readonly file: string;
  readonly token: string;
  readonly why: string;
}

export const FENCED_LINE_NUMBER_CITATION_EXEMPTIONS: readonly FencedLineNumberCitationExemption[] =
  [];

export type RowNumberCitation = { line: number; token: string };

export function findRowNumberCitations(lines: readonly ProseLine[]): RowNumberCitation[] {
  const out: RowNumberCitation[] = [];
  const pattern = /\d+\s*行目/g;
  for (const { line, text } of lines) {
    for (const m of text.matchAll(pattern)) {
      out.push({ line, token: m[0] });
    }
  }
  return out;
}

export type VerbatimCitation = { line: number; pattern: string; target: string };
export type LegacyVerbatimCitation = {
  line: number;
  pattern: string;
  target: string;
  form: string;
};

// 出典の逐語は、打ったときのシェルと同じ文字列で比べる: 逃がしたバックスラッシュの分だけ必ず 0 件になるため。
export function unescapeShellDoubleQuoted(text: string): string {
  return text.replace(/\\([\\`"$])/g, '$1');
}

function findAllGrepStyleCitations(
  lines: readonly ProseLine[],
): Array<{ line: number; hasF: boolean; hasDashDash: boolean; pattern: string; target: string }> {
  const out: Array<{
    line: number;
    hasF: boolean;
    hasDashDash: boolean;
    pattern: string;
    target: string;
  }> = [];
  const pattern = /`\s*grep -(F)?n(\s+--)?\s+(['"])(.+?)\3\s+([^\s`]+)\s*`/g;
  for (const { line, text } of lines) {
    for (const m of text.matchAll(pattern)) {
      out.push({
        line,
        hasF: m[1] === 'F',
        hasDashDash: m[2] !== undefined,
        pattern: m[3] === '"' ? unescapeShellDoubleQuoted(m[4] ?? '') : (m[4] ?? ''),
        target: m[5] ?? '',
      });
    }
  }
  return out;
}

export function findVerbatimCitations(lines: readonly ProseLine[]): VerbatimCitation[] {
  return findAllGrepStyleCitations(lines)
    .filter((c) => c.hasF && c.hasDashDash)
    .map((c) => ({ line: c.line, pattern: c.pattern, target: c.target }));
}

export function findLegacyVerbatimCitations(lines: readonly ProseLine[]): LegacyVerbatimCitation[] {
  return findAllGrepStyleCitations(lines)
    .filter((c) => !(c.hasF && c.hasDashDash))
    .map((c) => ({
      line: c.line,
      pattern: c.pattern,
      target: c.target,
      form: `grep -${c.hasF ? 'F' : ''}n${c.hasDashDash ? ' --' : ''}`,
    }));
}

export function findMissingVerbatimCitations(
  citations: readonly VerbatimCitation[],
  isRepoFile: (candidate: string) => boolean,
  readTarget: (target: string) => string,
): VerbatimCitation[] {
  return citations.filter((c) => {
    if (!isRepoFile(c.target)) return false;
    return !readTarget(c.target)
      .split('\n')
      .some((l) => l.includes(c.pattern));
  });
}

function isRepoFile(candidate: string): boolean {
  if (candidate.includes('..')) return false;
  try {
    return statSync(path.join(ROOT, candidate)).isFile();
  } catch {
    return false;
  }
}

function readRepoFile(target: string): string {
  return readFileSync(path.join(ROOT, target), 'utf8');
}

export function isWidenedScopeFile(relativePath: string): boolean {
  if (relativePath === '.claude' || relativePath.startsWith('.claude/')) return true;
  if (relativePath.startsWith('apps/web/app/')) return true;
  if (relativePath.startsWith('scripts/')) return true;
  return /(^|\/)src\//.test(relativePath);
}

export const CITATION_SCOPE_SELF_FILE = 'scripts/agents-md-references.test.ts';

export function excludeCitationScopeSelf(files: readonly string[]): string[] {
  return files.filter((f) => f !== CITATION_SCOPE_SELF_FILE);
}

export function listScannableFiles(root: string = ROOT): string[] {
  return listGitScannableFiles({ cwd: root }) as string[];
}

describe('listScannableFiles は未追跡ファイルも対象に入れる（#1817）', () => {
  async function makeRepoWithUntrackedFile(): Promise<string> {
    const dir = await makeTempDir('agents-md-references-1817-');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitChildEnv() });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    await writeFile(path.join(dir, 'tracked.ts'), 'export const ok = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    await writeFile(path.join(dir, 'new-untracked.ts'), '// see clone.ts:505 for the fence rule\n');
    return dir;
  }

  it('🔴（直す前の形）: 素の `git ls-files -z` は新規ファイルを見落とす', async () => {
    const dir = await makeRepoWithUntrackedFile();
    const oldForm = execFileSync('git', ['ls-files', '-z'], {
      cwd: dir,
      encoding: 'utf8',
      env: gitChildEnv(),
    })
      .split('\0')
      .filter((p) => p.length > 0);
    expect(oldForm).not.toContain('new-untracked.ts');
  });

  it('🟢（直した後）: listScannableFiles は同じ新規ファイルを対象に入れる', async () => {
    const dir = await makeRepoWithUntrackedFile();
    const files = listScannableFiles(dir);
    expect(files).toContain('new-untracked.ts');
    expect(files).toContain('tracked.ts');
  });
});

// basename が複数のファイルに一致しても曖昧さは解決しない: 答えるのは「リポジトリのどこかのファイルを指すか」だけで、「どのファイルか」ではないため。
export function buildBasenameAwareRepoFileResolver(
  repoRelativePaths: readonly string[],
): (candidate: string) => boolean {
  const exact = new Set(repoRelativePaths);
  const basenames = new Set(repoRelativePaths.map((p) => path.posix.basename(p)));
  return (candidate: string): boolean => {
    if (candidate.includes('..')) return false;
    if (exact.has(candidate)) return true;
    if (candidate.includes('/')) return false;
    return basenames.has(candidate);
  };
}

export interface WidenedLineNumberCitationExemption {
  readonly file: string;
  readonly token: string;
  readonly why: string;
}

export const WIDENED_LINE_NUMBER_CITATION_EXEMPTIONS: readonly WidenedLineNumberCitationExemption[] =
  [
    {
      file: '.claude/agents-md-records/repo-conventions.md',
      token: 'schema.ts:500-503',
      why:
        '出典ではなく証拠。AGENTS.md「リポジトリの約束」の実例(2026-08-23) が、この文書が' +
        'かつて `schema.ts:500-503`（現物は packages/core/src/schema.ts）という出典を書いて' +
        '行番号が腐った、という過去の実測を逐語で引用している箇所。#1192 の再編（PR2）で ' +
        'AGENTS.md からこのファイルへ逐語のまま移した。書き換えると証拠そのものが消える。',
    },
  ];

export interface CapturedOutputNonCitation {
  readonly file: string;
  readonly token: string;
  readonly why: string;
}

// `WIDENED_LINE_NUMBER_CITATION_EXEMPTIONS` へ載せない: 載せると「規約の対象だが例外を1つ作った」という別の意味になるため。
export const CAPTURED_OUTPUT_NON_CITATIONS: readonly CapturedOutputNonCitation[] = [
  {
    file: 'scripts/mutate-unhandled-errors.test.ts',
    token: 'scripts/check-tracked-nul-bytes.test.ts:43',
    why: '過去に test-guard が吐いた stdout の逐語コピー（`REAL_GUARD_B_SKIP`）の中の1行。指した先が動いてもこの文字列を直す必要は無い ⟹ 腐らない。',
  },
  {
    file: 'scripts/branch-deletable.test.ts',
    token: 'packages/core/src/archive-prune.ts:159',
    why: '`git grep -n -F` が実際に返した生出力（2026-09-22 観測）の逐語コピー。`parseGitGrepMatches` がこの形を崩さず分解できるかを固定するための fixture であって出典ではない ⟹ 指した先の行が動いても直す必要は無い。',
  },
  {
    file: 'scripts/branch-deletable.test.ts',
    token: 'scripts/test-guard-core.mjs:372',
    why: '同上（`git grep` の生出力の逐語コピー、複数行を1つのfixtureで確かめる回の1行）。',
  },
  {
    file: 'scripts/branch-deletable.test.ts',
    token: '.claude/skills/branch-cleanup/SKILL.md:67',
    why: '同上（`git grep` の生出力の逐語コピー、複数行を1つのfixtureで確かめる回のもう1行）。',
  },
];

export interface AgentsMdLineNumberCitationExemption {
  readonly token: string;
  readonly why: string;
}

export const AGENTS_MD_LINE_NUMBER_CITATION_EXEMPTIONS: readonly AgentsMdLineNumberCitationExemption[] =
  [];

const SCANNABLE_FILES = listScannableFiles();
const WIDENED_SCOPE_FILES = excludeCitationScopeSelf(SCANNABLE_FILES.filter(isWidenedScopeFile));
const isRepoFileOrBasename = buildBasenameAwareRepoFileResolver(SCANNABLE_FILES);

const agentsMd = readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
const prose = proseLines(agentsMd);

const repoConventionsRecord = readFileSync(
  path.join(ROOT, '.claude/agents-md-records/repo-conventions.md'),
  'utf8',
);
const repoConventionsRecordProse = proseLines(repoConventionsRecord);

const FENCE_COVERAGE_SELF_FILE = 'scripts/agents-md-references.test.ts';

const FENCE_COVERAGE_ENTRIES: readonly { file: string; text: string }[] = [
  { file: 'AGENTS.md', text: agentsMd },
  ...WIDENED_SCOPE_FILES.map((file) => ({ file, text: readRepoFile(file) })),
  { file: FENCE_COVERAGE_SELF_FILE, text: readRepoFile(FENCE_COVERAGE_SELF_FILE) },
];
const FENCE_COVERAGE_LIMITS: FenceCoverageLimits = {
  maxDroppedRatio: FENCE_COVERAGE_MAX_DROPPED_RATIO,
  minDroppedLines: FENCE_COVERAGE_MIN_DROPPED_LINES,
};

const FENCED_LINE_NUMBER_CITATION_ENTRIES: readonly { file: string; text: string }[] = [
  { file: 'AGENTS.md', text: agentsMd },
  ...WIDENED_SCOPE_FILES.map((file) => ({ file, text: readRepoFile(file) })),
];

describe('AGENTS.md の参照の形（#369）', () => {
  it('本文がフェンスの中身を含まない（この歯が何を見ているかの確認）', () => {
    const tqText = readRepoFile('.claude/skills/tool-quirks/SKILL.md');
    const tqProse = proseLines(tqText);
    expect(tqText).toContain('Cannot change the base branch of a closed pull request');
    expect(tqProse.map((l) => l.text).join('\n')).not.toContain(
      'Cannot change the base branch of a closed pull request',
    );
    expect(prose.length).toBeGreaterThan(100);
  });

  it('フェンスが最後まで閉じている（#786: 判定がずれた無検査を緑にしない）', () => {
    expect(proseLinesWithFenceState(agentsMd).unterminated).toBe(false);
  });

  it('リポジトリ内のファイルを `path:行番号`（裸のファイル名を含む）で指さない（#784）', () => {
    const hits = collectWidenedLineNumberCitations(
      [{ file: 'AGENTS.md', text: agentsMd }],
      isRepoFileOrBasename,
      AGENTS_MD_LINE_NUMBER_CITATION_EXEMPTIONS.map((e) => ({ file: 'AGENTS.md', token: e.token })),
    );
    expect(
      hits,
      '行番号は腐り、腐ったことが読む側から分からない（開いた人には「そこに無い」としか見えず、' +
        "移動したのか消えたのかが区別できない）。逐語（`grep -Fn -- '<逐語>' <path>`）かシンボル名で指すこと。" +
        '直せない理由（出典ではなく証拠）があるなら AGENTS_MD_LINE_NUMBER_CITATION_EXEMPTIONS へ理由つきで足すこと。',
    ).toEqual([]);
  });

  it('AGENTS_MD_LINE_NUMBER_CITATION_EXEMPTIONS の why が全部、非空である（#784）', () => {
    const blank = AGENTS_MD_LINE_NUMBER_CITATION_EXEMPTIONS.filter(
      (e) => e.why.trim().length === 0,
    ).map((e) => e.token);
    expect(
      blank,
      '免除の理由が空である。なぜ規約の対象から外すのかを書くこと（空欄を許すと免除表は数合わせの場所になる）。',
    ).toEqual([]);
  });

  it('AGENTS_MD_LINE_NUMBER_CITATION_EXEMPTIONS に載っている token が、いまも実際に検出される現物と一致する（幽霊免除が無い。#784）', () => {
    const stillDetected = new Set(
      findLineNumberCitations(prose, isRepoFileOrBasename).map((c) => c.token),
    );
    const ghosts = AGENTS_MD_LINE_NUMBER_CITATION_EXEMPTIONS.filter(
      (e) => !stillDetected.has(e.token),
    ).map((e) => e.token);
    expect(
      ghosts,
      '免除表に載っている token が、もう検出されない（直った/消えた）。免除表からこの行を消すこと。',
    ).toEqual([]);
  });

  it('現状: isRepoFileOrBasename は裸のファイル名（schema.ts:500-503、#1192 の再編で移った先の記録ファイル）を検出する（#784・#1192）', () => {
    const found = findLineNumberCitations(repoConventionsRecordProse, isRepoFileOrBasename);
    expect(found.some((c) => c.token === 'schema.ts:500-503')).toBe(true);
    const notFoundByPlainIsRepoFile = findLineNumberCitations(
      repoConventionsRecordProse,
      isRepoFile,
    );
    expect(notFoundByPlainIsRepoFile.some((c) => c.token === 'schema.ts:500-503')).toBe(false);
  });

  it('直上のテストが前提にしている行が、いま現物の記録ファイルに実在する（#784・#1192）', () => {
    expect(
      repoConventionsRecord.split('\n').filter((l) => l.includes('schema.ts:500-503')).length,
    ).toBe(1);
  });

  it('「N行目」で指さない', () => {
    const found = findRowNumberCitations(prose);
    expect(
      found.map((c) => `AGENTS.md:${c.line} ${c.token}`),
      '直上と同じ理由。行番号を日本語で書いても腐り方は変わらない。',
    ).toEqual([]);
  });

  it('`grep -Fn --` で書かれた出典が現物に当たる', () => {
    const citations = findVerbatimCitations(prose);
    const missing = findMissingVerbatimCitations(citations, isRepoFile, readRepoFile);
    expect(
      missing.map((c) => `AGENTS.md:${c.line} grep -Fn -- '${c.pattern}' ${c.target} が0件`),
      [
        'AGENTS.md が引いている逐語が、指したファイルに無い。',
        '⚠️ これは「行が動いた」では落ちない（この歯は行番号を一切見ていない）。',
        '落ちたということは、指された文言そのものが書き換えられたか消えたかである。',
        '(a) 文言を直したのなら、AGENTS.md 側の逐語もいまの文言へ直す（またはシンボル名へ変える）',
        '(b) 指していたものが消えたのなら、AGENTS.md の参照ごと畳む',
      ].join('\n'),
    ).toEqual([]);
  });

  it('旧形式（`grep -n` など、`-F` か `--` が無い）で書かれた出典が無い（#408）', () => {
    const legacy = findLegacyVerbatimCitations(prose);
    expect(
      legacy.map((c) => `AGENTS.md:${c.line} ${c.form} '${c.pattern}' ${c.target}`),
      [
        "出典は `grep -Fn -- '<逐語>' <path>` の形で書くこと（#408）。",
        '`grep -n`（`-F` 無し）は逐語のメタ文字を正規表現として解釈し、0件・誤爆を作る。',
        '`--` が無いと、逐語が `-` から始まったときに道具ごと違う形で壊れる' +
          '（固まる／exit 1 無出力／別ファイルの偽陽性。詳細は AGENTS.md 該当箇所）。',
      ].join('\n'),
    ).toEqual([]);
  });
});

// 「N行目」の規則を `.claude/**` へ広げない: コードの「N行目」は出典ではなく処理しているデータの行を指す語彙で、全件が偽陽性になるため。
describe('.claude/** と */src/** と apps/web/app/** と scripts/** の path:行番号 出典（PR #760 / #785）', () => {
  it('免除表の理由（why）が全部、非空である', () => {
    const blank = WIDENED_LINE_NUMBER_CITATION_EXEMPTIONS.filter(
      (e) => e.why.trim().length === 0,
    ).map((e) => `${e.file} ${e.token}`);
    expect(
      blank,
      '免除の理由が空である。なぜ広げた歯の対象から外すのかを書くこと' +
        '（空欄を許すと、免除表は数合わせの場所になる）。',
    ).toEqual([]);
  });

  it('`CAPTURED_OUTPUT_NON_CITATIONS` の why が全部、非空である', () => {
    const blank = CAPTURED_OUTPUT_NON_CITATIONS.filter((e) => e.why.trim().length === 0).map(
      (e) => `${e.file} ${e.token}`,
    );
    expect(
      blank,
      '「なぜ規約の対象外なのか」が空である。空欄を許すと、ここも数合わせの' + '場所になる。',
    ).toEqual([]);
  });

  it('免除表に載っている項目が、いまも実際に検出される現物と一致する（幽霊免除が無い）', () => {
    const stillDetected = new Set<string>();
    for (const file of WIDENED_SCOPE_FILES) {
      const text = readRepoFile(file);
      const lines = proseLines(text);
      for (const c of findLineNumberCitations(lines, isRepoFileOrBasename)) {
        stillDetected.add(`${file} ${c.token}`);
      }
    }
    const ghosts = WIDENED_LINE_NUMBER_CITATION_EXEMPTIONS.filter(
      (e) => !stillDetected.has(`${e.file} ${e.token}`),
    ).map((e) => `${e.file} ${e.token}`);
    expect(
      ghosts,
      '免除表に載っている file:token が、もう検出されない（直った/消えた）。' +
        '免除表からこの行を消すこと——直った後も免除に残すと、次に本当に必要な' +
        '免除が増えたときに見分けが付かなくなる。',
    ).toEqual([]);
  });

  it('`CAPTURED_OUTPUT_NON_CITATIONS` に載っている file+token が、いまも実際に検出される現物と一致する（幽霊が無い）', () => {
    const stillDetected = new Set<string>();
    for (const file of WIDENED_SCOPE_FILES) {
      const text = readRepoFile(file);
      const lines = proseLines(text);
      for (const c of findLineNumberCitations(lines, isRepoFileOrBasename)) {
        stillDetected.add(`${file} ${c.token}`);
      }
    }
    const ghosts = CAPTURED_OUTPUT_NON_CITATIONS.filter(
      (e) => !stillDetected.has(`${e.file} ${e.token}`),
    ).map((e) => `${e.file} ${e.token}`);
    expect(
      ghosts,
      '`CAPTURED_OUTPUT_NON_CITATIONS` に載っている file:token が、もう検出されない' +
        '（直った/消えた）。この行を表から消すこと。',
    ).toEqual([]);
  });

  it('リポジトリ内のファイルを `path:行番号`（裸のファイル名を含む）で指さない', () => {
    const entries = WIDENED_SCOPE_FILES.map((file) => ({ file, text: readRepoFile(file) }));
    const skipped = [
      ...WIDENED_LINE_NUMBER_CITATION_EXEMPTIONS.map((e) => ({ file: e.file, token: e.token })),
      ...CAPTURED_OUTPUT_NON_CITATIONS.map((e) => ({ file: e.file, token: e.token })),
    ];
    const hits = collectWidenedLineNumberCitations(entries, isRepoFileOrBasename, skipped);
    expect(
      hits,
      '行番号は腐り、腐ったことが読む側から分からない（AGENTS.md「他のファイルを' +
        '出典として指すときは、行番号を単独の出典にしない」）。逐語' +
        "（`grep -Fn -- '<逐語>' <path>`）かシンボル名で指すこと。" +
        '直せない理由があるなら WIDENED_LINE_NUMBER_CITATION_EXEMPTIONS へ理由つきで足すこと' +
        '（scripts/agents-md-references.test.ts）。過去に道具が吐いた出力の逐語コピーで' +
        '腐らないものなら CAPTURED_OUTPUT_NON_CITATIONS へ（免除表とは別枠）。',
    ).toEqual([]);
  });

  it('広げた対象範囲でフェンスが最後まで閉じている（#786）', () => {
    const unterminated: string[] = [];
    for (const file of WIDENED_SCOPE_FILES) {
      const text = readRepoFile(file);
      if (proseLinesWithFenceState(text).unterminated) unterminated.push(file);
    }
    expect(
      unterminated,
      '末尾に達してもフェンスが閉じていない。これ以降の行が丸ごと' +
        '「フェンスの中」として無検査になっている——フェンス記号の対応' +
        '（開いた文字・長さと同じもので閉じる）を直すこと。',
    ).toEqual([]);
  });
});

const WIDENED_VERBATIM_CITATION_EXEMPTIONS: ReadonlyArray<{
  file: string;
  pattern: string;
  why: string;
}> = [];

function isVerbatimCitationExempted(file: string, pattern: string): boolean {
  return WIDENED_VERBATIM_CITATION_EXEMPTIONS.some((e) => e.file === file && e.pattern === pattern);
}

describe('広げた対象範囲の grep -Fn -- 出典（issue #1450）', () => {
  const widened = WIDENED_SCOPE_FILES.map((file) => ({
    file,
    lines: proseLines(readRepoFile(file)),
  }));

  it('`grep -Fn --` で書かれた出典が現物に当たる', () => {
    const missing: string[] = [];
    for (const { file, lines } of widened) {
      const citations = findVerbatimCitations(lines).filter(
        (c) => !isVerbatimCitationExempted(file, c.pattern),
      );
      for (const c of findMissingVerbatimCitations(citations, isRepoFile, readRepoFile)) {
        missing.push(`${file}:${c.line} grep -Fn -- '${c.pattern}' ${c.target} が0件`);
      }
    }
    expect(
      missing,
      [
        'コードの注釈が引いている逐語が、指したファイルに無い。',
        '⚠️ これは「行が動いた」では落ちない（この歯は行番号を一切見ていない）。',
        '指された文言そのものが書き換えられたか消えたかである。',
        '(a) 文言を直したのなら、出典の逐語もいまの文言へ直す（またはシンボル名へ変える）',
        '(b) 指していたものが消えたのなら、出典ごと畳む',
        '(c) 出典ではなく門の合成入力なら、WIDENED_VERBATIM_CITATION_EXEMPTIONS へ理由つきで足す',
      ].join('\n'),
    ).toEqual([]);
  });

  it('旧形式（`grep -n` など、`-F` か `--` が無い）で書かれた出典が無い', () => {
    const legacy: string[] = [];
    for (const { file, lines } of widened) {
      for (const c of findLegacyVerbatimCitations(lines)) {
        legacy.push(`${file}:${c.line} ${c.form} '${c.pattern}' ${c.target}`);
      }
    }
    expect(legacy, "出典は `grep -Fn -- '<逐語>' <path>` の形で書くこと（#408）。").toEqual([]);
  });

  it('リポジトリの根から解決できない裸のファイル名で指さない', () => {
    const bare: string[] = [];
    for (const { file, lines } of widened) {
      for (const c of findVerbatimCitations(lines)) {
        if (/^[\w.-]+\.(ts|tsx|mjs|js|md|json|ya?ml)$/.test(c.target) && !isRepoFile(c.target)) {
          bare.push(`${file}:${c.line} ${c.target}`);
        }
      }
    }
    expect(bare, 'リポジトリの根からのパスで書くこと。').toEqual([]);
  });

  it('WIDENED_VERBATIM_CITATION_EXEMPTIONS の why が全部、非空である', () => {
    expect(WIDENED_VERBATIM_CITATION_EXEMPTIONS.filter((e) => e.why.trim() === '')).toEqual([]);
  });

  it('WIDENED_VERBATIM_CITATION_EXEMPTIONS に載っている組が、いまも実際に検出される（幽霊免除が無い）', () => {
    const detected = new Set(
      widened.flatMap(({ file, lines }) =>
        findVerbatimCitations(lines).map((c) => `${file}\0${c.pattern}`),
      ),
    );
    expect(
      WIDENED_VERBATIM_CITATION_EXEMPTIONS.filter(
        (e) => !detected.has(`${e.file}\0${e.pattern}`),
      ).map((e) => `${e.file} '${e.pattern}'`),
    ).toEqual([]);
  });

  it('対象範囲の出典が実際に拾われている（抽出が壊れて0件のまま緑にならない）', () => {
    const total = widened.reduce((sum, { lines }) => sum + findVerbatimCitations(lines).length, 0);
    // 数を守る門ではなく抽出が壊れていないかの確認なので、コメント整理の後の見込み（92 件）の半分にする
    expect(total).toBeGreaterThan(45);
  });
});

describe('unescapeShellDoubleQuoted（issue #1450）', () => {
  it('バッククォート・二重引用符・ドル記号・バックスラッシュの前のバックスラッシュだけを落とす', () => {
    expect(unescapeShellDoubleQuoted('\\`a\\` \\"b\\" \\$c \\\\d \\n')).toBe('`a` "b" $c \\d \\n');
  });

  it('二重引用符で書かれた出典にだけ効き、一重引用符の出典には効かない', () => {
    const lines = [
      { line: 1, text: 'x `grep -Fn -- "a \\`b\\`" a.ts`' },
      { line: 2, text: "x `grep -Fn -- 'a \\$b' a.ts`" },
    ];
    const got = findVerbatimCitations(lines);
    expect(got.find((c) => c.line === 1)?.pattern).toBe('a `b`');
    expect(got.find((c) => c.line === 2)?.pattern).toBe('a \\$b');
  });
});

describe('フェンスの中として落とした行の path:行番号（#891）', () => {
  it('免除表の理由（why）が全部、非空である', () => {
    const blank = FENCED_LINE_NUMBER_CITATION_EXEMPTIONS.filter(
      (e) => e.why.trim().length === 0,
    ).map((e) => `${e.file} ${e.token}`);
    expect(
      blank,
      '免除の理由が空である。なぜ直せないのかを書くこと（空欄を許すと、免除表は' +
        '数合わせの場所になる）。',
    ).toEqual([]);
  });

  it('免除表に載っている項目が、いまも実際に検出される現物と一致する（幽霊免除が無い）', () => {
    const stillDetected = new Set<string>();
    for (const { file, text } of FENCED_LINE_NUMBER_CITATION_ENTRIES) {
      const { droppedLines } = proseLinesWithFenceState(text);
      for (const c of findLineNumberCitations(droppedLines, isRepoFileOrBasename)) {
        stillDetected.add(`${file} ${c.token}`);
      }
    }
    const ghosts = FENCED_LINE_NUMBER_CITATION_EXEMPTIONS.filter(
      (e) => !stillDetected.has(`${e.file} ${e.token}`),
    ).map((e) => `${e.file} ${e.token}`);
    expect(
      ghosts,
      '免除表に載っている file:token が、もう検出されない（直った/消えた）。' +
        '免除表からこの行を消すこと。',
    ).toEqual([]);
  });

  it('フェンスの中（落とした行）に、この歯が拾う形の path:行番号 が無い（#891）', () => {
    const skipped = FENCED_LINE_NUMBER_CITATION_EXEMPTIONS.map((e) => ({
      file: e.file,
      token: e.token,
    }));
    const hits = collectFencedLineNumberCitations(
      FENCED_LINE_NUMBER_CITATION_ENTRIES,
      isRepoFileOrBasename,
      skipped,
    );
    expect(
      hits,
      [
        'フェンスの中（生の出力として落とした行）に、この歯が拾う形の `path:行番号` が見つかった。',
        '⚠ これは規約違反ではない——フェンスの中身は引き続き「出典として数えない」（赤くしない）。',
        'この赤の意味は「いま誰も見ていない場所（フェンスの中）に、findLineNumberCitations が拾う形のものが入った」であり、原因は次のどちらかである:',
        '(a) フェンス判定がずれている（開き/閉じの対応が本来の意図と違う）。落ちた行の開始位置を実際に確認すること。',
        '(b) 本当に生の出力（スタックトレース・実測コマンドの結果）を貼っていて、たまたま実在ファイルへ解決する path:行番号 の形になっている。',
        '次の一手: (a) ならフェンスの対応を直す。(b) なら現物修正を優先する——',
        '  doc の例示を架空パスへ倒す／フェンスで正しく囲み直す／path:行番号 が地の文に連続して現れない形へ言い換える',
        '  （scripts/check-pr-line-number-citations-core.mjs がこの PR で実際に採った直し方）。',
        '直せない理由が本当にあるなら FENCED_LINE_NUMBER_CITATION_EXEMPTIONS へ理由つきで足すこと' +
          '（scripts/agents-md-references.test.ts）。ただし免除は最後の手段——現物修正が優先である。',
      ].join('\n'),
    ).toEqual([]);
  });
});

describe('proseLinesWithFenceState の droppedLines（落とした行の中身を取り出す口。#891）', () => {
  it('フェンスの中の行を、開き・閉じのマーカー行を除いて返す', () => {
    const fixture = [
      'prose before',
      '```',
      'dropped line 1',
      'dropped line 2',
      '```',
      'prose after',
    ].join('\n');
    const { droppedLines } = proseLinesWithFenceState(fixture);
    expect(droppedLines).toEqual([
      { line: 3, text: 'dropped line 1' },
      { line: 4, text: 'dropped line 2' },
    ]);
  });

  it('unterminated（閉じていない）フェンスでも、開いた次の行から末尾まで droppedLines に入る', () => {
    const fixture = ['prose', '```', 'still dropped 1', 'still dropped 2'].join('\n');
    const { droppedLines, unterminated } = proseLinesWithFenceState(fixture);
    expect(unterminated).toBe(true);
    expect(droppedLines).toEqual([
      { line: 3, text: 'still dropped 1' },
      { line: 4, text: 'still dropped 2' },
    ]);
  });

  it('フェンスを持たない入力は droppedLines が空である', () => {
    const { droppedLines } = proseLinesWithFenceState('a\nb\nc');
    expect(droppedLines).toEqual([]);
  });

  it('複数のフェンス区間があれば、両方の中身を集める', () => {
    const fixture = [
      '```',
      'block A line 1',
      '```',
      'prose between',
      '~~~',
      'block B line 1',
      '~~~',
    ].join('\n');
    const { droppedLines } = proseLinesWithFenceState(fixture);
    expect(droppedLines).toEqual([
      { line: 2, text: 'block A line 1' },
      { line: 6, text: 'block B line 1' },
    ]);
  });
});

describe('collectFencedLineNumberCitations（合成 fixture。#891）', () => {
  it('フェンスの中に実在ファイルへ解決する path:行番号 があれば拾う', () => {
    // テンプレートリテラルで組み立てる: 地の文に `path:行番号` を連続して書くと、この歯自身が誤検出するため。
    const file = 'packages/core/src/clone.ts';
    const entries = [
      {
        file: 'some-doc.md',
        text: ['本文。', '```', `${file}:505 が原因だった`, '```'].join('\n'),
      },
    ];
    const resolve = buildBasenameAwareRepoFileResolver([file]);
    expect(collectFencedLineNumberCitations(entries, resolve, [])).toEqual([
      `some-doc.md:3 ${file}:505`,
    ]);
  });

  it('フェンスの外に在る同じ形は拾わない（collectWidenedLineNumberCitations の役目であって、ここの役目ではない）', () => {
    const file = 'packages/core/src/clone.ts';
    const entries = [{ file: 'some-doc.md', text: `${file}:505 が原因だった` }];
    const resolve = buildBasenameAwareRepoFileResolver([file]);
    expect(collectFencedLineNumberCitations(entries, resolve, [])).toEqual([]);
  });

  it('実在しないファイルは拾わない（架空パスは #891 の対象外）', () => {
    const entries = [
      {
        file: 'some-doc.md',
        text: ['```', 'scripts/example.mjs:42 が原因だった', '```'].join('\n'),
      },
    ];
    const resolve = buildBasenameAwareRepoFileResolver(['packages/core/src/clone.ts']);
    expect(collectFencedLineNumberCitations(entries, resolve, [])).toEqual([]);
  });

  it('免除表に載せた file+token は落ちる。載せなければ落ちない（免除が「そもそも拾えていない」のではないことの確認）', () => {
    const file = 'packages/core/src/clone.ts';
    const entries = [{ file: 'some-doc.md', text: ['```', `${file}:505`, '```'].join('\n') }];
    const resolve = buildBasenameAwareRepoFileResolver([file]);
    expect(
      collectFencedLineNumberCitations(entries, resolve, [
        { file: 'some-doc.md', token: `${file}:505` },
      ]),
    ).toEqual([]);
    expect(collectFencedLineNumberCitations(entries, resolve, [])).toEqual([
      `some-doc.md:2 ${file}:505`,
    ]);
  });

  it('「N行目」はフェンスの中でも拾わない（findRowNumberCitations を意図して使っていないことの確認）', () => {
    const entries = [
      { file: 'some-doc.md', text: ['```', 'この中の 42行目 は見ない。', '```'].join('\n') },
    ];
    const resolve = buildBasenameAwareRepoFileResolver([]);
    expect(collectFencedLineNumberCitations(entries, resolve, [])).toEqual([]);
  });

  it('`grep -Fn --` の正しい形（findVerbatimCitations が拾う形）はフェンスの中でも拾わない', () => {
    const file = 'packages/core/src/clone.ts';
    const entries = [
      {
        file: 'some-doc.md',
        text: ['```', `grep -Fn -- 'ここに在る文言' ${file}`, '```'].join('\n'),
      },
    ];
    const resolve = buildBasenameAwareRepoFileResolver([file]);
    expect(collectFencedLineNumberCitations(entries, resolve, [])).toEqual([]);
  });
});

describe('フェンス被覆（#786 残り）', () => {
  it('被覆の違反が0件である', () => {
    const violations = findFenceCoverageViolations(
      FENCE_COVERAGE_ENTRIES,
      FENCE_COVERAGE_EXEMPTIONS,
      FENCE_COVERAGE_LIMITS,
    );
    expect(violations.map(formatFenceCoverageViolation)).toEqual([]);
  });

  it('幽霊免除が0件である', () => {
    const ghosts = findGhostFenceCoverageExemptions(
      FENCE_COVERAGE_ENTRIES,
      FENCE_COVERAGE_EXEMPTIONS,
      FENCE_COVERAGE_LIMITS,
    );
    expect(
      ghosts,
      '免除表に載っている file が、もう閾値を超えていない（直った/消えた）。' +
        '免除表からこの行を消すこと。',
    ).toEqual([]);
  });

  it('免除表の理由（why）が全部、非空である', () => {
    const blank = FENCE_COVERAGE_EXEMPTIONS.filter((e) => e.why.trim().length === 0).map(
      (e) => e.file,
    );
    expect(blank, '免除の理由が空である。正当に長い生の出力である理由を書くこと。').toEqual([]);
  });

  it('`prose + dropped === total` が対象の全ファイルで成り立つ（勘定が壊れていないことの確認）', () => {
    const broken: string[] = [];
    for (const { file, text } of FENCE_COVERAGE_ENTRIES) {
      const { coverage } = proseLinesWithFenceState(text);
      if (coverage.prose + coverage.dropped !== coverage.total) {
        broken.push(
          `${file}: prose=${coverage.prose} dropped=${coverage.dropped} total=${coverage.total}`,
        );
      }
    }
    expect(
      broken,
      '検査した行数と落とした行数の合計が総行数と一致しない。' +
        '`proseLinesWithFenceState` の勘定が壊れている。',
    ).toEqual([]);
  });
});

describe('findFenceCoverageViolations / formatFenceCoverageViolation（合成 fixture。#786）', () => {
  it('割合と行数の両方が閾値を超える ⟹ 違反1件', () => {
    const fenceBody = Array.from({ length: 50 }, (_, i) => `dropped line ${i}`);
    const text = ['prose 1', '```', ...fenceBody, '```', 'prose 2'].join('\n');
    const violations = findFenceCoverageViolations(
      [{ file: 'fixture/both-exceeded.md', text }],
      [],
      FENCE_COVERAGE_LIMITS,
    );
    expect(violations).toEqual([
      {
        file: 'fixture/both-exceeded.md',
        total: 54,
        prose: 2,
        dropped: 52,
        ratio: 52 / 54,
        blocks: [{ open: 2, close: 53, lines: 52 }],
      },
    ]);
  });

  it('割合は超えるが行数が足りない小さいファイル ⟹ 違反0件（正当な小さいファイルで誤爆しない）', () => {
    const text = [
      'prose 1',
      '```',
      'a',
      'b',
      'c',
      'd',
      '```',
      'prose 2',
      'prose 3',
      'prose 4',
    ].join('\n');
    const violations = findFenceCoverageViolations(
      [{ file: 'fixture/small.md', text }],
      [],
      FENCE_COVERAGE_LIMITS,
    );
    expect(violations).toEqual([]);
  });

  it('行数は超えるが割合が足りない大きいファイル ⟹ 違反0件（AGENTS.md と同じ形）', () => {
    const fenceBody = Array.from({ length: 43 }, (_, i) => `dropped line ${i}`);
    const proseBefore = Array.from({ length: 80 }, (_, i) => `prose before ${i}`);
    const proseAfter = Array.from({ length: 75 }, (_, i) => `prose after ${i}`);
    const text = [...proseBefore, '```', ...fenceBody, '```', ...proseAfter].join('\n');
    const violations = findFenceCoverageViolations(
      [{ file: 'fixture/large.md', text }],
      [],
      FENCE_COVERAGE_LIMITS,
    );
    expect(violations).toEqual([]);
  });

  it('正当な最大（AGENTS.md 実測 18.54%: dropped=117/total=631）は違反0件 ⟹ 閾値を下げすぎると赤くなる', () => {
    const fenceBody = Array.from({ length: 115 }, (_, i) => `dropped line ${i}`);
    const proseBefore = Array.from({ length: 257 }, (_, i) => `prose before ${i}`);
    const proseAfter = Array.from({ length: 257 }, (_, i) => `prose after ${i}`);
    const text = [...proseBefore, '```', ...fenceBody, '```', ...proseAfter].join('\n');
    const { coverage } = proseLinesWithFenceState(text);
    expect(coverage).toMatchObject({ total: 631, prose: 514, dropped: 117 });
    expect(coverage.ratio).toBeCloseTo(0.1854, 4);

    const violations = findFenceCoverageViolations(
      [{ file: 'fixture/legit-max.md', text }],
      [],
      FENCE_COVERAGE_LIMITS,
    );
    expect(violations).toEqual([]);
  });

  it('欠陥の署名（旧実装での歯自身のファイルの実測 75.46%: dropped=704/total=933）は違反1件 ⟹ 閾値を上げすぎると赤くなる', () => {
    const fenceBody = Array.from({ length: 702 }, (_, i) => `dropped line ${i}`);
    const proseBefore = Array.from({ length: 115 }, (_, i) => `prose before ${i}`);
    const proseAfter = Array.from({ length: 114 }, (_, i) => `prose after ${i}`);
    const text = [...proseBefore, '```', ...fenceBody, '```', ...proseAfter].join('\n');
    const { coverage } = proseLinesWithFenceState(text);
    expect(coverage).toMatchObject({ total: 933, prose: 229, dropped: 704 });
    expect(coverage.ratio).toBeCloseTo(0.7546, 4);

    const violations = findFenceCoverageViolations(
      [{ file: 'fixture/defect-signature.md', text }],
      [],
      FENCE_COVERAGE_LIMITS,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('fixture/defect-signature.md');
  });

  it('免除表に載せた違反は違反にならない。免除したのに閾値を超えていないものは幽霊免除として拾われる', () => {
    const fenceBody = Array.from({ length: 50 }, (_, i) => `dropped line ${i}`);
    const violatingText = ['prose 1', '```', ...fenceBody, '```', 'prose 2'].join('\n');
    const cleanText = ['prose 1', 'prose 2', 'prose 3'].join('\n');
    const entries = [
      { file: 'fixture/violating.md', text: violatingText },
      { file: 'fixture/already-fixed.md', text: cleanText },
    ];
    const exemptions: FenceCoverageExemption[] = [
      {
        file: 'fixture/violating.md',
        why: '正当に長いスタックトレースの実測を含む（合成fixture）',
      },
      { file: 'fixture/already-fixed.md', why: '合成fixture: もう閾値を超えていない想定' },
    ];

    expect(findFenceCoverageViolations(entries, exemptions, FENCE_COVERAGE_LIMITS)).toEqual([]);
    expect(findGhostFenceCoverageExemptions(entries, exemptions, FENCE_COVERAGE_LIMITS)).toEqual([
      'fixture/already-fixed.md',
    ]);
  });

  it('#786 の形（1行に開閉が両方在る行の後ろに長い本文が続く）で coverage.dropped が増えない（被覆が縮まない）', () => {
    const tail = Array.from({ length: 100 }, (_, i) => `prose line ${i}`);
    const text = [' * ```code``` の続き', ...tail].join('\n');
    const { coverage } = proseLinesWithFenceState(text);
    expect(coverage.total).toBe(101);
    expect(coverage.prose).toBe(101);
    expect(coverage.dropped).toBe(0);
    expect(coverage.blocks).toEqual([]);
  });

  it('formatFenceCoverageViolation の出力: 落とした区間・原因の説明・警告の一文を含む（⛔ 数字だけの赤にしない）', () => {
    const violation: FenceCoverageViolation = {
      file: 'fixture/report-sample.md',
      total: 800,
      prose: 80,
      dropped: 720,
      ratio: 0.9,
      blocks: [
        { open: 700, close: null, lines: 60 },
        { open: 500, close: 550, lines: 51 },
        { open: 100, close: 140, lines: 41 },
        { open: 200, close: 230, lines: 31 },
        { open: 300, close: 320, lines: 21 },
        { open: 400, close: 411, lines: 12 },
        { open: 600, close: 605, lines: 6 },
      ],
    };
    const formatted = formatFenceCoverageViolation(violation);

    expect(formatted).toContain('fixture/report-sample.md');
    expect(formatted).toContain('720/800');
    expect(formatted).toContain('90.0%');
    expect(formatted).toContain('80');

    expect(formatted).toContain('700-末尾');
    expect(formatted).toContain('500-550');
    expect(formatted).toContain('100-140');
    expect(formatted).toContain('200-230');
    expect(formatted).toContain('300-320');
    expect(formatted).not.toContain('400-411');
    expect(formatted).not.toContain('600-605');
    expect(formatted).toContain('他 2 件');

    expect(formatted).toContain('フェンスの対応がずれている');
    expect(formatted).toContain('インライン');
    expect(formatted).toContain('正当に長い生の出力');
    expect(formatted).toContain('FENCE_COVERAGE_EXEMPTIONS');

    expect(formatted).toContain('他の歯は全部緑のまま通る');
    expect(formatted).toContain('この歯だけがそれを捕まえる');
  });

  it('coverage.blocks が期待どおり（開き行・閉じ行・長さ。unterminated のとき close === null）', () => {
    const closed = proseLinesWithFenceState(
      [
        ' * ```code``` の続き',
        '```',
        'real fence content (must stay hidden)',
        '```',
        'after the real fence, this line is prose again',
      ].join('\n'),
    );
    expect(closed.coverage.blocks).toEqual([{ open: 2, close: 4, lines: 3 }]);

    const unterminated = proseLinesWithFenceState(
      ['prose before', '```', 'hidden, the fence never closes'].join('\n'),
    );
    expect(unterminated.coverage.blocks).toEqual([{ open: 2, close: null, lines: 2 }]);
    expect(unterminated.unterminated).toBe(true);
  });
});

describe('findFenceRuleDivergences（実在 corpus。SCANNABLE_FILES 全体。#786 残り）', () => {
  it('FENCE_RULE_DIVERGENCE_FILES の why が全部、非空である', () => {
    const blank = FENCE_RULE_DIVERGENCE_FILES.filter((f) => f.why.trim().length === 0).map(
      (f) => f.file,
    );
    expect(
      blank,
      '理由が空である。なぜこのファイルだけが #786 の回帰の署名を出せる場所なのかを書くこと。',
    ).toEqual([]);
  });

  it('食い違うファイルの集合が FENCE_RULE_DIVERGENCE_FILES と完全一致する（増えても減っても赤）', () => {
    const entries = SCANNABLE_FILES.map((file) => ({ file, text: readRepoFile(file) }));
    expect(entries.length).toBeGreaterThan(400);

    const divergences = findFenceRuleDivergences(entries);
    const divergentFiles = new Map(divergences.map((d) => [d.file, d]));
    const expectedFiles = new Set(FENCE_RULE_DIVERGENCE_FILES.map((f) => f.file));

    const added = [...divergentFiles.values()]
      .filter((d) => !expectedFiles.has(d.file))
      .map((d) => `${d.file} 現行${d.current}行/旧実装${d.legacy}行`);
    const removed = FENCE_RULE_DIVERGENCE_FILES.map((f) => f.file).filter(
      (file) => !divergentFiles.has(file),
    );

    expect(
      { added, removed },
      [
        '旧実装（1行トグル、#796 より前）と現実装とで検査した行数が食い違うファイルの',
        '集合が、FENCE_RULE_DIVERGENCE_FILES と一致しなくなった。',
        '',
        '増えた場合（added、`パス 現行N行/旧実装N行` の形）: このファイルにも #786 の形',
        '（コメント内のインライン ``` など）が新しく書かれた ⟹ 被覆の歯が名指しで測る',
        '対象（FENCE_COVERAGE_SELF_FILE）を見直すこと。⟹ FENCE_RULE_DIVERGENCE_FILES へ',
        '理由つきで足すこと。',
        '',
        '消えた場合（removed、パスのみ）: 前提（署名を出せる場所は1本だけ）が実際に',
        '変わったか、もしくは数え方そのものが壊れた ⟹ ⛔ 表からこの行を消す前に、',
        'どちらなのかを確かめること（0件になっても赤くする——「食い違いが無くなった」と',
        '「数え方が壊れた」を同じ顔にしないため）。',
      ].join('\n'),
    ).toEqual({ added: [], removed: [] });
  });
});

describe('findFenceRuleDivergences / proseLinesLegacyToggle（合成 fixture。#786）', () => {
  it('当たるべきところで当たる: #786 の形（1行に開閉が両方在る行の後ろに本文が続く）は current > legacy で1件検出する', () => {
    const tail = Array.from({ length: 20 }, (_, i) => `prose line ${i}`);
    const text = [' * ```code``` の続き', ...tail].join('\n');
    const divergences = findFenceRuleDivergences([{ file: 'fixture/defect.md', text }]);
    expect(divergences).toHaveLength(1);
    expect(divergences[0]?.file).toBe('fixture/defect.md');
    expect(divergences[0] && divergences[0].current > divergences[0].legacy).toBe(true);
  });

  it('当たってはいけないところで当たらない: 開き行と閉じ行が別々に在る普通のフェンスは食い違わない（0件）', () => {
    const text = ['prose 1', '```', 'fenced content', '```', 'prose 2'].join('\n');
    expect(findFenceRuleDivergences([{ file: 'fixture/normal-fence.md', text }])).toEqual([]);
  });

  it('当たってはいけないところで当たらない: フェンスを1つも持たない入力は食い違わない（0件）', () => {
    const text = ['prose 1', 'prose 2', 'prose 3'].join('\n');
    expect(findFenceRuleDivergences([{ file: 'fixture/no-fence.md', text }])).toEqual([]);
  });

  it('proseLinesLegacyToggle 自身が旧実装のとおりに壊れている（1行に開閉が両方在る行でトグルし、後ろを落とす）', () => {
    const tail = Array.from({ length: 5 }, (_, i) => `prose line ${i}`);
    const text = [' * ```code``` の続き', ...tail].join('\n');
    expect(proseLinesLegacyToggle(text)).toEqual([]);
  });
});

describe('proseLines のフェンス判定（#786 の欠陥そのものを再現する合成 fixture）', () => {
  it('A: 1行に開閉が両方在る行（JSDoc の `* ` 接頭辞つき。歯自身の実例と同じ形）はトグルせずプローズのまま', () => {
    const fixture = [
      ' * ```code``` の続き',
      '```',
      'real fence content (must stay hidden)',
      '```',
      'after the real fence, this line is prose again',
    ].join('\n');
    const { lines, unterminated } = proseLinesWithFenceState(fixture);
    expect(lines.map((l) => l.line)).toEqual([1, 5]);
    expect(lines.map((l) => l.text)).not.toContain('real fence content (must stay hidden)');
    expect(unterminated).toBe(false);
  });

  it('B: `~~~` と ``` の混在は閉じない（開いた文字でしか閉じられない）', () => {
    const fixture = [
      '~~~',
      'hidden line 1',
      '```',
      'still hidden: a different fence character does not close ~~~',
      '~~~',
      'now closed, prose again',
    ].join('\n');
    const { lines, unterminated } = proseLinesWithFenceState(fixture);
    expect(lines.map((l) => l.line)).toEqual([6]);
    expect(unterminated).toBe(false);
  });

  it('C: フェンス長の不一致は閉じない（閉じは開いた長さ以上が必要）', () => {
    const fixture = [
      '````',
      'hidden inside a 4-backtick fence',
      '```',
      'still hidden: 3 backticks cannot close a 4-backtick fence',
      '````',
      'now closed by a matching (>=4) length, prose again',
    ].join('\n');
    const { lines, unterminated } = proseLinesWithFenceState(fixture);
    expect(lines.map((l) => l.line)).toEqual([6]);
    expect(unterminated).toBe(false);
  });

  it('D: 末尾まで閉じられていないフェンスは unterminated: true を返す', () => {
    const fixture = ['prose before', '```', 'hidden, the fence never closes'].join('\n');
    const { lines, unterminated } = proseLinesWithFenceState(fixture);
    expect(lines.map((l) => l.line)).toEqual([1]);
    expect(unterminated).toBe(true);
  });
});

describe('参照を拾う側そのもの（歯が空振りしていないことの確認）', () => {
  const fixture = [
    'その境界は `packages/core/src/schema.ts:500-503` に在る。',
    '`apps/web/app/test-support.tsx` の106行目を含む。',
    "逐語は `grep -Fn -- 'ここに在る文言' packages/core/src/schema.ts` で当たる。",
    '```',
    'at Worker.<anonymous> (…/tsup/dist/index.js:1545:26)',
    'この中の 42行目 は見ない。',
    '```',
    '時刻は 2026-08-22T09:35 で、`06:27` に出た。',
    'リポジトリ外は `tsup/dist/index.js:1703` のように書いてよい。',
  ].join('\n');
  const fixtureProse = proseLines(fixture);
  const fixtureIsRepoFile = (c: string) =>
    c === 'packages/core/src/schema.ts' || c === 'apps/web/app/test-support.tsx';

  it('フェンスの中は本文から落ちる', () => {
    expect(fixtureProse.map((l) => l.text)).not.toContain(
      'at Worker.<anonymous> (…/tsup/dist/index.js:1545:26)',
    );
    expect(fixtureProse.map((l) => l.line)).toEqual([1, 2, 3, 8, 9]);
  });

  it('リポジトリ内のファイルの `path:行番号` だけを拾う（時刻とリポジトリ外は拾わない）', () => {
    expect(findLineNumberCitations(fixtureProse, fixtureIsRepoFile)).toEqual([
      {
        line: 1,
        token: 'packages/core/src/schema.ts:500-503',
        target: 'packages/core/src/schema.ts',
      },
    ]);
  });

  it('「N行目」を拾う（フェンスの中のものは拾わない）', () => {
    expect(findRowNumberCitations(fixtureProse)).toEqual([{ line: 2, token: '106行目' }]);
  });

  it('`grep -Fn --` の出典から逐語とパスを取り出す', () => {
    expect(findVerbatimCitations(fixtureProse)).toEqual([
      { line: 3, pattern: 'ここに在る文言', target: 'packages/core/src/schema.ts' },
    ]);
  });

  it('旧形式（`grep -n`）は findVerbatimCitations に拾われず、findLegacyVerbatimCitations に拾われる（#408）', () => {
    const oldForm = proseLines(
      "逐語は `grep -n 'ここに在る文言' packages/core/src/schema.ts` で当たる。",
    );
    expect(findVerbatimCitations(oldForm)).toEqual([]);
    expect(findLegacyVerbatimCitations(oldForm)).toEqual([
      {
        line: 1,
        pattern: 'ここに在る文言',
        target: 'packages/core/src/schema.ts',
        form: 'grep -n',
      },
    ]);
  });

  it('`-F` は在るが `--` が無い形も、旧形式として拾われる（#408）', () => {
    const partialForm = proseLines(
      "逐語は `grep -Fn 'ここに在る文言' packages/core/src/schema.ts` で当たる。",
    );
    expect(findVerbatimCitations(partialForm)).toEqual([]);
    expect(findLegacyVerbatimCitations(partialForm)).toEqual([
      {
        line: 1,
        pattern: 'ここに在る文言',
        target: 'packages/core/src/schema.ts',
        form: 'grep -Fn',
      },
    ]);
  });

  it('正しい形（`grep -Fn --`）は findLegacyVerbatimCitations に拾われない', () => {
    expect(findLegacyVerbatimCitations(fixtureProse)).toEqual([]);
  });
});

describe('出典が現物に当たるかの判定そのもの（陰性 fixture。#408）', () => {
  const readTarget = (target: string): string => {
    if (target === 'positive.txt') return 'alpha\n * prefix needle-is-here suffix text\nomega\n';
    if (target === 'negative.txt') return 'alpha\nomega\n';
    throw new Error(`unexpected fixture target: ${target}`);
  };
  const fixtureIsRepoFile = (c: string): boolean => c === 'positive.txt' || c === 'negative.txt';

  it('逐語が対象ファイルに在れば missing に入らない', () => {
    const citations: VerbatimCitation[] = [
      { line: 1, pattern: 'needle-is-here', target: 'positive.txt' },
    ];
    expect(findMissingVerbatimCitations(citations, fixtureIsRepoFile, readTarget)).toEqual([]);
  });

  it('逐語が対象ファイルに無ければ missing に入る（陰性 fixture）', () => {
    const citations: VerbatimCitation[] = [
      { line: 1, pattern: 'needle-is-here', target: 'negative.txt' },
    ];
    expect(findMissingVerbatimCitations(citations, fixtureIsRepoFile, readTarget)).toEqual([
      { line: 1, pattern: 'needle-is-here', target: 'negative.txt' },
    ]);
  });

  it('リポジトリ外の target は見ない（在っても無くても missing に入らない）', () => {
    const citations: VerbatimCitation[] = [
      { line: 1, pattern: 'needle-is-here', target: 'outside-the-repo.txt' },
    ];
    expect(
      findMissingVerbatimCitations(citations, fixtureIsRepoFile, () => {
        throw new Error('リポジトリ外は isRepoFile で弾かれ、readTarget まで来ないはず');
      }),
    ).toEqual([]);
  });
});

describe('isWidenedScopeFile（歯の対象範囲そのもの。合成 fixture）', () => {
  it('.claude/** に入る', () => {
    expect(isWidenedScopeFile('.claude/skills/x/SKILL.md')).toBe(true);
    expect(isWidenedScopeFile('.claude')).toBe(true);
  });

  it('2階層下の src/** にも入る（PR #760 の再現コマンドが実際に当てていた形）', () => {
    expect(isWidenedScopeFile('apps/daemon/src/index.ts')).toBe(true);
    expect(isWidenedScopeFile('packages/core/src/clone.ts')).toBe(true);
  });

  it('apps/web/app/** に入る（src を持たない唯一のワークスペース。この PR で足した）', () => {
    expect(isWidenedScopeFile('apps/web/app/routes/chat.tsx')).toBe(true);
    expect(isWidenedScopeFile('apps/web/app/components/page.tsx')).toBe(true);
  });

  it('AGENTS.md・docs/ は入らない', () => {
    expect(isWidenedScopeFile('AGENTS.md')).toBe(false);
    expect(isWidenedScopeFile('docs/north_star.md')).toBe(false);
  });

  it('scripts/** は入る（#785。歯自身は isWidenedScopeFile ではなく excludeCitationScopeSelf が名前1つで除く）', () => {
    expect(isWidenedScopeFile('scripts/check-tracked-nul-bytes.test.ts')).toBe(true);
    expect(isWidenedScopeFile('scripts/agents-md-references.test.ts')).toBe(true);
  });

  it('apps/web でも app/ の外（設定ファイル）は入らない', () => {
    expect(isWidenedScopeFile('apps/web/package.json')).toBe(false);
    expect(isWidenedScopeFile('apps/web/vite.config.ts')).toBe(false);
    expect(isWidenedScopeFile('apps/webhooks/app/x.ts')).toBe(false);
  });

  it('パスの一部に "src" を含む語（srcじゃない）では誤爆しない', () => {
    expect(isWidenedScopeFile('packages/core/srcs/foo.ts')).toBe(false);
    expect(isWidenedScopeFile('packages/resrc/foo.ts')).toBe(false);
  });
});

describe('buildBasenameAwareRepoFileResolver（この PR の本体。合成 fixture）', () => {
  const repoFiles = [
    'packages/core/src/clone.ts',
    'apps/daemon/src/index.ts',
    'apps/runner/src/index.ts',
  ];
  const resolve = buildBasenameAwareRepoFileResolver(repoFiles);

  it('リポジトリ相対の完全一致を解決する（従来どおり）', () => {
    expect(resolve('packages/core/src/clone.ts')).toBe(true);
  });

  it('裸のファイル名（basename）も解決する——これが無いと #760 前の83%を取りこぼす', () => {
    expect(resolve('clone.ts')).toBe(true);
  });

  it('複数ファイルに一致する basename も解決する（曖昧さは解決しない仕様）', () => {
    expect(resolve('index.ts')).toBe(true);
  });

  it('リポジトリに存在しない裸のファイル名は解決しない', () => {
    expect(resolve('does-not-exist.ts')).toBe(false);
  });

  it('"/" を含むが完全一致しない候補は解決しない（部分パスの当て推量はしない）', () => {
    expect(resolve('core/src/clone.ts')).toBe(false);
  });

  it('".." を含む候補は解決しない', () => {
    expect(resolve('../clone.ts')).toBe(false);
  });
});

describe('広げた歯の end-to-end（合成 fixture。裸のファイル名の形が実際に鳴ることの確認）', () => {
  const repoFiles = ['packages/core/src/clone.ts', 'apps/daemon/src/index.ts'];
  const resolve = buildBasenameAwareRepoFileResolver(repoFiles);

  it('裸のファイル名の出典（`clone.ts:505`）を findLineNumberCitations が拾う', () => {
    const lines = proseLines('参照は `clone.ts:505` に在る。');
    expect(findLineNumberCitations(lines, resolve)).toEqual([
      { line: 1, token: 'clone.ts:505', target: 'clone.ts' },
    ]);
  });

  it('リポジトリ相対の出典（`apps/daemon/src/index.ts:1049-1050`）も引き続き拾う', () => {
    const lines = proseLines('参照は `apps/daemon/src/index.ts:1049-1050` に在る。');
    expect(findLineNumberCitations(lines, resolve)).toEqual([
      {
        line: 1,
        token: 'apps/daemon/src/index.ts:1049-1050',
        target: 'apps/daemon/src/index.ts',
      },
    ]);
  });

  it('時刻・版番号・リポジトリ外は拾わない（basename 解決を足しても誤検出が増えない）', () => {
    const lines = proseLines(
      [
        '時刻は 2026-08-22T09:35 で、`06:27` に出た。',
        'バージョンは `typescript-eslint:8.67.0` ではない。',
        'リポジトリ外は `tsup/dist/index.js:1703` のように書いてよい。',
      ].join('\n'),
    );
    expect(findLineNumberCitations(lines, resolve)).toEqual([]);
  });

  it('コメント記号つきのフェンス（`// \\`\\`\\` `）の中は見ない', () => {
    const lines = proseLines(
      ['// ```', '// clone.ts:505 のような実測はここでは書き換えない', '// ```'].join('\n'),
    );
    expect(findLineNumberCitations(lines, resolve)).toEqual([]);
  });
});

describe('excludeCitationScopeSelf / collectWidenedLineNumberCitations（合成 fixture。#785）', () => {
  it('除外が効く: CITATION_SCOPE_SELF_FILE だけを落とし、他は落とさない', () => {
    const files = [
      'scripts/check-tracked-nul-bytes.test.ts',
      CITATION_SCOPE_SELF_FILE,
      'scripts/mutate-unhandled-errors.test.ts',
    ];
    expect(excludeCitationScopeSelf(files)).toEqual([
      'scripts/check-tracked-nul-bytes.test.ts',
      'scripts/mutate-unhandled-errors.test.ts',
    ]);
  });

  it('除外が効きすぎていない（対の歯）: excludeCitationScopeSelf を通しても、SELF 以外の複数ファイルはどれも落ちない', () => {
    // collectWidenedLineNumberCitations だけに entries を渡さず excludeCitationScopeSelf を経由させる: 除外を広げる変異に反応しなくなるため。
    const files = [
      'scripts/other-file-a.test.ts',
      CITATION_SCOPE_SELF_FILE,
      'scripts/other-file-b.test.ts',
    ];
    const textByFile: Record<string, string> = {
      'scripts/other-file-a.test.ts': '参照は `clone.ts:505` に在る。',
      [CITATION_SCOPE_SELF_FILE]: '参照は `clone.ts:505` に在る（この歯自身の入力）。',
      'scripts/other-file-b.test.ts': '参照は `apps/daemon/src/index.ts:1049-1050` に在る。',
    };
    const resolve = buildBasenameAwareRepoFileResolver([
      'packages/core/src/clone.ts',
      'apps/daemon/src/index.ts',
    ]);
    const scoped = excludeCitationScopeSelf(files);
    const entries = scoped.map((file) => ({ file, text: textByFile[file] ?? '' }));
    expect(collectWidenedLineNumberCitations(entries, resolve, [])).toEqual([
      'scripts/other-file-a.test.ts:1 clone.ts:505',
      'scripts/other-file-b.test.ts:1 apps/daemon/src/index.ts:1049-1050',
    ]);
  });

  it('自己参照が実際に外れる: CITATION_SCOPE_SELF_FILE と同じ名前のファイルが持つ出典は、excludeCitationScopeSelf を通した後は検出されない', () => {
    const files = ['scripts/other-file.test.ts', CITATION_SCOPE_SELF_FILE];
    const textByFile: Record<string, string> = {
      'scripts/other-file.test.ts': '参照は `clone.ts:505` に在る。',
      [CITATION_SCOPE_SELF_FILE]: '参照は `clone.ts:505` に在る（この歯自身の入力）。',
    };
    const resolve = buildBasenameAwareRepoFileResolver(['packages/core/src/clone.ts']);
    const scoped = excludeCitationScopeSelf(files);
    const entries = scoped.map((file) => ({ file, text: textByFile[file] ?? '' }));
    expect(collectWidenedLineNumberCitations(entries, resolve, [])).toEqual([
      'scripts/other-file.test.ts:1 clone.ts:505',
    ]);
  });

  it('`CAPTURED_OUTPUT_NON_CITATIONS` に載せた file+token は skipped 経由で落ちる（合成入力）', () => {
    const entries = [
      {
        file: 'scripts/mutate-unhandled-errors.test.ts',
        text: '生ログの1行: scripts/check-tracked-nul-bytes.test.ts:43 it.skip',
      },
    ];
    const resolve = buildBasenameAwareRepoFileResolver(['scripts/check-tracked-nul-bytes.test.ts']);
    const skipped = CAPTURED_OUTPUT_NON_CITATIONS.map((e) => ({ file: e.file, token: e.token }));
    expect(collectWidenedLineNumberCitations(entries, resolve, skipped)).toEqual([]);
    expect(collectWidenedLineNumberCitations(entries, resolve, [])).toEqual([
      'scripts/mutate-unhandled-errors.test.ts:1 scripts/check-tracked-nul-bytes.test.ts:43',
    ]);
  });
});

// `docs/` の外のパスへ広げない: `apps` `packages` `scripts` の下は dist・生成物・glob・fixture で偽陽性が支配的になるため。
export interface CanonPathCitation {
  readonly line: number;
  readonly token: string;
}

// 直前が `:` のものを弾く: `git show <sha>:docs/….md`（畳んだ住所）を許すため。`/` を弾くのは URL を避けるため。
export function findCanonPathCitations(lines: readonly ProseLine[]): CanonPathCitation[] {
  const re = /(?<![\w.\-/:])(?:\.\/)?(docs\/[A-Za-z0-9_.\-/]*[A-Za-z0-9_-]\.md)/g;
  const out: CanonPathCitation[] = [];
  for (const { line, text } of lines) {
    for (const m of text.matchAll(re)) {
      const token = m[1];
      if (token === undefined) continue;
      out.push({ line, token });
    }
  }
  return out;
}

export function collectMissingCanonPathCitations(
  entries: readonly { file: string; text: string }[],
  exists: (candidate: string) => boolean,
  skipped: readonly { file: string; token: string }[],
): string[] {
  const skip = new Set(skipped.map((s) => `${s.file} ${s.token}`));
  const out: string[] = [];
  for (const { file, text } of entries) {
    for (const c of findCanonPathCitations(proseLines(text))) {
      if (exists(c.token)) continue;
      if (skip.has(`${file} ${c.token}`)) continue;
      out.push(`${file}:${c.line} ${c.token}`);
    }
  }
  return out;
}

export interface MissingCanonPathExemption {
  readonly file: string;
  readonly token: string;
  readonly why: string;
}

// 免除に件数を持たせない: 件数を焼き込むと、健全な参照を1本足しただけで赤くなり、書かない動機を作るため。
export const MISSING_CANON_PATH_EXEMPTIONS: readonly MissingCanonPathExemption[] = [
  {
    file: 'AGENTS.md',
    token: 'docs/roadmap.md',
    why: '廃止そのものを説明している行（「かつて … の進捗チェックボックスだけが例外だったが、その文書は廃止した」）。指し先の内容を必要としない過去形の言及である ⟹ 直すものが無い。',
  },
  {
    file: '.claude/agents-md-records/first-read.md',
    token: 'docs/roadmap.md',
    why:
      '#1192 の再編（PR2）で AGENTS.md から逐語のまま移した、廃止そのものを説明している行' +
      '（「ここには4本目として … 実装計画 … が在ったが、2026-08-26 に廃止した」）。同じ行に' +
      "畳んだ住所 `git show 13d7794:…` を持つ ⟹ 直すものが無い。移設前は `file: 'AGENTS.md'` " +
      'の免除がこの行も兼ねていた。',
  },
  {
    file: 'docs/architecture.md',
    token: 'docs/roadmap.md',
    why: '**正典。AI が単独で書き換えない側である**（AGENTS.md「正典は AI が単独で書き換えない」）。かつ中身は「廃止された」と明示したうえで畳んだ住所2本（`git show 13d7794:…` / `git show 7046e2c:…`）を同じ行に持つ ⟹ #904 が「正しく畳んだ見本」と呼んだものそのものである。',
  },
];

// 範囲を `src` や `.claude` で絞らない: 正典への腐った住所はどこにでも書けるため。
const CANON_PATH_SCOPE_FILES = excludeCitationScopeSelf(
  SCANNABLE_FILES.filter((f) => !lstatSync(path.join(ROOT, f)).isSymbolicLink()),
);

describe('正典のパスを名指しした住所が実在すること（#904）', () => {
  it('免除表の理由（why）が全部、非空である', () => {
    const blank = MISSING_CANON_PATH_EXEMPTIONS.filter((e) => e.why.trim().length === 0).map(
      (e) => `${e.file} ${e.token}`,
    );
    expect(
      blank,
      '免除の理由が空である。なぜ実在しないパスを名指ししたままでよいのかを' +
        '書くこと（空欄を許すと、免除表は数合わせの場所になる）。',
    ).toEqual([]);
  });

  it('免除表に載っている項目が、いまも実際に検出される現物と一致する（幽霊免除が無い）', () => {
    const stillDetected = new Set<string>();
    for (const file of CANON_PATH_SCOPE_FILES) {
      for (const c of findCanonPathCitations(proseLines(readRepoFile(file)))) {
        if (!isRepoFile(c.token)) stillDetected.add(`${file} ${c.token}`);
      }
    }
    const ghosts = MISSING_CANON_PATH_EXEMPTIONS.filter(
      (e) => !stillDetected.has(`${e.file} ${e.token}`),
    ).map((e) => `${e.file} ${e.token}`);
    expect(
      ghosts,
      '免除表に載っている file+token が、もう検出されない（直った/消えた/パスが' +
        '復活した）。免除表からこの行を消すこと——直った後も免除に残すと、次に' +
        '本当に必要な免除が増えたときに見分けが付かなくなる。',
    ).toEqual([]);
  });

  it('実在しない正典のパスを、実在するかのように名指ししていない', () => {
    const entries = CANON_PATH_SCOPE_FILES.map((file) => ({ file, text: readRepoFile(file) }));
    const skipped = MISSING_CANON_PATH_EXEMPTIONS.map((e) => ({ file: e.file, token: e.token }));
    const hits = collectMissingCanonPathCitations(entries, isRepoFile, skipped);
    expect(
      hits,
      '**消えたパスを「実在する住所」として名指ししている。**行番号の腐り' +
        '（開くと別の行が出るので気づく余地がある）と違って、**消えたパスは' +
        '開こうとしない限り永久に気づかれない** ⟹ 根拠として引いているなら、' +
        '失われるのは参照ではなく判断の理由そのものである（#904。実例は ' +
        'roadmap の6件で、消えてから気づかれるまで17日かかった）。' +
        '【直し方】(a) 根拠がいまも要る ⟹ `git show <sha>:<path>` の形へ畳む' +
        '（`AGENTS.md` と正典に見本が在る） (b) 根拠が別の場所へ移った ⟹ その' +
        '住所を指す（未完のフェーズを持つのは Issue である） (c) 根拠がもう' +
        '要らない ⟹ **理由を書いて**参照ごと消す。⛔ 黙って消さないこと——' +
        '「要らなくなった」と「探すのが面倒だった」は、消えた後では区別が' +
        '付かない。⛔ **「たぶんこのパスだろう」で書き換えないこと。**指そうと' +
        'していたものが分からないなら、直さずに人間へ聞くほうが安い——推測で' +
        '書いた住所は、次の人にとって同じ嘘である。直せない理由があるなら ' +
        'MISSING_CANON_PATH_EXEMPTIONS へ理由つきで足すこと' +
        '（scripts/agents-md-references.test.ts）。',
    ).toEqual([]);
  });
});

describe('findCanonPathCitations / collectMissingCanonPathCitations（合成 fixture。#904）', () => {
  const exists = (c: string) => c === 'docs/PRD.md' || c === 'docs/architecture.md';

  it('実在しないパスを拾い、実在するパスは拾わない', () => {
    const entries = [
      { file: 'a.ts', text: '根拠は `docs/gone.md` に在る。' },
      { file: 'b.ts', text: '根拠は `docs/PRD.md` に在る。' },
    ];
    expect(collectMissingCanonPathCitations(entries, exists, [])).toEqual(['a.ts:1 docs/gone.md']);
  });

  it('畳んだ住所（`<sha>:` が直前に付く形）は拾わない', () => {
    const entries = [{ file: 'a.ts', text: '読むなら `git show 13d7794:docs/gone.md` である。' }];
    expect(collectMissingCanonPathCitations(entries, exists, [])).toEqual([]);
  });

  it('先頭の `./` は剥がして同じトークンへ畳む', () => {
    const entries = [{ file: 'a.md', text: '[消えた計画](./docs/gone.md) を見よ。' }];
    expect(collectMissingCanonPathCitations(entries, exists, [])).toEqual(['a.md:1 docs/gone.md']);
  });

  it('URL の中（直前が `/`）は拾わない', () => {
    const entries = [
      { file: 'a.md', text: 'https://github.com/takecchi/alteroid/blob/main/docs/gone.md' },
    ];
    expect(collectMissingCanonPathCitations(entries, exists, [])).toEqual([]);
  });

  it('フェンスの中（生の出力）は拾わない', () => {
    const entries = [
      { file: 'a.md', text: ['本文。', '```', '$ cat docs/gone.md', '```'].join('\n') },
    ];
    expect(collectMissingCanonPathCitations(entries, exists, [])).toEqual([]);
  });

  it('免除表に載せた file+token は落ちる。載せなければ落ちない（免除が「そもそも拾えていない」のではないことの確認）', () => {
    const entries = [{ file: 'a.ts', text: '`docs/gone.md` は廃止された。' }];
    expect(
      collectMissingCanonPathCitations(entries, exists, [{ file: 'a.ts', token: 'docs/gone.md' }]),
    ).toEqual([]);
    expect(collectMissingCanonPathCitations(entries, exists, [])).toEqual(['a.ts:1 docs/gone.md']);
  });

  it('免除は file と token の両方が一致したときだけ効く（別ファイルの同じ token は落ちない）', () => {
    const entries = [{ file: 'b.ts', text: '`docs/gone.md` は廃止された。' }];
    expect(
      collectMissingCanonPathCitations(entries, exists, [{ file: 'a.ts', token: 'docs/gone.md' }]),
    ).toEqual(['b.ts:1 docs/gone.md']);
  });

  it('⭐ 陰性対照2: 健全な参照を何本足しても緑のまま（件数を焼き込んでいないことの証拠）', () => {
    const entries = [
      { file: 'a.ts', text: '`docs/PRD.md` と `docs/architecture.md` と `docs/PRD.md`。' },
      { file: 'b.ts', text: '[PRD](./docs/PRD.md) をもう1本足した。' },
    ];
    expect(collectMissingCanonPathCitations(entries, exists, [])).toEqual([]);
  });

  it('行番号は検出したトークンの行を指す（複数行）', () => {
    const entries = [{ file: 'a.ts', text: ['1行目。', '2行目。', '`docs/gone.md`'].join('\n') }];
    expect(collectMissingCanonPathCitations(entries, exists, [])).toEqual(['a.ts:3 docs/gone.md']);
  });
});
