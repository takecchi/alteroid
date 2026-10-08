import { placedModelTier } from './model-tier.js';

/**
 * もう読まない環境変数（2026-10-07 のオーナー決定）。**層は常に Claude で動く。**
 *
 * - `ALTEROID_CLONE_PROVIDER` — クローン層の provider
 * - `ALTEROID_MANAGER_PROVIDER` — マネージャー層（と作業者層）の provider
 * - `ALTEROID_CLONE_PEERS` — クローンが `manager_start` の `provider` 引数で呼べた provider
 *
 * Codex に作業を頼む口は `ALTEROID_MANAGER_PEERS`（マネージャーの MCP `peer`）だけが残る。
 *
 * **黙って無視しない**: 本番の器にこれらが残っていることがありうる。置いた人間は
 * 「効いている」と思ったままになるので、起動時に名前だけを1行ずつ stderr へ出す（値は出さない。
 * 起動は止めない）。
 */
export const RETIRED_LAYER_PROVIDER_ENV_KEYS = [
  'ALTEROID_CLONE_PROVIDER',
  'ALTEROID_MANAGER_PROVIDER',
  'ALTEROID_CLONE_PEERS',
] as const;

/**
 * 置かれている（空・空白でない）旧い変数ごとに1行。置かれていなければ `[]`。
 *
 * @param who 行頭の名乗り（`alteroidd` / `alteroid-runner`）
 */
export function retiredLayerProviderNotices(env: NodeJS.ProcessEnv, who: string): string[] {
  return RETIRED_LAYER_PROVIDER_ENV_KEYS.filter((key) => placedModelTier(env, key) !== null).map(
    (key) =>
      `${who}: ${key} はもう読みません（2026-10-07 の決定。層は Claude で動きます。` +
      `Codex に作業を頼むなら runner に ALTEROID_MANAGER_PEERS=codex を置いてください）。` +
      `この変数は外してください`,
  );
}
