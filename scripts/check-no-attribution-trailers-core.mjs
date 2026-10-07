// repo のファイルを走査しない: この門自身のテストの fixture が逐語を持つため、走査すると自己参照で誤検出する。
// 読めなかったら「見つからなかった」ではなく赤くする（`unreadable`）: 2値にすると判定できない場合が黙ってどちらかへ倒れるため。

// 大小文字を区別しない: `Co-Authored-By` と `Co-authored-by` が実際に共存していたため。
// `git interpret-trailers` に判定を委ねない: `🤖 Generated with [Claude Code](...)` は `Key: value` の形ではなく、取りこぼすため。
// 行頭の印はコードブロックや引用の中でも赤にする: squash マージは本文を丸ごと写し、囲みが素通りの経路になるため。
export const ATTRIBUTION_MARKERS = [
  {
    id: 'co-authored-by',
    label: 'Co-Authored-By:',
    pattern: /^\s*co-authored-by:/im,
  },
  {
    id: 'generated-with',
    label: '🤖 Generated with',
    pattern: /^\s*🤖\s*generated with/im,
  },
];

export function findAttributionMarkers(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  return ATTRIBUTION_MARKERS.filter((marker) => marker.pattern.test(text)).map(
    (marker) => marker.label,
  );
}

export function commitFullMessage(headline, messageBody) {
  const h = typeof headline === 'string' ? headline : '';
  const b = typeof messageBody === 'string' ? messageBody : '';
  return b.length > 0 ? `${h}\n\n${b}` : h;
}

export function evaluateNoAttributionTrailers({ body, commits }) {
  if (body === null || commits === null) {
    return { verdict: 'unreadable', findings: [] };
  }

  const findings = [];

  const bodyMarkers = findAttributionMarkers(body);
  if (bodyMarkers.length > 0) {
    findings.push({ source: 'PR 本文', markers: bodyMarkers });
  }

  for (const commit of commits) {
    const markers = findAttributionMarkers(commit?.message);
    if (markers.length === 0) continue;
    const oidShort =
      typeof commit?.oid === 'string' && commit.oid.length > 0
        ? commit.oid.slice(0, 7)
        : '(sha不明)';
    const headline =
      typeof commit?.headline === 'string' && commit.headline.length > 0
        ? ` "${commit.headline}"`
        : '';
    findings.push({ source: `commit ${oidShort}${headline}`, markers });
  }

  return { verdict: findings.length > 0 ? 'found' : 'clean', findings };
}

export function formatVerdict(prNumber, result) {
  const header = `check-no-attribution-trailers(#${prNumber}):`;
  switch (result.verdict) {
    case 'unreadable':
      return (
        `${header} 判定できなかった —— PR 本文かコミットメッセージを読めなかった` +
        '（fail-closed。「見つからなかった」ではなく赤くする）'
      );
    case 'found':
      return [
        `${header} NG —— Co-Authored-By: / 🤖 Generated with がまだ残っている`,
        ...result.findings.map((f) => `  ${f.source}: ${f.markers.join(', ')}`),
      ].join('\n');
    case 'clean':
      return (
        `${header} OK —— PR 本文・全コミットメッセージのどちらにも ` +
        'Co-Authored-By: / 🤖 Generated with が無い'
      );
    default:
      return `${header} 未知の verdict: ${result.verdict}`;
  }
}
