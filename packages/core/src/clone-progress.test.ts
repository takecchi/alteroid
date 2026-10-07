import { describe, it, expect } from 'vitest';
import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { CloneProgress } from './clone-progress.js';
import { fakeSdk, wireEvents, waitForDone } from './clone-test-harness.js';
import type { FakeCall, Setup } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { ChatStreamEvent } from './schema.js';
import { createMemoryStores, humanMessage } from './testing.js';

describe('CloneProgress — 進行中のターンの途中経過の記録（#2652）', () => {
  it('出来事を順に覚え、隣り合う text は1つにまとめる', () => {
    const progress = new CloneProgress();
    progress.record('c', { type: 'queued' });
    progress.record('c', { type: 'thinking' });
    progress.record('c', { type: 'text', text: 'こん' });
    progress.record('c', { type: 'text', text: 'にちは' });
    progress.record('c', { type: 'tool', tool: 'shell' });
    progress.record('c', { type: 'text', text: '続き' });

    expect(progress.snapshot('c')).toEqual([
      { type: 'queued' },
      { type: 'thinking' },
      { type: 'text', text: 'こんにちは' },
      { type: 'tool', tool: 'shell' },
      { type: 'text', text: '続き' },
    ]);
  });

  it('done / error で捨てる（終端そのものは覚えない）。他の会話には触らない', () => {
    const progress = new CloneProgress();
    progress.record('a', { type: 'thinking' });
    progress.record('b', { type: 'thinking' });
    progress.record('a', { type: 'done' });
    expect(progress.snapshot('a')).toBeNull();
    expect(progress.snapshot('b')).toEqual([{ type: 'thinking' }]);

    progress.record('b', { type: 'error', message: '失敗', kind: 'other' });
    expect(progress.snapshot('b')).toBeNull();
    expect(progress.size).toBe(0);
  });

  it('写しは記録と切り離されている（写しを変えても、あとから足しても互いに動かない）', () => {
    const progress = new CloneProgress();
    progress.record('c', { type: 'text', text: 'a' });
    const first = progress.snapshot('c')!;
    progress.record('c', { type: 'text', text: 'b' });
    expect(first).toEqual([{ type: 'text', text: 'a' }]);
    first.push({ type: 'thinking' });
    expect(progress.snapshot('c')).toEqual([{ type: 'text', text: 'ab' }]);
  });

  it('呼び出し側が渡した event を書き換えない（text の結合は作り直す）', () => {
    const progress = new CloneProgress();
    const head: ChatStreamEvent = { type: 'text', text: 'a' };
    progress.record('c', head);
    progress.record('c', { type: 'text', text: 'b' });
    expect(head).toEqual({ type: 'text', text: 'a' });
  });

  it('clear / clearAll で捨てる', () => {
    const progress = new CloneProgress();
    progress.record('a', { type: 'thinking' });
    progress.record('b', { type: 'thinking' });
    progress.clear('a');
    expect(progress.snapshot('a')).toBeNull();
    progress.clearAll();
    expect(progress.size).toBe(0);
  });
});

describe('Clone#attach — いままでの分を渡し、続きを購読する（#2652）', () => {
  function gatedSdk(options: { finish: 'success' | 'error' | 'no-result' }) {
    const calls: FakeCall[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let turnIndex = 0;

    const assistant = (text: string): SDKMessage =>
      ({
        type: 'assistant',
        message: { content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
        session_id: 'sess-fake',
        uuid: `uuid-${text}`,
      }) as unknown as SDKMessage;
    const result = (subtype: string, text: string): SDKMessage =>
      ({
        type: 'result',
        subtype,
        result: text,
        session_id: 'sess-fake',
        uuid: 'uuid-result',
      }) as unknown as SDKMessage;

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
          const index = turnIndex;
          turnIndex += 1;
          if (index !== 0) {
            yield assistant('わかった');
            yield result('success', 'わかった');
            continue;
          }
          yield assistant('前半');
          await gate;
          if (options.finish === 'no-result') return;
          yield assistant('後半');
          yield options.finish === 'success'
            ? result('success', '前半後半')
            : result('error_during_execution', '壊れた');
        }
      }
      return Object.assign(generate(), {
        close: () => undefined,
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;

    return { fn, calls, release: () => release() };
  }

  function setupGated(finish: 'success' | 'error' | 'no-result') {
    const sdk = gatedSdk({ finish });
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: sdk.fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const live = wireEvents(clone, 'conv-1');
    return { clone, release: sdk.release, live };
  }

  const attachTo = (clone: Setup['clone'], conversationId = 'conv-1') => {
    const received: ChatStreamEvent[] = [];
    if (clone.attach === undefined) throw new Error('attach が無い');
    const { inProgress, unsubscribe } = clone.attach(conversationId, (event) => {
      received.push(event);
    });
    return { inProgress, received, unsubscribe };
  };

  it('進行中なら、いままでの分（text は結合済み）が返り、続きは listener へ来る', async () => {
    const s = setupGated('success');
    s.clone.post(humanMessage('やあ'));
    await s.live.waitForEvents((seen) => seen.some((e) => e.type === 'text'));

    const late = attachTo(s.clone);
    expect(late.inProgress).toEqual([
      { type: 'queued' },
      { type: 'thinking' },
      { type: 'text', text: '前半' },
    ]);
    expect(late.received).toEqual([]);

    s.release();
    await waitForDone(s.live.events);
    expect(late.received.map((e) => e.type)).toEqual(['text', 'done']);

    const joined = [...late.inProgress!, ...late.received];
    const text = (events: ChatStreamEvent[]) =>
      events.map((e) => (e.type === 'text' ? e.text : '')).join('');
    expect(text(joined)).toBe(text(s.live.events));
    expect(joined.filter((e) => e.type !== 'text').map((e) => e.type)).toEqual(
      s.live.events.filter((e) => e.type !== 'text').map((e) => e.type),
    );

    late.unsubscribe();
    await s.clone.stop();
  });

  it('done の後は進行中ではない（null）', async () => {
    const s = setupGated('success');
    s.clone.post(humanMessage('やあ'));
    s.release();
    await waitForDone(s.live.events);

    const late = attachTo(s.clone);
    expect(late.inProgress).toBeNull();
    late.unsubscribe();
    await s.clone.stop();
  });

  it('error で終わったターンも捨てる', async () => {
    const s = setupGated('error');
    s.clone.post(humanMessage('やあ'));
    s.release();
    await s.live.waitForEvents((seen) => seen.some((e) => e.type === 'error'));

    const late = attachTo(s.clone);
    expect(late.inProgress).toBeNull();
    late.unsubscribe();
    await s.clone.stop();
  });

  it('result を伴わずセッションが終わった経路でも残らない', async () => {
    const s = setupGated('no-result');
    s.clone.post(humanMessage('やあ'));
    await s.live.waitForEvents((seen) => seen.some((e) => e.type === 'text'));
    expect(attachTo(s.clone).inProgress).not.toBeNull();

    s.release();
    await s.live.waitForEvents((seen) => seen.some((e) => e.type === 'error'));

    const late = attachTo(s.clone);
    expect(late.inProgress).toBeNull();
    late.unsubscribe();
    await s.clone.stop();
  });

  it('stop() でも捨てる（終端を出さずに畳まれた分を進行中と言い続けない）', async () => {
    const s = setupGated('success');
    s.clone.post(humanMessage('やあ'));
    await s.live.waitForEvents((seen) => seen.some((e) => e.type === 'text'));
    expect(attachTo(s.clone).inProgress).not.toBeNull();

    const stopping = s.clone.stop();
    s.release();
    await stopping;

    expect(attachTo(s.clone).inProgress).toBeNull();
  });

  it('別の会話の途中経過は混ざらない', async () => {
    const s = setupGated('success');
    s.clone.post(humanMessage('やあ'));
    await s.live.waitForEvents((seen) => seen.some((e) => e.type === 'text'));

    expect(attachTo(s.clone, 'conv-other').inProgress).toBeNull();

    s.release();
    await waitForDone(s.live.events);
    await s.clone.stop();
  });

  it('解除したあとは続きが来ない', async () => {
    const s = setupGated('success');
    s.clone.post(humanMessage('やあ'));
    await s.live.waitForEvents((seen) => seen.some((e) => e.type === 'text'));

    const late = attachTo(s.clone);
    late.unsubscribe();
    s.release();
    await waitForDone(s.live.events);
    expect(late.received).toEqual([]);
    await s.clone.stop();
  });
});
