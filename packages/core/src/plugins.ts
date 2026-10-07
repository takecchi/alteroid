import { createHash } from 'node:crypto';

import { z } from 'zod';

import { compareCodeUnits } from './code-unit-order.js';
import { ENV_PROFILE_SCOPES } from './store.js';

/**
 * 人間が入れた plugin（skill を含む。`.claude-plugin/plugin.json` と `skills/<name>/SKILL.md`
 * だけの plugin に包んで扱う）を、記憶ストアに1つ置くための形。
 *
 * ## なぜ記憶ストアか
 *
 * Railway には volume が1つも無く、`~/.claude` や `/home/worker` に置いたものは器と一緒に消える。
 * 本体（`files`）を**取り込んだ時点の中身のまま**持つので、起動のたびに外から取り直さず、
 * 取り元が消えても書き換えられても、動くものは変わらない（`McpServerStore` と同じ形。`mcp-servers.ts`）。
 *
 * ## 取り元（`source`）は commit SHA で固定する
 *
 * - `kind: 'url'` — https の Git リポジトリ（GitHub も任意の URL の1つとして、これで表す）。
 * - `kind: 'marketplace'` — 公式 marketplace（`claude-plugins-official`）の索引から解決した plugin。
 *   **解決した実体のリポジトリ URL（`url`）も持つ**（索引は動くので、実体の座標を固定する）。
 *
 * どちらも `sha`（小文字40桁16進）が固定の根拠で、自動更新はしない。`version` は取れたときだけ
 * 添える任意の表示用の文字列で、固定の根拠ではない。任意 URL を入れる前の確認（中身を見せて
 * もう一度押す）は API / UI の段の仕事で、ここは保存の形だけを持つ。
 *
 * ## 撒く先（`scope`）
 *
 * **実行環境プロファイルと同じ3値**（`all` / `app` / `runner`。`store.ts` の `ENV_PROFILE_SCOPES`）。
 * 既定は `all`。値の一覧を重複して書かない。
 *
 * ## hooks と `.mcp.json` は既定で無効
 *
 * plugin が持ち込む hooks とコード（`.mcp.json` の stdio など）は MCP の stdio 登録と同じかそれ以上に重い。
 * 既定は無効で、plugin ごとに `enableHooks` / `enableMcp` で有効にする（後の段が読む）。
 *
 * ## `files` の path は厳しく弾く
 *
 * 展開（後の段）が path をファイルシステムの path として使うので、入口と読み出しの両方で
 * 相対のみ・`..` / `.` セグメント禁止・絶対パス禁止・空セグメント禁止・NUL と制御文字禁止・`\` 禁止・
 * 重複禁止・（ファイルとディレクトリの衝突）禁止を検査する。シンボリックリンクは表現しない
 * （`files` はファイルだけ）。
 *
 * **未知の欄は黙って捨てずに拒む**（`z.strictObject`。綴り違いが「保存できたのに効かない」になる）。
 * 拒む文言には値（path・URL など）を載せず、どの欄かだけを書く。
 */

/** plugin の名前（`plugin.json` の `name` と同じものを入れる想定）。`claude mcp add` と同じ文字。 */
const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const pluginNameSchema = z
  .string()
  .regex(PLUGIN_NAME_PATTERN, '英数字・-・_ の1〜64文字で書くこと');

/** commit SHA。小文字40桁16進だけ（ブランチ名・タグ・短縮形・大文字は受けない＝固定にならない）。 */
export const pluginSourceShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, '小文字40桁の16進（commit SHA）で書くこと');

/** 公式 marketplace の名前（取り元として許す marketplace はこれだけ）。 */
export const OFFICIAL_MARKETPLACE = 'claude-plugins-official';

/** 保存の大きさの上限。取り込み時に弾く（DB・ファイルを無制限に太らせない）。 */
export const PLUGIN_LIMITS = {
  /** 1 plugin のファイル数。 */
  maxFiles: 4096,
  /** 1ファイルのバイト数。 */
  maxFileBytes: 16 * 1024 * 1024,
  /** 1 plugin の本体の合計バイト数。 */
  maxTotalBytes: 64 * 1024 * 1024,
  /** path の長さ（UTF-16 の文字数）。 */
  maxPathLength: 512,
  /** path の1セグメントの長さ（UTF-8 のバイト数。多くのファイルシステムの上限）。 */
  maxSegmentBytes: 255,
  /** URL の長さ。 */
  maxUrlLength: 2048,
} as const;

// eslint-disable-next-line no-control-regex -- 制御文字を弾くための検査
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * plugin の中の相対 path の検査。**弾く理由を返す（通れば null）**。理由に path の中身は載せない。
 */
export function validatePluginFilePath(path: unknown): string | null {
  if (typeof path !== 'string') return 'path が文字列でない';
  if (path === '') return 'path が空';
  if (path.length > PLUGIN_LIMITS.maxPathLength) return 'path が長すぎる';
  if (path.includes('\u0000')) return 'path に NUL を含む';
  if (CONTROL_CHARS.test(path)) return 'path に制御文字を含む';
  if (path.includes('\\')) return 'path に \\ を含む';
  if (path.startsWith('/')) return 'path が絶対パス';
  if (/^[A-Za-z]:/.test(path)) return 'path がドライブ文字で始まる';
  for (const segment of path.split('/')) {
    if (segment === '') return 'path に空のセグメントがある';
    if (segment === '.' || segment === '..') return 'path に . / .. のセグメントがある';
    if (Buffer.byteLength(segment, 'utf8') > PLUGIN_LIMITS.maxSegmentBytes) {
      return 'path のセグメントが長すぎる';
    }
  }
  return null;
}

const relativePathSchema = z.string().superRefine((path, ctx) => {
  const reason = validatePluginFilePath(path);
  if (reason !== null) ctx.addIssue({ code: 'custom', message: reason });
});

/**
 * https の URL だけ。資格つき（`user:pass@`）・クエリ・フラグメント・空白や制御文字を含むものは受けない
 * （トークンがクエリに載っても、日誌や DB に残さないため）。
 */
const httpsUrlSchema = z.string().superRefine((value, ctx) => {
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

const versionSchema = z
  .string()
  .min(1)
  .max(128)
  // eslint-disable-next-line no-control-regex -- 制御文字を弾くための検査
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), { message: '制御文字を含む' });

export const pluginSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('url'),
    url: httpsUrlSchema,
    /** リポジトリの中の plugin のディレクトリ（省略はリポジトリの根）。 */
    path: relativePathSchema.optional(),
    sha: pluginSourceShaSchema,
    version: versionSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('marketplace'),
    marketplace: z.literal(OFFICIAL_MARKETPLACE),
    /** marketplace の中での plugin 名。 */
    plugin: pluginNameSchema,
    /** marketplace から解決した実体のリポジトリ URL。 */
    url: httpsUrlSchema,
    path: relativePathSchema.optional(),
    sha: pluginSourceShaSchema,
    version: versionSchema.optional(),
  }),
]);

export type PluginSource = z.infer<typeof pluginSourceSchema>;

/** 撒く先。実行環境プロファイルと同じ3値（`ENV_PROFILE_SCOPES`）。既定は `all`。 */
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
  // どの器でも同じ綴り（UTC・ミリ秒）で往復させる（pg の timestamptz に合わせる）。
  .transform((v) => new Date(v).toISOString());

const installedBySchema = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => !v.includes('\u0000'), { message: 'NUL を含む' });

/** files の組としての検査（個数・合計・重複・ファイルとディレクトリの衝突）。 */
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
  source: pluginSourceSchema,
  /** 撒く先。既定は `all`。 */
  scope: pluginScopeSchema.default('all'),
  /** plugin の hooks を有効にするか。既定は無効。 */
  enableHooks: z.boolean().default(false),
  /** plugin の `.mcp.json` を有効にするか。既定は無効。 */
  enableMcp: z.boolean().default(false),
  files: filesSchema,
  installedAt: installedAtSchema,
  /** 入れたアカウントの識別子。 */
  installedBy: installedBySchema,
};

/** 置くときの入力。`contentSha256` は渡さず、{@link parsePluginInput} が計算する。 */
export const pluginInputSchema = z.strictObject(pluginFields);

/** 保存されている形。読むときは `contentSha256` を files から計算し直して突き合わせる。 */
export const storedPluginSchema = z.strictObject({
  ...pluginFields,
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/, '小文字64桁の16進で書くこと'),
});

export type PluginInput = z.input<typeof pluginInputSchema>;
export type StoredPlugin = z.output<typeof storedPluginSchema>;

/**
 * `list()` が返す要約。**files を含まない**。
 * 器が files を引かずに要約の行だけを読む場合（pg）も、このスキーマで検査する。
 */
export const pluginSummarySchema = storedPluginSchema.omit({ files: true }).extend({
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
});

export type PluginSummary = z.output<typeof pluginSummarySchema>;

/** 要約の行（files を引かずに読んだもの）の検査。投げる文言に値を載せない。 */
export function parsePluginSummary(input: unknown): PluginSummary {
  const result = pluginSummarySchema.safeParse(input);
  if (!result.success) throw new Error(describeIssue('保存された plugin の形が不正', result.error));
  return result.data;
}

/**
 * files の内容の指紋（sha256 の16進）。**files の並びに依らない**（path のコード単位順に並べて計算する）。
 *
 * 各ファイルを `JSON([path, executable, バイト数])` + 改行 + 中身 の順に積む。**バイト数を前に置く**ので、
 * path と中身の境目が曖昧にならない（`"a"+"bc"` と `"ab"+"c"` は別の指紋）。path・中身・実行ビットの
 * どれが変わっても変わる。
 */
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

/** files を path のコード単位順にして返す（3実装が同じ並びを返すため）。 */
function sortedFiles(files: PluginFile[]): PluginFile[] {
  return [...files].sort((a, b) => compareCodeUnits(a.path, b.path));
}

/**
 * 器（fs / pg / インメモリ）が書き込みの前に通す検査。**3実装が同じ関数を呼ぶ**
 * （器ごとに検査を書くと、1つだけ緩い器が生まれる。`parseMcpServers` と同じ理由）。
 *
 * 既定値を入れ、files を path 順に並べ、`contentSha256` を計算して返す。
 * 投げる例外の文言には値を載せない（どの欄か・何番目かだけ）。
 */
export function parsePluginInput(input: unknown): StoredPlugin {
  const result = pluginInputSchema.safeParse(input);
  if (!result.success) throw new Error(describeIssue('plugin の形が不正', result.error));
  const files = sortedFiles(result.data.files);
  return { ...result.data, files, contentSha256: computePluginContentSha256(files) };
}

/**
 * 器から読んだものの検査（SQL や手で書き換えられうる）。形に加えて、`contentSha256` が
 * files と合うことを確かめる。合わなければ投げる（文言に値を載せない）。
 */
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

/** 要約を名前のコード単位順に並べる（3実装が `list()` で揃える）。 */
export function sortPluginSummaries(list: PluginSummary[]): PluginSummary[] {
  return [...list].sort((a, b) => compareCodeUnits(a.name, b.name));
}

/** 名前が形に合うか（`get` / `remove` が、形に合わない名前を「無い」として扱うための門）。 */
export function isValidPluginName(name: string): boolean {
  return PLUGIN_NAME_PATTERN.test(name);
}

/**
 * 大文字小文字だけが違う別の名前か。**大文字小文字を区別しないファイルシステム（macOS）で
 * 展開先が衝突する**ので、入口で別の行として置かせない（実行環境プロファイルと同じ線）。
 */
export function pluginNamesCollide(a: string, b: string): boolean {
  return a !== b && a.toLowerCase() === b.toLowerCase();
}

export class PluginNameConflictError extends Error {
  constructor(name: string, existing: string) {
    super(`plugin の名前が既存の「${existing}」と大文字小文字だけが違う: ${name}`);
    this.name = 'PluginNameConflictError';
  }
}

/**
 * 展開先のディレクトリ名（`<name>@<sha>`）。**sha を含める**ので、版が変われば別のディレクトリになり、
 * 走行中のセッションが読んでいる版を上書きしない。展開そのものは後の段。
 */
export function pluginDirName(name: string, sha: string): string {
  return `${pluginNameSchema.parse(name)}@${pluginSourceShaSchema.parse(sha)}`;
}

/** runner（マネージャーと作業者の器）へ撒く scope。`app` はクローン（daemon）側が持つので含めない。 */
export const PLUGIN_SCOPES_FOR_RUNNER = ['all', 'runner'] as const;

export function isPluginScopeForRunner(
  scope: StoredPlugin['scope'],
): scope is (typeof PLUGIN_SCOPES_FOR_RUNNER)[number] {
  return (PLUGIN_SCOPES_FOR_RUNNER as readonly string[]).includes(scope);
}

/**
 * daemon が runner へ送る plugin 1本。**取り元の URL・入れた人・日時は運ばない**（runner は
 * 展開に要るものだけを受ける）。固定の根拠である source の sha と `contentSha256` は運ぶ。
 */
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

/**
 * runner が受け取った plugin の検査。**path と `contentSha256` の突き合わせまで行う**
 * （`parseStoredPlugin` と同じ検査。届いたものを信じない）。scope が `app` のものは拒む。
 * 投げる文言に値は載せない。
 */
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

/** plugin の指紋の1行。files の中身は載せない。 */
export interface PluginFingerprintEntry {
  name: string;
  /** 取り元の commit SHA。 */
  sha: string;
  contentSha256: string;
  /** フラグだけの変更も「差」として runner へ届けるために、指紋に含める。 */
  enableHooks: boolean;
  enableMcp: boolean;
}

/** 指紋の一覧の同一性（名前のコード単位順に並べて sha256 を取る）。並びに依らない。 */
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
