import { describe, it, expect, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { ChatStreamEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage, seedFingerprintlessArchiveRow } from './testing.js';
import {
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

  const VALUES_V2 = '---\ntype: premise\ndescription: 価値観の要旨\n---\n## VALUES-HEAD-V2\n本文\n';

  it('⭐ 多数の文書が消えても、削除された記憶の名前は1つも省略されない（省略された名前の文書が生きていると読まれないため）', async () => {
    const stores = createMemoryStores();
    const slugs = Array.from(
      { length: 80 },
      (_, index) => `removed-document-with-a-long-name-${String(index).padStart(3, '0')}`,
    );
    for (const slug of slugs) {
      await stores.persona.write(
        slug,
        `---\ntype: premise\ndescription: ${slug} の要旨\n---\n## ${slug}\n本文\n`,
      );
    }
    const s = setup(undefined, stores, {}, {});
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    for (const slug of slugs) await stores.persona.remove(slug);
    await firePreCompact(s);
    const { events } = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);

    const input = (s.calls[0] as FakeCall).inputs[1] ?? '';
    const line = input.split('\n').find((entry) => entry.startsWith('削除された記憶:'));
    expect(line).toBeDefined();
    for (const slug of slugs) expect(line).toContain(`${slug}.md`);
    expect(line).not.toMatch(/省略/);

    await s.clone.stop();
  });

  it('⭐ 載せ直すのはその回だけ。次のターンには載らない（毎ターン2万トークンを払わない）', async () => {
    const stores = await twoPremises();
    const s = setup(undefined, stores, {}, {});
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.write('values', VALUES_V2);
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

  it('⭐ 焼いた時点から変わっていなくても、要約の後は索引を丸ごと載せ直す', async () => {
    const s = setup(undefined, await twoPremises(), {}, {});
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await firePreCompact(s);

    const { events } = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);

    const input = (s.calls[0] as FakeCall).inputs[1] ?? '';
    expect(input).toContain('いまの索引を丸ごと載せ直す');
    expect(input).toContain('## VALUES-HEAD');
    expect(input).toContain('## HABITS-HEAD');
    expect(input).not.toContain('システムプロンプトの記憶は要約で消えていない');

    await s.clone.stop();
  });

  it('⭐ 潰されていないときは差分のまま（空振りしていないことの対照）', async () => {
    const stores = await twoPremises();
    const s = setup(undefined, stores, {}, {});
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
