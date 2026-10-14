import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry, type RunnerClient } from './runner-protocol.js';
import { createMemoryStores } from './testing.js';

// 鍵の回転で runner へ撒き損ねたら、繋ぎ直しを待たずに撒き直す（#4725）
describe('回転で runner へ撒き損ねた鍵の撒き直し（#4725）', () => {
  it('⭐ 撒き損ねた runner を帳面に載せ、挑み直しで鍵を降ろし直す', async () => {
    const runner = createLocalRunner({
      runnerId: 'runner-test',
      workspacePath: '/work/project',
      queryFn: (() => {
        throw new Error('この試験では SDK を呼ばない');
      }) as never,
      env: {},
    });
    const synced: string[] = [];
    let listener:
      ((results: readonly { runnerId: string; ok: boolean; error?: string }[]) => void) | undefined;
    const pool = createManagerPool({
      stores: createMemoryStores(),
      post: () => undefined,
      runners: createRunnerRegistry([runner]),
      syncRunnerToken: async (client: RunnerClient) => {
        synced.push(client.runnerId);
      },
      agentTokenPushes: {
        onPushed(next) {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      },
    });
    await pool.restore();
    // 繋ぎの時の降ろしが済んで落ち着くのを待ってから数える: 遅れて走る降ろしを撒き直しと取り違えないため
    await expect.poll(() => synced.length, { timeout: 5_000 }).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const atConnect = synced.length;

    listener?.([{ runnerId: 'runner-test', ok: false, error: 'runner が応答しない' }]);

    await expect
      .poll(() => synced.length, { timeout: 5_000, interval: 100 })
      .toBeGreaterThan(atConnect);
    expect(synced.at(-1)).toBe('runner-test');
    await pool.stop();
  }, 15_000);
});
