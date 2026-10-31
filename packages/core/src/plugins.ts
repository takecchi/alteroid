import { createHash } from 'node:crypto';

import { z } from 'zod';

import { compareCodeUnits } from './code-unit-order.js';
import {
  PLUGIN_LIMITS,
  PLUGIN_NAME_PATTERN,
  PLUGIN_NAME_RULE,
  PLUGIN_SHA_PATTERN,
  PLUGIN_SHA_RULE,
  PLUGIN_SOURCE_REF_MAX_LENGTH,
  validatePluginFilePath,
  validatePluginRepoUrl,
  validatePluginSourceRefChars,
} from './plugin-source-input.js';
import { ENV_PROFILE_SCOPES } from './store.js';

/**
 * 記憶ストアに置く: Railway には volume が無く、`~/.claude` 等に置くと器と一緒に消えるから。
 * 取り元は commit SHA で固定する: 索引は動くので、marketplace も解決した実体の `url` を持つ。
 * hooks と `.mcp.json` は既定で無効: stdio 登録と同じかそれ以上に重いから。
 * `files` の path は入口と読み出しの両方で検査する: 展開がファイルシステムの path として使うから。
 * 未知の欄は黙って捨てずに拒む: 綴り違いが「保存できたのに効かない」になるから。
 * 拒む文言には値（path・URL など）を載せず、どの欄かだけを書く。
 */

// 取り元の指定の形（名前・SHA・URL・path・ref・上限）の規則は plugin-source-input.ts（zod なし。web の束にも入れられる）。
// ここの zod のスキーマは、その定数・関数から組む。既存の import 先を変えないため、規則そのものもここから再び出す
export { PLUGIN_LIMITS, validatePluginFilePath };

export const pluginNameSchema = z.string().regex(PLUGIN_NAME_PATTERN, PLUGIN_NAME_RULE);

export const pluginSourceShaSchema = z.string().regex(PLUGIN_SHA_PATTERN, PLUGIN_SHA_RULE);

const relativePathSchema = z.string().superRefine((path, ctx) => {
  const reason = validatePluginFilePath(path);
  if (reason !== null) ctx.addIssue({ code: 'custom', message: reason });
});

const httpsUrlSchema = z.string().superRefine((value, ctx) => {
  const reason = validatePluginRepoUrl(value);
  if (reason !== null) ctx.addIssue({ code: 'custom', message: reason });
});

export const pluginRepoUrlSchema = httpsUrlSchema;
export const pluginRelativePathSchema = relativePathSchema;

export const pluginSourceRefSchema = z
  .string()
  .min(1)
  .max(PLUGIN_SOURCE_REF_MAX_LENGTH)
  .superRefine((value, ctx) => {
    const reason = validatePluginSourceRefChars(value);
    if (reason !== null) ctx.addIssue({ code: 'custom', message: reason });
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

export const OFFICIAL_MARKETPLACE = 'claude-plugins-official';

// 既定の URL を持つ: 未設定で marketplace 名での取得が使えなくなるのを避けるため。
export const OFFICIAL_MARKETPLACE_URL = 'https://github.com/anthropics/claude-plugins-official';

export function resolveMarketplaceUrl(envValue: string | undefined): string {
  const trimmed = envValue?.trim();
  return trimmed === undefined || trimmed === '' ? OFFICIAL_MARKETPLACE_URL : trimmed;
}

const versionSchema = z
  .string()
  .min(1)
  .max(128)
  // eslint-disable-next-line no-control-regex -- 制御文字を弾くための検査
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), { message: '制御文字を含む' });

export const PLUGIN_DESCRIPTION_MAX_LENGTH = 1024;

const pluginDescriptionSchema = z
  .string()
  .min(1)
  .max(PLUGIN_DESCRIPTION_MAX_LENGTH)
  // eslint-disable-next-line no-control-regex -- 制御文字を弾くための検査
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), { message: '制御文字を含む' });

/**
 * 弾かずに整える: 説明は飾りなので、整えられない文字列のせいで plugin を入れられなくしない。
 * HTML のエスケープはここでしない: 二重にエスケープすると化けるから。
 */
export function normalizePluginDescription(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex -- 制御文字を落とすための置換
  let text = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (text.length > PLUGIN_DESCRIPTION_MAX_LENGTH) {
    text = text.slice(0, PLUGIN_DESCRIPTION_MAX_LENGTH);
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
    text = text.trimEnd();
  }
  return text === '' ? undefined : text;
}

export const pluginSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('url'),
    url: httpsUrlSchema,
    path: relativePathSchema.optional(),
    sha: pluginSourceShaSchema,
    version: versionSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('marketplace'),
    marketplace: z.literal(OFFICIAL_MARKETPLACE),
    plugin: pluginNameSchema,
    url: httpsUrlSchema,
    path: relativePathSchema.optional(),
    sha: pluginSourceShaSchema,
    version: versionSchema.optional(),
  }),
]);

export type PluginSource = z.infer<typeof pluginSourceSchema>;

export const pluginScopeSchema = z.enum(ENV_PROFILE_SCOPES);

export const pluginFileSchema = z.strictObject({
  path: relativePathSchema,
  executable: z.boolean(),
  content: z
    .instanceof(Uint8Array)
    .refine((c) => c.byteLength <= PLUGIN_LIMITS.maxFileBytes, { message: 'ファイルが大きすぎる' }),
});

export type PluginFile = z.infer<typeof pluginFileSchema>;

const installedAtSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
    'ISO 8601 の日時で書くこと',
  )
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: '日時として読めない' })
  // どの器でも同じ綴り（UTC・ミリ秒）で往復させる。
  .transform((v) => new Date(v).toISOString());

const installedBySchema = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => !v.includes('\u0000'), { message: 'NUL を含む' });

const filesSchema = z.array(pluginFileSchema).superRefine((files, ctx) => {
  if (files.length > PLUGIN_LIMITS.maxFiles) {
    ctx.addIssue({ code: 'custom', message: 'ファイルの数が多すぎる' });
    return;
  }
  let total = 0;
  const seen = new Set<string>();
  const directories = new Set<string>();
  files.forEach((file, index) => {
    total += file.content.byteLength;
    if (seen.has(file.path)) {
      ctx.addIssue({ code: 'custom', path: [index, 'path'], message: 'path が重複している' });
    }
    seen.add(file.path);
    const segments = file.path.split('/');
    for (let i = 1; i < segments.length; i += 1) directories.add(segments.slice(0, i).join('/'));
  });
  if (total > PLUGIN_LIMITS.maxTotalBytes) {
    ctx.addIssue({ code: 'custom', message: '本体の合計が大きすぎる' });
  }
  files.forEach((file, index) => {
    if (directories.has(file.path)) {
      ctx.addIssue({
        code: 'custom',
        path: [index, 'path'],
        message: 'ファイルの path が別のファイルのディレクトリと同じ',
      });
    }
  });
});

const pluginFields = {
  name: pluginNameSchema,
  description: pluginDescriptionSchema.optional(),
  source: pluginSourceSchema,
  scope: pluginScopeSchema.default('all'),
  enableHooks: z.boolean().default(false),
  enableMcp: z.boolean().default(false),
  files: filesSchema,
  installedAt: installedAtSchema,
  installedBy: installedBySchema,
};

export const pluginInputSchema = z.strictObject(pluginFields);

export const storedPluginSchema = z.strictObject({
  ...pluginFields,
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/, '小文字64桁の16進で書くこと'),
});

export type PluginInput = z.input<typeof pluginInputSchema>;
export type StoredPlugin = z.output<typeof storedPluginSchema>;

// files を含まない。要約の行だけを読む器（pg）も、このスキーマで検査する。
export const pluginSummarySchema = storedPluginSchema.omit({ files: true }).extend({
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
});

export type PluginSummary = z.output<typeof pluginSummarySchema>;

// 投げる文言に値を載せない。
export function parsePluginSummary(input: unknown): PluginSummary {
  const result = pluginSummarySchema.safeParse(input);
  if (!result.success) throw new Error(describeIssue('保存された plugin の形が不正', result.error));
  return result.data;
}

// バイト数を前に置く: path と中身の境目が曖昧にならない（`"a"+"bc"` と `"ab"+"c"` は別の指紋）。
export function computePluginContentSha256(
  files: readonly { path: string; executable: boolean; content: Uint8Array }[],
): string {
  const hash = createHash('sha256');
  hash.update('alteroid-plugin-files-v1\n');
  const sorted = [...files].sort((a, b) => compareCodeUnits(a.path, b.path));
  for (const file of sorted) {
    hash.update(`${JSON.stringify([file.path, file.executable, file.content.byteLength])}\n`);
    hash.update(file.content);
  }
  return hash.digest('hex');
}

function describeIssue(label: string, error: z.ZodError): string {
  const first = error.issues[0];
  const where = first === undefined ? '' : first.path.map(String).join('.');
  return `${label}: ${where === '' ? '' : `${where}: `}${first?.message ?? '理由不明'}`;
}

function sortedFiles(files: PluginFile[]): PluginFile[] {
  return [...files].sort((a, b) => compareCodeUnits(a.path, b.path));
}

/**
 * 3実装（fs / pg / インメモリ）が同じ関数を呼ぶ: 器ごとに検査を書くと、1つだけ緩い器が生まれるから。
 * 投げる例外の文言には値を載せない（どの欄か・何番目かだけ）。
 */
export function parsePluginInput(input: unknown): StoredPlugin {
  const result = pluginInputSchema.safeParse(input);
  if (!result.success) throw new Error(describeIssue('plugin の形が不正', result.error));
  const files = sortedFiles(result.data.files);
  const { description, ...rest } = result.data;
  return {
    ...rest,
    // undefined の欄を作らない（「無ければ欄ごと無い」を3実装で揃える）。
    ...(description === undefined ? {} : { description }),
    files,
    contentSha256: computePluginContentSha256(files),
  };
}

// SQL や手で書き換えられうるので、`contentSha256` が files と合うことも確かめる。文言に値を載せない。
export function parseStoredPlugin(input: unknown): StoredPlugin {
  const result = storedPluginSchema.safeParse(input);
  if (!result.success) throw new Error(describeIssue('保存された plugin の形が不正', result.error));
  const files = sortedFiles(result.data.files);
  if (computePluginContentSha256(files) !== result.data.contentSha256) {
    throw new Error('保存された plugin の contentSha256 が files と合わない');
  }
  return { ...result.data, files };
}

export function pluginSummaryOf(plugin: StoredPlugin): PluginSummary {
  const { files, ...rest } = plugin;
  return {
    ...rest,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.content.byteLength, 0),
  };
}

export function sortPluginSummaries(list: PluginSummary[]): PluginSummary[] {
  return [...list].sort((a, b) => compareCodeUnits(a.name, b.name));
}

export function isValidPluginName(name: string): boolean {
  return pluginNameSchema.safeParse(name).success;
}

// 別の行として置かせない: 大文字小文字を区別しないファイルシステム（macOS）で展開先が衝突するから。
export function pluginNamesCollide(a: string, b: string): boolean {
  return a !== b && a.toLowerCase() === b.toLowerCase();
}

export class PluginNameConflictError extends Error {
  constructor(name: string, existing: string) {
    super(`plugin の名前が既存の「${existing}」と大文字小文字だけが違う: ${name}`);
    this.name = 'PluginNameConflictError';
  }
}

// sha を含める: 版が変われば別のディレクトリになり、走行中のセッションが読んでいる版を上書きしないから。
export function pluginDirName(name: string, sha: string): string {
  return `${pluginNameSchema.parse(name)}@${pluginSourceShaSchema.parse(sha)}`;
}

// `app` を含めない: クローン（daemon）側が持つから。
export const PLUGIN_SCOPES_FOR_RUNNER = ['all', 'runner'] as const;

export function isPluginScopeForRunner(
  scope: StoredPlugin['scope'],
): scope is (typeof PLUGIN_SCOPES_FOR_RUNNER)[number] {
  return (PLUGIN_SCOPES_FOR_RUNNER as readonly string[]).includes(scope);
}

// 取り元の URL・入れた人・日時は運ばない: runner は展開に要るものだけを受ける。
const runnerPluginSchema = z.strictObject({
  name: pluginNameSchema,
  sourceSha: pluginSourceShaSchema,
  scope: pluginScopeSchema.extract([...PLUGIN_SCOPES_FOR_RUNNER]),
  enableHooks: z.boolean(),
  enableMcp: z.boolean(),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/, '小文字64桁の16進で書くこと'),
  files: filesSchema,
});

export type RunnerPlugin = z.output<typeof runnerPluginSchema>;

// path と `contentSha256` の突き合わせまで行う: 届いたものを信じない。投げる文言に値は載せない。
export function parseRunnerPlugin(input: unknown): RunnerPlugin {
  const result = runnerPluginSchema.safeParse(input);
  if (!result.success) {
    throw new Error(describeIssue('runner へ送られた plugin の形が不正', result.error));
  }
  const files = sortedFiles(result.data.files);
  if (computePluginContentSha256(files) !== result.data.contentSha256) {
    throw new Error('runner へ送られた plugin の contentSha256 が files と合わない');
  }
  return { ...result.data, files };
}

export interface PluginFingerprintEntry {
  name: string;
  sha: string;
  contentSha256: string;
  // フラグだけの変更も「差」として runner へ届けるために、指紋に含める。
  enableHooks: boolean;
  enableMcp: boolean;
}

export function pluginsFingerprintOf(entries: readonly PluginFingerprintEntry[]): string {
  const hash = createHash('sha256');
  hash.update('alteroid-plugins-v2\n');
  const sorted = [...entries].sort((a, b) => compareCodeUnits(a.name, b.name));
  for (const entry of sorted) {
    hash.update(
      `${JSON.stringify([entry.name, entry.sha, entry.contentSha256, entry.enableHooks, entry.enableMcp])}\n`,
    );
  }
  return hash.digest('hex');
}
