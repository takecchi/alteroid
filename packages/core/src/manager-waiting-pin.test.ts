import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import {
  createRunnerRegistry,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores } from './testing.js';

const JOB_ID = 'mgr-waiting-pin';
const T0 = '2026-11-01T00:00:00.000Z';

type AskEvent = Extract<RunnerEvent, { type: 'ask' }>;

/**
 * 実時間では待たない: 出来事を 1 件ずつ流し、そのたびにマイクロタスクを流しきる（`#onEvent` の await の連鎖が終わるまで）。
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

async function open() {
  let clock = Date.parse(T0);
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [
    {
      liveBackgroundTasks: 0,
      managerId: JOB_ID,
      status: 'running',
      cwd: '/work/project',
      request: '調べて',
      waiting: [],
      sessionId: 'sess-1',
    },
  ];
  const runner = fakeRunnerClient({
    runnerId: 'runner-primary',
    async connect(onEvent) {
      emit = onEvent;
    },
    async stop(managerId) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
    },
    async list() {
      return [...alive];
    },
    async setProfile() {
      return { ok: true as const };
    },
  });
  const stores = createMemoryStores();
  await stores.jobs.putJob({
    id: JOB_ID,
    createdAt: T0,
    updatedAt: T0,
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: 'runner-primary',
  });
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    now: () => clock,
    post: (event) => inbox.push(event),
    runners: createRunnerRegistry([runner]),
  });
  await pool.restore();
  await settle();
  inbox.length = 0;
  const exchangeBefore = (await stores.journal.list({ types: ['exchange'] })).length;
  const escalationBefore = (await stores.journal.list({ types: ['escalation'] })).length;
  return {
    pool,
    inbox,
    setClock(iso: string) {
      clock = Date.parse(iso);
    },
    async ask(
      requestId: string,
      summary: string,
      kind: AskEvent['kind'] = 'permission',
      askedAt: string = T0,
    ): Promise<void> {
      emit?.({ type: 'ask', managerId: JOB_ID, requestId, kind, summary, askedAt });
      await settle();
    },
    async closed(status: 'done' | 'lost' | 'failed', reason: string): Promise<void> {
      emit?.({ type: 'closed', managerId: JOB_ID, status, reason });
      await settle();
    },
    async settled(requestId: string, withdrawn?: { reason: string }): Promise<void> {
      emit?.({
        type: 'settled',
        managerId: JOB_ID,
        requestId,
        ...(withdrawn === undefined ? {} : { withdrawn }),
      });
      await settle();
    },
    /** 一覧の像（status と待ちの列）と、台帳に書かれた status */
    async view(): Promise<{
      listed: { status: string; waiting: unknown } | undefined;
      stored: string | undefined;
    }> {
      const listed = (await pool.list()).find((item) => item.managerId === JOB_ID);
      const stored = (await stores.jobs.listJobs()).find((job) => job.id === JOB_ID)?.status;
      return {
        listed:
          listed === undefined ? undefined : { status: listed.status, waiting: listed.waiting },
        stored,
      };
    },
    /** 確認の処理が書いた escalation の行（古い順）。restore が書いた分は除く */
    async escalations(): Promise<unknown[]> {
      const entries = await stores.journal.list({ types: ['escalation'] });
      return entries
        .reverse()
        .slice(escalationBefore)
        .map((entry) => {
          // `id` は毎回変わり、`at` は台帳の実時間の時計なので落とす（`withdrawnAt` は注入した時計）
          return Object.fromEntries(
            Object.entries(entry).filter(([key]) => key !== 'id' && key !== 'at'),
          );
        });
    },
    /** 確認の処理が書いた exchange の本文と `with/role`（古い順） */
    async exchanges(): Promise<{ text: string; tag: string }[]> {
      const entries = await stores.journal.list({ types: ['exchange'] });
      return entries
        .filter(
          (entry): entry is Extract<typeof entry, { type: 'exchange' }> =>
            entry.type === 'exchange',
        )
        .reverse()
        .slice(exchangeBefore)
        .map((entry) => ({ text: entry.text, tag: `${entry.with}/${entry.role}` }));
    },
    /** 受信箱へ上がった知らせ（`id` は毎回変わるので落とす） */
    notices(): Record<string, unknown>[] {
      return inbox.map((event) => {
        return Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'id'));
      });
    },
  };
}

const item = (requestId: string, summary: string, kind: 'question' | 'permission', at: string) => ({
  requestId,
  summary,
  kind,
  askedAt: at,
});
const AT1 = '2026-11-01T00:00:01.000Z';
const AT2 = '2026-11-01T00:00:02.000Z';
const AT3 = '2026-11-01T00:00:03.000Z';
const AFTER_ANSWER =
  '\n答えたあと: allow すれば、この呼び出しがそのまま通る（撃ち直しは要らない）。deny なら担い手へ拒否として返る。';
const escalation = (question: string, approvalId: string) => ({
  type: 'escalation',
  question,
  approvalId,
  managerId: JOB_ID,
});
const WITHDRAWN_LEAD = 'この確認への答えは CLI へ届いていない（セッションを畳んだため）。理由: ';
const UNKNOWN_SUMMARY = '（不明 — 台帳の該当行が settled より先に消えていた）';

// 期待の文字列は仕様を先に書いたものではなく、切り出し前の作りの出力を写して目で読んで確かめたもの（コミットメッセージにも書く）。
describe('manager の ask / settled: 待ち・日誌・受信箱の全文（切り出し前の出力の固定）', () => {
  it('ask: 待ちへ requestId の鍵で積み、question はそのまま・permission は markup none と答えたあとを足して配る。分類器の拒否の確認には足さない', async () => {
    const s = await open();
    await s.ask('req-q', 'どちらにしますか', 'question', AT1);
    expect(s.notices()).toEqual([
      {
        type: 'manager_message',
        at: T0,
        managerId: JOB_ID,
        kind: 'question',
        text: 'どちらにしますか',
        requestId: 'req-q',
        statusAtDelivery: 'waiting_human',
      },
    ]);
    expect(await s.view()).toEqual({
      listed: {
        status: 'waiting_human',
        waiting: [item('req-q', 'どちらにしますか', 'question', AT1)],
      },
      stored: 'waiting_human',
    });

    await s.ask('req-p', 'Bash の実行許可: git push', 'permission', AT2);
    expect(s.notices().slice(1)).toEqual([
      {
        type: 'manager_message',
        at: T0,
        managerId: JOB_ID,
        kind: 'permission',
        text: `Bash の実行許可: git push${AFTER_ANSWER}`,
        requestId: 'req-p',
        markup: 'none',
        statusAtDelivery: 'waiting_human',
      },
    ]);

    await s.ask('req-c', '分類器が Bash を止めた: rm -rf', 'permission', AT3);
    expect(s.notices().slice(2)).toEqual([
      {
        type: 'manager_message',
        at: T0,
        managerId: JOB_ID,
        kind: 'permission',
        text: '分類器が Bash を止めた: rm -rf',
        requestId: 'req-c',
        markup: 'none',
        statusAtDelivery: 'waiting_human',
      },
    ]);
    const waiting = [
      item('req-q', 'どちらにしますか', 'question', AT1),
      item('req-p', 'Bash の実行許可: git push', 'permission', AT2),
      item('req-c', '分類器が Bash を止めた: rm -rf', 'permission', AT3),
    ];
    expect(await s.view()).toEqual({
      listed: { status: 'waiting_human', waiting },
      stored: 'waiting_human',
    });

    // 同じ requestId の再送は、要約・種類が違っても待ちにも受信箱にも日誌にも増えない
    await s.ask('req-p', '別の要約', 'question', '2026-11-01T00:00:04.000Z');
    expect(s.notices()).toHaveLength(3);
    expect(await s.view()).toEqual({
      listed: { status: 'waiting_human', waiting },
      stored: 'waiting_human',
    });
    expect(await s.escalations()).toEqual([
      escalation('どちらにしますか', 'req-q'),
      escalation('Bash の実行許可: git push', 'req-p'),
      escalation('分類器が Bash を止めた: rm -rf', 'req-c'),
    ]);
    // 確認要求は exchange を書かない（thinning は上限に当たったときだけ）
    expect(await s.exchanges()).toEqual([]);
    await s.pool.stop();
  });

  it('ask: 止めた委譲の確認は待ちにも status にも受信箱にも載せず、日誌（escalation）にだけ残す。settled(withdrawn) も日誌だけ', async () => {
    const s = await open();
    await s.pool.abort(JOB_ID, '止める');
    await settle();
    const noticesBefore = s.notices().length;
    const escalationsBefore = (await s.escalations()).length;
    const exchangesBefore = (await s.exchanges()).length;
    await s.ask('req-s', '止めたのに確認', 'question');
    expect(s.notices().slice(noticesBefore)).toEqual([]);
    expect((await s.escalations()).slice(escalationsBefore)).toEqual([
      escalation('止めたのに確認', 'req-s'),
    ]);
    // 止めた後に同じ requestId がもう一度来ても、早期 return は `requestId` の記憶を作らず、毎回日誌に残る
    await s.ask('req-s', '止めたのに確認', 'question');
    expect((await s.escalations()).slice(escalationsBefore)).toEqual([
      escalation('止めたのに確認', 'req-s'),
      escalation('止めたのに確認', 'req-s'),
    ]);
    await s.settled('req-s2', { reason: '止めたのに畳まれた' });
    expect((await s.escalations()).slice(escalationsBefore + 2)).toEqual([
      {
        ...escalation(UNKNOWN_SUMMARY, 'req-s2'),
        withdrawnAt: T0,
        withdrawnReason: `${WITHDRAWN_LEAD}止めたのに畳まれた`,
      },
    ]);
    expect(s.notices().slice(noticesBefore)).toEqual([]);
    expect((await s.exchanges()).slice(exchangesBefore)).toEqual([]);
    expect(await s.view()).toEqual({
      listed: { status: 'stopped', waiting: [] },
      stored: 'stopped',
    });
    await s.pool.stop();
  });

  it('ask: failed / lost の終端は waiting_human で書き戻さない（待ちには積み、受信箱へは出す）。done は waiting_human になり、settled で running へ戻る', async () => {
    const out: Record<string, unknown> = {};
    for (const status of ['failed', 'lost', 'done'] as const) {
      const s = await open();
      await s.closed(status, '終わった');
      await s.ask('req-x', '終端の後の確認', 'question');
      const asked = s.notices().filter((event) => event['requestId'] === 'req-x');
      const afterAsk = await s.view();
      await s.settled('req-x');
      out[status] = { asked, afterAsk, afterSettled: await s.view() };
      expect(await s.escalations()).toEqual([escalation('終端の後の確認', 'req-x')]);
      await s.pool.stop();
    }
    const waiting = [item('req-x', '終端の後の確認', 'question', T0)];
    const delivered = (statusAtDelivery: string) => [
      {
        type: 'manager_message',
        at: T0,
        managerId: JOB_ID,
        kind: 'question',
        text: '終端の後の確認',
        requestId: 'req-x',
        statusAtDelivery,
      },
    ];
    expect(out).toEqual({
      failed: {
        asked: delivered('failed'),
        afterAsk: { listed: { status: 'failed', waiting }, stored: 'failed' },
        afterSettled: { listed: { status: 'failed', waiting: [] }, stored: 'failed' },
      },
      lost: {
        asked: delivered('lost'),
        afterAsk: { listed: { status: 'lost', waiting }, stored: 'lost' },
        afterSettled: { listed: { status: 'lost', waiting: [] }, stored: 'lost' },
      },
      done: {
        asked: delivered('waiting_human'),
        afterAsk: { listed: { status: 'waiting_human', waiting }, stored: 'waiting_human' },
        afterSettled: { listed: { status: 'running', waiting: [] }, stored: 'running' },
      },
    });
  });

  it('settled: 取り下げ無しは待ちから外すだけ。取り下げ付きは要約を拾って日誌へ。待ちが空になって初めて running へ戻る。知らない id は外さず、要約は「不明」', async () => {
    const s = await open();
    await s.ask('a', 'A の要約', 'question', AT1);
    await s.ask('b', 'B の要約', 'permission', AT2);
    await s.ask('c', 'C の要約', 'question', AT3);
    const noticesBefore = s.notices().length;
    const escalationsBefore = (await s.escalations()).length;
    const only = (rest: ReturnType<typeof item>[]) => ({
      listed: { status: 'waiting_human', waiting: rest },
      stored: 'waiting_human',
    });
    const bItem = item('b', 'B の要約', 'permission', AT2);
    const cItem = item('c', 'C の要約', 'question', AT3);

    // 取り下げ無し: 外すだけで日誌には何も残さない
    await s.settled('a');
    expect(await s.view()).toEqual(only([bItem, cItem]));
    expect((await s.escalations()).length).toBe(escalationsBefore);

    // 取り下げ付き: 外す前に控えた要約と、注入した時計の時刻・理由が日誌に残る
    s.setClock('2026-11-01T00:05:00.000Z');
    await s.settled('b', { reason: '畳んだ' });
    expect(await s.view()).toEqual(only([cItem]));
    expect((await s.escalations()).slice(escalationsBefore)).toEqual([
      {
        ...escalation('B の要約', 'b'),
        withdrawnAt: '2026-11-01T00:05:00.000Z',
        withdrawnReason: `${WITHDRAWN_LEAD}畳んだ`,
      },
    ]);

    // 知らない id（取り下げ付き）: 待ちは動かず、要約は「不明」で日誌へ
    await s.settled('zzz', { reason: '知らない' });
    expect(await s.view()).toEqual(only([cItem]));
    expect((await s.escalations()).slice(escalationsBefore + 1)).toEqual([
      {
        ...escalation(UNKNOWN_SUMMARY, 'zzz'),
        withdrawnAt: '2026-11-01T00:05:00.000Z',
        withdrawnReason: `${WITHDRAWN_LEAD}知らない`,
      },
    ]);

    // 知らない id（取り下げ無し）: 何も起きない
    await s.settled('yyy');
    expect(await s.view()).toEqual(only([cItem]));
    expect((await s.escalations()).length).toBe(escalationsBefore + 2);

    // 最後の1件を外すと running へ戻り、もう一度同じ id が来ても動かない
    await s.settled('c');
    expect(await s.view()).toEqual({
      listed: { status: 'running', waiting: [] },
      stored: 'running',
    });
    await s.settled('c');
    expect(await s.view()).toEqual({
      listed: { status: 'running', waiting: [] },
      stored: 'running',
    });
    // settled は受信箱へも exchange へも何も出さない
    expect(s.notices().length).toBe(noticesBefore);
    expect(await s.exchanges()).toEqual([]);
    await s.pool.stop();
  });

  it('ask の「配り終えた id の記憶」は 512 件の蓋で古い側から忘れ、日誌（exchange manager/inbound）に跡を残す。忘れた id の再送だけが新しい確認として回る', async () => {
    const s = await open();
    for (let i = 0; i < 512; i += 1) {
      await s.ask(`id-${String(i)}`, `要約 ${String(i)}`, 'question');
    }
    expect(await s.exchanges()).toEqual([]);

    await s.ask('id-512', '要約 512', 'question');
    const thinning = (id: string) => ({
      text: `[間引き] [${JOB_ID}] 配り終えた確認の記憶が上限（512件）に達したので、古い 1 件を忘れた: ${id}。この id の確認が再送されると、新しい確認としてもう一度回る。`,
      tag: 'manager/inbound',
    });
    expect(await s.exchanges()).toEqual([thinning('id-0')]);

    // 忘れた id-0 の再送は新しい確認として回り（受信箱へ1件・待ちへもう1件）、記憶が1つ押し出されて id-1 を忘れる
    const noticesBefore = s.notices().length;
    await s.ask('id-0', '再送 0', 'question');
    expect(s.notices().length - noticesBefore).toBe(1);
    expect(await s.exchanges()).toEqual([thinning('id-0'), thinning('id-1')]);

    // 覚えている id-512 の再送は回らず、忘れた id-1 の再送は回る
    await s.ask('id-512', '再送 512', 'question');
    expect(s.notices().length - noticesBefore).toBe(1);
    await s.ask('id-1', '再送 1', 'question');
    expect(s.notices().length - noticesBefore).toBe(2);
    expect(await s.exchanges()).toEqual([thinning('id-0'), thinning('id-1'), thinning('id-2')]);
    expect(((await s.view()).listed?.waiting as unknown[]).length).toBe(515);
    await s.pool.stop();
  });
});
