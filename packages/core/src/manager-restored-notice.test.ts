import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  RunnerHttpError,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

// 器の作り直し・デーモンの再起動の後に、委譲ごとに届いていた「取り戻した」知らせを、
// 「1本目はすぐ・同じ出来事（同じ cause）の残りは1通」にまとめる（Issue #4443 (a) の続き）。
// 「届く」ことは固定の待ちではなく `vi.waitFor` で、条件が満ちるまで待つ。
// プール窓は、負荷で数百 ms 遅れても「窓の中」のまま確かめられるよう、十分長く取る。
const POOL_WINDOW_MS = 2_000;
const WAIT = { timeout: 15_000 };
vi.setConfig({ testTimeout: 30_000 });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FakeRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  resumes: string[];
  failResume: { value: boolean };
}

function fakeRunner(): FakeRunner {
  const alive: RunnerManagerState[] = [];
  const resumes: string[] = [];
  const failResume = { value: false };
  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect() {
      /* 出来事はこの検証では流さない */
    },
    async start(): Promise<{ cwd?: string }> {
      return {};
    },
    async resume(command): Promise<{ cwd?: string }> {
      // 400 は投げ直しても同じ答えが返る失敗（再試行の梯子へ載らず、戻せなかったものとして知らされる）。
      if (failResume.value) throw new RunnerHttpError('resume が失敗した (400)（試験用）', 400);
      resumes.push(command.managerId);
      return {};
    },
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop() {
      /* 使わない */
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
    async profile() {
      return undefined;
    },
    async setProfile() {
      return { ok: true as const };
    },
    async close() {
      /* 使わない */
    },
  };
  return { runner, alive, resumes, failResume };
}

function jobOf(id: string): Job {
  return {
    id,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: `/work/${id}`,
    sessionId: `sess-${id}`,
    runnerId: 'runner-primary',
    lastReport: `${id} の途中経過: 3件目まで読んだ`,
  };
}

interface Setup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: FakeRunner;
}

// `aliveIds` は runner がセッションを持っている（引き取るだけ＝ attached・cause は daemon）。
// `deadIds` は持っていない（前のセッションから再開させる＝ resumed・cause は runner）。
async function setup(
  aliveIds: readonly string[],
  deadIds: readonly string[] = [],
  options: { failResume?: boolean } = {},
): Promise<Setup> {
  const stores = createMemoryStores();
  const fake = fakeRunner();
  fake.failResume.value = options.failResume === true;
  for (const id of [...aliveIds, ...deadIds]) await stores.jobs.putJob(jobOf(id));
  for (const id of aliveIds) {
    fake.alive.push({
      managerId: id,
      status: 'running',
      cwd: `/work/${id}`,
      request: '調べて',
      waiting: [],
      sessionId: `sess-${id}`,
    });
  }
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: createRunnerRegistry([fake.runner]),
    synthesizedNoticeWindowMs: 20,
    quotaStopWindowMs: POOL_WINDOW_MS,
  });
  await pool.restore();
  return { pool, stores, inbox, fake };
}

function restoredMessages(events: readonly InboxEvent[]) {
  return events.filter(
    (event) => event.type === 'manager_message' && event.kind === 'report',
  ) as Extract<InboxEvent, { type: 'manager_message' }>[];
}

// 「取り戻した」一覧（`identity` が `restored:` で始まる external）だけを数える。
function restoredLists(events: readonly InboxEvent[]) {
  return events.filter(
    (event) => event.type === 'external' && (event.identity ?? '').startsWith('restored:'),
  ) as Extract<InboxEvent, { type: 'external' }>[];
}

function textOf(event: Extract<InboxEvent, { type: 'external' }>): string {
  return (event.payload as { text: string }).text;
}

async function journalTexts(stores: Stores): Promise<string[]> {
  const entries = await stores.journal.list({ types: ['exchange'] });
  return entries.map((entry) => JSON.stringify(entry));
}

async function waitForMessages(inbox: InboxEvent[], count: number): Promise<void> {
  await vi.waitFor(() => expect(restoredMessages(inbox)).toHaveLength(count), WAIT);
}

async function waitForLists(inbox: InboxEvent[], count: number): Promise<void> {
  await vi.waitFor(() => expect(restoredLists(inbox)).toHaveLength(count), WAIT);
}

// 窓へ貯めたことは、日誌の「受信箱へ行かず」の行で観測する（積んだ時点で担当ごとに書かれる）。
async function waitForStored(stores: Stores, count: number): Promise<void> {
  await vi.waitFor(async () => {
    const lines = await journalTexts(stores);
    const stored = lines.filter((l) => l.includes('受信箱へ行かず') && l.includes('N 本の委譲'));
    if (stored.length < count) throw new Error(`貯まったのが ${String(stored.length)} 本だけ`);
  }, WAIT);
}

describe('取り戻した知らせは、1本目はすぐ・同じ cause の残りは1通', () => {
  it('委譲1本だけ → 今どおり manager_message がすぐ1通。窓が閉じても追加は無い', async () => {
    const { pool, inbox } = await setup([], ['mgr-a']);

    await waitForMessages(inbox, 1);
    expect(restoredMessages(inbox)[0]?.text).toContain(
      'runner の器が作り直された。中断されていたこの委譲を、前のセッションから再開させた。',
    );

    await sleep(POOL_WINDOW_MS + 500);
    expect(restoredMessages(inbox)).toHaveLength(1);
    expect(restoredLists(inbox)).toHaveLength(0);

    await pool.stop();
    expect(restoredLists(inbox)).toHaveLength(0);
  });

  it('同じ cause で3本 → 1本目はすぐ、残りは担当ごとに届かず、窓が閉じたとき3本の一覧が1通', async () => {
    const { pool, stores, inbox } = await setup([], ['mgr-a', 'mgr-b', 'mgr-c']);

    // 1本目はすぐ。どれが1本目かは到着順で決まるので、届いた担当を読む。
    await waitForMessages(inbox, 1);
    const first = restoredMessages(inbox)[0]!.managerId;
    await waitForStored(stores, 2);
    expect(restoredMessages(inbox)).toHaveLength(1);
    expect(restoredLists(inbox)).toHaveLength(0);

    // 窓が閉じたとき、窓を開けた担当も含めた3本の一覧が1通。
    await waitForLists(inbox, 1);
    expect(restoredMessages(inbox)).toHaveLength(1);
    const sent = restoredLists(inbox);
    expect(sent[0]?.source).toBe('runner-registry');
    const text = textOf(sent[0]!);
    expect(text).toContain('runner の器が作り直された: 3 本の委譲に当たった');
    // 作業場の行（cause が daemon 以外のときだけ）は担当ごとに載る。
    expect(text.split('外へ保存していない作業は失われている').length - 1).toBe(3);
    for (const id of ['mgr-a', 'mgr-b', 'mgr-c']) {
      const line = text.split('\n').find((l) => l.startsWith(`- ${id}:`)) ?? '';
      expect(line, id).toContain('器 runner-primary');
      expect(line, id).toContain('前のセッションから再開させた（resumed）');
      expect(line, id).toContain('状態 running（セッションは生きている）');
      expect(text).toContain(`作業ディレクトリ: /work/${id}`);
      expect(text).toContain(`直近の報告（抜粋）: ${id} の途中経過: 3件目まで読んだ`);
      // 窓を開けた担当の行にだけ「最初の1本」の印が付く。
      expect(line.includes('最初の1本。担当への報告としては先に届けてある'), id).toBe(id === first);
    }
    // 案内は含まれる種類の分だけ1回ずつ（resumed だけなので attached の案内は無い）。
    expect(text.split('再開の指示は送信済み').length - 1).toBe(1);
    expect(text).not.toContain('返事待ちがあれば改めて届く');

    await pool.stop();
  });

  it('デーモンの再起動（cause は daemon）はまとめない: 窓を開かず・貯めず、担当ごとにすぐ届く', async () => {
    const { pool, inbox } = await setup(['mgr-a', 'mgr-b', 'mgr-c']);

    await waitForMessages(inbox, 3);
    for (const message of restoredMessages(inbox)) {
      expect(message.text).toContain(
        'デーモンが再起動した。この委譲は runner の中で走り続けている。',
      );
    }
    await sleep(POOL_WINDOW_MS + 500);
    expect(restoredLists(inbox)).toHaveLength(0);
    expect(restoredMessages(inbox)).toHaveLength(3);

    await pool.stop();
    expect(restoredLists(inbox)).toHaveLength(0);
  });

  it('デーモンの知らせは窓を開かない: daemon の後に来た runner の知らせが、1本目としてすぐ届く', async () => {
    const { pool, stores, inbox } = await setup(['mgr-a', 'mgr-b']);
    await waitForMessages(inbox, 2);

    // 器の作り直し（cause は runner）。引き取り済みの委譲は再開されず、新しい委譲だけが再開される。
    await stores.jobs.putJob(jobOf('mgr-c'));
    await pool.reattachRunner('runner-primary');
    await vi.waitFor(() => {
      const heads = restoredMessages(inbox).map((m) => `${m.managerId}:${m.text}`);
      expect(
        heads.some((h) => h.startsWith('mgr-c:') && h.includes('runner の器が作り直された')),
      ).toBe(true);
    }, WAIT);
    // daemon の知らせが窓を開いていたなら、mgr-c は貯まって届かない。
    expect(restoredLists(inbox)).toHaveLength(0);

    await pool.stop();
  });

  it('cause が違う2本 → どちらもすぐ届き、一覧は出ない', async () => {
    const { pool, inbox } = await setup(['mgr-a'], ['mgr-b']);

    await waitForMessages(inbox, 2);
    const heads = restoredMessages(inbox)
      .map((m) => m.text)
      .join('\n');
    // daemon の知らせはまとめない（窓を開かない）ので、runner の知らせは別の出来事の1本目としてすぐ届く。
    expect(heads).toContain('デーモンが再起動した');
    expect(heads).toContain('runner の器が作り直された');

    await sleep(POOL_WINDOW_MS + 500);
    expect(restoredLists(inbox)).toHaveLength(0);
    expect(restoredMessages(inbox)).toHaveLength(2);

    await pool.stop();
  });

  it('窓が閉じた後に来た委譲は新しい窓の1本目になり、すぐ担当ごとに届く', async () => {
    const { pool, stores, inbox } = await setup([], ['mgr-a', 'mgr-b']);

    await waitForLists(inbox, 1);
    expect(restoredMessages(inbox)).toHaveLength(1);

    // 窓の後に、同じ cause（runner）の取り直しが来る（新しい窓が開く。この器は runner を作り直し続けている）。
    await stores.jobs.putJob(jobOf('mgr-c'));
    await pool.reattachRunner('runner-primary');
    // 新しい窓の1本目: 一覧を待たずに担当ごとに届く（まだ2通目の一覧は出ていない）。
    await waitForMessages(inbox, 2);
    expect(restoredLists(inbox)).toHaveLength(1);

    // 窓が閉じたとき、その窓の分が新しい一覧になる（前の一覧とは別の出来事として畳まれない）。
    await waitForLists(inbox, 2);
    const [oldList, newList] = restoredLists(inbox);
    expect(newList?.identity).not.toBe(oldList?.identity);
    expect(textOf(newList!)).toContain('mgr-c');

    await pool.stop();
  });

  it('窓の途中で stop() すると、窓に貯めた分が1通として配られる', async () => {
    const { pool, stores, inbox } = await setup([], ['mgr-a', 'mgr-b']);

    await waitForMessages(inbox, 1);
    await waitForStored(stores, 1);
    expect(restoredLists(inbox)).toHaveLength(0);

    await pool.stop();

    expect(restoredLists(inbox)).toHaveLength(1);
    expect(textOf(restoredLists(inbox)[0]!)).toContain('2 本の委譲に当たった');
  });

  it('戻せなかった知らせ（#notifyUnresumable）はまとめず、担当ごとのまま届く', async () => {
    const { pool, inbox } = await setup([], ['mgr-a', 'mgr-b', 'mgr-c'], { failResume: true });

    await vi.waitFor(() => {
      const unresumable = restoredMessages(inbox).filter((m) => m.text.includes('戻せなかった'));
      expect(unresumable.map((m) => m.managerId).sort()).toEqual(['mgr-a', 'mgr-b', 'mgr-c']);
    }, WAIT);
    await sleep(POOL_WINDOW_MS + 500);
    expect(restoredLists(inbox)).toHaveLength(0);

    await pool.stop();
  });
});
