// 判定は機械の仕事ではない: 意図した close か事故かは timeline のデータだけからは区別できないため、一覧までを出して人が決める。
// 門にしない（required contexts に入れない）: 赤くする基準（閾値の妥当性）を確定させる機構が無いため。

import { evaluateIssueDoneTrailer } from './issue-done-trailer-core.mjs';
import { extractClosingKeywordReferences } from './check-pr-closing-keywords-core.mjs';

// 閾値を上げない: 上げるほど、人手のレビューが要らない偶然の一致が一覧に混ざるため。
export const DEFAULT_THRESHOLD_SECONDS = 10;

export const TRAILER_CLOSE_ACTOR = 'github-actions[bot]';

export const TRAILER_CLOSE_MAX_DELAY_SECONDS = 90;

function findNearestPriorMerge(mergedPRs, closedAtMs) {
  let best = null;
  for (const pr of mergedPRs) {
    if (pr.mergedAt > closedAtMs) continue;
    const diffSeconds = (closedAtMs - pr.mergedAt) / 1000;
    if (best === null || diffSeconds < best.diffSeconds) {
      best = { number: pr.number, mergedAt: pr.mergedAt, diffSeconds };
    }
  }
  return best;
}

function indexNamers(mergedPRs) {
  const trailerNamers = new Map();
  const keywordNamers = new Map();

  function add(map, issueNumber, entry) {
    if (!map.has(issueNumber)) map.set(issueNumber, []);
    map.get(issueNumber).push(entry);
  }

  for (const pr of mergedPRs) {
    if (typeof pr.body !== 'string') continue;
    const mergedAtMs = Date.parse(pr.mergedAt);
    if (Number.isNaN(mergedAtMs)) continue;
    const entry = { number: pr.number, mergedAt: mergedAtMs };

    const trailerResult = evaluateIssueDoneTrailer(pr.body);
    if (trailerResult.verdict === 'close') {
      for (const issue of trailerResult.issues) {
        add(trailerNamers, issue.number, entry);
      }
    }

    for (const issueNumber of extractClosingKeywordReferences(pr.body)) {
      add(keywordNamers, issueNumber, entry);
    }
  }

  return { trailerNamers, keywordNamers };
}

export function findKeywordClosedCandidates({
  mergedPRs,
  closeEvents,
  thresholdSeconds = DEFAULT_THRESHOLD_SECONDS,
}) {
  const mergedByOid = new Map();
  const mergedForTiming = [];
  for (const pr of mergedPRs) {
    const mergedAtMs = Date.parse(pr.mergedAt);
    if (Number.isNaN(mergedAtMs)) continue;
    mergedForTiming.push({ number: pr.number, mergedAt: mergedAtMs });
    if (typeof pr.mergeCommitOid === 'string' && pr.mergeCommitOid.length > 0) {
      mergedByOid.set(pr.mergeCommitOid, { number: pr.number, mergedAt: pr.mergedAt });
    }
  }
  const { trailerNamers, keywordNamers } = indexNamers(mergedPRs);

  const candidates = [];

  for (const ev of closeEvents) {
    const closedAtMs = Date.parse(ev.closedAt);
    if (Number.isNaN(closedAtMs)) continue;

    if (typeof ev.commitId === 'string' && ev.commitId.length > 0) {
      const matchedPr = mergedByOid.get(ev.commitId) ?? null;
      const secondsAfterMerge =
        matchedPr !== null ? (closedAtMs - Date.parse(matchedPr.mergedAt)) / 1000 : null;
      candidates.push({
        issueNumber: ev.issueNumber,
        closedAt: ev.closedAt,
        prNumber: matchedPr?.number ?? null,
        mergedAt: matchedPr?.mergedAt ?? null,
        secondsAfterMerge,
        matchedVia: 'commit-id',
        actor: ev.actor ?? null,
      });
      continue;
    }

    const nearestTrailerNamer = findNearestPriorMerge(
      trailerNamers.get(ev.issueNumber) ?? [],
      closedAtMs,
    );
    const isTrailerClose =
      ev.actor === TRAILER_CLOSE_ACTOR &&
      nearestTrailerNamer !== null &&
      nearestTrailerNamer.diffSeconds <= TRAILER_CLOSE_MAX_DELAY_SECONDS;
    if (isTrailerClose) {
      // 「過去にどこかの trailer で名乗られた」だけでは外さない: reopen 後に別の PR が閉じ直すことがあり、このイベントの時刻・actor と相関する命名 PR が要るため。
      continue;
    }

    const nearestKeywordNamer = findNearestPriorMerge(
      keywordNamers.get(ev.issueNumber) ?? [],
      closedAtMs,
    );
    if (nearestKeywordNamer !== null && nearestKeywordNamer.diffSeconds <= thresholdSeconds) {
      candidates.push({
        issueNumber: ev.issueNumber,
        closedAt: ev.closedAt,
        prNumber: nearestKeywordNamer.number,
        mergedAt: new Date(nearestKeywordNamer.mergedAt).toISOString(),
        secondsAfterMerge: nearestKeywordNamer.diffSeconds,
        matchedVia: 'timing',
        actor: ev.actor ?? null,
      });
      continue;
    }

    const nearest = findNearestPriorMerge(mergedForTiming, closedAtMs);
    if (nearest !== null && nearest.diffSeconds <= thresholdSeconds) {
      candidates.push({
        issueNumber: ev.issueNumber,
        closedAt: ev.closedAt,
        prNumber: nearest.number,
        mergedAt: new Date(nearest.mergedAt).toISOString(),
        secondsAfterMerge: nearest.diffSeconds,
        matchedVia: 'timing',
        actor: ev.actor ?? null,
      });
    }
  }

  return candidates;
}

export function formatReport(candidates, thresholdSeconds = DEFAULT_THRESHOLD_SECONDS) {
  const header = `check-keyword-closed-issues（閾値=${thresholdSeconds}秒）:`;
  if (candidates.length === 0) {
    return `${header} 候補は0件。`;
  }

  const lines = [
    `${header} ${candidates.length}件の候補。`,
    '⚠️ これは「閉じるキーワードで閉じた疑いがある」という一覧であって、意図した閉じ方か' +
      '事故かの判定ではない。この道具はその2つを区別できない——一覧を出すところまでが' +
      '機械の仕事で、判断は人がすること。',
    '',
  ];

  const sorted = [...candidates].sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1));
  for (const c of sorted) {
    const via =
      c.matchedVia === 'commit-id' ? 'commit_idがマージコミットと一致' : 'マージ直後のタイミング';
    const prPart = c.prNumber !== null ? `PR #${c.prNumber}` : '対応する merged PR は不明';
    const secondsPart =
      c.secondsAfterMerge !== null ? `マージの${c.secondsAfterMerge}秒後` : '（時間差は不明）';
    const actorPart = c.actor ? `actor=${c.actor}` : '';
    lines.push(
      `  #${c.issueNumber} closed ${c.closedAt} — ${prPart}の${secondsPart}（${via}）${actorPart}`,
    );
  }

  return lines.join('\n');
}
