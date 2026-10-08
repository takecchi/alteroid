import { describe, it, expect } from 'vitest';
import { ALWAYS_REDELIVER, createClone, humanTurnText } from './clone.js';
import type { HumanMessage } from './clone.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, wireEvents, waitFor } from './clone-test-harness.js';
import type { Setup } from './clone-test-harness.js';

describe('humanTurnText（ターン本文の組み立て）', () => {
  const message = (text: string, at: string): HumanMessage => ({
    type: 'human_message',
    id: `evt-${text}`,
    at,
    text,
    conversationId: 'conv-1',
  });

  it('1件なら本文そのまま（1文字も足さない）', () => {
    expect(humanTurnText([message('やあ', '2026-08-20T10:00:00.000Z')])).toBe('やあ');
  });

  it('issue #955: 巨大な人間の発言（10万字）も1文字も切らずに通す（切ってはいけない）', () => {
    const huge = '先頭' + 'x'.repeat(100_000) + '末尾';
    expect(humanTurnText([message(huge, '2026-08-20T10:00:00.000Z')])).toBe(huge);
  });

  it('複数件は全文を届いた順に並べ、各件の時刻を添える', () => {
    const text = humanTurnText([
      message('AAA', '2026-08-20T10:00:00.000Z'),
      message('BBB', '2026-08-20T10:00:09.000Z'),
    ]);

    expect(text).toContain('続けて **2 件** まとめて渡す');
    expect(text).toContain('AAA');
    expect(text).toContain('BBB');
    expect(text.indexOf('AAA')).toBeLessThan(text.indexOf('BBB'));
    expect(text).toContain('2026-08-20T10:00:00.000Z');
    expect(text).toContain('2026-08-20T10:00:09.000Z');
  });

  it('1件も無ければ空文字（呼び出し側が先頭を仮定しない）', () => {
    expect(humanTurnText([])).toBe('');
  });

  it('supersedes が無ければ、priorTexts を渡していても1文字も足さない', () => {
    const event = message('やあ', '2026-08-20T10:00:00.000Z');
    const priorTexts = new Map([[event.id, '無関係な本文']]);
    expect(humanTurnText([event], priorTexts)).toBe('やあ');
  });

  it('supersedes があれば、編集である合図を前置きする（issue「チャットの送信済みメッセージを編集する」）', () => {
    const event: HumanMessage = {
      ...message('直した本文', '2026-08-20T10:05:00.000Z'),
      supersedes: 'evt-old',
    };
    const text = humanTurnText([event]);
    expect(text).toContain('これは既出発言（id=evt-old）の編集である');
    expect(text).toContain('編集前の本文は引けなかった');
    expect(text).toContain('直した本文');
  });

  it('supersedes があり priorTexts が引けていれば、編集前の本文も渡す', () => {
    const event: HumanMessage = {
      ...message('直した本文', '2026-08-20T10:05:00.000Z'),
      supersedes: 'evt-old',
    };
    const priorTexts = new Map([[event.id, '元の本文']]);
    const text = humanTurnText([event], priorTexts);
    expect(text).toContain('これは既出発言（id=evt-old）の編集である');
    expect(text).toContain('元の本文');
    expect(text).toContain('直した本文');
    expect(text.indexOf('元の本文')).toBeLessThan(text.indexOf('直した本文'));
  });

  it('複数件のうち1件だけが編集でも、バッチの文面でどれが編集かが分かる', () => {
    const plain = message('ふつうの発言', '2026-08-20T10:00:00.000Z');
    const edited: HumanMessage = {
      ...message('直した本文', '2026-08-20T10:00:09.000Z'),
      supersedes: 'evt-old',
    };
    const priorTexts = new Map([[edited.id, '元の本文']]);
    const text = humanTurnText([plain, edited], priorTexts);
    expect(text).toContain('ふつうの発言');
    expect(text).toContain('（既出発言の編集）');
    expect(text).toContain('元の本文');
    expect(text).toContain('直した本文');
    const firstBlockEnd = text.indexOf('(2)');
    expect(text.slice(0, firstBlockEnd)).not.toContain('編集である');
  });

  it('副作用を巻き戻す指示は一切足さない（制約(B)）', () => {
    const event: HumanMessage = {
      ...message('直した本文', '2026-08-20T10:05:00.000Z'),
      supersedes: 'evt-old',
    };
    const text = humanTurnText([event], new Map([[event.id, '元の本文']]));
    expect(text).not.toMatch(/取り消|巻き戻|キャンセル/);
  });
});

describe('編集ターン（supersedes）—— #record と #runHumanTurn の配線', () => {
  function setupClone(reply?: (input: string) => string) {
    const stores = createMemoryStores();
    const { fn, calls } = fakeSdk(reply);
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    return { clone, stores, calls };
  }

  it('#record は human_message の supersedes を日誌の exchange へそのまま通す', async () => {
    const { clone, stores, calls } = setupClone();
    const original = await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '元の本文',
      conversationId: 'conv-record',
    });

    clone.post({
      type: 'human_message',
      id: 'evt-edit-record',
      at: new Date().toISOString(),
      text: '直した本文',
      conversationId: 'conv-record',
      supersedes: original.id,
    });

    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    const entries = await stores.journal.list({ types: ['exchange'] });
    const written = entries.find(
      (entry) => entry.type === 'exchange' && entry.text === '直した本文',
    );
    expect(written).toBeDefined();
    expect(written).toMatchObject({ supersedes: original.id, conversationId: 'conv-record' });
  });

  it('supersedes が無ければ、日誌の exchange に supersedes は付かない（取れない軸に値を作らない）', async () => {
    const { clone, stores, calls } = setupClone();
    clone.post({
      type: 'human_message',
      id: 'evt-plain-record',
      at: new Date().toISOString(),
      text: 'ふつうの発言',
      conversationId: 'conv-plain-record',
    });

    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    const entries = await stores.journal.list({ types: ['exchange'] });
    const written = entries.find(
      (entry) => entry.type === 'exchange' && entry.text === 'ふつうの発言',
    );
    expect(written).toBeDefined();
    expect(written).not.toHaveProperty('supersedes');
  });

  it('#runHumanTurn は旧エントリの本文を引いてターン入力へ渡す', async () => {
    const { clone, stores, calls } = setupClone();
    const original = await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '元の本文がここにある',
      conversationId: 'conv-turn',
    });

    clone.post({
      type: 'human_message',
      id: 'evt-edit-turn',
      at: new Date().toISOString(),
      text: '直した本文がここにある',
      conversationId: 'conv-turn',
      supersedes: original.id,
    });

    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    const input = calls[0]?.inputs[0] ?? '';
    expect(input).toContain(`これは既出発言（id=${original.id}）の編集である`);
    expect(input).toContain('元の本文がここにある');
    expect(input).toContain('直した本文がここにある');
  });

  it('旧エントリが引けなくても落ちない（編集である事実だけは伝える）', async () => {
    const { clone, calls } = setupClone();

    clone.post({
      type: 'human_message',
      id: 'evt-edit-missing',
      at: new Date().toISOString(),
      text: '直した本文（旧本文は無い）',
      conversationId: 'conv-missing',
      supersedes: 'evt-does-not-exist',
    });

    await waitFor(() => calls.length > 0, 'セッションが開くこと（落ちずにターンが進む）');
    clone.stop();

    const input = calls[0]?.inputs[0] ?? '';
    expect(input).toContain('これは既出発言（id=evt-does-not-exist）の編集である');
    expect(input).toContain('編集前の本文は引けなかった');
    expect(input).toContain('直した本文（旧本文は無い）');
  });

  it('副作用（承認待ち等）は編集後も巻き戻されない（制約(B)）', async () => {
    const { clone, stores, calls } = setupClone();
    const original = await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '元の本文',
      conversationId: 'conv-side-effect',
    });
    await stores.commitments.open({
      id: 'commit-untouched',
      at: new Date().toISOString(),
      origin: 'human',
      body: '編集前のターンが開いた依頼',
    });

    clone.post({
      type: 'human_message',
      id: 'evt-edit-side-effect',
      at: new Date().toISOString(),
      text: '直した本文',
      conversationId: 'conv-side-effect',
      supersedes: original.id,
    });

    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    const commitment = await stores.commitments.get('commit-untouched');
    expect(commitment).not.toBeNull();
    expect(commitment?.closedAt).toBeUndefined();
    const stillThere = await stores.journal.get(original.id);
    expect(stillThere?.type).toBe('exchange');
    expect(stillThere && stillThere.type === 'exchange' ? stillThere.text : undefined).toBe(
      '元の本文',
    );
  });
});

describe('クローン — 人間が待っている合図を待ち行列の先頭側へ入れる', () => {
  function setupWithHumanPriority(
    humanPriority: boolean,
    reply: (input: string) => string = () => 'わかった',
    sdkOptions: Parameters<typeof fakeSdk>[1] = {},
  ): Setup {
    const stores = createMemoryStores();
    const { fn, calls } = fakeSdk(reply, sdkOptions);
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      humanPriority,
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events, waitForEvents } = wireEvents(clone, 'conv-1');
    return { clone, stores, calls, events, waitForEvents };
  }

  const waitForFirstTurn = (s: Setup): Promise<void> =>
    waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

  const waitForAllDelivered = (s: Setup, markers: readonly string[]): Promise<void> =>
    waitFor(
      () => markers.every((marker) => (s.calls[0]?.inputs ?? []).join('\n').includes(marker)),
      `${markers.join(' / ')} が全部届く`,
    );

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400));

  const managerMessage = (id: string, managerId: string, text: string): InboxEvent => ({
    type: 'manager_message',
    id,
    at: new Date().toISOString(),
    managerId,
    kind: 'report',
    text,
  });

  const timerEvent = (id: string, kind: string): InboxEvent => ({
    type: 'timer',
    id,
    at: new Date().toISOString(),
    kind,
  });

  const managerMarker = (managerId: string, text: string): string =>
    `マネージャー ${managerId} から届いた。（報告）\n\n${text}`;
  const timerMarker = (kind: string): string => `定期ジョブ ${kind} の時刻になった`;
  // 区切り（`---`）の直後では探さない: 本文の前に会話の名乗り（#4210）が入り、その文面は直前の会話によって変わるため
  const humanMarker = (text: string): string => `\n\n${text}`;

  const DISTILL_MARKER = '記憶へ移すべきものがあるか確認せよ';

  it('人間の発言は、先に積まれていた人間以外を追い越して先に読まれる', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    s.clone.post(managerMessage('evt-mgr-a', 'mgr-a', 'マネージャーAの報告'));
    s.clone.post(managerMessage('evt-mgr-b', 'mgr-b', 'マネージャーBの報告'));
    s.clone.post(timerEvent('evt-timer-c', 'timer-c-kind'));
    s.clone.post(humanMessage('人間の発言だ'));

    const markerHuman = humanMarker('人間の発言だ');
    const markerMgrA = managerMarker('mgr-a', 'マネージャーAの報告');
    const markerMgrB = managerMarker('mgr-b', 'マネージャーBの報告');
    const markerTimer = timerMarker('timer-c-kind');

    await waitForAllDelivered(s, [markerHuman, markerMgrA, markerMgrB, markerTimer]);
    await settle();

    const inputs = s.calls[0]?.inputs ?? [];
    const idxHuman = inputs.findIndex((text) => text.includes(markerHuman));
    const idxMgrA = inputs.findIndex((text) => text.includes(markerMgrA));
    const idxMgrB = inputs.findIndex((text) => text.includes(markerMgrB));
    const idxTimer = inputs.findIndex((text) => text.includes(markerTimer));

    expect(idxHuman).toBeGreaterThan(-1);
    expect(idxMgrA).toBeGreaterThan(-1);
    expect(idxMgrB).toBeGreaterThan(-1);
    expect(idxTimer).toBeGreaterThan(-1);

    expect(idxHuman).toBeLessThan(idxMgrA);
    expect(idxHuman).toBeLessThan(idxMgrB);
    expect(idxHuman).toBeLessThan(idxTimer);

    await s.clone.stop();
  }, 15_000);

  it('人間を挟んでも、人間以外は1件も消えず、人間以外どうしの到着順も保たれる', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    s.clone.post(managerMessage('evt-a', 'mgr-a', '非人間A'));
    s.clone.post(timerEvent('evt-b', '非人間B'));
    s.clone.post(humanMessage('割り込む人間'));
    s.clone.post(managerMessage('evt-c', 'mgr-c', '非人間C'));

    const markerA = managerMarker('mgr-a', '非人間A');
    const markerB = timerMarker('非人間B');
    const markerC = managerMarker('mgr-c', '非人間C');
    const markerHuman = humanMarker('割り込む人間');

    await waitForAllDelivered(s, [markerA, markerB, markerC, markerHuman]);
    await settle();

    const inputs = s.calls[0]?.inputs ?? [];
    const idxA = inputs.findIndex((text) => text.includes(markerA));
    const idxB = inputs.findIndex((text) => text.includes(markerB));
    const idxC = inputs.findIndex((text) => text.includes(markerC));
    const idxHuman = inputs.findIndex((text) => text.includes(markerHuman));

    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxC).toBeGreaterThan(-1);

    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);

    expect(idxHuman).toBeGreaterThan(-1);
    expect(idxHuman).toBeLessThan(idxA);

    await s.clone.stop();
  }, 15_000);

  it('切ると純粋な先入れ先出しに戻る', async () => {
    const s = setupWithHumanPriority(false, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    s.clone.post(managerMessage('evt-mgr-a', 'mgr-a', 'マネージャーAの報告'));
    s.clone.post(managerMessage('evt-mgr-b', 'mgr-b', 'マネージャーBの報告'));
    s.clone.post(timerEvent('evt-timer-c', 'timer-c-kind'));
    s.clone.post(humanMessage('人間の発言だ'));

    const markerHuman = humanMarker('人間の発言だ');
    const markerMgrA = managerMarker('mgr-a', 'マネージャーAの報告');
    const markerMgrB = managerMarker('mgr-b', 'マネージャーBの報告');
    const markerTimer = timerMarker('timer-c-kind');

    await waitForAllDelivered(s, [markerHuman, markerMgrA, markerMgrB, markerTimer]);
    await settle();

    const inputs = s.calls[0]?.inputs ?? [];
    const idxHuman = inputs.findIndex((text) => text.includes(markerHuman));
    const idxMgrA = inputs.findIndex((text) => text.includes(markerMgrA));
    const idxMgrB = inputs.findIndex((text) => text.includes(markerMgrB));
    const idxTimer = inputs.findIndex((text) => text.includes(markerTimer));

    expect(idxHuman).toBeGreaterThan(-1);
    expect(idxMgrA).toBeGreaterThan(-1);
    expect(idxMgrB).toBeGreaterThan(-1);
    expect(idxTimer).toBeGreaterThan(-1);

    expect(idxMgrA).toBeLessThan(idxMgrB);
    expect(idxMgrB).toBeLessThan(idxTimer);
    expect(idxTimer).toBeLessThan(idxHuman);

    await s.clone.stop();
  }, 15_000);

  it('人間が続けて割り込んでも、人間どうしは送信順のまま（早い方が先）', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    s.clone.post(humanMessage('人間1'));
    s.clone.post(managerMessage('evt-mgr', 'mgr-x', 'マネージャーの報告'));
    s.clone.post(humanMessage('人間2'));
    s.clone.post(humanMessage('人間3'));
    s.clone.post(timerEvent('evt-timer', 'timer-kind'));
    s.clone.post(humanMessage('人間4'));

    const markerMgr = managerMarker('mgr-x', 'マネージャーの報告');
    const markerTimer = timerMarker('timer-kind');
    await waitForAllDelivered(s, ['人間1', '人間4', markerMgr, markerTimer]);
    await settle();

    const joined = (s.calls[0]?.inputs ?? []).join('\n');
    const idxOf = (text: string): number => joined.indexOf(`**\n\n${text}`);
    const i1 = idxOf('人間1');
    const i2 = idxOf('人間2');
    const i3 = idxOf('人間3');
    const i4 = idxOf('人間4');
    const idxMgr = joined.indexOf(markerMgr);
    const idxTimer = joined.indexOf(markerTimer);

    expect(i1, '人間1 が本文に見つからない').toBeGreaterThan(-1);
    expect(i2, '人間2 が本文に見つからない').toBeGreaterThan(-1);
    expect(i3, '人間3 が本文に見つからない').toBeGreaterThan(-1);
    expect(i4, '人間4 が本文に見つからない').toBeGreaterThan(-1);
    expect(idxMgr).toBeGreaterThan(-1);
    expect(idxTimer).toBeGreaterThan(-1);

    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
    expect(i3).toBeLessThan(i4);
    expect(i4).toBeLessThan(idxMgr);
    expect(i4).toBeLessThan(idxTimer);

    await s.clone.stop();
  }, 15_000);

  it('会話をまたいでも人間どうしは送信順で、あいだに別の会話が挟まればまとめない', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客', 'conv-0'));
    await waitForFirstTurn(s);

    s.clone.post(managerMessage('evt-mgr-a', 'mgr-A', 'Aの報告'));
    s.clone.post(managerMessage('evt-mgr-b', 'mgr-B', 'Bの報告'));
    s.clone.post(humanMessage('会話Hの1件目', 'conv-H'));
    s.clone.post(humanMessage('会話Iの1件目', 'conv-I'));
    s.clone.post(humanMessage('会話Hの2件目', 'conv-H'));
    s.clone.post(managerMessage('evt-mgr-c', 'mgr-C', 'Cの報告'));

    const markerA = managerMarker('mgr-A', 'Aの報告');
    const markerB = managerMarker('mgr-B', 'Bの報告');
    const markerC = managerMarker('mgr-C', 'Cの報告');
    await waitForAllDelivered(s, [markerC]);
    await settle();

    const inputs = s.calls[0]?.inputs ?? [];

    expect(inputs).toHaveLength(7);

    const joined = inputs.join('\n');
    const idxH1 = joined.indexOf(humanMarker('会話Hの1件目'));
    const idxI1 = joined.indexOf(humanMarker('会話Iの1件目'));
    const idxH2 = joined.indexOf(humanMarker('会話Hの2件目'));
    const idxA = joined.indexOf(markerA);
    const idxB = joined.indexOf(markerB);
    const idxC = joined.indexOf(markerC);

    expect(idxH1, '会話Hの1件目 が単発ターンとして見つからない').toBeGreaterThan(-1);
    expect(idxI1, '会話Iの1件目 が単発ターンとして見つからない').toBeGreaterThan(-1);
    expect(idxH2, '会話Hの2件目 が単発ターンとして見つからない').toBeGreaterThan(-1);
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxC).toBeGreaterThan(-1);

    expect(idxH1).toBeLessThan(idxI1);
    expect(idxI1).toBeLessThan(idxH2);

    expect(idxH2).toBeLessThan(idxA);

    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);

    const turnOfH1 = inputs.findIndex((text) => text.includes(humanMarker('会話Hの1件目')));
    const turnOfH2 = inputs.findIndex((text) => text.includes(humanMarker('会話Hの2件目')));
    expect(turnOfH1).not.toBe(turnOfH2);

    await s.clone.stop();
  }, 20_000);

  it('endConversation の蒸留は、待ち行列にある非人間より先に読まれ、非人間は1件も消えず到着順も保たれる（Issue #43）', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    s.clone.post(managerMessage('evt-mgr-a', 'mgr-a', '非人間A'));
    s.clone.post(timerEvent('evt-timer-b', '非人間B'));
    const endPromise = s.clone.endConversation('conv-1');

    const markerA = managerMarker('mgr-a', '非人間A');
    const markerB = timerMarker('非人間B');

    await waitForAllDelivered(s, [DISTILL_MARKER, markerA, markerB]);
    await settle();
    await endPromise;

    const inputs = s.calls[0]?.inputs ?? [];
    const idxDistill = inputs.findIndex((text) => text.includes(DISTILL_MARKER));
    const idxA = inputs.findIndex((text) => text.includes(markerA));
    const idxB = inputs.findIndex((text) => text.includes(markerB));

    expect(idxDistill).toBeGreaterThan(-1);
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);

    expect(idxDistill).toBeLessThan(idxA);
    expect(idxDistill).toBeLessThan(idxB);

    expect(idxA).toBeLessThan(idxB);

    await s.clone.stop();
  }, 15_000);

  it('endConversation の蒸留は、待ち行列にある人間の発言を追い越さない', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    s.clone.post(humanMessage('待っている人間'));
    const endPromise = s.clone.endConversation('conv-1');

    const markerHuman = humanMarker('待っている人間');
    await waitForAllDelivered(s, [markerHuman, DISTILL_MARKER]);
    await settle();
    await endPromise;

    const inputs = s.calls[0]?.inputs ?? [];
    const idxHuman = inputs.findIndex((text) => text.includes(markerHuman));
    const idxDistill = inputs.findIndex((text) => text.includes(DISTILL_MARKER));

    expect(idxHuman).toBeGreaterThan(-1);
    expect(idxDistill).toBeGreaterThan(-1);

    expect(idxHuman).toBeLessThan(idxDistill);

    await s.clone.stop();
  }, 15_000);

  it('stop() の shutdown 蒸留は割り込む（非人間は1件も消えないまま、先に読まれる）', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    s.clone.post(managerMessage('evt-mgr-a', 'mgr-a', '非人間A'));
    s.clone.post(timerEvent('evt-timer-b', '非人間B'));

    const markerA = managerMarker('mgr-a', '非人間A');
    const markerB = timerMarker('非人間B');

    const stopPromise = s.clone.stop();
    await waitForAllDelivered(s, [markerA, markerB, DISTILL_MARKER]);
    await settle();
    await stopPromise;

    const inputs = s.calls[0]?.inputs ?? [];
    const idxA = inputs.findIndex((text) => text.includes(markerA));
    const idxB = inputs.findIndex((text) => text.includes(markerB));
    const idxDistill = inputs.findIndex((text) => text.includes(DISTILL_MARKER));

    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxDistill).toBeGreaterThan(-1);

    expect(idxDistill).toBeLessThan(idxA);
    expect(idxDistill).toBeLessThan(idxB);
  }, 15_000);

  it('stop() の shutdown 蒸留は、待ち行列にある非人間より先に読まれる（Issue #564）', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    s.clone.post(managerMessage('evt-mgr-a', 'mgr-a', '非人間A'));
    s.clone.post(timerEvent('evt-timer-b', '非人間B'));

    const markerA = managerMarker('mgr-a', '非人間A');
    const markerB = timerMarker('非人間B');

    await s.clone.stop();

    const inputs = s.calls[0]?.inputs ?? [];
    const idxA = inputs.findIndex((text) => text.includes(markerA));
    const idxB = inputs.findIndex((text) => text.includes(markerB));
    const idxDistill = inputs.findIndex((text) => text.includes(DISTILL_MARKER));

    expect(idxDistill).toBeGreaterThan(-1);
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);

    expect(idxDistill).toBeLessThan(idxA);
    expect(idxDistill).toBeLessThan(idxB);
  }, 15_000);

  it('stop() の shutdown 蒸留が割り込んでも、非人間は1件も消えず到着順も保たれる（Issue #564）', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    s.clone.post(managerMessage('evt-mgr-a', 'mgr-a', '非人間A'));
    s.clone.post(timerEvent('evt-timer-b', '非人間B'));

    const markerA = managerMarker('mgr-a', '非人間A');
    const markerB = timerMarker('非人間B');

    await s.clone.stop();

    const inputs = s.calls[0]?.inputs ?? [];
    const idxA = inputs.findIndex((text) => text.includes(markerA));
    const idxB = inputs.findIndex((text) => text.includes(markerB));
    const idxDistill = inputs.findIndex((text) => text.includes(DISTILL_MARKER));

    expect(idxDistill).toBeGreaterThan(-1);
    expect(idxDistill).toBeLessThan(idxA);

    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxA).toBeLessThan(idxB);

    expect((await s.stores.inbox.pending()).count).toBe(0);
  }, 15_000);

  it('待ち行列に人間の発言が先に居るとき、stop() の shutdown 蒸留はそれを追い越さない（Issue #564）', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    s.clone.post(humanMessage('待っている人間'));

    const markerHuman = humanMarker('待っている人間');

    await s.clone.stop();

    const inputs = s.calls[0]?.inputs ?? [];
    const idxHuman = inputs.findIndex((text) => text.includes(markerHuman));
    const idxDistill = inputs.findIndex((text) => text.includes(DISTILL_MARKER));

    expect(idxHuman).toBeGreaterThan(-1);
    expect(idxDistill).toBeGreaterThan(-1);

    expect(idxHuman).toBeLessThan(idxDistill);
  }, 15_000);

  it('humanPriority: false のときは endConversation の蒸留も割り込まない', async () => {
    const s = setupWithHumanPriority(false, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    s.clone.post(managerMessage('evt-mgr-a', 'mgr-a', '非人間A'));
    s.clone.post(timerEvent('evt-timer-b', '非人間B'));
    const endPromise = s.clone.endConversation('conv-1');

    const markerA = managerMarker('mgr-a', '非人間A');
    const markerB = timerMarker('非人間B');

    await waitForAllDelivered(s, [markerA, markerB, DISTILL_MARKER]);
    await settle();
    await endPromise;

    const inputs = s.calls[0]?.inputs ?? [];
    const idxA = inputs.findIndex((text) => text.includes(markerA));
    const idxB = inputs.findIndex((text) => text.includes(markerB));
    const idxDistill = inputs.findIndex((text) => text.includes(DISTILL_MARKER));

    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxDistill).toBeGreaterThan(-1);

    expect(idxA).toBeLessThan(idxDistill);
    expect(idxB).toBeLessThan(idxDistill);

    await s.clone.stop();
  }, 15_000);
});

describe('humanTurnText（添付だけの発言）', () => {
  const event = (text: string, supersedes?: string) => ({
    type: 'human_message' as const,
    id: 'e1',
    at: '2026-10-06T00:00:00.000Z',
    text,
    conversationId: 'c',
    ...(supersedes === undefined ? {} : { supersedes }),
  });

  it('本文が空なら通知行だけが本文になる（空行を前置きしない）', () => {
    expect(humanTurnText([event('')], new Map(), new Map([['e1', '[添付] id=a']]))).toBe(
      '[添付] id=a',
    );
    expect(humanTurnText([event('こんにちは')], new Map(), new Map([['e1', '[添付] id=a']]))).toBe(
      'こんにちは\n\n[添付] id=a',
    );
  });

  it('本文が空の編集は、区切りの後ろに何も置かない', () => {
    const text = humanTurnText([event('', 'old')], new Map([['e1', '元']]), new Map());
    expect(text.endsWith('編集前の本文:\n\n元')).toBe(true);
    expect(text).not.toContain('---');
  });
});
