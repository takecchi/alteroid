import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { baseUrl, ensureRunning } from './daemon.js';
import { createClient } from './client.js';

/**
 * `alteroid chat` — クローンとの会話。
 *
 * 3層（日報・日誌・セッションログ）は chat と HTTP API の両方から読める必要が
 * ある（PRD「可観測性」）。chat ではスラッシュコマンドがその入口になり、
 * 普段は `/report` だけ読んで暮らせて、掘りたくなったら `/journal` →
 * `/manager` `/archive` と一本道で降りられる。
 */
export async function chatCommand(): Promise<void> {
  const info = await ensureRunning();
  const base = baseUrl(info);
  const client = createClient(base);

  const rl = createInterface({ input: stdin, output: stdout });
  let conversationId: string | null = null;
  // 直前に一覧した承認待ち。番号で答えられるようにするため覚えておく。
  const listed: string[] = [];

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
        const handled = await runSlashCommand(line, client, listed);
        if (handled === 'quit') break;
        continue;
      }

      conversationId = await sendMessage(base, line, conversationId);
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
  base: string,
  text: string,
  conversationId: string | null,
): Promise<string | null> {
  const response = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, conversationId: conversationId ?? undefined }),
  });

  if (!response.ok || !response.body) {
    stdout.write(`エラー: デーモンが応答しません (${response.status})\n`);
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
/runners             manager-runner の一覧（生死と資源）
/archive             セッションの生ログ一覧
/archive <id>        生ログの中身
/approvals           承認待ち（番号付き）
/answer <番号|id> <回答>  承認待ちに答える（番号は /approvals の並び）
/schedule            時間起点のジョブと次の発火
/run <kind>          定期ジョブを今すぐ起こす
/event <source> <本文>  外部イベントをクローンに届ける
/quit                終了
`;

async function runSlashCommand(
  line: string,
  client: ReturnType<typeof createClient>,
  listed: string[],
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
    case '/schedule': {
      const response = await client.schedule.$get();
      if (!response.ok) {
        stdout.write('定期ジョブを読めませんでした\n');
        return 'ok';
      }
      const { entries } = await response.json();
      if (entries.length === 0) stdout.write('（定期ジョブは仕込まれていません）\n');
      for (const entry of entries) {
        stdout.write(`  ${entry.kind}  次: ${entry.nextAt}\n      ${entry.description}\n`);
      }
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
      if (managers.length === 0) stdout.write('（マネージャーは1本も居ません）\n');
      for (const manager of managers) {
        const live = manager.live ? '' : ' /セッション切断';
        stdout.write(`  ${manager.managerId}  [${manager.status}${live}]  ${manager.request}\n`);
        // どの器で走っているか（器が落ちて移った先もここに出る）
        if (manager.runnerId) stdout.write(`      runner: ${manager.runnerId}\n`);
        stdout.write(`      cwd: ${manager.cwd}\n`);
        for (const item of manager.waiting) {
          stdout.write(`      返事待ち (${item.requestId}): ${summarizeText(item.summary)}\n`);
        }
        if (manager.lastReport)
          stdout.write(`      直近の報告: ${summarizeText(manager.lastReport)}\n`);
      }
      return 'ok';
    }

    /**
     * 器の一覧（M5）。
     *
     * 出るのは**実測**であって定員ではない。空きが少ないことは「もう頼めない」を
     * 意味しない（配置の材料であって上限ではない）。
     */
    case '/runners': {
      const response = await client.runners.$get();
      if (!response.ok) {
        stdout.write('runner の一覧を読めませんでした\n');
        return 'ok';
      }
      const { runners } = await response.json();
      if (runners.length === 0) stdout.write('（runner が名簿に居ません）\n');
      for (const runner of runners) {
        const state = runner.alive ? '生存' : `不通（${runner.misses}回）`;
        stdout.write(`  ${runner.runnerId}  [${state}]  ${runner.workspacePath}\n`);
        if (runner.lastSeenAt) stdout.write(`      最後の応答: ${runner.lastSeenAt}\n`);
        const capacity = runner.capacity;
        if (capacity) {
          const freeGiB = (capacity.freeMemoryBytes / 1024 ** 3).toFixed(1);
          const totalGiB = (capacity.totalMemoryBytes / 1024 ** 3).toFixed(1);
          stdout.write(
            `      CPU ${capacity.cpuCount}（負荷 ${capacity.load1m.toFixed(2)}） / ` +
              `メモリ 空き ${freeGiB}GiB / ${totalGiB}GiB / ` +
              `走行中 ${capacity.activeManagers}本\n`,
          );
        }
        if (runner.lastError)
          stdout.write(`      直近の失敗: ${summarizeText(runner.lastError)}\n`);
      }
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
      listed.length = 0;
      if (approvals.length === 0) {
        stdout.write('（承認待ちはありません）\n');
        return 'ok';
      }
      approvals.forEach((approval, index) => {
        listed.push(approval.id);
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
      const id = resolveApprovalId(reference, listed);
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

    default:
      stdout.write(`不明なコマンド: ${command ?? ''}\n${HELP}`);
      return 'ok';
  }
}

function writeReport(report: { date: string; body: string }): void {
  stdout.write(`── ${report.date} の日報 ──\n${report.body}\n`);
}

/** 番号（`/approvals` の並び）でも id そのままでも答えられるようにする。 */
function resolveApprovalId(reference: string, listed: string[]): string | null {
  if (/^\d+$/.test(reference)) return listed[Number(reference) - 1] ?? null;
  return reference;
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
