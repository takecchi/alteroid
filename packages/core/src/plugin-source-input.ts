// plugin の取り元の指定（`POST /plugins/preview` の本文）の形の規則。デーモンの入口の zod スキーマ（plugins.ts）と、web の送る前の検査が同じものを使う。
// zod も node: も import しない: ブラウザの束に zod（約 100 KB）を入れないため。plugins.ts は node:crypto と store.js も引く。
// zod のスキーマは、ここの定数・関数から組む（規則を二重に書かない）。同じ入力の表を両方に通して判定が一致することを plugin-source-input.test.ts が見る。
// 拒む文言には値（path・URL など）を載せず、どの欄かだけを書く。

export const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const PLUGIN_NAME_RULE = '英数字・-・_ の1〜64文字で書くこと';

// ブランチ名・タグ・短縮形は受けない: 固定にならないから。
export const PLUGIN_SHA_PATTERN = /^[0-9a-f]{40}$/;
export const PLUGIN_SHA_RULE = '小文字40桁の16進（commit SHA）で書くこと';

export const PLUGIN_LIMITS = {
  maxFiles: 4096,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxPathLength: 512,
  maxSegmentBytes: 255,
  maxUrlLength: 2048,
} as const;

export const PLUGIN_SOURCE_REF_MAX_LENGTH = 256;

// eslint-disable-next-line no-control-regex -- 制御文字を弾くための検査
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// 理由に path の中身は載せない。
// セグメントの長さは UTF-8 のバイト数で見る。ブラウザにも在る TextEncoder を使う
export function validatePluginFilePath(path: unknown): string | null {
  if (typeof path !== 'string') return 'path が文字列でない';
  if (path === '') return 'path が空';
  if (path.length > PLUGIN_LIMITS.maxPathLength) return 'path が長すぎる';
  if (path.includes('\u0000')) return 'path に NUL を含む';
  if (CONTROL_CHARS.test(path)) return 'path に制御文字を含む';
  if (path.includes('\\')) return 'path に \\ を含む';
  if (path.startsWith('/')) return 'path が絶対パス';
  if (/^[A-Za-z]:/.test(path)) return 'path がドライブ文字で始まる';
  const encoder = new TextEncoder();
  for (const segment of path.split('/')) {
    if (segment === '') return 'path に空のセグメントがある';
    if (segment === '.' || segment === '..') return 'path に . / .. のセグメントがある';
    if (encoder.encode(segment).length > PLUGIN_LIMITS.maxSegmentBytes) {
      return 'path のセグメントが長すぎる';
    }
  }
  return null;
}

// 資格つき・クエリ・フラグメントを受けない: トークンを日誌や DB に残さないため。理由を返す（通れば null）
export function validatePluginRepoUrl(value: string): string | null {
  if (value.length > PLUGIN_LIMITS.maxUrlLength) return 'URL が長すぎる';
  // eslint-disable-next-line no-control-regex -- 空白・制御文字を弾くための検査
  if (/[\u0000- \u007f]/.test(value)) return 'URL に空白・制御文字を含む';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'URL として読めない';
  }
  if (url.protocol !== 'https:') return 'https の URL だけ受ける';
  if (url.username !== '' || url.password !== '') return 'URL に資格を含められない';
  if (url.hostname === '') return 'URL にホスト名が無い';
  // 空のクエリ・フラグメント（`?` `#` だけ）も `URL` は正規化で消すので、元の文字列で見る。
  if (value.includes('?') || value.includes('#')) return 'URL にクエリ・フラグメントを含められない';
  return null;
}

// ref の中身の規則（空・長さは zod 側が min / max で持つので、文字だけ）
export function validatePluginSourceRefChars(value: string): string | null {
  // eslint-disable-next-line no-control-regex -- 制御文字・空白を弾くための検査
  if (/[\u0000- \u007f]/.test(value) || value.startsWith('-')) return '使えない文字を含む';
  return null;
}

// 空・長さ・文字をまとめて見る（web の検査用）。zod の `min(1).max(...)` と文字の検査と同じ判定
export function validatePluginSourceRef(value: string): string | null {
  if (value.length < 1) return '空';
  if (value.length > PLUGIN_SOURCE_REF_MAX_LENGTH) return '長すぎる';
  return validatePluginSourceRefChars(value);
}
