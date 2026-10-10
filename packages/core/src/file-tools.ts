import {
  AttachmentCursorError,
  classifyAttachmentFrom,
  encodeAttachmentCursor,
  isAttachmentBound,
  ATTACHMENT_UNBOUND_TTL_MS,
  type AttachmentFromClass,
  type AttachmentMeta,
  type AttachmentStore,
  type AttachmentUsage,
} from './attachment.js';
import { removeAttachmentCopy } from './attachment-fetch.js';
import { excerptLine, renderListing, renderListingEntry } from './excerpt.js';

/**
 * クローンの道具 `file_list` / `file_keep` / `file_delete` の実体。
 * 置き場の**控えだけ**を見る（`list` / `getMeta` / `usage` は中身を読まない。`get` は呼ばない）。
 */

/** 1回の呼び出しで置き場から取る件数。表示は {@link FILE_LIST_BUDGET} で別に締める。 */
export const FILE_LIST_PAGE = 50;

// 他の一覧の予算と値が同じでも使い回さない: 片方だけ直したくなったときに一緒に動くため
export const FILE_LIST_BUDGET = 6_000;

// 名前・種類は人間やマネージャーが決める文字列なので、出す側で締める
const FILE_LIST_NAME_EXCERPT = 80;
const FILE_LIST_TYPE_EXCERPT = 60;

const FROM_LABELS: Readonly<Record<AttachmentFromClass, string>> = {
  human: '人間',
  clone: 'クローン',
  manager: 'マネージャー',
  integration: '連携',
  unknown: '不明',
};

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** 保存中か、いつ消えるか。 */
export function describeAttachmentRetention(meta: AttachmentMeta): string {
  if (meta.keptAt !== undefined) return '保存中（期限なし）';
  if (meta.releasedAt === undefined && !isAttachmentBound(meta)) {
    const sweepAt = new Date(Date.parse(meta.createdAt) + ATTACHMENT_UNBOUND_TTL_MS).toISOString();
    return `未結び付け（${sweepAt} に消える。会話へ添えるか保存すれば残る）`;
  }
  return meta.expiresAt === undefined ? '期限なし' : `期限 ${meta.expiresAt}`;
}

/**
 * 一覧の1件。`renderListingEntry` を通す（一覧は id・名前・概要・作成・更新を必ず持つ）。
 * 更新は「保存の印を付け外しした時刻」で、一度も変えていなければ作成と同じである（控えの他の欄は変わらない）。
 */
function describeFileEntry(meta: AttachmentMeta): string {
  return renderListingEntry({
    id: meta.id,
    title: excerptLine(meta.name, FILE_LIST_NAME_EXCERPT),
    summary: [
      excerptLine(meta.mediaType, FILE_LIST_TYPE_EXCERPT),
      formatAttachmentSize(meta.size),
      `出所:${FROM_LABELS[classifyAttachmentFrom(meta.uploadedBy)]}`,
      describeAttachmentRetention(meta),
    ].join(' | '),
    createdAt: meta.createdAt,
    updatedAt: meta.keptAt ?? meta.releasedAt ?? meta.createdAt,
  });
}

/** 使用量の1〜2行（合計と、0 でない出所ごと）。 */
export function renderFileUsage(usage: AttachmentUsage): string {
  const total = `置き場の使用量: ${usage.count} 件 ${formatAttachmentSize(usage.totalBytes)}`;
  const parts = (Object.keys(FROM_LABELS) as AttachmentFromClass[])
    .filter((from) => usage.byFrom[from].count > 0)
    .map(
      (from) =>
        `${FROM_LABELS[from]} ${usage.byFrom[from].count} 件 ${formatAttachmentSize(usage.byFrom[from].totalBytes)}`,
    );
  return parts.length === 0 ? total : `${total}\n出所別: ${parts.join(' / ')}`;
}

export interface FileListInput {
  readonly kept?: boolean | undefined;
  readonly from?: AttachmentFromClass | undefined;
  readonly conversationId?: string | undefined;
  readonly query?: string | undefined;
  readonly cursor?: string | undefined;
}

export async function listFiles(
  stores: { readonly attachments: AttachmentStore },
  input: FileListInput,
): Promise<string> {
  let page;
  try {
    page = await stores.attachments.list({
      limit: FILE_LIST_PAGE,
      ...(input.kept === undefined ? {} : { kept: input.kept }),
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      ...(input.query === undefined ? {} : { q: input.query }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
  } catch (error) {
    if (error instanceof AttachmentCursorError) {
      return 'cursor が読めない。前回の応答の「続きは file_list cursor=…」をそのまま渡す（自分で組み立てない）。';
    }
    throw error;
  }
  const usage = renderFileUsage(await stores.attachments.usage());
  if (page.items.length === 0) {
    return `${usage}\n（この条件に合う添付は無い）`;
  }
  let cut = false;
  const body = renderListing(page.items.map(describeFileEntry), {
    budget: FILE_LIST_BUDGET,
    omitted: ({ rest, shown, total }) => {
      cut = true;
      const last = page.items[shown - 1]!;
      return (
        `…ほか ${rest} 件は省略（この呼び出しで ${total} 件取り、新しい順に ${shown} 件だけ出した）。` +
        `続きは file_list cursor=${encodeAttachmentCursor(last)} （同じ絞り込みで渡す）`
      );
    },
  });
  const more =
    !cut && page.nextCursor !== undefined
      ? `\n…まだある。続きは file_list cursor=${page.nextCursor} （同じ絞り込みで渡す）`
      : '';
  return [
    usage,
    '（控えだけ。更新は保存の印を付け外しした時刻で、一度も変えていなければ作成と同じ。中身は attachment_fetch id=<id> で取り出して Read で開ける）',
    body + more,
  ].join('\n');
}

export async function keepFile(
  stores: { readonly attachments: AttachmentStore },
  id: string,
  keep: boolean,
  now: Date,
): Promise<string> {
  const meta = await stores.attachments.setKept(id, keep, now);
  if (meta === undefined) {
    return `添付 ${id} は無い（保持期限が過ぎて消えた、または id の誤り）。`;
  }
  const label = `${meta.name}（id=${meta.id}）`;
  if (keep) {
    return `${label} に保存の印を付けた。期限なしで残る（file_delete で消すまで）。`;
  }
  return meta.keptAt !== undefined
    ? `${label} は保存中のまま（外せなかった）。`
    : `${label} は保存していない。${describeAttachmentRetention(meta)}。`;
}

/**
 * `file_delete` が消す前に日誌へ残す控えの要約（id・名前・種類・大きさ・sha256・出所・保存中だったか）。
 * **中身は書かない。** 名前は秘密ではない（資格のファイルはそもそも置き場へ入れない）。
 */
export function describeAttachmentForJournal(meta: AttachmentMeta): string {
  return [
    `id=${meta.id}`,
    `name=${meta.name}`,
    `type=${meta.mediaType}`,
    `size=${meta.size}`,
    `sha256=${meta.sha256}`,
    `出所=${FROM_LABELS[classifyAttachmentFrom(meta.uploadedBy)]}`,
    meta.keptAt === undefined ? '保存していなかった' : `保存中だった（${meta.keptAt} から）`,
  ].join(' ');
}

export async function deleteFile(
  stores: { readonly attachments: AttachmentStore },
  copiesDir: string,
  id: string,
  // 消す前に、読んだ控えを日誌へ書く口。投げたら何も消さない（消した後では、名前も大きさも辿れなくなるため）
  beforeRemove?: (meta: AttachmentMeta) => Promise<void>,
): Promise<string> {
  const meta = await stores.attachments.getMeta(id);
  if (meta !== undefined && beforeRemove !== undefined) await beforeRemove(meta);
  const removed = await stores.attachments.remove(id);
  // 写しは本体が無かったときも消す（`DELETE /attachments/:id` と同じ。本体だけ先に消えて取り残された写しを片付ける）
  await removeAttachmentCopy(copiesDir, id);
  if (!removed) {
    return `添付 ${id} は無い（保持期限が過ぎて消えた、または id の誤り）。取り出していた写しがあれば消した。`;
  }
  const what =
    meta === undefined
      ? `id=${id}`
      : `${meta.name}（id=${id}、${formatAttachmentSize(meta.size)}）`;
  return (
    `${what} の中身を消した。保存の印があっても消えている。attachment_fetch で取り出した写しも消した。取り戻せない。` +
    '消す前の控え（名前・種類・大きさ・sha256・出所）は日誌に残る。'
  );
}
