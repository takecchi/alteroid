import { describe, it, expect } from 'vitest';
import {
  REDELIVERY_COUNT_PREFIX_A,
  REDELIVERY_COUNT_PREFIX_B,
  isHumanOriginated,
  resolveCloneHumanPriority,
} from './clone.js';
import { EXCHANGE_KIND_GAUGE_PREFIX } from './exchange-kind.js';
import type { InboxEvent, InboxEventType } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { setup, waitFor, waitForExpect } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

describe('クローン — 割り込める起点は、人間の速さで来るものだけ（ここが有界性の全体）', () => {
  it('割り込める起点が人間の速さで来るものだけであること（ここが有界性の全体）', () => {
    const expected: Record<InboxEventType, boolean> = {
      human_message: true,
      human_answer: true,
      // 機械の速さで来る起点を true にしない: 割り込みの量が機械の速さで決まり、有界性の根拠が消えるため
      manager_message: false,
      external: false,
      timer: false,
      self_initiative: false,
      distill: false,
    };

    for (const [type, isHuman] of Object.entries(expected)) {
      const event = { type, id: `evt-${type}`, at: '2026-08-22T00:00:00.000Z' } as InboxEvent;
      expect(isHumanOriginated(event), `${type} の判定`).toBe(isHuman);
    }

    expect(Object.values(expected).filter(Boolean)).toHaveLength(2);
  });

  it('未設定・空・空白は既定（有効）で、明示的に切ったときだけ無効になる', () => {
    expect(resolveCloneHumanPriority({})).toBe(true);
    expect(resolveCloneHumanPriority({ ALTEROID_CLONE_HUMAN_PRIORITY: '' })).toBe(true);
    expect(resolveCloneHumanPriority({ ALTEROID_CLONE_HUMAN_PRIORITY: '   ' })).toBe(true);
    expect(resolveCloneHumanPriority({ ALTEROID_CLONE_HUMAN_PRIORITY: 'yes' })).toBe(true);

    for (const off of ['0', 'false', 'off', 'no', 'FALSE', 'Off']) {
      expect(resolveCloneHumanPriority({ ALTEROID_CLONE_HUMAN_PRIORITY: off }), off).toBe(false);
    }
  });
});

// post してから閉じる形にしない: 配達との競争になり、閉じる前に配られると測りたい状態が作れていないのに緑になるため
describe('台帳で片付け済みの報告には印が付く（#391）', () => {
  const REPORT_ID = 'evt-report-closed';

  function storesWithGet(get: (id: string) => Promise<unknown>): Stores {
    const base = createMemoryStores();
    return {
      ...base,
      commitments: { ...base.commitments, get: get as Stores['commitments']['get'] },
    };
  }

  function commitment(fields: { closedAt?: string; closedReason?: string }) {
    return {
      id: REPORT_ID,
      at: '2026-08-24T00:00:00.000Z',
      origin: 'manager' as const,
      body: '[report] 本文',
      ...fields,
    };
  }

  async function deliverReport(stores: Stores): Promise<string> {
    const s = setup(undefined, stores);
    s.clone.post({
      type: 'manager_message',
      id: REPORT_ID,
      at: new Date().toISOString(),
      managerId: 'mgr-closed',
      kind: 'report',
      text: '本文の前半。……そして後半に依頼が入っている。',
    });
    const inputs = (): string[] => (s.calls[0] as FakeCall).inputs;
    await waitForExpect(
      () => expect(inputs().find((input) => input.includes('本文の前半'))).toBeTruthy(),
      '『本文の前半』を含む入力が届く',
    );
    const delivered = inputs().find((input) => input.includes('本文の前半')) ?? '';
    await s.clone.stop();
    return delivered;
  }

  it('閉じた報告には印が付き、閉じた理由も一緒に届く', async () => {
    const delivered = await deliverReport(
      storesWithGet(async (id) =>
        id === REPORT_ID
          ? commitment({
              closedAt: '2026-08-24T00:05:00.000Z',
              closedReason: '判断は求めていないので閉じる',
            })
          : null,
      ),
    );

    expect(delivered).toContain('この報告は台帳で既に片付けている');
    expect(delivered).toContain('判断は求めていないので閉じる');
  });

  it('印が付いても本文は全文のまま届く（二度目の機会を消さない）', async () => {
    const delivered = await deliverReport(
      storesWithGet(async (id) =>
        id === REPORT_ID ? commitment({ closedAt: '2026-08-24T00:05:00.000Z' }) : null,
      ),
    );

    expect(delivered).toContain('本文の前半');
    expect(delivered).toContain('そして後半に依頼が入っている');
    expect(delivered).not.toContain('閉じた理由');
  });

  it('閉じていない報告には印が付かない', async () => {
    const delivered = await deliverReport(
      storesWithGet(async (id) => (id === REPORT_ID ? commitment({}) : null)),
    );

    expect(delivered).not.toContain('既に片付けている');
  });

  it('台帳が引けなかったら印を付けない（unknown は雑音側へ倒す）', async () => {
    const delivered = await deliverReport(
      storesWithGet(() => Promise.reject(new Error('台帳が読めない'))),
    );

    expect(delivered).toContain('本文の前半');
    expect(delivered).not.toContain('既に片付けている');
  });

  it('印は本文より後ろに出る', async () => {
    const delivered = await deliverReport(
      storesWithGet(async (id) =>
        id === REPORT_ID ? commitment({ closedAt: '2026-08-24T00:05:00.000Z' }) : null,
      ),
    );

    expect(delivered).toContain('本文の前半');
    expect(delivered.indexOf('本文の前半')).toBeLessThan(
      delivered.indexOf('この報告は台帳で既に片付けている'),
    );
  });
});

describe('述語が当たった配り直しの件数を数える（issue #1374）', () => {
  function storesWithGet(get: (id: string) => Promise<unknown>): Stores {
    const base = createMemoryStores();
    return {
      ...base,
      commitments: { ...base.commitments, get: get as Stores['commitments']['get'] },
    };
  }

  function commitment(id: string, fields: { closedAt?: string; closedReason?: string }) {
    return {
      id,
      at: '2026-09-24T00:00:00.000Z',
      origin: 'manager' as const,
      body: '[report] 本文',
      ...fields,
    };
  }

  async function countLines(
    stores: Stores,
    prefix: string,
  ): Promise<{ with: string; role: string; text: string }[]> {
    const exchanges = (await stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      role: string;
      text: string;
    }[];
    return exchanges.filter((entry) =>
      entry.text.startsWith(`${EXCHANGE_KIND_GAUGE_PREFIX}${prefix}`),
    );
  }

  it('(A) 台帳で片付け済みの報告が配られた回に、【数える:A】で始まる行が1つだけ増える', async () => {
    const REPORT_ID = 'evt-count-a-closed';
    const stores = storesWithGet(async (id) =>
      id === REPORT_ID ? commitment(REPORT_ID, { closedAt: '2026-09-24T00:05:00.000Z' }) : null,
    );
    const s = setup(undefined, stores);
    s.clone.post({
      type: 'manager_message',
      id: REPORT_ID,
      at: new Date().toISOString(),
      managerId: 'mgr-count-a',
      kind: 'report',
      text: '本文A',
    });
    const inputs = (): string[] => (s.calls[0] as FakeCall).inputs;
    await waitForExpect(
      () => expect(inputs().find((input) => input.includes('本文A'))).toBeTruthy(),
      '『本文A』を含む入力が届く',
    );

    const hits = await countLines(stores, REDELIVERY_COUNT_PREFIX_A);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.with).toBe('self');
    expect(hits[0]?.role).toBe('outbound');
    expect(hits[0]?.text).toContain('mgr-count-a');

    await s.clone.stop();
  });

  it('(A) 陽性対照: 閉じていない報告が配られても、「【数える:」で始まる行は増えない', async () => {
    const REPORT_ID = 'evt-count-a-open';
    const stores = storesWithGet(async (id) =>
      id === REPORT_ID ? commitment(REPORT_ID, {}) : null,
    );
    const s = setup(undefined, stores);
    s.clone.post({
      type: 'manager_message',
      id: REPORT_ID,
      at: new Date().toISOString(),
      managerId: 'mgr-count-a-open',
      kind: 'report',
      text: '本文A-open',
    });
    const inputs = (): string[] => (s.calls[0] as FakeCall).inputs;
    await waitForExpect(
      () => expect(inputs().find((input) => input.includes('本文A-open'))).toBeTruthy(),
      '『本文A-open』を含む入力が届く',
    );

    const exchanges = (await stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    expect(exchanges.filter((entry) => entry.text.startsWith('【数える:'))).toHaveLength(0);

    await s.clone.stop();
  });

  it('(B) 有効性の断り書きが付いてターンが起きた回に、【数える:B】で始まる行が1つだけ増える', async () => {
    const s = setup();
    s.clone.post({
      type: 'manager_message',
      id: 'evt-count-b-changed',
      at: new Date().toISOString(),
      managerId: 'mgr-count-b-ghost',
      kind: 'report',
      text: '本文B',
      statusAtDelivery: 'running',
    });
    const inputs = (): string[] => (s.calls[0] as FakeCall).inputs;
    await waitForExpect(
      () => expect(inputs().find((input) => input.includes('本文B'))).toBeTruthy(),
      '『本文B』を含む入力が届く',
    );

    const hits = await countLines(s.stores, REDELIVERY_COUNT_PREFIX_B);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.with).toBe('self');
    expect(hits[0]?.role).toBe('outbound');
    expect(hits[0]?.text).toContain('mgr-count-b-ghost');

    await s.clone.stop();
  });

  it('(B) 陽性対照: statusAtDelivery を名乗っていない報告では、「【数える:」で始まる行は増えない', async () => {
    const s = setup();
    s.clone.post({
      type: 'manager_message',
      id: 'evt-count-b-unclaimed',
      at: new Date().toISOString(),
      managerId: 'mgr-count-b-unclaimed',
      kind: 'report',
      text: '本文B-unclaimed',
    });
    const inputs = (): string[] => (s.calls[0] as FakeCall).inputs;
    await waitForExpect(
      () => expect(inputs().find((input) => input.includes('本文B-unclaimed'))).toBeTruthy(),
      '『本文B-unclaimed』を含む入力が届く',
    );

    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    expect(exchanges.filter((entry) => entry.text.startsWith('【数える:'))).toHaveLength(0);

    await s.clone.stop();
  });

  it('(A) まとめ読みでは、束の中で閉じている件数ぶんだけ行が増える', async () => {
    const REPORT_ID_1 = 'evt-count-a-batch-1';
    const REPORT_ID_2 = 'evt-count-a-batch-2';
    const REPORT_ID_3 = 'evt-count-a-batch-3';
    const stores = storesWithGet(async (id) => {
      if (id === REPORT_ID_1)
        return commitment(REPORT_ID_1, { closedAt: '2026-09-24T00:05:00.000Z' });
      if (id === REPORT_ID_3)
        return commitment(REPORT_ID_3, { closedAt: '2026-09-24T00:06:00.000Z' });
      return null;
    });
    const s = setup(undefined, stores);

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post({
      type: 'manager_message',
      id: REPORT_ID_1,
      at: new Date().toISOString(),
      managerId: 'mgr-count-batch',
      kind: 'report',
      text: '束1本目',
    });
    s.clone.post({
      type: 'manager_message',
      id: REPORT_ID_2,
      at: new Date().toISOString(),
      managerId: 'mgr-count-batch',
      kind: 'report',
      text: '束2本目',
    });
    s.clone.post({
      type: 'manager_message',
      id: REPORT_ID_3,
      at: new Date().toISOString(),
      managerId: 'mgr-count-batch',
      kind: 'report',
      text: '束3本目',
    });

    await waitFor(
      () => s.calls[0]?.inputs[1]?.includes('束3本目') ?? false,
      'まとめたターンが投げられる',
    );

    const hits = await countLines(stores, REDELIVERY_COUNT_PREFIX_A);
    expect(hits).toHaveLength(2);

    await s.clone.stop();
  }, 15_000);
});

describe('質問・許可確認にも、台帳で片付け済みなら印が付く（#871）', () => {
  function storesWithGet(get: (id: string) => Promise<unknown>): Stores {
    const base = createMemoryStores();
    return {
      ...base,
      commitments: { ...base.commitments, get: get as Stores['commitments']['get'] },
    };
  }

  function commitment(fields: { closedAt?: string; closedReason?: string }) {
    return {
      id: 'evt-871',
      at: '2026-09-15T00:00:00.000Z',
      origin: 'manager' as const,
      body: '[question] 本文',
      ...fields,
    };
  }

  // setupWithManager を使わず本物の ManagerPool を通す: マネージャーを一度も起こしていない liveness が 'unknown' の状態を、'settled' の経路と混ぜずに測るため
  async function deliverConfirmation(
    kind: 'question' | 'permission',
    stores: Stores,
    requestId = 'req-871',
  ): Promise<string> {
    const s = setup(undefined, stores);
    s.clone.post({
      type: 'manager_message',
      id: 'evt-871',
      at: new Date().toISOString(),
      managerId: 'mgr-871',
      kind,
      text: `本文の前半（${kind}）。……そして後半に依頼が入っている。`,
      requestId,
    });
    const inputs = (): string[] => (s.calls[0] as FakeCall).inputs;
    await waitForExpect(
      () => expect(inputs().find((input) => input.includes('本文の前半'))).toBeTruthy(),
      '『本文の前半』を含む入力が届く',
    );
    const delivered = inputs().find((input) => input.includes('本文の前半')) ?? '';
    await s.clone.stop();
    return delivered;
  }

  it('閉じた question には印が付き、答え直せとは言わない', async () => {
    const delivered = await deliverConfirmation(
      'question',
      storesWithGet(async (id) =>
        id === 'evt-871'
          ? commitment({
              closedAt: '2026-09-15T00:05:00.000Z',
              closedReason: 'もう要らないので閉じる',
            })
          : null,
      ),
    );

    expect(delivered).toContain('この質問は台帳で既に片付けている');
    expect(delivered).toContain('もう要らないので閉じる');
    expect(delivered).toContain('答え直す必要は無い');
    expect(delivered).not.toContain('返事をするまで');
    expect(delivered).not.toContain('manager_send');
    expect(delivered).not.toContain('ask_human');
  });

  it('閉じた permission にも印が付き、答え直せとは言わない', async () => {
    const delivered = await deliverConfirmation(
      'permission',
      storesWithGet(async (id) =>
        id === 'evt-871' ? commitment({ closedAt: '2026-09-15T00:05:00.000Z' }) : null,
      ),
    );

    expect(delivered).toContain('この実行の許可確認は台帳で既に片付けている');
    expect(delivered).toContain('答え直す必要は無い');
    expect(delivered).not.toContain('返事をするまで');
  });

  it('閉じていない question / permission には印が付かず、従来どおり全文が出る', async () => {
    const stores = storesWithGet(async (id) => (id === 'evt-871' ? commitment({}) : null));

    const question = await deliverConfirmation('question', stores, 'req-871-q');
    expect(question).not.toContain('既に片付けている');
    expect(question).toContain('返事をするまで');
    expect(question).toContain('manager_send');

    const permission = await deliverConfirmation('permission', stores, 'req-871-p');
    expect(permission).not.toContain('既に片付けている');
    expect(permission).toContain('返事をするまで');
  });

  it('台帳が引けなかったら question にも印を付けない（unknown は雑音側へ）', async () => {
    const delivered = await deliverConfirmation(
      'question',
      storesWithGet(() => Promise.reject(new Error('台帳が読めない'))),
    );

    expect(delivered).not.toContain('既に片付けている');
    expect(delivered).toContain('返事をするまで');
  });

  it('report 経路も同じ台帳から印を出す（3経路そろって対称）', async () => {
    const s = setup(
      undefined,
      storesWithGet(async (id) =>
        id === 'evt-871-report'
          ? commitment({ closedAt: '2026-09-15T00:05:00.000Z', closedReason: '報告側の確認' })
          : null,
      ),
    );
    s.clone.post({
      type: 'manager_message',
      id: 'evt-871-report',
      at: new Date().toISOString(),
      managerId: 'mgr-871',
      kind: 'report',
      text: '本文の前半（report）。……そして後半に依頼が入っている。',
    });
    const inputs = (): string[] => (s.calls[0] as FakeCall).inputs;
    await waitForExpect(
      () => expect(inputs().find((input) => input.includes('本文の前半'))).toBeTruthy(),
      '『本文の前半』を含む入力が届く',
    );
    const delivered = inputs().find((input) => input.includes('本文の前半')) ?? '';
    await s.clone.stop();

    expect(delivered).toContain('この報告は台帳で既に片付けている');
    expect(delivered).toContain('報告側の確認');
  });
});

describe('マネージャーの報告に受け取ってからの経過を添える（#562）', () => {
  async function deliverReport(overrides: { at: string; text?: string }): Promise<string> {
    const s = setup();
    const text = overrides.text ?? '直しました。CIも緑です。';
    s.clone.post({
      type: 'manager_message',
      id: 'evt-age-report',
      at: overrides.at,
      managerId: 'mgr-age',
      kind: 'report',
      text,
    });
    const inputs = (): string[] => (s.calls[0] as FakeCall).inputs;
    await waitForExpect(
      () => expect(inputs().find((input) => input.includes(text))).toBeTruthy(),
      'text の内容を含む入力が届く',
    );
    const delivered = inputs().find((input) => input.includes(text)) ?? '';
    await s.clone.stop();
    return delivered;
  }

  it('経過は閾値を設けず、受け取った直後の報告にも必ず1行出る', async () => {
    const at = new Date().toISOString();
    const delivered = await deliverReport({ at });

    expect(delivered).toContain('受け取ってから');
    expect(delivered).toContain('経過');
    expect(delivered).toContain(at);
  });

  // 3時間前という余裕のある値を使う: 実行に数秒かかっても4時間に届かず、丸めの結果が揺れないため
  it('経過は時間の単位で読みやすく丸められる', async () => {
    const at = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const delivered = await deliverReport({ at });

    expect(delivered).toContain('約3時間');
  });

  it('経過は日の単位でも読みやすく丸められる', async () => {
    const at = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const delivered = await deliverReport({ at });

    expect(delivered).toContain('約5日');
  });

  it('経過の行は本文の後ろ・指示の前に置かれる', async () => {
    const text = '経過の位置を確かめる本文';
    const at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const delivered = await deliverReport({ at, text });

    const bodyIndex = delivered.indexOf(text);
    const ageIndex = delivered.indexOf('受け取ってから');
    const instructionIndex = delivered.indexOf('続きが要るなら `manager_send`');

    expect(bodyIndex).toBeGreaterThanOrEqual(0);
    expect(ageIndex).toBeGreaterThan(bodyIndex);
    expect(instructionIndex).toBeGreaterThan(ageIndex);
  });

  it('at が壊れていたら、嘘の経過を出さず理由を書く', async () => {
    const delivered = await deliverReport({ at: 'これは日時ではない' });

    expect(delivered).not.toContain('NaN');
    expect(delivered).not.toMatch(/-\d+(秒|分|時間|日)/);
    expect(delivered).toContain('経過は測れない');
  });

  it('question / permission には経過が載らない', async () => {
    const s = setup();
    s.clone.post({
      type: 'manager_message',
      id: 'evt-age-question',
      at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      managerId: 'mgr-age-q',
      kind: 'question',
      text: '経過を混ぜてはいけない質問',
    });

    const inputs = (): string[] => (s.calls[0] as FakeCall).inputs;
    await waitForExpect(
      () =>
        expect(inputs().find((input) => input.includes('経過を混ぜてはいけない質問'))).toBeTruthy(),
      '『経過を混ぜてはいけない質問』を含む入力が届く',
    );
    const delivered = inputs().find((input) => input.includes('経過を混ぜてはいけない質問')) ?? '';
    await s.clone.stop();

    expect(delivered).not.toContain('受け取ってから');
  });
});
