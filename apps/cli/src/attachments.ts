import { readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve, sep } from 'node:path';
import { stderr, stdout } from './terminal-out.js';

import {
  ATTACHMENT_EMPTY_MESSAGE,
  AttachmentRejectedError,
  DEFAULT_ATTACHMENT_LIMITS,
  isAttachmentImageMediaType,
  attachmentDiskName,
  normalizeAttachmentName,
  validateAttachmentBatch,
  validateAttachmentInput,
  type AttachmentLimits,
} from '@alteroid/core';
import { formatBytes } from '@alteroid/logic';

import { createClient } from './client.js';
import { withErrorReason } from './format.js';
import { describeAuthFailure, resolveTarget, type Target } from './target.js';

/**
 * 添付（Issue #3111 段2）の CLI 側。`alteroid chat` / TUI の `/attach`、`alteroid attachments`
 * の共通部品をここに置く（口ごとに MIME の表や上限の検査を書き写さない）。
 *
 * - 上げる口は `POST /attachments`（`application/octet-stream`。名前と MIME はクエリ）。
 * - 上限の検査は core の `validateAttachment*`（デーモンと同じ関数）を、**デーモンの上限**
 *   （`GET /attachments/limits`。初回に1回だけ取る）で先に通す。取れなければ既定の上限で検査し、
 *   最終判断はデーモンの 4xx に任せる（#3204）。
 */

/** 拡張子（小文字・ドット無し）→ MIME。依存を足さない手書きの表。分からなければ octet-stream。 */
const MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  html: 'text/html',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

export const DEFAULT_MEDIA_TYPE = 'application/octet-stream';

export function mediaTypeOfName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return DEFAULT_MEDIA_TYPE;
  return MEDIA_TYPE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? DEFAULT_MEDIA_TYPE;
}

/** `[添付] name (type, size) id=…`。中身は出さない。 */
export function describeAttachment(a: {
  id: string;
  name: string;
  mediaType: string;
  size: number;
}): string {
  return `[添付] ${a.name} (${a.mediaType}, ${formatBytes(a.size)}) id=${a.id}`;
}

/** 発言に添付があれば、行ごとの文字列（無ければ空配列）。 */
export function attachmentLinesOf(
  attachments: readonly { id: string; name: string; mediaType: string; size: number }[] | undefined,
): string[] {
  return (attachments ?? []).map(describeAttachment);
}

/**
 * `/attach` に打たれたパスの解釈（REPL・TUI 共通。`alteroid attachments put ~/x` でシェルが
 * してくれることに揃える。#3219）。**`add` の前に呼ぶ**（`add` は解釈済みのパスを受ける。
 * `attachments put` の引数はシェルが解釈済みなので二重に解釈しない）。
 * - 前後が同じ引用符なら外し、中身はそのまま（シェルも引用符の中では `~` を展開しない）。
 * - 引用符が無ければ、先頭の `~` / `~/` を home に展開し、`\ ` は空白にする（端末へドラッグすると
 *   空白が `\ ` になる）。それ以外のバックスラッシュは触らない（ファイル名の一部かもしれず、
 *   黙って消すと別のパスになる）。`~user` は展開しない（引ける home が無い）。
 */
export function interpretAttachPath(raw: string): string {
  const trimmed = raw.trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(trimmed);
  if (quoted !== null) return quoted[2] ?? trimmed;
  const expanded =
    trimmed === '~' || trimmed.startsWith('~/') ? `${homedir()}${trimmed.slice(1)}` : trimmed;
  return expanded.replaceAll('\\ ', ' ');
}

/** 次に送る発言へ添えかけのファイル。 */
export interface DraftFile {
  readonly path: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  /** 上げ済みなら id（送信に失敗して再送するとき、上げ直さない）。 */
  uploadedId?: string;
  /**
   * `/edit` で、元の発言から引き継いだ添付（手元のファイルが無い。`path` は空）。上げ直せないので、
   * 期限切れでも「上げ済みの印」は捨てない（外すか、編集をやめるかを使い手に任せる。#3642）。
   */
  readonly carried?: true;
}

export type DraftResult = { ok: true; file: DraftFile } | { ok: false; reason: string };

/** 添えかけの一覧。`chat`（readline）と TUI で共有する。 */
export class AttachmentDraft {
  private readonly files: DraftFile[] = [];

  private known: AttachmentLimits | undefined;

  /**
   * 上限そのもの、またはそれを取る関数。取る関数が `null`（接続失敗・壊れた応答などの一時的な失敗）を
   * 返したら、覚えずに既定値で検査し、次に要るときにまた取る。値（古いデーモンの 404 の既定値を含む）は覚える。
   */
  constructor(
    private readonly source:
      AttachmentLimits | (() => Promise<AttachmentLimits | null>) = DEFAULT_ATTACHMENT_LIMITS,
  ) {}

  /** 検査に使う上限。 */
  async limits(): Promise<AttachmentLimits> {
    if (this.known !== undefined) return this.known;
    const got = typeof this.source === 'function' ? await this.source() : this.source;
    if (got === null) return DEFAULT_ATTACHMENT_LIMITS;
    this.known = got;
    return got;
  }

  list(): readonly DraftFile[] {
    return this.files;
  }

  get count(): number {
    return this.files.length;
  }

  /** パスを添えかけへ足す。上限（1つの大きさ・個数・合計）は先に見る。 */
  async add(path: string): Promise<DraftResult> {
    const absolute = resolve(path);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(absolute);
    } catch (error) {
      return { ok: false, reason: `読めない: ${absolute}（${errnoOf(error)}）` };
    }
    if (!info.isFile()) return { ok: false, reason: `ファイルではない: ${absolute}` };
    if (info.size === 0) return { ok: false, reason: ATTACHMENT_EMPTY_MESSAGE };
    const name = normalizeAttachmentName(basename(absolute));
    const mediaType = mediaTypeOfName(name);
    const limits = await this.limits();
    const max = isAttachmentImageMediaType(mediaType) ? limits.maxImageBytes : limits.maxFileBytes;
    if (info.size > max) {
      return {
        ok: false,
        reason: `大きすぎる: ${name} は ${info.size} バイト（1 つ ${max} バイトまで）`,
      };
    }
    try {
      validateAttachmentBatch([...this.files.map((f) => f.size), info.size], limits);
    } catch (error) {
      if (error instanceof AttachmentRejectedError) return { ok: false, reason: error.message };
      throw error;
    }
    const file: DraftFile = { path: absolute, name, mediaType, size: info.size };
    this.files.push(file);
    return { ok: true, file };
  }

  /**
   * 元の発言の添付（上げ済み）を、上げ直さずに添えかけへ載せる（`/edit` の開始。#3642）。
   * 上限の検査はしない（もう受け取られた添付で、足した分の検査は `add` が合計で見る）。
   */
  addUploaded(attachment: { id: string; name: string; mediaType: string; size: number }): void {
    this.files.push({
      path: '',
      name: attachment.name,
      mediaType: attachment.mediaType,
      size: attachment.size,
      uploadedId: attachment.id,
      carried: true,
    });
  }

  /** `all` か 1 始まりの番号。外したファイルを返す（無効なら理由）。 */
  remove(spec: string): { ok: true; removed: DraftFile[] } | { ok: false; reason: string } {
    const trimmed = spec.trim();
    if (trimmed === 'all') {
      return { ok: true, removed: this.files.splice(0, this.files.length) };
    }
    const index = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
    if (!Number.isSafeInteger(index) || index < 1 || index > this.files.length) {
      return {
        ok: false,
        reason:
          this.files.length === 0
            ? '添えかけのファイルは無い'
            : `番号は 1〜${this.files.length}（または all）`,
      };
    }
    return { ok: true, removed: this.files.splice(index - 1, 1) };
  }

  clear(): void {
    this.files.splice(0, this.files.length);
  }

  /**
   * 指定した分だけ外す（同じ `DraftFile` で引く）。送った分だけを空にするための口（#3245）: 上げて送る
   * 応答を待つあいだに `/attach` で足された分は残す。
   */
  discard(sent: readonly DraftFile[]): void {
    for (const file of sent) {
      const index = this.files.indexOf(file);
      if (index >= 0) this.files.splice(index, 1);
    }
  }

  /**
   * 送ると決めて `discard` した分を、送らなかったときに先頭へ戻す（元の並びのまま。上げ済みの印も残るので、
   * 次の送信で上げ直さない。#3588）。すでに入っている分は足さない。
   */
  restore(files: readonly DraftFile[]): void {
    this.files.unshift(...files.filter((f) => !this.files.includes(f)));
  }

  /** 一覧の文。 */
  describe(): string[] {
    if (this.files.length === 0) return ['（添えかけのファイルは無い。/attach <path> で足す）'];
    return this.files.map(
      (f, i) =>
        `  [${i + 1}] ${f.name} (${f.mediaType}, ${formatBytes(f.size)})` +
        `${f.uploadedId === undefined ? '' : ` 上げ済み id=${f.uploadedId}`}  ${f.carried === true ? '（元の添付）' : f.path}`,
    );
  }
}

/**
 * デーモンの添付の上限（`GET /attachments/limits`。#3204）。投げない。
 * - 取れた値を返す。
 * - 古いデーモン（404 など、応答はあるが口が無い）は core の既定値を返す（確定。覚えてよい）。
 * - 接続失敗・壊れた応答は `null`（一時的。呼び手は既定値で検査し、次に取り直す）。
 * 最終判断はデーモンなので、先行検査が既定値でも壊れはしない。
 */
export async function fetchAttachmentLimits(target: Target): Promise<AttachmentLimits | null> {
  try {
    const response = await createClient(target.baseUrl, target.headers).attachments.limits.$get();
    if (response.status === 404) return DEFAULT_ATTACHMENT_LIMITS;
    if (!response.ok) return null;
    const body: Partial<Record<keyof AttachmentLimits, unknown>> = await response.json();
    const keys = Object.keys(DEFAULT_ATTACHMENT_LIMITS) as (keyof AttachmentLimits)[];
    if (!keys.every((key) => Number.isSafeInteger(body[key]) && (body[key] as number) > 0)) {
      return null;
    }
    return body as AttachmentLimits;
  } catch {
    return null;
  }
}

/** `chat` が使う添えかけ（上限は `/attach` で取り、値か 404 が返れば以降は覚える。一時的な失敗は次の `/attach` で取り直す）。 */
export function createAttachmentDraft(target: Target): AttachmentDraft {
  return new AttachmentDraft(() => fetchAttachmentLimits(target));
}

function errnoOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : error instanceof Error ? error.message : String(error);
}

export interface UploadedAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
}

/**
 * 1つ上げる（`POST /attachments?name=&type=`、本文は生のバイト列、`content-type: application/octet-stream`）。
 * 失敗は例外（理由は人が読める文）。
 */
export async function uploadAttachment(
  target: Target,
  file: { name: string; mediaType: string; bytes: Uint8Array },
  signal?: AbortSignal,
): Promise<UploadedAttachment> {
  const query = new URLSearchParams({ name: file.name, type: file.mediaType });
  let response: Response;
  try {
    response = await fetch(`${target.baseUrl}/attachments?${query.toString()}`, {
      method: 'POST',
      headers: { ...target.headers, 'content-type': 'application/octet-stream' },
      body: file.bytes as Uint8Array<ArrayBuffer>,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    throw new Error(`デーモンに繋がらない（${errnoOf(error)}）`, { cause: error });
  }
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(`アップロードできない（HTTP ${response.status}）`, response),
    );
  }
  return (await response.json()) as UploadedAttachment;
}

/**
 * 送信が `400 attachment_missing`（添付が無い・期限切れ）で断られた。サーバは、発言に結び付かない添付を
 * 1 時間で掃除する（#3246）。`message` はサーバの理由の文（見つからない id を含む）。
 */
export class AttachmentMissingError extends Error {
  override readonly name = 'AttachmentMissingError';
}

/** 失敗した応答の本文が `attachment_missing` なら、サーバの理由の文。違えば `null`。 */
export function attachmentMissingMessageOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const { code, error } = body as { code?: unknown; error?: unknown };
  if (code !== 'attachment_missing') return null;
  return typeof error === 'string' && error.length > 0 ? error : '添付が見つからない';
}

/**
 * `attachment_missing` で落ちた送信の分（`sent`）から、サーバが掃除した添付の「上げ済み」の印を捨てて、
 * 次の送信で上げ直させる。**どれが無いかはサーバの文（`message`）に載る id で決める**。名指しが読み取れなければ、
 * その送信で上げ済みだった分を全部捨てる（残して 400 を繰り返すより、余計に上げ直すほうが安い）。
 * 使い手へ出す文を返す（添えかけは残してある）。
 */
export function expireUploads(sent: readonly DraftFile[], message: string): string {
  const uploaded = sent.filter((f) => f.uploadedId !== undefined);
  // `/edit` で引き継いだ元の添付は、上げ直せない（手元のファイルが無い）。印は捨てず、外すよう案内する（#3642）。
  const carriedNamed = uploaded.filter(
    (f) => f.carried === true && message.includes(f.uploadedId!),
  );
  if (carriedNamed.length > 0) {
    return (
      `元の添付が期限切れだったので送っていない（${carriedNamed.map((f) => f.name).join(', ')}）。` +
      '/detach で外して送るか、/edit-cancel で編集をやめる'
    );
  }
  const reuploadable = uploaded.filter((f) => f.carried !== true);
  const named = reuploadable.filter((f) => message.includes(f.uploadedId!));
  const expired = named.length > 0 ? named : reuploadable;
  for (const file of expired) delete file.uploadedId;
  const names = expired.map((f) => f.name).join(', ');
  return (
    `添付が期限切れだったので送っていない${names === '' ? '' : `（${names}）`}。` +
    '添えかけは残してある。次の送信で上げ直す'
  );
}

export type UploadDraftResult =
  | {
      ok: true;
      uploaded: UploadedAttachment[];
      /** `uploaded` と同じ並びの添えかけ（送った分。送れたら `draft.discard(files)` で外す）。 */
      files: DraftFile[];
    }
  | { ok: false; reason: string };

/**
 * 添えかけを全部上げて、id を揃える。**失敗したら添えかけは残す**（上げ済みの印は残し、再送で上げ直さない）。
 * 読む時点でも検査する（`/attach` から送るまでに中身が変わりうる。画像は中身の先頭も見る）。
 */
export async function uploadDraft(
  draft: AttachmentDraft,
  upload: (file: {
    name: string;
    mediaType: string;
    bytes: Uint8Array;
  }) => Promise<UploadedAttachment>,
): Promise<UploadDraftResult> {
  // 送ると決めた時点の写しを走査する（生きた配列を走査しない）。上げているあいだの `/attach` / `/detach` が
  // 走査とずれて、外したファイルを送ったり、後から足した分を混ぜたりしないように（#3558）。
  const snapshot = [...draft.list()];
  const uploaded: UploadedAttachment[] = [];
  const sent: DraftFile[] = [];
  const limits = await draft.limits();
  for (const file of snapshot) {
    if (file.uploadedId !== undefined) {
      uploaded.push({
        id: file.uploadedId,
        name: file.name,
        mediaType: file.mediaType,
        size: file.size,
        sha256: '',
      });
      sent.push(file);
      continue;
    }
    try {
      const bytes = new Uint8Array(await readFile(file.path));
      validateAttachmentInput({ name: file.name, mediaType: file.mediaType, bytes }, limits);
      const meta = await upload({ name: file.name, mediaType: file.mediaType, bytes });
      file.uploadedId = meta.id;
      uploaded.push(meta);
      sent.push(file);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `${file.name}: ${reason}` };
    }
  }
  return { ok: true, uploaded, files: sent };
}

// ---------------------------------------------------------------------------
// alteroid attachments put / get / meta
// ---------------------------------------------------------------------------

async function connect() {
  const target = await resolveTarget();
  if (target.note !== null) throw new Error(target.note);
  return { target, client: createClient(target.baseUrl, target.headers) };
}

export async function attachmentsPutCommand(path: string): Promise<void> {
  const { target } = await connect();
  const draft = new AttachmentDraft();
  const added = await draft.add(path);
  if (!added.ok) throw new Error(added.reason);
  const result = await uploadDraft(draft, (file) => uploadAttachment(target, file));
  if (!result.ok) throw new Error(result.reason);
  const meta = result.uploaded[0]!;
  stdout.write(`${meta.id}\n`);
  stderr.write(`${describeAttachment(meta)}（1 時間以内に発言へ添えないと掃除される）\n`);
}

export async function attachmentsMetaCommand(id: string): Promise<void> {
  const { client, target } = await connect();
  const response = await client.attachments[':id'].meta.$get({ param: { id } });
  if (response.status === 404) {
    throw new Error(`そんな添付はありません（消えた・期限切れ・id の誤り）: ${id}`);
  }
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    throw new Error(
      described ??
        (await withErrorReason(`添付の控えを読めません（HTTP ${response.status}）`, response)),
    );
  }
  const meta = await response.json();
  stdout.write(
    [
      `id: ${meta.id}`,
      `name: ${meta.name}`,
      `type: ${meta.mediaType}`,
      `size: ${meta.size}（${formatBytes(meta.size)}）`,
      `sha256: ${meta.sha256}`,
      ...(meta.conversationId === undefined ? [] : [`conversationId: ${meta.conversationId}`]),
      ...(meta.externalEventId === undefined ? [] : [`externalEventId: ${meta.externalEventId}`]),
      ...(meta.uploadedBy === undefined ? [] : [`uploadedBy: ${meta.uploadedBy}`]),
      `createdAt: ${meta.createdAt}`,
      `expiresAt: ${meta.expiresAt}`,
    ].join('\n') + '\n',
  );
}

/**
 * 中身を取る。`-o <file>` で保存先（`-` は標準出力）。省略すると控えの名前でカレントへ。
 * **既存のファイルは上書きしない**（`wx`）。
 */
export async function attachmentsGetCommand(
  id: string,
  options: { output?: string },
): Promise<void> {
  const { client, target } = await connect();
  let output = options.output;
  if (output === undefined) {
    const metaResponse = await client.attachments[':id'].meta.$get({ param: { id } });
    if (metaResponse.status === 404) {
      throw new Error(`そんな添付はありません（消えた・期限切れ・id の誤り）: ${id}`);
    }
    if (!metaResponse.ok) {
      const described = describeAuthFailure(metaResponse.status, target);
      throw new Error(
        described ??
          (await withErrorReason(
            `添付の控えを読めません（HTTP ${metaResponse.status}）`,
            metaResponse,
          )),
      );
    }
    // 名前は保存時に正規化済みだが、ここでも区切りを落として basename にし、UTF-8 で NAME_MAX 以内へ丸める
    // （写し・担い手の置き場と同じ `attachmentDiskName`。#3324 / #3521）。
    // `./` を前に付ける: 名前が `-` でも標準出力（`-o -`）と取り違えない（#3330）。
    // `path.join('.', name)` は `./` を畳んで `-` に戻すので使えない。
    output = `.${sep}${attachmentDiskName((await metaResponse.json()).name)}`;
  }
  // 中身は生のバイト列なので hono/client ではなく生の fetch（認証ヘッダは `target`）。
  const response = await fetch(`${target.baseUrl}/attachments/${encodeURIComponent(id)}`, {
    headers: target.headers,
  });
  if (response.status === 404) {
    throw new Error(`そんな添付はありません（消えた・期限切れ・id の誤り）: ${id}`);
  }
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    throw new Error(
      described ?? (await withErrorReason(`添付を取れません（HTTP ${response.status}）`, response)),
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (output === '-') {
    stdout.writeRaw(bytes);
    return;
  }
  try {
    await writeFile(output, bytes, { flag: 'wx' });
  } catch (error) {
    if ((error as { code?: unknown }).code === 'EEXIST') {
      throw new Error(
        `既にある（上書きしない）: ${output}。別の名前は -o <file>、標準出力へは -o -`,
        { cause: error },
      );
    }
    throw error;
  }
  stderr.write(`${output} に書いた（${bytes.length} バイト）\n`);
}
