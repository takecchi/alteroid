import { describe, expect, it } from 'vitest';

import {
  externalBatchPrompt,
  humanTurnText,
  managerReportBatchPrompt,
  mixedSignalBatchPrompt,
  type ExternalEvent,
  type HumanMessage,
  type ManagerReportMessage,
} from './clone.js';
import { DigestSessionDelta } from './digest-session-delta.js';

// 束の見出しの固定の注意書きは、同じ会話の2回目から参照になる。件数・担当名・時刻・本文は毎回出る。
// 控えは本番と同じ DigestSessionDelta（commit したものだけが「会話の上にある」。compaction の reset で全文へ戻る）

const HUMAN_GUIDE = '**まとめて1つの応答で答えよ。**';
const HUMAN_REF = '同じ注意が会話の上にある';
const MIXED_GUIDE = '**最後まで読んでから、1件ずつ要る手を打て。**';
const MIXED_RUN_GUIDE = '**この続きの報告は最後まで読んでから判断すること。**';
const REPORT_GUIDE = '**まとめて読んでから答えよ。**';
const EXTERNAL_GUIDE = '**同じ中身が複数回届いたからといって、同じ出来事の繰り返しとは限らない**';

function human(id: string, text: string): HumanMessage {
  return {
    type: 'human_message',
    id,
    at: '2026-08-20T10:00:00.000Z',
    conversationId: 'c1',
    text,
  } as HumanMessage;
}

function report(id: string, text: string): ManagerReportMessage {
  return {
    type: 'manager_message',
    id,
    at: '2026-08-20T10:00:00.000Z',
    managerId: 'mgr-a',
    kind: 'report',
    text,
  } as ManagerReportMessage;
}

function external(id: string): ExternalEvent {
  return {
    type: 'external',
    id,
    at: `2026-08-20T10:00:0${id.slice(-1)}.000Z`,
    source: 'github',
    payload: { title: '同じ中身' },
  } as ExternalEvent;
}

interface Kind {
  name: string;
  guide: string;
  build: (fold: (id: string, full: string, ref: string) => string, tag: string) => string;
  /** 毎回出る可変部（件数・担当名・時刻・本文） */
  variable: (tag: string) => string[];
}

const kinds: Kind[] = [
  {
    name: '人間の束',
    guide: HUMAN_GUIDE,
    build: (fold, tag) =>
      humanTurnText(
        [human('h1', `本文A-${tag}`), human('h2', `本文B-${tag}`)],
        new Map(),
        new Map(),
        fold,
      ),
    variable: (tag) => ['続けて **2 件** まとめて渡す', `本文A-${tag}`, `本文B-${tag}`],
  },
  {
    name: '同じ担当の報告の束',
    guide: REPORT_GUIDE,
    build: (fold, tag) =>
      managerReportBatchPrompt(
        [report('r1', `報告A-${tag}`), report('r2', `報告B-${tag}`)],
        { kind: 'none' },
        [{ kind: 'unknown' }, { kind: 'unknown' }],
        new Date('2026-08-20T10:05:00.000Z'),
        new Map(),
        fold,
      ),
    variable: (tag) => ['マネージャー mgr-a', '**2 件**', `報告A-${tag}`, `報告B-${tag}`],
  },
  {
    name: '混合の束（見出し）',
    guide: MIXED_GUIDE,
    build: (fold, tag) => mixedSignalBatchPrompt([`件1-${tag}`, `件2-${tag}`], fold),
    variable: (tag) => ['**2 件** まとめて渡す', `件1-${tag}`, `件2-${tag}`],
  },
  {
    name: '混合の束（同じ担当の塊の注意）',
    guide: MIXED_RUN_GUIDE,
    build: (fold, tag) =>
      mixedSignalBatchPrompt(
        [{ managerId: 'mgr-a', parts: [`塊1-${tag}`, `塊2-${tag}`] }, `別件-${tag}`],
        fold,
      ),
    variable: (tag) => [
      'マネージャー mgr-a からの報告が続けて 2 件（(1)〜(2)）',
      `塊1-${tag}`,
      `塊2-${tag}`,
      `別件-${tag}`,
    ],
  },
  {
    name: '外部の同じ中身の束',
    guide: EXTERNAL_GUIDE,
    build: (fold) => externalBatchPrompt([external('e-1'), external('e-2')], [], fold),
    variable: () => [
      '**2 件** まとめて渡す',
      '届いた時刻（届いた順）',
      'source: github',
      '同じ中身',
    ],
  },
];

describe.each(kinds)('$name の固定の注意は、同じ会話の2回目から参照になる', (kind) => {
  function session(): {
    fold: (id: string, full: string, ref: string) => string;
    delta: DigestSessionDelta;
  } {
    const delta = new DigestSessionDelta();
    return { delta, fold: (id, full, ref) => delta.fixed(id, full, ref) };
  }

  it('⭐ 1回目は全文、2回目は参照（可変部は毎回出る）', () => {
    const { delta, fold } = session();
    const first = kind.build(fold, 'one');
    delta.commit();
    const second = kind.build(fold, 'two');

    expect(first).toContain(kind.guide);
    for (const part of kind.variable('one')) expect(first).toContain(part);
    expect(second).not.toContain(kind.guide);
    expect(second).toContain('同じ注意が会話の上にある');
    for (const part of kind.variable('two')) expect(second).toContain(part);
    expect(second.length).toBeLessThan(first.length);
  });

  it('⭐ 入力が入らなかった回（commit しない）は、次も全文', () => {
    const { delta, fold } = session();
    kind.build(fold, 'one');
    delta.discardStaged();
    expect(kind.build(fold, 'two')).toContain(kind.guide);
  });

  it('⭐ compaction のあとは全文へ戻る', () => {
    const { delta, fold } = session();
    kind.build(fold, 'one');
    delta.commit();
    expect(kind.build(fold, 'two')).not.toContain(kind.guide);
    delta.commit();
    delta.reset('compaction');
    expect(kind.build(fold, 'three')).toContain(kind.guide);
  });

  it('畳む控えを渡さない呼び出しは、今までどおり毎回全文', () => {
    const full = (_id: string, text: string): string => text;
    expect(kind.build(full, 'one')).toContain(kind.guide);
    expect(kind.build(full, 'two')).toContain(kind.guide);
  });
});

describe('束の種類ごとに別の控えで畳む', () => {
  it('人間の束を畳んでも、報告の束・混合の束・外部の束は1回目なら全文', () => {
    const delta = new DigestSessionDelta();
    const fold = (id: string, full: string, ref: string): string => delta.fixed(id, full, ref);
    humanTurnText([human('h1', 'a'), human('h2', 'b')], new Map(), new Map(), fold);
    delta.commit();
    expect(
      humanTurnText([human('h3', 'a'), human('h4', 'b')], new Map(), new Map(), fold),
    ).toContain(HUMAN_REF);
    expect(mixedSignalBatchPrompt(['x', 'y'], fold)).toContain(MIXED_GUIDE);
    expect(externalBatchPrompt([external('e-1'), external('e-2')], [], fold)).toContain(
      EXTERNAL_GUIDE,
    );
  });
});
