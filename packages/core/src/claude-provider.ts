import type {
  CanUseTool,
  HookCallback,
  McpServerConfig,
  Options,
  SDKMessage,
  SessionStore,
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  AgentContentBlock,
  AgentEvent,
  AgentPermissionDenial,
  AgentRuntimeFacts,
  AgentTurnUsage,
} from './agent-events.js';
import type { AgentProvider } from './agent-ports.js';
import type { PermissionModeName } from './permission-mode.js';
import { resultErrorLines, resultFailureOf } from './sdk-failure.js';
import { CLONE_ALLOWED_TOOLS, MCP_SERVER_NAME } from './tools.js';
import { classifyUsageNotice, toRateLimitFacts } from './usage-limits.js';
import { isSuccessResult, modelUsageOf } from './usage.js';

/**
 * **Claude という provider の形を知っているのはこのファイルだけにする。**
 *
 * 向きが2つある。
 *
 * | 向き | 何をするか | 出入口 |
 * | --- | --- | --- |
 * | 書き側 | `Options`（SDK へ渡すセッション設定）を組み立てる | `buildCloneSessionOptions` / `buildCloneDistillOptions` / `buildManagerSessionOptions` |
 * | 読み側 | SDK のメッセージを中立イベントへ写す | `foldClaudeMessage`（→ `agent-events.ts`） |
 *
 * **provider を足すときに触る場所を1つにする**ための置き場であって、いま
 * provider は Claude だけである。呼び出し側（`clone.ts` / `runner.ts`）が持つ
 * インスタンスの状態・副作用のある前処理（記憶ドキュメントを読む・観測値を
 * 控える・実行環境プロファイルを重ねるなど）はここへは移さない — ここは
 * 「渡された値をどこへ置くか」と「届いた値が何を意味するか」だけを知っている
 * 純関数の集まりである。
 */

/** PreCompact フック内の蒸留に許す時間（秒）。超えたら compaction を待たせない。 */
export const PRE_COMPACT_HOOK_TIMEOUT_SECONDS = 120;

/** いま alteroid が実際に使っている唯一の provider。capabilities は10個すべて true。 */
export const CLAUDE_PROVIDER: AgentProvider = {
  id: 'claude',
  displayName: 'Claude',
  capabilities: {
    permissions: true, // runner.ts の #onPermission（canUseTool）
    toolAudit: true, // clone.ts の #onPostToolUse・#onDistillToolUse / runner.ts の #onPostToolUse（PostToolUse フック）
    compactionHook: true, // clone.ts の #onPreCompact / runner.ts の #onPreCompact（PreCompact フック）
    resume: true, // buildCloneSessionOptions / buildManagerSessionOptions の Options.resume
    sessionLog: true, // buildCloneSessionOptions / buildManagerSessionOptions の Options.sessionStore
    subagents: true, // buildManagerSessionOptions の Options.agents（runner.ts の WORKER_AGENT_NAME）
    mcpServers: true, // Options.settingSources + インプロセス MCP（tools.ts の createCloneMcpServer）
    childUser: true, // buildManagerSessionOptions の Options.spawnClaudeCodeProcess（runner.ts の #spawnAsChildUser）
    usage: true, // clone.ts / runner.ts の #recordUsage（result.modelUsage）
    partialMessages: true, // buildCloneSessionOptions の Options.includePartialMessages
  },
};

// ---------------------------------------------------------------------------
// A. クローン本セッション
// ---------------------------------------------------------------------------

export interface CloneSessionOptionsRequest {
  model: string;
  permissionMode: PermissionModeName;
  /** クローンの道具（インプロセス MCP）。呼び出し側が `mcpServerFactory` で組み立てて渡す。 */
  mcpServer: McpServerConfig;
  systemPrompt: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** `#stores.sessions.getCloneSessionId()` の結果そのまま。`null` なら resume 素材が無い。 */
  resume: string | null;
  sessionStore?: SessionStore;
  onPreCompact: HookCallback;
  onPostToolUse: HookCallback;
}

/** クローン本セッションへ渡す `Options`。組み立ての知識は `clone.ts` の旧 `#buildOptions` から移した。 */
export function buildCloneSessionOptions(request: CloneSessionOptionsRequest): Options {
  const {
    model,
    permissionMode,
    mcpServer,
    systemPrompt,
    env,
    cwd,
    resume,
    sessionStore,
    onPreCompact,
    onPostToolUse,
  } = request;

  return {
    model,
    // **`tools` を渡さない ＝ preset 一式。** 明示リストで絞れば能力の削除に
    // なり、それは層を問わず禁じられている（AGENTS.md 地雷1・7 / north_star
    // 「適用範囲」）。委譲が原則である理由（長寿命セッションの俯瞰と判断を守る）
    // は方針＝システムプロンプトで表す（`prompt.ts`）。
    //
    // **`allowedTools` は「確認なしで通す一覧」であって「使える道具の一覧」では
    // ない**（SDK: "To restrict which tools are available, use the `tools`
    // option instead."）。だからここに自作ツールだけを並べても組み込みツールは
    // 1つも減らない。並べてあるのは、自分の道具が権限の判断に晒されないように
    // するためである。
    allowedTools: CLONE_ALLOWED_TOOLS,
    // 人間が開く Claude Code と同じ既定（`auto`）。**`default` のまま道具を渡すと
    // 「渡したのに使えない」になる** — このセッションには `canUseTool` が無く、
    // SDK は確認相手が居ないとき `ask` の判断をそのまま拒否で終わらせる。
    //
    // **`canUseTool` は繋がない（クローンだけはマネージャーと事情が違う）。**
    // クローンは長寿命セッション1本で、受信箱のすべてのターンがそこを直列に
    // 通る。ここで人間の回答を待って止めれば、止まるのは待っている1件ではなく
    // 全部である（PRD「自律」の「止まるのはその仕事だけ」が壊れる）。確認が
    // 要ると判断したなら `ask_human` に積んでから手を動かすのが、この層での
    // 権限境界の表し方である（PRD「権限境界」）。
    permissionMode,
    mcpServers: {
      [MCP_SERVER_NAME]: mcpServer,
    },
    systemPrompt,
    // **人間が使っているのと同じ設定・同じ `.mcp.json` を読む。** ここを `[]` に
    // すると、人間が Claude Code で使っている MCP 連携がクローンからは1つも
    // 見えない ＝ 能力の削除（AGENTS.md 地雷7 の後半 / PRD「業務範囲」の
    // 「人間が使っている連携が、クローンと作業者からも使えること」）。
    settingSources: ['user', 'project', 'local'],
    // 参照系は `.claude/skills/` に置いてある（AGENTS.md「書く先を決める」）。
    // **`'all'` を明示する。** 省くと SDK 側は何も設定せず CLI の既定に委ねる
    // ことになり、器によって引けるものが変わる。**名前の列挙で絞らないのは
    // 地雷1と同じ理由**で、スキルが増えたときに自動で追いつかせるためである。
    skills: 'all',
    // 人間が置いた実行環境プロファイルを、クローンの手にも効かせる。
    env,
    includePartialMessages: true,
    ...(cwd === undefined ? {} : { cwd }),
    ...(resume === null ? {} : { resume }),
    // セッションの生ログも記憶ストアと同じ PostgreSQL へ（M4）。器を作り直しても
    // resume の素材が残る。**同一性はそれでも記憶に宿る** — ここが空でも、
    // 記憶と日誌が同じならクローンは同じクローンである。
    ...(sessionStore === undefined ? {} : { sessionStore }),
    hooks: {
      PreCompact: [
        {
          timeout: PRE_COMPACT_HOOK_TIMEOUT_SECONDS,
          hooks: [onPreCompact],
        },
      ],
      // `self_status` の effort と、**クローンが自分の手を使った跡**をここで拾う
      // （後者は `#onPostToolUse` のコメント）。
      //
      // 1. **`PostToolUse` はツールの実行後に走るので、実行そのものを止められない**
      //    （`PreToolUse` と違ってここで判断を差し込む余地が無い＝観測専用として
      //    安全に足せる）。
      // 2. **`PreCompact` はセッション生涯に対して1本のフックであり、effort は
      //    載らない**（`BaseHookInput.effort` はツール実行の文脈で発火するフックに
      //    しか付かない）。だから既存の `PreCompact` はそのままにし、別の枠へ足す。
      // 3. **クローンは毎ターン MCP の道具を叩く。** `self_status` を呼ぶ時点までに
      //    別の道具呼び出しが1本挟まっていれば、その回で観測済みになっている。
      //    **例外はそのセッションで最初の道具呼び出しそのもの** — そのときはまだ
      //    どの `PostToolUse` も発火しておらず `effort` は `null` のままである
      //    （`CloneRuntimeFacts.effort` のコメントと同じ）。
      PostToolUse: [
        {
          hooks: [onPostToolUse],
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// B. クローンの蒸留サイドクエリ
// ---------------------------------------------------------------------------

export interface CloneDistillOptionsRequest {
  model: string;
  permissionMode: PermissionModeName;
  mcpServer: McpServerConfig;
  systemPrompt: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  onPostToolUse: HookCallback;
}

/** 蒸留のサイドクエリへ渡す `Options`。組み立ての知識は `clone.ts` の旧 `#distillFromTranscript` から移した。 */
export function buildCloneDistillOptions(request: CloneDistillOptionsRequest): Options {
  const { model, permissionMode, mcpServer, systemPrompt, env, cwd, onPostToolUse } = request;

  return {
    model,
    // **本セッションと同じ配置にする。** 片方だけ道具や設定が違うと、
    // 人格の書き手（蒸留）だけが別の頭になる（モデル帯を揃えているのと
    // まったく同じ理由）。理由は `buildCloneSessionOptions` 側に書いてある。
    allowedTools: CLONE_ALLOWED_TOOLS,
    permissionMode,
    mcpServers: {
      [MCP_SERVER_NAME]: mcpServer,
    },
    systemPrompt,
    settingSources: ['user', 'project', 'local'],
    // 蒸留のターンも同じものを引ける（本セッションと道具を揃えてある）。
    skills: 'all',
    env,
    persistSession: false,
    ...(cwd === undefined ? {} : { cwd }),
    // **監査もこちら側に要る。** 道具と許可モードを本セッションと揃えた以上、
    // 記録だけ片方に無ければ「蒸留のターンで何をしたか」がどこにも残らない
    // （docs/architecture.md「PostToolUse フックで全ツール実行を日誌に記録」）。
    // **effort の観測はここでは意味を持たない**（別セッションの値なので
    // `#effort` を汚さないよう、日誌だけを書く枝を通す）。
    hooks: {
      PostToolUse: [{ hooks: [onPostToolUse] }],
    },
  };
}

// ---------------------------------------------------------------------------
// C. マネージャー（runner 側）
// ---------------------------------------------------------------------------

export interface ManagerSessionOptionsRequest {
  model: string;
  permissionMode: PermissionModeName;
  systemPromptAppend: string;
  /** 作業者層の本体1個だけを置く agents レコードの key（runner.ts の `WORKER_AGENT_NAME`）。 */
  workerAgentName: string;
  workerPrompt: string;
  workerModel: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  sessionStore: SessionStore;
  resume?: string;
  spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
  canUseTool: CanUseTool;
  onPostToolUse: HookCallback;
  onPreCompact: HookCallback;
  /**
   * ターンの開始を数える観測専用のフック（`worker_wait`）。
   *
   * **optional にしない。** 省略できる形にすると、provider を足す側が「渡さない」
   * ことで観測を静かに落とせる（可観測性は要件である。PRD「可観測性」）。
   */
  onUserPromptSubmit: HookCallback;
  /**
   * 作業者セッションが停止した瞬間の背景処理の在り高を観測する専用フック
   * （#357 の実測口）。
   *
   * **optional にしない。理由は直上の `onUserPromptSubmit` と同じ** —
   * 省略できる形にすると、provider を足す側が「渡さない」ことで観測を静かに
   * 落とせる（可観測性は要件である。PRD「可観測性」）。中身は `runner.ts` の
   * `#onSubagentStop` の doc を見よ。
   */
  onSubagentStop: HookCallback;
}

/** マネージャーへ渡す `Options`。組み立ての知識は `runner.ts` の旧 `#buildOptions` から移した。 */
export function buildManagerSessionOptions(request: ManagerSessionOptionsRequest): Options {
  const {
    model,
    permissionMode,
    systemPromptAppend,
    workerAgentName,
    workerPrompt,
    workerModel,
    cwd,
    env,
    sessionStore,
    resume,
    spawnClaudeCodeProcess,
    canUseTool,
    onPostToolUse,
    onPreCompact,
    onUserPromptSubmit,
    onSubagentStop,
  } = request;

  return {
    // 既定は `opus`。人間が `ALTEROID_MANAGER_MODEL` に置いていればそれを使う
    // （設定ではなく承認の置き場。`model-tier.ts`）。**ここが正本である** —
    // デーモン側の自己認識に出るのは同じ env から解いた宣言であって、
    // 実際にセッションへ渡っているのはこの値である。
    model,
    // `tools` は渡さない = preset 全部。明示リストで絞らない（AGENTS.md 地雷1）。
    // `maxTurns` も渡さない（地雷2）。
    // 人間が開く Claude Code と同じ既定（Auto）。`canUseTool` は下に残してあり、
    // `default` へ戻せば1件ずつクローンへ確認が回る。
    permissionMode,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: systemPromptAppend,
    },
    // 作業者層の本体はこの1個だけ。`tools` を書かない = 親の全ツールを継承。
    agents: {
      [workerAgentName]: {
        description:
          'コストと文脈のために切り出した実作業の担い手。実装に限らず、調査・下読み・' +
          '外部サービスの確認・レビュー・相談のたたき台づくりまで任せてよい。',
        prompt: workerPrompt,
        // **省略しない。** SDK の既定は親（マネージャー）の継承なので、
        // 省けばマネージャーを差し替えた人が作業者まで巻き添えで動かすことになる。
        model: workerModel,
      },
    },
    cwd,
    // 人間が使っているのと同じ設定・同じ .mcp.json を渡す（下向きは同じものが見える）
    settingSources: ['user', 'project', 'local'],
    // 参照系は `.claude/skills/` に置いてある（AGENTS.md「書く先を決める」）。
    // **`'all'` を明示する。** 省くと SDK 側は何も設定せず CLI の既定に委ねる
    // ことになり、器によって引けるものが変わる。名前の列挙で絞らないのは
    // 地雷1と同じ理由で、スキルが増えたときに自動で追いつかせるためである。
    //
    // **上の `agents`（作業者）側には `skills` を書かない。**
    // `AgentDefinition.skills` は `'all'` を受けず名前の配列しか取れないので、
    // 書けば「明示リストで絞る」（地雷1）になり、スキルが増えても追いつかない。
    // しかもあちらは *preload* なので、書いた分だけ作業者の文脈へ先に載る
    // ＝ 畳んだ意味が消える。
    skills: 'all',
    env,
    // 生ログはデーモンへ預ける。runner は永続化の器を持たない（記憶ストアの
    // 鍵を runner に置かないため）。
    sessionStore,
    ...(resume === undefined ? {} : { resume }),
    // 子プロセスを別 UID へ降ろす。**能力は1つも削らない** — 道具も preset も
    // そのままで、変えるのは実行する主体だけである（実行環境の境界）。
    ...(spawnClaudeCodeProcess === undefined ? {} : { spawnClaudeCodeProcess }),
    canUseTool,
    hooks: {
      PostToolUse: [{ hooks: [onPostToolUse] }],
      PreCompact: [{ hooks: [onPreCompact] }],
      // **観測専用**（`worker_wait`）。`{ continue: true }` を返すだけで何も
      // ブロックしない。理由は `runner.ts` の `#onUserPromptSubmit` の doc を見よ。
      UserPromptSubmit: [{ hooks: [onUserPromptSubmit] }],
      // **観測専用**（#357）。`{ continue: true }` を返すだけで何もブロック
      // しない。理由は `runner.ts` の `#onSubagentStop` の doc を見よ。
      SubagentStop: [{ hooks: [onSubagentStop] }],
    },
  };
}

// ---------------------------------------------------------------------------
// D. 読み側 —— Claude のメッセージを中立イベントへ写す
// ---------------------------------------------------------------------------

/**
 * Claude のメッセージ1件を {@link AgentEvent} へ写す（#486「読み側の中立化」）。
 *
 * **ここが「読み取りの判断」の唯一の置き場である。** SDK の綴り（`subtype` の値・
 * `permission_denials` の欄・`modelUsage` の在り処）を知っているのはこの関数と、
 * この関数が呼ぶ既に共有済みの判定（`sdk-failure.ts` / `usage-limits.ts` /
 * `usage.ts`）だけにする。**層（`clone.ts` / `runner.ts`）はもう SDK の綴りを
 * 読まない** —— 次の provider を足すときに書くのは、この関数と同じ形の写しを
 * もう1本だけである。
 *
 * **純関数である。** 状態を持たないので、ターンを跨ぐ記憶（喋った本文を溜める・
 * 印を持ち越す・委譲の区間を開く）は層の側に残る。それは「起きたことへの反応」で
 * あって読み取りの判断ではない（`agent-events.ts` の表の (ii)）。
 *
 * **0個返すことがある。** provider が出すもののうち「見ないと決めてある」種類が
 * あるためで、間引きではなく判断である（下の `task_progress` ほかの doc）。
 */
export function foldClaudeMessage(message: SDKMessage): AgentEvent[] {
  switch (message.type) {
    case 'system':
      return foldSystemMessage(message);

    // 枠の事実（アカウント単位）。**ターンの頭ごとに来る**ので、ここが走行中の
    // 唯一の最新情報になる（使い捨ての probe は idle 用）。
    case 'rate_limit_event': {
      const facts = toRateLimitFacts((message as { rate_limit_info?: unknown }).rate_limit_info);
      return facts === undefined ? [] : [{ type: 'rate_limit', facts }];
    }

    case 'stream_event': {
      const text = textDeltaOf((message as { event?: unknown }).event);
      return text === null ? [] : [{ type: 'text_delta', text }];
    }

    case 'assistant': {
      // **印だけを載せ、本文は載せない。** 本文の取り出し方（ブロックをどう繋ぐか）
      // は層によって違い、そこは表示と報告の作法＝ (ii) の側だからである。
      const errorCode = (message as { error?: unknown }).error;
      const messageId = (message as { uuid?: unknown }).uuid;
      return [
        {
          type: 'assistant_message',
          parentToolUseId: parentToolUseIdOf(message),
          blocks: contentBlocksOf((message as { message?: unknown }).message),
          ...(typeof messageId === 'string' && messageId.length > 0 ? { id: messageId } : {}),
          ...(typeof errorCode === 'string' && errorCode.trim().length > 0 ? { errorCode } : {}),
        },
      ];
    }

    // 道具の結果が返った＝実行は終わり、モデルが次を考え始めた。
    // `tool_result` を含むときだけにしているのは、人間の発言のエコーや
    // replay（`SDKUserMessageReplay`）を「考え始めた」と読み違えないため。
    case 'user': {
      const returned = contentBlocksRaw((message as { message?: unknown }).message).some(
        (block) => (block as { type?: unknown }).type === 'tool_result',
      );
      return returned ? [{ type: 'tool_result' }] : [];
    }

    case 'result': {
      const sessionId = (message as { session_id?: unknown }).session_id;
      // **成功した result の消費だけを通す。** SDK は
      // `crash/startup-error results may carry zeroed values` と言っている。
      // ゼロを「累積が 0 になった」として通すと、受け取った側の基準が下がり、
      // 次に届いた本物の累積が丸ごと増分になる（`usage.ts` の `isSuccessResult`）。
      const models = isSuccessResult(message) ? modelUsageOf(message) : undefined;
      // **観測用の写し。台帳には使わない**（`modelUsageOf` の doc「`result.usage`
      // は使わない」）。`models` と同じ条件（成功した result だけ）で絞る —— SDK の
      // 「crash/startup-error では zero 埋め」という注意は `usage` にも同様に効く
      // ので、失敗した result のこれを運ぶと存在しない消費を観測したことになる。
      // 何のためにここへ運ぶかは `agent-events.ts` の `AgentTurnUsage.mainLoopUsage`
      // の doc（→ `schema.ts` の `turn_usage.mainLoopUsage`）に書いてある。
      const mainLoopUsage = isSuccessResult(message)
        ? mainLoopUsageOf((message as { usage?: unknown }).usage)
        : undefined;
      const body = (message as { result?: unknown }).result;
      const subtype = (message as { subtype?: unknown }).subtype;
      const id = (message as { uuid?: unknown }).uuid;
      const failure = resultFailureOf(message);
      return [
        {
          type: 'turn_ended',
          succeeded: isSuccessResult(message),
          ...(failure === undefined ? {} : { failure }),
          body: typeof body === 'string' ? body : '',
          ...(typeof subtype === 'string' && subtype !== 'success' ? { outcome: subtype } : {}),
          errorLines: resultErrorLines(message),
          ...(models === undefined
            ? {}
            : {
                usage: {
                  models,
                  ...(typeof sessionId === 'string' ? { sessionId } : {}),
                  ...(mainLoopUsage === undefined ? {} : { mainLoopUsage }),
                },
              }),
          ...(typeof id === 'string' && id.length > 0 ? { id } : {}),
          // **`result` に載っている拒否は authoritative な側である**（走行中の
          // 合図は取りこぼしうる）。ターンの終わりの事実として一緒に運ぶ理由は
          // `AgentPermissionDeniedEvent` の doc。
          denials: permissionDenialsOf(message).map(toAgentPermissionDenial),
        },
      ];
    }

    default:
      return [];
  }
}

/**
 * `result.usage`（SDK の `NonNullableUsage`）を中立の形へ写す。
 *
 * **`usage.ts` の `usageTotalsSchema` とは意図的に形を揃えていない** ——
 * `NonNullableUsage` はコスト（`costUsd` に当たる欄）を持たないので、
 * 台帳の形に寄せると存在しない値を作ることになる。何のための写しかは
 * `agent-events.ts` の `AgentTurnUsage.mainLoopUsage` の doc を見よ。
 *
 * **読めなければ `undefined`。** 必須欄のどれかが数値でなければ、SDK が
 * 版で形を変えたと見て作り物を返さない（`runtimeFactsOf` と同じ作法）。
 */
function mainLoopUsageOf(raw: unknown): AgentTurnUsage['mainLoopUsage'] {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const usage = raw as Record<string, unknown>;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const cacheReadInputTokens = usage.cache_read_input_tokens;
  const cacheCreationInputTokens = usage.cache_creation_input_tokens;
  if (
    typeof inputTokens !== 'number' ||
    typeof outputTokens !== 'number' ||
    typeof cacheReadInputTokens !== 'number' ||
    typeof cacheCreationInputTokens !== 'number'
  ) {
    return undefined;
  }
  return { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens };
}

/** `system` の枝。**subtype ごとの見分けはここだけが知っている。** */
function foldSystemMessage(message: SDKMessage & { type: 'system' }): AgentEvent[] {
  const subtype = (message as { subtype?: unknown }).subtype;

  if (subtype === 'init') {
    return [
      {
        type: 'session_started',
        sessionId: message.session_id,
        runtime: runtimeFactsOf(message),
      },
    ];
  }

  // 確認へ上げずにその場で止められた1件（分類器・deny 規則・モード）。
  //
  // **`permissionMode: 'auto'` ではここが唯一の生の合図である。** `canUseTool` は
  // 呼ばれないので、この合図を捨てると手が止められたことが誰にも見えない。SDK 曰く
  // これは best-effort（取りこぼしうる）で、authoritative なのは
  // `result.permission_denials` — だから**両方**読む。
  if (subtype === 'permission_denied') {
    return [{ type: 'permission_denied', via: 'live', denial: toAgentPermissionDenial(message) }];
  }

  // compaction が1回起きた。**元々ここは `return []`（下の総取り）で落として
  // いた** —— `task_progress` 等の「見ないと決めてある」種類とは違い、これは
  // 判断ではなく単純な抜けである（`agent-events.ts` の `AgentCompactionEvent`
  // の doc）。読めない形（`trigger` が2値のどちらでもない・`pre_tokens` が
  // 数値でない）は SDK が版で形を変えたと見て0個にする —— 作り物を返さない。
  if (subtype === 'compact_boundary') {
    const metadata = (message as { compact_metadata?: unknown }).compact_metadata;
    if (typeof metadata !== 'object' || metadata === null) return [];
    const trigger = (metadata as { trigger?: unknown }).trigger;
    const preTokens = (metadata as { pre_tokens?: unknown }).pre_tokens;
    const postTokens = (metadata as { post_tokens?: unknown }).post_tokens;
    if ((trigger !== 'manual' && trigger !== 'auto') || typeof preTokens !== 'number') return [];
    return [
      {
        type: 'compaction',
        trigger,
        preTokens,
        ...(typeof postTokens === 'number' ? { postTokens } : {}),
      },
    ];
  }

  // 委譲の区間（`worker_wait`）。**下の「上限の文言」の総取りより必ず手前で
  // 見ること** — 後ろに置くと、`task_started` / `task_notification` はそこで
  // 無条件に捨てられて二度と読まれない（実際にそうなっていた。マネージャーが
  // 「残り5体を待ちます」だけのターンを40回以上回した事故で、40という回数自体は
  // `report` から日誌に残っていたが、契機がどこにも残っていなかった原因がこれ
  // である）。
  if (subtype === 'task_started' || subtype === 'task_notification') {
    const taskId = (message as { task_id?: unknown }).task_id;
    return [
      {
        type: subtype === 'task_started' ? 'delegation_started' : 'delegation_notified',
        ...(typeof taskId === 'string' ? { taskId } : {}),
      },
    ];
  }

  // `task_progress` / `task_updated` は**見ないと決めてある**（間引いている
  // のではなく、そもそも数える対象ではないという判断であることをここに
  // 明記する）。
  //
  // - `task_progress` は高頻度の進捗 ping で、ターンの契機にはならない
  // - `task_updated` は `task_started` / `task_notification` の間の状態遷移の
  //   詳細（`pending` → `running` → `completed` 等）で、区間の開閉には要らない
  if (subtype === 'task_progress' || subtype === 'task_updated') {
    return [];
  }

  // `background_tasks_changed` は「見ないと決めてある」から外れた
  // ——ただし理由（level 信号なので edge と相関させるな。フォアグラウンドの
  // まま終わる委譲はここに載らない、と SDK 自身が言っている）は**まだ
  // 生きている**。上の2種と同じ理由でいまも `worker_wait` の区間の開閉には
  // 使えない。**ここで新しく足すのは、その開閉とは別の問いの読み手である**
  // ——「いま起こしっぱなしの背景処理が在るか」（`agent-events.ts` の
  // `AgentBackgroundTasksEvent` の doc）。level 信号であることはこちらの
  // 問いには効かないので、そのまま REPLACE 意味論で運ぶ。
  //
  // **`tasks` が配列でなければ0個返す**（`runtimeFactsOf` と同じ作法。
  // 「読めた配列だけが『0本』を名乗れる」）——SDK が版で形を変えたと見て、
  // 作り物の「0本」を主張しない。
  if (subtype === 'background_tasks_changed') {
    const tasks = liveBackgroundTasksOf(message);
    return tasks === null ? [] : [{ type: 'background_tasks', tasks }];
  }

  // 上限の文言。**API エラーとしては来ない**（SDK のコメント）ので、通知・情報
  // メッセージの本文を見るしかない。ここを見ないと「枠を使い切って課金枠に
  // 移った」＝止まる一歩前を捉えられない。
  const said =
    subtype === 'notification'
      ? (message as { text?: unknown }).text
      : subtype === 'informational'
        ? (message as { content?: unknown }).content
        : undefined;
  if (typeof said !== 'string') return [];
  const notice = classifyUsageNotice(said);
  return notice === undefined ? [] : [{ type: 'usage_notice', notice }];
}

/**
 * init が名乗った実行時の事実。
 *
 * **`typeof` で検査し、読めない形は `null` のままにする。** 型定義の上ではどれも
 * 必須フィールドだが、ここで読み違えて例外を投げるとセッションの起動そのものが
 * 壊れる。読めなかったことは「まだ分からない」として出せば済む。**`mcp_servers`
 * も同じ扱いにする（#324）** —— 形が読めなかったときにまで「0本」と主張する
 * 根拠は無い。読めた配列だけが「0本」を名乗れる。
 */
function runtimeFactsOf(message: SDKMessage): AgentRuntimeFacts {
  const raw = message as unknown as {
    session_id?: unknown;
    model?: unknown;
    claude_code_version?: unknown;
    apiKeySource?: unknown;
    permissionMode?: unknown;
    mcp_servers?: unknown;
  };
  return {
    sessionId: typeof raw.session_id === 'string' ? raw.session_id : null,
    model: typeof raw.model === 'string' ? raw.model : null,
    agentVersion: typeof raw.claude_code_version === 'string' ? raw.claude_code_version : null,
    apiKeySource: typeof raw.apiKeySource === 'string' ? raw.apiKeySource : null,
    permissionMode: typeof raw.permissionMode === 'string' ? raw.permissionMode : null,
    mcpServers: Array.isArray(raw.mcp_servers)
      ? raw.mcp_servers.filter(
          (entry): entry is { name: string; status: string } =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as { name?: unknown }).name === 'string' &&
            typeof (entry as { status?: unknown }).status === 'string',
        )
      : null,
  };
}

/**
 * `system/background_tasks_changed` の `tasks` を中立の形へ写す。
 *
 * **防御的に読む**（`runtimeFactsOf` と同じ作法）。`raw.tasks` が配列で
 * なければ `null` を返し、呼び出し元はこれを「0個返す」ではなく
 * 「イベントそのものを出さない」に使う——読めなかった形にまで「0本」と
 * 主張する根拠は無い（`runtimeFactsOf` の doc「読めた配列だけが『0本』を
 * 名乗れる」）。
 *
 * 各要素は `task_id` が文字列でなければ落とす。`ambient === true`
 * （housekeeping task）は除く——SDK の doc「hosts should exclude them
 * from activity indicators」（`agent-events.ts` の
 * `AgentBackgroundTasksEvent` の doc に逐語を引いてある）。`task_type` が
 * 文字列でなければ `'(不明)'` を当てる——欄自体が壊れていても、要素の
 * 存在（＝背景処理が1件在ること）までは捨てない。
 */
function liveBackgroundTasksOf(
  raw: unknown,
): readonly { id: string; taskType: string }[] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const tasks = (raw as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return null;
  const result: { id: string; taskType: string }[] = [];
  for (const entry of tasks) {
    if (typeof entry !== 'object' || entry === null) continue;
    const taskId = (entry as { task_id?: unknown }).task_id;
    if (typeof taskId !== 'string') continue;
    if ((entry as { ambient?: unknown }).ambient === true) continue;
    const taskType = (entry as { task_type?: unknown }).task_type;
    result.push({ id: taskId, taskType: typeof taskType === 'string' ? taskType : '(不明)' });
  }
  return result;
}

/**
 * 拒否の1件を中立の形へ写す。
 *
 * **走行中の合図（`system/permission_denied`）と `result.permission_denials` の
 * 両方から呼ばれる。** 欄の揃い方は出所で違う（後者は `tool_name` /
 * `tool_use_id` / `tool_input` の3つしか持たない）が、**読み方は同じである** ——
 * だから写しは1本でよい。**無い欄は作り物を出さずキーごと省く。**
 */
function toAgentPermissionDenial(source: unknown): AgentPermissionDenial {
  const denial = source as {
    tool_name?: unknown;
    tool_use_id?: unknown;
    tool_input?: unknown;
    decision_reason?: unknown;
    decision_reason_type?: unknown;
    message?: unknown;
    agent_id?: unknown;
    agent_type?: unknown;
  } | null;
  return {
    ...(typeof denial?.tool_name === 'string' ? { tool: denial.tool_name } : {}),
    ...(typeof denial?.tool_use_id === 'string' && denial.tool_use_id.length > 0
      ? { toolUseId: denial.tool_use_id }
      : {}),
    ...(denial?.tool_input === undefined ? {} : { input: denial.tool_input }),
    ...(typeof denial?.decision_reason === 'string' ? { reason: denial.decision_reason } : {}),
    ...(typeof denial?.decision_reason_type === 'string'
      ? { reasonType: denial.decision_reason_type }
      : {}),
    ...(typeof denial?.message === 'string' ? { message: denial.message } : {}),
    ...(typeof denial?.agent_id === 'string' ? { agentId: denial.agent_id } : {}),
    ...(typeof denial?.agent_type === 'string' ? { agentType: denial.agent_type } : {}),
  };
}

/** `result` に載っている拒否の記録（authoritative な側）。無ければ空。 */
function permissionDenialsOf(message: SDKMessage): unknown[] {
  const denials = (message as { permission_denials?: unknown }).permission_denials;
  return Array.isArray(denials) ? denials.filter((entry) => entry !== null) : [];
}

/** 作業者（委譲の中）の発言なら親の道具 id が付く。本体の発言は `null`。 */
function parentToolUseIdOf(message: SDKMessage): string | null {
  const value = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  return typeof value === 'string' ? value : null;
}

/** 逐次配信の1片。text の delta 以外は読まない。 */
function textDeltaOf(event: unknown): string | null {
  const candidate = event as { type?: string; delta?: { type?: string; text?: unknown } };
  if (candidate.type !== 'content_block_delta') return null;
  if (candidate.delta?.type !== 'text_delta') return null;
  return typeof candidate.delta.text === 'string' ? candidate.delta.text : null;
}

/** 中身の塊をそのまま並べる（種類の見分けは呼び出し側）。 */
function contentBlocksRaw(message: unknown): unknown[] {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

/**
 * 中身の塊を中立の3種へ畳む。
 *
 * **`text` でも `tool_use` でもないものを捨てずに `other` として残す。** 数と順序が
 * 保たれるので、層の側が「読み飛ばした塊が在った」ことを見られる。
 */
function contentBlocksOf(message: unknown): AgentContentBlock[] {
  return contentBlocksRaw(message).map((block): AgentContentBlock => {
    const type = (block as { type?: unknown }).type;
    const text = (block as { text?: unknown }).text;
    if (type === 'text' && typeof text === 'string') return { type: 'text', text };
    const name = (block as { name?: unknown }).name;
    if (type === 'tool_use' && typeof name === 'string') return { type: 'tool_use', name };
    return { type: 'other' };
  });
}
