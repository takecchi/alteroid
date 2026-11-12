import { afterEach, describe, expect, it, vi } from 'vitest';

import { setStderrSinkForTesting } from './dropped-record.js';
import { createManagerPool, type ManagerPool } from './manager.js';
import { FakeRunnerClientBase } from './runner-client.test-support.js';
import {
  createRunnerRegistry,
  RUNNER_CAPABILITY_TRANSCRIPT_TAIL,
  type RunnerEntry,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// running の担当が 30 分間、何の出来事も無いとき、クローンの受信箱へ 1 episode につき 1 通だけ知らせる（A2）。
// 実時間も fake timer も使わない: `createManagerPool({ now })` の時計を進め、`pool.noteSilentManagers()` を直接呼ぶ。
// 閾値は定数 `MANAGER_SILENCE_NOTICE_MS`（30 分）。値そのものも縛るため、ここへ字面で置く。
const MINUTE = 60_000;
const THRESHOLD_MS = 30 * MINUTE;
const START = Date.parse('2026-10-23T13:40:00.000Z');

const SILENT = /出来事が無い/;
const RECOVERED = /出来事が戻った/;

class SilentRunner extends FakeRunnerClientBase {
  readonly runnerId = 'runner-silent';
  alive: RunnerManagerState[] = [];
  liveTranscript: string | null = null;
  #onEvent: ((event: RunnerEvent) => unknown) | null = null;

  async connect(onEvent: (event: RunnerEvent) => unknown): Promise<void> {
    this.#onEvent = onEvent;
    // 末尾の見回りは末尾の口を名乗る runner からだけ読む（#5160）
    await onEvent({
      type: 'hello',
      runnerId: this.runnerId,
      capabilities: [RUNNER_CAPABILITY_TRANSCRIPT_TAIL],
    });
  }
  async list(): Promise<RunnerManagerState[]> {
    return this.alive;
  }
  async stop(managerId: string): Promise<void> {
    this.alive = this.alive.filter((entry) => entry.managerId !== managerId);
  }
  async transcript(): Promise<string | null> {
    return this.liveTranscript;
  }
  async transcriptTail(): Promise<string | null> {
    return this.liveTranscript;
  }
  async setProfile() {
    return { ok: true as const };
  }

  // 出来事の処理（非同期）が済むまで手番を回す: 受け取りは待たれないことがある
  async push(event: RunnerEvent): Promise<void> {
    await this.#onEvent?.(event);
    for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function jobOf(id: string): Job {
  return {
    id,
    createdAt: '2026-10-23T12:00:00.000Z',
    updatedAt: '2026-10-23T13:33:00.000Z',
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: `sess-${id}`,
    runnerId: 'runner-silent',
    lastReportAt: '2026-10-23T13:33:00.000Z',
  };
}

interface Env {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  runner: SilentRunner;
  clock: () => number;
  advance: (ms: number) => void;
  setClock: (iso: string) => void;
  setLost: (lost: boolean) => void;
  /** 真の間、この正規表現に当たる本文の受信箱への配達が投げる。 */
  throwPostWhen: (pattern: RegExp | null) => void;
  close: () => Promise<void>;
}

async function setup(ids: readonly string[] = ['mgr-silent']): Promise<Env> {
  const stores = createMemoryStores();
  const runner = new SilentRunner();
  for (const id of ids) {
    await stores.jobs.putJob(jobOf(id));
    runner.alive.push({
      liveBackgroundTasks: 0,
      managerId: id,
      status: 'running',
      cwd: '/work/project',
      request: '調べて',
      waiting: [],
      sessionId: `sess-${id}`,
    });
  }
  const base = createRunnerRegistry([runner]);
  let lost = false;
  // 名簿は実物を使い、`entries()` だけ「lost と読まれている」ように見せられる形にする（メソッドはクラスの prototype にあるので、束ねて渡す）
  const registry = new Proxy(base, {
    get(target, property) {
      if (property === 'entries') {
        return (): RunnerEntry[] =>
          target
            .entries()
            .map((entry) =>
              lost ? { ...entry, state: 'lost', since: '2026-10-23T13:41:00.000Z' } : entry,
            );
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const inbox: InboxEvent[] = [];
  let postThrows: RegExp | null = null;
  let clock = START;
  const pool = createManagerPool({
    stores,
    post: (event) => {
      if (postThrows !== null && event.type === 'manager_message' && postThrows.test(event.text)) {
        throw new Error('受信箱へ積めない（試験用）');
      }
      inbox.push(event);
    },
    runners: registry,
    now: () => clock,
  });
  await pool.restore();
  return {
    pool,
    stores,
    inbox,
    runner,
    clock: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    setClock: (iso) => {
      clock = Date.parse(iso);
    },
    setLost: (value) => {
      lost = value;
    },
    throwPostWhen: (pattern) => {
      postThrows = pattern;
    },
    close: async () => {
      await pool.stop();
      await base.stop();
    },
  };
}

function toolUse(managerId: string): RunnerEvent {
  return { type: 'tool_use', managerId, actor: `manager:${managerId}`, tool: 'Read' };
}

function mirror(managerId: string): RunnerEvent {
  return {
    type: 'mirror',
    managerId,
    key: { projectKey: 'proj', sessionId: `sess-${managerId}` },
    entries: [],
  };
}

function usage(managerId: string): RunnerEvent {
  return {
    type: 'usage',
    managerId,
    sessionId: `sess-${managerId}`,
    models: {},
  } as unknown as RunnerEvent;
}

function toolRunning(managerId: string, tool: string): RunnerEvent {
  return {
    type: 'tool_running',
    managerId,
    actor: 'worker',
    tool,
    toolUseId: 'tu-1',
    startedAt: '2026-10-23T13:40:00.000Z',
  };
}

function report(managerId: string, status: 'done' | 'failed', extra: object = {}): RunnerEvent {
  return { type: 'report', managerId, text: '途中経過', status, ...extra } as RunnerEvent;
}

function turnEndLine(timestamp: string): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '終えた。' }],
      stop_reason: 'end_turn',
    },
  });
}

/** 受信箱の無音の知らせ（本文に「出来事が無い」を持つ manager_message） */
function silenceNotices(env: Env): string[] {
  return env.inbox.flatMap((event) =>
    event.type === 'manager_message' && SILENT.test(event.text) ? [event.text] : [],
  );
}

async function exchangeTexts(stores: Stores): Promise<string[]> {
  const entries = await stores.journal.list({ types: ['exchange'] });
  return entries.map((entry) => (entry.type === 'exchange' ? entry.text : ''));
}

async function failureLines(stores: Stores): Promise<string[]> {
  return (await exchangeTexts(stores)).filter(
    (text) => text.startsWith('[障害] ') && SILENT.test(text),
  );
}

async function recoveryLines(stores: Stores): Promise<string[]> {
  return (await exchangeTexts(stores)).filter(
    (text) => text.startsWith('[復旧] ') && RECOVERED.test(text),
  );
}

// 配達・日誌は非同期の連鎖の先にあるので、「出ない」の確認の前に十分に手番を回す
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function sweep(env: Env): Promise<void> {
  await env.pool.noteSilentManagers();
  await flush();
}

afterEach(() => {
  setStderrSinkForTesting(null);
});

describe('running の担当が 30 分間無音なら、クローンの受信箱へ 1 通だけ知らせる（A2）', () => {
  it('閾値の手前では 0 通で、閾値に達するとちょうど 1 通（日誌にも [障害] が 1 行）', async () => {
    const env = await setup();
    await sweep(env); // 最初の観測（基準時刻の起点）

    env.advance(THRESHOLD_MS - 1);
    await sweep(env);
    expect(silenceNotices(env)).toEqual([]);
    expect(await failureLines(env.stores)).toEqual([]);

    env.advance(1);
    await env.pool.noteSilentManagers();
    await vi.waitFor(() => expect(silenceNotices(env)).toHaveLength(1));
    const [text] = silenceNotices(env);
    expect(text).toContain('mgr-silent');
    expect(text).toContain('30分');
    // 断定しない: 長い無音が正常なこともある。確かめ方と動かし方を添える
    expect(text).toContain('断定はできない');
    expect(text).toContain('道具を呼ばない長い推論');
    expect(text).toContain('出力の少ない長い道具');
    expect(text).toContain('manager_transcript');
    expect(text).toContain('manager_send');
    await vi.waitFor(async () => expect(await failureLines(env.stores)).toHaveLength(1));
    expect((await failureLines(env.stores))[0]).toContain('[mgr-silent]');
    await env.close();
  });

  it('最後に届いた出来事の種類と、道具の実行中ならその名前を本文に載せる', async () => {
    const env = await setup();
    await sweep(env);
    await env.runner.push(toolRunning('mgr-silent', 'peer_run'));
    env.advance(THRESHOLD_MS);
    await env.pool.noteSilentManagers();
    await vi.waitFor(() => expect(silenceNotices(env)).toHaveLength(1));
    const [text] = silenceNotices(env);
    expect(text).toContain('tool_running');
    expect(text).toContain('peer_run');
    await env.close();
  });

  it('その後 10 周進めても 1 通のまま', async () => {
    const env = await setup();
    await sweep(env);
    env.advance(THRESHOLD_MS);
    await env.pool.noteSilentManagers();
    await vi.waitFor(() => expect(silenceNotices(env)).toHaveLength(1));

    for (let i = 0; i < 10; i += 1) {
      env.advance(MINUTE);
      await sweep(env);
    }
    expect(silenceNotices(env)).toHaveLength(1);
    expect(await failureLines(env.stores)).toHaveLength(1);
    await env.close();
  });

  it('出来事が来ると印が外れ（[復旧] は日誌のみ）、再び無音になれば別の episode として 2 通目', async () => {
    const env = await setup();
    await sweep(env);
    env.advance(THRESHOLD_MS);
    await env.pool.noteSilentManagers();
    await vi.waitFor(() => expect(silenceNotices(env)).toHaveLength(1));
    const inboxBefore = env.inbox.length;

    await env.runner.push(toolUse('mgr-silent'));
    await env.pool.noteSilentManagers();
    await vi.waitFor(async () => expect(await recoveryLines(env.stores)).toHaveLength(1));
    // 回復は受信箱へ出さない
    expect(env.inbox.length).toBe(inboxBefore);

    env.advance(THRESHOLD_MS - 1);
    await sweep(env);
    expect(silenceNotices(env)).toHaveLength(1);

    env.advance(1);
    await env.pool.noteSilentManagers();
    await vi.waitFor(() => expect(silenceNotices(env)).toHaveLength(2));
    expect(await recoveryLines(env.stores)).toHaveLength(1);
    await env.close();
  });

  it('出来事が届き続ける間は出ない（進捗の更新が効いている）', async () => {
    const env = await setup();
    await sweep(env);
    for (let i = 0; i < 6; i += 1) {
      env.advance(THRESHOLD_MS - MINUTE);
      await env.runner.push(toolUse('mgr-silent'));
      await sweep(env);
    }
    expect(silenceNotices(env)).toEqual([]);
    expect(await failureLines(env.stores)).toEqual([]);
    await env.close();
  });

  describe('正常な長い無音では出ない（2 時間進めても 0 通）', () => {
    const cases: [string, (env: Env) => Promise<void>][] = [
      [
        '返事待ち（ask → waiting_human）',
        async (env) => {
          await env.runner.push({
            type: 'ask',
            managerId: 'mgr-silent',
            requestId: 'req-1',
            kind: 'permission',
            summary: '許可しますか',
            askedAt: '2026-10-23T13:40:00.000Z',
          });
        },
      ],
      [
        '背景処理待ち（done に潰れる）',
        async (env) => {
          await env.runner.push(
            report('mgr-silent', 'done', { awaitingBackground: { count: 1, breakdown: 'bg' } }),
          );
        },
      ],
      [
        'done',
        async (env) => {
          await env.runner.push(report('mgr-silent', 'done'));
        },
      ],
      [
        'failed',
        async (env) => {
          await env.runner.push(report('mgr-silent', 'failed'));
        },
      ],
      [
        'stopped',
        async (env) => {
          await env.pool.abort('mgr-silent');
        },
      ],
      [
        'runner lost',
        async (env) => {
          env.setLost(true);
        },
      ],
      [
        '枠停止中',
        async (env) => {
          await env.runner.push({
            type: 'usage_notice',
            managerId: 'mgr-silent',
            notice: { kind: 'reached', text: "You've hit your individual spend limit." },
          } as RunnerEvent);
        },
      ],
    ];
    for (const [label, arrange] of cases) {
      it(label, async () => {
        const env = await setup();
        await sweep(env);
        await arrange(env);
        await sweep(env);
        env.advance(2 * 60 * MINUTE);
        await sweep(env);
        env.advance(2 * 60 * MINUTE);
        await sweep(env);
        expect(silenceNotices(env)).toEqual([]);
        expect(await failureLines(env.stores)).toEqual([]);
        await env.close();
      });
    }

    it('枠停止の対照: 印が立っていても running のままである（除外の理由が枠停止に限られる）', async () => {
      const env = await setup();
      await env.runner.push({
        type: 'usage_notice',
        managerId: 'mgr-silent',
        notice: { kind: 'reached', text: "You've hit your individual spend limit." },
      } as RunnerEvent);
      const [summary] = await env.pool.list();
      expect(summary?.status).toBe('running');
      expect(summary?.usageStoppedAt).toBeDefined();
      await env.close();
    });
  });

  it('usage（数えない出来事）だけが届いても、無音のまま通知される', async () => {
    const env = await setup();
    await sweep(env);
    env.advance(THRESHOLD_MS - MINUTE);
    await env.runner.push(usage('mgr-silent'));
    env.advance(MINUTE);
    await env.pool.noteSilentManagers();
    await vi.waitFor(() => expect(silenceNotices(env)).toHaveLength(1));
    await env.close();
  });

  it('mirror だけが届いても、無音のまま通知される（mirror は基準時刻を進めない）', async () => {
    // SDK の `sessionStoreFlush` 既定は 'batched'（時間基準の flush が無く、ターン終了か 500 件／1 MiB でだけ届く）ので、mirror は進捗の信号に使えない
    const env = await setup();
    await sweep(env);
    env.advance(THRESHOLD_MS - MINUTE);
    await env.runner.push(mirror('mgr-silent'));
    env.advance(MINUTE);
    await env.pool.noteSilentManagers();
    await vi.waitFor(() => expect(silenceNotices(env)).toHaveLength(1));
    await env.close();
  });

  it('manager_send で running に戻した直後は即通知しない（基準は監視者の最初の観測以降）', async () => {
    const env = await setup();
    await sweep(env);
    await env.runner.push(report('mgr-silent', 'done'));
    await sweep(env);
    // 最後の出来事（report）から 2 時間以上たっている
    env.advance(3 * 60 * MINUTE);
    await sweep(env);

    await env.pool.send('mgr-silent', '続きをお願いします');
    const [resumed] = await env.pool.list();
    expect(resumed?.status).toBe('running');
    await sweep(env);
    expect(silenceNotices(env)).toEqual([]);

    env.advance(THRESHOLD_MS - 1);
    await sweep(env);
    expect(silenceNotices(env)).toEqual([]);

    env.advance(1);
    await env.pool.noteSilentManagers();
    await vi.waitFor(() => expect(silenceNotices(env)).toHaveLength(1));
    await env.close();
  });

  it('end_turn の後に報告が届かない担当（stalled-turn-end）では出さない（#recoverUndelivered と重ねない）', async () => {
    const env = await setup();
    // 再起動の引き取りの後の 1 回目の見回りを済ませる。以後は再起動をまたがない回になる
    env.advance(11 * MINUTE);
    await env.pool.probeTurnEnds();
    await sweep(env);

    env.runner.liveTranscript = turnEndLine('2026-10-23T13:50:59.000Z');
    env.advance(THRESHOLD_MS);
    await env.pool.probeTurnEnds();
    await vi.waitFor(() =>
      expect(
        env.inbox.some(
          (event) =>
            event.type === 'manager_message' && event.text.includes('生ログの末尾から拾って配る'),
        ),
      ).toBe(true),
    );

    await sweep(env);
    env.advance(THRESHOLD_MS);
    await sweep(env);
    expect(silenceNotices(env)).toEqual([]);
    expect(await failureLines(env.stores)).toEqual([]);
    await env.close();
  });

  it('受信箱への配達が投げても周回は落ちず、残りの担当には知らせが届く。跡は stderr に残る', async () => {
    const env = await setup(['mgr-a', 'mgr-b']);
    const lines: string[] = [];
    setStderrSinkForTesting((line) => lines.push(line));
    env.throwPostWhen(/\[mgr-a\].*出来事が無い/s);
    await sweep(env);
    env.advance(THRESHOLD_MS);

    await expect(env.pool.noteSilentManagers()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(silenceNotices(env)).toHaveLength(1));
    expect(silenceNotices(env)[0]).toContain('[mgr-b]');
    expect(silenceNotices(env)[0]).not.toContain('[mgr-a]');
    expect(lines.some((line) => line.includes('無音の知らせ'))).toBe(true);

    // 失敗した担当も、二度目の周回で配達を積み直さない（印は出す前に立てる）
    env.throwPostWhen(null);
    await sweep(env);
    expect(silenceNotices(env)).toHaveLength(1);
    await env.close();
  });
});
