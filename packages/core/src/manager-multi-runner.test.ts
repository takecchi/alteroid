import type { Options, PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import type { RunnerCapacity, RunnerClient } from './runner-protocol.js';
import { createRunnerRegistry, type RunnerRegistry } from './runner-registry.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import type { WorkspacePolicy } from './workspace.js';

/**
 * 複数 runner の検証（roadmap M5 の受け入れ基準）。
 *
 * 1. runner を2台以上登録し、複数マネージャーが配置される
 * 2. `manager_send` / 許可確認 / 報告が、常に割り当て先の runner へ届く
 * 3. デーモン再起動後も runner affinity を復元できる
 * 4. 1台停止時、永続化済み session と workspace から別 runner で継続できる。
 *    できない場合は、復旧不能な未永続状態を人間へ明示できる
 * 5. runner 数を増減しても、人工的なセッション数上限や能力削減が入らない
 *
 * SDK は器の中で走るので、偽の `query` は runner ごとに1つ渡す。**どちらの器で
 * 走ったのか**が見えることが、この一式の要点である。
 */
interface FakeSession {
  options: Options;
  inputs: string[];
  ask(toolName: string, input: Record<string, unknown>): Promise<PermissionResult>;
  report(text: string): Promise<void>;
}

function fakeSdk(sessionId: string) {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    let emit: ((message: SDKMessage) => void) | null = null;
    let asks = 0;
    const buffered: SDKMessage[] = [];
    const inputs: string[] = [];

    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };

    const session: FakeSession = {
      options,
      inputs,
      async ask(toolName, input) {
        const canUseTool = options.canUseTool;
        if (canUseTool === undefined) throw new Error('canUseTool が渡っていない');
        const id = `req-${(asks += 1)}`;
        const result = await canUseTool(toolName, input, {
          signal: new AbortController().signal,
          toolUseID: `tool-${id}`,
          requestId: id,
        } as never);
        if (result === null) throw new Error('canUseTool が null を返した');
        return result;
      },
      async report(text) {
        push({
          type: 'result',
          subtype: 'success',
          result: text,
          session_id: sessionId,
          uuid: `uuid-${sessionId}`,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    };
    sessions.push(session);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        uuid: `init-${sessionId}`,
      } as unknown as SDKMessage;

      // デーモンから降りてくる入力を読み続ける裏方（ここでは記録するだけ）
      void (async () => {
        for await (const message of params.prompt as AsyncIterable<{
          message: { content: unknown };
        }>) {
          inputs.push(String(message.message.content));
        }
      })();

      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        // `close()` で null が来たら閉じる。ここを塞ぐと、畳めない Query が残る。
        if (message === null) return;
        yield message;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => {
        if (emit) emit(null as unknown as SDKMessage);
      },
      interrupt: async () => undefined,
    }) as never;
  }) as never;

  return { fn, sessions };
}

/** 器そのもの（偽の SDK ＋ 資源の報告 ＋ 落とせるスイッチ）。 */
interface Rig {
  client: RunnerClient;
  sessions: FakeSession[];
  /** 器を落とす。以後は名乗りも命令も返らない（コンテナが消えた状態）。 */
  kill(): void;
}

function rig(runnerId: string, sessionId: string, capacity: Partial<RunnerCapacity> = {}): Rig {
  const { fn, sessions } = fakeSdk(sessionId);
  const inner = createLocalRunner({
    runnerId,
    workspacePath: `/work/${runnerId}`,
    queryFn: fn,
    env: { PATH: '/usr/bin' },
    // 資源は固定して配置を読めるようにする（稼働セッション数だけ実測を通す）。
    capacityFn: (activeManagers) => ({
      cpuCount: 4,
      load1m: 0,
      totalMemoryBytes: 8_000_000_000,
      freeMemoryBytes: 6_000_000_000,
      uptimeSeconds: 100,
      ...capacity,
      activeManagers,
    }),
  });

  let dead = false;
  const gone = () => new Error(`${runnerId} は落ちている`);

  // 落ちた器は名乗りも命令も返さない。**「落ちている」を戻り値で表さない** —
  // 例外にしないと、名簿が生きている器と区別できない。
  const client: RunnerClient = {
    get runnerId() {
      return inner.runnerId;
    },
    get workspacePath() {
      return inner.workspacePath;
    },
    async health() {
      if (dead) throw gone();
      return inner.health();
    },
    async connect(onEvent) {
      if (dead) throw gone();
      return inner.connect(onEvent);
    },
    async start(command) {
      if (dead) throw gone();
      return inner.start(command);
    },
    async resume(command) {
      if (dead) throw gone();
      return inner.resume(command);
    },
    async send(managerId, text) {
      if (dead) throw gone();
      return inner.send(managerId, text);
    },
    async answer(managerId, answer) {
      if (dead) throw gone();
      return inner.answer(managerId, answer);
    },
    async stop(managerId) {
      if (dead) return;
      return inner.stop(managerId);
    },
    async list() {
      if (dead) throw gone();
      return inner.list();
    },
    async transcript(managerId) {
      if (dead) return null;
      return inner.transcript(managerId);
    },
    async close() {
      return inner.close();
    },
  };

  return {
    client,
    sessions,
    kill() {
      dead = true;
    },
  };
}

function clock(start = 1_000_000) {
  let at = start;
  return {
    now: () => at,
    advance(ms: number) {
      at += ms;
    },
  };
}

interface Fleet {
  pool: ManagerPool;
  registry: RunnerRegistry;
  stores: Stores;
  inbox: InboxEvent[];
  advance(ms: number): void;
}

function fleet(
  rigs: Rig[],
  options: { stores?: Stores; workspace?: WorkspacePolicy; inbox?: InboxEvent[] } = {},
): Fleet {
  const time = clock();
  const stores = options.stores ?? createMemoryStores();
  const inbox = options.inbox ?? [];
  const registry = createRunnerRegistry(
    rigs.map((entry) => entry.client),
    { now: time.now, heartbeatIntervalMs: 1_000, livenessTimeoutMs: 2_000 },
  );
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
  });
  return { pool, registry, stores, inbox, advance: time.advance };
}

describe('複数 runner — 配置と経路', () => {
  it('2台に複数のマネージャーが分かれて配置される（受け入れ基準1）', async () => {
    const a = rig('runner-a', 'sess-a');
    const b = rig('runner-b', 'sess-b');
    const f = fleet([a, b]);

    const first = await f.pool.start({ request: '1本目' });
    const second = await f.pool.start({ request: '2本目' });

    expect(a.sessions.length).toBe(1);
    expect(b.sessions.length).toBe(1);
    expect(new Set([first.runnerId, second.runnerId])).toEqual(new Set(['runner-a', 'runner-b']));

    // 台帳に `manager_id → runner_id → workspace` が残る（宛先の鎖）
    const jobs = await f.stores.jobs.listJobs();
    expect(jobs.map((job) => job.runnerId).sort()).toEqual(['runner-a', 'runner-b']);
    expect(jobs.every((job) => job.workspace !== undefined)).toBe(true);

    await f.pool.stop();
  });

  it('資源に余裕のある器へ寄せる（配置の材料は実行環境の資源だけ）', async () => {
    const small = rig('runner-small', 'sess-small', { cpuCount: 2, load1m: 2 });
    const big = rig('runner-big', 'sess-big', { cpuCount: 16, load1m: 0 });
    const f = fleet([small, big]);

    const started = await f.pool.start({ request: '重い仕事' });
    expect(started.runnerId).toBe('runner-big');

    await f.pool.stop();
  });

  it('send・許可確認・報告が、常に割り当て先の runner へ届く（受け入れ基準2）', async () => {
    const a = rig('runner-a', 'sess-a');
    const b = rig('runner-b', 'sess-b');
    const f = fleet([a, b]);

    const first = await f.pool.start({ request: '1本目' });
    const second = await f.pool.start({ request: '2本目' });
    const owner = new Map([
      [first.runnerId, first.managerId],
      [second.runnerId, second.managerId],
    ]);
    const aManager = owner.get('runner-a') as string;
    const bManager = owner.get('runner-b') as string;

    // 追加指示は、その manager が居る器のセッションにだけ届く（sticky routing）
    await f.pool.send(aManager, 'A への追加指示');
    const aSession = a.sessions[0] as FakeSession;
    const bSession = b.sessions[0] as FakeSession;
    await expect
      .poll(() => aSession.inputs.join('|'), { timeout: 2000 })
      .toContain('A への追加指示');
    expect(bSession.inputs.join('|')).not.toContain('A への追加指示');

    // 許可確認は、その器のセッションから上がってクローンの受信箱へ届く
    const asked = bSession.ask('Bash', { command: 'rm -rf /tmp/x' });
    await expect
      .poll(() => f.inbox.filter((event) => event.type === 'manager_message').length, {
        timeout: 2000,
      })
      .toBeGreaterThan(0);
    const ask = f.inbox.find(
      (event) => event.type === 'manager_message' && event.kind === 'permission',
    );
    if (ask?.type !== 'manager_message') throw new Error('許可確認が受信箱に届いていない');
    expect(ask.managerId).toBe(bManager);

    // 回答も割り当て先へ戻る（別の器の同名の確認と混ざらない）
    const answered = await f.pool.send(bManager, 'いい', {
      decision: 'allow',
      ...(ask.requestId === undefined ? {} : { requestId: ask.requestId }),
    });
    expect(answered.outcome).toBe('answered');
    expect(await asked).toEqual({ behavior: 'allow' });

    // 報告も manager_id 付きで上がる
    await bSession.report('B の報告');
    await expect
      .poll(
        () =>
          f.inbox.some(
            (event) =>
              event.type === 'manager_message' &&
              event.managerId === bManager &&
              event.text === 'B の報告',
          ),
        { timeout: 2000 },
      )
      .toBe(true);

    await f.pool.stop();
  });

  it('デーモンを再起動しても affinity が戻る（受け入れ基準3）', async () => {
    const a = rig('runner-a', 'sess-a');
    const b = rig('runner-b', 'sess-b');
    const stores = createMemoryStores();
    const first = fleet([a, b], { stores });

    const started = await first.pool.start({ request: '走り続ける仕事' });
    await expect
      .poll(async () => (await stores.jobs.listJobs())[0]?.sessionId, { timeout: 2000 })
      .toBeDefined();
    const home = started.runnerId;
    await first.pool.stop();

    // 器を作り直した後のデーモン（台帳だけが残っている）
    const second = fleet([a, b], { stores });
    const restored = await second.pool.restore();

    expect(restored.length).toBe(1);
    expect(restored[0]?.runnerId).toBe(home);
    // 別の器へ勝手に流れていない（sticky であること）
    const owner = home === 'runner-a' ? a : b;
    const other = home === 'runner-a' ? b : a;
    expect(owner.sessions.length).toBe(2);
    expect(other.sessions.length).toBe(0);

    await second.pool.stop();
  });

  it('runner が落ちたら、生きている器で続きを開く（受け入れ基準4 / git 再構築）', async () => {
    const a = rig('runner-a', 'sess-a');
    const b = rig('runner-b', 'sess-b', { cpuCount: 16 });
    // 大きい器に寄らないよう、まず a へ置く（落とす対象を決めたいだけ）
    const f = fleet([a], {
      workspace: { kind: 'git', repository: 'git@github.com:acme/app.git', ref: 'main' },
    });
    const started = await f.pool.start({ request: '実装して PR を出して' });
    expect(started.runnerId).toBe('runner-a');
    await expect
      .poll(async () => (await f.stores.jobs.listJobs())[0]?.sessionId, { timeout: 2000 })
      .toBeDefined();

    // b を後から名簿へ足す（runner は増やせる）。そして a を落とす。
    f.registry.register(b.client);
    a.kill();
    f.advance(3_000);

    // 生存確認が落ちたと見た時点で、話しかけられるのを待たずに置き直す
    await f.registry.heartbeat();
    await expect.poll(() => b.sessions.length, { timeout: 2000 }).toBe(1);

    const job = (await f.stores.jobs.listJobs())[0];
    expect(job?.runnerId).toBe('runner-b');
    expect(job?.cwd).toBe('/work/runner-b');
    expect(job?.status).toBe('running');

    // 続きは同じ session から開き直され、作り直しの指示が流れている
    const moved = b.sessions[0] as FakeSession;
    expect(moved.options.resume).toBe('sess-a');
    await expect.poll(() => moved.inputs.join('|'), { timeout: 2000 }).toContain('clone し直して');

    // クローンには「移した」ことが届く（把握したままでいる）
    expect(
      f.inbox.some(
        (event) => event.type === 'manager_message' && event.text.includes('runner-b で開き直した'),
      ),
    ).toBe(true);

    // 移送後も宛先は新しい器（sticky routing が付いていく）
    const sent = await f.pool.send(started.managerId, '続きを頼む');
    expect(sent.outcome).toBe('delivered');
    await expect.poll(() => moved.inputs.join('|'), { timeout: 2000 }).toContain('続きを頼む');

    await f.pool.stop();
  });

  it('移送の契機が重なっても、同じ仕事を2か所で開かない', async () => {
    const a = rig('runner-a', 'sess-a');
    const b = rig('runner-b', 'sess-b');
    const c = rig('runner-c', 'sess-c');
    const f = fleet([a], {
      workspace: { kind: 'git', repository: 'git@github.com:acme/app.git', ref: 'main' },
    });

    const started = await f.pool.start({ request: '長い仕事' });
    await expect
      .poll(async () => (await f.stores.jobs.listJobs())[0]?.sessionId, { timeout: 2000 })
      .toBeDefined();

    f.registry.register(b.client);
    f.registry.register(c.client);
    a.kill();
    f.advance(3_000);

    // 生存確認（名簿の通知）と、話しかけられたことが同時に起きる状況
    const [, sent] = await Promise.all([
      f.registry.heartbeat(),
      f.pool.send(started.managerId, 'どうなった？'),
      f.pool.rebalance(),
    ]);

    // 開き直るのは1本だけ（2本並ぶと同じ workspace へ二重に書く）
    expect(b.sessions.length + c.sessions.length).toBe(1);
    expect(sent.outcome).toBe('delivered');

    await f.pool.stop();
  });

  it('共有 FS なら作業ディレクトリごと引き継ぐ', async () => {
    const a = rig('runner-a', 'sess-a');
    const b = rig('runner-b', 'sess-b');
    const f = fleet([a], { workspace: { kind: 'shared-volume', path: '/mnt/shared/app' } });

    await f.pool.start({ request: '共有 FS の上で作業' });
    await expect
      .poll(async () => (await f.stores.jobs.listJobs())[0]?.sessionId, { timeout: 2000 })
      .toBeDefined();

    f.registry.register(b.client);
    a.kill();
    f.advance(3_000);
    await f.registry.heartbeat();

    await expect.poll(() => b.sessions.length, { timeout: 2000 }).toBe(1);
    const job = (await f.stores.jobs.listJobs())[0];
    // 同じパスが見えるので、作業ディレクトリは変わらない
    expect(job?.cwd).toBe('/mnt/shared/app');
    expect((b.sessions[0] as FakeSession).options.cwd).toBe('/mnt/shared/app');
    expect((b.sessions[0] as FakeSession).inputs.join('|')).toContain('そのまま残っている');

    await f.pool.stop();
  });

  it('移送できないときは、復旧不能な未永続状態を明示する（受け入れ基準4 の後段）', async () => {
    const a = rig('runner-a', 'sess-a');
    const b = rig('runner-b', 'sess-b');
    // 既定（runner ごとの volume）= その器の中にしか作業が無い
    const f = fleet([a]);

    const started = await f.pool.start({ request: 'コミットせずに作業中' });
    await expect
      .poll(async () => (await f.stores.jobs.listJobs())[0]?.sessionId, { timeout: 2000 })
      .toBeDefined();

    f.registry.register(b.client);
    a.kill();
    f.advance(3_000);
    await f.registry.heartbeat();

    // 黙って別の器で開き直さない（開き直せば、無い作業ディレクトリの上で続きが進む）
    await expect
      .poll(
        () =>
          f.inbox.some(
            (event) =>
              event.type === 'manager_message' && event.text.includes('続きを開けない状態'),
          ),
        { timeout: 2000 },
      )
      .toBe(true);
    expect(b.sessions.length).toBe(0);

    const notice = f.inbox.find(
      (event) => event.type === 'manager_message' && event.text.includes('続きを開けない'),
    );
    if (notice?.type !== 'manager_message') throw new Error('通知が無い');
    // 何が残り、何が失われたのかが読み取れること
    expect(notice.text).toContain('セッション（会話の続き）は預かってある');
    expect(notice.text).toContain('コミットしていない変更は復旧できない');
    expect(notice.text).toContain('人間に確認する');

    // 話しかけても、勝手に別の器へ移して「届いた」とは言わない
    const sent = await f.pool.send(started.managerId, 'どうなった？');
    expect(sent.outcome).toBe('unknown');
    expect(sent.detail).toContain('復旧できない');

    await f.pool.stop();
  });
});

describe('1台構成との等価性（M5 の回帰テスト）', () => {
  /** 委譲 → 確認 → 回答 → 報告、という一本の経路を器の数だけ変えて通す。 */
  async function walkThrough(count: number) {
    const rigs = Array.from({ length: count }, (_, index) =>
      rig(`runner-${index}`, `sess-${index}`),
    );
    const f = fleet(rigs);
    const started = await f.pool.start({ request: '同じ仕事' });

    const host = rigs.find((entry) => entry.client.runnerId === started.runnerId) as Rig;
    const session = host.sessions[0] as FakeSession;

    const asked = session.ask('AskUserQuestion', { questions: [{ question: 'どっち？' }] });
    await expect
      .poll(() => f.inbox.filter((event) => event.type === 'manager_message').length, {
        timeout: 2000,
      })
      .toBeGreaterThan(0);
    const question = f.inbox.find(
      (event) => event.type === 'manager_message' && event.kind === 'question',
    );
    if (question?.type !== 'manager_message') throw new Error('質問が届いていない');

    const answered = await f.pool.send(started.managerId, '左で', {
      ...(question.requestId === undefined ? {} : { requestId: question.requestId }),
    });
    await asked;
    await session.report('終わった');
    await expect
      .poll(() => (f.inbox.at(-1) as { text?: string }).text, { timeout: 2000 })
      .toBe('終わった');

    const list = await f.pool.list();
    const options = session.options;
    await f.pool.stop();

    return {
      outcome: answered.outcome,
      question: question.text,
      managers: list.length,
      // 能力に関わるものは器の数で変わってはいけない
      model: options.model,
      tools: options.tools,
      maxTurns: options.maxTurns,
      permissionMode: options.permissionMode,
      settingSources: options.settingSources,
      agents: Object.keys(options.agents ?? {}),
    };
  }

  it('1台でも3台でも、能力もプロトコルも同じままである（M5 のゴール）', async () => {
    const single = await walkThrough(1);
    const many = await walkThrough(3);

    expect(many).toEqual(single);
    expect(single.outcome).toBe('answered');
    expect(single.model).toBe('opus');
    // 器が増えても道具は絞られない / 上限は入らない（禁止1・2）
    expect(single.tools).toBeUndefined();
    expect(single.maxTurns).toBeUndefined();
    expect(single.permissionMode).toBeUndefined();
  });

  it('器の数に関係なく、同時に走らせる本数に上限を作らない（受け入れ基準5）', async () => {
    // 1台に何本でも積める（詰まっていることは資源に現れるが、断りはしない）
    const one = rig('runner-solo', 'sess-solo');
    const solo = fleet([one]);
    for (let index = 0; index < 6; index += 1) {
      await expect(solo.pool.start({ request: `${index}本目` })).resolves.toBeDefined();
    }
    expect(one.sessions.length).toBe(6);
    expect((await solo.pool.list()).length).toBe(6);
    await solo.pool.stop();

    // 器を減らしても増やしても、既にある能力は落ちない
    const a = rig('runner-a', 'sess-a');
    const b = rig('runner-b', 'sess-b');
    const pair = fleet([a, b]);
    for (let index = 0; index < 4; index += 1) {
      await expect(pair.pool.start({ request: `${index}本目` })).resolves.toBeDefined();
    }
    expect(a.sessions.length + b.sessions.length).toBe(4);
    await pair.pool.stop();
  });
});
