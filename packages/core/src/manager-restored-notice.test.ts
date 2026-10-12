import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  RunnerHttpError,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
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
  /** デーモンへ出来事を流す（`connect` が受け取った口）。 */
  emit: (event: RunnerEvent) => void;
}

function fakeRunner(): FakeRunner {
  const alive: RunnerManagerState[] = [];
  const resumes: string[] = [];
  const failResume = { value: false };
  let onEvent: ((event: RunnerEvent) => void) | undefined;
  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(listener) {
      onEvent = listener;
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
  return {
    runner,
    alive,
    resumes,
    failResume,
    emit: (event) => {
      if (onEvent === undefined) throw new Error('connect() がまだ呼ばれていない');
      onEvent(event);
    },
  };
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
  options: {
    failResume?: boolean;
    sessionLog?: 'absent' | 'loaded';
    resumeConfirmTimeoutMs?: number;
  } = {},
): Promise<Setup> {
  // `sessionLog` を渡したときだけ、生ログの預け先（pg 構成の `sessionStore`）を持たせ、委譲に鍵（projectKey）を付ける。
  const stores: Stores =
    options.sessionLog === undefined
      ? createMemoryStores()
      : {
          ...createMemoryStores(),
          sessionStore: {
            append: async () => undefined,
            load: async () =>
              options.sessionLog === 'loaded'
                ? [{ type: 'user', uuid: 'u-1', message: { role: 'user', content: '調べて' } }]
                : null,
          },
        };
  const fake = fakeRunner();
  fake.failResume.value = options.failResume === true;
  for (const id of [...aliveIds, ...deadIds]) {
    await stores.jobs.putJob(
      options.sessionLog === undefined ? jobOf(id) : { ...jobOf(id), projectKey: 'proj-key' },
    );
  }
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
    ...(options.resumeConfirmTimeoutMs === undefined
      ? {}
      : { resumeConfirmTimeoutMs: options.resumeConfirmTimeoutMs }),
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
    const text = restoredMessages(inbox)[0]?.text ?? '';
    expect(text).toContain(
      'runner の器が作り直された。中断されていたこの委譲に、前のセッションからの再開を指示した（runner は受け付けた。前の会話が戻ったかは確定待ち）。',
    );
    // 受理の時点で「再開させた」「報告を待てばよい」と言い切らない: 前の会話が無ければ、この後に lost になる（#4501）。
    expect(text).not.toContain('再開させた');
    expect(text).not.toContain('報告を待てばよい');
    expect(text).toContain(
      '戻れなければ、この後に担当ごとの知らせが別に届き、状態は lost になる。',
    );
    // 何で確定し、何分で何が起きるかを書く。
    expect(text).toContain(
      '新しいセッションから最初の印（道具の使用・確認の要求・失敗の無いターンの報告）',
    );
    expect(text).toContain(
      '10 分たっても印が届かなければ、その旨を担当ごとに別に知らせる（lost とは決めない）',
    );
    // 失敗の知らせを見分ける語（「戻せなかった」）を、受理の知らせに混ぜない。
    expect(text).not.toContain('戻せなかった');

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
      // 受理の後の running を「セッションは生きている」と言わない（#4501）。
      expect(line, id).toContain(
        '前のセッションからの再開を指示した（resume は受理された。会話が戻ったかは確定待ち）',
      );
      expect(line, id).toContain(
        '状態 running（確定待ち: resume を受理しただけ。会話が戻ったかは未確認）',
      );
      expect(line, id).not.toContain('セッションは生きている');
      expect(text).toContain(`作業ディレクトリ: /work/${id}`);
      expect(text).toContain(`直近の報告（抜粋）: ${id} の途中経過: 3件目まで読んだ`);
      // 窓を開けた担当の行にだけ「最初の1本」の印が付く。
      expect(line.includes('最初の1本。担当への報告としては先に届けてある'), id).toBe(id === first);
    }
    // 案内は含まれる種類の分だけ1回ずつ（resumed だけなので attached の案内は無い）。
    expect(text.split('再開を指示した委譲:').length - 1).toBe(1);
    expect(text).not.toContain('再開させた');
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

// 2026-10-11 の反映の後、生ログを預かっていない委譲 12 本を「再開を受け付けた」とだけ知らせ、ほぼ全部が後から lost になった。
// 預け先が在って引いた結果が空なら、受理の時点で「戻れない見込みが高い」と添える（#4501）。
describe('生ログ無しで出した resume の受理の知らせは、戻れない見込みが高いと添える（#4501）', () => {
  const HINT =
    '前の会話の生ログを預かっていない（器の中の会話も入れ替えで消えている）ので、戻れない見込みが高い。';

  it('預け先に生ログが無い → 担当への知らせ・まとめの1通・日誌のすべてに添える', async () => {
    const { pool, stores, inbox } = await setup([], ['mgr-a', 'mgr-b'], { sessionLog: 'absent' });

    await waitForMessages(inbox, 1);
    expect(restoredMessages(inbox)[0]?.text).toContain(`⚠ ${HINT}`);
    await waitForLists(inbox, 1);
    const text = textOf(restoredLists(inbox)[0]!);
    expect(text.split(HINT).length - 1).toBe(2);
    // 失敗の知らせを見分ける語を、受理の知らせに混ぜない。
    expect(text).not.toContain('戻せなかった');
    const journal = await journalTexts(stores);
    expect(
      journal.filter((line) => line.includes('（再開の指示を知らせた）') && line.includes(HINT)),
    ).toHaveLength(2);

    await pool.stop();
  });

  it('預け先に生ログが在る → 添えない', async () => {
    const { pool, stores, inbox } = await setup([], ['mgr-a', 'mgr-b'], { sessionLog: 'loaded' });

    await waitForMessages(inbox, 1);
    await waitForLists(inbox, 1);
    expect(restoredMessages(inbox)[0]?.text).not.toContain(HINT);
    expect(textOf(restoredLists(inbox)[0]!)).not.toContain(HINT);
    expect((await journalTexts(stores)).some((line) => line.includes(HINT))).toBe(false);

    await pool.stop();
  });

  it('預け先の無い構成（fs）では、無いと確かめたことにならないので添えない', async () => {
    const { pool, inbox } = await setup([], ['mgr-a']);

    await waitForMessages(inbox, 1);
    expect(restoredMessages(inbox)[0]?.text).not.toContain(HINT);

    await pool.stop();
  });
});

// 受理は「戻れた」ではない。新しいセッションから最初の印が届いて初めて「戻れた」と言い、期限までに届かなければその旨を知らせる（#4501）。
describe('resume が戻れたかは、新しいセッションから最初の印が届いた時点で確定する（#4501）', () => {
  const toolUse = (managerId: string): RunnerEvent => ({
    type: 'tool_use',
    managerId,
    actor: `manager:${managerId}`,
    tool: 'Bash',
    input: { command: 'git status' },
  });
  const UNCONFIRMED =
    '新しいセッションから戻れた印（道具の使用・確認の要求・失敗の無いターンの報告）が1つも届いていない';

  function unconfirmedNotices(inbox: readonly InboxEvent[]) {
    return restoredMessages(inbox).filter((m) => m.text.includes(UNCONFIRMED));
  }

  it('印が届いた担当だけ、まとめの1通で「戻れたことを確かめた」になり、日誌にも残る', async () => {
    const { pool, stores, inbox, fake } = await setup([], ['mgr-a', 'mgr-b']);

    await waitForMessages(inbox, 1);
    await waitForStored(stores, 1);
    fake.emit(toolUse('mgr-a'));

    await waitForLists(inbox, 1);
    const text = textOf(restoredLists(inbox)[0]!);
    const lineA = text.split('\n').find((l) => l.startsWith('- mgr-a:')) ?? '';
    const lineB = text.split('\n').find((l) => l.startsWith('- mgr-b:')) ?? '';
    expect(lineA).toContain('状態 running（戻れたことを確かめた）');
    expect(lineB).toContain(
      '状態 running（確定待ち: resume を受理しただけ。会話が戻ったかは未確認）',
    );
    const journal = await journalTexts(stores);
    expect(
      journal.filter(
        (l) => l.includes('[mgr-a] （戻れたことを確かめた）') && l.includes('tool_use'),
      ),
    ).toHaveLength(1);
    expect(journal.some((l) => l.includes('[mgr-b] （戻れたことを確かめた）'))).toBe(false);

    await pool.stop();
  });

  it('期限までに印が届かなければ、止めず lost とも決めずに、担当ごとに1通知らせて日誌に残す', async () => {
    const { pool, stores, inbox } = await setup([], ['mgr-a'], { resumeConfirmTimeoutMs: 300 });

    await vi.waitFor(() => expect(unconfirmedNotices(inbox)).toHaveLength(1), WAIT);
    const notice = unconfirmedNotices(inbox)[0]!;
    expect(notice.managerId).toBe('mgr-a');
    expect(notice.text).toContain('止めてはおらず、lost とも決めていない（いまの状態: running）');
    expect(notice.text).not.toContain('戻せなかった');
    const journal = await journalTexts(stores);
    expect(
      journal.filter((l) => l.includes('[mgr-a] （戻れたか確かめられないまま）')),
    ).toHaveLength(1);
    expect((await stores.jobs.listJobs()).find((job) => job.id === 'mgr-a')?.status).toBe(
      'running',
    );

    await pool.stop();
  });

  it('期限より前に印が届けば、期限の知らせは出ない', async () => {
    const { pool, inbox, fake } = await setup([], ['mgr-a'], { resumeConfirmTimeoutMs: 1_500 });

    await waitForMessages(inbox, 1);
    fake.emit(toolUse('mgr-a'));
    await sleep(2_000);
    expect(unconfirmedNotices(inbox)).toHaveLength(0);

    await pool.stop();
  });

  it('失敗したターンの報告は印にしない（戻れなかった resume も出しうる）', async () => {
    const { pool, inbox, fake } = await setup([], ['mgr-a'], { resumeConfirmTimeoutMs: 1_500 });

    await waitForMessages(inbox, 1);
    fake.emit({
      type: 'report',
      managerId: 'mgr-a',
      text: '結果なしで終了: error_during_execution',
      status: 'running',
      failure: { code: 'error_during_execution', via: 'result' },
    });
    await vi.waitFor(() => expect(unconfirmedNotices(inbox)).toHaveLength(1), WAIT);

    await pool.stop();
  });

  it('resume_failed が届けば確定を打ち切り、期限の知らせは出ない（その経路が自分で知らせる）', async () => {
    const { pool, inbox, fake } = await setup([], ['mgr-a'], { resumeConfirmTimeoutMs: 1_500 });

    await waitForMessages(inbox, 1);
    fake.emit({
      type: 'resume_failed',
      managerId: 'mgr-a',
      sessionId: 'sess-mgr-a',
      reason: '結果なしで終了: error_during_execution',
      recovered: false,
    });
    await sleep(2_000);
    expect(unconfirmedNotices(inbox)).toHaveLength(0);

    await pool.stop();
  });
});
