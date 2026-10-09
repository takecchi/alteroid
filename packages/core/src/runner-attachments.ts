import { randomUUID } from 'node:crypto';
import { chown, lstat, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
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
    const bytes = Buffer.from(attachment.data, 'base64');
    if (bytes.length !== attachment.size || sha256Hex(bytes) !== attachment.sha256) {
      throw new RunnerAttachmentRejectedError(
        `添付 ${attachment.id} の中身が size / sha256 と合わない（置かない）`,
      );
    }
    return { attachment, bytes };
  });

  const base = resolve(root);
  const managerDir = resolve(base, managerId);
  const dirMode = childGid === undefined ? 0o700 : 0o750;
  const fileMode = childGid === undefined ? 0o400 : 0o440;
  const created: string[] = [];
  const placedFiles: string[] = [];
  const placed: PlacedAttachment[] = [];
  try {
    await mkdir(base, { recursive: true, mode: 0o755 });
    await assertOwnDirectory(base);
    // 担い手が dir を辿れるように、置き場の root だけは誰でも辿れる（中身は 0750 の dir の奥）。
    await ensureDirectory(managerDir, dirMode, childGid);
    for (const { attachment, bytes } of decoded) {
      const name = normalizeAttachmentName(attachment.name);
      const dir = resolve(managerDir, attachment.id);
      const path = resolve(dir, attachmentDiskName(name));
      if (!dir.startsWith(managerDir + sep) || !path.startsWith(dir + sep)) {
        throw new RunnerAttachmentRejectedError(
          `添付 ${attachment.id} の置き先が置き場の外へ出る形だった`,
        );
      }
      if (await ensureDirectory(dir, dirMode, childGid)) created.push(dir);
      const tmp = resolve(dir, `.${randomUUID()}.tmp`);
      try {
        // `wx`（O_EXCL）は symlink を辿らない。
        const handle = await open(tmp, 'wx', fileMode);
        try {
          await handle.writeFile(bytes);
          if (childGid !== undefined) await handle.chown(ownUid() ?? -1, childGid);
        } finally {
          await handle.close();
        }
        await rename(tmp, path);
        placedFiles.push(path);
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw error;
      }
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
