import { describe, expect, it } from 'vitest';

import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// 取り下げた発言を `conversation_read` の発言単位の読み（conversationId・q）が普通の発言として出していた（#5456）。
// `GET /conversations/:id` の `delivery: 'withdrawn'` と同じく、外さず注記つきで出す。

const MARK = '取り下げた発言。クローンへは届いていない';

function tools(stores: Stores) {
  const list = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  return async (args: Record<string, unknown>): Promise<string> => {
    const found = list.find((entry) => entry.name === 'conversation_read');
    if (!found) throw new Error('道具 conversation_read が無い');
    const result = (await found.handler(args as never, {} as never)) as {
      content: { text: string }[];
    };
    return result.content.map((part) => part.text).join('');
  };
}

async function inbound(
  stores: Stores,
  conversationId: string,
  text: string,
  clientMessageId: string,
): Promise<void> {
  await stores.journal.append({
    type: 'exchange',
    with: 'human',
    role: 'inbound',
    text,
    conversationId,
    clientMessageId,
  });
}

async function markWithdrawn(
  stores: Stores,
  conversationId: string,
  clientMessageId: string,
): Promise<void> {
  // `Clone#interruptTurn` が足す取り下げの印の行と同じ形
  await stores.journal.append({
    type: 'exchange',
    with: 'self',
    role: 'outbound',
    text: `[判断] 人間の求めで、順番待ちだった発言（clientMessageId ${clientMessageId}）を取り下げた。`,
    conversationId,
    withdrawnClientMessageId: clientMessageId,
  });
}

async function seeded(): Promise<Stores> {
  const stores = createMemoryStores();
  await inbound(stores, 'conv-w', '本番の X を消して', 'cm-withdrawn');
  await markWithdrawn(stores, 'conv-w', 'cm-withdrawn');
  await inbound(stores, 'conv-w', 'やっぱり Y を確認して', 'cm-live');
  await stores.journal.append({
    type: 'exchange',
    with: 'human',
    role: 'outbound',
    text: 'Y を確認します',
    conversationId: 'conv-w',
  });
  return stores;
}

function lineOf(output: string, needle: string): string {
  // 見出しの行（at・role・id と注記）と、その次の本文の行をまとめて返す
  const lines = output.split('\n');
  const index = lines.findIndex((line) => line.includes(needle));
  if (index < 1) throw new Error(`出力に ${needle} の行が無い: ${output}`);
  return `${lines[index - 1]!}\n${lines[index]!}`;
}

describe('conversation_read — 取り下げた発言（#5456）', () => {
  it('conversationId 指定: 取り下げた発言に注記が付き、取り下げていない発言には付かない', async () => {
    const read = tools(await seeded());
    const out = await read({ conversationId: 'conv-w' });
    expect(out).toContain('本番の X を消して');
    expect(lineOf(out, '本番の X を消して')).toContain(MARK);
    expect(lineOf(out, 'やっぱり Y を確認して')).not.toContain(MARK);
    expect(lineOf(out, 'Y を確認します')).not.toContain(MARK);
    expect(out).toContain('取り下げた発言が 1 件ある');
  });

  it('q 指定: 取り下げた発言に注記が付き、取り下げていない発言には付かない', async () => {
    const read = tools(await seeded());
    const withdrawn = await read({ q: '本番の X' });
    expect(withdrawn).toContain(MARK);
    expect(withdrawn).toContain('取り下げた発言が 1 件ある');
    const live = await read({ q: 'やっぱり Y' });
    expect(live).toContain('やっぱり Y を確認して');
    expect(live).not.toContain(MARK);
    expect(live).not.toContain('取り下げた発言が');
    expect(live).not.toContain('判定できなかった');
  });

  it('取り下げの印が1つも無い会話には、注記も判定不能の言い方も出ない', async () => {
    const stores = createMemoryStores();
    await inbound(stores, 'conv-ok', '普通の発言', 'cm-1');
    const read = tools(stores);
    const out = await read({ conversationId: 'conv-ok' });
    expect(out).toContain('普通の発言');
    expect(out).not.toContain(MARK);
    expect(out).not.toContain('取り下げた発言が');
    expect(out).not.toContain('判定できなかった');
  });

  it('印を引く口が投げる回: 判定できなかったと言い、取り下げていないとは断定しない（conversationId・q の両方）', async () => {
    const stores = await seeded();
    stores.journal.withdrawnClientMessageIds = async () => {
      throw new Error('印の読みが落ちた');
    };
    const read = tools(stores);
    for (const args of [{ conversationId: 'conv-w' }, { q: '本番の X' }]) {
      const out = await read(args);
      expect(out).toContain('取り下げの有無を判定できなかった');
      expect(out).toContain('印の読みが落ちた');
      expect(out).toContain('取り下げていないとは言えない');
      expect(out).not.toContain(MARK);
      expect(out).toContain('本番の X を消して');
    }
  });

  it('速い口（withdrawnClientMessageIds を持つ器）でも同じ注記が付く。since と会話の絞りを渡して引く', async () => {
    const stores = await seeded();
    const queries: { since: string; conversationId?: string }[] = [];
    stores.journal.withdrawnClientMessageIds = async (query) => {
      queries.push(query);
      return ['cm-withdrawn'];
    };
    const read = tools(stores);
    const byConversation = await read({ conversationId: 'conv-w' });
    expect(lineOf(byConversation, '本番の X を消して')).toContain(MARK);
    expect(lineOf(byConversation, 'やっぱり Y を確認して')).not.toContain(MARK);
    expect(queries[0]?.conversationId).toBe('conv-w');
    const bySearch = await read({ q: '本番の X' });
    expect(bySearch).toContain(MARK);
    expect(queries[1]?.conversationId).toBeUndefined();
    expect(queries[1]?.since).toBe(queries[0]?.since);
  });

  it('持たない器（listPage を頁で読み切る口）でも同じ注記が付く', async () => {
    const stores = await seeded();
    expect(stores.journal.withdrawnClientMessageIds).toBeUndefined();
    const read = tools(stores);
    const out = await read({ conversationId: 'conv-w' });
    expect(lineOf(out, '本番の X を消して')).toContain(MARK);
  });

  it('id 指定の全文の読み: 取り下げた発言には注記が付き、取り下げていない発言には付かない', async () => {
    const stores = createMemoryStores();
    const withdrawn = await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '本番の X を消して',
      conversationId: 'conv-w',
      clientMessageId: 'cm-withdrawn',
    });
    await markWithdrawn(stores, 'conv-w', 'cm-withdrawn');
    const live = await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: 'やっぱり Y を確認して',
      conversationId: 'conv-w',
      clientMessageId: 'cm-live',
    });
    const read = tools(stores);
    const out = await read({ id: withdrawn.id });
    expect(out).toContain('本番の X を消して');
    expect(out.split('\n')[0]).toContain(MARK);
    expect(out).toContain('クローンへは届いていない。依頼として扱わないこと');
    const liveOut = await read({ id: live.id });
    expect(liveOut).toContain('やっぱり Y を確認して');
    expect(liveOut).not.toContain(MARK);
    expect(liveOut).not.toContain('依頼として扱わないこと');
    expect(liveOut).not.toContain('判定できなかった');
  });

  it('id 指定の頁送り（offset）でも注記が付く', async () => {
    const stores = createMemoryStores();
    const long = await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: 'あ'.repeat(20_000),
      conversationId: 'conv-w',
      clientMessageId: 'cm-long',
    });
    await markWithdrawn(stores, 'conv-w', 'cm-long');
    const read = tools(stores);
    const first = await read({ id: long.id });
    expect(first).toContain('conversation_read id=');
    expect(first.split('\n')[0]).toContain(MARK);
    const second = await read({ id: long.id, offset: 8_000 });
    expect(second.split('\n')[0]).toContain(MARK);
    expect(second).toContain('依頼として扱わないこと');
  });

  it('id 指定で印を引く口が投げる回: 判定できなかったと言い、取り下げていないとは断定しない', async () => {
    const stores = await seeded();
    const target = (
      await stores.journal.listPage({ types: ['exchange'], with: ['human'] })
    ).entries.find((entry) => entry.type === 'exchange' && entry.text === '本番の X を消して');
    if (target === undefined) throw new Error('対象の発言が無い');
    stores.journal.withdrawnClientMessageIds = async () => {
      throw new Error('印の読みが落ちた');
    };
    const out = await tools(stores)({ id: target.id });
    expect(out).toContain('本番の X を消して');
    expect(out).toContain('取り下げの有無を判定できなかった');
    expect(out).toContain('印の読みが落ちた');
    expect(out).toContain('取り下げていないとは言えない');
    expect(out).not.toContain(MARK);
  });

  it('予算で省いた行も数に入れるので「うち表示 k 件」を添える（conversationId・q）', async () => {
    const stores = createMemoryStores();
    await inbound(stores, 'conv-b', `古い取り下げ ${'あ'.repeat(300)}`, 'cm-old');
    await markWithdrawn(stores, 'conv-b', 'cm-old');
    for (let index = 0; index < 60; index += 1) {
      await inbound(stores, 'conv-b', `生きた ${index} ${'い'.repeat(300)}`, `cm-live-${index}`);
    }
    await inbound(stores, 'conv-b', `新しい取り下げ ${'う'.repeat(300)}`, 'cm-new');
    await markWithdrawn(stores, 'conv-b', 'cm-new');
    const read = tools(stores);
    const byConversation = await read({ conversationId: 'conv-b' });
    expect(byConversation).toContain('省略');
    expect(byConversation).toContain('取り下げた発言が 2 件');
    expect(byConversation).toContain('うち表示 1 件');
    const bySearch = await read({ q: '取り下げ' });
    expect(bySearch).toContain('取り下げた発言が 2 件');
    expect(bySearch).not.toContain('うち表示');
  });

  it('クローン側の発言だけを読む（speaker: clone）ときは、印を引かず注記も出さない', async () => {
    const stores = await seeded();
    stores.journal.withdrawnClientMessageIds = async () => {
      throw new Error('引かれてはいけない');
    };
    const read = tools(stores);
    const out = await read({ conversationId: 'conv-w', speaker: 'clone' });
    expect(out).toContain('Y を確認します');
    expect(out).not.toContain('判定できなかった');
    expect(out).not.toContain(MARK);
  });
});
