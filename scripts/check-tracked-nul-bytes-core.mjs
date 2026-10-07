// パスの一覧で書く除外リストを持たない: 除外は本物の汚染を隠す穴になるため。
// PNG は拡張子が `.png` かつ先頭8バイトが PNG のシグネチャのものだけ外す: 片方だけだと、NUL に化けたテキストを隠す穴になるため。

import { listGitScannableFiles } from './git-scannable-files-core.mjs';

// エスケープ表記ではなく `String.fromCharCode` で作る: エスケープ表記を書いたつもりが生の NUL バイトに化けて書き込まれた事故があったため。
export const NUL_CHAR = String.fromCharCode(0);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPngImage(path, bytes) {
  if (!/\.png$/i.test(path)) return false;
  if (bytes.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

export function findNulByteHits(files) {
  const hits = [];
  for (const file of files) {
    const index = file.content.indexOf(NUL_CHAR);
    if (index !== -1) {
      hits.push({
        path: file.path,
        index,
        snippet: file.content.slice(Math.max(0, index - 20), index + 20),
      });
    }
  }
  return hits;
}

export function listScannableFiles(root) {
  return listGitScannableFiles({ cwd: root });
}
