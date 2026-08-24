import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ChatStreamEvent,
  CloneHost,
  InboxEvent,
  Job,
  ManagerDenial,
  ManagerPool,
  ManagerSummary,
  RunnerClient,
  ScheduleStatus,
  Scheduler,
  Stores,
} from '@alteroid/core';
import {
  captureStderr,
  createAuthProviderRegistry,
  createAuthService,
  createManagerPool,
  createMemoryStores,
  createProfileApplier,
  createProfileService,
  createProfileVessel,
  createRunnerRegistry,
  createTokenPoolService,
} from '@alteroid/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp, parseAllowedOrigins } from './app.js';
import type { AuthPlan } from './auth.js';
import { createJournalBus, type JournalBus } from './journal-bus.js';
import { scheduleStatusSchema } from './openapi.js';

/** クローンの代わり。HTTP 層だけを検証する。 */
function fakeClone() {
  const listeners = new Map<string, Set<(event: ChatStreamEvent) => void>>();
  const ended: string[] = [];
  const answered: { id: string; answer: string }[] = [];
  const posted: InboxEvent[] = [];
  let reply: ChatStreamEvent[] = [{ type: 'text', text: 'やあ' }, { type: 'done' }];

  const emit = (conversationId: string, event: ChatStreamEvent) => {
    for (const listener of listeners.get(conversationId) ?? []) listener(event);
  };

  const managerList: ManagerSummary[] = [];
  const managerDenials = new Map<string, ManagerDenial[]>();
  const transcripts = new Map<string, string>();
  const managerSends: { managerId: string; text: string; requestId?: string }[] = [];
  const managerAborts: { managerId: string; reason?: string }[] = [];
  // `DELETE /managers/:id` が outcome ごとに正しい HTTP ステータスを写すことを見る
  // ためのノブ。既定は従来どおり `'stopped'`（居れば必ず止まる）。
  let abortOutcome: 'stopped' | 'not_stopped' | 'unknown' = 'stopped';

  const managers: ManagerPool = {
    async start() {
      throw new Error('この偽クローンからはマネージャーを起こさない');
    },
    async send(managerId, text, options) {
      if (!managerList.some((entry) => entry.managerId === managerId)) {
        return { outcome: 'unknown' as const, detail: `${managerId} は居ない` };
      }
      managerSends.push({
        managerId,
        text,
        ...(options?.requestId === undefined ? {} : { requestId: options.requestId }),
      });
      return { outcome: 'delivered' as const, detail: '届けた' };
    },
    async abort(managerId, reason) {
      if (!managerList.some((entry) => entry.managerId === managerId)) {
        // **2026-08-21 に改名。** 「居ない」は `'unknown'`（確かめられなかった）と
        // 紛れる別の観測なので `'absent'` に改名した（`manager.ts` の
        // `ManagerAbortResult` の doc）。
        return { outcome: 'absent' as const, detail: `${managerId} は居ない` };
      }
      managerAborts.push({ managerId, ...(reason === undefined ? {} : { reason }) });
      const detail =
        abortOutcome === 'stopped'
          ? '止めた'
          : abortOutcome === 'not_stopped'
            ? 'まだ止まっていない'
            : '止まったかは未確認';
      return { outcome: abortOutcome, detail };
    },
    async list() {
      return managerList;
    },
    /**
     * **固定値を返さない。** ここが常に `[]` を返すスタブのままだと、拒否件数が
     * 外向きの面に載っているかを見るテストが、何も見ずに通ってしまう。
     */
    denials(managerId) {
      return managerDenials.get(managerId) ?? [];
    },
    // **HTTP の面には出ていない。** `GET /runners` は `deps.runners`
    // （`RunnerRegistry`）を直に読み、`ManagerPool.runners()` は経由しない
    // （クローンの道具専用）ので、ここでは型を満たすだけの空スタブで足りる。
    async runners() {
      return { runners: [], unassigned: [], daemonRevision: { status: 'unknown' } };
    },
    async transcript(managerId) {
      return transcripts.get(managerId) ?? null;
    },
    async restore() {
      return [];
    },
    // HTTP 境界の検証では触らない（引き取りの契機はデーモンの配線側にある）。
    async reattachRunner() {},
    async stop() {},
  };

  const clone: CloneHost = {
    managers,
    post(event) {
      posted.push(event);
      if (event.type !== 'human_message') return;
      setTimeout(() => {
        for (const item of reply) emit(event.conversationId, item);
      }, 0);
    },
    subscribe(conversationId, listener) {
      const set = listeners.get(conversationId) ?? new Set();
      set.add(listener);
      listeners.set(conversationId, set);
      return () => set.delete(listener);
    },
    async endConversation(conversationId) {
      ended.push(conversationId);
    },
    async answerApproval(id, answer) {
      answered.push({ id, answer });
    },
    async stop() {},
  };

  return {
    clone,
    ended,
    answered,
    posted,
    managerList,
    managerDenials,
    transcripts,
    managerSends,
    managerAborts,
    setAbortOutcome(outcome: 'stopped' | 'not_stopped' | 'unknown') {
      abortOutcome = outcome;
    },
    setReply(events: ChatStreamEvent[]) {
      reply = events;
    },
  };
}

/** スケジューラの代わり。HTTP 層から起こせることだけを見る。 */
function fakeScheduler() {
  const ran: string[] = [];
  let refreshed = 0;
  const scheduler: Scheduler = {
    async refresh() {
      refreshed += 1;
    },
    // 位相の保存は HTTP 層から観測しない（ここで見るのは「起こせるか」だけ）。
    async settled() {},
    start() {},
    stop() {},
    list() {
      return [
        {
          kind: 'daily_report',
          description: '毎日 22:00（ローカル時刻）にその日の日報をまとめる',
          nextAt: '2026-08-12T13:00:00.000Z',
        },
      ];
    },
    run(kind) {
      ran.push(kind);
      return kind === 'daily_report';
    },
    tick() {
      return [];
    },
  };
  return {
    scheduler,
    ran,
    refreshCount: () => refreshed,
  };
}

let stores: Stores;
let journalBus: JournalBus;
let fake: ReturnType<typeof fakeClone>;
let schedule: ReturnType<typeof fakeScheduler>;
let app: ReturnType<typeof createApp>;
let shutdowns: number;

beforeEach(() => {
  const base = createMemoryStores();
  journalBus = createJournalBus(base.journal);
  stores = { ...base, journal: journalBus.journal };
  fake = fakeClone();
  schedule = fakeScheduler();
  shutdowns = 0;
  app = createApp({
    clone: fake.clone,
    stores,
    token: 'test-token',
    shutdown: () => (shutdowns += 1),
    scheduler: schedule.scheduler,
    journalEvents: journalBus,
  });
});

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** 本文を持たない POST（CLI はこれに content-type を付けて叩く）。 */
const post = { method: 'POST', headers: { 'content-type': 'application/json' } };

/**
 * ブラウザの単純リクエスト。人間が開いた任意のページから 127.0.0.1 へ投げられる形。
 * 応答は読めないが、送信は成立する。
 */
const simpleRequest = (body = 'x') => ({
  method: 'POST',
  headers: { 'content-type': 'text/plain;charset=UTF-8' },
  body,
});

describe('HTTP API', () => {
  it('/health はトークンそのものを返さない（許可を付与できる資格になったため）', async () => {
    const response = await app.request('/health');
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, operator: false });
    // かつてはここに token を載せていた。いまはこれ1本で access grant まで通るので、
    // 無認証で読める応答に置いてはいけない。
    expect(body).not.toHaveProperty('token');
    expect(JSON.stringify(body)).not.toContain('test-token');
  });

  it('/health は実行環境の持ち主のトークンを提示すると operator を返す（CLI の本人確認）', async () => {
    const response = await app.request('/health', {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, operator: true });
  });

  it('/chat は SSE でクローンの応答を流す', async () => {
    const response = await app.request('/chat', json({ text: 'やあ' }));

    expect(response.status).toBe(200);
    const body = await response.text();

    expect(body).toContain('event: open');
    expect(body).toContain('event: text');
    expect(body).toContain('event: done');
    expect(body).toContain('やあ');
    expect(fake.posted[0]).toMatchObject({ type: 'human_message', text: 'やあ' });
  });

  it('/chat は会話 id を引き継げる', async () => {
    const response = await app.request('/chat', json({ text: 'やあ', conversationId: 'conv-x' }));
    await response.text();

    expect(fake.posted[0]).toMatchObject({ conversationId: 'conv-x' });
  });

  /**
   * **`open` が届いた時点で、発言はもう受信箱に在る。**
   *
   * Web UI の追送（受信中に続けて打った発言）は、2本目の購読を張らないために
   * `open` を見た時点で接続を捨てる（`apps/web/app/routes/chat.tsx` の `followUp`）。
   * その判断が成り立つのは、投函が `open` より前に済んでいるからである。
   *
   * **この試験は、いまの実装の2つの順序を見分けられない。** `await
   * stream.writeSSE(open)` の直後に同期で `clone.post` を呼ぶ形（元の順序）でも、
   * 読み手が `open` を受け取るころには post は済んでいるので通る（実測でも通った）。
   * ここが捕まえるのは、**投函と `open` のあいだに本物の待ちが入る変更**である
   * — 積むのを await の後ろへ動かした瞬間に落ちる。
   */
  it('/chat は `open` を書く前に受信箱へ積む（追送が open を投函の合図に使える）', async () => {
    const response = await app.request('/chat', json({ text: 'やあ' }));
    const body = response.body;
    if (body === null) throw new Error('SSE の応答に本文が無い');

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    while (!seen.includes('event: open')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    // 読み終える前に見る。**全部読んでから見ると順序の情報が消える。**
    expect(seen).toContain('event: open');
    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0]).toMatchObject({ type: 'human_message', text: 'やあ' });

    await reader.cancel();
  });

  it('/chat は空文字を拒む', async () => {
    expect((await app.request('/chat', json({ text: '' }))).status).toBe(400);
  });

  /**
   * **クローンが黙っているあいだも、SSE には何かが流れる。**
   *
   * ここで見たいのは「TCP が切れずデータも流れない切断」を掃除する契機が
   * サーバ側に在ることで、その契機が heartbeat の書き込みそのものである
   * （`@alteroid/core` の `sse-heartbeat.ts` の JSDoc）。**掃除が起きたことはここでは見ていない**
   * —— 掃除は Node の `outgoing` の `close` / `error` を経由する経路で、
   * `app.request()`（実際の socket を持たない）では再現できない。**見ているのは
   * 「無音のときに書き込みが発生するか」までである。**
   *
   * クローンの返答は `done` を出さない形にしてストリームを開いたままにする
   * （`done` / `error` でループが抜けるので、既定の返答だと heartbeat の前に
   * 終わってしまう）。
   */
  it('/chat はクローンが黙っていても heartbeat のコメント行を流す', async () => {
    fake.setReply([{ type: 'text', text: 'やあ' }]);
    const beating = createApp({
      clone: fake.clone,
      stores,
      token: 'test-token',
      shutdown: () => (shutdowns += 1),
      scheduler: schedule.scheduler,
      journalEvents: journalBus,
      sseHeartbeatMs: 5,
    });

    const response = await beating.request('/chat', json({ text: 'やあ' }));
    const body = response.body;
    if (body === null) throw new Error('SSE の応答に本文が無い');

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    while (!seen.includes(': hb')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }

    // heartbeat が来ている。そして既存のフレームを壊していない
    expect(seen).toContain(': hb');
    expect(seen).toContain('event: open');
    expect(seen).toContain('event: text');
    // **コメント行が他のフレームへ食い込んでいない。** 1回の `write()` で
    // 書き切っているので、`data:` の途中に `: hb` が挟まることはない
    expect(seen).not.toMatch(/data:[^\n]*: hb/);

    await reader.cancel();
  });

  /**
   * **上の試験に歯が在ることの裏取り（陰性対照）。**
   *
   * 間隔を十分長くすれば、同じ読み方をしても `: hb` は来ない。これが無いと、
   * 「`: hb` を含む」は他の何か（たとえばフレームの区切り方）を拾っただけでも
   * 通ってしまう。
   */
  it('間隔より短いあいだは heartbeat は流れない（上の試験が周期を見ている証拠）', async () => {
    fake.setReply([{ type: 'text', text: 'やあ' }]);
    const quiet = createApp({
      clone: fake.clone,
      stores,
      token: 'test-token',
      shutdown: () => (shutdowns += 1),
      scheduler: schedule.scheduler,
      journalEvents: journalBus,
      sseHeartbeatMs: 60_000,
    });

    const response = await quiet.request('/chat', json({ text: 'やあ' }));
    const body = response.body;
    if (body === null) throw new Error('SSE の応答に本文が無い');

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    // `text` まで読んだら、その後100msぶん待って何も来ないことを見る
    while (!seen.includes('event: text')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }

    const next = await Promise.race([
      reader.read().then(({ value }) => decoder.decode(value)),
      new Promise<'まだ何も来ていない'>((resolve) =>
        setTimeout(() => resolve('まだ何も来ていない'), 100),
      ),
    ]);
    expect(next).toBe('まだ何も来ていない');

    await reader.cancel();
  });

  it('会話終了で蒸留が促される', async () => {
    const response = await app.request('/chat/conv-x/end', post);

    expect(response.status).toBe(200);
    expect(fake.ended).toEqual(['conv-x']);
  });

  it('記憶を API から読んで書き換えられる（人間の制御手段1）', async () => {
    await stores.persona.write('values', '# 価値観\n\nもとの内容\n');

    const list = await app.request('/memory');
    expect(await list.json()).toMatchObject({ documents: [{ slug: 'values' }] });

    const put = await app.request('/memory/values', {
      ...json({ content: '# 価値観\n\n人間が API から書き換えた\n' }),
      method: 'PUT',
    });
    expect(put.status).toBe(200);

    const read = await app.request('/memory/values');
    const body = (await read.json()) as { document: { content: string } };
    expect(body.document.content).toContain('人間が API から書き換えた');

    // 人間による書き換えも日誌に残る
    const entries = await stores.journal.list({ types: ['memory_update'] });
    expect(entries[0]).toMatchObject({ cause: 'human', slug: 'values' });
  });

  it('人間の書き換え（PUT）にも action: "write" が構造として載る', async () => {
    await app.request('/memory/values', {
      ...json({ content: '本文' }),
      method: 'PUT',
    });

    const entries = await stores.journal.list({ types: ['memory_update'] });
    expect(entries[0]).toMatchObject({ action: 'write' });
  });

  /**
   * human guard（記憶の保護状態）は「誰も送らない導出値」である
   * （PR「人間が一度でも書いた記憶を、統合の走行が黙って壊せないようにする」）。
   *
   * **入口の入力スキーマを1つも変えていないこと**が要件——`PUT /memory/:slug`
   * の body は `{ content }` のままで、保護状態はサーバ側だけで決まる。
   * `content` 以外を足しても（`cause` や `humanTouchedAt` のような、保護状態を
   * 自称できてしまいそうなフィールドを混ぜても）黙って無視され、書き込みは
   * `content` だけで完結する——書き手を選べる口ではない。
   */
  it('PUT /memory/:slug の body は content だけのまま（human guard は入口を増やしていない）', async () => {
    const put = await app.request('/memory/values', {
      ...json({
        content: '# 価値観\n\n最小の body\n',
        // 保護状態に見えるフィールドを混ぜても、入力スキーマには無いので無視される。
        humanTouchedAt: '2020-01-01T00:00:00.000Z',
        cause: 'clone',
      }),
      method: 'PUT',
    });

    expect(put.status).toBe(200);
    const body = (await put.json()) as { document: { content: string } };
    expect(body.document.content).toContain('最小の body');
    expect(body.document).not.toHaveProperty('cause');
    expect(body.document).not.toHaveProperty('humanTouchedAt');

    // PUT は常に人間の書き込みとして扱われる（body の cause: 'clone' は効かない）。
    const entries = await stores.journal.list({ types: ['memory_update'] });
    expect(entries[0]).toMatchObject({ cause: 'human' });
    expect(await stores.persona.protectionStatus('values')).toEqual({ kind: 'human' });
  });

  it('存在しない記憶は 404', async () => {
    expect((await app.request('/memory/nope')).status).toBe(404);
  });

  it('日誌を読める（可観測性の中段）', async () => {
    await stores.journal.append({ type: 'decision', decision: '自分で決めた', grounds: '記憶' });

    const response = await app.request('/journal?limit=10');
    const body = (await response.json()) as { entries: { type: string }[] };

    expect(body.entries[0]).toMatchObject({ type: 'decision' });
  });

  it('利用状況を層と場所で絞れる（4つの口に同じ絞り込みがある）', async () => {
    // **API にだけ無い／API にだけある絞り込みを作らない**（PRD「インターフェース」）。
    const record = async (layer: 'clone' | 'manager', site: 'session' | 'distill', usd: number) => {
      await stores.usage.record({
        layer,
        site,
        accumulation: site === 'distill' ? 'oneshot' : 'cumulative',
        managerId: layer === 'clone' ? 'clone' : 'mgr-1',
        date: '2026-08-14',
        at: '2026-08-14T10:00:00.000Z',
        snapshot: {
          models: {
            'claude-opus-5': {
              inputTokens: 1,
              outputTokens: 1,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              webSearchRequests: 0,
              costUsd: usd,
            },
          },
        },
      });
    };
    await record('manager', 'session', 2);
    await record('clone', 'distill', 0.5);

    const all = (await (await app.request('/usage')).json()) as {
      rows: { layer: string; site: string }[];
      layersSince: string | null;
      beforeLayers: boolean;
    };
    expect(all.rows).toHaveLength(2);
    expect(all.layersSince).toBe('2026-08-14T10:00:00.000Z');

    const onlyClone = (await (await app.request('/usage?layer=clone')).json()) as {
      rows: { layer: string; site: string }[];
    };
    expect(onlyClone.rows.map((row) => row.layer)).toEqual(['clone']);

    const onlyDistill = (await (await app.request('/usage?site=distill')).json()) as {
      rows: { site: string }[];
    };
    expect(onlyDistill.rows.map((row) => row.site)).toEqual(['distill']);
  });

  it('読めない層・場所は 400（黙って全件を返さない）', async () => {
    // 絞ったつもりの照会が全件を返すと、その数字は「絞り込んだ結果」として読まれる。
    expect((await app.request('/usage?layer=worker')).status).toBe(400);
    expect((await app.request('/usage?site=compaction')).status).toBe(400);
  });

  it('不正なスラッグへの書き込みは 400（500 にしない）', async () => {
    const response = await app.request('/memory/..%2Fescape', {
      ...json({ content: 'x' }),
      method: 'PUT',
    });
    expect(response.status).toBe(400);
  });

  it('日誌は種別と時刻で掘れる（一本道で降りられること）', async () => {
    await stores.journal.append({ type: 'exchange', with: 'human', role: 'inbound', text: 'a' });
    await stores.journal.append({ type: 'decision', decision: 'd', grounds: 'g' });

    const filtered = await app.request('/journal?type=decision');
    const body = (await filtered.json()) as { entries: { type: string }[] };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.type).toBe('decision');

    const future = await app.request(
      `/journal?since=${encodeURIComponent('2999-01-01T00:00:00Z')}`,
    );
    expect((await future.json()) as { entries: unknown[] }).toMatchObject({ entries: [] });
  });

  it('GET /journal?type=worker_wait が通る（新しい種別も既存の絞り込み経路に乗る）', async () => {
    await stores.journal.append({ type: 'decision', decision: 'd', grounds: 'g' });
    await stores.journal.append({
      type: 'worker_wait',
      openedAt: '2026-08-20T21:30:00.000Z',
      tasks: 2,
      turns: 5,
      byCause: { input: 0, notification: 1, continuation: 4 },
      toolless: 4,
      notifications: 1,
      submits: 0,
      settled: true,
    });

    const filtered = await app.request('/journal?type=worker_wait');
    expect(filtered.status).toBe(200);
    const body = (await filtered.json()) as {
      entries: { type: string; tasks: number; turns: number }[];
    };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({ type: 'worker_wait', tasks: 2, turns: 5 });
  });

  it('GET /journal?type=turn_usage が通る（新しい種別も既存の絞り込み経路に乗る）', async () => {
    await stores.journal.append({ type: 'decision', decision: 'd', grounds: 'g' });
    await stores.journal.append({
      type: 'turn_usage',
      layer: 'manager',
      site: 'session',
      managerId: 'mgr-1',
      models: {
        opus: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 30,
          webSearchRequests: 0,
          costUsd: 1.5,
        },
      },
    });

    const filtered = await app.request('/journal?type=turn_usage');
    expect(filtered.status).toBe(200);
    const body = (await filtered.json()) as {
      entries: { type: string; layer: string; models: Record<string, unknown> }[];
    };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({ type: 'turn_usage', layer: 'manager' });
    expect(body.entries[0]?.models.opus).toMatchObject({
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 30,
    });
  });

  it('日誌は until で窓の終端を閉じられる（人間も過去の一区間を取れる）', async () => {
    await stores.journal.append({ type: 'decision', decision: 'いまの分', grounds: 'g' });

    // 返るのは新しい順なので、終端を閉じられないと過去の一点には届かない。
    const past = await app.request(`/journal?until=${encodeURIComponent('2020-01-01T00:00:00Z')}`);
    expect((await past.json()) as { entries: unknown[] }).toMatchObject({ entries: [] });

    const now = await app.request(`/journal?until=${encodeURIComponent('2999-01-01T00:00:00Z')}`);
    const body = (await now.json()) as { entries: { decision?: string }[] };
    expect(body.entries.map((entry) => entry.decision)).toContain('いまの分');
  });

  it('承認待ちを読んで答えられる', async () => {
    await stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: new Date().toISOString(),
      question: 'これを送ってよいか',
    });

    const list = await app.request('/approvals');
    expect(await list.json()).toMatchObject({ approvals: [{ id: 'ap-1' }] });

    const answer = await app.request('/approvals/ap-1/answer', json({ answer: 'よい' }));
    expect(answer.status).toBe(200);
    expect(fake.answered).toEqual([{ id: 'ap-1', answer: 'よい' }]);
  });

  it('存在しない承認待ちへの回答は 404', async () => {
    expect((await app.request('/approvals/nope/answer', json({ answer: 'x' }))).status).toBe(404);
  });

  /**
   * `updatedAt` は新しい情報ではなく、応答に既に載っている `createdAt` /
   * `answeredAt` から `packages/core/src/schema.ts` の `approvalUpdatedAt` が
   * 導くだけの派生欄（#269 / このスキーマの `.extend()` を土台にした宣言は
   * `openapi.ts` を見ること）。**片方の枝だけ測ると導出を潰す変異が生き残る**
   * ので、回答待ち（右枝＝`createdAt`）と回答済み（左枝＝`answeredAt`）の
   * 両方を測る。
   */
  it('一覧の updatedAt は approvalUpdatedAt と一致する（回答待ちは作成時刻、回答済みは回答時刻）', async () => {
    await stores.jobs.putApproval({
      id: 'ap-updated-at',
      createdAt: '2026-01-01T00:00:00.000Z',
      question: '更新時刻の確認',
    });

    const pendingList = (await (await app.request('/approvals')).json()) as {
      approvals: { id: string; createdAt: string; updatedAt: string }[];
    };
    const pendingEntry = pendingList.approvals.find((a) => a.id === 'ap-updated-at');
    // 未回答は「作成時刻」と一致する（`answeredAt` が無いので右枝）
    expect(pendingEntry?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(pendingEntry?.updatedAt).toBe(pendingEntry?.createdAt);

    // 回答を付ける（HTTP の /answer 経路はこのテストの偽クローンでは店に書き戻さない
    // ので、器へ直接書く — 上の「片付けたものは…」と同じやり方）
    await stores.jobs.putApproval({
      id: 'ap-updated-at',
      createdAt: '2026-01-01T00:00:00.000Z',
      question: '更新時刻の確認',
      answeredAt: '2026-03-03T00:00:00.000Z',
      answer: 'よい',
    });

    // 既定（未回答のみ）では回答済みは一覧から消える
    const stillDefault = (await (await app.request('/approvals')).json()) as {
      approvals: { id: string }[];
    };
    expect(stillDefault.approvals.find((a) => a.id === 'ap-updated-at')).toBeUndefined();

    // **`pending=false` が、呼び出し元から `approvalUpdatedAt` の左枝
    // （`answeredAt` 有り）へ実際に到達する初めての経路である**
    // （`schema.ts` の `approvalUpdatedAt` の doc の2026-08-23 訂正を見ること）。
    const allList = (await (await app.request('/approvals?pending=false')).json()) as {
      approvals: { id: string; answeredAt?: string; updatedAt: string }[];
    };
    const answeredEntry = allList.approvals.find((a) => a.id === 'ap-updated-at');
    expect(answeredEntry?.updatedAt).toBe('2026-03-03T00:00:00.000Z');
    expect(answeredEntry?.updatedAt).toBe(answeredEntry?.answeredAt);
  });

  it('セッションログまで降りられる（可観測性の最下段）', async () => {
    const id = await stores.archive.archive('sess-1', '{"a":1}\n');

    const list = await app.request('/archive');
    expect(await list.json()).toMatchObject({ entries: [id] });

    const read = await app.request(`/archive/${id}`);
    expect(await read.text()).toBe('{"a":1}\n');
  });

  it('manager_id から一覧・状態・生ログへ降りられる（可観測性の下2層）', async () => {
    fake.managerList.push({
      managerId: 'mgr-1234',
      status: 'running',
      live: true,
      cwd: '/work/project',
      request: 'ログイン周りを直して',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
      waiting: [
        {
          requestId: 'req-1',
          summary: 'Bash の実行許可',
          kind: 'permission',
          askedAt: '2026-01-01T00:00:30.000Z',
        },
      ],
    });
    fake.transcripts.set('mgr-1234', '{"type":"user"}\n');

    const list = await app.request('/managers');
    expect(await list.json()).toMatchObject({ managers: [{ managerId: 'mgr-1234' }] });

    const detail = await app.request('/managers/mgr-1234');
    expect(await detail.json()).toMatchObject({ manager: { cwd: '/work/project' } });

    const transcript = await app.request('/managers/mgr-1234/transcript');
    expect(await transcript.text()).toBe('{"type":"user"}\n');

    expect((await app.request('/managers/nope')).status).toBe(404);
    expect((await app.request('/managers/nope/transcript')).status).toBe(404);
  });

  /**
   * **`kind`/`askedAt` を持たない `waiting` を抱えたマネージャーが1件でも
   * いると、それだけで `GET /managers` そのものが例外で落ちる穴が在った。**
   *
   * `/managers` と `/managers/:id` は、応答を返す前に `managerSummarySchema`
   * （`managerWaitingSchema` を含む）を `.parse()` に通す（`.safeParse()` では
   * ない。上の「宣言していないものは外へ出ない」の doc）。旧 runner は
   * `drainingSeconds` の猶予中、`kind`/`askedAt` を持たない `waiting` を返す
   * 窓がある（`packages/core/src/runner-protocol.ts` の `runnerWaitingSchema`
   * の doc、#334）。`managerWaitingSchema` の `kind`/`askedAt` が必須のまま
   * だと、その窓に入ったマネージャーが1件でもいるだけで `.parse()` が投げ、
   * **一覧そのものが1本も読めなくなる**——`RunnerHttpClient#list()` が
   * `safeParse` で要素ごと黙って捨てる形（歯は
   * `apps/daemon/src/runner-client.test.ts`）より広く壊れる。
   *
   * ここで見るのは状態コードだけではない——`waiting` の要素が本文に残って
   * いること（200 を返しても中身が消えていたら意味が無い）。
   */
  it('kind / askedAt を持たない waiting を抱えたマネージャーでも /managers と /managers/:id は 200 を返す', async () => {
    fake.managerList.push({
      managerId: 'mgr-legacy',
      status: 'waiting_human',
      live: true,
      cwd: '/work/legacy',
      request: '版のずれの窓に入った引き継ぎ',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
      waiting: [{ requestId: 'req-1', summary: 'Bash の実行許可' }],
    });

    const list = await app.request('/managers');
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      managers: { managerId: string; waiting: { requestId: string; summary: string }[] }[];
    };
    const listed = listBody.managers.find((m) => m.managerId === 'mgr-legacy');
    expect(listed?.waiting).toHaveLength(1);
    expect(listed?.waiting[0]?.requestId).toBe('req-1');
    expect(listed?.waiting[0]?.summary).toBe('Bash の実行許可');

    const detail = await app.request('/managers/mgr-legacy');
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      manager: { waiting: { requestId: string; summary: string }[] };
    };
    expect(detailBody.manager.waiting).toHaveLength(1);
    expect(detailBody.manager.waiting[0]?.requestId).toBe('req-1');
    expect(detailBody.manager.waiting[0]?.summary).toBe('Bash の実行許可');
  });

  /**
   * **宣言していないものは外へ出ない。**
   *
   * `describeRoute` の `resolver()` は `openapi.json` を作るだけで、ハンドラが
   * 何を返したかは検査しない。なので「スキーマを書いた」だけでは、`ManagerSummary`
   * にフィールドが1つ増えた日に spec に無いものが黙って外へ出る。
   *
   * ここで見るのは**宣言に無いフィールドを混ぜても応答に現れないこと**である。
   * 応答が spec を通ってから出ていることは、これでしか確かめられない
   * （宣言どおりのものが出るのを見るだけなら、parse を外しても通ってしまう）。
   */
  it('マネージャーの応答は、宣言していないフィールドを外へ出さない', async () => {
    // core の interface にフィールドが増えた日を再現する。`ManagerSummary` の
    // 定義を触らずに済むよう、ここでだけ型を外して混ぜる。
    fake.managerList.push({
      managerId: 'mgr-leak',
      status: 'running',
      live: true,
      cwd: '/work/project',
      request: '内部の像が混ざる日',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
      waiting: [],
      internalNote: 'openapi.json に書いていない内部の像',
    } as ManagerSummary);

    const list = (await (await app.request('/managers')).json()) as {
      managers: Record<string, unknown>[];
    };
    // 宣言したものは出る（parse が中身を空にしていないこと）。
    expect(list.managers[0]).toMatchObject({ managerId: 'mgr-leak', cwd: '/work/project' });
    expect(list.managers[0]).not.toHaveProperty('internalNote');

    const detail = (await (await app.request('/managers/mgr-leak')).json()) as {
      manager: Record<string, unknown>;
    };
    expect(detail.manager).toMatchObject({ managerId: 'mgr-leak' });
    expect(detail.manager).not.toHaveProperty('internalNote');
  });

  /**
   * **人間の画面にだけ見えないものを作らない。**
   *
   * PR #60 でクローンは `manager_list` から拒否件数を読めるようになったが、
   * `GET /managers` は「実行中」としか言わないままだった。人間の画面が読むのは
   * こちらなので、同じ仕事を見て人間とクローンで見えているものが食い違う。
   *
   * **状態は置き換えない。** 拒否は `running` に映らない（拒否があったことしか
   * 観測していない）ので、`status` はそのままにして添える。
   */
  it('拒否件数が、状態を置き換えずに一覧と詳細へ載る', async () => {
    fake.managerList.push({
      managerId: 'mgr-denied',
      status: 'running',
      live: true,
      cwd: '/work/project',
      request: '止められている仕事',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
      waiting: [],
    });
    fake.managerDenials.set('mgr-denied', [
      { tool: 'Bash', count: 4 },
      { tool: 'Write', count: 1 },
    ]);

    const list = (await (await app.request('/managers')).json()) as {
      managers: { status: string; denials?: { tool: string; count: number }[] }[];
    };
    // 状態の値は動かさない。
    expect(list.managers[0]?.status).toBe('running');
    expect(list.managers[0]?.denials).toEqual([
      { tool: 'Bash', count: 4 },
      { tool: 'Write', count: 1 },
    ]);

    const detail = (await (await app.request('/managers/mgr-denied')).json()) as {
      manager: { status: string; denials?: unknown };
    };
    expect(detail.manager.status).toBe('running');
    expect(detail.manager.denials).toEqual([
      { tool: 'Bash', count: 4 },
      { tool: 'Write', count: 1 },
    ]);
  });

  /**
   * **「数えていない」を「0 件だった」に見せない。**
   *
   * 拒否の帳面はデーモンのプロセス内にしかなく、器を作り直せば数え直しになる。
   * 常に `denials: []` を載せると、作り直した直後がいちばん「止められていない」
   * ように見える。`manager_list` が拒否ゼロの行に何も足さないのと揃える。
   */
  it('拒否が無いマネージャーには denials を載せない（0 件を主張しない）', async () => {
    fake.managerList.push({
      managerId: 'mgr-quiet',
      status: 'running',
      live: true,
      cwd: '/work/project',
      request: '止められていない仕事',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
      waiting: [],
    });

    const list = (await (await app.request('/managers')).json()) as {
      managers: Record<string, unknown>[];
    };
    expect(list.managers[0]).not.toHaveProperty('denials');
  });

  /**
   * **人間の面が読む値は、この経路を通った分だけである。**
   *
   * `lastFailure`（`schema.ts`）は「直近の1ターンが報告ではなく失敗で終わった」
   * ことで、これが無いと人間の画面には「報告が来た」としか出ない — 直す前は
   * `You've hit your org's monthly spend limit …` が最後の報告としてそのまま
   * 出ていた（`packages/core/src/sdk-failure.ts` の doc）。
   *
   * **宣言していないものは外へ出ない**のがこの面の規約なので（真上の
   * 「宣言していないフィールドを外へ出さない」）、`managerSummarySchema` から
   * `lastFailure` が落ちると、`ManagerSummary` に値があっても**黙って消える**。
   * それは CLI・Web の両方が同時に盲目になる形で、画面のテストでは捕まらない。
   *
   * **状態は置き換えない。** 支出上限に当たった回もセッションは生きているので
   * `status` は `done`（終えて待機中）のままである。
   */
  it('直近のターンの失敗が、状態を置き換えずに一覧と詳細へ載る', async () => {
    fake.managerList.push({
      managerId: 'mgr-billing',
      status: 'done',
      live: true,
      cwd: '/work/project',
      request: '調べて',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
      waiting: [],
      lastReport: '（このターンは応答を返さずに終わった: billing_error / assistant_error）',
      lastFailure: {
        code: 'billing_error',
        via: 'assistant_error',
        at: '2026-01-01T00:01:00.000Z',
      },
    });

    const list = (await (await app.request('/managers')).json()) as {
      managers: { status: string; lastFailure?: unknown }[];
    };
    // 状態の値は動かさない（`failed` へ倒すと「もう続けられない」と読まれる）。
    expect(list.managers[0]?.status).toBe('done');
    expect(list.managers[0]?.lastFailure).toEqual({
      code: 'billing_error',
      via: 'assistant_error',
      at: '2026-01-01T00:01:00.000Z',
    });

    const detail = (await (await app.request('/managers/mgr-billing')).json()) as {
      manager: { status: string; lastFailure?: unknown };
    };
    expect(detail.manager.status).toBe('done');
    expect(detail.manager.lastFailure).toEqual({
      code: 'billing_error',
      via: 'assistant_error',
      at: '2026-01-01T00:01:00.000Z',
    });
  });

  /** 失敗していない回に空の値を載せない（「失敗していない」と「見ていない」を混ぜない）。 */
  it('失敗していないマネージャーには lastFailure を載せない', async () => {
    fake.managerList.push({
      managerId: 'mgr-fine',
      status: 'done',
      live: true,
      cwd: '/work/project',
      request: '調べて',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
      waiting: [],
      lastReport: '調べ終わった',
    });

    const list = (await (await app.request('/managers')).json()) as {
      managers: Record<string, unknown>[];
    };
    expect(list.managers[0]).toMatchObject({ lastReport: '調べ終わった' });
    expect(list.managers[0]).not.toHaveProperty('lastFailure');
  });

  it('日報を読める（可観測性の最上段。普段の接点はほぼこれだけ）', async () => {
    await stores.journal.append({ type: 'daily_report', date: '2026-08-11', body: '昨日の日報' });
    await stores.journal.append({ type: 'daily_report', date: '2026-08-12', body: '今日の日報' });

    const list = await app.request('/reports?limit=7');
    const body = (await list.json()) as { reports: { date: string }[] };
    // 新しい順
    expect(body.reports.map((report) => report.date)).toEqual(['2026-08-12', '2026-08-11']);

    const one = await app.request('/reports/2026-08-11');
    expect(await one.json()).toMatchObject({ reports: [{ body: '昨日の日報' }] });

    expect((await app.request('/reports/2026-08-10')).status).toBe(404);
    expect((await app.request('/reports/2026%2F08%2F10')).status).toBe(400);
  });

  /**
   * ⭐ 上の1本は「追記した順の逆」でも通る（08-11 → 08-12 の順に積んでいるので、
   * 書いた順と日付順が一致している）。**実際に人間が見た壊れ方はここにある** —
   * 起動時の遡り生成では前の日ぶんの日報が今日書かれるので、**最後に書かれた行が
   * いちばん古い日付**になる。その状態で書いた順に返すと、一覧の先頭が古い日付に
   * なる（「WebUI の日報の並び順が変」という申告そのもの）。
   *
   * 並びの規則そのものの検査は `reports.test.ts` にある。ここで見るのは
   * **HTTP の口がその規則を通っていること**（`/reports` が日誌の並びを素通しして
   * いないこと）だけである。
   */
  it('遡り生成で後から書かれた古い日付の日報を、一覧の先頭に出さない', async () => {
    // 追記の順＝書いた順。日付の順とは逆にする（後追いが最後に走った状態）。
    await stores.journal.append({ type: 'daily_report', date: '2026-08-21', body: '08-21' });
    await stores.journal.append({ type: 'daily_report', date: '2026-08-19', body: '08-19' });

    const list = await app.request('/reports?limit=7');
    const body = (await list.json()) as { reports: { date: string }[] };
    expect(body.reports.map((report) => report.date)).toEqual(['2026-08-21', '2026-08-19']);

    // `limit=1` は「最新の日報」を出す口（ダッシュボードの1枚と CLI の `/report`）。
    // 最後に書かれた行ではなく、日付がいちばん新しい日報でなければならない。
    const latest = await app.request('/reports?limit=1');
    const latestBody = (await latest.json()) as { reports: { date: string }[] };
    expect(latestBody.reports.map((report) => report.date)).toEqual(['2026-08-21']);
  });

  it('外部イベントを受けてクローンの受信箱へ積む（起点③）', async () => {
    const response = await app.request('/events', json({ source: 'ci', payload: { ok: false } }));

    expect(response.status).toBe(200);
    expect(fake.posted[0]).toMatchObject({
      type: 'external',
      source: 'ci',
      payload: { ok: false },
    });
  });

  it('送り元の形を変えられない webhook も、本文ごと受けられる', async () => {
    const response = await app.request('/events/github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'review_requested' }),
    });

    expect(response.status).toBe(200);
    expect(fake.posted[0]).toMatchObject({
      type: 'external',
      source: 'github',
      payload: { action: 'review_requested' },
    });
  });

  it('JSON として読めない本文はそのまま渡す', async () => {
    await app.request('/events/mail', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'ただの文章',
    });
    expect(fake.posted[0]).toMatchObject({ source: 'mail', payload: 'ただの文章' });
  });

  /**
   * 127.0.0.1 で待つことはブラウザからの保護にならない。人間が開いた任意のページが
   * 単純リクエストを投げられ、応答が読めなくても**送信は成立する**。クローンのターンを
   * 他人が起こせる状態を残さない（塞ぐのは能力側ではなく実行環境の境界）。
   */
  it('ブラウザの単純リクエストでは、状態を変える POST を叩けない', async () => {
    const cases = [
      // 他人が判断材料を書き込める
      { path: '/events/github', body: '{"action":"注入"}' },
      // 他人が自律ターン（モデル利用・委譲の判断）を起こせる
      { path: '/schedule/self_initiative/run' },
      // 他人が蒸留ターンを起こせる
      { path: '/chat/conv-x/end' },
      // 他人がデーモンを止められる
      { path: '/shutdown' },
    ];

    for (const { path, body } of cases) {
      const response = await app.request(path, simpleRequest(body));
      expect(response.status, path).toBe(415);
    }

    // どれも通っていない
    expect(fake.posted).toEqual([]);
    expect(fake.ended).toEqual([]);
    expect(schedule.ran).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(shutdowns).toBe(0);
  });

  it('form / no-cors で投げられる content-type も受けない', async () => {
    for (const contentType of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      '',
    ]) {
      const response = await app.request('/schedule/daily_report/run', {
        method: 'POST',
        ...(contentType === '' ? {} : { headers: { 'content-type': contentType } }),
      });
      expect(response.status, contentType).toBe(415);
    }
    expect(schedule.ran).toEqual([]);
  });

  /**
   * ブラウザが単純リクエストか否かを決めるのは MIME essence（`;` より前）だけである。
   * パラメータに `application/json` と書いても safelist のまま preflight 無しで飛ぶので、
   * 部分一致で判定すると門番があるつもりで通ってしまう。
   */
  it('パラメータに application/json と書いた safelist な content-type を受けない', async () => {
    const disguises = [
      'text/plain; note=application/json',
      'text/plain;application/json',
      'application/x-www-form-urlencoded; note=application/json',
      'multipart/form-data; boundary=application/json',
    ];

    for (const contentType of disguises) {
      for (const path of [
        '/schedule/self_initiative/run',
        '/shutdown',
        '/chat/conv-x/end',
        '/events/github',
      ]) {
        const response = await app.request(path, {
          method: 'POST',
          headers: { 'content-type': contentType },
          body: '{"action":"注入"}',
        });
        expect(response.status, `${path} [${contentType}]`).toBe(415);
      }
    }

    expect(fake.posted).toEqual([]);
    expect(fake.ended).toEqual([]);
    expect(schedule.ran).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(shutdowns).toBe(0);
  });

  it('charset 付き・大文字の application/json は通す（本物の webhook を弾かない）', async () => {
    for (const contentType of [
      'application/json; charset=utf-8',
      'APPLICATION/JSON',
      ' application/json ',
    ]) {
      const response = await app.request('/schedule/daily_report/run', {
        method: 'POST',
        headers: { 'content-type': contentType },
      });
      expect(response.status, contentType).toBe(200);
    }
    expect(schedule.ran).toEqual(['daily_report', 'daily_report', 'daily_report']);
  });

  /**
   * 本文検査つきの経路（`validator('json', ...)`）も、同じ単純リクエストで叩ける
   * 位置にある。こちらは `deliberateClient` を通っていないので落ち方が違う —
   * hono の json validator は content-type が application/json でなければ本文を
   * **読まない**ので、空の入力がスキーマ検査に落ちて 400 になる（415 ではない）。
   *
   * 落ち方が違っても守っているものは同じで、**ハンドラまで届かない**ことである。
   * #22 で検査の実装を `@hono/zod-validator` から hono-openapi の `validator` へ
   * 差し替えたので、その一線をここで固定しておく（次の差し替えで薄まったら
   * 気づけるように）。
   */
  it('本文検査つきの経路も、ブラウザの単純リクエストでは叩けない', async () => {
    const cases = [
      // 他人が判断材料を書き込める
      { path: '/events', body: '{"source":"github","payload":{"action":"注入"}}' },
      // 他人がクローンの代わりに承認へ答えられる
      { path: '/approvals/answer', body: '{"answers":[{"id":"ap-1","answer":"よい"}]}' },
      { path: '/approvals/ap-1/answer', body: '{"answer":"よい"}' },
    ];

    for (const { path, body } of cases) {
      const response = await app.request(path, simpleRequest(body));
      expect(response.status, path).toBe(400);

      // safelist に見せかけた content-type でも同じ（MIME essence で判定される）
      for (const contentType of [
        'text/plain;application/json',
        'application/x-www-form-urlencoded',
        'multipart/form-data; boundary=application/json',
      ]) {
        const disguised = await app.request(path, {
          method: 'POST',
          headers: { 'content-type': contentType },
          body,
        });
        expect(disguised.status, `${path} [${contentType}]`).toBe(400);
      }
    }

    // どれもハンドラまで届いていない
    expect(fake.posted).toEqual([]);
    expect(fake.answered).toEqual([]);
  });

  it('中身のない通知も受ける（source だけ）', async () => {
    const response = await app.request('/events', json({ source: 'cron' }));
    expect(response.status).toBe(200);
    expect(fake.posted[0]).toMatchObject({ type: 'external', source: 'cron' });
  });

  it('定期ジョブの一覧と、手で起こす口がある', async () => {
    const list = await app.request('/schedule');
    expect(await list.json()).toMatchObject({ entries: [{ kind: 'daily_report' }] });

    const run = await app.request('/schedule/daily_report/run', post);
    expect(run.status).toBe(200);
    expect(schedule.ran).toEqual(['daily_report']);

    expect((await app.request('/schedule/nope/run', post)).status).toBe(404);
  });

  it('人間も継続中の依頼を仕込める。仕込んだら次の刻みを待たずに効く', async () => {
    const before = schedule.refreshCount();
    const response = await app.request(
      '/schedule',
      json({
        kind: 'issue-round',
        request: 'open issue を見て実装を進める',
        spec: { type: 'daily', at: '09:00' },
      }),
    );

    expect(response.status).toBe(200);
    expect(await stores.schedules.list()).toMatchObject([
      { kind: 'issue-round', spec: { type: 'daily', at: '09:00' } },
    ]);
    expect(schedule.refreshCount()).toBe(before + 1);
    // 人間が仕込んだことも日誌に残る（後から辿れること）
    expect(await stores.journal.list({ types: ['decision'] })).toHaveLength(1);
  });

  it('読めない時刻は API でも弾く（道具と同じ真実を持つ）', async () => {
    // 通ると一覧に「毎日 25:99」と出るのに実際は 00:00 に起きる、という
    // 人間が読んで矛盾する状態が作れてしまう
    for (const at of ['25:99', '99:00', '9:5', 'あさ']) {
      const response = await app.request(
        '/schedule',
        json({ kind: 'issue-round', request: 'x', spec: { type: 'daily', at } }),
      );
      expect(response.status, at).toBe(400);
    }
    expect(await stores.schedules.list()).toEqual([]);
  });

  it('cron 式でも仕込めるが、読めない式は弾く', async () => {
    const ok = await app.request(
      '/schedule',
      json({
        kind: 'weekly-review',
        request: '週次レビュー',
        spec: { type: 'cron', expression: '0 10 * * 1' },
      }),
    );
    expect(ok.status).toBe(200);
    expect(await stores.schedules.list()).toMatchObject([
      { spec: { type: 'cron', expression: '0 10 * * 1' } },
    ]);

    const broken = await app.request(
      '/schedule',
      json({
        kind: 'weekly-review',
        request: '週次レビュー',
        spec: { type: 'cron', expression: 'まいしゅう げつようび' },
      }),
    );
    expect(broken.status).toBe(400);
  });

  it('既定の定期ジョブの名前は API からも奪えない', async () => {
    const response = await app.request(
      '/schedule',
      json({ kind: 'daily_report', request: '日報を潰す', spec: { type: 'every', minutes: 1 } }),
    );

    expect(response.status).toBe(409);
    expect(await stores.schedules.list()).toEqual([]);
  });

  it('継続中の依頼を外せる。無いものは 404', async () => {
    await stores.schedules.put({
      kind: 'issue-round',
      spec: { type: 'daily', at: '09:00' },
      request: 'open issue を見て実装を進める',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    });

    const removed = await app.request('/schedule/issue-round', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
    });
    expect(removed.status).toBe(200);
    expect(await stores.schedules.list()).toEqual([]);

    const missing = await app.request('/schedule/nope', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
    });
    expect(missing.status).toBe(404);
  });

  /**
   * 台帳（引き受けたまま終わっていない仕事）。クローンは `commitment_*` を持っている
   * ので、人間の側から読めない・積めない・閉じられないと、頼んだことがどう扱われて
   * いるかを人間が確かめられない（PRD「可観測性」/「インターフェース」の等価性）。
   */
  it('人間が台帳へ積んだものが一覧に出る（origin は human で、id が返る）', async () => {
    const opened = await app.request(
      '/commitments',
      json({ body: 'issue #42 のレビュー指摘を直す', source: 'gh-42' }),
    );

    expect(opened.status).toBe(200);
    const { ok, id } = (await opened.json()) as { ok: boolean; id: string };
    expect(ok).toBe(true);
    expect(id).not.toBe('');

    const list = await app.request('/commitments');
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      entries: [{ id, origin: 'human', source: 'gh-42', body: 'issue #42 のレビュー指摘を直す' }],
    });

    // 器にも同じものが入っている（応答だけが正しい、という形になっていない）
    expect((await stores.commitments.list()).entries).toMatchObject([{ id, origin: 'human' }]);
    // chat の外から積んだものは、日誌に残さなければどこにも跡が無い
    expect(await stores.journal.list({ types: ['decision'] })).toHaveLength(1);
  });

  it('積んだ側が自分で選べるのは本文と出所だけ（origin を human 以外にできない）', async () => {
    // ここを人間に選ばせると、人間が積んだものが `self` を名乗れてしまい、
    // 「人間との約束か、自分で思い立ったことか」をクローンが区別できなくなる。
    const response = await app.request(
      '/commitments',
      json({ body: '出所を偽る', origin: 'self', id: 'なりすまし' }),
    );

    expect(response.status).toBe(200);
    expect((await stores.commitments.list()).entries).toMatchObject([{ origin: 'human' }]);
    expect((await stores.commitments.list()).entries[0]?.id).not.toBe('なりすまし');
  });

  it('片付けたものは既定の一覧から消え、includeClosed=true でだけ出る', async () => {
    const opened = await app.request('/commitments', json({ body: '日報の体裁を直す' }));
    const { id } = (await opened.json()) as { id: string };

    const closed = await app.request(
      `/commitments/${id}/close`,
      json({ reason: '直して PR を出した' }),
    );
    expect(closed.status).toBe(200);

    expect(await (await app.request('/commitments')).json()).toEqual({
      entries: [],
      unreadable: [],
    });
    // **`false` が `false` として効く**（`z.coerce.boolean()` だと真になる）
    expect(await (await app.request('/commitments?includeClosed=false')).json()).toEqual({
      entries: [],
      unreadable: [],
    });

    const all = await app.request('/commitments?includeClosed=true');
    expect(await all.json()).toMatchObject({
      entries: [{ id, body: '日報の体裁を直す', closedReason: '直して PR を出した' }],
    });
    // **`POST /commitments/:id/close` は `closedBy: 'human'` を書く**（issue #286）。
    // `commitment_close` ツール（クローン）と同じ欄を、どちらから来たか記録して分ける。
    expect((await stores.commitments.get(id))?.closedBy).toBe('human');
    // 行そのものは消えていない（何を片付けたかが日報の材料に残る）
    expect(await stores.commitments.get(id)).not.toBeNull();
    // 閉じたことも日誌に残る（積んだ1件と合わせて2本）
    expect(await stores.journal.list({ types: ['decision'] })).toHaveLength(2);
  });

  /**
   * `updatedAt` は新しい情報ではなく、応答に既に載っている `at` / `closedAt`
   * から `packages/core/src/schema.ts` の `commitmentUpdatedAt` が導くだけの
   * 派生欄（#269 / `.extend()` を土台にした宣言は `openapi.ts` を見ること）。
   * **片方の枝だけ測ると導出を潰す変異が生き残る**ので、未了（右枝＝`at`）と
   * 片付いた（左枝＝`closedAt`）の両方を測る。
   */
  it('一覧の updatedAt は commitmentUpdatedAt と一致する（未了は受け取った時刻、片付いたら片付けた時刻）', async () => {
    await stores.commitments.open({
      id: 'cm-updated-at',
      at: '2026-01-01T00:00:00.000Z',
      origin: 'human',
      body: '更新時刻の確認',
    });

    const openList = (await (await app.request('/commitments')).json()) as {
      entries: { id: string; at: string; updatedAt: string }[];
    };
    const openEntry = openList.entries.find((e) => e.id === 'cm-updated-at');
    // 未了は「受け取った時刻」と一致する（`closedAt` が無いので右枝）
    expect(openEntry?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(openEntry?.updatedAt).toBe(openEntry?.at);

    await stores.commitments.close(
      'cm-updated-at',
      '2026-02-02T00:00:00.000Z',
      '確認終了',
      'human',
    );

    const closedList = (await (await app.request('/commitments?includeClosed=true')).json()) as {
      entries: { id: string; at: string; closedAt: string; updatedAt: string }[];
    };
    const closedEntry = closedList.entries.find((e) => e.id === 'cm-updated-at');
    // 片付いたら「片付けた時刻」と一致する（受け取った時刻ではない — 左枝）
    expect(closedEntry?.updatedAt).toBe('2026-02-02T00:00:00.000Z');
    expect(closedEntry?.updatedAt).toBe(closedEntry?.closedAt);
    expect(closedEntry?.updatedAt).not.toBe(closedEntry?.at);
  });

  it('読めない includeClosed は弾く（黙って既定へ倒さない）', async () => {
    expect((await app.request('/commitments?includeClosed=yes')).status).toBe(400);
    expect((await app.request('/commitments?includeClosed=1')).status).toBe(400);
  });

  it('無い id を閉じると 404、二度目は 409（いつ・どう片付けたかを本文に入れる）', async () => {
    expect((await app.request('/commitments/nope/close', json({ reason: 'x' }))).status).toBe(404);

    const opened = await app.request('/commitments', json({ body: '二度閉じの確認' }));
    const { id } = (await opened.json()) as { id: string };

    expect(
      (await app.request(`/commitments/${id}/close`, json({ reason: '最初の始末' }))).status,
    ).toBe(200);

    const again = await app.request(`/commitments/${id}/close`, json({ reason: '後から来た始末' }));
    expect(again.status).toBe(409);
    // **最初の理由が残っている。** 上書きされると、人間が読む「何をもって終わりと
    // したか」が後から来たほうへ静かに入れ替わる
    expect(((await again.json()) as { error: string }).error).toContain('最初の始末');
    expect(await stores.commitments.get(id)).toMatchObject({ closedReason: '最初の始末' });

    // 理由の無い close は受け付けない（否定する材料が残らない閉じ方）
    const openedAgain = await app.request('/commitments', json({ body: '理由なしの確認' }));
    const other = (await openedAgain.json()) as { id: string };
    expect((await app.request(`/commitments/${other.id}/close`, json({ reason: '' }))).status).toBe(
      400,
    );
    expect((await stores.commitments.get(other.id))?.closedAt).toBeUndefined();
  });

  /**
   * 台帳の口も、人間が開いた任意のページから投げられる位置にある。積まれれば
   * クローンの次のターンに他人の宿題が載り、閉じられれば人間が頼んだことが
   * 黙って消える。`validator('json', ...)` を通っているのでハンドラまで届かない。
   */
  it('ブラウザの単純リクエストでは台帳を積めない・閉じられない', async () => {
    await stores.commitments.open({
      id: 'cm-1',
      at: '2026-08-12T00:00:00.000Z',
      origin: 'human',
      body: '人間が頼んだこと',
    });

    for (const { path, body } of [
      { path: '/commitments', body: '{"body":"注入された宿題"}' },
      { path: '/commitments/cm-1/close', body: '{"reason":"注入"}' },
    ]) {
      expect((await app.request(path, simpleRequest(body))).status, path).toBe(400);

      // safelist に見せかけた content-type でも同じ（MIME essence で判定される）
      for (const contentType of [
        'text/plain;application/json',
        'application/x-www-form-urlencoded',
        'multipart/form-data; boundary=application/json',
      ]) {
        const disguised = await app.request(path, {
          method: 'POST',
          headers: { 'content-type': contentType },
          body,
        });
        expect(disguised.status, `${path} [${contentType}]`).toBe(400);
      }
    }

    // 積まれても閉じられてもいない
    expect(await stores.commitments.list({ includeClosed: true })).toEqual({
      entries: [
        { id: 'cm-1', at: '2026-08-12T00:00:00.000Z', origin: 'human', body: '人間が頼んだこと' },
      ],
      unreadable: [],
    });
  });

  it('溜まった承認待ちをまとめて片付けられる（1件失敗しても残りは進む）', async () => {
    for (const id of ['ap-1', 'ap-2']) {
      await stores.jobs.putApproval({
        id,
        createdAt: new Date().toISOString(),
        question: `${id} を進めてよいか`,
      });
    }

    const response = await app.request(
      '/approvals/answer',
      json({
        answers: [
          { id: 'ap-1', answer: 'よい' },
          { id: 'ap-nope', answer: 'よい' },
          { id: 'ap-2', answer: 'だめ' },
        ],
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      results: [
        { id: 'ap-1', ok: true },
        { id: 'ap-nope', ok: false },
        { id: 'ap-2', ok: true },
      ],
    });
    expect(fake.answered).toEqual([
      { id: 'ap-1', answer: 'よい' },
      { id: 'ap-2', answer: 'だめ' },
    ]);
  });

  it('回答済みの承認待ちには二度答えられない（再開した仕事に同じ回答を流さない）', async () => {
    await stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: '2026-08-12T00:00:00.000Z',
      question: '進めてよいか',
      answeredAt: '2026-08-12T01:00:00.000Z',
      answer: 'よい',
    });

    const single = await app.request('/approvals/ap-1/answer', json({ answer: 'やっぱり駄目' }));
    expect(single.status).toBe(409);

    const batch = await app.request(
      '/approvals/answer',
      json({ answers: [{ id: 'ap-1', answer: 'やっぱり駄目' }] }),
    );
    expect(await batch.json()).toMatchObject({
      results: [{ id: 'ap-1', ok: false, error: 'already answered' }],
    });

    expect(fake.answered).toEqual([]);
  });

  it('存在しない日付の日報は 400（黙って別の日にずらさない）', async () => {
    expect((await app.request('/reports/2026-02-31')).status).toBe(400);
    expect((await app.request('/reports/0000-00-00')).status).toBe(400);
  });

  it('/shutdown で停止を要求できる', async () => {
    const response = await app.request('/shutdown', post);
    expect(response.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(shutdowns).toBe(1);
  });
});

/**
 * OpenAPI の配信（Issue #20）。
 *
 * spec が経路の実装とずれたら「外から API を叩けます」という主張そのものが
 * 嘘になる。ここでは「全経路が載っている」「SSE が SSE として書いてある」
 * 「人間向け画面が出る」の3点だけを見る（内容の細部は `apps/daemon/openapi.json`
 * 自体が machine-generated で、`pnpm build` のたびに作り直される）。
 */
describe('OpenAPI', () => {
  it('/openapi.json が OpenAPI 3.1 の spec を返す（SSE 経路も含めて全部載る）', async () => {
    const response = await app.request('/openapi.json');
    expect(response.status).toBe(200);

    const spec = (await response.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(spec.openapi).toBe('3.1.0');

    // 手で削らない限りここに載る経路数（約30本）を大きく下回っていないか、
    // 個別の経路名で確かめる。`/openapi.json` `/docs` 自身は載らない。
    const paths = Object.keys(spec.paths);
    for (const path of [
      '/health',
      '/chat',
      '/chat/{conversationId}/end',
      '/conversations',
      '/conversations/{id}',
      '/journal/stream',
      '/memory',
      '/memory/{slug}',
      '/journal',
      '/reports',
      '/reports/{date}',
      '/approvals',
      '/approvals/answer',
      '/approvals/{id}/answer',
      '/events',
      '/events/{source}',
      '/schedule',
      '/schedule/{kind}/run',
      '/commitments',
      '/commitments/{id}/close',
      '/managers',
      '/managers/{id}',
      '/managers/{id}/transcript',
      '/managers/{id}/messages',
      '/runners',
      '/runners/credentials',
      '/archive',
      '/archive/{id}',
      '/shutdown',
    ]) {
      expect(paths, path).toContain(path);
    }
    expect(paths).not.toContain('/openapi.json');
    expect(paths).not.toContain('/docs');
  });

  it('SSE 経路は text/event-stream を content に持つ（能力を単純化して削っていないこと）', async () => {
    const spec = (await (await app.request('/openapi.json')).json()) as {
      paths: Record<string, { post?: Operation; get?: Operation }>;
    };
    interface Operation {
      responses?: Record<string, { content?: Record<string, unknown> }>;
    }

    const chatContent = spec.paths['/chat']?.post?.responses?.['200']?.content;
    expect(Object.keys(chatContent ?? {})).toContain('text/event-stream');

    const journalStreamContent = spec.paths['/journal/stream']?.get?.responses?.['200']?.content;
    expect(Object.keys(journalStreamContent ?? {})).toContain('text/event-stream');
  });

  it('/docs は人間向けの画面（HTML）を返す', async () => {
    const response = await app.request('/docs');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<!doctype html>');
  });
});

/**
 * 器を替えても続きから話せること、聞きに行かなくても気づけること、人間が
 * 自分の言葉を自分で届けられること。
 *
 * どれも「読む口はあるのに触る口が無い」ために、画面や別の器から使おうとした
 * 瞬間に能力の差として現れていた穴である（north_star 禁止1）。
 */
describe('会話・出来事・マネージャーへの手出し', () => {
  async function exchange(conversationId: string, role: 'inbound' | 'outbound', text: string) {
    await stores.journal.append({ type: 'exchange', with: 'human', role, text, conversationId });
  }

  it('会話の一覧が新しい順に返る（器を替えても続きが見つかる）', async () => {
    await exchange('conv-a', 'inbound', '最初の会話');
    await exchange('conv-a', 'outbound', 'はい');
    await exchange('conv-b', 'inbound', 'あとの会話');

    const body = (await (await app.request('/conversations')).json()) as {
      conversations: { conversationId: string; messages: number; preview: string }[];
    };

    expect(body.conversations.map((entry) => entry.conversationId)).toEqual(['conv-b', 'conv-a']);
    expect(body.conversations[1]?.messages).toBe(2);
    // 抜粋はその会話のいちばん新しい発言
    expect(body.conversations[1]?.preview).toBe('はい');
  });

  it('会話の中身は古い順（読み上げる順序と同じ）', async () => {
    await exchange('conv-a', 'inbound', 'ひとつめ');
    await exchange('conv-a', 'outbound', 'ふたつめ');

    const body = (await (await app.request('/conversations/conv-a')).json()) as {
      messages: { role: string; text: string }[];
    };

    expect(body.messages).toMatchObject([
      { role: 'inbound', text: 'ひとつめ' },
      { role: 'outbound', text: 'ふたつめ' },
    ]);
    // **項目が増えていないことも見る。** `toMatchObject` は余分な鍵を無視し、
    // 応答スキーマは実行時に本体を削らない（`resolver()` は文書化だけ）ので、
    // 共有した組み立て（`conversation.ts` は `conversationId` も持つ）から
    // 1項目余って出ても、上のアサーションは通ってしまう。
    expect(Object.keys(body.messages[0]!).sort()).toEqual(['at', 'id', 'role', 'text']);
  });

  /**
   * **「無い」と「遡り切れていない」を同じ応答にしない。**
   *
   * この口は日誌の新しい方から `scan` 件しか見ない。一律 404 にしていたので、
   * 窓より古い会話が「そんな会話は無い」として返っていた（消えた会話と、まだ
   * 見ていない会話が呼ぶ側から区別できない）。判定できないという3つ目の状態を
   * 持たないと、判定できない場合が黙ってどちらかへ倒れる。
   */
  it('遡り切れていれば「無い」と言ってよい（scanned と reachedStart を添える）', async () => {
    await exchange('conv-a', 'inbound', 'ひとつめ');

    const response = await app.request('/conversations/conv-a');
    const body = (await response.json()) as { scanned: number; reachedStart: boolean };

    expect(response.status).toBe(200);
    // 日誌の exchange は1件だけ＝既定の scan（2000）に届かない＝先頭まで見た
    expect(body).toMatchObject({ scanned: 1, reachedStart: true });
    expect((await app.request('/conversations/does-not-exist')).status).toBe(404);
  });

  it('遡り切れていなければ 404 を返さず、判定できないことを返す', async () => {
    // 古い会話を先に積み、そのあと新しい会話で窓を埋める
    await exchange('conv-old', 'inbound', '古い発言');
    await exchange('conv-new', 'inbound', '新しい発言1');
    await exchange('conv-new', 'inbound', '新しい発言2');

    // 窓は新しい2件（conv-new）だけ。conv-old はその外にある
    const response = await app.request('/conversations/conv-old?scan=2');
    const body = (await response.json()) as {
      messages: unknown[];
      scanned: number;
      reachedStart: boolean;
    };

    // **404 ではない。** 無いのではなく、この窓では言えないだけである
    expect(response.status).toBe(200);
    expect(body.messages).toEqual([]);
    expect(body.reachedStart).toBe(false);
    expect(body.scanned).toBe(2);

    // 窓を広げれば見える（＝「無い」が誤りだったことの裏返し）
    const wider = await app.request('/conversations/conv-old?scan=10');
    const widerBody = (await wider.json()) as {
      messages: { text: string }[];
      reachedStart: boolean;
    };
    expect(wider.status).toBe(200);
    expect(widerBody.messages.map((m) => m.text)).toEqual(['古い発言']);
    expect(widerBody.reachedStart).toBe(true);
  });

  it('内部ターン（self）は会話に混ざらない', async () => {
    await stores.journal.append({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text: '蒸留の独り言',
      conversationId: 'conv-a',
    });

    expect((await app.request('/conversations/conv-a')).status).toBe(404);
  });

  it('日誌の追記がそのまま流れる（聞きに行かなくても気づける）', async () => {
    const response = await app.request('/journal/stream?type=escalation');
    expect(response.status).toBe(200);

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    // 最初のフレームは open
    await reader.read();

    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '流れてはいけない',
    });
    await stores.journal.append({
      type: 'escalation',
      question: '消してよいか',
      approvalId: 'ap-9',
      managerId: 'mgr-1',
    });

    const { value } = await reader.read();
    const frame = decoder.decode(value);

    // 絞り込んだ種別だけが届く。絞り込みを決めるのは呼ぶ側である
    expect(frame).toContain('escalation');
    expect(frame).toContain('消してよいか');
    expect(frame).not.toContain('流れてはいけない');
    await reader.cancel();
  });

  /**
   * **日誌に何も載らないあいだも heartbeat が流れる。**
   *
   * `/journal/stream` は `/chat` と違って**そもそも長時間無音が普通**である
   * （承認待ちが出るまで何も起きない）。だから無音死がいちばん出るのはこの経路で、
   * `apps/web` がこの口で自前の再接続を持っているのもそれが理由だった
   * （`apps/web/app/hooks/use-journal-live.ts` の冒頭コメント）。
   */
  it('日誌が無音でも heartbeat のコメント行が流れる（承認待ちを待つ長時間接続）', async () => {
    const beating = createApp({
      clone: fake.clone,
      stores,
      token: 'test-token',
      shutdown: () => (shutdowns += 1),
      scheduler: schedule.scheduler,
      journalEvents: journalBus,
      sseHeartbeatMs: 5,
    });

    const response = await beating.request('/journal/stream');
    expect(response.status).toBe(200);

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let seen = '';
    // **日誌へは1件も追記しない。** それでも読めるものが来ることを見る
    while (!seen.includes(': hb')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }

    expect(seen).toContain(': hb');
    // 最初のフレームは open のまま（heartbeat が先に割り込んでいない）
    expect(seen.indexOf('event: open')).toBeLessThan(seen.indexOf(': hb'));

    await reader.cancel();
  });

  it('配線されていなければ、黙って空を返さず 503 で知らせる', async () => {
    const bare = createApp({
      clone: fake.clone,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
    });
    expect((await bare.request('/journal/stream')).status).toBe(503);
  });

  it('人間からマネージャーへ直接届く', async () => {
    fake.managerList.push({
      managerId: 'mgr-1',
      status: 'running',
      live: true,
      cwd: '/work',
      request: '実装して',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      waiting: [],
    });

    const response = await app.request('/managers/mgr-1/messages', {
      ...post,
      body: JSON.stringify({ text: 'トークンは合っている。続けて', requestId: 'req-1' }),
    });

    expect(response.status).toBe(200);
    expect(fake.managerSends).toEqual([
      { managerId: 'mgr-1', text: 'トークンは合っている。続けて', requestId: 'req-1' },
    ]);
  });

  it('居ないマネージャーへ送っても、届いたことにしない', async () => {
    const response = await app.request('/managers/mgr-none/messages', {
      ...post,
      body: JSON.stringify({ text: 'やあ' }),
    });
    expect(response.status).toBe(404);
    expect(fake.managerSends).toEqual([]);
  });

  it('走っている仕事を1つだけ止められる（器ごと落とさない）', async () => {
    fake.managerList.push({
      managerId: 'mgr-1',
      status: 'running',
      live: true,
      cwd: '/work',
      request: '暴走中',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      waiting: [],
    });

    const response = await app.request('/managers/mgr-1', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: '方針が変わった' }),
    });

    expect(response.status).toBe(200);
    expect(fake.managerAborts).toEqual([{ managerId: 'mgr-1', reason: '方針が変わった' }]);
  });

  /**
   * **`not_stopped` / `unknown` は 200 のまま、`outcome` で言い分ける。**
   *
   * どちらも「そのマネージャーは居る」ことは確かなので、リクエスト自体は正しく
   * 処理できている——404 にすると「居ない」と紛れる。404 は `absent` だけである。
   */
  it('止まっていない・確かめられなかったときも 200 で outcome を返す（404 にしない）', async () => {
    fake.managerList.push({
      managerId: 'mgr-1',
      status: 'running',
      live: true,
      cwd: '/work',
      request: '暴走中',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      waiting: [],
    });

    fake.setAbortOutcome('not_stopped');
    const notStopped = await app.request('/managers/mgr-1', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(notStopped.status).toBe(200);
    expect(await notStopped.json()).toMatchObject({ outcome: 'not_stopped' });

    fake.setAbortOutcome('unknown');
    const unknown = await app.request('/managers/mgr-1', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({ outcome: 'unknown' });
  });

  it('居ないマネージャーを止めようとすると 404（absent）', async () => {
    const response = await app.request('/managers/mgr-none', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(404);
  });

  it('記憶は消せるし、消したことは日誌に残る', async () => {
    await stores.persona.write('habits', '朝は不機嫌');

    const response = await app.request('/memory/habits', { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect(await stores.persona.read('habits')).toBeNull();
    const journal = await stores.journal.list({ types: ['memory_update'] });
    expect(journal[0]).toMatchObject({ slug: 'habits', cause: 'human' });
  });

  it('人間の口（DELETE /memory/:slug）にも action: "remove" が構造として載る', async () => {
    await stores.persona.write('habits', '朝は不機嫌');

    await app.request('/memory/habits', { method: 'DELETE' });

    const journal = await stores.journal.list({ types: ['memory_update'] });
    expect(journal[0]).toMatchObject({ action: 'remove' });
  });

  it('無い記憶を消しても、消えたことにしない', async () => {
    expect((await app.request('/memory/missing', { method: 'DELETE' })).status).toBe(404);
    // 形が不正なものは 400（無いのか、そもそも名前として成立しないのかを分ける）
    expect((await app.request('/memory/居ない', { method: 'DELETE' })).status).toBe(400);
  });
});

/**
 * 実行環境プロファイル（`.zprofile` 相当）。
 *
 * 固定しているのは「器を作り直さずに環境を差し替えられること」と、
 * 「壊れたものを保存も配布もしないこと」の2つである。前者が無いと、道具の鍵を
 * 1つ足すたびに `compose.yaml` を直して器を焼き直すことになり（＝走行中の仕事が
 * 死ぬ）、後者が無いと、構文を間違えた1回で以後すべてのコマンドが壊れた環境で
 * 走り続ける。
 */
describe('実行環境プロファイル', () => {
  it('置いていなければ空を返す', async () => {
    const response = await app.request('/profile');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ script: '' });
  });

  it('置いたものを読み直せる（人間が自分で直せる）', async () => {
    const withProfile = createApp({
      clone: fake.clone,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      profile: profileService(stores),
    });

    const put = await withProfile.request('/profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ script: 'export SOME_API_TOKEN=abc123' }),
    });
    expect(put.status).toBe(200);

    const read = (await (await withProfile.request('/profile')).json()) as { script: string };
    // 入口で末尾の改行だけ整える（保存・配布・指紋が同じ文字列を見るため）。
    expect(read.script).toBe('export SOME_API_TOKEN=abc123\n');
  });

  it('PUT が返す指紋と GET が返す指紋が一致する', async () => {
    // **ここが食い違うと、届いているかを見る道具そのものが嘘をつく。**
    // 置き場が末尾の改行を足すだけで「置いた指紋」と「読んだ指紋」がずれ、
    // `alteroid profile status` が永久に「届いていない」と言い続ける
    // （鍵の指紋でも同じ失敗をしている）。
    const withProfile = createApp({
      clone: fake.clone,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      profile: profileService(stores),
    });

    // 末尾に改行が無い本文（人間が普通に書く形）
    const put = (await (
      await withProfile.request('/profile', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ script: 'export OK=1' }),
      })
    ).json()) as { sha256: string };
    const get = (await (await withProfile.request('/profile')).json()) as { sha256: string };

    expect(get.sha256).toBe(put.sha256);
  });

  it('runner へ降ろし、結果を返す', async () => {
    const runner = fakeRunner('runner-primary');
    const withProfile = createApp({
      clone: fake.clone,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      runners: registryOf([runner]),
      profile: profileService(stores, { runners: [runner] }),
    });

    const response = await withProfile.request('/profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ script: 'export OK=1' }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { runners: { runnerId: string; ok: boolean }[] };
    expect(body.runners).toEqual([{ runnerId: 'runner-primary', ok: true }]);
    expect(runner.received).toEqual(['export OK=1\n']);
  });

  it('読めないものは保存も配布もしない（前のものが残る）', async () => {
    const runner = fakeRunner('runner-primary');
    const withProfile = createApp({
      clone: fake.clone,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      runners: registryOf([runner]),
      profile: profileService(stores, { rejects: '壊れている', runners: [runner] }),
    });
    await stores.profile.write('export GOOD=1');

    const response = await withProfile.request('/profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ script: 'if [ ; then' }),
    });

    expect(response.status).toBe(400);
    // 保存されていない ＝ 器を作り直しても、前の効くプロファイルが戻る
    expect((await stores.profile.read())?.script).toBe('export GOOD=1');
    // 降ろしてもいない
    expect(runner.received).toEqual([]);
  });
});

/**
 * `PUT /profile` の応答が宣言（`profileUpdateResponseSchema`）どおりであること。
 *
 * `result.clone`（`ApplyProfileResult['clone']`、core の `ProfileApplyResult`。
 * `packages/core/src/profile.ts`）は、置いたものが実際に読めたときに
 * `profile: ProfileFingerprint` を持つ（`createProfileApplier().prepare()` が
 * 評価に成功すると必ず付ける）。しかし宣言（`profileUpdateResponseSchema.clone`、
 * `apps/daemon/src/openapi.ts`）にこのフィールドは無い — `sha256` / `bytes` /
 * `updatedAt` と完全に冗長なため（どちらも同じ本文から `fingerprintOf` した値）。
 * `.parse()` を通さなければ、これが黙って応答へ出る。
 *
 * **`app.test.ts` 内の `profileService()` ヘルパーはここでは使わない。** あちらの
 * `prepare()` は `{ ok: true, names: [] }` しか返さず `profile` を一度も生成
 * しないので、`.parse()` を外してもこのテストは何も検知しない（空撃ち）。
 * ここでは core の本物（`createProfileApplier` + `createProfileVessel`）を配線し、
 * 実際にシェルスクリプトを評価させて `clone.profile` を生成させる。
 */
describe('宣言と実物の一致（/profile）', () => {
  function withRealApplier() {
    const dir = mkdtempSync(join(tmpdir(), 'alteroid-app-profile-'));
    const vessel = createProfileVessel({ path: join(dir, 'profile.sh') });
    const applier = createProfileApplier({ vessel, baseEnv: () => ({}) });
    const profile = createProfileService({ stores, applier });
    const app = createApp({
      clone: fake.clone,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      profile,
    });
    return { app, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('宣言していないフィールドを外へ出さない（clone.profile は載らない）', async () => {
    const { app, cleanup } = withRealApplier();
    try {
      const response = await app.request('/profile', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ script: 'export SEE_IT_LEAK=1' }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { clone: Record<string, unknown> };

      // **applier がある経路を通っていること。** ここで `clone.ok` が `true` に
      // なっているのは、本物の `ProfileApplier` がスクリプトを実際に評価して
      // 通したからである（`profileService()` の空スタブでは `names` すら
      // 生成されない）。この確認が無いと、下の `not.toHaveProperty` が
      // 「そもそも clone.profile を生成できていないだけ」で通ってしまう。
      expect(body.clone.ok).toBe(true);
      expect(body.clone).not.toHaveProperty('profile');
    } finally {
      cleanup();
    }
  });

  it('宣言したフィールドは載る（parse がぜんぶ落としているのではない）', async () => {
    const { app, cleanup } = withRealApplier();
    try {
      const response = await app.request('/profile', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ script: 'export SEE_IT_LEAK=1' }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        sha256?: string;
        bytes?: number;
        clone: { ok: boolean; names?: string[] };
        runners: unknown[];
      };

      expect(body.sha256).toBeDefined();
      expect(body.bytes).toBeDefined();
      expect(body.clone.ok).toBe(true);
      expect(body.clone.names).toEqual(['SEE_IT_LEAK']);
      expect(body.runners).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

/**
 * 認証トークンのプール（Issue #393「PR1 プールの器」）。
 *
 * **回さない。** ここで固定するのは器の口（`GET` / `PUT` / `PUT .../policy`）が
 * 正しく `requireOperator` を通ること、値が応答のどこにも出ないこと、プールが
 * 空の既定構成の挙動が変わらないことの3つである。検知・切替（PR2 以降）はここに
 * 無い。
 */
describe('認証トークンのプール', () => {
  it('プールが空でも 200 を返し、既定の設定（free_exhausted）を返す（受け入れ基準7）', async () => {
    const withTokens = createApp({
      clone: fake.clone,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      tokens: createTokenPoolService({ stores }),
    });

    const response = await withTokens.request('/tokens');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tokens: [],
      settings: { rotateOn: 'free_exhausted', cooldownMs: 5 * 60 * 60 * 1000 },
    });
  });

  it('deps.tokens が無くても 200 を返す（配線されていないことを黙って隠さない形で既定を返す）', async () => {
    const response = await app.request('/tokens');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tokens: unknown[]; settings: { rotateOn: string } };
    expect(body.tokens).toEqual([]);
    expect(body.settings.rotateOn).toBe('free_exhausted');
  });

  it('PUT で置いたトークンが GET で読み直せる。値は応答のどこにも出ない', async () => {
    const withTokens = createApp({
      clone: fake.clone,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      tokens: createTokenPoolService({ stores }),
    });
    const SECRET = 'tok-super-secret-value';

    const put = await withTokens.request('/tokens', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tokens: [{ label: 'primary', value: SECRET }] }),
    });
    expect(put.status).toBe(200);
    const putText = await put.text();
    expect(putText).not.toContain(SECRET);

    const get = await withTokens.request('/tokens');
    const getText = await get.text();
    expect(getText).not.toContain(SECRET);
    const body = JSON.parse(getText) as { tokens: { label: string; sha256: string }[] };
    expect(body.tokens).toEqual([
      { id: expect.any(String), label: 'primary', order: 0, sha256: expect.any(String) },
    ]);
  });

  it('壊れた入力（消えた id を指す）は 400 を返し、保存しない。理由にトークンの値を含めない', async () => {
    const withTokens = createApp({
      clone: fake.clone,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      tokens: createTokenPoolService({ stores }),
    });
    const SECRET = 'tok-should-not-leak-in-error';

    const response = await withTokens.request('/tokens', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tokens: [{ id: 'ghost', label: '幽霊', value: SECRET }] }),
    });

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain(SECRET);

    expect(await stores.tokens.list()).toEqual([]);
  });

  /**
   * **スキーマ検証（`validator('json', …)`）で落ちた 400 にも値を出さない。**
   *
   * 実測（2026-08-24 観測、`@hono/standard-validator@0.4.0` の `dist/index.mjs`）:
   * `hook` を渡さないと `c.json({ data: value, error, success: false }, 400)` を
   * 返し、この `data` は**リクエスト本文そのもの**である。`sanitizeIssues` が
   * 見る `RESTRICTED_DATA_FIELDS` は `header: ['cookie']` だけなので、`json` は
   * 素通しになる。
   *
   * **⟹ `label` を1つ書き忘れただけで、その回に送った *全部* の値が応答へ載る。**
   * 下で2本送っているのはそのためで、**壊れていないほうの値まで漏れる**ことを
   * 固定する（1本だけだと「壊れた行だけ出さない」形の直しでも緑になる）。
   */
  it('スキーマ検証で落ちた 400 にも、同じ回に送った値が1つも出ない', async () => {
    const withTokens = createApp({
      clone: fake.clone,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      tokens: createTokenPoolService({ stores }),
    });
    const GOOD = 'tok-valid-row-value';
    const BAD = 'tok-row-without-label';

    const response = await withTokens.request('/tokens', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      // 2本目に label が無い＝トップレベルのスキーマ検証で落ちる。
      body: JSON.stringify({ tokens: [{ label: 'primary', value: GOOD }, { value: BAD }] }),
    });

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain(GOOD);
    expect(text).not.toContain(BAD);

    expect(await stores.tokens.list()).toEqual([]);
  });

  /**
   * **保存が「値を含むメッセージ」で落ちても、応答にも stderr にも値を出さない。**
   *
   * ドライバの例外は失敗したクエリの束縛パラメータを添えてくることがある
   * （`dropped-record.ts` の `reasonOf` の doc）。実測（2026-08-24 観測、
   * `drizzle-orm@0.45.2`）: `PgPreparedQuery` の `queryWithCache` が
   * `DrizzleQueryError(queryString, params, e)` で包み直し、その `message` は
   * `Failed query: <sql>` の次の行に `params: <params>` を持つ。`agent_tokens`
   * への insert なら、そこにトークンの値がそのまま並ぶ。
   *
   * 下の偽物のストアが投げる文言は、その実測した形を写したものである。
   */
  it('保存が値を含むメッセージで落ちても、応答にも stderr にも値が出ない', async () => {
    const SECRET = 'tok-inside-driver-error';
    const failing: Stores = {
      ...stores,
      tokens: {
        ...stores.tokens,
        replace: () => {
          throw new Error(
            'Failed query: insert into "agent_tokens" ("id", "label", "value") values ($1, $2, $3)\n' +
              `params: x1,primary,${SECRET}`,
          );
        },
      },
    };
    const withTokens = createApp({
      clone: fake.clone,
      stores: failing,
      token: 'test-token',
      shutdown: () => undefined,
      tokens: createTokenPoolService({ stores: failing }),
    });

    let response: Response | undefined;
    const lines = await captureStderr(async () => {
      response = await withTokens.request('/tokens', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tokens: [{ label: 'primary', value: SECRET }] }),
      });
    });

    // **入力は正しいので 400 ではない。** 落ちたのは保存であり、入力のせいにしない。
    expect(response?.status).toBe(500);
    const text = await (response as Response).text();
    expect(text).not.toContain(SECRET);
    // **跡は残す。ただし本文は出さない**（`dropped-record.ts` の作法）。
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(lines.join('\n')).not.toBe('');
  });

  it('PUT /tokens/policy で回す契機・冷却を変えられる（部分更新）', async () => {
    const withTokens = createApp({
      clone: fake.clone,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      tokens: createTokenPoolService({ stores }),
    });

    const response = await withTokens.request('/tokens/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rotateOn: 'overage_exhausted' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rotateOn: string; cooldownMs: number };
    expect(body.rotateOn).toBe('overage_exhausted');
    // 省略した項目（cooldownMs）は既定のまま。
    expect(body.cooldownMs).toBe(5 * 60 * 60 * 1000);
  });

  /**
   * `requireOperator` に落ちること。`/profile` と同じ強さの口である
   * （課金の主体を決める操作なので、`access grant` を通しただけのアカウントには
   * 開けない）。認証境界そのものの網羅は `auth.test.ts` に寄せてあるので、ここでは
   * 「この3経路が確かに `requireOperator` を通っている」ことだけを見る——
   * **許可されたアカウントでも 403** になることまで確かめる（`OPERATOR` トークンだけ
   * 通って「許可されてさえいれば通る」ように見えるのを防ぐため）。
   */
  describe('実行環境の持ち主だけ（403）', () => {
    const FAKE_PROVIDER = {
      kind: 'oauth2' as const,
      id: 'fake',
      label: 'Fake',
      authorizationUrl: (request: { state: string }) =>
        `https://example.test/authorize?state=${request.state}`,
      exchange: async () => ({
        subject: 'sub-tokens-test',
        email: 'sub-tokens-test@example.test',
        emailVerified: true,
        displayName: 'sub-tokens-test',
      }),
    };
    const post = { method: 'POST', headers: { 'content-type': 'application/json' } };
    const OPERATOR = { authorization: 'Bearer operator-token' };

    function buildAuthedApp() {
      const authStores = createMemoryStores();
      const resolved: AuthPlan = {
        enabled: true,
        providers: [FAKE_PROVIDER],
        publicBaseUrl: 'http://127.0.0.1:4517',
        tokenTtlDays: 30,
        description: 'テスト',
      };
      return createApp({
        clone: fake.clone,
        stores: authStores,
        token: 'operator-token',
        shutdown: () => undefined,
        tokens: createTokenPoolService({ stores: authStores }),
        auth: {
          plan: resolved,
          service: createAuthService({
            store: authStores.auth,
            providers: createAuthProviderRegistry(resolved.providers),
          }),
        },
      });
    }

    /** ログインさせて、実行環境の持ち主として許可（grant）まで通す。 */
    async function grantedAccountToken(app: ReturnType<typeof createApp>): Promise<string> {
      const started = (await (
        await app.request('/auth/login', { ...post, body: JSON.stringify({ provider: 'fake' }) })
      ).json()) as { requestId: string; authorizationUrl: string; claimSecret: string };
      const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';
      await app.request(`/auth/fake/callback?code=any&state=${encodeURIComponent(state)}`);
      const claimed = (await (
        await app.request(`/auth/login/${started.requestId}/claim`, {
          ...post,
          body: JSON.stringify({ claimSecret: started.claimSecret }),
        })
      ).json()) as { token: string; account: { id: string } };
      await app.request(`/access/${claimed.account.id}/grant`, {
        ...post,
        headers: { ...post.headers, ...OPERATOR },
      });
      return claimed.token;
    }

    it('資格が無ければ 401', async () => {
      const withAuth = buildAuthedApp();
      expect((await withAuth.request('/tokens')).status).toBe(401);
    });

    it('許可されたアカウントでも 403（実行環境の持ち主だけが通る）', async () => {
      const withAuth = buildAuthedApp();
      const granted = { authorization: `Bearer ${await grantedAccountToken(withAuth)}` };

      // 許可されている ＝ 他の経路（記憶）には触れる、という前提を先に確かめる。
      expect((await withAuth.request('/memory', { headers: granted })).status).toBe(200);

      expect((await withAuth.request('/tokens', { headers: granted })).status).toBe(403);
      expect(
        (
          await withAuth.request('/tokens', {
            method: 'PUT',
            headers: { 'content-type': 'application/json', ...granted },
            body: JSON.stringify({ tokens: [] }),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await withAuth.request('/tokens/policy', {
            method: 'PUT',
            headers: { 'content-type': 'application/json', ...granted },
            body: JSON.stringify({}),
          })
        ).status,
      ).toBe(403);
    });

    it('実行環境の持ち主は3経路とも通る', async () => {
      const withAuth = buildAuthedApp();

      expect((await withAuth.request('/tokens', { headers: OPERATOR })).status).toBe(200);
      expect(
        (
          await withAuth.request('/tokens', {
            method: 'PUT',
            headers: { 'content-type': 'application/json', ...OPERATOR },
            body: JSON.stringify({ tokens: [] }),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await withAuth.request('/tokens/policy', {
            method: 'PUT',
            headers: { 'content-type': 'application/json', ...OPERATOR },
            body: JSON.stringify({}),
          })
        ).status,
      ).toBe(200);
    });
  });
});

/**
 * `GET /schedule` の応答が宣言（`scheduleListResponseSchema` → `scheduleStatusSchema`）
 * どおりであること。
 *
 * `deps.scheduler?.list()` は core の `Scheduler` 実装が返す `ScheduleStatus[]` を
 * そのまま渡している。ここに宣言に無いフィールドが増えても `describeRoute` の
 * `resolver()` は検査しない（spec を作るだけ）。`.parse()` を外すと、
 * スケジューラが返したものがそのまま応答へ出る。
 *
 * **本物のハンドラを本物の経路で叩く。** `fakeScheduler()` を丸ごと差し替えず、
 * `list()` だけを宣言に無いフィールド混じりの値にすり替えた `Scheduler` を渡す。
 */
describe('宣言と実物の一致（/schedule）', () => {
  it('応答のキー集合が宣言のキー集合と一致する（余分なフィールドは外へ出ない）', async () => {
    const leakyEntry = {
      kind: 'daily_report',
      description: '毎日 22:00（ローカル時刻）にその日の日報をまとめる',
      nextAt: '2026-08-12T13:00:00.000Z',
      request: '例の件を毎朝報告して',
      lastRunAt: '2026-08-11T13:00:00.000Z',
      // **宣言に在る欄は全部埋める。** この試験は応答のキー集合と宣言のキー集合の
      // **一致**を見る（`toEqual`）ので、足場が宣言済みの欄を欠くと、漏れでも
      // 落ちるが**欠けでも落ちる。** `createdAt` / `updatedAt` は #235 で
      // `optional` として宣言に加わったもので、**アサーションは1文字も変えて
      // いない**（緩めると「余分なフィールドは外へ出ない」の保証が消える）。
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
      // 宣言（scheduleStatusSchema）に無いフィールド。
      secretDebugField: 'should-not-escape',
    } as unknown as ScheduleStatus;

    const leakyScheduler: Scheduler = { ...schedule.scheduler, list: () => [leakyEntry] };
    const withLeak = createApp({
      clone: fake.clone,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      scheduler: leakyScheduler,
    });

    const response = await withLeak.request('/schedule');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { entries: Record<string, unknown>[] };

    // **「宣言どおりのものが出る」だけを見ない。** それだけでは `.parse()` を
    // 外しても、たまたま拾った実物のキーが宣言と一致していれば通ってしまう。
    expect(JSON.stringify(body)).not.toContain('secretDebugField');

    const entry = body.entries[0];
    expect(entry).toBeDefined();
    const declaredKeys = Object.keys(scheduleStatusSchema.shape).sort();
    const actualKeys = Object.keys(entry as Record<string, unknown>).sort();
    expect(actualKeys).toEqual(declaredKeys);
  });
});

function fakeRunner(
  runnerId: string,
  options: { runnerIdKnown?: boolean; workspacePathKnown?: boolean; workspacePath?: string } = {},
) {
  const received: string[] = [];
  return {
    runnerId,
    // **既定は `true`（既存テストの前提を変えない）。** `false` を渡すと
    // 「`/health` から一度も `runnerId` を受け取れていない」状態を再現できる
    // （#330 の歯のために足した）。
    runnerIdKnown: options.runnerIdKnown ?? true,
    // **既定は `true`（既存テストの前提を変えない）。** `false` を渡すと
    // 「`/health` から一度も `workspacePath` を受け取れていない」状態を
    // 再現できる（#389 の歯のために足した）。
    workspacePathKnown: options.workspacePathKnown ?? true,
    workspacePath: options.workspacePath ?? '/work',
    received,
    async setProfile(script: string) {
      received.push(script);
      return { ok: true as const };
    },
    async profile() {
      return undefined;
    },
    async credentials() {
      return [];
    },
  };
}

function registryOf(runners: ReturnType<typeof fakeRunner>[]) {
  return {
    async list() {
      return runners;
    },
    async get(id: string) {
      return runners.find((runner) => runner.runnerId === id) ?? null;
    },
    async select() {
      throw new Error('この検証では使わない');
    },
  } as never;
}

/**
 * **本番と同じ1本道を通す。** 器（評価）の成否だけを差し替える。
 *
 * ここを偽物のサービスにすると、直列化も検査もテストの外に出てしまう。
 */
function profileService(
  target: Stores,
  options: { rejects?: string; runners?: ReturnType<typeof fakeRunner>[] } = {},
) {
  return createProfileService({
    stores: target,
    applier: {
      vessel: {} as never,
      fingerprint: () => undefined,
      env: () => ({}),
      async apply(script: string) {
        const prepared = await this.prepare(script);
        if (prepared.ok) await prepared.commit();
        return prepared;
      },
      // **`prepare` が本体である。** 本物も評価と反映を分けている（正本へ書けなかった
      // 更新がクローンにだけ残らないようにするため）。
      async prepare(script: string) {
        const base =
          options.rejects === undefined
            ? { ok: true, names: [] }
            : { ok: false, error: options.rejects, output: script };
        return { ...base, commit: async () => undefined, discard: async () => undefined };
      },
    },
    ...(options.runners === undefined ? {} : { runners: registryOf(options.runners) }),
  });
}

/**
 * 画面（apps/web）を別オリジンに置けるようにするための境界。
 *
 * ここで守っているのは「開けたつもりの範囲」と「実際に通る範囲」を一致させること
 * である。CORS を雑に開けると `deliberateClient` の前提（preflight が通らない）が
 * 消え、人間が開いた任意のページからクローンのターンを起こせる状態に戻る。
 */
describe('ブラウザからの呼び出しを許すオリジン', () => {
  const stores = createMemoryStores();

  function appWith(allowedOrigins: string[]) {
    return createApp({
      clone: fakeClone().clone,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      allowedOrigins,
    });
  }

  const preflight = (origin: string) => ({
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });

  it('既定（列挙なし）では CORS ヘッダを返さない', async () => {
    // ここが今までの姿勢。既定で1バイトも変わらないことを固定する。
    const app = appWith([]);
    const response = await app.request('/health', { headers: { origin: 'https://evil.example' } });

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('列挙したオリジンだけを、そのまま返す', async () => {
    const app = appWith(['https://www.example.com']);
    const response = await app.request('/health', {
      headers: { origin: 'https://www.example.com' },
    });

    expect(response.headers.get('access-control-allow-origin')).toBe('https://www.example.com');
    // Cookie は運ばせない設計なので、資格情報の許可は返さない。
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('列挙していないオリジンの preflight は通らない', async () => {
    const app = appWith(['https://www.example.com']);
    const response = await app.request('/chat', preflight('https://evil.example'));

    // 許可ヘッダが返らない＝ブラウザが本リクエストを送らない。
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('ワイルドカードは返さない（返した瞬間に単純リクエスト対策が無意味になる）', async () => {
    const app = appWith(['https://www.example.com']);
    const response = await app.request('/health', {
      headers: { origin: 'https://www.example.com' },
    });

    expect(response.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('CORS を開けても、単純リクエストは 415 のまま', async () => {
    // 許可したオリジンからでも、本文検査の無い POST は content-type を要求する。
    const app = appWith(['https://www.example.com']);
    const response = await app.request('/shutdown', {
      method: 'POST',
      headers: { origin: 'https://www.example.com', 'content-type': 'text/plain' },
      body: '',
    });

    expect(response.status).toBe(415);
  });
});

describe('parseAllowedOrigins', () => {
  it('オリジンだけを受け付ける', () => {
    expect(parseAllowedOrigins('https://a.example.com,http://127.0.0.1:5173')).toEqual({
      origins: ['https://a.example.com', 'http://127.0.0.1:5173'],
      rejected: [],
    });
  });

  it('末尾スラッシュは許すが、経路が付いたものは捨てる', () => {
    const result = parseAllowedOrigins('https://a.example.com/,https://b.example.com/app');

    expect(result.origins).toEqual(['https://a.example.com']);
    expect(result.rejected).toEqual(['https://b.example.com/app']);
  });

  it('* と、解釈できない値を捨てる', () => {
    // ここを通すと「列挙した相手だけ」という保証が消える。
    const result = parseAllowedOrigins('*,example.com, ,https://ok.example.com');

    expect(result.origins).toEqual(['https://ok.example.com']);
    expect(result.rejected).toEqual(['*', 'example.com']);
  });

  it('重複は畳む。未設定は空', () => {
    expect(parseAllowedOrigins('https://a.example.com,https://a.example.com').origins).toEqual([
      'https://a.example.com',
    ]);
    expect(parseAllowedOrigins(undefined)).toEqual({ origins: [], rejected: [] });
  });
});

/**
 * `GET /runners` は runner の一覧であって、**繋がっている runner の一覧ではない。**
 *
 * 上がってこない runner が一覧から消えるだけだと、人間には「設定し忘れた」のか
 * 「上がってこない」のかが区別できない（roadmap M5「runner の登録・生存判定」）。
 */
describe('runner の生死', () => {
  it('繋がっていない runner も、宛先と状態付きで並ぶ', async () => {
    // 挑み直しの間隔は長めに取る（この検証で見たいのは1回目の失敗の見え方）。
    const registry = createRunnerRegistry([], { retryBaseMs: 60_000, retryMaxMs: 60_000 });
    await registry.register({
      label: 'http://runner:4518',
      open: () => Promise.reject(new Error('fetch failed')),
    });
    await registry.register({
      label: '同一プロセス',
      open: async () => fakeRunner('runner-primary') as never,
    });

    const withRunners = createApp({
      clone: fake.clone,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      runners: registry,
    });

    const body = (await (await withRunners.request('/runners')).json()) as {
      runners: { label: string; state: string; runnerId?: string; error?: string }[];
    };

    expect(body.runners).toMatchObject([
      // 繋がっていないので runner_id は無い。**宛先は言える。**
      { label: 'http://runner:4518', state: 'unreachable' },
      { label: '同一プロセス', state: 'connected', runnerId: 'runner-primary' },
    ]);
    expect(body.runners[0]?.runnerId).toBeUndefined();
    expect(body.runners[0]?.error).toContain('fetch failed');

    await registry.stop();
  });

  /**
   * **#330 の罠そのもの。** `runnerId` は常に文字列を持つ（`HttpRunner` の既定値
   * `'runner-primary'`）ので、`entry.client !== null` だけを根拠に出すと、
   * `/health` から一度も `runnerId` を受け取れていない相手についても「受け取った
   * 値」の顔で出てしまう。繋がってはいる（`state: 'connected'`）が、まだ聞けて
   * いない runner が、既定値をそのまま名乗って見えないことを確かめる。
   */
  it('繋がっていても runnerId を聞けていない runner は、runnerId を出さない（#330）', async () => {
    const registry = createRunnerRegistry([], { retryBaseMs: 60_000, retryMaxMs: 60_000 });
    await registry.register({
      label: '旧版の runner',
      open: async () => fakeRunner('runner-primary', { runnerIdKnown: false }) as never,
    });

    const withRunners = createApp({
      clone: fake.clone,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      runners: registry,
    });

    const body = (await (await withRunners.request('/runners')).json()) as {
      runners: { label: string; state: string; runnerId?: string }[];
    };

    expect(body.runners).toMatchObject([{ label: '旧版の runner', state: 'connected' }]);
    // **既定値 `'runner-primary'` が「聞けた値」の顔で出ていないことを名指しで見る。**
    expect(body.runners[0]).not.toHaveProperty('runnerId');

    await registry.stop();
  });

  /**
   * **#330 と同じ形の罠が `workspacePath` にも在った（#389）。** `workspacePath`
   * も常に文字列を持つ（`HttpRunner` の既定値 `''`）ので、`entry.client !== null`
   * だけを根拠に出すと、`/health` から一度も `workspacePath` を受け取れていない
   * 相手についても「受け取った値」の顔で出てしまう。繋がってはいる
   * （`state: 'connected'`）が、まだ聞けていない runner が、既定値をそのまま
   * 名乗って見えないことを確かめる。
   */
  it('繋がっていても workspacePath を聞けていない runner は、workspacePath を出さない（#389）', async () => {
    const registry = createRunnerRegistry([], { retryBaseMs: 60_000, retryMaxMs: 60_000 });
    await registry.register({
      label: '旧版の runner',
      open: async () => fakeRunner('runner-primary', { workspacePathKnown: false }) as never,
    });

    const withRunners = createApp({
      clone: fake.clone,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      runners: registry,
    });

    const body = (await (await withRunners.request('/runners')).json()) as {
      runners: { label: string; state: string; workspacePath?: string }[];
    };

    expect(body.runners).toMatchObject([{ label: '旧版の runner', state: 'connected' }]);
    // **既定値 `''` が「聞けた値」の顔で出ていないことを名指しで見る。**
    expect(body.runners[0]).not.toHaveProperty('workspacePath');

    await registry.stop();
  });

  /**
   * **歯（iii）— 本当に `''` を名乗った相手については `''` が出ること（#389）。**
   * 上のテストと `workspacePath` の値だけを見ると同じ（どちらも `''`）だが、
   * `workspacePathKnown` が違う。ここを区別できないと、「聞けたか」の判定を
   * 値そのもの（`=== ''`）で代用したときと同じ害に戻る——本当に空の作業
   * ディレクトリを名乗る runner と、一度も聞けていない runner が見分けられ
   * なくなる。
   */
  it('workspacePath を聞けていて、それが空文字なら、空文字のまま出す（#389）', async () => {
    const registry = createRunnerRegistry([], { retryBaseMs: 60_000, retryMaxMs: 60_000 });
    await registry.register({
      label: '空の作業ディレクトリを名乗る runner',
      open: async () =>
        fakeRunner('runner-primary', { workspacePathKnown: true, workspacePath: '' }) as never,
    });

    const withRunners = createApp({
      clone: fake.clone,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      runners: registry,
    });

    const body = (await (await withRunners.request('/runners')).json()) as {
      runners: { label: string; state: string; workspacePath?: string }[];
    };

    expect(body.runners).toMatchObject([
      { label: '空の作業ディレクトリを名乗る runner', state: 'connected' },
    ]);
    // **聞けている以上、空文字であってもキー自体は出る。** 消えるのは
    // 「聞けていない」ときだけである。
    expect(body.runners[0]).toHaveProperty('workspacePath', '');

    await registry.stop();
  });

  /**
   * 一度は繋がった runner が黙ったことも、ここから見える。
   *
   * **`unreachable` と同じ扱いにしない。** あちらは「まだ開けていない」宛先で、
   * こちらは「開けていた」宛先＝走っていた仕事ごと黙った可能性がある。人間が
   * 見に来る場所で混ぜると、器を作り直すべきかどうかの判断が付かない。
   *
   * 時計は手で進める（30秒を実時間で待つと CI が遅く・不安定になる）。
   */
  it('名乗らなくなった runner は lost として並ぶ', async () => {
    vi.useFakeTimers();
    try {
      const registry = createRunnerRegistry();
      await registry.register({
        label: 'http://runner:4518',
        open: async () =>
          ({
            ...fakeRunner('runner-primary'),
            // 器は繋がったまま黙った（電源が抜けた・経路だけが切れた）。
            ping: () => Promise.reject(new Error('fetch failed')),
          }) as never,
      });

      const withRunners = createApp({
        clone: fake.clone,
        stores,
        token: 'test-token',
        shutdown: () => undefined,
        runners: registry,
      });

      // 3回分の名乗りが returns しないところまで進める。
      await vi.advanceTimersByTimeAsync(30_000);

      const body = (await (await withRunners.request('/runners')).json()) as {
        runners: { label: string; state: string; runnerId?: string; error?: string }[];
      };
      expect(body.runners).toMatchObject([
        { label: 'http://runner:4518', state: 'lost', runnerId: 'runner-primary' },
      ]);
      expect(body.runners[0]?.error).toContain('fetch failed');

      await registry.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 【A-1】繋がっていない runner は、聞いたことにしない。
   *
   * 指紋は runner が持つので、繋がっていない相手には聞きに行かない
   * （`app.ts` の `probe()`）。名簿に登録はあるが一度も開けていない runner が
   * `credentialsProbe` / `profileProbe` を `'unheard'` と言い、`credentials` は
   * 空配列のままであることを見る——ここで `'failed'` や `'asked'` に化けると、
   * 「確かめられなかった」が「叩いた」に見えてしまう。
   */
  it('繋がっていない runner は、聞いたことにしない', async () => {
    const registry = createRunnerRegistry([], { retryBaseMs: 60_000, retryMaxMs: 60_000 });
    await registry.register({
      label: 'http://runner-unreachable:4518',
      open: () => Promise.reject(new Error('fetch failed')),
    });

    const withRunners = createApp({
      clone: fake.clone,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      runners: registry,
    });

    const body = (await (await withRunners.request('/runners')).json()) as {
      runners: {
        label: string;
        credentials: unknown[];
        credentialsProbe: { status: string };
        profileProbe: { status: string };
      }[];
    };

    expect(body.runners[0]?.credentialsProbe).toEqual({ status: 'unheard' });
    expect(body.runners[0]?.profileProbe).toEqual({ status: 'unheard' });
    expect(body.runners[0]?.credentials).toEqual([]);

    await registry.stop();
  });

  /** 【A-2】叩いて失敗したら、失敗として残る。 */
  it('叩いて失敗したら、失敗として残る', async () => {
    const registry = createRunnerRegistry([], { retryBaseMs: 60_000, retryMaxMs: 60_000 });
    await registry.register({
      label: 'http://runner-failing:4518',
      open: async () =>
        ({
          ...fakeRunner('runner-failing'),
          credentials: () => Promise.reject(new Error('credentials RPC が落ちた')),
          profile: () => Promise.reject(new Error('profile RPC が落ちた')),
        }) as never,
    });

    const withRunners = createApp({
      clone: fake.clone,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      runners: registry,
    });

    const body = (await (await withRunners.request('/runners')).json()) as {
      runners: {
        label: string;
        credentials: unknown[];
        credentialsProbe: { status: string; error?: string };
        profileProbe: { status: string; error?: string };
      }[];
    };

    expect(body.runners[0]?.credentialsProbe.status).toBe('failed');
    expect(body.runners[0]?.credentialsProbe.error).toBeTruthy();
    expect(body.runners[0]?.profileProbe.status).toBe('failed');
    expect(body.runners[0]?.profileProbe.error).toBeTruthy();
    expect(body.runners[0]?.credentials).toEqual([]);

    await registry.stop();
  });

  /**
   * 【A-3】要である。叩いて0件なら、0件だと言う。
   *
   * これが無いと、実装が常に `unheard` / `failed` を返す方向へ倒れても緑のまま
   * になる。繋がって `credentials()` が `[]`・`profile()` が `undefined` を
   * 返す（＝聞けたうえで中身が無かった）runner を見て、両方の probe が
   * `'asked'` になることを確かめる——両方向を測るための1本である。
   */
  it('叩いて0件なら、0件だと言う', async () => {
    const registry = createRunnerRegistry([], { retryBaseMs: 60_000, retryMaxMs: 60_000 });
    await registry.register({
      label: 'http://runner-empty:4518',
      open: async () => fakeRunner('runner-empty') as never,
    });

    const withRunners = createApp({
      clone: fake.clone,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      runners: registry,
    });

    const body = (await (await withRunners.request('/runners')).json()) as {
      runners: {
        label: string;
        credentials: unknown[];
        credentialsProbe: { status: string };
        profileProbe: { status: string };
      }[];
    };

    expect(body.runners[0]?.credentialsProbe).toEqual({ status: 'asked' });
    expect(body.runners[0]?.profileProbe).toEqual({ status: 'asked' });
    expect(body.runners[0]?.credentials).toEqual([]);

    await registry.stop();
  });
});

/**
 * `DELETE /managers/:id` が「宛先が名簿に開いていないだけ」を 404 と畳まなく
 * なったことを、HTTP まで通して固定する。
 *
 * **`fakeClone()` では測れない。** あの偽物の `abort()` は、台帳に居ないときだけ
 * `'absent'` を返す作りで、「台帳には居るが宛先が名簿に開いていない」という今回の
 * 状態そのものを表現できない（`fake.managerList` に積むか積まないかの2値しか
 * 無い）。`outcome` の値だけを測ると「文言だけ直して 404 が残る」を見逃すので、
 * ここでは `fakeClone()` の `managers` を実物の `createManagerPool` へ差し替えて
 * `createApp` に繋ぐ——`packages/core/src/manager.test.ts` の
 * `describe('abort() は宛先が名簿に開いていないことを absent と言わない', ...)` と
 * 同じ足場（開けない宛先だけの名簿＋台帳にジョブ1本）を HTTP 層まで持ち上げた形。
 */
describe('DELETE /managers/:id と実物の ManagerPool（absent と unreachable を混ぜない）', () => {
  const runningAway: Job = {
    id: 'mgr-running-away',
    managerId: 'mgr-running-away',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running',
    summary: '長い移行作業',
    request: 'DB の移行をやって',
    cwd: '/work/project',
    runnerId: 'runner-primary',
    sessionId: 'sess-before-swap',
  };

  /**
   * 台帳にジョブを1本置き、名簿には**開けない宛先だけ**を登録した実物の
   * `ManagerPool` を `createApp` へ繋ぐ。`register()` は `#open()` を `await`
   * するので、戻った時点で名簿の状態は `unreachable` に確定している。
   */
  async function appWithUnreachableRunner() {
    const realStores = createMemoryStores();
    await realStores.jobs.putJob(runningAway);
    const registry = createRunnerRegistry([], { notify: () => undefined });
    await registry.register({
      label: 'http://runner:4518',
      open: (): Promise<RunnerClient> => Promise.reject(new Error('まだ上がっていない')),
    });
    const pool: ManagerPool = createManagerPool({
      stores: realStores,
      post: () => undefined,
      runners: registry,
      profile: createProfileService({ stores: realStores, runners: registry }),
    });
    const base = fakeClone();
    const realApp = createApp({
      clone: { ...base.clone, managers: pool },
      stores: realStores,
      token: 'test-token',
      shutdown: () => undefined,
    });
    return { realApp, pool, registry };
  }

  it('宛先が開いていないだけなら 404 にしない', async () => {
    const { realApp, pool, registry } = await appWithUnreachableRunner();

    const response = await realApp.request('/managers/mgr-running-away', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { outcome?: string };
    expect(body.outcome).toBe('unknown');

    await pool.stop();
    await registry.stop();
  });

  it('台帳に居ないものは、いままでどおり 404', async () => {
    const { realApp, pool, registry } = await appWithUnreachableRunner();

    const response = await realApp.request('/managers/mgr-does-not-exist', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(404);

    await pool.stop();
    await registry.stop();
  });
});

/**
 * `GET /runners` の `revision`（roadmap M5 相当。「自分がどのコミットで走って
 * いるか」）——デーモンと runner が別々にデプロイされて別コミットで走る窓に
 * 気づくための計器。
 *
 * **本体はここ。** `unknown`（名乗ったが runner が版を知らない）と `unheard`
 * （名乗り自体をまだ聞けていない）が同じ値へ潰れていないことを、**1つのテストの
 * 中で**確かめる——別々に測ると、両方が同じ値へ潰れる実装でも両方緑になる。
 *
 * 値は名簿（`RunnerRegistry#entries()`）が heartbeat で既に拾ったものをそのまま
 * 出すだけである（`app.ts` の `GET /runners` は新たに runner を叩かない）ので、
 * ここでは実際に heartbeat を1周させて `entries()` を更新させてから読む。
 */
describe('runner の版（GET /runners revision）', () => {
  it('unknown（名乗ったが版を知らない）と unheard（名乗りをまだ聞けていない）は別の値として並ぶ', async () => {
    vi.useFakeTimers();
    try {
      const registry = createRunnerRegistry();
      // 繋がって名乗るが、版を知らない runner。
      await registry.register({
        label: 'http://runner-unknown-revision:4518',
        open: async () =>
          ({
            ...fakeRunner('runner-unknown-revision'),
            async identity() {
              return { runnerId: 'runner-unknown-revision', revision: { status: 'unknown' } };
            },
          }) as never,
      });
      // 一度も繋がらない runner——名乗り自体を聞けていない。
      await registry.register({
        label: 'http://runner-never-connects:4518',
        open: () => Promise.reject(new Error('fetch failed')),
      });

      const withRunners = createApp({
        clone: fake.clone,
        stores,
        token: 'test-token',
        shutdown: () => undefined,
        runners: registry,
      });

      // 1回分の heartbeat を進めて、繋がった方の revision を probe させる。
      await vi.advanceTimersByTimeAsync(10_000);

      const body = (await (await withRunners.request('/runners')).json()) as {
        runners: { label: string; revision: { status: string } }[];
      };

      const knownButUnknown = body.runners.find(
        (r) => r.label === 'http://runner-unknown-revision:4518',
      );
      const neverConnected = body.runners.find(
        (r) => r.label === 'http://runner-never-connects:4518',
      );

      expect(knownButUnknown?.revision).toEqual({ status: 'unknown' });
      expect(neverConnected?.revision).toEqual({ status: 'unheard' });
      // **本体はここ。** 2状態が同じ値へ畳まれていないことを、同じテストの中で見る。
      expect(knownButUnknown?.revision).not.toEqual(neverConnected?.revision);

      await registry.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('版が返ってきた runner は known として、フル sha ごと並ぶ', async () => {
    vi.useFakeTimers();
    try {
      const registry = createRunnerRegistry();
      const rev = {
        status: 'known' as const,
        commit: 'a'.repeat(40),
        short: 'a'.repeat(12),
        source: 'build' as const,
      };
      await registry.register({
        label: 'http://runner-known:4518',
        open: async () =>
          ({
            ...fakeRunner('runner-known'),
            async identity() {
              return { runnerId: 'runner-known', revision: rev };
            },
          }) as never,
      });

      const withRunners = createApp({
        clone: fake.clone,
        stores,
        token: 'test-token',
        shutdown: () => undefined,
        runners: registry,
      });

      await vi.advanceTimersByTimeAsync(10_000);

      const body = (await (await withRunners.request('/runners')).json()) as {
        runners: { label: string; revision: unknown }[];
      };

      expect(body.runners[0]?.revision).toEqual(rev);

      await registry.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * **`RunnerRevisionStatus` は `RunnerLiveness`（`state`）から導出できない。**
   *
   * `#markSilent`（`runner-protocol.ts`）は `state` を `'lost'` にするとき、
   * それまでに学習した情報（`entry.client` も `entry.revision` も）を捨てない。
   * つまり「黙る直前まで、この版で走っていた」という情報は残り、それ自体が
   * 価値のある情報である。この歯は、将来誰かが「revision は state から
   * 導けるのでは」と簡約しに来たときに落ちる場所として置いてある
   * （`state === 'connected' ? known/unknown : unheard` のような導出へ書き換える
   * と、`lost` になった瞬間に version が消えて `unheard` へ化ける）。
   */
  it('state が lost になっても、直前に聞けた known な版は残る（state からは導出できない）', async () => {
    vi.useFakeTimers();
    try {
      const registry = createRunnerRegistry();
      const rev = {
        status: 'known' as const,
        commit: 'b'.repeat(40),
        short: 'b'.repeat(12),
        source: 'workspace' as const,
      };
      let heard = false;
      await registry.register({
        label: 'http://runner-lost-but-known:4518',
        open: async () =>
          ({
            ...fakeRunner('runner-lost-but-known'),
            async identity() {
              // 最初の1回だけ名乗り、以後は黙る（電源が抜けた・経路だけが切れた）。
              if (!heard) {
                heard = true;
                return { runnerId: 'runner-lost-but-known', revision: rev };
              }
              throw new Error('fetch failed');
            },
          }) as never,
      });

      const withRunners = createApp({
        clone: fake.clone,
        stores,
        token: 'test-token',
        shutdown: () => undefined,
        runners: registry,
      });

      // 1本目の heartbeat（t=10s）で known を覚える。以後3回（t=20s/30s/40s）
      // 黙り続け、t=40s の時点で HEARTBEAT_LOST_MS（30s）を超えて lost へ遷移する。
      await vi.advanceTimersByTimeAsync(40_000);

      const body = (await (await withRunners.request('/runners')).json()) as {
        runners: { label: string; state: string; revision: unknown }[];
      };
      const entry = body.runners.find((r) => r.label === 'http://runner-lost-but-known:4518');

      expect(entry?.state).toBe('lost');
      // **本体はここ。** state が lost でも revision は known のまま。
      expect(entry?.revision).toEqual(rev);

      await registry.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('登録前（名簿が空）でも daemonRevision は出る——runner の登録有無と無関係な事実だから', async () => {
    const withoutRunners = createApp({
      clone: fake.clone,
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      // `runners` を渡さない＝名簿そのものが無い構成。
    });

    const body = (await (await withoutRunners.request('/runners')).json()) as {
      runners: unknown[];
      daemonRevision: { status: string };
    };

    expect(body.runners).toEqual([]);
    // **デーモン自身の版が同じ応答に出ている**（1回の読みで runner の版と
    // 比較できる、が受け入れの本体）。値そのものはこのプロセスの焼き込み状態に
    // 依存するので、期待するのは「known か unknown のどちらかであり、
    // プレースホルダではない」ことだけである。
    expect(['known', 'unknown']).toContain(body.daemonRevision.status);
  });
});
