import { describe, it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '../../../vitest.tmpdir.js';
import { ALWAYS_REDELIVER, CLONE_MODEL_ENV_KEY, createClone } from './clone.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { ChatStreamEvent } from './schema.js';
import { CLONE_ACTOR_ID } from './usage.js';
import { captureStderr, createMemoryStores, humanMessage } from './testing.js';
import {
  fakeSdk,
  setup,
  wireEvents,
  waitFor,
  waitForDone,
  isTerminal,
  waitForTerminal,
} from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

describe('クローンの消費が台帳に載る（誰が・どこで）', () => {
  function usage(model: string, costUsd: number) {
    return {
      [model]: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: costUsd,
      },
    };
  }

  async function firePreCompact(main: FakeCall): Promise<void> {
    const dir = await makeTempDir('alteroid-clone-usage-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
    const hook = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
    await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
      signal: new AbortController().signal,
    } as never);
  }

  it('本セッションの分が layer=clone / site=session として載る', async () => {
    const s = setup(undefined, createMemoryStores(), {
      modelUsage: () => usage('claude-fable-5', 0.5),
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const { rows } = await s.stores.usage.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.layer).toBe('clone');
    expect(rows[0]?.site).toBe('session');
    expect(rows[0]?.managerId).toBe(CLONE_ACTOR_ID);
    expect(CLONE_ACTOR_ID.startsWith('mgr-')).toBe(false);
    expect(rows[0]?.totals.costUsd).toBe(0.5);

    await s.clone.stop();
  });

  it('モデル id が opus でも層は clone のままである（モデル名で層を代用していない）', async () => {
    const s = setup(
      undefined,
      createMemoryStores(),
      { modelUsage: () => usage('claude-opus-5', 3) },
      { [CLONE_MODEL_ENV_KEY]: 'opus' },
    );

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const { rows } = await s.stores.usage.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.model).toBe('claude-opus-5');
    expect(rows[0]?.layer).toBe('clone');

    await s.clone.stop();
  });

  it('要約の蒸留の分が site=distill として別に載る（本体の分と混ざらない）', async () => {
    const s = setup(undefined, createMemoryStores(), {
      modelUsage: (index) =>
        index === 0 ? usage('claude-fable-5', 1) : usage('claude-fable-5', 0.25),
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    await firePreCompact(s.calls[0] as FakeCall);

    const { rows } = await s.stores.usage.aggregate({});
    expect(rows.map((r) => [r.site, r.totals.costUsd]).sort()).toEqual([
      ['distill', 0.25],
      ['session', 1],
    ]);
    expect(rows.every((r) => r.layer === 'clone')).toBe(true);
    expect(rows.every((r) => r.managerId === CLONE_ACTOR_ID)).toBe(true);

    await s.clone.stop();
  });

  it('蒸留を2回走らせても、高くついた回が目減りしない（基準を持たない）', async () => {
    const distillCosts = [0.05, 0.08];
    let distillIndex = 0;
    const s = setup(undefined, createMemoryStores(), {
      modelUsage: (index) => {
        if (index === 0) return undefined;
        const cost = distillCosts[distillIndex] ?? 0;
        distillIndex += 1;
        return usage('claude-fable-5', cost);
      },
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    const main = s.calls[0] as FakeCall;
    await firePreCompact(main);
    await firePreCompact(main);

    const { rows } = await s.stores.usage.aggregate({ site: 'distill' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totals.costUsd).toBeCloseTo(0.13, 10);

    await s.clone.stop();
  });

  it('失敗した result は台帳へ入らない（ゼロで基準を下げない）', async () => {
    // [sdk-verbatim SDKResultError.modelUsage]
    // crash/startup-error results may carry zeroed usage
    // ゼロを累積が 0 になったとして通さない: 基準が下がり、次に届いた本物の累積が丸ごと増分になるため
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      modelUsage: () => usage('claude-fable-5', 0),
    });

    s.clone.post(humanMessage('やあ'));
    await waitForTerminal(s.events);
    expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual(['error']);

    const aggregate = await s.stores.usage.aggregate({});
    expect(aggregate.rows).toEqual([]);
    expect(aggregate.since).toBeNull();

    await s.clone.stop();
  });

  it('失敗した result はターンの失敗として日誌に残る（無記録で消えない）', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
    });

    s.clone.post(humanMessage('やあ'));
    await waitForTerminal(s.events);
    expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual(['error']);

    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
      text: string;
    }[];
    expect(exchanges.some((entry) => entry.text.includes('人間との対話ターンが失敗した'))).toBe(
      true,
    );

    await s.clone.stop();
  });

  it('失敗した result で done を出さない（成功したことにしない）', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
    });

    s.clone.post(humanMessage('やあ'));
    await waitForTerminal(s.events);
    expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual(['error']);
    expect(s.events.some((event) => event.type === 'done')).toBe(false);

    await s.clone.stop();
  });

  it('失敗した result でもターンは畳まれ、受信箱が止まらない', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
    });

    s.clone.post(humanMessage('1回目'));
    await waitForTerminal(s.events);
    expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual(['error']);

    s.clone.post(humanMessage('2回目'));
    await waitFor(() => s.events.filter(isTerminal).length === 2, '終端が2つ揃う');
    expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual(['error', 'error']);

    await s.clone.stop();
  });

  it('支出上限で終わったとき、その理由が記録に残る', async () => {
    const spendLimitMessage = "You've hit your individual spend limit for this account.";
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    s.clone.post(humanMessage('やあ'));
    await waitForTerminal(s.events);

    const errorEvent = s.events.find(
      (event): event is Extract<ChatStreamEvent, { type: 'error' }> => event.type === 'error',
    );
    expect(errorEvent?.message).toContain(spendLimitMessage);

    await s.clone.stop();
  });

  it('台帳へ積めなくてもターンは止まらない（黙って消さないが、殺しもしない）', async () => {
    const stores = createMemoryStores();
    stores.usage.record = () => Promise.reject(new Error('台帳が書けない'));

    const s = setup(undefined, stores, { modelUsage: () => usage('claude-fable-5', 1) });

    const stderr = await captureStderr(async () => {
      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);
      // `stop()` も捕獲の内側で呼ぶ: 外に置くと、片付けの蒸留ターンの台帳書き込みの失敗が生の stderr へ1行漏れるため
      await s.clone.stop();
    });

    expect(stderr.join('')).toContain('利用状況の台帳');

    const ledgerLines = stderr.filter((line) => line.includes('利用状況の台帳'));
    expect(ledgerLines).toHaveLength(2);
  });

  describe('認証トークンの帰属', () => {
    function cloneWithIdentity(
      identity: () => { tokenId: string; generation: number } | undefined,
    ) {
      const stores = createMemoryStores();
      let nth = 0;
      const { fn } = fakeSdk(undefined, {
        modelUsage: () => usage('claude-fable-5', ++nth * 0.5),
      });
      const clone = createClone({
        redeliveryGate: ALWAYS_REDELIVER,
        stores,
        queryFn: fn,
        env: {},
        tokenIdentity: identity,
        runners: createRunnerRegistry([
          createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
        ]),
      });
      const { events } = wireEvents(clone, 'conv-1');
      return { clone, stores, events };
    }

    it('現役の指名が在れば、その tokenId が行に載る', async () => {
      const s = cloneWithIdentity(() => ({ tokenId: 'tok-a', generation: 3 }));

      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      const { rows, tokensSince } = await s.stores.usage.aggregate({});
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tokenId).toBe('tok-a');
      expect(tokensSince).not.toBeNull();

      await s.clone.stop();
    });

    it('現役の指名が無ければ帰属を渡さない（プールが空の器で軸が始まらない）', async () => {
      const s = cloneWithIdentity(() => undefined);

      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      const { rows, since, tokensSince, beforeTokens } = await s.stores.usage.aggregate({});
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tokenId).toBeUndefined();
      expect(since).not.toBeNull();
      expect(tokensSince).toBeNull();
      expect(beforeTokens).toBe(true);

      await s.clone.stop();
    });

    it('帰属は「セッションが起きた瞬間の身元」である（record のたびに読み直さない）', async () => {
      let current = { tokenId: 'tok-a', generation: 1 };
      const s = cloneWithIdentity(() => current);

      s.clone.post(humanMessage('1回目'));
      await waitForDone(s.events);

      current = { tokenId: 'tok-b', generation: 2 };
      s.clone.post(humanMessage('2回目'));
      await waitFor(
        async () => (await s.stores.usage.aggregate({})).rows[0]?.totals.costUsd === 1,
        '2ターン目が台帳へ載ること',
      );

      const { rows } = await s.stores.usage.aggregate({});
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tokenId).toBe('tok-a');
      expect(rows[0]?.totals.costUsd).toBe(1);

      await s.clone.stop();
    });
  });
});
