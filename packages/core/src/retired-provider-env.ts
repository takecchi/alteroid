import { placedModelTier } from './model-tier.js';

/** 黙って無視しない: 置いた人間が「効いている」と思ったままになるので、起動時に名前だけ stderr へ出す。 */
export const RETIRED_LAYER_PROVIDER_ENV_KEYS = [
  'ALTEROID_CLONE_PROVIDER',
  'ALTEROID_MANAGER_PROVIDER',
  'ALTEROID_CLONE_PEERS',
] as const;

/** 値が `codex` でも読まない: 閉じる上書きとして残すと、開く操作と閉じる操作が別の設定に割れるから。 */
export const MANAGER_PEERS_ENV_KEY = 'ALTEROID_MANAGER_PEERS';

const PEER_OPENS_ON_CREDENTIALS =
  'Codex に作業を頼む口（マネージャーの peer）は、Codex のログイン（Web の「設定 — Codex」・' +
  '`alteroid codex login`）か CODEX_API_KEY が runner に届けば開きます';

export function retiredLayerProviderNotices(env: NodeJS.ProcessEnv, who: string): string[] {
  const layer = RETIRED_LAYER_PROVIDER_ENV_KEYS.filter(
    (key) => placedModelTier(env, key) !== null,
  ).map(
    (key) =>
      `${who}: ${key} はもう読みません（2026-10-07 の決定。層は Claude で動きます。` +
      `${PEER_OPENS_ON_CREDENTIALS}）。この変数は外してください`,
  );
  const peers =
    placedModelTier(env, MANAGER_PEERS_ENV_KEY) === null
      ? []
      : [
          `${who}: ${MANAGER_PEERS_ENV_KEY} はもう読みません（2026-10-08 の決定。` +
            `${PEER_OPENS_ON_CREDENTIALS}）。この変数は外してください`,
        ];
  return [...layer, ...peers];
}
