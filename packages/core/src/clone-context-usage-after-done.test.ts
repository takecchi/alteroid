import { describe, expect, it } from 'vitest';
import { setup, waitFor, waitForDone } from './clone-test-harness.js';
import { createMemoryStores, humanMessage } from './testing.js';
import type { Stores } from './store.js';

// ターン終わりの `getContextUsage`（最大 10s）を待たずに `done` を出し、`context_usage` は後から書く。
// 観測の回数も行の中身も変えない。変えるのは「待ち」と、日誌上の行の順（`context_usage` が `done` より後になりうる）だけ。
const usage = { totalTokens: 12_000, rawMaxTokens: 200_000, percentage: 6 };
const reply = () => 'はい';

/** 実時間で待たず、イベントループを数周回す（unhandled rejection の通知もこの間に出る）。 */
async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

async function rowsOf(stores: Stores) {
  const entries = await stores.journal.list({ types: ['context_usage'], order: 'asc' });
  return entries.flatMap((entry) => (entry.type === 'context_usage' ? [entry] : []));
}

describe('クローン — context_usage は done の後ろで取って書く', () => {
  it('⭐ getContextUsage が返らなくても done は出て、返った後で同じ中身の context_usage が書かれる', async () => {
    const g = gate();
    const stores = createMemoryStores();
    const s = setup(reply, stores, {
      getContextUsage: async () => {
        await g.opened;
        return usage;
      },
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    // done が出た時点では観測は返っていない（待っていたら、ここへ来られない）
    expect(await rowsOf(stores)).toHaveLength(0);

    g.open();
    await waitFor(async () => (await rowsOf(stores)).length === 1, 'context_usage の行が書かれる');
    const [row] = await rowsOf(stores);
    expect(row?.turnSucceeded).toBe(true);
    expect(row?.contextUsage).toEqual({ durationMs: expect.any(Number), ...usage });

    await s.clone.stop();
  });

  it('観測が失敗しても done は出て、error 付きの行が今までどおり書かれる', async () => {
    const stores = createMemoryStores();
    const s = setup(reply, stores, {
      getContextUsage: () => {
        throw new Error('観測に失敗（テスト用）');
      },
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    await waitFor(async () => (await rowsOf(stores)).length === 1, 'context_usage の行が書かれる');
    const [row] = await rowsOf(stores);
    expect(row?.contextUsage.error).toBeDefined();

    await s.clone.stop();
  });

  it('期限（contextUsageTimeoutMs）を過ぎたら、返らなかった旨の error 付きの行が書かれる', async () => {
    const stores = createMemoryStores();
    const s = setup(
      reply,
      stores,
      { getContextUsage: () => new Promise(() => undefined) },
      {},
      { contextUsageTimeoutMs: 30 },
    );

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    await waitFor(async () => (await rowsOf(stores)).length === 1, 'context_usage の行が書かれる');
    const [row] = await rowsOf(stores);
    expect(row?.contextUsage.error).toContain('返らなかった');

    await s.clone.stop();
  });

  it('⭐ 連続した2ターンで、観測は重ならず、ターンの順に書かれる', async () => {
    const gates = [gate(), gate()];
    let inFlight = 0;
    let maxInFlight = 0;
    let reads = 0;
    const stores = createMemoryStores();
    const s = setup(reply, stores, {
      getContextUsage: async () => {
        const index = reads;
        reads += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gates[index]?.opened;
        inFlight -= 1;
        return { ...usage, totalTokens: 1_000 * (index + 1) };
      },
    });

    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);
    s.clone.post(humanMessage('2回目'));
    await waitFor(
      () => s.events.filter((event) => event.type === 'done').length === 2,
      '2つ目の done が届く（前の観測を待たない）',
    );
    // 1つ目がまだ返っていないので、2つ目の観測は始まっていない
    expect(reads).toBe(1);

    gates[0]?.open();
    await waitFor(() => reads === 2, '1つ目が終わってから2つ目が始まる');
    gates[1]?.open();
    await waitFor(async () => (await rowsOf(stores)).length === 2, '2行書かれる');
    expect(maxInFlight).toBe(1);
    const rows = await rowsOf(stores);
    expect(rows.map((row) => row.contextUsage.totalTokens)).toEqual([1_000, 2_000]);

    await s.clone.stop();
  });

  it('⭐ 観測の途中で stop しても、観測の完了を待ってから閉じ、行は欠けず例外も出ない', async () => {
    const g = gate();
    const stores = createMemoryStores();
    const s = setup(reply, stores, {
      getContextUsage: async () => {
        await g.opened;
        return usage;
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);
      let stopped = false;
      const stopping = s.clone.stop().then(() => {
        stopped = true;
      });
      await settle();
      // 観測が返るまで、stop はセッションを閉じずに待つ
      expect(stopped).toBe(false);
      g.open();
      await stopping;
      // 1行目は止める前のターンの観測。stop の蒸留のターン（shutdown）の観測が2行目に続く（以前と同じ）
      const rows = await rowsOf(stores);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0]?.contextUsage.error).toBeUndefined();
      expect(rows[0]?.contextUsage.totalTokens).toBe(usage.totalTokens);
      await settle();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('最初のターンの ToolSearch の観測も、done の後ろで1回だけ渡る', async () => {
    const g = gate();
    const lines: string[] = [];
    const s = setup(
      reply,
      createMemoryStores(),
      {
        getContextUsage: async () => {
          await g.opened;
          return {
            ...usage,
            categories: [{ name: 'MCP tools', tokens: 3_000, kind: 'deferred' }],
          };
        },
      },
      {},
      {
        onFirstTurnToolSearch: (line) => {
          lines.push(line);
          return Promise.resolve();
        },
      },
    );

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    expect(lines).toHaveLength(0);
    g.open();
    await waitFor(() => lines.length === 1, '観測が渡る');
    expect(lines[0]).toContain('MCP の道具は deferred');

    await s.clone.stop();
  });
});
