import type { JournalEntry } from '@alteroid/core';
import { journalEntrySchema, reasonOf, startSseHeartbeat } from '@alteroid/core';
import { writeStderrLine } from '@alteroid/core';
import { survivesDeletion } from './journal-bus.js';
import {
  SSE_SEND_QUEUE_MAX_CHARS,
  SSE_SEND_QUEUE_MAX_ITEMS,
  SseSendQueue,
} from './sse-send-queue.js';
import { describeRoute, resolver } from 'hono-openapi';
import { z } from 'zod';
import { topologyResponseSchema } from './openapi.js';
import { describeProbeError, topologySignature } from './topology.js';
import { Hono } from 'hono';
import type { AppContext } from './app-context.js';
import type { AppDeps } from './app.js';
import type { AuthVariables } from './auth.js';
import {
  INVALID_QUERY_DESCRIPTION,
  jsonResponse,
  errorResponse,
  queryParams,
} from './app-shared.js';

const journalStreamQuery = z.object({
  type: z.string().optional(),
});

export function topologyRoutes(ctx: AppContext, deps: AppDeps) {
  const {
    stores,
    sseHeartbeatMs,
    streamSSE,
    topologyActivity,
    topology,
    topologyTickMs,
    topologyDebounceMs,
    watchSseCredential,
  } = ctx;
  return (
    new Hono<{ Variables: AuthVariables }>()
      // 種別を選り分ける表を持たない（絞り込みは呼ぶ側が指定する）: 見えない層を作らないための口で選別を始めたら意味が消える。
      .get(
        '/journal/stream',
        describeRoute({
          tags: ['journal'],
          summary: '日誌の追記をそのまま流す（SSE）',
          description:
            '日誌に載ったものがそのまま流れる（聞きに行かなくても承認待ちの発生に気づける）。' +
            '**SSE。** `event:` に日誌エントリ種別（`open` に加え、`exchange` / `decision` / ' +
            '`escalation` / `tool_use` / `memory_update` / `daily_report` / ' +
            '`external_event`）、`data:` に日誌エントリ本体（`open` は `{ok:true}` のみ別枠）。' +
            '`type` クエリで絞り込めるが、選り分ける表は持たない（絞り込みは呼ぶ側が決める）。' +
            '**コメント行（`:` で始まる行）の heartbeat が周期的に流れる。SSE の仕様上' +
            'クライアントは読み捨ててよい**（無音のまま死んだ接続を掃除するための送信でもある）。',
          responses: {
            200: {
              description: 'SSE ストリーム。',
              content: { 'text/event-stream': { schema: resolver(journalEntrySchema) } },
            },
            400: errorResponse(INVALID_QUERY_DESCRIPTION),
            503: errorResponse(
              '出来事の流れが配線されていない（能力を落とさず、黙って隠さない）。',
            ),
          },
        }),
        queryParams(journalStreamQuery),
        (c) => {
          const bus = deps.journalEvents;
          if (bus === undefined) {
            return c.json({ error: '出来事の流れが配線されていない' as const }, 503);
          }
          const types = c.req
            .valid('query')
            .type?.split(',')
            .filter((value) => value.length > 0);

          return streamSSE(c, async (stream) => {
            const queue = new SseSendQueue<JournalEntry>();
            let wake: (() => void) | null = null;
            let closed = false;

            const unsubscribe = bus.subscribe((entry) => {
              // 種別の絞りより先に見る: `type=` で墓標を流さない購読でも、溜めた行は捨てる必要があるため
              if (entry.type === 'conversation_deleted') queue.retain(survivesDeletion(entry));
              if (types !== undefined && !types.includes(entry.type)) return;
              queue.push(entry);
              wake?.();
            });

            // `try` は `subscribe()` の直後から始める（`/chat` と同じ理由）。
            try {
              stream.onAbort(() => {
                closed = true;
                wake?.();
              });

              // 資格が使えなくなったら閉じるだけで理由のイベントは流さない: この流れのデータは日誌の1件の形で読まれるので日誌でないものを混ぜない（読み手は切断として扱い、張り直しで 401 を受ける）。
              const credential = watchSseCredential(
                c.get('principal'),
                c.req.header('authorization'),
              );
              const stopHeartbeat = startSseHeartbeat(
                stream,
                sseHeartbeatMs,
                () => wake?.(),
                () => credential.tick(() => wake?.()),
              );

              try {
                await stream.writeSSE({ event: 'open', data: JSON.stringify({ ok: true }) });

                for (;;) {
                  if (closed || credential.lost() || stream.aborted || stream.closed) break;
                  const overflow = queue.overflow;
                  if (overflow !== undefined) {
                    // 新しい種類の出来事にしない: 受け手は流れの出来事を日誌の1件として読むため。コメント行で理由を残して閉じ、受け手の張り直しと取り直しに任せる（#4617）
                    const summary =
                      `日誌の流れ（/journal/stream）の購読者が読むのに追いつかず、待ち行列が上限を超えた` +
                      `（${String(overflow.items)} 件・${String(overflow.chars)} 字。上限 ` +
                      `${String(SSE_SEND_QUEUE_MAX_ITEMS)} 件・` +
                      `${String(SSE_SEND_QUEUE_MAX_CHARS)} 字）。` +
                      '溜めた分を捨ててこの購読を切った。受け手は張り直して表示中のデータを取り直す。';
                    await stream.write(`: ${summary}\n\n`).catch(() => undefined);
                    void stores.journal
                      .append({ type: 'external_event', source: 'journal-stream', summary })
                      .catch((error: unknown) => {
                        writeStderrLine(
                          `alteroidd: 日誌の流れの購読を切ったことを日誌へ残せませんでした: ${reasonOf(error)}\n  ${summary}\n`,
                        );
                      });
                    break;
                  }
                  const item = queue.shift();
                  if (item === undefined) {
                    await new Promise<void>((resolve) => {
                      wake = resolve;
                    });
                    wake = null;
                    continue;
                  }
                  await stream.writeSSE({ event: item.value.type, data: item.data });
                }
              } finally {
                stopHeartbeat();
              }
            } finally {
              unsubscribe();
            }
          });
        },
      )

      // 取れないものは `unknown` と言い、取れたふりをしない。線は最後の活動の時刻だけを返す（「いま流れている」の閾値は読み手が決める）。
      .get(
        '/topology',
        describeRoute({
          tags: ['topology'],
          summary: '稼働の地図（クローン・記憶・runner・マネージャー・作業者と、線の最後の活動）',
          description:
            '走行中・返事待ち・直近10分以内に終わった委譲を、抜粋と文字数の予算で締めて返す' +
            '（全文は `GET /managers/{id}`）。`unknown` は「分からない」であって `ok`/`idle` ではない。' +
            '線は `lastDownAt`（指示・書き込み）/ `lastUpAt`（報告・確認・読み出し）/ ' +
            '`lastActivityAt`（作業者の道具実行）の時刻だけ。作業者は `managerId` × `agentType` で束ねる。' +
            '台帳の行が読めない（版ずれ・手編集）委譲が在るときだけ、`unreadable`（`GET /managers` の ' +
            '`unreadable` と同じ形。issue #2705）を載せる——`managers` が空でも「居ない」とは限らない。' +
            '0件なら鍵ごと無い。',
          responses: {
            200: jsonResponse('稼働の地図。', topologyResponseSchema),
          },
        }),
        async (c) => c.json(topologyResponseSchema.parse(await topology.snapshot())),
      )

      .get(
        '/topology/stream',
        describeRoute({
          tags: ['topology'],
          summary: '稼働の地図の流れ（SSE）',
          description:
            '`event: snapshot` に `GET /topology` と同じ形。開いたとき1回、以後は内容が変わった' +
            'ときだけ送る。**組めなかったときは、失敗が続く間の最初の1回だけ `event: unavailable`' +
            '（`data: {"error": "<種別だけ>"}`。本文は載せない）を送り、立ち直った最初の組み直しは' +
            '内容が同じでも必ず `snapshot` で送る**（黙って止まったように見えない）。**コメント行（`:` で始まる行）の heartbeat が周期的に流れる。**',
          responses: {
            200: {
              description: 'SSE ストリーム。',
              content: { 'text/event-stream': { schema: resolver(topologyResponseSchema) } },
            },
          },
        }),
        (c) =>
          streamSSE(c, async (stream) => {
            let wake: (() => void) | null = null;
            let closed = false;
            let dirty = false;

            const unsubscribeJournal =
              deps.journalEvents?.subscribe(() => {
                dirty = true;
                wake?.();
              }) ?? (() => undefined);
            const unsubscribeWorkerTools = topologyActivity.onChange(() => {
              dirty = true;
              wake?.();
            });
            const unsubscribe = (): void => {
              unsubscribeJournal();
              unsubscribeWorkerTools();
            };

            try {
              stream.onAbort(() => {
                closed = true;
                wake?.();
              });
              const credential = watchSseCredential(
                c.get('principal'),
                c.req.header('authorization'),
              );
              const stopHeartbeat = startSseHeartbeat(
                stream,
                sseHeartbeatMs,
                () => wake?.(),
                () => credential.tick(() => wake?.()),
              );

              try {
                let last: string | null = null;
                let failing = false;
                for (;;) {
                  if (closed || credential.lost() || stream.aborted || stream.closed) break;
                  const fromEvent = dirty;
                  dirty = false;
                  try {
                    // どちらも共有の結果を使う: 購読者が何人でも台帳を読む回数が窓ごとに高々1回。
                    const snapshot = topologyResponseSchema.parse(
                      await topology.snapshot({
                        maxAgeMs: fromEvent ? topologyDebounceMs : 1000,
                      }),
                    );
                    failing = false;
                    const signature = topologySignature(snapshot);
                    if (signature !== last) {
                      last = signature;
                      await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(snapshot) });
                    }
                  } catch (error) {
                    // 理由は種別だけ: 本文は接続先などを含みうる。立ち直ったら内容が同じでも必ず送り直す（`last` を捨てる）。ストリームごとは落とさず次の周期でやり直す。
                    last = null;
                    if (!failing) {
                      failing = true;
                      await stream.writeSSE({
                        event: 'unavailable',
                        data: JSON.stringify({ error: describeProbeError(error) }),
                      });
                    }
                  }
                  if (!dirty) {
                    await new Promise<void>((resolve) => {
                      const timer = setTimeout(resolve, topologyTickMs);
                      wake = () => {
                        clearTimeout(timer);
                        resolve();
                      };
                    });
                    wake = null;
                  }
                  if (dirty && !closed) {
                    await new Promise<void>((resolve) => setTimeout(resolve, topologyDebounceMs));
                  }
                }
              } finally {
                stopHeartbeat();
              }
            } finally {
              unsubscribe();
            }
          }),
      )
  );
}
