import { createHash, randomUUID } from 'node:crypto';
import {
  chown,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import type { AgentInputImage, AgentUserInput } from './agent-session.js';
import {
  attachmentDiskName,
  normalizeAttachmentName,
  sniffAttachmentImageType,
  type AttachmentLimits,
  formatImageLimit,
  imageRouteOverNotice,
  readAttachmentLimits,
  routeImageCapBytes,
  TurnImageBudget,
  turnImageOverNotice,
  turnImageLimitsOf,
  type TurnAttachmentLimits,
  type TurnImageOverReason,
} from './attachment.js';
import { imageDimensionOverNotice, isImageOverDimension } from './attachment-image-size.js';
import { sha256Hex } from './auth.js';
import { stripNul } from './nul-guard.js';
import type { RunnerAttachment } from './runner-protocol.js';

/**
 * 担い手に書ける dir を作らない: runner（root）が書く先を担い手が symlink に差し替える経路を塞ぐため、
 * 所有は runner のままグループだけ担い手の gid にする（dir 0750 / ファイル 0440。子プロセスを降ろさない構成は 0700 / 0400）。
 * `/tmp` は誰でも書けるので、root と各 dir が runner 所有の実在の dir（symlink でない）かを確かめてから使う。
 */

export function defaultRunnerAttachmentsRoot(): string {
  return join(tmpdir(), 'alteroid-attachments');
}

export const RUNNER_ATTACHMENT_STALE_MS = 24 * 60 * 60_000;

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isSafeRunnerSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value);
}

const BODY_SLACK_BYTES = 2 * 1024 * 1024;
const PER_ATTACHMENT_OVERHEAD_BYTES = 4096;

/**
 * 能力の上限ではなく、デーモンの検めを抜けた巨大な本文への最後の歯止め。runner とデーモンは環境が別なので、
 * 上限の環境変数（`ALTEROID_ATTACHMENT_MAX_*`）を上げるときは両方に同じ値を置くこと。
 */
export function runnerAttachmentBodyLimit(limits: AttachmentLimits): number {
  return (
    Math.ceil((limits.maxTotalBytes * 4) / 3) +
    limits.maxPerMessage * PER_ATTACHMENT_OVERHEAD_BYTES +
    BODY_SLACK_BYTES
  );
}

export class RunnerAttachmentRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerAttachmentRejectedError';
  }
}

/** 別口（`stageRunnerAttachment`）で断るとき。`status` は 413（大きさの超過）か 422（照合が合わない）。 */
export class RunnerAttachmentStageError extends RunnerAttachmentRejectedError {
  readonly status: 413 | 422;
  constructor(message: string, status: 413 | 422) {
    super(message);
    this.name = 'RunnerAttachmentStageError';
    this.status = status;
  }
}

export interface StagedAttachmentEntry {
  readonly id: string;
  readonly size: number;
  readonly sha256: string;
  readonly path: string;
}

/**
 * 別口で置いて照合を済ませた添付の控え（managerId + id → size・sha256・path）。runner のメモリにだけ持つ。
 * 命令の `staged: true` の参照は、これと食い違えば断る（sha256 は別口で照合済みなので読み直さない）。
 */
export class StagedAttachmentLedger {
  readonly #entries = new Map<string, StagedAttachmentEntry>();

  set(managerId: string, entry: StagedAttachmentEntry): void {
    this.#entries.set(`${managerId}/${entry.id}`, entry);
  }

  get(managerId: string, id: string): StagedAttachmentEntry | undefined {
    return this.#entries.get(`${managerId}/${id}`);
  }

  delete(managerId: string, id: string): void {
    this.#entries.delete(`${managerId}/${id}`);
  }

  forgetManager(managerId: string): void {
    const prefix = `${managerId}/`;
    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(prefix)) this.#entries.delete(key);
    }
  }
}

export interface PlacedAttachment {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly path: string;
  readonly image?: AgentInputImage;
  readonly imageOverLimit?: number;
  readonly imageOverRouteLimit?: true;
  readonly imageOverDimension?: true;
  readonly imageOverTurnLimit?: { readonly reason: TurnImageOverReason; readonly limit: number };
}

export interface PlaceAttachmentsOptions {
  readonly root: string;
  readonly managerId: string;
  readonly attachments: readonly RunnerAttachment[];
  readonly childGid?: number;
  readonly limits?: TurnAttachmentLimits;
  readonly routeEnv?: NodeJS.ProcessEnv;
  /** 別口で置いた添付の控え。`staged: true` の添付を解くのに要る（無ければ `staged` は断る）。 */
  readonly ledger?: StagedAttachmentLedger;
}

const ownUid = (): number | undefined =>
  typeof process.getuid === 'function' ? process.getuid() : undefined;

async function assertOwnDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new RunnerAttachmentRejectedError(
      `添付の置き場 ${path} が実在の dir でない（symlink か dir 以外）。置かない`,
    );
  }
  const uid = ownUid();
  if (uid !== undefined && info.uid !== uid) {
    throw new RunnerAttachmentRejectedError(
      `添付の置き場 ${path} の所有者が runner ではない。置かない`,
    );
  }
}

async function ensureDirectory(
  path: string,
  mode: number,
  childGid: number | undefined,
): Promise<boolean> {
  let madeHere = true;
  await mkdir(path, { mode }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    madeHere = false;
  });
  await assertOwnDirectory(path);
  if (childGid !== undefined) await chown(path, ownUid() ?? -1, childGid);
  return madeHere;
}

// 命令で置く（`placeRunnerAttachments`）のと別口で置く（`stageRunnerAttachment`）のとで、置き場・置き先・モード・書き方を共有する。
const attachmentModes = (childGid: number | undefined) => ({
  dirMode: childGid === undefined ? 0o700 : 0o750,
  fileMode: childGid === undefined ? 0o400 : 0o440,
});

/** `<root>/<managerId>/<id>/<attachmentDiskName(name)>`。置き場の外へ出る形は断る。 */
function resolveAttachmentTarget(base: string, managerId: string, id: string, rawName: string) {
  const name = normalizeAttachmentName(rawName);
  const managerDir = resolve(base, managerId);
  const dir = resolve(managerDir, id);
  const path = resolve(dir, attachmentDiskName(name));
  if (!dir.startsWith(managerDir + sep) || !path.startsWith(dir + sep)) {
    throw new RunnerAttachmentRejectedError(`添付 ${id} の置き先が置き場の外へ出る形だった`);
  }
  return { name, managerDir, dir, path };
}

// 担い手が dir を辿れるように、置き場の root だけは誰でも辿れる（中身は 0750 の dir の奥）。
async function ensureAttachmentRoot(base: string): Promise<void> {
  await mkdir(base, { recursive: true, mode: 0o755 });
  await assertOwnDirectory(base);
}

/** tmp へ書いてから rename する。`wx`（O_EXCL）は symlink を辿らない。失敗したら tmp を消す。 */
async function writeAttachmentFile(
  dir: string,
  path: string,
  fileMode: number,
  childGid: number | undefined,
  write: (handle: FileHandle) => Promise<void>,
): Promise<void> {
  const tmp = resolve(dir, `.${randomUUID()}.tmp`);
  try {
    const handle = await open(tmp, 'wx', fileMode);
    try {
      await write(handle);
      if (childGid !== undefined) await handle.chown(ownUid() ?? -1, childGid);
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export interface StageRunnerAttachmentOptions {
  readonly root: string;
  readonly managerId: string;
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  /** 中身（流れてくるまま。溜めない）。 */
  readonly body: AsyncIterable<Uint8Array>;
  /** 1つの大きいファイルとして受ける最大バイト（`attachmentStageLimit`）。 */
  readonly limit: number;
  readonly childGid?: number;
  readonly ledger: StagedAttachmentLedger;
}

/**
 * 大きいファイルの別口（#4128 段3a）。中身を流しながら大きさと sha256 を数え、命令の添付と同じ置き先
 * （`<root>/<managerId>/<id>/<名前>`）へ置く。申告の `size` を超えた時点で読むのをやめ、終わって `size` / `sha256` が
 * 合わなければ、tmp を消して断る。**同じ id がすでに置いてあれば置き直す**（`placeRunnerAttachments` が同じ id を
 * 後のものが先のものを上書きするのと同じ。同じ中身なら結果は同じで、冪等）。
 */
export async function stageRunnerAttachment(
  options: StageRunnerAttachmentOptions,
): Promise<StagedAttachmentEntry> {
  const { root, managerId, id, size, sha256, body, limit, childGid, ledger } = options;
  if (!SAFE_SEGMENT.test(managerId)) {
    throw new RunnerAttachmentRejectedError('managerId が dir 名にできない形');
  }
  if (!SAFE_SEGMENT.test(id)) {
    throw new RunnerAttachmentRejectedError(`添付の id が dir 名にできない形: ${id}`);
  }
  // 読む前に断る。
  if (size > limit) {
    throw new RunnerAttachmentStageError(
      `添付 ${id} の大きさ ${size} バイトが、この runner の上限 ${limit} バイトを超える（置いていない）`,
      413,
    );
  }
  const base = resolve(root);
  const target = resolveAttachmentTarget(base, managerId, id, options.name);
  const { dirMode, fileMode } = attachmentModes(childGid);
  await ensureAttachmentRoot(base);
  await ensureDirectory(target.managerDir, dirMode, childGid);
  const dirMadeHere = await ensureDirectory(target.dir, dirMode, childGid);
  const hash = createHash('sha256');
  let received = 0;
  try {
    await writeAttachmentFile(target.dir, target.path, fileMode, childGid, async (handle) => {
      for await (const chunk of body) {
        received += chunk.byteLength;
        // 超えた時点で抜ける（`for await` の抜けで本文の読みも畳まれる）。
        if (received > size) {
          throw new RunnerAttachmentStageError(
            `添付 ${id} の中身が申告の size（${size} バイト）を超えた（置かない）`,
            413,
          );
        }
        hash.update(chunk);
        await handle.writeFile(chunk);
      }
      if (received !== size || hash.digest('hex') !== sha256) {
        throw new RunnerAttachmentStageError(
          `添付 ${id} の中身が size / sha256 と合わない（置かない）`,
          422,
        );
      }
    });
  } catch (error) {
    if (dirMadeHere) await rm(target.dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  const entry: StagedAttachmentEntry = { id, size, sha256, path: target.path };
  ledger.set(managerId, entry);
  return entry;
}

/** 命令の `staged: true` の参照を、別口で置いたファイルと突き合わせる（中身は読み直さない）。 */
async function verifyStagedAttachment(
  attachment: RunnerAttachment,
  managerId: string,
  dir: string,
  path: string,
  ledger: StagedAttachmentLedger | undefined,
): Promise<void> {
  const refuse = (why: string) =>
    new RunnerAttachmentRejectedError(`添付 ${attachment.id} は別口で置かれていない: ${why}`);
  const entry = ledger?.get(managerId, attachment.id);
  if (entry === undefined) throw refuse('置いた控えが無い');
  if (entry.size !== attachment.size || entry.sha256 !== attachment.sha256 || entry.path !== path) {
    throw refuse('命令の size / sha256 が、置いた控えと食い違う');
  }
  try {
    await assertOwnDirectory(dir);
    const info = await lstat(path);
    const uid = ownUid();
    if (
      !info.isFile() ||
      (uid !== undefined && info.uid !== uid) ||
      info.size !== attachment.size
    ) {
      throw refuse('置き場のファイルが控えと合わない');
    }
  } catch (error) {
    if (error instanceof RunnerAttachmentRejectedError) throw error;
    throw refuse('置き場にファイルが無い（消えた）');
  }
}

export async function placeRunnerAttachments(
  options: PlaceAttachmentsOptions,
): Promise<PlacedAttachment[]> {
  const { root, managerId, attachments, childGid } = options;
  const limits = options.limits ?? readAttachmentLimits().limits;
  const maxImageBytes = limits.maxImageBytes;
  const routeCap = routeImageCapBytes(limits, options.routeEnv ?? process.env);
  const turnLimits = turnImageLimitsOf(limits);
  const budget = new TurnImageBudget(turnLimits);
  if (!SAFE_SEGMENT.test(managerId)) {
    throw new RunnerAttachmentRejectedError('managerId が dir 名にできない形');
  }
  if (attachments.length === 0) return [];
  const seenIds = new Set<string>();
  const decoded = attachments.map((attachment) => {
    if (!SAFE_SEGMENT.test(attachment.id)) {
      throw new RunnerAttachmentRejectedError(`添付の id が dir 名にできない形: ${attachment.id}`);
    }
    // 同じ id は同じ置き先（`<id>/<名前>`）を指す。後のものが先のものを上書きし、通知行の sha256 が path の中身と合わなくなる。
    if (seenIds.has(attachment.id)) {
      throw new RunnerAttachmentRejectedError(`添付の id が重複している: ${attachment.id}`);
    }
    seenIds.add(attachment.id);
    // 別口で置いてあるものの参照（`staged`）は中身を持たない。置き場で突き合わせる。
    if (attachment.data === undefined) return { attachment, bytes: undefined };
    const bytes = Buffer.from(attachment.data, 'base64');
    if (bytes.length !== attachment.size || sha256Hex(bytes) !== attachment.sha256) {
      throw new RunnerAttachmentRejectedError(
        `添付 ${attachment.id} の中身が size / sha256 と合わない（置かない）`,
      );
    }
    return { attachment, bytes };
  });

  const base = resolve(root);
  const { dirMode, fileMode } = attachmentModes(childGid);
  const created: string[] = [];
  const placedFiles: string[] = [];
  const placed: PlacedAttachment[] = [];
  try {
    await ensureAttachmentRoot(base);
    const managerDir = resolve(base, managerId);
    await ensureDirectory(managerDir, dirMode, childGid);
    for (const { attachment, bytes } of decoded) {
      const { name, dir, path } = resolveAttachmentTarget(
        base,
        managerId,
        attachment.id,
        attachment.name,
      );
      if (bytes === undefined) {
        // 別口で置いたファイルは、この命令が失敗しても消さない（再送で同じ参照が通るように。`placedFiles` に入れない）。
        await verifyStagedAttachment(attachment, managerId, dir, path, options.ledger);
        placed.push({
          id: attachment.id,
          name,
          mediaType: attachment.mediaType,
          size: attachment.size,
          sha256: attachment.sha256,
          path,
        });
        continue;
      }
      if (await ensureDirectory(dir, dirMode, childGid)) created.push(dir);
      await writeAttachmentFile(dir, path, fileMode, childGid, (handle) => handle.writeFile(bytes));
      placedFiles.push(path);
      // 同じ id の別口の控えは、いま上書きしたので古い。
      options.ledger?.delete(managerId, attachment.id);
      const imageType = sniffAttachmentImageType(bytes);
      // 大きさと寸法は上げる時点で断るが、ここも消さない: 旧データ・上限を後から下げたとき・宣言が画像以外のものがここへ来る。
      const overRoute = routeCap !== undefined && bytes.length > routeCap;
      const overDimension =
        imageType !== undefined &&
        bytes.length <= maxImageBytes &&
        !overRoute &&
        isImageOverDimension(bytes, imageType);
      const overTurn =
        imageType === undefined || bytes.length > maxImageBytes || overRoute || overDimension
          ? undefined
          : budget.take(bytes.length);
      placed.push({
        id: attachment.id,
        name,
        mediaType: attachment.mediaType,
        size: attachment.size,
        sha256: attachment.sha256,
        path,
        ...(imageType === undefined
          ? {}
          : bytes.length > maxImageBytes
            ? { imageOverLimit: maxImageBytes }
            : overRoute
              ? { imageOverRouteLimit: true as const }
              : overDimension
                ? { imageOverDimension: true as const }
                : overTurn !== undefined
                  ? {
                      imageOverTurnLimit: {
                        reason: overTurn,
                        limit:
                          overTurn === 'count'
                            ? turnLimits.maxTurnImages
                            : turnLimits.maxTurnImageBytes,
                      },
                    }
                  : // 受け取った文字列（改行・空白・url-safe を黙って許す復号）ではなく、検めた bytes から作り直した正規の base64。
                    {
                      image: {
                        mediaType: imageType,
                        data: Buffer.from(bytes).toString('base64'),
                        name,
                      },
                    }),
      });
    }
  } catch (error) {
    for (const file of placedFiles) await rm(file, { force: true }).catch(() => undefined);
    for (const dir of created)
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return placed;
}

export function placedAttachmentNoticeLine(placed: PlacedAttachment): string {
  return (
    `[添付] id=${placed.id} name=${stripNul(placed.name)} type=${placed.mediaType} ` +
    `size=${placed.size} sha256=${placed.sha256} path=${placed.path}` +
    (placed.imageOverRouteLimit === true
      ? imageRouteOverNotice('path で Read で開ける')
      : placed.imageOverDimension === true
        ? imageDimensionOverNotice('path で Read で開ける')
        : placed.imageOverTurnLimit !== undefined
          ? turnImageOverNotice(
              placed.imageOverTurnLimit.reason,
              {
                maxTurnImages: placed.imageOverTurnLimit.limit,
                maxTurnImageBytes: placed.imageOverTurnLimit.limit,
              },
              'path で Read で開ける',
            )
          : placed.imageOverLimit === undefined
            ? `${placed.image === undefined ? '' : '（画像としても渡した）'}（Read で開ける）`
            : `（画像の上限（${formatImageLimit(placed.imageOverLimit)}）を超えるので画像としては渡していない。path で Read で開ける）`)
  );
}

export function composeAttachmentInput(
  text: string,
  placed: readonly PlacedAttachment[],
): AgentUserInput {
  if (placed.length === 0) return { text };
  const images = placed.flatMap((item) => (item.image === undefined ? [] : [item.image]));
  const body = `${text}\n\n${placed.map(placedAttachmentNoticeLine).join('\n')}`;
  return images.length === 0 ? { text: body } : { text: body, images };
}

export async function removeManagerAttachments(root: string, managerId: string): Promise<void> {
  if (!SAFE_SEGMENT.test(managerId)) return;
  const base = resolve(root);
  const dir = resolve(base, managerId);
  if (!dir.startsWith(base + sep)) return;
  await rm(dir, { recursive: true, force: true });
}

export async function pruneStaleAttachmentDirs(
  root: string,
  liveManagerIds: readonly string[],
  now: number,
  maxAgeMs: number = RUNNER_ATTACHMENT_STALE_MS,
): Promise<number> {
  const entries = await readdir(root).catch(() => [] as string[]);
  let removed = 0;
  for (const entry of entries) {
    if (liveManagerIds.includes(entry)) continue;
    const dir = join(root, entry);
    const info = await stat(dir).catch(() => undefined);
    if (info === undefined || now - info.mtimeMs <= maxAgeMs) continue;
    await rm(dir, { recursive: true, force: true }).then(
      () => {
        removed += 1;
      },
      () => undefined,
    );
  }
  return removed;
}
