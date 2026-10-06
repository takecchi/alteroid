import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import {
  approvalUpdatedAt,
  commitmentUpdatedAt,
  describeAnsweredVia,
  describeDenialFollowUp,
  describeManagerState,
  describeQuestionLines,
  describeReportDriftMark,
  describeSessionMissingKind,
  describeToolUseStall,
  describeTurnEnd,
  describeUnobservedOutcome,
  isFoldedTurnReport,
  JOURNAL_ENTRY_TYPES,
  jobStatusSchema,
  renderApprovalTrace,
  summarizeQuestions,
  usageLayerSchema,
  usageSiteSchema,
  type ApprovalSelection,
  type ApprovalTrace,
  type Commitment,
  type UnreadableApproval,
  type UnreadableCommitment,
  type UnreadableJob,
  type UnreadableSchedule,
  type UsageLayer,
  type UsageSite,
} from '@alteroid/core';
import {
  ARCHIVE_REMOVED_BYTES_UNIT_NOTE,
  describeGithubCi,
  JOURNAL_SEARCH_UNCOVERED_LIST,
} from '@alteroid/core/cli-light';
import {
  CGROUP_EVENTS_UNKNOWN_NOTE,
  formatCgroupEventsNote,
} from '@alteroid/core/cgroup-events-format';
import {
  JOURNAL_DIAGNOSTICS_TYPES,
  summarizeJournalDiagnosticsEntry,
  type JournalDiagnosticsEntryLike,
} from '@alteroid/core/journal-diagnostics-format';
import { describeManagerProvider } from '@alteroid/core/manager-provider-format';
import {
  formatSystemErrorFacts,
  formatSystemErrorUnknownNote,
} from '@alteroid/core/system-error-format';
import {
  describeUnpushedWorkObservationIncompleteness,
  describeUnpushedWorkObservationProvenance,
  describeUnpushedWorkObservationSource,
  isEmptyCompleteUnpushedWorkObservation,
} from '@alteroid/core/unpushed-work-observation-format';
import type { InferResponseType } from 'hono/client';

import {
  AttachmentDraft,
  attachmentLinesOf,
  describeAttachment,
  uploadAttachment,
  uploadDraft,
} from './attachments.js';
import { createClient, type DaemonClient } from './client.js';
import { markConversationReadAfterReply } from './conversations.js';
import { formatElapsedAgo } from './format.js';
import { redactBody, redactError } from './redact.js';
import { formatCreatedAt, freshnessMarker } from './memory.js';
import { parseSSEChunk, type SSEEvent } from './sse-frame.js';
import { describeAuthFailure, resolveTarget, type Target } from './target.js';
import { describeUsageDateOrder, narrowUsageAxis, renderUsage } from './usage.js';

/**
 * `alteroid chat` — クローンとの会話。
 *
 * 3層（日報・日誌・セッションログ）は chat と HTTP API の両方から読める必要が
 * ある（PRD「可観測性」）。chat ではスラッシュコマンドがその入口になり、
 * 普段は `/report` だけ読んで暮らせて、掘りたくなったら `/journal` →
 * `/manager` `/archive` と一本道で降りられる。
 */
export async function chatCommand(): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const base = target.baseUrl;
  const client = createClient(base, target.headers);

  const rl = createInterface({ input: stdin, output: stdout });
  // 次に送る発言へ添えかけのファイル（`/attach`）。
  const draft = new AttachmentDraft();
  let conversationId: string | null = null;
  // 直前に一覧したもの。番号で引けるようにするため覚えておく。
  const listed: Listed = {
    approvals: [],
    managerAnchors: {},
    commitments: [],
    conversations: [],
    managers: [],
    waiting: [],
    messages: [],
    messagesConversationId: null,
  };

  stdout.write('alteroid chat（Ctrl-D で終了 / /help でコマンド）\n');

  try {
    for (;;) {
      let line: string;
      try {
        line = (await rl.question('> ')).trim();
      } catch {
        break; // Ctrl-C
      }
      // 空行は、添えかけが無ければ送らない。あれば添付だけの発言として送る。
      if (line.length === 0 && draft.count === 0) continue;

      if (/^\/(attach|attachments|detach)(\s|$)/.test(line)) {
        await runAttachmentCommand(line, draft);
        continue;
      }

      if (line.startsWith('/')) {
        const handled = await runSlashCommand(line, client, listed, conversationId, target);
        if (handled === 'quit') break;
        continue;
      }

      // 添えかけがあれば先に上げる。失敗したら送らず、添えかけを残して理由を出す。
      let attachmentIds: string[] | undefined;
      if (draft.count > 0) {
        const uploaded = await uploadDraft(draft, (file) => uploadAttachment(target, file));
        if (!uploaded.ok) {
          stdout.write(
            `添付を上げられなかったので送っていません: ${uploaded.reason}\n` +
              '（添えかけは残してあります。/attachments で確認、/detach で外せます）\n',
          );
          continue;
        }
        attachmentIds = uploaded.uploaded.map((a) => a.id);
        for (const a of uploaded.uploaded) stdout.write(`  ${describeAttachment(a)}\n`);
      }
      conversationId = await sendMessage(target, line, conversationId, undefined, {
        ...(attachmentIds === undefined ? {} : { attachments: attachmentIds }),
        // サーバが発言を受けたら添えかけを空にする（受けなかったら残す）。
        onAccepted: () => draft.clear(),
      });
    }
  } finally {
    rl.close();
    if (conversationId) {
      // 会話終了は蒸留の契機（寿命モデル: 蒸留は生存条件）
      await endConversationOnExit(client, target, conversationId);
    }
  }
}

export async function sendMessage(
  target: Target,
  text: string,
  conversationId: string | null,
  /**
   * **送信済みの人間の発言を編集する口**（issue「チャットの送信済み
   * メッセージを編集する」）。値はその発言（自分の過去の `role: inbound`）の
   * 日誌エントリ id。`POST /chat` の本文へそのまま載せる——新しい HTTP 経路は
   * 足さない（案A: 既存の `/chat` に乗せる）。
   */
  supersedes?: string,
  options: {
    /** `POST /attachments` が返した id（発言へ結び付ける）。 */
    attachments?: string[];
    /** サーバが発言を受けた（HTTP 2xx）とき。添えかけを空にする合図。 */
    onAccepted?: () => void;
  } = {},
): Promise<string | null> {
  // SSE は hono/client ではなく生の fetch で受ける（EventSource は POST も
  // ヘッダ付与もできない）。認証ヘッダはここにも要る。
  const response = await fetch(`${target.baseUrl}/chat`, {
    method: 'POST',
    headers: { ...target.headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      conversationId: conversationId ?? undefined,
      ...(supersedes === undefined ? {} : { supersedes }),
      ...(options.attachments === undefined || options.attachments.length === 0
        ? {}
        : { attachments: options.attachments }),
    }),
  });

  if (!response.ok || !response.body) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) {
      stdout.write(`${described}\n`);
      return conversationId;
    }
    // **本文の `error` をそのまま出す。** `supersedes` の検証（400）は4通り
    // あり、どれも「次に何を打てばよいか」まで書いてある（`apps/daemon/src/app.ts`
    // の手前検証）。ここで一律「デーモンが応答しません」に潰すと、`/edit` が
    // クローンの応答を指したときの案内（制約(C)）が人間に届かない。
    stdout.write(`エラー: ${await errorDetail(response)}\n`);
    return conversationId;
  }

  options.onAccepted?.();
  let nextConversationId = conversationId;
  let wrote = false;
  // 返答が最後まで表示されたか（`done` が来て、`error` / `usage_limited` が無かった）。既読にする条件。
  let completed = false;
  let failedOrLimited = false;
  // **本文は改行までためて、行ごとに伏せてから書く**（#2635）。チャンクごとに伏せると、
  // 2つのチャンクにまたがったトークンはどちらの断片も規則に合わずに出る。端末へ書いた
  // ものは取り消せないので、まだ改行の来ていない残りは `pending` に持ち、ほかの出来事の
  // 前と終わりに伏せてから書き出す。本文の網の規則は、どれも1行の中で完結する。
  let pending = '';
  const flushPending = (): void => {
    if (pending === '') return;
    stdout.write(redactBody(pending));
    pending = '';
  };

  for await (const event of readSSE(response.body)) {
    if (event.name !== 'text') flushPending();
    switch (event.name) {
      case 'open': {
        const data = event.json<{ conversationId: string }>();
        if (data) nextConversationId = data.conversationId;
        break;
      }
      case 'text': {
        const data = event.json<{ text: string }>();
        if (data) {
          pending += data.text;
          const lineEnd = pending.lastIndexOf('\n');
          if (lineEnd !== -1) {
            stdout.write(redactBody(pending.slice(0, lineEnd + 1)));
            pending = pending.slice(lineEnd + 1);
          }
          wrote = true;
        }
        break;
      }
      case 'tool': {
        const data = event.json<{ tool: string }>();
        if (data) stdout.write(`\n  · ${data.tool}\n`);
        break;
      }
      case 'ask_human': {
        const data = event.json<{ approvalId: string; question: string }>();
        if (data) {
          stdout.write(`\n  ? 人間への確認（${data.approvalId}）: ${redactBody(data.question)}\n`);
          stdout.write('    /answer <id> <回答> で返せます\n');
        }
        break;
      }
      case 'usage_limited': {
        const data = event.json<{ message: string }>();
        if (data) {
          stdout.write(`\n  ! ${redactError(data.message)}\n`);
          stdout.write(
            '    （この発言は保持されていて、次に枠が開いたときに配り直されて試し直される）\n',
          );
        }
        failedOrLimited = true;
        break;
      }
      case 'done':
        completed = true;
        break;
      case 'error': {
        failedOrLimited = true;
        const data = event.json<{ message: string }>();
        stdout.write(`\nエラー: ${data ? redactError(data.message) : '不明'}\n`);
        break;
      }
      default:
        break;
    }
  }

  flushPending();
  if (wrote) stdout.write('\n');
  if (completed && !failedOrLimited && nextConversationId !== null) {
    await markConversationReadAfterReply(target, nextConversationId);
  }
  return nextConversationId;
}

export { parseSSEChunk, type SSEEvent };

async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseSSEChunk(chunk);
      if (parsed) yield parsed;
      boundary = buffer.indexOf('\n\n');
    }
  }
}

const HELP = `/attach <path>       次に送る発言にファイルを添える（複数回で複数個。本文を打って送ると一緒に上がる。添えかけがあれば空行の Enter で添付だけも送れる）
/attachments         添えかけのファイルの一覧
/detach <番号|all>   添えかけを外す
/report [日付]        日報（既定は直近。日付は YYYY-MM-DD）
/reports [件数]       日報の一覧
/memory              記憶の一覧
/memory <slug>       記憶の中身（書き換えは alteroid memory edit <slug>）
/journal [件数] [type=<種別1,種別2>] [q=<語>]  日誌（新しい順）。q= はそれ以降の行末までを1つの語として扱う
                     type= は ${JOURNAL_ENTRY_TYPES.slice(0, 7).join(' / ')} /
                     ${JOURNAL_ENTRY_TYPES.slice(7).join(' / ')} のカンマ区切り
/conversations [limit=<N>] [scan=<N>]  会話の一覧（新しい順、番号付き）
/conversation <番号|id> [scan=<N>] [includeSuperseded=true]  その会話の中身（古い順。
                     番号は /conversations の並び。includeSuperseded=true でチャットの
                     編集で畳まれた旧発言・その応答も含めて読める）
/edit <番号|id> <新しい本文>  送信済みの自分の発言を編集する（番号は /conversation の並び。
                     クローンの応答は編集できない。編集前のターンの副作用は取り消さない）
/managers [status=<s1,s2>] [limit=<N>] [after=<番号|id>]  マネージャーの一覧（番号付き）と状態
                     status= は ${jobStatusSchema.options.join(' / ')} のカンマ区切り。
                     limit= と after= で古い側へ頁を辿る（after= は直前の /managers に
                     出た番号か id）。何も付けなければ全件（従来どおり）
/manager <番号|id>    そのマネージャーのセッション生ログ（番号は /managers の並び）
/stop <番号|id> [理由]  その仕事だけをやめさせる（止めた事実は日誌に残る）
/waiting             マネージャーの返事待ち一覧（番号付き）
/msg <番号|id> <本文>  マネージャーへ追加指示を送る（質問への回答としては扱われない）
/reply <番号|requestId> <本文>  マネージャーの質問に自分の言葉で答える（番号は /waiting の並び）
/allow [番号|requestId] [理由]  マネージャーの実行許可の確認に許可で答える
/deny  [番号|requestId] [理由]  マネージャーの実行許可の確認に拒否で答える
                     番号・requestId を省くと、返事待ちのマネージャーが1本だけ
                     なら送る（2本以上なら送らずに候補を出す）
/archive             セッションの生ログ一覧（大きさ・時刻つき）
/archive <id>        生ログの中身
/archive sessions    セッションごとの行数・使用量の集計
/archive remove <id> [理由]  生ログの本文だけを消す（行は残り、本文だけが消えた印になる）
                     走行中のマネージャーの退避は既定で拒まれる——理由を付けて
                     もう一度打つと、その理由を記録した上で消せる
/approvals           承認待ち（番号付き）
/approvals all       回答済み・取り下げ済みも含めて見る
/answer <番号|id> <回答>  承認待ちに答える（番号は /approvals の並び）
/answer <番号|id> --select <設問id>=<選択肢id>[,<選択肢id>...] [--other <設問id>=<文>] [補足]
                     設問つきの承認待ちに選んで答える（--select / --other は何度でも書ける。
                     文に空白があれば "..." で囲む。補足の自由文は併用できる。設問は /approval で読む）
/approval <番号|id>  承認待ちを詳しく見る（設問・選択肢・推奨・単一/複数・その他の可否）
/approval-trace <番号|id>  その承認の答えと、答えを受けてクローンが取った行動を対で見る
                     （番号は /approvals の並び。答えが無い・対が無いときは理由が出る）
/answers <番号|id> <回答> [<番号|id> <回答> ...]  溜まった承認待ちにまとめて答える
                     （回答は1語。複数語なら "..." で囲む。1件が駄目でも残りは進み、
                      結果は id ごとに出る）
/commitments         引き受けたまま終わっていない仕事（番号付き）
/commitments all     片付けたものも含めて見る
/commit <本文>       引き受けたことを台帳へ積む
/commit-edit <番号|id> <新しい本文>  台帳の本文を後から直す（番号は /commitments の並び。
                     直せるのは自分が積んだ未了の行だけ——断りの理由はサーバが返す）
/done <番号|id> <理由>  片付けたことを記録する（理由は必須。番号は /commitments の並び）
/usage [from=YYYY-MM-DD] [to=YYYY-MM-DD] [manager=<id>] [layer=<種>] [site=<場所>] [token=<id>]  利用状況（いくら使ったか）
                     layer= は ${usageLayerSchema.options.join(' / ')}、site= は
                     ${usageSiteSchema.options.join(' / ')} のどれか。token= は
                     alteroid token list の id（値の集合は閉じていないため検査しない）
/schedule            時間起点のジョブ・継続中の依頼と次の発火
/schedule <kind> <HH:MM|30m|cron 0 10 * * 1> <依頼>  継続する依頼を仕込む
/unschedule <kind>   継続中の依頼を外す
/run <kind>          定期ジョブを今すぐ起こす
/event <source> [本文]  外部イベントをクローンに届ける（本文が JSON ならその値として）
/quit                終了
`;

/**
 * 直前に一覧したものの id を、番号で引けるように覚えておく置き場。
 *
 * **承認待ち・台帳・会話・マネージャー・待ちで別々に持つ。** 1本にまとめると
 * `/approvals` の直後の `/done 1` が承認待ちの id を閉じに行く（どれも「番号で
 * 指す一覧」なので、混ざったことに人間が気づく手がかりが無い）。会話・マネー
 * ジャー・待ちを足すときも既存のフィールドへ相乗りさせず、独立したフィールド
 * にしてある。
 *
 * **`managers` と `waiting` は別物である（#336）。** 答える相手は「マネージャー」
 * ではなく「その中の1件の確認」なので、番号は待ちの側（`waiting`）に要る。
 * `/managers` の直後に `/reply 1` を打ったとき、マネージャーの id が requestId
 * として使われてはいけない — 1本にまとめていたら、それが起きる。
 */
export interface Listed {
  approvals: string[];
  commitments: string[];
  conversations: string[];
  /** `/managers` の並び。`/manager` `/stop` `/msg` `/managers after=` が引く。 */
  managers: string[];
  /**
   * `/managers` の直前の一覧に出た行の錨（`managerId` → `startedAt`）。
   * `/managers after=<番号|id>` が引く（issue #670）。
   *
   * **`managers` へ相乗りさせず独立に持つ**（この interface の doc の規律）。
   * あちらは `string[]`（`resolveListedId` が番号を引くための並び）で、
   * ここは順序を要らない引き当てである——`GET /managers` の錨は
   * `(afterId, afterStartedAt)` の**組**なので、`managerId` だけでは続きの
   * 起点が決まらない（`apps/daemon/src/app.ts` の `ManagerPagingKey`）。
   *
   * **`startedAt` を人間に打たせない**ためにここが在る。ミリ秒精度の ISO を
   * 手で写させる形は、CLI にだけ「打ち間違えると 400」という段差を作る。
   */
  managerAnchors: Record<string, string>;
  /** `/waiting` の並び。`/reply` `/allow` `/deny` が引く。 */
  waiting: { managerId: string; requestId: string }[];
  /**
   * 直前の `/conversation` が振った、**人間の発言だけ**の番号→id。`/edit` が引く。
   *
   * **クローンの応答（outbound）には番号を振らない。** 編集できるのは人間の
   * 発言だけという制約(C)を、番号選択の時点で自然に満たすためである
   * （サーバ側の 400 はこれをすり抜けた——番号ではなく id を直に打った——
   * 場合の保険であって、ここが主な防御線である）。
   *
   * **既に別の編集で畳まれた発言にも番号を振らない。** 畳まれた発言を再度
   * 指すと、サーバは「既に別の編集に置き換えられている」で 400 を返す
   * （`computeSupersededIds`）。既定の `/conversation` は畳まれた発言を表示
   * しないので、これは自然に満たされる。
   */
  messages: string[];
  /**
   * 上の番号が属する会話 id（`/edit` が `POST /chat` の `conversationId` に
   * 添える）。**`/edit` の対象は「いま話している会話」ではなく「直前に
   * `/conversation` で開いた会話」である**——編集は会話内のどの過去の人間の
   * 発言も対象にできる（直近に限らない）ので、この2つは別物として持つ。
   * まだ何も見ていなければ `null`。
   */
  messagesConversationId: string | null;
}

/**
 * **ここの `!response.ok` は例外を投げない（`stdout.write` して `'ok'` を返す）。**
 * #1641 / PR #1642 で変更系コマンド（`reset.ts` / `access.ts` / `token.ts` /
 * `memory.ts` / `practice.ts` 等）は HTTP の失敗で例外を投げる形に揃えたが、
 * ここは意図して揃えていない——`runSlashCommand` の呼び出し側（`chatCommand`
 * の読み取りループ）に `try/catch` が無く、ここで投げると対話のセッション
 * 全体が落ちるためである（オーナー了承済み）。
 */
export async function runSlashCommand(
  line: string,
  client: ReturnType<typeof createClient>,
  listed: Listed,
  /**
   * いまの会話 id。台帳へ積むときの「どこから来たか」に使う（`Commitment.source`）。
   * まだ一言も話していなければ `null` で、そのときは source を付けない。
   */
  conversationId: string | null = null,
  /**
   * `/edit` が `POST /chat` を叩くのに要る（SSE は hono/client ではなく生の
   * fetch で受けるため。`sendMessage` と同じ理由）。**この関数の他のどの
   * 分岐にも要らない**——ここにしか無い実行時の口（`target.baseUrl` /
   * `target.headers`）を、この1コマンドのためだけに引き回している。
   * 呼び出し元（`chatCommand`）は常に渡すが、テストの大半は `/edit` を
   * 試さないので省略できるよう任意にしてある。
   */
  target?: Target,
): Promise<'ok' | 'quit'> {
  const [command, ...rest] = line.split(/\s+/);

  switch (command) {
    case '/help':
      stdout.write(HELP);
      return 'ok';

    // --- 日報（人間の普段の接点はほぼこれだけ） -----------------------------
    case '/report': {
      const date = rest[0];
      if (date) {
        const response = await client.reports[':date'].$get({ param: { date } });
        if (!response.ok) {
          // 「無い」は 404 だけ。400（日付の形）・5xx を「ありません」と言わない。
          stdout.write(
            `${
              response.status === 404
                ? `${date} の日報はありません`
                : await withDetail(`${date} の日報を読めませんでした`, response)
            }\n`,
          );
          return 'ok';
        }
        const body = await response.json();
        if ('reports' in body) for (const report of body.reports) writeReport(report);
        return 'ok';
      }
      const response = await client.reports.$get({ query: { limit: '1' } });
      if (!response.ok) {
        stdout.write(`${await withDetail('日報を読めませんでした', response)}\n`);
        return 'ok';
      }
      const { reports } = await response.json();
      if (reports.length === 0) {
        stdout.write('（日報はまだありません。/run daily_report で今すぐ作れます）\n');
        return 'ok';
      }
      for (const report of reports) writeReport(report);
      return 'ok';
    }

    case '/reports': {
      const limit = rest[0] ?? '14';
      const response = await client.reports.$get({ query: { limit } });
      if (!response.ok) {
        stdout.write(`${await withDetail('日報を読めませんでした', response)}\n`);
        return 'ok';
      }
      const { reports } = await response.json();
      if (reports.length === 0) stdout.write('（日報はまだありません）\n');
      for (const report of reports) {
        stdout.write(`${renderReportLine(report)}\n`);
      }
      noteIfAtLimit(reports.length, limit, '日報');
      return 'ok';
    }

    // --- 自律（時間起点と外部イベント） -------------------------------------
    /**
     * 引数なしなら一覧、あれば仕込む。
     *
     * **人間の側にも仕込む口を置く。** 外せるのに足せないのは不揃いで、
     * 「クローンに頼めばよい」で済ませると人間の手が API を直に叩くしかなくなる。
     */
    case '/schedule': {
      if (rest.length >= 3) {
        const [kind, ...tail] = rest;
        const parsed = takeWhen(tail);
        if (parsed === null || parsed.request.length === 0) {
          stdout.write(
            '周期は HH:MM（毎日その時刻）／30m・30（分ごと）／cron <5項目>（例: cron 0 10 * * 1）\n',
          );
          return 'ok';
        }
        const created = await client.schedule.$post({
          json: { kind: kind ?? '', request: parsed.request, spec: parsed.spec },
        });
        stdout.write(
          created.ok
            ? `${kind ?? ''} を仕込みました（/schedule で確認できます）\n`
            : `${await withDetail(
                '仕込めませんでした（名前は英小文字・数字・. _ -、既定の定期ジョブの名前は使えません。cron 式なら書式も確かめてください）',
                created,
              )}\n`,
        );
        return 'ok';
      }
      if (rest.length > 0) {
        stdout.write('使い方: /schedule <kind> <HH:MM|30m|cron 0 10 * * 1> <依頼の本文>\n');
        return 'ok';
      }
      const response = await client.schedule.$get();
      if (!response.ok) {
        stdout.write(`${await withDetail('定期ジョブを読めませんでした', response)}\n`);
        return 'ok';
      }
      const { entries, unreadable = [] } = await response.json();
      // 読めない行が在るのに「仕込まれていません」とだけ言わない（issue #2343）。
      if (entries.length === 0) {
        stdout.write(
          unreadable.length === 0
            ? '（定期ジョブは仕込まれていません）\n'
            : '（読めた定期ジョブは仕込まれていません）\n',
        );
      }
      for (const entry of entries) {
        stdout.write(
          `  ${entry.kind}  次: ${entry.nextAt}\n      ${redactBody(entry.description)}\n`,
        );
        // 継続中の依頼だけが持つもの。何を頼まれたままなのかが人間に見えること
        if (entry.request !== undefined) {
          // **概要（何を頼まれたままなのか）。** ここが出ていなかったので、
          // 人間は kind と次の発火時刻しか見えていなかった。
          stdout.write(`      依頼: ${summarizeText(entry.request)}\n`);
        }
        // **「無い」を黙らせない。** 既定の日報・発意はコードに書かれた既定で、
        // 仕込まれたレコードではないので**作成という出来事が存在しない**。
        // 空欄や `—` にすると「取れなかった」と読まれる（探しに行く人が出る）。
        stdout.write(
          entry.createdAt === undefined
            ? '      作成・更新: 無し（コードに書かれた既定の仕込みで、仕込まれた記録がありません）\n'
            : `      作成: ${entry.createdAt}  更新: ${entry.updatedAt ?? entry.createdAt}\n`,
        );
        if (entry.request !== undefined) {
          stdout.write(`      前回: ${entry.lastRunAt ?? '（まだ一度も動いていません）'}\n`);
        }
      }
      const unreadableNote = renderUnreadableScheduleNotice(unreadable);
      if (unreadableNote !== '') stdout.write(`${unreadableNote}\n`);
      return 'ok';
    }

    case '/unschedule': {
      const kind = rest[0];
      if (!kind) {
        stdout.write('使い方: /unschedule <kind>（/schedule で一覧）\n');
        return 'ok';
      }
      const response = await client.schedule[':kind'].$delete({ param: { kind } });
      // 「無い」は 404 だけ。それ以外の失敗を「ありません」と言わない。
      stdout.write(
        `${
          response.ok
            ? `${kind} を外しました`
            : response.status === 404
              ? `${kind} という継続中の依頼はありません（既定の定期ジョブは外せません）`
              : await withDetail(`${kind} を外せませんでした`, response)
        }\n`,
      );
      return 'ok';
    }

    case '/run': {
      const kind = rest[0];
      if (!kind) {
        stdout.write('使い方: /run <kind>（/schedule で一覧）\n');
        return 'ok';
      }
      const response = await client.schedule[':kind'].run.$post({ param: { kind } });
      stdout.write(
        `${
          response.ok
            ? `${kind} を起こしました（結果は日誌・日報に出ます）`
            : response.status === 404
              ? `${kind} という定期ジョブはありません`
              : await withDetail(`${kind} を起こせませんでした`, response)
        }\n`,
      );
      return 'ok';
    }

    case '/event': {
      const [source] = rest;
      if (!source) {
        stdout.write('使い方: /event <source> [本文]（本文が JSON ならその値として届ける）\n');
        return 'ok';
      }
      // 本文は空白を畳まない生の残りを使う（`rest` は空白で割ってあり、JSON の文字列や
      // 本文の中の連続した空白を壊す）。解釈は Web の予定の画面と同じ（issue #3146）。
      const body = line.replace(/^\S+\s+\S+\s*/, '').trimEnd();
      const response = await client.events.$post({
        json: { source, payload: parseEventPayload(body) },
      });
      stdout.write(
        `${
          response.ok
            ? '外部イベントとして届けました（クローンが判断します）'
            : await withDetail('届けられませんでした', response)
        }\n`,
      );
      return 'ok';
    }

    case '/quit':
    case '/exit':
      return 'quit';

    case '/memory': {
      const slug = rest[0];
      if (!slug) {
        const response = await client.memory.$get();
        // 失敗の本文（`{ error }`）に `documents` は無い。確かめずに読むと TypeError で落ちる。
        if (!response.ok) {
          stdout.write(`${await withDetail('記憶の一覧を読めませんでした', response)}\n`);
          return 'ok';
        }
        const { documents } = await response.json();
        if (documents.length === 0) stdout.write('（記憶はまだ空）\n');
        // **表記は `alteroid memory list`（`memory.ts`）に寄せる。** 同じ
        // `GET /memory` を見ながら、ここは slug と title しか出していなかった
        // （#235 はトップレベルの `alteroid memory list` だけを直し、この
        // `chat` の中の重複実装を残していた——同じ記憶を同じセッションの中で
        // 違う答えで出す形になっていた）。新しい言い方を発明せず、
        // `memory.ts` の `formatCreatedAt` / `freshnessMarker` をそのまま使う。
        for (const doc of documents) {
          const marker = freshnessMarker(doc.descriptionFreshness);
          const desc = doc.description === undefined ? '' : ` — ${marker}${doc.description}`;
          stdout.write(
            `  ${doc.slug}  — ${doc.title}` +
              ` (作成: ${formatCreatedAt(doc.createdAt)} / 更新: ${doc.updatedAt})${desc}\n`,
          );
        }
        return 'ok';
      }
      const response = await client.memory[':slug'].$get({ param: { slug } });
      if (!response.ok) {
        // 「無い」は 404 だけ。400（スラッグの形）・5xx を「ありません」と言わない。
        stdout.write(
          `${
            response.status === 404
              ? 'そんな記憶はありません'
              : await withDetail('記憶を読めませんでした', response)
          }\n`,
        );
        return 'ok';
      }
      const body = await response.json();
      if ('document' in body) stdout.write(`${body.document.content}\n`);
      return 'ok';
    }

    case '/journal': {
      // **`q=` は行末までを1つの語として取る**（`parseJournalSearchTokens`）。
      // 語で探す口に空白が入らないのは実用にならない — `/usage` /
      // `/conversations` の `key=value` の慣習は保ったまま、値の側だけ
      // 行末まで伸ばす。
      //
      // **知らない `type=` は 400 を待たずにその場で断る**（`/managers` の
      // `status=` / `/usage` の `layer=`・`site=` と同じ慣習）。デーモンへ
      // 問い合わせる前に `parseJournalSearchTokens` が検査するので、
      // `parsed.ok` を先に見る。
      const parsed = parseJournalSearchTokens(rest);
      if (!parsed.ok) {
        stdout.write(`${parsed.message}\n`);
        return 'ok';
      }
      const { limit: limitToken, q, type } = parsed;
      const limit = limitToken ?? '20';
      const response = await client.journal.$get({
        query: {
          limit,
          ...(type === undefined ? {} : { type }),
          ...(q === undefined ? {} : { q }),
        },
      });
      if (!response.ok) {
        stdout.write(
          `${await withDetail('日誌を読めませんでした（件数 / type= / q= の値を確かめてください）', response)}\n`,
        );
        return 'ok';
      }
      const { entries } = await response.json();
      if (entries.length === 0) {
        // **0件のとき、探す対象に入っていない欄が在ることまで言う**
        // （`journal_read` の同じ場面と同じ扱い）。黙ると「日誌にその語は
        // 無い」と読めるが、実際には tool_use の input に書かれているかも
        // しれない（AGENTS.md「静かに失敗する道具」）。
        //
        // **`type=` で絞った上での0件を「日誌はまだ空」と言わない。** 絞り込み
        // が効いた結果の0件を全体の空と混ぜると、絞りを外せば見えるはずの
        // 日誌まで「無い」と読める（嘘の観測）。
        if (q === undefined && type === undefined) {
          stdout.write('（日誌はまだ空）\n');
        } else if (q === undefined) {
          stdout.write(
            `type=${type} に当たる日誌はありません` + '（絞り込みを外せば見えるかもしれません）\n',
          );
        } else {
          const prefix = type === undefined ? '' : `type=${type} に絞った上で、`;
          stdout.write(
            `${prefix}「${q}」に当たる日誌はありません。` +
              `ただし ${JOURNAL_SEARCH_UNCOVERED_LIST} は探す対象に入っていないので、` +
              'そこにだけ書かれている語はここでは当たりません\n',
          );
        }
      }
      for (const entry of entries) {
        stdout.write(`  ${entry.at}  [${entry.type}] ${summarize(entry)}\n`);
        // **id を出す。** 全 variant が持っているのに、ここでは1度も出て
        // いなかった。日誌の1件を後から名指しで辿る手がかりが無かった。
        stdout.write(`      id: ${entry.id}\n`);
      }
      noteIfAtLimit(entries.length, limit, '日誌');
      return 'ok';
    }

    /**
     * 会話の一覧。**`POST /chat` の SSE は流すだけで、後から読み直す口が
     * chat スラッシュコマンドの側には無かった**（CLI サブコマンドは
     * `alteroid conversations list` / `show` にある）。器（端末・タブ・アプリ）を
     * 替えても続きから話せることは PRD「インターフェース」の等価性そのもの。
     *
     * **`scanned` を必ず出す。** 日誌から組み立てているので、遡り切れていない
     * ことがある（黙って打ち切らない — #108 / #109 と同じ理由）。
     *
     * **`limit=` / `scan=` で窓を広げられる**（`/usage from=… to=…` と同じ
     * `key=value` の慣習。`parseUsageFilters` 参照）。既定は変えていない —
     * 何も指定しなければ従来どおりデーモンの既定（`limit=20` `scan=2000`
     * 相当）のままで、既定の重さを全員に配ってはいない。
     */
    case '/conversations': {
      const raw = parseKeyValueTokens(rest);
      const query = {
        ...(raw.limit === undefined ? {} : { limit: raw.limit }),
        ...(raw.scan === undefined ? {} : { scan: raw.scan }),
      };
      const response = await client.conversations.$get({ query });
      if (!response.ok) {
        stdout.write(
          `${await withDetail('会話の一覧を読めませんでした（limit= / scan= の値を確かめてください）', response)}\n`,
        );
        return 'ok';
      }
      const { conversations, scanned, reachedStart, hiddenByLimit } = await response.json();
      listed.conversations.length = 0;
      if (conversations.length === 0) {
        stdout.write('（会話はまだありません）\n');
      } else {
        conversations.forEach((conversation, index) => {
          listed.conversations.push(conversation.conversationId);
          // **作成（`startedAt`）を足す。** `conversations.ts` の
          // `renderConversationsList` と同じ欠落（#214）。同じ `GET /conversations`
          // を見ながら、こちらの重複実装も `startedAt` を出していなかった。
          stdout.write(
            `  [${index + 1}] ${conversation.conversationId}` +
              `  作成: ${conversation.startedAt}  更新: ${conversation.updatedAt}` +
              `  (${conversation.messages}件)\n`,
          );
          stdout.write(`      ${redactBody(conversation.preview)}\n`);
        });
      }
      // **0件でも scanned を出す。** ここで打ち切ると、0件が「本当に無い」の
      // か「窓の外に残っている（判定できない）」のかを人間が区別できなくなる
      // （#108 / #109 が塞いだ「黙って打ち切る」の再導入）。サブコマンド面
      // （`conversations.ts` の `renderConversationsList`）と同じ形にしてある。
      //
      // **打ち切られているかもしれないなら、広げる手の在り処を示す。** chat
      // 自身も `/conversations scan=<N>` で広げられるが、それでも「これで
      // 全部」ではない（`scan` を増やしても遡り切ったとは限らない）ので、
      // 手の在り処自体は常に示す。手を隠すと、人間は「広げる必要があるかも
      // しれない」ことにすら気づけなくなる。
      stdout.write(
        `  （人間との往復を新しい方から ${scanned} 件見て集計した。これより古い会話は窓の外に` +
          '残っているかもしれません — 判定できません。さらに見るには ' +
          '`/conversations scan=<N>`（表示件数を増やすには limit=<N>。' +
          'alteroid conversations list --scan / --limit でも同じことができます）\n',
      );
      // **`reachedStart` / `hiddenByLimit` も出す（#418 の裏返し）。**
      // `conversations.ts` の `renderConversationsList` と同じ形（`false`
      // のときだけ、`>0` のときだけ）。サーバとクローンの道具は既に言って
      // いるので、この重複実装だけが黙っていると端末では気づけなくなる。
      if (!reachedStart) {
        stdout.write(
          `  （人間との往復を ${scanned} 件遡ったが、先頭には届いていない。これより古い会話が` +
            '残っているかもしれません）\n',
        );
      }
      if (hiddenByLimit > 0) {
        stdout.write(
          `  …ほか ${hiddenByLimit} 件は省略（この窓に ${conversations.length + hiddenByLimit} 件あり、` +
            `新しい順に ${conversations.length} 件だけ出した）。limit=<N> を増やせば出ます\n`,
        );
      }
      if (conversations.length > 0) {
        stdout.write('  /conversation <番号|id> で中身を読めます\n');
      }
      return 'ok';
    }

    case '/conversation': {
      const reference = rest[0];
      if (!reference) {
        stdout.write(
          '使い方: /conversation <番号|id> [scan=<N>] [includeSuperseded=true]' +
            '（番号は /conversations の並び）\n',
        );
        return 'ok';
      }
      const id = resolveListedId(reference, listed.conversations);
      if (id === null) {
        stdout.write(`[${reference}] は /conversations の一覧にありません\n`);
        return 'ok';
      }
      // **`scan=` で窓を広げられる**（`/conversations` と同じ `key=value` の
      // 慣習）。`limit` はこの経路には無い（1件の中身を読むだけで件数の
      // 絞り込みが要らない）。
      //
      // **`includeSuperseded=true` — チャットの編集で既定ビューから畳まれた
      // 旧発言・その応答も含めて読む**（制約(A)。既定は含めない——デーモンの
      // 既定と同じ重さを、指定しなかった呼び出し全部に配らない）。
      const rawQuery = parseKeyValueTokens(rest.slice(1));
      const includeSuperseded = rawQuery.includeSuperseded === 'true';
      const query = {
        ...(rawQuery.scan === undefined ? {} : { scan: rawQuery.scan }),
        ...(includeSuperseded ? { includeSuperseded: 'true' as const } : {}),
      };
      const response = await client.conversations[':id'].$get({ param: { id }, query });
      if (response.status === 404) {
        // **遡り切れた場合だけ 404**（デーモン側の約束）。判定できないときは
        // 200 に空の `messages` と `reachedStart: false` が来る。
        stdout.write(`そんな会話はありません: ${id}\n`);
        return 'ok';
      }
      if (!response.ok) {
        stdout.write(
          `${await withDetail('会話を読めませんでした（scan= の値を確かめてください）', response)}\n`,
        );
        return 'ok';
      }
      const { messages, scanned, reachedStart, supersededCount } = await response.json();
      /**
       * **番号を振り直す。`/edit` がこの並びを引く。**
       *
       * 対象は「まだ畳まれていない、人間の発言」だけである——クローンの
       * 応答は編集できず（制約C）、既に別の編集に置き換えられた発言も
       * サーバの4つ目の検証で弾かれるので、番号選択の時点でどちらも自然に
       * 除ける（`--include-superseded` 相当を付けて畳まれた発言を表示した
       * ときも、その行には番号を振らない）。
       */
      listed.messages.length = 0;
      listed.messagesConversationId = id;
      if (messages.length === 0) {
        stdout.write(
          reachedStart
            ? '（発言はありません）\n'
            : '（この窓には発言が見つかりませんでした。窓の外に残っているかもしれません' +
                '（判定できません） — /conversation <番号|id> scan=<N> で広げられます）\n',
        );
      } else {
        for (const message of messages) {
          const speaker = message.role === 'inbound' ? '人間' : 'クローン';
          const editable = message.role === 'inbound' && message.supersededBy === undefined;
          if (editable) listed.messages.push(message.id);
          const label = editable ? `[${listed.messages.length}]` : '   ';
          // **どれが畳まれた版で、どの編集に置き換えられたかを読める形に
          // する。** `includeSuperseded=true` のときだけ、どちらかが付きうる。
          const edit =
            message.supersededBy !== undefined
              ? `  [畳まれた版 → ${message.supersededBy} に置き換えられた]`
              : message.supersedes !== undefined
                ? `  [編集後の発言 — ${message.supersedes} を置き換えた]`
                : '';
          stdout.write(
            `  ${label} [${message.at}] ${speaker}: ${redactBody(message.text)}${edit}\n`,
          );
          for (const line of attachmentLinesOf(message.attachments)) {
            stdout.write(`         ${redactBody(line)}\n`);
          }
        }
      }
      stdout.write(
        reachedStart
          ? `  （人間との往復を ${scanned} 件遡り、この会話の先頭まで届きました）\n`
          : `  （人間との往復を ${scanned} 件遡りましたが先頭には届いていません。これより古い発言が` +
              '残っているかもしれません — /conversation <番号|id> scan=<N>（または ' +
              'alteroid conversations show --scan）で広げられます）\n',
      );
      // **`includeSuperseded` の値によらず常に出す（0件なら出さない）。**
      // 制約(A)——出ないと、この会話に編集で畳まれた版が在ることに、人間の
      // 側の器も気づけなくなる。
      if (supersededCount > 0) {
        stdout.write(
          `  （この会話にはチャットの編集で畳まれた版が ${supersededCount} 件ある。中身を読むには ` +
            '/conversation <番号|id> includeSuperseded=true で広げられます）\n',
        );
      }
      if (listed.messages.length > 0) {
        stdout.write('  /edit <番号|id> <新しい本文> で自分の発言を編集できます\n');
      }
      return 'ok';
    }

    /**
     * 送信済みの自分（人間）の発言を編集する（issue「チャットの送信済み
     * メッセージを編集する」）。Web UI のチャット画面の鉛筆アイコンと同じ能力
     * を CLI にも出す（north_star「入口の等価性」——画面にしかできないことを
     * 作らない）。
     *
     * **番号は直前の `/conversation` が振ったものだけを引く。** `/conversation`
     * は人間の発言（かつ、まだ畳まれていないもの）にしか番号を振らないので
     * （`Listed.messages` の doc）、番号で指す限り**クローンの応答を編集対象に
     * できない**——制約(C)の主な防御線はここである。id を直に打った場合は
     * この防御を素通りしうるが、そのときはサーバの4種の検証（`apps/daemon/src/app.ts`
     * の `POST /chat`）が 400 で弾き、その理由（`errorDetail`）をそのまま出す。
     *
     * **`conversationId` は「いま話している会話」ではなく「直前に `/conversation`
     * で開いた会話」を使う。** 編集は会話内のどの過去の人間の発言も対象にでき
     * （直近に限らない）、その会話は今の対話中の会話と別物でありうるため
     * （`Listed.messagesConversationId` の doc）。
     *
     * **副作用は一切巻き戻さない（制約B）。** ここは `supersedes` を積んだ
     * `POST /chat` を打つだけで、編集前のターンが起こした記憶・承認待ち・
     * マネージャー・台帳の行には触れない——巻き戻しのロジックは無い。
     */
    case '/edit': {
      const [reference, ...bodyParts] = rest;
      const text = bodyParts.join(' ');
      if (!reference || text.length === 0) {
        stdout.write(
          '使い方: /edit <番号|id> <新しい本文>（番号は /conversation の並び。' +
            '編集できるのは自分（人間）の発言だけです — クローンの応答は指せません）\n',
        );
        return 'ok';
      }
      const id = resolveListedId(reference, listed.messages);
      if (id === null) {
        stdout.write(
          `[${reference}] は直前の /conversation の一覧にありません` +
            '（番号は、その会話でまだ畳まれていない自分の発言だけに振られています）\n',
        );
        return 'ok';
      }
      const owningConversationId = listed.messagesConversationId;
      if (owningConversationId === null) {
        stdout.write('先に /conversation <番号|id> でその発言が含まれる会話を開いてください\n');
        return 'ok';
      }
      if (target === undefined) {
        // **実運用では常に渡る**（`chatCommand` が渡す）。防御的な分岐——
        // このコマンドだけが要る実行時の口（`target`）が無い呼び出しに備える。
        stdout.write('編集を送れませんでした（接続先が分かりません）\n');
        return 'ok';
      }
      await sendMessage(target, text, owningConversationId, id);
      return 'ok';
    }

    /**
     * マネージャーの一覧（issue #670）。
     *
     * **台帳（`jobs`）に行を消す口が無い**ので、ここは「その環境で今までに
     * 起こした委譲の総数」を毎回出す口だった。**直し方は「消す」ではなく
     * 絞り込みと窓である**——上限で古いものを刈る形は north_star 禁止2 に触れる
     * （`packages/core/src/manager.ts` の `#retire` の doc が逐語で禁じている）。
     *
     * **`status=` / `limit=` / `after=` を1つも渡さなければ、応答は従来と
     * 1バイト違わない**（あの口の opt-in は生のクエリで判定される）。既定を
     * 絞らないのは Web と同じ判断で、**到達できない行を作らない**ためである。
     */
    case '/managers': {
      const parsed = parseManagerFilters(rest);
      if (!parsed.ok) {
        stdout.write(`${parsed.message}\n`);
        return 'ok';
      }
      // **錨は組で渡す**（`afterId` だけでは 400）。`startedAt` は人間に打たせず
      // 直前の一覧から引く（`Listed.managerAnchors` の doc）。
      let anchor: { afterId: string; afterStartedAt: string } | undefined;
      if (parsed.after !== undefined) {
        const afterId = resolveListedId(parsed.after, listed.managers);
        const afterStartedAt = afterId === null ? undefined : listed.managerAnchors[afterId];
        if (afterId === null || afterStartedAt === undefined) {
          // **「直前の一覧に無い」と言う。** id を直に書いても、その行が直前の
          // 一覧に出ていなければ `startedAt` が手元に無く、錨を組めない。
          stdout.write(
            `[${parsed.after}] は直前の /managers の一覧にありません` +
              '（after= には直前に出た番号か id を指してください）\n',
          );
          return 'ok';
        }
        anchor = { afterId, afterStartedAt };
      }

      const response = await client.managers.$get({
        query: { ...parsed.query, ...(anchor ?? {}) },
      });
      if (!response.ok) {
        // **400 の本文をそのまま出す。** この口は3つの理由で断る（知らない
        // `status` / 錨の片割れ / 指す行が見当たらない）ので、ひとまとめの
        // 一言に畳むとどれなのかが読めなくなる——次の一手が決まらない。
        stdout.write(`マネージャーの一覧を読めませんでした — ${await errorDetail(response)}\n`);
        return 'ok';
      }
      const { managers, unreadable = [] } = await response.json();
      // **番号を振る。** `/manager` `/stop` `/msg` がこの並びを引く（#336）。
      listed.managers.length = 0;
      listed.managers.push(...managers.map((entry) => entry.managerId));
      // **錨も同じ一覧から作り直す**（`after=` が引く）。前の一覧の分を残すと、
      // いま画面に出ていない行を起点にできてしまい、番号と錨が食い違う。
      for (const key of Object.keys(listed.managerAnchors)) delete listed.managerAnchors[key];
      for (const entry of managers) listed.managerAnchors[entry.managerId] = entry.startedAt;
      stdout.write(`${renderManagerList(managers, parsed.query.status, unreadable)}\n`);
      // **読めない行は「居ない」と分けて言う**（issue #2345）。0件なら何も足さない。
      const unreadableJobNote = renderUnreadableJobNotice(unreadable);
      if (unreadableJobNote !== '') stdout.write(`${unreadableJobNote}\n`);
      // **切ったなら黙らない**（`renderManagersWindowNote` の doc）。
      const note = renderManagersWindowNote(managers.length, parsed.query);
      if (note !== null) stdout.write(note);
      return 'ok';
    }

    /**
     * マネージャーの返事待ち一覧。`/approvals` のマネージャー版（#336）。
     *
     * **`/managers` とは別の番号を振る。** 答える相手は「マネージャー」では
     * なく「その中の1件の確認」で、1本のマネージャーが同時に複数を待つことも
     * ある（並列に呼ばれた道具はそれぞれ別の確認として降りてくる）。
     */
    case '/waiting': {
      const response = await client.managers.$get({
        /**
         * **ここは窓も絞りも渡さない（issue #670）。意図である。**
         *
         * この一覧が数えているのは「マネージャー」ではなく `waiting`（1件の
         * 確認）で、**件数を決めるのは台帳に積まれた委譲の総数ではなく、いま
         * 未回答の確認の数である**——`/managers` を膨らませていた「終端した
         * 委譲も残る」がここには効かない（終端した行の `waiting` は空）。
         *
         * **`status=waiting_human` で絞らない。** 絞れば速くなるが、
         * 「`waiting` が空でない行の `status` は必ず `waiting_human`」を
         * **確かめていない**——`ask` は両方を立て（`record.job.status =
         * 'waiting_human'`）、`settled` と `abort()` は両方を畳むが、
         * `done` / `failed` / `lost` へ落ちる経路が `waiting` を空にしている
         * かは追っていない。⟹ 絞ると、**人間が答えれば進む確認が黙って
         * 一覧から消えうる**（north_star 禁止1）。「判定できない」を
         * 「消してよい」へ倒さない側に置く。
         */
        query: {},
      });
      if (!response.ok) {
        stdout.write(`${await withDetail('マネージャーの一覧を読めませんでした', response)}\n`);
        return 'ok';
      }
      const { managers } = await response.json();
      const { text, entries } = renderWaitingList(managers);
      listed.waiting.length = 0;
      listed.waiting.push(...entries);
      stdout.write(`${text}\n`);
      if (entries.length > 0) {
        stdout.write(
          '  /reply <番号|requestId> <本文> で質問に答える、' +
            '/allow /deny [番号|requestId] [理由] で実行許可に答えられます' +
            '（1本だけなら番号無しでも打てます）\n',
        );
      }
      return 'ok';
    }

    /**
     * この仕事だけをやめさせる。
     *
     * **`/managers` で状態を読めるのに、止める手が CLI に無かった。** 画面
     * （`apps/web/app/routes/manager-detail.tsx`）にはあり、PRD「インターフェース」は
     * 3面で同じことができると書いている（起こせることの列挙に「委譲の停止」がある）。
     * 読めるだけで手が出せない面があると、その面の人間は器ごと落とすしかなくなり、
     * 関係の無い仕事まで道連れになる（それがこの口の存在理由そのものである）。
     *
     * **理由を書ける形にしてある。** 止めた事実は日誌に残るので、そこに「なぜ」が
     * 無いと、後から見た人間（とクローン）が判断を再構成できない。
     */
    case '/stop': {
      const reference = rest[0];
      if (!reference) {
        stdout.write('使い方: /stop <番号|manager_id> [理由]\n');
        return 'ok';
      }
      const id = resolveListedId(reference, listed.managers);
      if (id === null) {
        stdout.write(`[${reference}] は /managers の一覧にありません\n`);
        return 'ok';
      }
      const reason = rest.slice(1).join(' ').trim();
      const response = await client.managers[':id'].$delete({
        param: { id },
        // 空文字を送らない（`reason` は `min(1)`）。**書かなかったことを空文字で
        // 埋めると、日誌に「理由：（空）」が残って、書き忘れと区別が付かない。**
        json: reason === '' ? {} : { reason },
      });
      if (!response.ok) {
        // 404 だけ「見つからない」と言う。それ以外（400・5xx 等）はサーバの
        // 理由（`errorDetail`）をそのまま出す — 状態コードだけを見せて
        // 「打ち間違えた」と誤読させない（issue #2172、`/commit-edit` と同じ形）。
        stdout.write(
          `${
            response.status === 404
              ? `そのマネージャーは見つかりませんでした: ${id}`
              : await errorDetail(response)
          }\n`,
        );
        return 'ok';
      }
      // **応答をそのまま出す。** 「止めた」と言い換えると、器の側が別の結果
      // （既に終わっていた等）を返しても同じ顔になる。
      const { outcome, detail } = await response.json();
      stdout.write(`${outcome}: ${detail}\n`);
      return 'ok';
    }

    case '/manager': {
      // 日誌で足りないときに、manager_id からそのセッションの生ログへ降りる
      const reference = rest[0];
      if (!reference) {
        stdout.write('使い方: /manager <番号|manager_id>\n');
        return 'ok';
      }
      const id = resolveListedId(reference, listed.managers);
      if (id === null) {
        stdout.write(`[${reference}] は /managers の一覧にありません\n`);
        return 'ok';
      }
      const response = await client.managers[':id'].transcript.$get({ param: { id } });
      if (!response.ok) {
        // 「まだ無い」は 404 だけ。5xx 等を「まだありません」と言わない。
        stdout.write(
          `${
            response.status === 404
              ? 'そのマネージャーの生ログはまだありません'
              : await withDetail('そのマネージャーの生ログを読めませんでした', response)
          }\n`,
        );
        return 'ok';
      }
      stdout.write(`${redactBody(await response.text())}\n`);
      return 'ok';
    }

    /**
     * 追加指示。**`requestId` も `decision` も付けない。**
     *
     * これが `/reply` と分かれている理由そのもの — マネージャーが確認を待って
     * いても、この一言は回答として消費されず、追加指示として流れる
     * （`packages/core/src/manager.ts` の `send` の doc「宛先を推測しない」）。
     * ここで `requestId`/`decision` を足すと、待ちが在るときに追加指示が
     * 回答へ化ける形になり、#313 と同じ穴を CLI 側に開けることになる。
     */
    case '/msg': {
      const [reference, ...bodyParts] = rest;
      const text = bodyParts.join(' ');
      if (!reference || text.length === 0) {
        stdout.write('使い方: /msg <番号|manager_id> <本文>\n');
        return 'ok';
      }
      const id = resolveListedId(reference, listed.managers);
      if (id === null) {
        stdout.write(`[${reference}] は /managers の一覧にありません\n`);
        return 'ok';
      }
      const response = await client.managers[':id'].messages.$post({
        param: { id },
        json: { text },
      });
      if (!response.ok) {
        // 404 だけ「見つからない」と言う。それ以外はサーバの理由をそのまま出す
        // （issue #2172、`/commit-edit` と同じ形）。
        stdout.write(
          `${
            response.status === 404
              ? `そのマネージャーは見つかりませんでした: ${id}`
              : await errorDetail(response)
          }\n`,
        );
        return 'ok';
      }
      const { outcome, detail } = await response.json();
      stdout.write(`${outcome}: ${detail}\n`);
      return 'ok';
    }

    /**
     * マネージャーの質問（`AskUserQuestion`）に、人間が自分の言葉で答える。
     *
     * **`requestId` だけを添える。`decision` は付けない** — 質問には
     * 許可/拒否の意思が無い（`apps/web` の `QuestionWaitingRow` と同じ約束）。
     */
    case '/reply': {
      const [reference, ...bodyParts] = rest;
      const text = bodyParts.join(' ');
      if (!reference || text.length === 0) {
        stdout.write('使い方: /reply <番号|requestId> <本文>\n');
        return 'ok';
      }
      const target = await resolveWaitingTarget(reference, listed.waiting, client);
      if (!target.ok) {
        stdout.write(`${target.message}\n`);
        return 'ok';
      }
      const response = await client.managers[':id'].messages.$post({
        param: { id: target.managerId },
        json: { text, requestId: target.requestId },
      });
      if (!response.ok) {
        // 404 だけ「見つからない」と言う。それ以外はサーバの理由をそのまま出す
        // （issue #2172、`/commit-edit` と同じ形）。
        stdout.write(
          `${
            response.status === 404
              ? `そのマネージャーは見つかりませんでした: ${target.managerId}`
              : await errorDetail(response)
          }\n`,
        );
        return 'ok';
      }
      const { outcome, detail } = await response.json();
      stdout.write(`${outcome}: ${detail}\n`);
      return 'ok';
    }

    /**
     * 実行許可の確認に答える（許可／拒否）。
     *
     * **引数が1つも無ければ「宛先を書かずに decision だけ送る」形になる**
     * （#336）。番号|requestId の形は第1引数が常に宛先になるので、この分岐
     * だけがその形を表す。宛先を CLI 側で当てずに、デーモンの
     * `#choosePending`（`packages/core/src/manager.ts`）へそのまま委ねる —
     * ただし `#choosePending` はマネージャー1本の中の曖昧さしか見ない
     * （HTTP の経路が `managerId` を要求するため）。**どのマネージャーへ送る
     * かは CLI 側で決めなければならず、そこは絶対に当てない** — 返事待ちの
     * マネージャーが2本以上あれば、どちらへも送らずに候補を出す。1本だけなら
     * その1本へ decision だけを渡し、複数の確認を待っていた場合はデーモンが
     * requestId の一覧を添えて断ってくる（その応答をそのまま出す）。
     *
     * **理由（本文）は省略できる。** 未指定なら Web UI の固定文言
     * （`apps/web/app/routes/manager-detail.tsx` の `PermissionWaitingRow`）に
     * 揃える。理由を必須にすると、API が要求していない制約を CLI 側で足す
     * ことになる（north_star 禁止2）。
     */
    case '/allow':
    case '/deny': {
      const decision: 'allow' | 'deny' = command === '/allow' ? 'allow' : 'deny';
      const defaultText = decision === 'allow' ? '許可する' : '許可しない';

      if (rest.length === 0) {
        const target = await resolveDecisionOnlyManager(client);
        if (!target.ok) {
          stdout.write(`${target.message}\n`);
          return 'ok';
        }
        const response = await client.managers[':id'].messages.$post({
          param: { id: target.managerId },
          json: { text: defaultText, decision },
        });
        if (!response.ok) {
          // 404 だけ「見つからない」と言う。それ以外はサーバの理由をそのまま出す
          // （issue #2172、`/commit-edit` と同じ形）。
          stdout.write(
            `${
              response.status === 404
                ? `そのマネージャーは見つかりませんでした: ${target.managerId}`
                : await errorDetail(response)
            }\n`,
          );
          return 'ok';
        }
        const { outcome, detail } = await response.json();
        stdout.write(`${outcome}: ${detail}\n`);
        return 'ok';
      }

      const [reference, ...reasonParts] = rest;
      const reason = reasonParts.join(' ');
      const target = await resolveWaitingTarget(reference ?? '', listed.waiting, client);
      if (!target.ok) {
        stdout.write(`${target.message}\n`);
        return 'ok';
      }
      const response = await client.managers[':id'].messages.$post({
        param: { id: target.managerId },
        json: {
          text: reason.length === 0 ? defaultText : reason,
          requestId: target.requestId,
          decision,
        },
      });
      if (!response.ok) {
        // 404 だけ「見つからない」と言う。それ以外はサーバの理由をそのまま出す
        // （issue #2172、`/commit-edit` と同じ形）。
        stdout.write(
          `${
            response.status === 404
              ? `そのマネージャーは見つかりませんでした: ${target.managerId}`
              : await errorDetail(response)
          }\n`,
        );
        return 'ok';
      }
      const { outcome, detail } = await response.json();
      stdout.write(`${outcome}: ${detail}\n`);
      return 'ok';
    }

    case '/archive': {
      // 可観測性の最下段。日誌で足りないときの最後の拠り所へ、chat から降りられる。
      const sub = rest[0];

      // sessionId ごとの行数・使用量の集計(#698)。⭐ 依頼の動機そのもの
      // ——「1本が何度積まれているか」は、個々の大きさより先に問題を特定する。
      if (sub === 'sessions') {
        const response = await client.archive.sessions.$get();
        if (!response.ok) {
          stdout.write(`${await withDetail('アーカイブの集計を読めませんでした', response)}\n`);
          return 'ok';
        }
        const { sessions } = await response.json();
        if (sessions.length === 0) stdout.write('（生ログはまだありません）\n');
        for (const session of sessions) {
          stdout.write(
            `  ${session.sessionId}  行数: ${session.rows}` +
              `  使用量合計: ${session.storedBytes}バイト（最大1行: ${session.maxStoredBytes}バイト）` +
              `  ${session.firstAt} 〜 ${session.lastAt}\n`,
          );
        }
        return 'ok';
      }

      /**
       * 本文だけを消す（tombstone。行は残る。#698 で HTTP/クローンの道具に
       * 入った `remove` を、人間の対話面（CLI）へも出す（#776）。
       *
       * **走行中のマネージャーの退避は既定で拒まれる。** `overrideReason` を
       * 付けずに叩いて 409 が返ったら、サーバの断り文言をそのまま出し
       * （`/done` 等と同じ「応答をそのまま出す」約束）、理由を付けて打ち直す
       * 形を案内する——黙って失敗させない。
       */
      if (sub === 'remove') {
        const removeId = rest[1];
        if (!removeId) {
          stdout.write('使い方: /archive remove <id> [理由]\n');
          return 'ok';
        }
        const reason = rest.slice(2).join(' ').trim();
        const response = await client.archive[':id'].$delete({
          param: { id: removeId },
          // 空文字を送らない（/stop と同じ約束——書かなかったことと空文字を
          // 区別する）。
          query: reason === '' ? {} : { overrideReason: reason },
        });
        if (response.status === 404) {
          stdout.write('その生ログはありません\n');
          return 'ok';
        }
        if (response.status === 409) {
          stdout.write(
            `${await errorDetail(response)}\n` +
              `理由を付けて上書きするには: /archive remove ${removeId} <理由>\n`,
          );
          return 'ok';
        }
        if (!response.ok) {
          // 404・409 以外（400・5xx 等）はサーバの理由（`errorDetail`）をそのまま出す
          // （issue #2172 / PR #2175 と同じ形）。状態コードだけでは何が悪いか分からない。
          stdout.write(`${await errorDetail(response)}\n`);
          return 'ok';
        }
        const result = await response.json();
        const overrideNote =
          result.override !== undefined
            ? `（⚠️ override — 走行中のマネージャー ${result.override.managerId} の退避を、` +
              `理由「${redactBody(result.override.reason)}」で消しました）`
            : '';
        stdout.write(
          `${result.alreadyRemoved ? '前から消されていました' : '消しました'}` +
            `（${result.bytes}バイト。${ARCHIVE_REMOVED_BYTES_UNIT_NOTE}）${overrideNote}\n`,
        );
        return 'ok';
      }

      const id = sub;
      if (!id) {
        const response = await client.archive.$get();
        if (!response.ok) {
          stdout.write(`${await withDetail('アーカイブを読めませんでした', response)}\n`);
          return 'ok';
        }
        const { entries } = await response.json();
        if (entries.length === 0) stdout.write('（生ログはまだありません）\n');
        for (const entry of entries) {
          const removedNote = entry.removedAt !== undefined ? '（本文は削除済み）' : '';
          stdout.write(`  ${entry.id}  ${entry.storedBytes}バイト  ${entry.at}${removedNote}\n`);
        }
        return 'ok';
      }
      const response = await client.archive[':id'].$get({ param: { id } });
      if (!response.ok) {
        // 「無い」は 404 だけ。5xx 等を「ありません」と言わない。
        stdout.write(
          `${
            response.status === 404
              ? 'その生ログはありません'
              : await withDetail('その生ログを読めませんでした', response)
          }\n`,
        );
        return 'ok';
      }
      stdout.write(`${redactBody(await response.text())}\n`);
      return 'ok';
    }

    /**
     * 溜まった保留を人間がまとめて片付けるための一覧。番号を振るのは、
     * 人間が席に戻ったときに UUID を写す作業をさせないためである。
     */
    case '/approvals': {
      // **`all` で回答済み・取り下げ済みも含める（#963。`/commitments all` と
      // 同じ約束）。** 既定は未回答かつ未取り下げのみ——番号を振って
      // `/answer` に使わせる一覧を、答えようがない行で埋めないため。
      const includeSettled = rest[0] === 'all';
      // **`order` を明示して呼ぶ。窓（`limit` / `cursor`）は作らない。**
      // 直しているのは並びの不安定さであって、件数の可視化ではない（ここは全件を
      // 受け取っているので、応答へ載る `total` は受け取った配列の長さと必ず一致する
      // 冗長な値である。**だから出さない**）。
      //
      // どれも渡さない呼びはストアの生の並びがそのまま返り、その並びは実装ごとに
      // 違う — `storage-fs` / `testing.ts` は挿入順（`putApproval` が既存の id を
      // 末尾へ動かす）、`storage-pg` は `createdAt` の昇順。⟹ **どの永続化層で
      // 動いているかで並びが変わっていた。** `order` を明示するとデーモンが
      // `(createdAt, id)` の昇順へ揃えるので、実装によらず同じ順になる。
      //
      // **ここで番号を振って `/approve <番号>` に使わせている以上、並びが動くのは
      // そのまま誤爆の経路である**（人間が見た番号と、次に打つ番号がずれる）。
      const response = await client.approvals.$get({
        query: { order: 'asc', ...(includeSettled ? { pending: 'false' as const } : {}) },
      });
      if (!response.ok) {
        stdout.write(`${await withDetail('承認待ちを読めませんでした', response)}\n`);
        return 'ok';
      }
      const { approvals, unreadable = [] } = await response.json();
      listed.approvals.length = 0;
      if (approvals.length === 0) {
        // 読めない行が在るのに「ありません」とだけ言わない（issue #2298）。
        stdout.write(
          unreadable.length === 0
            ? '（承認待ちはありません）\n'
            : '（読めた承認待ちはありません）\n',
        );
        const note = renderUnreadableApprovalNotice(unreadable);
        if (note !== '') stdout.write(`${note}\n`);
        return 'ok';
      }
      approvals.forEach((approval, index) => {
        listed.approvals.push(approval.id);
        // **札は質問の1行目。** 全文をそのまま先頭行へ出していたので、改行を
        // 含む質問では `[1] ` の行が途中で折れて、番号と質問の対応が崩れていた
        // （クローン側は #215 で1行目を札にしてある）。
        //
        // **残りの行は落とさない。** CLI は人間へ返す口なので、切れば能力を削る
        // （north_star 禁止1）。札の下へそのまま続ける。
        const [head, ...restLines] = redactBody(approval.question).split('\n');
        stdout.write(`  [${index + 1}] ${head ?? ''}\n`);
        for (const line of restLines) stdout.write(`      ${line}\n`);
        stdout.write(
          `      id: ${approval.id}  作成: ${approval.createdAt}` +
            `  更新: ${approvalUpdatedAt(approval)}\n`,
        );
        if (approval.jobId) stdout.write(`      マネージャー: ${approval.jobId}\n`);
        if (approval.context) stdout.write(`      背景: ${summarizeText(approval.context)}\n`);
        // **設問は件数だけ（一覧は短く。issue #2525）。** 選択肢・推奨・id は `/approval` で読む。
        if (approval.questions !== undefined && approval.questions.length > 0) {
          stdout.write(
            `      ${summarizeQuestions(approval.questions)}` +
              `（/approval ${index + 1} で選択肢を読める）\n`,
          );
        }
        // **取り下げ済み・回答済みの状態を出す（#963）。** `/approvals all` で
        // 初めて視界に入る2状態——`approval_withdraw` はクローンが起こす行為
        // なので人間に取り下げボタンは無いが、取り下げられた事実と理由は
        // CLI からも読めること（issue #963 §5「少なくとも…読めることは要る」
        // をこの口にも揃える）。
        if (approval.withdrawnAt) {
          stdout.write(`      状態: 取り下げ済み（${approval.withdrawnAt}）\n`);
          stdout.write(
            `      取り下げた理由: ${approval.withdrawnReason === undefined || approval.withdrawnReason === null ? '（理由の記録なし）' : redactBody(approval.withdrawnReason)}\n`,
          );
        } else if (approval.answeredAt) {
          stdout.write(`      状態: 回答済み（${approval.answeredAt}）\n`);
          if (approval.answer) stdout.write(`      回答: ${redactBody(approval.answer)}\n`);
          // **回答経路（Issue #1479）。** 記録が無い（古い経路で答えられた）行では
          // 出さない——「わからない」を「operator ではない」に化けさせない。
          if (approval.answeredVia) {
            stdout.write(`      回答経路: ${describeAnsweredVia(approval.answeredVia)}\n`);
          }
        }
        // **この確認が上がった会話を辿れるようにする（issue #877）。** Web の
        // 承認画面（`apps/web/app/routes/approvals.tsx` の `ConversationPanel`）
        // は `approval.conversationId` から会話を復元して出すが、CLI はここが
        // 空で、`/approvals` を見ても`ask_human` の問いがどの会話から出たのか
        // 辿る手がかりが無かった。**`GET /approvals` は元から
        // `conversationId` を返している**（#773／`pendingApprovalSchema`）ので、
        // 読み側だけで揃う。
        //
        // **会話の中身はここでは出さない。** 一覧に本文を全文で載せると件数で
        // 溢れる（north_star 禁止1、地雷表「エージェントへ返す一覧に本文を
        // 全文で載せる」）うえ、承認1件ごとに会話を1本取りに行く形は承認が
        // 溜まるほどリクエストが線形に増える（同じ issue が範囲外として
        // 挙げている懸念そのもの）。CLI には既に会話の中身を読む専用コマンド
        // （`/conversation <番号|id>`。id は生の文字列も直接渡せる——
        // `resolveListedId` 参照）があるので、ここでは id を出して案内するだけ
        // にする。
        stdout.write(
          approval.conversationId
            ? `      会話: ${approval.conversationId}` +
                `（/conversation ${approval.conversationId} で読めます）\n`
            : '      会話: 紐づいていない' +
                '（マネージャー発・内部ターンには紐づけられる会話が存在しない）\n',
        );
      });
      stdout.write('  /answer <番号> <回答> で答えられます（答えた仕事だけが再開します）\n');
      const unreadableNote = renderUnreadableApprovalNotice(unreadable);
      if (unreadableNote !== '') stdout.write(`${unreadableNote}\n`);
      return 'ok';
    }

    /**
     * 承認の答えと、その後にクローンが取った行動を対で見る（issue #847 の案B）。
     *
     * **デーモンの `GET /approvals/:id/trace` を読み、クローンの `approval_trace` と
     * 同じ `renderApprovalTrace` で文字にする**——口ごとに出す中身を違えない。
     * 違うのは切らないことだけ（人間へ返す口なので、抜粋にすれば能力を削る。
     * north_star 禁止1）。
     */
    case '/approval-trace': {
      const [reference] = rest;
      if (!reference) {
        stdout.write('使い方: /approval-trace <番号|id>\n');
        return 'ok';
      }
      const id = resolveListedId(reference, listed.approvals);
      if (id === null) {
        stdout.write(`[${reference}] は /approvals の一覧にありません\n`);
        return 'ok';
      }
      const response = await client.approvals[':id'].trace.$get({ param: { id } });
      if (response.status === 404) {
        stdout.write(`承認 ${id} はありません\n`);
        return 'ok';
      }
      if (!response.ok) {
        stdout.write(`${await withDetail('承認の答えと行動の対を読めませんでした', response)}\n`);
        return 'ok';
      }
      const trace = (await response.json()) as ApprovalTrace;
      stdout.write(
        `${redactBody(
          renderApprovalTrace(trace, {
            budget: null,
            summaryLimit: null,
            detailHint: '（行動は日誌の行の全文。前後の文脈は /journal で読めます）',
          }),
        )}\n`,
      );
      return 'ok';
    }

    /**
     * 承認待ち1件の詳細（issue #2525）。`/approvals` は件数だけにして短く保ち、設問と選択肢
     * （推奨の印・単一か複数か・その他を書けるか・答えるときの id）はここで全部出す。
     * 回答済み・取り下げ済みの件も開ける（番号は `/approvals` の並び）。
     */
    case '/approval': {
      const reference = rest[0];
      if (!reference) {
        stdout.write('使い方: /approval <番号|id>\n');
        return 'ok';
      }
      const id = resolveListedId(reference, listed.approvals);
      if (id === null) {
        stdout.write(`[${reference}] は /approvals の一覧にありません\n`);
        return 'ok';
      }
      const response = await client.approvals.$get({ query: { order: 'asc', pending: 'false' } });
      if (!response.ok) {
        stdout.write(`${await withDetail('承認待ちを読めませんでした', response)}\n`);
        return 'ok';
      }
      const { approvals } = await response.json();
      const approval = approvals.find((entry) => entry.id === id);
      if (approval === undefined) {
        stdout.write(`[${reference}] （${id}）は見つかりませんでした\n`);
        return 'ok';
      }
      stdout.write(`  ${redactBody(approval.question)}\n`);
      stdout.write(`      id: ${approval.id}  作成: ${approval.createdAt}\n`);
      if (approval.context) stdout.write(`      背景: ${redactBody(approval.context)}\n`);
      if (approval.withdrawnAt) {
        stdout.write(`      状態: 取り下げ済み（${approval.withdrawnAt}）\n`);
      } else if (approval.answeredAt) {
        stdout.write(`      状態: 回答済み（${approval.answeredAt}）\n`);
        if (approval.answer) stdout.write(`      回答: ${redactBody(approval.answer)}\n`);
      }
      if (approval.questions === undefined || approval.questions.length === 0) {
        stdout.write('      （設問はありません。/answer <番号> <回答> で自由文で答えます）\n');
        return 'ok';
      }
      for (const questionLine of describeQuestionLines(approval.questions)) {
        stdout.write(`      ${redactBody(questionLine)}\n`);
      }
      stdout.write(
        '      答え方: /answer <番号> --select <設問id>=<選択肢id>[,<選択肢id>...]' +
          ' [--other <設問id>=<文>] [補足]\n',
      );
      return 'ok';
    }

    case '/answer': {
      const [reference, ...answerParts] = rest;
      if (!reference) {
        stdout.write('使い方: /answer <番号|id> <回答>\n');
        return 'ok';
      }
      const id = resolveListedId(reference, listed.approvals);
      if (id === null) {
        stdout.write(`[${reference}] は /approvals の一覧にありません\n`);
        return 'ok';
      }
      // **構造化した回答として読むのは、その承認待ちが設問（`questions`）を持つときだけ**
      // （issue #2583）。`--select` / `--other` の字面が行にあるときだけ、その1件を取ってきて
      // 確かめる。設問の無い承認待ちには、残り全部を今までどおり1つの自由文として送る
      // （引用符も解釈しない）。**取れなかったときに黙って自由文へ倒さない** — 設問つきの
      // 承認待ちへ、構造化のつもりの字面をそのまま自由文として送ってしまうため。
      let structured: ReturnType<typeof parseStructuredAnswer> | null = null;
      if (/(^|\s)--(select|other)(=|\s|$)/.test(line)) {
        const lookup = await client.approvals.$get({ query: { order: 'asc', pending: 'false' } });
        if (!lookup.ok) {
          stdout.write(
            `${await withDetail('承認待ちを読めなかったので、回答を送っていません', lookup)}\n`,
          );
          return 'ok';
        }
        const { approvals } = await lookup.json();
        const target = approvals.find((entry) => entry.id === id);
        if (target === undefined) {
          stdout.write(`[${reference}] （${id}）は見つからなかったので、回答を送っていません\n`);
          return 'ok';
        }
        if (target.questions !== undefined && target.questions.length > 0) {
          structured = parseStructuredAnswer(
            tokenizeWithQuotes(line.replace(/^\S+\s*/, '')).slice(1),
          );
        }
      }
      if (structured !== null && 'error' in structured) {
        stdout.write(`${redactError(structured.error)}\n`);
        return 'ok';
      }
      const answer = structured === null ? answerParts.join(' ') : structured.supplement;
      if (answer.length === 0 && structured === null) {
        stdout.write('使い方: /answer <番号|id> <回答>\n');
        return 'ok';
      }
      const response = await client.approvals[':id'].answer.$post({
        param: { id },
        json:
          structured === null
            ? { answer }
            : {
                selections: structured.selections,
                ...(answer.length === 0 ? {} : { answer }),
              },
      });
      stdout.write(
        `${response.ok ? '回答しました' : await withDetail('回答に失敗しました', response)}\n`,
      );
      return 'ok';
    }

    /**
     * 溜まった承認待ちにまとめて答える（`POST /approvals/answer`）。
     *
     * **`/answer` は変えない。** あれは「番号|id と、残り全部を1つの自由文として
     * 答える」形で、複数件を1行に混ぜようとすると自由文とどこで区切るかが
     * 決められない（引用符を要求すると今の使い方を壊す）。だから複数件は
     * 別コマンドにして、**各件の回答は1語（複数語なら引用符で囲む）** という
     * 別の約束にする。/answer の自由文はそのまま残る。
     *
     * **1件飛ばせる**（対象の番号を書かなければ良い）・**途中でやめられる**
     * （書いた分だけで Enter を押せば良い）ので、一覧を全部読んで一括で allow
     * するしかない、という形にはならない。
     */
    case '/answers': {
      // `line` は先頭で `/\s+/` 分割済みだが、それでは引用符の中の空白が
      // 保てない。引用符を活かすため、コマンド名の後ろの生の文字列から読み直す。
      const argsText = line.replace(/^\S+\s*/, '');
      const tokens = tokenizeQuoted(argsText);
      const pairs = parseAnswerPairs(tokens);
      if (pairs === null) {
        stdout.write(
          '使い方: /answers <番号|id> <回答> [<番号|id> <回答> ...]' +
            '（回答は1語。複数語なら "..." で囲む）\n',
        );
        return 'ok';
      }

      const requests: { id: string; answer: string }[] = [];
      for (const pair of pairs) {
        const id = resolveListedId(pair.reference, listed.approvals);
        if (id === null) {
          stdout.write(`  [${pair.reference}] は /approvals の一覧にありません（飛ばしました）\n`);
          continue;
        }
        requests.push({ id, answer: pair.answer });
      }

      if (requests.length === 0) {
        stdout.write('送れる回答がありませんでした\n');
        return 'ok';
      }

      const response = await client.approvals.answer.$post({ json: { answers: requests } });
      if (!response.ok) {
        stdout.write(
          `${await withDetail('まとめて答えられませんでした（サーバ側の検査に落ちました）', response)}\n`,
        );
        return 'ok';
      }
      // **成功件数だけを言わない。** 1件が駄目でも残りは進む設計なので、
      // どの id が通らなかったかを人間が見られること。
      const { results } = await response.json();
      for (const result of results) {
        stdout.write(
          result.ok
            ? `  [${result.id}] 回答しました\n`
            : `  [${result.id}] 回答に失敗: ${result.error === undefined ? '不明' : redactError(result.error)}\n`,
        );
      }
      return 'ok';
    }

    /**
     * 引き受けたまま終わっていない仕事の台帳（`schema.ts` の `commitmentSchema`）。
     *
     * **承認待ちとは別のものである。** あちらは「クローンが人間の答えを待って
     * 止まっている」で、こちらは「頼まれたことがまだ片付いていない」。止まって
     * いなくても片付いていない仕事はあるので、片方で他方は代用できない。
     *
     * 既定では未了だけを出す。`all` で片付けたものも出すのは、日報の材料に
     * なるのが「何を片付けたか」の側だからである。
     *
     * **⚠️ 「器は行を消さない」は契約であって、fs 版が完全に守れているわけ
     * ではない（issue #416）。** `CLOSED_HISTORY_LIMIT`（`packages/storage-fs/
     * src/commitments.ts`）を超えた古い片付き行は物理削除される。削除された
     * 累計件数は `trimmedClosed` として応答に載るので、`renderCommitments` へ
     * 渡して人間にも見える形にする。
     */
    case '/commitments': {
      const includeClosed = rest[0] === 'all';
      const response = await client.commitments.$get({
        query: includeClosed ? { includeClosed: 'true' } : {},
      });
      if (!response.ok) {
        stdout.write(`${await withDetail('台帳を読めませんでした', response)}\n`);
        return 'ok';
      }
      const { entries, unreadable, trimmedClosed } = await response.json();
      const { text, ids } = renderCommitments(entries, Date.now(), unreadable, trimmedClosed);
      listed.commitments.length = 0;
      listed.commitments.push(...ids);
      stdout.write(`${text}\n`);
      if (ids.length > 0) {
        stdout.write('  /done <番号> <理由> で片付けたことを記録できます\n');
      }
      return 'ok';
    }

    /**
     * 人間の手でも積めるようにする（`/schedule` に仕込む口を置いたのと同じ理由）。
     *
     * クローンに頼めばよい、で済ませると「人間は台帳を読めるが書けない」という
     * 不揃いが残る。しかも積みたい場面はたいてい「いま言ったことを忘れられたら
     * 困る」ときなので、クローンのターンを1回起こさないと書けないのは重い。
     */
    case '/commit': {
      const body = rest.join(' ');
      if (body.length === 0) {
        stdout.write('使い方: /commit <本文>（引き受けたままの仕事として台帳へ積みます）\n');
        return 'ok';
      }
      const response = await client.commitments.$post({
        json: {
          body,
          // どこから来たかは会話 id で表す（`Commitment.source`）。まだ会話が
          // 始まっていなければ付けない — 嘘の出どころを埋めない。
          ...(conversationId === null ? {} : { source: conversationId }),
        },
      });
      if (response.ok) {
        stdout.write('台帳に積みました（/commitments で確認できます）\n');
        return 'ok';
      }
      // 404 だけ今の文言を保つ。それ以外（400・5xx 等）はサーバの理由
      // （`errorDetail`）をそのまま出す（issue #2172、`/commit-edit` と同じ形）。
      stdout.write(
        `${response.status === 404 ? '台帳に積めませんでした' : await errorDetail(response)}\n`,
      );
      return 'ok';
    }

    case '/done': {
      const [reference, ...reasonParts] = rest;
      // **理由は必須**（Web の `commitments.tsx` の `reason.trim() === ''` と同じ。
      // issue #3143）。閉じた理由は人間が後から読んで否定する材料なので、
      // 書かれていないまま「閉じた」事実だけを残さない。送る前に断る。
      const reason = reasonParts.join(' ').trim();
      if (!reference || reason.length === 0) {
        stdout.write(
          '使い方: /done <番号|id> <理由>（番号は /commitments の並び）\n' +
            '  理由が要ります（何をもって片付いたかを、後から読んで確かめられるように残すため）\n',
        );
        return 'ok';
      }
      const id = resolveListedId(reference, listed.commitments);
      if (id === null) {
        stdout.write(`[${reference}] は /commitments の一覧にありません\n`);
        return 'ok';
      }
      const response = await client.commitments[':id'].close.$post({
        param: { id },
        json: { reason },
      });
      if (response.ok) {
        stdout.write('片付いたことを記録しました\n');
        return 'ok';
      }
      // **失敗の理由を1つに畳まない。** 「既に片付いている」と「そんな id は無い」は
      // 次の一手が違う（前者は何もしなくてよく、後者は一覧を取り直す必要がある）。
      stdout.write(
        `${
          response.status === 409
            ? 'それは既に片付いています'
            : response.status === 404
              ? 'その id は台帳にありません'
              : await errorDetail(response)
        }\n`,
      );
      return 'ok';
    }

    /**
     * 台帳の本文を後から直す（#1058。`PATCH /commitments/:id`）。
     *
     * **⚠️ `/edit` に相乗りさせていない。** あれは**自分のチャット発言**の編集で、
     * 引く番号の置き場が違う（`listed.conversation` vs `listed.commitments`）。
     * この repo は番号の置き場を面ごとに分けてあり、混ぜると
     * 「`/commitments` の直後の `/edit 1`」が会話の発言を指す。
     *
     * ## ⛔ 直せる行の条件をここへ写さないこと
     *
     * 断るのはサーバで、403 の本文が**その行の `origin` を名指しして理由と出口まで
     * 書く**（`apps/daemon/src/app.ts` の `PATCH /commitments/:id` が「ここが
     * 『なぜ押せないか』の唯一の持ち主である」と逐語で言っている）。**Web UI も
     * 断りの文面を1文字も持っていない。** ⟹ CLI も持たない —— `errorDetail()` で
     * サーバの文をそのまま出す。写すと、サーバ側の線が動いた日に CLI だけが
     * 静かに嘘になる。
     */
    case '/commit-edit': {
      const [reference, ...bodyParts] = rest;
      const body = bodyParts.join(' ').trim();
      if (!reference || body.length === 0) {
        stdout.write('使い方: /commit-edit <番号|id> <新しい本文>（番号は /commitments の並び）\n');
        return 'ok';
      }
      const id = resolveListedId(reference, listed.commitments);
      if (id === null) {
        stdout.write(`[${reference}] は /commitments の一覧にありません\n`);
        return 'ok';
      }
      const response = await client.commitments[':id'].$patch({
        param: { id },
        json: { body },
      });
      if (response.ok) {
        stdout.write('本文を直しました（直す前の本文は日誌に逐語で残っています）\n');
        return 'ok';
      }
      // **サーバの文をそのまま出す**（上の doc）。状態コードで言い換えない。
      stdout.write(`${await errorDetail(response)}\n`);
      return 'ok';
    }

    /**
     * いくら使ったか。**人間が見られるものは、クローンが `usage_read` で見て
     * いるのと同じもの**（PRD 可観測性・north_star 禁止1）。経路は `GET /usage`
     * の1本だけで、表示は `usage.ts` の `renderUsage` に寄せてある
     * （CLI 本体の `alteroid usage` と表示を揃えるため）。
     */
    case '/usage': {
      const parsed = parseUsageFilters(rest);
      if (!parsed.ok) {
        stdout.write(`${parsed.message}\n`);
        return 'ok';
      }
      const response = await client.usage.$get({ query: parsed.filters });
      if (!response.ok) {
        stdout.write(
          `${await withDetail('利用状況を読めませんでした（from=/to= の日付の形を確かめてください）', response)}\n`,
        );
        return 'ok';
      }
      const aggregate = await response.json();
      // issue #2155: `to` が `from` より前だと常に0件になり、「その範囲には
      // 記録が無い。」だけでは「期間の指定が逆」と区別できない
      // （`usage.ts` の `alteroid usage` と同じ穴・同じ注記）。
      const dateOrderNotice = describeUsageDateOrder(parsed.filters.from, parsed.filters.to);
      if (dateOrderNotice !== null) {
        stdout.write(`${dateOrderNotice}\n`);
      }
      stdout.write(`${renderUsage(aggregate)}\n`);
      return 'ok';
    }

    default:
      stdout.write(`不明なコマンド: ${command ?? ''}\n${HELP}`);
      return 'ok';
  }
}

/**
 * 日報1件ぶんの表示。
 *
 * **日報の行は、日報が書けなかった印であることがある**（`unavailable`。
 * `packages/core/src/schema.ts` の doc が正本）。**その本文を素で出さないこと** —
 * 実際に起きた壊れ方は、日報の本文が丸ごと
 * `You've hit your org's monthly spend limit …` になっていた、というものである。
 * 見出しを `── <日付> の日報 ──` のまま出すと、人間はエラー文を「クローンが書いた
 * その日のまとめ」として読む（＝直した穴が人間の面で開き直る）。
 *
 * **理由は言い換えずに出す。** SDK の文言のまま置いてあるので、人間がそれで検索
 * できる（`usage-limits.ts` の「言い換えないこと」と同じ約束）。
 *
 * **次にどこを見ればよいかまで書く。** 「作れなかった」で終わると、その日の記録が
 * 消えたと読める。実際には日誌には全部残っているので、降りる先を名指しする
 * （PRD「可観測性」の一本道）。
 *
 * 表示を関数に出して export してあるのは `renderManagerList` / `renderUsage` と
 * 同じ理由 — 何を出しているかを端末なしで確かめられるようにするためである。
 */
export function renderReport(report: {
  date: string;
  body: string;
  unavailable?: string | undefined;
}): string {
  if (report.unavailable !== undefined && report.unavailable !== '') {
    return (
      `── ⚠ ${report.date} の日報は作れなかった ──\n` +
      `理由: ${redactBody(report.unavailable)}\n` +
      'この日の記録は日誌に残っている（/journal で辿れる）。' +
      '書けていないだけなので、原因が解ければ /run daily_report で作り直せる\n'
    );
  }
  return `── ${report.date} の日報 ──\n${redactBody(report.body)}\n`;
}

/**
 * 一覧（`/reports`）の1行。
 *
 * **ここでも本文を素で出さない。** 一覧は日付が並ぶだけの面なので、印の行を
 * 本文の抜粋で出すと「その日は上限に当たった話が日報に書かれている」と読める。
 *
 * **`at`（書かれた時刻）を足す。** `date` だけだと、同じ日に日報が2本あると
 * 見分けが付かない（#214）。`dailyReportEntrySchema` は元から `at` を持ち、
 * Web（`apps/web/app/routes/reports.tsx` の `reportLabel`）は `date` と時刻を
 * 並べて出している——CLI にだけこの区別が無かった。**ISO をそのまま出す**
 * （ロケール依存の整形はしない。この一覧の他の欄——`作成`/`更新`——もすべて
 * 生の ISO で、ここだけ変えると読み方が揃わなくなる）。
 */
export function renderReportLine(report: {
  date: string;
  at: string;
  body: string;
  unavailable?: string | undefined;
}): string {
  if (report.unavailable !== undefined && report.unavailable !== '') {
    return (
      `  ${report.date}  ${report.at}` +
      `  ⚠ 日報なし（作れなかった。理由: ${summarizeText(report.unavailable)}）`
    );
  }
  return `  ${report.date}  ${report.at}  ${summarizeText(report.body)}`;
}

function writeReport(report: { date: string; body: string; unavailable?: string }): void {
  stdout.write(renderReport(report));
}

/**
 * `/reports` `/journal` が「切ったなら切ったと言う」ための共通の断り書き
 * （Issue #426 の G3）。**窓の大きさ（`/reports` の既定14件・`/journal` の
 * 既定20件）はここでは変えない** — 決め方が未決だと Issue 本文が書いている
 * ので、決まっていない基準で動かすより「切ったことと定量を言う」ほうを
 * 先に片付ける。
 *
 * **`GET /reports` `GET /journal` はどちらも総件数を返さない**
 * （`apps/daemon/src/app.ts` の `describeRoute`、逐語: 「封筒は持たない ——
 * 続きが在るかは `limit` 件ちょうど返ったかで判る」。
 * `grep -Fn -- 'ちょうど返ったかで判る' apps/daemon/src/app.ts` で当たる）。
 * だから `excerpt.ts` が課す規律
 * （何件省いたか／全何件か）をそのままの形では守れない —— 正確な省略件数・
 * 全体件数はどちらも言えない。**言えるのは「返った件数が要求した上限と
 * ちょうど一致した」という、この API 自身が定めた唯一の合図だけである。**
 * 黙って切り捨てず、その事実だけを言う（`apps/web` 側の同じ形は
 * `tokens.tsx` の `RotationHistory` / `reports.tsx` の `isReportsWindowFull`）。
 */
function noteIfAtLimit(count: number, limit: string, label: string): void {
  if (count !== Number(limit)) return;
  stdout.write(`直近 ${limit} 件のみ表示している。これより古い${label}があるかもしれない。\n`);
}

/** 一覧で拒否を出す道具の種類数（多い分は件数だけ言う）。 */
const LIST_DENIED_TOOLS = 3;

/**
 * `GET /managers` が返す1本ぶん。**クライアントが実際に受け取る形**から導く
 * （core の `ManagerSummary` ではない — 拒否件数はデーモンの外向きの面でだけ
 * 合流するので、そちらには無い）。
 *
 * **status（`200`）を明示するのは issue #670 で 400 が生えたからである。**
 * あの口は `status` / `limit` / 錨（`afterId` ＋ `afterStartedAt`）を受け取る
 * ようになり、不正なクエリ・見当たらない錨を 400 で断る ⟹ `$get` の返りが
 * 応答の union になり、`InferEndpointType`（`hono@4.13.1` の
 * `dist/types/client/types.d.ts`）の `U extends ClientResponse<infer O, ...>`
 * が union の上では解けなくなった。**200 を名指しすれば元の1本に戻る。**
 *
 * **`/managers` は窓を使う側になった**（issue #670 の続き。`status=` / `limit=` /
 * `after=` を受ける。`parseManagerFilters`）。**`/waiting` は使わない**——理由は
 * そちらの `query: {}` の doc に在る（絞ると答えれば進む確認が消えうる）。
 * **クローンの `manager_list` はいまも窓を持たない**。あちらは並びの向きを
 * 決めることが先なので #662 が持っている。
 */
type ManagerListItem = InferResponseType<DaemonClient['managers']['$get'], 200>['managers'][number];
type ManagerDenial = NonNullable<ManagerListItem['denials']>[number];
/** `lastUnpushedWorkObservation` 単体（discriminated union。Issue #1883）。 */
type ManagerUnpushedWorkObservation = NonNullable<ManagerListItem['lastUnpushedWorkObservation']>;

/**
 * `ManagerDenial.actor` を一行に添える短い印にする。
 *
 * **`packages/core/src/tools.ts` の `denialActorTag` と同じ書式に揃えてある。**
 * 片方だけ直すと、クローンが見る `manager_list` と人間が見るこの CLI とで
 * 同じ拒否を見て違う判断をする（Issue #373、2026-08-24 コメント
 * #5393921053）。`undefined`（層が取れていない）を黙って消したり、
 * マネージャー側へ混ぜたりしない——3値のまま出す。
 */
function denialActorTag(actor: ManagerDenial['actor']): string {
  return actor === 'manager' ? ' [マネージャー]' : actor === 'worker' ? ' [作業者]' : ' [層不明]';
}

/**
 * 状態に添える「確認へ上がらず止められた」件数の一行。
 *
 * **状態を置き換えない。** 確認へ上がらず止められると、その仕事は `running`
 * のまま手が止まって見える。札は `[running]` のまま残し、その下に並べる。
 *
 * **⚠ ただし拒否の出所は、この数からは取れない（Issue #1267 / #1289）。** 器の
 * モデル分類器・deny 規則の拒否と、alteroid 自身の `PreToolUse` フック
 * （`bash-wait-guard.ts` 等）の拒否は同じイベントとして通るが、帰結が違う
 * ——前者は確認がクローンへ回らないので担い手は本当に詰むが、後者は理由と
 * 代替案が担い手自身へ直接返っているので自力で抜けられることがある
 * （`manager.ts` の `case 'permission_denied'`）。だから断定はせず、(b) の
 * 可能性を残す。
 *
 * **人間が読む面は3つある。** クローンは `manager_list` で、Web UI は一覧で
 * 同じものを見ているのに、端末だけが「実行中」としか言わなかった。同じ仕事を
 * 見て人間とクローンが違う判断をするのは、北極星 禁止1（デグレード禁止）を
 * いつもと逆の向きに踏むことである。
 *
 * **畳み方は他の2面と同じ**（新しい側から3種＋切った分）。デーモンは古い順で
 * 返すので末尾から採る — 知りたいのはいま何で止まっているかである。
 *
 * **拒否が無いときは何も足さない。** `denials` が無いのと `[]` は別で、常に
 * 何か書くと「0 件だった」と読める。件数はデーモンのプロセス内にしか無く、
 * 器を作り直せば数え直しなので、作り直した直後がいちばん静かに見える形にしない。
 *
 * 端末は1本ぶんに割ける行が少ないので、但し書きは Web UI より短くしてある。
 * ただし「止まっている**可能性がある**」までは削らない — 数えているのは拒否
 * そのものであって、それで止まったかどうかはデーモンから見えていない。
 *
 * **各件に `denialActorTag` で層を添える**（Issue #373）。
 */
function denialLine(
  denials: ManagerDenial[] | undefined,
  lastReportAt: string | undefined,
): string | null {
  if (denials === undefined || denials.length === 0) return null;
  // 止められた後に報告が届いたか（#1455）。字面の生成元はクローンの面と同じ関数。
  const followUp = describeDenialFollowUp(denials, lastReportAt);
  // 帳面は古い順に積まれている。**新しい側から**採る。
  const recent = [...denials].reverse();
  const shown = recent.slice(0, LIST_DENIED_TOOLS);
  const rest = recent.length - shown.length;
  const total = denials.reduce((sum, entry) => sum + entry.count, 0);
  return (
    `⚠ 確認へ上がらず止められた道具: ${shown.map((e) => `${e.tool} ${e.count}件${denialActorTag(e.actor)}`).join(' / ')}` +
    (rest > 0 ? `（ほか ${rest} 種、全 ${total} 件）` : '') +
    '。まず担い手自身の拒否文を読ませること。' +
    '(a) 器の分類器か deny 規則なら、手が止まっている可能性があります。' +
    '(b) alteroid 自身の PreToolUse フックなら、理由と代替案は担い手へ直接返っており自力で抜けられることがあります' +
    (followUp === null ? '' : `。${followUp}`)
  );
}

/**
 * 直近の1ターンが**報告ではなく失敗**で終わったことを、状態に添える一行。
 *
 * **`status` を置き換えない。** 支出上限に当たった回もセッションは生きているので
 * 台帳の `status` は `done`（＝終えて待機中。話しかければ続く）のままである
 * （`packages/core/src/schema.ts` の `lastFailure` の doc）。札を `failed` へ倒すと
 * 嘘になり、人間は「もう続けられない」と読んで起こし直す判断を誤る。
 *
 * **SDK の語（`code` / `via`）をそのまま出す。** 言い換えると、人間が SDK の型定義や
 * ログで引ける手がかりが消える。`billing_error` と `rate_limit` は次の一手が違う
 * （前者は人間が枠を上げる話で、後者は待てば直る）。
 *
 * **何をすればよいかまで書く。** 「失敗した」だけだと、この仕事が死んだのか
 * 話しかければ続くのかが読めない。続けられるという事実そのものが、この
 * `status` と `lastFailure` を分けた理由である。
 *
 * ## ⚠️ Issue #1882: `status` が既にセッションの死を確定させている回は分けて言う
 *
 * `lastFailure` は `packages/core/src/manager.ts` の `case 'report'` が書く欄で、
 * 次の `report` が届くまで消えない。だから、枠(429)などで畳まれた回の直後に
 * セッションそのものが `failed` / `lost`（誰も望まない終わり方）や `stopped`
 * （人間・クローンが明示的に止めた終わり方）へ確定しても、この行は上の
 * 「セッションは生きているので……」という古い前提を言い続ける——同じ画面の
 * 状態バッジは終端の札を出しているので、1画面の中で言い切りが事実と矛盾する
 * （Issue #1882 本文の実測）。
 *
 * **`status` を追加の引数として受け取り、`failed` / `lost`（core の
 * `isManagerOutcomeUnobserved` と同じ判定: `status === 'failed' ||
 * status === 'lost'`）と `status === 'stopped'` の2分岐で言い分ける**
 * （core の `describeManagerFailure`（PR #1904）・Web の `terminalFailureNote`
 * （PR #1889）と同じ2分岐・同じ意味）。**生きている3値（`running` /
 * `waiting_human` / `done`）の文言は1文字も変えない。**
 *
 * **`manager_send` は実際に `stopped` へも resume を試みうる**（core の
 * `manager.ts` の `send()` は `status` を見ずに `#load()` で `ManagerRecord`
 * を作り直し、`#resume()` もその印が無ければ素通りする——core PR #1904 が
 * 現物で確かめた事実）。⟹ **「もう続かない」とまでは言わない**——続ける
 * 手段（話しかける）は塞がっていないが、届く保証は無いとまで言う。
 *
 * **CLI の次の一手の語はこの面のものを使う（`/msg`）。** `runnerLostSince` の
 * 行（直下）が同じ理由で `manager_send` ではなく `/msg` を名指ししている
 * ——ここも揃える。
 *
 * ## `lastFoldedTurn` が在る回は出さない
 *
 * `lastFailure` は `case 'report'` が `status === 'stopped'` の間は一切
 * 触らない欄（`lastFoldedTurn` だけを書いて早期 return する分岐）——
 * `lastFoldedTurn` が在る回の `lastFailure` は、畳まれる**前**の無関係な
 * 古いターンを指す。core の `manager_report`（Issue #1798。`foldedTurn !==
 * undefined` の回は `describeManagerFailure` を呼ばない）・Web の
 * `FailureNote`（PR #1889。同じ回に `null` を返す）と同じ線で、ここも
 * `null` を返す。
 */
function failureLine(
  failure: ManagerListItem['lastFailure'],
  status: ManagerListItem['status'],
  lastFoldedTurn: ManagerListItem['lastFoldedTurn'],
): string | null {
  if (failure === undefined || failure === null) return null;
  if (lastFoldedTurn !== undefined) return null;
  const opening = `⚠ 直近のターンは報告ではなく失敗で終わっています: ${failure.code}（${failure.via}, ${failure.at}）`;
  if (status === 'failed' || status === 'lost') {
    return (
      `${opening}。ただし status: ${status}——セッションそのものが、依頼者が望まない終わり方で` +
      '既に終端している。「セッションが生きていて原因が解ければ話しかければ続く」という前提はここでは' +
      '成り立たない——続けたいなら /msg で送ると resume を試みるしかなく、届く保証は無い'
    );
  }
  if (status === 'stopped') {
    return (
      `${opening}。ただし status: stopped——このセッションは、その後 人間・クローンが明示的に` +
      '停止させ、確かめたうえで既に終端している。「セッションが生きていて原因が解ければ話しかければ続く」' +
      'という前提はここでは成り立たない——続けたいなら /msg で送ると resume を試みるしかなく、届く保証は無い'
    );
  }
  return `${opening}。セッションは生きているので、原因が解ければ話しかければ続きます`;
}

/**
 * 枠(利用上限)で止まっている委譲の1行（Issue #1883。GET /managers が返す
 * `usageStoppedAt`）。
 *
 * **core の `packages/core/src/tools.ts` の `describeUsageStopped` と同じ
 * 3分岐を複製する。** あの関数は `export` されていない（`manager_list` 専用の
 * 私用関数）——`apps/cli` は `@alteroid/core` の公開面（`index.ts` が
 * re-export するものと、`./mask-url` のような軽い口）しか import できない
 * 前提なので、ここは複製である（`failureLine` が `isManagerOutcomeUnobserved`
 * の判定を複製しているのと同じ理由・同じ形）。
 *
 * **#1882 と同じ穴を作らない。** `failureLine` と同じ2分岐——
 * `status === 'failed' || status === 'lost'`（core の `isManagerOutcomeUnobserved`
 * と同じ判定）と `status === 'stopped'`——で「セッションは生きている」を
 * 言い切らない。**生きている3値（`running`/`waiting_human`/`done`）の文言は
 * `describeUsageStopped` の第3分岐と同じ意味で書く。**
 *
 * **`stopped` 枝にも resume の一文を付ける（PR #1904 で core が揃えた形）。**
 * core の `describeUsageStopped` は元は `failed`/`lost` 枝にだけ「起こし直すには
 * manager_send で resume を試みるしかなく、届く保証は無い」を持ち、`stopped` 枝は
 * それを欠いていた——#1904 がここを揃えた（`grep -Fn -- '起こし直すには
 * manager_send で resume を試みるしかなく、届く保証は無い' packages/core/src/tools.ts`
 * が `describeUsageStopped` 内で2箇所ヒットする——`failed`/`lost` 枝と `stopped` 枝の
 * 両方が同じ resume の一文を持つ）。CLI 版も同じ穴を作らないよう、`stopped` 枝に
 * `/msg` での resume の一文を足す。
 *
 * **Web の `DiagnosticsCard`（`manager-detail.tsx`）はこの欄を独立した行として
 * 出さないと決めている**（`ResetTimeSkewNote` 自身が「枠で止まっている間だけ
 * 意味を持つ」と書くので、という理由）。**CLI はここで core 側の判断を採る**——
 * Web の詳細画面と違い、CLI の `/managers` には別建ての詳細画面が無く
 * （`/manager` はセッション生ログで診断カードの代わりにならない）、
 * `resetTimeSkewMatch` が `undefined`（枠に当たった直後でまだ429の文言と
 * 突き合わせていない・プール未配線 等）の間はこの行だけが唯一の手がかりに
 * なる。出さないと「枠に当たっている」という事実そのものが CLI から消える。
 */
function usageStoppedLine(
  usageStoppedAt: ManagerListItem['usageStoppedAt'],
  status: ManagerListItem['status'],
): string | null {
  if (usageStoppedAt === undefined) return null;
  if (status === 'failed' || status === 'lost') {
    return (
      `      ⚠ 枠(利用上限)で止まっている（${usageStoppedAt} から）。` +
      `ただし status: ${status}——セッションそのものが、依頼者が望まない終わり方で` +
      '既に終端している。「セッションは生きているので鍵が回れば続く」はここでは' +
      '成り立たない——起こし直すには /msg で送ると resume を試みるしかなく、届く保証は無い' +
      '（実際に届いたかどうかは、この一覧の他の行——システムエラー・cgroup 等——を見ること）。'
    );
  }
  if (status === 'stopped') {
    return (
      `      ⚠ 枠(利用上限)で止まっている（${usageStoppedAt} から）。` +
      'ただし status: stopped——このセッションは、その後 人間・クローンが明示的に' +
      '停止させ、確かめたうえで既に終端している。「セッションは生きているので鍵が' +
      '回ればこの委譲は続く」はここでは成り立たない' +
      '——起こし直すには /msg で送ると resume を試みるしかなく、届く保証は無い' +
      '（実際に届いたかどうかは、この一覧の他の行——システムエラー・cgroup 等——を見ること）。'
    );
  }
  return (
    `      ⚠ 枠(利用上限)で止まっている（${usageStoppedAt} から）。` +
    'セッションは生きているので、鍵が回ればこの委譲は続く' +
    '——status はそれまで動かさない（仕様である）。'
  );
}

/**
 * セッションが `failed` として畳まれたときの、Node が構造として持つ失敗の
 * 分類（Issue #1883。GET /managers が返す `lastSystemError`）。
 *
 * **文言は core と同じ正本から引く**（`@alteroid/core/system-error-format` の
 * `formatSystemErrorFacts` / `formatSystemErrorUnknownNote`）。この2つは
 * ブラウザへ出す軽い口として作られていて（zod を持たない）、Web の
 * `SystemErrorNote`（`manager-detail.tsx`）も同じ2つから文言を引く——CLI も
 * ここに合流させ、3つ目の複製を作らない。**ゲート（`status !== 'failed'` なら
 * `null`）だけは、この関数側で複製する**——ゲートそのものは軽い口に無い
 * （`describeManagerSystemError` の doc と同じ理由）。
 *
 * **末尾の指し先だけ CLI 向けに変える**（Web が画面のセクション名を指すのと
 * 同じ作法）——core 向けの `lastFailure`（MCP の欄名）ではなく、CLI の
 * `failureLine` が出す見出し文言を指す。
 */
function systemErrorLine(
  status: ManagerListItem['status'],
  lastSystemError: ManagerListItem['lastSystemError'],
): string | null {
  if (status !== 'failed') return null;
  if (lastSystemError === undefined) {
    const note = formatSystemErrorUnknownNote(
      '、上の「直近のターンは報告ではなく失敗で終わっています」の行を見ること',
    );
    return `      ⚠ セッションは失敗で畳まれた。${note}。`;
  }
  return (
    `      ⚠ セッションは器の資源による落ち方で畳まれた可能性 ` +
    `（${lastSystemError.at}）: ${formatSystemErrorFacts(lastSystemError)}`
  );
}

/**
 * セッションが `failed` として畳まれたときの cgroup の pids/OOM カウンタの
 * 差分（Issue #1883。GET /managers が返す `lastCgroupEvents`）。
 *
 * **`systemErrorLine` と対で読むが軸は別**（`describeManagerCgroupEvents` の
 * doc と同じ注意——因果は名乗らない）。文言は同じく軽い口
 * （`@alteroid/core/cgroup-events-format`）から引く。
 */
function cgroupEventsLine(
  status: ManagerListItem['status'],
  lastCgroupEvents: ManagerListItem['lastCgroupEvents'],
): string | null {
  if (status !== 'failed') return null;
  if (lastCgroupEvents === undefined) {
    return `      ⚠ ${CGROUP_EVENTS_UNKNOWN_NOTE}。`;
  }
  return `      ${formatCgroupEventsNote(lastCgroupEvents)}（${lastCgroupEvents.at}）。`;
}

/**
 * `tokenGeneration` が `undefined` のときに、なぜ分からないかを言う
 * （Issue #1883。GET /managers が返す `tokenGenerationUnknownReason`）。
 *
 * core の `describeTokenGenerationUnknownReason`（`tools.ts`）と同じ3分岐を
 * 複製する（export されていない私用関数——`usageStoppedLine` の doc と同じ
 * 理由）。
 *
 * **`tokenGeneration` / `activeTokenGeneration`（世代の生の番号）はここでは
 * 出さないと決めた。** Web の `DiagnosticsCard` が「生の世代番号を並べても
 * 人間の次の一手は増えない」と決めた理由（`resetTimeSkewMatch` が既に
 * 人間向けの結論を出している）は CLI にもそのまま当てはまる——CLI と Web で
 * 揃える。**`tokenGenerationUnknownReason` はこの2つとは別の性質**——生の
 * 番号ではなく「なぜ分からないか」という説明そのものなので、除く理由が
 * 当てはまらない。しかも `tokenGeneration` が定義されているときはこの欄
 * ごと消える（daemon 側の不変条件。`openapi.ts` の doc）ので、ここで
 * `tokenGeneration` を見る必要が無い。
 *
 * **`reattached-across-restart` の対処（core は
 * `manager_stop → manager_start`）は、CLI の語へ言い換える。** core の助言
 * 定数（`STALE_TOKEN_RESTART_ADVICE`）の逐語をそのまま複製すると
 * `pnpm check:stale-token-restart-advice` に引っかかる
 * （`scripts/check-stale-token-restart-advice-core.mjs` の `BANNED_PHRASES`）
 * ——生成元の外でその逐語を持ってよいのは `*.test.ts` だけである。Web の
 * `resetTimeSkewText` も同じ理由で言い換えている（`manager-detail.tsx` の
 * doc）ので、ここも同じ2つの核（(1) 止める前に外へ出た成果を確かめる (2) 失われる
 * のは会話だけではない）を CLI の言葉（`/stop` ではなく `/msg` — この委譲は
 * まだ止まっていない）で運ぶ。
 */
function tokenGenerationUnknownReasonLine(
  tokenGenerationUnknownReason: ManagerListItem['tokenGenerationUnknownReason'],
): string | null {
  if (tokenGenerationUnknownReason === undefined) return null;
  if (tokenGenerationUnknownReason === 'pool-not-wired') {
    return (
      '      認証トークンの世代: 分からない（このデプロイは認証トークンの世代そのものを' +
      '配線していない構成。全ての委譲について同じ理由で分からない——この委譲固有の' +
      '問題ではなく、起こし直しても変わらない）。'
    );
  }
  if (tokenGenerationUnknownReason === 'not-yet-observed') {
    return (
      '      認証トークンの世代: 分からない（この委譲のセッションが、いまのデーモンの' +
      'プロセスではまだ一度も起きていない。開始・明示的な resume・認証トークンの' +
      '回転のどれかが起きれば次の一覧から埋まる——いま何もしなくてよい）。'
    );
  }
  if (tokenGenerationUnknownReason === 'reattached-across-restart') {
    return (
      '      認証トークンの世代: 分からない（デーモンの再起動をまたいで、器に生きた' +
      'ままのセッションを引き取った。引き取っただけではこのセッションの環境変数に' +
      '触れていないので、抱えている世代を確かめる材料が無い——一致でも不一致でもない、' +
      '正直な「分からない」である）。この委譲へ daemon が次に明示的に触れば' +
      '（送信・回転のどちらでも）自動で埋まるが、429 が続くなど気になるようなら、' +
      '止める前に、まず外へ出た成果（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめること。' +
      '確かめずに止めると、失われるのは会話だけではない——そのターンで進行中だった' +
      '作業も一緒に失われうる。確かめたうえで、/msg で送ると resume を試みる。'
    );
  }
  return (
    `      認証トークンの世代: 分からない理由に、この一覧が知らない値 ` +
    `"${String(tokenGenerationUnknownReason)}" が入っている（デーモンの版が新しい可能性）。`
  );
}

/**
 * 429の文言の `resets` 時刻を、プールの各鍵の `cooldownUntil` と突き合わせた
 * 結果（Issue #1883。GET /managers が返す `resetTimeSkewMatch`）。
 *
 * **core の `describeResetTimeSkew` との違い**——あちらは `tokenGeneration` /
 * `activeTokenGeneration`（世代の生の番号）が既に食い違いを名指ししている
 * ときは二重に鳴らさないよう抑える分岐を持つ。**CLI はその生の番号を出さない
 * と決めた**（`tokenGenerationUnknownReasonLine` の doc）ので、抑える判定に
 * 使う材料そのものが無い——Web の `resetTimeSkewText` と同じ理由で、抑えずに
 * そのまま出す（二重に鳴る先が無いので実害は無い）。
 *
 * **未知の値でも落ちない。** 版のずれ（新しいデーモンが第3の値を返す）は
 * 型では防げない——`describeWaitingKind`（このファイル）と同じ作法で、
 * 知らない値をそのまま名乗る。
 *
 * **`'stale'` の対処は CLI の語へ言い換える**
 * （`tokenGenerationUnknownReasonLine` の doc と同じ理由・同じ2つの核）。
 */
function resetTimeSkewLine(
  resetTimeSkewMatch: ManagerListItem['resetTimeSkewMatch'],
  hasUnpushedWorkObservationLine: boolean,
): string | null {
  if (resetTimeSkewMatch === undefined) return null;
  if (resetTimeSkewMatch === 'stale') {
    // 「下の『未push観測』」は、その行が実際に出るときだけ指す（0本で省かれた行を指さない）。
    const unpushedNote = !hasUnpushedWorkObservationLine
      ? ''
      : '下の「未push観測」にも最後の観測が出ている（いまの状態ではない）ので、合わせて見ること。';
    return (
      '      ⚠ 認証トークンの世代ずれの疑い（429の文言に書かれていた resets 時刻が、' +
      '現役ではない鍵の冷却期限と一致した）。このセッションは古い鍵を掴んだまま' +
      '走っている可能性がある——鍵が通る状態へ戻っても、このセッション自身は' +
      'ターンの境界に達するまで戻らない。この行が消えないまま 429 が続くようなら、' +
      '止める前に、まず外へ出た成果（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめること。' +
      unpushedNote +
      '確かめずに止めると、失われるのは会話だけではない——そのターンで進行中だった' +
      '作業も一緒に失われうる。確かめたうえで、/msg で送ると resume を試みる。'
    );
  }
  if (resetTimeSkewMatch === 'active') {
    return (
      '      認証トークン: 429の文言に書かれていた resets 時刻が、現役の鍵自身の' +
      '冷却期限と一致した——世代ずれではなく、待てば戻る。'
    );
  }
  return (
    `      認証トークンの世代ずれの判定: この一覧が知らない値 ` +
    `"${String(resetTimeSkewMatch)}"（デーモンの版が新しい可能性）。`
  );
}

/** `observation.worktrees` を1行にする。core の `formatUnpushedWorkObservationWorktrees`
 * （`tools.ts`、export されていない）と同じ判断の複製（Issue #1883）。
 */
function formatUnpushedWorkObservationWorktrees(
  worktrees: readonly { relativePath: string; branch: string | null }[],
): string {
  return worktrees.length === 0
    ? '見つかった作業ツリー0本'
    : worktrees
        .map(
          (wt) =>
            `${wt.relativePath}: branch=${wt.branch === null ? 'null（取れなかった）' : wt.branch}`,
        )
        .join(' / ');
}

/**
 * `/stop`（running・非force）の断り、ターンが `report` で終わったとき、
 * Bash で `git push` か新しい枝を作る操作を検出したとき、または止める操作
 * そのもの（`/stop` の force・`done`/`waiting_human` の非force・人間の停止・
 * 自動畳み。Issue #1266 残り2）で取った最後の未push観測（Issue #1883。
 * GET /managers が返す `lastUnpushedWorkObservation`）。
 *
 * **core の `describeUnpushedWorkObservation`（`tools.ts`）と同じ2つの分岐を
 * 複製する**（export されていない私用関数）。
 *
 * ## 器の入れ替え（redeploy 等）で応答不能な委譲は、別の言い方をする
 *
 * `manager.sessionMissingSince !== undefined` の間は、上の一般論ではなく
 * `manager.shutdownObservationArrivedAfterSwap` の値で言い分ける——core の
 * doc と同じ判断: 届いた（`true`）なら「器が止まる直前の観測」と言い切り、
 * 届いていない（`false`・観測が無い・古いセッションのもの・`source` が
 * `'shutdown'` ではない のどれか）なら、その旨を明示したうえで、いま表示中の
 * 観測（在れば）を添える。
 *
 * **`cwd`（探索の起点の絶対パス）は載せない。** `observedWorktreeBranchSchema`
 * の doc が引く「出してよい範囲」をそのまま継ぐ——core と同じ線。
 *
 * **`kind: 'observed'` の3箇所すべてに「探しきれていない」の注記を足す
 * （Issue #1885 / PR #1896。main へ入って CLI がまた1歩遅れていた）。** 文言は
 * core・Web と同じ正本（`@alteroid/core/unpushed-work-observation-format` の
 * `describeUnpushedWorkObservationIncompleteness`）から引く——ここも軽い口
 * なので複製にならない（`system-error-format` / `cgroup-events-format` と
 * 同じ形）。4欄がどれも無ければ空文字を返すので、健全な観測では1文字も
 * 増えない。
 */
function unpushedWorkObservationIncompleteSuffix(
  observation: Extract<ManagerUnpushedWorkObservation, { kind: 'observed' }>,
): string {
  const note = describeUnpushedWorkObservationIncompleteness(observation);
  return note === null ? '' : `\n      ${note}`;
}

function unpushedWorkObservationLine(manager: ManagerListItem): string | null {
  const observation = manager.lastUnpushedWorkObservation;

  if (manager.sessionMissingSince !== undefined) {
    if (manager.shutdownObservationArrivedAfterSwap === true && observation !== undefined) {
      if (observation.kind === 'unavailable') {
        return (
          `      未push観測: 器が止まる直前（${observation.at}）に取ろうとしたが取れなかった: ` +
          redactBody(observation.reason)
        );
      }
      // 作業ツリー0本で探索の失敗も無いなら行を省く（Issue #2970）。
      if (isEmptyCompleteUnpushedWorkObservation(observation)) return null;
      return (
        `      未push観測: 器が止まる直前（${observation.at}）の観測: ` +
        formatUnpushedWorkObservationWorktrees(observation.worktrees) +
        unpushedWorkObservationIncompleteSuffix(observation)
      );
    }
    const shown =
      observation === undefined
        ? '表示中の観測は無い（一度も取れていない）'
        : observation.kind === 'unavailable'
          ? `表示中の観測は ${observation.at} 時点・${describeUnpushedWorkObservationSource(observation.source)} のもの（取れなかった: ${redactBody(observation.reason)}）`
          : `表示中の観測は ${observation.at} 時点・${describeUnpushedWorkObservationSource(observation.source)} のもの: ${formatUnpushedWorkObservationWorktrees(observation.worktrees)}` +
            unpushedWorkObservationIncompleteSuffix(observation);
    return (
      '      ⚠ 未push観測: 器が止まる直前の観測は届いていない' +
      '（best-effort の送信のため。未pushが無かったことを意味しない）。' +
      shown
    );
  }

  if (observation === undefined) return null;
  // 作業ツリー0本で探索の失敗も無いなら行を省く（Issue #2970）。
  if (isEmptyCompleteUnpushedWorkObservation(observation)) return null;
  const provenance = describeUnpushedWorkObservationProvenance(observation.source, 'この一覧');
  if (observation.kind === 'unavailable') {
    return (
      `      未push観測（${provenance}）: 取れなかった（${observation.at}）: ` +
      redactBody(observation.reason)
    );
  }
  return (
    `      未push観測（${provenance}、${observation.at}）: ` +
    formatUnpushedWorkObservationWorktrees(observation.worktrees) +
    unpushedWorkObservationIncompleteSuffix(observation)
  );
}

/**
 * マネージャーの一覧を、人間が読める形へ（`/managers`）。
 *
 * 表示を関数に出してあるのは、`renderUsage`（`usage.ts`）と同じ理由 —
 * 何を出しているかを端末なしで確かめられるようにするためである。
 *
 * **`status` は絞りの有無だけを渡す（#2203）。** `renderManagerList` は
 * 一覧しか受け取っておらず、`status=` で絞った0件と絞っていない0件が
 * 同じ「（マネージャーは1本も居ません）」になっていた——絞りを外せば
 * 見えるはずの一覧まで「1本も居ない」と読める（嘘の観測）。手本は CLI
 * `/journal` の `type=` 0件（#2073 / PR #2089）。**絞っていない0件の
 * 文言は変えない** — 呼び出し元が `status` を渡さなければ、この関数は
 * 1文字も変わらない。
 */
export function renderManagerList(
  managers: ManagerListItem[],
  status?: string,
  unreadable: readonly UnreadableJob[] = [],
  now: Date = new Date(),
): string {
  if (managers.length === 0) {
    // **読めない行が在るときは「居ない」と言わない**（issue #2345）。読めない行は状態も
    // 取れないので、`status` で絞った先に居ないとも言えない。
    if (unreadable.length > 0) {
      return status === undefined
        ? '（読めたマネージャーは居ません。居ないとは言えません）'
        : `status=${status} に当たる読めたマネージャーは居ません（読めない行の状態は分からないので、居ないとは言えません）`;
    }
    return status === undefined
      ? '（マネージャーは1本も居ません）'
      : `status=${status} に当たるマネージャーは居ません（絞り込みを外せば見えるかもしれません）`;
  }

  const lines: string[] = [];
  managers.forEach((manager, index) => {
    // **字面は `describeManagerState` から取る（唯一の生成元）。** ここは同じ
    // 意味の字面を自前で組んでいて、`live` を真偽値としてしか扱えなかった——
    // **「取れていない」（`undefined`）を表せず、取れていない回まで
    // 「話しかけられる」側へ倒れていた。** クローンの `manager_list` と digest は
    // 既にこの関数を通しており、人間の入口だけが別の字面を出していた。
    //
    // **依頼文も抜粋にする。** 同じ関数の中で `waiting` と `lastReport` だけを
    // 畳んでいたので、数千字の依頼が来ると一覧そのものが流れて読めなくなった。
    //
    // **番号を振る。** `/manager` `/stop` `/msg` がこの並びを引く（#336）。
    lines.push(
      `  [${index + 1}] ${manager.managerId}  ` +
        // **第3引数まで通す（#621 / #643）。** ここで落とすと、人間の入口
        // だけが「手が空いた」と「背景処理の完了を待って畳んだ」を潰した字面を
        // 出すことになる（この関数がそもそも直した「面によって字面が割れる」形の
        // 再発である）。
        `[${describeManagerState(manager.status, manager.live, manager.awaitingBackground)}]  ` +
        `${summarizeText(manager.request)}`,
    );
    lines.push(`      cwd: ${manager.cwd}`);
    // **マネージャー層の provider（#486 S9）。** 欄が無いのは「不明」で、`claude` とは描かない
    // （クローンの道具・Web UI と同じ `describeManagerProvider`）。
    lines.push(`      provider: ${describeManagerProvider(manager.managerProvider)}`);
    // **作成と更新。** 値は `GET /managers` が既に返していて、ここが出して
    // いなかっただけである（クローンの `manager_list` には #208 から出ている）。
    lines.push(`      作成: ${manager.startedAt}  更新: ${manager.updatedAt}`);
    // **`live: false` の理由を、分かる分だけ名指しする。** 状態名だけだと
    // 「セッションが終わった」のか「宛先の器が消えた」のかが読めず、人間の
    // 打つ手（起こし直すのか、器の側を見るのか）が決まらない。
    //
    // **断定は「器が黙っている」までである** —— その中で走っていたかどうかは
    // この観測からは言えない（`lost` の但し書きと同じ線引き）。
    //
    // **⚠️ 「いま話しかけられない」と書かないこと。実測して嘘だと分かっている。**
    //
    // 2026-08-28 まで、ここは「新しい委譲の宛先からも外れているので、いま
    // 話しかけられない」と書いていた。**`packages/core` の足場で実測したら偽だった**
    // —— 名簿が `state: 'lost'` と判定した器に載っている委譲へ `ManagerPool.send()`
    // を撃つと `{ outcome: 'delivered', detail: '追加指示として届けた。' }` が返り、
    // runner の resume の口が実際に叩かれる。構造の理由: `#markSilent` は
    // `entry.state` を `'lost'` にするだけで **`entry.client` を落とさず**、
    // `Registry#get()` は `entry.state` を見ない（`list()` は `lost` を除くが
    // `get()` は除かない）。`send()` は `job.runnerId` が在れば `#runnerOf` →
    // `get()` を通り、**`runnerLostSince` が立つのは `runnerId` が在るときだけ**
    // なので必ずこちら側である。
    //
    // **これは一度閉じた欠陥と同じ形である。** `ba4053d`（#67「「いま送っても
    // 届かず」の真下に、届く送信ボタンが並んでいた」）は、届く相手に「届かない」と
    // 書いた**注記のほうを**直した（送信は塞がなかった —— 塞ぐと「人間が自分の言葉で
    // 繋ぎ直す唯一の手」が消える。north_star 禁止1）。
    //
    // **⚠️ #67 の commit 本文が持つ実測表（`delivered` / `unknown` の2値）を
    // そのまま当てないこと。あれは古い。** `0fb068f`（PR #571「manager_send が
    // [running] の相手へ 404 を貫通させる」#563）で `ManagerSendResult.outcome` は
    // **4値**（`answered` / `delivered` / `session_missing` / `unknown`）になった。
    // **commit 本文は書き換わらないので、いつ偽になったかが本文からは読めない。**
    //
    // ⟹ **残してよいのは「新しい委譲の宛先からは外れている」まで**（`list()` が
    // `lost` を除くので実測で真）。落とすのは送信可否の推論だけである。生の値は
    // PR #586 のコメント（`pull/586#issuecomment-5450674492`）に在る。
    //
    // **次の一手の語はこの面のものを使う。** CLI には器（runner）を見る命令が
    // 無いので、`tools.ts` のように `runner_list` を名指ししない（Web UI が
    // 同じ理由で画面に無いものを名指ししていないのと同じ形）。
    if (manager.runnerLostSince !== undefined) {
      lines.push(
        `      ⚠ 宛先の器は ${manager.runnerLostSince} 以降 名乗っていない。` +
          '新しい委譲の宛先からは外れている（置き先として数えない）。' +
          '**この委譲が失われたという意味ではない** — ' +
          '黙っているのが器なのか経路なのかは、ここからは言えない（器の中でまだ走っていることもある）。' +
          '話しかけることは塞いでいない — 戻る先（session_id）が在れば、' +
          '/msg で送ると resume を試みる（届くとは限らない）。' +
          '打つ手はこの委譲の側ではなく器の側にある — 名乗らなくなった器そのものを確かめること',
      );
    }
    // **宛先の器が名簿から entry ごと消えている**（Issue #1212 running 側。段1。
    // `ManagerSummary.runnerVanished`）。上の `runnerLostSince`（entry は残って
    // いるが黙っている）とは別の集合で、排他ではない。文言の核は `manager_list`
    // （`packages/core/src/tools.ts` の `describeRunnerVanished`）と揃える。
    // 消えた時刻は持たない——名簿に残っていない。
    //
    // **走り始めの時刻（`startedAt`）は core 版に揃えて足す（Issue #1883の
    // 「軽微な点」）。** core の `describeRunnerVanished` は「この委譲の走り
    // 始めは ${manager.startedAt}」を含めるが、CLI 版はここを手で写した際に
    // 落としていた——矛盾ではないが揃っていなかった（同じ関数の中の変更
    // なので、この PR で一緒に直す）。
    if (manager.runnerVanished === true) {
      lines.push(
        `      ⚠ 宛先の器が名簿から消えている（この委譲の走り始めは ${manager.startedAt}。` +
          '消えた時刻は名簿に残っていないので分からない）。' +
          'resume を試したわけではないので「戻れなかった(lost)」ではなく、lost で絞っても出てこない。' +
          '状態は走行中のまま残っている — 確かめる前に起こし直さないこと（同じ仕事が2本になる）',
      );
    }
    // **`runnerLostSince` とは別の欄である（#563）。** あちらは器が黙った
    // （`live` が落ちる）。こちらは**器は答えている**が、この委譲のセッションだけが
    // 無い——`sessionId` が在れば resume から入り直せるので `live` は落ちない。
    // ⟹ 状態は `[running]` のままで、この行だけが5つ目の形を名指しする。
    //
    // **「失われた」と読ませない。** 完遂した後にセッションが畳まれ、終端イベント
    // だけが届かなかった回も同じ形に見え、デーモンには区別する材料が無い
    // （`packages/core/src/manager.ts` の `sendFailureDetail` の doc）。
    if (manager.sessionMissingSince !== undefined) {
      lines.push(
        `      ⚠ 宛先の runner は ${manager.sessionMissingSince} の時点で、この委譲のセッションを持っていなかった` +
          '（runner がそう答えた。聞けなかったのではない）。' +
          // **由来を畳まない（#579）。** クローンの面（`manager_list`）と同じ
          // 生成元（`describeSessionMissingKind`）から取る——ここで自前で書くと、
          // 同じ状態が面によって違う次の一手を指すことになる。
          describeSessionMissingKind(manager.sessionMissingKind) +
          '**この委譲が失われたという意味ではない** — ' +
          '完遂した後にセッションが畳まれ、終端の合図だけが届かなかった回も同じ形に見える。' +
          'まず /manager で生ログを確かめること（報告が届いていなくても、' +
          'そこに書き終えた報告が残っていることがある）。話しかければ resume から入り直す',
      );
    }
    // **`lost` を状態名だけで済ませない。** クローン（`manager_list`）と Web UI には
    // 但し書きが出るのに、ここだけ `[lost]` としか出ていなかった＝同じ状態を見て
    // 人間とクローンが違う判断をする形になっていた。
    //
    // 言い切れるのは観測した分までである（PR #60）。デーモンが見ているのは
    // 「前のセッションへ戻れたか」だけで、成果の有無は見ていない — 落ちる直前に
    // PR をマージまで済ませていた仕事が `lost` になった実例がある。
    if (manager.status === 'lost') {
      lines.push(
        '      ⚠ 前のセッションへ戻れなかった。見ているのは戻れたかどうかだけで、' +
          '成果が既に外へ出ていることがある（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）。' +
          '起こし直す前にそこを確かめること',
      );
    }
    // **Issue #2428**: 依頼者が何を観測していないか（`lost` / `failed` の但し書き）。
    // 字面は `manager_list` の `unobservedOutcomeLine` と同じ生成元
    // （`describeUnobservedOutcome`）から取る。対象外の委譲では `null` で 1 文字も足さない。
    const unobserved = describeUnobservedOutcome(manager);
    if (unobserved !== null) lines.push(`      ${unobserved}`);
    const denied = denialLine(manager.denials, manager.lastReportAt);
    if (denied !== null) lines.push(`      ${denied}`);
    // **`kind`（質問／実行許可）と `askedAt` も出す（#336）。** 種別が読めない
    // と、人間は `/reply` と `/allow` のどちらを打つべきか分からない。どちらも
    // 版のずれの窓（旧 runner の応答）では欠けうる — 欠けても行そのものは
    // 出す（`describeWaitingKind` / `describeAskedAt` の doc）。
    for (const item of manager.waiting) {
      lines.push(
        `      返事待ち (${item.requestId})  種別: ${describeWaitingKind(item.kind)}` +
          `${describeAskedAt(item.askedAt)}: ${summarizeText(item.summary)}`,
      );
    }
    // **失敗は報告の**上**に置く。** 下に置くと、包まれたエラー文（`lastReport`）を
    // 先に読んでから「実は報告ではない」と分かる順になる。
    const failed = failureLine(manager.lastFailure, manager.status, manager.lastFoldedTurn);
    if (failed !== null) lines.push(`      ${failed}`);
    // **枠(利用上限)で止まっている委譲も、同じ「失敗は報告の上」の順で置く
    // （Issue #1883）。** `lastFailure` の行（すぐ上）とは別の軸なので別行
    // ——両方が同時に出ることがある（`usageStoppedLine` の doc、core と同じ
    // 排他にしない決定）。
    const usageStopped = usageStoppedLine(manager.usageStoppedAt, manager.status);
    if (usageStopped !== null) lines.push(usageStopped);
    // **セッションそのものが `failed` として畳まれた落ち方も、同じ順で置く
    // （Issue #1883）。** `lastFailure` とは別の軸なので別行——両方が同時に
    // 出ることがある（`systemErrorLine` の doc）。
    const systemError = systemErrorLine(manager.status, manager.lastSystemError);
    if (systemError !== null) lines.push(systemError);
    // **同じ順で置く（Issue #1883）。** `systemErrorLine`（すぐ上）とは別の軸
    // なので別行——両方が同時に出ることがある。
    const cgroupEvents = cgroupEventsLine(manager.status, manager.lastCgroupEvents);
    if (cgroupEvents !== null) lines.push(cgroupEvents);
    // **失敗した回は「報告」と呼ばない。** 本文は runner 側で
    // 「（このターンは応答を返さずに終わった: …）」と包まれているが、見出しが
    // 「直近の報告」のままだと、人間は包みの内側だけを読んで報告として扱う。
    //
    // **Issue #1882: `lastFoldedTurn` が在る回は、その材料で組む。**
    // `manager.lastReport` は `case 'report'`（`packages/core/src/manager.ts`）
    // の `status === 'stopped'` 早期 return では更新されない——`lastFoldedTurn`
    // が在る回の `lastReport` は畳まれる**前**の無関係な古いターンのままである。
    // それを「直近の報告」「直近のターンの中身」と呼ぶと、実際に直近届いた
    // 本文（`lastFoldedTurn.text`）とは違うものを「直近」と呼ぶことになる
    // ——core の `manager_report`（Issue #1038）が使う見出し「停止後に届いた、
    // 畳まれたターンの中身」と同じ意味で、受信時刻つきで出す。
    if (manager.lastFoldedTurn !== undefined) {
      lines.push(
        `      停止後に届いた、畳まれたターンの中身（${manager.lastFoldedTurn.at} 受信）: ` +
          summarizeText(manager.lastFoldedTurn.text),
      );
    } else if (manager.lastReport) {
      // **Issue #2428**: `result` を受け取らないまま畳まれた回（`lastUnreported`）も
      // 「報告」と呼ばない。判定は `manager_list` と同じ `isFoldedTurnReport`。
      const label = isFoldedTurnReport(manager) ? '直近のターンの中身' : '直近の報告';
      lines.push(`      ${label}: ${summarizeText(manager.lastReport)}`);
    }
    // **Issue #2432**: 受信した報告の status と、いまの status の食い違い。判定も字面も
    // `manager_list` の「（… 受信、⚠ status 食い違い）」と同じ関数（`describeReportDriftMark`）
    // から取る。CLI の報告の行には受信時刻が無く、足すと既存の行の形が変わるので、
    // 印だけを報告の行の直後に別の行で出す。`now` は引数（テストで固定する）。
    // 食い違いが無い・欄が無い（古い daemon）ときは `null` で、何も出さない。
    const reportDrift = describeReportDriftMark(manager, now);
    if (reportDrift !== null) lines.push(`      ${reportDrift}`);
    // **Issue #2428**: ターン終了の報告漏れ（`describeTurnEnd`）と、道具の応答待ちの
    // 矛盾／実行中（`describeToolUseStall`）。**判定も字面も `manager_list`
    // （`packages/core/src/tools.ts`）と同じ関数を呼ぶ**——ここで組み直さない。
    // 欄が無い（古い daemon）・健全な委譲では `null` で、何も出さない（0 や「無い」は書かない）。
    // 返る文字列は `manager_list` の行頭インデント（2 桁）を含むので、この面の深さへ替える。
    const turnEnd = describeTurnEnd(manager);
    if (turnEnd !== null) lines.push(`      ${turnEnd.trimStart()}`);
    const toolUseStall = describeToolUseStall(manager);
    if (toolUseStall !== null) lines.push(`      ${toolUseStall.trimStart()}`);
    // **Issue #1883**: この委譲が抱えている認証トークンの世代が分からない
    // ときに、なぜ分からないかを添える（`tokenGenerationUnknownReasonLine` の
    // doc）。
    const tokenGenerationUnknown = tokenGenerationUnknownReasonLine(
      manager.tokenGenerationUnknownReason,
    );
    if (tokenGenerationUnknown !== null) lines.push(tokenGenerationUnknown);
    // **Issue #1883**: 429の文言のresets時刻を、プールのcooldownUntilと
    // 突き合わせた結果を添える（`resetTimeSkewLine` の doc）。
    const resetTimeSkew = resetTimeSkewLine(
      manager.resetTimeSkewMatch,
      unpushedWorkObservationLine(manager) !== null,
    );
    if (resetTimeSkew !== null) lines.push(resetTimeSkew);
    // **Issue #1883**: `/stop`（running・非force）の断りが最後に取った、
    // 未 push の作業ツリーの観測を添える（`unpushedWorkObservationLine` の
    // doc）。
    const unpushedWork = unpushedWorkObservationLine(manager);
    if (unpushedWork !== null) lines.push(unpushedWork);
  });
  return lines.join('\n');
}

/** `GET /managers` が返す1件の `waiting`（1本の確認）。 */
type ManagerWaitingItem = ManagerListItem['waiting'][number];

/**
 * 種別（質問／実行許可）を人間が読める語へ。
 *
 * **`kind` は省略されうる。** 新しいデーモンが `drainingSeconds` の猶予中の
 * 旧 runner へ問い合わせる窓があり、そちらの応答には `kind` が乗らない
 * （`railway/README.md`「4. 落ちた側を待つ / 取り直す」）。**分からないものを
 * 分かった顔で書かない** — 「実行許可」と決めつけると、実際は質問だった
 * ときに人間が `/allow` を打ってしまう。
 */
function describeWaitingKind(kind: ManagerWaitingItem['kind']): string {
  if (kind === 'question') return '質問';
  if (kind === 'permission') return '実行許可';
  return '種別不明';
}

/**
 * `askedAt` を人間が読める形へ（無ければ欄そのものを出さない）。
 *
 * **絶対値をそのまま出す。** `renderManagerList` の他の欄（`作成`/`更新`）と
 * 同じ約束で、相対表現（「4時間前」）はここで作らない（`AGENTS.md`「時刻の
 * 扱い」）。**無いときは空文字や `-` で埋めない** — それ自体が「取れない軸に
 * 意味の決まっていない値を作る」ことになる（`kind` と同じ版ずれの窓で欠ける）。
 */
function describeAskedAt(askedAt: ManagerWaitingItem['askedAt']): string {
  return askedAt === undefined ? '' : `  確認: ${askedAt}`;
}

/**
 * マネージャーの返事待ちを、番号付きで人間が読める形へ（`/waiting`）。
 *
 * `/approvals` の一覧（`renderCommitments` と同じ形 — 表示と番号の対応を
 * ここで一緒に作って返す）に揃えてある。番号と (managerId, requestId) の
 * 対応を表示側と別々に作ると、ずれた瞬間に**人間が見ていない確認**へ答える
 * ことになる。
 *
 * **`kind`/`askedAt` が欠けていても行は出す。** 版のずれの窓（旧 runner への
 * 問い合わせ）でも人間の手が残ることを、ここで保証する——欠けたら丸ごと
 * 落とすと、いちばん要るとき（人間の返事を待っている最中）に口が消える。
 */
export function renderWaitingList(managers: ManagerListItem[]): {
  text: string;
  entries: { managerId: string; requestId: string }[];
} {
  const entries: { managerId: string; requestId: string }[] = [];
  const lines: string[] = [];
  for (const manager of managers) {
    for (const item of manager.waiting) {
      entries.push({ managerId: manager.managerId, requestId: item.requestId });
      const [head, ...rest] = redactBody(item.summary).split('\n');
      lines.push(`  [${entries.length}] ${head ?? ''}`);
      for (const line of rest) lines.push(`      ${line}`);
      lines.push(
        `      manager: ${manager.managerId}  requestId: ${item.requestId}` +
          `  種別: ${describeWaitingKind(item.kind)}${describeAskedAt(item.askedAt)}`,
      );
    }
  }
  if (entries.length === 0) {
    return { text: '（返事待ちのマネージャーはいません）', entries: [] };
  }
  return { text: lines.join('\n'), entries };
}

type ScheduleSpecInput =
  | { type: 'daily'; at: string }
  | { type: 'every'; minutes: number }
  | { type: 'cron'; expression: string };

/**
 * 人間が書く周期の言い方を、先頭から必要なぶんだけ読む。
 *
 * `09:00` なら毎日その時刻、`30m` / `30` なら分ごと、`cron` なら**続く5項目**が式。
 * cron 式は空白を含むので、依頼の本文との境目を語数で決める（引用符を人間に
 * 要求すると、シェルの引用と混ざって書けなくなる）。読めなければ null。
 */
function takeWhen(tokens: string[]): { spec: ScheduleSpecInput; request: string } | null {
  const [head, ...tail] = tokens;
  if (head === undefined) return null;

  if (head === 'cron') {
    // cron の標準は5項目（分・時・日・月・曜日）
    if (tail.length < 6) return null;
    return {
      spec: { type: 'cron', expression: tail.slice(0, 5).join(' ') },
      request: tail.slice(5).join(' '),
    };
  }

  const request = tail.join(' ');
  if (/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(head)) {
    return { spec: { type: 'daily', at: head }, request };
  }
  const minutes = /^(\d+)m?$/.exec(head);
  if (minutes === null) return null;
  const parsed = Number(minutes[1]);
  return parsed >= 1 ? { spec: { type: 'every', minutes: parsed }, request } : null;
}

/**
 * `/usage from=2026-08-01 to=2026-08-14 manager=abc` のような `key=value` を読む。
 * 順不同・省略可。知らない key は無視する（typo で無言のまま無視されるより、
 * 全期間を見せて「絞れていない」と気づける形にする）。
 */
interface UsageFilters {
  from?: string;
  to?: string;
  managerId?: string;
  layer?: UsageLayer;
  site?: UsageSite;
  /**
   * どの認証トークンで（issue #2079）。**値の集合は閉じていない**（プールの
   * 中身は器ごとに違う）ので、`layer`/`site` と違って検査しない——`usage.ts`
   * の `UsageOptions.token` の doc と同じ理由。存在しない id を弾かず、
   * そのままデーモンへ渡す。
   */
  tokenId?: string;
}

type ParsedUsageFilters = { ok: true; filters: UsageFilters } | { ok: false; message: string };

/**
 * `key=value` トークン列を Record へ。`=` が無い・値が空のトークンは無視する。
 *
 * `/usage from=… to=…`（`parseUsageFilters`）と `/conversations limit=… scan=…`
 * `/conversation <id> scan=…` が共有する慣習。窓を広げる知識（何が読めない値
 * かの判定）は呼び出し側が持つ — ここは字面を割るだけ。
 */
function parseKeyValueTokens(tokens: string[]): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const token of tokens) {
    const [key, ...valueParts] = token.split('=');
    const value = valueParts.join('=');
    if (value.length === 0 || key === undefined) continue;
    raw[key] = value;
  }
  return raw;
}

/** `/journal [件数] [type=<種別1,種別2>] [q=<語>]` を解いた結果（issue #2073）。 */
export type ParsedJournalSearchTokens =
  { ok: true; limit?: string; type?: string; q?: string } | { ok: false; message: string };

/**
 * `/journal [件数] [type=<種別1,種別2>] [q=<語>]` を解く。
 *
 * **`q=` は、そのトークンから行末までを1つの語として扱う。** 呼び出し元は
 * 行を空白で割った後のトークン列を渡してくる（`line.split(/\s+/)`）ので、
 * `parseKeyValueTokens` をそのまま使うと **空白を含む語で探せない** ——
 * 「語で探す」口としては使いものにならない。`/usage` / `/conversations` の
 * `key=value` の慣習は保ったまま、値の側だけ行末まで伸ばす。だから
 * `type=` も `q=` と同じ「行末まで読む」領域には置かず、`q=` より前
 * （`before`）だけを見る——`type=` の値そのものにカンマ以外の区切りは
 * 無いので、行末まで伸ばす理由が無い。
 *
 * **件数は従来どおり先頭の位置引数である**（`/journal 50`）。既存の呼びを
 * 1文字も変えないため、`type=` にも `q=` にも当たらない最初のトークンを
 * 件数として読む——`type=` を素通しで「最初の非空トークン」と読むと、
 * `/journal type=decision 50` のような並びで `type=decision` を件数として
 * 誤読する。
 *
 * **`q=`・`type=`（値が空）は渡さない**のと同じに倒す。HTTP 側は空文字列を
 * 「絞らない」に倒すので結果は同じだが、渡さないほうが意図が読みやすい。
 *
 * **知らない種別は 400 を待たずにその場で断る**（`/managers` の `status=`・
 * `/usage` の `layer=`/`site=` と同じ慣習）。種別の集合は core の
 * `JOURNAL_ENTRY_TYPES` だけが持つので、書き写さずそこから使える値の一覧を
 * 組む。
 */
export function parseJournalSearchTokens(tokens: string[]): ParsedJournalSearchTokens {
  const qIndex = tokens.findIndex((token) => token.startsWith('q='));
  const before = qIndex === -1 ? tokens : tokens.slice(0, qIndex);

  const typeToken = before.find((token) => token.startsWith('type='));
  const type = typeToken?.slice('type='.length);

  const limit = before.find((token) => token.length > 0 && !token.startsWith('type='));

  if (type !== undefined && type.length > 0) {
    const unknown = type
      .split(',')
      .filter((value) => value.length > 0)
      .filter((value) => !(JOURNAL_ENTRY_TYPES as readonly string[]).includes(value));
    if (unknown.length > 0) {
      return {
        ok: false,
        message:
          `type= に知らない値が入っています: ${unknown.join(', ')}` +
          `（使えるのは ${JOURNAL_ENTRY_TYPES.join(' / ')}）`,
      };
    }
  }

  if (qIndex === -1) {
    return {
      ok: true,
      ...(limit === undefined ? {} : { limit }),
      ...(type === undefined || type.length === 0 ? {} : { type }),
    };
  }
  const q = tokens.slice(qIndex).join(' ').slice('q='.length);
  return {
    ok: true,
    ...(limit === undefined ? {} : { limit }),
    ...(type === undefined || type.length === 0 ? {} : { type }),
    ...(q.length === 0 ? {} : { q }),
  };
}

/**
 * `/usage from=… to=… manager=… layer=… site=… token=…` を解く。
 *
 * **層と場所の値の集合は core の schema だけが持つ**（`narrowUsageAxis`）。chat 側に
 * 書き写すと、値が増えたときにここだけ古くなる。読めない値は 400 を待たずにその場で
 * 「どれを指定すればよいか」を返す。
 *
 * **`token=` は検査しない（issue #2079）。** 値の集合が閉じていない（認証
 * トークンのプールは器ごとに違う）ので、CLI が許された値の一覧を持てない
 * ——`usage.ts` の `UsageOptions.token` / `alteroid usage --token` と同じ
 * 受け渡し。
 */
function parseUsageFilters(tokens: string[]): ParsedUsageFilters {
  const raw = parseKeyValueTokens(tokens);
  const layer = narrowUsageAxis<UsageLayer>(usageLayerSchema, raw.layer);
  if (!layer.ok) return { ok: false, message: `layer= は ${layer.allowed} のどれか` };
  const site = narrowUsageAxis<UsageSite>(usageSiteSchema, raw.site);
  if (!site.ok) return { ok: false, message: `site= は ${site.allowed} のどれか` };
  return {
    ok: true,
    filters: {
      ...(raw.from === undefined ? {} : { from: raw.from }),
      ...(raw.to === undefined ? {} : { to: raw.to }),
      ...(raw.manager === undefined ? {} : { managerId: raw.manager }),
      ...(layer.value === undefined ? {} : { layer: layer.value }),
      ...(site.value === undefined ? {} : { site: site.value }),
      ...(raw.token === undefined ? {} : { tokenId: raw.token }),
    },
  };
}

/** 番号（直前の一覧の並び）でも id そのままでも指せるようにする。 */
function resolveListedId(reference: string, listed: string[]): string | null {
  if (/^\d+$/.test(reference)) return listed[Number(reference) - 1] ?? null;
  return reference;
}

/**
 * 失敗した応答から、人間に見せる理由を1行取り出す（issue #670）。
 *
 * **デーモンが書いた文をそのまま使う。** `/managers` の 400 は3種類あり、
 * どれも「次に何を打てばよいか」まで書いてある（`apps/daemon/src/app.ts` の
 * `parseManagerStatuses` の呼び出し側と錨の実在検査）。CLI 側で言い換えると
 * その案内が消えるうえ、断り方が増えたときにここだけ古くなる。
 *
 * **読めなければ状態コードだけを言う**——`access.ts` / `profile.ts` /
 * `login.ts` が既に同じ倒し方をしている（`typeof body.error === 'string'`）。
 * **黙って空文字を返さない**（理由が無いのと、理由が読めないのを混ぜない）。
 */
/**
 * 既存の文言の後ろへ、`errorDetail` を足す（`マネージャーの一覧を読めませんでした — …`
 * の形。issue #2172 / PR #2175 と同じ）。**固定の文言だけを返して状態コードも理由も
 * 捨てる口を作らないための、口ごとに共通の1本。**
 */
async function withDetail(
  message: string,
  response: { status: number; json: () => Promise<unknown> },
): Promise<string> {
  return `${message} — ${await errorDetail(response)}`;
}

async function errorDetail(response: { status: number; json: () => Promise<unknown> }) {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const { error } = body as { error?: unknown };
      if (typeof error === 'string' && error.length > 0) return redactError(error);
    }
  } catch {
    // 本文が JSON でない（プロキシの HTML 等）。状態コードへ倒す。
  }
  return `HTTP ${response.status}（理由は読めませんでした）`;
}

/**
 * 抜けるときの `POST /chat/:id/end`。**要求が通ってから**「蒸留しています」と言う。失敗
 * （例外・非 ok）は、会話は終わっておらず蒸留も走っていないこと、あとで終えられることを
 * 出す。終了コードは変えない（REPL の他のエラーと同じく、書いて正常に戻る）。
 */
export async function endConversationOnExit(
  client: DaemonClient,
  target: Target,
  conversationId: string,
  write: (text: string) => void = (text) => void stdout.write(text),
): Promise<void> {
  write('\n（会話を終えています…）\n');
  let reason: string;
  try {
    const response = await client.chat[':conversationId'].end.$post({
      param: { conversationId },
    });
    if (response.ok) {
      write('（学びを記憶へ蒸留しています…）\n');
      return;
    }
    reason = describeAuthFailure(response.status, target) ?? (await errorDetail(response));
  } catch (error) {
    reason = redactError(error instanceof Error ? error.message : String(error));
  }
  write(
    `会話 ${conversationId} を終えられませんでした（${reason}）。会話は終わっておらず、` +
      '学びの蒸留も走っていません。あとで Web の会話画面の「会話を終える」か、' +
      `alteroid tui で /conversations から開き直して /end で終えられます\n`,
  );
}

/** `/managers [status=…] [limit=…] [after=…]` を解いた結果（issue #670）。 */
export type ParsedManagerFilters =
  | {
      ok: true;
      /**
       * `GET /managers` へそのまま渡す絞り込みと窓の大きさ。**1つも無ければ
       * `$get` へ渡るクエリは空になり、応答は従来と1バイト違わない**（あの口の
       * opt-in は生のクエリで判定される。`apps/daemon/src/app.ts` の `optedIn`）。
       */
      query: { status?: string; limit?: string };
      /**
       * 錨の**参照**（番号か id）。`startedAt` はここには無い——組にするのは
       * `Listed.managerAnchors` を引ける呼び出し側の仕事である（そちらの doc）。
       */
      after?: string;
    }
  | { ok: false; message: string };

/**
 * `/managers` の絞り込みと窓を解く（issue #670）。
 *
 * **`status=` の値の集合は core の schema だけが持つ**（`parseUsageFilters` の
 * `narrowUsageAxis` と同じ理由——chat 側に書き写すと札が増えたときにここだけ
 * 古くなる）。**読めない値は 400 を待たずにその場で「どれを指定すればよいか」を
 * 返す。** デーモンも同じ検査を持っているので、これは二重の門であって唯一の
 * 門ではない（`apps/daemon/src/app.ts` の `parseManagerStatuses`）。
 *
 * **`limit=` は検査しない。** 範囲（1〜1000）を持つのはデーモンの側で、ここに
 * 数を書き写すと片方だけ動いたときに CLI が「通るはずの値」を拒む側になる。
 * 落ちたら 400 の本文をそのまま出す（`/managers` のハンドラ）。
 *
 * **`after=` は錨の *片方* しか受け取らない。** 残りの `startedAt` は
 * `Listed.managerAnchors` から引く（そちらの doc）ので、この関数は文字列を
 * 解くだけで、引き当ての失敗は呼び出し側が言う。
 */
export function parseManagerFilters(tokens: string[]): ParsedManagerFilters {
  const raw = parseKeyValueTokens(tokens);

  if (raw.status !== undefined) {
    // **空の要素（`status=a,,b`）は落とす。** デーモンの `parseManagerStatuses`
    // が同じ落とし方をするので、ここで知らない値として数えると CLI だけが
    // 断る形になる。
    const unknown = raw.status
      .split(',')
      .filter((value) => value.length > 0)
      .filter((value) => !jobStatusSchema.safeParse(value).success);
    if (unknown.length > 0) {
      return {
        ok: false,
        message:
          `status= に知らない値が入っています: ${unknown.join(', ')}` +
          `（使えるのは ${jobStatusSchema.options.join(' / ')}）`,
      };
    }
  }

  return {
    ok: true,
    query: {
      ...(raw.status === undefined ? {} : { status: raw.status }),
      ...(raw.limit === undefined ? {} : { limit: raw.limit }),
    },
    ...(raw.after === undefined ? {} : { after: raw.after }),
  };
}

/**
 * 窓がいっぱいだったことと、続きの打ち方を出す（issue #670）。
 *
 * **言えるのは「要求した上限とちょうど同じ件数が返った」という1つの事実だけ
 * である**——`GET /managers` は封筒（`total` / `nextCursor`）を持たないので、
 * 残りが何件かも、そもそも残っているかも言えない（`noteIfAtLimit` の doc が
 * 同じ線を引いている）。**黙って切らないためだけに出す。**
 *
 * **`noteIfAtLimit` を使わずに別に持つ理由は、続きの打ち方まで出すことである。**
 * 錨は「直前の一覧の最後の番号」なので、この一覧の件数がそのまま次の `after=`
 * になる——`/conversation <番号|id> scan=<N>` と同じで、次の一手を人間に
 * 組み立てさせない。**`status=` は打たれた字面をそのまま繰り返す**（絞りを
 * 外した命令を案内すると、続きを読んだつもりで別の一覧へ移る）。
 *
 * `limit=` を渡していないときは `null`（窓を掛けていないので、切れていない）。
 */
export function renderManagersWindowNote(
  count: number,
  query: { status?: string; limit?: string },
): string | null {
  const { limit, status } = query;
  if (limit === undefined) return null;
  // **`Number(limit)` が NaN なら黙る。** 読めない値はデーモンが 400 で断る側
  // なので、ここへ来たなら数として通っている——それでも `!==` は NaN で必ず
  // 真になり、切れていない一覧に注記を付けてしまう。
  if (!Number.isFinite(Number(limit)) || count !== Number(limit)) return null;
  const statusPart = status === undefined ? '' : ` status=${status}`;
  return (
    `limit=${limit} 件ちょうど返った。これより古い委譲が残っているかもしれない（判定できない）。\n` +
    `  続きは /managers${statusPart} limit=${limit} after=${count}\n`
  );
}

/** `/reply` `/allow` `/deny` の宛先解決の結果。 */
type WaitingTarget =
  { ok: true; managerId: string; requestId: string } | { ok: false; message: string };

/**
 * `/reply` `/allow` `/deny` の第1引数を (managerId, requestId) へ解く。
 *
 * **番号なら `/waiting` の並びをそのまま引く**（`Listed.waiting`）。数字で
 * なければ **`requestId` そのもの**として受け、**`GET /managers` を引き直して
 * その `requestId` を持つマネージャーを探す** — 先に `/waiting` を打っていな
 * くても効くようにするためである（#336）。
 *
 * **宛先を CLI 側で当てない。** 同じ `requestId` を複数のマネージャーが持つ
 * ことは、`requestId` が SDK 側の識別子である以上、原理的には否定できない
 * （`AGENTS.md`「踏みやすい地雷」）。見つかったものが2件以上なら、どちらへも
 * 送らず両方の `managerId` を出す — 先頭を選ばない。0件なら「待っている
 * マネージャーは居ません」と言って終わる（推測しない）。
 */
async function resolveWaitingTarget(
  reference: string,
  listedWaiting: Listed['waiting'],
  client: ReturnType<typeof createClient>,
): Promise<WaitingTarget> {
  if (/^\d+$/.test(reference)) {
    const entry = listedWaiting[Number(reference) - 1];
    if (entry === undefined) {
      return { ok: false, message: `[${reference}] は /waiting の一覧にありません` };
    }
    return { ok: true, managerId: entry.managerId, requestId: entry.requestId };
  }

  const response = await client.managers.$get({
    // **窓は渡さない**（issue #670。渡さなければ応答は1バイトも変わらない
    // ＝この呼びの挙動は何も変えていない。CLI へ窓を通すかは別 issue で、
    // ここは 型の追随だけである。`ManagerListItem` の doc）。
    query: {},
  });
  if (!response.ok) {
    return {
      ok: false,
      message: await withDetail('マネージャーの一覧を読めませんでした', response),
    };
  }
  const { managers } = await response.json();
  const owners = managers.filter((manager) =>
    manager.waiting.some((item) => item.requestId === reference),
  );
  if (owners.length === 0) {
    return {
      ok: false,
      message: `${reference} という requestId を待っているマネージャーは居ません`,
    };
  }
  if (owners.length > 1) {
    return {
      ok: false,
      message:
        `${reference} は複数のマネージャーが待っています。どちらか分からないので` +
        `送っていません: ${owners.map((manager) => manager.managerId).join(' / ')}`,
    };
  }
  const owner = owners[0];
  if (owner === undefined) {
    return {
      ok: false,
      message: `${reference} という requestId を待っているマネージャーは居ません`,
    };
  }
  return { ok: true, managerId: owner.managerId, requestId: reference };
}

/** `/allow` `/deny` を引数なしで打ったときの宛先解決の結果。 */
type DecisionOnlyTarget = { ok: true; managerId: string } | { ok: false; message: string };

/**
 * `/allow` `/deny` を引数なしで打ったとき（宛先を書かずに decision だけ送る形）
 * の、宛先（マネージャー）解決。
 *
 * `POST /managers/:id/messages` は `managerId` を URL に要求するので、
 * `requestId` を省いても宛先そのものは要る。**ここでも当てない** —
 * 返事待ちのマネージャーが2本以上あれば、どちらへも送らず候補を出す。1本
 * だけなら、その1本の中の曖昧さ（複数の確認を同時に待っている場合）は
 * デーモンの `#choosePending`（`packages/core/src/manager.ts`）が解く。
 */
async function resolveDecisionOnlyManager(
  client: ReturnType<typeof createClient>,
): Promise<DecisionOnlyTarget> {
  const response = await client.managers.$get({
    // **窓は渡さない**（issue #670。渡さなければ応答は1バイトも変わらない
    // ＝この呼びの挙動は何も変えていない。CLI へ窓を通すかは別 issue で、
    // ここは 型の追随だけである。`ManagerListItem` の doc）。
    query: {},
  });
  if (!response.ok) {
    return {
      ok: false,
      message: await withDetail('マネージャーの一覧を読めませんでした', response),
    };
  }
  const { managers } = await response.json();
  const waiting = managers.filter((manager) => manager.waiting.length > 0);
  if (waiting.length === 0) {
    return { ok: false, message: '返事待ちのマネージャーはいません' };
  }
  if (waiting.length > 1) {
    return {
      ok: false,
      message:
        '複数のマネージャーが返事待ちです。どれに送るか分からないので送っていません: ' +
        waiting.map((manager) => manager.managerId).join(' / '),
    };
  }
  const only = waiting[0];
  if (only === undefined) {
    return { ok: false, message: '返事待ちのマネージャーはいません' };
  }
  return { ok: true, managerId: only.managerId };
}

/**
 * 引用符（`"..."` / `'...'`）を1トークンとして保つ簡易トークナイザ。
 *
 * `/answers` の各回答は1語だが、複数語にしたいときだけ引用符で囲めるように
 * するための道具。`line.split(/\s+/)` では引用符の中の空白ごと割れてしまう
 * ので、コマンド本体は `/answers` の処理でだけこちらを使う（他のコマンドの
 * 単純な空白分割は変えない）。
 */
function tokenizeQuoted(text: string): string[] {
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const tokens: string[] = [];
  for (const match of text.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

/**
 * シェルに近い分け方: 空白で割るが、引用符（`"..."` / `'...'`）の中の空白は保ち、**語の途中の
 * 引用符も効く**（`--other q2="ただし 来週"` が1語になる）。`tokenizeQuoted`（`/answers` 用）は
 * 引用符が語の先頭にあるときだけ効くので、`設問id=文` の形には使えない。
 */
function tokenizeWithQuotes(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * `/answer <番号|id> --select q1=a --select q2=a,b --other q2=テキスト [補足]` の、番号の後ろの
 * トークンを読む（issue #2525）。`--select` は `<設問id>=<選択肢id>[,<選択肢id>...]`、
 * `--other` は `<設問id>=<文>`（文に `=` があってもよい。最初の `=` で割る）。どちらも `--名前 値` と
 * `--名前=値` の両方で書け、同じ設問に何度書いてもよい（選択肢は書いた順に足す）。残りの
 * トークンは補足の自由文になる。**突き合わせはデーモンが行う**（知らない id は 400 で返る）。
 */
function parseStructuredAnswer(
  tokens: string[],
): { selections: ApprovalSelection[]; supplement: string } | { error: string } {
  const selections: ApprovalSelection[] = [];
  const supplement: string[] = [];
  const entryOf = (questionId: string): ApprovalSelection => {
    let entry = selections.find((candidate) => candidate.questionId === questionId);
    if (entry === undefined) {
      entry = { questionId, optionIds: [] };
      selections.push(entry);
    }
    return entry;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    const flag = /^--(select|other)(?:=([\s\S]*))?$/.exec(token);
    if (flag === null) {
      supplement.push(token);
      continue;
    }
    const name = flag[1] as 'select' | 'other';
    let value = flag[2];
    if (value === undefined) {
      i += 1;
      value = tokens[i];
    }
    const eq = value === undefined ? -1 : value.indexOf('=');
    if (value === undefined || eq <= 0) {
      return {
        error:
          `--${name} は --${name} <設問id>=${name === 'select' ? '<選択肢id>[,<選択肢id>...]' : '<文>'}` +
          ' の形で書いてください',
      };
    }
    const questionId = value.slice(0, eq);
    const rest = value.slice(eq + 1);
    const entry = entryOf(questionId);
    if (name === 'select') {
      entry.optionIds.push(
        ...rest
          .split(',')
          .map((optionId) => optionId.trim())
          .filter((optionId) => optionId !== ''),
      );
    } else {
      entry.other = entry.other === undefined ? rest : `${entry.other} ${rest}`;
    }
  }
  if (selections.length === 0) {
    return { error: '--select か --other に1つ以上の設問を書いてください' };
  }
  return { selections, supplement: supplement.join(' ') };
}

/** `/answers` の1件ぶん — どの承認待ちに、何を答えるか。 */
interface AnswerPair {
  reference: string;
  answer: string;
}

/**
 * `/answers` のトークン列を (番号|id, 回答) の対へ読む。
 *
 * トークン数が偶数でない・答えが空、のどちらかがあれば全体を不正として
 * `null` を返す（一部だけ解釈して送ると、書いたつもりの件が黙って落ちる）。
 */
function parseAnswerPairs(tokens: string[]): AnswerPair[] | null {
  if (tokens.length === 0 || tokens.length % 2 !== 0) return null;
  const pairs: AnswerPair[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const reference = tokens[i];
    const answer = tokens[i + 1];
    if (reference === undefined || answer === undefined || answer.length === 0) return null;
    pairs.push({ reference, answer });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// 引き受けたまま終わっていない仕事の台帳
// ---------------------------------------------------------------------------

const COMMITMENT_ORIGIN_LABEL: Record<Commitment['origin'], string> = {
  human: '人間',
  manager: 'マネージャー',
  external: '外部',
  self: '自分',
};

/**
 * 読めない行が在ることの断り（issue #296）。無ければ空文字。
 *
 * **id が取れない行は件数だけに数える**（`packages/core/src/tools.ts` の
 * `commitment_list` ・`packages/core/src/digest.ts` ・`apps/web` の
 * `UnreadableNote` と同じ扱い。行が壊れている以上、id という材料が
 * そもそも無いことがある）。
 *
 * **「片付いたのではない」を落とさないこと。** これを落とすと、読めない行が
 * 静かに未了から消えたのと区別が付かなくなる（`packages/core/src/store.ts` の
 * `CommitmentList` の doc と同じ理由）。
 */
function renderUnreadableNotice(unreadable: UnreadableCommitment[]): string {
  if (unreadable.length === 0) return '';
  const ids = unreadable.map((entry) => entry.id).filter((id): id is string => id !== undefined);
  return (
    `  ⚠ 読めない行が ${unreadable.length} 件あります` +
    (ids.length === 0 ? '' : `（id: ${ids.join(', ')}）`) +
    '。片付いたのではありません。'
  );
}

/**
 * 読めない承認待ちの断り（issue #2298。`renderUnreadableNotice` と同じ形）。0件なら空文字。
 * **「壊れた行であって、回答済み・取り下げ済みではない」を落とさない。** 番号は振らない
 * （読めない行へは `/answer` できない）。
 */
function renderUnreadableApprovalNotice(unreadable: UnreadableApproval[]): string {
  if (unreadable.length === 0) return '';
  const ids = unreadable.map((entry) => entry.id).filter((id): id is string => id !== undefined);
  return (
    `  ⚠ 読めない承認待ちが ${unreadable.length} 件あります` +
    (ids.length === 0 ? '' : `（id: ${ids.join(', ')}）`) +
    '。壊れた行であって、回答済み・取り下げ済みではありません。この一覧には載っていません。'
  );
}

/**
 * 読めない委譲の断り（issue #2345。`renderUnreadableApprovalNotice` と同じ形）。
 * 0件なら空文字。**「壊れた行であって、居ないのでも、畳まれたのでもない」を落とさない。**
 * 番号は振らない（読めない行へは `/msg` も `/stop` もできない）。
 */
function renderUnreadableJobNotice(unreadable: readonly UnreadableJob[]): string {
  if (unreadable.length === 0) return '';
  const ids = unreadable.map((entry) => entry.id).filter((id): id is string => id !== undefined);
  return (
    `  ⚠ 読めない委譲が ${unreadable.length} 件あります` +
    (ids.length === 0 ? '' : `（id: ${ids.join(', ')}）`) +
    '。壊れた行であって、居ないのでも、畳まれたのでもありません。この一覧には載っていません。'
  );
}

/**
 * 読めない継続中の依頼の断り（issue #2343。`renderUnreadableApprovalNotice` と同じ形）。
 * 0件なら空文字。**「壊れた行であって、消された依頼ではない」を落とさない。**
 * kind が取れた行は `/unschedule <kind>` で外せる（ストアの `removeIfPresent` は読めない行も外す）。
 */
function renderUnreadableScheduleNotice(unreadable: UnreadableSchedule[]): string {
  if (unreadable.length === 0) return '';
  const kinds = unreadable
    .map((entry) => entry.kind)
    .filter((kind): kind is string => kind !== undefined);
  return (
    `  ⚠ 読めない継続中の依頼が ${unreadable.length} 件あります` +
    (kinds.length === 0 ? '' : `（kind: ${kinds.join(', ')}）`) +
    '。壊れた行であって、消された依頼ではありません。この一覧には載っていません。' +
    (kinds.length === 0 ? '' : '外すなら /unschedule <kind> です。')
  );
}

/**
 * 保持上限を超えて物理削除された片付き行の断り（issue #416）。0件なら空文字。
 *
 * **`renderUnreadableNotice` と同じ形にする。** どちらも `CommitmentList`
 * （`packages/core/src/store.ts`）の「無い」でも「片付いた」でもない状態を運ぶ
 * ——`unreadable` は読めなかった行、こちらは既に消えた行という違いだけである。
 */
function renderTrimmedClosedNotice(trimmedClosed: number): string {
  if (trimmedClosed === 0) return '';
  return (
    `  ⚠ 保持上限を超えて物理削除された片付き行が累計 ${trimmedClosed} 件あります。` +
    '削除された分の内容はここでは二度と読めません。'
  );
}

/**
 * 台帳を、人間が読む形へ（`/commitments`）。
 *
 * **番号と id の対応をここで一緒に作って返す。** 表示側と `/done` 側で別々に
 * 並べ直すと、ずれた瞬間に**人間が見ていないものを閉じる**。番号は片付いたものにも
 * 振る — 抜け番にすると、人間が数え直して指すことになる。
 *
 * 表示を関数に出してあるのは `renderManagerList` / `renderUsage` と同じ理由で、
 * 何を出しているかを端末なしで確かめられるようにするためである。
 */
export function renderCommitments(
  commitments: Commitment[],
  now: number = Date.now(),
  unreadable: UnreadableCommitment[] = [],
  trimmedClosed = 0,
): { text: string; ids: string[] } {
  // **読めない行の断りを、読める行が0件のときも出す（issue #296）。** これを
  // 下の早期 return より後ろへ置くと、台帳が読めない行だけになったときに
  // 「引き受けたまま終わっていない仕事はありません」とだけ出る ——
  // **いちばん危ない状態が、いちばん安心な文言で出る。**
  //
  // **CLI にも出すのは、口ごとに能力差を作らないためである**（`docs/PRD.md`
  // 「要件: インターフェース（CLI・HTTP API・Web UI）」）。Web
  // （`apps/web/app/routes/commitments.tsx` の `UnreadableNote`）と
  // クローン（`packages/core/src/tools.ts` の `commitment_list`）にだけ在って
  // ここに無いと、**CLI で台帳を読んだ人間だけが、読めない行の存在を知らない。**
  // **保持上限の削除（issue #416）も同じ理由で同じ扱いにする。**
  const notices = [renderUnreadableNotice(unreadable), renderTrimmedClosedNotice(trimmedClosed)]
    .filter((line) => line !== '')
    .join('\n');

  if (commitments.length === 0) {
    return {
      text:
        notices === ''
          ? '（引き受けたまま終わっていない仕事はありません）'
          : `${notices}\n（読める行は無い）`,
      ids: [],
    };
  }

  const lines: string[] = [];
  const ids: string[] = [];
  if (notices !== '') lines.push(notices);

  commitments.forEach((commitment, index) => {
    ids.push(commitment.id);
    const closed = commitment.closedAt !== undefined;
    // **本文は畳む。** 器は全文を持つ（要約を持たせない）ので、切るのは表示側の
    // 仕事である。畳まないと、数千字の依頼1本で一覧が流れて読めなくなる。
    lines.push(`  [${index + 1}] ${closed ? '✓ ' : ''}${summarizeText(commitment.body)}`);
    const from =
      COMMITMENT_ORIGIN_LABEL[commitment.origin] +
      (commitment.source === undefined ? '' : `(${commitment.source})`);
    // **5項目を揃える**（人間の依頼: id + 名前 + 概要 + updated_at + created_at）。
    // 名前は「起点」、概要は上の本文の抜粋、作成は受け取った時刻、更新は
    // 片付けた時刻（まだなら受け取った時刻）。**齢の表示は残す** — 人間が
    // 一覧を読むときに効くのはそこで、ISO を足したから要らなくなるものではない。
    lines.push(
      `      id: ${commitment.id}  起点: ${from}  作成: ${commitment.at}` +
        `（${formatElapsedAgo(commitment.at, now)}）  更新: ${commitmentUpdatedAt(commitment)}`,
    );
    if (closed) {
      lines.push(
        `      片付けた: ${commitment.closedAt ?? ''}  ${summarizeText(commitment.closedReason ?? '')}`,
      );
    }
  });

  return { text: lines.join('\n'), ids };
}

function summarize(entry: Record<string, unknown>): string {
  for (const key of ['text', 'decision', 'question', 'summary', 'body', 'tool']) {
    const value = entry[key];
    if (typeof value === 'string') return summarizeText(value);
  }
  // **`worker_wait` / `turn_usage` / `context_usage` / `inbox_flow`（と、下の `github_observation`）は
  // 上の6キーのどれも持たず、ここまで来ると要約が空欄のまま出ていた**
  // （issue #2016）。Web（`packages/swr/src/hooks/queries.ts` の
  // `summarizeJournalEntry`）と同じ文言を、共有の口
  // （`@alteroid/core/journal-diagnostics-format`）から借りる——2箇所で
  // 複製しない。残り9種（この6キーで拾えている種別）は1文字も変えない。
  if (isJournalDiagnosticsEntry(entry)) return summarizeJournalDiagnosticsEntry(entry);
  // **`github_observation`（#2245）も6キーのどれも持たない**（本文は `result` の中）。repo・観測者
  // （申告であることを落とさない）・ok なら件数、failed なら理由を出す。failed に数は無い。
  if (entry.type === 'github_observation') return summarizeGithubObservation(entry);
  return '';
}

function summarizeGithubObservation(entry: Record<string, unknown>): string {
  const result = entry.result as
    | {
        status?: string;
        openIssues?: number;
        openPulls?: number;
        ci?: Parameters<typeof describeGithubCi>[0]['ci'];
        ciUnavailable?: string;
        truncated?: boolean;
        reason?: string;
      }
    | undefined;
  const head = `${String(entry.repo)}（観測者 ${String(entry.observedBy)}）`;
  if (result?.status === 'ok') {
    return (
      `${head} open Issue ${String(result.openIssues)} 件 / open PR ${String(result.openPulls)} 件` +
      (result.truncated === true ? '（limit に達した。下限）' : '') +
      ` / ${describeGithubCi(result)}`
    );
  }
  if (result?.status === 'failed')
    return `${head} 取れなかった: ${summarizeText(result.reason ?? '')}`;
  return head;
}

/**
 * `entry.type` が `JOURNAL_DIAGNOSTICS_TYPES`（4種）のどれかであることの
 * 判別。**欄の形までは検査しない**——`GET /journal` はサーバ側で
 * `journalEntrySchema` を通った行しか返さないので、`type` が一致すれば
 * 欄の形も一致する前提を置く（`entry` を `Record<string, unknown>` で
 * 緩く受けているのはこの関数の呼び出し元と同じ理由——`chat.test.ts` の
 * `JournalEntryLike` と同じ緩さ）。
 */
function isJournalDiagnosticsEntry(
  entry: Record<string, unknown>,
): entry is JournalDiagnosticsEntryLike {
  return (
    typeof entry.type === 'string' &&
    (JOURNAL_DIAGNOSTICS_TYPES as readonly string[]).includes(entry.type)
  );
}

function summarizeText(value: string): string {
  // 伏せ字を先に掛ける（切ってからだとトークンの途中で切れて形が崩れ、取りこぼす）。
  const single = redactBody(value).replace(/\s+/g, ' ').trim();
  return single.length > 80 ? `${single.slice(0, 80)}…` : single;
}

/** `/attach <path>` / `/attachments` / `/detach <番号|all>`（添えかけの操作。送るときに上がる）。 */
export async function runAttachmentCommand(line: string, draft: AttachmentDraft): Promise<void> {
  const match = /^\/(\w+)\s*([\s\S]*)$/.exec(line.trim());
  const command = match?.[1] ?? '';
  const args = (match?.[2] ?? '').trim();
  if (command === 'attach') {
    if (args === '') {
      stdout.write('使い方: /attach <path>\n');
      return;
    }
    const added = await draft.add(unquotePath(args));
    if (!added.ok) {
      stdout.write(`添えられません: ${added.reason}\n`);
      return;
    }
    stdout.write(
      `添えかけ ${draft.count} 件（${added.file.name}）。本文を打って送ると一緒に上がります（空行の Enter なら添付だけを送る）\n`,
    );
    return;
  }
  if (command === 'attachments') {
    for (const text of draft.describe()) stdout.write(`${text}\n`);
    return;
  }
  if (args === '') {
    stdout.write('使い方: /detach <番号|all>\n');
    return;
  }
  const removed = draft.remove(args);
  stdout.write(
    removed.ok
      ? `外した: ${removed.removed.map((f) => f.name).join(', ')}（残り ${draft.count} 件）\n`
      : `外せません: ${removed.reason}\n`,
  );
}

/** パスの前後の引用符（シェルの癖で付けがち）を外す。 */
function unquotePath(raw: string): string {
  const match = /^(['"])(.*)\1$/.exec(raw);
  return match === null ? raw : (match[2] ?? raw);
}

/**
 * `/event` の本文を API の payload（JSON）にする。**Web の予定の画面
 * （`apps/web/app/routes/schedule.tsx` の `EventForm`）と同じ解釈**で、webhook の
 * `POST /events/:source` とも同じ（issue #3146）: JSON として読めればその値、読めなければ
 * 文字列のまま。空の本文は JSON として読めないので空文字列になる（Web が source だけで
 * 送れるのと同じ）。入口ごとに解釈が違うと、同じ `{"a":1}` でもクローンが読む本文と
 * 重複判定の鍵（`JSON.stringify(payload)`）が入口で変わってしまう。
 * 共有の純関数は無いので同じ規則を書いてある（Web 側は変えていない）。
 */
export function parseEventPayload(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}
