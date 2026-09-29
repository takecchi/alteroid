import { Badge } from '../common';

export type StatusTone = 'ok' | 'warn' | 'danger' | 'neutral' | 'accent';

export type StatusMap<S extends string> = Record<S, { tone: StatusTone; label: string }>;

/**
 * 状態の札（マネージャーの状態・承認の状態・トークンの状態）。何をどの札にするかは
 * 画面が `map` で渡す（状態の意味は画面側の知識で、この層は持たない）。
 *
 * **知らない状態にも倒れ先を持つ**（`apps/web/app/routes/managers.tsx` の
 * `ManagerStatusBadge` と同じ判断。issue #1623）。Web とデーモンは別々にデプロイ
 * されるので、デーモンが先に新しい値を返す時間が在る。型が合っていても JSON は
 * そのまま届く。
 *
 * - 知らない値は**生の値をそのまま見せる**（「不明」だけだと何が来たのか追えない）
 * - **`Object.hasOwn` で引く** —— `map['constructor']` のような継承したキーは
 *   `undefined` にならず、別の形で壊れるため
 */
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
