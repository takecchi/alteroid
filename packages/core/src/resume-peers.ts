import { selectNewestWithinBudget } from './resume-budget.js';

/**
 * 担当の resume で戻す peer（Codex）の会話の記録。
 * 預かり先（SessionStore）では、担当の主の記録と同じ `projectKey` / `sessionId` に `subpath: 'peers/<peerId>'` を足した鍵で持つ。
 * 行は Codex の rollout の行（`timestamp, ordinal, type, payload`）で、先頭に1件、戻す場所を作るための印（{@link PeerMetaEntry}）を預ける。
 */
export const PEER_SUBPATH_PREFIX = 'peers/';

/** 印の行の `type`。rollout の行には無い名前にして、戻すときに rollout の行と取り違えない。 */
export const PEER_META_ENTRY_TYPE = 'alteroid_peer_meta';

export interface PeerMetaEntry {
  readonly type: typeof PEER_META_ENTRY_TYPE;
  readonly provider: string;
  readonly threadId: string;
  /** Codex の `CODEX_HOME/sessions/` から下の相対パス（`rollout-…-<threadId>.jsonl` で終わる）。 */
  readonly relPath: string;
}

export interface ResumePeerTranscript {
  readonly peerId: string;
  readonly provider: string;
  readonly threadId: string;
  readonly relPath: string;
  readonly entries: unknown[];
}

/**
 * 合計の上限（各 entry の JSON の文字数の和）。作業者の分（`RESUME_SUBAGENT_BUDGET_CHARS`）とは別に数える:
 * peer の記録は rollout の全行（ツールの出力を含む）で、作業者の分と同じ枠を取り合うと、どちらかが丸ごと落ちるため。
 */
export const RESUME_PEER_BUDGET_CHARS = 32 * 1024 * 1024;

export function isPeerSubpath(subpath: string): boolean {
  return subpath.startsWith(PEER_SUBPATH_PREFIX) && subpath.length > PEER_SUBPATH_PREFIX.length;
}

export function peerIdOfSubpath(subpath: string): string {
  return subpath.slice(PEER_SUBPATH_PREFIX.length);
}

export function isPeerMetaEntry(entry: unknown): entry is PeerMetaEntry {
  if (typeof entry !== 'object' || entry === null) return false;
  const record = entry as Record<string, unknown>;
  return (
    record.type === PEER_META_ENTRY_TYPE &&
    typeof record.provider === 'string' &&
    typeof record.threadId === 'string' &&
    typeof record.relPath === 'string'
  );
}

/**
 * 預かった行から印を取り出して peer の記録に組む。印が無い・読めなければ `undefined`（置き場が作れない）。
 * 印は最後の1件を採る（続きから起こした回に重ねて預けるため）。印の行は `entries` から外す。
 */
export function buildPeerTranscript(
  peerId: string,
  stored: readonly unknown[],
): ResumePeerTranscript | undefined {
  let meta: PeerMetaEntry | undefined;
  const entries: unknown[] = [];
  for (const entry of stored) {
    if (isPeerMetaEntry(entry)) meta = entry;
    else entries.push(entry);
  }
  if (meta === undefined || entries.length === 0) return undefined;
  return {
    peerId,
    provider: meta.provider,
    threadId: meta.threadId,
    relPath: meta.relPath,
    entries,
  };
}

/** 選び方は `selectNewestWithinBudget` のとおり。落としたものの peerId は `omitted` に返す。 */
export function selectPeersWithinBudget(
  candidates: readonly ResumePeerTranscript[],
  budgetChars: number = RESUME_PEER_BUDGET_CHARS,
): { included: ResumePeerTranscript[]; omitted: string[] } {
  return selectNewestWithinBudget(candidates, (candidate) => candidate.peerId, budgetChars);
}
