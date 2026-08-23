import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * **`AGENTS.md` が他のファイルを指すときの形を固定する歯**（#369）。
 *
 * `AGENTS.md` はドキュメントなので、書いてある内容そのものに歯は当てられない。
 * ここが測るのは**参照の形**だけである — 腐ったときに「移動したのか消えたのか」を
 * 読む側が区別できる形になっているか。守っているのは3つで、それ以外は守っていない。
 *
 * 1. リポジトリ内のファイルを `path:行番号` で指していないこと
 * 2. 「N行目」で指していないこと
 * 3. `grep -n '<逐語>' <path>` の形で書かれた出典が、現物に当たること
 *
 * **フェンス（```）の中は見ない。** あそこに在るのは出典ではなく**生の出力**
 * （スタックトレース・過去の実測）で、書き換えてはいけないものだからである。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export type ProseLine = { line: number; text: string };

/** `AGENTS.md` の本文（フェンスの中を落としたもの）を行番号つきで返す。 */
export function proseLines(markdown: string): ProseLine[] {
  const out: ProseLine[] = [];
  let inFence = false;
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? '';
    if (/^\s*(```|~~~)/.test(text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    out.push({ line: i + 1, text });
  }
  return out;
}

export type LineNumberCitation = { line: number; token: string; target: string };

/**
 * `path:123` / `path:123-456` の形の参照のうち、**その `path` がこのリポジトリに実在する
 * ファイルを指しているもの**だけを返す。
 *
 * 実在で絞るのが要点である。この形の見た目は時刻（`2026-08-22T09:35`、`06:27`）と
 * 区別が付かず、リポジトリ外の依存（`tsup/dist/index.js:1703`）は版が固定されていれば
 * 腐らない。**腐るのは「このリポジトリのファイルを行番号で指したとき」だけである。**
 */
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

export type RowNumberCitation = { line: number; token: string };

/** 「106行目」の形の参照を返す。 */
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

/**
 * ``` `grep -n '<逐語>' <path>` ``` の形（インラインのコードスパン）で書かれた出典を返す。
 *
 * **この形だけを見る。** 引数にファイルを取らない `grep`（`grep -rn '<語>'`）や
 * `grep -c` は、出典ではなく道具の説明なので拾わない。
 */
export function findVerbatimCitations(lines: readonly ProseLine[]): VerbatimCitation[] {
  const out: VerbatimCitation[] = [];
  const pattern = /`\s*grep -n\s+(['"])(.+?)\1\s+([^\s`]+)\s*`/g;
  for (const { line, text } of lines) {
    for (const m of text.matchAll(pattern)) {
      out.push({ line, pattern: m[2] ?? '', target: m[3] ?? '' });
    }
  }
  return out;
}

function isRepoFile(candidate: string): boolean {
  if (candidate.includes('..')) return false;
  try {
    return statSync(path.join(ROOT, candidate)).isFile();
  } catch {
    return false;
  }
}

const agentsMd = readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
const prose = proseLines(agentsMd);

describe('AGENTS.md の参照の形（#369）', () => {
  it('本文がフェンスの中身を含まない（この歯が何を見ているかの確認）', () => {
    // フェンスの中にしか無い逐語。落ちたら proseLines が壊れている＝下の3本が
    // 「見ていないから0件」になりうるので、先にここで止める。
    expect(agentsMd).toContain('error occurred in dts build');
    expect(prose.map((l) => l.text).join('\n')).not.toContain('error occurred in dts build');
    expect(prose.length).toBeGreaterThan(100);
  });

  it('リポジトリ内のファイルを `path:行番号` で指さない', () => {
    const found = findLineNumberCitations(prose, isRepoFile);
    expect(
      found.map((c) => `AGENTS.md:${c.line} ${c.token}`),
      '行番号は腐り、腐ったことが読む側から分からない（開いた人には「そこに無い」としか見えず、' +
        '移動したのか消えたのかが区別できない）。逐語（`grep -n \'<逐語>\' <path>`）かシンボル名で指すこと。',
    ).toEqual([]);
  });

  it('「N行目」で指さない', () => {
    const found = findRowNumberCitations(prose);
    expect(
      found.map((c) => `AGENTS.md:${c.line} ${c.token}`),
      '直上と同じ理由。行番号を日本語で書いても腐り方は変わらない。',
    ).toEqual([]);
  });

  it('`grep -n` で書かれた出典が現物に当たる', () => {
    const citations = findVerbatimCitations(prose);
    const missing = citations.filter((c) => {
      if (!isRepoFile(c.target)) return false; // リポジトリ外は見ない
      return !readFileSync(path.join(ROOT, c.target), 'utf8')
        .split('\n')
        .some((l) => l.includes(c.pattern));
    });
    expect(
      missing.map((c) => `AGENTS.md:${c.line} grep -n '${c.pattern}' ${c.target} が0件`),
      [
        'AGENTS.md が引いている逐語が、指したファイルに無い。',
        '⚠️ これは「行が動いた」では落ちない（この歯は行番号を一切見ていない）。',
        '落ちたということは、指された文言そのものが書き換えられたか消えたかである。',
        '(a) 文言を直したのなら、AGENTS.md 側の逐語もいまの文言へ直す（またはシンボル名へ変える）',
        '(b) 指していたものが消えたのなら、AGENTS.md の参照ごと畳む',
      ].join('\n'),
    ).toEqual([]);
  });
});

describe('参照を拾う側そのもの（歯が空振りしていないことの確認）', () => {
  // AGENTS.md が偶然きれいでも、拾う側が壊れていれば上の3本は0件で通る。
  // ここは AGENTS.md を見ずに、拾う側だけを合成入力で測る。
  const fixture = [
    'その境界は `packages/core/src/schema.ts:500-503` に在る。',
    '`apps/web/app/test-support.tsx` の106行目を含む。',
    "逐語は `grep -n 'ここに在る文言' packages/core/src/schema.ts` で当たる。",
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
      { line: 1, token: 'packages/core/src/schema.ts:500-503', target: 'packages/core/src/schema.ts' },
    ]);
  });

  it('「N行目」を拾う（フェンスの中のものは拾わない）', () => {
    expect(findRowNumberCitations(fixtureProse)).toEqual([{ line: 2, token: '106行目' }]);
  });

  it('`grep -n` の出典から逐語とパスを取り出す', () => {
    expect(findVerbatimCitations(fixtureProse)).toEqual([
      { line: 3, pattern: 'ここに在る文言', target: 'packages/core/src/schema.ts' },
    ]);
  });
});
