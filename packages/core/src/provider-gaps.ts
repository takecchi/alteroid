/**
 * provider が持たない能力を、何が失われるかの文言で数える純関数（PRD「provider」の
 * 「持たないことは持たないと出す」）。
 *
 * **層は常に Claude で動く**（2026-10-07 のオーナー決定）ので、層の欠落を日報・自己認識・
 * `self_status` へ載せる配線は撤去した。ここに残るのは、層ごとの既定
 * （`layer-providers.ts`）が要件を担う能力を欠かないことを測る歯と、provider の申告
 * （`codex-provider.ts`）が何を欠くかを言うための文言だけである。
 *
 * **SDK を import しない**（`agent-ports.ts` と同じ理由）。入力は provider の
 * 実体ではなく `displayName` と `capabilities` だけ — 偽 provider でテストするために
 * 本番の `AgentProviderId` を広げなくて済むようにしてある。
 *
 * 文言の出所はこのファイルの {@link LOST_WHEN_MISSING} 1か所。欠落が無ければ `[]` を返す。
 */

import {
  missingRequirementCapabilities,
  type AgentCapabilities,
  type AgentProvider,
} from './agent-ports.js';

/** 欠落を数える層。**この順で出す。** */
export const PROVIDER_GAP_LAYERS = ['clone', 'manager', 'worker'] as const;
export type ProviderGapLayer = (typeof PROVIDER_GAP_LAYERS)[number];

const LAYER_LABEL: Record<ProviderGapLayer, string> = {
  clone: 'クローン層',
  manager: 'マネージャー層',
  worker: '作業者層',
};

/** 欠落の判定に要る provider の事実だけ。 */
export type ProviderGapSubject = Pick<AgentProvider, 'displayName' | 'capabilities'>;

/** 層ごとの provider。 */
export type LayerProviders = Record<ProviderGapLayer, ProviderGapSubject>;

type RequirementKey = Exclude<keyof AgentCapabilities, 'partialMessages'>;

/** 要件を担う能力が無いとき、PRD 上何が失われるか。**文言の唯一の出所。** */
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

/**
 * 欠けた要件の能力ごとに1行（層の順、層の中は `REQUIREMENT_BEARING_CAPABILITIES`
 * の順）。欠落が1つも無ければ `[]`。**渡した層だけ数える**。
 */
export function describeProviderGaps(providers: Partial<LayerProviders>): string[] {
  const lines: string[] = [];
  for (const layer of PROVIDER_GAP_LAYERS) {
    const provider = providers[layer];
    if (provider === undefined) continue;
    lines.push(...gapLines(LAYER_LABEL[layer], provider));
  }
  return lines;
}
