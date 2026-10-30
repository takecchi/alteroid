import { z } from 'zod';

// plugin の取り元の指定（`POST /plugins/preview` の本文）の形。デーモンの入口と、web の送る前の検査が同じものを使う。
// zod だけを import する小さな入口に切る: plugins.ts は node:crypto と store.js を引くので、ブラウザの束へ入れられないため。
// 拒む文言には値（path・URL など）を載せず、どの欄かだけを書く。

const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const PLUGIN_NAME_RULE = '英数字・-・_ の1〜64文字で書くこと';

export const pluginNameSchema = z.string().regex(PLUGIN_NAME_PATTERN, PLUGIN_NAME_RULE);

// ブランチ名・タグ・短縮形は受けない: 固定にならないから。
export const pluginSourceShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, '小文字40桁の16進（commit SHA）で書くこと');

export const PLUGIN_LIMITS = {
  maxFiles: 4096,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxPathLength: 512,
  maxSegmentBytes: 255,
  maxUrlLength: 2048,
} as const;

// eslint-disable-next-line no-control-regex -- 制御文字を弾くための検査
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// 理由に path の中身は載せない。
// セグメントの長さは UTF-8 のバイト数で見る。`Buffer` ではなく `TextEncoder` を使う: ブラウザにも在り、結果は同じため
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

export const relativePathSchema = z.string().superRefine((path, ctx) => {
  const reason = validatePluginFilePath(path);
  if (reason !== null) ctx.addIssue({ code: 'custom', message: reason });
});

// 資格つき・クエリ・フラグメントを受けない: トークンを日誌や DB に残さないため。
export const httpsUrlSchema = z.string().superRefine((value, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (value.length > PLUGIN_LIMITS.maxUrlLength) return reject('URL が長すぎる');
  // eslint-disable-next-line no-control-regex -- 空白・制御文字を弾くための検査
  if (/[\u0000- \u007f]/.test(value)) return reject('URL に空白・制御文字を含む');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return reject('URL として読めない');
  }
  if (url.protocol !== 'https:') return reject('https の URL だけ受ける');
  if (url.username !== '' || url.password !== '') return reject('URL に資格を含められない');
  if (url.hostname === '') return reject('URL にホスト名が無い');
  // 空のクエリ・フラグメント（`?` `#` だけ）も `URL` は正規化で消すので、元の文字列で見る。
  if (value.includes('?') || value.includes('#')) {
    return reject('URL にクエリ・フラグメントを含められない');
  }
});

export const pluginRepoUrlSchema = httpsUrlSchema;
export const pluginRelativePathSchema = relativePathSchema;

export const pluginSourceRefSchema = z
  .string()
  .min(1)
  .max(256)
  // eslint-disable-next-line no-control-regex -- 制御文字・空白を弾くための検査
  .refine((v) => !/[\u0000- \u007f]/.test(v) && !v.startsWith('-'), {
    message: '使えない文字を含む',
  });

// 未知の欄は拒む: 綴り違いが「効かない指定」にならないようにするため。
export const pluginPreviewRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('url'),
    url: pluginRepoUrlSchema,
    path: pluginRelativePathSchema.optional(),
    ref: pluginSourceRefSchema.optional(),
    sha: pluginSourceShaSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('marketplace'), plugin: pluginNameSchema }),
]);
