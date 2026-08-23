import { describe, expect, it } from 'vitest';

import {
  MEMORY_LISTING_BUDGET,
  MEMORY_TOC_ENTRY_LIMIT,
  applyMemoryFrontmatterPatch,
  assertNeverMemoryCreatedAt,
  assertNeverMemoryDescriptionFreshness,
  assertNeverMemoryFrontmatterState,
  assertNeverMemoryProtectionStatus,
  containsMemoryFrontmatterLineBreak,
  deriveMemoryCreatedAtFromJournal,
  deriveMemoryFrontmatter,
  describeMemoryProtectionStatus,
  isKnownMemoryDocKind,
  memoryProtectionAllowsFullReplace,
  nextDescribedAt,
  parseMemoryFrontmatter,
  renderMemoryDocument,
  renderMemoryDocuments,
  renderMemoryListing,
  resolveMemoryDescriptionFreshness,
  resolveMemoryDocKind,
  type MemoryPart,
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

  it('文書のあいだは空行1つで、渡された順序のまま並ぶ', () => {
    expect(
      renderMemoryDocuments([
        { slug: 'b', content: 'に\n' },
        { slug: 'a', content: 'い\n' },
      ]),
    ).toBe('<!-- memory: b.md -->\nに\n\n<!-- memory: a.md -->\nい');
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

  it('type: premise は premise、type: fact は fact', () => {
    expect(resolveMemoryDocKind({ kind: 'parsed', type: 'premise' })).toBe('premise');
    expect(resolveMemoryDocKind({ kind: 'parsed', type: 'fact' })).toBe('fact');
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
  it('premise と fact は既知', () => {
    expect(isKnownMemoryDocKind('premise')).toBe(true);
    expect(isKnownMemoryDocKind('fact')).toBe(true);
  });

  it('綴り違い・大文字・空文字・未知の語は既知ではない', () => {
    expect(isKnownMemoryDocKind('Fact')).toBe(false);
    expect(isKnownMemoryDocKind('facts')).toBe(false);
    expect(isKnownMemoryDocKind('premis')).toBe(false);
    expect(isKnownMemoryDocKind('')).toBe(false);
    expect(isKnownMemoryDocKind('note')).toBe(false);
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

  it('describedAt が updatedAt より前なら stale', () => {
    expect(
      resolveMemoryDescriptionFreshness({
        description: '要旨',
        describedAt: '2026-08-20T00:00:00Z',
        updatedAt: '2026-08-21T00:00:00Z',
      }),
    ).toEqual({ kind: 'stale' });
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
  it('【受け入れ基準の最上位】frontmatter を1つも持たない文書の集合に対して、焼き込みが現行と完全に同じである', () => {
    const docs = [premise('b', 'に'), premise('a', 'い')];
    const rendered = renderMemoryDocuments(docs);
    const legacy = docs.map(renderMemoryDocument).join('\n\n');
    expect(rendered).toBe(legacy);
  });

  it('premise（区分無し）は全文が載る', () => {
    const rendered = renderMemoryDocuments([premise('values', '大事にしていること')]);
    expect(rendered).toContain('<!-- memory: values.md -->');
    expect(rendered).toContain('大事にしていること');
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

  it('二重に載せない: premise が全文で載っているとき、同じ文書の本文が目次側にも出ない', () => {
    const docs = [
      premise('p1', '前提の本文'),
      fact('f1', { title: 'F1', description: '要旨', freshness: { kind: 'fresh' } }),
    ];
    const rendered = renderMemoryDocuments(docs);

    // premise は1回だけ全文で載る。
    const occurrences = rendered.split('<!-- memory: p1.md -->').length - 1;
    expect(occurrences).toBe(1);
    // fact の本文（見出し以降の詳細）はどこにも出ない。
    expect(rendered).not.toContain('本文の詳細（目次からは開けない）');
    expect(rendered).toContain('- f1: F1');
  });

  it('取りこぼさない: documents() の件数 == 全文で載った件数 + 目次に出た件数', () => {
    const docs = [
      premise('premise-a'),
      premise('premise-b'),
      fact('fact-a', { description: '要旨a', freshness: { kind: 'fresh' } }),
      fact('fact-b', { description: '要旨b', freshness: { kind: 'stale' } }),
      fact('malformed-parent-ignored', {
        description: '要旨c',
        freshness: { kind: 'unknown' },
        parent: 'nope',
      }),
    ];
    const rendered = renderMemoryDocuments(docs);

    const fullTextCount = (rendered.match(/<!-- memory: [\w-]+\.md -->/g) ?? []).length;
    const tocCount = docs.filter((doc) => rendered.includes(`- ${doc.slug}:`)).length;
    expect(fullTextCount + tocCount).toBe(docs.length);
  });

  it('切ったら言う: 目次を件数で切ったら、切った件数が出力に現れる', () => {
    const docs = Array.from({ length: MEMORY_TOC_ENTRY_LIMIT + 5 }, (_, index) =>
      fact(`fact-${index}`, { description: `要旨${index}`, freshness: { kind: 'fresh' } }),
    );
    const rendered = renderMemoryDocuments(docs);
    expect(rendered).toContain('…ほか 5 件は目次から省略');
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
        freshness: { kind: 'stale' },
      }),
    ]);
    expect(rendered).toContain('stale-doc');
    expect(rendered).toContain('⚠古い要旨（本文の方が新しい）: 古い要旨');
  });

  it('4状態を畳まない: fresh / stale / unknown / absent がそれぞれ別の表示になる', () => {
    const fresh = renderMemoryDocuments([
      fact('x-fresh', { description: '説明', freshness: { kind: 'fresh' } }),
    ]);
    const stale = renderMemoryDocuments([
      fact('x-stale', { description: '説明', freshness: { kind: 'stale' } }),
    ]);
    const unknown = renderMemoryDocuments([
      fact('x-unknown', { description: '説明', freshness: { kind: 'unknown' } }),
    ]);
    // absent は description そのものを frontmatter に書かない（4状態のうち
    // description が無いときの唯一の状態であることを、内容そのもので表す）。
    const absent = renderMemoryDocuments([fact('x-absent', { freshness: { kind: 'absent' } })]);

    const distinct = new Set([fresh, stale, unknown, absent].map((s) => s.trim()));
    expect(distinct.size).toBe(4);
    expect(absent).toContain('（要旨なし）');
  });

  it('malformed の文書は消えず、premise として全文が残り、frontmatter が壊れている印が付く', () => {
    const rendered = renderMemoryDocuments([
      { slug: 'broken', content: '---\nauthor: 未知のキー\n---\n# Broken\n本文は残る' },
    ]);
    expect(rendered).toContain('本文は残る');
    expect(rendered).toContain('frontmatter が壊れている');
  });

  it('存在しない親を指す parent を黙って落とさない', () => {
    const rendered = renderMemoryDocuments([
      fact('orphan', { description: '説明', freshness: { kind: 'fresh' }, parent: 'not-exist' }),
    ]);
    expect(rendered).toContain('orphan');
    expect(rendered).toContain('親 not-exist が見つからない');
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
