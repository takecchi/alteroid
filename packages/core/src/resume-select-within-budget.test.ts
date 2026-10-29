import { describe, expect, it } from 'vitest';

import { selectPeersWithinBudget, type ResumePeerTranscript } from './resume-peers.js';
import { selectSubagentsWithinBudget, type ResumeSubagentTranscript } from './resume-subagents.js';

// 作業者の分と peer の分は、鍵の欄（`subpath` / `peerId`）が違うだけで、同じ規則で選ぶ。
// 同じ場面を両方へ通し、選び方が揃っていることを縛る。
interface Selector {
  name: string;
  select: (
    candidates: ReadonlyArray<{ key: string; entries: unknown[] }>,
    budgetChars?: number,
  ) => { included: string[]; omitted: string[] };
}

const subagents: Selector = {
  name: 'selectSubagentsWithinBudget',
  select: (candidates, budgetChars) => {
    const transcripts: ResumeSubagentTranscript[] = candidates.map(({ key, entries }) => ({
      subpath: key,
      entries,
    }));
    const picked = selectSubagentsWithinBudget(transcripts, budgetChars);
    return { included: picked.included.map((item) => item.subpath), omitted: picked.omitted };
  },
};

const peers: Selector = {
  name: 'selectPeersWithinBudget',
  select: (candidates, budgetChars) => {
    const transcripts: ResumePeerTranscript[] = candidates.map(({ key, entries }) => ({
      peerId: key,
      provider: 'codex',
      threadId: `thread-${key}`,
      relPath: `rollout-${key}.jsonl`,
      entries,
    }));
    const picked = selectPeersWithinBudget(transcripts, budgetChars);
    return { included: picked.included.map((item) => item.peerId), omitted: picked.omitted };
  },
};

function at(minute: number): string {
  return new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();
}

function entry(chars: number, timestamp?: unknown): Record<string, unknown> {
  return { ...(timestamp === undefined ? {} : { timestamp }), pad: 'x'.repeat(chars) };
}

// 上限が数えるもの（各 entry の JSON の文字数の和）
function sizeOf(entries: readonly unknown[]): number {
  return entries.reduce<number>((sum, item) => sum + (JSON.stringify(item) ?? '').length, 0);
}

describe.each([subagents, peers])(
  '$name（resume で戻す記録を上限に収まるぶんだけ選ぶ）',
  ({ select }) => {
    it('新しい順に並べて入れる', () => {
      const picked = select([
        { key: 'old', entries: [entry(10, at(1))] },
        { key: 'new', entries: [entry(10, at(3))] },
        { key: 'mid', entries: [entry(10, at(2))] },
      ]);

      expect(picked).toEqual({ included: ['new', 'mid', 'old'], omitted: [] });
    });

    it('新しさが同じなら、鍵の大きいほうを先に入れる', () => {
      const one = [entry(100, at(1))];
      const picked = select(
        [
          { key: 'a', entries: one },
          { key: 'b', entries: one },
        ],
        sizeOf(one),
      );

      expect(picked).toEqual({ included: ['b'], omitted: ['a'] });
    });

    it('入らない1本は落とし、その後ろの小さいものが入るなら入れる', () => {
      const small = [entry(10, at(2))];
      const smallOldest = [entry(10, at(1))];
      const picked = select(
        [
          { key: 'big-newest', entries: [entry(500, at(3))] },
          { key: 'small', entries: small },
          { key: 'small-oldest', entries: smallOldest },
        ],
        sizeOf(small) + sizeOf(smallOldest),
      );

      expect(picked).toEqual({ included: ['small', 'small-oldest'], omitted: ['big-newest'] });
    });

    it('新しさは後ろから見て最初に読める timestamp で決め、読めなければ最も古い扱いにする', () => {
      const unreadable = [entry(10, 'not a date'), entry(10, 42), 'line'];
      const earlierStamp = [entry(10, at(5)), entry(10), null];
      const latest = [entry(10, at(1)), entry(10, at(4))];
      const picked = select(
        [
          { key: 'unreadable', entries: unreadable },
          { key: 'earlier-stamp', entries: earlierStamp },
          { key: 'latest', entries: latest },
        ],
        sizeOf(earlierStamp) + sizeOf(latest),
      );

      expect(picked).toEqual({ included: ['earlier-stamp', 'latest'], omitted: ['unreadable'] });
    });

    it('既定の上限（32 MiB 相当）に収まるなら全部入れる', () => {
      const picked = select([
        { key: 'a', entries: [entry(10, at(1))] },
        { key: 'b', entries: [entry(10, at(2))] },
      ]);

      expect(picked).toEqual({ included: ['b', 'a'], omitted: [] });
    });
  },
);
