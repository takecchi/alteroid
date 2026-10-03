import type { AgentProvider } from './agent-ports.js';

/**
 * Codex（`codex app-server`）が名乗る事実（#486 M7 段 S6）。
 *
 * **実装で満たしているものだけを `true` にする。** 満たせないものは `false` と申告し、
 * 欠けた要件は `provider-gaps.ts` が日報・クローンの自己認識・`self_status` へ出す
 * （持たない能力を持つふりをしない。確認の代用も出さない）。
 *
 * このファイルは Claude Agent SDK を import しない（`agent-ports.ts` と同じ理由）。
 * 駆動役の実体は `codex-manager-driver.ts`。
 *
 * | 能力 | 値 | 根拠 |
 * | --- | --- | --- |
 * | permissions | true | `item/commandExecution/requestApproval` / `item/fileChange/requestApproval` を `spec.onPermission` へ回し、`mapCodexApproval` で答える。MCP elicitation・`requestUserInput`・`item/permissions/requestApproval` は alteroid の判断の型で表せないので、クローンへ回さず答えて観測だけ残す（嘘の確認を出さない） |
 * | toolAudit | false | `PostToolUse` 相当の全件記録の口を、この駆動役は `spec.onPostToolUse` へ繋いでいない（item の通知は中立イベントに畳むだけ） |
 * | compactionHook | false | Codex に「圧縮の前に割り込む」口が無い（`thread/compacted` は事後の通知）。記憶への蒸留の割り込みは効かない |
 * | resume | true | `thread/resume`。ただし rollout は Codex 側の `CODEX_HOME` にあり、器ごと失われれば開き直せない（`sessionLog` が false の裏面） |
 * | sessionLog | false | 生ログ（rollout）を器の外（デーモン）へ預ける口が無い。`spec.sessionLog` は使わない |
 * | subagents | false | Codex の app-server に `Options.agents` 相当（作業者を別モデルで走らせる口）を繋いでいない。作業者層は無い |
 * | mcpServers | false | `spec.mcpServers` を `thread/start` の `config.mcp_servers` へ写して渡すが（`codex-mcp-config.ts`）、実機の app-server で繋がることは未確認なので false のまま |
 * | childUser | true | `spec.spawnProcess`（別 UID の子）で `codex app-server` を起こす |
 * | usage | true | `thread/tokenUsage/updated` の `last` を足し、単価表（`codex-pricing.ts`）で USD を出す（トークンのみ・web 検索回数は読めない。表に無いモデルは費用を「読めなかった」とする） |
 * | partialMessages | true | `item/agentMessage/delta` を `text_delta` に畳む |
 */
export const CODEX_PROVIDER: AgentProvider = {
  id: 'codex',
  displayName: 'Codex',
  capabilities: {
    permissions: true,
    toolAudit: false,
    compactionHook: false,
    resume: true,
    sessionLog: false,
    subagents: false,
    mcpServers: false,
    childUser: true,
    usage: true,
    partialMessages: true,
  },
};
