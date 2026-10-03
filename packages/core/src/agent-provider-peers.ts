import { AGENT_PROVIDER_IDS, type AgentProviderId } from './agent-ports.js';
import { placedAgentProvider } from './agent-provider-selection.js';
import type { ProviderGapLayer } from './provider-gaps.js';

/**
 * 「もう一方の provider を呼んでよいか」を人間が開ける口（Issue #486 / M7 段 S7 の前提部品）。
 *
 * - クローン: `ALTEROID_CLONE_PEERS`（`manager_start` の `provider` 引数が見える範囲）
 * - マネージャー: `ALTEROID_MANAGER_PEERS`（MCP `peer` が見える範囲）
 *
 * **作業者の変数は無い**（親に従う。S1 と同じ）。この段では誰からも呼ばれない純粋な関数で、
 * 環境変数は呼び出し側が文字列で渡す（`process.env` を読まない）。
 *
 * ## 書式（正典に書式の定めが無かったので最小の形）
 *
 * カンマ区切りの provider 名。前後の空白は落とす。大文字小文字は緩めない
 * （`ALTEROID_*_PROVIDER` と同じ）。例: `codex` / `codex, claude`。
 *
 * ## 未設定・空・空白だけは「閉じている」（空集合）
 *
 * 既定は閉じていて、人間が開けたときだけ開く。compose の `${VAR:-}` が空文字を
 * 渡すため、空も未設定と同じ。
 *
 * ## 黙って無視しない（S1 と同じく例外で起動を止める）
 *
 * - 未知の値（綴り違い）: 黙って捨てると「開けたつもりで閉じている」、黙って通すと
 *   「許していない provider が開く」。どちらも人間が気づけないので例外にする。
 * - 空の要素（`codex,,claude` や末尾のカンマ）: 書き損じの徴候なので例外にする。
 *
 * ## 自分の層の provider は、例外にせず集合から除く（ただし黙らせない）
 *
 * 例: manager=claude で `claude`。「もう一方」を呼ぶ口なので自分と同じ provider は意味がなく、
 * 集合には入れない。**例外にはしない** — 両方の層に同じ値（例: `codex,claude`）を書く運用や、
 * provider を入れ替えたときに、無害な値で起動が止まるのは害のほうが大きい。
 * **ただし黙って捨てない**: 書かれていたことを {@link PeersResolution.selfListed} で返す。
 * 起動時に表示するのは呼び出し側（配線は S7）。
 */
export const CLONE_PEERS_ENV_KEY = 'ALTEROID_CLONE_PEERS';
export const MANAGER_PEERS_ENV_KEY = 'ALTEROID_MANAGER_PEERS';

/** PEERS を持つ層。作業者は親に従うので持たない。 */
export type PeersLayer = Exclude<ProviderGapLayer, 'worker'>;

const PEERS_ENV_KEY: Record<PeersLayer, string> = {
  clone: CLONE_PEERS_ENV_KEY,
  manager: MANAGER_PEERS_ENV_KEY,
};

export function peersEnvKeyOf(layer: PeersLayer): string {
  return PEERS_ENV_KEY[layer];
}

/** {@link parsePeers} の結果。 */
export interface PeersResolution {
  /** 呼んでよい provider（自分の層の provider は含まない）。 */
  readonly peers: ReadonlySet<AgentProviderId>;
  /** 値に自分の層の provider が書かれていた（集合からは除いた）。表示するのは呼び出し側。 */
  readonly selfListed: boolean;
}

/**
 * 層の PEERS の値から、呼んでよい provider の集合を返す。
 *
 * @param raw その層の PEERS の値（未設定は `undefined`）
 * @param selfProvider その層が使っている provider（PEERS に書けない）
 * @param known 受け付ける provider。既定は {@link AGENT_PROVIDER_IDS}（テスト用の口）
 */
export function parsePeers(
  layer: PeersLayer,
  raw: string | undefined,
  selfProvider: AgentProviderId,
  known: readonly AgentProviderId[] = AGENT_PROVIDER_IDS,
): PeersResolution {
  const key = PEERS_ENV_KEY[layer];
  const given = placedAgentProvider({ [key]: raw }, key);
  const peers = new Set<AgentProviderId>();
  let selfListed = false;
  if (given === null) return { peers, selfListed };
  for (const part of given.split(',')) {
    const name = part.trim();
    if (name.length === 0) {
      throw new Error(
        `${key} の値が不正: ${given}（空の要素がある。カンマ区切りで provider 名を書く）`,
      );
    }
    const id = known.find((candidate) => candidate === name);
    if (id === undefined) {
      throw new Error(`${key} の値が不正: ${name}（使えるのは ${known.join(' / ')}）`);
    }
    if (id === selfProvider) {
      selfListed = true;
      continue;
    }
    peers.add(id);
  }
  return { peers, selfListed };
}

/** 層の PEERS を環境変数の束から読む。 */
export function resolvePeers(
  layer: PeersLayer,
  env: NodeJS.ProcessEnv,
  selfProvider: AgentProviderId,
  known: readonly AgentProviderId[] = AGENT_PROVIDER_IDS,
): PeersResolution {
  return parsePeers(layer, env[PEERS_ENV_KEY[layer]], selfProvider, known);
}

/** `target` を呼んでよいか。開けていない provider と、自分自身は false。 */
export function isPeerAllowed(
  selfProvider: AgentProviderId,
  peers: ReadonlySet<AgentProviderId>,
  target: AgentProviderId,
): boolean {
  return target !== selfProvider && peers.has(target);
}
