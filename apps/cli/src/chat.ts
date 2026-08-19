import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import {
  usageLayerSchema,
  usageSiteSchema,
  type Commitment,
  type UsageLayer,
  type UsageSite,
} from '@alteroid/core';
import type { InferResponseType } from 'hono/client';

import { createClient, type DaemonClient } from './client.js';
import { describeAuthFailure, resolveTarget, type Target } from './target.js';
import { narrowUsageAxis, renderUsage } from './usage.js';

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
  let conversationId: string | null = null;
  // 直前に一覧したもの。番号で引けるようにするため覚えておく。
  const listed: Listed = { approvals: [], commitments: [] };

  stdout.write('alteroid chat（Ctrl-D で終了 / /help でコマンド）\n');

  try {
    for (;;) {
      let line: string;
      try {
        line = (await rl.question('> ')).trim();
      } catch {
        break; // Ctrl-C
      }
      if (line.length === 0) continue;

      if (line.startsWith('/')) {
        const handled = await runSlashCommand(line, client, listed, conversationId);
        if (handled === 'quit') break;
        continue;
      }

      conversationId = await sendMessage(target, line, conversationId);
    }
  } finally {
    rl.close();
    if (conversationId) {
      // 会話終了は蒸留の契機（寿命モデル: 蒸留は生存条件）
      stdout.write('\n（学びを記憶へ蒸留しています…）\n');
      await client.chat[':conversationId'].end
        .$post({ param: { conversationId } })
        .catch(() => undefined);
    }
  }
}

async function sendMessage(
  target: Target,
  text: string,
  conversationId: string | null,
): Promise<string | null> {
  // SSE は hono/client ではなく生の fetch で受ける（EventSource は POST も
  // ヘッダ付与もできない）。認証ヘッダはここにも要る。
  const response = await fetch(`${target.baseUrl}/chat`, {
    method: 'POST',
    headers: { ...target.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ text, conversationId: conversationId ?? undefined }),
  });

  if (!response.ok || !response.body) {
    const described = describeAuthFailure(response.status, target);
    stdout.write(
      described === null
        ? `エラー: デーモンが応答しません (${response.status})\n`
        : `${described}\n`,
    );
    return conversationId;
  }

  let nextConversationId = conversationId;
  let wrote = false;

  for await (const event of readSSE(response.body)) {
    switch (event.name) {
      case 'open': {
        const data = event.json<{ conversationId: string }>();
        if (data) nextConversationId = data.conversationId;
        break;
      }
      case 'text': {
        const data = event.json<{ text: string }>();
        if (data) {
          stdout.write(data.text);
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
          stdout.write(`\n  ? 人間への確認（${data.approvalId}）: ${data.question}\n`);
          stdout.write('    /answer <id> <回答> で返せます\n');
        }
        break;
      }
      case 'error': {
        const data = event.json<{ message: string }>();
        stdout.write(`\nエラー: ${data?.message ?? '不明'}\n`);
        break;
      }
      default:
        break;
    }
  }

  if (wrote) stdout.write('\n');
  return nextConversationId;
}

interface SSEEvent {
  name: string;
  data: string;
  json<T>(): T | null;
}

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

function parseSSEChunk(chunk: string): SSEEvent | null {
  let name = 'message';
  const dataLines: string[] = [];

  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;

  const data = dataLines.join('\n');
  return {
    name,
    data,
    json<T>(): T | null {
      try {
        return JSON.parse(data) as T;
      } catch {
        return null;
      }
    },
  };
}

const HELP = `/report [日付]        日報（既定は直近。日付は YYYY-MM-DD）
/reports [件数]       日報の一覧
/memory              記憶の一覧
/memory <slug>       記憶の中身
/journal [件数]      日誌（新しい順）
/managers            マネージャーの一覧と状態
/manager <id>        そのマネージャーのセッション生ログ
/archive             セッションの生ログ一覧
/archive <id>        生ログの中身
/approvals           承認待ち（番号付き）
/answer <番号|id> <回答>  承認待ちに答える（番号は /approvals の並び）
/commitments         引き受けたまま終わっていない仕事（番号付き）
/commitments all     片付けたものも含めて見る
/commit <本文>       引き受けたことを台帳へ積む
/done <番号|id> [理由]  片付けたことを記録する（番号は /commitments の並び）
/usage [from=YYYY-MM-DD] [to=YYYY-MM-DD] [manager=<id>]  利用状況（いくら使ったか）
/schedule            時間起点のジョブ・継続中の依頼と次の発火
/schedule <kind> <HH:MM|30m|cron 0 10 * * 1> <依頼>  継続する依頼を仕込む
/unschedule <kind>   継続中の依頼を外す
/run <kind>          定期ジョブを今すぐ起こす
/event <source> <本文>  外部イベントをクローンに届ける
/quit                終了
`;

/**
 * 直前に一覧したものの id を、番号で引けるように覚えておく置き場。
 *
 * **承認待ちと台帳で別々に持つ。** 1本にまとめると `/approvals` の直後の
 * `/done 1` が承認待ちの id を閉じに行く（どちらも「番号で指す一覧」なので、
 * 混ざったことに人間が気づく手がかりが無い）。
 */
export interface Listed {
  approvals: string[];
  commitments: string[];
}

export async function runSlashCommand(
  line: string,
  client: ReturnType<typeof createClient>,
  listed: Listed,
  /**
   * いまの会話 id。台帳へ積むときの「どこから来たか」に使う（`Commitment.source`）。
   * まだ一言も話していなければ `null` で、そのときは source を付けない。
   */
  conversationId: string | null = null,
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
          stdout.write(`${date} の日報はありません\n`);
          return 'ok';
        }
        const body = await response.json();
        if ('reports' in body) for (const report of body.reports) writeReport(report);
        return 'ok';
      }
      const response = await client.reports.$get({ query: { limit: '1' } });
      if (!response.ok) {
        stdout.write('日報を読めませんでした\n');
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
        stdout.write('日報を読めませんでした\n');
        return 'ok';
      }
      const { reports } = await response.json();
      if (reports.length === 0) stdout.write('（日報はまだありません）\n');
      for (const report of reports) {
        stdout.write(`  ${report.date}  ${summarizeText(report.body)}\n`);
      }
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
            : `仕込めませんでした（名前は英小文字・数字・. _ -、既定の定期ジョブの名前は使えません。cron 式なら書式も確かめてください）\n`,
        );
        return 'ok';
      }
      if (rest.length > 0) {
        stdout.write('使い方: /schedule <kind> <HH:MM|30m|cron 0 10 * * 1> <依頼の本文>\n');
        return 'ok';
      }
      const response = await client.schedule.$get();
      if (!response.ok) {
        stdout.write('定期ジョブを読めませんでした\n');
        return 'ok';
      }
      const { entries } = await response.json();
      if (entries.length === 0) stdout.write('（定期ジョブは仕込まれていません）\n');
      for (const entry of entries) {
        stdout.write(`  ${entry.kind}  次: ${entry.nextAt}\n      ${entry.description}\n`);
        // 継続中の依頼だけが持つもの。何を頼まれたままなのかが人間に見えること
        if (entry.request !== undefined) {
          stdout.write(`      前回: ${entry.lastRunAt ?? '（まだ一度も動いていません）'}\n`);
        }
      }
      return 'ok';
    }

    case '/unschedule': {
      const kind = rest[0];
      if (!kind) {
        stdout.write('使い方: /unschedule <kind>（/schedule で一覧）\n');
        return 'ok';
      }
      const response = await client.schedule[':kind'].$delete({ param: { kind } });
      stdout.write(
        response.ok
          ? `${kind} を外しました\n`
          : `${kind} という継続中の依頼はありません（既定の定期ジョブは外せません）\n`,
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
        response.ok
          ? `${kind} を起こしました（結果は日誌・日報に出ます）\n`
          : `${kind} という定期ジョブはありません\n`,
      );
      return 'ok';
    }

    case '/event': {
      const [source, ...bodyParts] = rest;
      const body = bodyParts.join(' ');
      if (!source || body.length === 0) {
        stdout.write('使い方: /event <source> <本文>\n');
        return 'ok';
      }
      const response = await client.events.$post({ json: { source, payload: body } });
      stdout.write(
        response.ok
          ? '外部イベントとして届けました（クローンが判断します）\n'
          : '届けられませんでした\n',
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
        const { documents } = await response.json();
        if (documents.length === 0) stdout.write('（記憶はまだ空）\n');
        for (const doc of documents) stdout.write(`  ${doc.slug}  — ${doc.title}\n`);
        return 'ok';
      }
      const response = await client.memory[':slug'].$get({ param: { slug } });
      if (!response.ok) {
        stdout.write('そんな記憶はありません\n');
        return 'ok';
      }
      const body = await response.json();
      if ('document' in body) stdout.write(`${body.document.content}\n`);
      return 'ok';
    }

    case '/journal': {
      const limit = rest[0] ?? '20';
      const response = await client.journal.$get({ query: { limit } });
      if (!response.ok) {
        stdout.write('日誌を読めませんでした\n');
        return 'ok';
      }
      const { entries } = await response.json();
      if (entries.length === 0) stdout.write('（日誌はまだ空）\n');
      for (const entry of entries) {
        stdout.write(`  ${entry.at}  [${entry.type}] ${summarize(entry)}\n`);
      }
      return 'ok';
    }

    case '/managers': {
      const response = await client.managers.$get();
      if (!response.ok) {
        stdout.write('マネージャーの一覧を読めませんでした\n');
        return 'ok';
      }
      const { managers } = await response.json();
      stdout.write(`${renderManagerList(managers)}\n`);
      return 'ok';
    }

    case '/manager': {
      // 日誌で足りないときに、manager_id からそのセッションの生ログへ降りる
      const id = rest[0];
      if (!id) {
        stdout.write('使い方: /manager <manager_id>\n');
        return 'ok';
      }
      const response = await client.managers[':id'].transcript.$get({ param: { id } });
      if (!response.ok) {
        stdout.write('そのマネージャーの生ログはまだありません\n');
        return 'ok';
      }
      stdout.write(`${await response.text()}\n`);
      return 'ok';
    }

    case '/archive': {
      // 可観測性の最下段。日誌で足りないときの最後の拠り所へ、chat から降りられる。
      const id = rest[0];
      if (!id) {
        const response = await client.archive.$get();
        if (!response.ok) {
          stdout.write('アーカイブを読めませんでした\n');
          return 'ok';
        }
        const { entries } = await response.json();
        if (entries.length === 0) stdout.write('（生ログはまだありません）\n');
        for (const entry of entries) stdout.write(`  ${entry}\n`);
        return 'ok';
      }
      const response = await client.archive[':id'].$get({ param: { id } });
      if (!response.ok) {
        stdout.write('その生ログはありません\n');
        return 'ok';
      }
      stdout.write(`${await response.text()}\n`);
      return 'ok';
    }

    /**
     * 溜まった保留を人間がまとめて片付けるための一覧。番号を振るのは、
     * 人間が席に戻ったときに UUID を写す作業をさせないためである。
     */
    case '/approvals': {
      const response = await client.approvals.$get({ query: {} });
      if (!response.ok) {
        stdout.write('承認待ちを読めませんでした\n');
        return 'ok';
      }
      const { approvals } = await response.json();
      listed.approvals.length = 0;
      if (approvals.length === 0) {
        stdout.write('（承認待ちはありません）\n');
        return 'ok';
      }
      approvals.forEach((approval, index) => {
        listed.approvals.push(approval.id);
        stdout.write(`  [${index + 1}] ${approval.question}\n`);
        stdout.write(`      id: ${approval.id}  積まれた: ${approval.createdAt}\n`);
        if (approval.jobId) stdout.write(`      マネージャー: ${approval.jobId}\n`);
        if (approval.context) stdout.write(`      背景: ${summarizeText(approval.context)}\n`);
      });
      stdout.write('  /answer <番号> <回答> で答えられます（答えた仕事だけが再開します）\n');
      return 'ok';
    }

    case '/answer': {
      const [reference, ...answerParts] = rest;
      const answer = answerParts.join(' ');
      if (!reference || answer.length === 0) {
        stdout.write('使い方: /answer <番号|id> <回答>\n');
        return 'ok';
      }
      const id = resolveListedId(reference, listed.approvals);
      if (id === null) {
        stdout.write(`[${reference}] は /approvals の一覧にありません\n`);
        return 'ok';
      }
      const response = await client.approvals[':id'].answer.$post({
        param: { id },
        json: { answer },
      });
      stdout.write(response.ok ? '回答しました\n' : '回答に失敗しました\n');
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
     * なるのが「何を片付けたか」の側だからである（器は行を消さない）。
     */
    case '/commitments': {
      const includeClosed = rest[0] === 'all';
      const response = await client.commitments.$get({
        query: includeClosed ? { includeClosed: 'true' } : {},
      });
      if (!response.ok) {
        stdout.write('台帳を読めませんでした\n');
        return 'ok';
      }
      const { entries } = await response.json();
      const { text, ids } = renderCommitments(entries);
      listed.commitments.length = 0;
      listed.commitments.push(...ids);
      stdout.write(`${text}\n`);
      if (ids.length > 0) {
        stdout.write('  /done <番号> [理由] で片付けたことを記録できます\n');
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
      stdout.write(
        response.ok
          ? '台帳に積みました（/commitments で確認できます）\n'
          : '台帳に積めませんでした\n',
      );
      return 'ok';
    }

    case '/done': {
      const [reference, ...reasonParts] = rest;
      if (!reference) {
        stdout.write('使い方: /done <番号|id> [理由]（番号は /commitments の並び）\n');
        return 'ok';
      }
      const id = resolveListedId(reference, listed.commitments);
      if (id === null) {
        stdout.write(`[${reference}] は /commitments の一覧にありません\n`);
        return 'ok';
      }
      const reason = reasonParts.join(' ');
      const response = await client.commitments[':id'].close.$post({
        param: { id },
        json: { reason: reason.length === 0 ? DONE_WITHOUT_REASON : reason },
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
              : `記録できませんでした (${response.status})`
        }\n`,
      );
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
        stdout.write('利用状況を読めませんでした（from=/to= の日付の形を確かめてください）\n');
        return 'ok';
      }
      const aggregate = await response.json();
      stdout.write(`${renderUsage(aggregate)}\n`);
      return 'ok';
    }

    default:
      stdout.write(`不明なコマンド: ${command ?? ''}\n${HELP}`);
      return 'ok';
  }
}

function writeReport(report: { date: string; body: string }): void {
  stdout.write(`── ${report.date} の日報 ──\n${report.body}\n`);
}

/** 一覧で拒否を出す道具の種類数（多い分は件数だけ言う）。 */
const LIST_DENIED_TOOLS = 3;

/**
 * `GET /managers` が返す1本ぶん。**クライアントが実際に受け取る形**から導く
 * （core の `ManagerSummary` ではない — 拒否件数はデーモンの外向きの面でだけ
 * 合流するので、そちらには無い）。
 */
type ManagerListItem = InferResponseType<DaemonClient['managers']['$get']>['managers'][number];
type ManagerDenial = NonNullable<ManagerListItem['denials']>[number];

/**
 * 状態に添える「確認へ上がらず止められた」件数の一行。
 *
 * **状態を置き換えない。** 分類器か deny 規則がその場で拒否すると、その仕事は
 * `running` のまま手が止まる。札は `[running]` のまま残し、その下に並べる。
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
 */
function denialLine(denials: ManagerDenial[] | undefined): string | null {
  if (denials === undefined || denials.length === 0) return null;
  // 帳面は古い順に積まれている。**新しい側から**採る。
  const recent = [...denials].reverse();
  const shown = recent.slice(0, LIST_DENIED_TOOLS);
  const rest = recent.length - shown.length;
  const total = denials.reduce((sum, entry) => sum + entry.count, 0);
  return (
    `⚠ 確認へ上がらず止められた道具: ${shown.map((e) => `${e.tool} ${e.count}件`).join(' / ')}` +
    (rest > 0 ? `（ほか ${rest} 種、全 ${total} 件）` : '') +
    '。手が止まっている可能性があります'
  );
}

/**
 * マネージャーの一覧を、人間が読める形へ（`/managers`）。
 *
 * 表示を関数に出してあるのは、`renderUsage`（`usage.ts`）と同じ理由 —
 * 何を出しているかを端末なしで確かめられるようにするためである。
 */
export function renderManagerList(managers: ManagerListItem[]): string {
  if (managers.length === 0) return '（マネージャーは1本も居ません）';

  const lines: string[] = [];
  for (const manager of managers) {
    const live = manager.live ? '' : ' /セッション切断';
    // **依頼文も抜粋にする。** 同じ関数の中で `waiting` と `lastReport` だけを
    // 畳んでいたので、数千字の依頼が来ると一覧そのものが流れて読めなくなった。
    lines.push(
      `  ${manager.managerId}  [${manager.status}${live}]  ${summarizeText(manager.request)}`,
    );
    lines.push(`      cwd: ${manager.cwd}`);
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
          '成果がリモート（PR・ブランチ・コミット）まで届いていることがある。' +
          '起こし直す前にそこを確かめること',
      );
    }
    const denied = denialLine(manager.denials);
    if (denied !== null) lines.push(`      ${denied}`);
    for (const item of manager.waiting) {
      lines.push(`      返事待ち (${item.requestId}): ${summarizeText(item.summary)}`);
    }
    if (manager.lastReport) lines.push(`      直近の報告: ${summarizeText(manager.lastReport)}`);
  }
  return lines.join('\n');
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
}

type ParsedUsageFilters = { ok: true; filters: UsageFilters } | { ok: false; message: string };

/**
 * `/usage from=… to=… manager=… layer=… site=…` を解く。
 *
 * **層と場所の値の集合は core の schema だけが持つ**（`narrowUsageAxis`）。chat 側に
 * 書き写すと、値が増えたときにここだけ古くなる。読めない値は 400 を待たずにその場で
 * 「どれを指定すればよいか」を返す。
 */
function parseUsageFilters(tokens: string[]): ParsedUsageFilters {
  const raw: Record<string, string> = {};
  for (const token of tokens) {
    const [key, ...valueParts] = token.split('=');
    const value = valueParts.join('=');
    if (value.length === 0 || key === undefined) continue;
    raw[key] = value;
  }
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
    },
  };
}

/** 番号（直前の一覧の並び）でも id そのままでも指せるようにする。 */
function resolveListedId(reference: string, listed: string[]): string | null {
  if (/^\d+$/.test(reference)) return listed[Number(reference) - 1] ?? null;
  return reference;
}

// ---------------------------------------------------------------------------
// 引き受けたまま終わっていない仕事の台帳
// ---------------------------------------------------------------------------

/**
 * `/done` に理由を書かなかったときに残す1行。
 *
 * **空文字を送らない。** 器は「どう片付いたか」が残る前提で作ってあり
 * （`schema.ts` の `closedReason`）、そこが空だと「閉じた」という事実だけが
 * 残って人間が後から否定できなくなる。理由を書かなかったこと自体は事実なので、
 * 起きたことだけを書く（片付いた中身を勝手に埋めない）。
 */
const DONE_WITHOUT_REASON = '人間が chat の /done で片付けたと記録した（理由は書かれていない）';

const COMMITMENT_ORIGIN_LABEL: Record<Commitment['origin'], string> = {
  human: '人間',
  manager: 'マネージャー',
  external: '外部',
  self: '自分',
};

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
): { text: string; ids: string[] } {
  if (commitments.length === 0) {
    return { text: '（引き受けたまま終わっていない仕事はありません）', ids: [] };
  }

  const lines: string[] = [];
  const ids: string[] = [];

  commitments.forEach((commitment, index) => {
    ids.push(commitment.id);
    const closed = commitment.closedAt !== undefined;
    // **本文は畳む。** 器は全文を持つ（要約を持たせない）ので、切るのは表示側の
    // 仕事である。畳まないと、数千字の依頼1本で一覧が流れて読めなくなる。
    lines.push(`  [${index + 1}] ${closed ? '✓ ' : ''}${summarizeText(commitment.body)}`);
    const from =
      COMMITMENT_ORIGIN_LABEL[commitment.origin] +
      (commitment.source === undefined ? '' : `(${commitment.source})`);
    lines.push(
      `      id: ${commitment.id}  起点: ${from}  受け取った: ${commitment.at}` +
        `（${formatElapsed(commitment.at, now)}前）`,
    );
    if (closed) {
      lines.push(
        `      片付けた: ${commitment.closedAt ?? ''}  ${summarizeText(commitment.closedReason ?? '')}`,
      );
    }
  });

  return { text: lines.join('\n'), ids };
}

/**
 * 受け取ってからの経過（＝齢）。
 *
 * **台帳は優先度も締切も持たない**（`schema.ts` の `commitmentSchema`）ので、
 * 人間が急ぎ方を決める材料はこれだけである。ISO の時刻だけを出すと、読むたびに
 * 引き算をさせることになる。
 *
 * 未来の時刻（時計のずれ）は 0 に丸める。ここで負の齢を出しても人間には直せない。
 */
function formatElapsed(iso: string, now: number): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return '不明';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 3600) return `${Math.round(seconds / 60)}分`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}時間`;
  return `${Math.round(seconds / 86_400)}日`;
}

function summarize(entry: Record<string, unknown>): string {
  for (const key of ['text', 'decision', 'question', 'summary', 'body', 'tool']) {
    const value = entry[key];
    if (typeof value === 'string') return summarizeText(value);
  }
  return '';
}

function summarizeText(value: string): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length > 80 ? `${single.slice(0, 80)}…` : single;
}
