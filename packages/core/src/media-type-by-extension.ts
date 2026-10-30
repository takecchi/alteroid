import { extname } from 'node:path';

// 拡張子から型を引く表は1か所に置く（#5800）: クローンの file_put・担い手の報告・CLI の /attach が別々に持つと、足りない拡張子が表ごとにずれ、同じファイルが経路によって octet-stream で届くため
const MEDIA_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export const FALLBACK_MEDIA_TYPE = 'application/octet-stream';

/** 中身は見ない: 画像かどうかの最終判定は置き場（`prepareAttachment`）が magic で照合する。 */
export function guessMediaTypeFromPath(path: string): string {
  return MEDIA_TYPES_BY_EXTENSION[extname(path).toLowerCase()] ?? FALLBACK_MEDIA_TYPE;
}
