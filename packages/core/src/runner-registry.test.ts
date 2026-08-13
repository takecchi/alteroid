import type { query as sdkQuery, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
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
function fakeSdk(): typeof sdkQuery {
  return ((params: { prompt: unknown }) => {
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
});
