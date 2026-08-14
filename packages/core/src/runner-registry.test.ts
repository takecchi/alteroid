import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry, RunnerHttpError } from './runner-protocol.js';
import type { RunnerClient } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * runner の名簿（roadmap M5）。
 *
 * ここで固定したいのは**名簿が動的である**ことである。デーモンは runner が
 * 上がるのを待たずに走り始め、runner は後から名簿に載る。載る前に届いた委譲が
 * 失敗するのは仕方がないが、**載った後の委譲が届かないのは配線の穴**である。
 *
 * 偽 SDK は runner に渡す（SDK を握るのは runner であって名簿ではない）。
 * `vi.mock` は使わない — 名簿が本物の `RunnerClient` を開けることまで含めて
 * 見たいので、差し替えるのは SDK の口だけにする。
 */
function fakeSdk(sessions: { options: Options }[] = []): typeof sdkQuery {
  return ((params: { prompt: unknown; options?: Options }) => {
    sessions.push({ options: params.options ?? {} });
    let close = (): void => undefined;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-late',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      // クローンからの入力は読み捨てる（ここで見たいのは宛先の決定だけ）。
      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) {
          void message; // 読み続けるだけ
        }
      })();

      // 閉じられるまで走り続ける（畳めないセッションを作るとテストがハングする）。
      await closed;
    }

    return Object.assign(generate(), {
      close: () => close(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

describe('runner の名簿', () => {
  it('後から register した runner へ委譲できる', async () => {
    const stores = createMemoryStores();
    const inbox: InboxEvent[] = [];

    // **空の名簿でデーモンが立ち上がる。** ここが M5 の起点である — runner が
    // 上がるまで待つ形だと、その間 chat も日誌も承認も止まる。
    const registry = createRunnerRegistry();
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: registry,
    });
    expect(await registry.list()).toEqual([]);

    // 名簿が取るのは**開いた接続ではなく開き方**である。これが「runner が上がって
    // いなくても名簿に載せられる」の土台になる（`runnerId` は繋がるまで分からない
    // ので、登録時には要求しない）。
    await registry.register({
      label: '同一プロセス',
      open: async () =>
        createLocalRunner({
          runnerId: 'runner-late',
          workspacePath: '/work/project',
          queryFn: fakeSdk(),
          env: {},
        }),
    });

    const manager = await pool.start({ request: '後から来た runner に頼む' });
    expect(manager.runnerId).toBe('runner-late');
    expect(manager.cwd).toBe('/work/project');

    await pool.stop();
    await registry.stop();
  });

  it('後から register した runner が、台帳に残っていた委譲を引き取る', async () => {
    const stores = createMemoryStores();
    const at = new Date().toISOString();
    // デーモンだけが先に上がった状態。runner はまだ居ないが、台帳には走行中の
    // 委譲が残っている（器の入れ替えでも、デーモンの再起動でも起きる形）。
    await stores.jobs.putJob({
      id: 'mgr-old',
      managerId: 'mgr-old',
      createdAt: at,
      updatedAt: at,
      status: 'running',
      summary: '前回から走っている仕事',
      request: '前回から走っている仕事',
      cwd: '/work/project',
      sessionId: 'sess-old',
      runnerId: 'runner-late',
    });

    const inbox: InboxEvent[] = [];
    const registry = createRunnerRegistry();
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: registry,
    });

    const sessions: { options: Options }[] = [];
    await registry.register({
      label: '同一プロセス',
      open: async () =>
        createLocalRunner({
          runnerId: 'runner-late',
          workspacePath: '/work/project',
          queryFn: fakeSdk(sessions),
          env: {},
        }),
    });

    // **名乗り（hello）から取り直しが走る。** 名簿の購読でデーモン側が繋ぎに行く
    // ので、後から現れた runner でも引き取りの契機がある。
    for (let i = 0; i < 100 && sessions.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(sessions[0]?.options.resume).toBe('sess-old');

    await pool.stop();
    await registry.stop();
  });

  it('上がってこない runner を背景で挑み直し、上がったら委譲の宛先になる', async () => {
    let attempts = 0;
    const registry = createRunnerRegistry([], { retryBaseMs: 5, retryMaxMs: 5 });

    // 2回こけてから上がる器（デプロイの最中に起動した、いつもの形）。
    await registry.register({
      label: 'http://runner:4518',
      open: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('fetch failed');
        return createLocalRunner({
          runnerId: 'runner-slow',
          workspacePath: '/work/project',
          queryFn: fakeSdk(),
          env: {},
        });
      },
    });

    // 最初の1回はこけている。**それでも名簿には載っている**（宛先を失わない）。
    expect(registry.entries()).toMatchObject([
      { label: 'http://runner:4518', state: 'unreachable' },
    ]);

    // 猶予の内に上がってくれば、そのまま宛先になる（起動直後の数秒をやり過ごす）。
    const runner = await registry.select({});
    expect(runner.runnerId).toBe('runner-slow');
    expect(attempts).toBe(3);
    expect(registry.entries()).toMatchObject([{ state: 'connected', runnerId: 'runner-slow' }]);

    await runner.close();
    await registry.stop();
  });

  it('挑み直しても直らない失敗は、挑み直さずにクローンへ知らせる', async () => {
    const failures: { label: string; error: string }[] = [];
    let attempts = 0;
    const registry = createRunnerRegistry([], {
      retryBaseMs: 1,
      retryMaxMs: 1,
      notify: (failure) => failures.push(failure),
    });

    await registry.register({
      label: 'http://runner:4518',
      open: async () => {
        attempts += 1;
        // 鍵違い。**同じものを投げ直しても同じ答えが返る。**
        throw new RunnerHttpError('鍵を拒まれた', 401);
      },
    });

    // 挑み直しの間隔をいくら跨いでも、叩き直さない。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attempts).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.label).toBe('http://runner:4518');
    expect(registry.entries()).toMatchObject([{ state: 'unusable' }]);

    // 待っても誰も来ないので、**猶予も使わずに返す**（黙って待つと設定の誤りが隠れる）。
    const started = Date.now();
    await expect(registry.select({})).rejects.toThrow(/どれも使えない/);
    expect(Date.now() - started).toBeLessThan(500);

    await registry.stop();
  });

  /**
   * **返らないことは「黙って引き下がる」と同じ欠陥である。**
   *
   * 繋がるまで待つ形にすると、委譲を呼んだクローンのターンが張り付き、先に listen
   * した意味が消える（詰まる場所が移るだけになる）。宛先が居ないことは隠さずに言う。
   */
  it('繋がっていないときは、猶予を過ぎたら状態を添えて失敗する', async () => {
    const registry = createRunnerRegistry([], {
      retryBaseMs: 10_000,
      retryMaxMs: 10_000,
      selectWaitMs: 50,
    });
    await registry.register({
      label: 'http://runner:4518',
      open: () => Promise.reject(new Error('fetch failed')),
    });

    // 呼んだ側が「少し置いて投げ直す」を選べるだけの材料が要る。
    await expect(registry.select({})).rejects.toThrow(/http:\/\/runner:4518 は unreachable/);
    await expect(registry.select({})).rejects.toThrow(/fetch failed/);
    // **「登録0台」とは別のことを言う**（設定の問題ではないので、対応が変わる）。
    await expect(registry.select({})).rejects.not.toThrow(/1台も登録されていない/);

    await registry.stop();
  });

  it('登録が0台のときは、設定の問題として即座に返す', async () => {
    const registry = createRunnerRegistry();
    const started = Date.now();
    // 時間では直らないので、猶予すら使わない。
    await expect(registry.select({})).rejects.toThrow(/1台も登録されていない/);
    expect(Date.now() - started).toBeLessThan(500);
    await registry.stop();
  });

  it('stop() で背景の挑み直しが畳まれる', async () => {
    let attempts = 0;
    const registry = createRunnerRegistry([], { retryBaseMs: 5, retryMaxMs: 5 });
    await registry.register({
      label: 'http://runner:4518',
      open: async () => {
        attempts += 1;
        throw new Error('fetch failed');
      },
    });

    await registry.stop();
    const after = attempts;
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 畳み残すと、止めたはずのデーモンが背景で runner を叩き続ける。
    expect(attempts).toBe(after);
  });

  it('unregister した runner は宛先から外れる', async () => {
    const registry = createRunnerRegistry();
    let opened: RunnerClient | null = null;
    await registry.register({
      label: '同一プロセス',
      open: async () => {
        opened = createLocalRunner({
          runnerId: 'runner-gone',
          workspacePath: '/work/project',
          queryFn: fakeSdk(),
          env: {},
        });
        return opened;
      },
    });
    expect(await registry.get('runner-gone')).not.toBeNull();

    await registry.unregister('同一プロセス');
    expect(registry.entries()).toEqual([]);
    expect(await registry.list()).toEqual([]);
    expect(await registry.get('runner-gone')).toBeNull();

    await registry.stop();
  });
});
