import type { EnvVarScope, ProfileScope } from '@alteroid/logic';

// 環境変数（`/credentials`）とプロファイル（`/profile`）は、渡す先（scope）の値が同じ。両方の画面でこの1つを使う。
export function describeScope(scope: EnvVarScope | ProfileScope): {
  label: string;
  tone: 'neutral' | 'accent';
} {
  switch (scope) {
    case 'all':
      return { label: '共通', tone: 'accent' };
    case 'app':
      return { label: 'クローンだけ', tone: 'neutral' };
    case 'runner':
      return { label: 'マネージャーだけ', tone: 'neutral' };
    default:
      // 投げずに「未知」とそのまま出す: web とデーモンは別々に配られ、サーバのほうが新しい窓が必ず在るため
      return { label: `未知の渡す先（${String(scope)}）`, tone: 'neutral' };
  }
}

export const SCOPE_OPTIONS: { value: EnvVarScope & ProfileScope; label: string }[] = [
  { value: 'all', label: '共通（クローン・マネージャー両方。既定）' },
  { value: 'app', label: 'クローンだけ' },
  { value: 'runner', label: 'マネージャーだけ' },
];
