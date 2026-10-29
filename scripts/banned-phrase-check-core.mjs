// 「生成元の外に助言の字面を書き直していないか」を見る検査の共通部分。字面・生成元・検査自身の core の場所は各検査の core が持つ。
// 生成元・テスト・その検査自身の core は免除する: 生成元の出力を当てる側であり、core は探す字面の定義を持つため、免除しないと門が自分自身を指して赤くなり続ける。

import { listGitScannableFiles } from './git-scannable-files-core.mjs';

export function isExemptPath(path, { generatorPath, checkerCorePath }) {
  return (
    path === generatorPath ||
    path === checkerCorePath ||
    path.endsWith('.test.ts') ||
    path.endsWith('.test.tsx') ||
    path.endsWith('.test.jsx')
  );
}

export function findBannedPhraseHits(files, phrases, isExempt) {
  const hits = [];
  for (const file of files) {
    if (isExempt(file.path)) continue;
    const lines = file.content.split('\n');
    for (const phrase of phrases) {
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
const TARGET_SUFFIXES = ['.ts', '.mjs', '.js', '.tsx', '.jsx'];

export function listScannableSources(root) {
  return listGitScannableFiles({ cwd: root }).filter((path) =>
    TARGET_SUFFIXES.some((suffix) => path.endsWith(suffix)),
  );
}
