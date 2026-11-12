import { describe, expect, it } from 'vitest';

import { setup, waitFor, type Setup } from './clone-test-harness.js';
import {
  DROPPED_SIGNAL_NOTICE_MAX,
  describeDroppedSignals,
  digestOfDroppedSignal,
  mergeDroppedSignals,
  restoreDroppedSignals,
  type DroppedSignalDigest,
} from './dropped-signals.js';
import type { InboxEvent, JournalEntry } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';

function report(id: string, text: string): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: new Date().toISOString(),
    managerId: 'mgr-4633',
    kind: 'report',
    text,
    requestId: 'req-1',
  };
}

const NOTICE = '[system] 前のターンが枠以外の理由で失敗したので';

describe('失敗したターンで外れた合図の要旨（#4633 の案C）', () => {
  it('要旨は種類・送り主・本文の冒頭・requestId を持ち、回答と蒸留は載せない', () => {
    const digest = digestOfDroppedSignal(report('evt-r', `報告の本文 ${'あ'.repeat(500)}`));
    expect(digest).toMatchObject({
      id: 'evt-r',
      type: 'manager_message',
      from: '担当 mgr-4633（report）',
      requestId: 'req-1',
    });
    expect(digest?.head.length).toBeLessThanOrEqual(201);
    expect(
      digestOfDroppedSignal({
        type: 'human_answer',
        id: 'a',
        at: '2026-10-14T00:00:00.000Z',
        approvalId: 'ap',
        answer: 'はい',
      }),
    ).toBeNull();
    expect(
      digestOfDroppedSignal({
        type: 'distill',
        id: 'd',
        at: '2026-10-14T00:00:00.000Z',
        reason: 'scheduled',
      }),
    ).toBeNull();
    expect(describeDroppedSignals([], 0)).toBe('');
    expect(describeDroppedSignals([], 3)).toContain('ほかに 3 件');
  });

  it('⭐ 報告のターンが枠以外の理由で失敗したら、次の通常ターンの入力に要旨を1度添え、日誌に1行残す。届いた後のターンには添えない', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, {
      resultFor: (turnIndex) =>
        turnIndex < 1
          ? { subtype: 'error_during_execution', text: 'API Error: 500 Internal server error' }
          : undefined,
    });
    const inputs = () => s.calls.flatMap((call) => call.inputs);

    s.clone.post(report('evt-report', '消えてはいけない報告の本文'));
    await waitFor(async () => {
      const rows = await stores.journal.list({ types: ['exchange'] });
      return rows.some((row) => JSON.stringify(row).includes('処理されないまま受信箱から外した'));
    }, '外した合図の日誌の行');

    s.clone.post(humanMessage('次の発言'));
    await waitFor(() => inputs().some((text) => text.includes('次の発言')), '次のターン');
    const next = inputs().find((text) => text.includes('次の発言')) ?? '';
    expect(next).toContain(NOTICE);
    expect(next).toContain('担当 mgr-4633（report）');
    expect(next).toContain('requestId=req-1');
    expect(next).toContain('消えてはいけない報告の本文');

    s.clone.post(humanMessage('その次の発言'));
    await waitFor(() => inputs().some((text) => text.includes('その次の発言')), 'その次のターン');
    const after = inputs().find((text) => text.includes('その次の発言')) ?? '';
    expect(after).not.toContain(NOTICE);
    await s.clone.stop();
  });

  it('要旨を添えたターンもまた失敗したら、次のターンにもう一度添える', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, {
      resultFor: (turnIndex) =>
        turnIndex < 2
          ? { subtype: 'error_during_execution', text: 'API Error: 500 Internal server error' }
          : undefined,
    });
    const inputs = () => s.calls.flatMap((call) => call.inputs);

    s.clone.post(report('evt-report', '二度目でも残る報告'));
    s.clone.post(humanMessage('失敗する発言'));
    await waitFor(() => inputs().some((text) => text.includes('失敗する発言')), '2本目のターン');
    s.clone.post(humanMessage('通る発言'));
    await waitFor(() => inputs().some((text) => text.includes('通る発言')), '3本目のターン');

    const third = inputs().find((text) => text.includes('通る発言')) ?? '';
    expect(third).toContain('二度目でも残る報告');
    expect(third).toContain('失敗する発言');
    await s.clone.stop();
  });
});

// 以降は「再起動をまたいで届く」ことの縛り。同じ stores を使い回し、クローンだけを入れ替える（stop → 新しい setup）
const FAILED = {
  subtype: 'error_during_execution',
  text: 'API Error: 500 Internal server error',
} as const;

async function droppedRows(stores: Stores): Promise<number> {
  const rows = await stores.journal.list({ types: ['exchange'], with: ['self'] });
  return rows.filter((row) => JSON.stringify(row).includes('処理されないまま受信箱から外した'))
    .length;
}

async function settledRows(stores: Stores): Promise<number> {
  const rows = await stores.journal.list({ types: ['exchange'], with: ['self'] });
  return rows.filter((row) => JSON.stringify(row).includes('届け終えた')).length;
}

/** clone1: 初回のターンが失敗して、報告が処理されないまま外れる。日誌の行を確かめて止める */
async function dropReportThenStop(stores: Stores): Promise<void> {
  const first = setup(undefined, stores, {
    resultFor: (turnIndex) => (turnIndex < 1 ? FAILED : undefined),
  });
  first.clone.post(report('evt-report', '消えてはいけない報告の本文'));
  await waitFor(async () => (await droppedRows(stores)) >= 1, '外した合図の日誌の行');
  await first.clone.stop();
}

function expectDelivered(input: string): void {
  expect(input).toContain(NOTICE);
  expect(input).toContain('担当 mgr-4633（report）');
  expect(input).toContain('requestId=req-1');
  expect(input).toContain('消えてはいけない報告の本文');
}

async function firstInputFor(s: Setup, text: string): Promise<string> {
  s.clone.post(humanMessage(text));
  const inputs = () => s.calls.flatMap((call) => call.inputs);
  await waitFor(() => inputs().some((input) => input.includes(text)), `${text} のターン`);
  return inputs().find((input) => input.includes(text)) ?? '';
}

describe('外れた合図の要旨は、再起動をまたいで届け直される（A1）', () => {
  it('⭐ 再現: 外れた後に再起動しても、起動後の最初の通常ターンの入力に要旨が載る', async () => {
    const stores = createMemoryStores();
    await dropReportThenStop(stores);

    const second = setup(undefined, stores, {});
    expectDelivered(await firstInputFor(second, '起動後の最初の発言'));
    await second.clone.stop();
  });

  it('(1) 届けたターンが成功したら、その後の起動には載らない（1回だけ）', async () => {
    const stores = createMemoryStores();
    await dropReportThenStop(stores);

    const second = setup(undefined, stores, {});
    expectDelivered(await firstInputFor(second, '起動後の最初の発言'));
    await waitFor(async () => (await settledRows(stores)) >= 1, '届け終えた日誌の行');
    await second.clone.stop();

    const third = setup(undefined, stores, {});
    const input = await firstInputFor(third, '二度目の起動の発言');
    expect(input).not.toContain(NOTICE);
    expect(input).not.toContain('消えてはいけない報告の本文');
    await third.clone.stop();
  });

  it('(2) 届けたターンが失敗したら、次の起動にもう一度載る', async () => {
    const stores = createMemoryStores();
    await dropReportThenStop(stores);

    const second = setup(undefined, stores, { resultFor: () => FAILED });
    expectDelivered(await firstInputFor(second, '失敗する発言'));
    await waitFor(async () => (await droppedRows(stores)) >= 2, '2本目の外した日誌の行');
    expect(await settledRows(stores)).toBe(0);
    await second.clone.stop();

    const third = setup(undefined, stores, {});
    expectDelivered(await firstInputFor(third, '三度目の起動の発言'));
    await third.clone.stop();
  });

  it('(3) 日誌の読みが遅くても、起動直後に来た1本目の入力に載る（入力の組み立てで待つ）', async () => {
    const stores = createMemoryStores();
    await dropReportThenStop(stores);

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = 0;
    const slow: Stores = {
      ...stores,
      journal: {
        ...stores.journal,
        list: async (query) => {
          if (query?.q !== undefined) {
            gated += 1;
            await gate;
          }
          return stores.journal.list(query);
        },
      },
    };
    const second = setup(undefined, slow, {});
    second.clone.post(humanMessage('起動直後の発言'));
    // 日誌の読みが解けないまま、他の処理が進む余地を十分に与える（実時間は使わない: 順番を回すだけ）
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(gated).toBeGreaterThan(0);
    expect(
      second.calls.flatMap((call) => call.inputs).some((x) => x.includes('起動直後の発言')),
    ).toBe(false);
    release();
    const inputs = () => second.calls.flatMap((call) => call.inputs);
    await waitFor(() => inputs().some((x) => x.includes('起動直後の発言')), '起動直後のターン');
    expectDelivered(inputs().find((x) => x.includes('起動直後の発言')) ?? '');
    await second.clone.stop();
  });

  it('(5) 日誌の読みが投げても、起動とターンは進む（要旨は載らない）', async () => {
    const stores = createMemoryStores();
    await dropReportThenStop(stores);

    const broken: Stores = {
      ...stores,
      journal: {
        ...stores.journal,
        list: async (query) => {
          if (query?.q !== undefined) throw new Error('journal unavailable');
          return stores.journal.list(query);
        },
      },
    };
    const second = setup(undefined, broken, {});
    const input = await firstInputFor(second, '読めなくても進む発言');
    expect(input).toContain('読めなくても進む発言');
    expect(input).not.toContain(NOTICE);
    await second.clone.stop();
  });
});

describe('restoreDroppedSignals（純関数）', () => {
  function digest(id: string, extra: Partial<DroppedSignalDigest> = {}): DroppedSignalDigest {
    return {
      id,
      at: '2026-11-01T00:00:00.000Z',
      type: 'manager_message',
      from: '担当 mgr-1（report）',
      head: `本文 ${id}`,
      ...extra,
    };
  }

  function droppedRow(index: number, digests: unknown): JournalEntry {
    return {
      type: 'exchange',
      id: `row-${String(index)}`,
      at: `2026-11-01T00:00:${String(index).padStart(2, '0')}.000Z`,
      with: 'self',
      role: 'outbound',
      text: '[判断] 外した',
      droppedSignals: digests,
    } as unknown as JournalEntry;
  }

  function settledRow(index: number, ids: unknown): JournalEntry {
    return {
      type: 'exchange',
      id: `settled-${String(index)}`,
      at: `2026-11-02T00:00:${String(index).padStart(2, '0')}.000Z`,
      with: 'self',
      role: 'outbound',
      text: '[判断] 届け終えた',
      droppedSignalsSettled: ids,
    } as unknown as JournalEntry;
  }

  it('外れた分から、届け終えた分を引く', () => {
    const restored = restoreDroppedSignals(
      [droppedRow(1, [digest('a'), digest('b')]), droppedRow(2, [digest('c')])],
      [settledRow(1, ['b'])],
    );
    expect(restored.digests.map((d) => d.id)).toEqual(['a', 'c']);
    expect(restored.overflowed).toBe(0);
  });

  it('同じ id は1件にする。requestId など欄はそのまま残る', () => {
    const restored = restoreDroppedSignals(
      [droppedRow(1, [digest('a', { requestId: 'req-1' })]), droppedRow(2, [digest('a')])],
      [],
    );
    expect(restored.digests).toHaveLength(1);
    expect(restored.digests[0]).toMatchObject({ id: 'a' });
  });

  it('上限（20件）を超えたら新しい側を残し、あふれは件数だけ数える', () => {
    const many = Array.from({ length: DROPPED_SIGNAL_NOTICE_MAX + 5 }, (_, i) =>
      digest(`d${String(i).padStart(2, '0')}`),
    );
    const restored = restoreDroppedSignals([droppedRow(1, many)], []);
    expect(restored.digests).toHaveLength(DROPPED_SIGNAL_NOTICE_MAX);
    expect(restored.digests[0]?.id).toBe('d05');
    expect(restored.digests.at(-1)?.id).toBe('d24');
    expect(restored.overflowed).toBe(5);
  });

  it('読めない行・形の合わない要旨は飛ばし、読める分は拾う', () => {
    const restored = restoreDroppedSignals(
      [
        droppedRow(1, 'not-an-array'),
        droppedRow(2, [{ id: 'broken' }, null, 7, digest('ok')]),
        { type: 'decision', id: 'x', at: '2026-11-01T00:00:00.000Z' } as unknown as JournalEntry,
      ],
      [settledRow(1, 'not-an-array'), settledRow(2, [1, null, 'zzz'])],
    );
    expect(restored.digests.map((d) => d.id)).toEqual(['ok']);
  });
});

describe('mergeDroppedSignals（組み直した要旨と、この器が先に外した分を併せる）', () => {
  function digest(id: string): DroppedSignalDigest {
    return {
      id,
      at: '2026-11-01T00:00:00.000Z',
      type: 'manager_message',
      from: '担当 mgr-1（report）',
      head: `本文 ${id}`,
    };
  }
  const ids = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(2, '0')}`);

  it('15 件 + 新たに 10 件（うち 2 件は同じ id）→ 重複を 1 件に畳み、上限 20 件に切ってあふれを数える', () => {
    const restored = ids('r', 15).map(digest);
    // c08・c09 の代わりに組み直し済みの r13・r14 と同じ id を入れる
    const current = [...ids('c', 8), 'r13', 'r14'].map(digest);
    const merged = mergeDroppedSignals({ digests: restored, overflowed: 0 }, current);
    // 重複を畳むと 15 + 8 = 23 件。古い側 3 件（r00〜r02）があふれる
    expect(merged.digests).toHaveLength(DROPPED_SIGNAL_NOTICE_MAX);
    expect(merged.digests.map((d) => d.id)).toEqual([...ids('r', 15).slice(3), ...ids('c', 8)]);
    expect(new Set(merged.digests.map((d) => d.id)).size).toBe(merged.digests.length);
    expect(merged.overflowed).toBe(3);
  });

  it('組み直しの時点であふれていた件数に、併せてあふれた件数を足す', () => {
    const merged = mergeDroppedSignals(
      { digests: ids('r', DROPPED_SIGNAL_NOTICE_MAX).map(digest), overflowed: 2 },
      ids('c', 4).map(digest),
    );
    expect(merged.digests).toHaveLength(DROPPED_SIGNAL_NOTICE_MAX);
    expect(merged.overflowed).toBe(6);
  });
});

describe('組み直しであふれた件数は断り書きに出る', () => {
  it('日誌に 25 件の外れた要旨があれば、再起動後の最初の入力に 20 件と「ほかに 5 件」が載る', async () => {
    const stores = createMemoryStores();
    const digests = Array.from({ length: DROPPED_SIGNAL_NOTICE_MAX + 5 }, (_, i) => ({
      id: `evt-old-${String(i).padStart(2, '0')}`,
      at: '2026-11-01T00:00:00.000Z',
      type: 'manager_message',
      from: '担当 mgr-1（report）',
      head: `古い報告 ${String(i)}`,
    }));
    await stores.journal.append({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text: '[判断] ターンが枠以外の理由で失敗したので、渡した合図 25 件を処理されないまま受信箱から外した（理由: 試験）。',
      droppedSignals: digests,
    });
    const second = setup(undefined, stores, {});
    const input = await firstInputFor(second, '起動後の最初の発言');
    expect(input).toContain(NOTICE);
    expect(input).toContain('ほかに 5 件');
    expect(input).toContain('id=evt-old-24');
    expect(input).not.toContain('id=evt-old-04 ');
    await second.clone.stop();
  });
});
