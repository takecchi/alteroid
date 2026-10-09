import { realpath, open, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';

import {
  ATTACHMENT_UPLOADED_BY_CLONE,
  AttachmentRejectedError,
  formatImageLimit,
  isAttachmentImageMediaType,
  type AttachmentLimits,
  type AttachmentStore,
} from './attachment.js';
import { reasonOf } from './dropped-record.js';
import type { AttachmentRef } from './schema.js';

/**
 * クローンが手元のファイルを添付の置き場へ入れる（`file_put` の実体。Issue #4126）。
 *
 * 検証は必ず置き場の `put`（`prepareAttachment`。3実装で同じ検査）を通す。ここで先に見るのは、
 * 読む前でなければ意味が無いもの（通常ファイルか・上限・資格の置き場）だけである。
 */

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
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export const FILE_PUT_FALLBACK_MEDIA_TYPE = 'application/octet-stream';

/** 拡張子からの小さな推定。無ければ `application/octet-stream`。中身は見ない（画像は置き場が magic で照合する）。 */
export function guessMediaTypeFromPath(path: string): string {
  return MEDIA_TYPES_BY_EXTENSION[extname(path).toLowerCase()] ?? FILE_PUT_FALLBACK_MEDIA_TYPE;
}

/** 資格が置かれている場所。どちらも `realpath` 済み。 */
export interface CredentialSources {
  /** `ALTEROID_CREDENTIAL_DIR` が指すディレクトリ。 */
  readonly dir?: string;
  /** 名前が `_FILE` で終わる環境変数の名前 → それが指すファイル。 */
  readonly files: ReadonlyMap<string, string>;
}

function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * `realPath`（`realpath` 済み）が資格の置き場なら、断る理由を返す。そうでなければ `undefined`。
 * ディスクを見ない純関数（`CredentialSources` の組み立てが {@link resolveCredentialSources}）。
 */
export function credentialSourceRefusal(
  realPath: string,
  sources: CredentialSources,
): string | undefined {
  if (sources.dir !== undefined && isInside(sources.dir, realPath)) {
    return `資格の置き場（ALTEROID_CREDENTIAL_DIR の配下）にあるファイルは、保存も共有もしない`;
  }
  for (const [name, target] of sources.files) {
    if (target === realPath) {
      return `環境変数 ${name} が指す資格のファイルは、保存も共有もしない`;
    }
  }
  return undefined;
}

async function realpathOrResolve(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * 環境変数から資格の置き場を集める。**無いものは `resolve` へ倒す**（realpath が通らない場所を
 * 「無いから資格ではない」と読むと、指しているだけの変数を素通りさせてしまう）。
 */
export async function resolveCredentialSources(env: NodeJS.ProcessEnv): Promise<CredentialSources> {
  const dirRaw = env.ALTEROID_CREDENTIAL_DIR?.trim();
  const files = new Map<string, string>();
  for (const [name, value] of Object.entries(env)) {
    if (!name.endsWith('_FILE') || value === undefined || value.trim() === '') continue;
    files.set(name, await realpathOrResolve(value.trim()));
  }
  return {
    ...(dirRaw === undefined || dirRaw === '' ? {} : { dir: await realpathOrResolve(dirRaw) }),
    files,
  };
}

export type PutLocalFileResult =
  | { readonly ok: true; readonly ref: AttachmentRef; readonly note?: string }
  | { readonly ok: false; readonly message: string };

export interface PutLocalFileOptions {
  readonly limits: AttachmentLimits;
  readonly env: NodeJS.ProcessEnv;
}

function describeErrno(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return '見つからない';
  if (code === 'EACCES' || code === 'EPERM') return '読む権限が無い';
  return reasonOf(error);
}

export async function putLocalFile(
  stores: { readonly attachments: AttachmentStore },
  input: {
    readonly path: string;
    readonly name?: string | undefined;
    /** true なら保存の印つきで入れる（期限なし・未結び付け1時間の掃除にも掛からない。#4126 P5）。 */
    readonly keep?: boolean | undefined;
  },
  options: PutLocalFileOptions,
): Promise<PutLocalFileResult> {
  const refuse = (message: string): PutLocalFileResult => ({ ok: false, message });
  const path = input.path;
  if (!isAbsolute(path)) {
    return refuse(`path は絶対パスで渡す（${path} は相対パス）。置き場には何も入れていない。`);
  }

  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    return refuse(`${path} を開けない: ${describeErrno(error)}。置き場には何も入れていない。`);
  }

  const credential = credentialSourceRefusal(real, await resolveCredentialSources(options.env));
  if (credential !== undefined) {
    return refuse(
      `${path} は置き場へ入れなかった。${credential}（人間へ送ると鍵が漏れる）。` +
        '必要なのが資格の中身そのものなら、人間にそのファイルの場所を言って、渡し方は人間に決めてもらう。',
    );
  }

  // 読む前に見る: 通常ファイル以外（FIFO・デバイス・ディレクトリ）を開くと、読み終わらない・巨大になる
  let before;
  try {
    before = await stat(real);
  } catch (error) {
    return refuse(`${path} を調べられない: ${describeErrno(error)}。置き場には何も入れていない。`);
  }
  if (!before.isFile()) {
    return refuse(`${path} は通常のファイルではない。置き場には何も入れていない。`);
  }

  let mediaType = guessMediaTypeFromPath(input.name ?? real);
  let note: string | undefined;
  // 画像の上限を超える画像は「受け付けはするが画像としては見えない」: 宣言を落としてその他の上限で入れる（人間はダウンロードできる）
  if (isAttachmentImageMediaType(mediaType) && before.size > options.limits.maxImageBytes) {
    note =
      `画像の上限（${formatImageLimit(options.limits.maxImageBytes)}）を超えるので、画像ではなくファイル` +
      `（${FILE_PUT_FALLBACK_MEDIA_TYPE}）として入れた。人間の画面では画像として見えず、ダウンロードして開く。`;
    mediaType = FILE_PUT_FALLBACK_MEDIA_TYPE;
  }
  const max = options.limits.maxFileBytes;
  if (before.size > max) {
    return refuse(
      `${path} は ${before.size} バイトあり、ファイル1つの上限 ` +
        `${formatImageLimit(max)} を超える。読まずに断った。置き場には何も入れていない。`,
    );
  }

  let handle;
  try {
    handle = await open(real, 'r');
  } catch (error) {
    return refuse(`${path} を読めなかった: ${describeErrno(error)}。置き場には何も入れていない。`);
  }
  const fileHandle = handle;

  // 同じ handle から読む（stat と読みの間にパスが差し替わっても、開いたファイルを読む）。
  // stat した大きさ+1 バイトだけ読む: stat から open までに伸びたぶん（上限を超えうる）を読まないため。
  // 入れ直し（下の寸法の落とし）のたびに先頭から読み直す。
  const bodyOf = async function* (): AsyncGenerator<Uint8Array> {
    let total = 0;
    try {
      for await (const chunk of fileHandle.createReadStream({
        start: 0,
        end: before.size,
        autoClose: false,
      })) {
        total += chunk.length;
        if (total > before.size) throw new FileChangedWhileReading();
        yield chunk;
      }
    } catch (error) {
      if (error instanceof FileChangedWhileReading) throw error;
      throw new FileReadFailed(error);
    }
  };

  try {
    const putInput = {
      name: input.name ?? basename(real),
      uploadedBy: ATTACHMENT_UPLOADED_BY_CLONE,
      ...(input.keep === true ? { kept: true } : {}),
    };
    let meta;
    try {
      meta = await stores.attachments.putStream({ ...putInput, mediaType, body: bodyOf() });
    } catch (error) {
      // 寸法の上限（#4131）も、サイズの上限と同じく「受け付けるが画像としては見えない」: 宣言を落として入れ直す
      if (error instanceof AttachmentRejectedError && error.code === 'image_dimension_too_large') {
        note =
          `画像の寸法の上限を超えるので（${reasonOf(error)}）、画像ではなくファイル` +
          `（${FILE_PUT_FALLBACK_MEDIA_TYPE}）として入れた。人間の画面では画像として見えず、ダウンロードして開く。`;
        mediaType = FILE_PUT_FALLBACK_MEDIA_TYPE;
        meta = await stores.attachments.putStream({ ...putInput, mediaType, body: bodyOf() });
      } else {
        throw error;
      }
    }
    return {
      ok: true,
      ref: {
        id: meta.id,
        name: meta.name,
        mediaType: meta.mediaType,
        size: meta.size,
        sha256: meta.sha256,
      },
      ...(note === undefined ? {} : { note }),
    };
  } catch (error) {
    if (error instanceof FileChangedWhileReading) {
      return refuse(`${path} は読む間に大きさが変わった。置き場には何も入れていない。`);
    }
    if (error instanceof FileReadFailed) {
      return refuse(
        `${path} を読めなかった: ${describeErrno(error.cause)}。置き場には何も入れていない。`,
      );
    }
    if (error instanceof AttachmentRejectedError) {
      return refuse(
        `${path} は置き場が受け付けなかった: ${reasonOf(error)}。置き場には何も入れていない。`,
      );
    }
    return refuse(
      `${path} を置き場へ入れられなかった: ${reasonOf(error)}（もう一度試すと直る場合がある）`,
    );
  } finally {
    await fileHandle.close().catch(() => undefined);
  }
}

class FileChangedWhileReading extends Error {}

class FileReadFailed extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super('file read failed');
    this.cause = cause;
  }
}
