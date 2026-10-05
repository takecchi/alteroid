import { assertNoNul, stripNul } from './nul-guard.js';
import type { PermissionGrant } from './schema.js';

/**
 * `PermissionGrantStore.put` の入口の NUL の扱い（issue #2927。teto の判断、2026-10-05）。
 * 3実装が書く前に呼ぶ。
 *
 * - 鍵と参照キー（`id`・`approvalId`・`route.accountId`）は `NulNotAllowedError` で断る。
 * - 本文（`rule`・`allows`・`denies`・`answer`）は NUL を落として残す（pg は jsonb で持つので
 *   NUL を持てない。fs も含めて落とす）。
 *
 * 入力は書き換えず、整えた写しを返す。
 */
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
