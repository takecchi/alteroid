import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  query as sdkQuery,
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  CLONE_MODEL,
  CLONE_MODEL_ENV_KEY,
  CLONE_PERMISSION_MODE_ENV_KEY,
  createClone,
  humanTurnText,
  placedClonePermissionMode,
  resolveCloneModel,
  isHumanOriginated,
  resolveCloneHumanPriority,
  resolveClonePermissionMode,
} from './clone.js';
import type { HumanMessage } from './clone.js';
import type { TokenRotatorObservation } from './token-rotator.js';
import { fingerprintOf } from './credentials.js';
import {
  DISTILL_GAP_NOTICE_HEAD,
  DISTILL_SUCCEEDED_DECISION_PREFIX,
  deriveDistillGapFromJournal,
  describeDistillGap,
  distillSucceededEntry,
} from './distill-gap.js';
import type { DistillGap } from './distill-gap.js';
import type { CloneHost } from './host.js';
import type { ManagerPool, ManagerSummary } from './manager.js';
import { measureMemoryFloor, renderMemoryDocuments } from './memory.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createScheduler } from './schedule.js';
import type { ChatStreamEvent, InboxEvent, InboxEventType, JournalEntryInput } from './schema.js';
import type { Stores } from './store.js';
import { CLONE_ACTOR_ID, isCloneActor } from './usage.js';
import { createCloneMcpServer, createCloneTools } from './tools.js';
import type { ToolContext } from './tools.js';
import {
  captureStderr,
  createMemoryStores,
  failingJournalAppend,
  flakyInboxRemove,
  humanMessage,
} from './testing.js';

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
  options: {
    delayMs?: number;
    failWith?: string;
    /**
     * `result` に載せる `modelUsage`。**`query()` 呼び出しの番号で変える形にして
     * ある。**
     *
     * 固定値を1つ返すスタブにすると、本セッションと蒸留のサイドクエリが同じ値に
     * なり、「どちらの分がどこへ積まれたか」を問えないまま緑になる（AGENTS.md
     * 「固定値を返すスタブはテストを緑にしたまま分岐を殺す」）。
     */
    modelUsage?: (callIndex: number) => Record<string, unknown> | undefined;
    /** `result` の `subtype`。既定は `'success'`。 */
    resultSubtype?: string;
    /**
     * `result` の本文（`result.result`）。既定は `reply()` の返り値そのまま
     * （既存の振る舞いを変えない）。支出上限のように、assistant の発言とは別に
     * `result` だけが理由の本文を運んでくる回を作るためのもの。**固定値を返す
     * スタブにしない** — 呼ばなければ既定の `text` を素通しするだけで、他の
     * テストの挙動は1つも変わらない。
     */
    resultText?: string;
    /**
     * ターン（＝1回の入力。同一セッション内で0始まりの通し番号）ごとに
     * `resultSubtype` / `resultText` を差し替える。返り値が `undefined` なら
     * そのターンは `resultSubtype` / `resultText`（省略時は成功）を使う。
     *
     * **固定値のスタブにしないための口**（`modelUsage` と同じ理由）。枠の保持と
     * 解除は「何回目の再試行か」で結果が変わる場面を検証する必要があり、
     * `resultSubtype` / `resultText` だけでは全ターンが同じ結果に固定される。
     */
    resultFor?: (
      turnIndex: number,
    ) => { subtype?: string; text?: string; isError?: boolean } | undefined;
    /**
     * そのターンの `assistant` メッセージに SDK の失敗の印
     * （`SDKAssistantMessage.error`）を載せ、本文を差し替える。
     *
     * **これが実機で起きた形である。** 支出上限の文言は `result` ではなく
     * `assistant` メッセージの text ブロックとして届き、`error: 'billing_error'`
     * が付いていた（`sdk-failure.ts` の doc）。この口が無いと、その経路を
     * 1本も通せない ＝ 実際に起きた壊れ方を再現できない。
     *
     * **固定値のスタブにしない**（`modelUsage` / `resultFor` と同じ理由）。
     * 呼ばなければ既存の振る舞いは1つも変わらない。
     */
    assistantErrorAt?: (turnIndex: number) => { error: string; text: string } | undefined;
    /**
     * ターンの `assistant` より前に `rate_limit_event` を差し込む。返り値が
     * `undefined` ならそのターンには出さない。**枠の検知（`rate_limit_event`
     * 経路）を `result` の文言と独立に検証するための口。**
     */
    rateLimitEventAt?: (turnIndex: number) => Record<string, unknown> | undefined;
    /**
     * ターンの `assistant` より前に `system`（`notification` / `informational`）
     * を差し込む。返り値が `undefined` ならそのターンには出さない。
     */
    systemNoticeAt?: (
      turnIndex: number,
    ) => { subtype: 'notification' | 'informational'; text: string } | undefined;
    /**
     * ターンの中で `assistant` の前に差し込む生の合図（`system/permission_denied`
     * など）。**`result` の直前ではなく前に置く** — 実物もその順で来る。
     *
     * **`systemNoticeAt` と役割が違う。** あちらは `notification` /
     * `informational` 専用の砂糖で、こちらは任意の形（拒否のように `tool_name` /
     * `tool_use_id` を持つもの）を通すための生の口である。
     */
    beforeAssistant?: (callIndex: number) => SDKMessage[];
    /** `result` に載せる `permission_denials`（authoritative な側の記録）。 */
    permissionDenials?: (callIndex: number) => unknown[] | undefined;
    /**
     * 指定した番号のターンを出し終えたところで、**セッションそのものを終わらせる**
     * （generator を `return` する）。
     *
     * **`failWith` では代用できない。** あちらは init すら出さずに投げるので、
     * 「ターンは1本走った、そのあとセッションが死んだ」という状態が作れない。
     * ここが要るのは、`clone.ts` の読み取りループの `finally` が `#query = null`
     * にする経路を通したいときである — `#query` が null だと `stop()` は蒸留を
     * 挟まず、**`await` を1つも通さずに `#inbox.close()` まで進む。** それが
     * 「受信箱が閉じた後に `#pump` の先頭へ来る」順序を作る唯一の手である。
     */
    endSessionAfterTurn?: number;
    /**
     * init に載せる `mcp_servers`。既定は非空の1件（既存の呼び出し元の挙動を
     * 変えない）。`[]` を渡せば「init を観測して、SDK が0本と報告した」を
     * 再現できる（#324 —— `null`＝未観測とは別の状態であることを確かめる口）。
     */
    mcpServers?: Array<{ name: string; status: string }>;
  } = {},
) {
  const calls: FakeCall[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const call: FakeCall = { options: params.options ?? {}, inputs: [] };
    const callIndex = calls.length;
    calls.push(call);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      if (options.failWith !== undefined) throw new Error(options.failWith);

      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
        // `self_status`（runtime facts）が init から拾うフィールド。実物の SDK が
        // 返す形に合わせて運ぶ（`clone.ts` の `#captureInitFacts` を実際に通す）。
        model: 'claude-fake-init-model-xyz',
        claude_code_version: '9.9.9-fake',
        apiKeySource: 'user',
        permissionMode: 'default',
        mcp_servers: options.mcpServers ?? [{ name: 'alteroid', status: 'connected' }],
      } as unknown as SDKMessage;

      const prompt = params.prompt;
      if (typeof prompt === 'string') {
        call.inputs.push(prompt);
        yield* turn(reply(prompt), 0);
        return;
      }

      let turnIndex = 0;
      for await (const message of prompt as AsyncIterable<{ message: { content: unknown } }>) {
        const text = String(message.message.content);
        call.inputs.push(text);
        if (options.delayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        }
        const idx = turnIndex;
        turnIndex += 1;
        yield* turn(reply(text), idx);
        // セッションを終わらせる（`endSessionAfterTurn` の doc）。既定
        // （`undefined`）では番号が一致しないので、他のテストの挙動は変わらない。
        if (options.endSessionAfterTurn === idx) return;
      }
    }

    function* turn(text: string, turnIndex: number): Generator<SDKMessage> {
      const rateLimitInfo = options.rateLimitEventAt?.(turnIndex);
      if (rateLimitInfo !== undefined) {
        yield {
          type: 'rate_limit_event',
          rate_limit_info: rateLimitInfo,
          session_id: 'sess-fake',
          uuid: `uuid-ratelimit-${turnIndex}`,
        } as unknown as SDKMessage;
      }
      const systemNotice = options.systemNoticeAt?.(turnIndex);
      if (systemNotice !== undefined) {
        yield {
          type: 'system',
          subtype: systemNotice.subtype,
          session_id: 'sess-fake',
          uuid: `uuid-sysnotice-${turnIndex}`,
          ...(systemNotice.subtype === 'notification'
            ? { text: systemNotice.text }
            : { content: systemNotice.text }),
        } as unknown as SDKMessage;
      }
      for (const message of options.beforeAssistant?.(callIndex) ?? []) yield message;
      // 失敗の印が付く回は、本文もその印のもの（上限の文言など）に差し替わる。
      // **無印の本文と両方を流さない** — 実機では印付きの1本だけが来る。
      const assistantError = options.assistantErrorAt?.(turnIndex);
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: assistantError?.text ?? text }] },
        parent_tool_use_id: null,
        session_id: 'sess-fake',
        uuid: 'uuid-assistant',
        ...(assistantError === undefined ? {} : { error: assistantError.error }),
      } as unknown as SDKMessage;
      const modelUsage = options.modelUsage?.(callIndex);
      const resultOverride = options.resultFor?.(turnIndex);
      const denials = options.permissionDenials?.(callIndex);
      yield {
        type: 'result',
        subtype: resultOverride?.subtype ?? options.resultSubtype ?? 'success',
        result: resultOverride?.text ?? options.resultText ?? text,
        session_id: 'sess-fake',
        uuid: 'uuid-result',
        ...(resultOverride?.isError === undefined ? {} : { is_error: resultOverride.isError }),
        ...(modelUsage === undefined ? {} : { modelUsage }),
        ...(denials === undefined ? {} : { permission_denials: denials }),
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
  /**
   * `events` が条件を満たすまで、壁時計のポーリングではなく直接つかむ。
   *
   * **いま既に満たしていれば即座に返る**（追い越しを防ぐ。下の注記参照）。
   * まだなら、`clone.subscribe` の callback が出来事の到着ごとに同期で呼ぶ
   * 通知先に登録し、そこで条件を確かめて resolve する。
   *
   * 経緯: 元は `expect.poll(() => events.filter(...).length === N, {timeout:
   * 3000})` で「N件になったこと」を一定間隔でポーリングしていた。PR #90 の
   * 変異試験自身が「落ち方の所要時間がどれも3000ms台＝ポーリングの待ち切れ
   * である」と自己申告していた（落ちたのがタイムアウトなのか、条件そのもの
   * が偽なのかを見分けにくい弱い形）。`events` は `clone.subscribe` の
   * callback で同期に push されるので、そのたびに条件を確かめて resolve
   * すれば、ポーリング間隔にも壁時計の上限にも頼らない。
   *
   * **「次に届いた出来事」ではなく「条件を満たすか」を見るのが要る** —
   * 呼び出し側が待ち始める前に条件が満たされてしまう窓が実在する
   * （`apps/web` 側の同種の直しで、そこを「次の1回」で待つ形にして
   * ハングさせた実測がある）。先に条件を確かめてから待つ形にすると、
   * 追い越されていても即座に真になるので、この窓が消える。
   */
  waitForEvents(predicate: (events: readonly ChatStreamEvent[]) => boolean): Promise<void>;
}

/**
 * `clone.subscribe` を張り、`events` の配列と、それを壁時計のポーリングでは
 * なく直接つかむ `waitForEvents` を組にして返す。`setup` と `setupScripted`
 * の両方が同じ配線を要るので、ここへ1本にまとめる（`Setup.waitForEvents`
 * の doc 参照）。
 */
function wireEvents(
  clone: CloneHost,
  conversationId: string,
): { events: ChatStreamEvent[]; waitForEvents: Setup['waitForEvents'] } {
  const events: ChatStreamEvent[] = [];
  const waiters: {
    predicate: (events: readonly ChatStreamEvent[]) => boolean;
    resolve: () => void;
  }[] = [];
  function notifyWaiters(): void {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const candidate = waiters[i];
      if (candidate !== undefined && candidate.predicate(events)) {
        waiters.splice(i, 1);
        candidate.resolve();
      }
    }
  }
  clone.subscribe(conversationId, (event) => {
    events.push(event);
    notifyWaiters();
  });
  function waitForEvents(
    predicate: (events: readonly ChatStreamEvent[]) => boolean,
  ): Promise<void> {
    if (predicate(events)) return Promise.resolve();
    return new Promise((resolve) => {
      waiters.push({ predicate, resolve });
    });
  }
  return { events, waitForEvents };
}

function setup(
  reply?: (input: string) => string,
  stores: Stores = createMemoryStores(),
  sdkOptions: Parameters<typeof fakeSdk>[1] = {},
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
  const { events, waitForEvents } = wireEvents(clone, 'conv-1');
  return { clone, stores, calls, events, waitForEvents };
}

/** 非同期の書き込みが器へ届くまで待つ（`post` は同期で返るので待てない）。 */
async function waitFor(check: () => Promise<boolean> | boolean, label: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - started > 3000) throw new Error(`${label} が起きない`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

/** ターンの終端（`done` または `error`）。失敗したターンを見るテストで使う。 */
const isTerminal = (event: ChatStreamEvent): boolean =>
  event.type === 'done' || event.type === 'error';

/**
 * ターンの終端（`done` か `error`）が来るまで待つ。**種類は見ない、来たことだけ見る。**
 *
 * 失敗したターンを見るテストで `error` だけを待つ形にすると、変異試験（新しい
 * `if (!isSuccessResult(message)) { ... }` の分岐を消して回すテスト）で
 * `error` が永久に来ずタイムアウトで落ちる。**タイムアウトは歯があった証拠に
 * ならない** — 同じホストで別の作業が走っていると負荷だけで同じ落ち方をする
 * （実測で偽陽性が出ている）。ここでは終端の"有無"だけを待ち、終端の"種類"は
 * 呼び出し側が `isTerminal` で絞った配列を `toEqual` で比べて確かめる。分岐を
 * 消した世界でも `done` は同じ速さで来て poll は抜けるが、期待した `['error']`
 * とは一致せず**アサーション不一致で落ちる**（タイムアウトでは落ちない）。
 */
async function waitForTerminal(events: ChatStreamEvent[]): Promise<void> {
  await expect.poll(() => events.some(isTerminal), { timeout: 3000 }).toBe(true);
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
    //
    // ↑ **この期待は #32 で反転した。** 元の文（と実装）は north_star「適用範囲」が
    // 名指しで否定している推論だった — 人間は道具を持たない存在ではないので、
    // 「人間の写像だから道具を持たない」は写像として成り立たない。したがって
    // `tools` は**渡さない**（preset 一式）。マネージャー・作業者と同じ扱いである
    // （AGENTS.md 地雷1・7 / PRD「層ごとの能力」）。
    expect(options.tools).toBeUndefined();
    // 自作ツールは確認なしで使える。**これは使える道具の一覧ではない**（確認を
    // 省く側の一覧である）。組み込みツールが減っていないことは上で見ている。
    expect(options.allowedTools).toContain('mcp__alteroid__memory_write');
    expect(options.allowedTools).toContain('mcp__alteroid__ask_human');
    expect(options.mcpServers).toHaveProperty('alteroid');
    // 人間の設定と MCP 連携をそのまま読む（PRD「業務範囲」）。ここが `[]` だと
    // 人間が使っている連携がクローンから1つも見えない
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    // 人間が開く Claude Code と同じ既定。`default` だと、答える相手が居ない確認が
    // そのまま拒否になって「道具を渡したのに使えない」が生まれる
    expect(options.permissionMode).toBe('auto');
    // ターン数上限で暴走を止めない（AGENTS.md 地雷2）
    expect(options.maxTurns).toBeUndefined();

    await s.clone.stop();
  });

  it('自分の手で使った道具は日誌に残る（自作ツールは重ねて残さない）', async () => {
    // docs/architecture.md「非対称な可視性」:「どちらで見たかは日誌に残す。委譲が
    // 原則である理由が守られているかは、禁止ではなく記録で見る」。道具を渡した以上
    // （#32）、ここが無いと「委譲していない」を見る手が禁止しか残らない。
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');

    await hook(
      { tool_name: 'Bash', tool_input: { command: 'git log --oneline -3' } } as never,
      undefined,
      {} as never,
    );
    // 自作ツールはそれ自身が跡を残す（`memory_update` / 日誌の本文 / 台帳）。
    // ここで重ねると、毎ターン数本叩く道具の記録で日誌が埋まって掘れなくなる。
    await hook(
      { tool_name: 'mcp__alteroid__memory_write', tool_input: { slug: 'values' } } as never,
      undefined,
      {} as never,
    );

    const entries = await s.stores.journal.list({ types: ['tool_use'] });
    expect(entries.map((entry) => (entry as { tool: string }).tool)).toEqual(['Bash']);
    expect((entries[0] as { actor: string }).actor).toBe(CLONE_ACTOR_ID);
    expect((entries[0] as { input: unknown }).input).toEqual({
      command: 'git log --oneline -3',
    });

    await s.clone.stop();
  });

  it('サブエージェントの中の道具実行は、自分で叩いた分と区別して残る', async () => {
    // クローンは preset 一式を持つので `Task` も持っている。ここを分けないと
    // 「自分でやったのか委ねたのか」の問いに嘘の数が返る（runner が
    // `manager:<id>` と `worker:<id>:<agent>` を分けているのと同じ理由）。
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');

    await hook(
      { tool_name: 'Read', tool_input: { file_path: '/a' } } as never,
      undefined,
      {} as never,
    );
    await hook(
      {
        tool_name: 'Grep',
        tool_input: { pattern: 'x' },
        // SDK: 「Use this field (not agent_type) to distinguish subagent calls」
        agent_id: 'sub-1',
        agent_type: 'general-purpose',
      } as never,
      undefined,
      {} as never,
    );
    // **`agent_type` が読めなくても、サブエージェント側であることは落とさない。**
    await hook(
      { tool_name: 'Glob', tool_input: {}, agent_id: 'sub-2' } as never,
      undefined,
      {} as never,
    );

    const entries = await s.stores.journal.list({ types: ['tool_use'] });
    const byTool = new Map(
      entries.map((entry) => [
        (entry as { tool: string }).tool,
        (entry as { actor: string }).actor,
      ]),
    );
    expect(byTool.get('Read')).toBe(CLONE_ACTOR_ID);
    expect(byTool.get('Grep')).toBe('clone:sub:general-purpose');
    expect(byTool.get('Glob')).toBe('clone:sub:(不明)');
    // どれもクローンの手として数えられる（digest の分類が拾えること）
    for (const actor of byTool.values()) expect(isCloneActor(actor)).toBe(true);

    await s.clone.stop();
  });

  it('道具の名前が読めなくても、記録を落とさない（監査の穴を静かに空けない）', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
    // 名前が読めないなら「自作ツールだった」ではなく「観測できなかった」である。
    await hook({ tool_input: { any: 1 } } as never, undefined, {} as never);

    const entries = await s.stores.journal.list({ types: ['tool_use'] });
    expect(entries.map((entry) => (entry as { tool: string }).tool)).toEqual(['(不明な道具)']);

    await s.clone.stop();
  });

  it('蒸留のサイドクエリの道具実行も日誌に残る（別セッションだと分かる形で）', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const main = s.calls[0] as FakeCall;
    const dir = await mkdtemp(join(tmpdir(), 'alteroid-distill-audit-'));
    try {
      const transcriptPath = join(dir, 'transcript.jsonl');
      await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
      const preCompact = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
      if (preCompact === undefined) throw new Error('PreCompact フックが登録されていない');
      await preCompact(
        { session_id: 'sess-fake', transcript_path: transcriptPath } as never,
        undefined,
        { signal: new AbortController().signal } as never,
      );

      const side = s.calls.at(-1) as FakeCall;
      expect(side).not.toBe(main);
      // **道具と許可モードを揃えたのだから、記録も揃っていること。**
      const hook = side.options.hooks?.PostToolUse?.[0]?.hooks?.[0];
      if (hook === undefined) throw new Error('蒸留側に PostToolUse フックが無い');
      await hook(
        { tool_name: 'Write', tool_input: { file_path: '/a' } } as never,
        undefined,
        {} as never,
      );

      const entries = await s.stores.journal.list({ types: ['tool_use'] });
      const write = entries.find((entry) => (entry as { tool: string }).tool === 'Write');
      expect((write as { actor: string } | undefined)?.actor).toBe('clone:distill');
      expect(isCloneActor('clone:distill')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    await s.clone.stop();
  });

  it('確認へ上がらず止められた道具は日誌に残る。生の合図と result で二重に書かない', async () => {
    // `permissionMode: 'auto'` ＋ `canUseTool` 無しなので拒否は普通に起きる。
    // ここを捨てると「静かになった」と「起きていない」が区別できなくなる。
    //
    // **生の合図と `result` の両方に同じ1件を載せる。** SDK は前者を best-effort、
    // 後者を authoritative と言っているので実装は両方読む ＝ 二重に書かないことも
    // 一緒に確かめないと、日誌が同じ拒否で2倍に膨らむ。
    const denial = { tool_name: 'Bash', tool_use_id: 'tu-1', tool_input: { command: 'git push' } };
    const s = setup(undefined, createMemoryStores(), {
      beforeAssistant: () => [
        {
          type: 'system',
          subtype: 'permission_denied',
          ...denial,
          decision_reason: '分類器が止めた',
          decision_reason_type: 'classifier',
          message: 'Bash is not allowed right now',
        } as unknown as SDKMessage,
      ],
      permissionDenials: () => [denial],
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const denied = (await s.stores.journal.list({ types: ['exchange'] })).filter((entry) =>
      (entry as { text: string }).text.includes('確認へ上がらずに止められた'),
    );
    expect(denied.length).toBe(1);
    const text = (denied[0] as { text: string }).text;
    expect(text).toContain('Bash');
    // **分類・理由・モデルへの拒否文の3つとも読む。** #230 で `runner.ts` 側は
    // 3つとも読むようになったが、`clone.ts` 側は `decision_reason` しか読んで
    // いなかった（#229）。ここが赤くなれば、その非対称が戻ってきたということ。
    expect(text).toContain('分類: classifier');
    expect(text).toContain('理由: 分類器が止めた');
    expect(text).toContain('モデルへの拒否文: Bash is not allowed right now');
    // 許可モードも添える（「なぜ確認が来ないのか」を後から読む人のために）
    expect(text).toContain('auto');
    // **拒否は `tool_use` として数えない** — 使えていない回数を「自分で手を動かした
    // 回数」に混ぜると、digest の材料がそのまま狂う。
    expect(await s.stores.journal.list({ types: ['tool_use'] })).toEqual([]);

    await s.clone.stop();
  });

  it('確認へ上がらず止められた道具の分類・拒否文が欠けているときは作り物を出さず省く', async () => {
    // `result.permission_denials`（`via: 'result'`）は理由を持たない。`via:
    // 'live'` でも SDK がフィールドを付けてこなければ同じく欠ける。**欠けている
    // ものを空文字や「不明」で埋めると、読み手が「そう答えが返ってきた」と誤読
    // する。** 欠けていること自体を、ラベルごと出さないことで表す。
    const denial = { tool_name: 'Bash', tool_use_id: 'tu-2', tool_input: { command: 'git push' } };
    const s = setup(undefined, createMemoryStores(), {
      permissionDenials: () => [denial],
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const denied = (await s.stores.journal.list({ types: ['exchange'] })).filter((entry) =>
      (entry as { text: string }).text.includes('確認へ上がらずに止められた'),
    );
    expect(denied.length).toBe(1);
    const text = (denied[0] as { text: string }).text;
    expect(text).toContain('Bash');
    expect(text).not.toContain('分類:');
    expect(text).not.toContain('理由:');
    expect(text).not.toContain('モデルへの拒否文:');
    // 何も詰められなかったときは括弧そのものを出さない（空の括弧を残さない）。
    expect(text).not.toContain('（）');

    await s.clone.stop();
  });

  /**
   * Issue #373 — `runner.ts` の `#noteDenial` は `agent_id` を読んで層
   * （マネージャー自身／作業者）を判定するが、`clone.ts` の同名メソッドは
   * 読んでいなかった。クローン自身も preset 一式を持つので `Task`（作業者＝
   * サブエージェント）を持ち、拒否がクローン本体のものか作業者のものかを
   * 区別できないと、日誌を追う側が誤った層へ次の手を向けかねない。
   *
   * **`via: 'live'` のときだけ層が載る。** `agent_id` は `SDKPermissionDeniedMessage`
   * （生の合図、`via: 'live'`）にしか原理的に存在しない
   * （`SDKPermissionDenial`＝`via: 'result'` は3つのフィールドしか持たない）。
   */
  it('拒否の層（クローン本体／作業者／どちらの層か不明）が日誌の文言に出る', async () => {
    const mainThread = { tool_name: 'Bash', tool_use_id: 'tu-main', tool_input: { command: 'ls' } };
    const subAgent = {
      tool_name: 'Write',
      tool_use_id: 'tu-sub',
      tool_input: { file_path: '/a' },
      agent_id: 'agent-1',
      agent_type: 'general-purpose',
    };
    const resultOnly = { tool_name: 'Edit', tool_use_id: 'tu-result' };
    const s = setup(undefined, createMemoryStores(), {
      beforeAssistant: () => [
        { type: 'system', subtype: 'permission_denied', ...mainThread } as unknown as SDKMessage,
        { type: 'system', subtype: 'permission_denied', ...subAgent } as unknown as SDKMessage,
      ],
      // `permissionDenials` が読む `result.permission_denials` 側は authoritative
      // だが `agent_id` を持たない——生の合図（上）とは別の tool_use_id にして
      // 二重書き防止（`#deniedToolUses`）に引っかからないようにする。
      permissionDenials: () => [resultOnly],
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const denied = (await s.stores.journal.list({ types: ['exchange'] })).filter((entry) =>
      (entry as { text: string }).text.includes('確認へ上がらずに止められた'),
    );
    expect(denied.length).toBe(3);
    const texts = denied.map((entry) => (entry as { text: string }).text);

    const mainText = texts.find((t) => t.includes('Bash'));
    expect(mainText).toContain('クローン本体');
    expect(mainText).not.toContain('作業者');

    const subText = texts.find((t) => t.includes('Write'));
    expect(subText).toContain('作業者');
    expect(subText).toContain('general-purpose');

    const resultText = texts.find((t) => t.includes('Edit'));
    expect(resultText).toContain('どちらの層か不明');
    expect(resultText).not.toContain('クローン本体');
    expect(resultText).not.toContain('作業者');

    await s.clone.stop();
  });

  it('権限モードの既定は人間が開く Claude Code と同じ（auto）。置けるのは人間だけ', () => {
    // `default` のままだと、答える相手が居ない確認（このセッションに `canUseTool`
    // は無い）がそのまま拒否になり、道具を渡したのに使えない状態になる。
    expect(resolveClonePermissionMode({})).toBe('auto');
    expect(resolveClonePermissionMode({ [CLONE_PERMISSION_MODE_ENV_KEY]: '' })).toBe('auto');
    expect(resolveClonePermissionMode({ [CLONE_PERMISSION_MODE_ENV_KEY]: '   ' })).toBe('auto');
    // 人間が締めることはできる（実行環境の設定であって能力の制限ではない）
    expect(resolveClonePermissionMode({ [CLONE_PERMISSION_MODE_ENV_KEY]: '  default  ' })).toBe(
      'default',
    );
    // **綴りの間違いは黙って既定へ倒さない。** 倒すと「都度確認にしたはずなのに
    // 確認が来ない」ことに人間が気づけない
    expect(() => resolveClonePermissionMode({ [CLONE_PERMISSION_MODE_ENV_KEY]: 'strict' })).toThrow(
      /ALTEROID_CLONE_PERMISSION_MODE/,
    );
  });

  it('置かれたかどうかは「既定と違うか」では言い換えられない（起動時の告知の材料）', () => {
    // モデル帯（`placedCloneModel`）と同じ含み。`auto` を明示的に置いた人にも
    // 「置かれている」と言えなければ、告知は事実を言っていない。
    expect(placedClonePermissionMode({})).toBeNull();
    expect(placedClonePermissionMode({ [CLONE_PERMISSION_MODE_ENV_KEY]: '  ' })).toBeNull();
    expect(placedClonePermissionMode({ [CLONE_PERMISSION_MODE_ENV_KEY]: ' auto ' })).toBe('auto');
    // **綴りを間違えた値も返す。** 告知は落ちる前に出るので、ここで潰すと
    // 「何を置いたせいで落ちたか」が本人に見えない
    expect(placedClonePermissionMode({ [CLONE_PERMISSION_MODE_ENV_KEY]: 'strict' })).toBe('strict');
  });

  it('人間が置いた権限モードが実際にセッションへ渡る', async () => {
    const s = setup(
      undefined,
      createMemoryStores(),
      {},
      {
        [CLONE_PERMISSION_MODE_ENV_KEY]: 'default',
      },
    );

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    expect((s.calls[0] as FakeCall).options.permissionMode).toBe('default');

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
      // **道具の配置も揃っていること**（#32）。帯だけ揃えても、片方に道具が無ければ
      // 人格を書く側だけが別の頭になる（会話の最後に「鍵を実行環境へ移す」を
      // やろうとして失敗した実例と同じ形）。
      expect(side.options.tools).toBeUndefined();
      expect(side.options.settingSources).toEqual(['user', 'project', 'local']);
      // **`toBe(main…)` だけにしないこと。** 両方 `undefined` でも等しくなるので、
      // 「どちらにも渡していない」が「揃っている」として通ってしまう。
      expect(side.options.permissionMode).toBe('auto');
      expect(side.options.permissionMode).toBe(main.options.permissionMode);
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
    // **人間の発言は末尾にそのまま載る。** 断り書き（配り直し・台帳）は前に付くので
    // 完全一致では見ないが、**後ろを削ったり書き換えたりしていないこと**は
    // `endsWith` のほうが強く言える（`toContain` だと部分一致で通ってしまう）。
    expect(inputs[0]?.endsWith('価値観を伝える')).toBe(true);
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
 * マネージャーからの質問・許可確認が、答え直す必要の無いものとして再提示される
 * バグ（クローンが解決済みの確認へ二重に答え、`manager_send` が「その確認は
 * 待っていない」と弾く）の直し。
 *
 * 実測（2026-08-22）: 解決済みの確認が「まだ止まっている」としてクローンへ再提示
 * され、クローンが騙されて同じ requestId へ二重に回答した。原因は `managerPrompt()`
 * が `InboxEvent` だけを見る純関数で、その確認がいまも `ManagerPool` の `waiting`
 * に載っているかを1度も確かめていなかったこと。
 *
 * ここで固定するのは3つ:
 * 1. いま実際に待っている確認は、従来の文言（「返事をするまで…止まっている」）で
 *    届く（生きている確認）
 * 2. `waiting` から消えた確認は、その文言では届かない（＝答え直せと言わない）
 * 3. `managers.list()` が投げても、ターンは落ちず、従来の文言のままで届く
 *    （確かめられなかった側は安全側＝雑音へ倒す。喪失させない）
 *
 * ⚠️ **この直しは「解決済みなら必ず正しい文言が出る」ことまでは保証しない。**
 * `manager.ts` の `send()`（`manager_send` の実体）は `runner.answer()` が成功
 * しても `record.waiting` を同期では書き換えない。`waiting` からその requestId が
 * 消えるのは、あとから非同期で届く別種の `RunnerEvent`（`'settled'`。
 * `manager.ts` の `#onEvent` 内）のハンドラだけである。**答えた直後・
 * `'settled'` が処理を終える前の窓で合図が配られると、`waiting` にはまだ
 * 載っているので、この直しを入れても従来どおり「まだ止まっている」の文言が出る。**
 * 安全側（雑音）へ倒れているので方針には反しないが、「もう完全に守られている」
 * とは読まないこと。ここを完全に閉じるには回答の受理そのものを冪等にする必要が
 * あり、この直しの範囲外である。
 */
describe('クローン — マネージャーの確認がいまも待たれているかを確かめてから文言を出す', () => {
  /**
   * `escalation.test.ts` の `fakeManagerSdk()` と同じ形。委譲先（マネージャー）の
   * SDK を模し、`canUseTool` 経由で許可確認を1件降ろせるようにする。
   *
   * ここで模すのはモデルの手（どの道具をどう呼ぶか）だけで、道具の実体・
   * ジョブ台帳・受信箱・マネージャー側の待ち（`ManagerPool`）はすべて本物を通す
   * ——だから `waiting` へ実際に積まれ、実際に消える。
   */
  function fakeManagerSdk() {
    const sessions: {
      options: Options;
      ask: (tool: string, id: string) => Promise<PermissionResult>;
    }[] = [];

    const fn = ((params: { prompt: unknown; options?: Options }) => {
      const options = params.options ?? {};

      sessions.push({
        options,
        ask(tool, id) {
          const canUseTool = options.canUseTool as CanUseTool;
          return canUseTool(tool, { command: `${tool}:${id}` }, {
            signal: new AbortController().signal,
            requestId: id,
            toolUseID: id,
          } as never) as Promise<PermissionResult>;
        },
      });

      let finish: (() => void) | null = null;

      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-mgr',
          uuid: 'uuid-init',
        } as unknown as SDKMessage;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }

      return Object.assign(generate(), {
        close: () => finish?.(),
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;

    return { fn, sessions };
  }

  /**
   * クローン本体（`s.clone`）とマネージャーのプール（`s.clone.managers`）を、
   * 委譲先の SDK を差し込んだ状態で1つに束ねる。`setup()` を使わないのは、
   * `setup()` の runner が `ask()`（`canUseTool` を叩く口）を持たない別種の
   * 偽 SDK に固定されているため。
   */
  function setupWithManager(reply?: (input: string) => string) {
    const manager = fakeManagerSdk();
    const { fn, calls } = fakeSdk(reply);
    const clone = createClone({
      stores: createMemoryStores(),
      queryFn: fn,
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: manager.fn, env: {} }),
      ]),
    });
    return { clone, manager, calls };
  }

  it('待っている確認は、いまの文言（返事をするまで…止まっている）で届く', async () => {
    const { clone, manager, calls } = setupWithManager();

    const { managerId } = await clone.managers.start({ request: '1件確認する仕事' });
    const session = manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    // 生きている確認（`waiting` に積まれたまま）を作る。
    void session.ask('Bash', 'req-live');

    const inputs = () => (calls[0] as FakeCall).inputs;
    const text = await expect
      .poll(() => inputs().find((input) => input.includes('req-live')), { timeout: 3000 })
      .toBeTruthy()
      .then(() => inputs().find((input) => input.includes('req-live')) ?? '');

    expect(text).toContain(`返事をするまで ${managerId} のこの1件だけが止まっている`);
    expect(text).toContain('manager_send');
    expect(text).toContain('ask_human');
    expect(text).not.toContain('もう待たれていない');

    await clone.stop();
  });

  it('waiting から消えた確認は、その文言では届かない（答え直せと言わない）', async () => {
    const { clone, manager, calls } = setupWithManager();

    const { managerId } = await clone.managers.start({ request: '1件確認する仕事' });
    const session = manager.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    // 一度は生きている確認として届く。
    const pending = session.ask('Bash', 'req-settled');
    const inputs = () => (calls[0] as FakeCall).inputs;
    await expect
      .poll(() => inputs().some((input) => input.includes('req-settled')), { timeout: 3000 })
      .toBe(true);

    // 本物の応答経路（`manager.ts` の `send()`）で解く。runner 側の
    // `canUseTool` が解決し、`'settled'` RunnerEvent を経て `waiting` から
    // 消えるところまで、本物の機構をそのまま通す。
    const sendResult = await clone.managers.send(managerId, 'それでよい', {
      requestId: 'req-settled',
      decision: 'allow',
    });
    expect(sendResult.outcome).toBe('answered');
    expect(await pending).toEqual({ behavior: 'allow' });

    // `waiting` から実際に消えたことを確認する（この直しが効く前提）。
    await expect
      .poll(
        async () =>
          (await clone.managers.list())
            .find((m) => m.managerId === managerId)
            ?.waiting.map((w) => w.requestId),
        { timeout: 3000 },
      )
      .toEqual([]);

    // ここからが本題 — **解決済みの確認が、再送のように同じ requestId で
    // もう一度届く**（実測されたバグの形。`ManagerPool#emit` が毎回新しい
    // event.id を発行する経路なので、`id` だけ変えて模す）。
    clone.post({
      type: 'manager_message',
      id: 'evt-redelivered',
      at: new Date().toISOString(),
      managerId,
      kind: 'permission',
      text: 'Bash の実行許可: req-settled（再送）',
      requestId: 'req-settled',
    });

    const redelivered = await expect
      .poll(() => inputs().find((input) => input.includes('再送')), { timeout: 3000 })
      .toBeTruthy()
      .then(() => inputs().find((input) => input.includes('再送')) ?? '');

    // 「答え直せ」という指示が1文字も無いこと。
    expect(redelivered).not.toContain('返事をするまで');
    expect(redelivered).not.toContain('manager_send');
    expect(redelivered).not.toContain('ask_human');
    expect(redelivered).toContain('もう待たれていない');

    await clone.stop();
  });

  /**
   * 変異試験で見つかった穴の埋め合わせ（このテストが無いと、`confirmationLiveness`
   * の `summaries.find((entry) => entry.managerId === managerId)` を
   * `find((entry) => true)` へ変異させても151本が全通過し、生存した）。
   *
   * 上の2本（生きている確認／消えた確認）はどちらもマネージャーが1体しか
   * 走っていない。`managerId` で絞らずに `list()` の先頭要素を拾っても、
   * 候補が1件しか無ければ偶然当たってしまい、絞り込みそのものは測れない。
   *
   * ここでは2体のマネージャーを走らせ、**同じ requestId 文字列**を使って
   * 「mgr-A の確認は解決済み・mgr-B の確認は生きている」という組を作る。
   * `list()` は `startedAt` の降順で返す（`manager.ts` の `list()`）ので、
   * 後から始めた mgr-B が並びの先頭に来る——`managerId` を見ずに先頭を拾う
   * 実装なら、mgr-A への再送を mgr-B の「生きている」で答えてしまう。
   */
  it('別のマネージャーの生きている確認と混ざらない（managerId で絞り込む）', async () => {
    const { clone, manager, calls } = setupWithManager();

    // mgr-A — 先に始め、確認を1件解いておく（waiting から消える）。
    const { managerId: managerA } = await clone.managers.start({ request: 'A の仕事' });
    const sessionA = manager.sessions[0];
    if (!sessionA) throw new Error('mgr-A のセッションが無い');
    const pendingA = sessionA.ask('Bash', 'req-shared');
    const inputs = () => (calls[0] as FakeCall).inputs;
    await expect
      .poll(() => inputs().some((input) => input.includes('req-shared')), { timeout: 3000 })
      .toBe(true);
    const sendResult = await clone.managers.send(managerA, 'それでよい', {
      requestId: 'req-shared',
      decision: 'allow',
    });
    expect(sendResult.outcome).toBe('answered');
    expect(await pendingA).toEqual({ behavior: 'allow' });
    await expect
      .poll(
        async () =>
          (await clone.managers.list())
            .find((m) => m.managerId === managerA)
            ?.waiting.map((w) => w.requestId),
        { timeout: 3000 },
      )
      .toEqual([]);

    // mgr-B — 後から始め、**同じ requestId 文字列**で確認を出したまま
    // （waiting に残る＝生きている）。
    const { managerId: managerB } = await clone.managers.start({ request: 'B の仕事' });
    const sessionB = manager.sessions[1];
    if (!sessionB) throw new Error('mgr-B のセッションが無い');
    void sessionB.ask('Bash', 'req-shared');
    await expect
      .poll(
        async () =>
          (await clone.managers.list())
            .find((m) => m.managerId === managerB)
            ?.waiting.map((w) => w.requestId),
        { timeout: 3000 },
      )
      .toEqual(['req-shared']);
    // 並び順の前提（後から始めた mgr-B が先頭）を自分で確かめる。
    const order = (await clone.managers.list()).map((m) => m.managerId);
    expect(order[0]).toBe(managerB);

    // ここからが本題 — **解決済みの mgr-A の確認**が、同じ requestId で
    // もう一度届く。生きているのは mgr-B の同名確認だけである。
    clone.post({
      type: 'manager_message',
      id: 'evt-cross-manager',
      at: new Date().toISOString(),
      managerId: managerA,
      kind: 'permission',
      text: 'Bash の実行許可: req-shared（mgr-A への再送）',
      requestId: 'req-shared',
    });

    const redelivered = await expect
      .poll(() => inputs().find((input) => input.includes('mgr-A への再送')), { timeout: 3000 })
      .toBeTruthy()
      .then(() => inputs().find((input) => input.includes('mgr-A への再送')) ?? '');

    // mgr-B の生存に引きずられず、mgr-A の確認として「もう待たれていない」。
    expect(redelivered).toContain('もう待たれていない');
    expect(redelivered).not.toContain('返事をするまで');

    await clone.stop();
  });

  it('managers.list() が投げても、ターンは落ちず、いまの文言のまま届く', async () => {
    const { fn, calls } = fakeSdk();
    // `list()` だけ必ず投げる、それ以外は呼ばれない前提のスタブ。
    // ManagerPool の全メソッドを実装するが、このテストで使うのは `list` だけ。
    const throwingPool: ManagerPool = {
      start: () => {
        throw new Error('not implemented');
      },
      send: () => {
        throw new Error('not implemented');
      },
      abort: () => {
        throw new Error('not implemented');
      },
      list: () => {
        throw new Error('list() が壊れている（実測を模す）');
      },
      denials: () => [],
      runnerBacklog: () => [],
      runners: () => {
        throw new Error('not implemented');
      },
      transcript: () => {
        throw new Error('not implemented');
      },
      restore: () => Promise.resolve([]),
      reattachRunner: () => Promise.resolve(),
      probeTurnEnds: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    };

    const clone = createClone({
      stores: createMemoryStores(),
      queryFn: fn,
      managers: throwingPool,
    });

    clone.post({
      type: 'manager_message',
      id: 'evt-permission-unknown',
      at: new Date().toISOString(),
      managerId: 'mgr-unknown',
      kind: 'permission',
      text: 'Bash の実行許可: 確かめられない',
      requestId: 'req-unknown',
    });

    const inputs = () => (calls[0] as FakeCall).inputs;
    // **ターンが落ちずに進むこと自体が主張である。** list() が投げたまま
    // ターンが止まれば、この poll はタイムアウトで落ちる。
    const text = await expect
      .poll(() => inputs().find((input) => input.includes('確かめられない')), { timeout: 3000 })
      .toBeTruthy()
      .then(() => inputs().find((input) => input.includes('確かめられない')) ?? '');

    // 確かめられなかった側は安全側（いまの文言のまま）へ倒す。
    expect(text).toContain('返事をするまで mgr-unknown のこの1件だけが止まっている');
    expect(text).toContain('manager_send');
    expect(text).not.toContain('もう待たれていない');

    await clone.stop();
  });

  it('report の文言は変わらない（kind !== question/permission は判定しない）', async () => {
    const { clone, calls } = setupWithManager();

    clone.post({
      type: 'manager_message',
      id: 'evt-report-unchanged',
      at: new Date().toISOString(),
      managerId: 'mgr-report',
      kind: 'report',
      text: '直しました（報告のみ）',
    });

    const inputs = () => (calls[0] as FakeCall).inputs;
    const text = await expect
      .poll(() => inputs().find((input) => input.includes('直しました（報告のみ）')), {
        timeout: 3000,
      })
      .toBeTruthy()
      .then(() => inputs().find((input) => input.includes('直しました（報告のみ）')) ?? '');

    expect(text).toContain('（報告）');
    expect(text).toContain('続きが要るなら `manager_send` で指示を出し');
    expect(text).not.toContain('止まっている');
    expect(text).not.toContain('もう待たれていない');

    await clone.stop();
  });
});

/**
 * shutdown 蒸留が conversation_end 蒸留と重複して走るのを防ぐ直し（`d247074`）の歯。
 *
 * PR #119 の残作業 — 実装（`#hasUndistilledActivity` と、`#handle` の `'distill'`
 * 分岐が前回の蒸留成功以降にターンが1本も無ければ見送る判定）に、これまで
 * テストが1本も無かった。
 *
 * **「起きなかったこと」は見送り自身が能動的に書く合図（日誌の `exchange`。
 * `with: 'self'` / `role: 'outbound'` / 本文に「蒸留（<reason>）は見送った」を
 * 含む）で見る。** `await` が返った時点でこの行は確定済みであり、タイムアウトで
 * 「来なかったから見送ったはず」と読むのは `waitForTerminal` の doc が明記して
 * いるとおり歯があった証拠にならない（別の負荷で `done` そのものが遅れても
 * 同じ見え方になる）。
 */
describe('クローン — shutdown 蒸留の重複防止', () => {
  /** `buildDistillPrompt` が書く固定の呼びかけ。蒸留ターンかどうかの見分け方。 */
  const DISTILL_MARKER = '記憶へ移すべきものがあるか確認せよ';

  /** 見送りの日誌（`type: 'exchange'` / `with: 'self'` / `role: 'outbound'`）だけを拾う。 */
  async function skippedDistillEntries(
    stores: Stores,
  ): Promise<{ text: string; with: string; role: string }[]> {
    const entries = (await stores.journal.list({ types: ['exchange'] })) as {
      text: string;
      with: string;
      role: string;
    }[];
    return entries.filter(
      (entry) =>
        entry.with === 'self' && entry.role === 'outbound' && entry.text.includes('は見送った'),
    );
  }

  it('A: endConversation の直後に stop() が来ても、蒸留は1回しか走らない', async () => {
    const s = setup();

    s.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');
    await s.clone.stop();

    const inputs = (s.calls[0] as FakeCall).inputs;
    const distillPrompts = inputs.filter((input) => input.includes(DISTILL_MARKER));
    expect(distillPrompts.length).toBe(1);

    const skipped = await skippedDistillEntries(s.stores);
    expect(skipped.length).toBe(1);
    expect(skipped[0]?.text).toContain('蒸留（shutdown）は見送った');
  });

  it('B: 蒸留の後に新しいターンが1本でも走れば、続く stop() の蒸留は見送らない（取りこぼさない）', async () => {
    const s = setup();

    s.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');

    // 別の会話で通常ターンをもう1本。`s.events` は conv-1 専用の購読なので、
    // conv-2 用の購読をここで別に張って「その通常ターンが終わったこと」を
    // 直接待つ（既存の `wireEvents` をそのまま使い回す — 新しい足場は作らない）。
    const other = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('別件です', 'conv-2'));
    await waitForDone(other.events);

    await s.clone.stop();

    const inputs = (s.calls[0] as FakeCall).inputs;
    const distillPrompts = inputs.filter((input) => input.includes(DISTILL_MARKER));
    expect(distillPrompts.length).toBe(2);
    expect(await skippedDistillEntries(s.stores)).toEqual([]);
  });

  it('C: 蒸留が失敗して終わったら印を下ろさない（次の機会にもう一度試す）', async () => {
    const s = setup(undefined, createMemoryStores(), {
      // ターン0＝人間の発言、ターン1＝endConversation の蒸留。**蒸留のターンだけ**
      // を失敗させる。`error_during_execution` は枠の保持にはならない分類
      // （`classifyUsageNotice` は SDK が失敗として出した文言だけを見るので、
      // 既定の応答文言のままなら `#usageBlocked` は立たない）。
      resultFor: (turnIndex) =>
        turnIndex === 1 ? { subtype: 'error_during_execution', isError: true } : undefined,
    });

    s.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');
    await s.clone.stop();

    const inputs = (s.calls[0] as FakeCall).inputs;
    const distillPrompts = inputs.filter((input) => input.includes(DISTILL_MARKER));
    // 失敗した蒸留は印を下ろさないので、stop() の蒸留は見送られず、もう一度走る。
    expect(distillPrompts.length).toBe(2);
    expect(await skippedDistillEntries(s.stores)).toEqual([]);
  });

  it('D: 最初の会話終了では、蒸留が見送られずにちゃんと走る（重複防止が正常な経路を殺していない）', async () => {
    const s = setup();

    s.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');

    // **ここでアサーションを済ませる。** この時点で `endConversation` の蒸留は
    // 成功しており印は下りているので、この後 `stop()` を呼ぶと、その shutdown
    // 蒸留は「正しく」見送られる（歯Aの管轄）。`stop()` の後で「見送りが無い」を
    // 検査すると、この歯が自分の生んだ見送りエントリで落ちる。
    const inputs = (s.calls[0] as FakeCall).inputs;
    const distillPrompts = inputs.filter((input) => input.includes(DISTILL_MARKER));
    expect(distillPrompts.length).toBe(1);
    expect(await skippedDistillEntries(s.stores)).toEqual([]);

    await s.clone.stop();
  });
});

/**
 * `self_status`（`self.ts` の `CloneRuntimeFacts`）の配線。
 *
 * **`createSdkMcpServer` は道具を MCP の transport の裏へ隠すので、テストから
 * ハンドラを直接呼べない。** `mcpServerFactory`（クローンの `CloneOptions`。
 * 主にテスト用、既定は `createCloneMcpServer`）でその境界を覗く — 差し替えた
 * 関数は渡ってきた `context`（クローンが実際に組み立てたもの。`runtime` を含む）
 * を控えたうえで、本物の `createCloneMcpServer(context)` をそのまま呼ぶ。
 * 道具の実装もクローンが渡す `context` も本物のまま、呼び出しの境界だけを覗ける。
 *
 * `self_status` 自身のハンドラは、控えた `context` から独立に
 * `createCloneTools(context)` を呼んで取り出す（`tools.test.ts` と同じ形）。
 */
describe('クローン — self_status（runtime facts の配線）', () => {
  function setupCapturing(
    env: NodeJS.ProcessEnv = {},
    stores: Stores = createMemoryStores(),
    fakeSdkOptions: Parameters<typeof fakeSdk>[1] = {},
  ) {
    const { fn, calls } = fakeSdk(undefined, fakeSdkOptions);
    let captured: ToolContext | undefined;
    const clone = createClone({
      stores,
      queryFn: fn,
      env,
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
      mcpServerFactory: (context) => {
        captured = context;
        return createCloneMcpServer(context);
      },
    });
    const events: ChatStreamEvent[] = [];
    clone.subscribe('conv-1', (event) => events.push(event));

    return {
      clone,
      events,
      calls,
      async selfStatus(): Promise<string> {
        if (captured === undefined) throw new Error('ToolContext がまだ捕まっていない');
        const tools = createCloneTools(captured);
        const found = tools.find((entry) => entry.name === 'self_status');
        if (!found) throw new Error('self_status という道具が無い');
        const result = await found.handler({} as never, {});
        return (result.content ?? []).map((part) => ('text' in part ? part.text : '')).join('');
      },
    };
  }

  it('ALTEROID_CLONE_MODEL を置いた偽 env で呼ぶと、declaredModel がその値で出て、差し替え済みと読める', async () => {
    const s = setupCapturing({ [CLONE_MODEL_ENV_KEY]: 'まだ無いモデル' });
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const body = await s.selfStatus();
    expect(body).toContain('宣言されたモデル帯: まだ無いモデル');
    expect(body).toContain(`人間が \`${CLONE_MODEL_ENV_KEY}\` に置いた値`);

    await s.clone.stop();
  });

  it('env が無ければ declaredModel は既定（fable）で出て、差し替えなしと読める', async () => {
    const s = setupCapturing({});
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const body = await s.selfStatus();
    expect(body).toContain(`宣言されたモデル帯: ${CLONE_MODEL}`);
    expect(CLONE_MODEL).toBe('fable');
    expect(body).toContain(`既定。\`${CLONE_MODEL_ENV_KEY}\` は置かれていない`);
    expect(body).not.toContain('に置いた値');

    await s.clone.stop();
  });

  it('偽 SDK が init で報告したモデル id が、宣言した帯とは違う文字列としてそのまま出る', async () => {
    const s = setupCapturing({ [CLONE_MODEL_ENV_KEY]: 'まだ無いモデル' });
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const body = await s.selfStatus();
    expect(body).toContain('claude-fake-init-model-xyz');
    // 宣言した帯の値では埋まっていない（「SDK が実際に報告した」行だけを見る）
    const sdkLine = body.split('\n').find((line) => line.includes('SDK が実際に報告したモデル'));
    expect(sdkLine).toBeDefined();
    expect(sdkLine).not.toContain('まだ無いモデル');

    await s.clone.stop();
  });

  /**
   * **`#captureInitFacts` が本物の init メッセージから読んだ `[]` を、そのまま
   * 「観測できた0本」として `self_status` まで運ぶことを確かめる（#324）。**
   * `self.ts` 側の単体テストは `describeCloneRuntime` に直接 `mcpServers: []` を
   * 渡すだけなので、`clone.ts` が実際に init の `mcp_servers: []` を `null` に
   * 潰さず配線できているかはここでしか見えない —— 直しの本体は `clone.ts` の
   * 側（init を観測したかどうかを実際に区別できること）である。
   */
  it('偽 SDK が init で mcp_servers: [] を報告すると、self_status は「0本」と言い「まだ分からない」は出ない', async () => {
    const s = setupCapturing({}, createMemoryStores(), { mcpServers: [] });
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const body = await s.selfStatus();
    const mcpLine = body.split('\n').find((line) => line.includes('MCP サーバ'));
    expect(mcpLine).toBeDefined();
    expect(mcpLine).not.toContain('まだ分からない');
    expect(mcpLine).toContain('0本');

    await s.clone.stop();
  });

  /**
   * **init が届く前の窓を、タイミングの賭けではなく実際にゲートで止めて作る。**
   * `fakeSdk` は init を即座に流すので、ここだけは init の前で止められる専用の
   * 偽 SDK をローカルに用意する（`#buildOptions` は `#ensureQuery` の中で
   * 呼ばれるので、context は init 到着より前に控えられる — その順序を利用する）。
   */
  it('init を観測する前は sdkModel が「まだ分からない」で、帯の値では埋まらない', async () => {
    let releaseInit: () => void = () => undefined;
    const initGate = new Promise<void>((resolve) => {
      releaseInit = resolve;
    });
    let captured: ToolContext | undefined;
    const stores = createMemoryStores();

    const fn = ((params: { prompt: unknown; options?: Options }) => {
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        await initGate;
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-gated',
          uuid: 'uuid-init',
          model: 'claude-fake-init-model-xyz',
          claude_code_version: '9.9.9-fake',
          apiKeySource: 'user',
          permissionMode: 'default',
          mcp_servers: [{ name: 'alteroid', status: 'connected' }],
        } as unknown as SDKMessage;

        for await (const message of params.prompt as AsyncIterable<unknown>) {
          void message; // 入力の中身は見ない。到着したことだけが要る。
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'わかった' }] },
            parent_tool_use_id: null,
            session_id: 'sess-gated',
            uuid: 'uuid-assistant',
          } as unknown as SDKMessage;
          yield {
            type: 'result',
            subtype: 'success',
            result: 'わかった',
            session_id: 'sess-gated',
            uuid: 'uuid-result',
          } as unknown as SDKMessage;
        }
      }
      const generator = generate();
      return Object.assign(generator, {
        close: () => undefined,
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;

    const clone = createClone({
      stores,
      queryFn: fn,
      env: { [CLONE_MODEL_ENV_KEY]: 'まだ無いモデル' },
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
      mcpServerFactory: (context) => {
        captured = context;
        return createCloneMcpServer(context);
      },
    });
    const events: ChatStreamEvent[] = [];
    clone.subscribe('conv-1', (event) => events.push(event));

    clone.post(humanMessage('やあ'));
    // `#buildOptions`（→ `mcpServerFactory`）は `#ensureQuery` の中、init が
    // 届くより前に走る。ここで context が控えられるのを待つ（init はまだ
    // `initGate` で止めてある）。
    await expect.poll(() => captured !== undefined, { timeout: 3000 }).toBe(true);

    if (captured === undefined) throw new Error('ToolContext がまだ捕まっていない');
    const tools = createCloneTools(captured);
    const found = tools.find((entry) => entry.name === 'self_status');
    if (!found) throw new Error('self_status という道具が無い');
    const result = await found.handler({} as never, {});
    const body = (result.content ?? []).map((part) => ('text' in part ? part.text : '')).join('');

    expect(body).toContain('SDK が実際に報告したモデル id: まだ分からない');
    expect(body).not.toContain('claude-fake-init-model-xyz');
    // init 未観測のこの窓では MCP サーバも「まだ分からない」——「0本」ではない
    // （#324）。gate の向こう側で init は非空の mcp_servers を運んでくるので、
    // ここで「0本」が出ていたら「未観測」と「観測できた0本」を区別できていない。
    const mcpLine = body.split('\n').find((line) => line.includes('MCP サーバ'));
    expect(mcpLine).toBeDefined();
    expect(mcpLine).toContain('まだ分からない');
    expect(mcpLine).not.toContain('0本');

    releaseInit();
    await waitForDone(events);
    await clone.stop();
  });

  it('effort が一度も報告されていなければ「まだ分からない」で、既定値では埋まらない', async () => {
    const s = setupCapturing({});
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const body = await s.selfStatus();
    expect(body).toContain('effort（実効値）: まだ分からない');
    expect(body).not.toMatch(/効な effort.*(low|medium|high|xhigh|max)/);

    await s.clone.stop();
  });

  it('PostToolUse フックが effort: xhigh を運ぶと、self_status にその値が出る', async () => {
    const s = setupCapturing({});
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    // **偽 SDK に本物として登録されたフックを、実際に呼ぶ。** 私有フィールドを
    // 直接触らない（`options.hooks.PostToolUse[0].hooks[0]` を叩く。既存の
    // PreCompact フックのテストと同じ形）。
    const main = s.calls[0];
    const hook = main?.options.hooks?.PostToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
    await hook({ effort: { level: 'xhigh' } } as never, undefined, {
      signal: new AbortController().signal,
    } as never);

    const body = await s.selfStatus();
    expect(body).toContain('effort（実効値）: xhigh');

    await s.clone.stop();
  });

  it('既定と同じ値を人間が置いた場合も「置かれている」と出る（値の比較で言い換えていない）', async () => {
    const s = setupCapturing({ [CLONE_MODEL_ENV_KEY]: CLONE_MODEL });
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const body = await s.selfStatus();
    expect(body).toContain(`宣言されたモデル帯: ${CLONE_MODEL}`);
    // 置いた値が既定と同じでも、置かれている事実は消えない
    expect(body).toContain(`人間が \`${CLONE_MODEL_ENV_KEY}\` に置いた値`);
    expect(body).not.toContain('は置かれていない');

    await s.clone.stop();
  });

  /**
   * **セッションを開き直したら、前のセッションで観測した値は捨てる。**
   *
   * 残すと、新しいセッションの init が届く前（あるいは届かないまま）に
   * `self_status` が前のセッションの値を「いまの値」として返す — 観測していない
   * ものを確信する形になり、この道具の存在理由そのものが壊れる。
   *
   * 1本目のセッションは init（モデル id 付き）を流してから落ち、2本目は
   * **init を1度も流さない**偽 SDK を使う。持ち越していれば1本目の値が出る。
   */
  it('セッションを開き直すと、前のセッションで観測したモデル id と effort を持ち越さない', async () => {
    let attempt = 0;
    let captured: ToolContext | undefined;
    const calls: Options[] = [];

    const fn = ((params: { prompt: unknown; options?: Options }) => {
      calls.push(params.options ?? {});
      const round = ++attempt;
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        if (round === 1) {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'sess-first',
            uuid: 'uuid-init',
            model: 'claude-first-session-model',
            claude_code_version: '1.1.1-first',
            apiKeySource: 'user',
            permissionMode: 'default',
            mcp_servers: [{ name: 'alteroid', status: 'connected' }],
          } as unknown as SDKMessage;
          // 1往復だけ返してからセッションが落ちる（＝ `#query` が捨てられる）。
          for await (const message of params.prompt as AsyncIterable<unknown>) {
            void message;
            yield {
              type: 'result',
              subtype: 'success',
              result: 'わかった',
              session_id: 'sess-first',
              uuid: 'uuid-result',
            } as unknown as SDKMessage;
            throw new Error('1本目のセッションが落ちた');
          }
          return;
        }
        // 2本目は init を1度も流さない。**持ち越していればここで1本目の値が出る。**
        for await (const message of params.prompt as AsyncIterable<unknown>) {
          void message;
          yield {
            type: 'result',
            subtype: 'success',
            result: 'わかった',
            session_id: 'sess-second',
            uuid: 'uuid-result-2',
          } as unknown as SDKMessage;
        }
      }
      const generator = generate();
      return Object.assign(generator, {
        close: () => undefined,
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;

    const clone = createClone({
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
      mcpServerFactory: (context) => {
        captured = context;
        return createCloneMcpServer(context);
      },
    });
    const events: ChatStreamEvent[] = [];
    clone.subscribe('conv-1', (event) => events.push(event));

    async function selfStatus(): Promise<string> {
      if (captured === undefined) throw new Error('ToolContext がまだ捕まっていない');
      const found = createCloneTools(captured).find((entry) => entry.name === 'self_status');
      if (!found) throw new Error('self_status という道具が無い');
      const result = await found.handler({} as never, {});
      return (result.content ?? []).map((part) => ('text' in part ? part.text : '')).join('');
    }

    // 1本目 — init を観測し、フックで effort も観測させる。
    clone.post(humanMessage('やあ'));
    await waitForDone(events);
    const hook = calls[0]?.hooks?.PostToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
    await hook({ effort: { level: 'xhigh' } } as never, undefined, {
      signal: new AbortController().signal,
    } as never);
    const first = await selfStatus();
    expect(first).toContain('claude-first-session-model');
    expect(first).toContain('effort（実効値）: xhigh');

    // 2本目 — セッションが落ちたので開き直る（`calls` が2本になるまで待つ）。
    events.length = 0;
    clone.post(humanMessage('もう一度'));
    await expect.poll(() => calls.length, { timeout: 3000 }).toBe(2);
    await waitForDone(events);

    const second = await selfStatus();
    expect(second).toContain('SDK が実際に報告したモデル id: まだ分からない');
    expect(second).not.toContain('claude-first-session-model');
    expect(second).toContain('effort（実効値）: まだ分からない');
    expect(second).not.toContain('effort（実効値）: xhigh');

    await clone.stop();
  });

  /**
   * `injectedMemoryChars` が名乗っているのは**「このセッションを組み立てた時点」**の
   * 文字数である。
   *
   * かつてこの値は、載せ直しの控え（記憶の全文を持っていたフィールド）の長さを
   * そのまま返していた。載せ直しが起きるとその控えが更新されるので、**走行中に
   * 人間が記憶を直すと、この行だけが黙って「いまの総文字数」に化けていた**
   * （そう名乗っていないのに）。`tools.test.ts` は固定値を渡すので、この配線の
   * ずれはクローン側から見ないと出ない。
   */
  it('焼き込んだ記憶の文字数は、走行中に人間が記憶を直しても動かない', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('values', `# 価値観\n\n${'あ'.repeat(50)}\n`);
    const s = setupCapturing({}, stores);

    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    const baked = renderMemoryDocuments(await stores.persona.documents()).length;
    const line = `焼き込んだ記憶の文字数（このセッションを組み立てた時点）: ${baked.toLocaleString('en-US')} 文字`;
    expect(await s.selfStatus()).toContain(line);

    // 人間が記憶を大きく書き換える（載せ直しが起きる量にする）
    await stores.persona.write('values', `# 価値観\n\n${'い'.repeat(5000)}\n`);
    const events: ChatStreamEvent[] = [];
    s.clone.subscribe('conv-2', (event) => events.push(event));
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);
    // 載せ直しが実際に起きたことを確かめてから、動いていないことを見る
    expect((s.calls[0] as FakeCall).inputs[1] ?? '').toContain('記憶が更新された');

    expect(await s.selfStatus()).toContain(line);

    await s.clone.stop();
  });
});

/**
 * `memory_update.cause` の配線 — 蒸留のターンが書いた記憶と、通常のターンが
 * 書いた記憶を、日誌の上で区別できるか。
 *
 * enum に `'distill'` があっても、それを書く本番コードが1つも無ければ、
 * 絞り込んだ側には常に `'clone'` が返り、蒸留は記憶を書いていないと読める。
 * `AGENTS.md`「踏みやすい地雷」の**「取れない軸に 0 の行を作る」**（＝「使って
 * いない」と読める／取れないことが出力から消える）と同じ形だが、**ここは
 * それより一段悪い — 軸は取れる**（実行文脈から導ける）**のに、取れるものに
 * ついて嘘の 0 を出していた。** しかも `cause` の enum は
 * `apps/daemon/openapi.json` に載っている公開の契約なので、その 0 は外へ
 * 出ていた。
 *
 * **`docs/PRD.md`「provider が持たない能力を、持っているように見せない」は
 * ここの根拠ではない。** あちらは provider の能力（許可確認を上げられない
 * provider に「それらしい確認」を出す形）についての要件であって、字義が違う。
 */
describe('クローン — memory_update の cause 配線（蒸留と通常ターンの区別）', () => {
  /**
   * 各ターンの入力が届いた直後、外から解放するまで待つ偽 SDK。
   *
   * **`fakeSdk` では代用できない** — あちらの `reply` は同期関数で `await` を
   * 挟めない。ここでは「入力が届いた（＝ `Clone#turn` が立ち、`kind` が確定
   * した）」瞬間と「結果を返す」瞬間のあいだへ、外から割り込む窓を作る。
   * 窓の中で道具のハンドラを直接呼べば、「そのターンが走っている最中に
   * 書いた記憶」の `cause` を確かめられる。
   *
   * **ターンの外で呼ぶと意味を失う** — `#turn` は `#finishTurn()` でターンの
   * 終わりに `null` へ戻るので、外側で呼ぶと `memoryCause` は既定の `'clone'`
   * に落ち、「蒸留ターンが走っている最中に書いた」という条件を確かめられない。
   */
  function fakeGatedSdk() {
    const calls: FakeCall[] = [];
    const gates = new Map<string, () => void>();
    // 素通しスイッチ。`true` にした後に届く入力はゲートへ登録せず、その場で
    // 先へ進む（誰も `release` を呼ばなくても対応する `result` まで進む）。
    // 片付け（`stop()` など）を、本番の重複防止（`#hasUndistilledActivity`）の
    // 挙動——見送られるか、もう1本ターンが増えるか——に依存させないための道具。
    let passThrough = false;

    const fn = ((params: { prompt: unknown; options?: Options }) => {
      const call: FakeCall = { options: params.options ?? {}, inputs: [] };
      const callIndex = calls.length;
      calls.push(call);

      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-fake',
          uuid: 'uuid-init',
        } as unknown as SDKMessage;

        let turnIndex = 0;
        for await (const message of params.prompt as AsyncIterable<{
          message: { content: unknown };
        }>) {
          const text = String(message.message.content);
          call.inputs.push(text);
          const key = `${callIndex}:${turnIndex}`;
          // **ここで止める。** 解放されるまで、このターンは「走っている最中」
          // のままである（`this.#turn` が立ち、`kind` が確定している）。
          // ただし素通しスイッチが入っていれば待たずに先へ進む。
          if (!passThrough) {
            await new Promise<void>((resolve) => {
              gates.set(key, resolve);
            });
          }
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'わかった' }] },
            parent_tool_use_id: null,
            session_id: 'sess-fake',
            uuid: `uuid-assistant-${key}`,
          } as unknown as SDKMessage;
          yield {
            type: 'result',
            subtype: 'success',
            result: 'わかった',
            session_id: 'sess-fake',
            uuid: `uuid-result-${key}`,
          } as unknown as SDKMessage;
          turnIndex += 1;
        }
      }

      const generator = generate();
      return Object.assign(generator, {
        close: () => undefined,
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;

    return {
      fn,
      calls,
      /** 指定したターンの窓を解放する（まだ届いていなければ例外で落ちる）。 */
      release(callIndex: number, turnIndex: number): void {
        const key = `${callIndex}:${turnIndex}`;
        const resolve = gates.get(key);
        if (resolve === undefined) throw new Error(`ゲート ${key} がまだ無い`);
        gates.delete(key);
        resolve();
      },
      /**
       * 以後届く入力はゲートで待たず素通しする。**片付けの直前に呼ぶこと。**
       * これを呼んだ後は、本番の重複防止が「見送る」か「もう1本ターンを
       * 増やす」かのどちらであっても、そのターンはゲートに引っかからず
       * 進むので、片付けが本番の別の機能の挙動へ依存しなくなる。
       */
      openGate(): void {
        passThrough = true;
      },
    };
  }

  /**
   * `setup` と同じ配線（本物の SDK やマネージャーを誤って起こさない）だが、
   * `queryFn` を `fakeGatedSdk` に差し替え、`mcpServerFactory` の中で
   * **本物の配線と同じタイミングで一度だけ** `createCloneTools` を呼んで
   * 道具の配列を控える。
   *
   * **`callTool` のたびに `createCloneTools` を呼び直さないこと。** 本番では
   * `createCloneTools` はセッションを組むとき（`mcpServerFactory` 呼び出し時）
   * に一度だけ呼ばれ、以後のターンはすべて同じ道具の配列を使い回す
   * （`createCloneMcpServer` の中）。呼び直す形でテストを書くと、
   * 「`createCloneTools` の呼び出し時に1回だけ評価する」変異
   * （`memoryCause` をハンドラの外で先に確定させる形）と「道具の実行時に
   * 毎回評価する」正しい実装が、テストからは区別できなくなる — 呼び直す
   * たびに変異後のコードも新しく評価し直されてしまうため。
   */
  function setupGated() {
    const { fn, calls, release, openGate } = fakeGatedSdk();
    let tools: ReturnType<typeof createCloneTools> | undefined;
    const stores = createMemoryStores();
    const clone = createClone({
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
      mcpServerFactory: (context) => {
        tools = createCloneTools(context);
        return createCloneMcpServer(context);
      },
    });
    const { events, waitForEvents } = wireEvents(clone, 'conv-1');
    return {
      clone,
      stores,
      calls,
      events,
      waitForEvents,
      release,
      openGate,
      tools(): ReturnType<typeof createCloneTools> {
        if (tools === undefined) throw new Error('道具の配列がまだ作られていない');
        return tools;
      },
    };
  }

  /** 控えた道具の配列から1本取り出し、ハンドラを直接呼ぶ。 */
  async function callTool(
    tools: ReturnType<typeof createCloneTools>,
    name: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    const found = tools.find((entry) => entry.name === name);
    if (!found) throw new Error(`${name} という道具が無い`);
    await found.handler(args as never, {} as never);
  }

  it('T1: 本セッションの蒸留ターンが書いた記憶は cause: distill になる', async () => {
    const s = setupGated();
    // **human guard（記憶の保護）の前提を先に満たしておく。** `values` に
    // 一度も書き込みが無い（履歴が無い＝ unknown）状態のまま distill から
    // `memory_write`（全文置換）すると、その歯で断られてしまい journal に
    // `memory_update` が1件も残らない——ここで確かめたいのは「distill が書けば
    // cause: distill になる」ことであって、歯そのものはガードのテスト
    // （`tools.test.ts`）が持つ。既存の記憶を蒸留が上書きする、という現実の
    // 形に合わせて先に1回 clone-only の下書きを作っておく。
    await s.stores.persona.write('values', '# 価値観\n\n（下書き）\n');

    // 1本目 — 通常ターンをまず1本通し、セッションを確立する
    // （`endConversation` は `this.#query` が無ければ何もしない）。
    s.clone.post(humanMessage('やあ'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '1本目の入力');
    s.release(0, 0);
    await waitForDone(s.events);

    // 2本目 — 会話終了で促される蒸留ターン。`endConversation` は完了を待つので
    // await せず、ターンが走っている最中に道具を呼んでから解放する。
    const endPromise = s.clone.endConversation('conv-1');
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 2, '蒸留ターンの入力');
    // 見分け方は文面（`buildDistillPrompt` が書く固定の呼びかけ）。
    expect(s.calls[0]?.inputs[1]).toContain('記憶へ移すべきものがあるか確認せよ');

    await callTool(s.tools(), 'memory_write', {
      slug: 'values',
      content: '# 価値観\n\n蒸留が書いた\n',
      summary: '蒸留の書き込みテスト（T1）',
    });

    s.release(0, 1);
    await endPromise;

    const entries = await s.stores.journal.list({ types: ['memory_update'] });
    expect(entries.at(-1)).toMatchObject({ cause: 'distill' });

    // 片付け。`stop()` が shutdown 蒸留をもう1本走らせるかどうか
    // （＝重複防止 `#hasUndistilledActivity` が下りているか）に依存しない
    // よう、以後の入力はゲートで待たず素通しにする。見送られて新しい
    // ターンが増えなくても、増えても、どちらでも `stop()` は返る。
    s.openGate();
    await s.clone.stop();
  });

  it('T2: 本セッションの通常ターン（人間の発言）が書いた記憶は cause: clone のまま', async () => {
    const s = setupGated();

    s.clone.post(humanMessage('やあ'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '通常ターンの入力');

    await callTool(s.tools(), 'memory_write', {
      slug: 'values',
      content: '# 価値観\n\n通常ターンが書いた\n',
      summary: '通常ターンの書き込みテスト（T2）',
    });

    s.release(0, 0);
    await waitForDone(s.events);

    const entries = await s.stores.journal.list({ types: ['memory_update'] });
    expect(entries.at(-1)).toMatchObject({ cause: 'clone' });

    // ここでは `#hasUndistilledActivity` がまだ立っているので、`stop()` は
    // shutdown 蒸留をもう1本走らせる。そのターンも解放してやる必要がある
    // （解放しないと `stop()` が `#reader` の完了待ちで戻らない）。
    const stopPromise = s.clone.stop();
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 2, 'shutdown 蒸留の入力');
    s.release(0, 1);
    await stopPromise;
  });

  it('T3: pre_compact のサイドクエリが書いた記憶は cause: distill になる', async () => {
    const { fn, calls } = fakeSdk();
    // **ここも `mcpServerFactory` の呼び出し時に一度だけ `createCloneTools` を
    // 呼ぶ**（`setupGated` の doc と同じ理由。本セッションとサイドクエリで
    // それぞれ1回ずつ呼ばれるので、道具の配列も2本控わる）。
    const toolsLists: ReturnType<typeof createCloneTools>[] = [];
    const stores = createMemoryStores();
    // T1 と同じ理由（human guard: 履歴の無い `values` への distill 全文置換は
    // 断られる。ここで確かめたいのは cause: distill のタグ付けであって、
    // 歯そのものは `tools.test.ts` が持つ）。
    await stores.persona.write('values', '# 価値観\n\n（下書き）\n');
    const clone = createClone({
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
      mcpServerFactory: (context) => {
        toolsLists.push(createCloneTools(context));
        return createCloneMcpServer(context);
      },
    });
    const { events } = wireEvents(clone, 'conv-1');

    clone.post(humanMessage('やあ'));
    await waitForDone(events);

    const main = calls[0] as FakeCall;
    const dir = await mkdtemp(join(tmpdir(), 'alteroid-distill-cause-'));
    try {
      const transcriptPath = join(dir, 'transcript.jsonl');
      await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
      const preCompact = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
      if (preCompact === undefined) throw new Error('PreCompact フックが登録されていない');
      await preCompact(
        { session_id: 'sess-fake', transcript_path: transcriptPath } as never,
        undefined,
        { signal: new AbortController().signal } as never,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    // `mcpServerFactory` は本セッションの初期化で1回、サイドクエリでもう1回呼ばれる。
    // **サイドクエリで控えた側（2回目）を使う**（依頼書の指示どおり）。
    expect(toolsLists.length).toBe(2);
    const sideTools = toolsLists[1];
    if (sideTools === undefined) throw new Error('サイドクエリの道具の配列が控えられていない');

    await callTool(sideTools, 'memory_write', {
      slug: 'values',
      content: '# 価値観\n\nサイドクエリが書いた\n',
      summary: 'サイドクエリの書き込みテスト（T3）',
    });

    const entries = await stores.journal.list({ types: ['memory_update'] });
    expect(entries.at(-1)).toMatchObject({ cause: 'distill' });

    await clone.stop();
  });

  it('T4: 蒸留が追記すると、cause: distill と action: append の両方が出る', async () => {
    const s = setupGated();

    s.clone.post(humanMessage('やあ'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '1本目の入力');
    s.release(0, 0);
    await waitForDone(s.events);

    const endPromise = s.clone.endConversation('conv-1');
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 2, '蒸留ターンの入力');

    await callTool(s.tools(), 'memory_append', {
      slug: 'values',
      content: '追記した学び\n',
      summary: '蒸留の追記テスト（T4）',
    });

    s.release(0, 1);
    await endPromise;

    const entries = await s.stores.journal.list({ types: ['memory_update'] });
    expect(entries.at(-1)).toMatchObject({ cause: 'distill', action: 'append' });

    // 片付け。T1 と同じ理由で、以後の入力はゲートで待たず素通しにする。
    s.openGate();
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

  /**
   * 発意 tick の要約（digest）に `ManagerPool` の liveness が渡っていること
   * （#5243d633）。
   *
   * `#recentDigest` は `digest.ts` の `buildActivityDigest` を呼ぶだけで、
   * `live`（＝いま話しかけられるか）はジョブ台帳の軸ではなく
   * `ManagerPool#list()` が実行時に返すものである。ここへ配線し忘れると、
   * digest の「マネージャー」節は常に「セッション不明」（`liveness` 省略時の
   * 既定）になり、`manager_list` の実際の状態（`live: false` ＝セッション
   * 切断）とは違う文言のまま tick がクローンへ届く——今回直した実害
   * （終わった仕事へ3本目の委譲を出した）と同じ形の穴が、配線側にも開き
   * うる。
   *
   * `#dailyReport` 側の配線は `digest.test.ts` の `describeManagerState` の
   * 歯と合わせてここでは測らない——`buildActivityDigest` へ `liveness` が
   * 届けば `describeManagerState` は同じ字面を出すので、**tick 側の配線が
   * 生きていること**をここでは見る。
   */
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
    // `throwingPool`（上の「managers.list() が投げても…」の歯）と同じ形の
    // スタブ。このテストで使うのは `list()` だけなので、それ以外は
    // 呼ばれない前提で投げる。
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
      runnerBacklog: () => [],
      runners: () => {
        throw new Error('not implemented');
      },
      transcript: () => {
        throw new Error('not implemented');
      },
      restore: () => Promise.resolve([]),
      reattachRunner: () => Promise.resolve(),
      probeTurnEnds: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    };

    const clone = createClone({ stores, queryFn: fn, managers: pool });

    clone.post({
      type: 'self_initiative',
      id: 'evt-self-liveness',
      at: new Date().toISOString(),
      reason: '定期 tick',
    });

    const inputs = () => (calls[0]?.inputs ?? []).join('\n');
    await expect
      .poll(() => inputs().includes('mgr-alive') && inputs().includes('mgr-dead'), {
        timeout: 3000,
      })
      .toBe(true);

    const text = inputs();
    // `describeManagerState` と同じ字面（`digest.test.ts` で直接測っている）。
    // ここで見るのは、配線を通ってその字面が tick のプロンプトまで実際に
    // 届くことである。
    expect(text).toContain('mgr-alive [running]');
    expect(text).toContain('mgr-dead [running/セッション切断]');

    await clone.stop();
  });

  /**
   * 「記憶の床」の1行（#553 F2）。挿入点は `#recentDigest()`（`clone.ts`）で、
   * `self_initiative` / `timer` の両 tick に載り、日報には載らない
   * （`#recentDigestBare` を切り出した理由）。ここから下の一連の歯が、
   * その分岐を1つずつ確かめる。
   */
  describe('記憶の床（tick の digest 先頭、#553 F2）', () => {
    it('発意 tick の digest の先頭に床の行が在り、基準未確立・前回tick無しを言う', async () => {
      const s = setup(() => '今回は動かない');

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-floor-first',
        at: new Date().toISOString(),
        reason: '定期 tick',
      });

      await expect
        .poll(() => inputsOf(s)().includes('以下は直近の状況である。'), { timeout: 3000 })
        .toBe(true);

      const text = inputsOf(s)();
      // digest の**先頭**が床の行である（見出しの直後に直接続く）。
      expect(text).toContain('以下は直近の状況である。\n\n記憶の床:');
      // tick は `#runInternal`（＝セッション構築）より前に digest を作るので、
      // プロセス最初のセッションがまだ組まれていない tick が実在する
      // （`#promptMemoryChars === 0`）。0 を基準として「n 文字増えた」とは
      // 名乗らない。
      expect(text).toContain('基準がまだ無いので線の判定は出せない。');
      // このプロセスで最初の tick なので、前回との差分は出せない。
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
      await expect
        .poll(() => call()?.inputs.some((input) => input.includes('何かする')), {
          timeout: 3000,
        })
        .toBe(true);
      expect(call()?.inputs.at(-1)).toContain('以下は直近の状況である。\n\n記憶の床:');

      s.clone.post({
        type: 'timer',
        id: 'evt-timer-daily',
        at: new Date().toISOString(),
        kind: 'daily_report',
        target: '2026-08-11',
      });
      await expect
        .poll(() => s.stores.journal.list({ types: ['daily_report'] }), { timeout: 3000 })
        .toHaveLength(1);

      const dailyPrompt = call()?.inputs.at(-1) ?? '';
      expect(dailyPrompt).toContain('以下はこの日の記録の要約である。');
      // ⛔ 日報には床の行を出さない（依頼者の明示指定）。
      expect(dailyPrompt).not.toContain('記憶の床:');

      await s.clone.stop();
    });

    it('2回目の tick で「前回の tick から ±N 文字」が出る（1回目では出ない）。線を超えたら印が出る', async () => {
      const stores = createMemoryStores();
      await stores.persona.write('note', `# Note\n\n${'a'.repeat(200)}\n`);
      const s = setup(() => 'わかった', stores);
      const call = () => s.calls[0];

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-diff-1',
        at: new Date().toISOString(),
        reason: '1本目',
      });
      await expect.poll(() => (call()?.inputs.length ?? 0) === 1, { timeout: 3000 }).toBe(true);
      const firstText = call()?.inputs[0] ?? '';
      expect(firstText).toContain(
        '前回の tick が無いので差分は出せない（このプロセスでの最初の tick）。',
      );
      expect(firstText).not.toMatch(/前回の tick から/);
      // 1本目の tick 自身がセッションを組むので、以後は基準が確立している
      // （閾値 10% を超えないぶんの増分では、線の印はまだ出ない）。
      expect(firstText).not.toContain('⚠️ 線（');

      // 1本目の tick が組んだセッションの基準（= このときの床の絶対値）。
      const baseline = measureMemoryFloor(await stores.persona.documents()).totalChars;

      // 基準から +20% 超の増分を作る（線 = +10% を確実に超える）。
      const extra = Math.ceil(baseline * 0.2) + 50;
      await stores.persona.write('note', `# Note\n\n${'a'.repeat(200 + extra)}\n`);
      const grownFloor = measureMemoryFloor(await stores.persona.documents()).totalChars;
      const expectedDiff = grownFloor - baseline;

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-diff-2',
        at: new Date().toISOString(),
        reason: '2本目',
      });
      await expect.poll(() => (call()?.inputs.length ?? 0) === 2, { timeout: 3000 }).toBe(true);
      const secondText = call()?.inputs[1] ?? '';
      expect(secondText).toContain(
        `前回の tick から +${expectedDiff.toLocaleString('en-US')} 文字。`,
      );
      expect(secondText).toContain('⚠️ 線（セッション構築時点から +10%）に達している。');

      await s.clone.stop();
    });

    it('線（+10%）を超えないときは印が出ない', async () => {
      const stores = createMemoryStores();
      await stores.persona.write('note', `# Note\n\n${'a'.repeat(400)}\n`);
      const s = setup(() => 'わかった', stores);
      const call = () => s.calls[0];

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-under-1',
        at: new Date().toISOString(),
        reason: '1本目',
      });
      await expect.poll(() => (call()?.inputs.length ?? 0) === 1, { timeout: 3000 }).toBe(true);

      const baseline = measureMemoryFloor(await stores.persona.documents()).totalChars;
      // 基準から +5% ぶんだけ増やす（線 = +10% の半分。確実に超えない）。
      const smallExtra = Math.max(1, Math.floor(baseline * 0.05));
      await stores.persona.write('note', `# Note\n\n${'a'.repeat(400 + smallExtra)}\n`);

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-under-2',
        at: new Date().toISOString(),
        reason: '2本目',
      });
      await expect.poll(() => (call()?.inputs.length ?? 0) === 2, { timeout: 3000 }).toBe(true);
      const secondText = call()?.inputs[1] ?? '';
      // 差分そのものは出るが、線の印は出ない。
      expect(secondText).toMatch(/前回の tick から \+\d/);
      expect(secondText).not.toContain('⚠️ 線（');

      await s.clone.stop();
    });

    /**
     * **線ちょうど（+10.0%）でも印が出る**（`>` ではなく `>=` である、の側）。
     *
     * 依頼者（クローン）が自分の記憶へ書いている語が「+10% に**達した**ので
     * 畳んだ」であること、そして「+10.0% と表示しながら印が出ない」という
     * 表示と判定の食い違いを作らないことの2つが理由（`#memoryFloorDigestLine`
     * の doc）。**境界そのものを測る歯なので、境界に居ることを歯自身が
     * 確かめる**——丸めた百分率がちょうど 10.0 でなければ、この歯は境界を
     * 測っていないことになるので落ちる。
     */
    it('線ちょうど（+10.0%）でも印が出る（線に達したら印、の側）', async () => {
      const stores = createMemoryStores();
      await stores.persona.write('note', `# Note\n\n${'a'.repeat(5_000)}\n`);
      const s = setup(() => 'わかった', stores);
      const call = () => s.calls[0];

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-exact-1',
        at: new Date().toISOString(),
        reason: '1本目',
      });
      await expect.poll(() => (call()?.inputs.length ?? 0) === 1, { timeout: 3000 }).toBe(true);

      // 1本目の tick が組んだセッションの基準。
      const baseline = measureMemoryFloor(await stores.persona.documents()).totalChars;
      await stores.persona.write(
        'note',
        `# Note\n\n${'a'.repeat(5_000 + Math.round(baseline * 0.1))}\n`,
      );

      // **歯自身が境界に居ることを確かめる。** 実装と同じ丸め方
      // （小数第1位）で、ちょうど 10.0 になっていること。
      const grown = measureMemoryFloor(await stores.persona.documents()).totalChars;
      expect(Math.round(((grown - baseline) / baseline) * 100 * 10) / 10).toBe(10);

      s.clone.post({
        type: 'self_initiative',
        id: 'evt-exact-2',
        at: new Date().toISOString(),
        reason: '2本目',
      });
      await expect.poll(() => (call()?.inputs.length ?? 0) === 2, { timeout: 3000 }).toBe(true);
      expect(call()?.inputs[1] ?? '').toContain(
        '⚠️ 線（セッション構築時点から +10%）に達している。',
      );

      await s.clone.stop();
    });

    it('記憶の床が測れないとき、0 を名乗らず「測れなかった」と言う（digest 本体は壊れない）', async () => {
      const base = createMemoryStores();
      // **床の測定（`#memoryFloorDigestLine`）だけを壊す。** `persona.documents()`
      // は `#buildOptions`（システムプロンプトの組み立て）や `#withFreshMemory`
      // からも呼ばれるので、無条件に投げるとセッションの構築そのものが壊れて
      // ターンが1本も走らなくなる（実測: 無条件に投げると入力がSDKへ一切
      // 届かずタイムアウトした）。tick の digest は `#runInternal`（＝
      // `#ensureQuery`）より前に作られるので、**このターンで最初に呼ばれる
      // 1回**が床の測定である。それだけを壊す。
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
      await expect.poll(() => (s.calls[0]?.inputs.length ?? 0) === 1, { timeout: 3000 }).toBe(true);

      const text = s.calls[0]?.inputs[0] ?? '';
      expect(text).toContain(
        '記憶の床: 測れなかった（理由: Error: persona 読み込み失敗（実測を模す））。',
      );
      // 床の行の中に数字を1つも作っていない（0 を名乗っていない）。
      expect(text).not.toMatch(/記憶の床:[^\n]*\d/);
      // digest 本体（`buildActivityDigest`）は persona を見ないので壊れない。
      expect(text).toContain('聞かずに動いたなら');

      await s.clone.stop();
    });

    /**
     * 「基準が取り直された」（resume 等でセッションが組み直され、% が
     * 説明なく下がって見える）警告。
     *
     * **本当に別の値へ組み直させる**（スタブでの偽装ではない）ために、
     * 人間の発言で組んだセッション1を `endSessionAfterTurn: 0` で終わらせ
     * （`#query === null` に戻ることは、既存の歯——このファイルの
     * 「受信箱が閉じた後に…」歯——が同じ形で頼っている観測点である）、
     * その間に記憶の中身を書き換えてから発意 tick を2本続ける。
     *
     * 1本目の tick 自身は「組み直す前」の基準しか知らない（このtickが
     * 新しいセッションを組む張本人であり、digest はそのセッション構築より
     * 前に作られるため）。**基準の食い違いが digest に現れるのは次の
     * tick である** — これは実装（`#lastTickMemoryBaselineChars` を
     * 前回tick時点の値として比べる設計）そのものの帰結であって、この歯が
     * 都合よく2本目まで待っているのではない。
     */
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
      // このtick自身はまだ組み直す前の基準（baseline1）しか知らない。
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
    // 添えるのは**元の発火時刻**（復旧時刻に置き換えない）
    expect(inputsOf(restarted)()).toContain('2026-08-12T00:00:00.000Z');

    // 終わったので印は消え、定期の基準が進む
    await expect
      .poll(async () => (await stores.schedules.list())[0]?.pendingRun, { timeout: 3000 })
      .toBeUndefined();
    expect((await stores.schedules.list())[0]?.lastScheduledRunAt).toBeDefined();

    scheduler.stop();
    await restarted.clone.stop();
  });

  it('配り直された発火は、元の時刻・元の理由で確定する', async () => {
    const stores = createMemoryStores();
    // 09:10 の手動発火を引き受けたまま落ちた状態
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
    // スケジューラが配り直す形（元の時刻・元の理由をそのまま運ぶ）
    s.clone.post({
      type: 'timer',
      id: 'evt-resume',
      at: '2026-08-12T09:10:00.000Z',
      kind: 'issue-round',
      cause: 'manual',
    });

    await expect
      .poll(async () => (await stores.schedules.list())[0]?.pendingRun, { timeout: 3000 })
      .toBeUndefined();

    const after = (await stores.schedules.list())[0];
    // 手で起こした1回だったので、配り直しても定期の基準は動かない
    expect(after?.lastScheduledRunAt).toBeUndefined();
    expect(after?.lastRunAt).toBe('2026-08-12T09:10:00.000Z');
    // 走りかけていたことは元の時刻で伝わる
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

/**
 * `#forget` の消し込み（`inbox.remove`）まわりの直し（issue #256）。
 *
 * **終了条件は2つ**——(1) `commitment_close` と `inbox.remove` の間に失敗が
 * 挟まっても検出できない状態を無くす（ここでは `remove` 単体の一時的な失敗を
 * 拾い直す形で対応する。理由は `#forget` の doc を見よ——ターンをまたぐ
 * トランザクションは安全に組めない） (2) `#forget` のメモリ上の印
 * （`#unread` / `#redelivered` / `#redeliveredClosed`）のクリアが `remove`
 * 成功後に回ること。(2) は private field なので直接は見えないが、**(2) が
 * 直っていなければ (1) の拾い直しは成立しない**（印を先に消すと、拾い直しの
 * 意味が無くなる）——なので下の「拾い直して実際に消える」テストは (2) の
 * 間接証拠でもある。
 */
describe('クローン — commitment_close と inbox.remove の消し込み（issue #256）', () => {
  it('inbox.remove が一時的に失敗しても、拾い直して実際に消える', async () => {
    const base = createMemoryStores();
    // 最初の2回だけ失敗させ、3回目（FORGET_RETRY_ATTEMPTS の最後）で成功させる。
    const { stores, calls } = flakyInboxRemove(base, 2, '瞬断');
    const s = setup(() => 'わかった', stores);

    const event = humanMessage('やあ');
    s.clone.post(event);
    await waitForDone(s.events);

    // `done` はターンの `try` の中で先に届く。`#forget` の拾い直し
    // （`FORGET_RETRY_MS` の待ちを挟む）は `finally` 側の後始末なので、
    // 消えるまで別に待つ。
    await waitFor(async () => {
      const pending = await stores.inbox.claimPending();
      return !pending.some((p) => p.event.id === event.id);
    }, '拾い直した末に inbox から消える');
    expect(calls.length).toBe(3);

    await s.clone.stop();
  }, 10_000);

  it('拾い直しても消せなければ、跡を残したうえで消さずに次の起動へ委ねる', async () => {
    const base = createMemoryStores();
    // `FORGET_RETRY_ATTEMPTS`（3）を超えて恒久的に失敗させる。
    const { stores, calls } = flakyInboxRemove(base, 10, '恒久的な障害');
    const s = setup(() => 'わかった', stores);

    const event = humanMessage('やあ');
    const lines = await captureStderr(async () => {
      s.clone.post(event);
      await waitForDone(s.events);
      // 拾い直しの間隔（`FORGET_RETRY_MS` × (1+2) ≒ 600ms）ぶん待って
      // 諦めきるのを待つ。
      await new Promise((resolve) => setTimeout(resolve, 1200));
    });

    // 消せなかったことが跡として残る（黙って消えていない）。
    expect(lines.some((line) => line.includes('未読の消し込み'))).toBe(true);
    // **消していない** — ストアにはまだ残っていて、次の起動
    // （`#restoreUnread` の配り直し、issue #217）に委ねられる。issue #256 が
    // 壊さないよう指示している「消せなかったものは次の起動で配り直される」
    // 設計そのものである。
    const pending = await stores.inbox.claimPending();
    expect(pending.some((p) => p.event.id === event.id)).toBe(true);
    expect(calls.length).toBe(3);

    await s.clone.stop();
  }, 10_000);
});

/**
 * 記憶が**二重に文脈へ載らない**こと。
 *
 * 記憶はセッションを組み立てた時点でシステムプロンプトへ焼き込まれる。走行中の
 * 手編集を届けるための載せ直し（`#withFreshMemory`）は、かつて**記憶の全文**を
 * 本文の前に置いていた。つまり1つの文書の1行を直すだけで、変わっていない文書まで
 * 含めた全文が2つ目の写しとして文脈に入り、しかもそれは会話の履歴に残るので
 * 直すたびに増え、resume でも運ばれていた。
 *
 * ここで固定するのは3つである。
 *
 * 1. 変わった文書だけが載る（＝変わっていない文書は二重に載らない）
 * 2. 何も変わっていなければ何も足さない
 * 3. resume では全文を載せ直さず、正本がシステムプロンプト側だと断るだけにする
 *
 * **受け入れ基準3（人間の手編集が次の会話に反映される）を弱めていないこと**は、
 * 上の「走行中に人間が記憶を書き換えたら、次のターンで載せ直す」がそのまま
 * 見ている（あちらは触っていない）。
 */
describe('クローン — 記憶を二重に載せない', () => {
  /** その名のとおり、載せ直しの中に本文が出てきてはいけない文書。 */
  const UNCHANGED_BODY = 'HABIT-BODY-MUST-NOT-BE-RESENT';

  async function twoDocumentStores(): Promise<Stores> {
    const stores = createMemoryStores();
    await stores.persona.write('values', '# 価値観\n\nOLD-VALUE\n');
    await stores.persona.write('habits', `# 習慣\n\n${UNCHANGED_BODY}\n`);
    return stores;
  }

  /** 2ターン目を同じセッションへ流し、その入力を返す。 */
  async function secondTurn(s: Setup): Promise<string> {
    const events: ChatStreamEvent[] = [];
    s.clone.subscribe('conv-2', (event) => events.push(event));
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);
    return (s.calls[0] as FakeCall).inputs[1] ?? '';
  }

  it('1つの文書を直しても、変わっていない文書の本文は載せ直さない', async () => {
    const stores = await twoDocumentStores();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.write('values', '# 価値観\n\nNEW-VALUE\n');
    const second = await secondTurn(s);

    // 直した文書は、どの文書かを指せる見出しつきで載る
    expect(second).toContain('<!-- memory: values.md -->');
    expect(second).toContain('NEW-VALUE');
    // **これが本題。** 触っていない文書の本文は2つ目の写しにならない
    expect(second).not.toContain(UNCHANGED_BODY);
    expect(second).not.toContain('<!-- memory: habits.md -->');
    // 絞ったのは載せ直しの側だけである。システムプロンプトには両方載ったまま
    const systemPrompt = String((s.calls[0] as FakeCall).options.systemPrompt);
    expect(systemPrompt).toContain(UNCHANGED_BODY);
    expect(systemPrompt).toContain('<!-- memory: habits.md -->');

    await s.clone.stop();
  });

  it('記憶が何も変わっていなければ、ターンの本文に何も足さない', async () => {
    const stores = await twoDocumentStores();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    const second = await secondTurn(s);

    expect(second).not.toContain('記憶が更新された');
    expect(second).not.toContain('<!-- memory:');
    expect(second).not.toContain('OLD-VALUE');
    // 本文そのものは削られていない（断り書きが前に付く経路があるので末尾で見る）
    expect(second.endsWith('2回目')).toBe(true);

    await s.clone.stop();
  });

  it('セッションを組み立てた最初のターンでは、焼き込んだ記憶を載せ直さない', async () => {
    const stores = await twoDocumentStores();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    const first = (s.calls[0] as FakeCall).inputs[0] ?? '';
    expect(first).not.toContain('記憶が更新された');
    expect(first).not.toContain('OLD-VALUE');
    expect(first).not.toContain(UNCHANGED_BODY);
    // 焼き込み自体は起きている（載せ直しが要らないのは、そちらに載っているから）
    expect(String((s.calls[0] as FakeCall).options.systemPrompt)).toContain('OLD-VALUE');

    await s.clone.stop();
  });

  it('記憶を消したら、消えたことを名前で伝える（本文を載せ直さない）', async () => {
    const stores = await twoDocumentStores();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.remove('habits');
    const second = await secondTurn(s);

    expect(second).toContain('削除された記憶: habits.md');
    // 消した文書の本文を載せるのは「消したのに文脈には居る」という一番まぎらわしい状態
    expect(second).not.toContain(UNCHANGED_BODY);
    // 残っている文書は変わっていないので、こちらも載せ直さない
    expect(second).not.toContain('OLD-VALUE');

    await s.clone.stop();
  });

  it('記憶が全部消えたら、空になったと伝える', async () => {
    const stores = await twoDocumentStores();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.remove('values');
    await stores.persona.remove('habits');
    const second = await secondTurn(s);

    expect(second).toContain('（記憶は空になった）');
    expect(second).toContain('削除された記憶:');
    expect(second).toContain('values.md');
    expect(second).toContain('habits.md');

    await s.clone.stop();
  });

  /**
   * **削除された記憶の列挙にも上限が要る（#409）。** `removed` は一度に消えた
   * 文書の件数ぶん伸びる列挙で、`.map().join()` に上限も合図も無かった。
   * 60件をまとめて消すと、切っていない実装ではこの1行だけで数百文字になる
   * ——ここでは抜粋の合図（`excerptLine` の「省略」）が出て、伸び続けないことを
   * 見る。
   */
  it('大量の記憶を一度に消しても、削除された記憶の列挙は抜粋の合図で締まる', async () => {
    const stores = createMemoryStores();
    const slugs = Array.from({ length: 60 }, (_, index) => `doc-${index}`);
    for (const slug of slugs) {
      await stores.persona.write(slug, `# ${slug}\n\nbody\n`);
    }
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    for (const slug of slugs) {
      await stores.persona.remove(slug);
    }
    const second = await secondTurn(s);

    const line = second.split('\n').find((entry) => entry.startsWith('削除された記憶:'));
    expect(line).toBeDefined();
    // 60件の生の列挙をそのまま出せば数百文字になる。ここでは合図が出て、
    // 際限なく伸びていないことを見る。
    expect(line!.length).toBeLessThan(600);
    expect(line).toMatch(/省略/);

    await s.clone.stop();
  });

  /**
   * **ここが resume の側の穴だった。**
   *
   * 前のセッションが載せ直した塊は、履歴として残る。それは
   * 「以降はこちらが現在の記憶である」と名乗る形で、しかもシステムプロンプトより
   * **後ろ**に並ぶ。デーモンが落ちている間に人間が記憶を直していた場合、正本
   * （新しいシステムプロンプト）のほうが新しいのに、古い写しが最後の言葉になる。
   */
  it('resume した最初のターンでは、正本がシステムプロンプト側だと断る（全文を載せ直さない）', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('values', '# 価値観\n\nV1-OLD\n');

    const first = setup(undefined, stores);
    first.clone.post(humanMessage('1回目'));
    await waitForDone(first.events);
    // 前のセッションで載せ直しが起きた状態を、実際に人間の手編集で作る
    await stores.persona.write('values', '# 価値観\n\nV2-MID\n');
    const events: ChatStreamEvent[] = [];
    first.clone.subscribe('conv-2', (event) => events.push(event));
    first.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);
    expect((first.calls[0] as FakeCall).inputs[1] ?? '').toContain('V2-MID');
    await first.clone.stop();

    // デーモンが落ちている間に、人間がもう一度直す
    await stores.persona.write('values', '# 価値観\n\nV3-NEWEST\n');

    const second = setup(undefined, stores);
    second.clone.post(humanMessage('また来た'));
    await waitForDone(second.events);

    const call = second.calls[0] as FakeCall;
    expect(call.options.resume).toBe('sess-fake');
    const input = call.inputs[0] ?? '';
    expect(input).toContain('現在の記憶');
    expect(input).toContain('システムプロンプト');
    // **全文を載せ直して上書きしない。** それはいま塞いでいる二重載せそのものである
    expect(input).not.toContain('V3-NEWEST');
    expect(input).not.toContain('<!-- memory: values.md -->');
    // 正本の側には最新が載っている
    expect(String(call.options.systemPrompt)).toContain('V3-NEWEST');
    expect(String(call.options.systemPrompt)).not.toContain('V2-MID');

    await second.clone.stop();
  });

  it('resume の断りは最初のターンだけで、以降のターンには付かない', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('values', '# 価値観\n\nV1\n');

    const first = setup(undefined, stores);
    first.clone.post(humanMessage('1回目'));
    await waitForDone(first.events);
    await first.clone.stop();

    const second = setup(undefined, stores);
    second.clone.post(humanMessage('また来た'));
    await waitForDone(second.events);
    expect((second.calls[0] as FakeCall).inputs[0] ?? '').toContain('resume');

    const third = await secondTurn(second);
    expect(third).not.toContain('resume');

    await second.clone.stop();
  });

  it('新規に開いたセッションでは resume の断りを出さない（起きていないことを言わない）', async () => {
    const stores = await twoDocumentStores();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    expect((s.calls[0] as FakeCall).options.resume).toBeUndefined();
    expect((s.calls[0] as FakeCall).inputs[0] ?? '').not.toContain('resume');

    await s.clone.stop();
  });

  it('内部ターン（蒸留）にも同じ絞り込みが効く（起点ごとに違う載せ方をしない）', async () => {
    const stores = await twoDocumentStores();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    await stores.persona.write('values', '# 価値観\n\nNEW-VALUE\n');
    await s.clone.endConversation('conv-1');

    // 蒸留の内部ターンが同じセッションへ流れる（`#runInternal`）
    const distill = (s.calls[0] as FakeCall).inputs[1] ?? '';
    expect(distill).toContain('記憶へ移すべきものがあるか確認せよ');
    expect(distill).toContain('NEW-VALUE');
    expect(distill).not.toContain(UNCHANGED_BODY);

    await s.clone.stop();
  });
});

/**
 * ターンの失敗が、聞き手の有無に関わらず観測できるか。
 *
 * **ここが成り立っていることが、受信箱の消し込みの前提である**（#58）。例外で
 * 終わった合図も `#forget` してよいとしたのは「失敗が記録されているから」で、
 * `#emit` は購読者が居なければ何もしない以上、chat へ流すだけでは記録に
 * ならない。7 つある入力経路のうち `human_message` だけがそれで済ませていた。
 */
describe('クローン — ターンの失敗の跡', () => {
  /** 日誌の `exchange` を、判定に使う形だけ取り出す。 */
  async function exchanges(stores: Stores) {
    return (await stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      role: string;
      text: string;
      conversationId?: string;
    }[];
  }

  it('人間が chat を閉じた後にターンが失敗しても、日誌に残る（購読者は居ない）', async () => {
    const stores = createMemoryStores();
    // `setup` が購読するのは conv-1 だけ。conv-9 には聞き手が一人も居ない
    // ＝「発言 → chat を閉じる／切断 → そのターンが失敗」と同じ形。
    const s = setup(undefined, stores, { failWith: 'セッションを起こせない' });

    s.clone.post(humanMessage('やあ', 'conv-9'));

    await expect
      .poll(
        async () =>
          (await exchanges(stores)).some(
            (entry) => entry.role === 'outbound' && entry.text.includes('失敗した'),
          ),
        { timeout: 3000 },
      )
      .toBe(true);

    /*
     * **`with` の期待値を `human` から `self` へ反転させた（#92）。**
     *
     * 元の期待値は現行の欠陥を仕様として固定していた — `with: 'human'` /
     * `role: 'outbound'` で書くと `GET /conversations/:id`（`with === 'human'`
     * だけで絞る）をそのまま通り、**SDK の生の文言が「クローンの返信」として
     * 会話に並ぶ**。人間が「英語の文言だけが返信される」と訴えたのがこれである。
     *
     * **保証は弱くなっていない。** このテストが守っているのは「購読者が居なくても
     * 失敗が日誌に残る」ことと「`conversationId` が載る」ことで、どちらも下で
     * そのまま見ている。加えて `with` を絞って**特定の1件**を掴むようにしたので
     * （元は `text.includes('失敗した')` の最初の1件で、人間へ返す1行と
     * 区別できていなかった）、生の理由がどちらに載るかまで固定できている。
     */
    const all = await exchanges(stores);
    const failure = all.find(
      (entry) => entry.with === 'self' && entry.text.startsWith('人間との対話ターンが失敗した'),
    );
    expect(failure).toBeDefined();
    // 呼び出し側が構造化フィールドとして持っている値は載せる（#56 の線）。
    // 落とすと、どの会話の失敗だったかを時刻でしか突き合わせられなくなる。
    expect(failure?.conversationId).toBe('conv-9');
    expect(failure?.text).toContain('セッションを起こせない');

    // 人間の側には、生の文言を含まない1行が返っている（沈黙にしない）。
    const toHuman = all.filter(
      (entry) => entry.with === 'human' && entry.role === 'outbound' && entry.text !== 'やあ',
    );
    expect(toHuman).toHaveLength(1);
    expect(toHuman[0]?.conversationId).toBe('conv-9');
    expect(toHuman[0]?.text).not.toContain('セッションを起こせない');

    await s.clone.stop();
  });

  it('購読者が例外を投げても、跡は残る（`#emit` は購読側の失敗を握り潰す）', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, { failWith: '読み取りが即死した' });
    // 聞き手は「居る」が、受け取れない。`#emit` が握り潰すので、chat へ流した
    // ことを記録の代わりにしていると、購読者が居ないときと同じ形で消える。
    s.clone.subscribe('conv-9', () => {
      throw new Error('購読側が壊れている');
    });

    s.clone.post(humanMessage('やあ', 'conv-9'));

    await expect
      .poll(
        async () =>
          (await exchanges(stores)).some(
            (entry) => entry.role === 'outbound' && entry.text.includes('失敗した'),
          ),
        { timeout: 3000 },
      )
      .toBe(true);

    await s.clone.stop();
  });

  /**
   * 文脈窓（コンテキストウィンドウ）超過の失敗だけ、日誌に目印が入るか（Issue
   * #318 P4）。**対照（当たらない失敗には入らない）も見る** — 無いと、全部の
   * 失敗に目印を付ける実装が生存する。
   */
  describe('文脈窓超過の失敗には目印が入る', () => {
    it('該当する失敗: 目印（ASCII の検索語）と生の文言の両方が `with: self` に残る', async () => {
      const stores = createMemoryStores();
      const real = 'prompt is too long: 220000 tokens > 200000 maximum';
      const s = setup(undefined, stores, { failWith: real });

      s.clone.post(humanMessage('やあ', 'conv-9'));

      await expect
        .poll(
          async () =>
            (await exchanges(stores)).some(
              (entry) =>
                entry.with === 'self' && entry.text.startsWith('人間との対話ターンが失敗した'),
            ),
          { timeout: 3000 },
        )
        .toBe(true);

      const failure = (await exchanges(stores)).find(
        (entry) => entry.with === 'self' && entry.text.startsWith('人間との対話ターンが失敗した'),
      );
      // ASCII の検索語（`journal_read q=` で引ける形。条件1）。
      expect(failure?.text).toContain('context_window_failure');
      expect(failure?.text).toContain('prompt_too_long');
      // 生の文言は逐語のまま（言い換えない）。
      expect(failure?.text).toContain(real);
      // 弱さ（条件2）: 「該当した」だけでなく型合わせであることを書く。
      expect(failure?.text).toContain('契約ではない');

      // 人間へ返す1行（`with: human`）に、目印と生の文言を持ち込まない線。
      //
      // **⚠️ この歯は「人間へ返す1行は一切変わらない」を測るものではない。**
      // 測っているのは「ASCII の目印（`context_window_failure`）と生の文言が
      // 混ざらない」ことだけである。**枠で保持している回には日本語の断り1文が
      // 足される**（`CONTEXT_WINDOW_ALSO_NOTICE`。下の describe が測る）。
      //
      // **そしてこの本は `failWith` で落としているので `#usageBlocked` は立って
      // いない ＝ 2×2 の左下（枠の保持なし × 長さに当たった）である。⟹ ここは
      // 意図して変えていない側であり、この歯はその不変の対照でもある。**
      const toHuman = (await exchanges(stores)).find(
        (entry) => entry.with === 'human' && entry.role === 'outbound' && entry.text !== 'やあ',
      );
      expect(toHuman?.text).not.toContain('context_window_failure');
      expect(toHuman?.text).not.toContain(real);

      await s.clone.stop();
    });

    it('対照: 文脈窓と無関係な失敗には目印が入らない', async () => {
      const stores = createMemoryStores();
      // 枠（利用上限）の失敗——紛らわしいが別の種別（`usage-limits.ts` の対象）。
      const real = "You've hit your individual spend limit";
      const s = setup(undefined, stores, { failWith: real });

      s.clone.post(humanMessage('やあ', 'conv-9'));

      await expect
        .poll(
          async () =>
            (await exchanges(stores)).some(
              (entry) =>
                entry.with === 'self' && entry.text.startsWith('人間との対話ターンが失敗した'),
            ),
          { timeout: 3000 },
        )
        .toBe(true);

      const failure = (await exchanges(stores)).find(
        (entry) => entry.with === 'self' && entry.text.startsWith('人間との対話ターンが失敗した'),
      );
      expect(failure?.text).toContain(real);
      expect(failure?.text).not.toContain('context_window_failure');

      await s.clone.stop();
    });
  });

  /**
   * **文脈窓（プロンプトの長さ）で落ちたら、セッションを畳んで作り直す**
   * （#553。人間の依頼「今後発生した際に落ちないように対策」）。
   *
   * ## 何が壊れていたか
   *
   * 失敗した `result` は例外ではないので `#read` の `for await` は回り続け、
   * `#query` は非 null のまま残る。⟹ 次のターンは `#ensureQuery` の早期 return で
   * **同じセッション**へ入り、同じ長すぎる会話を持ったまま同じところで落ちる。
   * 実測（#553）: 2026-08-29〜31 に 24 件。
   *
   * ## 対照を3本置く（無いと「何でも畳む」実装が生き残る）
   *
   * 1. **長さではない失敗** —— 畳まない
   * 2. **引き継がずに開いて1度も答えていないセッション** —— 畳んでも直らないので
   *    畳まず、そう名乗る（暴走の止め）
   * 3. **`#recycleForToken` と混ざっていない** —— トークンを回すだけでは
   *    `setCloneSessionId(null)` が打たれない（＝会話が切れない）
   */
  describe('文脈窓で落ちたら、セッションを畳んで作り直す', () => {
    /** 長さで落ちる `result`（実測の (B) 群の形）。 */
    const tooLong = 'Prompt is too long';

    /**
     * 1本目を成功させ、2本目を長さで落とす。
     *
     * **1本目を成功させるのが要点である** —— `#sessionAnswered` が立たないと
     * 暴走の止めに掛かって畳まれない（対照2 がそこを押す）。**固定値のスタブに
     * しない**（`resultFor` の doc と同じ理由）。
     */
    /**
     * @param failDistill 蒸留のサイドセッションを**起こせない**形にする。
     *   **枠が閉じている回の代役である** —— 実測では長さで落ちた24件のうち9件が
     *   「長さと枠が同時」だった（`#salvageTranscript` の doc）。
     */
    function setupFold(failText: string, failDistill = false) {
      const stores = createMemoryStores();
      let failNext = false;
      const { fn, calls } = fakeSdk(undefined, {
        resultFor: () =>
          failNext ? { subtype: 'success', isError: true, text: failText } : undefined,
      });
      // **サイドセッションだけを落とす。** 本セッションの `prompt` は非同期の
      // イテレータで来るので、**文字列で来る側が蒸留である。**
      const queryFn: typeof fn = (args) => {
        if (failDistill && typeof args.prompt === 'string') throw new Error('枠が閉じている');
        return fn(args);
      };
      const clone = createClone({
        stores,
        queryFn,
        env: {},
        runners: createRunnerRegistry([
          createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
        ]),
      });
      const events: ChatStreamEvent[] = [];
      clone.subscribe('conv-1', (event) => events.push(event));
      return { clone, stores, calls, events, failFrom: () => (failNext = true) };
    }

    /**
     * 人間へ返った最後の1行（`with: 'human'` / `outbound`）。
     *
     * **`exchanges`（この describe の親が持つ）を通す。** 日誌の読み口を自前に
     * 書き分けると、親の歯と別の並び順・別の絞り方になりうる。
     */
    async function lastToHuman(stores: Stores): Promise<string | undefined> {
      // **`#reportFailure` が書く1行だけを採る。**`with: 'human'` の outbound には
      // **クローンの発言そのもの**も載る（失敗したターンでも、出ていた本文は
      // 印を付けて残される）。⟹ 単に最後の1件を採ると、そちらを拾う。
      const rows = (await exchanges(stores)).filter(
        (entry) =>
          entry.with === 'human' &&
          entry.role === 'outbound' &&
          (entry.text.startsWith('この発言には返せなかった') ||
            entry.text.startsWith('いま利用上限に当たっているので')),
      );
      return rows[rows.length - 1]?.text;
    }

    it('畳んで、次のターンは新しいセッションで走る。resume 素材は捨てられている', async () => {
      const s = setupFold(tooLong);

      // 1本目は成功させる（`#sessionAnswered` を立てる）。
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');
      // 成功した時点で session id が控えられている。
      expect(await s.stores.sessions.getCloneSessionId()).not.toBeNull();

      // 2本目を長さで落とす。
      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), '2本目が落ちること');

      // **印と同時に resume 素材が捨てられている**（畳んだ後ではない）。
      await waitFor(
        async () => (await s.stores.sessions.getCloneSessionId()) === null,
        'resume 素材が捨てられること',
      );

      // 3本目は**新しいセッション**で走る。
      await new Promise((resolve) => setTimeout(resolve, 80));
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.calls.length > 1, '2本目のセッションが開くこと');
      await s.clone.stop();

      expect(s.calls.length).toBeGreaterThan(1);
    });

    it('人間へ返す1行で「記録は消えていない」と言う（会話が失われたとは言わない）', async () => {
      const s = setupFold(tooLong);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');
      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), '2本目が落ちること');

      const text = await lastToHuman(s.stores);
      await s.clone.stop();

      expect(text).toContain('次の発言から新しく開き直す');
      // **⛔ 消えていないものを消えたことにしない。**
      expect(text).toContain('消えていない');
      expect(text).not.toContain('失われ');
      // 読み直す口の名前は、クローン側の断りが持つ（ここには出さない）。
      expect(text).not.toContain('context_window_failure');
    });

    it('対照1（長さではない失敗）: 畳まない。resume 素材も残る', async () => {
      const s = setupFold('何か別の理由で落ちた');
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');
      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), '2本目が落ちること');

      const text = await lastToHuman(s.stores);
      await new Promise((resolve) => setTimeout(resolve, 80));
      // **⭐ ここが「何でも畳む」実装を殺す。**
      expect(await s.stores.sessions.getCloneSessionId()).not.toBeNull();
      await s.clone.stop();
      expect(text).not.toContain('次の発言から新しく開き直す');
    });

    it('対照2（暴走の止め）: 引き継がずに開いて1度も答えていないなら、畳まずにそう言う', async () => {
      const s = setupFold(tooLong);
      // **最初のターンから落とす** ⟹ `#resumedFrom === null` かつ
      // `#sessionAnswered === false` ＝ 開き直しても材料が同じ状態。
      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');

      const text = await lastToHuman(s.stores);
      await new Promise((resolve) => setTimeout(resolve, 80));
      await s.clone.stop();

      // 畳んでいない（＝抑止が効いている）。
      expect(text).not.toContain('次の発言から新しく開き直す');
      // **抑止したことを名乗る。** 名乗らないと外から「なぜか動かない」に見える。
      expect(text).toContain('開き直していない');
      expect(text).toContain('プロンプトそのものが収まっていない可能性');
    });

    /**
     * **⭐ 畳む直前に、生ログが器の外へ出る**（#553 / #564）。
     *
     * ## なぜ在り処を `PostToolUse` から控えるのか
     *
     * 既存の退避（`#onPreCompact`）は在り処を `PreCompact` フックの入力から
     * 受け取っている。**⟹ compaction 自体が失敗した回（＝ここで扱う回）は
     * そのフックが走らないので、在り処が誰にも分からない。**
     * `transcript_path` は `BaseHookInput` の必須フィールドなので、**既に張って
     * ある `PostToolUse` から控えられる**（フックを増やさない）。
     *
     * ## ⚠️ この歯が測っていないこと
     *
     * **蒸留（2段目）が走ったかは測っていない。** あちらはモデルを呼ぶので、
     * 枠が閉じている回では原理的に落ちる（実測で24件中9件がその形）。**この歯が
     * 固定しているのは「退避（1段目）はモデルを呼ばないので、そちらだけは通る」
     * ことである。**
     */
    it('畳む直前に生ログを退避する（在り処は PostToolUse から控えたもの）', async () => {
      const s = setupFold(tooLong);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');

      // 道具を1つ使った跡を作る ＝ 在り処が控えられる。**本物と同じ経路で叩く**
      // （既存の PreCompact / PostToolUse の歯と同じ形）。
      const dir = await mkdtemp(join(tmpdir(), 'alteroid-ctxwin-'));
      try {
        const transcriptPath = join(dir, 'transcript.jsonl');
        await writeFile(transcriptPath, '畳む直前の生ログ', 'utf8');
        const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
        if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
        await hook({ tool_name: 'Read', transcript_path: transcriptPath } as never, undefined, {
          signal: new AbortController().signal,
        } as never);

        s.failFrom();
        s.clone.post(humanMessage('やあ'));
        await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');

        // **退避されている。**
        await waitFor(async () => (await s.stores.archive.list()).length > 0, '退避されること');
        const ids = await s.stores.archive.list();
        expect(await s.stores.archive.read(ids[0] as string)).toBe('畳む直前の生ログ');
      } finally {
        await s.clone.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('対照（在り処を控えていない）: 退避を試みず、日誌にノイズも増やさない', async () => {
      const s = setupFold(tooLong);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');
      // 道具を1つも使っていない ＝ 控えは空である（`#transcriptPath` の弱さ）。
      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');
      await new Promise((resolve) => setTimeout(resolve, 80));
      await s.clone.stop();

      expect(await s.stores.archive.list()).toHaveLength(0);
      // **黙って通す側へ倒してある。**「退避に失敗した」を毎回書くとノイズになる。
      const selfRows = (await exchanges(s.stores)).filter((entry) => entry.with === 'self');
      expect(selfRows.some((entry) => entry.text.includes('生ログの退避に失敗した'))).toBe(false);
    });

    /**
     * **⭐ (i) 退避が落ちても (ii) 蒸留へ進む。**
     *
     * 直す前は (i) の `catch` で `return` していた。⟹ (i) は全文を 1 本の文字列に
     * するので、生ログが伸びて `ERR_STRING_TOO_LONG` になると**蒸留も道連れで
     * 止まる**（`readTranscriptTail` の doc）。ここはその制御の流れを固定する。
     *
     * ## 測り方
     *
     * 在り処の控えは残したまま**ファイルを消す**。⟹ (i) も (ii) も読めないので、
     * **(ii) の行が日誌に在ること自体が「(i) の後に進んだ」証拠になる。**
     *
     * ## 併せて、文言が嘘にならないことも測る
     *
     * 直す前の (ii) の文言は「生ログの退避は済んでいる」と固定だった。**(i) が
     * 落ちた回にそう書くと守れない約束になる**（AGENTS.md「静かに失敗する道具」と
     * 同じ形で、読む側は残っていると信じる）。
     */
    it('退避が落ちても蒸留へ進み、日誌は「どこにも残っていない」と言う', async () => {
      const s = setupFold(tooLong);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');

      const dir = await mkdtemp(join(tmpdir(), 'alteroid-ctxwin-gone-'));
      const transcriptPath = join(dir, 'transcript.jsonl');
      await writeFile(transcriptPath, '畳む直前の生ログ', 'utf8');
      const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
      if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
      await hook({ tool_name: 'Read', transcript_path: transcriptPath } as never, undefined, {
        signal: new AbortController().signal,
      } as never);
      // **控えは残したまま、ファイルだけを消す。** ⟹ (i) と (ii) の両方が読めない。
      await rm(dir, { recursive: true, force: true });

      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');

      await waitFor(
        async () =>
          (await exchanges(s.stores)).some((entry) =>
            entry.text.includes('文脈窓で畳む前の蒸留に失敗した'),
          ),
        '蒸留まで進んで、その失敗が日誌に残ること',
      );
      const rows = await exchanges(s.stores);
      expect(
        rows.some((entry) => entry.text.includes('文脈窓で畳む前の生ログの退避に失敗した')),
      ).toBe(true);
      const distillRow = rows.find((entry) =>
        entry.text.includes('文脈窓で畳む前の蒸留に失敗した'),
      );
      expect(distillRow?.text).toContain('この区間はどこにも残っていない');
      expect(distillRow?.text).not.toContain('生ログの退避は済んでいる');
      // **⭐ 墓標も立たない**（#564 E1b の限界）。退避が落ちた回は拾う材料が
      // 器の外に無いので、指す先が無い。
      expect(await s.stores.sessions.getTranscriptGrave()).toBeNull();

      await s.clone.stop();
    });

    /**
     * **⭐ 蒸留が落ちたら、退避の id を墓標として残す**（#564 E1b）。
     *
     * ここで蒸留が落ちる主な理由は**枠が閉じていること**で、枠は待てば開く。
     * ⟹ **印が無ければ、開いた後に拾う手がかりが1つも残らない。**
     *
     * 指すのは `archive` の id であってセッション id ではない —— この時点で
     * セッション id は既に捨ててある（`TranscriptGrave` の doc）。
     */
    it('蒸留が落ちたら、退避の id を墓標として残す', async () => {
      const s = setupFold(tooLong, true);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');

      const dir = await mkdtemp(join(tmpdir(), 'alteroid-ctxwin-grave-'));
      try {
        const transcriptPath = join(dir, 'transcript.jsonl');
        await writeFile(transcriptPath, '畳む直前の生ログ', 'utf8');
        const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
        if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
        await hook({ tool_name: 'Read', transcript_path: transcriptPath } as never, undefined, {
          signal: new AbortController().signal,
        } as never);

        s.failFrom();
        s.clone.post(humanMessage('やあ'));
        await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');

        await waitFor(
          async () => (await s.stores.sessions.getTranscriptGrave()) !== null,
          '墓標が立つこと',
        );
        const ids = await s.stores.archive.list();
        expect((await s.stores.sessions.getTranscriptGrave())?.archiveId).toBe(ids[0]);
      } finally {
        await s.clone.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('対照: 蒸留が通った回は墓標を残さない', async () => {
      const s = setupFold(tooLong);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');

      const dir = await mkdtemp(join(tmpdir(), 'alteroid-ctxwin-grave-none-'));
      try {
        const transcriptPath = join(dir, 'transcript.jsonl');
        await writeFile(transcriptPath, '畳む直前の生ログ', 'utf8');
        const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
        if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
        await hook({ tool_name: 'Read', transcript_path: transcriptPath } as never, undefined, {
          signal: new AbortController().signal,
        } as never);

        s.failFrom();
        s.clone.post(humanMessage('やあ'));
        await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');
        await waitFor(async () => (await s.stores.archive.list()).length > 0, '退避されること');

        expect(await s.stores.sessions.getTranscriptGrave()).toBeNull();
      } finally {
        await s.clone.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    /**
     * **⭐ 畳んだ次のターンで、クローン自身にも1度だけ断る**（#553、依頼元の決裁）。
     *
     * ## なぜ人間への1行だけでは足りないのか
     *
     * 畳んだ次のターンで、クローンは**自分が文脈を失ったことを知らない。**
     * ⟹ 読み直すべきだと気づけない。⟹ 人間には「なぜか話が通じない」として出る。
     * **落ちなくなっても、人間から見た症状はそこで残る。**
     *
     * ## 対照を2本置く
     *
     * 1. **1度だけ** —— 次のターンには載らない（毎ターン載ると文脈を食う）
     * 2. **畳んでいない失敗では載らない**
     */
    it('畳んだ次のターンで、クローン自身へ1度だけ断る（読み口の名前つき）', async () => {
      const s = setupFold(tooLong);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');
      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');
      await waitFor(
        async () => (await s.stores.sessions.getCloneSessionId()) === null,
        '畳むと決まること',
      );

      // 畳んだ後の新しいセッションで1ターン回す。
      await new Promise((resolve) => setTimeout(resolve, 80));
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.calls.length > 1, '2本目のセッションが開くこと');
      const next = s.calls.at(-1) as FakeCall;
      await waitFor(() => next.inputs.length > 0, '入力が届くこと');

      const first = next.inputs[0] as string;
      expect(first).toContain('前の会話を引き継がずに開き直した');
      // **⭐ 読み直す口の名前が在る**（依頼元の条件。無いと口を探すところから始まる）。
      expect(first).toContain('conversation_read');
      // **記憶は失われていない**ことも言う（そこを混同すると同一性の話になる）。
      expect(first).toContain('記憶');

      // 対照1: **1度だけ。**次のターンには載らない。
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => next.inputs.length > 1, '2ターン目の入力が届くこと');
      await s.clone.stop();
      expect(next.inputs[1] as string).not.toContain('前の会話を引き継がずに開き直した');
    });

    it('対照（畳んでいない失敗）: クローンへの断りも載らない', async () => {
      const s = setupFold('何か別の理由で落ちた');
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');
      s.failFrom();
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'error'), 'ターンが落ちること');

      const main = s.calls[0] as FakeCall;
      const before = main.inputs.length;
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => main.inputs.length > before, '次の入力が届くこと');
      await s.clone.stop();

      expect(main.inputs.at(-1) as string).not.toContain('前の会話を引き継がずに開き直した');
    });

    it('対照3: トークンを回すだけでは resume 素材を捨てない（会話が切れない）', async () => {
      const s = setupFold(tooLong);
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.events.some((event) => event.type === 'done'), '1本目が通ること');

      s.clone.recycleSessionForToken();
      await new Promise((resolve) => setTimeout(resolve, 80));
      s.clone.post(humanMessage('やあ'));
      await waitFor(() => s.calls.length > 1, '2本目のセッションが開くこと');
      await s.clone.stop();

      // **2つの印が混ざっていない。** 混ざると、鍵を回すだけで会話が切れる。
      expect(await s.stores.sessions.getCloneSessionId()).not.toBeNull();
    });
  });

  /**
   * **枠で保持していると言うとき、そのターンが長さにも当たっていたらそう言う。**
   *
   * ## なぜこの1マスだけか
   *
   * `#reportFailure` が人間へ返す1行は、（枠で保持しているか）×（文脈窓に当たったか）
   * の 2×2 になる。**嘘になっていたのは「枠で保持 × 長さにも当たった」の1マス
   * だけである** —— そこは「枠が開いたら試し直して返信する」と言い切るが、長さが
   * 同じままなら枠が開いても同じところへ落ちる ＝ 守れない約束になる。
   *
   * ## 実機の形（依頼元の実測、2026-08-29〜31 に24件。うち9件がこの形）
   *
   * ```
   * Prompt is too long · automatic compaction failed: You've hit your or…
   * ```
   *
   * **1本の文字列に両方が入っている。** CLI が見出し（`Prompt is too long`）と
   * compaction の失敗の詳細を合成しているためで、`classifyUsageNotice` は
   * `includes` で `You've hit your` に当たり、`classifyContextWindowFailure` は
   * `prompt is too long` に当たる。**⟹ 2つとも真になる。**
   *
   * ## 対照を2本置く（無いと「常に足す」実装が生き残る）
   *
   * 1. **枠で保持 × 長さではない** —— 断りが**出ない**こと
   * 2. **枠の保持なし × 長さに当たった** —— 断りが**出ない**こと（＝上の
   *    「目印が入る」の本が測っている左下のマス。**意図して変えていない側**）
   */
  describe('枠で保持していて、長さにも当たっていたら、両方言う', () => {
    /** 実機の (A) 群の形。1本の文字列に枠と長さの両方が入っている。 */
    const bothMessage =
      "Prompt is too long · automatic compaction failed: You've hit your org's monthly spend limit";
    /** 枠だけ（長さの語を含まない）。対照1 用。 */
    const usageOnlyMessage = "You've hit your individual spend limit for this account.";

    /** 失敗した `result` で1ターン落とし、人間へ返った1行を取り出す。 */
    async function toHumanAfterFailure(resultText: string): Promise<string | undefined> {
      const stores = createMemoryStores();
      const s = setup(undefined, stores, {
        resultFor: () => ({ subtype: 'success', isError: true, text: resultText }),
      });

      // **既定の会話（`conv-1`）へ出す。**`setup` が `subscribe` を張っているのは
      // そこだけなので、別の会話へ出すと `waitForTerminal` が永久に待つ。
      s.clone.post(humanMessage('やあ'));
      await waitForTerminal(s.events);
      await waitFor(
        async () =>
          (await exchanges(stores)).some(
            (entry) => entry.with === 'human' && entry.role === 'outbound' && entry.text !== 'やあ',
          ),
        '人間への1行',
      );

      const toHuman = (await exchanges(stores)).find(
        (entry) => entry.with === 'human' && entry.role === 'outbound' && entry.text !== 'やあ',
      );
      await s.clone.stop();
      return toHuman?.text;
    }

    it('枠で保持 × 長さにも当たった: 保持の1行に「枠が開いても落ちる」が足される', async () => {
      const toHuman = await toHumanAfterFailure(bothMessage);

      // 前半（保持している事実）は否定しない。**保持は正しい** —— compaction は
      // 本物の枠に当たっており、やめれば閉じた枠を叩き続けることになる。
      expect(toHuman).toContain('いま利用上限に当たっているので');
      expect(toHuman).toContain('枠が開いたら試し直して返信する');
      // 足す側: 長さにも当たっていることと、待つだけでは足りないこと。
      expect(toHuman).toContain('文脈窓');
      expect(toHuman).toContain('枠が開いても');
      // **⛔ ASCII の目印と生の文言は人間へ返す1行に持ち込まない**（日誌側の道具）。
      expect(toHuman).not.toContain('context_window_failure');
      expect(toHuman).not.toContain(bothMessage);
    });

    it('対照1（枠だけ）: 長さの語を含まない上限では、断りが出ない', async () => {
      const toHuman = await toHumanAfterFailure(usageOnlyMessage);

      expect(toHuman).toContain('枠が開いたら試し直して返信する');
      // **ここが出たら「常に足す」実装である。**
      expect(toHuman).not.toContain('文脈窓');
    });

    it('対照2（保持なし × 長さ）: 枠に当たっていない長さの失敗では、1行は変わらない', async () => {
      // 枠の文言を1つも含まない（`classifyUsageNotice` に当たらない）長さの失敗。
      const toHuman = await toHumanAfterFailure('prompt is too long: 1206750 tokens > 1000000');

      // 既存の文言のまま。**⟹ この1マスは意図して変えていない**（依頼元の判定が
      // 「2×2 の右下1マスだけ」であり、ここは範囲の外）。
      expect(toHuman).toContain('この発言には返せなかった');
      expect(toHuman).not.toContain('文脈窓');
      expect(toHuman).not.toContain('いま利用上限に当たっているので');
    });
  });

  it('日誌にも書けなければ stderr に1行。ただし本文は出さない', async () => {
    // `#reportFailure` の `message` は `String(error)` ＝ SDK・API・ストアの
    // ドライバが決める文字列で、**こちらが値を決めていない**（ドライバは失敗した
    // クエリのパラメータを添えてくることがある）。そこを素で stderr へ出すと
    // **日誌にすら入らなかった本文がホスティング先のログには残る**（#52 の逆転）。
    // ここではその形を、秘密を含む例外で作る。
    const secret = 'GH_TOKEN=ghp_000000000000000000000000000000000000';
    const stores = failingJournalAppend(createMemoryStores(), '器が閉じている');

    const lines = await captureStderr(async () => {
      const s = setup(undefined, stores, { failWith: `クエリが失敗した params=["${secret}"]` });
      // 失敗が `#reportFailure` まで届いたことは chat 側の `error` で見る
      // （日誌は落ちるので、そちらでは待てない）。
      const seen: ChatStreamEvent[] = [];
      s.clone.subscribe('conv-9', (event) => seen.push(event));
      s.clone.post(humanMessage('やあ', 'conv-9'));
      await expect
        .poll(() => seen.some((event) => event.type === 'error'), { timeout: 3000 })
        .toBe(true);
      await s.clone.stop();
    });

    const outbound = lines.filter(
      (line) => line.includes('日誌を記録できませんでした') && line.includes('role=outbound'),
    );
    /*
     * **件数を1から2へ変えた（#92）。** 会話のある失敗は日誌へ2件書く —
     * 生の理由（`with: 'self'`）と、人間へ返す1行（`with: 'human'`）である
     * （`#reportFailure` の doc）。器が閉じていればどちらも落ちるので跡も2行出る。
     *
     * **保証は弱くなっていない。** 守っているのは「跡は出る」「本文は出さない」で、
     * 下の3つ（理由・長さの形・秘密を含まないこと）を**全行に**課している
     * （元は `outbound[0]` だけを見ていたので、2行目が本文を漏らしても通った）。
     */
    expect(outbound).toHaveLength(2);
    for (const line of outbound) {
      // 理由だけは出す（`reasonOf` を通っている）。
      expect(line).toContain('器が閉じている');
      // 本文は出さない。長さだけ出す（「空だった」と「書けなかった」が区別できる）。
      expect(line).toMatch(/role=outbound chars=[1-9]\d*/u);
    }
    expect(lines.join('')).not.toContain(secret);
    expect(lines.join('')).not.toContain('ghp_');
    expect(lines.join('')).not.toContain('params=');
  });
});

describe('クローン — 考えている合図（thinking）', () => {
  /**
   * `fakeSdk` は assistant(text) → result の1本道しか流せず、tool_use /
   * tool_result を混ぜられない。ここでは呼び出し側が渡した固定のメッセージ列を
   * そのまま流すだけの専用の偽 SDK をローカルに用意する
   * （既存の `fakeSdk` の振る舞いは変えない）。
   *
   * **1本目の入力にだけ台本を使い、以降は汎用の応答に落ちる。** `clone.stop()` は
   * 終了前に必ず蒸留の内部ターンをもう1本流す（生存条件）。台本を1本しか
   * 用意しないテストでその2本目が無応答のままだと `result` が来ず、
   * `stop()` が永遠に返らなくなる。
   */
  function fakeScriptedSdk(turns: SDKMessage[][]) {
    const calls: FakeCall[] = [];
    let turnIndex = 0;

    const fn = ((params: { prompt: unknown; options?: Options }) => {
      const call: FakeCall = { options: params.options ?? {}, inputs: [] };
      calls.push(call);

      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-fake',
          uuid: 'uuid-init',
        } as unknown as SDKMessage;

        for await (const message of params.prompt as AsyncIterable<{
          message: { content: unknown };
        }>) {
          call.inputs.push(String(message.message.content));
          const script = turns[turnIndex] ?? [assistantText('わかった'), resultMessage('わかった')];
          turnIndex += 1;
          yield* script;
        }
      }

      const generator = generate();
      return Object.assign(generator, {
        close: () => undefined,
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;

    return { fn, calls };
  }

  /** `setup` と同じ配線（本物の SDK やマネージャーを誤って起こさない）だが、queryFn だけ差し替える。 */
  function setupScripted(turns: SDKMessage[][]): Setup {
    const { fn, calls } = fakeScriptedSdk(turns);
    const stores = createMemoryStores();
    const clone = createClone({
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events, waitForEvents } = wireEvents(clone, 'conv-1');
    return { clone, stores, calls, events, waitForEvents };
  }

  function assistantText(text: string): SDKMessage {
    return {
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: 'sess-fake',
      uuid: 'uuid-assistant-text',
    } as unknown as SDKMessage;
  }

  function assistantToolUse(name: string): SDKMessage {
    return {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu-1', name, input: {} }] },
      parent_tool_use_id: null,
      session_id: 'sess-fake',
      uuid: 'uuid-assistant-tool',
    } as unknown as SDKMessage;
  }

  function userToolResult(): SDKMessage {
    return {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }],
      },
      parent_tool_use_id: 'tu-1',
      session_id: 'sess-fake',
      uuid: 'uuid-user-tool-result',
    } as unknown as SDKMessage;
  }

  /** 人間の発言のエコーや replay を模する（`tool_result` を含まない `user` メッセージ）。 */
  function userEcho(text: string): SDKMessage {
    return {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: 'sess-fake',
      uuid: 'uuid-user-echo',
    } as unknown as SDKMessage;
  }

  function resultMessage(text: string): SDKMessage {
    return {
      type: 'result',
      subtype: 'success',
      result: text,
      session_id: 'sess-fake',
      uuid: 'uuid-result',
    } as unknown as SDKMessage;
  }

  it('人間の発言に thinking が付き、text より先に届く', async () => {
    const s = setupScripted([[assistantText('こんにちは'), resultMessage('こんにちは')]]);

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const thinkingIndex = s.events.findIndex((event) => event.type === 'thinking');
    const textIndex = s.events.findIndex((event) => event.type === 'text');
    expect(thinkingIndex).toBeGreaterThanOrEqual(0);
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(thinkingIndex).toBeLessThan(textIndex);

    await s.clone.stop();
  });

  it('道具の結果が返ったら thinking を送り直す（tool の合図で止まらない）', async () => {
    const s = setupScripted([
      [
        assistantToolUse('shell'),
        userToolResult(),
        assistantText('できた'),
        resultMessage('できた'),
      ],
    ]);

    s.clone.post(humanMessage('やって'));
    await waitForDone(s.events);

    const toolIndex = s.events.findIndex((event) => event.type === 'tool');
    expect(toolIndex).toBeGreaterThanOrEqual(0);

    const after = s.events.slice(toolIndex + 1);
    const thinkingAfterToolIndex = after.findIndex((event) => event.type === 'thinking');
    const textAfterToolIndex = after.findIndex((event) => event.type === 'text');
    expect(thinkingAfterToolIndex).toBeGreaterThanOrEqual(0);
    expect(thinkingAfterToolIndex).toBeLessThan(textAfterToolIndex);

    await s.clone.stop();
  });

  it('tool_result を含まない user メッセージでは thinking を送らない', async () => {
    const s = setupScripted([
      [userEcho('やあ'), assistantText('こんにちは'), resultMessage('こんにちは')],
    ]);

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    // #runTurn が入力を渡した時点の1回だけで、tool_result を含まない
    // user メッセージ（エコー）からは増えない。
    const thinkingCount = s.events.filter((event) => event.type === 'thinking').length;
    expect(thinkingCount).toBe(1);

    await s.clone.stop();
  });

  /**
   * **日誌が書けなくても会話は続く。だが跡は残る。**
   *
   * 跡が無いと、日誌は判別器として静かに嘘をつく — 「日誌に無い」が
   * 「起きなかった」と読めてしまう。しかも一番書けなくなりやすいのは
   * 片付けの途中（ストアを閉じた後）＝一番調べたい時間帯である。
   *
   * 同時に、**跡に本文が乗らないこと**も固定する。ここを緩めると、日誌にすら
   * 入らなかった秘密がホスティング先のログに出る（#52 と同じ形）。
   */
  it('日誌が書けなくても会話は続き、落としたことが stderr に残る（本文は出さない）', async () => {
    const stores = failingJournalAppend(createMemoryStores(), 'storage is closed');
    const s = setup(() => 'こんにちは', stores);

    const lines = await captureStderr(async () => {
      s.clone.post(humanMessage('鍵は ghp_000000000000000000000000000000000000 だ'));
      await waitForDone(s.events);
      await s.clone.stop();
    });

    // 記録できないことでセッションを殺さない（この判断は変えていない）
    const shown = s.events
      .filter((event) => event.type === 'text')
      .map((event) => event.text)
      .join('');
    expect(shown).toBe('こんにちは');

    const dropped = lines.filter((line) => line.includes('日誌を記録できませんでした')).join('');
    expect(dropped).not.toBe('');
    expect(dropped).toContain('storage is closed');
    expect(dropped).toContain('exchange');
    expect(dropped).not.toContain('ghp_');
  });

  /**
   * **止まった後に届いたものは処理できない。だが跡は残る。**
   *
   * `post` は7種類の起点（人間の発言・外部イベント・timer・発意・runner の
   * 通知・マネージャーの報告/質問/許可確認・人間の承認回答）が通る1本道である。
   * ここで黙って消えると、「受信箱に積まれたまま死んだ」「閉じた後に届いた」
   * 「ターンが間に合わなかった」が日誌の上で同じ形になり、切り分けられない。
   *
   * 跡が stderr なのは、この窓が `storage.close()` → `process.exit(0)` の窓
   * そのものだからである（非同期の日誌書き込みは間に合う保証が無い）。
   * 同時に**跡に本文が乗らないこと**も固定する — テスト出力に `GH_TOKEN` が
   * 全文で出た前例がある（`railway/setup.test.ts` の差分アサーション、#52）。
   *
   * **【経緯・期待値を反転した】** ここは元々「捨てる」ことを仕様として固定して
   * いた。その根拠は「処理しようとすると『未読の永続化』という別の設計になる」で
   * あり、当時それは正しかった。**その設計は後から入った**（`#remember` と
   * `#restoreUnread`）ので、根拠のほうが先に消えていた。片付けの窓に落ちた人間の
   * 最後の一言は、いちばん気づかれない失われ方をする。
   *
   * 上の段落の「ここで黙って消えると〜」以下は**そのまま効いている**（跡を残す
   * ことと本文を出さないことは何も変わっていない）。増えたのは、跡に加えて
   * **器にも残す**という保証である。**保証が減っていないこと**を見やすくするため、
   * 元の検証（跡が2行・本文が出ない・時刻が付く・1行に収まる）は1つも消して
   * いない。
   */
  it('止まった後に届いた合図は器へ残し、何が来たかが stderr に残る（本文は出さない）', async () => {
    const s = setup();
    await s.clone.stop();

    const lines = await captureStderr(() => {
      s.clone.post(humanMessage('鍵は ghp_000000000000000000000000000000000000 だ'));
      s.clone.post({
        type: 'manager_message',
        id: 'evt-report',
        at: new Date().toISOString(),
        managerId: 'mgr-1',
        kind: 'report',
        text: 'PR #99 をマージした。鍵は ghp_000000000000000000000000000000000000',
      });
    });

    const dropped = lines.filter((line) => line.includes('このプロセスでは処理しませんでした'));
    expect(dropped).toHaveLength(2);
    expect(dropped[0]).toContain('human_message');
    // どのマネージャーの、どの種類の一件だったかは残る
    expect(dropped[1]).toContain('manager_message managerId=mgr-1 kind=report');
    for (const line of dropped) {
      expect(line).not.toContain('ghp_');
      // 「いつ」。ホスティング先の付ける時刻に頼らない
      expect(line).toMatch(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/u);
      expect(line.endsWith('\n')).toBe(true);
      expect(line.trimEnd()).not.toContain('\n');
    }

    // **跡だけでは足りない。** 次の起動で配り直せる形で器に残っていること。
    // 書き込みは非同期なので、`post` が返った直後には間に合っていない
    await waitFor(async () => (await s.stores.inbox.claimPending()).length === 2, '未読の書き出し');

    // 引き受けた仕事としても載る（人間の最後の一言が、跡だけになって消えない）
    const open = (await s.stores.commitments.list()).entries;
    expect(open.map((entry) => entry.origin)).toEqual(['human', 'manager']);
    // 本文は器の中には**入る**（拾い直せなければ意味が無い）。出さないのは stderr の側だけ
    expect(open[0]?.body).toContain('ghp_');
  });
});

/**
 * 人間の発言が日誌へ載る時点と、その瞬間に出す合図。
 *
 * **「一件ずつ判断する」と「発言の記録も一件ずつ待たせる」は別のことである。**
 * ターンの直列は意図された設計（`docs/architecture.md` の同時実行モデル）だが、
 * 記録をその直列の後ろに置いていたのは帰結であって設計ではなかった。後ろに置くと、
 * 先客（蒸留・マネージャーとの往復・自律の起点）が走っているあいだ**日誌にその
 * 発言が存在しない** — 日誌から組み立てる `GET /conversations` にも出ないので、
 * 器（端末・タブ・アプリ）を替えた人からは発言そのものが消えて見える。
 *
 * ここで固定するのは「直列を壊さずに記録だけを前へ出した」ことである。
 */
describe('クローン — 発言を受理した瞬間の記録と合図', () => {
  /**
   * 1本目のターンを、明示的に解くまで握ったままにする偽 SDK。
   *
   * **時間で近似しない。** 「先客のターンが走っているあいだに届いた発言」を
   * `delayMs` で作ると、遅延の長さと poll の待ち時間の綱引きになる（速い器で通り、
   * 遅い器で落ちる）。止めたターンを明示的に解く形にすれば、「順番待ちのあいだ」を
   * 時計から切り離せる。
   */
  function fakeGatedSdk() {
    const calls: FakeCall[] = [];
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let held = true;

    const fn = ((params: { prompt: unknown; options?: Options }) => {
      const call: FakeCall = { options: params.options ?? {}, inputs: [] };
      calls.push(call);

      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-fake',
          uuid: 'uuid-init',
        } as unknown as SDKMessage;

        for await (const message of params.prompt as AsyncIterable<{
          message: { content: unknown };
        }>) {
          // **本文を控えてから止める。** 止めてから控えると「ターンが始まった」を
          // テストから観測できず、順番待ちを作れたことが確かめられない。
          call.inputs.push(String(message.message.content));
          if (held) await gate;
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'ok' }] },
            parent_tool_use_id: null,
            session_id: 'sess-fake',
            uuid: 'uuid-assistant',
          } as unknown as SDKMessage;
          yield {
            type: 'result',
            subtype: 'success',
            result: 'ok',
            session_id: 'sess-fake',
            uuid: 'uuid-result',
          } as unknown as SDKMessage;
        }
      }

      const generator = generate();
      return Object.assign(generator, {
        close: () => undefined,
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;

    return {
      fn,
      calls,
      /** 握っていたターンを解く。以降のターンは止まらない（`stop()` の蒸留が返る）。 */
      release: () => {
        held = false;
        open();
      },
    };
  }

  interface Gated {
    clone: CloneHost;
    stores: Stores;
    calls: FakeCall[];
    release: () => void;
  }

  function setupGated(stores: Stores = createMemoryStores()): Gated {
    const { fn, calls, release } = fakeGatedSdk();
    const clone = createClone({
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    return { clone, stores, calls, release };
  }

  /** 先客の内部ターンを走らせたまま止める（＝以後に届く発言は順番待ちになる）。 */
  async function occupy(gated: Gated): Promise<void> {
    gated.clone.post({
      type: 'self_initiative',
      id: 'evt-busy',
      at: new Date().toISOString(),
      reason: '先客のターン',
    });
    await expect.poll(() => (gated.calls[0]?.inputs ?? []).length, { timeout: 3000 }).toBe(1);
  }

  /**
   * 追記の1本目だけを遅らせる（受理の瞬間の追記だけが遅い形）。
   *
   * 全部を等しく遅らせると、受理の瞬間に書き始める側と応答を待ってから書く側の
   * 差が出ない（どちらも同じだけ遅れて着順は変わらない）。
   */
  function delayFirstJournalAppend(stores: Stores, delayMs: number): Stores {
    let first = true;
    return {
      ...stores,
      journal: {
        ...stores.journal,
        async append(entry) {
          if (first) {
            first = false;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          return stores.journal.append(entry);
        },
      },
    };
  }

  async function inboundTexts(stores: Stores): Promise<string[]> {
    const entries = (await stores.journal.list({ types: ['exchange'] })) as {
      role: string;
      text: string;
    }[];
    return entries.filter((entry) => entry.role === 'inbound').map((entry) => entry.text);
  }

  it('順番待ちのあいだに日誌へ載る（ターンが回るのを待たない）', async () => {
    const gated = setupGated();
    await occupy(gated);

    gated.clone.post(humanMessage('MSG-WAITING', 'conv-2'));

    // 先客のターンは握ったまま。**ここで載ることがこの直しの主題である。**
    await expect.poll(() => inboundTexts(gated.stores), { timeout: 3000 }).toContain('MSG-WAITING');
    // 載ったのは順番が来たからではない（この発言はまだモデルへ渡っていない）。
    expect(gated.calls[0]?.inputs).toHaveLength(1);

    gated.release();
    await gated.clone.stop();
  }, 10_000);

  it('日誌には一度だけ載る（受理の瞬間とターンの入口で二重に書かない）', async () => {
    const s = setup(() => 'こんにちは');

    s.clone.post(humanMessage('MSG-ONCE'));
    await waitForDone(s.events);

    expect((await inboundTexts(s.stores)).filter((text) => text === 'MSG-ONCE')).toHaveLength(1);

    await s.clone.stop();
  });

  it('`queued` は受理したその同期の中で届く（往復を待たない）', async () => {
    const s = setup();

    s.clone.post(humanMessage('やあ'));
    // **`await` を1つも挟まない。** `post` から戻った時点で既に届いていること。
    expect(s.events).toEqual([{ type: 'queued' }]);

    await waitForDone(s.events);
    await s.clone.stop();
  });

  it('順番待ちのあいだ `thinking` は来ない（2つの状態を1つの語に潰していない）', async () => {
    const gated = setupGated();
    const events: ChatStreamEvent[] = [];
    gated.clone.subscribe('conv-2', (event) => events.push(event));
    await occupy(gated);

    gated.clone.post(humanMessage('MSG-QUEUED', 'conv-2'));

    // 受理はされている（`queued`）。だが誰も考えていない（`thinking` は無い）。
    expect(events.map((event) => event.type)).toEqual(['queued']);

    gated.release();
    await gated.clone.stop();
  }, 10_000);

  it('順番が来たら `thinking` が続く（`queued` を置き換えるのではなく後に来る）', async () => {
    const s = setup(() => 'こんにちは');

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const types = s.events.map((event) => event.type);
    expect(types.indexOf('queued')).toBe(0);
    expect(types.indexOf('thinking')).toBeGreaterThan(0);

    await s.clone.stop();
  });

  it('追記が遅くても、発言は応答より先に日誌へ載る', async () => {
    // 待たずにターンを走らせると、短いターンでは応答の追記が先に着き、**日誌の上で
    // クローンが問われる前に答えたことになる**。追記の順序が会話の順序である
    // （`GET /conversations` は並べ直さない）ので、ここは着順で守る。
    const s = setup(() => 'こんにちは', delayFirstJournalAppend(createMemoryStores(), 200));

    s.clone.post(humanMessage('MSG-ORDER'));
    await waitForDone(s.events);

    // `list` は新しい順。
    const roles = (
      (await s.stores.journal.list({ types: ['exchange'] })) as { role: string }[]
    ).map((entry) => entry.role);
    expect(roles).toEqual(['outbound', 'inbound']);

    await s.clone.stop();
  }, 10_000);

  it('2発言が続けて届いても、日誌には受け取った順で載る', async () => {
    // 追記が `#pump` の中に在ったあいだ、この直列は受信箱のループが与えていた。
    // 受理の瞬間へ移した以上、**2本の追記が同時に飛ぶ**（`PgJournalStore` は
    // 自分で直列化していない）。1本目だけを遅くして、着順が入れ替わらないかを見る。
    const s = setup(() => 'こんにちは', delayFirstJournalAppend(createMemoryStores(), 200));

    s.clone.post(humanMessage('MSG-FIRST', 'conv-1'));
    s.clone.post(humanMessage('MSG-SECOND', 'conv-1'));

    // `list` は新しい順なので、受け取った順に入っていれば後の発言が先に出る。
    await expect
      .poll(() => inboundTexts(s.stores), { timeout: 3000 })
      .toEqual(['MSG-SECOND', 'MSG-FIRST']);

    await s.clone.stop();
  }, 10_000);

  it('日誌へ書けなくても応答は返る（記録できないことで応答を止めない）', async () => {
    const stores = failingJournalAppend(createMemoryStores(), '器が閉じている');

    await captureStderr(async () => {
      const s = setup(() => 'こんにちは', stores);
      s.clone.post(humanMessage('やあ'));
      // 落ちるなら `waitForDone` が投げる。
      await waitForDone(s.events);
      expect(s.events.some((event) => event.type === 'done')).toBe(true);
      await s.clone.stop();
    });
  });

  it('ターンが失敗しても、発言そのものは日誌に残る（#59 の保証を落とさない）', async () => {
    const stores = createMemoryStores();
    // 聞き手の居ない会話（`setup` が購読するのは conv-1 だけ）で、ターンを失敗させる。
    const s = setup(undefined, stores, { failWith: 'セッションを起こせない' });

    s.clone.post(humanMessage('MSG-FAILED', 'conv-9'));

    await expect.poll(() => inboundTexts(stores), { timeout: 3000 }).toContain('MSG-FAILED');

    await s.clone.stop();
  });

  it('人間以外の起点は起点ごとの型のまま（受理の瞬間へ寄せていない）', async () => {
    const stores = createMemoryStores();
    const s = setup(() => '見た', stores);

    s.clone.post({
      type: 'manager_message',
      id: 'evt-report',
      at: new Date().toISOString(),
      managerId: 'mgr-1',
      kind: 'report',
      text: 'MSG-REPORT',
    });

    await expect
      .poll(
        async () =>
          (await stores.journal.list({ types: ['exchange'] })).filter(
            (entry) => entry.type === 'exchange' && entry.with === 'manager',
          ).length,
        { timeout: 3000 },
      )
      .toBe(1);

    await s.clone.stop();
  });
});

/**
 * クローン自身の消費を台帳へ載せる。
 *
 * **ここが無かったことが依頼の出発点である。** `clone.ts` の `case 'result'` は
 * 本文を日誌へ書くだけで `modelUsage` を1バイトも読んでいなかった。人間は
 * `claude.ai/settings/usage` で自分の消費を見られるのだから、その写像である
 * クローンが自分の分を読めないのは能力の削除である（north_star 禁止1）。
 */
describe('クローンの消費が台帳に載る（誰が・どこで）', () => {
  /** モデル id を1つだけ持つ `modelUsage`。費用だけを動かす。 */
  function usage(model: string, costUsd: number) {
    return {
      [model]: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        // SDK 側の綴りは大文字（`costUSD`）。ここを小文字で書くと 0 が積まれる。
        costUSD: costUsd,
      },
    };
  }

  /** `PreCompact` フックを実際に叩いて蒸留のサイドクエリを走らせる。 */
  async function firePreCompact(main: FakeCall): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'alteroid-clone-usage-'));
    try {
      const transcriptPath = join(dir, 'transcript.jsonl');
      await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
      const hook = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
      if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
      await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
        signal: new AbortController().signal,
      } as never);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('本セッションの分が layer=clone / site=session として載る', async () => {
    const s = setup(undefined, createMemoryStores(), {
      modelUsage: () => usage('claude-fable-5', 0.5),
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const { rows } = await s.stores.usage.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.layer).toBe('clone');
    expect(rows[0]?.site).toBe('session');
    // actor は予約 id。マネージャーの id（`mgr-…`）とは衝突しない。
    expect(rows[0]?.managerId).toBe(CLONE_ACTOR_ID);
    expect(CLONE_ACTOR_ID.startsWith('mgr-')).toBe(false);
    expect(rows[0]?.totals.costUsd).toBe(0.5);

    await s.clone.stop();
  });

  it('モデル id が opus でも層は clone のままである（モデル名で層を代用していない）', async () => {
    // **これが依頼の中心にある問題である。** `ALTEROID_CLONE_MODEL=opus` を置くと
    // クローンとマネージャーは台帳で同じ `model` に並ぶ。モデル名を層の代わりに
    // 使っていれば、ここでクローンの分が「マネージャーの分」として読める。
    const s = setup(
      undefined,
      createMemoryStores(),
      { modelUsage: () => usage('claude-opus-5', 3) },
      { [CLONE_MODEL_ENV_KEY]: 'opus' },
    );

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const { rows } = await s.stores.usage.aggregate({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.model).toBe('claude-opus-5');
    expect(rows[0]?.layer).toBe('clone');

    await s.clone.stop();
  });

  it('要約の蒸留の分が site=distill として別に載る（本体の分と混ざらない）', async () => {
    // 呼び出し 0 が本セッション、呼び出し 1 が蒸留のサイドクエリ。**別の値を
    // 返す**ことで、どちらの分がどこへ積まれたかを問える。
    const s = setup(undefined, createMemoryStores(), {
      modelUsage: (index) =>
        index === 0 ? usage('claude-fable-5', 1) : usage('claude-fable-5', 0.25),
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    await firePreCompact(s.calls[0] as FakeCall);

    const { rows } = await s.stores.usage.aggregate({});
    expect(rows.map((r) => [r.site, r.totals.costUsd]).sort()).toEqual([
      ['distill', 0.25],
      ['session', 1],
    ]);
    // どちらもクローンの分である（「誰が」は同じで「どこで」が違う）。
    expect(rows.every((r) => r.layer === 'clone')).toBe(true);
    expect(rows.every((r) => r.managerId === CLONE_ACTOR_ID)).toBe(true);

    await s.clone.stop();
  });

  it('蒸留を2回走らせても、高くついた回が目減りしない（基準を持たない）', async () => {
    // 蒸留は毎回新しい `query()` で、`result` はその1回の総量そのものである。
    // 基準を持たせると 2回目は差の $0.03 しか積まれない（$0.08 の回が黙って縮む）。
    const distillCosts = [0.05, 0.08];
    let distillIndex = 0;
    const s = setup(undefined, createMemoryStores(), {
      modelUsage: (index) => {
        if (index === 0) return undefined; // 本セッションの分は数えない（この項の対象外）
        const cost = distillCosts[distillIndex] ?? 0;
        distillIndex += 1;
        return usage('claude-fable-5', cost);
      },
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    const main = s.calls[0] as FakeCall;
    await firePreCompact(main);
    await firePreCompact(main);

    const { rows } = await s.stores.usage.aggregate({ site: 'distill' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totals.costUsd).toBeCloseTo(0.13, 10);

    await s.clone.stop();
  });

  it('失敗した result は台帳へ入らない（ゼロで基準を下げない）', async () => {
    // SDK は `crash/startup-error results may carry zeroed values` と言っている。
    // ゼロを「累積が 0 になった」として通すと基準が下がり、次に届いた本物の累積が
    // 丸ごと増分になる ＝ 記録済みの分がもう一度積まれる。
    //
    // **`waitForDone` から `waitForTerminal` へ変えた経緯。** ここは元々
    // `waitForDone` で待っていたが、それは「失敗した result でも done が出る」
    // という当時の欠陥をそのまま仕様として固定していた（`case 'result':` が
    // 成否を見ずに無条件で `done` を出していたため）。その欠陥を直した結果、
    // このターンは `done` ではなく `error` で終わるので `waitForDone` は
    // 3秒でタイムアウトして落ちる。台帳のアサーション（`rows` が空 / `since` が
    // null）はこのテストが本来保証しているものなので変えていない。
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      modelUsage: () => usage('claude-fable-5', 0),
    });

    s.clone.post(humanMessage('やあ'));
    await waitForTerminal(s.events);
    expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual(['error']);

    const aggregate = await s.stores.usage.aggregate({});
    expect(aggregate.rows).toEqual([]);
    // 台帳そのものが始まっていない（1件も record していない）。
    expect(aggregate.since).toBeNull();

    await s.clone.stop();
  });

  it('失敗した result はターンの失敗として日誌に残る（無記録で消えない）', async () => {
    // 直す前は、失敗した result でも成否を見ずに `done` を出して `#finishTurn()`
    // を呼んでいた。`#turn` は既に `null` になった後なので `#reportFailure` が
    // 一度も呼ばれず、例外も起きないので `#handle` は正常終了し、受信箱の合図は
    // `#forget` されて消える — 支出上限や実行時エラーでターンが死んでも、日誌に
    // 何も残らなかった。ここではその「無記録で消える」が直っていることを見る。
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
    });

    s.clone.post(humanMessage('やあ'));
    await waitForTerminal(s.events);
    expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual(['error']);

    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
      text: string;
    }[];
    expect(exchanges.some((entry) => entry.text.includes('人間との対話ターンが失敗した'))).toBe(
      true,
    );

    await s.clone.stop();
  });

  it('失敗した result で done を出さない（成功したことにしない）', async () => {
    // `#emit` は `done` と `error` のどちらか一方だけを出す設計である。ここは
    // 「`error` が来た」だけでなく「`done` は一度も来ていない」までを見る —
    // 直す前の欠陥はまさに「失敗しても done が出る」ことだったので、`error` の
    // 有無だけでは同じ欠陥を見落としうる。
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
    });

    s.clone.post(humanMessage('やあ'));
    await waitForTerminal(s.events);
    expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual(['error']);
    expect(s.events.some((event) => event.type === 'done')).toBe(false);

    await s.clone.stop();
  });

  it('失敗した result でもターンは畳まれ、受信箱が止まらない', async () => {
    // `#finishTurn()` を失敗側で呼び忘れると、その `Turn.resolve` を待っている
    // `#runTurn`（延いては `#handle` と `#pump` の `for await`）が永久に返らず、
    // 受信箱のループそのものが次の合図へ進めなくなる。1本目が失敗で終わった後、
    // 2本目の発言が独立に処理される（＝2本目の error が来る）ことでそれを見る。
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
    });

    s.clone.post(humanMessage('1回目'));
    await waitForTerminal(s.events);
    expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual(['error']);

    s.clone.post(humanMessage('2回目'));
    await expect.poll(() => s.events.filter(isTerminal).length === 2, { timeout: 3000 }).toBe(true);
    expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual(['error', 'error']);

    await s.clone.stop();
  });

  it('支出上限で終わったとき、その理由が記録に残る', async () => {
    // 実機で支出上限に当たったとき、SDK は `subtype: 'error_during_execution'` と
    // 共に `result` へ `You've hit your individual spend limit` を載せて終わる
    // （`runner.ts` の同じ場面のコメントと同じ実例）。`subtype` だけを見て
    // 「結果なしで終了: error_during_execution」とだけ記録すると、上限で
    // 止まったのか単に失敗したのかをクローンが区別できなくなる。
    const spendLimitMessage = "You've hit your individual spend limit for this account.";
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    s.clone.post(humanMessage('やあ'));
    await waitForTerminal(s.events);

    const errorEvent = s.events.find(
      (event): event is Extract<ChatStreamEvent, { type: 'error' }> => event.type === 'error',
    );
    expect(errorEvent?.message).toContain(spendLimitMessage);

    await s.clone.stop();
  });

  it('台帳へ積めなくてもターンは止まらない（黙って消さないが、殺しもしない）', async () => {
    const stores = createMemoryStores();
    stores.usage.record = () => Promise.reject(new Error('台帳が書けない'));

    const s = setup(undefined, stores, { modelUsage: () => usage('claude-fable-5', 1) });

    const stderr = await captureStderr(async () => {
      s.clone.post(humanMessage('やあ'));
      // done が来る＝ターンが完走している
      await waitForDone(s.events);
      // **`stop()` も捕獲の内側で呼ぶ。** 外に置くと、`stop()` が積む片付けの蒸留
      // （`reason: 'shutdown'`）が**本セッションの2本目のターン**を起こし、その
      // `result` の台帳書き込みが同じ理由で失敗して、**生の stderr へ1行漏れる**
      // （`captureStderr` は `finally` で `process.stderr.write` を戻すので、その
      // 1ms 後の排出は素の stderr へ出る）。実測: 単体・`-t` 単発・フルスイートの
      // どれでも毎回1行。**フルスイートでだけ出るのではない。**
      //
      // 漏れが実害になるのは、その行が製品コードが本番で出すのと同じ前半
      // （`利用状況の台帳を記録できませんでした（layer=clone site=...）`）を持ち、
      // しかも `process.stderr.write` を直に呼ぶので vitest の「どのテストの出力か」
      // の前置きが付かないためである。緑の実行で毎回1行出続ければ、読み手はその
      // 文言を既知のノイズとして飛ばす訓練を受ける。
      //
      // 同じ `captureStderr` を使う兄弟の2本（`日誌にも書けなければ stderr に1行`
      // ／`storage is closed` を見る本）は、はじめから `stop()` を内側に置いて
      // いて漏れていない。**ここだけが外に出ていた。**
      await s.clone.stop();
    });

    // 跡は残る（「日誌に無い」が「起きなかった」と読めないように）
    expect(stderr.join('')).toContain('利用状況の台帳');

    // **件数まで見る。** `toContain` だけだと、人間のターンの分1件で満たされて
    // しまうので、**片付けの蒸留ターンで台帳の失敗が報告されなくなっても落ちない**
    // （そこは「たまたま出ていた」だけだった）。2件の出どころは、人間の発言の
    // ターンと、`stop()` が積む片付けの蒸留ターンである。`modelUsage` は
    // `callIndex` を見ないのでどちらの `result` にも usage が載り、どちらの
    // 書き込みもこのテストのスタブが reject する。
    const ledgerLines = stderr.filter((line) => line.includes('利用状況の台帳'));
    expect(ledgerLines).toHaveLength(2);
  });

  /**
   * **どの認証トークンで使ったか**（Issue #393 受け入れ基準6）。
   *
   * ここが固定するのは「クローンが何を渡すか」だけである。列の意味・鍵・軸の始点は
   * storage の2つの器（`@alteroid/storage-fs` / `@alteroid/storage-pg` の
   * `usage.test.ts`）が持つ。
   */
  describe('認証トークンの帰属', () => {
    /** 帰属を渡すクローン。`setup` は `tokenIdentity` を受けないので直に組む。 */
    function cloneWithIdentity(
      identity: () => { tokenId: string; generation: number } | undefined,
    ) {
      const stores = createMemoryStores();
      // **固定値にしない。** 呼ぶ回ごとに増える累積を返すので、同じセッションの
      // 2ターン目にも増分が立つ（固定値だと差が 0 になり、2ターン目が台帳に
      // 現れないので「読み直していないこと」を測れない）。
      let nth = 0;
      const { fn } = fakeSdk(undefined, {
        modelUsage: () => usage('claude-fable-5', ++nth * 0.5),
      });
      const clone = createClone({
        stores,
        queryFn: fn,
        env: {},
        tokenIdentity: identity,
        runners: createRunnerRegistry([
          createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
        ]),
      });
      const { events } = wireEvents(clone, 'conv-1');
      return { clone, stores, events };
    }

    it('現役の指名が在れば、その tokenId が行に載る', async () => {
      const s = cloneWithIdentity(() => ({ tokenId: 'tok-a', generation: 3 }));

      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      const { rows, tokensSince } = await s.stores.usage.aggregate({});
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tokenId).toBe('tok-a');
      // 帰属が1件入ったので、トークンの軸が始まっている。
      //
      // **`beforeTokens` は見ない。** 下限の無い照会（`from` 省略）は常に始点より
      // 前を含みうるので真である（`beforeLedger` / `beforeLayers` と同じ契約）。
      // ここで偽を期待すると、契約と逆のものを固定してしまう。
      expect(tokensSince).not.toBeNull();

      await s.clone.stop();
    });

    it('現役の指名が無ければ帰属を渡さない（プールが空の器で軸が始まらない）', async () => {
      // **受け入れ基準7 の側である。** ここで何かを埋めると、プールを1本も
      // 持っていない器が「そのトークンで使った」と名乗る。
      const s = cloneWithIdentity(() => undefined);

      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);

      const { rows, since, tokensSince, beforeTokens } = await s.stores.usage.aggregate({});
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tokenId).toBeUndefined();
      // 台帳は始まっているのに、トークンの軸だけ始まっていない。
      expect(since).not.toBeNull();
      expect(tokensSince).toBeNull();
      expect(beforeTokens).toBe(true);

      await s.clone.stop();
    });

    it('帰属は「セッションが起きた瞬間の身元」である（record のたびに読み直さない）', async () => {
      // **読み直すと、回した直後に届いた前のセッションぶんの消費が新しいトークンに
      // 付く。** `#tokenIdentities`（マネージャー側）が在るのと同じ理由である。
      let current = { tokenId: 'tok-a', generation: 1 };
      const s = cloneWithIdentity(() => current);

      s.clone.post(humanMessage('1回目'));
      await waitForDone(s.events);

      // セッションは開いたまま、現役だけが入れ替わる。
      current = { tokenId: 'tok-b', generation: 2 };
      s.clone.post(humanMessage('2回目'));
      await waitFor(
        async () => (await s.stores.usage.aggregate({})).rows[0]?.totals.costUsd === 1,
        '2ターン目が台帳へ載ること',
      );

      const { rows } = await s.stores.usage.aggregate({});
      // **行は1つのまま。** 読み直していれば `tok-b` の行が別に立つ。
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tokenId).toBe('tok-a');
      expect(rows[0]?.totals.costUsd).toBe(1);

      await s.clone.stop();
    });
  });
});

/**
 * PreCompact のサイドセッション（`#distillFromTranscript`）が起こすターンの
 * 入力を日誌に残す（Issue #243 の7本目。既存6経路は `clone-turn-input.test.ts`
 * が持つ）。
 *
 * この経路は `#runInternal` / `#runTurn` を経由せず `this.#queryFn` を直接
 * 呼ぶので、あちらのテストが使う `bootClone`（ストリーミング入力専用の
 * 簡約フェイク）では起こせない——ここは1つ上の「クローンの消費が台帳に載る」と
 * 同じ `fakeSdk`（文字列プロンプトも扱える。`typeof prompt === 'string'` 分岐）
 * と `firePreCompact` の骨格を使う。
 */
describe('クローン — PreCompact サイドセッションの入力を日誌に残す（#243）', () => {
  const TRANSCRIPT = 'PRECOMPACT-TRANSCRIPT-MARKER-7f2a 要約に潰される直前の生ログの中身';

  /** `PreCompact` フックを実際に叩いて蒸留のサイドクエリを走らせる。 */
  async function firePreCompact(main: FakeCall, transcript = TRANSCRIPT): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'alteroid-clone-precompact-turn-input-'));
    try {
      const transcriptPath = join(dir, 'transcript.jsonl');
      await writeFile(transcriptPath, transcript, 'utf8');
      const hook = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
      if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
      await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
        signal: new AbortController().signal,
      } as never);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** 日誌から `pre_compact_distill` の1行を拾う（self/inbound で絞る）。 */
  async function pickEntry(stores: Stores): Promise<string> {
    const entries = await stores.journal.list({ types: ['exchange'] });
    const hit = entries.find(
      (entry) =>
        entry.type === 'exchange' &&
        entry.with === 'self' &&
        entry.role === 'inbound' &&
        entry.text.includes('ターンの入力: pre_compact_distill'),
    );
    expect(
      hit,
      '日誌に self/inbound の「ターンの入力: pre_compact_distill」の行が無い',
    ).toBeDefined();
    return hit?.type === 'exchange' ? hit.text : '';
  }

  it('chars と指紋が残り、生ログの本文そのものは載らない', async () => {
    const s = setup();

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    await firePreCompact(s.calls[0] as FakeCall);

    const text = await pickEntry(s.stores);

    // **先に、本文が実際にそのターン（SDK へ渡った側）には載っていることを
    // 確かめる。** これが無いと下の `not.toContain` は空振りで真になる。
    expect(s.calls[1]?.inputs[0]).toContain(TRANSCRIPT);

    expect(text).toContain(`tail.chars=${TRANSCRIPT.length}`);
    expect(text).toContain(`tail.fp=${fingerprintOf(TRANSCRIPT)}`);
    // **本文そのもの（全文でも抜粋でも）は載らない。**
    expect(text).not.toContain(TRANSCRIPT);
    expect(text).not.toContain('PRECOMPACT-TRANSCRIPT-MARKER-7f2a');

    await s.clone.stop();
  });

  it('長さが同じでも内容が違えば指紋が変わる（chars だけでは区別できない）', async () => {
    const a = `${'A'.repeat(30)}-MARK-ONE`;
    const b = `${'B'.repeat(30)}-MARK-TWO`;
    expect(a.length).toBe(b.length);

    async function recordedFingerprint(transcript: string): Promise<string> {
      const s = setup();
      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);
      await firePreCompact(s.calls[0] as FakeCall, transcript);
      const text = await pickEntry(s.stores);
      await s.clone.stop();
      const match = /tail\.fp=([0-9a-f]+)/u.exec(text);
      if (match?.[1] === undefined) throw new Error('日誌の行に指紋が見つからない');
      return match[1];
    }

    const fpA = await recordedFingerprint(a);
    const fpB = await recordedFingerprint(b);

    expect(fpA).toBe(fingerprintOf(a));
    expect(fpB).toBe(fingerprintOf(b));
    expect(fpA).not.toBe(fpB);
  });
});

/**
 * 蒸留へ渡す末尾は、**全文を 1 本の文字列にせずに**読む（`readTranscriptTail`）。
 *
 * ## なぜこの歯が要るか
 *
 * `readFile(path, 'utf8')` は中身を 1 本の文字列にするので、JS の文字列の上限
 * （`node:buffer` の `constants.MAX_STRING_LENGTH`）を超えると
 * `ERR_STRING_TOO_LONG` で投げる。**クローンの生ログは 1 本のセッションが伸び続ける
 * 形（resume が同じセッションへ書き足す）なので、伸びるほど確実に当たる側である。**
 *
 * ## ⚠️ この歯が測っているのは「単位」である
 *
 * `tailOf` が切るのは**文字**であってバイトではない。⟹ 末尾から
 * `DISTILL_TRANSCRIPT_TAIL_CHARS` **バイト**だけ読む形へ直すと、日本語混じりの生ログでは
 * 渡る量が 1/3 になる。**そしてそれは赤くならない** —— 短い末尾でも蒸留は成功するので、
 * 失われたことがどこにも出ない。⟹ **だから長さと中身をここで測る。**
 */
describe('クローン — 蒸留の末尾は全文を読まずに取る（渡る量を減らさない）', () => {
  /** 1 行あたり約 200 文字の日本語（1 文字 3 バイト）を並べた生ログ。 */
  function japaneseTranscript(lines: number): string {
    return Array.from(
      { length: lines },
      (_, i) => `${String(i).padStart(4, '0')}行目の記録である。${'あ'.repeat(180)}`,
    ).join('\n');
  }

  /** `PreCompact` フックを実際に叩いて蒸留のサイドクエリを走らせる。 */
  async function firePreCompactWith(main: FakeCall, transcript: string): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'alteroid-clone-tail-'));
    try {
      const transcriptPath = join(dir, 'transcript.jsonl');
      await writeFile(transcriptPath, transcript, 'utf8');
      const hook = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
      if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
      await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
        signal: new AbortController().signal,
      } as never);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('60,000 文字級の日本語でも、渡る末尾は全文を読んだときと同じである', async () => {
    const transcript = japaneseTranscript(500);
    // **前提を先に測る。** ここが偽なら、下の歯は単位の取り違えを検出できない。
    expect(transcript.length).toBeGreaterThan(60_000);
    expect(Buffer.byteLength(transcript, 'utf8')).toBeGreaterThan(transcript.length * 2.5);

    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    await firePreCompactWith(s.calls[0] as FakeCall, transcript);

    // **末尾 60,000 文字ぶんが渡っている。** バイトで窓を取ると 20,000 文字台になる。
    const rows = (await s.stores.journal.list({ types: ['exchange'] })).filter(
      (entry) => entry.type === 'exchange',
    );
    const inputRow = rows.find((entry) => entry.text.includes('ターンの入力: pre_compact_distill'));
    expect(inputRow, '日誌に pre_compact_distill の行が無い').toBeDefined();
    const chars = Number(/tail\.chars=(\d+)/u.exec(inputRow?.text ?? '')?.[1] ?? '0');
    expect(chars).toBeGreaterThan(59_000);
    expect(chars).toBeLessThanOrEqual(60_000);

    // **中身も同じである。** 長さだけでは、別の 60,000 文字を渡しても通る。
    const prompt = s.calls[1]?.inputs[0] ?? '';
    expect(prompt).toContain(transcript.slice(-59_000));
    // 渡すのは末尾だけである（全文は渡らない）。
    expect(prompt).not.toContain(transcript.slice(0, 200));

    await s.clone.stop();
  });

  /**
   * **⭐ 退避が落ちても蒸留へ進む**（`#onPreCompact`）。
   *
   * 直す前は 1 つの `try` に (i) 退避と (ii) 蒸留が入っていた。⟹ 全文の `readFile` か
   * `archive` のどちらかが落ちると**蒸留も走らない。** この経路の doc は逐語で
   * 「蒸留は生存条件であり、後回しにしてよい機能ではない」と書いているので、
   * **退避の都合で蒸留が止まる形は、その約束と食い違う。**
   */
  it('退避が落ちても蒸留へ進む（PreCompact。文言も2つに割れている）', async () => {
    const stores = createMemoryStores();
    const broken: Stores = {
      ...stores,
      archive: {
        archive: async () => {
          throw new Error('退避先が閉じている');
        },
        list: () => stores.archive.list(),
        read: (id: string) => stores.archive.read(id),
      },
    };

    const s = setup(undefined, broken);
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    await firePreCompactWith(s.calls[0] as FakeCall, 'PRECOMPACT-BROKEN-ARCHIVE の生ログ');

    const rows = (await broken.journal.list({ types: ['exchange'] })).filter(
      (entry) => entry.type === 'exchange',
    );
    // **蒸留は走った**（退避の失敗に巻き込まれていない）。
    expect(rows.some((entry) => entry.text.includes('ターンの入力: pre_compact_distill'))).toBe(
      true,
    );
    // **文言は2つに割れている**（直す前は「退避・蒸留に失敗した」の1本だった）。
    expect(rows.some((entry) => entry.text.includes('PreCompact の退避に失敗した'))).toBe(true);
    expect(rows.some((entry) => entry.text.includes('PreCompact の蒸留に失敗した'))).toBe(false);

    await s.clone.stop();
  });
});

/**
 * 起動時に、**前の器が記憶へ移せなかった区間を拾い直す**（#564 E1b。
 * `#pickUpTranscriptGrave`）。
 *
 * ## なぜ歯が要るか
 *
 * 印（墓標）が立つのは蒸留が落ちた回で、**主な理由は枠が閉じていること**である。
 * 枠は待てば開くが、**拾い直す手が無ければ、開いても誰も戻らない。**
 *
 * ## ⚠️ この歯が測っていないこと
 *
 * **枠が閉じたまま何度も起動する回**は測っていない（印が残り続けることは
 * 「印を下ろすのは成功したときだけ」という1本の条件から出るが、実際に回して
 * いない）。
 */
describe('クローン — 起動時に墓標を拾い直す（#564 E1b）', () => {
  /** 日誌の self/outbound を text で読む。 */
  async function selfTexts(stores: Stores): Promise<string[]> {
    const rows = await stores.journal.list({ types: ['exchange'] });
    return rows
      .filter((entry) => entry.type === 'exchange' && entry.with === 'self')
      .map((entry) => (entry.type === 'exchange' ? entry.text : ''));
  }

  it('墓標が在れば拾って蒸留し、印を下ろす', async () => {
    const stores = createMemoryStores();
    const archiveId = await stores.archive.archive(
      'sess-old',
      'GRAVE-TRANSCRIPT-MARKER-3c9d 前の器が記憶へ移せなかった区間の生ログ',
    );
    await stores.sessions.setTranscriptGrave({ archiveId });

    const s = setup(undefined, stores);
    await waitFor(
      async () =>
        (await selfTexts(stores)).some((text) =>
          text.includes('前の器が記憶へ移せなかった区間を拾い直す'),
        ),
      '拾い直しの1行が日誌に残ること',
    );
    // **蒸留のサイドセッションへ中身が渡っている**（日誌の行だけでは、拾っただけで
    // 何も渡していない形と区別が付かない）。
    await waitFor(
      () =>
        s.calls.some((call) =>
          call.inputs.some((input) => input.includes('GRAVE-TRANSCRIPT-MARKER-3c9d')),
        ),
      '蒸留へ生ログが渡ること',
    );
    // **印は下りている**（蒸留が成功したので）。
    await waitFor(
      async () => (await stores.sessions.getTranscriptGrave()) === null,
      '印が下りること',
    );

    await s.clone.stop();
  });

  it('退避が見つからないときは、印を下ろして日誌に残す', async () => {
    const stores = createMemoryStores();
    await stores.sessions.setTranscriptGrave({ archiveId: 'sess-gone-0001' });

    const s = setup(undefined, stores);
    await waitFor(
      async () =>
        (await selfTexts(stores)).some((text) =>
          text.includes('退避が見つからないので、印を下ろした'),
        ),
      '印を下ろした1行が残ること',
    );
    expect(await stores.sessions.getTranscriptGrave()).toBeNull();
    // **蒸留は起こさない**（渡す中身が無い）。
    expect(
      (await selfTexts(stores)).some((text) =>
        text.includes('前の器が記憶へ移せなかった区間を拾い直す'),
      ),
    ).toBe(false);

    await s.clone.stop();
  });

  it('対照: 墓標が無ければ何も起こさない', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const texts = await selfTexts(stores);
    expect(texts.some((text) => text.includes('前の器が記憶へ移せなかった区間を拾い直す'))).toBe(
      false,
    );
    expect(texts.some((text) => text.includes('退避が見つからないので、印を下ろした'))).toBe(false);

    await s.clone.stop();
  });
});

/**
 * `UsageFold.delta`（ターン1回ぶんの増分）は台帳へ積むだけで捨てていた。
 * 台帳は日 × actor × モデル × 層 × 場所に畳むので、「そのターンがいくらだったか」
 * は台帳のどこにも残らない。ここは `#recordUsage` が `turn_usage` として
 * 日誌へ残すことを見る（`manager.ts` の `case 'usage'` にも対になる形を足した
 * — 片方だけだと非対称が残る）。
 */
describe('クローン — ターン1回ぶんの増分を turn_usage として日誌に残す', () => {
  /** `costUsd` に加え cache read/write も動かせる `modelUsage` の素材。 */
  function usageOf(
    model: string,
    fields: {
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      costUsd?: number;
    },
  ) {
    return {
      [model]: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: fields.cacheReadInputTokens ?? 0,
        cacheCreationInputTokens: fields.cacheCreationInputTokens ?? 0,
        webSearchRequests: 0,
        // SDK 側の綴りは大文字（`costUSD`）。
        costUSD: fields.costUsd ?? 0,
      },
    };
  }

  it('cacheReadInputTokens / cacheCreationInputTokens / costUsd が潰されずに日誌へ入る', async () => {
    const s = setup(undefined, createMemoryStores(), {
      modelUsage: () =>
        usageOf('claude-fable-5', {
          costUsd: 0.5,
          cacheReadInputTokens: 120,
          cacheCreationInputTokens: 40,
        }),
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const entries = await s.stores.journal.list({ types: ['turn_usage'] });
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (entry?.type !== 'turn_usage') throw new Error('turn_usage が日誌に無い');
    expect(entry.layer).toBe('clone');
    expect(entry.site).toBe('session');
    expect(entry.managerId).toBe(CLONE_ACTOR_ID);
    // **合計に潰していないこと** — read と write が別々に残っている。
    expect(entry.models['claude-fable-5']).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 120,
      cacheCreationInputTokens: 40,
      webSearchRequests: 0,
      costUsd: 0.5,
    });
    expect(entry.reset).toBeUndefined();

    await s.clone.stop();
  });

  it('増分が空の回（同じ累積が2ターン続く）は turn_usage の行を書かない', async () => {
    // 同一セッション内の2ターン目。`modelUsage` は同じ値を返し続けるので、
    // 2回目の累積は1回目と変わらない ＝ 増分ゼロ。
    const s = setup(undefined, createMemoryStores(), {
      modelUsage: () => usageOf('claude-fable-5', { costUsd: 1 }),
    });

    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    s.clone.post(humanMessage('2回目'));
    await expect
      .poll(() => s.events.filter((event) => event.type === 'done').length === 2, {
        timeout: 3000,
      })
      .toBe(true);

    const entries = await s.stores.journal.list({ types: ['turn_usage'] });
    // **「行が無い」＝増分ゼロであって、そのターンが無料だったわけではない**
    // （このテストでは実際に増分がゼロなので1件のまま増えない、が正しい）。
    expect(entries).toHaveLength(1);

    await s.clone.stop();
  });

  it('累積が数え直された回は turn_usage に reset が付く（models は差分ではなく新しい累積の先頭）', async () => {
    let turnCount = 0;
    const s = setup(undefined, createMemoryStores(), {
      modelUsage: () => {
        turnCount += 1;
        return turnCount === 1
          ? usageOf('claude-fable-5', { costUsd: 5 })
          : usageOf('claude-fable-5', { costUsd: 3 });
      },
    });

    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    // resume / /clear で SDK 側の累積が 0 から始まり、次に読めた値が 3 だった形。
    s.clone.post(humanMessage('2回目'));
    await expect
      .poll(() => s.events.filter((event) => event.type === 'done').length === 2, {
        timeout: 3000,
      })
      .toBe(true);

    const all = await s.stores.journal.list({ limit: 50 });
    // **既存の1行（`exchange with=self`）は従来どおり出る**（あちらを壊していない）。
    const note = all.find(
      (entry) => entry.type === 'exchange' && entry.text.includes('数え直された'),
    );
    expect(note).toBeDefined();

    const turnUsageEntries = all.filter((entry) => entry.type === 'turn_usage');
    expect(turnUsageEntries).toHaveLength(2);
    const resetEntry = turnUsageEntries.find(
      (entry) => entry.type === 'turn_usage' && entry.reset !== undefined,
    );
    if (resetEntry?.type !== 'turn_usage') throw new Error('reset 付きの turn_usage が無い');
    expect(resetEntry.reset).toEqual({ fromCostUsd: 5, toCostUsd: 3 });
    expect(resetEntry.models['claude-fable-5']?.costUsd).toBe(3);

    await s.clone.stop();
  });

  it('台帳へ積めなければ turn_usage も書かれない（黙って消さないが、殺しもしない）', async () => {
    const stores = createMemoryStores();
    stores.usage.record = () => Promise.reject(new Error('台帳が書けない'));

    const s = setup(undefined, stores, {
      modelUsage: () => usageOf('claude-fable-5', { costUsd: 1 }),
    });

    const stderr = await captureStderr(async () => {
      s.clone.post(humanMessage('やあ'));
      await waitForDone(s.events);
      // **`stop()` も捕獲の内側で呼ぶ。** 理由はすぐ上の兄弟
      // （`台帳へ積めなくてもターンは止まらない`）と同じで、外に置くと `stop()` が
      // 積む片付けの蒸留ターンの台帳失敗が**生の stderr へ漏れる**。
      // `turn_usage` が0件であることも、片付けのターンまで含めて見るほうが強い。
      await s.clone.stop();
    });

    expect(stderr.join('')).toContain('利用状況の台帳');
    const entries = await s.stores.journal.list({ types: ['turn_usage'] });
    expect(entries).toHaveLength(0);
  });

  it('失敗したターン（isSuccessResult が偽）は turn_usage の行を書かず、消費は次の成功したターンへ合算される', async () => {
    // `#recordUsage` は `isSuccessResult` が偽の result を早期 return で捨てる
    // （`schema.ts` の `turn_usage.models` の doc「## これは『このターンの消費』
    // ではなく『前回成功した result からの増分』である」）。1ターン目は失敗、
    // 2ターン目は成功で、SDK側の累積は両方を含む形（$5）を返す ——
    // 失敗ターンの分（$2）は消えるのではなく、2ターン目の増分へ合算されて
    // 現れることを見る。
    let modelUsageCalls = 0;
    const s = setup(undefined, createMemoryStores(), {
      resultFor: (turnIndex) =>
        turnIndex === 0 ? { subtype: 'error_during_execution' } : undefined,
      modelUsage: () => {
        modelUsageCalls += 1;
        return modelUsageCalls === 1
          ? usageOf('claude-fable-5', { costUsd: 2 })
          : usageOf('claude-fable-5', { costUsd: 5 });
      },
    });

    s.clone.post(humanMessage('1回目'));
    await waitForTerminal(s.events);
    expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual(['error']);

    // **失敗ターンは行を1件も作らない。**
    const afterFirst = await s.stores.journal.list({ types: ['turn_usage'] });
    expect(afterFirst).toHaveLength(0);

    s.clone.post(humanMessage('2回目'));
    await expect
      .poll(() => s.events.filter((event) => event.type === 'done').length === 1, {
        timeout: 3000,
      })
      .toBe(true);

    const afterSecond = await s.stores.journal.list({ types: ['turn_usage'] });
    expect(afterSecond).toHaveLength(1);
    const entry = afterSecond[0];
    if (entry?.type !== 'turn_usage') throw new Error('turn_usage が日誌に無い');
    // **失敗ターンの分（$2）は消えたのではなく、2ターン目の増分（$5）へ
    // 合算されて現れている**（基準は失敗ターンで更新されていないので、
    // 2ターン目の差分は 5 - 0 = 5 になる）。
    expect(entry.models['claude-fable-5']?.costUsd).toBe(5);

    await s.clone.stop();
  });

  /**
   * **非対称の解消。** `manager.ts` の `case 'usage'` の `catch` は台帳の
   * 記録が失敗すると `exchange with=manager` を日誌へ書くが、クローン層の
   * `#recordUsage` は `noteDroppedRecord` で stderr にしか跡を残していな
   * かった。台帳の記録が落ちたクローンのターンは、日誌に `turn_usage` も
   * `exchange` も1行も残らなかった（`schema.ts` の `turn_usage` の doc
   * 「行が無い理由は3つある」の2番）。ここでは `#recordUsage` の `catch` が
   * `#journal` を1回だけ呼び直すようになったことを見る（新しい仕組みは
   * 作っていない — `#journal` が既に持つ「best-effort・stderr フォール
   * バック・throw しない」の契約に乗るだけである）。
   */
  it('台帳へ積めなければ、日誌に exchange with=self が1件残る（非対称の解消）', async () => {
    const stores = createMemoryStores();
    stores.usage.record = () => Promise.reject(new Error('台帳が書けない'));

    const s = setup(undefined, stores, {
      modelUsage: () => usageOf('claude-fable-5', { costUsd: 1 }),
    });

    s.clone.post(humanMessage('やあ'));
    // 台帳が落ちてもターンは正常に畳まれる（既存の振る舞いを壊していない）。
    await waitForDone(s.events);

    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      role: string;
      text: string;
    }[];
    const dropped = exchanges.find(
      (entry) => entry.with === 'self' && entry.text.includes('消費を台帳へ記録できなかった'),
    );
    expect(dropped).toBeDefined();
    // マネージャー層（`manager.ts` の同じ catch）と文言を揃えてある。
    expect(dropped?.text).toContain('消費を台帳へ記録できなかった（この分は集計に出ない）');
    // クローン層には複数マネージャーのような区別が無い代わりに、呼び出し
    // 文脈を区別する軸である `site` をタグとして前置する。
    expect(dropped?.text).toContain('site=session');

    await s.clone.stop();
  });

  it('台帳の記録も日誌への追記も両方失敗しても、throw が外へ出ずターンが畳まれる', async () => {
    const stores = createMemoryStores();
    stores.usage.record = () => Promise.reject(new Error('台帳が書けない'));
    stores.journal.append = () => Promise.reject(new Error('日誌も書けない'));

    const s = setup(undefined, stores, {
      modelUsage: () => usageOf('claude-fable-5', { costUsd: 1 }),
    });

    const stderr = await captureStderr(async () => {
      s.clone.post(humanMessage('やあ'));
      // done が来る＝ターンが完走している（`#journal` の内側の catch へ
      // 吸収され、`#recordUsage` の外へ例外が漏れていない）。
      await waitForDone(s.events);
    });

    // 台帳の失敗そのものを名指しする跡は stderr に残る。
    expect(stderr.join('')).toContain('利用状況の台帳');
    // 日誌への追記そのものも失敗したので、`#journal` 自身のフォールバックで
    // もう1行 stderr に残る（`noteDroppedRecord('日誌', ...)`）。
    expect(stderr.join('')).toContain('日誌を記録できませんでした');

    await s.clone.stop();
  });
});

/**
 * 枠（利用上限）に当たったら、合図を捨てずに保持し、次の合図が来たときに
 * 試し直す（`clone.ts` の `#usageBlocked` / `#deferred`）。
 *
 * タイマーは持たない。「試す」の契機は常に**新しい合図の到着**である。`post()`
 * は解除の印を立てるだけで、保持していた合図を FIFO の順で受信箱へ戻すのは
 * `#pump` の先頭である（**そこへ寄せてあるのが競合を塞いでいる本体** —
 * 下の「終端を出した直後…」／「短絡した合図の後始末の直前に…」の2本が、
 * 寄せる前に何が失われていたかを名指しで踏む）。戻した先頭が枠でまた落ちれば
 * `#usageBlocked` が再び立ち、残りはまた保持される（`#pump` の枠チェック）。
 */
describe('クローン — 枠（利用上限）が閉じたら保持して次の合図で試す', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  /**
   * 実際に SDK へ投げられた入力を「何件目か」の並びへ畳む。**FIFO を見るための
   * 目である。**
   *
   * 完全一致では見ない — `redeliveryNotice` / `commitmentNotice` が本文の前に
   * 付くので、部分一致で畳む。どれにも当たらない入力は `'?'` にして**捨てない**
   * （落とすと、余計な入力が1件混ざったことが並びから消える）。
   */
  function labelOrder(call: FakeCall): string[] {
    return call.inputs.map((text) => {
      for (const label of ['一件目', '二件目', '三件目']) {
        if (text.includes(label)) return label;
      }
      return '?';
    });
  }

  it('枠に当たったとき、usage_limited が error より先に届く', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    s.clone.post(humanMessage('やあ'));
    await waitForTerminal(s.events);

    const usageLimitedIndex = s.events.findIndex((event) => event.type === 'usage_limited');
    const errorIndex = s.events.findIndex((event) => event.type === 'error');
    expect(usageLimitedIndex).toBeGreaterThanOrEqual(0);
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(usageLimitedIndex).toBeLessThan(errorIndex);

    const usageLimitedEvent = s.events[usageLimitedIndex] as Extract<
      ChatStreamEvent,
      { type: 'usage_limited' }
    >;
    expect(usageLimitedEvent.message).toContain(spendLimitMessage);

    await s.clone.stop();
  });

  it('枠に当たった合図は forget されない（stores.inbox に未読として残る）', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    const event = humanMessage('やあ');
    s.clone.post(event);
    await waitForTerminal(s.events);

    // `waitForTerminal` は `error` の到着（`#reportFailure` 内の同期 `#emit`）
    // だけを見ており、`#pump` の `finally`（`#settleInboxEvent`）はそのあとの
    // 非同期の続きなので、消えて**いない**ことを確かめるにはそこまで待つ。
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === event.id);
    }, '枠に当たった合図が未読として残る');

    await s.clone.stop();
  });

  it('枠が閉じている間に届いた2本目は、ターンが回らないのに error で終端する', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    s.clone.post(humanMessage('一件目'));
    await waitForTerminal(s.events);
    expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual(['error']);

    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.length === 1;
    }, '1本目が未読のまま保持される');
    const inputsBeforeSecondPost = (s.calls[0] as FakeCall).inputs.length;

    s.clone.post(humanMessage('二件目'));
    // 2本目の到着は「保持していた1本目の再試行」を1回だけ誘発する。その再試行も
    // 同じ理由（固定の spendLimitMessage）で失敗するので枠は閉じたままで、
    // 2本目自身は短絡される。terminal は合計3件になる
    // （1本目の初回失敗・1本目の再試行の失敗・2本目の短絡）。
    //
    // 何を待っているか: 「terminal が3件になったこと」であって「3秒以内に
    // なったか」ではない。`s.waitForEvents` は `clone.subscribe` の callback
    // が出来事の到着ごとに同期で条件を確かめる（`waitForEvents` の doc 参照）。
    // 経緯: 元は `expect.poll(..., { timeout: 3000 })` でポーリングしていた。
    // PR #90 の変異試験自身が「落ち方の所要時間が3000ms台＝ポーリングの
    // 待ち切れ」と自己申告していた（弱い証拠）。
    await s.waitForEvents((events) => events.filter(isTerminal).length === 3);
    expect(s.events.filter(isTerminal).map((event) => event.type)).toEqual([
      'error',
      'error',
      'error',
    ]);

    // 2本目自身はターンを回さない ＝ 呼び出し回数（query 呼び出し）も入力も
    // 2本目の分は増えていない（増えたのは1本目の再試行の1件だけ）。
    expect(s.calls.length).toBe(1);
    const inputsAfterSecondPost = (s.calls[0] as FakeCall).inputs.length;
    expect(inputsAfterSecondPost).toBe(inputsBeforeSecondPost + 1);
    expect((s.calls[0] as FakeCall).inputs.some((text) => text.includes('二件目'))).toBe(false);

    await s.clone.stop();
  });

  it('3本目の合図が来たら、保持していた合図が FIFO の順で配り直され、実際に投げられる', async () => {
    // 最初の2ターン（0, 1回目の入力）だけ失敗させ、3回目以降は通常どおり
    // 成功させる。**固定値のスタブにしないための `resultFor`**（何回目かで
    // 挙動を変える）。
    const s = setup(undefined, createMemoryStores(), {
      resultFor: (turnIndex) =>
        turnIndex < 2 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    s.clone.post(humanMessage('一件目')); // turn 0: 失敗
    await waitForTerminal(s.events);

    s.clone.post(humanMessage('二件目')); // 1本目の再試行（turn 1: 失敗）を誘発。2本目自身は短絡される
    //
    // **この待ちだけは、以前は `expect.poll` のまま残されていた。** 決定的な待ちへ
    // 変えると直後の `post('三件目')` が二件目を迷子にする、というのが理由で、
    // それは**テストの問題ではなく production 側の競合**だった（`post()` が
    // その場で `#usageBlocked` を降ろし、まだ `#deferred` へ積まれていない
    // 合図を取り残していた）。`expect.poll` のポーリング間隔がその後始末を
    // 待つ時間を偶然与えていたので、穴が隠れていただけである。
    //
    // 競合は `clone.ts` の `#pump` 先頭（解除をそこへ寄せた）で塞いであり、
    // 隙間そのものを名指しで踏む本が2本ある（下の「終端を出した直後…」／
    // 「短絡した合図の後始末の直前に…」）。**塞いだので、ここもポーリングを
    // 使わない形へ揃えられる。**
    await s.waitForEvents((events) => events.filter(isTerminal).length === 3);

    s.clone.post(humanMessage('三件目')); // 保持していた[一件目, 二件目]を戻し、三件目も積む
    // 一件目(turn 2) → 二件目(turn 3) → 三件目(turn 4) の順に実際に投げられ、
    // 今度はすべて成功する（`done` が3件増える）。
    await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length === 3);

    // 入力に載ったテキストの出現順で FIFO を確かめる（`labelOrder` の doc）。
    expect(labelOrder(s.calls[0] as FakeCall)).toEqual([
      '一件目',
      '一件目',
      '一件目',
      '二件目',
      '三件目',
    ]);

    await s.clone.stop();
  });

  /**
   * ## 割り込む一点を、待ちの速さではなく `#emit` の同期性で名指しする
   *
   * 下の2本は「終端（`error`）は出したが、その合図の後始末
   * （`#settleInboxEvent`）はまだ走っていない」という**一点**に `post()` を
   * 差し込む。`#emit` は購読者の callback を同期で呼ぶので、callback の中で
   * `post()` を呼べばその一点に必ず入る。
   *
   * **`await` を挟んだ待ちの後に `post()` する形では、この窓に入れるかどうかが
   * ホストの速さで変わる**（＝踏めた回だけ壊れ、踏まなかった回は緑になる）。
   * 実際に PR #110 は、`expect.poll` のポーリング間隔が偶然この後始末を待って
   * いたおかげでこの穴を見ずに済んでいた。ここでは**タイミングに一切頼らずに
   * 毎回踏む**ので、直っていなければ必ず落ちる。
   *
   * **どちらの本も、直す前の世界でも「待ち」は必ず抜ける形にしてある** —
   * 落ちるのは `toEqual` の不一致であって、待ちのタイムアウトではない
   * （AGENTS.md「タイムアウトは歯があった証拠にならない」）。
   */
  it('終端を出した直後（後始末の前）に次の合図が届いても、枠で保持した合図は消えない', async () => {
    // 1ターン目（一件目の初回）だけ枠で失敗させ、以降は成功させる。
    const s = setup(undefined, createMemoryStores(), {
      resultFor: (turnIndex) =>
        turnIndex < 1 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    // 一件目の `error` を emit している最中に二件目を post する（上の doc）。
    let injected = false;
    const unsubscribe = s.clone.subscribe('conv-1', (event) => {
      if (event.type !== 'error' || injected) return;
      injected = true;
      s.clone.post(humanMessage('二件目'));
    });

    s.clone.post(humanMessage('一件目'));

    // **入力が2件になること自体は、直る前も後も起きる** — 直す前は
    // [一件目, 二件目]（一件目が `#forget` されて消え、二件目だけが走る）、
    // 直した後は [一件目, 一件目]（保持した一件目が先に配り直される）。
    // だからこの待ちはどちらの世界でも抜け、下の `toEqual` で落ちる。
    // `s.calls[0]` は `query()` が呼ばれるまで `undefined` である（`post` は同期で
    // 返るので、待ちの初回は必ずその前に走る）。**`?.` で受けること** — 素で
    // 読むと待ちの中で TypeError になり、「歯が無い」ではなく「テストが壊れた」で
    // 落ちる。
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 2, '2件目の入力が投げられる');
    // 直す前の壊れ方: `post()` がその場で `#usageBlocked` を降ろしていたので、
    // `#pump` の `finally` が読む時点では `null` ＝ `defer: false` になり、
    // **枠で失敗しただけの一件目が `#forget` される**（器からも消えるので
    // 再起動でも戻らない ＝ 人間の発言が黙って失われる）。
    //
    // **先頭2件だけを見る（`slice`）。** 待ちが抜けた時点で3件目が既に投げられて
    // いることがあり、配列まるごとの一致で見ると**直っているのに落ちる**
    // （実測でそうなった）。見たいのは「2件目に何が投げられたか」なので、
    // 直す前の世界との違い（`二件目` か `一件目` か）はこの先頭2件で決まる。
    expect(labelOrder(s.calls[0] as FakeCall).slice(0, 2)).toEqual(['一件目', '一件目']);

    // 保持した一件目が消えていない ＝ 両方に返る（二件目は一件目の後）。
    await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length === 2);
    expect(labelOrder(s.calls[0] as FakeCall)).toEqual(['一件目', '一件目', '二件目']);

    unsubscribe();
    await s.clone.stop();
  });

  it('短絡した合図の後始末の直前に3本目が届いても、2本目は迷子にならず FIFO を保つ', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultFor: (turnIndex) =>
        turnIndex < 2 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    s.clone.post(humanMessage('一件目')); // turn 0: 失敗 → 保持（terminal 1件目）
    await waitForTerminal(s.events);

    // 三件目を撃つのは**二件目の短絡の `error`**（terminal 3件目）である。
    // 一件目の再試行の失敗（terminal 2件目）ではない — 件数で名指しするので、
    // どの `error` に入ったかがホストの速さで変わらない。
    let injected = false;
    const unsubscribe = s.clone.subscribe('conv-1', (event) => {
      if (event.type !== 'error' || injected) return;
      if (s.events.filter(isTerminal).length < 3) return;
      injected = true;
      s.clone.post(humanMessage('三件目'));
    });

    s.clone.post(humanMessage('二件目')); // 一件目の再試行（turn 1: 失敗）＋二件目の短絡

    // **入力が4件になること自体は、直る前も後も起きる** — 直す前は
    // [一件目, 一件目, 一件目, 三件目]（二件目が `#deferred` に取り残されて
    // このプロセスでは二度と処理されない）、直した後は
    // [一件目, 一件目, 一件目, 二件目]。
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 4, '4件目の入力が投げられる');
    // **先頭4件だけを見る**（上の本と同じ理由。5件目が既に投げられていることが
    // あり、配列まるごとの一致では直っているのに落ちる）。
    expect(labelOrder(s.calls[0] as FakeCall).slice(0, 4)).toEqual([
      '一件目',
      '一件目',
      '一件目',
      '二件目',
    ]);

    // 三件目まで含めて FIFO（到着順）で全部に返る。
    await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length === 3);
    expect(labelOrder(s.calls[0] as FakeCall)).toEqual([
      '一件目',
      '一件目',
      '一件目',
      '二件目',
      '三件目',
    ]);

    unsubscribe();
    await s.clone.stop();
  });

  it('枠が閉じている間に2件が続けて届いても、配り直しは到着順のまま（待ち行列を追い越さない）', async () => {
    // 1ターン目（一件目の初回）だけ枠で失敗させる。
    const s = setup(undefined, createMemoryStores(), {
      resultFor: (turnIndex) =>
        turnIndex < 1 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    s.clone.post(humanMessage('一件目')); // turn 0: 失敗 → 保持
    await waitForTerminal(s.events);

    // **続けて2件 post する。** 1件目の `post` は待っている `#pump` へ直接渡り、
    // 2件目は待ち行列に並ぶ（`Inbox#push` の waiter 経路）。つまり解除の時点で
    // **待ち行列には既に別の合図が居る** — 保持していた分を `push`（末尾）で
    // 戻すと、あとから届いた三件目に追い越される。`Inbox#unshift`（先頭へ戻す）
    // でなければ到着順が崩れる、というのがこの本の見ている歯である。
    s.clone.post(humanMessage('二件目'));
    s.clone.post(humanMessage('三件目'));

    // **2件目に何が投げられるかで決まる。** 先頭へ戻していれば保持していた
    // 一件目の再試行、末尾へ積んでいれば追い越した三件目になる。**どちらの
    // 世界でも入力は2件以上になる**ので、この待ちはタイムアウトせず、下の
    // `toEqual` が落ちる（AGENTS.md「タイムアウトは歯があった証拠にならない」）。
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 2, '2件目の入力が投げられる');
    expect(labelOrder(s.calls[0] as FakeCall).slice(0, 2)).toEqual(['一件目', '一件目']);

    // 二件目と三件目は**1ターンにまとめて**読まれる（#123 のまとめ読み。連続する
    // 同じ会話の人間の発言なので `drainWhile` が両方取る）。保持していた一件目は
    // `#heldForUsage` で対象外なので、まとめられずに単独で先に読まれる。
    // ＝ ターンは「一件目(初回) → 一件目(再試行) → 二件目＋三件目」の3本。
    await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length === 2);
    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(labelOrder(s.calls[0] as FakeCall)).toEqual(['一件目', '一件目', '二件目']);
    // 3本目のターンに両方の本文が、到着順で載っている（`labelOrder` は最初に
    // 当たった1つを返すので、まとめられた側はここで別に見る）。
    const merged = inputs[2] ?? '';
    expect(merged).toContain('二件目');
    expect(merged).toContain('三件目');
    expect(merged.indexOf('二件目')).toBeLessThan(merged.indexOf('三件目'));

    await s.clone.stop();
  });

  /**
   * **解除を `#pump` へ移したことで新しく開いた口を塞いでいるのがこの本である。**
   *
   * 解除が `post()` に在ったあいだ、閉じた受信箱へ戻してしまう心配は無かった —
   * `post()` は先頭で `#stopped` を見て return するからである。`#pump` の先頭へ
   * 移すと、そのガードが効かない側へ出る: `stop()` は `#inbox.close()` を呼ぶが、
   * `for await` は待ち行列に残った分を吐き出しながら回り続けるので、**閉じた後に
   * 解除の地点へ来る**ことがありうる。`Inbox#unshift` は閉じた受信箱では投げ、
   * そこは `try` の外なので、投げれば受信箱のループごと死ぬ（`#pump` は `void`
   * で起こしてあるので unhandled rejection ＝ デーモンごと落ちうる。走行中の
   * マネージャーも巻き添えになる）。
   *
   * **この順序は `#query === null` でなければ作れない。** `stop()` は `#query` が
   * 在れば蒸留を `await` するので、その間に `#pump` が先頭へ到達して印を消費して
   * しまう。枠に当たった直後にセッションが終わる台本（`endSessionAfterTurn`）で
   * `#query` を null にすると、`stop()` は `await` を1つも通さずに `#inbox.close()`
   * まで進む。
   *
   * **落ち方について正直に言う。** ガードを外すとこの本は
   * 「unhandled rejection ＋ 待ちのタイムアウト」で落ちる。**アサーションの不一致
   * ではない**（AGENTS.md「タイムアウトは歯があった証拠にならない」）。それでも
   * 付ける理由は、unhandled rejection が汎用のタイムアウトとは違って**原因を
   * 名指しする**特定の信号だからである。
   */
  it('受信箱が閉じた後に解除の印が残っていても、受信箱のループを殺さない', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
      // 1本目のターンを出し終えたらセッションを終わらせる ＝ `#query` が null。
      endSessionAfterTurn: 0,
    });

    const first = humanMessage('一件目');
    s.clone.post(first);
    await waitForTerminal(s.events);
    // 保持されたこと（＝`#deferred` へ積み終わったこと）を器の側で待つ。
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === first.id);
    }, '一件目が未読として保持される');
    const terminalsBefore = s.events.filter(isTerminal).length;

    // 印を立てて（`post`）、`#pump` が先頭へ戻る前に閉じる（`stop`）。
    const second = humanMessage('二件目');
    s.clone.post(second);
    await s.clone.stop();

    // **解除しなかったほうの被害は無い。** 二件目には「枠で保持した」終端が届き、
    await s.waitForEvents((events) => events.filter(isTerminal).length === terminalsBefore + 1);
    // どちらの合図も器に未読のまま残る（次の起動で `#restoreUnread` が拾い直す。
    // この機構が生死をまたげる理由がそれである）。
    const pending = await s.stores.inbox.claimPending();
    expect(pending.map((p) => p.event.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('org_policy では待たない（保持せず、従来どおり失敗として消える）', async () => {
    // SDK のプレフィックス集合そのもの（自前の文言を作らない）。
    const orgPolicyMessage = 'This service is disabled for your org by admin decision.';
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: orgPolicyMessage,
    });

    const event = humanMessage('やあ');
    s.clone.post(event);
    await waitForTerminal(s.events);

    expect(s.events.filter(isTerminal).map((e) => e.type)).toEqual(['error']);
    // 「待たない」＝ usage_limited を出さない。
    expect(s.events.some((e) => e.type === 'usage_limited')).toBe(false);

    // 「保持しない」＝ 従来どおり forget されて器から消える。
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return !pending.some((p) => p.event.id === event.id);
    }, 'org_policy の合図は保持されず forget される');

    await s.clone.stop();
  });

  it('rate_limit_event の status: rejected でも枠が閉じたと判定する', async () => {
    // `result` の文言には上限のプレフィックスを一切含めない。届く usage_limited
    // が rate_limit_event 経路だけで説明できることを確かめるため。
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: '（結果なし。rate_limit_event だけが上限の理由を運ぶ）',
      rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour' }),
    });

    s.clone.post(humanMessage('一件目'));
    await waitForTerminal(s.events);
    expect(s.events.some((e) => e.type === 'usage_limited')).toBe(true);

    s.clone.post(humanMessage('二件目'));
    // 1本目の再試行（同じ rate_limit_event が毎ターン付くので再び失敗）＋
    // 2本目の短絡で terminal は合計3件になる。何を待っているか・経緯は
    // 上（`枠が閉じている間に届いた2本目は…`）と同じ（`s.waitForEvents` の
    // doc 参照）。
    await s.waitForEvents((events) => events.filter(isTerminal).length === 3);

    // 2本目はターンを回さない ＝ rate_limit_event 経路だけでも保持が効いている。
    expect((s.calls[0] as FakeCall).inputs.some((text) => text.includes('二件目'))).toBe(false);

    await s.clone.stop();
  });

  it('rate_limit_event で status: rejected が来ても、同じターンの result が成功したら保持されない', async () => {
    // `rate_limit_info` の `status` は枠1つぶんの状態でしかない
    // （`rateLimitFactsSchema` — `status` とは別に `overageStatus` /
    // `usingOverage` / `overageResetsAt` がある）。`five_hour` が `rejected`
    // でも課金枠（overage）に落ちてターンは成功する組み合わせが構造上あり、
    // `usage-limits.ts` の `usageTransitionOf` は `entered_overage` として
    // 名前まで付けている通常の遷移である。この組み合わせで、答えが返って
    // 終わった合図まで保持・再送されない（＝成功した仕事の二重実行にならない）
    // ことを確かめる。
    const s = setup(undefined, createMemoryStores(), {
      rateLimitEventAt: (turnIndex) =>
        turnIndex === 0
          ? { status: 'rejected', rateLimitType: 'five_hour', isUsingOverage: true }
          : undefined,
    });

    const event = humanMessage('やあ');
    s.clone.post(event);
    await waitForTerminal(s.events);
    // 検知そのものは起きる（usage_limited は届く）が、ターンは成功して done。
    expect(s.events.filter(isTerminal).map((e) => e.type)).toEqual(['done']);

    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return !pending.some((p) => p.event.id === event.id);
    }, '成功したターンの合図は保持されず forget される');

    await s.clone.stop();
  });

  it('（追加確認）system/notification の上限文言でも枠が閉じたと判定する', async () => {
    // 検知3経路の最後の1つ。必須の6本には無いが、`#dispatch` の `case 'system'`
    // に足した分岐を素通りさせないためにここで直接確かめる。
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: '（結果なし。system 通知だけが上限の理由を運ぶ）',
      systemNoticeAt: () => ({ subtype: 'notification', text: spendLimitMessage }),
    });

    s.clone.post(humanMessage('一件目'));
    await waitForTerminal(s.events);
    expect(s.events.some((e) => e.type === 'usage_limited')).toBe(true);

    s.clone.post(humanMessage('二件目'));
    // 何を待っているか・経緯は上（`枠が閉じている間に届いた2本目は…`）と同じ
    // （`s.waitForEvents` の doc 参照）。
    await s.waitForEvents((events) => events.filter(isTerminal).length === 3);
    expect((s.calls[0] as FakeCall).inputs.some((text) => text.includes('二件目'))).toBe(false);

    await s.clone.stop();
  });

  it('同じ transition の通知が2回届いても、日誌のその行は1件しか増えない', async () => {
    // `transition` は待たない（まだ動く）分類なので、ターンは毎回 done で
    // 終わり、`system` の通知は毎ターン繰り返し届く（`usage-limits.ts` の
    // `usageTransitionOf` の doc「毎ターン届く同じ事実で受信箱を埋めないこと」
    // と同じ場面）。`#usageNotices` で畳んでいなければ、同じ文言の行が
    // ターンの数だけ日誌に増える。
    const transitionMessage = "You're now using extra usage until your limit resets.";
    const s = setup(undefined, createMemoryStores(), {
      systemNoticeAt: () => ({ subtype: 'notification', text: transitionMessage }),
    });

    s.clone.post(humanMessage('一件目'));
    await waitForDone(s.events);

    s.clone.post(humanMessage('二件目'));
    // 何を待っているか・経緯は上（`枠が閉じている間に届いた2本目は…`）と同じ
    // （`s.waitForEvents` の doc 参照）。
    await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length === 2);

    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    const matching = exchanges.filter((entry) => entry.text.includes(transitionMessage));
    expect(matching).toHaveLength(1);

    await s.clone.stop();
  });

  /**
   * ## 保持（枠）の間、配り直しの印（`#redelivered`）は消えない ── 解除で戻ってきても断り書きは付く
   *
   * **なぜこの歯が要るか。** Issue https://github.com/takecchi/alteroid/issues/351 は
   * 「枠解除ブロック（この `describe` が検証している `#pump` 先頭の解除処理）が
   * `#redelivered` / `#redeliveredClosed` の `Map` 2つを触らないので、解除で戻って
   * きた配り直しの合図は断り書き無しの全文で届く」と書いていた。**これは逆である。**
   *
   * - `#redelivered` を**消すのは `#forget` の1箇所だけ**（`clone.ts` の `#forget`）
   * - 枠で保持する枝（`#settleInboxEvent` の `else if (defer)`）は **`#forget` を
   *   呼ばない**
   * - ⟹ **保持している間、印は消えない ⟹ 解除で戻ってきた合図にも断り書きは付く**
   *
   * **そしてこれは偶然ではなく、意図して選ばれている。** `#settleInboxEvent` の
   * 当該枝に逐語でこう書いてある（`grep -Fn -- '保持したことを覚えておく' clone.ts`）:
   *
   * > 保持したことを覚えておく（`#heldForUsage` の doc）。**印を消すのは
   * > `#forget` と同じ側である** ── 保持している間に消すと、解除で戻ってきた
   * > 合図が「初めて届いたもの」に見えてまとめ読みの対象へ戻る。
   *
   * Issue #351 は 2026-08-27 に `not planned` で閉じた（前提が成り立たなかった
   * ため）。**⟹ 閉じたことで、この振る舞いを守るものが doc のコメントだけになった。
   * ⟹ だからここに歯を入れる。**
   *
   * **筋書き**: (1) 器（`stores.inbox`）に未読の合図を直接残し、前のプロセスが
   * 死んだ状況を作る → クローンを起こして `#restoreUnread` に拾わせる
   * （＝ `#redelivered` に印が立つ）。(2) 枠を閉じて、その合図を保持させる。
   * (3) 枠を解除して、戻ってきた合図が実際にターンへ載るところまで進める。
   * (4) そのターンの入力に配り直しの断り書き（「これは配り直しである」/
   * 「回目の配達」）が載っていることを、SDK へ実際に渡った入力（`FakeCall.inputs`）
   * で見る。**`#redelivered` の Map を直接覗かない** ── private field を覗く形は
   * 実装を変えた瞬間に意味を失うので、外から見える振る舞い（ターンへ渡る入力）
   * で固定する。
   */
  it('枠で保持された合図が解除で戻ってきても、配り直しの断り書きは付いたまま届く（#351 は逆を主張していたが、印を消すのは #forget だけである）', async () => {
    const stores = createMemoryStores();
    const held = humanMessage('一件目');
    // 前のプロセスが死んだ状況（未読のまま器に残った合図）を直接作る。
    await stores.inbox.put(held, new Date(0).toISOString());

    const s = setup(undefined, stores, {
      // turn 0（#restoreUnread が拾い直した一件目の初回試行）だけ枠で失敗させる。
      // それ以降（解除後の再試行・二件目）は成功させる。
      resultFor: (turnIndex) =>
        turnIndex < 1 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    // #restoreUnread が起動直後に一件目を拾い直し、#redelivered に印を立てて配る
    // （このテストは一件目について `post()` を1度も呼んでいない）。枠で失敗する
    // ので保持される。
    await waitForTerminal(s.events);
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === held.id);
    }, '拾い直した一件目が枠で保持される');

    // 新しい合図（二件目）を届けて、枠の解除を試させる。
    s.clone.post(humanMessage('二件目'));
    await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length === 2);

    const inputs = (s.calls[0] as FakeCall).inputs;
    // turn 0: #restoreUnread からの初回配達。配り直しの断り書きが付く（前提）。
    expect(inputs[0] ?? '').toContain('一件目');
    expect(inputs[0] ?? '').toContain('これは配り直しである');
    expect(inputs[0] ?? '').toContain('回目の配達');

    // turn 1: 枠の解除で戻ってきた同じ一件目。**ここが #351 の逆を確かめる本体**
    // ―― 保持している間 #forget を呼んでいないので #redelivered は消えておらず、
    // 解除後の再試行にも断り書きが付く。
    expect(inputs[1] ?? '').toContain('一件目');
    expect(inputs[1] ?? '').toContain('これは配り直しである');
    expect(inputs[1] ?? '').toContain('回目の配達');

    // turn 2: 二件目自身は #restoreUnread を経由していないので、断り書きは付かない
    // （対照 ―― どんな入力にも常に付くわけではないことを見る）。
    expect(inputs[2] ?? '').toContain('二件目');
    expect(inputs[2] ?? '').not.toContain('これは配り直しである');

    await s.clone.stop();
  });
});

/**
 * `#settleInboxEvent` に足した「枠で保持している間、中身を持たない合図
 * （`isTick`）で在庫を作らない」の3本（`clone.ts` の `#foldsIntoHeldTick` /
 * `#noteFoldedTick` / `#deferred` / `isTick` / `isSameTick`）。
 *
 * 上の「枠が閉じたら保持して次の合図で試す」ブロックが確かめているのは FIFO・
 * 再試行そのものであり、ここで確かめるのは**その保持の中身が増え続けないこと**
 * （歯1・2）と、**畳んでも再試行の回数そのものは1回も減らないこと**（歯3）で
 * ある。3本とも `self_initiative` / `timer` 起点のターンは `ChatStreamEvent` を
 * 1件も出さない（`#conversationOf` が `human_message` 以外に `null` を返し、
 * `#emit` が `null` で即 return する）ので、`waitForTerminal` はここでは使えない。
 *
 * **歯1 の同期は「tick 自身の跡」を待たない。** かつては「畳んだ」旨の
 * 日誌行が出るのを待っていたが、畳み込みを殺す変異（`#foldsIntoHeldTick` を
 * `return false` にする）でも、畳み込みを `post()` 側へ動かす変異（畳まれた
 * tick が受信箱へ一切積まれなくなる）でも、その日誌行は永久に出ない —
 * どちらも**アサーション不一致ではなくタイムアウトで落ちる**形になってしまい、
 * 「タイムアウトは歯があった証拠にならない」に反する。代わりに `postTickThenPacer`
 * （下）で「tick を post した直後に、畳み込みの対象外である人間の発言
 * （pacer）を post し、その pacer 自身の終端が来るまで待つ」形にする。
 * 受信箱は直列 FIFO で、`#pump` の `for await` は1件の後始末
 * （`#settleInboxEvent` を含む）が完全に終わってから次を取り出すので、pacer
 * 自身の終端が観測できた時点で、直前に積んだ tick の後始末は必ず完了して
 * いる。**tick が畳まれたか保持されたかに関わらず**pacer は必ず受信箱を
 * 通って終端まで届くので、この待ちはどの変異が当たっていても必ず抜ける。
 * 歯2はこの変更の対象外（`calls[0].inputs.length` を直接見る既存の形のまま）。
 *
 * **歯3 は `postTickThenPacer` を使わない（過去に使っていたが、それ自体が
 * 歯3を測れなくしていたため外した）。** 歯3が測りたいのは「tick が**単独で**
 * 解除を1回起こすこと」であり、pacer（人間の発言）は畳み込みの対象外なので
 * それ自身の `post()` が必ず解除を1回起こしてしまう。畳み込みを `post()` 側へ
 * 戻す変異（tick が受信箱へ一切積まれなくなる）が当たっても、pacer 自身の
 * 解除が測定対象の代わりに数を稼いでしまい、期待する回数と実際の回数が
 * 偶然一致して歯が落ちない（実測でこの変異は歯3を生き残らせた）。歯3では
 * 代わりに `releaseAttemptCount`（日誌の「枠の解除を試す」行数）だけを見て
 * 同期する — 詳しい理由は歯3のテスト本体のコメントを見よ。
 *
 * **⚠️ この3本は `humanPriority: false`（人間優先を切った状態）に固定してある。**
 * `postTickThenPacer`（pacer 同期）も歯3の `releaseAttemptCount` 直接待ちも、
 * 「tick を post した直後に別の合図を post すれば、待ち行列上でも tick が先・
 * 後続が後という順序のまま処理される」という FIFO の歩調取りを前提にしている。
 * 人間優先（既定で有効。`CLONE_HUMAN_PRIORITY_ENV_KEY`）が入ると、pacer 自身が
 * 人間の発言なので待ち行列の人間の最後尾へ割り込みうる — 前提が崩れる（実測:
 * `humanPriority` を既定のまま歯1を走らせると `selfInitiatives` が1件のはずが
 * 2件になって落ちる）。**これらが測っているのは「FIFO の下での畳み込み」であって、
 * 「人間優先が有効なままでの畳み込み」ではない。人間優先が有効なままでの畳み込みは
 * 別の歯（`人間優先が有効なままでも、保持中の tick は畳まれて在庫が増えない`）が
 * 測る。**
 */
describe('クローン — 枠で保持している間、中身を持たない合図で在庫を作らない', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  /**
   * `humanPriority: false` に固定したセットアップ。**このブロックの3本
   * （歯1・2・3）専用。** 上のブロック doc の「⚠️」の理由により、FIFO の
   * 歩調取り（`postTickThenPacer` / `releaseAttemptCount` 直接待ち）はこの前提
   * が崩れると測れなくなる。`setup()`（ファイル冒頭）は `env` を渡す口しか
   * 持たないので、ここでは `setupWithHumanPriority`（ファイル末尾）と同じ形で
   * `createClone` を直接呼び、`CloneOptions.humanPriority` を直渡しする。
   */
  function setupFixedFifo(
    reply?: (input: string) => string,
    stores: Stores = createMemoryStores(),
    sdkOptions: Parameters<typeof fakeSdk>[1] = {},
  ): Setup {
    const { fn, calls } = fakeSdk(reply, sdkOptions);
    const clone = createClone({
      stores,
      queryFn: fn,
      env: {},
      humanPriority: false,
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events, waitForEvents } = wireEvents(clone, 'conv-1');
    return { clone, stores, calls, events, waitForEvents };
  }

  /** 「畳んだ」旨の日誌の行数。 */
  async function foldedNoteCount(s: Setup): Promise<number> {
    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    return exchanges.filter((entry) => entry.text.includes('畳んだ')).length;
  }

  /**
   * 解除の試行が `expected` 回に達するまで待つ。**当初は歯3専用だったが、
   * 「人間優先が有効なままでも、保持中の tick は畳まれて在庫が増えない」
   * （後述）も同じ待ちを使う。**
   *
   * ## この待ちが言えないこと（計器の側に貼る）
   *
   * **「起きなかった（実装の退行）」と「器が遅すぎた（飽和）」を区別できない。**
   * どちらも同じタイムアウトで出る。**赤を見たら、実装の退行を探しに行く前に
   * 器の負荷を疑うこと** — 他の歯（歯1・歯2）はアサーションの不一致で数十 ms
   * のうちに落ちるので、**そちらが緑のままここだけが数秒かけて落ちているなら、
   * 退行の可能性が高い。逆に全体が遅いなら飽和を先に疑う。**
   *
   * この器は混むと vitest の fork pool ごと落ちることがある（`AGENTS.md`
   * 「自分が走っている器」）ので、**待ちは負荷に耐える側へ倒してある**
   * （共有の `waitFor` の 3 秒ではなく下の予算）。それでも足りない可能性は
   * 消せないので、消せないことを上に書いてある。
   *
   * `it()` 側にも明示のタイムアウトを付けてあること。**vitest の既定は 5 秒**で、
   * 付けないとこの待ちより先にそちらが当たり、**理由の書かれていない汎用の
   * タイムアウト**に化ける（＝ここに書いた断り書きが読まれない）。
   */
  const RELEASE_WAIT_BUDGET_MS = 15_000;
  async function waitForReleaseAttempts(s: Setup, expected: number, what: string): Promise<void> {
    const started = Date.now();
    for (;;) {
      const seen = await releaseAttemptCount(s);
      if (seen === expected) return;
      if (Date.now() - started > RELEASE_WAIT_BUDGET_MS) {
        throw new Error(
          `${what}: 解除の試行が ${expected} 回になるのを ${RELEASE_WAIT_BUDGET_MS}ms 待ったが ${seen} 回のままだった。` +
            'この歯は「起きなかった（退行）」と「器が遅すぎた（飽和）」を区別できない。' +
            '他の歯（歯1・歯2）が緑でここだけ落ちているなら退行を、全体が遅いなら器の飽和を先に疑うこと。',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /**
   * 解除の試行が `baseline` より増えるまで待つ。**目標を固定値にできない歯用**
   * （「人間優先が有効なままでも、保持中の tick は畳まれて在庫が増えない」）。
   * 人間の発言も枠の解除を誘発しうる（`post()` の `#releaseRequested` は起点の
   * 種類を問わない）ので、そのぶんの回数を歯の側で先読みできない。**予算・
   * 断り書きの理由は `waitForReleaseAttempts` と同じなのでそちらを見よ。**
   */
  async function waitForReleaseAttemptsAbove(
    s: Setup,
    baseline: number,
    what: string,
  ): Promise<void> {
    const started = Date.now();
    for (;;) {
      const seen = await releaseAttemptCount(s);
      if (seen > baseline) return;
      if (Date.now() - started > RELEASE_WAIT_BUDGET_MS) {
        throw new Error(
          `${what}: 解除の試行が ${baseline} 回より増えるのを ${RELEASE_WAIT_BUDGET_MS}ms 待ったが ${seen} 回のままだった。` +
            'この歯は「起きなかった（退行）」と「器が遅すぎた（飽和）」を区別できない。' +
            '他の歯が緑でここだけ落ちているなら退行を、全体が遅いなら器の飽和を先に疑うこと。',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** 「枠の解除を試す」旨の日誌の行数（＝解除を試した回数そのもの）。 */
  async function releaseAttemptCount(s: Setup): Promise<number> {
    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    return exchanges.filter((entry) => entry.text.includes('枠の解除を試す')).length;
  }

  /**
   * `stores.inbox.put` の呼び出し回数を合図 id ごとに数える薄いラッパー。
   *
   * `#remember`（`clone.ts`）は `post()` の中で「受理した時点」に呼ばれ、
   * `#foldsIntoHeldTick` の判定より**前**にある。だから畳まれる側の tick でも、
   * 畳み込みが `#settleInboxEvent`（受信箱から取り出した後）で起きている限り
   * 必ず一度は `put` が呼ばれる。**畳み込みを `post()` 側（受信箱へ積む前）へ
   * 動かす変異が当たると、畳まれる側の tick はここが 0 のまま残る** — 歯1 の
   * `foldedNoteCount`（日誌の跡）とは別の観測点（器への書き出しそのもの）で、
   * 同じ「畳み込みが正しい場所で起きているか」を確かめる。
   */
  function withInboxPutSpy(stores: Stores): {
    stores: Stores;
    putCallCountFor: (id: string) => number;
  } {
    const counts = new Map<string, number>();
    const original = stores.inbox;
    const spiedInbox: Stores['inbox'] = {
      ...original,
      async put(event, at) {
        counts.set(event.id, (counts.get(event.id) ?? 0) + 1);
        return original.put(event, at);
      },
    };
    return {
      stores: { ...stores, inbox: spiedInbox },
      putCallCountFor: (id) => counts.get(id) ?? 0,
    };
  }

  /**
   * ある conversation の終端（`done` か `error`）が来るまで待つ。`s.events`
   * （`wireEvents`）は `conv-1` にしか張っていないので、pacer 専用の
   * conversation で終端を見るにはここで別に購読を張る必要がある。
   */
  function waitForTerminalOn(clone: CloneHost, conversationId: string): Promise<void> {
    return new Promise((resolve) => {
      const unsubscribe = clone.subscribe(conversationId, (event) => {
        if (event.type === 'done' || event.type === 'error') {
          unsubscribe();
          resolve();
        }
      });
    });
  }

  /**
   * tick を1件 post した直後に、専用の conversation を持つ人間の発言
   * （pacer）を1件 post し、その pacer 自身の終端（`done`/`error`）が来る
   * まで待つ。
   *
   * **同期の根拠はファイル冒頭の doc comment を参照。** ここでは繰り返さない
   * — 要は「pacer は畳み込みの対象外なので必ず受信箱を通り、直列 FIFO の
   * 性質上、pacer の終端が来た時点で直前の tick の後始末は必ず終わっている」
   * という一点である。**tick 自身の跡（畳んだ日誌・在庫の中身）はここでは
   * 一切見ない。**
   *
   * pacer の conversation id は呼び出しごとに変える — 起点や他の pacer の
   * 終端と混ざらないようにするため（`conv-1` を共有すると「何件目の終端か」
   * を数える形になり、脆くなる）。
   */
  async function postTickThenPacer(
    clone: CloneHost,
    tick: InboxEvent,
    pacerConversationId: string,
  ): Promise<void> {
    const terminal = waitForTerminalOn(clone, pacerConversationId);
    clone.post(tick);
    clone.post(humanMessage(`pacer(${pacerConversationId})`, pacerConversationId));
    await terminal;
  }

  // **この歯は2つの要求を同時に見ている。** (1) 在庫が増えないこと
  // （`selfInitiatives` が1件のまま — M1「畳み込みを殺す」・M2「何でも畳む」が
  // 壊す）と、(2) 畳んだ跡が日誌に残ること（`foldedNoteCount` — M3「畳み込みを
  // `post()` 側へ戻す」が壊す。`post()` 側で畳むと `#noteFoldedTick` を通らない）。
  // **だから3つの変異全部でこの歯が落ちる。** どちらも本物の要求なのでアサー
  // ションは1つも削らない — 「なぜ全部の変異で落ちるのか」を次に読む者が
  // 疑わずに済むように、ここへ明記しておく。
  it('歯1: 発意 tick を続けて送っても、保持する在庫は1件のまま増えない', async () => {
    const s = setupFixedFifo(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    const origin = humanMessage('起点');
    s.clone.post(origin);
    await waitForTerminal(s.events);
    // 既存テスト（「枠に当たった合図は forget されない」）と同じ待ち方 — 起点が
    // 未読として保持し終わるまで待つ。
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === origin.id);
    }, '起点が未読として保持される');

    // 1本目: まだ何も保持していないので畳めない（`#deferred` に self_initiative
    // が無い）。実際にモデルへ渡る「起点」の再試行を1回誘発して、初めて
    // `#deferred` に self_initiative が1件乗る。同期は tick 自身の跡ではなく
    // pacer（人間の発言）の終端を待つ（`postTickThenPacer` の doc）。
    await postTickThenPacer(
      s.clone,
      { type: 'self_initiative', id: 'evt-si-1', at: new Date().toISOString(), reason: '1本目' },
      'conv-pacer-1',
    );

    // 2本目: 既に保持している self_initiative（1本目）へ畳まれる（はず）。
    // 畳まれた分は `#forget` されて器の未読からも消える。
    await postTickThenPacer(
      s.clone,
      { type: 'self_initiative', id: 'evt-si-2', at: new Date().toISOString(), reason: '2本目' },
      'conv-pacer-2',
    );

    // 3本目も同様に畳まれる（はず）。
    await postTickThenPacer(
      s.clone,
      { type: 'self_initiative', id: 'evt-si-3', at: new Date().toISOString(), reason: '3本目' },
      'conv-pacer-3',
    );

    const pending = await s.stores.inbox.claimPending();
    const selfInitiatives = pending.filter((p) => p.event.type === 'self_initiative');
    // 在庫は1件だけ（3回届いたのに増えていない）。
    //
    // **「1件」が言えるのは、1件ずつ順番に送った場合に限る。** 極端に詰めて送ると
    // 2件になりうる — 畳み込みの相手は `#deferred` に**入った後**の合図なので、
    // 受信箱から取り出されてから `#settleInboxEvent` が積むまでの間に次が届くと、
    // その1件は畳む相手を見つけられない（`#pump` の「`isTick` の畳み込みは
    // 『処理中の1件＋待ち行列の1件』を残す形で効いている」と同じ形の下限である）。
    // **実世界の tick は既定で55分間隔**（`apps/daemon/src/schedule.ts` の
    // `DEFAULT_INITIATIVE_EVERY_MINUTES`）なのでこの形で書いてある。
    //
    // **だから「2件になった」を回帰と読まないこと。** 詰めて送れば起きる正常な
    // 下限であって、在庫が青天井に増える（直す前は3回で3件だった）のとは別物である。
    expect(selfInitiatives).toHaveLength(1);
    // 動いていないのは**先に保持していた側**（1本目）である。畳むのは新しく
    // 届いた方だけで、既に保持している側は触らない。
    expect(selfInitiatives[0]?.event.id).toBe('evt-si-1');
    // 畳んだ跡が2件、日誌に残る（2本目・3本目のぶん）。
    expect(await foldedNoteCount(s)).toBe(2);
    // 起点（人間の発言）は畳み込みの対象外なので、未読のまま残っている。
    expect(pending.some((p) => p.event.id === origin.id)).toBe(true);

    await s.clone.stop();
  });

  it('歯2: 中身を持つ合図・別の日のタイマーは畳まれず、枠が開けば到着順に処理される', async () => {
    // 枠を「途中までは閉じたまま、合図で明示的に開けるまでは開かない」形にする
    // ための可変フラグ。再試行が何回起きるかを数えずに済ませるための口
    // （`resultFor` は毎ターン呼ばれるので、フラグを見るだけで済む）。
    let releaseGateOpen = false;
    const s = setupFixedFifo(undefined, createMemoryStores(), {
      resultFor: () =>
        releaseGateOpen
          ? undefined
          : { subtype: 'error_during_execution', text: spendLimitMessage },
    });

    const origin = humanMessage('起点');
    s.clone.post(origin);
    await waitForTerminal(s.events);
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === origin.id);
    }, '起点が未読として保持される');

    // **畳まれてはいけない**もの4種。1件ずつ post し、前の分が誘発した「起点」の
    // 再試行が実際に投げられたことを待ってから次を送る。
    const second = humanMessage('二件目');
    s.clone.post(second);
    await waitFor(async () => (s.calls[0]?.inputs.length ?? 0) >= 2, '二件目が誘発した再試行');

    const manager = {
      type: 'manager_message' as const,
      id: 'evt-manager',
      at: new Date().toISOString(),
      managerId: 'mgr-1',
      kind: 'report' as const,
      text: 'マネージャーからの一件（目印テキスト）',
    };
    s.clone.post(manager);
    await waitFor(
      async () => (s.calls[0]?.inputs.length ?? 0) >= 3,
      'manager_message が誘発した再試行',
    );

    const timerA = {
      type: 'timer' as const,
      id: 'evt-timer-a',
      at: new Date().toISOString(),
      kind: 'custom-check',
      target: '2026-08-20',
    };
    s.clone.post(timerA);
    await waitFor(
      async () => (s.calls[0]?.inputs.length ?? 0) >= 4,
      'timer(08-20) が誘発した再試行',
    );

    // kind / cause は同じで target だけが違う ＝ 別の日 ＝ 別の仕事（`isSameTick`
    // の doc）なので、timerA が保持中でも畳まれてはいけない。
    const timerB = {
      type: 'timer' as const,
      id: 'evt-timer-b',
      at: new Date().toISOString(),
      kind: 'custom-check',
      target: '2026-08-21',
    };
    s.clone.post(timerB);
    await waitFor(
      async () => (s.calls[0]?.inputs.length ?? 0) >= 5,
      'timer(08-21) が誘発した再試行',
    );

    // ここまでの5件（起点＋畳まれてはいけない4件）は、すべて未読として保持
    // されている。1件も畳まれていない。
    const heldIds = [origin.id, second.id, manager.id, timerA.id, timerB.id];
    const pendingBeforeOpen = await s.stores.inbox.claimPending();
    for (const id of heldIds) {
      expect(pendingBeforeOpen.some((p) => p.event.id === id)).toBe(true);
    }
    expect(await foldedNoteCount(s)).toBe(0);

    // 枠を開けて、続きの合図（トリガー）を送る。これで保持していた分から順に
    // 配り直され、実際に成功して処理される。
    releaseGateOpen = true;
    const trigger = humanMessage('トリガー');
    s.clone.post(trigger);
    // 起点・二件目・トリガーの3件だけが人間の発言（chat の宛先を持つ）なので、
    // `done` は3件。manager_message / timer は宛先が無い内部ターンなので
    // `ChatStreamEvent` を出さない（このブロックの doc）。
    await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length === 3);

    // 到着順のまま処理されたことを、`calls[0].inputs` に載った本文の出現順で
    // 確かめる（`labelOrder` と同じ考え方。ここは型が混ざるので専用の目印で見る）。
    //
    // **単なる部分一致では見られない。** `#recentDigest`（tick 系のプロンプトに
    // 載る「引き受けたまま終わっていない仕事」一覧）は、その時点で台帳に載って
    // いる全件を列挙する。`post()` は同期でその場で台帳へ載せる（`#commit` の
    // doc）ので、**まだ自分の番が来ていない合図でも、後から届いた分の digest には
    // 先に載る**（実測: `トリガー` は一覧の最後に post するが、その digest 一覧
    // 自体は timerA/timerB の番でもう出現していた）。だから「その合図**自身**の
    // ターン本文」に固有の並び（`commitmentNoticeFor` が本文の直前に必ず挟む
    // `\n\n---\n` の直後）で狙う — digest の列挙側にはこの並びが出ない
    // （`- evt-x（...）\n  本文` という別の形である）。
    const inputs = (s.calls[0] as FakeCall).inputs;
    const firstIndexOf = (marker: string) => inputs.findIndex((text) => text.includes(marker));
    const order = {
      二件目: firstIndexOf('\n\n---\n二件目'),
      manager: firstIndexOf('（報告）\n\nマネージャーからの一件（目印テキスト）'),
      timerA: firstIndexOf('対象: 2026-08-20'),
      timerB: firstIndexOf('対象: 2026-08-21'),
      トリガー: firstIndexOf('\n\n---\nトリガー'),
    };
    for (const [label, index] of Object.entries(order)) {
      expect(index, `${label} が calls[0].inputs に見つからない`).toBeGreaterThanOrEqual(0);
    }
    expect(order.二件目).toBeLessThan(order.manager);
    expect(order.manager).toBeLessThan(order.timerA);
    expect(order.timerA).toBeLessThan(order.timerB);
    expect(order.timerB).toBeLessThan(order.トリガー);

    await s.clone.stop();
  });

  /**
   * ## 歯3 が守っているもの
   *
   * `#foldsIntoHeldTick` による畳み込みを `post()` 側（受信箱へ積む前）に移すと、
   * 畳まれた tick は受信箱へ何も積まない ＝ `#pump` の `for await` が次の要素を
   * 受け取れず、`#releaseRequested` の印を見に来る機会そのものが無くなる。
   * tick（`self_initiative` / `timer`）は「枠が開いたかを試す」ための**唯一の
   * 定期的な契機**なので、そうなった瞬間、枠が実際には開いているのに誰も
   * 気づかず再試行が静かに止まる — 費用は増えないが、仕事も二度と進まない。
   *
   * 実装（`clone.ts` の `#settleInboxEvent` 内）はこれを避け、畳み込みを
   * **受信箱から取り出した後**（＝解除の印は必ず処理済み）に置いている。だから
   * 「畳まれた」こと自体は歯1で確かめた在庫の話とは別に、**畳まれてもなお
   * 解除の試行そのものは1回も減っていない**ことを、ここで別に確かめる。
   *
   * 見るのは2つ — (1) 実際にモデルへ渡った回数（`calls[0].inputs`）、
   * (2) 日誌の「枠の解除を試す」行数（＝解除を試した回数そのもの、畳まれた
   * 分も含めて減っていないか）。この歯は「畳んだ跡」（`foldedNoteCount`）を
   * 1つも見ない — 見るのは解除の回数と実際の再試行回数だけである（畳んだ跡の
   * 記録は歯1の役割）。
   *
   * **ここでは `postTickThenPacer`（pacer 同期）を使わない。過去に使っていて、
   * それ自体がこの歯を測れなくしていたと判明したため外した。** 測りたいのは
   * 「tick が**単独で**解除を1回起こすこと」である。`#releaseRequested` は
   * 真偽値であってカウンタではない（`post()` が立てるのは印だけで、何回届いた
   * かは覚えない）。pacer（人間の発言）は畳み込みの対象外なので、pacer 自身の
   * `post()` も枠が閉じていれば必ず解除の印を立てる。つまり:
   *
   * - 正しい実装: tick が受信箱を通って解除の印を立てる → 解除1回
   * - 畳み込みを `post()` 側へ戻す変異: tick は畳まれて受信箱へ一切積まれず
   *   解除の印を立てない。**しかし直後の pacer が同じ印を立ててしまい**、
   *   結局どちらも解除1回になる — **回数が一致してしまい、歯は落ちない**
   *   （実測: この形の歯3はこの変異を生き延びた）。
   *
   * だから同期には、解除を起こしうる別の合図（pacer を含む）を一切混ぜない。
   * 代わりに tick を1件ずつ post し、その都度 `releaseAttemptCount` が
   * 1つずつ増えるのを直接待つ。
   */
  it('歯3: 発意 tick を畳んでも、枠が開いたかを試した回数は3回のまま減らない', async () => {
    const { stores, putCallCountFor } = withInboxPutSpy(createMemoryStores());
    const s = setupFixedFifo(undefined, stores, {
      resultSubtype: 'error_during_execution',
      resultText: spendLimitMessage,
    });

    const origin = humanMessage('起点');
    s.clone.post(origin);
    await waitForTerminal(s.events);
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === origin.id);
    }, '起点が未読として保持される');

    // 1件目の tick。この時点で `#deferred` に self_initiative は無いので
    // 畳まれる相手が居ない。届いたこと自体が `#releaseRequested` を立て、
    // `#pump` が次にこれを取り出した時点で解除を1回試す（保持していた起点を
    // 配り直し、その再試行がまた枠に当たって保持し直す）。
    s.clone.post({
      type: 'self_initiative',
      id: 'evt-si-1',
      at: new Date().toISOString(),
      reason: '1本目',
    });
    await waitForReleaseAttempts(s, 1, '1件目の tick');

    // 2件目の tick。ここでは既に `#deferred` に1件目（self_initiative）が
    // 保持されているので `#foldsIntoHeldTick` が真になり、この合図自体は
    // `#settleInboxEvent` で畳まれて捨てられる（在庫が増えないことは歯1の
    // 役割）。**畳み込みは受信箱から取り出した後で起きるので、届いた事実は
    // 必ず一度受信箱を通り、`#releaseRequested` を立てる。だから畳まれても
    // 解除の試行そのものは1回も減らない** — これがこの歯の本体である。
    s.clone.post({
      type: 'self_initiative',
      id: 'evt-si-2',
      at: new Date().toISOString(),
      reason: '2本目',
    });
    // **この待ちが歯の本体である。**
    //
    // 退行する（畳み込みを `post()` 側へ戻す＝上の doc の M3）と、この2件目の
    // tick は `post()` の時点で捨てられ、受信箱へ一切積まれない。積まれなければ
    // `#releaseRequested` を立てる機会そのものが無く、解除は起きない ＝ この
    // 待ちはタイムアウトで抜ける。
    //
    // **これは前回の壊れ方（postTickThenPacer を歯3にも使っていた版）とは別物
    // である。** 前回は「畳んだ跡が日誌に出るのを待つ」形で同期していたため、
    // **歯が測っているものとは無関係な理由で**、アサーションに到達する前に
    // タイムアウトしていた（＝タイムアウトが測定の代わりになっていなかった）。
    // **ここでのタイムアウトは、測っている当のものが起きなかったことそのもので
    // ある** — 「tick が単独で解除を起こす」の否定は「何も起きない」であり、
    // 何も起きないことは待つ以外に観測できない。**だからこのタイムアウトは
    // 測定であって、事故ではない。** AGENTS.md「タイムアウトは歯があった証拠に
    // ならない」は、**測っているものと無関係な待ちで落ちる形**を戒めたもので
    // あり、これはそれではない。
    await waitForReleaseAttempts(
      s,
      2,
      '2件目の tick（畳まれても回数は減らない — この待ちが歯の本体）',
    );

    // 3件目の tick。同様に畳まれるが、解除の試行はまた1回増える。
    s.clone.post({
      type: 'self_initiative',
      id: 'evt-si-3',
      at: new Date().toISOString(),
      reason: '3本目',
    });
    await waitForReleaseAttempts(s, 3, '3件目の tick（畳まれても回数は減らない）');

    // (1) 実際にモデルへ渡った回数。起点＋3回の再試行＝4回。全件が「起点」の
    // 本文を運んでいる（再試行は本文を変えない）。
    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs.every((text) => text.includes('起点'))).toBe(true);
    expect(inputs).toHaveLength(4);

    // (2) 解除を試した回数そのもの。
    expect(await releaseAttemptCount(s)).toBe(3);

    // (3) 畳まれた分も含めて、tick はすべて一度は器へ書き出されている
    // （`withInboxPutSpy` の doc）。**畳み込みが `#settleInboxEvent` に在る
    // ＝ 合図が器へ書かれた後に畳む**ということなので、畳んだ側が `#forget`
    // で消しに行く必要がある、という実装の形がここに出ている。
    //
    // **この観測点も、畳み込みを `post()` 側へ動かす変異を捕まえる。**
    // `post()` の畳み込みは `#remember`（＝器への書き出し）より**前**に
    // return するので、2件目・3件目は器へ1度も書かれず 0 になる。
    // ただし実際にその変異を当てたときに落ちるのは (2) の待ちのほうで
    // （`releaseAttemptCount` が 2 にならずタイムアウトする）、ここまで
    // 到達しない。**「捕まえる観測点」と「実際に落ちる観測点」は別である。**
    expect(putCallCountFor('evt-si-1')).toBe(1);
    expect(putCallCountFor('evt-si-2')).toBe(1);
    expect(putCallCountFor('evt-si-3')).toBe(1);

    await s.clone.stop();
    // **明示のタイムアウト。** 上の `waitForReleaseAttempts` の予算より必ず大きく
    // すること — vitest の既定は 5 秒なので、付けないとこちらが先に当たり、
    // あの断り書き（「退行か飽和かを区別できない」）が読まれないまま
    // 汎用のタイムアウトに化ける。
  }, 30_000);

  /**
   * ## この歯が守っているもの
   *
   * 上の3本（歯1・2・3）は `humanPriority: false` に固定してある（このブロック
   * doc の「⚠️」）。**それだけだと、実際に出荷される設定（`humanPriority: true`
   * が既定）について畳み込みを測る歯が1本も無くなる** — そこが壊れても緑の
   * ままになる。ここではその穴を埋める。
   *
   * 足場に `postTickThenPacer` は使えない。人間優先の下では pacer（人間の
   * 発言）が待ち行列上で tick を追い越しうるので、「pacer の終端＝直前の tick
   * の後始末が完了している」という FIFO 前提が成り立たない。代わりに歯3と
   * 同じ形 — `releaseAttemptCount`（日誌の「枠の解除を試す」行数）を直接
   * 待つ — を使う。
   *
   * **単に `humanPriority: true` を渡すだけの歯にしないため、1件目の tick を
   * 保持させた後、実際に「もう1件人間の発言を挟む」場面を通す。** この post は
   * `Clone#post` の `this.#humanPriority && isHumanOriginated(event) ? …` の
   * 分岐を毎回、真の側（`isHumanOriginated` を `Inbox#push` へ渡す側）で通る
   * — `humanPriority: false` にすればここは必ず `undefined` になる。**その
   * 人間の発言そのものが「新しい合図」として枠の解除をもう1回誘発しうる**
   * （`post()` の `#releaseRequested` は起点の種類を問わない）ので、2件目の
   * tick を送った後の `releaseAttemptCount` を固定値ではなく「人間の発言を
   * 挟んだ時点の値より増えていること」で待つ（固定値にすると、人間の発言が
   * 誘発する解除の回数が変わっただけで歯が壊れたことになり、測りたいもの —
   * 畳み込みそのもの — とは無関係な理由で落ちる）。
   *
   * **⚠️ この歯が示さないこと。** ここで人間の発言を挟む時点では `#pump` は
   * 必ず待ち手（`Inbox` の `#waiters`）が居る状態まで進んでいる（`releaseAttemptCount`
   * を直接待つ設計そのものが、待ち行列が捌け切るまで待つ形だからである）。
   * `Inbox#push` は待ち手が居ればそのまま渡す（＝クローンが暇なとき、割り込む
   * 相手が待ち行列に居ない）ので、**この歯だけでは `insertAfterLast` による
   * 待ち行列上の並べ替えそのもの（人間以外を実際に飛び越す分岐）は踏まない。**
   * 実測: この `it` は `humanPriority: true` を `false` に変えても、他の
   * assert を1つも変えずに緑のまま通る（畳み込みの成否は「`#deferred` に
   * 同種の tick が既に居るか」だけで決まり、その周りに何が・どの順で
   * 積まれたかには依らないため）。**並べ替えそのもの（人間が人間以外を
   * 飛び越す・人間以外どうしは飛び越さない）は上の
   * `describe('クローン — 人間が待っている合図を待ち行列の先頭側へ入れる', ...)`
   * が別に測っている。**
   *
   * ## ⚠️ この歯は「干渉しないこと」を測っていない
   *
   * **`humanPriority` を `false` に反転しても、この歯は緑のまま通る**（実測、
   * 2026-08-22）。だから**フラグの効果を測ってはいない。**
   *
   * **そしてそれは歯の作りが悪いのではなく、干渉が構造的に起きないからである。**
   * 畳み込みが成立するかは `#deferred` に同種の tick が既に居るかだけで決まり、
   * 順序が効くのは **tick どうしの前後**だけである。**tick はすべて人間以外なので、
   * 人間優先は tick どうしの順序を1ミリも動かさない**（動かすのは「人間 対 それ
   * 以外」の1段だけ）。**だから落ちる歯は書けない。書けば嘘の歯になる。**
   *
   * **その構造そのものを守っているのは、下の有界性の歯である**
   * （`割り込める起点が人間の速さで来るものだけであること`）。tick を人間起点に
   * した瞬間に前提が崩れるので、あちらがコンパイルで止める。
   *
   * **ここが測っているのは1つだけ** — **出荷される設定（`humanPriority: true`）
   * の下で、畳み込みが壊れたら落ちること。** それは被覆として要る（#168 の歯3本は
   * `humanPriority: false` に固定してあるので、既定の設定を通る歯がここしかない）。
   *
   * 見るのは歯1と同じ2点 — (1) 未読の `self_initiative` が1件だけ（畳んでも
   * 在庫が増えない）、(2) 畳んだ跡の日誌が1件（畳み込みが実際に起きた証拠）。
   */
  it('人間優先が有効なままでも、保持中の tick は畳まれて在庫が増えない', async () => {
    const s = setup(
      undefined,
      createMemoryStores(),
      { resultSubtype: 'error_during_execution', resultText: spendLimitMessage },
      // 人間優先は既定で有効（`resolveCloneHumanPriority({}) === true`）。
      // ここでは明示的に渡し、この歯が `humanPriority: true` の下で測っている
      // ことを自明にする。
      { ALTEROID_CLONE_HUMAN_PRIORITY: 'true' },
    );

    const origin = humanMessage('起点');
    s.clone.post(origin);
    await waitForTerminal(s.events);
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === origin.id);
    }, '起点が未読として保持される');

    // 1件目の tick。まだ `#deferred` に self_initiative は無いので畳めない。
    // 届いたこと自体が枠の解除を1回誘発する（歯3と同じ理由）。
    s.clone.post({
      type: 'self_initiative',
      id: 'evt-si-1',
      at: new Date().toISOString(),
      reason: '1本目',
    });
    await waitForReleaseAttempts(s, 1, '1件目の tick');
    const attemptsAfterTick1 = await releaseAttemptCount(s);

    // 枠で保持している最中に、もう1件人間が発言する（`humanPriority: true` の
    // 分岐を実際に通す一手。上の doc の「⚠️」に、ここが示すこと・示さない
    // ことの線引きがある）。人間優先下でも枠のロジック（保持・未読）は
    // 変わらないことをここで確かめる。
    const second = humanMessage('もう一件');
    s.clone.post(second);
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === second.id);
    }, '2件目の人間の発言が未読として保持される');

    // 2件目の tick。既に `#deferred` に1件目（self_initiative）が保持されて
    // いるので畳まれる（はず）。解除の試行そのものは1回も減らない —
    // **ただし目標値は固定しない。** 直前の人間の発言（`second`）自体も
    // 枠の解除をもう1回誘発しうる（上の doc）ので、「2件目の tick を送る前の
    // 値より増えている」ことだけを待つ。
    s.clone.post({
      type: 'self_initiative',
      id: 'evt-si-2',
      at: new Date().toISOString(),
      reason: '2本目',
    });
    await waitForReleaseAttemptsAbove(
      s,
      attemptsAfterTick1,
      '2件目の tick が枠の解除をもう一度誘発する（人間優先が有効でも回数は減らない）',
    );

    const pending = await s.stores.inbox.claimPending();
    const selfInitiatives = pending.filter((p) => p.event.type === 'self_initiative');
    // 未読の self_initiative は1件だけ（人間優先が有効でも在庫は増えない）。
    expect(selfInitiatives).toHaveLength(1);
    expect(selfInitiatives[0]?.event.id).toBe('evt-si-1');
    // 畳んだ跡が日誌に1件だけ残る（2本目のぶん）。
    expect(await foldedNoteCount(s)).toBe(1);
    // 人間の発言（起点・2件目）は畳み込みの対象外なので、両方とも未読のまま。
    expect(pending.some((p) => p.event.id === origin.id)).toBe(true);
    expect(pending.some((p) => p.event.id === second.id)).toBe(true);

    await s.clone.stop();
  }, 30_000);
});

/**
 * 症状B（人間の報告）: 「利用上限に当たった状態で話しかけると、枠が回復した
 * 後も、待たされていた発言への返信が届かない」を直接確かめる。
 *
 * 上のブロック（FIFO の配り直し）が確かめているのは「保持と再投入がクローンの
 * 内部で動くか」であって、「人間の側から見えるか」ではない。既存のその
 * ブロックは `setup()` の張りっぱなしの購読（ファイル冒頭 `clone.subscribe`）を
 * 使っており、`apps/daemon/src/app.ts` の `POST /chat`（:772-811）が
 * `done` / `error` を見た時点で `unsubscribe()` する現物の振る舞いを再現して
 * いない。ここではその振る舞いを持つ聞き手を自分で用意する。
 *
 * **人間の要望はリアルタイム性ではない**（「あとで良いのでちゃんと返信して
 * ほしい」が本旨。マネージャーからの追加指示）。SSE を張りっぱなしにする形が
 * 正解ではないので、ここで測るのは「その場で観測できるか」と「後から見つけら
 * れる形（日誌）で残るか」という別々の2つの事実であり、どちらかが正しい・
 * 間違っているという話ではない。
 */
describe('クローン — 枠が回復した後の返信は、人間の側から観測できるか（症状B）', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  /**
   * `setup()` は張りっぱなしの購読を1本持つ（ファイル冒頭）。ここではそれを
   * 使わず、購読者を自分で選べる素の clone を組み立てる。
   */
  function setupBareClone(sdkOptions: Parameters<typeof fakeSdk>[1] = {}): {
    clone: CloneHost;
    stores: Stores;
    calls: FakeCall[];
  } {
    const stores = createMemoryStores();
    const { fn, calls } = fakeSdk(undefined, sdkOptions);
    const clone = createClone({
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    return { clone, stores, calls };
  }

  /**
   * `apps/daemon/src/app.ts` の `POST /chat` と同じ振る舞いの聞き手
   * （:772 で subscribe、:774/:808 で `done`/`error` を終端と見て、
   * :811 の `finally` で unsubscribe する）。**張りっぱなしにしないことが
   * 要点** — 実物の SSE 購読はここで終わる。
   */
  function subscribeLikeChatEndpoint(clone: CloneHost, conversationId: string): ChatStreamEvent[] {
    const events: ChatStreamEvent[] = [];
    const unsubscribe = clone.subscribe(conversationId, (event) => {
      events.push(event);
      if (event.type === 'done' || event.type === 'error') unsubscribe();
    });
    return events;
  }

  it('(a) 元の接続（done/error で外れる、実物の SSE と同じ聞き手）には、保持していた合図の再試行が成功しても届かない', async () => {
    const { clone, stores, calls } = setupBareClone({
      resultFor: (turnIndex) =>
        turnIndex === 0
          ? { subtype: 'error_during_execution', text: spendLimitMessage }
          : undefined,
    });

    // 1本目: 枠に当たる。app.ts の POST /chat と同じ聞き手を張ってから post する
    // （app.ts も :772 の subscribe を :787 の post より先に行う）。
    const firstConnection = subscribeLikeChatEndpoint(clone, 'conv-1');
    clone.post(humanMessage('一件目'));
    await waitForTerminal(firstConnection);
    expect(firstConnection.filter(isTerminal).map((event) => event.type)).toEqual(['error']);
    // ここで購読は既に外れている（`subscribeLikeChatEndpoint` が error を見て
    // 自分で unsubscribe した）。

    await waitFor(async () => {
      const pending = await stores.inbox.claimPending();
      return pending.length === 1;
    }, '1本目が未読のまま保持される');

    // 枠が回復した後の「試す契機」は、人間が chat を開いていなくても来る
    // （自律 tick・マネージャーからの報告・外部イベントなど、`post()` を呼ぶ
    // ものなら何でもよい — `clone.ts:505` の解除チェックは合図の種類を見ない）。
    // ここでは conv-1 に紐付かない `timer` 合図を使い、「1本目の接続がまだ
    // 生きている」という都合の良い前提を置かないことを明示する。
    clone.post({
      type: 'timer',
      id: 'evt-trigger',
      at: new Date().toISOString(),
      kind: 'self_initiative_tick',
    });

    // 保持していた1本目の再試行が実際に SDK へ投げられるまで待つ
    // （calls[0] の入力数が2件目に増える＝再試行が起きた証拠）。
    await waitFor(async () => (calls[0]?.inputs.length ?? 0) >= 2, '1本目の再試行が実行される');
    // 再試行そのものが成功したこと（done で終わる）も別途確かめる（副読）。
    //
    // **「失敗の記録ではない outbound」では足りない。** 枠で保持していることを
    // 人間へ返す1行（`#reportFailure`）も同じ `with: 'human'` / `outbound` /
    // `conv-1` で載るので、否定形の条件だと再試行を待たずに満たされてしまう。
    // 偽の SDK の返信は常に `わかった` なので**その本文を数える** — 1本目でも
    // assistant の本文は流れて日誌に載る（`clone.ts` の journal 書き込みは
    // result の成否より前）ので、**2件目が出た＝再試行の返信が載った**である。
    //
    // ---- 追記（SDK のエラーを応答として扱うのをやめた改修） ----
    // 上の「1本目でも assistant の本文が**そのまま**日誌に載る」は、もう成り立た
    // ない。失敗したターンの本文には印が付く（`clone.ts` の `result` の分岐。
    // 無印で残すと、日誌が digest を通って翌日の日報の材料になるときに
    // 「クローンがそう言った」として効いてしまう）。
    //
    // **これは保証を弱める変更ではない。** 印が付くことで、素の `わかった` は
    // **再試行の返信ただ1件だけ**になる — 直す前の `>= 2` は「1本目の分と合わせて
    // 2件」という数え方だったので、1本目の本文が混ざる余地があった。いまは
    // 1件でも「再試行の返信が載った」を一意に指す。**そのうえで、1本目の本文に
    // 印が付いていることも同じ待ちの中で確かめる**（片方だけを見ると、印を
    // 付ける実装が消えても緑のままになる）。
    await waitFor(async () => {
      const exchanges = await stores.journal.list({ types: ['exchange'] });
      const outbound = exchanges.filter(
        (entry) =>
          entry.type === 'exchange' &&
          entry.with === 'human' &&
          entry.role === 'outbound' &&
          entry.conversationId === 'conv-1',
      );
      const retried = outbound.filter(
        (entry) => entry.type === 'exchange' && entry.text === 'わかった',
      );
      const marked = outbound.filter(
        (entry) =>
          entry.type === 'exchange' &&
          entry.text.startsWith('（このターンは失敗して終わった') &&
          entry.text.includes('わかった'),
      );
      return retried.length === 1 && marked.length === 1;
    }, '再試行が成功した記録が日誌に残る（1本目の本文には失敗の印が付く）');

    // 症状B(a): 元の接続には、この再試行の成功（text/done）が一切届いていない
    // — 購読は1本目自身の error で既に外れている。**これは「あるべき」を示す
    // アサーションではない**（マネージャーの指示どおり、SSE を張りっぱなしに
    // する形は正解ではないため）。観測された事実として記録する。
    // 1本目自身の queued/thinking/text/usage_limited/error のあとは何も増えて
    // いないこと＝再試行の分（2周目の queued 以降）が一切届いていないこと。
    expect(firstConnection.some((event) => event.type === 'done')).toBe(false);
    expect(firstConnection.filter(isTerminal)).toHaveLength(1);
    expect(firstConnection.filter((event) => event.type === 'usage_limited')).toHaveLength(1);

    await clone.stop();
  });

  it('(b) 保持していた合図の再試行が成功すると、日誌には with:human / role:outbound / 同じ conversationId の記録が残る', async () => {
    const { clone, stores } = setupBareClone({
      resultFor: (turnIndex) =>
        turnIndex === 0
          ? { subtype: 'error_during_execution', text: spendLimitMessage }
          : undefined,
    });

    const isMatchingOutboundExchange = (
      entry: Awaited<ReturnType<Stores['journal']['list']>>[number],
    ): entry is Extract<
      Awaited<ReturnType<Stores['journal']['list']>>[number],
      { type: 'exchange' }
    > =>
      entry.type === 'exchange' &&
      entry.with === 'human' &&
      entry.role === 'outbound' &&
      entry.conversationId === 'conv-1';

    const matchingOutbound = async () =>
      (await stores.journal.list({ types: ['exchange'] })).filter(isMatchingOutboundExchange);

    const firstConnection = subscribeLikeChatEndpoint(clone, 'conv-1');
    clone.post(humanMessage('一件目'));
    await waitForTerminal(firstConnection);

    const before = await matchingOutbound();
    const beforeCount = before.length;

    clone.post({
      type: 'timer',
      id: 'evt-trigger',
      at: new Date().toISOString(),
      kind: 'self_initiative_tick',
    });

    // 症状B(b): 再試行が成功すると、日誌には新しい outbound の記録が増える
    // （`#emit` の購読者の有無とは無関係に、`clone.ts:2062` の journal 書き込みは
    // 常に走る）。**これは実際にありうる真の観測**であって、(a) と対になる
    // 別の事実である。
    await waitFor(
      async () => (await matchingOutbound()).length > beforeCount,
      '保持していた1本目の再試行の返信が日誌に残る',
    );

    const after = await matchingOutbound();
    const newest = after.find((entry) => !before.some((existing) => existing.id === entry.id));
    expect(newest).toBeDefined();
    // **増えた1件が再試行の返信そのものであること**まで見る（否定形だと、枠で
    // 保持していることを人間へ返す1行でも通ってしまう）。偽の SDK の返信は
    // 常に `わかった` である。
    expect(newest?.text).toBe('わかった');
    expect(newest?.text.startsWith('人間との対話ターンが失敗した')).toBe(false);

    await clone.stop();
  });

  /**
   * 人間へ返す1行を、**枠のときとそれ以外で言い分けているか**。
   *
   * 人間の要望は「あとで良いのでちゃんと返信してほしい」である。だから会話に
   * 残る1行は「待てば返る」と「もう返らない」を区別していなければならない —
   * どちらも「失敗した」で済ませると、人間は待つべきかもう一度送るべきかを
   * 会話から決められない（送り直すと、保持されている分と重複する）。
   *
   * **`#reportFailure` の分岐（`#usageBlocked === null`）に歯を当てるのが目的**
   * なので、枠の場合と枠でない場合を1本の中で対にして見る（別々の it にすると、
   * 片方だけが緑のまま「常に同じ文言を返す」実装を通してしまう）。
   */
  it('人間へ返す1行は、枠で保持しているときだけ「あとで試し直す」と言う', async () => {
    /**
     * 会話に残った、クローンからの1行（assistant の本文 `わかった` は除く）。
     *
     * **除外は `includes` で行う**（元は `!== 'わかった'` だった）。失敗した
     * ターンの本文には印が付くので（`clone.ts` の `result` の分岐）、完全一致で
     * 除くと `（このターンは失敗して終わった…）\nわかった` が「クローンからの
     * 1行」に混ざり、**このヘルパが数える対象が2件になって条件が永久に満たされ
     * なくなる**。ここで見たいのは `#reportFailure` が人間へ返す1行だけである。
     */
    const noticesFor = async (stores: Stores) =>
      (await stores.journal.list({ types: ['exchange'] }))
        .filter(
          (entry) =>
            entry.type === 'exchange' &&
            entry.with === 'human' &&
            entry.role === 'outbound' &&
            entry.conversationId === 'conv-1' &&
            !entry.text.includes('わかった'),
        )
        .map((entry) => (entry.type === 'exchange' ? entry.text : ''));

    // 枠に当たった場合。
    const limited = setupBareClone({
      resultFor: () => ({ subtype: 'error_during_execution', text: spendLimitMessage }),
    });
    limited.clone.post(humanMessage('一件目'));
    await waitFor(async () => (await noticesFor(limited.stores)).length === 1, '枠の1行が残る');
    const limitedNotice = (await noticesFor(limited.stores))[0] ?? '';
    expect(limitedNotice).toContain('利用上限');
    expect(limitedNotice).toContain('試し直');
    // 生の文言（英語）は人間へ返す1行には載せない。
    expect(limitedNotice).not.toContain(spendLimitMessage);
    await limited.clone.stop();

    // 枠ではない失敗の場合。**待てば返るとは言わない。**
    const broken = setupBareClone({
      resultFor: () => ({ subtype: 'error_during_execution', text: '内部で何かが壊れた' }),
    });
    broken.clone.post(humanMessage('一件目'));
    await waitFor(
      async () => (await noticesFor(broken.stores)).length === 1,
      '枠でない失敗の1行が残る',
    );
    const brokenNotice = (await noticesFor(broken.stores))[0] ?? '';
    expect(brokenNotice).toContain('返せなかった');
    expect(brokenNotice).not.toContain('試し直');
    expect(brokenNotice).not.toContain('内部で何かが壊れた');
    await broken.clone.stop();
  });
});

/**
 * **エラーが「応答」として保存される穴**（この改修の本体）。
 *
 * 実際に起きた壊れ方は、日報の本文が丸ごとこれになっていた、というものである。
 *
 * ```
 * You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message
 * ```
 *
 * 経路は3つ重なっていた（`sdk-failure.ts` の doc）。
 *
 * 1. `assistant.error`（SDK が「これは応答ではない」と付ける印）を1度も見ておらず、
 *    text ブロックを無条件に `turn.text` へ足していた
 * 2. `isSuccessResult` が `subtype === 'success'` だけを見ており、`is_error: true`
 *    を成功として通していた
 * 3. `#runTurn` の戻り値が `string` 一本で成否を運ばず、日報はそれを本文にした
 *
 * **さらに、失敗したときに書かれた1件が再試行を殺していた** — 上限の合図は保持
 * されて配り直されるのに、その1件があるせいで `#dailyReport` の早期 return と
 * `missingDailyReportDates` の両方が「もう書いた」と判断する。
 *
 * だからここで見るのは4つである。
 *
 * - エラーの文言が日報の本文にならないこと
 * - **枠で保持している回は日報の行を1つも書かないこと**（再試行を殺さない）
 * - 枠ではない失敗では `unavailable` の印付きで書き、印の行は「日報がある」と
 *   数えないこと
 * - `assistant.error` / `is_error` のどちらの経路でも、本文が応答にならないこと
 */
describe('クローン — SDK のエラーを応答として扱わない（日報がエラー文になる穴）', () => {
  /** 実機で観測された文言そのまま（`USAGE_LIMIT_ERROR_PREFIXES` の1つめに当たる）。 */
  const orgSpendLimit =
    "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message";

  function postDailyReport(clone: CloneHost, date: string): void {
    clone.post({
      type: 'timer',
      id: `evt-timer-${date}`,
      at: new Date().toISOString(),
      kind: 'daily_report',
      target: date,
    });
  }

  const reportsOf = async (stores: Stores) =>
    (await stores.journal.list({ types: ['daily_report'] })) as {
      type: 'daily_report';
      date: string;
      body: string;
      unavailable?: string;
    }[];

  it('assistant.error が付いた本文は日報にならず、枠で保持している回は日報の行を1つも書かない', async () => {
    // 実機の形: 上限の文言は `assistant` メッセージとして届き、`error` が付く。
    // `result` は `subtype: 'success'` で返る（`is_error` も立たない）ので、
    // **印を見ないと成功と区別が付かない**回である。
    const s = setup(() => 'ここは日報の本文になってはいけない', createMemoryStores(), {
      assistantErrorAt: () => ({ error: 'billing_error', text: orgSpendLimit }),
    });

    postDailyReport(s.clone, '2026-08-19');

    // ターンが畳まれたことを、失敗の記録で確かめる（`#reportFailure` の内部ターン側）。
    await waitFor(async () => {
      const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
        with: string;
        text: string;
      }[];
      return exchanges.some(
        (entry) => entry.with === 'self' && entry.text.startsWith('内部ターンが失敗した'),
      );
    }, '日報のターンが失敗として記録される');

    // **枠で保持しているので、日報の行は1件も無い。** ここに印だけでも書くと、
    // 配り直しで走り直したときに早期 return して本物が永久に書かれない。
    expect(await reportsOf(s.stores)).toHaveLength(0);

    // 失敗の記録には SDK の文言がそのまま残る（人間が検索できる形）。
    const failures = (
      (await s.stores.journal.list({ types: ['exchange'] })) as { with: string; text: string }[]
    ).filter((entry) => entry.text.startsWith('内部ターンが失敗した'));
    expect(failures[0]?.text).toContain(orgSpendLimit);
    expect(failures[0]?.text).toContain('billing_error');
    // どの印で分かったかも残す（次に掘り始める位置が違う）。
    expect(failures[0]?.text).toContain('assistant_error');

    // 上限として分類され、保持へ切り替わっている（枠の知らせが日誌にある）。
    const notices = (
      (await s.stores.journal.list({ types: ['exchange'] })) as { with: string; text: string }[]
    ).filter((entry) => entry.text.startsWith('利用上限に当たった'));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain(orgSpendLimit);

    await s.clone.stop();
  });

  it('subtype:success でも is_error が立っていれば応答として扱わない', async () => {
    // `isSuccessResult`（台帳の問い）は `subtype === 'success'` だけを見るので、
    // この回を成功として通す。**応答の問いは `isAnsweredResult` が答える。**
    const s = setup(() => 'これも日報の本文になってはいけない', createMemoryStores(), {
      resultFor: () => ({ subtype: 'success', text: orgSpendLimit, isError: true }),
    });

    postDailyReport(s.clone, '2026-08-19');

    await waitFor(async () => {
      const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
        with: string;
        text: string;
      }[];
      return exchanges.some(
        (entry) => entry.with === 'self' && entry.text.startsWith('内部ターンが失敗した'),
      );
    }, '日報のターンが失敗として記録される');

    // 枠として分類されるので保持側。日報は書かれない。
    expect(await reportsOf(s.stores)).toHaveLength(0);

    const failures = (
      (await s.stores.journal.list({ types: ['exchange'] })) as { with: string; text: string }[]
    ).filter((entry) => entry.text.startsWith('内部ターンが失敗した'));
    // `subtype` が `success` のまま失敗した回だと分かる形で残っていること。
    expect(failures[0]?.text).toContain('result_is_error');

    await s.clone.stop();
  });

  it('枠ではない失敗では unavailable の印付きで書き、印の行は「日報がある」と数えない', async () => {
    const stores = createMemoryStores();
    const s = setup(() => '部分的に出ていた本文', stores, {
      // 枠ではない失敗（`classifyUsageNotice` に当たらない文言）。**保持しない**
      // ので、日報が無い日を作らないために印付きの行を書く側になる。
      resultFor: () => ({ subtype: 'error_during_execution', text: '内部で何かが壊れた' }),
    });

    postDailyReport(s.clone, '2026-08-19');

    await waitFor(async () => (await reportsOf(stores)).length === 1, '印付きの行が書かれる');
    const placeholder = (await reportsOf(stores))[0];
    // **本文がエラー文そのものになっていない**（ここが直った点）。
    expect(placeholder?.body).not.toBe('内部で何かが壊れた');
    expect(placeholder?.body).toContain('作れなかった');
    // 理由は落とさない（人間が掘るときの手がかり）。
    expect(placeholder?.unavailable).toContain('内部で何かが壊れた');
    await s.clone.stop();

    // 同じ日をもう一度締める。**印の行は「日報がある」と数えないので、本物が書ける。**
    const again = setup(() => '今日はログイン周りを直した。保留は無い。', stores);
    postDailyReport(again.clone, '2026-08-19');
    await waitFor(async () => {
      const reports = await reportsOf(stores);
      return reports.some((entry) => entry.unavailable === undefined);
    }, '後から本物の日報が書ける');

    const written = (await reportsOf(stores)).filter((entry) => entry.unavailable === undefined);
    expect(written).toHaveLength(1);
    expect(written[0]?.body).toContain('ログイン周り');
    await again.clone.stop();
  });

  it('本物の日報が既にある日は、失敗しても印の行を足さない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'daily_report',
      date: '2026-08-19',
      body: 'クローンが道具で書いた日報',
    });

    // 道具で書いた**後に**ターンが失敗した回（`daily_report_write` は成功した
    // のに result が失敗で返る、はありうる）。印を足すと、人間が読む唯一の層に
    // 「作れなかった」が並んで見える。
    const s = setup(() => '書いておいた', stores, {
      resultFor: () => ({ subtype: 'error_during_execution', text: '内部で何かが壊れた' }),
    });
    postDailyReport(s.clone, '2026-08-19');

    await waitFor(async () => {
      const exchanges = (await stores.journal.list({ types: ['exchange'] })) as {
        with: string;
        text: string;
      }[];
      return exchanges.some(
        (entry) => entry.with === 'self' && entry.text.startsWith('内部ターンが失敗した'),
      );
    }, 'ターンが失敗として記録される');

    const reports = await reportsOf(stores);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.unavailable).toBeUndefined();
    await s.clone.stop();
  });

  it('成功したターンでは印を付けない（この機構が普段の日報を壊していないこと）', async () => {
    const s = setup(() => '今日はログイン周りを直した。保留は無い。');
    postDailyReport(s.clone, '2026-08-19');

    await waitFor(async () => (await reportsOf(s.stores)).length === 1, '日報が書かれる');
    const report = (await reportsOf(s.stores))[0];
    expect(report?.unavailable).toBeUndefined();
    expect(report?.body).toContain('ログイン周り');
    await s.clone.stop();
  });

  it('組織方針で止められた回も日誌に残る（待たないが、記録はする）', async () => {
    // `ORG_POLICY_LIMIT_PREFIXES` の文言。**利用上限とは別**で、待っても直らない。
    // 直す前はここで早期 return していたので、日誌に1行も残らなかった。
    const orgPolicy = 'This service is disabled for your organization';
    const s = setup(() => 'なにか', createMemoryStores(), {
      resultFor: () => ({ subtype: 'error_during_execution', text: orgPolicy }),
    });

    s.clone.post(humanMessage('一件目'));

    await waitFor(async () => {
      const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
        text: string;
      }[];
      return exchanges.some((entry) => entry.text.startsWith('組織の方針で止められている'));
    }, '組織方針の知らせが日誌に残る');

    // **待たない**（保持しない）ことは変えていない。枠として保持していたら、
    // 人間の発言が未読のまま溜まり続ける。
    const notices = s.events.filter((event) => event.type === 'usage_limited');
    expect(notices).toHaveLength(0);

    await s.clone.stop();
  });
});

/**
 * 人間は返事を待っているあいだも喋る。
 *
 * **ここで守っているのは「まとめること」ではなく「まとめても失われないこと」である。**
 * 1件ずつ別ターンで読む形は、後で言い直された最初の一言に本気で答えてから、次の
 * ターンでその仕事をやり直す（費用も二重に払う）。だからまとめる — ただし全文・
 * 順序・器の未読・台帳の id のどれか1つでも落ちたら、それは「畳んで捨てた」に
 * なる。この describe はその4つを1本ずつ見ている。
 */
describe('クローン — 処理待ちのあいだに積み上がった発言', () => {
  /** 先客のターンが実際に走り始めるまで待つ（積んだ時点で「処理待ち」だと言えるようにする）。 */
  const waitForFirstTurn = (s: Setup): Promise<void> =>
    waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

  /** 積んだ最後の発言が、どのターンかは問わず SDK へ渡るまで待つ。 */
  const waitForDelivered = (s: Setup, text: string): Promise<void> =>
    waitFor(() => (s.calls[0]?.inputs ?? []).join('\n').includes(text), `${text} が渡る`);

  /**
   * まとめた／まとめないの判定は**ターンの本数**で出る。本数を `waitFor` で待つと、
   * 期待どおりにならない世界（＝変異させた世界）でタイムアウトになり、
   * **タイムアウトは歯があった証拠にならない**（AGENTS.md）。だから
   * 「最後の発言が届いた」まで待ってから少し置き、本数は等値で比べる。
   */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400));

  it('処理待ちに積み上がった発言は1ターンにまとめて渡る（全文が届いた順に載る）', async () => {
    const s = setup(() => 'わかった', createMemoryStores(), { delayMs: 250 });

    s.clone.post(humanMessage('一件目'));
    await waitForFirstTurn(s);
    s.clone.post(humanMessage('二件目'));
    s.clone.post(humanMessage('三件目'));

    await waitForDelivered(s, '三件目');
    await settle();

    // 先客の1本 + 積み上がった2件をまとめた1本 = 2本。**3本ではない**
    expect(s.calls[0]?.inputs).toHaveLength(2);

    const merged = s.calls[0]?.inputs[1] ?? '';
    expect(merged).toContain('二件目');
    expect(merged).toContain('三件目');
    expect(merged).toContain('**2 件** の発言が届いた');
    // 届いた順のまま渡す（言い直しを先に読ませない）
    expect(merged.indexOf('二件目')).toBeLessThan(merged.indexOf('三件目'));

    await s.clone.stop();
  }, 15_000);

  it('1件だけのときは本文に断り書きを足さない（普通の一往復を重くしない）', async () => {
    const s = setup(() => 'わかった');

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const input = s.calls[0]?.inputs[0] ?? '';
    expect(input).toContain('やあ');
    expect(input).not.toContain('の発言が届いた');
    expect(input).not.toContain('まとめて1つの応答で答えよ');

    await s.clone.stop();
  });

  it('会話が違う発言はまとめない（別の端末で話している相手の画面に応答を流さない）', async () => {
    const s = setup(() => 'わかった', createMemoryStores(), { delayMs: 150 });

    s.clone.post(humanMessage('先客', 'conv-1'));
    await waitForFirstTurn(s);
    s.clone.post(humanMessage('こちら1', 'conv-1'));
    s.clone.post(humanMessage('あちら', 'conv-2'));
    s.clone.post(humanMessage('こちら2', 'conv-1'));

    await waitForDelivered(s, 'こちら2');
    await settle();

    // 4件が4本のまま走る（会話をまたいで束ねない）
    expect(s.calls[0]?.inputs).toHaveLength(4);
    const second = s.calls[0]?.inputs[1] ?? '';
    expect(second).toContain('こちら1');
    expect(second).not.toContain('あちら');
    expect(second).not.toContain('こちら2');

    await s.clone.stop();
  }, 15_000);

  // **この歯はかつて「間に別の起点が挟まったら飛び越えない（受信箱の順序を
  // 並べ替えない）」という名前で、飛び越えないことを保証していた。** 人間から
  // 「優先度を人間 > マネージャーにできますか？ 割り込んでもいいので人間への
  // 回答を優先するようにしてほしい」（2026-08-22 JST、逐語）という要望を受け、
  // `CLONE_HUMAN_PRIORITY_ENV_KEY`（既定で有効）により**人間の発言だけ**が
  // 待ち行列上で人間以外を飛び越すようになった。飛び越すのは人間どうしの中で
  // 最後尾へ、であって人間以外は互いに追い越さない — この歯はいま真になった
  // その形（人間以外どうしの非喪失・順序保存）を測る。人間が飛び越す場面は
  // 上の `describe('クローン — 人間が待っている合図を待ち行列の先頭側へ入れる', ...)`
  // が別に測っている。
  it('人間以外どうしは、間に別の起点が挟まっても飛び越えない', async () => {
    const s = setup(() => 'わかった', createMemoryStores(), { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);
    s.clone.post(humanMessage('挟まる前'));
    s.clone.post({
      type: 'external',
      id: 'evt-ext',
      at: new Date().toISOString(),
      source: 'webhook',
      payload: '先に届いた外部イベント',
    });
    s.clone.post(humanMessage('挟まった後'));

    await waitForDelivered(s, '挟まった後');
    await settle();

    const inputs = s.calls[0]?.inputs ?? [];
    // **実測で決めた期待値（2026-08-22 観測）。** 「挟まった後」は待ち行列上、
    // 到着順ではなく人間の最後尾（＝「挟まる前」の直後）へ入り直すので、external
    // を飛び越えて「挟まる前」に連続する。連続した人間の発言2件は
    // `#mergedHumanBatch` により1ターンにまとめられる（まとめられること自体は
    // 依頼者が受け入れ済み）。だから本数は「先客」＋「人間2件の合流ターン」＋
    // 「external」の3本になる（4本ではない）。
    expect(inputs).toHaveLength(3);
    // 人間2件が1ターンにまとまる。
    expect(inputs[1]).toContain('挟まる前');
    expect(inputs[1]).toContain('挟まった後');
    // まとめても本文中の順序は到着順のまま（言い直しを先に読ませない）。
    const merged = inputs[1] ?? '';
    expect(merged.indexOf('挟まる前')).toBeLessThan(merged.indexOf('挟まった後'));
    // 外部イベントが人間の発言に追い越されない
    // だった。いまは人間が飛び越す（人間の決定。逐語は `CLONE_HUMAN_PRIORITY_ENV_KEY`）。
    // その結果、external は人間2件がまとまった後（3本目）に置かれる。
    expect(inputs[2]).toContain('先に届いた外部イベント');

    await s.clone.stop();
  }, 15_000);

  it('まとめた分は1件も器に残らない（起動のたびに配り直される形を作らない）', async () => {
    const stores = createMemoryStores();
    const s = setup(() => 'わかった', stores, { delayMs: 200 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);
    s.clone.post(humanMessage('続き1'));
    s.clone.post(humanMessage('続き2'));

    await waitForDelivered(s, '続き2');
    await settle();

    // まとめて読んだ2件のどちらも未読から消えている（1件でも残れば次の起動で配り直される）
    expect(await stores.inbox.claimPending()).toEqual([]);

    await s.clone.stop();
  }, 15_000);

  it('まとめた件数ぶんの未了 id が断り書きに載る（閉じ方を渡さない未了を作らない）', async () => {
    const stores = createMemoryStores();
    const s = setup(() => 'わかった', stores, { delayMs: 200 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);
    s.clone.post(humanMessage('続き1'));
    s.clone.post(humanMessage('続き2'));

    await waitForDelivered(s, '続き2');
    await settle();

    const merged = s.calls[0]?.inputs[1] ?? '';
    expect(merged).toContain('2 件も台帳に載せた');
    // 台帳の id は合図の id そのもの（`commitmentFor`）。2件とも渡す
    expect(merged).toContain('evt-続き1');
    expect(merged).toContain('evt-続き2');
    expect(merged).toContain('閉じるのは id ごとである');

    await s.clone.stop();
  }, 15_000);

  /**
   * **未了 id の列挙にも上限が要る（#409）。** `idList` はまとめて届いた件数
   * ぶん伸びる列挙で、`.map().join()` に上限も合図も無かった。大量にまとめて
   * 届くと、切っていない実装ではこの1行だけで数百文字になる——ここでは
   * 抜粋の合図（`excerptLine` の「省略」）が出て、伸び続けないことを見る。
   */
  it('まとめて届いた未了が大量でも、id の列挙は抜粋の合図で締まる', async () => {
    const stores = createMemoryStores();
    const s = setup(() => 'わかった', stores, { delayMs: 200 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);
    const count = 50;
    for (let index = 0; index < count; index += 1) {
      s.clone.post(humanMessage(`続き${index}`));
    }

    await waitForDelivered(s, `続き${count - 1}`);
    await settle();

    const merged = s.calls[0]?.inputs[1] ?? '';
    expect(merged).toContain(`${count} 件も台帳に載せた`);
    const line = merged.split('\n').find((entry) => entry.includes('台帳に載せた（id:'));
    expect(line).toBeDefined();
    // 50件の生の id をそのまま出せば数百文字になる。ここでは合図が出て、
    // 際限なく伸びていないことを見る。
    expect(line!.length).toBeLessThan(600);
    expect(line).toMatch(/省略/);

    await s.clone.stop();
  }, 15_000);

  it('配り直しの合図はまとめない（何が二度目なのか言えなくなる）', async () => {
    // 前の器が処理を終えられなかった2件。起動時に拾い直される（`#restoreUnread`）
    const stores = createMemoryStores();
    await stores.inbox.put(humanMessage('未読1'), '2026-08-20T10:00:00.000Z');
    await stores.inbox.put(humanMessage('未読2'), '2026-08-20T10:00:01.000Z');

    const s = setup(() => 'わかった', stores, { delayMs: 200 });

    await waitForDelivered(s, '未読2');
    await settle();

    const inputs = s.calls[0]?.inputs ?? [];
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toContain('配り直しである');
    expect(inputs[0]).toContain('未読1');
    expect(inputs[0]).not.toContain('未読2');

    await s.clone.stop();
  }, 15_000);

  /**
   * **`#restoreUnread` の配り直しも `post()` と同じ人間優先を効かせる。** `post()`
   * は `Inbox#push` へ `insertAfterLast`（人間なら `isHumanOriginated`）を渡して
   * 人間の発言を待ち行列の人間の最後尾へ入れるが、`#restoreUnread` はこれまで
   * 第2引数を渡さずに `this.#inbox.push(record.event)` と呼んでいた（`post` を
   * 通さない理由は tick の畳み込みで落ちた行が残り続けるためであり、それとは
   * 別に人間優先まで一緒に落ちていた）。
   *
   * **先頭の1件だけでは測れない。** `#pump` は `#restoreUnread` を `void` で
   * 起こしてから直後に `for await (const event of this.#inbox)` を張るので、
   * 待ち手（`Inbox` の `#waiters`）は `claimPending` が返る前から既に登録
   * 済みである。claim 順で**最初に配り直される1件は、待ち行列を経由せず
   * 待ち手へ直接渡って即座に走行中のターンになる**（`insertAfterLast` は
   * 「待ち手が居れば素通し」なので、ここには一切効かない —
   * `Inbox#push` の doc「待ち手が居るときは順序の話にならない」）。実測
   * （2026-08-27）: `[非人間, human, 非人間]` の3件だけで claim 順を
   * `human` が中間に来るよう仕込んでも、直した実装を当てても当てなくても
   * ターンの並びは1文字も変わらなかった——先頭の非人間が即座に走行中の
   * ターンを奪い、残り2件（human・非人間）が積まれる先の待ち行列は
   * 常に空で、`insertAfterLast` に飛び越す相手が居ないため。
   *
   * だからここでは**先頭に「奪われ役」の非人間を1件多く置く**：
   * `非人間A`（claim 順で最初、走行中のターンを奪う）→ `非人間C`（待ち行列に
   * 積まれて残る）→ `human`（`非人間C` を飛び越せるかが本題）→ `非人間B`
   * （human より後なので、直しても飛び越されない）。飛び越す本題は
   * `human` 対 `非人間C` の1組で足りる。
   */
  it('起動直後の配り直しでも、人間の発言は待ち行列に残っていた非人間より先に読まれる（#restoreUnread の人間優先）', async () => {
    const stores = createMemoryStores();
    const nonHumanA: InboxEvent = {
      type: 'external',
      id: 'evt-nonhuman-a',
      at: '2026-08-20T10:00:00.000Z',
      source: 'webhook-a',
      payload: '非人間A（claim順で最初・走行中のターンを奪う）',
    };
    const nonHumanC: InboxEvent = {
      type: 'external',
      id: 'evt-nonhuman-c',
      at: '2026-08-20T10:00:01.000Z',
      source: 'webhook-c',
      payload: '非人間C（待ち行列に積まれて残る）',
    };
    const human = humanMessage('人間の発言だ');
    const nonHumanB: InboxEvent = {
      type: 'external',
      id: 'evt-nonhuman-b',
      at: '2026-08-20T10:00:03.000Z',
      source: 'webhook-b',
      payload: '非人間B（human より後・飛び越されない）',
    };

    // claim 順（＝ `put` の第2引数。`stores.inbox.claimPending` が並べ替えに
    // 使うのはこちらで、`event.at` ではない）で
    // [非人間A, 非人間C, human, 非人間B] に並ぶよう仕込む。`humanMessage()` は
    // `event.at` に呼び出し時の実時刻を積むので、`event.at` をそのまま claim
    // 順へ使うと（今日の日付が2026-08-20より後になり）human が最後尾に落ちる
    // ——claim 順は明示的に別で渡す。
    await stores.inbox.put(nonHumanA, '2026-08-20T10:00:00.000Z');
    await stores.inbox.put(nonHumanC, '2026-08-20T10:00:01.000Z');
    await stores.inbox.put(human, '2026-08-20T10:00:02.000Z');
    await stores.inbox.put(nonHumanB, '2026-08-20T10:00:03.000Z');

    const s = setup(() => 'わかった', stores, { delayMs: 200 });

    await waitForDelivered(s, '非人間B（human より後・飛び越されない）');
    await settle();

    const joined = (s.calls[0]?.inputs ?? []).join('\n');
    const idxA = joined.indexOf('非人間A（claim順で最初・走行中のターンを奪う）');
    const idxC = joined.indexOf('非人間C（待ち行列に積まれて残る）');
    const idxHuman = joined.indexOf('人間の発言だ');
    const idxB = joined.indexOf('非人間B（human より後・飛び越されない）');

    // 4件とも実際に届いている（見つからない＝-1 を「先」と誤読しない）
    expect(idxA).toBeGreaterThan(-1);
    expect(idxC).toBeGreaterThan(-1);
    expect(idxHuman).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);

    // 本題: 待ち行列に積まれて残っていた非人間Cより、human が先に読まれる
    expect(idxHuman).toBeLessThan(idxC);

    // 非人間は1件も消えず、非人間どうしの到着順（A → C → B）は保たれる
    expect(idxA).toBeLessThan(idxC);
    expect(idxC).toBeLessThan(idxB);

    // human より後に claim された非人間Bは、human を追い越さない
    expect(idxHuman).toBeLessThan(idxB);

    await s.clone.stop();
  }, 15_000);
});

describe('humanTurnText（ターン本文の組み立て）', () => {
  const message = (text: string, at: string): HumanMessage => ({
    type: 'human_message',
    id: `evt-${text}`,
    at,
    text,
    conversationId: 'conv-1',
  });

  it('1件なら本文そのまま（1文字も足さない）', () => {
    expect(humanTurnText([message('やあ', '2026-08-20T10:00:00.000Z')])).toBe('やあ');
  });

  it('複数件は全文を届いた順に並べ、各件の時刻を添える', () => {
    const text = humanTurnText([
      message('AAA', '2026-08-20T10:00:00.000Z'),
      message('BBB', '2026-08-20T10:00:09.000Z'),
    ]);

    expect(text).toContain('**2 件** の発言が届いた');
    expect(text).toContain('AAA');
    expect(text).toContain('BBB');
    expect(text.indexOf('AAA')).toBeLessThan(text.indexOf('BBB'));
    // 「3分空けて言い直した」と「続けて3行打った」を読み分ける材料はクローンへ渡す
    expect(text).toContain('2026-08-20T10:00:00.000Z');
    expect(text).toContain('2026-08-20T10:00:09.000Z');
  });

  it('1件も無ければ空文字（呼び出し側が先頭を仮定しない）', () => {
    expect(humanTurnText([])).toBe('');
  });
});

describe('クローン — 人間が待っている合図を待ち行列の先頭側へ入れる', () => {
  /**
   * `setup()`（`Setup`）は `CloneOptions.humanPriority` を渡す口を持たないので、
   * ここでは `createClone` を直接呼ぶ（`setupCapturing` などファイル内の既存の
   * 特設セットアップと同じ形）。`humanPriority` は環境変数を経由せず直渡しする
   * （`permissionMode` の直渡し実測は無いが、コンストラクタは
   * `humanPriority ?? resolveCloneHumanPriority(envSource)` で `false` を
   * nullish coalescing が通すので、直渡しした `false` がそのまま効く）。
   */
  function setupWithHumanPriority(
    humanPriority: boolean,
    reply: (input: string) => string = () => 'わかった',
    sdkOptions: Parameters<typeof fakeSdk>[1] = {},
  ): Setup {
    const stores = createMemoryStores();
    const { fn, calls } = fakeSdk(reply, sdkOptions);
    const clone = createClone({
      stores,
      queryFn: fn,
      env: {},
      humanPriority,
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events, waitForEvents } = wireEvents(clone, 'conv-1');
    return { clone, stores, calls, events, waitForEvents };
  }

  /** 先客のターンが実際に走り始めるまで待つ（積んだ時点で「処理待ち」だと言えるようにする）。 */
  const waitForFirstTurn = (s: Setup): Promise<void> =>
    waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

  /**
   * 渡した目印が全部、実際にモデルへ渡った入力のどこかに現れるまで待つ。
   *
   * **順序では待たない。** 「N番目に来た」を条件にすると、割り込みが起きない
   * 壊れ方（＝人間が最後に読まれる）でもタイムアウトせずに済んでしまい、歯が
   * 「揃って届いたこと」しか測らなくなる（測りたいのは順序そのもの）。ここでは
   * 「全部届いたか」だけを見て、届いた順序はテスト本体が `findIndex` で確かめる。
   */
  const waitForAllDelivered = (s: Setup, markers: readonly string[]): Promise<void> =>
    waitFor(
      () => markers.every((marker) => (s.calls[0]?.inputs ?? []).join('\n').includes(marker)),
      `${markers.join(' / ')} が全部届く`,
    );

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400));

  const managerMessage = (id: string, managerId: string, text: string): InboxEvent => ({
    type: 'manager_message',
    id,
    at: new Date().toISOString(),
    managerId,
    kind: 'report',
    text,
  });

  const timerEvent = (id: string, kind: string): InboxEvent => ({
    type: 'timer',
    id,
    at: new Date().toISOString(),
    kind,
  });

  // --- 目印（マーカー）の作り方 -------------------------------------------
  //
  // **単純な部分文字列一致だと誤検出する。** タイマー・発意 tick のターンは
  // `#recentDigest` を積むので、**まだ実際には読まれていない、他の待ち行列上の
  // 合図の本文（`text`）まで、そのターンの中に「引き受けたまま終わっていない
  // 仕事」の一覧としてそのまま引用される**（`commitment_list` と同じ台帳を見る
  // ため）。実測: `manager_message` C を投げる前に `timer` B のターンが走ると、
  // B のターンの digest 節に C の `text` がそのまま載り、`text.includes(...)`
  // で C の目印を探すと**C 自身のターンより前に**当たってしまい、順序の検証が
  // 壊れる（本当は正しい実装なのに歯が誤って落ちる／誤って通る）。
  //
  // 対策は、**そのイベント自身が処理されているときにしか現れない複合文字列**を
  // 目印にすること。
  // - `manager_message`: 本物のターンは `managerPrompt` の
  //   `マネージャー ${managerId} から届いた。（報告）\n\n${text}` という並びで
  //   しか現れない。digest の引用は `- evt-x（... / manager / ...）\n  [report]
  //   ${text}` という別の並びなので、「から届いた」を含めれば衝突しない。
  // - `timer`: `定期ジョブ ${kind} の時刻になった` は、そのタイマー自身が
  //   処理されたときにしか現れない（**タイマーは台帳に開かないので、他の
  //   ターンの digest にタイマーが載ることはそもそも無い** — `commitFor` の
  //   doc）。
  // - `human_message`（単発）: 本物のターンの本文は `humanTurnText([event])`
  //   ＝ `text` そのもので、直前には `#commitmentNotice` の区切り `\n\n---\n`
  //   が必ず付く（合図を1件でも受理していれば起こる）。digest の引用は
  //   `\n  ${text}`（2スペース区切り）であって `---\n` ではないので、
  //   `---\n${text}` を目印にすれば衝突しない。
  const managerMarker = (managerId: string, text: string): string =>
    `マネージャー ${managerId} から届いた。（報告）\n\n${text}`;
  const timerMarker = (kind: string): string => `定期ジョブ ${kind} の時刻になった`;
  const humanMarker = (text: string): string => `---\n${text}`;

  /**
   * 蒸留ターンの目印（`buildDistillPrompt` が書く固定の呼びかけ）。`reason` が
   * `conversation_end` でも `shutdown` でも同じ文面へ写る（`clone.ts` の
   * `#handle` の `'distill'` 分岐）ので、この目印だけでは reason を区別できない
   * ——以下の歯はどれも1テストにつき蒸留を1回しか起こさないので、それで足りる。
   */
  const DISTILL_MARKER = '記憶へ移すべきものがあるか確認せよ';

  it('人間の発言は、先に積まれていた人間以外を追い越して先に読まれる', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    // クローンがターンを回している最中（先客）に、待ち行列へ積む。
    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    s.clone.post(managerMessage('evt-mgr-a', 'mgr-a', 'マネージャーAの報告'));
    s.clone.post(managerMessage('evt-mgr-b', 'mgr-b', 'マネージャーBの報告'));
    s.clone.post(timerEvent('evt-timer-c', 'timer-c-kind'));
    s.clone.post(humanMessage('人間の発言だ'));

    const markerHuman = humanMarker('人間の発言だ');
    const markerMgrA = managerMarker('mgr-a', 'マネージャーAの報告');
    const markerMgrB = managerMarker('mgr-b', 'マネージャーBの報告');
    const markerTimer = timerMarker('timer-c-kind');

    await waitForAllDelivered(s, [markerHuman, markerMgrA, markerMgrB, markerTimer]);
    await settle();

    const inputs = s.calls[0]?.inputs ?? [];
    const idxHuman = inputs.findIndex((text) => text.includes(markerHuman));
    const idxMgrA = inputs.findIndex((text) => text.includes(markerMgrA));
    const idxMgrB = inputs.findIndex((text) => text.includes(markerMgrB));
    const idxTimer = inputs.findIndex((text) => text.includes(markerTimer));

    // 全部実際に届いている（見つからない＝-1 を「先」と誤読しない）
    expect(idxHuman).toBeGreaterThan(-1);
    expect(idxMgrA).toBeGreaterThan(-1);
    expect(idxMgrB).toBeGreaterThan(-1);
    expect(idxTimer).toBeGreaterThan(-1);

    // 待ち行列に積まれていた3件の人間以外より、人間の発言が先に読まれる
    expect(idxHuman).toBeLessThan(idxMgrA);
    expect(idxHuman).toBeLessThan(idxMgrB);
    expect(idxHuman).toBeLessThan(idxTimer);

    await s.clone.stop();
  }, 15_000);

  it('人間を挟んでも、人間以外は1件も消えず、人間以外どうしの到着順も保たれる', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    // 人間以外A → 人間以外B → （人間を挟む）→ 人間以外C
    s.clone.post(managerMessage('evt-a', 'mgr-a', '非人間A'));
    s.clone.post(timerEvent('evt-b', '非人間B'));
    s.clone.post(humanMessage('割り込む人間'));
    s.clone.post(managerMessage('evt-c', 'mgr-c', '非人間C'));

    const markerA = managerMarker('mgr-a', '非人間A');
    const markerB = timerMarker('非人間B');
    const markerC = managerMarker('mgr-c', '非人間C');
    const markerHuman = humanMarker('割り込む人間');

    await waitForAllDelivered(s, [markerA, markerB, markerC, markerHuman]);
    await settle();

    const inputs = s.calls[0]?.inputs ?? [];
    const idxA = inputs.findIndex((text) => text.includes(markerA));
    const idxB = inputs.findIndex((text) => text.includes(markerB));
    const idxC = inputs.findIndex((text) => text.includes(markerC));
    const idxHuman = inputs.findIndex((text) => text.includes(markerHuman));

    // (a) 人間以外は3件とも処理される（1件も消えない）
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxC).toBeGreaterThan(-1);

    // (b) 人間以外どうしの到着順（A → B → C）は保たれる
    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);

    // (c) 人間の発言はそれらより先に読まれる
    expect(idxHuman).toBeGreaterThan(-1);
    expect(idxHuman).toBeLessThan(idxA);

    await s.clone.stop();
  }, 15_000);

  it('切ると純粋な先入れ先出しに戻る', async () => {
    const s = setupWithHumanPriority(false, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    // 歯1と同じ並びで post する（人間以外2件 + timer 1件 → 人間の発言）
    s.clone.post(managerMessage('evt-mgr-a', 'mgr-a', 'マネージャーAの報告'));
    s.clone.post(managerMessage('evt-mgr-b', 'mgr-b', 'マネージャーBの報告'));
    s.clone.post(timerEvent('evt-timer-c', 'timer-c-kind'));
    s.clone.post(humanMessage('人間の発言だ'));

    const markerHuman = humanMarker('人間の発言だ');
    const markerMgrA = managerMarker('mgr-a', 'マネージャーAの報告');
    const markerMgrB = managerMarker('mgr-b', 'マネージャーBの報告');
    const markerTimer = timerMarker('timer-c-kind');

    await waitForAllDelivered(s, [markerHuman, markerMgrA, markerMgrB, markerTimer]);
    await settle();

    const inputs = s.calls[0]?.inputs ?? [];
    const idxHuman = inputs.findIndex((text) => text.includes(markerHuman));
    const idxMgrA = inputs.findIndex((text) => text.includes(markerMgrA));
    const idxMgrB = inputs.findIndex((text) => text.includes(markerMgrB));
    const idxTimer = inputs.findIndex((text) => text.includes(markerTimer));

    expect(idxHuman).toBeGreaterThan(-1);
    expect(idxMgrA).toBeGreaterThan(-1);
    expect(idxMgrB).toBeGreaterThan(-1);
    expect(idxTimer).toBeGreaterThan(-1);

    // 切ってあるので到着順のまま。人間の発言は最後に読まれる（追い越さない）
    expect(idxMgrA).toBeLessThan(idxMgrB);
    expect(idxMgrB).toBeLessThan(idxTimer);
    expect(idxTimer).toBeLessThan(idxHuman);

    await s.clone.stop();
  }, 15_000);

  /**
   * **人間どうしは送信順のまま。追い越さない。** 割り込むのは「人間 対 それ以外」の
   * 1段だけで、人間の発言の中では送った順が保たれる（`Inbox#push` の
   * `insertAfterLast` が「最後に一致した要素の**直後**」へ入れるため）。
   *
   * **人間優先が壊しうるものの中で、これは壊してはいけない側である。**
   *
   * **人間が名指しで聞いた性質である**（2026-08-22 JST、逐語）:
   *
   * > 人間が4回割り込んだ際には、**ちゃんと送信順**（当たり前だが、早い方が優先
   * > される）**に割り込まれるようになっていますか？**
   *
   * **だから4件で、しかもクローン全体を通して測る**（`post` から流して、実際に
   * SDK へ渡った並びを見る）。`Inbox` を直接動かす測定では「並べ替えの機構は
   * 送信順を保つ」までしか言えず、**人間が聞いているのは自分の体験のほう**である。
   *
   * **この歯が無いと、実装を「常に先頭へ入れる」に変えても誰も気づかない。**
   * 実測（変異試験 N2、2026-08-22）: `insertAfterLast` の探索を捨てて常に先頭へ
   * 入れる変異を当てたとき、**順序の歯3本はどれも落ちなかった。** 人間が人間以外
   * より前に出ることは変わらないので素通りする。**落ちたのは無関係な既存テスト
   * 1本だけだった。** ＝ **設計としては保たれていたが、測る歯は1本も無かった。**
   */
  it('人間が続けて割り込んでも、人間どうしは送信順のまま（早い方が先）', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    // 人間4件のあいだに人間以外を挟む（挟まっても人間どうしの順は変わらない）。
    s.clone.post(humanMessage('人間1'));
    s.clone.post(managerMessage('evt-mgr', 'mgr-x', 'マネージャーの報告'));
    s.clone.post(humanMessage('人間2'));
    s.clone.post(humanMessage('人間3'));
    s.clone.post(timerEvent('evt-timer', 'timer-kind'));
    s.clone.post(humanMessage('人間4'));

    const markerMgr = managerMarker('mgr-x', 'マネージャーの報告');
    const markerTimer = timerMarker('timer-kind');
    await waitForAllDelivered(s, ['人間1', '人間4', markerMgr, markerTimer]);
    await settle();

    // **4件は隣り合うので1ターンにまとめられる**（`#mergedHumanBatch`）。
    // まとまっても、まとまらなくても、**本文の並びで送信順を見る**。
    //
    // **目印は本文にしか現れない形にする。** 生の `人間1` で探すと、台帳の断り書き
    // に載る id 一覧に当たる。**あの一覧は実際の並び順と無関係に安定した順で出るので、
    // 順序を壊しても検出できない** — 実測（2026-08-22）: 変異 N2「常に先頭へ入れる」
    // を当てたとき、生の目印だとこの歯は**緑のまま通り**、本文だけを見る形に直したら
    // `expected 897 to be less than 858` で落ちた。まとめた本文は `humanTurnText` が
    // `` **(n) <at>**\n\n<text> `` の形で並べるので、`**\n\n` を前置きにする。
    const joined = (s.calls[0]?.inputs ?? []).join('\n');
    const idxOf = (text: string): number => joined.indexOf(`**\n\n${text}`);
    const i1 = idxOf('人間1');
    const i2 = idxOf('人間2');
    const i3 = idxOf('人間3');
    const i4 = idxOf('人間4');
    const idxMgr = joined.indexOf(markerMgr);
    const idxTimer = joined.indexOf(markerTimer);

    expect(i1, '人間1 が本文に見つからない').toBeGreaterThan(-1);
    expect(i2, '人間2 が本文に見つからない').toBeGreaterThan(-1);
    expect(i3, '人間3 が本文に見つからない').toBeGreaterThan(-1);
    expect(i4, '人間4 が本文に見つからない').toBeGreaterThan(-1);
    expect(idxMgr).toBeGreaterThan(-1);
    expect(idxTimer).toBeGreaterThan(-1);

    // **送信順（1 → 2 → 3 → 4）。ここが「常に先頭へ入れる」で反転する。**
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
    expect(i3).toBeLessThan(i4);
    // そのうえで、4件とも人間以外より前に出ている。
    expect(i4).toBeLessThan(idxMgr);
    expect(i4).toBeLessThan(idxTimer);

    await s.clone.stop();
  }, 15_000);

  /**
   * **会話をまたいでも人間どうしは送信順で、まとめは会話の中だけ。** 上の
   * 「送信順のまま」は会話が1つの場合を測っている。ここは**会話が複数ある場合**を
   * 測る — Web UI は会話を別々に作れ（`/chat/<conversationId>`）、人間は複数の
   * 会話を並行して開く。
   *
   * **人間が名指しで聞いた形である**（2026-08-22 JST、逐語）:
   *
   * > 処理待機中→マネージャーAから発言→マネージャーBから発言→ユーザーが新規会話
   * > (会話ID:H)→ユーザーが新規会話(会話ID:I)→ユーザーが追加発言(会話ID:H)→
   * > マネージャーCから発言
   * >
   * > この処理順を教えてほしい
   *
   * **並びが2つの規則の交点で決まるので、片方だけ見ても答えが出ない。**
   *
   * 1. `Inbox#push` の `insertAfterLast(isHumanOriginated)` は**会話 id を見ない**
   *    ので、人間の中は純粋な送信順（H → I → H）。**会話 H の2件目は、先に届いた
   *    会話 I を追い越さない**
   * 2. `#mergedHumanBatch` は「**先頭から連続していて、かつ同じ `conversationId`**」
   *    しか束ねない（`drainWhile`）ので、あいだに会話 I が挟まった会話 H の2件は
   *    **まとまらず、別々のターンで読まれる**
   *
   * **1と2は逆を向いている。** 1は「会話をまたいで1列に並べる」、2は「会話の中
   * でしか束ねない」。**どちらかを変えると、もう一方が黙って変わる** — 会話 H の
   * 2件を束ねるには待ち行列全体から掻き集めるしかなく、その瞬間に会話 I が1ターン
   * 後ろへ下がって規則1（会話をまたぐ送信順）が崩れる。**人間はこの交換を提示された
   * うえで「会話をまたぐと送信順を守るでいい」と決めた**（同日、逐語）。だから
   * **ここで固定しているのは実装の都合ではなく、人間が選んだ側である。**
   *
   * **実装は1文字も変えずにこの歯を足している。** 挙動は #177 の時点で既にこう
   * なっていたが、**測る歯が1本も無かった** — 人間が聞くまで誰も測っていなかった、
   * という #177 と同じ形である（あちらは「人間どうしの送信順」）。
   *
   * **本数（7）まで assert するのは、まとめの有無が本数にしか現れないからである。**
   * 順序（`findIndex`）だけを見ると、会話 H の2件が1ターンに束ねられても
   * 「H1 が I1 より前」は真のまま通る。**規則2が壊れても順序の assert は緑になる。**
   */
  it('会話をまたいでも人間どうしは送信順で、あいだに別の会話が挟まればまとめない', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    // 「処理待機中」＝ 先客のターンが走っている最中。ここへ6件が積み上がる。
    // **走行中のターンは止まらない**（人間優先が縮めるのは待ち行列で待つ時間だけ）。
    s.clone.post(humanMessage('先客', 'conv-0'));
    await waitForFirstTurn(s);

    s.clone.post(managerMessage('evt-mgr-a', 'mgr-A', 'Aの報告'));
    s.clone.post(managerMessage('evt-mgr-b', 'mgr-B', 'Bの報告'));
    s.clone.post(humanMessage('会話Hの1件目', 'conv-H'));
    s.clone.post(humanMessage('会話Iの1件目', 'conv-I'));
    s.clone.post(humanMessage('会話Hの2件目', 'conv-H'));
    s.clone.post(managerMessage('evt-mgr-c', 'mgr-C', 'Cの報告'));

    const markerA = managerMarker('mgr-A', 'Aの報告');
    const markerB = managerMarker('mgr-B', 'Bの報告');
    const markerC = managerMarker('mgr-C', 'Cの報告');
    // **最後に読まれるはずのものが届くまで待つ。** 順序では待たない
    // （`waitForAllDelivered` の doc）。
    await waitForAllDelivered(s, [markerC]);
    await settle();

    const inputs = s.calls[0]?.inputs ?? [];

    // **本数で、まとめが1件も起きていないことを見る。** 先客 ＋ 人間3件 ＋
    // マネージャー3件 ＝ 7本。会話 H の2件が束ねられれば6本になる。
    expect(inputs).toHaveLength(7);

    // **目印は単発ターンの形（`---\n<本文>`）で探す。** 生の本文で探すと、他の
    // ターンの digest に引用された「まだ読まれていない合図」に当たる
    // （`humanMarker` の doc）。まとめられた場合はこの形にならないので、
    // 束ねられた瞬間にここが -1 になって落ちる（本数の assert と二重に効く）。
    const joined = inputs.join('\n');
    const idxH1 = joined.indexOf(humanMarker('会話Hの1件目'));
    const idxI1 = joined.indexOf(humanMarker('会話Iの1件目'));
    const idxH2 = joined.indexOf(humanMarker('会話Hの2件目'));
    const idxA = joined.indexOf(markerA);
    const idxB = joined.indexOf(markerB);
    const idxC = joined.indexOf(markerC);

    expect(idxH1, '会話Hの1件目 が単発ターンとして見つからない').toBeGreaterThan(-1);
    expect(idxI1, '会話Iの1件目 が単発ターンとして見つからない').toBeGreaterThan(-1);
    expect(idxH2, '会話Hの2件目 が単発ターンとして見つからない').toBeGreaterThan(-1);
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxC).toBeGreaterThan(-1);

    // **人間の中は送信順。会話 H の2件目は、先に届いた会話 I を追い越さない。**
    // ここが「同じ会話を待ち行列全体から掻き集める」実装で反転する。
    expect(idxH1).toBeLessThan(idxI1);
    expect(idxI1).toBeLessThan(idxH2);

    // **人間3件は、先に積まれていたマネージャー2件を全部飛び越す。**
    expect(idxH2).toBeLessThan(idxA);

    // **人間以外どうしは到着順のまま。後から届いた C も末尾のままで、餓死しない。**
    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);

    // 会話 H の2件が別々のターンで読まれている（同じターンに同居していない）。
    // **本数の assert とは別の壊れ方を捕まえる** — 片方が落ちて片方が残る形
    // （例: 束ねずに1件を捨てる）だと本数は7のままになりうる。
    const turnOfH1 = inputs.findIndex((text) => text.includes(humanMarker('会話Hの1件目')));
    const turnOfH2 = inputs.findIndex((text) => text.includes(humanMarker('会話Hの2件目')));
    expect(turnOfH1).not.toBe(turnOfH2);

    await s.clone.stop();
  }, 20_000);

  /**
   * Issue #43: 「会話を終える」を押した人間が、非人間のイベント全部の後ろで
   * 待たされていた窓を塞ぐ歯。
   *
   * `endConversation`（`POST /chat/:conversationId/end`。route の doc に
   * 「CLI が chat を抜けるときに叩く」と逐語がある）は `#postAndWait` で
   * `reason: 'conversation_end'` の蒸留を積み、HTTP ハンドラ（`apps/daemon/src/app.ts`）
   * がその完了を `await` してから応答を返す ＝ **人間が画面の前で待っている**。
   * それなのに `#postAndWait` はこれまで常に末尾へ積んでいたので、先に待ち行列に
   * 積まれていた非人間（`timer` / `manager_message` 等）を全部読み終えるまで
   * 人間が待たされていた。
   *
   * **`isHumanOriginated`（`clone.ts:221`）は広げない。** 型を人間起点にすると
   * `stop()` が投げる `reason: 'shutdown'`（プロセス終了時。誰も待っていない）
   * まで人間起点になり、有界性の根拠（`isHumanOriginated` の doc「割り込みは
   * 人間の速さでしか来ない」）が壊れる。直しは呼び出し側 —— `endConversation`
   * だけが `#postAndWait` へ割り込みを頼む形にする。
   */
  it('endConversation の蒸留は、待ち行列にある非人間より先に読まれ、非人間は1件も消えず到着順も保たれる（Issue #43）', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    // 非人間A → 非人間B が先に積まれた状態で、人間が「会話を終える」を押す。
    s.clone.post(managerMessage('evt-mgr-a', 'mgr-a', '非人間A'));
    s.clone.post(timerEvent('evt-timer-b', '非人間B'));
    const endPromise = s.clone.endConversation('conv-1');

    const markerA = managerMarker('mgr-a', '非人間A');
    const markerB = timerMarker('非人間B');

    await waitForAllDelivered(s, [DISTILL_MARKER, markerA, markerB]);
    await settle();
    await endPromise;

    const inputs = s.calls[0]?.inputs ?? [];
    const idxDistill = inputs.findIndex((text) => text.includes(DISTILL_MARKER));
    const idxA = inputs.findIndex((text) => text.includes(markerA));
    const idxB = inputs.findIndex((text) => text.includes(markerB));

    expect(idxDistill).toBeGreaterThan(-1);
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);

    // 待っている人間（HTTP の await）の蒸留が、先に積まれていた非人間2件を追い越す。
    expect(idxDistill).toBeLessThan(idxA);
    expect(idxDistill).toBeLessThan(idxB);

    // 非人間は1件も消えず、到着順（A → B）も保たれる。
    expect(idxA).toBeLessThan(idxB);

    await s.clone.stop();
  }, 15_000);

  it('endConversation の蒸留は、待ち行列にある人間の発言を追い越さない', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    // 人間の発言が先に積まれている状態で、同じ会話が終わる。
    s.clone.post(humanMessage('待っている人間'));
    const endPromise = s.clone.endConversation('conv-1');

    const markerHuman = humanMarker('待っている人間');
    await waitForAllDelivered(s, [markerHuman, DISTILL_MARKER]);
    await settle();
    await endPromise;

    const inputs = s.calls[0]?.inputs ?? [];
    const idxHuman = inputs.findIndex((text) => text.includes(markerHuman));
    const idxDistill = inputs.findIndex((text) => text.includes(DISTILL_MARKER));

    expect(idxHuman).toBeGreaterThan(-1);
    expect(idxDistill).toBeGreaterThan(-1);

    // 先に並んでいた人間の発言を、あとから来た蒸留（人間の待ちであっても）は追い越さない。
    expect(idxHuman).toBeLessThan(idxDistill);

    await s.clone.stop();
  }, 15_000);

  it('stop() の shutdown 蒸留は割り込む（非人間は1件も消えないまま、先に読まれる）', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    // プロセス終了時と同じ形 —— stop() を呼ぶ時点で、非人間が先に積まれている。
    s.clone.post(managerMessage('evt-mgr-a', 'mgr-a', '非人間A'));
    s.clone.post(timerEvent('evt-timer-b', '非人間B'));

    const markerA = managerMarker('mgr-a', '非人間A');
    const markerB = timerMarker('非人間B');

    const stopPromise = s.clone.stop();
    await waitForAllDelivered(s, [markerA, markerB, DISTILL_MARKER]);
    await settle();
    await stopPromise;

    const inputs = s.calls[0]?.inputs ?? [];
    const idxA = inputs.findIndex((text) => text.includes(markerA));
    const idxB = inputs.findIndex((text) => text.includes(markerB));
    const idxDistill = inputs.findIndex((text) => text.includes(DISTILL_MARKER));

    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxDistill).toBeGreaterThan(-1);

    // **かつてここは逆を期待していた**（#43。逐語で残す）——
    //
    //   「プロセス終了で誰も待っていない shutdown 蒸留は、先に積まれていた非人間を
    //     追い越さない（末尾のまま）。endConversation とここが分かれることが本丸。」
    //
    // **Issue #564 (a) で反転した。** 根拠は2つある。
    //
    // 1. **この期待は設計判断の記録ではなかった。** PR #558 の本文自身が逐語で
    //    「旧実装がそもそも『常に末尾』だったので、これらの観点は赤を取れていない
    //    —— 直したことで守られ続けている、という確認に留まる」と書いている。
    //    ⟹ ここが固定していたのは「旧実装がそうだった」であって、「そうあるべき」ではない
    // 2. **「誰も待っていない」は待ち時間の根拠であって、完了性の根拠ではない。**
    //    `apps/daemon/src/index.ts:1049-1050` が
    //    `setTimeout(() => process.exit(0), FORCED_EXIT_MS)`（`FORCED_EXIT_MS` は
    //    55_000。`index.ts:141,152`）を張っているので、行列の後ろで待つ蒸留は
    //    「順番が遅い」のではなく**切られる**（#564 の観測 —— 会話が1区間まるごと失われた）
    //
    // **この歯が本当に守っているものは反転していない。** 上の
    // `waitForAllDelivered(s, [markerA, markerB, DISTILL_MARKER])` が
    // 「非人間が1件も消えない」を押さえており、そこは1文字も変えていない。**変えたのは
    // 順序の向きだけで、アサーションは1つも消していない。**
    expect(idxDistill).toBeLessThan(idxA);
    expect(idxDistill).toBeLessThan(idxB);
  }, 15_000);

  /**
   * Issue #564 (a): `stop()` の shutdown 蒸留も割り込ませる（A-1）。
   *
   * すぐ上の歯（#43 で入れたもの）は `waitForAllDelivered` で「非人間が1件も
   * 消えない」を押さえたうえで順序を見る。**#564 (a) でその順序の向きを反転した**
   * （経緯はそちらのコメントに逐語で残してある）。**ここから下の3本は、反転だけでは
   * 押さえきれない面を足すものである。**
   *
   * - 1本目は反転した上の歯と重なる（順序）。**重複させたまま残す** —— 上は
   *   `waitForAllDelivered` で待ってから順序を見るのに対し、こちらは待たずに
   *   `stop()` の戻りだけを見る。**測っている時点が違う。**
   * - 2本目は「`stop()` から戻った時点で全部が渡っている」と「器に未読が残らない」
   *   —— 割り込ませただけで読み切りを足さないと、ここが落ちる（`clone.ts` の
   *   `await this.#pumpLoop` のコメント）
   * - 3本目は「人間は追い越されない」の見張り
   *
   * 旧挙動の根拠は「誰も画面の前で待っていない」だったが、#564 が現物で示した
   * とおり、それは**待ち時間**の根拠であって**完了性**の根拠ではない。強制終了の
   * 期限（`apps/daemon/src/index.ts:1049-1050` の `setTimeout(() => process.exit(0),
   * FORCED_EXIT_MS)`）が在る以上、行列の後ろで待つ蒸留は「順番が遅い」ではなく
   * **切られる**。
   */
  it('stop() の shutdown 蒸留は、待ち行列にある非人間より先に読まれる（Issue #564）', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    // プロセス終了時と同じ形 —— stop() を呼ぶ時点で、非人間が先に積まれている。
    s.clone.post(managerMessage('evt-mgr-a', 'mgr-a', '非人間A'));
    s.clone.post(timerEvent('evt-timer-b', '非人間B'));

    const markerA = managerMarker('mgr-a', '非人間A');
    const markerB = timerMarker('非人間B');

    await s.clone.stop();

    const inputs = s.calls[0]?.inputs ?? [];
    const idxA = inputs.findIndex((text) => text.includes(markerA));
    const idxB = inputs.findIndex((text) => text.includes(markerB));
    const idxDistill = inputs.findIndex((text) => text.includes(DISTILL_MARKER));

    expect(idxDistill).toBeGreaterThan(-1);
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);

    // shutdown の蒸留が、先に積まれていた非人間2件を追い越す。
    expect(idxDistill).toBeLessThan(idxA);
    expect(idxDistill).toBeLessThan(idxB);
  }, 15_000);

  /**
   * **割り込ませただけでは持ち越しの穴が開く。**
   *
   * `#postAndWait(..., true)` を渡すだけにすると、蒸留は先に読まれるが、待ち行列に
   * 残っていた非人間は**1件もモデルへ届かなくなる**（捨てているのは
   * `#inbox.close()` ではなく `this.#query?.close()` のほう。`Inbox#close()` は
   * 待ち行列を捨てず、`next()` は `#queue.shift()` を先に見る）。だから A-1 は
   * `#pump()` の Promise を保持して、閉じる前に**読み切る**。
   *
   * ここは `waitForAllDelivered` を**使わない。** 使うと「いつかは届く」しか
   * 測れず、`stop()` が読み切ってから戻ることを測れない —— **`stop()` から戻った
   * 時点で**全部が SDK へ渡っていることが、この歯の主張である。
   */
  it('stop() の shutdown 蒸留が割り込んでも、非人間は1件も消えず到着順も保たれる（Issue #564）', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    s.clone.post(managerMessage('evt-mgr-a', 'mgr-a', '非人間A'));
    s.clone.post(timerEvent('evt-timer-b', '非人間B'));

    const markerA = managerMarker('mgr-a', '非人間A');
    const markerB = timerMarker('非人間B');

    await s.clone.stop();

    const inputs = s.calls[0]?.inputs ?? [];
    const idxA = inputs.findIndex((text) => text.includes(markerA));
    const idxB = inputs.findIndex((text) => text.includes(markerB));
    const idxDistill = inputs.findIndex((text) => text.includes(DISTILL_MARKER));

    // 蒸留は割り込んでいる（この歯が測りたい状況であることの前提）。
    expect(idxDistill).toBeGreaterThan(-1);
    expect(idxDistill).toBeLessThan(idxA);

    // それでも非人間は1件も消えず、到着順（A → B）も保たれる。
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxA).toBeLessThan(idxB);

    // 器の側にも未読は残らない（読み切ってから畳んだ ＝ 後始末まで通した）。
    expect((await s.stores.inbox.pending()).count).toBe(0);
  }, 15_000);

  it('待ち行列に人間の発言が先に居るとき、stop() の shutdown 蒸留はそれを追い越さない（Issue #564）', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    // 人間の発言が先に積まれている状態でプロセスが畳まれる。
    s.clone.post(humanMessage('待っている人間'));

    const markerHuman = humanMarker('待っている人間');

    await s.clone.stop();

    const inputs = s.calls[0]?.inputs ?? [];
    const idxHuman = inputs.findIndex((text) => text.includes(markerHuman));
    const idxDistill = inputs.findIndex((text) => text.includes(DISTILL_MARKER));

    expect(idxHuman).toBeGreaterThan(-1);
    expect(idxDistill).toBeGreaterThan(-1);

    // 割り込みの述語は `isHumanOriginated(queued) ||` を含むので、先に並んでいた
    // 人間の発言は shutdown の蒸留に追い越されない。
    expect(idxHuman).toBeLessThan(idxDistill);
  }, 15_000);

  it('humanPriority: false のときは endConversation の蒸留も割り込まない', async () => {
    const s = setupWithHumanPriority(false, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    s.clone.post(managerMessage('evt-mgr-a', 'mgr-a', '非人間A'));
    s.clone.post(timerEvent('evt-timer-b', '非人間B'));
    const endPromise = s.clone.endConversation('conv-1');

    const markerA = managerMarker('mgr-a', '非人間A');
    const markerB = timerMarker('非人間B');

    await waitForAllDelivered(s, [markerA, markerB, DISTILL_MARKER]);
    await settle();
    await endPromise;

    const inputs = s.calls[0]?.inputs ?? [];
    const idxA = inputs.findIndex((text) => text.includes(markerA));
    const idxB = inputs.findIndex((text) => text.includes(markerB));
    const idxDistill = inputs.findIndex((text) => text.includes(DISTILL_MARKER));

    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxDistill).toBeGreaterThan(-1);

    // 切ってあるので純粋な FIFO のまま。蒸留は非人間2件より後ろで読まれる。
    expect(idxA).toBeLessThan(idxDistill);
    expect(idxB).toBeLessThan(idxDistill);

    await s.clone.stop();
  }, 15_000);
});

/**
 * Issue #562 PR-2: `#mergedHumanBatch` は人間の発言しか束ねない。マネージャーから
 * 連続して届いた報告（`kind === 'report'`）は1件ずつ別のターンで読まれ、7本
 * `manager_stop` が届けば7ターン消費する（`manager.ts` の実測、逐語は
 * `grep -Fn -- 'きっかり7ターン' packages/core/src/manager.ts`）。
 *
 * ここは、同じ `managerId` の連続する `report` を1ターンにまとめて読む
 * `#mergedManagerReportBatch` / `#runManagerReportBatch` の歯である。
 *
 * **`manager_message` はどの起点よりも `#emit` が効かない。** `#conversationOf`
 * が `manager_message` に対して常に `null` を返すので（`#handle` の
 * `manager_message` 分岐は内部ターン）、`done` / `error` / `usage_limited` の
 * どれも chat の購読者には届かない（`#emit` は `conversationId === null` を
 * 即 return する）。**だからここでは `waitForEvents`/`waitForTerminal`（chat
 * ストリームを見る）を使わず、`s.calls[0].inputs`（実際に SDK へ渡った入力）を
 * ポーリングして待つ** —— 既存の「歯2: 中身を持つ合図・別の日のタイマーは
 * 畳まれず」ブロックが manager_message を混ぜるときと同じ形である。
 */
describe('クローン — 同じマネージャーの連続する report をまとめて読む（#562）', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  /** 既定は `kind: 'report'`。question/permission の境界を確かめる歯だけ渡す。 */
  const managerMessage = (
    id: string,
    managerId: string,
    text: string,
    kind: 'report' | 'question' | 'permission' = 'report',
    requestId?: string,
  ): InboxEvent => ({
    type: 'manager_message',
    id,
    at: new Date().toISOString(),
    managerId,
    kind,
    text,
    ...(requestId === undefined ? {} : { requestId }),
  });

  /** 直後の書き込み・後続ターンの発火が無いことを確かめるための、短い据え置き。 */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400));

  it('同じマネージャーの連続する report 3件が1ターンにまとめて読まれ、全文が届く', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(managerMessage('r1', 'mgr-batch', '報告1本目'));
    s.clone.post(managerMessage('r2', 'mgr-batch', '報告2本目'));
    s.clone.post(managerMessage('r3', 'mgr-batch', '報告3本目'));

    await waitFor(
      () => s.calls[0]?.inputs[1]?.includes('報告3本目') ?? false,
      'まとめたターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    // **モデル呼び出しは先客 + まとめた1本の計2回。** 3件を別々に読めば4回になる。
    expect(inputs).toHaveLength(2);

    const merged = inputs[1] ?? '';
    expect(merged).toContain('報告1本目');
    expect(merged).toContain('報告2本目');
    expect(merged).toContain('報告3本目');
    // 全文が届いた順に並ぶ（要約していない）。
    expect(merged.indexOf('報告1本目')).toBeLessThan(merged.indexOf('報告2本目'));
    expect(merged.indexOf('報告2本目')).toBeLessThan(merged.indexOf('報告3本目'));

    // **後始末も3件ぶん通る。** 1件でも取りこぼせば器に未読のまま残り続ける
    // （`#forget` の doc）。
    await waitFor(
      async () => (await s.stores.inbox.claimPending()).length === 0,
      '3件とも消し込まれる',
    );

    // **日誌への追記も3件ぶん行われる**（1回にまとめて握り潰していない）。
    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      text: string;
    }[];
    const managerExchanges = exchanges.filter((entry) => entry.with === 'manager');
    expect(managerExchanges.filter((entry) => entry.text.includes('報告1本目'))).toHaveLength(1);
    expect(managerExchanges.filter((entry) => entry.text.includes('報告2本目'))).toHaveLength(1);
    expect(managerExchanges.filter((entry) => entry.text.includes('報告3本目'))).toHaveLength(1);

    await s.clone.stop();
  }, 15_000);

  // **束ねられる報告は、定義上いちばん長く待った報告である。** 単発の経路
  // （`managerPrompt`）にだけ「受け取ってからの経過」が載って、こちらに載らないと、
  // **待った証拠がいちばん要る場所でだけ消える**（#562 PR-1 が入れたもの）。
  it('まとめた本文にも、1件ごとに受け取ってからの経過が載る', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(managerMessage('age1', 'mgr-age', '報告1本目'));
    s.clone.post(managerMessage('age2', 'mgr-age', '報告2本目'));

    await waitFor(
      () => s.calls[0]?.inputs[1]?.includes('報告2本目') ?? false,
      'まとめたターンが投げられる',
    );
    await settle();

    const merged = (s.calls[0] as FakeCall).inputs[1] ?? '';
    // 2件ぶん、それぞれに経過の行が付く（1つに畳んでいない）。
    expect(merged.split('受け取ってから').length - 1).toBe(2);
    // 丸めた値だけでなく、受け取った時刻そのものも併記される
    // （他のタイムスタンプと突き合わせられるように。`describeReportAge` の doc）。
    expect(merged).toContain('受け取った時刻:');

    await s.clone.stop();
  }, 15_000);

  it('間に別のマネージャーの報告が挟まったら、そこで止まる（飛び越えない）', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(managerMessage('a1', 'mgr-A', 'A1本目'));
    s.clone.post(managerMessage('a2', 'mgr-A', 'A2本目'));
    s.clone.post(managerMessage('b1', 'mgr-B', 'B1本目'));
    s.clone.post(managerMessage('a3', 'mgr-A', 'A3本目'));

    await waitFor(
      () => s.calls[0]?.inputs[3]?.includes('A3本目') ?? false,
      '4本目（A3単独）のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    // 先客 + [A1+A2まとめ] + B1 + A3 = 4本。A1〜A3を1本に飛び越して束ねれば3本になる。
    expect(inputs).toHaveLength(4);

    expect(inputs[1] ?? '').toContain('A1本目');
    expect(inputs[1] ?? '').toContain('A2本目');
    expect(inputs[1] ?? '').not.toContain('B1本目');
    expect(inputs[1] ?? '').not.toContain('A3本目');

    expect(inputs[2] ?? '').toContain('B1本目');
    expect(inputs[2] ?? '').not.toContain('A1本目');
    expect(inputs[2] ?? '').not.toContain('A3本目');

    expect(inputs[3] ?? '').toContain('A3本目');
    expect(inputs[3] ?? '').not.toContain('A1本目');
    expect(inputs[3] ?? '').not.toContain('B1本目');

    await s.clone.stop();
  }, 15_000);

  it('連続する report の途中に人間の発言が挟まったら、そこで止まる（人間優先を切って純粋な到着順で確かめる）', async () => {
    // 人間優先を切る理由: 既定だと `insertAfterLast` が人間の発言を待ち行列の
    // 先頭側へ入れ直すので、「呼んだ順」と「並んだ順」がずれる（`Inbox#push` の
    // doc）。ここで確かめたいのは「並んだ順で見て、間に別の起点が挟まったら
    // `drainWhile` が止まる」ことなので、並びを呼んだ順のまま固定する。
    //
    // **A1・A2 は連続していて同じマネージャーなのでまとめ読みの対象になる —
    // それでも間の人間の発言より後ろの A3 まで飛び越して拾ってはいけない。**
    // A1 単独 + human 単独 + A2 単独（3件とも別々のまま）だと、まとめ読みが
    // 無い旧実装でも同じ本数になってしまい、赤にならない。A1+A2 を隣り合わせに
    // 置くことで、「まとめる」と「人間の手前で止める」の両方を同時に測る。
    const s = setup(undefined, createMemoryStores(), {}, { ALTEROID_CLONE_HUMAN_PRIORITY: '0' });

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(managerMessage('a1', 'mgr-A', 'A1本目'));
    s.clone.post(managerMessage('a2', 'mgr-A', 'A2本目'));
    s.clone.post(humanMessage('割り込む人間'));
    s.clone.post(managerMessage('a3', 'mgr-A', 'A3本目'));

    await waitFor(
      () => s.calls[0]?.inputs[3]?.includes('A3本目') ?? false,
      '4本目（A3単独）のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    // 先客 + [A1+A2まとめ] + 人間 + A3 = 4本。
    // まとめ読みが無ければ 先客+A1+A2+人間+A3 の5本になる（＝この本数で赤が見える）。
    expect(inputs).toHaveLength(4);

    expect(inputs[1] ?? '').toContain('A1本目');
    expect(inputs[1] ?? '').toContain('A2本目');
    expect(inputs[1] ?? '').not.toContain('割り込む人間');
    expect(inputs[1] ?? '').not.toContain('A3本目');
    expect(inputs[2] ?? '').toContain('割り込む人間');
    expect(inputs[3] ?? '').toContain('A3本目');
    expect(inputs[3] ?? '').not.toContain('A1本目');
    expect(inputs[3] ?? '').not.toContain('A2本目');

    await s.clone.stop();
  }, 15_000);

  it('question / permission はまとめられない（同じマネージャーの report のすぐ後ろでも止まる）', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(managerMessage('r1', 'mgr-Q', '報告1本目'));
    s.clone.post(managerMessage('r2', 'mgr-Q', '報告2本目'));
    s.clone.post(managerMessage('q1', 'mgr-Q', '質問1本目', 'question', 'req-1'));

    await waitFor(
      () => s.calls[0]?.inputs[2]?.includes('質問1本目') ?? false,
      '3本目（question単独）のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    // 先客 + [report×2まとめ] + question = 3本。
    expect(inputs).toHaveLength(3);
    expect(inputs[1] ?? '').toContain('報告1本目');
    expect(inputs[1] ?? '').toContain('報告2本目');
    expect(inputs[1] ?? '').not.toContain('質問1本目');
    expect(inputs[2] ?? '').toContain('質問1本目');
    expect(inputs[2] ?? '').not.toContain('報告1本目');
    expect(inputs[2] ?? '').not.toContain('報告2本目');
    // question は答え方の経路も示される（既存の `managerPrompt` 分岐がそのまま
    // 通っていることの確認 —— まとめ読みの追加で壊れていないか）。
    expect(inputs[2]).toContain('manager_send');

    await s.clone.stop();
  }, 15_000);

  it('#redelivered に載っている報告はまとめられない（配り直しは単独のまま）', async () => {
    const stores = createMemoryStores();
    const r1 = managerMessage('r1', 'mgr-X', '前回届いた報告1');
    const r2 = managerMessage('r2', 'mgr-X', '前回届いた報告2');
    // 前のプロセスが死んで未読のまま残っていた状況を直接作る（`#restoreUnread` が拾う）。
    await stores.inbox.put(r1, new Date(0).toISOString());
    await stores.inbox.put(r2, new Date(1).toISOString());

    const s = setup(undefined, stores);

    await waitFor(
      () => s.calls[0]?.inputs[1]?.includes('前回届いた報告2') ?? false,
      '2件目（単独）のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    // 2件とも単独のターンで読まれる（まとめれば1本になる）。
    expect(inputs).toHaveLength(2);
    expect(inputs[0] ?? '').toContain('前回届いた報告1');
    expect(inputs[0] ?? '').toContain('これは配り直しである');
    expect(inputs[0] ?? '').not.toContain('前回届いた報告2');
    expect(inputs[1] ?? '').toContain('前回届いた報告2');
    expect(inputs[1] ?? '').toContain('これは配り直しである');
    expect(inputs[1] ?? '').not.toContain('前回届いた報告1');

    await s.clone.stop();
  }, 15_000);

  it('枠で保持した report はまとめ読みの対象から外れる（#heldForUsage）', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultFor: (turnIndex) =>
        turnIndex < 1 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    s.clone.post(managerMessage('r1', 'mgr-Y', '報告1本目')); // turn0: 失敗 → 保持
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 1, '一件目のターンが投げられる');
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === 'r1');
    }, '一件目が未読として保持される');

    s.clone.post(managerMessage('r2', 'mgr-Y', '報告2本目'));
    s.clone.post(managerMessage('r3', 'mgr-Y', '報告3本目'));

    await waitFor(
      () => s.calls[0]?.inputs[2]?.includes('報告3本目') ?? false,
      '2件目・3件目ぶんの入力が投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    // turn0(失敗) + turn1(r1単独の再試行) + turn2(r2+r3まとめ) = 3本。
    expect(inputs).toHaveLength(3);
    expect(inputs[1] ?? '').toContain('報告1本目');
    expect(inputs[1] ?? '').not.toContain('報告2本目');
    expect(inputs[2] ?? '').toContain('報告2本目');
    expect(inputs[2] ?? '').toContain('報告3本目');
    expect(inputs[2] ?? '').not.toContain('報告1本目');

    await s.clone.stop();
  }, 15_000);

  it('1件だけのときは従来どおりの本文のまま（断り書きが載らない）', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(managerMessage('r1', 'mgr-Z', '単独の報告'));

    await waitFor(
      () => s.calls[0]?.inputs[1]?.includes('単独の報告') ?? false,
      '2本目のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(2);
    const solo = inputs[1] ?? '';
    // **`managerPrompt` が出す1件の形をそのまま通していることを見る。**
    // ⚠️ 逐語の完全一致では固定しない ── 本文には #562 PR-1 が入れた「受け取って
    // からの経過」が挟まり、その値は時刻に依存する。ここで見たいのは**まとめ読みの
    // 前置きを足していないこと**なので、単発の経路が持つべき要素の有無で固定する。
    expect(solo).toContain('[system] マネージャー mgr-Z から届いた。（報告）');
    expect(solo).toContain('単独の報告');
    // 単発の経路にも経過は載る（PR-1。まとめた側だけの性質にしない）。
    expect(solo).toContain('受け取ってから');
    expect(solo).toContain(
      '続きが要るなら `manager_send` で指示を出し、要らないなら何もしなくてよい。',
    );
    expect(solo).toContain('学びや判断の基準になったことがあれば記憶へ移すこと。');
    // まとめ読みの前置き（「続けて」「まとめて読んでから」等）が1文字も載らない。
    expect(solo).not.toContain('続けて');
    expect(solo).not.toContain('まとめて読んでから');
    expect(solo).not.toContain('**(1)**');

    await s.clone.stop();
  }, 15_000);
});

/**
 * 割り込める起点の集合そのものを固定する。
 *
 * ## なぜ doc では守れないのか
 *
 * 人間以外が餓死しない理由は**割り込みの量が有界だから**で、有界なのは
 * **割り込めるのが人間の速さでしか来ないものだけ**だからである（`isHumanOriginated`
 * の doc）。`external`（webhook）や `timer` を1つ足すと、**割り込みの量が機械の
 * 速さで決まるようになり、有界性の根拠が消える。**
 *
 * ## この集合は畳み込みの前提でもある（守っているものが2つある）
 *
 * **⚠️ この2つ目は、設計時に意図したものではない。** 人間優先を入れる過程で
 * 「出荷される設定を測る歯が無くなる」を塞ごうとして、初めて見つかった。
 * **だからここには「なぜそう決めたか」の記録が無い** — 探しても出てこないのは
 * 記録漏れではなく、**誰も一度も決めていない**からである。**暗黙の前提がほかにも
 * 在りうると疑うこと。**
 *
 * **tick（`timer` / `self_initiative`）を `true` にすると、tick どうしが並べ替わり
 * うるようになり、畳み込み（`#foldsIntoHeldTick`）が黙って効かなくなる** —
 * 「先に届いた tick が `#deferred` へ入る前に次の tick が処理される」が起こりうる
 * ためで、#168 の歯「発意 tick を続けて送っても、保持する在庫は1件のまま増えない」
 * が守っているものが崩れる。**有界性だけを検討して足さないこと。**
 *
 * **そしてそれは緑のまま起きる。** 順序の歯（上の3本）は有限件数しか流さないので、
 * 集合が広がっても通る。**踏んでも出力に何も出ない**種類の壊れ方なので、doc に
 * 書いておくだけでは守れない（この repo は「読んだのに踏んだ」を何度も記録して
 * いる）。**気づく主体を `vitest` にする。**
 *
 * ## どう守っているか
 *
 * `InboxEvent` は `type` による判別可能な共用体なので、`Record<InboxEventType, …>`
 * にすると**新しい起点が増えた瞬間にコンパイルが落ちる。** 落ちた人は「これは人間
 * 起点か」を宣言させられ、その場で上の doc に当たる。**先例は #159**（画面から
 * 消した状態の数え上げを、テスト側の `Record<ManagerStatus, true>` へ移して
 * 「状態が増えるとコンパイルが落ちる」形にしたもの）。
 */
describe('クローン — 割り込める起点は、人間の速さで来るものだけ（ここが有界性の全体）', () => {
  it('割り込める起点が人間の速さで来るものだけであること（ここが有界性の全体）', () => {
    // **すべての起点について宣言させる。** 起点が増えるとここがコンパイルで落ちる。
    // 落ちたら、足した起点が「人間が待っている合図」かどうかを決めてから足すこと。
    const expected: Record<InboxEventType, boolean> = {
      human_message: true,
      human_answer: true,
      // 以下はすべて false。**機械の速さで来るものを true にしないこと** —
      // した瞬間に割り込みの量が機械の速さで決まり、有界性の根拠が消える。
      manager_message: false,
      external: false,
      timer: false,
      self_initiative: false,
      distill: false,
    };

    // 宣言と実装が一致すること。**`isHumanOriginated` は `type` しか見ない**ので、
    // 他のフィールドは判定に効かない（型を満たすだけの最小限を渡す）。
    for (const [type, isHuman] of Object.entries(expected)) {
      const event = { type, id: `evt-${type}`, at: '2026-08-22T00:00:00.000Z' } as InboxEvent;
      expect(isHumanOriginated(event), `${type} の判定`).toBe(isHuman);
    }

    // **true は2つだけである。** 上の Record を全部 true にする変異を弾く歯で、
    // 個別の一致（上のループ）だけでは「全部 true」を通してしまう。
    expect(Object.values(expected).filter(Boolean)).toHaveLength(2);
  });

  it('未設定・空・空白は既定（有効）で、明示的に切ったときだけ無効になる', () => {
    // **「読めなかった」を「切られた」と読まない。** 緩めると、変数が届かなかった
    // だけの器で人間の待ちが黙って戻る（`resolveCloneHumanPriority` の doc）。
    expect(resolveCloneHumanPriority({})).toBe(true);
    expect(resolveCloneHumanPriority({ ALTEROID_CLONE_HUMAN_PRIORITY: '' })).toBe(true);
    expect(resolveCloneHumanPriority({ ALTEROID_CLONE_HUMAN_PRIORITY: '   ' })).toBe(true);
    expect(resolveCloneHumanPriority({ ALTEROID_CLONE_HUMAN_PRIORITY: 'yes' })).toBe(true);

    for (const off of ['0', 'false', 'off', 'no', 'FALSE', 'Off']) {
      expect(resolveCloneHumanPriority({ ALTEROID_CLONE_HUMAN_PRIORITY: off }), off).toBe(false);
    }
  });
});

/**
 * **台帳で片付け済みの報告に印を付ける**（#391）。
 *
 * ## この describe が守っている性質
 *
 * クローンは、報告が**ターンへ配られる前に**台帳（`commitment_list`）で全文を
 * 読める —— `Clone#post()` は受信箱へ積む**前**に `#commit` を呼ぶからである。
 * だから「読んで答えた」つもりで閉じられ、**その後に来る配達が新規と見分けが
 * 付かない**（#391 で6例観測されている）。
 *
 * ## ⚠️ 「配り直しかどうか」は測っていない
 *
 * この印は配り直しの機構（`#redelivered` / `#redeliveredClosed`）を一切見ず、
 * **台帳が閉じているかだけを見る。** だからこの歯も、初回配達か再配達かを
 * 作り分けていない —— **作り分ける必要が無いことそのものが、この設計の要点で
 * ある。**
 *
 * ## 足場について
 *
 * 台帳の状態は `commitments.get` を差し替えて作る。**`post` してから閉じる形に
 * しないのは、配達との競争になるからである** —— 閉じる前に配られてしまえば、
 * 測りたい状態が作れていないのに緑になる（足場が測定対象と重なる形）。
 */
describe('台帳で片付け済みの報告には印が付く（#391）', () => {
  const REPORT_ID = 'evt-report-closed';

  /** `commitments.get` だけを差し替えた `Stores`。他の面は本物のまま。 */
  function storesWithGet(get: (id: string) => Promise<unknown>): Stores {
    const base = createMemoryStores();
    return {
      ...base,
      commitments: { ...base.commitments, get: get as Stores['commitments']['get'] },
    };
  }

  /** 台帳の1件を組み立てる。`closedAt` を渡さなければ未了。 */
  function commitment(fields: { closedAt?: string; closedReason?: string }) {
    return {
      id: REPORT_ID,
      at: '2026-08-24T00:00:00.000Z',
      origin: 'manager' as const,
      body: '[report] 本文',
      ...fields,
    };
  }

  async function deliverReport(stores: Stores): Promise<string> {
    const s = setup(undefined, stores);
    s.clone.post({
      type: 'manager_message',
      id: REPORT_ID,
      at: new Date().toISOString(),
      managerId: 'mgr-closed',
      kind: 'report',
      text: '本文の前半。……そして後半に依頼が入っている。',
    });
    const inputs = (): string[] => (s.calls[0] as FakeCall).inputs;
    const delivered = await expect
      .poll(() => inputs().find((input) => input.includes('本文の前半')), { timeout: 3000 })
      .toBeTruthy()
      .then(() => inputs().find((input) => input.includes('本文の前半')) ?? '');
    await s.clone.stop();
    return delivered;
  }

  /**
   * **この歯が単独で守るもの**: 閉じている報告に印が付き、**閉じた理由まで運ぶ**こと。
   *
   * 理由を運ぶのは、**誤って閉じたときに誤りが理由の側に出る**からである
   * （実例: 「判断は求めていない」と書いて閉じた報告の本文後半に依頼が在った）。
   */
  it('閉じた報告には印が付き、閉じた理由も一緒に届く', async () => {
    const delivered = await deliverReport(
      storesWithGet(async (id) =>
        id === REPORT_ID
          ? commitment({
              closedAt: '2026-08-24T00:05:00.000Z',
              closedReason: '判断は求めていないので閉じる',
            })
          : null,
      ),
    );

    expect(delivered).toContain('この報告は台帳で既に片付けている');
    expect(delivered).toContain('判断は求めていないので閉じる');
  });

  /**
   * **この歯が単独で守るもの**: **本文を短くしない**こと。
   *
   * #391 が頼んだのは「見分けが付くこと」であって「短くすること」ではない。
   * そして実例（台帳 `801f5ee7`）では、**全文がもう一度届いたからこそ**
   * 「判断は求めていない」と誤って閉じたことに気づけた。**短くすると、その
   * 二度目の機会が消える。**
   */
  it('印が付いても本文は全文のまま届く（二度目の機会を消さない）', async () => {
    const delivered = await deliverReport(
      storesWithGet(async (id) =>
        id === REPORT_ID ? commitment({ closedAt: '2026-08-24T00:05:00.000Z' }) : null,
      ),
    );

    expect(delivered).toContain('本文の前半');
    expect(delivered).toContain('そして後半に依頼が入っている');
    // 閉じた理由が無ければ、括弧ごと出さない（取れない軸に値を作らない）。
    expect(delivered).not.toContain('閉じた理由');
  });

  /**
   * **この歯が単独で守るもの**: 閉じていない報告に印を付けないこと。
   *
   * 付けると「片付け済みだから読まなくてよい」を、**まだ片付けていないものへ**
   * 出すことになる。
   */
  it('閉じていない報告には印が付かない', async () => {
    const delivered = await deliverReport(
      storesWithGet(async (id) => (id === REPORT_ID ? commitment({}) : null)),
    );

    expect(delivered).not.toContain('既に片付けている');
  });

  /**
   * **この歯が単独で守るもの**: 台帳が引けなかったときに**安全側（雑音側）へ**
   * 倒れること。
   *
   * 3値の `'unknown'` は `'open'` の言い換えではないが、**出す文言としては同じ**
   * （ふつうに全文を出す）。**引けなかったことを「閉じている」と読まない。**
   */
  it('台帳が引けなかったら印を付けない（unknown は雑音側へ倒す）', async () => {
    const delivered = await deliverReport(
      storesWithGet(() => Promise.reject(new Error('台帳が読めない'))),
    );

    expect(delivered).toContain('本文の前半');
    expect(delivered).not.toContain('既に片付けている');
  });

  /**
   * **この歯が単独で守るもの**: 印は**本文の後ろ**に出ること。
   *
   * 本文より前に置くと「読まなくてよい」と読まれて本文を飛ばされる ——
   * 本文を残した意味が消える。
   */
  it('印は本文より後ろに出る', async () => {
    const delivered = await deliverReport(
      storesWithGet(async (id) =>
        id === REPORT_ID ? commitment({ closedAt: '2026-08-24T00:05:00.000Z' }) : null,
      ),
    );

    expect(delivered.indexOf('本文の前半')).toBeLessThan(
      delivered.indexOf('この報告は台帳で既に片付けている'),
    );
  });
});

/**
 * マネージャーの報告に「受け取ってから、どれだけ経ったか」を添える（#562）。
 *
 * **実害**: 3件とも、クローンが読んだ時点で対象 PR は既に MERGED だった
 * （「#558 は押せる」等）。報告に時刻も経過も1文字も入らないため、クローンは
 * 自分がいま読んでいる文が何分・何時間前のものかを知る手段が無かった。
 *
 * `event.at` は `Clone#post()` が受理した時点の時刻であって、マネージャーが
 * 書いた時刻ではない——だからここでは「受け取ってから」でしか主張しない。
 */
describe('マネージャーの報告に受け取ってからの経過を添える（#562）', () => {
  /** `manager_message`（report）を投げて、届いた本文を拾う。 */
  async function deliverReport(overrides: { at: string; text?: string }): Promise<string> {
    const s = setup();
    const text = overrides.text ?? '直しました。CIも緑です。';
    s.clone.post({
      type: 'manager_message',
      id: 'evt-age-report',
      at: overrides.at,
      managerId: 'mgr-age',
      kind: 'report',
      text,
    });
    const inputs = (): string[] => (s.calls[0] as FakeCall).inputs;
    const delivered = await expect
      .poll(() => inputs().find((input) => input.includes(text)), { timeout: 3000 })
      .toBeTruthy()
      .then(() => inputs().find((input) => input.includes(text)) ?? '');
    await s.clone.stop();
    return delivered;
  }

  /**
   * **この歯が単独で守るもの**: 経過は閾値を設けず、短くても必ず1行出ること。
   *
   * 閾値で「古いときだけ出す」形にすると、「新しい報告に行が出ない」のと
   * 「この機能自体が無い」のとが出力上で区別できなくなる——`tools.ts` の
   * `describeInboxBacklog`（#562 のもう一方）が0件で行を消していたのと同じ形。
   * ここではその逆を確かめる：**いま受け取ったばかりの報告にも行が出る。**
   */
  it('経過は閾値を設けず、受け取った直後の報告にも必ず1行出る', async () => {
    const at = new Date().toISOString();
    const delivered = await deliverReport({ at });

    // 「書かれた時刻」ではなく「受け取った時刻」の語彙で出ること。
    expect(delivered).toContain('受け取ってから');
    expect(delivered).toContain('経過');
    // 丸めた値だけでなく、`at` そのもの（ISO 文字列）も一緒に出ること
    // （突き合わせができるように）。
    expect(delivered).toContain(at);
  });

  /**
   * **この歯が単独で守るもの**: 経過は秒／分／時間／日を読みやすく丸めること。
   *
   * 3時間前という余裕のある値を使う——テストの実行に数百ms〜数秒かかっても
   * 4時間には届かないので、丸めの結果が揺れない。
   */
  it('経過は時間の単位で読みやすく丸められる', async () => {
    const at = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const delivered = await deliverReport({ at });

    expect(delivered).toContain('約3時間');
  });

  /** 同じ理由で、日の単位でも丸められることを確かめる（5日前）。 */
  it('経過は日の単位でも読みやすく丸められる', async () => {
    const at = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const delivered = await deliverReport({ at });

    expect(delivered).toContain('約5日');
  });

  /**
   * **この歯が単独で守るもの**: 経過の行は本文の後ろ・指示の前に置かれること
   * （#391 の `closedReportNotice` と同じ規則）。
   *
   * 本文より前に置くと「読まなくてよい」と読まれて本文を飛ばされる——
   * その規則をここでも守ること。
   */
  it('経過の行は本文の後ろ・指示の前に置かれる', async () => {
    const text = '経過の位置を確かめる本文';
    const at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const delivered = await deliverReport({ at, text });

    const bodyIndex = delivered.indexOf(text);
    const ageIndex = delivered.indexOf('受け取ってから');
    const instructionIndex = delivered.indexOf('続きが要るなら `manager_send`');

    expect(bodyIndex).toBeGreaterThanOrEqual(0);
    expect(ageIndex).toBeGreaterThan(bodyIndex);
    expect(instructionIndex).toBeGreaterThan(ageIndex);
  });

  /**
   * **この歯が単独で守るもの**: `event.at` が parse できないとき、`NaN` や
   * 「-1分前」のような嘘の値を出さず、取れない理由を書く側へ倒すこと
   * （AGENTS.md「取れない軸に0の行を作る」と同じ考え方）。
   */
  it('at が壊れていたら、嘘の経過を出さず理由を書く', async () => {
    const delivered = await deliverReport({ at: 'これは日時ではない' });

    expect(delivered).not.toContain('NaN');
    // 負の経過（-1分前など）も出さない。
    expect(delivered).not.toMatch(/-\d+(秒|分|時間|日)/);
    expect(delivered).toContain('経過は測れない');
  });

  /**
   * **この歯が単独で守るもの**: `question` / `permission` には経過の行が
   * 載らないこと（この PR は `kind === 'report'` の分岐だけを変える）。
   */
  it('question / permission には経過が載らない', async () => {
    const s = setup();
    s.clone.post({
      type: 'manager_message',
      id: 'evt-age-question',
      at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      managerId: 'mgr-age-q',
      kind: 'question',
      text: '経過を混ぜてはいけない質問',
    });

    const inputs = (): string[] => (s.calls[0] as FakeCall).inputs;
    const delivered = await expect
      .poll(() => inputs().find((input) => input.includes('経過を混ぜてはいけない質問')), {
        timeout: 3000,
      })
      .toBeTruthy()
      .then(() => inputs().find((input) => input.includes('経過を混ぜてはいけない質問')) ?? '');
    await s.clone.stop();

    expect(delivered).not.toContain('受け取ってから');
  });
});

/**
 * 認証トークンのプールの現役をクローンへ届ける口（Issue #393 PR3）。
 *
 * **ここで固定するのは3つ** — 呼ばれるたびに読み直すこと（凍らないこと）、
 * 渡さなければ今までどおりであること、そして**プロファイルが同じ名前を宣言して
 * いると鍵が上書きされること**（塞がない代わりに測っておく）。
 */
describe('credentials（SDK 子プロセスへ重ねる鍵の現在値）', () => {
  let postSeq = 0;

  function cloneWithCredentials(input: {
    credentials?: () => Record<string, string>;
    profileEnv?: Record<string, string>;
    env?: NodeJS.ProcessEnv;
  }) {
    const { fn, calls } = fakeSdk();
    const clone = createClone({
      stores: createMemoryStores(),
      queryFn: fn,
      env: input.env ?? {},
      ...(input.credentials === undefined ? {} : { credentials: input.credentials }),
      ...(input.profileEnv === undefined
        ? {}
        : {
            profile: {
              env: () => input.profileEnv as Record<string, string>,
            } as unknown as Parameters<typeof createClone>[0]['profile'],
          }),
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    return { clone, calls };
  }

  it('渡さなければ、env とプロファイルだけ（既定の構成の挙動を変えない）', async () => {
    const { clone, calls } = cloneWithCredentials({ env: { FROM_ENV: 'yes' } });
    clone.post({
      type: 'human_message',
      id: `evt-cred-${String(++postSeq)}`,
      at: new Date().toISOString(),
      text: 'こんにちは',
      conversationId: 'conv-1',
    });
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env?.FROM_ENV).toBe('yes');
    expect(calls[0]?.options.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('渡した鍵が、凍った env に勝って子へ届く', async () => {
    const { clone, calls } = cloneWithCredentials({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'frozen-at-startup' },
      credentials: () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'rotated-now' }),
    });
    clone.post({
      type: 'human_message',
      id: `evt-cred-${String(++postSeq)}`,
      at: new Date().toISOString(),
      text: 'こんにちは',
      conversationId: 'conv-1',
    });
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    // **凍った env に勝つ。** 順番を逆にすると鍵が回らない（`runner.ts` と同じ規則）。
    expect(calls[0]?.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('rotated-now');
  });

  it('セッションを起こすたびに読み直す（値を持たず関数を持つ理由）', async () => {
    let current = 'first';
    const { clone, calls } = cloneWithCredentials({
      credentials: () => ({ CLAUDE_CODE_OAUTH_TOKEN: current }),
    });
    clone.post({
      type: 'human_message',
      id: `evt-cred-${String(++postSeq)}`,
      at: new Date().toISOString(),
      text: 'こんにちは',
      conversationId: 'conv-1',
    });
    await waitFor(() => calls.length > 0, '1本目のセッションが開くこと');
    expect(calls[0]?.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('first');

    // **走っているセッションには届かない**（env は起動時に凍る）。届くのは
    // 次に起こすセッションからである。
    current = 'second';
    expect(calls[0]?.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('first');
    clone.stop();
  });

  it('⚠️ プロファイルが同じ名前を宣言していると、鍵が上書きされる', async () => {
    // **これは塞いでいない挙動を測る歯である。** 重ね順は `runner.ts` と揃えて
    // あり（プロファイルが鍵より後）、動かすと `GH_TOKEN` のほうが壊れる。
    // 塞ぐのは検出のほう（`credentialNamesShadowedByProfile`）。
    //
    // **測っておく理由は、順序を「直した」つもりで動かす人を止めるためである。**
    // ここが赤くなったら、それは規則が変わったということである。
    const { clone, calls } = cloneWithCredentials({
      credentials: () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'rotated-now' }),
      profileEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'declared-in-profile' },
    });
    clone.post({
      type: 'human_message',
      id: `evt-cred-${String(++postSeq)}`,
      at: new Date().toISOString(),
      text: 'こんにちは',
      conversationId: 'conv-1',
    });
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('declared-in-profile');
  });
});

/**
 * 枠の観測を回し手へ渡す口（Issue #393 PR3）。
 *
 * **ここが固定するのは「何を渡すか」である。** クローンは回すかどうかを判断しない
 * ——判断も選択も撒きも回し手が持つ。
 */
describe('onUsageObservation（回し手へ渡す観測）', () => {
  let seq = 0;

  function cloneObserving(input: {
    sdkOptions?: Parameters<typeof fakeSdk>[1];
    identity?: { tokenId: string; generation: number };
    onObserve?: (o: TokenRotatorObservation) => Promise<void>;
  }) {
    const seen: TokenRotatorObservation[] = [];
    const { fn, calls } = fakeSdk(undefined, input.sdkOptions ?? {});
    const clone = createClone({
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      ...(input.identity === undefined ? {} : { tokenIdentity: () => input.identity }),
      onUsageObservation:
        input.onObserve ??
        (async (o) => {
          seen.push(o);
        }),
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    return { clone, calls, seen };
  }

  function say(clone: ReturnType<typeof createClone>): void {
    clone.post({
      type: 'human_message',
      id: `evt-obs-${String(++seq)}`,
      at: new Date().toISOString(),
      text: 'こんにちは',
      conversationId: 'conv-1',
    });
  }

  it('文言から分類した通知は、そのまま notice として渡る', async () => {
    const { clone, seen } = cloneObserving({
      sdkOptions: {
        resultSubtype: 'error_during_execution',
        resultText: "You've hit your org's monthly spend limit",
      },
    });
    say(clone);
    await waitFor(() => seen.length > 0, '観測が渡ること');
    clone.stop();

    expect(seen[0]?.notice?.kind).toBe('reached');
    // **文言をそのまま持つ**（言い換えると回復の見込みの分類が効かなくなる）。
    expect(seen[0]?.notice?.text).toContain("You've hit your");
  });

  /**
   * **この歯がこの配線でいちばん重い。**
   *
   * `#noteUsageNotice` は `rate_limit_event` 経路からも呼ばれ、そこで
   * `rejectedRateLimitNotice` が `reached` の形の通知を作る。**それを回し手へ
   * `notice` として渡すと、`overage_exhausted` の設定でも課金枠を1円も使わずに
   * 回る**（Issue #393 追記1 の訂正がまさにこの取り違えを直したものである）。
   */
  it('⚠️ rate_limit_event は notice ではなく、事実と遷移で渡る', async () => {
    const { clone, seen } = cloneObserving({
      sdkOptions: {
        rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour' }),
      },
    });
    say(clone);
    await waitFor(() => seen.length > 0, '観測が渡ること');
    clone.stop();

    const observation = seen[0];
    // **notice を持たない。** 持っていたら、それは仕立て直した `reached` である。
    expect(observation).not.toHaveProperty('notice');
    expect(observation?.transition).toBe('rejected');
    expect(observation?.facts?.status).toBe('rejected');
  });

  it('同じ rejected が毎ターン来ても、渡すのは遷移した1回だけ', async () => {
    // `rate_limit_event` はターンの頭ごとに来る。状態をそのまま流すと、1回の
    // 当たりでプールを何本も食う。
    const { clone, seen } = cloneObserving({
      sdkOptions: {
        rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour' }),
      },
    });
    say(clone);
    await waitFor(() => seen.length > 0, '1回目の観測');
    say(clone);
    say(clone);
    await waitFor(() => seen.length > 0, '追加のターン');
    clone.stop();

    expect(seen.filter((o) => o.transition === 'rejected')).toHaveLength(1);
  });

  it('セッションが起きたときの身元を、その観測すべてに添える', async () => {
    const { clone, seen } = cloneObserving({
      identity: { tokenId: 'tok-a', generation: 3 },
      sdkOptions: {
        rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour' }),
      },
    });
    say(clone);
    await waitFor(() => seen.length > 0, '観測が渡ること');
    clone.stop();

    expect(seen[0]?.observedBy).toEqual({ tokenId: 'tok-a', generation: 3 });
  });

  it('身元が無ければ添えない（unknown へ倒すのは回し手の側）', async () => {
    const { clone, seen } = cloneObserving({
      sdkOptions: {
        rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour' }),
      },
    });
    say(clone);
    await waitFor(() => seen.length > 0, '観測が渡ること');
    clone.stop();

    expect(seen[0]).not.toHaveProperty('observedBy');
  });

  it('回し手が投げてもターンを壊さない（別の失敗で上限の報告を置き換えない）', async () => {
    const { clone, calls } = cloneObserving({
      onObserve: () => Promise.reject(new Error('回し手が落ちた')),
      sdkOptions: {
        resultSubtype: 'error_during_execution',
        resultText: "You've hit your org's monthly spend limit",
      },
    });
    say(clone);
    // セッションは開き、ターンは最後まで走る。
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();
    expect(calls.length).toBeGreaterThan(0);
  });
});

/**
 * 認証トークンを回した後のセッション作り直し（Issue #393 PR4）。
 *
 * **Issue が「実装者が決めると必ず壊れる」と名指しした箇所である。** 畳む位置を
 * ターンの境界に置かないと、既定の設定で必ず2つ踏む —— 通るはずだった仕事を殺すか、
 * 回したことが「セッションが終了した」という失敗として依頼者へ届くか。
 */
describe('recycleSessionForToken（回した後のセッション作り直し）', () => {
  let seq = 0;

  /**
   * **読み先行する偽 SDK。** 結果を出す前に、次の入力を取りに行く。
   *
   * ## なぜ専用の偽物が要るか
   *
   * 共有の `fakeSdk` は `for await (const message of prompt)` で1件ずつ処理する
   * ——**ターンが走っているあいだ、入力ストリームに次を要求しない。** ⟹ そこでは
   * `#inputStream` が `#turn !== null` の状態で判定へ到達しないので、
   * **「ターンの境界でだけ畳む」という条件が一度も発火しない。**
   *
   * **実測: 共有の偽物で書いた歯は、変異（`#turn === null` の条件を外す）を
   * 当てても3本とも緑のままだった。** 測っていなかったということである。
   *
   * ここが再現するのは「SDK が読み先行する」形で、**守っている条件が実際に効く
   * 唯一の場面**である。
   */
  function lookaheadSdk(turnDelayMs = 20) {
    const sessions: { inputs: string[] }[] = [];
    const fn = ((params: { prompt: unknown; options?: Options }) => {
      const session = { inputs: [] as string[] };
      sessions.push(session);
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: `sess-lookahead-${String(sessions.length)}`,
          uuid: `uuid-init-${String(sessions.length)}`,
          model: 'claude-fake',
          claude_code_version: '9.9.9-fake',
          apiKeySource: 'user',
          permissionMode: 'default',
          mcp_servers: [{ name: 'alteroid', status: 'connected' }],
        } as unknown as SDKMessage;

        const iterator = (params.prompt as AsyncIterable<{ message: { content: unknown } }>)[
          Symbol.asyncIterator
        ]();

        for (;;) {
          const current = await iterator.next();
          if (current.done === true) return;
          session.inputs.push(String(current.value.message.content));

          // **結果を出す前に次を要求する。** この時点で `#turn` はまだ立って
          // いるので、`#inputStream` は「ターンの境界ではない」と判定しなければ
          // ならない。
          const lookahead = iterator.next();

          await new Promise((resolve) => setTimeout(resolve, turnDelayMs));
          yield {
            type: 'result',
            subtype: 'success',
            result: 'わかった',
            session_id: `sess-lookahead-${String(sessions.length)}`,
            uuid: `uuid-result-${String(session.inputs.length)}`,
          } as unknown as SDKMessage;

          const next = await lookahead;
          if (next.done === true) return;
          // 読み先行で取った分をこのまま処理する。
          session.inputs.push(String(next.value.message.content));
          await new Promise((resolve) => setTimeout(resolve, turnDelayMs));
          yield {
            type: 'result',
            subtype: 'success',
            result: 'わかった',
            session_id: `sess-lookahead-${String(sessions.length)}`,
            uuid: `uuid-result-b-${String(session.inputs.length)}`,
          } as unknown as SDKMessage;
        }
      }
      const generator = generate();
      return Object.assign(generator, {
        close: () => undefined,
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;
    return { fn, sessions };
  }

  function say(clone: ReturnType<typeof createClone>): void {
    clone.post({
      type: 'human_message',
      id: `evt-recycle-${String(++seq)}`,
      at: new Date().toISOString(),
      text: 'こんにちは',
      conversationId: 'conv-1',
    });
  }

  function setupRecycle(sdkOptions: Parameters<typeof fakeSdk>[1] = {}) {
    const { fn, calls } = fakeSdk(undefined, sdkOptions);
    const clone = createClone({
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    return { clone, calls };
  }

  /**
   * **入力ストリームが閉じたら、走っているターンを捨てて終わる偽 SDK。**
   *
   * ## なぜこれが要るか
   *
   * 上の `lookaheadSdk` は、入力が尽きても**そのターンの結果は必ず出す。** ⟹
   * ターンの途中で畳んでも `#turn` は結果の到着で片付き、`#read` の `finally`
   * に届く頃には `null` になっている ——**危険が現れない。**
   *
   * **実測: `lookaheadSdk` だけで書いた歯は、「ターンの境界でだけ畳む」条件を
   * 外す変異を当てても緑のままだった。** 測っていなかったということである。
   *
   * ここが模すのは「**入力の口が閉じた＝畳めという合図**」と読む SDK である。
   * そのとき走っていたターンは結果を返さないので、`#read` の `finally` が
   * `#turn` を見つけて**「クローンのセッションが終了した」を依頼者へ報告する**
   * ——Issue #393 追記5 が名指ししている壊れ方そのものである。
   *
   * **⚠️ 本物の SDK がどちらの側かは測っていない。** この歯が守っているのは
   * 「どちらでも壊れない」ことであって、「本物がこう振る舞う」ではない。
   */
  function abortOnStreamEndSdk(turnDelayMs = 40) {
    const sessions: { inputs: string[] }[] = [];
    const fn = ((params: { prompt: unknown; options?: Options }) => {
      const session = { inputs: [] as string[] };
      sessions.push(session);
      const label = `sess-abort-${String(sessions.length)}`;
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: label,
          uuid: `uuid-init-${label}`,
          model: 'claude-fake',
          claude_code_version: '9.9.9-fake',
          apiKeySource: 'user',
          permissionMode: 'default',
          mcp_servers: [{ name: 'alteroid', status: 'connected' }],
        } as unknown as SDKMessage;

        const iterator = (params.prompt as AsyncIterable<{ message: { content: unknown } }>)[
          Symbol.asyncIterator
        ]();

        for (;;) {
          const current = await iterator.next();
          if (current.done === true) return;
          session.inputs.push(String(current.value.message.content));

          // 読み先行。**入力の口が閉じたら、このターンを捨てて終わる。**
          const lookahead = iterator.next();
          const finished = await Promise.race([
            lookahead.then((next) =>
              next.done === true ? ('closed' as const) : ('next' as const),
            ),
            new Promise<'turn'>((resolve) => setTimeout(() => resolve('turn'), turnDelayMs)),
          ]);
          if (finished === 'closed') return;

          yield {
            type: 'result',
            subtype: 'success',
            result: 'わかった',
            session_id: label,
            uuid: `uuid-result-${String(session.inputs.length)}`,
          } as unknown as SDKMessage;

          const next = await lookahead;
          if (next.done === true) return;
          session.inputs.push(String(next.value.message.content));
          await new Promise((resolve) => setTimeout(resolve, turnDelayMs));
          yield {
            type: 'result',
            subtype: 'success',
            result: 'わかった',
            session_id: label,
            uuid: `uuid-result-b-${String(session.inputs.length)}`,
          } as unknown as SDKMessage;
        }
      }
      const generator = generate();
      return Object.assign(generator, {
        close: () => undefined,
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;
    return { fn, sessions };
  }

  function cloneWith(fn: typeof sdkQuery) {
    return createClone({
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
  }

  /**
   * **受け入れ基準（Issue #393 追記5）**: 回すと決めた時点で走っていたターンが、
   * 最後まで走って結果を返す —— 依頼者に「セッションが終了した」が届かない。
   *
   * **読み先行する偽 SDK でしか測れない**（上の `lookaheadSdk` の doc）。共有の
   * 偽物では、ターン中に入力ストリームへ到達しないので条件が発火しない。
   */
  it('⚠️ ターンの途中では畳まない。走っているターンは最後まで走る', async () => {
    // **捨てる SDK で測る**（`lookaheadSdk` では危険が現れない。あちらの doc）。
    const { fn, sessions } = abortOnStreamEndSdk(40);
    const clone = cloneWith(fn);
    const events: string[] = [];
    clone.subscribe('conv-1', (event) => events.push(event.type));

    say(clone);
    await waitFor(() => sessions.length > 0, 'セッションが開くこと');
    // 読み先行で入力ストリームが判定へ到達している状態で、ターンの途中に回す。
    await new Promise((resolve) => setTimeout(resolve, 10));
    clone.recycleSessionForToken();

    await waitFor(() => events.includes('done'), 'ターンが最後まで走ること');
    await clone.stop();

    // **「クローンのセッションが終了した」が届いていない。**
    expect(events).toContain('done');
    expect(events).not.toContain('error');
  });

  /**
   * **境界で起こさないと、古いセッションのまま止まる。** 読み先行の SDK は、
   * ターンが終わっても自分から取りに来ない（既に要求済みで、その約束が解けるのを
   * 待っている）。
   */
  it('ターンが終わった境界で畳まれ、次は新しいセッションになる', async () => {
    const { fn, sessions } = lookaheadSdk(20);
    const clone = cloneWith(fn);

    say(clone);
    await waitFor(() => sessions.length > 0, '1本目が開くこと');
    clone.recycleSessionForToken();
    // 境界で畳まれるので、次の入力は**新しいセッション**で走る。
    await new Promise((resolve) => setTimeout(resolve, 80));
    say(clone);

    await waitFor(() => sessions.length > 1, '2本目が開くこと');
    await clone.stop();
    expect(sessions.length).toBeGreaterThan(1);
  });

  /**
   * セッションがまだ無いときに印を立てると、**次に作られるセッション（もう新しい
   * 鍵で起きたもの）がいきなり畳まれる。**
   */
  it('セッションがまだ無ければ印を立てない', async () => {
    const { fn, sessions } = lookaheadSdk(5);
    const clone = cloneWith(fn);

    // セッションが1本も無い状態で呼ぶ。
    clone.recycleSessionForToken();

    say(clone);
    await waitFor(() => sessions.length > 0, '1本目が開くこと');
    // **同じセッションが使い回される**（印が立っていれば、ここで2本目になる）。
    await new Promise((resolve) => setTimeout(resolve, 60));
    say(clone);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await clone.stop();

    expect(sessions).toHaveLength(1);
  });

  /**
   * **⭐ 失敗した直後に畳んでも、余計な失敗が1件も増えない。**
   *
   * ## なぜこれを先に固定するのか
   *
   * 文脈窓（プロンプトの長さ）で落ちた回にセッションを畳み直す設計（#553）が、
   * この性質に**丸ごと乗っている。** 乗っている先はここである:
   *
   * - `#apply` の `case 'turn_ended'` は、失敗した `result` に対して
   *   `#reportFailure`（`error` を1件 emit する）を打ち、そのあと `#finishTurn()` を
   *   呼ぶ
   * - `#finishTurn()` は `#turn` を `null` にしてから境界を起こす
   * - ⟹ `#inputStream` が境界で `return` し、`#read` の `finally` に届く頃には
   *   `#turn` は `null` ⟹ `if (turn) { … 'クローンのセッションが終了した' }` が
   *   偽になる
   *
   * **⟹ もしこの順序が崩れると、失敗を1件報告した直後に「セッションが終了した」が
   * 同じ会話へもう1件届く。** 人間から見ると、1回の失敗が2回に見える ——
   * しかも2件目は原因を1文字も持たない。
   *
   * ## ⚠️ 既存の兄弟の歯とは条件が違う
   *
   * 上の「ターンの途中では畳まない」は**成功して終わるターンの途中**で畳む。
   * こちらは**失敗して終わったターンの直後**に畳む。**`#turn` を片付ける経路が
   * 別である**（あちらは結果の到着、こちらは失敗側の `#finishTurn()`）ので、
   * あちらが緑でもこちらは保証されない。
   *
   * **⚠️ この歯は `recycleSessionForToken()`（＝トークンを回す側の引き金）で
   * 畳んでいる。** 文脈窓で畳む引き金はまだ無いので、**固定しているのは
   * 「畳む引き金が何であれ、失敗の直後に畳んでも余計な報告が出ない」という
   * 順序の性質だけである。**
   */
  it('⚠️ 失敗した直後に畳んでも、余計な失敗が増えない（次は新しいセッションで走る）', async () => {
    // **固定値のスタブにしない。** 1本目だけ失敗させ、2本目は通す —— 全ターンを
    // 失敗に固定すると「2本目の失敗」と「余計な報告」が区別できなくなる。
    let failNext = true;
    const { clone, calls } = setupRecycle({
      resultFor: () =>
        failNext ? { subtype: 'success', isError: true, text: 'Prompt is too long' } : undefined,
    });
    const events: string[] = [];
    clone.subscribe('conv-1', (event) => events.push(event.type));

    say(clone);
    await waitFor(() => events.includes('error'), '1本目が失敗すること');
    failNext = false;

    // 失敗の直後に畳む（ターンはもう終わっている ＝ 境界に居る）。
    clone.recycleSessionForToken();
    await new Promise((resolve) => setTimeout(resolve, 80));
    say(clone);

    await waitFor(() => calls.length > 1, '2本目のセッションが開くこと');
    await waitFor(() => events.includes('done'), '2本目が最後まで走ること');
    await clone.stop();

    // **失敗の報告は1件だけ。**2件目（`クローンのセッションが終了した`）が出ない。
    expect(events.filter((type) => type === 'error')).toHaveLength(1);
    // 畳めているので、2本目は別のセッションである。
    expect(calls.length).toBeGreaterThan(1);
  });

  it('クローン全体の停止（stop）とは別物である', async () => {
    // 混ぜると「トークンを回したらクローンが止まる」になる。
    const { clone, calls } = setupRecycle();
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');

    clone.recycleSessionForToken();
    say(clone);

    // 止まっていないので、次のターンが走る。
    await waitFor(() => calls.length > 1, '止まらずに次が走ること');
    clone.stop();
  });
});

/**
 * 蒸留が間に合わなかった区間の検出（Issue #564 の (b)。`distill-gap.ts`）。
 *
 * **歯が固定しているのは「開始ではなく成功で数える」ことである。** 日誌には
 * 蒸留を**始めた**印（`ターンの入力: distill`）が前から在り、そちらを使うと
 * 「開始したが完了しなかった回」——まさに検出したい形——が「蒸留した」として
 * 数えられる。歯2がそこを直接押す（失敗した蒸留では開始の印だけが残り、成功の
 * 印は残らない）。
 */
describe('クローン — 蒸留が間に合わなかった区間の検出', () => {
  /** 「蒸留が成功で終わった」の印（`decision`）だけを拾う。 */
  async function distillSucceededEntries(stores: Stores): Promise<{ decision: string }[]> {
    const entries = (await stores.journal.list({ types: ['decision'] })) as { decision: string }[];
    return entries.filter((entry) => entry.decision.startsWith(DISTILL_SUCCEEDED_DECISION_PREFIX));
  }

  /** 蒸留を**始めた**印（`turnInputEntry` が書く `exchange`）だけを拾う。 */
  async function distillStartedEntries(stores: Stores): Promise<{ text: string }[]> {
    const entries = (await stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    return entries.filter((entry) => entry.text.startsWith('ターンの入力: distill'));
  }

  /**
   * 器を組み立てる前後に1ミリ秒以上の隙間を作る。
   *
   * **待ち合わせではなく境界の作り分けである。** 区間の上端は器が起きた時刻
   * （`JournalQuery.until`。境界を含む）なので、種を仕込んだ行と器の生成が
   * 同一ミリ秒に並ぶと、どちらの側に落ちるかが決まらない。実運用では起きない
   * （器はデーモンの起動時に組み立てられ、最初の合図は人間の速さで来る）が、
   * テストは同一ミリ秒に並びうるので明示的に離す。
   */
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

  it('1: 蒸留が成功で終わったら、日誌にその印が残る', async () => {
    const s = setup();

    s.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');

    // **`stop()` の前に測る。** この時点で印は下りているので、続く `stop()` の
    // 蒸留は正しく見送られ、印は増えない（歯Aの管轄。同じ作法が上の歯Dに在る）。
    const marks = await distillSucceededEntries(s.stores);
    expect(marks.length).toBe(1);
    expect(marks[0]?.decision).toContain('reason=conversation_end');

    await s.clone.stop();
  });

  it('2: 蒸留が失敗して終わったら、成功の印は残らない（開始の印は残る）', async () => {
    const s = setup(undefined, createMemoryStores(), {
      // ターン0＝人間の発言、ターン1＝endConversation の蒸留。**蒸留のターンだけ**
      // を失敗させる（上の歯Cと同じ仕込み）。
      resultFor: (turnIndex) =>
        turnIndex === 1 ? { subtype: 'error_during_execution', isError: true } : undefined,
    });

    s.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(s.events);
    await s.clone.endConversation('conv-1');

    // **開始の印は在る。** これが在るのに成功の印が無い、という組み合わせが
    // 「開始を使っていない」ことの証拠である（開始で数えていれば、この回も
    // 「蒸留した」と読まれてしまう）。
    expect((await distillStartedEntries(s.stores)).length).toBe(1);
    expect(await distillSucceededEntries(s.stores)).toEqual([]);

    await s.clone.stop();
  });

  it('3: ずれが在れば、次のセッションの最初のターンにだけ断り書きが載る', async () => {
    const stores = createMemoryStores();
    // 前のプロセスが蒸留し損ねた活動。**器を組み立てる前に仕込む**（器が起きた
    // 後に書かれた行は、定義上いまの会話の中に在るので数えない）。
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '前のプロセスで話しかけたが、蒸留される前に落ちた',
    });
    await tick();

    const s = setup(undefined, stores);
    await tick();

    s.clone.post(humanMessage('こんにちは'));
    await waitForDone(s.events);

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs[0]).toContain(DISTILL_GAP_NOTICE_HEAD);

    // 2ターン目。`s.events` は conv-1 専用なので別の購読を張る（歯Bと同じ形）。
    const other = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('別件です', 'conv-2'));
    await waitForDone(other.events);

    expect((s.calls[0] as FakeCall).inputs[1]).not.toContain(DISTILL_GAP_NOTICE_HEAD);

    await s.clone.stop();
  });

  it('4: 正常に蒸留して落ちた器の次のセッションでは、断り書きは載らない（毎回鳴らない）', async () => {
    // **仕込みではなく、実際に蒸留を1本走らせて日誌を作る。** 蒸留そのものが
    // 日誌へ書く（開始の印・応答・消費・そして成功の印）うえ、`stop()` の
    // 見送りは**成功の印より後**に書かれる。素朴に「印より後に日誌の行が在るか」
    // で数えると、正常に蒸留して静かに落ちた器でも必ず真になる ＝ 断り書きが
    // 毎回鳴る。ここが偽陽性の本体である。
    const stores = createMemoryStores();
    // **累積を毎回増やす。** 固定値にすると増分が 0 になり、`turn_usage` の行が
    // 最初のターンぶんしか作られない（AGENTS.md「固定値を返すスタブはテストを
    // 緑にしたまま分岐を殺す」）。増やしておけば蒸留のターンぶんの行も出るので、
    // 「蒸留自身の `turn_usage`（`site: 'session'`）を数えていない」ことまで押せる。
    let nth = 0;
    const first = setup(undefined, stores, {
      modelUsage: () => {
        nth += 1;
        return {
          'claude-fable-5': {
            inputTokens: 10 * nth,
            outputTokens: 20 * nth,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.5 * nth,
          },
        };
      },
    });

    first.clone.post(humanMessage('価値観を伝える'));
    await waitForDone(first.events);
    await first.clone.endConversation('conv-1');
    await first.clone.stop();
    await tick();

    // 器の入れ替わり。**同じ日誌の上で**次のセッションを起こす。
    const second = setup(undefined, stores);
    await tick();

    second.clone.post(humanMessage('こんにちは'));
    await waitForDone(second.events);

    expect((second.calls[0] as FakeCall).inputs[0]).not.toContain(DISTILL_GAP_NOTICE_HEAD);

    await second.clone.stop();
  });

  it('5: 成功の印と同じミリ秒に積まれた行を、印より後ろと数えない（境界）', async () => {
    // 活動 → その後に「成功で終わった」印、の順に仕込む。**`at` は器が埋めるので
    // この2行は同じミリ秒に並びうる。** 時刻で窓を切る（`since: 印の時刻`）と
    // 境界を含んでしまい、その蒸留がまさに移した活動を「移されなかった」と数える。
    // 窓は `id` を錨にする `after` で切ってある（`journal-order-with-contract.ts`
    // の契約9 —— 同じミリ秒に積んだ2行をまたいでも飛ばさず重複しない）。
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '前のプロセスで話しかけた',
    });
    await stores.journal.append(distillSucceededEntry('shutdown'));
    await tick();

    const s = setup(undefined, stores);
    await tick();

    s.clone.post(humanMessage('こんにちは'));
    await waitForDone(s.events);

    expect((s.calls[0] as FakeCall).inputs[0]).not.toContain(DISTILL_GAP_NOTICE_HEAD);

    await s.clone.stop();
  });

  it('6: PreCompact のサイドセッションで蒸留が成功したら、reason=pre_compact の印が残る', async () => {
    // **受信箱を通らない別経路である。** `#handle` の `'distill'` 分岐にだけ印を
    // 置くと、「要約の直前に蒸留して、そのまま器が入れ替わった」回が「1度も蒸留
    // していない」と読まれる。
    const s = setup();

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const main = s.calls[0] as FakeCall;
    const dir = await mkdtemp(join(tmpdir(), 'alteroid-distill-gap-'));
    try {
      const transcriptPath = join(dir, 'transcript.jsonl');
      await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
      const hook = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
      if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
      await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
        signal: new AbortController().signal,
      } as never);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const marks = await distillSucceededEntries(s.stores);
    expect(marks.map((mark) => mark.decision)).toEqual([
      `${DISTILL_SUCCEEDED_DECISION_PREFIX} reason=pre_compact`,
    ]);

    await s.clone.stop();
  });

  it('7: `site` が `session` でない `turn_usage` は活動として数えない（蒸留のサイドセッションの分）', async () => {
    // **導出（`deriveDistillGapFromJournal`）へ直に当てる歯である。** 上の6本は
    // クローンのループを通しているが、この条件だけはそこからは押せない ——
    // `site: 'distill'` を書くのは PreCompact のサイドセッションだけで、そこは
    // `#recordUsage` → 成功の印 の順に書くので、その行が**印より後ろ**に来る経路が
    // 器の側に無い（しかも `isSuccessResult` が偽なら両方とも書かれない）。
    // 順序が守ってくれている条件を、基準そのものの側でも1本押さえる。
    const usageEntry = (site: 'session' | 'distill'): JournalEntryInput => ({
      type: 'turn_usage',
      layer: 'clone',
      site,
      managerId: CLONE_ACTOR_ID,
      models: {
        'claude-fable-5': {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUsd: 0.5,
        },
      },
    });

    const stores = createMemoryStores();
    await stores.journal.append(distillSucceededEntry('pre_compact'));
    // 印より**後ろ**に置く。素朴に「印より後に日誌の行が在るか」で数えるなら、
    // これだけで「ずれが在る」になる。
    await stores.journal.append(usageEntry('distill'));
    await tick();

    expect(
      await deriveDistillGapFromJournal(stores.journal, { until: new Date().toISOString() }),
    ).toBeNull();

    // **逆向きも押す。** `site: 'session'` なら数える —— ここが無いと
    // 「`turn_usage` を丸ごと数えない」に変異させても緑のままになる。
    await stores.journal.append(usageEntry('session'));
    await tick();

    const gap = await deriveDistillGapFromJournal(stores.journal, {
      until: new Date().toISOString(),
    });
    expect(gap?.activityCount).toBe(1);
  });

  /**
   * 文面の自己矛盾（Issue #564 続き）。
   *
   * **`describeDistillGap` へ直に当てる歯である**（歯7と同じ当て方 —— この
   * 条件は日誌を仕込んで作るものではなく `DistillGap` の値そのものが決めるので、
   * クローンのループを通さず値を直に組み立てて渡せる）。
   *
   * `deriveDistillGapFromJournal` は窓の下端を `after: { id, at }`（`id` の
   * 錨）で切っているので、印と同じミリ秒に積まれた「印より後ろの行」が正しく
   * 区間の始まりに数えられることがあり、そのとき `firstActivityAt` は
   * `lastDistilledAt` と同じ値になる（`distill-gap.ts` の
   * `describeDistillGap` の doc）。素朴な文面は「それより後」と言いながら
   * 区間の始まりに同じ時刻を出し、読み手には実装が矛盾しているように見える。
   * ここで固定するのは、その場合だけ理由の1文が足されることである。
   */
  it('8: 区間の始まりが蒸留の時刻と同じミリ秒のとき、断り書きにその理由が載る', () => {
    const gap: DistillGap = {
      lastDistilledAt: '2026-08-28T00:00:00.000Z',
      firstActivityAt: '2026-08-28T00:00:00.000Z',
      lastActivityAt: '2026-08-28T00:00:00.500Z',
      activityCount: 1,
      window: 'since_last_distill',
    };

    expect(describeDistillGap(gap)).toContain(
      '**区間の始まりが蒸留の時刻と同じに見えるのは、日誌の時刻がミリ秒までしか' +
        '無いためである。**数えているのは時刻ではなく日誌の並びで、成功の印そのものより' +
        '後ろに積まれた行だけを数えている（印と同じミリ秒でも、印より前に積まれた行は' +
        '数えていない）。',
    );
  });

  /**
   * 上の歯8の裏 —— 時刻が違うときは、その1文が載らない（共通の場合の文面が
   * 太らないことの歯）。歯8を「常に足す」へ弱めて壊すと、この歯だけが落ちる。
   */
  it('9: 区間の始まりが蒸留の時刻と違うとき、その1文は載らない', () => {
    const gap: DistillGap = {
      lastDistilledAt: '2026-08-28T00:00:00.000Z',
      firstActivityAt: '2026-08-28T00:00:00.500Z',
      lastActivityAt: '2026-08-28T00:00:01.000Z',
      activityCount: 1,
      window: 'since_last_distill',
    };

    expect(describeDistillGap(gap)).not.toContain('区間の始まりが蒸留の時刻と同じに見えるのは');
  });
});
