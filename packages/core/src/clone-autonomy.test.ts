import { describe, it, expect } from 'vitest';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { EXCHANGE_KIND_REPLY_PREFIX } from './exchange-kind.js';
import type { ManagerPool, ManagerSummary } from './manager.js';
import { measureMemoryFloor } from './memory.js';
import { createScheduler } from './schedule.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, setup, waitFor, waitForExpect, waitForTerminal } from './clone-test-harness.js';
import type { Setup } from './clone-test-harness.js';

describe('クローン — 自律（人間以外の起点）', () => {
  const inputsOf = (s: Setup) => () => (s.calls[0]?.inputs ?? []).join('\n');

  async function selfInitiativeCauseLines(s: Setup): Promise<string[]> {
    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      text: string;
    }[];
    return exchanges
      .filter((e) => e.with === 'self' && e.text.startsWith('ターンの入力: self_initiative'))
      .map((e) => e.text.match(/cause=\S+/)?.[0] ?? 'cause=(無し)');
  }

  async function dailyReportCauseLines(s: Setup): Promise<string[]> {
    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      text: string;
    }[];
    return exchanges
      .filter((e) => e.with === 'self' && e.text.startsWith('ターンの入力: daily_report'))
      .map((e) => e.text.match(/cause=\S+/)?.[0] ?? 'cause=(無し)');
  }

  it('発意 tick で、人間が黙っていても自分の判断が動く（起点④）', async () => {
    const s = setup(() => '今回は動かない');

    s.clone.post({
      type: 'self_initiative',
      id: 'evt-self',
      at: new Date().toISOString(),
      reason: '定期 tick',
    });

    await waitFor(
      () => inputsOf(s)().includes('次にやることがあるか'),
      '『次にやることがあるか』という問いかけが入力に届く',
    );
    expect(s.events).toEqual([]);
    expect(await selfInitiativeCauseLines(s)).toEqual(['cause=schedule']);

    await s.clone.stop();
  });

  it('取りこぼしを拾った発意 tick は、日誌に cause=schedule_catchup として残る', async () => {
    const s = setup(() => '取りこぼしを拾って動いた');

    s.clone.post({
      type: 'self_initiative',
      id: 'evt-self-catchup',
      at: new Date().toISOString(),
      reason: '定期 tick',
      cause: 'schedule_catchup',
    });

    await waitFor(
      () => inputsOf(s)().includes('次にやることがあるか'),
      '『次にやることがあるか』という問いかけが入力に届く',
    );
    expect(await selfInitiativeCauseLines(s)).toEqual(['cause=schedule_catchup']);

    await s.clone.stop();
  });

  it('手で起こした（/run self_initiative）発意 tick は、日誌に cause=manual として残る', async () => {
    const s = setup(() => '手で起こされて動いた');

    s.clone.post({
      type: 'self_initiative',
      id: 'evt-self-manual',
      at: new Date().toISOString(),
      reason: '定期 tick',
      cause: 'manual',
    });

    await waitFor(
      () => inputsOf(s)().includes('次にやることがあるか'),
      '『次にやることがあるか』という問いかけが入力に届く',
    );
    expect(await selfInitiativeCauseLines(s)).toEqual(['cause=manual']);

    await s.clone.stop();
  });

  it('発意 tick の要約に ManagerPool の liveness が渡る（#5243d633）', async () => {
    const { fn, calls } = fakeSdk(() => '今回は動かない');
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    await stores.jobs.putJob({
      id: 'mgr-alive',
      createdAt: now,
      updatedAt: now,
      status: 'running',
      summary: '生きている仕事',
      request: '生きている仕事',
    });
    await stores.jobs.putJob({
      id: 'mgr-dead',
      createdAt: now,
      updatedAt: now,
      status: 'running',
      summary: 'セッションが切れた仕事',
      request: 'セッションが切れた仕事',
    });

    const summaryOf = (managerId: string, live: boolean): ManagerSummary => ({
      managerId,
      status: 'running',
      live,
      cwd: '/work',
      request: '仕事',
      startedAt: now,
      updatedAt: now,
      waiting: [],
    });
    const pool: ManagerPool = {
      start: () => {
        throw new Error('not implemented');
      },
      send: () => {
        throw new Error('not implemented');
      },
      abort: () => {
        throw new Error('not implemented');
      },
      list: () => Promise.resolve([summaryOf('mgr-alive', true), summaryOf('mgr-dead', false)]),
      denials: () => [],
      pushHealthOf: () => undefined,
      runnerBacklog: () => [],
      runnerIdOf: () => Promise.resolve(undefined),
      runners: () => {
        throw new Error('not implemented');
      },
      transcript: () => {
        throw new Error('not implemented');
      },
      unpushedWork: () => {
        throw new Error('not implemented');
      },
      runningManagerOwning: () => undefined,
      restore: () => Promise.resolve([]),
      resumeStoppedByUsage: () => Promise.resolve([]),
      reattachRunner: () => Promise.resolve(),
      relocateFrom: () => {
        throw new Error('not implemented');
      },
      vacate: () => {
        throw new Error('not implemented');
      },
      probeTurnEnds: () => Promise.resolve(),
      flushWithheldReports: () => Promise.resolve(),
      settleStalledUsageWakes: () => Promise.resolve([]),
      renotifyStalledDenials: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    };

    const clone = createClone({
      stores,
      queryFn: fn,
      managers: pool,
      redeliveryGate: ALWAYS_REDELIVER,
    });

    clone.post({
      type: 'self_initiative',
      id: 'evt-self-liveness',
      at: new Date().toISOString(),
      reason: '定期 tick',
    });

    const inputs = () => (calls[0]?.inputs ?? []).join('\n');
    await waitFor(
      () => inputs().includes('mgr-alive') && inputs().includes('mgr-dead'),
      '『mgr-alive』と『mgr-dead』の両方が入力に届く',
    );

    const text = inputs();
    expect(text).toContain('mgr-alive [running]');
    expect(text).toContain('mgr-dead [running/セッション切断]');

    await clone.stop();
  });

  describe('記憶の床（tick の digest 先頭、#553 F2）', () => {
    const noteWithSummary = (summaryChars: number) =>
      `---\ndescription: ${'a'.repeat(summaryChars)}\n---\n\n# Note\n\n本文\n`;

    it('発意 tick の digest の先頭に床の行が在り、基準未確立・前回tick無しを言う', async () => {
      const s = setup(() => '今回は動かない');

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-floor-first',
        at: new Date().toISOString(),
        reason: '定期 tick',
      });

      await waitFor(
        () => inputsOf(s)().includes('以下は直近の状況である。'),
        '日報の『以下は直近の状況である。』が入力に届く',
      );

      const text = inputsOf(s)();
      expect(text).toContain('以下は直近の状況である。\n\n記憶の床:');
      expect(text).toContain('基準がまだ無いので線の判定は出せない。');
      expect(text).toContain(
        '前回の tick が無いので差分は出せない（このプロセスでの最初の tick）。',
      );

      await s.clone.stop();
    });

    it('定期ジョブ（timer）にも床の行が載るが、日報（daily_report）には載らない', async () => {
      const stores = createMemoryStores();
      await stores.schedules.put({
        kind: 'issue-round',
        spec: { type: 'daily' as const, at: '09:00' },
        request: '何かする',
        createdAt: '2026-08-11T00:00:00.000Z',
        updatedAt: '2026-08-11T00:00:00.000Z',
      });
      const s = setup(() => '見た', stores);
      const call = () => s.calls[0];

      s.clone.post({
        type: 'timer',
        id: 'evt-timer-floor',
        at: '2026-08-12T00:00:00.000Z',
        kind: 'issue-round',
      });
      await waitFor(
        () => call()?.inputs.some((input) => input.includes('何かする')) ?? false,
        '『何かする』を含む入力が届く',
      );
      expect(call()?.inputs.at(-1)).toContain('以下は直近の状況である。\n\n記憶の床:');

      s.clone.post({
        type: 'timer',
        id: 'evt-timer-daily',
        at: new Date().toISOString(),
        kind: 'daily_report',
        target: '2026-08-11',
      });
      await waitForExpect(
        async () =>
          expect(await s.stores.journal.list({ types: ['daily_report'] })).toHaveLength(1),
        'daily_report が日誌に1件積まれる',
      );

      const dailyPrompt = call()?.inputs.at(-1) ?? '';
      expect(dailyPrompt).toContain('以下はこの日の記録の要約である。');
      expect(dailyPrompt).not.toContain('記憶の床:');

      await s.clone.stop();
    });

    it('2回目の tick で「前回の tick から ±N 文字」が出る（1回目では出ない）。線を超えたら印が出る', async () => {
      const stores = createMemoryStores();
      const summaryChars = 1_000;
      await stores.persona.write('note', noteWithSummary(summaryChars));
      const s = setup(() => 'わかった', stores);
      const call = () => s.calls[0];

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-diff-1',
        at: new Date().toISOString(),
        reason: '1本目',
      });
      await waitFor(() => (call()?.inputs.length ?? 0) === 1, '1本目の入力');
      const firstText = call()?.inputs[0] ?? '';
      expect(firstText).toContain(
        '前回の tick が無いので差分は出せない（このプロセスでの最初の tick）。',
      );
      expect(firstText).not.toMatch(/前回の tick から/);
      expect(firstText).not.toContain('⚠️ 線（');

      const baseline = measureMemoryFloor(await stores.persona.documents()).totalChars;

      const extra = Math.ceil(baseline * 0.2) + 50;
      await stores.persona.write('note', noteWithSummary(summaryChars + extra));
      const grownFloor = measureMemoryFloor(await stores.persona.documents()).totalChars;
      const expectedDiff = grownFloor - baseline;
      expect(expectedDiff).toBeGreaterThan(baseline * 0.1);

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-diff-2',
        at: new Date().toISOString(),
        reason: '2本目',
      });
      await waitFor(() => (call()?.inputs.length ?? 0) === 2, '2本目の入力');
      const secondText = call()?.inputs[1] ?? '';
      expect(secondText).toContain(
        `前回の tick から +${expectedDiff.toLocaleString('en-US')} 文字。`,
      );
      expect(secondText).toContain('⚠️ 線（セッション構築時点から +10%）に達している。');

      await s.clone.stop();
    });

    it('線（+10%）を超えないときは印が出ない', async () => {
      const stores = createMemoryStores();
      const summaryChars = 1_000;
      await stores.persona.write('note', noteWithSummary(summaryChars));
      const s = setup(() => 'わかった', stores);
      const call = () => s.calls[0];

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-under-1',
        at: new Date().toISOString(),
        reason: '1本目',
      });
      await waitFor(() => (call()?.inputs.length ?? 0) === 1, '1本目の入力');

      const baseline = measureMemoryFloor(await stores.persona.documents()).totalChars;
      const smallExtra = Math.max(1, Math.floor(baseline * 0.05));
      await stores.persona.write('note', noteWithSummary(summaryChars + smallExtra));
      const grownFloor = measureMemoryFloor(await stores.persona.documents()).totalChars;
      expect(grownFloor - baseline).toBeGreaterThan(0);
      expect(grownFloor - baseline).toBeLessThan(baseline * 0.1);

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-under-2',
        at: new Date().toISOString(),
        reason: '2本目',
      });
      await waitFor(() => (call()?.inputs.length ?? 0) === 2, '2本目の入力');
      const secondText = call()?.inputs[1] ?? '';
      expect(secondText).toMatch(/前回の tick から \+\d/);
      expect(secondText).not.toContain('⚠️ 線（');

      await s.clone.stop();
    });

    it('線ちょうど（+10.0%）でも印が出る（線に達したら印、の側）', async () => {
      const stores = createMemoryStores();
      const summaryChars = 2_000;
      await stores.persona.write('note', noteWithSummary(summaryChars));
      const s = setup(() => 'わかった', stores);
      const call = () => s.calls[0];

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-exact-1',
        at: new Date().toISOString(),
        reason: '1本目',
      });
      await waitFor(() => (call()?.inputs.length ?? 0) === 1, '1本目の入力');

      const baseline = measureMemoryFloor(await stores.persona.documents()).totalChars;
      await stores.persona.write(
        'note',
        noteWithSummary(summaryChars + Math.round(baseline * 0.1)),
      );

      const grown = measureMemoryFloor(await stores.persona.documents()).totalChars;
      expect(Math.round(((grown - baseline) / baseline) * 100 * 10) / 10).toBe(10);

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-exact-2',
        at: new Date().toISOString(),
        reason: '2本目',
      });
      await waitFor(() => (call()?.inputs.length ?? 0) === 2, '2本目の入力');
      expect(call()?.inputs[1] ?? '').toContain(
        '⚠️ 線（セッション構築時点から +10%）に達している。',
      );

      await s.clone.stop();
    });

    it('記憶の床が測れないとき、0 を名乗らず「測れなかった」と言う（digest 本体は壊れない）', async () => {
      const base = createMemoryStores();
      let personaDocumentsCalls = 0;
      const stores: Stores = {
        ...base,
        persona: {
          ...base.persona,
          documents: () => {
            personaDocumentsCalls += 1;
            return personaDocumentsCalls === 1
              ? Promise.reject(new Error('persona 読み込み失敗（実測を模す）'))
              : base.persona.documents();
          },
        },
      };
      const s = setup(() => '今回は動かない', stores);

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-unreadable',
        at: new Date().toISOString(),
        reason: '定期 tick',
      });
      await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '1本目の入力');

      const text = s.calls[0]?.inputs[0] ?? '';
      expect(text).toContain(
        '記憶の床: 測れなかった（理由: Error: persona 読み込み失敗（実測を模す））。',
      );
      expect(text).not.toMatch(/記憶の床:[^\n]*\d/);
      expect(text).toContain('聞かずに動いたなら');

      await s.clone.stop();
    });

    it('セッションが組み直されて基準が取り直されたら ⚠️ の一言が出る', async () => {
      const stores = createMemoryStores();
      await stores.persona.write('note', `# Note\n\n${'a'.repeat(80)}\n`);
      const s = setup(() => 'わかった', stores, { endSessionAfterTurn: 0 });

      s.clone.post(humanMessage('やあ'));
      await waitForTerminal(s.events);

      const baseline1 = measureMemoryFloor(await stores.persona.documents()).totalChars;
      await stores.persona.write('note', `# Note\n\n${'a'.repeat(500)}\n`);
      const baseline2 = measureMemoryFloor(await stores.persona.documents()).totalChars;
      expect(baseline2).not.toBe(baseline1);

      const flatInputs = () => s.calls.flatMap((call) => call.inputs);

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-rebase-1',
        at: new Date().toISOString(),
        reason: '1本目のtick',
      });
      await waitFor(() => flatInputs().length === 2, '1本目のtickが届く');
      expect(flatInputs().at(-1)).not.toContain('セッションが組み直されて基準が');

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-rebase-2',
        at: new Date().toISOString(),
        reason: '2本目のtick',
      });
      await waitFor(() => flatInputs().length === 3, '2本目のtickが届く');
      expect(flatInputs().at(-1)).toContain(
        `⚠️ セッションが組み直されて基準が ${baseline1.toLocaleString('en-US')} → ` +
          `${baseline2.toLocaleString('en-US')} 文字へ取り直された（% が下がったのは畳んだからではない）。`,
      );

      await s.clone.stop();
    });
  });

  it('外部イベントは日誌に残り、中身がクローンに渡る（起点③）', async () => {
    const s = setup(() => '見た');

    s.clone.post({
      type: 'external',
      id: 'evt-ext',
      at: new Date().toISOString(),
      source: 'ci',
      payload: { repo: 'alteroid', status: 'failure' },
    });

    await waitFor(() => inputsOf(s)().includes('"failure"'), 'failure の入力が届く');
    expect(inputsOf(s)()).toContain('source: ci');

    const externals = (await s.stores.journal.list({ types: ['external_event'] })) as {
      source: string;
    }[];
    expect(externals[0]?.source).toBe('ci');

    await s.clone.stop();
  });

  it('8,000 文字を超える外部イベントは、プロンプトで量と取り方を名乗り、日誌には全文が残る（issue #1535）', async () => {
    const s = setup(() => '見た');
    const at = new Date().toISOString();
    const big = '外部先頭' + 'w'.repeat(20_000) + '外部末尾';
    s.clone.post({ type: 'external', id: 'evt-big', at, source: 'webhook', payload: big });

    await waitFor(() => inputsOf(s)().includes('外部先頭'), '外部イベントの入力が届く');
    const input = inputsOf(s)();
    expect(input).not.toContain('外部末尾');
    expect(input).toContain('文字省略。全 20,008 文字');
    expect(input).toContain('journal_read');
    expect(input).toContain(`since: "${at}"`);
    expect(input).toContain('日誌には切らずに書いてある');

    const externals = (await s.stores.journal.list({
      types: ['external_event'],
      since: at,
    })) as { summary: string }[];
    expect(externals.some((entry) => entry.summary === big)).toBe(true);

    await s.clone.stop();
  });

  it('8,000 文字以内の外部イベントは、プロンプトの本文を1文字も変えず取り方も足さない（issue #1535）', async () => {
    const s = setup(() => '見た');
    s.clone.post({
      type: 'external',
      id: 'evt-small',
      at: new Date().toISOString(),
      source: 'webhook',
      payload: '小さな外部イベント',
    });
    await waitFor(() => inputsOf(s)().includes('小さな外部イベント'), '外部イベントの入力が届く');
    expect(inputsOf(s)()).not.toContain('文字省略');
    expect(inputsOf(s)()).not.toContain('全文の取り方');
    await s.clone.stop();
  });

  it('日誌の上限（20万字）を超える外部イベントは、日誌でも量を名乗り、プロンプトはそれを言う（issue #1535）', async () => {
    const s = setup(() => '見た');
    const at = new Date().toISOString();
    const huge = '巨大先頭' + 'v'.repeat(250_000);
    s.clone.post({ type: 'external', id: 'evt-huge', at, source: 'webhook', payload: huge });
    await waitFor(() => inputsOf(s)().includes('巨大先頭'), '外部イベントの入力が届く');
    expect(inputsOf(s)()).toContain('日誌にも先頭 200,000 文字までしか残っていない');
    const externals = (await s.stores.journal.list({
      types: ['external_event'],
      since: at,
    })) as { summary: string }[];
    const summary = externals[0]?.summary ?? '';
    expect(summary.startsWith('巨大先頭')).toBe(true);
    expect(summary).toContain('文字省略。全 250,004 文字');
    await s.clone.stop();
  });

  it('締めの時刻で日報が作られ、対象日は発火が運んだ日である（起点② / 可観測性の最上段）', async () => {
    const s = setup(() => '今日はログイン周りを直した。保留は無い。');

    s.clone.post({
      type: 'timer',
      id: 'evt-timer',
      at: new Date().toISOString(),
      kind: 'daily_report',
      target: '2026-08-11',
    });

    await waitForExpect(
      async () => expect(await s.stores.journal.list({ types: ['daily_report'] })).toHaveLength(1),
      'daily_report が日誌に1件積まれる',
    );
    const reports = await s.stores.journal.list({ types: ['daily_report'] });

    expect(reports[0]).toMatchObject({
      date: '2026-08-11',
      body: expect.stringContaining('ログイン周り'),
    });
    expect(inputsOf(s)()).toContain('2026-08-11 を締める');
    expect(await dailyReportCauseLines(s)).toEqual(['cause=schedule']);

    await s.clone.stop();
  });

  it('後追いで作られた日報は、日誌に cause=schedule_catchup として残る', async () => {
    const s = setup(() => '後追いで締めた');

    s.clone.post({
      type: 'timer',
      id: 'evt-timer-catchup',
      at: new Date().toISOString(),
      kind: 'daily_report',
      target: '2026-08-12',
      cause: 'schedule_catchup',
    });

    await waitForExpect(
      async () => expect(await s.stores.journal.list({ types: ['daily_report'] })).toHaveLength(1),
      'daily_report が日誌に1件積まれる',
    );
    expect(await dailyReportCauseLines(s)).toEqual(['cause=schedule_catchup']);

    await s.clone.stop();
  });

  it('手で起こした（/run daily_report）日報は、日誌に cause=manual として残る', async () => {
    const s = setup(() => '手で起こされて締めた');

    s.clone.post({
      type: 'timer',
      id: 'evt-timer-manual',
      at: new Date().toISOString(),
      kind: 'daily_report',
      target: '2026-08-12',
      cause: 'manual',
    });

    await waitForExpect(
      async () => expect(await s.stores.journal.list({ types: ['daily_report'] })).toHaveLength(1),
      'daily_report が日誌に1件積まれる',
    );
    expect(await dailyReportCauseLines(s)).toEqual(['cause=manual']);

    await s.clone.stop();
  });

  it('クローンが自分で日報を書いていれば二重に作らない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'daily_report',
      date: '2026-08-11',
      body: 'クローンが道具で書いた日報',
    });

    const s = setup(() => '書いておいた', stores);
    s.clone.post({
      type: 'timer',
      id: 'evt-timer',
      at: new Date().toISOString(),
      kind: 'daily_report',
      target: '2026-08-11',
    });

    await waitFor(
      async () =>
        ((await stores.journal.list({ types: ['exchange'] })) as { with: string }[]).some(
          (entry) => entry.with === 'self',
        ),
      "with: 'self' の exchange が日誌に積まれる",
    );

    const reports = await stores.journal.list({ types: ['daily_report'] });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ body: 'クローンが道具で書いた日報' });

    await s.clone.stop();
  });

  it('継続中の依頼は、時刻が来たとき本文ごとクローンに渡る（記憶に思い出せるかの賭けにしない）', async () => {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'issue-round',
      spec: { type: 'daily', at: '09:00' },
      request: 'このリポジトリの open issue を見て、着手できるものから実装を進める',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
      lastRunAt: '2026-08-11T00:00:00.000Z',
    });

    const s = setup(() => 'issue を1件拾って委譲した', stores);
    s.clone.post({
      type: 'timer',
      id: 'evt-timer',
      at: '2026-08-12T00:00:00.000Z',
      kind: 'issue-round',
    });

    await waitFor(
      () => inputsOf(s)().includes('open issue を見て'),
      '『open issue を見て』という定期実行の入力が届く',
    );
    expect(inputsOf(s)()).toContain('2026-08-11T00:00:00.000Z');
    expect(inputsOf(s)()).toContain('二重に起こさない');

    await waitForExpect(
      async () =>
        expect((await stores.schedules.get('issue-round'))?.lastRunAt).toBe(
          '2026-08-12T00:00:00.000Z',
        ),
      'issue-round の lastRunAt が更新される',
    );

    await s.clone.stop();
  });

  it('依頼が読めない発火では、本文なしの曖昧なターンを走らせない（読み直して届く）', async () => {
    const stores = createMemoryStores();
    const plan = {
      kind: 'issue-round',
      spec: { type: 'daily' as const, at: '09:00' },
      request: 'このリポジトリの open issue を見て、着手できるものから実装を進める',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    };
    await stores.schedules.put(plan);

    const real = stores.schedules.get.bind(stores.schedules);
    let failures = 1;
    stores.schedules.get = async (kind) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('DB が揺れた');
      }
      return real(kind);
    };

    const s = setup(() => 'issue を1件拾って委譲した', stores);
    s.clone.post({
      type: 'timer',
      id: 'evt-timer',
      at: '2026-08-12T00:00:00.000Z',
      kind: 'issue-round',
    });

    await waitFor(
      () => inputsOf(s)().includes('open issue を見て'),
      '『open issue を見て』という定期実行の入力が届く',
    );
    expect(inputsOf(s)()).not.toContain('この定期ジョブが何のために仕込まれている');

    await s.clone.stop();
  });

  it('依頼を読めないままなら、その発火では動かず、前回時刻も進めない', async () => {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'issue-round',
      spec: { type: 'daily' as const, at: '09:00' },
      request: 'open issue を見て実装を進める',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    });
    stores.schedules.get = () => Promise.reject(new Error('DB が落ちている'));

    const s = setup(() => '動いてしまった', stores);
    s.clone.post({
      type: 'timer',
      id: 'evt-timer',
      at: '2026-08-12T00:00:00.000Z',
      kind: 'issue-round',
    });

    await waitFor(
      async () =>
        ((await stores.journal.list({ types: ['exchange'] })) as { text: string }[]).some((entry) =>
          entry.text.includes('読めなかった'),
        ),
      '『読めなかった』を含む exchange が日誌に積まれる',
    );

    expect(s.calls).toEqual([]);
    expect((await stores.schedules.list()).entries[0]?.lastRunAt).toBeUndefined();

    await s.clone.stop();
  });

  it('「起きた」を記録できない発火では動かない（動いてから記録できないと二重に走る）', async () => {
    const stores = createMemoryStores();
    const plan = {
      kind: 'issue-round',
      spec: { type: 'daily' as const, at: '09:00' },
      request: 'open issue を見て、着手できるものから実装を進める',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    };
    await stores.schedules.put(plan);

    const real = stores.schedules.claimRun.bind(stores.schedules);
    let failing = true;
    stores.schedules.claimRun = async (kind, expectedUpdatedAt, at, cause) => {
      if (failing) throw new Error('UPDATE が落ちた');
      return real(kind, expectedUpdatedAt, at, cause);
    };

    const s = setup(() => 'issue を1件拾って委譲した', stores);
    const fire = () => ({
      type: 'timer' as const,
      id: `evt-${Math.random()}`,
      at: '2026-08-12T00:00:00.000Z',
      kind: 'issue-round',
    });

    s.clone.post(fire());

    await waitFor(
      async () =>
        ((await stores.journal.list({ types: ['exchange'] })) as { text: string }[]).some((entry) =>
          entry.text.includes('記録できなかった'),
        ),
      '『記録できなかった』を含む exchange が日誌に積まれる',
    );
    expect(s.calls).toEqual([]);
    expect((await stores.schedules.list()).entries[0]?.lastRunAt).toBeUndefined();

    failing = false;
    s.clone.post(fire());

    await waitFor(
      () => inputsOf(s)().includes('open issue を見て'),
      '『open issue を見て』という定期実行の入力が届く',
    );
    expect((await stores.schedules.list()).entries[0]?.lastRunAt).toBe('2026-08-12T00:00:00.000Z');

    const runs = (await stores.journal.list({ types: ['exchange'] })).filter((entry) =>
      (entry as { text: string }).text.includes('委譲した'),
    );
    expect(runs).toHaveLength(1);

    await s.clone.stop();
  });

  it('記録できなかった発火は、再起動相当の拾い直しでちょうど1回だけ実行される', async () => {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'watch',
      spec: { type: 'every' as const, minutes: 60 },
      request: '見張って進める',
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });

    const real = stores.schedules.claimRun.bind(stores.schedules);
    let failing = true;
    stores.schedules.claimRun = async (kind, expectedUpdatedAt, at, cause) => {
      if (failing) throw new Error('UPDATE が落ちた');
      return real(kind, expectedUpdatedAt, at, cause);
    };

    const s = setup(() => '進めた', stores);
    const posted: string[] = [];
    const scheduler = createScheduler({
      entries: [],
      post: (event) => {
        posted.push(event.type);
        s.clone.post(event);
      },
      schedules: stores.schedules,
    });

    await scheduler.refresh();
    scheduler.start();
    await waitFor(() => posted.length >= 1, '1件目の投稿');
    scheduler.stop();
    await waitFor(
      async () =>
        ((await stores.journal.list({ types: ['exchange'] })) as { text: string }[]).some((entry) =>
          entry.text.includes('記録できなかった'),
        ),
      '『記録できなかった』を含む exchange が日誌に積まれる',
    );
    expect(s.calls).toEqual([]);

    failing = false;
    const second = createScheduler({
      entries: [],
      post: (event) => s.clone.post(event),
      schedules: stores.schedules,
    });
    await second.refresh();
    second.start();

    await waitFor(() => inputsOf(s)().includes('見張って進める'), '見張りの入力が届く');
    second.stop();

    const runs = (await stores.journal.list({ types: ['exchange'] })).filter(
      (entry) => (entry as { text: string }).text === `${EXCHANGE_KIND_REPLY_PREFIX}進めた`,
    );
    expect(runs).toHaveLength(1);

    await s.clone.stop();
  });

  it('引き受けた直後に落ちた発火は、器を作り直したときに本文つきで配り直される', async () => {
    const stores = createMemoryStores();
    const plan = {
      kind: 'issue-round',
      spec: { type: 'daily' as const, at: '09:00' },
      request: 'open issue を見て、着手できるものから実装を進める',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    };
    await stores.schedules.put(plan);

    const crashing = setup(() => '届いていないのに動いた', stores);
    const claim = stores.schedules.claimRun.bind(stores.schedules);
    stores.schedules.claimRun = async (kind, expectedUpdatedAt, at, cause) => {
      await claim(kind, expectedUpdatedAt, at, cause);
      throw new Error('器が落ちた');
    };

    crashing.clone.post({
      type: 'timer',
      id: 'evt-crash',
      at: '2026-08-12T00:00:00.000Z',
      kind: 'issue-round',
    });

    await waitForExpect(
      async () =>
        expect((await stores.schedules.list()).entries[0]?.pendingRun?.at).toBe(
          '2026-08-12T00:00:00.000Z',
        ),
      'pendingRun.at が更新される',
    );
    expect(crashing.calls).toEqual([]);
    expect((await stores.schedules.list()).entries[0]?.lastScheduledRunAt).toBeUndefined();

    await crashing.clone.stop();
    stores.schedules.claimRun = claim;
    const restarted = setup(() => 'issue を1件拾って委譲した', stores);
    const scheduler = createScheduler({
      entries: [],
      post: (event) => restarted.clone.post(event),
      schedules: stores.schedules,
    });
    await scheduler.refresh();
    scheduler.start();

    await waitFor(
      () => inputsOf(restarted)().includes('open issue を見て'),
      '『open issue を見て』という定期実行の入力が届く（再起動後）',
    );
    expect(inputsOf(restarted)()).toContain('引き受けたまま終わっていない');
    expect(inputsOf(restarted)()).toContain('2026-08-12T00:00:00.000Z');

    await waitForExpect(
      async () => expect((await stores.schedules.list()).entries[0]?.pendingRun).toBeUndefined(),
      'pendingRun が消える（undefined になる）',
    );
    expect((await stores.schedules.list()).entries[0]?.lastScheduledRunAt).toBeDefined();

    scheduler.stop();
    await restarted.clone.stop();
  });

  it('ターンが（枠切れ以外で）失敗で終わった定期の発火は、完了にせず印を残す（#2739）', async () => {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'weekly-round',
      spec: { type: 'cron' as const, expression: '0 10 * * 1' },
      request: '週次で open issue を見て実装を進める',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });

    const s = setup(undefined, stores, {
      resultSubtype: 'error_during_execution',
      resultText: 'internal failure: something broke',
    });
    s.clone.post({
      type: 'timer',
      id: 'evt-failed-turn',
      at: '2026-08-10T10:00:00.000Z',
      kind: 'weekly-round',
    });

    await waitFor(() => s.calls.length > 0, '失敗するターンが走る');
    await s.clone.stop();

    const after = (await stores.schedules.list()).entries[0];
    expect(after?.pendingRun?.at).toBe('2026-08-10T10:00:00.000Z');
    expect(after?.lastScheduledRunAt).toBeUndefined();
  });

  it('配り直された発火は、元の時刻・元の理由で確定する', async () => {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'issue-round',
      spec: { type: 'every' as const, minutes: 60 },
      request: 'open issue を見て実装を進める',
      createdAt: '2026-08-12T08:00:00.000Z',
      updatedAt: '2026-08-12T08:00:00.000Z',
      lastRunAt: '2026-08-12T09:10:00.000Z',
      pendingRun: { at: '2026-08-12T09:10:00.000Z', cause: 'manual' as const },
    });

    const s = setup(() => '配り直された分を見た', stores);
    s.clone.post({
      type: 'timer',
      id: 'evt-resume',
      at: '2026-08-12T09:10:00.000Z',
      kind: 'issue-round',
      cause: 'manual',
    });

    await waitForExpect(
      async () => expect((await stores.schedules.list()).entries[0]?.pendingRun).toBeUndefined(),
      'pendingRun が消える（undefined になる）',
    );

    const after = (await stores.schedules.list()).entries[0];
    expect(after?.lastScheduledRunAt).toBeUndefined();
    expect(after?.lastRunAt).toBe('2026-08-12T09:10:00.000Z');
    expect(inputsOf(s)()).toContain('2026-08-12T09:10:00.000Z');

    await s.clone.stop();
  });

  it('手で起こした発火は、観測用の前回時刻だけを進める（定期の基準は動かさない）', async () => {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'issue-round',
      spec: { type: 'every' as const, minutes: 60 },
      request: 'open issue を見て実装を進める',
      createdAt: '2026-08-12T08:00:00.000Z',
      updatedAt: '2026-08-12T08:00:00.000Z',
    });

    const s = setup(() => '手で起こされたので見た', stores);
    s.clone.post({
      type: 'timer',
      id: 'evt-manual',
      at: '2026-08-12T09:10:00.000Z',
      kind: 'issue-round',
      cause: 'manual',
    });

    await waitFor(
      () => inputsOf(s)().includes('open issue を見て'),
      '『open issue を見て』という定期実行の入力が届く',
    );

    const after = (await stores.schedules.list()).entries[0];
    expect(after?.lastRunAt).toBe('2026-08-12T09:10:00.000Z');
    expect(after?.lastScheduledRunAt).toBeUndefined();

    await s.clone.stop();
  });

  it('定期の発火は、観測用と定期の基準の両方を進める', async () => {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'issue-round',
      spec: { type: 'every' as const, minutes: 60 },
      request: 'open issue を見て実装を進める',
      createdAt: '2026-08-12T08:00:00.000Z',
      updatedAt: '2026-08-12T08:00:00.000Z',
    });

    const s = setup(() => '定期で見た', stores);
    s.clone.post({
      type: 'timer',
      id: 'evt-schedule',
      at: '2026-08-12T09:00:00.000Z',
      kind: 'issue-round',
    });

    await waitFor(
      () => inputsOf(s)().includes('open issue を見て'),
      '『open issue を見て』という定期実行の入力が届く',
    );

    const after = (await stores.schedules.list()).entries[0];
    expect(after?.lastRunAt).toBe('2026-08-12T09:00:00.000Z');
    expect(after?.lastScheduledRunAt).toBe('2026-08-12T09:00:00.000Z');

    await s.clone.stop();
  });

  it('取りこぼしを拾った発火は、日誌に cause=schedule_catchup として残り、定期の基準も進む', async () => {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'issue-round',
      spec: { type: 'every' as const, minutes: 60 },
      request: 'open issue を見て実装を進める',
      createdAt: '2026-08-12T08:00:00.000Z',
      updatedAt: '2026-08-12T08:00:00.000Z',
    });

    const s = setup(() => '取りこぼしを拾って見た', stores);
    s.clone.post({
      type: 'timer',
      id: 'evt-catchup',
      at: '2026-08-13T00:00:00.000Z',
      kind: 'issue-round',
      cause: 'schedule_catchup',
    });

    await waitFor(
      () => inputsOf(s)().includes('open issue を見て'),
      '『open issue を見て』という定期実行の入力が届く',
    );

    const after = (await stores.schedules.list()).entries[0];
    expect(after?.lastRunAt).toBe('2026-08-13T00:00:00.000Z');
    expect(after?.lastScheduledRunAt).toBe('2026-08-13T00:00:00.000Z');

    const exchanges = (await stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      text: string;
    }[];
    const turnInputLines = exchanges
      .filter((e) => e.with === 'self' && e.text.startsWith('ターンの入力: timer'))
      .map((e) => e.text);
    expect(turnInputLines).toHaveLength(1);
    expect(turnInputLines[0]).toContain('cause=schedule_catchup');

    await s.clone.stop();
  });

  it('読んでから確定するまでに人間が消したら、取り消された依頼は動かさない', async () => {
    const stores = createMemoryStores();
    const plan = {
      kind: 'issue-round',
      spec: { type: 'daily' as const, at: '09:00' },
      request: 'open issue を見て、着手できるものから実装を進める',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    };
    await stores.schedules.put(plan);

    const read = stores.schedules.get.bind(stores.schedules);
    let removeOnce = true;
    stores.schedules.get = async (kind) => {
      const found = await read(kind);
      if (removeOnce && found !== null) {
        removeOnce = false;
        await stores.schedules.remove(kind);
      }
      return found;
    };

    const s = setup(() => '消えた依頼で動いてしまった', stores);
    s.clone.post({
      type: 'timer',
      id: 'evt-timer',
      at: '2026-08-12T00:00:00.000Z',
      kind: 'issue-round',
    });

    await waitFor(
      async () =>
        ((await stores.journal.list({ types: ['exchange'] })) as { text: string }[]).some((entry) =>
          entry.text.includes('人間がこの依頼を消した'),
        ),
      '『人間がこの依頼を消した』を含む exchange が日誌に積まれる',
    );

    expect(s.calls).toEqual([]);

    await s.clone.stop();
  });

  it('読んでから確定するまでに人間が直したら、新しい本文で動く（古い本文では動かない）', async () => {
    const stores = createMemoryStores();
    const plan = {
      kind: 'issue-round',
      spec: { type: 'daily' as const, at: '09:00' },
      request: '古い依頼: すべての issue を実装する',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    };
    await stores.schedules.put(plan);

    const read = stores.schedules.get.bind(stores.schedules);
    let editOnce = true;
    stores.schedules.get = async (kind) => {
      const found = await read(kind);
      if (editOnce && found !== null) {
        editOnce = false;
        await stores.schedules.put({
          ...found,
          request: '新しい依頼: bug ラベルの issue だけ直す',
          updatedAt: '2026-08-11T12:00:00.000Z',
        });
      }
      return found;
    };

    const s = setup(() => 'bug の issue を1件拾った', stores);
    s.clone.post({
      type: 'timer',
      id: 'evt-timer',
      at: '2026-08-12T00:00:00.000Z',
      kind: 'issue-round',
    });

    await waitFor(
      () => inputsOf(s)().includes('bug ラベルの issue だけ'),
      '『bug ラベルの issue だけ』という入力が届く',
    );
    expect(inputsOf(s)()).not.toContain('すべての issue を実装する');
    expect((await stores.schedules.list()).entries[0]).toMatchObject({
      updatedAt: '2026-08-11T12:00:00.000Z',
      lastRunAt: '2026-08-12T00:00:00.000Z',
    });

    await s.clone.stop();
  });

  it('仕込んだ覚えのない定期ジョブなら、記憶に照らして判断させる（従来の振る舞い）', async () => {
    const s = setup(() => '何もしない');

    s.clone.post({
      type: 'timer',
      id: 'evt-timer',
      at: new Date().toISOString(),
      kind: 'しらない仕込み',
    });

    await waitFor(() => inputsOf(s)().includes('記憶にある'), '記憶の入力が届く');

    await s.clone.stop();
  });

  it('人間の回答待ちが溜まっていても、他の仕事は進む（受け入れ基準2）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: new Date().toISOString(),
      question: '本番に出してよいか',
    });

    const s = setup(() => '保留は保留のまま、別の件を進める', stores);
    s.clone.post({
      type: 'self_initiative',
      id: 'evt-self',
      at: new Date().toISOString(),
      reason: '定期 tick',
    });

    await waitFor(() => (s.calls[0]?.inputs ?? []).length > 0, '最初の入力');
    expect((await stores.jobs.listApprovals({ pendingOnly: true })).entries).toHaveLength(1);
    expect((s.calls[0]?.inputs ?? []).join('\n')).toContain('本番に出してよいか');

    await s.clone.stop();
  });

  it('読まれる前に積み重なった同じ tick は畳む（発火は減らさない）', async () => {
    const s = setup(() => '見た', createMemoryStores(), { delayMs: 120 });

    for (let i = 0; i < 4; i += 1) {
      s.clone.post({
        type: 'self_initiative',
        id: `evt-self-${i}`,
        at: new Date().toISOString(),
        reason: '定期 tick',
      });
    }

    await waitForExpect(
      () => expect((s.calls[0]?.inputs ?? []).length).toBeGreaterThanOrEqual(2),
      'クローンへの入力が2件以上に増える',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(s.calls[0]?.inputs).toHaveLength(2);

    await s.clone.stop();
  }, 10_000);

  it('対象日が違う日報は畳まない（別の日の締めは別の仕事）', async () => {
    const stores = createMemoryStores();
    const s = setup(() => '締めた', stores, { delayMs: 60 });

    for (const target of ['2026-08-10', '2026-08-11', '2026-08-11']) {
      s.clone.post({
        type: 'timer',
        id: `evt-${target}-${Math.random()}`,
        at: new Date().toISOString(),
        kind: 'daily_report',
        target,
      });
    }

    await waitForExpect(
      async () => expect(await stores.journal.list({ types: ['daily_report'] })).toHaveLength(2),
      'daily_report が日誌に2件積まれる',
    );

    const dates = ((await stores.journal.list({ types: ['daily_report'] })) as { date: string }[])
      .map((entry) => entry.date)
      .sort();
    expect(dates).toEqual(['2026-08-10', '2026-08-11']);

    await s.clone.stop();
  }, 10_000);

  it('中身のない通知でも「undefined」を読ませない', async () => {
    const s = setup(() => '見た');

    s.clone.post({
      type: 'external',
      id: 'evt-empty',
      at: new Date().toISOString(),
      source: 'cron',
    });

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).join('\n').includes('中身のない通知'),
      '『中身のない通知』を含む入力が届く',
    );
    expect((s.calls[0]?.inputs ?? []).join('\n')).not.toContain('undefined');

    await s.clone.stop();
  });

  it('日報以外の定期ジョブも受け取れる（人間が後から仕込んだもの）', async () => {
    const s = setup(() => '見直した');

    s.clone.post({
      type: 'timer',
      id: 'evt-timer',
      at: new Date().toISOString(),
      kind: 'weekly_review',
    });

    await waitFor(
      () => inputsOf(s)().includes('定期ジョブ weekly_review'),
      '『定期ジョブ weekly_review』という入力が届く',
    );

    await s.clone.stop();
  });
});
