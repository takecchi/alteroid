/**
 * 実行時の依存を持たない（Web はバレルを値で import できず、軽い口から読むため）。
 * 目立たせるだけで自動では取り消さず、期限の欄も足さない（オーナー決定）。
 * 月に1回使う許可を目立たせないよう、月の周期に2週間の余裕を足した。
 */
export const PERMISSION_GRANT_STALE_DAYS = 45;

export interface PermissionGrantStalenessInput {
  grantedAt: string;
  lastUsedAt?: string | undefined;
  revokedAt?: string | undefined;
}

export interface PermissionGrantStaleness {
  stale: boolean;
  idleDays: number;
  basis: 'lastUsedAt' | 'grantedAt';
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function assessPermissionGrantStaleness(
  grant: PermissionGrantStalenessInput,
  now: Date,
): PermissionGrantStaleness {
  const basis = grant.lastUsedAt === undefined ? 'grantedAt' : 'lastUsedAt';
  const basisTime = Date.parse(
    basis === 'lastUsedAt' ? (grant.lastUsedAt as string) : grant.grantedAt,
  );
  const elapsed = now.getTime() - basisTime;
  const idleDays = Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed / DAY_MS)) : 0;
  return {
    stale: grant.revokedAt === undefined && idleDays >= PERMISSION_GRANT_STALE_DAYS,
    idleDays,
    basis,
  };
}
