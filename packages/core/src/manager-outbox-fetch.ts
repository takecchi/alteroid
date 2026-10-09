import { createHash } from 'node:crypto';

import {
  ATTACHMENT_REQUEST_TIMEOUT_MS,
  AttachmentRejectedError,
  attachmentBatchItemOf,
  attachmentMaxBytes,
  isAttachmentImageMediaType,
  normalizeAttachmentName,
  validateAttachmentBatch,
  type AttachmentBatchItem,
  type AttachmentLimits,
  type AttachmentStore,
} from './attachment.js';
import { sha256Hex } from './auth.js';
import { reasonOf } from './dropped-record.js';
import type {
  RunnerClient,
  RunnerOutboxFile,
  RunnerOutboxRejectedFile,
} from './runner-protocol.js';
import type { AttachmentRef } from './schema.js';

/**
 * 取れなかったものは捨てず、名前と理由の一覧にして返す: 黙って落とさない。
 * 取りながら大きさを数えて、runner の申告か1つの上限を超えたら打ち切る: runner を信じきらない。
 * 取った後はすぐ報告へ結び付ける: 1時間の未結び付けの掃除に掛からないように。置けたものだけ退避先を消させ、失敗は握る。
 */

export const OUTBOX_FETCH_FILE_TIMEOUT_MS = 30_000;
export const OUTBOX_FETCH_TOTAL_TIMEOUT_MS = 90_000;
const OUTBOX_FETCH_ASSUMED_BYTES_PER_SECOND = 1024 * 1024;

/**
 * 大きさに応じて期限を延ばす: 大きいファイルが既定の 30 秒で時間切れにならないように。
 * 上限は {@link ATTACHMENT_REQUEST_TIMEOUT_MS}（runner 側の1リクエストの持ち時間）。
 */
export function outboxFetchDeadlineMs(size: number): number {
  const scaled = Math.ceil((Math.max(0, size) / OUTBOX_FETCH_ASSUMED_BYTES_PER_SECOND) * 1000);
  return Math.min(ATTACHMENT_REQUEST_TIMEOUT_MS, Math.max(OUTBOX_FETCH_FILE_TIMEOUT_MS, scaled));
}

/** 既定の 90 秒に、各ファイルの期限が既定の 30 秒を超えて延びた分だけを足す（小さいファイルだけの報告は延びない）。上限は1時間。 */
export function outboxFetchTotalDeadlineMs(fileDeadlinesMs: readonly number[]): number {
  const extension = fileDeadlinesMs.reduce(
    (acc, ms) => acc + Math.max(0, ms - OUTBOX_FETCH_FILE_TIMEOUT_MS),
    0,
  );
  return Math.min(ATTACHMENT_REQUEST_TIMEOUT_MS, OUTBOX_FETCH_TOTAL_TIMEOUT_MS + extension);
}

export const OUTBOX_DELETE_TIMEOUT_MS = 5_000;

export interface ManagerReportFiles {
  readonly attachments: AttachmentRef[];
  readonly rejected: { name: string; reason: string }[];
}

export interface FetchManagerOutboxInput {
  readonly runner: RunnerClient;
  readonly runnerNamesOutbox: boolean;
  readonly managerId: string;
  readonly reportId: string;
  readonly files: readonly RunnerOutboxFile[];
  readonly rejectedFiles: readonly RunnerOutboxRejectedFile[];
  readonly store: AttachmentStore;
  readonly limits: AttachmentLimits;
  readonly fileTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
}

type Rejected = { name: string; reason: string };

/** 制御文字・改行をクローンのターンへ持ち込ませない。 */
export function rejectedFileOf(file: { name: string; reason: string }): Rejected {
  return {
    name: normalizeAttachmentName(file.name),
    reason: file.reason.replaceAll(/\s+/gu, ' ').trim(),
  };
}

const FALLBACK_MEDIA_TYPE = 'application/octet-stream';

const IMAGE_FALLBACK_CODES: ReadonlySet<string> = new Set([
  'magic_mismatch',
  'too_large',
  'image_dimension_too_large',
]);

export async function fetchManagerOutbox(
  input: FetchManagerOutboxInput,
): Promise<ManagerReportFiles> {
  const attachments: AttachmentRef[] = [];
  const rejected: Rejected[] = input.rejectedFiles.map(rejectedFileOf);
  if (input.files.length === 0) return { attachments, rejected };

  const { runner } = input;
  const open = runner.openOutboxFile?.bind(runner);
  if (!input.runnerNamesOutbox || open === undefined) {
    for (const file of input.files) {
      rejected.push({
        name: normalizeAttachmentName(file.name),
        reason: 'runner が取り出しの口を名乗っていない',
      });
    }
    return { attachments, rejected };
  }

  const fileTimeoutOf = (file: RunnerOutboxFile): number =>
    input.fileTimeoutMs ?? outboxFetchDeadlineMs(file.size);
  const totalTimeoutMs =
    input.totalTimeoutMs ?? outboxFetchTotalDeadlineMs(input.files.map(fileTimeoutOf));
  const totalSignal = AbortSignal.timeout(totalTimeoutMs);
  const toRemove: RunnerOutboxFile[] = [];
  const acceptedItems: AttachmentBatchItem[] = [];

  for (const file of input.files) {
    const name = normalizeAttachmentName(file.name);
    // 個数・合計は申告の大きさで先に検める: 取りに行く前に断れる
    try {
      validateAttachmentBatch(
        [
          ...acceptedItems,
          {
            size: file.size,
            image: isAttachmentImageMediaType(file.mediaType.split(';')[0]!.trim().toLowerCase()),
          },
        ],
        input.limits,
      );
    } catch (error) {
      if (error instanceof AttachmentRejectedError) {
        rejected.push({ name, reason: `受け取らなかった: ${error.message}` });
        continue;
      }
      throw error;
    }
    if (totalSignal.aborted) {
      rejected.push({
        name,
        reason: `受け取れなかった（時間切れ。1回の報告の取り出しは全体で ${seconds(totalTimeoutMs)} 秒まで）`,
      });
      continue;
    }
    const fileTimeoutMs = fileTimeoutOf(file);
    const signal = AbortSignal.any([totalSignal, AbortSignal.timeout(fileTimeoutMs)]);
    const outcome = await fetchOne({
      open,
      managerId: input.managerId,
      file,
      name,
      signal,
      limits: input.limits,
      store: input.store,
      reportId: input.reportId,
      uploadedBy: `manager:${input.managerId}`,
      timedOutReason: () =>
        totalSignal.aborted
          ? `受け取れなかった（時間切れ。1回の報告の取り出しは全体で ${seconds(totalTimeoutMs)} 秒まで）`
          : `受け取れなかった（時間切れ。1つの取り出しは ${seconds(fileTimeoutMs)} 秒まで）`,
    });
    if (outcome.ok) {
      attachments.push(outcome.ref);
      toRemove.push(file);
      acceptedItems.push(attachmentBatchItemOf(outcome.ref));
    } else {
      rejected.push({ name, reason: outcome.reason });
      // 大きさで断ったもの（二度と取りに行かない）も消させる: 外部ストレージの無いデーモンが断る大きいファイルを、
      // runner の退避先に24時間の掃除まで溜めないため
      if (outcome.neverFetch === true) toRemove.push(file);
    }
  }

  // 失敗は握る: 取りこぼしは runner の24時間の掃除が消す。報告は止めない
  const remove = runner.deleteOutboxFile?.bind(runner);
  if (remove !== undefined && toRemove.length > 0) {
    await Promise.allSettled(
      toRemove.map((file) =>
        remove(input.managerId, file.fileId, {
          signal: AbortSignal.timeout(OUTBOX_DELETE_TIMEOUT_MS),
        }),
      ),
    );
  }
  return { attachments, rejected };
}

type FetchOneOutcome =
  { ok: true; ref: AttachmentRef } | { ok: false; reason: string; neverFetch?: true };

async function fetchOne(input: {
  open: NonNullable<RunnerClient['openOutboxFile']>;
  managerId: string;
  file: RunnerOutboxFile;
  name: string;
  signal: AbortSignal;
  limits: AttachmentLimits;
  store: AttachmentStore;
  reportId: string;
  uploadedBy: string;
  timedOutReason: () => string;
}): Promise<FetchOneOutcome> {
  const { file, signal } = input;
  const fileMax = attachmentMaxBytes(input.limits, false);
  if (file.size > fileMax) {
    return {
      ok: false,
      reason: `1つの上限（${fileMax} バイト）を超える（申告 ${file.size} バイト）ので取りに行かなかった`,
      neverFetch: true,
    };
  }
  // 画像（宣言）は先頭の検めと入れ直しに中身が要るので集める。それ以外は置き場へ流す
  const image = isAttachmentImageMediaType(file.mediaType.split(';')[0]!.trim().toLowerCase());
  let bytes: Uint8Array | undefined;
  try {
    const opening = input.open(input.managerId, file.fileId, { signal });
    const content = await raceAbort(opening, signal);
    if (content === 'aborted') {
      void opening.then(
        (late) => (late === undefined ? undefined : closeBody(late.body)),
        () => undefined,
      );
      return { ok: false, reason: input.timedOutReason() };
    }
    if (content === undefined) {
      return {
        ok: false,
        reason: '退避先に無かった（runner が消した、または既に取り出された）',
      };
    }
    if (content.size !== undefined && content.size !== file.size) {
      void closeBody(content.body);
      return {
        ok: false,
        reason: `runner の応答の大きさ（${content.size} バイト）が報告の申告（${file.size} バイト）と合わない`,
      };
    }
    if (!image) return await streamToStore(input, content.body);
    const read = await readBounded(content.body, file.size, signal);
    if (read.kind === 'aborted') return { ok: false, reason: input.timedOutReason() };
    if (read.kind === 'too_large') {
      return {
        ok: false,
        reason: `runner の申告（${file.size} バイト）を超えて送ってきたので、途中で打ち切った`,
      };
    }
    bytes = read.bytes;
  } catch (error) {
    if (signal.aborted) return { ok: false, reason: input.timedOutReason() };
    return { ok: false, reason: `取り出しに失敗した: ${reasonOf(error)}` };
  }
  if (bytes.length !== file.size) {
    return {
      ok: false,
      reason: `大きさが申告（${file.size} バイト）と合わない（${bytes.length} バイト受け取った）`,
    };
  }
  if (sha256Hex(bytes) !== file.sha256) return { ok: false, reason: 'sha256 が申告と合わない' };

  let meta;
  try {
    meta = await putWithImageFallback(input.store, {
      name: file.name,
      mediaType: file.mediaType,
      bytes,
      uploadedBy: input.uploadedBy,
    });
  } catch (error) {
    return { ok: false, reason: `置き場へ入れられなかった: ${reasonOf(error)}` };
  }
  return bindToReport(input, meta);
}

type FetchOneInput = Parameters<typeof fetchOne>[0];

class OutboxStreamStop extends Error {}

/** 画像でないファイルは集めずに置き場へ流す。申告を超えたら打ち切り、流し終えて申告と合わなければ入れたものを消す。 */
async function streamToStore(
  input: FetchOneInput,
  body: AsyncIterable<Uint8Array>,
): Promise<FetchOneOutcome> {
  const { file, signal } = input;
  const iterator = body[Symbol.asyncIterator]();
  const hash = createHash('sha256');
  let total = 0;
  let ended = false;
  let stop: 'aborted' | 'too_large' | undefined;
  let bodyError: { error: unknown } | undefined;
  const source = (async function* (): AsyncGenerator<Uint8Array> {
    try {
      for (;;) {
        const pending = iterator.next();
        // 中断で待つのをやめた後に遅れて拒否されても、未処理の拒否にしない
        pending.catch(() => undefined);
        const step = await raceAbort(pending, signal);
        if (step === 'aborted') {
          stop = 'aborted';
          throw new OutboxStreamStop();
        }
        if (step.done === true) {
          ended = true;
          return;
        }
        total += step.value.length;
        if (total > file.size) {
          stop = 'too_large';
          throw new OutboxStreamStop();
        }
        hash.update(step.value);
        yield step.value;
      }
    } catch (error) {
      if (!(error instanceof OutboxStreamStop)) bodyError = { error };
      throw error;
    } finally {
      // 読み切らずに抜けるときに、相手の繋ぎを畳む（待たない）
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }
  })();

  let meta;
  try {
    meta = await input.store.putStream({
      name: file.name,
      mediaType: file.mediaType,
      body: source,
      uploadedBy: input.uploadedBy,
    });
  } catch (error) {
    if (stop === 'aborted' || (signal.aborted && !ended)) {
      return { ok: false, reason: input.timedOutReason() };
    }
    if (stop === 'too_large') {
      return {
        ok: false,
        reason: `runner の申告（${file.size} バイト）を超えて送ってきたので、途中で打ち切った`,
      };
    }
    if (bodyError !== undefined) {
      return { ok: false, reason: `取り出しに失敗した: ${reasonOf(bodyError.error)}` };
    }
    if (ended) {
      const mismatch = mismatchOf(file, total, hash);
      if (mismatch !== undefined) return { ok: false, reason: mismatch };
    }
    return { ok: false, reason: `置き場へ入れられなかった: ${reasonOf(error)}` };
  }
  const mismatch = mismatchOf(file, total, hash);
  if (mismatch !== undefined) {
    // 照合に落ちたら、入れたものを消す（置き場に残さない）。
    await input.store.remove(meta.id).catch(() => undefined);
    return { ok: false, reason: mismatch };
  }
  return bindToReport(input, meta);
}

function mismatchOf(
  file: RunnerOutboxFile,
  total: number,
  hash: ReturnType<typeof createHash>,
): string | undefined {
  if (total !== file.size) {
    return `大きさが申告（${file.size} バイト）と合わない（${total} バイト受け取った）`;
  }
  if (hash.copy().digest('hex') !== file.sha256) return 'sha256 が申告と合わない';
  return undefined;
}

async function bindToReport(
  input: FetchOneInput,
  meta: Awaited<ReturnType<AttachmentStore['put']>>,
): Promise<FetchOneOutcome> {
  try {
    const bound = await input.store.bindToManagerReport([meta.id], input.reportId);
    if (!bound.bound.includes(meta.id)) {
      return { ok: false, reason: '置き場へ入れたが、報告へ結び付けられなかった' };
    }
  } catch (error) {
    return { ok: false, reason: `報告へ結び付けられなかった: ${reasonOf(error)}` };
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
  };
}

async function putWithImageFallback(
  store: AttachmentStore,
  input: { name: string; mediaType: string; bytes: Uint8Array; uploadedBy: string },
) {
  try {
    return await store.put(input);
  } catch (error) {
    if (
      error instanceof AttachmentRejectedError &&
      IMAGE_FALLBACK_CODES.has(error.code) &&
      isAttachmentImageMediaType(input.mediaType.split(';')[0]!.trim().toLowerCase())
    ) {
      // 画像の上限・中身の検めに落ちた画像は、受け付けはするが画像としては見えない種類で入れ直す
      return store.put({ ...input, mediaType: FALLBACK_MEDIA_TYPE });
    }
    throw error;
  }
}

type ReadResult = { kind: 'ok'; bytes: Uint8Array } | { kind: 'too_large' } | { kind: 'aborted' };

async function readBounded(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<ReadResult> {
  const iterator = body[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const pending = iterator.next();
      // 中断で待つのをやめた後に遅れて拒否されても、未処理の拒否にしない
      pending.catch(() => undefined);
      const step = await raceAbort(pending, signal);
      if (step === 'aborted') return { kind: 'aborted' };
      if (step.done === true) return { kind: 'ok', bytes: Buffer.concat(chunks) };
      total += step.value.length;
      if (total > maxBytes) return { kind: 'too_large' };
      chunks.push(step.value);
    }
  } finally {
    // 読み切らずに抜けるときに、相手の繋ぎを畳む（待たない: 返らない相手を待つと打ち切りの意味が無い）
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
}

function closeBody(body: AsyncIterable<Uint8Array>): Promise<void> {
  return Promise.resolve(body[Symbol.asyncIterator]().return?.()).then(
    () => undefined,
    () => undefined,
  );
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | 'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted');
  return new Promise<T | 'aborted'>((resolve, reject) => {
    const onAbort = () => resolve('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function seconds(ms: number): number {
  return Math.round(ms / 100) / 10;
}
