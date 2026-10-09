import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

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

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { clearRecentTracesForTesting, recentDroppedTraces } from './dropped-record.js';
import { gitChildEnv } from './git-child-env.test-support.js';
import {
  MANAGER_MODEL,
  WORKER_AGENT_NAME,
  WORKER_MODEL,
  WITHHELD_ENV_KEYS,
  createManagerPool,
  guardArchiveRemoval,
  type AutoFoldOutcome,
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
import { createCredentialService } from './credential-service.js';
import { fingerprintOf } from './credentials.js';
import { createProfileService } from './profile-service.js';
import { createLocalRunner } from './runner-local.js';
import {
  createRunnerRegistry,
  RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL,
  RunnerHttpError,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerCredentialFingerprint,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerEntry,
  type RunnerMcpServersFingerprint,
  type RunnerPlacementResources,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
  type RunnerRegistry,
  type RunnerResumeCommand,
  type UnpushedWorkResult,
} from './runner-protocol.js';
import type { InboxEvent, Job, JobStatus, JournalEntry } from './schema.js';
import { workspaceLocatorSchema } from './schema.js';
import type { Stores } from './store.js';
import {
  captureStderr,
  createMemoryStores,
  failingJobWrite,
  failingJournalAppend,
  seedFingerprintlessArchiveRow,
} from './testing.js';
import { createCloneTools } from './tools.js';
import type { TokenRotatorObservation } from './token-rotator.js';
import type { UsageTotals } from './usage.js';

type WorkerWaitEvent = Extract<RunnerEvent, { type: 'worker_wait' }>;

// 末尾専用の一意な目印: `.repeat()` の繰り返しだと抜粋の先頭にも同じ文字列が含まれ、
// `not.toContain` が先頭一致で落ちるため、切り詰めの外にしか無い文字列を末尾へ足す。
const REQUEST_TAIL_MARKER = 'REQUEST-TAIL-MARKER-9f3c2a91';
const REPORT_TAIL_MARKER = 'REPORT-TAIL-MARKER-7e1b44de';

interface FakeSession {
  options: Options;
  inputs: string[];
  ask(
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    requestId?: string,
  ): Promise<PermissionResult>;
  say(text: string, options?: { parentToolUseId?: string }): Promise<void>;
  report(text: string): Promise<void>;
  usedTool(tool: string, extra?: Record<string, unknown>): Promise<void>;
  noticeLimit(text: string): Promise<void>;
  rateLimit(info: Record<string, unknown>): Promise<void>;
}

function fakeSdk() {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    let emit: ((message: SDKMessage) => void) | null = null;
    let asks = 0;
    // `result` の `uuid` はターンごとに別の値にする: 固定だと runner が `reportId` として
    // 運ぶ冪等化で2回目以降の `report()` が握りつぶされ、実機では起きない重複扱いになるため。
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
        // 既定の request_id も被らせない: SDK は並列に呼ばれた道具を別々の id で同時に降ろすため。
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
  runner?: RunnerClient;
  generateManagerId?: () => string;
  onUsageObservation?: (observation: TokenRotatorObservation) => Promise<void>;
  tokenIdentity?: () => { tokenId: string; generation: number } | undefined;
  syncRunnerToken?: (runner: RunnerClient) => Promise<void>;
  // 省略時は渡さない: 本番と同じ既定（3000ms）のまま走らせるため。
  // 窓の後に届く知らせの中身を測る試験だけが `TEST_NOTICE_WINDOW_MS` を渡す。
  synthesizedNoticeWindowMs?: number;
}

// 窓の満了を待つ試験だけ既定より短く取る。0 に近づけすぎない: 1回の `restore()` で
// 連続して積まれる知らせが1つの束に収まる幅（100ms）が要るため。
const TEST_NOTICE_WINDOW_MS = 100;

// 偽の `query` は runner に渡す: SDK を握るのは runner で、デーモンは `RunnerRegistry` しか知らないため。
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
    // 本番と同じ1本道を通す: 降ろし直しは更新と同じ列に入る必要があり、省くと
    // 「重なったら壊れる」経路を試験が見なくなるため。鍵の袋も同じ。
    profile: createProfileService({ stores, runners: registry }),
    credentials: createCredentialService({
      stores,
      runners: registry,
      withheldEnvKeys: [...WITHHELD_ENV_KEYS],
    }),
    ...(options.generateManagerId === undefined
      ? {}
      : { generateManagerId: options.generateManagerId }),
    ...(options.onUsageObservation === undefined
      ? {}
      : { onUsageObservation: options.onUsageObservation }),
    ...(options.tokenIdentity === undefined ? {} : { tokenIdentity: options.tokenIdentity }),
    ...(options.syncRunnerToken === undefined ? {} : { syncRunnerToken: options.syncRunnerToken }),
    ...(options.synthesizedNoticeWindowMs === undefined
      ? {}
      : { synthesizedNoticeWindowMs: options.synthesizedNoticeWindowMs }),
  });
  return { pool, stores, sessions, inbox, runner };
}

describe('マネージャー', () => {
  it('層とモデル帯の対応、道具の配置を固定する（北極星の不変条件）', async () => {
    const s = setup();
    await s.pool.start({ request: 'ログイン周りを直して' });

    const { options } = s.sessions[0] as FakeSession;

    expect(options.model).toBe(MANAGER_MODEL);
    expect(MANAGER_MODEL).toBe('opus');

    const worker = (options.agents ?? {})[WORKER_AGENT_NAME] as AgentDefinition;
    expect(worker.model).toBe(WORKER_MODEL);
    expect(WORKER_MODEL).toBe('sonnet');

    expect(options.tools).toBeUndefined();
    expect(options.allowedTools).toBeUndefined();
    expect(options.disallowedTools).toBeUndefined();
    expect(worker.tools).toBeUndefined();
    expect(worker.disallowedTools).toBeUndefined();

    expect(options.maxTurns).toBeUndefined();
    expect(options.maxBudgetUsd).toBeUndefined();
    expect(worker.maxTurns).toBeUndefined();

    expect(options.permissionMode).toBe('auto');
    expect(typeof options.canUseTool).toBe('function');

    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    expect(options.cwd).toBe('/work/project');

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

    // 空文字は既定へ落とす: compose の `${VAR:-}` で未設定の変数が空文字として届き、
    // `!== undefined` で見ると SDK へそのまま流れて起動時に落ちるため。
    // 既知の別名で関門を作らない: SDK が増やしたモデルを人間が選べなくなるため。
    expect(resolveManagerModel({ [MANAGER_MODEL_ENV_KEY]: 'fable' })).toBe('fable');
    expect(resolveManagerModel({ [MANAGER_MODEL_ENV_KEY]: '  fable  ' })).toBe('fable');
    expect(resolveWorkerModel({ [WORKER_MODEL_ENV_KEY]: 'まだ無いモデル' })).toBe('まだ無いモデル');
  });

  it('置かれたかどうかは、既定と同じ値を置いた場合も「置いた」である', () => {
    expect(placedManagerModels({})).toEqual([]);
    expect(placedManagerModels({ [MANAGER_MODEL_ENV_KEY]: '  ' })).toEqual([]);

    // 値の比較で言い換えない: 答えているのは「差し替えの承認が置かれているか」で、
    // 「既定と違うか」ではないため。
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
    // 作業者の `model` を省略しない: SDK の既定は親の継承で、マネージャーの差し替えが作業者まで動かすため。
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
    expect(env.PATH).toBe('/usr/bin');

    await s.pool.stop();
  });

  // 時刻は固定できない（`new Date()` を直接使う設計）ので、報告の前後で取った時刻で挟む。
  it('報告が降りてきたら、デーモンが受け取った時刻が委譲の要約に載る（#358）', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });

    const before = Date.now();
    await (s.sessions[0] as FakeSession).report('終わった');
    const after = Date.now();

    const [summary] = await s.pool.list();
    expect(summary?.lastReport).toBe('終わった');
    const at = summary?.lastReportAt;
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
    const s = setup();
    await s.pool.start({ request: 'ログイン周りを直して' });

    const { options } = s.sessions[0] as FakeSession;
    expect(options.permissionMode).toBe('auto');
    expect(typeof options.canUseTool).toBe('function');

    await s.pool.stop();
  });

  it('許可確認はクローンへ回り、返事が来るまでその仕事だけが止まる（受け入れ基準2）', async () => {
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

    const event = s.inbox.find((entry) => entry.type === 'manager_message');
    expect(event).toMatchObject({ kind: 'permission', managerId });
    expect((event as { requestId?: string }).requestId).toBeTruthy();

    const waiting = (await s.pool.list()).find((m) => m.managerId === managerId);
    expect(waiting?.status).toBe('waiting_human');
    expect(waiting?.waiting[0]?.summary).toContain('Bash');

    const result = await s.pool.send(managerId, 'よい', { decision: 'allow' });
    expect(result.outcome).toBe('answered');
    expect(await asked).toEqual({ behavior: 'allow' });
    expect((await s.pool.list()).find((m) => m.managerId === managerId)?.status).toBe('running');

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

  it("実行許可の確認は manager_message に markup: 'none' が立つ（#287）", async () => {
    const s = setup();
    await s.pool.start({ request: 'デプロイして' });
    const session = s.sessions[0] as FakeSession;

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

  it('AskUserQuestion の選択肢（label と description）がクローンへ届く', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '設計を相談したい' });
    const session = s.sessions[0] as FakeSession;

    const asked = session.ask(
      'AskUserQuestion',
      {
        questions: [
          {
            question: 'DB はどちらにする？',
            header: 'DB',
            options: [
              { label: 'PostgreSQL', description: '本番と同じ。移行は要らない' },
              { label: 'SQLite', description: '手元だけで完結するが本番と違う' },
            ],
            multiSelect: false,
          },
        ],
      },
      undefined,
      'req-db-options',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const delivered = s.inbox.find((e) => e.type === 'manager_message') as
      { text: string } | undefined;
    expect(delivered).toBeDefined();
    const text = delivered?.text ?? '';
    expect(text).toContain('DB はどちらにする？');
    expect(text).toContain('PostgreSQL');
    expect(text).toContain('本番と同じ。移行は要らない');
    expect(text).toContain('SQLite');
    expect(text).toContain('手元だけで完結するが本番と違う');

    await s.pool.send(managerId, 'PostgreSQL で', { requestId: 'req-db-options' });
    await asked;
    await s.pool.stop();
  });

  it('AskUserQuestion にはクローンの言葉がそのまま回答として入る', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '設計を相談したい' });
    const session = s.sessions[0] as FakeSession;

    // 質問に allow/deny は無いので、宛先は requestId で特定する。
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

    const escalations = (await s.stores.journal.list({ types: ['escalation'] })) as {
      answer?: string;
    }[];
    expect(escalations[0]?.answer).toBe('[allow] PostgreSQL で');

    await s.pool.stop();
  });

  it('AskUserQuestion の確認には manager_message に markup のキーが無い（#287）', async () => {
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

    await s.pool.send(managerId, 'PostgreSQL で', {
      requestId: 'req-db-deny',
      decision: 'deny',
    });
    expect(await asked).toMatchObject({ behavior: 'allow' });

    const escalations = (await s.stores.journal.list({ types: ['escalation'] })) as {
      answer?: string;
    }[];
    expect(escalations[0]?.answer).toBe('[allow] PostgreSQL で');

    await s.pool.stop();
  });

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

    // `decision` を明示する: 無いと「追加指示」として流れるだけで、あいまい分岐に届かないため。
    const result = await s.pool.send(managerId, 'どれのこと？', { decision: 'allow' });
    expect(result.outcome).toBe('unknown');
    expect(result.detail?.length).toBeLessThan(1_000);
    expect(result.detail).toMatch(/省略/);

    await s.pool.stop();
  });

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

  // `s.pool.list()` では `state()` 側の取り直しを検出できない（`ask` イベント経由で1度だけ
  // 埋まる `record.waiting` を見るため）ので、`s.runner.list()` を直接呼ぶ。
  it('runner.state() は呼ぶたびに askedAt を取り直さない（#334 / #323）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: 'デプロイして' });
    const session = s.sessions[0] as FakeSession;

    session.ask('Bash', { command: 'git push' }, undefined, 'req-stable');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const first = (await s.runner.list()).find((m) => m.managerId === managerId);
    const askedAtFirst = first?.waiting.find((item) => item.requestId === 'req-stable')?.askedAt;
    expect(askedAtFirst).toBeTruthy();

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
    const s = setup();
    const { managerId } = await s.pool.start({ request: 'デプロイして' });
    const session = s.sessions[0] as FakeSession;

    const asked = session.ask('Bash', { command: 'git push --force' }, undefined, 'req-only');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await s.pool.list()).find((m) => m.managerId === managerId)?.waiting).toHaveLength(1);

    const result = await s.pool.send(managerId, 'ところで、進捗はどうなっている？');

    expect(result.outcome).toBe('delivered');
    await expect
      .poll(() => session.inputs, { timeout: 2000 })
      .toEqual(['デプロイして', 'ところで、進捗はどうなっている？']);
    expect((await s.pool.list()).find((m) => m.managerId === managerId)?.waiting).toHaveLength(1);

    const answered = await s.pool.send(managerId, 'よい', { decision: 'allow' });
    expect(answered.outcome).toBe('answered');
    expect(await asked).toEqual({ behavior: 'allow' });

    await s.pool.stop();
  });

  it('保留が1件でも、「待って」を含む普通の会話文は deny として消費されない（#313）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '公開して' });
    const session = s.sessions[0] as FakeSession;

    const asked = session.ask('Bash', { command: 'npm publish' }, undefined, 'req-wait');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result = await s.pool.send(managerId, 'その件は少し待ってください。先に状況を教えて');

    // deny が返っていないことを先に測る: outcome を先に見ると、消費されたときにそちらで
    // 落ちて、この行まで到達しない。
    const settled = await Promise.race([
      asked,
      new Promise((resolve) => setTimeout(() => resolve('unsettled'), 50)),
    ]);
    expect(settled).toBe('unsettled');

    expect(result.outcome).toBe('delivered');

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

    // 欄ごと消さない: 消すと「何も書かれていない」と同じに見え、「取れなかった」という観測が消えるため。
    expect(summary?.workspace).toBeDefined();
    expect(summary?.workspace?.kind).toBe('unknown');
    expect((summary?.workspace as { reason?: string } | undefined)?.reason ?? '').not.toBe('');

    await s.pool.stop();
  });

  it('過去に書かれた runner-volume の行は、そのまま読める（遡って直さない）', () => {
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
      runnerId: 'runner-test',
      workspace: {
        kind: 'unknown',
        runnerId: 'runner-test',
        path: '/work/project',
        reason: expect.stringContaining('確かめられない') as unknown as string,
      },
    });

    // 確かめていない永続性を名乗らない: `runner-volume` に戻ると、ボリュームを付けない構成で
    // 台帳が偽になり「復旧できる」と信じる方向へ嘘をつくため。
    expect(job?.workspace?.kind).not.toBe('runner-volume');
    expect((job?.workspace as { reason?: string } | undefined)?.reason ?? '').not.toBe('');

    await (s.sessions[0] as FakeSession).usedTool('Read');
    expect(job).not.toHaveProperty('transcriptPath');

    await s.pool.stop();
  });

  it('conversationId を渡せば JobStore へそのまま写る。省略すれば欄自体が付かない', async () => {
    const s = setup();
    const { managerId: withConv } = await s.pool.start({
      request: '直して',
      conversationId: 'conv-1',
    });
    const { managerId: withoutConv } = await s.pool.start({ request: '別件' });

    const jobs = await s.stores.jobs.listJobs();
    const jobWithConv = jobs.find((job) => job.id === withConv);
    const jobWithoutConv = jobs.find((job) => job.id === withoutConv);

    expect(jobWithConv?.conversationId).toBe('conv-1');
    // 既定値へ倒さない: `undefined` を明示で書くと「会話に紐づかない委譲」と
    // 「まだ判定していない委譲」が区別できなくなるため。
    expect(jobWithoutConv).not.toHaveProperty('conversationId');

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

    const guessed = await s.pool.send(managerId, 'それは危険なのでやめて', { decision: 'deny' });
    expect(guessed.outcome).toBe('unknown');
    expect(guessed.detail).toContain('requestId');

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
    const s = setup();
    const { managerId } = await s.pool.start({ request: 'デプロイして' });
    const session = s.sessions[0] as FakeSession;

    // decision は足さない: 測っているのは decision を書き忘れた回答の読み取りそのもので、足すと対象が消える。
    // 「やめ」の前に区切りは無い: 語境界で探すと見つからず、拒否が承認として表に出る。
    const asked = session.ask('Bash', { command: 'git push --force' }, undefined, 'req-force');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await s.pool.send(managerId, 'それはやめて、代わりに差分だけ見せて', {
      requestId: 'req-force',
    });

    expect(await asked).toMatchObject({ behavior: 'deny' });

    const escalations = (await s.stores.journal.list({ types: ['escalation'] })) as {
      answer?: string;
    }[];
    expect(escalations[0]?.answer).toBe('[deny] それはやめて、代わりに差分だけ見せて');

    await s.pool.stop();
  });

  it('承認とも拒否とも読めない言い方は、既定を閉じる側にして拒否する（旧: 肯定の返事は通す。issue #1827/#1837 で反転）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '調べて' });
    const session = s.sessions[0] as FakeSession;

    // decision は足さない: 測っているのは decision 無しの読み取りだから。
    const asked = session.ask('Read', { file_path: '/work/a.ts' }, undefined, 'req-read');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await s.pool.send(managerId, 'よい、そのまま進めて', { requestId: 'req-read' });

    expect(await asked).toMatchObject({ behavior: 'deny' });

    expect(result.outcome).toBe('answered');
    expect(result.detail).toContain('読み取れず');
    expect(result.detail).toContain("decision: 'allow'");

    const escalations = (await s.stores.journal.list({ types: ['escalation'] })) as {
      answer?: string;
    }[];
    expect(escalations[0]?.answer).toBe('[unreadable] よい、そのまま進めて');

    await s.pool.stop();
  });

  it('unreadable で拒否された後、同じ道具を撃ち直すと新しい確認が上がり、decision: allow を付けて答え直せば通る（issue #1827/#1837）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '調べて' });
    const session = s.sessions[0] as FakeSession;

    const firstAsk = session.ask('Read', { file_path: '/work/a.ts' }, undefined, 'req-retry-1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await s.pool.send(managerId, 'よい、そのまま進めて', { requestId: 'req-retry-1' });
    expect(await firstAsk).toMatchObject({ behavior: 'deny' });

    const secondAsk = session.ask('Read', { file_path: '/work/a.ts' }, undefined, 'req-retry-2');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await s.pool.list()).find((m) => m.managerId === managerId)?.waiting).toHaveLength(1);

    const retried = await s.pool.send(managerId, 'よい、そのまま進めて', {
      requestId: 'req-retry-2',
      decision: 'allow',
    });
    expect(retried.outcome).toBe('answered');
    expect(await secondAsk).toEqual({ behavior: 'allow' });

    await s.pool.stop();
  });

  it('runner が decision を報告しない回（版skewの窓）は、allow/deny へ倒さず journal に残す（#322）', async () => {
    // 可変箱に包む: 素の `let emit` を複数メソッドから触ると、呼び出し側の参照が `never` に narrowing されるため。
    const wired: { emit: ((event: RunnerEvent) => void) | null } = { emit: null };
    const legacyRunner: RunnerClient = {
      runnerId: 'runner-legacy',
      runnerIdKnown: true,
      workspacePathKnown: true,
      workspacePath: '/work/project',
      async connect(onEvent) {
        wired.emit = onEvent;
      },
      async start(): Promise<{ cwd?: string }> {
        return {};
      },
      async resume(): Promise<{ cwd?: string }> {
        return {};
      },
      async send() {
        return true;
      },
      async answer(_managerId, answer) {
        // `settled` も流す: 流さないと `waiting` が残ったままで「解けた」を主張できない。
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
    expect(escalations[0]?.answer).toBe('[unknown] よい');

    await s.pool.stop();
  });

  it('中断で解けた確認は待ち行列に残らない（次の指示を食い潰さない）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '調べて' });
    const session = s.sessions[0] as FakeSession;

    const aborter = new AbortController();
    const asked = session.ask('Bash', { command: 'ls' }, aborter.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));

    aborter.abort();
    expect(await asked).toMatchObject({ behavior: 'deny' });

    const after = (await s.pool.list()).find((m) => m.managerId === managerId);
    expect(after?.status).toBe('running');
    expect(after?.waiting).toEqual([]);

    expect((await s.pool.send(managerId, 'こっちを見て')).outcome).toBe('delivered');

    await s.pool.stop();
  });

  it('居ないマネージャーへの送信は、黙って捨てずに理由を返す', async () => {
    const s = setup();
    expect((await s.pool.send('mgr-nope', 'やあ')).outcome).toBe('unknown');
    await s.pool.stop();
  });

  it('LocalRunner.send はセッションの有無を boolean で報告する（#899）', async () => {
    const s = setup();

    await expect(s.runner.send('mgr-never-started', 'こんにちは')).resolves.toBe(false);

    const { managerId } = await s.pool.start({ request: '調べて' });
    await expect(s.runner.send(managerId, '続けて')).resolves.toBe(true);

    await s.pool.stop();
  });

  it('記憶ストアの接続情報を子プロセスへ渡さない（クラウド構成の本命の強制）', async () => {
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

    expect(env.PATH).toBe('/usr/bin');

    // 器の env の鍵は子へ渡さない: 現役でない鍵（週次上限で冷却中のもの）で走り、
    // クローンが撒いたものと器に残っていたものを区別できなくなるため。
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

    await s.pool.stop();
  });
});

// `randomUUID` は差し替えず `generateManagerId` で注入する: `vi.mock('node:crypto')` の前例が無いため。
describe('managerId の発行（#238）', () => {
  it('切り詰めない — 既定の発行器は `mgr-` に UUID 全体を続ける', async () => {
    const s = setup();
    const summary = await s.pool.start({ request: '調べて' });

    expect(summary.managerId).toMatch(
      /^mgr-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    await s.pool.stop();
  });

  it('発行した id が既に走っている委譲のものなら、上書きせず引き直し、跡を残す（本文は出さない）', async () => {
    const generateManagerId = vi
      .fn<() => string>()
      .mockReturnValueOnce('mgr-dup')
      .mockReturnValueOnce('mgr-dup')
      .mockReturnValueOnce('mgr-fresh');
    const s = setup(undefined, { generateManagerId });

    const first = await s.pool.start({
      request: `一本目 秘密は ghp_000000000000000000000000000000000000 だ`,
    });
    expect(first.managerId).toBe('mgr-dup');

    const lines = await captureStderr(async () => {
      const second = await s.pool.start({ request: '二本目' });
      expect(second.managerId).toBe('mgr-fresh');
    });

    const text = lines.join('');
    expect(text).toContain('managerId の発行が衝突したので引き直しました');
    expect(text).toContain('managerId=mgr-dup');
    expect(text).toContain('attempt=1');
    expect(text).not.toContain('ghp_');
    expect(text).not.toContain('一本目');
    expect(text).not.toContain('二本目');

    const listed = await s.pool.list();
    expect(listed.find((m) => m.managerId === 'mgr-dup')?.request).toContain('一本目');
    expect(listed.find((m) => m.managerId === 'mgr-fresh')?.request).toBe('二本目');

    await s.pool.stop();
  });

  it('引き直しが上限に達したら、上書きせず例外で止める', async () => {
    const generateManagerId = vi.fn<() => string>().mockReturnValue('mgr-stuck');
    const s = setup(undefined, { generateManagerId });

    const first = await s.pool.start({ request: '一本目' });
    expect(first.managerId).toBe('mgr-stuck');

    const lines = await captureStderr(async () => {
      await expect(s.pool.start({ request: '二本目' })).rejects.toThrow(
        /managerId の発行が.*回連続で衝突/,
      );
    });

    const text = lines.join('');
    expect(text).toContain('managerId の発行が衝突したので引き直しました');

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
    // 開き直すだけにしない: 「話しかけられるまで待つ」形だと、自律運転中の再起動で仕事が永久に止まるため。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const s = setup(undefined, { stores });

    const restored = await s.pool.restore();

    expect(restored.map((m) => m.managerId)).toEqual(['mgr-old']);
    expect(s.sessions).toHaveLength(1);
    expect((s.sessions[0] as FakeSession).options.resume).toBe('sess-before-restart');
    await expect
      .poll(() => (s.sessions[0] as FakeSession).inputs, { timeout: 2000 })
      .toEqual([
        // resume した分岐は器の入れ替えとして扱う: 「デーモンが再起動した」だけでは、
        // 作業ディレクトリが消えたことを告げないため。
        '[system] runner の器が作り直された。作業ディレクトリが残っているとは限らないので、続きに入る前に手元の状態を確かめよ。中断していた作業の続きを進めよ。',
      ]);

    const notice = s.inbox.find((event) => event.type === 'manager_message');
    expect(notice).toMatchObject({ managerId: 'mgr-old', kind: 'report' });
    expect((notice as { text: string }).text).not.toContain('DB の移行をやって');
    expect((notice as { text: string }).text).toContain('manager_report managerId=mgr-old');
    expect((notice as { text: string }).text).toContain('スキーマまで書いた');

    const listed = (await s.pool.list()).find((m) => m.managerId === 'mgr-old');
    expect(listed).toMatchObject({ live: true, status: 'running', runnerId: 'runner-test' });

    await s.pool.stop();
  });

  it('#252: 依頼文・直近の報告が巨大でも、知らせは全文を埋め込まない', async () => {
    // 末尾の断片で判定する: 抜粋は先頭を残す仕様なので、先頭一致だけの判定では
    // 先頭だけ切って残りは埋め込んだままでも素通りするため。
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

  it('返事待ちだったマネージャーには、確認が失われたことを伝えて再開させる', async () => {
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
    const stores = createMemoryStores();
    const first = setup(undefined, { stores });
    const { managerId } = await first.pool.start({ request: '長い仕事' });

    const second = setup(undefined, { stores, runner: first.runner });
    const restored = await second.pool.restore();

    expect(restored.map((m) => m.managerId)).toEqual([managerId]);
    expect(first.sessions).toHaveLength(1);
    const notice = second.inbox.find((event) => event.type === 'manager_message');
    expect((notice as { text: string }).text).toContain('runner の中で走り続けている');

    await second.pool.stop();
  });

  it('待機中だった仕事は黙って引き取る（報告はしないが、話しかければ続く）', async () => {
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

  it('stopped の仕事はデーモン再起動でも拾い直さない（明示的に止められた終端）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-stopped-restart', status: 'stopped' });
    const s = setup(undefined, { stores });

    const resumed = await s.pool.restore();

    expect(resumed).toEqual([]);
    expect(s.inbox).toEqual([]);
    expect(s.sessions).toHaveLength(0);

    await s.pool.stop();
  });

  it('stopped の仕事でも、明示的な manager_send なら resume 経路を通って続く', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-stopped-send', status: 'stopped' });
    const s = setup(undefined, { stores });

    expect(await s.pool.restore()).toEqual([]);
    expect(s.sessions).toHaveLength(0);

    const result = await s.pool.send('mgr-stopped-send', 'まだ続きがある');

    expect(result.outcome).toBe('delivered');
    expect(s.sessions).toHaveLength(1);
    expect((s.sessions[0] as FakeSession).options.resume).toBe('sess-before-restart');

    const listed = (await s.pool.list()).find((m) => m.managerId === 'mgr-stopped-send');
    expect(listed?.status).toBe('running');

    await s.pool.stop();
  });

  it('runner が lost と名乗ったセッションを、繋がっているからと live: true にしない', async () => {
    // `live` の判定は `attached` に依存させない: 代入を数え上げて成り立つ不変条件は、
    // 次に代入を足した人が黙って壊すため。
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
    expect(restored.map((m) => m.managerId)).toEqual([runningJob.id]);
    expect(restored[0]?.live).toBe(false);

    const listed = (await s.pool.list()).find((m) => m.managerId === runningJob.id);
    expect(listed).toMatchObject({ status: 'lost', live: false });

    await s.pool.stop();
  });

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
    // fixture の値そのものと比べる: `toBeCloseTo` のような近似では、取り直す変異が生き残るため。
    expect(question?.askedAt).toBe(askedAtQuestion);
    expect(permission?.askedAt).toBe(askedAtPermission);

    await s.pool.stop();
  });

  it('runner が lost と名乗ったセッションへ send すると resume 経路を通る（届かない runner.send() にしない）', async () => {
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

    // resume の発生そのものを見る: fake の `send` は何も記録しないので、その不在は証拠にならない。
    expect(fake.state.resumes).toHaveLength(1);
    expect(fake.state.resumes[0]).toMatchObject({
      managerId: runningJob.id,
      sessionId: 'sess-before-restart',
    });
    expect(result.outcome).toBe('delivered');

    await s.pool.stop();
  });

  it('runner が lost と名乗ったセッションを引き取っても、「走り続けている」とは知らせない', async () => {
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

    // resume の発生そのものを見る: fake の `send` は何も記録しないので、その不在は証拠にならない。
    expect(fake.state.resumes).toHaveLength(1);
    expect(fake.state.resumes[0]).toMatchObject({
      managerId: runningJob.id,
      sessionId: 'sess-before-restart',
    });
    expect(result.outcome).toBe('delivered');

    await s.pool.stop();
  });

  it('runner が failed と名乗ったセッションを引き取っても、「走り続けている」とは知らせない', async () => {
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
    // `swappableRunner` は使わない: その fake の `resume` は無条件に alive を1本増やすので、
    // `host.resume()` の短絡（生きたセッションを見つけたら `push` して return）を確かめられないため。
    const stores = createMemoryStores();
    const first = setup(undefined, { stores });
    const { managerId } = await first.pool.start({ request: '長い仕事' });

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

    const second = setup(undefined, { stores, runner: first.runner });
    await second.pool.restore();

    const result = await second.pool.send(managerId, 'まだ続きがある');

    expect(first.sessions).toHaveLength(1);
    expect(result.outcome).toBe('delivered');
    await expect
      .poll(() => (first.sessions[0] as FakeSession).inputs, { timeout: 2000 })
      .toContain('まだ続きがある');

    await second.pool.stop();
  });

  it('生きたまま待機している done を引き取っても、「走り続けている」とは知らせない', async () => {
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

    const passed = (s.sessions[0] as FakeSession).options.sessionStore as typeof sessionStore;
    expect(passed).toBeDefined();
    await passed.append({ projectKey: 'proj-key' }, [{ type: 'user', uuid: 'u1' }]);
    await expect.poll(() => appended.length, { timeout: 2000 }).toBe(1);

    await expect
      .poll(async () => (await s.stores.jobs.listJobs())[0]?.projectKey, { timeout: 2000 })
      .toBe('proj-key');

    expect(await s.pool.transcript(managerId)).toEqual({
      kind: 'body',
      body: '{"type":"user","uuid":"u1"}\n',
    });

    await s.pool.stop();
  });

  it('unpushedWork は同一プロセスでも実際の git の答えを運ぶ（#1039）', async () => {
    const run = promisify(execFile);
    const dir = await makeTempDir('alteroid-manager-unpushed-');
    const git = (args: string[]) =>
      // 器の秘密を継承させない: `gitChildEnv()` は `git` を解決する `PATH` と偽 `HOME` だけを渡す。
      run('git', args, { cwd: dir, env: { ...gitChildEnv(), GIT_TERMINAL_PROMPT: '0' } });
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test']);
    await writeFile(join(dir, 'a.txt'), 'first\n');
    await git(['add', 'a.txt']);
    await git(['commit', '-q', '-m', 'first']);

    const s = setup(undefined, { stores: createMemoryStores() });
    const { managerId } = await s.pool.start({ request: '確認', cwd: dir });

    const probe = await s.pool.unpushedWork(managerId);

    expect(probe.kind).toBe('ok');
    if (probe.kind !== 'ok') throw new Error('unreachable');
    expect(probe.result.worktrees).toHaveLength(1);
    expect(probe.result.worktrees[0]).toMatchObject({
      relativePath: '.',
      branch: 'main',
      unpushedCommitCount: 1,
      uncommittedChangeCount: 0,
    });

    await s.pool.stop();
  });
});

describe('unpushedWork の観測を台帳へ残す（Issue #1228 候補(1)）', () => {
  it('manager_stop が呼ぶ unpushedWork の枝名は、器を落とした後も台帳から引ける', async () => {
    const run = promisify(execFile);
    const dir = await makeTempDir('alteroid-manager-unpushed-ledger-');
    const git = (args: string[]) =>
      // 器の秘密を継承させない: `gitChildEnv()` は `git` を解決する `PATH` と偽 `HOME` だけを渡す。
      run('git', args, { cwd: dir, env: { ...gitChildEnv(), GIT_TERMINAL_PROMPT: '0' } });
    await git(['init', '-q', '-b', 'fix/1228-worktree-branch-into-ledger']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test']);
    await writeFile(join(dir, 'a.txt'), 'first\n');
    await git(['add', 'a.txt']);
    await git(['commit', '-q', '-m', 'first']);

    const stores = createMemoryStores();
    const s = setup(undefined, { stores });
    const { managerId } = await s.pool.start({ request: '確認', cwd: dir });

    const probe = await s.pool.unpushedWork(managerId);
    expect(probe.kind).toBe('ok');

    await s.pool.stop();

    const stored = (await stores.jobs.listJobs()).find((job) => job.id === managerId);
    expect(stored?.lastUnpushedWorkObservation).toMatchObject({
      kind: 'observed',
      cwd: dir,
      worktrees: [{ relativePath: '.', branch: 'fix/1228-worktree-branch-into-ledger' }],
    });
    if (stored?.lastUnpushedWorkObservation?.kind !== 'observed') {
      throw new Error('unreachable');
    }
    expect(typeof stored.lastUnpushedWorkObservation.at).toBe('string');

    expect(stored?.cwd).toBe(dir);
  });

  it('取れなかった回は unavailable + reason を残し、一度も呼んでいない回（欄が丸ごと無い）と区別できる', async () => {
    const fake = swappableRunner('runner-primary');
    const stores = createMemoryStores();
    const s = setup(undefined, { stores, runner: fake.runner });
    const { managerId } = await s.pool.start({ request: '確認' });

    const before = (await stores.jobs.listJobs()).find((job) => job.id === managerId);
    expect(before?.lastUnpushedWorkObservation).toBeUndefined();

    const probe = await s.pool.unpushedWork(managerId);
    expect(probe).toMatchObject({ kind: 'unavailable' });

    const after = (await stores.jobs.listJobs()).find((job) => job.id === managerId);
    expect(after?.lastUnpushedWorkObservation).toMatchObject({
      kind: 'unavailable',
      reason: 'この runner はこの口を持たない（古い版、またはテストの偽物）。',
    });
    if (after?.lastUnpushedWorkObservation?.kind !== 'unavailable') {
      throw new Error('unreachable');
    }
    expect(typeof after.lastUnpushedWorkObservation.at).toBe('string');

    await s.pool.stop();
  });
});

describe('list() が lastUnpushedWorkObservation を運ぶ（Issue #1266）', () => {
  const baseJob = {
    id: 'mgr-unpushed-base',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    status: 'running' as const,
    summary: '確認',
  };

  it('observed な観測を list() がそのまま運ぶ', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({
      ...baseJob,
      id: 'mgr-unpushed-observed',
      lastUnpushedWorkObservation: {
        kind: 'observed',
        at: '2026-09-20T00:05:00.000Z',
        cwd: '/work/project',
        worktrees: [{ relativePath: '.', branch: 'feat/example' }],
      },
    });
    const s = setup(undefined, { stores });

    const listed = (await s.pool.list()).find((m) => m.managerId === 'mgr-unpushed-observed');

    expect(listed?.lastUnpushedWorkObservation).toEqual({
      kind: 'observed',
      at: '2026-09-20T00:05:00.000Z',
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'feat/example' }],
    });

    await s.pool.stop();
  });

  it('unavailable な観測（reason を含む）も list() がそのまま運ぶ', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({
      ...baseJob,
      id: 'mgr-unpushed-unavailable',
      lastUnpushedWorkObservation: {
        kind: 'unavailable',
        at: '2026-09-20T00:05:00.000Z',
        reason: 'この runner はこの口を持たない（古い版、またはテストの偽物）。',
      },
    });
    const s = setup(undefined, { stores });

    const listed = (await s.pool.list()).find((m) => m.managerId === 'mgr-unpushed-unavailable');

    expect(listed?.lastUnpushedWorkObservation).toEqual({
      kind: 'unavailable',
      at: '2026-09-20T00:05:00.000Z',
      reason: 'この runner はこの口を持たない（古い版、またはテストの偽物）。',
    });

    await s.pool.stop();
  });

  it('観測が無い委譲では list() の欄そのものが無い（undefined）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...baseJob, id: 'mgr-unpushed-none' });
    const s = setup(undefined, { stores });

    const listed = (await s.pool.list()).find((m) => m.managerId === 'mgr-unpushed-none');

    expect(listed?.lastUnpushedWorkObservation).toBeUndefined();

    await s.pool.stop();
  });
});

function swappableRunner(runnerId = 'runner-primary') {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const state = {
    alive: [] as RunnerManagerState[],
    resumes: [] as RunnerResumeCommand[],
    listCalls: 0,
    listThrows: false,
    sends: [] as string[],
    answers: [] as { managerId: string; requestId: string }[],
    profiles: [] as string[],
    held: new Map<string, string>(),
    credentialPushes: [] as { name: string; value: string }[][],
    resources: undefined as RunnerPlacementResources | undefined,
    // `enableUnpushedWork()` を呼ぶまで `runner.unpushedWork` は生やさない: 無条件に生やすと、
    // 「runner がこの口を持たないときは unavailable + reason が残る」試験が壊れるため。
    unpushedWorkResult: undefined as UnpushedWorkResult | undefined,
    transcript: null as string | null,
  };
  const runner: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePathKnown: true,
    workspacePath: '/work/project',
    async connect(onEvent) {
      // ここで名乗らせない: 本物の `connect` は即 return し名乗りは後から SSE に乗るので、
      // 同期的に名乗らせると引き取りとの順序が現実と変わり、器のずれを作れなくなる。
      emit = onEvent;
    },
    async start(): Promise<{ cwd?: string }> {
      return {};
    },
    async resume(command): Promise<{ cwd?: string }> {
      state.resumes.push(command);
      state.alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
      return {};
    },
    // 本物と同じ 404 を返す: 黙って成功させると、`alive` から消えたセッションへの送信が
    // 届いたことになり、台帳の `attached` が嘘になる窓を再現できないため。
    async send(managerId) {
      state.sends.push(managerId);
      if (!state.alive.some((s) => s.managerId === managerId)) {
        throw new RunnerHttpError(
          `runner POST /managers/${managerId}/messages が失敗した (404)`,
          404,
        );
      }
      return true;
    },
    async answer(managerId, answer) {
      state.answers.push({ managerId, requestId: answer.requestId });
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
      if (state.listThrows) throw new Error('一覧が読めない（器は生きている）');
      return [...state.alive];
    },
    async transcript() {
      return state.transcript;
    },
    async resources() {
      return state.resources;
    },
    async credentials() {
      return [...state.held].map(([name, value]) => ({
        name,
        sha256: fingerprintOf(value),
        updatedAt: '2026-01-01T00:00:00.000Z',
      }));
    },
    async setCredentials(entries) {
      state.credentialPushes.push([...entries]);
      for (const entry of entries) {
        if (entry.value.length === 0) state.held.delete(entry.name);
        else state.held.set(entry.name, entry.value);
      }
      return [...state.held].map(([name, value]) => ({
        name,
        sha256: fingerprintOf(value),
        updatedAt: '2026-01-01T00:00:00.000Z',
      }));
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
    swap() {
      state.alive = [];
      emit?.({ type: 'hello', runnerId });
    },
    reconnect() {
      emit?.({ type: 'hello', runnerId });
    },
    // 新しい `RunnerEvent` には欄が無いので型の外から渡す（`runner-client.ts` の zod は未知の欄を捨てる）。
    helloFromLegacyProviderRunner(capabilities: string[]) {
      emit?.({
        type: 'hello',
        runnerId,
        capabilities,
        managerProvider: 'codex',
        managerProviders: ['claude', 'codex'],
      } as unknown as RunnerEvent);
    },
    helloWithModels(models: { managerModel?: string; workerModel?: string }) {
      emit?.({ type: 'hello', runnerId, ...models });
    },
    helloWithAnthropicRoute(anthropicRoute?: string[]) {
      emit?.({
        type: 'hello',
        runnerId,
        ...(anthropicRoute === undefined ? {} : { anthropicRoute }),
      });
    },
    anthropicRouteEvent(anthropicRoute: string[]) {
      emit?.({ type: 'anthropic_route', runnerId, anthropicRoute });
    },
    helloWithCapabilities(capabilities: string[]) {
      emit?.({ type: 'hello', runnerId, capabilities });
    },
    enableUnpushedWork(result: UnpushedWorkResult | undefined) {
      state.unpushedWorkResult = result;
      (runner as { unpushedWork?: RunnerClient['unpushedWork'] }).unpushedWork = () =>
        Promise.resolve(state.unpushedWorkResult);
    },
    session(managerId: string, sessionId: string) {
      const session = state.alive.find((s) => s.managerId === managerId);
      if (session) session.sessionId = sessionId;
      emit?.({ type: 'session', managerId, sessionId });
    },
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
    settled(managerId: string, requestId: string, withdrawn?: { reason: string }) {
      const session = state.alive.find((s) => s.managerId === managerId);
      if (session) session.waiting = session.waiting.filter((w) => w.requestId !== requestId);
      emit?.({ type: 'settled', managerId, requestId, ...(withdrawn ? { withdrawn } : {}) });
    },
    // `fields` は固定値のスタブにしない: 渡さなければ4つとも省略され（`reportId` 無し＝旧 runner 相当）、
    // 他の試験の挙動が変わらないため。
    report(
      managerId: string,
      text: string,
      status: JobStatus = 'done',
      fields: {
        contentless?: true;
        failure?: { code: string; via: string };
        reportId?: string;
        unreported?: { reason: string };
      } = {},
    ) {
      emit?.({ type: 'report', managerId, text, status, ...fields });
    },
    usage(
      managerId: string,
      models: Record<string, UsageTotals>,
      sessionId?: string,
      answered?: boolean,
    ) {
      emit?.({
        type: 'usage',
        managerId,
        sessionId,
        models,
        ...(answered === undefined ? {} : { answered }),
      });
    },
    workerWait(managerId: string, fields: Omit<WorkerWaitEvent, 'type' | 'managerId'>) {
      emit?.({ type: 'worker_wait', managerId, ...fields });
    },
    closed(managerId: string, status: 'done' | 'lost' | 'failed', reason: string) {
      state.alive = state.alive.filter((s) => s.managerId !== managerId);
      emit?.({ type: 'closed', managerId, status, reason });
    },
    denied(
      managerId: string,
      tool: string,
      fields: {
        actor?: string;
        reasonType?: string;
        reason?: string;
        message?: string;
        inputHead?: string;
      } = {},
    ) {
      emit?.({
        type: 'permission_denied',
        managerId,
        toolUseId: `${tool}:test`,
        tool,
        input: {},
        via: 'live',
        ...fields,
      });
    },
    // `input` を省くと欄ごと落ちる: 本物と同じく `JSON.stringify` で落ちる形を再現するため。
    toolUse(managerId: string, actor: string, tool: string, input?: unknown) {
      emit?.({
        type: 'tool_use',
        managerId,
        actor,
        tool,
        ...(input === undefined ? {} : { input }),
      });
    },
    note(
      managerId: string,
      text: string,
      escalate?: true,
      stall?: Extract<RunnerEvent, { type: 'note' }>['stall'],
    ) {
      emit?.({
        type: 'note',
        managerId,
        text,
        ...(escalate === undefined ? {} : { escalate }),
        ...(stall === undefined ? {} : { stall }),
      });
    },
    resumeFailed(managerId: string, sessionId: string, reason: string, recovered: boolean) {
      emit?.({ type: 'resume_failed', managerId, sessionId, reason, recovered });
    },
    // `closed()` と違い `emit` を呼ばない: 畳んだ合図が届かず台帳が `attached: true` のまま残る窓を再現するため。
    vanish(managerId: string) {
      state.alive = state.alive.filter((s) => s.managerId !== managerId);
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

    fake.usage('mgr-spend', { opus: usage({ outputTokens: 250, costUsd: 3 }) }, 'sess-1');
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(3);

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
    // 基準を下げて引き算しない: resume で SDK 側の累積が 0 から始まるので、引くと記録済みの分が消える。
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

    // ゼロを数え直しとして採用しない: 次に届いた本物の $5 が丸ごと増分になるため。
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

    expect((await stores.usage.aggregate({})).since).toBeNull();

    fake.usage('mgr-spend', { opus: usage({ costUsd: 1 }) });
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(1);

    const aggregate = await stores.usage.aggregate({ from: '2020-01-01' });
    expect(aggregate.since).not.toBeNull();
    expect(aggregate.beforeLedger).toBe(true);
    expect(aggregate.notice).toContain('請求明細ではない');

    await s.pool.stop();
  });

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

    fake.usage('mgr-spend', { opus: usage({ costUsd: 1 }) }, 'sess-1');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const entries = await stores.journal.list({ types: ['turn_usage'] });
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

    fake.usage('mgr-spend', { opus: usage({ costUsd: 3 }) }, 'sess-1');
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(8);

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

  it('⚠️ 応答として返った usage（answered: true）が降りたら、成功の観測（succeeded: true）を回し手へも渡す', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const seen: TokenRotatorObservation[] = [];
    const s = setup(undefined, {
      stores,
      runner: fake.runner,
      tokenIdentity: () => ({ tokenId: 'tok-a', generation: 5 }),
      onUsageObservation: async (o) => {
        seen.push(o);
      },
    });
    await s.pool.restore();

    fake.usage('mgr-spend', { opus: usage({ costUsd: 1 }) }, 'sess-1', true);
    await expect.poll(() => seen.length, { timeout: 2000 }).toBeGreaterThan(0);

    // 枠の観測（`notice` / `facts` / `transition`）を混ぜない: `succeeded` の分岐が両方の意味を持つことになるため。
    expect(seen[0]).toEqual({
      succeeded: true,
      observedBy: { tokenId: 'tok-a', generation: 5 },
    });

    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(1);

    await s.pool.stop();
  });

  // 枠で落ちたターンを成功と読まない: usage の到着だけで成功を渡すと、recovered → 委譲 → また枠、を無限に往復するため。
  it.each([
    ['応答ではなかった（answered: false。枠で落ちた is_error のターン）', false],
    ['欄が無い（畳む直前の読み取り・版のずれた runner）', undefined],
  ])('🔴 %s usage は、成功の観測を回し手へ渡さない', async (_title, answered) => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const seen: TokenRotatorObservation[] = [];
    const s = setup(undefined, {
      stores,
      runner: fake.runner,
      tokenIdentity: () => ({ tokenId: 'tok-a', generation: 5 }),
      onUsageObservation: async (o) => {
        seen.push(o);
      },
    });
    await s.pool.restore();

    fake.usage('mgr-spend', { opus: usage({ costUsd: 1 }) }, 'sess-1', answered);

    // 積み終わるのを待ってから見る: 待たずに見ると処理前の空を測ることになり、歯が効かない。
    await expect.poll(() => totalCostUsd(stores), { timeout: 2000 }).toBe(1);
    expect(seen.filter((o) => o.succeeded === true)).toEqual([]);

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
    expect(entries[0]).not.toHaveProperty('sources');

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
    // 引き取りの契機をデーモンの起動時だけにしない: runner だけを再デプロイするとセッションは消えるのに台帳は `running` のままで、クローンが話しかけるまで止まるため。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    expect(fake.state.resumes).toHaveLength(1);

    fake.swap();

    await expect.poll(() => fake.state.resumes.length, { timeout: 2000 }).toBe(2);
    expect(fake.state.resumes[1]).toMatchObject({
      managerId: 'mgr-running',
      sessionId: 'sess-before-swap',
    });

    // 「デーモンが再起動した」と伝えない: 手元が残っている前提で書き始めるため。
    expect(fake.state.resumes[1]?.message).toContain('runner の器が作り直された');
    expect(fake.state.resumes[1]?.message).toContain('手元の状態を確かめよ');

    const notice = s.inbox.filter((event) => event.type === 'manager_message').at(-1);
    expect((notice as { text: string }).text).toContain('runner の器が作り直された');
    expect((notice as { text: string }).text).toContain('外へ保存していない作業は失われている');

    await s.pool.stop();
  });

  it('#resumeOnce の短絡: 取り直している最中に重なった2つ目の契機を busy で断る（Issue #203）', async () => {
    // `send()` を2本重ねない: 事前チェックが常に先に答え、`#resumeOnce` 自身の短絡が実行されないため。`send()` の事前チェックを経由しない `reattachRunner()` 経由の `#reattach` を重ねる。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);

    // 貸し出しを台帳へ書く1回目の `putJob` を止める。この間 `#resuming` には既に id が入っている（`#resumeOnce` はチェックと追加のあいだに await を挟まない）。
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

    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    const firstSend = s.pool.send(runningJob.id, '1つ目の指示');
    await expect.poll(() => putJobCalls, { timeout: 2000 }).toBe(1);

    // busy で断られたことは `reattachRunner()` の戻り値から見えない（`#reattach` は `outcome !== 'resumed'` を黙って `continue` する）ので、resume が増えなかったことで観測する。
    await s.pool.reattachRunner('runner-primary');
    expect(fake.state.resumes).toHaveLength(0);

    releasePutJob();
    const first = await firstSend;

    expect(first.outcome).toBe('delivered');
    expect(fake.state.resumes).toHaveLength(1);
    expect(fake.state.resumes[0]).toMatchObject({
      managerId: runningJob.id,
      sessionId: runningJob.sessionId,
    });

    await s.pool.stop();
  });

  it('返事待ちだったマネージャーの、死んだ確認を持ち越さない', async () => {
    // 持ち越さない: 新しい器はその request_id を知らず確認が永久に解けないので、以後の `manager_send` がすべて死んだ確認への回答として横取りされ、`answer` が false を返して握り潰される。
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, status: 'waiting_human' });
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
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

    expect((await s.pool.list()).find((m) => m.managerId === 'mgr-running')?.waiting).toEqual([]);

    const result = await s.pool.send('mgr-running', '続きをやって');
    expect(result.outcome).toBe('delivered');
    expect(fake.state.answers).toEqual([]);

    await s.pool.stop();
  });

  it('runner が名乗るたびに、実行環境プロファイルを降ろし直す', async () => {
    // 降ろし直しを省かない: runner は記憶ストアを読めず、省くと器を作り直した瞬間に鍵が消えて誰も気づけない。
    const stores = createMemoryStores();
    await stores.profile.set('default', 'export SOME_API_TOKEN=abc123', 'all');
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    // 名乗り任せにしない: 最初のマネージャーがプロファイルの届く前に走り出しうるため、委譲を始める前に降ろす。
    await s.pool.restore();
    await expect.poll(() => fake.state.profiles.length, { timeout: 2000 }).toBe(1);
    expect(fake.state.profiles[0]).toContain('SOME_API_TOKEN');

    fake.swap();
    await expect.poll(() => fake.state.profiles.length, { timeout: 2000 }).toBe(2);
    expect(fake.state.profiles[1]).toContain('SOME_API_TOKEN');
  });

  it('runner が名乗るたびに、マネージャーへ降ろす環境変数も降ろし直す', async () => {
    // 降ろし直しを省かない: runner は記憶ストアを読めず、Railway には volume が無いので runner 側の器（`/run/alteroid/credentials`）は器と一緒に消える。
    const stores = createMemoryStores();
    await stores.credentials.put([
      { name: 'GH_TOKEN', value: 'ghp_from_vault' },
      { name: 'GIT_AUTHOR_NAME', value: 'takecchi' },
    ]);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    await expect.poll(() => fake.state.credentialPushes.length, { timeout: 2000 }).toBe(1);
    expect(fake.state.held.get('GH_TOKEN')).toBe('ghp_from_vault');
    expect(fake.state.held.get('GIT_AUTHOR_NAME')).toBe('takecchi');

    fake.state.held.clear();
    fake.swap();
    await expect.poll(() => fake.state.credentialPushes.length, { timeout: 2000 }).toBe(2);
    expect(fake.state.held.get('GH_TOKEN')).toBe('ghp_from_vault');
  });

  it('正本もクローンの器の env も空なら、名乗ってきた runner へ1文字も降ろさない', async () => {
    // 配るものが無いときに「全部外せ」と言わない: 外す指示は `apply` が明示的に送る側の仕事で、名乗り直しの側では送らない。
    const stores = createMemoryStores();
    // プロファイルを置くのは同期のため: 鍵の降ろしはその直後に呼ばれるので、プロファイルが降りたのを見てから鍵を見れば「まだ降りていないだけ」を「降ろさなかった」と読まない。
    await stores.profile.set('default', 'export MARKER=1', 'all');
    const fake = swappableRunner();
    fake.state.held.set('GH_TOKEN', 'ghp_from_env');
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    await expect.poll(() => fake.state.profiles.length, { timeout: 2000 }).toBe(1);

    expect(fake.state.credentialPushes).toEqual([]);
    expect(fake.state.held.get('GH_TOKEN')).toBe('ghp_from_env');
  });

  it('provider を名乗る旧い runner の hello でも、能力の名乗りはそのまま受ける（provider の名乗りは読まない）', async () => {
    const fake = swappableRunner();
    const s = setup(undefined, { runner: fake.runner });
    await s.pool.restore();

    fake.helloFromLegacyProviderRunner(['awaiting-background-signal']);
    await expect
      .poll(() => s.pool.runnerHasCapability?.('runner-primary', 'awaiting-background-signal'))
      .toBe(true);
    expect(s.pool).not.toHaveProperty('runnerManagerProvider');
    expect(s.pool).not.toHaveProperty('runnerReportedManagerProvider');
  });

  it('hello のモデルの名乗りを保持し、欄なしの hello では持ち越さず不明を返す（#3921）', async () => {
    const fake = swappableRunner();
    const s = setup(undefined, { runner: fake.runner });
    await s.pool.restore();

    fake.helloWithModels({ managerModel: 'opus', workerModel: 'sonnet' });
    await expect
      .poll(() => s.pool.runnerReportedModels?.('runner-primary'))
      .toEqual({ manager: 'opus', worker: 'sonnet' });
    fake.helloWithModels({ workerModel: 'haiku' });
    await expect
      .poll(() => s.pool.runnerReportedModels?.('runner-primary'))
      .toEqual({ worker: 'haiku' });
    fake.helloWithModels({});
    await expect.poll(() => s.pool.runnerReportedModels?.('runner-primary')).toBeUndefined();
    expect(s.pool.runnerReportedModels?.('runner-never')).toBeUndefined();
  });

  it('hello と anthropic_route の接続先の名乗りを保持し、欄なしの hello では持ち越さない（#4263・#4261）', async () => {
    const fake = swappableRunner();
    const s = setup(undefined, { runner: fake.runner });
    await s.pool.restore();

    fake.helloWithAnthropicRoute(['ANTHROPIC_MODEL=m（出所: 器）']);
    await expect
      .poll(() => s.pool.runnerReportedAnthropicRoute?.('runner-primary'))
      .toEqual(['ANTHROPIC_MODEL=m（出所: 器）']);
    fake.anthropicRouteEvent([]);
    await expect.poll(() => s.pool.runnerReportedAnthropicRoute?.('runner-primary')).toEqual([]);
    fake.anthropicRouteEvent(['a', 'b']);
    await expect
      .poll(() => s.pool.runnerReportedAnthropicRoute?.('runner-primary'))
      .toEqual(['a', 'b']);
    fake.helloWithAnthropicRoute();
    await expect
      .poll(() => s.pool.runnerReportedAnthropicRoute?.('runner-primary'))
      .toBeUndefined();
    expect(s.pool.runnerReportedAnthropicRoute?.('runner-never')).toBeUndefined();
  });

  it('取り直しの最中に起こされた委譲を、死んだものとして起こし直さない', async () => {
    // runner を先に読まない: その隙間で起こされた委譲が「runner に居ないのに台帳には居る」と見え、走り出したばかりの仕事を二本にする。台帳を先に読めば、隙間で生まれた仕事は手元の一覧に入らない。
    const stores = createMemoryStores();
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    fake.runner.list = async () => {
      fake.state.listCalls += 1;
      if (!first) return [...fake.state.alive];
      first = false;
      // 止まっている間に起きたことは応答に映らない（本物の HTTP 応答も投げた時点の景色を返す）。
      const before = [...fake.state.alive];
      await gate;
      return before;
    };
    fake.runner.start = async (command) => {
      fake.state.alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
      });
      return {};
    };

    fake.reconnect();
    await expect.poll(() => fake.state.listCalls, { timeout: 2000 }).toBeGreaterThan(0);

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
    // 生死は台帳ではなく runner に聞く: `hello` だけで再開させると、ネットワークが一瞬途切れるたびに同じ仕事が二本走る。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    expect(fake.state.resumes).toHaveLength(1);

    const before = fake.state.listCalls;
    fake.reconnect();

    // 聞きに行ったことも見る: resume の本数だけだと、機構が存在しなくても・例外で死んでいても緑になる。
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

    expect((await s.pool.list()).find((m) => m.managerId === 'mgr-done')?.status).toBe('done');

    await s.pool.stop();
  });

  it('台帳にしか無い終わった仕事の live は、reattach の巻き添えで変わらない', async () => {
    // 「`#records` に無いなら常に `live: false`」と決め打たない: `#retire` で外れた done / failed の委譲の `live: true` が読めなくなるため、`isLive()`（`job.sessionId` だけで決まる）で計算する。
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-finished', status: 'done' });
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

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
    // `list()` の失敗を「セッションが無い」と読まない: 生きている仕事を二重に起こすため。分からないときは触らない。
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

    // 聞きに行ったことも見る: `#reattach` に入らないまま緑になるのを防ぐ。
    await expect.poll(() => asked, { timeout: 2000 }).toBe(1);
    expect(fake.state.resumes).toHaveLength(1);

    await s.pool.stop();
  });

  it('起動時に掴んだ器と、名乗ってきた器が違っても取り直す', async () => {
    // 最初の名乗りを「初回だから」と素通りさせない: 畳まれつつある旧 runner は猶予（`drainingSeconds`）の間 `/health` と `/managers` に答え続けるので、「生きている」と判断した直後に SSE が新しい器へ繋がる順序が普通に起きる。
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

    const restored = await s.pool.restore();
    expect(restored.map((m) => m.managerId)).toEqual(['mgr-running']);
    expect(fake.state.resumes).toHaveLength(0);

    fake.swap();

    await expect.poll(() => fake.state.resumes.length, { timeout: 2000 }).toBe(1);
    expect(fake.state.resumes[0]?.message).toContain('runner の器が作り直された');

    await s.pool.stop();
  });

  it('取り直しの最中に届いた名乗りを取りこぼさない', async () => {
    // 走行中だからと2つ目の名乗りを捨てない: その入れ替えが誰にも見られないまま終わるため。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    expect(fake.state.resumes).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));

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

    fake.swap();
    release();

    await expect.poll(() => fake.state.resumes.length, { timeout: 2000 }).toBe(2);

    await s.pool.stop();
  });

  it('resume が一時的にこけても、次の名乗りを待たずに自分で戻す', async () => {
    // 「次の名乗りでまた挑む」形にしない: `hello` は SSE が繋がったときにしか来ないので、resume だけが一時的にこけると永久に挑まれず、台帳が `running` のまま誰も走っていない仕事が残る。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    expect(fake.state.resumes).toHaveLength(1);

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
    // 生死確認で黙って引き下がらない: SSE は安定していて次の名乗りは来ないので、台帳は `running` のままセッションが不在になる恒久停止が残る。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    expect(fake.state.resumes).toHaveLength(1);

    let asked = 0;
    fake.runner.list = async () => {
      asked += 1;
      if (asked === 1) throw new RunnerHttpError('runner GET /managers が失敗した (503)', 503);
      return [...fake.state.alive];
    };

    fake.swap();

    await expect.poll(() => asked, { timeout: 2000 }).toBe(1);
    expect(fake.state.resumes).toHaveLength(1);

    await expect.poll(() => fake.state.resumes.length, { timeout: 5000 }).toBe(2);
    expect(fake.state.resumes[1]).toMatchObject({ managerId: 'mgr-running' });

    await s.pool.stop();
  });

  it('台帳を引けなかったときも、次の名乗りを待たずに引き直す', async () => {
    // ここだけ「黙って終わる」にしない: 同じ恒久停止が別の段階に残るため。
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
    // 黙って `running` のまま置くのでも回し続けるのでもなく、見えるようにする: 400 は同じものを投げ直しても同じ答えが返るため。
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob);
    const fake = swappableRunner();
    const s = setup(undefined, {
      stores,
      runner: fake.runner,
      synthesizedNoticeWindowMs: TEST_NOTICE_WINDOW_MS,
    });

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
        { timeout: 4000 },
      )
      .toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(attempts).toBe(1);

    await s.pool.stop();
  });

  it('諦めたジョブは、同じ runner の別ジョブの再試行に巻き込まれない', async () => {
    // 諦めの判定をジョブ側に覚える: 予約は runner 単位なので、覚えないと一時障害のジョブが1本あるだけで、4xx で「挑み直さない」と決めたジョブが毎回巻き込まれ、無意味な resume と同じ障害通知が積み上がる。
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

    await expect.poll(() => tries.flaky, { timeout: 8000 }).toBe(3);
    await expect
      .poll(() => fake.state.resumes.some((r) => r.managerId === 'mgr-flaky'), { timeout: 8000 })
      .toBe(true);

    expect(tries.broken).toBe(1);

    // 人間とクローンの明示的な経路は塞がない: 諦めたのは自動の取り直しだけ。
    await expect(s.pool.send('mgr-broken', 'やり直して')).rejects.toThrow('400');
    expect(tries.broken).toBe(2);

    await s.pool.stop();

    // 通知は止めた後に数える: 合流窓（既定 3000ms）へ積まれるので、梯子の終わりで数えると 0 件にも 1 件にもなりうる。`stop()` は窓に積んだ知らせを同期的に配り切る（`#flushSynthesizedNotices`）。
    const notices = s.inbox.filter(
      (event) =>
        event.type === 'manager_message' &&
        (event as { managerId: string }).managerId === 'mgr-broken' &&
        (event as { text: string }).text.includes('戻せなかった'),
    );
    expect(notices).toHaveLength(1);
  });

  it('別の runner のジョブには手を出さない（M5 で runner が増えても混ざらない）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, id: 'mgr-elsewhere', runnerId: 'runner-second' });
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    fake.swap();

    await expect.poll(() => fake.state.listCalls, { timeout: 2000 }).toBeGreaterThan(1);
    expect(fake.state.resumes).toHaveLength(0);

    await s.pool.stop();
  });
});

/**
 * resume を SDK 側に拒まれる runner。失敗は `POST /managers/:id/resume` の応答としては返らず、受理された後に開いたストリームから落ちてくる。
 */
function resumeRejectingSdk(
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
    reuse?: Stores,
    synthesizedNoticeWindowMs?: number,
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
      ...(synthesizedNoticeWindowMs === undefined ? {} : { synthesizedNoticeWindowMs }),
    });
    return { pool, stores, inbox, opened };
  }

  it('session_id で戻れなくても、預かった生ログから続きを起こす', async () => {
    // 黙って引き下がらない: session_id が腐っていても生ログはデーモンが預かっているので、そこから組み立て直せる。
    const s = setupRejecting(savedLog, 'no-conversation', undefined, TEST_NOTICE_WINDOW_MS);
    await s.stores.jobs.putJob(runningJob);

    await s.pool.restore();

    await expect.poll(() => s.opened.length, { timeout: 2000 }).toBe(2);
    expect(s.opened[0]?.resume).toBe('sess-before-restart');
    expect(s.opened[1]?.resume).toBeUndefined();

    await expect
      .poll(() => (s.opened[1]?.inputs ?? []).join('\n'), { timeout: 2000 })
      .toContain('スキーマまで書いた');
    expect((s.opened[1]?.inputs ?? []).join('\n')).toContain('DB の移行をやって');

    // `#notifyResumeFallback` は合流窓（既定3000ms）に積まれるので、直接の `.find()` ではなく `expect.poll` で待つ。
    await expect
      .poll(
        () =>
          s.inbox.find(
            (event) => event.type === 'manager_message' && event.text.includes('生ログ'),
          ),
        { timeout: 4000 },
      )
      .toBeDefined();

    await s.pool.stop();
  });

  it('#252: 依頼文・直近の報告が巨大でも、生ログからの知らせは全文を埋め込まない', async () => {
    // 末尾だけに現れる一意な目印を混ぜる: 同じ語の繰り返しだと、抜粋が残す先頭部分にも末尾と同じ文字列が偶然含まれ、先頭一致と区別できなくなる。
    const hugeRequest = 'これは巨大な依頼文である。'.repeat(300) + REQUEST_TAIL_MARKER;
    const hugeReport = 'これは巨大な直近の報告である。'.repeat(300) + REPORT_TAIL_MARKER;
    const s = setupRejecting(savedLog, 'no-conversation', undefined, TEST_NOTICE_WINDOW_MS);
    await s.stores.jobs.putJob({ ...runningJob, request: hugeRequest, lastReport: hugeReport });

    await s.pool.restore();

    await expect
      .poll(
        () =>
          s.inbox.find(
            (event) => event.type === 'manager_message' && event.text.includes('生ログ'),
          ),
        { timeout: 4000 },
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
    // 黙って挑み続けない: 同じ session_id の resume が繰り返されると、同じ障害通知が受信箱に積み上がるだけで、誰も状況を知れないまま台帳の `running` が残る。
    const s = setupRejecting(null, 'no-conversation', undefined, TEST_NOTICE_WINDOW_MS);
    await s.stores.jobs.putJob(runningJob);

    await s.pool.restore();

    await expect
      .poll(
        () =>
          s.inbox.find(
            (event) => event.type === 'manager_message' && event.text.includes('戻せなかった'),
          ),
        { timeout: 4000 },
      )
      .toBeDefined();
    const notice = s.inbox.find(
      (event) => event.type === 'manager_message' && event.text.includes('戻せなかった'),
    ) as { text: string };
    expect(notice.text).toContain('自動では再試行しない');
    expect(notice.text).not.toContain('DB の移行をやって');
    expect(notice.text).toContain('manager_report managerId=mgr-lost');

    expect(s.opened.filter((entry) => entry.resume === undefined)).toHaveLength(0);

    await s.pool.stop();
  });

  it('#252: 依頼文・直近の報告が巨大でも、戻せなかった知らせは全文を埋め込まない', async () => {
    // 末尾だけに現れる一意な目印を混ぜる: 同じ語の繰り返しだと、抜粋が残す先頭部分にも末尾と同じ文字列が偶然含まれ、先頭一致と区別できなくなる。
    const hugeRequest = 'これは巨大な依頼文である。'.repeat(300) + REQUEST_TAIL_MARKER;
    const hugeReport = 'これは巨大な直近の報告である。'.repeat(300) + REPORT_TAIL_MARKER;
    const s = setupRejecting(null, 'no-conversation', undefined, TEST_NOTICE_WINDOW_MS);
    await s.stores.jobs.putJob({ ...runningJob, request: hugeRequest, lastReport: hugeReport });

    await s.pool.restore();

    await expect
      .poll(
        () =>
          s.inbox.find(
            (event) => event.type === 'manager_message' && event.text.includes('戻せなかった'),
          ),
        { timeout: 4000 },
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

  // 「戻せなかった」を「成果が無い」と言い換えない: デーモンが観測したのは resume の失敗だけで、知らせが「起こし直せ」で終わると済んだ仕事をもう一度走らせる。
  it('戻せなかった知らせは、成果の有無を断定せずリモートを確かめさせる', async () => {
    const s = setupRejecting(null, 'no-conversation', undefined, TEST_NOTICE_WINDOW_MS);
    await s.stores.jobs.putJob(runningJob);

    await s.pool.restore();

    await expect
      .poll(
        () =>
          s.inbox.find(
            (event) => event.type === 'manager_message' && event.text.includes('戻せなかった'),
          ),
        { timeout: 4000 },
      )
      .toBeDefined();
    const notice = s.inbox.find(
      (event) => event.type === 'manager_message' && event.text.includes('戻せなかった'),
    ) as { text: string };

    expect(notice.text).toContain('「仕事が終わっていない」ことの証拠ではない');
    expect(notice.text).toMatch(/リモート|PR/);
    expect(notice.text).toContain('起こし直す前に');

    await s.pool.stop();
  });

  it('開きはしたが結果なしで終わった resume も、戻れなかったものとして扱う', async () => {
    // `init` が来たことを「戻れた」と読まない: 開いただけで何も返せていないなら、続きは進まない。
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
    // 「落ちたら作り直す」に広げない: コミットや PR を出した後の失敗で同じ作業を記録から二度走らせるため。resume の失敗として扱うのはセッションがまだ何もしていないときだけ。
    const s = setupRejecting(savedLog, 'after-work', undefined, TEST_NOTICE_WINDOW_MS);
    await s.stores.jobs.putJob(runningJob);

    await s.pool.restore();

    await expect
      .poll(
        () =>
          s.inbox.find(
            (event) => event.type === 'manager_message' && event.text.includes('落ちた'),
          ),
        { timeout: 4000 },
      )
      .toBeDefined();
    expect(s.opened.filter((entry) => entry.resume === undefined)).toHaveLength(0);

    await s.pool.stop();
  });

  it('打ち切ったマネージャーは、デーモンを作り直しても二度と resume されない', async () => {
    // 「もう戻せない」をプロセス内の記憶（`#unresumable`）にだけ置かない: 器を作り直すと消え、台帳の `done`（待機中）だけが残って、腐った session_id へ毎回話しかけ、失われた仕事が完了として片付く。
    const first = setupRejecting(null, 'error-result', undefined, TEST_NOTICE_WINDOW_MS);
    await first.stores.jobs.putJob(runningJob);

    await first.pool.restore();
    await expect
      .poll(
        () =>
          first.inbox.find(
            (event) => event.type === 'manager_message' && event.text.includes('戻せなかった'),
          ),
        { timeout: 4000 },
      )
      .toBeDefined();
    await first.pool.stop();

    const stored = (await first.stores.jobs.listJobs()).find((job) => job.id === 'mgr-lost');
    expect(stored?.status).toBe('lost');

    const second = setupRejecting(null, 'error-result', first.stores);

    expect(await second.pool.restore()).toEqual([]);
    expect(second.opened).toHaveLength(0);
    const listed = (await second.pool.list()).find((m) => m.managerId === 'mgr-lost');
    expect(listed).toMatchObject({ status: 'lost', live: false });

    // `restore()` の直後には測らない: 知らせは合流窓（既定 3000ms）へ積まれ、直後に見た `[]` は何も測らない。`stop()` は窓に積んだ知らせを同期的に配り切る（`#flushSynthesizedNotices`）ので、止めた後に見る。
    await second.pool.stop();
    expect(second.inbox.filter((event) => event.type === 'manager_message')).toEqual([]);
  });

  it('送信に失敗した直後の一覧が、lost を live: true へ格上げしない', async () => {
    // 像を `list()` が既定の `live: true` で見せない: `send()` は宛先を `#load()` で像へ載せてから resume を投げるので、失敗しても像は残り、`status: lost` と `live: true` という両立しない組が出る。
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, status: 'lost' });
    const fake = swappableRunner('runner-test');
    let attempted = 0;
    fake.runner.resume = async () => {
      attempted += 1;
      throw new Error('runner POST /managers/mgr-lost/resume が失敗した (400)');
    };
    const s = setup(undefined, { stores, runner: fake.runner });

    expect((await s.pool.list()).find((m) => m.managerId === 'mgr-lost')).toMatchObject({
      status: 'lost',
      live: false,
    });

    await expect(s.pool.send('mgr-lost', '続きをやって')).rejects.toThrow();
    // resume まで届いたうえで失敗したことを固定する: 見ないと send() が別の理由で早々に落ちても緑になる。
    expect(attempted).toBe(1);

    const listed = (await s.pool.list()).find((m) => m.managerId === 'mgr-lost');
    expect(listed).toMatchObject({ status: 'lost', live: false });

    await s.pool.stop();
  });

  it('resume の失敗が後から降ってきても、一覧は lost を live: true で見せない', async () => {
    // `#load()` を直すだけでは塞がらない: `resume_failed` は受理された後に SSE で降りてくるので、像は既に `#records` に居る。
    const s = setupRejecting(null, 'error-result', undefined, TEST_NOTICE_WINDOW_MS);
    await s.stores.jobs.putJob(runningJob);

    await s.pool.restore();
    await expect
      .poll(
        () =>
          s.inbox.find(
            (event) => event.type === 'manager_message' && event.text.includes('戻せなかった'),
          ),
        { timeout: 4000 },
      )
      .toBeDefined();

    const listed = (await s.pool.list()).find((m) => m.managerId === 'mgr-lost');
    expect(listed).toMatchObject({ status: 'lost', live: false });

    await s.pool.stop();
  });
});

// `result` だけを報告にしない: ターンの本文は道具を挟むたびに切れ、`result` は最後の一片でしかないので、クローンには末尾だけが届き、欠けていることが誰にも見えない。
describe('マネージャーの報告を黙って落とさない', () => {
  it('道具で分断された本文も、6つ出したなら6つとも届く', async () => {
    const s = setup();
    await s.pool.start({ request: '6セクションで報告して' });
    const session = s.sessions[0] as FakeSession;

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
    // `restore()` を省かない: `swappableRunner#connect` は `#ensureConnected` が呼ぶまで `emit` を持たず、省くと `fake.report(...)` が無言で no-op になる。
    await s.pool.restore();
    // `restore()` の知らせ（`#notifyRestored`）が届くのを待つ: 待たずに `before` を取ると、知らせが後から紛れ込んで冪等化の歯を汚す。
    await vi.waitFor(() => {
      if (s.inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
    });
    return { s, fake };
  }

  /** 一覧は写し忘れうるので、台帳の1件を直接読む。 */
  async function jobOf(s: Setup, managerId: string) {
    return (await s.stores.jobs.listJobs()).find((entry) => entry.id === managerId);
  }

  it('同じ reportId の report が二度届いても、受信箱には一度しか積まれない', async () => {
    const { s, fake } = await running();
    const before = s.inbox.length;
    const journalBefore = (await s.stores.journal.list({ types: ['exchange'] })).length;

    fake.report(job.id, '1回目の届け', 'done', { reportId: 'rep-dup-1' });
    fake.report(job.id, '1回目の届け（再送）', 'done', { reportId: 'rep-dup-1' });

    await vi.waitFor(async () => {
      const current = await jobOf(s, job.id);
      if (current?.lastReport !== '1回目の届け') throw new Error('台帳がまだ更新されていない');
    });
    // fire-and-forget なので即座には判定できない: 再送のぶんが後から紛れ込まないよう、待ち切ってから数える。
    await new Promise((resolve) => setTimeout(resolve, 20));

    // `before` から後ろだけを見る: `restore()` 自身の知らせが `kind: 'report'` で1件積まれているため。
    const reports = s.inbox
      .filter((event) => event.type === 'manager_message' && event.kind === 'report')
      .slice(before);
    expect(reports).toHaveLength(1);
    expect((reports[0] as { text: string }).text).toBe('1回目の届け');

    const current = await jobOf(s, job.id);
    expect(current?.lastReport).toBe('1回目の届け');

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

    // 旧 runner はこの欄を送らない: 冪等化を諦めるのであって、拒んで捨てることはしない。
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

// 古い `lastFoldedTurn` を残さない: 止めた委譲を再開して報告し始めた後も古い畳んだ本文が居座り、`manager_report` / `manager_list` の見出しを誤らせるため。
describe('lastFoldedTurn は応答として終わった回では下ろす（Issue #1038）', () => {
  const job = {
    id: 'mgr-folded-then-resumed',
    managerId: 'mgr-folded-then-resumed',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: 'sess-folded-then-resumed',
    runnerId: 'runner-primary',
    lastFoldedTurn: { text: '前回止めたときの畳まれた本文', at: '2026-08-01T00:30:00.000Z' },
  };

  it('通常の report が届くと、古い lastFoldedTurn は台帳から下ろされる', async () => {
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
    await s.pool.restore();
    await vi.waitFor(() => {
      if (s.inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
    });

    fake.report(job.id, '再開後の正常な報告', 'done');

    await vi.waitFor(async () => {
      const current = (await s.stores.jobs.listJobs()).find((j) => j.id === job.id);
      if (current?.lastReport !== '再開後の正常な報告')
        throw new Error('台帳がまだ更新されていない');
    });

    const current = (await s.stores.jobs.listJobs()).find((j) => j.id === job.id);
    expect(current?.lastFoldedTurn).toBeUndefined();
    expect(Object.hasOwn(current as object, 'lastFoldedTurn')).toBe(false);
    expect(current?.lastReportStatus).toBe('done');

    await s.pool.stop();
  });
});

// `RecentMap` 単体の歯では `#reportedOf` 自身の配線の誤り（並びの取り違え・逆順）を捕まえないので、日誌に書かれた本文から id を抜いて測る。`RecentMap.set()` は1回で高々+1しか増やさず `onForget` の配列長は常に1なので、`…ほか N件省略` の分岐（`rest > 0`）はこの経路では到達せず、`renderListing` の向きの変異は検出できない。
describe('#reportedOf: 忘れた id は古い側から日誌に出る（#409）', () => {
  const job = {
    id: 'mgr-report-oldest-first',
    managerId: 'mgr-report-oldest-first',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: 'sess-report-oldest-first',
    runnerId: 'runner-primary',
  };

  it('上限を超えたぶん、日誌に書かれる「忘れた」id は挿入順どおり最も古いものから出る', async () => {
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
    // `#reportedOf` の記憶は record に載るので、`restore()` で `#records` に載せておく。
    await s.pool.restore();
    await vi.waitFor(() => {
      if (s.inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
    });

    // `order: 'asc'` を明示する: 既定は `desc` なので、そのまま `slice(journalBefore)` すると後から積んだ分を取り出せない。
    const journalBefore = (await s.stores.journal.list({ types: ['exchange'], order: 'asc' }))
      .length;

    // `REPORTED_MEMORY_LIMIT`（manager.ts の非公開定数）の手複製: 本体を変えたらここも直す。ずれると「まだ埋まっていない」側に倒れて green のまま何も測らなくなる。
    const LIMIT = 512;
    const EXTRA = 5;

    // await せず同期のループで流す: `#onEvent` は record が `#records` に居れば `.set()` に至るまで await を挟まないので、呼ぶ順序どおりに `.set()` が実行される。
    for (let i = 0; i < LIMIT + EXTRA; i += 1) {
      fake.report(job.id, `report-body-${i}`, 'done', { reportId: `rep-${i}` });
    }

    const forgetEntries = await vi.waitFor(async () => {
      const all = await s.stores.journal.list({ types: ['exchange'], order: 'asc' });
      const found = all
        .slice(journalBefore)
        .filter(
          (entry): entry is Extract<JournalEntry, { type: 'exchange' }> =>
            entry.type === 'exchange' && entry.text.includes('処理済みの報告の記憶が上限'),
        );
      if (found.length < EXTRA) throw new Error(`まだ ${EXTRA} 件ぶん届いていない`);
      return found;
    });

    expect(forgetEntries).toHaveLength(EXTRA);

    const texts = forgetEntries.map((entry) => entry.text);
    for (let i = 0; i < EXTRA; i += 1) {
      expect(texts[i]).toContain(`古い 1 件を忘れた: rep-${i}。`);
    }

    const joined = texts.join('\n');
    for (let i = LIMIT; i < LIMIT + EXTRA; i += 1) {
      expect(joined).not.toContain(`忘れた: rep-${i}。`);
    }

    await s.pool.stop();
  });
});

describe('#flushUnreported の印が manager_list / manager_report の見出しに届く（#917）', () => {
  const job = {
    id: 'mgr-unreported-cross',
    managerId: 'mgr-unreported-cross',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: 'sess-unreported-cross',
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
    await s.pool.restore();
    await vi.waitFor(() => {
      if (s.inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
    });
    return { s, fake };
  }

  it('unreported が在る report では、見出しが「直近のターンの中身」へ倒れる（落ちるべきものが落ちる）', async () => {
    const { s, fake } = await running();

    // `failure` は付けない: 名乗れないものを名乗らないのが runner.ts の `#flushUnreported` の形で、変えると歯が効かなくなるため。
    fake.report(
      job.id,
      '（このターンは結果を受け取らないまま畳まれた: デーモンから停止を指示された。）\n' +
        '（以下は畳まれる前にマネージャーが書いていた本文である。ターンの途中の発言が' +
        '混ざっていることがある）\n\n途中まで調べた内容',
      'running',
      { unreported: { reason: 'デーモンから停止を指示された。' } },
    );

    await vi.waitFor(async () => {
      const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
      if (listed?.lastReport === undefined) throw new Error('報告がまだ台帳に届いていない');
    });

    const tools = createCloneTools({
      stores: s.stores,
      emit: () => undefined,
      managers: s.pool,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const list = tools.find((entry) => entry.name === 'manager_list');
    const report = tools.find((entry) => entry.name === 'manager_report');
    if (!list || !report) throw new Error('manager_list / manager_report が無い');

    const listResult = await list.handler({} as never, {});
    const listText = (listResult.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(listText).toContain('直近のターンの中身');
    expect(listText).not.toContain('直近の報告');

    const reportResult = await report.handler({ managerId: job.id } as never, {});
    const reportText = (reportResult.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(reportText).toContain('直近のターンの中身');
    expect(reportText).not.toContain('直近の報告');

    await s.pool.stop();
  });

  it('unreported も failure も無い、普通に完了した report では見出しは「直近の報告」のまま', async () => {
    const { s, fake } = await running();

    fake.report(job.id, '普通に完遂した報告の本文', 'done');

    await vi.waitFor(async () => {
      const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
      if (listed?.lastReport === undefined) throw new Error('報告がまだ台帳に届いていない');
    });

    const tools = createCloneTools({
      stores: s.stores,
      emit: () => undefined,
      managers: s.pool,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const list = tools.find((entry) => entry.name === 'manager_list');
    const report = tools.find((entry) => entry.name === 'manager_report');
    if (!list || !report) throw new Error('manager_list / manager_report が無い');

    const listResult = await list.handler({} as never, {});
    const listText = (listResult.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(listText).toContain('直近の報告');
    expect(listText).not.toContain('直近のターンの中身');

    const reportResult = await report.handler({ managerId: job.id } as never, {});
    const reportText = (reportResult.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(reportText).toContain('直近の報告');
    expect(reportText).not.toContain('直近のターンの中身');

    await s.pool.stop();
  });
});

// 受理だけで「止まった」と言わない: `runner.stop()` は該当セッションが無いと黙って何もしないので、runner の一覧から消えたことまで見る。
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
    const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(listed?.status).toBe('stopped');
    expect(listed?.live).toBe(false);

    await s.pool.stop();
  });

  // 1本にまとめない: outcome の変異と台帳ガードの変異が同じ1本を落とし、どちらの保証が壊れたか見分けられなくなるため。
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

    expect(result.outcome).toBe('not_stopped');
    expect(result.sessionGone).toBe(false);
    expect(result.detail).toContain('止まっていない');

    await s.pool.stop();
  });

  it('セッションが残っていたら、台帳を1文字も書かない', async () => {
    const { s } = await abortWithLiveSession();

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

  // 次の「人間が止めたときは…」と対で置く: 片方だけだと `#post` をまるごと消す変異が素通りするため。
  it('クローンが manager_stop で止めても、manager_message は配らない（post 0件）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.abort(job.id, '報告は出たのに終わらない', 'clone');

    expect(s.inbox.filter((event) => event.type === 'manager_message')).toHaveLength(0);

    await s.pool.stop();
  });

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

  // `stopped` 以外の枝にも置く: `stopped` の枝だけ見ると、`not_stopped` / `unknown` にだけ無条件 `#post` を残す変異が通るため。
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
    // `restore()` 自体が通知を配ることがある: 数えたいのは `abort()` のぶんだけなので、`restore()` の後で基準を取る。
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

  // `outcome: 'stopped'` にする: そうしないと `reason` が `messageText` へ埋め込まれず、markup の歯が効かないため。
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

  it('クローンが reason 付きで止めても manager_message は配られない（markup を問うまでもない。by === "clone"）', async () => {
    const s = await stoppableSetup();

    await s.pool.abort(job.id, '報告は出たのに終わらない', 'clone');

    const stopped = findStopMessage(s.inbox, '報告は出たのに終わらない');
    expect(stopped).toBeUndefined();

    await s.pool.stop();
  });

  it('人間が reason 無しで止めても markup は立たない（reason === undefined）', async () => {
    const s = await stoppableSetup();

    await s.pool.abort(job.id);

    const stopped = findStopMessage(s.inbox, '停止させました');
    expect(stopped).toBeDefined();
    expect(stopped?.markup).toBeUndefined();

    await s.pool.stop();
  });

  // 本文に reason が入っていないことまで見る: markup が立たないことだけだと、reason が入っているのに印だけ落ちた場合と区別できないため。
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
    expect(notStopped?.text).not.toContain('*思いつきで* 止めた');
    expect(notStopped?.markup).toBeUndefined();

    await s.pool.stop();
  });

  it('居ないマネージャーを止めても、黙って成功にしない', async () => {
    const s = setup(undefined, { stores: createMemoryStores(), runner: swappableRunner().runner });

    const result = await s.pool.abort('mgr-nope');

    expect(result.outcome).toBe('absent');
    expect(result.detail).toContain('mgr-nope');

    await s.pool.stop();
  });

  // 3本に割る: 日誌に残す保証は outcome にも台帳ガードにも依存しない独立の保証で、まとめると変異がどの保証を壊したか見えなくなるため。
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

    const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(listed?.status).toBe('running');

    await s.pool.stop();
  });

  // RPC の不明を止まった事実より優先しない: stop の RPC が返らなくても実際に止まっていることがあるので、権威は `sessionGone` に置く。
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

  // 跡に本文（鍵）を載せない: stderr へ漏れるため。
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

  // 上限で抜けても失敗させない: 日誌に書かれない変異のもとで保証2のテストまで落ちると、日誌に残る保証との分離が崩れるため。
  // 固定の実時間待ちにしない: 混んだ CI で処理が終わる前に抜け、ガードを外す変異が黙って通るため。
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

  // 2本に割る: 1本にまとめると、ガードを外す変異と日誌呼び出しを消す変異が同じ1本を落とし、どちらの保証が壊れたか見分けられないため。
  it('report イベントは日誌には残る（捨てない）', async () => {
    const { s, fake } = await stopped();

    fake.report(job.id, '止めたはずなのに報告してきた', 'done');

    await journalHas(s, '止めたはずなのに報告してきた', ['exchange']);

    await s.pool.stop();
  });

  it('report イベントはクローンへは回らず、status も動かない', async () => {
    const { s, fake } = await stopped();
    const postedBefore = s.inbox.length;

    fake.report(job.id, '止めたはずなのに報告してきた', 'done');
    await settleAfterJournal(s, '止めたはずなのに報告してきた', ['exchange']);

    expect(s.inbox.length).toBe(postedBefore);
    const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(listed?.status).toBe('stopped');

    await s.pool.stop();
  });

  // (b)(c) を併記する: `lastFoldedTurn` だけ書いて stopped 維持と inbox 不達を無視する変異を通さないため。
  it('report イベントは status===stopped でも、畳んだ本文を lastFoldedTurn へ台帳ごと残す（Issue #1038）', async () => {
    const { s, fake } = await stopped();
    const postedBefore = s.inbox.length;

    fake.report(job.id, '止めたはずなのに報告してきた（畳まれた本文）', 'done');
    await settleAfterJournal(s, '止めたはずなのに報告してきた（畳まれた本文）', ['exchange']);

    const listed = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(listed?.lastFoldedTurn?.text).toBe('止めたはずなのに報告してきた（畳まれた本文）');
    expect(typeof listed?.lastFoldedTurn?.at).toBe('string');
    const persistedJobs = await s.stores.jobs.listJobs();
    const persisted = persistedJobs.find((j) => j.id === job.id);
    expect(
      persisted?.lastFoldedTurn?.text,
      '#persist されていること（像だけでなく永続化先にも載っている）',
    ).toBe('止めたはずなのに報告してきた（畳まれた本文）');

    expect(listed?.status).toBe('stopped');
    expect(s.inbox.length).toBe(postedBefore);

    await s.pool.stop();
  });

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

  it('settled イベント（withdrawn 付き）は日誌には残る（捨てない）', async () => {
    const { s, fake } = await stopped();

    fake.settled(job.id, 'req-after-stop', {
      reason: '止めたはずなのに畳まれたと言ってきた',
    });

    await journalHas(s, '止めたはずなのに畳まれたと言ってきた', ['escalation']);

    const escalations = (await s.stores.journal.list({ types: ['escalation'] })) as {
      approvalId?: string;
      managerId?: string;
      withdrawnAt?: string;
      withdrawnReason?: string;
    }[];
    const entry = escalations.find((e) => e.approvalId === 'req-after-stop');
    expect(entry?.managerId).toBe(job.id);
    expect(typeof entry?.withdrawnAt).toBe('string');
    expect(entry?.withdrawnReason).toContain('CLI へ');
    expect(entry?.withdrawnReason).toContain('止めたはずなのに畳まれたと言ってきた');

    await s.pool.stop();
  });

  it('settled イベント（withdrawn 付き）はクローンへは回らず、status も waiting も動かない', async () => {
    const { s, fake } = await stopped();
    const postedBefore = s.inbox.length;

    fake.settled(job.id, 'req-after-stop-2', {
      reason: '止めたはずなのに畳まれたと言ってきた（2）',
    });
    await settleAfterJournal(s, '止めたはずなのに畳まれたと言ってきた（2）', ['escalation']);

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

  it('明示的な manager_send で起こした後の resume_failed は、新しいガードに塞がれず従来どおり処理される', async () => {
    const { s, fake } = await stopped();

    const sendResult = await s.pool.send(job.id, 'まだ続きがある');
    expect(sendResult.outcome).toBe('delivered');
    const afterSend = (await s.pool.list()).find((m) => m.managerId === job.id);
    expect(afterSend?.status).toBe('running');

    fake.resumeFailed(job.id, job.sessionId, '結局戻れていなかった', false);

    await expect
      .poll(async () => (await s.pool.list()).find((m) => m.managerId === job.id)?.status, {
        timeout: 2000,
      })
      .toBe('lost');

    await s.pool.stop();
  });
});

describe('Issue #1586: settled(withdrawn) を日誌へ残す（畳むときに CLI へ届かなかった deny の記録）', () => {
  const runningJob = {
    id: 'mgr-running',
    managerId: 'mgr-running',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '移行作業',
    request: 'DB の移行をやって',
    cwd: '/work/project',
    sessionId: 'sess-1586',
    runnerId: 'runner-primary',
  };

  it('withdrawn 付きの settled は、requestId・summary・届いていないこと・reason が読める1行として日誌に残る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, status: 'waiting_human' });
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    fake.ask('mgr-running', 'req-1', 'Bash の実行許可: rm -rf /tmp/x');
    await expect
      .poll(
        async () =>
          (await s.pool.list()).find((m) => m.managerId === 'mgr-running')?.waiting.length,
        { timeout: 2000 },
      )
      .toBe(1);

    fake.settled('mgr-running', 'req-1', { reason: 'デーモンから停止を指示された。' });
    await expect
      .poll(
        async () =>
          (await s.pool.list()).find((m) => m.managerId === 'mgr-running')?.waiting.length,
        { timeout: 2000 },
      )
      .toBe(0);

    const escalations = (await s.stores.journal.list({ types: ['escalation'] })) as {
      question?: string;
      approvalId?: string;
      managerId?: string;
      withdrawnAt?: string;
      withdrawnReason?: string;
    }[];
    const entry = escalations.find((e) => e.approvalId === 'req-1' && e.withdrawnAt !== undefined);
    expect(entry?.question).toBe('Bash の実行許可: rm -rf /tmp/x');
    expect(entry?.managerId).toBe('mgr-running');
    expect(typeof entry?.withdrawnAt).toBe('string');
    expect(entry?.withdrawnReason).toContain('CLI へ');
    expect(entry?.withdrawnReason).toContain('デーモンから停止を指示された。');

    await s.pool.stop();
  });

  it('withdrawn 無しの settled は、これまでどおり日誌に何も残さない（answer()・onAbort と同じ形）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({ ...runningJob, status: 'waiting_human' });
    const fake = swappableRunner();
    const s = setup(undefined, { stores, runner: fake.runner });

    await s.pool.restore();
    fake.ask('mgr-running', 'req-2', 'Bash の実行許可: echo hi');
    await expect
      .poll(
        async () =>
          (await s.pool.list()).find((m) => m.managerId === 'mgr-running')?.waiting.length,
        { timeout: 2000 },
      )
      .toBe(1);

    fake.settled('mgr-running', 'req-2');
    await expect
      .poll(
        async () =>
          (await s.pool.list()).find((m) => m.managerId === 'mgr-running')?.waiting.length,
        { timeout: 2000 },
      )
      .toBe(0);

    const escalations = (await s.stores.journal.list({ types: ['escalation'] })) as {
      approvalId?: string;
      withdrawnAt?: string;
    }[];
    expect(escalations.some((e) => e.approvalId === 'req-2' && e.withdrawnAt !== undefined)).toBe(
      false,
    );

    await s.pool.stop();
  });
});

describe('ターンが report で終わったとき unpushedWork を1回取る（Issue #1266 の (4)）', () => {
  async function jobOf(s: Setup, managerId: string) {
    return (await s.stores.jobs.listJobs()).find((job) => job.id === managerId);
  }

  it('report でターンが終わると、unpushedWork が呼ばれ、枝名を含む観測が台帳に残る', async () => {
    const fake = swappableRunner('runner-primary');
    const calls: { managerId: string; hasSignal: boolean }[] = [];
    const runner: RunnerClient = {
      ...fake.runner,
      async unpushedWork(managerId, options) {
        calls.push({ managerId, hasSignal: options?.signal !== undefined });
        return {
          cwd: '/work/project',
          worktrees: [{ relativePath: '.', branch: 'feat/1266-turn-end-unpushed-observation' }],
        };
      },
    };
    const stores = createMemoryStores();
    const s = setup(undefined, { stores, runner });
    const { managerId } = await s.pool.start({ request: '確認' });

    fake.report(managerId, '完了しました');

    await expect.poll(() => calls.length, { timeout: 2000 }).toBe(1);
    expect(calls[0]).toEqual({ managerId, hasSignal: true });

    await expect
      .poll(async () => (await jobOf(s, managerId))?.lastUnpushedWorkObservation, {
        timeout: 2000,
      })
      .toMatchObject({ kind: 'observed' });
    const job = await jobOf(s, managerId);
    expect(job?.lastUnpushedWorkObservation).toMatchObject({
      kind: 'observed',
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'feat/1266-turn-end-unpushed-observation' }],
    });

    expect(job?.status).toBe('done');
    expect(job?.lastReport).toBe('完了しました');

    await s.pool.stop();
  });

  it('report でターンが終わると、確かめきれなかったことの4欄が台帳に残り、unreadableDirSample だけは残らない（Issue #1885）', async () => {
    const fake = swappableRunner('runner-primary');
    const runner: RunnerClient = {
      ...fake.runner,
      async unpushedWork() {
        return {
          cwd: '/work/project',
          worktrees: [{ relativePath: '.', branch: 'feat/1885-incomplete' }],
          truncatedAtCount: 50,
          stoppedEarly: true,
          scratchRootsUnknown: '確かめられなかった（/tmp を読めなかった: EACCES）',
          unreadableDirCount: 3,
          unreadableDirSample: '/workspace/mgr-1/locked: EACCES',
        };
      },
    };
    const stores = createMemoryStores();
    const s = setup(undefined, { stores, runner });
    const { managerId } = await s.pool.start({ request: '確認' });

    fake.report(managerId, '完了しました');

    await expect
      .poll(async () => (await jobOf(s, managerId))?.lastUnpushedWorkObservation, {
        timeout: 2000,
      })
      .toMatchObject({ kind: 'observed' });

    const job = await jobOf(s, managerId);
    expect(job?.lastUnpushedWorkObservation).toMatchObject({
      kind: 'observed',
      truncatedAtCount: 50,
      stoppedEarly: true,
      scratchRootsUnknown: '確かめられなかった（/tmp を読めなかった: EACCES）',
      unreadableDirCount: 3,
    });
    // `unreadableDirSample` は写さない: 絶対パスを含むため、台帳に出さない線の外になる。
    expect(job?.lastUnpushedWorkObservation).not.toHaveProperty('unreadableDirSample');

    await s.pool.stop();
  });

  // `Object.keys` で数える: `undefined` を書き込んでも `toMatchObject` は気づかないため。
  it('確かめきれなかった申告が無い観測は、台帳にもこの4欄が1つも増えない（Issue #1885）', async () => {
    const fake = swappableRunner('runner-primary');
    const runner: RunnerClient = {
      ...fake.runner,
      async unpushedWork() {
        return {
          cwd: '/work/project',
          worktrees: [{ relativePath: '.', branch: 'feat/1885-complete' }],
        };
      },
    };
    const stores = createMemoryStores();
    const s = setup(undefined, { stores, runner });
    const { managerId } = await s.pool.start({ request: '確認' });

    fake.report(managerId, '完了しました');

    await expect
      .poll(async () => (await jobOf(s, managerId))?.lastUnpushedWorkObservation, {
        timeout: 2000,
      })
      .toMatchObject({ kind: 'observed' });

    const observation = (await jobOf(s, managerId))?.lastUnpushedWorkObservation;
    expect(Object.keys(observation ?? {}).sort()).toEqual([
      'at',
      'cwd',
      'kind',
      'source',
      'worktrees',
    ]);

    await s.pool.stop();
  });

  it('report の配達は、unpushedWork の往復の完了を待たない', async () => {
    const fake = swappableRunner('runner-primary');
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: RunnerClient = {
      ...fake.runner,
      async unpushedWork() {
        await gate;
        return { cwd: '/work/project', worktrees: [] };
      },
    };
    const stores = createMemoryStores();
    const s = setup(undefined, { stores, runner });
    const { managerId } = await s.pool.start({ request: '確認' });

    fake.report(managerId, '配達されるはず');

    await expect
      .poll(async () => (await jobOf(s, managerId))?.lastReport, { timeout: 2000 })
      .toBe('配達されるはず');
    await expect
      .poll(
        () =>
          s.inbox.some(
            (event) => event.type === 'manager_message' && event.text.includes('配達されるはず'),
          ),
        { timeout: 2000 },
      )
      .toBe(true);

    release?.();
    await s.pool.stop();
  });

  it('runner がこの口を持たないときは unavailable + reason が残り、報告の処理は進む', async () => {
    const fake = swappableRunner('runner-primary');
    const stores = createMemoryStores();
    const s = setup(undefined, { stores, runner: fake.runner });
    const { managerId } = await s.pool.start({ request: '確認' });

    fake.report(managerId, '完了しました');

    await expect
      .poll(async () => (await jobOf(s, managerId))?.lastUnpushedWorkObservation, {
        timeout: 2000,
      })
      .toMatchObject({
        kind: 'unavailable',
        reason: 'この runner はこの口を持たない（古い版、またはテストの偽物）。',
      });

    const job = await jobOf(s, managerId);
    expect(job?.status).toBe('done');
    expect(job?.lastReport).toBe('完了しました');
    await expect
      .poll(
        () =>
          s.inbox.some(
            (event) => event.type === 'manager_message' && event.text.includes('完了しました'),
          ),
        {
          timeout: 2000,
        },
      )
      .toBe(true);

    await s.pool.stop();
  });

  it('unpushedWork が失敗しても（例外）、報告の配達は止まらない', async () => {
    const fake = swappableRunner('runner-primary');
    const stores = createMemoryStores();
    const s = setup(undefined, { stores, runner: fake.runner });
    const { managerId } = await s.pool.start({ request: '確認' });

    // `pool.unpushedWork` を直接モックする: `runner.unpushedWork` 側を失敗させても `#probeUnpushedWork` の try/catch に飲まれ、呼び出し元の `.catch()` の歯が効かないため。
    const spy = vi.spyOn(s.pool, 'unpushedWork').mockRejectedValue(new Error('boom'));

    fake.report(managerId, '完了しました');

    await expect
      .poll(async () => (await jobOf(s, managerId))?.lastReport, { timeout: 2000 })
      .toBe('完了しました');
    const job = await jobOf(s, managerId);
    expect(job?.status).toBe('done');
    await expect
      .poll(
        () =>
          s.inbox.some(
            (event) => event.type === 'manager_message' && event.text.includes('完了しました'),
          ),
        {
          timeout: 2000,
        },
      )
      .toBe(true);

    // 呼ばれたことも見る: そもそも呼んでいないから止まらなかった、との区別が付かなくなるため。
    await expect.poll(() => spy.mock.calls.length, { timeout: 2000 }).toBe(1);

    spy.mockRestore();
    await s.pool.stop();
  });

  it('同じ委譲の report が短い間に続いても、unpushedWork は重ねて投げない', async () => {
    const fake = swappableRunner('runner-primary');
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: RunnerClient = {
      ...fake.runner,
      async unpushedWork(managerId) {
        calls.push(managerId);
        await gate;
        return { cwd: '/work/project', worktrees: [] };
      },
    };
    const stores = createMemoryStores();
    const s = setup(undefined, { stores, runner });
    const { managerId } = await s.pool.start({ request: '確認' });

    fake.report(managerId, '1回目の報告', 'done', { reportId: 'r1' });
    await expect.poll(() => calls.length, { timeout: 2000 }).toBe(1);

    fake.report(managerId, '2回目の報告', 'done', { reportId: 'r2' });
    await expect
      .poll(async () => (await jobOf(s, managerId))?.lastReport, { timeout: 2000 })
      .toBe('2回目の報告');
    expect(calls).toEqual([managerId]);

    release?.();
    await expect
      .poll(async () => (await jobOf(s, managerId))?.lastUnpushedWorkObservation, {
        timeout: 2000,
      })
      .toMatchObject({ kind: 'observed' });
    fake.report(managerId, '3回目の報告', 'done', { reportId: 'r3' });
    await expect.poll(() => calls.length, { timeout: 2000 }).toBe(2);

    await s.pool.stop();
  });

  // 周期で取る形を足さない: 観測はターン終了時の1回だけで、定期巡回は入れていない能力のため。
  it('report が一度も届いていない間は、時計をどれだけ進めても unpushedWork は呼ばれない', async () => {
    vi.useFakeTimers();
    try {
      const fake = swappableRunner('runner-primary');
      const calls: string[] = [];
      const runner: RunnerClient = {
        ...fake.runner,
        async unpushedWork(managerId) {
          calls.push(managerId);
          return { cwd: '/work/project', worktrees: [] };
        },
      };
      const stores = createMemoryStores();
      const s = setup(undefined, { stores, runner });
      await s.pool.start({ request: '確認' });

      await vi.advanceTimersByTimeAsync(60 * 60_000);

      expect(calls).toEqual([]);

      await s.pool.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('止めた後に届いた report では unpushedWork を呼ばない（R4）', async () => {
    // 最初から `status: 'stopped'` で台帳へ書かない: `#restoreJobs` は `running` でない job へ繋ぎに行かず、`fake.report()` のイベントが黙って捨てられるため。`running` → `abort()` で止める。
    const job = {
      id: 'mgr-stopped-no-unpushed-probe',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T01:00:00.000Z',
      status: 'running' as const,
      summary: '止める',
      request: '止める',
      cwd: '/work/project',
      sessionId: 'sess-stopped-no-unpushed-probe',
      runnerId: 'runner-primary',
    };
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);
    const fake = swappableRunner('runner-primary');
    fake.state.alive.push({
      managerId: job.id,
      status: 'running',
      cwd: job.cwd,
      request: job.request,
      waiting: [],
      sessionId: job.sessionId,
    });
    const calls: string[] = [];
    const runner: RunnerClient = {
      ...fake.runner,
      async stop(managerId: string) {
        fake.state.alive = fake.state.alive.filter((session) => session.managerId !== managerId);
      },
      async unpushedWork(managerId) {
        calls.push(managerId);
        return { cwd: '/work/project', worktrees: [] };
      },
    };
    const s = setup(undefined, { stores, runner });
    const aborted = await s.pool.abort(job.id, 'テストで止めた');
    expect(aborted.outcome).toBe('stopped');

    // `abort()` 自身が止める直前に観測を取る（`source: 'stop'`）: 測りたいのは止めた後の report なので、ここで `calls` をリセットし観測の値を控える。
    expect(calls).toEqual(['mgr-stopped-no-unpushed-probe']);
    calls.length = 0;
    const observationAfterAbort = (await stores.jobs.listJobs()).find(
      (j) => j.id === job.id,
    )?.lastUnpushedWorkObservation;
    expect(observationAfterAbort).toMatchObject({ kind: 'observed', source: 'stop' });

    fake.report(job.id, '止めた後に届いた報告');

    await expect
      .poll(
        async () => {
          const entries = await s.stores.journal.list({ types: ['exchange'] });
          return entries.some((entry) => JSON.stringify(entry).includes('止めた後に届いた報告'));
        },
        { timeout: 2000 },
      )
      .toBe(true);

    expect(calls).toEqual([]);
    const stored = await stores.jobs.listJobs();
    expect(stored.find((j) => j.id === job.id)?.lastUnpushedWorkObservation).toEqual(
      observationAfterAbort,
    );

    await s.pool.stop();
  });
});

describe('Bash の git push を検出したら unpushedWork を1回取る（Issue #1376 の続き）', () => {
  async function jobOf(s: Setup, managerId: string) {
    return (await s.stores.jobs.listJobs()).find((job) => job.id === managerId);
  }

  async function toolUseJournalHas(s: Setup, needle: string) {
    await expect
      .poll(
        async () => {
          const entries = await s.stores.journal.list({ types: ['tool_use'] });
          return entries.some((entry) => JSON.stringify(entry).includes(needle));
        },
        { timeout: 2000 },
      )
      .toBe(true);
  }

  it('Bash の git push tool_use で unpushedWork が呼ばれ、枝名を含む観測が台帳に残る', async () => {
    const fake = swappableRunner('runner-primary');
    const calls: { managerId: string; hasSignal: boolean }[] = [];
    const runner: RunnerClient = {
      ...fake.runner,
      async unpushedWork(managerId, options) {
        calls.push({ managerId, hasSignal: options?.signal !== undefined });
        return {
          cwd: '/work/project',
          worktrees: [{ relativePath: '.', branch: 'feat/1376-push-observation' }],
        };
      },
    };
    const stores = createMemoryStores();
    const s = setup(undefined, { stores, runner });
    const { managerId } = await s.pool.start({ request: '確認' });

    fake.toolUse(managerId, `manager:${managerId}`, 'Bash', { command: 'git push origin HEAD' });

    await expect.poll(() => calls.length, { timeout: 2000 }).toBe(1);
    expect(calls[0]).toEqual({ managerId, hasSignal: true });

    await expect
      .poll(async () => (await jobOf(s, managerId))?.lastUnpushedWorkObservation, {
        timeout: 2000,
      })
      .toMatchObject({ kind: 'observed' });
    const job = await jobOf(s, managerId);
    expect(job?.lastUnpushedWorkObservation).toMatchObject({
      kind: 'observed',
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'feat/1376-push-observation' }],
    });

    await toolUseJournalHas(s, 'git push origin HEAD');

    await s.pool.stop();
  });

  it('作業者の Bash の git push でも、同じ委譲について unpushedWork が呼ばれる', async () => {
    const fake = swappableRunner('runner-primary');
    const calls: string[] = [];
    const runner: RunnerClient = {
      ...fake.runner,
      async unpushedWork(managerId) {
        calls.push(managerId);
        return { cwd: '/work/project', worktrees: [] };
      },
    };
    const stores = createMemoryStores();
    const s = setup(undefined, { stores, runner });
    const { managerId } = await s.pool.start({ request: '確認' });

    fake.toolUse(managerId, `worker:${managerId}:general-purpose`, 'Bash', {
      command: 'git add -A && git commit -m x && git push',
    });

    await expect.poll(() => calls.length, { timeout: 2000 }).toBe(1);
    expect(calls).toEqual([managerId]);

    await s.pool.stop();
  });

  it('Bash 以外の道具では git push らしき input があっても呼ばれない', async () => {
    const fake = swappableRunner('runner-primary');
    const calls: string[] = [];
    const runner: RunnerClient = {
      ...fake.runner,
      async unpushedWork(managerId) {
        calls.push(managerId);
        return { cwd: '/work/project', worktrees: [] };
      },
    };
    const stores = createMemoryStores();
    const s = setup(undefined, { stores, runner });
    const { managerId } = await s.pool.start({ request: '確認' });

    fake.toolUse(managerId, `manager:${managerId}`, 'Write', {
      file_path: '/tmp/x',
      content: 'git push',
    });
    await toolUseJournalHas(s, 'Write');

    expect(calls).toEqual([]);

    await s.pool.stop();
  });

  it('Bash でも git push を含まないコマンドでは呼ばれない', async () => {
    const fake = swappableRunner('runner-primary');
    const calls: string[] = [];
    const runner: RunnerClient = {
      ...fake.runner,
      async unpushedWork(managerId) {
        calls.push(managerId);
        return { cwd: '/work/project', worktrees: [] };
      },
    };
    const stores = createMemoryStores();
    const s = setup(undefined, { stores, runner });
    const { managerId } = await s.pool.start({ request: '確認' });

    fake.toolUse(managerId, `manager:${managerId}`, 'Bash', { command: 'git status' });
    fake.toolUse(managerId, `manager:${managerId}`, 'Bash', { command: 'git pull --rebase' });
    await toolUseJournalHas(s, 'git pull --rebase');

    expect(calls).toEqual([]);

    await s.pool.stop();
  });

  it('echo など誤検出でも、観測を1回余分に取るだけで報告の処理は乱れない', async () => {
    const fake = swappableRunner('runner-primary');
    const calls: string[] = [];
    const runner: RunnerClient = {
      ...fake.runner,
      async unpushedWork(managerId) {
        calls.push(managerId);
        return { cwd: '/work/project', worktrees: [] };
      },
    };
    const stores = createMemoryStores();
    const s = setup(undefined, { stores, runner });
    const { managerId } = await s.pool.start({ request: '確認' });

    fake.toolUse(managerId, `manager:${managerId}`, 'Bash', {
      command: "echo 'git push しました'",
    });

    await expect.poll(() => calls.length, { timeout: 2000 }).toBe(1);
    const job = await jobOf(s, managerId);
    expect(job?.lastUnpushedWorkObservation).toMatchObject({ kind: 'observed' });
    expect(job?.status).not.toBe('failed');

    await s.pool.stop();
  });

  it('同じ委譲で git push の tool_use が短い間に続いても、unpushedWork は重ねて投げない', async () => {
    const fake = swappableRunner('runner-primary');
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: RunnerClient = {
      ...fake.runner,
      async unpushedWork(managerId) {
        calls.push(managerId);
        await gate;
        return { cwd: '/work/project', worktrees: [] };
      },
    };
    const stores = createMemoryStores();
    const s = setup(undefined, { stores, runner });
    const { managerId } = await s.pool.start({ request: '確認' });

    fake.toolUse(managerId, `manager:${managerId}`, 'Bash', { command: 'git push' });
    await expect.poll(() => calls.length, { timeout: 2000 }).toBe(1);

    fake.toolUse(managerId, `manager:${managerId}`, 'Bash', { command: 'git push' });
    await toolUseJournalHas(s, 'Bash');
    expect(calls).toEqual([managerId]);

    release?.();
    await expect
      .poll(async () => (await jobOf(s, managerId))?.lastUnpushedWorkObservation, {
        timeout: 2000,
      })
      .toMatchObject({ kind: 'observed' });

    fake.toolUse(managerId, `manager:${managerId}`, 'Bash', { command: 'git push' });
    await expect.poll(() => calls.length, { timeout: 2000 }).toBe(2);

    await s.pool.stop();
  });

  it('report 起点の観測が進行中なら、同じ委譲の git push は重ねて投げない', async () => {
    const fake = swappableRunner('runner-primary');
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: RunnerClient = {
      ...fake.runner,
      async unpushedWork(managerId) {
        calls.push(managerId);
        await gate;
        return { cwd: '/work/project', worktrees: [] };
      },
    };
    const stores = createMemoryStores();
    const s = setup(undefined, { stores, runner });
    const { managerId } = await s.pool.start({ request: '確認' });

    fake.report(managerId, '完了しました');
    await expect.poll(() => calls.length, { timeout: 2000 }).toBe(1);

    fake.toolUse(managerId, `manager:${managerId}`, 'Bash', { command: 'git push' });
    await toolUseJournalHas(s, 'Bash');
    expect(calls).toEqual([managerId]);

    release?.();
    await s.pool.stop();
  });

  it('unpushedWork が失敗しても（例外）、tool_use の日誌書き込みは止まらない', async () => {
    const fake = swappableRunner('runner-primary');
    const stores = createMemoryStores();
    const s = setup(undefined, { stores, runner: fake.runner });
    const { managerId } = await s.pool.start({ request: '確認' });

    const spy = vi.spyOn(s.pool, 'unpushedWork').mockRejectedValue(new Error('boom'));

    fake.toolUse(managerId, `manager:${managerId}`, 'Bash', { command: 'git push' });

    await toolUseJournalHas(s, 'git push');

    await expect.poll(() => spy.mock.calls.length, { timeout: 2000 }).toBe(1);

    spy.mockRestore();
    await s.pool.stop();
  });
});

describe('Bash の枝作成を検出したら unpushedWork を1回取る（Issue #1376 の続き）', () => {
  async function jobOf(s: Setup, managerId: string) {
    return (await s.stores.jobs.listJobs()).find((job) => job.id === managerId);
  }

  async function toolUseJournalHas(s: Setup, needle: string) {
    await expect
      .poll(
        async () => {
          const entries = await s.stores.journal.list({ types: ['tool_use'] });
          return entries.some((entry) => JSON.stringify(entry).includes(needle));
        },
        { timeout: 2000 },
      )
      .toBe(true);
  }

  it.each([
    ['git checkout -b feat/x', 'git checkout -b'],
    ['git switch -c feat/y', 'git switch -c'],
    ['git branch feat/z', 'git branch <名前>'],
  ])('%s で unpushedWork が呼ばれ、観測が台帳に残る（%s）', async (command) => {
    const fake = swappableRunner('runner-primary');
    const calls: string[] = [];
    const runner: RunnerClient = {
      ...fake.runner,
      async unpushedWork(managerId) {
        calls.push(managerId);
        return { cwd: '/work/project', worktrees: [{ relativePath: '.', branch: 'feat/x' }] };
      },
    };
    const stores = createMemoryStores();
    const s = setup(undefined, { stores, runner });
    const { managerId } = await s.pool.start({ request: '確認' });

    fake.toolUse(managerId, `manager:${managerId}`, 'Bash', { command });

    await expect.poll(() => calls.length, { timeout: 2000 }).toBe(1);
    expect(calls).toEqual([managerId]);

    await expect
      .poll(async () => (await jobOf(s, managerId))?.lastUnpushedWorkObservation, {
        timeout: 2000,
      })
      .toMatchObject({ kind: 'observed' });

    await s.pool.stop();
  });

  it('git worktree add で unpushedWork が呼ばれる', async () => {
    const fake = swappableRunner('runner-primary');
    const calls: string[] = [];
    const runner: RunnerClient = {
      ...fake.runner,
      async unpushedWork(managerId) {
        calls.push(managerId);
        return { cwd: '/work/project', worktrees: [] };
      },
    };
    const stores = createMemoryStores();
    const s = setup(undefined, { stores, runner });
    const { managerId } = await s.pool.start({ request: '確認' });

    fake.toolUse(managerId, `manager:${managerId}`, 'Bash', {
      command: 'git worktree add ../other-tree -b feat/w',
    });

    await expect.poll(() => calls.length, { timeout: 2000 }).toBe(1);
    expect(calls).toEqual([managerId]);

    await s.pool.stop();
  });

  it('git branch の一覧・削除では呼ばれない', async () => {
    const fake = swappableRunner('runner-primary');
    const calls: string[] = [];
    const runner: RunnerClient = {
      ...fake.runner,
      async unpushedWork(managerId) {
        calls.push(managerId);
        return { cwd: '/work/project', worktrees: [] };
      },
    };
    const stores = createMemoryStores();
    const s = setup(undefined, { stores, runner });
    const { managerId } = await s.pool.start({ request: '確認' });

    fake.toolUse(managerId, `manager:${managerId}`, 'Bash', { command: 'git branch' });
    fake.toolUse(managerId, `manager:${managerId}`, 'Bash', {
      command: 'git branch -d feat/done',
    });
    fake.toolUse(managerId, `manager:${managerId}`, 'Bash', { command: 'git branch -a' });
    await toolUseJournalHas(s, 'git branch -a');

    expect(calls).toEqual([]);

    await s.pool.stop();
  });

  it('無関係な Bash では呼ばれない', async () => {
    const fake = swappableRunner('runner-primary');
    const calls: string[] = [];
    const runner: RunnerClient = {
      ...fake.runner,
      async unpushedWork(managerId) {
        calls.push(managerId);
        return { cwd: '/work/project', worktrees: [] };
      },
    };
    const stores = createMemoryStores();
    const s = setup(undefined, { stores, runner });
    const { managerId } = await s.pool.start({ request: '確認' });

    fake.toolUse(managerId, `manager:${managerId}`, 'Bash', { command: 'git status' });
    fake.toolUse(managerId, `manager:${managerId}`, 'Bash', { command: 'ls -la' });
    await toolUseJournalHas(s, 'ls -la');

    expect(calls).toEqual([]);

    await s.pool.stop();
  });

  it('枝作成の観測が進行中なら、同じ委譲の git push は重ねて投げない', async () => {
    const fake = swappableRunner('runner-primary');
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: RunnerClient = {
      ...fake.runner,
      async unpushedWork(managerId) {
        calls.push(managerId);
        await gate;
        return { cwd: '/work/project', worktrees: [] };
      },
    };
    const stores = createMemoryStores();
    const s = setup(undefined, { stores, runner });
    const { managerId } = await s.pool.start({ request: '確認' });

    fake.toolUse(managerId, `manager:${managerId}`, 'Bash', { command: 'git checkout -b feat/a' });
    await expect.poll(() => calls.length, { timeout: 2000 }).toBe(1);

    // 1本目がまだ `gate` で止まっている間に push する。
    fake.toolUse(managerId, `manager:${managerId}`, 'Bash', { command: 'git push' });
    await toolUseJournalHas(s, 'git push');
    expect(calls).toEqual([managerId]);

    release?.();
    await expect
      .poll(async () => (await jobOf(s, managerId))?.lastUnpushedWorkObservation, {
        timeout: 2000,
      })
      .toMatchObject({ kind: 'observed' });

    await s.pool.stop();
  });
});

describe('中身の無い報告は、記録は残すがクローンを起こさない', () => {
  async function jobOf(s: Setup, managerId: string) {
    return (await s.stores.jobs.listJobs()).find((job) => job.id === managerId);
  }

  // 台帳は一覧が写し忘れうるので直接読む。日誌が見えた時点で `#emit` の分岐は通り終えている
  // （`#onEvent` は fire-and-forget で、日誌の書き込みは分岐の直前）。
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

    await session.report('');

    // 完了の合図は日誌ではなく `lastReport`（台帳）にする: 日誌を待つと、`#journal` を消す変異で
    // このテストまで落ち、「起こさない」と「記録に残る」が別々の歯でなくなるため。
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

describe('一覧は、直近のターンが失敗で終わったことを落とさない', () => {
  const failedJob = {
    id: 'mgr-billing',
    managerId: 'mgr-billing',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    // `failed` にしない: 支出上限に当たってもセッションは生きていて、話しかければ続くため。
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
    // `failed` へ倒さない: 人間が続けられる仕事をそこで閉じてしまうため。
    expect(listed?.status).toBe('done');

    await s.pool.stop();
  });

  it('失敗していないマネージャーには lastFailure を作らない（「失敗していない」と「見ていない」を混ぜない）', async () => {
    const stores = createMemoryStores();
    // `delete` で外す: `exactOptionalPropertyTypes` で `undefined` を代入できないため。
    const ok = { ...failedJob, id: 'mgr-ok', managerId: 'mgr-ok' };
    delete (ok as { lastFailure?: unknown }).lastFailure;
    await stores.jobs.putJob(ok);
    const s = setup(undefined, { stores });

    const listed = (await s.pool.list()).find((m) => m.managerId === 'mgr-ok');

    expect(listed).toBeDefined();
    expect(listed?.lastFailure).toBeUndefined();
    expect(Object.hasOwn(listed as object, 'lastFailure')).toBe(false);

    await s.pool.stop();
  });
});

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

      fake.denied(id, 'Bash');
      expect(s.pool.denials(id)).toEqual([{ tool: 'Bash', count: 1, lastAt: expect.any(String) }]);

      fake.closed(id, status, `終端: ${status}`);

      // `denials()` はプロセス内だけの帳面（`Job` には書かない）なので、空へ戻れば像が消えた証拠になる。
      await expect.poll(() => s.pool.denials(id), { timeout: 2000 }).toEqual([]);

      const listed = (await s.pool.list()).find((m) => m.managerId === id);
      expect(listed).toBeDefined();
      expect(listed).toMatchObject({
        status,
        request: 'DB の移行をやって',
        // `lost` だけは戻れないと確認済みなので false。`done` / `failed` は `session_id` が残る限り起こし直せる。
        live: status !== 'lost',
      });

      const transcript = await s.pool.transcript(id);
      expect(transcript).toEqual({ kind: 'missing' });

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
    expect(s.pool.denials(id)).toEqual([{ tool: 'Edit', count: 1, lastAt: expect.any(String) }]);

    await s.pool.abort(id, '暴走したので');

    expect(s.pool.denials(id)).toEqual([]);
    const listed = (await s.pool.list()).find((m) => m.managerId === id);
    expect(listed).toMatchObject({ status: 'stopped' });

    await s.pool.stop();
  });

  (['done', 'lost', 'failed'] as const).forEach((status) => {
    it(`closed（${status}）で #records から外れた後も、runnerIdOf() は台帳から runnerId を答える`, async () => {
      const id = `mgr-runnerid-${status}`;
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

      expect(s.pool.denials(id)).toEqual([]);
      await expect(s.pool.runnerIdOf(id)).resolves.toBe('runner-test');

      fake.denied(id, 'Bash');
      expect(s.pool.denials(id)).toEqual([{ tool: 'Bash', count: 1, lastAt: expect.any(String) }]);
      fake.closed(id, status, `終端: ${status}`);
      await expect.poll(() => s.pool.denials(id), { timeout: 2000 }).toEqual([]);

      await expect(s.pool.runnerIdOf(id)).resolves.toBe('runner-test');

      await s.pool.stop();
    });
  });

  it('runnerIdOf() は、像にも台帳にも存在しない managerId には undefined を返す（判定できないへ落ちる）', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, { stores });
    await s.pool.restore();

    await expect(s.pool.runnerIdOf('mgr-does-not-exist')).resolves.toBeUndefined();

    await s.pool.stop();
  });

  it('resume_failed で lost になって外れても、manager_send で明示的に起こし直せる（送信の経路が壊れない）', async () => {
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
    expect(s.pool.denials(id)).toEqual([{ tool: 'Bash', count: 1, lastAt: expect.any(String) }]);

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
    const id = 'mgr-reattach-giveup';
    const stores = createMemoryStores();
    await stores.jobs.putJob(job(id));
    const fake = swappableRunner('runner-test');
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.denied(id, 'Bash');
    expect(s.pool.denials(id)).toEqual([{ tool: 'Bash', count: 1, lastAt: expect.any(String) }]);

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
    await s.pool.restore();

    fake.closed(id, 'lost', 'セッションが落ちた');

    const result = await s.pool.send(id, '許可する', { requestId: 'req-9' });
    expect(result.outcome).toBe('unknown');
    expect(result.detail).toContain('待っていない');

    await s.pool.stop();
  });
});

describe('denials() の分類・理由・拒否文（issue #1105）', () => {
  function job(id: string): Job {
    return {
      id,
      managerId: id,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      status: 'running',
      summary: '走らせておいて',
      request: '調べて',
      cwd: '/work/project',
      sessionId: `sess-${id}`,
      runnerId: 'runner-test',
    };
  }

  function alive(id: string) {
    return {
      managerId: id,
      status: 'running' as const,
      cwd: '/work/project',
      request: '調べて',
      waiting: [],
      sessionId: `sess-${id}`,
    };
  }

  it('分類・理由・拒否文が denials() に載る', async () => {
    const id = 'mgr-denial-reason-basic';
    const stores = createMemoryStores();
    await stores.jobs.putJob(job(id));
    const fake = swappableRunner('runner-test');
    fake.state.alive.push(alive(id));
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.denied(id, 'Bash', {
      reasonType: 'classifier',
      reason: 'この形は共有資源を起動しうる',
      message: 'Blocked by classifier',
    });

    expect(s.pool.denials(id)).toEqual([
      {
        tool: 'Bash',
        count: 1,
        lastAt: expect.any(String),
        reasonType: 'classifier',
        reason: 'この形は共有資源を起動しうる',
        message: 'Blocked by classifier',
      },
    ]);

    await s.pool.stop();
  });

  (
    [
      [
        'reasonType のみ欠如',
        { reason: '理由だけ', message: '拒否文だけ' },
        { reasonType: undefined },
      ],
      ['reason のみ欠如', { reasonType: '分類だけ', message: '拒否文だけ' }, { reason: undefined }],
      ['message のみ欠如', { reasonType: '分類だけ', reason: '理由だけ' }, { message: undefined }],
    ] as const
  ).forEach(([label, fields, absent]) => {
    it(`${label}——欠けた欄はキーごと省き、他の欄はそのまま出す`, async () => {
      const id = `mgr-denial-reason-${label}`;
      const stores = createMemoryStores();
      await stores.jobs.putJob(job(id));
      const fake = swappableRunner('runner-test');
      fake.state.alive.push(alive(id));
      const s = setup(undefined, { stores, runner: fake.runner });
      await s.pool.restore();

      fake.denied(id, 'Bash', fields);

      const [denial] = s.pool.denials(id);
      expect(denial).toBeDefined();
      for (const key of Object.keys(absent)) {
        expect(denial).not.toHaveProperty(key);
      }
      for (const [key, value] of Object.entries(fields)) {
        expect(denial).toHaveProperty(key, value);
      }

      await s.pool.stop();
    });
  });

  it('理由を1つも持たない拒否（従来どおり）では3欄とも出ない', async () => {
    const id = 'mgr-denial-reason-none';
    const stores = createMemoryStores();
    await stores.jobs.putJob(job(id));
    const fake = swappableRunner('runner-test');
    fake.state.alive.push(alive(id));
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.denied(id, 'Bash');

    const [denial] = s.pool.denials(id);
    expect(denial).toEqual({ tool: 'Bash', count: 1, lastAt: expect.any(String) });

    await s.pool.stop();
  });

  it('複数回止められたときは最新1件の理由だけを持つ（前回分は持ち越さない）', async () => {
    const id = 'mgr-denial-reason-latest-only';
    const stores = createMemoryStores();
    await stores.jobs.putJob(job(id));
    const fake = swappableRunner('runner-test');
    fake.state.alive.push(alive(id));
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.denied(id, 'Bash', { reasonType: 'classifier', reason: '1回目の理由' });
    fake.denied(id, 'Bash', { reasonType: 'rule', reason: '2回目の理由' });

    const [denial] = s.pool.denials(id);
    expect(denial).toMatchObject({
      tool: 'Bash',
      count: 2,
      reasonType: 'rule',
      reason: '2回目の理由',
    });
    expect(denial?.reason).not.toBe('1回目の理由');

    fake.denied(id, 'Bash');
    const [after] = s.pool.denials(id);
    expect(after).toMatchObject({ tool: 'Bash', count: 3 });
    expect(after).not.toHaveProperty('reasonType');
    expect(after).not.toHaveProperty('reason');

    await s.pool.stop();
  });

  it('層（actor）が違えば別の組として、それぞれの理由を独立に持つ', async () => {
    const id = 'mgr-denial-reason-per-actor';
    const stores = createMemoryStores();
    await stores.jobs.putJob(job(id));
    const fake = swappableRunner('runner-test');
    fake.state.alive.push(alive(id));
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.denied(id, 'Bash', {
      actor: `manager:${id}`,
      reasonType: 'classifier',
      reason: 'マネージャー側',
    });
    fake.denied(id, 'Bash', {
      actor: `worker:${id}:agent-1`,
      reasonType: 'rule',
      reason: '作業者側',
    });

    const denials = s.pool.denials(id);
    expect(denials).toHaveLength(2);
    expect(denials.find((d) => d.actor === 'manager')).toMatchObject({
      reasonType: 'classifier',
      reason: 'マネージャー側',
    });
    expect(denials.find((d) => d.actor === 'worker')).toMatchObject({
      reasonType: 'rule',
      reason: '作業者側',
    });

    await s.pool.stop();
  });

  it('入力の先頭（inputHead）も denials() に載る', async () => {
    const id = 'mgr-denial-input-head-basic';
    const stores = createMemoryStores();
    await stores.jobs.putJob(job(id));
    const fake = swappableRunner('runner-test');
    fake.state.alive.push(alive(id));
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.denied(id, 'Bash', {
      reasonType: 'classifier',
      inputHead: 'sed -i 1s/.../ 538-comment.md',
    });

    expect(s.pool.denials(id)).toEqual([
      {
        tool: 'Bash',
        count: 1,
        lastAt: expect.any(String),
        reasonType: 'classifier',
        inputHead: 'sed -i 1s/.../ 538-comment.md',
      },
    ]);

    await s.pool.stop();
  });

  it('inputHead を持たない拒否（旧い runner・控えが無い等）では、その欄だけ省く', async () => {
    const id = 'mgr-denial-input-head-absent';
    const stores = createMemoryStores();
    await stores.jobs.putJob(job(id));
    const fake = swappableRunner('runner-test');
    fake.state.alive.push(alive(id));
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.denied(id, 'Bash', { reasonType: 'classifier' });

    const [denial] = s.pool.denials(id);
    expect(denial).toMatchObject({ tool: 'Bash', reasonType: 'classifier' });
    expect(denial).not.toHaveProperty('inputHead');

    await s.pool.stop();
  });

  it('複数回止められたときは最新1件の inputHead だけを持つ（前回分は持ち越さない）', async () => {
    const id = 'mgr-denial-input-head-latest-only';
    const stores = createMemoryStores();
    await stores.jobs.putJob(job(id));
    const fake = swappableRunner('runner-test');
    fake.state.alive.push(alive(id));
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.denied(id, 'Bash', { inputHead: '1回目の入力' });
    fake.denied(id, 'Bash', { inputHead: '2回目の入力' });

    const [denial] = s.pool.denials(id);
    expect(denial).toMatchObject({ tool: 'Bash', count: 2, inputHead: '2回目の入力' });

    fake.denied(id, 'Bash');
    const [after] = s.pool.denials(id);
    expect(after).not.toHaveProperty('inputHead');

    await s.pool.stop();
  });
});

class FakePoolRunner implements RunnerClient {
  readonly runnerId: string;
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  report: RunnerPlacementResources | undefined;
  started: string[] = [];
  resourcesCalls = 0;
  credentialsCalls = 0;
  onEvent: ((event: RunnerEvent) => void) | null = null;
  unpushedWorkResult: UnpushedWorkResult | undefined = undefined;
  profileCalls = 0;
  fakeCredentials: RunnerCredentialFingerprint[] = [];
  fakeProfile: RunnerProfileFingerprint | undefined;
  credentialsError: string | undefined;
  profileError: string | undefined;
  listCalls = 0;
  mcpServersCalls = 0;
  fakeMcpServers: RunnerMcpServersFingerprint | undefined;
  mcpServersError: string | undefined;
  // プロパティで持たせる: クラスのメソッドにすると全インスタンスが持ち、
  // `mcpServers` を持たない古い runner を模せないため。
  mcpServers?: () => Promise<RunnerMcpServersFingerprint | undefined>;

  constructor(
    runnerId: string,
    report?: RunnerPlacementResources,
    options?: { supportsMcpServers?: boolean },
  ) {
    this.runnerId = runnerId;
    this.report = report;
    if (options?.supportsMcpServers === true) {
      this.mcpServers = async () => {
        this.mcpServersCalls += 1;
        if (this.mcpServersError !== undefined) throw new Error(this.mcpServersError);
        return this.fakeMcpServers;
      };
    }
  }

  resourcesError: string | undefined;
  async resources(): Promise<RunnerPlacementResources | undefined> {
    this.resourcesCalls += 1;
    if (this.resourcesError !== undefined) throw new Error(this.resourcesError);
    return this.report;
  }
  async connect(onEvent: (event: RunnerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }
  hello(capabilities?: string[]): void {
    this.onEvent?.({
      type: 'hello',
      runnerId: this.runnerId,
      ...(capabilities === undefined ? {} : { capabilities }),
    });
  }
  async start(command: { managerId: string }): Promise<{ cwd?: string }> {
    this.started.push(command.managerId);
    return {};
  }
  async resume(): Promise<{ cwd?: string }> {
    return {};
  }
  async send(): Promise<boolean> {
    return true;
  }
  async answer(): Promise<RunnerAnswerOutcome> {
    return { delivered: false };
  }
  async stop(): Promise<void> {}
  async list(): Promise<RunnerManagerState[]> {
    this.listCalls += 1;
    return [];
  }
  async unpushedWork(): Promise<UnpushedWorkResult | undefined> {
    return this.unpushedWorkResult;
  }
  async transcript(): Promise<string | null> {
    return null;
  }
  async credentials(): Promise<RunnerCredentialFingerprint[]> {
    this.credentialsCalls += 1;
    if (this.credentialsError !== undefined) throw new Error(this.credentialsError);
    return this.fakeCredentials;
  }
  async setCredentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async profile(): Promise<RunnerProfileFingerprint | undefined> {
    this.profileCalls += 1;
    if (this.profileError !== undefined) throw new Error(this.profileError);
    return this.fakeProfile;
  }
  async setProfile(): Promise<RunnerProfileResult> {
    return { ok: true };
  }
  async close(): Promise<void> {}
}

describe('note.escalate（#570 の起こし直しが上限に達した回）', () => {
  function job(id: string): Job {
    return {
      id,
      managerId: id,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      status: 'running',
      summary: '走らせておいて',
      request: 'CI を見張っておいて',
      cwd: '/work/project',
      sessionId: `sess-${id}`,
      runnerId: 'runner-test',
    };
  }

  function alive(id: string) {
    return {
      managerId: id,
      status: 'running' as const,
      cwd: '/work/project',
      request: 'CI を見張っておいて',
      waiting: [],
      sessionId: `sess-${id}`,
    };
  }

  it('escalate を伴わない note は、日誌にだけ残り受信箱へは出ない（従来どおり）', async () => {
    const id = 'mgr-note-no-escalate';
    const stores = createMemoryStores();
    await stores.jobs.putJob(job(id));
    const fake = swappableRunner('runner-test');
    fake.state.alive.push(alive(id));
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();
    // `restore()` 自体が受信箱へ1本出すので、note 前の件数を基準にする。
    const before = s.inbox.length;

    fake.note(id, `[${id}] 起こし直した（1回目 / 上限 2）。`);

    await expect
      .poll(
        async () => {
          const entries = await stores.journal.list({ types: ['exchange'] });
          return entries.some((entry) => 'text' in entry && entry.text.includes('起こし直した'));
        },
        { timeout: 2000 },
      )
      .toBe(true);

    expect(s.inbox.length).toBe(before);

    await s.pool.stop();
  });

  it('escalate: true の note は、日誌に加えて受信箱にも1本上がる', async () => {
    const id = 'mgr-note-escalate';
    const stores = createMemoryStores();
    await stores.jobs.putJob(job(id));
    const fake = swappableRunner('runner-test');
    fake.state.alive.push(alive(id));
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();
    const before = s.inbox.filter(
      (event) => event.type === 'manager_message' && event.managerId === id,
    ).length;

    fake.note(
      id,
      `[${id}] 上限（2回）に達したため、起こし直さなかった（既に 2回 起こし直し済み）。`,
      true,
    );

    await expect
      .poll(
        async () => {
          const entries = await stores.journal.list({ types: ['exchange'] });
          return entries.some(
            (entry) => 'text' in entry && entry.text.includes('起こし直さなかった'),
          );
        },
        { timeout: 2000 },
      )
      .toBe(true);

    const managerMessagesOf = (managerId: string) =>
      s.inbox.filter(
        (event) => event.type === 'manager_message' && event.managerId === managerId,
      ) as { kind: string; text: string }[];
    await expect.poll(() => managerMessagesOf(id).length, { timeout: 2000 }).toBe(before + 1);
    const escalated = managerMessagesOf(id).at(-1);
    expect(escalated?.kind).toBe('report');
    expect(escalated?.text).toContain('自動では再開しない');
    expect(escalated?.text).toContain('journal_read');

    await s.pool.stop();
  });
});

describe('note.stall（Issue #357 — 空転の型付き記録への振り分け）', () => {
  function job(id: string): Job {
    return {
      id,
      managerId: id,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      status: 'running',
      summary: '走らせておいて',
      request: 'CI を見張っておいて',
      cwd: '/work/project',
      sessionId: `sess-${id}`,
      runnerId: 'runner-test',
    };
  }

  function alive(id: string) {
    return {
      managerId: id,
      status: 'running' as const,
      cwd: '/work/project',
      request: 'CI を見張っておいて',
      waiting: [],
      sessionId: `sess-${id}`,
    };
  }

  it('stall 無しの note は、これまでどおり exchange として日誌に残る', async () => {
    const id = 'mgr-note-stall-absent';
    const stores = createMemoryStores();
    await stores.jobs.putJob(job(id));
    const fake = swappableRunner('runner-test');
    fake.state.alive.push(alive(id));
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.note(id, `[${id}] 旧 runner からの note（stall を知らない）。`);

    await expect
      .poll(
        async () => {
          const entries = await stores.journal.list({ types: ['exchange'] });
          return entries.some(
            (entry) => 'text' in entry && entry.text.includes('旧 runner からの note'),
          );
        },
        { timeout: 2000 },
      )
      .toBe(true);

    const stallEntries = await stores.journal.list({ types: ['subagent_stall'] });
    expect(stallEntries).toHaveLength(0);

    // 種別だけでなく `with` / `role` も固定する: `with: 'self'` は人間に見せない内部ターンを意味し、
    // 倒れると旧 runner の note が人間の目から静かに消えるため。
    const fallback = (await stores.journal.list({ types: ['exchange'] })).find(
      (entry) => 'text' in entry && entry.text.includes('旧 runner からの note'),
    );
    if (fallback === undefined || fallback.type !== 'exchange') {
      throw new Error('fallback の exchange が見つからない');
    }
    expect(fallback.with).toBe('manager');
    expect(fallback.role).toBe('inbound');

    await s.pool.stop();
  });

  it('stall 付きの note は subagent_stall として日誌に残り、構造の欄がそのまま渡る', async () => {
    const id = 'mgr-note-stall-present';
    const stores = createMemoryStores();
    await stores.jobs.putJob(job(id));
    const fake = swappableRunner('runner-test');
    fake.state.alive.push(alive(id));
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();

    fake.note(id, `[${id}] 起こし直した（1回目 / 上限 2）。`, undefined, {
      agentId: 'agent-1',
      agentType: 'worker',
      ownedTaskCount: 1,
      sessionTaskCount: 2,
      wakeupCount: 1,
      outcome: 'woken',
    });

    await expect
      .poll(
        async () => {
          const entries = await stores.journal.list({ types: ['subagent_stall'] });
          return entries.length;
        },
        { timeout: 2000 },
      )
      .toBe(1);

    const [entry] = await stores.journal.list({ types: ['subagent_stall'] });
    if (entry === undefined || entry.type !== 'subagent_stall') {
      throw new Error('subagent_stall の日誌が見つからない');
    }
    expect(entry.agentId).toBe('agent-1');
    expect(entry.agentType).toBe('worker');
    expect(entry.ownedTaskCount).toBe(1);
    expect(entry.sessionTaskCount).toBe(2);
    expect(entry.wakeupCount).toBe(1);
    expect(entry.outcome).toBe('woken');
    expect(entry.text).toContain('起こし直した');

    const exchangeEntries = await stores.journal.list({ types: ['exchange'] });
    expect(exchangeEntries.some((e) => 'text' in e && e.text.includes('起こし直した（1回目'))).toBe(
      false,
    );

    await s.pool.stop();
  });

  it('stall と escalate を両方伴う note は、subagent_stall として残りかつ受信箱にも上がる', async () => {
    const id = 'mgr-note-stall-and-escalate';
    const stores = createMemoryStores();
    await stores.jobs.putJob(job(id));
    const fake = swappableRunner('runner-test');
    fake.state.alive.push(alive(id));
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();
    const before = s.inbox.filter(
      (event) => event.type === 'manager_message' && event.managerId === id,
    ).length;

    fake.note(id, `[${id}] 起こし直さなかった（既に 2回 起こし直し済み）。`, true, {
      agentId: 'agent-9',
      agentType: 'Explore',
      ownedTaskCount: 3,
      sessionTaskCount: 5,
      wakeupCount: 2,
      outcome: 'limit_reached',
    });

    await expect
      .poll(
        async () => {
          const entries = await stores.journal.list({ types: ['subagent_stall'] });
          return entries.length;
        },
        { timeout: 2000 },
      )
      .toBe(1);

    // `outcome` は上限側でも確かめる: `woken` だけだと、定数 `'woken'` を書き込む変異が両方のテストを通り抜けるため。
    const [stallEntry] = await stores.journal.list({ types: ['subagent_stall'] });
    if (stallEntry === undefined || stallEntry.type !== 'subagent_stall') {
      throw new Error('subagent_stall の日誌が見つからない');
    }
    expect(stallEntry.outcome).toBe('limit_reached');
    expect(stallEntry.agentId).toBe('agent-9');
    expect(stallEntry.agentType).toBe('Explore');
    expect(stallEntry.ownedTaskCount).toBe(3);
    expect(stallEntry.sessionTaskCount).toBe(5);
    expect(stallEntry.wakeupCount).toBe(2);

    const managerMessagesOf = (managerId: string) =>
      s.inbox.filter(
        (event) => event.type === 'manager_message' && event.managerId === managerId,
      ) as { kind: string; text: string }[];
    await expect.poll(() => managerMessagesOf(id).length, { timeout: 2000 }).toBe(before + 1);
    expect(managerMessagesOf(id).at(-1)?.kind).toBe('report');

    await s.pool.stop();
  });
});

describe('runner の指名（Pool.start の runnerId）', () => {
  it('runnerId を指名すると、その runner が起こされる（自動配置の点数計算を通していない）', async () => {
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

  // 期待値は固定文字列にせず `.started` の実測から作る: 入力の書き戻しや決め打ちの名前を返す変異を落とすため。
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
    // 台帳へ直接仕込む: `pool.start({ runnerId })` で内訳を作ると、指名側の変異でこのテストまで落ち、どちらの歯が壊れたか区別できなくなるため。
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

    expect(overview.runners.find((r) => r.label === 'runner-a')?.managers).toEqual([
      {
        managerId: 'mgr-no-session',
        status: 'running',
        live: false,
        tokenGenerationUnknownReason: 'pool-not-wired',
      },
    ]);

    await pool.stop();
    await registry.stop();
  });

  it('runnerId の無いマネージャーを、どの器にも混ぜず unassigned 別枠へ出す', async () => {
    const stores = createMemoryStores();
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

    expect(overview.runners.find((r) => r.label === 'runner-only')?.managers).toEqual([]);
    expect(overview.unassigned).toEqual([
      {
        managerId: 'mgr-legacy',
        status: 'done',
        live: false,
        tokenGenerationUnknownReason: 'pool-not-wired',
      },
    ]);

    await pool.stop();
    await registry.stop();
  });

  it('state は5値のまま渡す（connected へ畳まない）', async () => {
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

  it('fingerprints を渡さなければ credentials()/profile()/mcpServers() を呼ばず、指紋も probe も載せない', async () => {
    const a = new FakePoolRunner('runner-a', undefined, { supportsMcpServers: true });
    a.fakeCredentials = [
      { name: 'GITHUB_TOKEN', sha256: 'deadbeef0000', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    a.fakeProfile = { sha256: 'cafef00dbabe', bytes: 3, updatedAt: '2026-01-01T00:00:00.000Z' };
    a.fakeMcpServers = {
      sha256: 'abc123abc123',
      names: ['github'],
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([a]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const overview = await pool.runners();

    expect(a.credentialsCalls).toBe(0);
    expect(a.profileCalls).toBe(0);
    expect(a.mcpServersCalls).toBe(0);
    expect(overview.runners[0]?.credentials).toBeUndefined();
    expect(overview.runners[0]?.profile).toBeUndefined();
    expect(overview.runners[0]?.mcpServers).toBeUndefined();
    expect(overview.runners[0]?.credentialsProbe).toBeUndefined();
    expect(overview.runners[0]?.profileProbe).toBeUndefined();
    expect(overview.runners[0]?.mcpServersProbe).toBeUndefined();

    await pool.stop();
    await registry.stop();
  });

  it('fingerprints: true を渡すと、開いている器の鍵とプロファイルの指紋を添え、probe は asked になる', async () => {
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
    expect(overview.runners[0]?.credentialsProbe).toEqual({ status: 'asked' });
    expect(overview.runners[0]?.profileProbe).toEqual({ status: 'asked' });

    await pool.stop();
    await registry.stop();
  });

  it('fingerprints: true で鍵0件・プロファイル無しでも probe は asked のまま（0件を「聞けなかった」と混同しない）', async () => {
    const a = new FakePoolRunner('runner-a');
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([a]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const overview = await pool.runners({ fingerprints: true });

    expect(overview.runners[0]?.credentials).toEqual([]);
    expect(overview.runners[0]?.profile).toBeUndefined();
    expect(overview.runners[0]?.credentialsProbe).toEqual({ status: 'asked' });
    expect(overview.runners[0]?.profileProbe).toEqual({ status: 'asked' });

    await pool.stop();
    await registry.stop();
  });

  it('fingerprints: true でも繋がっていない runner には聞きに行かず、probe は unheard になる', async () => {
    const registry = createRunnerRegistry([], { retryBaseMs: 5, retryMaxMs: 5 });
    await registry.register({
      label: 'http://runner:later',
      open: () => Promise.reject(new Error('fetch failed')),
    });
    const stores = createMemoryStores();
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const overview = await pool.runners({ fingerprints: true });

    expect(overview.runners[0]?.credentials).toBeUndefined();
    expect(overview.runners[0]?.profile).toBeUndefined();
    expect(overview.runners[0]?.credentialsProbe).toEqual({ status: 'unheard' });
    expect(overview.runners[0]?.profileProbe).toEqual({ status: 'unheard' });
    expect(overview.runners[0]?.mcpServersProbe).toEqual({ status: 'unheard' });

    await pool.stop();
    await registry.stop();
  });

  it('fingerprints: true で聞いたが失敗したら、probe は failed になり理由が載る（credentials/profile とも潰さない）', async () => {
    const a = new FakePoolRunner('runner-a');
    a.credentialsError = 'credentials RPC failed (test)';
    a.profileError = 'profile RPC failed (test)';
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([a]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const overview = await pool.runners({ fingerprints: true });

    expect(overview.runners[0]?.credentials).toBeUndefined();
    expect(overview.runners[0]?.profile).toBeUndefined();
    expect(overview.runners[0]?.credentialsProbe).toEqual({
      status: 'failed',
      error: 'Error: credentials RPC failed (test)',
    });
    expect(overview.runners[0]?.profileProbe).toEqual({
      status: 'failed',
      error: 'Error: profile RPC failed (test)',
    });

    await pool.stop();
    await registry.stop();
  });

  describe('runner_list の MCP の登録の指紋（mcpServersProbe、Issue #1949）', () => {
    it('口を持たない runner（fake が supportsMcpServers を渡していない）は unsupported になる', async () => {
      const a = new FakePoolRunner('runner-a');
      const stores = createMemoryStores();
      const registry = createRunnerRegistry([a]);
      const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

      const overview = await pool.runners({ fingerprints: true });

      expect(overview.runners[0]?.mcpServers).toBeUndefined();
      expect(overview.runners[0]?.mcpServersProbe).toEqual({ status: 'unsupported' });

      await pool.stop();
      await registry.stop();
    });

    it('口を持つ runner が聞けたら asked になり、指紋と名前が載る', async () => {
      const a = new FakePoolRunner('runner-a', undefined, { supportsMcpServers: true });
      a.fakeMcpServers = {
        sha256: 'abc123abc123',
        names: ['github', 'remote'],
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      const stores = createMemoryStores();
      const registry = createRunnerRegistry([a]);
      const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

      const overview = await pool.runners({ fingerprints: true });

      expect(a.mcpServersCalls).toBe(1);
      expect(overview.runners[0]?.mcpServers).toEqual(a.fakeMcpServers);
      expect(overview.runners[0]?.mcpServersProbe).toEqual({ status: 'asked' });

      await pool.stop();
      await registry.stop();
    });

    it('口を持つ runner が聞いて失敗したら failed になる（unsupported とは別の文言）', async () => {
      const a = new FakePoolRunner('runner-a', undefined, { supportsMcpServers: true });
      a.mcpServersError = 'mcpServers RPC failed (test)';
      const stores = createMemoryStores();
      const registry = createRunnerRegistry([a]);
      const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

      const overview = await pool.runners({ fingerprints: true });

      expect(overview.runners[0]?.mcpServers).toBeUndefined();
      expect(overview.runners[0]?.mcpServersProbe).toEqual({
        status: 'failed',
        error: 'Error: mcpServers RPC failed (test)',
      });

      await pool.stop();
      await registry.stop();
    });

    it('fingerprints を渡さなければ、口を持つ runner でも mcpServers() を呼ばず probe も無い', async () => {
      const a = new FakePoolRunner('runner-a', undefined, { supportsMcpServers: true });
      a.fakeMcpServers = {
        sha256: 'abc123abc123',
        names: ['github'],
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      const stores = createMemoryStores();
      const registry = createRunnerRegistry([a]);
      const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

      const overview = await pool.runners();

      expect(a.mcpServersCalls).toBe(0);
      expect(overview.runners[0]?.mcpServers).toBeUndefined();
      expect(overview.runners[0]?.mcpServersProbe).toBeUndefined();

      await pool.stop();
      await registry.stop();
    });
  });

  // 「既定では呼ばない」の assert は置かない: 既定の経路は独立した2つの門（外側の
  // `fingerprints || resources` と内側の `!options.resources`）で塞がれていて、どの単一の変異でも
  // 赤くならず、「守られている」という嘘を読み手に与えるため。その歯は上の
  // 「resources() は呼ばない」が `fingerprints: true` で外側の門を通して担う。
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

  it('訊けなかった器は resources が undefined、訊けたが pids の無い器は resources はあるが pids が無い', async () => {
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([], { retryBaseMs: 5, retryMaxMs: 5 });
    await registry.register({
      label: 'runner-unreachable',
      open: () => Promise.reject(new Error('fetch failed')),
    });
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

  describe('resourcesProbe（Issue #2426）', () => {
    it('繋がっていない・失敗した・口を持たない・取れた を別の状態で返し、失敗は理由つき', async () => {
      const stores = createMemoryStores();
      const registry = createRunnerRegistry([], { retryBaseMs: 5, retryMaxMs: 5 });
      await registry.register({
        label: 'runner-unreachable',
        open: () => Promise.reject(new Error('fetch failed')),
      });
      const failing = new FakePoolRunner('runner-failing', { managers: 0 });
      failing.resourcesError = 'resources RPC failed (test)';
      await registry.register({ label: 'runner-failing', open: () => Promise.resolve(failing) });
      const old = new FakePoolRunner('runner-old', { managers: 0 });
      (old as { resources?: unknown }).resources = undefined;
      await registry.register({ label: 'runner-old', open: () => Promise.resolve(old) });
      const ok = new FakePoolRunner('runner-ok', { managers: 0, pids: { current: 5, max: 10 } });
      await registry.register({ label: 'runner-ok', open: () => Promise.resolve(ok) });

      const pool = createManagerPool({ stores, post: () => undefined, runners: registry });
      const overview = await pool.runners({ resources: true });
      const byLabel = new Map(overview.runners.map((r) => [r.label, r]));

      expect(byLabel.get('runner-unreachable')?.resourcesProbe).toEqual({ status: 'unheard' });
      expect(byLabel.get('runner-failing')?.resourcesProbe).toEqual({
        status: 'failed',
        error: expect.stringContaining('resources RPC failed (test)'),
      });
      expect(byLabel.get('runner-old')?.resourcesProbe).toEqual({ status: 'unsupported' });
      expect(byLabel.get('runner-ok')?.resourcesProbe).toEqual({ status: 'asked' });
      expect(byLabel.get('runner-ok')?.resources?.pids).toEqual({ current: 5, max: 10 });
      for (const label of ['runner-unreachable', 'runner-failing', 'runner-old']) {
        expect(byLabel.get(label)?.resources).toBeUndefined();
      }

      await pool.stop();
      await registry.stop();
    });

    it('resources: true を渡さない回は resourcesProbe の欄自体が無い', async () => {
      const a = new FakePoolRunner('runner-a', { managers: 0 });
      const stores = createMemoryStores();
      const registry = createRunnerRegistry([a]);
      const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

      const overview = await pool.runners();
      expect(overview.runners[0]).not.toHaveProperty('resourcesProbe');

      await pool.stop();
      await registry.stop();
    });
  });
});

describe('自動で畳む（ManagerPool.runners の pids 逼迫契機、#1394 段④⑥⑦）', () => {
  // 台帳へ直接ジョブを置かない: `turnEndReason` は `Job` に永続化されず `activityKind: 'unknown'`
  // のままで候補にならないため、`restore()` → `probeTurnEnds()` → `report()` の経路を通す。
  const TURN_END_TS = '2026-08-31T23:00:00.000Z';
  const REPORT_AT = '2026-09-01T00:00:00.000Z';
  const SEVEN_HOURS_LATER = Date.parse(REPORT_AT) + 7 * 3_600_000;

  function transcriptWithEndTurn(): string {
    return `${JSON.stringify({
      type: 'assistant',
      timestamp: TURN_END_TS,
      message: { content: [{ type: 'text', text: '直した' }], stop_reason: 'end_turn' },
    })}\n`;
  }

  async function setupActiveDoneCandidate(options: {
    unpushedWorkResult?: UnpushedWorkResult;
    pids?: { current: number; max: number };
    capabilities?: string[];
  }) {
    const id = 'mgr-idle';
    const fake = swappableRunner('runner-a');
    fake.state.alive.push({
      managerId: id,
      status: 'running',
      cwd: '/work/project',
      request: 'バグを直して',
      waiting: [],
      sessionId: `sess-${id}`,
    });
    fake.state.transcript = transcriptWithEndTurn();
    if (options.unpushedWorkResult !== undefined) {
      fake.enableUnpushedWork(options.unpushedWorkResult);
    }
    if (options.pids !== undefined) {
      fake.state.resources = { managers: 1, pids: options.pids };
    }

    const stores = createMemoryStores();
    await stores.jobs.putJob({
      id,
      managerId: id,
      createdAt: '2026-08-31T00:00:00.000Z',
      // `TURN_END_PROBE_QUIET_MS`（10分）より前にする: `probeTurnEnds()` の「動いているものを叩かない」門で弾かれないため。
      updatedAt: '2026-08-31T23:30:00.000Z',
      status: 'running',
      summary: '走らせておいて',
      request: 'バグを直して',
      cwd: '/work/project',
      sessionId: `sess-${id}`,
      runnerId: 'runner-a',
    });

    let clock = Date.parse(REPORT_AT);
    const posted: unknown[] = [];
    // 既定の `stop()` は no-op: `abort()` の `sessionGone` 判定（`runner.list()` が空か）で畳まれたことを
    // 確かめるため、`state.alive` を落とす `stop` を上乗せする。
    const runner: RunnerClient = {
      ...fake.runner,
      async stop(managerId: string) {
        fake.state.alive = fake.state.alive.filter((s) => s.managerId !== managerId);
      },
    };
    const registry = createRunnerRegistry([runner]);
    const pool = createManagerPool({
      stores,
      post: (event) => posted.push(event),
      runners: registry,
      now: () => clock,
    });

    await pool.restore();
    // `restore()` が `updatedAt` を「いま」へ進めるので、そのままだと `probeTurnEnds()` の10分の門に
    // 引っかかり探りが一度も走らない。経過を作ってから呼ぶ。
    clock += 20 * 60_000;
    await pool.probeTurnEnds();
    if (options.capabilities !== undefined) fake.helloWithCapabilities(options.capabilities);

    fake.report(id, '直した', 'done');
    await expect
      .poll(async () => (await pool.list()).find((m) => m.managerId === id)?.status, {
        timeout: 2000,
      })
      .toBe('done');

    clock = SEVEN_HOURS_LATER;

    // 下準備が積んだ分は捨てる: 下準備も `#post` を使うので、残すと「何も配っていない」を確かめるテストが常に失敗するため。
    posted.length = 0;

    return { id, fake, stores, pool, registry, posted, setClock: (ms: number) => (clock = ms) };
  }

  it('pids が逼迫していなければ、候補が居ても見ない（autoFolded 欄そのものが無い）', async () => {
    const { id, pool, registry, posted } = await setupActiveDoneCandidate({
      unpushedWorkResult: { cwd: '/work/project', worktrees: [] },
      pids: { current: 100, max: 1000 },
      capabilities: [RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL],
    });

    const overview = await pool.runners({ resources: true });

    expect(overview.autoFolded).toBeUndefined();
    expect((await pool.list()).find((m) => m.managerId === id)?.status).toBe('done');
    expect(posted).toEqual([]);

    await pool.stop();
    await registry.stop();
  });

  it('pids が逼迫し、候補の5条件と未push安全弁をすべて満たせば自動で畳む', async () => {
    const { id, pool, registry, posted, stores } = await setupActiveDoneCandidate({
      unpushedWorkResult: { cwd: '/work/project', worktrees: [] },
      pids: { current: 900, max: 1000 },
      capabilities: [RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL],
    });

    const overview = await pool.runners({ resources: true });

    const outcomes = overview.autoFolded as AutoFoldOutcome[];
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ managerId: id, runnerId: 'runner-a', outcome: 'folded' });

    const after = (await pool.list()).find((m) => m.managerId === id);
    expect(after?.status).toBe('stopped');

    const decisions = await stores.journal.list({ types: ['decision'] });
    const foldDecision = decisions.find(
      (entry) => 'decision' in entry && entry.decision.includes('[auto-fold]'),
    );
    expect(foldDecision).toBeDefined();
    expect(foldDecision && 'decision' in foldDecision ? foldDecision.decision : '').toContain(id);

    expect(
      posted.some(
        (event) =>
          typeof event === 'object' &&
          event !== null &&
          'managerId' in event &&
          (event as { managerId?: string }).managerId === id,
      ),
    ).toBe(true);

    await pool.stop();
    await registry.stop();
  });

  it('capabilities を名乗っていない runner では畳まない（条件3が偽のまま）', async () => {
    const { id, pool, registry } = await setupActiveDoneCandidate({
      unpushedWorkResult: { cwd: '/work/project', worktrees: [] },
      pids: { current: 900, max: 1000 },
    });

    const overview = await pool.runners({ resources: true });

    expect(overview.autoFolded).toEqual([]);
    expect((await pool.list()).find((m) => m.managerId === id)?.status).toBe('done');

    await pool.stop();
    await registry.stop();
  });

  it('未 push の実装があれば畳まず、見送った理由を decision で残す', async () => {
    const { id, pool, registry, stores } = await setupActiveDoneCandidate({
      unpushedWorkResult: {
        cwd: '/work/project',
        worktrees: [
          { relativePath: '.', branch: 'work', unpushedCommitCount: 2, uncommittedChangeCount: 0 },
        ],
      },
      pids: { current: 900, max: 1000 },
      capabilities: [RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL],
    });

    const overview = await pool.runners({ resources: true });

    const outcomes = overview.autoFolded as AutoFoldOutcome[];
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ managerId: id, outcome: 'blocked-unpushed-work' });

    expect((await pool.list()).find((m) => m.managerId === id)?.status).toBe('done');

    const decisions = await stores.journal.list({ types: ['decision'] });
    const skipDecision = decisions.find(
      (entry) => 'decision' in entry && entry.decision.includes('[auto-fold-skip]'),
    );
    expect(skipDecision).toBeDefined();

    await pool.stop();
    await registry.stop();
  });

  // 呼ぶたびに時計を6時間+1分進める: 安全弁が呼ぶ `unpushedWork()` の `#persist()` が
  // `manager.updatedAt` を「いま」へ進めるので、進めずに2回呼ぶと経過時間が0で候補から外れるため。
  const RECANDIDATE_GAP_MS = 6 * 3_600_000 + 60_000;

  it('同じ委譲・同じ理由での見送りは、間隔を空けて何度呼んでも decision を1件しか書かない', async () => {
    const { id, pool, registry, stores, setClock } = await setupActiveDoneCandidate({
      unpushedWorkResult: {
        cwd: '/work/project',
        worktrees: [
          { relativePath: '.', branch: 'work', unpushedCommitCount: 2, uncommittedChangeCount: 0 },
        ],
      },
      pids: { current: 900, max: 1000 },
      capabilities: [RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL],
    });

    let clock = SEVEN_HOURS_LATER;
    for (let i = 0; i < 3; i += 1) {
      setClock(clock);
      const overview = await pool.runners({ resources: true });
      const outcomes = overview.autoFolded as AutoFoldOutcome[];
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ managerId: id, outcome: 'blocked-unpushed-work' });
      clock += RECANDIDATE_GAP_MS;
    }

    const decisions = await stores.journal.list({ types: ['decision'] });
    const skipDecisions = decisions.filter(
      (entry) => 'decision' in entry && entry.decision.includes('[auto-fold-skip]'),
    );
    expect(skipDecisions).toHaveLength(1);

    await pool.stop();
    await registry.stop();
  });

  it('委譲が新しいターンを回す（lastReportAt が進む）と、同じ理由の見送りでももう1件 decision を書く', async () => {
    const { id, pool, registry, stores, fake, setClock } = await setupActiveDoneCandidate({
      unpushedWorkResult: {
        cwd: '/work/project',
        worktrees: [
          { relativePath: '.', branch: 'work', unpushedCommitCount: 2, uncommittedChangeCount: 0 },
        ],
      },
      pids: { current: 900, max: 1000 },
      capabilities: [RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL],
    });

    setClock(SEVEN_HOURS_LATER);
    await pool.runners({ resources: true });

    // 実時計を先に進めておく: 1件目と2件目の `lastReportAt` が同じミリ秒になると
    // 鍵が「変わっていない」と誤判定され、2件目の decision が書かれず flake になるため。
    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.report(id, '2巡目もまだ push していない', 'done');
    // 検出条件に `lastReportAt` を使わない: 上の理由で衝突しうる値のため、本文（`lastReport`）で判定する。
    await expect
      .poll(
        async () => (await stores.jobs.listJobs()).find((entry) => entry.id === id)?.lastReport,
        { timeout: 2000 },
      )
      .toBe('2巡目もまだ push していない');

    // clock を進める前に待つ: report 契機の fire-and-forget（`#observeUnpushedWorkOnce`）が
    // 後から着地すると `updatedAt` を新しい clock で上書きし、経過時間の起点をリセットしてしまうため。
    await new Promise((resolve) => setTimeout(resolve, 20));

    setClock(SEVEN_HOURS_LATER + RECANDIDATE_GAP_MS);
    const overview = await pool.runners({ resources: true });
    const outcomes = overview.autoFolded as AutoFoldOutcome[];
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ managerId: id, outcome: 'blocked-unpushed-work' });

    const decisions = await stores.journal.list({ types: ['decision'] });
    const skipDecisions = decisions.filter(
      (entry) => 'decision' in entry && entry.decision.includes('[auto-fold-skip]'),
    );
    expect(skipDecisions).toHaveLength(2);

    await pool.stop();
    await registry.stop();
  });

  it('見送りの理由の分類が変わったら、lastReportAt が同じでももう1件 decision を書く', async () => {
    const { id, pool, registry, stores, fake, setClock } = await setupActiveDoneCandidate({
      unpushedWorkResult: {
        cwd: '/work/project',
        worktrees: [
          { relativePath: '.', branch: 'work', unpushedCommitCount: 2, uncommittedChangeCount: 0 },
        ],
      },
      pids: { current: 900, max: 1000 },
      capabilities: [RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL],
    });

    setClock(SEVEN_HOURS_LATER);
    await pool.runners({ resources: true });

    // `report()` は呼ばない: `lastReportAt` を動かさず、分類（`classifyAutoFoldUnpushedWorkProbe`）の変化だけで書き直すことを見るため。
    fake.enableUnpushedWork({
      cwd: '/work/project',
      worktrees: [
        { relativePath: '.', branch: 'work', unpushedCommitCount: 5, uncommittedChangeCount: 0 },
      ],
    });

    setClock(SEVEN_HOURS_LATER + RECANDIDATE_GAP_MS);
    const overview = await pool.runners({ resources: true });
    const outcomes = overview.autoFolded as AutoFoldOutcome[];
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ managerId: id, outcome: 'blocked-unpushed-work' });

    const decisions = await stores.journal.list({ types: ['decision'] });
    const skipDecisions = decisions.filter(
      (entry) => 'decision' in entry && entry.decision.includes('[auto-fold-skip]'),
    );
    expect(skipDecisions).toHaveLength(2);

    await pool.stop();
    await registry.stop();
  });

  it('未pushが確かめられなかった（unavailable）ときも安全側で畳まない', async () => {
    const { id, pool, registry } = await setupActiveDoneCandidate({
      pids: { current: 900, max: 1000 },
      capabilities: [RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL],
    });

    const overview = await pool.runners({ resources: true });

    const outcomes = overview.autoFolded as AutoFoldOutcome[];
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.outcome).toBe('blocked-unpushed-work');
    expect((await pool.list()).find((m) => m.managerId === id)?.status).toBe('done');

    await pool.stop();
    await registry.stop();
  });

  it('候補になった直後に誰かが先に状態を変えていたら、安全側に倒して畳まない（raced）', async () => {
    const { id, pool, registry, stores } = await setupActiveDoneCandidate({
      unpushedWorkResult: { cwd: '/work/project', worktrees: [] },
      pids: { current: 900, max: 1000 },
      capabilities: [RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL],
    });
    const job = (await stores.jobs.listJobs()).find((j) => j.id === id);
    if (!job) throw new Error('準備に失敗');
    await stores.jobs.putJob({ ...job, status: 'stopped' });

    const overview = await pool.runners({ resources: true });

    const outcomes = overview.autoFolded as AutoFoldOutcome[];
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.outcome).toBe('raced');

    await pool.stop();
    await registry.stop();
  });

  it('runnerId が違う委譲は、その runner が逼迫していても対象にしない', async () => {
    // 委譲の `runnerId` を逼迫側と別名（`runner-c`）にする: 同じ名前だと「対象にしない」ことの検算にならないため。
    const pressured = new FakePoolRunner('runner-a', {
      managers: 0,
      pids: { current: 900, max: 1000 },
    });
    const stores = createMemoryStores();
    await stores.jobs.putJob({
      id: 'mgr-other',
      managerId: 'mgr-other',
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
      status: 'done',
      summary: '直した',
      request: 'バグを直して',
      cwd: '/work/project',
      sessionId: 'sess-mgr-other',
      runnerId: 'runner-c',
    });
    const registry = createRunnerRegistry([pressured]);
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      now: () => SEVEN_HOURS_LATER,
    });

    const overview = await pool.runners({ resources: true });

    expect(overview.autoFolded).toEqual([]);
    expect((await pool.list()).find((m) => m.managerId === 'mgr-other')?.status).toBe('done');

    await pool.stop();
    await registry.stop();
  });

  describe('もう1つの契機（manager_start の自動配置、ManagerPool.autoFoldOnPlacementPressure）', () => {
    function invoke(
      pool: ManagerPool,
      runnerId: string,
      pids: { current: number; max: number },
    ): void {
      if (pool.autoFoldOnPlacementPressure === undefined) {
        throw new Error('createManagerPool() が返す本物は常にこの口を持つはず');
      }
      pool.autoFoldOnPlacementPressure(runnerId, pids);
    }

    it('戻り値は同期の void——manager_start（配置）の応答を待たせない', async () => {
      const { id, pool, registry } = await setupActiveDoneCandidate({
        unpushedWorkResult: { cwd: '/work/project', worktrees: [] },
        pids: { current: 900, max: 1000 },
        capabilities: [RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL],
      });

      const result = invoke(pool, 'runner-a', { current: 900, max: 1000 });
      expect(result).toBeUndefined();

      await expect
        .poll(async () => (await pool.list()).find((m) => m.managerId === id)?.status, {
          timeout: 2000,
        })
        .toBe('stopped');

      await pool.stop();
      await registry.stop();
    });

    it('逼迫していれば、配置契機からでも段⑤⑥⑦を通して畳む', async () => {
      const { id, pool, registry, stores } = await setupActiveDoneCandidate({
        unpushedWorkResult: { cwd: '/work/project', worktrees: [] },
        pids: { current: 900, max: 1000 },
        capabilities: [RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL],
      });

      invoke(pool, 'runner-a', { current: 900, max: 1000 });

      await expect
        .poll(async () => (await pool.list()).find((m) => m.managerId === id)?.status, {
          timeout: 2000,
        })
        .toBe('stopped');

      const decisions = await stores.journal.list({ types: ['decision'] });
      const foldDecision = decisions.find(
        (entry) => 'decision' in entry && entry.decision.includes('[auto-fold]'),
      );
      expect(foldDecision).toBeDefined();

      await pool.stop();
      await registry.stop();
    });

    it('逼迫していなければ、list() を1回も読まずに戻る（契機の門がここでも独立して効く）', async () => {
      const runner = new FakePoolRunner('runner-a', { managers: 0 });
      const stores = createMemoryStores();
      const registry = createRunnerRegistry([runner]);
      const pool = createManagerPool({ stores, post: () => undefined, runners: registry });
      let listCalls = 0;
      const originalList = pool.list.bind(pool);
      pool.list = (...args: Parameters<typeof pool.list>) => {
        listCalls += 1;
        return originalList(...args);
      };

      invoke(pool, 'runner-a', { current: 100, max: 1000 });
      expect(listCalls).toBe(0);

      const decisions = await stores.journal.list({ types: ['decision'] });
      expect(decisions).toEqual([]);

      await pool.stop();
      await registry.stop();
    });

    it('内側の判定が例外で落ちたら、畳まず「判定できなかった」として decision を残す（未pushの見送りとは別の理由）', async () => {
      const { pool, registry, stores } = await setupActiveDoneCandidate({
        unpushedWorkResult: { cwd: '/work/project', worktrees: [] },
        pids: { current: 900, max: 1000 },
        capabilities: [RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL],
      });
      pool.list = () => Promise.reject(new Error('台帳が読めない（テストの模擬）'));

      invoke(pool, 'runner-a', { current: 900, max: 1000 });

      await expect
        .poll(
          async () => {
            const decisions = await stores.journal.list({ types: ['decision'] });
            return decisions.some(
              (entry) => 'decision' in entry && entry.decision.includes('[auto-fold-skip]'),
            );
          },
          { timeout: 2000 },
        )
        .toBe(true);

      const decisions = await stores.journal.list({ types: ['decision'] });
      const skipDecision = decisions.find(
        (entry) => 'decision' in entry && entry.decision.includes('[auto-fold-skip]'),
      );
      expect(skipDecision && 'decision' in skipDecision ? skipDecision.decision : '').toContain(
        '例外',
      );
      expect(
        decisions.some((entry) => 'decision' in entry && entry.decision.includes('[auto-fold]')),
      ).toBe(false);

      await pool.stop();
      await registry.stop();
    });

    it('未pushが確かめられなかった（unavailable）ときも、配置契機からでは安全側で畳まない（判定の共有を確かめる）', async () => {
      const { id, pool, registry } = await setupActiveDoneCandidate({
        pids: { current: 900, max: 1000 },
        capabilities: [RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL],
      });

      invoke(pool, 'runner-a', { current: 900, max: 1000 });

      // 実時間を待ってから読む: `expect.poll` では「変わらないこと」を測れないため。
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await pool.list()).find((m) => m.managerId === id)?.status).toBe('done');

      await pool.stop();
      await registry.stop();
    });

    it('2つの配置契機が同じ委譲を同時に拾っても、二重に abort しない（[auto-fold] は1行だけ）', async () => {
      const { id, pool, registry, stores } = await setupActiveDoneCandidate({
        unpushedWorkResult: { cwd: '/work/project', worktrees: [] },
        pids: { current: 900, max: 1000 },
        capabilities: [RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL],
      });

      invoke(pool, 'runner-a', { current: 900, max: 1000 });
      invoke(pool, 'runner-a', { current: 900, max: 1000 });

      await expect
        .poll(async () => (await pool.list()).find((m) => m.managerId === id)?.status, {
          timeout: 2000,
        })
        .toBe('stopped');

      const decisions = await stores.journal.list({ types: ['decision'] });
      const foldDecisions = decisions.filter(
        (entry) => 'decision' in entry && entry.decision.includes('[auto-fold]'),
      );
      expect(foldDecisions).toHaveLength(1);

      await pool.stop();
      await registry.stop();
    });

    it('runner_list 契機と配置契機が同時に同じ委譲を拾っても、二重に abort しない', async () => {
      const { id, pool, registry, stores } = await setupActiveDoneCandidate({
        unpushedWorkResult: { cwd: '/work/project', worktrees: [] },
        pids: { current: 900, max: 1000 },
        capabilities: [RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL],
      });

      const runnersPromise = pool.runners({ resources: true });
      invoke(pool, 'runner-a', { current: 900, max: 1000 });

      await runnersPromise;
      await expect
        .poll(async () => (await pool.list()).find((m) => m.managerId === id)?.status, {
          timeout: 2000,
        })
        .toBe('stopped');

      const decisions = await stores.journal.list({ types: ['decision'] });
      const foldDecisions = decisions.filter(
        (entry) => 'decision' in entry && entry.decision.includes('[auto-fold]'),
      );
      expect(foldDecisions).toHaveLength(1);

      await pool.stop();
      await registry.stop();
    });
  });
});

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

  // これが赤くなったら `manager_list` が自動で往復を払うようになっている:
  // north_star 禁止2（クローンの opt-in を一覧の側から踏み潰さない）に触れる。
  it('pool.list() を何度呼んでも runner.list() は一度も呼ばれない（増えた往復は heartbeat の側だけである）', async () => {
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([a]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    await pool.list();
    await pool.list();
    await pool.list();

    expect(a.listCalls).toBe(0);

    await pool.stop();
    await registry.stop();
  });

  it('pendingEvents が undefined の runner は記録しない（0で埋めない）', async () => {
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

class FakeBacklogMergeRunner implements RunnerClient {
  readonly runnerId: string;
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  report: RunnerPlacementResources | undefined;
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
  async start(): Promise<{ cwd?: string }> {
    return {};
  }
  async resume(): Promise<{ cwd?: string }> {
    return {};
  }
  async send(): Promise<boolean> {
    return true;
  }
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

// 時計は手で進める: heartbeat の10秒周期を実時間で待たないため。`now` を渡さず、
// Pool の `observedAt` と Registry の heartbeat の `at` を同じ `Date.now()` に揃える。
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

    await pool.runners({ resources: true });
    expect(pool.runnerBacklog!()).toEqual([
      {
        runnerId: 'runner-a',
        pendingEvents: 9,
        oldestPendingAt: '2026-08-20T00:00:00.000Z',
        observedAt: '2026-08-27T00:00:00.000Z',
      },
    ]);

    runner.identityPendingEvents = 4;
    runner.identityOldestPendingAt = '2026-08-27T00:00:05.000Z';
    await vi.advanceTimersByTimeAsync(10_000);

    expect(pool.runnerBacklog!()).toEqual([
      {
        runnerId: 'runner-a',
        pendingEvents: 4,
        oldestPendingAt: '2026-08-27T00:00:05.000Z',
        observedAt: '2026-08-27T00:00:10.000Z',
      },
    ]);

    // 次の heartbeat 周（t=20s）には届かない範囲で時計を進める。
    runner.report = {
      managers: 0,
      pendingEvents: 7,
      oldestPendingAt: '2026-08-27T00:00:11.000Z',
    };
    await vi.advanceTimersByTimeAsync(1_000);
    await pool.runners({ resources: true });

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

// 3つを別々の `it()` で測る: vitest は最初の失敗で止まるので、1本に同居させると
// 後ろの検査が走らず、`unusable` の側を消す変異が素通りするため。
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
    const s = await poolWithClosedRegistry(async () => {
      throw new Error('まだ上がっていない');
    });

    const result = await s.pool.send('mgr-away', '続きをやって');

    expect(result.outcome).toBe('unknown');
    expect(result.detail).toContain('unreachable');

    await s.pool.stop();
    await s.registry.stop();
  });

  it('待っても直らない宛先は、そう言う（unusable と unreachable を混ぜない）', async () => {
    const s = await poolWithClosedRegistry(async () => {
      throw new RunnerHttpError('鍵が違う', 403);
    });

    const result = await s.pool.send('mgr-away', '続きをやって');

    expect(result.outcome).toBe('unknown');
    expect(result.detail).toContain('unusable');
    // 同じ言葉で両方を言わない: 混ざると読む側が待つか起こし直すかを決められないため。
    expect(result.detail).not.toContain('unreachable');

    await s.pool.stop();
    await s.registry.stop();
  });

  it('恒久の断定をしない（判定できないことを言わない）', async () => {
    const s = await poolWithClosedRegistry(async () => {
      throw new Error('まだ上がっていない');
    });

    const result = await s.pool.send('mgr-away', '続きをやって');

    expect(result.detail).not.toContain('移送');
    expect(result.detail).toContain('戻せないことの証明ではない');

    await s.pool.stop();
    await s.registry.stop();
  });

  it('宛先が開いていれば、いままでどおり届く（一律にこの言葉へ倒していない）', async () => {
    const s = setup();
    const { managerId } = await s.pool.start({ request: '長い仕事' });

    const result = await s.pool.send(managerId, 'まだ続きがある');

    expect(result.outcome).toBe('delivered');
    expect(result.detail).not.toContain('名簿');

    await s.pool.stop();
  });
});

// 2本を別々の `it()` で測る: 片方だけだと逆向きの嘘（本当に預かっていないものまで
// 「読めなかった」に倒す計器）に気づけず、同居させると最初の失敗で後ろが走らないため。
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

    expect(lines.join('')).toContain('預かってある生ログを読み出せませんでした');
    expect(s.fake.state.resumes).toHaveLength(0);
    expect(await statusOf(s.stores)).toBe('running');
    expect(result?.outcome).toBe('unknown');
    expect(result?.detail).toContain('引きに行って失敗した');
    expect(result?.detail).not.toContain('新しく起こし直すこと');

    await s.pool.stop();
    await s.registry.stop();
  });

  it('本当に預かっていないときは、いままでどおり resume を投げ、戻れなければ lost で終える', async () => {
    // 逆向きに倒さない側: 本当に材料が無い委譲まで走行中のまま放置すると、`lost`（起こし直す対象の印）が付かず誰も起こし直さない。
    const s = await poolWithSessionStore(async () => null);

    const lines = await captureStderr(async () => {
      await s.pool.send(job.id, '続きをやって');
    });

    expect(lines.join('')).not.toContain('読み出せませんでした');
    expect(s.fake.state.resumes).toHaveLength(1);
    expect(s.fake.state.resumes[0]?.entries).toBeUndefined();

    s.fake.resumeFailed(job.id, 'sess-before-swap', 'SDK に会話が残っていない', false);
    await expect.poll(() => statusOf(s.stores), { timeout: 2000 }).toBe('lost');

    await s.pool.stop();
    await s.registry.stop();
  });
});

// 2本を別々の `it()` にする: 宛先が開いていない側だけだと、`abort()` が何を渡しても
// `unknown` を返す劣化に気づけない（台帳に本当に居ない側がそれを検知する）。
// `poolWithClosedRegistry` を使わず同じ形を組む: 別の describe のブロックスコープに閉じていて参照できないため。
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
    expect(result.detail).toContain('unreachable');
    expect(result.detail).not.toContain('というマネージャーは居ない');

    await pool.stop();
    await registry.stop();
  });

  it('待っても直らない宛先（unusable）でも、居ないとは言わず、状態も畳まない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningAway);
    const registry = createRunnerRegistry([], { notify: () => undefined });
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
    expect(result.detail).not.toContain('unreachable');

    await pool.stop();
    await registry.stop();
  });

  it('台帳に居ないものは、いままでどおり absent', async () => {
    const { pool, registry } = await poolWithUnreachableRunnerAndJob();

    // 消さないこと: 上のテストだけだと「abort は何でも unknown と言う」劣化を検知できない。
    const result = await pool.abort('mgr-does-not-exist');

    expect(result.outcome).toBe('absent');

    await pool.stop();
    await registry.stop();
  });
});

// 別々の `it()` で測る: vitest は最初の失敗で止まるので、同居させると後ろが走らないため。
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

  it('聞けなかった器のジョブは resume せず、台帳も動かさない', async () => {
    const fake = swappableRunner('runner-a');
    fake.runner.list = async () => {
      throw new Error('runner が応答しない');
    };
    const s = poolWith([fake.runner], [onA]);
    await s.seed();

    await s.pool.restore();

    expect(fake.state.resumes).toHaveLength(0);
    const job = (await s.stores.jobs.listJobs()).find((j) => j.id === 'mgr-on-a');
    expect(job?.status).toBe('running');

    await s.pool.stop();
    await s.registry.stop();
  });

  // 上の歯だけだと「黙って飛ばす」実装でも緑になるため、跡を別に測る。
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

  // ガードを `#records.set` の後ろへ動かすとこの歯だけが落ちる: 載せずに帰らないと次の `restore()` が拾い直せない。
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

    await s.pool.restore();
    expect(fake.state.resumes).toHaveLength(0);

    await s.pool.restore();
    expect(fake.state.resumes.map((r) => r.managerId)).toEqual(['mgr-on-a']);

    await s.pool.stop();
    await s.registry.stop();
  });

  // 上の2本だけだと「1台でも聞けなければ全部飛ばす」一律の実装でも緑になる。
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

    expect(a.state.resumes).toHaveLength(0);
    expect(b.state.resumes.map((r) => r.managerId)).toEqual(['mgr-on-b']);

    await s.pool.stop();
    await s.registry.stop();
  });
});

// マネージャー経由の枠の検知（`usage_notice` と `rate_limit` の `#onEvent`）にはこの層の歯が無い:
// `ManagerPool` の外から呼べず、偽の SDK に通知を吐かせて runner 経由で流す harness の口を `setup()` が持たないため。
// 同じ取り違えはクローン側の clone-usage-observation-and-recycle.test.ts で測ってある（片側だけの保証）。

describe('onUsageObservation（マネージャー経由の観測）', () => {
  const REACHED = "You've hit your org's monthly spend limit";

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
    expect(seen[0]?.notice?.text).toBe(REACHED);
  });

  // `rejected` は「その枠1つが尽きた」であって「仕事が止まった」ではない:
  // `reached` の形へ仕立て直して回し手へ渡すと、`overage_exhausted` の設定でも課金枠を使わずに回ってしまう。
  it('⚠️ rate_limit は notice ではなく、事実と遷移で渡る', async () => {
    const seen: TokenRotatorObservation[] = [];
    const s = await startManager({
      onUsageObservation: async (o) => {
        seen.push(o);
      },
    });

    await s.sessions[0]!.rateLimit({ status: 'rejected', rateLimitType: 'five_hour' });
    await settle();

    expect(seen[0]).not.toHaveProperty('notice');
    expect(seen[0]?.transition).toBe('rejected');
    expect(seen[0]?.facts?.status).toBe('rejected');
  });

  it('同じ rejected が毎ターン来ても、知らせるのは1回だけ（回し手へは毎回渡す）', async () => {
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

    // 本数で数える: `transition === 'rejected'` で絞ると、回し手へ1本も渡さない変異を見逃すため。
    expect(seen).toHaveLength(3);
    expect(seen.filter((o) => o.transition === 'rejected')).toHaveLength(1);
    expect(seen[0]?.transition).toBe('rejected');
    expect(seen[1]?.transition).toBeUndefined();
    expect(seen.map((o) => o.statusNow)).toEqual(['rejected', 'rejected', 'rejected']);

    // 知らせは合流窓（既定3000ms）に積まれるので、`stop()` で flush してから数える。
    await s.pool.stop();
    const reports = s.inbox.filter(
      (event) => event.type === 'manager_message' && event.kind === 'report',
    );
    expect(reports).toHaveLength(1);
  });

  // 値にバッククォートを含めて可変長フェンスになることまで見る: 「包まれた」だけだと、
  // 1本のバッククォートで固定する実装（値の側で閉じてしまう）が通ってしまうため。
  it('⚠️ 受信箱へ渡る本文では、kind と overageDisabledReason が codeSpan で包まれる', async () => {
    const s = await startManager();

    await s.sessions[0]!.rateLimit({
      rateLimitType: 'five_hour`*weird*`',
      isUsingOverage: true,
      overageDisabledReason: 'out_of_credits `rm -rf /`',
    });

    // 知らせは合流窓（既定3000ms）に積まれるので、`stop()` で flush してから読む。
    await s.pool.stop();
    const report = s.inbox.find(
      (event) => event.type === 'manager_message' && event.kind === 'report',
    ) as { text: string } | undefined;
    if (report === undefined) throw new Error('報告が届いていない');

    expect(report.text).toContain('`` five_hour`*weird*` ``');
    expect(report.text).toContain('`` out_of_credits `rm -rf /` ``');
    expect(report.text).toContain('**まだ動くが、この先で止まる。**');
  });

  // 日誌は包まない: Markdown で描かれる面ではなく、包むと読み手に無いバッククォートが見えるため。
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
    expect(text).toContain('five_hour`*weird*`');
    expect(text).not.toContain('`` five_hour`*weird*` ``');
    expect(text).toContain('out_of_credits `rm -rf /`');
    expect(text).not.toContain('`` out_of_credits `rm -rf /` ``');

    await s.pool.stop();
  });

  // フォールバック `'枠'` は包まない: デーモンが書いた日本語であって SDK の値ではなく、包むとデーモン自身の言葉が SDK の値の顔をするため。
  it('kind が無い回のフォールバック「枠」は包まれない', async () => {
    const s = await startManager();

    await s.sessions[0]!.rateLimit({ status: 'rejected' });

    await s.pool.stop();
    const report = s.inbox.find(
      (event) => event.type === 'manager_message' && event.kind === 'report',
    ) as { text: string } | undefined;
    if (report === undefined) throw new Error('報告が届いていない');

    expect(report.text).toContain('（枠）');
    expect(report.text).not.toContain('（`枠`）');
  });

  it('⚠️ 身元は「セッションが起きたとき」のもの。観測のたびに読み直さない', async () => {
    // 読み直すと、回した後に届いた前のセッションの観測が新しい身元を名乗り、世代の照合が素通しになる。
    // 固定値の `tokenIdentity` では測れない（読み直しても同じ値が返る）ので、セッションが起きた後に変える。
    let identity = { tokenId: 'tok-a', generation: 3 };
    const seen: TokenRotatorObservation[] = [];
    const s = await startManager({
      tokenIdentity: () => identity,
      onUsageObservation: async (o) => {
        seen.push(o);
      },
    });

    identity = { tokenId: 'tok-b', generation: 9 };

    await s.sessions[0]!.noticeLimit(REACHED);
    await settle();

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
    // 回せなかったことは枠に当たったこととは別の失敗であり、後者の報告を前者で置き換えない。
    const s = await startManager({
      onUsageObservation: () => Promise.reject(new Error('回し手が落ちた')),
    });

    await s.sessions[0]!.noticeLimit(REACHED);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const entries = await s.stores.journal.list({});
    expect(entries.some((entry) => JSON.stringify(entry).includes("You've hit your"))).toBe(true);
  });

  it('顔④: usage_notice（time）は既存の文言はそのまま、末尾に回復の見込みを添える', async () => {
    const s = await startManager();

    await s.sessions[0]!.noticeLimit(REACHED);

    // 知らせは合流窓（既定3000ms）に積まれるので、`stop()` で flush してから読む。
    await s.pool.stop();
    const report = s.inbox.find(
      (event) => event.type === 'manager_message' && event.kind === 'report',
    ) as { text: string } | undefined;
    if (report === undefined) throw new Error('報告が届いていない');

    expect(report.text).toContain('利用上限に当たった。この文言で仕事が止まっている');
    expect(report.text).toContain(REACHED);
    expect(report.text).toContain('（回復の見込み: 時間で戻る（time））');

    const entries = await s.stores.journal.list({});
    const entry = entries.find((e) => JSON.stringify(e).includes(REACHED));
    expect(entry).toBeDefined();
    const journalText = (entry as { text?: string }).text ?? '';
    expect(journalText).toContain('（回復の見込み: 時間で戻る（time））');
  });

  it('顔④: usage_notice（action）は「人間が動かないと戻らない」を添える', async () => {
    const s = await startManager();
    const ACTION_TEXT = 'Your usage allocation has been disabled by your admin';

    await s.sessions[0]!.noticeLimit(ACTION_TEXT);
    await s.pool.stop();

    const report = s.inbox.find(
      (event) => event.type === 'manager_message' && event.kind === 'report',
    ) as { text: string } | undefined;
    if (report === undefined) throw new Error('報告が届いていない');

    expect(report.text).toContain(ACTION_TEXT);
    expect(report.text).toContain('（回復の見込み: 人間が動かないと戻らない（action））');
  });

  it('顔④: usage_notice（unknown。transition）は回復の見込みの行を足さない', async () => {
    const s = await startManager();
    const TRANSITION_TEXT = "You're now using extra usage";

    await s.sessions[0]!.noticeLimit(TRANSITION_TEXT);
    await s.pool.stop();

    const report = s.inbox.find(
      (event) => event.type === 'manager_message' && event.kind === 'report',
    ) as { text: string } | undefined;
    if (report === undefined) throw new Error('報告が届いていない');

    expect(report.text).toContain(TRANSITION_TEXT);
    expect(report.text).not.toContain('回復の見込み');
  });

  it('名乗ってきた runner へ鍵を降ろす（後から上がった runner に追いつかせる）', async () => {
    const synced: string[] = [];
    await startManager({
      syncRunnerToken: async (runner) => {
        synced.push(runner.runnerId);
      },
    });

    expect(synced).toContain('runner-test');
  });

  it('繋ぎ直してきた runner にも鍵を降ろす（器が入れ替わっていれば鍵も消えている）', async () => {
    const synced: string[] = [];
    const s = await startManager({
      syncRunnerToken: async (runner) => {
        synced.push(runner.runnerId);
      },
    });
    const atConnect = synced.length;
    expect(atConnect).toBeGreaterThan(0);

    await s.pool.reattachRunner('runner-test');
    await settle();

    expect(synced.length).toBeGreaterThan(atConnect);
    expect(synced.at(-1)).toBe('runner-test');
  });

  // `#reattach` は繋ぎ済みの旗（`#connections`）を触らないので、鍵降ろしの完了前に `#connectTo` が即戻り、
  // 委譲が古い資格のまま走り出しうる。「窓が無い」側を assert する: 逆向きだと直した瞬間に赤くなるため。
  it('窓: #reattach が鍵を降ろし切る前に、委譲が同じ runner を選んで古い資格のまま走り出さない', async () => {
    const stores = createMemoryStores();
    const fake = swappableRunner('runner-test');

    // 器の環境変数（`CLAUDE_CODE_OAUTH_TOKEN`）は `RunnerClient` に現れないので、`setCredentials` だけが書き換える外部の可変箱で表す。
    const credential = { value: 'token-boot' };
    const order: string[] = [];

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

    fake.runner.start = async (command) => {
      order.push(`start:${credential.value}`);
      fake.state.alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
      });
      return {};
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

    await s.pool.restore();
    expect(credential.value).toBe('token-gen-1');

    credential.value = 'token-stale-from-container-boot';
    order.length = 0;
    gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    fake.swap();
    await expect
      .poll(() => order.includes('setCredentials:start:token-gen-2'), { timeout: 2000 })
      .toBe(true);

    const startPromise = s.pool.start({ request: '調べて' });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order.some((entry) => entry.startsWith('start:'))).toBe(false);

    releaseGate();
    await startPromise;

    expect(order).toContain('setCredentials:done:token-gen-2');
    expect(order).toContain('start:token-gen-2');
    expect(order.some((entry) => entry === 'start:token-boot')).toBe(false);
    expect(order.some((entry) => entry === 'start:token-stale-from-container-boot')).toBe(false);
    expect(order.some((entry) => entry === 'start:token-gen-1')).toBe(false);

    await s.pool.stop();
  });
});

describe('rate_limit を跨いで畳んだ本数を日誌へ残す（Issue #1425）', () => {
  async function settle(ms = 20): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  function crossFoldLines(entries: unknown[]): string[] {
    return entries
      .map((entry) => (entry as { text?: string }).text ?? '')
      .filter((text) => text.includes('同じ壁を跨いで畳んだ報告'));
  }

  it('陽性: 別のマネージャーが跨いで畳まれると、次の遷移で本数が1行に残る', async () => {
    const s = setup();
    await s.pool.start({ request: 'A' });
    await s.pool.start({ request: 'B' });
    await s.pool.start({ request: 'C' });

    const [a, b, c] = s.sessions as FakeSession[];

    await a!.rateLimit({ status: 'rejected', rateLimitType: 'five_hour' });
    await b!.rateLimit({ status: 'rejected', rateLimitType: 'five_hour' });
    await c!.rateLimit({ status: 'rejected', rateLimitType: 'five_hour' });
    await a!.rateLimit({ status: 'allowed', rateLimitType: 'five_hour' });
    await b!.rateLimit({ status: 'rejected', rateLimitType: 'five_hour' });
    await settle();

    const entries = await s.stores.journal.list({});
    const lines = crossFoldLines(entries);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('2 本の異なるマネージャーが当たっている');

    await s.pool.stop();
  });

  it('やりすぎの対照: 同じマネージャーだけが繰り返しても、本数の行は出ない', async () => {
    const s = setup();
    await s.pool.start({ request: 'A' });

    const [a] = s.sessions as FakeSession[];

    await a!.rateLimit({ status: 'rejected', rateLimitType: 'five_hour' });
    await a!.rateLimit({ status: 'allowed', rateLimitType: 'five_hour' });
    await a!.rateLimit({ status: 'rejected', rateLimitType: 'five_hour' });
    await settle();

    const entries = await s.stores.journal.list({});
    expect(crossFoldLines(entries)).toHaveLength(0);

    await s.pool.stop();
  });

  it('やりすぎの対照: 初回の遷移だけでは本数の行は出ない', async () => {
    const s = setup();
    await s.pool.start({ request: 'A' });

    const [a] = s.sessions as FakeSession[];

    await a!.rateLimit({ status: 'rejected', rateLimitType: 'five_hour' });
    await settle();

    const entries = await s.stores.journal.list({});
    expect(crossFoldLines(entries)).toHaveLength(0);

    await s.pool.stop();
  });
});

// `createLocalRunner`（`setup()` の既定）は `workspacePathKnown` が常に `true` なので、
// この歯は `workspacePathKnown: false` の偽物（`swappableRunner` を上書きしたもの）でしか踏めない。
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
    // 「cwd の形」を禁止する assertion は立てない: 文言が「cwd の形が不正なのではない」と明示していて自己矛盾するため。
    expect(String(caught)).toContain('workspacePath をまだ一度も聞けていない');

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

    const result = await s.pool.send(id, '続けて');
    expect(result.outcome).toBe('unknown');
    expect(result.detail).toContain('workspacePath を一度も聞けていない');

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
    expect(fake.state.resumes[0]?.cwd).toBe('/work/project');

    await s.pool.stop();
  });
});

// `status` は動かさない: 黙っているのが器なのか経路なのかは片側から決められないので、
// `lost`（resume を試して戻れなかったという確かめた事実）を名乗らせない。
describe('宛先の器が黙ったことを live が見る', () => {
  // 実物の heartbeat を回さない: `lost` の判定に30秒（`HEARTBEAT_LOST_MS`）かかるため
  // （その測り方は `runner-heartbeat.test.ts` が持つ）。
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
      vacate: (id) => registry.vacate(id),
      noteManagerFailed: (id) => registry.noteManagerFailed(id),
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
    // `sessionId` を持たせる: 在ると `isLive()` は「戻る先が在る」として `live: true` を返しうるため、それを破る側を測る。
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
    expect(orphan).not.toHaveProperty('runnerLostSince');

    await pool.stop();
    await registry.stop();
  });

  it('宛先が書かれていない古い委譲は、黙った器の判定に巻き込まない', async () => {
    const stores = createMemoryStores();
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
      {
        managerId: 'mgr-orphan',
        status: 'running',
        live: false,
        tokenGenerationUnknownReason: 'pool-not-wired',
      },
    ]);

    await pool.stop();
    await real.stop();
  });

  // `vacating` は `lost`（黙った）とは別の理由: `#silentRunners()` は `lost` だけを数えるホワイトリストで、
  // `vacating` を足して `false` へ倒すと、名乗りが続いている器を黙ったと誤判定する。
  it('drain 中（vacating）の委譲は live: true のままで、runnerLostSince も出ない', async () => {
    const stores = createMemoryStores();
    await seed(stores, { id: 'mgr-draining', runnerId: 'runner-a', sessionId: 'sess-a' });
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const real = createRunnerRegistry([a]);
    const registry = withEntryState(real, 'runner-a', {
      state: 'vacating',
      since: '2026-08-27T09:00:00.000Z',
    });
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const listed = await pool.list();
    const draining = listed.find((m) => m.managerId === 'mgr-draining');

    expect(draining?.live).toBe(true);
    expect(draining).not.toHaveProperty('runnerLostSince');
    expect(draining?.status).toBe('running');

    await pool.stop();
    await real.stop();
  });
});

// 1本が投げて走査ごと止まると、後ろに並んだ委譲は `#records` にすら載らず `running` のまま誰にも拾われない
// （呼び出し元の `takeOver()` は例外を握り潰すので、跡はログ1行しか残らない）。
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

    expect(restored.map((m) => m.managerId)).toContain('mgr-behind');
    expect(s.sessions).toHaveLength(1);

    const listed = await s.pool.list();
    expect(listed.find((m) => m.managerId === 'mgr-poison')?.status).toBe('running');

    await s.pool.stop();
  });

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
    expect(listed.find((m) => m.managerId === 'mgr-poison')?.live).toBe(false);

    await s.pool.stop();
  });
});

describe('running のまま、宛先の runner が名簿から entry ごと消えている委譲を数える（Issue #1212 running 側、段0）', () => {
  function vanishedRunnerGaugeLines(entries: unknown[]): string[] {
    return entries
      .map((entry) => (entry as { text?: string }).text ?? '')
      .filter((text) => text.includes('名簿から entry ごと消えている'));
  }

  async function seedRunning(
    stores: Stores,
    id: string,
    runnerId: string,
    createdAt: string,
  ): Promise<void> {
    await stores.jobs.putJob({
      id,
      managerId: id,
      createdAt,
      updatedAt: createdAt,
      status: 'running',
      summary: '仕事',
      request: '仕事',
      cwd: '/work/project',
      runnerId,
      sessionId: `sess-${id}`,
    });
  }

  it('陽性: 宛先の runner が名簿から entry ごと消え、running のまま残っている委譲が1本あると、本数と最古の経過時間が1行残る', async () => {
    const stores = createMemoryStores();
    await seedRunning(stores, 'mgr-vanished', 'runner-gone', '2026-09-24T00:00:00.000Z');
    // `runner-gone` を登録しない: 再起動直後の形（名乗る前の `connecting` の entry が載る）にしないため。その形は下の「判定できない」の歯が持つ。
    const registry = createRunnerRegistry([]);
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      now: () => Date.parse('2026-09-24T01:05:00.000Z'),
    });

    const listed = await pool.list();

    expect(listed.find((m) => m.managerId === 'mgr-vanished')?.status).toBe('running');
    expect(listed.find((m) => m.managerId === 'mgr-vanished')?.runnerVanished).toBe(true);

    const entries = await stores.journal.list({ order: 'asc' });
    const lines = vanishedRunnerGaugeLines(entries);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[runner-gone]');
    expect(lines[0]).toContain('running のまま残っている委譲が 1 本ある');
    expect(lines[0]).toContain('最古の委譲は1時間5分経過');

    await pool.stop();
    await registry.stop();
  });

  it('🔴 #1547: 宛先の runner がまだ繋がる途中（connecting・名乗る前）なら、印も計器も立てない', async () => {
    const stores = createMemoryStores();
    await seedRunning(stores, 'mgr-a', 'runner-a', '2026-09-24T00:00:00.000Z');
    const registry = createRunnerRegistry([]);
    let resolveOpen: (client: RunnerClient) => void = () => {};
    const openGate = new Promise<RunnerClient>((resolve) => {
      resolveOpen = resolve;
    });
    void registry.register({ label: 'runner-a', open: () => openGate });
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const duringConnect = await pool.list();
    expect(duringConnect.find((m) => m.managerId === 'mgr-a')?.runnerVanished).toBeUndefined();
    expect(vanishedRunnerGaugeLines(await stores.journal.list({ order: 'asc' }))).toHaveLength(0);

    resolveOpen(new FakePoolRunner('runner-a', { managers: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const afterConnect = await pool.list();
    expect(afterConnect.find((m) => m.managerId === 'mgr-a')?.runnerVanished).toBeUndefined();

    await pool.stop();
    await registry.stop();
  });

  it('#1547: 別の runner が名乗る前でも「判定できない」に倒す（その entry が宛先そのものかもしれない）', async () => {
    const stores = createMemoryStores();
    await seedRunning(stores, 'mgr-a', 'runner-gone', '2026-09-24T00:00:00.000Z');
    const registry = createRunnerRegistry([]);
    void registry.register({ label: 'runner-x', open: () => new Promise<RunnerClient>(() => {}) });
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const listed = await pool.list();
    expect(listed.find((m) => m.managerId === 'mgr-a')?.runnerVanished).toBeUndefined();
    expect(vanishedRunnerGaugeLines(await stores.journal.list({ order: 'asc' }))).toHaveLength(0);

    await pool.stop();
    await registry.stop();
  });

  it('やりすぎの対照①: runner の entry が名簿に残っていれば（lost でも）、本数の行は出ない', async () => {
    const stores = createMemoryStores();
    await seedRunning(stores, 'mgr-listed', 'runner-a', '2026-09-24T00:00:00.000Z');
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const registry = createRunnerRegistry([a]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const listed = await pool.list();

    expect(listed.find((m) => m.managerId === 'mgr-listed')?.runnerVanished).toBeUndefined();

    const entries = await stores.journal.list({ order: 'asc' });
    expect(vanishedRunnerGaugeLines(entries)).toHaveLength(0);

    await pool.stop();
    await registry.stop();
  });

  it('やりすぎの対照②: entry が消えていても running の委譲が0本なら、本数の行は出ない', async () => {
    const stores = createMemoryStores();
    const at = '2026-09-24T00:00:00.000Z';
    await stores.jobs.putJob({
      id: 'mgr-done',
      managerId: 'mgr-done',
      createdAt: at,
      updatedAt: at,
      status: 'done',
      summary: '仕事',
      request: '仕事',
      cwd: '/work/project',
      runnerId: 'runner-gone',
    });
    const registry = createRunnerRegistry([]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const listed = await pool.list();

    expect(listed.find((m) => m.managerId === 'mgr-done')?.runnerVanished).toBeUndefined();

    const entries = await stores.journal.list({ order: 'asc' });
    expect(vanishedRunnerGaugeLines(entries)).toHaveLength(0);

    await pool.stop();
    await registry.stop();
  });

  it('書く頻度: 本数が変わらなければ、list() を重ねて呼んでも行を重ねて書かない', async () => {
    const stores = createMemoryStores();
    await seedRunning(stores, 'mgr-vanished', 'runner-gone', '2026-09-24T00:00:00.000Z');
    const registry = createRunnerRegistry([]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    await pool.list();
    await pool.list();
    await pool.list();

    const entries = await stores.journal.list({ order: 'asc' });
    expect(vanishedRunnerGaugeLines(entries)).toHaveLength(1);

    await pool.stop();
    await registry.stop();
  });

  it('書く頻度: 本数が増えると、増えた本数で改めて1行残る', async () => {
    const stores = createMemoryStores();
    await seedRunning(stores, 'mgr-vanished-1', 'runner-gone', '2026-09-24T00:00:00.000Z');
    const registry = createRunnerRegistry([]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    await pool.list();
    await seedRunning(stores, 'mgr-vanished-2', 'runner-gone', '2026-09-24T00:05:00.000Z');
    await pool.list();

    const entries = await stores.journal.list({ order: 'asc' });
    const lines = vanishedRunnerGaugeLines(entries);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('running のまま残っている委譲が 1 本ある');
    expect(lines[1]).toContain('running のまま残っている委譲が 2 本ある');

    await pool.stop();
    await registry.stop();
  });

  // `#journal()` 自身が append の失敗を飲むため、この歯は try/catch を外しても赤くならない。それでも固定するのは、「`#journal` が reject しても list() が同じ結果を返す」要件への回帰試験だから。
  it('journal.append が失敗しても、list() は例外を投げず同じ結果を返す', async () => {
    clearRecentTracesForTesting();
    const stores = failingJournalAppend(createMemoryStores(), 'journal down (#1212)');
    await seedRunning(stores, 'mgr-vanished', 'runner-gone', '2026-09-24T00:00:00.000Z');
    const registry = createRunnerRegistry([]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    const listed = await pool.list();

    expect(listed.find((m) => m.managerId === 'mgr-vanished')?.status).toBe('running');
    expect(recentDroppedTraces().some((line) => line.includes('日誌を記録できませんでした'))).toBe(
      true,
    );

    await pool.stop();
    await registry.stop();
  });

  // `#journal` 自身の try/catch は append の失敗しか守らない: 呼ぶ前の計算が投げる経路は `#noteVanishedRunnerGauge` 全体の try/catch が守っており、外すと赤くなるのはこの歯だけ。
  it('計器の集計・整形（#journal を呼ぶ前）が例外を投げても、list() は例外を投げず同じ結果を返す', async () => {
    const stores = createMemoryStores();
    await seedRunning(stores, 'mgr-vanished', 'runner-gone', '2026-09-24T00:00:00.000Z');
    const registry = createRunnerRegistry([]);
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      now: () => {
        throw new Error('clock down (#1212 test)');
      },
    });

    const listed = await pool.list();

    expect(listed.find((m) => m.managerId === 'mgr-vanished')?.status).toBe('running');

    await pool.stop();
    await registry.stop();
  });
});

describe('runner にセッションが無い相手への manager_send（#563）', () => {
  const attachedJob = {
    id: 'mgr-orphan',
    managerId: 'mgr-orphan',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '調べもの',
    request: '調べておいて',
    cwd: '/work/project',
    runnerId: 'runner-primary',
  };

  // `attached` を直に立てない: 「runner が一覧に載せていた」ことを根拠に立てる本物の経路を通さないと、`attached` が嘘になる窓を再現したことにならない。
  async function attached(sessionId: string | undefined) {
    const stores = createMemoryStores();
    await stores.jobs.putJob({
      ...attachedJob,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    const fake = swappableRunner();
    fake.state.alive.push({
      managerId: attachedJob.id,
      status: 'running',
      cwd: attachedJob.cwd,
      request: attachedJob.request,
      waiting: [],
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    const s = setup(undefined, { stores, runner: fake.runner });
    await s.pool.restore();
    return { fake, s };
  }

  const summaryOf = async (pool: ManagerPool) =>
    (await pool.list()).find((m) => m.managerId === attachedJob.id);

  it('404 を受けて resume に成功したら delivered（例外は貫通しない・印は消える）', async () => {
    const { fake, s } = await attached('sess-1');
    fake.vanish(attachedJob.id);

    const result = await s.pool.send(attachedJob.id, '続きを頼む');

    expect(result.outcome).toBe('delivered');
    expect(result.detail).not.toBe('追加指示として届けた。');
    expect(fake.state.resumes.map((r) => r.managerId)).toEqual([attachedJob.id]);
    expect(fake.state.sends).toEqual([attachedJob.id]);

    const summary = await summaryOf(s.pool);
    expect(summary?.sessionMissingSince).toBeUndefined();
    expect(summary?.live).toBe(true);

    await s.pool.stop();
  });

  it('404 を受けて resume にも失敗したら session_missing（unknown へ畳まない）', async () => {
    const { fake, s } = await attached(undefined);
    fake.vanish(attachedJob.id);

    const result = await s.pool.send(attachedJob.id, '続きを頼む');

    // `'unknown'` へ畳まない: `app.ts` が 404 を返し、台帳に在る委譲が「そんなものは無い」としか読めなくなるため。
    expect(result.outcome).toBe('session_missing');
    expect(result.outcome).not.toBe('unknown');

    await s.pool.stop();
  });

  it('send() は例外を投げない（貫通していた壊れ方をそのまま歯にする）', async () => {
    const { fake, s } = await attached(undefined);
    fake.vanish(attachedJob.id);

    await expect(s.pool.send(attachedJob.id, '続きを頼む')).resolves.toMatchObject({
      outcome: 'session_missing',
    });

    await s.pool.stop();
  });

  it('resume にも失敗した委譲は、list() が sessionMissingSince を出す（live は落ちない）', async () => {
    const { fake, s } = await attached(undefined);
    fake.vanish(attachedJob.id);
    await s.pool.send(attachedJob.id, '続きを頼む');

    const summary = await summaryOf(s.pool);
    expect(summary?.sessionMissingSince).toBeDefined();
    expect(summary?.status).toBe('running');
    expect(summary?.runnerLostSince).toBeUndefined();

    await s.pool.stop();
  });

  // 次の2本は対で読む（違いは `list()` が答えるか投げるかだけ）: 片方だけだと「常に付ける」実装や「何も無い」実装でも通り、「答えたうえで載せなかった」と「聞けなかった」を分けられない。
  it('reattach: runner が答えて一覧に載せず resume も失敗したら、印が付く', async () => {
    const { fake, s } = await attached(undefined);
    fake.vanish(attachedJob.id);

    fake.reconnect();
    await expect
      .poll(async () => (await summaryOf(s.pool))?.sessionMissingSince, { timeout: 2000 })
      .toBeDefined();

    expect(fake.state.sends).toEqual([]);

    await s.pool.stop();
  });

  it('reattach: runner が list() に答えられないときは印を付けない（聞けなかった ≠ 無い）', async () => {
    // 「応答が無い」を「セッションが無い」と読まない: 走っているマネージャーを一覧が「セッションが無い」と名乗ることになる。`#restoreJobs` と `#reattach` も同じ歯止めを持つ。
    const { fake, s } = await attached(undefined);
    fake.vanish(attachedJob.id);
    fake.state.listThrows = true;
    fake.state.listCalls = 0;

    fake.reconnect();
    await expect.poll(() => fake.state.listCalls, { timeout: 2000 }).toBeGreaterThan(0);

    const summary = await summaryOf(s.pool);
    expect(summary?.sessionMissingSince).toBeUndefined();
    expect(summary?.status).toBe('running');

    await s.pool.stop();
  });
});

// 実物の heartbeat は回さない: 観測が名簿へどう立つかは `runner-heartbeat.test.ts` が固定しており、ここは名簿に立った観測を `Pool` がどう読むかだけを見るため、`entries()` へ直接差し込む。
describe('生存確認が観測した sessions から sessionMissingSince を立てる（#579）', () => {
  // `runnerId` ではなく `label` で差し込む: 同じ `runnerId` の行が複数在る場合（下の「和を採る」歯）を行の label で区別するため。
  // `patches()` は呼ぶたびに評価し直す: 同じテスト内で観測を差し替えて2周目以降の `pool.list()` を呼べるようにするため。
  function withEntrySessions(
    registry: RunnerRegistry,
    patches: () => ReadonlyMap<string, { sessions: readonly string[]; sessionsObservedAt: string }>,
  ): RunnerRegistry {
    return {
      list: () => registry.list(),
      get: (id) => registry.get(id),
      select: (input) => registry.select(input),
      register: (source) => registry.register(source),
      unregister: (label) => registry.unregister(label),
      vacate: (id) => registry.vacate(id),
      noteManagerFailed: (id) => registry.noteManagerFailed(id),
      subscribe: (onOpen) => registry.subscribe(onOpen),
      stop: () => registry.stop(),
      entries: () =>
        registry.entries().map((entry) => {
          const patch = patches().get(entry.label);
          return patch === undefined ? entry : { ...entry, ...patch };
        }),
    };
  }

  it('走行中の委譲を runner が一覧に載せなくなると、誰も send() を打たず hello も来ないのに pool.list() の sessionMissingSince が立つ（#579 本題）', async () => {
    let clock = new Date('2026-08-27T09:00:00.000Z').getTime();
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const stores = createMemoryStores();
    const real = createRunnerRegistry([a]);
    const patches = new Map<string, { sessions: readonly string[]; sessionsObservedAt: string }>();
    const registry = withEntrySessions(real, () => patches);
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      now: () => clock,
    });

    const summary = await pool.start({ request: '調べもの' });
    expect(a.started).toEqual([summary.managerId]);

    clock += 10_000;
    patches.set('runner-a', { sessions: [], sessionsObservedAt: new Date(clock).toISOString() });

    const listed = await pool.list();
    const found = listed.find((m) => m.managerId === summary.managerId);

    expect(found?.sessionMissingSince).toBeDefined();
    expect(found?.status).toBe('running');
    expect(a.started).toEqual([summary.managerId]);

    await pool.stop();
    await real.stop();
  });

  it('runner が載せているうちは立たない', async () => {
    let clock = new Date('2026-08-27T09:00:00.000Z').getTime();
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const stores = createMemoryStores();
    const real = createRunnerRegistry([a]);
    const patches = new Map<string, { sessions: readonly string[]; sessionsObservedAt: string }>();
    const registry = withEntrySessions(real, () => patches);
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      now: () => clock,
    });

    const summary = await pool.start({ request: '調べもの' });

    clock += 10_000;
    patches.set('runner-a', {
      sessions: [summary.managerId],
      sessionsObservedAt: new Date(clock).toISOString(),
    });

    const listed = await pool.list();
    const found = listed.find((m) => m.managerId === summary.managerId);

    expect(found?.sessionMissingSince).toBeUndefined();

    await pool.stop();
    await real.stop();
  });

  describe('runnerListedAt: runner の一覧に載っていた観測を写す', () => {
    const at = '2026-08-27T00:00:00.000Z';
    const observedAt = '2026-08-27T00:00:10.000Z';
    async function setup(patch: { sessions: readonly string[]; state?: string } | null) {
      const stores = createMemoryStores();
      await stores.jobs.putJob({
        id: 'mgr-done',
        managerId: 'mgr-done',
        createdAt: at,
        updatedAt: at,
        status: 'done',
        summary: '終わった',
        request: '頼んだ',
        cwd: '/work/project',
        runnerId: 'runner-a',
        sessionId: 'sess-done',
      } as Job);
      const a = new FakePoolRunner('runner-a', { managers: 0 });
      const real = createRunnerRegistry([a]);
      const patches = new Map<
        string,
        { sessions: readonly string[]; sessionsObservedAt: string }
      >();
      if (patch !== null) {
        patches.set('runner-a', {
          ...patch,
          sessionsObservedAt: observedAt,
        } as unknown as { sessions: readonly string[]; sessionsObservedAt: string });
      }
      const pool = createManagerPool({
        stores,
        post: () => undefined,
        runners: withEntrySessions(real, () => patches),
      });
      await pool.restore();
      const found = (await pool.list()).find((m) => m.managerId === 'mgr-done');
      await pool.stop();
      await real.stop();
      return found;
    }

    it('done でも、runner が一覧に載せていれば観測時刻が立つ（status は動かない）', async () => {
      const found = await setup({ sessions: ['mgr-done'] });
      expect(found?.status).toBe('done');
      expect(found?.runnerListedAt).toBe(observedAt);
    });

    it('一覧に載っていなければ立たない', async () => {
      expect((await setup({ sessions: ['other'] }))?.runnerListedAt).toBeUndefined();
      expect((await setup({ sessions: [] }))?.runnerListedAt).toBeUndefined();
    });

    it('まだ聞けていない（sessions が無い）なら立たない', async () => {
      expect((await setup(null))?.runnerListedAt).toBeUndefined();
    });

    it('黙った器（lost）の一覧は根拠にしない', async () => {
      const found = await setup({ sessions: ['mgr-done'], state: 'lost' });
      expect(found?.runnerListedAt).toBeUndefined();
    });
  });

  // `done` は対象外: runner がセッションを畳むのが正常な回もあり、⚠ を付けると本当に困っている1本が埋もれる。`start()` は必ず `running` で始まるので、台帳へ直接置いて `restore()` で作る。
  it('待機中（done）の委譲には立たない', async () => {
    const stores = createMemoryStores();
    const at = '2026-08-27T00:00:00.000Z';
    await stores.jobs.putJob({
      id: 'mgr-done',
      managerId: 'mgr-done',
      createdAt: at,
      updatedAt: at,
      status: 'done',
      summary: '終わった',
      request: '頼んだ',
      cwd: '/work/project',
      runnerId: 'runner-a',
      sessionId: 'sess-done',
    } as Job);
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const real = createRunnerRegistry([a]);
    const patches = new Map<string, { sessions: readonly string[]; sessionsObservedAt: string }>();
    const registry = withEntrySessions(real, () => patches);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    await pool.restore();
    patches.set('runner-a', { sessions: [], sessionsObservedAt: '2026-08-27T00:00:10.000Z' });

    const listed = await pool.list();
    const found = listed.find((m) => m.managerId === 'mgr-done');

    expect(found?.status).toBe('done');
    expect(found?.sessionMissingSince).toBeUndefined();

    await pool.stop();
    await real.stop();
  });

  it('起こした直後の窓では立たない（観測時刻が runnerSessionSince より古い）', async () => {
    const clock = new Date('2026-08-27T09:00:00.000Z').getTime();
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const stores = createMemoryStores();
    const real = createRunnerRegistry([a]);
    const patches = new Map<string, { sessions: readonly string[]; sessionsObservedAt: string }>();
    const registry = withEntrySessions(real, () => patches);
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      now: () => clock,
    });

    patches.set('runner-a', {
      sessions: [],
      sessionsObservedAt: new Date(clock - 5_000).toISOString(),
    });

    const summary = await pool.start({ request: '起こしたて' });
    const listed = await pool.list();
    const found = listed.find((m) => m.managerId === summary.managerId);

    expect(found?.sessionMissingSince).toBeUndefined();

    await pool.stop();
    await real.stop();
  });

  it('一度立った後、より新しい観測で runner が載せていたら消える', async () => {
    let clock = new Date('2026-08-27T09:00:00.000Z').getTime();
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const stores = createMemoryStores();
    const real = createRunnerRegistry([a]);
    const patches = new Map<string, { sessions: readonly string[]; sessionsObservedAt: string }>();
    const registry = withEntrySessions(real, () => patches);
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      now: () => clock,
    });

    const summary = await pool.start({ request: '調べもの' });

    clock += 10_000;
    patches.set('runner-a', { sessions: [], sessionsObservedAt: new Date(clock).toISOString() });
    const first = (await pool.list()).find((m) => m.managerId === summary.managerId);
    expect(first?.sessionMissingSince).toBeDefined();

    clock += 10_000;
    patches.set('runner-a', {
      sessions: [summary.managerId],
      sessionsObservedAt: new Date(clock).toISOString(),
    });
    const second = (await pool.list()).find((m) => m.managerId === summary.managerId);
    expect(second?.sessionMissingSince).toBeUndefined();

    await pool.stop();
    await real.stop();
  });

  it('同じ runnerId の行が2つ在り、片方が抱えていると答えたら立たない（和を採る）', async () => {
    let clock = new Date('2026-08-27T09:00:00.000Z').getTime();
    const oldClient = new FakePoolRunner('runner-a', { managers: 0 });
    const newClient = new FakePoolRunner('runner-a', { managers: 0 });
    const stores = createMemoryStores();
    const real = createRunnerRegistry([]);
    await real.register({ label: 'runner-a-old', open: async () => oldClient });
    await real.register({ label: 'runner-a-new', open: async () => newClient });
    const patches = new Map<string, { sessions: readonly string[]; sessionsObservedAt: string }>();
    const registry = withEntrySessions(real, () => patches);
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      now: () => clock,
    });

    const summary = await pool.start({ request: '調べもの' });

    clock += 10_000;
    const observedAt = new Date(clock).toISOString();
    patches.set('runner-a-old', { sessions: [], sessionsObservedAt: observedAt });
    patches.set('runner-a-new', { sessions: [summary.managerId], sessionsObservedAt: observedAt });

    const listed = await pool.list();
    const found = listed.find((m) => m.managerId === summary.managerId);

    expect(found?.sessionMissingSince).toBeUndefined();

    await pool.stop();
    await real.stop();
  });

  // 皮を使わない: 皮は差し込んだ値をそのまま読むので、`#probeSessions` が書く欄名と `#runnerSessions()` が読む欄名が食い違っていても緑のままになる。
  it('通しの歯: 本物の生存確認を1周させると、pool.list() の sessionMissingSince が実際に立つ（皮を使わない）', async () => {
    vi.useFakeTimers();
    try {
      const a = new FakePoolRunner('runner-a', { managers: 0 });
      const stores = createMemoryStores();
      const registry = createRunnerRegistry([a]);
      // `now` を渡さない: 観測が `runnerSessionSince` より新しくないと立たないので、既定の `Date.now()` に擬似時計を読ませて時計を揃える。
      const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

      const summary = await pool.start({ request: '調べもの' });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(a.listCalls).toBeGreaterThan(0);

      const listed = await pool.list();
      const found = listed.find((m) => m.managerId === summary.managerId);

      expect(found?.sessionMissingSince).toBeDefined();

      await pool.stop();
      await registry.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('shutdownObservationArrivedAfterSwap（クローンの指摘を受けて追加。PR #1266 候補C）', () => {
  function withEntrySessions(
    registry: RunnerRegistry,
    patches: () => ReadonlyMap<string, { sessions: readonly string[]; sessionsObservedAt: string }>,
  ): RunnerRegistry {
    return {
      list: () => registry.list(),
      get: (id) => registry.get(id),
      select: (input) => registry.select(input),
      register: (source) => registry.register(source),
      unregister: (label) => registry.unregister(label),
      vacate: (id) => registry.vacate(id),
      noteManagerFailed: (id) => registry.noteManagerFailed(id),
      subscribe: (onOpen) => registry.subscribe(onOpen),
      stop: () => registry.stop(),
      entries: () =>
        registry.entries().map((entry) => {
          const patch = patches().get(entry.label);
          return patch === undefined ? entry : { ...entry, ...patch };
        }),
    };
  }

  it('runnerSessionSince より後に取れた source:shutdown の観測は「届いた」と判定する', async () => {
    let clock = new Date('2026-09-27T00:00:00.000Z').getTime();
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const stores = createMemoryStores();
    const real = createRunnerRegistry([a]);
    const patches = new Map<string, { sessions: readonly string[]; sessionsObservedAt: string }>();
    const registry = withEntrySessions(real, () => patches);
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      now: () => clock,
    });

    const summary = await pool.start({ request: '調べもの' });
    const managerId = summary.managerId;

    clock += 5_000;
    a.unpushedWorkResult = {
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'feat/shutdown-arrived' }],
    };
    await pool.unpushedWork(managerId, { source: 'shutdown' });

    clock += 10_000;
    patches.set('runner-a', { sessions: [], sessionsObservedAt: new Date(clock).toISOString() });

    const listed = await pool.list();
    const found = listed.find((m) => m.managerId === managerId);

    expect(found?.sessionMissingSince).toBeDefined();
    expect(found?.shutdownObservationArrivedAfterSwap).toBe(true);
    expect(found?.lastUnpushedWorkObservation).toMatchObject({
      source: 'shutdown',
      worktrees: [{ branch: 'feat/shutdown-arrived' }],
    });

    await pool.stop();
    await real.stop();
  });

  it('runnerSessionSince より前（古いセッションが残した）source:shutdown の観測は「届いていない」に倒す', async () => {
    let clock = new Date('2026-09-27T00:00:00.000Z').getTime();
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const stores = createMemoryStores();
    const real = createRunnerRegistry([a]);
    const patches = new Map<string, { sessions: readonly string[]; sessionsObservedAt: string }>();
    const registry = withEntrySessions(real, () => patches);
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      now: () => clock,
    });

    const summary = await pool.start({ request: '調べもの' });
    const managerId = summary.managerId;

    clock += 1_000;
    a.unpushedWorkResult = {
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'feat/stale-shutdown' }],
    };
    await pool.unpushedWork(managerId, { source: 'shutdown' });

    clock += 2_000;
    a.onEvent?.({ type: 'session', managerId, sessionId: 'sess-resumed' });
    await expect
      .poll(async () => (await stores.jobs.listJobs())[0]?.sessionId, { timeout: 2000 })
      .toBe('sess-resumed');

    clock += 10_000;
    patches.set('runner-a', { sessions: [], sessionsObservedAt: new Date(clock).toISOString() });

    const listed = await pool.list();
    const found = listed.find((m) => m.managerId === managerId);

    expect(found?.sessionMissingSince).toBeDefined();
    expect(found?.shutdownObservationArrivedAfterSwap).toBe(false);
    expect(found?.lastUnpushedWorkObservation).toMatchObject({
      source: 'shutdown',
      worktrees: [{ branch: 'feat/stale-shutdown' }],
    });

    await pool.stop();
    await real.stop();
  });

  it('source が shutdown 以外（例: report）の観測は、runnerSessionSince より後でも「届いていない」に倒す', async () => {
    let clock = new Date('2026-09-27T00:00:00.000Z').getTime();
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const stores = createMemoryStores();
    const real = createRunnerRegistry([a]);
    const patches = new Map<string, { sessions: readonly string[]; sessionsObservedAt: string }>();
    const registry = withEntrySessions(real, () => patches);
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      now: () => clock,
    });

    const summary = await pool.start({ request: '調べもの' });
    const managerId = summary.managerId;

    clock += 5_000;
    a.unpushedWorkResult = { cwd: '/work/project', worktrees: [] };
    await pool.unpushedWork(managerId, { source: 'report' });

    clock += 10_000;
    patches.set('runner-a', { sessions: [], sessionsObservedAt: new Date(clock).toISOString() });

    const listed = await pool.list();
    const found = listed.find((m) => m.managerId === managerId);

    expect(found?.sessionMissingSince).toBeDefined();
    expect(found?.shutdownObservationArrivedAfterSwap).toBe(false);
    expect(found?.lastUnpushedWorkObservation).toMatchObject({ source: 'report' });

    await pool.stop();
    await real.stop();
  });

  it('source が stop（Issue #1266 残り2。force:true 等の明示停止）の観測も、runnerSessionSince より後でも「届いていない」に倒す', async () => {
    let clock = new Date('2026-09-27T00:00:00.000Z').getTime();
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const stores = createMemoryStores();
    const real = createRunnerRegistry([a]);
    const patches = new Map<string, { sessions: readonly string[]; sessionsObservedAt: string }>();
    const registry = withEntrySessions(real, () => patches);
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      now: () => clock,
    });

    const summary = await pool.start({ request: '調べもの' });
    const managerId = summary.managerId;

    clock += 5_000;
    a.unpushedWorkResult = { cwd: '/work/project', worktrees: [] };
    await pool.unpushedWork(managerId, { source: 'stop' });

    clock += 10_000;
    patches.set('runner-a', { sessions: [], sessionsObservedAt: new Date(clock).toISOString() });

    const listed = await pool.list();
    const found = listed.find((m) => m.managerId === managerId);

    expect(found?.sessionMissingSince).toBeDefined();
    expect(found?.shutdownObservationArrivedAfterSwap).toBe(false);
    expect(found?.lastUnpushedWorkObservation).toMatchObject({ source: 'stop' });

    await pool.stop();
    await real.stop();
  });

  it('sessionMissingSince が立っていなければ欄ごと消える（判定そのものが要らない）', async () => {
    let clock = new Date('2026-09-27T00:00:00.000Z').getTime();
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([a]);
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      now: () => clock,
    });

    const summary = await pool.start({ request: '調べもの' });
    const managerId = summary.managerId;

    clock += 5_000;
    a.unpushedWorkResult = {
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'feat/normal' }],
    };
    await pool.unpushedWork(managerId, { source: 'shutdown' });

    const listed = await pool.list();
    const found = listed.find((m) => m.managerId === managerId);

    expect(found?.sessionMissingSince).toBeUndefined();
    expect(found?.shutdownObservationArrivedAfterSwap).toBeUndefined();

    await pool.stop();
    await registry.stop();
  });
});

describe('sessionMissingKind: 由来を畳まない（#579）', () => {
  const jobId = 'mgr-kind';
  const at = '2026-08-01T00:00:00.000Z';

  function withEntrySessions(
    registry: RunnerRegistry,
    patches: () => ReadonlyMap<string, { sessions: readonly string[]; sessionsObservedAt: string }>,
  ): RunnerRegistry {
    return {
      list: () => registry.list(),
      get: (id) => registry.get(id),
      select: (input) => registry.select(input),
      register: (source) => registry.register(source),
      unregister: (label) => registry.unregister(label),
      vacate: (id) => registry.vacate(id),
      noteManagerFailed: (id) => registry.noteManagerFailed(id),
      subscribe: (onOpen) => registry.subscribe(onOpen),
      stop: () => registry.stop(),
      entries: () =>
        registry.entries().map((entry) => {
          const patch = patches().get(entry.label);
          return patch === undefined ? entry : { ...entry, ...patch };
        }),
    };
  }

  // `sessionId` を持たせない: 戻る先が無く、404 のあとの resume が必ず `no-session` で失敗して `'resume-failed'` を確実に作れるため。
  async function setupKind() {
    const stores = createMemoryStores();
    await stores.jobs.putJob({
      id: jobId,
      managerId: jobId,
      createdAt: at,
      updatedAt: at,
      status: 'running',
      summary: '調べもの',
      request: '調べておいて',
      cwd: '/work/project',
      runnerId: 'runner-primary',
    } as Job);
    const fake = swappableRunner('runner-primary');
    fake.state.alive.push({
      managerId: jobId,
      status: 'running',
      cwd: '/work/project',
      request: '調べておいて',
      waiting: [],
    });
    const real = createRunnerRegistry([fake.runner]);
    const patches = new Map<string, { sessions: readonly string[]; sessionsObservedAt: string }>();
    const registry = withEntrySessions(real, () => patches);
    return { stores, fake, real, patches, registry };
  }

  it('生存確認由来で立った印は unlisted である', async () => {
    let clock = new Date('2026-08-27T09:00:00.000Z').getTime();
    const { stores, registry, patches, real } = await setupKind();
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      now: () => clock,
    });
    await pool.restore();

    clock += 10_000;
    patches.set('runner-primary', {
      sessions: [],
      sessionsObservedAt: new Date(clock).toISOString(),
    });

    const listed = await pool.list();
    const found = listed.find((m) => m.managerId === jobId);

    expect(found?.sessionMissingSince).toBeDefined();
    expect(found?.sessionMissingKind).toBe('unlisted');

    await pool.stop();
    await real.stop();
  });

  it('格上げ: unlisted が立っている委譲へ send() して resume でも入り直せなかったら resume-failed へ変わる（時刻は最初のまま動かない）', async () => {
    let clock = new Date('2026-08-27T09:00:00.000Z').getTime();
    const { stores, fake, registry, patches, real } = await setupKind();
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      now: () => clock,
    });
    await pool.restore();

    clock += 10_000;
    const firstAt = new Date(clock).toISOString();
    patches.set('runner-primary', { sessions: [], sessionsObservedAt: firstAt });
    const beforeSend = (await pool.list()).find((m) => m.managerId === jobId);
    expect(beforeSend?.sessionMissingKind).toBe('unlisted');
    expect(beforeSend?.sessionMissingSince).toBe(firstAt);

    fake.vanish(jobId);
    clock += 10_000;
    await pool.send(jobId, '続きを頼む');

    const after = (await pool.list()).find((m) => m.managerId === jobId);
    expect(after?.sessionMissingKind).toBe('resume-failed');
    expect(after?.sessionMissingSince).toBe(firstAt);

    await pool.stop();
    await real.stop();
  });

  it('格下げはしない: resume-failed が立っている委譲を、その後の生存確認の観測が unlisted へ戻さない', async () => {
    let clock = new Date('2026-08-27T09:00:00.000Z').getTime();
    const { stores, fake, registry, patches, real } = await setupKind();
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: registry,
      now: () => clock,
    });
    await pool.restore();

    fake.vanish(jobId);
    clock += 5_000;
    await pool.send(jobId, '続きを頼む');
    const afterSend = (await pool.list()).find((m) => m.managerId === jobId);
    expect(afterSend?.sessionMissingKind).toBe('resume-failed');
    const sinceAfterSend = afterSend?.sessionMissingSince;
    expect(sinceAfterSend).toBeDefined();

    clock += 10_000;
    patches.set('runner-primary', {
      sessions: [],
      sessionsObservedAt: new Date(clock).toISOString(),
    });
    const afterHeartbeat = (await pool.list()).find((m) => m.managerId === jobId);
    expect(afterHeartbeat?.sessionMissingKind).toBe('resume-failed');
    expect(afterHeartbeat?.sessionMissingSince).toBe(sinceAfterSend);

    await pool.stop();
    await real.stop();
  });

  it('消えるときは時刻と由来が必ず一緒に消える（片方だけ残らない）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob({
      id: jobId,
      managerId: jobId,
      createdAt: at,
      updatedAt: at,
      status: 'running',
      summary: '調べもの',
      request: '調べておいて',
      cwd: '/work/project',
      runnerId: 'runner-primary',
      sessionId: 'sess-kind',
    } as Job);
    const fake = swappableRunner('runner-primary');
    fake.state.alive.push({
      managerId: jobId,
      status: 'running',
      cwd: '/work/project',
      request: '調べておいて',
      waiting: [],
      sessionId: 'sess-kind',
    });
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: createRunnerRegistry([fake.runner]),
    });
    await pool.restore();

    fake.vanish(jobId);
    await pool.send(jobId, '続きを頼む');

    const listed = await pool.list();
    const found = listed.find((m) => m.managerId === jobId);
    expect(found?.sessionMissingSince).toBeUndefined();
    expect(found?.sessionMissingKind).toBeUndefined();

    await pool.stop();
  });
});

// 投げ直しは測らない: マネージャーの委譲経路にはその応答を読んで判断し直す相手がいない（`tools.ts` の `appendJournalOrThrow` とは非対称）。測るのは「跡が残ること」だけ。
describe('穴C: #pushProfile が journal.append の失敗で跡を残す', () => {
  it('プロファイル同期が失敗し、日誌への記録も失敗すると self_dropped の帳面に跡が残る', async () => {
    clearRecentTracesForTesting();
    const stores = failingJournalAppend(createMemoryStores(), 'journal down (test)');
    // ストアへ直接仕込む: `profile_write` 経由だとその道具自身の `journal.append` も壊れた stores を通り、「#pushProfile 側の跡」に別の跡が混ざる。
    await stores.profile.set('default', 'export A=1', 'all');
    const s = setup(undefined, { stores });
    // プロファイルを仕込んだうえで `runner.setProfile` だけを失敗させる: 何も置かないと `syncRunner` が `null` を返し、`#pushProfile` が日誌へ触る前に return する。
    s.runner.setProfile = async () => ({ ok: false, error: 'profile sync failed (test)' });

    await s.pool.start({ request: '調べて' });
    await s.pool.stop();

    const traces = recentDroppedTraces();
    expect(traces.some((line) => line.includes('日誌を記録できませんでした'))).toBe(true);
  });
});

describe('穴C: #pushAgentToken が journal.append の失敗で跡を残す', () => {
  it('認証トークンの同期が失敗し、日誌への記録も失敗すると self_dropped の帳面に跡が残る', async () => {
    clearRecentTracesForTesting();
    const stores = failingJournalAppend(
      createMemoryStores(),
      'journal down (test, pushAgentToken)',
    );
    // `syncRunnerToken` を注入して投げさせる: 未注入だと `#pushAgentToken` が日誌へ触る前に return する。
    const s = setup(undefined, {
      stores,
      syncRunnerToken: async () => {
        throw new Error('token sync failed (test)');
      },
    });

    await s.pool.start({ request: '調べて' });
    await s.pool.stop();

    const traces = recentDroppedTraces();
    // `with=self role=outbound` まで見る: 壊れた stores では委譲のライフサイクル由来の `with=manager` の跡も同じ「日誌を記録できませんでした」を名乗るため、文言だけだと `#pushAgentToken` の catch を揉み消しに戻しても緑のままになる。`with=self` は `#pushProfile`（この it ではプロファイル未設定で return）と `#pushAgentToken` しか使わない。
    expect(
      traces.some(
        (line) =>
          line.includes('日誌を記録できませんでした') && line.includes('with=self role=outbound'),
      ),
    ).toBe(true);
  });
});

describe('マネージャー — case archive は diverged/unknown だけを日誌へ記録する（#698）', () => {
  async function firePreCompact(session: FakeSession, dir: string, body: string): Promise<void> {
    const transcriptPath = join(
      dir,
      `t-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
    await writeFile(transcriptPath, body, 'utf8');
    const matchers = session.options.hooks?.PreCompact as HookCallbackMatcher[] | undefined;
    for (const matcher of matchers ?? []) {
      for (const hook of matcher.hooks) {
        await hook({ transcript_path: transcriptPath } as never, undefined, {
          signal: new AbortController().signal,
        });
      }
    }
  }

  async function continuityRows(stores: Stores): Promise<{ text: string }[]> {
    const entries = await stores.journal.list({ types: ['exchange'] });
    return entries
      .filter(
        (entry): entry is Extract<JournalEntry, { type: 'exchange' }> =>
          entry.type === 'exchange' && entry.text.includes('マネージャーの生ログの退避'),
      )
      .map((entry) => ({ text: entry.text }));
  }

  it('continues は記録されない。diverged/unknown だけが記録され、文言はマネージャーの呼び手を名乗る', async () => {
    const s = setup();
    await s.pool.start({ request: 'デプロイして' });
    const session = s.sessions[0] as FakeSession;
    const dir = await makeTempDir('alteroid-mgr-archive-continuity-');
    try {
      await firePreCompact(session, dir, 'AAAA');
      await firePreCompact(session, dir, 'AAAABBBB');
      await firePreCompact(session, dir, 'ZZZZZZZZZZZZ');

      await vi.waitFor(async () => {
        expect((await s.stores.archive.list()).length).toBe(3);
      });

      const rows = await continuityRows(s.stores);
      expect(rows.some((row) => row.text.includes('continuity=continues'))).toBe(false);
      expect(rows.some((row) => row.text.includes('continuity=first'))).toBe(false);
      expect(rows.some((row) => row.text.includes('continuity=diverged'))).toBe(true);
      expect(rows.some((row) => row.text.includes('AAAA'))).toBe(false);
      expect(rows.some((row) => row.text.includes('ZZZZZZZZZZZZ'))).toBe(false);
      // 囲みの飾り（`[…]`）ではなく呼び手の名前そのものを見る: 飾りを変えるだけで赤くなるのは当てすぎ。
      expect(rows.some((row) => row.text.includes('マネージャーの生ログの退避'))).toBe(true);
    } finally {
      await s.pool.stop();
    }
  });

  it('unknown（直前が指紋を持たない）も記録される', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, { stores });
    const { managerId } = await s.pool.start({ request: 'デプロイして' });
    const session = s.sessions[0] as FakeSession;
    const dir = await makeTempDir('alteroid-mgr-archive-unknown-');
    try {
      await seedFingerprintlessArchiveRow(stores.archive, managerId, 'LEGACY\n');

      await firePreCompact(session, dir, 'LEGACY\nNEW\n');

      await vi.waitFor(async () => {
        expect((await stores.archive.list()).length).toBe(2);
      });

      const rows = await continuityRows(stores);
      expect(rows.some((row) => row.text.includes('continuity=unknown'))).toBe(true);
    } finally {
      await s.pool.stop();
    }
  });
});

describe('runningManagerPinning / guardArchiveRemoval の requireContainment（#698）', () => {
  async function firePreCompact(session: FakeSession, dir: string, body: string): Promise<void> {
    const transcriptPath = join(
      dir,
      `t-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
    await writeFile(transcriptPath, body, 'utf8');
    const matchers = session.options.hooks?.PreCompact as HookCallbackMatcher[] | undefined;
    for (const matcher of matchers ?? []) {
      for (const hook of matcher.hooks) {
        await hook({ transcript_path: transcriptPath } as never, undefined, {
          signal: new AbortController().signal,
        });
      }
    }
  }

  async function seedTwoArchivedCopies(
    s: Setup,
  ): Promise<{ managerId: string; oldId: string; newId: string; dir: string }> {
    const { managerId } = await s.pool.start({ request: 'デプロイして' });
    const session = s.sessions[0] as FakeSession;
    const dir = await makeTempDir('alteroid-mgr-archive-pinning-');
    await firePreCompact(session, dir, 'PIN-A'.repeat(20));
    await firePreCompact(session, dir, 'PIN-A'.repeat(20) + 'PIN-B'.repeat(20));
    await vi.waitFor(async () => {
      expect((await s.stores.archive.list()).length).toBe(2);
    });
    const rows = await s.stores.archive.list();
    const oldRow = rows.find((r) => r.continuity === 'first');
    const newRow = rows.find((r) => r.continuity === 'continues');
    expect(oldRow, '1本目（first）が見つからない').toBeDefined();
    expect(newRow, '2本目（continues）が見つからない').toBeDefined();
    return { managerId, oldId: oldRow!.id, newId: newRow!.id, dir };
  }

  function pinningOf(pool: ManagerPool): (archiveId: string) => string | undefined {
    expect(
      pool.runningManagerPinning,
      '実物の Pool は runningManagerPinning を実装するはず',
    ).toBeDefined();
    return pool.runningManagerPinning!.bind(pool);
  }

  it('末尾（新しい写し）は runningManagerOwning でも runningManagerPinning でも保護される', async () => {
    const s = setup();
    const { managerId, newId } = await seedTwoArchivedCopies(s);
    try {
      expect(s.pool.runningManagerOwning(newId)).toBe(managerId);
      expect(pinningOf(s.pool)(newId)).toBe(managerId);
    } finally {
      await s.pool.stop();
    }
  });

  it('末尾より古い写しは、runningManagerOwning では保護されるが runningManagerPinning では保護されない（狭まる）', async () => {
    const s = setup();
    const { managerId, oldId } = await seedTwoArchivedCopies(s);
    try {
      expect(s.pool.runningManagerOwning(oldId)).toBe(managerId);
      expect(pinningOf(s.pool)(oldId)).toBeUndefined();
    } finally {
      await s.pool.stop();
    }
  });

  it('存在しない archiveId はどちらの判定でも undefined', async () => {
    const s = setup();
    await seedTwoArchivedCopies(s);
    try {
      expect(s.pool.runningManagerOwning('archive-not-exist')).toBeUndefined();
      expect(pinningOf(s.pool)('archive-not-exist')).toBeUndefined();
    } finally {
      await s.pool.stop();
    }
  });

  describe('guardArchiveRemoval の第4引数 requireContainment', () => {
    it('requireContainment: true なら、末尾は denied・古い写しは allowed（狭まる）', async () => {
      const s = setup();
      const { managerId, oldId, newId } = await seedTwoArchivedCopies(s);
      try {
        const guardOld = guardArchiveRemoval(s.pool, oldId, undefined, true);
        const guardNew = guardArchiveRemoval(s.pool, newId, undefined, true);
        expect(guardOld).toEqual({ kind: 'allowed' });
        expect(guardNew).toEqual({ kind: 'denied', managerId });
      } finally {
        await s.pool.stop();
      }
    });

    it('requireContainment を省略（既存呼び）すると、古い写しも末尾も denied のまま——1ビットも変わらない', async () => {
      const s = setup();
      const { managerId, oldId, newId } = await seedTwoArchivedCopies(s);
      try {
        const guardOld = guardArchiveRemoval(s.pool, oldId, undefined);
        const guardNew = guardArchiveRemoval(s.pool, newId, undefined);
        expect(guardOld).toEqual({ kind: 'denied', managerId });
        expect(guardNew).toEqual({ kind: 'denied', managerId });
      } finally {
        await s.pool.stop();
      }
    });

    it('requireContainment: false なら、含有の証明が無いので狭めない——古い写しも denied のまま', async () => {
      const s = setup();
      const { managerId, oldId } = await seedTwoArchivedCopies(s);
      try {
        const guardOld = guardArchiveRemoval(s.pool, oldId, undefined, false);
        expect(guardOld).toEqual({ kind: 'denied', managerId });
      } finally {
        await s.pool.stop();
      }
    });

    it('runningManagerPinning を持たない像では、requireContainment: true でも狭めない（安全側）', () => {
      const stub = {
        runningManagerOwning: (archiveId: string) =>
          archiveId === 'old-copy' ? 'mgr-x' : undefined,
      } as unknown as ManagerPool;

      const guard = guardArchiveRemoval(stub, 'old-copy', undefined, true);
      expect(guard).toEqual({ kind: 'denied', managerId: 'mgr-x' });
    });
  });
});

describe('runner ごとの押し込み結果（pushHealth）', () => {
  it('繋がった直後、試みた分だけ ok になる（試みていない種類は省かれる）', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });

    const health = s.pool.pushHealthOf(s.runner.runnerId);
    expect(health?.profile).toEqual({ status: 'ok', at: expect.any(String) });
    expect(health?.credentials).toEqual({ status: 'ok', at: expect.any(String) });
    // `undefined` を「成功した」の既定値として埋めない: `syncRunnerToken` が無いと `#pushAgentToken` は何もせず、この種類は「まだ試みていない」まま。
    expect(health?.agentToken).toBeUndefined();

    await s.pool.stop();
  });

  it('runners()（runner_list の材料）にも同じ値が出る', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });

    const overview = await s.pool.runners();
    const entry = overview.runners.find((r) => r.runnerId === s.runner.runnerId);
    expect(entry?.pushHealth).toEqual(s.pool.pushHealthOf(s.runner.runnerId));
    expect(entry?.pushHealth?.profile?.status).toBe('ok');

    await s.pool.stop();
  });

  it('プロファイルの押し込みが失敗すると failed になり、原文の理由も残る', async () => {
    const stores = createMemoryStores();
    // 何か置いておく: 何も置かないと `syncRunner` が `null` を返し、`runner.setProfile` が呼ばれない。
    await stores.profile.set('default', 'export A=1', 'all');
    const s = setup(undefined, { stores });
    s.runner.setProfile = async () => ({ ok: false, error: 'profile sync failed (test)' });

    await s.pool.start({ request: '調べて' });

    expect(s.pool.pushHealthOf(s.runner.runnerId)?.profile).toEqual({
      status: 'failed',
      at: expect.any(String),
      error: 'profile sync failed (test)',
    });
    expect(s.pool.pushHealthOf(s.runner.runnerId)?.credentials?.status).toBe('ok');

    await s.pool.stop();
  });

  it('環境変数の押し込みが例外で失敗すると failed になる', async () => {
    const stores = createMemoryStores();
    // 何か置いておく: 正本が空だと `syncRunner` が `null` を返し、`runner.setCredentials` が呼ばれない。
    await stores.credentials.put([{ name: 'NPM_TOKEN', value: 'npm_x' }]);
    const s = setup(undefined, { stores });
    s.runner.setCredentials = async () => {
      throw new Error('credentials sync failed (test)');
    };

    await s.pool.start({ request: '調べて' });

    const outcome = s.pool.pushHealthOf(s.runner.runnerId)?.credentials;
    expect(outcome?.status).toBe('failed');
    expect(outcome?.error).toContain('credentials sync failed (test)');

    await s.pool.stop();
  });

  it('認証トークンの押し込みが失敗すると failed になる（syncRunnerToken 経由）', async () => {
    const s = setup(undefined, {
      syncRunnerToken: async () => {
        throw new Error('token sync failed (test)');
      },
    });

    await s.pool.start({ request: '調べて' });

    const outcome = s.pool.pushHealthOf(s.runner.runnerId)?.agentToken;
    expect(outcome?.status).toBe('failed');
    expect(outcome?.error).toContain('token sync failed (test)');

    await s.pool.stop();
  });

  it('名乗っていない（runnerId を持たない）行には何も記録されない', () => {
    const stores = createMemoryStores();
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: createRunnerRegistry([]),
    });
    expect(pool.pushHealthOf('never-seen')).toBeUndefined();
  });
});

describe('runner ごとの plugin の読み込み結果（pluginLoad）', () => {
  async function setupPoolWithRunner() {
    let clock = new Date('2026-10-08T00:00:00.000Z').getTime();
    const a = new FakePoolRunner('runner-a', { managers: 0 });
    const stores = createMemoryStores();
    const real = createRunnerRegistry([a]);
    const pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: real,
      now: () => clock,
    });
    const summary = await pool.start({ request: '調べもの' });
    return {
      pool,
      real,
      stores,
      a,
      managerId: summary.managerId,
      tick: (ms: number) => {
        clock += ms;
        return new Date(clock).toISOString();
      },
    };
  }

  it('一度も session を受けていない runner は undefined（0件とも失敗とも読まない）', async () => {
    const s = await setupPoolWithRunner();

    expect(s.pool.pluginLoadOf?.('runner-a')).toBeUndefined();

    await s.pool.stop();
    await s.real.stop();
  });

  it('pluginLoad を運ぶ session を受けると、runner・managerId・受けた時刻つきで控える', async () => {
    const s = await setupPoolWithRunner();
    const pluginLoad = {
      plugins: [{ name: 'p', version: '1.0.0' }],
      errors: [{ plugin: 'q', type: 'load', message: 'boom' }],
      errorsOmitted: 2,
    };

    const at = s.tick(1_000);
    s.a.onEvent?.({ type: 'session', managerId: s.managerId, sessionId: 'sess-1', pluginLoad });
    await expect
      .poll(() => s.pool.pluginLoadOf?.('runner-a'), { timeout: 2000 })
      .toEqual({ at, managerId: s.managerId, pluginLoad });

    await s.pool.stop();
    await s.real.stop();
  });

  it('後の session が上書きする。pluginLoad を持たない session は前の観測を消さない', async () => {
    const s = await setupPoolWithRunner();
    const first = { plugins: [{ name: 'first' }], errors: null };
    const second = { plugins: [{ name: 'second' }], errors: null };

    s.a.onEvent?.({
      type: 'session',
      managerId: s.managerId,
      sessionId: 'sess-1',
      pluginLoad: first,
    });
    await expect
      .poll(() => s.pool.pluginLoadOf?.('runner-a')?.pluginLoad, { timeout: 2000 })
      .toEqual(first);

    s.tick(1_000);
    s.a.onEvent?.({
      type: 'session',
      managerId: s.managerId,
      sessionId: 'sess-2',
      pluginLoad: second,
    });
    await expect
      .poll(() => s.pool.pluginLoadOf?.('runner-a')?.pluginLoad, { timeout: 2000 })
      .toEqual(second);

    s.a.onEvent?.({ type: 'session', managerId: s.managerId, sessionId: 'sess-3' });
    await expect
      .poll(async () => (await s.stores.jobs.listJobs())[0]?.sessionId, { timeout: 2000 })
      .toBe('sess-3');
    expect(s.pool.pluginLoadOf?.('runner-a')?.pluginLoad).toEqual(second);

    await s.pool.stop();
    await s.real.stop();
  });

  it('日誌へは、マネージャーごとに前回と変わったときだけ書く（同じ結果の再送は書かない）', async () => {
    const s = await setupPoolWithRunner();
    const loadTexts = async () =>
      (await s.stores.journal.list({ types: ['exchange'] })).flatMap((entry) =>
        entry.type === 'exchange' && entry.text.includes('plugin の読み込み結果')
          ? [entry.text]
          : [],
      );
    const first = { plugins: [{ name: 'first', version: '1.0.0' }], errors: null };
    const second = {
      plugins: [{ name: 'second' }],
      errors: [{ plugin: 'q', type: 'load', message: 'boom' }],
    };

    for (const [id, pluginLoad] of [
      ['sess-1', first],
      ['sess-2', first],
      ['sess-3', second],
    ] as const) {
      s.a.onEvent?.({ type: 'session', managerId: s.managerId, sessionId: id, pluginLoad });
      await expect
        .poll(async () => (await s.stores.jobs.listJobs())[0]?.sessionId, { timeout: 2000 })
        .toBe(id);
    }

    const texts = await loadTexts();
    expect(texts).toHaveLength(2);
    expect(
      texts.some((text) =>
        text.endsWith(
          `[${s.managerId}] init が知らせた plugin の読み込み結果: 読み込めた plugin: first@1.0.0。読み込みの失敗: 失敗の報告は無い`,
        ),
      ),
    ).toBe(true);
    expect(
      texts.some((text) =>
        text.endsWith(
          `[${s.managerId}] init が知らせた plugin の読み込み結果: 読み込めた plugin: second。読み込みの失敗: 失敗 1 件 — q（load）: boom`,
        ),
      ),
    ).toBe(true);

    await s.pool.stop();
    await s.real.stop();
  });
});

describe('押し込みに失敗した runner へ、諦めずに挑み直す', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('繋がったままの runner で、一時的な失敗が次の hello を待たずに自然に直る', async () => {
    const stores = createMemoryStores();
    await stores.profile.set('default', 'export A=1', 'all');
    const s = setup(undefined, { stores });
    let broken = true;
    s.runner.setProfile = async () =>
      broken ? { ok: false, error: 'profile sync failed (test)' } : { ok: true };

    await s.pool.start({ request: '調べて' });
    expect(s.pool.pushHealthOf(s.runner.runnerId)?.profile?.status).toBe('failed');

    broken = false;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(s.pool.pushHealthOf(s.runner.runnerId)?.profile?.status).toBe('ok');

    await s.pool.stop();
  });

  it('直り続けなくても諦めない（何度でも挑み直す）', async () => {
    const stores = createMemoryStores();
    await stores.profile.set('default', 'export A=1', 'all');
    const s = setup(undefined, { stores });
    let attempts = 0;
    s.runner.setProfile = async () => {
      attempts += 1;
      return { ok: false, error: 'profile sync failed (test)' };
    };

    await s.pool.start({ request: '調べて' });
    const attemptsAfterConnect = attempts;
    expect(s.pool.pushHealthOf(s.runner.runnerId)?.profile?.status).toBe('failed');

    // 回数の上限を置かない: `north_star 禁止2`（回数では諦めない）。
    await vi.advanceTimersByTimeAsync(120_000);

    expect(attempts).toBeGreaterThan(attemptsAfterConnect + 1);
    expect(s.pool.pushHealthOf(s.runner.runnerId)?.profile?.status).toBe('failed');

    await s.pool.stop();
  });

  it('pool.stop() の後は、予約していた挑み直しを起こさない', async () => {
    const stores = createMemoryStores();
    await stores.profile.set('default', 'export A=1', 'all');
    const s = setup(undefined, { stores });
    let attempts = 0;
    s.runner.setProfile = async () => {
      attempts += 1;
      return { ok: false, error: 'profile sync failed (test)' };
    };

    await s.pool.start({ request: '調べて' });
    const attemptsAtStop = attempts;
    // 前提の確認: 播種を忘れると `setProfile` が一度も呼ばれず、この後の「止めた後は増えない」が両方 0 のまま無意味に緑になる。
    expect(attemptsAtStop).toBeGreaterThan(0);

    await s.pool.stop();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(attempts).toBe(attemptsAtStop);
  });
});

describe('manager_list / manager_report のモデルの行（#3921・#3947）', () => {
  const job = {
    id: 'mgr-models-line',
    managerId: 'mgr-models-line',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T01:00:00.000Z',
    status: 'running' as const,
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: 'sess-models-line',
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
    await s.pool.restore();
    await vi.waitFor(() => {
      if (s.inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
    });
    const tools = createCloneTools({
      stores: s.stores,
      emit: () => undefined,
      managers: s.pool,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const textOf = async (name: string, input: object) => {
      const tool = tools.find((entry) => entry.name === name);
      if (!tool) throw new Error(`${name} が無い`);
      const result = await tool.handler(input as never, {});
      return (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
    };
    return { s, fake, textOf };
  }

  it('名乗りを受けていなければ「不明」と書き、名乗られた分だけ出す（既定の opus / sonnet で埋めない）', async () => {
    const { s, fake, textOf } = await running();
    const wanted = '  モデル: マネージャー 不明 / 作業者 不明';

    const before = await textOf('manager_list', {});
    expect(before).toContain(wanted);
    expect(before).not.toMatch(/opus|sonnet/);
    expect(await textOf('manager_report', { managerId: job.id })).toContain(
      'モデル: マネージャー 不明 / 作業者 不明',
    );

    fake.helloWithModels({ managerModel: 'opus', workerModel: 'sonnet' });
    await vi.waitFor(async () => {
      expect(await textOf('manager_list', {})).toContain(
        '  モデル: マネージャー opus / 作業者 sonnet',
      );
    });
    expect(await textOf('manager_report', { managerId: job.id })).toContain(
      'モデル: マネージャー opus / 作業者 sonnet',
    );

    fake.helloWithModels({ workerModel: 'haiku' });
    await vi.waitFor(async () => {
      expect(await textOf('manager_list', {})).toContain(
        '  モデル: マネージャー 不明 / 作業者 haiku',
      );
    });

    await s.pool.stop();
  });
});
