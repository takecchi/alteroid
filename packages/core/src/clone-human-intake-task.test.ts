import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import {
  fakeSdk,
  fakeScriptedSdk,
  waitFor,
  waitForTerminal,
  wireEvents,
} from './clone-test-harness.js';
import type { ScriptedStep } from './clone-test-harness.js';
import { migrateCommitmentsToTasks } from './commitment-task-migration.js';
import type { ManagerPool, ManagerStartInput, ManagerSummary } from './manager.js';
import type { RunnerFleetOverview } from './manager.js';
import type { RunnerLiveness } from './runner-protocol.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import type { InboxEvent, JournalEntry, Task } from './schema.js';
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

function stubPool(started: ManagerStartInput[] = []): ManagerPool {
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
  };
}

const say = (text: string): ScriptedStep[] => [
  { delta: text },
  { assistant: [{ type: 'text', text }] },
];

type Tools = (name: string) => (args: Record<string, unknown>) => Promise<unknown>;

function boot(
  script: (turnIndex: number, input: string, tool: Tools) => ScriptedStep[],
  options: { stores?: Stores; managers?: ManagerPool; resultSubtype?: string } = {},
) {
  const stores = options.stores ?? createMemoryStores();
  let captured: ToolContext | undefined;
  const tool: Tools = (name) => (args) => {
    const found = createCloneTools(captured!).find((entry) => entry.name === name);
    if (found === undefined) throw new Error(`${name} が無い`);
    return found.handler(args as never, {});
  };
  const { fn } = fakeScriptedSdk(
    (turnIndex, input) => script(turnIndex, input, tool),
    options.resultSubtype === undefined ? {} : { resultSubtype: options.resultSubtype },
  );
  const clone = createClone({
    redeliveryGate: ALWAYS_REDELIVER,
    stores,
    queryFn: fn,
    env: {},
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

  it('human_answer: 台帳の行と同じ id の Task になるが、起点の会話は付かない', async () => {
    const s = boot(() => say('承認の回答を受けた'));
    s.clone.post({
      type: 'human_answer',
      id: 'ans-1',
      at: new Date().toISOString(),
      approvalId: 'appr-1',
      answer: '進めてよい',
    });
    await waitFor(async () => (await s.stores.tasks.get('ans-1')) !== null, 'Task が積まれる');

    const created = await s.stores.tasks.get('ans-1');
    expect(created?.origin).toBe('human');
    expect(created?.source).toBe('appr-1');
    expect(created?.originConversationId).toBeUndefined();
    expect((await s.stores.commitments.get('ans-1'))?.id).toBe('ans-1');
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

    const report = await migrateCommitmentsToTasks(s.stores, {
      dryRun: false,
      now: new Date().toISOString(),
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

  it('そのターンで同じ起点の会話の委譲（manager_start）を起こしたら閉じない', async () => {
    const started: ManagerStartInput[] = [];
    const s = boot(
      (_turn, _input, tool) => [
        ...say('委譲した'),
        { run: () => tool('manager_start')({ request: '重い調査' }) },
      ],
      { managers: stubPool(started) },
    );
    s.clone.post(human('evt-d', '重い調査を頼みたい'));
    await waitForTerminal(s.events);

    expect(started[0]?.conversationId).toBe('conv-1');
    expect(await statusOf(s.stores, 'evt-d')).toBe('queued');
    await s.clone.stop();
  });

  it('task_keep で印を立てた task は閉じない。外した後の返答では閉じる', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(seeded('kept'));
    const s = boot(
      (turn, _input, tool) =>
        turn === 0
          ? [...say('途中経過'), { run: () => tool('task_keep')({ taskId: 'kept', keep: true }) }]
          : [...say('終わった'), { run: () => tool('task_keep')({ taskId: 'kept', keep: false }) }],
      { stores },
    );
    s.clone.post(human('evt-1', 'ひとつめ'));
    await waitForTerminal(s.events);
    expect((await stores.tasks.get('kept'))?.keep).toBe(true);
    // 立てたターンで返答しても閉じない（task_keep は返答と同じターンの中で呼ばれた）
    expect(await statusOf(stores, 'kept')).toBe('queued');
    expect(await statusOf(stores, 'evt-1')).toBe('done');

    s.events.length = 0;
    s.clone.post(human('evt-2', 'ふたつめ'));
    await waitForTerminal(s.events);

    // 2ターン目は keep を外したのは返答の後（ターンの中の道具）なので、このターンの終わりの判定では外れている
    expect(await statusOf(stores, 'kept')).toBe('done');
    const kept = await stores.tasks.get('kept');
    expect(kept?.closedBy).toBe('daemon');
    expect((await decisions(stores)).some((text) => text.includes('「続く」の印を立てた'))).toBe(
      true,
    );
    await s.clone.stop();
  });

  it('waiting / needs_decision の task は、起点の会話へ返答しても閉じない', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(seeded('w', { status: 'waiting' }));
    await stores.tasks.add(seeded('n', { status: 'needs_decision' }));
    await stores.tasks.add(seeded('q'));
    const s = boot(() => say('返答'), { stores });
    s.clone.post(human('evt-x', '別件'));
    await waitForTerminal(s.events);

    expect(await statusOf(stores, 'w')).toBe('waiting');
    expect(await statusOf(stores, 'n')).toBe('needs_decision');
    expect(await statusOf(stores, 'q')).toBe('done');
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

  it('内部ターン（報告の読み）が conversation_post で起点の会話へ書いたら閉じる。書かなければ閉じない', async () => {
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
              {
                run: () =>
                  tool('conversation_post')({ text: '終わりました', conversationId: 'conv-9' }),
              },
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
    await waitFor(
      async () => (await statusOf(stores, 't9')) === 'done',
      'conversation_post で閉じる',
    );

    const written = (await decisions(stores)).filter((text) => text.includes('t9'));
    expect(written.some((text) => text.includes('conversation_post'))).toBe(true);
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
