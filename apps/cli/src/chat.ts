import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { baseUrl, ensureRunning } from './daemon.js';
import { createClient } from './client.js';

/**
 * `alteroid chat` — クローンとの会話。
 *
 * 3層（日報・日誌・セッションログ）は chat と HTTP API の両方から読める必要が
 * ある（PRD「可観測性」）。M1 の chat ではスラッシュコマンドがその入口になる。
 */
export async function chatCommand(): Promise<void> {
  const info = await ensureRunning();
  const base = baseUrl(info);
  const client = createClient(base);

  const rl = createInterface({ input: stdin, output: stdout });
  let conversationId: string | null = null;

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
        const handled = await runSlashCommand(line, client);
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

const HELP = `/memory              記憶の一覧
/memory <slug>       記憶の中身
/journal [件数]      日誌（新しい順）
/managers            マネージャーの一覧と状態
/manager <id>        そのマネージャーのセッション生ログ
/archive             セッションの生ログ一覧
/archive <id>        生ログの中身
/approvals           承認待ち
/answer <id> <回答>  承認待ちに答える
/quit                終了
`;

async function runSlashCommand(
  line: string,
  client: ReturnType<typeof createClient>,
): Promise<'ok' | 'quit'> {
  const [command, ...rest] = line.split(/\s+/);

  switch (command) {
    case '/help':
      stdout.write(HELP);
      return 'ok';

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
        stdout.write(`      cwd: ${manager.cwd}\n`);
        for (const item of manager.waiting) {
          stdout.write(`      返事待ち (${item.requestId}): ${summarizeText(item.summary)}\n`);
        }
        if (manager.lastReport)
          stdout.write(`      直近の報告: ${summarizeText(manager.lastReport)}\n`);
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

    case '/approvals': {
      const response = await client.approvals.$get({ query: {} });
      if (!response.ok) {
        stdout.write('承認待ちを読めませんでした\n');
        return 'ok';
      }
      const { approvals } = await response.json();
      if (approvals.length === 0) stdout.write('（承認待ちはありません）\n');
      for (const approval of approvals) {
        stdout.write(`  ${approval.id}  ${approval.question}\n`);
      }
      return 'ok';
    }

    case '/answer': {
      const [id, ...answerParts] = rest;
      const answer = answerParts.join(' ');
      if (!id || answer.length === 0) {
        stdout.write('使い方: /answer <id> <回答>\n');
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
