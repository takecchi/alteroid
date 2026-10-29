import { describe, expect, it } from 'vitest';

import { commitmentFor } from './clone.js';
import {
  autoCloseRepliedTasks,
  selectTasksToAutoClose,
  taskFromHumanIntake,
  turnDelegatedForTask,
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
): TurnReplyTrace {
  return {
    startedAt: TURN_START,
    replied: new Map(Object.entries(replied)),
    delegatedOriginConversationIds: new Set(delegated),
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

  it('そのターンで同じ起点の会話の委譲を起こしていれば閉じない', () => {
    expect(
      selectTasksToAutoClose([task('a')], trace({ 'conv-1': 'turn_reply' }, ['conv-1'])),
    ).toEqual([]);
    // 別の会話を起点にした委譲では、この task は閉じる
    expect(
      selectTasksToAutoClose([task('a')], trace({ 'conv-1': 'turn_reply' }, ['conv-2'])).map(
        (t) => t.id,
      ),
    ).toEqual(['a']);
  });

  it('ターンの始まりより後に届いた task は閉じない（返答の宛先になっていない）', () => {
    const late = task('late', { createdAt: '2026-10-29T00:10:00.001Z' });
    const exact = task('exact', { createdAt: TURN_START });
    expect(selectTasksToAutoClose([late, exact], trace()).map((t) => t.id)).toEqual(['exact']);
  });

  it('委譲の判定は1つの関数（P3 で task.id との一致へ置き換える点）にまとまっている', () => {
    expect(turnDelegatedForTask(task('a'), trace({}, ['conv-1']))).toBe(true);
    expect(turnDelegatedForTask(task('a'), trace({}, []))).toBe(false);
    expect(
      turnDelegatedForTask(task('a', { originConversationId: undefined }), trace({}, ['conv-1'])),
    ).toBe(false);
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

  it('返答の経路（conversation_post）を日誌に書き分ける', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(task('a'));
    await autoCloseRepliedTasks(stores, trace({ 'conv-1': 'conversation_post' }), NOW);
    const [entry] = (await stores.journal.list({ types: ['decision'] })) as Extract<
      JournalEntry,
      { type: 'decision' }
    >[];
    expect(entry?.grounds).toContain('conversation_post');
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

describe('taskFromHumanIntake: 台帳の行と同じ id の Task', () => {
  const at = '2026-10-29T01:00:00.000Z';
  const message: InboxEvent = {
    type: 'human_message',
    id: 'evt-1',
    at,
    text: `${'あ'.repeat(70)}\n2行目`,
    conversationId: 'conv-9',
  };
  const answer: InboxEvent = {
    type: 'human_answer',
    id: 'evt-2',
    at,
    approvalId: 'appr-1',
    answer: 'はい',
  };

  it('human_message: id・source は台帳の行と同じ、起点の会話付き、title は先頭行60字', () => {
    const entry = commitmentFor(message);
    expect(entry).not.toBeNull();
    const built = taskFromHumanIntake(entry!, message, NOW);
    expect(built).toMatchObject({
      id: 'evt-1',
      status: 'queued',
      origin: 'human',
      source: 'conv-9',
      originConversationId: 'conv-9',
      createdAt: at,
    });
    expect([...built.title]).toHaveLength(60);
    expect(built.title.endsWith('…')).toBe(true);
    expect(built.body).toBe(entry?.body);
  });

  it('human_answer: 起点の会話は付けない（会話 id が無い）', () => {
    const entry = commitmentFor(answer);
    const built = taskFromHumanIntake(entry!, answer, NOW);
    expect(built.id).toBe('evt-2');
    expect(built.source).toBe('appr-1');
    expect(built.originConversationId).toBeUndefined();
  });
});

describe('commitmentFor: 人間の合図だけが台帳に開く（#5469 P5）', () => {
  const at = '2026-10-29T01:00:00.000Z';

  it('manager_message・external・timer・self_initiative は開かない', () => {
    const events: InboxEvent[] = [
      { type: 'manager_message', id: 'm', at, managerId: 'mgr', kind: 'report', text: '終わった' },
      { type: 'external', id: 'x', at, source: 'github', payload: { a: 1 } },
      { type: 'timer', id: 't', at, kind: 'k', reason: 'r' } as unknown as InboxEvent,
      { type: 'self_initiative', id: 's', at, reason: 'r' } as unknown as InboxEvent,
    ];
    for (const event of events) expect(commitmentFor(event), event.type).toBeNull();
  });

  it('human_message・human_answer は開く', () => {
    expect(
      commitmentFor({ type: 'human_message', id: 'h', at, text: 'やって', conversationId: 'c' })
        ?.origin,
    ).toBe('human');
    expect(
      commitmentFor({ type: 'human_answer', id: 'a', at, approvalId: 'p', answer: 'ok' })?.origin,
    ).toBe('human');
  });
});
