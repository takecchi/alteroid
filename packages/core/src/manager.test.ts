import type {
  query as sdkQuery,
  AgentDefinition,
  CanUseTool,
  HookCallbackMatcher,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SessionStoreEntry,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MANAGER_MODEL,
  WORKER_AGENT_NAME,
  WORKER_MODEL,
  WITHHELD_ENV_KEYS,
  createManagerPool,
  type ManagerPool,
  type RunnerFleetOverview,
} from './manager.js';
import {
  MANAGER_MODEL_ENV_KEY,
  WORKER_MODEL_ENV_KEY,
  placedManagerModels,
  resolveManagerModel,
  resolveWorkerModel,
} from './runner.js';
import { createProfileService } from './profile-service.js';
import { createLocalRunner } from './runner-local.js';
import {
  createRunnerRegistry,
  RunnerHttpError,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerCredentialFingerprint,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerEntry,
  type RunnerPlacementResources,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
  type RunnerRegistry,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type { InboxEvent, Job, JobStatus, JournalEntry } from './schema.js';
import { workspaceLocatorSchema } from './schema.js';
import type { Stores } from './store.js';
import {
  captureStderr,
  createMemoryStores,
  failingJobWrite,
  failingJournalAppend,
} from './testing.js';
import type { TokenRotatorObservation } from './token-rotator.js';
import type { UsageTotals } from './usage.js';

type WorkerWaitEvent = Extract<RunnerEvent, { type: 'worker_wait' }>;

/**
 * #252 の「知らせは全文を埋め込まない」試験だけが使う、末尾専用の目印。
 *
 * `.repeat()` で作った巨大な依頼文・報告は同じ語の繰り返しなので、末尾から
 * 適当に切り出しても、抜粋が残す先頭部分に**同じ文字列が偶然含まれる**
 * （このテストを書く過程で実際に起きた——`not.toContain` が意図せず先頭一致で
 * 落ちた）。切り詰めの外にしか存在しない一意な文字列を末尾へ足すことで、
 * 「本当に末尾（＝切り詰められた側）が含まれていないか」だけを見る。
 */
const REQUEST_TAIL_MARKER = 'REQUEST-TAIL-MARKER-9f3c2a91';
const REPORT_TAIL_MARKER = 'REPORT-TAIL-MARKER-7e1b44de';

/**
 * SDK を実際に呼ばずに委譲の配線を検証する。
 *
 * ここで固定したいのは北極星に由来する不変条件（モデル帯・`tools` を渡さないこと・
 * 上限を置かないこと・認証情報を配らないこと）と、エスカレーションが一本の経路で
 * 通ること。SDK 実呼び出しの確認は手動で行う。
 */
interface FakeSession {
  options: Options;
  inputs: string[];
  /** マネージャー側から「確認したい」と言う。返るのは SDK へ返す許可結果。 */
  ask(
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    requestId?: string,
  ): Promise<PermissionResult>;
  /** マネージャーが本文を1つ喋る（人間の画面に出るもの）。 */
  say(text: string, options?: { parentToolUseId?: string }): Promise<void>;
  /** マネージャー側の1ターンが終わる。 */
  report(text: string): Promise<void>;
  /** PostToolUse フックを鳴らす。 */
  usedTool(tool: string, extra?: Record<string, unknown>): Promise<void>;
  /**
   * SDK が上限の文言を通知として出す（Issue #393）。
   *
   * **この口が無かったせいで、`ManagerPool#onEvent` の `usage_notice` を測る歯が
   * 1本も書けなかった**（`onEvent` は private で、runner のイベント経由でしか
   * 届かない）。押し込む先は runner の `system/notification` の経路である。
   */
  noticeLimit(text: string): Promise<void>;
  /**
   * SDK が枠の事実を出す（Issue #393）。**ターンの頭ごとに来るもの。**
   *
   * これも上と同じ理由で口が無かった。
   */
  rateLimit(info: Record<string, unknown>): Promise<void>;
}

function fakeSdk() {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    let emit: ((message: SDKMessage) => void) | null = null;
    let asks = 0;
    // **#206: `result` メッセージの `uuid` は実機では毎ターン別の値になる**
    // （SDK が result ごとに払う）。`runner.ts` はこれを `reportId` として
    // そのまま運ぶので、この fake が固定値を返すと2回目以降の `report()` が
    // 冪等化で握りつぶされ、実機では起きない重複扱いになる。ターンごとに
    // 別の値にして、この fake を実機の形へ寄せる。
    let reports = 0;
    const buffered: SDKMessage[] = [];
    const inputs: string[] = [];

    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };

    const session: FakeSession = {
      options,
      inputs,
      async ask(toolName, input, signal, requestId) {
        const canUseTool = options.canUseTool as CanUseTool;
        // SDK は1回の応答で並列に呼ばれた道具を、それぞれ別の request_id で
        // 同時に降ろしてくる。既定でも被らせない。
        const id = requestId ?? `req-${(asks += 1)}`;
        const result = await canUseTool(toolName, input, {
          signal: signal ?? new AbortController().signal,
          toolUseID: `tool-${id}`,
          requestId: id,
        } as never);
        if (result === null) throw new Error('canUseTool が null を返した（返事が届かない）');
        return result;
      },
      async noticeLimit(text) {
        push({
          type: 'system',
          subtype: 'notification',
          text,
          session_id: 'sess-mgr',
          uuid: `uuid-notice-${String(text.length)}`,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async rateLimit(info) {
        push({
          type: 'rate_limit_event',
          rate_limit_info: info,
          session_id: 'sess-mgr',
          uuid: `uuid-ratelimit-${String(Object.keys(info).length)}`,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async say(text, sayOptions = {}) {
        push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
          parent_tool_use_id: sayOptions.parentToolUseId ?? null,
          session_id: 'sess-mgr',
          uuid: `uuid-say-${text.length}`,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async report(text) {
        push({
          type: 'result',
          subtype: 'success',
          result: text,
          session_id: 'sess-mgr',
          uuid: `uuid-result-${(reports += 1)}`,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async usedTool(tool, extra = {}) {
        const matchers = options.hooks?.PostToolUse as HookCallbackMatcher[];
        for (const matcher of matchers) {
          for (const hook of matcher.hooks) {
            await hook(
              {
                hook_event_name: 'PostToolUse',
                tool_name: tool,
                tool_input: { a: 1 },
                transcript_path: '/tmp/does-not-exist.jsonl',
                ...extra,
              } as never,
              undefined,
              { signal: new AbortController().signal },
            );
          }
        }
      },
    };
    sessions.push(session);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      // クローンからの入力を読み続ける裏方（ここでは記録するだけ）
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
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions };
}

interface Setup {
  pool: ManagerPool;
  stores: Stores;
  sessions: FakeSession[];
  inbox: InboxEvent[];
  runner: RunnerClient;
}

interface SetupOptions {
  stores?: Stores;
  withheldEnvKeys?: readonly string[];
  /** 差し替えると runner ごと入れ替えられる（HTTP 越しの検証に使う）。 */
  runner?: RunnerClient;
  /** 衝突を再現する試験のための注入口（`ManagerPoolOptions.generateManagerId`）。 */
  generateManagerId?: () => string;
  /** 枠の観測を回し手へ渡す口（Issue #393）。 */
  onUsageObservation?: (observation: TokenRotatorObservation) => Promise<void>;
  /** いま撒かれているトークンの身元（Issue #393）。 */
  tokenIdentity?: () => { tokenId: string; generation: number } | undefined;
  /** 名乗ってきた runner へ鍵を降ろす口（Issue #393）。 */
  syncRunnerToken?: (runner: RunnerClient) => Promise<void>;
}

/**
 * デーモン側のプール＋同一プロセスの runner。
 *
 * SDK を握るのは runner なので、偽の `query` は runner に渡す。デーモンは
 * `RunnerRegistry` しか知らない（固定 URL も runner の内部も前提にしない）。
 */
function setup(
  env: NodeJS.ProcessEnv = { PATH: '/usr/bin', ALTEROID_HOME: '/secret' },
  options: SetupOptions = {},
): Setup {
  const { fn, sessions } = fakeSdk();
  const stores = options.stores ?? createMemoryStores();
  const inbox: InboxEvent[] = [];
  const runner =
    options.runner ??
    createLocalRunner({
      runnerId: 'runner-test',
      workspacePath: '/work/project',
      queryFn: fn,
      env,
      ...(options.withheldEnvKeys === undefined
        ? {}
        : { withheldEnvKeys: options.withheldEnvKeys }),
    });
  const registry = createRunnerRegistry([runner]);
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    // **本番と同じ1本道を通す。** 降ろし直しは更新と同じ列に入る必要があるので、
    // ここを省くと「重なったら壊れる」経路をテストが見なくなる。
    profile: createProfileService({ stores, runners: registry }),
    ...(options.generateManagerId === undefined
      ? {}
      : { generateManagerId: options.generateManagerId }),
    ...(options.onUsageObservation === undefined
      ? {}
      : { onUsageObservation: options.onUsageObservation }),
    ...(options.tokenIdentity === undefined ? {} : { tokenIdentity: options.tokenIdentity }),
    ...(options.syncRunnerToken === undefined ? {} : { syncRunnerToken: options.syncRunnerToken }),
  });
  return { pool, stores, sessions, inbox, runner };
}

describe('マネージャー', () => {
  it('層とモデル帯の対応、道具の配置を固定する（北極星の不変条件）', async () => {
    const s = setup();
    await s.pool.start({ request: 'ログイン周りを直して' });

    const { options } = s.sessions[0] as FakeSession;

    // マネージャー = Opus / 作業者 = Sonnet。変更には人間の承認が要る（地雷5）
    expect(options.model).toBe(MANAGER_MODEL);
    expect(MANAGER_MODEL).toBe('opus');

    const worker = (options.agents ?? {})[WORKER_AGENT_NAME] as AgentDefinition;
    expect(worker.model).toBe(WORKER_MODEL);
    expect(WORKER_MODEL).toBe('sonnet');

    // `tools` を明示リストで絞らない（地雷1）。作業者は tools 省略 = 全継承
    expect(options.tools).toBeUndefined();
    expect(options.allowedTools).toBeUndefined();
    expect(options.disallowedTools).toBeUndefined();
    expect(worker.tools).toBeUndefined();
    expect(worker.disallowedTools).toBeUndefined();

    // ターン数・予算の上限で暴走を止めない（地雷2）
    expect(options.maxTurns).toBeUndefined();
    expect(options.maxBudgetUsd).toBeUndefined();
    expect(worker.maxTurns).toBeUndefined();

    // 権限モードは人間が Claude Code を開いたときと同じ（Auto）。`canUseTool` の
    // 配線はそのまま残す（要件。既定で確認を出すかどうかだけが変わる）
    expect(options.permissionMode).toBe('auto');
    expect(typeof options.canUseTool).toBe('function');

    // 人間と同じ設定・同じ .mcp.json を渡す（下向きは同じものが見える）
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    expect(options.cwd).toBe('/work/project');

    // Claude Code 既定のシステムプロンプトを置き換えない（置き換え = デグレード）
    expect(options.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });

    await s.pool.stop();
  });

  it('モデル帯の既定は環境変数で動かない。空・空白は既定に落ちる', () => {
    for (const env of [{}, { [MANAGER_MODEL_ENV_KEY]: '' }, { [MANAGER_MODEL_ENV_KEY]: '   ' }]) {
      expect(resolveManagerModel(env)).toBe(MANAGER_MODEL);
    }
    for (const env of [{}, { [WORKER_MODEL_ENV_KEY]: '' }, { [WORKER_MODEL_ENV_KEY]: '   ' }]) {
      expect(resolveWorkerModel(env)).toBe(WORKER_MODEL);
    }

    // 空文字が既定へ落ちることは器の都合でもある。compose は `${VAR:-}` で
    // 渡すので、未設定の変数は空文字として届く。ここを `!== undefined` で見ると
    // 空文字がそのまま SDK へ流れて起動時に落ちる。

    // 人間が置いた値だけが効く。既知の別名で関門を作らない（SDK が増やした
    // モデルを人間が選べなくなる＝能力の削除。north_star 禁止1）
    expect(resolveManagerModel({ [MANAGER_MODEL_ENV_KEY]: 'fable' })).toBe('fable');
    expect(resolveManagerModel({ [MANAGER_MODEL_ENV_KEY]: '  fable  ' })).toBe('fable');
    expect(resolveWorkerModel({ [WORKER_MODEL_ENV_KEY]: 'まだ無いモデル' })).toBe('まだ無いモデル');
  });

  it('置かれたかどうかは、既定と同じ値を置いた場合も「置いた」である', () => {
    expect(placedManagerModels({})).toEqual([]);
    expect(placedManagerModels({ [MANAGER_MODEL_ENV_KEY]: '  ' })).toEqual([]);

    // **値の比較で言い換えられない。** ここが答えているのは「差し替えの承認が
    // 置かれているか」であって「既定と違うか」ではない（起動ログに出す判断の材料）。
    expect(placedManagerModels({ [MANAGER_MODEL_ENV_KEY]: MANAGER_MODEL })).toEqual([
      { key: MANAGER_MODEL_ENV_KEY, value: MANAGER_MODEL, fallback: MANAGER_MODEL },
    ]);

    expect(
      placedManagerModels({
        [MANAGER_MODEL_ENV_KEY]: 'fable',
        [WORKER_MODEL_ENV_KEY]: 'haiku',
      }),
    ).toEqual([
      { key: MANAGER_MODEL_ENV_KEY, value: 'fable', fallback: MANAGER_MODEL },
      { key: WORKER_MODEL_ENV_KEY, value: 'haiku', fallback: WORKER_MODEL },
    ]);
  });

  it('差し替えた帯が、実際に SDK へ渡るマネージャーと作業者の両方に効く', async () => {
    const s = setup({
      PATH: '/usr/bin',
      [MANAGER_MODEL_ENV_KEY]: 'fable',
      [WORKER_MODEL_ENV_KEY]: 'haiku',
    });
    await s.pool.start({ request: 'ログイン周りを直して' });

    const { options } = s.sessions[0] as FakeSession;
    expect(options.model).toBe('fable');

    const worker = (options.agents ?? {})[WORKER_AGENT_NAME] as AgentDefinition;
    expect(worker.model).toBe('haiku');

    await s.pool.stop();
  });

  it('マネージャーだけ差し替えても、作業者は巻き添えで動かない', async () => {
    // **作業者の `model` を省略すると SDK の既定は親の継承になる。** 省いてあると
    // マネージャーを差し替えた人が作業者まで一緒に動かすことになり、「切り出した
    // 実作業だけ安く回す」という階層の意味が消える（north_star の前提）。
    const s = setup({ PATH: '/usr/bin', [MANAGER_MODEL_ENV_KEY]: 'fable' });
    await s.pool.start({ request: 'ログイン周りを直して' });

    const { options } = s.sessions[0] as FakeSession;
    expect(options.model).toBe('fable');

    const worker = (options.agents ?? {})[WORKER_AGENT_NAME] as AgentDefinition;
    expect(worker.model).toBe(WORKER_MODEL);
    expect(worker.model).toBe('sonnet');

    await s.pool.stop();
  });

  it('記憶ストアの所在を子プロセスへ渡さない（非対称な可視性は境界で守る）', async () => {
    const s = setup({ PATH: '/usr/bin', ALTEROID_HOME: '/secret', ALTEROID_PORT: '4517' });
    await s.pool.start({ request: '調べて' });

    const env = (s.sessions[0] as FakeSession).options.env ?? {};
    for (const key of WITHHELD_ENV_KEYS) expect(env[key]).toBeUndefined();
    // 一方で、人間が使っている環境そのものは削らない（PATH を落とすとただの故障）
    expect(env.PATH).toBe('/usr/bin');

    await s.pool.stop();
  });

  /**
   * **この歯が単独で守るもの**: 報告が降りてきた瞬間に、デーモンが**受け取った
   * 時刻を刻む**こと（#358）。
   *
   * **描き方の歯とは別物である。** `tools.test.ts` の `manager_list` の歯は
   * `ManagerSummary.lastReportAt` を**直接代入して**出力の形を測っており、
   * 「刻む」側は1本も通っていない。**実測（変異試験、2026-08-24）**: この歯を
   * 足す前に `record.job.lastReportAt = new Date().toISOString();` を消す変異を
   * 当てたところ、**5本の変異のうちこれだけが生存した** —— 描き方の歯は全部
   * 緑のまま通った。
   *
   * **時刻そのものは固定できない**（`new Date()` を直接使う設計で、`lastFailure.at`
   * と同じ作法）。だから**区間で挟む** —— 報告の前後で取った時刻の間に在ることを
   * 見る。これは「何か文字列が入った」より強く、「特定の値」より脆くない。
   */
  it('報告が降りてきたら、デーモンが受け取った時刻が委譲の要約に載る（#358）', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });

    const before = Date.now();
    await (s.sessions[0] as FakeSession).report('終わった');
    const after = Date.now();

    const [summary] = await s.pool.list();
    expect(summary?.lastReport).toBe('終わった');
    const at = summary?.lastReportAt;
    // **存在だけでは足りない。** 刻んだ値が「受け取った瞬間」であることまで見る。
    expect(at).toBeDefined();
    const stamped = Date.parse(at ?? '');
    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);

    await s.pool.stop();
  });

  it('委譲はノンブロッキングで、複数を同時に走らせられる（受け入れ基準1）', async () => {
    const s = setup();

    const a = await s.pool.start({ request: 'A をやって' });
    const b = await s.pool.start({ request: 'B をやって', cwd: '/work/other' });

    expect(s.sessions).toHaveLength(2);
    expect((await s.pool.list()).map((m) => m.managerId).sort()).toEqual(
      [a.managerId, b.managerId].sort(),
    );

    // 交錯して届く報告を、どちらのものか分かる形で受信箱へ流す
    await (s.sessions[1] as FakeSession).report('B 終わった');
    await (s.sessions[0] as FakeSession).report('A 終わった');

    const reports = s.inbox.filter((event) => event.type === 'manager_message');
    expect(reports.map((event) => [event.managerId, event.text])).toEqual([
      [b.managerId, 'B 終わった'],
      [a.managerId, 'A 終わった'],
    ]);

    await s.pool.stop();
  });

  it('既定では当たり障りのない道具で確認を出さない（permissionMode: auto）', async () => {
    // 人間が Claude Code を開けば `Read` や `grep` でいちいち止まらない。層を
    // 下りた瞬間にそれが止まるならデグレード（north_star 禁止1）であって仕様ではない。
    const s = setup();
    await s.pool.start({ request: 'ログイン周りを直して' });

    const { options } = s.sessions[0] as FakeSession;
    expect(options.permissionMode).toBe('auto');
    // 経路そのものは残す。既定で確認を出すかどうかだけを変えている。
    expect(typeof options.canUseTool).toBe('function');

    await s.pool.stop();
  });

  it('許可確認はクローンへ回り、返事が来るまでその仕事だけが止まる（受け入れ基準2）', async () => {
    // 都度確認へ戻した状態＝設定を戻せば従来どおり動くことの証明でもある。
    const s = setup({
      PATH: '/usr/bin',
      ALTEROID_HOME: '/secret',
      ALTEROID_MANAGER_PERMISSION_MODE: 'default',
    });
    const { managerId } = await s.pool.start({ request: 'デプロイして' });
    const session = s.sessions[0] as FakeSession;
    expect(session.options.permissionMode).toBe('default');

    const asked = session.ask('Bash', { command: 'git push' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // クローンの受信箱に許可確認として届く
    const event = s.inbox.find((entry) => entry.type === 'manager_message');
    expect(event).toMatchObject({ kind: 'permission', managerId });
    expect((event as { requestId?: string }).requestId).toBeTruthy();

    // 止まっているのはこの仕事だけ（一覧からもそう見える）
    const waiting = (await s.pool.list()).find((m) => m.managerId === managerId);
    expect(waiting?.status).toBe('waiting_human');
    expect(waiting?.waiting[0]?.summary).toContain('Bash');

    // クローンが答えると、そこだけが再開する
    const result = await s.pool.send(managerId, 'よい', { decision: 'allow' });
    expect(result.outcome).toBe('answered');
    expect(await asked).toEqual({ behavior: 'allow' });
    expect((await s.pool.list()).find((m) => m.managerId === managerId)?.status).toBe('running');

    // 誰が何を聞かれ、何と答えたかが日誌だけで追える（受け入れ基準4）
    const escalations = (await s.stores.journal.list({ types: ['escalation'] })) as {
      managerId?: string;
      answer?: string;
    }[];
    expect(escalations.map((entry) => [entry.managerId, entry.answer])).toEqual([
      [managerId, '[allow] よい'],
      [managerId, undefined],
    ]);

    await s.pool.stop();
  });

  /**
   * **issue #287 の続き。** `case 'ask'` の `summary` は runner.ts の
   * `#onPermission` が `` `${toolName} の実行許可: ${brief(input)}` `` の形
   * で組み立てる（`brief()` は道具の呼び出し引数の JSON ダンプで、AI が
   * 書いた文章ではない）。この `text` を `<Markdown>` で描く面
   * （`apps/web` の `commitments.tsx`）でバッククォート等が `<code>` に
   * 食われて消えるのを防ぐため、`kind === 'permission'` のときだけ
   * `markup: 'none'` を立てる。
   */
  it("実行許可の確認は manager_message に markup: 'none' が立つ（#287）", async () => {
    const s = setup();
    await s.pool.start({ request: 'デプロイして' });
    const session = s.sessions[0] as FakeSession;

    // `command` にバッククォートを含めておく——立てなければ化ける入力の実例。
    session.ask('Bash', { command: 'echo `date`' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const event = s.inbox.find((entry) => entry.type === 'manager_message');
    expect(event).toMatchObject({ kind: 'permission' });
    expect((event as { markup?: string }).markup).toBe('none');

    await s.pool.stop();
  });

  it('deny は理由付きでマネージャーへ返る（会話は続く。能力は削らない）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: 'デプロイして' });
    const session = s.sessions[0] as FakeSession;

    const asked = session.ask('Bash', { command: 'rm -rf /' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await s.pool.send(managerId, 'それはやめて、代わりに一覧だけ見せて', { decision: 'deny' });

    expect(await asked).toMatchObject({
      behavior: 'deny',
      message: 'それはやめて、代わりに一覧だけ見せて',
    });

    await s.pool.stop();
  });

  it('AskUserQuestion にはクローンの言葉がそのまま回答として入る', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '設計を相談したい' });
    const session = s.sessions[0] as FakeSession;

    // #313 以降、回答として消費されるのは requestId か decision が在るものだけ。
    // 質問に allow/deny は無いので、宛先（requestId）で特定する。測っている性質
    // （クローンの言葉がそのまま answers に入る）は変わっていない。
    const asked = session.ask(
      'AskUserQuestion',
      {
        questions: [
          { question: 'DB はどちらにする？', header: 'DB', options: [], multiSelect: false },
        ],
      },
      undefined,
      'req-db',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(s.inbox.find((e) => e.type === 'manager_message')).toMatchObject({
      kind: 'question',
      text: 'DB はどちらにする？',
    });

    await s.pool.send(managerId, 'PostgreSQL で', { requestId: 'req-db' });
    expect(await asked).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'DB はどちらにする？': 'PostgreSQL で' } },
    });

    // **#322: AskUserQuestion の常時 allow は、以前は journal から1文字も
    // 読めなかった。** `decision` を付けずに答えた回でも `[allow]` が残ること
    // をここで見る（`decision を書き忘れても…` テストが permission 側で見て
    // いるのと対になる、question 側の回帰）。
    const escalations = (await s.stores.journal.list({ types: ['escalation'] })) as {
      answer?: string;
    }[];
    expect(escalations[0]?.answer).toBe('[allow] PostgreSQL で');

    await s.pool.stop();
  });

  /**
   * **issue #287 の続き。** `question` 側の `summary`
   * （`describeQuestions(input)`）はモデル自身が書いた質問文であり、
   * 「AI が書いたものは Markdown として描く」という既存の軸に乗る。
   * `markup: 'none'` は `kind === 'permission'` のときにしか立てないので、
   * ここでは `markup` という**キーそのものが無い**ことを見る
   * （`undefined` が値として入っているのではなく、`in` で見て無い）。
   */
  it("AskUserQuestion の確認には manager_message に markup のキーが無い（#287）", async () => {
    const s = setup();
    await s.pool.start({ request: '設計を相談したい' });
    const session = s.sessions[0] as FakeSession;

    session.ask(
      'AskUserQuestion',
      {
        questions: [
          { question: 'DB はどちらにする？', header: 'DB', options: [], multiSelect: false },
        ],
      },
      undefined,
      'req-db-markup',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const event = s.inbox.find((e) => e.type === 'manager_message');
    expect(event).toMatchObject({ kind: 'question' });
    expect(event && 'markup' in event).toBe(false);

    await s.pool.stop();
  });

  /**
   * **#322 の core: AskUserQuestion は decision を一切見ない。** ここでは
   * わざと矛盾した `decision: 'deny'` を明示して答え、それでも allow へ
   * 解決されること（既存の挙動。runner.ts の `#onPermission` が元々そう
   * 実装している）と、その事実が journal からも読めること（この Issue の
   * 直す対象）の両方を1本で確かめる。
   */
  it('AskUserQuestion は decision を明示しても無視して常に allow になり、その事実が journal に残る（#322）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '設計を相談したい' });
    const session = s.sessions[0] as FakeSession;

    const asked = session.ask(
      'AskUserQuestion',
      {
        questions: [
          { question: 'DB はどちらにする？', header: 'DB', options: [], multiSelect: false },
        ],
      },
      undefined,
      'req-db-deny',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // **矛盾した decision を渡す。** 質問への回答に allow/deny という概念は
    // 無いので、これは無視されて allow になるはずである。
    await s.pool.send(managerId, 'PostgreSQL で', {
      requestId: 'req-db-deny',
      decision: 'deny',
    });
    expect(await asked).toMatchObject({ behavior: 'allow' });

    const escalations = (await s.stores.journal.list({ types: ['escalation'] })) as {
      answer?: string;
    }[];
    // **`decision: 'deny'` を渡したのに `[deny]` にはならない。** ここが
    // 変わっていたら、`decideAnswer` が `kind` を見ずに `decision` を素通し
    // している（＝仕様が壊れている）ことを意味する。
    expect(escalations[0]?.answer).toBe('[allow] PostgreSQL で');

    await s.pool.stop();
  });

  /**
   * **複数の確認が同時に待っているときの断りにも上限が要る（#409）。**
   * `send()` が requestId 無しで呼ばれ複数件が待っていると「複数の確認を
   * 同時に待っている」と断って `record.waiting` を列挙するが、この列挙に
   * 上限も合図も無かった——1件ごとの `summary` は自由文（質問文）なので、
   * 大量に同時待ちがあれば直接の返り値がそのまま伸びる。ここでは抜粋の
   * 合図（`excerptLine` の「省略」）が出て、伸び続けないことを見る。
   */
  it('大量の確認が同時に待っていても、あいまいさの断りは抜粋の合図で締まる', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '設計を相談したい' });
    const session = s.sessions[0] as FakeSession;

    const count = 30;
    for (let index = 0; index < count; index += 1) {
      session.ask(
        'AskUserQuestion',
        {
          questions: [
            {
              question: `質問その${index}はどうしますか、長めの本文で埋めておく`,
              header: 'Q',
              options: [],
              multiSelect: false,
            },
          ],
        },
        undefined,
        `req-ambiguous-${index}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    // requestId を渡さない——複数件が同時に待っているので「あいまい」に落ちる。
    // `decision` が無いと「追加指示」として流れるだけなので（`#choosePending`
    // の doc）、あいまい分岐に届かせるためにここでは明示する。
    const result = await s.pool.send(managerId, 'どれのこと？', { decision: 'allow' });
    expect(result.outcome).toBe('unknown');
    // 30件の生の列挙をそのまま出せば数千文字になる。ここでは合図が出て、
    // 際限なく伸びていないことを見る。
    expect(result.detail?.length).toBeLessThan(1_000);
    expect(result.detail).toMatch(/省略/);

    await s.pool.stop();
  });

  /**
   * **一覧が種別を持つこと自体を測る（#334）。** 直前のテストは「質問への
   * 回答がそのまま answers に入る」という別の性質を測っており、`kind` の
   * 値そのものは `toMatchObject` で1回しか通していない。ここでは
   * `s.pool.list()`（画面・クローンの `manager_list` が読む面そのもの）が
   * 返す `waiting` を主語にして、質問と実行許可の両方を同時に持たせ、
   * それぞれが正しい `kind` を名乗ることを見る。
   */
  it('AskUserQuestion の待ちは kind: question として一覧に出る / 実行許可の待ちは kind: permission として出る（#334）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '設計を相談したい' });
    const session = s.sessions[0] as FakeSession;

    session.ask(
      'AskUserQuestion',
      {
        questions: [
          { question: 'DB はどちらにする？', header: 'DB', options: [], multiSelect: false },
        ],
      },
      undefined,
      'req-kind-q',
    );
    session.ask('Bash', { command: 'git push' }, undefined, 'req-kind-p');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const waiting = (await s.pool.list()).find((m) => m.managerId === managerId)?.waiting ?? [];
    expect(waiting.find((item) => item.requestId === 'req-kind-q')?.kind).toBe('question');
    expect(waiting.find((item) => item.requestId === 'req-kind-p')?.kind).toBe('permission');

    await s.pool.stop();
  });

  /**
   * **`RunnerSession#state()` は呼ばれるたびに `askedAt` を取り直さない
   * （#334 / #323）ことを、`state()` を直接呼ぶ経路で測る。**
   *
   * ⚠️ 直前のテストや `manager.test.ts` の他の歯は `s.pool.list()`（＝
   * manager.ts の `record.waiting`。`ask` イベント経由で1度だけ埋まる）を
   * 見ている。**これだけでは `state()` 側の取り直しを検出できない** ——
   * 実際に変異試験（`.claude/skills/mutation-testing/`）で確かめた。
   * `state()` の `askedAt: request.askedAt` を `askedAt: new
   * Date().toISOString()` に変える変異は、`s.pool.list()` ベースの歯・
   * 「デーモン再起動でも kind と askedAt を保つ」歯（`swappableRunner` の
   * fake を使うテスト。実 runner を経由しない）のどちらでも生存したまま
   * だった。
   *
   * だからここでは `s.runner.list()`（`LocalRunner#list()` → `RunnerHost#list()`
   * → 各セッションの `state()` を直接呼ぶ、本番と同じ経路）を2回、実時間を
   * 空けて呼び、`askedAt` が両方の呼び出しで同じ値であることを直接見る。
   */
  it('runner.state() は呼ぶたびに askedAt を取り直さない（#334 / #323）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: 'デプロイして' });
    const session = s.sessions[0] as FakeSession;

    session.ask('Bash', { command: 'git push' }, undefined, 'req-stable');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const first = (await s.runner.list()).find((m) => m.managerId === managerId);
    const askedAtFirst = first?.waiting.find((item) => item.requestId === 'req-stable')?.askedAt;
    expect(askedAtFirst).toBeTruthy();

    // 実時間で間隔を空ける。取り直す変異ならここで別の値（別のミリ秒）になる。
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = (await s.runner.list()).find((m) => m.managerId === managerId);
    const askedAtSecond = second?.waiting.find((item) => item.requestId === 'req-stable')?.askedAt;

    expect(askedAtSecond).toBe(askedAtFirst);

    await s.pool.stop();
  });

  it('返事待ちでないときの manager_send は追加指示として届く（会話に戻れる）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '調べて' });

    const result = await s.pool.send(managerId, 'ついでにこれも見て');
    expect(result.outcome).toBe('delivered');

    await expect
      .poll(() => (s.sessions[0] as FakeSession).inputs, { timeout: 2000 })
      .toEqual(['調べて', 'ついでにこれも見て']);

    await s.pool.stop();
  });

  it('保留が1件でも、宛先も意思も示さないメッセージは回答として消費されない（#313）', async () => {
    // 直上の歯は「待ちが0件」の側。こちらは**待ちが1件ある**側で、かつては
    // 件数が1であることだけを根拠に、本文を見ずに先頭へ入れていた。宛先
    // （requestId）も意思（decision）も示していない普通の会話文が
    // inferDecision に落ちて {behavior:'allow'} に化けていた。
    const s = setup();
    const { managerId } = await s.pool.start({ request: 'デプロイして' });
    const session = s.sessions[0] as FakeSession;

    const asked = session.ask('Bash', { command: 'git push --force' }, undefined, 'req-only');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await s.pool.list()).find((m) => m.managerId === managerId)?.waiting).toHaveLength(1);

    const result = await s.pool.send(managerId, 'ところで、進捗はどうなっている？');

    // 回答ではなく追加指示として届く
    expect(result.outcome).toBe('delivered');
    await expect
      .poll(() => session.inputs, { timeout: 2000 })
      .toEqual(['デプロイして', 'ところで、進捗はどうなっている？']);
    // 確認は解けていない。誰も答えていないので待ち行列に残ったまま
    expect((await s.pool.list()).find((m) => m.managerId === managerId)?.waiting).toHaveLength(1);

    // **能力は削っていない** — 意思を示せば、待ちが1件のときは今までどおり通る
    const answered = await s.pool.send(managerId, 'よい', { decision: 'allow' });
    expect(answered.outcome).toBe('answered');
    expect(await asked).toEqual({ behavior: 'allow' });

    await s.pool.stop();
  });

  it('保留が1件でも、「待って」を含む普通の会話文は deny として消費されない（#313）', async () => {
    // 逆向きの誤射。DENIAL_PHRASES は部分一致なので、「少し待ってください」の
    // ような普通の文が deny になり、本文全文が**その道具を呼んだ主体**（作業者を
    // 含む）の tool 結果として返っていた。
    const s = setup();
    const { managerId } = await s.pool.start({ request: '公開して' });
    const session = s.sessions[0] as FakeSession;

    const asked = session.ask('Bash', { command: 'npm publish' }, undefined, 'req-wait');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result = await s.pool.send(managerId, 'その件は少し待ってください。先に状況を教えて');

    // **この歯の本題を先に測る** — 呼び出し元へ deny が返っていないこと。
    // outcome を先に見ると、消費されたときにそちらで落ちてしまい、
    // 「誰の tool 結果に何が返ったか」を名指しするこの行まで到達しない。
    const settled = await Promise.race([
      asked,
      new Promise((resolve) => setTimeout(() => resolve('unsettled'), 50)),
    ]);
    expect(settled).toBe('unsettled');

    expect(result.outcome).toBe('delivered');

    // **inferDecision は残っている** — requestId を添えた回答は今までどおり
    // 本文から拒否を読み取る
    await s.pool.send(managerId, 'やっぱり待って', { requestId: 'req-wait' });
    expect(await asked).toMatchObject({ behavior: 'deny', message: 'やっぱり待って' });

    await s.pool.stop();
  });

  it('マネージャーと作業者の全ツール実行が日誌に残る（受け入れ基準4）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '直して' });
    const session = s.sessions[0] as FakeSession;

    await session.usedTool('Edit');
    await session.usedTool('Bash', { agent_id: 'agent-1', agent_type: WORKER_AGENT_NAME });

    const entries = (await s.stores.journal.list({ types: ['tool_use'] })) as {
      actor: string;
      tool: string;
    }[];
    expect(entries.map((entry) => [entry.actor, entry.tool])).toEqual([
      [`worker:${managerId}:${WORKER_AGENT_NAME}`, 'Bash'],
      [`manager:${managerId}`, 'Edit'],
    ]);

    await s.pool.stop();
  });

  it('「永続性は確かめられなかった」が外向きの要約まで届く（黙って落とさない）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '直して' });

    const summary = (await s.pool.list()).find((m) => m.managerId === managerId);

    // **欄ごと消さない。** 消すと外からは「何も書かれていない」のと同じに見え、
    // 「取れなかった」という観測がそこで消える（AGENTS.md の地雷表と同じ形）。
    expect(summary?.workspace).toBeDefined();
    expect(summary?.workspace?.kind).toBe('unknown');
    // 値自身が理由を名乗る（読む側が「なぜ分からないか」を追加で引かなくてよい）。
    expect((summary?.workspace as { reason?: string } | undefined)?.reason ?? '').not.toBe('');

    await s.pool.stop();
  });

  it('過去に書かれた runner-volume の行は、そのまま読める（遡って直さない）', () => {
    // **既存の行は書き換えない**のがこのプロジェクトの方針なので、古い値は残る。
    // 残る以上、読めなくなってはいけない（読めなくすると台帳が壊れる）。
    const legacy = workspaceLocatorSchema.safeParse({
      kind: 'runner-volume',
      runnerId: 'runner-old',
      path: '/workspace',
    });

    expect(legacy.success).toBe(true);
  });

  it('manager_id → runner_id → session_id → workspace が JobStore に残る（resume の足がかり）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '直して' });

    await expect
      .poll(async () => (await s.stores.jobs.listJobs())[0]?.sessionId, { timeout: 2000 })
      .toBe('sess-mgr');

    const job = (await s.stores.jobs.listJobs())[0];
    expect(job).toMatchObject({
      id: managerId,
      request: '直して',
      cwd: '/work/project',
      // 宛先（どの runner か）と workspace の所在まで残す。ここが欠けると、
      // runner が増えた瞬間に manager_send の宛先が決まらない。
      runnerId: 'runner-test',
      // **永続性は断定しない。** どこに在るか（`runnerId` / `path`）は言えるが、
      // その器の workspace が入れ替えを跨いで残るかはデーモンからは分からない。
      workspace: {
        kind: 'unknown',
        runnerId: 'runner-test',
        path: '/work/project',
        reason: expect.stringContaining('確かめられない') as unknown as string,
      },
    });

    // **確かめていない永続性を名乗らない。** ここが `runner-volume` に戻ると、
    // ボリュームを付けない構成（`railway/README.md`「workspace は毎デプロイで
    // 消える」）で台帳が偽になり、しかも「復旧できる」と信じる方向へ嘘をつく。
    expect(job?.workspace?.kind).not.toBe('runner-volume');
    // 理由の無い「分からない」は値と同じなので、空を許さない。
    expect((job?.workspace as { reason?: string } | undefined)?.reason ?? '').not.toBe('');

    // **runner のローカルパスは台帳に持たない。** 生ログへは runner の API か、
    // 預かったアーカイブ／セッションから降りる（デーモンは runner の中を仮定しない）。
    await (s.sessions[0] as FakeSession).usedTool('Read');
    expect(job).not.toHaveProperty('transcriptPath');

    await s.pool.stop();
  });

  it('停止時に返事待ちを宙吊りにしない', async () => {
    const s = setup();
    await s.pool.start({ request: 'デプロイして' });
    const asked = (s.sessions[0] as FakeSession).ask('Bash', { command: 'git push' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await s.pool.stop();
    expect(await asked).toMatchObject({ behavior: 'deny' });
  });

  it('同時に複数を待っているとき、回答は requestId の宛先へ届く（取り違えない）', async () => {
    // 1回の応答で並列に道具を呼ぶと、確認は同時に複数降りてくる。宛先を見ずに
    // 先頭へ入れると、拒否のつもりの一言が別の質問の答えになり、拒否したかった
    // 道具は次の一言で通ってしまう。
    const s = setup();
    const { managerId } = await s.pool.start({ request: '整理して' });
    const session = s.sessions[0] as FakeSession;

    const question = session.ask('AskUserQuestion', {
      questions: [{ question: 'DB は？', header: 'DB', options: [], multiSelect: false }],
    });
    const danger = session.ask('Bash', { command: 'rm -rf /' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const waiting = (await s.pool.list()).find((m) => m.managerId === managerId)?.waiting ?? [];
    expect(waiting).toHaveLength(2);
    const dangerId = waiting.find((item) => item.summary.includes('Bash'))?.requestId as string;
    const questionId = waiting.find((item) => item.summary.includes('DB'))?.requestId as string;

    // 宛先を書かずに答えるのは拒む（推測して取り違えるより、聞き返す）
    const guessed = await s.pool.send(managerId, 'それは危険なのでやめて', { decision: 'deny' });
    expect(guessed.outcome).toBe('unknown');
    expect(guessed.detail).toContain('requestId');

    // 宛先を指せば、その1件だけが解ける
    await s.pool.send(managerId, 'それは危険なのでやめて', {
      decision: 'deny',
      requestId: dangerId,
    });
    expect(await danger).toMatchObject({ behavior: 'deny', message: 'それは危険なのでやめて' });

    await s.pool.send(managerId, 'PostgreSQL で', { requestId: questionId });
    expect(await question).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'DB は？': 'PostgreSQL で' } },
    });

    await s.pool.stop();
  });

  it('同じ確認が再送されても、待ちを二重に積まない（回答が二重に消費されない）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '調べて' });
    const session = s.sessions[0] as FakeSession;

    const first = session.ask('Bash', { command: 'ls' }, undefined, 'req-same');
    const again = session.ask('Bash', { command: 'ls' }, undefined, 'req-same');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await s.pool.list()).find((m) => m.managerId === managerId)?.waiting).toHaveLength(1);

    await s.pool.send(managerId, 'よい', { decision: 'allow', requestId: 'req-same' });
    expect(await first).toEqual({ behavior: 'allow' });
    expect(await again).toEqual({ behavior: 'allow' });

    await s.pool.stop();
  });

  it('decision を書き忘れても、日本語の拒否を承認と読み違えない', async () => {
    // 「それはやめて」の「やめ」の前に区切りは無い。語境界で探すと**見つからず**、
    // 見つからないことが allow として表に出る（拒否が承認になる最悪の壊れ方）。
    const s = setup();
    const { managerId } = await s.pool.start({ request: 'デプロイして' });
    const session = s.sessions[0] as FakeSession;

    // #313 以降、宛先も意思も示さない一言は回答として消費されない。**decision は
    // 足さない** — このテストが測っているのは「decision を書き忘れた回答」の
    // 読み取りそのものなので、足すと測る対象が消える。宛先だけを特定する。
    const asked = session.ask('Bash', { command: 'git push --force' }, undefined, 'req-force');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await s.pool.send(managerId, 'それはやめて、代わりに差分だけ見せて', {
      requestId: 'req-force',
    });

    expect(await asked).toMatchObject({ behavior: 'deny' });

    // **#322: decision を書き忘れた回は、以前は journal に本文がそのまま
    // 残るだけで `[allow]` か `[deny]` かが読めなかった。** SDK へ実際に
    // 返った decision（上の `behavior: 'deny'`）と同じ値が journal にも
    // 残ることを、ここで直接見る。
    const escalations = (await s.stores.journal.list({ types: ['escalation'] })) as {
      answer?: string;
    }[];
    expect(escalations[0]?.answer).toBe('[deny] それはやめて、代わりに差分だけ見せて');

    await s.pool.stop();
  });

  it('肯定の返事は通す（迷ったら止める、にはしない）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '調べて' });
    const session = s.sessions[0] as FakeSession;

    // #313 以降の宛先の明示。**decision は足さない**（直上と同じ理由 — 測って
    // いるのは decision 無しでの読み取りが allow へ倒れることである）。
    const asked = session.ask('Read', { file_path: '/work/a.ts' }, undefined, 'req-read');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await s.pool.send(managerId, 'よい、そのまま進めて', { requestId: 'req-read' });

    expect(await asked).toEqual({ behavior: 'allow' });

    // **#322: こちらも同じ理由。** decision を書き忘れた肯定の回答が
    // journal では `[allow]` として残ることを見る（直上の deny 側と対）。
    const escalations = (await s.stores.journal.list({ types: ['escalation'] })) as {
      answer?: string;
    }[];
    expect(escalations[0]?.answer).toBe('[allow] よい、そのまま進めて');

    await s.pool.stop();
  });

  /**
   * **#322 の3つ目の制約: `decision` を報告しない runner の応答を、allow/deny
   * の既定値へ倒さない。** ローリング再デプロイの窓では、まだこの変更前の
   * runner が `{ ok: true }` だけを返し、確定した decision を運べない
   * （`RunnerAnswerOutcome` の doc）。この偽 runner はそれを模す —
   * `answer()` が `{ delivered: true }` のみを返し、`decision` キー自体を
   * 持たない。
   *
   * **ローカルの `decision: 'allow'` を渡していても** journal は `[allow]`
   * へ倒さない——渡した値は「クローンが何を言ったか」でしかなく、「runner が
   * 何を確定したか」の代わりにはならない。この区別自体がこの Issue の中身
   * である。
   */
  it('runner が decision を報告しない回（版skewの窓）は、allow/deny へ倒さず journal に残す（#322）', async () => {
    // **`let` + 複数クロージャでの narrowing を避けるため、可変箱に包む。**
    // （素の `let emit` を object literal の複数メソッドから触ると、
    // 呼び出し側での参照が `never` に narrowing される場合がある）
    const wired: { emit: ((event: RunnerEvent) => void) | null } = { emit: null };
    const legacyRunner: RunnerClient = {
      runnerId: 'runner-legacy',
      runnerIdKnown: true,
      workspacePathKnown: true,
      workspacePath: '/work/project',
      async connect(onEvent) {
        wired.emit = onEvent;
      },
      async start() {
        /* この検証では使わない */
      },
      async resume() {
        /* この検証では使わない */
      },
      async send() {
        /* この検証では使わない */
      },
      async answer(_managerId, answer) {
        // **この版の runner は decision を報告しない（#322 が模す版skew）。**
        // `settled` も流す（`runner-sticky.test.ts` と同じ約束 — 流さないと
        // `waiting` が残ったままになり「解けた」を主張できない）。
        wired.emit?.({ type: 'settled', managerId: _managerId, requestId: answer.requestId });
        return { delivered: true };
      },
      async stop() {
        /* この検証では使わない */
      },
      async list() {
        return [];
      },
      async transcript() {
        return null;
      },
      async credentials() {
        return [];
      },
      async setCredentials() {
        return [];
      },
      async profile() {
        return undefined;
      },
      async setProfile() {
        return { ok: true };
      },
      async close() {
        /* この検証では使わない */
      },
    };
    const s = setup(undefined, { runner: legacyRunner });
    const { managerId } = await s.pool.start({ request: 'デプロイして' });

    wired.emit?.({
      type: 'ask',
      managerId,
      requestId: 'req-legacy',
      kind: 'permission',
      summary: 'Bash の実行許可: git push',
      askedAt: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result = await s.pool.send(managerId, 'よい', {
      decision: 'allow',
      requestId: 'req-legacy',
    });
    expect(result.outcome).toBe('answered');

    const escalations = (await s.stores.journal.list({ types: ['escalation'] })) as {
      answer?: string;
    }[];
    // 最新（answer 側）が先頭。ask 側（2件目）は元々 `answer` 欄を持たない。
    expect(escalations[0]?.answer).toBe('[unknown] よい');

    await s.pool.stop();
  });

  it('中断で解けた確認は待ち行列に残らない（次の指示を食い潰さない）', async () => {
    // マネージャー側の中断で宙吊りを解いたあと、その1件が行列に残っていると、
    // 次にクローンが送った「追加指示」が誰も待っていない返事として消える。
    const s = setup();
    const { managerId } = await s.pool.start({ request: '調べて' });
    const session = s.sessions[0] as FakeSession;

    const aborter = new AbortController();
    const asked = session.ask('Bash', { command: 'ls' }, aborter.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));

    aborter.abort();
    expect(await asked).toMatchObject({ behavior: 'deny' });

    // 返事待ちは解けている
    const after = (await s.pool.list()).find((m) => m.managerId === managerId);
    expect(after?.status).toBe('running');
    expect(after?.waiting).toEqual([]);

    // 次の一言はちゃんと追加指示として届く
    expect((await s.pool.send(managerId, 'こっちを見て')).outcome).toBe('delivered');

    await s.pool.stop();
  });

  it('居ないマネージャーへの送信は、黙って捨てずに理由を返す', async () => {
    const s = setup();
    expect((await s.pool.send('mgr-nope', 'やあ')).outcome).toBe('unknown');
    await s.pool.stop();
  });

  it('記憶ストアの接続情報を子プロセスへ渡さない（クラウド構成の本命の強制）', async () => {
    // ローカルではパス、クラウドでは DB 認証情報。**渡さなければ到達経路が無い**。
    // ツールを削って塞ぐのではなく、認証情報の配布範囲で守る（roadmap M4 受け入れ基準3）。
    const s = setup(
      {
        PATH: '/usr/bin',
        HOME: '/home/alteroid',
        ALTEROID_HOME: '/data/alteroid',
        ALTEROID_DATABASE_URL: 'postgres://alteroid:secret@db:5432/alteroid',
        CLAUDE_CODE_OAUTH_TOKEN: 'token-for-the-sdk',
      },
      { withheldEnvKeys: ['PGPASSWORD'] },
    );
    await s.pool.start({ request: '調べて' });

    const env = (s.sessions[0] as FakeSession).options.env ?? {};
    expect(env.ALTEROID_DATABASE_URL).toBeUndefined();
    expect(env.PGPASSWORD).toBeUndefined();
    for (const key of WITHHELD_ENV_KEYS) expect(env[key]).toBeUndefined();

    // 記憶ストアと関係のない環境は削らない。認証を落とせばマネージャーは
    // ただ動かなくなる = デグレードであって境界ではない。
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-for-the-sdk');
    expect(env.PATH).toBe('/usr/bin');

    await s.pool.stop();
  });
});

/**
 * managerId の発行 — **切り詰めない。仮定ではなく `#records` を引いて確かめる**
 * （#238）。
 *
 * `randomUUID` を差し替える前例がこの repo に無いので（`vi.mock('node:crypto')`
 * は使わない）、`ManagerPoolOptions.generateManagerId` で差し替える。`now` と
 * 同じ形の注入口である。
 */
describe('managerId の発行（#238）', () => {
  it('切り詰めない — 既定の発行器は `mgr-` に UUID 全体を続ける', async () => {
    const s = setup();
    const summary = await s.pool.start({ request: '調べて' });

    // UUIDv4 全体（36文字）。旧実装は先頭8桁で切り詰めていた
    // （`mgr-${randomUUID().slice(0, 8)}`）。
    expect(summary.managerId).toMatch(
      /^mgr-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    await s.pool.stop();
  });

  it('発行した id が既に走っている委譲のものなら、上書きせず引き直し、跡を残す（本文は出さない）', async () => {
    const generateManagerId = vi
      .fn<() => string>()
      .mockReturnValueOnce('mgr-dup')
      .mockReturnValueOnce('mgr-dup') // 2本目の1回目の発行。1本目と衝突する
      .mockReturnValueOnce('mgr-fresh'); // 引き直し
    const s = setup(undefined, { generateManagerId });

    const first = await s.pool.start({
      request: `一本目 秘密は ghp_000000000000000000000000000000000000 だ`,
    });
    expect(first.managerId).toBe('mgr-dup');

    const lines = await captureStderr(async () => {
      const second = await s.pool.start({ request: '二本目' });
      // **上書きされず、引き直した id が使われる。**
      expect(second.managerId).toBe('mgr-fresh');
    });

    // **跡が残る。** id と試行回数だけで、本文（依頼文）は載らない。
    const text = lines.join('');
    expect(text).toContain('managerId の発行が衝突したので引き直しました');
    expect(text).toContain('managerId=mgr-dup');
    expect(text).toContain('attempt=1');
    expect(text).not.toContain('ghp_');
    expect(text).not.toContain('一本目');
    expect(text).not.toContain('二本目');

    // **1本目の記録は上書きされていない。** `#records.set` が黙って潰していれば
    // ここが二本目の request で上書きされる。
    const listed = await s.pool.list();
    expect(listed.find((m) => m.managerId === 'mgr-dup')?.request).toContain('一本目');
    expect(listed.find((m) => m.managerId === 'mgr-fresh')?.request).toBe('二本目');

    await s.pool.stop();
  });

  it('引き直しが上限に達したら、上書きせず例外で止める', async () => {
    // 常に同じ id しか返さない壊れた発行器。上限回数ぶん必ず衝突し続ける。
    const generateManagerId = vi.fn<() => string>().mockReturnValue('mgr-stuck');
    const s = setup(undefined, { generateManagerId });

    const first = await s.pool.start({ request: '一本目' });
    expect(first.managerId).toBe('mgr-stuck');

    const lines = await captureStderr(async () => {
      await expect(s.pool.start({ request: '二本目' })).rejects.toThrow(
        /managerId の発行が.*回連続で衝突/,
      );
    });

    // 上限回数ぶん、引き直しの跡が残っている（黙って諦めていない）。
    const text = lines.join('');
    expect(text).toContain('managerId の発行が衝突したので引き直しました');

    // **1本目の記録は無傷。二本目は影も形も残らない**（例外を投げる前に
    // `#records.set` していれば、ここに `mgr-stuck` の request が「二本目」に
    // 書き換わっている）。
    const listed = await s.pool.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.managerId).toBe('mgr-stuck');
    expect(listed[0]?.request).toBe('一本目');

    await s.pool.stop();
  });
});

describe('デーモン再起動後（M4）', () => {
  const runningJob = {
    id: 'mgr-old',
    managerId: 'mgr-old',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '移行作業',
    request: 'DB の移行をやって',
    cwd: '/work/project',
    sessionId: 'sess-before-restart',
    lastReport: 'スキーマまで書いた',
  };

  it('走行中だったマネージャーを実際に resume し、続きを進めさせる（受け入れ基準2）', async () => {
    // **開き直すだけでは足りない。** 人間の不在で止まってよいのは承認待ちの仕事
    // だけであり（PRD「自律」）、器が落ちたことを理由に止まったままにはしない。
    // 「話しかけられるまで待つ」形にすると、自律運転中の再起動で仕事が永久に止まる。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const s = setup(undefined, { stores });

    const restored = await s.pool.restore();

    expect(restored.map((m) => m.managerId)).toEqual(['mgr-old']);
    // session_id から SDK セッションが起き、続きの指示まで届いている
    expect(s.sessions).toHaveLength(1);
    expect((s.sessions[0] as FakeSession).options.resume).toBe('sess-before-restart');
    await expect
      .poll(() => (s.sessions[0] as FakeSession).inputs, { timeout: 2000 })
      .toEqual(['[system] デーモンが再起動した。中断していた作業の続きを進めよ。']);

    // クローンが「続きがある」ことを知る経路は受信箱ただ1つ
    const notice = s.inbox.find((event) => event.type === 'manager_message');
    expect(notice).toMatchObject({ managerId: 'mgr-old', kind: 'report' });
    // **#252（2026-08-23 反転）: 依頼文はもう埋め込まない。** クローン自身が書いた
    // 依頼文を、状態が変わっただけの知らせに全文で送り返す理由が無い（読みたければ
    // `manager_report ... part=request`）。かつてここは「依頼文が入っている」ことを
    // 固定していたが、それ自体が #252 の欠陥だった。
    expect((notice as { text: string }).text).not.toContain('DB の移行をやって');
    expect((notice as { text: string }).text).toContain('manager_report managerId=mgr-old');
    // 直近の報告は短いので抜粋してもそのまま全文が残る（切り詰めの確認は
    // 「知らせは全文を埋め込まない（#252）」の巨大な報告のテストが別に持つ）。
    expect((notice as { text: string }).text).toContain('スキーマまで書いた');

    // 一覧では走行中に戻っている（止まったまま live: true に見せない）
    const listed = (await s.pool.list()).find((m) => m.managerId === 'mgr-old');
    // resume 後のセッション id は SDK が返す新しいもので上書きされる
    // （次の再起動でもそこから戻れるように、台帳は常に最新の id を持つ）。
    expect(listed).toMatchObject({ live: true, status: 'running', runnerId: 'runner-test' });

    await s.pool.stop();
  });

  /**
   * #252: `#notifyRestored` は「デーモンが再起動した」という**事実の知らせ**でしか
   * ない。依頼文（クローン自身が書いたもの）を送り返す理由は無く、直近の報告も
   * 全文を持つ必要は無い——中身はいつでも `manager_report` で読める。
   *
   * **末尾の断片で判定する。** 抜粋は先頭を残す仕様（`excerpt.ts`）なので、先頭が
   * 一致するだけの判定では「全文の先頭だけ切って残りは埋め込んだまま」でも
   * 素通りしてしまう。
   */
  it('#252: 依頼文・直近の報告が巨大でも、知らせは全文を埋め込まない', async () => {
    // **末尾だけに現れる目印を混ぜる。** 本文が同じ語の繰り返しだと、抜粋が
    // 残す先頭部分にも「末尾と同じ文字列」が偶然含まれてしまい、末尾の断片で
    // 判定したつもりが先頭一致と区別できなくなる（このテストを書く過程で実際に
    // 一度それで落ちた）。抜粋に絶対に現れない一意な目印を末尾へ置く。
    const hugeRequest = 'これは巨大な依頼文である。'.repeat(300) + REQUEST_TAIL_MARKER;
    const hugeReport = 'これは巨大な直近の報告である。'.repeat(300) + REPORT_TAIL_MARKER;
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, request: hugeRequest, lastReport: hugeReport });
    const s = setup(undefined, { stores });

    await s.pool.restore();

    const notice = s.inbox.find((event) => event.type === 'manager_message') as {
      text: string;
    };
    expect(notice).toBeDefined();

    const requestTail = REQUEST_TAIL_MARKER;
    const reportTail = REPORT_TAIL_MARKER;
    // 全文はもちろん、末尾だけでも含まれない（先頭一致では見えない切り詰めを見る）。
    expect(notice.text).not.toContain(hugeRequest);
    expect(notice.text).not.toContain(hugeReport);
    expect(notice.text).not.toContain(requestTail);
    expect(notice.text).not.toContain(reportTail);

    // 本文の長さに上限がある（依頼文・報告よりも十分小さい）。
    expect(notice.text.length).toBeLessThan(1000);
    expect(notice.text.length).toBeLessThan(hugeRequest.length);
    expect(notice.text.length).toBeLessThan(hugeReport.length);

    // 続きの取り方が manager_report と id 付きで名指しされている。
    expect(notice.text).toContain(`manager_report managerId=${runningJob.id}`);
    expect(notice.text).toContain('part=request');

    // 省いた分量の断り書きが出ている（excerpt.ts の流儀）。
    expect(notice.text).toContain('文字省略');

    await s.pool.stop();
  });

  it('返事待ちだったマネージャーには、確認が失われたことを伝えて再開させる', async () => {
    // 待っていた確認は器と一緒に消えている。黙って再開させると、マネージャーは
    // 返ってこない返事を待ち続ける。
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, status: 'waiting_human' });
    const s = setup(undefined, { stores });

    await s.pool.restore();

    await expect
      .poll(() => (s.sessions[0] as FakeSession).inputs.join(''), { timeout: 2000 })
      .toContain('待っていた確認は器と一緒に失われている');

    await s.pool.stop();
  });

  it('runner に生きているセッションは resume せず、繋ぎ直すだけ（二重に起こさない）', async () => {
    // デーモンだけが再起動した場合、マネージャーは runner の中で手を動かし続けて
    // いる。ここで resume すると、走っているセッションを二重に起こすことになる。
    const stores = createMemoryStores();
    const first = setup(undefined, { stores });
    const { managerId } = await first.pool.start({ request: '長い仕事' });

    // 同じ runner に別のデーモンが繋ぎ直す（＝デーモンだけが入れ替わった。
    // runner は別プロセスなので、デーモンが消えてもセッションは生きている）。
    const second = setup(undefined, { stores, runner: first.runner });
    const restored = await second.pool.restore();

    expect(restored.map((m) => m.managerId)).toEqual([managerId]);
    // セッションは増えていない（resume していない）
    expect(first.sessions).toHaveLength(1);
    const notice = second.inbox.find((event) => event.type === 'manager_message');
    expect((notice as { text: string }).text).toContain('runner の中で走り続けている');

    await second.pool.stop();
  });

  it('待機中だった仕事は黙って引き取る（報告はしないが、話しかければ続く）', async () => {
    // `done` は死ではなく待機である。ここで拾わないと、一度再起動を跨いだ仕事は
    // 二度目の再起動で resume できなくなる（人間が開いたままの窓を勝手に閉じる形）。
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-done', status: 'done' });
    const s = setup(undefined, { stores });

    expect(await s.pool.restore()).toEqual([]);
    expect(s.inbox).toEqual([]);
    expect(s.sessions).toHaveLength(0);

    expect((await s.pool.send('mgr-done', 'まだ続きがある')).outcome).toBe('delivered');
    expect((s.sessions[0] as FakeSession).options.resume).toBe('sess-before-restart');

    await s.pool.stop();
  });

  it('session_id の無い仕事は拾い直さない（戻る先が無い）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-nosession', sessionId: undefined });
    const s = setup(undefined, { stores });

    expect(await s.pool.restore()).toEqual([]);
    expect(s.inbox).toEqual([]);
    expect((await s.pool.send('mgr-nosession', 'やあ')).outcome).toBe('unknown');

    await s.pool.stop();
  });

  /**
   * **`stopped` は明示的に止められた終端であって、`done`（待機）ではない。**
   *
   * `restore()` / `#reattach()` は `running` / `waiting_human` のホワイトリストで
   * 自動の再開先を決めている（`stopped` は名指しで除外しなくても、このホワイト
   * リストに入っていない時点で自動では対象外になる）。ここでそれをロックする —
   * デーモンの再起動で、止めたはずのマネージャーが甦って `resume` されないこと。
   */
  it('stopped の仕事はデーモン再起動でも拾い直さない（明示的に止められた終端）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-stopped-restart', status: 'stopped' });
    const s = setup(undefined, { stores });

    const resumed = await s.pool.restore();

    // resumed に含まれない＝自動では再開の対象にしていない。
    expect(resumed).toEqual([]);
    // 起こし直しの通知（`#notifyRestored`）も出ていない。
    expect(s.inbox).toEqual([]);
    // runner へ resume が飛んでいない（飛んでいれば fake SDK にセッションが1本立つ）。
    expect(s.sessions).toHaveLength(0);

    await s.pool.stop();
  });

  /**
   * **`stopped` でも、明示的な `manager_send` は続きへ戻せる。**
   *
   * `schema.ts` の `jobStatusSchema` の doc は以前「話しかけても続かない」と
   * 書いていたが、これは誤りだった（2026-08-22 訂正）。`abort()` は
   * `job.sessionId` を消さない——デーモンが**自動では**起こし直さない（直前の
   * テスト）のと、人間・クローンが明示的に送ったときに戻せるかは別の話である。
   * `send()` は `record.attached` を見て `!record.attached` なら `#resumeOnce`
   * （`lost` / `failed` と同じ経路）へ入るので、`stopped` もここを通って続く。
   * ここを塞ぐと、人間が Claude Code のセッションを止めても `--resume` で戻せる
   * 能力を、この階層だけ持たないことになる（`docs/north_star.md` 禁止2・
   * 追加制限禁止）。
   */
  it('stopped の仕事でも、明示的な manager_send なら resume 経路を通って続く', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-stopped-send', status: 'stopped' });
    const s = setup(undefined, { stores });

    // 自動では拾い直さない（直前のテストと同じ確認。ここまでは同じ振る舞い）。
    expect(await s.pool.restore()).toEqual([]);
    expect(s.sessions).toHaveLength(0);

    const result = await s.pool.send('mgr-stopped-send', 'まだ続きがある');

    // session_id から resume 経路を通り、実際に SDK セッションが起きている。
    expect(result.outcome).toBe('delivered');
    expect(s.sessions).toHaveLength(1);
    expect((s.sessions[0] as FakeSession).options.resume).toBe('sess-before-restart');

    // 台帳も `running` へ戻る（`stopped` に固定されたままにはならない）。
    const listed = (await s.pool.list()).find((m) => m.managerId === 'mgr-stopped-send');
    expect(listed?.status).toBe('running');

    await s.pool.stop();
  });

  it('runner が lost と名乗ったセッションを、繋がっているからと live: true にしない', async () => {
    // 引き取り（`#restoreJobs`）は runner が名乗った状態をそのまま採る。runner の
    // 側では resume の失敗が確定してから（`#status = 'lost'`）そのセッションが
    // 一覧から消えるまでに実 I/O を挟むので、その隙間で引き取ると `lost` を名乗る
    // セッションを掴む。その像の `attached` は上流で `false` に倒すようにしたが、
    // **`live` の判定はそれに依存しない**（下の理由）。
    //
    // **「`lost` と `attached: true` が同時に立つ代入は無い」に寄りかからない。**
    // 代入を全部数え上げて成り立つ不変条件は、次に代入を足した人が黙って壊す。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: runningJob.id,
      status: 'lost',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [],
      sessionId: 'sess-before-restart',
    });
    const s = setup(undefined, { stores, runner: fake.runner });

    const restored = await s.pool.restore();
    // 繋ぎ直してはいる（引き取りの経路を通ったことを固定する）。
    expect(restored.map((m) => m.managerId)).toEqual([runningJob.id]);
    expect(restored[0]?.live).toBe(false);

    const listed = (await s.pool.list()).find((m) => m.managerId === runningJob.id);
    expect(listed).toMatchObject({ status: 'lost', live: false });

    await s.pool.stop();
  });

  /**
   * **デーモン再起動後の引き取り（`#restoreJobs`）は `runner.state()` を経由する。**
   * `ask` イベント経由（`#onEvent` の `case 'ask'`）とは別の経路で、`kind` /
   * `askedAt` を運ぶ入口がもう1つある——`RunnerSession#state()`（`runner.ts`）が
   * `#pending` から `waiting` を組み立てる箇所である。ここが値を落としていても
   * `ask` 経由の歯（直前・直後のテスト）は気づけない。#334 の実装ではここが
   * 2箇所目の穴だった。
   *
   * **`askedAt` は特に重い。** 引き取り直すたびに「いま」へ取り直すと、4時間
   * 待っている確認が再起動のたびに「たった今」へ化ける——足した理由（#323。
   * 待ち時間の長さで人間の次の一手が変わる）がそのまま消える。ここでは
   * 「いま」とは明らかに違う過去の時刻を fixture に置き、引き取り後もその
   * 値のままであることを見る。
   */
  it('待ちが在るままデーモンが再起動しても、引き取り直した waiting は kind と askedAt を保つ（#334）', async () => {
    const askedAtQuestion = '2026-08-23T02:00:00.000Z';
    const askedAtPermission = '2026-08-23T05:30:00.000Z';
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, status: 'waiting_human' });
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: runningJob.id,
      status: 'waiting_human',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [
        {
          requestId: 'req-restart-q',
          summary: 'DB はどちらにする？',
          kind: 'question',
          askedAt: askedAtQuestion,
        },
        {
          requestId: 'req-restart-p',
          summary: 'Bash の実行許可',
          kind: 'permission',
          askedAt: askedAtPermission,
        },
      ],
      sessionId: 'sess-before-restart',
    });
    const s = setup(undefined, { stores, runner: fake.runner });

    const restored = await s.pool.restore();
    expect(restored.map((m) => m.managerId)).toEqual([runningJob.id]);

    const waiting = (await s.pool.list()).find((m) => m.managerId === runningJob.id)?.waiting ?? [];
    const question = waiting.find((item) => item.requestId === 'req-restart-q');
    const permission = waiting.find((item) => item.requestId === 'req-restart-p');
    expect(question?.kind).toBe('question');
    expect(permission?.kind).toBe('permission');
    // **取り直していないこと**を明示的に見る。「いま」の近似値ではなく
    // fixture に置いた値そのものと一致する（`toBeCloseTo` のような近似では、
    // 取り直す変異が生き残る）。
    expect(question?.askedAt).toBe(askedAtQuestion);
    expect(permission?.askedAt).toBe(askedAtPermission);

    await s.pool.stop();
  });

  it('runner が lost と名乗ったセッションへ send すると resume 経路を通る（届かない runner.send() にしない）', async () => {
    // `attached: true` を固定していた頃は、ここで `send()` の `!record.attached` が
    // 偽になり `runner.send()` が直に呼ばれていた。しかし畳まれたセッションへの
    // `push` は `RunnerSession#push` が `#stopped` を見て黙って捨てる
    // （runner.ts）。つまり「届いた」という顔をして実は届いていなかった —
    // これがこの不具合の実害である。ここでは `runner.resume()`（`#resumeOnce`
    // の経路）が呼ばれたことを直接見て、そちらへ向いたことを固定する。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: runningJob.id,
      status: 'lost',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [],
      sessionId: 'sess-before-restart',
    });
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    const result = await s.pool.send(runningJob.id, '続けて');

    // resume 経路を通った証拠は「resume が増えた」こと（fake の `send` は何も
    // 記録しないので、その不在ではなく resume の発生そのものを見る）。
    expect(fake.state.resumes).toHaveLength(1);
    expect(fake.state.resumes[0]).toMatchObject({
      managerId: runningJob.id,
      sessionId: 'sess-before-restart',
    });
    expect(result.outcome).toBe('delivered');

    await s.pool.stop();
  });

  it('runner が lost と名乗ったセッションを引き取っても、「走り続けている」とは知らせない', async () => {
    // `#notifyRestored(record, 'attached')` は「runner の中で走り続けている」と
    // 断言する文面を受信箱へ流す。しかし `lost` は runner が「もう居ない」と
    // 名乗った状態そのものなので、この文面は嘘になる。`attached: true` を固定
    // していた頃はここが必ず届いていた（前のテストの実害と対になる、報告面の実害）。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: runningJob.id,
      status: 'lost',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [],
      sessionId: 'sess-before-restart',
    });
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();

    const notices = s.inbox
      .filter((event) => event.type === 'manager_message' && event.managerId === runningJob.id)
      .map((event) => (event as { text: string }).text);
    expect(notices.some((text) => text.includes('runner の中で走り続けている'))).toBe(false);

    await s.pool.stop();
  });

  it('runner が failed と名乗ったセッションへ send すると resume 経路を通る（届かない runner.send() にしない）', async () => {
    // `failed` は `lost` と同じ形で畳まれている。`RunnerSession#finish('failed', ...)`
    // （runner.ts）も `#stopped = true` を先に立ててから一覧に残ったまま実 I/O
    // （アーカイブ送出）を挟むので、その隙間で引き取ると畳まれたセッションへ
    // `attached: true` を立てることになる。`lost` 版と同じ実害（届かない
    // `runner.send()` を届いたことにして `running` へ巻き戻す）が起きるはずが
    // 無いことを、`runner.resume()`（`#resumeOnce` の経路）が呼ばれたことで見る。
    // `failed` は「話しかければ直るかもしれない失敗」（runner.ts のコメント）
    // なので、resume を試みるのが正しい。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: runningJob.id,
      status: 'failed',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [],
      sessionId: 'sess-before-restart',
    });
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    const result = await s.pool.send(runningJob.id, '続けて');

    // resume 経路を通った証拠は「resume が増えた」こと（fake の `send` は何も
    // 記録しないので、その不在ではなく resume の発生そのものを見る）。
    expect(fake.state.resumes).toHaveLength(1);
    expect(fake.state.resumes[0]).toMatchObject({
      managerId: runningJob.id,
      sessionId: 'sess-before-restart',
    });
    expect(result.outcome).toBe('delivered');

    await s.pool.stop();
  });

  it('runner が failed と名乗ったセッションを引き取っても、「走り続けている」とは知らせない', async () => {
    // `#notifyRestored(record, 'attached')` は「runner の中で走り続けている」と
    // 断言する文面を受信箱へ流す。しかし `failed` も `lost` と同じく runner が
    // 「もう居ない」と名乗った状態そのものなので、この文面は嘘になる。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: runningJob.id,
      status: 'failed',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [],
      sessionId: 'sess-before-restart',
    });
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();

    const notices = s.inbox
      .filter((event) => event.type === 'manager_message' && event.managerId === runningJob.id)
      .map((event) => (event as { text: string }).text);
    expect(notices.some((text) => text.includes('runner の中で走り続けている'))).toBe(false);

    await s.pool.stop();
  });

  it('生きたまま待機している done へ send しても、セッションを二重に起こさない', async () => {
    // `done` は `lost` / `failed` と違って**2箇所から付く**。ここで確かめたいのは
    // 畳まれた方（`#finish('done', ...)`）ではなく、セッションを `#sessions` に
    // 生かしたまま `#status` だけを `'done'` にする方（1ターンが終わって次の
    // 指示を待っている状態）。`swappableRunner` は使わない — あの fake の
    // `resume` は無条件に alive を1本増やすので、`host.resume()` の短絡
    // （生きたセッションを見つけたら `push` して return する）を確かめられない。
    // 実 runner（`setup` の既定 = `createLocalRunner`）で、ホワイトリスト化した
    // `attached` 判定が「安全側に倒しても届く」ことまで見る。
    const stores = createMemoryStores();
    const first = setup(undefined, { stores });
    const { managerId } = await first.pool.start({ request: '長い仕事' });

    // 1ターン終える。runner 側は `#status` を `'done'` にするが、セッションは
    // `#sessions` に生きたまま残る（runner.ts の該当分岐）。
    await (first.sessions[0] as FakeSession).report('ここまでやった');
    await expect
      .poll(
        async () => {
          const jobs = await stores.jobs.listJobs();
          return jobs.find((job) => job.id === managerId)?.status;
        },
        { timeout: 2000 },
      )
      .toBe('done');

    // デーモンだけが再起動した想定。runner は同じものを渡す（生きたまま）。
    const second = setup(undefined, { stores, runner: first.runner });
    await second.pool.restore();

    const result = await second.pool.send(managerId, 'まだ続きがある');

    // セッションは増えていない（`host.resume()` が alive を見つけて `push` に
    // 短絡した証拠。新しいセッションが起きていれば `resume()` が作り直している）。
    expect(first.sessions).toHaveLength(1);
    expect(result.outcome).toBe('delivered');
    // 「resume 経路へ向いた」だけでなく、実際に文言が届いたことまで見る。
    // ここが「安全側に倒しても実害が無い」の全部である。
    await expect
      .poll(() => (first.sessions[0] as FakeSession).inputs, { timeout: 2000 })
      .toContain('まだ続きがある');

    await second.pool.stop();
  });

  it('生きたまま待機している done を引き取っても、「走り続けている」とは知らせない', async () => {
    // 観測された実害そのもの: 通知は「走り続けている」と言うのに、`manager_list`
    // は `[done]`（待機）を返す。`done` を `attached: true` にしていた頃は、
    // 畳まれた方の `done`（実は死んでいる）でもこの通知が出ていた。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: runningJob.id,
      status: 'done',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [],
      sessionId: 'sess-before-restart',
    });
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();

    const notices = s.inbox
      .filter((event) => event.type === 'manager_message' && event.managerId === runningJob.id)
      .map((event) => (event as { text: string }).text);
    expect(notices.some((text) => text.includes('runner の中で走り続けている'))).toBe(false);

    await s.pool.stop();
  });

  it('done を安全側に倒しても、一覧の live: true は落ちない', async () => {
    // `attached: false` にしたことで「話しかけられるのに切れて見える」という
    // 逆向きの嘘が出ていないかを測る。`isLive()` は `record.job.sessionId` が
    // あれば `attached` を見ずに `true` を返すので、ここは崩れないはずである。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: runningJob.id,
      status: 'done',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [],
      sessionId: 'sess-before-restart',
    });
    const s = setup(undefined, { stores, runner: fake.runner });

    const restored = await s.pool.restore();
    expect(restored[0]).toMatchObject({ status: 'done', live: true });

    const listed = (await s.pool.list()).find((m) => m.managerId === runningJob.id);
    expect(listed).toMatchObject({ status: 'done', live: true });

    await s.pool.stop();
  });

  it('runner が waiting_human と名乗ったセッションは、繋がっているままにする', async () => {
    // ホワイトリストの肯定側。`running` 側は既存テスト
    // （'runner に生きているセッションは resume せず、繋ぎ直すだけ'）が持っている
    // ので、ここでは `waiting_human` を固定する。
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, status: 'waiting_human' });
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: runningJob.id,
      status: 'waiting_human',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [],
      sessionId: 'sess-before-restart',
    });
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();

    const notices = s.inbox
      .filter((event) => event.type === 'manager_message' && event.managerId === runningJob.id)
      .map((event) => (event as { text: string }).text);
    expect(notices.some((text) => text.includes('runner の中で走り続けている'))).toBe(true);

    await s.pool.stop();
  });

  /**
   * **Issue #240。** 直上のテストと同じ経路（`restore()` が runner に生きた
   * セッションを見つけ、`#notifyRestored(record, 'attached')` を呼ぶ）だが、
   * こちらは受信箱ではなく**日誌**を見る。
   *
   * この呼び出し元（`#restoreJobs` の attach 分岐）は `#notifyRestored` を
   * 呼ぶ前に自分では `#journal` していない——`resumed` 側の呼び出し元
   * （同じ `restore()` 内 / `#reattach`）はしているが、あちらは「再開の指示を
   * 送った」という別の事実を書いているのであって、`attached` 側の跡ではない。
   * 日誌を「無い＝この経路を通っていない」の判別に使うには、`#notifyRestored`
   * 自身が呼び出し元によらず必ず1本残す必要がある。
   */
  it('runner が waiting_human と名乗ったセッションを引き取ったとき、日誌にも跡が残る（#240）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, status: 'waiting_human' });
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: runningJob.id,
      status: 'waiting_human',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [],
      sessionId: 'sess-before-restart',
    });
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();

    const entries = await stores.journal.list({ types: ['exchange'] });
    const line = entries.find(
      (entry) =>
        'text' in entry &&
        entry.text.includes(runningJob.id) &&
        entry.text.includes('走り続けている'),
    );
    expect(line).toBeDefined();

    await s.pool.stop();
  });

  it('戻る先が無い仕事は、話しかけた後も live: false のままである', async () => {
    // 上の `unknown` は「届かなかった」という**その場の返事**でしかない。届け
    // られなかった相手を一覧が `live: true` で見せ続けるなら、人間もクローンも
    // 送り直す先として選び続ける。**話しかけた後こそ嘘をつかせない。**
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-nosession', sessionId: undefined });
    const s = setup(undefined, { stores });

    expect((await s.pool.send('mgr-nosession', 'やあ')).outcome).toBe('unknown');

    const listed = (await s.pool.list()).find((m) => m.managerId === 'mgr-nosession');
    expect(listed).toMatchObject({ live: false });
    expect(listed?.sessionId).toBeUndefined();

    await s.pool.stop();
  });

  it('生ログは runner からデーモンへ上がり、そこから降りられる', async () => {
    // **runner は記憶ストアの鍵を持たない。** だから生ログを永続化するのは
    // デーモンであり、runner は預けるだけである。ここが切れると、器を作り直した
    // 後に manager_id から生ログへ降りられない（可観測性の最下段の欠落）。
    const appended: { projectKey: string; entries: unknown[] }[] = [];
    const sessionStore = {
      append: async (key: { projectKey: string }, entries: unknown[]) => {
        appended.push({ projectKey: key.projectKey, entries });
      },
      load: async (key: { projectKey: string; sessionId: string }) =>
        key.projectKey === 'proj-key' && key.sessionId === 'sess-mgr'
          ? [{ type: 'user', uuid: 'u1' }]
          : null,
    };
    const stores = { ...createMemoryStores(), sessionStore };
    const s = setup(undefined, { stores });
    const { managerId } = await s.pool.start({ request: '調べて' });

    // runner 側の SDK が生ログを預けると、デーモンの側に落ちる
    const passed = (s.sessions[0] as FakeSession).options.sessionStore as typeof sessionStore;
    expect(passed).toBeDefined();
    await passed.append({ projectKey: 'proj-key' }, [{ type: 'user', uuid: 'u1' }]);
    await expect.poll(() => appended.length, { timeout: 2000 }).toBe(1);

    // 生ログを引き当てる鍵（projectKey）も台帳に残る
    await expect
      .poll(async () => (await s.stores.jobs.listJobs())[0]?.projectKey, { timeout: 2000 })
      .toBe('proj-key');

    // runner のファイルもアーカイブも無いが、預けた生ログから返せる
    expect(await s.pool.transcript(managerId)).toBe('{"type":"user","uuid":"u1"}\n');

    await s.pool.stop();
  });
});

/**
 * 器の入れ替えを再現できる runner。
 *
 * デーモンから見える顔（`RunnerClient`）だけで作る。HTTP 実装でも同一プロセス
 * 実装でも、デーモンが知っているのはこの形しかない。
 */
function swappableRunner(runnerId = 'runner-primary') {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const state = {
    alive: [] as RunnerManagerState[],
    resumes: [] as RunnerResumeCommand[],
    /**
     * `list()` が呼ばれた回数。
     *
     * **「resume が増えていない」だけでは、機構が動いて何もしなかったのか、
     * そもそも動かなかったのかを区別できない。** ここを見れば、生死を runner に
     * 聞きに行ったことまで確かめられる。
     */
    listCalls: 0,
    answers: [] as { managerId: string; requestId: string }[],
    /** 降ろされた実行環境プロファイル。名乗るたびに1本増える。 */
    profiles: [] as string[],
  };
  const runner: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePathKnown: true,
    workspacePath: '/work/project',
    async connect(onEvent) {
      // **ここで名乗らせない。** 本物（`apps/daemon/src/runner-client.ts` の
      // `connect`）は `void this.#pump(...)` で即 return し、名乗りは後から SSE に
      // 乗ってくる。同期的に名乗らせると、起動時の引き取りと名乗りの順序が現実と
      // 変わり、「引き取りが見た器」と「SSE が繋がった器」がずれる場合を作れない。
      emit = onEvent;
    },
    async start() {
      /* この検証では使わない */
    },
    async resume(command) {
      state.resumes.push(command);
      state.alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
    },
    async send() {
      /* この検証では使わない */
    },
    async answer(managerId, answer) {
      state.answers.push({ managerId, requestId: answer.requestId });
      // 新しい器はその request_id を知らない（＝解けない）。
      const delivered = state.alive.some((s) =>
        s.waiting.some((w) => w.requestId === answer.requestId),
      );
      return { delivered };
    },
    async stop() {
      /* この検証では使わない */
    },
    async list() {
      state.listCalls += 1;
      return [...state.alive];
    },
    async transcript() {
      return null;
    },
    async credentials() {
      return [];
    },
    async setCredentials() {
      return [];
    },
    async profile() {
      return undefined;
    },
    async setProfile(script: string) {
      state.profiles.push(script);
      return { ok: true };
    },
    async close() {
      /* この検証では使わない */
    },
  };
  return {
    runner,
    state,
    /** 器を作り直す ＝ 中のセッションは消え、新しいストリームが名乗り直す。 */
    swap() {
      state.alive = [];
      emit?.({ type: 'hello', runnerId });
    },
    /** ストリームだけが切れて繋ぎ直す（器はそのまま）。 */
    reconnect() {
      emit?.({ type: 'hello', runnerId });
    },
    /** SDK のセッションが立った、と伝える（本物は `start` の直後に上がってくる）。 */
    session(managerId: string, sessionId: string) {
      const session = state.alive.find((s) => s.managerId === managerId);
      if (session) session.sessionId = sessionId;
      emit?.({ type: 'session', managerId, sessionId });
    },
    /** マネージャーが確認を上げる（デーモン側の待ち行列に積まれる）。 */
    ask(
      managerId: string,
      requestId: string,
      summary: string,
      kind: 'question' | 'permission' = 'permission',
      askedAt: string = new Date().toISOString(),
    ) {
      const session = state.alive.find((s) => s.managerId === managerId);
      session?.waiting.push({ requestId, summary, kind, askedAt });
      emit?.({ type: 'ask', managerId, requestId, kind, summary, askedAt });
    },
    /**
     * マネージャーの1ターンが終わって報告が上がる。
     *
     * `fields` は `contentless` / `failure` / `reportId`（#206）を差し込むための
     * 口（`runner-protocol.ts` の `report` イベントの doc）。**固定値のスタブに
     * しない** — 渡さなければ3つとも省略される既存の振る舞いのままなので、他の
     * テストの挙動は1つも変わらない（`reportId` 無し＝旧 runner 相当）。
     */
    report(
      managerId: string,
      text: string,
      status: JobStatus = 'done',
      fields: {
        contentless?: true;
        failure?: { code: string; via: string };
        reportId?: string;
      } = {},
    ) {
      emit?.({ type: 'report', managerId, text, status, ...fields });
    },
    /** SDK が報告した消費の**累積**を降ろす（差分にするのはデーモン側）。 */
    usage(managerId: string, models: Record<string, UsageTotals>, sessionId?: string) {
      emit?.({ type: 'usage', managerId, sessionId, models });
    },
    /** 委譲1区間ぶんの集計を降ろす（runner 側の集計は `runner-wakeup.test.ts` が別に固定する）。 */
    workerWait(managerId: string, fields: Omit<WorkerWaitEvent, 'type' | 'managerId'>) {
      emit?.({ type: 'worker_wait', managerId, ...fields });
    },
    /** runner 側でセッションが本当に閉じた（`RunnerSession#finish()` を通った）。 */
    closed(managerId: string, status: 'done' | 'lost' | 'failed', reason: string) {
      state.alive = state.alive.filter((s) => s.managerId !== managerId);
      emit?.({ type: 'closed', managerId, status, reason });
    },
    /** 確認へ上げずにその場で止められた（分類器・deny 規則）。 */
    denied(managerId: string, tool: string) {
      emit?.({
        type: 'permission_denied',
        managerId,
        toolUseId: `${tool}:test`,
        tool,
        input: {},
        via: 'live',
      });
    },
    /** 前のセッションを開き直せなかった（`recovered: false` なら仕事が止まる）。 */
    resumeFailed(managerId: string, sessionId: string, reason: string, recovered: boolean) {
      emit?.({ type: 'resume_failed', managerId, sessionId, reason, recovered });
    },
  };
}

describe('消費を台帳へ積む', () => {
  const runningJob = {
    id: 'mgr-spend',
    managerId: 'mgr-spend',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '調べもの',
    request: '調べておいて',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: 'runner-primary',
  };

  function usage(over: Partial<UsageTotals>): UsageTotals {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd: 0,
      ...over,
    };
  }

  async function totalCostUsd(stores: Stores): Promise<number> {
    const { rows } = await stores.usage.aggregate({});
    return rows.reduce((sum, row) => sum + row.totals.costUsd, 0);
  }

  it('累積が降りてきたら差分だけ積む（同じ累積が2回来ても増えない）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.usage('mgr-spend', { opus: usage({ outputTokens: 100, costUsd: 1 }) }, 'sess-1');
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(1);

    // 累積が伸びた分だけ増える。
    fake.usage('mgr-spend', { opus: usage({ outputTokens: 250, costUsd: 3 }) }, 'sess-1');
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(3);

    // 同じものが再送されても増えない（イベント再送で二重計上しない）。
    fake.usage('mgr-spend', { opus: usage({ outputTokens: 250, costUsd: 3 }) }, 'sess-1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await totalCostUsd(stores)).toBe(3);

    await s.pool.stop();
  });

  it('モデル別に分けて積む（どの層が高いかが分かる）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.usage('mgr-spend', {
      'claude-opus-5': usage({ costUsd: 2 }),
      'claude-sonnet-5': usage({ costUsd: 0.5 }),
    });
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(2.5);

    const { rows } = await stores.usage.aggregate({});
    expect(rows.map((row) => row.model).sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(rows.every((row) => row.managerId === 'mgr-spend')).toBe(true);

    await s.pool.stop();
  });

  it('累積が数え直されても記録済みは減らず、数え直したことが日誌に残る', async () => {
    // resume で SDK 側の累積が 0 から始まる。ここで基準を下げて引き算すると
    // 記録済みの分が消える（＝消費が減ったように見える）。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.usage('mgr-spend', { opus: usage({ costUsd: 5 }) }, 'sess-1');
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(5);

    fake.usage('mgr-spend', { opus: usage({ costUsd: 3 }) }, 'sess-1');
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(8);

    const entries = await stores.journal.list({ limit: 50 });
    const note = entries.find((entry) => 'text' in entry && entry.text.includes('数え直された'));
    expect(note).toBeDefined();

    await s.pool.stop();
  });

  it('全部ゼロの累積では記録済みを崩さない（クラッシュの記録に引きずられない）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.usage('mgr-spend', { opus: usage({ costUsd: 5 }) }, 'sess-1');
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(5);

    // ゼロを数え直しとして採用すると、次に届いた本物の $5 が丸ごと増分になる。
    fake.usage('mgr-spend', { opus: usage({}) }, 'sess-1');
    fake.usage('mgr-spend', { opus: usage({ costUsd: 5 }) }, 'sess-1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await totalCostUsd(stores)).toBe(5);

    await s.pool.stop();
  });

  it('台帳の始点を持つので「記録が無い期間」を 0 と言わない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    // まだ1件も無いうちは始点も無い。
    expect((await stores.usage.aggregate({})).since).toBeNull();

    fake.usage('mgr-spend', { opus: usage({ costUsd: 1 }) });
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(1);

    const aggregate = await stores.usage.aggregate({ from: '2020-01-01' });
    expect(aggregate.since).not.toBeNull();
    // 台帳より前にかかる照会は「0」ではなく「記録が無い」と言えること。
    expect(aggregate.beforeLedger).toBe(true);
    expect(aggregate.notice).toContain('請求明細ではない');

    await s.pool.stop();
  });

  /**
   * `fold.delta`（ターン1回ぶんの増分）は台帳へ積むだけで捨てていた。
   * ここは日誌に `turn_usage` として残ることを見る（`clone.ts` と対になる形を
   * `manager.ts` の `case 'usage'` にも入れた — 片方だけだと非対称が残る）。
   */
  it('1ターンの増分が cache read/write を保持したまま turn_usage として日誌に残る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.usage(
      'mgr-spend',
      { opus: usage({ cacheReadInputTokens: 100, cacheCreationInputTokens: 30, costUsd: 1 }) },
      'sess-1',
    );
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(1);

    const entries = await stores.journal.list({ types: ['turn_usage'] });
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (entry?.type !== 'turn_usage') throw new Error('turn_usage が日誌に無い');
    expect(entry.layer).toBe('manager');
    expect(entry.site).toBe('session');
    expect(entry.managerId).toBe('mgr-spend');
    expect(entry.sessionId).toBe('sess-1');
    // **合計に潰していないこと** — read と write が別々に残っている。
    expect(entry.models.opus).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 30,
      webSearchRequests: 0,
      costUsd: 1,
    });
    expect(entry.reset).toBeUndefined();

    await s.pool.stop();
  });

  it('増分が空の回（同じ累積の再送）は turn_usage の行を書かない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.usage('mgr-spend', { opus: usage({ costUsd: 1 }) }, 'sess-1');
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(1);

    // 同じ累積が再送される（イベント再送）＝増分ゼロ。
    fake.usage('mgr-spend', { opus: usage({ costUsd: 1 }) }, 'sess-1');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const entries = await stores.journal.list({ types: ['turn_usage'] });
    // **「行が無い」＝増分ゼロであって、そのターンが無料だったわけではない**
    // （このテストでは実際に増分がゼロなので1件のまま増えない、が正しい）。
    expect(entries).toHaveLength(1);

    await s.pool.stop();
  });

  it('累積が数え直された回は turn_usage に reset が付き、既存の数え直し通知（exchange）も従来どおり出る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.usage('mgr-spend', { opus: usage({ costUsd: 5 }) }, 'sess-1');
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(5);

    // resume で SDK 側の累積が 0 から始まり、次に読めた値が 3 だった形。
    fake.usage('mgr-spend', { opus: usage({ costUsd: 3 }) }, 'sess-1');
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(8);

    // **既存の1行（`exchange`）は従来どおり出る**（あちらを壊していない）。
    const all = await stores.journal.list({ limit: 50 });
    const note = all.find((entry) => 'text' in entry && entry.text.includes('数え直された'));
    expect(note).toBeDefined();

    const turnUsageEntries = all.filter(
      (entry): entry is Extract<JournalEntry, { type: 'turn_usage' }> =>
        entry.type === 'turn_usage',
    );
    expect(turnUsageEntries).toHaveLength(2);
    const resetEntry = turnUsageEntries.find((entry) => entry.reset !== undefined);
    if (resetEntry === undefined) throw new Error('reset 付きの turn_usage が無い');
    expect(resetEntry.reset).toEqual({ fromCostUsd: 5, toCostUsd: 3 });
    // **models は差分ではなく新しい累積の先頭**（3 であって -2 ではない）。
    expect(resetEntry.models.opus?.costUsd).toBe(3);

    await s.pool.stop();
  });

  it('台帳へ積めなくても仕事は止まらず、跡が残る（turn_usage は書かれない）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    stores.usage.record = () => Promise.reject(new Error('台帳が書けない'));
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.usage('mgr-spend', { opus: usage({ costUsd: 1 }) }, 'sess-1');

    await expect
      .poll(
        async () => {
          const entries = await stores.journal.list({ limit: 50 });
          return entries.some(
            (entry) => 'text' in entry && entry.text.includes('消費を台帳へ記録できなかった'),
          );
        },
        { timeout: 2000 },
      )
      .toBe(true);

    const turnUsage = await stores.journal.list({ types: ['turn_usage'] });
    expect(turnUsage).toHaveLength(0);

    await s.pool.stop();
  });
});

describe('worker_wait — 委譲1区間ぶんの集計を日誌に残す', () => {
  const runningJob = {
    id: 'mgr-wait',
    managerId: 'mgr-wait',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '調べもの',
    request: '調べておいて',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: 'runner-primary',
  };

  it('runner から降りた worker_wait は日誌に1件だけ入る（台帳には足さない）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.workerWait('mgr-wait', {
      openedAt: '2026-08-20T00:00:00.000Z',
      tasks: 5,
      turns: 41,
      byCause: { input: 1, notification: 3, continuation: 37 },
      toolless: 38,
      notifications: 3,
      submits: 0,
      settled: true,
    });

    const entries = await vi.waitFor(async () => {
      const found = await stores.journal.list({ types: ['worker_wait'] });
      if (found.length === 0) throw new Error('worker_wait がまだ日誌に無い');
      return found;
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'worker_wait',
      tasks: 5,
      turns: 41,
      byCause: { input: 1, notification: 3, continuation: 37 },
      toolless: 38,
      settled: true,
    });
    // sources を渡していなければ日誌にもフィールドごと現れない
    // （取れない軸に0の行を作らない）。
    expect(entries[0]).not.toHaveProperty('sources');

    // 台帳（`ManagerSummary`）には足さない。
    const summary = (await s.pool.list()).find((job) => job.managerId === 'mgr-wait');
    expect(summary).not.toHaveProperty('workerWait');
    expect(JSON.stringify(summary)).not.toContain('worker_wait');

    await s.pool.stop();
  });

  it('sources を渡していれば日誌にもそのまま残る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.workerWait('mgr-wait', {
      openedAt: '2026-08-20T00:00:00.000Z',
      tasks: 1,
      turns: 1,
      byCause: { input: 0, notification: 1, continuation: 0 },
      toolless: 1,
      notifications: 1,
      submits: 1,
      sources: { system: 1 },
      settled: true,
    });

    const entries = await vi.waitFor(async () => {
      const found = await stores.journal.list({ types: ['worker_wait'] });
      if (found.length === 0) throw new Error('worker_wait がまだ日誌に無い');
      return found;
    });
    expect(entries[0]).toMatchObject({ sources: { system: 1 } });

    await s.pool.stop();
  });
});

describe('runner だけが入れ替わったとき（デプロイ）', () => {
  const runningJob = {
    id: 'mgr-running',
    managerId: 'mgr-running',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '移行作業',
    request: 'DB の移行をやって',
    cwd: '/work/project',
    sessionId: 'sess-before-swap',
    runnerId: 'runner-primary',
    lastReport: 'スキーマまで書いた',
  };

  it('デーモンが生き残っていても、走行中だった仕事を取り直す', async () => {
    // **引き取りの契機がデーモンの起動時しか無いと、ここが落ちる。** runner だけを
    // 再デプロイするとセッションは消えるのに台帳は `running` のままで、クローンが
    // 話しかけるまで永久に止まる。人間の不在で止まってよいのは承認待ちの仕事だけ
    // である（PRD「自律」）。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    // 起動時の引き取り。runner に居ないので resume されて走り出す。
    await s.pool.restore();
    expect(fake.state.resumes).toHaveLength(1);

    // ここで runner だけが入れ替わる（デーモンは生きたまま）。
    fake.swap();

    await expect.poll(() => fake.state.resumes.length, { timeout: 2000 }).toBe(2);
    expect(fake.state.resumes[1]).toMatchObject({
      managerId: 'mgr-running',
      sessionId: 'sess-before-swap',
    });

    // **「デーモンが再起動した」と伝えない。** 手元が残っている前提で書き始める。
    expect(fake.state.resumes[1]?.message).toContain('runner の器が作り直された');
    expect(fake.state.resumes[1]?.message).toContain('手元の状態を確かめよ');

    // クローンにも届く。作業ディレクトリが消えている可能性まで言う。
    const notice = s.inbox.filter((event) => event.type === 'manager_message').at(-1);
    expect((notice as { text: string }).text).toContain('runner の器が作り直された');
    expect((notice as { text: string }).text).toContain('コミット前の変更は失われている');

    await s.pool.stop();
  });

  it('#resumeOnce の短絡: 取り直している最中に重なった2つ目の契機を busy で断る（Issue #203）', async () => {
    // **`#resumeOnce`（manager.ts の `if (this.#resuming.has(id)) return 'busy';`）
    // は、これまで一度も測られていなかった**（`grep -n "resuming"
    // packages/core/src/manager.test.ts` が0件）。`send()` 自身も同じ判定を
    // 事前に持つ（`resumeFailureDetail` の doc の逐語「`send()` は `#resuming`
    // を事前にも見る」）が、それは別の行であり、`send()` を2本重ねるだけでは
    // 常にその事前チェックが先に答えてしまい、`#resumeOnce` 自身の短絡は
    // 一度も実行されない。
    //
    // ここで確かめたいのは、`send()` の事前チェックを経由しない契機
    // （`reattachRunner()` 経由の `#reattach`。呼び出し元は `manager.ts` の
    // `#resumeOnce(record, runner, message)` 呼び出し、送り元は「hello」と
    // 同一の1本）が重なったとき、それでも二重に resume されないことである。
    // これを守っているのは `send()` 側の事前チェックではなく、`#resumeOnce`
    // 自身の短絡だけである。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);

    // `#claimForResume` の中の `await this.#stores.jobs.putJob(record.job)`
    // （貸し出しを台帳へ書く1回目の呼び）を止める。この await の間、
    // `#resuming` には既に id が入っている——`#resumeOnce` はチェックと
    // 追加のあいだに await を挟まない（doc「確かめてから立てるまでに `await`
    // を挟まない」）。
    let releasePutJob!: () => void;
    const gate = new Promise<void>((resolve) => {
      releasePutJob = resolve;
    });
    let putJobCalls = 0;
    const originalPutJob = stores.jobs.putJob.bind(stores.jobs);
    stores.jobs.putJob = async (job: Job) => {
      putJobCalls += 1;
      if (putJobCalls === 1) await gate;
      return originalPutJob(job);
    };

    const fake = swappableRunner(); // runnerId: 'runner-primary'（runningJob と一致）
    const s = setup(undefined, { stores, runner: fake.runner });

    // 1つ目の契機: `manager_send`。`#resumeOnce` に入り、貸し出しを書く
    // 直前で止まる（`#resuming` には既に id が入っている）。
    const firstSend = s.pool.send(runningJob.id, '1つ目の指示');
    await expect.poll(() => putJobCalls, { timeout: 2000 }).toBe(1);

    // 2つ目の契機: runner の再接続（`#reattach`）。`send()` の事前チェックを
    // 経由せず、直接 `#resumeOnce` を呼ぶ経路である。busy で断られたことは
    // `reattachRunner()` の戻り値からは見えない（`#reattach` は
    // `outcome !== 'resumed'` を黙って `continue` する）ので、
    // 「resume が増えなかったこと」で観測する。
    await s.pool.reattachRunner('runner-primary');
    // 1本目はまだ止まっている。2本目が短絡されずに通っていれば、ここで
    // 既に `runner.resume()` が呼ばれているはずである。
    expect(fake.state.resumes).toHaveLength(0);

    // 1本目を進ませて完了させる。
    releasePutJob();
    const first = await firstSend;

    expect(first.outcome).toBe('delivered');
    // **1本しか走っていない。** 2本目が busy を無視して通っていれば、ここが
    // 2以上になる（変異: `#resumeOnce` の短絡を外す）。
    expect(fake.state.resumes).toHaveLength(1);
    expect(fake.state.resumes[0]).toMatchObject({
      managerId: runningJob.id,
      sessionId: runningJob.sessionId,
    });

    await s.pool.stop();
  });

  it('返事待ちだったマネージャーの、死んだ確認を持ち越さない', async () => {
    // **持ち越すと、そのマネージャーには誰も届かなくなる。** 新しい器はその
    // request_id を知らないので確認は永久に解けず、以後の `manager_send` は
    // すべて死んだ確認への回答として横取りされ、`answer` が false を返して
    // 握り潰される。resume したのにクローンからも人間からも到達できない相手が
    // 残るのは、この修正が引いている PRD「自律」そのものの否定になる。
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, status: 'waiting_human' });
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    // 器の中で確認待ちになる（デーモン側の待ち行列にも積まれる）。
    fake.ask('mgr-running', 'req-1', 'force push してよいか');
    await expect
      .poll(
        async () =>
          (await s.pool.list()).find((m) => m.managerId === 'mgr-running')?.waiting.length,
        { timeout: 2000 },
      )
      .toBe(1);

    fake.swap();
    await expect.poll(() => fake.state.resumes.length, { timeout: 2000 }).toBe(2);

    // 待ち行列は空になっている（新しい器は req-1 を知らない）。
    expect((await s.pool.list()).find((m) => m.managerId === 'mgr-running')?.waiting).toEqual([]);

    // 追加指示が、死んだ確認への回答として横取りされない。
    const result = await s.pool.send('mgr-running', '続きをやって');
    expect(result.outcome).toBe('delivered');
    expect(fake.state.answers).toEqual([]);

    await s.pool.stop();
  });

  it('runner が名乗るたびに、実行環境プロファイルを降ろし直す', async () => {
    // **runner は記憶ストアを読めない**（M4 受け入れ基準3）ので、プロファイルを
    // 自分で取りに行けない。降ろし直さないと、器を作り直した瞬間に「昨日まで
    // 通っていた鍵が消える」が起きる — しかも誰も気づけない。
    const stores = createMemoryStores();
    await stores.profile.write('export SOME_API_TOKEN=abc123');
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    // **委譲を始める前に降りている。** 名乗り任せにすると、最初のマネージャーが
    // プロファイルの届く前に走り出しうる。
    await s.pool.restore();
    await expect.poll(() => fake.state.profiles.length, { timeout: 2000 }).toBe(1);
    expect(fake.state.profiles[0]).toContain('SOME_API_TOKEN');

    // 器が入れ替わる ＝ 置いたものは消えている。もう一度降ろす。
    fake.swap();
    await expect.poll(() => fake.state.profiles.length, { timeout: 2000 }).toBe(2);
    expect(fake.state.profiles[1]).toContain('SOME_API_TOKEN');
  });

  it('取り直しの最中に起こされた委譲を、死んだものとして起こし直さない', async () => {
    // **台帳と runner は別の瞬間に読まれる。** runner を先に読むと、その隙間で
    // 起こされた委譲が「runner に居ないのに台帳には居る」と見え、走り出した
    // ばかりの仕事を二本にしてしまう。台帳を先に読めば、隙間で生まれた仕事は
    // そもそも手元の一覧に入らない。
    const stores = createMemoryStores();
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    // 台帳を読んだ後・runner に聞く前で止める。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    fake.runner.list = async () => {
      fake.state.listCalls += 1;
      if (!first) return [...fake.state.alive];
      first = false;
      // 止まっている間に起きたことは、この応答には映らない（本物の HTTP 応答も
      // 投げた時点の景色を返す）。
      const before = [...fake.state.alive];
      await gate;
      return before;
    };
    // 起こした委譲が runner に居ることにする（本物の `start` と同じ）。
    fake.runner.start = async (command) => {
      fake.state.alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
      });
    };

    fake.reconnect();
    await expect.poll(() => fake.state.listCalls, { timeout: 2000 }).toBeGreaterThan(0);

    // 取り直しが止まっている間に、新しい委譲が走り出す。セッションも立つ
    // （＝台帳から見れば「resume できる走行中の仕事」に見える）。
    const started = await s.pool.start({ request: 'いま起こした仕事' });
    fake.session(started.managerId, 'sess-brand-new');
    await expect
      .poll(async () => (await stores.jobs.listJobs())[0]?.sessionId, { timeout: 2000 })
      .toBe('sess-brand-new');

    release();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.state.resumes.filter((r) => r.managerId === started.managerId)).toEqual([]);
    expect(fake.state.resumes).toHaveLength(0);

    await s.pool.stop();
  });

  it('ストリームが切れただけなら何もしない（走っている仕事を二重に起こさない）', async () => {
    // 生死は台帳ではなく runner に聞く。聞かずに `hello` だけで再開させると、
    // ネットワークが一瞬途切れるたびに同じ仕事が二本走る。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    expect(fake.state.resumes).toHaveLength(1);

    const before = fake.state.listCalls;
    fake.reconnect();

    // **聞きに行ったうえで何もしなかった**ことを見る。resume の本数だけを見ると、
    // 機構が存在しなくても・例外で死んでいても緑になる。
    await expect.poll(() => fake.state.listCalls, { timeout: 2000 }).toBe(before + 1);
    expect(fake.state.resumes).toHaveLength(1);

    await s.pool.stop();
  });

  it('待機中だった仕事は起こさない（`done` は死ではなく待機である）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-done', status: 'done' });
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    const before = fake.state.listCalls;
    fake.swap();

    await expect.poll(() => fake.state.listCalls, { timeout: 2000 }).toBe(before + 1);
    expect(fake.state.resumes).toHaveLength(0);

    // 待機のまま。話しかければ続く（`restore` が引き取った状態を壊さない）。
    expect((await s.pool.list()).find((m) => m.managerId === 'mgr-done')?.status).toBe('done');

    await s.pool.stop();
  });

  it('台帳にしか無い終わった仕事の live は、reattach の巻き添えで変わらない', async () => {
    // ステータス判定より前に `#records` へ載せると、`list()` が終わった仕事まで
    // `live: true` で見せる、という懸念そのものは正しい。だがここで確かめたいのは
    // 「`#records` に無いなら常に `live: false`」ではない — その決め打ちは
    // **`#retire`（終端した委譲を `#records` から外す）が入る前提でしか成り立たない
    // 話だった。** 当時「台帳にしか無い」に落ちる経路は `session_id` が無い /
    // `status: 'lost'` のものだけで、どちらも `isLive()` 自身が `false` を返すので
    // 決め打ちと一致していた。`#retire` を足した後は、**`done` / `failed` で
    // 終わった委譲も「台帳にしか無い」側へ普通に落ちる**（`session_id` が残って
    // いれば `manager_send` で明示的に起こし直せる）。決め打ちの `false` のままだと
    // 「完了した委譲について読めていた `live: true` が、外した瞬間に読めなくなる」
    // というデグレードになるので、`list()` のフォールバックは `isLive()` で計算し
    // 直すようにした（本体側の変更）。
    //
    // その上でこのテストが元々守っていたもの（`#reattach` の巻き添えで値が動かない
    // こと）は生きている。`isLive()` は `attached` を見ず `job.sessionId` だけで
    // 決まるので、reattach が触れなかったこの仕事の `live` は前後で変わらない。
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-finished', status: 'done' });
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    // `restore` を通さずに（＝台帳にしか無い状態で）器が入れ替わる。
    const before = (await s.pool.list()).find((m) => m.managerId === 'mgr-finished');
    expect(before).toMatchObject({ status: 'done', live: true });
    fake.swap();

    await expect.poll(() => fake.state.listCalls, { timeout: 2000 }).toBeGreaterThan(0);
    expect(fake.state.resumes).toHaveLength(0);
    const after = (await s.pool.list()).find((m) => m.managerId === 'mgr-finished');
    expect(after).toMatchObject({ status: 'done', live: true });

    await s.pool.stop();
  });

  it('runner に聞けなかったときは何もしない（応答が無いことを死と読まない）', async () => {
    // `list()` が失敗したのを「セッションが無い」と読むと、生きている仕事を
    // 二重に起こす。分からないときは触らない。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    expect(fake.state.resumes).toHaveLength(1);

    let asked = 0;
    fake.runner.list = async () => {
      asked += 1;
      throw new Error('runner が応答しない');
    };
    fake.swap();

    // 聞きには行っている（`#reattach` に入らないまま緑になるのを防ぐ）。
    await expect.poll(() => asked, { timeout: 2000 }).toBe(1);
    expect(fake.state.resumes).toHaveLength(1);

    await s.pool.stop();
  });

  it('起動時に掴んだ器と、名乗ってきた器が違っても取り直す', async () => {
    // **畳まれつつある旧 runner は、猶予（`drainingSeconds`）の間ずっと `/health`
    // と `/managers` に答え続ける。** 起動時の引き取りがそれを見て「生きている」
    // と判断した直後に、SSE が新しい器へ繋がる、という順序が普通に起きる。
    // ここで最初の名乗りを「初回だから」と素通りさせると、まさに拾いたい
    // 入れ替えが落ちる。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    fake.state.alive.push({
      managerId: 'mgr-running',
      status: 'running',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [],
      sessionId: 'sess-before-swap',
    });
    const s = setup(undefined, { stores, runner: fake.runner });

    // 旧い器が答えるので、繋ぎ直しただけで resume はしない。
    const restored = await s.pool.restore();
    expect(restored.map((m) => m.managerId)).toEqual(['mgr-running']);
    expect(fake.state.resumes).toHaveLength(0);

    // SSE が繋がった先は、もう新しい器である。**これが最初の名乗りになる。**
    fake.swap();

    await expect.poll(() => fake.state.resumes.length, { timeout: 2000 }).toBe(1);
    expect(fake.state.resumes[0]?.message).toContain('runner の器が作り直された');

    await s.pool.stop();
  });

  it('取り直しの最中に届いた名乗りを取りこぼさない', async () => {
    // **起動直後の名乗りを処理している最中に器が入れ替わるのは、まさに拾いたい
    // 場合そのものである。** 走行中だから、と2つ目の名乗りを捨てると、その
    // 入れ替えは誰にも見られないまま終わる。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    expect(fake.state.resumes).toHaveLength(1);
    // 起動時の名乗りで走った取り直しが片付くのを待ってから仕掛ける。
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 1回目の取り直しを `list()` の途中で止め、そこに入れ替え前の景色を返させる。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = fake.state.listCalls;
    let first = true;
    fake.runner.list = async () => {
      fake.state.listCalls += 1;
      if (!first) return [...fake.state.alive];
      first = false;
      const before = [...fake.state.alive];
      await gate;
      return before;
    };

    fake.reconnect();
    await expect.poll(() => fake.state.listCalls, { timeout: 2000 }).toBe(base + 1);

    // 止まっている間に器が入れ替わる。
    fake.swap();
    release();

    await expect.poll(() => fake.state.resumes.length, { timeout: 2000 }).toBe(2);

    await s.pool.stop();
  });

  it('resume が一時的にこけても、次の名乗りを待たずに自分で戻す', async () => {
    // **`hello` は SSE が繋がったときにしか来ない。** 器は上がってストリームも
    // 安定しているのに resume だけが一時的にこけた場合（起動直後・瞬断・5xx）、
    // 「次の名乗りでまた挑む」では永久に挑まれない。台帳は `running` のまま
    // 誰も走っていない仕事が残り、この経路が塞いだ穴と同じ形になる。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    expect(fake.state.resumes).toHaveLength(1);

    // 次の resume だけ 503 で落とす（器は生きていて `list()` は答え続ける）。
    const original = fake.runner.resume.bind(fake.runner);
    let failed = 0;
    fake.runner.resume = async (command) => {
      if (failed === 0) {
        failed += 1;
        throw new RunnerHttpError('runner POST /managers/x/resume が失敗した (503)', 503);
      }
      return original(command);
    };

    fake.swap();

    // 名乗りも `manager_send` も追加せずに復旧する。
    await expect.poll(() => failed, { timeout: 2000 }).toBe(1);
    expect(fake.state.resumes).toHaveLength(1);
    await expect.poll(() => fake.state.resumes.length, { timeout: 5000 }).toBe(2);
    expect(fake.state.resumes[1]).toMatchObject({
      managerId: 'mgr-running',
      sessionId: 'sess-before-swap',
    });

    await s.pool.stop();
  });

  it('生死を聞けなかったときも、次の名乗りを待たずに聞き直す', async () => {
    // `GET /managers` は resume と同じ HTTP 経路なので、器の起動直後・瞬断・
    // 一時的な 5xx でこける。**ここで黙って引き下がると、resume の再試行と
    // 同じ恒久停止が「生死確認の段階」に残る** — SSE は安定しているので次の
    // 名乗りは来ず、台帳は `running` のままセッションは不在になる。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    expect(fake.state.resumes).toHaveLength(1);

    // swap 後の最初の `list()` だけ落とす（SSE は繋がったまま）。
    let asked = 0;
    fake.runner.list = async () => {
      asked += 1;
      if (asked === 1) throw new RunnerHttpError('runner GET /managers が失敗した (503)', 503);
      return [...fake.state.alive];
    };

    fake.swap();

    await expect.poll(() => asked, { timeout: 2000 }).toBe(1);
    expect(fake.state.resumes).toHaveLength(1);

    // 名乗りも `manager_send` も追加せずに、聞き直して resume まで到達する。
    await expect.poll(() => fake.state.resumes.length, { timeout: 5000 }).toBe(2);
    expect(fake.state.resumes[1]).toMatchObject({ managerId: 'mgr-running' });

    await s.pool.stop();
  });

  it('台帳を引けなかったときも、次の名乗りを待たずに引き直す', async () => {
    // 記憶ストア側の一時障害も同じ予約経路に載せる。ここだけ「黙って終わる」に
    // すると、同じ恒久停止が別の段階に残る。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    expect(fake.state.resumes).toHaveLength(1);

    const listJobs = stores.jobs.listJobs.bind(stores.jobs);
    let reads = 0;
    stores.jobs.listJobs = async () => {
      reads += 1;
      if (reads === 1) throw new Error('台帳が一時的に読めない');
      return listJobs();
    };

    fake.swap();

    await expect.poll(() => reads, { timeout: 2000 }).toBe(1);
    await expect.poll(() => fake.state.resumes.length, { timeout: 5000 }).toBe(2);

    await s.pool.stop();
  });

  it('投げ直しても同じ答えが返る失敗は、無限に再試行せずクローンへ知らせる', async () => {
    // 400 は runner が「その命令は受け取れない」と答えている。同じものを投げ直しても
    // 同じ答えが返るので、黙って `running` のまま置くのでも回し続けるのでもなく、
    // 見えるようにするのが唯一の出口である（roadmap M5 受け入れ基準4）。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    let attempts = 0;
    fake.runner.resume = async () => {
      attempts += 1;
      throw new RunnerHttpError('runner POST /managers/x/resume が失敗した (400)', 400);
    };

    fake.swap();

    await expect
      .poll(
        () =>
          s.inbox
            .filter((event) => event.type === 'manager_message')
            .some((event) => (event as { text: string }).text.includes('戻せなかった')),
        { timeout: 2000 },
      )
      .toBe(true);

    // 予約が積まれていないこと（時間を置いても挑み直さない）。
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(attempts).toBe(1);

    await s.pool.stop();
  });

  it('諦めたジョブは、同じ runner の別ジョブの再試行に巻き込まれない', async () => {
    // **予約は runner 単位、諦めの判定はジョブ単位である。** ジョブ側に覚えないと、
    // 同じ runner に一時障害のジョブが1本あるだけで予約が積まれ続け、4xx で
    // 「挑み直さない」と決めたジョブが毎回巻き込まれる。runner への無意味な
    // resume と、同じ障害通知が予約の間隔ごとにクローンの受信箱へ積み上がる
    // （`isRetryableRunnerError` と README の約束が複数ジョブで破れる）。
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-broken' });
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-flaky' });
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    expect(fake.state.resumes).toHaveLength(2);

    const original = fake.runner.resume.bind(fake.runner);
    const tries = { broken: 0, flaky: 0 };
    fake.runner.resume = async (command) => {
      if (command.managerId === 'mgr-broken') {
        tries.broken += 1;
        throw new RunnerHttpError('runner POST resume が失敗した (400)', 400);
      }
      tries.flaky += 1;
      if (tries.flaky <= 2) {
        throw new RunnerHttpError('runner POST resume が失敗した (503)', 503);
      }
      return original(command);
    };

    fake.swap();

    // flaky は 503 を2回踏んでから戻る（＝予約が2回積まれる）。
    await expect.poll(() => tries.flaky, { timeout: 8000 }).toBe(3);
    await expect
      .poll(() => fake.state.resumes.some((r) => r.managerId === 'mgr-flaky'), { timeout: 8000 })
      .toBe(true);

    // その間、broken は1回しか試されず、通知も1回だけ。
    expect(tries.broken).toBe(1);
    const notices = s.inbox.filter(
      (event) =>
        event.type === 'manager_message' &&
        (event as { managerId: string }).managerId === 'mgr-broken' &&
        (event as { text: string }).text.includes('戻せなかった'),
    );
    expect(notices).toHaveLength(1);

    // **人間とクローンの明示的な経路は塞がない。** 諦めたのは自動の取り直しだけで、
    // 頼まれたら投げに行く（結果は呼び手へ返る。ここでは runner が 400 を返す）。
    await expect(s.pool.send('mgr-broken', 'やり直して')).rejects.toThrow('400');
    expect(tries.broken).toBe(2);

    await s.pool.stop();
  });

  it('別の runner のジョブには手を出さない（M5 で runner が増えても混ざらない）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-elsewhere', runnerId: 'runner-second' });
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    fake.swap();

    await expect.poll(() => fake.state.listCalls, { timeout: 2000 }).toBeGreaterThan(1);
    // 入れ替わったのは runner-primary の器だけ。他所の宛先まで起こし直さない
    // （`#runners.get('runner-second')` が null を返すので `restore` も触らない）。
    expect(fake.state.resumes).toHaveLength(0);

    await s.pool.stop();
  });
});

/**
 * resume を SDK 側に拒まれる runner。
 *
 * 実機で起きたのはこれである（`No conversation found with session ID: …`）。
 * **失敗は `POST /managers/:id/resume` の応答としては返ってこない** — 命令は
 * 受理され、開いたストリームの側から後で落ちてくる。だから「resume を投げられた」
 * ことと「続きへ戻れた」ことは別物であり、前者だけを見ている限りこの穴は塞がらない。
 */
function resumeRejectingSdk(
  /**
   * 拒まれ方は実機で2種類出ている。
   *
   * - `no-conversation`: init すら来ずに落ちる（`No conversation found …`）
   * - `error-result`: 開きはするが、その回が結果なしで終わる（`error_during_execution`）
   * - `after-work`: 手が動いた後で落ちる。**これは resume の失敗ではない**
   */
  how: 'no-conversation' | 'error-result' | 'after-work' = 'no-conversation',
) {
  const opened: { resume: string | undefined; inputs: string[] }[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    const inputs: string[] = [];
    opened.push({ resume: options.resume, inputs });

    void (async () => {
      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        inputs.push(String(message.message.content));
      }
    })();

    let finish: (() => void) | null = null;

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      if (options.resume !== undefined && how === 'no-conversation') {
        // **init すら来ない。** SDK は開いた直後にこれを投げる。
        await new Promise((resolve) => setTimeout(resolve, 0));
        throw new Error(
          'Claude Code returned an error result:\n' +
            `No conversation found with session ID: ${options.resume}`,
        );
      }

      if (options.resume !== undefined) {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: options.resume,
          uuid: 'uuid-init',
        } as unknown as SDKMessage;

        if (how === 'after-work') {
          // 実際に道具を動かしてから落ちる（済んだ作業がある）。
          const matchers = options.hooks?.PostToolUse as HookCallbackMatcher[];
          for (const matcher of matchers) {
            for (const hook of matcher.hooks) {
              await hook(
                { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} } as never,
                undefined,
                { signal: new AbortController().signal },
              );
            }
          }
          throw new Error('マネージャーのセッションが途中で落ちた');
        }

        yield {
          type: 'result',
          subtype: 'error_during_execution',
          session_id: options.resume,
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
        return;
      }
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-after-fallback',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      // 新しいセッションは、閉じられるまで開いたまま手を動かし続ける
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, opened };
}

describe('前のセッションへ戻れなかったとき（M4 受け入れ基準2）', () => {
  const runningJob = {
    id: 'mgr-lost',
    managerId: 'mgr-lost',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '移行作業',
    request: 'DB の移行をやって',
    cwd: '/work/project',
    sessionId: 'sess-before-restart',
    projectKey: 'proj-key',
    lastReport: 'スキーマまで書いた',
  };

  const savedLog = [
    { type: 'user', message: { role: 'user', content: 'DB の移行をやって' } },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'スキーマまで書いた' }] },
    },
  ];

  function setupRejecting(
    entries: unknown[] | null,
    how: 'no-conversation' | 'error-result' | 'after-work' = 'no-conversation',
    /**
     * 同じ台帳を引き継いだ**作り直しのデーモン**を組むときに渡す。プロセス内の
     * 記憶（`#unresumable`）は引き継がれない — そこが問題の在り処である。
     */
    reuse?: Stores,
  ) {
    const { fn, opened } = resumeRejectingSdk(how);
    const sessionStore = {
      append: async () => undefined,
      load: async (key: { projectKey: string; sessionId: string }) =>
        (entries !== null && key.projectKey === 'proj-key' ? entries : null) as never,
    };
    const stores = reuse ?? { ...createMemoryStores(), sessionStore };
    const inbox: InboxEvent[] = [];
    const runner = createLocalRunner({
      runnerId: 'runner-test',
      workspacePath: '/work/project',
      queryFn: fn,
      env: { PATH: '/usr/bin' },
    });
    const registry = createRunnerRegistry([runner]);
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: registry,
      profile: createProfileService({ stores, runners: registry }),
    });
    return { pool, stores, inbox, opened };
  }

  it('session_id で戻れなくても、預かった生ログから続きを起こす', async () => {
    // **黙って引き下がらない。** 器が落ちたことを理由に仕事を止めてよいのは
    // 承認待ちのときだけである（PRD「自律」）。session_id が腐っていても、
    // 生ログはデーモンが預かっているのだから、そこから組み立て直せる。
    const s = setupRejecting(savedLog);
    await s.stores.jobs.putJob(runningJob);

    await s.pool.restore();

    // 1本目は resume（拒まれる）、2本目は resume 無しで開き直したもの
    await expect.poll(() => s.opened.length, { timeout: 2000 }).toBe(2);
    expect(s.opened[0]?.resume).toBe('sess-before-restart');
    expect(s.opened[1]?.resume).toBeUndefined();

    // 新しいセッションには、失われたセッションの記録が渡っている
    await expect
      .poll(() => (s.opened[1]?.inputs ?? []).join('\n'), { timeout: 2000 })
      .toContain('スキーマまで書いた');
    expect((s.opened[1]?.inputs ?? []).join('\n')).toContain('DB の移行をやって');

    // クローンは「前のセッションからは戻れなかった」ことを知る（黙って続けない）
    const notice = s.inbox.find(
      (event) => event.type === 'manager_message' && event.text.includes('生ログ'),
    );
    expect(notice).toBeDefined();

    await s.pool.stop();
  });

  /**
   * #252: `#notifyResumeFallback` も「生ログから作り直して続けた」という**事実の
   * 知らせ**でしかない。依頼文・直近の報告を全文で持たせる理由が無い。
   */
  it('#252: 依頼文・直近の報告が巨大でも、生ログからの知らせは全文を埋め込まない', async () => {
    // **末尾だけに現れる目印を混ぜる。** 本文が同じ語の繰り返しだと、抜粋が
    // 残す先頭部分にも「末尾と同じ文字列」が偶然含まれてしまい、末尾の断片で
    // 判定したつもりが先頭一致と区別できなくなる（このテストを書く過程で実際に
    // 一度それで落ちた）。抜粋に絶対に現れない一意な目印を末尾へ置く。
    const hugeRequest = 'これは巨大な依頼文である。'.repeat(300) + REQUEST_TAIL_MARKER;
    const hugeReport = 'これは巨大な直近の報告である。'.repeat(300) + REPORT_TAIL_MARKER;
    const s = setupRejecting(savedLog);
    await s.stores.jobs.putJob({ ...runningJob, request: hugeRequest, lastReport: hugeReport });

    await s.pool.restore();

    await expect
      .poll(
        () =>
          s.inbox.find(
            (event) => event.type === 'manager_message' && event.text.includes('生ログ'),
          ),
        { timeout: 2000 },
      )
      .toBeDefined();
    const notice = s.inbox.find(
      (event) => event.type === 'manager_message' && event.text.includes('生ログ'),
    ) as { text: string };

    const requestTail = REQUEST_TAIL_MARKER;
    const reportTail = REPORT_TAIL_MARKER;
    expect(notice.text).not.toContain(hugeRequest);
    expect(notice.text).not.toContain(hugeReport);
    expect(notice.text).not.toContain(requestTail);
    expect(notice.text).not.toContain(reportTail);

    expect(notice.text.length).toBeLessThan(1000);
    expect(notice.text.length).toBeLessThan(hugeRequest.length);
    expect(notice.text.length).toBeLessThan(hugeReport.length);

    expect(notice.text).toContain(`manager_report managerId=${runningJob.id}`);
    expect(notice.text).toContain('part=request');
    expect(notice.text).toContain('文字省略');

    await s.pool.stop();
  });

  it('生ログも無いなら、再試行を打ち切ってクローンへ知らせる', async () => {
    // 投げ直しても同じ答えしか返らない失敗である。**黙って挑み続けない** —
    // 同じ session_id の resume が繰り返されると、同じ障害通知が受信箱に積み上がる
    // だけで、誰も状況を知れないまま台帳の `running` が残る。
    const s = setupRejecting(null);
    await s.stores.jobs.putJob(runningJob);

    await s.pool.restore();

    await expect
      .poll(
        () =>
          s.inbox.find(
            (event) => event.type === 'manager_message' && event.text.includes('戻せなかった'),
          ),
        { timeout: 2000 },
      )
      .toBeDefined();
    const notice = s.inbox.find(
      (event) => event.type === 'manager_message' && event.text.includes('戻せなかった'),
    ) as { text: string };
    expect(notice.text).toContain('自動では再試行しない');
    // **#252（2026-08-23 反転）: 依頼文はもう埋め込まない。** 送り返す理由が無い
    // 依頼文の代わりに、`manager_report ... part=request` への案内が残る。
    expect(notice.text).not.toContain('DB の移行をやって');
    expect(notice.text).toContain('manager_report managerId=mgr-lost');

    // 生ログが無いのだから、勝手に白紙のセッションを起こさない
    expect(s.opened.filter((entry) => entry.resume === undefined)).toHaveLength(0);

    await s.pool.stop();
  });

  /**
   * #252: `#notifyUnresumable` も「前のセッションから戻せなかった」という**事実の
   * 知らせ**でしかない。依頼文・直近の報告を全文で持たせる理由が無い。
   */
  it('#252: 依頼文・直近の報告が巨大でも、戻せなかった知らせは全文を埋め込まない', async () => {
    // **末尾だけに現れる目印を混ぜる。** 本文が同じ語の繰り返しだと、抜粋が
    // 残す先頭部分にも「末尾と同じ文字列」が偶然含まれてしまい、末尾の断片で
    // 判定したつもりが先頭一致と区別できなくなる（このテストを書く過程で実際に
    // 一度それで落ちた）。抜粋に絶対に現れない一意な目印を末尾へ置く。
    const hugeRequest = 'これは巨大な依頼文である。'.repeat(300) + REQUEST_TAIL_MARKER;
    const hugeReport = 'これは巨大な直近の報告である。'.repeat(300) + REPORT_TAIL_MARKER;
    const s = setupRejecting(null);
    await s.stores.jobs.putJob({ ...runningJob, request: hugeRequest, lastReport: hugeReport });

    await s.pool.restore();

    await expect
      .poll(
        () =>
          s.inbox.find(
            (event) => event.type === 'manager_message' && event.text.includes('戻せなかった'),
          ),
        { timeout: 2000 },
      )
      .toBeDefined();
    const notice = s.inbox.find(
      (event) => event.type === 'manager_message' && event.text.includes('戻せなかった'),
    ) as { text: string };

    const requestTail = REQUEST_TAIL_MARKER;
    const reportTail = REPORT_TAIL_MARKER;
    expect(notice.text).not.toContain(hugeRequest);
    expect(notice.text).not.toContain(hugeReport);
    expect(notice.text).not.toContain(requestTail);
    expect(notice.text).not.toContain(reportTail);

    expect(notice.text.length).toBeLessThan(1000);
    expect(notice.text.length).toBeLessThan(hugeRequest.length);
    expect(notice.text.length).toBeLessThan(hugeReport.length);

    expect(notice.text).toContain(`manager_report managerId=${runningJob.id}`);
    expect(notice.text).toContain('part=request');
    expect(notice.text).toContain('文字省略');

    await s.pool.stop();
  });

  /**
   * **「戻せなかった」を「成果が無い」と言い換えない。**
   *
   * デーモンが観測したのは resume の失敗だけで、PR もブランチも見ていない
   * （リポジトリの事情はマネージャーの領域であって、デーモンが知るべきもので
   * はない）。2026-08-16T03:15 に、落ちる直前に PR を出して CI を通しマージ
   * まで届いていた仕事が、その1分半後の器の作り直しでこの経路を通った。
   * 知らせが「起こし直せ」で終わると、済んだ仕事をもう一度走らせる。
   */
  it('戻せなかった知らせは、成果の有無を断定せずリモートを確かめさせる', async () => {
    const s = setupRejecting(null);
    await s.stores.jobs.putJob(runningJob);

    await s.pool.restore();

    await expect
      .poll(
        () =>
          s.inbox.find(
            (event) => event.type === 'manager_message' && event.text.includes('戻せなかった'),
          ),
        { timeout: 2000 },
      )
      .toBeDefined();
    const notice = s.inbox.find(
      (event) => event.type === 'manager_message' && event.text.includes('戻せなかった'),
    ) as { text: string };

    // 観測していないことを断定しない。
    expect(notice.text).toContain('「仕事が終わっていない」ことの証拠ではない');
    // 次の一手が書いてある（起こし直す前に確かめる先）。
    expect(notice.text).toMatch(/リモート|PR/);
    expect(notice.text).toContain('起こし直す前に');

    await s.pool.stop();
  });

  it('開きはしたが結果なしで終わった resume も、戻れなかったものとして扱う', async () => {
    // もう1つの実機の顔（`error_during_execution`）。**`init` が来たことを
    // 「戻れた」と読まない** — 開いただけで何も返せていないなら、続きは進まない。
    const s = setupRejecting(savedLog, 'error-result');
    await s.stores.jobs.putJob(runningJob);

    await s.pool.restore();

    await expect.poll(() => s.opened.length, { timeout: 2000 }).toBe(2);
    expect(s.opened[1]?.resume).toBeUndefined();
    await expect
      .poll(() => (s.opened[1]?.inputs ?? []).join('\n'), { timeout: 2000 })
      .toContain('スキーマまで書いた');

    await s.pool.stop();
  });

  it('手が動いた後に落ちたのなら作り直さない（済んだ作業を二度走らせない）', async () => {
    // ここを「落ちたら作り直す」に広げると、コミットや PR を出した後の失敗で
    // 同じ作業を記録から二度走らせることになる。resume の失敗として扱うのは
    // **このセッションがまだ何もしていないとき**だけである。
    const s = setupRejecting(savedLog, 'after-work');
    await s.stores.jobs.putJob(runningJob);

    await s.pool.restore();

    // 落ちたことは伝わるが、白紙から起こし直しはしない
    await expect
      .poll(
        () =>
          s.inbox.find(
            (event) => event.type === 'manager_message' && event.text.includes('落ちた'),
          ),
        { timeout: 2000 },
      )
      .toBeDefined();
    expect(s.opened.filter((entry) => entry.resume === undefined)).toHaveLength(0);

    await s.pool.stop();
  });

  it('打ち切ったマネージャーは、デーモンを作り直しても二度と resume されない', async () => {
    // **「もう戻せない」がプロセス内の記憶（`#unresumable`）にしか無い。** 台帳へ
    // 残るのは `done`（＝直近の依頼を終えて待機中）である — 結果なしで終わった
    // resume が、そのまま「1ターン終わった」として報告に化けるからである。
    //
    // 器を作り直すと記憶は消え、台帳の `done` だけが残る。クローンから見えるのは
    // 「待機中で、話しかければ続くマネージャー」であり、実際には腐った session_id
    // しか無い。デプロイのたびに同じ死体へ話しかけ、同じ失敗の通知が積み上がる。
    // **戻せなかった仕事が「終わった」に見えるのが最も悪い** — 失われた仕事が
    // 完了として片付き、誰も起こし直さない。
    const first = setupRejecting(null, 'error-result');
    await first.stores.jobs.putJob(runningJob);

    await first.pool.restore();
    await expect
      .poll(
        () =>
          first.inbox.find(
            (event) => event.type === 'manager_message' && event.text.includes('戻せなかった'),
          ),
        { timeout: 2000 },
      )
      .toBeDefined();
    await first.pool.stop();

    // 台帳が「戻せない」を覚えている。`done`（待機中）でも `running` でもない。
    const stored = (await first.stores.jobs.listJobs()).find((job) => job.id === 'mgr-lost');
    expect(stored?.status).toBe('lost');

    // 器を入れ替えたデーモン。プロセス内の記憶は空だが、台帳は引き継いでいる。
    const second = setupRejecting(null, 'error-result', first.stores);

    expect(await second.pool.restore()).toEqual([]);
    // resume を投げ直していない（同じ死体をもう一度起こしに行かない）。
    expect(second.opened).toHaveLength(0);
    // 同じ通知も積み直さない（一度知らせたことを毎回言い直さない）。
    expect(second.inbox.filter((event) => event.type === 'manager_message')).toEqual([]);

    // **「終わった」ではない。** クローンが起こし直す対象として見分けられる。
    const listed = (await second.pool.list()).find((m) => m.managerId === 'mgr-lost');
    expect(listed).toMatchObject({ status: 'lost', live: false });

    await second.pool.stop();
  });

  it('送信に失敗した直後の一覧が、lost を live: true へ格上げしない', async () => {
    // **人間がこの画面を見るのは、まさに送った直後である**（送ったから状態を
    // 確かめる）。`send()` は宛先を `#load()` でプロセス内の像へ載せてから resume を
    // 投げるので、投げた先で失敗しても像は残る。その像を `list()` が既定の
    // `live: true` で見せると、`status: lost`（前のセッションへ戻れなかった）と
    // `live: true`（繋がっている）という両立しない組が出る。台帳は正しいまま
    // なので、**嘘をつくのは一覧だけ**である。
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, status: 'lost' });
    const fake = swappableRunner('runner-test');
    let attempted = 0;
    fake.runner.resume = async () => {
      attempted += 1;
      // 実機で出たのはこれ（runner の HTTP 経路が 400 を返す）。
      throw new Error('runner POST /managers/mgr-lost/resume が失敗した (400)');
    };
    const s = setup(undefined, { stores, runner: fake.runner });

    // 送る前。台帳にしか無いので `live: false`（ここは既に守られている）。
    expect((await s.pool.list()).find((m) => m.managerId === 'mgr-lost')).toMatchObject({
      status: 'lost',
      live: false,
    });

    await expect(s.pool.send('mgr-lost', '続きをやって')).rejects.toThrow();
    // **resume まで届いたうえで失敗した**ことを固定する。ここを見ないと、
    // send() が別の理由で早々に落ちても緑になる。
    expect(attempted).toBe(1);

    const listed = (await s.pool.list()).find((m) => m.managerId === 'mgr-lost');
    expect(listed).toMatchObject({ status: 'lost', live: false });

    await s.pool.stop();
  });

  it('resume の失敗が後から降ってきても、一覧は lost を live: true で見せない', async () => {
    // 同じ嘘へのもう1本の道。`resume_failed` は**受理された後**に SSE で降りてくる
    // ので、そのとき像は既に `#records` に居る。ここで `status: lost` /
    // `attached: false` へ落としても、一覧が像を無条件に `live: true` と数えるなら
    // 表示は変わらない。**`#load()` を直すだけでは塞がらない**のはこの経路である。
    const s = setupRejecting(null, 'error-result');
    await s.stores.jobs.putJob(runningJob);

    await s.pool.restore();
    await expect
      .poll(
        () =>
          s.inbox.find(
            (event) => event.type === 'manager_message' && event.text.includes('戻せなかった'),
          ),
        { timeout: 2000 },
      )
      .toBeDefined();

    // 台帳を落としたのと同じデーモンが、そのまま一覧を出す。
    const listed = (await s.pool.list()).find((m) => m.managerId === 'mgr-lost');
    expect(listed).toMatchObject({ status: 'lost', live: false });

    await s.pool.stop();
  });
});

/**
 * 報告の受信経路（クローンは「送られた」ではなく「届いた」ものしか読めない）。
 *
 * マネージャーの1ターンの出力は、SDK の `result` 1本では表せない。人間が
 * Claude Code の画面で読んでいるのは**そのターンに出た本文すべて**であり、
 * `result` はその最後の一片でしかないことがある（道具を挟むたびに本文は
 * 切れる）。`result` だけを報告にすると、クローンには末尾だけが届き、
 * **欠けていることが誰にも見えない**。人間より読めるものが少ない＝デグレード
 * （north_star 禁止1）であり、断片から全体像を組み立てた誤判断の原因になる。
 */
describe('マネージャーの報告を黙って落とさない', () => {
  it('道具で分断された本文も、6つ出したなら6つとも届く', async () => {
    const s = setup();
    await s.pool.start({ request: '6セクションで報告して' });
    const session = s.sessions[0] as FakeSession;

    // 前半を喋る → 道具を使う → 後半を喋る。SDK の `result` に載るのは
    // 最後の一片だけ、という実機で起きた形をそのまま作る。
    await session.say('## 1\n本文1\n\n## 2\n本文2\n\n## 3\n本文3');
    await session.say('## 4\n本文4\n\n## 5\n本文5\n\n## 6\n本文6');
    await session.report('## 5\n本文5\n\n## 6\n本文6');

    const reports = await vi.waitFor(() => {
      const found = s.inbox.filter(
        (event) => event.type === 'manager_message' && event.kind === 'report',
      );
      if (found.length === 0) throw new Error('報告がまだ届いていない');
      return found;
    });
    const delivered = reports.map((event) => (event as { text: string }).text).join('\n');

    for (const section of ['## 1', '## 2', '## 3', '## 4', '## 5', '## 6']) {
      expect(delivered).toContain(section);
    }

    await s.pool.stop();
  });

  it('作業者の本文はマネージャーの報告に混ぜない', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = s.sessions[0] as FakeSession;

    await session.say('マネージャーの結論');
    // 作業者（Task の中）の本文は `parent_tool_use_id` が付く。これは
    // マネージャーが人間へ向けて喋ったものではない。
    await session.say('作業者の途中経過', { parentToolUseId: 'tool-1' });
    await session.report('マネージャーの結論');

    const report = await vi.waitFor(() => {
      const found = s.inbox.find(
        (event) => event.type === 'manager_message' && event.kind === 'report',
      );
      if (!found) throw new Error('報告がまだ届いていない');
      return found as { text: string };
    });

    expect(report.text).toContain('マネージャーの結論');
    expect(report.text).not.toContain('作業者の途中経過');

    await s.pool.stop();
  });

  it('前のターンの本文を次のターンの報告へ持ち越さない', async () => {
    const s = setup();
    await s.pool.start({ request: '2回に分けて答えて' });
    const session = s.sessions[0] as FakeSession;

    await session.say('1回目の答え');
    await session.report('1回目の答え');
    await session.say('2回目の答え');
    await session.report('2回目の答え');

    const reports = await vi.waitFor(() => {
      const found = s.inbox.filter(
        (event) => event.type === 'manager_message' && event.kind === 'report',
      );
      if (found.length < 2) throw new Error('報告がまだ2本届いていない');
      return found as { text: string }[];
    });

    expect(reports[reports.length - 1]?.text).not.toContain('1回目の答え');

    await s.pool.stop();
  });
});

/**
 * **report の冪等化（#206）。**
 *
 * `ask` には `requestId` による冪等化（`#askedOf`）が在るのに、`report` には
 * 対応するものが無かった、という非対称を埋める変更（`runnerEventSchema` の
 * `report.reportId` と `manager.ts` の `case 'report':` の doc を参照）。
 * ここでは `swappableRunner` で直接 `RunnerEvent` を組み立てて emit する
 * ——SDK 層を経由しないので、`reportId` の有無を単体で制御できる。
 */
describe('report の冪等化（#206）', () => {
  const job = {
    id: 'mgr-report-idempotent',
    managerId: 'mgr-report-idempotent',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: 'sess-report-idempotent',
    runnerId: 'runner-primary',
  };

  async function running() {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);
    const fake = swappableRunner();
    fake.state.alive.push({
      managerId: job.id,
      status: 'running',
      cwd: job.cwd,
      request: job.request,
      waiting: [],
      sessionId: job.sessionId,
    });
    const s = setup(undefined, { stores, runner: fake.runner });
    // **`swappableRunner#connect` は `#ensureConnected`（`restore()` の中）が
    // 呼ぶまで `emit` を持たない。** ここを省くと `fake.report(...)` の
    // `emit?.(...)` が無言で no-op になり、イベントは `#onEvent` へ一切
    // 届かない（`stopped()` が `pool.abort()` を先に呼んでいるのと同じ理由）。
    await s.pool.restore();
    // **`restore()` は「runner の中で走り続けている」の知らせ（`#notifyRestored`）
    // を fire-and-forget で受信箱へ積む。** ここを待たずに `before = s.inbox.length`
    // を取ると、この知らせが後から紛れ込んで冪等化の歯を汚す
    // （`journalHas` と同じ「処理が終わった合図が要る」形）。
    await vi.waitFor(() => {
      if (s.inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
    });
    return { s, fake };
  }

  /** 台帳の1件を直接読む（`jobOf` と同じ理由 — 一覧は写し忘れうる）。 */
  async function jobOf(s: Setup, managerId: string) {
    return (await s.stores.jobs.listJobs()).find((entry) => entry.id === managerId);
  }

  it('同じ reportId の report が二度届いても、受信箱には一度しか積まれない', async () => {
    const { s, fake } = await running();
    const before = s.inbox.length;
    // `restore()` の知らせも `#journal` を通るので、こちらも基準を後で取る
    // （直上の `before` と同じ理由）。
    const journalBefore = (await s.stores.journal.list({ types: ['exchange'] })).length;

    fake.report(job.id, '1回目の届け', 'done', { reportId: 'rep-dup-1' });
    fake.report(job.id, '1回目の届け（再送）', 'done', { reportId: 'rep-dup-1' });

    await vi.waitFor(async () => {
      const current = await jobOf(s, job.id);
      if (current?.lastReport !== '1回目の届け') throw new Error('台帳がまだ更新されていない');
    });
    // 再送のぶんが後から紛れ込んでいないことまで、少し待って確かめる
    // （fire-and-forget なので即座には判定できない——上の `settleAfterJournal`
    // と同じ理由。ここは待ち切ってから数える）。
    await new Promise((resolve) => setTimeout(resolve, 20));

    // **`before` から後ろだけを見る。** `restore()` 自身が「runner の中で
    // 走り続けている」の知らせを `kind: 'report'` で1件積んでいる
    // （`running()` の doc）ので、種類だけで絞ると先頭にそれが混ざる。
    const reports = s.inbox
      .filter((event) => event.type === 'manager_message' && event.kind === 'report')
      .slice(before);
    expect(reports).toHaveLength(1);
    expect((reports[0] as { text: string }).text).toBe('1回目の届け');

    // 台帳にも再送の本文が乗っていない（1回目のまま）。
    const current = await jobOf(s, job.id);
    expect(current?.lastReport).toBe('1回目の届け');

    // 日誌にも exchange が1件しか増えていない。
    const entries = await s.stores.journal.list({ types: ['exchange'] });
    expect(entries).toHaveLength(journalBefore + 1);

    await s.pool.stop();
  });

  it('reportId が違えば、どちらも別の報告として届く', async () => {
    const { s, fake } = await running();
    const before = s.inbox.length;

    fake.report(job.id, '1件目', 'done', { reportId: 'rep-a' });
    fake.report(job.id, '2件目', 'done', { reportId: 'rep-b' });

    const reports = await vi.waitFor(() => {
      const found = s.inbox.filter(
        (event) => event.type === 'manager_message' && event.kind === 'report',
      );
      if (found.length < before + 2) throw new Error('2件とも届いていない');
      return found.slice(before);
    });
    expect(reports.map((event) => (event as { text: string }).text)).toEqual(['1件目', '2件目']);

    await s.pool.stop();
  });

  it('reportId の無い report（旧 runner 相当）は、これまでどおり毎回処理される', async () => {
    const { s, fake } = await running();
    const before = s.inbox.length;

    // **旧 runner はこの欄を送らない。** #206 の判断は「冪等化を諦める」——
    // 拒んで捨てる方は選んでいない。この歯はその判断が実際にそう動くことを
    // 固定する（`manager.ts` の `case 'report':` の doc）。
    fake.report(job.id, '旧runnerの報告', 'done');
    fake.report(job.id, '旧runnerの報告（2回目）', 'done');

    const reports = await vi.waitFor(() => {
      const found = s.inbox.filter(
        (event) => event.type === 'manager_message' && event.kind === 'report',
      );
      if (found.length < before + 2) throw new Error('2件とも届いていない');
      return found.slice(before);
    });
    expect(reports.map((event) => (event as { text: string }).text)).toEqual([
      '旧runnerの報告',
      '旧runnerの報告（2回目）',
    ]);

    await s.pool.stop();
  });
});

/**
 * **止めたことと、止まったことは別である。**
 *
 * `runner.stop()` は該当のセッションが手元に無ければ**黙って何もしない**
 * （`#sessions.get(id)?.stop()`）。受理だけを見て「止まった」と言うと、走り
 * 続けているマネージャーを止めたことにしてしまう — 人間もクローンも、止めた
 * つもりで次の判断へ進む。実際に畳まれたセッションは runner の一覧から消える
 * （`onClosed`）ので、そこまで見に行く。
 *
 * 人間の口（`DELETE /managers/:id`）もクローンの `manager_stop` も、ここを通る。
 */
describe('止めた結果を確かめる', () => {
  const job = {
    id: 'mgr-stopme',
    managerId: 'mgr-stopme',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '暴走中',
    request: '延々と直し続けている',
    cwd: '/work/project',
    sessionId: 'sess-stopme',
    runnerId: 'runner-primary',
  };

  it('セッションが畳まれたら、止まったと言い切る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);
    const fake = swappableRunner();
    fake.state.alive.push({
      managerId: job.id,
      status: 'running',
      cwd: job.cwd,
      request: job.request,
      waiting: [],
      sessionId: job.sessionId,
    });
    // 本物どおり、止めたセッションは一覧から消える。
    const runner = {
      ...fake.runner,
      async stop(managerId: string) {
        fake.state.alive = fake.state.alive.filter((s) => s.managerId !== managerId);
      },
    };
    const s = setup(undefined, { stores, runner });

    const result = await s.pool.abort(job.id, '暴走したので');

    expect(result.outcome).toBe('stopped');
    expect(result.sessionGone).toBe(true);
    expect(result.detail).not.toContain('止まりきっていない');
    // **2026-08-21 に反転。** 直す前は `sessionGone === true`（止まったと確かめた）
    // でも台帳の `status` を `'done'`（＝終えて待機中。セッションは生きている）に
    // 書いていた——止めた事実と「待機中」が1語に潰れ、`isLive()` は
    // `record.job.sessionId` が残っていることを理由に `live: true` を返して
    // いた（このテストは元々それを固定していた）。いまは `'stopped'` という
    // 専用の終端状態を持つので、ここを反転する（PR「『止めた』を、止まったと
    // 確かめたときだけそう言う」の3点セット：期待値だけ反転・元のコメントは
    // 上に残す・PR 本文に理由を書く）。
    const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(listed?.status).toBe('stopped');
    expect(listed?.live).toBe(false);

    await s.pool.stop();
  });

  /**
   * **未回答の待ちがある状態で止めてみる。** `not_stopped` は「確かめられて
   * いない」ではなく「止まっていないと確かめた」明確な失敗なので、生きている
   * かもしれないマネージャーの状態を1文字も畳んではいけない——`waiting`（未回答
   * の許可確認）が消えないことまで確かめる。
   *
   * **2026-08-22 に2本へ割った（変異試験で分離を確認）。** 元は1本の `it()` で
   * 「`outcome` の正しさ」と「台帳を1文字も書かない」の両方を順に assert して
   * いた。変異試験でこの2つを別々に壊すと（1: `outcome` を常に `'stopped'` に
   * 固定する／2: `outcome === 'stopped'` の台帳書き込みガードを外す）、
   * **どちらの変異でも同じ1本が落ちた**——`outcome` を常に `'stopped'` にすると
   * ガードの条件も常に真になり台帳まで書き換わるので、1つの変異が両方の保証を
   * 一緒に壊してしまい、テストの落ち方だけでは「どちらの保証が壊れたか」が
   * 見分けられなかった。`outcome` の正しさ（何を確かめたか）と、台帳を書かない
   * こと（確かめられていないものへの副作用が無いか）は別の保証なので、
   * `abort()` は fire-and-forget な後続処理を持たず全部 `await` 済みで返る
   * （`#onEvent` の R4 系と違って完了待ちの同期が要らない）ことを使い、
   * 単純に2つの `it()` へ分けた。アサーションは1つも削っていない。
   */
  async function abortWithLiveSession() {
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...job, status: 'waiting_human' });
    // `swappableRunner` の `stop` は何もしない ＝ 受理はするが畳まない器。
    const fake = swappableRunner();
    fake.state.alive.push({
      managerId: job.id,
      status: 'waiting_human',
      cwd: job.cwd,
      request: job.request,
      waiting: [
        {
          requestId: 'req-1',
          summary: '本番に触ってよいか',
          kind: 'permission',
          askedAt: '2026-08-01T01:00:00.000Z',
        },
      ],
      sessionId: job.sessionId,
    });
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();
    const result = await s.pool.abort(job.id);
    return { s, result };
  }

  it('セッションが残っていたら、止まったことにしない（outcome の正しさ）', async () => {
    const { s, result } = await abortWithLiveSession();

    // **黙って成功にしない。** 見た結果をそのまま言う。
    expect(result.outcome).toBe('not_stopped');
    expect(result.sessionGone).toBe(false);
    expect(result.detail).toContain('止まっていない');

    await s.pool.stop();
  });

  it('セッションが残っていたら、台帳を1文字も書かない', async () => {
    const { s } = await abortWithLiveSession();

    // **台帳を1文字も書かない。** status も waiting も、止める前のままである。
    const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(listed?.status).toBe('waiting_human');
    expect(listed?.waiting).toEqual([
      {
        requestId: 'req-1',
        summary: '本番に触ってよいか',
        kind: 'permission',
        askedAt: '2026-08-01T01:00:00.000Z',
      },
    ]);

    await s.pool.stop();
  });

  /**
   * 誰が止めたかは記録に残る。クローンが止めた仕事の日誌に「人間が停止させた」と
   * 残ると、人間とクローンで見えている経緯が食い違う（止まり方は同じである）。
   */
  it('クローンが止めたら、クローンが止めたと残る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.abort(job.id, '報告は出たのに終わらない', 'clone');

    const entries = await s.stores.journal.list({ types: ['exchange'] });
    const stopped = entries.find((entry) => JSON.stringify(entry).includes('（停止）'));
    expect(JSON.stringify(stopped)).toContain('クローンが停止させた');
    expect(JSON.stringify(stopped)).not.toContain('人間が停止させた');

    await s.pool.stop();
  });

  /**
   * **Issue #320。** クローン自身が `manager_stop` で止めたときの知らせは、
   * 同じターンの中で同期の戻り値として既に読めている（`packages/core/src/
   * tools.ts` の `manager_stop` の戻り値が `messageText` の真部分集合を
   * 含む）。非同期の `manager_message` を重ねて配ると、新しい情報が無いのに
   * クローンのターンだけ1回消費する（実測: 終了済み7本を畳んで7ターン）。
   * `abort()` は日誌（`#journal`）を無条件に呼んだうえで、配達（`#post`）
   * だけを `by === 'clone'` のとき省く——このテストは「配らない」側だけを
   * 見る。人間発が今までどおり配ることは、次の
   * 「人間が止めたときは、今までどおり manager_message が1件配られる」で
   * 対にして見る——**この2本は対でなければ意味が無い**。ここだけ緑にして
   * 隣を書かないと、`#post` をまるごと消す変異（human 発まで壊す変異）が
   * 素通りしてしまう。
   */
  it('クローンが manager_stop で止めても、manager_message は配らない（post 0件）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.abort(job.id, '報告は出たのに終わらない', 'clone');

    expect(s.inbox.filter((event) => event.type === 'manager_message')).toHaveLength(0);

    await s.pool.stop();
  });

  /**
   * 直前の「クローンが manager_stop で止めても配らない」と対で読む一本。
   * 人間が止めた事実はクローンにとって外から来た出来事で、同期の戻り値を
   * 持たない（人間は `manager_stop` ツールを呼んでいないので、そのものが
   * 無い）——だからここだけは配達が唯一の経路であり、今までどおり配る。
   */
  it('人間が止めたときは、今までどおり manager_message が1件配られる（クローン発と対で見る）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.abort(job.id, '暴走したので', 'human');

    const messages = s.inbox.filter((event) => event.type === 'manager_message');
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages[0])).toContain('人間が停止させました');

    await s.pool.stop();
  });

  /**
   * `outcome !== 'stopped'` でも、`by === 'clone'` なら配らない。`stopped` の
   * 枝だけを見て `if (by !== 'clone')` を書くと通ってしまう変異
   * （`not_stopped` / `unknown` の枝にだけ古い無条件 `#post` を残す形）を
   * この2本（本テストと次の `unknown`）で塞ぐ。
   */
  it('クローンが止めても、outcome が not_stopped なら配らない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...job, status: 'waiting_human' });
    // `swappableRunner` の `stop` は何もしない ＝ 受理はするが畳まない器。
    const fake = swappableRunner();
    fake.state.alive.push({
      managerId: job.id,
      status: 'waiting_human',
      cwd: job.cwd,
      request: job.request,
      waiting: [{ requestId: 'req-1', summary: '本番に触ってよいか' }],
      sessionId: job.sessionId,
    });
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();
    // **`restore()` 自体が「待ちが残っている」通知を配ることがある** — ここで
    // 数えたいのは `abort()` が新たに配ったぶんだけなので、`restore()` の後で
    // 基準を取り直す（この後は `abort()` しか `#post` を呼ばない）。
    const beforeAbort = s.inbox.length;

    const result = await s.pool.abort(job.id, '報告は出たのに終わらない', 'clone');

    expect(result.outcome).toBe('not_stopped');
    expect(
      s.inbox.slice(beforeAbort).filter((event) => event.type === 'manager_message'),
    ).toHaveLength(0);

    await s.pool.stop();
  });

  it('クローンが止めても、outcome が unknown なら配らない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);
    const fake = swappableRunner();
    const runner = {
      ...fake.runner,
      async stop(): Promise<void> {
        throw new Error('期限切れ（テスト）');
      },
      async list() {
        throw new Error('list も届かない（テスト）');
      },
    };
    const s = setup(undefined, { stores, runner });

    const result = await s.pool.abort(job.id, '報告は出たのに終わらない', 'clone');

    expect(result.outcome).toBe('unknown');
    expect(s.inbox.filter((event) => event.type === 'manager_message')).toHaveLength(0);

    await s.pool.stop();
  });

  /**
   * `markup: 'none'` は、人間が停止理由へ自由記述で打った `reason` が実際に
   * `messageText` へ埋め込まれる回にだけ立つ（issue #287）。条件は
   * `by === 'human' && reason !== undefined` の2つで、**どちらか片方だけ
   * 満たしても立たないことを別々の歯で確かめる。**
   *
   * `outcome === 'stopped'` にしないと `reason` が `messageText` へ埋め込ま
   * れない（`abort()` の `stoppedBase`）ので、「セッションが畳まれたら、
   * 止まったと言い切る」と同じ形（`stop()` がセッションを一覧から消す偽の
   * runner）で `outcome: 'stopped'` を作る。
   */
  async function stoppableSetup(): Promise<Setup> {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);
    const fake = swappableRunner();
    fake.state.alive.push({
      managerId: job.id,
      status: 'running',
      cwd: job.cwd,
      request: job.request,
      waiting: [],
      sessionId: job.sessionId,
    });
    const runner = {
      ...fake.runner,
      async stop(managerId: string) {
        fake.state.alive = fake.state.alive.filter((s) => s.managerId !== managerId);
      },
    };
    return setup(undefined, { stores, runner });
  }

  function findStopMessage(inbox: InboxEvent[], needle: string) {
    return inbox.find(
      (event): event is Extract<InboxEvent, { type: 'manager_message' }> =>
        event.type === 'manager_message' && event.text.includes(needle),
    );
  }

  it("人間が reason 付きで止めたら、manager_message に markup: 'none' が立つ", async () => {
    const s = await stoppableSetup();

    await s.pool.abort(job.id, '*思いつきで* 止めた', 'human');

    const stopped = findStopMessage(s.inbox, '*思いつきで* 止めた');
    expect(stopped).toBeDefined();
    expect(stopped?.markup).toBe('none');

    await s.pool.stop();
  });

  /**
   * **2026-08-24 に反転（Issue #320）。** 直す前は `by === 'clone'` でも
   * `manager_message` が配られていて、ここは「配られはするが `markup` だけは
   * 立たない」ことを固定していた。#320 の修正で `by === 'clone'` のときは
   * そもそも配らなくなった（`abort()` 内の `if (by !== 'clone')`）ので、
   * 「配られる」という前提そのものが崩れている——`markup` の有無を問う以前に、
   * 問う対象の `manager_message` が無い。**保証は弱くなっていない**: 以前は
   * 「配られるが印は無い」だったのが、いまは「配られないので印を心配する
   * 必要が無い」という、より強い形に置き換わっている（`stopped` が
   * `undefined` であること自体が、`markup` が絶対に立たないことの証明を
   * 兼ねる）。この反転自体は「クローンが manager_stop で止めても、
   * manager_message は配らない（post 0件）」と重なるが、**そちらは0件を
   * 数えるだけで、`markup` という観点をこの場所に残す意味がある**ので消さない。
   */
  it('クローンが reason 付きで止めても manager_message は配られない（markup を問うまでもない。by === "clone"）', async () => {
    const s = await stoppableSetup();

    await s.pool.abort(job.id, '報告は出たのに終わらない', 'clone');

    const stopped = findStopMessage(s.inbox, '報告は出たのに終わらない');
    expect(stopped).toBeUndefined();

    await s.pool.stop();
  });

  it('人間が reason 無しで止めても markup は立たない（reason === undefined）', async () => {
    const s = await stoppableSetup();

    // `by` を省略すると既定は 'human'（`abort()` のシグネチャ）。
    await s.pool.abort(job.id);

    const stopped = findStopMessage(s.inbox, '停止させました');
    expect(stopped).toBeDefined();
    expect(stopped?.markup).toBeUndefined();

    await s.pool.stop();
  });

  /**
   * **`outcome !== 'stopped'` では `reason` が本文へ入らない**（`abort()` は
   * `stopped` の枝でだけ `理由: ${reason}` を前置する）。人間が `reason` を
   * 書いていても、その文字が1文字も入っていないメッセージに印を立てるのは嘘で
   * ある — 印は「この text が Markdown として書かれていない」という**その text
   * についての事実**を名乗るものだから（`textMarkupSchema` の doc、
   * `packages/core/src/schema.ts`）。
   *
   * **本文に人間の文字が入っていないことまで見る。** `markup` が立たないこと
   * だけを見ると、「`reason` が入っているのに印だけ落ちた」場合と区別が付かない。
   */
  it('人間が reason 付きでも、止まっていなければ markup は立たない（reason が本文に入らない回）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...job, status: 'waiting_human' });
    // `swappableRunner` の `stop` は何もしない ＝ 受理はするが畳まない器。
    const fake = swappableRunner();
    fake.state.alive.push({
      managerId: job.id,
      status: 'waiting_human',
      cwd: job.cwd,
      request: job.request,
      waiting: [],
      sessionId: job.sessionId,
    });
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    const result = await s.pool.abort(job.id, '*思いつきで* 止めた', 'human');
    expect(result.outcome).toBe('not_stopped');

    const notStopped = findStopMessage(s.inbox, 'まだ止まっていません');
    expect(notStopped).toBeDefined();
    // 人間の文字が本文に1文字も入っていないこと（印を立てない根拠そのもの）
    expect(notStopped?.text).not.toContain('*思いつきで* 止めた');
    expect(notStopped?.markup).toBeUndefined();

    await s.pool.stop();
  });

  it('居ないマネージャーを止めても、黙って成功にしない', async () => {
    const s = setup(undefined, { stores: createMemoryStores(), runner: swappableRunner().runner });

    const result = await s.pool.abort('mgr-nope');

    // **2026-08-21 に反転（改名）。** 「居ない」は PR #137 の語彙で `'unknown'`
    // （確かめられなかった）と紛れる別の観測なので `'absent'` に改名した
    // （`DELETE /managers/:id` はここだけ 404 に写す）。
    expect(result.outcome).toBe('absent');
    expect(result.detail).toContain('mgr-nope');

    await s.pool.stop();
  });

  /**
   * **`runner.stop()` が投げても、`abort()` ごと reject させない（R3）。**
   *
   * HTTP 越しの runner では期限切れ（`RunnerUnknownError`）や明確な失敗（接続
   * 拒否等）が `runner.stop()` から投げられる（`runner-client.ts` の `#call`）。
   * 直す前はここを裸で `await` していたので、投げた瞬間 `abort()` 全体が reject
   * し、日誌の1行も、クローンへの通知も、状態の更新も、何も残らないまま
   * `DELETE /managers/:id` が 500 になっていた。
   *
   * ここでは `runner.list()` の探りも届かないケースを固定する——権威を置く先
   * （`sessionGone`）自体が確かめられないので `'unknown'` が正しい。
   */
  /**
   * **2026-08-22 に3本へ割った。** 元は1本の `it()` で「`outcome` を `'unknown'`
   * で言い切る」「例外を握り潰さない（日誌に残る）」「台帳を1文字も書かない」の
   * 3つを順に assert していた。「セッションが残っていたら」の変異試験（上）で、
   * `outcome` を常に `'stopped'` にする変異（変異1）と台帳の書き込みガード
   * （`if (outcome === 'stopped')`）を外す変異（変異2）を当てたところ、**この
   * テストも同じ形で複数の変異にまたがって落ちた**（変異1はこのテストの
   * `outcome` の行と `status` の行の両方を、変異2は `status` の行だけを壊す）。
   * `status` の書き込みは `outcome === 'stopped'` の分岐の中にあるので、
   * `outcome` を壊す変異は必然的に `status` の保証も一緒に壊す——これは
   * テストの粒度の問題ではなく実装の構造そのもの（`status` の正しさが
   * `outcome` の正しさに依存する）なので、これ以上は分けても分離しきれない。
   * それでも「日誌に握り潰さず残ること」は `outcome` にも `status` の書き込み
   * 分岐にも依存しない独立した保証なので、ここだけは完全に分離できる——
   * 割ることで、少なくとも変異2（台帳ガード外し）が `outcome` の保証と日誌の
   * 保証のどちらにも触れないことが見えるようになる。アサーションは1つも
   * 削っていない。
   */
  async function abortWithUnreachableProbe() {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);
    const fake = swappableRunner();
    const runner = {
      ...fake.runner,
      async stop(): Promise<void> {
        throw new Error('期限切れ（テスト）');
      },
      async list() {
        throw new Error('list も届かない（テスト）');
      },
    };
    const s = setup(undefined, { stores, runner });
    const result = await s.pool.abort(job.id);
    return { s, result };
  }

  it('runner.stop() が投げても abort() は投げない（探りも届かなければ unknown で言い切る）', async () => {
    const { s, result } = await abortWithUnreachableProbe();

    expect(result.outcome).toBe('unknown');
    expect(result.sessionGone).toBeUndefined();
    expect(result.detail).toContain('期限切れ（テスト）');

    await s.pool.stop();
  });

  it('runner.stop() が投げても、捕まえた例外を握り潰さず日誌に残す', async () => {
    const { s } = await abortWithUnreachableProbe();

    const entries = await s.stores.journal.list({ types: ['exchange'] });
    const line = entries.find((entry) => JSON.stringify(entry).includes(job.id));
    expect(line).toBeDefined();
    expect(JSON.stringify(line)).toContain('期限切れ（テスト）');

    await s.pool.stop();
  });

  it('runner.stop() が投げても探りが unknown なら、台帳を1文字も書かない', async () => {
    const { s } = await abortWithUnreachableProbe();

    // **状態は動かさない。** 確かめられていない以上、書く材料が無い。
    const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(listed?.status).toBe('running');

    await s.pool.stop();
  });

  /**
   * **RPC の不明を、止まった事実より優先させない。**
   *
   * `runner.stop()` が例外を投げても、`runner.list()` の探りが「消えた」と
   * 答えるなら、止まったと言い切ってよい（stop の RPC が返らなくても、届いて
   * いて実際に止まっていることがある）。権威は常に `sessionGone` に置く。
   */
  it('runner.stop() が投げても、探りで消えていれば stopped', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);
    const fake = swappableRunner();
    const runner = {
      ...fake.runner,
      async stop(): Promise<void> {
        throw new Error('返らなかった（テスト）');
      },
      async list() {
        // 探りには答えた。該当のセッションは既に消えている。
        return [];
      },
    };
    const s = setup(undefined, { stores, runner });

    const result = await s.pool.abort(job.id);

    expect(result.outcome).toBe('stopped');
    expect(result.sessionGone).toBe(true);
    const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(listed?.status).toBe('stopped');

    await s.pool.stop();
  });

  /**
   * **書けなくても委譲は止めない。だが跡は残る。**
   *
   * ジョブ台帳のほうが効く。「後から `manager_report` で読めた ⟹ 経路が
   * 通っていた」は成功した場合の話であって、失敗は台帳にも日誌にも跡を
   * 残さない（＝台帳を判別器に使えない）。
   *
   * 跡に本文が乗らないことも一緒に固定する（#52 と同じ形を作らない）。
   */
  it('日誌とジョブ台帳が書けなくても委譲は続き、落としたことが stderr に残る（本文は出さない）', async () => {
    const stores = failingJobWrite(
      failingJournalAppend(createMemoryStores(), 'storage is closed'),
      'storage is closed',
    );
    const s = setup(undefined, { stores });

    const lines = await captureStderr(async () => {
      await s.pool.start({ request: '鍵は ghp_000000000000000000000000000000000000 だ' });
      await s.pool.stop();
    });

    const text = lines.join('');
    expect(text).toContain('日誌を記録できませんでした');
    expect(text).toContain('ジョブ台帳を記録できませんでした');
    expect(text).toContain('storage is closed');
    expect(text).not.toContain('ghp_');
  });
});

/**
 * **止めたマネージャーの後続イベントは、日誌に残してクローンを起こさない（R4）。**
 *
 * `abort()` が `#retire()` しても、`#onEvent` は台帳から像を作り直す（`#load()`）。
 * だから止めたあとに届く `report` / `ask` を無条件に処理すると、`record.job.status`
 * を `stopped` から上書きし、`#emit()` でクローンのターンを起こしてしまう
 * （「止めたマネージャーが後から報告を出す」「死んだマネージャーが確認を求める」）。
 */
describe('止めたマネージャーの後続イベント（R4）', () => {
  const job = {
    id: 'mgr-stopped-then-event',
    managerId: 'mgr-stopped-then-event',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '暴走中',
    request: '延々と直し続けている',
    cwd: '/work/project',
    sessionId: 'sess-stopped-then-event',
    runnerId: 'runner-primary',
  };

  /** 止めるところまで共通に済ませる（`abort()` の探りで `sessionGone: true` になる形）。 */
  async function stopped() {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);
    const fake = swappableRunner();
    fake.state.alive.push({
      managerId: job.id,
      status: 'running',
      cwd: job.cwd,
      request: job.request,
      waiting: [],
      sessionId: job.sessionId,
    });
    const runner = {
      ...fake.runner,
      async stop(managerId: string) {
        fake.state.alive = fake.state.alive.filter((s) => s.managerId !== managerId);
      },
    };
    const s = setup(undefined, { stores, runner });
    const result = await s.pool.abort(job.id, 'テストで止めた');
    expect(result.outcome).toBe('stopped');
    return { s, fake };
  }

  /**
   * `emit?.(...)` は `runner.connect((event) => void this.#onEvent(event))` を
   * 経由するので、`#onEvent` は fire-and-forget（`void`）で走る。イベントを
   * 発火した直後は日誌への書き込みがまだ終わっていないことがあるので、
   * `expect.poll` で「処理が終わった」ことそのものを確かめてから、
   * 他のアサーション（inbox が増えていないこと・status が動いていないこと）へ進む。
   */
  async function journalHas(s: Setup, needle: string, types: JournalEntry['type'][]) {
    await expect
      .poll(
        async () => {
          const entries = await s.stores.journal.list({ types });
          return entries.some((entry) => JSON.stringify(entry).includes(needle));
        },
        { timeout: 2000 },
      )
      .toBe(true);
  }

  /**
   * **`#onEvent` の中で `await` を挟まずに済む「処理が終わった」の合図が無い。**
   *
   * `journalHas`（上）は「日誌にその文字列が現れる」ことを待つので、日誌への
   * 書き込みが実際に起きる保証だけを使える。しかし下のガードのうち「journal
   * 呼び出しだけを消す変異」（保証1＝日誌に残ることを壊す変異）を当てると、
   * ガード自身の分岐（`if (status === 'stopped') { ...; return; }`）は残った
   * ままなので、この変異のもとでも `#onEvent` は正しく早期リターンし、
   * inbox / status は一切動かない——つまり保証2（クローンへ回らない・status が
   * 動かない）は**その変異のもとでも成立している**。だから保証2のテストが
   * `journalHas` を「処理が終わった合図」として待ってしまうと、日誌には何も
   * 書かれないその変異のもとでタイムアウトし、**保証2は壊れていないのに
   * テストだけが落ちる**——保証1と保証2がまた1つに戻ってしまう。
   *
   * **元は固定の実時間（`setTimeout(resolve, 100)`）で fire-and-forget の
   * 完了を待っていた。これに欠陥があった。** 器が混んでいる CI（runner は
   * UTC・共有）では、100ms のうちに `#onEvent` の処理が終わらないことがある。
   * そのとき「まだ処理されていない（inbox がまだ増えていないだけ）」を
   * 「クローンへ回らなかった（保証2が成立している）」と読んでしまう——
   * ガードを無効化する変異Aを当てても、処理が固定時間内に終わらなければ
   * テストは黙って通る＝歯が消える（`AGENTS.md`「静かに失敗する道具」の
   * 「失敗が成功として観測される」形そのもの）。
   *
   * **直し方は「日誌が書かれるまで、ただし上限つきで待つ」こと。** 正常時は
   * 日誌にその文字列が現れた時点で待ちを終えるので速く、取りこぼしが無い。
   * **上限まで現れなくても、この待ちのほうを失敗させない。** `#journal(...)`
   * を壊す変異（保証1を壊す変異B）を当てたときは、日誌には最後まで何も
   * 書かれないので、この待ちは上限まで律儀に待ってから黙って抜ける。その
   * 結果、保証2のテストは（日誌の中身を見ずに）inbox / status のアサーション
   * まで進み、変異Bのもとでも通る——落ちる集合が保証1側とちょうど分かれた
   * ままになる。**この「上限で抜けても失敗させない」という一見奇妙な仕様
   * こそが、保証1と保証2の分離を保つ本体である。** 次に読む者がここへ
   * `expect`（「タイムアウトしたら失敗させたい」という自然な直感）を足すと、
   * その分離がまた壊れる——足したくなったら、まずこのコメントとセットで
   * `journalHas` との役割の違いを読み直すこと。
   */
  async function settleAfterJournal(
    s: Setup,
    needle: string,
    types: JournalEntry['type'][],
    timeoutMs = 500,
  ) {
    const start = Date.now();
    for (;;) {
      const entries = await s.stores.journal.list({ types });
      if (entries.some((entry) => JSON.stringify(entry).includes(needle))) return;
      if (Date.now() - start >= timeoutMs) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /**
   * **`report` のテストは、ここから2本に割ってある（2026-08-22）。**
   *
   * 元は1本の `it()` で「日誌には残る」「クローンへは回らず status も動かない」
   * を順に assert していた。変異試験で次の2つを別々に壊すと:
   *
   * - 変異A: ガード（`if (record.job.status === 'stopped') {...}`）を丸ごと外す
   * - 変異B: ガードは残したまま、その中の `await this.#journal(...)` だけを消す
   *
   * **どちらの変異でも、落ちたテストは同じ1本だった**（変異Aは
   * `s.inbox.length` の行で、変異Bは `journalHas` の行で落ち、その先には
   * 進まない）。vitest は最初に失敗した assertion で止まるので、テスト名の
   * 粒度だけでは「日誌に残る」と「クローンを起こさない」のどちらの保証が
   * 壊れたのかが区別できない。1つの `it()` の中に2つの保証を重ねて書いていた
   * ことが原因なので、保証ごとに `it()` を分けた。アサーションは1つも
   * 削っていない。
   */
  it('report イベントは日誌には残る（捨てない）', async () => {
    const { s, fake } = await stopped();

    fake.report(job.id, '止めたはずなのに報告してきた', 'done');

    // 日誌には残っている（捨てない）。
    await journalHas(s, '止めたはずなのに報告してきた', ['exchange']);

    await s.pool.stop();
  });

  it('report イベントはクローンへは回らず、status も動かない', async () => {
    const { s, fake } = await stopped();
    const postedBefore = s.inbox.length;

    fake.report(job.id, '止めたはずなのに報告してきた', 'done');
    await settleAfterJournal(s, '止めたはずなのに報告してきた', ['exchange']);

    // クローンの受信箱（inbox）へは1件も増えていない。
    expect(s.inbox.length).toBe(postedBefore);
    // status は stopped から動かない。
    const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(listed?.status).toBe('stopped');

    await s.pool.stop();
  });

  /** `ask` も `report` と同じ形（日誌＋受信箱＋waiting を1本で見ていた）なので、同じ理由で割る。 */
  it('ask イベントは日誌には残る（捨てない）', async () => {
    const { s, fake } = await stopped();

    fake.ask(job.id, 'req-after-stop', '止めたはずなのに確認を求めてきた');

    await journalHas(s, '止めたはずなのに確認を求めてきた', ['escalation']);

    await s.pool.stop();
  });

  it('ask イベントはクローンへは回らず、waiting も積まれない', async () => {
    const { s, fake } = await stopped();
    const postedBefore = s.inbox.length;

    fake.ask(job.id, 'req-after-stop', '止めたはずなのに確認を求めてきた');
    await settleAfterJournal(s, '止めたはずなのに確認を求めてきた', ['escalation']);

    expect(s.inbox.length).toBe(postedBefore);
    const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(listed?.status).toBe('stopped');
    expect(listed?.waiting).toEqual([]);

    await s.pool.stop();
  });

  it('closed(failed) イベントは日誌には載るが、クローンへは回らず status も動かない', async () => {
    const { s, fake } = await stopped();
    const postedBefore = s.inbox.length;

    fake.closed(job.id, 'failed', '止めたはずなのに落ちたと言ってきた');

    await journalHas(s, '止めたはずなのに落ちたと言ってきた', ['exchange']);
    expect(s.inbox.length).toBe(postedBefore);
    const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(listed?.status).toBe('stopped');

    await s.pool.stop();
  });

  /**
   * `resume_failed` は `report` / `ask` / `closed` と同じ形の後続イベントである
   * （直前に投げていた自動再開の結果が、止めた後に遅れて届く）。ここも同じ理由で
   * 畳む。`event.recovered` の真偽どちらでも（`running` へ書く枝・`lost` へ書く枝
   * どちらでも）status を動かさないことを両方固定する。
   */
  it('resume_failed（recovered: false）イベントは日誌には載るが、クローンへは回らず status も動かない', async () => {
    const { s, fake } = await stopped();
    const postedBefore = s.inbox.length;

    fake.resumeFailed(job.id, job.sessionId, '止めたはずなのに開き直せなかったと言ってきた', false);

    await journalHas(s, '止めたはずなのに開き直せなかったと言ってきた', ['exchange']);
    expect(s.inbox.length).toBe(postedBefore);
    const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(listed?.status).toBe('stopped');

    await s.pool.stop();
  });

  it('resume_failed（recovered: true）イベントも日誌には載るが、クローンへは回らず status も動かない', async () => {
    const { s, fake } = await stopped();
    const postedBefore = s.inbox.length;

    fake.resumeFailed(job.id, job.sessionId, '止めたはずなのに生ログから続けたと言ってきた', true);

    await journalHas(s, '止めたはずなのに生ログから続けたと言ってきた', ['exchange']);
    expect(s.inbox.length).toBe(postedBefore);
    const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(listed?.status).toBe('stopped');

    await s.pool.stop();
  });

  /**
   * **このガードは、明示的な `manager_send` で起こし直す能力を塞がない。**
   *
   * `send()` は resume が受理された時点で `record.job.status` を先に `'running'`
   * へ書く（`send()` 本体）。だから `resume_failed` がその後に届いても、この時点
   * では `record.job.status` は既に `'stopped'` ではなく、上の新しいガードには
   * 掛からない——`resume_failed` 本来の分岐（`event.recovered` の真偽で
   * `running` / `lost` を書き分ける）がそのまま働く。ここでは `recovered: false`
   * を届けて `lost` へ落ちることを確かめる——ガードに飲まれて `stopped` の
   * ままだったら、この分岐は起きない。
   */
  it('明示的な manager_send で起こした後の resume_failed は、新しいガードに塞がれず従来どおり処理される', async () => {
    const { s, fake } = await stopped();

    // stopped から明示的に送る。session_id は残っているので resume 経路を通り、
    // 受理された時点で status は 'running' へ戻る（`schema.ts` の
    // `jobStatusSchema` の doc・2026-08-22 訂正）。
    const sendResult = await s.pool.send(job.id, 'まだ続きがある');
    expect(sendResult.outcome).toBe('delivered');
    const afterSend = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(afterSend?.status).toBe('running');

    // その resume が SDK 側では見つからなかった、と後から同じ runner から届く
    // （`fake` は `stopped()` が組んだ、この pool に繋がっている runner その
    // ものである）。`recovered: false` なので、塞がれていなければ `lost` へ
    // 落ちる——新しいガードに飲まれて `running` のままなら、この分岐は起きない。
    fake.resumeFailed(job.id, job.sessionId, '結局戻れていなかった', false);

    await expect
      .poll(async () => (await s.pool.list()).find((m) => m.managerId === job.id)?.status, {
        timeout: 2000,
      })
      .toBe('lost');

    await s.pool.stop();
  });
});

/**
 * **中身の無い報告は、記録は残すがクローンのターンを起こさない。**
 *
 * `runner.ts` の `resultText()` / `reportText()` が「SDK の `result` にも
 * `said`（そのターンで実際に喋った本文）にも文字が無かった」と確定させた
 * ときだけ `report` イベントに `contentless: true` が立つ
 * （`runner-protocol.ts` の doc）。`manager.ts` の `case 'report'` はこれを見て
 * `#emit()`（クローンの受信箱へ積む経路）だけをスキップし、台帳・日誌は
 * これまでどおり書く。捨てると「黙って失われる」を作るので、捨てない。
 *
 * **「クローンを起こさない」と「記録に残る」は別々の歯にしてある。** 1本目
 * （inbox が増えない）は `manager.ts` が `contentless` を無視する変異で
 * 落ちるが、台帳・日誌を消す変異では落ちない。2本目（台帳・日誌に残る）は
 * その逆で、1本目の変異では落ちない。
 *
 * **文言では判定していない。** `contentless` は構造化された印であって
 * `event.text === '（報告なし）'` という文字列一致ではない（`sdk-failure.ts`
 * の「検知は構造化された印だけで行う」と同じ形）。3本目がこれを固定する —
 * マネージャーが `say()` で本当に「（報告なし）」と喋った回は `said` が
 * 非空になるので `contentless` が立たず、文言が同じでもクローンへ届く。
 */
describe('中身の無い報告は、記録は残すがクローンを起こさない', () => {
  /** 台帳の1件を直接読む（`runner-failure.test.ts` の `jobOf` と同じ理由 —一覧は写し忘れうる）。 */
  async function jobOf(s: Setup, managerId: string) {
    return (await s.stores.jobs.listJobs()).find((job) => job.id === managerId);
  }

  /**
   * 日誌に載ったことを「`#onEvent` の処理が（`#emit` の分岐まで）終わった」の
   * 合図にする。R4 のテスト（`journalHas`）と同じ理由 — `#onEvent` は
   * fire-and-forget（`void`）で走るので、発火直後は書き込みがまだ終わって
   * いないことがある。日誌への書き込みは `#emit` を呼ぶかどうかの分岐の
   * 直前なので、これが見えた時点で分岐は（同期的に）通り終えている。
   */
  async function journalHasText(s: Setup, needle: string): Promise<void> {
    await vi.waitFor(async () => {
      const entries = await s.stores.journal.list({ types: ['exchange'] });
      if (!entries.some((entry) => JSON.stringify(entry).includes(needle))) {
        throw new Error('日誌にまだ載っていない');
      }
    });
  }

  it('本文が1文字も無い報告では、クローンの受信箱（inbox）が増えない', async () => {
    const s = setup();
    const started = await s.pool.start({ request: '調べて' });
    const session = s.sessions[0] as FakeSession;
    const before = s.inbox.length;

    // `say()` を1度も呼ばない ＝ said は空。SDK の result も空文字列 ＝
    // resultText() が「（報告なし）」を作り empty:true になる。
    await session.report('');

    // **完了の合図は `lastReport`（台帳）にする。日誌ではない。** ここは
    // 「クローンを起こさない」だけを固定したいテストなので、待ち方そのものが
    // `#journal` に依存すると、`#journal` を消す変異（次のテストが検出すべき
    // もの）でこのテストまで一緒にタイムアウトで落ちてしまう —
    // 「クローンを起こさない」と「記録に残る」を別々の歯にする、という要件に
    // 反する。`record.job.lastReport` は `#journal` より前に書かれる
    // （`manager.ts` の `case 'report'`）ので、これを待てば1と2の変異を
    // 混同しない。
    await vi.waitFor(async () => {
      const job = await jobOf(s, started.managerId);
      if (job?.lastReport !== '（報告なし）') throw new Error('台帳がまだ更新されていない');
    });

    expect(s.inbox.length).toBe(before);

    await s.pool.stop();
  });

  it('同じ回は台帳（lastReport）と日誌には残っている', async () => {
    const s = setup();
    const started = await s.pool.start({ request: '調べて' });
    const session = s.sessions[0] as FakeSession;

    await session.report('');
    await journalHasText(s, '（報告なし）');

    const job = await jobOf(s, started.managerId);
    expect(job?.lastReport).toBe('（報告なし）');

    const entries = await s.stores.journal.list({ types: ['exchange'] });
    expect(entries.some((entry) => JSON.stringify(entry).includes('（報告なし）'))).toBe(true);

    await s.pool.stop();
  });

  it('マネージャーが本当に「（報告なし）」と報告した回は、文言が同じでもクローンへ届く', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = s.sessions[0] as FakeSession;
    const before = s.inbox.length;

    // said（実際に喋った本文）に '（報告なし）' そのものが入る形を作る。
    // 中身が無い場合とまったく同じ文字列が本文になるが、`said` が非空
    // なので contentless は立たない。
    await session.say('（報告なし）');
    await session.report('（報告なし）');

    const report = await vi.waitFor(() => {
      const found = s.inbox.find(
        (event) => event.type === 'manager_message' && event.kind === 'report',
      );
      if (!found) throw new Error('報告がまだ届いていない');
      return found as { text: string };
    });
    expect(report.text).toContain('（報告なし）');
    expect(s.inbox.length).toBe(before + 1);

    await s.pool.stop();
  });

  it('中身のある報告はこれまでどおりクローンへ届く（回帰）', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = s.sessions[0] as FakeSession;
    const before = s.inbox.length;

    await session.say('中身のある報告');
    await session.report('中身のある報告');

    const report = await vi.waitFor(() => {
      const found = s.inbox.find(
        (event) => event.type === 'manager_message' && event.kind === 'report',
      );
      if (!found) throw new Error('報告がまだ届いていない');
      return found as { text: string };
    });
    expect(report.text).toContain('中身のある報告');
    expect(s.inbox.length).toBe(before + 1);

    await s.pool.stop();
  });
});

/**
 * **台帳に載っている事実を、一覧が落とさない。**
 *
 * `lastFailure`（`schema.ts`）は「直近の1ターンが報告ではなく失敗で終わった」
 * ことで、人間の面（CLI の `/managers`・Web のマネージャー画面）とクローンが
 * これを読んで「報告が来た」と区別する。**外へ出るのは `summaryOf` を通った分
 * だけ**なので、ここが写し忘れると、台帳には載っているのにどの面にも出ない
 * ——直す前とまったく同じ見え方（`You've hit your org's monthly spend limit …`
 * が報告として出る）に戻る（`sdk-failure.ts` の doc）。
 */
describe('一覧は、直近のターンが失敗で終わったことを落とさない', () => {
  const failedJob = {
    id: 'mgr-billing',
    managerId: 'mgr-billing',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    // **`failed` ではない。** 支出上限に当たった回もセッションは生きているので、
    // 台帳の状態は `done`（終えて待機中。話しかければ続く）のままである。
    status: 'done' as const,
    summary: '調査',
    request: '調べて',
    cwd: '/work/project',
    lastReport: '（このターンは応答を返さずに終わった: billing_error / assistant_error）',
    lastFailure: {
      code: 'billing_error',
      via: 'assistant_error',
      at: '2026-08-20T10:00:00.000Z',
    },
  };

  it('台帳の lastFailure が要約に載る（status は done のまま）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(failedJob);
    const s = setup(undefined, { stores });

    const listed = (await s.pool.list()).find((m) => m.managerId === 'mgr-billing');

    expect(listed?.lastFailure).toEqual({
      code: 'billing_error',
      via: 'assistant_error',
      at: '2026-08-20T10:00:00.000Z',
    });
    // **状態は置き換えない。** ここを `failed` へ倒すと、人間は続けられる仕事を
    // そこで閉じる（`status` と `lastFailure` を分けた理由そのもの）。
    expect(listed?.status).toBe('done');

    await s.pool.stop();
  });

  it('失敗していないマネージャーには lastFailure を作らない（「失敗していない」と「見ていない」を混ぜない）', async () => {
    const stores = createMemoryStores();
    // **失敗の印だけを外した同じジョブ**を入れる（`delete` で外すのは、
    // `exactOptionalPropertyTypes` で `undefined` を代入できないため）。
    const ok = { ...failedJob, id: 'mgr-ok', managerId: 'mgr-ok' };
    delete (ok as { lastFailure?: unknown }).lastFailure;
    await stores.jobs.putJob(ok);
    const s = setup(undefined, { stores });

    const listed = (await s.pool.list()).find((m) => m.managerId === 'mgr-ok');

    expect(listed).toBeDefined();
    expect(listed?.lastFailure).toBeUndefined();
    // キーごと無いこと（`undefined` を入れた形と区別する）。
    expect(Object.hasOwn(listed as object, 'lastFailure')).toBe(false);

    await s.pool.stop();
  });
});

/**
 * `#records`（デーモン側が持つマネージャーの像）の寿命。
 *
 * `ManagerRecord` の JSDoc は「像はマネージャーと一緒に消えるので寿命は元から
 * 有限」と書いているが、`done` / `lost` / `failed` へ着いても外す経路が
 * 一度も無かった（実測で6日に58本、外れずに増え続ける）。`#retire` がその
 * 唯一の出口である。
 *
 * ここでは `#records` から外れたこと自体を、プロセス内だけに載る帳面
 * （`denials()`。`Job` 側には無い）が空へ戻ることで観測する — `list()` /
 * `manager_send` の出力は `#load()` が台帳から作り直すので、外れても外れなくても
 * 同じに見える（それ自体が受け入れ条件でもある）。
 */
describe('#records の寿命（終端で外れる）', () => {
  function job(id: string, overrides: Partial<Job> = {}): Job {
    return {
      id,
      managerId: id,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      status: 'running',
      summary: '長い仕事',
      request: 'DB の移行をやって',
      cwd: '/work/project',
      sessionId: `sess-${id}`,
      runnerId: 'runner-test',
      ...overrides,
    };
  }

  (['done', 'lost', 'failed'] as const).forEach((status) => {
    it(`closed（${status}）で #records から外れても、manager_list / manager_report は従来どおり答えられる（受け入れ条件）`, async () => {
      const id = `mgr-closed-${status}`;
      const stores = createMemoryStores();
      await stores.jobs.putJob(job(id));
      const fake = swappableRunner('runner-test');
      fake.state.alive.push({
        managerId: id,
        status: 'running',
        cwd: '/work/project',
        request: 'DB の移行をやって',
        waiting: [],
        sessionId: `sess-${id}`,
      });
      const s = setup(undefined, { stores, runner: fake.runner });
      await s.pool.restore();

      // 走行中に拒否が積まれる（`denials()` が非空になる ＝ 像がまだ生きている証拠）。
      fake.denied(id, 'Bash');
      expect(s.pool.denials(id)).toEqual([{ tool: 'Bash', count: 1 }]);

      // 本当に閉じる（`RunnerSession#finish()` を通った印）。
      fake.closed(id, status, `終端: ${status}`);

      // **`#records` から外れたことの外部から見える証拠。** `denied` はプロセス内
      // だけの帳面で `Job` には書かない（起動をまたいでも残らない設計）ので、
      // ここが空へ戻ることは「像そのものが消えた」ことを意味する。
      await expect.poll(() => s.pool.denials(id), { timeout: 2000 }).toEqual([]);

      // **それでも `manager_list` / `manager_report` は答えられる。** `Job` 本体は
      // 台帳に残るので、`list()` は台帳から summary を作り直す。
      const listed = (await s.pool.list()).find((m) => m.managerId === id);
      expect(listed).toBeDefined();
      expect(listed).toMatchObject({
        status,
        request: 'DB の移行をやって',
        // `lost` だけは「戻れないと確認済み」なので `live: false` が正しい。
        // `done` / `failed` は `session_id` が残っている限り明示的に起こし直せる
        // ので `live: true`（`list()` のフォールバックを `isLive()` に直した分）。
        live: status !== 'lost',
      });

      const transcript = await s.pool.transcript(id);
      // 生ログを預かっていない fake runner でも、`transcript()` は「無い」で
      // 応答できる（`#records` に無いことで例外にならない）ことだけを見る。
      expect(transcript).toBeNull();

      await s.pool.stop();
    });
  });

  it('abort() で外れても、manager_list は従来どおり答えられる', async () => {
    const id = 'mgr-aborted';
    const stores = createMemoryStores();
    await stores.jobs.putJob(job(id));
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: id,
      status: 'running',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [],
      sessionId: `sess-${id}`,
    });
    const runner = {
      ...fake.runner,
      async stop(managerId: string) {
        fake.state.alive = fake.state.alive.filter((s) => s.managerId !== managerId);
      },
    };
    const s = setup(undefined, { stores, runner });
    await s.pool.restore();

    fake.denied(id, 'Edit');
    expect(s.pool.denials(id)).toEqual([{ tool: 'Edit', count: 1 }]);

    await s.pool.abort(id, '暴走したので');

    expect(s.pool.denials(id)).toEqual([]);
    const listed = (await s.pool.list()).find((m) => m.managerId === id);
    // **2026-08-21 に反転。** 直す前は `abort()` が確かに止めても台帳の `status` を
    // `'done'` に書いていた（「止めた」と「待機中」が1語に潰れていた、R2）。いまは
    // `'stopped'` という専用の終端状態を持つので、ここを反転する（3点セットは
    // 上の「セッションが畳まれたら、止まったと言い切る」と同じ理由）。
    expect(listed).toMatchObject({ status: 'stopped' });

    await s.pool.stop();
  });

  it('resume_failed で lost になって外れても、manager_send で明示的に起こし直せる（送信の経路が壊れない）', async () => {
    // 「lost へ明示的に話しかけて起こし直す経路」（`resume_failed` のコメント）が
    // `#retire` の後でも通ることを見る。`#load()` が台帳から像を作り直し、
    // `!record.attached` の分岐が resume を投げる。
    const id = 'mgr-resume-failed-lost';
    const stores = createMemoryStores();
    await stores.jobs.putJob(job(id));
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: id,
      status: 'running',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [],
      sessionId: `sess-${id}`,
    });
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.denied(id, 'Bash');
    expect(s.pool.denials(id)).toEqual([{ tool: 'Bash', count: 1 }]);

    fake.resumeFailed(id, `sess-${id}`, '開き直せなかった', false);
    await expect
      .poll(async () => (await stores.jobs.listJobs()).find((j) => j.id === id)?.status, {
        timeout: 2000,
      })
      .toBe('lost');
    expect(s.pool.denials(id)).toEqual([]);

    const result = await s.pool.send(id, '続けて');
    expect(fake.state.resumes).toHaveLength(1);
    expect(fake.state.resumes[0]).toMatchObject({ managerId: id, sessionId: `sess-${id}` });
    expect(result.outcome).toBe('delivered');

    await s.pool.stop();
  });

  it('reattach（runner 入れ替え）で挑み直しを諦めて lost になっても外れる', async () => {
    // `#reattach` 側のもう1つの `lost` 化経路（`isRetryableRunnerError` が偽の
    // resume 失敗）。ここも `#retire` の対象であることを確かめる。
    const id = 'mgr-reattach-giveup';
    const stores = createMemoryStores();
    await stores.jobs.putJob(job(id));
    const fake = swappableRunner('runner-test');
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.denied(id, 'Bash');
    expect(s.pool.denials(id)).toEqual([{ tool: 'Bash', count: 1 }]);

    fake.runner.resume = async () => {
      throw new RunnerHttpError('runner POST resume が失敗した (400)', 400);
    };
    fake.swap();

    await expect
      .poll(async () => (await stores.jobs.listJobs()).find((j) => j.id === id)?.status, {
        timeout: 2000,
      })
      .toBe('lost');
    await expect.poll(() => s.pool.denials(id), { timeout: 2000 }).toEqual([]);

    await s.pool.stop();
  });

  /**
   * **Issue #240。** 直上のテストと同じ経路（`#reattach` が
   * `isRetryableRunnerError` を偽と判定して諦める、`cause: 'runner'` が既定の
   * `#notifyUnresumable`）だが、こちらは受信箱ではなく**日誌**を見る。
   *
   * この呼び出し元（`manager.ts` の `#reattach`）は `#notifyUnresumable` を
   * 呼ぶ前に自分では `#journal` していない——409（世代衝突）の枝や `session`
   * 原因の枝とは違う。日誌を「無い＝この経路を通っていない」の判別に使うには、
   * `#notifyUnresumable` 自身が呼び出し元によらず必ず1本残す必要がある。
   */
  it('reattach で挑み直しを諦めたとき、日誌にも跡が残る（#240）', async () => {
    const id = 'mgr-reattach-giveup-journal';
    const stores = createMemoryStores();
    await stores.jobs.putJob(job(id));
    const fake = swappableRunner('runner-test');
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.runner.resume = async () => {
      throw new RunnerHttpError('runner POST resume が失敗した (400)', 400);
    };
    fake.swap();

    await expect
      .poll(async () => (await stores.jobs.listJobs()).find((j) => j.id === id)?.status, {
        timeout: 2000,
      })
      .toBe('lost');

    const entries = await stores.journal.list({ types: ['exchange'] });
    const line = entries.find(
      (entry) => 'text' in entry && entry.text.includes(id) && entry.text.includes('戻せなかった'),
    );
    expect(line).toBeDefined();

    await s.pool.stop();
  });

  it('確認待ちが残っていても、閉じた（closed）後の /answer は宙に浮かず「解けない」と返る', async () => {
    // 落とし穴1: 外した瞬間に、未解決の確認が残っているマネージャーへの
    // `/answer` が通らなくなる形が無いか。`case 'closed'` は `#retire` の前から
    // `record.waiting = []` を持ってから畳んでいる（`resume_failed` の `lost` 化
    // 経路にも同じ形を足した）ので、答えは「待っていない」という明確な結果に
    // なる（宙に浮いて黙って捨てられることはない）。
    const id = 'mgr-ask-then-closed';
    const stores = createMemoryStores();
    await stores.jobs.putJob(job(id, { status: 'waiting_human' }));
    const fake = swappableRunner('runner-test');
    fake.state.alive.push({
      managerId: id,
      status: 'waiting_human',
      cwd: '/work/project',
      request: 'DB の移行をやって',
      waiting: [
        {
          requestId: 'req-9',
          summary: '許可して',
          kind: 'permission',
          askedAt: '2026-08-01T01:00:00.000Z',
        },
      ],
      sessionId: `sess-${id}`,
    });
    const s = setup(undefined, { stores, runner: fake.runner });
    // `restore()` が runner の `alive` から `waiting` をそのまま引き取る
    // （`waiting_human` はホワイトリストに載っているので `attached: true`）。
    await s.pool.restore();

    // クローンが答える前に runner 側でセッションが閉じた。
    fake.closed(id, 'lost', 'セッションが落ちた');

    const result = await s.pool.send(id, '許可する', { requestId: 'req-9' });
    expect(result.outcome).toBe('unknown');
    expect(result.detail).toContain('待っていない');

    await s.pool.stop();
  });
});

/**
 * runner の指名（`ManagerStartInput.runnerId`）と一覧（`ManagerPool.runners()`）。
 *
 * roadmap の依頼「コンテナがいくつあって、どこで何をいくつ動かしているかを
 * クローンが把握できるようにする」＋「manager を立てるときにどちらのコンテナで
 * 作業するかをクローンの判断で選べるようにする」の、`ManagerPool` 層での固定。
 *
 * SDK は握らない——`Pool.start()` は `runner.start(command)` を呼ぶだけで完結する
 * ので、`RunnerClient` を直接実装した軽い偽物で足りる（`runner-placement.test.ts`
 * と同じ作法）。
 */
class FakePoolRunner implements RunnerClient {
  readonly runnerId: string;
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  report: RunnerPlacementResources | undefined;
  started: string[] = [];
  /** 呼ばれた回数。**`resources()` は呼ばれないことを確かめるために数える。** */
  resourcesCalls = 0;
  credentialsCalls = 0;
  profileCalls = 0;
  fakeCredentials: RunnerCredentialFingerprint[] = [];
  fakeProfile: RunnerProfileFingerprint | undefined;

  constructor(runnerId: string, report?: RunnerPlacementResources) {
    this.runnerId = runnerId;
    this.report = report;
  }

  async resources(): Promise<RunnerPlacementResources | undefined> {
    this.resourcesCalls += 1;
    return this.report;
  }
  async connect(): Promise<void> {}
  async start(command: { managerId: string }): Promise<void> {
    this.started.push(command.managerId);
  }
  async resume(): Promise<void> {}
  async send(): Promise<void> {}
  async answer(): Promise<RunnerAnswerOutcome> {
    return { delivered: false };
  }
  async stop(): Promise<void> {}
  async list(): Promise<RunnerManagerState[]> {
    return [];
  }
  async transcript(): Promise<string | null> {
    return null;
  }
  async credentials(): Promise<RunnerCredentialFingerprint[]> {
    this.credentialsCalls += 1;
    return this.fakeCredentials;
  }
  async setCredentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async profile(): Promise<RunnerProfileFingerprint | undefined> {
    this.profileCalls += 1;
    return this.fakeProfile;
  }
  async setProfile(): Promise<RunnerProfileResult> {
    return { ok: true };
  }
  async close(): Promise<void> {}
}

describe('runner の指名（Pool.start の runnerId）', () => {
  it('runnerId を指名すると、その runner が起こされる（自動配置の点数計算を通していない）', async () => {
    // 点数だけを見れば roomy が勝つ構図——それでも tight を名指ししたら tight に
    // 置かれることを確かめる（自動配置の点数計算を通していない証拠）。
    const roomy = new FakePoolRunner('runner-roomy', {
      memory: { limitBytes: 32_000_000_000, usedBytes: 1_000_000_000, source: 'cgroup' },
      managers: 0,
    });
    const tight = new FakePoolRunner('runner-tight', {
      memory: { limitBytes: 32_000_000_000, usedBytes: 30_000_000_000, source: 'cgroup' },
      managers: 4,
    });
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([roomy, tight]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const summary = await pool.start({ request: '指名した器で頼む', runnerId: 'runner-tight' });

    // **ここで見るのは「指名が効いたか」だけ。** 返り値の runnerId が実際の選択と
    // 一致するかは別の保証（次の describe）なので、ここでは混ぜない。
    expect(tight.started).toEqual([summary.managerId]);
    expect(roomy.started).toEqual([]);

    await pool.stop();
    await registry.stop();
  });

  it('指名しなくても、資源で選ばれた runner が起こされる（自動配置は変えていない）', async () => {
    const busy = new FakePoolRunner('runner-busy', { managers: 9 });
    const idle = new FakePoolRunner('runner-idle', { managers: 0 });
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([busy, idle]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    await pool.start({ request: '自動配置に任せる' });

    expect(idle.started).toHaveLength(1);
    expect(busy.started).toEqual([]);

    await pool.stop();
    await registry.stop();
  });

  /**
   * **返ってくる `runnerId` は、実際に `start()` を受け取った器と一致する。**
   *
   * 期待値を固定文字列にしないのが要点——「指名が正しく効いたか」
   * （上のテスト）とは別の保証であることを、判定そのものの作り方で切り離す。
   * ここで見たいのは「実際に走った器と、名乗る値が食い違っていないか」だけ
   * なので、期待値も実測（`.started` にどちらが積まれたか）から作る。これで
   * 「入力をそのまま書き戻す」「常に決め打ちの名前を返す」のどちらの変異でも
   * 実際に走った器と食い違えば落ちる。
   */
  it('指名の有無によらず、返ってくる runnerId は実際に start() を受け取った器と一致する', async () => {
    const busy = new FakePoolRunner('runner-busy', { managers: 9 });
    const idle = new FakePoolRunner('runner-idle', { managers: 0 });
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([busy, idle]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const summary = await pool.start({ request: '自動配置に任せる' });

    const actual = [busy, idle].find((runner) => runner.started.includes(summary.managerId));
    expect(actual).toBeDefined();
    expect(summary.runnerId).toBe(actual?.runnerId);

    await pool.stop();
    await registry.stop();
  });
});

describe('runner の一覧（ManagerPool.runners）', () => {
  it('器ごとの本数を返す（デーモンの台帳から見た数）', async () => {
    // **台帳へ直接3本を仕込む。** `pool.start({ runnerId })`（指名）を使って本数の
    // 内訳を作ると、この歯が指名の正しさ（別の保証）と結合してしまう——指名側の
    // 変異でこのテストまで巻き添えで落ち、どちらの歯が壊れたか区別できなくなる。
    // 数え方だけを見るために、台帳（`Job.runnerId`）を直に置く。
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const b = new FakePoolRunner('runner-b', { managers: 0 });
    const stores = createMemoryStores();
    const at = new Date().toISOString();
    for (const [id, runnerId] of [
      ['mgr-1', 'runner-a'],
      ['mgr-2', 'runner-a'],
      ['mgr-3', 'runner-b'],
    ] as const) {
      await stores.jobs.putJob({
        id,
        managerId: id,
        createdAt: at,
        updatedAt: at,
        status: 'running',
        summary: id,
        request: id,
        cwd: '/work/project',
        runnerId,
      });
    }
    const registry = createRunnerRegistry([a, b]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const overview: RunnerFleetOverview = await pool.runners();

    const byLabel = new Map(overview.runners.map((r) => [r.label, r]));
    expect(byLabel.get('runner-a')?.managers).toHaveLength(2);
    expect(byLabel.get('runner-b')?.managers).toHaveLength(1);
    expect(overview.unassigned).toEqual([]);

    await pool.stop();
    await registry.stop();
  });

  /**
   * **`live` を内訳へ運ぶ**（`RunnerManagerEntry`）。
   *
   * `runners()` は内訳を作る直前に `list()` を呼んでいて、そこには
   * `isLive()` の結果が既に載っている。**それを落とすと `runner_list` の
   * 側でだけ「走行中」と「走行中だがセッション切断」が潰れる**——#540 が
   * 定期 tick の要約で直したのと同じ形の穴が、この一覧に残っていた。
   *
   * ここで見るのは値が運ばれることだけで、字面は `tools.test.ts` 側が見る。
   */
  it('器ごとの内訳に live を運ぶ（status だけに畳まない）', async () => {
    const stores = createMemoryStores();
    const at = new Date().toISOString();
    await stores.jobs.putJob({
      id: 'mgr-no-session',
      managerId: 'mgr-no-session',
      createdAt: at,
      updatedAt: at,
      status: 'running',
      summary: 'セッションを持たない仕事',
      request: 'セッションを持たない仕事',
      cwd: '/work/project',
      runnerId: 'runner-a',
    });
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const registry = createRunnerRegistry([a]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const overview = await pool.runners();

    // 台帳にしか無く `sessionId` も無いので戻る先が無い（`isLive()`）。
    // **`status` は `running` のままである** — だからこそ `live` が要る。
    expect(overview.runners.find((r) => r.label === 'runner-a')?.managers).toEqual([
      { managerId: 'mgr-no-session', status: 'running', live: false },
    ]);

    await pool.stop();
    await registry.stop();
  });

  it('runnerId の無いマネージャーを、どの器にも混ぜず unassigned 別枠へ出す', async () => {
    const stores = createMemoryStores();
    // **`runnerId` を書かない古いジョブを台帳に直接置く。** `manager_id → runner_id`
    // を記録する前の世代を模す（`Job.runnerId` は optional）。
    const at = new Date().toISOString();
    await stores.jobs.putJob({
      id: 'mgr-legacy',
      managerId: 'mgr-legacy',
      createdAt: at,
      updatedAt: at,
      status: 'done',
      summary: '記録の無い古い仕事',
      request: '記録の無い古い仕事',
      cwd: '/work/project',
    });
    const only = new FakePoolRunner('runner-only', { managers: 0 });
    const registry = createRunnerRegistry([only]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const overview = await pool.runners();

    // **0 に畳まれていない。** `runner-only` の内訳には現れず、別枠に1件として出る。
    expect(overview.runners.find((r) => r.label === 'runner-only')?.managers).toEqual([]);
    expect(overview.unassigned).toEqual([
      // `live: false` — 台帳にしか無く `sessionId` も持たないので戻る先が無い
      // （`isLive()`）。**`status` と一緒に必ず運ぶ**（`RunnerManagerEntry` の doc）。
      { managerId: 'mgr-legacy', status: 'done', live: false },
    ]);

    await pool.stop();
    await registry.stop();
  });

  it('state は5値のまま渡す（connected へ畳まない）', async () => {
    // まだ開けていない（開けなかった）1台は `unreachable`。`connected` へ畳んで
    // いれば、クローンは「使える」と誤読する。
    const registry = createRunnerRegistry([], { retryBaseMs: 5, retryMaxMs: 5 });
    await registry.register({
      label: 'http://runner:later',
      open: () => Promise.reject(new Error('fetch failed')),
    });
    const stores = createMemoryStores();
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const overview = await pool.runners();

    expect(overview.runners).toMatchObject([
      { label: 'http://runner:later', state: 'unreachable' },
    ]);

    await pool.stop();
    await registry.stop();
  });

  it('resources() は呼ばない（この一覧のために配置の往復を足さない）', async () => {
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([a]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    await pool.runners();
    await pool.runners({ fingerprints: true });

    expect(a.resourcesCalls).toBe(0);

    await pool.stop();
    await registry.stop();
  });

  it('fingerprints を渡さなければ credentials()/profile() を呼ばず、指紋を載せない', async () => {
    const a = new FakePoolRunner('runner-a');
    a.fakeCredentials = [
      { name: 'GITHUB_TOKEN', sha256: 'deadbeef0000', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    a.fakeProfile = { sha256: 'cafef00dbabe', bytes: 3, updatedAt: '2026-01-01T00:00:00.000Z' };
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([a]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const overview = await pool.runners();

    expect(a.credentialsCalls).toBe(0);
    expect(a.profileCalls).toBe(0);
    expect(overview.runners[0]?.credentials).toBeUndefined();
    expect(overview.runners[0]?.profile).toBeUndefined();

    await pool.stop();
    await registry.stop();
  });

  it('fingerprints: true を渡すと、開いている器の鍵とプロファイルの指紋を添える', async () => {
    const a = new FakePoolRunner('runner-a');
    a.fakeCredentials = [
      { name: 'GITHUB_TOKEN', sha256: 'deadbeef0000', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    a.fakeProfile = { sha256: 'cafef00dbabe', bytes: 3, updatedAt: '2026-01-01T00:00:00.000Z' };
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([a]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const overview = await pool.runners({ fingerprints: true });

    expect(overview.runners[0]?.credentials).toEqual(a.fakeCredentials);
    expect(overview.runners[0]?.profile).toEqual(a.fakeProfile);

    await pool.stop();
    await registry.stop();
  });

  /**
   * pids（#315 案1）。`fingerprints` と同じ opt-in の形——`resources: true` を
   * 渡したときだけ `resources()` を呼ぶ。**呼ばれた回数を直接数える**（AGENTS.md
   * 「取れない軸に0の行を作らない」と対になる、「呼んだかどうか」の歯）。
   */
  /**
   * **ここが測るのは「`resources: true` のときは呼ぶ／値が載る」だけである。**
   *
   * **「既定では呼ばない」をここで測らないのは、測れないからである**（2026-08-24、
   * 変異試験で確かめた）。既定の経路は**独立した2つの門**で塞がっている:
   *
   * 1. 外側 — `options.fingerprints || options.resources` が偽なら `open`
   *    （開いている器の一覧）自体を作らないので、`client` が `undefined` になる
   * 2. 内側 — `client === undefined || !options.resources`
   *
   * **どちらか片方を壊しても、もう片方が既定の経路を塞ぎ続ける。** だから
   * 「既定で `resources()` が呼ばれないこと」を assert しても、**その行は
   * どんな単一の変異でも赤くならない** —— 実測: 内側の門から
   * `|| !options.resources` を外す変異を当てても、この形の assert は緑のまま
   * 通った。**落ちないと分かっている assert を置くと、次に読む人へ「この性質は
   * 守られている」と嘘をつく**ので置かない。
   *
   * **その変異を実際に捕まえたのは、上の「resources() は呼ばない（この一覧の
   * ために配置の往復を足さない）」である** —— あちらは `fingerprints: true` を
   * 渡して外側の門を通してから数えるので、内側の門だけを単独で撃てる。
   * **「既定では往復を足さない」の歯はあちらに在る。ここには無い。**
   */
  it('resources: true のときだけ resources() を呼び、pids が overview に載る', async () => {
    const a = new FakePoolRunner('runner-a', {
      managers: 0,
      pids: { current: 872, max: 1000 },
    });
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([a]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const overview = await pool.runners({ resources: true });
    expect(a.resourcesCalls).toBe(1);
    expect(overview.runners[0]?.resources?.pids).toEqual({ current: 872, max: 1000 });

    await pool.stop();
    await registry.stop();
  });

  /**
   * **3つの状態を混ぜない。**
   *
   * 1. 読めた（上のテストが押さえている）
   * 2. runner に訊けなかった — `resources` を持つ器が名簿に無い（まだ開けていない）
   *    ときは、`resources: true` を渡しても呼びようが無い。`RunnerOverview.resources`
   *    は `undefined` のままである
   * 3. 訊けたが pids が読めなかった — `resources()` が答えたが `pids` を持たない
   *    （cgroup の無い器。ローカル開発など）。`RunnerOverview.resources` は
   *    定義されるが `.pids` が無い
   *
   * 2 と 3 を同じ `undefined` へ潰すと、クローンは「訊けなかった」と「そもそも
   * pids という概念が無い器」を区別できなくなる。
   */
  it('訊けなかった器は resources が undefined、訊けたが pids の無い器は resources はあるが pids が無い', async () => {
    const stores = createMemoryStores();
    // **state 2**: まだ開けていない（`open` が失敗する）ので、`RunnerRegistry#list()`
    // には現れない——`resources: true` を渡しても client 自体が見つからない。
    const registry = createRunnerRegistry([], { retryBaseMs: 5, retryMaxMs: 5 });
    await registry.register({
      label: 'runner-unreachable',
      open: () => Promise.reject(new Error('fetch failed')),
    });
    // **state 3**: 開いてはいるが、`resources()` が pids を持たない値を返す
    // （cgroup を持たない器を模す）。
    const noCgroup = new FakePoolRunner('runner-no-cgroup', { managers: 0 });
    await registry.register({ label: 'runner-no-cgroup', open: () => Promise.resolve(noCgroup) });

    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const overview = await pool.runners({ resources: true });

    const byLabel = new Map(overview.runners.map((r) => [r.label, r]));
    expect(byLabel.get('runner-unreachable')?.resources).toBeUndefined();
    expect(byLabel.get('runner-no-cgroup')?.resources).toBeDefined();
    expect(byLabel.get('runner-no-cgroup')?.resources?.pids).toBeUndefined();

    await pool.stop();
    await registry.stop();
  });
});

/**
 * runner→デーモンの脚（`Outbox` の滞留）のキャッシュ（#358 案b）。
 *
 * `ManagerPool.runnerBacklog()` は `runners({ resources: true })` が拾った
 * `pendingEvents` / `oldestPendingAt` を、往復を増やさずに読めるようにした
 * ものである（`RunnerBacklogSnapshot` の doc）。ここで見るのは「warm する
 * 条件」「cold のときに出てこないこと」「往復が増えないこと」の3つ。
 */
describe('runner の滞留のキャッシュ（ManagerPool.runnerBacklog）', () => {
  it('runners({ resources: true }) の後にキャッシュが warm し、観測時刻付きで値が返る', async () => {
    const a = new FakePoolRunner('runner-a', {
      managers: 0,
      pendingEvents: 9,
      oldestPendingAt: '2026-08-20T00:00:00.000Z',
    });
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([a]);
    const observedAt = new Date('2026-08-27T00:30:00.000Z');
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      now: () => observedAt.getTime(),
    });

    expect(pool.runnerBacklog!()).toEqual([]);
    await pool.runners({ resources: true });

    expect(pool.runnerBacklog!()).toEqual([
      {
        runnerId: 'runner-a',
        pendingEvents: 9,
        oldestPendingAt: '2026-08-20T00:00:00.000Z',
        observedAt: observedAt.toISOString(),
      },
    ]);

    await pool.stop();
    await registry.stop();
  });

  /**
   * **往復を増やさないことの歯。** `resources: true` を渡さずに `runners()`
   * を呼んでも、`resources()` そのものが呼ばれない（既存の「resources: true
   * のときだけ resources() を呼ぶ」歯と同じ根拠）ので、キャッシュも warm し
   * ようがない——`manager_list` が自動でこの往復を払わないという設計判断
   * （`tools.ts` の `manager_list` の JSDoc）が、ここでも保たれていることを
   * 直接確かめる。
   */
  it('resources を渡さずに runners() を呼んでもキャッシュは warm しない（往復を足さない）', async () => {
    const a = new FakePoolRunner('runner-a', { managers: 0, pendingEvents: 9 });
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([a]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    await pool.runners();
    await pool.runners({ fingerprints: true });

    expect(a.resourcesCalls).toBe(0);
    expect(pool.runnerBacklog!()).toEqual([]);

    await pool.stop();
    await registry.stop();
  });

  it('pendingEvents が undefined の runner は記録しない（0で埋めない）', async () => {
    // `report` 自体は返るが `pendingEvents` を持たない——この機能より前の
    // runner を模す（`RunnerPlacementResources.pendingEvents` の doc）。
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([a]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    await pool.runners({ resources: true });

    expect(pool.runnerBacklog!()).toEqual([]);

    await pool.stop();
    await registry.stop();
  });

  it('oldestPendingAt が無ければ欄ごと省く（0件の言い方を混ぜない）', async () => {
    const a = new FakePoolRunner('runner-a', { managers: 0, pendingEvents: 3 });
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([a]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    await pool.runners({ resources: true });

    const snapshot = pool.runnerBacklog!()[0];
    expect(snapshot?.pendingEvents).toBe(3);
    expect(snapshot).not.toHaveProperty('oldestPendingAt');

    await pool.stop();
    await registry.stop();
  });
});

/**
 * `identity()` を持つ runner。`resources()` と `identity()` の両方を独立に
 * 差し替えられる——runnerBacklog() が2つの由来（`resources()` 由来の
 * `#runnerBacklog` map と、`identity()` 由来の `registry.entries()`）を
 * 正しく合流させることを見るための最小限の偽物（`FakePoolRunner` に
 * `identity()` を足しただけ）。
 */
class FakeBacklogMergeRunner implements RunnerClient {
  readonly runnerId: string;
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  /** `resources()` が返す値（案b 第1段の由来）。 */
  report: RunnerPlacementResources | undefined;
  /** `identity()` が返す滞留の2欄（案b 第2段の由来）。 */
  identityPendingEvents: number | undefined;
  identityOldestPendingAt: string | undefined;

  constructor(runnerId: string) {
    this.runnerId = runnerId;
  }

  async resources(): Promise<RunnerPlacementResources | undefined> {
    return this.report;
  }
  async identity(): Promise<
    | { runnerId?: string; instanceId?: string; pendingEvents?: number; oldestPendingAt?: string }
    | undefined
  > {
    return {
      runnerId: this.runnerId,
      ...(this.identityPendingEvents === undefined
        ? {}
        : { pendingEvents: this.identityPendingEvents }),
      ...(this.identityOldestPendingAt === undefined
        ? {}
        : { oldestPendingAt: this.identityOldestPendingAt }),
    };
  }
  async connect(): Promise<void> {}
  async start(): Promise<void> {}
  async resume(): Promise<void> {}
  async send(): Promise<void> {}
  async answer(): Promise<RunnerAnswerOutcome> {
    return { delivered: false };
  }
  async stop(): Promise<void> {}
  async list(): Promise<RunnerManagerState[]> {
    return [];
  }
  async transcript(): Promise<string | null> {
    return null;
  }
  async credentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async setCredentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async profile(): Promise<RunnerProfileFingerprint | undefined> {
    return undefined;
  }
  async setProfile(): Promise<RunnerProfileResult> {
    return { ok: true };
  }
  async close(): Promise<void> {}
}

/**
 * `runnerBacklog()` が `resources()` 由来と `identity()`（heartbeat）由来を
 * 合流させ、観測時刻の新しいほうを採ること（#358 案b の第2段）。
 *
 * **時計は手で進める**（`runner-swap.test.ts` と同じ理由——heartbeat の
 * 10秒周期を実時間で待たない）。`now` オプションを渡さないので、`Pool` の
 * `observedAt` も `Registry` の heartbeat の `at` も同じ `Date.now()`
 * （フェイク時計）を見る——2つの由来が同じ時計の上で競える形にしてある。
 */
describe('runnerBacklog() が resources() 由来と identity() 由来を合流させる（#358 案b の第2段）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('新しく観測できたほうを採る（heartbeat が resources() より後なら heartbeat 側、逆なら resources() 側）', async () => {
    const runner = new FakeBacklogMergeRunner('runner-a');
    runner.report = {
      managers: 0,
      pendingEvents: 9,
      oldestPendingAt: '2026-08-20T00:00:00.000Z',
    };
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([runner]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    // t=0: resources() 由来（古い値）を warm する。
    await pool.runners({ resources: true });
    expect(pool.runnerBacklog!()).toEqual([
      {
        runnerId: 'runner-a',
        pendingEvents: 9,
        oldestPendingAt: '2026-08-20T00:00:00.000Z',
        observedAt: '2026-08-27T00:00:00.000Z',
      },
    ]);

    // t=10s: heartbeat が identity() 由来（新しい値）を warm する。
    runner.identityPendingEvents = 4;
    runner.identityOldestPendingAt = '2026-08-27T00:00:05.000Z';
    await vi.advanceTimersByTimeAsync(10_000);

    // **新しいほう（heartbeat 側）が勝つ。**
    expect(pool.runnerBacklog!()).toEqual([
      {
        runnerId: 'runner-a',
        pendingEvents: 4,
        oldestPendingAt: '2026-08-27T00:00:05.000Z',
        observedAt: '2026-08-27T00:00:10.000Z',
      },
    ]);

    // t=11s: resources() を呼び直す（さらに新しい値）。次の heartbeat 周（t=20s）
    // には届かない範囲で時計を進める。
    runner.report = {
      managers: 0,
      pendingEvents: 7,
      oldestPendingAt: '2026-08-27T00:00:11.000Z',
    };
    await vi.advanceTimersByTimeAsync(1_000);
    await pool.runners({ resources: true });

    // **逆転する——今度は resources() 側（もっと新しい）が勝つ。** 合流が
    // 「片方を常に優先する」実装ではないことの証拠になる。
    expect(pool.runnerBacklog!()).toEqual([
      {
        runnerId: 'runner-a',
        pendingEvents: 7,
        oldestPendingAt: '2026-08-27T00:00:11.000Z',
        observedAt: '2026-08-27T00:00:11.000Z',
      },
    ]);

    await pool.stop();
    await registry.stop();
  });

  it('resources() 由来しか無い runner はそのまま出て、identity() 由来しか無い runner とは混ざらない', async () => {
    const resourcesOnly = new FakePoolRunner('runner-resources', {
      managers: 0,
      pendingEvents: 2,
    });
    const identityOnly = new FakeBacklogMergeRunner('runner-identity');
    identityOnly.identityPendingEvents = 6;
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([resourcesOnly, identityOnly]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    await pool.runners({ resources: true });
    await vi.advanceTimersByTimeAsync(10_000);

    expect([...pool.runnerBacklog!()].sort((a, b) => a.runnerId.localeCompare(b.runnerId))).toEqual(
      [
        {
          runnerId: 'runner-identity',
          pendingEvents: 6,
          observedAt: '2026-08-27T00:00:10.000Z',
        },
        {
          runnerId: 'runner-resources',
          pendingEvents: 2,
          observedAt: '2026-08-27T00:00:00.000Z',
        },
      ],
    );

    await pool.stop();
    await registry.stop();
  });
});

/**
 * 宛先を引けなかったときに返す言葉（`ManagerPool` の `#runnerNotOpenDetail`。
 * `send()` と `abort()` の両方がこれを呼ぶ）。
 *
 * **測るのは「言葉が、コードの観測と食い違っていないか」だけである。**
 * `RunnerRegistry#get()` が `null` を返すのは `entry.client` が無いときで、そこには
 * **まだ開けていない**（`unreachable`。再試行は予約済み）が含まれる。それをここは
 * 「別の runner で続きを起こすには workspace の移送が要る」という**恒久の言葉**で
 * 返していた——待てば直る状態を、待っても直らない状態の言葉で報告していた形である。
 *
 * **3つを別々の `it()` で測る。** vitest は最初の失敗で止まるので、1本に同居させると
 * 後ろの検査が一度も走らないまま緑になる（同居していれば、`unusable` の側を消す変異が
 * 素通りしていた）。
 *
 * **能力の話ではない。** `manager_send` は塞いでいないので、宛先が開いていれば
 * 従来どおり届く——それを4本目で押さえる（一律にこの言葉へ倒していないこと）。
 */
describe('宛先が名簿に開いていないときに返す言葉', () => {
  const away = {
    id: 'mgr-away',
    managerId: 'mgr-away',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'done' as const,
    summary: '移行作業',
    request: 'DB の移行をやって',
    cwd: '/work/project',
    runnerId: 'runner-primary',
    sessionId: 'sess-before-swap',
  };

  /**
   * 開けない宛先だけが載っている名簿でプールを組む。
   *
   * `register()` は `#open()` を `await` するので、戻った時点で状態は確定している
   * （`isRetryableRunnerError` が真なら `unreachable`、偽なら `unusable`）。
   * **`entry.client` は `null` のまま**なので `get()` は `null` を返し、
   * `#runnerOf` がこの経路に落ちる。
   */
  async function poolWithClosedRegistry(open: () => Promise<RunnerClient>) {
    const stores = createMemoryStores();
    await stores.jobs.putJob(away);
    const registry = createRunnerRegistry([], { notify: () => undefined });
    await registry.register({ label: 'http://runner:4518', open });
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      profile: createProfileService({ stores, runners: registry }),
    });
    return { pool, registry };
  }

  it('まだ開けていない宛先は、まだ開けていないと言う（unreachable を畳まない）', async () => {
    // status を持たない失敗は「待てば直る」側（`isRetryableRunnerError`）。
    const s = await poolWithClosedRegistry(async () => {
      throw new Error('まだ上がっていない');
    });

    const result = await s.pool.send('mgr-away', '続きをやって');

    expect(result.outcome).toBe('unknown');
    // 名簿の状態がそのまま出ている。**5値を `connected` へ畳まない。**
    expect(result.detail).toContain('unreachable');

    await s.pool.stop();
    await s.registry.stop();
  });

  it('待っても直らない宛先は、そう言う（unusable と unreachable を混ぜない）', async () => {
    // 4xx は runner が「その命令は受け取れない」と答えている＝挑み直さない側。
    const s = await poolWithClosedRegistry(async () => {
      throw new RunnerHttpError('鍵が違う', 403);
    });

    const result = await s.pool.send('mgr-away', '続きをやって');

    expect(result.outcome).toBe('unknown');
    expect(result.detail).toContain('unusable');
    // **同じ言葉で両方を言わない。** ここが混ざると、読む側は待つか起こし直すかを
    // 決められない（`RunnerRegistry#select` の doc が数え上げている区別そのもの）。
    expect(result.detail).not.toContain('unreachable');

    await s.pool.stop();
    await s.registry.stop();
  });

  it('恒久の断定をしない（判定できないことを言わない）', async () => {
    const s = await poolWithClosedRegistry(async () => {
      throw new Error('まだ上がっていない');
    });

    const result = await s.pool.send('mgr-away', '続きをやって');

    // ここが観測しているのは「いま開いた宛先が無い」ことだけで、移送が要るかどうかは
    // 判定していない。**読んだ側が恒久の結論を持ち帰る形にしない。**
    expect(result.detail).not.toContain('移送');
    expect(result.detail).toContain('戻せないことの証明ではない');

    await s.pool.stop();
    await s.registry.stop();
  });

  it('宛先が開いていれば、いままでどおり届く（一律にこの言葉へ倒していない）', async () => {
    // **能力を削っていないことの側。** 文言を直すだけの変更なので、送れる相手は
    // 1件も変わらない。
    const s = setup();
    const { managerId } = await s.pool.start({ request: '長い仕事' });

    const result = await s.pool.send(managerId, 'まだ続きがある');

    expect(result.outcome).toBe('delivered');
    expect(result.detail).not.toContain('名簿');

    await s.pool.stop();
  });
});

/**
 * 生ログを引きに行って失敗したときの扱い（`ManagerPool#loadSession`）。
 *
 * **ここは `catch` で `null` を返していた。** 呼び出し側からは「預かっていない」
 * と見分けが付かず、下流はそれを恒久の結論に変える —— `#resume` が材料無しで
 * resume を投げ、runner が `resume_failed{recovered:false}` を返し、デーモンが
 * `lost` を確定させて `#unresumable` へ積む。**記憶ストアが一瞬読めなかっただけで
 * 委譲が終端する。**
 *
 * **書く側（`case 'mirror'`）は同じ区別を守っている**（`noteDroppedRecord`）。
 * 読む側だけが破っていた。
 *
 * **2本を別々の `it()` で測る。** 片方だけだと逆向きの嘘（本当に預かっていない
 * ものまで「読めなかった」に倒す計器）に気づけない。vitest は最初の失敗で止まるので、
 * 同居させると後ろが一度も走らない。
 */
describe('生ログを読み出せなかったとき（「無い」と畳まない）', () => {
  const job = {
    id: 'mgr-unreadable',
    managerId: 'mgr-unreadable',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '移行作業',
    request: 'DB の移行をやって',
    cwd: '/work/project',
    runnerId: 'runner-primary',
    sessionId: 'sess-before-swap',
    projectKey: 'proj-key',
  };

  /** `load` の振る舞いだけを差し替えたプールを組む。 */
  async function poolWithSessionStore(load: () => Promise<SessionStoreEntry[] | null>) {
    const stores = {
      ...createMemoryStores(),
      sessionStore: { append: async () => undefined, load },
    };
    await stores.jobs.putJob(job);
    const fake = swappableRunner();
    const inbox: InboxEvent[] = [];
    const registry = createRunnerRegistry([fake.runner]);
    const pool = createManagerPool({
      stores,
      post: (event: InboxEvent) => inbox.push(event),
      runners: registry,
      profile: createProfileService({ stores, runners: registry }),
    });
    return { pool, stores, fake, inbox, registry };
  }

  const statusOf = async (stores: Stores) =>
    (await stores.jobs.listJobs()).find((j) => j.id === job.id)?.status;

  it('引きに行って失敗したら、失敗として残す（跡を出し、材料無しで resume を投げず、恒久に落とさない）', async () => {
    const s = await poolWithSessionStore(async () => {
      throw new Error('記憶ストアがいま読めない');
    });

    let result: Awaited<ReturnType<ManagerPool['send']>> | undefined;
    const lines = await captureStderr(async () => {
      result = await s.pool.send(job.id, '続きをやって');
    });

    // ① 跡が残る。**書く側（noteDroppedRecord）と対になる。**
    expect(lines.join('')).toContain('預かってある生ログを読み出せませんでした');

    // ② 材料無しで resume を投げない。**これが lost を作っていた当のものである。**
    expect(s.fake.state.resumes).toHaveLength(0);

    // ③ 恒久に落とさない。台帳は走行中のまま（`lost` にしない）。
    expect(await statusOf(s.stores)).toBe('running');

    // ④ 返す言葉が「無い」と言わない。**起こし直せ、という誤った行動も指示しない。**
    expect(result?.outcome).toBe('unknown');
    expect(result?.detail).toContain('引きに行って失敗した');
    expect(result?.detail).not.toContain('新しく起こし直すこと');

    await s.pool.stop();
    await s.registry.stop();
  });

  it('本当に預かっていないときは、いままでどおり resume を投げ、戻れなければ lost で終える', async () => {
    // **逆向きに倒していないことの側。** 「読めなかった」を作った代わりに、
    // 本当に材料が無い委譲まで走行中のまま放置すると、今度は誰も起こし直さない
    // （`lost` は「起こし直す対象」として見分けるためにある。`schema.ts`）。
    const s = await poolWithSessionStore(async () => null);

    const lines = await captureStderr(async () => {
      await s.pool.send(job.id, '続きをやって');
    });

    // 跡は出ない（読めている。材料が無いだけである）。
    expect(lines.join('')).not.toContain('読み出せませんでした');
    // resume は投げる（材料が無くても、SDK 側に会話が残っていれば戻れる）。
    expect(s.fake.state.resumes).toHaveLength(1);
    expect(s.fake.state.resumes[0]?.entries).toBeUndefined();

    // runner が「戻れなかった」と答えたら、いままでどおり lost で終える。
    s.fake.resumeFailed(job.id, 'sess-before-swap', 'SDK に会話が残っていない', false);
    await expect.poll(() => statusOf(s.stores), { timeout: 2000 }).toBe('lost');

    await s.pool.stop();
    await s.registry.stop();
  });
});

/**
 * `abort()` が「宛先が名簿に開いていない」を `'absent'`（HTTP 404 相当）へ畳まなく
 * なったことを固定する。旧実装はこの経路で `outcome: 'absent'` を返し、`app.ts` が
 * それをそのまま 404 にしていた。しかしここまで来ているということは `#load` が
 * 台帳から像を作れた＝**このマネージャーは存在する。** 宛先がいま開いていない
 * だけで、そこには `unreachable`（まだ開けていない。再試行は予約済み）が含まれる
 * ——一時的な状態を「そんなものは無い」という機械可読な終端で答えていた
 * （`ManagerAbortResult` の doc、`abort()` 本体のコメント）。
 *
 * **2本を別々の `it()` にする。** 片方（宛先が開いていない）だけだと、
 * 「`abort()` は何を渡しても `unknown` を返す」という壊れた形へ倒れても
 * 気づけない——もう片方（台帳に本当に居ない）が、その劣化を検知する側である。
 *
 * **足場は上の `describe('宛先が名簿に開いていないときに返す言葉', ...)` 内の
 * `poolWithClosedRegistry` と同じ組み方だが、そこを直接呼ばない。** 定義がその
 * `describe` のコールバック内（ブロックスコープ）に閉じていて、ここから参照
 * できないため——かつ、その `describe` は別 PR の歯なので中身は1バイトも変えない。
 * ここでは同じ形を独自に組む。
 */
describe('abort() は宛先が名簿に開いていないことを absent と言わない', () => {
  const runningAway = {
    id: 'mgr-running-away',
    managerId: 'mgr-running-away',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '長い移行作業',
    request: 'DB の移行をやって',
    cwd: '/work/project',
    runnerId: 'runner-primary',
    sessionId: 'sess-before-swap',
  };

  /**
   * 台帳にジョブを1本置き、名簿には**開けない宛先だけ**を登録する。
   * `register()` は `#open()` を `await` するので、戻った時点で状態は
   * `unreachable` に確定している（`entry.client` は `null` のまま）。
   */
  async function poolWithUnreachableRunnerAndJob() {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningAway);
    const registry = createRunnerRegistry([], { notify: () => undefined });
    await registry.register({
      label: 'http://runner:4518',
      open: async () => {
        throw new Error('まだ上がっていない');
      },
    });
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      profile: createProfileService({ stores, runners: registry }),
    });
    return { pool, registry };
  }

  it('宛先が名簿に開いていないときは、居ないと言わない', async () => {
    const { pool, registry } = await poolWithUnreachableRunnerAndJob();

    const result = await pool.abort('mgr-running-away');

    expect(result.outcome).toBe('unknown');
    // 名簿の状態（5値）がそのまま載っている。畳んで捨てていない。
    expect(result.detail).toContain('unreachable');
    // **「マネージャーは居ない」という断定（`absent` の文言）を含まない。**
    // ここが以前の `${managerId} というマネージャーは居ない。` へ逆戻りして
    // いないことの検査。
    expect(result.detail).not.toContain('というマネージャーは居ない');

    await pool.stop();
    await registry.stop();
  });

  /**
   * **`unusable`（待っても直らない）でも同じ枝を通り、しかも畳まれないこと。**
   *
   * この PR は「一時（`unreachable`）と恒久（台帳に居ない）を畳むな」を潰して
   * いる。**その隣に別の畳みが残っていると同じ形が再発する** — `unusable` は
   * 4xx 由来（runner が「その命令は受け取れない」と答えている）なので、
   * `unreachable`（待てば直る。再試行は予約済み）と畳まれると**意味が逆になる**。
   *
   * 構造上は同じ枝を通るはずである（`runner-protocol.ts` の `#open()` の catch
   * 節で `entry.client = null` は `isRetryableRunnerError` による分岐の**手前**に
   * 置かれている）。**が、それは読みであって観測ではないので、ここで測る。**
   */
  it('待っても直らない宛先（unusable）でも、居ないとは言わず、状態も畳まない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningAway);
    const registry = createRunnerRegistry([], { notify: () => undefined });
    // 4xx は「挑み直しても同じ答えが返る」側（`isRetryableRunnerError` が偽）。
    await registry.register({
      label: 'http://runner:4518',
      open: async () => {
        throw new RunnerHttpError('鍵が違う', 403);
      },
    });
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      profile: createProfileService({ stores, runners: registry }),
    });

    const result = await pool.abort('mgr-running-away');

    expect(result.outcome).toBe('unknown');
    expect(result.detail).toContain('unusable');
    // **待てば直る側と混ぜない。** ここが混ざると、読む側は待つか諦めるかを
    // 決められない（意味が逆になる）。
    expect(result.detail).not.toContain('unreachable');

    await pool.stop();
    await registry.stop();
  });

  it('台帳に居ないものは、いままでどおり absent', async () => {
    const { pool, registry } = await poolWithUnreachableRunnerAndJob();

    // **これが逆向きに嘘をつく計器になっていないことの側である。** 消さないこと
    // ——上のテストだけだと「abort は何でも unknown と言う」という劣化を検知
    // できない。台帳に本当に居ないものは、これまでどおり absent（404 相当）。
    const result = await pool.abort('mgr-does-not-exist');

    expect(result.outcome).toBe('absent');

    await pool.stop();
    await registry.stop();
  });
});

/**
 * 起動時の生存判定で、**runner に聞けなかったことを「セッションが無い」と読まない**
 * （`ManagerPool#restoreJobs`）。
 *
 * ここは `runner.list().catch(() => [])` だった。`alive` に載らなかったジョブは
 * `running` / `waiting_human` なら実際に resume されるので、**runner に聞けな
 * かっただけで、走り続けているマネージャーがもう1本起こされる。**
 *
 * **同じ歯止めは `#reattach` に逐語で在った**（「聞けなかったときは何もしない。
 * 応答が無いことを『セッションが無い』と読むと、生きている仕事を二重に起こす」）。
 * 同じクラス・同じ RPC・同じ危険で、片方にだけ置かれていた。
 *
 * **3本を別々の `it()` で測る。** vitest は最初の失敗で止まるので、同居させると
 * 後ろが一度も走らない。**それぞれが単独で守るものを doc に書く。**
 */
describe('起動時の生存判定で、聞けなかったことを「居ない」と読まない', () => {
  const onA = {
    id: 'mgr-on-a',
    managerId: 'mgr-on-a',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '長い移行作業',
    request: 'DB の移行をやって',
    cwd: '/work/project',
    runnerId: 'runner-a',
    sessionId: 'sess-a',
  };

  function poolWith(runners: RunnerClient[], jobs: Job[]) {
    const stores = createMemoryStores();
    const registry = createRunnerRegistry(runners);
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      profile: createProfileService({ stores, runners: registry }),
    });
    return {
      stores,
      registry,
      pool,
      seed: async () => {
        for (const job of jobs) await stores.jobs.putJob(job);
      },
    };
  }

  /**
   * **この歯が単独で守るもの**: 聞けなかった器のジョブを resume しないこと。
   * これが落ちると、生きているマネージャーが二重に起こされる（この PR の主題）。
   */
  it('聞けなかった器のジョブは resume せず、台帳も動かさない', async () => {
    const fake = swappableRunner('runner-a');
    fake.runner.list = async () => {
      throw new Error('runner が応答しない');
    };
    const s = poolWith([fake.runner], [onA]);
    await s.seed();

    await s.pool.restore();

    // 二重に起こしていない。
    expect(fake.state.resumes).toHaveLength(0);
    // 台帳は走行中のまま（終端へも落としていない）。
    const job = (await s.stores.jobs.listJobs()).find((j) => j.id === 'mgr-on-a');
    expect(job?.status).toBe('running');

    await s.pool.stop();
    await s.registry.stop();
  });

  /**
   * **この歯が単独で守るもの**: 聞けなかったことが跡に残ること。
   * 上の歯だけだと「黙って飛ばす」実装でも緑になり、後から「セッションが無かった」
   * のか「聞けなかった」のかを誰も言えない。
   */
  it('聞けなかったことが跡に残る', async () => {
    const fake = swappableRunner('runner-a');
    fake.runner.list = async () => {
      throw new Error('runner が応答しない');
    };
    const s = poolWith([fake.runner], [onA]);
    await s.seed();

    const lines = await captureStderr(async () => {
      await s.pool.restore();
    });

    expect(lines.join('')).toContain('runner のセッション一覧を読み出せませんでした');
    expect(lines.join('')).toContain('runner-a');

    await s.pool.stop();
    await s.registry.stop();
  });

  /**
   * **この歯が単独で守るもの**: 飛ばしたことが**先送りであって取りこぼしではない**こと。
   *
   * 「聞けなかったら起こさない」に倒すと、今度は逆側の「黙って失われる」を作る —
   * runner が答えられない間ずっと飛ばし続け、誰も拾い直さないまま台帳に
   * `running` が残る、という形である。**そうなっていないことを測る。**
   *
   * 仕組みは「`#records` へ載せる前に抜ける」こと。載せずに帰れば次の
   * `restore()` が `#records.has` で弾かれずにもう一度拾う。`restore()` は
   * runner が開くたびに `takeOver`（`apps/daemon/src/index.ts`）から呼ばれる。
   *
   * **ガードを `#records.set` の後ろへ動かすと、この歯だけが落ちる。**
   */
  it('聞けなかったのは先送りであって、取りこぼしではない（次に答えたら起こし直す）', async () => {
    const fake = swappableRunner('runner-a');
    let asked = 0;
    fake.runner.list = async () => {
      asked += 1;
      if (asked === 1) throw new Error('runner が応答しない');
      return [...fake.state.alive];
    };
    const s = poolWith([fake.runner], [onA]);
    await s.seed();

    // 1回目は聞けないので起こさない。
    await s.pool.restore();
    expect(fake.state.resumes).toHaveLength(0);

    // 2回目（runner が開き直って `takeOver` が走った形）。**ここで拾い直す。**
    await s.pool.restore();
    expect(fake.state.resumes.map((r) => r.managerId)).toEqual(['mgr-on-a']);

    await s.pool.stop();
    await s.registry.stop();
  });

  /**
   * **この歯が単独で守るもの**: 巻き添えにしないこと。
   * 上の2本だけだと「1台でも聞けなければ全部飛ばす」という一律の実装でも緑になる。
   * **答えた器のジョブは、いままでどおり起こし直す。**
   */
  it('答えた器のジョブは巻き添えにしない（一律に飛ばしていない）', async () => {
    const a = swappableRunner('runner-a');
    a.runner.list = async () => {
      throw new Error('runner が応答しない');
    };
    const b = swappableRunner('runner-b');
    const onB = {
      ...onA,
      id: 'mgr-on-b',
      managerId: 'mgr-on-b',
      runnerId: 'runner-b',
      sessionId: 'sess-b',
    };
    const s = poolWith([a.runner, b.runner], [onA, onB]);
    await s.seed();

    await s.pool.restore();

    // 聞けなかった器の分は起こさない。
    expect(a.state.resumes).toHaveLength(0);
    // 答えた器の分は、いままでどおり起こす。
    expect(b.state.resumes.map((r) => r.managerId)).toEqual(['mgr-on-b']);

    await s.pool.stop();
    await s.registry.stop();
  });
});

/**
 * マネージャー経由の枠の検知を回し手へ繋ぐ（Issue #393 PR3）。
 *
 * **ここで固定するのは2つ** — `rate_limit` を通知の形へ仕立て直さずに渡すことと、
 * **受信箱の畳みより先に渡す**こと。
 */

/**
 * ⚠️ **マネージャー経由の観測（Issue #393 PR3）には、この層の歯がまだ無い。**
 *
 * 繋いだのは2箇所（`usage_notice` と `rate_limit` の `#onEvent`）だが、
 * **どちらも `ManagerPool` の外からは呼べない** — あれらは runner の
 * イベントストリームから届くもので、`onEvent` は private である。測るには
 * **偽の SDK に通知を吐かせて runner 経由で流す**harness が要り、いまの
 * `setup()` はそれを受ける口（sdk options）を持っていない。
 *
 * **「テストが書けない構造は、テストが無いのと同じ」**（AGENTS.md）なので、
 * ここに無いことを書いておく。**次に触る人へ: harness に口を足すのが先である。**
 *
 * **同じ取り違え（`rate_limit` を `reached` の形で回し手へ渡す）は、クローン側では
 * 測ってある** — `clone.test.ts` の「⚠️ rate_limit_event は notice ではなく、
 * 事実と遷移で渡る」。**片側だけの保証であることを、この注記が持つ。**
 */

/**
 * マネージャー経由の枠の検知を回し手へ繋ぐ（Issue #393）。
 *
 * **この層の歯は、配線した PR では書けなかった。** `#onEvent` は private で、
 * runner のイベント経由でしか届かず、当時の `setup()` は偽 SDK に通知を吐かせる
 * 口を持っていなかった。**「テストが書けない構造は、テストが無いのと同じ」**
 * （AGENTS.md）なので、口（`FakeSession#noticeLimit` / `#rateLimit`）を足して
 * ここで測る。
 */
describe('onUsageObservation（マネージャー経由の観測）', () => {
  const REACHED = "You've hit your org's monthly spend limit";

  /** 器の中の待ちが片付くまで少しだけ回す（既存の歯と同じ作法）。 */
  async function settle(ms = 20): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function startManager(options: SetupOptions = {}) {
    const s = setup(undefined, options);
    await s.pool.start({ request: 'ログイン周りを直して' });
    await settle();
    return s;
  }

  it('文言から分類した通知は、そのまま notice として渡る', async () => {
    const seen: TokenRotatorObservation[] = [];
    const s = await startManager({
      onUsageObservation: async (o) => {
        seen.push(o);
      },
    });

    await s.sessions[0]!.noticeLimit(REACHED);
    await settle();

    expect(seen[0]?.notice?.kind).toBe('reached');
    // **文言をそのまま持つ**（言い換えると回復の見込みの分類が効かなくなる）。
    expect(seen[0]?.notice?.text).toBe(REACHED);
  });

  /**
   * **この歯がこの層でいちばん重い。**
   *
   * `rejected` は「その枠1つが尽きた」であって「仕事が止まった」ではない
   * （Issue #393 追記1 の訂正）。`reached` の形へ仕立て直して回し手へ渡すと、
   * **`overage_exhausted` の設定でも課金枠を1円も使わずに回る。**
   */
  it('⚠️ rate_limit は notice ではなく、事実と遷移で渡る', async () => {
    const seen: TokenRotatorObservation[] = [];
    const s = await startManager({
      onUsageObservation: async (o) => {
        seen.push(o);
      },
    });

    await s.sessions[0]!.rateLimit({ status: 'rejected', rateLimitType: 'five_hour' });
    await settle();

    // **notice を持たない。** 持っていたら、それは仕立て直した `reached` である。
    expect(seen[0]).not.toHaveProperty('notice');
    expect(seen[0]?.transition).toBe('rejected');
    expect(seen[0]?.facts?.status).toBe('rejected');
  });

  it('同じ rejected が毎ターン来ても、渡すのは遷移した1回だけ', async () => {
    const seen: TokenRotatorObservation[] = [];
    const s = await startManager({
      onUsageObservation: async (o) => {
        seen.push(o);
      },
    });

    const info = { status: 'rejected', rateLimitType: 'five_hour' };
    await s.sessions[0]!.rateLimit(info);
    await settle();
    await s.sessions[0]!.rateLimit(info);
    await s.sessions[0]!.rateLimit(info);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // **本数で数える。** `transition === 'rejected'` で絞ると、状態をそのまま
    // 流す実装（`transition` が undefined で毎回渡る）を見逃す —— 実際、
    // 絞る形で書いた歯はその変異を捕まえられなかった。
    expect(seen).toHaveLength(1);
    expect(seen[0]?.transition).toBe('rejected');
  });

  /**
   * **`kind` / `overageDisabledReason` を受信箱（`#emit`）へ渡す前に包む**（issue #287）。
   *
   * `case 'rate_limit'` が組み立てる本文はデーモンが**意図して Markdown で書いた**もの
   * （`**まだ動くが、この先で止まる。**`）で、そこへ SDK 由来の2つの値を素で埋めていた。
   * `rateLimitFactsSchema`（`usage-limits.ts`）はどちらも `z.enum` ではなく `z.string()`
   * ——境界が任意の字面を通す以上、いまの SDK の実際の値（`five_hour` 等の snake_case）が
   * 化けないとしても、ここだけ素で通す理由が無い（`case 'permission_denied'` と同じ理由）。
   *
   * **包みが実際に効いていることまで見る。** 「包まれた」だけを測ると、1本の
   * バッククォートで固定する実装（値にバッククォートが含まれると閉じてしまう）が
   * そのまま通る。値そのものにバッククォートを含めて、可変長フェンスになることを見る。
   */
  it('⚠️ 受信箱へ渡る本文では、kind と overageDisabledReason が codeSpan で包まれる', async () => {
    const s = await startManager();

    // 値にバッククォートと `*` を仕込む。1本のバッククォートで固定する実装なら
    // ここで閉じてしまい、以降の字面（`）。**まだ動くが…` 等）まで巻き込む。
    await s.sessions[0]!.rateLimit({
      rateLimitType: 'five_hour`*weird*`',
      isUsingOverage: true,
      overageDisabledReason: 'out_of_credits `rm -rf /`',
    });

    const report = await vi.waitFor(() => {
      const found = s.inbox.find(
        (event) => event.type === 'manager_message' && event.kind === 'report',
      ) as { text: string } | undefined;
      if (found === undefined) throw new Error('報告がまだ届いていない');
      return found;
    });

    // 中身の最長のバッククォートの連なりは1本なので、包みは2本のはず。末尾が
    // バッククォートの値は、CommonMark に取り除かれないよう両端に空白も足される
    // （`codeSpan` の doc）。
    expect(report.text).toContain('`` five_hour`*weird*` ``');
    expect(report.text).toContain('`` out_of_credits `rm -rf /` ``');
    // 定型文（デーモンの prose）はそのまま残っている。
    expect(report.text).toContain('**まだ動くが、この先で止まる。**');

    await s.pool.stop();
  });

  /**
   * **日誌（`#journal`）は包まない。** あちらは Markdown で描かれる面ではないので、
   * 包むと読み手に無いバッククォートが見える。これが無いと、日誌を巻き込んだ
   * 変異（受信箱と日誌の両方を包んでしまう実装）を見逃す。
   */
  it('日誌へ渡る本文では、kind と overageDisabledReason は包まれない', async () => {
    const s = await startManager();

    await s.sessions[0]!.rateLimit({
      rateLimitType: 'five_hour`*weird*`',
      isUsingOverage: true,
      overageDisabledReason: 'out_of_credits `rm -rf /`',
    });
    await settle();

    const entries = await s.stores.journal.list({});
    const entry = entries.find((e) => JSON.stringify(e).includes('five_hour'));
    expect(entry).toBeDefined();
    const text = (entry as { text?: string }).text ?? '';
    // 値そのものは残るが、包み（追加のバッククォート）は付かない。
    expect(text).toContain('five_hour`*weird*`');
    expect(text).not.toContain('`` five_hour`*weird*` ``');
    expect(text).toContain('out_of_credits `rm -rf /`');
    expect(text).not.toContain('`` out_of_credits `rm -rf /` ``');

    await s.pool.stop();
  });

  /**
   * **`kind` が無いときのフォールバック `'枠'` は包まない。** あれはデーモンが書いた
   * 日本語であって SDK の値ではない。包むと、デーモン自身の言葉が SDK の値の顔をする
   * ——この issue が問題にしているのと逆向きの混ざり方になる。
   */
  it('kind が無い回のフォールバック「枠」は包まれない', async () => {
    const s = await startManager();

    // `rateLimitType` を渡さない＝ `kind` が undefined になる回。`status: 'rejected'`
    // で `rejected` 遷移を起こす。
    await s.sessions[0]!.rateLimit({ status: 'rejected' });

    const report = await vi.waitFor(() => {
      const found = s.inbox.find(
        (event) => event.type === 'manager_message' && event.kind === 'report',
      ) as { text: string } | undefined;
      if (found === undefined) throw new Error('報告がまだ届いていない');
      return found;
    });

    expect(report.text).toContain('（枠）');
    expect(report.text).not.toContain('（`枠`）');

    await s.pool.stop();
  });

  it('⚠️ 身元は「セッションが起きたとき」のもの。観測のたびに読み直さない', async () => {
    // **読み直すと、回した後に届いた前のセッションの観測が新しい身元を名乗り、
    // 世代の照合がそのまま素通しになる** —— 5本のマネージャーが同時に当たった回に
    // プールを5個消費する、というこの照合が存在する理由そのものである。
    //
    // **固定値の `tokenIdentity` では測れない**（読み直しても同じ値が返る）。
    // セッションが起きた後に変える。
    let identity = { tokenId: 'tok-a', generation: 3 };
    const seen: TokenRotatorObservation[] = [];
    const s = await startManager({
      tokenIdentity: () => identity,
      onUsageObservation: async (o) => {
        seen.push(o);
      },
    });

    // セッションが起きた後に回った、という状況。
    identity = { tokenId: 'tok-b', generation: 9 };

    await s.sessions[0]!.noticeLimit(REACHED);
    await settle();

    // **起きたときの身元**が付く（いまの身元ではない）。
    expect(seen[0]?.observedBy).toEqual({ tokenId: 'tok-a', generation: 3 });
  });

  it('身元が無ければ添えない（unknown へ倒すのは回し手の側）', async () => {
    const seen: TokenRotatorObservation[] = [];
    const s = await startManager({
      onUsageObservation: async (o) => {
        seen.push(o);
      },
    });

    await s.sessions[0]!.noticeLimit(REACHED);
    await settle();

    expect(seen[0]).not.toHaveProperty('observedBy');
  });

  it('回し手が投げても、マネージャーの経路を壊さない', async () => {
    // 回せなかったことは枠に当たったこととは別の失敗であり、後者の報告を
    // 前者で置き換えない。
    const s = await startManager({
      onUsageObservation: () => Promise.reject(new Error('回し手が落ちた')),
    });

    await s.sessions[0]!.noticeLimit(REACHED);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // 日誌には通知が残っている（マネージャーの経路は生きている）。
    const entries = await s.stores.journal.list({});
    expect(entries.some((entry) => JSON.stringify(entry).includes("You've hit your"))).toBe(true);
  });

  it('名乗ってきた runner へ鍵を降ろす（後から上がった runner に追いつかせる）', async () => {
    // これが無いと、起動時の撒き直しが「そのとき繋がっていた runner」にしか
    // 届かない。
    const synced: string[] = [];
    await startManager({
      syncRunnerToken: async (runner) => {
        synced.push(runner.runnerId);
      },
    });

    expect(synced).toContain('runner-test');
  });

  it('繋ぎ直してきた runner にも鍵を降ろす（器が入れ替わっていれば鍵も消えている）', async () => {
    // **プロファイルと同じ位置に無かった。** `#connectTo` は `#pushProfile` の
    // 直後に `#pushAgentToken` を呼ぶが、`#reattach` は `#pushProfile` だけを
    // 呼んでいた ⟹ 繋ぎ直してきた runner は**回す前のトークンのまま走る。**
    //
    // **見えない形で壊れる。** 走っているマネージャーからは、自分が古いトークンを
    // 使っていることが分からない（`#pushAgentToken` の doc の逐語）。
    const synced: string[] = [];
    const s = await startManager({
      syncRunnerToken: async (runner) => {
        synced.push(runner.runnerId);
      },
    });
    const atConnect = synced.length;
    expect(atConnect).toBeGreaterThan(0);

    // 器が入れ替わって名乗り直してきた（この関数の doc が拾いに来ている場合そのもの）。
    await s.pool.reattachRunner('runner-test');
    await settle();

    expect(synced.length).toBeGreaterThan(atConnect);
    expect(synced.at(-1)).toBe('runner-test');
  });

  /**
   * ⚠️ **窓の仮説（直上2本の続き）。** 直上の歯は「`#reattach` がいずれ鍵を
   * 降ろすか」だけを見ていて、**降ろし終える前に委譲がその runner を選べるか**
   * は見ていない。`#connectTo`（`#ensureConnected` / `start()` が使う）は
   * `#connections`（`WeakMap<RunnerClient, Promise<void>>`）に**繋ぎ済みの
   * 旗**を持つが、`#reattach` は一度もこの旗を触らない——`#connectTo` が既に
   * 一度その runner を繋ぎ終えていれば（初回接続で必ずそうなる）、
   * `#connections.get(runner)` は**もう resolve 済みの Promise**を返すので、
   * `#reattach` の `#pushAgentToken` がまだ走っている最中でも `#connectTo` は
   * 即座に戻る。⟹ 器が入れ替わった直後、`#reattach` が新しい鍵を降ろし終える
   * 前に `start()` が同じ runner を選べてしまい、その委譲は runner が
   * **自分の器の環境変数から起きた古い値**のまま走り出す（この関数の doc
   * 「マネージャーの側からは見えない」）。
   *
   * **測るのは「窓が無い」側。** 直したら緑、直す前は赤になるように、
   * 「鍵を降ろし切ってから委譲が走る」ことを assert する（逆向きだと、直した
   * 瞬間に赤くなるテストが残る）。
   */
  it('窓: #reattach が鍵を降ろし切る前に、委譲が同じ runner を選んで古い資格のまま走り出さない', async () => {
    const stores = createMemoryStores();
    const fake = swappableRunner('runner-test');

    /**
     * 「器がいま持っている資格」を表す外部の可変箱。本物は runner の器の
     * 環境変数（`CLAUDE_CODE_OAUTH_TOKEN`）で、`RunnerClient` のインター
     * フェースには現れない——`setCredentials` の呼び出しだけがこれを書き換える
     * （`apps/daemon/src/token-spread.ts` の `createRunnerTokenSync`）。
     */
    const credential = { value: 'token-boot' };
    const order: string[] = [];

    // `#pushAgentToken` からの `setCredentials` を、こちらが離すまで止められる
    // ようにする（初回接続では開けたままにしておき、器の入れ替え後だけ閉じる）。
    let gate: Promise<void> = Promise.resolve();
    let releaseGate: () => void = () => undefined;
    fake.runner.setCredentials = async (credentials) => {
      const value = credentials[0]?.value ?? 'unknown';
      order.push(`setCredentials:start:${value}`);
      await gate;
      credential.value = value;
      order.push(`setCredentials:done:${value}`);
      return [];
    };

    // 委譲が「呼ばれた瞬間に runner が持っていた資格」を記録する。
    fake.runner.start = async (command) => {
      order.push(`start:${credential.value}`);
      fake.state.alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
      });
    };

    let generation = 0;
    const s = setup(undefined, {
      stores,
      runner: fake.runner,
      syncRunnerToken: async (runner) => {
        generation += 1;
        await runner.setCredentials([
          { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: `token-gen-${generation}` },
        ]);
      },
    });

    // 初回接続（`#connectTo`）。gate は開いているのですぐ終わる。
    await s.pool.restore();
    expect(credential.value).toBe('token-gen-1');

    // **器が入れ替わった。** 新しい器は「回す前のトークン」＝自分の環境変数
    // から起きた古い値を持っている（この関数の doc の逐語どおり）。次の
    // `setCredentials`（＝`#reattach` の鍵降ろし）は、こちらが離すまで止める。
    credential.value = 'token-stale-from-container-boot';
    order.length = 0;
    gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    // 名乗り直してきた（`#reattach` が非同期に発火。fire-and-forget）。
    fake.swap();
    await expect
      .poll(() => order.includes('setCredentials:start:token-gen-2'), { timeout: 2000 })
      .toBe(true);

    // **鍵がまだ降り切っていない間に、同じ runner への委譲を投げる。**
    const startPromise = s.pool.start({ request: '調べて' });

    // **ここが本題。** 窓が無ければ、委譲は `#reattach` の鍵降ろしが終わる
    // （`setCredentials` が resolve する）まで進めない——`start:` はまだ
    // `order` に現れないはずである。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order.some((entry) => entry.startsWith('start:'))).toBe(false);

    releaseGate();
    await startPromise;

    // 委譲は新しい資格で走り出している。古い資格（起動時の値・入れ替え後に
    // 器が持っていた値）では一度も走っていない。
    expect(order).toContain('setCredentials:done:token-gen-2');
    expect(order).toContain('start:token-gen-2');
    expect(order.some((entry) => entry === 'start:token-boot')).toBe(false);
    expect(order.some((entry) => entry === 'start:token-stale-from-container-boot')).toBe(false);
    expect(order.some((entry) => entry === 'start:token-gen-1')).toBe(false);

    await s.pool.stop();
  });
});

/**
 * `workspacePath` を一度も聞けていない runner に対して、`cwd` を省いて
 * マネージャーを起こす／取り直すと、既定値 `''` が `cwd` として組み立てられ、
 * runner 側の `cwd: z.string().min(1)`（`runner-protocol.ts`）に「cwd の形が
 * 不正」として弾かれる（#402）。真因（workspacePath 未取得）が別の顔で
 * 報告される、というのがこの Issue の症状——ここでは、その手前で区別できる
 * 形にして断ることを測る。
 *
 * **どちらの箇所も `RunnerClient.workspacePathKnown` を見る。** これは
 * `HttpRunner` の生成時に呼ばれる `hello()` が1回だけ立てるフラグで
 * （`apps/daemon/src/runner-client.ts`）、`createLocalRunner`（`setup()` の既定）
 * は常に `true` を返すため、この歯は `workspacePathKnown: false` の
 * 偽物（`swappableRunner` を上書きしたもの）でしか踏めない。
 */
describe('workspacePath を一度も聞けていない runner への cwd 省略（#402）', () => {
  it('start(): cwd を省くと、cwd の形ではなく「workspacePath を聞けていない」で断り、managerId を消費しない', async () => {
    const fake = swappableRunner('runner-primary');
    const runner: RunnerClient = { ...fake.runner, workspacePathKnown: false, workspacePath: '' };
    const s = setup(undefined, { runner });

    let caught: unknown;
    try {
      await s.pool.start({ request: 'ログイン周りを直して' });
    } catch (error) {
      caught = error;
    }
    // **真因（workspacePath 未取得）を名指ししていることを見る。** 文言自体は
    // 「cwd の形が不正なのではない」とも明示している（誤読防止）ので、
    // 「cwd の形」という部分文字列そのものを禁止する assertion は立てない
    // ——それを立てると、この否定の一文自体に引っかかって自己矛盾する
    // （実際に CI で踏んだ）。ここで測るべきは「workspacePath という真因が
    // 出ているか」であって「cwd という語が出ていないか」ではない。
    expect(String(caught)).toContain('workspacePath をまだ一度も聞けていない');

    // **managerId を1つも消費していない。** ここで断らずに `runner.start()` まで
    // 進んでいたら、そちらが投げた時点で `#claimManagerId()` が発行した id は
    // `#records.delete()` されて `list()` からは見えなくなる（`start()` の
    // 「起こせなかったものを一覧に残さない」のコメントと同じ結果）——今回は
    // それ以前で止まったことを、台帳・像のどちらにも1件も残っていないことで見る。
    expect(await s.pool.list()).toHaveLength(0);

    await s.pool.stop();
  });

  it('start(): cwd を明示すれば、workspacePath を聞けていない runner でも起こせる（フォールバックを使わないので窓に触れない）', async () => {
    const fake = swappableRunner('runner-primary');
    const runner: RunnerClient = { ...fake.runner, workspacePathKnown: false, workspacePath: '' };
    const s = setup(undefined, { runner });

    const started = await s.pool.start({
      request: 'ログイン周りを直して',
      cwd: '/work/explicit',
    });
    expect(started.cwd).toBe('/work/explicit');

    await s.pool.stop();
  });

  it('start(): workspacePath を聞けている runner なら、cwd を省いても従来どおり runner.workspacePath へ倒す（回帰）', async () => {
    const fake = swappableRunner('runner-primary'); // workspacePathKnown は既定で true
    const s = setup(undefined, { runner: fake.runner });

    const started = await s.pool.start({ request: 'ログイン周りを直して' });
    expect(started.cwd).toBe('/work/project');

    await s.pool.stop();
  });

  it('resume(): cwd を記録しておらず runner からも workspacePath を聞けていないと、「聞けていない」で断る（cwd の形ではない）', async () => {
    const id = 'mgr-no-cwd';
    const stores = createMemoryStores();
    // **`cwd` を持たない委譲。** `jobSchema.cwd` は optional なので、これより
    // 前の形式で作られた委譲、または一度も cwd 解決を経ていない記録を模す。
    const record: Job = {
      id,
      managerId: id,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      status: 'running',
      summary: '長い仕事',
      request: 'DB の移行をやって',
      sessionId: `sess-${id}`,
      runnerId: 'runner-test',
    };
    await stores.jobs.putJob(record);

    const fake = swappableRunner('runner-test');
    const runner: RunnerClient = { ...fake.runner, workspacePathKnown: false, workspacePath: '' };
    const s = setup(undefined, { stores, runner });

    await s.pool.restore();
    // `#restoreJobs` は `held-by-lease` 以外の失敗（新設の
    // `workspace-path-unknown` を含む）を黙って見送るので、`record.attached` は
    // false のまま残る（「他の理由はここでは何もしない」のコメント）。

    const result = await s.pool.send(id, '続けて');
    expect(result.outcome).toBe('unknown');
    // **真因（workspacePath 未取得）を名指ししていることを見る。** 上の
    // `start()` の歯と同じ理由で「cwd の形」という部分文字列そのものを
    // 禁止する assertion は立てない（文言が「cwd の形が不正なのではない」と
    // 明示するため、その否定文自体に引っかかって自己矛盾する）。
    expect(result.detail).toContain('workspacePath を一度も聞けていない');

    // **resume が実際には呼ばれていないことも見る。** `cwd: ''` を組み立てて
    // runner へ渡していれば、ここが1件以上になる。
    expect(fake.state.resumes).toHaveLength(0);

    await s.pool.stop();
  });

  it('resume(): cwd を記録していなくても、runner が workspacePath を聞けていれば従来どおり resume できる（回帰）', async () => {
    const id = 'mgr-no-cwd-known';
    const stores = createMemoryStores();
    const record: Job = {
      id,
      managerId: id,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      status: 'running',
      summary: '長い仕事',
      request: 'DB の移行をやって',
      sessionId: `sess-${id}`,
      runnerId: 'runner-test',
    };
    await stores.jobs.putJob(record);

    const fake = swappableRunner('runner-test'); // workspacePathKnown は既定で true
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();

    expect(fake.state.resumes).toHaveLength(1);
    // 記録に `cwd` が無いので、既存のフォールバック（`runner.workspacePath`）を通る。
    expect(fake.state.resumes[0]?.cwd).toBe('/work/project');

    await s.pool.stop();
  });
});

/**
 * 宛先の器が黙ったとき、`live` がそれを見る（#358 の系列）。
 *
 * **ここが塞いでいる穴**: `isLive()` が見ていた材料（`status` / `attached` /
 * `sessionId`）は**どれもイベント駆動でしか更新されない**。runner の器が
 * `closed` も `resume_failed` も送らずに消えると `attached` は `true` のまま
 * 残り、`manager_list` は「走行中／話しかけられる」と名乗り続けた。
 *
 * デーモンは10秒ごとの生存確認で黙った器を `state: 'lost'` と判定しており、
 * その器は新しい委譲の宛先からも既に外れている（`RunnerRegistry#list()` の doc
 * 「`lost` は並ばない」）。**置き先として数えない器へ「話しかけられる」と
 * 名乗るほうが食い違っていた。**
 *
 * **`status` は動かさない。** 黙っているのが器なのか経路なのかは片側からは
 * 決められないので、`lost`（resume を試して戻れなかったという確かめた事実）を
 * ここで名乗らせない。
 */
describe('宛先の器が黙ったことを live が見る', () => {
  /**
   * 名簿の判定だけを差し替える薄い皮。
   *
   * **実物の heartbeat を回さないのは、`lost` の判定に30秒（`HEARTBEAT_LOST_MS`）
   * が要るからである。** ここで見たいのは「`entries()` が `lost` を告げたとき
   * `live` がどう出るか」であって、`lost` を立てるまでの時間の測り方ではない
   * （そちらは `runner-heartbeat.test.ts` が持つ）。
   */
  function withEntryState(
    registry: RunnerRegistry,
    runnerId: string,
    patch: Partial<RunnerEntry>,
  ): RunnerRegistry {
    return {
      list: () => registry.list(),
      get: (id) => registry.get(id),
      select: (input) => registry.select(input),
      register: (source) => registry.register(source),
      unregister: (label) => registry.unregister(label),
      subscribe: (onOpen) => registry.subscribe(onOpen),
      stop: () => registry.stop(),
      entries: () =>
        registry
          .entries()
          .map((entry) => (entry.runnerId === runnerId ? { ...entry, ...patch } : entry)),
    };
  }

  async function seed(stores: Stores, job: Partial<Job> & { id: string }): Promise<void> {
    const at = new Date().toISOString();
    await stores.jobs.putJob({
      managerId: job.id,
      createdAt: at,
      updatedAt: at,
      status: 'running',
      summary: '仕事',
      request: '仕事',
      cwd: '/work/project',
      ...job,
    } as Job);
  }

  it('黙ったと判定された器に載っている委譲は live: false になり、その判定時刻を運ぶ', async () => {
    const stores = createMemoryStores();
    // **`sessionId` を持たせる。** これが在ると、いままでの `isLive()` は
    // 「戻る先が在る」として `live: true` を返していた（この試験が守る差分）。
    await seed(stores, { id: 'mgr-orphan', runnerId: 'runner-a', sessionId: 'sess-a' });
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const real = createRunnerRegistry([a]);
    const registry = withEntryState(real, 'runner-a', {
      state: 'lost',
      since: '2026-08-27T09:00:00.000Z',
    });
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const listed = await pool.list();
    const orphan = listed.find((m) => m.managerId === 'mgr-orphan');

    expect(orphan?.live).toBe(false);
    expect(orphan?.runnerLostSince).toBe('2026-08-27T09:00:00.000Z');
    // **`status` は動かしていない。** 「黙った器に載っている」は「戻れなかった」
    // ではないので、`lost` という名前をここで使わない。
    expect(orphan?.status).toBe('running');

    await pool.stop();
    await real.stop();
  });

  it('同じ委譲は、器が黙っていなければ live: true のままで、欄も出ない', async () => {
    const stores = createMemoryStores();
    await seed(stores, { id: 'mgr-orphan', runnerId: 'runner-a', sessionId: 'sess-a' });
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const registry = createRunnerRegistry([a]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const listed = await pool.list();
    const orphan = listed.find((m) => m.managerId === 'mgr-orphan');

    expect(orphan?.live).toBe(true);
    // **欄ごと消える。** 「黙っていない」を `false` のような値で書かない。
    expect(orphan).not.toHaveProperty('runnerLostSince');

    await pool.stop();
    await registry.stop();
  });

  it('宛先が書かれていない古い委譲は、黙った器の判定に巻き込まない', async () => {
    const stores = createMemoryStores();
    // `runnerId` を持たない世代。どの器に居たのかをこの情報だけでは決められない。
    await seed(stores, { id: 'mgr-legacy', sessionId: 'sess-legacy' });
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const real = createRunnerRegistry([a]);
    const registry = withEntryState(real, 'runner-a', {
      state: 'lost',
      since: '2026-08-27T09:00:00.000Z',
    });
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const listed = await pool.list();
    const legacy = listed.find((m) => m.managerId === 'mgr-legacy');

    expect(legacy?.live).toBe(true);
    expect(legacy).not.toHaveProperty('runnerLostSince');

    await pool.stop();
    await real.stop();
  });

  it('runner_list の内訳にも同じ live が出る（2つの道具で字面が割れない）', async () => {
    const stores = createMemoryStores();
    await seed(stores, { id: 'mgr-orphan', runnerId: 'runner-a', sessionId: 'sess-a' });
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const real = createRunnerRegistry([a]);
    const registry = withEntryState(real, 'runner-a', {
      state: 'lost',
      since: '2026-08-27T09:00:00.000Z',
    });
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const overview = await pool.runners();

    expect(overview.runners.find((r) => r.runnerId === 'runner-a')?.managers).toEqual([
      { managerId: 'mgr-orphan', status: 'running', live: false },
    ]);

    await pool.stop();
    await real.stop();
  });
});

/**
 * 起動時の引き取り（`#restoreJobs`）で1本が投げても、後ろに並んだ委譲を道連れに
 * しない。
 *
 * **この理由は発明ではない。** 同じクラスの走査を持つ `#reattach` のジョブループ
 * には、同じ文言の理由が既に置いてある —— 「1本が戻せなくても、残りを道連れに
 * しない。ここで抜けると、後ろに並んでいた仕事が誰にも拾われないまま `running`
 * として残る」。**その理由が `#restoreJobs` に掛からない根拠は無い。**
 *
 * **こちらのほうが重い。** `#restoreJobs` はデーモンの起動時に台帳の**全ジョブ**を
 * 1本の走査で回すので、1本が投げるとその回の引き取りが丸ごと止まり、後ろに並んだ
 * 委譲は `#records` にすら載らないまま台帳に `running` で残る。呼び出し元
 * （`apps/daemon/src/index.ts` の `takeOver()`）は例外を握り潰して空配列を返す
 * ので、跡はログ1行しか残らない。
 */
describe('起動時の引き取りは、1本が投げても後ろを道連れにしない', () => {
  const at = '2026-08-01T00:00:00.000Z';
  function pending(id: string): Job {
    return {
      id,
      managerId: id,
      createdAt: at,
      updatedAt: at,
      status: 'running',
      summary: id,
      request: id,
      cwd: '/work/project',
      sessionId: `sess-${id}`,
      runnerId: 'runner-test',
    };
  }

  /**
   * **挑み直せる種類の失敗**（`RunnerHttpError` でない＝経路が切れた等）。
   * `isRetryableRunnerError` は `RunnerHttpError` 以外を `true` に倒す。
   */
  it('投げた1本の後ろに並んだ委譲も、同じ回で引き取られる', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(pending('mgr-poison'));
    await stores.jobs.putJob(pending('mgr-behind'));
    const s = setup(undefined, { stores });
    const original = s.runner.resume.bind(s.runner);
    s.runner.resume = async (command: RunnerResumeCommand) => {
      if (command.managerId === 'mgr-poison') throw new Error('boom（経路が切れた）');
      return original(command);
    };

    const restored = await s.pool.restore();

    // **後ろの1本は拾われている。** 塞ぐ前はここが空だった（走査ごと止まるので）。
    expect(restored.map((m) => m.managerId)).toContain('mgr-behind');
    expect(s.sessions).toHaveLength(1);

    // **投げた1本は `running` のままである。** 挑み直せる種類なので梯子へ載せた
    // だけで、「戻れなかった」とは確かめていない —— `lost` を名乗らせない。
    const listed = await s.pool.list();
    expect(listed.find((m) => m.managerId === 'mgr-poison')?.status).toBe('running');

    await s.pool.stop();
  });

  /**
   * **挑み直さないと決めた種類の失敗**（4xx の `RunnerHttpError`）。
   * `#reattach` の同じ分岐と同じ扱いにする —— この1本は `lost` になる。
   * resume を実際に試して戻れなかったので、ここでは `lost` は**確かめた事実**である。
   */
  it('挑み直さないと決めた1本は lost になり、後ろの委譲は引き取られる', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(pending('mgr-poison'));
    await stores.jobs.putJob(pending('mgr-behind'));
    const s = setup(undefined, { stores });
    const original = s.runner.resume.bind(s.runner);
    s.runner.resume = async (command: RunnerResumeCommand) => {
      if (command.managerId === 'mgr-poison') {
        throw new RunnerHttpError('runner POST /managers/mgr-poison/resume が失敗した (400)', 400);
      }
      return original(command);
    };

    const restored = await s.pool.restore();

    expect(restored.map((m) => m.managerId)).toContain('mgr-behind');

    const listed = await s.pool.list();
    expect(listed.find((m) => m.managerId === 'mgr-poison')?.status).toBe('lost');
    // **抜け殻のまま残さない。** `lost` は像からも外れる（`#retire`）ので、
    // 一覧は「走行中」と数えない。
    expect(listed.find((m) => m.managerId === 'mgr-poison')?.live).toBe(false);

    await s.pool.stop();
  });
});
