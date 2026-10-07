import { describe, it, expect, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '../../../vitest.tmpdir.js';
import {
  ALWAYS_REDELIVER,
  DAEMON_TOKEN_POOL_REOPENED_SOURCE,
  commitmentFor,
  createClone,
} from './clone.js';
import { EXCHANGE_KIND_THINNING_PREFIX } from './exchange-kind.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { ChatStreamEvent, Commitment, InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage, seedFingerprintlessArchiveRow } from './testing.js';
import {
  fakeGatedSdk,
  fakeSdk,
  setup,
  wireEvents,
  lastSessionCall,
  waitFor,
  waitForDone,
} from './clone-test-harness.js';
import type { FakeCall, Setup } from './clone-test-harness.js';

describe('クローン — 要約に潰された後の索引の載せ直し（#696）', () => {
  async function twoPremises(): Promise<Stores> {
    const stores = createMemoryStores();
    await stores.persona.write(
      'values',
      '---\ntype: premise\ndescription: 価値観の要旨\n---\n## VALUES-HEAD\n本文\n',
    );
    await stores.persona.write(
      'habits',
      '---\ntype: premise\ndescription: 習慣の要旨\n---\n## HABITS-HEAD\n本文\n',
    );
    return stores;
  }

  async function firePreCompact(s: Setup): Promise<void> {
    const main = s.calls[0] as FakeCall;
    const dir = await makeTempDir('alteroid-index-refresh-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
    const preCompact = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (preCompact === undefined) throw new Error('PreCompact フックが登録されていない');
    await preCompact(
      { session_id: 'sess-fake', transcript_path: transcriptPath } as never,
      undefined,
      { signal: new AbortController().signal } as never,
    );
  }

  it('⭐ 潰された次のターンでは、変わっていない文書も含めて索引の全体が載る', async () => {
    const s = setup(undefined, await twoPremises());
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await firePreCompact(s);

    const { events } = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);

    const input = (s.calls[0] as FakeCall).inputs[1] ?? '';
    expect(input).toContain('この会話の文脈が要約に潰された');
    expect(input).toContain('いまの索引を丸ごと載せ直す');
    expect(input).toContain('## VALUES-HEAD');
    expect(input).toContain('## HABITS-HEAD');
    expect(input).toContain('memory_section_read');

    await s.clone.stop();
  });

  it('⭐ 載せ直すのはその回だけ。次のターンには載らない（毎ターン2万トークンを払わない）', async () => {
    const s = setup(undefined, await twoPremises());
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await firePreCompact(s);

    const { events: second } = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(second);

    const { events: third } = wireEvents(s.clone, 'conv-3');
    s.clone.post(humanMessage('3回目', 'conv-3'));
    await waitForDone(third);

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs[1] ?? '').toContain('要約に潰された');
    expect(inputs[2] ?? '').not.toContain('要約に潰された');
    expect(inputs[2] ?? '').not.toContain('## HABITS-HEAD');

    await s.clone.stop();
  });

  it('⭐ 潰されていないときは差分のまま（空振りしていないことの対照）', async () => {
    const stores = await twoPremises();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.write(
      'values',
      '---\ntype: premise\ndescription: 価値観の要旨\n---\n## VALUES-HEAD-NEW\n本文\n',
    );

    const { events } = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);

    const input = (s.calls[0] as FakeCall).inputs[1] ?? '';
    expect(input).not.toContain('要約に潰された');
    expect(input).toContain('## VALUES-HEAD-NEW');
    expect(input).not.toContain('## HABITS-HEAD');

    await s.clone.stop();
  });
});

describe('クローン — PreCompact の退避は diverged/unknown だけを日誌へ記録する（#698）', () => {
  async function firePreCompact(
    main: FakeCall,
    sessionId: string,
    transcript: string,
  ): Promise<void> {
    const dir = await makeTempDir('alteroid-clone-precompact-continuity-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, transcript, 'utf8');
    const hook = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
    await hook({ session_id: sessionId, transcript_path: transcriptPath } as never, undefined, {
      signal: new AbortController().signal,
    } as never);
  }

  async function continuityRows(stores: Stores): Promise<{ text: string }[]> {
    const entries = (await stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    // 囲みの飾り（[…]）では絞らない: 飾りを変えるだけの変異でこの歯が赤くなる（当てすぎ）ため
    return entries.filter(
      (entry) => entry.text.includes('PreCompact の退避') && entry.text.includes('continuity='),
    );
  }

  it('first/continues は記録されない。diverged だけが記録される', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    const main = s.calls[0] as FakeCall;

    await firePreCompact(main, 'sess-continuity', 'AAAA');
    await firePreCompact(main, 'sess-continuity', 'AAAABBBB');
    await firePreCompact(main, 'sess-continuity', 'ZZZZZZZZZZZZ');

    await waitFor(async () => (await s.stores.archive.list()).length >= 3, '3件退避されること');

    const rows = await continuityRows(s.stores);
    expect(rows.some((row) => row.text.includes('continuity=continues'))).toBe(false);
    expect(rows.some((row) => row.text.includes('continuity=first'))).toBe(false);
    expect(rows.some((row) => row.text.includes('continuity=diverged'))).toBe(true);
    expect(rows.some((row) => row.text.includes('AAAA'))).toBe(false);
    expect(rows.some((row) => row.text.includes('ZZZZZZZZZZZZ'))).toBe(false);

    await s.clone.stop();
  });

  it('unknown（直前の行が指紋を持たない）も記録される', async () => {
    const stores = createMemoryStores();
    await seedFingerprintlessArchiveRow(stores.archive, 'sess-legacy', 'LEGACY\n');
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    const main = s.calls[0] as FakeCall;

    await firePreCompact(main, 'sess-legacy', 'LEGACY\nNEW\n');

    await waitFor(async () => (await stores.archive.list()).length >= 2, '退避されること');

    const rows = await continuityRows(stores);
    expect(rows.some((row) => row.text.includes('continuity=unknown'))).toBe(true);

    await s.clone.stop();
  });
});

describe('クローン — 文脈窓で畳む前の退避は diverged/unknown だけを日誌へ記録する（#698）', () => {
  const tooLong = 'Prompt is too long';

  function setupFold() {
    const stores = createMemoryStores();
    const { fn, calls } = fakeSdk(undefined, {
      resultFor: (turnIndex) =>
        turnIndex === 1 ? { subtype: 'success', isError: true, text: tooLong } : undefined,
    });
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events } = wireEvents(clone, 'conv-1');
    return { clone, stores, calls, events };
  }

  // 新しく起きた分だけを見て待つ: .some() を配列全体に掛けると、1周目の 'done' / 'error' が2周目以降の待ちを即座に満たすため
  async function waitForNewEvent(
    events: ChatStreamEvent[],
    fromLength: number,
    type: ChatStreamEvent['type'],
    label: string,
  ): Promise<void> {
    await waitFor(() => events.slice(fromLength).some((event) => event.type === type), label);
  }

  async function successThenFold(
    s: ReturnType<typeof setupFold>,
    dir: string,
    body: string,
  ): Promise<void> {
    let fromLength = s.events.length;
    s.clone.post(humanMessage('やあ'));
    await waitForNewEvent(s.events, fromLength, 'done', '1本目が通ること');

    const transcriptPath = join(
      dir,
      `t-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
    await writeFile(transcriptPath, body, 'utf8');
    const main = lastSessionCall(s.calls);
    const hook = main.options.hooks?.PostToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
    await hook({ tool_name: 'Read', transcript_path: transcriptPath } as never, undefined, {
      signal: new AbortController().signal,
    } as never);

    const before = (await s.stores.archive.list()).length;
    fromLength = s.events.length;
    s.clone.post(humanMessage('やあ'));
    await waitForNewEvent(s.events, fromLength, 'error', '2本目（長さ失敗）が落ちること');
    await waitFor(
      async () => (await s.stores.archive.list()).length > before,
      '文脈窓の畳みで退避されること',
    );
    await waitFor(
      async () => (await s.stores.sessions.getCloneSessionId()) === null,
      '資材が捨てられて次が新しいセッションになること',
    );
  }

  it('continues は記録されない。diverged だけが記録される', async () => {
    const s = setupFold();
    const dir = await makeTempDir('alteroid-clone-salvage-continuity-');
    try {
      await successThenFold(s, dir, 'AAAA');
      await successThenFold(s, dir, 'AAAABBBB');
      await successThenFold(s, dir, 'ZZZZZZZZZZZZ');

      const rows = ((await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[])
        // 囲みの飾りでは絞らない: 飾りを変えるだけの変異でこの歯が赤くなる（当てすぎ）ため
        .filter(
          (entry) =>
            entry.text.includes('文脈窓で畳む前の退避') && entry.text.includes('continuity='),
        );
      expect(rows.some((row) => row.text.includes('continuity=continues'))).toBe(false);
      expect(rows.some((row) => row.text.includes('continuity=first'))).toBe(false);
      expect(rows.some((row) => row.text.includes('continuity=diverged'))).toBe(true);
      expect(rows.some((row) => row.text.includes('AAAA'))).toBe(false);
      expect(rows.some((row) => row.text.includes('ZZZZZZZZZZZZ'))).toBe(false);
    } finally {
      await s.clone.stop();
    }
  });
});

describe('CloneOptions.redeliveryGate は必須 — 省いた形は型として組めない（Issue #845）', () => {
  it('redeliveryGate を省いた CloneOptions は型として組めない（対照: 明示すれば組める）', () => {
    const wontTypeCheck = () =>
      // @ts-expect-error redeliveryGate は必須。省いた形は型として組めない
      createClone({ stores: createMemoryStores() });
    expect(typeof wontTypeCheck).toBe('function');

    expect(() =>
      createClone({ stores: createMemoryStores(), redeliveryGate: ALWAYS_REDELIVER }),
    ).not.toThrow();
  });
});

describe('待ちの経路に壁時計が無い（#1220）', () => {
  // vi.useRealTimers() は finally で必ず戻す: 偽の時計を掛けたまま抜けると、誰も進めないので永久に返らない状態が後続へ漏れるため
  function fakeHost(): { host: CloneHost; emit: (event: ChatStreamEvent) => void } {
    let listener: ((event: ChatStreamEvent) => void) | undefined;
    const host = {
      subscribe: (_conversationId: string, callback: (event: ChatStreamEvent) => void) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
    } as unknown as CloneHost;
    return {
      host,
      emit: (event) => {
        if (listener === undefined) throw new Error('subscribe されていない');
        listener(event);
      },
    };
  }

  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
  }

  it('⭐ 出来事の待ちは、時計を1ミリ秒も進めずに解ける（ポーリングへ戻すと赤くなる）', async () => {
    vi.useFakeTimers();
    try {
      const { host, emit } = fakeHost();
      const { events } = wireEvents(host, 'conv-1');
      let settled = false;
      void waitForDone(events).then(() => {
        settled = true;
      });
      emit({ type: 'done' } as ChatStreamEvent);
      await flushMicrotasks();
      expect(
        settled,
        'done の待ちが、時計を進めないと解けなかった。' +
          '⟹ 待ちが壁時計のポーリング（setTimeout / setInterval / expect.poll の timeout）へ' +
          '戻っている。出来事そのものを観測する形（wireEvents の waitForEvents）へ戻すこと（#1220）。',
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('⭐ waitFor は壁時計で諦めない（30秒進めても失敗しない）', async () => {
    vi.useFakeTimers();
    try {
      let arrived = false;
      let rejection: unknown;
      let resolved = false;
      const waiting = waitFor(() => arrived, 'テスト用の待ち').then(
        () => {
          resolved = true;
        },
        (error: unknown) => {
          rejection = error;
        },
      );

      await vi.advanceTimersByTimeAsync(30_000);
      expect(
        rejection,
        'waitFor が壁時計で諦めた。⟹ 打ち切りが足し戻されている。' +
          '「3000 を伸ばす」も同じ賭けを続けるだけなので、締め切りそのものを持たないこと（#1220）。',
      ).toBeUndefined();
      expect(resolved).toBe(false);

      arrived = true;
      await vi.advanceTimersByTimeAsync(10);
      await waiting;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ⚠️ **`#removeStaleRedeliveryChunk` の `#redeliveredClosed.delete` には歯を書いていない。書けない。** stale の合図は #redeliveredClosed に一度も載らないため
describe('inbox_flow.retained —— #forget 以外の経路の後始末（Issue #1264 の続き）', () => {
  it('拾い直した合図を待ち行列から消すと、その合図の3つの索引が外れる（`dropQueuedInboxEvents` の中の3行の固定）', async () => {
    const stores = createMemoryStores();

    const live = humanMessage('生きている拾い直し', 'conv-live');
    const queued = humanMessage('待ち行列で消される拾い直し', 'conv-queued');
    await stores.inbox.put(live, '2026-09-01T00:00:00.000Z');
    await stores.inbox.put(queued, '2026-09-01T00:00:01.000Z');
    await stores.commitments.open(commitmentFor(queued) as Commitment);
    expect(
      await stores.commitments.close(
        queued.id,
        '2026-09-01T00:05:00.000Z',
        'もう対応済み',
        'clone',
      ),
    ).toBe(true);

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

    await waitFor(
      () => calls.some((call) => call.inputs.some((text) => text.includes('生きている拾い直し'))),
      'live のターンが始まる',
    );

    expect(await clone.dropQueuedInboxEvents([queued.id])).toBe(1);

    release();

    await waitFor(
      async () => (await stores.journal.list({ types: ['inbox_flow'] })).length >= 1,
      '1本目の inbox_flow 行',
    );
    const rows = await stores.journal.list({ types: ['inbox_flow'] });
    const row = rows[0];
    if (row?.type !== 'inbox_flow') throw new Error('inbox_flow が日誌に無い');
    expect(row.retained).toEqual({
      unread: 1,
      redelivered: 1,
      redeliveredClosed: 0,
      pendingCollapse: 0,
    });

    await clone.stop();
  });

  it('stale の拾い直しを一括で消すと、その合図の索引が外れる（`#removeStaleRedeliveryChunk` の `#unread` / `#redelivered` の固定）', async () => {
    const stores = createMemoryStores();

    const stale: InboxEvent = {
      type: 'external',
      id: 'evt-stale-tokenpool',
      at: '2026-09-01T00:00:00.000Z',
      source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
    };
    const live = humanMessage('stale の後ろの生きている拾い直し', 'conv-live');
    await stores.inbox.put(stale, '2026-09-01T00:00:00.000Z');
    await stores.inbox.put(live, '2026-09-01T00:00:01.000Z');

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

    await waitFor(
      () =>
        calls.some((call) =>
          call.inputs.some((text) => text.includes('stale の後ろの生きている拾い直し')),
        ),
      'live のターンが始まる',
    );
    await waitFor(async () => (await stores.inbox.pending()).count === 1, 'stale が器から消える');

    release();

    await waitFor(
      async () => (await stores.journal.list({ types: ['inbox_flow'] })).length >= 1,
      '1本目の inbox_flow 行',
    );
    const rows = await stores.journal.list({ types: ['inbox_flow'] });
    const row = rows[0];
    if (row?.type !== 'inbox_flow') throw new Error('inbox_flow が日誌に無い');
    expect(row.retained).toEqual({
      unread: 1,
      redelivered: 1,
      redeliveredClosed: 0,
      pendingCollapse: 0,
    });

    await clone.stop();
  });

  it('拾い直している最中に消された合図は、配らずに畳んだうえで3つの索引も外す（`#restoreUnreadPass` の `#droppedWhileRestoring` 分岐の3行の固定）', async () => {
    const stores = createMemoryStores();

    const target = humanMessage('拾い直しの最中に消される', 'conv-dropped');
    await stores.inbox.put(target, '2026-09-01T00:00:00.000Z');
    await stores.commitments.open(commitmentFor(target) as Commitment);
    expect(
      await stores.commitments.close(
        target.id,
        '2026-09-01T00:05:00.000Z',
        'もう対応済み',
        'clone',
      ),
    ).toBe(true);

    // 消し込みは commitments.get の await の中で差し込む: 時間で近似せず、#restoringUnread が立っている窓で必ず墓標が残るため
    const holder: { clone?: ReturnType<typeof createClone> } = {};
    let droppedDuringRestore: number | undefined;
    const originalGet = stores.commitments.get.bind(stores.commitments);
    stores.commitments.get = async (id) => {
      if (id === target.id && droppedDuringRestore === undefined) {
        if (holder.clone === undefined) throw new Error('clone がまだ無い');
        droppedDuringRestore = await holder.clone.dropQueuedInboxEvents([target.id]);
      }
      return originalGet(id);
    };

    const sdk = fakeSdk();
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: sdk.fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    holder.clone = clone;

    await waitFor(
      async () =>
        (await stores.journal.list({ types: ['exchange'] })).some(
          (entry) =>
            entry.type === 'exchange' &&
            entry.text.startsWith(
              `${EXCHANGE_KIND_THINNING_PREFIX}拾い直している最中に器から消された合図なので`,
            ),
        ),
      '拾い直しの最中に消された合図を畳んだ跡',
    );
    expect(droppedDuringRestore).toBe(0);

    clone.post(humanMessage('後から届く合図（窓をトリガー）', 'conv-after'));
    await waitFor(
      async () => (await stores.journal.list({ types: ['inbox_flow'] })).length >= 1,
      '1本目の inbox_flow 行',
    );
    const rows = await stores.journal.list({ types: ['inbox_flow'] });
    const row = rows[0];
    if (row?.type !== 'inbox_flow') throw new Error('inbox_flow が日誌に無い');
    expect(row.retained).toEqual({
      unread: 1,
      redelivered: 0,
      redeliveredClosed: 0,
      pendingCollapse: 0,
    });
    expect(
      sdk.calls.some((call) =>
        call.inputs.some((text) => text.includes('拾い直しの最中に消される')),
      ),
    ).toBe(false);

    await clone.stop();
  });
});
