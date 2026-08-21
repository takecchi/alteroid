import { randomUUID } from 'node:crypto';

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { isCronExpression } from './cron.js';
import { describePage, excerptLine, page } from './excerpt.js';
import type { ManagerDenial, ManagerPool, ManagerSummary } from './manager.js';
import { renderMemoryDocuments } from './memory.js';
import type { ProfileService } from './profile-service.js';
import {
  RESERVED_SCHEDULE_KINDS,
  describeScheduleSpec,
  localDate,
  localDayRange,
  parseTimeOfDay,
} from './schedule.js';
import { JOURNAL_ENTRY_TYPES, scheduleKindSchema, scheduleSpecSchema } from './schema.js';
import type {
  ChatStreamEvent,
  JournalEntry,
  MemoryDocumentMeta,
  PendingApproval,
  ScheduleSpec,
  ScheduledRequest,
} from './schema.js';
import { CANON_REVISION, canonDocument, canonNames, describeCloneRuntime } from './self.js';
import type { CloneRuntimeFacts } from './self.js';
import type { Stores } from './store.js';
import type { AccountUsageState } from './usage-snapshot.js';
import {
  ACCOUNT_USAGE_TITLE,
  describeAccountUsage,
  formatUsd,
  summarizeUsage,
  usageLayerSchema,
  usageSiteSchema,
  type UsageAggregate,
  type UsageBreakdown,
  type UsageTotals,
} from './usage.js';

/**
 * クローンの道具（インプロセス MCP）。
 *
 * **ここにあるのは「足す分」であって「持てる全部」ではない。** クローンは preset
 * 一式（`tools` を渡さない）と人間の MCP 連携（`settingSources`）も持っていて、
 * ここに並ぶのは alteroid 固有の口 — 記憶・日誌・承認・委譲・実行環境 — だけである
 * （`clone.ts` の `#buildOptions`）。
 *
 * **「クローンは組み込みツールを持たない」と書き足さないこと。** 一度そう書いて
 * 実装もそうなっていたが、それは north_star「適用範囲」が名指しで否定している推論
 * だった（人間は道具を持たない存在ではない ＝ 写像として成り立たない。#32）。
 *
 * モデルから見える名前は `mcp__alteroid__<tool>` になる。
 */
export const MCP_SERVER_NAME = 'alteroid';

export interface ToolContext {
  stores: Stores;
  /** いま人間と繋がっている会話へイベントを流す（繋がっていなければ捨てる）。 */
  emit(event: ChatStreamEvent): void;
  /**
   * 委譲先。省略できるのは蒸留用の短命セッションのためで、そこでは
   * マネージャーを起こさない（記憶へ移すだけの内部ターン）。
   */
  managers?: ManagerPool;
  /**
   * 実行環境プロファイルを置いて配るための器と宛先。
   *
   * **クローンにも人間と同じ手を持たせる。** 人間は自分の `~/.zshenv` を開いて
   * 直せるのだから、その写像であるクローンにできないのは能力の削除である
   * （north_star 禁止2 は層を問わず効く）。鍵が文脈に載ることは**方針**
   * （システムプロンプト）で扱い、道具を取り上げて表現しない。
   */
  profile?: ProfileService;
  /**
   * アカウント全体の利用状況（claude.ai 側が言っている値）を読む口。
   *
   * **人間が `claude.ai/settings/usage` で見られるものである。** クローンが
   * 見られないのは能力の削除（north_star 禁止1）なので、`usage_read` から同じものを
   * 返す。無ければ「まだ分からない」と出す — **0 とは言わない。**
   */
  accountUsage?: () => AccountUsageState;
  /**
   * いま自分がどう走っているか（`self_status` の材料）。
   *
   * **省略できるのはテストのためだけである。** 本番の配線（`clone.ts`）は本セッションと
   * 蒸留のサイドクエリの両方へ渡す。落とすと、渡し忘れた側だけ `self_status` が
   * 「この場面では取れない」を返す（例: 蒸留のサイドクエリだけ自分のことが分からない）。
   */
  runtime?: () => CloneRuntimeFacts;
}

export function qualifiedToolName(name: string): string {
  return `mcp__${MCP_SERVER_NAME}__${name}`;
}

export const CLONE_TOOL_NAMES = [
  'memory_list',
  'memory_read',
  'memory_write',
  'memory_append',
  'journal_write',
  'journal_read',
  'ask_human',
  'approvals_list',
  'daily_report_write',
  'usage_read',
  'schedule_list',
  'schedule_create',
  'schedule_remove',
  'commitment_list',
  'commitment_open',
  'commitment_close',
  'profile_read',
  'profile_write',
  'self_read',
  'self_status',
  'manager_start',
  'manager_send',
  'manager_stop',
  'manager_list',
  'manager_report',
  'runner_list',
] as const;

/**
 * 一覧の既定の大きさ。
 *
 * **件数に比例して伸びる出力を作らない。** MCP の出力上限を超えた応答は
 * クローンに1文字も届かず（SDK はファイルへ落とすので、いまはクローンが `Read` で
 * 追える。**それでもここを緩めない** — 一覧を読むたびにファイルを開き直すのは
 * 人間が Web UI で一覧を見るのと等価ではない）、一覧が丸ごと使えなくなる。
 * 実測では 52,997 文字で溢れた。
 * 人間は Web UI で件数によらず一覧を見られるので、ここが壊れるのは
 * 能力の削除である（north_star 禁止1）。M5 で runner が増えれば件数も増える。
 */
const LIST_REQUEST_EXCERPT = 160;
const LIST_REPORT_EXCERPT = 240;
const LIST_BUDGET = 8_000;
/**
 * 一覧に添える拒否は、**新しい側から**この件数まで。
 *
 * 上限で切るのは 1 本の異常が一覧を食い潰さないためだが、**切ったことは必ず
 * 言う**（`denialLine`）。黙って落とすと「3種類しか止められていない」に見える。
 */
const LIST_DENIED_TOOLS = 3;
/** 全文を取りに来たときの1回分。続きは `offset` で取れる。 */
const REPORT_PAGE = 8_000;

/**
 * 未了の台帳を1回に出す件数と、1件ぶんの本文の厚み。
 *
 * **切ったことは必ず言う**（`LIST_DENIED_TOOLS` と同じ理由）。「これで全部だ」と
 * 読まれた台帳は、載っているのに見えない仕事を作る＝この器が塞ごうとしている穴が
 * そのまま戻る。
 */
const COMMITMENT_LIST_LIMIT = 30;
const COMMITMENT_BODY_LIMIT = 240;

/**
 * 日誌の一覧の予算と、1件ぶんの本文の厚み。
 *
 * **`manager_list` とは用途が違う。** あちらは全体の要約だが、日誌は
 * 「特定の時刻の1行を探す」ために引く。探す側にとって要るのは
 * *いつ・誰が・どの型か*であって本文の厚みではないので、**本文を薄くして
 * 件数を残す**側へ倒す。全文が要ると分かった1件は `id` で取りに行く。
 */
const JOURNAL_TEXT_EXCERPT = 120;
const JOURNAL_BUDGET = 8_000;
/** 日誌1件の全文を取りに来たときの1回分。続きは `offset` で取れる。 */
const JOURNAL_PAGE = 8_000;

/**
 * 自作ツールは確認なしで通す（能力の削除ではなく、道具が道具として使えること）。
 *
 * **これは「使える道具の一覧」ではない。** `allowedTools` は確認を省く側の一覧で
 * あって、ここに無い道具が使えなくなるわけではない（SDK: "To restrict which tools
 * are available, use the `tools` option instead."）。ここへ組み込みツールを
 * 書き足す／ここから消すことで、クローンの能力を調整しようとしないこと。
 */
export const CLONE_ALLOWED_TOOLS = CLONE_TOOL_NAMES.map(qualifiedToolName);

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

/**
 * 一覧に添える「確認へ上がらず止められた」件数の行。
 *
 * **`status` は「動いている」を意味しない。** 分類器か deny 規則がその場で拒否
 * すると、その仕事は `running` のまま手が止まる。それが日誌と（繰り返したときだけ）
 * 受信箱にしか出ていなかったので、一覧を見ているクローンには止まっていることが
 * 見えなかった。
 *
 * **ここでも観測した分しか言わない。** 数えているのは拒否そのものであって、
 * その結果マネージャーが止まったかどうかは見ていない（動きを見る手がデーモンに
 * 無い）。数は器を作り直せば消えるので、そのことも書く — 「0 件」を
 * 「止められていない」と読まれると、作り直し直後がいちばん静かに見える。
 */
function denialLine(denials: ManagerDenial[]): string | null {
  if (denials.length === 0) return null;
  // 帳面は古い順に積まれている。**新しい側から**採る。
  const recent = [...denials].reverse();
  const shown = recent.slice(0, LIST_DENIED_TOOLS);
  const rest = recent.length - shown.length;
  const total = denials.reduce((sum, entry) => sum + entry.count, 0);
  return (
    `  ⚠ 確認へ上がらず止められた道具: ${shown.map((e) => `${e.tool} ${e.count}件`).join(' / ')}` +
    (rest > 0 ? `（ほか ${rest} 種、全 ${total} 件）` : '') +
    '。この確認はクローンには回ってきていないので、手が止まっている可能性がある' +
    '（全件は journal_read に残っている。件数はデーモンを作り直すと数え直しになる）。'
  );
}

const NO_POOL = text(
  'いまは委譲できない場面である（記憶へ移すための内部ターン）。' +
    '実作業が必要なら、この場では記憶に残すだけにして、次の会話で委譲すること。',
);

/** ツール定義そのもの。MCP の配線を通さずに単体テストできるよう分けてある。 */
export function createCloneTools(context: ToolContext) {
  const { stores } = context;

  return [
    // --- 記憶 -----------------------------------------------------------
    tool('memory_list', '記憶の文書一覧を返す。中身は返さない。', {}, async () => {
      const documents = await stores.persona.list();
      if (documents.length === 0) return text('（記憶はまだ空）');
      return text(
        documents.map((doc) => `- ${doc.slug}: ${doc.title} (${doc.updatedAt})`).join('\n'),
      );
    }),

    tool(
      'memory_read',
      '記憶の文書を1つ読む。',
      { slug: z.string().describe('文書のスラッグ（拡張子なし）') },
      async ({ slug }) => {
        const doc = await stores.persona.read(slug);
        return text(doc ? doc.content : `記憶 ${slug} は存在しない。`);
      },
    ),

    tool(
      'memory_write',
      [
        '記憶の文書を全文置換する（無ければ作る）。',
        '人間がこのファイルを直接開いて読むことを前提に、Markdown として読みやすく書くこと。',
        '人間が手で書いた記述を、整形の都合で消さないこと。',
      ].join(' '),
      {
        slug: z.string().describe('文書のスラッグ（英小文字・数字・-・_）'),
        content: z.string().describe('Markdown 全文'),
        summary: z.string().describe('何を更新したかの一行要約（日誌に残る）'),
      },
      async ({ slug, content, summary }) => {
        await stores.persona.write(slug, content);
        await stores.journal.append({ type: 'memory_update', slug, cause: 'clone', summary });
        return text(`記憶 ${slug} を更新した。`);
      },
    ),

    tool(
      'memory_append',
      '記憶の文書の末尾に追記する（無ければ作る）。既存の記述を消したくないときはこちら。',
      {
        slug: z.string().describe('文書のスラッグ'),
        content: z.string().describe('追記する Markdown'),
        summary: z.string().describe('何を追記したかの一行要約（日誌に残る）'),
      },
      async ({ slug, content, summary }) => {
        await stores.persona.append(slug, content);
        await stores.journal.append({ type: 'memory_update', slug, cause: 'clone', summary });
        return text(`記憶 ${slug} に追記した。`);
      },
    ),

    // --- 日誌 -----------------------------------------------------------
    tool(
      'journal_write',
      [
        '判断を日誌に残す（追記専用）。',
        '人間に聞かずに実行した判断は必ずここに残すこと。',
        '人間が後から読んで否定できることが、最終承認の実体である。',
      ].join(' '),
      {
        decision: z.string().describe('何を判断し、何をしたか'),
        grounds: z.string().describe('記憶のどこに根拠があったか。無いなら「根拠なし」と書く'),
      },
      async ({ decision, grounds }) => {
        const entry = await stores.journal.append({ type: 'decision', decision, grounds });
        return text(`日誌に記録した（${entry.id}）。`);
      },
    ),

    /**
     * 日誌を掘る道具。
     *
     * **これは「探す」ための口である。** 全文を素で並べていたときは、200 件を
     * 頼むと 178,524 文字になって MCP の出力上限で丸ごと落ち、クローンには
     * 1 文字も届かなかった（SDK はファイルへ落とすが、クローンにファイルを
     * 読む道具は無い）。人間は Web UI と `GET /journal` で日誌を読めるので、
     * これは能力の削除そのものである（north_star 禁止1）。
     *
     * 直し方は `manager_list` ↔ `manager_report` と同じ形にした。
     * 一覧は**予算を先に決めて入るところまで**積み、本文は抜粋にして
     * *いつ・誰が・どの型か*と `id` を必ず残す。全文が要る1件は `id` で取る。
     *
     * **`until` が無いと過去は掘れない。** 返るのは新しい順なので、`since` だけ
     * では手前の最新分が `limit` を食い尽くし、狙った時刻には決して届かない。
     */
    tool(
      'journal_read',
      [
        '日誌を新しい順に読む。過去の一点を掘るには since/until で窓を閉じること',
        '（新しい順に返るので、until を指定しないと最新分しか見えない）。',
        '一覧の本文は抜粋で、全文が要る1件は id を渡して取る。',
      ].join(' '),
      {
        limit: z.number().int().min(1).max(200).optional().describe('件数（既定 20）'),
        since: z
          .string()
          .optional()
          .describe('ISO 8601。この時刻以降だけ返す（例 2026-08-15T09:00:00Z）'),
        until: z
          .string()
          .optional()
          .describe('ISO 8601。この時刻以前だけ返す。過去を掘るときはこれを指定する'),
        types: z
          .array(z.enum(JOURNAL_ENTRY_TYPES))
          .optional()
          .describe('種別で絞る。省略すると全種別'),
        id: z
          .string()
          .optional()
          .describe('この1件を全文で読む（一覧に出ている id）。他の条件は無視される'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('id で全文を読むとき、何文字目から読むか'),
      },
      async ({ limit, since, until, types, id, offset = 0 }) => {
        // --- 全文モード（1件だけ） ---
        if (id !== undefined) {
          const entry = await stores.journal.get(id);
          if (!entry) return text(`日誌 ${id} は無い（id が違うか、まだ書かれていない）。`);
          const { head, body } = renderJournalEntry(entry);
          if (body === '') return text(`${entry.at} ${head}`);
          const part = page(body, offset, JOURNAL_PAGE);
          const tail = part.more
            ? `\n\n…（ここで切れている。続きは journal_read id=${entry.id} offset=${part.to}）`
            : '';
          return text(`${entry.at} ${head}（${describePage(part)}）\n\n${part.body}${tail}`);
        }

        // --- 一覧モード ---
        const requested = limit ?? 20;
        const entries = await stores.journal.list({
          limit: requested,
          ...(since === undefined ? {} : { since }),
          ...(until === undefined ? {} : { until }),
          ...(types === undefined || types.length === 0 ? {} : { types }),
        });
        if (entries.length === 0) {
          return text(
            since === undefined && until === undefined && types === undefined
              ? '（日誌はまだ空）'
              : '（その条件に当たる日誌は無い）',
          );
        }

        // **予算を先に決めて、入るところまで積む。** 件数から出力量を決めると、
        // 何件で壊れるかが運任せになる（それで丸ごと落ちた）。切ったなら必ずそう言う。
        const lines: string[] = [];
        let used = 0;
        let shown = 0;
        for (const entry of entries) {
          const { head, body } = renderJournalEntry(entry);
          const line =
            `${entry.at} ${head} id=${entry.id}` +
            (body === '' ? '' : `\n  ${excerptLine(body, JOURNAL_TEXT_EXCERPT)}`);
          if (shown > 0 && used + line.length > JOURNAL_BUDGET) break;
          lines.push(line);
          used += line.length;
          shown += 1;
        }

        const rest = entries.length - shown;
        if (rest > 0) {
          lines.push(
            `…ほか ${rest} 件は省略（この条件で ${entries.length} 件あり、新しい順に ${shown} 件だけ出した）。` +
              'さらに遡るなら until を、狭めるなら since / types を指定すること。',
          );
        }
        lines.push('（本文は抜粋。全文は journal_read id=<id> で取れる）');
        return text(lines.join('\n'));
      },
    ),

    // --- 人間への確認 ----------------------------------------------------
    tool(
      'ask_human',
      [
        '人間に確認する。記憶に根拠が無いことだけをここへ回す。',
        'これは承認待ちキューに積むだけで、人間の応答を待たない。',
        '止まるのはこの件だけであり、他の仕事は進めてよい。',
        '回答は後から受信箱に届く。',
      ].join(' '),
      {
        question: z.string().describe('人間への質問。何を判断してほしいかを具体的に'),
        context: z.string().optional().describe('判断に必要な背景'),
        managerId: z
          .string()
          .optional()
          .describe('マネージャーからの確認を人間に回す場合、その manager_id'),
        requestId: z
          .string()
          .optional()
          .describe(
            'マネージャーからの確認を人間に回す場合、受信箱に届いた requestId。' +
              '人間の回答をこの確認へ返すために必要なので、managerId と必ず対で渡すこと',
          ),
      },
      async ({ question, context: background, managerId, requestId }) => {
        const approval: PendingApproval = {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          question,
          ...(background === undefined ? {} : { context: background }),
          ...(managerId === undefined ? {} : { jobId: managerId }),
          ...(requestId === undefined ? {} : { requestId }),
        };
        await stores.jobs.putApproval(approval);
        await stores.journal.append({
          type: 'escalation',
          question,
          approvalId: approval.id,
        });
        context.emit({ type: 'ask_human', approvalId: approval.id, question });
        return text(`承認待ちキューに積んだ（${approval.id}）。回答は後から届く。`);
      },
    ),

    tool(
      'approvals_list',
      [
        'いま人間の回答を待っている件の一覧。',
        '人間が席に居ないあいだに溜まる。溜まっていても他の仕事は進めてよい。',
      ].join(' '),
      {},
      async () => {
        const pending = await stores.jobs.listApprovals({ pendingOnly: true });
        if (pending.length === 0) return text('（人間の回答待ちは無い）');
        return text(
          pending
            .map((approval) =>
              [
                `- ${approval.id}（${approval.createdAt}）${approval.question}`,
                approval.jobId === undefined
                  ? null
                  : `  宛先: managerId: "${approval.jobId}"` +
                    (approval.requestId === undefined
                      ? ''
                      : `, requestId: "${approval.requestId}"`),
              ]
                .filter((line) => line !== null)
                .join('\n'),
            )
            .join('\n'),
        );
      },
    ),

    // --- 日報 --------------------------------------------------------------
    tool(
      'daily_report_write',
      [
        'その日の日報を残す。人間が普段読むのはこれだけである。',
        '今日何をしたか・何が決まったか・何が保留か、が読んだだけで分かるように書くこと。',
      ].join(' '),
      {
        date: z
          .string()
          .optional()
          .describe('対象日 YYYY-MM-DD（省略時は今日。締めの指示に書かれた日付を使うこと）'),
        body: z.string().describe('日報の本文（Markdown）'),
      },
      async ({ date, body }) => {
        // 存在しない日付（2026-02-31 など）で残すと、その日報は二度と読めない。
        // 形の検査だけでは通ってしまうので localDayRange に確かめさせる。
        const target =
          date !== undefined && localDayRange(date) !== null ? date : localDate(new Date());
        await stores.journal.append({ type: 'daily_report', date: target, body });
        return text(`${target} の日報を残した。`);
      },
    ),

    // --- 利用状況（いくら使ったか） --------------------------------------------
    /**
     * **人間が見られるものは、クローンからも見られること。**
     *
     * 人間は `claude.ai/settings/usage` と Web UI で消費を見られる。その写像である
     * クローンが見られないなら、それは能力の削除である（north_star 禁止1）。
     *
     * これは飾りではなく**判断の材料**である。委譲を続けてよいか、重い仕事を
     * いま投げてよいかは、残りが見えなければ勘で決めるしかない。実際に支出上限へ
     * 当たって走行中のマネージャーが2本同時に落ちたとき、クローンには事前に
     * 知る手段が無く、マネージャーの返答から推測するしかなかった。
     */
    tool(
      'usage_read',
      [
        'alteroid が使った分（トークンと費用）を台帳から読む。',
        '軸は5つ — 日・マネージャー（誰の分か）・モデル・layer（誰が: clone / manager）・site（どこで: session / distill）。',
        '**推定値であり請求明細ではない。**',
        '記録は台帳を置いた日から始まっているので、それより前は 0 ではなく「記録が無い」と出る。',
        'まとめ表示は軸ごとに打ち切る。続きは axis と offset で辿れる（打ち切りの行にそのまま書いてある）。',
      ].join(' '),
      {
        from: z.string().optional().describe('この日から（YYYY-MM-DD）。省略すると台帳の全期間'),
        to: z.string().optional().describe('この日まで（YYYY-MM-DD）'),
        managerId: z
          .string()
          .optional()
          .describe('この actor の分だけ（マネージャーの id か "clone"）'),
        layer: usageLayerSchema.optional().describe('誰が使った分だけ（clone / manager）'),
        site: usageSiteSchema.optional().describe('どこで使った分だけ（session / distill）'),
        axis: z
          .enum(USAGE_AXES)
          .optional()
          .describe(
            'この軸だけを offset から出す（まとめ表示・他の軸・アカウント全体の残りは出ない）',
          ),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('axis と一緒に使う。その軸の何件目から出すか'),
      },
      async ({ from, to, managerId, layer, site, axis, offset }) => {
        const aggregate = await stores.usage.aggregate({
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          ...(managerId === undefined ? {} : { managerId }),
          ...(layer === undefined ? {} : { layer }),
          ...(site === undefined ? {} : { site }),
        });
        // **軸モードでは「続きの1軸」だけを返す。** アカウント全体の残りもまとめ表示も
        // 付けない — 続きを辿るほど同じ全体が積み増しで返ってくるのを避けるためである。
        if (axis !== undefined) {
          return text(
            renderUsage(aggregate, { axis, ...(offset === undefined ? {} : { offset }) }),
          );
        }
        return text(
          [
            renderAccountUsage(context.accountUsage?.() ?? { state: 'unknown' }),
            '',
            '## alteroid が使った分（台帳）',
            renderUsage(aggregate),
          ].join('\n'),
        );
      },
    ),

    // --- 継続中の依頼（時間起点の仕込み） --------------------------------------
    tool(
      'schedule_list',
      [
        '仕込んである継続中の依頼の一覧。周期と、前回それで動いた時刻が分かる。',
        '既定の日報・発意 tick はここには出ない（あれは設定で回っているもの）。',
      ].join(' '),
      {},
      async () => {
        const plans = await stores.schedules.list();
        if (plans.length === 0) return text('（継続中の依頼は無い）');
        return text(
          plans
            .map((plan) =>
              [
                `- ${plan.kind}（${describeScheduleSpec(plan.spec)}）`,
                `  依頼: ${plan.request}`,
                `  前回動いた時刻: ${plan.lastRunAt ?? '（まだ一度も動いていない）'}`,
              ].join('\n'),
            )
            .join('\n'),
        );
      },
    ),

    tool(
      'schedule_create',
      [
        'その場で終わらない依頼を、時間起点として仕込む。',
        '時刻が来れば必ずあなたの受信箱へ届き、そのとき依頼の本文と前回動いた時刻が一緒に渡る。',
        '記憶に書くのは判断の根拠であって、記憶は時計を持たない。継続する依頼はここにも置くこと。',
        '同じ kind で呼べば置き換わる（周期や本文の直しはこれで行う）。',
      ].join(' '),
      {
        kind: z
          .string()
          .describe('この依頼の名前（英小文字・数字・. _ -）。後から直す・消すときの識別子'),
        request: z
          .string()
          .describe(
            '依頼の本文。時刻が来たときのあなたが読んで、そのまま動ける粒度で書く' +
              '（対象・狙い・どこまでやるか。人間から頼まれた言葉そのものも残すとよい）',
          ),
        dailyAt: z
          .string()
          .optional()
          .describe('毎日この時刻に起こす（ローカル時刻の HH:MM）。周期はどれか1つだけ渡す'),
        everyMinutes: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('この分数ごとに起こす。周期はどれか1つだけ渡す'),
        cron: z
          .string()
          .optional()
          .describe(
            'cron 式で起こす（ローカル時刻。例: 毎週月曜 10:00 なら `0 10 * * 1`）。' +
              '曜日や月の指定が要るときはこれを使う。周期はどれか1つだけ渡す',
          ),
      },
      async ({ kind, request, dailyAt, everyMinutes, cron }) => {
        const parsedKind = scheduleKindSchema.safeParse(kind);
        if (!parsedKind.success) {
          return text(`kind "${kind}" は使えない（英小文字・数字・. _ - のみ、64文字まで）。`);
        }
        if (RESERVED_SCHEDULE_KINDS.includes(parsedKind.data)) {
          // 名前が使えないことだけ言って黙らない。既定の刻みを変えたいなら手段は
          // 別にあり（デーモンの設定）、それを人間に頼めることまで伝える。
          return text(
            `${parsedKind.data} は既定の定期ジョブの名前なので使えない（別の名前を付けること）。` +
              '日報の締め時刻や発意 tick の間隔そのものを変えたいなら、それはデーモンの設定' +
              '（`ALTEROID_DAILY_REPORT_AT` / `ALTEROID_INITIATIVE_EVERY`）なので人間に頼むこと。',
          );
        }
        const given = [dailyAt, everyMinutes, cron].filter((value) => value !== undefined);
        if (given.length !== 1) {
          return text('dailyAt / everyMinutes / cron のうち、どれか1つだけ渡すこと。');
        }
        if (dailyAt !== undefined && parseTimeOfDay(dailyAt) === null) {
          return text(`dailyAt "${dailyAt}" は HH:MM として読めない。`);
        }
        if (cron !== undefined && !isCronExpression(cron)) {
          return text(
            `cron "${cron}" は cron 式として読めない（例: 毎週月曜 10:00 なら \`0 10 * * 1\`）。`,
          );
        }

        const spec: ScheduleSpec =
          dailyAt !== undefined
            ? { type: 'daily', at: dailyAt }
            : cron !== undefined
              ? { type: 'cron', expression: cron }
              : { type: 'every', minutes: everyMinutes ?? 60 };
        const parsedSpec = scheduleSpecSchema.safeParse(spec);
        if (!parsedSpec.success) return text(`周期を読めなかった: ${parsedSpec.error.message}`);

        const now = new Date().toISOString();
        const existing = await stores.schedules.get(parsedKind.data);
        const plan: ScheduledRequest = {
          kind: parsedKind.data,
          spec: parsedSpec.data,
          request,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          // **これまでの記録を引き継ぐ。** 落とすと、直した瞬間に定期の基準が消えて
          // 位相が createdAt から引き直され（＝直後に1回余分に起きる）、引き受けたまま
          // 終わっていない発火の印も消える（＝その回が失われる）。
          ...(existing?.lastRunAt === undefined ? {} : { lastRunAt: existing.lastRunAt }),
          ...(existing?.lastScheduledRunAt === undefined
            ? {}
            : { lastScheduledRunAt: existing.lastScheduledRunAt }),
          ...(existing?.pendingRun === undefined ? {} : { pendingRun: existing.pendingRun }),
        };
        await stores.schedules.put(plan);
        await stores.journal.append({
          type: 'decision',
          decision:
            `${existing ? '定期の依頼を直した' : '定期の依頼を仕込んだ'}: ` +
            `${plan.kind}（${describeScheduleSpec(plan.spec)}）: ${request}`,
          grounds: '継続する依頼を時間起点として持つ判断',
        });
        return text(
          `${plan.kind} を ${describeScheduleSpec(plan.spec)} で仕込んだ。時刻が来たら依頼の本文とともに届く。`,
        );
      },
    ),

    tool(
      'schedule_remove',
      '継続中の依頼を片付ける。済んだ依頼・もう要らない依頼はここで外す。',
      { kind: z.string().describe('schedule_list に出ている kind') },
      async ({ kind }) => {
        const existing = await stores.schedules.get(kind);
        if (!existing) return text(`継続中の依頼 ${kind} は無い。`);
        await stores.schedules.remove(kind);
        await stores.journal.append({
          type: 'decision',
          decision: `定期の依頼を外した: ${kind}: ${existing.request}`,
          grounds: 'この依頼はもう要らないという判断',
        });
        return text(`${kind} を外した。`);
      },
    ),

    // --- 引き受けたまま終わっていない仕事（未了の台帳） ------------------------
    //
    // **これは「やることの一覧」ではない。** 器が持つのは「何を頼まれたか」と
    // 「まだ片付いていない」の2値だけで、順序も優先度も締切も持たない（PRD「自律」）。
    // 何を先にやるか、そもそもやるかは毎回クローンが記憶に照らして決める。器がするのは
    // **忘れさせないこと**だけである。
    tool(
      'commitment_list',
      [
        '引き受けたまま終わっていない仕事の一覧。古い順に出る。',
        '人間の依頼・マネージャーからの一件・外部イベントは、届いた時点で自動的にここへ載る。',
        '**載っているものは、あなたが閉じるまで消えない。**',
        'どれを先にやるかの順序はここには無い。記憶にある目的と価値観に照らして毎回決め直すこと。',
      ].join(' '),
      {
        includeClosed: z
          .boolean()
          .optional()
          .describe('片付けたものも見る（既定は未了だけ）。何を片付けたかを振り返るとき用'),
      },
      async ({ includeClosed }) => {
        const entries = await stores.commitments.list(
          includeClosed === true ? { includeClosed: true } : undefined,
        );
        if (entries.length === 0) return text('（引き受けたまま終わっていない仕事は無い）');
        const shown = entries.slice(0, COMMITMENT_LIST_LIMIT);
        const rest = entries.length - shown.length;
        return text(
          [
            ...shown.map((entry) =>
              [
                `- ${entry.id}`,
                `  受け取った時刻: ${entry.at}（${entry.origin}${entry.source === undefined ? '' : ` / ${entry.source}`}）`,
                `  ${excerptLine(entry.body, COMMITMENT_BODY_LIMIT)}`,
                entry.closedAt === undefined
                  ? '  状態: 未了'
                  : `  状態: ${entry.closedAt} に片付けた（${excerptLine(entry.closedReason ?? '', 120)}）`,
              ].join('\n'),
            ),
            // 黙って切らない。切ったことが見えないと「これで全部だ」と読まれる。
            ...(rest > 0 ? [`- …ほか ${rest} 件（多い順ではなく古い順に切っている）`] : []),
          ].join('\n'),
        );
      },
    ),

    tool(
      'commitment_open',
      [
        '自分で気づいたことを、引き受けた仕事として台帳に載せる。',
        '人間が「あ、これ直さないと」と思ったときにメモするのと同じもので、',
        'いま手を付けないなら**必ずここへ置くこと** — 会話の文脈はやがて要約に潰れ、',
        '記憶は時計を持たないので、そこにだけ置いた宿題は思い出せるかどうかの賭けになる。',
        '記憶へ書くのは判断の根拠のほうで、両方やってよい。',
      ].join(' '),
      {
        body: z
          .string()
          .min(1)
          .describe(
            '何を引き受けたか。後日のあなたが読んでそのまま動ける粒度で書く（対象・狙い・どこまでやるか）',
          ),
        source: z
          .string()
          .optional()
          .describe('関係する相手や出所（マネージャー id・会話 id など。分かるときだけ）'),
      },
      async ({ body, source }) => {
        const entry = {
          id: randomUUID(),
          at: new Date().toISOString(),
          origin: 'self' as const,
          ...(source === undefined ? {} : { source }),
          body,
        };
        await stores.commitments.open(entry);
        // **自分で決めて引き受けたことは日誌に残す。** 聞かずに動いた判断が後から
        // 否定できることが最終承認の実体である（north_star）。自動で開いたものは
        // 起点ごとに既に日誌へ載っているので、ここで残すのは `self` のぶんだけ。
        await stores.journal.append({
          type: 'decision',
          decision: `引き受けた仕事として台帳に載せた（${entry.id}）: ${body}`,
          grounds: '手を付ける前に忘れないため（記憶は時計を持たない）',
        });
        return text(`台帳に載せた（${entry.id}）。片付いたら commitment_close で閉じること。`);
      },
    ),

    tool(
      'commitment_close',
      [
        '引き受けた仕事が片付いたことを記録する。**返事をしただけでは閉じない。**',
        '委譲したなら、マネージャーが報告を返して始末がつくまでは開いたままにしておくこと。',
        'やらないと決めたのなら、それも片付いたうちである（理由にそう書いて閉じる）。',
      ].join(' '),
      {
        id: z.string().describe('commitment_list に出ている id'),
        reason: z
          .string()
          .min(1)
          .describe(
            '何をもって片付いたとするか（やったこと、あるいはやらないと決めた理由）。' +
              '人間はこれを読んで後から否定する',
          ),
      },
      async ({ id, reason }) => {
        const existing = await stores.commitments.get(id);
        if (existing === null) return text(`引き受けた仕事 ${id} は台帳に無い。`);
        if (existing.closedAt !== undefined) {
          return text(
            `${id} は既に ${existing.closedAt} に片付けてある（${existing.closedReason ?? ''}）。`,
          );
        }
        await stores.commitments.close(id, new Date().toISOString(), reason);
        return text(`${id} を片付けた。`);
      },
    ),

    // --- 実行環境プロファイル --------------------------------------------
    //
    // **人間の `~/.zshenv` に当たるもの。** 人間が自分で開いて直せる以上、
    // その写像であるクローンにできないのは能力の削除である（north_star 禁止2）。
    // 鍵が文脈に載ることは方針（システムプロンプト）で扱う。
    tool(
      'profile_read',
      [
        '実行環境プロファイル（人間の ~/.zprofile に当たるもの）の本文を読む。',
        'ここに書いた export は、あなた自身にも、あなたが起こすマネージャーと作業者にも効く。',
        '**本文には鍵が入っている。読んだ中身を記憶や日誌へ書き写さないこと**',
        '（記憶はあなたのシステムプロンプトに載るし、人間がいつでも開く場所である）。',
      ].join(' '),
      {},
      async () => {
        const current = await stores.profile.read();
        if (current === null) {
          return text('実行環境プロファイルは置かれていない。');
        }
        return text(`（最終更新 ${current.updatedAt}）\n${current.script}`);
      },
    ),

    tool(
      'profile_write',
      [
        '実行環境プロファイルを全文置換する（空文字で外す）。',
        '人間から「このトークンを使って」「PATH にこれを足して」のように**実行環境そのもの**を',
        '渡されたら、会話の中に置いたままにせずここへ移すこと — 会話は要約に潰れ、器は作り直される。',
        '記憶（判断の根拠）とは別の器である。鍵や PATH を記憶に書かないこと。',
        '置く前に実際に読めるかを確かめるので、読めなければ保存も配布もされず理由が返る。',
        '**全文置換なので、足すだけのつもりなら先に profile_read で今の本文を取ること。**',
      ].join(' '),
      {
        script: z
          .string()
          .describe(
            'シェルスクリプト全文（`export FOO=bar` / `export PATH="$HOME/bin:$PATH"` / `eval "$(tool env)"` など）。' +
              '空文字はプロファイルを外す意味になる',
          ),
        summary: z
          .string()
          .describe('何を変えたかの一行要約（日誌に残る。**値そのものは書かない**）'),
      },
      async ({ script, summary }) => {
        if (context.profile === undefined) {
          return text(
            'いまは実行環境プロファイルを差し替えられない場面である（記憶へ移すための内部ターン）。' +
              '次の会話で置くこと。',
          );
        }
        // **人間の口（`PUT /profile`）とまったく同じ1本道を通る。** 評価・保存・
        // 配布が1つの区間として直列に行われるので、人間の更新と重なっても層ごとに
        // 違う本文が残らない。
        const result = await context.profile.apply(script);

        // **失敗を判断として記録しない。** 置けなかったのはシステムの結果であって
        // クローンの判断ではない。理由はそのまま返して、直すのはこの場でやらせる。
        if (!result.stored) {
          return text(
            `実行環境プロファイルを置けなかった（保存も配布もしていない）: ${result.clone.error ?? '理由不明'}` +
              `${result.clone.output === undefined || result.clone.output.length === 0 ? '' : `\n${result.clone.output}`}`,
          );
        }

        await stores.journal.append({
          type: 'decision',
          decision: `実行環境プロファイルを更新した: ${summary}`,
          grounds: '人間から実行環境そのものを渡された（値は記録しない）',
        });

        const failed = result.runners.filter((runner) => !runner.ok);
        const delivered = result.runners.filter((runner) => runner.ok).map((r) => r.runnerId);
        return text(
          [
            `実行環境プロファイルを更新した（sha256 ${result.sha256 ?? '外した'}）。`,
            delivered.length === 0 ? null : `配った先: ${delivered.join(', ')}`,
            failed.length === 0
              ? null
              : `配れなかった先: ${failed.map((r) => `${r.runnerId}（${r.error ?? '理由不明'}）`).join(', ')}`,
            'これから起こす仕事には即座に効く。走行中の仕事は gh / git だけが次の呼び出しから拾う。',
          ]
            .filter((line) => line !== null)
            .join('\n'),
        );
      },
    ),

    // --- 自分自身 -----------------------------------------------------------
    tool(
      'self_read',
      [
        '自分自身（alteroid）の正典を1つ、全文で読む。',
        '自分が何で出来ているか・何が要件か・どう設計されているか・何が未着手かはここにある。',
        'ビルド時に焼き込んだ写しなので、実装の最新が要るならマネージャーにリポジトリを読ませること。',
      ].join(' '),
      {
        document: z
          .string()
          .describe(`正典の名前。読めるのは ${canonNames().join(' / ')}（上ほど優先順位が高い）`),
      },
      async ({ document }) => {
        const doc = canonDocument(document);
        if (doc === undefined) {
          return text(`正典 ${document} は無い。読めるのは ${canonNames().join(' / ')}。`);
        }
        return text(
          `${doc.path}（${CANON_REVISION.length > 0 ? `リビジョン ${CANON_REVISION}` : 'リビジョン不明'} の写し）\n\n${doc.content}`,
        );
      },
    ),

    /**
     * **人間は Claude Code で自分の設定（モデル・版・許可モード・MCP 接続）を見られる。**
     * クローンから見えないなら、その一点で人間の代替になっていない
     * （north_star 禁止1）。ここは `SelfFacts`（システムプロンプトに焼き込む静的な事実）
     * とは別物で、SDK が走行中に実際に報告してくる値を返す。
     *
     * 整形は `self.ts` の `describeCloneRuntime` に寄せてある（自分自身の事実を1か所に
     * 集めるため）。ここで組み立てるのは、その場でしか読めない2つだけ — いまの記憶の
     * 大きさ（会話の途中で書き換わりうる）と、台帳との突き合わせ（SDK モデル id が
     * 分かって初めて意味を持つ）。
     */
    tool(
      'self_status',
      [
        'いま自分が何で走っているかを返す（宣言されたモデル帯・SDK が実際に報告したモデル id・',
        'effort・Claude Code の版・認証の出所（値ではなく名前）・許可モード・MCP サーバ・',
        'セッション id・記憶の大きさ・台帳との突き合わせ）。',
        '**effort はこのセッションで最初の道具呼び出しでは取れない**（前の道具呼び出しの結果として',
        '観測するため）。モデルが effort に対応していない場合もずっと取れない。',
        '取れない値は「まだ分からない」と出る（既定値では埋めない）。',
      ].join(' '),
      {},
      async () => {
        const runtime = context.runtime?.();
        if (runtime === undefined) {
          return text(
            'いまは自分の実行時の事実を読めない場面である（記憶へ移すための内部ターン）。' +
              '次の会話で呼ぶこと。',
          );
        }

        const [documents, memoryDocuments, aggregate] = await Promise.all([
          stores.persona.list(),
          stores.persona.documents(),
          // モデル id が分かっていなければ、突き合わせる軸そのものが無い。
          runtime.sdkModel === null ? Promise.resolve(null) : stores.usage.aggregate({}),
        ]);

        return text(
          [
            describeCloneRuntime(runtime),
            '',
            // **クローンの文脈へ実際に載る形で数える。** 本文だけを足すと、見出しの
            // ぶんだけ本当より少ない数を「いまの総文字数」として名乗ることになる。
            renderMemorySize(documents, renderMemoryDocuments(memoryDocuments)),
            '',
            renderLedgerCrossReference(runtime.sdkModel, aggregate),
          ].join('\n'),
        );
      },
    ),

    // --- 委譲 --------------------------------------------------------------
    tool(
      'manager_start',
      [
        'マネージャー（あなたが起こす Claude Code）に仕事を任せる。',
        '起動して即返るので、完了を待たずに次の判断へ移ってよい。同時に何本走らせてもよい。',
        '依頼できるのは実装だけではない。調査・設計の相談・外部サービスの確認・レビューも同じように頼める。',
      ].join(' '),
      {
        request: z
          .string()
          .describe('依頼内容。人間が Claude Code に書くのと同じ粒度で、背景と狙いを添えて書く'),
        cwd: z
          .string()
          .optional()
          .describe('作業ディレクトリ（実プロジェクトの場所）。省略時はデーモンの既定'),
        runnerId: z
          .string()
          .optional()
          .describe(
            '置き先の器を名指しで指名する（runner_list / manager_list が出す runnerId）。' +
              'これは配置の指名であって本数の制限ではない——省略すれば資源による自動配置。' +
              '指名した器が名簿に無い・使えない・名前が重複のときは失敗し、他の器へは' +
              '自動で落とさない（返ってきた文言をそのまま読むこと）。',
          ),
      },
      async ({ request, cwd, runnerId }) => {
        if (!context.managers) return NO_POOL;
        const started = await context.managers.start({
          request,
          ...(cwd === undefined ? {} : { cwd }),
          ...(runnerId === undefined ? {} : { runnerId }),
        });
        await stores.journal.append({
          type: 'decision',
          decision:
            `マネージャー ${started.managerId} を起こした（cwd: ${started.cwd}` +
            `${runnerId === undefined ? '' : `, 指名: runnerId=${runnerId}`}）: ${request}`,
          grounds: '委譲の判断',
        });
        return text(
          `マネージャー ${started.managerId} を起こした（cwd: ${started.cwd}、` +
            `runner: ${started.runnerId ?? '未記録'}）。` +
            '報告・質問は後から受信箱に届く。',
        );
      },
    ),

    tool(
      'manager_send',
      [
        '走行中のマネージャーへ追加指示を送る、または止まっている質問・許可確認に答える。',
        'そのマネージャーが返事待ちなら、これが回答になる（止まっていたその仕事だけが再開する）。',
        '許可確認への回答では decision を必ず付けること。',
      ].join(' '),
      {
        managerId: z.string().describe('manager_start が返した id'),
        message: z
          .string()
          .describe('マネージャーへの本文。deny のときは、なぜ駄目でどうしてほしいかを書く'),
        decision: z
          .enum(['allow', 'deny'])
          .optional()
          .describe('許可確認への回答のとき必須。それ以外では不要'),
        requestId: z
          .string()
          .optional()
          .describe(
            'どの確認への回答かを示す id（受信箱に届いた requestId）。' +
              '1本のマネージャーが複数を同時に待つことがあるので、回答では必ず添えること',
          ),
      },
      async ({ managerId, message, decision, requestId }) => {
        if (!context.managers) return NO_POOL;
        const result = await context.managers.send(managerId, message, {
          ...(decision === undefined ? {} : { decision }),
          ...(requestId === undefined ? {} : { requestId }),
        });
        return text(result.detail);
      },
    ),

    /**
     * **止める手。**
     *
     * 人間は Web UI と CLI から1本ずつ止められる（`DELETE /managers/:id`）。
     * クローンにそれが無いと、暴走したマネージャーも、報告を出したのに終わらない
     * マネージャーも、**無応答のまま放置するしか手が無い**（north_star 禁止1:
     * 能力の削除）。実際にそうなった。
     *
     * 通す口は人間と同じ `ManagerPool.abort` である。**クローン用の停止を別に
     * 作らない** — 挙動が2種類あると、人間とクローンで見えている状態が食い違う。
     *
     * これは**クローンの道具**であって、マネージャーには渡らない（この MCP は
     * クローン側にしか配線が無い）。マネージャーが自分や隣の仕事を止められる
     * ようになると、M4 の制御面分離が意味を失う。
     */
    tool(
      'manager_stop',
      [
        'マネージャーを止める。人間が Web UI から押す停止と同じもので、その1本だけが止まる。',
        '暴走しているとき、報告を出したのに終わらないとき、依頼自体が要らなくなったときに使う。',
        '止めたあと本当に止まったかを確かめて返すので、返ってきた状態まで読むこと。',
      ].join(' '),
      {
        managerId: z.string().describe('manager_list に出ている id'),
        reason: z
          .string()
          .optional()
          .describe('なぜ止めたか。日誌と、その仕事の記録に残る。後から辿れるように書く'),
      },
      async ({ managerId, reason }) => {
        if (!context.managers) return NO_POOL;
        const pool = context.managers;
        const find = async (): Promise<ManagerSummary | undefined> =>
          (await pool.list().catch(() => [])).find((manager) => manager.managerId === managerId);

        // 止める前の状態を控える。**既に終わっていた仕事を止めたときに、それを
        // そうと言えるようにする**ため（黙って何もしないのが一番悪い）。
        const before = await find();
        const result = await pool.abort(managerId, reason, 'clone');

        // **outcome ごとに言い分ける。** 以前は `outcome` が常に `'stopped'` で、
        // 止まっていない・不明なときも「止めた」と機械可読な形で答えていた
        // （R1）。ここで4値をそのまま文言に写す。
        if (result.outcome === 'absent') {
          // **エラーで終わらせず、何が起きているかを言う。**
          if (!before) {
            return text(
              `${managerId} は居ない（id が違うか、台帳からも消えている）。` +
                'manager_list で今あるものが見える。',
            );
          }
          return text(
            `${managerId} は止められなかった: ${result.detail}\n` +
              `台帳では ${before.status} で、このデーモンからは話しかけられない（live: false）。` +
              '走らせていた器がもう無いので、止める手そのものが残っていない。',
          );
        }

        const after = await find();

        if (result.outcome === 'not_stopped') {
          // **止まっていないと確かめた（明確な失敗）。「止めた」と言わない。**
          return text(
            `[${managerId}] ${result.detail}\n` +
              `**止まっていない。** runner には ${managerId} のセッションがまだ残っている。` +
              `いまの状態: ${after === undefined ? '一覧から消えている' : `${after.status}${after.live ? '' : '/セッション切断'}`}。` +
              ' manager_list で確かめ、必要ならもう一度止めること。',
          );
        }

        if (result.outcome === 'unknown') {
          // **確かめられなかった（不明）。「止めた」とも「止まっていない」とも
          // 言い切らない。**
          return text(
            `[${managerId}] ${result.detail}\n` +
              '止まったかは**未確認**である（runner に確認が取れなかった）。' +
              'manager_list で状態を確かめること。',
          );
        }

        // ここに来るのは outcome === 'stopped'（sessionGone === true を確かめた）。
        const lines = [`[${managerId}] ${result.detail}`];

        if (before?.status === 'done') {
          // **`done` は「マネージャー自身のターンが終わって待機中」でしかない。**
          // その下で作業者が走っているかは、デーモンからは見えていない（作業者の
          // 生存も worktree の更新時刻も、ここからは読めない）。前の文言は
          // 「走っている手は無く」と断定していたが、それは観測ではなく推測である。
          lines.push(
            'もともと待機中（done）だった仕事である。マネージャー自身のターンは終わっていたので、' +
              '畳んだのは記録である。ただし **`done` は「その下で誰も動いていない」ことまでは' +
              '意味しない** — 作業者が走っているかどうかはデーモンからは見えていない。',
          );
        }
        lines.push(
          after === undefined
            ? '一覧からも消えている。'
            : `いまの状態: ${after.status}${after.live ? '' : '/セッション切断'}。`,
        );
        return text(lines.join('\n'));
      },
    ),

    tool(
      'manager_list',
      [
        'マネージャーの一覧と状態を見る。何が走っていて、何が返事待ちかが分かる。',
        // **状態の名前を「観測」より強く読ませない。** running は「走らせた」で
        // あって「進んでいる」ではなく、done は「マネージャーのターンが終わった」
        // であって「仕事が終わった」ではない。⚠ の行がその差を埋める。
        '状態の名前はデーモンが観測できた範囲でしかないので、⚠ の行まで読むこと。',
        '依頼文と報告は抜粋なので、全文が要るなら manager_report で取ること。',
      ].join(' '),
      {},
      async () => {
        if (!context.managers) return NO_POOL;
        const managers = await context.managers.list();
        if (managers.length === 0) return text('（マネージャーは1本も居ない）');

        // **予算を先に決めて、入るところまで積む。** 件数から出力量を決めると、
        // 何件で壊れるかが運任せになる。切ったなら必ずそう言う。
        const lines: string[] = [];
        let used = 0;
        let shown = 0;
        for (const manager of managers) {
          const entry = [
            `- ${manager.managerId} [${manager.status}${manager.live ? '' : '/セッション切断'}]`,
            // **runnerId は空欄にしない。** 取れていないことを「未記録」という
            // 文字列で読める形にする（AGENTS.md「取れない軸に0の行を作らない」と
            // 同じ理由——空欄だと「取れていない」のか「読み忘れ」なのか区別できない）。
            `  runner: ${manager.runnerId ?? '未記録'}`,
            `  依頼: ${excerptLine(manager.request, LIST_REQUEST_EXCERPT)}`,
            `  cwd: ${manager.cwd}`,
            // **`lost` を状態名だけで済ませない。** 「終わった」と読まれると、
            // 完了していない仕事がそのまま片付く。何が起きたかと、次に何をすれば
            // よいかを、この一覧の中で言い切る。
            //
            // **ただし、言い切れるのは観測した分までである。** `lost` が表して
            // いるのは「前のセッションへ戻れなかった」という**一つの**観測で
            // あって、成果の有無ではない。デーモンは PR もブランチも見ていない
            // （リポジトリの事情はマネージャーの領域である）。実際に、落ちる
            // 直前に PR を出して CI を通しマージまで済ませていた仕事が、その
            // 1分半後の器の作り直しで `lost` になり、この行が「途中で失われて
            // いる（完了ではない）」と嘘をついた。
            //
            // 断定を外しても `done` とは混ざらない。「戻れなかった」は
            // 「終えて待っている」ではないからである（PR #42 の分け方は保つ）。
            manager.status === 'lost'
              ? '  ⚠ 前のセッションへ戻れなかった。**戻れたかどうかしか見ていない** — ' +
                'この仕事が終わっていたかは分からない（成果がリモートの PR・ブランチ・' +
                'コミットまで届いていることがある）。まずそこを確かめ、続きが要ると' +
                '判断したときだけ manager_start で起こし直すこと。'
              : null,
            // **拒否は `status` に映らない。** 分類器か deny 規則がその場で止めた
            // 仕事は `running` のまま手が動かない。日誌と（繰り返したときだけ）
            // 受信箱にしか出ないので、一覧を見ているクローンには「走っている」と
            // しか読めなかった。状態の値は増やさず、状態に添える。
            denialLine(context.managers?.denials(manager.managerId) ?? []),
            ...manager.waiting.map(
              (item) => `  返事待ち(requestId: ${item.requestId}): ${item.summary}`,
            ),
            manager.lastReport === undefined
              ? null
              : `  直近の報告: ${excerptLine(manager.lastReport, LIST_REPORT_EXCERPT)}`,
          ]
            .filter((line) => line !== null)
            .join('\n');
          if (shown > 0 && used + entry.length > LIST_BUDGET) break;
          lines.push(entry);
          used += entry.length;
          shown += 1;
        }

        const rest = managers.length - shown;
        if (rest > 0) {
          lines.push(
            `…ほか ${rest} 件は省略（全 ${managers.length} 件）。` +
              '走っているものから順に出している。',
          );
        }
        lines.push('（依頼と報告は抜粋。全文は manager_report <managerId> で取れる）');
        return text(lines.join('\n'));
      },
    ),

    /**
     * 一覧を抜粋にした以上、**全文への行き先が要る。**
     *
     * 人間は Web UI と `GET /managers/:id/transcript` で全文を読める。クローンに
     * 同じ手が無いまま抜粋だけにすると、削っただけになる（north_star 禁止1）。
     * 長ければ切って捨てるのではなく、`offset` で続きを取れる形にする。
     */
    tool(
      'manager_report',
      [
        'マネージャーの依頼文・直近の報告を全文で読む。',
        'manager_list は抜粋なので、欠落に気づいたらここで全部読むこと。',
        '長い場合は続きの取り方が末尾に出るので、最後まで読み切ること。',
      ].join(' '),
      {
        managerId: z.string().describe('manager_list に出ている id'),
        part: z
          .enum(['report', 'request'])
          .optional()
          .describe('report=直近の報告（既定） / request=依頼文'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('何文字目から読むか。前回の応答が示した続きの位置を渡す'),
      },
      async ({ managerId, part = 'report', offset = 0 }) => {
        if (!context.managers) return NO_POOL;
        const managers = await context.managers.list();
        const found = managers.find((manager) => manager.managerId === managerId);
        if (!found) {
          return text(
            `マネージャー ${managerId} は居ない（もう畳まれたか、id が違う）。` +
              'manager_list で今あるものが見える。',
          );
        }

        const body = part === 'request' ? found.request : found.lastReport;
        if (body === undefined || body.length === 0) {
          return text(
            part === 'request'
              ? `マネージャー ${managerId} の依頼文が記録に無い。`
              : `マネージャー ${managerId} からの報告はまだ無い（状態: ${found.status}）。`,
          );
        }

        const label = part === 'request' ? '依頼文' : '直近の報告';
        const part1 = page(body, offset, REPORT_PAGE);
        const head = `マネージャー ${managerId} の${label}（${describePage(part1)}）`;
        const tail = part1.more
          ? `\n\n…（ここで切れている。続きは manager_report managerId=${managerId}` +
            `${part === 'request' ? ' part=request' : ''} offset=${part1.to}）`
          : '';
        return text(`${head}\n\n${part1.body}${tail}`);
      },
    ),

    /**
     * 器（runner）の一覧。**「増えた器をクローンが使えるようになるための前提」
     * の「見る」側。**
     *
     * 人間は増えていく runner のコンテナがいくつあり、それぞれで何本走っているかを
     * 意識できる立場にいる（設定・デプロイの画面から）。クローンにその同じ材料が
     * 無いと、`manager_start` に `runnerId` を渡す判断そのものができない
     * （north_star 禁止1）。
     */
    tool(
      'runner_list',
      [
        '委譲先の器（runner のコンテナ）がいくつあり、それぞれで何本のマネージャーが' +
          '走っているかを見る。manager_start の runnerId に渡す名前もここで分かる。',
        'ここで数えている本数はデーモンの台帳から見た数である。新しいマネージャーを' +
          'どこへ置くか（資源による自動配置）の判断が使う本数は runner 自身が /health で' +
          '名乗る別の値で、この一覧とはずれうる——混ぜて配置の判断を予測しないこと。',
        'state は5値（connecting/connected/unreachable/unusable/lost）のまま出る。' +
          'unreachable（まだ開けていない）と lost（開けていたのに黙った）は別物である。',
      ].join(' '),
      {
        fingerprints: z
          .boolean()
          .optional()
          .describe(
            '鍵とプロファイルの指紋（sha256）まで出すか。既定は出さない——' +
              '要らないものを文脈へ載せない側に倒してある。人間は Web UI の設定画面で' +
              '常に見られるので、必要になったらここを true にして開くこと。',
          ),
      },
      async ({ fingerprints }) => {
        if (!context.managers) return NO_POOL;
        const overview = await context.managers.runners(
          fingerprints === undefined ? {} : { fingerprints },
        );

        if (overview.runners.length === 0) {
          return text(
            '登録されている runner は0台である（設定に ALTEROID_RUNNER_URLS 等が無いか、' +
              'まだ配線されていない）。',
          );
        }

        const lines: string[] = [
          // **1台のときにそう言う。** 言わないと「分散していない」ことが読み取れず、
          // 複数台に散っていると誤読されうる（依頼者からの明示要求）。
          overview.runners.length === 1
            ? 'runner は1台のみ登録されている（分散していない）。'
            : `runner は${overview.runners.length}台登録されている。`,
        ];

        for (const runner of overview.runners) {
          lines.push(
            `- ${runner.label} [${runner.state}]` +
              (runner.runnerId === undefined ? '（runnerId は未確定。まだ名乗っていない）' : ` runnerId=${runner.runnerId}`),
          );
          if (runner.workspacePath !== undefined) lines.push(`  workspace: ${runner.workspacePath}`);
          if (runner.error !== undefined) lines.push(`  直近の失敗: ${runner.error}`);
          lines.push(
            runner.managers.length === 0
              ? '  マネージャー: 無し'
              : `  マネージャー(${runner.managers.length}): ` +
                  runner.managers.map((m) => `${m.managerId}[${m.status}]`).join(', '),
          );
          // **表示そのものを引数で二重に締める。** 値を取ってくるかどうかは
          // `ManagerPool.runners()` 側（`options.fingerprints`）が決めるが、ここでも
          // `fingerprints === true` のときしか出さない——どちらか片方が緩んでも
          // 既定で漏れない（多重防御。値そのものは sha256 のままで、素の鍵は運ばない）。
          if (fingerprints === true && runner.credentials !== undefined) {
            lines.push(
              runner.credentials.length === 0
                ? '  鍵: 無し'
                : `  鍵の指紋: ${runner.credentials.map((c) => `${c.name}=${c.sha256}`).join(', ')}`,
            );
          }
          if (fingerprints === true && runner.profile !== undefined) {
            lines.push(`  プロファイルの指紋: ${runner.profile.sha256}`);
          }
        }

        if (overview.unassigned.length > 0) {
          lines.push(
            `どの器か分からない: ${overview.unassigned.length}件（` +
              overview.unassigned.map((m) => `${m.managerId}[${m.status}]`).join(', ') +
              '）。runnerId が記録されていない古いマネージャーで、どの器の内訳にも混ぜていない。',
          );
        }

        return text(lines.join('\n'));
      },
    ),
  ];
}

/**
 * 日誌1件を「見出し」と「本文」に分ける。
 *
 * **見出しには、探すのに要るものだけを置く。** 日誌を引くのは特定の1行を
 * 探すためなので、*いつ・誰が・どの型か*が残っていれば当たりは付けられる。
 * 本文（長くなりうる側）だけを抜粋の対象にし、見出しは削らない。
 */
function renderJournalEntry(entry: JournalEntry): { head: string; body: string } {
  switch (entry.type) {
    case 'exchange': {
      const conversation =
        entry.conversationId === undefined ? '' : ` conversation=${entry.conversationId}`;
      return { head: `[exchange ${entry.with}/${entry.role}]${conversation}`, body: entry.text };
    }
    case 'decision':
      return { head: '[decision]', body: `${entry.decision}（根拠: ${entry.grounds}）` };
    case 'escalation': {
      const to = entry.managerId === undefined ? '' : ` manager=${entry.managerId}`;
      const answered = entry.answeredAt === undefined ? '未回答' : `回答済み ${entry.answeredAt}`;
      return {
        head: `[escalation approval=${entry.approvalId}${to} ${answered}]`,
        body: entry.answer === undefined ? entry.question : `${entry.question} → ${entry.answer}`,
      };
    }
    case 'tool_use':
      return {
        head: `[tool_use ${entry.actor} ${entry.tool}]`,
        body: safeJson(entry.input),
      };
    case 'memory_update':
      return { head: `[memory_update ${entry.slug} (${entry.cause})]`, body: entry.summary };
    case 'daily_report':
      return { head: `[daily_report ${entry.date}]`, body: entry.body };
    case 'external_event':
      return { head: `[external_event ${entry.source}]`, body: entry.summary };
    case 'worker_wait': {
      const cause = entry.byCause;
      return {
        head: `[worker_wait tasks=${entry.tasks} turns=${entry.turns} settled=${entry.settled}]`,
        body:
          `作業者 ${entry.tasks} 体を待つあいだに ${entry.turns} ターン` +
          `（通知 ${cause.notification} / 自己継続 ${cause.continuation} / 話しかけ ${cause.input}）。` +
          `うち ${entry.toolless} ターンは道具を1つも動かしていない。` +
          `UserPromptSubmit の発火は ${entry.submits} 回` +
          (entry.sources === undefined
            ? '（source は取れていない）'
            : `（内訳: ${Object.entries(entry.sources)
                .map(([source, count]) => `${source}=${count}`)
                .join(', ')}）`) +
          '。',
      };
    }
    case 'turn_usage': {
      // **キャッシュの書き直しを目で分かる形にする**（潰すと測る意味が消える。
      // PR「なぜ台帳ではなく日誌なのか」）。数え直しの印は一覧の head にも
      // 出す — 印の行を一覧から隠さない（`worker_wait` の `settled: false` の
      // 扱いと同じ考え方）。
      const modelLines = Object.entries(entry.models)
        .map(([model, totals]) => {
          const cache =
            totals.cacheReadInputTokens === 0 && totals.cacheCreationInputTokens === 0
              ? ''
              : ` cache(read=${totals.cacheReadInputTokens} write=${totals.cacheCreationInputTokens})`;
          return (
            `${model}: ${formatUsd(totals.costUsd)}${cache} ` +
            `in=${totals.inputTokens} out=${totals.outputTokens}`
          );
        })
        .join('\n');
      const resetLine =
        entry.reset === undefined
          ? ''
          : `\n⚠ 数え直しを挟んだ回（${formatUsd(entry.reset.fromCostUsd)} → ` +
            `${formatUsd(entry.reset.toCostUsd)}）。models は差分ではなく新しい累積の先頭 — ` +
            '他の行と足し合わせると二重に数える。';
      return {
        head:
          `[turn_usage ${entry.layer}/${entry.site} ${entry.managerId}]` +
          (entry.reset === undefined ? '' : ' ⚠reset'),
        body: `${modelLines}${resetLine}`,
      };
    }
  }
}

/** 日誌に入った任意の値を文字列にする（循環参照でも読み手を落とさない）。 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 台帳の集計をクローンが読める形へ。
 *
 * **落としたら落としたと言う。** 日数やマネージャーの本数に比例して伸ばすと MCP の
 * 出力上限を超え、そのときクローンには1文字も届かない（実測 52,997 文字で溢れた）。
 * だから軸ごとに上限を置くが、**打ち切ったことを必ず書く** — 「全部でこれだけ」と
 * 読める出力を黙って作ると、それは嘘になる。
 */
const USAGE_AXIS_LIMIT = 14;

/**
 * 軸の名前。**打ち切りから続きへ辿るための識別子でもある**（`axis` 引数）。
 *
 * 「全部出す」は採らない — 出力が伸びるとクローンの入力を毎ターン食う。代わりに
 * **打ち切りの行がそのまま次に打つ手を書く。**
 */
const USAGE_AXES = ['date', 'manager', 'model', 'layer', 'site'] as const;
type UsageAxis = (typeof USAGE_AXES)[number];

/** `axis` を指定したときに1回で出す件数。 */
const USAGE_AXIS_PAGE = 100;

const USAGE_AXIS_TITLES: Record<UsageAxis, string> = {
  date: '日別',
  manager: 'マネージャー別',
  model: 'モデル別',
  layer: '層別（誰が）',
  site: '場所別（どこで）',
};

interface UsageAxisEntry {
  label: string;
  totals: UsageTotals;
}

/**
 * 軸ごとの並びを1か所へ寄せる。**まとめ表示と `axis` モードが同じここを通ること。**
 *
 * まとめ表示の先頭 N 件と `axis` モードの `offset=0..N` が同じ並びでなければ、
 * ページングは取りこぼすか重複する。
 *
 * **全順序にする。** 費用の降順だけだと同額のときの順序が `groupBy` の `Map` の
 * 挿入順に依存する（いまは安定ソートの結果としてラベル昇順に落ちているが、それは
 * 実装の偶然である）。「費用降順 → ラベル昇順」を約束にすると結果は変わらないまま
 * ページングの前提が成り立つ。
 */
function usageAxisEntries(summary: UsageBreakdown, axis: UsageAxis): UsageAxisEntry[] {
  const byCost = (entries: UsageAxisEntry[]) =>
    entries.sort((a, b) => b.totals.costUsd - a.totals.costUsd || a.label.localeCompare(b.label));
  switch (axis) {
    case 'date':
      // 日別は新しい順（古い日で上限を使い切らせない）。日付そのものが全順序である。
      return summary.byDate
        .map((entry) => ({ label: entry.date, totals: entry.totals }))
        .sort((a, b) => b.label.localeCompare(a.label));
    case 'manager':
      return byCost(summary.byManager.map((e) => ({ label: e.managerId, totals: e.totals })));
    case 'model':
      return byCost(summary.byModel.map((e) => ({ label: e.model, totals: e.totals })));
    case 'layer':
      return byCost(summary.byLayer.map((e) => ({ label: e.layer, totals: e.totals })));
    case 'site':
      return byCost(summary.bySite.map((e) => ({ label: e.site, totals: e.totals })));
  }
}

/**
 * アカウント全体の残り（クローンが読む形）。
 *
 * **文言は `usage-format.ts` の `describeAccountUsage` が持つ。** ここに書き写すと、
 * 同じ値を見る4つの口（クローンの道具・CLI 2つ・Web）で言い方が分かれ、いつか
 * 片方だけが「取れなかった」を 0 と描く。ここがやるのは見出しを付けることだけで、
 * クローンの文脈は Markdown なので強調はそのまま残す。
 */
function renderAccountUsage(state: AccountUsageState): string {
  return [`## ${ACCOUNT_USAGE_TITLE}`, ...describeAccountUsage(state)].join('\n');
}

function renderUsage(
  aggregate: UsageAggregate,
  view: { axis?: UsageAxis; offset?: number } = {},
): string {
  const { rows, since, layersSince, beforeLedger, beforeLayers, notice } = aggregate;

  if (since === null) {
    return [
      '台帳にはまだ1件も記録が無い。',
      '（消費の記録はこの機能を入れた時点から始まる。それより前の分は残っていない）',
    ].join('\n');
  }

  const summary = summarizeUsage(rows);
  const lines: string[] = [];

  if (view.axis !== undefined) {
    // **軸モードは「打ち切りの続き」を取りに来た呼び出しである。** まとめ表示も
    // 他の軸も出さない — 続きを取るたびに同じ全体が返ってくると、続きを辿るほど
    // 入力を食うことになる。
    const axis = view.axis;
    const offset = view.offset ?? 0;
    const entries = usageAxisEntries(summary, axis);
    lines.push(`${USAGE_AXIS_TITLES[axis]}（全 ${entries.length} 件 / offset=${offset}）`);
    const page = entries.slice(offset, offset + USAGE_AXIS_PAGE);
    if (page.length === 0) {
      // **黙って空を返さない。** 空の一覧だけでは「この軸には記録が無い」と
      // 「offset が範囲外」を区別できない。
      lines.push(`  （その軸は全 ${entries.length} 件で、offset=${offset} 以降は無い）`);
    } else {
      for (const entry of page) {
        lines.push(`  ${entry.label}: ${formatUsd(entry.totals.costUsd)}`);
      }
      const rest = entries.length - (offset + page.length);
      if (rest > 0) {
        lines.push(
          `  …（残り ${rest} 件は出していない。` +
            `axis="${axis}", offset=${offset + page.length} で続きが出る）`,
        );
      }
    }
  } else if (rows.length === 0) {
    lines.push('その範囲には記録が無い。');
  } else {
    lines.push(`合計 ${formatUsd(summary.total.costUsd)}`);
    lines.push(
      `  入力 ${summary.total.inputTokens.toLocaleString('en-US')} / ` +
        `出力 ${summary.total.outputTokens.toLocaleString('en-US')} / ` +
        `キャッシュ読み ${summary.total.cacheReadInputTokens.toLocaleString('en-US')} / ` +
        `キャッシュ書き ${summary.total.cacheCreationInputTokens.toLocaleString('en-US')}`,
    );

    for (const axis of USAGE_AXES) {
      const entries = usageAxisEntries(summary, axis);
      lines.push('', `${USAGE_AXIS_TITLES[axis]}:`);
      for (const entry of entries.slice(0, USAGE_AXIS_LIMIT)) {
        lines.push(`  ${entry.label}: ${formatUsd(entry.totals.costUsd)}`);
      }
      if (entries.length > USAGE_AXIS_LIMIT) {
        // **打ち切りの行がそのまま次に打つ手を書く。** 「残り N 件」だけでは、
        // 続きを見る方法が無いのと同じである。
        lines.push(
          `  …（残り ${entries.length - USAGE_AXIS_LIMIT} 件は出していない。` +
            `axis="${axis}", offset=${USAGE_AXIS_LIMIT} で続きが出る）`,
        );
      }
    }
  }

  lines.push('', `台帳の始点: ${since}`);
  if (beforeLedger) {
    // **0 と言わない。** 台帳が無かった期間を「使っていない期間」と読ませない。
    lines.push(
      '照会した範囲は台帳の始点より前にかかっている。その分は **0 ではなく「記録が無い」**。',
    );
  }
  // **層の始点を台帳の始点と混ぜない。** 層の軸は台帳より後から入ったので、それより
  // 前の行の層と場所は既定値であって観測ではない。
  lines.push(
    layersSince === null
      ? '層と場所の軸はまだ1件も記録していない。'
      : `層と場所の軸の始点: ${layersSince}`,
  );
  if (beforeLayers) {
    lines.push(
      '照会した範囲は層と場所の軸の始点より前にかかっている。' +
        'その分の層と場所は **既定値であって観測ではない**（クローンが使っていなかった、' +
        '蒸留が起きていなかった、とは読まないこと）。',
    );
  }
  lines.push(notice);
  return lines.join('\n');
}

/**
 * 記憶の文書ごとの内訳を出す上限。
 *
 * **`memory_list` は件数によらず全件を返す**（persona.list() の meta は軽く、
 * 実測でも壊れていない）。ただし `self_status` は他の節（実行時の事実・台帳との
 * 突き合わせ）と同居するので、ここだけは `LIST_BUDGET` と同じ考え方で件数に
 * 上限を置く。**切ったことは必ず言う。**
 */
const SELF_STATUS_MEMORY_DOC_LIMIT = 30;

/**
 * 記憶の大きさ。
 *
 * **「いまの総文字数」と「システムプロンプトへ焼き込んだ時点の文字数」は
 * ここでは出さない**（後者は `describeCloneRuntime` 側 — `CloneRuntimeFacts` の
 * 材料であって、記憶ストアを読み直しても変わらない値だからである）。ここが
 * 出すのは、いま `stores.persona` を読み直した時点の値だけで、会話の途中で
 * 記憶が書き換わっていれば、その場で変わる。
 */
function renderMemorySize(documents: MemoryDocumentMeta[], totalMemory: string): string {
  const lines = [
    '## 記憶の大きさ（いま stores.persona を読み直した値）',
    '',
    `- 総文字数: ${totalMemory.length.toLocaleString('en-US')} 文字（${documents.length} 文書）`,
  ];
  if (documents.length === 0) return lines.join('\n');

  const shown = documents.slice(0, SELF_STATUS_MEMORY_DOC_LIMIT);
  for (const doc of shown) {
    lines.push(
      `  - ${doc.slug}: ${doc.bytes.toLocaleString('en-US')} bytes（更新 ${doc.updatedAt}）`,
    );
  }
  const rest = documents.length - shown.length;
  if (rest > 0) {
    lines.push(`  …ほか ${rest} 文書は省略（全 ${documents.length} 文書）。`);
  }
  return lines.join('\n');
}

/**
 * SDK が実際に使っているモデル id と、台帳（`usage_read` と同じ器）を突き合わせる。
 *
 * **「あなたの消費が台帳に載っている／載っていない」と書かないこと。** 台帳の軸が
 * 変わった瞬間にその文は嘘になる。代わりに軸そのもの — 該当するモデル id の行が
 * どの `managerId` × `layer` × `site` にあるか — を構造として出す。
 *
 * **畳む鍵に層と場所を入れる。** `ALTEROID_CLONE_MODEL` を置けばクローンと
 * マネージャーは同じモデル id に並ぶので、`managerId` だけで畳むと #80 で残った
 * 「モデル名だけでは自分を見分けられない」がそのまま残る。層を鍵に入れて初めて
 * 「このモデル id の行のうち、層はこう分かれている」が見える。
 */
function renderLedgerCrossReference(
  sdkModel: string | null,
  aggregate: UsageAggregate | null,
): string {
  const lines = ['## 台帳との突き合わせ（軸: 日 × actor × モデル × 層 × 場所）', ''];

  if (sdkModel === null) {
    lines.push('まだ init を観測していないので、SDK のモデル id が分からず突き合わせられない。');
    return lines.join('\n');
  }
  if (aggregate === null || aggregate.since === null) {
    lines.push(`台帳にはまだ1件も記録が無い（いまのモデル id: ${sdkModel}）。`);
    return lines.join('\n');
  }

  const matches = aggregate.rows.filter((row) => row.model === sdkModel);
  if (matches.length === 0) {
    lines.push(`モデル id ${sdkModel} と同じ行は無い（台帳の始点: ${aggregate.since}）。`);
    return lines.join('\n');
  }

  // actor × 層 × 場所 ごとに畳む。**件数（行数）に比例して伸ばさない** — 日別の
  // 行数が増えても、出す単位はこの組み合わせの数までにとどめる。
  const buckets = new Map<
    string,
    { managerId: string; layer: string; site: string; costUsd: number }
  >();
  for (const row of matches) {
    const key = `${row.managerId} ${row.layer} ${row.site}`;
    const found = buckets.get(key);
    if (found === undefined) {
      buckets.set(key, {
        managerId: row.managerId,
        layer: row.layer,
        site: row.site,
        costUsd: row.totals.costUsd,
      });
    } else {
      found.costUsd += row.totals.costUsd;
    }
  }
  // 費用降順 → 鍵の昇順。同額のときに `Map` の挿入順へ落ちないようにする。
  const entries = [...buckets.values()].sort(
    (a, b) =>
      b.costUsd - a.costUsd ||
      a.managerId.localeCompare(b.managerId) ||
      a.layer.localeCompare(b.layer) ||
      a.site.localeCompare(b.site),
  );

  lines.push(
    `モデル id ${sdkModel} の行の内訳（台帳の軸そのもの。行には必ず actor と層と場所が付く）:`,
  );
  for (const entry of entries.slice(0, USAGE_AXIS_LIMIT)) {
    lines.push(
      `  - managerId: "${entry.managerId}" / layer: ${entry.layer} / site: ${entry.site}` +
        ` / 合計 ${formatUsd(entry.costUsd)}`,
    );
  }
  if (entries.length > USAGE_AXIS_LIMIT) {
    lines.push(`  …（残り ${entries.length - USAGE_AXIS_LIMIT} 件は出していない）`);
  }
  return lines.join('\n');
}

export function createCloneMcpServer(context: ToolContext) {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '0.1.0',
    instructions:
      'alteroid のクローン自身の道具。記憶（人間がいつでも読み書きする Markdown）、' +
      '日誌（追記専用）、人間への確認、継続中の依頼（時間起点の仕込み）、' +
      '実行環境プロファイル（`.zprofile` 相当）、自分自身（alteroid）の正典と実行時の状態、' +
      'マネージャーへの委譲。',
    tools: createCloneTools(context),
  });
}
