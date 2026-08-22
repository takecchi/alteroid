import { describe, expect, it } from 'vitest';

import type { ManagerDenial, ManagerPool, ManagerSummary, RunnerFleetOverview } from './manager.js';
import { renderMemoryDocuments } from './memory.js';
import { createProfileService } from './profile-service.js';
import { journalEntrySchema, type ChatStreamEvent } from './schema.js';
import type { CloneRuntimeFacts } from './self.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { buildCloneSystemPrompt } from './prompt.js';
import {
  CLONE_ALLOWED_TOOLS,
  CLONE_TOOL_NAMES,
  createCloneTools,
  qualifiedToolName,
} from './tools.js';
import type { AccountUsageState } from './usage-snapshot.js';

interface Harness {
  stores: Stores;
  emitted: ChatStreamEvent[];
  sent: { managerId: string; message: string; decision?: string; requestId?: string }[];
  started: { request: string; cwd?: string; runnerId?: string }[];
  /** 人間と同じ口（ManagerPool.abort）へ届いた停止。 */
  aborted: { managerId: string; reason?: string }[];
  /** runner へ降ろされたプロファイルの本文。 */
  distributed: string[];
  /** 走っていることになっているマネージャー（直接いじって状況を作る）。 */
  running: ManagerSummary[];
  /** 確認へ上がらず止められた道具（manager_id → 古い順）。 */
  denied: Map<string, ManagerDenial[]>;
  /**
   * `abort()` が返す outcome を差し替える（既定は `'stopped'`）。
   *
   * `manager_stop` の文言が outcome ごとに分かれることを見るためのもので、
   * `'not_stopped'` / `'unknown'` のときは「本物と同じところまで動かす」
   * （status を畳む・セッションを切る）を**しない**——それが outcome の意味である。
   */
  setAbortOutcome(outcome: 'stopped' | 'not_stopped' | 'unknown', sessionGone?: boolean): void;
  /**
   * `manager_start` の指名が無いとき、`Pool.start()` が返す `runnerId`
   * （自動配置が選んだ器）を差し替える。`undefined` にすると「未記録」の文言を
   * 見るための状態を作れる。
   */
  setAutoRunnerId(runnerId: string | undefined): void;
  /** `runner_list` が読む `ManagerPool.runners()` の返り値を差し替える。 */
  setRunnersOverview(overview: RunnerFleetOverview): void;
  /**
   * `manager_transcript` が読む `ManagerPool.transcript()` の返り値を差し替える。
   * 設定しなければ既定で `null`（3段のどこにも無い、を模している）。
   */
  setTranscript(managerId: string, body: string | null): void;
  /** `runners()` に渡された引数（`fingerprints` を渡したかどうかの検査用）。 */
  runnersCalls: { fingerprints?: boolean }[];
  call(name: string, args: Record<string, unknown>): Promise<string>;
}

function harness(runtime?: () => CloneRuntimeFacts): Harness {
  const stores = createMemoryStores();
  const emitted: ChatStreamEvent[] = [];
  const sent: { managerId: string; message: string; decision?: string; requestId?: string }[] = [];
  const started: { request: string; cwd?: string; runnerId?: string }[] = [];
  const aborted: { managerId: string; reason?: string }[] = [];
  const running: ManagerSummary[] = [];
  const denied = new Map<string, ManagerDenial[]>();
  let abortOutcome: 'stopped' | 'not_stopped' | 'unknown' = 'stopped';
  let abortSessionGone: boolean | undefined = true;
  // **指名しなかったときに Pool.start() が返す runnerId。** 本物は資源で選んだ
  // 器の runnerId を返す——ここでは差し替え可能な既定値でそれを真似る。
  let autoRunnerId: string | undefined = 'runner-test';
  let runnersOverview: RunnerFleetOverview = {
    runners: [],
    unassigned: [],
    daemonRevision: { status: 'unknown' },
  };
  const runnersCalls: { fingerprints?: boolean }[] = [];
  const transcripts = new Map<string, string>();

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
        // **指名があればそれを、無ければ自動配置の代わりの既定値を返す。** 本物
        // （`Pool.start`）は常に実際に走った器の runnerId を返す——指名の有無を
        // 問わない、がここで固定したい形である。
        ...((input.runnerId ?? autoRunnerId) === undefined
          ? {}
          : { runnerId: input.runnerId ?? autoRunnerId }),
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
    denials(managerId: string) {
      return denied.get(managerId) ?? [];
    },
    async transcript(managerId: string) {
      return transcripts.get(managerId) ?? null;
    },
    async restore() {
      return [];
    },
    // クローンの道具はこの口を呼ばない（引き取りの契機はデーモン側にある）。
    async reattachRunner() {},
    async abort(managerId: string, reason?: string) {
      aborted.push({ managerId, ...(reason === undefined ? {} : { reason }) });
      const found = running.find((manager) => manager.managerId === managerId);
      if (!found)
        return { outcome: 'absent' as const, detail: `${managerId} というマネージャーは居ない。` };
      if (abortOutcome === 'stopped') {
        // 本物と同じところまで動かす（status を畳み、セッションを切る）。ここを
        // 動かさないと「受理した」と「効いた」の差がテストに映らない。
        found.status = 'stopped';
        found.live = false;
      }
      // `not_stopped` / `unknown` は「台帳を1文字も書かない」が本物の挙動なので、
      // ここでも `found` を触らない。
      return {
        outcome: abortOutcome,
        detail:
          abortOutcome === 'stopped'
            ? '止めた'
            : abortOutcome === 'not_stopped'
              ? 'まだ止まっていない'
              : '止まったかは未確認',
        ...(abortSessionGone === undefined ? {} : { sessionGone: abortSessionGone }),
      };
    },
    async runners(options = {}) {
      runnersCalls.push(options);
      return runnersOverview;
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
    ...(runtime === undefined ? {} : { runtime }),
  });

  return {
    stores,
    emitted,
    sent,
    started,
    aborted,
    distributed,
    running,
    denied,
    setAbortOutcome(outcome, sessionGone) {
      abortOutcome = outcome;
      // 省略時は outcome から自然に決まる値を補う（`stopped` ⟺ `true`、
      // `not_stopped` ⟺ `false`、`unknown` ⟺ `undefined`）。
      abortSessionGone =
        sessionGone ??
        (outcome === 'stopped' ? true : outcome === 'not_stopped' ? false : undefined);
    },
    setAutoRunnerId(runnerId) {
      autoRunnerId = runnerId;
    },
    setRunnersOverview(overview) {
      runnersOverview = overview;
    },
    setTranscript(managerId, body) {
      if (body === null) transcripts.delete(managerId);
      else transcripts.set(managerId, body);
    },
    runnersCalls,
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

  /**
   * **人間の決定**（「器の許可規則に `gh pr merge` を通す」）。
   *
   * 効くのは権限モードが `default` に締められたときだけで、既定の `auto` では
   * この一覧に無くても通る。**それでも歯を打つのは、消えたことに気づくためである**
   * — 「一覧に在るから大丈夫」と読まれる規則が、黙って消えるほうが害が大きい。
   */
  it('gh pr merge は確認なしで通す一覧に在る', () => {
    expect(CLONE_ALLOWED_TOOLS).toContain('Bash(gh pr merge:*)');
  });

  /**
   * **広げていないことも測る。** `toContain` だけだと、あとから
   * `Bash(gh *)` や `Bash(*)` を足しても落ちない — 確認を*省く*のと
   * 確認を*消す*のは別の判断である（`CLONE_ALLOWED_BASH` の doc）。
   */
  it('通しているのは gh pr merge の1つだけで、Bash を広く開けていない', () => {
    const bash = CLONE_ALLOWED_TOOLS.filter((name) => name.startsWith('Bash('));
    expect(bash).toEqual(['Bash(gh pr merge:*)']);
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

  it('memory_write の日誌には action: "write" が構造として載る（文言だけに頼らない）', async () => {
    const h = harness();

    await h.call('memory_write', { slug: 'values', content: '本文', summary: '書いた' });

    const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
    expect(entry).toMatchObject({ action: 'write' });
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

  it('memory_append の日誌には action: "append" が構造として載る', async () => {
    const h = harness();

    await h.call('memory_append', { slug: 'values', content: '追記', summary: '追記した' });

    const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
    expect(entry).toMatchObject({ action: 'append' });
  });

  /**
   * `memory_delete` — 記憶の文書ごと消す口。
   *
   * `schedule_remove` は在るのに削除だけが欠けていた非対称を塞ぐ
   * （north_star 禁止1）。保証ごとに `it()` を割る。
   */
  describe('memory_delete（記憶の文書を消す）', () => {
    it('文書ごと消える（memory_list から消える。本文が空になるだけではない）', async () => {
      const h = harness();
      await h.stores.persona.write('temp-note', '# 一時的なメモ\n\n本文');

      await h.call('memory_delete', { slug: 'temp-note', summary: 'もう要らない' });

      expect(await h.stores.persona.read('temp-note')).toBeNull();
      const list = await h.stores.persona.list();
      expect(list.some((doc) => doc.slug === 'temp-note')).toBe(false);
    });

    it('存在しないスラッグは黙って成功しない', async () => {
      const h = harness();

      const reply = await h.call('memory_delete', { slug: 'nope', summary: '消したつもり' });

      expect(reply).toContain('存在しない');
      // 消したつもりで何も消えていない、を作らない — 何も変わっていないと言い切る。
      expect(reply).toMatch(/消えない|変わっていない/);
    });

    it('削除が日誌に残る（slug と消す直前の文字数）', async () => {
      const h = harness();
      const body = '# メモ\n\n' + 'あ'.repeat(42);
      await h.stores.persona.write('temp-note', body);

      await h.call('memory_delete', { slug: 'temp-note', summary: '片付け' });

      const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
      expect(entry).toMatchObject({ type: 'memory_update', slug: 'temp-note' });
      expect((entry as { summary: string }).summary).toContain(String(body.length));
    });

    it('削除の日誌に本文が写っていない', async () => {
      const h = harness();
      const secretBody = '# メモ\n\n他人に見せたくない値: SECRET-XYZ-999';
      await h.stores.persona.write('temp-note', secretBody);

      await h.call('memory_delete', { slug: 'temp-note', summary: '片付け' });

      const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
      expect((entry as { summary: string }).summary).not.toContain('SECRET-XYZ-999');
    });

    it('action: "remove" が構造として載る（文言だけに頼らない）', async () => {
      const h = harness();
      await h.stores.persona.write('temp-note', '本文');

      await h.call('memory_delete', { slug: 'temp-note', summary: '片付け' });

      const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
      expect(entry).toMatchObject({ action: 'remove' });
    });
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

  /**
   * 置き先の指名（`runnerId`）。**これは配置の指名であって本数の制限ではない**
   * ——ここで固定したいのは、道具からプールへ指名がそのまま渡ることと、
   * 実際に走った器（`started.runnerId`）が指名の有無を問わず返り値へ載ること。
   * 指名そのものの成否判定（名簿に無い・使えない・重複）は `Registry#select`
   * の責務であって、ここでは配線だけを見る（`runner-select.test.ts` が本体）。
   */
  it('manager_start に runnerId を渡すと、そのまま ManagerPool.start へ指名として届く', async () => {
    const h = harness();

    const reply = await h.call('manager_start', {
      request: 'この器で頼む',
      runnerId: 'runner-b',
    });

    expect(h.started).toEqual([{ request: 'この器で頼む', runnerId: 'runner-b' }]);
    // **指名した名前がそのまま返る。** 指名が効いたかをクローンが確かめる材料。
    expect(reply).toContain('runner-b');
  });

  it('manager_start は runnerId を指名しなくても、実際に走った runner を返す', async () => {
    const h = harness();
    h.setAutoRunnerId('runner-auto-placed');

    const reply = await h.call('manager_start', { request: '自動配置に任せる' });

    expect(reply).toContain('runner-auto-placed');
  });

  it('runnerId が取れないときは空欄にせず「未記録」と言う', async () => {
    const h = harness();
    h.setAutoRunnerId(undefined);

    const reply = await h.call('manager_start', { request: '記録が無い場合' });

    expect(reply).toContain('未記録');
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
    // **2026-08-21 に反転。** 直す前は `sessionGone === true`（止まったと確かめた）
    // でも台帳の `status` を `'done'`（＝終えて待機中）に書いていた（R2）。いまは
    // `'stopped'` という専用の終端状態を持つので、ここを反転する（PR「『止めた』を、
    // 止まったと確かめたときだけそう言う」の3点セット）。
    expect(reply).toContain('stopped');
  });

  it('manager_stop は not_stopped のとき「止めた」と言わない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.setAbortOutcome('not_stopped');

    const reply = await h.call('manager_stop', { managerId: 'mgr-1', reason: '暴走した' });

    expect(reply).toContain('止まっていない');
    // 台帳は書いていないので、まだ running のまま見える。
    expect(reply).toContain('running');
  });

  it('manager_stop は unknown のとき「止めた」とも「止まっていない」とも言い切らない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.setAbortOutcome('unknown');

    const reply = await h.call('manager_stop', { managerId: 'mgr-1', reason: '暴走した' });

    expect(reply).toContain('未確認');
  });

  it('manager_stop は absent のとき居ないと言う', async () => {
    const h = harness();

    const reply = await h.call('manager_stop', { managerId: 'mgr-nope' });

    expect(reply).toContain('居ない');
  });

  it('manager_list は状態と返事待ちを返す', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });

    const reply = await h.call('manager_list', {});
    expect(reply).toContain('mgr-1');
    expect(reply).toContain('running');
  });

  it('manager_list は runnerId を出す（未記録なら空欄にせずそう言う）', async () => {
    const h = harness();
    h.setAutoRunnerId('runner-shown');
    await h.call('manager_start', { request: 'A' });
    h.setAutoRunnerId(undefined);
    await h.call('manager_start', { request: 'B' });

    const reply = await h.call('manager_list', {});

    expect(reply).toContain('runner-shown');
    expect(reply).toContain('未記録');
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
 * `runner_list`——「コンテナがいくつあって、どこで何をいくつ動かしているかを
 * クローンが把握できるようにする」の「見る」側。
 *
 * `ManagerPool.runners()` 自体の数え方（本数・unassigned への分離）の固定は
 * `manager.test.ts` に置く。ここで固定したいのは、その結果をクローンへ返す
 * **文言**の側——5値を畳んでいないか、既定で指紋を出していないか、1台のときに
 * 「分散していない」と読める1行があるか、である。
 */
describe('runner_list（器の一覧）', () => {
  it('登録が0台のときも「0台である」と言う（空の出力にしない）', async () => {
    const h = harness();
    h.setRunnersOverview({ runners: [], unassigned: [], daemonRevision: { status: 'unknown' } });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('0台');
  });

  it('器が1台のときは「分散していない」と読める1行が入る', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-only',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-only',
          managers: [],
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('1台のみ');
    expect(reply).toContain('分散していない');
  });

  it('器が複数台のときも形が崩れない（分散していないとは言わない）', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [{ managerId: 'mgr-1', status: 'running' }],
        },
        {
          label: 'runner-b',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-b',
          managers: [],
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('runner-a');
    expect(reply).toContain('runner-b');
    expect(reply).not.toContain('分散していない');
  });

  it('state の5値をそのまま出す（connected へ畳まない）', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'a',
          revision: { status: 'unheard' },
          state: 'connecting',
          since: '2026-01-01T00:00:00.000Z',
          managers: [],
        },
        {
          label: 'b',
          revision: { status: 'unheard' },
          state: 'unreachable',
          since: '2026-01-01T00:00:00.000Z',
          managers: [],
        },
        {
          label: 'c',
          revision: { status: 'unheard' },
          state: 'unusable',
          since: '2026-01-01T00:00:00.000Z',
          managers: [],
        },
        {
          label: 'd',
          revision: { status: 'unheard' },
          state: 'lost',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-d',
          managers: [],
        },
        {
          label: 'e',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-e',
          managers: [],
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    for (const state of ['connecting', 'unreachable', 'unusable', 'lost', 'connected']) {
      expect(reply).toContain(`[${state}]`);
    }
  });

  it('器ごとのマネージャー本数を出す', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [
            { managerId: 'mgr-1', status: 'running' },
            { managerId: 'mgr-2', status: 'done' },
          ],
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).toContain('mgr-1');
    expect(reply).toContain('mgr-2');
    expect(reply).toContain('(2)');
  });

  it('runnerId の無いマネージャーを、どの器にも混ぜず別枠で出す', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
        },
      ],
      unassigned: [{ managerId: 'mgr-legacy', status: 'done' }],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    // **runner-a の内訳（マネージャー: 無し）に紛れ込んでいない。**
    expect(reply).toContain('どの器か分からない');
    expect(reply).toContain('mgr-legacy');
  });

  /**
   * 指紋（鍵・プロファイルの sha256）は**既定で出さない**。
   *
   * この歯は「出ない」ことの歯なので、まず検出器が非0を出せることを示す
   * （変異試験の要求：意図的に出す実装にしたら落ちる形になっていること）。
   * その確認は、次の「引数を渡せば指紋が出る」テストが兼ねる——同じ
   * `setRunnersOverview` の入力に対して、引数の有無だけで出力が変わることを
   * 2本のテストの対で示す。
   */
  it('引数を渡さなければ指紋を出さない（既定で文脈へ載せない）', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
          credentials: [
            { name: 'GITHUB_TOKEN', sha256: 'deadbeef0000', updatedAt: '2026-01-01T00:00:00.000Z' },
          ],
          profile: { sha256: 'cafef00dbabe', bytes: 12, updatedAt: '2026-01-01T00:00:00.000Z' },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', {});

    expect(reply).not.toContain('deadbeef0000');
    expect(reply).not.toContain('cafef00dbabe');
    // **道具からプールへは何も渡らない**（既定）。
    expect(h.runnersCalls).toEqual([{}]);
  });

  it('fingerprints: true を渡すと指紋が出る（方針は設定で開けられる）', async () => {
    const h = harness();
    h.setRunnersOverview({
      runners: [
        {
          label: 'runner-a',
          revision: { status: 'unheard' },
          state: 'connected',
          since: '2026-01-01T00:00:00.000Z',
          runnerId: 'runner-a',
          managers: [],
          credentials: [
            { name: 'GITHUB_TOKEN', sha256: 'deadbeef0000', updatedAt: '2026-01-01T00:00:00.000Z' },
          ],
          profile: { sha256: 'cafef00dbabe', bytes: 12, updatedAt: '2026-01-01T00:00:00.000Z' },
        },
      ],
      unassigned: [],
      daemonRevision: { status: 'unknown' },
    });

    const reply = await h.call('runner_list', { fingerprints: true });

    expect(reply).toContain('deadbeef0000');
    expect(reply).toContain('cafef00dbabe');
    expect(h.runnersCalls).toEqual([{ fingerprints: true }]);
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

/**
 * `manager_transcript` — 可観測性の最下段（セッションそのものの生ログ）。
 *
 * **`manager_report` に `part: 'transcript'` を足す形にしなかった理由**は
 * 実装側のコメントに書いた（`null` の意味が違う・大きさの桁が違う・契約が
 * 2つになる）。ここではその実物を保証ごとに1本ずつ確かめる。
 */
describe('manager_transcript（生ログへ降りる）', () => {
  it('生ログの全文へ降りられる（lastReport の抜粋ではなく transcript() の中身が返る）', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    for (const summary of h.running)
      summary.lastReport = '要約された最終報告（これは生ログではない）';
    h.setTranscript('mgr-1', '{"type":"user","text":"生ログにしか無い中身"}');

    const reply = await h.call('manager_transcript', { managerId: 'mgr-1' });

    expect(reply).toContain('生ログにしか無い中身');
    expect(reply).not.toContain('要約された最終報告');
  });

  it('切ったことが呼び手に届く', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    const body = 'x'.repeat(9_000);
    h.setTranscript('mgr-1', body);
    // **`lastReport` にも同じ内容を置いておく。** この保証（切ったら黙らない）は
    // 「本文がどこから来たか」（それは別の歯が守る）とは独立に測りたいので、
    // 本文の出所を差し替える変異が紛れ込んでも実害が出ないようにしてある。
    for (const summary of h.running) summary.lastReport = body;

    const reply = await h.call('manager_transcript', { managerId: 'mgr-1' });

    expect(reply).toMatch(/省略|文字目/);
    expect(reply).toContain('ここで切れている');
    expect(reply).toContain('offset');
  });

  it('offset で続きが取れる', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    // **`offset` の指定は 8,000（`TRANSCRIPT_PAGE`）を直接使う。** 前の応答の
    // 「続きの取り方」の文言から offset を抜き出す形にすると、この保証が
    // tail の文言（テスト2が守る対象）に依存してしまい、2つの歯が分離しなく
    // なる（tail を黙らせる変異が offset のテストまで巻き込んで倒す）。
    const body = `${'a'.repeat(8_000)}TAIL-MARK`;
    h.setTranscript('mgr-1', body);
    // 同じ理由で lastReport にも同じ内容を置く（上のテストのコメント参照）。
    for (const summary of h.running) summary.lastReport = body;

    const first = await h.call('manager_transcript', { managerId: 'mgr-1' });
    expect(first).not.toContain('TAIL-MARK');

    const second = await h.call('manager_transcript', {
      managerId: 'mgr-1',
      offset: 8_000,
    });
    expect(second).toContain('TAIL-MARK');
  });

  it('3段のどこにも無いとき「無い」と言う（黙って空を返さない）', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    // setTranscript しない＝走行中の runner・退避済みアーカイブ・預かった
    // セッションの生ログ、3段のどこにも無い状態を模す。

    const reply = await h.call('manager_transcript', { managerId: 'mgr-1' });

    expect(reply.length).toBeGreaterThan(0);
    expect(reply).toContain('無い');
    expect(reply).toMatch(/runner/);
    expect(reply).toMatch(/アーカイブ/);
  });

  it('manager_report の出力から生ログへの降り方が読める', async () => {
    const h = harness();
    await h.call('manager_start', { request: '調べて' });
    for (const summary of h.running) summary.lastReport = '短い報告';

    const reply = await h.call('manager_report', { managerId: 'mgr-1' });

    expect(reply).toContain('manager_transcript');
  });
});

/**
 * 状態の表示が、**観測していないことまで語らない**こと。
 *
 * ここで固定しているのは「何を言うか」ではなく「**何を言わないか**」である。
 * デーモンが観測できるのは限られている（セッションへ戻れたか / 拒否があったか /
 * マネージャーのターンが終わったか）のに、文言はその先まで — 仕事が失われた、
 * 走っている、走っている手は無い — と断定していた。断定は静かに間違う。
 */
describe('一覧の文言は、観測した分しか言わない', () => {
  /**
   * **実際に起きた誤りをそのまま置いてある。**
   *
   * 2026-08-16T03:15 に落ちたマネージャーは、その直前に PR #59 を出し、CI を
   * 通し、マージまで届いていた。1分半後に器が作り直されて `lost` になり、
   * 一覧は「この仕事は途中で失われている（完了ではない）」と言った。
   * デーモンは PR を見ていないのだから、これは観測ではなく推測だった。
   */
  it('lost に「完了ではない」と書かない（成果の有無は観測していない）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'PR を出して' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.status = 'lost';
    target.live = false;

    const reply = await h.call('manager_list', {});

    // 断定へ戻したら、ここで落ちる。
    expect(reply).not.toContain('途中で失われている');
    expect(reply).not.toContain('完了ではない');
    // 観測した分（戻れなかった）は言い切る。
    expect(reply).toContain('戻れなかった');
    // **次の一手を渡す。** 「断定をやめる」だけだと、読んだ側は結局
    // 起こし直すか放置するかを勘で決めることになる。
    expect(reply).toMatch(/リモート|PR/);
    expect(reply).toContain('確かめ');
  });

  /**
   * **PR #42 の分け方は保つ。** 断定を外したせいで `lost` が `done`（終えて
   * 待っている）と同じ顔になったら、失われた仕事が黙って片付く方の欠陥へ戻る。
   */
  it('lost は done と混ざらない（起こし直す対象として見分けられる）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    await h.call('manager_start', { request: 'B' });
    const [lost, done] = h.running;
    if (!lost || !done) throw new Error('準備に失敗');
    lost.status = 'lost';
    lost.live = false;
    done.status = 'done';

    const reply = await h.call('manager_list', {});
    const lostEntry = reply.slice(reply.indexOf('mgr-1'), reply.indexOf('mgr-2'));
    const doneEntry = reply.slice(reply.indexOf('mgr-2'));

    expect(lostEntry).toContain('⚠');
    expect(lostEntry).toContain('manager_start');
    // done 側には「起こし直せ」の案内が付かない（話しかければ続く）。
    expect(doneEntry).not.toContain('⚠');
  });

  /**
   * **`running` は「動いている」ではない。**
   *
   * 分類器か deny 規則がその場で拒否すると、その仕事は `running` のまま手が
   * 止まる。それが日誌と（繰り返したときだけ）受信箱にしか出ておらず、一覧を
   * 見ているクローンには「走っている」としか読めなかった。
   */
  it('拒否で手が止まっていることが、状態に添えて一覧に出る', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.denied.set('mgr-1', [
      { tool: 'Bash', count: 4 },
      { tool: 'Write', count: 1 },
    ]);

    const reply = await h.call('manager_list', {});

    // 状態の値そのものは動かさない（`openapi.json` の外向きの面を触らない）。
    expect(reply).toContain('[running]');
    expect(reply).toContain('Bash 4件');
    expect(reply).toContain('Write 1件');
    // **なぜ一覧に出す必要があったのか**まで書く（クローンには回っていない）。
    expect(reply).toContain('クローンには回ってきていない');
    expect(reply).toContain('journal_read');
  });

  it('拒否が無いマネージャーには何も足さない（雑音にしない）', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });

    const reply = await h.call('manager_list', {});

    expect(reply).not.toContain('止められた道具');
  });

  it('拒否の種類が多くても一覧を食い潰さず、切ったことを言う', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    h.denied.set(
      'mgr-1',
      Array.from({ length: 7 }, (_, index) => ({ tool: `tool-${index}`, count: index + 1 })),
    );

    const reply = await h.call('manager_list', {});

    // 新しい側（末尾）から3種。
    expect(reply).toContain('tool-6 7件');
    expect(reply).toContain('tool-4 5件');
    expect(reply).not.toContain('tool-3');
    // 黙って落とさない。
    expect(reply).toContain('ほか 4 種');
    expect(reply).toContain('全 28 件');
  });

  /**
   * **`done` は「マネージャー自身のターンが終わった」でしかない。**
   *
   * その下で作業者が走っているかは、デーモンには見えていない（作業者の生存も
   * worktree の更新時刻も、ここからは読めない）。「走っている手は無く」は
   * 観測ではなく推測だった。
   */
  it('done を畳んだときに「走っている手は無い」と断定しない', async () => {
    const h = harness();
    await h.call('manager_start', { request: 'A' });
    const target = h.running[0];
    if (!target) throw new Error('準備に失敗');
    target.status = 'done';

    const reply = await h.call('manager_stop', { managerId: 'mgr-1' });

    expect(reply).toContain('待機中（done）');
    // 断定へ戻したら、ここで落ちる。
    expect(reply).not.toContain('走っている手は無く');
    expect(reply).toContain('作業者');
    expect(reply).toContain('見えていない');
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
      layer: 'manager',
      site: 'session',
      accumulation: 'cumulative',
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

describe('usage_read の5軸と、打ち切りから続きへ辿る道', () => {
  const one = (costUsd: number) => ({
    'claude-opus-5': {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd,
    },
  });

  async function record(
    h: Harness,
    over: {
      layer: 'clone' | 'manager';
      site: 'session' | 'distill';
      managerId: string;
      costUsd: number;
      date?: string;
    },
  ) {
    await h.stores.usage.record({
      layer: over.layer,
      site: over.site,
      accumulation: over.site === 'distill' ? 'oneshot' : 'cumulative',
      managerId: over.managerId,
      date: over.date ?? '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: { models: one(over.costUsd) },
    });
  }

  it('層と場所の軸を出す（モデル名では層を見分けられない）', async () => {
    // 2件とも同じモデル id である。`ALTEROID_CLONE_MODEL` を置けば実際にこうなる。
    const h = harness();
    await record(h, { layer: 'manager', site: 'session', managerId: 'mgr-1', costUsd: 2 });
    await record(h, { layer: 'clone', site: 'distill', managerId: 'clone', costUsd: 0.5 });

    const reply = await h.call('usage_read', {});

    expect(reply).toContain('層別（誰が）:');
    expect(reply).toContain('場所別（どこで）:');
    expect(reply).toContain('manager: $2.00');
    expect(reply).toContain('clone: $0.5000');
    expect(reply).toContain('distill: $0.5000');
  });

  it('層で絞れる（4つの口に同じ絞り込みがある）', async () => {
    const h = harness();
    await record(h, { layer: 'manager', site: 'session', managerId: 'mgr-1', costUsd: 2 });
    await record(h, { layer: 'clone', site: 'session', managerId: 'clone', costUsd: 0.5 });

    const onlyClone = await h.call('usage_read', { layer: 'clone' });

    expect(onlyClone).toContain('合計 $0.5000');
    expect(onlyClone).not.toContain('mgr-1');
  });

  it('場所で絞れる', async () => {
    const h = harness();
    await record(h, { layer: 'clone', site: 'session', managerId: 'clone', costUsd: 2 });
    await record(h, { layer: 'clone', site: 'distill', managerId: 'clone', costUsd: 0.5 });

    const onlyDistill = await h.call('usage_read', { site: 'distill' });

    expect(onlyDistill).toContain('合計 $0.5000');
  });

  it('打ち切ったら、続きの取り方をその行に書く（「残り N 件」で終わらせない）', async () => {
    // **黙って切り捨てない**うえに、**続きへ辿れないことも作らない。**
    const h = harness();
    for (let i = 0; i < 20; i += 1) {
      await record(h, {
        layer: 'manager',
        site: 'session',
        managerId: `mgr-${String(i).padStart(2, '0')}`,
        costUsd: 20 - i,
      });
    }

    const reply = await h.call('usage_read', {});

    expect(reply).toContain('残り 6 件は出していない');
    expect(reply).toContain('axis="manager", offset=14 で続きが出る');
  });

  it('axis を指定すると、その軸だけを offset から出す', async () => {
    const h = harness();
    for (let i = 0; i < 20; i += 1) {
      await record(h, {
        layer: 'manager',
        site: 'session',
        managerId: `mgr-${String(i).padStart(2, '0')}`,
        costUsd: 20 - i,
      });
    }

    const reply = await h.call('usage_read', { axis: 'manager', offset: 14 });

    // まとめ表示の先頭14件と続きが重ならない（同じ並びを1か所で決めている）。
    expect(reply).toContain('mgr-14');
    expect(reply).toContain('mgr-19');
    expect(reply).not.toContain('mgr-13');
    // 他の軸もアカウント全体の残りも出さない（続きを辿るたびに全体が返らない）。
    expect(reply).not.toContain('日別');
    expect(reply).not.toContain('アカウント全体の残り');
  });

  it('offset が範囲外でも黙って空を返さない', async () => {
    // 空の一覧だけでは「この軸には記録が無い」と「offset が範囲外」を区別できない。
    const h = harness();
    await record(h, { layer: 'manager', site: 'session', managerId: 'mgr-1', costUsd: 1 });

    const reply = await h.call('usage_read', { axis: 'manager', offset: 99 });

    expect(reply).toContain('全 1 件で、offset=99 以降は無い');
  });

  it('層の軸の始点を台帳の始点と混ぜない', async () => {
    const h = harness();
    await record(h, { layer: 'manager', site: 'session', managerId: 'mgr-1', costUsd: 1 });

    const reply = await h.call('usage_read', { from: '2020-01-01' });

    expect(reply).toContain('層と場所の軸の始点: 2026-08-14');
    expect(reply).toContain('既定値であって観測ではない');
  });
});

describe('usage_read はアカウント全体の残りも返す（人間と同じものを見せる）', () => {
  function withAccount(accountUsage: () => AccountUsageState) {
    const stores = createMemoryStores();
    const tools = createCloneTools({ stores, emit: () => undefined, accountUsage });
    return async (args: Record<string, unknown> = {}) => {
      const found = tools.find((t) => t.name === 'usage_read');
      const result = await found!.handler(args as never, {} as never);
      return result.content.map((part) => ('text' in part ? part.text : '')).join('\n');
    };
  }

  it('まだ取っていないときは「0」ではなく「分からない」と言う', async () => {
    const call = withAccount(() => ({ state: 'unknown' }));
    const reply = await call();
    expect(reply).toContain('まだ取りに行っていない');
    expect(reply).toContain('0 ではなく');
  });

  it('取れなかったときは理由を出す（0% と描かない）', async () => {
    const call = withAccount(() => ({
      state: 'failed',
      at: '2026-08-14T10:00:00.000Z',
      reason: '2つの口のどちらも答えなかった',
    }));
    const reply = await call();
    expect(reply).toContain('取れなかった');
    expect(reply).toContain('0 ではなく');
    expect(reply).not.toContain('0%');
  });

  it('この構成では取れないときは、そう言う', async () => {
    const call = withAccount(() => ({
      state: 'unavailable',
      at: '2026-08-14T10:00:00.000Z',
      reason: 'claude.ai にログインしていない（鍵が届けば取れる）',
    }));
    expect(await call()).toContain('ログインしていない');
  });

  it('枠と支出上限を出す', async () => {
    const call = withAccount(() => ({
      state: 'ok',
      usage: {
        at: '2026-08-14T10:00:00.000Z',
        plan: 'Claude Max',
        limitsAvailable: true,
        windows: [
          { kind: 'five_hour', utilization: 42, resetsAt: Date.parse('2026-08-14T13:00:00.000Z') },
        ],
        extraUsage: {
          enabled: true,
          monthlyLimit: 100,
          usedCredits: 40,
          utilization: 40,
          currency: 'USD',
        },
      },
    }));
    const reply = await call();
    expect(reply).toContain('Claude Max');
    expect(reply).toContain('42% 使用');
    expect(reply).toContain('40 USD / 100 USD');
  });

  it('使用率が付かない枠を 0% と書かない', async () => {
    // `five_hour` には utilization が付かないことがある（実測）。
    const call = withAccount(() => ({
      state: 'ok',
      usage: {
        at: '2026-08-14T10:00:00.000Z',
        plan: 'Claude Team',
        limitsAvailable: true,
        windows: [{ kind: 'five_hour', resetsAt: Date.parse('2026-08-14T13:00:00.000Z') }],
      },
    }));
    const reply = await call();
    expect(reply).toContain('使用率は取れなかった');
    expect(reply).not.toContain('0% 使用');
  });

  it('枠が来なかったら「0%」ではなく「取れなかった」', async () => {
    // `rate_limits_available: true` でも `rate_limits: null` があり得る（実測）。
    const call = withAccount(() => ({
      state: 'ok',
      usage: {
        at: '2026-08-14T10:00:00.000Z',
        plan: 'Claude Team',
        limitsAvailable: true,
        windows: [],
      },
    }));
    const reply = await call();
    expect(reply).toContain('枠: 取れなかった');
    expect(reply).toContain('0% ではない');
  });

  it('支出上限が取れないことを黙らない（残額が分からないと言う）', async () => {
    const call = withAccount(() => ({
      state: 'ok',
      usage: {
        at: '2026-08-14T10:00:00.000Z',
        plan: 'Claude Max',
        limitsAvailable: true,
        windows: [{ kind: 'five_hour', utilization: 10 }],
      },
    }));
    const reply = await call();
    expect(reply).toContain('支出上限: 取れなかった');
    expect(reply).toContain('残額は分からない');
  });

  it('通貨が分からないときは金額として整形しない（嘘の単位を名乗らない）', async () => {
    const call = withAccount(() => ({
      state: 'ok',
      usage: {
        at: '2026-08-14T10:00:00.000Z',
        plan: 'Claude Max',
        limitsAvailable: true,
        windows: [],
        extraUsage: { enabled: true, monthlyLimit: 100, usedCredits: 40, utilization: 40 },
      },
    }));
    const reply = await call();
    expect(reply).toContain('単位不明');
    expect(reply).not.toContain('$40');
  });
});

/**
 * `self_status`（いま自分がどう走っているか）。
 *
 * **`CloneRuntimeFacts` の整形そのものは self.test.ts が確かめる。** ここで見るのは
 * tools.ts 側だけの仕事 — その場で読み直す記憶の大きさと、台帳との突き合わせが、
 * `stores` の実物と正しく噛み合っているか。
 */
describe('self_status（いま自分がどう走っているか）', () => {
  const RUNTIME: CloneRuntimeFacts = {
    declaredModel: 'fable',
    modelOverridden: false,
    modelEnvKey: 'ALTEROID_CLONE_MODEL',
    sdkModel: null,
    effort: null,
    requestedEffort: null,
    claudeCodeVersion: null,
    apiKeySource: null,
    permissionMode: null,
    requestedPermissionMode: 'auto',
    mcpServers: [],
    sessionId: null,
    resumedFrom: null,
    // **意図的に、以下で書き込む記憶の総文字数とは違う値にしてある。** 「いまの
    // 総文字数」と区別できることを見るための固定値であって、実際の構築時の値を
    // 模したものではない。
    injectedMemoryChars: 3,
    systemPromptChars: 999,
  };

  it('道具として配られている（クローンから見えないものを作らない）', () => {
    expect(CLONE_ALLOWED_TOOLS).toContain(qualifiedToolName('self_status'));
  });

  it('runtime を渡していない場面（蒸留のサイドクエリを模した形）では、落ちずに読めないと返す', async () => {
    const tools = createCloneTools({ stores: createMemoryStores(), emit: () => undefined });
    const found = tools.find((entry) => entry.name === 'self_status');
    if (!found) throw new Error('self_status が無い');
    const result = await found.handler({} as never, {});
    const body = (result.content ?? []).map((part) => ('text' in part ? part.text : '')).join('');
    expect(body).toContain('読めない場面');
  });

  it('記憶の文書数といまの総文字数が出る。焼き込んだ時点の文字数とは別々に出る', async () => {
    const h = harness(() => RUNTIME);
    await h.call('memory_write', {
      slug: 'values',
      content: '# 価値観\n\n人間が手で書いた方針',
      summary: '書いた',
    });
    await h.call('memory_write', {
      slug: 'habits',
      content: '# 習慣\n\n毎朝記憶を見直す',
      summary: '書いた',
    });
    const totalMemory = renderMemoryDocuments(await h.stores.persona.documents());
    expect(totalMemory.length).not.toBe(RUNTIME.injectedMemoryChars);

    const reply = await h.call('self_status', {});

    expect(reply).toContain('2 文書');
    expect(reply).toContain(`${totalMemory.length.toLocaleString('en-US')} 文字`);
    // 焼き込んだ時点の文字数（固定値 3）が、いまの総文字数とは別の行として出る。
    expect(reply).toContain('焼き込んだ記憶の文字数（このセッションを組み立てた時点）: 3 文字');
  });

  it('記憶を書き換えたあとに呼んでも、いまの総文字数は読み直した値が出る', async () => {
    const h = harness(() => RUNTIME);
    await h.call('memory_write', { slug: 'values', content: '# 価値観\n\n最初の版', summary: '1' });
    await h.call('self_status', {}); // 1回目（内容は見ない。副作用が無いことの前提づくり）

    await h.call('memory_write', {
      slug: 'values',
      content: '# 価値観\n\n書き換えた後のもっと長い方針の本文',
      summary: '2',
    });
    const totalMemory = renderMemoryDocuments(await h.stores.persona.documents());

    const reply = await h.call('self_status', {});

    expect(reply).toContain(`${totalMemory.length.toLocaleString('en-US')} 文字`);
    // 焼き込んだ時点（固定値 3）は書き換えても動かない — 別の軸であることの確認。
    expect(reply).toContain('組み立てた時点）: 3 文字');
  });

  it('鍵・トークンの値を出さない（profile_write で置いた値が self_status に出ない）', async () => {
    const h = harness(() => RUNTIME);
    await h.call('profile_write', {
      script: 'export SOME_API_TOKEN=super-secret-value-000',
      summary: 'トークンを実行環境へ移した',
    });

    const reply = await h.call('self_status', {});

    expect(reply).not.toContain('super-secret-value-000');
  });

  it('SDK モデル id がまだ分からなければ、突き合わせをせずそう言う', async () => {
    const h = harness(() => RUNTIME); // sdkModel: null

    const reply = await h.call('self_status', {});

    expect(reply).toContain('まだ init を観測していない');
  });

  it('台帳に同じモデル id の行があれば、その managerId が出る（軸: 日 × マネージャー × モデル）', async () => {
    const models = {
      'claude-fable-9000': {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUsd: 1.5,
      },
    };
    const h = harness(() => ({ ...RUNTIME, sdkModel: 'claude-fable-9000' }));
    await h.stores.usage.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'cumulative',
      managerId: 'mgr-7',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: { models },
    });

    const reply = await h.call('self_status', {});

    expect(reply).toContain('claude-fable-9000');
    expect(reply).toContain('managerId: "mgr-7"');
    // 「載っている／いない」という断定ではなく、軸（managerId 付きの行）を出す。
    expect(reply).not.toMatch(/あなたの消費が(台帳に)?載って/);
  });

  it('同じモデル id の行が無ければ、そう言う（0 件と嘘をつかない）', async () => {
    const h = harness(() => ({ ...RUNTIME, sdkModel: 'claude-fable-9000' }));
    await h.stores.usage.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'cumulative',
      managerId: 'mgr-1',
      date: '2026-08-14',
      at: '2026-08-14T10:00:00.000Z',
      snapshot: {
        models: {
          'claude-other-model': {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUsd: 1,
          },
        },
      },
    });

    const reply = await h.call('self_status', {});

    expect(reply).toContain('同じ行は無い');
  });
});

/**
 * `journalEntrySchema` の `memory_update.action` は **optional** で足した。
 *
 * 「書いた」と「消した」の区別がこれまで `summary` の自由文にしか無かった
 * （PR #144 で潰したのと同じ形の欠陥）ので機械可読な区別を足すが、optional に
 * したのは既存の日誌エントリを1件も壊さないためである。ここではその意味
 * そのもの——`action` の無いエントリが今も通ること——を固定する。
 */
describe('journalEntrySchema の memory_update（action の後方互換）', () => {
  it('action の無い既存エントリ（action 導入前の形）が今も通る', () => {
    const legacy = {
      type: 'memory_update' as const,
      id: 'j-1',
      at: '2026-08-01T00:00:00.000Z',
      slug: 'values',
      cause: 'human' as const,
      summary: '古い形式のエントリ（action フィールドが無い）',
    };

    const result = journalEntrySchema.safeParse(legacy);

    expect(result.success).toBe(true);
  });

  it('action を付けたエントリも通り、値がそのまま読める', () => {
    const withAction = {
      type: 'memory_update' as const,
      id: 'j-2',
      at: '2026-08-01T00:00:00.000Z',
      slug: 'values',
      cause: 'clone' as const,
      action: 'remove' as const,
      summary: '削除の記録',
    };

    const result = journalEntrySchema.safeParse(withAction);

    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'memory_update') {
      expect(result.data.action).toBe('remove');
    }
  });
});

/**
 * **道具を足したら、システムプロンプトの道具一覧（`prompt.ts` の「# 道具」）にも載せる。**
 *
 * 関数呼び出しのスキーマ（`allowedTools`）に載っていれば呼べはするが、クローンが
 * 「そういう道具がある」と自分で気づく手がかりは一覧にしかない。載せ忘れると、
 * 能力はあるのに使われない道具ができる（`self_status` を足したときに実際に
 * 載せ忘れた）。ここは載せ忘れが**静かに通る**形の失敗なので、仕組みで塞ぐ。
 */
describe('システムプロンプトの道具一覧', () => {
  it('CLONE_TOOL_NAMES の全部が載っている（一覧に無い道具を作らない）', () => {
    const prompt = buildCloneSystemPrompt({ memory: '' });
    const section = prompt.split('# 道具')[1]?.split('# 委譲')[0];
    // 節そのものが見つからなければ、下の照合は全部「載っていない」に倒れる。
    // **その状態を「一覧が空だった」と読み替えないこと**（節の名前を変えたなら
    // ここも直す、が正しい振る舞いである）。
    expect(section).toBeDefined();
    const missing = CLONE_TOOL_NAMES.filter((name) => !(section ?? '').includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });
});
