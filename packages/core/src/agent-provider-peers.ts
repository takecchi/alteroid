import type { AgentProviderId } from './agent-ports.js';

/**
 * マネージャー層の MCP `peer` を開く条件（#4118。2026-10-08 のオーナー決定）。
 *
 * **人間がその provider の設定（資格）を済ませたら開く。** 逐語は「ユーザーがcodexでログインして
 * 使えるようにしたってことはcodexを使えるようにしたってことでしょ？」。Codex なら、runner に
 * ChatGPT ログイン（デーモンの正本から降りる）か、袋の `CODEX_API_KEY` が届いていれば開き、
 * どちらも無ければ閉じる。判定は資格が届く・外れるたびにやり直す（runner の再起動は要らない）。
 *
 * 以前は runner の `ALTEROID_MANAGER_PEERS` で開けていた。ログインしても変数を置かなければ開かず、
 * オーナーはログインだけで使えると受け取った（2026-10-08 の実例）。変数は退役させた
 * （`retired-provider-env.ts`。置かれていても読まず、起動時に「もう読まない」と出す）。
 */

/** peer になれる provider（層の provider = Claude は「もう一方」ではないので入らない）。 */
export const PEER_PROVIDER_IDS: readonly AgentProviderId[] = ['codex'];

/** runner に届いている資格（**値は持たない**。在るかどうかだけ）。 */
export interface PeerCredentialPresence {
  /** 袋の `CODEX_API_KEY`（空・空白だけは「無い」）。 */
  readonly codexApiKey: boolean;
  /** デーモンの正本から降りた ChatGPT ログイン。 */
  readonly codexChatgptLogin: boolean;
}

/** 閉じている peer と、その理由（人が読む文。runner_list・self_status・Web にそのまま出る）。 */
export interface PeerClosed {
  readonly provider: AgentProviderId;
  readonly reason: string;
}

export interface PeerOpening {
  readonly open: readonly AgentProviderId[];
  readonly closed: readonly PeerClosed[];
}

export const CODEX_PEER_CLOSED_REASON =
  'Codex の資格がこの器に届いていない（ChatGPT ログインも CODEX_API_KEY も無い）。' +
  '人間が Web の「設定 — Codex」か `alteroid codex login` でログインするか、' +
  '`alteroid credential set CODEX_API_KEY` で鍵を置くと、再起動なしで開く';

/** 届いている資格から、開いている peer と閉じている peer（理由つき）を決める。**純粋関数。** */
export function resolvePeerOpening(presence: PeerCredentialPresence): PeerOpening {
  if (presence.codexApiKey || presence.codexChatgptLogin) return { open: ['codex'], closed: [] };
  return { open: [], closed: [{ provider: 'codex', reason: CODEX_PEER_CLOSED_REASON }] };
}

/** 2つの開き具合が同じか（名乗り直しと、セッションの組み直しの要否に使う）。 */
export function samePeerOpening(a: PeerOpening, b: PeerOpening): boolean {
  return (
    a.open.join(',') === b.open.join(',') &&
    a.closed.map((c) => `${c.provider}:${c.reason}`).join('\n') ===
      b.closed.map((c) => `${c.provider}:${c.reason}`).join('\n')
  );
}

/**
 * peer の provider ごとに、人間が開けたモデル名の一覧を置く環境変数の名前（#3934）。
 * Codex なら `ALTEROID_MANAGER_PEER_CODEX_MODELS`（カンマ区切り）。
 * **provider ごとに分ける**: モデル名は provider の語彙なので、1本の一覧に混ぜると
 * どの provider のモデルか判別できなくなる。
 */
export function managerPeerModelsEnvKey(provider: AgentProviderId): string {
  return `ALTEROID_MANAGER_PEER_${provider.toUpperCase()}_MODELS`;
}

/** {@link managerPeerModelsEnvKey} の Codex の名前（`.env.example` / `compose.yaml` と突き合わせる）。 */
export const MANAGER_PEER_CODEX_MODELS_ENV_KEY = 'ALTEROID_MANAGER_PEER_CODEX_MODELS';

/**
 * モデル名の一覧を解く。未設定・空・空白だけは空（`model` 引数を出さない）。
 * **綴りの不正（空の要素）は起動時に止める**。重複は1つに畳む。
 */
export function parsePeerModels(raw: string | undefined, key: string): string[] {
  const given = raw?.trim() ?? '';
  if (given.length === 0) return [];
  const models: string[] = [];
  for (const part of given.split(',')) {
    const name = part.trim();
    if (name.length === 0) {
      throw new Error(
        `${key} の値が不正: ${given}（空の要素がある。カンマ区切りでモデル名を書く）`,
      );
    }
    if (/\s/.test(name)) {
      throw new Error(`${key} の値が不正: ${name}（モデル名に空白は入らない）`);
    }
    if (!models.includes(name)) models.push(name);
  }
  return models;
}

/**
 * peer になれる provider ごとにモデルの一覧を解く。置かれていない provider は載せない。
 * 開いているかどうかには依らない（資格は後から届くので、起動時に「使われない」とは言えない）。
 */
export function resolvePeerModels(
  env: NodeJS.ProcessEnv,
  providers: readonly AgentProviderId[] = PEER_PROVIDER_IDS,
): Partial<Record<AgentProviderId, readonly string[]>> {
  const models: Partial<Record<AgentProviderId, readonly string[]>> = {};
  for (const provider of providers) {
    const key = managerPeerModelsEnvKey(provider);
    const list = parsePeerModels(env[key], key);
    if (list.length > 0) models[provider] = list;
  }
  return models;
}
