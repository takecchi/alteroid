// 判定を vitest の外に出さない: `.skip` で自分を黙らせる手口は `test-guard-core.mjs` の歯Bがすべてのテストファイルを走査して既に塞いでいるため。
// 対象は `*.test.ts` と名指しした helper だけ: helper 自身は正当に `mkdtemp` を呼んでよく、広げると helper を書くたびに誤爆するため。
// 許可リストは古びたら赤くする（`stale`）: 許可リストへ書き戻したファイルの消し忘れに気づけるようにするため。

export const HELPER_GLOBS = [
  '**/*.test-support.ts',
  'scripts/git-child-env.ts',
  '.github/scripts/git-child-env.ts',
];

const MKDTEMP_CALL_RE = /\bmkdtemp(Sync)?\s*\(/g;

export function findDirectMkdtempCalls(files) {
  const hits = [];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      MKDTEMP_CALL_RE.lastIndex = 0;
      const m = MKDTEMP_CALL_RE.exec(lines[i]);
      if (m) {
        hits.push({ path: file.path, line: i + 1, matched: m[0].trim() });
      }
    }
  }
  return hits;
}

export function formatMkdtempGuardMessage(violations) {
  const lines = violations.map((h) => `  ${h.path}:${h.line}  ${h.matched}`);
  return [
    `no-direct-mkdtemp: 許可リストに無い直接呼び出しが ${violations.length} 件見つかった:`,
    ...lines,
    '',
    'テストファイルから mkdtemp / mkdtempSync を直接呼ばず、',
    'vitest.tmpdir.ts の makeTempDir / makeTempDirSync を使うこと。',
    '（本番コードの挙動そのものを確かめるテストなど、正当な理由があるなら',
    ' scripts/no-direct-mkdtemp-core.mjs の ALLOWLIST へ理由つきで追加する。）',
  ].join('\n');
}

export function formatStaleAllowlistMessage(stalePaths) {
  return [
    `no-direct-mkdtemp: 許可リストに載っているが、もう直接呼び出しが無いファイルが ${stalePaths.length} 件ある:`,
    ...stalePaths.map((p) => `  ${p}`),
    '',
    '移行が済んだ（helper へ寄せた、または呼び出し自体を消した）なら、',
    'scripts/no-direct-mkdtemp-core.mjs の ALLOWLIST からその行を消すこと。',
    '許可リストを実態より広いまま残すと、次に何が移行済みかが分からなくなる。',
  ].join('\n');
}

export function judgeMkdtempScan(matchedPaths, hits, allowlist) {
  if (matchedPaths.length === 0) {
    return {
      ok: false,
      kind: 'scan-empty',
      message: [
        'no-direct-mkdtemp: 判定できない — 走査対象が0ファイルだった。',
        'root の vitest.config.ts の include に一致するテストファイルが1件も見つからない。',
        'include の glob 展開に失敗した、走査の起点がずれた、などが疑われる',
        '（test-guard-core.mjs の EXIT_SCAN_EMPTY と同じ状態）。',
      ].join('\n'),
    };
  }

  const violations = hits.filter((h) => !allowlist.has(h.path));
  if (violations.length > 0) {
    return { ok: false, kind: 'violation', message: formatMkdtempGuardMessage(violations) };
  }

  const hitPaths = new Set(hits.map((h) => h.path));
  const stalePaths = [...allowlist.keys()].filter((p) => !hitPaths.has(p));
  if (stalePaths.length > 0) {
    return { ok: false, kind: 'stale-allowlist', message: formatStaleAllowlistMessage(stalePaths) };
  }

  return { ok: true, scanned: matchedPaths.length, allowlisted: allowlist.size };
}

export const ALLOWLIST = new Map([]);
