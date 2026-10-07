import { describe, it, expect } from 'vitest';
import type { Stores } from './store.js';
import {
  captureStderr,
  createMemoryStores,
  failingInboxPut,
  flakyInboxPut,
  flakyInboxRemove,
  humanMessage,
} from './testing.js';
import {
  setup,
  wireEvents,
  waitFor,
  waitForDone,
  memoryCardOutlineLines,
} from './clone-test-harness.js';
import type { FakeCall, Setup } from './clone-test-harness.js';

describe('クローン — 壊れ方の回帰', () => {
  it('応答中に会話終了が来てもループが止まらない（ターンの起動口は受信箱1つ）', async () => {
    const s = setup(() => 'A の返事', createMemoryStores(), { delayMs: 120 });

    s.clone.post(humanMessage('MSG-A'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await s.clone.endConversation('conv-1');

    expect(s.events.some((event) => event.type === 'done')).toBe(true);

    const { events } = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('MSG-B', 'conv-2'));
    await waitForDone(events);

    await s.clone.stop();
  }, 10_000);

  it('resume に失敗したら腐ったセッション id を捨てる（人間の手作業を要求しない）', async () => {
    const stores = createMemoryStores();
    await stores.sessions.setCloneSessionId('stale-session-id');

    const s = setup(undefined, stores, { failWith: 'No conversation found with session ID' });
    s.clone.post(humanMessage('やあ'));

    await waitFor(() => s.events.some((event) => event.type === 'error'), 'error イベントが届く');
    await waitFor(
      async () => (await stores.sessions.getCloneSessionId()) === null,
      'session id が消える',
    );
    expect(await stores.sessions.getCloneSessionId()).toBeNull();

    await s.clone.stop();
  });

  it('走行中に人間が記憶を書き換えたら、次のターンで載せ直す（受け入れ基準3）', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('values', '# 価値観\n\nOLD-VALUE\n');
    const before = await memoryCardOutlineLines(stores, 'values');

    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.write('values', '# 価値観\n\nNEW-VALUE\n');
    const after = await memoryCardOutlineLines(stores, 'values');

    const { events } = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);

    const second = (s.calls[0] as FakeCall).inputs[1] ?? '';
    for (const line of after) expect(second).toContain(line);
    for (const line of before) expect(second).not.toContain(line);
    expect(second).toContain('2回目');

    await s.clone.stop();
  });

  it('内部ターンの応答も日誌に残る（見えない層を作らない）', async () => {
    const s = setup(() => '記憶を更新しました');

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');

    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      role: string;
    }[];
    expect(exchanges.some((entry) => entry.with === 'self' && entry.role === 'outbound')).toBe(
      true,
    );

    await s.clone.stop();
  });

  it('承認への回答は日誌からも追える', async () => {
    const s = setup();
    await s.stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: new Date().toISOString(),
      question: 'これを送ってよいか',
    });

    await s.clone.answerApproval('ap-1', 'よい');

    const escalations = (await s.stores.journal.list({ types: ['escalation'] })) as {
      answer?: string;
    }[];
    expect(escalations.some((entry) => entry.answer === 'よい')).toBe(true);

    await s.clone.stop();
  });
});

describe('クローン — commitment_close と inbox.remove の消し込み（issue #256）', () => {
  it('inbox.remove が一時的に失敗しても、拾い直して実際に消える', async () => {
    const base = createMemoryStores();
    const { stores, calls } = flakyInboxRemove(base, 2, '瞬断');
    const s = setup(() => 'わかった', stores);

    const event = humanMessage('やあ');
    s.clone.post(event);
    await waitForDone(s.events);

    await waitFor(async () => {
      const pending = await stores.inbox.claimPending();
      return !pending.some((p) => p.event.id === event.id);
    }, '拾い直した末に inbox から消える');
    expect(calls.length).toBe(3);

    await s.clone.stop();
  }, 10_000);

  it('拾い直しても消せなければ、跡を残したうえで消さずに次の起動へ委ねる', async () => {
    const base = createMemoryStores();
    const { stores, calls } = flakyInboxRemove(base, 10, '恒久的な障害');
    const s = setup(() => 'わかった', stores);

    const event = humanMessage('やあ');
    const lines = await captureStderr(async () => {
      s.clone.post(event);
      await waitForDone(s.events);
      await new Promise((resolve) => setTimeout(resolve, 1200));
    });

    expect(lines.some((line) => line.includes('未読の消し込み'))).toBe(true);
    const pending = await stores.inbox.claimPending();
    expect(pending.some((p) => p.event.id === event.id)).toBe(true);
    expect(calls.length).toBe(3);

    await s.clone.stop();
  }, 10_000);
});

describe('クローン — #remember の inbox.put 拾い直し（issue #1085）', () => {
  it('put() が一過性に失敗しても、拾い直して DB に書かれる', async () => {
    const base = createMemoryStores();
    const { stores, calls } = flakyInboxPut(base, 2, '瞬断');
    const s = setup(() => 'わかった', stores, { delayMs: 1500 });

    const event = humanMessage('やあ');
    s.clone.post(event);

    await waitFor(async () => {
      const pending = await stores.inbox.claimPending();
      return pending.some((p) => p.event.id === event.id);
    }, '拾い直した末に DB へ書かれる');
    expect(calls.length).toBe(3);

    await waitForDone(s.events);
    await s.clone.stop();
  }, 10_000);

  it('拾い直しても書けなければ、post は落ちずに配達は続き、跡は「落とした」と名乗らない', async () => {
    const stores = failingInboxPut(createMemoryStores(), '恒久的な障害');
    const s = setup(() => 'わかった', stores);

    const event = humanMessage('やあ');
    const lines = await captureStderr(async () => {
      s.clone.post(event);
      await waitForDone(s.events);
      await new Promise((resolve) => setTimeout(resolve, 1200));
    });

    const trace = lines.filter((line) => line.includes('未読の合図をストアへ書けませんでした'));
    expect(trace).toHaveLength(1);
    expect(trace[0]).toContain('恒久的な障害');
    expect(trace[0]).not.toContain('落とし');
    expect(trace[0]).toContain('失ってはいない');
    expect(trace[0]).toContain('器が入れ替われば');

    await s.clone.stop();
  }, 10_000);
});

describe('クローン — 記憶を二重に載せない', () => {
  const UNCHANGED_BODY = 'HABIT-BODY-MUST-NOT-BE-RESENT';

  async function twoDocumentStores(): Promise<Stores> {
    const stores = createMemoryStores();
    await stores.persona.write('values', '# 価値観\n\nOLD-VALUE\n');
    await stores.persona.write('habits', `# 習慣\n\n${UNCHANGED_BODY}\n`);
    return stores;
  }

  async function secondTurn(s: Setup): Promise<string> {
    const { events } = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);
    return (s.calls[0] as FakeCall).inputs[1] ?? '';
  }

  it('1つの文書を直しても、変わっていない文書の本文は載せ直さない', async () => {
    const stores = await twoDocumentStores();
    const habitsCard = await memoryCardOutlineLines(stores, 'habits');
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.write('values', '# 価値観\n\nNEW-VALUE\n');
    const valuesCard = await memoryCardOutlineLines(stores, 'values');
    const second = await secondTurn(s);

    // 見出しの括弧の中は見ない: カード全体と変わった範囲だけのどちらへ倒れるかは量で決まり、固定すると分量の都合で歯が落ちるため
    expect(second).toContain('<!-- memory: values.md');
    for (const line of valuesCard) expect(second).toContain(line);
    for (const line of habitsCard) expect(second).not.toContain(line);
    expect(second).not.toContain(UNCHANGED_BODY);
    expect(second).not.toContain('<!-- memory: habits.md');
    const systemPrompt = String((s.calls[0] as FakeCall).options.systemPrompt);
    for (const line of habitsCard) expect(systemPrompt).toContain(line);
    expect(systemPrompt).toContain('<!-- memory: habits.md');

    await s.clone.stop();
  });

  it('記憶が何も変わっていなければ、ターンの本文に何も足さない', async () => {
    const stores = await twoDocumentStores();
    const valuesCard = await memoryCardOutlineLines(stores, 'values');
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    const second = await secondTurn(s);

    expect(second).not.toContain('記憶が更新された');
    expect(second).not.toContain('<!-- memory:');
    expect(second).not.toContain('OLD-VALUE');
    for (const line of valuesCard) expect(second).not.toContain(line);
    for (const line of valuesCard) {
      expect(String((s.calls[0] as FakeCall).options.systemPrompt)).toContain(line);
    }
    expect(second.endsWith('2回目')).toBe(true);

    await s.clone.stop();
  });

  it('セッションを組み立てた最初のターンでは、焼き込んだ記憶を載せ直さない', async () => {
    const stores = await twoDocumentStores();
    const valuesCard = await memoryCardOutlineLines(stores, 'values');
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    const first = (s.calls[0] as FakeCall).inputs[0] ?? '';
    expect(first).not.toContain('記憶が更新された');
    expect(first).not.toContain('OLD-VALUE');
    expect(first).not.toContain(UNCHANGED_BODY);
    for (const line of valuesCard) expect(first).not.toContain(line);
    const systemPrompt = String((s.calls[0] as FakeCall).options.systemPrompt);
    for (const line of valuesCard) expect(systemPrompt).toContain(line);

    await s.clone.stop();
  });

  it('記憶を消したら、消えたことを名前で伝える（本文を載せ直さない）', async () => {
    const stores = await twoDocumentStores();
    const habitsCard = await memoryCardOutlineLines(stores, 'habits');
    const valuesCard = await memoryCardOutlineLines(stores, 'values');
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.remove('habits');
    const second = await secondTurn(s);

    expect(second).toContain('削除された記憶: habits.md');
    expect(second).not.toContain(UNCHANGED_BODY);
    for (const line of habitsCard) expect(second).not.toContain(line);
    expect(second).not.toContain('OLD-VALUE');
    for (const line of valuesCard) expect(second).not.toContain(line);
    const systemPrompt = String((s.calls[0] as FakeCall).options.systemPrompt);
    for (const line of [...habitsCard, ...valuesCard]) expect(systemPrompt).toContain(line);

    await s.clone.stop();
  });

  it('記憶が全部消えたら、空になったと伝える', async () => {
    const stores = await twoDocumentStores();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.remove('values');
    await stores.persona.remove('habits');
    const second = await secondTurn(s);

    expect(second).toContain('（記憶は空になった）');
    expect(second).toContain('削除された記憶:');
    expect(second).toContain('values.md');
    expect(second).toContain('habits.md');

    await s.clone.stop();
  });

  it('大量の記憶を一度に消しても、削除された記憶の列挙は抜粋の合図で締まる', async () => {
    const stores = createMemoryStores();
    const slugs = Array.from({ length: 60 }, (_, index) => `doc-${index}`);
    for (const slug of slugs) {
      await stores.persona.write(slug, `# ${slug}\n\nbody\n`);
    }
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    for (const slug of slugs) {
      await stores.persona.remove(slug);
    }
    const second = await secondTurn(s);

    const line = second.split('\n').find((entry) => entry.startsWith('削除された記憶:'));
    expect(line).toBeDefined();
    expect(line!.length).toBeLessThan(600);
    expect(line).toMatch(/省略/);

    await s.clone.stop();
  });

  it('resume した最初のターンでは、正本がシステムプロンプト側だと断る（全文を載せ直さない）', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('values', '# 価値観\n\nV1-OLD\n');

    const first = setup(undefined, stores);
    first.clone.post(humanMessage('1回目'));
    await waitForDone(first.events);
    await stores.persona.write('values', '# 価値観\n\nV2-MID\n');
    const v2Card = await memoryCardOutlineLines(stores, 'values');
    const { events } = wireEvents(first.clone, 'conv-2');
    first.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);
    for (const line of v2Card) expect((first.calls[0] as FakeCall).inputs[1] ?? '').toContain(line);
    await first.clone.stop();

    await stores.persona.write('values', '# 価値観\n\nV3-NEWEST\n');
    const v3Card = await memoryCardOutlineLines(stores, 'values');

    const second = setup(undefined, stores);
    second.clone.post(humanMessage('また来た'));
    await waitForDone(second.events);

    const call = second.calls[0] as FakeCall;
    expect(call.options.resume).toBe('sess-fake');
    const input = call.inputs[0] ?? '';
    expect(input).toContain('現在の記憶');
    expect(input).toContain('システムプロンプト');
    expect(input).not.toContain('V3-NEWEST');
    for (const line of v3Card) expect(input).not.toContain(line);
    expect(input).not.toContain('<!-- memory: values.md');
    const systemPrompt = String(call.options.systemPrompt);
    for (const line of v3Card) expect(systemPrompt).toContain(line);
    for (const line of v2Card) expect(systemPrompt).not.toContain(line);

    await second.clone.stop();
  });

  it('resume の断りは最初のターンだけで、以降のターンには付かない', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('values', '# 価値観\n\nV1\n');

    const first = setup(undefined, stores);
    first.clone.post(humanMessage('1回目'));
    await waitForDone(first.events);
    await first.clone.stop();

    const second = setup(undefined, stores);
    second.clone.post(humanMessage('また来た'));
    await waitForDone(second.events);
    expect((second.calls[0] as FakeCall).inputs[0] ?? '').toContain('resume');

    const third = await secondTurn(second);
    expect(third).not.toContain('resume');

    await second.clone.stop();
  });

  it('新規に開いたセッションでは resume の断りを出さない（起きていないことを言わない）', async () => {
    const stores = await twoDocumentStores();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    expect((s.calls[0] as FakeCall).options.resume).toBeUndefined();
    expect((s.calls[0] as FakeCall).inputs[0] ?? '').not.toContain('resume');

    await s.clone.stop();
  });

  it('内部ターン（蒸留）にも同じ絞り込みが効く（起点ごとに違う載せ方をしない）', async () => {
    const stores = await twoDocumentStores();
    const habitsCard = await memoryCardOutlineLines(stores, 'habits');
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.write('values', '# 価値観\n\nNEW-VALUE\n');
    const valuesCard = await memoryCardOutlineLines(stores, 'values');
    await s.clone.endConversation('conv-1');

    const distill = (s.calls[0] as FakeCall).inputs[1] ?? '';
    expect(distill).toContain('記憶へ移すべきものがあるか確認せよ');
    for (const line of valuesCard) expect(distill).toContain(line);
    for (const line of habitsCard) expect(distill).not.toContain(line);
    expect(distill).not.toContain(UNCHANGED_BODY);

    await s.clone.stop();
  });

  it('⭐ 親が差分に含まれないとき、載せ直しは「見つからない」と言わない', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('core', '# core\n\n前提の本文\n');
    await stores.persona.write(
      'child',
      '---\ntype: fact\ndescription: 子の要旨\nparent: core\n---\n# child\n\n子の本文\n',
    );
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.write(
      'child',
      '---\ntype: fact\ndescription: 子の要旨（更新）\nparent: core\n---\n# child\n\n子の本文\n',
    );
    const second = await secondTurn(s);

    expect(second).toContain('記憶が更新された');
    expect(second).not.toContain('が見つからない');
    expect(second).toContain('親 core は在るが、ここに載せた分には含まれない');
    expect(second).not.toContain('前提の本文');
    expect(second).not.toContain('<!-- memory: core.md -->');

    await s.clone.stop();
  });
});
