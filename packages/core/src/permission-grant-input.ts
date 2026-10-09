import { assertNoNul, stripNul } from './nul-guard.js';
import type { PermissionGrant } from './schema.js';

/** 本文の NUL は pg の jsonb が持てないので、fs も含めて落とす。鍵と参照キーは断る。 */
export function preparePermissionGrantForPut(grant: PermissionGrant): PermissionGrant {
  assertNoNul('permissionGrant.id', grant.id);
  assertNoNul('permissionGrant.approvalId', grant.approvalId);
  assertNoNul('permissionGrant.route.accountId', grant.route.accountId);
  return {
    ...grant,
    rule: stripNul(grant.rule),
    allows: grant.allows.map(stripNul),
    denies: grant.denies.map(stripNul),
    answer: stripNul(grant.answer),
  };
}
