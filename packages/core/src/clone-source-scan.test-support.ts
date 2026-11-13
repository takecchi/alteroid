import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// clone.ts（と、振り分けの固定・長いメソッドの固定では manager.ts・runner.ts・digest.ts）のソースを走査して「書き換えの前後で変わらないこと」を固定する試験の共通の道具。
// 日誌の1行の固定（`clone-journal-self-sites-pin.test.ts`）と、振り分けの case の中身の固定（`clone-dispatch-cases-pin.test.ts`）と、長いメソッドの中身の固定（`clone-method-body-pin.test.ts`）が使う。
// 1つの試験に写さず、ここに置く: 文字列・テンプレート・コメントの読み飛ばし方が2つの試験でずれると、片方だけが見逃すため。

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

export const CLONE_TS = path.join(SRC_DIR, 'clone.ts');

export function readCloneSource(): string {
  return readFileSync(CLONE_TS, 'utf8');
}

/**
 * 日誌へ `with: 'self'` の1行を書く箇所（`this.#journalSelf(` / `this.#journal({ type: 'exchange', with: 'self', … })`）を持つソース。
 * `Clone` から協力者クラスへ塊を切り出したら、その協力者のファイルをここへ足す（足し漏れは `clone-journal-self-sites-pin.test.ts` が落ちる）。
 */
export const JOURNAL_SELF_SOURCES = [
  'clone.ts',
  'clone-graves.ts',
  'clone-daily-report.ts',
  'clone-denial-journal.ts',
  'clone-approval-answers.ts',
  'clone-turn-input.ts',
  'clone-task-intake.ts',
  'clone-usage-ledger.ts',
] as const;

/** `packages/core/src` の下のファイルを、名前で読む（`JOURNAL_SELF_SOURCES` の走査用）。 */
export function readCoreSource(file: string): string {
  return readFileSync(path.join(SRC_DIR, file), 'utf8');
}

/** `packages/core/src` の下の（試験ではない）ソースのファイル名。`JOURNAL_SELF_SOURCES` の足し漏れを見つけるために並べる。 */
export function coreSourceFiles(): string[] {
  return readdirSync(SRC_DIR).filter(
    (file) =>
      file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.test-support.ts'),
  );
}

/** 振り分けの固定・長いメソッドの固定の対象にしてよいソース（`packages/core/src` の下）。 */
export type ScannedSource = 'clone.ts' | 'manager.ts' | 'runner.ts' | 'digest.ts';

export function readSource(file: ScannedSource): string {
  return readFileSync(path.join(SRC_DIR, file), 'utf8');
}

const DECLARATION_RE =
  /^ {0,2}(?:(?:export|default|public|private|protected|static|async|readonly)\s+)*(?:function\s+)?(?:get\s+|set\s+)?(#?[A-Za-z_$][\w$]*)\s*[(<]/;
const NOT_A_DECLARATION = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'function',
  'await',
  'throw',
]);

/** `index` を囲む宣言（メソッド・関数）の名前。行頭から2字下げまでの宣言を、上へ遡って探す。 */
export function enclosingDeclaration(text: string, index: number): string {
  const lines = text.slice(0, index).split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    const m = DECLARATION_RE.exec(line);
    if (m && !NOT_A_DECLARATION.has(m[1]!) && !line.trimEnd().endsWith(';')) return m[1]!;
  }
  return '<top>';
}

/**
 * `from` の開き括弧（`{` / `(`）から対応する閉じまでを読み、閉じの位置と、深さ 1 の `,` の位置を返す。
 * 文字列（'…' / "…"）・テンプレートの地の文・コメント（`//` と `/* *\/`）は数えない。テンプレートの `${…}` の中は式として数える。
 */
export function readGroup(text: string, from: number): { close: number; commas: number[] } {
  const stack: string[] = [];
  const commas: number[] = [];
  let i = from;
  while (i < text.length) {
    const ch = text[i]!;
    const top = stack.at(-1);
    if (top === '`') {
      if (ch === '\\') i += 2;
      else if (ch === '`') {
        stack.pop();
        i += 1;
      } else if (ch === '$' && text[i + 1] === '{') {
        stack.push('${');
        i += 2;
      } else i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const newline = text.indexOf('\n', i);
      i = newline === -1 ? text.length : newline;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i += 1;
      while (i < text.length && text[i] !== ch) i += text[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === '`') stack.push('`');
    else if (ch === '{' || ch === '(' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ')' || ch === ']') {
      stack.pop();
      if (stack.length === 0) return { close: i, commas };
    } else if (ch === ',' && stack.length === 1) commas.push(i);
    i += 1;
  }
  return { close: -1, commas };
}

/**
 * `name` のメソッド・関数の本体（`{` の中）を返す。見る宣言は2つの形だけ:
 * クラスの中の2字下げの `async #name(` / `#name(`、行頭の `export async function name(` / `function name(`（`export`・`async` は省けてよい）。
 * 2字下げの形は `#` で始まる名前にだけ当てる: 行頭の関数の本体の中の2字下げの呼び出し（`  name(…);`）を宣言と読み違えないため。
 */
export function methodBody(text: string, name: string, asMember = false): string {
  const declaration = new RegExp(
    name.startsWith('#') || asMember
      ? `\\n {2}(?:async )?${name}\\(`
      : `\\n(?:export )?(?:async )?function ${name}\\(`,
  ).exec(text);
  if (declaration === null) throw new Error(`${name} の宣言が見つからない`);
  const paramsOpen = declaration.index + declaration[0].length - 1;
  const paramsClose = readGroup(text, paramsOpen).close;
  const bodyOpen = text.indexOf('{', paramsClose);
  const bodyClose = readGroup(text, bodyOpen).close;
  if (paramsClose === -1 || bodyOpen === -1 || bodyClose === -1) {
    throw new Error(`${name} の本体の括弧が読めない`);
  }
  return text.slice(bodyOpen + 1, bodyClose);
}

/** 長いメソッドから中身そのまま出した段。差し戻して読むための表（`expandedMethodBody`）。 */
export type InlinedStep = {
  /** 出した先のメソッド */
  readonly name: string;
  /** 元のメソッドの中でそれを呼ぶ1文（`squash` で畳んだ形） */
  readonly call: string;
  /** 出した先の末尾に足した1文。差し戻すときに外す */
  readonly trailing: string;
  /**
   * 出した先が別のファイル（`packages/core/src` の下の協力者のクラス）のとき、そのファイル名。省けば元のメソッドと同じファイル。
   * `#` で始まらない名前（協力者の公開メソッド）は、行頭の関数ではなくクラスの 2 字下げのメンバーとして探す。
   */
  readonly from?: string;
};

/**
 * clone.ts の、元のメソッド → そこから出した段。段を出す PR は、出す前にここへ足す（足した時点では差し戻すものが無く、固定は変わらない）。
 * 振り分けの固定（`clone-dispatch-cases-pin.test.ts`）が case の先のメソッドを読むときにも差し戻すので、表はファイルごとに1つだけにする（`INLINED_BY_FILE`）。
 */
export const INLINED_BY_METHOD: Readonly<Record<string, readonly InlinedStep[]>> = {
  // 受信箱のループ: ターンの前の組み立て（時計と断り書き）と、ターンの後始末（`finally` の中身）を出した（#6357）
  '#pump': [
    {
      name: '#prepareTurn',
      call: 'const timer = await this.#prepareTurn(event, batch);',
      trailing: ' return timer;',
    },
    { name: '#settleTurn', call: 'await this.#settleTurn(batch, timer);', trailing: '' },
    // 枠の解除（`#usageBlocked` を降ろして保持分を戻す同期の部分）。日誌の本文を返す末尾の `return` は、呼び出しの直後の `await #journalSelf` が受け取るので差し戻すときに外す
    {
      name: '#releaseUsageBlock',
      call: 'const line = this.#releaseUsageBlock(event);',
      trailing:
        ' return `枠の解除を試す。新しい合図が届いたので、保持していた ${held.length} 件を配り直す。${suffix}`;',
    },
  ],
  // まとめ読みの選択と配り分け（`#pump` から出した）。`run` が束の変数を閉じ込めるアローで差し戻せないので、差し戻す段は無く、自分自身のメソッドとして固定する
  '#chooseBatch': [],
  // 起動時の未読の拾い直し: 畳み込みの代表の作り直しと、live の見出しの1行
  '#restoreUnreadPass': [
    {
      name: '#registerRestoredRepresentatives',
      call: 'this.#registerRestoredRepresentatives(pending);',
      trailing: '',
    },
    {
      name: '#journalRedeliveredLive',
      call: 'await this.#journalRedeliveredLive(decided, alone);',
      trailing: '',
    },
  ],
  // 受信箱の `timer` の1件: ターンの後の完了の記録（失敗の再試行・枠保持の印・完了）
  '#handleTimer': [
    {
      name: '#settleTimerRun',
      call: 'await this.#settleTimerRun(event, plan, outcome, cause);',
      trailing: '',
    },
  ],
  // SDK の `turn_ended` の1件: 時計のモデルの段を閉じる1文と、失敗したターン・答えが返ったターンの後始末
  // （どちらも直後の `return;` は元のメソッドに残す）
  '#applyTurnEnded': [
    {
      name: '#closeModelPhase',
      call: 'this.#closeModelPhase(timer, event);',
      trailing: '',
    },
    {
      name: '#settleFailedTurn',
      call: 'await this.#settleFailedTurn(event, turn, failure);',
      trailing: '',
    },
    {
      name: '#settleAnsweredTurn',
      call: 'await this.#settleAnsweredTurn(turn);',
      trailing: '',
    },
  ],
};

/**
 * ファイル → 元のメソッド → そこから出した段。メソッドの名前はファイルの中でだけ一意なので、ファイルで分ける
 * （clone.ts と runner.ts の両方に `#applyTurnEnded` のような同じ名前がありうる）。
 */
export const INLINED_BY_FILE: Readonly<
  Record<ScannedSource, Readonly<Record<string, readonly InlinedStep[]>>>
> = {
  'clone.ts': INLINED_BY_METHOD,
  'manager.ts': {},
  'runner.ts': {
    // SDK の `turn_ended` の1件（`RunnerSession#apply` から出した先）: 文脈占有を送る段と、成功したターンの使用量を送る段。
    // どちらも `await` を含まないので同期のメソッドへ出し、呼び出しにも `await` を付けない
    '#applyTurnEnded': [
      {
        name: '#emitContextUsage',
        call: 'this.#emitContextUsage(event, contextUsage);',
        trailing: '',
      },
      {
        name: '#emitAnsweredUsage',
        call: 'this.#emitAnsweredUsage(event, failure);',
        trailing: '',
      },
      // 報告の組み立てから送出・後始末（`RunnerReportEmitter#emit`。別ファイル）。引数は前半が算出した値で、本体の字面は元のまま。
      // 呼び出しの直後の `return;` は元のメソッドに残す（出した先の末尾の `return;` は差し戻すときに外す）
      {
        name: 'emit',
        call: 'this.#reportEmitter.emit(event, {said, failure, noCredentialDirHint, openedWorkersThisTurn, workerRejectionsThisTurn, failedWorkerNotificationsThisTurn, failedWorkerNotificationsNamingLimitThisTurn, liveBackground, outbox});',
        trailing: ' return;',
        from: 'runner-report-emit.ts',
      },
    ],
  },
  'digest.ts': {
    // 要約の全体の形: 末尾で `sections` へ節を足す `if` のうち、`await` を含まない4つ（エスカレーションの節は `await` を含むので出さない）
    buildActivityDigest: [
      {
        name: 'appendDecisionsSection',
        call: 'appendDecisionsSection(sections, decisions, decisionsCount, routineDecisionsCount);',
        trailing: '',
      },
      {
        name: 'appendPendingSection',
        call: 'appendPendingSection(sections, pending, unreadableApprovalNote);',
        trailing: '',
      },
      {
        name: 'appendMemoryUpdatesSection',
        call: 'appendMemoryUpdatesSection(sections, memoryUpdates, memoryUpdatesCount);',
        trailing: '',
      },
      {
        name: 'appendExternalsSection',
        call: 'appendExternalsSection(sections, externals, externalsCount, externalSourceTally, options);',
        trailing: '',
      },
    ],
  },
};

/** メソッドの本体を `squash` で畳み、`INLINED_BY_FILE` に載った段は、出した先の本体を呼び出しの位置へ差し戻したもの。 */
export function expandedMethodBody(
  text: string,
  method: string,
  file: ScannedSource = 'clone.ts',
): string {
  let body = squash(methodBody(text, method));
  for (const { name, call, trailing, from } of INLINED_BY_FILE[file][method] ?? []) {
    const at = body.indexOf(call);
    if (at === -1) continue;
    if (body.indexOf(call, at + 1) !== -1) throw new Error(`${call} が2回ある`);
    let inner =
      from === undefined
        ? squash(methodBody(text, name))
        : squash(methodBody(readCoreSource(from), name, true));
    if (trailing !== '') {
      if (!inner.endsWith(trailing)) throw new Error(`${name} の末尾が ${trailing.trim()} でない`);
      inner = inner.slice(0, -trailing.length);
    }
    body = body.slice(0, at) + inner + body.slice(at + call.length);
  }
  return body;
}

/** 括弧の中身を、深さ 1 の `,` で分ける。 */
export function splitGroup(text: string, open: number): string[] {
  const { close, commas } = readGroup(text, open);
  const bounds = [open, ...commas, close];
  const parts: string[] = [];
  for (let k = 0; k + 1 < bounds.length; k += 1) {
    parts.push(text.slice(bounds[k]! + 1, bounds[k + 1]!));
  }
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * 式の外側（コードの部分）の空白を1つに畳み、コメントを落とす。文字列（'…' / "…"）とテンプレートの地の文は、1文字も変えずに残す。
 * テンプレートの `${…}` の中はコードとして畳む。
 * 畳む理由: 書き換えると prettier が折り返しと字下げを変え、コメントの置き場所も動きうるため。文字列を畳まない理由: 書き換えの途中で文言の中の空白・改行を誤って変えたら見えるようにするため。
 */
export function squash(expression: string): string {
  let out = '';
  // `` ` `` はテンプレートの地の文の中、`${` はその中の式の中を表す
  const stack: string[] = [];
  let pendingSpace = false;
  const emit = (chunk: string): void => {
    // 開き括弧（`(` `[` `{` `${`）の直後の空白は落とす: prettier は字下げが変わると、同じ呼び出しを1行にも複数行にも折るため
    if (pendingSpace && out !== '' && !/(?:\$\{|[([{])$/.test(out)) out += ' ';
    pendingSpace = false;
    out += chunk;
  };
  // 閉じ括弧の直前の空白と末尾の `,` は落とす（開き括弧の直後と同じ理由。複数行に折ると末尾に `,` が付く）
  const close = (chunk: string): void => {
    pendingSpace = false;
    out = out.replace(/,\s*$/, '').trimEnd();
    out += chunk;
  };
  let i = 0;
  while (i < expression.length) {
    const ch = expression[i]!;
    if (stack.at(-1) === '`') {
      if (ch === '\\') {
        out += expression.slice(i, i + 2);
        i += 2;
      } else if (ch === '`') {
        out += ch;
        stack.pop();
        i += 1;
      } else if (ch === '$' && expression[i + 1] === '{') {
        out += '${';
        stack.push('${');
        i += 2;
      } else {
        out += ch;
        i += 1;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      pendingSpace = true;
      i += 1;
      continue;
    }
    if (ch === '/' && expression[i + 1] === '/') {
      const newline = expression.indexOf('\n', i);
      i = newline === -1 ? expression.length : newline;
      pendingSpace = true;
      continue;
    }
    if (ch === '/' && expression[i + 1] === '*') {
      const end = expression.indexOf('*/', i + 2);
      i = end === -1 ? expression.length : end + 2;
      pendingSpace = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < expression.length && expression[j] !== ch) j += expression[j] === '\\' ? 2 : 1;
      emit(expression.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      emit(ch);
      stack.push('`');
      i += 1;
      continue;
    }
    if (ch === '}' && stack.at(-1) === '${') {
      // `${…}` の閉じの前の空白は落とす（prettier が `${ x }` の形に折ることがあるため）
      close(ch);
      stack.pop();
      i += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      close(ch);
      i += 1;
      continue;
    }
    emit(ch);
    i += 1;
  }
  return out.trim();
}
