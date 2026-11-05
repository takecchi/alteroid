import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXCHANGE_KIND_PREFIXES } from './exchange-kind.js';

const CORE_SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

interface ExchangeWriteSite {
  readonly file: string;
  readonly line: number;
  readonly objectText: string;
  /** 書き込み箇所を囲むメソッド／関数の名前。行番号と違い、無関係な編集では動かない。 */
  readonly enclosing: string;
  readonly start: number;
  readonly end: number;
}

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
const DECLARATION_RE =
  /^ {0,2}(?:(?:export|default|public|private|protected|static|async|readonly)\s+)*(?:function\s+)?(?:get\s+|set\s+)?(#?[A-Za-z_$][\w$]*)\s*[(<]/;

function enclosingDeclaration(text: string, index: number): string {
  const lines = text.slice(0, index).split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    const m = DECLARATION_RE.exec(line);
    if (m && !NOT_A_DECLARATION.has(m[1]!) && !line.trimEnd().endsWith(';')) return m[1]!;
  }
  return '<top>';
}

function readCoreSource(file: string): string {
  return readFileSync(path.join(CORE_SRC_DIR, file), 'utf8');
}

/**
 * `type: 'exchange'` を実際に書く helper（ファイル → 本体を書くメソッド名・呼び出しの字面・helper が固定で書く `with`）。
 * helper の本体は text を変数で受けるので接頭辞の検査の対象にならない。代わりに、helper の呼び出し
 * （`this.#journalExchange('inbound' | 'outbound', text)` / `this.#journalSelf(…)`）の側を書き込み箇所として数える。
 * 表に無いファイルも既定の `journalExchange`（`#` の有無を問わない）の呼び出しを数える: 窓（`*-windows.ts`）などが `this.journalExchange(…)` で書くため。
 */
interface ExchangeHelper {
  /** 本体を書くメソッド名（その中の `journal({…})` は書き込み箇所に数えない）。無ければ本体はこのファイルに無い */
  readonly definition?: string;
  /** 呼び出しの字面（`this.` の後ろ）にかける正規表現の断片 */
  readonly callPattern: string;
  readonly with: string;
}
const DEFAULT_EXCHANGE_HELPER: ExchangeHelper = {
  callPattern: '#?journalExchange',
  with: 'manager',
};
const EXCHANGE_HELPER_DEFINITIONS: Record<string, ExchangeHelper> = {
  'clone.ts': { definition: '#journalSelf', callPattern: '#journalSelf', with: 'self' },
  'manager.ts': {
    definition: '#journalExchange',
    callPattern: '#?journalExchange',
    with: 'manager',
  },
};

/**
 * 書き込み箇所の走査。2つの形を数える:
 *  - `journal(` / `journal.append(` に渡すオブジェクトリテラルが `type: 'exchange'` を持つもの（従来どおり）
 *  - helper（`EXCHANGE_HELPER_DEFINITIONS`）の呼び出し `this.#helper(role, text)`（`with` を固定で書く helper。text は第2引数）
 */
function findJournalCallObjects(file: string): ExchangeWriteSite[] {
  const text = readCoreSource(file);
  const sites: ExchangeWriteSite[] = [];
  const helper = EXCHANGE_HELPER_DEFINITIONS[file] ?? DEFAULT_EXCHANGE_HELPER;
  const callRe = /\bjournal(?:\.append)?\(\{/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(text)) !== null) {
    const openBraceIndex = m.index + m[0].length - 1;
    const end = findMatchingBrace(text, openBraceIndex);
    if (end === -1) {
      throw new Error(
        `${file}: ${m.index} にある journal( 呼び出しの閉じ括弧が見つからない（括弧の対応が崩れている）`,
      );
    }
    const objectText = text.slice(openBraceIndex, end + 1);
    if (!/type:\s*'exchange'/.test(objectText)) continue;
    const enclosing = enclosingDeclaration(text, m.index);
    if (enclosing === helper.definition) continue;
    const line = text.slice(0, m.index).split('\n').length;
    sites.push({ file, line, objectText, enclosing, start: openBraceIndex, end });
  }
  const helperRe = new RegExp(`\\bthis\\.${helper.callPattern}\\(`, 'g');
  while ((m = helperRe.exec(text)) !== null) {
    const openParenIndex = m.index + m[0].length - 1;
    const end = findMatchingBrace(text, openParenIndex, '(', ')');
    if (end === -1) {
      throw new Error(
        `${file}: ${m.index} にある ${m[0]} 呼び出しの閉じ括弧が見つからない（括弧の対応が崩れている）`,
      );
    }
    const args = text.slice(openParenIndex + 1, end);
    const head = /^\s*'(?:inbound|outbound)',\s*/.exec(args);
    if (!head) {
      throw new Error(
        `${file}: ${m.index} にある ${m[0]} の第1引数が 'inbound' / 'outbound' の字面ではない（走査が読めない）`,
      );
    }
    sites.push({
      file,
      line: text.slice(0, m.index).split('\n').length,
      // 既存の欄の取り出しをそのまま使うため、`text` 欄を持つオブジェクトの形に直す（with は helper が固定で書く値）。
      objectText: `{ with: '${helper.with}', text: ${args.slice(head[0].length)} }`,
      enclosing: enclosingDeclaration(text, m.index),
      start: openParenIndex,
      end,
    });
  }
  return sites.sort((a, b) => a.start - b.start);
}

function findMatchingBrace(
  text: string,
  openIndex: number,
  open: '{' | '(' = '{',
  close: '}' | ')' = '}',
): number {
  let depth = 0;
  let inBacktick = false;
  let templateExprDepth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : '';
    if (inSingle) {
      if (ch === "'" && prev !== '\\') inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && prev !== '\\') inDouble = false;
      continue;
    }
    if (inBacktick) {
      if (templateExprDepth > 0) {
        if (ch === '{') templateExprDepth += 1;
        else if (ch === '}') templateExprDepth -= 1;
        continue;
      }
      if (ch === '`' && prev !== '\\') {
        inBacktick = false;
        continue;
      }
      if (ch === '$' && text[i + 1] === '{') {
        templateExprDepth = 1;
        i += 1;
        continue;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      continue;
    }
    if (ch === open) {
      depth += 1;
      continue;
    }
    if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
      continue;
    }
  }
  return -1;
}

function extractFieldValue(objectText: string, fieldName: string): string | undefined {
  const m = new RegExp(`(^|[{,\\s])${fieldName}:\\s*`).exec(objectText);
  if (!m) return undefined;
  let i = m.index + m[0].length;
  const start = i;
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let inBacktick = false;
  let templateExprDepth = 0;
  let inSingle = false;
  let inDouble = false;
  for (; i < objectText.length; i += 1) {
    const ch = objectText[i];
    const prev = i > 0 ? objectText[i - 1] : '';
    if (inSingle) {
      if (ch === "'" && prev !== '\\') inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && prev !== '\\') inDouble = false;
      continue;
    }
    if (inBacktick) {
      if (templateExprDepth > 0) {
        if (ch === '{') templateExprDepth += 1;
        else if (ch === '}') {
          templateExprDepth -= 1;
        }
        continue;
      }
      if (ch === '`' && prev !== '\\') {
        inBacktick = false;
        continue;
      }
      if (ch === '$' && objectText[i + 1] === '{') {
        templateExprDepth = 1;
        i += 1;
        continue;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      continue;
    }
    if (ch === '(') {
      depthParen += 1;
      continue;
    }
    if (ch === ')') {
      depthParen -= 1;
      continue;
    }
    if (ch === '[') {
      depthBracket += 1;
      continue;
    }
    if (ch === ']') {
      depthBracket -= 1;
      continue;
    }
    if (ch === '{') {
      depthBrace += 1;
      continue;
    }
    if (ch === '}') {
      if (depthBrace === 0) break;
      depthBrace -= 1;
      continue;
    }
    if (ch === ',' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
      break;
    }
  }
  return objectText.slice(start, i);
}

function isLiteralHumanWith(objectText: string): boolean {
  const withValue = extractFieldValue(objectText, 'with');
  return withValue !== undefined && withValue.trim() === "'human'";
}

function textFieldReferencesAnyPrefix(objectText: string): boolean {
  const textValue = extractFieldValue(objectText, 'text');
  if (textValue === undefined) return false;
  return EXCHANGE_KIND_PREFIXES.some(({ kind }) =>
    textValue.includes(`EXCHANGE_KIND_${kind.toUpperCase()}_PREFIX`),
  );
}

/**
 * 分類表: 「type: 'exchange' を書くメソッド／関数」→「そこで使う kind（接頭辞の kind 名、または構造で応答と分かる 'human'）」。
 *
 * 書き込み箇所の総数は固定しない（総数は並行する PR が同じ数に触れて、片方が main に入った後でもう片方の CI を落とした）。
 * 代わりに「どのメソッドが、どの kind で書くか」を持つ。守る性質は3つ:
 *  - 新しいメソッドに書き込み箇所を足したら、この表に1行足すまで落ちる（分類を忘れた箇所を通さない）
 *  - 既存メソッドに足した箇所でも、その行に無い kind を使えば落ちる（種別の取り違えを通さない）
 *  - メソッドから書き込み箇所が無くなったら、その行が残っていて落ちる（表の腐りを通さない）
 * 同じメソッドに同じ kind の箇所を足す・消すだけなら表は動かさずに通る（数の更新は要らない）。
 * 行はメソッド名の辞書順に並べる（並行する PR が同じ場所へ行を足して衝突しにくくするため）。
 * 限界: 複数の kind が並ぶメソッド（`#handleEvent` など）では、その行の kind どうしの取り違えは表では見えない（1箇所ごとの接頭辞の検査だけが守る）。
 */
const KINDS_BY_ENCLOSING: Record<string, Record<string, string>> = {
  'clone.ts': {
    // `#apply` の case を種類ごとのメソッドへ出したので、`#apply` 自身には書き込み箇所が無い。
    // 降格の行（`refusal`。欄を足しているので `#journalSelf` へ寄せていない）は `#applyRefusal` へ移った
    '#applyRateLimit': 'gauge',
    '#applyRefusal': 'decision',
    '#applySessionStarted': 'decision',
    '#buildSessionSpec': 'decision',
    '#completeScheduledRun': 'failure',
    '#dailyReport': 'decision,failure',
    // 墓標の拾い直しの後半（拾い直しの行・蒸留の失敗の行）は `#distillGrave` が書く。前半（読めなかった印の行）は各 `#pickUpOne*` に残る
    '#distillGrave': 'failure,recovery',
    '#dropPendingCollapse': 'thinning',
    '#dropStaleRedelivery': 'thinning',
    '#externalMcpServers': 'failure',
    '#foldIntoPendingCollapse': 'thinning',
    '#foldRecoveredNotice': 'thinning',
    // `#handle` の case を種類ごとのメソッドへ出した。書き込みは出した先の `#handleDistill`（蒸留の見送り）と `#handleTimer`（定期の依頼）に移った
    '#handleDistill': 'thinning',
    '#handleTimer': 'decision',
    '#journalIncomingBody': 'reply',
    // `#restoreUnreadPass` の live の見出しの1行を出した先
    '#journalRedeliveredLive': 'recovery',
    '#journalReply': 'reply',
    '#journalRestoreUnreadPassEnd': 'gauge',
    '#journalRestoreUnreadPassStart': 'gauge',
    '#journalSupersededTokenPoolNotice': 'thinning',
    '#noteCallerGauge': 'gauge',
    '#noteDenial': 'decision',
    '#noteDroppedSignals': 'decision',
    '#noteFoldedTick': 'thinning',
    '#noteGrantFunneled': 'decision',
    '#noteHeldEscalation': 'decision,human',
    '#noteRedeliveryPredicateHitB': 'gauge',
    '#noteRefusal': 'decision',
    '#noteRefusalToHuman': 'human',
    '#noteSkippedInitiativeTick': 'thinning',
    '#noteUnproductiveUsageBlockFold': 'decision',
    '#noteUsageNotice': 'gauge',
    '#onPreCompact': 'failure,recovery',
    '#onSubagentStop': 'decision',
    '#openHumanTask': 'failure',
    '#pickUpOneLostSession': 'failure',
    '#pickUpOneTranscriptGrave': 'failure',
    '#plugins': 'decision,failure',
    '#pump': 'thinning',
    '#read': 'decision',
    '#record': 'human',
    '#recordUsage': 'failure,gauge',
    '#recordWorkerLimit': 'decision',
    '#reopenAnswerDeliveryAfterFailure': 'decision',
    '#reopenSession': 'decision',
    '#reportDroppedGraves': 'failure',
    '#reportFailure': 'failure,human,thinning',
    '#restoreUnreadPass': 'thinning',
    '#resumeCandidateWithinBudget': 'decision',
    '#salvageTranscript': 'failure,recovery',
    // `#handleTimer` のターンの後の完了の記録を出した先（失敗の再試行の1行）
    '#settleTimerRun': 'failure',
    '#stopRunningTurn': 'decision,failure',
    '#withFreshMemory': 'gauge',
    '#withdrawQueued': 'decision',
    '#workerLimitNotice': 'decision',
    buildHumanAnswerEvent: 'thinning',
    dropQueuedInboxEvents: 'thinning',
  },
  'manager.ts': {
    '#askedOf': 'thinning',
    '#closeAfterLost': 'decision',
    '#closeDuplicateFailed': 'decision',
    '#closeSelfFenced': 'recovery',
    '#deliverReportFromUnreplacedSession': 'reply',
    '#deniedOf': 'thinning',
    '#dropStaleSessionEvent': 'decision',
    // `#handleEvent` の case を種類ごとのメソッドへ出したので、`#handleEvent` 自身には書き込み箇所が無い
    '#handlePermissionDenied': 'decision',
    '#handleReport': 'reply',
    '#handleResumeFailed': 'failure',
    '#handleSession': 'decision,failure',
    '#ignoreIfMovedAway': 'decision',
    '#ignoreOrDeferClosed': 'decision',
    '#journalNote': 'reply',
    '#noteAmbiguousResolved': 'recovery',
    '#noteAmbiguousSighting': 'failure',
    '#noteClosedFailure': 'failure',
    '#noteVanishedRunnerGauge': 'gauge',
    '#noticeSilentDone': 'decision',
    '#notifyResumeFallback': 'recovery',
    '#notifyUnresumable': 'failure',
    '#recordDelivery': 'reply',
    '#recordStoppedReport': 'decision',
    '#reportedOf': 'thinning',
    '#settleResumedAfterRestart': 'recovery',
    '#settleResumedReattach': 'recovery',
    '#startAfterSupersedeCheck': 'reply',
    abort: 'reply',
  },
  // 止まった拒否の知らせ直しの出し切りの日誌（旧 `Pool#renotifyStalledDenial`）。同じ検査をここへ移した。
  'denial-renotify.ts': {
    '#renotifyOne': 'thinning',
  },
  // 生ログの退避の継続性の日誌（旧 `Pool#handleEvent` の archive の case）。同じ検査をここへ移した。
  'archive-receiver.ts': {
    onArchive: 'failure',
  },
  // 押し込みの帳面の失敗の日誌（旧 `Pool#journalPushFailure` / `#flushPushFailureFold(s)`）。同じ検査をここへ移した。
  'push-ledger.ts': {
    '#flushFailureFold': 'thinning',
    '#flushFailureFolds': 'thinning',
    '#journalFailure': 'failure,thinning',
  },
  // 枠の窓の日誌（旧 `Pool#joinQuotaStopWindow` / `#deliverQuotaStopWindow`）。同じ検査をここへ移した。
  'quota-stop-windows.ts': {
    '#deliver': 'thinning',
    join: 'thinning',
  },
  // 合成した知らせの担当ごとの窓の日誌（旧 `Pool#flushSynthesizedNoticeFor`）。同じ検査をここへ移した。
  'synthesized-notice-windows.ts': {
    '#flushFor': 'gauge,thinning',
  },
  // 「取り戻した」窓と resume 確認の日誌（旧 `Pool#notifyRestored` / `#observeResumeConfirmation` ほか）。同じ検査をここへ移した。
  'restored-windows.ts': {
    '#deliverWindow': 'thinning',
    '#onTimeout': 'recovery',
    notify: 'recovery,thinning',
    observe: 'recovery',
  },
  // resume の最中に預けた出来事を窓が閉じるときに捨てた日誌（旧 `Pool#endRelocationWindow`）。同じ検査をここへ移した。
  'resume-event-windows.ts': {
    close: 'decision',
  },
  // 生ログの写しの預けの失敗の日誌（旧 `Pool#appendMirrorRetrying`）。同じ検査をここへ移した。
  'session-loaders.ts': {
    appendMirrorRetrying: 'failure',
  },
  // 使用量を受け取る出来事の日誌（旧 `Pool#handleEvent` の usage 系の case・`#recordStaleRunnerUsage`・`#usageNoticeMemoryOf`・`#retire` の畳み残し・`#flushRateLimitJournalFolds`）。同じ検査をここへ移した。
  'usage-receiver.ts': {
    '#recordStaleRunnerUsage': 'failure,gauge',
    '#usageNoticeMemoryOf': 'thinning',
    flushJournalFolds: 'thinning',
    onPeerUsage: 'failure',
    onRateLimit: 'gauge,thinning',
    onUsage: 'failure,gauge',
    onUsageNotice: 'gauge,thinning',
    retire: 'thinning',
  },
  // 枠の起こし直しの日誌（旧 `Pool#nudgeForUsageRotationOnce`）。同じ検査をここへ移した。
  'usage-wake.ts': {
    '#nudgeForUsageRotationOnce': 'failure,recovery',
  },
};

/**
 * `journal(` / `journal.append(` の形を取らずに `type: 'exchange'` を書いている箇所の明示の例外表（メソッド名 → 理由）。
 * 走査が見落とす書き方を黙って通さないための表で、載るのは helper の本体だけ（呼び出し側は走査が別に数える）。
 */
const EXCHANGE_LITERALS_OUTSIDE_JOURNAL_CALLS: Record<string, Record<string, string>> = {
  'clone.ts': {
    '#journalSelf':
      'type: exchange を書く helper の本体。呼び出し側（this.#journalSelf(…)）を走査が数える',
  },
  'manager.ts': {
    '#journalExchange':
      'type: exchange を書く helper の本体。呼び出し側（this.#journalExchange(…)）を走査が数える',
  },
};

function exchangeLiteralsOutside(
  file: string,
  sites: readonly ExchangeWriteSite[],
): ExchangeWriteSite[] {
  const text = readCoreSource(file);
  const outside: ExchangeWriteSite[] = [];
  const literalRe = /type:\s*'exchange'/g;
  let m: RegExpExecArray | null;
  while ((m = literalRe.exec(text)) !== null) {
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    if (/^\s*(\/\/|\*|\/\*)/.test(text.slice(lineStart, m.index))) continue;
    if (sites.some((site) => site.start <= m!.index && m!.index <= site.end)) continue;
    outside.push({
      file,
      line: text.slice(0, m.index).split('\n').length,
      objectText: m[0],
      enclosing: enclosingDeclaration(text, m.index),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return outside;
}

/**
 * 箇所の分類。接頭辞を text に持つならその kind 名、持たず `with: 'human'` の構造で応答と分かるなら 'human'、
 * どちらでもなければ空（＝分類が漏れている）。
 */
function classifyKinds(site: ExchangeWriteSite): string[] {
  const textValue = extractFieldValue(site.objectText, 'text') ?? '';
  const kinds = EXCHANGE_KIND_PREFIXES.filter(({ kind }) =>
    textValue.includes(`EXCHANGE_KIND_${kind.toUpperCase()}_PREFIX`),
  ).map(({ kind }) => kind as string);
  if (kinds.length > 0) return kinds.sort();
  return isLiteralHumanWith(site.objectText) ? ['human'] : [];
}

function kindsByEnclosing(sites: readonly ExchangeWriteSite[]): Record<string, string> {
  const merged = new Map<string, Set<string>>();
  for (const site of sites) {
    const set = merged.get(site.enclosing) ?? new Set<string>();
    for (const kind of classifyKinds(site)) set.add(kind);
    merged.set(site.enclosing, set);
  }
  return Object.fromEntries(
    [...merged.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, kinds]) => [name, [...kinds].sort().join(',')]),
  );
}

describe('type: exchange の書き込み全箇所が kind 接頭辞を持つ（issue #1332）', () => {
  for (const file of [
    'archive-receiver.ts',
    'clone.ts',
    'denial-renotify.ts',
    'manager.ts',
    'push-ledger.ts',
    'quota-stop-windows.ts',
    'restored-windows.ts',
    'resume-event-windows.ts',
    'session-loaders.ts',
    'synthesized-notice-windows.ts',
    'usage-receiver.ts',
    'usage-wake.ts',
  ]) {
    const sites = findJournalCallObjects(file);

    it(`${file}: 走査が書き込み箇所を1つも見つけられない状態（走査の故障）を通さない`, () => {
      expect(sites.length).toBeGreaterThan(0);
    });

    it(`${file}: journal( の形を取らない type: 'exchange' は明示の例外表にあるものだけ（走査の見落とし口を塞ぐ）`, () => {
      const allowed = Object.keys(EXCHANGE_LITERALS_OUTSIDE_JOURNAL_CALLS[file] ?? {});
      const unlisted = exchangeLiteralsOutside(file, sites)
        .filter((site) => !allowed.includes(site.enclosing))
        .map((site) => `${site.enclosing}（${file}:${String(site.line)}）`);
      expect(unlisted).toEqual([]);
    });

    it(`${file}: 書き込み箇所のあるメソッドがすべて分類表に載り、その kind が表と一致する（載せ忘れ・取り違え・表の腐りを通さない）`, () => {
      expect(kindsByEnclosing(sites)).toEqual(KINDS_BY_ENCLOSING[file]);
    });

    describe(`${file}: 各箇所が「with: 'human'（構造で応答と分かる）」か「6接頭辞のどれかを text に持つ」のどちらか`, () => {
      for (const site of sites) {
        it(`${file}:${String(site.line)}（${site.enclosing}）`, () => {
          if (isLiteralHumanWith(site.objectText)) {
            return;
          }
          expect(textFieldReferencesAnyPrefix(site.objectText)).toBe(true);
        });
      }
    });
  }
});

describe('exchange-kind-apply-branch: clone.ts の apply（with が self/human の条件式）', () => {
  it('self 側の分岐だけが EXCHANGE_KIND_REPLY_PREFIX を text に持つ（human 側は付けない）', () => {
    const sites = findJournalCallObjects('clone.ts');
    const applySite = sites.find((site) =>
      site.objectText.includes("turn.conversationId === null ? 'self' : 'human'"),
    );
    expect(applySite).toBeDefined();
    const textValue = extractFieldValue(applySite!.objectText, 'text');
    expect(textValue).toBeDefined();
    expect(textValue).toContain('EXCHANGE_KIND_REPLY_PREFIX');
    expect(textValue).toMatch(/turn\.conversationId === null \? EXCHANGE_KIND_REPLY_PREFIX : ''/);
  });
});
