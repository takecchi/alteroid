/**
 * `GET /status` の `cloneSessionRefusal`（クローンのセッションが安全分類器に弾かれ続けている状況。#4173）を
 * 読む・1行に言う部品。
 */

export interface SessionRefusal {
  streak: number;
  category: string | null;
  since: string | null;
  sessionId: string | null;
  autoReopen: 'enabled' | 'disabled' | 'halted';
}

/** 形が読めなければ `null`（作り物を返さない）。 */
export function readSessionRefusal(value: unknown): SessionRefusal | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const autoReopen = raw.autoReopen;
  if (autoReopen !== 'enabled' && autoReopen !== 'disabled' && autoReopen !== 'halted') return null;
  if (typeof raw.streak !== 'number') return null;
  return {
    streak: raw.streak,
    category: typeof raw.category === 'string' ? raw.category : null,
    since: typeof raw.since === 'string' ? raw.since : null,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
    autoReopen,
  };
}

const AUTO_REOPEN_LABEL = {
  enabled: '自動の開き直し: 有効',
  disabled: '自動の開き直し: 外してある',
  halted: '自動の開き直し: 止めた（開き直したセッションも答えないまま弾かれた）',
} as const;

/** `alteroid daemon status` に足す1行。 */
export function describeSessionRefusalLine(refusal: SessionRefusal): string {
  const category = refusal.category ?? '不明';
  const head =
    refusal.streak > 0
      ? `クローンのセッションが安全分類器に ${String(refusal.streak)} 回続けて弾かれている（category: ${category}）`
      : 'クローンのセッションの自動の開き直しを止めている';
  return `  ⚠ ${head}。${AUTO_REOPEN_LABEL[refusal.autoReopen]}。開き直す: alteroid reopen\n`;
}
