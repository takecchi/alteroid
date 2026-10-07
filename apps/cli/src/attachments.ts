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
import { describeCliFailure, isConnectionFailure } from './failure-message.js';
import { withErrorReason } from './format.js';
import { describeAuthFailure, resolveTarget, type Target } from './target.js';

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

export function describeAttachment(a: {
  id: string;
  name: string;
  mediaType: string;
  size: number;
}): string {
  return `[添付] ${a.name} (${a.mediaType}, ${formatBytes(a.size)}) id=${a.id}`;
}

export function attachmentLinesOf(
  attachments: readonly { id: string; name: string; mediaType: string; size: number }[] | undefined,
): string[] {
  return (attachments ?? []).map(describeAttachment);
}

export function interpretAttachPath(raw: string): string {
  const trimmed = raw.trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(trimmed);
  if (quoted !== null) return quoted[2] ?? trimmed;
  const expanded =
    trimmed === '~' || trimmed.startsWith('~/') ? `${homedir()}${trimmed.slice(1)}` : trimmed;
  // `\ ` 以外のバックスラッシュは触らない: ファイル名の一部かもしれず、消すと別のパスになるため
  return expanded.replaceAll('\\ ', ' ');
}

export interface DraftFile {
  readonly path: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  uploadedId?: string;
  readonly carried?: true;
}

export type DraftResult = { ok: true; file: DraftFile } | { ok: false; reason: string };

export class AttachmentDraft {
  private readonly files: DraftFile[] = [];

  private known: AttachmentLimits | undefined;

  constructor(
    private readonly source:
      AttachmentLimits | (() => Promise<AttachmentLimits | null>) = DEFAULT_ATTACHMENT_LIMITS,
  ) {}

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

  // 上限の検査はしない: もう受け取られた添付のため
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

  // 全部は消さない: 送信の応答を待つあいだに `/attach` で足された分を残すため
  discard(sent: readonly DraftFile[]): void {
    for (const file of sent) {
      const index = this.files.indexOf(file);
      if (index >= 0) this.files.splice(index, 1);
    }
  }

  restore(files: readonly DraftFile[]): void {
    this.files.unshift(...files.filter((f) => !this.files.includes(f)));
  }

  describe(): string[] {
    if (this.files.length === 0) return ['（添えかけのファイルは無い。/attach <path> で足す）'];
    return this.files.map(
      (f, i) =>
        `  [${i + 1}] ${f.name} (${f.mediaType}, ${formatBytes(f.size)})` +
        `${f.uploadedId === undefined ? '' : ` 上げ済み id=${f.uploadedId}`}  ${f.carried === true ? '（元の添付）' : f.path}`,
    );
  }
}

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
    // 繋がらないときは、単発のコマンドと同じ直し方の案内にする（#3995）。それ以外の例外は今まで通り errno を言う
    throw new Error(
      isConnectionFailure(error)
        ? describeCliFailure(error)
        : `デーモンに繋がらない（${errnoOf(error)}）`,
      { cause: error },
    );
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

export class AttachmentMissingError extends Error {
  override readonly name = 'AttachmentMissingError';
}

export function attachmentMissingMessageOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const { code, error } = body as { code?: unknown; error?: unknown };
  if (code !== 'attachment_missing') return null;
  return typeof error === 'string' && error.length > 0 ? error : '添付が見つからない';
}

export function expireUploads(sent: readonly DraftFile[], message: string): string {
  const uploaded = sent.filter((f) => f.uploadedId !== undefined);
  // 引き継いだ元の添付の印は捨てない: 手元のファイルが無く上げ直せないため
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
  // 名指しが読み取れなければ全部捨てる: 残して 400 を繰り返すより、余計に上げ直すほうが安いため
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
      files: DraftFile[];
    }
  | { ok: false; reason: string };

export async function uploadDraft(
  draft: AttachmentDraft,
  upload: (file: {
    name: string;
    mediaType: string;
    bytes: Uint8Array;
  }) => Promise<UploadedAttachment>,
): Promise<UploadDraftResult> {
  // 生きた配列を走査しない: 上げているあいだの `/attach` / `/detach` とずれるため
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
    // `path.join('.', name)` を使わない: `./` を畳んで `-` に戻り、標準出力（`-o -`）と取り違えるため
    output = `.${sep}${attachmentDiskName((await metaResponse.json()).name)}`;
  }
  // hono/client を使わない: 中身が生のバイト列のため
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
