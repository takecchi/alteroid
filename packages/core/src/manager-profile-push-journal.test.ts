/**
 * **#pushProfile の失敗経路は、runner から返って来た `output`（評価の生 stderr）を
 * 日誌へ書かない。長さだけを書く。** かつてはそのまま journal（`stores.journal`、
 * `with: 'self'` の exchange）へ埋め込んでいた。
 *
 * ## 何が起きるか
 *
 * `runner-protocol.ts` の `RunnerProfileResult.output` は「プロファイルが出した
 * 出力（人間が原因を見るための窓）」であり、**評価に使ったシェルの生の stderr
 * がそのまま乗る**（`profile.ts` の `evaluateProfile` の doc: 「本文の標準出力は
 * 捨てずに stderr 側へ寄せる」）。プロファイルの本文には鍵が入りうる
 * （`.claude/skills/env-profile/SKILL.md` 「本文には鍵の値が入っている」）ので、
 * 本文の書き間違い（構文エラーでシェルが該当行をそのままエコーする）や、本文
 * 自身のデバッグ用 echo によって、**この `output` に鍵の値そのものが乗ることが
 * ある**。
 *
 * クローンの道具 `profile_write` の成功時は「値は記録しない」と明言してこの
 * 窓をその場の応答（tool result）としてのみ返し、journal には要約（`summary`）
 * だけを書く。ところが `manager.ts` の `#pushProfile` は、runner への配布が
 * **失敗**したときに `result.output` を検閲・抜粋なしでそのまま
 * `this.#journal({ type: 'exchange', with: 'self', ... })` に埋め込む。この
 * journal は永続化され、`journal_read` 道具で後からクローン自身にも読めるし、
 * 人間の日誌閲覧経路からも見える——「その場の応答」という約束の外へ、鍵の値が
 * 永続的な記録として漏れる。
 *
 * この歯は本物の鍵・本物のシェルを一切使わない。`RunnerClient.setProfile` を
 * ダミー値入りの `output` を返すスタブに差し替え、`manager.ts` の
 * `#pushProfile`（`grep -Fn -- 'async #pushProfile' packages/core/src/manager.ts`）
 * だけを起こして journal を覗く。
 */
import type {
  query as sdkQuery,
  CanUseTool,
  HookCallbackMatcher,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { WITHHELD_ENV_KEYS, createManagerPool, type ManagerPool } from './manager.js';
import { createCredentialService } from './credential-service.js';
import { createProfileService } from './profile-service.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry, type RunnerClient } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * `manager.test.ts` の `fakeSdk` / `setup` を最小限に切り詰めた写し。
 *
 * SDK を実際には起こさず、`pool.start` が `#connectTo` → `#pushProfile` まで
 * 進めるのに足りるだけの受け答えを用意する。
 */
function fakeSdk() {
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    let emit: ((message: SDKMessage) => void) | null = null;
    const buffered: SDKMessage[] = [];

    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };

    void (async () => {
      for await (const _ of params.prompt as AsyncIterable<unknown>) {
        // クローンからの入力は読み捨てる。この歯は委譲の中身を見ない。
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
      env: {},
    }),
  });
  return { pool, runner };
}

describe('#pushProfile の失敗経路は、プロファイルの出力を日誌へ書かない', () => {
  it('runner の setProfile が返す output に含まれるダミーの鍵の値が、日誌に残らない（長さだけが残る）', async () => {
    const stores = createMemoryStores();
    // **何か置いておく。** 置いていないと `syncRunner` が「同期の必要なし」で
    // `null` を返し、`runner.setProfile` 自体が呼ばれない
    // （`manager.test.ts` の「押し込みに失敗した runner」と同じ前提）。
    await stores.profile.write('export A=1');
    const { pool, runner } = setup(stores);

    // **本物の鍵は使わない。** ダミー値だけの fixture ——実際の壊れ方
    // （本文の構文エラーでシェルが該当行をそのままエコーする / 本文自身の
    // デバッグ用 echo）を模した、runner 側の評価結果のスタブ。
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

    // **日誌に鍵の値そのものが残らない。**
    expect(leaking).toEqual([]);
    // **置けなかったこと・理由・出力の長さは残る**（黙って消さない）。
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
