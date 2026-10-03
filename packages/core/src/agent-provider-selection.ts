import {
  AGENT_PROVIDER_IDS,
  DEFAULT_AGENT_PROVIDER_ID,
  type AgentProvider,
  type AgentProviderId,
} from './agent-ports.js';
import { CLAUDE_PROVIDER } from './claude-provider.js';
import { CODEX_PROVIDER } from './codex-provider.js';
import { placedModelTier } from './model-tier.js';

/**
 * 層ごとの provider を環境変数で選ぶ口（Issue #486 / M7 段 S1）。
 *
 * - クローン: `ALTEROID_CLONE_PROVIDER`（デーモンが読む）
 * - マネージャー: `ALTEROID_MANAGER_PROVIDER`（runner が読む）
 *
 * **作業者用の変数は無い。** 作業者はマネージャーの子（`Options.agents`）なので、
 * 親の provider に従う。層を3つに割る必要が出るまで、つまみを増やさない。
 *
 * ## 受け付ける値は {@link AGENT_PROVIDER_IDS} だけ
 *
 * 受け付けの出所はそこ1つで、provider を足すときはそこへ1行足す。**ただし層ごとに、実際に
 * 動かせる駆動役が在るものへ絞る**（{@link CLONE_PROVIDER_IDS} / {@link MANAGER_PROVIDER_IDS}）。
 * 既定（置かない・`claude`）の挙動は変わらない。
 *
 * ## 黙って既定へ倒さない
 *
 * 綴りを間違えた値（例: `cladue`）を黙って `claude` へ倒すと、別の provider を
 * 効かせたかった人間が、効いていないことに気づけない。`resolveCloneToolsTransport`
 * / `resolvePermissionModeFor` と同じく、未知の値は例外にして起動を止める。
 * 空・空白は「未設定」で既定へ落ちる（compose の `${VAR:-}` が空文字を渡すため）。
 *
 * ## プロファイルでは解かない
 *
 * `model-tier.ts` と同じ理由で、読むのは器自身の `process.env` である。
 */
export const CLONE_PROVIDER_ENV_KEY = 'ALTEROID_CLONE_PROVIDER';
export const MANAGER_PROVIDER_ENV_KEY = 'ALTEROID_MANAGER_PROVIDER';

export { DEFAULT_AGENT_PROVIDER_ID };

/** 人間が実際に値を置いたか（置いていなければ `null`）。起動時の表示の材料。 */
export function placedAgentProvider(env: NodeJS.ProcessEnv, key: string): string | null {
  return placedModelTier(env, key);
}

/**
 * クローン層が実際に動かせる provider。**{@link AGENT_PROVIDER_IDS} の部分集合。**
 *
 * `codex` はマネージャー層の駆動役（`codex-manager-driver.ts`）だけが在り、クローン層の駆動役
 * は無い（#486 S8）。`ALTEROID_CLONE_PROVIDER=codex` を受け付けると、クローンは黙って
 * Claude で走るのに provider だけが codex を名乗る — 効いていないことに気づけない。
 * 実装が入る段でここへ足す。
 */
export const CLONE_PROVIDER_IDS: readonly AgentProviderId[] = ['claude'];

/** マネージャー層（と、その子の作業者）が実際に動かせる provider。 */
export const MANAGER_PROVIDER_IDS: readonly AgentProviderId[] = ['claude', 'codex'];

function resolveAgentProviderId(
  env: NodeJS.ProcessEnv,
  key: string,
  accepted: readonly AgentProviderId[],
): AgentProviderId {
  const given = placedAgentProvider(env, key);
  if (given === null) return DEFAULT_AGENT_PROVIDER_ID;
  const known = accepted.find((id) => id === given);
  if (known !== undefined) return known;
  throw new Error(
    `${key} の値が不正: ${given}` +
      `（使えるのは ${accepted.join(' / ')}。既定は ${DEFAULT_AGENT_PROVIDER_ID}）`,
  );
}

/** クローン層の provider id。未知の値・この層にまだ実装が無い値は例外。 */
export function resolveCloneProviderId(env: NodeJS.ProcessEnv = process.env): AgentProviderId {
  return resolveAgentProviderId(env, CLONE_PROVIDER_ENV_KEY, CLONE_PROVIDER_IDS);
}

/** マネージャー層（と、その子の作業者）の provider id。未知の値は例外。 */
export function resolveManagerProviderId(env: NodeJS.ProcessEnv = process.env): AgentProviderId {
  return resolveAgentProviderId(env, MANAGER_PROVIDER_ENV_KEY, MANAGER_PROVIDER_IDS);
}

/**
 * provider id から実体を引く。`Record<AgentProviderId, …>` なので、
 * {@link AgentProviderId} へ id を足すとここが型エラーになり、実体の登録を忘れられない。
 */
const AGENT_PROVIDERS: Record<AgentProviderId, AgentProvider> = {
  claude: CLAUDE_PROVIDER,
  codex: CODEX_PROVIDER,
};

export function agentProviderOf(id: AgentProviderId): AgentProvider {
  return AGENT_PROVIDERS[id];
}

/** runner が名乗った provider id（文字列）から実体を引く。受け付ける id 以外は `undefined`。 */
export function knownProviderOf(id: string): AgentProvider | undefined {
  const known = AGENT_PROVIDER_IDS.find((candidate) => candidate === id);
  return known === undefined ? undefined : agentProviderOf(known);
}
