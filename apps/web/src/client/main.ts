import type {
  ChatStreamEvent,
  JournalEntry,
  ManagerSummary,
  PendingApproval,
  ScheduleStatus,
} from '@alteroid/core';

/**
 * 画面側。
 *
 * デーモンの HTTP API だけを相手にする（`/api/*` は同一オリジンのプロキシ越しに
 * そのままデーモンへ届く）。CLI の `alteroid chat` が持っている経路と同じものを、
 * 押せる形で並べているだけである — 片方にしかない機能を作らない。
 *
 * 文字列は必ず `textContent` で入れる。クローンの応答も生ログも日報も、
 * 中身は書いた本人以外には決められない文字列である。
 */

type DailyReport = Extract<JournalEntry, { type: 'daily_report' }>;

const STATUS_POLL_MS = 4000;

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`要素が見つかりません: #${id}`);
  return found as T;
}

const connection = el('connection');

/** デーモンへの往復。`content-type` を名乗るのは呼び出し側の責務である。 */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${response.status} ${detail.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

function setConnection(error: unknown): void {
  connection.textContent = error === null ? '' : `デーモンに繋がりません（${String(error)}）`;
}

/** 一覧の描画。中身が空なら「無い」と言う（黙って空欄にしない）。 */
function renderList(target: HTMLElement, cards: HTMLElement[], empty: string): void {
  target.replaceChildren();
  if (cards.length === 0) {
    const note = document.createElement('div');
    note.className = 'empty';
    note.textContent = empty;
    target.append(note);
    return;
  }
  target.append(...cards);
}

function card(className = 'card'): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  return node;
}

function line(text: string, className?: string): HTMLDivElement {
  const node = document.createElement('div');
  if (className !== undefined) node.className = className;
  node.textContent = text;
  return node;
}

function badge(text: string, kind?: string): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = kind === undefined ? 'badge' : `badge ${kind}`;
  node.textContent = text;
  return node;
}

function localTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

// --- タブ -----------------------------------------------------------------

type TabName = 'chat' | 'status' | 'reports';

let currentTab: TabName = 'chat';

function showTab(name: TabName): void {
  currentTab = name;
  for (const button of document.querySelectorAll<HTMLButtonElement>('#tabs button')) {
    button.classList.toggle('active', button.dataset.tab === name);
  }
  for (const section of document.querySelectorAll<HTMLElement>('.tab')) {
    section.classList.toggle('active', section.id === `tab-${name}`);
  }
  if (name === 'status') void refreshStatus();
  if (name === 'reports') void refreshReports();
}

for (const button of document.querySelectorAll<HTMLButtonElement>('#tabs button')) {
  button.addEventListener('click', () => {
    const name = button.dataset.tab;
    if (name === 'chat' || name === 'status' || name === 'reports') showTab(name);
  });
}

// --- 会話 -----------------------------------------------------------------

const messages = el('messages');
const composer = el<HTMLFormElement>('composer');
const input = el<HTMLTextAreaElement>('input');
const sendButton = el<HTMLButtonElement>('send');
const endButton = el<HTMLButtonElement>('end-conversation');
const conversationLabel = el('conversation');

let conversationId: string | null = null;
let sending = false;

function setConversation(id: string | null): void {
  conversationId = id;
  conversationLabel.textContent = id === null ? '' : `会話 ${id.slice(0, 8)}`;
  endButton.disabled = id === null;
}

function appendMessage(text: string, className: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = `message ${className}`;
  node.textContent = text;
  messages.append(node);
  messages.scrollTop = messages.scrollHeight;
  return node;
}

/**
 * 人間への確認をその場で返せるようにする。
 * 溜めてから `/approvals` を見に行かせると、確認は流れる。
 */
function appendAsk(approvalId: string, question: string): void {
  const node = card('message ask');
  node.append(line(`確認: ${question}`));

  const form = document.createElement('form');
  form.className = 'answer';
  const answer = document.createElement('input');
  answer.type = 'text';
  answer.placeholder = '回答して返す';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = '返す';
  form.append(answer, submit);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = answer.value.trim();
    if (text.length === 0) return;
    submit.disabled = true;
    void api(`/approvals/${encodeURIComponent(approvalId)}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer: text }),
    })
      .then(() => {
        setConnection(null);
        node.replaceChildren(line(`確認: ${question}`), line(`→ ${text}`, 'muted'));
      })
      .catch((error: unknown) => {
        submit.disabled = false;
        setConnection(error);
      });
  });

  node.append(form);
  messages.append(node);
  messages.scrollTop = messages.scrollHeight;
}

interface SSEEvent {
  name: string;
  data: string;
}

async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let name = 'message';
      const data: string[] = [];
      for (const raw of chunk.split('\n')) {
        if (raw.startsWith('event:')) name = raw.slice(6).trim();
        else if (raw.startsWith('data:')) data.push(raw.slice(5).trimStart());
      }
      if (data.length > 0) yield { name, data: data.join('\n') };
      boundary = buffer.indexOf('\n\n');
    }
  }
}

async function send(text: string): Promise<void> {
  appendMessage(text, 'human');
  sending = true;
  sendButton.disabled = true;

  let bubble: HTMLDivElement | null = null;

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, conversationId: conversationId ?? undefined }),
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      appendMessage(`エラー: デーモンが応答しません (${response.status}) ${detail}`, 'error');
      return;
    }
    setConnection(null);

    for await (const raw of readSSE(response.body)) {
      // 種別は event 行で来るが、data の中にも同じものが入っている
      const event = JSON.parse(raw.data) as ChatStreamEvent | { conversationId: string };
      if (raw.name === 'open') {
        setConversation((event as { conversationId: string }).conversationId);
        continue;
      }
      const streamed = event as ChatStreamEvent;
      switch (streamed.type) {
        case 'text':
          bubble ??= appendMessage('', 'clone');
          bubble.textContent += streamed.text;
          messages.scrollTop = messages.scrollHeight;
          break;
        case 'tool':
          bubble = null;
          appendMessage(`· ${streamed.tool}`, 'tool');
          break;
        case 'ask_human':
          bubble = null;
          appendAsk(streamed.approvalId, streamed.question);
          break;
        case 'error':
          bubble = null;
          appendMessage(`エラー: ${streamed.message}`, 'error');
          break;
        case 'thinking':
        case 'done':
          break;
      }
    }
  } catch (error: unknown) {
    appendMessage(`エラー: ${String(error)}`, 'error');
    setConnection(error);
  } finally {
    sending = false;
    sendButton.disabled = false;
    input.focus();
  }
}

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (text.length === 0 || sending) return;
  input.value = '';
  void send(text);
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

// 会話の終わりは蒸留の契機（寿命モデル: 蒸留は生存条件）。閉じる口が無いと、
// 画面から使う限りクローンが学ばないままになる。
endButton.addEventListener('click', () => {
  const id = conversationId;
  if (id === null) return;
  endButton.disabled = true;
  void api(`/chat/${encodeURIComponent(id)}/end`, { method: 'POST' })
    .then(() => {
      setConnection(null);
      appendMessage('（学びを記憶へ蒸留しました。次の発言から新しい会話になります）', 'tool');
      setConversation(null);
    })
    .catch((error: unknown) => {
      endButton.disabled = false;
      setConnection(error);
    });
});

setConversation(null);

// --- 実行状況 -------------------------------------------------------------

const approvalsList = el('approvals');
const approvalsCount = el('approvals-count');
const managersList = el('managers');
const scheduleList = el('schedule');
const transcript = el('transcript');
const transcriptOf = el('transcript-of');

let selectedManagerId: string | null = null;

function approvalCard(approval: PendingApproval): HTMLDivElement {
  const node = card();
  const title = card('title');
  title.append(badge('確認', 'waiting_human'), line(localTime(approval.createdAt), 'muted'));
  node.append(title, line(approval.question, 'body'));
  if (approval.context !== undefined) node.append(line(approval.context, 'muted'));
  if (approval.jobId !== undefined) node.append(line(`マネージャー ${approval.jobId}`, 'muted'));

  const form = document.createElement('form');
  form.className = 'answer';
  const answer = document.createElement('input');
  answer.type = 'text';
  answer.placeholder = '回答して返す';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = '返す';
  form.append(answer, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = answer.value.trim();
    if (text.length === 0) return;
    submit.disabled = true;
    void api(`/approvals/${encodeURIComponent(approval.id)}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer: text }),
    })
      .then(() => {
        setConnection(null);
        return refreshStatus();
      })
      .catch((error: unknown) => {
        submit.disabled = false;
        setConnection(error);
      });
  });
  node.append(form);
  return node;
}

function managerCard(manager: ManagerSummary): HTMLDivElement {
  const node = card('card selectable');
  if (manager.managerId === selectedManagerId) node.classList.add('selected');

  const title = card('title');
  title.append(
    badge(manager.status, manager.status),
    line(manager.managerId.slice(0, 8), 'muted'),
    line(manager.live ? '' : '（runner 不在）', 'muted'),
  );
  node.append(title, line(manager.request, 'body'));
  node.append(line(`${manager.cwd} · 更新 ${localTime(manager.updatedAt)}`, 'muted'));
  if (manager.waiting.length > 0) {
    node.append(line(`確認待ち ${manager.waiting.length} 件`, 'muted'));
    for (const waiting of manager.waiting) node.append(line(`? ${waiting.summary}`, 'muted'));
  }
  if (manager.lastReport !== undefined) node.append(line(manager.lastReport, 'muted'));

  node.addEventListener('click', () => {
    selectedManagerId = manager.managerId;
    void loadTranscript(manager.managerId);
    void refreshStatus();
  });
  return node;
}

async function loadTranscript(managerId: string): Promise<void> {
  transcriptOf.textContent = managerId;
  try {
    const response = await fetch(`/api/managers/${encodeURIComponent(managerId)}/transcript`);
    transcript.textContent = response.ok
      ? await response.text()
      : `生ログを取得できません (${response.status})`;
    setConnection(null);
  } catch (error: unknown) {
    setConnection(error);
  }
}

/**
 * 実行状況の更新。承認待ちの入力に触っている間は、その一覧だけ描き直さない
 * （書きかけの回答を消さないため）。
 */
async function refreshStatus(): Promise<void> {
  try {
    const [approvals, managers, schedule] = await Promise.all([
      api<{ approvals: PendingApproval[] }>('/approvals?pending=true'),
      api<{ managers: ManagerSummary[] }>('/managers'),
      api<{ entries: ScheduleStatus[] }>('/schedule'),
    ]);
    setConnection(null);

    approvalsCount.textContent =
      approvals.approvals.length === 0 ? '' : `${approvals.approvals.length} 件`;
    if (!approvalsList.contains(document.activeElement)) {
      renderList(
        approvalsList,
        approvals.approvals.map(approvalCard),
        '待っているものはありません',
      );
    }
    renderList(managersList, managers.managers.map(managerCard), '走っているものはありません');
    renderList(
      scheduleList,
      schedule.entries.map((entry) => {
        const node = card();
        node.append(line(entry.description), line(`次 ${localTime(entry.nextAt)}`, 'muted'));
        return node;
      }),
      '定期実行はありません',
    );
  } catch (error: unknown) {
    setConnection(error);
  }
}

// 実行状況は見ている間だけ追いかける。裏で回し続けても読む人は居ない。
setInterval(() => {
  if (currentTab === 'status') void refreshStatus();
}, STATUS_POLL_MS);

// --- 日報 -----------------------------------------------------------------

const reportList = el('report-list');
const reportTitle = el('report-title');
const reportBody = el('report-body');

let selectedReportDate: string | null = null;

function showReport(report: DailyReport): void {
  selectedReportDate = report.date;
  reportTitle.textContent = `${report.date} の日報`;
  reportBody.textContent = report.body;
  for (const node of reportList.querySelectorAll<HTMLElement>('.card')) {
    node.classList.toggle('selected', node.dataset.date === report.date);
  }
}

async function refreshReports(): Promise<void> {
  try {
    const { reports } = await api<{ reports: DailyReport[] }>('/reports?limit=30');
    setConnection(null);
    renderList(
      reportList,
      reports.map((report) => {
        const node = card('card selectable');
        node.dataset.date = report.date;
        if (report.date === selectedReportDate) node.classList.add('selected');
        node.append(line(report.date), line(report.body.slice(0, 60), 'muted'));
        node.addEventListener('click', () => {
          showReport(report);
        });
        return node;
      }),
      '日報はまだありません',
    );
    // 何も選んでいなければ一番新しいものを開く（普段は日報を偶に読むだけでよい）
    const latest = reports[0];
    if (selectedReportDate === null && latest !== undefined) showReport(latest);
  } catch (error: unknown) {
    setConnection(error);
  }
}

showTab('chat');
input.focus();
