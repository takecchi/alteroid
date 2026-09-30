/**
 * 長く使われていない許可を見分ける純粋な判定（Issue #1804）。
 *
 * **実行時の依存を1つも持たない**（型も構造で受ける）。CLI（`alteroid permission
 * list`）と Web（`/permissions`）が同じ判定を使うために置き、Web はバレルを値で
 * import できないので `@alteroid/core/permission-staleness` の軽い口から読む
 * （`permission-rule.ts` / `answered-via.ts` と同じ路線）。
 *
 * **目立たせるだけで、自動では取り消さない。期限の欄も足さない**（オーナー決定。
 * 許可は無期限のまま、取り消すかどうかは人が決める）。
 *
 * `now` は引数で受ける（`Date.now()` をここで読まない）。テストが時計を注入する。
 */

/**
 * 何日使われていなければ「長く使われていない」とするか。
 * 月に1回使う許可を誤って目立たせないよう、月の周期（30日強）に2週間の余裕を足した。
 * 目立たせるだけなので、長めに倒しても失うものが無い。
 */
export const PERMISSION_GRANT_STALE_DAYS = 45;

export interface PermissionGrantStalenessInput {
  grantedAt: string;
  lastUsedAt?: string | undefined;
  revokedAt?: string | undefined;
}

export interface PermissionGrantStaleness {
  /** 取り消し済みは常に false。それ以外は `idleDays >= PERMISSION_GRANT_STALE_DAYS`。 */
  stale: boolean;
  /** 起点から `now` までの経過日数（切り捨て。未来の起点は 0）。 */
  idleDays: number;
  /** 起点。`lastUsedAt` があればそれ、無ければ `grantedAt`。 */
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
