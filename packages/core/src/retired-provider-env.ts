import { placedModelTier } from './model-tier.js';

/**
 * もう読まない環境変数（2026-10-07 のオーナー決定）。**層は常に Claude で動く。**
 *
 * - `ALTEROID_CLONE_PROVIDER` — クローン層の provider
 * - `ALTEROID_MANAGER_PROVIDER` — マネージャー層（と作業者層）の provider
 * - `ALTEROID_CLONE_PEERS` — クローンが `manager_start` の `provider` 引数で呼べた provider
 *
 * Codex に作業を頼む口はマネージャーの MCP `peer` だけが残る。開く条件は Codex の資格である
 * （{@link MANAGER_PEERS_ENV_KEY} の退役。`agent-provider-peers.ts`）。
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
 * 以前マネージャーの MCP `peer` を開けていた変数（2026-10-08 のオーナー決定で退役。#4118）。
 * いまは Codex の資格（ChatGPT ログインか `CODEX_API_KEY`）が runner に届けば開く。
 * **値が `codex` でも何でも読まない**（明示的に閉じる上書きとしても残さない — 閉じたいなら
 * ログアウトするか鍵を外す。開く操作と閉じる操作を同じ1つの設定に揃える）。
 */
export const MANAGER_PEERS_ENV_KEY = 'ALTEROID_MANAGER_PEERS';

const PEER_OPENS_ON_CREDENTIALS =
  'Codex に作業を頼む口（マネージャーの peer）は、Codex のログイン（Web の「設定 — Codex」・' +
  '`alteroid codex login`）か CODEX_API_KEY が runner に届けば開きます';

/**
 * 置かれている（空・空白でない）旧い変数ごとに1行。置かれていなければ `[]`。
 *
 * @param who 行頭の名乗り（`alteroidd` / `alteroid-runner`）
 */
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
