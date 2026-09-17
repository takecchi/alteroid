import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { createProfileService } from './profile-service.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import type { AgentToken } from './token-pool.js';
import { createMemoryStores } from './testing.js';

/**
 * **`ManagerSummary.resetTimeSkewMatch`**（Issue #914 オーナー提案(2)）。
 *
 * `manager-token-generation.test.ts`（提案1。世代番号の直接比較）とは別の
 * 材料源を固定する——こちらは daemon のプロセス内記憶（`tokenIdentity`）に
 * 一切頼らず、429の文言そのものと `stores.tokens`（DB正本）だけで判定する。
 * ⟹ `tokenIdentity` を配線していない・提案1が「分からない」を返す構成でも
 * 独立に効くことをここで固定する。
 *
 * ## ここが固定するもの
 *
 * 1. ⭐ 降りた鍵の`cooldownUntil`と一致する`reached`通知が届くと、`list()`が
 *    `resetTimeSkewMatch: 'stale'`を返す
 * 2. ⚠️ 現役の鍵自身の`cooldownUntil`と一致すれば`'active'`（世代ずれではない）
 * 3. マネージャーが自力でターンを終える（`failure`無しの`report`）と、
 *    印は`usageStoppedAt`と同じ寿命で下りる
 * 4. `tokenIdentity`を配線していない（＝提案1が終始`pool-not-wired`のまま
 *    何も言えない）構成でも、この判定は独立に効く
 */

const JOB: Job = {
  id: 'mgr-reset',
  managerId: 'mgr-reset',
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-primary',
};

/** `manager-usage-resume.test.ts` の `nudgeRunner()` の縮小版。 */
function fakeRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];

  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start() {
      /* この検証では使わない */
    },
    async resume(command) {
      alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
    },
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      const at = alive.findIndex((state) => state.managerId === managerId);
      if (at >= 0) alive.splice(at, 1);
    },
    async list() {
      return [...alive];
    },
    async transcript() {
      return null;
    },
    async credentials() {
      return [];
    },
    async setCredentials() {
      return [];
    },
    async profile(): Promise<RunnerProfileFingerprint | undefined> {
      return undefined;
    },
    async setProfile(): Promise<RunnerProfileResult> {
      return { ok: false, error: 'この検証では使わない' };
    },
    async close() {
      /* この検証では使わない */
    },
  };

  return {
    runner,
    push(event: RunnerEvent): void {
      if (emit === null) throw new Error('connect されていない（名乗る前に流している）');
      emit(event);
    },
  };
}

/** 実測（#914 の 2026-09-14T20:19Z のコメント）を模した文言。9:30am (Asia/Tokyo) = 00:30Z。 */
const NOTICE_TEXT = "You've hit your session limit · resets 9:30am (Asia/Tokyo)";
/** 次に来る 00:30Z は 2026-09-15T00:30:00.000Z。 */
const RESET_TARGET = Date.parse('2026-09-15T00:30:00.000Z');
/** 通知を受け取る時刻（`now` として固定する）。 */
const NOW = Date.parse('2026-09-14T20:19:00.000Z');

function reached(): RunnerEvent {
  return {
    type: 'usage_notice',
    managerId: JOB.id,
    notice: { kind: 'reached', text: NOTICE_TEXT },
  } as RunnerEvent;
}

function okReport(): RunnerEvent {
  return {
    type: 'report',
    managerId: JOB.id,
    text: '調べ終えた',
    status: 'done',
  } as RunnerEvent;
}

/** イベントを流したあと、`#onEvent` の非同期の中身が落ち着くまで待つ。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function setup() {
  const stores = createMemoryStores();
  await stores.jobs.putJob(JOB);
  const fake = fakeRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    now: () => NOW,
    // **提案1（`tokenIdentity`）は意図して配線しない。** この判定が
    // daemon のプロセス内記憶に頼らないことを固定するためである
    // （直上の doc「ここが固定するもの」4）。
  });
  await pool.restore();
  return { pool, fake, stores };
}

async function summaryFor(pool: Awaited<ReturnType<typeof setup>>['pool'], managerId: string) {
  const list = await pool.list();
  const found = list.find((s) => s.managerId === managerId);
  if (found === undefined) throw new Error(`${managerId} が list() に見つからない`);
  return found;
}

describe('Issue #914 オーナー提案(2): resets時刻の突き合わせによる世代ずれの疑い', () => {
  it('⭐ 降りた鍵のcooldownUntilと一致する429を受けると、世代ずれ(stale)と名指しする', async () => {
    const { pool, fake, stores } = await setup();

    const dropped: AgentToken = {
      id: 'tok-08',
      label: 'alteroid08',
      order: 0,
      cooldownUntil: RESET_TARGET,
      cooldownSource: 'quota_reset',
    };
    const active: AgentToken = { id: 'tok-09', label: 'alteroid09', order: 1 };
    await stores.tokens.replace([dropped, active]);
    await stores.tokens.writeActive({
      tokenId: 'tok-09',
      generation: 2,
      rotatedAt: '2026-09-14T20:00:00.000Z',
    });

    fake.push(reached());
    await settle();

    const summary = await summaryFor(pool, JOB.id);
    expect(summary.resetTimeSkewMatch).toBe('stale');
    // **提案1は配線していないので、終始「分からない」のままである。**
    expect(summary.tokenGeneration).toBeUndefined();
    expect(summary.tokenGenerationUnknownReason).toBe('pool-not-wired');

    await pool.stop();
  });

  it('⚠️ 陰性対照: 現役自身のcooldownUntilと一致すれば「待てば戻る」(active)——世代ずれではない', async () => {
    const { pool, fake, stores } = await setup();

    const active: AgentToken = {
      id: 'tok-09',
      label: 'alteroid09',
      order: 0,
      cooldownUntil: RESET_TARGET,
      cooldownSource: 'quota_reset',
    };
    await stores.tokens.replace([active]);
    await stores.tokens.writeActive({
      tokenId: 'tok-09',
      generation: 1,
      rotatedAt: '2026-09-14T20:00:00.000Z',
    });

    fake.push(reached());
    await settle();

    const summary = await summaryFor(pool, JOB.id);
    expect(summary.resetTimeSkewMatch).toBe('active');

    await pool.stop();
  });

  it('プールが空（現役の指名も無い）なら、429が届いても何も名乗らない', async () => {
    const { pool, fake } = await setup();

    fake.push(reached());
    await settle();

    const summary = await summaryFor(pool, JOB.id);
    expect(summary.resetTimeSkewMatch).toBeUndefined();

    await pool.stop();
  });

  it('自力でターンを終えると、印は`usageStoppedAt`と同じ寿命で下りる', async () => {
    const { pool, fake, stores } = await setup();

    const dropped: AgentToken = {
      id: 'tok-08',
      label: 'alteroid08',
      order: 0,
      cooldownUntil: RESET_TARGET,
      cooldownSource: 'quota_reset',
    };
    const active: AgentToken = { id: 'tok-09', label: 'alteroid09', order: 1 };
    await stores.tokens.replace([dropped, active]);
    await stores.tokens.writeActive({
      tokenId: 'tok-09',
      generation: 2,
      rotatedAt: '2026-09-14T20:00:00.000Z',
    });

    fake.push(reached());
    await settle();
    expect((await summaryFor(pool, JOB.id)).resetTimeSkewMatch).toBe('stale');

    fake.push(okReport());
    await settle();

    const summary = await summaryFor(pool, JOB.id);
    expect(summary.resetTimeSkewMatch).toBeUndefined();

    await pool.stop();
  });
});
