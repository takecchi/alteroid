// 生成元・テスト・この検査自身の core は免除する: 生成元の出力を当てる側であり、core は探す字面の定義を持つため、免除しないと門が自分自身を指して赤くなり続ける。
// `manager.ts` の言い換えの族は射程に含めない: 場面が違う（貸し出しの関門）ため。

import { listGitScannableFiles } from './git-scannable-files-core.mjs';

export const GENERATOR_PATH = 'packages/core/src/usage-limits.ts';

export const BANNED_PHRASES = [
  {
    id: 'old',
    text: '先に manager_start で起こし直さないこと',
    why:
      '旧字面（#1287 で統一する前）。生成元 RESTART_BEFORE_CHECK_ADVICE / ' +
      'RESTART_BEFORE_CHECK_ADVICE_CODE_SPAN に揃えること',
  },
  {
    id: 'unified-plain',
    text: '確かめる前に manager_start で起こし直さないこと',
    why: '統一後の字面（バッククォート無し）。生成元定数 RESTART_BEFORE_CHECK_ADVICE を使わず直接書かれている',
  },
  {
    id: 'unified-code',
    text: '確かめる前に `manager_start` で起こし直さないこと',
    why:
      '統一後の字面（バッククォート有り）。生成元定数 RESTART_BEFORE_CHECK_ADVICE_CODE_SPAN を' +
      '使わず直接書かれている',
  },
];

export const CHECKER_CORE_PATH = 'scripts/check-restart-before-check-advice-core.mjs';

export function isExempt(path) {
  return (
    path === GENERATOR_PATH ||
    path === CHECKER_CORE_PATH ||
    path.endsWith('.test.ts') ||
    path.endsWith('.test.tsx') ||
    path.endsWith('.test.jsx')
  );
}

export function findRestartBeforeCheckAdviceHits(files) {
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
