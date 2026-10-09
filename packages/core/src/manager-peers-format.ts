// zod・SDK を読まない: CLI の軽い入口（`cli-light.ts`）からも読むため
export type ManagerPeersView =
  | {
      status: 'named';
      peers: { provider: string; models?: string[] }[];
      closed?: { provider: string; reason: string }[];
    }
  | { status: 'unknown' };

export function peerProviderLabel(provider: string): string {
  return provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude' : provider;
}

// 名乗らない旧い runner は「頼めない」と既定値で埋めず「不明」と言う。欄そのものが無いときと、開閉どちらも無いときは `undefined`（行を出さない）。
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
