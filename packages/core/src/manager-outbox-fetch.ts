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
 * デーモンが runner の出し箱の退避先からファイルを取りに行き、置き場へ入れる段取り（Issue #4126 P2b）。
 *
 * 報告（`report`）に載った `files` を1つずつ、この順で処理する。**取れなかったものは捨てず、名前と理由の一覧にして返す**
 * （呼び手が報告に添える。黙って落とさない）。
 *
 * 1. 個数・合計を `validateAttachmentBatch`（人間の1発言と同じ上限）で検める。超えた分は理由つきで受け取らない
 * 2. `openOutboxFile` で開き、**取りながら大きさを数えて**、runner の申告か1つの上限を超えたら途中で打ち切る
 *    （runner を信じきらない）
 * 3. 大きさと sha256 を申告と照合する。合わなければ置かない
 * 4. `store.put`（`prepareAttachment` を通る）で置く。宣言が画像なのに画像の上限を超える・中身が合わないときは
 *    `application/octet-stream` に落として入れ直す（画像としては見えないが、受け付ける）
 * 5. すぐ報告へ結び付ける（1時間の未結び付けの掃除に掛からないように）。**置けたものだけ**退避先を消させる（失敗は握る）
 */

/** 1つの取り出しにかける時間の既定。 */
export const OUTBOX_FETCH_FILE_TIMEOUT_MS = 30_000;
/** 1回の報告ぶんの取り出し全体にかける時間の既定。超えた分は「受け取れなかった（時間切れ）」にして報告を先へ進める。 */
export const OUTBOX_FETCH_TOTAL_TIMEOUT_MS = 90_000;
/** 大きさに応じて延ばす期限の、見込む転送速度（バイト/秒。1 MiB/s）。 */
const OUTBOX_FETCH_ASSUMED_BYTES_PER_SECOND = 1024 * 1024;

/**
 * 1つのファイルを取る（または別口へ押す）時間の期限（ms）。大きさに応じて延ばす（#4128 段3b）:
 * `max(既定 30 秒, size / (1 MiB/s))`。30 MiB までは既定の 30 秒のまま（小さいファイルの期限を変えない）。
 * 上限は {@link ATTACHMENT_REQUEST_TIMEOUT_MS}（1時間。runner 側の1リクエストの持ち時間）。2 GiB は 2048 秒（約34分）。
 */
export function outboxFetchDeadlineMs(size: number): number {
  const scaled = Math.ceil((Math.max(0, size) / OUTBOX_FETCH_ASSUMED_BYTES_PER_SECOND) * 1000);
  return Math.min(ATTACHMENT_REQUEST_TIMEOUT_MS, Math.max(OUTBOX_FETCH_FILE_TIMEOUT_MS, scaled));
}

/**
 * 1回の報告ぶんの取り出し全体の期限（ms）。既定の 90 秒に、各ファイルの期限が既定の 30 秒を超えて延びた分を足す
 * （小さいファイルだけの報告は 90 秒のまま。大きいファイルの分だけ延びる）。上限は1時間。
 */
export function outboxFetchTotalDeadlineMs(fileDeadlinesMs: readonly number[]): number {
  const extension = fileDeadlinesMs.reduce(
    (acc, ms) => acc + Math.max(0, ms - OUTBOX_FETCH_FILE_TIMEOUT_MS),
    0,
  );
  return Math.min(ATTACHMENT_REQUEST_TIMEOUT_MS, OUTBOX_FETCH_TOTAL_TIMEOUT_MS + extension);
}

/** 退避先を消させる呼び出し1回の時間。 */
export const OUTBOX_DELETE_TIMEOUT_MS = 5_000;

export interface ManagerReportFiles {
  readonly attachments: AttachmentRef[];
  readonly rejected: { name: string; reason: string }[];
}

export interface FetchManagerOutboxInput {
  readonly runner: RunnerClient;
  /** runner が `manager-outbox` を名乗っているか。名乗っていなければ取りに行かず、rejected に落とす。 */
  readonly runnerNamesOutbox: boolean;
  readonly managerId: string;
  /** 結び付け先の報告の id。 */
  readonly reportId: string;
  readonly files: readonly RunnerOutboxFile[];
  readonly rejectedFiles: readonly RunnerOutboxRejectedFile[];
  readonly store: AttachmentStore;
  readonly limits: AttachmentLimits;
  readonly fileTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
}

type Rejected = { name: string; reason: string };

/** 断ったファイルの名前を、クローンのターンへ出してよい形にする（制御文字・改行を持ち込ませない）。 */
export function rejectedFileOf(file: { name: string; reason: string }): Rejected {
  return {
    name: normalizeAttachmentName(file.name),
    reason: file.reason.replaceAll(/\s+/gu, ' ').trim(),
  };
}

/** 画像として入れ直さず、画像でない種類に落とすときの種類。 */
const FALLBACK_MEDIA_TYPE = 'application/octet-stream';

/** 宣言が画像のときだけ、octet-stream に落として入れ直してよい断り方。 */
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

  // 注入（試験用）があればそれを優先する。無ければ大きさに応じて延ばす
  const fileTimeoutOf = (file: RunnerOutboxFile): number =>
    input.fileTimeoutMs ?? outboxFetchDeadlineMs(file.size);
  const totalTimeoutMs =
    input.totalTimeoutMs ?? outboxFetchTotalDeadlineMs(input.files.map(fileTimeoutOf));
  const totalSignal = AbortSignal.timeout(totalTimeoutMs);
  const placed: RunnerOutboxFile[] = [];
  const acceptedItems: AttachmentBatchItem[] = [];

  for (const file of input.files) {
    const name = normalizeAttachmentName(file.name);
    // 個数・合計は申告の大きさで先に検める（取りに行く前に断れる）。取った後の実際の大きさは下で照合する。
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
      placed.push(file);
      acceptedItems.push(attachmentBatchItemOf(outcome.ref));
    } else {
      rejected.push({ name, reason: outcome.reason });
    }
  }

  // 置けたものだけ、退避先を消させる。失敗は握る（取りこぼしは runner の24時間の掃除が消す）。報告は止めない。
  const remove = runner.deleteOutboxFile?.bind(runner);
  if (remove !== undefined && placed.length > 0) {
    await Promise.allSettled(
      placed.map((file) =>
        remove(input.managerId, file.fileId, {
          signal: AbortSignal.timeout(OUTBOX_DELETE_TIMEOUT_MS),
        }),
      ),
    );
  }
  return { attachments, rejected };
}

type FetchOneOutcome = { ok: true; ref: AttachmentRef } | { ok: false; reason: string };

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
    };
  }
  // 画像（宣言）は先頭の検めと入れ直しに中身が要るので、これまでどおり集めて入れる。それ以外は置き場へ流す（#4128 段1）
  const image = isAttachmentImageMediaType(file.mediaType.split(';')[0]!.trim().toLowerCase());
  let bytes: Uint8Array | undefined;
  try {
    const opening = input.open(input.managerId, file.fileId, { signal });
    const content = await raceAbort(opening, signal);
    if (content === 'aborted') {
      // 待つのをやめた後に開けてしまった繋ぎは畳む
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

/**
 * 画像でないファイルを、集めずに置き場へ流す（#4128 段1）。取りながら大きさと sha256 を数え、申告を超えたら打ち切る。
 * 流し終えてから申告と照合し、合わなければ**入れたものを消す**（これまでの「照合してから入れる」と結果が同じ）。
 */
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
    // 照合に落ちたら、入れたものを消す
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
      // 画像の上限・中身の検めに落ちた画像は、受け付けはするが画像としては見えない種類で入れ直す（PRD「添付」）。
      return store.put({ ...input, mediaType: FALLBACK_MEDIA_TYPE });
    }
    throw error;
  }
}

type ReadResult = { kind: 'ok'; bytes: Uint8Array } | { kind: 'too_large' } | { kind: 'aborted' };

/** 取りながら数え、`maxBytes` を超えた時点で打ち切る。`signal` が中断されたら待たずに抜ける。 */
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

/** `promise` と中断を競わせる。中断が先なら `'aborted'`。 */
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
