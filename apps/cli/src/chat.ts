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
  const listed: Listed = { approvals: [], commitments: [], conversations: [] };

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
      case 'usage_limited': {
        const data = event.json<{ message: string }>();
        if (data) {
          stdout.write(`\n  ! ${data.message}\n`);
          stdout.write(
            '    （この発言は保持されていて、次に枠が開いたときに配り直されて試し直される）\n',
          );
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

export interface SSEEvent {
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

/**
 * SSE の1フレーム（空行までの塊）を読む。**`null` は「読み飛ばす」の意味である。**
 *
 * `event:` / `data:` 以外の行は無視するので、コメント行（`:` 始まり。デーモンが
 * 無音死の掃除のために周期的に流す heartbeat）だけの塊は `data:` が1本も無く、
 * ここで `null` になって `readSSE` から yield されない。
 *
 * **export しているのは試験のためである**（`./chat.test.ts`）。デーモン側の
 * heartbeat が `alteroid chat` を壊さないことは、実装を読めば分かるが読むだけでは
 * 固定されない —— 誰かがこの関数を「未知の行はエラーにしよう」と直した日に、
 * 落ちるのは CLI の実行時であって型検査ではない。挙動は1文字も変えていない。
 */
export function parseSSEChunk(chunk: string): SSEEvent | null {
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
/memory <slug>       記憶の中身（書き換えは alteroid memory edit <slug>）
/journal [件数]      日誌（新しい順）
/conversations [limit=<N>] [scan=<N>]  会話の一覧（新しい順、番号付き）
/conversation <番号|id> [scan=<N>]  その会話の中身（古い順。番号は /conversations の並び）
/managers            マネージャーの一覧と状態
/manager <id>        そのマネージャーのセッション生ログ
/stop <id> [理由]    その仕事だけをやめさせる（止めた事実は日誌に残る）
/archive             セッションの生ログ一覧
/archive <id>        生ログの中身
/approvals           承認待ち（番号付き）
/answer <番号|id> <回答>  承認待ちに答える（番号は /approvals の並び）
/answers <番号|id> <回答> [<番号|id> <回答> ...]  溜まった承認待ちにまとめて答える
                     （回答は1語。複数語なら "..." で囲む。1件が駄目でも残りは進み、
                      結果は id ごとに出る）
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
 * **承認待ち・台帳・会話で別々に持つ。** 1本にまとめると `/approvals` の直後の
 * `/done 1` が承認待ちの id を閉じに行く（どれも「番号で指す一覧」なので、
 * 混ざったことに人間が気づく手がかりが無い）。会話を足すときも既存のフィールドへ
 * 相乗りさせず、独立したフィールド（`conversations`）にしてある。
 */
export interface Listed {
  approvals: string[];
  commitments: string[];
  conversations: string[];
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
        stdout.write(`${renderReportLine(report)}\n`);
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
        stdout.write('会話の一覧を読めませんでした（limit= / scan= の値を確かめてください）\n');
        return 'ok';
      }
      const { conversations, scanned } = await response.json();
      listed.conversations.length = 0;
      if (conversations.length === 0) {
        stdout.write('（会話はまだありません）\n');
      } else {
        conversations.forEach((conversation, index) => {
          listed.conversations.push(conversation.conversationId);
          stdout.write(
            `  [${index + 1}] ${conversation.conversationId}  更新: ${conversation.updatedAt}` +
              `  (${conversation.messages}件)\n`,
          );
          stdout.write(`      ${conversation.preview}\n`);
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
        `  （日誌を新しい方から ${scanned} 件見て集計した。これより古い会話は窓の外に` +
          '残っているかもしれません — 判定できません。さらに見るには ' +
          '`/conversations scan=<N>`（表示件数を増やすには limit=<N>。' +
          'alteroid conversations list --scan / --limit でも同じことができます）\n',
      );
      if (conversations.length > 0) {
        stdout.write('  /conversation <番号|id> で中身を読めます\n');
      }
      return 'ok';
    }

    case '/conversation': {
      const reference = rest[0];
      if (!reference) {
        stdout.write(
          '使い方: /conversation <番号|id> [scan=<N>]（番号は /conversations の並び）\n',
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
      const rawQuery = parseKeyValueTokens(rest.slice(1));
      const query = rawQuery.scan === undefined ? {} : { scan: rawQuery.scan };
      const response = await client.conversations[':id'].$get({ param: { id }, query });
      if (response.status === 404) {
        // **遡り切れた場合だけ 404**（デーモン側の約束）。判定できないときは
        // 200 に空の `messages` と `reachedStart: false` が来る。
        stdout.write(`そんな会話はありません: ${id}\n`);
        return 'ok';
      }
      if (!response.ok) {
        stdout.write('会話を読めませんでした（scan= の値を確かめてください）\n');
        return 'ok';
      }
      const { messages, scanned, reachedStart } = await response.json();
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
          stdout.write(`  [${message.at}] ${speaker}: ${message.text}\n`);
        }
      }
      stdout.write(
        reachedStart
          ? `  （日誌を ${scanned} 件遡り、この会話の先頭まで届きました）\n`
          : `  （日誌を ${scanned} 件遡りましたが先頭には届いていません。これより古い発言が` +
              '残っているかもしれません — /conversation <番号|id> scan=<N>（または ' +
              'alteroid conversations show --scan）で広げられます）\n',
      );
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
      const id = rest[0];
      if (!id) {
        stdout.write('使い方: /stop <manager_id> [理由]\n');
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
        stdout.write(`そのマネージャーは見つかりませんでした: ${id}\n`);
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
        stdout.write('まとめて答えられませんでした（サーバ側の検査に落ちました）\n');
        return 'ok';
      }
      // **成功件数だけを言わない。** 1件が駄目でも残りは進む設計なので、
      // どの id が通らなかったかを人間が見られること。
      const { results } = await response.json();
      for (const result of results) {
        stdout.write(
          result.ok
            ? `  [${result.id}] 回答しました\n`
            : `  [${result.id}] 回答に失敗: ${result.error ?? '不明'}\n`,
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
      `理由: ${report.unavailable}\n` +
      'この日の記録は日誌に残っている（/journal で辿れる）。' +
      '書けていないだけなので、原因が解ければ /run daily_report で作り直せる\n'
    );
  }
  return `── ${report.date} の日報 ──\n${report.body}\n`;
}

/**
 * 一覧（`/reports`）の1行。
 *
 * **ここでも本文を素で出さない。** 一覧は日付が並ぶだけの面なので、印の行を
 * 本文の抜粋で出すと「その日は上限に当たった話が日報に書かれている」と読める。
 */
export function renderReportLine(report: {
  date: string;
  body: string;
  unavailable?: string | undefined;
}): string {
  if (report.unavailable !== undefined && report.unavailable !== '') {
    return `  ${report.date}  ⚠ 日報なし（作れなかった。理由: ${summarizeText(report.unavailable)}）`;
  }
  return `  ${report.date}  ${summarizeText(report.body)}`;
}

function writeReport(report: { date: string; body: string; unavailable?: string }): void {
  stdout.write(renderReport(report));
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
 */
function failureLine(failure: ManagerListItem['lastFailure']): string | null {
  if (failure === undefined || failure === null) return null;
  return (
    `⚠ 直近のターンは報告ではなく失敗で終わっています: ${failure.code}（${failure.via}, ${failure.at}）` +
    '。セッションは生きているので、原因が解ければ話しかければ続きます'
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
    // **失敗は報告の**上**に置く。** 下に置くと、包まれたエラー文（`lastReport`）を
    // 先に読んでから「実は報告ではない」と分かる順になる。
    const failed = failureLine(manager.lastFailure);
    if (failed !== null) lines.push(`      ${failed}`);
    // **失敗した回は「報告」と呼ばない。** 本文は runner 側で
    // 「（このターンは応答を返さずに終わった: …）」と包まれているが、見出しが
    // 「直近の報告」のままだと、人間は包みの内側だけを読んで報告として扱う。
    if (manager.lastReport) {
      const label = manager.lastFailure === undefined ? '直近の報告' : '直近のターンの中身';
      lines.push(`      ${label}: ${summarizeText(manager.lastReport)}`);
    }
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

/**
 * `/usage from=… to=… manager=… layer=… site=…` を解く。
 *
 * **層と場所の値の集合は core の schema だけが持つ**（`narrowUsageAxis`）。chat 側に
 * 書き写すと、値が増えたときにここだけ古くなる。読めない値は 400 を待たずにその場で
 * 「どれを指定すればよいか」を返す。
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
    },
  };
}

/** 番号（直前の一覧の並び）でも id そのままでも指せるようにする。 */
function resolveListedId(reference: string, listed: string[]): string | null {
  if (/^\d+$/.test(reference)) return listed[Number(reference) - 1] ?? null;
  return reference;
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
