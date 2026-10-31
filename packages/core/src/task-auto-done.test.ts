import { describe, expect, it } from 'vitest';

import {
  autoCloseRepliedTasks,
  selectTasksToAutoClose,
  hasDelegationForTask,
  opensHumanTask,
  taskFromHumanIntake,
} from './task-auto-done.js';
import type { TurnReplyTrace, TurnReplyVia } from './task-auto-done.js';
import type { InboxEvent, JournalEntry, Task } from './schema.js';
import { createMemoryStores } from './testing.js';

const T0 = '2026-10-29T00:00:00.000Z';
const TURN_START = '2026-10-29T00:10:00.000Z';
const NOW = '2026-10-29T00:11:00.000Z';

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    createdAt: T0,
    updatedAt: T0,
    status: 'queued',
    origin: 'human',
    title: `title-${id}`,
    body: `BODY-SECRET-${id}`,
    originConversationId: 'conv-1',
    ...overrides,
  };
}

function trace(
  replied: Record<string, TurnReplyVia> = { 'conv-1': 'turn_reply' },
  delegated: string[] = [],
  extra: {
    read?: string[];
    unread?: string[];
    asked?: string[];
    active?: string[];
  } = {},
): TurnReplyTrace {
  return {
    startedAt: TURN_START,
    replied: new Map(Object.entries(replied)),
    readSignalIds: new Set(extra.read ?? []),
    unreadSignalIds: new Set(extra.unread ?? []),
    askedConversationIds: new Set(extra.asked ?? []),
    delegatedTaskIds: new Set(delegated),
    activeJobTaskIds: new Set(extra.active ?? []),
  };
}

describe('selectTasksToAutoClose: 何を閉じ、何を閉じないか', () => {
  it('起点の会話へ返答したターンの、queued で印の無い task を選ぶ', () => {
    expect(selectTasksToAutoClose([task('a')], trace()).map((t) => t.id)).toEqual(['a']);
  });

  it('waiting / needs_decision は閉じない（待ち・判断待ちを器が勝手に閉じない）', () => {
    const tasks = [
      task('q'),
      task('w', { status: 'waiting' }),
      task('n', { status: 'needs_decision' }),
    ];
    expect(selectTasksToAutoClose(tasks, trace()).map((t) => t.id)).toEqual(['q']);
  });

  it('「続く」の印（keep）の task は閉じない', () => {
    expect(selectTasksToAutoClose([task('k', { keep: true })], trace())).toEqual([]);
  });

  it('別の会話への返答では閉じない。起点の会話が無い task も閉じない', () => {
    const tasks = [
      task('other', { originConversationId: 'conv-2' }),
      task('none', { originConversationId: undefined }),
    ];
    expect(selectTasksToAutoClose(tasks, trace())).toEqual([]);
  });

  it('そのターンでその task に結び付けた委譲を頼んでいれば閉じない（task の id の一致だけで見る）', () => {
    expect(selectTasksToAutoClose([task('a')], trace({ 'conv-1': 'turn_reply' }, ['a']))).toEqual(
      [],
    );
    // 別の task のための委譲では、この task は閉じる。同じ会話でも task が違えば巻き込まない
    expect(
      selectTasksToAutoClose([task('a'), task('b')], trace({ 'conv-1': 'turn_reply' }, ['b'])).map(
        (t) => t.id,
      ),
    ).toEqual(['a']);
  });

  it('ターンの始まりより後に届いた task は閉じない（返答の宛先になっていない）', () => {
    const late = task('late', { createdAt: '2026-10-29T00:10:00.001Z' });
    const exact = task('exact', { createdAt: TURN_START });
    expect(selectTasksToAutoClose([late, exact], trace()).map((t) => t.id)).toEqual(['exact']);
  });

  it('委譲の判定は task.id と Job.taskId の一致だけ（hasDelegationForTask）', () => {
    expect(hasDelegationForTask(task('a'), trace({}, ['a']))).toBe(true);
    expect(hasDelegationForTask(task('a'), trace({}, ['b']))).toBe(false);
    expect(hasDelegationForTask(task('a'), trace({}, []))).toBe(false);
    // 前のターンで起こして、いまも走っている委譲（このターンの控えには無い）
    expect(hasDelegationForTask(task('a'), trace({}, [], { active: ['a'] }))).toBe(true);
    expect(hasDelegationForTask(task('a'), trace({}, [], { active: ['b'] }))).toBe(false);
    // 会話 id では見ない
    expect(hasDelegationForTask(task('a'), trace({}, ['conv-1'], { active: ['conv-1'] }))).toBe(
      false,
    );
  });

  it('前のターンで起こして走っている委譲（running / waiting_human）が結び付いた task は、次の返答でも閉じない', () => {
    expect(
      selectTasksToAutoClose(
        [task('a'), task('b')],
        trace({ 'conv-1': 'turn_reply' }, [], { active: ['a'] }),
      ).map((t) => t.id),
    ).toEqual(['b']);
  });

  it('そのターンで問い（ask_human）を出した会話の task は閉じない。別の会話の task は閉じる', () => {
    const tasks = [task('a'), task('b', { originConversationId: 'conv-2' })];
    expect(
      selectTasksToAutoClose(
        tasks,
        trace({ 'conv-1': 'turn_reply', 'conv-2': 'task_say' }, [], { asked: ['conv-1'] }),
      ).map((t) => t.id),
    ).toEqual(['b']);
  });

  it('turn_reply: そのターンが読んだ発言の id の task だけ閉じる（同じ会話のまだ読んでいない発言は閉じない）', () => {
    const tasks = [task('read'), task('unread')];
    expect(
      selectTasksToAutoClose(tasks, trace({ 'conv-1': 'turn_reply' }, [], { read: ['read'] })).map(
        (t) => t.id,
      ),
    ).toEqual(['read']);
  });

  it('task_say: 受信箱にまだ残っている合図の task を除く', () => {
    const tasks = [task('done-reading'), task('still-in-inbox')];
    expect(
      selectTasksToAutoClose(
        tasks,
        trace({ 'conv-1': 'task_say' }, [], { unread: ['still-in-inbox'] }),
      ).map((t) => t.id),
    ).toEqual(['done-reading']);
  });

  it('回答のターン（読んだ発言が無い）の返答: 受信箱にまだ残っている合図の task を除いて閉じる', () => {
    const tasks = [task('asker'), task('later')];
    expect(
      selectTasksToAutoClose(
        tasks,
        trace({ 'conv-1': 'turn_reply' }, [], { unread: ['later'] }),
      ).map((t) => t.id),
    ).toEqual(['asker']);
  });
});

describe('autoCloseRepliedTasks: 閉じて日誌に残す', () => {
  it('done・closedBy daemon・理由が残り、日誌には id と title だけが書かれる（本文は書かない）', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(task('a'));

    const outcome = await autoCloseRepliedTasks(stores, trace(), NOW);

    expect(outcome.closed.map((t) => t.id)).toEqual(['a']);
    const closed = await stores.tasks.get('a');
    expect(closed?.status).toBe('done');
    expect(closed?.closedBy).toBe('daemon');
    expect(closed?.closedAt).toBe(NOW);
    expect(closed?.closedReason).toContain('起点の会話へ返答したので自動で閉じた');
    const decisions = (await stores.journal.list({ types: ['decision'] })) as Extract<
      JournalEntry,
      { type: 'decision' }
    >[];
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decision).toContain('a: title-a');
    expect(decisions[0]?.decision).toContain('conv-1');
    expect(`${decisions[0]?.decision}${decisions[0]?.grounds}`).not.toContain('BODY-SECRET');
    expect(decisions[0]?.grounds).toContain('そのターン自身の返答');
  });

  it('返答の経路（task_say）を日誌に書き分ける', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(task('a'));
    await autoCloseRepliedTasks(stores, trace({ 'conv-1': 'task_say' }), NOW);
    const [entry] = (await stores.journal.list({ types: ['decision'] })) as Extract<
      JournalEntry,
      { type: 'decision' }
    >[];
    expect(entry?.grounds).toContain('task_say');
  });

  it('返答が無ければ何も読まず何も書かない', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(task('a'));
    const outcome = await autoCloseRepliedTasks(stores, trace({}), NOW);
    expect(outcome.closed).toEqual([]);
    expect((await stores.tasks.get('a'))?.status).toBe('queued');
    expect(await stores.journal.list({ types: ['decision'] })).toHaveLength(0);
  });

  it('閉じた task は includeClosed で読み返せる', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(task('a'));
    await autoCloseRepliedTasks(stores, trace(), NOW);
    expect((await stores.tasks.list()).entries).toEqual([]);
    expect((await stores.tasks.list({ includeClosed: true })).entries.map((t) => t.id)).toEqual([
      'a',
    ]);
  });

  it('日誌が書けなくても閉じた事実は戻さず、failed に数える', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(task('a'));
    const failing = {
      tasks: stores.tasks,
      journal: {
        ...stores.journal,
        append: () => Promise.reject(new Error('journal down')),
      },
    } as unknown as Pick<typeof stores, 'tasks' | 'journal'>;
    const outcome = await autoCloseRepliedTasks(failing, trace(), NOW);
    expect(outcome.failed).toEqual([{ id: 'a', step: 'journal' }]);
    expect((await stores.tasks.get('a'))?.status).toBe('done');
  });
});

describe('taskFromHumanIntake: 合図と同じ id の Task', () => {
  const at = '2026-10-29T01:00:00.000Z';
  const message: Extract<InboxEvent, { type: 'human_message' }> = {
    type: 'human_message',
    id: 'evt-1',
    at,
    text: `${'あ'.repeat(70)}\n2行目`,
    conversationId: 'conv-9',
  };
  const ref = (id: string, name: string) => ({
    id,
    name,
    mediaType: 'text/plain',
    size: 1,
    sha256: 'a'.repeat(64),
  });

  it('human_message: id・source は合図のとおり、起点の会話付き、title は先頭行60字、本文は全文', () => {
    const built = taskFromHumanIntake(message, NOW);
    expect(built).toMatchObject({
      id: 'evt-1',
      status: 'queued',
      origin: 'human',
      source: 'conv-9',
      originConversationId: 'conv-9',
      createdAt: at,
      updatedAt: NOW,
    });
    expect([...built.title]).toHaveLength(60);
    expect(built.title.endsWith('…')).toBe(true);
    expect(built.body).toBe(message.text);
  });

  it('添付だけの発言は、本文が空にならず添付の名前が入る（#4029）', () => {
    const built = taskFromHumanIntake(
      { ...message, text: '', attachments: [ref('a1', 'shot.png')] },
      NOW,
    );
    expect(built.body).toBe('［添付 1件: shot.png］');
    expect(built.title).toBe('［添付 1件: shot.png］');
  });

  it('本文と添付の両方がある発言は、本文の後ろに添付の名前が付く', () => {
    const built = taskFromHumanIntake(
      {
        ...message,
        text: 'これを見て',
        attachments: [ref('a1', 'shot.png'), ref('a2', 'run.log')],
      },
      NOW,
    );
    expect(built.body).toBe('これを見て［添付 2件: shot.png、run.log］');
  });

  it('添付が多いときは先頭の3件の名前だけを出し、残りは件数にする', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((n) => ref(n, `${n}.txt`));
    expect(taskFromHumanIntake({ ...message, text: '', attachments: many }, NOW).body).toBe(
      '［添付 5件: a.txt、b.txt、c.txt、ほか 2 件］',
    );
  });

  it('添付の無い発言の body は変わらない', () => {
    expect(taskFromHumanIntake({ ...message, text: 'やって' }, NOW).body).toBe('やって');
  });
});

describe('opensHumanTask: Task を開く合図は人間の発言だけ（#5469 P5・#5923）', () => {
  const at = '2026-10-29T01:00:00.000Z';

  it('manager_message・external・timer・self_initiative・human_answer は開かない', () => {
    const events: InboxEvent[] = [
      { type: 'manager_message', id: 'm', at, managerId: 'mgr', kind: 'report', text: '終わった' },
      { type: 'external', id: 'x', at, source: 'github', payload: { a: 1 } },
      { type: 'timer', id: 't', at, kind: 'k', reason: 'r' } as unknown as InboxEvent,
      { type: 'self_initiative', id: 's', at, reason: 'r' } as unknown as InboxEvent,
      { type: 'human_answer', id: 'a', at, approvalId: 'p', answer: 'ok' },
    ];
    for (const event of events) expect(opensHumanTask(event), event.type).toBe(false);
  });

  it('human_message は開く', () => {
    expect(
      opensHumanTask({ type: 'human_message', id: 'h', at, text: 'やって', conversationId: 'c' }),
    ).toBe(true);
  });
});
