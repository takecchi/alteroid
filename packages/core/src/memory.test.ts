import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MEMORY_LISTING_BUDGET,
  MEMORY_PREMISE_RANKING_BUDGET,
  MEMORY_PREMISE_CARD_BUDGET,
  MEMORY_PROMPT_DESCRIPTION_BUDGET,
  MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET,
  MEMORY_TIDY_TARGETS_BUDGET,
  describeMemoryTidyTargets,
  MEMORY_PROMPT_OUTLINE_BUDGET,
  MEMORY_PROMPT_OMITTED_TAIL_BUDGET,
  MEMORY_TOC_CHAR_BUDGET,
  MEMORY_TOC_ENTRY_LIMIT,
  MEMORY_TOC_LINE_LIMIT,
  applyMemoryFrontmatterPatch,
  assertNeverMemoryCreatedAt,
  assertNeverMemoryDescriptionFreshness,
  assertNeverMemoryFrontmatterState,
  assertNeverMemoryProtectionStatus,
  containsMemoryFrontmatterLineBreak,
  cutMemorySections,
  deriveMemoryCreatedAtFromJournal,
  deriveMemoryFrontmatter,
  describeMemoryFloor,
  describeMemoryPremiseRanking,
  describeMemoryProtectionStatus,
  describeMemoryReinjectionEstimate,
  describeMemorySessionDelta,
  describeMemoryWriteDiff,
  findOverlappingMemorySections,
  isKnownMemoryDocKind,
  lookupMemorySection,
  measureMemoryFloor,
  measurePremiseOutlineFit,
  memoryBodyStart,
  memoryProtectionAllowsFullReplace,
  memorySectionId,
  nextDescribedAt,
  parseMemoryFrontmatter,
  renderMemoryDocument,
  renderMemoryDocuments,
  renderMemoryListing,
  renderMemoryOutline,
  resolveMemoryDescriptionFreshness,
  resolveMemoryDocKind,
  scanMemorySections,
  type MemoryPart,
  type MemorySection,
  type MemoryTocIssue,
} from './memory.js';
import type { JournalEntry, MemoryDescriptionFreshness, MemoryProtectionStatus } from './schema.js';

/**
 * 記憶をクローンの文脈へ載せる形。
 *
 * **ここが器（fs / pg / インメモリ）から移ってきたもの**なので、形そのものを
 * 1か所で固定する。器ごとに持っていた頃、インメモリ実装だけが見出しを付けて
 * おらず、しかもそれに気づける検査がどこにも無かった。
 *
 * 見出しの形（`<!-- memory: slug.md -->`）は**上の層が依存している**。走行中に
 * 変わった文書だけを載せ直すとき、システムプロンプトに載っている塊と同じ見出しで
 * 指せることが前提になっている（`clone.ts` の `#withFreshMemory`）。
 */
describe('記憶の載せ方', () => {
  it('人間が開くファイル名と同じ見出しを付ける', () => {
    expect(renderMemoryDocument({ slug: 'values', content: '# 価値観\n\nあ' })).toBe(
      '<!-- memory: values.md -->\n# 価値観\n\nあ',
    );
  });

  /**
   * 末尾の空白を落とす。**落とさないと文書の境目が見た目で動く** — 人間が
   * エディタで末尾に改行を足しただけで、載せ直しの差分に出る本文が変わる。
   */
  it('末尾の空白だけを落とす（先頭と本文には触らない）', () => {
    const rendered = renderMemoryDocument({ slug: 'a', content: '\n  先頭は残す\n\n\n' });

    expect(rendered).toBe('<!-- memory: a.md -->\n\n  先頭は残す');
    expect(rendered.endsWith('先頭は残す')).toBe(true);
  });

  /**
   * **かつてここは本文（`に` / `い`）が並ぶことまで固定していた。** premise の
   * 載り方が全文からカード（要旨＋節の目次）へ変わったので（`memory.ts` の
   * `renderPremiseCard`）、本文は載らなくなった。
   *
   * **この歯が測っているのは本文ではなく「並び」である**——渡した順序のまま、
   * 文書のあいだが空行1つで区切られること。**その保証は1ミリも弱まっていない**
   * （むしろ、カードの見出しに slug が入るので並びの確認はより直接になった）。
   */
  it('文書のあいだは空行1つで、渡された順序のまま並ぶ', () => {
    const rendered = renderMemoryDocuments([
      { slug: 'b', content: '# に\n' },
      { slug: 'a', content: '# い\n' },
    ]);
    const heads = rendered.split('\n\n').map((block) => block.split('\n')[0]);

    expect(heads[0]?.startsWith('<!-- memory: b.md（premise')).toBe(true);
    expect(heads[1]?.startsWith('<!-- memory: a.md（premise')).toBe(true);
    // 区切りは空行ちょうど1つ（2つ以上でも0でもない）。
    expect(rendered.split('\n\n').length).toBe(2);
    expect(rendered).not.toContain('\n\n\n');
  });

  it('記憶が1つも無ければ空文字（「空」を言うのは呼び手の仕事である）', () => {
    expect(renderMemoryDocuments([])).toBe('');
  });
});

/**
 * `MemoryProtectionStatus` の3状態の網羅性。
 *
 * **`unknown` を `clone-only` に畳まないこと。** 判定（`memoryProtectionAllowsFullReplace`）
 * と描画（`describeMemoryProtectionStatus`）のどちらも `switch` の `default` で
 * `assertNeverMemoryProtectionStatus`（引数の型は `never`）へ渡している。
 *
 * **これが型レベルの網羅性チェックである。** 状態を1つ足すと、その `switch` の
 * どの分岐にも当たらなくなった値が `default` まで落ち、`never` へ代入できずに
 * `tsc` が落ちる——分岐を書き足し忘れたまま黙って `unknown` 側に倒れる実装を
 * 防いでいる。ここでは同じ構造の**実行時の裏付け**を確かめる: 3状態それぞれで
 * 例外を投げずに判定・描画ができること（正の保証）と、型で弾かれるはずの
 * 未知の状態が来たら `default` 節が実際に例外を投げること（負の保証。
 * 黙って何かを返して嘘をつかないことの確認）。
 */
describe('MemoryProtectionStatus の網羅性', () => {
  const ALL_STATUSES: MemoryProtectionStatus[] = [
    { kind: 'human' },
    { kind: 'clone-only' },
    { kind: 'unknown' },
  ];

  it('3状態それぞれで判定・描画が例外を投げずに返る', () => {
    for (const status of ALL_STATUSES) {
      expect(() => memoryProtectionAllowsFullReplace(status)).not.toThrow();
      expect(() => describeMemoryProtectionStatus(status)).not.toThrow();
    }
  });

  it('human / unknown は distill からの全文置換を許さず、clone-only だけ許す', () => {
    expect(memoryProtectionAllowsFullReplace({ kind: 'human' })).toBe(false);
    expect(memoryProtectionAllowsFullReplace({ kind: 'unknown' })).toBe(false);
    expect(memoryProtectionAllowsFullReplace({ kind: 'clone-only' })).toBe(true);
  });

  it('3状態それぞれが異なる一言を返す（unknown を human や clone-only に読み替えない）', () => {
    const labels = new Set(ALL_STATUSES.map((status) => describeMemoryProtectionStatus(status)));
    expect(labels.size).toBe(3);
  });

  it('未知の状態（型では弾かれるはずの値）が来たら、黙って倒れず例外を投げる', () => {
    // `as unknown as MemoryProtectionStatus` は型チェックを迂回する——ここは
    // 「実行時にここへ来たら」という if の話であって、通常の呼び出し経路では
    // 型で弾かれる（switch の default が `never` を要求するのがその強制力）。
    const unknownVariant = { kind: 'new-kind' } as unknown as MemoryProtectionStatus;

    expect(() => memoryProtectionAllowsFullReplace(unknownVariant)).toThrow();
    expect(() => describeMemoryProtectionStatus(unknownVariant)).toThrow();
  });

  it('assertNeverMemoryProtectionStatus 自体も、渡されたものを含めて例外を投げる', () => {
    const bogus = { kind: 'bogus' } as never;
    expect(() => assertNeverMemoryProtectionStatus(bogus)).toThrow(/bogus/);
  });
});

/** `deriveMemoryCreatedAtFromJournal` に渡す最小限のフェイク journal。 */
function fakeJournal(entries: JournalEntry[]): { list: () => Promise<JournalEntry[]> } {
  return { list: async () => entries };
}

/** `memory_update` の日誌エントリを1件作る（テストの意図を読みやすくする）。 */
function memoryUpdateEntry(
  slug: string,
  at: string,
  action: 'write' | 'append' | 'remove' | undefined,
): JournalEntry {
  return {
    type: 'memory_update',
    id: `id-${slug}-${at}`,
    at,
    slug,
    cause: 'clone',
    action,
    summary: 'テスト用',
  } as JournalEntry;
}

describe('MemoryCreatedAt の網羅性', () => {
  it('assertNeverMemoryCreatedAt は未知の状態を投げる', () => {
    const bogus = { kind: 'bogus' } as never;
    expect(() => assertNeverMemoryCreatedAt(bogus)).toThrow(/bogus/);
  });
});

/**
 * `deriveMemoryCreatedAtFromJournal` — 記憶の `createdAt` の根拠のひとつ。
 *
 * **唯一の根拠ではない。** 第一の出所は書き込み経路自身（fs の `#writeNow` /
 * pg の `write` と `append`）で、これはその配線より前に作られた行を埋める
 * backfill（`markCreatedAt`）が使う導出関数である（記憶の `createdAt` 対応）。
 *
 * `deriveHumanTouchedAtFromJournal` と対になるが見るものが逆——あちらは
 * `cause:'human'` に絞って**最後**（新しいほう）を残すのに対し、こちらは
 * `cause` を問わず `action:'write'` だけに絞って**最初**（古いほう）を残す。
 */
describe('deriveMemoryCreatedAtFromJournal — 日誌から createdAt の根拠を導出する', () => {
  it('その slug の最初の write の at が採られる（新しいほうが採られないこと）', async () => {
    // journal.list() は新しい順に返るので、新しい順に並べて渡す。
    const journal = fakeJournal([
      memoryUpdateEntry('notes', '2026-03-01T00:00:00.000Z', 'write'),
      memoryUpdateEntry('notes', '2026-02-01T00:00:00.000Z', 'append'),
      memoryUpdateEntry('notes', '2026-01-01T00:00:00.000Z', 'write'),
    ]);

    const result = await deriveMemoryCreatedAtFromJournal(journal);

    // 一番新しい write（3/1）でも、間の append（2/1）でもなく、
    // 一番古い write（1/1）が採られる。
    expect(result.get('notes')).toBe('2026-01-01T00:00:00.000Z');
  });

  it('action:write が無い slug は結果に含まれない（根拠が無い＝unknown の元）', async () => {
    const journal = fakeJournal([
      memoryUpdateEntry('appended-only', '2026-01-01T00:00:00.000Z', 'append'),
      memoryUpdateEntry('removed-only', '2026-01-01T00:00:00.000Z', 'remove'),
      memoryUpdateEntry('legacy', '2026-01-01T00:00:00.000Z', undefined),
    ]);

    const result = await deriveMemoryCreatedAtFromJournal(journal);

    expect(result.has('appended-only')).toBe(false);
    expect(result.has('removed-only')).toBe(false);
    expect(result.has('legacy')).toBe(false);
    expect(result.size).toBe(0);
  });

  it('日誌が空なら空の Map（根拠ゼロ件）', async () => {
    const result = await deriveMemoryCreatedAtFromJournal(fakeJournal([]));

    expect(result.size).toBe(0);
  });

  it('複数の slug を同時に扱える', async () => {
    const journal = fakeJournal([
      memoryUpdateEntry('b', '2026-02-01T00:00:00.000Z', 'write'),
      memoryUpdateEntry('a', '2026-01-15T00:00:00.000Z', 'write'),
      memoryUpdateEntry('b', '2026-01-01T00:00:00.000Z', 'write'),
    ]);

    const result = await deriveMemoryCreatedAtFromJournal(journal);

    expect(result.get('a')).toBe('2026-01-15T00:00:00.000Z');
    expect(result.get('b')).toBe('2026-01-01T00:00:00.000Z');
  });
});

// =============================================================================
// #170「目次 → 詳細（オンデマンド）＋ 階層」
// =============================================================================

/** 目次（fact）に載る1件を作る小さなヘルパー。テストの意図を読みやすくする。 */
function fact(
  slug: string,
  options: {
    title?: string;
    description?: string;
    type?: string;
    parent?: string;
    freshness?: MemoryDescriptionFreshness;
    extraFrontmatter?: string;
  } = {},
): MemoryPart {
  const title = options.title ?? slug;
  const type = options.type ?? 'fact';
  const lines = ['---'];
  if (options.description !== undefined) lines.push(`description: ${options.description}`);
  lines.push(`type: ${type}`);
  if (options.parent !== undefined) lines.push(`parent: ${options.parent}`);
  if (options.extraFrontmatter !== undefined) lines.push(options.extraFrontmatter);
  lines.push('---');
  lines.push(`# ${title}`);
  lines.push('本文の詳細（目次からは開けない）');
  return {
    slug,
    title,
    content: lines.join('\n'),
    descriptionFreshness: options.freshness ?? { kind: 'unknown' },
  };
}

function premise(slug: string, body = '本文'): MemoryPart {
  return { slug, content: `# ${slug}\n${body}` };
}

/**
 * 節数 `n`・見出し長 `headingLength` の premise を作る（frontmatter 無し＝
 * 既定で premise。`resolveMemoryDocKind` の doc）。
 *
 * **`measurePremiseOutlineFit` / `MemoryFloor.outlineSaturatedPremise` /
 * `describeMemoryFloor` の A/B/C の歯が共有する**——1文書あたりの目次の
 * 予算に対する飽和・非飽和を、節数だけで作り分けられるようにするための
 * 器である。
 */
function manySectionPremise(slug: string, n: number, headingLength = 40): MemoryPart {
  const heading = (i: number) => `${'あ'.repeat(headingLength)}${String(i).padStart(4, '0')}`;
  const body = Array.from({ length: n }, (_, i) => `# ${heading(i)}\n本文`).join('\n');
  return { slug, content: body };
}

describe('frontmatter の解釈（parseMemoryFrontmatter）— 3状態、畳まない', () => {
  it('先頭が `---` でなければ none', () => {
    expect(parseMemoryFrontmatter('# 価値観\n\n本文')).toEqual({ kind: 'none' });
    expect(parseMemoryFrontmatter('')).toEqual({ kind: 'none' });
  });

  it('閉じの `---` が無ければ malformed', () => {
    expect(parseMemoryFrontmatter('---\ndescription: x\n# 見出し')).toEqual({
      kind: 'malformed',
    });
  });

  it('未知のキーがあれば malformed', () => {
    expect(parseMemoryFrontmatter('---\nauthor: someone\n---\n# T')).toEqual({
      kind: 'malformed',
    });
  });

  it('`key: value` の形から外れた行（コロンが無い）があれば malformed', () => {
    expect(parseMemoryFrontmatter('---\njust text\n---\n# T')).toEqual({ kind: 'malformed' });
  });

  it('既知のキー（description / type / parent）だけなら parsed。値は文字列のまま', () => {
    expect(
      parseMemoryFrontmatter('---\ndescription: 要旨\ntype: fact\nparent: p\n---\n# T\n本文'),
    ).toEqual({ kind: 'parsed', description: '要旨', type: 'fact', parent: 'p' });
  });

  it('値は型推論しない（`type: no` は文字列 "no" のまま。false にしない）', () => {
    const parsed = parseMemoryFrontmatter('---\ntype: no\n---\n# T');
    expect(parsed).toEqual({ kind: 'parsed', type: 'no' });
  });

  it('一部のキーだけでも parsed になる（description のみ、type のみ）', () => {
    expect(parseMemoryFrontmatter('---\ndescription: 要旨だけ\n---\n# T')).toEqual({
      kind: 'parsed',
      description: '要旨だけ',
    });
  });
});

/**
 * `applyMemoryFrontmatterPatch` — #318 案 (a) の中核。
 *
 * **本文が1バイトも変わらないことを、複数見出しを持つ長い本文で確かめる**
 * （マネージャーの指定どおり）。ここが崩れると「本文がツール呼び出しの中に
 * 一度も現れない」という性質（`memory_frontmatter_set` の存在理由そのもの）
 * が壊れる。
 */
describe('applyMemoryFrontmatterPatch — frontmatter のキーだけを差し替える。本文には触れない', () => {
  const longBody = [
    '# 価値観',
    '',
    '## 判断の基準',
    '',
    '本文1行目。',
    '本文2行目。',
    '',
    '## 好み',
    '',
    '- 箇条書き1',
    '- 箇条書き2',
    '',
    '### 細目',
    '',
    '最後の段落。複数行の\n本文が続く。',
  ].join('\n');

  it('frontmatter が無い（none）文書には、先頭に新しく作って足す。本文は無傷', () => {
    const next = applyMemoryFrontmatterPatch(longBody, { description: '新しい要旨' });
    expect(next).toBe(`---\ndescription: 新しい要旨\n---\n${longBody}`);
    // 本文がそのまま、1文字も変わらずに残っている。
    expect(next.endsWith(longBody)).toBe(true);
  });

  it('type を渡さなければ、none の文書は premise のまま（載り方は変わらない）', () => {
    const next = applyMemoryFrontmatterPatch(longBody, { description: '要旨' });
    expect(resolveMemoryDocKind(parseMemoryFrontmatter(next))).toBe('premise');
  });

  it('parsed の文書は、渡したキーだけを差し替え、渡さなかったキーは既存のまま残す', () => {
    const original = `---\ndescription: 古い要旨\ntype: fact\nparent: root\n---\n${longBody}`;
    const next = applyMemoryFrontmatterPatch(original, { description: '新しい要旨' });
    expect(parseMemoryFrontmatter(next)).toEqual({
      kind: 'parsed',
      description: '新しい要旨',
      type: 'fact',
      parent: 'root',
    });
  });

  it('本文は1バイトも変わらない（見出しを複数持つ長い本文で確かめる）', () => {
    const original = `---\ndescription: 古い要旨\ntype: premise\n---\n${longBody}`;
    const next = applyMemoryFrontmatterPatch(original, { type: 'fact' });
    const body = next.split('\n').slice(4).join('\n'); // 3行の frontmatter + 閉じの --- の次から
    expect(body).toBe(longBody);
  });

  it('3キー全部を同時に差し替えられる', () => {
    const original = `---\ndescription: 古\ntype: premise\nparent: old-parent\n---\n${longBody}`;
    const next = applyMemoryFrontmatterPatch(original, {
      description: '新',
      type: 'fact',
      parent: 'new-parent',
    });
    expect(parseMemoryFrontmatter(next)).toEqual({
      kind: 'parsed',
      description: '新',
      type: 'fact',
      parent: 'new-parent',
    });
  });

  it('malformed には例外を投げる（呼び手が先に断ること）', () => {
    const malformed = '---\nno colon here\n---\n本文';
    expect(parseMemoryFrontmatter(malformed)).toEqual({ kind: 'malformed' });
    expect(() => applyMemoryFrontmatterPatch(malformed, { description: 'x' })).toThrow();
  });

  /**
   * 本文が空（frontmatter だけ）の文書（#354 のコメント）。
   *
   * **ここを測るものが1本も無かった。** `frontmatterBody` は
   * `---\n…\n---\n` と `---\n…\n---` の両方に対して空文字を返すので、
   * **本文が空のときだけ、閉じの `---` の後ろの改行の有無が `body` から
   * 復元できない。** 実装は `content` の末尾でそれを決めている。
   *
   * **2本ある理由は、片方だけでは倒れる向きを固定できないからである** ——
   * 「改行を保つ」だけを測ると `${header}\n` を無条件で返す実装が通り、
   * 「改行を足さない」だけを測ると `header` を無条件で返す実装（#338 以降の
   * 挙動そのもの）が通る。**両方が同時に在ってはじめて、片側の1バイトを
   * もう片側の1バイトに付け替える変更が落ちる。**
   */
  describe('本文が空（frontmatter だけの文書）— 閉じの --- の後ろの改行は元のまま', () => {
    it('元が末尾に改行を持つなら、閉じの --- の後ろの改行が残る（1バイトも減らない）', () => {
      const original = '---\ndescription: 旧\n---\n';
      const next = applyMemoryFrontmatterPatch(original, { description: '新' });
      expect(next).toBe('---\ndescription: 新\n---\n');
      // 落ちていたのはこの1バイトである（#354 のコメント）。
      expect(next.endsWith('---\n')).toBe(true);
      expect(next.length).toBe(original.length);
    });

    it('元が末尾に改行を持たないなら、改行を足さない（1バイトも増えない）', () => {
      const original = '---\ndescription: 旧\n---';
      const next = applyMemoryFrontmatterPatch(original, { description: '新' });
      expect(next).toBe('---\ndescription: 新\n---');
      expect(next.endsWith('\n')).toBe(false);
      expect(next.length).toBe(original.length);
    });

    it('本文が空でも frontmatter は読み直せる（改行の扱いが形を壊していない）', () => {
      for (const original of ['---\ndescription: 旧\ntype: fact\n---\n', '---\ntype: fact\n---']) {
        const next = applyMemoryFrontmatterPatch(original, { parent: 'root' });
        expect(parseMemoryFrontmatter(next)).toMatchObject({ kind: 'parsed', parent: 'root' });
      }
    });

    it('本文が空でない側は影響を受けない（末尾の改行がそのまま残る）', () => {
      const original = `---\ndescription: 旧\n---\n${longBody}\n`;
      const next = applyMemoryFrontmatterPatch(original, { description: '新' });
      expect(next).toBe(`---\ndescription: 新\n---\n${longBody}\n`);
    });
  });
});

describe('区分の解決（resolveMemoryDocKind）— 既定は premise（4-11 の安全弁）', () => {
  it('frontmatter が無い（none）なら premise', () => {
    expect(resolveMemoryDocKind({ kind: 'none' })).toBe('premise');
  });

  it('frontmatter が壊れている（malformed）なら premise', () => {
    expect(resolveMemoryDocKind({ kind: 'malformed' })).toBe('premise');
  });

  it('type が無ければ premise', () => {
    expect(resolveMemoryDocKind({ kind: 'parsed' })).toBe('premise');
  });

  it('type が既知の集合に無い値なら premise', () => {
    expect(resolveMemoryDocKind({ kind: 'parsed', type: 'note' })).toBe('premise');
  });

  it('type: premise は premise、type: fact は fact、type: indexed は indexed', () => {
    expect(resolveMemoryDocKind({ kind: 'parsed', type: 'premise' })).toBe('premise');
    expect(resolveMemoryDocKind({ kind: 'parsed', type: 'fact' })).toBe('fact');
    expect(resolveMemoryDocKind({ kind: 'parsed', type: 'indexed' })).toBe('indexed');
  });

  /**
   * ⚠️ 安全弁の回帰確認（`indexed` を既知にした後でも壊れていないこと）。
   * `indexed` を足す前は綴り違い・大文字は無条件で premise へ倒れていた——
   * `indexed` を既知の値へ加えたことで、**未知の値の判定基準そのものが
   * 変わっていないか**を確かめる。`Indexed`（大文字）は依然として未知の
   * 値なので premise へ倒れる。
   */
  it('⚠️ indexed を追加した後も、綴り違い（大文字）は premise へ倒れる（安全弁は壊れていない）', () => {
    expect(resolveMemoryDocKind({ kind: 'parsed', type: 'Indexed' })).toBe('premise');
    expect(resolveMemoryDocKind({ kind: 'parsed', type: 'indexeds' })).toBe('premise');
  });
});

/**
 * `isKnownMemoryDocKind` — 書き込み側の入口（`memory_frontmatter_set`）が
 * 「渡された値をそのまま frontmatter へ書いてよいか」を判定するための関数。
 * `resolveMemoryDocKind` の「未知の値は premise へ倒す」読み出し側の安全弁
 * とは別の使い道である（同じ集合を共有するので、既知の値の判定そのものは
 * 一致する）。
 */
describe('isKnownMemoryDocKind — 書き込み側の入口が使う判定', () => {
  it('premise と fact と indexed は既知', () => {
    expect(isKnownMemoryDocKind('premise')).toBe(true);
    expect(isKnownMemoryDocKind('fact')).toBe(true);
    expect(isKnownMemoryDocKind('indexed')).toBe(true);
  });

  it('綴り違い・大文字・空文字・未知の語は既知ではない', () => {
    expect(isKnownMemoryDocKind('Fact')).toBe(false);
    expect(isKnownMemoryDocKind('facts')).toBe(false);
    expect(isKnownMemoryDocKind('premis')).toBe(false);
    expect(isKnownMemoryDocKind('')).toBe(false);
    expect(isKnownMemoryDocKind('note')).toBe(false);
    expect(isKnownMemoryDocKind('Indexed')).toBe(false);
    expect(isKnownMemoryDocKind('indexeds')).toBe(false);
  });
});

/**
 * `containsMemoryFrontmatterLineBreak` — `memory_frontmatter_set`（tools.ts）
 * が入口で断るために使う検査。改行を含む値を `serializeMemoryFrontmatter`
 * （1キー1行の形）へそのまま渡すと、値の続きが別の行として紛れ込む
 * （本文は失われないが、値から本文へ文字列が混ざる経路ができる）。
 */
describe('containsMemoryFrontmatterLineBreak — 改行を含む値の検出', () => {
  it('\\n を含めば true', () => {
    expect(containsMemoryFrontmatterLineBreak('a\nb')).toBe(true);
  });

  it('\\r を含めば true（\\r\\n だけでなく単独の \\r も）', () => {
    expect(containsMemoryFrontmatterLineBreak('a\rb')).toBe(true);
    expect(containsMemoryFrontmatterLineBreak('a\r\nb')).toBe(true);
  });

  it('改行を含まなければ false（--- を含む1行の値はここでは問題ない）', () => {
    expect(containsMemoryFrontmatterLineBreak('a')).toBe(false);
    expect(containsMemoryFrontmatterLineBreak('a---b')).toBe(false);
    expect(containsMemoryFrontmatterLineBreak('')).toBe(false);
  });

  /**
   * ⚠️ 差し戻しで見つかった実際の混入を再現する（回帰確認）。
   *
   * `applyMemoryFrontmatterPatch` 自体は改行を検査しない
   * （検査は呼び手＝ `memory_frontmatter_set` の入口の責務——`type` の
   * 検査と同じ設計）。ここでは「検査を挟まずに直接呼んだら何が起きるか」
   * を固定し、`containsMemoryFrontmatterLineBreak` が本当にこの形を
   * 捕まえる値を検出することを確かめる。
   */
  it('検査を挟まないまま渡すと、値の続きが本文の先頭へ紛れ込む（再現）', () => {
    const original = '---\ndescription: 古\n---\n# 見出し\n\n本文である';
    const injected = applyMemoryFrontmatterPatch(original, {
      description: 'a\n---\nb',
      type: 'fact',
    });
    expect(parseMemoryFrontmatter(injected)).toEqual({ kind: 'parsed', description: 'a' });
    // 本文そのものは失われていない（末尾に残っている）。
    expect(injected.endsWith('本文である')).toBe(true);
    // だが値の続き（'b' や 'type: fact' や '---'）が本文の先頭として紛れ込む。
    expect(injected).toContain('b\ntype: fact\n---\n# 見出し');
    // これが `containsMemoryFrontmatterLineBreak` が入口で断るべき理由である。
    expect(containsMemoryFrontmatterLineBreak('a\n---\nb')).toBe(true);
  });
});

describe('要旨の鮮度（resolveMemoryDescriptionFreshness）— 4状態、畳まない', () => {
  it('description が無ければ absent（describedAt があっても absent が勝つ）', () => {
    expect(
      resolveMemoryDescriptionFreshness({
        description: undefined,
        describedAt: '2026-08-20T00:00:00Z',
        updatedAt: '2026-08-21T00:00:00Z',
      }),
    ).toEqual({ kind: 'absent' });
  });

  it('description はあるが describedAt を持たなければ unknown', () => {
    expect(
      resolveMemoryDescriptionFreshness({
        description: '要旨',
        describedAt: undefined,
        updatedAt: '2026-08-21T00:00:00Z',
      }),
    ).toEqual({ kind: 'unknown' });
  });

  it('describedAt が updatedAt 以降なら fresh', () => {
    expect(
      resolveMemoryDescriptionFreshness({
        description: '要旨',
        describedAt: '2026-08-21T00:00:00Z',
        updatedAt: '2026-08-21T00:00:00Z',
      }),
    ).toEqual({ kind: 'fresh' });
  });

  it('describedAt が updatedAt より前なら stale（差をミリ秒で持つ、#821）', () => {
    expect(
      resolveMemoryDescriptionFreshness({
        description: '要旨',
        describedAt: '2026-08-20T00:00:00Z',
        updatedAt: '2026-08-21T00:00:00Z',
      }),
    ).toEqual({ kind: 'stale', staleForMs: 24 * 60 * 60 * 1000 });
  });

  it('stale の差は1時間と30日で別の値になる（語ではなく数で測る、#821 条件2）', () => {
    const oneHour = resolveMemoryDescriptionFreshness({
      description: '要旨',
      describedAt: '2026-08-20T00:00:00Z',
      updatedAt: '2026-08-20T01:00:00Z',
    });
    const thirtyDays = resolveMemoryDescriptionFreshness({
      description: '要旨',
      describedAt: '2026-08-01T00:00:00Z',
      updatedAt: '2026-08-31T00:00:00Z',
    });
    expect(oneHour).toEqual({ kind: 'stale', staleForMs: 60 * 60 * 1000 });
    expect(thirtyDays).toEqual({ kind: 'stale', staleForMs: 30 * 24 * 60 * 60 * 1000 });
    // 差そのものが違う値であることを直接確かめる——「stale というラベルが
    // 出た」ではなく「差が動いた」ことを見る。
    expect(oneHour.kind === 'stale' && thirtyDays.kind === 'stale').toBe(true);
    if (oneHour.kind === 'stale' && thirtyDays.kind === 'stale') {
      expect(oneHour.staleForMs).not.toBe(thirtyDays.staleForMs);
    }
  });

  /**
   * ⚠️ `stale` を決める比較（文字列の辞書式）と、差を作る比較（`Date.parse`
   * の数値）は別物である——精度（小数秒の桁数）が違う2つの ISO 8601 文字列
   * では、辞書式が「小さい」と判定した側が、数値としては後（＝大きい）で
   * ありうる。
   *
   * ここでは `describedAt = '...T10:00:00.500Z'`（小数点あり）・
   * `updatedAt = '...T10:00:00Z'`（小数点なし）を渡す。辞書式では `'.'`
   * （0x2E）が `'Z'`（0x5A）より小さいので `describedAt < updatedAt` が
   * 真になり `stale` へ入るが、数値としては `describedAt` の方が500ミリ秒
   * 後（＝大きい）——clamp が無ければ `staleForMs` は `-500` になる。
   *
   * **`Math.max(0, ...)` を外す変異（マネージャー指摘、条件1の直接の歯）は
   * ここで捕まる。** 負の値が「0（＝最新）」以外の意味を持ってはいけない
   * ——このテストは「0になる」ことそのものを固定する（負のまま漏れる／
   * NaN になる、のどちらでもないことを確かめる）。
   */
  it('精度違いで辞書式と数値の順序が食い違っても、staleForMs は負にならない（0 に丸める）', () => {
    const result = resolveMemoryDescriptionFreshness({
      description: '要旨',
      describedAt: '2026-09-11T10:00:00.500Z',
      updatedAt: '2026-09-11T10:00:00Z',
    });
    expect(result).toEqual({ kind: 'stale', staleForMs: 0 });
  });

  it('assertNeverMemoryDescriptionFreshness は未知の状態を投げる', () => {
    const bogus = { kind: 'bogus' } as never;
    expect(() => assertNeverMemoryDescriptionFreshness(bogus)).toThrow(/bogus/);
  });

  it('assertNeverMemoryFrontmatterState は未知の状態を投げる', () => {
    const bogus = { kind: 'bogus' } as never;
    expect(() => assertNeverMemoryFrontmatterState(bogus)).toThrow(/bogus/);
  });
});

describe('deriveMemoryFrontmatter — fs / pg が list() / read() / documents() で共通に使う唯一の実装', () => {
  it('none の文書は premise・description 無し・absent', () => {
    const derived = deriveMemoryFrontmatter({
      content: '# 価値観\n本文',
      updatedAt: '2026-08-21T00:00:00Z',
      describedAt: undefined,
    });
    expect(derived.frontmatter).toEqual({ kind: 'none' });
    expect(derived.kind).toBe('premise');
    expect(derived.description).toBeUndefined();
    expect(derived.descriptionFreshness).toEqual({ kind: 'absent' });
  });

  it('fact かつ describedAt が updatedAt 以降なら fresh を返す', () => {
    const derived = deriveMemoryFrontmatter({
      content: '---\ndescription: 要旨\ntype: fact\n---\n# T\n本文',
      updatedAt: '2026-08-21T00:00:00Z',
      describedAt: '2026-08-21T00:00:00Z',
    });
    expect(derived.kind).toBe('fact');
    expect(derived.description).toBe('要旨');
    expect(derived.descriptionFreshness).toEqual({ kind: 'fresh' });
  });
});

describe('nextDescribedAt — 書き手は書けない。store が新旧の description を比べて進める（4-3）', () => {
  it('description が変わっていなければ据え置く', () => {
    const result = nextDescribedAt({
      priorContent: '---\ndescription: 同じ\n---\n# T\n旧本文',
      nextContent: '---\ndescription: 同じ\n---\n# T\n新本文（本文だけ変えた）',
      priorDescribedAt: '2026-08-01T00:00:00Z',
      writtenAt: '2026-08-21T00:00:00Z',
    });
    expect(result).toBe('2026-08-01T00:00:00Z');
  });

  it('description が変わっていれば、渡された writtenAt へ進める', () => {
    const result = nextDescribedAt({
      priorContent: '---\ndescription: 旧\n---\n# T\n本文',
      nextContent: '---\ndescription: 新\n---\n# T\n本文',
      priorDescribedAt: '2026-08-01T00:00:00Z',
      writtenAt: '2026-08-21T00:00:00Z',
    });
    expect(result).toBe('2026-08-21T00:00:00Z');
  });

  it('新規作成（priorContent が null）で description が付けば、changed 扱いになる', () => {
    const result = nextDescribedAt({
      priorContent: null,
      nextContent: '---\ndescription: 初めての要旨\n---\n# T\n本文',
      priorDescribedAt: undefined,
      writtenAt: '2026-08-21T00:00:00Z',
    });
    expect(result).toBe('2026-08-21T00:00:00Z');
  });

  it('書いた直後は describedAt === updatedAt になるので、直後の読み出しは必ず fresh', () => {
    const writtenAt = '2026-08-21T00:00:00Z';
    const describedAt = nextDescribedAt({
      priorContent: '---\ndescription: 旧\n---\n# T\n本文',
      nextContent: '---\ndescription: 新\n---\n# T\n本文',
      priorDescribedAt: '2026-08-01T00:00:00Z',
      writtenAt,
    });
    expect(
      resolveMemoryDescriptionFreshness({ description: '新', describedAt, updatedAt: writtenAt }),
    ).toEqual({ kind: 'fresh' });
  });
});

/**
 * `renderMemoryDocuments` — 区分ごとの載り方（B の表）と、5つの受け入れ基準
 * （二重に載せない・取りこぼさない・切ったら言う・古い要旨は消えない・
 * 4状態を畳まない）。**「該当0件」だけを根拠にするテストは書かない** ——
 * 切る/切らない、載せる/載せない、それぞれを別の `it()` で測る。
 */
describe('renderMemoryDocuments — 区分ごとの載り方と、目次→詳細の受け入れ基準', () => {
  /**
   * **⚠️ かつてここは「frontmatter を1つも持たない文書の集合に対して、焼き込みが
   * frontmatter 導入前と1バイトも変わらない」という受け入れ基準だった。**
   * 人間が 2026-09-08 に載せ方そのものを反転させた（premise は全文からカードへ）
   * ので、**その基準は意味を失った**——旧実装（`renderMemoryDocument` の全文）と
   * 一致しないことが正しい。
   *
   * **消さずに反転させる。** 測る対象は変えていない（frontmatter を1つも持たない
   * 文書がどう扱われるか）。**変わったのは「premise として扱われた結果どう載るか」
   * だけであり、区分の既定（frontmatter 無し ＝ premise）は1ミリも動いていない**
   * ——それをここで固定する。
   */
  it('【区分の既定】frontmatter を1つも持たない文書は premise として扱われる（載り方はカード）', () => {
    const docs = [premise('b', 'に'), premise('a', 'い')];
    const rendered = renderMemoryDocuments(docs);

    // premise の枝を通っている（fact の目次側には出ない）。
    expect(rendered).toContain('<!-- memory: b.md（premise');
    expect(rendered).toContain('<!-- memory: a.md（premise');
    expect(rendered).not.toContain('## 記憶の目次');
    // そして旧実装（全文）とは一致しない——これが反転そのものである。
    expect(rendered).not.toBe(docs.map(renderMemoryDocument).join('\n\n'));
  });

  /**
   * **⚠️ かつてここは「premise（区分無し）は全文が載る」だった。** 反転の本体で
   * ある（人間の決定 2026-09-08）。**保証は弱くなっていない**——「本文が載る」を
   * 「本文が載らず、代わりに要旨と節の目次が載る」へ言い換えたうえで、
   * **本文が載っていないことを明示的に測る**（消していない）。
   */
  it('premise（区分無し）はカード（要旨＋節の目次）が載り、本文は1文字も載らない', () => {
    const rendered = renderMemoryDocuments([
      { slug: 'values', content: '# 価値観\n大事にしていること' },
    ]);
    expect(rendered).toContain('<!-- memory: values.md（premise');
    // 見出しは載る（何が書いてあるかは分かる）。
    expect(rendered).toContain('# 価値観');
    // 本文は載らない。
    expect(rendered).not.toContain('大事にしていること');
    // 開く口を名指ししている（載せないことを能力の削除にしないための条件）。
    expect(rendered).toContain('memory_section_read');
  });

  it('fact は目次の1行だけが載り、本文は載らない（memory_read で開く前提）', () => {
    const rendered = renderMemoryDocuments([
      fact('runbook', {
        title: '定点観測',
        description: '費用の推移',
        freshness: { kind: 'fresh' },
      }),
    ]);
    expect(rendered).toContain('runbook: 定点観測');
    expect(rendered).toContain('費用の推移');
    expect(rendered).not.toContain('本文の詳細（目次からは開けない）');
  });

  it('二重に載せない: premise がカードで載っているとき、同じ文書が目次側にも出ない', () => {
    const docs = [
      premise('p1', '前提の本文'),
      fact('f1', { title: 'F1', description: '要旨', freshness: { kind: 'fresh' } }),
    ];
    const rendered = renderMemoryDocuments(docs);

    // premise のカードは1回だけ載る（載り方が全文からカードへ変わっただけで、
    // 「どの文書もどちらか一方に必ず1回だけ現れる」という不変条件は同じ）。
    const occurrences = rendered.split('<!-- memory: p1.md（premise').length - 1;
    expect(occurrences).toBe(1);
    expect(rendered).not.toContain('- p1:');
    // fact の本文（見出し以降の詳細）はどこにも出ない。
    expect(rendered).not.toContain('本文の詳細（目次からは開けない）');
    expect(rendered).toContain('- f1: F1');
  });

  it('取りこぼさない: documents() の件数 == 全文で載った件数 + 目次に出た件数', () => {
    const docs = [
      premise('premise-a'),
      premise('premise-b'),
      fact('fact-a', { description: '要旨a', freshness: { kind: 'fresh' } }),
      fact('fact-b', { description: '要旨b', freshness: { kind: 'stale', staleForMs: 1000 } }),
      fact('malformed-parent-ignored', {
        description: '要旨c',
        freshness: { kind: 'unknown' },
        parent: 'nope',
      }),
    ];
    const rendered = renderMemoryDocuments(docs);

    // premise はカードの見出しで、fact は目次の1行で数える（載り方が変わっても
    // 「どちらか一方に必ず1回だけ現れる」は同じ不変条件である）。
    const cardCount = (rendered.match(/<!-- memory: [\w-]+\.md（premise/g) ?? []).length;
    const tocCount = docs.filter((doc) => rendered.includes(`- ${doc.slug}:`)).length;
    expect(cardCount + tocCount).toBe(docs.length);
  });

  it('切ったら言う: 目次を件数で切ったら、切った件数が出力に現れる', () => {
    // **freshness は absent を使う（#821 以降の約束）。** ここで測りたいのは
    // 件数の蓋であって鮮度ではない——absent なら印が空文字になり、
    // 鮮度の印を足す前の（1行の長さが description だけで決まる）行を保てる。
    // fresh 等を使うと印の文字数ぶん1行が伸び、この it() が固定している
    // 件数（300／5）が崩れる。
    const docs = Array.from({ length: MEMORY_TOC_ENTRY_LIMIT + 5 }, (_, index) =>
      fact(`fact-${index}`, { description: `要旨${index}`, freshness: { kind: 'absent' } }),
    );
    const rendered = renderMemoryDocuments(docs);
    expect(rendered).toContain('…ほか 5 件は目次から省略');
    // 記憶の全体を渡す呼び手（`presentInMemory` 無し）は従来どおりの文言のまま
    // ——「今回載せた分だけである」という限定は付かない。
    expect(rendered).toContain(
      `…ほか 5 件は目次から省略（目次の対象は全 ${MEMORY_TOC_ENTRY_LIMIT + 5} 件）。`,
    );
    expect(rendered).not.toContain('今回載せた分だけである');
  });

  /**
   * ⭐ 3（軽い）: 部分だけを描く呼び手（`clone.ts` の `#withFreshMemory` を模す）
   * の下では、省略行の文言が変わる。
   *
   * **「部分か」の判定は `presentInMemory` の有無ではなく、この描画に出ている
   * slug で記憶の全体を覆えているかで決める**（`tocEntriesCoverWholeMemory`
   * の doc）——ここでは `presentInMemory` に、描画に出ていない文書
   * （`outside-doc`）をもう1件足すことで「覆えていない」状態を作る。
   *
   * **値は `MEMORY_TOC_ENTRY_LIMIT` を書き写さず参照する**（依頼者の門）。
   */
  it('⭐ 部分だけを描く呼び手の下では、省略行が「記憶の全体ではなく、今回載せた分だけ」と明言する', () => {
    // freshness は absent（件数の蓋を測るための行の長さを、鮮度の印の分だけ
    // 伸ばさないため。上の it() と同じ理由、#821）。
    const docs = Array.from({ length: MEMORY_TOC_ENTRY_LIMIT + 5 }, (_, index) =>
      fact(`fact-${index}`, { description: `要旨${index}`, freshness: { kind: 'absent' } }),
    );
    const outsideDoc = fact('outside-doc', { description: '外', freshness: { kind: 'absent' } });
    const rendered = renderMemoryDocuments(docs, { presentInMemory: [...docs, outsideDoc] });

    expect(rendered).toContain(
      `…ほか 5 件は目次から省略（この目次に並べたのは全 ${MEMORY_TOC_ENTRY_LIMIT + 5} 件。` +
        '記憶の全体ではなく、今回載せた分だけである）。',
    );
    expect(rendered).not.toContain(`目次の対象は全 ${MEMORY_TOC_ENTRY_LIMIT + 5} 件）。`);
  });

  /**
   * 対照。`presentInMemory` を渡していても、この描画（`entries`）だけで記憶の
   * 全体を覆えているなら——たとえば `#withFreshMemory` の差分にたまたま記憶の
   * 全件が含まれた回——**従来どおりの文言のまま**である。判定が
   * `presentInMemory` の「有無」ではなく「覆えているか」であることの直接の歯。
   */
  it('presentInMemory を渡していても、この描画が記憶の全体を覆っていれば従来どおりの文言のまま', () => {
    // freshness は absent（同上の理由、#821）。
    const docs = Array.from({ length: MEMORY_TOC_ENTRY_LIMIT + 5 }, (_, index) =>
      fact(`fact-${index}`, { description: `要旨${index}`, freshness: { kind: 'absent' } }),
    );
    const rendered = renderMemoryDocuments(docs, { presentInMemory: docs });

    expect(rendered).toContain(
      `…ほか 5 件は目次から省略（目次の対象は全 ${MEMORY_TOC_ENTRY_LIMIT + 5} 件）。`,
    );
    expect(rendered).not.toContain('今回載せた分だけである');
  });

  /**
   * ⭐⭐⭐ 目次の蓋は件数（`MEMORY_TOC_ENTRY_LIMIT`）と文字数
   * （`MEMORY_TOC_CHAR_BUDGET`）の2軸を持つ——依頼者の求めで、**どちらで
   * 切ったかを断り書きが名乗る**。3状態（件数のみ／文字数のみ／両方）を
   * それぞれ非自明な入力で作り分ける（`.claude/skills/mutation-testing/`
   * 「歯は非自明な状況で当てる」と同じ理由——余裕のある入力では分岐に
   * 入らない）。
   *
   * `tocEntriesCoverWholeMemory` の既存の区別（「目次の対象は全 N 件」／
   * 「この目次に並べたのは全 N 件…」）は、この節ではどちらも記憶の全体を
   * 渡しているので前者のまま——**切った理由の文言と独立に組み合わさる**
   * ことは、この3つの it() が同じ scope 文言を共有しつつ cause 文言だけが
   * 変わることで示される。
   */
  describe('目次の蓋: 件数のみ／文字数のみ／両方を、非自明な入力で作り分ける', () => {
    it('件数のみで切れる（305件・短い要旨——文字数の予算にはまだ余裕がある）', () => {
      // freshness は absent（鮮度の印の分だけ1行が伸びると、この it() が
      // 前提にしている「300件ぶんの短い要旨は文字数の予算に収まる」が崩れる。
      // #821 以降、fresh も印を持つため、この it() の関心（件数の蓋）とは
      // 無関係な理由で分岐が変わってしまう）。
      const docs = Array.from({ length: MEMORY_TOC_ENTRY_LIMIT + 5 }, (_, i) =>
        fact(`fact-${String(i).padStart(3, '0')}`, {
          description: 'x'.repeat(10),
          freshness: { kind: 'absent' },
        }),
      );
      const rendered = renderMemoryDocuments(docs);

      // 前提: 本当に「件数のみ」で切れている（300件ぶんの短い要旨は
      // 文字数の予算に収まる）。前提が壊れていたらこの it() は違う分岐を
      // 測ってしまう。
      expect(rendered.match(/^- fact-/gm)?.length).toBe(MEMORY_TOC_ENTRY_LIMIT);
      expect(rendered).toContain(
        `…ほか 5 件は目次から省略（目次の対象は全 ${MEMORY_TOC_ENTRY_LIMIT + 5} 件）。`,
      );
      expect(rendered).toContain(
        `${MEMORY_TOC_ENTRY_LIMIT} 件の上限に当たって件数で切った（文字数の予算 ` +
          `${MEMORY_TOC_CHAR_BUDGET.toLocaleString('en-US')} 文字にはまだ余裕がある）。`,
      );
      // 3状態を混ぜない: 他の2状態の言い回しを含まない。
      expect(rendered).not.toContain('文字に当たって文字数で切った');
      expect(rendered).not.toContain('の両方に当たって切った');
      // 件数のみで切れているときは、実行できない助言（fact を減らせ、に類する
      // 越権の助言）を出さない。
      expect(rendered).not.toContain('memory_frontmatter_set で短くする');
      // 存在そのものが見えなくなる、という非対称は3状態どれでも必ず出る。
      expect(rendered).toContain(
        'fact 文書が存在することを毎ターンの焼き込みの中で名乗る唯一の場所',
      );
      expect(rendered).toContain(
        '省かれた 5 件は、この焼き込みの中では存在しないのと見分けが付かない。',
      );
    });

    it('文字数のみで切れる（100件・要旨が1行の上限いっぱい——件数は300件の上限の下）', () => {
      const docs = Array.from({ length: 100 }, (_, i) =>
        fact(`fact-${String(i).padStart(3, '0')}`, {
          description: 'あ'.repeat(MEMORY_TOC_LINE_LIMIT),
          freshness: { kind: 'fresh' },
        }),
      );
      const rendered = renderMemoryDocuments(docs);

      // 前提: 本当に「文字数のみ」で切れている（件数は100件で300件の上限の
      // 遥か下だが、要旨が長いので束ねた総量が予算を超える）。
      const shownCount = rendered.match(/^- fact-/gm)?.length ?? 0;
      expect(shownCount).toBeGreaterThan(0);
      expect(shownCount).toBeLessThan(100);
      expect(rendered).toContain('…ほか');
      expect(rendered).toContain('目次から省略（目次の対象は全 100 件）。');
      expect(rendered).toContain(
        `文字数の予算 ${MEMORY_TOC_CHAR_BUDGET.toLocaleString('en-US')} 文字に当たって文字数で切った` +
          `（件数は ${MEMORY_TOC_ENTRY_LIMIT} 件の上限の下——要旨が長い文書が多い）。`,
      );
      expect(rendered).not.toContain('件の上限に当たって件数で切った');
      expect(rendered).not.toContain('の両方に当たって切った');
      // 文字数で切れているときは、実行できる直し方（要旨を短くする）を出す。
      expect(rendered).toContain(
        '要旨（description）が長い文書は memory_frontmatter_set で短くすると、同じ件数でもここに多く載る。',
      );
      expect(rendered).toContain(
        'fact 文書が存在することを毎ターンの焼き込みの中で名乗る唯一の場所',
      );
    });

    it('両方に当たる（320件・要旨が1行の上限いっぱい——件数の上限を超え、なお300件ぶんが文字数の予算も超える）', () => {
      const docs = Array.from({ length: MEMORY_TOC_ENTRY_LIMIT + 20 }, (_, i) =>
        fact(`fact-${String(i).padStart(3, '0')}`, {
          description: 'あ'.repeat(MEMORY_TOC_LINE_LIMIT),
          freshness: { kind: 'fresh' },
        }),
      );
      const rendered = renderMemoryDocuments(docs);

      // 前提: 本当に「両方」に当たっている——件数の上限（300）を超えており、
      // かつ件数で切った後の300件ぶんの要旨だけでも文字数の予算を超えるので、
      // 実際に載る件数は300件よりさらに少ない。
      const shownCount = rendered.match(/^- fact-/gm)?.length ?? 0;
      expect(shownCount).toBeGreaterThan(0);
      expect(shownCount).toBeLessThan(MEMORY_TOC_ENTRY_LIMIT);
      expect(rendered).toContain(
        `目次から省略（目次の対象は全 ${MEMORY_TOC_ENTRY_LIMIT + 20} 件）。`,
      );
      expect(rendered).toContain(
        `件数（${MEMORY_TOC_ENTRY_LIMIT} 件の上限）と文字数（予算 ` +
          `${MEMORY_TOC_CHAR_BUDGET.toLocaleString('en-US')} 文字）の両方に当たって切った。`,
      );
      expect(rendered).not.toContain('件の上限に当たって件数で切った');
      expect(rendered).not.toContain('文字に当たって文字数で切った');
      expect(rendered).toContain(
        'fact 文書が存在することを毎ターンの焼き込みの中で名乗る唯一の場所',
      );
    });

    /**
     * ⭐⭐⭐⭐ 2つの蓋は「件数で切ってから、その残りに文字数の蓋を掛ける」
     * 順でなければならない——逆（束ねた全体に先に文字数の蓋を掛けてから
     * 件数で切る）だと、**表示される件数は変わらないのに、切った理由の
     * 名乗りだけが誤る**（依頼者の求め。2つの蓋が独立に効いているかを、
     * 順序を意識しない入力では測れない——上の3つの it() はどれも「先頭
     * 300件だけで文字数の判定が決まる」形なので、この非自明な境界を通らない）。
     *
     * 入力: 先頭300件は要旨なし（束ねて 8,849字相当、予算に対して大きな
     * 余裕を残す）。末尾20件は要旨が1行の上限いっぱい（長い）。**320件を
     * 束ねた総量は予算を超えるが、件数で切った後の先頭300件だけなら予算に
     * 大きく収まる。** ⟹ 正しい実装は「件数のみ」を名乗る（末尾20件は
     * 件数の上限だけで丸ごと落ちるので、文字数の判定にすら入らない）。
     * もし文字数の蓋を束ねた全体（320件）に対して先に評価する実装だと、
     * 末尾の長い行の一部が「予算を圧迫した」と誤って判定し、**表示件数は
     * 300件のまま変わらないのに**「両方」を誤って名乗る。
     */
    it('⭐ 順序が結果を変える境界（先頭300件は予算に大きな余裕、320件束ねると予算超過——正しくは「件数のみ」）', () => {
      const shortDocs = Array.from({ length: MEMORY_TOC_ENTRY_LIMIT }, (_, i) =>
        fact(`fact-${String(i).padStart(3, '0')}`, { freshness: { kind: 'absent' } }),
      );
      const longDocs = Array.from({ length: 20 }, (_, i) =>
        fact(`zzz-${String(i).padStart(3, '0')}`, {
          description: 'あ'.repeat(MEMORY_TOC_LINE_LIMIT),
          freshness: { kind: 'fresh' },
        }),
      );
      const rendered = renderMemoryDocuments([...shortDocs, ...longDocs]);

      // 前提: 表示件数はちょうど300件（先頭の要旨なし文書だけ）で、末尾の
      // 長い20件は1件も表示に混ざらない——文字数の判定が「先頭300件だけ」で
      // 決まっていることの直接の確認。
      const shownCount = rendered.match(/^- (fact|zzz)-/gm)?.length ?? 0;
      expect(shownCount).toBe(MEMORY_TOC_ENTRY_LIMIT);
      expect(rendered).not.toMatch(/^- zzz-/m);

      expect(rendered).toContain(
        `${MEMORY_TOC_ENTRY_LIMIT} 件の上限に当たって件数で切った（文字数の予算 ` +
          `${MEMORY_TOC_CHAR_BUDGET.toLocaleString('en-US')} 文字にはまだ余裕がある）。`,
      );
      expect(rendered).not.toContain('の両方に当たって切った');
      expect(rendered).not.toContain('文字に当たって文字数で切った');
    });
  });

  /**
   * 目次の蓋（`MEMORY_TOC_CHAR_BUDGET`）を測るための1件。**要旨は1行の上限
   * ちょうど**（`MEMORY_TOC_LINE_LIMIT`）——1行が運ぶ量を最大にした、蓋が
   * 確実に噛む形である。
   *
   * **freshness は absent（#821 以降の約束）。** ここで測りたいのは文字数の
   * 蓋の算術であって鮮度ではない——`fresh` を使うと鮮度の印の文字数ぶん
   * 1行が伸び、この関数が使う下の2つの it()（測る側とその外挿）の数値が
   * 鮮度の印の実装に引きずられて動いてしまう。
   */
  const tocCapFact = (index: number) =>
    fact(`fact-${String(index).padStart(3, '0')}`, {
      description: 'あ'.repeat(MEMORY_TOC_LINE_LIMIT),
      freshness: { kind: 'absent' },
    });

  /**
   * 候補行1本ぶんの限界費用を、**手で書式を真似ずに実測する。** 同じ長さの
   * 要旨を持つ2件・1件のレンダリング結果の差分が「1行＋区切りの改行」ぶんで
   * ある——`renderMemoryTocLine` の内部の書式（インデント・鮮度の印・区切り
   * 文字）を書き写すと、書式が変わったときにここだけが古くなる（テストの
   * 構造が実装の複製にならないようにする）。
   */
  const measureTocMarginalCost = () => {
    const one = renderMemoryDocuments([tocCapFact(0)]);
    const two = renderMemoryDocuments([tocCapFact(0), tocCapFact(1)]);
    return { one, two, marginal: two.length - one.length };
  };

  /**
   * 目次の断り書き（`renderMemoryTocOmission`）の1行目の頭。**逐語で持つ**
   * ——定数を import して両側を一緒に動かす形にしない（#747 の作法。同じ
   * ファイルの `⭐ memory.ts の中で 8,000 を持つ MEMORY_*_BUDGET 定数を、
   * 断り書きが漏れなく名指しする` の doc）。
   */
  const TOC_OMISSION_NOTE_HEAD = '…ほか ';

  /**
   * ⭐⭐⭐ 穴の実在。**緩くてよい歯である**——ここで測りたいのは「蓋が
   * 無ければ束ねた総量が桁で溢れていた」という事実だけで、締めても意味が
   * 増えない。
   *
   * **`60_000` を直書きしない。** `MEMORY_TOC_ENTRY_LIMIT * MEMORY_TOC_LINE_LIMIT`
   * から出す（依頼者の求め。既存の歯の作法——値を書き写さず参照する）。
   *
   * **⚠️ この主張は、かつて次の it()（修理の実在）と1本の it() に同居して
   * いた。** 同居させたせいで、緩くてよいこちら側に合わせた `+ 1_000` という
   * 丸い遊びが、締まっていないと意味が無い側の上界に入り込んでいた——実測
   * （base `139c7aa`）で1行の限界費用は 224 字なので、`1000 / 224 = 4.46`
   * ⟹ **予算を3行ぶん（672字、予算の 5.6%）恒常的に超過しても、どの歯も
   * 落ちなかった**（+1/+2/+3 が生存し、+4 で初めてこの歯が落ちた）。
   * **だから2本に割ってある。** 割った理由そのものが、この doc の要点である
   * ——1本の歯が「穴が在った」と「修理が効いている」を両方主張すると、遊びは
   * 必ず緩い側に合わせられる。
   */
  it('⭐⭐⭐ 穴の実在: 蓋が無ければ、束ねた候補行は 300件 × 1行200字 の下限を超えて伸びる', () => {
    const { one, two, marginal } = measureTocMarginalCost();
    // 前提: この2件はどちらの蓋にも掛かっていない（2件だけなので省略が
    // 出ない）——外挿の材料が「蓋が効く前」の値であることを確かめる。
    expect(one).not.toContain('省略');
    expect(two).not.toContain('省略');

    const extrapolatedCandidateTotal = one.length + (MEMORY_TOC_ENTRY_LIMIT - 1) * marginal;

    // 蓋が無ければ、300件ぶんの候補行はこの下限を超えて伸びる（実際の外挿値は
    // これよりさらに大きい——各行は要旨だけでなく slug・title・インデントも
    // 運ぶため）。
    const preCapFloor = MEMORY_TOC_ENTRY_LIMIT * MEMORY_TOC_LINE_LIMIT;
    expect(extrapolatedCandidateTotal).toBeGreaterThan(preCapFloor);
  });

  /**
   * ⭐⭐⭐ 修理の実在。**こちらは締まっていないと意味が無い歯である。**
   *
   * ## 遊びの大きさを決めるのは断り書きであって、書き手ではない
   *
   * 出力が `MEMORY_TOC_CHAR_BUDGET` を超えてよい理由は1つしかない——
   * `renderListing`（`excerpt.ts`）が予算で締めるのは**目次の項目行だけ**で、
   * 切ったときの断り書き（`renderMemoryTocOmission`）はその上に載るからである。
   * ⟹ **だから上界の第2項は、丸い数字ではなく「この出力に実際に載った断り
   * 書きの長さ」である。** 断り書きの文言が伸び縮みすれば上界も同じだけ動く
   * ので、遊びの大きさに書き手の裁量は1文字も残らない。
   *
   * ## 何を捕まえるか（実測。base `139c7aa`、合成入力のみ）
   *
   * `renderMemoryToc` の `candidateLines.slice(0, charBudgetInfo.shown)` を
   * `… + N)` へ変異させる（＝予算より N 行多く出す）と、**N=1 で落ちる。**
   * 1行の限界費用は 224 字、この上界の余裕は 58 字である。
   *
   * ## ⚠️ この歯が測っていないこと
   *
   * - **予算より少なく出す側（`… - 1`）は捕まえない。** これは上界であって、
   *   「予算を使い切っている」ことは主張していない
   * - **断り書きの*中身*は測っていない。** 長さしか見ないので、文言が別物へ
   *   置き換わっても長さが同じならこの歯は緑のままである（中身は上の3状態の
   *   it() が逐語で持つ）
   * - **項目行のほかにも予算の上に載るものが在る**——見出し2行
   *   （`<!-- memory: index -->` と `## 記憶の目次…`）と、行を繋ぐ改行である
   *   （実測 123 字）。この上界がそれでも成り立つのは、`renderListing` が
   *   予算を使い切らずに止まるため（実測 181 字を余らせる）であって、見出しが
   *   予算の内側に在るからではない
   */
  it('⭐⭐⭐ 修理の実在: 予算を超えてよいのは断り書きぶんだけ（遊びは断り書きの実測長が決める）', () => {
    const docs = Array.from({ length: MEMORY_TOC_ENTRY_LIMIT }, (_, i) => tocCapFact(i));
    const rendered = renderMemoryDocuments(docs);
    expect(rendered).toContain('省略');

    // 上界の第2項は「この出力に実際に載った断り書き」から取る。
    const noteStart = rendered.indexOf(TOC_OMISSION_NOTE_HEAD);
    expect(noteStart).toBeGreaterThan(-1);
    const omissionNote = rendered.slice(noteStart);
    // 切り出した先に目次の項目行が混ざっていない（＝これは断り書きそのもので
    // あって、目印が項目行の中に当たったのではない）。
    expect(omissionNote).not.toMatch(/^- fact-/m);

    expect(rendered.length).toBeLessThan(MEMORY_TOC_CHAR_BUDGET + omissionNote.length);

    // 対照: この上界が「そもそも蓋が噛んでいない」ことで成り立っていない
    // ——蓋が無いときの外挿値とは桁が違う。
    const { one, marginal } = measureTocMarginalCost();
    const extrapolatedCandidateTotal = one.length + (MEMORY_TOC_ENTRY_LIMIT - 1) * marginal;
    expect(rendered.length).toBeLessThan(extrapolatedCandidateTotal / 2);
  });

  /**
   * ⭐ `MEMORY_TOC_CHAR_BUDGET` の値そのものは、どの歯にも固定されていない
   * ——歯は定数を import して期待文言を組むので、**値を動かすと期待値も一緒に
   * 動く**（自己整合）。実測（base `139c7aa`、全件）: `12_001` / `11_999` の
   * どちらへ変異させても**生存**した。
   *
   * **だからといって `expect(MEMORY_TOC_CHAR_BUDGET).toBe(12_000)` は置かない。**
   * それは実測に基づいて値を調整する正当な改善まで禁じる歯になる。**代わりに
   * 「なぜ 12,000 なのか」＝ 値の帰属と関係のほうを固定する**（手本は #747 の
   * 「8,000 を持つ別の予算が増えたら赤くなる」歯）。
   *
   * 固定するのは、`MEMORY_TOC_CHAR_BUDGET` の doc が逐語で主張している
   * 「別の数を置くことで『別の予算である』を値そのものに語らせる」である。
   * **この repo では値の共有そのものは禁じられていない**（実測: 8,000 は
   * `MEMORY_LISTING_BUDGET` と `MEMORY_OUTLINE_BUDGET` が、3,000 は
   * `MEMORY_PROMPT_DESCRIPTION_BUDGET` と `MEMORY_TIDY_TARGETS_BUDGET` が
   * 分け合っている）ので、**この歯は「一般に値を共有するな」ではなく、
   * この定数についての doc の主張だけを守っている。**
   *
   * 崩れたときにどこが赤くなるか: 誰かが 12,000 を別の `MEMORY_*_BUDGET` へ
   * 写すか、この定数を既存の値（8,000 / 6,000 …）へ揃えると `sharing` に
   * 名前が入り、`toEqual([])` が落ちる。doc の主張を書き換えるか、値を戻すまで
   * 赤いままになる。
   *
   * **⚠️ この歯が測っていないこと: 値そのものは測らない。** 12,000 → 12,001 の
   * ような、帰属も関係も壊さない変異はここでも生存する（それは意図であって
   * 見落としではない）。
   */
  it('⭐ 焼き込みの予算（MEMORY_TOC_CHAR_BUDGET）は、他のどの記憶の予算とも値を分け合わない', () => {
    const source = readFileSync(fileURLToPath(new URL('./memory.ts', import.meta.url)), 'utf8');
    const byName = new Map<string, number>();
    for (const match of source.matchAll(/export const (MEMORY_\w*_BUDGET) = ([\d_]+);/g)) {
      byName.set(match[1] as string, Number((match[2] as string).replace(/_/g, '')));
    }

    // 対照: ソースから読んだ値と import した値が同じものを指している
    // （正規表現が黙って外れていたら、下の `sharing` は常に空になる）。
    expect(byName.get('MEMORY_TOC_CHAR_BUDGET')).toBe(MEMORY_TOC_CHAR_BUDGET);

    const sharing = [...byName.entries()]
      .filter(
        ([name, value]) => name !== 'MEMORY_TOC_CHAR_BUDGET' && value === MEMORY_TOC_CHAR_BUDGET,
      )
      .map(([name]) => name)
      .sort();
    expect(sharing).toEqual([]);

    // 関係の側。**毎ターン全員が払う焼き込み**の予算なので、1回のツール応答の
    // 予算（`MEMORY_LISTING_BUDGET`）よりも、premise 1文書ぶんの節目次の予算
    // （`MEMORY_PROMPT_OUTLINE_BUDGET`）よりも大きい——束ねる対象が広い。
    expect(MEMORY_TOC_CHAR_BUDGET).toBeGreaterThan(MEMORY_LISTING_BUDGET);
    expect(MEMORY_TOC_CHAR_BUDGET).toBeGreaterThan(MEMORY_PROMPT_OUTLINE_BUDGET);
    // そして蓋が無いときの下限（300件 × 1行200字）よりは小さい——蓋として
    // 実際に噛む側に居ること。
    expect(MEMORY_TOC_CHAR_BUDGET).toBeLessThan(MEMORY_TOC_ENTRY_LIMIT * MEMORY_TOC_LINE_LIMIT);
  });

  it('切らないときは、切った件数の注記が出ない（切る/切らないは別の it() で測る）', () => {
    const docs = [fact('a'), fact('b'), fact('c')];
    const rendered = renderMemoryDocuments(docs);
    expect(rendered).not.toContain('省略');
  });

  it('古い要旨は消えない: stale な fact 文書が印つきで目次に残る', () => {
    const rendered = renderMemoryDocuments([
      fact('stale-doc', {
        title: 'Stale Doc',
        description: '古い要旨',
        freshness: { kind: 'stale', staleForMs: 60 * 60 * 1000 },
      }),
    ]);
    expect(rendered).toContain('stale-doc');
    expect(rendered).toContain('要旨は本文より1時間古い: 古い要旨');
  });

  /**
   * ⚠️⚠️ **4つの被験体には必ず同じ slug を渡す（`SAME_SLUG`）。読みやすさの
   * ために `x-fresh` / `x-stale` のように分けないこと。**
   *
   * **理由**: slug は出力の行頭にそのまま出る（`- <slug>: <title> — …`）。
   * ⟹ **4つに別々の slug を渡すと、測りたい当のもの（印を作る
   * `memoryFreshnessMarker`）が何を返そうと4つの文字列は必ず互いに異なり、
   * `distinct.size === 4` は無条件に成立する。** つまりこの歯は常に緑で、
   * 変異を1つも検出しない。
   *
   * **実際にそうなっていた**（実測 2026-09-12）。ここはかつて `x-fresh` /
   * `x-stale` / `x-unknown` / `x-absent` の4つの slug を使っており、
   * `memoryFreshnessMarker` の **4分岐すべてを空文字に潰しても**——つまり
   * #821 の直しを丸ごと削除しても——**緑のまま通った。** 4つを同じ slug に
   * すると `expected 2 to be 4` で赤くなる。
   *
   * ⟹ 🔑 **これは #821 が名指しした欠陥と同じ形である**——「常に真になる
   * 観測は、観測ではない」。**#821 を直した PR（#860）が、その Issue と同じ形
   * の歯を置いていた。**
   *
   * ⟹ ⭐ **一般形: 「N 通りが互いに別の表示になる」型の歯は、被験体の識別子を
   * 揃えないと無条件に通る。** 同じ形の歯を書くときは、まず「測りたいものを
   * 潰したらこの歯は赤くなるか」を実際に撃って確かめること。
   *
   * ⛔ 下の `expect(slugs.size).toBe(1)` は、**分けた人がその場で気づくため**に
   * 置いてある。`distinct.size` より**先に**落ちるので、失敗の理由が
   * 「印が畳まれた」ではなく「被験体が分かれている」であることが出力で分かる。
   */
  it('4状態を畳まない: fresh / stale / unknown / absent がそれぞれ別の表示になる（被験体の slug は揃える）', () => {
    // 4つの render の差が「印」だけになるように、被験体は1つの slug に固定する。
    const SAME_SLUG = 'x';
    const fresh = renderMemoryDocuments([
      fact(SAME_SLUG, { description: '説明', freshness: { kind: 'fresh' } }),
    ]);
    const stale = renderMemoryDocuments([
      fact(SAME_SLUG, { description: '説明', freshness: { kind: 'stale', staleForMs: 1000 } }),
    ]);
    const unknown = renderMemoryDocuments([
      fact(SAME_SLUG, { description: '説明', freshness: { kind: 'unknown' } }),
    ]);
    // absent は description そのものを frontmatter に書かない（4状態のうち
    // description が無いときの唯一の状態であることを、内容そのもので表す）。
    const absent = renderMemoryDocuments([fact(SAME_SLUG, { freshness: { kind: 'absent' } })]);

    const rendered = [fresh, stale, unknown, absent];

    // ⛔ 被験体が分かれていないこと。ここが 1 でなければ、下の `distinct.size` は
    // 印ではなく slug の差を測っている——この歯が無力になる唯一の壊れ方である。
    const slugs = new Set(rendered.map((s) => s.match(/^- (\S+?):/m)?.[1]));
    expect(slugs).toEqual(new Set([SAME_SLUG]));

    const distinct = new Set(rendered.map((s) => s.trim()));
    expect(distinct.size).toBe(4);
    expect(absent).toContain('（要旨なし）');
  });

  /**
   * **かつてここは「本文が残る」まで固定していた。** premise の載り方が全文から
   * カードへ変わったので（`renderPremiseCard`）、本文は誰の枝でも載らない。
   *
   * **この歯が測っているのは「文書が消えないこと」と「壊れている印が付くこと」**
   * であり、そこは1ミリも弱まっていない——`malformed` が黙って `fact` へ倒れて
   * 目次1行になれば、この歯は落ちる。
   */
  it('malformed の文書は消えず、premise として扱われ、frontmatter が壊れている印が付く', () => {
    const rendered = renderMemoryDocuments([
      { slug: 'broken', content: '---\nauthor: 未知のキー\n---\n# Broken\n本文は残る' },
    ]);
    expect(rendered).toContain('frontmatter が壊れている');
    // premise の枝を通っている（fact の目次側ではない）。
    expect(rendered).toContain('<!-- memory: broken.md（premise');
    expect(rendered).not.toContain('## 記憶の目次');
    // 文書そのものは消えていない（見出しが載る）。
    expect(rendered).toContain('# Broken');
  });

  it('存在しない親を指す parent を黙って落とさない', () => {
    const rendered = renderMemoryDocuments([
      fact('orphan', { description: '説明', freshness: { kind: 'fresh' }, parent: 'not-exist' }),
    ]);
    expect(rendered).toContain('orphan');
    expect(rendered).toContain('親 not-exist が見つからない');
  });

  /**
   * ⭐ fact の parent が premise を指すと「見つからない」と出る欠陥の修正。
   *
   * `renderMemoryDocuments` の目次（`renderMemoryToc`）は fact だけを対象に
   * 組む——premise は目次の `bySlug` に居ない。だから親が premise として
   * 実在していても、目次だけを見ると「見つからない」になっていた（同じ
   * データが `memory_list` では正常に解決するのに、面によって答えが違う
   * 欠陥）。
   *
   * **⚠️ 器は必ず premise 2件 + fact 1件を持つ**（AGENTS.md「測るのは
   * 呼び出し回数ではなく状態である」）。premise が0件の器では、
   * 「親が premise」と「親がそもそも無い」の2分岐が両方「見つからない」に
   * 畳まれてしまい、この歯が変異を検出できなくなる。
   *
   * **2つの `it()` に分ける**（畳むと、どちらか一方の分岐を潰す変異が生存する）。
   */
  it('⭐ 親が premise を指すときは「見つからない」ではなく「在るが、目次には出ない」と言う', () => {
    const rendered = renderMemoryDocuments([
      premise('core-a', '前提A'),
      premise('core-b', '前提B'),
      fact('child', { description: '子', freshness: { kind: 'fresh' }, parent: 'core-a' }),
    ]);
    expect(rendered).toContain('親 core-a は在るが、この目次は fact だけを列挙する');
    expect(rendered).not.toContain('親 core-a が見つからない');
  });

  it('親が本当に存在しない slug なら、従来どおり「見つからない」のまま', () => {
    const rendered = renderMemoryDocuments([
      premise('core-a', '前提A'),
      premise('core-b', '前提B'),
      fact('child', {
        description: '子',
        freshness: { kind: 'fresh' },
        parent: 'really-not-exist',
      }),
    ]);
    expect(rendered).toContain('親 really-not-exist が見つからない');
    expect(rendered).not.toContain('在るが、この目次は fact だけを列挙する');
  });

  /**
   * ⭐ `clone.ts` の `#withFreshMemory` が踏んだ欠陥（実測 2026-09-02）の修正。
   *
   * 記憶の更新を伝える塊は**変わった文書だけ**を `renderMemoryDocuments` へ
   * 渡す。親（`parent`）が今回変わっていなければ、その `渡された集合の中でしか
   * 解決できない`ので「親 X が見つからない」（＝そもそも文書が無い）と出て
   * いた——実際には親は記憶に実在し、今回の描画に含まれていないだけである。
   * `options.presentInMemory` に記憶の全体の文書を渡すと、この2つが
   * 区別される（→ `parent-not-rendered`）。
   *
   * **`presentInMemory` の型は `readonly MemoryPart[]`（文書そのもの）である。**
   * slug の集合ではなく文書を渡すのは、循環の検出（`cycle-outside-render` の歯）が
   * 記憶の全体の `parent` まで引ける必要があるため——ここでは循環を測らないので
   * `core-a` の `content` は空でよい。
   */
  it('⭐ 親が今回の描画に含まれないだけのときは「見つからない」と言わない', () => {
    const rendered = renderMemoryDocuments(
      [fact('child', { description: '子', freshness: { kind: 'fresh' }, parent: 'core-a' })],
      { presentInMemory: [{ slug: 'core-a', content: '' }, fact('child')] },
    );
    expect(rendered).toContain('親 core-a は在るが、ここに載せた分には含まれない');
    expect(rendered).not.toContain('が見つからない');
  });

  it('親が本当に存在しないなら、`presentInMemory` を渡していても従来どおり「見つからない」', () => {
    const rendered = renderMemoryDocuments(
      [
        fact('child', {
          description: '子',
          freshness: { kind: 'fresh' },
          parent: 'really-not-exist',
        }),
      ],
      // `presentInMemory` には子の文書しか無い——親の slug はどこにも無いので、
      // 記憶の全体を渡していても状況は変わらない。
      { presentInMemory: [fact('child')] },
    );
    expect(rendered).toContain('親 really-not-exist が見つからない');
    expect(rendered).not.toContain('ここに載せた分には含まれない');
  });

  /**
   * 優先順位の歯。`resolveMemoryHierarchy` の `effectiveParent` は
   * `renderedAsPremise` を `presentInMemory` より先に見る——同じ描画の中に
   * premise として全文が載っているなら、そちらの言い方（「この目次のすぐ上」）
   * のほうが具体的で、読み手に近い場所を指せる。
   *
   * **⚠️ 器は必ず premise 2件 + fact 1件を持つ**（上の「親が premise を指す」
   * テストと同じ理由）。
   */
  it('親が同じ描画の中に premise として載っているなら、`presentInMemory` を渡してもそちらの言い方が勝つ', () => {
    const rendered = renderMemoryDocuments(
      [
        premise('core-a', '前提A'),
        premise('core-b', '前提B'),
        fact('child', { description: '子', freshness: { kind: 'fresh' }, parent: 'core-a' }),
      ],
      { presentInMemory: [premise('core-a', '前提A'), premise('core-b', '前提B'), fact('child')] },
    );
    expect(rendered).toContain('親 core-a は在るが、この目次は fact だけを列挙する');
    expect(rendered).not.toContain('ここに載せた分には含まれない');
  });

  /**
   * 互換の保証。`options.presentInMemory` を渡さなければ出力は1バイトも
   * 変わらない——`renderMemoryDocuments` の doc がそう約束している。ここでは
   * `toBe` で文字列全体の同一性を見る（部分一致では、既定値の変化が
   * 「たまたま含まれていた文字列」に隠れうる）。
   */
  it('`presentInMemory` を渡さなければ出力が1バイトも変わらない', () => {
    const docs = [
      fact('orphan', { description: '説明', freshness: { kind: 'fresh' }, parent: 'not-exist' }),
    ];
    const rendered = renderMemoryDocuments(docs);
    // #821 以降、fresh も「要旨の後に本文は動いていない」という印を持つ
    // （常に何か言う設計。旧来の「fresh は印なし」ではなくなった）。
    expect(rendered).toBe(
      '<!-- memory: index -->\n' +
        '## 記憶の目次（fact。本文は memory_read で開く。階層はインデントで表す）\n' +
        '- orphan: orphan — 要旨の後に本文は動いていない: 説明［親 not-exist が見つからない］',
    );
  });

  it('循環する parent を黙って落とさない', () => {
    const rendered = renderMemoryDocuments([
      fact('cycle-a', { description: 'A', freshness: { kind: 'fresh' }, parent: 'cycle-b' }),
      fact('cycle-b', { description: 'B', freshness: { kind: 'fresh' }, parent: 'cycle-a' }),
    ]);
    expect(rendered).toContain('cycle-a');
    expect(rendered).toContain('cycle-b');
    expect(rendered).toContain('循環');
  });

  it('自分自身を親に指定しても黙って落とさない', () => {
    const rendered = renderMemoryDocuments([
      fact('self-parent', {
        description: 'S',
        freshness: { kind: 'fresh' },
        parent: 'self-parent',
      }),
    ]);
    expect(rendered).toContain('self-parent');
    expect(rendered).toContain('循環');
  });

  it('階層はインデントで表す（親子とも fact のとき）', () => {
    const rendered = renderMemoryDocuments([
      fact('parent-doc', { title: '親', description: '親の説明', freshness: { kind: 'fresh' } }),
      fact('child-doc', {
        title: '子',
        description: '子の説明',
        freshness: { kind: 'fresh' },
        parent: 'parent-doc',
      }),
    ]);
    const lines = rendered.split('\n');
    const parentLine = lines.find((line) => line.includes('parent-doc:'));
    const childLine = lines.find((line) => line.includes('child-doc:'));
    expect(parentLine).toBeDefined();
    expect(childLine).toBeDefined();
    // 子のほうがインデントが深い（先頭の空白の数で見る）。
    const leadingSpaces = (line: string) => line.length - line.trimStart().length;
    expect(leadingSpaces(childLine ?? '')).toBeGreaterThan(leadingSpaces(parentLine ?? ''));
  });

  it('記憶が1つも無ければ空文字のまま（従来と同じ）', () => {
    expect(renderMemoryDocuments([])).toBe('');
  });

  /**
   * ⭐ `cycle-outside-render`（循環の一部が描画の外を通る）。
   *
   * a → b → c → a の輪で、この描画に載っているのは a と b だけ（c は
   * `presentInMemory` にしか無い）。`entries` の中だけで閉じた循環検出
   * （直す前の実装）では、a から見ると「親 b はこの描画には無いが記憶には
   * 実在する」（`parent-not-rendered`）としか言えない——輪の存在そのものが
   * 見えない。`resolveMemoryHierarchy` の `detectCycle` が記憶の全体
   * （`presentInMemory`）まで辿るようになったことで、a・b どちらから見ても
   * 「循環している。ただし輪の一部はこの描画の外」と言えるようになる。
   *
   * **`toContain('循環')` だけでは `cycle` と区別できない**（両方に「循環」が
   * 含まれる）ので、ここでは専用の逐語（「輪の一部はここに載せた分には含まれ
   * ない」）で確かめる。
   */
  it('⭐ 循環の一部がこの描画の外を通るとき、cycle ではなく cycle-outside-render として出る', () => {
    const ringA = fact('ring-a', {
      description: 'A',
      freshness: { kind: 'fresh' },
      parent: 'ring-b',
    });
    const ringB = fact('ring-b', {
      description: 'B',
      freshness: { kind: 'fresh' },
      parent: 'ring-c',
    });
    // ring-c はこの描画には出ない——`presentInMemory` にだけ実在する。
    const ringC = fact('ring-c', {
      description: 'C',
      freshness: { kind: 'fresh' },
      parent: 'ring-a',
    });

    const rendered = renderMemoryDocuments([ringA, ringB], {
      presentInMemory: [ringA, ringB, ringC],
    });

    expect(rendered).toContain('ring-a');
    expect(rendered).toContain('ring-b');
    // ring-c 自体はこの描画の対象（fact の目次）には出ない——`presentInMemory`
    // にしか無いことがこの歯の前提である。
    expect(rendered).not.toContain('ring-c:');
    expect(rendered).toContain(
      '親 ring-b との間で循環（輪の一部はここに載せた分には含まれない——記憶の側にある）',
    );
    expect(rendered).toContain(
      '親 ring-c との間で循環（輪の一部はここに載せた分には含まれない——記憶の側にある）',
    );
    // 畳んでいないことの対照——`cycle`（3語版）の逐語は出ない。
    expect(rendered).not.toContain('親 ring-b との間で循環］');
    expect(rendered).not.toContain('親 ring-c との間で循環］');
  });

  /**
   * 対照。`presentInMemory` を渡していても、輪の全員がこの描画（`entries`）の
   * 中で完結していれば、従来どおり `cycle`（`cycle-outside-render` ではない）
   * のままである——種類を畳んでいないことの歯（`cycle-outside-render` を足した
   * ことで、既存の `cycle` が誤って外側の印に化けていないか）。
   */
  it('presentInMemory を渡していても、輪の全員がこの描画の中で完結していれば cycle のまま', () => {
    const cycleA = fact('closed-a', {
      description: 'A',
      freshness: { kind: 'fresh' },
      parent: 'closed-b',
    });
    const cycleB = fact('closed-b', {
      description: 'B',
      freshness: { kind: 'fresh' },
      parent: 'closed-a',
    });

    const rendered = renderMemoryDocuments([cycleA, cycleB], {
      presentInMemory: [cycleA, cycleB],
    });

    expect(rendered).toContain('親 closed-b との間で循環］');
    expect(rendered).toContain('親 closed-a との間で循環］');
    expect(rendered).not.toContain('輪の一部');
  });

  /**
   * 対照。親が描画の外に在るが、循環していないときは**従来どおり**
   * `parent-not-rendered` のままである——`cycle-outside-render` を足した
   * ことで、循環していない「親が外に在るだけ」の状態まで誤って循環側へ
   * 倒れていないことの歯（`resolveMemoryHierarchy` の doc「循環の判定を他の
   * 4つより先に行う」が、循環でないものまで循環と誤判定していないか）。
   */
  it('対照: 親が描画の外に在るが循環していないときは、従来どおり parent-not-rendered のまま', () => {
    const core = { slug: 'core', content: '' };
    const child = fact('child', {
      description: '子',
      freshness: { kind: 'fresh' },
      parent: 'core',
    });

    const rendered = renderMemoryDocuments([child], { presentInMemory: [core, child] });

    expect(rendered).toContain('親 core は在るが、ここに載せた分には含まれない');
    expect(rendered).not.toContain('循環');
  });

  /**
   * ⭐ 網羅性の歯。`MemoryTocIssue` は5状態——**`Record<MemoryTocIssue, true>`
   * で縛る**（依頼者の門: この repo の既存の網羅の歯は手書きの配列 +
   * `assertNever` だが、今回は明示的にこの形を指定された）。6つ目の状態が
   * 増えると、この宣言に埋め忘れがあれば `tsc` が落ちる——配列に足し忘れても
   * 実行時まで気づけない、という失敗モードを型で塞ぐ。
   *
   * **ループの前に対象が空でないことを確かめる**（`Object.keys` が空のまま
   * 1回も回らず緑になる事故を防ぐ。依頼者の門）。
   */
  it('⭐ MemoryTocIssue の5状態は互いに異なる文言になる（畳んでいない）', () => {
    const ALL_ISSUES: Record<MemoryTocIssue, true> = {
      'missing-parent': true,
      cycle: true,
      'parent-not-listed': true,
      'parent-not-rendered': true,
      'cycle-outside-render': true,
    };
    const issues = Object.keys(ALL_ISSUES) as MemoryTocIssue[];
    // 対象が空でないこと（後続のループが1回も回らず緑になる事故を防ぐ）。
    expect(issues.length).toBe(5);

    const outputs: Record<MemoryTocIssue, string> = {
      'missing-parent': renderMemoryDocuments([
        fact('miss-child', { description: '子', freshness: { kind: 'fresh' }, parent: 'nope' }),
      ]),
      'parent-not-listed': renderMemoryDocuments([
        premise('listed-core'),
        fact('listed-child', {
          description: '子',
          freshness: { kind: 'fresh' },
          parent: 'listed-core',
        }),
      ]),
      'parent-not-rendered': renderMemoryDocuments(
        [
          fact('rendered-child', {
            description: '子',
            freshness: { kind: 'fresh' },
            parent: 'rendered-core',
          }),
        ],
        { presentInMemory: [{ slug: 'rendered-core', content: '' }] },
      ),
      cycle: renderMemoryDocuments([
        fact('closed-a2', { description: 'A', freshness: { kind: 'fresh' }, parent: 'closed-b2' }),
        fact('closed-b2', { description: 'B', freshness: { kind: 'fresh' }, parent: 'closed-a2' }),
      ]),
      'cycle-outside-render': renderMemoryDocuments(
        [fact('ext-a', { description: 'A', freshness: { kind: 'fresh' }, parent: 'ext-b' })],
        {
          presentInMemory: [
            fact('ext-a', { description: 'A', freshness: { kind: 'fresh' }, parent: 'ext-b' }),
            fact('ext-b', { description: 'B', freshness: { kind: 'fresh' }, parent: 'ext-c' }),
            fact('ext-c', { description: 'C', freshness: { kind: 'fresh' }, parent: 'ext-a' }),
          ],
        },
      ),
    };

    for (const issue of issues) {
      expect(outputs[issue].length).toBeGreaterThan(0);
    }
    // **印そのもの（［…］の中身）を取り出して比べる。** 全文どうしを比べると
    // slug や description の違いだけで別文字列になり、印を畳む変異（例:
    // `cycle-outside-render` の文言を `cycle` と同じにする）を見逃す。
    const bracket = (rendered: string): string => rendered.match(/［[^］]+］/)?.[0] ?? '';
    const markers = issues.map((issue) => bracket(outputs[issue]));
    expect(markers.every((marker) => marker.length > 0)).toBe(true);
    // 5状態が互いに異なる文言であること——これが本体（畳んでいないことの直接の証拠）。
    expect(new Set(markers).size).toBe(5);
  });
});

/**
 * premise のカードを**束ねた全体**の蓋（`MEMORY_PREMISE_CARD_BUDGET`）。
 *
 * **1文書あたりの予算（`MEMORY_PROMPT_DESCRIPTION_BUDGET` /
 * `MEMORY_PROMPT_OUTLINE_BUDGET`）を測る歯とは別である。** あちらは「1枚が
 * 大きくならないこと」、こちらは「**枚数が増えても総量が伸びないこと**」で、
 * 片方が緑でももう片方は何も測れていない（`fact` 側で `MEMORY_TOC_ENTRY_LIMIT`
 * と `MEMORY_TOC_CHAR_BUDGET` を2軸に分けているのと同じ関係）。
 */
describe('premise のカードの束ねた蓋（MEMORY_PREMISE_CARD_BUDGET）— 文書数に対する上界', () => {
  /**
   * カードが**1文書あたりの予算に張り付く**形の premise 1件。要旨は
   * `MEMORY_PROMPT_DESCRIPTION_BUDGET` ちょうど、節数は目次が
   * `MEMORY_PROMPT_OUTLINE_BUDGET` を確実に超える数にしてある——1枚が運ぶ量を
   * 最大にした、束ねた蓋が確実に噛む形である。
   */
  const capPremise = (index: number): MemoryPart => ({
    slug: `premise-${String(index).padStart(3, '0')}`,
    title: `前提${index}`,
    content: [
      '---',
      'type: premise',
      `description: ${'あ'.repeat(MEMORY_PROMPT_DESCRIPTION_BUDGET)}`,
      '---',
      '',
      // 1行あたり数十文字の見出しを、目次の予算を超える数だけ積む。
      ...Array.from({ length: 200 }, (_, n) => `## 節${n} ${'見出し'.repeat(4)}\n\n本文\n`),
    ].join('\n'),
  });

  /**
   * カード1枚ぶんの限界費用を、**書式を真似ずに実測する。** 2件と1件の
   * レンダリング結果の差が「カード1枚＋区切り」ぶんである——`renderPremiseCard`
   * の内部の書式（見出しコメント・要旨の行・節の行）を書き写すと、書式が
   * 変わったときにここだけが古くなる（`measureTocMarginalCost` と同じ作法）。
   */
  const measureCardMarginalCost = () => {
    const one = renderMemoryDocuments([capPremise(0)]);
    const two = renderMemoryDocuments([capPremise(0), capPremise(1)]);
    return { one, two, marginal: two.length - one.length };
  };

  /** 断り書きの1行目の頭。**逐語で持つ**（定数を import して両側を一緒に動かさない）。 */
  const DEMOTION_NOTE_HEAD = '<!-- memory: カードを落とした分（premise / indexed';

  /**
   * ⭐⭐ **導出そのものを歯にする。**
   *
   * `MEMORY_PREMISE_CARD_BUDGET` の doc は「張り付いたカードが `premise` なら
   * 5枚・`indexed` なら9枚で収まり、6枚目の `premise` で噛む」と書いている。
   * **コメントは検査されないので、1文書あたりの予算かこの蓋のどちらかが動くと、
   * 導出だけが静かに嘘になる**——実際に2026-09-11 にそうなった（#807 がカードを
   * 1枚あたり +202 文字にし、#805 が `indexed` を蓋の対象へ加えた）。
   *
   * ⟹ **doc に書いた枚数を、定数と実測から計算し直して突き合わせる。** 数値は
   * 書き写さず、**カード1枚の限界費用を測って割る**（書式が変わっても追随する）。
   */
  it('⭐⭐ doc の導出（premise 5枚 / indexed 9枚で収まり、6枚目の premise で噛む）が現物と一致する', () => {
    /** 1文書あたりの予算に**完全に**張り付いたカード。節は目次の予算を確実に超える数。 */
    const saturated = (index: number, kind: 'premise' | 'indexed'): MemoryPart => ({
      slug: `${kind}-${String(index).padStart(3, '0')}`,
      content: [
        '---',
        `type: ${kind}`,
        `description: ${'あ'.repeat(kind === 'premise' ? MEMORY_PROMPT_DESCRIPTION_BUDGET : MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET)}`,
        '---',
        '',
        ...Array.from(
          { length: 400 },
          (_, n) => `## 節${n} ${'見出しの語'.repeat(6)}\n\n本文${n}\n`,
        ),
      ].join('\n'),
    });
    /** カード1枚＋区切りぶんの費用。**書式を真似ずに差で取る。** */
    const marginal = (kind: 'premise' | 'indexed'): number =>
      renderMemoryDocuments([saturated(0, kind), saturated(1, kind)]).length -
      renderMemoryDocuments([saturated(0, kind)]).length;

    expect(Math.floor(MEMORY_PREMISE_CARD_BUDGET / marginal('premise'))).toBe(5);
    expect(Math.floor(MEMORY_PREMISE_CARD_BUDGET / marginal('indexed'))).toBe(9);

    // **6枚目の premise で実際に噛む**（枚数の割り算だけでなく、噛んだことを出力で見る）。
    const six = renderMemoryDocuments(
      Array.from({ length: 6 }, (_, index) => saturated(index, 'premise')),
    );
    expect(six).toContain(DEMOTION_NOTE_HEAD);
  });

  /**
   * ⭐⭐ **蓋は `indexed` のカードにも掛かる。**
   *
   * #810（この蓋）と #805（`indexed`）は独立に書かれ、**合流の時点で衝突した。**
   * #810 の `selectPremiseCards` は premise のカードだけを集め、大きさを
   * `renderPremisePart` で直に測っていた ⟹ **そのまま合わせると `indexed` の
   * カードが蓋の外へ出る。** 上限が「60,000 ＋ indexed の総量」に化け、
   * **文書数に比例して伸びる穴が `indexed` の側へ開き直る**——この蓋が
   * まさに塞いだ形である。
   *
   * ⟹ 測る式を引数へ外へ出し、`[...premiseParts, ...indexedParts]` を同じ蓋へ
   * 通すようにした。**この歯はその判断を固定する。**
   *
   * ⚠️ **`indexed` を1件も含まない入力では、この変更で出力は1文字も変わらない**
   * （既定の描き手は `renderPremisePart` のままで、`cardParts === premiseParts`
   * になる）——不変条件3は別の歯が持つ。
   */
  it('⭐⭐ 蓋は indexed のカードにも掛かる（indexed を蓋の外に置かない）', () => {
    const capIndexed = (index: number): MemoryPart => ({
      slug: `indexed-${String(index).padStart(3, '0')}`,
      title: `索引${index}`,
      content: [
        '---',
        'type: indexed',
        `description: ${'い'.repeat(MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET)}`,
        '---',
        '',
        ...Array.from({ length: 200 }, (_, n) => `## 節${n} ${'見出し'.repeat(4)}\n\n本文\n`),
      ].join('\n'),
    });

    // **indexed だけで蓋を確実に超える枚数**を、限界費用の実測から出す
    // （枚数を直書きしない。`measureCardMarginalCost` と同じ作法）。
    const marginalIndexed =
      renderMemoryDocuments([capIndexed(0), capIndexed(1)]).length -
      renderMemoryDocuments([capIndexed(0)]).length;
    const count = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 2) / marginalIndexed);
    const docs = Array.from({ length: count }, (_, index) => capIndexed(index));

    const rendered = renderMemoryDocuments(docs);

    // **蓋が噛んでいる**（噛まなければ、この枚数で予算の2倍へ届いてしまう）。
    expect(rendered).toContain(DEMOTION_NOTE_HEAD);
    expect(rendered.length).toBeLessThan(MEMORY_PREMISE_CARD_BUDGET * 2);
  });

  /**
   * ⭐⭐⭐ 穴の実在。**緩くてよい歯である**——測りたいのは「蓋が無ければ総量が
   * 文書数に比例して伸び、予算を桁で超えていた」という事実だけである。
   *
   * **外挿の材料は蓋が噛む前の値から取る**（1件・2件）。`60_000` も
   * 「296,088」も直書きしない——限界費用の実測から導く。
   */
  /**
   * ⭐⭐⭐ **予算は1本である。区分ごとに2本持たない。**
   *
   * ## 直上の歯だけでは足りなかった（変異で分かったこと）
   *
   * 直上の「蓋は indexed のカードにも掛かる」は **`indexed` だけ**を通して
   * 「`MEMORY_PREMISE_CARD_BUDGET * 2` 未満」を主張する。⟹ **区分ごとに同じ
   * 予算を1本ずつ持たせる改修（`premise` に 60,000・`indexed` に 60,000）では、
   * どちらの区分も単独では予算の2倍に届かないので緑のまま通る。**
   *
   * 実測（2026-09-11、`main` = `89cb1a9`）: `selectPremiseCards` の呼びを
   * `premiseParts` と `indexedParts` の2本へ割る変異を当てて、
   * **`memory.test.ts` ＋ `tools.test.ts` の 869 件すべて生存。**
   * ⟹ **床が黙って 120,000 文字（= 60,000 × 2）まで伸びる形が、どの歯にも
   * 引っかからなかった。**
   *
   * ## だから混在で測る
   *
   * 両方の区分を同時に、**それぞれ単独では予算に届かない量**だけ積む。
   * ⟹ 予算が1本なら噛み、2本なら噛まない。**噛むこと自体が主張である。**
   *
   * **⚠️ この歯が測っていないこと**: どちらの区分が先に落ちるかは測っていない
   * （実装は大きさだけで決めており、区分では優先しない——`selectPremiseCards`
   * の doc）。ここが主張するのは「予算を分け合うこと」だけである。
   */
  it('⭐⭐⭐ premise と indexed は1つの予算を分け合う（区分ごとに2本持たない）', () => {
    const capIndexedShared = (index: number): MemoryPart => ({
      slug: `shared-idx-${String(index).padStart(3, '0')}`,
      content: [
        '---',
        'type: indexed',
        `description: ${'い'.repeat(MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET)}`,
        '---',
        '',
        '## 節\n\n本文\n',
      ].join('\n'),
    });

    // 1枚ぶんの限界費用を実測から取る（枚数を直書きしない）。
    const marginalPremise = measureCardMarginalCost().marginal;
    const marginalIndexed =
      renderMemoryDocuments([capIndexedShared(0), capIndexedShared(1)]).length -
      renderMemoryDocuments([capIndexedShared(0)]).length;

    // **それぞれ単独では予算に届かない枚数**（予算の 0.6 ぶん）。
    const premiseCount = Math.floor((MEMORY_PREMISE_CARD_BUDGET * 0.6) / marginalPremise);
    const indexedCount = Math.floor((MEMORY_PREMISE_CARD_BUDGET * 0.6) / marginalIndexed);
    expect(premiseCount, 'premise の足場が空である').toBeGreaterThan(0);
    expect(indexedCount, 'indexed の足場が空である').toBeGreaterThan(0);

    const premiseOnly = Array.from({ length: premiseCount }, (_, i) => capPremise(i));
    const indexedOnly = Array.from({ length: indexedCount }, (_, i) => capIndexedShared(i));

    // 前提: **単独では噛まない**（＝この足場が「2本の予算」でも通る量である）。
    expect(renderMemoryDocuments(premiseOnly)).not.toContain(DEMOTION_NOTE_HEAD);
    expect(renderMemoryDocuments(indexedOnly)).not.toContain(DEMOTION_NOTE_HEAD);

    // 混ぜると噛む——予算が1本だからである（2本なら噛まない）。
    const mixed = renderMemoryDocuments([...premiseOnly, ...indexedOnly]);
    expect(mixed).toContain(DEMOTION_NOTE_HEAD);

    // そして総量は予算1本ぶん（＋断り書き）に収まる。
    const note = mixed.slice(mixed.indexOf(DEMOTION_NOTE_HEAD));
    expect(mixed.length).toBeLessThan(MEMORY_PREMISE_CARD_BUDGET + note.length);
  });

  it('⭐⭐⭐ 穴の実在: 蓋が無ければ、束ねたカードは文書数に比例して予算を桁で超える', () => {
    const { one, two, marginal } = measureCardMarginalCost();
    // 前提: この2件は束ねた蓋に掛かっていない（＝外挿の材料が「蓋が効く前」の値）。
    expect(one).not.toContain(DEMOTION_NOTE_HEAD);
    expect(two).not.toContain(DEMOTION_NOTE_HEAD);
    // 1枚が1文書あたりの予算に張り付いていること（この足場が薄いと外挿が効かない）。
    expect(marginal).toBeGreaterThan(MEMORY_PROMPT_OUTLINE_BUDGET);

    // 蓋が無ければ、予算の2倍を超えるのに要る枚数はこれだけである。
    const docsToDoubleBudget = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 2) / marginal);
    const extrapolated = one.length + (docsToDoubleBudget - 1) * marginal;
    expect(extrapolated).toBeGreaterThan(MEMORY_PREMISE_CARD_BUDGET * 2);

    // そしてその枚数は、実運用で起こりうる桁である（数百件ではない）。
    expect(docsToDoubleBudget).toBeLessThan(100);
  });

  /**
   * ⭐⭐⭐ 修理の実在。**こちらは締まっていないと意味が無い歯である。**
   *
   * ## 遊びの大きさを決めるのは断り書きであって、書き手ではない
   *
   * 出力が `MEMORY_PREMISE_CARD_BUDGET` を超えてよい理由は1つ——予算が締めて
   * いるのは**カードだけ**で、落とした分の断り書き（`renderPremiseBudgetNotice`）
   * はその上に載るからである。⟹ 上界の第2項は丸い数字ではなく「**この出力に
   * 実際に載った断り書きの長さ**」にする（`MEMORY_TOC_CHAR_BUDGET` の歯と同じ作法）。
   *
   * ## ⚠️ この歯が測っていないこと
   *
   * - **予算を使い切っていることは主張していない**（これは上界である）
   * - **断り書きの中身は測っていない**（長さしか見ない。中身は下の it() が逐語で持つ）
   */
  it('⭐⭐⭐ 修理の実在: 枚数を増やしても、予算を超えてよいのは断り書きぶんだけ', () => {
    const { one, marginal } = measureCardMarginalCost();
    const many = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 3) / marginal);
    const rendered = renderMemoryDocuments(Array.from({ length: many }, (_, i) => capPremise(i)));

    const noteStart = rendered.indexOf(DEMOTION_NOTE_HEAD);
    expect(noteStart).toBeGreaterThan(-1);
    const note = rendered.slice(noteStart);
    // 切り出した先にカードが混ざっていない（＝これは断り書きそのものである）。
    expect(note).not.toContain('節（memory_section_read に節id を渡せば本文が開く');

    expect(rendered.length).toBeLessThan(MEMORY_PREMISE_CARD_BUDGET + note.length);

    // 対照: この上界が「そもそも蓋が噛んでいない」ことで成り立っていない
    // ——蓋が無いときの外挿値とは桁が違う。
    const extrapolated = one.length + (many - 1) * marginal;
    expect(rendered.length).toBeLessThan(extrapolated / 2);
  });

  /**
   * ⭐⭐⭐ **文書は消えない。** `renderMemoryTocOmission` が逐語で名乗っている
   * 約束（「premise はカードが切られても見出しは必ず残るが、fact はここでしか
   * 名乗らない」）を、この蓋が破っていないことを測る。
   *
   * **これが落ちたら、蓋は「能力の削除」になっている**（north_star 禁止1）。
   */
  it('⭐⭐⭐ カードを落としても文書は消えない: 全ての slug が焼き込みに現れる', () => {
    const { marginal } = measureCardMarginalCost();
    const many = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 2) / marginal);
    const docs = Array.from({ length: many }, (_, i) => capPremise(i));
    const rendered = renderMemoryDocuments(docs);

    // 落ちた分が実際に在る（＝この歯が空振りしていない）。
    expect(rendered).toContain(DEMOTION_NOTE_HEAD);
    expect(docs.filter((doc) => !rendered.includes(doc.slug))).toEqual([]);
  });

  /**
   * ⭐⭐⭐ **上界は文書数に依らない。** これが `MEMORY_PREMISE_CARD_BUDGET` の
   * doc が主張している「文書が何件増えても焼き込みはこの和を超えない」の本体である。
   *
   * ## なぜ「修理の実在」だけでは足りなかったか（変異で分かったこと）
   *
   * 上の「修理の実在」の上界は `MEMORY_PREMISE_CARD_BUDGET + note.length` で、
   * **`note` の中に落とした分の一覧そのものが入っている。** ⟹ 一覧の予算
   * （`MEMORY_PREMISE_STUB_BUDGET`）を外しても、上界が一緒に伸びて緑のままに
   * なる。実測（2026-09-11、変異8）: `budget: MEMORY_PREMISE_STUB_BUDGET` を
   * `Number.MAX_SAFE_INTEGER` へ変異させて **230件すべて生存。**
   *
   * ⟹ **入力の大きさに依らない量で測る。** 枚数を増やしたときに総量がほとんど
   * 動かないこと——「カード1枚ぶんよりも小さい」を基準にする（この基準自体も
   * 実測から取る）。
   */
  it('⭐⭐⭐ 上界は文書数に依らない: 枚数を足しても、総量はカード1枚ぶんも増えない', () => {
    const { marginal } = measureCardMarginalCost();
    const base = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 2) / marginal);
    const few = renderMemoryDocuments(Array.from({ length: base }, (_, i) => capPremise(i)));
    const many = renderMemoryDocuments(Array.from({ length: base + 100 }, (_, i) => capPremise(i)));

    // 前提: どちらも蓋が噛んでいる（＝これは「蓋の後」どうしの比較である）。
    expect(few).toContain(DEMOTION_NOTE_HEAD);
    expect(many).toContain(DEMOTION_NOTE_HEAD);

    // 100件足しても、増えるのは件数の桁ぶんだけである。
    expect(many.length - few.length).toBeLessThan(marginal);
  });

  /**
   * ⭐⭐⭐ **断り書きは「蓋が無ければいくらだったか」を名乗る。**
   *
   * 切ったあとの長さを名乗ると、**超えたこと自体が出力から消える**
   * （`excerpt.ts` の「切ったら、切ったことを必ず言う」）。⟹ クローンは
   * 「どれだけ超えているか」＝どれだけ畳む必要があるかを読めなくなる。
   *
   * **期待値は実装の式を写さずに組み立てる**——1文書ずつ描いた長さの和と、
   * 区切りの長さ（これも2件・1件・1件の実測から導く）で独立に再計算する。
   *
   * 実測（2026-09-11、変異7）: `uncappedChars: totalChars` を
   * `uncappedChars: used`（＝蓋の後の長さ）へ変異させて **230件すべて生存**
   * だったので、この歯を足した。
   */
  it('⭐⭐⭐ 断り書きが名乗るのは蓋が無かったときの総量である（蓋の後の長さではない）', () => {
    const { marginal } = measureCardMarginalCost();
    const count = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 2) / marginal);
    const docs = Array.from({ length: count }, (_, i) => capPremise(i));
    const rendered = renderMemoryDocuments(docs);
    expect(rendered).toContain(DEMOTION_NOTE_HEAD);

    // 区切りの長さを実測から導く（リテラルを書かない）。
    const a = docs[0];
    const b = docs[1];
    if (a === undefined || b === undefined) throw new Error('足場が空である');
    const joinChars =
      renderMemoryDocuments([a, b]).length -
      renderMemoryDocuments([a]).length -
      renderMemoryDocuments([b]).length;
    expect(joinChars).toBeGreaterThan(0);

    const uncapped =
      docs.reduce((sum, doc) => sum + renderMemoryDocuments([doc]).length, 0) +
      joinChars * (docs.length - 1);

    // 蓋が無かったときの総量を名乗っている。
    expect(rendered).toContain(
      `カード（premise と indexed）の合計が ${uncapped.toLocaleString('en-US')} 文字になり`,
    );
    // そしてそれは、実際に載った長さより大きい（＝蓋の後の値ではない）。
    expect(uncapped).toBeGreaterThan(rendered.length);
  });

  it('落とした件数・残した件数・開く口・直し方を名乗る', () => {
    const { marginal } = measureCardMarginalCost();
    const many = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 2) / marginal);
    const rendered = renderMemoryDocuments(Array.from({ length: many }, (_, i) => capPremise(i)));

    expect(rendered).toContain('件のカードを落として1行にした');
    expect(rendered).toContain('カードのまま載っているのは');
    // 開く口（載せないことを能力の削除にしないための条件）。
    expect(rendered).toContain('memory_outline');
    expect(rendered).toContain('memory_section_read');
    // 直し方と、倒してはいけない方向。
    expect(rendered).toContain('memory_section_move');
    expect(rendered).toContain('要旨（description）を削る方向へ倒さないこと');
  });

  /**
   * ⭐⭐ **落とす順序は入力の順に依らない。** 依らせると、同じ記憶が呼びごとに
   * 違うカードを落とし、クローンはそれを記憶の破損として読む。
   *
   * **⚠️ この歯が測っていないこと**: 大きさが**同じ**カードどうしの順序は
   * `slug` で決まるので、大きさが全部同じ入力では「slug の大きい側が恒久的に
   * 落ちる」——`excerpt.ts` の `ListingBudget.omitted` が名指ししている形が、
   * その入力に対しては残る。実運用でカードの大きさが完全に一致することは無い
   * （見出しコメントが `全 N 文字 / M 節` を運ぶ）ので塞いでいないが、
   * **塞いでいないことをここに書いておく。**
   */
  /**
   * カードの大きさが**要旨の長さに比例して単調に増える** premise。
   *
   * **⚠️ 節数で大きさに差を付けてはいけない。** 節目次が1文書あたりの予算
   * （`MEMORY_PROMPT_OUTLINE_BUDGET`）に当たると、節を増やすほどカードは
   * **小さくなる**（省略の断り書きへ畳まれるため）——実測（2026-09-11、この
   * 足場）で 200節 10,179 文字 / 211節 10,153 文字。**節数はカードの大きさの
   * 代理指標にならない。** だからここは要旨の長さで差を付ける（予算の下に
   * 収めるので、切り詰めが挟まらず単調である）。
   */
  const sizedPremise = (index: number): MemoryPart => ({
    slug: `sized-${String(index).padStart(3, '0')}`,
    title: `前提${index}`,
    content: [
      '---',
      'type: premise',
      `description: ${'あ'.repeat(200 + index * 100)}`,
      '---',
      '',
      ...Array.from({ length: 5 }, (_, n) => `## 節${n}\n\n本文\n`),
    ].join('\n'),
  });

  it('⭐⭐ 落とすのは大きいほうから（渡す順序を変えても結果が変わらない）', () => {
    // 要旨の長さで大きさに差を付ける（`sizedPremise` の doc）。40件あれば
    // 束ねた予算を確実に超える（1件あたり数百〜数千文字）。
    const docs = Array.from({ length: 40 }, (_, i) => sizedPremise(i));

    const forward = renderMemoryDocuments(docs);
    const reversed = renderMemoryDocuments([...docs].reverse());

    // 落ちた slug の集合が一致する（順序に依らない）。
    const demotedSlugs = (rendered: string) => {
      const note = rendered.slice(rendered.indexOf(DEMOTION_NOTE_HEAD));
      return docs
        .map((doc) => doc.slug)
        .filter((slug) => note.includes(`- ${slug}.md（`))
        .sort();
    };
    expect(forward).toContain(DEMOTION_NOTE_HEAD);
    expect(demotedSlugs(forward)).toEqual(demotedSlugs(reversed));

    // そして落ちたのは大きいほう（いちばん小さい1件は必ずカードのまま残る）。
    const smallest = docs[0];
    if (smallest === undefined) throw new Error('足場が空である');
    expect(forward).toContain(`<!-- memory: ${smallest.slug}.md（premise`);
  });

  /**
   * ⭐⭐ **差分の載せ直しには蓋を掛けない**（`selectPremiseCards` の doc）。
   *
   * `clone.ts` の `#withFreshMemory` が渡す集合は「今回変わった範囲」であって
   * 床ではない。そこへ蓋を掛けると、システムプロンプト側ではカードが在る文書が
   * 差分の側だけ1行に落ちる——**同じ文脈の中で、同じ文書について2つの載り方が
   * 並ぶ。**
   */
  it('⭐⭐ 差分の載せ直し（seenContent を渡す呼び）には蓋を掛けない', () => {
    const { marginal } = measureCardMarginalCost();
    const many = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 2) / marginal);
    const docs = Array.from({ length: many }, (_, i) => capPremise(i));

    // 蓋を掛ける呼び（記憶の全体）では落ちる。
    expect(renderMemoryDocuments(docs)).toContain(DEMOTION_NOTE_HEAD);

    // 差分の呼びでは落ちない。**`seenContent` は空の Map でよい**——渡したこと
    // 自体が「これは差分である」の合図である。
    const asDelta = renderMemoryDocuments(docs, {
      presentInMemory: docs,
      seenContent: new Map(),
    });
    expect(asDelta).not.toContain(DEMOTION_NOTE_HEAD);
  });

  /**
   * ⭐⭐ **メーターが嘘をつかない。** 蓋が噛むと `totalChars` は枚数を増やしても
   * ほとんど動かない——`demotedPremiseDocs` が0でない限り、`totalChars` は
   * 「蓋が効いた後の値」である（`MemoryFloor.demotedPremiseDocs` の doc）。
   */
  it('⭐⭐ measureMemoryFloor: demotedPremiseDocs が実物と一致し、premiseDocs は引かれない', () => {
    const { marginal } = measureCardMarginalCost();
    const many = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 2) / marginal);
    const docs = Array.from({ length: many }, (_, i) => capPremise(i));

    const floor = measureMemoryFloor(docs);
    // 区分の件数は動かない（落ちても premise である）。
    expect(floor.premiseDocs).toBe(many);
    expect(floor.demotedPremiseDocs).toBeGreaterThan(0);
    expect(floor.demotedPremiseDocs).toBeLessThan(many);

    // 落ちた件数は、断り書きが名乗る数と一致する。
    const rendered = renderMemoryDocuments(docs);
    expect(rendered).toContain(
      `**大きいほうから ${floor.demotedPremiseDocs.toLocaleString('en-US')} 件のカードを落として1行にした**`,
    );

    // 蓋が噛んでいない足場では0である（0 の行を作らないための対照）。
    expect(measureMemoryFloor([capPremise(0)]).demotedPremiseDocs).toBe(0);
  });

  /**
   * ⭐⭐ 蓋が噛んだ回だけ、床の一言が「この増減は蓋の後の値である」と名乗る。
   * **噛んでいない回は1文字も出さない**（毎回付けると、本当に噛んだときの
   * 目印が効かなくなる）。
   */
  it('⭐⭐ describeMemoryFloor は、蓋が噛んだ回だけ増減の読み方を断る', () => {
    const { marginal } = measureCardMarginalCost();
    const many = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 2) / marginal);
    const capped = Array.from({ length: many }, (_, i) => capPremise(i));
    const small = [capPremise(0)];

    const cappedLine = describeMemoryFloor({
      before: measureMemoryFloor(capped.slice(0, -1)),
      after: measureMemoryFloor(capped),
      slug: capped[capped.length - 1]?.slug ?? 'premise-000',
      kind: 'premise',
      created: false,
    });
    expect(cappedLine).toContain('この増減は蓋が効いた後の値である');

    const smallLine = describeMemoryFloor({
      before: measureMemoryFloor([]),
      after: measureMemoryFloor(small),
      slug: 'premise-000',
      kind: 'premise',
      created: false,
    });
    expect(smallLine).not.toContain('この増減は蓋が効いた後の値である');
  });

  /**
   * ⚠️ **測っていない枝を明記する。** `selectPremiseCards` には「いちばん小さい
   * カード1枚で予算を超えるときは、その1枚を残す」という倒し方が在るが、
   * **この枝には歯が無い。**
   *
   * 理由: 1枚のカードは1文書あたりの予算で頭打ちになる（要旨
   * `MEMORY_PROMPT_DESCRIPTION_BUDGET` ＋ 節目次 `MEMORY_PROMPT_OUTLINE_BUDGET`
   * ＋ 固定費）ので、`MEMORY_PREMISE_CARD_BUDGET` を1枚で超える入力を**作れない。**
   * ⟹ あの枝は、束ねた予算を1枚ぶんより小さく下げたときのための保険である。
   *
   * **ここで測れるのは「1枚のカードは束ねた予算より必ず小さい」という前提のほうで、
   * それが崩れたらこの歯が落ちる**（＝あの枝に歯を書く必要が生まれたと分かる）。
   */
  /**
   * ⭐⭐⭐ **断り書きは、落ちた文書の区分について嘘をつかない。**
   *
   * ## 何が起きていたか（実測 2026-09-11、`main` = `702b5afc`）
   *
   * #805 が蓋の対象へ `indexed` を加えたとき、**断り書きの文言は premise のまま
   * 残った。** ⟹ `indexed` だけ 200 件を通すと、premise が1件も無いのに
   * 「⚠️ **premise** のカードの合計が 1,225,998 文字になり」と名乗り、落とした
   * 1行（`- idx-009.md（全 6,046 文字 / 1 節…）`）も区分を1文字も言わなかった。
   *
   * ## ⚠️ そして2つ目のほうが重い —— 実行できない助言になっていた
   *
   * 直し方の (1) は「この行に出ている文書を `memory_frontmatter_set` で
   * `type: indexed` にする」だった。**落ちたのが既に `indexed` の文書なら、
   * これは何もしない。** ⟹ クローンはそれを実行し、床が1文字も下がらないのを見る。
   *
   * `renderMemoryTocOmission` は同じ線を逐語で引いている——「実行できない助言
   * （越権の助言）を出さないための線引きである」。**そこがこちらでは守られて
   * いなかった。**
   */
  describe('断り書きは落ちた区分について嘘をつかない（#805 で蓋が indexed へ広がった後）', () => {
    /** `indexed` の要旨の予算に張り付いたカード1枚。節の目次は載らない。 */
    const saturatedIndexed = (index: number): MemoryPart => ({
      slug: `sat-idx-${String(index).padStart(3, '0')}`,
      content: [
        '---',
        'type: indexed',
        `description: ${'い'.repeat(MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET)}`,
        '---',
        '',
        '## 節\n\n本文\n',
      ].join('\n'),
    });

    it('⭐⭐⭐ indexed だけが落ちたとき、premise が落ちたとは名乗らない', () => {
      const rendered = renderMemoryDocuments(
        Array.from({ length: 20 }, (_, i) => saturatedIndexed(i)),
      );
      expect(rendered).toContain(DEMOTION_NOTE_HEAD);

      // 内訳を名乗る（premise 0 件 / indexed N 件）。
      expect(rendered).toMatch(/（premise 0 件 \/ indexed [\d,]+ 件。/);
      // 落とした1行が区分を名乗る。
      expect(rendered).toMatch(/^- sat-idx-\d+\.md（indexed・/m);
      // **premise のカードだと名乗らない**（これが嘘だった側）。
      expect(rendered).not.toContain('premise のカードの合計');
    });

    it('⭐⭐⭐ 落ちたのが indexed だけなら、「indexed にせよ」という実行できない助言を出さない', () => {
      const rendered = renderMemoryDocuments(
        Array.from({ length: 20 }, (_, i) => saturatedIndexed(i)),
      );
      // (1) の手そのものを出さない。
      expect(rendered).not.toContain('type: indexed にする');
      // 代わりに、残っている手がそれだけであることを言う。
      expect(rendered).toContain('に残っている手はこれだけである');
      expect(rendered).toContain('type: indexed にしても1文字も下がらない');
      // (2) の手は出る（実行できる）。
      expect(rendered).toContain('memory_section_move で割り');
    });

    it('⭐⭐ 落ちたのが premise だけなら、(1) の手を premise の件数で名指しして出す', () => {
      const { marginal } = measureCardMarginalCost();
      const count = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 2) / marginal);
      const rendered = renderMemoryDocuments(
        Array.from({ length: count }, (_, i) => capPremise(i)),
      );
      expect(rendered).toContain(DEMOTION_NOTE_HEAD);

      expect(rendered).toMatch(/（premise [\d,]+ 件 \/ indexed 0 件。/);
      expect(rendered).toMatch(
        /\(1\) 上の premise [\d,]+ 件を memory_frontmatter_set で type: indexed にする/,
      );
      // indexed が1件も落ちていないので、indexed 向けの断りは出ない。
      expect(rendered).not.toContain('に残っている手はこれだけである');
      expect(rendered).toMatch(/^- premise-\d+\.md（premise・/m);
    });

    it('⭐⭐ 両方が混ざって落ちたときは、内訳と両方の手が出る', () => {
      // premise を張り付かせ、indexed も張り付かせて混ぜる。premise のほうが
      // 1枚が大きいので先に落ちる——**それでも内訳は測った値で出す。**
      const { marginal } = measureCardMarginalCost();
      const premiseCount = Math.ceil((MEMORY_PREMISE_CARD_BUDGET * 1.5) / marginal);
      const docs = [
        ...Array.from({ length: premiseCount }, (_, i) => capPremise(i)),
        ...Array.from({ length: 20 }, (_, i) => saturatedIndexed(i)),
      ];
      const rendered = renderMemoryDocuments(docs);
      expect(rendered).toContain(DEMOTION_NOTE_HEAD);

      // 内訳の2つの数は、落とした1行の区分の数え上げと一致する。
      const note = rendered.slice(rendered.indexOf(DEMOTION_NOTE_HEAD));
      const matched = /（premise ([\d,]+) 件 \/ indexed ([\d,]+) 件。/.exec(note);
      expect(matched, '内訳が出ていない').not.toBeNull();
      const declaredPremise = Number((matched?.[1] ?? '0').replace(/,/g, ''));
      const declaredIndexed = Number((matched?.[2] ?? '0').replace(/,/g, ''));
      expect(declaredPremise + declaredIndexed).toBe(measureMemoryFloor(docs).demotedPremiseDocs);
      // **⚠️ 一覧の予算（MEMORY_PREMISE_STUB_BUDGET）で行が省かれうるので、
      // 内訳の数と「一覧に出ている行の数」は一致しない。** 内訳は落とした全件を
      // 数えた値であり、行はそこから予算で切ったものである——だから突き合わせる
      // 相手は measureMemoryFloor の側にした。
      expect(declaredPremise).toBeGreaterThan(0);
    });
  });

  it('⚠️ 前提の固定: カード1枚は束ねた予算より必ず小さい（だから「1枚は残す」枝は到達不能）', () => {
    const { marginal } = measureCardMarginalCost();
    expect(marginal).toBeLessThan(MEMORY_PREMISE_CARD_BUDGET);
    expect(MEMORY_PROMPT_DESCRIPTION_BUDGET + MEMORY_PROMPT_OUTLINE_BUDGET).toBeLessThan(
      MEMORY_PREMISE_CARD_BUDGET,
    );
  });
});

/**
 * 不変条件2（既定の振る舞いは1文字も変えない）を測る合成コーパス。
 *
 * **`indexed` を1件も含まない** —— `type` 無指定（none）・明示的な
 * premise・fact・malformed・未知の type の5文書。この配列の中身を変えたら、
 * `INVARIANT2_GOLDEN` も測り直すこと（外部の pre-PR ビルドとの突き合わせは
 * 報告の測定セクションを見よ）。
 */
const INVARIANT2_CORPUS: MemoryPart[] = [
  { slug: 'no-frontmatter', content: '# no-frontmatter\n本文A\n## 節A1\n中身A1' },
  {
    slug: 'explicit-premise',
    content:
      '---\ntype: premise\ndescription: 要旨B\n---\n# explicit-premise\n本文B\n## 節B1\n中身B1\n## 節B2\n中身B2',
  },
  { slug: 'fact-doc', content: '---\ntype: fact\ndescription: 要旨C\n---\n# fact-doc\n本文C' },
  { slug: 'broken', content: '---\nno colon here\n---\n# broken\n本文D' },
  {
    slug: 'unknown-type',
    content:
      '---\ntype: something-else\ndescription: 要旨E\n---\n# unknown-type\n本文E\n## 節E1\n中身E1',
  },
];

/**
 * `INVARIANT2_CORPUS` を `renderMemoryDocuments` に通した golden。
 *
 * **採取した実装**: この PR（`indexed` 追加後）の `renderMemoryDocuments`。
 * **突き合わせ**: 同じ `INVARIANT2_CORPUS`（コピー）を、base
 * `05c3d31ca07c3de800643cad1e50bfe5ab330d20` で独立にビルドした
 * `@alteroid/core` の `renderMemoryDocuments` へ通した出力と1文字も違わず
 * 一致することを、node スクリプトで確認済み（報告に生出力を記載）。
 */
const INVARIANT2_GOLDEN =
  '<!-- memory: no-frontmatter.md（premise・本文は載っていない。全 32 文字 / 2 節） -->\n要旨: （まだ書かれていない。memory_frontmatter_set の description で書くこと——ここが空だと、本文を開くまでこの文書が何なのか分からない）\n節（memory_section_read に節id を渡せば本文が開く。数字は文字数・子込み）:\n[5f35fd4b-d02c5e61] # no-frontmatter — 32 文字\n  [a200735a-6700831a] ## 節A1 — 11 文字\n\n<!-- memory: explicit-premise.md（premise・本文は載っていない。全 85 文字 / 3 節） -->\n要旨: 要旨B\n節（memory_section_read に節id を渡せば本文が開く。数字は文字数・子込み）:\n[d261b61a-c981527a] # explicit-premise — 46 文字\n  [0ca6eb3f-52241122] ## 節B1 — 12 文字\n  [e2d59aaf-2a39d6bb] ## 節B2 — 11 文字\n\n<!-- memory: frontmatter が壊れている（既知の形にならなかった。premise として扱っている） -->\n<!-- memory: broken.md（premise・本文は載っていない。全 34 文字 / 1 節） -->\n要旨: （まだ書かれていない。memory_frontmatter_set の description で書くこと——ここが空だと、本文を開くまでこの文書が何なのか分からない）\n節（memory_section_read に節id を渡せば本文が開く。数字は文字数・子込み）:\n[489e4048-1b0e31ad] # broken — 12 文字\n\n<!-- memory: unknown-type.md（premise・本文は載っていない。全 76 文字 / 2 節） -->\n要旨: 要旨E\n節（memory_section_read に節id を渡せば本文が開く。数字は文字数・子込み）:\n[9f0ec3f9-96417823] # unknown-type — 30 文字\n  [d6a625f1-9195a16d] ## 節E1 — 11 文字\n\n<!-- memory: index -->\n## 記憶の目次（fact。本文は memory_read で開く。階層はインデントで表す）\n- fact-doc: fact-doc — 要旨を書いた時刻が記録されていない: 要旨C';

/**
 * `indexed` — 第3の区分（2026-09-11 追加）。要旨だけが焼かれ、節の目次は
 * 焼かれない。**満たすべき不変条件は3つ**（依頼の設計の芯）:
 *
 * 1. ⭐⭐ `indexed` の床は、同じ文書を `premise` にしたときの床を絶対に超えない
 * 2. 既定の振る舞い（`type` 無指定・premise・fact・malformed・未知の値）は
 *    この PR の前後で1文字も変わらない
 * 3. `indexed` のカードでも「そこに何が在るか」（節数・全体の文字数）は
 *    失われない。節を開く手段（`memory_outline` → `memory_section_read`）を
 *    案内する
 */
describe('indexed — 第3の区分（要旨だけ。節の目次は焼かれない）', () => {
  /**
   * ⭐⭐ 不変条件1（歯で固定）。**定数どうしを比較する歯** — `indexed` の
   * 要旨予算と `premise` の要旨＋目次予算のどちらか一方だけが将来動くと、
   * この歯が赤くなる。
   */
  it('⭐⭐ MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET は premise の要旨予算＋目次予算より必ず小さい', () => {
    expect(MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET).toBeLessThan(
      MEMORY_PROMPT_DESCRIPTION_BUDGET + MEMORY_PROMPT_OUTLINE_BUDGET,
    );
    // 推奨値（6,000）そのものも固定する——変わったら気づけるように。
    expect(MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET).toBe(6_000);
  });

  it('indexed のカードには「本文は載っていない」（head）と「目次は載らない」（節の行）、節数・全体の文字数が出る', () => {
    // 節を複数持たせて、節数を確かめられるようにする。
    const withSections: MemoryPart = {
      slug: 'proj-only',
      content:
        '---\ndescription: 特定のプロジェクトでしか使わない記憶\ntype: indexed\n---\n' +
        '## 一\n本文1\n## 二\n本文2\n## 三\n本文3',
    };
    const rendered = renderMemoryDocuments([withSections]);

    expect(rendered).toContain('<!-- memory: proj-only.md（indexed・本文は載っていない。');
    // head は premise と同じ形（不変条件1 — 節0件のとき indexed と premise の
    // 床が一致してしまうのを避けるため、head に indexed 固有の説明は足さない。
    // `renderIndexedCard` の doc を見よ）。目次を焼かない旨は節の行に出る。
    expect(rendered).toContain('目次は載らない');
    // 「そこに何が在るか」——節数と全体の文字数（不変条件3）。
    expect(rendered).toContain(`全 ${withSections.content.length} 文字`);
    expect(rendered).toContain('/ 3 節');
    expect(rendered).toContain('要旨: 特定のプロジェクトでしか使わない記憶');
  });

  it('indexed は節の目次（節idの行）を1文字も焼かない（unlike premise）', () => {
    const content = '---\ntype: indexed\ndescription: 要旨\n---\n## 一\n本文1\n## 二\n本文2';
    const indexedRendered = renderMemoryDocuments([{ slug: 'doc', content }]);
    const premiseRendered = renderMemoryDocuments([
      { slug: 'doc', content: content.replace('type: indexed', 'type: premise') },
    ]);

    // premise 側には節idの行（`[hexhex-hexhex] 見出し — N 文字`）が出る。
    const sectionIdLine = /\[[0-9a-f]{8}-[0-9a-f]{8}\]/;
    expect(premiseRendered).toMatch(sectionIdLine);
    // indexed 側には出ない——節の目次を丸ごと持たない。
    expect(indexedRendered).not.toMatch(sectionIdLine);
    expect(indexedRendered).not.toContain('見出し');
  });

  it('indexed は節を開く手段（memory_outline → memory_section_read）を案内する。q= / offset= は名指ししない', () => {
    const content = '---\ntype: indexed\ndescription: 要旨\n---\n## 一\n本文1';
    const rendered = renderMemoryDocuments([{ slug: 'doc', content }]);

    expect(rendered).toContain('memory_outline');
    expect(rendered).toContain('memory_section_read');
    // ⚠️ q= / offset= は memory_outline へ足す別 PR が未マージなので名指ししない
    // （実行できない助言を書かない）。
    expect(rendered).not.toContain('q=');
    expect(rendered).not.toContain('offset=');
  });

  it('節が1つも無い indexed 文書は、memory_read で開く旨を出す（premise の0節分岐と同じ形）', () => {
    const rendered = renderMemoryDocuments([
      { slug: 'doc', content: '---\ntype: indexed\ndescription: 要旨\n---\n前書きだけ' },
    ]);
    expect(rendered).toContain('1つも無い');
    expect(rendered).toContain('memory_read');
  });

  /**
   * ⭐⭐ 不変条件1の実地版——測定した床（`measureMemoryFloor`）で、同じ文書を
   * `indexed` にしたときが `premise` にしたときを必ず下回ることを、複数の
   * 器（節数・要旨の長さを変えて）で確かめる。
   */
  it.each([
    { sections: 0, descLen: 10 },
    { sections: 3, descLen: 100 },
    { sections: 50, descLen: 4_000 },
    { sections: 300, descLen: 9_000 },
  ])(
    '⭐⭐ 同じ文書を premise にしたときより indexed にしたときのほうが床は必ず小さい（節 $sections・要旨 $descLen 文字）',
    ({ sections, descLen }) => {
      const body = Array.from({ length: sections }, (_, i) => `## 節${i}\n本文${i}`).join('\n');
      const description = 'あ'.repeat(descLen);
      const premiseDoc: MemoryPart = {
        slug: 'doc',
        content: `---\ndescription: ${description}\ntype: premise\n---\n${body}`,
      };
      const indexedDoc: MemoryPart = {
        slug: 'doc',
        content: `---\ndescription: ${description}\ntype: indexed\n---\n${body}`,
      };

      const premiseFloor = measureMemoryFloor([premiseDoc]);
      const indexedFloor = measureMemoryFloor([indexedDoc]);

      expect(indexedFloor.totalChars).toBeLessThan(premiseFloor.totalChars);
    },
  );

  it('measureMemoryFloor は indexedChars / indexedDocs / largestIndexed を返す（indexed 0件なら 0 / 0 / null）', () => {
    const onlyPremise = measureMemoryFloor([premise('p', '本文')]);
    expect(onlyPremise.indexedChars).toBe(0);
    expect(onlyPremise.indexedDocs).toBe(0);
    expect(onlyPremise.largestIndexed).toBeNull();

    const withIndexed = measureMemoryFloor([
      { slug: 'small', content: '---\ntype: indexed\ndescription: 小\n---\n## 一\n本文' },
      {
        slug: 'large',
        content: `---\ntype: indexed\ndescription: 大\n---\n${'## 節\n本文\n'.repeat(20)}`,
      },
    ]);
    expect(withIndexed.indexedDocs).toBe(2);
    expect(withIndexed.indexedChars).toBeGreaterThan(0);
    expect(withIndexed.largestIndexed?.slug).toBe('large');
  });

  /**
   * ⭐ 不変条件2（既定の振る舞いは1文字も変えない）。
   *
   * `indexed` を1件も含まない合成コーパス（`type` 無指定・premise・fact・
   * malformed・未知の type）を `renderMemoryDocuments` へ通し、出力を
   * 固定する（golden）。
   *
   * **この golden は post-PR の実装から採取したものだが、pre-PR（base
   * `05c3d31c`）で独立にビルドした `@alteroid/core` の同じ関数へ、
   * `INVARIANT2_CORPUS` と全く同じコーパスを通した出力と、1文字も違わず
   * 一致することを別途 node スクリプトで確認済み**（報告の測定セクションに
   * 実行コマンドと生出力を記載。このリポジトリの外の一時ビルドを使うため、
   * その突き合わせ自体はここには書けない——ここに書けるのは、その突き合わせ
   * で確認した値をこの歯で固定することだけである）。
   */
  it('⭐ 不変条件2: indexed を含まない合成コーパスの出力は、この PR の前後で1文字も変わらない（golden）', () => {
    const rendered = renderMemoryDocuments(INVARIANT2_CORPUS);
    expect(rendered).toBe(INVARIANT2_GOLDEN);
  });
});

describe('renderMemoryListing — `memory_list` 用の一覧。全区分を対象にする', () => {
  it('記憶が空なら空である旨を返す', () => {
    expect(renderMemoryListing([])).toBe('（記憶はまだ空）');
  });

  it('premise も fact も一覧に出る（premise は全文には出ないが一覧には出る）', () => {
    const listing = renderMemoryListing([
      {
        slug: 'p1',
        title: 'P1',
        kind: 'premise',
        description: undefined,
        descriptionFreshness: { kind: 'absent' },
        parent: undefined,
        updatedAt: '2026-08-21T00:00:00Z',
        createdAt: { kind: 'unknown' },
      },
      {
        slug: 'f1',
        title: 'F1',
        kind: 'fact',
        description: '要旨',
        descriptionFreshness: { kind: 'fresh' },
        parent: undefined,
        updatedAt: '2026-08-21T00:00:00Z',
        createdAt: { kind: 'unknown' },
      },
    ]);
    expect(listing).toContain('[premise] p1: P1');
    expect(listing).toContain('[fact] f1: F1');
    expect(listing).toContain('要旨');
  });

  /**
   * `memory_list` は7つのツールが横並びで持つ id + 名前 + 概要 + updated_at +
   * created_at のうち、`createdAt` を最後に足したもの（人間の依頼、逐語:
   * 「一覧系ツールは最低でも id + 名前 + 概要 + updated_at + created_at が
   * 欲しい」）。known / unknown を別々の `it()` にする——片方が通ると
   * もう片方も通ったように見える形にしないため。
   */
  it('createdAt が known なら ISO 時刻がそのまま出る', () => {
    const listing = renderMemoryListing([
      {
        slug: 'p1',
        title: 'P1',
        kind: 'premise',
        description: undefined,
        descriptionFreshness: { kind: 'absent' },
        parent: undefined,
        updatedAt: '2026-08-21T00:00:00Z',
        createdAt: { kind: 'known', at: '2026-01-02T03:04:05.000Z' },
      },
    ]);

    expect(listing).toContain('作成: 2026-01-02T03:04:05.000Z');
    expect(listing).toContain('更新: 2026-08-21T00:00:00Z');
  });

  /**
   * ⭐ 案4（`renderMemoryTocIssue` の `parent-not-listed`）の副作用が無いこと。
   *
   * `renderMemoryListing` は全区分（premise も fact も）を `entries` に含めて
   * `resolveMemoryHierarchy(tocEntries)` を呼ぶ——`elsewhere` を渡さない。
   * だから親が premise でも `bySlug` に直接見つかり、新しい3つ目の状態
   * （`parent-not-listed`）は構造的に起こりえない（既定値が空集合なので、
   * `renderMemoryToc` 側の変更はこの経路に一切効かない）。ここではそれを
   * 実際の出力で確かめる——親が premise を指す fact が、印を1つも出さずに
   * 通常どおり親子で解決されること。
   */
  it('⭐ 親が premise を指していても、一覧では通常どおり解決する（案4の副作用が無い）', () => {
    const listing = renderMemoryListing([
      {
        slug: 'core',
        title: 'Core',
        kind: 'premise',
        description: undefined,
        descriptionFreshness: { kind: 'absent' },
        parent: undefined,
        updatedAt: '2026-08-21T00:00:00Z',
        createdAt: { kind: 'unknown' },
      },
      {
        slug: 'child',
        title: 'Child',
        kind: 'fact',
        description: '子',
        descriptionFreshness: { kind: 'fresh' },
        parent: 'core',
        updatedAt: '2026-08-21T00:00:00Z',
        createdAt: { kind: 'unknown' },
      },
    ]);

    expect(listing).toContain('[premise] core: Core');
    expect(listing).toContain('[fact] child: Child');
    expect(listing).not.toContain('見つからない');
    expect(listing).not.toContain('列挙する');
    expect(listing).not.toContain('循環');
  });

  it('createdAt が unknown なら「不明」と明言する（空文字で隠さない）', () => {
    const listing = renderMemoryListing([
      {
        slug: 'p1',
        title: 'P1',
        kind: 'premise',
        description: undefined,
        descriptionFreshness: { kind: 'absent' },
        parent: undefined,
        updatedAt: '2026-08-21T00:00:00Z',
        createdAt: { kind: 'unknown' },
      },
    ]);

    expect(listing).toContain('作成: 不明');
    // 「作成: 」で終わって空になっていないこと（取れないことが出力から消えない）。
    expect(listing).not.toMatch(/作成: $/m);
    expect(listing).not.toMatch(/作成: \/ /);
  });

  /**
   * #821 — 「⚠古い要旨」が12/12で鳴って信号を失っていた欠陥の直し。
   *
   * **語ではなく数で測る（条件2）。** `staleForMs` を変えると出力の文字列
   * そのものが変わることを、1時間差・30日差の2点で撃つ——`toContain` で
   * 固定の語（例えば「古い」）だけを探すと、実装が数を無視して固定文字列を
   * 返す変異が生き残る。ここでは実際の数値を含む文字列を要求する。
   */
  it('stale の印は差の大きさで文字列が変わる（1時間差と30日差、条件2）', () => {
    const entry = (staleForMs: number) => ({
      slug: 'stale-doc',
      title: 'Stale',
      kind: 'fact' as const,
      description: '要旨',
      descriptionFreshness: { kind: 'stale' as const, staleForMs },
      parent: undefined,
      updatedAt: '2026-08-21T00:00:00Z',
      createdAt: { kind: 'unknown' as const },
    });

    const oneHour = renderMemoryListing([entry(60 * 60 * 1000)]);
    const thirtyDays = renderMemoryListing([entry(30 * 24 * 60 * 60 * 1000)]);

    expect(oneHour).toContain('要旨は本文より1時間古い');
    expect(thirtyDays).toContain('要旨は本文より30日古い');
    // 数を変えたら文字列も変わる——固定文字列を返す変異はここで生存できない。
    expect(oneHour).not.toBe(thirtyDays);
  });

  /**
   * 条件1: 「取れなかった」（describedAt が無い＝ unknown）と「0（＝最新）」
   * （fresh）を同じ言葉にしない。**unknown を stale の0日版として出さない**
   * ——読み手が「0日ぶん新しい＝いちばん新しい＝手を入れなくてよい」と
   * 誤読するのを防ぐ（#821 コメント、クローンの決定）。
   */
  it('unknown（記録なし）と fresh（正直なゼロ）は別の言葉で出る（条件1）', () => {
    const entry = (descriptionFreshness: { kind: 'fresh' | 'unknown' }) => ({
      slug: 'doc',
      title: 'Doc',
      kind: 'fact' as const,
      description: '要旨',
      descriptionFreshness,
      parent: undefined,
      updatedAt: '2026-08-21T00:00:00Z',
      createdAt: { kind: 'unknown' as const },
    });

    const fresh = renderMemoryListing([entry({ kind: 'fresh' })]);
    const unknown = renderMemoryListing([entry({ kind: 'unknown' })]);

    expect(fresh).not.toBe(unknown);
    // unknown 側に「古い」の文字列や日数表現が紛れ込んでいないこと
    // （「0日ぶん新しい」のような誤読を招く文言を禁じる）。
    expect(unknown).not.toMatch(/\d+(秒|分|時間|日)/);
    expect(unknown).toContain('記録されていない');
    expect(fresh).not.toContain('記録されていない');
    expect(fresh).toContain('本文は動いていない');
  });

  /**
   * 条件3: ⚠ を消したことで「何も言わなくなる」文書が出ないか。
   * `absent`（要旨そのものが無い）だけは何も出さない設計だが、
   * `fresh` / `stale` / `unknown` は要旨がある限り必ず何か言う
   * （「常に出す」設計。「古いときだけ出す」なら fresh は何も言わない）。
   */
  it('要旨がある文書（fresh / stale / unknown）は必ず何か言う。absent だけ何も出さない（条件3）', () => {
    const base = {
      slug: 'doc',
      title: 'Doc',
      kind: 'fact' as const,
      parent: undefined,
      updatedAt: '2026-08-21T00:00:00Z',
      createdAt: { kind: 'unknown' as const },
    };
    const fresh = renderMemoryListing([
      { ...base, description: '説明', descriptionFreshness: { kind: 'fresh' as const } },
    ]);
    const stale = renderMemoryListing([
      {
        ...base,
        description: '説明',
        descriptionFreshness: { kind: 'stale' as const, staleForMs: 1000 },
      },
    ]);
    const unknown = renderMemoryListing([
      { ...base, description: '説明', descriptionFreshness: { kind: 'unknown' as const } },
    ]);
    const absent = renderMemoryListing([
      { ...base, description: undefined, descriptionFreshness: { kind: 'absent' as const } },
    ]);

    // fresh/stale/unknown は「説明」の前に必ず何か文字が入る（—description という
    // 剥き出しの形にならない）。
    expect(fresh).not.toContain('— 説明');
    expect(stale).not.toContain('— 説明');
    expect(unknown).not.toContain('— 説明');
    // absent は description が無いので、そもそも「— 」の区切りごと出ない。
    expect(absent).not.toContain(' — ');
  });

  /**
   * **上限は件数ではなく文字数である。**
   *
   * #170 が入れた `MEMORY_TOC_ENTRY_LIMIT`（300件）はプロンプトへ焼く目次
   * （`renderMemoryToc`）にだけ効いていて、道具の側（`memory_list`）は全件を
   * 返していた。そして件数だけでは足りない——300件 × 1行200字で 60,000 字になり、
   * `manager_list` が実際に溢れた 52,997 字を超える。
   */
  /**
   * `description` の長さは呼び手が指定できるようにしてある。
   *
   * **「1行の抜粋」と「一覧の打ち切り」は別の省略である。** 長い要旨を渡すと
   * 1行ごとに `excerptLine` の注記（「…文字省略」）が付くので、素朴に `'省略'`
   * を探すと一覧を切っていなくても当たる。**2つを1つの語で測らない。**
   */
  function docs(count: number, descriptionLength = 40) {
    return Array.from({ length: count }, (_, index) => ({
      slug: `doc-${index}`,
      title: `題${index}`,
      kind: 'fact' as const,
      description: 'あ'.repeat(descriptionLength),
      descriptionFreshness: { kind: 'fresh' as const },
      parent: undefined,
      updatedAt: '2026-08-21T00:00:00Z',
      createdAt: { kind: 'unknown' as const },
    }));
  }

  it('文書が増えても、一覧は文字数の予算に収まる', () => {
    const listing = renderMemoryListing(docs(500));

    expect(listing.length).toBeLessThan(MEMORY_LISTING_BUDGET + 500);
  });

  it('要旨が長くても、一覧は文字数の予算に収まる', () => {
    // 件数だけを上限にしていると、ここが 300件 × 200字 = 60,000 字になる。
    const listing = renderMemoryListing(docs(500, 400));

    expect(listing.length).toBeLessThan(MEMORY_LISTING_BUDGET + 500);
  });

  it('切ったなら黙らない（出した件数・全体の件数・全文の取り方が出る）', () => {
    const listing = renderMemoryListing(docs(500));

    // 一覧を切ったことは「N 件は省略」で言う（1行の抜粋の注記とは別の文言）
    expect(listing).toMatch(/ほか \d+ 件は省略/);
    expect(listing).toContain('全 500 件');
    // 一覧から落ちた文書へも行けること（落ちた＝到達できないでは能力の削除になる）
    expect(listing).toContain('memory_read');
  });

  it('予算に収まる件数なら、一覧の断り書きを付けない', () => {
    const listing = renderMemoryListing(docs(3));

    expect(listing).not.toMatch(/件は省略/);
  });
});

/**
 * #913: 「時間差だけでは、いちばん手が入っている文書がいちばん新しく見える」
 * ——#821 が測った `staleForMs`（`describedAt` と `updatedAt` の時間差）は
 * 「要旨がどれだけ前に古くなったか」しか言えず、「その間に本文がどれだけ
 * 変わったか（本文の変化量）」を持っていない。
 *
 * ⚠️⚠️ **これは2手目（歯を先に書く手）である。実装（`memory.ts` の本体・
 * ストア・表示）は1文字も変えていない。** ここに置く歯は、契約
 * （マネージャーが確定させた設計）が実装される前に書いた「失敗する歯」で
 * あり、現時点では赤くなることを狙っている（一部は #821 と同じ理由で
 * 現時点でも緑になりうる——各 it() のコメントに実測を書く）。
 *
 * **狙う契約（マネージャー確定）:**
 * - `MemoryDescriptionFreshness` の `stale` に `drift: MemoryDescriptionDrift`
 *   を足す。`measured`（`describedBytes` / `currentBytes` / 符号付き
 *   `deltaBytes`）と `unrecorded`（記録が無い＝0ではない）の2状態
 * - `fresh` には `drift` を持たせない（drift は stale 専用）
 *
 * ここではまだ実装されていない `drift` を、あたかも在るかのように
 * `descriptionFreshness` へ直接埋め込んで `renderMemoryListing` を呼ぶ
 * ——実装（`memoryFreshnessMarker` 等）がまだ `drift` を1文字も読んでいない
 * ので、出力に変化量の数値が現れず、下の `it()` は赤くなるはずである。
 */
describe('#913: 要旨の鮮度は時間差だけでなく本文の変化量も運ぶ（契約のみ。実装はまだ無い）', () => {
  /** 本文が実際にどれだけ変わったか（`drift`）を埋め込んだ1件を作る。 */
  function driftEntry(
    slug: string,
    staleForMs: number,
    drift:
      | { kind: 'measured'; describedBytes: number; currentBytes: number; deltaBytes: number }
      | { kind: 'unrecorded' },
  ) {
    return {
      slug,
      title: slug,
      kind: 'fact' as const,
      description: '要旨',
      // ⚠️ `drift` はまだ `MemoryDescriptionFreshness` の型に無い。ここでは
      // 契約が実装された後の形を先取りして埋め込んでいる（vitest は tsc を
      // 通さないので、型エラーではなく実行時の assert 差分として赤くなる）。
      descriptionFreshness: { kind: 'stale' as const, staleForMs, drift } as unknown as MemoryDescriptionFreshness,
      parent: undefined,
      updatedAt: '2026-08-21T00:00:00Z',
      createdAt: { kind: 'unknown' as const },
    };
  }

  /** 一覧の中から `slug` の行を取り出し、符号付きのバイト変化量を読む。無ければ null。 */
  function extractByteDelta(listing: string, slug: string): number | null {
    const line = listing.split('\n').find((l) => l.includes(`${slug}:`));
    if (line === undefined) return null;
    const match = /([+-])\s*([\d,]+)\s*バイト/.exec(line);
    if (match === null) return null;
    const sign = match[1] === '-' ? -1 : 1;
    return sign * Number(match[2].replace(/,/g, ''));
  }

  /**
   * 歯1（本題の再現）。#913 の表そのもの——
   * 文書A: 要旨から30日、本文は+200バイト。文書B: 要旨から1時間、本文は+60,000バイト。
   *
   * **測るのは「語がある」ではなく「読み手が B を先に選べるか」——数として
   * B の変化量が A より大きいことを直接比較する。** 時間差だけで見れば
   * A（30日）のほうが「古い」が、本文の変化量で見れば B のほうが桁違いに
   * 大きく動いている、というのが #913 の指摘そのものである。
   */
  it('⭐ 30日で+200バイトの文書より、1時間で+60,000バイト変わった文書のほうが、変化量としては大きいと数で分かる', () => {
    const barelyTouchedInAMonth = driftEntry('doc-a', 30 * 24 * 60 * 60 * 1000, {
      kind: 'measured',
      describedBytes: 1000,
      currentBytes: 1200,
      deltaBytes: 200,
    });
    const heavilyEditedInAnHour = driftEntry('doc-b', 60 * 60 * 1000, {
      kind: 'measured',
      describedBytes: 1000,
      currentBytes: 61000,
      deltaBytes: 60000,
    });

    const listing = renderMemoryListing([barelyTouchedInAMonth, heavilyEditedInAnHour]);

    const deltaA = extractByteDelta(listing, 'doc-a');
    const deltaB = extractByteDelta(listing, 'doc-b');

    expect(deltaA).not.toBeNull();
    expect(deltaB).not.toBeNull();
    expect(deltaB as number).toBeGreaterThan(deltaA as number);
  });

  /**
   * ⛔ `toContain('60,000')` だけで済ませない——数を変えたら出力も変わる
   * ことを、2点（200 バイトと 60,000 バイト）で直接確かめる。固定文字列を
   * 返す変異はここで生存できない。
   */
  it('⭐ 変化量の数を変えると出力も変わる（語ではなく数で測る。200バイトと60,000バイトの2点）', () => {
    const small = renderMemoryListing([
      driftEntry('doc', 60 * 60 * 1000, {
        kind: 'measured',
        describedBytes: 1000,
        currentBytes: 1200,
        deltaBytes: 200,
      }),
    ]);
    const large = renderMemoryListing([
      driftEntry('doc', 60 * 60 * 1000, {
        kind: 'measured',
        describedBytes: 1000,
        currentBytes: 61000,
        deltaBytes: 60000,
      }),
    ]);

    expect(small).not.toBe(large);
    expect(extractByteDelta(small, 'doc')).toBe(200);
    expect(extractByteDelta(large, 'doc')).toBe(60000);
  });

  /**
   * 歯2-1（陰性対照）。#821 が名指しした失敗——「検出する歯だけ置くと決定の
   * 巻き戻しが通る」——と同じ形をここでも避ける。`unrecorded`（記録が無い）
   * を「0バイト変わった」（measured, deltaBytes: 0）と同じ言葉にしないこと。
   * #821 の条件1（「取れなかった」と「0」を混ぜない）の、変化量版である。
   */
  it('⭐⭐ 陰性対照1: unrecorded（記録なし）と「0バイト変わった」は別の言葉で出る（#821 条件1と同じ形）', () => {
    const unrecorded = renderMemoryListing([
      driftEntry('doc', 60 * 60 * 1000, { kind: 'unrecorded' }),
    ]);
    const zeroChanged = renderMemoryListing([
      driftEntry('doc', 60 * 60 * 1000, {
        kind: 'measured',
        describedBytes: 1000,
        currentBytes: 1000,
        deltaBytes: 0,
      }),
    ]);

    expect(unrecorded).not.toBe(zeroChanged);
    expect(extractByteDelta(unrecorded, 'doc')).toBeNull();
    expect(unrecorded).toContain('記録されていない');
    expect(zeroChanged).not.toContain('記録されていない');
  });

  /**
   * 歯2-2（陰性対照）。本文が縮んだ文書（`deltaBytes < 0`）を「変わって
   * いない」（`deltaBytes === 0`）と同じ表示にしない——減った側を「変わって
   * いない」に畳むと、実質的な改変（削って書き直した等）を見逃す。
   */
  it('⭐⭐ 陰性対照2: 本文が縮んだ文書（負の変化量）は「変わっていない」と同じ表示にならない', () => {
    const shrunk = renderMemoryListing([
      driftEntry('doc', 60 * 60 * 1000, {
        kind: 'measured',
        describedBytes: 1000,
        currentBytes: 800,
        deltaBytes: -200,
      }),
    ]);
    const unchanged = renderMemoryListing([
      driftEntry('doc', 60 * 60 * 1000, {
        kind: 'measured',
        describedBytes: 1000,
        currentBytes: 1000,
        deltaBytes: 0,
      }),
    ]);

    expect(shrunk).not.toBe(unchanged);
    expect(extractByteDelta(shrunk, 'doc')).toBe(-200);
  });

  /**
   * 歯2-3（陰性対照）。`drift` は `stale`専用の契約——`fresh` の文書には
   * 変化量が出てはいけない。#821 が直した「常に鳴る印」（12/12 文書で ⚠ が
   * 付いていた欠陥）と同じ形に戻っていないかを確かめる。
   *
   * ⚠️ この it() は、実装が無い現時点でも**すでに緑になりうる**
   * （`fresh` はそもそもどんな変化量も出力しないため）。実装が入った後の
   * 回帰を防ぐための歯として、あえて先に置いている——実測は報告に書く。
   */
  it('⭐⭐ 陰性対照3: fresh の文書には変化量が出ない（stale 以外へ漏れていない）', () => {
    const fresh = renderMemoryListing([
      {
        slug: 'doc',
        title: 'Doc',
        kind: 'fact' as const,
        description: '要旨',
        descriptionFreshness: { kind: 'fresh' as const },
        parent: undefined,
        updatedAt: '2026-08-21T00:00:00Z',
        createdAt: { kind: 'unknown' as const },
      },
    ]);

    expect(extractByteDelta(fresh, 'doc')).toBeNull();
    expect(fresh).not.toMatch(/バイト/);
  });
});

/**
 * 節（section）の走査・節id・切り取り・目次（#318 案 (b)）。
 *
 * **ここで測るのは純粋関数だけである。** ストア（3実装）を通す性質は
 * `tools.test.ts` の側に置く——節の切り分けそのものは `content` から
 * `content` への関数なので、器を替えても答えは変わらない。
 */
describe('記憶の節（memory_outline / memory_section_move、#318 案 (b)）', () => {
  const withFrontmatter = [
    '---',
    'description: 私について',
    'type: premise',
    '---',
    '前書きである（節ではない）。',
    '',
    '# 私について',
    '本文A',
    '',
    '## 経歴',
    '本文B',
    '',
    '### だから',
    '本文C',
    '',
    '#### さらに',
    '本文D',
    '',
    '## 例',
    '本文E',
    '',
  ].join('\n');

  const headingsOf = (content: string): string[] =>
    scanMemorySections(content).sections.map((section) => section.heading);

  it('frontmatter は節ではない（本文の始まりより前を1つも節にしない）', () => {
    const scan = scanMemorySections(withFrontmatter);

    expect(scan.bodyStart).toBe(memoryBodyStart(withFrontmatter));
    // frontmatter の3行はどの節にも入らない。
    for (const section of scan.sections)
      expect(section.start).toBeGreaterThanOrEqual(scan.bodyStart);
    expect(headingsOf(withFrontmatter)).toEqual([
      '# 私について',
      '## 経歴',
      '### だから',
      '#### さらに',
      '## 例',
    ]);
  });

  it('最初の見出しより前の前書きは節ではない（指す値が発行されない）', () => {
    const scan = scanMemorySections(withFrontmatter);
    const first = scan.sections[0];

    expect(first?.heading).toBe('# 私について');
    // 前書き（「前書きである（節ではない）。」）は最初の節の外に在る。
    expect(withFrontmatter.slice(scan.bodyStart, first?.start)).toContain('前書きである');
    for (const section of scan.sections) {
      expect(withFrontmatter.slice(section.start, section.end)).not.toContain('前書きである');
    }
  });

  /**
   * 節の範囲（子込み）。**「同じ深さ以下」を「同じ深さ」に狭めると壊れる。**
   * `###` の節が次の `##` で終わらなくなり、子でないものを子として運ぶ。
   */
  it('節は「同じ深さ以下の次の見出しの直前」で終わる（### は次の ## で終わり、次の #### では終わらない）', () => {
    const sections = scanMemorySections(withFrontmatter).sections;
    const dakara = sections.find((section) => section.heading === '### だから');
    const body = withFrontmatter.slice(dakara?.start, dakara?.end);

    // `#### さらに` は子なので含む（次の #### では終わらない）。
    expect(body).toContain('#### さらに');
    expect(body).toContain('本文D');
    // `## 例` は同じ深さ以下なので、その直前で終わる。
    expect(body).not.toContain('## 例');
    expect(body).not.toContain('本文E');
  });

  it('各節の文字数は子込みである（移したときに動く量が、呼ぶ前に分かる）', () => {
    const sections = scanMemorySections(withFrontmatter).sections;
    const keireki = sections.find((section) => section.heading === '## 経歴');
    const dakara = sections.find((section) => section.heading === '### だから');
    const sarani = sections.find((section) => section.heading === '#### さらに');

    expect(keireki?.chars).toBe((keireki?.end ?? 0) - (keireki?.start ?? 0));
    // 親の文字数は子を含む（子の分を足し合わせるのではなく、包含関係で測る
    // ——子の子を二重に数えないため）。
    expect(keireki?.chars).toBeGreaterThan(dakara?.chars ?? 0);
    expect(dakara?.chars).toBeGreaterThan(sarani?.chars ?? 0);
  });

  describe('節id は「指し先」であると同時に「版の照合」である', () => {
    it('中身が変われば id が変わる（＝読んだ後の書き換えを検出できる）', () => {
      const before = scanMemorySections(withFrontmatter).sections.find(
        (section) => section.heading === '## 例',
      );
      const after = scanMemorySections(
        withFrontmatter.replace('本文E', '本文E（直した）'),
      ).sections.find((section) => section.heading === '## 例');

      expect(before?.id).not.toBe(after?.id);
    });

    /**
     * **文書全体のハッシュを ETag にする形との決定的な違いがここである。**
     * 無関係な節が動いただけで断られるようになると、この道具は使えなくなる。
     */
    it('他の節が変わっても id は変わらない（無関係な変更で誤検出しない）', () => {
      const before = scanMemorySections(withFrontmatter).sections.find(
        (section) => section.heading === '## 例',
      );
      const after = scanMemorySections(
        withFrontmatter.replace('本文A', '本文A（別の節を直した）'),
      ).sections.find((section) => section.heading === '## 例');

      expect(after?.id).toBe(before?.id);
    });

    /**
     * **例外を1つ、仕様として固定する。** 節の範囲は子を含むので、子を
     * 動かすと親の中身が実際に変わる＝親の id も変わる。正しい振る舞い
     * だが呼び手は驚くので、`memorySectionId` の doc に書いてある。
     */
    it('入れ子の子を移すと、親の id は変わる（子は親の中身だから）', () => {
      const scan = scanMemorySections(withFrontmatter);
      const parentBefore = scan.sections.find((section) => section.heading === '### だから');
      const child = scan.sections.find((section) => section.heading === '#### さらに');
      const { nextContent } = cutMemorySections(withFrontmatter, [child as never]);
      const parentAfter = scanMemorySections(nextContent).sections.find(
        (section) => section.heading === '### だから',
      );

      expect(parentAfter).toBeDefined();
      expect(parentAfter?.id).not.toBe(parentBefore?.id);
    });

    it('見出しが同じで中身も同じ節は、同じ id になる（曖昧さが id に現れる）', () => {
      // **末尾の空行まで一致させる。** 節の範囲は「次の見出しの直前」までなので、
      // 最後の節だけ末尾の改行の数が違うと、それだけで別の id になる。
      const doc = '# A\n本文\n\n# A\n本文\n\n# B\n終わり\n';
      const [first, second] = scanMemorySections(doc).sections;

      expect(first?.id).toBe(second?.id);
      expect(lookupMemorySection(scanMemorySections(doc).sections, first?.id as string).kind).toBe(
        'ambiguous',
      );
    });

    it('memorySectionId は「見出しだけのハッシュ」と「見出し＋中身のハッシュ」を繋いだ形である', () => {
      // 前半は見出しだけで決まるので、中身が変わっても動かない。
      const a = memorySectionId('## 経歴', '本文B\n');
      const b = memorySectionId('## 経歴', '別の本文\n');
      const c = memorySectionId('## 別の見出し', '本文B\n');

      expect(a.split('-')[0]).toBe(b.split('-')[0]);
      expect(a.split('-')[1]).not.toBe(b.split('-')[1]);
      expect(a.split('-')[0]).not.toBe(c.split('-')[0]);
    });
  });

  describe('lookupMemorySection は「無い」と「古い」を畳まない', () => {
    const sections = () => scanMemorySections(withFrontmatter).sections;

    it('その id の節が在れば found', () => {
      const target = sections().find((section) => section.heading === '## 経歴');

      expect(lookupMemorySection(sections(), target?.id as string)).toMatchObject({
        kind: 'found',
      });
    });

    it('見出しが一致するが中身のハッシュが違うなら stale（誰かが書き換えた）', () => {
      const target = sections().find((section) => section.heading === '## 経歴');
      const stale = `${(target?.id as string).split('-')[0]}-00000000`;

      expect(lookupMemorySection(sections(), stale)).toMatchObject({ kind: 'stale' });
    });

    it('見出しごと一致しないなら absent（打ち間違い・別の文書）', () => {
      expect(lookupMemorySection(sections(), 'deadbeef-cafebabe')).toMatchObject({
        kind: 'absent',
      });
    });
  });

  /**
   * ⚠️⚠️ **走査が2本であることを、意図として固定する歯。**
   *
   * 同じ文書に対して、片方（差分の要約の検出器 `extractMemoryHeadings`）は
   * コードフェンスの中の `#` 行を**拾い**、もう片方（節の境界の決定器
   * `scanMemorySections`）は**拾わない**。
   *
   * **食い違いではなく、向きが逆だから2本在る**——検出器は拾いすぎる側
   * （見落とすと気づく手段が無い）、決定器は拾わない側（拾いすぎると
   * フェンスが片方だけ残って静かに壊れる）へ倒してある。
   *
   * **1つの `it()` で並べて assert しているのは、どちらか片方を「直して」
   * 1本にまとめようとする変更を、必ずここで止めるためである。**
   * `extractMemoryHeadings` は export されていないので、その実際の呼び手
   * （`describeMemoryWriteDiff`）を通して測る——本物の経路で測るぶん、
   * 直接呼ぶより強い。
   */
  it('走査は2本である: 差分の要約はフェンスの中の見出しを拾い、節の境界は拾わない', () => {
    const fenced = [
      '# ログ',
      '',
      '## 例',
      '```sh',
      '## これは見出しではない',
      'echo hi',
      '```',
      '本文',
      '',
    ].join('\n');

    // (1) 節の境界の決定器 — フェンスの中の `##` を節にしない。
    expect(headingsOf(fenced)).toEqual(['# ログ', '## 例']);

    // (2) 差分の要約の検出器 — フェンスの中の `##` を見出しとして数える
    //     （だからフェンスごと消すと「消えた見出し」として名指しされる）。
    const withoutFence = ['# ログ', '', '## 例', '本文', ''].join('\n');
    expect(describeMemoryWriteDiff(fenced, withoutFence)).toContain('## これは見出しではない');
  });

  it('コードフェンスの中の見出しを節の境界にしないので、移した後もフェンスの開閉が揃う', () => {
    const fenced = [
      '# ログ',
      '',
      '## 例',
      '```sh',
      '## これは見出しではない',
      'echo hi',
      '```',
      '本文E',
      '',
      '## 次',
      '本文F',
      '',
    ].join('\n');
    const target = scanMemorySections(fenced).sections.find(
      (section) => section.heading === '## 例',
    );
    const { nextContent, cut } = cutMemorySections(fenced, [target as never]);

    // 切り取った側にフェンスが丸ごと入っている（開きと閉じが同数）。
    expect((cut.match(/^```/gm) ?? []).length).toBe(2);
    // 残った側にはフェンスが1つも残っていない（片方だけ残っていない）。
    expect((nextContent.match(/^```/gm) ?? []).length).toBe(0);
    expect(nextContent).toContain('## 次');
    expect(nextContent).not.toContain('echo hi');
  });

  it('~~~ のフェンスも追う（``` だけを見ていない）', () => {
    const fenced = ['# ログ', '~~~', '## 中', '~~~', '本文', ''].join('\n');

    expect(headingsOf(fenced)).toEqual(['# ログ']);
  });

  it('開いたまま閉じないフェンスは、そこから先を全部フェンスの中とみなす（拾わない側へ倒す）', () => {
    const broken = ['# ログ', '```sh', '## 閉じていない', '本文', ''].join('\n');

    expect(headingsOf(broken)).toEqual(['# ログ']);
  });

  describe('cutMemorySections は継ぎ足しである（frontmatter を書き直さない）', () => {
    it('frontmatter のバイト列が1バイトも変わらない（キーの順序も空白も含めて）', () => {
      // わざとキーの順序を `type` → `description` にし、余分な空白も入れる。
      const doc = [
        '---',
        'type:  premise',
        'description:   私について',
        '---',
        '# A',
        '本文',
        '',
        '# B',
        '本文',
        '',
      ].join('\n');
      const scan = scanMemorySections(doc);
      const target = scan.sections.find((section) => section.heading === '# A');
      const { nextContent } = cutMemorySections(doc, [target as never]);

      expect(nextContent.slice(0, scan.bodyStart)).toBe(doc.slice(0, scan.bodyStart));
      expect(nextContent).toContain('type:  premise');
      expect(nextContent).toContain('description:   私について');
      expect(nextContent).not.toContain('# A');
    });

    it('切り取った文字列と残った文字列を繋ぐと、必ず元に戻る（1文字も落とさない・増やさない）', () => {
      const scan = scanMemorySections(withFrontmatter);
      for (const section of scan.sections) {
        const { nextContent, cut } = cutMemorySections(withFrontmatter, [section]);
        expect(nextContent.slice(0, section.start) + cut + nextContent.slice(section.start)).toBe(
          withFrontmatter,
        );
      }
    });
  });

  /**
   * `cutMemorySections` の複数節版（`memory_section_move` が1回で複数の節id を
   * 移せるようにするために足した）。上の「1節だけ」の歯とは別に、**複数・
   * 飛び飛び・逆順**の3つを固定する。
   */
  describe('cutMemorySections（複数節をまとめて切り取る）', () => {
    /** 兄弟が3つ並ぶだけの単純な文書。中の1つ（B）を飛ばして A・C だけを選ぶ。 */
    const multiDoc = [
      '---',
      'type:  premise',
      'description:   複数節',
      '---',
      '# A',
      '本文A',
      '',
      '# B',
      '本文B',
      '',
      '# C',
      '本文C',
      '',
    ].join('\n');
    const find = (heading: string): MemorySection =>
      scanMemorySections(multiDoc).sections.find(
        (section) => section.heading === heading,
      ) as MemorySection;

    it('cutMemorySections は継ぎ足しである — 切り取った文字列と残った文字列から元が復元できる（複数節・飛び飛びでも）', () => {
      const a = find('# A');
      const b = find('# B');
      const c = find('# C');
      const header = multiDoc.slice(0, a.start);
      const pieceA = multiDoc.slice(a.start, a.end);
      const pieceB = multiDoc.slice(b.start, b.end);
      const pieceC = multiDoc.slice(c.start, c.end);

      // B を飛ばして A と C だけを切り取る（飛び飛び）。
      const { nextContent, cut } = cutMemorySections(multiDoc, [a, c]);

      // 残った側には間の B だけが残る。
      expect(nextContent).toBe(header + pieceB);
      // 切り取った側は A と C（文書に現れる順で繋がる）。
      expect(cut).toBe(pieceA + pieceC);
      // 3つの断片を正しい位置へ並べ直すと元の文書に戻る
      // ——これが「継ぎ足しである」ことの中身である。
      expect(header + pieceA + pieceB + pieceC).toBe(multiDoc);
    });

    it('cutMemorySections は frontmatter のバイト列を1バイトも動かさない（複数節でも）', () => {
      const scan = scanMemorySections(multiDoc);

      const { nextContent } = cutMemorySections(multiDoc, [find('# A'), find('# C')]);

      expect(nextContent.slice(0, scan.bodyStart)).toBe(multiDoc.slice(0, scan.bodyStart));
      expect(nextContent).toContain('type:  premise');
      expect(nextContent).toContain('description:   複数節');
    });

    it('cutMemorySections は渡す順に依存しない（逆順に渡しても結果が同じ）', () => {
      const a = find('# A');
      const c = find('# C');

      const forward = cutMemorySections(multiDoc, [a, c]);
      const backward = cutMemorySections(multiDoc, [c, a]);

      expect(backward).toEqual(forward);
    });
  });

  describe('findOverlappingMemorySections（範囲の重なりの検査）', () => {
    const sections = () => scanMemorySections(withFrontmatter).sections;
    const find = (heading: string): MemorySection =>
      sections().find((section) => section.heading === heading) as MemorySection;

    it('親と子を同時に指すと重なりとして拾う（end は子込みなので、親を切ると子も一緒に動く）', () => {
      const parent = find('## 経歴');
      const child = find('### だから');

      const overlap = findOverlappingMemorySections([parent, child]);

      expect(overlap).not.toBeNull();
      expect([overlap?.first.heading, overlap?.second.heading]).toEqual(['## 経歴', '### だから']);
    });

    it('同じ節id を2回渡すのも重なりとして拾う（範囲が完全に一致する）', () => {
      const section = find('## 例');

      expect(findOverlappingMemorySections([section, section])).not.toBeNull();
    });

    it('隣り合う兄弟は重なりではない（誤検出しない。渡す順にも依存しない）', () => {
      const keireki = find('## 経歴');
      const rei = find('## 例');

      expect(findOverlappingMemorySections([keireki, rei])).toBeNull();
      expect(findOverlappingMemorySections([rei, keireki])).toBeNull();
    });

    it('空配列・1件だけなら null（重なりようがない）', () => {
      expect(findOverlappingMemorySections([])).toBeNull();
      expect(findOverlappingMemorySections([find('## 経歴')])).toBeNull();
    });
  });

  it('memoryBodyStart は frontmatterBody（applyMemoryFrontmatterPatch が使う側）と一致する', () => {
    // 本文の始まりが2つの実装に分かれると、frontmatter を添字で運ぶ側が
    // 本文の一部を frontmatter として運ぶ形で壊れる。同じ答えであることを固定する。
    const cases = [
      '---\ndescription: x\n---\n# A\n本文\n',
      '---\ndescription: x\n---\n',
      '---\ndescription: x\n---',
      '# A\n本文\n',
      '---\n閉じが無い\n# A\n',
      '',
    ];
    for (const content of cases) {
      // `applyMemoryFrontmatterPatch` は本文をそのまま後ろへ繋ぎ直すので、
      // 「本文」の側が食い違えば必ずこの等式が破れる。
      const patched =
        parseMemoryFrontmatter(content).kind === 'malformed'
          ? null
          : applyMemoryFrontmatterPatch(content, {});
      if (patched !== null)
        expect(patched.endsWith(content.slice(memoryBodyStart(content)))).toBe(true);
    }
  });

  /**
   * 予算（`MEMORY_OUTLINE_BUDGET`）を確実に超える文書を組む。
   *
   * **節ごとに中身を変えてある。** 中身まで同一の節は節id が衝突し、
   * `renderMemoryOutline` がその行へ ⚠ を付ける（＝測りたい形ではない行が混じる）。
   */
  const flood = (count: number): string =>
    Array.from({ length: count }, (_, index) => `## 節${index}\n${'あ'.repeat(50)}${index}\n`).join(
      '\n',
    );

  describe('renderMemoryOutline', () => {
    it('本文を1文字も出さない（出るのは節id・見出し行・文字数だけ）', () => {
      const doc = ['# 見出し', 'SECRET-XYZ-999', '', '## 子', 'SECRET-XYZ-999', ''].join('\n');

      const outline = renderMemoryOutline(scanMemorySections(doc).sections);

      expect(outline).not.toContain('SECRET-XYZ-999');
      expect(outline).toContain('# 見出し');
      expect(outline).toContain('## 子');
    });

    it('frontmatter の行を1つも出さない', () => {
      const outline = renderMemoryOutline(scanMemorySections(withFrontmatter).sections);

      expect(outline).not.toContain('description:');
      expect(outline).not.toContain('type:');
      expect(outline).not.toContain('---');
    });

    it('インデントが見出しの深さを表す', () => {
      const lines = renderMemoryOutline(scanMemorySections(withFrontmatter).sections).split('\n');

      expect(lines[0]).toMatch(/^\[/);
      expect(lines[1]).toMatch(/^ {2}\[/);
      expect(lines[2]).toMatch(/^ {4}\[/);
      expect(lines[3]).toMatch(/^ {6}\[/);
    });

    it('中身まで同一の節が2つあると、その id の行に「この id では動かせない」と印が出る', () => {
      const doc = '# A\n本文\n\n# A\n本文\n\n# B\n終わり\n';

      const outline = renderMemoryOutline(scanMemorySections(doc).sections);

      expect(outline.match(/この id では動かせない/g)?.length).toBe(2);
    });

    it('節が1つも無いなら、そう返す（黙って空を返さない）', () => {
      expect(renderMemoryOutline(scanMemorySections('前書きだけである。\n').sections)).toContain(
        '節が1つも無い',
      );
    });

    it('件数ではなく文字数の予算で切り、切ったことを必ず言う', () => {
      const outline = renderMemoryOutline(scanMemorySections(flood(400)).sections);

      expect(outline).toMatch(/末尾 \d+ 節は省略/);
      expect(outline).toContain('全 400 件');
    });

    /**
     * ## `side` — 目次に**方向**を持たせた分
     *
     * **直している詰まりは「肥大化を防ぐ道具が、肥大化そのものによって
     * 使えなくなる」である。** 予算は先頭から詰めるので、大きな文書では
     * **末尾側の節id が目次に出てこない** ＝ `memory_section_move` の指し先が
     * 手に入らない。⟹ 割りたい文書ほど割れない。
     *
     * **⚠️ ここで測っているのは向きだけである。** 中央（どちらの端からも予算の
     * 外に出る節）は `head` でも `tail` でも出ない——それは欠落ではなく、この
     * 引数が言えないことである（`renderMemoryOutline` の doc の表）。
     */
    describe("side（予算で落とす側を選ぶ。既定は 'head'）", () => {
      /** 予算を確実に超える文書。**節ごとに中身を変える**（同一だと id が衝突して ⚠ が混じる）。 */
      const many = flood(400);
      const sectionsOf = () => scanMemorySections(many).sections;
      /** 目次に出た節id を、出た順に並べて取る。 */
      const idsIn = (outline: string): string[] =>
        [...outline.matchAll(/\[([0-9a-f]{8}-[0-9a-f]{8})\]/g)].map((match) => match[1] as string);

      it("⭐ side='tail' は、既定の目次には出てこない末尾側の節id を出す", () => {
        const sections = sectionsOf();
        const first = sections[0]!;
        const last = sections[sections.length - 1]!;

        const head = renderMemoryOutline(sections);
        const tail = renderMemoryOutline(sections, 'tail');

        // 既定では末尾が落ちている ＝ この節id は手に入らない。
        expect(head).toContain(first.id);
        expect(head).not.toContain(last.id);
        // 向きを渡すと取れる。落ちるのは先頭側になる。
        expect(tail).toContain(last.id);
        expect(tail).not.toContain(first.id);
      });

      /**
       * **「0件」と「問い方が違う」を区別できるようにするための歯である。**
       * どちら側を省いたかが出力に無いと、読み手は「その節は無い」と読む。
       */
      it('⭐ 断り書きが「どちら側を」「何節」省いたかを言う（どちらの向きでも）', () => {
        const sections = sectionsOf();

        expect(renderMemoryOutline(sections)).toMatch(
          /…末尾 \d+ 節は省略（節は全 400 件あり、先頭から \d+ 件だけ出した）。/,
        );
        expect(renderMemoryOutline(sections, 'tail')).toMatch(
          /…先頭 \d+ 節は省略（節は全 400 件あり、末尾から \d+ 件だけ出した）。/,
        );
      });

      /** 続きの取り方を書く（`ListingBudget.omitted` の doc）。口が実在するのはこの版からである。 */
      it('断り書きが続きの取り方を案内する（既定は side=tail へ、tail は既定へ）', () => {
        const sections = sectionsOf();

        expect(renderMemoryOutline(sections)).toContain('side=tail');
        expect(renderMemoryOutline(sections, 'tail')).toContain('side を渡さずに呼べば出る');
        // ⚠ **言えないこと**（中央はどちらの向きでも出ない）も、どちらの断り書きにも書く。
        // 「中央」の語だけを測ると、逆のことを言う文面（「中央も出る」）が素通りする。
        expect(renderMemoryOutline(sections)).toContain('どちらの向きでも出ない');
        expect(renderMemoryOutline(sections, 'tail')).toContain('どちらの向きでも出ない');
      });

      it('断り書きは穴が空いている側へ置く（既定は最後の行、tail は先頭の行）', () => {
        const head = renderMemoryOutline(sectionsOf()).split('\n');
        const tail = renderMemoryOutline(sectionsOf(), 'tail').split('\n');

        expect(head.at(-1)).toContain('節は省略');
        expect(head[0]).not.toContain('節は省略');
        expect(tail[0]).toContain('節は省略');
        expect(tail.at(-1)).not.toContain('節は省略');
      });

      it("引数を渡さないのは side='head' と同じ（既定の向きを変えていない）", () => {
        const sections = sectionsOf();

        expect(renderMemoryOutline(sections)).toBe(renderMemoryOutline(sections, 'head'));
      });

      /**
       * ⭐ **節id は向きに依存しない**（`memorySectionId` の材料はその節の見出し行と
       * 中身だけで、目次のどこを切って出したかは材料に入っていない）。⟹ **向きを
       * 足しても版の照合は弱まらない。** 併せて、**行の並びが文書順のままである**
       * ことも測る（`tail` は詰める向きが違うだけで、並べ替えではない）。
       */
      it('⭐ 出る節id は並びの端そのもので、向きで1文字も変わらない', () => {
        const sections = sectionsOf();
        const all = sections.map((section) => section.id);

        const headIds = idsIn(renderMemoryOutline(sections));
        const tailIds = idsIn(renderMemoryOutline(sections, 'tail'));

        expect(headIds.length).toBeGreaterThan(1);
        expect(tailIds.length).toBeGreaterThan(1);
        expect(all.slice(0, headIds.length)).toEqual(headIds);
        expect(all.slice(-tailIds.length)).toEqual(tailIds);
      });

      it('予算に入りきる文書では、向きを渡しても出力が1文字も変わらない（切っていない）', () => {
        const sections = scanMemorySections(withFrontmatter).sections;

        expect(renderMemoryOutline(sections, 'tail')).toBe(renderMemoryOutline(sections, 'head'));
        expect(renderMemoryOutline(sections, 'tail')).not.toContain('節は省略');
      });

      it("side='tail' でも本文を1文字も出さない（向きを足しても消えない性質）", () => {
        const doc = ['# 見出し', 'SECRET-XYZ-999', '', '## 子', 'SECRET-XYZ-999', ''].join('\n');

        const outline = renderMemoryOutline(scanMemorySections(doc).sections, 'tail');

        expect(outline).not.toContain('SECRET-XYZ-999');
        expect(outline).toContain('## 子');
      });
    });

    /**
     * 依頼者が実際に踏んだ取り違え——`memory_outline` の予算（8,000）を、
     * 毎ターンの焼き込みの節目次の予算（`MEMORY_PROMPT_OUTLINE_BUDGET` = 6,000）
     * だと思い込んで記憶に書いた——の再発防止。値・何を切るか・同じ数字を持つ
     * 別の予算の名前の3つが**同時に**見えるかを測る。
     *
     * ⚠️ **期待値は逐語（`'8,000'`）で持つ。** `MEMORY_OUTLINE_BUDGET` を import
     * して `toContain(String(MEMORY_OUTLINE_BUDGET))` と書くと、実装側の定数を
     * 差し替える変異で比較の両側が一緒に動き、変異が素通りする
     * （`.claude/skills/mutation-testing/` の「比較の両側が同じ経路で同じ値へ
     * 強制されると、比較そのものが恒真になる」と同じ形）。
     */
    describe('省略の断り書きに足す予算の注記（3点が同時に見える）', () => {
      const sections = () => scanMemorySections(flood(400)).sections;

      it('値・何を切る予算か・別の予算の名前の3つが head 側の断り書きに見える', () => {
        const outline = renderMemoryOutline(sections());

        // 1. その値。定数を import せず、逐語で確かめる（上のコメントの理由）。
        expect(outline).toContain('8,000');
        // 2. 何を切る予算か（1回のツール応答であって、毎ターンの焼き込みではない）。
        expect(outline).toContain('memory_outline の1回のツール応答');
        expect(outline).toContain('毎ターン全員が払う焼き込み');
        // 3. ⭐ 同じ数字を持つ別の記憶の予算の名前。
        expect(outline).toContain('MEMORY_LISTING_BUDGET');
      });

      it('同じ3点が tail 側の断り書きにも見える（共有の1文字列を使っている）', () => {
        const outline = renderMemoryOutline(sections(), 'tail');

        expect(outline).toContain('8,000');
        expect(outline).toContain('memory_outline の1回のツール応答');
        expect(outline).toContain('毎ターン全員が払う焼き込み');
        expect(outline).toContain('MEMORY_LISTING_BUDGET');
      });

      it('MEMORY_LISTING_BUDGET といまの値が一致しているので「別の予算である」と言う', () => {
        // 対照: 現物で一致していることを先に確かめる（一致が崩れたら別の枝を通る
        // ——`renderMemoryOutlineBudgetNote` の doc）。
        expect(MEMORY_LISTING_BUDGET).toBe(8_000);

        const outline = renderMemoryOutline(sections());

        expect(outline).toContain('別の予算である');
        expect(outline).not.toContain('値が一致しない');
      });

      it('自身を「目次」と呼ばない（取り違えの発端はこの語の重複だった）', () => {
        const outline = renderMemoryOutline(sections());
        const tailOutline = renderMemoryOutline(sections(), 'tail');

        expect(outline).not.toContain('次の目次がそこへ届く');
        expect(tailOutline).toContain('次に memory_outline を呼んだときの応答にそれが載る');
      });

      /**
       * ⭐ 次に memory.ts へ 8,000 を持つ別の `MEMORY_*_BUDGET` 定数が増えたとき、
       * この歯が気づけるようにする——依頼者の懸念そのもの（数字の帰属の取り違え）
       * に対する予防線。ソースを自分で読み、`MEMORY_OUTLINE_BUDGET` と同じ値を
       * 持つ定数名を全部拾って、断り書きがそれを名指ししているかを見る。
       *
       * 増えたときにどこが赤くなるか: 新しい定数の値が 8,000 なら `siblings` に
       * 名前が加わり、下の `toEqual(['MEMORY_LISTING_BUDGET'])` がまず落ちる。
       * `renderMemoryOutlineBudgetNote`（memory.ts）を直してその名を断り書きへ
       * 足すまで、この歯は赤いままになる。
       */
      it('⭐ memory.ts の中で 8,000 を持つ MEMORY_*_BUDGET 定数を、断り書きが漏れなく名指しする', () => {
        const source = readFileSync(fileURLToPath(new URL('./memory.ts', import.meta.url)), 'utf8');
        const byName = new Map<string, number>();
        for (const match of source.matchAll(/export const (MEMORY_\w*_BUDGET) = ([\d_]+);/g)) {
          byName.set(match[1] as string, Number((match[2] as string).replace(/_/g, '')));
        }

        expect(byName.get('MEMORY_OUTLINE_BUDGET')).toBe(8_000);
        const siblings = [...byName.entries()]
          .filter(([name, value]) => name !== 'MEMORY_OUTLINE_BUDGET' && value === 8_000)
          .map(([name]) => name)
          .sort();

        // いまの実測（memory.ts の10本中）: 同じ値を持つのは MEMORY_LISTING_BUDGET だけ。
        expect(siblings).toEqual(['MEMORY_LISTING_BUDGET']);

        const outline = renderMemoryOutline(sections());
        for (const name of siblings) expect(outline).toContain(name);
      });

      /**
       * ⭐ **族の名乗り（「他にもある」）を head/tail 両方で測る。**
       *
       * #747 は兄弟を `MEMORY_LISTING_BUDGET` の個体名で1本だけ名指しした。
       * 依頼者は #747 の線引き（個体名で名指しし、範囲は記憶の予算に限る）を
       * 採ると決めたが、それでも「これで全部」に見える誤読は残る——だから
       * `renderMemoryOutlineBudgetNote` にもう1句、個体名を挙げずに
       * 「同じ理由で同じ値を持つ予算が他にもある」とだけ言う文を足した
       * （`family` 変数。`sibling` の2分岐のどちらの中にも書いていない
       * ——書くとその分岐が選ばれたときにしか出ない非対称になる）。
       *
       * **「この数字だけではどの予算かは決まらない」と「他にもある」を別々に
       * 測る**——文言のどちらか片方だけを削る変異でも落ちるようにするため。
       *
       * ⚠️ **「MCP の出力上限」という理由づけは、`scope` 側の文にも同じ語
       * （「（MCP の出力上限のため）」）が既に出ている。** そのため
       * `toContain('MCP の出力上限')` のような短い逐語だけで測ると、族の
       * 名乗りの文を丸ごと消しても `scope` 側の出現で緑のままになる
       * （実測で確認済み——下の報告参照）。ここでは族の名乗りの文だけに
       * 現れる、より長い逐語（`scope` 側の言い回しとは地続きにならない形）
       * で測る。
       */
      it('⭐ 族の名乗り（「他にもある」）が head 側の断り書きに見える（scope 側の「MCP の出力上限」とは別の逐語で測る）', () => {
        const outline = renderMemoryOutline(sections());

        expect(outline).toContain('この数字だけではどの予算かは決まらない');
        expect(outline).toContain('同じ理由で同じ値を持つ予算が他にもある');
        expect(outline).toContain(
          '（MCP の出力上限）という理由で道具の応答を切る予算に共通して使われている値であり',
        );
      });

      it('⭐ 同じ族の名乗りが tail 側の断り書きにも見える（共有の1文字列を使っている）', () => {
        const outline = renderMemoryOutline(sections(), 'tail');

        expect(outline).toContain('この数字だけではどの予算かは決まらない');
        expect(outline).toContain('同じ理由で同じ値を持つ予算が他にもある');
        expect(outline).toContain(
          '（MCP の出力上限）という理由で道具の応答を切る予算に共通して使われている値であり',
        );
      });

      it('⚠️ 族の名乗りは個体名（MEMORY_LISTING_BUDGET 以外の定数名・memory_list）を挙げない', () => {
        const outline = renderMemoryOutline(sections());
        // 族の名乗りの文そのもの（family）を、断り書き全体から抜き出して測る
        // ——sibling が既に MEMORY_LISTING_BUDGET を名指ししているので、
        // 断り書き全体に対して素朴に not.toContain すると sibling 側の
        // 名指しごと壊れる歯になってしまう（#747 の既存の歯と衝突する）。
        const familyStart = outline.indexOf('そして');
        expect(familyStart).toBeGreaterThan(-1);
        const family = outline.slice(familyStart);

        expect(family).not.toContain('MEMORY_LISTING_BUDGET');
        expect(family).not.toContain('memory_list');
      });
    });

    /**
     * `q`（見出しの絞り込み）と `offset`（窓をずらす）——中央（どちらの端からも
     * 予算の外に出る節）へ届く2つの口。#（依頼の）本文にある通り、以下を固定する:
     *
     * 1. `q` も `offset` も渡さないとき、出力は1文字も変わらない
     * 2. `q` の一致0件と、一致はあるが予算で切れた場合は別の文言
     * 3. `offset` を窓の大きさぶんずつ進めれば、全節が有限回で出る
     * 4. `q` に正規表現のメタ文字を渡しても壊れない
     */
    describe('q（見出しの絞り込み）と offset（窓をずらす）', () => {
      it('⭐ q も offset も渡さないとき、出力は1文字も変わらない（オプション形・省略の両方）', () => {
        const sections = scanMemorySections(flood(400)).sections;

        const bare = renderMemoryOutline(sections);
        const emptyOptions = renderMemoryOutline(sections, {});
        const explicitHead = renderMemoryOutline(sections, { side: 'head' });
        const stringForm = renderMemoryOutline(sections, 'head');

        expect(emptyOptions).toBe(bare);
        expect(explicitHead).toBe(bare);
        expect(stringForm).toBe(bare);
      });

      it('q が見出しに1つも一致しないとき、一致0件だと明示する（予算で切れたのとは違う文言）', () => {
        const sections = scanMemorySections('# 見出しA\n本文\n\n# 見出しB\n本文\n').sections;

        const outline = renderMemoryOutline(sections, { q: 'ぜったい出てこない文字列XYZ' });

        expect(outline).toContain('一致0件');
        expect(outline).toContain('全 2 節を検索した');
        // 「予算で切れた」側（一致はあるが載せきれなかった場合）の言い回しと
        // 混ざっていないこと——一致0件は「一致そのものが無い」であって
        // 「予算が足りない」ではない。
        expect(outline).not.toContain('予算で省略');
        expect(outline).not.toContain('全件を載せた');
      });

      it('q は大文字小文字を区別しない部分一致で見出しを絞り込む', () => {
        const sections = scanMemorySections(
          '# Alpha Section\n本文\n\n# beta section\n本文\n\n# gamma\n本文\n',
        ).sections;

        const outline = renderMemoryOutline(sections, { q: 'SECTION' });

        expect(outline).toContain('Alpha Section');
        expect(outline).toContain('beta section');
        expect(outline).not.toContain('gamma');
        expect(outline).toContain('全 3 節のうち 2 節が一致した');
      });

      it('q に一致はあるが全件が予算に収まるとき「全件を載せた」と言い、一致0件とは違う文言になる', () => {
        const sections = scanMemorySections('# Alpha\n本文\n\n# Beta\n本文\n').sections;

        const outline = renderMemoryOutline(sections, { q: 'Alpha' });

        expect(outline).toContain('全 2 節のうち 1 節が一致した');
        expect(outline).toContain('全件を載せた');
        expect(outline).not.toContain('一致0件');
      });

      it('⭐ q に一致した節が予算で切れたとき、一致0件とは別の文言で「予算で省略」と言う', () => {
        // 見出しに共通の合言葉を持つ節を大量に作り、予算を超えさせる。
        const many = Array.from(
          { length: 400 },
          (_, index) => `## マッチ対象-${index}\n${'あ'.repeat(50)}${index}\n`,
        ).join('\n');
        const sections = scanMemorySections(many).sections;

        const outline = renderMemoryOutline(sections, { q: 'マッチ対象' });

        expect(outline).toContain('全 400 節のうち 400 節が一致した');
        expect(outline).toContain('予算で省略');
        expect(outline).not.toContain('一致0件');
        expect(outline).not.toContain('全件を載せた');
      });

      it('q は side と併用でき、絞り込んだ結果を末尾から詰められる', () => {
        const many = Array.from(
          { length: 400 },
          (_, index) => `## マッチ対象-${index}\n${'あ'.repeat(50)}${index}\n`,
        ).join('\n');
        const sections = scanMemorySections(many).sections;
        const first = sections[0]!;
        const last = sections[sections.length - 1]!;

        const headOutline = renderMemoryOutline(sections, { q: 'マッチ対象', side: 'head' });
        const tailOutline = renderMemoryOutline(sections, { q: 'マッチ対象', side: 'tail' });

        expect(headOutline).toContain(first.id);
        expect(headOutline).not.toContain(last.id);
        expect(tailOutline).toContain(last.id);
        expect(tailOutline).not.toContain(first.id);
      });

      /**
       * ⚠️ `q` はメタ文字を正規表現として解釈してはいけない——`String.includes`
       * にそのまま渡すので、`.` `*` `[` `(` `\` のようなメタ文字を含んでいても
       * 文字どおりの並びとしてしか一致しない。壊れる（例外を投げる／意図しない
       * 大量一致をする）ことがないことを固定する。
       */
      it.each(['.', '*', '[', '(', '\\', '(a', '[a-z]', 'a.b', 'a*b', 'a\\b'])(
        '⭐ q=%s のような正規表現のメタ文字を渡しても壊れない',
        (needle) => {
          const sections = scanMemorySections('# 見出しA\n本文\n\n# 見出しB\n本文\n').sections;

          expect(() => renderMemoryOutline(sections, { q: needle })).not.toThrow();
          // 見出しにそのメタ文字が literal に含まれていない限り一致しない。
          expect(renderMemoryOutline(sections, { q: needle })).toContain('一致0件');
        },
      );

      it('q のメタ文字が見出しに literal に含まれていれば、その並びとして一致する', () => {
        const sections = scanMemorySections('# a.b special\n本文\n\n# axb other\n本文\n').sections;

        // 正規表現なら `.` は任意の1文字に一致して両方拾ってしまうが、
        // literal な部分一致なら "a.b" は最初の見出しにしか一致しない。
        const outline = renderMemoryOutline(sections, { q: 'a.b' });

        expect(outline).toContain('全 2 節のうち 1 節が一致した');
        expect(outline).toContain('a.b special');
        expect(outline).not.toContain('axb other');
      });

      it('offset は先頭から N 節を飛ばしてから予算を埋める', () => {
        const sections = scanMemorySections(flood(10)).sections;

        const fromStart = renderMemoryOutline(sections, { offset: 0 });
        const fromThree = renderMemoryOutline(sections, { offset: 3 });

        expect(fromStart).toContain(sections[0]!.id);
        expect(fromThree).not.toContain(sections[0]!.id);
        expect(fromThree).not.toContain(sections[1]!.id);
        expect(fromThree).not.toContain(sections[2]!.id);
        expect(fromThree).toContain(sections[3]!.id);
      });

      it('offset は範囲外（節数以上）なら黙って空を返さず、明示して断る', () => {
        const sections = scanMemorySections('# A\n本文\n\n# B\n本文\n').sections;

        const outline = renderMemoryOutline(sections, { offset: 5 });

        expect(outline).toContain('offset=5');
        expect(outline).toContain('節は無い');
        expect(outline).toContain('全 2 節');
      });

      /**
       * ⚠️ 境界値（`offset === 節数`）を単独で固定する。**節数より大きい値
       * （直上の歯）だけでは、`offset >= pool.length` を `offset > pool.length`
       * に弱めるオフバイワンを検出できない**——直上の歯は `offset=5` を
       * 「節数2より大きい」でしか使っておらず、`>` でも `>=` でも同じく
       * 拒まれるので通ってしまう。ちょうど境界（節数と同じ値）を別に
       * 固定することで、この2つの演算子を区別する。
       */
      it('offset はちょうど節数と同じ値でも範囲外として断る（境界値。節数より大きい値だけでは区別できない）', () => {
        const sections = scanMemorySections('# A\n本文\n\n# B\n本文\n').sections;

        const outline = renderMemoryOutline(sections, { offset: 2 });

        expect(outline).toContain('offset=2');
        expect(outline).toContain('節は無い');
        expect(outline).toContain('全 2 節');
      });

      it('offset は続きの offset の値そのものと、いま何節目から何節目までかを言う', () => {
        const sections = scanMemorySections(flood(400)).sections;

        const outline = renderMemoryOutline(sections, { offset: 0 });

        expect(outline).toMatch(/1〜\d+ 節目 \/ 全 400 節のうち \d+ 節を出した。/);
        expect(outline).toMatch(/続きが在る。次は offset=\d+ で呼ぶこと/);
      });

      it('offset が最後まで届くと「続きは無い」と言う', () => {
        const sections = scanMemorySections('# A\n本文\n\n# B\n本文\n').sections;

        const outline = renderMemoryOutline(sections, { offset: 1 });

        expect(outline).toContain('続きは無い（最後まで出した）');
      });

      /**
       * ⭐⭐ **「到達できなくなったものが0件である」ことの根拠。**
       *
       * 大きな文書（予算を確実に超える）を合成し、`offset` を「前の呼び出しが
       * 返した次の offset」ぶんずつ進めて machine的に全節を読み切る。**出た
       * 節id の集合が、文書が持つ全節id の集合と一致すること**を assert する
       * ——これが「offset を窓の大きさぶんずつ進めれば、どんなに大きい文書
       * でも有限回の呼び出しで全節を出せる」の直接の証拠である。
       */
      it('⭐⭐ offset を窓の大きさぶんずつ進めれば、有限回の呼び出しで全節id が出る（到達漏れ0件の根拠）', () => {
        const sections = scanMemorySections(flood(2000)).sections;
        const allIds = new Set(sections.map((section) => section.id));

        const seenIds = new Set<string>();
        let offset = 0;
        let iterations = 0;
        const MAX_ITERATIONS = 2000; // 有限回であることの安全弁（無限ループの検出）。

        for (;;) {
          iterations += 1;
          if (iterations > MAX_ITERATIONS) {
            throw new Error(`offset を進めても終わらない（${MAX_ITERATIONS} 回で打ち切り）`);
          }
          const outline = renderMemoryOutline(sections, { offset });
          for (const match of outline.matchAll(/\[([0-9a-f]{8}-[0-9a-f]{8})\]/g)) {
            seenIds.add(match[1] as string);
          }
          const more = /続きが在る。次は offset=(\d+) で呼ぶこと/.exec(outline);
          if (!more) break;
          offset = Number(more[1]);
        }

        expect(seenIds).toEqual(allIds);
        // 有限回であること自体も測る（2,000節を1回の窓（数十節程度）で舐めるので、
        // 反復回数は節数よりずっと少ないはずである）。
        expect(iterations).toBeLessThan(sections.length);
      });

      it('offset は side を見ない（渡しても既定の先頭からの詰め方のまま）', () => {
        const sections = scanMemorySections(flood(10)).sections;

        const withoutSide = renderMemoryOutline(sections, { offset: 2 });
        const withTailSide = renderMemoryOutline(sections, { offset: 2, side: 'tail' });

        expect(withoutSide).toBe(withTailSide);
      });

      it('q と offset は併用でき、offset は絞り込んだ結果に対して窓を開く', () => {
        const many = Array.from(
          { length: 20 },
          (_, index) =>
            `## マッチ対象-${index}\n${'あ'.repeat(10)}${index}\n\n## 無関係-${index}\n本文\n`,
        ).join('\n');
        const sections = scanMemorySections(many).sections;
        const matched = sections.filter((section) => section.heading.includes('マッチ対象'));

        const outline = renderMemoryOutline(sections, { q: 'マッチ対象', offset: 0 });

        expect(outline).toContain('全 40 節のうち 20 節が一致した');
        expect(outline).toContain(matched[0]!.id);
        // 絞り込み後の母数（20）に対する窓であって、全体（40）に対する窓ではない。
        expect(outline).toMatch(/絞り込み後 20 節のうち \d+ 節を出した。/);
      });
    });
  });

  /**
   * **#805（`indexed`）と #807（`memory_outline` の `q` / `offset`）が噛み合って
   * いることを測る。⭐⭐ どちらか片方の改修だけでは書けない歯である。**
   *
   * `indexed` は節の目次を焼き込みから外す ⟹ **その文書の節id は毎ターンの
   * カードに1つも出ない。** そこだけを見ると到達性が消えたように見えるが、
   * 消えていない——`memory_outline` の `offset` が有限回で全節を出すからである。
   *
   * **この2つを同じ歯で通さないと、「載っていないのに全部届く」という主張の
   * 片側しか測れない。** 片方だけでは「載っていない」か「届く」のどちらかしか
   * 言えず、`indexed` へ移すことが安全だという根拠にならない。
   */
  describe('indexed の文書と memory_outline の統合（#805 × #807）', () => {
    const indexedDoc = (body: string): string =>
      ['---', 'description: 要旨である。', 'type: indexed', '---', body].join('\n');

    it('⭐⭐ indexed は節の目次を1つも焼かないが、offset を回せば全節id に到達できる（到達漏れ0件）', () => {
      const content = indexedDoc(flood(2000));
      const sections = scanMemorySections(content).sections;
      const allIds = new Set(sections.map((section) => section.id));

      // (1) **焼き込みのカードには節id が1つも出ない**（indexed の効き目そのもの）。
      const card = renderMemoryDocuments([{ slug: 'probe', content }]);
      expect(card).not.toMatch(/\[[0-9a-f]{8}-[0-9a-f]{8}\]/);

      // (2) **それでも offset を回せば全節id が出る。** (1) と (2) の両方が同時に
      // 真であることが、この歯の主張の全体である。
      const seenIds = new Set<string>();
      let offset = 0;
      let iterations = 0;
      const MAX_ITERATIONS = 2000; // 有限回であることの安全弁（無限ループの検出）。
      for (;;) {
        iterations += 1;
        if (iterations > MAX_ITERATIONS) {
          throw new Error(`offset を進めても終わらない（${MAX_ITERATIONS} 回で打ち切り）`);
        }
        const outline = renderMemoryOutline(sections, { offset });
        for (const match of outline.matchAll(/\[([0-9a-f]{8}-[0-9a-f]{8})\]/g)) {
          seenIds.add(match[1] as string);
        }
        const more = /続きが在る。次は offset=(\d+) で呼ぶこと/.exec(outline);
        if (!more) break;
        offset = Number(more[1]);
      }

      expect(seenIds).toEqual(allIds);
      expect(iterations).toBeLessThan(sections.length);
    });

    /**
     * **`q` が見るのは見出しだけである。⚠️ ただし「本文を見ない」ことは、この歯
     * ではなく型が守っている**——`renderMemoryOutline` が受け取る `MemorySection`
     * は `id` / `heading` / `depth` / `start` / `end` / `chars` しか持たず、
     * **本文がそもそも手元に無い。** ⟹「本文の語では引けない」を assert しても
     * **失敗しようのない歯（いつでも緑）になる。実際に変異を当てて測ったらそうだった。**
     * ⟹ ここでは代わりに**失敗しうること**を測る——**節が持つ他の欄（節id・文字数）
     * へ `q` が広がっていないこと。**
     *
     * ⚠️ **見出しに数字を入れない合成データを使う。** `flood` の `## 節12` の形だと、
     * 文字数（例: `34`）が見出しの数字に偶然当たって、**当たった理由が区別できない。**
     */
    it('indexed の文書でも q で見出しを引ける。⛔ 節id や文字数へは広がらない（見出しだけを見る）', () => {
      const kana = 'あいうえおかきくけこ';
      const digitFree = (index: number): string =>
        String(index)
          .split('')
          .map((digit) => kana[Number(digit)])
          .join('');
      const body = Array.from(
        { length: 300 },
        (_, index) => `## セクション${digitFree(index)}\n${'ん'.repeat(50)}${digitFree(index)}\n`,
      ).join('\n');
      const content = indexedDoc(
        ['## ミダシダケノゴ を含む見出し', 'この節の本文には目印がある。', '', body].join('\n'),
      );
      const sections = scanMemorySections(content).sections;
      const target = sections.find((section) => section.heading.includes('ミダシダケノゴ'));
      if (target === undefined) throw new Error('合成データが壊れている（目印の節が無い）');

      // 見出しに在る語は1回で当たり、**節id がそのまま出る**（＝その場で開ける）。
      const byHeading = renderMemoryOutline(sections, { q: 'ミダシダケノゴ' });
      expect(byHeading).toContain('ミダシダケノゴ');
      expect(byHeading).toMatch(/\[[0-9a-f]{8}-[0-9a-f]{8}\]/);

      // **節id の断片では引けない。** 節id は見出しではないので、ここへ広がると
      // 「見出しで探す」という道具の約束が静かに変わる。
      const byId = renderMemoryOutline(sections, { q: target.id.slice(0, 8) });
      expect(byId).toContain('一致0件');

      // **文字数の数字でも引けない。** 見出しに数字が1つも無いので、当たったら
      // それは文字数の欄へ広がったということである（当たった理由が一意に決まる）。
      const byChars = renderMemoryOutline(sections, { q: String(target.chars) });
      expect(byChars).toContain('一致0件');
    });
  });
});

/**
 * frontmatter の「乗っ取り」が起こりえないことを、性質として測る（#318 案 (b) の第3層）。
 *
 * **⚠️ これは分岐のテストではない。** `memory_section_move` は書き込み前に
 * 「frontmatter のバイト列が同一か」「`parseMemoryFrontmatter().kind` が
 * 変わっていないか」を検査して、外れたら何も書かずに断る。**その断りへ到達
 * する入力を、私は1つも構成できなかった**——節の切り取りは
 * 「`content.slice(0, section.start)` ＋ `content.slice(section.end)`」で、
 * `section.start` は必ず `memoryBodyStart` 以上、かつ切り取り後の1行目は
 * 見出し行（`#` で始まる）か空文字にしかならないからである。
 *
 * **だからここで測るのは「検査が鳴ること」ではなく「鳴る入力が無いこと」で
 * ある。** 検査そのものは、次にここを触る人が継ぎ足しをやめて組み直す形へ
 * 変えたときのための不変条件であって、いまの実装では死んだ枝である
 * （PR 本文にもそう書いた。変異試験でもこの枝は生存する）。
 *
 * **この形が要る理由は、`memory_section_replace`（作らないと決めた口）との
 * 差にある。** 置換なら呼び手が任意の文字列を渡すので
 * 「`---\ndescription: 乗っ取り\n---\n# 見出し`」で最初の節を置き換えると
 * 無かったはずの frontmatter が生える。**移動には呼び手の文字列が1つも
 * 無いので、その経路が入力の側に存在しない。**
 */
describe('節の切り取りは frontmatter の解釈を変えない（乗っ取りが起こりえない）', () => {
  const documents = [
    // frontmatter あり
    '---\ndescription: x\ntype: premise\n---\n# A\n本文\n\n## B\n本文\n',
    // frontmatter なし・前書きあり・本文の中に `---` の塊
    '前書き\n---\ndescription: 乗っ取り\n---\n# A\n本文\n\n# B\n本文\n',
    // frontmatter なし・最初の節の中に `---` の塊
    '# A\n本文\n\n---\ndescription: 乗っ取り\n---\n\n# B\n本文\n',
    // frontmatter あり・本文の1行目が `---` の塊
    '---\ndescription: x\n---\n---\ndescription: 乗っ取り\n---\n# A\n本文\n',
    // 節が1つだけ（切ると空文字になる）
    '# A\n本文\n',
    '---\ndescription: x\n---\n# A\n本文\n',
  ];

  it('どの文書のどの節を切り取っても、frontmatter のバイト列も解釈も変わらない', () => {
    for (const content of documents) {
      const scan = scanMemorySections(content);
      const priorKind = parseMemoryFrontmatter(content).kind;
      for (const section of scan.sections) {
        const { nextContent } = cutMemorySections(content, [section]);
        expect(nextContent.slice(0, scan.bodyStart)).toBe(content.slice(0, scan.bodyStart));
        expect(parseMemoryFrontmatter(nextContent).kind).toBe(priorKind);
      }
    }
  });

  it('切り取った文字列は必ず見出し行から始まる（移し先の先頭に frontmatter を作れない）', () => {
    for (const content of documents) {
      for (const section of scanMemorySections(content).sections) {
        const { cut } = cutMemorySections(content, [section]);
        expect(cut.split('\n')[0]).toMatch(/^#{1,6}\s/);
      }
    }
  });
});

// =============================================================================
// 記憶の肥大への恒久対策 — measureMemoryFloor / describeMemoryFloor
// =============================================================================

/**
 * `measureMemoryFloor` — 「記憶の肥大」を測る。
 *
 * **⚠️ 器に premise 2件 + fact 1件を必ず持たせる（AGENTS.md
 * 「測るのは呼び出し回数ではなく状態である」）。** fact が0件だと
 * `filter(d => d.kind === 'premise')` を外す変異が同値になって生存し、
 * premise が0件だと逆側の分岐が測れない。
 */
describe('measureMemoryFloor — 焼き込みの大きさを測る（記憶の肥大への恒久対策）', () => {
  /** premise 2件 + fact 1件。中核の歯は必ずこの形の器を使う。 */
  function mixedDocs(): MemoryPart[] {
    return [
      premise('p-small', '短い前提'),
      premise('p-large', 'あ'.repeat(500)),
      fact('f-one', { description: '要旨', freshness: { kind: 'fresh' } }),
    ];
  }

  it('⭐ totalChars は renderMemoryDocuments(documents).length と厳密に一致する（複数の器で）', () => {
    const fixtures: MemoryPart[][] = [
      [],
      [premise('only-premise', '本文')],
      [fact('only-fact', { description: '要旨', freshness: { kind: 'fresh' } })],
      mixedDocs(),
      // malformed な frontmatter（premise として扱われ、注記が前置される）。
      [{ slug: 'broken', content: '---\nauthor: 未知のキー\n---\n# Broken\n本文' }],
      // 親が存在しない fact（目次に印が付く）。
      [fact('orphan', { description: '説明', freshness: { kind: 'fresh' }, parent: 'not-exist' })],
    ];
    for (const docs of fixtures) {
      expect(measureMemoryFloor(docs).totalChars).toBe(renderMemoryDocuments(docs).length);
    }
  });

  it('premise 合計は premise の文書だけの合計に一致し、fact の分を含まない（器に fact 1件必須）', () => {
    const docs = mixedDocs();
    const floor = measureMemoryFloor(docs);
    const premiseOnlyRendered = renderMemoryDocuments(
      docs.filter((doc) => doc.slug.startsWith('p-')),
    );

    expect(floor.premiseDocs).toBe(2);
    expect(floor.factDocs).toBe(1);
    expect(floor.premiseChars).toBe(premiseOnlyRendered.length);
    // fact の目次ぶんが乗っているぶん、全体は premise 合計より必ず大きい
    // ——premise 合計に fact が混ざっていれば、この不等号は成り立たない
    // か、たまたま一致してしまう（fact を0件にした器では測れない理由）。
    expect(floor.totalChars).toBeGreaterThan(floor.premiseChars);
    expect(floor.tocChars).toBeGreaterThan(0);
  });

  it('largestPremise は最も大きい premise を指す（`renderPremisePart` の結果の長さで比べる）', () => {
    const docs = mixedDocs();
    const floor = measureMemoryFloor(docs);
    expect(floor.largestPremise?.slug).toBe('p-large');
    // **数を書き写さない。** かつてここは 500（＝全文が載っていた頃の本文量）を
    // 直接書いていたが、載るのはカード（要旨＋節の目次）になったので、その数は
    // もう何も意味しない。**測るべきは「実際に載る形の長さと一致すること」**で、
    // それは器（`mixedDocs`）が変わっても腐らない。
    const largeRendered = renderMemoryDocuments(docs.filter((doc) => doc.slug === 'p-large'));
    expect(floor.largestPremise?.chars).toBe(largeRendered.length);
    // そして他の premise より確かに大きい（「最も大きい」の側）。
    const smallRendered = renderMemoryDocuments(docs.filter((doc) => doc.slug === 'p-small'));
    expect(largeRendered.length).toBeGreaterThan(smallRendered.length);
  });

  it('premise が1件も無ければ largestPremise は null', () => {
    const floor = measureMemoryFloor([
      fact('only-fact', { description: '要旨', freshness: { kind: 'fresh' } }),
    ]);
    expect(floor.largestPremise).toBeNull();
  });

  it('malformed な frontmatter の premise は、注記込みの長さで数える（`content.length` ではない）', () => {
    const broken: MemoryPart = {
      slug: 'broken',
      content: '---\nauthor: 未知のキー\n---\n# Broken\n本文',
    };
    const floor = measureMemoryFloor([broken]);
    // `content` そのものより長い——frontmatter が壊れている注記が前置されるため。
    expect(floor.totalChars).toBeGreaterThan(broken.content.length);
    expect(floor.largestPremise?.chars).toBe(floor.totalChars);
  });

  it('単位は文字（String.length）であって bytes ではない', () => {
    // 全角5文字（UTF-8では15バイト）。
    const docs = [premise('zenkaku', '価値観です')];
    const floor = measureMemoryFloor(docs);
    const rendered = renderMemoryDocuments(docs);
    expect(floor.totalChars).toBe(rendered.length);
    expect(floor.totalChars).not.toBe(Buffer.byteLength(rendered, 'utf8'));
  });

  it('⭐ 記憶を1バイトも書き換えない（`MemoryPart[]` を受け取るだけの純粋関数）', () => {
    const docs = mixedDocs();
    const before = docs.map((doc) => doc.content);
    measureMemoryFloor(docs);
    expect(docs.map((doc) => doc.content)).toEqual(before);
  });
});

/**
 * `measurePremiseOutlineFit` / `MemoryFloor.outlineSaturatedPremise` — 1文書
 * あたりの目次の予算（`MEMORY_PROMPT_OUTLINE_BUDGET`）に対して、premise の
 * 節の目次がどこに居るかを測る（#772「記憶の肥大」の続き）。
 *
 * **`shown` が崖そのものであることを実測で固定する歯（下の「⭐⭐」）が
 * いちばんの中核である。** リテラル（85 のような値）は見出し長で動くので
 * 書かない——`measurePremiseOutlineFit` 自身が返す `shown` を使って、
 * その境目を実地に確かめる。
 */
describe('measurePremiseOutlineFit / MemoryFloor.outlineSaturatedPremise — 目次の崖（#772）', () => {
  it('切れていない文書に対して null を返す（節が少ない文書）', () => {
    const doc = manySectionPremise('small', 3);
    // 前提: 本当に切れていない（切れていればこのテストは何も測らない）。
    expect(renderMemoryDocuments([doc])).not.toContain('節は目次から省略');
    expect(measurePremiseOutlineFit(doc)).toBeNull();
  });

  it('節が1つも無い文書に対して null を返す', () => {
    const doc: MemoryPart = { slug: 'no-sections', content: '見出しの無い前書きだけ' };
    expect(measurePremiseOutlineFit(doc)).toBeNull();
  });

  /**
   * ⭐ これは「数え方が2本に割れていない」を測る歯である。期待値をリテラルで
   * 書かず、`renderMemoryDocuments` の出力（断り書き）から正規表現で数を
   * 抜き出して、`measurePremiseOutlineFit` の戻り値と突き合わせる。
   */
  it('⭐ 切れている文書に対して返す rest/shown/total が、断り書きの中の数と一致する', () => {
    const doc = manySectionPremise('saturated', 400);
    const fit = measurePremiseOutlineFit(doc);
    expect(fit).not.toBeNull();

    const rendered = renderMemoryDocuments([doc]);
    const hit =
      /末尾 ([\d,]+) 節は目次から省略（全 ([\d,]+) 節のうち先頭 ([\d,]+) 節だけ載せた）/.exec(
        rendered,
      );
    expect(hit).not.toBeNull();
    const [, rest = '', total = '', shown = ''] = hit as RegExpExecArray;
    const toNumber = (s: string) => Number(s.replace(/,/g, ''));

    expect(fit?.rest).toBe(toNumber(rest));
    expect(fit?.total).toBe(toNumber(total));
    expect(fit?.shown).toBe(toNumber(shown));
    // 足し算としても整合する。
    expect(fit!.shown + fit!.rest).toBe(fit!.total);
  });

  /**
   * ⭐⭐ **`shown` が崖そのものであることを実測で固定する。** 節数 N（切れる）
   * の文書から `shown = S` を取り、**同じ見出し生成器で先頭 S 節だけを持つ
   * 文書**を作ると省略が出ないこと、**S+1 節**だと省略が出ることを両方
   * assert する。リテラル（85 等）は見出し長で動くので書かない。
   *
   * なぜこれで崖に当たると言えるか: `fillListingBudget` は先頭から貪欲に
   * 積むので、各行の重みはその文書の総節数に依存しない（節id・文字数の
   * 固定費も見出しも、その節自身の長さでしか決まらない）。⟹ 先頭 S 節・
   * 先頭 S+1 節だけを持つ文書でも、`items[0..S-1]` の累積は元の文書と
   * 1文字も変わらず、`items[S]` を足すかどうかだけが違う——だから
   * 「ちょうど S 節で収まり、S+1 節目から溢れる」という境目を、切り出した
   * 文書で再現できる。
   */
  it('⭐⭐ shown は崖そのものである（先頭 shown 節では省略が出ず、shown+1 節では出る）', () => {
    const headingLength = 40;
    const saturated = manySectionPremise('cliff-source', 400, headingLength);
    const fit = measurePremiseOutlineFit(saturated);
    expect(fit).not.toBeNull();
    const shown = fit!.shown;
    // 前提: 崖が文書の範囲内に実在する（0 や総節数と同じでは何も測れない）。
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(400);

    const exactlyShown = manySectionPremise('cliff-exact', shown, headingLength);
    expect(measurePremiseOutlineFit(exactlyShown)).toBeNull();
    expect(renderMemoryDocuments([exactlyShown])).not.toContain('節は目次から省略');

    const oneMore = manySectionPremise('cliff-plus-one', shown + 1, headingLength);
    const oneMoreFit = measurePremiseOutlineFit(oneMore);
    expect(oneMoreFit).not.toBeNull();
    expect(oneMoreFit?.rest).toBe(1);
    expect(oneMoreFit?.shown).toBe(shown);
    expect(renderMemoryDocuments([oneMore])).toContain('節は目次から省略');
  });

  it('measureMemoryFloor(...).outlineSaturatedPremise は、切れている premise だけを含む', () => {
    const saturated = manySectionPremise('floor-saturated', 400);
    const notSaturated = premise('floor-small', '短い前提');
    const floor = measureMemoryFloor([saturated, notSaturated]);

    const slugs = floor.outlineSaturatedPremise.map((entry) => entry.slug);
    expect(slugs).toContain('floor-saturated');
    expect(slugs).not.toContain('floor-small');
    expect(floor.outlineSaturatedPremise).toHaveLength(1);
  });

  /**
   * ⚠⚠ **`demotedPremise`（束ねた蓋 `MEMORY_PREMISE_CARD_BUDGET` でカードごと
   * 1行に落ちた文書）は除外する。** あちらは目次そのものが焼かれていないので、
   * 「目次が予算で切れている」と名乗ると嘘になる（`MemoryFloor.outlineSaturatedPremise`
   * の doc）。
   */
  it('⚠⚠ outlineSaturatedPremise は、束ねた蓋で1行に落ちた premise を含まない', () => {
    // 全件を「単体でも目次が切れる」同じ形の文書にする——そうすることで、
    // 「そもそも目次が切れていないから外れた」のか「蓋で1行に落ちたから
    // 外れた」のかを区別できる。件数を積んで束ねた予算
    // （`MEMORY_PREMISE_CARD_BUDGET`）を超えさせ、大きいほうから蓋を掛ける。
    const template = (index: number): MemoryPart => ({
      slug: `outline-demoted-${String(index).padStart(3, '0')}`,
      content: Array.from({ length: 200 }, (_, i) => `## ${'あ'.repeat(20)}${i}\n本文`).join('\n'),
    });

    // 前提: テンプレート単体は本当に目次が切れている（切れていなければ、
    // 以下の等式は「そもそも飽和していないから外れた」ケースと区別できない）。
    expect(measurePremiseOutlineFit(template(0))).not.toBeNull();

    const count = 20;
    const docs = Array.from({ length: count }, (_, i) => template(i));
    const floor = measureMemoryFloor(docs);

    // 前提: 本当に蓋が噛んでいる（1件も落ちていなければ、除外の効果を
    // このテストは何も測っていない）。全件が落ちてもいけない
    // （1件は必ず残るはずで、残らなければ `selectPremiseCards` 側の前提が壊れている）。
    expect(floor.demotedPremiseDocs).toBeGreaterThan(0);
    expect(floor.demotedPremiseDocs).toBeLessThan(count);

    // 全 count 件が個別には目次飽和している。⟹ outlineSaturatedPremise から
    // 減っている分は、蓋で落ちた分とちょうど一致するはずである——除外が
    // 効いていなければ（デグレードすれば）、この等式は count を超えて壊れる。
    expect(floor.outlineSaturatedPremise.length + floor.demotedPremiseDocs).toBe(count);
  });
});

/**
 * `describeMemoryFloor` — 書く4口（`memory_write` / `memory_append` /
 * `memory_frontmatter_set` / `memory_section_move`）の応答の末尾に添える、
 * 「毎ターンの床」の一言。
 *
 * **⭐ 新規作成の枝がいちばん声を大きい。** premise を新規作成したときだけ
 * 「毎ターン全文が焼かれる」ことを言う——他の枝（fact の新規作成・既存文書の
 * 更新）では言わない。
 */
describe('describeMemoryFloor — 「毎ターンの床」の一言（新規作成の枝がいちばん声を大きい）', () => {
  const emptyFloor = measureMemoryFloor([]);

  it('⭐ premise の新規作成では、区分・床の遷移（文字）・「毎ターン何が焼かれるか」の3つが出る', () => {
    const after = measureMemoryFloor([premise('new-doc', 'あ'.repeat(100))]);
    const reply = describeMemoryFloor({
      before: emptyFloor,
      after,
      slug: 'new-doc',
      kind: 'premise',
      created: true,
    });

    expect(reply).toContain('premise');
    expect(reply).toContain(
      `${emptyFloor.totalChars.toLocaleString('en-US')} 文字から ${after.totalChars.toLocaleString('en-US')} 文字へ`,
    );
    // **かつてここは「全文がそのままクローンの文脈へ焼かれる」だった。** 載り方が
    // カード（要旨＋節の目次）へ変わったので文言も変わった。**測っているのは
    // 「新規の premise にだけ、毎ターン何が焼かれるかを言う強い1行が出ること」**
    // であって、その保証は弱まっていない（下の fact の枝で出ないことを別に測って
    // いる歯が、この行の存在に依存している）。
    expect(reply).toContain('毎ターン「要旨＋節の目次」がクローンの文脈へ焼かれる');
    expect(reply).toContain('memory_section_read');
    // 他の枝より明確に強い言い方（依頼の重心）。
    expect(reply).toContain('⭐');
  });

  it('fact の新規作成では「全文が焼かれる」の1行が出ない', () => {
    const after = measureMemoryFloor([
      fact('new-fact', { description: '要旨', freshness: { kind: 'fresh' } }),
    ]);
    const reply = describeMemoryFloor({
      before: emptyFloor,
      after,
      slug: 'new-fact',
      kind: 'fact',
      created: true,
    });

    expect(reply).toContain('fact');
    expect(reply).not.toContain('全文がそのままクローンの文脈へ焼かれる');
  });

  it('既存文書の更新（新規作成ではない）では「全文が焼かれる」も⭐も出ない', () => {
    const before = measureMemoryFloor([premise('doc', '短い本文')]);
    const after = measureMemoryFloor([premise('doc', '短い本文をもっと増やした')]);
    const reply = describeMemoryFloor({
      before,
      after,
      slug: 'doc',
      kind: 'premise',
      created: false,
    });

    expect(reply).toContain('premise');
    expect(reply).not.toContain('全文がそのままクローンの文脈へ焼かれる');
    expect(reply).not.toContain('⭐');
  });

  /**
   * ⭐ 増減の**符号**を単体で固定する。
   *
   * **なぜ単体で要るか（変異試験で見つかった脆さ）。** `formatMemoryFloorTransition`
   * の `afterChars - beforeChars` を逆向きにする変異を当てたとき、赤くなったのは
   * `tools.test.ts` の `memory_section_move` の統合の歯**1本だけ**だった ——
   * このファイルの単体は1本も撃たなかった。**その1本を消すか条件を変えると、
   * 符号は誰も見ていない状態になる。**
   *
   * **⚠️ 「変異が検出された」の内側に在る脆さである** —— 合格の数字（9/9・生存0）
   * を見ているだけでは出てこない。だから本数まで数えて、ここへ足した。
   */
  it('⭐ 床が減ったときは増減が負で出る（増えたときは正。符号を単体で固定する）', () => {
    // **本文の長さでは床が動かなくなった。** 焼き込みはカード（要旨＋節の目次）
    // なので、本文を 500 字から 100 字へ減らしても載る量はほぼ変わらない
    // （変わるのは「全 N 文字」の桁だけ）。**床を実際に動かすのは節の数である**
    // ——だから器を「節が多い／少ない」で作る。測っている符号の話は同じ。
    const big = measureMemoryFloor([
      premise('doc', ['## 一', '本文', '## 二', '本文', '## 三', '本文'].join('\n')),
    ]);
    const small = measureMemoryFloor([premise('doc', '## 一\n本文')]);

    const shrunk = describeMemoryFloor({
      before: big,
      after: small,
      slug: 'doc',
      kind: 'premise',
      created: false,
    });
    expect(small.totalChars).toBeLessThan(big.totalChars);
    expect(shrunk).toContain(`（${(small.totalChars - big.totalChars).toLocaleString('en-US')}）`);
    expect(shrunk).toContain('-');

    const grown = describeMemoryFloor({
      before: small,
      after: big,
      slug: 'doc',
      kind: 'premise',
      created: false,
    });
    expect(grown).toContain(`（+${(big.totalChars - small.totalChars).toLocaleString('en-US')}）`);
  });

  it('⛔ 既存の語「区分が変わった」を使い回さない（tools.test.ts の歯と同じ語を撃たない）', () => {
    const before = measureMemoryFloor([premise('doc', 'a')]);
    const after = measureMemoryFloor([
      fact('doc', { type: 'fact', description: '要旨', freshness: { kind: 'fresh' } }),
    ]);
    const reply = describeMemoryFloor({ before, after, slug: 'doc', kind: 'fact', created: false });

    expect(reply).not.toContain('区分が変わった');
  });

  it('単位は文字である（bytes を出していない）', () => {
    const after = measureMemoryFloor([premise('zenkaku', '価値観です')]);
    const reply = describeMemoryFloor({
      before: emptyFloor,
      after,
      slug: 'zenkaku',
      kind: 'premise',
      created: true,
    });
    expect(reply).toContain('文字');
    expect(reply).not.toContain('bytes');
  });

  it('床の行は「いま読み直した値」であることを名乗る（read→write の間の書き換え窓があるため）', () => {
    const after = measureMemoryFloor([premise('doc', '本文')]);
    const reply = describeMemoryFloor({
      before: emptyFloor,
      after,
      slug: 'doc',
      kind: 'premise',
      created: true,
    });
    expect(reply).toContain('いま読み直した値');
  });

  /**
   * ⭐ premise の新規作成の枝には、「どこを見ればよいか」への回答（最大の
   * premise を名指しする）と、「縮めるのに全文置換は要らないこと」（3手順の
   * 道具名）を足す——依頼者が実際にこの枝で詰まった経験（`about-me-core` を
   * 作った夜、応答が文字数だけだった）を踏まえた決裁。
   *
   * **稀にしか出ない枝だけに足す。** fact の新規作成・既存文書の更新には
   * 足さない——別の `it()` で「出ない」ことを固定する（畳むと変異が生存する）。
   */
  it('⭐ premise の新規作成では、いま最大の premise の slug と文字数が出る', () => {
    const after = measureMemoryFloor([
      premise('small', '短い'),
      premise('new-doc', 'あ'.repeat(500)),
    ]);
    const reply = describeMemoryFloor({
      before: emptyFloor,
      after,
      slug: 'new-doc',
      kind: 'premise',
      created: true,
    });

    expect(after.largestPremise?.slug).toBe('new-doc');
    expect(reply).toContain('いま最も大きい premise: new-doc');
    expect(reply).toContain(`${after.largestPremise?.chars.toLocaleString('en-US')} 文字`);
  });

  it('⭐ premise の新規作成では、縮める3手順（memory_outline → memory_section_move → memory_frontmatter_set）の道具名が全部出る', () => {
    const after = measureMemoryFloor([premise('new-doc', 'あ'.repeat(500))]);
    const reply = describeMemoryFloor({
      before: emptyFloor,
      after,
      slug: 'new-doc',
      kind: 'premise',
      created: true,
    });

    expect(reply).toContain('memory_outline');
    expect(reply).toContain('memory_section_move');
    expect(reply).toContain('memory_frontmatter_set');
  });

  it('⛔ fact の新規作成には、最大の premise の名指しも3手順も出ない（稀にしか出ない枝専用）', () => {
    const after = measureMemoryFloor([
      premise('some-premise', 'あ'.repeat(500)),
      fact('new-fact', { description: '要旨', freshness: { kind: 'fresh' } }),
    ]);
    const reply = describeMemoryFloor({
      before: emptyFloor,
      after,
      slug: 'new-fact',
      kind: 'fact',
      created: true,
    });

    expect(reply).not.toContain('いま最も大きい premise');
    expect(reply).not.toContain('memory_outline');
    expect(reply).not.toContain('memory_section_move');
    expect(reply).not.toContain('memory_frontmatter_set');
  });

  it('⛔ 既存文書の更新（created: false）には、最大の premise の名指しも3手順も出ない', () => {
    const before = measureMemoryFloor([premise('doc', '短い本文')]);
    const after = measureMemoryFloor([premise('doc', '短い本文をもっと増やした')]);
    const reply = describeMemoryFloor({
      before,
      after,
      slug: 'doc',
      kind: 'premise',
      created: false,
    });

    expect(reply).not.toContain('いま最も大きい premise');
    expect(reply).not.toContain('memory_outline');
    expect(reply).not.toContain('memory_section_move');
    expect(reply).not.toContain('memory_frontmatter_set');
  });

  /**
   * `outlineSaturationNote`（1文書あたりの目次の予算。#772）— `before` /
   * `after` の両方を見て4つに分ける（A/B/C/無し。`describeMemoryFloor` の
   * doc の表）。
   *
   * ⚠ **訂正2（依頼者の決裁）: 「出さない」を歯で固定する。** 唯一の根拠は
   * 「張り付いていない回は1文字も出さない」——文字数の増減では測らず、
   * `張り付いている` / `越えた` / `切られなくなった` が1文字も含まれないことそのものを
   * assert する。**同じ歯で、焼き込みの側（`renderMemoryDocuments`）にも
   * 変更4の1文（`落ちている` / `移し切るまで`）が出ていないことを測る**
   * ——こちらが本当の「床 +0」である。
   */
  describe('outlineSaturationNote — 1文書あたりの目次の予算に対する4つの場合（#772）', () => {
    it('⭐ 収まっている → 収まっている: 1文字も出さない（floorLine にも焼き込みにも0）', () => {
      const before = measureMemoryFloor([premise('doc', '短い本文')]);
      const after = measureMemoryFloor([premise('doc', '短い本文をもっと増やした')]);
      const reply = describeMemoryFloor({
        before,
        after,
        slug: 'doc',
        kind: 'premise',
        created: false,
      });

      expect(reply).not.toContain('張り付いている');
      expect(reply).not.toContain('越えた');
      expect(reply).not.toContain('切られなくなった');

      // 焼き込みの側（変更4の1文）も0——こちらが本当の「床 +0」である。
      const rendered = renderMemoryDocuments([premise('doc', '短い本文をもっと増やした')]);
      expect(rendered).not.toContain('落ちている');
      expect(rendered).not.toContain('移し切るまで');
    });

    it('A: 張り付き → 張り付き: 「揺れ」の断り（節を移した効果ではない）', () => {
      const before = measureMemoryFloor([manySectionPremise('doc', 400)]);
      const after = measureMemoryFloor([manySectionPremise('doc', 450)]);
      const reply = describeMemoryFloor({
        before,
        after,
        slug: 'doc',
        kind: 'premise',
        created: false,
      });

      const afterFit = after.outlineSaturatedPremise.find((entry) => entry.slug === 'doc');
      expect(afterFit).toBeDefined();
      expect(reply).toContain('張り付いている');
      expect(reply).toContain('この増減は張り付いた領域の中の揺れであって、節を移した効果ではない');
      expect(reply).toContain(`全 ${afterFit!.total.toLocaleString('en-US')} 節`);
      expect(reply).toContain(
        `${afterFit!.shown.toLocaleString('en-US')} 節だけが焼き込みに載っている`,
      );
      expect(reply).toContain(
        `落ちている ${afterFit!.rest.toLocaleString('en-US')} 節を移し切るまで`,
      );
      // B・C の文言は出ない。
      expect(reply).not.toContain('越えた');
      expect(reply).not.toContain('切られなくなった');
    });

    it('B: 収まっている → 張り付き: 「この書き込みで予算を越えた」（増分は本物）', () => {
      const before = measureMemoryFloor([manySectionPremise('doc', 3)]);
      const after = measureMemoryFloor([manySectionPremise('doc', 400)]);
      const reply = describeMemoryFloor({
        before,
        after,
        slug: 'doc',
        kind: 'premise',
        created: false,
      });

      const afterFit = after.outlineSaturatedPremise.find((entry) => entry.slug === 'doc');
      expect(afterFit).toBeDefined();
      expect(reply).toContain('この書き込みで doc の節の目次が1文書あたりの予算');
      expect(reply).toContain('越えた');
      expect(reply).toContain('この増分は揺れではなく本物である');
      expect(reply).toContain(`${afterFit!.rest.toLocaleString('en-US')} 節が落ちた`);
      // A・C の文言は出ない。
      expect(reply).not.toContain('張り付いている');
      expect(reply).not.toContain('切られなくなった');
    });

    it('C: 張り付き → 飽和リストから外れた: 「目次で切られなくなった」。⛔ この先どう動くかは言わない', () => {
      const before = measureMemoryFloor([manySectionPremise('doc', 400)]);
      const after = measureMemoryFloor([manySectionPremise('doc', 3)]);
      const reply = describeMemoryFloor({
        before,
        after,
        slug: 'doc',
        kind: 'premise',
        created: false,
      });

      const beforeFit = before.outlineSaturatedPremise.find((entry) => entry.slug === 'doc');
      const afterFit = after.outlineSaturatedPremise.find((entry) => entry.slug === 'doc');
      expect(beforeFit).toBeDefined();
      expect(afterFit).toBeUndefined(); // after は定義上もう飽和していない。
      expect(reply).toContain('切られなくなった');
      expect(reply).toContain('省略の断り書きごと床から落ちた');
      // A・B の文言は出ない。
      expect(reply).not.toContain('張り付いている');
      expect(reply).not.toContain('越えた');
      // ⛔ この先どう動くかは言わない（下の indexed の歯が理由を持つ）。
      expect(reply).not.toContain('節を移した分だけ床が下がる');
    });

    /**
     * ⭐⭐ **C が「この先どう動くか」を言ってはいけない理由を、そのまま歯にする。**
     *
     * C は「飽和していた premise が `after.outlineSaturatedPremise` から消えた」
     * で発火するが、消え方は4通りある（予算に収まった／`indexed` になった／
     * `fact` になった／文書ごと消えた）。**`MemoryFloor` は slug ごとの区分を
     * 持たないので、この関数は4つを区別できない。**
     *
     * ⟹ かつて C は「ここから先は、節を移した分だけ床が下がる」と書いていたが、
     * **`indexed` へ移った回にはそれが偽である**——`indexed` は節の目次を1行も
     * 焼かないので、節を移しても床は1文字も動かない。**そして `premise` から
     * `indexed` への付け替えは実運用で最も多く起きた操作である**（本番の記憶は
     * 2026-09-12 時点で6文書中5文書が `indexed`）。この歯はその遷移を直接作って、
     * 偽の予測が戻ってこないことを固定する。
     */
    it('⭐⭐ premise → indexed で飽和が消えた回でも、C は「節を移した分だけ床が下がる」と言わない', () => {
      const saturated = manySectionPremise('doc', 400);
      const asIndexed: MemoryPart = {
        slug: 'doc',
        content: `---\ntype: indexed\ndescription: 付け替えた\n---\n${saturated.content}`,
      };
      const before = measureMemoryFloor([saturated]);
      const after = measureMemoryFloor([asIndexed]);
      // 前提: 節数は1つも減っていないのに、飽和リストからは消えている
      // （＝「節を移したから収まった」ではない、という遷移そのもの）。
      expect(before.outlineSaturatedPremise.map((entry) => entry.slug)).toContain('doc');
      expect(after.outlineSaturatedPremise).toHaveLength(0);
      expect(after.indexedDocs).toBe(1);

      const reply = describeMemoryFloor({
        before,
        after,
        slug: 'doc',
        kind: 'indexed',
        created: false,
      });

      expect(reply).toContain('切られなくなった');
      // 🔴 これが本題——`indexed` では節を移しても床は動かないので、偽になる。
      expect(reply).not.toContain('節を移した分だけ床が下がる');
      // そして「区別していない」ことを行そのものが名乗る。
      expect(reply).toContain('区別していない');
    });

    /**
     * ⭐⭐ **いちばん重要な歯（訂正3）。** `memory_section_move` は移し先
     * （`toSlug`）の視点で `slug` を渡す（`tools.ts` の「床は『移した先』の
     * 視点で言う」）。⟹ 「予算に張り付いた premise（A）から、別の文書（B）へ
     * 節を移す」呼び出しでは、`slug` に入っているのは B だが、名乗るべきは
     * **張り付いている当の文書 A** である。`input.slug` に引きずられて B を
     * 主語にしていないか、A を主語にできているかを両方確かめる。
     */
    it('⭐⭐ memory_section_move: slug（移し先 B）ではなく、張り付いている移動元 A を名乗る', () => {
      // A: 400節で飽和 → 300節を B へ移した後も、100節でなお飽和している
      // （揺れ＝A。数値は変わるので「何も変わっていない」側には落ちない）。
      const before = measureMemoryFloor([
        manySectionPremise('a-doc', 400),
        premise('b-doc', '移す前のB'),
      ]);
      const after = measureMemoryFloor([
        manySectionPremise('a-doc', 100),
        premise('b-doc', '移した後のB（節が増えた）'),
      ]);
      // `memory_section_move` は移し先（B）の視点で slug を渡す。
      const reply = describeMemoryFloor({
        before,
        after,
        slug: 'b-doc',
        kind: 'premise',
        created: false,
      });

      // 前提: a-doc は before/after とも本当に飽和していて、かつ数値が
      // 変わっている（そうでなければ「何も変わっていない」側に落ちて、
      // このテストは何も測らない）。
      const beforeAFit = before.outlineSaturatedPremise.find((entry) => entry.slug === 'a-doc');
      const afterAFit = after.outlineSaturatedPremise.find((entry) => entry.slug === 'a-doc');
      expect(beforeAFit).toBeDefined();
      expect(afterAFit).toBeDefined();
      expect(beforeAFit!.rest).not.toBe(afterAFit!.rest);

      // 名乗るべきは A ——slug（B）ではない。
      expect(reply).toContain('a-doc の節の目次は1文書あたりの予算');
      expect(reply).toContain('張り付いている');
      // ⛔ B（`input.slug`）を主語にした一文は出ない。
      expect(reply).not.toContain('b-doc の節の目次');
    });

    /**
     * ⭐ 「飽和しているが何も変わっていない premise」は名乗らない——無関係な
     * 文書へ書いたターンで、張り付いた別の文書の名前が毎回出るのを防ぐ側
     * （`demotedNote` と同じ「噛んでいない回は1文字も出さない」の倒し方）。
     */
    it('⭐ 飽和したまま何も変わっていない premise は、無関係な書き込みでは名乗らない', () => {
      const saturatedElsewhere = manySectionPremise('saturated-elsewhere', 400);
      const before = measureMemoryFloor([saturatedElsewhere, premise('unrelated', '元の本文')]);
      const after = measureMemoryFloor([
        saturatedElsewhere,
        premise('unrelated', '書き換えた本文'),
      ]);

      // 前提: saturated-elsewhere は前後で1文字も変わっていない
      // （数値が同一であることを直接確かめる）。
      const beforeFit = before.outlineSaturatedPremise.find(
        (entry) => entry.slug === 'saturated-elsewhere',
      );
      const afterFit = after.outlineSaturatedPremise.find(
        (entry) => entry.slug === 'saturated-elsewhere',
      );
      expect(beforeFit).toEqual(afterFit);

      const reply = describeMemoryFloor({
        before,
        after,
        slug: 'unrelated',
        kind: 'premise',
        created: false,
      });

      expect(reply).not.toContain('saturated-elsewhere');
      expect(reply).not.toContain('張り付いている');
    });
  });
});

/**
 * `describeMemoryReinjectionEstimate` — 「この書き込みによって、次のターンの
 * 会話へ載る見込みの文字数」の一言（P2、#318 の続き）。
 *
 * **`describeMemoryFloor`（直上）とは別の量を測る歯である。** あちらは
 * 「毎ターン焼き込まれ続ける総量」（記憶全体の before/after）、こちらは
 * 「この書き込みの結果、`#withFreshMemory` が次の1ターンだけ差分として
 * 載せ直す量」（`renderMemoryDocuments(changed)`、changed はこの書き込みで
 * 変わった文書だけ）。**中心は区分で結果が変わること**——premise は全文、
 * fact は目次1行ぶんしか返らない。
 */
describe('describeMemoryReinjectionEstimate — 「次のターンの会話へ載る見込み」の一言', () => {
  it('⭐ premise の文書へ書くと、renderMemoryDocuments([文書]) と一致する文字数が出る（載るのはカード）', () => {
    const doc = premise('about-me-core', 'あ'.repeat(500));
    const reply = describeMemoryReinjectionEstimate([doc], [doc], new Map());
    const expectedChars = renderMemoryDocuments([doc]).length;

    expect(reply).toContain(`${expectedChars.toLocaleString('en-US')} 文字`);
    // **かつてここは `premise・全文` を測り、本文が実際に載ることまで見ていた。**
    // 載り方がカードへ変わったので（人間の決定 2026-09-08）、**本文が載らない
    // ことのほうを測る**——アサーションは消していない。向きが反転しただけである。
    expect(reply).toContain('premise・カード（要旨＋節の目次）');
    expect(renderMemoryDocuments([doc])).not.toContain('あ'.repeat(500));
    // 代わりに見出しは載る（何が書いてあるかは分かる）。
    expect(renderMemoryDocuments([doc])).toContain('# about-me-core');
  });

  it('⭐ fact の文書へ書くと、目次1行ぶんしか出ない——同じ本文量でも premise よりずっと小さい', () => {
    const factDoc = fact('runbook', {
      description: '費用の推移',
      freshness: { kind: 'fresh' },
    });
    // 本文が長くても、目次1行にしか影響しない（本文自体は载らない）。
    const longFactDoc: MemoryPart = { ...factDoc, content: factDoc.content + 'あ'.repeat(5000) };
    const reply = describeMemoryReinjectionEstimate([longFactDoc], [longFactDoc], new Map());
    const expectedChars = renderMemoryDocuments([longFactDoc]).length;

    expect(reply).toContain(`${expectedChars.toLocaleString('en-US')} 文字`);
    expect(reply).toContain('fact・目次1行');
    // 5,000文字の本文は目次側には出ない（載る量は本文量に比例しない）。
    expect(expectedChars).toBeLessThan(200);
  });

  it('⭐ 区分で結果が変わる——同じ本文量の premise と fact を比べると、fact のほうが小さい数を返す', () => {
    const body = 'あ'.repeat(1000);
    const premiseDoc = premise('doc-p', body);
    const factDoc: MemoryPart = {
      ...fact('doc-f', { description: '要旨', freshness: { kind: 'fresh' } }),
      content: `---\ntype: fact\ndescription: 要旨\n---\n# doc-f\n${body}`,
    };

    const premiseChars = renderMemoryDocuments([premiseDoc]).length;
    const factChars = renderMemoryDocuments([factDoc]).length;

    expect(describeMemoryReinjectionEstimate([premiseDoc], [premiseDoc], new Map())).toContain(
      `${premiseChars.toLocaleString('en-US')} 文字`,
    );
    expect(describeMemoryReinjectionEstimate([factDoc], [factDoc], new Map())).toContain(
      `${factChars.toLocaleString('en-US')} 文字`,
    );
    expect(factChars).toBeLessThan(premiseChars);
  });

  it('⚠️「他に何も変わらなければ」という条件付きであることを明言する（単一文書でも複数文書でも）', () => {
    const singleParts: [MemoryPart] = [premise('a', '本文')];
    const multiParts: [MemoryPart, MemoryPart] = [premise('a', '本文'), premise('b', '本文')];
    const single = describeMemoryReinjectionEstimate(singleParts, singleParts, new Map());
    const multi = describeMemoryReinjectionEstimate(multiParts, multiParts, new Map());

    for (const reply of [single, multi]) {
      expect(reply).toContain('予測であって実測ではない');
      expect(reply).toContain('他に何も変わらなければ');
      expect(reply).toContain('単純に合算しないこと');
    }
  });

  it('⭐ memory_section_move の形（2文書）では、両方の合計が1つの数として出る（別々に render して足したものとは限らず、まとめて render した値と一致する）', () => {
    const fromDoc = premise('about-me', 'あ'.repeat(300));
    const toDoc = premise('about-me-appendix', 'い'.repeat(300));

    const reply = describeMemoryReinjectionEstimate([toDoc, fromDoc], [toDoc, fromDoc], new Map());
    const combinedChars = renderMemoryDocuments([toDoc, fromDoc]).length;
    const separateSum =
      renderMemoryDocuments([toDoc]).length + renderMemoryDocuments([fromDoc]).length;

    expect(reply).toContain(`${combinedChars.toLocaleString('en-US')} 文字`);
    // まとめて render した値は、別々に render して足した値とは一致しない
    // （premise 同士を繋ぐ区切り文字のぶん）——「合計」を選んだ理由そのもの。
    expect(combinedChars).not.toBe(separateSum);
    expect(reply).toContain('about-me-appendix と about-me の合計');
  });

  it('⚠️ memory_section_move（2文書）だけに「両方の合計である」の注記が出る——1文書のときは出ない', () => {
    const singleParts: [MemoryPart] = [premise('a', '本文')];
    const multiParts: [MemoryPart, MemoryPart] = [premise('a', '本文'), premise('b', '本文')];
    const single = describeMemoryReinjectionEstimate(singleParts, singleParts, new Map());
    const multi = describeMemoryReinjectionEstimate(multiParts, multiParts, new Map());

    expect(single).not.toContain('移動元と移動先の両方');
    expect(multi).toContain('移動元と移動先の両方');
    expect(multi).toContain('両方まとめて渡した結果');
  });

  it('内訳に文書ごとの区分（premise・カード / fact・目次1行）が並ぶ', () => {
    const premiseDoc = premise('about-me', '本文');
    const factDoc: MemoryPart = {
      ...fact('appendix', { description: '付録', freshness: { kind: 'fresh' } }),
    };

    const reply = describeMemoryReinjectionEstimate(
      [factDoc, premiseDoc],
      [factDoc, premiseDoc],
      new Map(),
    );

    expect(reply).toContain('appendix（fact・目次1行）');
    // ラベルは実際に載る形を言い当てる（`premise・全文` から言い換えた）。
    expect(reply).toContain('about-me（premise・カード（要旨＋節の目次））');
  });

  it('parts が空なら呼び手の実装誤りとして例外を投げる（型を迂回した呼び手への最後の砦）', () => {
    // **引数は非空タプル（`readonly [MemoryPart, ...MemoryPart[]]`）にしてある**
    // ので、`tsc` は素の `[]` を拒む。ここで確かめたいのは「型を迂回して空を
    // 渡した呼び手」への `throw` が残っていることそのものなので、意図して
    // `as unknown as` で型を迂回する（`describeMemoryReinjectionEstimate` の doc
    // 「引数を非空タプルにしてある理由」）。
    const empty = [] as unknown as [MemoryPart, ...MemoryPart[]];
    expect(() => describeMemoryReinjectionEstimate(empty, [], new Map())).toThrow();
  });

  /**
   * 第2引数（`memoryAfter`）も必須である——**空配列を渡しても `throw` しない**
   * （`describeMemoryReinjectionEstimate` の doc「空配列を渡されても throw
   * しない」）。空は「`presentInMemory` を渡さなかった」のと同じ挙動になる
   * だけで、`parts` の非空タプルとは扱いが違う（あちらは呼び手の実装誤りの
   * 最後の砦、こちらはストアの状態そのもの）。
   */
  it('memoryAfter に空配列を渡しても throw しない（presentInMemory 無しと同じ挙動になるだけ）', () => {
    const doc = fact('orphan', { description: '説明', freshness: { kind: 'fresh' } });
    expect(() => describeMemoryReinjectionEstimate([doc], [], new Map())).not.toThrow();
  });

  /**
   * ⭐ 本題（親が今回の書き込みに含まれない fact を書いたとき）。
   *
   * これが直る前は、`describeMemoryReinjectionEstimate` は `parts`（今回書いた
   * 文書）しか見ておらず、`presentInMemory` を渡していなかった。書いた文書の
   * `parent` が今回の書き込みに含まれない premise を指しているとき、実際に
   * `#withFreshMemory` が載せる印（「在るが、ここに載せた分には含まれない」）
   * より短い印（「見つからない」）で数えてしまい、**実測32文字少なく出ていた**
   * （`memory.ts` の「⭐ 直っていたもの」の doc）。
   */
  it('⭐ 親が今回の書き込みに含まれない premise を指す fact を書いたとき、見込みは「見つからない」ではなく「ここに載せた分には含まれない」の印ぶんで数える', () => {
    const core = premise('core', '前提の本文');
    const child = fact('child', {
      description: '子',
      freshness: { kind: 'fresh' },
      parent: 'core',
    });
    const memoryAfter = [core, child];

    const reply = describeMemoryReinjectionEstimate([child], memoryAfter, new Map());
    const expectedChars = renderMemoryDocuments([child], { presentInMemory: memoryAfter }).length;
    // 直す前の数え方（presentInMemory を渡さない）と比べて、実際に文字数が
    // 増えていること（短い印のままではないこと）を対照として見る。
    const beforeFixChars = renderMemoryDocuments([child]).length;

    expect(reply).toContain(`${expectedChars.toLocaleString('en-US')} 文字`);
    expect(expectedChars).toBeGreaterThan(beforeFixChars);
    expect(renderMemoryDocuments([child], { presentInMemory: memoryAfter })).toContain(
      '親 core は在るが、ここに載せた分には含まれない',
    );
  });
});

/**
 * `describeMemorySessionDelta` — 「セッション構築時点からの増分」の一言
 * （P3、#318 の続き。閾値なし）。
 *
 * **`describeMemoryFloor` / `describeMemoryReinjectionEstimate`（上の2つ）とは
 * 別の量を測る歯である。** あの2つは「毎ターン焼き込まれ続ける総量」と
 * 「次のターンだけ差分として載る量」で、こちらは「次にセッションが**組み立て
 * 直されたら**焼かれる量」——比較の相手は前回の書き込みではなく
 * `CloneRuntimeFacts.injectedMemoryChars`（このセッションの構築時点の値）。
 */
describe('describeMemorySessionDelta — 「セッション構築時点からの増分」の一言（P3）', () => {
  it('⭐ セッション構築時点から増えていれば、方向（増える）と割合が出る', () => {
    const reply = describeMemorySessionDelta({ afterChars: 150, injectedMemoryChars: 100 });

    expect(reply).toContain('次に組み立て直されたら焼かれる量（セッション構築時点との差）');
    expect(reply).toContain('セッション構築時点 100 文字');
    expect(reply).toContain('いま 150 文字');
    expect(reply).toContain('+50 文字');
    expect(reply).toContain('+50%');
    expect(reply).toContain('増える見込み');
  });

  it('⭐ セッション構築時点から減っていれば、方向（減る）と負の割合が出る', () => {
    const reply = describeMemorySessionDelta({ afterChars: 60, injectedMemoryChars: 100 });

    expect(reply).toContain('-40 文字');
    expect(reply).toContain('-40%');
    expect(reply).toContain('減る見込み');
    expect(reply).not.toContain('増える');
  });

  /**
   * ⭐ 必須の歯（依頼者が名指し）。片側だけだと「常に増えたと言う実装」が
   * 緑で通ってしまう——`afterChars === injectedMemoryChars` のとき、
   * 「増える」「減る」のどちらにも読める語を出さないことを確かめる。
   */
  it('⭐⭐ 増分が0のとき（何も変わっていないとき）に、増えたかのような文言を出さない（必須の歯）', () => {
    const reply = describeMemorySessionDelta({ afterChars: 100, injectedMemoryChars: 100 });

    expect(reply).toContain('変わっていない');
    expect(reply).not.toMatch(/増え/);
    expect(reply).not.toMatch(/減っ/);
  });

  it('セッション構築時点が0文字だったときは、割合を捏造せず「出せない」と言う', () => {
    const reply = describeMemorySessionDelta({ afterChars: 40, injectedMemoryChars: 0 });

    expect(reply).toContain('+40 文字');
    expect(reply).toContain('割合は出せない');
    expect(reply).not.toMatch(/%/);
  });

  /**
   * ⚠️ `injectedMemoryChars` が引けない呼び手のための代替経路（依頼者が
   * 事後に承認）。**黙って差し替えない**——現在値であることを文言に明記する。
   */
  it('⚠️ injectedMemoryChars が null（引けない）なら、現在値であることを明記して現在値を出す', () => {
    const reply = describeMemorySessionDelta({ afterChars: 12_345, injectedMemoryChars: null });

    expect(reply).toContain('12,345 文字');
    expect(reply).toContain('現在値である');
    expect(reply).not.toContain('次に組み立て直されたら焼かれる量（セッション構築時点との差）');
  });

  it('閾値・警告に相当する語を使わない（判断はクローンが下す）', () => {
    const grown = describeMemorySessionDelta({ afterChars: 999_999, injectedMemoryChars: 1 });
    const fallback = describeMemorySessionDelta({ afterChars: 999_999, injectedMemoryChars: null });

    for (const reply of [grown, fallback]) {
      expect(reply).not.toContain('畳');
      expect(reply).not.toContain('危な');
      expect(reply).not.toContain('断る');
      expect(reply).not.toContain('べきだ');
    }
  });
});

/**
 * `describeMemoryPremiseRanking` — 「premise の大きさの順位」の一言
 * （P3、#318 の続き）。
 *
 * **`describeMemoryFloor` の `largestPremise`（premise を新規作成した枝でしか
 * 出ない、最大の1件だけの名指し）とは別物。** こちらは呼ぶたびに、いま在る
 * 全 premise を大きい順に並べる——「どれが大きいか」ではなく「どういう順に
 * 大きいか」まで見せる。
 */
describe('describeMemoryPremiseRanking — 「premise の大きさの順位」の一言（P3）', () => {
  it('premise が無ければ、順位ではなくその旨を言う', () => {
    const reply = describeMemoryPremiseRanking([]);
    expect(reply).toContain('premise の大きさの順位');
    expect(reply).toContain('いま premise はまだ無い');
  });

  it('fact しか無くても、順位ではなくその旨を言う（fact は対象にしない）', () => {
    const reply = describeMemoryPremiseRanking([fact('runbook', { description: '事実' })]);
    expect(reply).toContain('いま premise はまだ無い');
  });

  it('⭐ premise を大きい順に並べる', () => {
    const small = premise('doc-small', 'あ'.repeat(10));
    const large = premise('doc-large', 'い'.repeat(1000));
    const medium = premise('doc-medium', 'う'.repeat(100));

    const reply = describeMemoryPremiseRanking([small, large, medium]);

    const idxLarge = reply.indexOf('doc-large:');
    const idxMedium = reply.indexOf('doc-medium:');
    const idxSmall = reply.indexOf('doc-small:');
    expect(idxLarge).toBeGreaterThan(-1);
    expect(idxMedium).toBeGreaterThan(-1);
    expect(idxSmall).toBeGreaterThan(-1);
    expect(idxLarge).toBeLessThan(idxMedium);
    expect(idxMedium).toBeLessThan(idxSmall);
    expect(reply).toContain('1. doc-large:');
    expect(reply).toContain('全 3 件');
  });

  it('同じ大きさなら slug 昇順で決定的に並ぶ（呼ぶたびに順序が入れ替わらない）', () => {
    const a = premise('aaa', 'おなじ本文');
    const z = premise('zzz', 'おなじ本文');

    const reply1 = describeMemoryPremiseRanking([z, a]);
    const reply2 = describeMemoryPremiseRanking([a, z]);

    expect(reply1).toBe(reply2);
    expect(reply1.indexOf('aaa:')).toBeLessThan(reply1.indexOf('zzz:'));
  });

  it('fact は数えない——premise だけの順位になる', () => {
    const p = premise('doc-p', '本文');
    const f = fact('doc-f', { description: '要旨' });

    const reply = describeMemoryPremiseRanking([p, f]);

    expect(reply).toContain('doc-p:');
    expect(reply).not.toContain('doc-f:');
    expect(reply).toContain('全 1 件');
  });

  /**
   * サイズの数え方は `measureMemoryFloor` と揃える——malformed な frontmatter
   * には説明の1行が前に付くので、`content.length` だけを足すと実物より
   * 少ない数を名乗ることになる（`measureMemoryFloor` の doc と同じ理由）。
   */
  it('malformed な frontmatter を持つ premise は、content.length ではなく実際に載る形で数える', () => {
    const malformed: MemoryPart = {
      slug: 'broken',
      content: '---\nnot: [valid\n---\n# 壊れた\n本文',
    };
    expect(resolveMemoryDocKind(parseMemoryFrontmatter(malformed.content))).toBe('premise');

    const reply = describeMemoryPremiseRanking([malformed]);
    const match = /broken: ([\d,]+) 文字/.exec(reply);
    expect(match).not.toBeNull();
    const reportedChars = Number(((match as RegExpExecArray)[1] ?? '').replace(/,/g, ''));
    expect(reportedChars).toBeGreaterThan(malformed.content.length);
  });

  /**
   * ⭐ 一覧の上限は文字数で持つ（AGENTS.md の地雷表「一覧の上限を件数だけで
   * 決める」）。切ったら省いた件数を必ず言う（`.claude/skills/listing-and-detail/`）。
   */
  it('⭐ 予算を超えたら、件数ではなく文字数で切り、省いた件数を必ず言う', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      premise(`p${i.toString().padStart(4, '0')}`, '本文'),
    );

    const reply = describeMemoryPremiseRanking(many);

    expect(reply).toMatch(/…ほか \d+ 件は省略/);
    expect(reply).toContain('全 200 件');
    expect(reply).toContain('memory_list で確認できる');

    const shownMatch = /大きい順に (\d+) 件だけ出した/.exec(reply);
    expect(shownMatch).not.toBeNull();
    const shown = Number((shownMatch as RegExpExecArray)[1]);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(200);

    const restMatch = /…ほか (\d+) 件は省略/.exec(reply);
    const rest = Number((restMatch as RegExpExecArray)[1]);
    expect(shown + rest).toBe(200);
  });

  it('予算に収まる件数なら、省略の注記を出さない', () => {
    const few = [premise('a', '本文'), premise('b', '本文')];
    const reply = describeMemoryPremiseRanking(few);
    expect(reply).not.toContain('省略');
    expect(String(MEMORY_PREMISE_RANKING_BUDGET)).not.toBe('0'); // 定数が生きていることの最小確認
  });

  it('閾値・警告に相当する語を使わない（判断はクローンが下す）', () => {
    const many = Array.from({ length: 5 }, (_, i) => premise(`p${i}`, 'あ'.repeat(1000)));
    const reply = describeMemoryPremiseRanking(many);

    expect(reply).not.toContain('畳');
    expect(reply).not.toContain('危な');
    expect(reply).not.toContain('大きすぎ');
  });
});

/**

/**
 * ⭐ premise の焼き込み（`renderPremiseCard`）と、載せ直しの絞り込み
 * （`RenderMemoryDocumentsOptions.seenContent`）。
 *
 * ## この2つが在る理由（本番の実測、2026-09-08T00:15Z〜00:40Z）
 *
 * Railway の PostgreSQL を直接引いた値:
 *
 * | | 値 |
 * | --- | --- |
 * | premise 5本の合計 | 527,277 文字（≒ 411,000 トークン）を**毎ターン**焼いていた |
 * | 要旨＋見出しだけなら | 73,285 文字（13.9%。≒ 57,000 トークン） |
 * | `alteroid-work` | 303,013 文字・**917 節**（1節あたり約 330 文字＝ログである） |
 * | 記憶の書き換え（2026-09-07） | 244 回。載せ直された総量 80 MB に対し、実際に変わったのは約 567 kB |
 *
 * 人間の決定（2026-09-08）: **「読みたいときに読める仕組みは必要だが、毎回
 * 全行読ませるのは無駄だと感じる。」**
 *
 * **測るのは3つ**——(a) 本文が載らないこと (b) それでも「何が書いてあるか」と
 * 「どう開くか」は載ること (c) 載せ直しが変わった範囲だけになること。
 * **(b) が無いとこの変更は能力の削除である。**
 */
describe('premise の焼き込み（カード）と、載せ直しの絞り込み（seenContent）', () => {
  /** 節が多い premise。**差分が意味を持つのは、カードが十分に大きいときだけである。** */
  function manySections(count: number, extra = ''): string {
    const body = Array.from({ length: count }, (_, i) => `## 節${i}\n節${i}の本文である。`).join(
      '\n',
    );
    return `---\ntype: premise\ndescription: 前提の要旨\n---\n${body}${extra}`;
  }

  it('⭐ カードには本文が載らず、要旨・節の見出し・節id・文字数・開き方が載る', () => {
    const rendered = renderMemoryDocuments([
      {
        slug: 'about-me',
        content:
          '---\ntype: premise\ndescription: 私の要旨\n---\n## 判断の基準\nここが本文である。',
      },
    ]);

    // (a) 本文は1文字も載らない。
    expect(rendered).not.toContain('ここが本文である');
    // (b) 何が書いてあるかは分かる（要旨と見出し）。
    expect(rendered).toContain('要旨: 私の要旨');
    expect(rendered).toContain('## 判断の基準');
    // (b) どう開くかも書いてある（これが無いと能力の削除になる）。
    expect(rendered).toContain('memory_section_read');
    // (b) 節id が実際に載っている（目次を取り直さずに開ける）。
    expect(rendered).toMatch(/\[[0-9a-f]{8}-[0-9a-f]{8}\] ## 判断の基準 — /);
    // 大きさが桁で違う（この変更の目的そのもの）。
    expect(rendered.length).toBeLessThan(400);
  });

  it('要旨がまだ書かれていない premise では、書けと言う（黙って空欄にしない）', () => {
    const rendered = renderMemoryDocuments([{ slug: 'doc', content: '## 節\n本文' }]);
    expect(rendered).toContain('要旨: （まだ書かれていない');
    expect(rendered).toContain('memory_frontmatter_set');
  });

  it('見出しが1つも無い premise では、節が無いことと見出しを付ける利点を言う', () => {
    const rendered = renderMemoryDocuments([{ slug: 'doc', content: '見出しの無い本文' }]);
    expect(rendered).toContain('節: 1つも無い');
    expect(rendered).not.toContain('見出しの無い本文');
    expect(rendered).toContain('memory_read');
  });

  /**
   * ⭐ 目安（線）。**門ではない**——書き込みは1つも止めない。
   * 予算に当たったこと自体が「この文書を割れ」という合図であり、その手順を
   * 断り書きに書く（`excerpt.ts` の「続きの取り方を書けるのは、呼び手の側に
   * その口が実在するときだけである」）。
   */
  it('⭐ 目次が予算に収まらない文書は、省いた件数と「割る手順」を名乗る', () => {
    const huge = Array.from(
      { length: 400 },
      (_, i) => `## これは十分に長い見出しであり予算を食い尽くす ${i}\n本文`,
    ).join('\n');
    const rendered = renderMemoryDocuments([
      { slug: 'big', content: `---\ntype: premise\ndescription: 大きい\n---\n${huge}` },
    ]);

    expect(rendered).toContain('節は目次から省略');
    expect(rendered).toContain('目次すら毎ターンの焼き込みに収まっていない');
    expect(rendered).toContain('memory_section_move');
    // 予算そのものは超えない（超えたら「予算」の意味が無い）。
    expect(rendered.length).toBeLessThan(MEMORY_PROMPT_OUTLINE_BUDGET * 2);
  });

  /**
   * ⭐⭐ **「切った」だけでは行動に繋がらない。落ちた側を名指しする。**
   *
   * 予算で落ちるのは常に末尾側なので、**追記で育つ文書では「いま足した節」が
   * 落ちる**（`MEMORY_PROMPT_OMITTED_TAIL_BUDGET` の doc の観測）。⟹ 断り書きが
   * 件数しか名乗らないと、読み手は「N 節省略」を「だから今日足したものが
   * 見えない」へ繋げられない。**落ちているのは本文であって見出しではない**ので、
   * 見出しは断り書きに入る。
   */
  it('⭐⭐ 目次が予算で切れた文書は、落ちた末尾の直近の節を節id つきで名指しする', () => {
    // 末尾の節だけ見分けられる見出しにする（先頭側に紛れないこと）。
    const filler = Array.from(
      { length: 200 },
      (_, i) => `## これは十分に長い見出しであり予算を食い尽くす ${i}\n本文`,
    ).join('\n');
    const content =
      `---\ntype: premise\ndescription: 大きい\n---\n${filler}\n` +
      '## 58. 今日足したばかりの規則\n本文';
    const rendered = renderMemoryDocuments([{ slug: 'big', content }]);

    // 前提: 末尾は本当に落ちている（落ちていなければこのテストは何も測らない）。
    expect(rendered).toContain('節は目次から省略');
    const omissionAt = rendered.indexOf('節は目次から省略');
    const namedAt = rendered.indexOf('## 58. 今日足したばかりの規則');
    expect(namedAt).toBeGreaterThan(omissionAt);

    // 名指しは「節id つきの行そのまま」である ⟹ memory_section_read へ渡せる。
    expect(rendered).toMatch(/\[[0-9a-f]{8}-[0-9a-f]{8}\] ## 58\. 今日足したばかりの規則 — /);
    expect(rendered).toContain('節id はそのまま memory_section_read に渡せる');
  });

  /**
   * ⚠️ **名指しの量は件数ではなく文字数で持つ。** 見出しの長さは節ごとに
   * ばらばらなので、「直近3節」のように件数で決めると断り書きの長さが見出し
   * 次第で暴れる（`excerpt.ts` の `ListingBudget`「件数から出力量を決めると、
   * 何件で壊れるかが運任せになる」。`manager_list` で一覧が丸ごと落ちた形）。
   */
  it('⚠ 落ちた末尾の名指しは件数ではなく文字数で切る（長い見出し1本で暴れない）', () => {
    const filler = Array.from(
      { length: 200 },
      (_, i) => `## これは十分に長い見出しであり予算を食い尽くす ${i}\n本文`,
    ).join('\n');
    const monster = `## ${'長'.repeat(4_000)}\n本文`;
    const rendered = renderMemoryDocuments([
      {
        slug: 'big',
        content: `---\ntype: premise\ndescription: 大きい\n---\n${filler}\n${monster}`,
      },
    ]);

    // 4,000 文字の見出しが丸ごと断り書きへ出ることは無い。
    expect(rendered).not.toContain('長'.repeat(4_000));
    // 名指しのぶんは予算 ＋ 切った跡の合図ぶんに収まる。
    const namedBlock = rendered.slice(rendered.indexOf('落ちた末尾のうち直近の節'));
    expect(namedBlock.length).toBeLessThan(MEMORY_PROMPT_OMITTED_TAIL_BUDGET * 4);
  });

  /**
   * ⭐ **「何をすれば直るか」まで出す。** 「N 節省略」は状態の報告であって、
   * 次の一手にならない。1行の平均・そのうちの固定費・縮める目標を数字で出す。
   */
  it('⭐ 縮めれば載る文書には、見出しを平均いくつまで縮めればよいかを数字で出す', () => {
    const huge = Array.from(
      { length: 120 },
      (_, i) => `## これは十分に長い見出しであり予算を食い尽くす ${i}\n本文`,
    ).join('\n');
    const rendered = renderMemoryDocuments([
      { slug: 'big', content: `---\ntype: premise\ndescription: 大きい\n---\n${huge}` },
    ]);

    expect(rendered).toMatch(/1行の平均は \d+ 文字（うち節id と文字数の固定費が \d+ 文字）。/);
    expect(rendered).toMatch(/見出しを平均 \d+ 文字（いま \d+ 文字）まで縮める必要がある。/);
  });

  /**
   * 🔴 **達成不能な助言を出さない。** 1行の固定費（節id 17 文字 ＋ `— N 文字`）は
   * **節数に比例する** ⟹ 節が増えると、見出しを最短（`# x`）まで縮めても予算に
   * 入らない点を越える。**そこで「縮めれば載る」と出すのは嘘である**（縮める先が
   * 無い）。⟹ そのときは「割るしかない」と名乗る。
   *
   * これは `excerpt.ts` の「続きの取り方を書けるのは、呼び手の側にその口が実在
   * するときだけである」を助言の側へ当てた形である。
   */
  it('🔴 見出しを最短まで縮めても載らない文書には「縮めれば載る」と言わず、割れと言う', () => {
    // 見出しは最短に近いのに、節数で固定費が予算を食い切る形（実運用の
    // alteroid-work は 917 節ある）。
    const many = Array.from({ length: 400 }, (_, i) => `# ${i}\n本文`).join('\n');
    const rendered = renderMemoryDocuments([
      { slug: 'log', content: `---\ntype: premise\ndescription: 追記だけの文書\n---\n${many}` },
    ]);

    expect(rendered).toContain('節は目次から省略');
    expect(rendered).toContain('見出しを最短');
    expect(rendered).toContain('割るしかない');
    // 🔴 嘘を出さない: 縮める目標は1つも出さない。
    expect(rendered).not.toMatch(/まで縮める必要がある/);
  });

  /**
   * ⭐⭐⭐ **名乗った助言が実行可能であることを、助言のとおりにやって確かめる。**
   *
   * 断り書きは「見出しを平均 N 文字まで縮めれば全節が載る」と言う。⟹ **その N
   * まで実際に縮めて描き直し、本当に省略が消えることを見る。** 数を書き写して
   * 突き合わせるのではなく、**言ったことをやって結果を見る**形にしてある——
   * こうすると N の丸め方（floor / ceil）を1つ間違えただけでここが落ちる。
   *
   * これは `excerpt.ts` の「続きの取り方を書けるのは、呼び手の側にその口が実在
   * するときだけである」の、助言版の歯である。
   */
  it('⭐⭐⭐ 名乗った目標まで見出しを縮めると、本当に全節が載る（助言が実行できる）', () => {
    // 番号を先頭に置く（縮めたあとも見出しが重複しない ⟹ 節id が衝突しない）。
    const heading = (i: number) => `## ${i}. ${'あ'.repeat(60)}`;
    const build = (make: (i: number) => string) =>
      `---\ntype: premise\ndescription: 規則\n---\n` +
      Array.from({ length: 106 }, (_, i) => `${make(i + 1)}\n${'本文'.repeat(60)}`).join('\n');

    const before = renderMemoryDocuments([{ slug: 'rules', content: build(heading) }]);
    const target = /見出しを平均 (\d+) 文字（いま \d+ 文字）まで縮める必要がある。/.exec(before);
    expect(target).not.toBeNull();
    const limit = Number((target as RegExpExecArray)[1]);

    // 助言のとおり、全部の見出しをその長さまで縮める。
    const after = renderMemoryDocuments([
      { slug: 'rules', content: build((i) => heading(i).slice(0, limit)) },
    ]);
    expect(after).not.toContain('節は目次から省略');
    // 縮める前は本当に切れていた（切れていなければこのテストは何も測らない）。
    expect(before).toContain('節は目次から省略');
  });

  /**
   * ⚠️ **「縮めろ」と言うときの目標は、縮められる下限（`# x` の3文字）を
   * 下回ってはならない。** 下回った数を出すのは、達成不能な助言を「達成可能」の
   * 顔で出すことである——`renderPremiseOutlineOmission` が反転を判定している線
   * そのものを、**節数を振って総当たりで**見る（1点の実例では、線が1文字ずれても
   * 気づかない）。
   */
  it('⚠ 縮めろと言うときの目標は、見出しの最短（3文字）を下回らない', () => {
    const claims: number[] = [];
    for (let n = 150; n <= 260; n += 1) {
      const body = Array.from({ length: n }, (_, i) => `# ${i}\n本`).join('\n');
      const rendered = renderMemoryDocuments([
        { slug: 'log', content: `---\ntype: premise\ndescription: d\n---\n${body}` },
      ]);
      const hit = /見出しを平均 (\d+) 文字（いま \d+ 文字）まで縮める必要がある。/.exec(rendered);
      if (hit !== null) claims.push(Number(hit[1]));
    }
    // この範囲には「縮めれば載る」と言う文書が実在する（0件ならこのテストは
    // 何も測っていない）。
    expect(claims.length).toBeGreaterThan(0);
    expect(Math.min(...claims)).toBeGreaterThanOrEqual(3);
  });

  /**
   * ⭐ **左右を揃える。** 反転側（`⚠ 節id と文字数の固定費だけで…`）は以前から
   * 予算値を出していたが、非反転側（`1行の平均は…`）は出していなかった——
   * 同じ断り書きの中で片方だけ予算を名乗らない状態だった。両側とも
   * `MEMORY_PROMPT_OUTLINE_BUDGET` の値を出すことを固定する。
   */
  it('⭐ 目次が予算で切れた断り書きは、反転側・非反転側のどちらでも予算値を名乗る', () => {
    const budgetPhrase = `予算 ${MEMORY_PROMPT_OUTLINE_BUDGET.toLocaleString('en-US')} 文字`;

    // 非反転側（「見出しを縮めれば載る」）——固定費が節数に比例して予算を
    // 食い切る手前の点（既存の歯「名乗った目標まで見出しを縮めると…」と
    // 同じ形の入力）。
    const shrinkable = Array.from(
      { length: 120 },
      (_, i) => `## これは十分に長い見出しであり予算を食い尽くす ${i}\n本文`,
    ).join('\n');
    const nonInverted = renderMemoryDocuments([
      {
        slug: 'shrinkable',
        content: `---\ntype: premise\ndescription: 大きい\n---\n${shrinkable}`,
      },
    ]);
    // 前提: 本当に非反転側（「縮めれば載る」）に入っている。
    expect(nonInverted).toMatch(/見出しを平均 \d+ 文字（いま \d+ 文字）まで縮める必要がある。/);
    expect(nonInverted).toContain(budgetPhrase);

    // 反転側（「縮めても載らない」）——見出しを最短近くまで削っても固定費
    // だけで予算を超える節数（既存の歯「見出しを最短まで縮めても載らない
    // 文書には…」と同じ形の入力）。
    const unshrinkable = Array.from({ length: 400 }, (_, i) => `# ${i}\n本文`).join('\n');
    const inverted = renderMemoryDocuments([
      {
        slug: 'unshrinkable',
        content: `---\ntype: premise\ndescription: 追記だけの文書\n---\n${unshrinkable}`,
      },
    ]);
    // 前提: 本当に反転側（「縮めても載らない」）に入っている。
    expect(inverted).toContain('見出しを最短');
    expect(inverted).not.toMatch(/まで縮める必要がある。/);
    expect(inverted).toContain(budgetPhrase);
  });

  /**
   * ⭐⭐ **断り書きは節数だけでなく目次の総量（文字数）を出す。**
   *
   * 節数だけでは「この文書を割るべきか」の判断に文字数の推測が要る——
   * 節を移しても目次に乗っている文字数（＝床）が減るとは限らないため
   * （落ちるのは常に末尾なので、末尾を移しても先頭側の目次は動かない）。
   * ⟹ 全体・載った分・省いた分の3つを出し、**足し算で整合すること**を
   * 変異に強い形で測る（別の量を出す変異・内訳を壊す変異は、この足し算で
   * 捕まる）。**そして「全 N 文字」の N が何の文字数かを名指しする**——
   * 節の本文の総量ではなく、目次として毎ターンの焼き込みに載る量である。
   *
   * 反転側・非反転側の両方で測る（`renderPremiseOutlineOmission` の
   * 冒頭1行は両分岐で共有されているので、非対称に足すとどちらかで
   * 抜け落ちる）。
   */
  it('⭐⭐ 断り書きは目次の総量を「載った分＋省いた分」の内訳とともに出し、何の文字数かを名指しする', () => {
    // 「全体」を指す節（`節の目次は全 T 節ぶんで X 文字（節の本文の総量ではない）`）は
    // 「載る」/「載った」を1文字も使わない——「載った分」は shownChars 側にしか
    // 付かない、という語の衝突回避そのものを固定する。
    const totalNamingPhrase = '節の目次は全 ';
    const notBodyPhrase = '（節の本文の総量ではない）';
    const breakdown =
      /節の目次は全 ([\d,]+) 節ぶんで ([\d,]+) 文字（節の本文の総量ではない）——うち焼き込みに載った分 ([\d,]+) 文字、予算に入らず省いた分 ([\d,]+) 文字。/;
    const toNumber = (s: string) => Number(s.replace(/,/g, ''));

    // 非反転側（「見出しを縮めれば載る」）。
    const shrinkable = Array.from(
      { length: 120 },
      (_, i) => `## これは十分に長い見出しであり予算を食い尽くす ${i}\n本文`,
    ).join('\n');
    const nonInverted = renderMemoryDocuments([
      {
        slug: 'shrinkable-total',
        content: `---\ntype: premise\ndescription: 大きい\n---\n${shrinkable}`,
      },
    ]);
    expect(nonInverted).toMatch(/見出しを平均 \d+ 文字（いま \d+ 文字）まで縮める必要がある。/);
    expect(nonInverted).toContain(totalNamingPhrase);
    expect(nonInverted).toContain(notBodyPhrase);
    const nonInvertedMatch = breakdown.exec(nonInverted);
    expect(nonInvertedMatch).not.toBeNull();
    const [, , nOutline = '', nShown = '', nDropped = ''] = nonInvertedMatch as RegExpExecArray;
    expect(toNumber(nShown) + toNumber(nDropped)).toBe(toNumber(nOutline));
    expect(toNumber(nShown)).toBeGreaterThan(0);
    expect(toNumber(nDropped)).toBeGreaterThan(0);

    // 反転側（「縮めても載らない」）。
    const unshrinkable = Array.from({ length: 400 }, (_, i) => `# ${i}\n本文`).join('\n');
    const inverted = renderMemoryDocuments([
      {
        slug: 'unshrinkable-total',
        content: `---\ntype: premise\ndescription: 追記だけの文書\n---\n${unshrinkable}`,
      },
    ]);
    expect(inverted).toContain('見出しを最短');
    expect(inverted).not.toMatch(/まで縮める必要がある。/);
    expect(inverted).toContain(totalNamingPhrase);
    expect(inverted).toContain(notBodyPhrase);
    const invertedMatch = breakdown.exec(inverted);
    expect(invertedMatch).not.toBeNull();
    const [, , iOutline = '', iShown = '', iDropped = ''] = invertedMatch as RegExpExecArray;
    expect(toNumber(iShown) + toNumber(iDropped)).toBe(toNumber(iOutline));
    expect(toNumber(iShown)).toBeGreaterThan(0);
    expect(toNumber(iDropped)).toBeGreaterThan(0);
  });

  /**
   * ⭐ **変更4: 断り書きは、数（rest/shown）が何を意味するかを1文で言う（#772）。**
   * これは「1文が本当に出ていること」を直接固定する歯である——`shown` を
   * 描き直さず、断り書きの中の数（`測る` 側と同じ数え方）と突き合わせる。
   *
   * 反転側・非反転側の両方で確かめる（`arithmetic` と同じく両分岐で共有
   * されている文なので、片方だけでは片方の壊れ方を見逃す）。
   */
  it('⭐ 断り書きは「落ちている節を移し切るまで床は動かない」ことを1文で言う（rest/shown の数と一致する）', () => {
    const sentence =
      /落ちている ([\d,]+) 節をすべて移し切るまで、毎ターンの床はほとんど動かない.+?。([\d,]+) 節まで割り切った時点で省略が消え、この断り書きごと床から落ちる——そこが節の移動が床に効き始める点である。/;
    const toNumber = (s: string) => Number(s.replace(/,/g, ''));

    // 非反転側。
    const shrinkable = Array.from(
      { length: 120 },
      (_, i) => `## これは十分に長い見出しであり予算を食い尽くす ${i}\n本文`,
    ).join('\n');
    const nonInverted = renderMemoryDocuments([
      {
        slug: 'sentence-shrinkable',
        content: `---\ntype: premise\ndescription: d\n---\n${shrinkable}`,
      },
    ]);
    const nonInvertedHit = sentence.exec(nonInverted);
    expect(nonInvertedHit).not.toBeNull();
    const omissionHit =
      /末尾 ([\d,]+) 節は目次から省略（全 ([\d,]+) 節のうち先頭 ([\d,]+) 節だけ載せた）/.exec(
        nonInverted,
      );
    expect(omissionHit).not.toBeNull();
    const [, nRest = '', , nShown = ''] = omissionHit as RegExpExecArray;
    const [, sentenceRest = '', sentenceShown = ''] = nonInvertedHit as RegExpExecArray;
    expect(toNumber(sentenceRest)).toBe(toNumber(nRest));
    expect(toNumber(sentenceShown)).toBe(toNumber(nShown));

    // 反転側（見出しを縮めても載らない側でも、同じ1文が出る）。
    const unshrinkable = Array.from({ length: 400 }, (_, i) => `# ${i}\n本文`).join('\n');
    const inverted = renderMemoryDocuments([
      {
        slug: 'sentence-unshrinkable',
        content: `---\ntype: premise\ndescription: d\n---\n${unshrinkable}`,
      },
    ]);
    expect(sentence.test(inverted)).toBe(true);

    // 切れていない文書には、この1文は1文字も出ない（床 +0 の対照）。
    const notSaturated = renderMemoryDocuments([premise('not-saturated', '本文')]);
    expect(notSaturated).not.toContain('落ちている');
    expect(notSaturated).not.toContain('移し切るまで');
  });

  /**
   * ⛔ **予算値を2回出さない。** `arithmetic`（同じ関数の両分岐）が既に
   * `予算 ${MEMORY_PROMPT_OUTLINE_BUDGET} 文字` を名乗っている。総量の1句を
   * 足したことで予算値がもう一度出てはならない——出現回数がちょうど1回で
   * あることを、反転側・非反転側の両方で測る。
   */
  it('⛔ 目次の総量を足しても、予算値の出現は反転側・非反転側とも1回のままである', () => {
    const budgetPhrase = `予算 ${MEMORY_PROMPT_OUTLINE_BUDGET.toLocaleString('en-US')} 文字`;
    const countOccurrences = (text: string, needle: string) => text.split(needle).length - 1;

    const shrinkable = Array.from(
      { length: 120 },
      (_, i) => `## これは十分に長い見出しであり予算を食い尽くす ${i}\n本文`,
    ).join('\n');
    const nonInverted = renderMemoryDocuments([
      {
        slug: 'shrinkable-budget-once',
        content: `---\ntype: premise\ndescription: 大きい\n---\n${shrinkable}`,
      },
    ]);
    expect(nonInverted).toMatch(/見出しを平均 \d+ 文字（いま \d+ 文字）まで縮める必要がある。/);
    expect(countOccurrences(nonInverted, budgetPhrase)).toBe(1);

    const unshrinkable = Array.from({ length: 400 }, (_, i) => `# ${i}\n本文`).join('\n');
    const inverted = renderMemoryDocuments([
      {
        slug: 'unshrinkable-budget-once',
        content: `---\ntype: premise\ndescription: 追記だけの文書\n---\n${unshrinkable}`,
      },
    ]);
    expect(inverted).toContain('見出しを最短');
    expect(inverted).not.toMatch(/まで縮める必要がある。/);
    expect(countOccurrences(inverted, budgetPhrase)).toBe(1);
  });

  /**
   * ⭐⭐ **断り書きの締めが「何を移すか」の基準を持つ。**
   *
   * 同じ断り書きの中で「足したばかりの節はここに出る」（直近の名指し）の
   * すぐ後に `side=tail`（末尾を見る）→ `memory_section_move`（付録へ移す）が
   * 隣接している。素直に読むと「末尾を見て、それを移す」に読めてしまい、
   * いちばん新しい学びを `fact` へ追い出しかねない——しかも追い出した節は
   * 目次から消えるので、読み手は何を失ったか気づけない。この誤読を、
   * 断り書きの締めで名指しして塞ぐ。
   */
  it('⭐⭐ 断り書きの締めは、移す対象の基準と side=tail の誤読の両方を名乗る', () => {
    const huge = Array.from(
      { length: 200 },
      (_, i) => `## これは十分に長い見出しであり予算を食い尽くす ${i}\n本文`,
    ).join('\n');
    const rendered = renderMemoryDocuments([
      { slug: 'big', content: `---\ntype: premise\ndescription: 大きい\n---\n${huge}` },
    ]);

    // 1. 移す対象の基準——済んだ経緯・1回きりの実測・失効した手順であって、
    //    末尾の新しい節ではない。
    expect(rendered).toContain(
      '移すのは済んだ経緯・1回きりの実測・失効した手順であって、末尾の新しい節ではない。',
    );
    // 2. side=tail の誤読を名指しで塞ぐ——読むためであって移すためではない。
    expect(rendered).toContain('side=tail は末尾を**読む**ための向きであって');
    expect(rendered).toContain('末尾を**移す**ための指示ではない');
  });

  it('⭐ 要旨が長すぎる文書は、切ったことと全文の在り処と直し方を名乗る', () => {
    const longDescription = 'あ'.repeat(MEMORY_PROMPT_DESCRIPTION_BUDGET + 500);
    const rendered = renderMemoryDocuments([
      {
        slug: 'doc',
        content: `---\ntype: premise\ndescription: ${longDescription}\n---\n## 節\n本文`,
      },
    ]);

    expect(rendered).toContain('要旨が長すぎて毎ターンの焼き込みに収まっていない');
    expect(rendered).toContain('memory_list');
    expect(rendered).toContain('要旨に本文を書かず');
    // 切ってはいるが、切ったぶんだけであって文書は消えていない。
    expect(rendered).toContain('## 節');
  });

  it('要旨が目安に収まっていれば、切らないし印も出さない（線の反対側）', () => {
    const rendered = renderMemoryDocuments([
      { slug: 'doc', content: '---\ntype: premise\ndescription: 短い要旨\n---\n## 節\n本文' },
    ]);
    expect(rendered).toContain('要旨: 短い要旨');
    expect(rendered).not.toContain('要旨が長すぎて');
  });

  // -------------------------------------------------------------------------
  // 載せ直しの絞り込み（seenContent）
  // -------------------------------------------------------------------------

  it('⭐ 節を1つ足しただけなら、カードの変わった範囲だけが載る', () => {
    const before: MemoryPart = { slug: 'alteroid-work', content: manySections(60) };
    const after: MemoryPart = {
      slug: 'alteroid-work',
      content: manySections(60, '\n## 新しい節\n追記した本文'),
    };

    const rendered = renderMemoryDocuments([after], {
      seenContent: new Map([[after.slug, before.content]]),
    });

    // 変わった行（新しい見出し）は載る。
    expect(rendered).toContain('## 新しい節');
    // 変わっていない節の行は載らない。
    expect(rendered).not.toContain('## 節30');
    // 省いた側を必ず名乗る。
    expect(rendered).toContain('は変わっていない');
    expect(rendered).toContain('<!-- memory: alteroid-work.md（カードの変わった範囲だけ） -->');
    // カード全体よりはっきり小さい（この絞り込みの目的そのもの）。
    expect(rendered.length).toBeLessThan(renderMemoryDocuments([after]).length / 5);
  });

  /**
   * ⚠️ **この歯は反転させた**（本番の実測、2026-09-11。`renderPremiseDelta` の
   * doc「『いまは無い行』は一枚岩ではない」を見ること）。
   *
   * 旧い実装は「消えた行（節かどうかを問わない）」を1つの数として名乗って
   * いた——ここでは要旨の行（節ではない）が1行消えるので、旧い実装は
   * 「いまは無い行: 1 行」と言っていた。**しかしこれは何も失われていない**
   * ——要旨の行は書き換わっただけで、その新しい版は `added` 側に既に載って
   * いる（`toContain('要旨: 直した要旨')` の行そのもの）。旧い文言は
   * 「節が消えたか、書き換わって別の行になったか」としか言わず、要旨の
   * ような**節ではない行**まで同じ扱いにしていた。
   *
   * 直した実装は、消えた行のうち**節の行（`[節id] 見出し — N 文字` の形）
   * だけ**を「押し出された／消えた・書き換わった／判定できない」に分ける。
   * 要旨の行はこの形に一致しないので `other` に落ち、**「消えた」とは
   * 名乗らない**——ここでは節を1つも変えていないので、新しい歯は
   * 「いまは無い行」系の文言が1文字も出ないことを確かめる（旧い歯が
   * 期待していた `'いまは無い行: 1 行'` とは逆の期待値である）。
   */
  it('⭐ 要旨だけを直したときは、変わった範囲だけが載り、「消えた節」は1文字も名乗らない（要旨の行は節ではない）', () => {
    const before: MemoryPart = { slug: 'doc', content: manySections(60) };
    const after: MemoryPart = {
      slug: 'doc',
      content: manySections(60).replace('description: 前提の要旨', 'description: 直した要旨'),
    };

    const rendered = renderMemoryDocuments([after], {
      seenContent: new Map([[after.slug, before.content]]),
    });

    expect(rendered).toContain('要旨: 直した要旨');
    // 節の行は1つも変わっていないので載らない。
    expect(rendered).not.toContain('## 節30');
    // 変わっていない行数を名乗る（黙って省かない）。
    expect(rendered).toContain('行は変わっていないので載せていない');
    expect(rendered).toContain('<!-- memory: doc.md（カードの変わった範囲だけ） -->');
    // 要旨の行（節ではない）が書き換わっただけなので、「消えた節」系の文言は
    // 1文字も出ない——起きていないことを起きたかのように書かない。
    expect(rendered).not.toContain('いまは無い');
    expect(rendered).not.toContain('押し出された節');
    expect(rendered).not.toContain('判定できない節');
  });

  /**
   * ⭐⭐ 変更3: 押し出された節（甲）・消えたか書き換わった節（乙）・
   * 判定できない節（丙）を分けて名乗る（本番の実測、2026-09-11。
   * `renderPremiseDelta` の doc「⚠️『いまは無い行』は一枚岩ではない」を
   * 見ること）。
   */
  describe('消えた節を「押し出された／消えた・書き換わった／判定できない」に分ける', () => {
    it('⭐⭐ 押し出された節（甲）は、いまの節id 付きで名指しされ、節自体は文書に在ることが確かめられる', () => {
      // 主リスト（MEMORY_PROMPT_OUTLINE_BUDGET）・末尾の名指し窓
      // （MEMORY_PROMPT_OMITTED_TAIL_BUDGET）のどちらの予算も確実に超える数。
      const BASE_COUNT = 220;
      const baseBody = Array.from(
        { length: BASE_COUNT },
        (_, i) => `## 節${i}\n節${i}の本文である。`,
      ).join('\n');
      // ⚠️ `before.content` は末尾に改行を1つ明示的に持たせる。**理由**:
      // `scanMemorySections` は「文書の絶対末尾で閉じる最後の節」だけ、次の
      // 見出しの前で閉じる節と違って末尾の改行を body に含めない（この非対称は
      // 既存の仕様——`memorySectionId` 周りの歯「末尾の空行まで一致させる」を
      // 見ること）。そのため、末尾に改行が無い `before` の最後の節（節219）へ
      // 単純に `\n${appendedBody}` を継ぎ足すと、その節が「文書の絶対末尾」で
      // なくなることで**改行の含み方が変わり、見出し・本文を1文字も変えて
      // いないのに id そのものが変わってしまう**（本文が変わって古くなった、
      // という意味での「押し出された」ではなく、この合成データ特有の継ぎ目の
      // アーティファクトである）。`before.content` 側に先に改行を持たせ、
      // `after.content` は単純連結（余分な区切りを足さない）にすることで、
      // 節219の body スライスが前後で1バイトも変わらないようにしてある。
      const before: MemoryPart = {
        slug: 'doc',
        content: `---\ntype: premise\ndescription: 前提の要旨\n---\n${baseBody}\n`,
      };
      // after: 既存の節は1文字も変えず、末尾へさらに節を積む
      // ——`memory_append` と同じ形（末尾への追記）。
      const appendedBody = Array.from(
        { length: 80 },
        (_, i) => `## 追記節${i}\n追記節${i}の本文である。`,
      ).join('\n');
      const after: MemoryPart = { slug: 'doc', content: `${before.content}${appendedBody}` };

      const idPattern = /\[([0-9a-f]{8}-[0-9a-f]{8})\]/g;
      const idsIn = (text: string): Set<string> =>
        new Set([...text.matchAll(idPattern)].map((match) => match[1] as string));

      // 「前は見えていたが、いまは見えない」節id の集合を、実装を経由せず
      // 自分で計算する（delta を使わない、素の全文カードどうしの比較）。
      const idsVisibleBefore = idsIn(renderMemoryDocuments([before]));
      const idsVisibleAfterAlone = idsIn(renderMemoryDocuments([after]));
      const vanished = [...idsVisibleBefore].filter((id) => !idsVisibleAfterAlone.has(id));

      // 前提: この合成コーパスで実際に「前は見えていたが、いまは見えない」
      // 節が生まれていること（そうでなければこの歯は何も測っていない）。
      expect(vanished.length).toBeGreaterThan(0);

      // 押し出されただけで、節自体はいまの文書にまだ在る。
      const currentSections = scanMemorySections(after.content).sections;
      for (const id of vanished) {
        expect(currentSections.some((section) => section.id === id)).toBe(true);
      }

      const rendered = renderMemoryDocuments([after], {
        seenContent: new Map([[after.slug, before.content]]),
      });

      expect(rendered).toContain(`押し出された節: ${vanished.length} 節`);
      expect(rendered).toContain('節そのものは文書に在る');
      // 消えたか書き換わった・判定できない、は0件のはず（今回は追記だけで
      // 既存の節を1文字も変えていないので、見出しの衝突も消滅も起きない）。
      expect(rendered).not.toContain('いまは無い節');
      expect(rendered).not.toContain('判定できない節');
      // 実際に、計算した節id のうち少なくとも1つが名指しの中に現れる
      // （予算で全件は載らないことがあるので「少なくとも1つ」で見る）。
      const idsInRendered = idsIn(rendered);
      expect(vanished.some((id) => idsInRendered.has(id))).toBe(true);
    });

    it('見出しが本文と一緒に変わっただけの通常の更新は「押し出された」と名乗らない（同じ節がまだ見えている）', () => {
      // 小さい文書——予算に確実に収まるので、本文を変えても見た目の
      // 「見える/見えない」は変わらない。ただの更新である。
      const before: MemoryPart = {
        slug: 'doc',
        content: '---\ntype: premise\ndescription: 要旨\n---\n## 節A\n元の本文\n\n## 節B\n本文B\n',
      };
      const after: MemoryPart = {
        slug: 'doc',
        content:
          '---\ntype: premise\ndescription: 要旨\n---\n## 節A\n書き換えた本文\n\n## 節B\n本文B\n',
      };

      const rendered = renderMemoryDocuments([after], {
        seenContent: new Map([[after.slug, before.content]]),
      });

      // 節Aの新しい行はカードに現に載っている（＝押し出されてなどいない）。
      const afterSection = scanMemorySections(after.content).sections.find(
        (section) => section.heading === '## 節A',
      )!;
      expect(rendered).toContain(afterSection.id);
      expect(rendered).not.toContain('押し出された節');
      expect(rendered).not.toContain('いまは無い節');
      expect(rendered).not.toContain('判定できない節');
    });

    it('見出しごと消された・書き換わった節は「消えたか書き換わった」（乙）と名乗る', () => {
      const before: MemoryPart = { slug: 'doc', content: manySections(60) };
      const after: MemoryPart = {
        slug: 'doc',
        content: manySections(60)
          .split('\n')
          .filter((line) => line !== '## 節30' && line !== '節30の本文である。')
          .join('\n'),
      };

      // 前提: 節30 の見出しはいまの文書のどこにも無い。
      expect(scanMemorySections(after.content).sections.some((s) => s.heading === '## 節30')).toBe(
        false,
      );

      const rendered = renderMemoryDocuments([after], {
        seenContent: new Map([[after.slug, before.content]]),
      });

      expect(rendered).toContain('いまは無い節: 1 節');
      expect(rendered).toContain('どの節の見出しとも一致しない');
      expect(rendered).not.toContain('押し出された節');
      expect(rendered).not.toContain('判定できない節');
    });

    it('見出しが重複していて、どの節に対応するか決められないときは「判定できない」（丙）と名乗る（3つ目の状態を潰さない）', () => {
      // ⚠️ 変更した節（1つ）に対して、**変わっていない節を大量に添える**
      // （`manySections` の60節）。理由: `renderPremiseDelta` は `added` が
      // カード全体に占める割合が `MEMORY_DELTA_MAX_RATIO`（0.5）を超えたら
      // 差分そのものを諦め、カード全体を返す（差分にする価値が無いという
      // 判断）。この fixture をごく小さいまま（節2つ）にすると、書き換えで
      // 増えた行がカードの過半を占めてしまい、**差分機構そのものが働かず**
      // 「判定できない節」の文言を検査する前提が崩れる（実測で踏んだ）。
      // 変わらない節を十分に積むことで、比率をこの歯が測りたい経路
      // （差分が実際に描かれる経路）に載せている。
      const before: MemoryPart = {
        slug: 'doc',
        content: manySections(60, '\n\n## 重複見出し\n本文A\n'),
      };
      const after: MemoryPart = {
        slug: 'doc',
        // 節Aの本文を変え（＝旧い行を消す）、かつ同じ見出しをもう1つ足す
        // ——いまの文書に「重複見出し」が2つ在る状態を作る。
        content: manySections(60, '\n\n## 重複見出し\n本文A書き換え\n\n## 重複見出し\n本文C\n'),
      };

      const currentHeadingCount = scanMemorySections(after.content).sections.filter(
        (s) => s.heading === '## 重複見出し',
      ).length;
      expect(currentHeadingCount).toBe(2); // 前提の確認。

      const rendered = renderMemoryDocuments([after], {
        seenContent: new Map([[after.slug, before.content]]),
      });

      expect(rendered).toContain('判定できない節: 1 節');
      expect(rendered).toContain('同じ見出しがいまの文書に複数在るため');
      expect(rendered).not.toContain('押し出された節');
      expect(rendered).not.toContain('いまは無い節');
    });
  });

  it('⭐ 大半が変わったときは差分にせずカード全体を載せる（「変わった範囲だけ」と名乗らない）', () => {
    const before: MemoryPart = { slug: 'doc', content: manySections(20) };
    const after: MemoryPart = {
      slug: 'doc',
      content: `---\ntype: premise\ndescription: 前提の要旨\n---\n${Array.from(
        { length: 20 },
        (_, i) => `## まったく違う見出し${i}\n中身も違う。`,
      ).join('\n')}`,
    };

    const rendered = renderMemoryDocuments([after], {
      seenContent: new Map([[after.slug, before.content]]),
    });

    expect(rendered).toBe(renderMemoryDocuments([after]));
    expect(rendered).not.toContain('カードの変わった範囲だけ');
  });

  it('⭐ seenContent を渡さなければ出力は1バイトも変わらない（システムプロンプト側の不変条件）', () => {
    const docs = [
      { slug: 'a', content: manySections(5) },
      { slug: 'b', content: manySections(3) },
    ];
    expect(renderMemoryDocuments(docs, {})).toBe(renderMemoryDocuments(docs));
    expect(renderMemoryDocuments(docs, { presentInMemory: docs })).toBe(
      renderMemoryDocuments(docs),
    );
  });

  it('⭐ 床（measureMemoryFloor）は seenContent の影響を受けない', () => {
    const before: MemoryPart = { slug: 'doc', content: manySections(60) };
    const after: MemoryPart = { slug: 'doc', content: manySections(60, '\n## 追記\n本文') };

    const injected = renderMemoryDocuments([after], {
      seenContent: new Map([[after.slug, before.content]]),
    }).length;
    const floor = measureMemoryFloor([after]).totalChars;

    expect(injected).toBeLessThan(floor / 5);
    // 床は「渡さない呼び手」の値そのものである（差分の存在で1文字も動かない）。
    expect(floor).toBe(renderMemoryDocuments([after]).length);
  });

  it('見ていない文書（新規作成）はカード全体が載る——空の Map と同じ扱い', () => {
    const doc: MemoryPart = { slug: 'new-doc', content: manySections(5) };
    expect(renderMemoryDocuments([doc], { seenContent: new Map() })).toBe(
      renderMemoryDocuments([doc]),
    );
  });

  it('fact は seenContent を渡しても目次1行のまま（もともと本文が載らないので差分の余地が無い）', () => {
    const before = fact('appendix', { description: '古い要旨', freshness: { kind: 'fresh' } });
    const after = fact('appendix', { description: '新しい要旨', freshness: { kind: 'fresh' } });
    expect(
      renderMemoryDocuments([after], { seenContent: new Map([[after.slug, before.content]]) }),
    ).toBe(renderMemoryDocuments([after]));
  });

  /**
   * ⭐ 行で切る理由そのもの。記憶の本文には絵文字（⚠️ / 🎯）が実際に含まれて
   * おり、UTF-16 の code unit で切るとサロゲートペアが割れて壊れた文字が文脈へ
   * 載る。**行の境界は必ず文字の境界である。**
   */
  it('⭐ 絵文字（サロゲートペア）を含む見出しの境界で切っても、壊れた文字を作らない', () => {
    const body = (extra: string): string =>
      `---\ntype: premise\ndescription: 🎯 要旨 ⚠️\n---\n${Array.from(
        { length: 40 },
        (_, i) => `## 🎯 節${i} ⚠️\n本文`,
      ).join('\n')}${extra}`;
    const rendered = renderMemoryDocuments(
      [{ slug: 'doc', content: body('\n## 🎯 追記 ⚠️\n本文') }],
      {
        seenContent: new Map([['doc', body('')]]),
      },
    );

    expect(rendered).toContain('## 🎯 追記 ⚠️');
    // 孤立サロゲート（U+D800–U+DFFF が対にならずに残った形）が1つも無いこと。
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(rendered),
    ).toBe(false);
  });

  /**
   * ⭐ 見込み（書く側）と実物（載る側）が同じ計算に揃っていること。
   * `describeMemoryReinjectionEstimate` は `renderMemoryDocuments` を
   * 再実装せず、同じ `seenContent` をそのまま通す。
   */
  it('⭐ 見込みの文字数が、差分として実際に載る文字数と一致する', () => {
    const before: MemoryPart = { slug: 'doc', content: manySections(60) };
    const after: MemoryPart = { slug: 'doc', content: manySections(60, '\n## 追記\n本文') };
    const seen = new Map([[after.slug, before.content]]);

    const actual = renderMemoryDocuments([after], { presentInMemory: [after], seenContent: seen });
    const reply = describeMemoryReinjectionEstimate([after], [after], seen);

    expect(reply).toContain(`${actual.length.toLocaleString('en-US')} 文字`);
    expect(reply).toContain('doc（premise・カードの変わった範囲だけ）');
    expect(actual.length).toBeLessThan(renderMemoryDocuments([after]).length / 5);
  });
});

/**
 * ⭐ `describeMemoryTidyTargets` — 毎ターンの焼き込みに収まっていない文書を名指しする。
 *
 * ## この関数が在る理由（実測 2026-09-08）
 *
 * `renderPremiseCard` は予算に当たったとき ⚠ を出すが、**それはその文書の
 * カードの中にしか無い。** tick の digest にも、書き込みの応答にも、
 * `self_status` にも、`memory_list` にも、**予算に当たった文書を名指しする
 * 情報は1つも無かった**（全走査して確かめた）。集計も無かった。
 *
 * ⟹ 定期の棚卸し（`schedule.ts` の `memoryTidyEntry`）へ「どれを割るか」を
 * 渡す口が必要になった。
 */
describe('describeMemoryTidyTargets — 焼き込みに収まっていない文書を名指しする', () => {
  /** 節の目次が予算を超える premise を作る（見出しを長くして数で押す）。 */
  function fatOutline(slug: string): MemoryPart {
    const body = Array.from(
      { length: 300 },
      (_, i) => `## これは十分に長い見出しであり予算を食い尽くす ${i}\n本文`,
    ).join('\n');
    return { slug, content: `---\ntype: premise\ndescription: 要旨\n---\n${body}` };
  }

  it('⭐ 目次が予算を超えた文書を、名前と数で名指しする', () => {
    const reply = describeMemoryTidyTargets([fatOutline('alteroid-work')]);

    expect(reply).toContain('棚卸しの的');
    expect(reply).toContain('- alteroid-work:');
    expect(reply).toContain('節の目次が');
    // 予算そのものを書き写さず、定数から出す（腐らない）。
    expect(reply).toContain(`予算 ${MEMORY_PROMPT_OUTLINE_BUDGET.toLocaleString('en-US')} 文字`);
    // 何をすればよいかを言う（名指しだけで終わらせない）。
    expect(reply).toContain('memory_section_move');
  });

  it('⭐ 要旨が予算を超えた文書も名指しする（別の理由として並ぶ）', () => {
    const long = 'あ'.repeat(MEMORY_PROMPT_DESCRIPTION_BUDGET + 100);
    const reply = describeMemoryTidyTargets([
      { slug: 'about-me', content: `---\ntype: premise\ndescription: ${long}\n---\n## 節\n本文` },
    ]);

    expect(reply).toContain('- about-me:');
    expect(reply).toContain('要旨が');
    expect(reply).not.toContain('節の目次が');
  });

  it('2つとも超えていれば、1行に2つの理由が並ぶ', () => {
    const long = 'あ'.repeat(MEMORY_PROMPT_DESCRIPTION_BUDGET + 100);
    const fat = fatOutline('both');
    const both: MemoryPart = {
      slug: 'both',
      content: fat.content.replace('description: 要旨', `description: ${long}`),
    };

    const reply = describeMemoryTidyTargets([both]);
    const line = reply.split('\n').find((row) => row.startsWith('- both:')) ?? '';
    expect(line).toContain('節の目次が');
    expect(line).toContain('要旨が');
  });

  /**
   * ⭐ **「的が無い」を「記憶が小さい」と読ませない。** 予算は1文書ごとに
   * 掛かるので、全部が予算の下でも合計は大きくなりうる。
   */
  it('⭐ 的が1つも無いときは、それが「小さい」ではないと断る', () => {
    const reply = describeMemoryTidyTargets([premise('small', '## 節\n本文')]);

    expect(reply).toContain('収まっていない文書は無い');
    expect(reply).toContain('「記憶が小さい」ではない');
  });

  it('fact は的にしない（もともと目次の1行しか焼かれない）', () => {
    const fat = fatOutline('appendix');
    const asFact: MemoryPart = {
      slug: 'appendix',
      content: fat.content.replace('type: premise', 'type: fact'),
    };
    expect(describeMemoryTidyTargets([asFact])).toContain('収まっていない文書は無い');
  });

  it('一覧は文字数の予算で切り、切ったら件数を言う', () => {
    const many = Array.from({ length: 60 }, (_, i) => fatOutline(`doc-${i}`));
    const reply = describeMemoryTidyTargets(many);

    expect(reply).toContain('件は省略');
    expect(reply.length).toBeLessThan(MEMORY_TIDY_TARGETS_BUDGET * 2);
  });
});
