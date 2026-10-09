// SDK を import しない: 偽 provider でテストするために本番の `AgentProviderId` を広げなくて済むよう、入力は `displayName` と `capabilities` だけにしてある。

import {
  missingRequirementCapabilities,
  type AgentCapabilities,
  type AgentProvider,
} from './agent-ports.js';

/** 欠落を数える層。この順で出す。 */
export const PROVIDER_GAP_LAYERS = ['clone', 'manager', 'worker'] as const;
export type ProviderGapLayer = (typeof PROVIDER_GAP_LAYERS)[number];

const LAYER_LABEL: Record<ProviderGapLayer, string> = {
  clone: 'クローン層',
  manager: 'マネージャー層',
  worker: '作業者層',
};

export type ProviderGapSubject = Pick<AgentProvider, 'displayName' | 'capabilities'>;

export type LayerProviders = Record<ProviderGapLayer, ProviderGapSubject>;

type RequirementKey = Exclude<keyof AgentCapabilities, 'partialMessages'>;

/** 文言の唯一の出所。 */
const LOST_WHEN_MISSING: Record<RequirementKey, string> = {
  permissions:
    '権限境界: 許可確認を人間へ上げられない（承認したのに拒否される、を避けるため確認の代用は出さない）',
  toolAudit: '可観測性: ツール実行の記録（全件）が日誌に残らない',
  compactionHook: '記憶への蒸留: 文脈圧縮の前に記憶へ移す割り込みが効かない',
  resume: '引き取り: 再起動や器の入れ替えの後にセッションを再開できない',
  sessionLog: '引き取り: 生ログを器の外へ預けられない',
  subagents: '3層: 作業者（サブエージェント）を使えない',
  mcpServers: '業務範囲: MCP 連携（外部サービス）を使えない',
  childUser: '制御面の保護: 子プロセスを別 UID で動かせない',
  usage: '台帳: 消費が報告されない（この層の消費は台帳の合計に含まれない）',
};

function gapLines(owner: string, provider: ProviderGapSubject): string[] {
  return missingRequirementCapabilities(provider.capabilities).map(
    (key) =>
      `${owner}（${provider.displayName}）は ${key} を持たない — ${LOST_WHEN_MISSING[key as RequirementKey]}`,
  );
}

export function describeProviderGaps(providers: Partial<LayerProviders>): string[] {
  const lines: string[] = [];
  for (const layer of PROVIDER_GAP_LAYERS) {
    const provider = providers[layer];
    if (provider === undefined) continue;
    lines.push(...gapLines(LAYER_LABEL[layer], provider));
  }
  return lines;
}
