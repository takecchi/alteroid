// 検査Bは定型句を探さず、同じテキストに「枝」と保持語が在るかだけを見る: 定型句の完全一致だと本物の保持を静かに取りこぼすため。

export const BRANCH_WORDS = ['枝', 'ブランチ'];

// 保持語の一覧は狭めない: 狭めると本物の保持を取りこぼすため。
export const RETENTION_WORDS = [
  '残す',
  '残る',
  '残しま',
  '残して',
  '消しません',
  '消さない',
  '消していない',
  '削除してはいけない',
  '削除候補ではない',
];

export function hasBranchWord(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return BRANCH_WORDS.some((w) => text.includes(w));
}

export function findRetentionWordHits(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const hits = [];
  for (const word of RETENTION_WORDS) {
    const index = text.indexOf(word);
    if (index !== -1) hits.push({ word, index });
  }
  return hits;
}

export function excerptAround(text, index, matchLength, radius = 150) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + matchLength + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end) + suffix;
}

export function evaluateRetentionPromise(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { promising: false, hits: [] };
  }
  if (!hasBranchWord(text)) {
    return { promising: false, hits: [] };
  }
  const retentionHits = findRetentionWordHits(text);
  if (retentionHits.length === 0) {
    return { promising: false, hits: [] };
  }
  const hits = retentionHits.map(({ word, index }) => ({
    word,
    excerpt: excerptAround(text, index, word.length),
  }));
  return { promising: true, hits };
}

export function evaluateRetentionSources(sources) {
  const hits = [];
  for (const src of sources ?? []) {
    const result = evaluateRetentionPromise(src?.text);
    if (!result.promising) continue;
    for (const h of result.hits) {
      hits.push({ prNumber: src.prNumber, source: src.source, word: h.word, excerpt: h.excerpt });
    }
  }
  return hits;
}

export function parseGitGrepMatches(rawOutput, revPrefix) {
  if (typeof rawOutput !== 'string' || rawOutput.trim().length === 0) return [];
  const prefix = `${revPrefix}:`;
  const matches = [];
  for (const rawLine of rawOutput.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;
    const withoutRev = line.startsWith(prefix) ? line.slice(prefix.length) : line;
    const firstColon = withoutRev.indexOf(':');
    const secondColon = firstColon === -1 ? -1 : withoutRev.indexOf(':', firstColon + 1);
    if (firstColon === -1 || secondColon === -1) {
      // 分解できなかった行は落とさずそのまま見せる: 静かに消えると形の崩れに気づけないため。
      matches.push({ path: null, line: null, content: withoutRev });
      continue;
    }
    matches.push({
      path: withoutRev.slice(0, firstColon),
      line: withoutRev.slice(firstColon + 1, secondColon),
      content: withoutRev.slice(secondColon + 1),
    });
  }
  return matches;
}

const DISCLAIMER =
  'これは「消すな」ではなく「読め」である。誤検出が在る' +
  '（検査Bは「枝」または「ブランチ」＋保持語の同居だけを見る。文意までは判定しない）。';

export function formatBranchSection(branchName, checkAMatches, checkBHits) {
  const lines = [`## ${branchName}`, '', `A: ${checkAMatches.length}件`];
  for (const m of checkAMatches) {
    lines.push(`  ${m.path ?? '(解釈できない行)'}:${m.line ?? '?'}: ${m.content}`);
  }
  lines.push('', `B: ${checkBHits.length}件`);
  for (const h of checkBHits) {
    lines.push(`  PR #${h.prNumber} ${h.source} — 保持語「${h.word}」: ${h.excerpt}`);
  }
  return lines.join('\n');
}

export function buildReport(branchResults) {
  const sections = [];
  let anyHit = false;
  for (const r of branchResults) {
    if (r.checkAMatches.length > 0 || r.checkBHits.length > 0) anyHit = true;
    const section = [formatBranchSection(r.branch, r.checkAMatches, r.checkBHits)];
    if (r.errors && r.errors.length > 0) {
      section.push('', '⚠ 収集中のエラー:', ...r.errors.map((e) => `  ${e}`));
    }
    sections.push(section.join('\n'));
  }
  const text = [`⚠ ${DISCLAIMER}`, '', ...sections, '', `⚠ ${DISCLAIMER}`].join('\n');
  return { text, exitCode: anyHit ? 1 : 0 };
}
