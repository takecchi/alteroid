import { AGENT_PROVIDER_IDS, type AgentProviderId } from './agent-ports.js';
import { CODEX_NO_WORKER_LABEL, layerModelLabel } from './agent-provider-selection.js';
import { placedModelTier } from './model-tier.js';
import {
  MANAGER_MODEL_ENV_KEY,
  placedModelAppliesTo,
  resolveManagerModel,
  resolveWorkerModel,
} from './runner.js';

// runner.ts から import しない: 束ねた後の評価順が変わり、provider の表が未初期化のまま読まれるため（core-bundle-init.test.ts）
/**
 * provider のセッションに実際に効くモデルの表記（マネージャー層・作業者層）。セッションへ渡す値と
 * 同じ解決（{@link resolveManagerModel} / {@link resolveWorkerModel} / {@link placedModelAppliesTo}）から作る。
 */
export function sessionModelLabels(
  provider: AgentProviderId,
  hostManagerProvider: AgentProviderId | undefined,
  env: NodeJS.ProcessEnv,
): { manager: string; worker: string } {
  const visible = placedModelAppliesTo(hostManagerProvider, provider) ? env : {};
  return {
    manager: layerModelLabel(
      provider,
      resolveManagerModel(visible),
      placedModelTier(visible, MANAGER_MODEL_ENV_KEY),
    ),
    worker: provider === 'codex' ? CODEX_NO_WORKER_LABEL : resolveWorkerModel(visible),
  };
}

/** `hello.models` に載せる、この runner が起こせる provider ごとの表記。 */
export function runnerModelLabels(
  hostManagerProvider: AgentProviderId,
  env: NodeJS.ProcessEnv,
): Record<string, { manager: string; worker: string }> {
  return Object.fromEntries(
    AGENT_PROVIDER_IDS.map((provider) => [
      provider,
      sessionModelLabels(provider, hostManagerProvider, env),
    ]),
  );
}
