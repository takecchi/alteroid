import { Badge } from '../common';

export type StatusTone = 'ok' | 'warn' | 'danger' | 'neutral' | 'accent';

export type StatusMap<S extends string> = Record<S, { tone: StatusTone; label: string }>;

// 知らない状態にも倒れ先を持ち、生の値をそのまま見せる: Web とデーモンは別々にデプロイされ、デーモンが先に新しい値を返す時間が在り、「不明」だけだと何が来たのか追えないため
// `Object.hasOwn` で引く: `map['constructor']` のような継承したキーは `undefined` にならず、別の形で壊れるため
export function StatusBadge<S extends string>({
  status,
  map,
}: {
  status: S | string;
  map: StatusMap<S>;
}) {
  const view = Object.hasOwn(map, status)
    ? map[status as S]
    : { tone: 'neutral' as const, label: `知らない状態（${String(status)}）` };
  return <Badge tone={view.tone}>{view.label}</Badge>;
}
