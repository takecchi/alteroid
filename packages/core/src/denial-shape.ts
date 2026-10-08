// 入力そのものを覚えない: 覚えるとコマンド本文（鍵が入りうる文字列）を抱え続けることになるため
export interface DeniedRecord {
  input: boolean;
}

export interface RecentDenial {
  readonly at: string;
  readonly tool: string;
  readonly headWord?: string;
  readonly reasonType?: string;
  readonly reason?: string;
  readonly message?: string;
}

// 空文字を置かない: 「空のコマンド」と「入力が届かない経路」が同じ字面になるため
// Markdown の記号を書かない: 報告本文へそのまま埋まり、`_` や `*` が `<em>` に化けるため
export function denialInputAbsence(via: 'live' | 'result'): string {
  return via === 'live'
    ? '入力は付いていない（走行中の合図には入力の欄が無い。' +
        'ターン終わりの記録が届けば、続く note に形だけ残る）'
    : '入力は付いていない（result の記録に入力の欄が無かった）';
}

// `=` `:` `/` を許さず 32 文字で切る: 代入や URL が先頭に来ると、先頭の語が値そのものになるため
const SAFE_HEAD_WORD = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;

// 英数字が混ざった長い語は出さない: AWS のアクセスキー id は SAFE_HEAD_WORD だけでは素通しするため
const SECRET_ISH_MIN_LENGTH = 12;

const WITHHELD_HEAD_WORD = '(伏せた)';

const MAX_KEYS = 8;

// `file_path` を入れない: 先頭の語がパスの断片になり、値を出さない線を越えるため
const COMMAND_KEYS = new Set(['command']);

export function commandHeadWord(value: string): string | undefined {
  const head = value.trimStart().split(/\s/, 1)[0];
  if (head === undefined || head === '') return undefined;
  if (!SAFE_HEAD_WORD.test(head)) return undefined;
  if (head.length >= SECRET_ISH_MIN_LENGTH && /[0-9]/.test(head) && /[A-Za-z]/.test(head)) {
    return undefined;
  }
  return head;
}

export function denialCommandHeadWord(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const keys = Object.keys(input as Record<string, unknown>);
  const commandKey = keys.find((key) => COMMAND_KEYS.has(key));
  if (commandKey === undefined) return undefined;
  const commandValue = (input as Record<string, unknown>)[commandKey];
  return typeof commandValue === 'string' ? commandHeadWord(commandValue) : undefined;
}

function charsOf(value: unknown): number | undefined {
  if (typeof value === 'string') return value.length;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : text.length;
  } catch {
    return undefined;
  }
}

export function denialInputShape(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (input === null) return 'null';

  const chars = charsOf(input);
  const size = chars === undefined ? '長さ不明' : `chars=${chars}`;

  // 素の文字列には先頭の語を出さない: 入力全体が鍵だったとき、その鍵をまるごと出すため
  if (typeof input === 'string') return `文字列 / ${size}`;
  if (typeof input !== 'object') return `${typeof input} / ${size}`;
  if (Array.isArray(input)) return `配列 / 要素=${input.length} / ${size}`;

  const keys = Object.keys(input as Record<string, unknown>);
  const shown = keys.slice(0, MAX_KEYS).join(',');
  const keyList = keys.length === 0 ? '(欄なし)' : keys.length > MAX_KEYS ? `${shown},…` : shown;

  // 欄が無ければ節ごと落とす: 「先頭の語=(伏せた)」と書くと、見に行って隠したように読めるため
  const commandKey = keys.find((key) => COMMAND_KEYS.has(key));
  const commandValue =
    commandKey === undefined ? undefined : (input as Record<string, unknown>)[commandKey];
  const headPart =
    typeof commandValue !== 'string'
      ? ''
      : ` / 先頭の語=${commandHeadWord(commandValue) ?? WITHHELD_HEAD_WORD}`;

  return `欄=${keyList}${headPart} / ${size}`;
}

export class RecentDenialLog {
  readonly #limit: number;
  readonly #entries: { toolUseId: string; denial: RecentDenial }[] = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  remember(
    toolUseId: string,
    at: string,
    tool: string,
    denial: { input?: unknown; reasonType?: string; reason?: string; message?: string },
  ): void {
    const headWord = denialCommandHeadWord(denial.input);
    this.#entries.push({
      toolUseId,
      denial: {
        at,
        tool,
        ...(headWord === undefined ? {} : { headWord }),
        ...(denial.reasonType === undefined ? {} : { reasonType: denial.reasonType }),
        ...(denial.reason === undefined ? {} : { reason: denial.reason }),
        ...(denial.message === undefined ? {} : { message: denial.message }),
      },
    });
    if (this.#entries.length > this.#limit) {
      this.#entries.splice(0, this.#entries.length - this.#limit);
    }
  }

  fillHeadWord(toolUseId: string, input: unknown): void {
    const headWord = denialCommandHeadWord(input);
    if (headWord === undefined) return;
    const entry = this.#entries.find((it) => it.toolUseId === toolUseId);
    if (entry === undefined || entry.denial.headWord !== undefined) return;
    entry.denial = { ...entry.denial, headWord };
  }

  list(): readonly RecentDenial[] {
    return this.#entries.map((it) => it.denial);
  }
}
