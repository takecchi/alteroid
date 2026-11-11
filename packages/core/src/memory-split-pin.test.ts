// 仕様を先に書いたものではなく、今の出力から変えないための歯。
// `memory.ts` を J（journal-derive）・F（frontmatter）・S（sections）へ分ける PR の前に、
// 既存の試験が名指ししていない所を、今の出力のまま固定する。期待を直すときは「分けたせいで変わった」のか
// 「意図して変えた」のかを先に切り分けること。
import { describe, expect, it } from 'vitest';

import * as memoryEntry from './memory.js';
import {
  describeMemorySessionDelta,
  formatMemoryCreatedAt,
  memoryProtectionRebuildDecision,
  toMemoryCreatedAt,
} from './memory.js';
import { scanMemoryBudgetConstants } from './memory-budget-scan.test-support.js';

describe('memory.ts の入口の公開面', () => {
  // 実行時に出る名前だけを縛る。型だけの export（interface / type）は実行時に現れないので、tsc に任せる。
  it('実行時の export 名の集合が変わらない', () => {
    expect(Object.keys(memoryEntry).sort()).toMatchInlineSnapshot(`
      [
        "MEMORY_JOURNAL_SCAN_PAGE_SIZE",
        "MEMORY_LISTING_BUDGET",
        "MEMORY_OUTLINE_BUDGET",
        "MEMORY_OUTLINE_SIDES",
        "MEMORY_PREMISE_CARD_BUDGET",
        "MEMORY_PREMISE_RANKING_BUDGET",
        "MEMORY_PROMPT_DESCRIPTION_BUDGET",
        "MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET",
        "MEMORY_PROMPT_OMITTED_TAIL_BUDGET",
        "MEMORY_PROMPT_OUTLINE_BUDGET",
        "MEMORY_PROMPT_OUTLINE_HEADING_WIDTH",
        "MEMORY_REINJECTION_ESTIMATE_NOTE",
        "MEMORY_SECTION_MOVE_HIERARCHY_JUMP_LIST_BUDGET",
        "MEMORY_SECTION_MOVE_LIST_BUDGET",
        "MEMORY_TIDY_TARGETS_BUDGET",
        "MEMORY_TOC_CHAR_BUDGET",
        "MEMORY_TOC_ENTRY_LIMIT",
        "MEMORY_TOC_LINE_LIMIT",
        "applyMemoryFrontmatterPatch",
        "assertNeverMemoryCreatedAt",
        "assertNeverMemoryDescriptionDrift",
        "assertNeverMemoryDescriptionFreshness",
        "assertNeverMemoryDocKind",
        "assertNeverMemoryProtectionStatus",
        "cutMemorySections",
        "deriveHumanTouchedAtFromJournal",
        "deriveMemoryBootBackfillFromJournal",
        "deriveMemoryFrontmatter",
        "describeMemoryFloor",
        "describeMemoryPremiseRanking",
        "describeMemoryReinjectionEstimate",
        "describeMemorySectionMoveHierarchyJumpWarning",
        "describeMemorySessionDelta",
        "describeMemoryTidyTargets",
        "describeMemoryWriteDiff",
        "findMemoryFrontmatterLineBreak",
        "findMemorySectionHierarchyJumps",
        "findOverlappingMemorySections",
        "formatMemoryCreatedAt",
        "isKnownMemoryDocKind",
        "lookupMemorySection",
        "measureMemoryFloor",
        "measurePremiseOutlineFit",
        "memoryBodyStart",
        "memoryProtectionRebuildDecision",
        "memorySectionId",
        "nextDescribedState",
        "parseMemoryFrontmatter",
        "renderMemoryDocuments",
        "renderMemoryListing",
        "renderMemoryOutline",
        "resolveMemoryDescriptionFreshness",
        "resolveMemoryDocKind",
        "scanMemorySections",
        "toMemoryCreatedAt",
      ]
    `);
  });

  // 分割で予算が複数ファイルに散っても、読み漏らして兄弟検査が静かに弱まらないよう、読んだ集合そのものを縛る。
  it('MEMORY_*_BUDGET の全走査が読む定数名の集合が変わらない', () => {
    expect([...scanMemoryBudgetConstants().keys()].sort()).toMatchInlineSnapshot(`
      [
        "MEMORY_LISTING_BUDGET",
        "MEMORY_OUTLINE_BUDGET",
        "MEMORY_PREMISE_CARD_BUDGET",
        "MEMORY_PREMISE_RANKING_BUDGET",
        "MEMORY_PROMPT_DESCRIPTION_BUDGET",
        "MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET",
        "MEMORY_PROMPT_OMITTED_TAIL_BUDGET",
        "MEMORY_PROMPT_OUTLINE_BUDGET",
        "MEMORY_SECTION_MOVE_HIERARCHY_JUMP_LIST_BUDGET",
        "MEMORY_SECTION_MOVE_LIST_BUDGET",
        "MEMORY_TIDY_TARGETS_BUDGET",
        "MEMORY_TOC_CHAR_BUDGET",
      ]
    `);
  });

  it('全走査が読んだ予算の値は、実行時の export と一致する', () => {
    const runtime = memoryEntry as unknown as Record<string, unknown>;
    for (const [name, value] of scanMemoryBudgetConstants()) {
      expect(runtime[name], name).toBe(value);
    }
  });
});

describe('memoryProtectionRebuildDecision', () => {
  // 分岐は無く、件数を文に差し込むだけ。差し込み位置と固定文を縛る。
  it('件数を差し込んだ字面（decision と grounds）', () => {
    expect(memoryProtectionRebuildDecision({ humanRestored: 3, hashesBaselined: 5 }))
      .toMatchInlineSnapshot(`
      {
        "decision": "記憶の保護状態の索引（派生値）を日誌から組み直した（human 印 3 件を復元、本文のハッシュ 5 件を現在の値で基準化）。",
        "grounds": "索引が読めなかった（無い・壊れている・スキーマが合わない）ため、次の読み出しでその場で組み直した。cause:human の記録は日誌が持つので保護（human 印）は失われていないが、この組み直しより前に外部から本文が書き換えられていたとしても、それはもう検出できない（ハッシュは日誌に無いので、組み直す瞬間の本文の値で新しく基準化するため）。",
      }
    `);
  });

  it('件数が 0 でも文は変わらず、件数だけが入れ替わる', () => {
    const zero = memoryProtectionRebuildDecision({ humanRestored: 0, hashesBaselined: 0 });
    const some = memoryProtectionRebuildDecision({ humanRestored: 3, hashesBaselined: 5 });
    expect(zero.decision).toContain('human 印 0 件を復元、本文のハッシュ 0 件を');
    expect(some.decision.replace('3 件', '0 件').replace('5 件', '0 件')).toBe(zero.decision);
    expect(zero.grounds).toBe(some.grounds);
  });
});

describe('formatMemoryCreatedAt', () => {
  it('作成時刻が無ければ「不明」と言う（空文字で隠さない）', () => {
    expect(formatMemoryCreatedAt({ kind: 'unknown' })).toBe('不明');
    expect(formatMemoryCreatedAt(toMemoryCreatedAt(undefined))).toBe('不明');
  });

  it('作成時刻があればそのまま出す', () => {
    expect(formatMemoryCreatedAt(toMemoryCreatedAt('2026-01-02T03:04:05.000Z'))).toBe(
      '2026-01-02T03:04:05.000Z',
    );
  });

  it('空文字の時刻は known のまま空文字を出す（今の挙動。不明へは倒さない）', () => {
    expect(toMemoryCreatedAt('')).toEqual({ kind: 'known', at: '' });
    expect(formatMemoryCreatedAt(toMemoryCreatedAt(''))).toBe('');
  });
});

describe('formatMemoryPercentDelta の 0% 枝（describeMemorySessionDelta 経由）', () => {
  // 小数1桁へ丸めて 0 になる増減は `+0%` / `-0%` ではなく `0%` と出る。
  it('増えるが 0.1% 未満', () => {
    expect(
      describeMemorySessionDelta({ afterChars: 100_001, injectedMemoryChars: 100_000 }),
    ).toMatchInlineSnapshot(
      `"次に組み立て直されたら焼かれる量（セッション構築時点との差）: セッション構築時点 100,000 文字 → いま 100,001 文字（+1 文字（0%）、増える見込み）。"`,
    );
  });

  it('減るが 0.1% 未満', () => {
    expect(
      describeMemorySessionDelta({ afterChars: 99_999, injectedMemoryChars: 100_000 }),
    ).toMatchInlineSnapshot(
      `"次に組み立て直されたら焼かれる量（セッション構築時点との差）: セッション構築時点 100,000 文字 → いま 99,999 文字（-1 文字（0%）、減る見込み）。"`,
    );
  });

  it('丸めても 0 にならない増減は符号つきで出る（0% 枝の隣）', () => {
    expect(
      describeMemorySessionDelta({ afterChars: 100_100, injectedMemoryChars: 100_000 }),
    ).toContain('（+0.1%）');
    expect(
      describeMemorySessionDelta({ afterChars: 99_900, injectedMemoryChars: 100_000 }),
    ).toContain('（-0.1%）');
  });
});
