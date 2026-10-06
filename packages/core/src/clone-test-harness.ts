/**
 * `clone.test.ts` から切り出した共有の試験ハーネス（Issue #1744 負債2）。
 *
 * 元は `clone.test.ts` 冒頭のプリアンブルだった。**中身は1文字も変えていない** ——
 * 変えたのは輸出（`export` の追加）と、この行のコメントだけである。分割した
 * 各 `clone-*.test.ts` がここから必要な部品だけを import する。
 */

import { afterEach, expect } from 'vitest';
import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { renderMemoryDocuments } from './memory.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { ChatStreamEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/** `content` の text 部分。配列なら text ブロックを結合する（画像は含めない）。 */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return String(content);
  return content
    .filter((b): b is { type: 'text'; text: string } => (b as { type?: unknown }).type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * SDK を実際に呼ばずにクローンループを検証する。
 *
 * ここで固定したいのは配線と、北極星に由来する不変条件（モデル帯・道具の配置・
 * 蒸留の契機・記憶の載せ方）である。SDK 実呼び出しの確認は手動で行う。
 */
export interface FakeCall {
  options: Options;
  inputs: string[];
  /**
   * 入力ごとの生の `content`（文字列のまま、または text / image ブロックの配列）。
   * `inputs` は常に text 部分だけ（配列なら text ブロックを結合）なので、既存の検査は変わらない。
   */
  inputBlocks?: unknown[];
  /**
   * **この呼び出しが本流のセッションのものか、サイドクエリのものか**（#890）。
   *
   * 見分けは `prompt` の形そのものである —— 本流は入力ストリーム
   * （`AsyncIterable`）で入り、サイドクエリ（蒸留）は**1本の文字列**で入る
   * （`clone.ts` の `#inputStream` と `#distillFromTranscript`）。下の
   * `generate()` も同じ `typeof prompt === 'string'` で枝分かれしている。
   *
   * **控えておかないと、テスト側は「`calls` の最後」でしか本流を指せない。**
   * ⟹ サイドクエリが後から積まれた回に、本流のつもりでサイドクエリを掴む。
   * **そして掴めてしまう** —— 蒸留側の `Options` にも `PostToolUse` は在る
   * （`claude-provider.ts` の `buildCloneDistillOptions`）ので、「フックが
   * 無い」で落ちてくれず、**呼ぶ先が `#onDistillToolUse` に差し替わるだけ**に
   * なる。あちらは `transcript_path` を控えないので、生ログの在り処が
   * 立たないまま畳みへ入り、退避が黙って素通りする（#890 の落ち方）。
   */
  kind: 'session' | 'sideQuery';
}

export function fakeSdk(
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
    /**
     * `result` に載せる `usage`（メインループだけの生の消費。`NonNullableUsage`
     * の写し。`modelUsage` とは別物）。**固定値を返すスタブにしない**（同じ理由）。
     * 省略時は `result.usage` を載せない（既存の呼び出し元の挙動を変えない）。
     */
    resultUsage?: (callIndex: number) => Record<string, unknown> | undefined;
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
     * `Query.getContextUsage()` の返り値を差し替える。**呼び出し番号
     * （`callIndex` — 同一セッション内で `query()` が起きた回。ここは1セッション
     * につき1回しか呼ばれないので、実質「このセッションかどうか」の意味しか
     * 持たない）ごとに変えられる形にしてある**（固定値のスタブにしないための口。
     * `modelUsage` と同じ理由）。**省略時は `getContextUsage` そのものを
     * 実装しない** —— 実機で SDK がこの口を持たない・未接続のときと同じ形で、
     * `clone.ts` の `#observeContextUsage` の `catch` が `error` として拾う経路を
     * 通す。**関数が例外を投げれば、そのまま `getContextUsage()` の reject に
     * なる**（成功・失敗どちらも同じ口で作れる）。
     */
    getContextUsage?: (callIndex: number) => unknown;
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
    const call: FakeCall = {
      options: params.options ?? {},
      inputs: [],
      inputBlocks: [],
      kind: typeof params.prompt === 'string' ? 'sideQuery' : 'session',
    };
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
        const text = contentText(message.message.content);
        call.inputs.push(text);
        (call.inputBlocks ??= []).push(message.message.content);
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
      const resultUsage = options.resultUsage?.(callIndex);
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
        ...(resultUsage === undefined ? {} : { usage: resultUsage }),
        ...(denials === undefined ? {} : { permission_denials: denials }),
      } as unknown as SDKMessage;
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
      ...(options.getContextUsage === undefined
        ? {}
        : { getContextUsage: async () => options.getContextUsage!(callIndex) }),
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, calls };
}

export interface Setup {
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
/**
 * 出来事を溜める配列と、**その配列へ届いた瞬間に同期で解決する待ち**を組にして
 * 返す（#1220）。
 *
 * **なぜ `wireEvents` から切り出したのか。** 購読の仕方は1つではない ——
 * `wireEvents` は張りっぱなしにするが、実物の SSE を模した聞き手
 * （`subscribeLikeChatEndpoint`）は**終端で購読を外す**。そちらを `wireEvents` へ
 * 寄せると、**測っている当のもの（接続が外れること）が消える。**
 *
 * ⟹ **配線の形は呼ぶ側に任せ、観測の部品だけを共有する。** こうしておけば、
 * どんな購読の仕方をしても `waitForDone` / `waitForTerminal` が壁時計を使わずに
 * 済む。⛔ 逆に、ここを通さずに配列を作ると `waitForEventsOf` が拒む（fail-closed）。
 */
export function createEventSink(): {
  events: ChatStreamEvent[];
  push: (event: ChatStreamEvent) => void;
  waitForEvents: Setup['waitForEvents'];
} {
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
  function waitForEvents(
    predicate: (events: readonly ChatStreamEvent[]) => boolean,
  ): Promise<void> {
    if (predicate(events)) return Promise.resolve();
    return new Promise((resolve) => {
      waiters.push({ predicate, resolve });
    });
  }
  eventWaiters.set(events, waitForEvents);
  return {
    events,
    push: (event) => {
      events.push(event);
      notifyWaiters();
    },
    waitForEvents,
  };
}

export function wireEvents(
  clone: CloneHost,
  conversationId: string,
): { events: ChatStreamEvent[]; waitForEvents: Setup['waitForEvents'] } {
  const { events, push, waitForEvents } = createEventSink();
  clone.subscribe(conversationId, push);
  return { events, waitForEvents };
}

/**
 * `wireEvents` が配線した `events` 配列から、その配列を見張る `waitForEvents`
 * を引く台帳（#1220）。
 *
 * **なぜ台帳を挟むのか。** `waitForDone` / `waitForTerminal` は呼び出し側から
 * `events` 配列しか受け取らない（159 箇所）。配列だけでは「誰が push しているか」
 * が分からないので、従来は**壁時計でポーリングするしかなかった**。配線した側で
 * 登録しておけば、呼び出し側を1文字も書き換えずに、**出来事が届いた瞬間に同期で
 * 解決する形**（`Setup.waitForEvents` の doc）へ載せ替えられる。
 *
 * **⛔ 引けなかったら壁時計へ落とさない。** 落とすと、この Issue が塞いだ穴が
 * 「引けなかったとき限定」で静かに戻る（`AGENTS.md`「判定できないという3つ目の
 * 状態を持つ」）。配線されていないことは判定できるので、そのまま拒む。
 */
const eventWaiters = new WeakMap<ChatStreamEvent[], Setup['waitForEvents']>();

export function waitForEventsOf(events: ChatStreamEvent[], label: string): Setup['waitForEvents'] {
  const waitForEvents = eventWaiters.get(events);
  if (waitForEvents === undefined) {
    throw new Error(
      `${label}: この events 配列は wireEvents が配線したものではないので、出来事を` +
        '直接つかむ待ち方ができない。壁時計のポーリングへは落とさない（#1220）。' +
        'events は wireEvents / setup / setupScripted が返したものを渡すこと。',
    );
  }
  return waitForEvents;
}

export function setup(
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
    redeliveryGate: ALWAYS_REDELIVER,
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

/**
 * ちょうど1行だけを取り出して返す（`inbox-backlog.test.ts` の同名ヘルパと
 * 同じ形）。**`toContain` は同じ語が別の行に在ると節ごと消しても緑のまま
 * になる**（AGENTS.md）ので、束の行のような「1行に3つの値を持つ」形を測る
 * ときは、行そのものを取り出して `toBe` で全文一致させる。
 */
export function lineStartingWith(text: string, prefix: string): string {
  const matches = text.split('\n').filter((line) => line.startsWith(prefix));
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

/**
 * **本流のセッションの、最後の呼び出し**（#890）。
 *
 * ⛔ `calls` の末尾をそのまま使わないこと。蒸留のサイドクエリは畳みの後に
 * **遅れて**積まれるので、末尾が本流である保証はどこにも無い —— 実測（#890）で、
 * 蒸留側の生ログ読み取りが数 ms 遅れるだけで末尾がサイドクエリへ入れ替わり、
 * そこから先の待ちが budget を丸ごと使い切って落ちた。**位置ではなく種類で指す。**
 *
 * サイドクエリそのものを掴みたいテストは `calls.at(-1)` のままでよい（あちらは
 * 「直前に自分で起こしたサイドクエリ」を指しており、末尾であることが意味を持つ）。
 */
export function lastSessionCall(calls: FakeCall[]): FakeCall {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i]!;
    if (call.kind === 'session') return call;
  }
  throw new Error('本流のセッションの呼び出しが1本も無い');
}

/**
 * ⛔ **待ちの打ち切りを壁時計で持たない**（#1220）。
 *
 * ## 何が起きていたか
 *
 * ここには `WAIT_BUDGET_MS = 3000` が在り、`waitFor` / `waitForDone` は
 * 「3000ms 経ったら諦める」形だった。**2026-09-12T17:46:25Z、`main` の CI が
 * それで落ちた**（`3ca6397` = PR #909 のマージ。誰も気づかず、直した PR も無い）。
 * 本来の所要は実測 36〜53ms なので budget は 60 倍以上あったが、**器が混めば
 * 60 倍は埋まる。** 埋まったとき、歯は「実装が壊れた」と名乗る。
 *
 * ## なぜ「3000 を大きくする」で直さないのか
 *
 * 確率を下げるだけで、同じ賭けを CI の遅さと引き換えに続けることになる
 * （Issue #1220 の逐語）。⟹ **締め切りそのものを持たない。**
 *
 * ## なぜ「tick 数で締め切る」でも直さないのか（測って落とした案）
 *
 * 壁時計の ms ではなく macrotask の tick 数で締め切れば負荷に依らない、と考えたが、
 * **この歯は本物のタイマーを跨ぐ** —— `fakeSdk` の `delayMs` は 60 / 120 / 150 /
 * 200 / 250 / 1500 ms が実在し、`setTimeout` で本物の遅延を作る
 * （`grep -Fn -- 'delayMs: 1500' packages/core/src/clone-memory-and-commitment-fixes.test.ts`）。tick で回すと、
 * タイマーが発火するまで tick を空回りで使い切る。
 *
 * ## いま残っている締め切りは何か（⚠ 賭けが消えたのではなく、1本に集約された）
 *
 * **vitest 自身の `testTimeout`（`vitest.config.ts` に指定が無いので既定の 5000ms）
 * だけである。** ⟹ 200 本を超える「隠れた 3000ms の賭け」が、**見える 1 本の設定**に
 * なった。⛔ **ここへ新しい締め切りを足し戻さないこと。**
 *
 * ## 諦めたときに何が分かるか
 *
 * 締め切りを外したので、`label` を載せた例外はもう出ない。代わりに**解けていない
 * 待ちの `label` を `afterEach` が stderr へ出す**（下）。⚠️ `process.stdout.write`
 * は使えない —— `vitest.setup.ts` の歯がテストを落とす（#314）。
 */
type PendingWait = { readonly label: string };

const pendingWaits = new Set<PendingWait>();

/**
 * テストの区切り。**待ちの取り消しに使う**（時間ではなく「テストが終わったか」で切る）。
 *
 * 締め切りを外した副作用として、解けない待ちは `setTimeout` を積み続ける ——
 * テストが終わっても回り続けると、次のテストの器を無駄に食う。`afterEach` で
 * 1つ進めておけば、**次の poll で必ず抜ける**（打ち切りの根拠が壁時計ではなく
 * テストの寿命になる）。
 */
let testEpoch = 0;

afterEach(() => {
  testEpoch += 1;
  if (pendingWaits.size === 0) return;
  const labels = [...pendingWaits].map((wait) => wait.label);
  pendingWaits.clear();
  // **stderr であることに意味がある。** 既定の reporter でも出るうえ、
  // `vitest.setup.ts` の stdout の歯を通らない（あちらの doc に逐語で在る）。
  process.stderr.write(
    `⚠️ このテストが終わった時点で、解けていない待ちが ${labels.length} 本ある。` +
      'テストが testTimeout で落ちたなら、落ちた理由はこれである可能性が高い' +
      '（#1220 で壁時計の打ち切りを外したので、待ち自身はもう例外を投げない）:\n' +
      labels.map((label) => `  - ${label}\n`).join(''),
  );
});

/** 非同期の書き込みが器へ届くまで待つ（`post` は同期で返るので待てない）。 */
export async function waitFor(
  check: () => Promise<boolean> | boolean,
  label: string,
): Promise<void> {
  if (await check()) return;
  const epoch = testEpoch;
  const wait: PendingWait = { label };
  pendingWaits.add(wait);
  try {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      // **「起きない」と言い切らない**（#890）。ここで言えるのは「テストが終わる
      // までに起きなかった」までで、**「起きなかった」と「まだ起きていない」は
      // 別である。** 潰すと、次に読む人がこの1行から「そもそも起きない」と読む
      // ⟹ 実際に #890 でその誤診が出ている。
      if (testEpoch !== epoch) {
        throw new Error(`${label} を待っている途中でテストが終わった（待ちは解けていない）`);
      }
      if (await check()) return;
    }
  } finally {
    pendingWaits.delete(wait);
  }
}

/**
 * `expect(...).M(V)` の形のアサーションを、解けるまで待ってから実行する
 * （#1220）。**壁時計の打ち切りを持たない** —— 土台は `waitFor` で、諦める
 * 条件は「テストが終わったか」であって時間ではない。
 *
 * かつて `expect.poll(G, { timeout: 3000 }).M(V)` と書いていた 65 箇所を、
 * ここへ機械的に置き換えてある。**判定の意味は1文字も変えていない** ——
 * 引いたのは打ち切りだけである。
 *
 * `waitFor` の `check` は真偽値を返す必要があるので、ここでは assertion を
 * try/catch して真偽へ変換して渡す。**解けた後にもう一度 assertion を
 * 本当に実行する** —— (1) 失敗したときに通常の diff が出る形を保つため
 * (2) その assertion が vitest に1個の expect として数えられる形を保つため、
 * の両方の理由による（`waitFor` 側の boolean は診断に使わない）。
 */
export async function waitForExpect(
  assertion: () => void | Promise<void>,
  label: string,
): Promise<void> {
  await waitFor(async () => {
    try {
      await assertion();
      return true;
    } catch {
      return false;
    }
  }, label);
  await assertion();
}

/**
 * chat の1往復が終わる（done が届く）まで待つ。
 *
 * **壁時計を1つも使わない** —— `clone.subscribe` の callback から同期で解決する
 * （`Setup.waitForEvents` の doc）。待ち始める前に既に `done` が届いていても
 * 即座に真になるので、追い越しの窓も無い。
 */
export function waitForDone(events: ChatStreamEvent[]): Promise<void> {
  return waitForEventsOf(
    events,
    'done の待ち',
  )((seen) => seen.some((event) => event.type === 'done'));
}

/** ターンの終端（`done` または `error`）。失敗したターンを見るテストで使う。 */
export const isTerminal = (event: ChatStreamEvent): boolean =>
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
export async function waitForTerminal(events: ChatStreamEvent[]): Promise<void> {
  // **壁時計を持たない**（#1220）。`expect.poll` の `timeout` は 3000ms の
  // 打ち切りそのものだったので、`waitForEvents` へ載せ替えてある。
  await waitForEventsOf(events, '終端の待ち')((seen) => seen.some(isTerminal));
}

/**
 * いま JS の microtask キューに積んである継続を、有界回数ぶん先まで進める。
 * **時計は1ミリ秒も使わない**（`setTimeout` を1つも積まない）ので、ここでの
 * 「待つ」は壁時計のポーリングではない——キューが尽きれば早く戻り、尽きて
 * いなくても回数で必ず止まる。
 *
 * ## なぜ要るか（#1220 で `waitForTerminal` を同期の出来事通知へ載せ替えたことで
 * 露出した窓）
 *
 * `#reportFailure`（`clone.ts`）は**まず** `#emit(conversationId, {type:'error',...})`
 * を呼び、人間向けの断り文（`humanText`）を組み立てて `#journal` へ書くのは
 * **そのあと**である（`#usageBlocked` を読んでから書く1行）。`waitForTerminal` が
 * 見ているのは前者（`error` イベント）だけなので、**後者の journal 書き込みが
 * 終わる前に `waitForTerminal` が解決する窓**が実在する。
 *
 * さらに、セッションを終わらせる台本（`endSessionAfterTurn`）を使うテストでは、
 * `#read()` の `for await` が SDK の async generator から `{done:true}` を
 * 受け取って `finally` へ入り、`this.#query = null` を打つまでに何本かの
 * `await` を挟む（`#flushSessionUsage()` など）。**`error` イベントが飛ぶ
 * 時点では、この `finally` はまだ実行されていないことがある**——`stop()` の
 * `if (this.#query)` 分岐（走行中の蒸留を待つかどうか）は、この窓に居るか
 * どうかで結果が変わる。
 *
 * **壁時計でポーリングしていた頃は、この窓を実時間が黙って埋めていた。**
 * `waitForTerminal` / `waitFor` が出来事を同期でつかむ形（#1220）になり、
 * テストの続きがほぼ同じ tick で走るようになったことで、**この窓に入ったまま
 * 次のコードが動く**ことが実測で確認できた（旧 `packages/core/src/clone.test.ts`。いまは
 * `packages/core/src/clone-quota-hold.test.ts`
 * の「受信箱が閉じた後に解除の印が残っていても、受信箱のループを殺さない」が
 * これを踏んで `Test timed out` になっていた——原因は `stop()` が `#query` を
 * まだ非 null と見て蒸留を待ち、その間に届いていた次の合図の解除が先に走って
 * しまい、終端の出来事の数が想定より多くなって最終の `waitForEvents` の述語が
 * 二度と真にならない、という形）。
 *
 * **直し方は「待つ対象そのものを観測する」から外れない。** 壁時計の締め切りを
 * 足し戻すのではなく、**その窓を作っている非同期の継続そのものを先に進めて
 * しまう**——`createMemoryStores()` はメモリ上の実装で実 I/O もタイマーも
 * 使わないので、待っているのは常に microtask の連鎖である。回数は経験的な
 * 上振れ（実測では数回で足りる）に十分な余裕を持たせてあるだけで、**壁時計の
 * 締め切りとは種類が違う**——尽きれば `for` を最後まで回すだけで、それ以上
 * 「諦める」判断も例外も無い（何回目で十分だったかを数えて検査していない）。
 */
export async function flushPendingMicrotasks(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

/**
 * premise の**節の目次の行**（`[節id] 見出し — N 文字`）を、いまストアに在る
 * 本文から組み立てる。**焼き込み・載せ直しに実際に載る形そのものである。**
 *
 * ## なぜ本文ではなくこれで測るのか（人間の決定 2026-09-08）
 *
 * `premise` の焼き込みは**全文からカード（要旨＋節の目次）へ**変わり、本文は
 * 1文字も載らなくなった（`memory.ts` の `renderPremiseCard`）。だから
 * 「人間が書き換えたら次の会話に反映される」（受け入れ基準3）を**本文の文字列
 * が載るか**で測っていた歯は、そのままでは測る対象を失う。
 *
 * **反映は消えていない。反映の現れ方が変わっただけである** —— 節id は
 * `<見出しの8桁>-<sha256(見出し行 + 中身) の先頭8桁>` なので（`memory.ts` の
 * `memorySectionId`）、**本文を1文字直せば節id が変わる。** 文字数も
 * 一緒に載る。⟹ この行が変わったことは「人間の手編集が届いた」ことであり、
 * この行が載っていないことは「その文書は載せ直されていない」ことである。
 *
 * **期待値を手で書き写さない。** 節id はハッシュなので写せば必ず腐る——
 * 焼き込みと同じ関数（`renderMemoryDocuments`）に通した結果から取る。
 *
 * 見出し行（`<!-- memory: … -->`）と要旨の1行は文書によらず同じ形なので、
 * **文書と版を見分けられる行だけ**を返す（入れ子の節はインデントが付くので
 * 行頭の空白を許す）。
 */
export async function memoryCardOutlineLines(stores: Stores, slug: string): Promise<string[]> {
  const doc = (await stores.persona.documents()).find((entry) => entry.slug === slug);
  if (doc === undefined) throw new Error(`記憶に ${slug} が無い`);
  const outline = renderMemoryDocuments([doc])
    .split('\n')
    .filter((line) => /^\s*\[[0-9a-f]{8}-[0-9a-f]{8}\] /.test(line));
  // 0 行のまま返すと、以降の `toContain` / `not.toContain` が1つも走らないまま
  // 緑になる（測っていないのに測ったことになる形）。
  if (outline.length === 0) throw new Error(`${slug} のカードに節の目次が無い`);
  return outline;
}

/**
 * 起動時に拾い直した合図を、明示的に解くまで握ったままにする偽 SDK。
 *
 * **時間で近似しない**（`describe('クローン — 発言を受理した瞬間の記録と
 * 合図')` の `fakeGatedSdk` と同じ理由・同じ形——「1件目のターンが走って
 * いるあいだに、もう1件が待ち行列に残っている」という順番待ちの窓を
 * `delayMs` の綱引きに賭けない）。
 */
export function fakeGatedSdk() {
  const calls: FakeCall[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const call: FakeCall = {
      options: params.options ?? {},
      inputs: [],
      inputBlocks: [],
      kind: typeof params.prompt === 'string' ? 'sideQuery' : 'session',
    };
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
        call.inputs.push(contentText(message.message.content));
        (call.inputBlocks ??= []).push(message.message.content);
        await gate;
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
    /** 握っていたターンを解く。以降のターンはこの1回だけ解けば済み、あとは
     * この `describe` の中では止めない（この `fn` を使うテストは各1回しか
     * ターンを起こさない、か、2本目以降は解いたあとに届くので `gate` は
     * 既に解決済みのまま素通りする）。 */
    release: () => release(),
  };
}
