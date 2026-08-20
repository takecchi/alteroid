import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  CLONE_MODEL,
  CLONE_MODEL_ENV_KEY,
  CLONE_PERMISSION_MODE_ENV_KEY,
  createClone,
  placedClonePermissionMode,
  resolveCloneModel,
  resolveClonePermissionMode,
} from './clone.js';
import type { CloneHost } from './host.js';
import { renderMemoryDocuments } from './memory.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createScheduler } from './schedule.js';
import type { ChatStreamEvent } from './schema.js';
import type { Stores } from './store.js';
import { CLONE_ACTOR_ID, isCloneActor } from './usage.js';
import { createCloneMcpServer, createCloneTools } from './tools.js';
import type { ToolContext } from './tools.js';
import {
  captureStderr,
  createMemoryStores,
  failingJournalAppend,
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
    resultFor?: (turnIndex: number) => { subtype?: string; text?: string } | undefined;
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
        mcp_servers: [{ name: 'alteroid', status: 'connected' }],
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
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
        session_id: 'sess-fake',
        uuid: 'uuid-assistant',
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
    expect(text).toContain('分類器が止めた');
    // 許可モードも添える（「なぜ確認が来ないのか」を後から読む人のために）
    expect(text).toContain('auto');
    // **拒否は `tool_use` として数えない** — 使えていない回数を「自分で手を動かした
    // 回数」に混ぜると、digest の材料がそのまま狂う。
    expect(await s.stores.journal.list({ types: ['tool_use'] })).toEqual([]);

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
  function setupCapturing(env: NodeJS.ProcessEnv = {}, stores: Stores = createMemoryStores()) {
    const { fn, calls } = fakeSdk();
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
   * 同時に**跡に本文が乗らないこと**も固定する — 報告本文に `GH_TOKEN` が
   * 全文で出た前例がある（#52）。
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
    const open = await s.stores.commitments.list();
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
    });

    // 跡は残る（「日誌に無い」が「起きなかった」と読めないように）
    expect(stderr.join('')).toContain('利用状況の台帳');

    await s.clone.stop();
  });
});

/**
 * 枠（利用上限）に当たったら、合図を捨てずに保持し、次の合図が来たときに
 * 試し直す（`clone.ts` の `#usageBlocked` / `#deferred`）。
 *
 * タイマーは持たない。「試す」の契機は常に**新しい合図の到着**であり、
 * `post()` が保持していた合図を FIFO の順で受信箱へ戻して解除する。戻した
 * 先頭が枠でまた落ちれば `#usageBlocked` が再び立ち、残りはまた保持される
 * （`#pump` の枠チェック）。
 */
describe('クローン — 枠（利用上限）が閉じたら保持して次の合図で試す', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

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
    // **ここは `s.waitForEvents` へ変えていない。意図的に `expect.poll` のまま
    // 残す。** 変えてみたところ、このすぐ後の `post('三件目')` が高い確率で
    // 二件目を迷子にすることが分かった（実測）。
    //
    // 原因: `s.waitForEvents` は `events` へ push された**その場**で resolve
    // する。だが「terminal が3件になった」（＝二件目の `error` が `#emit`
    // された）時点では、`#pump` の `finally` にある `#settleInboxEvent`
    // （二件目を `#deferred` へ積む後始末）はまだ**非同期の続き**として
    // 走っている最中で、終わっていないことがある
    // （`枠に当たった合図は forget されない` のコメントと同じ理由）。
    // その一瞬に `post('三件目')` が `#usageBlocked` を降ろして
    // `this.#deferred.splice(0)` を読むと、二件目がまだ `#deferred` に
    // 居ないまま素通りされる。`stores.inbox`（永続化された「未読」）は
    // 二件目をずっと pending のまま持ち続けるが、in-memory の `#deferred`
    // には二度と載らないので、二件目は**このプロセスが生きている間
    // 二度と処理されない**まま迷子になる（`done` が3件に届かず、この直後の
    // 待ちが永久にハングする形で発覚した）。
    //
    // `expect.poll` はポーリング間隔（既定内で数回まわる）が、たまたまこの
    // `#settleInboxEvent` の後始末を待つ時間を与えていたので、この隙間が
    // 隠れていた。**これは production 側（`clone.ts` の `post()` と
    // `#settleInboxEvent`/`#deferred` の間の競合）の潜在的な穴であって、
    // この便の範囲（web のテストと2つの同便項目）を超える** — 直すなら
    // `#deferred` への反映と `#usageBlocked` の解除の順序を production
    // コードごと見直す必要があり、ここでは「決定的な待ちへ変える」を
    // 無理に適用せず、`expect.poll` のまま残すことにした。
    await expect.poll(() => s.events.filter(isTerminal).length === 3, { timeout: 3000 }).toBe(true);

    s.clone.post(humanMessage('三件目')); // 保持していた[一件目, 二件目]を戻し、三件目も積む
    // 一件目(turn 2) → 二件目(turn 3) → 三件目(turn 4) の順に実際に投げられ、
    // 今度はすべて成功する（`done` が3件増える）。この2つ目の待ちは、この後
    // さらに `post()` を呼ぶことが無い（`order` の読み取りだけ）ので、
    // `s.waitForEvents` に変えても上のような迷子は起きない。
    await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length === 3);

    // 入力に載ったテキストの出現順で FIFO を確かめる（`redeliveryNotice` /
    // `commitmentNotice` が前置されるので完全一致ではなく部分一致で見る）。
    const order = (s.calls[0] as FakeCall).inputs.map((text) => {
      if (text.includes('一件目')) return '一件目';
      if (text.includes('二件目')) return '二件目';
      if (text.includes('三件目')) return '三件目';
      return '?';
    });
    expect(order).toEqual(['一件目', '一件目', '一件目', '二件目', '三件目']);

    await s.clone.stop();
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
    await waitFor(async () => {
      const exchanges = await stores.journal.list({ types: ['exchange'] });
      return (
        exchanges.filter(
          (entry) =>
            entry.type === 'exchange' &&
            entry.with === 'human' &&
            entry.role === 'outbound' &&
            entry.conversationId === 'conv-1' &&
            entry.text === 'わかった',
        ).length >= 2
      );
    }, '再試行が成功した記録が日誌に残る');

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
    /** 会話に残った、クローンからの1行（assistant の本文 `わかった` は除く）。 */
    const noticesFor = async (stores: Stores) =>
      (await stores.journal.list({ types: ['exchange'] }))
        .filter(
          (entry) =>
            entry.type === 'exchange' &&
            entry.with === 'human' &&
            entry.role === 'outbound' &&
            entry.conversationId === 'conv-1' &&
            entry.text !== 'わかった',
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
