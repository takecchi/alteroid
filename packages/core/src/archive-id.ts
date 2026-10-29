import { compareIsoInstant } from './iso-instant.js';

const ARCHIVE_ID_STAMP_SUFFIX_RE =
  /-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:-(\d+))?\.jsonl$/;

// 非可逆: 文字の違う2つの sessionId が同じ名前になりうるので、元の sessionId は ID から復元せず脇の記録から読む
// pg と fs で同じ置き換えにする: ID の形が器で違うと `archiveIdBranch` が片方の ID を読み違えるため
export function sanitizeArchiveSessionId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

// 枝番を付ける前の土台: `matchArchiveIdStamp` が読めるスタンプの形（`:` と `.` を `-` にした ISO）と揃える
export function archiveIdBase(sessionId: string, at: Date): string {
  return `${sanitizeArchiveSessionId(sessionId)}-${at.toISOString().replace(/[:.]/g, '-')}`;
}

// 1本目は枝番無し、2本目以降を `-2`: `archiveIdBranch` が枝番無しを 1 と読む形に合わせるため
export function archiveIdCandidate(base: string, attempt: number): string {
  return attempt === 1 ? `${base}.jsonl` : `${base}-${attempt}.jsonl`;
}

export interface ArchiveIdStampMatch {
  readonly suffix: string;
  readonly stamp: string;
  readonly branch: number;
}

export function matchArchiveIdStamp(id: string): ArchiveIdStampMatch | undefined {
  const match = ARCHIVE_ID_STAMP_SUFFIX_RE.exec(id);
  if (match === null) return undefined;
  const suffix = match[0];
  const stamp = match[1];
  const branchText = match[2];
  if (stamp === undefined) return undefined;
  return { suffix, stamp, branch: branchText === undefined ? 1 : Number.parseInt(branchText, 10) };
}

// 一致しない id を 1（いちばん古い側）にする: 想定外の id が「いちばん新しい」と誤認されないため
export function archiveIdBranch(id: string): number {
  return matchArchiveIdStamp(id)?.branch ?? 1;
}

// id の字面ではなく枝番の数値で比べる: `-` < `.` なので、枝番の無い id（1本目）が字面上は最大になるため
export function compareArchiveEntriesNewestFirst(
  a: { readonly sessionId: string; readonly at: string; readonly id: string },
  b: { readonly sessionId: string; readonly at: string; readonly id: string },
): number {
  // 実時刻で比べる: `at` はオフセット表記もありうるので、文字列では並びが狂うため
  const byInstant = compareIsoInstant(b.at, a.at);
  if (byInstant !== 0) return byInstant;
  if (a.sessionId === b.sessionId) {
    const branchDiff = archiveIdBranch(b.id) - archiveIdBranch(a.id);
    if (branchDiff !== 0) return branchDiff;
  } else {
    return a.sessionId < b.sessionId ? -1 : 1;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}
