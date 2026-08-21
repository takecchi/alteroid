/**
 * どのコーディングエージェントが層（クローン・マネージャー・作業者）を
 * 動かしているかを表す、provider に依存しない語彙。
 *
 * **このファイルは Claude Agent SDK のパッケージを import してはいけない**
 * （型も定数も）。ここに SDK の型が1つでも漏れると、次の provider を足すときに
 * 「Claude の形に似せて作る」以外の選択肢が無くなる — 中立でいることそのものが
 * この場所の価値である（番人テストは `agent-ports.test.ts` にある）。
 *
 * `Options` の実際の組み立て（SDK 固有の構造）は `claude-provider.ts` に置く。
 */

/**
 * どのコーディングエージェントが層を動かしているかの id。
 *
 * **{@link AGENT_PROVIDER_IDS} が唯一の出所である。** provider を1つ足すときは
 * ここへ1行足すことから始まる。
 */
export type AgentProviderId = 'claude';

/** {@link AgentProviderId} の全体。**この配列が唯一の出所**。 */
export const AGENT_PROVIDER_IDS: readonly AgentProviderId[] = ['claude'];

/**
 * このリポジトリが実際に使っている10個の能力。
 *
 * 各フィールドが「alteroid のどの要件を担っているか」を JSDoc に書く —
 * これがこのファイルの価値である。新しい provider を足すときは、ここに並んだ
 * 要件を（`partialMessages` を除いて）どう満たすかを1つずつ確かめること。
 * 満たせないものがあれば {@link NO_CAPABILITIES} から出発し、
 * {@link missingRequirementCapabilities} で欠けている要件を機械的に洗い出せる。
 */
export interface AgentCapabilities {
  /**
   * PRD「権限境界」。
   *
   * Claude では `canUseTool` + `AskUserQuestion` で実装している。
   */
  permissions: boolean;
  /**
   * PRD「可観測性」（聞かずに実行した判断が日誌に残る）。
   *
   * Claude では `PostToolUse` フックで実装している。
   */
  toolAudit: boolean;
  /**
   * クローンの寿命モデル（記憶への蒸留）。
   *
   * Claude では `PreCompact` フックで実装している。
   */
  compactionHook: boolean;
  /**
   * M4 受け入れ基準（デーモン再起動後の引き取り）。
   *
   * Claude では `Options.resume` で実装している。
   */
  resume: boolean;
  /**
   * 同上（生ログを器の外へ預ける）。
   *
   * Claude では `SessionStore` で実装している。
   */
  sessionLog: boolean;
  /**
   * PRD「層ごとの能力」の3層（作業者層）。
   *
   * Claude では `Options.agents` で実装している。
   */
  subagents: boolean;
  /**
   * PRD「業務範囲」（人間の MCP 連携）。
   *
   * Claude では `settingSources` + インプロセス MCP で実装している。
   */
  mcpServers: boolean;
  /**
   * architecture「制御面の保護」3枚目。
   *
   * Claude では `spawnClaudeCodeProcess` で実装している。
   */
  childUser: boolean;
  /**
   * 台帳（消費の観測）。
   *
   * Claude では `result.modelUsage` で実装している。
   */
  usage: boolean;
  /**
   * **要件ではない**（操作性）。
   *
   * Claude では `includePartialMessages` で実装している。ストリーミング表示は
   * north_star / PRD / architecture のどの要件からも要求されていない — 無くても
   * クローンが動く・マネージャーが動くという受け入れ基準はどれも成立する。
   * だから {@link REQUIREMENT_BEARING_CAPABILITIES} からはこれだけを外してある。
   */
  partialMessages: boolean;
}

/** 全部 `false`。新しい provider の出発点。 */
export const NO_CAPABILITIES: AgentCapabilities = {
  permissions: false,
  toolAudit: false,
  compactionHook: false,
  resume: false,
  sessionLog: false,
  subagents: false,
  mcpServers: false,
  childUser: false,
  usage: false,
  partialMessages: false,
};

/**
 * 要件を担っている capability だけ（{@link AgentCapabilities} の10個のうち
 * `partialMessages` を除いた9個）。
 *
 * **`partialMessages` だけを外している理由**: 他の9個はいずれも docs
 * （north_star / PRD / architecture）か roadmap の受け入れ基準が名指しで要求して
 * いるのに対し、`partialMessages` は応答の見せ方（ストリーミング表示）でしかない
 * — それが `false` でも、人間が最終的に受け取る応答内容そのものは変わらない
 * （`includePartialMessages` は途中経過の `stream_event` を追加で流すだけで、
 * 最後の `result` はこの値に関わらず届く）。だから「要件を満たしているか」の
 * 判定からは外す。
 */
export const REQUIREMENT_BEARING_CAPABILITIES: readonly (keyof AgentCapabilities)[] = [
  'permissions',
  'toolAudit',
  'compactionHook',
  'resume',
  'sessionLog',
  'subagents',
  'mcpServers',
  'childUser',
  'usage',
];

/**
 * `capabilities` のうち、要件を担っているのに `false` になっているキーを
 * {@link REQUIREMENT_BEARING_CAPABILITIES} の順で返す。全部 `true` なら空配列。
 *
 * **純粋関数である。** provider の判定はここだけに置き、呼び出し側で個別に
 * `if (!capabilities.permissions) ...` を書き並べない。
 */
export function missingRequirementCapabilities(
  capabilities: AgentCapabilities,
): readonly (keyof AgentCapabilities)[] {
  return REQUIREMENT_BEARING_CAPABILITIES.filter((key) => !capabilities[key]);
}

/** 1つのコーディングエージェント provider が名乗る事実。 */
export interface AgentProvider {
  readonly id: AgentProviderId;
  readonly displayName: string;
  readonly capabilities: AgentCapabilities;
}
