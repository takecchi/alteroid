import { describe, expect, it } from 'vitest';

import { EXCHANGE_KIND_THINNING_PREFIX } from './exchange-kind.js';
import { decideInitiativeTick, INITIATIVE_DAILY_CHECK_MS } from './initiative-gate.js';
import { waitForExpect, setup } from './clone-test-harness.js';
import type { Task } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { turnInputEntry } from './turn-input.js';

// #5469 P6a: 発意 tick を、動ける仕事があるときと1日1回の点検（と手で起こした回）に限る門

let counter = 0;
function makeTask(over: Partial<Task> = {}): Task {
  counter += 1;
  const at = new Date().toISOString();
  return {
    id: `task-${counter}`,
    createdAt: at,
    updatedAt: at,
    status: 'queued',
    origin: 'self',
    title: `title-${counter}`,
    body: 'body',
    ...over,
  };
}

async function recordTickTurn(stores: Stores): Promise<string> {
  const entry = await stores.journal.append(
    turnInputEntry({ type: 'self_initiative', reason: '定期 tick', cause: 'schedule', digest: '' }),
  );
  return entry.at;
}

const schedule = (now: Date = new Date()) => ({ cause: 'schedule' as const, now });

describe('decideInitiativeTick（発意 tick の門）', () => {
  it('(d) 手で起こした回は、動ける仕事が無く直近に回していても常に回す', async () => {
    const stores = createMemoryStores();
    await recordTickTurn(stores);
    expect(await decideInitiativeTick(stores, { cause: 'manual', now: new Date() })).toEqual({
      run: true,
      because: 'manual',
    });
  });

  it('(a) 待ち行列に queued が1件あれば回す', async () => {
    const stores = createMemoryStores();
    await recordTickTurn(stores);
    await stores.tasks.add(makeTask({ status: 'queued' }));
    expect(await decideInitiativeTick(stores, schedule())).toEqual({
      run: true,
      because: 'movable_task',
    });
  });

  it('(a) needs_decision が1件あれば回す', async () => {
    const stores = createMemoryStores();
    await recordTickTurn(stores);
    await stores.tasks.add(makeTask({ status: 'needs_decision' }));
    expect(await decideInitiativeTick(stores, schedule())).toEqual({
      run: true,
      because: 'movable_task',
    });
  });

  it('(a) waiting だけなら回さず、畳んだ跡に件数と直近の tick の時刻が載る', async () => {
    const stores = createMemoryStores();
    const lastTickAt = await recordTickTurn(stores);
    await stores.tasks.add(makeTask({ status: 'waiting' }));
    await stores.tasks.add(makeTask({ status: 'waiting' }));
    expect(await decideInitiativeTick(stores, schedule())).toEqual({
      run: false,
      queued: 0,
      needsDecision: 0,
      waiting: 2,
      lastTickAt,
    });
  });

  it('(a) 閉じた task（done）は動ける仕事に数えない', async () => {
    const stores = createMemoryStores();
    await recordTickTurn(stores);
    await stores.tasks.add(makeTask({ status: 'done', closedAt: new Date().toISOString() }));
    expect((await decideInitiativeTick(stores, schedule())).run).toBe(false);
  });

  it('(b) 旧台帳に、同じ id の task が無い開いた行があれば回す', async () => {
    const stores = createMemoryStores();
    await recordTickTurn(stores);
    await stores.commitments.open({
      id: 'cm-legacy',
      at: new Date().toISOString(),
      origin: 'human',
      body: '旧台帳だけに在る行',
    });
    expect(await decideInitiativeTick(stores, schedule())).toEqual({
      run: true,
      because: 'legacy_ledger_open',
    });
  });

  it('(b) 旧台帳の行に同じ id の task が（閉じていても）在れば数えない', async () => {
    const stores = createMemoryStores();
    await recordTickTurn(stores);
    await stores.commitments.open({
      id: 'shared-id',
      at: new Date().toISOString(),
      origin: 'human',
      body: '人間の依頼',
    });
    await stores.tasks.add(
      makeTask({ id: 'shared-id', status: 'done', closedAt: new Date().toISOString() }),
    );
    expect((await decideInitiativeTick(stores, schedule())).run).toBe(false);
  });

  it('(c) 直近24時間に発意 tick のターンが無ければ、動ける仕事が無くても回す', async () => {
    const stores = createMemoryStores();
    expect(await decideInitiativeTick(stores, schedule())).toEqual({
      run: true,
      because: 'daily_check',
    });
  });

  it('(c) 回した印の行が24時間より古ければ回す。24時間以内なら回さない', async () => {
    const stores = createMemoryStores();
    await recordTickTurn(stores);
    const now = new Date();
    expect((await decideInitiativeTick(stores, schedule(now))).run).toBe(false);
    const later = new Date(now.getTime() + INITIATIVE_DAILY_CHECK_MS + 60_000);
    expect(await decideInitiativeTick(stores, schedule(later))).toEqual({
      run: true,
      because: 'daily_check',
    });
  });

  it('(c) 回さずに畳んだ行（[間引き]）は「回した印」に数えない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text: `${EXCHANGE_KIND_THINNING_PREFIX}動ける仕事が無い発意 tick なので、ターンを起こさずに畳んだ。ターンの入力: self_initiative という語を含んでいても数えない`,
    });
    expect(await decideInitiativeTick(stores, schedule())).toEqual({
      run: true,
      because: 'daily_check',
    });
  });

  describe('判定に要る読みが失敗したら、回す側へ倒す', () => {
    async function readyToSkip(): Promise<Stores> {
      const stores = createMemoryStores();
      await recordTickTurn(stores);
      expect((await decideInitiativeTick(stores, schedule())).run).toBe(false);
      return stores;
    }
    const boom = () => Promise.reject(new Error('読めない（試験）'));

    it('tasks が読めない', async () => {
      const base = await readyToSkip();
      const stores: Stores = { ...base, tasks: { ...base.tasks, list: boom } };
      expect(await decideInitiativeTick(stores, schedule())).toEqual({
        run: true,
        because: 'read_failed',
      });
    });

    it('旧台帳が読めない', async () => {
      const base = await readyToSkip();
      const stores: Stores = { ...base, commitments: { ...base.commitments, list: boom } };
      expect(await decideInitiativeTick(stores, schedule())).toEqual({
        run: true,
        because: 'read_failed',
      });
    });

    it('日誌が読めない', async () => {
      const base = await readyToSkip();
      const stores: Stores = { ...base, journal: { ...base.journal, list: boom } };
      expect(await decideInitiativeTick(stores, schedule())).toEqual({
        run: true,
        because: 'read_failed',
      });
    });

    it('読めない task の行が在る（動ける task かもしれない）', async () => {
      const base = await readyToSkip();
      const stores: Stores = {
        ...base,
        tasks: {
          ...base.tasks,
          list: () =>
            Promise.resolve({
              entries: [],
              unreadable: [{ id: 'broken', error: '壊れている' }] as never,
            }),
        },
      };
      expect(await decideInitiativeTick(stores, schedule())).toEqual({
        run: true,
        because: 'read_failed',
      });
    });
  });
});

describe('クローン — 発意 tick の門', () => {
  const tickEvent = (id: string, cause?: 'manual') =>
    ({
      type: 'self_initiative' as const,
      id,
      at: new Date().toISOString(),
      reason: '定期 tick',
      ...(cause === undefined ? {} : { cause }),
    }) as const;

  it('動ける仕事が無く直近に回していた定期 tick は、モデルを呼ばず、日誌に1行を残し、合図は処理済みになる', async () => {
    const stores = createMemoryStores();
    const lastTickAt = await recordTickTurn(stores);
    await stores.tasks.add(makeTask({ status: 'waiting' }));
    const s = setup(() => '呼ばれてはいけない', stores);

    s.clone.post(tickEvent('evt-gated'));

    const skipLine = async (): Promise<string[]> =>
      ((await stores.journal.list({ types: ['exchange'] })) as { with: string; text: string }[])
        .filter(
          (e) =>
            e.with === 'self' &&
            e.text.startsWith(`${EXCHANGE_KIND_THINNING_PREFIX}動ける仕事が無い発意 tick`),
        )
        .map((e) => e.text);
    await waitForExpect(
      async () => expect(await skipLine()).toHaveLength(1),
      '畳んだ跡が日誌に1行残る',
    );
    const [line] = await skipLine();
    expect(line).toContain('queued=0 needs_decision=0 waiting=1');
    expect(line).toContain(`直近に発意 tick のターンを回した時刻: ${lastTickAt}`);
    expect(line).toContain('モデルへは1文字も渡していない');

    await waitForExpect(
      async () => expect((await stores.inbox.pending()).count).toBe(0),
      '合図が処理済みになる（配り直されない）',
    );
    expect(s.calls.flatMap((call) => call.inputs)).toEqual([]);

    await s.clone.stop();
  });

  it('動ける task が在る定期 tick は、モデルのターンとして回る', async () => {
    const stores = createMemoryStores();
    await recordTickTurn(stores);
    await stores.tasks.add(makeTask({ status: 'queued' }));
    const s = setup(() => '動く', stores);

    s.clone.post(tickEvent('evt-open'));

    await waitForExpect(
      () =>
        expect(s.calls.flatMap((call) => call.inputs).join('\n')).toContain('次にやることがあるか'),
      'tick の入力がモデルへ届く',
    );

    await s.clone.stop();
  });

  it('手で起こした tick は、動ける仕事が無く直近に回していても回る', async () => {
    const stores = createMemoryStores();
    await recordTickTurn(stores);
    const s = setup(() => '動く', stores);

    s.clone.post(tickEvent('evt-manual', 'manual'));

    await waitForExpect(
      () =>
        expect(s.calls.flatMap((call) => call.inputs).join('\n')).toContain('次にやることがあるか'),
      'tick の入力がモデルへ届く',
    );

    await s.clone.stop();
  });
});
