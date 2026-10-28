import { describe, expect, it } from 'vitest';

import type { ManagerPool } from './manager.js';
import { resolveTaskPlacement } from './task-tools.js';
import { createMemoryStores } from './testing.js';
import { cloneToolJournalsItself, createCloneTools, qualifiedToolName } from './tools.js';

function harness() {
  const stores = createMemoryStores();
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
    managers: {} as unknown as ManagerPool,
  });
  return {
    stores,
    async call(name: string, args: Record<string, unknown>): Promise<string> {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`ツール ${name} が無い`);
      const result = await found.handler(args as never, {});
      return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    },
    async ids(): Promise<string[]> {
      return (await stores.tasks.list()).entries.map((task) => task.id);
    },
    async titles(): Promise<string[]> {
      return (await stores.tasks.list()).entries.map((task) => task.title);
    },
  };
}

async function journalText(h: ReturnType<typeof harness>): Promise<string> {
  return JSON.stringify(await h.stores.journal.list({ types: ['decision'] }));
}

describe('resolveTaskPlacement', () => {
  it('to を省くと既定の位置（placement なし）', () => {
    expect(resolveTaskPlacement(undefined, undefined)).toEqual({
      kind: 'ok',
      placement: undefined,
    });
  });
  it('before / after には anchorId が要り、front / back には付けられない', () => {
    expect(resolveTaskPlacement('before', undefined).kind).toBe('invalid');
    expect(resolveTaskPlacement('front', 'x').kind).toBe('invalid');
    expect(resolveTaskPlacement(undefined, 'x').kind).toBe('invalid');
    expect(resolveTaskPlacement('after', 'x')).toEqual({
      kind: 'ok',
      placement: { kind: 'after', anchorId: 'x' },
    });
  });
});

describe('task_* 道具', () => {
  it('操作の3つは自分で日誌に残す名簿に、task_list は残さない名簿に在る', () => {
    for (const name of ['task_add', 'task_move', 'task_set_status'] as const) {
      expect(cloneToolJournalsItself(qualifiedToolName(name))).toBe(true);
    }
    expect(cloneToolJournalsItself(qualifiedToolName('task_list'))).toBe(false);
  });

  it('task_add は origin self で足し、末尾へ入り、日誌に残す', async () => {
    const h = harness();
    await h.call('task_add', { title: '一つ目', body: '本文1' });
    await h.call('task_add', { title: '二つ目', body: '本文2' });
    expect(await h.titles()).toEqual(['一つ目', '二つ目']);
    const [first] = (await h.stores.tasks.list()).entries;
    expect(first?.origin).toBe('self');
    expect(first?.status).toBe('queued');
    expect(await journalText(h)).toContain('一つ目');
  });

  it('task_add は置き場所を指せる', async () => {
    const h = harness();
    await h.call('task_add', { title: 'a', body: 'a' });
    await h.call('task_add', { title: 'b', body: 'b', to: 'front' });
    expect(await h.titles()).toEqual(['b', 'a']);
    const [b, a] = await h.ids();
    await h.call('task_add', { title: 'c', body: 'c', to: 'after', anchorId: b });
    expect(await h.titles()).toEqual(['b', 'c', 'a']);
    const out = await h.call('task_add', { title: 'd', body: 'd', to: 'after', anchorId: 'nope' });
    expect(out).toContain('何も足していない');
    expect(await h.titles()).toEqual(['b', 'c', 'a']);
    expect(a).toBeDefined();
  });

  it.each([
    [{ title: '', body: 'x' }, 'title'],
    [{ title: '  ', body: 'x' }, 'title'],
    [{ title: 'a\nb', body: 'x' }, 'title'],
    [{ title: 'ok', body: '' }, 'body'],
    [{ title: 'ok', body: ' \n' }, 'body'],
    [{ title: 'ok', body: 'x', originConversationId: '\u0000' }, 'originConversationId'],
    [{ title: 'ok', body: 'x', to: 'before' }, 'anchorId'],
  ])('task_add は不正な入力 %j を断り、何も足さない', async (args, mention) => {
    const h = harness();
    const out = await h.call('task_add', args);
    expect(out).toContain(mention);
    expect(await h.ids()).toEqual([]);
    expect(await journalText(h)).not.toContain('task を足した');
  });

  it('task_move は並びを変え、閉じた件・自分自身の基準・無い id は断る', async () => {
    const h = harness();
    for (const title of ['a', 'b', 'c']) await h.call('task_add', { title, body: title });
    const [a, b, c] = await h.ids();
    expect(await h.call('task_move', { taskId: c, to: 'front' })).toContain('動かした');
    expect(await h.titles()).toEqual(['c', 'a', 'b']);
    await h.call('task_move', { taskId: c, to: 'after', anchorId: b });
    expect(await h.titles()).toEqual(['a', 'b', 'c']);
    expect(await h.call('task_move', { taskId: a, to: 'before', anchorId: a })).toContain('自身');
    expect(await h.call('task_move', { taskId: 'nope', to: 'back' })).toContain('無い');
    await h.call('task_set_status', { taskId: b, status: 'done', reason: '終わった' });
    expect(await h.call('task_move', { taskId: b, to: 'front' })).toContain('閉じている');
    expect(await h.call('task_move', { taskId: a, to: 'after', anchorId: b })).toContain(
      '開いている task に無い',
    );
    expect(await h.titles()).toEqual(['a', 'c']);
  });

  it('task_set_status は閉じるのに reason を要求し、断ったら何も変えず日誌にも残さない', async () => {
    const h = harness();
    await h.call('task_add', { title: 'a', body: 'a' });
    const [a] = await h.ids();
    for (const status of ['done', 'cancelled']) {
      expect(await h.call('task_set_status', { taskId: a, status })).toContain('reason が要る');
      expect(await h.call('task_set_status', { taskId: a, status, reason: ' ' })).toContain(
        'reason',
      );
    }
    expect((await h.stores.tasks.get(a!))?.status).toBe('queued');
    expect(await journalText(h)).not.toContain('状態を変えた');
  });

  it('開いている3状態は行き来でき、閉じた件は queued にだけ戻せて、閉じた記録が日誌へ逐語で残る', async () => {
    const h = harness();
    await h.call('task_add', { title: 'a', body: 'a' });
    const [a] = await h.ids();
    expect(await h.call('task_set_status', { taskId: a, status: 'waiting' })).toContain('移した');
    expect(await h.call('task_set_status', { taskId: a, status: 'needs_decision' })).toContain(
      '移した',
    );
    expect(await h.call('task_set_status', { taskId: a, status: 'needs_decision' })).toContain(
      '何もしていない',
    );
    await h.call('task_set_status', { taskId: a, status: 'cancelled', reason: 'やめた理由' });
    const closed = await h.stores.tasks.get(a!);
    expect(closed?.closedBy).toBe('clone');
    expect(closed?.closedReason).toBe('やめた理由');
    expect(await h.call('task_set_status', { taskId: a, status: 'waiting' })).toContain('移せない');
    expect((await h.stores.tasks.get(a!))?.status).toBe('cancelled');
    const out = await h.call('task_set_status', { taskId: a, status: 'queued', reason: '戻す' });
    expect(out).toContain('日誌に残してある');
    const reopened = await h.stores.tasks.get(a!);
    expect(reopened?.status).toBe('queued');
    expect(reopened?.closedAt).toBeUndefined();
    const text = await journalText(h);
    expect(text).toContain('やめた理由');
    expect(text).toContain('閉じた主体=clone');
  });

  it('task_list は一覧に抜粋だけを出し、全文は id で取れ、閉じた件は includeClosed で足される', async () => {
    const h = harness();
    const long = 'あ'.repeat(1_000);
    await h.call('task_add', { title: '長い', body: `${long}末尾の印` });
    await h.call('task_add', { title: '短い', body: '短い本文' });
    const [first, second] = await h.ids();
    const list = await h.call('task_list', {});
    expect(list).toContain('長い');
    expect(list).not.toContain('末尾の印');
    expect(list.indexOf(first!)).toBeLessThan(list.indexOf(second!));
    const detail = await h.call('task_list', { id: first });
    expect(detail).toContain('末尾の印');

    await h.call('task_set_status', { taskId: second, status: 'done', reason: '済んだ理由' });
    expect(await h.call('task_list', {})).not.toContain('短い本文');
    const withClosed = await h.call('task_list', { includeClosed: true });
    expect(withClosed).toContain('短い本文');
    const closedDetail = await h.call('task_list', { id: second });
    expect(closedDetail).toContain('済んだ理由');
    expect(await h.call('task_list', { id: 'nope' })).toContain('無い');
    expect(await h.call('task_list', { id: first, offset: -1 })).toContain('offset');
  });

  it('task_list は予算で切れたら続きの cursor を案内し、辿ると全件が1度ずつ出る', async () => {
    const h = harness();
    const long = 'あ'.repeat(300);
    for (let i = 0; i < 80; i++) {
      const pad = String(i).padStart(3, '0');
      await h.call('task_add', { title: `件${pad}`, body: `${long}${pad}` });
    }
    const all = await h.ids();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const out = await h.call('task_list', cursor === undefined ? {} : { cursor });
      for (const id of all) if (out.includes(id)) seen.push(id);
      const next = /task_list cursor=([A-Za-z0-9_-]+) で取れる/.exec(out);
      if (next === null) break;
      expect(out).not.toContain('この一覧に続きを取る口はまだ無い');
      cursor = next[1];
    }
    expect(seen).toEqual(all);
  });

  it('task_list の cursor は、壊れたもの・includeClosed の食い違い・錨が消えたものを黙って別の続きにしない', async () => {
    const h = harness();
    const long = 'あ'.repeat(300);
    for (let i = 0; i < 80; i++) await h.call('task_add', { title: `件${i}`, body: long });
    const first = await h.call('task_list', {});
    const cursor = /task_list cursor=([A-Za-z0-9_-]+) で取れる/.exec(first)![1]!;
    expect(await h.call('task_list', { cursor: 'xxxx' })).toContain('壊れている');
    expect(await h.call('task_list', { cursor, includeClosed: true })).toContain('includeClosed');
    const anchor = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).id as string;
    await h.call('task_set_status', { taskId: anchor, status: 'done', reason: '済み' });
    expect(await h.call('task_list', { cursor })).toContain('いまの一覧に居ない');
  });

  it('閉じた件の開き直しは日誌が先: 日誌が落ちたら閉じたままで、閉じた記録が残る', async () => {
    const stores = createMemoryStores();
    const realAppend = stores.journal.append.bind(stores.journal);
    let failing = false;
    stores.journal.append = async (entry) => {
      if (failing) throw new Error('journal down');
      return realAppend(entry);
    };
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      conversationId: () => undefined,
      memoryCause: () => 'clone',
      managers: {} as unknown as ManagerPool,
    });
    const call = async (name: string, args: Record<string, unknown>) => {
      const found = tools.find((entry) => entry.name === name)!;
      return found.handler(args as never, {});
    };
    await call('task_add', { title: 'a', body: 'a' });
    const [task] = (await stores.tasks.list()).entries;
    await call('task_set_status', { taskId: task!.id, status: 'done', reason: '終わった理由' });
    failing = true;
    await expect(
      call('task_set_status', { taskId: task!.id, status: 'queued', reason: '戻す' }),
    ).rejects.toThrow('行為は起きていない');
    const after = await stores.tasks.get(task!.id);
    expect(after?.status).toBe('done');
    expect(after?.closedReason).toBe('終わった理由');
    expect(after?.closedBy).toBe('clone');
  });

  it('task が1件も無いとき、空と言う', async () => {
    const h = harness();
    expect(await h.call('task_list', {})).toContain('task は無い');
  });

  it('台帳（commitment）とは別の器で、片方に足してももう片方には載らない', async () => {
    const h = harness();
    await h.call('task_add', { title: 'a', body: 'a' });
    expect((await h.stores.commitments.list()).entries).toHaveLength(0);
    await h.call('commitment_open', { body: '約束' });
    expect(await h.ids()).toHaveLength(1);
  });
});
