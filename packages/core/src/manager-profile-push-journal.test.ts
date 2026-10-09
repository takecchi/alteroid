// `output`（評価の生 stderr）には、構文エラーのエコーやデバッグ用 echo でプロファイル本文の鍵の値が乗りうる。
// 日誌は永続化されるので、`output` は日誌へ書かず長さだけを書く。
import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { WITHHELD_ENV_KEYS, createManagerPool, type ManagerPool } from './manager.js';
import { createCredentialService } from './credential-service.js';
import { createProfileService } from './profile-service.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry, type RunnerClient } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

function fakeSdk() {
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    let emit: ((message: SDKMessage) => void) | null = null;
    const buffered: SDKMessage[] = [];

    void (async () => {
      for await (const input of params.prompt as AsyncIterable<unknown>) {
        void input;
      }
    })();

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => {
        if (emit) emit(null as unknown as SDKMessage);
      },
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn };
}

function setup(stores: Stores): { pool: ManagerPool; runner: RunnerClient } {
  const { fn } = fakeSdk();
  const inbox: InboxEvent[] = [];
  const runner = createLocalRunner({
    runnerId: 'runner-bughunt',
    workspacePath: '/work/project',
    queryFn: fn,
    env: { PATH: '/usr/bin', ALTEROID_HOME: '/secret' },
  });
  const registry = createRunnerRegistry([runner]);
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    credentials: createCredentialService({
      stores,
      runners: registry,
      withheldEnvKeys: [...WITHHELD_ENV_KEYS],
    }),
  });
  return { pool, runner };
}

describe('#pushProfile の失敗経路は、プロファイルの出力を日誌へ書かない', () => {
  it('runner の setProfile が返す output に含まれるダミーの鍵の値が、日誌に残らない（長さだけが残る）', async () => {
    const stores = createMemoryStores();
    // 何か置いておく: 無いと `syncRunner` が `null` を返し、`runner.setProfile` 自体が呼ばれない。
    await stores.profile.set('default', 'export A=1', 'all');
    const { pool, runner } = setup(stores);

    // 本物の鍵は使わない: ダミー値だけの fixture。
    const DUMMY_SECRET = 'dummy-topsecret-9f21ac';
    runner.setProfile = async () => ({
      ok: false,
      error: 'profile sync failed (test)',
      output: `sh: 1: export GH_TOKEN=${DUMMY_SECRET}: 構文エラー（fixture）`,
    });

    await pool.start({ request: '調べて' });
    await pool.stop();

    const entries = await stores.journal.list({ types: ['exchange'] });
    const leaking = entries.filter((entry) => 'text' in entry && entry.text.includes(DUMMY_SECRET));

    expect(leaking).toEqual([]);
    const failed = entries.filter(
      (entry) => 'text' in entry && entry.text.includes('実行環境プロファイルを置けなかった'),
    );
    expect(failed.length).toBeGreaterThan(0);
    expect(
      failed.every((entry) => 'text' in entry && entry.text.includes('profile sync failed (test)')),
    ).toBe(true);
    expect(
      failed.every(
        (entry) => 'text' in entry && /プロファイルの出力 \d+ 文字は記録しない/.test(entry.text),
      ),
    ).toBe(true);
  });
});
