import { randomUUID } from 'node:crypto';

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { isCronExpression } from './cron.js';
import { describePage, excerptLine, page } from './excerpt.js';
import type { ManagerPool, ManagerSummary } from './manager.js';
import type { ProfileService } from './profile-service.js';
import {
  RESERVED_SCHEDULE_KINDS,
  describeScheduleSpec,
  localDate,
  localDayRange,
  parseTimeOfDay,
} from './schedule.js';
import { scheduleKindSchema, scheduleSpecSchema } from './schema.js';
import type { ChatStreamEvent, PendingApproval, ScheduleSpec, ScheduledRequest } from './schema.js';
import { CANON_REVISION, canonDocument, canonNames } from './self.js';
import type { Stores } from './store.js';

/**
 * クローンの道具（インプロセス MCP）。
 *
 * クローンは組み込みツールを持たない。持つのはここにある自作ツールだけであり、
 * これは人間の写像としての配置であってデグレードではない
 * （north_star「適用範囲」）。この理由付けをマネージャー以下に流用しないこと。
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
  'schedule_list',
  'schedule_create',
  'schedule_remove',
  'profile_read',
  'profile_write',
  'self_read',
  'manager_start',
  'manager_send',
  'manager_stop',
  'manager_list',
  'manager_report',
] as const;

/**
 * 一覧の既定の大きさ。
 *
 * **件数に比例して伸びる出力を作らない。** MCP の出力上限を超えた応答は
 * クローンに1文字も届かず（SDK がファイルへ落とすが、クローンにファイルを
 * 読む道具は無い）、一覧が丸ごと使えなくなる。実測では 52,997 文字で溢れた。
 * 人間は Web UI で件数によらず一覧を見られるので、ここが壊れるのは
 * 能力の削除である（north_star 禁止1）。M5 で runner が増えれば件数も増える。
 */
const LIST_REQUEST_EXCERPT = 160;
const LIST_REPORT_EXCERPT = 240;
const LIST_BUDGET = 8_000;
/** 全文を取りに来たときの1回分。続きは `offset` で取れる。 */
const REPORT_PAGE = 8_000;

/** 自作ツールは確認なしで通す（能力の削除ではなく、道具が道具として使えること）。 */
export const CLONE_ALLOWED_TOOLS = CLONE_TOOL_NAMES.map(qualifiedToolName);

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
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

    tool(
      'journal_read',
      '日誌を新しい順に読む。',
      { limit: z.number().int().min(1).max(200).optional().describe('件数（既定 20）') },
      async ({ limit }) => {
        const entries = await stores.journal.list({ limit: limit ?? 20 });
        if (entries.length === 0) return text('（日誌はまだ空）');
        return text(entries.map((entry) => JSON.stringify(entry)).join('\n'));
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
      },
      async ({ request, cwd }) => {
        if (!context.managers) return NO_POOL;
        const started = await context.managers.start({
          request,
          ...(cwd === undefined ? {} : { cwd }),
        });
        await stores.journal.append({
          type: 'decision',
          decision: `マネージャー ${started.managerId} を起こした（cwd: ${started.cwd}）: ${request}`,
          grounds: '委譲の判断',
        });
        return text(
          `マネージャー ${started.managerId} を起こした（cwd: ${started.cwd}）。` +
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

        if (result.outcome === 'unknown') {
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
        const lines = [`[${managerId}] ${result.detail}`];

        // **「受理した」で終わらせない。** 止めたあとの状態を読み直して返す。
        if (result.sessionGone === false) {
          lines.push(
            `**止まりきっていない。** runner には ${managerId} のセッションがまだ残っている。` +
              'manager_list で確かめ、残っているならもう一度止めること。',
          );
        } else if (result.sessionGone === undefined) {
          lines.push(
            '止まったかは**未確認**である（runner に確認が取れなかった）。' +
              'manager_list で状態を確かめること。',
          );
        }

        if (before?.status === 'done') {
          lines.push(
            'もともと待機中（done）だった仕事である。走っている手は無く、記録を畳んだだけになる。',
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
            `  依頼: ${excerptLine(manager.request, LIST_REQUEST_EXCERPT)}`,
            `  cwd: ${manager.cwd}`,
            // **`lost` を状態名だけで済ませない。** 「終わった」と読まれると、
            // 完了していない仕事がそのまま片付く。何が起きたかと、次に何をすれば
            // よいかを、この一覧の中で言い切る。
            manager.status === 'lost'
              ? '  ⚠ 前のセッションへ戻れず、この仕事は途中で失われている（完了ではない）。' +
                '続きが要るなら manager_start で起こし直すこと。'
              : null,
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
  ];
}

export function createCloneMcpServer(context: ToolContext) {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '0.1.0',
    instructions:
      'alteroid のクローン自身の道具。記憶（人間がいつでも読み書きする Markdown）、' +
      '日誌（追記専用）、人間への確認、継続中の依頼（時間起点の仕込み）、' +
      '実行環境プロファイル（`.zprofile` 相当）、自分自身（alteroid）の正典、マネージャーへの委譲。',
    tools: createCloneTools(context),
  });
}
