import type { JobStatus, ManagerPool, ManagerSummary, RunnerClient } from '@alteroid/core';
import {
  jobStatusSchema,
  managerModelsOf,
  codePointBoundary,
  redactSecretsInBody,
  stripNul,
  noteDroppedRecord,
  reasonOf,
  reportRunnerRevision,
  describeUnreadableManagerRow,
  resolveBuildRevision,
  decisionUnusedNote,
  excerptLine,
  loadManagerAttachments,
  UnreadableJobError,
} from '@alteroid/core';
import { describeRoute, resolver } from 'hono-openapi';
import { z } from 'zod';
import {
  archiveRemovedResponseSchema,
  attachmentErrorResponseSchema,
  managerActionResponseSchema,
  managerDetailResponseSchema,
  managersListResponseSchema,
  runnersListResponseSchema,
  runnersVacateCommandSchema,
  runnersVacateResponseSchema,
} from './openapi.js';
import { Hono } from 'hono';
import type { AppContext } from './app-context.js';
import type { AppDeps } from './app.js';
import type { AuthVariables } from './auth.js';
import {
  jsonResponse,
  errorResponse,
  journalWriteFailedResponse,
  invalidWith,
  jsonBody,
  queryParams,
  appendJournalOrDrop,
  journalWriteFailedBody,
  kindOfError,
  humanActionOf,
} from './app-shared.js';

// 「空」は NUL を落とした後で見る: ストアは NUL を落とすので、落とす前の長さで見ると NUL だけの値が空のまま届く。`nonBlankString`（空白だけも弾く）とは別物。
export const nonNulString = z
  .string()
  .min(1)
  .refine((value) => stripNul(value).length > 0);

const managerMessageBody = z.object({
  // NUL だけの text が空の追加指示として届かないよう `nonNulString` で見る。
  text: nonNulString,
  requestId: z.string().min(1).optional(),
  decision: z.enum(['allow', 'deny']).optional(),
  // `POST /attachments` が返した id。道具 `manager_send` の `attachments` と同じ意味・同じ検証（`loadManagerAttachments`）。
  attachments: z.array(z.string().min(1)).optional(),
});

const abortBody = z.object({
  // NUL だけの reason は、止めた後の文言と日誌の理由が空欄になるので入口で断る。
  reason: nonNulString.optional(),
});

// 何も渡さない呼びは応答が1バイトも変わらない（opt-in）: 判定は生のクエリで行う（`c.req.valid('query')` は既定値を埋めるので「渡されたか」を答えない）。
// カーソルは `/journal` 形（可視の複合キー）である。`order` は足さない（並びは `ManagerPool.list()` が固定している）。`limit` の既定を作らない: 渡していない呼びの応答が変わり、到達できない行が生まれる（north_star 禁止2）。
// `max` を 1000 にしたのは窓の形を `/journal` と揃えるためで、資源を守る数値ではない。
const managersQuery = z.object({
  // 知らない値は 400 で断る（ハンドラで検査）: 黙って無視すると、綴りを間違えた呼びが「0件」として返り、絞り込みが効いていないことに気づけない。
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  // 「次」は返る順序の意味（`startedAt` の降順なので、錨より古い側が返る）。
  afterId: z.string().optional(),
  afterStartedAt: z.string().optional(),
});

// `managerId` は同時刻の同着を割る補助キー: `ManagerPool.list()` の並びは `startedAt` だけで決まり同着の相対順は決まっていないので、補助キーを足して初めて頁を辿っても飛ばさず重複しない。
interface ManagerPagingKey {
  startedAt: string;
  managerId: string;
}

// `localeCompare` を使う: `ManagerPool.list()` の並べ替えと同じ比較にしないと、並べ直した結果があちらの並びと食い違う。
function compareManagerPagingKey(a: ManagerPagingKey, b: ManagerPagingKey): number {
  const byStartedAt = b.startedAt.localeCompare(a.startedAt);
  if (byStartedAt !== 0) return byStartedAt;
  return b.managerId.localeCompare(a.managerId);
}

// 知らない値は捨てずに返す（呼び出し側が 400 にする）。空の要素は落とす（`/journal` の `type` と同じ形）。
function parseManagerStatuses(raw: string): { statuses: JobStatus[]; unknown: string[] } {
  const statuses: JobStatus[] = [];
  const unknown: string[] = [];
  for (const value of raw.split(',')) {
    if (value.length === 0) continue;
    const parsed = jobStatusSchema.safeParse(value);
    if (parsed.success) statuses.push(parsed.data);
    else unknown.push(value);
  }
  return { statuses, unknown };
}

// 拒否はデーモンのプロセス内にしか無い像なので外向きの面でだけ合流させ、core の interface へ混ぜない（台帳へ持ち越さない）。拒否が無いときはキーごと載せない: `[]` は「0 件だった」と読めるが、実際は「この器では数えていない」でもありうる。
function managerView(managers: ManagerPool, summary: ManagerSummary) {
  const denials = managers.denials(summary.managerId);
  return {
    ...summary,
    ...(denials.length === 0 ? {} : { denials }),
    // 取れなければ欄ごと載せない（クローンの道具と同じ読み方。既定の帯で埋めない）。
    ...managerModelsOf(managers, summary),
  };
}

/** 一覧（`GET /managers`）で依頼文と報告を切る長さ（UTF-16 の単位）。一覧の利用者が使うのは最長でも 120 字（TUI）で、全文は詳細で取る（#5089） */
export const MANAGER_LIST_TEXT_HEAD = 200;

/**
 * 切るときに伏せを掛ける窓の、切る位置より後ろの余白（字）。伏せの規則（`redactSecretsInBody`）はどれも秘密の頭から始まり、
 * 長さに上限がある（最長は `github_pat_` の 311 字・URL の userinfo の 200 字ほど）か、`…KEY=` の代入・Bearer・PEM（END が無ければ
 * 文字列の終わりまで伏せる）のように頭から窓の終わりまで伏せる。なので切る位置の前で始まる秘密は、この余白があれば切った頭の中では必ず伏せられる。
 * 窓の終わりで秘密が切れて規則に当たりやすくなる向き（伏せすぎ）にしかずれない
 */
const MANAGER_LIST_REDACT_MARGIN = 512;

// 先頭だけにして末尾に `…` を付ける。切らないなら undefined。コードポイントの途中では切らない。
// 切るときは、描画の側（Web・CLI の `redactBody`）と同じ伏せを掛けてから切る（`redactedExcerpt` と同じ順）: 生のまま切ると、
// 切れ目をまたいだ鍵の頭だけが残り、描画の側の伏せの規則に当たらずに出てしまうため。伏せは先頭の窓にだけ掛ける: 全文に掛けると
// 600 件で 30ms ほど増えるため。切らない行は今までどおり生のまま返す（伏せは描画の側の仕事のまま）
function textHead(text: string, max: number): string | undefined {
  if (text.length <= max) return undefined;
  const readEnd = codePointBoundary(text, max + MANAGER_LIST_REDACT_MARGIN);
  const redacted = redactSecretsInBody(text.slice(0, readEnd), undefined);
  if (redacted.length <= max && readEnd >= text.length) return undefined;
  return `${redacted.slice(0, codePointBoundary(redacted, max))}…`;
}

// 一覧の1行: 詳細（`managerView`）と同じ欄を持ち、大きい本文（依頼文・報告）だけを先頭に切る（#5089）。
// 欄ごと外さない: CLI の `/managers` が報告の有無で「報告ゼロ」を言い分け、Web の使用量の画面が依頼文の頭をラベルにするため
function managerListItem(managers: ManagerPool, summary: ManagerSummary) {
  const view = managerView(managers, summary);
  const request = textHead(view.request, MANAGER_LIST_TEXT_HEAD);
  const lastReport =
    view.lastReport === undefined ? undefined : textHead(view.lastReport, MANAGER_LIST_TEXT_HEAD);
  return {
    ...view,
    ...(request === undefined ? {} : { request, requestTruncated: true as const }),
    ...(lastReport === undefined ? {} : { lastReport, lastReportTruncated: true as const }),
  };
}

// 人間の答えを届ける前の日誌が書けなかったことだけを、`managers.send` から抜ける他の例外と見分けるための印。`beforeAnswer` が投げた例外は `send` をそのまま通って route へ戻るので、型で拾う。
class AnswerJournalWriteError extends Error {
  constructor(readonly journalError: unknown) {
    super('答えを届ける前の日誌が書けなかった');
    this.name = 'AnswerJournalWriteError';
  }
}

// 戻り値を1つの値に畳まない: 「空」と「聞けなかった」が同じ形になるので `*Probe` を必ず一緒に組み立てる。理由は `reasonOf` を通す: 例外は失敗した呼び出しのパラメータを添えることがあるので、素の `String(error)` を応答へ載せない。
async function probe(
  runner: RunnerClient | undefined,
  kind: 'credentials' | 'profile',
): Promise<Record<string, unknown>> {
  const key = kind === 'credentials' ? 'credentialsProbe' : 'profileProbe';
  const empty = kind === 'credentials' ? { credentials: [] } : {};
  if (runner === undefined) return { ...empty, [key]: { status: 'unheard' } };
  try {
    if (kind === 'credentials') {
      return { credentials: await runner.credentials(), credentialsProbe: { status: 'asked' } };
    }
    const value = await runner.profile();
    return {
      ...(value === undefined ? {} : { profile: value }),
      profileProbe: { status: 'asked' },
    };
  } catch (error) {
    return { ...empty, [key]: { status: 'failed', error: reasonOf(error) } };
  }
}

export function managersRoutes(ctx: AppContext, deps: AppDeps) {
  const { clone, stores, attachmentLimits } = ctx;
  return (
    new Hono<{ Variables: AuthVariables }>()
      // 応答は返す前に宣言したスキーマを通す（`.parse()`）: `resolver()` は `openapi.json` を作るだけで実際の応答を見ないので、`ManagerSummary` にフィールドが増えた日に spec に書いていないものを黙って外へ出す。`.parse()` なら宣言に無いキーを落とす。
      .get(
        '/managers',
        describeRoute({
          tags: ['managers'],
          summary: '委譲先マネージャーの一覧',
          description:
            '委譲先マネージャーの一覧と状態。**行は1つも消えない**——台帳（`jobs`）に削除の口は無く、' +
            '終端した委譲もそのまま残る（issue #670。`ManagerPool#retire` の doc）。' +
            '⟹ 件数はその環境で今までに起こした委譲の総数と等しくなるので、`status` で絞り、' +
            '`limit` と錨（`afterId` ＋ `afterStartedAt`）で窓を掛けられる。' +
            '`status` はカンマ区切りで複数指定できる（`running` / `waiting_human` / `done` / ' +
            '`failed` / `lost` / `stopped`。**知らない値は 400**——黙って無視すると、綴りを' +
            '間違えた呼びが「0件」として返り、絞り込みが効いていないことに気づけない）。' +
            '`afterId` と `afterStartedAt` は必ず組で渡す（片方だけは 400）。' +
            '**指す行が見当たらないときも 400**——黙って先頭から返さない' +
            '（`apps/daemon/src/cursor.ts` の「判定できないを黙って先頭へ倒さない」と同じ理由。' +
            'この口は照合できる——台帳の行が消えないので、「無い」は「消えた」ではなく' +
            '「そんな錨は刷っていない」である）。' +
            '錨は `status` の絞りの外の行でもよい——頁の間に状態が変わった委譲（前の頁には載っていた）を錨にした続きも読める（issue #4801）。' +
            '**並びは `startedAt` の降順で固定**（`ManagerPool.list()` の契約）で、ここでは選べない' +
            '——`order` は足さない。⟹ 錨の「次」は*より古い*側である。' +
            '**封筒（`total` / `nextCursor`）は持たない**——続きが在るかは `limit` 件ちょうど' +
            '返ったかで判る（応答に新しい欄を1つも足さない）。' +
            '当てる順序は **`status` 絞り → 錨 → `limit`** である（先に窓で切ると、次の頁の' +
            '起点がずれる。issue #418 が塞いだ穴と同じ形）。' +
            '**窓のクエリ（`status`・`limit`・錨）を1つも渡さない呼びは、窓を足す前と同じく全件を同じ並びで返す**（opt-in）。' +
            'ただし行の欄の切り（下の `request`・`lastReport`）は、窓のクエリの有無に関わらず掛かる。' +
            '**CLI とクローンの `manager_list` はこの窓を使っていない**（別 issue）。' +
            '行が読めない（版ずれ・手編集）委譲が在るときだけ、`unreadable`（id が取れれば id と' +
            '不正な欄名。本文は載せない）を載せる（issue #2345）。**「居ない」でも「畳まれた」でもない**。' +
            '`status` の絞り・`limit`・錨では切らず、常に全件を返す。0件なら鍵ごと無い。' +
            '**依頼文（`request`）と報告（`lastReport`）は一覧では先頭 ' +
            `${String(MANAGER_LIST_TEXT_HEAD)} 字（UTF-16 の単位）までに切り、末尾に \`…\` を付ける**（#5089。委譲は消えないので、` +
            '全文を載せると件数に比例して応答が太る）。切った欄は、表示の側と同じ秘密の伏せを掛けてから切る' +
            '（切れ目をまたいだ鍵の頭が残らないように）。切った欄には `requestTruncated` / `lastReportTruncated` が `true` で付く。' +
            '全文は `GET /managers/{id}` で取る。欄の有無は変えない（報告が無い委譲は、一覧でも `lastReport` を持たない）。',
          responses: {
            200: jsonResponse('マネージャーの一覧と状態。', managersListResponseSchema),
            400: errorResponse(
              'クエリが不正（`limit` は1以上1000以下の整数）、`status` に知らない値が入っている、' +
                '`afterId` / `afterStartedAt` の片方だけが渡された、`afterStartedAt` の形式が不正、' +
                'または錨が指す行が見当たらない。',
            ),
          },
        }),
        queryParams(managersQuery),
        async (c) => {
          const { status, limit, afterId, afterStartedAt } = c.req.valid('query');
          // opt-in の判定は生のクエリで行う。`status` は含めない: 窓とは別の絞り込みなので、`status` だけの呼びは並べ直しを通らず `list()` の生の並びのまま絞られる。
          const optedIn =
            c.req.query('limit') !== undefined ||
            c.req.query('afterId') !== undefined ||
            c.req.query('afterStartedAt') !== undefined;

          // 片方だけでは境界が決まらない。この2つの if で TypeScript が以降 `string` に絞る。
          if (afterId === undefined && afterStartedAt !== undefined) {
            return c.json({ error: 'afterId と afterStartedAt は両方一緒に渡す' as const }, 400);
          }
          if (afterId !== undefined && afterStartedAt === undefined) {
            return c.json({ error: 'afterId と afterStartedAt は両方一緒に渡す' as const }, 400);
          }
          if (
            afterId !== undefined &&
            afterStartedAt !== undefined &&
            Number.isNaN(Date.parse(afterStartedAt))
          ) {
            return c.json({ error: 'afterStartedAt は ISO 8601 で指定する' as const }, 400);
          }

          let statuses: JobStatus[] | undefined;
          if (status !== undefined) {
            const parsed = parseManagerStatuses(status);
            if (parsed.unknown.length > 0) {
              return c.json(
                {
                  error:
                    `status に知らない値が入っている: ${parsed.unknown.join(', ')}` +
                    `（使えるのは ${jobStatusSchema.options.join(' / ')}）`,
                },
                400,
              );
            }
            statuses = parsed.statuses;
          }

          const managers = await clone.managers.list();

          // 当てる順序は `status` 絞り → 錨 → `limit`: 先に `limit` で切ると切った窓の中から絞ることになり（先頭の1件が `done` だっただけで `status=running&limit=1` が 0 件を返す）、錨を `limit` より後に当てると次の頁の起点がずれる。`status=`（空）は絞らない: 0件へ倒すと絞りを解除した画面が「マネージャーが消えた」ように見える。
          const active = statuses;
          let view =
            active === undefined || active.length === 0
              ? managers
              : managers.filter((m) => active.includes(m.status));

          // 並べ直すのは opt-in のときだけ: `list()` の並びは同着の相対順を決めていないので、錨で辿るには補助キー（`managerId`）まで含めた順序が要る。opt-in しなければ通さない（既定の呼びの応答がバイト単位で一致する）。
          if (optedIn) {
            view = [...view].sort(compareManagerPagingKey);
            if (afterId !== undefined && afterStartedAt !== undefined) {
              const pivot = { managerId: afterId, startedAt: afterStartedAt };
              // 実在を確かめる（`/approvals` と違う）: 台帳の行は消えないので、見当たらないのは「消えた」ではなく「そんな錨は刷っていない」で、黙って先頭から返すと呼ぶ側は同じ頁を無限に読む。
              // 絞る前の一覧で確かめる（#4801）: `status` で絞った一覧からは、頁の間に状態が変わった担当が消え、その錨が二度と使えなくなるため（続きは錨が一覧に無くても比べて決まる）
              const exists = managers.some(
                (m) => m.managerId === afterId && m.startedAt === afterStartedAt,
              );
              if (!exists) {
                return c.json(
                  {
                    error:
                      `afterId/afterStartedAt が指す行が見当たらない（${afterId} / ${afterStartedAt}）。` +
                      '応答に載っていた managerId と startedAt をそのまま渡すこと',
                  },
                  400,
                );
              }
              view = view.filter((m) => compareManagerPagingKey(m, pivot) > 0);
            }
          }

          const page = optedIn && limit !== undefined ? view.slice(0, limit) : view;

          // 0 件なら鍵ごと無い: 空配列は「読めない行は 0 件」と読め、既存の呼び手の応答も変わる。窓（`status` / `limit` / 錨）では切らない: 行が読めないのでどの状態のものかも分からない。
          const unreadable = await stores.jobs.listUnreadableJobs();

          return c.json(
            managersListResponseSchema.parse({
              managers: page.map((summary) => managerListItem(clone.managers, summary)),
              ...(unreadable.length > 0 ? { unreadable } : {}),
            }),
          );
        },
      )

      .get(
        '/managers/:id',
        describeRoute({
          tags: ['managers'],
          summary: '1本のマネージャーの状態',
          responses: {
            200: jsonResponse('マネージャーの状態。', managerDetailResponseSchema),
            404: errorResponse('該当するマネージャーが無い。'),
            409: errorResponse(
              '該当する委譲の行は在るが、型に合わない形で入っていて読めない（居ないのとは区別する。' +
                'issue #2359）。本文は載せず、理由は不正な欄名だけ。',
            ),
          },
        }),
        async (c) => {
          const id = c.req.param('id');
          // 1件のために台帳を全部読まない（#5089）。`get` を持たない偽のプールだけ一覧から探す
          let manager: ManagerSummary | undefined;
          try {
            manager =
              clone.managers.get === undefined
                ? (await clone.managers.list()).find((entry) => entry.managerId === id)
                : await clone.managers.get(id);
          } catch (error) {
            if (!(error instanceof UnreadableJobError)) throw error;
            // 読めない行と分かった: 下の言い分け（409）へ落とす
            manager = undefined;
          }
          if (!manager) {
            // `list()` は読めない委譲の行を飛ばすので、壊れた行の id はここで見つからない: 見つからなかったときだけ台帳を読み直し、行が在るなら 404 ではなく 409 と言い分ける。本文は載せず、理由は不正な欄名だけ。
            const unreadableRow = (await stores.jobs.listUnreadableJobs()).find(
              (row) => row.id === id,
            );
            if (unreadableRow !== undefined) {
              return c.json({ error: describeUnreadableManagerRow(id, unreadableRow.reason) }, 409);
            }
            return c.json({ error: 'not found' as const }, 404);
          }
          return c.json(
            managerDetailResponseSchema.parse({ manager: managerView(clone.managers, manager) }),
          );
        },
      )

      .get(
        '/managers/:id/transcript',
        describeRoute({
          tags: ['managers'],
          summary: 'マネージャーの生ログ',
          description:
            'manager_id からそのセッションの生ログへ。走行中ならファイルの上、退避済みなら' +
            'アーカイブから返る（可観測性3層の最下段）。',
          responses: {
            200: {
              description: '生ログ（JSONL の生テキスト）。',
              content: { 'text/plain': { schema: resolver(z.string()) } },
            },
            404: errorResponse('該当するマネージャーの生ログが無い。'),
            409: errorResponse(
              '該当する委譲の行は在るが、型に合わない形で入っていて読めない（居ないのとは区別する。' +
                'issue #2359）。本文は載せず、理由は不正な欄名だけ。',
            ),
            410: jsonResponse(
              '退避はあったが、本文は `DELETE /archive/:id` で消されている（#698）。' +
                'いつ・何バイト落としたか、どの archive id だったかを返す。',
              archiveRemovedResponseSchema,
            ),
          },
        }),
        async (c) => {
          const result = await clone.managers.transcript(c.req.param('id'));
          if (result.kind === 'missing') return c.json({ error: 'not found' as const }, 404);
          // 読めない行は 404 にしない: 居ないのではなく壊れている。
          if (result.kind === 'unreadable') return c.json({ error: result.detail }, 409);
          if (result.kind === 'removed') {
            return c.json(
              archiveRemovedResponseSchema.parse({
                error: 'removed',
                removedAt: result.removedAt,
                bytes: result.bytes,
                archiveId: result.archiveId,
              }),
              410,
            );
          }
          return c.text(result.body);
        },
      )

      .post(
        '/managers/:id/messages',
        describeRoute({
          tags: ['managers'],
          summary: '人間からマネージャーへ直接話しかける',
          description:
            'これが無いと、人間の言葉はクローンを経由してしか届かない。クローンの代わりに判断' +
            'するための口ではない（判断はクローンの仕事のまま）。人間が自分の言葉を自分で届ける' +
            'ための口である。許可確認への回答なら `requestId` を付ける。' +
            '**`attachments`（任意）— `POST /attachments` で上げた添付の id を渡すと、その添付が担い手の手元に' +
            'ファイルとして置かれ（画像は画像としても見える）、日誌には参照だけが残る（クローンの道具 `manager_send` の' +
            '`attachments` と同じ）。** 存在しない id（保持期限切れ・誤り）・個数や合計が上限（`GET /attachments/limits`）を' +
            '超える・確認への回答（`requestId` / `decision`）に添える、のいずれかなら 400 で、何も送らない。' +
            '`text` は添付があっても必須。添付は会話・報告には結び付けない（他の入口が上げた添付も渡せる）。',
          responses: {
            200: jsonResponse(
              '`outcome` を読むこと。`answered` = 止まっていた確認を解いた。' +
                '`delivered` = 追加指示として届けた（runner にセッションが無く resume から' +
                '入り直した回も含む。`detail` がそう言う）。' +
                '`session_missing` = **runner がこの委譲のセッションを持っておらず、resume でも' +
                '入り直せなかった**（#563。**届いていない**）。' +
                '`unknown` はここには出ない（404 になる）。' +
                '`declined` = **認証トークンの世代が食い違う done の委譲を畳んで新しい鍵で起こし直したいが、' +
                '背景処理・確認待ちが残っている（または分からない）ため、畳まず、送らなかった**' +
                '（#2851。そのものは居る。`detail` が残っているものと取れる手を言う）。' +
                '`declined` で返るのは、預かれなかった回（添付付き・預かりの上限を超えた）だけである。' +
                '`held` = `declined` と同じ理由でいまは届けられないので、**伝言を台帳に預かった**' +
                '（#4441。届けられるようになったら自動で届け、日誌とクローンへ知らせる。送り直すと二重に届く）。' +
                '⚠️ `session_missing` を 404 にしないのは、**そのものは居る**からである — ' +
                '委譲は台帳に在り、時間で解ける理由（引き取り中・貸し出し期限）なら送り直しで通る。' +
                '⚠️ `requestId` 無しで `decision` を付け、待っている確認に当たらず `delivered` / `held` になった回は、' +
                '`detail` の末尾に「回答としては使っていない」警告が付く（クローンの道具 `manager_send` と同じ文）。',
              managerActionResponseSchema,
            ),
            400: jsonResponse(
              '本文が JSON として不正、または `attachments` の検証に失敗した（見つからない id・上限超過・' +
                '確認への回答への添付）。何も送っていない。' +
                '`attachments` の検証失敗には `code` が付く（見つからない・期限切れは `attachment_missing`、個数・サイズの上限超過は `too_many` / `total_too_large` / `too_large` など。`POST /chat` と同じ綴り）。',
              attachmentErrorResponseSchema,
            ),
            404: errorResponse('該当するマネージャーが無い。'),
            409: errorResponse(
              '該当する委譲の行は在るが、型に合わない形で入っていて読めない（居ないのとは区別する。' +
                'issue #2359）。送っていない。本文は載せず、理由は不正な欄名だけ。',
            ),
            500: journalWriteFailedResponse(
              '確認への答えを届ける前の日誌が書けなかった（**答えていない**。担当は確認待ちのまま）。' +
                '日誌を先に書き、書けなければ答えを届けない。',
            ),
          },
        }),
        jsonBody(managerMessageBody, invalidWith('text の形が不正')),
        async (c) => {
          const { text, requestId, decision, attachments: attachmentIds } = c.req.valid('json');
          const managerId = c.req.param('id');
          // 検証は送る前に済ませる: 失敗したら何も送らない（`manager_send` と同じ `loadManagerAttachments`）。結び付け（bind）はしない: 担い手へ渡すのは中身の写しで、会話・報告の持ち物にはならない
          if (
            (attachmentIds?.length ?? 0) > 0 &&
            (requestId !== undefined || decision !== undefined)
          ) {
            return c.json(
              {
                error:
                  '確認への回答（requestId / decision を付けた送信）には添付を載せられない。' +
                  '何も送っていない。回答は添付なしで送り、添付は追加指示として別に送ること。',
              },
              400,
            );
          }
          const handover = await loadManagerAttachments(
            stores,
            attachmentIds ?? [],
            attachmentLimits,
          );
          if (!handover.ok) {
            return c.json(
              {
                error: handover.message,
                ...(handover.code === undefined ? {} : { code: handover.code }),
              },
              400,
            );
          }
          // 答えを届ける前に判断の行を書く: 答えが届いたのに日誌に跡が無い窓を作らないため（人間の答えは承認の跡そのもの）。
          // 行を書いたかを旗で持つ: 確認に当たらなかった送信では `beforeAnswer` が呼ばれず、書いていない行は打ち消さない。
          // この行には humanAction を付けない: 付けた行は次のターンでクローンに名指しされるので、答えが届かず打ち消す回に、届いていないものを「人間が送った」と学ばせないため。印は答えが効いた後の行（下）が持つ。
          const answerJournaled: { requestId?: string } = {};
          const retractAnswerJournal = async (detail: string): Promise<void> => {
            if (answerJournaled.requestId === undefined) return;
            await appendJournalOrDrop(
              stores,
              {
                type: 'decision',
                decision:
                  `人間が担当 ${managerId} の確認（${answerJournaled.requestId}）へ直接答えるとした直前の回答の行は` +
                  `効いていない（答えは届いていない）。理由: ${excerptLine(detail, 200)}`,
                grounds: '先に書いた回答の行の後で、答えが届かなかったため打ち消す',
              },
              '人間の直接の回答の打ち消しの日誌',
              `id=${managerId}`,
            );
          };
          let result;
          try {
            result = await clone.managers.send(managerId, text, {
              ...(requestId === undefined ? {} : { requestId }),
              ...(decision === undefined ? {} : { decision }),
              ...(handover.attachments.length === 0 ? {} : { attachments: handover.attachments }),
              beforeAnswer: async (pending) => {
                try {
                  await stores.journal.append({
                    type: 'decision',
                    decision:
                      `人間が担当 ${managerId} の確認（${pending.requestId}: ${excerptLine(pending.summary, 200)}）へ直接答える` +
                      `（decision=${decision ?? '指定なし（runner が本文から読む）'}。抜粋: ${excerptLine(text, 200)}）`,
                    grounds:
                      '人間が直接 API からマネージャーの確認へ答えた（答えを届ける前に残す）',
                  });
                } catch (error) {
                  throw new AnswerJournalWriteError(error);
                }
                answerJournaled.requestId = pending.requestId;
              },
            });
          } catch (error) {
            if (error instanceof AnswerJournalWriteError) {
              noteDroppedRecord(
                '人間の直接の回答の日誌（答えていない）',
                `id=${managerId}`,
                kindOfError(error.journalError),
              );
              return c.json(journalWriteFailedBody(), 500);
            }
            await retractAnswerJournal(`送信が例外で終わった: ${reasonOf(error)}`);
            throw error;
          }
          if (result.outcome !== 'answered') await retractAnswerJournal(result.detail);
          // `session_missing` を 404 に混ぜない: 「そのものは居る」側で、待てば直る状態を 404 という機械可読な終端で返すことになる。200 + `outcome` で返し、読み手に解釈の余地を残す。
          if (result.outcome === 'unknown') return c.json({ error: result.detail }, 404);
          // 行は在るが読めないものは「居ない」の 404 にしない（409）。
          if (result.outcome === 'unreadable') return c.json({ error: result.detail }, 409);
          // 効かなかった回（`session_missing` / `declined`）には積まない: 届いていないものを「人間が送った」と学ばせないため。`exchange` 行は変えず、直しの合図は別の1行（`decision`）に持つ。
          if (
            result.outcome === 'answered' ||
            result.outcome === 'delivered' ||
            result.outcome === 'held'
          ) {
            await appendJournalOrDrop(
              stores,
              {
                type: 'decision',
                decision:
                  requestId === undefined
                    ? `人間が担当 ${managerId} へ直接送った（抜粋: ${excerptLine(text, 200)}）`
                    : `人間が担当 ${managerId} の許可確認（${requestId}）へ直接答えた（抜粋: ${excerptLine(text, 200)}）`,
                grounds: '人間が直接 API からマネージャーへ送った',
                ...humanActionOf(c.get('principal'), 'manager_message', managerId),
              },
              '人間からマネージャーへの直接送信の日誌',
              `id=${managerId}`,
            );
          }
          // 道具（`manager_send`）と同じ警告を `detail` の末尾へ足す: 足さないと Web・CLI の人間が、許可したつもりで何も通っていないことに気づけない
          return c.json({
            outcome: result.outcome,
            detail: `${result.detail}${decisionUnusedNote(decision, requestId, result.outcome)}`,
          });
        },
      )

      .delete(
        '/managers/:id',
        describeRoute({
          tags: ['managers'],
          summary: 'この仕事をやめさせる',
          description:
            '暴走を止める手段が「器ごと落とす」しか無いと、関係の無い仕事まで道連れになる。' +
            'この口は1本だけを止める。止めた事実は日誌に残る。',
          responses: {
            200: jsonResponse(
              '止める指示は処理できた。`outcome` を読むこと — `stopped`（止まったと確かめた）/ ' +
                '`not_stopped`（止まっていないと確かめた）/ `unknown`（確かめられなかった）のどれかで、' +
                '止まったと機械可読に言えるのは `stopped` のときだけである。',
              managerActionResponseSchema,
            ),
            400: errorResponse('本文が JSON として不正。'),
            404: errorResponse('該当するマネージャー（`absent`）が無い。'),
            409: errorResponse(
              '該当する委譲の行は在るが、型に合わない形で入っていて読めない（`unreadable`。居ないのとは' +
                '区別する。issue #2359）。止めておらず、行も書き換えていない。本文は載せず、理由は不正な欄名だけ。',
            ),
          },
        }),
        jsonBody(abortBody, invalidWith('reason の形が不正')),
        async (c) => {
          const { reason } = c.req.valid('json');
          const result = await clone.managers.abort(
            c.req.param('id'),
            ...(reason === undefined ? [] : ([reason] as const)),
          );
          // `'absent'` だけが 404: `'not_stopped'` / `'unknown'` は「そのものは居る」という観測結果で、リクエスト自体は正しく処理できている（200 で `outcome` を返す）。
          if (result.outcome === 'absent') return c.json({ error: result.detail }, 404);
          // 行は在るが読めないものは「居ない」の 404 にしない（409）。
          if (result.outcome === 'unreadable') return c.json({ error: result.detail }, 409);
          return c.json({ outcome: result.outcome, detail: result.detail });
        },
      )

      // 指紋を出す: 人間が置いた鍵とマネージャーが握っている鍵が同じかを確かめる手段が他に無く、無いと「権限が足りない」のか「届いていない」のかを切り分けられない。値は返らない。
      .get(
        '/runners',
        describeRoute({
          tags: ['runners'],
          summary: '委譲先 runner の一覧と、配られている鍵の指紋',
          description:
            '指紋を出すのは、人間が置いた鍵とマネージャーが握っている鍵が同じかどうかを確かめる' +
            '手段が他に無いからである。**値は返らない。**',
          responses: {
            200: jsonResponse('runner の一覧。', runnersListResponseSchema),
          },
        }),
        async (c) => {
          // runner の一覧が空でもこの値だけは常に出す: 自分がどの版で走っているかは runner の登録有無と無関係な事実。
          const daemonRevision = reportRunnerRevision(resolveBuildRevision());
          // runner が0台・名簿が無いときも出す（クローン自身の init の事実）。読み口を持たないホストでは欄ごと省く: 「0件」と埋めない。
          const clonePluginLoad = clone.pluginLoad?.();
          const clonePluginLoadField = clonePluginLoad === undefined ? {} : { clonePluginLoad };
          const registry = deps.runners;
          if (registry === undefined) {
            return c.json(
              runnersListResponseSchema.parse({
                runners: [],
                daemonRevision,
                ...clonePluginLoadField,
              }),
            );
          }
          // 名簿に載っている全部を返す: 上がってこない runner が消えるだけだと「設定し忘れた」のか「上がってこない」のかが区別できない。
          const open = new Map((await registry.list()).map((runner) => [runner.runnerId, runner]));
          return c.json(
            runnersListResponseSchema.parse({
              runners: await Promise.all(
                registry.entries().map(async (entry) => {
                  const runner =
                    entry.runnerId === undefined ? undefined : open.get(entry.runnerId);
                  return {
                    label: entry.label,
                    state: entry.state,
                    since: entry.since,
                    ...(entry.error === undefined ? {} : { error: entry.error }),
                    ...(entry.runnerId === undefined ? {} : { runnerId: entry.runnerId }),
                    ...(entry.workspacePath === undefined
                      ? {}
                      : { workspacePath: entry.workspacePath }),
                    // 繋がっていない相手のぶんも出す: 黙った器の「最後に応えていたプロセス」は、戻ってきたときに同じ器かを突き合わせる材料で、消すと黙っている間だけ材料が消える。
                    ...(entry.instanceId === undefined ? {} : { instanceId: entry.instanceId }),
                    ...(entry.instanceSince === undefined
                      ? {}
                      : { instanceSince: entry.instanceSince }),
                    // 繋がっていない相手には聞きに行かない。聞かなかったこと・聞いて失敗したこと・聞いて0件だったことを同じ表現へ潰さない: 読む側が「鍵が配られていない」のか「確かめられなかった」のかを区別できなくなる。
                    ...(await probe(runner, 'credentials')),
                    ...(await probe(runner, 'profile')),
                    // 名簿に既にある値をそのまま出し、ここで新たに runner を叩かない: 「未接続／頼んで失敗／頼んでいない」が潰れる穴を増やさない。
                    revision: entry.revision,
                    // 押し込みの直近結果は `probe` の指紋とは別物（記憶から返すだけで新たな往復は無い）: `ManagerPool` の内部状態なので `clone.managers` 経由の専用アクセサ（`pushHealthOf`）が要る。
                    ...(entry.runnerId === undefined
                      ? {}
                      : (() => {
                          const pushHealth = clone.managers.pushHealthOf(entry.runnerId);
                          return pushHealth === undefined ? {} : { pushHealth };
                        })()),
                    // 読み口を持たないプールでは「不明」に倒す: 「頼めない」と埋めない。
                    managerPeers: clone.managers.managerPeersOf?.(entry.runnerId) ?? {
                      status: 'unknown',
                    },
                    // 読み口を持たないプール・まだ session を受けていない runner では欄ごと省く: 「0件」と埋めない。
                    ...(entry.runnerId === undefined
                      ? {}
                      : (() => {
                          const pluginLoad = clone.managers.pluginLoadOf?.(entry.runnerId);
                          return pluginLoad === undefined ? {} : { pluginLoad };
                        })()),
                  };
                }),
              ),
              daemonRevision,
              ...clonePluginLoadField,
            }),
          );
        },
      )

      // `RunnerRegistry` ではなく `ManagerPool.vacate()` を呼ぶ: `RunnerRegistry#vacate` は同期・往復無しの名簿操作だけで、「確かめた停止」の握手と `relocateFrom` まで含めた HTTP から見える唯一の受け口がこちら。どの器を空けるかはクローンの判断で、スクリプトが黙って選ばない。
      .post(
        '/runners/vacate',
        describeRoute({
          tags: ['runners'],
          summary: 'その runner を意図して空ける（drain）',
          description:
            '空けると立てるだけで、その場では終わらない。載っている委譲は' +
            '「確かめた停止」の握手を経て、貸し出し期限を待たずに他の runner へ移る。' +
            '**応答は「立てた」ことの確認であって「終わった」ことの確認ではない**' +
            '——進捗は GET /runners（state: vacating）と GET /managers（runnerId が' +
            '動いたか）で追う。',
          responses: {
            200: jsonResponse(
              '空けると立てた。名簿に無い runnerId でも同じ 200 を返す' +
                '（`RunnerRegistry#unregister` と同じ作法——名乗ってすらいない' +
                '宛先を「無かった」と取り立てて言うほどの情報ではない）。' +
                '**握手を飛ばした回は `handshakeSkipped` が載る**（状態は 200 のまま）。' +
                'runner の名簿を読めなかった（`runner_unreadable`）か、台帳の委譲の一覧を' +
                '読めなかった（`jobs_unreadable`）回で、載っている委譲への確かめた停止の' +
                '握手をしておらず、貸し出しも返していない。**呼び直せば握手をやり直す。**' +
                '飛ばさなかった回は欄が無い（`{ ok: true }` のまま）。',
              runnersVacateResponseSchema,
            ),
            400: errorResponse(
              '`runnerId` が無い、または文字列として不正（`jsonBody` の hook が断る。' +
                'PR #1747 が揃えた形——送られた値は1文字も含めない）。',
            ),
          },
        }),
        jsonBody(runnersVacateCommandSchema, invalidWith('runnerId の形が不正（空けていない）')),
        async (c) => {
          const { runnerId } = c.req.valid('json');
          const { handshakeSkipped } = await clone.managers.vacate(runnerId);
          // 握手を飛ばした回だけ欄を載せる。状態は 200 のまま: 立てたこと自体は成功している。
          return c.json(
            runnersVacateResponseSchema.parse({
              ok: true,
              ...(handshakeSkipped === undefined ? {} : { handshakeSkipped }),
            }),
          );
        },
      )
  );
}
