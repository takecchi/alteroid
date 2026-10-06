/**
 * スラッシュコマンドの表と解決（純粋・I/O 無し）。
 * 出所: takecchi/codiva（MIT）`src/core/commands.ts` の `{name, aliases, describe}` の形。
 *
 * コマンドを足すときは `COMMANDS` に 1 件足し、`CommandAction` を受ける側（`app.tsx`）に
 * 分岐を足す。実際の副作用（終了・画面の移動）はここでは起こさない。
 */

export type CommandAction =
  | 'help'
  | 'exit'
  | 'chat'
  | 'approvals'
  | 'managers'
  | 'journal'
  | 'memory'
  | 'conversations'
  | 'resume'
  | 'new'
  | 'end'
  | 'interrupt'
  | 'attach'
  | 'attachments'
  | 'detach'
  | 'edit'
  | 'editCancel';

export interface CommandSpec {
  /** 正式名（先頭の `/` なし・小文字）。 */
  name: string;
  aliases?: readonly string[];
  action: CommandAction;
  /** ヘルプに出す 1 行説明。 */
  describe: string;
}

/** 表示順はこの配列順。 */
export const COMMANDS: readonly CommandSpec[] = [
  { name: 'chat', action: 'chat', describe: '会話の画面へ移る（1）' },
  {
    name: 'approvals',
    action: 'approvals',
    describe: '承認待ちの画面へ移る（2）。<id> でその詳細を開く',
  },
  {
    name: 'managers',
    aliases: ['delegations'],
    action: 'managers',
    describe: '委譲（マネージャー）の画面へ移る（3）',
  },
  {
    name: 'journal',
    action: 'journal',
    describe: '日誌の画面へ移る（4）。[件数] type=<種別,…> q=<語> で絞る',
  },
  { name: 'memory', action: 'memory', describe: '記憶の画面へ移る（5。読むだけ）' },
  {
    name: 'conversations',
    aliases: ['history'],
    action: 'conversations',
    describe: '会話の履歴から選んで開き直す',
  },
  {
    name: 'resume',
    action: 'resume',
    describe: '進行中の会話へ戻る。[会話 id] 省略なら新しい順に探す（自動では戻らない）',
  },
  { name: 'new', action: 'new', describe: '新しい会話を始める（今の会話は終えない）' },
  {
    name: 'end',
    action: 'end',
    describe: '今の会話を終える（学びを記憶へ蒸留する）',
  },
  {
    name: 'attach',
    action: 'attach',
    describe:
      '次に送る発言へファイルを添える。<path>（複数回で複数個。送るときに上がる。空の入力の Enter で添付だけも送れる）',
  },
  { name: 'attachments', action: 'attachments', describe: '添えかけのファイルの一覧' },
  { name: 'detach', action: 'detach', describe: '添えかけを外す。<番号|all>' },
  {
    name: 'edit',
    action: 'edit',
    describe:
      '自分の発言を編集する。<番号|id>（無しなら編集できる発言の一覧）。本文は入力欄に入り、Enter で置き換えて送る。/detach で添付を外せる',
  },
  {
    name: 'edit-cancel',
    action: 'editCancel',
    describe: '始めた編集をやめる（何も送らない）',
  },
  { name: 'interrupt', action: 'interrupt', describe: '走っているターンを止める（Ctrl+C と同じ）' },
  { name: 'help', aliases: ['?'], action: 'help', describe: 'コマンドとキーの一覧' },
  {
    name: 'exit',
    aliases: ['quit'],
    action: 'exit',
    describe:
      '終了する（Ctrl+D でも可。書きかけがあるときは 1 度目は案内だけで、もう一度で捨てて終了）',
  },
];

export type ResolvedInput =
  | { kind: 'command'; spec: CommandSpec; args: string }
  | { kind: 'unknown'; name: string }
  | { kind: 'text'; text: string };

/**
 * 入力欄の 1 行を解釈する。
 * - `/` で始まらない → そのまま発言（`text`）。
 * - `//` で始まる → 先頭の `/` を 1 つ外した発言（`/` で始まる文を送るための抜け道。
 *   Web の会話では普通に送れるので、TUI でも送れる口を残す）。
 * - `/` だけ → help。
 * - 既知の名前・別名 → コマンド。未知の名前 → `unknown`（誤入力をクローンへ送らない）。
 */
export function resolveCommand(line: string): ResolvedInput {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return { kind: 'text', text: trimmed };
  if (trimmed.startsWith('//')) return { kind: 'text', text: trimmed.slice(1) };
  const match = /^\/(\S*)\s*([\s\S]*)$/.exec(trimmed);
  const name = (match?.[1] ?? '').toLowerCase();
  const args = (match?.[2] ?? '').trim();
  if (name === '') return { kind: 'command', spec: HELP, args };
  for (const spec of COMMANDS) {
    if (spec.name === name || spec.aliases?.includes(name)) return { kind: 'command', spec, args };
  }
  return { kind: 'unknown', name };
}

const HELP = COMMANDS.find((c) => c.action === 'help') as CommandSpec;

/** `/help` の本文（行ごと）。 */
export function helpLines(): string[] {
  const lines = ['コマンド:'];
  for (const c of COMMANDS) {
    const names = [c.name, ...(c.aliases ?? [])].map((n) => `/${n}`).join(' ');
    lines.push(`  ${names}  ${c.describe}`);
  }
  lines.push(
    'キー:',
    '  Enter 送信 / 改行は、行末の \\ + Enter か Alt+Enter（Alt を Meta として送る端末のとき）',
    '    Shift+Enter は、端末が Shift+Enter を区別して送る設定のときだけ改行（そうでなければ Enter と同じで送信になる）',
    '  Esc 入力欄を抜ける（そのあと 1〜5 で画面を移る、Tab か i で戻る）',
    '  PgUp / PgDn 会話ログのスクロール（末尾へ届くと追従に戻る）',
    '  日誌の画面: ↑↓ 選ぶ / Enter 全文 / f 種別で絞る / n 最新へ戻って追従 / m 古い側 / r 読み直し',
    '  委譲の画面: ↑↓ 選ぶ / Enter 詳細（生ログ） / f 状態で絞る / m 古い側 / r 読み直し',
    '  委譲の詳細: i か Enter か Tab で追加指示を書く / s 止める（y で確定） / ↑↓ PgUp PgDn 生ログ / r 読み直し / Esc 一覧へ（書きかけが在れば Esc を二度）',
    '  承認待ちの画面: ↑↓ 選ぶ / Enter 詳細 / a 答える（設問は ↑↓ と Space で選び、s で確認、y で送る） / r 読み直し',
    '  回答済み・取り下げ済み: 承認待ちの画面で d → 決着した日（新しい日が上）→ Enter でその日の件 → Enter で詳細（m で古い日、Esc で戻る）',
    '  会話で承認待ちが来たら、Esc のあと a でその詳細へ飛べる',
    '  記憶の画面（読むだけ）: ↑↓ 選ぶ / Enter 本文 / r 読み直し / Esc 一覧へ',
    '  Ctrl+C 走っているターンを止める / Ctrl+D 終了（書きかけ（会話・委譲・承認待ちの欄）があるときは、1 度目は案内だけ。もう一度 ^D か /exit で捨てて終了）',
    '  入力欄の編集: ← → ↑ ↓ / Home・End か Ctrl+A・Ctrl+E で行頭・行末 / Ctrl+W 直前の語を消す（空白で区切る） / Ctrl+K 行末まで消す / Delete 後ろの1字 / Ctrl+U 空にする',
    '  `//` で始めると、先頭の `/` を 1 つ外した文をそのまま送る',
  );
  return lines;
}
