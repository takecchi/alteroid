// 日誌の検索 q で引く固定の語。変えると過去の行と引けなくなる（行の頭の `[計器] ` は書く側が付ける）。
export const SUBAGENT_HOOK_GAUGE_PHRASE = 'サブエージェント呼びの確認';
export const CALLER_VERDICT_GAUGE_PHRASE = '呼び手の判定';

/** hook の PreToolUse で見た道具の種類。名前そのものは行に出さない（種類だけで足りる）。 */
export type ToolKind = 'mcp-alteroid' | 'mcp-他' | '組込み';

/** handler が `extra._meta['claudecode/toolUseId']` をどう読めたか。値は持たない。 */
export type ToolUseIdProbe = 'present' | 'missing' | 'wrongType';

/** 先頭が `mcp__alteroid__`（クローン本体）か `mcp__alteroid-`（peer・manager など）ならクローン側の MCP 道具。 */
export function toolKindOf(toolName: string): ToolKind {
  if (toolName.startsWith('mcp__alteroid__') || toolName.startsWith('mcp__alteroid-')) {
    return 'mcp-alteroid';
  }
  return toolName.startsWith('mcp__') ? 'mcp-他' : '組込み';
}

// 種類（結果の組）ごとの上限。サブの呼びは確かめたい本題なので多め、本体は基準の比較だけなので少なめ。
export const SUBAGENT_GAUGE_LIMIT = 20;
export const MAIN_GAUGE_LIMIT = 5;

/**
 * 計器の行を間引く数え手。**種類ごとに最初の N 回だけ行を返し、N+1 回目に「以降は間引く（累計 K）」を1回だけ返し、
 * それ以降は `undefined`（カウンタだけ進める）。**
 *
 * 「100 回ごとに累計」ではなく1回きりにした理由: 呼びの数に比例して日誌が育ち続けるのを避けるため（本番の1デーモンは長く生きる）。
 * 見たいのは「取れているか」の有無で、最初の N 回の並びで読める。代わりに N+1 回目以降の変化は追えない（再起動で数え直し）。
 * 行の本文（接頭辞なし）を返すだけで書き込みは持たない: 書けなくても判定の結果を変えないのは呼び出し側の責務。
 */
export class CallerGauge {
  readonly #counts = new Map<string, number>();

  /** @returns 日誌へ書く本文。書かない回は `undefined`。 */
  note(label: string, limit: number): string | undefined {
    const count = (this.#counts.get(label) ?? 0) + 1;
    this.#counts.set(label, count);
    if (count <= limit) return label;
    if (count === limit + 1) return `${label}は以降は間引く（累計 ${String(count)}）`;
    return undefined;
  }
}

export function hookGaugeLabel(isSubagent: boolean, kind: ToolKind): string {
  return `${SUBAGENT_HOOK_GAUGE_PHRASE}（hook: ${isSubagent ? 'サブの呼び' : '本体の呼び'}・道具の種類 ${kind}）`;
}

export function verdictGaugeLabel(probe: ToolUseIdProbe, subagent: boolean): string {
  const meta = probe === 'present' ? '有' : probe === 'missing' ? '無' : '型違い';
  return `${CALLER_VERDICT_GAUGE_PHRASE}（_meta の toolUseId: ${meta}・${subagent ? 'サブ' : '本体'}と判定）`;
}
