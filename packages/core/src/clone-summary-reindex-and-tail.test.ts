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

/**
 * ⭐ 要約に潰された後、記憶の索引を丸ごと載せ直す（Issue #696）。
 *
 * ## 何が壊れていたか
 *
 * 記憶の焼き込みはセッションを組むときに1回だけ行われる。以後の変化は
 * **差分**として会話へ載るので「構築時点の索引 ＋ 差分 ＝ 現在」で揃っている
 * ——**compaction までは。** 要約に潰されると差分もその中へ畳まれ、確実に
 * 残るのは構築時点の索引だけになる。本番のクローンは6日間1セッションのまま
 * だったので、**6日前の索引を「現在の記憶」として読み続けていた。**
 *
 * ## 測るのは「潰された後に全体が載ること」と「その回だけであること」
 *
 * 全体が載るのは高い（索引は2万トークン級）ので、**毎ターン載ってはいけない。**
 * だから3本で挟む —— 載ること／次のターンには載らないこと／潰されていない
 * ときは差分のままであること。
 */
describe('クローン — 要約に潰された後の索引の載せ直し（#696）', () => {
  /** 節を持つ premise 2本。索引に見出しが出るので「全体か差分か」が行で見分けられる。 */
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
    // 潰されたことと、下が新しいことを言う。
    expect(input).toContain('この会話の文脈が要約に潰された');
    expect(input).toContain('いまの索引を丸ごと載せ直す');
    // **1文字も記憶を触っていないのに、両方の索引が載る**（差分なら0件で何も載らない）。
    expect(input).toContain('## VALUES-HEAD');
    expect(input).toContain('## HABITS-HEAD');
    // 本文は載らない（カードの約束は変わっていない）。
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
    // 3ターン目には印が下りている。
    expect(inputs[2] ?? '').not.toContain('要約に潰された');
    expect(inputs[2] ?? '').not.toContain('## HABITS-HEAD');

    await s.clone.stop();
  });

  it('⭐ 潰されていないときは差分のまま（空振りしていないことの対照）', async () => {
    const stores = await twoPremises();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    // values だけを直す。habits は1文字も触らない。
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
    // 触っていない文書は載らない（＝全体を載せる枝へ落ちていない）。
    expect(input).not.toContain('## HABITS-HEAD');

    await s.clone.stop();
  });
});

/**
 * `#onPreCompact` の退避は `diverged` / `unknown` のときだけ日誌へ記録する
 * （`continues` は記録しない）——理由は `archive-continuity.ts` の
 * `describeArchiveContinuityForJournal` の doc。文言は `'PreCompact の退避'`
 * を名乗り、他の2つの呼び手（`#salvageTranscript` / `manager.ts` の
 * `case 'archive'`）と区別できる。
 */
describe('クローン — PreCompact の退避は diverged/unknown だけを日誌へ記録する（#698）', () => {
  /** `PreCompact` フックを実際に叩く。`session_id` を固定して連続性の鎖を作る。 */
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
    // **呼び手の名前と `continuity=` の2つで絞る。囲みの飾り（`[…]`）では絞らない。**
    // 飾りで絞っていたときは、飾りを変えるだけの変異でこの歯が赤くなった（＝当てすぎ。
    // #698 の変異試験 m5 で実測）。絞りが担っているのは2つ——同じ呼び手の**失敗**の記録
    // （`PreCompact の退避に失敗した`）を拾わないことと、他の2つの呼び手と混ざらないこと。
    // **どちらも飾りには依存しない。**
    return entries.filter(
      (entry) => entry.text.includes('PreCompact の退避') && entry.text.includes('continuity='),
    );
  }

  it('first/continues は記録されない。diverged だけが記録される', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    const main = s.calls[0] as FakeCall;

    await firePreCompact(main, 'sess-continuity', 'AAAA'); // first
    await firePreCompact(main, 'sess-continuity', 'AAAABBBB'); // continues
    await firePreCompact(main, 'sess-continuity', 'ZZZZZZZZZZZZ'); // diverged

    await waitFor(async () => (await s.stores.archive.list()).length >= 3, '3件退避されること');

    const rows = await continuityRows(s.stores);
    expect(rows.some((row) => row.text.includes('continuity=continues'))).toBe(false);
    expect(rows.some((row) => row.text.includes('continuity=first'))).toBe(false);
    expect(rows.some((row) => row.text.includes('continuity=diverged'))).toBe(true);
    // 本文そのもの・断片は載らない。
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

/**
 * `#salvageTranscript`（文脈窓で畳む前の退避）も同じ規則で記録する。
 * 文言は `'文脈窓で畳む前の退避'` を名乗る——`#onPreCompact` の
 * `'PreCompact の退避'` / `manager.ts` の `'マネージャーの生ログの退避'` とは
 * 区別できる形である。
 *
 * `fakeSdk` は `system:init` の `session_id` を常に固定値（`'sess-fake'`）で
 * 出すので、文脈窓の畳みで新しいセッションへ作り直しても
 * `this.#sdkSessionId` は同じ値のまま——同じ `sessionId` を鍵にした連続性の
 * 鎖を2回の畳みにまたがって作れる。
 */
describe('クローン — 文脈窓で畳む前の退避は diverged/unknown だけを日誌へ記録する（#698）', () => {
  const tooLong = 'Prompt is too long';

  /**
   * **`resultFor` の `turnIndex` はセッションごとに0から数え直す**（`fakeSdk`
   * の doc）。⟹ 各セッションの「1本目は成功・2本目は長さで落ちる（畳む）」を
   * 固定すれば、`failNext` のような使い回しの旗を持たなくても、畳みのたびに
   * 新しいセッションで同じ形（成功→畳み）を繰り返させられる。
   */
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

  /**
   * `events` は全サイクルぶん積み上がる配列なので、**新しく起きた分だけ**を
   * 見て待つ（`.some()` を配列全体に掛けると、1周目の 'done' / 'error' が
   * 2周目以降の待ちを即座に満たしてしまう）。
   */
  async function waitForNewEvent(
    events: ChatStreamEvent[],
    fromLength: number,
    type: ChatStreamEvent['type'],
    label: string,
  ): Promise<void> {
    await waitFor(() => events.slice(fromLength).some((event) => event.type === type), label);
  }

  /**
   * 1セッションぶん——1本目を成功させ、生ログの在り処を控えたうえで2本目を
   * 長さ失敗させて畳ませる。畳み終わる（退避が `list()` に出る）まで待つ。
   */
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
    // 次のサイクルが新しいセッションへ入れるよう、資材が捨てられるまで待つ。
    await waitFor(
      async () => (await s.stores.sessions.getCloneSessionId()) === null,
      '資材が捨てられて次が新しいセッションになること',
    );
  }

  it('continues は記録されない。diverged だけが記録される', async () => {
    const s = setupFold();
    const dir = await makeTempDir('alteroid-clone-salvage-continuity-');
    try {
      await successThenFold(s, dir, 'AAAA'); // first
      await successThenFold(s, dir, 'AAAABBBB'); // continues
      await successThenFold(s, dir, 'ZZZZZZZZZZZZ'); // diverged

      const rows = ((await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[])
        // 囲みの飾りでは絞らない（理由は `#onPreCompact` 側の `continuityRows` の注釈）。
        .filter(
          (entry) =>
            entry.text.includes('文脈窓で畳む前の退避') && entry.text.includes('continuity='),
        );
      expect(rows.some((row) => row.text.includes('continuity=continues'))).toBe(false);
      expect(rows.some((row) => row.text.includes('continuity=first'))).toBe(false);
      expect(rows.some((row) => row.text.includes('continuity=diverged'))).toBe(true);
      // 本文そのもの・断片は載らない。
      expect(rows.some((row) => row.text.includes('AAAA'))).toBe(false);
      expect(rows.some((row) => row.text.includes('ZZZZZZZZZZZZ'))).toBe(false);
    } finally {
      await s.clone.stop();
    }
  });
});

/**
 * `CloneOptions.redeliveryGate` は必須（Issue #845。#783 続きで必須化した後、
 * `#redeliveryGate` フィールドと `#restoreUnread` の分岐だけが `| undefined` /
 * 到達しない `if` として「省略できる」と主張し続けていた）。
 *
 * **これは型レベルの歯である。** `vitest` はトランスパイル済みの JS を実行する
 * だけなので、この `it()` 自体は実行時には常に通る。守っているのは
 * **`pnpm typecheck`（`tsc --noEmit`）がこのファイルを検査したときに、次の行が
 * 「型エラーである」ことを要求する** 側——`@ts-expect-error` は「次の行は型
 * エラーになるはずだ」という主張で、**実際にエラーにならなければ
 * `@ts-expect-error` 自身が「不要な抑制」として `pnpm typecheck` を落とす**
 * （作法は `prompt.test.ts`「branded type — RenderedMemory を経由しない記憶は
 * buildCloneSystemPrompt に渡せない」に既に在る）。
 *
 * ⟹ **`redeliveryGate` を再び `redeliveryGate?:` へ緩めると、ここが
 * `pnpm typecheck` を落とす。**
 */
describe('CloneOptions.redeliveryGate は必須 — 省いた形は型として組めない（Issue #845）', () => {
  it('redeliveryGate を省いた CloneOptions は型として組めない（対照: 明示すれば組める）', () => {
    const wontTypeCheck = () =>
      // @ts-expect-error redeliveryGate は必須。省いた形は型として組めない
      // （`CloneOptions.redeliveryGate` の doc）。
      createClone({ stores: createMemoryStores() });
    // 実行はしない。ここが測るのは型として組めないことだけである
    // （実行時に「無くても動く」ことを測っているのではない——それでは
    // 必須化そのものの歯にならない）。
    expect(typeof wontTypeCheck).toBe('function');

    // 対照: 明示すれば従来どおり組める（この歯が「redeliveryGate を
    // 渡すこと自体を壊した」だけではないことを確かめる）。
    expect(() =>
      createClone({ stores: createMemoryStores(), redeliveryGate: ALWAYS_REDELIVER }),
    ).not.toThrow();
  });
});

describe('待ちの経路に壁時計が無い（#1220）', () => {
  /**
   * ⭐ **この2本が、この Issue の「再発を止める門」である。**
   *
   * #1192 で takecchi が「**注意書きを増やすことと、再発を防ぐことが別になり始めて
   * いる**」と指摘した。実際、ここには既に「⛔ ここを伸ばして歯を黙らせないこと」と
   * 書いてあったのに、**壁時計の打ち切りは残り、2026-09-12 に `main` の CI を落とした。**
   * ⟹ 注意書きでは止まらない。**測る。**
   *
   * ## なぜ偽タイマーで測るのか
   *
   * 「壁時計に依存しない」は、**時計を止めれば直接測れる**。ポーリングの形へ戻すと
   * `setTimeout` / `setInterval` が発火しないので、下の1本目は必ず赤くなる。
   * 打ち切りを足し戻すと、2本目が必ず赤くなる。**どちらも実時間を1ミリ秒も使わない。**
   *
   * ⚠️ `vi.useRealTimers()` は `finally` で必ず戻すこと。偽の時計を掛けたまま
   * テストを抜けると、`vitest.setup.ts` が逐語で言うとおり「誰も進めないので永久に
   * 返らない」状態が後続へ漏れる。
   */
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

  /** マイクロタスクだけを有界に流す。**時計は1ミリ秒も進めない。** */
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

      // **古い打ち切り（3000ms）の10倍。**条件は偽のままにしておく。
      await vi.advanceTimersByTimeAsync(30_000);
      expect(
        rejection,
        'waitFor が壁時計で諦めた。⟹ 打ち切りが足し戻されている。' +
          '「3000 を伸ばす」も同じ賭けを続けるだけなので、締め切りそのものを持たないこと（#1220）。',
      ).toBeUndefined();
      expect(resolved).toBe(false);

      // 条件が真になれば、ちゃんと解ける（空振りしていないことの対照）。
      arrived = true;
      await vi.advanceTimersByTimeAsync(10);
      await waiting;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * `inbox_flow.retained` で、`#forget` 以外の3つの経路の後始末を固定する
 * （Issue #1264 の続き）。
 *
 * `#unread` / `#redelivered` / `#redeliveredClosed` から項目を外す3行は、
 * `#forget` のほかに3箇所ある——`dropQueuedInboxEvents`（待ち行列から消す。
 * #1049）・`#removeStaleRedeliveryChunk`（stale の一括消し込み。#1264 が
 * 名指しした一括経路）・`#restoreUnreadPass` の「拾い直しの最中に消された
 * 合図」の分岐。上の `describe` が歯にしたのは `#forget` だけで、この3箇所は
 * 1行ずつ殺しても全スイートが緑のままだった。
 *
 * **消し込みの前に項目が入っていることは、ここでは窓で直接は測れない**
 * （窓はターンの終わりにしか書かれず、どの経路も消すのはそれより前）。
 * 代わりに、各シナリオで「その経路を通ったこと」を別の出口で固定し
 * （`dropQueuedInboxEvents` の戻り値・器の残数・日誌の1行）、項目が入る
 * ことは `#restoreUnreadPass` の同じ組み立て（上の `describe` の最後の歯が
 * 窓で `{ unread: 2, redelivered: 2, redeliveredClosed: 1 }` を固定している
 * 形）に頼る。
 *
 * ⚠️ **`#removeStaleRedeliveryChunk` の `#redeliveredClosed.delete` には歯を
 * 書いていない。書けない。** stale と判定されるのは token-pool の自己通知だけ
 * （`inbox-staleness.ts` の `restoredInboxEventVerdict`）で、自己通知の
 * `commitmentFor` は `null` を返す（`isDaemonSelfNotice`）——stale の合図は
 * `#redeliveredClosed` に一度も載らないので、その行が外す項目がいまの判定の
 * 下では存在しない。stale の判定が広がったらこの行にも歯が要る。
 *
 * **その「広がったら」を知らせる門は `inbox-staleness.test.ts` に在る**
 * （Issue #1534 案1。`restoredInboxEventVerdict が stale と言う合図は、
 * 必ず commitmentFor が null` の describe）——広がってこの前提が崩れたら、
 * こちらではなくあちらが先に赤くなる。`CloneRedeliveryState.drop` が両方の
 * 索引から外すこと自体は `clone-redelivery-state.test.ts` が単体で固定する
 * （同 Issue 案2）。
 */
describe('inbox_flow.retained —— #forget 以外の経路の後始末（Issue #1264 の続き）', () => {
  it('拾い直した合図を待ち行列から消すと、その合図の3つの索引が外れる（`dropQueuedInboxEvents` の中の3行の固定）', async () => {
    const stores = createMemoryStores();

    // `live` のターンを握っているあいだ、`queued` は待ち行列に残る
    // （上の `describe` の最後の歯と同じ組み立て）。`queued` は台帳が閉じて
    // いるので `#redeliveredClosed` にも載る。
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

    // `queued` が待ち行列に居たことの固定（0 なら、この歯は何も測っていない）。
    expect(await clone.dropQueuedInboxEvents([queued.id])).toBe(1);

    release();

    await waitFor(
      async () => (await stores.journal.list({ types: ['inbox_flow'] })).length >= 1,
      '1本目の inbox_flow 行',
    );
    const rows = await stores.journal.list({ types: ['inbox_flow'] });
    const row = rows[0];
    if (row?.type !== 'inbox_flow') throw new Error('inbox_flow が日誌に無い');
    // 🔴 残るのは処理中の `live` 自身だけ。3行のどれかを殺すと、`queued` の
    // 分が対応する欄に残る（`unread: 2` / `redelivered: 2` / `redeliveredClosed: 1`）。
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

    // stale（token-pool の復帰通知）を先に、live を後に積む（`claimPending` は
    // `at` の昇順）。stale は `#redelivered` / `#unread` に載ってから一括の
    // 消し込みへ回る（`#restoreUnreadPass` の `staleBuffer`）。
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
    // 一括の消し込みが器まで届いたことの固定（stale が消え、live だけが残る）。
    // 0 件のまま（＝消し込みが走っていない）ならこの歯は何も測っていない。
    await waitFor(async () => (await stores.inbox.pending()).count === 1, 'stale が器から消える');

    release();

    await waitFor(
      async () => (await stores.journal.list({ types: ['inbox_flow'] })).length >= 1,
      '1本目の inbox_flow 行',
    );
    const rows = await stores.journal.list({ types: ['inbox_flow'] });
    const row = rows[0];
    if (row?.type !== 'inbox_flow') throw new Error('inbox_flow が日誌に無い');
    // 🔴 残るのは処理中の `live` 自身だけ。`#unread.delete` / `#redelivered.delete`
    // を殺すと、stale の分が対応する欄に残る。
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

    // 台帳を閉じておくので、拾い直しの中で `#redeliveredClosed` にも載る。
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

    // **消し込みを拾い直しの最中へ差し込む。** `#restoreUnreadPass` は record
    // ごとに台帳を照会する（`commitments.get`）——その `await` の中で
    // `dropQueuedInboxEvents` を呼べば、`#restoringUnread` が立っている窓で
    // 必ず墓標が残る（時間で近似しない）。
    // `createClone` より前にフックを差すので、器は入れ物越しに後から渡す。
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

    // この分岐を通ったことの固定（日誌の1行）。通らなければこの歯は何も測っていない。
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
    // まだ待ち行列に積まれる前なので、その場で落とせたのは0件（墓標だけが残る）。
    expect(droppedDuringRestore).toBe(0);

    clone.post(humanMessage('後から届く合図（窓をトリガー）', 'conv-after'));
    await waitFor(
      async () => (await stores.journal.list({ types: ['inbox_flow'] })).length >= 1,
      '1本目の inbox_flow 行',
    );
    const rows = await stores.journal.list({ types: ['inbox_flow'] });
    const row = rows[0];
    if (row?.type !== 'inbox_flow') throw new Error('inbox_flow が日誌に無い');
    // 🔴 残るのは処理中の後発の合図だけ。3行のどれかを殺すと、消された
    // 合図の分が対応する欄に残る。
    expect(row.retained).toEqual({
      unread: 1,
      redelivered: 0,
      redeliveredClosed: 0,
      pendingCollapse: 0,
    });
    // 消された合図は配られていない。
    expect(
      sdk.calls.some((call) =>
        call.inputs.some((text) => text.includes('拾い直しの最中に消される')),
      ),
    ).toBe(false);

    await clone.stop();
  });
});
