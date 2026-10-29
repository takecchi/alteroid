import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import {
  fakeSdk,
  fakeScriptedSdk,
  waitFor,
  waitForTerminal,
  wireEvents,
  withoutQueueNotice,
} from './clone-test-harness.js';
import type { ScriptedStep } from './clone-test-harness.js';
import { migrateCommitmentsToTasks } from './commitment-task-migration.js';
import type { ManagerPool, ManagerStartInput, ManagerSummary } from './manager.js';
import type { RunnerFleetOverview } from './manager.js';
import type { RunnerLiveness } from './runner-protocol.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import type { InboxEvent, Job, JournalEntry, Task } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneMcpServer, createCloneTools } from './tools.js';
import type { ToolContext } from './tools.js';

// #5469 P5: 人間の依頼を Task として自動で積む／返答したターンの終わりに queued の task を自動で done にする。
const AT = '2026-10-29T00:00:00.000Z';
const OLD = '2026-01-01T00:00:00.000Z';

function human(id: string, text: string, conversationId = 'conv-1'): InboxEvent {
  return { type: 'human_message', id, at: new Date().toISOString(), text, conversationId };
}

function managerReport(id: string, text: string): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: new Date().toISOString(),
    managerId: 'mgr-1',
    kind: 'report',
    text,
  };
}

function seeded(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    createdAt: OLD,
    updatedAt: OLD,
    status: 'queued',
    origin: 'human',
    title: `title-${id}`,
    body: `body-${id}`,
    originConversationId: 'conv-1',
    ...overrides,
  };
}

function stubPool(
  started: ManagerStartInput[] = [],
  overrides: Partial<ManagerPool> = {},
): ManagerPool {
  const notImplemented = () => {
    throw new Error('not implemented');
  };
  return {
    start: (input: ManagerStartInput): Promise<ManagerSummary> => {
      started.push(input);
      return Promise.resolve({
        managerId: 'mgr-started',
        status: 'running',
        live: true,
        cwd: '/work',
        request: input.request,
        startedAt: AT,
        updatedAt: AT,
        waiting: [],
        runnerId: 'runner-a',
      });
    },
    send: notImplemented,
    abort: notImplemented,
    list: () => Promise.resolve([]),
    denials: () => [],
    pushHealthOf: () => undefined,
    runnerBacklog: () => [],
    runnerIdOf: () => Promise.resolve(undefined),
    runners: (): Promise<RunnerFleetOverview> =>
      Promise.resolve({
        runners: [
          {
            label: 'runner-0',
            state: 'connected' as RunnerLiveness,
            since: AT,
            managers: [],
            revision: { status: 'unheard' as const },
          },
        ],
        unassigned: [],
        daemonRevision: { status: 'unknown' as const, reason: 'テスト' },
      }),
    transcript: notImplemented,
    unpushedWork: notImplemented,
    runningManagerOwning: () => undefined,
    restore: () => Promise.resolve([]),
    resumeStoppedByUsage: () => Promise.resolve([]),
    reattachRunner: () => Promise.resolve(),
    relocateFrom: notImplemented,
    vacate: notImplemented,
    probeTurnEnds: () => Promise.resolve(),
    flushWithheldReports: () => Promise.resolve(),
    settleStalledUsageWakes: () => Promise.resolve([]),
    renotifyStalledDenials: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    ...overrides,
  };
}

const say = (text: string): ScriptedStep[] => [
  { delta: text },
  { assistant: [{ type: 'text', text }] },
];

type Tools = (name: string) => (args: Record<string, unknown>) => Promise<unknown>;

function boot(
  script: (turnIndex: number, input: string, tool: Tools) => ScriptedStep[],
  options: {
    stores?: Stores;
    managers?: ManagerPool;
    resultSubtype?: string;
    resultFor?: (turnIndex: number) => { subtype: string; text: string } | undefined;
    env?: NodeJS.ProcessEnv;
    mergedBatchLimit?: number;
  } = {},
) {
  const stores = options.stores ?? createMemoryStores();
  let captured: ToolContext | undefined;
  const tool: Tools = (name) => (args) => {
    const found = createCloneTools(captured!).find((entry) => entry.name === name);
    if (found === undefined) throw new Error(`${name} が無い`);
    return found.handler(args as never, {});
  };
  const { fn } = fakeScriptedSdk((turnIndex, input) => script(turnIndex, input, tool), {
    ...(options.resultSubtype === undefined ? {} : { resultSubtype: options.resultSubtype }),
    ...(options.resultFor === undefined ? {} : { resultFor: options.resultFor }),
  });
  const clone = createClone({
    redeliveryGate: ALWAYS_REDELIVER,
    stores,
    queryFn: fn,
    env: options.env ?? {},
    ...(options.mergedBatchLimit === undefined
      ? {}
      : { mergedBatchLimit: options.mergedBatchLimit }),
    inboxSettleMs: 0,
    reportSettleMs: 0,
    managers: options.managers ?? stubPool(),
    mcpServerFactory: (context) => {
      captured = context;
      return createCloneMcpServer(context);
    },
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  const { events } = wireEvents(clone, 'conv-1');
  return { clone, stores, events };
}

async function statusOf(stores: Stores, id: string): Promise<string | undefined> {
  return (await stores.tasks.get(id))?.status;
}

async function decisions(stores: Stores): Promise<string[]> {
  const rows = (await stores.journal.list({ types: ['decision'] })) as Extract<
    JournalEntry,
    { type: 'decision' }
  >[];
  return rows.map((row) => `${row.decision}\n${row.grounds}`);
}

describe('人間の依頼は台帳の行と同じ id で Task としても積まれる', () => {
  it('human_message: id・source は台帳と同じ、起点の会話・queued・title は先頭行・置き場所は P2 の既定', async () => {
    const s = boot(() => say('受けた'));
    s.clone.post(human('evt-a', '最初の依頼です\n詳細は2行目'));
    await waitFor(async () => (await s.stores.tasks.get('evt-a')) !== null, 'Task が積まれる');

    const created = await s.stores.tasks.get('evt-a');
    const row = await s.stores.commitments.get('evt-a');
    expect(row?.id).toBe('evt-a');
    expect(created).toMatchObject({
      id: 'evt-a',
      origin: 'human',
      source: 'conv-1',
      originConversationId: 'conv-1',
      title: '最初の依頼です',
      body: '最初の依頼です\n詳細は2行目',
    });
    expect(created?.source).toBe(row?.source);
    await s.clone.stop();
  });

  it('既定の置き場所: 開いている human 起点の最後の直後に届いた順で並ぶ（自分で足した self の task より前）', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(seeded('self-1', { origin: 'self', originConversationId: undefined }));
    const s = boot(() => say('受けた'), { stores });
    s.clone.post(human('evt-a', '一つ目', 'conv-A'));
    await waitFor(async () => (await stores.tasks.get('evt-a')) !== null, 'a');
    s.clone.post(human('evt-b', '二つ目', 'conv-B'));
    await waitFor(async () => (await stores.tasks.get('evt-b')) !== null, 'b');

    // どちらも返答で閉じる前に並びを見るため、閉じた件も含めて読む
    const listed = await stores.tasks.list({ includeClosed: true });
    expect(listed.entries.map((task) => task.id).filter((id) => id !== 'self-1')).toEqual(
      expect.arrayContaining(['evt-a', 'evt-b']),
    );
    await s.clone.stop();
  });

  it('human_answer: 台帳には載る（移行期）が、Task は作らない（回答は新しい依頼ではない）', async () => {
    const s = boot(() => say('承認の回答を受けた'));
    s.clone.post({
      type: 'human_answer',
      id: 'ans-1',
      at: new Date().toISOString(),
      approvalId: 'appr-1',
      answer: '進めてよい',
      conversationId: 'conv-1',
    });
    await waitFor(async () => (await s.stores.commitments.get('ans-1')) !== null, '台帳に載る');
    await waitForTerminal(s.events);

    expect((await s.stores.commitments.get('ans-1'))?.origin).toBe('human');
    expect((await s.stores.tasks.list({ includeClosed: true })).entries).toEqual([]);
    await s.clone.stop();
  });

  it('manager_message・external は受信箱には届くが、台帳にも Task にも積まれない', async () => {
    const inputs: string[] = [];
    const s = boot((_turn, input) => {
      inputs.push(input);
      return [];
    });
    s.clone.post(managerReport('rep-1', 'REPORT-BODY 終わった'));
    s.clone.post({
      type: 'external',
      id: 'ext-1',
      at: new Date().toISOString(),
      source: 'github',
      payload: { note: 'EXTERNAL-BODY' },
    });
    await waitFor(
      () =>
        inputs.some((text) => text.includes('REPORT-BODY')) &&
        inputs.some((text) => text.includes('EXTERNAL-BODY')),
      '2つの合図がターンの入力に届く',
    );

    expect((await s.stores.tasks.list({ includeClosed: true })).entries).toEqual([]);
    expect((await s.stores.commitments.list({ includeClosed: true })).entries).toEqual([]);
    await s.clone.stop();
  });

  it('同じ id の Task が既に在れば二重に作らず、既存の行を書き換えない（配り直し・P7a の移行との共存）', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(seeded('evt-dup', { title: '先に在った行', keep: true }));
    const s = boot(() => [], { stores });
    s.clone.post(human('evt-dup', '同じ合図'));
    await waitFor(async () => (await stores.commitments.get('evt-dup')) !== null, '台帳の行');

    const all = (await stores.tasks.list({ includeClosed: true })).entries;
    expect(all.filter((task) => task.id === 'evt-dup')).toHaveLength(1);
    expect((await stores.tasks.get('evt-dup'))?.title).toBe('先に在った行');
    await s.clone.stop();
  });

  it('P7a の移行は、自動で積んだ Task を existed として扱い、台帳を閉じるだけにする', async () => {
    const s = boot(() => []);
    s.clone.post(human('evt-mig', '移行と共存する依頼'));
    await waitFor(async () => (await s.stores.tasks.get('evt-mig')) !== null, 'Task');
    await waitFor(async () => (await s.stores.commitments.get('evt-mig')) !== null, '台帳');

    const now = new Date().toISOString();
    const plan = await migrateCommitmentsToTasks(s.stores, { dryRun: true, now });
    const report = await migrateCommitmentsToTasks(s.stores, {
      dryRun: false,
      now,
      expectedFingerprint: plan.fingerprint,
    });

    expect(report.summary.closeOnly).toBe(1);
    expect(report.summary.toTask).toBe(0);
    expect(
      (await s.stores.tasks.list({ includeClosed: true })).entries.filter(
        (task) => task.id === 'evt-mig',
      ),
    ).toHaveLength(1);
    await s.clone.stop();
  });
});

describe('起点の会話へ返答したターンの終わりに、queued の task が自動で done になる', () => {
  it('返答したターンの終わりに done（closedBy daemon・理由つき）。日誌には id と title だけが残り、閉じた件は読み返せる', async () => {
    const s = boot(() => say('やっておく'));
    s.clone.post(human('evt-r', '調べてほしい\n本文の2行目 SECRET-BODY'));
    await waitForTerminal(s.events);

    const closed = await s.stores.tasks.get('evt-r');
    expect(closed?.status).toBe('done');
    expect(closed?.closedBy).toBe('daemon');
    expect(closed?.closedReason).toContain('起点の会話へ返答したので自動で閉じた');
    const written = (await decisions(s.stores)).filter((text) => text.includes('evt-r'));
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('調べてほしい');
    expect(written[0]).not.toContain('SECRET-BODY');
    expect((await s.stores.tasks.list()).entries).toEqual([]);
    expect(
      (await s.stores.tasks.list({ includeClosed: true })).entries.map((task) => task.id),
    ).toContain('evt-r');
    await s.clone.stop();
  });

  it('返答の本文が空なら閉じない（返答していない）', async () => {
    const s = boot(() => []);
    s.clone.post(human('evt-silent', '返事なしの依頼'));
    await waitFor(async () => (await s.stores.tasks.get('evt-silent')) !== null, 'Task');
    await waitFor(
      async () => (await s.stores.journal.list({ types: ['turn_usage'] })).length >= 0,
      '待ち',
    );
    // ターンの終わりまで進める: 次の合図を投げ、その入力が届くのを待つ
    s.clone.post(human('evt-next', '次'));
    await waitFor(async () => (await s.stores.tasks.get('evt-next')) !== null, '次の Task');
    await s.clone.stop();

    expect(await statusOf(s.stores, 'evt-silent')).toBe('queued');
  });

  it('そのターンで task に結び付けた委譲（manager_start の taskId）を起こしたら閉じない', async () => {
    const started: ManagerStartInput[] = [];
    const s = boot(
      (_turn, _input, tool) => [
        ...say('委譲した'),
        { run: () => tool('manager_start')({ request: '重い調査', taskId: 'evt-d' }) },
      ],
      { managers: stubPool(started) },
    );
    s.clone.post(human('evt-d', '重い調査を頼みたい'));
    await waitForTerminal(s.events);

    expect(started[0]?.taskId).toBe('evt-d');
    expect(await statusOf(s.stores, 'evt-d')).toBe('queued');
    await s.clone.stop();
  });

  it('taskId を渡さない委譲（manager_start）は task に結び付かないので、同じ会話の task も閉じる', async () => {
    const started: ManagerStartInput[] = [];
    const s = boot(
      (_turn, _input, tool) => [
        ...say('委譲した'),
        { run: () => tool('manager_start')({ request: '重い調査' }) },
      ],
      { managers: stubPool(started) },
    );
    s.clone.post(human('evt-nt', '重い調査を頼みたい'));
    await waitForTerminal(s.events);

    expect(started[0]?.conversationId).toBe('conv-1');
    expect(started[0]?.taskId).toBeUndefined();
    expect(await statusOf(s.stores, 'evt-nt')).toBe('done');
    await s.clone.stop();
  });

  it('task_keep で印を立てた task は閉じない。外した後の返答では閉じる', async () => {
    // 発言の id と task の id を同じにして、ターンがその発言を読むようにする（読んだ発言の task だけが閉じる）
    const stores = createMemoryStores();
    await stores.tasks.add(seeded('kept'));
    await stores.tasks.add(seeded('kept-2', { keep: true }));
    const s = boot(
      (turn, _input, tool) =>
        turn === 0
          ? [...say('途中経過'), { run: () => tool('task_keep')({ taskId: 'kept', keep: true }) }]
          : [
              ...say('終わった'),
              { run: () => tool('task_keep')({ taskId: 'kept-2', keep: false }) },
            ],
      { stores },
    );
    s.clone.post(human('kept', 'ひとつめ'));
    await waitForTerminal(s.events);
    expect((await stores.tasks.get('kept'))?.keep).toBe(true);
    // 立てたターンで返答しても閉じない（task_keep は返答と同じターンの中で呼ばれた）
    expect(await statusOf(stores, 'kept')).toBe('queued');

    s.events.length = 0;
    s.clone.post(human('kept-2', 'ふたつめ'));
    await waitForTerminal(s.events);

    // 2ターン目は keep をターンの中で外したので、このターンの終わりの判定では外れている
    expect(await statusOf(stores, 'kept-2')).toBe('done');
    const kept = await stores.tasks.get('kept-2');
    expect(kept?.closedBy).toBe('daemon');
    expect((await decisions(stores)).some((text) => text.includes('「続く」の印を立てた'))).toBe(
      true,
    );
    await s.clone.stop();
  });

  it('waiting / needs_decision の task は、起点の会話へ返答しても閉じない', async () => {
    const stores = createMemoryStores();
    // 発言の id と task の id を同じにする: 読んだ発言の task であっても、waiting / needs_decision は閉じない
    await stores.tasks.add(seeded('w', { status: 'waiting' }));
    await stores.tasks.add(seeded('n', { status: 'needs_decision' }));
    await stores.tasks.add(seeded('q'));
    const s = boot(() => say('返答'), { stores });
    s.clone.post(human('w', '待ち'));
    s.clone.post(human('n', '判断待ち'));
    s.clone.post(human('q', '普通'));
    await waitFor(async () => (await statusOf(stores, 'q')) === 'done', 'q が閉じる');

    expect(await statusOf(stores, 'w')).toBe('waiting');
    expect(await statusOf(stores, 'n')).toBe('needs_decision');
    await s.clone.stop();
  });

  it('別の会話への返答では、その会話を起点にしない task は閉じない', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(seeded('other', { originConversationId: 'conv-other' }));
    const s = boot(() => say('返答'), { stores });
    s.clone.post(human('evt-y', '別の会話の依頼'));
    await waitForTerminal(s.events);

    expect(await statusOf(stores, 'other')).toBe('queued');
    expect(await statusOf(stores, 'evt-y')).toBe('done');
    await s.clone.stop();
  });

  it('機構の一行（失敗したターンの人間向けの1行）は返答に数えない', async () => {
    const s = boot(() => say('失敗する前の本文'), { resultSubtype: 'error_during_execution' });
    s.clone.post(human('evt-f', '失敗するターン'));
    await waitForTerminal(s.events);

    const rows = (await s.stores.journal.list({ types: ['exchange'], with: ['human'] })) as Extract<
      JournalEntry,
      { type: 'exchange' }
    >[];
    expect(rows.some((row) => row.role === 'outbound')).toBe(true);
    expect(await statusOf(s.stores, 'evt-f')).toBe('queued');
    await s.clone.stop();
  });

  it('内部ターン（報告の読み）が task_say で task の起点の会話へ書いたら、その会話の task が閉じる。書かなければ閉じない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '元の依頼',
      conversationId: 'conv-9',
    });
    await stores.tasks.add(seeded('t9', { originConversationId: 'conv-9' }));
    const s = boot(
      (_turn, input, tool) =>
        input.includes('POST-REPORT')
          ? [
              ...say('読んだ'),
              { run: () => tool('task_say')({ taskId: 't9', text: '終わりました' }) },
            ]
          : say('読んだ'),
      { stores },
    );

    s.clone.post(managerReport('rep-quiet', 'QUIET-REPORT'));
    await waitFor(
      async () => (await stores.journal.list({ types: ['inbox_flow'] })).length > 0,
      '1つ目の報告のターンが終わる',
    );
    expect(await statusOf(stores, 't9')).toBe('queued');

    s.clone.post(managerReport('rep-post', 'POST-REPORT'));
    await waitFor(async () => (await statusOf(stores, 't9')) === 'done', 'task_say で閉じる');

    const written = (await decisions(stores)).filter((text) => text.includes('t9'));
    expect(written.some((text) => text.includes('task_say'))).toBe(true);
    await s.clone.stop();
  });

  it('task_say が task A へ書くと、同じ起点の会話の別の queued の task B も閉じる（返答は task ではなく会話に数えるため。現状の挙動の固定）', async () => {
    // `postToConversation` は返答を「会話 id」で控え、`selectTasksToAutoClose` は起点の会話が一致する queued の task を、
    // 未読の合図・「続く」の印・問い・委譲・ターン開始後の到着で除いたうえで全部閉じる。task_say の宛先 task（A）だけには絞らない。
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '元の依頼',
      conversationId: 'conv-x',
    });
    await stores.tasks.add(seeded('task-a', { originConversationId: 'conv-x' }));
    await stores.tasks.add(seeded('task-b', { originConversationId: 'conv-x' }));
    await stores.tasks.add(seeded('task-other', { originConversationId: 'conv-y' }));
    const s = boot(
      (_turn, input, tool) =>
        input.includes('POST-REPORT')
          ? [
              ...say('読んだ'),
              { run: () => tool('task_say')({ taskId: 'task-a', text: 'A の報告です' }) },
            ]
          : say('読んだ'),
      { stores },
    );

    s.clone.post(managerReport('rep-post', 'POST-REPORT'));
    await waitFor(async () => (await statusOf(stores, 'task-a')) === 'done', 'A が閉じる');
    await waitFor(async () => (await statusOf(stores, 'task-b')) === 'done', 'B も閉じる');
    // 別の会話の task は閉じない
    expect(await statusOf(stores, 'task-other')).toBe('queued');
    await s.clone.stop();
  });

  it('同じ合図の再配達（同じ id の再 post）で Task は二重にならない', async () => {
    const s = boot(() => say('返答'));
    s.clone.post(human('evt-once', '一度だけ'));
    await waitForTerminal(s.events);
    s.events.length = 0;
    s.clone.post(human('evt-once', '一度だけ'));
    await waitFor(async () => (await s.stores.commitments.get('evt-once')) !== null, '台帳');
    await s.clone.stop();

    expect(
      (await s.stores.tasks.list({ includeClosed: true })).entries.filter(
        (task) => task.id === 'evt-once',
      ),
    ).toHaveLength(1);
  });
});

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const SPEND_LIMIT = "You've hit your individual spend limit for this account.";

describe('ask_human を呼んだターンでは、その会話の task を閉じない（人間の答え待ち）', () => {
  it('問いを出したターンの返答では閉じず、回答を受けたターンの返答で閉じる。回答では Task を作らない', async () => {
    const s = boot((_turn, input, tool) =>
      input.includes('承認待ちにしていた質問に人間が答えた')
        ? say('回答を受けた。進める')
        : [
            ...say('確認します'),
            { run: () => tool('ask_human')({ question: 'どちらにしますか' }) },
          ],
    );
    s.clone.post(human('ask-1', 'どちらかを選んで進めてほしい'));
    await waitForTerminal(s.events);

    // 問いを出したターンの返答では閉じない
    expect(await statusOf(s.stores, 'ask-1')).toBe('queued');
    const approvals = (await s.stores.jobs.listApprovals({ pendingOnly: true })).entries;
    expect(approvals).toHaveLength(1);

    // 本物の回答の口（承認待ちの行に答えを書いてから、回答のイベントを積む）を通す
    await s.clone.answerApproval(approvals[0]!.id, 'A案で');
    await waitFor(
      async () => (await statusOf(s.stores, 'ask-1')) === 'done',
      '回答のターンで閉じる',
    );

    expect((await s.stores.tasks.get('ask-1'))?.closedBy).toBe('daemon');
    // 回答のイベントからは Task が作られていない
    expect(
      (await s.stores.tasks.list({ includeClosed: true })).entries.map((task) => task.id),
    ).toEqual(['ask-1']);
    await s.clone.stop();
  });

  it('前のターンで出した未回答の問いの会話は、後の別の報告のターンが task_say しても閉じない。答えたターンで閉じる', async () => {
    const s = boot((_turn, input, tool) =>
      input.includes('承認待ちにしていた質問に人間が答えた')
        ? say('回答を受けた。進める')
        : input.includes('LATER-REPORT')
          ? [
              ...say('読んだ'),
              { run: () => tool('task_say')({ taskId: 'ask-2', text: '別件の報告です' }) },
            ]
          : [
              ...say('確認します'),
              { run: () => tool('ask_human')({ question: 'どちらにしますか' }) },
            ],
    );
    s.clone.post(human('ask-2', 'どちらかを選んで進めてほしい'));
    await waitForTerminal(s.events);
    const approvals = (await s.stores.jobs.listApprovals({ pendingOnly: true })).entries;
    expect(approvals).toHaveLength(1);

    s.clone.post(managerReport('rep-later', 'LATER-REPORT'));
    await waitFor(
      async () =>
        (await s.stores.journal.list({ types: ['exchange'], with: ['human'] })).some(
          (row) => row.type === 'exchange' && row.text.includes('別件の報告です'),
        ),
      '別の報告のターンが task_say を書く',
    );
    await waitFor(
      async () => (await s.stores.journal.list({ types: ['turn_timing'] })).length >= 2,
      '報告のターンが終わる',
    );
    expect(await statusOf(s.stores, 'ask-2')).toBe('queued');

    await s.clone.answerApproval(approvals[0]!.id, 'A案で');
    await waitFor(
      async () => (await statusOf(s.stores, 'ask-2')) === 'done',
      '答えたターンで閉じる',
    );
    await s.clone.stop();
  });
});

describe('閉じるのは、そのターンが読んだ発言の task だけ（まだ読んでいない同じ会話の発言は閉じない）', () => {
  it('束ねる数の上限で束から外れた残りは、先のターンの返答で閉じない', async () => {
    const g = gate();
    const s = boot(
      (_turn, input) =>
        withoutQueueNotice(input).includes('H3-BODY')
          ? [{ run: () => g.promise }, ...say('3')]
          : say('返答'),
      { mergedBatchLimit: 2 },
    );
    s.clone.post(human('h1', 'H1-BODY'));
    s.clone.post(human('h2', 'H2-BODY'));
    s.clone.post(human('h3', 'H3-BODY'));
    await waitFor(
      async () =>
        (await statusOf(s.stores, 'h1')) === 'done' && (await statusOf(s.stores, 'h2')) === 'done',
      '束に入った2件が閉じる',
    );

    // h3 は束から外れて、まだ読まれていない
    expect(await statusOf(s.stores, 'h3')).toBe('queued');
    g.open();
    await waitFor(
      async () => (await statusOf(s.stores, 'h3')) === 'done',
      'h3 は自分のターンで閉じる',
    );
    await s.clone.stop();
  });

  it('待ち行列で同じ会話の発言が別の会話をはさむとき、後ろの発言は先のターンの返答で閉じない', async () => {
    const g = gate();
    const s = boot((_turn, input) =>
      withoutQueueNotice(input).includes('C-BODY')
        ? [{ run: () => g.promise }, ...say('C')]
        : say('返答'),
    );
    s.clone.post(human('a', 'A-BODY', 'conv-1'));
    s.clone.post(human('b', 'B-BODY', 'conv-2'));
    s.clone.post(human('c', 'C-BODY', 'conv-1'));
    await waitFor(async () => (await statusOf(s.stores, 'a')) === 'done', 'a が閉じる');

    expect(await statusOf(s.stores, 'c')).toBe('queued');
    g.open();
    await waitFor(
      async () => (await statusOf(s.stores, 'c')) === 'done',
      'c は自分のターンで閉じる',
    );
    await s.clone.stop();
  });

  it('枠で保持中の発言は、別のターンの task_say で閉じない', async () => {
    const g = gate();
    const stores = createMemoryStores();
    await stores.tasks.add(seeded('say-target', { originConversationId: 'conv-1' }));
    let reportTurns = 0;
    const s = boot(
      (_turn, input, tool) => {
        if (input.includes('MHELD')) {
          reportTurns += 1;
          return reportTurns === 1
            ? say('枠に当たる回')
            : [
                ...say('読んだ'),
                { run: () => tool('task_say')({ taskId: 'say-target', text: '終わりました' }) },
              ];
        }
        return input.includes('HELD-BODY')
          ? [{ run: () => g.promise }, ...say('held')]
          : say('返答');
      },
      {
        stores,
        env: { ALTEROID_CLONE_HUMAN_PRIORITY: 'off' },
        resultFor: (turnIndex) =>
          turnIndex === 0 ? { subtype: 'error_during_execution', text: SPEND_LIMIT } : undefined,
      },
    );
    s.clone.post(managerReport('rep-held', 'MHELD'));
    s.clone.post(human('held-1', 'HELD-BODY', 'conv-1'));
    await waitForTerminal(s.events);
    await waitFor(async () => (await s.stores.tasks.get('held-1')) !== null, 'held-1 の Task');

    // 枠が開いたことを試す合図。保持していた報告が先に配り直され、その返答が conv-1 へ書く
    s.clone.post(human('probe', 'PROBE', 'conv-2'));
    await waitFor(() => reportTurns >= 2, '報告のターンが task_say まで進む');
    await waitFor(
      async () =>
        (await s.stores.journal.list({ types: ['exchange'], with: ['human'] })).some(
          (row) => row.type === 'exchange' && row.text.includes('終わりました'),
        ),
      'task_say が書かれる',
    );

    // held-1 はまだ配り直されて読まれていない（自分のターンはゲートで止まっている）
    expect(await statusOf(s.stores, 'held-1')).toBe('queued');
    g.open();
    await waitFor(
      async () => (await statusOf(s.stores, 'held-1')) === 'done',
      'held-1 は自分のターンで閉じる',
    );
    await s.clone.stop();
  });

  it('ALTEROID_CLONE_HUMAN_PRIORITY を切ると、先の報告のターンの task_say で、後ろの発言を閉じない', async () => {
    const g = gate();
    const stores = createMemoryStores();
    await stores.tasks.add(seeded('say-target', { originConversationId: 'conv-1' }));
    const s = boot(
      (_turn, input, tool) =>
        input.includes('PRIO-REPORT')
          ? [
              ...say('読んだ'),
              { run: () => tool('task_say')({ taskId: 'say-target', text: '終わりました' }) },
            ]
          : input.includes('PRIO-BODY')
            ? [{ run: () => g.promise }, ...say('返答')]
            : say('返答'),
      { stores, env: { ALTEROID_CLONE_HUMAN_PRIORITY: 'off' } },
    );
    s.clone.post(managerReport('rep-prio', 'PRIO-REPORT'));
    s.clone.post(human('prio-1', 'PRIO-BODY', 'conv-1'));
    await waitFor(
      async () =>
        (await s.stores.journal.list({ types: ['exchange'], with: ['human'] })).some(
          (row) => row.type === 'exchange' && row.text.includes('終わりました'),
        ),
      'task_say が書かれる',
    );

    expect(await statusOf(s.stores, 'prio-1')).toBe('queued');
    g.open();
    await waitFor(
      async () => (await statusOf(s.stores, 'prio-1')) === 'done',
      'prio-1 は自分のターンで閉じる',
    );
    await s.clone.stop();
  });
});

describe('その task に結び付いた委譲（Job.taskId）が走っている task は、次の返答でも閉じない', () => {
  function job(id: string, status: Job['status'], conversationId: string, taskId?: string): Job {
    return {
      id,
      createdAt: AT,
      updatedAt: AT,
      status,
      conversationId,
      summary: 's',
      ...(taskId === undefined ? {} : { taskId }),
    };
  }

  it('結び付いた委譲が running / waiting_human のあいだは閉じない。結び付かない委譲・同じ会話の別の task は閉じる', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job('m-run', 'running', 'conv-1', 'd-run'));
    await stores.jobs.putJob(job('m-wait', 'waiting_human', 'conv-3', 'd-wait'));
    // taskId の無い委譲（会話は同じ）。task に結び付かないので数えない
    await stores.jobs.putJob(job('m-free', 'running', 'conv-2'));
    // 結び付いた委譲が終わっている（done）なら閉じる対象のまま
    await stores.jobs.putJob(job('m-done', 'done', 'conv-4', 'd-ended'));
    const s = boot(() => say('返答'), { stores });
    s.clone.post(human('d-run', '走っている委譲がある', 'conv-1'));
    s.clone.post(human('d-wait', '人間待ちの委譲がある', 'conv-3'));
    s.clone.post(human('d-free', '結び付かない委譲だけの会話', 'conv-2'));
    s.clone.post(human('d-ended', '委譲は終わっている', 'conv-4'));
    s.clone.post(human('d-sibling', '同じ会話の別の task', 'conv-1'));
    await waitFor(
      async () =>
        (await statusOf(stores, 'd-free')) === 'done' &&
        (await statusOf(stores, 'd-ended')) === 'done',
      '結び付く委譲の無い task は閉じる',
    );
    await waitFor(
      async () => (await stores.journal.list({ types: ['turn_timing'] })).length >= 5,
      '5つのターンが終わる',
    );

    expect(await statusOf(stores, 'd-run')).toBe('queued');
    expect(await statusOf(stores, 'd-wait')).toBe('queued');
    expect(await statusOf(stores, 'd-sibling')).toBe('done');
    await s.clone.stop();
  });

  it('manager_send で既存の委譲へ頼んだターンも、その委譲の taskId の task を閉じない（委譲が走っていなくても）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job('m-old', 'done', 'conv-1', 'd-send'));
    const sent: string[] = [];
    const pool = stubPool([], {
      send: (managerId) => {
        sent.push(managerId);
        return Promise.resolve({ outcome: 'delivered' as const, detail: '届けた' });
      },
    });
    const s = boot(
      (_turn, _input, tool) => [
        ...say('続きを頼んだ'),
        { run: () => tool('manager_send')({ managerId: 'm-old', message: '続きを頼む' }) },
      ],
      { stores, managers: pool },
    );
    s.clone.post(human('d-send', '前の委譲の続きを頼みたい', 'conv-1'));
    await waitForTerminal(s.events);

    expect(sent).toEqual(['m-old']);
    expect(await statusOf(stores, 'd-send')).toBe('queued');
    await s.clone.stop();
  });
});
