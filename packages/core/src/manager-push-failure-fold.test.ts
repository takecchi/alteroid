import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PUSH_FAILURE_FOLD_IDLE_GAP_MS, WITHHELD_ENV_KEYS, createManagerPool } from './manager.js';
import { createCredentialService } from './credential-service.js';
import { createProfileService } from './profile-service.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores } from './testing.js';

/**
 * **押し込みの挑み直しが積む同じ失敗の行を、日誌へ1行にまとめる**（issue #1311）。
 *
 * 押し込みに失敗した runner へは、`#retryFailedPushes` が諦めずに挑み直す（間隔は
 * 60秒で頭打ち）。直らない障害では毎分1行の同じ「〜を降ろせなかった」が積まれ続ける。
 *
 * ## ⚠️ 測り分けたいこと（畳みすぎと畳み足りないの両方）
 *
 * 「減った」だけを測ると、**黙って失う**側の壊れ方が緑のまま通る。だから
 * **試行の回数（`setProfile` の呼び出し回数）を物差しにして、書いた行と要約の件数の
 * 合計が回数に一致する**ことを測る（畳みすぎ＝合計が足りない、畳み足りない＝生の行が多い）。
 * 要約は畳んだ本文を丸ごと載せるので、**要約の行は生の行として数えない**
 * （数え方を間違えると「本物2行」と「1行＋要約」が区別できない型になる）。
 */

const FOLD_FRAGMENT = '同じ合図が続いたので畳んだ';
const FAILURE_FRAGMENT = '実行環境プロファイルを置けなかった';

function fakeSdk(): typeof sdkQuery {
  return ((input: { options: Options }) => {
    void input;
    let finish: (() => void) | undefined;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        uuid: 'uuid-1',
      } as unknown as SDKMessage;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

async function setup() {
  const stores = createMemoryStores();
  // 何か置く（無いと `syncRunner` が「要らない」で `null` を返し、`setProfile` が呼ばれない）。
  await stores.profile.set('default', 'export A=1', 'all');
  const runner = createLocalRunner({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    queryFn: fakeSdk(),
    env: { PATH: '/usr/bin' },
  });
  const registry = createRunnerRegistry([runner]);
  const profile = createProfileService({ stores, runners: registry });
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: registry,
    profile,
    credentials: createCredentialService({
      stores,
      runners: registry,
      withheldEnvKeys: [...WITHHELD_ENV_KEYS],
    }),
  });
  return { stores, runner, pool, profile };
}

async function textsOf(stores: Awaited<ReturnType<typeof setup>>['stores']) {
  const entries = await stores.journal.list({ types: ['exchange'], limit: 10_000 });
  return entries.flatMap((entry) => ('text' in entry ? [entry.text] : []));
}

/** 畳んだ要約の行か（要約は畳んだ本文を丸ごと載せるので、生の行の数え方から除く）。 */
const isSummary = (text: string) => text.includes(FOLD_FRAGMENT);
/** 要約の「2回目以降を N 回ぶん」の N。 */
const suppressedOf = (text: string) => Number(/2回目以降を (\d+) 回ぶん/.exec(text)?.[1] ?? 0);

describe('押し込みの失敗の行の畳み込み（#1311）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('直らない失敗: 生の行は1本だけ、残りは要約に数えられ、試行の回数と合計が一致する', async () => {
    const { stores, runner, pool } = await setup();
    let attempts = 0;
    runner.setProfile = async () => {
      attempts += 1;
      return { ok: false, error: 'profile sync failed (test, persistent)' };
    };

    await pool.start({ request: '走る' });
    // 挑み直しは 2,4,8,16,32,60,60,… 秒。20分で十分に反復する。
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    // 反復が実際に起きていること（起きていなければ、この歯は何も測っていない）。
    expect(attempts).toBeGreaterThan(10);
    await pool.stop();

    const texts = (await textsOf(stores)).filter((t) => t.includes(FAILURE_FRAGMENT));
    const raw = texts.filter((t) => !isSummary(t));
    const summaries = texts.filter(isSummary);

    // 畳み足りない: 生の行は1本（初回）だけ。
    expect(raw).toHaveLength(1);
    // 畳みすぎ: 生の行 + 要約が数えた件数 == 試行の回数（1回も失っていない）。
    expect(raw.length + summaries.reduce((sum, t) => sum + suppressedOf(t), 0)).toBe(attempts);
  });

  it('理由が変わったら、畳まずに新しい行として書く（畳みすぎの検出）', async () => {
    const { stores, runner, pool } = await setup();
    let attempts = 0;
    runner.setProfile = async () => {
      attempts += 1;
      return { ok: false, error: attempts <= 4 ? 'reason A (test)' : 'reason B (test)' };
    };

    await pool.start({ request: '走る' });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    await pool.stop();

    const texts = (await textsOf(stores)).filter((t) => t.includes(FAILURE_FRAGMENT));
    const raw = texts.filter((t) => !isSummary(t));
    expect(raw.filter((t) => t.includes('reason A (test)'))).toHaveLength(1);
    expect(raw.filter((t) => t.includes('reason B (test)'))).toHaveLength(1);
  });

  it('直ったら畳んだ分を要約で吐く。その後の失敗は1件目として必ず書く', async () => {
    const { stores, runner, pool, profile } = await setup();
    let attempts = 0;
    let broken = true;
    runner.setProfile = async () => {
      attempts += 1;
      if (broken) return { ok: false, error: 'profile sync failed (test, transient)' };
      return { ok: true };
    };

    await pool.start({ request: '走る' });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const failedAttempts = attempts;
    expect(failedAttempts).toBeGreaterThan(4);

    // 直る。次の挑み直しで成功し、連なりが閉じて要約が出る（止める前に出ている）。
    broken = false;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(pool.pushHealthOf('runner-test')?.profile?.status).toBe('ok');

    const afterRecovery = (await textsOf(stores)).filter((t) => t.includes(FAILURE_FRAGMENT));
    expect(afterRecovery.filter(isSummary).reduce((sum, t) => sum + suppressedOf(t), 0)).toBe(
      failedAttempts - 1,
    );

    // また壊れたとき（同じ本文）は、前の連なりに吸われず1件目として書かれる。
    // （即時の配布 `apply` が失敗すると、帳面が failed になり、挑み直しが予約される。）
    broken = true;
    await profile.apply('export DUMMY_SETTING=not-a-secret');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await pool.stop();
    const all = (await textsOf(stores)).filter(
      (t) => t.includes(FAILURE_FRAGMENT) && !isSummary(t),
    );
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it('畳む空きは挑み直しの上限（60秒）より長い（既定の60秒だと毎回途切れて何も畳まれない）', () => {
    expect(PUSH_FAILURE_FOLD_IDLE_GAP_MS).toBeGreaterThan(60_000);
  });
});
