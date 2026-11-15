import { describe, expect, it } from 'vitest';

import {
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH,
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE,
} from './classifier-denial-streak.js';
import {
  externalBatchPrompt,
  externalBatchUnrenderedIds,
  managerReportBatchRender,
  REPORT_FOLLOW_UP_GUIDE,
  type ExternalEvent,
  type ManagerReportMessage,
} from './clone-batch-prompts.js';
import { setup, waitFor, waitForDone } from './clone-test-harness.js';
import { DENIAL_REPLY_ROUTE } from './denial-key.js';
import { EXTERNAL_EVENT_FRAMING, externalEventInstruction } from './prompt.js';
import { buildDenialAskSummary } from './runner-permission-denied-text.js';
import { sectionBlock } from './section-block.js';
import type { InboxEvent, JournalEntry } from './schema.js';
import { describeSituation, describeSituationParts, situationPartChars } from './situation.js';
import { createMemoryStores, humanMessage } from './testing.js';
import {
  buildTurnInputEntry,
  TURN_INPUT_SIGNALS_LIMIT,
  turnInputShortfallChars,
} from './turn-input-observation.js';

// クローンの1ターンに実際に渡した入力の組み立ての内訳（`turn_input`）。文字数・件数・識別子だけを書き、本文は書かない

type Row = Extract<JournalEntry, { type: 'turn_input' }>;

async function rows(stores: ReturnType<typeof createMemoryStores>): Promise<Row[]> {
  return (await stores.journal.list({ types: ['turn_input'] }))
    .filter((entry): entry is Row => entry.type === 'turn_input')
    .reverse();
}

const sum = (record: Record<string, number>): number =>
  Object.values(record).reduce((total, value) => total + value, 0);

function managerMessage(
  id: string,
  kind: 'report' | 'question' | 'permission',
  text: string,
): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: new Date().toISOString(),
    managerId: 'mgr-A',
    kind,
    text,
  } as InboxEvent;
}

function inputsOf(s: ReturnType<typeof setup>): string[] {
  return s.calls.filter((call) => call.kind === 'session').flatMap((call) => call.inputs);
}

function expectTotalsAddUp(row: Row): void {
  expect(row.totalChars).toBe(
    sum(row.notices) + row.humanActionsChars + row.freshMemoryChars + row.bodyChars,
  );
}

describe('turn_input（ターンの入力の内訳）', () => {
  it('人間の発言: 内訳の合計が、実際に投げた入力の文字数と一致する。1ターン1行', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('こんにちは'));
    await waitForDone(s.events);
    await waitFor(async () => (await rows(stores)).length === 1, 'turn_input の1行');

    const [row] = await rows(stores);
    expect(row?.kind).toBe('normal');
    expect(row?.conversationId).toBe('conv-1');
    expect(row?.triggers).toEqual(['human_message']);
    expect(row?.totalChars).toBe(inputsOf(s).at(-1)?.length);
    expectTotalsAddUp(row!);
    expect(row?.signals).toEqual([{ kind: 'human', chars: 'こんにちは'.length }]);
    expect(row?.notices.situation).toBeGreaterThan(0);
    // 該当する注記だけが立つ（0 は省く）
    expect(Object.keys(row?.notices ?? {})).not.toContain('distillGap');
    expect(Object.values(row?.notices ?? {}).every((chars) => chars > 0)).toBe(true);
    // いまの全体の中身の和は notices.situation と一致する
    expect(sum(row?.situationParts ?? {})).toBe(row?.notices.situation);
    expect(row?.situationParts).toHaveProperty('readings');
    await s.clone.stop();
  });

  it('本文・注記の文面は日誌の行に入らない', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('ひみつの合言葉ふくろう'));
    await waitForDone(s.events);
    await waitFor(async () => (await rows(stores)).length === 1, 'turn_input の1行');
    const json = JSON.stringify(await rows(stores));
    expect(json).not.toContain('ふくろう');
    expect(json).not.toContain('区分の読み方');
    expect(json).not.toContain('いまの全体');
    await s.clone.stop();
  });

  it('マネージャーの報告: 切る前の長さが signals に残り、定型は templates に分かれる', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores);
    const long = `結果${'あ'.repeat(9_000)}`;
    s.clone.post(managerMessage('r1', 'report', long));
    await waitFor(async () => (await rows(stores)).length === 1, 'turn_input の1行');

    const [row] = await rows(stores);
    expect(row?.triggers).toEqual(['manager_message']);
    expect(row?.signals).toEqual([
      { kind: 'manager_report', managerId: 'mgr-A', chars: long.length },
    ]);
    expect(row?.templates?.REPORT_FOLLOW_UP_GUIDE).toBe(REPORT_FOLLOW_UP_GUIDE.length);
    expect(row?.bodyChars).toBeLessThan(long.length + 1_000);
    expect(row?.totalChars).toBe(inputsOf(s).at(-1)?.length);
    expectTotalsAddUp(row!);
    expect(JSON.stringify(row)).not.toContain('結果ああ');
    await s.clone.stop();
  });

  it('拒否の知らせのターン: 合図・定型・枠組みの和が本文と一致し、拒否の固定文面は定型に出ない', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores);
    const text = `Bash の実行が止められた。${DENIAL_REPLY_ROUTE}\n全件は日誌に残っている`;
    s.clone.post(managerMessage('d1', 'report', text));
    await waitFor(async () => (await rows(stores)).length === 1, 'turn_input の1行');

    const [row] = await rows(stores);
    expect(row?.signals).toEqual([
      { kind: 'denial_notice', managerId: 'mgr-A', chars: text.length },
    ]);
    expect(row?.templates).not.toHaveProperty('DENIAL_REPLY_ROUTE');
    expect(row?.templates?.REPORT_FOLLOW_UP_GUIDE).toBe(REPORT_FOLLOW_UP_GUIDE.length);
    expect(row!.framingChars).toBeGreaterThan(0);
    // 丸めを経ていない: 合図 + 定型 + 枠組み = 本文
    expect(text.length + sum(row?.templates ?? {}) + row!.framingChars).toBe(row?.bodyChars);
    expectTotalsAddUp(row!);
    await s.clone.stop();
  });

  it('許可確認・外部イベント・質問は、それぞれの種類名で残る', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores);
    s.clone.post(managerMessage('p1', 'permission', '実行してよいですか'));
    await waitFor(async () => (await rows(stores)).length === 1, '1行目');
    s.clone.post({
      type: 'external',
      id: 'x1',
      at: new Date().toISOString(),
      source: 'webhook',
      payload: { a: 1 },
    } as InboxEvent);
    await waitFor(async () => (await rows(stores)).length === 2, '2行目');
    s.clone.post(managerMessage('q1', 'question', 'どうしますか'));
    await waitFor(async () => (await rows(stores)).length === 3, '3行目');

    const all = await rows(stores);
    expect(all.map((row) => row.signals[0]?.kind)).toEqual([
      'manager_confirmation',
      'external',
      'manager_question',
    ]);
    // 全部のターンで、合計が投げた入力と一致する
    const inputs = inputsOf(s);
    all.forEach((row, index) => {
      expectTotalsAddUp(row);
      expect(row.totalChars).toBe(inputs[index]?.length);
    });
    expect(all[1]?.templates).toHaveProperty('EXTERNAL_EVENT_FRAMING');
    await s.clone.stop();
  });

  it('同じ中身の external の束を clone に通すと、2件目以降は rendered: false で、枠組みは丸めを経ない', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('先客'));
    await waitFor(() => inputsOf(s).length === 1, '先客のターンが投げられる');
    const payload = { deploy: 'ok', detail: '同じ中身' };
    for (const id of ['x1', 'x2', 'x3']) {
      s.clone.post({
        type: 'external',
        id,
        at: new Date().toISOString(),
        source: 'webhook',
        payload,
      } as InboxEvent);
    }
    await waitFor(
      async () => (await stores.inbox.claimPending()).length === 0,
      '全件が消し込まれる',
    );
    await waitFor(async () => (await rows(stores)).length === inputsOf(s).length, '行が揃う');

    const batchRow = (await rows(stores)).find((row) => row.signals.length === 3);
    const chars = JSON.stringify(payload, null, 2).length;
    expect(batchRow?.signals).toEqual([
      { kind: 'external', chars },
      { kind: 'external', chars, rendered: false },
      { kind: 'external', chars, rendered: false },
    ]);
    expect(chars + sum(batchRow?.templates ?? {}) + batchRow!.framingChars).toBe(
      batchRow?.bodyChars,
    );
    expect(batchRow!.framingChars).toBeGreaterThan(0);
    await s.clone.stop();
  });

  it('束ねたターン・複数のターンでも、行ごとの合計が実際の入力と一致する', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('先客'));
    await waitFor(() => inputsOf(s).length === 1, '先客のターンが投げられる');
    s.clone.post(managerMessage('b1', 'report', '甲'));
    s.clone.post(managerMessage('b2', 'report', '乙'));
    s.clone.post(humanMessage('続き'));
    await waitFor(
      async () => (await stores.inbox.claimPending()).length === 0,
      '全件が消し込まれる',
    );
    await waitFor(async () => (await rows(stores)).length === inputsOf(s).length, '行が揃う');

    const all = await rows(stores);
    const inputs = inputsOf(s);
    expect(all.length).toBeGreaterThanOrEqual(2);
    all.forEach((row, index) => {
      expectTotalsAddUp(row);
      expect(row.totalChars).toBe(inputs[index]?.length);
    });
    await s.clone.stop();
  });
});

describe('buildTurnInputEntry', () => {
  const composed = (body: string) => ({
    distillGap: '',
    contextWindowFold: '',
    droppedSignals: '',
    redelivery: '',
    validity: '断り',
    mergedBatchTruncation: '',
    commitment: '待ち',
    situation: '',
    body,
  });

  it('注記は欄名ごとに分かれ、0 のものは省く', () => {
    const entry = buildTurnInputEntry({
      kind: 'normal',
      conversationId: null,
      batch: [humanMessage('a')],
      composed: composed('本文'),
      lengths: { composed: 5, withHumanActions: 5, final: 5 },
      situationParts: undefined,
    });
    expect(entry.notices).toEqual({ validity: 2, commitment: 2 });
    expect(entry).not.toHaveProperty('conversationId');
    expect(entry).not.toHaveProperty('situationParts');
  });

  it('合図が上限を超えたら先頭だけ残し、省いた件数を持つ。枠組みは省いた分も引く', () => {
    const batch = Array.from({ length: TURN_INPUT_SIGNALS_LIMIT + 5 }, (_, index) =>
      managerMessage(`m${String(index)}`, 'report', 'x'.repeat(10)),
    );
    const entry = buildTurnInputEntry({
      kind: 'normal',
      conversationId: null,
      batch,
      composed: composed('y'.repeat(400)),
      lengths: { composed: 400, withHumanActions: 400, final: 400 },
      situationParts: undefined,
    });
    expect(entry.signals).toHaveLength(TURN_INPUT_SIGNALS_LIMIT);
    expect(entry.signalsOmitted).toBe(5);
    expect(entry.triggers).toEqual(['manager_message']);
    expect(entry.framingChars).toBe(400 - 25 * 10);
  });

  // 拒否の固定文面は合図の本文（event.text）の一部。合図と定型の両方に数えると、枠組みが過小になり、負なら 0 に隠れる（修正前の挙動）
  const observe = (event: InboxEvent, body: string) => ({
    kind: 'normal' as const,
    conversationId: null,
    batch: [event],
    composed: composed(body),
    lengths: { composed: body.length, withHumanActions: body.length, final: body.length },
    situationParts: undefined,
  });

  function expectBodyPartition(entry: ReturnType<typeof buildTurnInputEntry>): void {
    // 合図は20件以内の試験だけで使う（省いた分は `signals` に載らない）
    expect(entry.signalsOmitted).toBeUndefined();
    expect(
      // 本文に出なかった合図（rendered: false）は本文の内訳に入らない
      entry.signals.reduce((total, s) => total + (s.rendered === false ? 0 : s.chars), 0) +
        sum(entry.templates ?? {}) +
        entry.framingChars,
    ).toBe(entry.bodyChars);
  }

  it('拒否の知らせ: 固定文面は合図に一度だけ数え、定型には数えない。枠組みは前置きと末尾だけ', () => {
    const text = `ツールの実行が止められた。${DENIAL_REPLY_ROUTE}\n全件は日誌に残っている`;
    const body = `HEAD\n\n${text}\n\n${REPORT_FOLLOW_UP_GUIDE}`;
    const observation = observe(managerMessage('d1', 'report', text), body);
    const entry = buildTurnInputEntry(observation);

    expect(entry.signals).toEqual([
      { kind: 'denial_notice', managerId: 'mgr-A', chars: text.length },
    ]);
    expect(entry.templates).toEqual({ REPORT_FOLLOW_UP_GUIDE: REPORT_FOLLOW_UP_GUIDE.length });
    // 'HEAD\n\n'（6字）+ '\n\n'（2字）
    expect(entry.framingChars).toBe(8);
    expect(entry.bodyChars).toBe(body.length);
    expectBodyPartition(entry);
    expect(turnInputShortfallChars(observation)).toBe(0);
  });

  it.each([
    ['一時規則を足せない確認', false, DENIAL_ASK_AFTER_ANSWER_PARAGRAPH],
    ['一時規則を足せる Bash の確認', true, DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE],
  ])('拒否の許可確認（%s）: ASK の段落は合図に一度だけ数える', (_name, ruleable, paragraph) => {
    const text = buildDenialAskSummary(null, '作業者', 'Bash', ruleable, '理由', '入力');
    expect(text).toContain(paragraph);
    const body = `HEAD\n\n${text}\n\nTAIL`;
    const observation = observe(managerMessage('a1', 'permission', text), body);
    const entry = buildTurnInputEntry(observation);

    expect(entry.signals).toEqual([
      { kind: 'manager_confirmation', managerId: 'mgr-A', chars: text.length },
    ]);
    expect(entry.templates).toBeUndefined();
    // 'HEAD\n\n'（6字）+ '\n\nTAIL'（6字）
    expect(entry.framingChars).toBe(12);
    expectBodyPartition(entry);
    expect(turnInputShortfallChars(observation)).toBe(0);
  });

  it('混合束: 拒否の知らせ・報告・外部イベントが並んでも、各区分に一度ずつだけ数える', () => {
    const denial = `止められた。${DENIAL_REPLY_ROUTE}`;
    const body = [
      'HEAD',
      `**(1)**\n${denial}\n${REPORT_FOLLOW_UP_GUIDE}`,
      `**(2)**\n${EXTERNAL_EVENT_FRAMING}\n{"a":1}\n${externalEventInstruction()}`,
    ].join('\n---\n');
    const batch = [
      managerMessage('d1', 'report', denial),
      {
        type: 'external',
        id: 'x1',
        at: new Date().toISOString(),
        source: 'webhook',
        payload: '{"a":1}',
      } as InboxEvent,
    ];
    const observation = { ...observe(batch[0]!, body), batch };
    const entry = buildTurnInputEntry(observation);

    expect(entry.templates).toEqual({
      REPORT_FOLLOW_UP_GUIDE: REPORT_FOLLOW_UP_GUIDE.length,
      EXTERNAL_EVENT_FRAMING: EXTERNAL_EVENT_FRAMING.length,
      EXTERNAL_EVENT_INSTRUCTION: externalEventInstruction().length,
    });
    expectBodyPartition(entry);
    expect(turnInputShortfallChars(observation)).toBe(0);
  });

  // 同じ中身の external の束は、中身を本文に1回だけ出す（`externalBatchPrompt`）。2件目以降は signals に chars を持つが本文には出ない
  const externalEvent = (id: string, payload: string): ExternalEvent => ({
    type: 'external',
    id,
    at: '2026-11-15T00:00:00.000Z',
    source: 'webhook',
    payload,
  });

  it.each([2, 3])(
    '同じ中身の external の束（%i 件）: 本文に出ない件の字数は枠組みから引かない',
    (count) => {
      const payload = '{"deploy":"ok"}';
      const events = Array.from({ length: count }, (_, index) =>
        externalEvent(`x${String(index)}`, payload),
      );
      const body = `HEAD\n${EXTERNAL_EVENT_FRAMING}\n${payload}\n${externalEventInstruction()}\nTAIL`;
      const observation = {
        ...observe(events[0]!, body),
        batch: events,
        unrenderedEventIds: new Set(externalBatchUnrenderedIds(events)),
      };
      const entry = buildTurnInputEntry(observation);

      expect(entry.signals).toEqual(
        events.map((_, index) => ({
          kind: 'external',
          chars: payload.length,
          ...(index === 0 ? {} : { rendered: false }),
        })),
      );
      expect(entry.templates).toEqual({
        EXTERNAL_EVENT_FRAMING: EXTERNAL_EVENT_FRAMING.length,
        EXTERNAL_EVENT_INSTRUCTION: externalEventInstruction().length,
      });
      // 'HEAD\n'（5字）+ framing 直後の '\n'（1字）+ instruction 直前の '\n'（1字）+ '\nTAIL'（5字）
      expect(entry.framingChars).toBe(12);
      expectBodyPartition(entry);
      expect(turnInputShortfallChars(observation)).toBe(0);
    },
  );

  it.each([2, 3])(
    'externalBatchPrompt が組んだ本文でも、%i 件の束の内訳が本文と一致する',
    (count) => {
      const payload = '{"deploy":"ok","detail":"同じ中身"}';
      const events = Array.from({ length: count }, (_, index) =>
        externalEvent(`x${String(index)}`, payload),
      );
      const body = externalBatchPrompt(events);
      const observation = {
        ...observe(events[0]!, body),
        batch: events,
        unrenderedEventIds: new Set(externalBatchUnrenderedIds(events)),
      };
      const entry = buildTurnInputEntry(observation);

      // 中身は本文に1回だけ出る。件数が増えても枠組みの字数は変わらない（2件・3件で同じ値）
      expect(entry.framingChars).toBe(
        body.length -
          payload.length -
          EXTERNAL_EVENT_FRAMING.length -
          externalEventInstruction().length,
      );
      expectBodyPartition(entry);
      expect(turnInputShortfallChars(observation)).toBe(0);
    },
  );

  it('同じ担当の報告の束が予算で古い側の本文を省いたとき、省いた件は rendered: false で枠組みから引かない', () => {
    const reports = Array.from(
      { length: 4 },
      (_, index) =>
        managerMessage(`r${String(index)}`, 'report', 'x'.repeat(15_000)) as ManagerReportMessage,
    );
    const { prompt, unrenderedIds } = managerReportBatchRender(
      reports,
      { kind: 'missing', conversationId: null },
      new Date('2026-11-15T00:00:00.000Z'),
      new Map(),
      20_000,
    );
    expect(unrenderedIds).toEqual(['r0']);
    const observation = {
      ...observe(reports[0]!, prompt),
      batch: reports,
      unrenderedEventIds: new Set(unrenderedIds),
    };
    const entry = buildTurnInputEntry(observation);

    expect(entry.signals.map((signal) => signal.rendered)).toEqual([
      false,
      undefined,
      undefined,
      undefined,
    ]);
    expectBodyPartition(entry);
    expect(turnInputShortfallChars(observation)).toBe(0);
  });

  it('切り詰めで枠組みが負になるときは 0 に丸める（切る前の合図の長さが本文を超える。丸めは shortfall に出る）', () => {
    const observation = observe(managerMessage('m', 'report', 'x'.repeat(9_000)), 'y'.repeat(100));
    expect(buildTurnInputEntry(observation).framingChars).toBe(0);
    expect(turnInputShortfallChars(observation)).toBe(8_900);
  });

  it('切り詰めで枠組みが負になるときは 0 に丸める', () => {
    const entry = buildTurnInputEntry({
      kind: 'normal',
      conversationId: null,
      batch: [managerMessage('m', 'report', 'x'.repeat(9_000))],
      composed: composed('y'.repeat(100)),
      lengths: { composed: 100, withHumanActions: 100, final: 100 },
      situationParts: undefined,
    });
    expect(entry.framingChars).toBe(0);
  });
});

describe('situation の部分（describeSituationParts）', () => {
  it('部分の連結は describeSituation の文字列と1文字も違わず、長さの和も一致する', () => {
    const input = { managers: [], runners: [], at: Date.UTC(2026, 10, 15, 3, 4, 5) };
    const parts = describeSituationParts(input);
    expect(sectionBlock(parts.map((part) => part.line))).toBe(describeSituation(input));
    expect(sum(situationPartChars(parts))).toBe(describeSituation(input).length);
    expect(parts.map((part) => part.name)).toEqual(['head', 'delegation', 'runners', 'readings']);
  });
});
