import { describe, expect, it } from 'vitest';

import {
  computeUnion,
  computeVanishedFootprint,
  evaluatePrVanishedFootprint,
  extractInlineCodeSpans,
  findNamedMentions,
  formatVerdict,
  matchNamedCandidate,
  truncateExcerpt,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-pr-vanished-footprint-core.mjs';

/**
 * `check-pr-vanished-footprint` の歯（Issue #1130）。
 *
 * 本物の `gh api` / `gh pr view` は叩かない —— 合成したコミット・差分・本文で
 * 判定だけを確かめる（`check-pr-closing-keywords.test.ts` と同じ理由）。
 *
 * PR #1115 / #1007 は Issue #1130 のコメント（2026-09-17T02:48:37Z、observedBy
 * takecchi、`gh api repos/takecchi/alteroid/commits/<sha> --jq
 * '.files[].filename'` で検算済み）に載った実測値をそのまま fixture にしている。
 */

describe('computeUnion', () => {
  it('通常のコミット（parentCount=1）のファイルを和集合にする', () => {
    const union = computeUnion([
      { parentCount: 1, files: ['a.ts', 'b.ts'] },
      { parentCount: 1, files: ['b.ts', 'c.ts'] },
    ]);
    expect([...union].sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('parentCount が2件以上のマージコミットは除外する', () => {
    const union = computeUnion([
      { parentCount: 1, files: ['a.ts'] },
      { parentCount: 2, files: ['merged-only.ts'] },
      { parentCount: 3, files: ['merged-only-2.ts'] },
    ]);
    expect([...union].sort()).toEqual(['a.ts']);
  });

  it('files が無い / 空のコミットも壊れない', () => {
    const union = computeUnion([
      { parentCount: 1, files: [] },
      { parentCount: 0, files: undefined as never },
    ]);
    expect([...union]).toEqual([]);
  });
});

describe('computeVanishedFootprint', () => {
  it('U と F が同じなら空（緑の前提）', () => {
    expect(computeVanishedFootprint(new Set(['a.ts', 'b.ts']), ['a.ts', 'b.ts'])).toEqual([]);
  });

  it('U にあって F に無いものだけを返す（ソート済み）', () => {
    expect(computeVanishedFootprint(new Set(['z.ts', 'a.ts', 'b.ts']), ['b.ts'])).toEqual([
      'a.ts',
      'z.ts',
    ]);
  });

  it('配列で渡しても Set と同じ結果になる', () => {
    expect(computeVanishedFootprint(['a.ts', 'b.ts'], ['b.ts'])).toEqual(['a.ts']);
  });
});

describe('matchNamedCandidate — 3つの当たり方', () => {
  it('完全一致（exact）', () => {
    expect(matchNamedCandidate('AGENTS.md', 'AGENTS.md')).toBe('exact');
  });

  it('末尾一致（suffix）: tools.ts が packages/core/src/tools.ts に当たる', () => {
    expect(matchNamedCandidate('packages/core/src/tools.ts', 'tools.ts')).toBe('suffix');
  });

  it('ディレクトリ前方一致（subpath）: packages/core が packages/core/foo.ts に当たる', () => {
    expect(matchNamedCandidate('packages/core/foo.ts', 'packages/core')).toBe('subpath');
  });

  it('ディレクトリ前方一致（subpath）: packages/core が packages/core/src/tools.ts に当たる（深い階層でも）', () => {
    expect(matchNamedCandidate('packages/core/src/tools.ts', 'packages/core')).toBe('subpath');
  });

  it('当たらない場合は null', () => {
    expect(matchNamedCandidate('packages/core/src/tools.ts', 'unrelated.ts')).toBeNull();
  });

  it(
    '⛔ 差し戻し（2026-09-17）: packages/core が packages/core-extra/foo.ts に当たらない' +
      '（境界の無い startsWith を混ぜていたことによる誤爆。`/` の境界を要求する形に直した）',
    () => {
      expect(matchNamedCandidate('packages/core-extra/foo.ts', 'packages/core')).toBeNull();
    },
  );

  it(
    '⛔ 差し戻し（2026-09-17）: 1文字の候補 `a` が apps/web/foo.ts に当たらない' +
      '（この repo の本文に頻出する短い断片が、v の先頭に偶然一致するだけで当たらないこと）',
    () => {
      expect(matchNamedCandidate('apps/web/foo.ts', 'a')).toBeNull();
    },
  );

  it('短い断片でも `/` の境界を跨げば当たる（例: apps が apps/web/foo.ts に当たる）', () => {
    expect(matchNamedCandidate('apps/web/foo.ts', 'apps')).toBe('subpath');
  });
});

describe('extractInlineCodeSpans', () => {
  it('複数行から複数のスパンを拾う', () => {
    const body = ['`a.ts` の話。', '`b.ts` と `c.ts` の話。'].join('\n');
    expect(extractInlineCodeSpans(body).map((s: { content: string }) => s.content)).toEqual([
      'a.ts',
      'b.ts',
      'c.ts',
    ]);
  });

  it('空のスパンは候補にしない', () => {
    expect(
      extractInlineCodeSpans('`` と `a.ts`').map((s: { content: string }) => s.content),
    ).toEqual(['a.ts']);
  });

  it('スパンは行を跨がない', () => {
    const body = ['`a.ts', 'b.ts`'].join('\n');
    expect(extractInlineCodeSpans(body)).toEqual([]);
  });

  it('空文字・非文字列は空配列', () => {
    expect(extractInlineCodeSpans('')).toEqual([]);
    expect(extractInlineCodeSpans(null as unknown as string)).toEqual([]);
  });
});

describe('truncateExcerpt', () => {
  it('200文字以下ならそのまま（前後の空白は trim する）', () => {
    expect(truncateExcerpt('  短い行  ')).toBe('短い行');
  });

  it('200文字を超えたら切り詰めて … を付ける', () => {
    const long = 'あ'.repeat(250);
    const result = truncateExcerpt(long);
    expect(result.length).toBe(201);
    expect(result.endsWith('…')).toBe(true);
    expect(result.startsWith('あ'.repeat(200))).toBe(true);
  });

  it('既定の上限は200文字だが引数で変えられる', () => {
    expect(truncateExcerpt('abcdefghij', 5)).toBe('abcde…');
  });
});

describe('findNamedMentions', () => {
  it('名指しがあれば file と hits を返す', () => {
    const result = findNamedMentions(['AGENTS.md'], '- `AGENTS.md` に追記した。');
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('AGENTS.md');
    expect(result[0].hits).toEqual([
      { kind: 'exact', candidate: 'AGENTS.md', excerpt: '- `AGENTS.md` に追記した。' },
    ]);
  });

  it('名指しが無ければ空配列', () => {
    expect(findNamedMentions(['AGENTS.md'], 'ふつうの本文。コードスパンは無い。')).toEqual([]);
  });

  it('同じ行に同じ当たり方が複数回出ても重複させない', () => {
    const result = findNamedMentions(
      ['AGENTS.md'],
      '`AGENTS.md` と、もう一度 `AGENTS.md` に言及する行。',
    );
    expect(result).toHaveLength(1);
    expect(result[0].hits).toHaveLength(1);
  });

  it('V が複数件のとき、名指しされたものだけを返す（名指しされないものは含まれない）', () => {
    const result = findNamedMentions(['a.ts', 'b.ts'], '`a.ts` だけに触れる本文。');
    expect(result.map((r: { file: string }) => r.file)).toEqual(['a.ts']);
  });
});

describe('evaluatePrVanishedFootprint — 判定の芯', () => {
  it('V が空なら緑（大多数のケース。実測 150本中148本）', () => {
    const result = evaluatePrVanishedFootprint({
      commits: [{ parentCount: 1, files: ['a.ts', 'b.ts'] }],
      finalFiles: ['a.ts', 'b.ts'],
      body: '`a.ts` を変更した。',
    });
    expect(result.verdict).toBe('ok');
    expect(result.vanished).toEqual([]);
  });

  it('V が非空でも、本文がどれも名指ししていなければ緑', () => {
    const result = evaluatePrVanishedFootprint({
      commits: [{ parentCount: 1, files: ['a.ts', 'vanished.ts'] }],
      finalFiles: ['a.ts'],
      body: 'この本文は vanished.ts に一言も触れていない。',
    });
    expect(result.vanished).toEqual(['vanished.ts']);
    expect(result.verdict).toBe('ok');
  });

  it('V が非空 かつ 名指しが在れば赤（found）', () => {
    const result = evaluatePrVanishedFootprint({
      commits: [{ parentCount: 1, files: ['a.ts', 'vanished.ts'] }],
      finalFiles: ['a.ts'],
      body: '- `vanished.ts` を追記した。',
    });
    expect(result.vanished).toEqual(['vanished.ts']);
    expect(result.verdict).toBe('found');
    expect(result.mentions).toEqual([
      {
        file: 'vanished.ts',
        hits: [
          { kind: 'exact', candidate: 'vanished.ts', excerpt: '- `vanished.ts` を追記した。' },
        ],
      },
    ]);
  });

  it('マージコミット（parentCount=2）は U に混ぜない ⟹ そのファイルは V にも現れない', () => {
    const result = evaluatePrVanishedFootprint({
      commits: [
        { parentCount: 1, files: ['a.ts'] },
        { parentCount: 2, files: ['merged-in.ts'] },
      ],
      finalFiles: ['a.ts'],
      body: '`merged-in.ts` の話。',
    });
    expect(result.vanished).toEqual([]);
    expect(result.verdict).toBe('ok');
  });

  it('commits が null なら unreadable（fail-closed）', () => {
    const result = evaluatePrVanishedFootprint({ commits: null, finalFiles: [], body: '' });
    expect(result.verdict).toBe('unreadable');
  });

  it('finalFiles が null なら unreadable', () => {
    const result = evaluatePrVanishedFootprint({ commits: [], finalFiles: null, body: '' });
    expect(result.verdict).toBe('unreadable');
  });

  it('body が文字列でなければ unreadable', () => {
    const result = evaluatePrVanishedFootprint({ commits: [], finalFiles: [], body: null });
    expect(result.verdict).toBe('unreadable');
  });

  it('commits が空配列・finalFiles が空配列・body が空文字は「読めた」結果であり ok', () => {
    const result = evaluatePrVanishedFootprint({ commits: [], finalFiles: [], body: '' });
    expect(result.verdict).toBe('ok');
  });
});

describe('実測: PR #1115（本物。Issue #1130 コメント 2026-09-17T02:48:37Z より）', () => {
  // U = {ci.yml, no-attribution-trailers.yml, pr-title.yml, AGENTS.md,
  //      check-no-attribution-trailers.mjs}（コミット3本、いずれも parentCount=1）
  // F は AGENTS.md を含まない4件 ⟹ V = {AGENTS.md}
  const commits = [
    {
      parentCount: 1,
      files: ['.github/workflows/ci.yml', '.github/workflows/no-attribution-trailers.yml'],
    },
    {
      parentCount: 1,
      files: [
        '.github/workflows/pr-title.yml',
        'AGENTS.md',
        'scripts/check-no-attribution-trailers.mjs',
      ],
    },
    { parentCount: 1, files: ['AGENTS.md'] },
  ];
  const finalFiles = [
    '.github/workflows/ci.yml',
    '.github/workflows/no-attribution-trailers.yml',
    '.github/workflows/pr-title.yml',
    'scripts/check-no-attribution-trailers.mjs',
  ];
  const body =
    '- `AGENTS.md` の「draft の run が `conclusion: success` を名乗るようになった」項に、' +
    'この変更で状況が変わったことを追記（実測の記録そのものは書き換えていない）';

  it('V = {AGENTS.md}', () => {
    const union = computeUnion(commits);
    expect(computeVanishedFootprint(union, finalFiles)).toEqual(['AGENTS.md']);
  });

  it('本文が `AGENTS.md` を完全一致で名指ししている ⟹ 赤', () => {
    const result = evaluatePrVanishedFootprint({ commits, finalFiles, body });
    expect(result.vanished).toEqual(['AGENTS.md']);
    expect(result.verdict).toBe('found');
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0].file).toBe('AGENTS.md');
    expect(result.mentions[0].hits[0].kind).toBe('exact');
  });

  it('formatVerdict が名指しされた文と、次の一手（required ではない旨）を出す', () => {
    const result = evaluatePrVanishedFootprint({ commits, finalFiles, body });
    const text = formatVerdict('1115', result);
    expect(text).toContain('`AGENTS.md`');
    expect(text).toContain('本文がまだ古い主張を持っていないか確かめること');
    expect(text).toContain('required ではない');
    // 「本文が嘘だ」とは言わない
    expect(text).not.toContain('嘘');
  });
});

describe('実測: PR #1007（唯一のもう1本。Issue #1130 コメント 2026-09-17T02:48:37Z より）', () => {
  // V = {packages/core/src/prompt.ts,
  //      packages/core/src/tool-description-enumeration.test.ts,
  //      packages/core/src/tools.test.ts}
  // 実際のコミット一覧は Issue コメントに数値までは載っていないため、U がこの3件
  // ＋最終差分に残るファイルを含む、という最小限の構成で合成する
  // （評価対象は「U\F の計算」ではなく「名指しの判定と、動詞を見ないことの帰結」）。
  const commits = [
    {
      parentCount: 1,
      files: [
        'packages/core/src/prompt.ts',
        'packages/core/src/tool-description-enumeration.test.ts',
        'packages/core/src/tools.test.ts',
        'packages/core/src/tools.ts',
        'packages/core/src/inbox-remove-many.ts',
      ],
    },
  ];
  const finalFiles = ['packages/core/src/tools.ts', 'packages/core/src/inbox-remove-many.ts'];
  // 実際の本文の逐語（Issue コメントより）:
  // 「⛔ クローンの道具 `inbox_remove_many`（`tools.ts` / `prompt.ts` の「# 道具」節 /
  //   `tool-description-enumeration.test.ts` / `tools.test.ts` の該当ケース）— #1013 へ」
  const body =
    '- ⛔ クローンの道具 `inbox_remove_many`（`tools.ts` / `prompt.ts` の「# 道具」節 / ' +
    '`tool-description-enumeration.test.ts` / `tools.test.ts` の該当ケース）— #1013 へ';

  it('V の3件を計算できる', () => {
    const union = computeUnion(commits);
    expect(computeVanishedFootprint(union, finalFiles)).toEqual([
      'packages/core/src/prompt.ts',
      'packages/core/src/tool-description-enumeration.test.ts',
      'packages/core/src/tools.test.ts',
    ]);
  });

  it(
    '⚠️ この設計では赤くなる（動詞を判定しないため）。' +
      '実際の本文は「このPRではやらず #1013 へ送る」という一覧の中の名指しで、嘘ではない。' +
      'Issue #1130 の判断（腐る動詞リストを持つより、この形の赤を1本受け入れる）どおりの' +
      '意図された挙動であり、この門が required ではない理由そのものの実例でもある。',
    () => {
      const result = evaluatePrVanishedFootprint({ commits, finalFiles, body });
      expect(result.vanished).toEqual([
        'packages/core/src/prompt.ts',
        'packages/core/src/tool-description-enumeration.test.ts',
        'packages/core/src/tools.test.ts',
      ]);
      expect(result.verdict).toBe('found');
      // 3件とも末尾一致（`prompt.ts` 等の短い名前で名指しされている）
      expect(result.mentions).toHaveLength(3);
      for (const mention of result.mentions) {
        expect(mention.hits[0].kind).toBe('suffix');
      }
    },
  );
});

describe('formatVerdict', () => {
  it('ok は OK を名乗る', () => {
    const text = formatVerdict('1', { verdict: 'ok', vanished: [], mentions: [] });
    expect(text).toContain('check-pr-vanished-footprint(#1):');
    expect(text).toContain('OK');
  });

  it('unreadable は fail-closed であることを名乗る', () => {
    const text = formatVerdict('1', { verdict: 'unreadable', vanished: [], mentions: [] });
    expect(text).toContain('判定できなかった');
    expect(text).toContain('fail-closed');
  });

  it('found は required ではないことと、次の一手を必ず含む', () => {
    const text = formatVerdict('1', {
      verdict: 'found',
      vanished: ['x.ts'],
      mentions: [
        { file: 'x.ts', hits: [{ kind: 'exact', candidate: 'x.ts', excerpt: '`x.ts` の話。' }] },
      ],
    });
    expect(text).toContain('required ではない');
    expect(text).toContain('`x.ts`');
  });
});

/**
 * 着地後に見つかった2件の欠陥を突く歯（どちらも実測で再現済み）。
 *
 * - 誤検出: フェンス（```）の中のバッククォートを名指しとして拾っていた
 * - 見逃し: 候補の末尾スラッシュ（`packages/core/`）が二重スラッシュになり外れていた
 */
describe('フェンスの中を名指しとして拾わない（誤検出の修正）', () => {
  it('フェンスの中だけに在るバッククォートは名指しに数えない', () => {
    const body = ['参考:', '```js', 'const p = `AGENTS.md`;', '```'].join('\n');
    expect(extractInlineCodeSpans(body)).toEqual([]);
  });

  it('フェンスの外（地の文）のバッククォートは今までどおり拾う', () => {
    const body = '本文が `AGENTS.md` を名指ししている。';
    expect(extractInlineCodeSpans(body).map((s: { content: string }) => s.content)).toEqual([
      'AGENTS.md',
    ]);
  });

  it('フェンスの中だけで触れたファイルは found にしない（本文は変えていないと明記している回）', () => {
    const body = [
      '参考:',
      '```js',
      'const p = `AGENTS.md`;',
      '```',
      'この PR では AGENTS.md を1文字も変更していない。',
    ].join('\n');
    const result = evaluatePrVanishedFootprint({
      commits: [{ parentCount: 1, files: ['AGENTS.md', 'a.ts'] }],
      finalFiles: ['a.ts'],
      body,
    });
    expect(result.vanished).toEqual(['AGENTS.md']);
    expect(result.mentions).toEqual([]);
    expect(result.verdict).toBe('ok');
  });

  it('同じ消えた足跡でも、地の文で名指しされていれば found のまま（見逃しを増やしていない）', () => {
    const result = evaluatePrVanishedFootprint({
      commits: [{ parentCount: 1, files: ['AGENTS.md', 'a.ts'] }],
      finalFiles: ['a.ts'],
      body: '本文が `AGENTS.md` を名指ししている。',
    });
    expect(result.verdict).toBe('found');
  });
});

describe('末尾スラッシュ付きのディレクトリ名指し（見逃しの修正）', () => {
  it('末尾スラッシュ付きでも subpath に当たる', () => {
    expect(matchNamedCandidate('packages/core/src/tools.ts', 'packages/core/')).toBe('subpath');
  });

  it('末尾スラッシュ無しの従来の形も subpath のまま', () => {
    expect(matchNamedCandidate('packages/core/src/tools.ts', 'packages/core')).toBe('subpath');
  });

  it('⚠ 境界の不変条件は戻していない —— packages/core は packages/core-extra/... に当たらない', () => {
    expect(matchNamedCandidate('packages/core-extra/foo.ts', 'packages/core')).toBeNull();
    expect(matchNamedCandidate('packages/core-extra/foo.ts', 'packages/core/')).toBeNull();
  });

  it('スラッシュだけの候補は、剥がすと空になるのでどこにも当てない', () => {
    expect(matchNamedCandidate('a.ts', '/')).toBeNull();
    expect(matchNamedCandidate('a.ts', '///')).toBeNull();
  });
});
