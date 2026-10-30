import { createHash } from 'node:crypto';

import { createRunnerHost, type RunnerEvent, type RunnerHost } from '@alteroid/core';
import { SSEStreamingApi, type SSEMessage } from 'hono/streaming';
import { describe, expect, it, vi } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

// #5692（段1）: まだ書いていない分を、`Outbox` の連番つきの1本の列にした。接続が持つのは「次に書く連番」だけで、
// 書き込みが成功したときだけ進む。差し戻しが無いので、書けなかった出来事は同じ連番のまま列に残る。

const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function bearer(extra?: Record<string, string>): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream', ...extra };
}

function newHost(): RunnerHost {
  return createRunnerHost({
    runnerId: 'runner-single-log-test',
    workspacePath: '/workspace',
    emit: () => undefined,
  });
}

function sessionEvent(id: string): RunnerEvent {
  return { type: 'session', managerId: `mgr-${id}`, sessionId: `sess-${id}` };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  budgetMs: number,
): Promise<string> {
  const decoder = new TextDecoder();
  let seen = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'期限切れ'>((resolve) => {
    timer = setTimeout(() => resolve('期限切れ'), budgetMs);
    timer.unref?.();
  });
  try {
    while (!seen.includes(needle)) {
      const next = await Promise.race([reader.read(), expired]);
      if (next === '期限切れ') break;
      if (next.done) break;
      seen += decoder.decode(next.value, { stream: true });
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return seen;
}

async function readUntilClosed(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  budgetMs: number,
): Promise<'closed' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), budgetMs);
    timer.unref?.();
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), expired]);
      if (next === 'timeout') return 'timeout';
      if (next.done) return 'closed';
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// 最初の1件の書き込みだけ返らない（読まなくなった接続）。2本目以降は本物へ通す。
function hangFirstEventWrite(): { restore: () => void } {
  const realWriteSSE = SSEStreamingApi.prototype.writeSSE;
  let hung = false;
  const spy = vi.spyOn(SSEStreamingApi.prototype, 'writeSSE').mockImplementation(async function (
    this: SSEStreamingApi,
    message: SSEMessage,
  ) {
    if (message.event !== 'hello' && !hung) {
      hung = true;
      return new Promise<void>(() => undefined);
    }
    return realWriteSSE.call(this, message);
  });
  return { restore: () => spy.mockRestore() };
}

describe('書き込みが締め切りを越えて畳まれたあとの繋ぎ直し（#630 (B)・#4154 の二重配送。#5692 で連番を振り直さなくなった）', () => {
  it('デーモンが実は受け取っていた（Last-Event-ID がその連番）なら、同じ出来事を送り直さない。申告が無ければ、同じ連番で送る', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const event = sessionEvent('timed-out');
    const seq = outbox.push(event);
    const hang = hangFirstEventWrite();
    try {
      const app = createRunnerApp({
        host,
        outbox,
        tokenSha256: TOKEN_SHA256,
        sseHeartbeatMs: 60_000,
        sseWriteDeadlineMs: 20,
      });
      const first = await app.request('/events', { headers: bearer() });
      if (first.body === null) throw new Error('SSE の応答に本文が無い');
      expect(await readUntilClosed(first.body.getReader(), 2000)).toBe('closed');
      // 書き終えていない: 溜まりに残っている
      expect(outbox.pending).toBe(1);

      // デーモンは実は受け取っていた
      const received = await app.request('/events', {
        headers: bearer({ 'Last-Event-ID': String(seq) }),
      });
      if (received.body === null) throw new Error('SSE の応答に本文が無い');
      const receivedReader = received.body.getReader();
      const seen = await readUntil(receivedReader, JSON.stringify(event), 300);
      expect(seen).not.toContain(JSON.stringify(event));
      expect(outbox.pending).toBe(0);
      await receivedReader.cancel();
      await expect.poll(() => outbox.subscribed, { timeout: 1000 }).toBe(false);

      // 届いていないなら（申告が無い）、同じ連番で書き直す
      const retry = await app.request('/events', { headers: bearer() });
      if (retry.body === null) throw new Error('SSE の応答に本文が無い');
      const retryReader = retry.body.getReader();
      const redelivered = await readUntil(retryReader, JSON.stringify(event), 1000);
      expect(redelivered).toContain(JSON.stringify(event));
      expect(redelivered).toContain(`id: ${String(seq)}`);
      await retryReader.cancel();
    } finally {
      hang.restore();
      await host.shutdown();
    }
  });
});

describe('繋ぎ直しの最中の溜まり（#358 の計器。購読中は、その接続がこれから書く分を数える）', () => {
  it('Last-Event-ID で読み返している最中の分も pending / oldestPendingAt に数え、書き終えたら減る', () => {
    let clock = 'T1';
    const outbox = new Outbox(() => clock);
    outbox.push(sessionEvent('1'));
    clock = 'T2';
    outbox.push(sessionEvent('2'));
    clock = 'T3';
    outbox.push(sessionEvent('3'));
    const detachAll = outbox.attach(() => undefined);
    expect(outbox.pending).toBe(0);
    detachAll();
    // 書き終えた後ろに溜まりは無い
    expect(outbox.pending).toBe(0);

    const subscription = outbox.subscribe({ lastEventId: 0, wake: () => undefined });
    expect(outbox.pending).toBe(3);
    expect(outbox.oldestPendingAt).toBe('T1');
    const first = subscription.peek();
    if (first === undefined) throw new Error('読み返す1件目が無い');
    expect(first.seq).toBe(1);
    subscription.wrote(first);
    expect(outbox.pending).toBe(2);
    expect(outbox.oldestPendingAt).toBe('T2');
    subscription.detach();
    // 外れたら、書き終えた連番の後ろ（まだ書いていない分）だけ
    expect(outbox.pending).toBe(0);
  });

  it('書けなかった（書き終えていない）分は、接続が外れたあとも溜まりに残り、queuedAt は積んだときのまま', () => {
    let clock = 'OLD';
    const outbox = new Outbox(() => clock);
    outbox.push(sessionEvent('1'));
    clock = 'NEW';
    const subscription = outbox.subscribe({ wake: () => undefined });
    expect(subscription.peek()?.seq).toBe(1);
    subscription.detach();
    expect(outbox.pending).toBe(1);
    expect(outbox.oldestPendingAt).toBe('OLD');
  });
});

describe('控えの上限は、まだ書いていない分と読み返し中の分を落とさない（#4669 の上限を、列の上で守る）', () => {
  it('件数の上限を超えても、購読が次に書く連番より後ろは落とさず、書き終えて前に出た分から古い方を落とす', () => {
    const outbox = new Outbox();
    const total = Outbox.SENT_HISTORY_LIMIT + 5;
    for (let i = 1; i <= total; i += 1) outbox.push(sessionEvent(String(i)));
    const subscription = outbox.subscribe({ lastEventId: 0, wake: () => undefined });
    // 読み返しの途中（1件目の手前に居る）で、後ろの分が書き終えた扱いになっても（別の経路が記録）、落とさない
    outbox.recordSent(sessionEvent(String(total)), total, '2026-01-01T00:00:00.000Z');
    expect(outbox.sentSince(0)).toHaveLength(total);

    for (let item = subscription.peek(); item !== undefined; item = subscription.peek()) {
      if (item.seq > 6) break;
      subscription.wrote(item);
    }
    // 1〜6 を書き終えて cursor が 7 へ進んだので、1〜5 は落とせる
    expect(outbox.sentSince(0).map((item) => item.seq)[0]).toBe(6);
    expect(outbox.sentSince(0)).toHaveLength(Outbox.SENT_HISTORY_LIMIT);
    subscription.detach();
  });

  it('まだ書いていない分は、件数がいくつ溜まっても落とさない（上限を置かない）', () => {
    const outbox = new Outbox();
    const total = Outbox.SENT_HISTORY_LIMIT * 3;
    for (let i = 1; i <= total; i += 1) outbox.push(sessionEvent(String(i)));
    expect(outbox.pending).toBe(total);
    const delivered: number[] = [];
    const detach = outbox.attach((_event, seq) => delivered.push(seq));
    expect(delivered).toHaveLength(total);
    expect(delivered[0]).toBe(1);
    expect(delivered.at(-1)).toBe(total);
    detach();
  });
});

describe('置き換え（#630 (C)）: 古い接続は何も持たず、書き終えていない分は新しい接続が同じ連番で書く', () => {
  it('古い接続の書き込みが後から成功で返っても、書き終えたことにしない', () => {
    const outbox = new Outbox();
    outbox.push(sessionEvent('1'));
    let superseded = 0;
    const older = outbox.subscribe({
      wake: () => undefined,
      onSuperseded: () => (superseded += 1),
    });
    const item = older.peek();
    if (item === undefined) throw new Error('書く1件が無い');

    const newer = outbox.subscribe({ wake: () => undefined });
    expect(superseded).toBe(1);
    expect(older.superseded).toBe(true);

    older.wrote(item);
    expect(outbox.sentSince(0)).toEqual([]);
    expect(newer.peek()?.seq).toBe(1);
    expect(outbox.pending).toBe(1);
    newer.detach();
  });

  it('新しい接続が来たら、古い接続は畳まれる（古い応答が終わる）。止まっていた1件は新しい接続が同じ連番で書く', async () => {
    const host = newHost();
    const outbox = new Outbox();
    const app = createRunnerApp({
      host,
      outbox,
      tokenSha256: TOKEN_SHA256,
      sseHeartbeatMs: 60_000,
    });
    try {
      const older = await app.request('/events', { headers: bearer() });
      if (older.body === null) throw new Error('SSE の応答に本文が無い');
      const olderReader = older.body.getReader();
      expect(await readUntil(olderReader, 'event: hello', 1000)).toContain('event: hello');

      const newer = await app.request('/events', { headers: bearer() });
      if (newer.body === null) throw new Error('SSE の応答に本文が無い');
      const newerReader = newer.body.getReader();

      expect(await readUntilClosed(olderReader, 2000)).toBe('closed');

      const event = sessionEvent('after-swap');
      const seq = outbox.push(event);
      const seen = await readUntil(newerReader, JSON.stringify(event), 1000);
      expect(seen).toContain(JSON.stringify(event));
      expect(seen).toContain(`id: ${String(seq)}`);
      await newerReader.cancel();
    } finally {
      await host.shutdown();
    }
  });
});
