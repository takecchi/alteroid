import { describe, expect, it } from 'vitest';

import type { ManagerPool, ManagerSummary } from './manager.js';
import { createProfileService } from './profile-service.js';
import type { ChatStreamEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { CLONE_ALLOWED_TOOLS, createCloneTools, qualifiedToolName } from './tools.js';

interface Harness {
  stores: Stores;
  emitted: ChatStreamEvent[];
  sent: { managerId: string; message: string; decision?: string; requestId?: string }[];
  started: { request: string; cwd?: string }[];
  /** 人間と同じ口（ManagerPool.abort）へ届いた停止。 */
  aborted: { managerId: string; reason?: string }[];
  /** runner へ降ろされたプロファイルの本文。 */
  distributed: string[];
  /** 走っていることになっているマネージャー（直接いじって状況を作る）。 */
  running: ManagerSummary[];
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
      // 本物の `list()` は毎回作り直した写しを返す（`summaryOf`）。同じ物を返すと、
      // 呼び手が控えた「前の状態」が後から書き換わってしまう。
      return running.map((manager) => ({ ...manager }));
    },
    async transcript() {
      return null;
    },
    async restore() {
      return [];
    },
    async abort(managerId: string, reason?: string) {
      aborted.push({ managerId, ...(reason === undefined ? {} : { reason }) });
      const found = running.find((manager) => manager.managerId === managerId);
      if (!found)
        return { outcome: 'unknown' as const, detail: `${managerId} というマネージャーは居ない。` };
      // 本物と同じところまで動かす（status を畳み、セッションを切る）。ここを
      // 動かさないと「受理した」と「効いた」の差がテストに映らない。
      found.status = 'done';
      found.live = false;
      return { outcome: 'stopped' as const, detail: '止めた', sessionGone: true };
    },
    async stop() {},
  };

  // 実行環境プロファイルの配布先。人間の口と同じ配線を通す。
  const distributed: string[] = [];
  const runners = {
    async list() {
      return [
        {
          runnerId: 'runner-test',
          async setProfile(script: string) {
            distributed.push(script);
            return { ok: true as const };
          },
        },
      ];
    },
    async get() {
      return null;
    },
    async select() {
      throw new Error('この検証では使わない');
    },
  } as never;

  const tools = createCloneTools({
    stores,
    emit: (event) => emitted.push(event),
    managers,
    // **本番と同じ1本道を通す。** ここを偽物にすると、直列化も検査も
    // テストの外に出てしまう。
    profile: createProfileService({ stores, runners }),
  });

  return {
    stores,
    emitted,
    sent,
    started,
    aborted,
    distributed,
    running,
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

  /**
   * 実行環境プロファイル。
   *
   * **クローンにも人間と同じ手を持たせる。** 人間は自分の `~/.zshenv` を開いて
   * 直せるのだから、その写像であるクローンにできないのは能力の削除である
   * （north_star 禁止2 は層を問わず効く）。
   *
   * 固定するのは「人間が言ったことを永続化できる」ことと、「置いたものが
   * ちゃんと配られる」ことの2つ。**人間の口（`PUT /profile`）と同じ経路を通る**
   * ので、片方だけ検査が緩いという状態を作らない。
   */
  it('profile_write は保存し、runner へも降ろす', async () => {
    const h = harness();

    const result = await h.call('profile_write', {
      script: 'export SOME_API_TOKEN=abc123',
      summary: '人間から渡されたトークンを実行環境へ移した',
    });

    expect(result).toContain('更新した');
    expect((await h.stores.profile.read())?.script).toContain('SOME_API_TOKEN');
    // **置くだけで終わらせない。** 配られていなければマネージャーには効かない。
    expect(h.distributed).toHaveLength(1);
    expect(h.distributed[0]).toContain('SOME_API_TOKEN');
  });

  it('profile_read で今の本文を取れる（足すだけの更新ができる）', async () => {
    const h = harness();
    await h.call('profile_write', { script: 'export A=1', summary: 'A' });

    const body = await h.call('profile_read', {});

    expect(body).toContain('export A=1');
  });

  it('置けなかったら判断として記録せず、理由をその場で返す', async () => {
    const h = harness();
    // 器が「読めない」と答える状況。置けなかったのはシステムの結果であって、
    // クローンの判断ではない（日誌の decision を汚さない）。
    const tools = createCloneTools({
      stores: h.stores,
      emit: () => undefined,
      profile: createProfileService({
        stores: h.stores,
        applier: {
          vessel: {} as never,
          fingerprint: () => undefined,
          env: () => ({}),
          async apply() {
            return { ok: false, error: '構文が壊れている' };
          },
          async prepare() {
            return {
              ok: false,
              error: '構文が壊れている',
              commit: async () => undefined,
              discard: async () => undefined,
            };
          },
        },
      }),
    });
    const write = tools.find((entry) => entry.name === 'profile_write');
    const result = await write?.handler({ script: 'if [ ; then', summary: 'x' } as never, {});
    const body = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(body).toContain('置けなかった');
    expect(body).toContain('構文が壊れている');
    expect(await h.stores.profile.read()).toBeNull();
    expect(await h.stores.journal.list({ types: ['decision'] })).toHaveLength(0);
  });

  it('日誌に残すのは何を変えたかであって、値ではない', async () => {
    const h = harness();

    await h.call('profile_write', {
      script: 'export SOME_API_TOKEN=super-secret',
      summary: 'Slack の鍵を置いた',
    });

    const [entry] = await h.stores.journal.list({ types: ['decision'] });
    expect(JSON.stringify(entry)).not.toContain('super-secret');
    expect(JSON.stringify(entry)).toContain('Slack の鍵を置いた');
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
    const first = await h.stores.schedules.get('watch');
    await h.stores.schedules.claimRun(
      'watch',
      first?.updatedAt ?? '',
      '2026-08-12T00:00:00.000Z',
      'schedule',
    );
    await h.stores.schedules.completeRun('watch', '2026-08-12T00:00:00.000Z', 'schedule');

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

  // --- 自分自身 -------------------------------------------------------------

  it('self_read は正典を全文返す（クローンが自分の要件を読める）', async () => {
    const h = harness();

    const body = await h.call('self_read', { document: 'north_star' });

    expect(body).toContain('docs/north_star.md');
    expect(body).toContain('デグレード禁止');
    expect(body).toContain('追加制限禁止');
  });

  it('self_read は無い名前に、読める名前を添えて答える（黙って空を返さない）', async () => {
    const h = harness();

    const body = await h.call('self_read', { document: 'agents' });

    expect(body).toContain('north_star');
    expect(body).toContain('roadmap');
  });

  /**
   * 委譲できない内部ターン（蒸留）でも、自分が何者かは読めること。
   * ここが `managers` の有無に引きずられると、記憶へ移す判断だけが
   * 自己認識なしで行われる。
   */
  it('self_read は委譲できない場面でも使える', async () => {
    const tools = createCloneTools({ stores: createMemoryStores(), emit: () => undefined });
    const found = tools.find((entry) => entry.name === 'self_read');

    const result = await found?.handler({ document: 'roadmap' } as never, {});
    const body = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(body).toContain('docs/roadmap.md');
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

  /**
   * **人間に出来てクローンに出来ないことを作らない**（north_star 禁止1）。
   *
   * 停止は Web UI（`DELETE /managers/:id`）にも CLI にもあるのに、クローンの道具
   * だけに無かった。暴走したマネージャーも、報告を出したのに終わらないマネージャーも、
   * クローンからは**無応答のまま放置するしか手が無かった**（実際にそうなった）。
   *
   * 通す口は人間と同じ `ManagerPool.abort` である。クローン専用の停止を別に作ると、
   * 人間とクローンで見えている状態が食い違う。
   */
  it('manager_stop は人間と同じ口で止め、止まったことを確かめてから返す', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });

    const reply = await h.call('manager_stop', { managerId: 'mgr-1', reason: '暴走した' });

    expect(h.aborted).toEqual([{ managerId: 'mgr-1', reason: '暴走した' }]);
    // **「受理した」で終わらせない。** 止めたあとの実際の状態を読み直して返す。
    expect(reply).toContain('mgr-1');
    expect(reply).toContain('done');
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

/**
 * 一覧は**件数が増えても読める**こと。
 *
 * 人間は Web UI でマネージャー一覧を見られる。クローンだけが件数の増加で
 * 見られなくなるなら、それは能力の削除（north_star 禁止1）である。しかも
 * MCP の出力上限を超えた応答はクローンに1文字も届かない（SDK がファイルへ
 * 落として「上限超過」だけを返す）ので、**溢れさせた時点で全滅**する。
 * 抜粋に留め、省いたことを明示し、全文は別の口で取れるようにする。
 */
describe('manager_list は件数が増えても壊れない', () => {
  async function crowded(count: number): Promise<Harness> {
    const h = harness();
    for (let index = 0; index < count; index += 1) {
      await h.call('manager_start', { request: `依頼${index}: ${'あ'.repeat(1500)}` });
    }
    for (const summary of h.running) summary.lastReport = `報告: ${'ほ'.repeat(3000)}`;
    return h;
  }

  it('マネージャーが増えても既定の出力は上限内に収まる', async () => {
    const few = await crowded(3);
    const many = await crowded(120);

    const small = await few.call('manager_list', {});
    const big = await many.call('manager_list', {});

    // 実測で溢れたのは 52,997 文字。件数に比例して伸びる作りだと、
    // 何件で壊れるかが運任せになる。
    expect(big.length).toBeLessThan(12_000);
    expect(small.length).toBeLessThan(12_000);
  });

  it('切ったことを黙らない（何文字省いたか・全部で何件かが出力に出る）', async () => {
    const h = await crowded(120);

    const reply = await h.call('manager_list', {});

    // 本文の抜粋には「省略した分量」が付く
    expect(reply).toMatch(/省略/);
    expect(reply).toMatch(/全\s*\d[\d,]*\s*文字/);
    // 一覧そのものを切ったなら、全体の件数が分かる
    expect(reply).toContain('120');
    // 全文への行き先が書いてある
    expect(reply).toContain('manager_report');
  });

  it('manager_report は報告の全文を返し、長ければ続きの取り方を示す', async () => {
    const h = await crowded(2);

    const reply = await h.call('manager_report', { managerId: 'mgr-1' });

    expect(reply).toContain('報告: ほ');
    // 全文が一度に返らないなら、どこで切れていて続きをどう取るかを必ず言う
    if (!reply.includes('ほ'.repeat(3000))) {
      expect(reply).toMatch(/省略|続き/);
      expect(reply).toMatch(/offset/);
    }
  });

  it('居ないマネージャーを聞かれたら黙らずにそう返す', async () => {
    const h = await crowded(1);

    const reply = await h.call('manager_report', { managerId: 'mgr-999' });

    expect(reply).toContain('mgr-999');
  });
});

describe('usage_read（人間が見られるものはクローンからも見られる）', () => {
  const models = {
    'claude-opus-5': {
      inputTokens: 10,
      outputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd: 2,
    },
    'claude-sonnet-5': {
      inputTokens: 5,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd: 0.0031,
    },
  };

  async function spent(h: Harness) {
    await h.stores.usage.record({
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: { models },
    });
  }

  it('道具として配られている（クローンから見えないものを作らない）', () => {
    expect(CLONE_ALLOWED_TOOLS).toContain(qualifiedToolName('usage_read'));
  });

  it('合計とモデル別を返し、但し書きを必ず添える', async () => {
    const h = harness();
    await spent(h);

    const reply = await h.call('usage_read', {});

    expect(reply).toContain('合計 $2.00');
    expect(reply).toContain('claude-opus-5');
    expect(reply).toContain('claude-sonnet-5');
    // **推定であることを落とさない。** 台帳の数字を確定として見せない。
    expect(reply).toContain('請求明細ではない');
  });

  it('$1 未満を丸めて 0 にしない（「使っていない」と読めてしまう）', async () => {
    const h = harness();
    await spent(h);

    const reply = await h.call('usage_read', { managerId: 'mgr-1' });

    expect(reply).toContain('$0.0031');
    expect(reply).not.toContain('$0.00\n');
  });

  it('まだ1件も無ければ「$0」ではなく「記録が無い」と言う', async () => {
    const h = harness();

    const reply = await h.call('usage_read', {});

    expect(reply).toContain('記録が無い');
    expect(reply).not.toContain('$0');
  });

  it('台帳の始点より前を聞かれたら「0」ではなく「記録が無い」と言う', async () => {
    // 過去分は掘り起こさないと決めた。だから始点を黙って隠さない — 台帳が無かった
    // 期間を「使っていない期間」に見せると、それは嘘になる。
    const h = harness();
    await spent(h);

    const reply = await h.call('usage_read', { from: '2020-01-01' });

    expect(reply).toContain('台帳の始点');
    expect(reply).toContain('記録が無い');
  });

  it('その範囲に記録が無いことと、台帳が空であることを混ぜない', async () => {
    const h = harness();
    await spent(h);

    const reply = await h.call('usage_read', { from: '2026-09-01', to: '2026-09-30' });

    expect(reply).toContain('その範囲には記録が無い');
    // 台帳自体は始まっているので、その始点は分かる。
    expect(reply).toContain('台帳の始点: 2026-08-14');
  });
});
