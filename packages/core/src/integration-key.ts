import { z } from 'zod';

import { randomToken, sha256Hex } from './auth.js';
import { assertNoNul, stripNul } from './nul-guard.js';
import type { RemoveUnreadableRowsOptions, RemoveUnreadableRowsResult } from './store.js';

// `scopes: [...]` のような選べる許可の一覧を持たない: 持った瞬間に `permissions.yaml` と同じ形になるため
export const INTEGRATION_KEY_PREFIX = 'altk_';

export const DEFAULT_INTEGRATION_MAX_BODY_BYTES = 1024 * 1024;

export const DEFAULT_INTEGRATION_RATE_PER_MINUTE = 60;

export const INTEGRATION_KEY_LAST_USED_THROTTLE_MS = 60_000;

export const INTEGRATION_SOURCE_PATTERN = /^[a-z0-9._-]{1,64}$/;

const isoDateTime = z.string().datetime({ offset: true });

export const integrationSourceSchema = z.string().regex(INTEGRATION_SOURCE_PATTERN);

export const integrationKeyRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  source: integrationSourceSchema,
  sha256: z.string().length(64),
  createdAt: isoDateTime,
  createdBy: z.string().min(1),
  expiresAt: isoDateTime.nullable(),
  revokedAt: isoDateTime.nullable(),
  lastUsedAt: isoDateTime.nullable(),
  maxBodyBytes: z.number().int().positive().max(2_147_483_647).nullable(),
  ratePerMinute: z.number().int().positive().max(2_147_483_647).nullable(),
});

export type IntegrationKeyRecord = z.infer<typeof integrationKeyRecordSchema>;

// 行の中身（名前・source・sha256 など）を載せない: 識別に使うのは id だけのため
export interface UnreadableIntegrationKey {
  id?: string | undefined;
  reason: string;
}

export type RevokeIntegrationKeyOutcome =
  | { status: 'not_found' }
  | { status: 'already_revoked'; key: IntegrationKeyRecord }
  | { status: 'revoked'; key: IntegrationKeyRecord };

export interface IntegrationKeyStore {
  putIntegrationKey(key: IntegrationKeyRecord): Promise<void>;
  findIntegrationKeyBySha256(sha256: string): Promise<IntegrationKeyRecord | null>;
  getIntegrationKey(id: string): Promise<IntegrationKeyRecord | null>;
  listIntegrationKeys(): Promise<IntegrationKeyRecord[]>;
  markIntegrationKeyUsed(id: string, at: string): Promise<void>;
  revokeIntegrationKey(id: string, at: string): Promise<RevokeIntegrationKeyOutcome>;
  listUnreadableIntegrationKeys(): Promise<UnreadableIntegrationKey[]>;
  removeUnreadableIntegrationKeys(
    ids: readonly string[],
    options?: RemoveUnreadableRowsOptions,
  ): Promise<RemoveUnreadableRowsResult>;
}

export function issueIntegrationKeyValue(): string {
  return `${INTEGRATION_KEY_PREFIX}${randomToken(32)}`;
}

export function looksLikeIntegrationKey(bearer: string): boolean {
  return bearer.startsWith(INTEGRATION_KEY_PREFIX);
}

export function integrationKeyFingerprint(sha256: string): string {
  return sha256.slice(0, 12);
}

// 期限は「期限より前なら開く」向きで比べる: `NaN` との比較はどれも偽になり、閉じる側へ落ちるため
export function isIntegrationKeyUsable(key: IntegrationKeyRecord, now: Date): boolean {
  if (key.revokedAt !== null) return false;
  if (key.expiresAt === null) return true;
  const expiresAt = Date.parse(key.expiresAt);
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt > now.getTime();
}

export interface IntegrationLimits {
  maxBodyBytes: number;
  ratePerMinute: number;
}

export function integrationKeyLimits(key: IntegrationKeyRecord): IntegrationLimits {
  return {
    maxBodyBytes: key.maxBodyBytes ?? DEFAULT_INTEGRATION_MAX_BODY_BYTES,
    ratePerMinute: key.ratePerMinute ?? DEFAULT_INTEGRATION_RATE_PER_MINUTE,
  };
}

export function prepareIntegrationKeyForWrite(key: IntegrationKeyRecord): IntegrationKeyRecord {
  assertNoNul('integrationKey.id', key.id);
  assertNoNul('integrationKey.source', key.source);
  assertNoNul('integrationKey.sha256', key.sha256);
  assertNoNul('integrationKey.createdBy', key.createdBy);
  return { ...key, name: stripNul(key.name) };
}

export function compareIntegrationKeyOrder(
  a: IntegrationKeyRecord,
  b: IntegrationKeyRecord,
): number {
  const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
  if (a.id < b.id) return -1;
  return a.id > b.id ? 1 : 0;
}

export async function resolveIntegrationKey(options: {
  store: IntegrationKeyStore;
  bearer: string;
  now: Date;
}): Promise<IntegrationKeyRecord | null> {
  const { store, bearer, now } = options;
  if (!looksLikeIntegrationKey(bearer)) return null;
  const found = await store.findIntegrationKeyBySha256(sha256Hex(bearer));
  if (found === null || !isIntegrationKeyUsable(found, now)) return null;
  const previous = found.lastUsedAt === null ? 0 : Date.parse(found.lastUsedAt);
  if (!(now.getTime() - previous < INTEGRATION_KEY_LAST_USED_THROTTLE_MS)) {
    await store.markIntegrationKeyUsed(found.id, now.toISOString());
  }
  return found;
}
