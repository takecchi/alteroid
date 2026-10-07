// 生成元・テスト・この検査自身の core は免除する: 生成元の出力を当てる側であり、core は探す字面の定義を持つため、免除しないと門が自分自身を指して赤くなり続ける。
// 1 つ目の字面に `manager_stop → ` を含める: `lost` の委譲向けの「確かめてから起こし直せ」（別の助言）を誤って捕まえないため。

import { listGitScannableFiles } from './git-scannable-files-core.mjs';

export const GENERATOR_PATH = 'packages/core/src/usage-limits.ts';

export const BANNED_PHRASES = [
  {
    id: 'advice',
    text: 'manager_stop → manager_start で起こし直すこと',
    why: '助言の行動そのもの。生成元 STALE_TOKEN_RESTART_ADVICE を参照すること',
  },
  {
    id: 'understatement',
    text: '会話は失われる',
    why: '#914 が「失われるものを過小に言っている」と名指しした言い方。進行中の作業も失われる',
  },
];

export const CHECKER_CORE_PATH = 'scripts/check-stale-token-restart-advice-core.mjs';

export function isExempt(path) {
  return (
    path === GENERATOR_PATH ||
    path === CHECKER_CORE_PATH ||
    path.endsWith('.test.ts') ||
    path.endsWith('.test.tsx') ||
    path.endsWith('.test.jsx')
  );
}

export function findStaleTokenAdviceHits(files) {
  const hits = [];
  for (const file of files) {
    if (isExempt(file.path)) continue;
    const lines = file.content.split('\n');
    for (const phrase of BANNED_PHRASES) {
      lines.forEach((text, index) => {
        if (!text.includes(phrase.text)) return;
        hits.push({
          path: file.path,
          id: phrase.id,
          text: phrase.text,
          why: phrase.why,
          line: index + 1,
        });
      });
    }
  }
  return hits;
}

// `.tsx` / `.jsx` も走査する: 助言は JSX/TSX の文字列リテラルでも配られ、`apps/web` だけを対象外にする理由が無いため。
export const TARGET_SUFFIXES = ['.ts', '.mjs', '.js', '.tsx', '.jsx'];

export function listScannableSources(root) {
  return listGitScannableFiles({ cwd: root }).filter((path) =>
    TARGET_SUFFIXES.some((suffix) => path.endsWith(suffix)),
  );
}
