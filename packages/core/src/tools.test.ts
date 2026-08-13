import { describe, expect, it } from 'vitest';

import type { ManagerPool, ManagerSummary } from './manager.js';
import type { ChatStreamEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { CLONE_ALLOWED_TOOLS, createCloneTools, qualifiedToolName } from './tools.js';

interface Harness {
  stores: Stores;
  emitted: ChatStreamEvent[];
  sent: { managerId: string; message: string; decision?: string; requestId?: string }[];
  started: { request: string; cwd?: string }[];
  call(name: string, args: Record<string, unknown>): Promise<string>;
}

function harness(): Harness {
  const stores = createMemoryStores();
  const emitted: ChatStreamEvent[] = [];
  const sent: { managerId: string; message: string; decision?: string; requestId?: string }[] = [];
  const started: { request: string; cwd?: string }[] = [];
  const aborted: { managerId: string; reason?: string }[] = [];
  const running: ManagerSummary[] = [];

  const managers: ManagerPool = {
    async start(input) {
      started.push(input);
      const summary: ManagerSummary = {
        managerId: `mgr-${started.length}`,
        status: 'running',
        live: true,
        cwd: input.cwd ?? '/work',
        request: input.request,
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        waiting: [],
      };
      running.push(summary);
      return summary;
    },
    async send(managerId, message, options = {}) {
      sent.push({ managerId, message, ...options });
      return { outcome: 'answered', detail: '回答した。' };
    },
    async list() {
      return running;
    },
    async transcript() {
      return null;
    },
    async restore() {
      return [];
    },
    async abort(managerId: string, reason?: string) {
      aborted.push({ managerId, ...(reason === undefined ? {} : { reason }) });
      return { outcome: 'stopped' as const, detail: '止めた' };
    },
    async stop() {},
  };

  const tools = createCloneTools({ stores, emit: (event) => emitted.push(event), managers });

  return {
    stores,
    emitted,
    sent,
    started,
    async call(name, args) {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`ツール ${name} が無い`);
      const result = await found.handler(args as never, {});
      return (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
    },
  };
}

describe('クローンの道具', () => {
  it('モデルから見える名前は mcp__alteroid__* である', () => {
    expect(qualifiedToolName('ask_human')).toBe('mcp__alteroid__ask_human');
    expect(CLONE_ALLOWED_TOOLS).toContain('mcp__alteroid__memory_write');
  });

  it('memory_write は記憶を更新し、日誌に memory_update を残す', async () => {
    const h = harness();

    await h.call('memory_write', {
      slug: 'values',
      content: '# 価値観\n\n速さより正しさ\n',
      summary: '価値観を書いた',
    });

    expect((await h.stores.persona.read('values'))?.content).toContain('速さより正しさ');
    const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
    expect(entry).toMatchObject({ type: 'memory_update', slug: 'values', cause: 'clone' });
  });

  // --- 継続中の依頼 --------------------------------------------------------
  // 「定期的に〜しておいて」を、思い出せるかどうかの賭けにしないための器。

  it('schedule_create は継続中の依頼として残り、schedule_list で読める', async () => {
    const h = harness();

    const created = await h.call('schedule_create', {
      kind: 'issue-round',
      request: 'このリポジトリの open issue を見て、着手できるものから実装を進める',
      dailyAt: '09:00',
    });
    expect(created).toContain('毎日 09:00');

    const plans = await h.stores.schedules.list();
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      kind: 'issue-round',
      spec: { type: 'daily', at: '09:00' },
    });
    expect(await h.call('schedule_list', {})).toContain('open issue');

    // 聞かずに仕込んだことは日誌に残る
    const [entry] = await h.stores.journal.list({ types: ['decision'] });
    expect(entry).toMatchObject({ type: 'decision' });
  });

  it('同じ kind で仕込み直すと置き換わる（前回動いた時刻は保つ）', async () => {
    const h = harness();
    await h.call('schedule_create', { kind: 'watch', request: '最初の依頼', everyMinutes: 30 });
    await h.stores.schedules.markRun('watch', '2026-08-12T00:00:00.000Z');

    await h.call('schedule_create', { kind: 'watch', request: '直した依頼', everyMinutes: 10 });

    const plans = await h.stores.schedules.list();
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      request: '直した依頼',
      spec: { type: 'every', minutes: 10 },
      lastRunAt: '2026-08-12T00:00:00.000Z',
    });
  });

  it('cron 式でも仕込める（曜日の指定が要る依頼のため）', async () => {
    const h = harness();

    const created = await h.call('schedule_create', {
      kind: 'weekly-review',
      request: '週次で先週の日報を読み直して、抜けている決めごとを拾う',
      cron: '0 10 * * 1',
    });
    expect(created).toContain('cron: 0 10 * * 1');

    expect((await h.stores.schedules.list())[0]).toMatchObject({
      spec: { type: 'cron', expression: '0 10 * * 1' },
    });
  });

  it('読めない cron 式は仕込まない', async () => {
    const h = harness();

    const result = await h.call('schedule_create', {
      kind: 'weekly-review',
      request: 'x',
      cron: 'まいしゅう げつようび',
    });

    expect(result).toContain('cron 式として読めない');
    expect(await h.stores.schedules.list()).toEqual([]);
  });

  it('周期の指定は1つだけ。読めない指定は仕込まない', async () => {
    const h = harness();

    expect(await h.call('schedule_create', { kind: 'a', request: 'x' })).toContain('どれか1つだけ');
    expect(
      await h.call('schedule_create', {
        kind: 'a',
        request: 'x',
        dailyAt: '09:00',
        everyMinutes: 30,
      }),
    ).toContain('どれか1つだけ');
    expect(
      await h.call('schedule_create', {
        kind: 'a',
        request: 'x',
        dailyAt: '09:00',
        cron: '0 10 * * 1',
      }),
    ).toContain('どれか1つだけ');
    expect(
      await h.call('schedule_create', { kind: 'a', request: 'x', dailyAt: '25:00' }),
    ).toContain('読めない');
    expect(
      await h.call('schedule_create', { kind: 'ダメな名前', request: 'x', dailyAt: '09:00' }),
    ).toContain('使えない');
    expect(await h.stores.schedules.list()).toEqual([]);
  });

  it('既定の定期ジョブの名前は奪えない（日報を潰せない）', async () => {
    const h = harness();
    const result = await h.call('schedule_create', {
      kind: 'daily_report',
      request: '日報を潰す',
      everyMinutes: 1,
    });
    expect(result).toContain('既定の定期ジョブ');
    expect(await h.stores.schedules.list()).toEqual([]);
  });

  it('schedule_remove は依頼を片付ける。無い依頼なら何もしない', async () => {
    const h = harness();
    await h.call('schedule_create', { kind: 'watch', request: '見張る', everyMinutes: 30 });

    expect(await h.call('schedule_remove', { kind: 'しらない' })).toContain('無い');
    expect(await h.stores.schedules.list()).toHaveLength(1);

    expect(await h.call('schedule_remove', { kind: 'watch' })).toContain('外した');
    expect(await h.stores.schedules.list()).toEqual([]);
  });

  it('memory_append は既存の記述を消さない（人間の手書きを守る）', async () => {
    const h = harness();
    await h.stores.persona.write('values', '# 価値観\n\n人間が手で書いた\n');

    await h.call('memory_append', {
      slug: 'values',
      content: '- クローンが足した学び',
      summary: '学びを追記',
    });

    const content = (await h.stores.persona.read('values'))?.content ?? '';
    expect(content).toContain('人間が手で書いた');
    expect(content).toContain('クローンが足した学び');
  });

  it('journal_write は判断を日誌に残す（聞かずに実行した判断の記録）', async () => {
    const h = harness();

    await h.call('journal_write', {
      decision: '人間に聞かずに設定を変えた',
      grounds: 'about-me.md に「設定変更は任せる」とある',
    });

    const [entry] = await h.stores.journal.list({ types: ['decision'] });
    expect(entry).toMatchObject({ type: 'decision', grounds: expect.stringContaining('about-me') });
  });

  it('ask_human は承認待ちに積み、日誌に残し、chat へ通知する（応答は待たない）', async () => {
    const h = harness();

    const reply = await h.call('ask_human', { question: 'これを送ってよいか' });

    const pending = await h.stores.jobs.listApprovals({ pendingOnly: true });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.question).toBe('これを送ってよいか');

    const [escalation] = await h.stores.journal.list({ types: ['escalation'] });
    expect(escalation).toMatchObject({ type: 'escalation', question: 'これを送ってよいか' });

    expect(h.emitted).toEqual([
      { type: 'ask_human', approvalId: pending[0]?.id, question: 'これを送ってよいか' },
    ]);
    // 積むだけ。ここでブロックしない（止まるのはその仕事だけ）
    expect(reply).toContain('承認待ちキューに積んだ');
  });

  it('ask_human は manager_id を添えれば、どの仕事が止まっているか辿れる', async () => {
    const h = harness();

    await h.call('ask_human', { question: '本番に出してよいか', managerId: 'mgr-1' });

    const [pending] = await h.stores.jobs.listApprovals({ pendingOnly: true });
    expect(pending?.jobId).toBe('mgr-1');
  });

  it('approvals_list で、人間の回答待ちを自分で見られる（溜まった保留の運用）', async () => {
    const h = harness();
    expect(await h.call('approvals_list', {})).toContain('回答待ちは無い');

    await h.call('ask_human', {
      question: '本番に出してよいか',
      managerId: 'mgr-1',
      requestId: 'req-9',
    });
    await h.stores.jobs.putApproval({
      id: 'ap-old',
      createdAt: '2026-01-01T00:00:00.000Z',
      question: '済んだ質問',
      answeredAt: '2026-01-01T01:00:00.000Z',
      answer: 'よい',
    });

    const reply = await h.call('approvals_list', {});
    expect(reply).toContain('本番に出してよいか');
    expect(reply).toContain('req-9');
    // 回答済みは並べない（片付ける先がここだから）
    expect(reply).not.toContain('済んだ質問');
  });

  it('daily_report_write は指定された日付で日報を残す', async () => {
    const h = harness();

    await h.call('daily_report_write', { date: '2026-08-11', body: '# 日報\n\n直した' });

    const [entry] = await h.stores.journal.list({ types: ['daily_report'] });
    expect(entry).toMatchObject({ type: 'daily_report', date: '2026-08-11' });
  });

  it('日付が無い・壊れている・存在しない日なら今日として残す（読めない日報を作らない）', async () => {
    const h = harness();
    const today = new Date();
    const expected = `${today.getFullYear()}-${`${today.getMonth() + 1}`.padStart(2, '0')}-${`${today.getDate()}`.padStart(2, '0')}`;

    await h.call('daily_report_write', { body: '本文' });
    await h.call('daily_report_write', { date: 'きのう', body: '本文' });
    // 形は合っているが存在しない日。ここを通すと書いた日と読める日がずれる
    await h.call('daily_report_write', { date: '2026-02-31', body: '本文' });

    const entries = (await h.stores.journal.list({ types: ['daily_report'] })) as {
      date: string;
    }[];
    expect(entries).toHaveLength(3);
    for (const entry of entries) expect(entry.date).toBe(expected);
  });

  it('manager_start は起こして即返り、委譲の判断が日誌に残る', async () => {
    const h = harness();

    const reply = await h.call('manager_start', {
      request: 'ログイン周りを直して',
      cwd: '/work/x',
    });

    expect(h.started).toEqual([{ request: 'ログイン周りを直して', cwd: '/work/x' }]);
    expect(reply).toContain('mgr-1');

    const [entry] = await h.stores.journal.list({ types: ['decision'] });
    expect(entry).toMatchObject({ decision: expect.stringContaining('mgr-1') });
  });

  it('manager_send は decision と requestId を添えて、宛先を指して答えられる', async () => {
    const h = harness();

    await h.call('manager_send', {
      managerId: 'mgr-1',
      message: 'よい',
      decision: 'allow',
      requestId: 'req-9',
    });

    expect(h.sent).toEqual([
      { managerId: 'mgr-1', message: 'よい', decision: 'allow', requestId: 'req-9' },
    ]);
  });

  it('manager_list は状態と返事待ちを返す', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });

    const reply = await h.call('manager_list', {});
    expect(reply).toContain('mgr-1');
    expect(reply).toContain('running');
  });

  it('委譲先が無い場面（蒸留の内部ターン）は、黙らずにそう返す', async () => {
    const stores = createMemoryStores();
    const tools = createCloneTools({ stores, emit: () => undefined });
    const found = tools.find((entry) => entry.name === 'manager_start');
    const result = await found?.handler({ request: 'x' } as never, {});

    expect(JSON.stringify(result)).toContain('委譲できない');
  });
});
