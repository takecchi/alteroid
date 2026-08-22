import type {
  CanUseTool,
  HookCallback,
  McpServerConfig,
  Options,
  SessionStore,
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';

import type { AgentProvider } from './agent-ports.js';
import type { PermissionModeName } from './permission-mode.js';
import { CLONE_ALLOWED_TOOLS, MCP_SERVER_NAME } from './tools.js';

/**
 * `Options`（SDK へ渡すセッション設定）を組み立てるのはこのファイルだけにする。
 *
 * **provider を足すときに触る場所を1つにする**ための置き場であって、いま
 * provider は Claude だけである。呼び出し側（`clone.ts` / `runner.ts`）が持つ
 * インスタンスの状態・副作用のある前処理（記憶ドキュメントを読む・観測値を
 * 控える・実行環境プロファイルを重ねるなど）はここへは移さない — ここは
 * 「渡された値をどこへ置くか」だけを知っている純粋な組み立てである。
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
  /**
   * 人間が開けた実行許可（`PermissionStore` の全量。規則の文字列そのもの）。
   *
   * **ここに来るのは `allow` だけである。** 台帳が `allow` しか持たないので
   * （`permissionRuleSchema` の不変条件1）、ここへ deny が混ざる経路は無い。
   *
   * **省略時は空。** 呼び出し側が渡し忘れると「人間が許可を開けたのに効かない」
   * という静かな壊れ方をするので、渡すのは `clone.ts` の `#buildOptions` の責務である。
   */
  allowRules?: readonly string[];
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
    allowRules = [],
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
    //
    // **ここへ人間が開けた分を足す**（`allowRules`）。足す先が `allowedTools` なのは、
    // 既定の `auto` では SDK のモデル分類器がその場で拒否を決め `canUseTool` が
    // 呼ばれないからで、**確認を回す先を作っても発火しない**。通す方法は「確認なしで
    // 通す一覧」に載せることだけである。**これは能力の調整ではなく、人間が自分の PC で
    // 「常に許可」を押すのに当たる操作をクローンにも持たせることである**（north_star
    // 禁止1。押す口が無いこと自体がデグレードだった）。
    //
    // **走行中に増えた分はここには載らない。** セッションを開くとき1回しか組まれない
    // ので、そちらは `Query.applyFlagSettings` で別に流し込む（`clone.ts` の
    // `applyPermissions`）。**両方要る** — こちらが無いと器を作り直したときに許可が
    // 消え、あちらが無いと次にセッションが開くまで効かない。
    allowedTools: [...CLONE_ALLOWED_TOOLS, ...allowRules],
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
    },
  };
}
