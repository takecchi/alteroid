import { describe, expect, it } from 'vitest';

import { REPORT_FOLLOW_UP_GUIDE } from './clone-batch-prompts.js';
import { setup, waitFor, waitForDone } from './clone-test-harness.js';
import { sectionBlock } from './section-block.js';
import type { InboxEvent, JournalEntry } from './schema.js';
import { describeSituation, describeSituationParts, situationPartChars } from './situation.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { buildTurnInputEntry, TURN_INPUT_SIGNALS_LIMIT } from './turn-input-observation.js';

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
