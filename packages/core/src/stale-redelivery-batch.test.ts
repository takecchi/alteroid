import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, DAEMON_TOKEN_POOL_REOPENED_SOURCE, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent, JournalEntryInput } from './schema.js';
import type { Stores } from './store.js';
import { captureStderr, createMemoryStores } from './testing.js';

/**
 * Issue #903 の実装（`clone.ts` の `#restoreUnreadPass` / `#dropStaleRedelivery` /
 * `#removeStaleRedeliveryChunk`）が守るべき性質を測る。
 *
 * **この対象はもともと `inbox-persistence.test.ts` の
 * 「拾い直した token-pool の合図の消し込み（Issue #783 段1）」が持っていた。**
 * あちらは「stale が消える」「本文が残る」「モデルへ渡らない」という**1件の
 * 挙動**を固定しており、#903 の後もそのまま緑であること自体が「stale の判定
 * そのものは動かしていない」ことの証拠になっている（既存の歯は1文字も
 * 変えていない）。ここで新しく測るのは**複数件を一括で扱ったときの性質**
 * ——ストアへの書き込み回数・日誌の行数・失った情報が無いこと・live 側が
 * 無傷であること・後始末の網羅性・途中で止まったときの一貫性である。
 *
 * `Clone` の private field（`#unread` / `#redelivered` / `#pendingCollapse`）は
 * 直接覗かない（`clone.test.ts` の「`#redelivered` の Map を直接覗かない ──
 * private field を覗く形は…」と同じ理由。JS の `#` は本物の private で、
 * クラス定義の外からは構文上アクセスできない）。**すべて観測できる外部
 * 挙動を通して確かめる。**
 */

interface Fake {
  fn: typeof sdkQuery;
  inputs: string[];
}

/** SDK の代わり。届いた入力をすべて記録し、`ok` とだけ返す。 */
function fakeSdk(): Fake {
  const inputs: string[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
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
        inputs.push(String(message.message.content));
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

  return { fn, inputs };
}

function bootClone(stores: Stores): Fake & { clone: CloneHost } {
  const fake = fakeSdk();
  const clone = createClone({
    stores,
    queryFn: fake.fn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
    redeliveryGate: ALWAYS_REDELIVER,
  });
  return { ...fake, clone };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`${label} が起きない`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** stale（token-pool）の `external` 合図。`at` は個別に指定できる（受け取り時刻）。 */
function staleTokenPoolEvent(id: string, at: string, payload: unknown): InboxEvent {
  return { type: 'external', id, at, source: DAEMON_TOKEN_POOL_REOPENED_SOURCE, payload };
}

/** live な `manager_message`（配り直しの既存の歯と同じ形）。 */
function managerReport(text: string, id: string, at: string): InboxEvent {
  return { type: 'manager_message', id, at, managerId: 'mgr-1', kind: 'report', text };
}

/**
 * `stores.inbox.removeMany` と `stores.journal.append` の呼び出しを実際に
 * 数える偽実装で包む（AGENTS.md「報告の形」— 判定ではなく実測を返す）。
 * 中身は本物の `MemoryInboxStore` / `MemoryJournalStore` へそのまま委ねる
 * ——数えるだけで挙動は変えない。
 */
function instrument(base: Stores): {
  stores: Stores;
  removeManyCalls: string[][];
  appendCalls: JournalEntryInput[];
} {
  const removeManyCalls: string[][] = [];
  const appendCalls: JournalEntryInput[] = [];
  const stores: Stores = {
    ...base,
    inbox: {
      ...base.inbox,
      async removeMany(ids: readonly string[]) {
        removeManyCalls.push([...ids]);
        return base.inbox.removeMany(ids);
      },
    },
    journal: {
      ...base.journal,
      async append(entry: JournalEntryInput) {
        appendCalls.push(entry);
        return base.journal.append(entry);
      },
    },
  };
  return { stores, removeManyCalls, appendCalls };
}

/** `removeMany` を最初の `failCount` 回だけ失敗させる（`flakyInboxRemove` の複数件版）。 */
function flakyRemoveMany(
  base: Stores,
  failCount: number,
  reason: string,
): { stores: Stores; calls: string[][] } {
  const calls: string[][] = [];
  let remaining = failCount;
  return {
    calls,
    stores: {
      ...base,
      inbox: {
        ...base.inbox,
        async removeMany(ids: readonly string[]) {
          calls.push([...ids]);
          if (remaining > 0) {
            remaining -= 1;
            return Promise.reject(new Error(reason));
          }
          return base.inbox.removeMany(ids);
        },
      },
    },
  };
}

describe('stale な配り直しの一括消し込み（issue #903）', () => {
  it('stale N 件を一括で消す: removeMany の呼び出し回数が N より少ない（ストアを偽実装で包んで実際に数える）', async () => {
    const base = createMemoryStores();
    const { stores, removeManyCalls } = instrument(base);
    const N = 5;
    const ids = Array.from({ length: N }, (_, i) => `evt-stale-few-${i}`);
    for (const [i, id] of ids.entries()) {
      const at = `2026-08-01T00:00:0${i}.000Z`;
      await stores.inbox.put(staleTokenPoolEvent(id, at, `PAYLOAD-${i}`), at);
    }

    const { clone } = bootClone(stores);
    await waitFor(
      async () => (await stores.inbox.peekPending()).length === 0,
      '全件が受信箱から消える',
    );

    // **実測**: N=5 件に対して呼び出しは1回。
    expect(removeManyCalls.length).toBeLessThan(N);
    expect(removeManyCalls.length).toBe(1);
    // **失っていない**: 渡した id は1つも欠けず、余計な id も無い。
    expect(removeManyCalls.flat().sort()).toEqual([...ids].sort());

    await clone.stop();
  });

  it('塊の上限（RESTORE_STALE_REMOVE_CHUNK_MAX_IDS = 65,535）+1 件を仕込むと removeMany が2回以上に割れる', async () => {
    const base = createMemoryStores();
    const { stores, removeManyCalls } = instrument(base);
    const CHUNK_MAX = 65_535;
    const N = CHUNK_MAX + 1;
    for (let i = 0; i < N; i += 1) {
      const id = `evt-chunk-${i}`;
      const at = new Date(2026, 0, 1, 0, 0, 0, i % 1000).toISOString();
      await stores.inbox.put(staleTokenPoolEvent(id, at, i), at);
    }

    const { clone } = bootClone(stores);
    await waitFor(
      async () => (await stores.inbox.peekPending()).length === 0,
      '全件（65,536件）が受信箱から消える',
      60_000,
    );

    // **実測**: 上限を1件超えただけで、呼び出しが2回に割れる。
    expect(removeManyCalls.length).toBeGreaterThanOrEqual(2);
    // **失っていない**: 塊を全部つなげると渡した件数に戻る。
    const totalRemoved = removeManyCalls.reduce((sum, chunk) => sum + chunk.length, 0);
    expect(totalRemoved).toBe(N);
    // **上限を守っている**: どの塊も上限を超えない。
    for (const chunk of removeManyCalls) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX);
    }

    await clone.stop();
  }, 90_000);

  it('stale 1件あたりの journal.append 回数が3回から2回に減った（同じく数える）', async () => {
    // **基準（0件）を先に測る**——起動そのものが書く journal（もしあれば）を
    // 「stale の処理が足した分」から除くため。実測どうしを比べる形にし、
    // 決め打ちの定数（0 など）を仮定しない。
    const baseline = createMemoryStores();
    const { stores: baselineStores, appendCalls: baselineAppends } = instrument(baseline);
    const { clone: baselineClone } = bootClone(baselineStores);
    // 待つ材料が無いので一呼吸だけ置く——0件の起動はすぐに `#restoreUnreadPass`
    // を通り終える。
    await new Promise((resolve) => setTimeout(resolve, 50));
    await baselineClone.stop();
    const baselineCount = baselineAppends.length;

    const stores0 = createMemoryStores();
    const { stores, appendCalls } = instrument(stores0);
    const N = 4;
    const ids = Array.from({ length: N }, (_, i) => `evt-stale-count-${i}`);
    for (const [i, id] of ids.entries()) {
      const at = `2026-08-02T00:00:0${i}.000Z`;
      await stores.inbox.put(staleTokenPoolEvent(id, at, `COUNT-PAYLOAD-${i}`), at);
    }

    const { clone } = bootClone(stores);
    await waitFor(
      async () => (await stores.inbox.peekPending()).length === 0,
      '全件が受信箱から消える',
    );

    // stale 1件につき (本文 + 畳んだ見出し1行) = 2回。3回目（旧「配り直した」の
    // 単独行）は書かれない。
    expect(appendCalls.length - baselineCount).toBe(2 * N);

    await clone.stop();
  });

  it('減った1行の情報が失われていない — 残った見出しの行に deliveries の回数が載っている（逐語で撃つ）', async () => {
    const stores = createMemoryStores();
    const event = staleTokenPoolEvent(
      'evt-deliveries-stale',
      '2026-08-03T00:00:00.000Z',
      'DELIVERIES-PAYLOAD',
    );
    await stores.inbox.put(event, event.at);

    const { clone } = bootClone(stores);
    await waitFor(async () => (await stores.inbox.peekPending()).length === 0, '消える');

    const exchanges = await stores.journal.list({ types: ['exchange'] });
    const folded = exchanges.find(
      (entry) =>
        entry.type === 'exchange' &&
        entry.text.includes('ターンを起こさずに消した') &&
        entry.text.includes(event.at),
    );
    const text = folded && folded.type === 'exchange' ? folded.text : '';

    // **`deliveries`（今回は1回目）が文中にそのまま残っている。**
    expect(text).toContain('1回目の配達');
    // **「配り直した」と「消した」が1行に畳まれている**（両方の語がこの1行に
    // 同居している——2行が1行になったことの直接の証拠）。
    expect(text).toContain('未読のまま残っていた合図を配り直した');
    expect(text).toContain('ターンを起こさずに消した');

    await clone.stop();
  });

  it('拾い直しても消せなければ跡を残して次の起動へ委ねる——一括経路でも FORGET_RETRY_ATTEMPTS の再試行を落とさない', async () => {
    const base = createMemoryStores();
    // `FORGET_RETRY_ATTEMPTS`（3）を超えて恒久的に失敗させる。
    const { stores, calls } = flakyRemoveMany(base, 10, '恒久的な障害（テスト用）');
    const event = staleTokenPoolEvent(
      'evt-stale-retry-exhausted',
      '2026-08-04T00:00:00.000Z',
      'RETRY-PAYLOAD',
    );
    await stores.inbox.put(event, event.at);

    const lines = await captureStderr(async () => {
      const { clone } = bootClone(stores);
      // 見出しの行（journal）は removeMany の成否に関わらず先に書かれる
      // ——それを待ってから、拾い直しの間隔（`FORGET_RETRY_MS` × (1+2) ≒
      // 600ms）ぶんさらに待って諦めきるのを待つ。
      await waitFor(async () => {
        const exchanges = await stores.inbox.peekPending();
        return exchanges.length === 1; // まだ消えていないことを繰り返し確認
      }, '（消えていないことの確認のための一呼吸）');
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await clone.stop();
    });

    // 3回試行して諦めている（1件の塊なので、塊ごとに3回）。
    expect(calls.length).toBe(3);
    // 消せなかったことが跡として残る。
    expect(lines.some((line) => line.includes('未読の消し込み'))).toBe(true);
    // **消していない**——次の起動（`#restoreUnread`）に委ねられる。
    const pending = await base.inbox.claimPending();
    expect(pending.some((p) => p.event.id === event.id)).toBe(true);
  }, 10_000);

  it('本文追記（external_event）は1件ずつ N 件出る（畳まれていない）', async () => {
    const stores = createMemoryStores();
    const N = 3;
    const ids = Array.from({ length: N }, (_, i) => `evt-body-${i}`);
    for (const [i, id] of ids.entries()) {
      const at = `2026-08-05T00:00:0${i}.000Z`;
      await stores.inbox.put(staleTokenPoolEvent(id, at, `BODY-PAYLOAD-${i}`), at);
    }

    const { clone } = bootClone(stores);
    await waitFor(async () => (await stores.inbox.peekPending()).length === 0, '全件が消える');

    const externalEvents = await stores.journal.list({ types: ['external_event'] });
    for (let i = 0; i < N; i += 1) {
      const found = externalEvents.some(
        (entry) => entry.type === 'external_event' && entry.summary.includes(`BODY-PAYLOAD-${i}`),
      );
      expect(found).toBe(true);
    }
    // **畳まれていない**: N件それぞれの本文が個別に、合計 N 件出ている
    // （どれか1件へ集約されていない）。
    const matching = externalEvents.filter(
      (entry) => entry.type === 'external_event' && entry.summary.includes('BODY-PAYLOAD-'),
    );
    expect(matching.length).toBe(N);

    await clone.stop();
  });

  it('live の経路は1文字も変わっていない — manager_message の配り直しで「配り直した」の行がいまも単独で出る', async () => {
    const stores = createMemoryStores();
    const event = managerReport(
      '未読のまま残っていた報告',
      'evt-live-unchanged',
      new Date(0).toISOString(),
    );
    await stores.inbox.put(event, event.at);

    const { clone, inputs } = bootClone(stores);
    await waitFor(() => inputs.length > 0, '配り直された報告がターンに渡る');

    const prompt = inputs[0] ?? '';
    expect(prompt).toContain('配り直し');
    expect(prompt).toContain('1 回目の配達');

    const exchanges = await stores.journal.list({ types: ['exchange'] });
    const redelivered = exchanges.find(
      (entry) =>
        entry.type === 'exchange' && entry.text.includes('未読のまま残っていた合図を配り直した'),
    );
    const text = redelivered && redelivered.type === 'exchange' ? redelivered.text : '';
    // **live は「消した」を伴わない単独の行のまま。**
    expect(text).toContain('未読のまま残っていた合図を配り直した');
    expect(text).not.toContain('ターンを起こさずに消した');

    await clone.stop();
  });

  it('後始末（settled と pendingCollapse）が一括経路でも起きている', async () => {
    const stores = createMemoryStores();
    // **同じ内容（同じ collapse key）を持つ2件の stale**——`#pendingCollapse`
    // の代表（先に見つかった行）がこの一括経路で正しく片付くかを見る。
    const sharedPayload = 'SHARED-COLLAPSE-PAYLOAD';
    const first = staleTokenPoolEvent('evt-collapse-a', '2026-08-06T00:00:00.000Z', sharedPayload);
    const second = staleTokenPoolEvent('evt-collapse-b', '2026-08-06T00:00:01.000Z', sharedPayload);
    await stores.inbox.put(first, first.at);
    await stores.inbox.put(second, second.at);

    const { clone } = bootClone(stores);
    await waitFor(async () => (await stores.inbox.peekPending()).length === 0, '両方消える');

    // **settled（inbox_flow）**: stale の消し込みはターンを起こさないので、
    // 別のターンを1本起こしてから inbox_flow の書き込みを待つ。
    clone.post({
      type: 'human_message',
      id: 'evt-trigger-turn',
      at: new Date().toISOString(),
      text: 'inbox_flow を書かせるための1ターン',
      conversationId: 'conv-settled',
    });
    await waitFor(async () => {
      const entries = await stores.journal.list({ types: ['inbox_flow'] });
      return entries.some(
        (entry) =>
          entry.type === 'inbox_flow' &&
          entry.settled.byType.some((row) => row.type === 'external' && row.count >= 2),
      );
    }, 'inbox_flow が settled=2件以上の external を報告する');

    // **pendingCollapse**: 代表（先に拾われた行）が消えた後、同じ内容の
    // 「新しい」token-pool 合図を post しても、消えた行の幻へ畳まれない。
    //
    // ⚠️ **「新しい external_event が増えるか」では判定できない**（実測で
    // 見つけた自分の設計ミス）。`#foldIntoPendingCollapse` の `row-folded`
    // 判定（畳まれた場合）は `post()` を early return させず、その場では
    // 「畳んだ」の1行を書くだけでそのまま待ち行列へ積む——結局そのターンが
    // 処理されるときに束ね読み（`#mergedExternalBatch`）が本文を書くので、
    // 畳まれていても畳まれていなくても、いずれ `external_event` は増える。
    // **畳まれたかどうかを直接分けるのは「畳んだ」の1行が post() の時点で
    // 即座に出るかどうかである**（`#foldIntoPendingCollapse` の
    // `row-folded` 分岐、逐語は
    // `grep -Fn -- 'alteroid 自身が合成した同一本文の未読が既に受信箱にあるので' packages/core/src/clone.ts`）
    // ——`#pendingCollapse` の鍵が消えた行を指したまま残っていれば、post()
    // が同期的にこの行を書く。消えていれば、post() はこの行を一切書かず、
    // 新しい代表として索引に登録するだけで通過する。
    const before = await stores.journal.list({ types: ['exchange'] });
    const beforeFoldedCount = before.filter(
      (entry) => entry.type === 'exchange' && entry.text.includes('受信箱の行は増やさずに畳んだ'),
    ).length;

    clone.post(staleTokenPoolEvent('evt-collapse-fresh', new Date().toISOString(), sharedPayload));
    // **`post()` は同期関数** なので、畳まれるなら `journal` への `void` 呼び出し
    // 自体はこの行の直後に発行済みである（書き込みの完了までは待たない—
    // `#journal` は best-effort）。ここでは十分な猶予（`waitFor` の既定
    // タイムアウト）だけ置いて、増えていないことを確認する。
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterFolded = await stores.journal.list({ types: ['exchange'] });
    const afterFoldedCount = afterFolded.filter(
      (entry) => entry.type === 'exchange' && entry.text.includes('受信箱の行は増やさずに畳んだ'),
    ).length;
    expect(afterFoldedCount).toBe(beforeFoldedCount);

    await clone.stop();
  });

  it('拾い直しの途中で器が畳まれても、消えた分だけが消えた一貫した状態で止まる（#stopped / #inbox.closed を毎周見る性質を壊していない）', async () => {
    const base = createMemoryStores();
    const N = 3000;
    // **`Date` のミリ秒フィールドは999を超えると繰り上がる**（`new Date(y, m,
    // d, h, min, s, ms)` の `ms` は0-999想定）——最初の版はここで
    // `i`（0..2999）をそのまま `ms` に渡し、1000件ごとに秒が繰り上がって
    // 同じ `at` を持つ行が複数できていた（`at` は日誌の逐語照合に使うので、
    // 衝突すると別の record の行を自分の行と誤認する）。**epoch ミリ秒へ
    // `i` をそのまま足す形にすれば、フィールドの繰り上がりを起こさずに
    // 3000件すべてが一意の `at` を持つ。**
    const baseEpochMs = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
    const atForIndex = (i: number): string => new Date(baseEpochMs + i).toISOString();
    const ids = Array.from({ length: N }, (_, i) => `evt-crash-${i}`);
    for (const [i, id] of ids.entries()) {
      const at = atForIndex(i);
      await base.inbox.put(staleTokenPoolEvent(id, at, i), at);
    }

    // **`removeMany` は N=3000 では上限（65,535）に届かないので、
    // ストアへの一括消し込みはループの末尾で1回だけ起きる。** それより前
    // ——ループが1件ずつ日誌を書いている最中——に `stop()` を割り込ませない
    // と、常に「全部消えた後」しか観測できない（`waitFor` によるポーリングは
    // 粒度が粗く、その一瞬を狙って止めるには使えなかった。実測: 最初の版は
    // ここが `expect(remainingIds.size).toBeGreaterThan(0)` で落ち、
    // `removedIds.length === N` だった）。
    //
    // ⟹ **日誌への書き込みそのものに割り込んで、ちょうど良いタイミングで
    // 同期的に `stop()` を起こす。** ポーリングの粒度に頼らない。
    // `clone` は `stores` を組み立てた後にしか作れないので、割り込み側からは
    // 箱越しに触る（`let` で受けると代入が1回きりで `prefer-const` に当たる）。
    const cloneRef: { current: CloneHost | undefined } = { current: undefined };
    let stopPromise: Promise<void> | undefined;
    let droppedSoFar = 0;
    const STOP_AFTER = 500;
    const stores: Stores = {
      ...base,
      journal: {
        ...base.journal,
        async append(entry) {
          const result = await base.journal.append(entry);
          if (
            stopPromise === undefined &&
            entry.type === 'exchange' &&
            entry.text.includes('ターンを起こさずに消した')
          ) {
            droppedSoFar += 1;
            if (droppedSoFar >= STOP_AFTER && cloneRef.current !== undefined) {
              stopPromise = cloneRef.current.stop();
            }
          }
          return result;
        },
      },
    };

    const booted = bootClone(stores);
    cloneRef.current = booted.clone;

    await waitFor(() => stopPromise !== undefined, 'stop() が割り込みで起こされる');
    await stopPromise;

    const remaining = await base.inbox.peekPending();
    const remainingIds = new Set(remaining.map((r) => r.event.id));
    const removedIds = ids.filter((id) => !remainingIds.has(id));

    // 本当に「途中」だったことの確認（全部消えても、1件も消えなくてもいけない）。
    expect(removedIds.length).toBeGreaterThan(0);
    expect(remainingIds.size).toBeGreaterThan(0);

    const exchanges = await stores.journal.list({ types: ['exchange'] });
    const droppedTexts = exchanges
      .filter(
        (entry) => entry.type === 'exchange' && entry.text.includes('ターンを起こさずに消した'),
      )
      .map((entry) => (entry.type === 'exchange' ? entry.text : ''));

    const atOf = (id: string): string => atForIndex(ids.indexOf(id));

    // **一貫性(正方向)**: 消えた id は、必ず「消した」の日誌を伴っている
    // ——ストアから消えたのに日誌に跡が無い、という食い違いが無い。
    for (const id of removedIds) {
      const at = atOf(id);
      expect(droppedTexts.some((text) => text.includes(at))).toBe(true);
    }
    // **一貫性(逆方向)**: 残っている id については「消した」の日誌が絶対に
    // 無い——日誌が「消した」と言っているのにストアにまだ在る、という
    // 食い違いが無い（`flushStaleRemovalBuffer` を早期 return の手前に
    // 必ず挟んでいることの直接の証拠）。
    for (const id of remainingIds) {
      const at = atOf(id);
      expect(droppedTexts.some((text) => text.includes(at))).toBe(false);
    }
  }, 30_000);
});
