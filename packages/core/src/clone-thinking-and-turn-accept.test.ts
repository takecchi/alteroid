import { describe, it, expect } from 'vitest';
import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { Stores } from './store.js';
import {
  captureStderr,
  createMemoryStores,
  failingInboxPut,
  failingJournalAppend,
  humanMessage,
} from './testing.js';
import {
  fakeSdk,
  setup,
  wireEvents,
  waitFor,
  waitForExpect,
  waitForDone,
} from './clone-test-harness.js';
import type { FakeCall, Setup } from './clone-test-harness.js';

describe('クローン — 考えている合図（thinking）', () => {
  // 1本目の入力にだけ台本を使い、以降は汎用の応答に落とす: stop() が蒸留の内部ターンをもう1本流し、無応答のままだと result が来ず stop() が返らないため
  function fakeScriptedSdk(turns: SDKMessage[][]) {
    const calls: FakeCall[] = [];
    let turnIndex = 0;

    const fn = ((params: { prompt: unknown; options?: Options }) => {
      const call: FakeCall = {
        options: params.options ?? {},
        inputs: [],
        kind: typeof params.prompt === 'string' ? 'sideQuery' : 'session',
      };
      calls.push(call);

      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-fake',
          uuid: 'uuid-init',
        } as unknown as SDKMessage;

        for await (const message of params.prompt as AsyncIterable<{
          message: { content: unknown };
        }>) {
          call.inputs.push(String(message.message.content));
          const script = turns[turnIndex] ?? [assistantText('わかった'), resultMessage('わかった')];
          turnIndex += 1;
          yield* script;
        }
      }

      const generator = generate();
      return Object.assign(generator, {
        close: () => undefined,
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;

    return { fn, calls };
  }

  function setupScripted(turns: SDKMessage[][]): Setup {
    const { fn, calls } = fakeScriptedSdk(turns);
    const stores = createMemoryStores();
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events, waitForEvents } = wireEvents(clone, 'conv-1');
    return { clone, stores, calls, events, waitForEvents };
  }

  function assistantText(text: string): SDKMessage {
    return {
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: 'sess-fake',
      uuid: 'uuid-assistant-text',
    } as unknown as SDKMessage;
  }

  function assistantToolUse(name: string): SDKMessage {
    return {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu-1', name, input: {} }] },
      parent_tool_use_id: null,
      session_id: 'sess-fake',
      uuid: 'uuid-assistant-tool',
    } as unknown as SDKMessage;
  }

  function userToolResult(): SDKMessage {
    return {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }],
      },
      parent_tool_use_id: 'tu-1',
      session_id: 'sess-fake',
      uuid: 'uuid-user-tool-result',
    } as unknown as SDKMessage;
  }

  function userEcho(text: string): SDKMessage {
    return {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: 'sess-fake',
      uuid: 'uuid-user-echo',
    } as unknown as SDKMessage;
  }

  function resultMessage(text: string): SDKMessage {
    return {
      type: 'result',
      subtype: 'success',
      result: text,
      session_id: 'sess-fake',
      uuid: 'uuid-result',
    } as unknown as SDKMessage;
  }

  it('人間の発言に thinking が付き、text より先に届く', async () => {
    const s = setupScripted([[assistantText('こんにちは'), resultMessage('こんにちは')]]);

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const thinkingIndex = s.events.findIndex((event) => event.type === 'thinking');
    const textIndex = s.events.findIndex((event) => event.type === 'text');
    expect(thinkingIndex).toBeGreaterThanOrEqual(0);
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(thinkingIndex).toBeLessThan(textIndex);

    await s.clone.stop();
  });

  it('道具の結果が返ったら thinking を送り直す（tool の合図で止まらない）', async () => {
    const s = setupScripted([
      [
        assistantToolUse('shell'),
        userToolResult(),
        assistantText('できた'),
        resultMessage('できた'),
      ],
    ]);

    s.clone.post(humanMessage('やって'));
    await waitForDone(s.events);

    const toolIndex = s.events.findIndex((event) => event.type === 'tool');
    expect(toolIndex).toBeGreaterThanOrEqual(0);

    const after = s.events.slice(toolIndex + 1);
    const thinkingAfterToolIndex = after.findIndex((event) => event.type === 'thinking');
    const textAfterToolIndex = after.findIndex((event) => event.type === 'text');
    expect(thinkingAfterToolIndex).toBeGreaterThanOrEqual(0);
    expect(thinkingAfterToolIndex).toBeLessThan(textAfterToolIndex);

    await s.clone.stop();
  });

  it('tool_result を含まない user メッセージでは thinking を送らない', async () => {
    const s = setupScripted([
      [userEcho('やあ'), assistantText('こんにちは'), resultMessage('こんにちは')],
    ]);

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const thinkingCount = s.events.filter((event) => event.type === 'thinking').length;
    expect(thinkingCount).toBe(1);

    await s.clone.stop();
  });

  it('日誌が書けなくても会話は続き、落としたことが stderr に残る（本文は出さない）', async () => {
    const stores = failingJournalAppend(createMemoryStores(), 'storage is closed');
    const s = setup(() => 'こんにちは', stores);

    const lines = await captureStderr(async () => {
      s.clone.post(humanMessage('鍵は ghp_000000000000000000000000000000000000 だ'));
      await waitForDone(s.events);
      await s.clone.stop();
    });

    const shown = s.events
      .filter((event) => event.type === 'text')
      .map((event) => event.text)
      .join('');
    expect(shown).toBe('こんにちは');

    const dropped = lines.filter((line) => line.includes('日誌を記録できませんでした')).join('');
    expect(dropped).not.toBe('');
    expect(dropped).toContain('storage is closed');
    expect(dropped).toContain('exchange');
    expect(dropped).not.toContain('ghp_');
  });

  it('止まった後に届いた合図は器へ残し、何が来たかが stderr に残る（本文は出さない）', async () => {
    const s = setup();
    await s.clone.stop();

    const lines = await captureStderr(() => {
      s.clone.post(humanMessage('鍵は ghp_000000000000000000000000000000000000 だ'));
      s.clone.post({
        type: 'manager_message',
        id: 'evt-report',
        at: new Date().toISOString(),
        managerId: 'mgr-1',
        kind: 'report',
        text: 'PR #99 をマージした。鍵は ghp_000000000000000000000000000000000000',
      });
    });

    const dropped = lines.filter((line) => line.includes('このプロセスでは処理しませんでした'));
    expect(dropped).toHaveLength(2);
    expect(dropped[0]).toContain('human_message');
    expect(dropped[1]).toContain('manager_message managerId=mgr-1 kind=report');
    for (const line of dropped) {
      expect(line).not.toContain('ghp_');
      expect(line).toMatch(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/u);
      expect(line.endsWith('\n')).toBe(true);
      expect(line.trimEnd()).not.toContain('\n');
    }

    await waitFor(async () => (await s.stores.inbox.claimPending()).length === 2, '未読の書き出し');

    const open = (await s.stores.commitments.list()).entries;
    expect(open.map((entry) => entry.origin)).toEqual(['human', 'manager']);
    expect(open[0]?.body).toContain('ghp_');
  });

  it('片付けの窓（止まった後）で書き込みが尽きたら、跡は「失われた」と名乗る（issue #1144）', async () => {
    const stores = failingInboxPut(createMemoryStores(), '器が閉じている');
    const s = setup(undefined, stores);
    await s.clone.stop();

    const secret = 'GH_TOKEN=ghp_000000000000000000000000000000000000';
    const lines = await captureStderr(async () => {
      s.clone.post(humanMessage(secret));
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    const trace = lines.filter((line) => line.includes('未読の合図をストアへ書けませんでした'));
    expect(trace).toHaveLength(1);
    expect(trace[0]).toContain('器が閉じている');
    expect(trace[0]).not.toContain('ただし失ってはいない');
    expect(trace[0]).not.toContain('メモリの待ち行列には残って');
    expect(trace[0]).toContain('この合図は失われた');
    expect(lines.join('')).not.toContain(secret);
    expect(lines.join('')).not.toContain('ghp_');
    expect(trace[0]).toContain(`chars=${secret.length}`);
  }, 10_000);
});

describe('クローン — 発言を受理した瞬間の記録と合図', () => {
  // 時間で近似しない: delayMs だと遅延の長さと poll の待ち時間の綱引きになり、速い器で通って遅い器で落ちるため
  function fakeGatedSdk() {
    const calls: FakeCall[] = [];
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let held = true;

    const fn = ((params: { prompt: unknown; options?: Options }) => {
      const call: FakeCall = {
        options: params.options ?? {},
        inputs: [],
        kind: typeof params.prompt === 'string' ? 'sideQuery' : 'session',
      };
      calls.push(call);

      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-fake',
          uuid: 'uuid-init',
        } as unknown as SDKMessage;

        for await (const message of params.prompt as AsyncIterable<{
          message: { content: unknown };
        }>) {
          call.inputs.push(String(message.message.content));
          if (held) await gate;
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'ok' }] },
            parent_tool_use_id: null,
            session_id: 'sess-fake',
            uuid: 'uuid-assistant',
          } as unknown as SDKMessage;
          yield {
            type: 'result',
            subtype: 'success',
            result: 'ok',
            session_id: 'sess-fake',
            uuid: 'uuid-result',
          } as unknown as SDKMessage;
        }
      }

      const generator = generate();
      return Object.assign(generator, {
        close: () => undefined,
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;

    return {
      fn,
      calls,
      release: () => {
        held = false;
        open();
      },
    };
  }

  interface Gated {
    clone: CloneHost;
    stores: Stores;
    calls: FakeCall[];
    release: () => void;
  }

  function setupGated(stores: Stores = createMemoryStores()): Gated {
    const { fn, calls, release } = fakeGatedSdk();
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    return { clone, stores, calls, release };
  }

  async function occupy(gated: Gated): Promise<void> {
    gated.clone.post({
      type: 'self_initiative',
      id: 'evt-busy',
      at: new Date().toISOString(),
      reason: '先客のターン',
    });
    await waitFor(() => (gated.calls[0]?.inputs ?? []).length === 1, '1本目の入力');
    expect((gated.calls[0]?.inputs ?? []).length).toBe(1);
  }

  function delayFirstJournalAppend(stores: Stores, delayMs: number): Stores {
    let first = true;
    return {
      ...stores,
      journal: {
        ...stores.journal,
        async append(entry) {
          if (first) {
            first = false;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          return stores.journal.append(entry);
        },
      },
    };
  }

  async function inboundTexts(stores: Stores): Promise<string[]> {
    const entries = (await stores.journal.list({ types: ['exchange'] })) as {
      role: string;
      text: string;
    }[];
    return entries.filter((entry) => entry.role === 'inbound').map((entry) => entry.text);
  }

  it('順番待ちのあいだに日誌へ載る（ターンが回るのを待たない）', async () => {
    const gated = setupGated();
    await occupy(gated);

    gated.clone.post(humanMessage('MSG-WAITING', 'conv-2'));

    await waitFor(
      async () => (await inboundTexts(gated.stores)).includes('MSG-WAITING'),
      'MSG-WAITING が台帳へ届く',
    );
    expect(await inboundTexts(gated.stores)).toContain('MSG-WAITING');
    expect(gated.calls[0]?.inputs).toHaveLength(1);

    gated.release();
    await gated.clone.stop();
  }, 10_000);

  it('日誌には一度だけ載る（受理の瞬間とターンの入口で二重に書かない）', async () => {
    const s = setup(() => 'こんにちは');

    s.clone.post(humanMessage('MSG-ONCE'));
    await waitForDone(s.events);

    expect((await inboundTexts(s.stores)).filter((text) => text === 'MSG-ONCE')).toHaveLength(1);

    await s.clone.stop();
  });

  it('`queued` は受理したその同期の中で届く（往復を待たない）', async () => {
    const s = setup();

    s.clone.post(humanMessage('やあ'));
    expect(s.events).toEqual([{ type: 'queued' }]);

    await waitForDone(s.events);
    await s.clone.stop();
  });

  it('順番待ちのあいだ `thinking` は来ない（2つの状態を1つの語に潰していない）', async () => {
    const gated = setupGated();
    const { events } = wireEvents(gated.clone, 'conv-2');
    await occupy(gated);

    gated.clone.post(humanMessage('MSG-QUEUED', 'conv-2'));

    expect(events.map((event) => event.type)).toEqual(['queued']);

    gated.release();
    await gated.clone.stop();
  }, 10_000);

  it('順番が来たら `thinking` が続く（`queued` を置き換えるのではなく後に来る）', async () => {
    const s = setup(() => 'こんにちは');

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const types = s.events.map((event) => event.type);
    expect(types.indexOf('queued')).toBe(0);
    expect(types.indexOf('thinking')).toBeGreaterThan(0);

    await s.clone.stop();
  });

  it('追記が遅くても、発言は応答より先に日誌へ載る', async () => {
    const s = setup(() => 'こんにちは', delayFirstJournalAppend(createMemoryStores(), 200));

    s.clone.post(humanMessage('MSG-ORDER'));
    await waitForDone(s.events);

    // with: ['human'] で絞る: #commit 段1 が足す exchange with=self の行と混ざると、人間との往復の着順が読み取れなくなるため
    const roles = (
      (await s.stores.journal.list({ types: ['exchange'], with: ['human'] })) as {
        role: string;
      }[]
    ).map((entry) => entry.role);
    expect(roles).toEqual(['outbound', 'inbound']);

    await s.clone.stop();
  }, 10_000);

  it('2発言が続けて届いても、日誌には受け取った順で載る', async () => {
    const s = setup(() => 'こんにちは', delayFirstJournalAppend(createMemoryStores(), 200));

    s.clone.post(humanMessage('MSG-FIRST', 'conv-1'));
    s.clone.post(humanMessage('MSG-SECOND', 'conv-1'));

    await waitForExpect(
      async () => expect(await inboundTexts(s.stores)).toEqual(['MSG-SECOND', 'MSG-FIRST']),
      '受信テキストが並び替わって2件揃う',
    );

    await s.clone.stop();
  }, 10_000);

  it('日誌へ書けなくても応答は返る（記録できないことで応答を止めない）', async () => {
    const stores = failingJournalAppend(createMemoryStores(), '器が閉じている');

    await captureStderr(async () => {
      const s = setup(() => 'こんにちは', stores);
      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);
      expect(s.events.some((event) => event.type === 'done')).toBe(true);
      await s.clone.stop();
    });
  });

  it('ターンが失敗しても、発言そのものは日誌に残る（#59 の保証を落とさない）', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, { failWith: 'セッションを起こせない' });

    s.clone.post(humanMessage('MSG-FAILED', 'conv-9'));

    await waitFor(
      async () => (await inboundTexts(stores)).includes('MSG-FAILED'),
      'MSG-FAILED が台帳へ届く',
    );
    expect(await inboundTexts(stores)).toContain('MSG-FAILED');

    await s.clone.stop();
  });

  it('人間以外の起点は起点ごとの型のまま（受理の瞬間へ寄せていない）', async () => {
    const stores = createMemoryStores();
    const s = setup(() => '見た', stores);

    s.clone.post({
      type: 'manager_message',
      id: 'evt-report',
      at: new Date().toISOString(),
      managerId: 'mgr-1',
      kind: 'report',
      text: 'MSG-REPORT',
    });

    await waitForExpect(
      async () =>
        expect(
          (await stores.journal.list({ types: ['exchange'] })).filter(
            (entry) => entry.type === 'exchange' && entry.with === 'manager',
          ).length,
        ).toBe(1),
      'manager 向け exchange が1件、日誌に積まれる',
    );

    await s.clone.stop();
  });
});
