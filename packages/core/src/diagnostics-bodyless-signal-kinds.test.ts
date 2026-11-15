import { describe, expect, it } from 'vitest';

import { BODYLESS_SIGNAL_KINDS } from './diagnostics-conversation-analysis.js';
import { DAILY_REPORT_KIND } from './schedule.js';
import { inboxEventSchema, type InboxEvent, type InboxEventType } from './schema.js';
import { buildTurnInputEntry } from './turn-input-observation.js';

// `BODYLESS_SIGNAL_KINDS`（本文を持たない合図の kind。束のとき `signals[].chars` が 0 で書かれる）は手書きの一覧で、出所の定数は無い。
// 出所は `buildTurnInputEntry` が合図ごとに決める `signals[].kind` と `chars`（`signalKindOf`・`signalTextOf`、turn-input-observation.ts）。
// ここでは実際の `buildTurnInputEntry` に、受信箱の合図の種類を全部渡して `chars` の意味を測り、手書きの一覧と突き合わせる。
// 出所が変わったら（合図の種類が増える・kind の名前が変わる・本文の持ち方が変わる）落ちる。

const FIX_MESSAGE =
  '出所が変わった。`BODYLESS_SIGNAL_KINDS`（packages/core/src/diagnostics-conversation-analysis.ts）を直すこと。' +
  '出所は turn-input-observation.ts の `signalKindOf`・`signalTextOf`';

const AT = '2026-11-13T00:00:00.000Z';
const BODY = 'ターンの本文'; // 本文を持たない合図が1件だけのターンでは、この長さが chars になる
const FILLER: InboxEvent = {
  type: 'human_message',
  id: 'filler',
  at: AT,
  text: 'filler',
  conversationId: 'c',
};

// `Record<InboxEventType, …>` にして、受信箱の合図の種類が増えたら型で落とす（実行時にも schema の一覧と突き合わせる）
const SAMPLES: Record<InboxEventType, InboxEvent[]> = {
  human_message: [
    { type: 'human_message', id: 'h1', at: AT, text: 'こんにちは', conversationId: 'c' },
  ],
  human_answer: [{ type: 'human_answer', id: 'a1', at: AT, approvalId: 'ap', answer: 'はい' }],
  distill: [{ type: 'distill', id: 'd1', at: AT, reason: 'scheduled' }],
  timer: [
    { type: 'timer', id: 't1', at: AT, kind: 'some-schedule' },
    { type: 'timer', id: 't2', at: AT, kind: DAILY_REPORT_KIND },
  ],
  external: [{ type: 'external', id: 'e1', at: AT, source: 's', payload: { text: '外部の本文' } }],
  self_initiative: [{ type: 'self_initiative', id: 's1', at: AT, reason: '発意' }],
  manager_message: [
    { type: 'manager_message', id: 'm1', at: AT, managerId: 'm', kind: 'report', text: '報告' },
    { type: 'manager_message', id: 'm2', at: AT, managerId: 'm', kind: 'question', text: '質問' },
    { type: 'manager_message', id: 'm3', at: AT, managerId: 'm', kind: 'permission', text: '許可' },
  ],
};

function charsOf(batch: InboxEvent[]): Array<{ kind: string; chars: number }> {
  return buildTurnInputEntry({
    kind: 'normal',
    conversationId: null,
    batch,
    composed: {
      distillGap: '',
      contextWindowFold: '',
      droppedSignals: '',
      redelivery: '',
      validity: '',
      mergedBatchTruncation: '',
      commitment: '',
      situation: '',
      body: BODY,
    },
    lengths: { composed: BODY.length, withHumanActions: BODY.length, final: BODY.length },
    situationParts: undefined,
  }).signals.map((signal) => ({ kind: signal.kind, chars: signal.chars }));
}

describe('BODYLESS_SIGNAL_KINDS は、turn_input を書く側（buildTurnInputEntry）の chars の意味と一致する', () => {
  it('標本は、受信箱の合図の種類（inboxEventSchema の type）を全部含む', () => {
    const types = inboxEventSchema.options.map(
      (option) => (option.shape.type as unknown as { value: string }).value,
    );
    expect(
      new Set(Object.keys(SAMPLES)),
      '受信箱の合図の種類が増減した。SAMPLES に標本を足し、BODYLESS_SIGNAL_KINDS を確かめること',
    ).toEqual(new Set(types));
  });

  it('束のとき chars が 0 になる kind（= 本文を持たない）が、手書きの一覧と一致する', () => {
    const bodyless = new Set<string>();
    const withBody = new Set<string>();
    for (const events of Object.values(SAMPLES)) {
      for (const event of events) {
        const alone = charsOf([event]);
        const batched = charsOf([event, FILLER]);
        expect(alone, FIX_MESSAGE).toHaveLength(1);
        const [single] = alone;
        const [inBatch] = batched;
        if (single === undefined || inBatch === undefined) throw new Error(FIX_MESSAGE);
        expect(inBatch.kind, FIX_MESSAGE).toBe(single.kind);
        if (inBatch.chars === 0) {
          // 本文を持たない: 1件だけのターンでは、ターンの本文そのものが合図の本文になる（定型の文面）
          expect(single.chars, FIX_MESSAGE).toBe(BODY.length);
          bodyless.add(single.kind);
        } else {
          // 本文を持つ: 束でも1件でも、合図自身の本文の長さ（ターンの本文の長さではない）
          expect(single.chars, FIX_MESSAGE).toBe(inBatch.chars);
          expect(single.chars, FIX_MESSAGE).not.toBe(BODY.length);
          withBody.add(single.kind);
        }
      }
    }
    // 同じ kind が、本文を持つ回と持たない回の両方に出ない（出所が kind 単位で決めていることの確認）
    expect(
      [...bodyless].filter((kind) => withBody.has(kind)),
      FIX_MESSAGE,
    ).toEqual([]);
    expect([...bodyless].sort(), FIX_MESSAGE).toEqual([...BODYLESS_SIGNAL_KINDS].sort());
  });

  it('日報（daily_report）は timer の合図の一種として、timer と別の kind で書かれる', () => {
    const kinds = SAMPLES.timer.map((event) => charsOf([event])[0]?.kind);
    expect(kinds, FIX_MESSAGE).toEqual(['timer', 'daily_report']);
  });
});
