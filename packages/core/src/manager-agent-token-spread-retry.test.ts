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
    await expect.poll(() => pool.pushHealthOf('runner-test')?.agentToken?.status).toBe('ok');

    listener?.([{ runnerId: 'runner-test', ok: false, error: 'runner が応答しない' }]);

    // 知らせた時点で帳面に失敗として載る（実時間で待たずに見分ける。#2146）: 載らなければ挑み直しの対象にならない
    expect(pool.pushHealthOf('runner-test')?.agentToken?.status).toBe('failed');
    const atFailure = synced.length;
    // 挑み直しで降ろし直され、帳面が ok に戻る
    await expect
      .poll(() => pool.pushHealthOf('runner-test')?.agentToken?.status, { timeout: 5_000 })
      .toBe('ok');
    expect(synced.length).toBeGreaterThan(atFailure);
    expect(synced.at(-1)).toBe('runner-test');
    await pool.stop();
  }, 10_000);
});
