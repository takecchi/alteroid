// zod・SDK を読まない: CLI の軽い入口（`cli-light.ts`）からも読むため
/**
 * runner が名乗った peer（`RunnerOverview.managerPeers`。#3940・#4118）の見せ方。
 * `runner_list` / `self_status`（クローン）と CLI の `alteroid runners` が同じ字面を使う。
 */
export type ManagerPeersView =
  | {
      status: 'named';
      peers: { provider: string; models?: string[] }[];
      /** 閉じている peer と理由（#4118。名乗る版の runner だけが送る）。 */
      closed?: { provider: string; reason: string }[];
    }
  | { status: 'unknown' };

/** provider の名前を人の読む名前へ（知らない名前はそのまま）。 */
export function peerProviderLabel(provider: string): string {
  return provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude' : provider;
}

/**
 * 1台ぶんの説明。開いている peer は「頼める」、閉じている peer は理由つきで「閉じている」と言う
 * （#4118。ログイン済みなのに開いていない器の理由を見せるため）。**どちらも無い器は `undefined`
 * （行を出さない）**——理由を名乗らない旧い版の runner の見え方は変えない。
 * **名乗らない旧い runner（`unknown`）は「不明」と言う**——「頼めない」と既定値で埋めない。
 * 欄そのものが無い（旧いデーモンの応答・`ManagerPool.runners()` を経由しない固定値）ときは行を出さない
 * （`*Probe` が無いときに旧来の形へ倒すのと同じ）。
 */
export function describeManagerPeers(view: ManagerPeersView | undefined): string | undefined {
  if (view === undefined) return undefined;
  if (view.status === 'unknown') {
    return '不明（この runner は名乗らない旧い版か、名乗りをまだ受けていない）';
  }
  const open = view.peers.map((peer) => {
    const label = peerProviderLabel(peer.provider);
    const models =
      peer.models === undefined || peer.models.length === 0
        ? `モデルは ${label} の既定`
        : `名指しできるモデル: ${peer.models.join(', ')}`;
    return `${label} に作業を頼める（peer: ${peer.provider}。${models}）`;
  });
  const closed = (view.closed ?? []).map(
    (entry) => `${peerProviderLabel(entry.provider)} は閉じている（${entry.reason}）`,
  );
  const parts = [...open, ...closed];
  return parts.length === 0 ? undefined : parts.join(' / ');
}
