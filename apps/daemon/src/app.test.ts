import type {
  ChatStreamEvent,
  CloneHost,
  InboxEvent,
  ManagerPool,
  ManagerSummary,
  Scheduler,
  Stores,
} from '@alteroid/core';
import { createMemoryStores } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp, parseAllowedOrigins } from './app.js';
import { createJournalBus, type JournalBus } from './journal-bus.js';

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
  const transcripts = new Map<string, string>();
  const managerSends: { managerId: string; text: string; requestId?: string }[] = [];
  const managerAborts: { managerId: string; reason?: string }[] = [];

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
        return { outcome: 'unknown' as const, detail: `${managerId} は居ない` };
      }
      managerAborts.push({ managerId, ...(reason === undefined ? {} : { reason }) });
      return { outcome: 'stopped' as const, detail: '止めた' };
    },
    async list() {
      return managerList;
    },
    async transcript(managerId) {
      return transcripts.get(managerId) ?? null;
    },
    async restore() {
      return [];
    },
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
    transcripts,
    managerSends,
    managerAborts,
    setReply(events: ChatStreamEvent[]) {
      reply = events;
    },
  };
}

/** スケジューラの代わり。HTTP 層から起こせることだけを見る。 */
function fakeScheduler() {
  const ran: string[] = [];
  const scheduler: Scheduler = {
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
  return { scheduler, ran };
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
  it('/health は本人確認用のトークンを返す（CLI が PID を信用しないため）', async () => {
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, token: 'test-token' });
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

  it('/chat は空文字を拒む', async () => {
    expect((await app.request('/chat', json({ text: '' }))).status).toBe(400);
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

  it('存在しない記憶は 404', async () => {
    expect((await app.request('/memory/nope')).status).toBe(404);
  });

  it('日誌を読める（可観測性の中段）', async () => {
    await stores.journal.append({ type: 'decision', decision: '自分で決めた', grounds: '記憶' });

    const response = await app.request('/journal?limit=10');
    const body = (await response.json()) as { entries: { type: string }[] };

    expect(body.entries[0]).toMatchObject({ type: 'decision' });
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
      waiting: [{ requestId: 'req-1', summary: 'Bash の実行許可' }],
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

  it('記憶は消せるし、消したことは日誌に残る', async () => {
    await stores.persona.write('habits', '朝は不機嫌');

    const response = await app.request('/memory/habits', { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect(await stores.persona.read('habits')).toBeNull();
    const journal = await stores.journal.list({ types: ['memory_update'] });
    expect(journal[0]).toMatchObject({ slug: 'habits', cause: 'human' });
  });

  it('無い記憶を消しても、消えたことにしない', async () => {
    expect((await app.request('/memory/missing', { method: 'DELETE' })).status).toBe(404);
    // 形が不正なものは 400（無いのか、そもそも名前として成立しないのかを分ける）
    expect((await app.request('/memory/居ない', { method: 'DELETE' })).status).toBe(400);
  });
});

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
