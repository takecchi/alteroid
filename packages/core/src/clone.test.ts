import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { CLONE_MODEL, CLONE_MODEL_ENV_KEY, createClone, resolveCloneModel } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createScheduler } from './schedule.js';
import type { ChatStreamEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';

/**
 * SDK を実際に呼ばずにクローンループを検証する。
 *
 * ここで固定したいのは配線と、北極星に由来する不変条件（モデル帯・道具の配置・
 * 蒸留の契機・記憶の載せ方）である。SDK 実呼び出しの確認は手動で行う。
 */
interface FakeCall {
  options: Options;
  inputs: string[];
}

function fakeSdk(
  reply: (input: string) => string = () => 'わかった',
  options: { delayMs?: number; failWith?: string } = {},
) {
  const calls: FakeCall[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const call: FakeCall = { options: params.options ?? {}, inputs: [] };
    calls.push(call);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      if (options.failWith !== undefined) throw new Error(options.failWith);

      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      const prompt = params.prompt;
      if (typeof prompt === 'string') {
        call.inputs.push(prompt);
        yield* turn(reply(prompt));
        return;
      }

      for await (const message of prompt as AsyncIterable<{ message: { content: unknown } }>) {
        const text = String(message.message.content);
        call.inputs.push(text);
        if (options.delayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        }
        yield* turn(reply(text));
      }
    }

    function* turn(text: string): Generator<SDKMessage> {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
        session_id: 'sess-fake',
        uuid: 'uuid-assistant',
      } as unknown as SDKMessage;
      yield {
        type: 'result',
        subtype: 'success',
        result: text,
        session_id: 'sess-fake',
        uuid: 'uuid-result',
      } as unknown as SDKMessage;
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, calls };
}

interface Setup {
  clone: CloneHost;
  stores: Stores;
  calls: FakeCall[];
  events: ChatStreamEvent[];
}

function setup(
  reply?: (input: string) => string,
  stores: Stores = createMemoryStores(),
  sdkOptions: { delayMs?: number; failWith?: string } = {},
  // 既定は空。手元に ALTEROID_CLONE_MODEL が置いてあるかどうかでテストの結果を
  // 変えない（不変条件の検証が環境に左右されたら意味がない）。
  env: NodeJS.ProcessEnv = {},
): Setup {
  const { fn, calls } = fakeSdk(reply, sdkOptions);
  // マネージャーも偽物にしておく。ここで検証したいのはクローンのループだけであり、
  // 誤って本物の SDK を起こさないようにする。
  const clone = createClone({
    stores,
    queryFn: fn,
    env,
    // 委譲先も偽物にしておく。ここで検証したいのはクローンのループだけであり、
    // 誤って本物の SDK を起こさないようにする。
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  const events: ChatStreamEvent[] = [];
  clone.subscribe('conv-1', (event) => events.push(event));
  return { clone, stores, calls, events };
}

/** chat の1往復が終わる（done が届く）まで待つ。 */
function waitForDone(events: ChatStreamEvent[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (events.some((event) => event.type === 'done')) {
        clearInterval(tick);
        resolve();
      } else if (Date.now() - started > 3000) {
        clearInterval(tick);
        reject(new Error(`done が来ない: ${JSON.stringify(events)}`));
      }
    }, 5);
  });
}

describe('クローン', () => {
  it('人間の発言に応答し、往復が日誌に残る', async () => {
    const s = setup(() => 'こんにちは');

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const shown = s.events
      .filter((event) => event.type === 'text')
      .map((event) => event.text)
      .join('');
    expect(shown).toBe('こんにちは');

    const exchanges = await s.stores.journal.list({ types: ['exchange'] });
    expect(exchanges.map((e) => (e as { role: string }).role)).toEqual(['outbound', 'inbound']);

    await s.clone.stop();
  });

  it('層とモデル帯の対応、道具の配置を固定する（北極星の不変条件）', async () => {
    const s = setup();

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const { options } = s.calls[0] as FakeCall;
    // クローン = Fable。既定はここから動かない。降ろせるのは人間だけであり、
    // 実装や AI の都合で既定を下げない（AGENTS.md 地雷5 / north_star 禁止1）
    expect(options.model).toBe(CLONE_MODEL);
    expect(CLONE_MODEL).toBe('fable');
    // 組み込みツールは持たせない（人間の写像としての配置）
    expect(options.tools).toEqual([]);
    // 自作ツールは確認なしで使える
    expect(options.allowedTools).toContain('mcp__alteroid__memory_write');
    expect(options.allowedTools).toContain('mcp__alteroid__ask_human');
    expect(options.mcpServers).toHaveProperty('alteroid');
    // 人間のプロジェクト設定は持ち込まない
    expect(options.settingSources).toEqual([]);
    // ターン数上限で暴走を止めない（AGENTS.md 地雷2）
    expect(options.maxTurns).toBeUndefined();

    await s.clone.stop();
  });

  it('モデル帯の既定は環境変数で動かない。空・空白は既定に落ちる', () => {
    expect(resolveCloneModel({})).toBe(CLONE_MODEL);
    expect(resolveCloneModel({ [CLONE_MODEL_ENV_KEY]: '' })).toBe(CLONE_MODEL);
    expect(resolveCloneModel({ [CLONE_MODEL_ENV_KEY]: '   ' })).toBe(CLONE_MODEL);
    // 人間が置いた値だけが効く。既知の別名で関門を作らない（SDK が増やした
    // モデルを人間が選べなくなる＝能力の削除。north_star 禁止1）
    expect(resolveCloneModel({ [CLONE_MODEL_ENV_KEY]: 'opus' })).toBe('opus');
    expect(resolveCloneModel({ [CLONE_MODEL_ENV_KEY]: '  opus  ' })).toBe('opus');
    expect(resolveCloneModel({ [CLONE_MODEL_ENV_KEY]: 'まだ無いモデル' })).toBe('まだ無いモデル');
  });

  it('差し替えた帯は本セッションと蒸留のサイドクエリの両方に効く', async () => {
    const s = setup(undefined, createMemoryStores(), {}, { [CLONE_MODEL_ENV_KEY]: 'opus' });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const main = s.calls[0] as FakeCall;
    expect(main.options.model).toBe('opus');

    // PreCompact の蒸留は別の短命セッションで走る。ここだけ帯が違うと、
    // 人格を書く側だけが別の頭になる。
    const dir = await mkdtemp(join(tmpdir(), 'alteroid-clone-model-'));
    try {
      const transcriptPath = join(dir, 'transcript.jsonl');
      await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');

      const hook = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
      if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
      await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
        signal: new AbortController().signal,
      } as never);

      const side = s.calls.at(-1) as FakeCall;
      expect(side).not.toBe(main);
      expect(side.options.model).toBe('opus');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    await s.clone.stop();
  });

  it('記憶をシステムプロンプトに載せる。人間が書き換えれば次の会話に反映される（受け入れ基準3）', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('values', '# 価値観\n\n人間が手で書いた方針\n');

    const s = setup(undefined, stores);
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    expect(String((s.calls[0] as FakeCall).options.systemPrompt)).toContain('人間が手で書いた方針');

    await s.clone.stop();
  });

  it('セッション id を覚え、次の起動で resume に渡す（再起動しても同じ人格）', async () => {
    const stores = createMemoryStores();

    const first = setup(undefined, stores);
    first.clone.post(humanMessage('やあ'));
    await waitForDone(first.events);
    await first.clone.stop();

    expect(await stores.sessions.getCloneSessionId()).toBe('sess-fake');
    expect((first.calls[0] as FakeCall).options.resume).toBeUndefined();

    const second = setup(undefined, stores);
    second.clone.post(humanMessage('また来た'));
    await waitForDone(second.events);

    expect((second.calls[0] as FakeCall).options.resume).toBe('sess-fake');

    await second.clone.stop();
  });

  it('会話終了で蒸留を促す（蒸留は生存条件であって付加機能ではない）', async () => {
    const s = setup();

    s.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs[0]).toBe('価値観を伝える');
    expect(inputs[1]).toContain('記憶へ移すべきものがあるか確認せよ');

    await s.clone.stop();
  });

  it('承認待ちへの回答は受信箱を通ってクローンに届く', async () => {
    const s = setup();
    await s.stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: new Date().toISOString(),
      question: 'これを送ってよいか',
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    await s.clone.answerApproval('ap-1', 'よい');

    // 回答済みになる
    expect(await s.stores.jobs.listApprovals({ pendingOnly: true })).toEqual([]);

    // クローンに回答が届く（内部ターンなので chat には出さない）
    await expect
      .poll(() => (s.calls[0] as FakeCall).inputs.some((input) => input.includes('よい')), {
        timeout: 3000,
      })
      .toBe(true);

    await s.clone.stop();
  });

  it('マネージャーの報告と確認は受信箱を通ってクローンに届く（配線）', async () => {
    const s = setup();

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    s.clone.post({
      type: 'manager_message',
      id: 'evt-report',
      at: new Date().toISOString(),
      managerId: 'mgr-1',
      kind: 'report',
      text: '直しました',
    });
    s.clone.post({
      type: 'manager_message',
      id: 'evt-permission',
      at: new Date().toISOString(),
      managerId: 'mgr-2',
      kind: 'permission',
      text: 'Bash の実行許可: git push',
      requestId: 'req-1',
    });

    const inputs = () => (s.calls[0] as FakeCall).inputs;
    await expect
      .poll(() => inputs().some((input) => input.includes('直しました')), { timeout: 3000 })
      .toBe(true);

    const permission = await expect
      .poll(() => inputs().find((input) => input.includes('git push')), { timeout: 3000 })
      .toBeTruthy()
      .then(() => inputs().find((input) => input.includes('git push')) ?? '');

    // 止まっているのはその仕事だけだと伝わり、答え方の経路も示される
    expect(permission).toContain('mgr-2');
    expect(permission).toContain('manager_send');
    expect(permission).toContain('ask_human');

    // マネージャーとの往復も日誌に残る（見えない層を作らない）
    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { with: string }[];
    expect(exchanges.some((entry) => entry.with === 'manager')).toBe(true);

    await s.clone.stop();
  });
});

/**
 * 起点4つ（PRD「自律」）。人間の発言以外の3つは、**人間が一切入力していない状態**で
 * 起きることが本質なので、どのテストも human_message を送らずに始める。
 */
describe('クローン — 自律（人間以外の起点）', () => {
  const inputsOf = (s: Setup) => () => (s.calls[0]?.inputs ?? []).join('\n');

  it('発意 tick で、人間が黙っていても自分の判断が動く（起点④）', async () => {
    const s = setup(() => '今回は動かない');

    s.clone.post({
      type: 'self_initiative',
      id: 'evt-self',
      at: new Date().toISOString(),
      reason: '定期 tick',
    });

    await expect
      .poll(() => inputsOf(s)().includes('次にやることがあるか'), { timeout: 3000 })
      .toBe(true);
    // 人間には見せない内部ターンなので chat には出ない
    expect(s.events).toEqual([]);

    await s.clone.stop();
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

    await expect.poll(() => inputsOf(s)().includes('"failure"'), { timeout: 3000 }).toBe(true);
    expect(inputsOf(s)()).toContain('source: ci');

    const externals = (await s.stores.journal.list({ types: ['external_event'] })) as {
      source: string;
    }[];
    expect(externals[0]?.source).toBe('ci');

    await s.clone.stop();
  });

  it('締めの時刻で日報が作られ、対象日は発火が運んだ日である（起点② / 可観測性の最上段）', async () => {
    const s = setup(() => '今日はログイン周りを直した。保留は無い。');

    s.clone.post({
      type: 'timer',
      id: 'evt-timer',
      at: new Date().toISOString(),
      kind: 'daily_report',
      // デーモンが止まっていた日を後から締めることがあるので、対象日は運ばれてくる
      target: '2026-08-11',
    });

    const reports = await expect
      .poll(() => s.stores.journal.list({ types: ['daily_report'] }), { timeout: 3000 })
      .toHaveLength(1)
      .then(() => s.stores.journal.list({ types: ['daily_report'] }));

    expect(reports[0]).toMatchObject({
      date: '2026-08-11',
      body: expect.stringContaining('ログイン周り'),
    });
    expect(inputsOf(s)()).toContain('2026-08-11 を締める');

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

    // ターンが終わったことを内部ターンの日誌で確かめる
    await expect
      .poll(
        async () =>
          ((await stores.journal.list({ types: ['exchange'] })) as { with: string }[]).some(
            (entry) => entry.with === 'self',
          ),
        { timeout: 3000 },
      )
      .toBe(true);

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

    await expect
      .poll(() => inputsOf(s)().includes('open issue を見て'), { timeout: 3000 })
      .toBe(true);
    // 前回いつ動いたかも渡す（同じ仕事をまっさらから起こさないため）
    expect(inputsOf(s)()).toContain('2026-08-11T00:00:00.000Z');
    expect(inputsOf(s)()).toContain('二重に起こさない');

    // 起きたこと自体が記録され、次の発火では「前回」が更新されている
    await expect
      .poll(async () => (await stores.schedules.get('issue-round'))?.lastRunAt, { timeout: 3000 })
      .toBe('2026-08-12T00:00:00.000Z');

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

    // 器が一瞬だけ揺れる（pg の瞬断・fs の一時エラー）
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

    // 復旧したら本来の依頼が届く（1周期ぶん落とさない）
    await expect
      .poll(() => inputsOf(s)().includes('open issue を見て'), { timeout: 3000 })
      .toBe(true);
    // 本文なしの曖昧なターンは走っていない
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

    // 読めなかったことは日誌に残る（黙って落とさない）
    await expect
      .poll(
        async () =>
          ((await stores.journal.list({ types: ['exchange'] })) as { text: string }[]).some(
            (entry) => entry.text.includes('読めなかった'),
          ),
        { timeout: 3000 },
      )
      .toBe(true);

    // ターンは1本も走っていない（Fable を曖昧な仕事で消費しない）
    expect(s.calls).toEqual([]);
    // 「動いた」ことにもしない。次の発火で同じ依頼がそのまま来る
    expect((await stores.schedules.list())[0]?.lastRunAt).toBeUndefined();

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

    // 読めるが書けない（DB の一時障害で UPDATE だけ落ちる）を模す
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

    // ① 記録できないあいだは本体ターンを起こさない（PR や外部操作までやらせない）
    await expect
      .poll(
        async () =>
          ((await stores.journal.list({ types: ['exchange'] })) as { text: string }[]).some(
            (entry) => entry.text.includes('記録できなかった'),
          ),
        { timeout: 3000 },
      )
      .toBe(true);
    expect(s.calls).toEqual([]);
    expect((await stores.schedules.list())[0]?.lastRunAt).toBeUndefined();

    // ② 復旧すれば、次の発火で依頼の本文つきで動く
    failing = false;
    s.clone.post(fire());

    await expect
      .poll(() => inputsOf(s)().includes('open issue を見て'), { timeout: 3000 })
      .toBe(true);
    expect((await stores.schedules.list())[0]?.lastRunAt).toBe('2026-08-12T00:00:00.000Z');

    // ③ 走ったのは1回だけ（再起動相当の拾い直しでも二重に実行しない）
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
      // 「落ちている間に過ぎた予定」として拾われる位置に置く
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

    // 1回目の起動: 過ぎた予定を拾って発火するが、記録できないので動かない
    await scheduler.refresh();
    scheduler.start();
    await expect.poll(() => posted.length >= 1, { timeout: 3000 }).toBe(true);
    scheduler.stop();
    await expect
      .poll(
        async () =>
          ((await stores.journal.list({ types: ['exchange'] })) as { text: string }[]).some(
            (entry) => entry.text.includes('記録できなかった'),
          ),
        { timeout: 3000 },
      )
      .toBe(true);
    expect(s.calls).toEqual([]);

    // 2回目の起動（器が直っている）: 同じ予定を拾い直して、今度は動く
    failing = false;
    const second = createScheduler({
      entries: [],
      post: (event) => s.clone.post(event),
      schedules: stores.schedules,
    });
    await second.refresh();
    second.start();

    await expect.poll(() => inputsOf(s)().includes('見張って進める'), { timeout: 3000 }).toBe(true);
    second.stop();

    // 実際に走ったのは1回だけ
    const runs = (await stores.journal.list({ types: ['exchange'] })).filter(
      (entry) => (entry as { text: string }).text === '進めた',
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

    // --- 1回目の器: claim できた直後に中断される -------------------------------
    const crashing = setup(() => '届いていないのに動いた', stores);
    // 「claim は成功したが、モデルへ渡す前に器が落ちた」を作る
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

    await expect
      .poll(async () => (await stores.schedules.list())[0]?.pendingRun?.at, { timeout: 3000 })
      .toBe('2026-08-12T00:00:00.000Z');
    // モデルには何も届いていない
    expect(crashing.calls).toEqual([]);
    // 定期の基準は進んでいない（「もう動いた」ことにしない）
    expect((await stores.schedules.list())[0]?.lastScheduledRunAt).toBeUndefined();

    // --- 2回目の器: 同じ Stores から作り直す -----------------------------------
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

    // 引き受けたまま終わっていない回が、依頼の本文つきで届く
    await expect
      .poll(() => inputsOf(restarted)().includes('open issue を見て'), { timeout: 3000 })
      .toBe(true);
    // 走りかけていた可能性は隠さない（二重に手を出す前に確かめさせる）
    expect(inputsOf(restarted)()).toContain('引き受けたまま終わっていない');

    // 終わったので印は消え、定期の基準が進む
    await expect
      .poll(async () => (await stores.schedules.list())[0]?.pendingRun, { timeout: 3000 })
      .toBeUndefined();
    expect((await stores.schedules.list())[0]?.lastScheduledRunAt).toBeDefined();

    scheduler.stop();
    await restarted.clone.stop();
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

    await expect
      .poll(() => inputsOf(s)().includes('open issue を見て'), { timeout: 3000 })
      .toBe(true);

    const after = (await stores.schedules.list())[0];
    expect(after?.lastRunAt).toBe('2026-08-12T09:10:00.000Z');
    // 定期の予定の基準は動かない（次の起動で位相がずれない）
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
    // cause を省略した発火は定期の予定として扱う（schema の既定）
    s.clone.post({
      type: 'timer',
      id: 'evt-schedule',
      at: '2026-08-12T09:00:00.000Z',
      kind: 'issue-round',
    });

    await expect
      .poll(() => inputsOf(s)().includes('open issue を見て'), { timeout: 3000 })
      .toBe(true);

    const after = (await stores.schedules.list())[0];
    expect(after?.lastRunAt).toBe('2026-08-12T09:00:00.000Z');
    expect(after?.lastScheduledRunAt).toBe('2026-08-12T09:00:00.000Z');

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

    // 「読んだ直後に人間の DELETE が着地した」を作る
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

    await expect
      .poll(
        async () =>
          ((await stores.journal.list({ types: ['exchange'] })) as { text: string }[]).some(
            (entry) => entry.text.includes('人間がこの依頼を消した'),
          ),
        { timeout: 3000 },
      )
      .toBe(true);

    // 古い本文でも、本文なしの曖昧なターンでも走らせない
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

    // 「読んだ直後に人間の POST が着地した」を作る
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

    await expect
      .poll(() => inputsOf(s)().includes('bug ラベルの issue だけ'), { timeout: 3000 })
      .toBe(true);
    // 取り消された本文は渡っていない
    expect(inputsOf(s)()).not.toContain('すべての issue を実装する');
    // 発火の跡は新しい版に付く
    expect((await stores.schedules.list())[0]).toMatchObject({
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

    await expect.poll(() => inputsOf(s)().includes('記憶にある'), { timeout: 3000 }).toBe(true);

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

    await expect.poll(() => (s.calls[0]?.inputs ?? []).length > 0, { timeout: 3000 }).toBe(true);
    // 保留は保留のまま（回答待ちを勝手に片付けない）
    expect(await stores.jobs.listApprovals({ pendingOnly: true })).toHaveLength(1);
    // それでも発意 tick は状況を見て動いている
    expect((s.calls[0]?.inputs ?? []).join('\n')).toContain('本番に出してよいか');

    await s.clone.stop();
  });

  it('読まれる前に積み重なった同じ tick は畳む（発火は減らさない）', async () => {
    // ターンが長引いているあいだに tick が溜まると、同じ材料の同じ判断を
    // 連続で走らせることになる（重複した委譲が起きうる）。読む前の重複には
    // 情報が無いので畳む。回数の上限を置くのとは別物。
    const s = setup(() => '見た', createMemoryStores(), { delayMs: 120 });

    for (let i = 0; i < 4; i += 1) {
      s.clone.post({
        type: 'self_initiative',
        id: `evt-self-${i}`,
        at: new Date().toISOString(),
        reason: '定期 tick',
      });
    }

    // 処理中の1件 + 待ち行列の1件 だけが走る
    await expect
      .poll(() => (s.calls[0]?.inputs ?? []).length, { timeout: 3000 })
      .toBeGreaterThanOrEqual(2);
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

    await expect
      .poll(() => stores.journal.list({ types: ['daily_report'] }), { timeout: 5000 })
      .toHaveLength(2);

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

    await expect
      .poll(() => (s.calls[0]?.inputs ?? []).join('\n').includes('中身のない通知'), {
        timeout: 3000,
      })
      .toBe(true);
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

    await expect
      .poll(() => inputsOf(s)().includes('定期ジョブ weekly_review'), { timeout: 3000 })
      .toBe(true);

    await s.clone.stop();
  });
});

describe('クローン — 壊れ方の回帰', () => {
  it('応答中に会話終了が来てもループが止まらない（ターンの起動口は受信箱1つ）', async () => {
    // chat を2枚開いて片方を閉じる、という常駐デーモンでは普通の操作。
    // 蒸留が走行中ターンを踏み潰すと、以後クローンが永久に無反応になっていた。
    const s = setup(() => 'A の返事', createMemoryStores(), { delayMs: 120 });

    s.clone.post(humanMessage('MSG-A'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await s.clone.endConversation('conv-1');

    // A の返事は捨てられない
    expect(s.events.some((event) => event.type === 'done')).toBe(true);

    // 以後も普通に応答できる
    const events: ChatStreamEvent[] = [];
    s.clone.subscribe('conv-2', (event) => events.push(event));
    s.clone.post(humanMessage('MSG-B', 'conv-2'));
    await waitForDone(events);

    await s.clone.stop();
  }, 10_000);

  it('resume に失敗したら腐ったセッション id を捨てる（人間の手作業を要求しない）', async () => {
    const stores = createMemoryStores();
    await stores.sessions.setCloneSessionId('stale-session-id');

    const s = setup(undefined, stores, { failWith: 'No conversation found with session ID' });
    s.clone.post(humanMessage('やあ'));

    await expect
      .poll(() => s.events.some((event) => event.type === 'error'), { timeout: 3000 })
      .toBe(true);
    await expect.poll(() => stores.sessions.getCloneSessionId(), { timeout: 3000 }).toBeNull();

    await s.clone.stop();
  });

  it('走行中に人間が記憶を書き換えたら、次のターンで載せ直す（受け入れ基準3）', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('values', '# 価値観\n\nOLD-VALUE\n');

    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    // 人間がエディタで直接書き換える
    await stores.persona.write('values', '# 価値観\n\nNEW-VALUE\n');

    const events: ChatStreamEvent[] = [];
    s.clone.subscribe('conv-2', (event) => events.push(event));
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);

    const second = (s.calls[0] as FakeCall).inputs[1] ?? '';
    expect(second).toContain('NEW-VALUE');
    expect(second).toContain('2回目');

    await s.clone.stop();
  });

  it('内部ターンの応答も日誌に残る（見えない層を作らない）', async () => {
    const s = setup(() => '記憶を更新しました');

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');

    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      role: string;
    }[];
    expect(exchanges.some((entry) => entry.with === 'self' && entry.role === 'outbound')).toBe(
      true,
    );

    await s.clone.stop();
  });

  it('承認への回答は日誌からも追える', async () => {
    const s = setup();
    await s.stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: new Date().toISOString(),
      question: 'これを送ってよいか',
    });

    await s.clone.answerApproval('ap-1', 'よい');

    const escalations = (await s.stores.journal.list({ types: ['escalation'] })) as {
      answer?: string;
    }[];
    expect(escalations.some((entry) => entry.answer === 'よい')).toBe(true);

    await s.clone.stop();
  });
});
