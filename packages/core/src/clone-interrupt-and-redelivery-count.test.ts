import { describe, it, expect } from 'vitest';
import {
  REDELIVERY_COUNT_PREFIX_B,
  isHumanOriginated,
  resolveCloneHumanPriority,
} from './clone.js';
import { EXCHANGE_KIND_GAUGE_PREFIX } from './exchange-kind.js';
import type { InboxEvent, InboxEventType } from './schema.js';
import type { Stores } from './store.js';
import { setup, waitForExpect } from './clone-test-harness.js';
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

describe('述語が当たった配り直しの件数を数える（issue #1374）', () => {
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
