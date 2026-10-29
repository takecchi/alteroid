// 判定を vitest の外に出さない: `.skip` で自分を黙らせる手口は `test-guard-core.mjs` の歯Bがすべてのテストファイルを走査して既に塞いでいるため。
// 対象は `*.test.ts` と名指しした helper だけ: helper 自身は正当に `mkdtemp` を呼んでよく、広げると helper を書くたびに誤爆するため。

export const HELPER_GLOBS = ['**/*.test-support.ts', 'scripts/git-child-env.ts'];

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
    `no-direct-mkdtemp: 直接呼び出しが ${violations.length} 件見つかった:`,
    ...lines,
    '',
    'テストファイルから mkdtemp / mkdtempSync を直接呼ばず、',
    'vitest.tmpdir.ts の makeTempDir / makeTempDirSync を使うこと。',
  ].join('\n');
}

export function judgeMkdtempScan(matchedPaths, hits) {
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

  if (hits.length > 0) {
    return { ok: false, kind: 'violation', message: formatMkdtempGuardMessage(hits) };
  }

  return { ok: true, scanned: matchedPaths.length };
}
