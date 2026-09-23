import { describe, expect, it } from 'vitest';

import {
  BRANCH_WORDS,
  RETENTION_WORDS,
  buildReport,
  evaluateRetentionPromise,
  evaluateRetentionSources,
  excerptAround,
  findRetentionWordHits,
  formatBranchSection,
  hasBranchWord,
  parseGitGrepMatches,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './branch-deletable-core.mjs';

/**
 * `branch-deletable` の歯。本物の `git grep` / `gh` は叩かない——合成した
 * テキスト・生出力の形で判定だけを確かめる（`check-no-attribution-trailers.test.ts`
 * と同じ理由）。
 *
 * ⭐ **とくに「枝（`名前`）は残る」の形が当たることを固定する**——これは
 * 2026-09-20 に削除された26本を、狭い定型句（「枝は残る」の完全一致）で
 * 測ったときに実際に取りこぼした形である（`fix/1130-pr-body-diff-claim-measurement`
 * と `ci/1171-railway-typecheck` が窓から落ち、8本→6本になった）。
 */

describe('hasBranchWord / findRetentionWordHits', () => {
  it('「枝」「ブランチ」のどちらかで枝の話だと判定する', () => {
    expect(hasBranchWord('この枝は残す')).toBe(true);
    expect(hasBranchWord('このブランチは残す')).toBe(true);
    expect(hasBranchWord('無関係な文章')).toBe(false);
    expect(hasBranchWord('')).toBe(false);
    expect(hasBranchWord(null)).toBe(false);
  });

  it('BRANCH_WORDS は枝・ブランチの2語', () => {
    expect(BRANCH_WORDS).toEqual(['枝', 'ブランチ']);
  });

  it('RETENTION_WORDS は依頼者が実測で決めた9語を持つ（狭めない）', () => {
    expect(RETENTION_WORDS).toEqual([
      '残す',
      '残る',
      '残しま',
      '残して',
      '消しません',
      '消さない',
      '消していない',
      '削除してはいけない',
      '削除候補ではない',
    ]);
  });

  it('保持語が複数在れば全部を拾う', () => {
    const hits = findRetentionWordHits('残す。消しません。削除してはいけない。');
    expect(hits.map((h: { word: string }) => h.word)).toEqual([
      '残す',
      '消しません',
      '削除してはいけない',
    ]);
  });

  it('保持語が無ければ空配列', () => {
    expect(findRetentionWordHits('ふつうの文章')).toEqual([]);
  });
});

describe('excerptAround', () => {
  it('前後150文字ぶんを切り出し、境界で省略記号を付ける', () => {
    const text = 'あ'.repeat(200) + '残る' + 'い'.repeat(200);
    const idx = 200;
    const excerpt = excerptAround(text, idx, '残る'.length, 150);
    expect(excerpt.startsWith('…')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt).toContain('残る');
  });

  it('先頭・末尾に近ければ省略記号を付けない', () => {
    const text = '残る' + 'い'.repeat(10);
    const excerpt = excerptAround(text, 0, '残る'.length, 150);
    expect(excerpt.startsWith('…')).toBe(false);
    expect(excerpt.endsWith('…')).toBe(false);
  });
});

describe('evaluateRetentionPromise', () => {
  it('⭐ 「枝（<枝名>）は残る」の形が当たる（実測で取りこぼした形の再発防止）', () => {
    const text = '枝（fix/1130-pr-body-diff-claim-measurement）は残る。理由はここに書く。';
    const result = evaluateRetentionPromise(text);
    expect(result.promising).toBe(true);
    expect(result.hits.map((h: { word: string }) => h.word)).toContain('残る');
  });

  it('「枝は残る」の完全一致でなくても、枝の話＋保持語の同居で当たる', () => {
    const text = 'この件について、ci/1171-railway-typecheck のブランチは消していない。';
    const result = evaluateRetentionPromise(text);
    expect(result.promising).toBe(true);
  });

  it('保持語だけで枝の語が無ければ当たらない', () => {
    const result = evaluateRetentionPromise('この設定は残す。');
    expect(result.promising).toBe(false);
    expect(result.hits).toEqual([]);
  });

  it('枝の語だけで保持語が無ければ当たらない', () => {
    const result = evaluateRetentionPromise('この枝を消してよいか検討する。');
    expect(result.promising).toBe(false);
  });

  it('⚠️ 誤検出は仕様どおり当たる（文意が逆でも「枝」＋保持語の同居で当たる）', () => {
    // 実測: chore/dependabot-config の本文は「この枝は残す理由が無い。削除してよい」
    const text = 'この枝は残す理由が無い。削除してよい。';
    const result = evaluateRetentionPromise(text);
    expect(result.promising).toBe(true);
  });

  it('空文字・null・undefined は当たらない', () => {
    expect(evaluateRetentionPromise('').promising).toBe(false);
    expect(evaluateRetentionPromise(null).promising).toBe(false);
    expect(evaluateRetentionPromise(undefined).promising).toBe(false);
  });
});

describe('evaluateRetentionSources', () => {
  it('複数の PR・複数のソースから当たった箇所だけを集める', () => {
    const hits = evaluateRetentionSources([
      { prNumber: 93, source: '本文', text: 'ブランチは残す。' },
      { prNumber: 93, source: 'コメント(id 1)', text: '無関係なコメント。' },
      { prNumber: 119, source: '本文', text: '枝は消しません。' },
    ]);
    expect(hits).toEqual([
      { prNumber: 93, source: '本文', word: '残す', excerpt: expect.stringContaining('残す') },
      {
        prNumber: 119,
        source: '本文',
        word: '消しません',
        excerpt: expect.stringContaining('消しません'),
      },
    ]);
  });

  it('何も当たらなければ空配列', () => {
    expect(evaluateRetentionSources([{ prNumber: 1, source: '本文', text: '無関係' }])).toEqual([]);
  });

  it('sources が空・undefined でも例外を投げない', () => {
    expect(evaluateRetentionSources([])).toEqual([]);
    expect(evaluateRetentionSources(undefined)).toEqual([]);
  });
});

describe('parseGitGrepMatches', () => {
  it('`<rev>:<path>:<line>:<content>` の形を構造化する（実測どおりの形）', () => {
    const raw =
      'origin/main:packages/core/src/archive-prune.ts:159: * ある。**この実測を載せていた枝 `investigate/698-archive-stage1` は';
    const matches = parseGitGrepMatches(raw, 'origin/main');
    expect(matches).toEqual([
      {
        path: 'packages/core/src/archive-prune.ts',
        line: '159',
        content: ' * ある。**この実測を載せていた枝 `investigate/698-archive-stage1` は',
      },
    ]);
  });

  it('複数行・中身にコロンを含む行も崩さず分解する', () => {
    const raw = [
      'origin/main:scripts/test-guard-core.mjs:372: *    `origin/measure/fb1c80e3-388-signal-scaffold` の',
      'origin/main:.claude/skills/branch-cleanup/SKILL.md:67: 実測(2026-08-27): `fix/distill-shutdown-dedup` は force_push が 09:04:52Z',
    ].join('\n');
    const matches = parseGitGrepMatches(raw, 'origin/main');
    expect(matches).toHaveLength(2);
    expect(matches[0].path).toBe('scripts/test-guard-core.mjs');
    expect(matches[0].line).toBe('372');
    expect(matches[1].content).toContain('force_push が 09:04:52Z');
  });

  it('空文字・空白だけの出力は0件（該当なしは正常な結果）', () => {
    expect(parseGitGrepMatches('', 'origin/main')).toEqual([]);
    expect(parseGitGrepMatches('   \n  ', 'origin/main')).toEqual([]);
    expect(parseGitGrepMatches(null, 'origin/main')).toEqual([]);
  });

  it('想定した形に分解できない行は落とさず、そのまま見せる', () => {
    const matches = parseGitGrepMatches('形が崩れた1行', 'origin/main');
    expect(matches).toEqual([{ path: null, line: null, content: '形が崩れた1行' }]);
  });
});

describe('formatBranchSection', () => {
  it('A/B の件数と中身を人が読める形にする', () => {
    const section = formatBranchSection(
      'fix/distill-shutdown-dedup',
      [{ path: 'a.ts', line: '10', content: 'fix/distill-shutdown-dedup を参照' }],
      [{ prNumber: 851, source: '本文', word: '残す', excerpt: '…ブランチは残す…' }],
    );
    expect(section).toContain('## fix/distill-shutdown-dedup');
    expect(section).toContain('A: 1件');
    expect(section).toContain('a.ts:10:');
    expect(section).toContain('B: 1件');
    expect(section).toContain('PR #851');
    expect(section).toContain('残す');
  });

  it('0件でも件数の行は出す', () => {
    const section = formatBranchSection('wip/m5-merge-snapshot', [], []);
    expect(section).toContain('A: 0件');
    expect(section).toContain('B: 0件');
  });
});

describe('buildReport', () => {
  it('先頭と末尾に「消すな、ではなく読め」の注記を付ける', () => {
    const { text } = buildReport([{ branch: 'x', checkAMatches: [], checkBHits: [] }]);
    const occurrences = text.split('読め').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(text).toContain('誤検出が在る');
  });

  it('1件でも当たれば終了コード1', () => {
    const { exitCode } = buildReport([
      {
        branch: 'x',
        checkAMatches: [{ path: 'a.ts', line: '1', content: 'x' }],
        checkBHits: [],
      },
    ]);
    expect(exitCode).toBe(1);
  });

  it('検査Bだけの当たりでも終了コード1', () => {
    const { exitCode } = buildReport([
      {
        branch: 'x',
        checkAMatches: [],
        checkBHits: [{ prNumber: 1, source: '本文', word: '残す', excerpt: '…' }],
      },
    ]);
    expect(exitCode).toBe(1);
  });

  it('全枝が0件なら終了コード0', () => {
    const { exitCode } = buildReport([
      { branch: 'x', checkAMatches: [], checkBHits: [] },
      { branch: 'y', checkAMatches: [], checkBHits: [] },
    ]);
    expect(exitCode).toBe(0);
  });

  it('複数枝を渡すと、それぞれの見出しで区切って出す', () => {
    const { text } = buildReport([
      { branch: 'x', checkAMatches: [], checkBHits: [] },
      { branch: 'y', checkAMatches: [], checkBHits: [] },
    ]);
    expect(text).toContain('## x');
    expect(text).toContain('## y');
  });

  it('収集中のエラーが在れば、握り潰さず出す', () => {
    const { text } = buildReport([
      {
        branch: 'x',
        checkAMatches: [],
        checkBHits: [],
        errors: ['gh pr list が失敗した: something'],
      },
    ]);
    expect(text).toContain('収集中のエラー');
    expect(text).toContain('gh pr list が失敗した');
  });
});
