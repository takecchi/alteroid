// 会話への書き込み・添付・ファイル・会話の読み取り（task_say / file_* / reply_attach / attachment_fetch / conversation_read）の道具。
// `tools.ts` から呼ぶ（`createCloneTools` が並びのまま連結する）。このファイルから `tools.ts` を import しない（一方向）。

import { z } from 'zod';
import { fallbackAttachmentCopiesDir, fetchAttachmentCopy } from './attachment-fetch.js';
import { ATTACHMENT_FROM_CLASSES, readAttachmentLimits } from './attachment.js';
import { putLocalFile } from './file-put.js';
import {
  deleteFile,
  describeAttachmentAlreadyGoneRetraction,
  describeAttachmentForJournal,
  keepFile,
  listFiles,
} from './file-tools.js';
import {
  checkAndBindOutboundAttachments,
  releaseOutboundAttachments,
  type OutboundAttachmentResult,
} from './outbound-attachments.js';
import {
  bySpeaker,
  conversationMessages,
  decodeConversationCursor,
  encodeConversationCursor,
  humanExchanges,
  InvalidConversationCursorError,
  lookupWithdrawnForMessages,
  readConversationPage,
  readConversationWindow,
  readConversationWindowPage,
  searchExchanges,
  type ConversationCursor,
  type ConversationMessage,
  type ConversationPage,
} from './conversation.js';
import {
  describeResolvedConversationPrefix,
  describeUnresolvedConversation,
  resolveConversationId,
} from './conversation-lookup.js';
import { isTaskClosed } from './task.js';
import {
  describeUnreadableJournalTimeBoundary,
  normalizeJournalTimeBoundary,
} from './journal-time.js';
import { reasonOf } from './dropped-record.js';
import {
  describePage,
  excerptLine,
  excerptRow,
  page,
  renderListing,
  renderListingFromEnd,
} from './excerpt.js';
import type { Task, JournalEntry } from './schema.js';
import { UnreadableJournalEntryError, UnreadableTaskError } from './store.js';
import {
  describeIntRangeViolation,
  describeStringLengthViolation,
  formatIntRangeJa,
  formatStringLengthJa,
} from './tool-arg-checks.js';
import type { ToolContext, CloneToolsShared } from './clone-tools-context.js';
import {
  tool,
  text,
  appendJournalOrThrow,
  appendJournalOrDrop,
  JournalNotRecordedError,
  isSubagentCaller,
  NO_FIXED_FOLD,
  type FixedFold,
  describeUnreadableJournalEntry,
} from './clone-tools-common.js';

// `JOURNAL_*` を使い回さない: 値は同じでも探す対象（会話の1発言）が違うため
const CONVERSATION_EXCHANGE_EXCERPT = 200;

const CONVERSATION_LIST_BUDGET = 8_000;

const CONVERSATION_PAGE = 8_000;

function roleLabel(role: 'inbound' | 'outbound'): string {
  return role === 'inbound' ? '人間' : 'クローン';
}

// 取り下げた発言は外さず注記つきで出す（`GET /conversations/:id` の `delivery: 'withdrawn'` と同じ向き）。
// 印を引けなかった回は「取り下げていない」と言わない: 空の集合へ倒すと、取り下げた発言が生きた依頼に見える（#5456）
function describeWithdrawnReading(
  lookup: Awaited<ReturnType<typeof lookupWithdrawnForMessages>>,
  messages: readonly { role: 'inbound' | 'outbound'; clientMessageId?: string | undefined }[],
  // 予算で省いた行を含めて数えるので、実際に表示した行（`messages` の一部）を渡せば「うち表示 k 件」を添える。1件を id で読む回は `single`
  options: {
    shown?: readonly { role: 'inbound' | 'outbound'; clientMessageId?: string | undefined }[];
    single?: boolean;
  } = {},
): {
  isWithdrawn: (message: { clientMessageId?: string | undefined }) => boolean;
  notes: string[];
} {
  const shownOf = (
    count: (message: {
      role: 'inbound' | 'outbound';
      clientMessageId?: string | undefined;
    }) => boolean,
  ): string =>
    options.shown === undefined || options.shown.length === messages.length
      ? ''
      : `（省いた行を含む数。うち表示 ${options.shown.filter(count).length} 件）`;
  const isHumanSendable = (message: {
    role: 'inbound' | 'outbound';
    clientMessageId?: string | undefined;
  }): boolean => message.role === 'inbound' && message.clientMessageId !== undefined;
  if (lookup.kind === 'unknown') {
    const unverifiable = messages.filter(isHumanSendable).length;
    return {
      isWithdrawn: () => false,
      notes: [
        `（取り下げの有無を判定できなかった: 取り下げの印を日誌から読めなかった（${lookup.reason}）。` +
          (options.single
            ? 'この発言は、取り下げていないとは言えない。'
            : `人間の発言 ${unverifiable} 件${shownOf(isHumanSendable)}は、取り下げていないとは言えない。`) +
          'クローンへ届いていない発言が混じっているかもしれないので、実行の根拠にする前に人間へ確かめること）',
      ],
    };
  }
  const ids = lookup.ids;
  const isWithdrawn = (message: { clientMessageId?: string | undefined }): boolean =>
    message.clientMessageId !== undefined && ids.has(message.clientMessageId);
  const count = messages.filter(
    (message) => message.role === 'inbound' && isWithdrawn(message),
  ).length;
  return {
    isWithdrawn,
    notes:
      count === 0
        ? []
        : [
            options.single
              ? '（この発言は、人間が送ったあとクローンへ届く前に取り下げたもので、クローンへは届いていない。依頼として扱わないこと）'
              : `（取り下げた発言が ${count} 件${shownOf((message) => message.role === 'inbound' && isWithdrawn(message))}ある。人間が送ったあとクローンへ届く前に取り下げたもので、` +
                'クローンへは届いていない。依頼として扱わないこと。会話の一覧の件数はこれを除いて数えるので、' +
                'ここに出ている行数とは合わない）',
          ],
  };
}

const WITHDRAWN_MESSAGE_MARK = '（取り下げた発言。クローンへは届いていない）';

// 中身は出さない: `conversation_read` は一覧の道具で、中身は別の取り口に回すため。名前は抜粋にする: 255 文字まで入り、10 個並べても溢れない長さへ締めるため
function attachmentLines(
  attachments: readonly { id: string; name: string; mediaType: string; size: number }[] | undefined,
  indent: string,
): string {
  if (attachments === undefined || attachments.length === 0) return '';
  return (
    `\n${indent}[添付 ${attachments.length}件]` +
    attachments
      .map(
        (a) =>
          `\n${indent}  id=${a.id} name=${excerptLine(a.name, 80)} type=${a.mediaType} size=${a.size}`,
      )
      .join('') +
    `\n${indent}  （attachment_fetch id=<id> で取り出して Read で開ける）`
  );
}

export function attachTools(context: ToolContext, shared: CloneToolsShared) {
  const { stores, getConversationId } = shared;
  return [
    // いまのターンの会話そのものへは書かない: ターンの返答が届くので、道具で書くと同じ画面に返答が2通並ぶため
    // 宛先は task の起点の会話に固定する（会話 id の引数・新規会話の生成は持たない）。閉じた task にも書ける（報告を後から出すため）
    tool(
      'task_say',
      [
        'task の起点の会話へ1通書く。宛先は task の起点の会話に固定で、会話 id は選べない。いまのターンが人間の発言で起きたものでなくても届く（定期の仕事・外部イベント・委譲の報告を人間へ知らせる口）。',
        '閉じた task にも書ける（報告を後から出すため）。',
        'task が無い、または起点の会話を持たない古い task なら、何も書かずに断る（古い task は task_add で足し直す）。',
        'いまのターンの会話へは書けない（そこへは普通に返答すれば届く。添付なら reply_attach）。',
        '知らせるだけで、答えは待たない。確認や承認が要るなら ask_human を使うこと。',
        '人間へファイルを渡すなら、先に file_put で置き場へ入れ、その id を attachments に渡す（添付があれば text は空でもよい。どちらも空の発言は書かない）。',
        '添付の検査（存在・個数・合計の上限）に1つでも落ちたら、何も書かずに断る。',
        '知らせるためだけに足した task は、書いたら done にして閉じる。続ける仕事の task は、書いた会話が返答に数えられて器が自動で done にしないよう、task_keep で「続く」の印を付ける（queued で印の無い task は、このターンの終わりに自動で done になりうる）。',
        '日誌には人間との往復（あなたの発言）として残る。',
      ].join(' '),
      {
        taskId: z
          .string()
          .describe(
            `書く先の task の id（task_list に出ている id。閉じた件も可。${formatStringLengthJa({ min: 1 })}）`,
          ),
        text: z
          .string()
          .optional()
          .describe(
            `人間へ届ける本文（添付が無いとき必須。${formatStringLengthJa({ min: 1 })}。添付があれば省略か空でもよい）`,
          ),
        attachments: z
          .array(z.string().min(1))
          .optional()
          .describe(
            '添える添付の id（file_put の応答の id）。1発言に添えられる個数・合計には人間の発言と同じ上限がある。' +
              'どこにも結ばれていない添付は、この発言の会話へ結ばれる',
          ),
      },
      async ({ taskId, text: rawBody, attachments: attachmentIds }) => {
        const withAttachments = attachmentIds !== undefined && attachmentIds.length > 0;
        if (!withAttachments) {
          if (rawBody === undefined) {
            return text('text か attachments のどちらかが要る（どちらも空の発言は書かない）。');
          }
          const textError = describeStringLengthViolation('text', rawBody, { min: 1 });
          if (textError !== null) return text(textError);
        }
        const body = rawBody ?? '';
        const taskIdError = describeStringLengthViolation('taskId', taskId, { min: 1 });
        if (taskIdError !== null) return text(taskIdError);
        let task: Task | null;
        try {
          task = await stores.tasks.get(taskId);
        } catch (error) {
          if (error instanceof UnreadableTaskError) {
            return {
              ...text(`task ${taskId} は読めない形で入っている。何も書かなかった。`),
              isError: true,
            };
          }
          throw error;
        }
        if (task === null) {
          return {
            ...text(
              `task ${taskId} は無いので、何も書かなかった（task_list で実在する id を確かめること）。`,
            ),
            isError: true,
          };
        }
        const target = task.originConversationId;
        if (target === undefined) {
          return {
            ...text(
              `task ${taskId} は起点の会話を持たない古い task なので、何も書かなかった。task_add で足し直すと起点の会話が付く。`,
            ),
            isError: true,
          };
        }
        // 解決を挟まず、そのままの一致で断る: いまのターンの会話は、1通目がまだ日誌に載っていないことがあるため
        if (target === getConversationId()) {
          return {
            ...text(
              `task ${taskId} の起点の会話 ${target} はいまのターンの会話なので、この道具では書かなかった。` +
                (withAttachments
                  ? 'このターンの返答に添付を添えるなら reply_attach を使う。'
                  : 'このターンの返答として書けば、その会話へ届く。'),
            ),
            isError: true,
          };
        }
        const attached = withAttachments
          ? await checkAndBindOutboundAttachments(stores, attachmentIds, {
              conversationId: target,
              limits: context.attachmentLimits ?? readAttachmentLimits().limits,
            })
          : ({ ok: true, refs: [], newlyBound: [] } satisfies OutboundAttachmentResult);
        if (!attached.ok) return text(`会話へは書かなかった。${attached.message}`);
        let entry;
        try {
          entry = await appendJournalOrThrow(
            'task_say',
            stores.journal,
            {
              type: 'exchange',
              with: 'human',
              role: 'outbound',
              text: body,
              conversationId: target,
              ...(attached.refs.length === 0 ? {} : { attachments: attached.refs }),
            },
            'act-not-performed',
          );
        } catch (error) {
          // 書けなかった発言に添付を結んだままにしない: 結んだままだと、掃除が未結び付けとして消す前に1時間ぶん居座る
          await releaseOutboundAttachments(stores, attached.newlyBound, target).catch(
            () => undefined,
          );
          throw error;
        }
        context.noteTaskSaid?.(taskId);
        if (attached.refs.length === 0) context.postToConversation?.(target, body);
        else context.postToConversation?.(target, body, attached.refs);
        const withNote =
          attached.refs.length === 0 ? '' : `（添付 ${attached.refs.length} 件つき）`;
        return text(
          `task ${taskId} の起点の会話 ${target} へ書いた${withNote}（${entry.id}）。` +
            (!isTaskClosed(task.status)
              ? '\n知らせるだけの task なら task_set_status で done にすること。'
              : ''),
        );
      },
    ),

    tool(
      'file_put',
      [
        'あなたの手元（デーモンの側）のファイルを、添付の置き場へ入れる。人間へファイルを渡す最初の段で、',
        '返る id を reply_attach（いまのターンの返信に添える）か task_say の attachments（task の起点の会話へ書く）に渡すと、人間の画面に添付として出る。',
        '返信に添えるまで、この添付はどこにも結ばれていないので **1時間で消える**。入れたらすぐ添えること。',
        '後で使うために取っておくなら keep: true で入れる（保存の印つき。期限なし・1時間の掃除にも掛からない。消えるのは file_delete したときだけ）。入れた後から付けるなら file_keep、置き場の一覧は file_list。',
        '通常のファイルだけ入れられる（ディレクトリ・特殊ファイルは断る）。大きさの上限は人間の添付と同じ（その他の上限を超えるものは読まずに断る）。画像の上限を超える画像は、画像ではなくファイル（application/octet-stream）として入れる（人間はダウンロードして開く）。',
        '画像は中身（先頭の印）が拡張子の種類と一致しないと断る。種類は拡張子から推す（分からなければ application/octet-stream）。',
        '**資格・鍵を含むファイルは入れない**: ALTEROID_CREDENTIAL_DIR の配下と、名前が _FILE で終わる環境変数が指すファイルは断る。',
        '人間に送ってよい内容かは、入れる前に自分で確かめること。',
      ].join(' '),
      {
        path: z.string().min(1).describe('入れるファイルの絶対パス（デーモンの側のファイル）'),
        name: z
          .string()
          .min(1)
          .optional()
          .describe('人間の画面に出す名前。省略するとファイル名。種類もこの名前の拡張子から推す'),
        keep: z
          .boolean()
          .optional()
          .describe(
            'true なら保存の印つきで入れる（期限なし・1時間の掃除にも掛からない）。既定 false',
          ),
      },
      async ({ path, name, keep }) => {
        const result = await putLocalFile(
          stores,
          { path, ...(name === undefined ? {} : { name }), ...(keep === true ? { keep } : {}) },
          { limits: context.attachmentLimits ?? readAttachmentLimits().limits, env: process.env },
        );
        if (!result.ok) return { ...text(result.message), isError: true };
        const { ref } = result;
        return text(
          `置き場へ入れた。id=${ref.id}\nname=${ref.name} type=${ref.mediaType} size=${ref.size} sha256=${ref.sha256}\n` +
            (result.note === undefined ? '' : `${result.note}\n`) +
            (keep === true
              ? '保存の印つきで入れた（期限なし・1時間の掃除にも掛からない。消すのは file_delete）。' +
                '人間へ渡すなら reply_attach か task_say の attachments に id を渡す。'
              : '会話に添える（reply_attach、または task_say の attachments）まで、この添付は1時間で消える。' +
                '取っておくなら file_keep id=<id> keep=true。'),
        );
      },
    ),

    tool(
      'file_list',
      [
        '添付の置き場の控えの一覧（新しい順）と、置き場の使用量（合計と出所ごと）を返す。**中身は読まない**（中身は attachment_fetch で取り出して Read で開ける）。',
        '1行に id・名前・種類・大きさ・出所・保存中か期限・作成日時が出る。',
        `絞り込み: kept（true＝保存中だけ・false＝保存していないものだけ）、from（${ATTACHMENT_FROM_CLASSES.join(' / ')}。上げた主体の分類）、conversationId、query（名前の部分一致）。`,
        '文字数の予算で締めるので、切れたら末尾に「続きは file_list cursor=…」が出る。その cursor を同じ絞り込みでそのまま渡すと続きが読める。',
        '期限切れで消えたものは出ない。保存した添付に期限も全体の容量の上限も無いので、使用量を見て要らないものは file_delete で消すこと。',
      ].join(' '),
      {
        kept: z.boolean().optional().describe('true＝保存中だけ・false＝保存していないものだけ'),
        from: z
          .enum(ATTACHMENT_FROM_CLASSES)
          .optional()
          .describe('上げた主体の分類（人間・クローン・マネージャー・連携の鍵・不明）'),
        conversationId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'この会話に結ばれた添付だけ（完全な id か、1つの会話に決まる 8 文字以上の先頭）',
          ),
        query: z.string().min(1).optional().describe('名前の部分一致（大文字小文字を問わない）'),
        cursor: z
          .string()
          .min(1)
          .optional()
          .describe('続きの位置。前回の応答の「続きは file_list cursor=…」をそのまま渡す'),
      },
      async ({ kept, from, conversationId: conversationIdInput, query, cursor }) => {
        try {
          // 一意に決まる 8 文字以上の前方一致だけ読み替える（#5130）。当たらない id は今どおりそのまま絞る
          let conversationId = conversationIdInput;
          let resolvedNote = '';
          if (conversationIdInput !== undefined) {
            const resolution = await resolveConversationId(stores.journal, conversationIdInput);
            if (resolution.kind === 'ambiguous') {
              return text(
                `置き場の一覧は読んでいない。${describeUnresolvedConversation(conversationIdInput, resolution)}`,
              );
            }
            if (resolution.kind === 'prefix') {
              conversationId = resolution.id;
              resolvedNote = `${describeResolvedConversationPrefix(conversationIdInput, resolution.id)}\n`;
            }
          }
          return text(
            resolvedNote + (await listFiles(stores, { kept, from, conversationId, query, cursor })),
          );
        } catch (error) {
          return text(
            `置き場の一覧を読めなかった: ${reasonOf(error)}（もう一度試すと直る場合がある）`,
          );
        }
      },
    ),

    tool(
      'file_keep',
      [
        '添付に保存の印を付ける／外す。保存中の添付は保持期限（既定30日）でも、未結び付け1時間の掃除でも消えない（期限なし。全体の容量の上限も無い）。',
        'keep: true で付ける。keep: false で外す（外した時刻から保持日数後に期限が入る。応答にいつ消えるかが出る）。',
        '無い id（期限切れで消えた・id の誤り）は「無い」と返る。',
        '人間が保存した添付の印も外せるが、人間の持ち物を変える行為なので、外すのは要らないと判断できるときだけ。この操作（道具の使用と id）は日誌に残る。',
      ].join(' '),
      {
        id: z.string().min(1).describe('添付の id（file_list / file_put の応答）'),
        keep: z.boolean().describe('true＝保存の印を付ける・false＝外す'),
      },
      async ({ id, keep }) => {
        try {
          return text(await keepFile(stores, id, keep, new Date()));
        } catch (error) {
          return text(
            `添付 ${id} の保存の印を変えられなかった: ${reasonOf(error)}（もう一度試すと直る場合がある）`,
          );
        }
      },
    ),

    tool(
      'file_delete',
      [
        '添付の中身と控えを消す。**保存の印が付いていても消える。取り戻せない。** 人間の持ち物でも消せるので、要らないと判断できるときだけ。',
        'その id を attachment_fetch で取り出した写しも消す。すでに会話へ添えた添付を消すと、画面の添付は開けなくなる。',
        '**消す前に**、その控え（id・名前・種類・大きさ・sha256・出所・保存中だったか。中身は書かない）を日誌へ書く。日誌に書けなければ何も消さない（やり直してよい）。',
        '控えが読めなかった無い id（期限切れで消えた・id の誤り）は「無い」と返り、日誌には何も書かない。控えを読んだ後に消えていたときは、消す行と打ち消しの行が日誌に残る。',
        '外部の置き場に預けた中身は先に消す。置き場から消せなかったときは「消していない」と理由が返り（控えも写しも残る）、日誌に断った旨の行が足される。もう一度呼ぶと再試行する。',
      ].join(' '),
      {
        id: z.string().min(1).describe('消す添付の id（file_list / file_put の応答）'),
      },
      async ({ id }) => {
        try {
          return text(
            await deleteFile(
              stores,
              context.attachmentCopiesDir ?? fallbackAttachmentCopiesDir(),
              id,
              async (meta) => {
                // 消した後では名前も大きさも辿れないので、先に書く。書けなければ投げて、何も消さない（`act-not-performed`）
                await appendJournalOrThrow(
                  'file_delete',
                  stores.journal,
                  {
                    type: 'decision',
                    decision: `添付の中身と控えを消す: ${meta.name}（id=${meta.id}）`,
                    grounds: `消す前の控え: ${describeAttachmentForJournal(meta)}`,
                  },
                  'act-not-performed',
                );
              },
              async (meta, reason) => {
                // 断った後に足す行: 先に書いた「消す」の行だけでは、日誌が消したように読める。書けなくても断りの結果は変えない
                await appendJournalOrDrop('file_delete', stores.journal, {
                  type: 'decision',
                  decision: `添付の中身を置き場から消せなかったので、消していない（控えも残した）: ${meta === undefined ? `id=${id}` : `${meta.name}（id=${meta.id}）`}`,
                  grounds: `理由: ${reason}。直前の「消す」の行は実行されていない。もう一度 file_delete で再試行できる。`,
                });
              },
              async (meta) => {
                // 控えを読んだ後に別の手で消えていた回: 先に書いた「消す」の行はこの呼びでは実行されていない。書けなくても「無い」の結果は変えない
                await appendJournalOrDrop('file_delete', stores.journal, {
                  type: 'decision',
                  ...describeAttachmentAlreadyGoneRetraction(meta),
                });
              },
            ),
          );
        } catch (error) {
          if (error instanceof JournalNotRecordedError) throw error;
          return text(
            `添付 ${id} を消せなかった: ${reasonOf(error)}（もう一度試すと直る場合がある）`,
          );
        }
      },
    ),

    tool(
      'reply_attach',
      [
        '**いまのターンの返信**に添付を添える。人間の発言で起きたターン（会話のあるターン）で使い、返信の本文とは別に、画面の返信に添付が付く。',
        'ids は file_put の応答の id（または人間が添えた添付の id）。1件以上。',
        '同じターンで複数回呼んでも、個数・合計は合わせて数える（人間の1発言と同じ上限）。1つでも検査に落ちたら、何も添えずに、どれがなぜかを返す。',
        'どこにも結ばれていない添付はこの会話へ結ばれる。すでに別の会話に結ばれている添付は結び直さず、そのまま添える。',
        '本文が空で添付だけの返信でも、返信として残る。',
        'いまのターンに会話が無いとき（定期の仕事・外部イベントが起点で返信先が無い）は使えない。task の起点の会話へ渡すなら task_say の attachments を使う。',
        '資格・鍵を含むファイルは添えないこと。',
      ].join(' '),
      {
        ids: z
          .array(z.string().min(1))
          .min(1)
          .describe('添える添付の id（file_put の応答の id）。1件以上'),
      },
      async ({ ids }) => {
        const conversationId = getConversationId();
        if (conversationId === undefined) {
          return {
            ...text(
              'いまのターンには返信先の会話が無いので、返信には添えられない（何も添えていない）。' +
                '人間へ渡すなら task_say の attachments に id を渡す。',
            ),
            isError: true,
          };
        }
        const slot = context.replyAttachments;
        if (slot === undefined) {
          return {
            ...text('この器では返信に添付を添えられない（何も添えていない）。'),
            isError: true,
          };
        }
        const attached = await checkAndBindOutboundAttachments(stores, ids, {
          conversationId,
          limits: context.attachmentLimits ?? readAttachmentLimits().limits,
          alreadyAttached: slot.current(),
        });
        if (!attached.ok) return { ...text(attached.message), isError: true };
        if (attached.refs.length === 0) {
          return text('指された添付はすでにこの返信に添えてある');
        }
        slot.add(attached.refs);
        return text(
          `この返信に添付 ${attached.refs.length} 件を添えた: ` +
            attached.refs.map((ref) => `${ref.name}（id=${ref.id}）`).join(', ') +
            `。このターンの返信には合計 ${slot.current().length} 件ついている。`,
        );
      },
    ),

    tool(
      'attachment_fetch',
      [
        '人間が会話に添えた添付（画像・動画・PDF・ログなど）の中身を、デーモンの手元のファイルへ取り出す。',
        'id は発言の通知行（[添付] id=…）か conversation_read の [添付 n件] にある。',
        '返るパスを **Read で開ける**（クローンの作業ディレクトリの中に置く）。動画は置いて取り出せるところまで（コマ切り出しはしない）。',
        '同じ中身（sha256 が同じ）の写しが既にあれば書き直さず使い回す。',
        '**取り出したものは写し**で、正本ではない。器が作り直される・一定時間（24時間）たつと消えうる。必要なら再度取り出す。',
        '添付は保持期限（既定30日）を過ぎる・未結び付けのまま1時間たつと消える。そのときは「見つからない」と返る。',
        '**中身は記憶にも日誌にも写さない**（日誌に残るのは道具の使用の記録だけ）。要る事実は自分の言葉で記憶へ書く。',
      ].join(' '),
      {
        id: z.string().min(1).describe('添付の id（通知行の id=… / conversation_read の添付行）'),
      },
      async ({ id }) => {
        try {
          const result = await fetchAttachmentCopy(
            stores,
            context.attachmentCopiesDir ?? fallbackAttachmentCopiesDir(),
            id,
          );
          if (!result.ok) {
            return text(
              result.reason === 'not_found'
                ? `添付 ${id} は見つからない（保持期限が過ぎて消えた、または id の誤り）。人間に再送を頼む。`
                : result.reason === 'mismatch'
                  ? `添付 ${id} は取り出せなかった（置き場から読んだ中身が、控えの大きさか sha256 と合わない。途中で切れたか壊れている。写しは残していない。もう一度試すと直る場合がある）。`
                  : `添付 ${id} は取り出せない（置き場が返した id か名前が、置き場所の外へ出る形だった）。`,
            );
          }
          const { copy } = result;
          return text(
            `添付 ${id} を取り出した${copy.reused ? '（既にあった写しを使い回した）' : ''}。` +
              `Read で開ける。\npath=${copy.path}\nname=${copy.name} type=${copy.mediaType} ` +
              `size=${copy.size} sha256=${copy.sha256}`,
          );
        } catch (error) {
          return text(
            `添付 ${id} を取り出せなかった: ${reasonOf(error)}（もう一度試すと直る場合がある）`,
          );
        }
      },
    ),

    tool(
      'conversation_read',
      [
        '人間との会話を日誌から読み返す。要約に潰された後でも逐語はここに残っている。',
        'conversationId を指定するとその会話の中身を古い順に読める。',
        'q だけを指定すると窓の中を語で探す（新しい順）。',
        '何も指定しなければ会話の一覧（新しい順）。',
        '一覧が limit・文字数の予算・scan の窓で切れたら、末尾に「続きを読むには: conversation_read cursor=…」が出るので、' +
          'その cursor をそのまま渡すと続き（limit の上限 200 や窓の外も含む）から読める。続きが無ければ出ない。' +
          'GET /conversations（人間の口）と同じ cursor である。',
        '人間自身の発言だけを見るなら speaker: "human" を指定する',
        '（既定 both は人間とクローンの両方の発言を含む）。',
        '一覧の本文は抜粋で、全文が要る1件は id を渡して取る。',
        '人間は送信済みの発言を編集できる（チャットの「メッセージを編集する」機能）。' +
          'conversationId を指定した既定の応答は編集後の版だけを返すが、畳まれた版が' +
          '在れば件数を注記する。旧版と旧版への応答も読むには includeSuperseded: true を指定する。',
        '人間が送ったあとクローンへ届く前に取り下げた発言は、conversationId・q の読みでは外さず「（取り下げた発言。クローンへは届いていない）」と付けて出す（依頼として扱わない。会話の一覧の件数はこれを除く）。取り下げの印を読めなかった回は、有無を判定できなかったと言う。',
        '**ここに出ないもの**（知らずに引くと「無かった」と読むので、先に言う）:',
        '① **ask_human への人間の回答は、この道具では出ない。**',
        '回答の本文は日誌の escalation にしか無いので journal_read types=["escalation"] で読むこと',
        '（approvals_list の一覧モードは**まだ答えが来ていない件**だけを出すが、id を渡す全文モードは答えが付いた件も開けて、回答の本文もそこに出る）。',
        '② 人間がマネージャーへ直接話しかけた発言も出ない',
        '（日誌には with:"manager" として載り、あなた自身の指示と見分けが付かない）。',
        '**ここに出るもの**: 発言に添付があれば「[添付 n件]」と各添付の id・name・type・size（メタデータだけ）。',
        '**添付の中身はここには出ない**（画像は届いたターンでだけ画像として渡される）。',
        '画像・動画・PDF・ログなど**どの添付も、attachment_fetch id=<添付の id> で手元に取り出して Read で開ける**（動画は置いて取り出せるところまで）。',
      ].join(' '),
      {
        conversationId: z
          .string()
          .optional()
          .describe(
            'この会話の中身を古い順に読む（一覧に出ている conversationId か、1つの会話に決まる 8 文字以上の先頭）',
          ),
        q: z
          .string()
          .optional()
          .describe('語で探す（大文字小文字を区別しない部分一致）。conversationId と併用できる'),
        speaker: z
          .enum(['human', 'clone', 'both'])
          .optional()
          .describe('既定 both。human で人間自身の発言だけ（clone はクローンの返答だけ）'),
        since: z
          .string()
          .optional()
          .describe('ISO 8601。この時刻以降だけ返す（例 2026-08-15T09:00:00Z）'),
        until: z
          .string()
          .optional()
          .describe('ISO 8601。この時刻以前だけ返す。過去を掘るときはこれを指定する'),
        scan: z
          .number()
          .optional()
          .describe(
            `人間との往復を何件遡るか（${formatIntRangeJa({ min: 1, max: 10_000 })}。既定 2000。マネージャーとの往復・内部ターンは` +
              '数えない。conversationId を指定したときは、その会話の人間との往復だけを数える）。遡り切れたかは応答の注記で分かる',
          ),
        limit: z
          .number()
          .optional()
          .describe(
            `一覧モードで返す会話の本数（${formatIntRangeJa({ min: 1, max: 200 })}。既定 20）。conversationId / q のときは効かない`,
          ),
        cursor: z
          .string()
          .optional()
          .describe(
            '一覧モードの続きを読む位置。前回の応答の末尾「続きを読むには」に出た cursor をそのまま渡す' +
              '（自分で組み立てない。GET /conversations の nextCursor と同じもの）。' +
              '同じ since / until を付けて呼ぶこと。conversationId / q のときは効かない',
          ),
        id: z
          .string()
          .optional()
          .describe('この発言1件を全文で読む（一覧に出ている id）。他の条件は無視される'),
        offset: z
          .number()
          .optional()
          .describe(`id で全文を読むとき、何文字目から読むか（${formatIntRangeJa({ min: 0 })}）`),
        includeSuperseded: z
          .boolean()
          .optional()
          .describe(
            '既定 false。true にすると、チャットで編集され既定ビューから畳まれた旧発言・' +
              'それに対する応答も conversationId のときに含めて返す（各発言に supersedes / ' +
              'supersededBy が付く）。false のままでも、畳まれた版が在れば件数を注記する',
          ),
      },
      async (
        {
          conversationId: conversationIdInput,
          q,
          speaker = 'both',
          since: sinceInput,
          until: untilInput,
          scan,
          limit,
          cursor: cursorInput,
          id,
          offset = 0,
          includeSuperseded = false,
        },
        extra: unknown,
      ) => {
        const fold = isSubagentCaller(context, extra)
          ? NO_FIXED_FOLD
          : (context.foldFixed ?? NO_FIXED_FOLD);
        const argViolation = describeConversationReadArgViolation(scan, limit, offset);
        if (argViolation !== null) return text(argViolation);
        // 読み方 1: id（1発言の全文）
        if (id !== undefined)
          return text(await readConversationEntryText(stores.journal, id, offset));

        const boundaries = readJournalTimeBoundaries(sinceInput, untilInput);
        if (boundaries.kind === 'refused') return text(boundaries.body);
        const { since, until } = boundaries;
        const target = await resolveConversationReadTarget(stores.journal, conversationIdInput);
        if (target.kind === 'refused') return text(target.body);
        const { conversationId, resolvedNoteLines } = target;

        const scanLimit = scan ?? 2000;
        const listMode = conversationId === undefined && q === undefined;
        const decodedCursor = decodeConversationListCursor(listMode, cursorInput);
        if (decodedCursor.kind === 'refused') return text(decodedCursor.body);
        const { cursor } = decodedCursor;
        const read = await readConversationReadWindow(stores.journal, {
          listMode,
          limit,
          scanLimit,
          cursor,
          conversationId,
          since,
          until,
        });
        if (read.kind === 'refused') return text(read.body);
        const { listPage, entries, scannedCount, exhausted } = read;
        // `since` を渡されたら「先頭に届いた」と言わない: `reachedStart` は行を出し切ったかだけで、`since` は LIMIT より先に効くため、混ぜると `since` より古い側に在りうるものを「無い」と言い切る
        const reached = exhausted && since === undefined;
        const view: ConversationReadView = {
          conversationId,
          reached,
          scanNote: describeConversationScanNote({
            conversationId,
            listMode,
            scannedCount,
            exhausted,
            reached,
            since,
          }),
          resolvedNoteLines,
          cursorIgnoredNote: describeCursorIgnoredNote(listMode, cursorInput),
        };

        // 読み方 2: conversationId（1つの会話を古い順に）
        if (conversationId !== undefined) {
          return text(
            await readConversationMessagesText(
              stores.journal,
              entries,
              conversationId,
              { speaker, q, includeSuperseded },
              view,
              fold,
            ),
          );
        }
        // 読み方 3: q（会話をまたぐ検索）
        if (q !== undefined) {
          return text(
            await readConversationSearchText(stores.journal, entries, q, speaker, view, fold),
          );
        }
        // 読み方 4: 一覧。`speaker` が効かないことを黙らない（一覧の関数が注記する）
        return text(
          readConversationListText(
            listPage as ConversationPage,
            { limit, scan, sinceInput, untilInput, speaker, cursor },
            view,
            fold,
          ),
        );
      },
    ),
  ];
}

// ---- `conversation_read` の出力を部分ごとに組む関数 ----
// 読み方は4つ（1発言の全文＝`id`、1つの会話＝`conversationId`、会話をまたぐ検索＝`q`、一覧）。読み方ごとに1つの関数があり、その中を行・注記・予算の詰めの関数に分ける。
// 各関数は出力の1つの部分を文字列（または行の配列）で返す。`conversation_read` の式は引数を読み、読み方を選んで、その結果を返すだけにする。
// `fold` は呼んだ時点で「会話に出した」と控える: 呼ぶ順と回数を変えないこと（呼び出し側の並びがそのまま控えへの書き込みの順になる）。

type ConversationReadJournal = CloneToolsShared['stores']['journal'];
type ConversationWindowEntries = Awaited<ReturnType<typeof readConversationWindow>>;
type ConversationListed = ConversationPage['conversations'][number];

/** 窓を読み終えたあとの、どの読み方にも共通な事実（窓が先頭に届いたか・窓の注記・名指した会話）。 */
interface ConversationReadView {
  conversationId: string | undefined;
  reached: boolean;
  scanNote: string;
  resolvedNoteLines: string[];
  cursorIgnoredNote: string[];
}

/** 一覧の読みが、渡された絞りを続きの呼びへ付け直すために持つ値。 */
interface ConversationListRequest {
  limit: number | undefined;
  scan: number | undefined;
  sinceInput: string | undefined;
  untilInput: string | undefined;
  speaker: 'human' | 'clone' | 'both';
  cursor: ConversationCursor | undefined;
}

/** 入力の検査と早期の戻り: scan・limit・offset が範囲を外れているときの全文（無ければ null）。 */
function describeConversationReadArgViolation(
  scan: number | undefined,
  limit: number | undefined,
  offset: number,
): string | null {
  const scanError = describeIntRangeViolation('scan', scan, { min: 1, max: 10_000 });
  if (scanError !== null) return scanError;
  const limitError = describeIntRangeViolation('limit', limit, { min: 1, max: 200 });
  if (limitError !== null) return limitError;
  const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
  if (offsetError !== null) return offsetError;
  return null;
}

// ---- 読み方 1: id（1発言の全文） ----

/** `id` で1発言を全文で読む回の全文（無い・会話の発言でない回の案内も含む）。 */
async function readConversationEntryText(
  journal: ConversationReadJournal,
  id: string,
  offset: number,
): Promise<string> {
  let entry: JournalEntry | null;
  try {
    entry = await journal.get(id);
  } catch (error) {
    if (error instanceof UnreadableJournalEntryError)
      return describeUnreadableJournalEntry('発言', id);
    throw error;
  }
  if (!entry) return `発言 ${id} は無い（id が違うか、まだ書かれていない）。`;
  if (entry.type !== 'exchange' || entry.with !== 'human') {
    return `${id} は会話の発言ではない。日誌の中身を見るなら journal_read id=${id} を使うこと。`;
  }
  // 一覧は本文を抜粋して「全文は id で取れる」と案内するので、案内先でも取り下げを言う: 言わないと長い取り下げ済みの指示が生きた依頼に見える（#5456）。続きの頁（offset）でも毎回引く
  const withdrawnReading = describeWithdrawnReading(
    await lookupWithdrawnForMessages(journal, entry.conversationId, [entry]),
    [entry],
    { single: true },
  );
  const part = page(entry.text, offset, CONVERSATION_PAGE);
  return (
    `${entry.at} [${roleLabel(entry.role)}] id=${entry.id}` +
    (entry.role === 'inbound' && withdrawnReading.isWithdrawn(entry)
      ? WITHDRAWN_MESSAGE_MARK
      : '') +
    `（${describePage(part)}）` +
    `\n\n${part.body}${describeEntryPageTail(entry, part)}${attachmentLines(entry.attachments, '')}` +
    withdrawnReading.notes.map((note) => `\n${note}`).join('')
  );
}

/** 全文の頁の末尾: 続きがあるときだけ、続きの取り方（offset）を言う。 */
function describeEntryPageTail(entry: JournalEntry, part: ReturnType<typeof page>): string {
  return part.more
    ? `\n\n…（ここで切れている。続きは conversation_read id=${entry.id} offset=${part.to}）`
    : '';
}

// ---- 窓を読む前の共通部分（時刻の境界・会話 id・cursor・窓の読み） ----

/** since/until を正規化する: `journal_read` と同じ穴を持つため。読めない境界なら断りの全文を返す。 */
function readJournalTimeBoundaries(
  sinceInput: string | undefined,
  untilInput: string | undefined,
):
  | { kind: 'ok'; since: string | undefined; until: string | undefined }
  | { kind: 'refused'; body: string } {
  if (sinceInput !== undefined && normalizeJournalTimeBoundary(sinceInput) === null) {
    return {
      kind: 'refused',
      body: describeUnreadableJournalTimeBoundary('since', sinceInput) + '**会話は読んでいない。**',
    };
  }
  if (untilInput !== undefined && normalizeJournalTimeBoundary(untilInput) === null) {
    return {
      kind: 'refused',
      body: describeUnreadableJournalTimeBoundary('until', untilInput) + '**会話は読んでいない。**',
    };
  }
  const since =
    sinceInput === undefined ? undefined : (normalizeJournalTimeBoundary(sinceInput) ?? undefined);
  const until =
    untilInput === undefined ? undefined : (normalizeJournalTimeBoundary(untilInput) ?? undefined);
  return { kind: 'ok', since, until };
}

/** 一意に決まる 8 文字以上の前方一致だけ読み替える（#5130）。曖昧なときは断りの全文を返す。 */
async function resolveConversationReadTarget(
  journal: ConversationReadJournal,
  conversationIdInput: string | undefined,
): Promise<
  | { kind: 'ok'; conversationId: string | undefined; resolvedNoteLines: string[] }
  | { kind: 'refused'; body: string }
> {
  // 当たらない id は今どおり窓の中で読み、「無い／この窓には無い」で答える（解決できなかったことでは断らない）
  let conversationId = conversationIdInput;
  const resolvedNoteLines: string[] = [];
  if (conversationIdInput !== undefined) {
    const resolution = await resolveConversationId(journal, conversationIdInput);
    if (resolution.kind === 'ambiguous') {
      return {
        kind: 'refused',
        body: `会話は読んでいない。${describeUnresolvedConversation(conversationIdInput, resolution)}`,
      };
    }
    if (resolution.kind === 'prefix') {
      conversationId = resolution.id;
      resolvedNoteLines.push(
        describeResolvedConversationPrefix(conversationIdInput, resolution.id),
      );
    }
  }
  return { kind: 'ok', conversationId, resolvedNoteLines };
}

/** 一覧の読みの cursor を解く。壊れていれば断りの全文を返す（一覧以外では cursor は読まない）。 */
function decodeConversationListCursor(
  listMode: boolean,
  cursorInput: string | undefined,
): { kind: 'ok'; cursor: ConversationCursor | undefined } | { kind: 'refused'; body: string } {
  if (listMode && cursorInput !== undefined) {
    const decoded = decodeConversationCursor(cursorInput);
    if (decoded === null) {
      return {
        kind: 'refused',
        body:
          'cursor が壊れている（この道具か GET /conversations が返したものではないか、書き換えられている）。' +
          'cursor は前回の応答の「続きを読むには」に出たものをそのまま渡すこと（自分で組み立てない）。' +
          '先頭から読み直すなら cursor を省いて呼ぶこと。**会話は読んでいない。**',
      };
    }
    return { kind: 'ok', cursor: decoded };
  }
  return { kind: 'ok', cursor: undefined };
}

/** 窓の読み。一覧は頁で、それ以外は窓の発言で返す。継続点が指す発言が見当たらないときは断りの全文を返す。 */
async function readConversationReadWindow(
  journal: ConversationReadJournal,
  params: {
    listMode: boolean;
    limit: number | undefined;
    scanLimit: number;
    cursor: ConversationCursor | undefined;
    conversationId: string | undefined;
    since: string | undefined;
    until: string | undefined;
  },
): Promise<
  | {
      kind: 'ok';
      listPage: ConversationPage | undefined;
      entries: ConversationWindowEntries;
      scannedCount: number;
      exhausted: boolean;
    }
  | { kind: 'refused'; body: string }
> {
  const { listMode, limit, scanLimit, cursor, conversationId, since, until } = params;
  let listPage: ConversationPage | undefined;
  let entries: ConversationWindowEntries = [];
  let windowReachedStart = false;
  // 窓の組み立ては `readConversationWindow` 1か所に閉じる: 手組みし直すたびに `with` を絞り忘れる余地が生まれるため
  if (listMode) {
    try {
      listPage = await readConversationPage(journal, {
        limit: limit ?? 20,
        scan: scanLimit,
        ...(cursor === undefined ? {} : { cursor }),
        ...(since === undefined ? {} : { since }),
        ...(until === undefined ? {} : { until }),
      });
    } catch (error) {
      // 継続点が指す発言が見当たらないのは「判定できない」: 黙って先頭から返さない
      if (error instanceof InvalidConversationCursorError) {
        return {
          kind: 'refused',
          body:
            `cursor が使えない（${error.message}。別の日誌のものか、書き換えられている）。` +
            '先頭から読み直すなら cursor を省いて呼ぶこと。**会話は読んでいない。**',
        };
      }
      throw error;
    }
  } else {
    // 会話を名指したときはその会話だけをストア側で絞る: 全会話の窓を読んでから絞ると、他の会話の往復が `scan` を食い尽くして古い会話が「判定できない」になるため。
    const window = await readConversationWindowPage(journal, {
      scan: scanLimit,
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
    });
    entries = window.entries;
    windowReachedStart = window.reachedStart;
  }
  const scannedCount = listPage === undefined ? entries.length : listPage.scanned;
  // 終端は件数から推さない: 読めない行を捨てて短くなった窓を「先頭に届いた」と誤るため（一覧は `listPage.reachedStart`、それ以外は窓の `reachedStart`）
  const exhausted = listPage === undefined ? windowReachedStart : listPage.reachedStart;
  return { kind: 'ok', listPage, entries, scannedCount, exhausted };
}

/** 窓の注記: 何件遡ったか・先頭に届いたか・届かないときの次の手。 */
function describeConversationScanNote(params: {
  conversationId: string | undefined;
  listMode: boolean;
  scannedCount: number;
  exhausted: boolean;
  reached: boolean;
  since: string | undefined;
}): string {
  const { conversationId, listMode, scannedCount, exhausted, reached, since } = params;
  return (
    `（${conversationId === undefined ? '' : 'この会話の'}人間との往復を ${scannedCount} 件遡った。` +
    (reached
      ? '先頭に届いている）'
      : exhausted
        ? `since=${since} より新しい範囲は出し切ったが、それより古い側は見ていない。` +
          'since を外すか古い方へずらすこと）'
        : listMode
          ? 'この窓より古いものは見ていない。続きは「続きを読むには」の cursor で読める）'
          : 'この窓より古いものは見ていない。scan を増やすか until で窓をずらすこと）')
  );
}

/** 一覧以外で cursor を渡されたとき: 使っていないことを言う注記（無ければ空）。 */
function describeCursorIgnoredNote(listMode: boolean, cursorInput: string | undefined): string[] {
  return !listMode && cursorInput !== undefined
    ? [
        '（cursor は会話の一覧のときだけ効く。conversationId / q のときは使っていない。' +
          '古い側は until で窓をずらすこと）',
      ]
    : [];
}

/** 会話の読みと検索の読みが末尾に付ける、本文は抜粋だという注記。 */
function describeExcerptNote(fold: FixedFold): string {
  return fold(
    'conversation-read:excerpt-note',
    '（本文は抜粋。全文は conversation_read id=<id> で取れる）',
    '（本文は抜粋。全文は id=<id>）',
  );
}

// ---- 読み方 2: conversationId（1つの会話を古い順に） ----

/** 畳み込みの正本（`conversationMessages`）を経由して、出す発言と畳まれた版の件数を決める。 */
function selectConversationMessages(
  entries: ConversationWindowEntries,
  conversationId: string,
  filter: {
    speaker: 'human' | 'clone' | 'both';
    q: string | undefined;
    includeSuperseded: boolean;
  },
): { matched: ConversationMessage[]; supersededCount: number } {
  const { speaker, q, includeSuperseded } = filter;
  // 畳み込みの正本（`conversationMessages`）を経由する: 畳み込み規則を持つのを `conversation.ts` の1か所だけにするため
  // 常に `includeSuperseded: true` で1回だけ呼ぶ: 既定ビューでも畳まれた版の件数を数える必要があり、出ないとクローンは畳まれた版の存在に気づけないため
  const allMessages = conversationMessages(entries, conversationId, {
    includeSuperseded: true,
  });
  const supersededCount = allMessages.filter(
    (message) => message.supersededBy !== undefined,
  ).length;
  const visible = includeSuperseded
    ? allMessages
    : allMessages.filter((message) => message.supersededBy === undefined);
  const speakerFiltered =
    speaker === 'both'
      ? visible
      : visible.filter(
          (message) => message.role === (speaker === 'human' ? 'inbound' : 'outbound'),
        );
  const needle = q?.toLowerCase();
  const matched =
    needle === undefined
      ? speakerFiltered
      : speakerFiltered.filter((message) => message.text.toLowerCase().includes(needle));
  return { matched, supersededCount };
}

/** 会話に当たる発言が無いときの全文。 */
function describeConversationNoMessages(
  conversationId: string,
  view: ConversationReadView,
): string {
  return [
    ...view.resolvedNoteLines,
    (view.reached
      ? `会話 ${conversationId} に当たる発言は無い。`
      : `会話 ${conversationId} は、この窓には無い（判定できない）。`) + `\n${view.scanNote}`,
  ].join('\n');
}

/** 会話の1発言の行（畳み込み済みの印・取り下げの印・抜粋・添付）。 */
function conversationMessageLine(
  message: ConversationMessage,
  withdrawnReading: ReturnType<typeof describeWithdrawnReading>,
): string {
  return (
    `${message.at} [${roleLabel(message.role)}] id=${message.id}` +
    (message.supersededBy === undefined
      ? ''
      : `（畳み込み済み。編集後は id=${message.supersededBy}）`) +
    (message.role === 'inbound' && withdrawnReading.isWithdrawn(message)
      ? WITHDRAWN_MESSAGE_MARK
      : '') +
    `\n  ${excerptRow(message.text, CONVERSATION_EXCHANGE_EXCERPT)}` +
    attachmentLines(message.attachments, '  ')
  );
}

/** 畳まれた版の件数の注記（無ければ空）。予算の断り書きとは別の行にする: 「予算で切った」と「畳み込みで意図的に隠した」は別の事実のため。 */
function describeSupersededNote(
  supersededCount: number,
  includeSuperseded: boolean,
  conversationId: string,
): string[] {
  if (supersededCount === 0) return [];
  return [
    includeSuperseded
      ? `（この会話には畳まれた版が ${supersededCount} 件あり、includeSuperseded=true ` +
        'なので含めて表示している）'
      : `（この会話には畳まれた版が ${supersededCount} 件ある。読むには ` +
        `conversation_read conversationId=${conversationId} includeSuperseded=true を指定する）`,
  ];
}

/** 会話の行を新しい側から予算で詰める。落とすのは古い側で、どちら側を落としたかを言う。 */
function renderConversationMessageLines(lines: string[]): { rendered: string; shownCount: number } {
  let shownCount = lines.length;
  // 会話は新しい側から積む: 予算で切るとき落とすのは古い側にし、会話を開く動機である直近の続きを残すため
  const rendered = renderListingFromEnd(lines, {
    budget: CONVERSATION_LIST_BUDGET,
    // どちら側を落としたかを言う: 「N 件省略」だけだと続きの取り方を間違えるため
    omitted: ({ rest, shown, total }) => {
      shownCount = shown;
      return (
        `…この会話の**古い側** ${rest} 件は省略（この窓に ${total} 件あり、` +
        `新しい側から ${shown} 件だけ出した）。古い側を見るには until で窓を古い方へずらすこと。`
      );
    },
  });
  return { rendered, shownCount };
}

/** `conversationId` で1つの会話を古い順に読む回の全文。 */
async function readConversationMessagesText(
  journal: ConversationReadJournal,
  entries: ConversationWindowEntries,
  conversationId: string,
  filter: {
    speaker: 'human' | 'clone' | 'both';
    q: string | undefined;
    includeSuperseded: boolean;
  },
  view: ConversationReadView,
  fold: FixedFold,
): Promise<string> {
  const { matched, supersededCount } = selectConversationMessages(entries, conversationId, filter);
  if (matched.length === 0) return describeConversationNoMessages(conversationId, view);
  const withdrawnLookup = await lookupWithdrawnForMessages(journal, conversationId, matched);
  const withdrawnReading = describeWithdrawnReading(withdrawnLookup, matched);
  const lines = matched.map((message) => conversationMessageLine(message, withdrawnReading));
  const supersededNote = describeSupersededNote(
    supersededCount,
    filter.includeSuperseded,
    conversationId,
  );
  const { rendered, shownCount } = renderConversationMessageLines(lines);
  const withdrawnNotes = describeWithdrawnReading(withdrawnLookup, matched, {
    shown: shownCount === 0 ? [] : matched.slice(-shownCount),
  }).notes;
  return [
    ...view.resolvedNoteLines,
    rendered,
    describeExcerptNote(fold),
    ...supersededNote,
    ...withdrawnNotes,
    ...view.cursorIgnoredNote,
    view.scanNote,
  ].join('\n');
}

// ---- 読み方 3: q（会話をまたぐ検索） ----

/** 検索に当たった1発言の行（会話 id・取り下げの印・抜粋・添付）。 */
function conversationSearchLine(
  message: ConversationMessage,
  withdrawnReading: ReturnType<typeof describeWithdrawnReading>,
): string {
  return (
    `${message.at} [${roleLabel(message.role)}] id=${message.id}` +
    ` conversation=${message.conversationId ?? '(無し)'}` +
    (message.role === 'inbound' && withdrawnReading.isWithdrawn(message)
      ? WITHDRAWN_MESSAGE_MARK
      : '') +
    '\n' +
    `  ${excerptRow(message.text, CONVERSATION_EXCHANGE_EXCERPT)}` +
    attachmentLines(message.attachments, '  ')
  );
}

/** 検索の行を新しい順に予算で詰める。省いたのは古い側だと言う。 */
function renderConversationSearchLines(
  lines: string[],
  q: string,
): { rendered: string; shownCount: number } {
  let shownCount = lines.length;
  const rendered = renderListing(lines, {
    budget: CONVERSATION_LIST_BUDGET,
    omitted: ({ rest, shown, total }) => {
      shownCount = shown;
      return (
        `…ほか ${rest} 件は省略（"${q}" に ${total} 件当たり、新しい順に ${shown} 件だけ出した）。` +
        '省いたのは**古い側**である。scan を増やしても出てこない（当たりが増えるだけで、' +
        '切られる側は変わらない）ので、until で窓を古い方へずらすこと。'
      );
    },
  });
  return { rendered, shownCount };
}

/** `q` で会話をまたいで探す回の全文。 */
async function readConversationSearchText(
  journal: ConversationReadJournal,
  entries: ConversationWindowEntries,
  q: string,
  speaker: 'human' | 'clone' | 'both',
  view: ConversationReadView,
  fold: FixedFold,
): Promise<string> {
  const exchanges = bySpeaker(humanExchanges(entries), speaker);
  const matched = searchExchanges(exchanges, q);
  if (matched.length === 0) {
    return (
      (view.reached
        ? `"${q}" に当たる発言は無い。`
        : `"${q}" は、この窓には無い（判定できない）。`) + `\n${view.scanNote}`
    );
  }
  // 会話をまたぐ検索なので、会話を問わず印を引く（一覧の読みと同じ）
  const withdrawnLookup = await lookupWithdrawnForMessages(journal, undefined, matched);
  const withdrawnReading = describeWithdrawnReading(withdrawnLookup, matched);
  const lines = matched.map((message) => conversationSearchLine(message, withdrawnReading));
  const { rendered, shownCount } = renderConversationSearchLines(lines, q);
  const withdrawnNotes = describeWithdrawnReading(withdrawnLookup, matched, {
    shown: matched.slice(0, shownCount),
  }).notes;
  return [
    rendered,
    describeExcerptNote(fold),
    ...withdrawnNotes,
    ...view.cursorIgnoredNote,
    view.scanNote,
  ].join('\n');
}

// ---- 読み方 4: 一覧（会話の一覧、新しい順） ----

/** 渡した絞りは続きの呼びにも付ける: 付け忘れると窓が変わるため。続きが無ければ空。 */
function describeConversationContinuation(
  resume: ConversationCursor | null,
  request: ConversationListRequest,
  fold: FixedFold,
): string[] {
  if (resume === null) return [];
  const { sinceInput, untilInput, scan, limit } = request;
  const args = [
    `cursor=${encodeConversationCursor(resume)}`,
    ...(sinceInput === undefined ? [] : [`since=${sinceInput}`]),
    ...(untilInput === undefined ? [] : [`until=${untilInput}`]),
    ...(scan === undefined ? [] : [`scan=${scan}`]),
    ...(limit === undefined ? [] : [`limit=${limit}`]),
  ];
  return [
    `続きを読むには: conversation_read ${args.join(' ')}` +
      fold(
        'conversation-read:continuation-note',
        '（limit の上限や窓の外もこれで辿れる。続きが無くなれば、この行は出ない）',
        '（窓の外もこれで辿れる。続きが無ければ行は出ない）',
      ),
  ];
}

/** 一覧が空のときの全文。 */
function describeEmptyConversationList(
  listing: ConversationPage,
  request: ConversationListRequest,
  view: ConversationReadView,
  fold: FixedFold,
): string {
  const emptyNote = !view.reached
    ? 'この窓には無い（判定できない）。'
    : request.cursor === undefined
      ? '会話はまだ無い。'
      : 'この cursor より古い会話は無い。';
  return [
    emptyNote,
    ...describeConversationContinuation(listing.next, request, fold),
    view.scanNote,
  ].join('\n');
}

/** 一覧の1会話の行（id・期間・件数・プレビュー）。 */
function conversationListRow(conversation: ConversationListed): string {
  return (
    `${conversation.conversationId} ${conversation.startedAt}〜${conversation.updatedAt}` +
    `（${conversation.messages} 件）\n  ${conversation.preview}`
  );
}

/** 一覧の行を予算で詰める。どちらの段で切れたかで勧める手を変える: 混ぜると効かない手を案内することになるため。 */
function renderConversationListBody(
  lines: string[],
  hiddenByLimit: number,
  windowTotal: number,
): { body: string; cutByBudget: boolean; shownByBudget: number } {
  let cutByBudget = false;
  let shownByBudget = lines.length;
  const body = renderListing(lines, {
    budget: CONVERSATION_LIST_BUDGET,
    // 予算が縛っているときは `limit` で落ちた分も合わせて「古い側」として1つの数で言う: `limit` を増やしても省略へ回るだけのため
    omitted: ({ rest, shown }) => {
      cutByBudget = true;
      shownByBudget = shown;
      return (
        `…ほか ${rest + hiddenByLimit} 件は省略（この窓に ${windowTotal} 件あり、` +
        `新しい順に ${shown} 件だけ出した）。` +
        '省いたのは**古い側**である。limit を増やしても出てこない（予算のほうで切れているので、' +
        '増やした分がそのまま省略へ回る）。続きは下の cursor で読むこと。'
      );
    },
  });
  return { body, cutByBudget, shownByBudget };
}

/** `limit` で切れて予算にはまだ余りがあるときの注記（無ければ空）。 */
function describeHiddenByLimitNote(
  cutByBudget: boolean,
  hiddenByLimit: number,
  windowTotal: number,
  shownCount: number,
  listLimit: number,
): string[] {
  if (cutByBudget || hiddenByLimit <= 0) return [];
  // 言い方は既存の一覧に寄せる（`…ほか N 件は省略`）: 新しい言い方を足すとその言い方も契約に入るため、予算の側との区別は語ではなく勧める手で分ける
  return [
    `…ほか ${hiddenByLimit} 件は省略（この窓に ${windowTotal} 件あり、` +
      `新しい順に ${shownCount} 件だけ出した）。` +
      '省いたのは**古い側**で、切ったのは limit=' +
      `${listLimit} である。予算にはまだ余りがあるので、limit を増やせば出る。`,
  ];
}

/** `speaker` が一覧に効かないことの注記（both のときは空）。使わなかったならそう言う。 */
function describeSpeakerIgnoredNote(speaker: 'human' | 'clone' | 'both'): string[] {
  return speaker !== 'both'
    ? [
        `（speaker=${speaker} はこの一覧には効いていない。会話が在るかどうかは誰が喋ったかで` +
          '変わらないので、一覧は絞らずに出している。話者で絞るのは conversationId か q の' +
          'ときである）',
      ]
    : [];
}

/** 一覧（会話の一覧）を読む回の全文。 */
function readConversationListText(
  listing: ConversationPage,
  request: ConversationListRequest,
  view: ConversationReadView,
  fold: FixedFold,
): string {
  // `limit` で落ちた分も数に入れる: `slice` の後の件数だけだと、`limit` で消えた分が出力のどこにも現れず、日誌の先頭に届いていると読める応答のまま消えるため
  const listLimit = request.limit ?? 20;
  const conversations = listing.conversations;
  const hiddenByLimit = listing.hiddenByLimit;
  const windowTotal = conversations.length + hiddenByLimit;
  if (conversations.length === 0)
    return describeEmptyConversationList(listing, request, view, fold);
  const lines = conversations.map(conversationListRow);
  const { body, cutByBudget, shownByBudget } = renderConversationListBody(
    lines,
    hiddenByLimit,
    windowTotal,
  );
  const notes: string[] = [];
  notes.push(
    ...describeHiddenByLimitNote(
      cutByBudget,
      hiddenByLimit,
      windowTotal,
      conversations.length,
      listLimit,
    ),
  );
  const lastShown = conversations[shownByBudget - 1];
  const resume = cutByBudget
    ? ((lastShown === undefined ? undefined : listing.positions.get(lastShown.conversationId)) ??
      listing.next)
    : listing.next;
  notes.push(...describeConversationContinuation(resume, request, fold));
  notes.push(
    fold(
      'conversation-read:list-open-note',
      '（各会話の中身は conversation_read conversationId=<id> で古い順に読める）',
      '（中身は conversationId=<id> で読める）',
    ),
  );
  notes.push(...describeSpeakerIgnoredNote(request.speaker));
  notes.push(view.scanNote);
  return [body, ...notes].join('\n');
}
