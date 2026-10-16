/**
 * 担当の発言に英語の文が混ざったら、次の道具の結果に知らせを添え、日誌に1行残す（#4965）。
 *
 * 報告を日本語で書かせるのは運用の決まりで、製品の要件ではない（#2884・north_star 禁止2）。そのため既定は off で、
 * 掛けたい器が `ALTEROID_REPORT_LANGUAGE=ja` を runner の env か実行環境プロファイルに置く。
 * **知らせるだけで、止めない・断らない**（`block` を使わない）。
 */

export const REPORT_LANGUAGE_ENV = 'ALTEROID_REPORT_LANGUAGE';

export const REPORT_LANGUAGE_VALUES = ['ja', 'off'] as const;
export type ReportLanguageMode = (typeof REPORT_LANGUAGE_VALUES)[number];

// 既定は掛けない: 作者の運用スタイルを要件にしない（north_star 禁止2）
export const DEFAULT_REPORT_LANGUAGE: ReportLanguageMode = 'off';

export function resolveReportLanguage(env: NodeJS.ProcessEnv = process.env): ReportLanguageMode {
  const given = env[REPORT_LANGUAGE_ENV]?.trim();
  if (given === undefined || given.length === 0) return DEFAULT_REPORT_LANGUAGE;
  if ((REPORT_LANGUAGE_VALUES as readonly string[]).includes(given)) {
    return given as ReportLanguageMode;
  }
  // 綴り違いは黙って既定へ倒さず投げる: 持ち主が気づけないままにならないため（受け手が知らせない側へ倒して note に残す）
  throw new Error(
    `${REPORT_LANGUAGE_ENV} の値が不正: ${given}（使えるのは ${REPORT_LANGUAGE_VALUES.join(' / ')}。既定は ${DEFAULT_REPORT_LANGUAGE}）`,
  );
}

// 実効の値: 実行環境プロファイルの値を優先し、無ければ runner の env の値（`resolveEffectiveBashShapeGuard` と同じ作法）
export function resolveEffectiveReportLanguage(
  env: NodeJS.ProcessEnv,
  profileEnv: Readonly<Record<string, string>>,
): ReportLanguageMode {
  const fromProfile = profileEnv[REPORT_LANGUAGE_ENV]?.trim();
  if (fromProfile !== undefined && fromProfile.length > 0) {
    return resolveReportLanguage({ [REPORT_LANGUAGE_ENV]: fromProfile });
  }
  return resolveReportLanguage(env);
}

// 起動行・出し直しの行。不正な値でも投げず、不正だと分かるように書く（起動は落とさない）
export function describeReportLanguage(
  env: NodeJS.ProcessEnv,
  profileEnv: Readonly<Record<string, string>>,
): string {
  const fromProfile = (profileEnv[REPORT_LANGUAGE_ENV]?.trim() ?? '').length > 0;
  const tail = fromProfile
    ? `（${REPORT_LANGUAGE_ENV}。実行環境プロファイルの値。runner の env より優先される）`
    : `（${REPORT_LANGUAGE_ENV}。runner の env の値。実行環境プロファイルに置けばそちらが優先される）`;
  try {
    return `報告の言語の知らせ: ${resolveEffectiveReportLanguage(env, profileEnv)}${tail}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `報告の言語の知らせ: 不正な値（${message}）。直すまで知らせない${tail}`;
  }
}

// --- 判定 ---

// 小さく持つ: 増やすほど、英単語を交えた日本語以外の札（`Test Files  659 passed`）まで引っかけるため
const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'the',
  'a',
  'an',
  'to',
  'is',
  'are',
  'was',
  'be',
  'and',
  'or',
  'of',
  'for',
  'with',
  'in',
  'on',
  'it',
  'this',
  'that',
  'then',
  'now',
  'not',
  'will',
  'can',
  'should',
  'we',
  'i',
  'you',
  'let',
  'check',
  'pass',
  'fail',
  'run',
  'add',
  'fix',
]);

// 行頭がこの語の行はコマンドとして外す。大文字始まり（`Run the tests`）は英語の文なので、小文字だけで照合する
const COMMAND_NAMES: ReadonlySet<string> = new Set([
  'git',
  'gh',
  'pnpm',
  'npm',
  'npx',
  'yarn',
  'node',
  'cd',
  'ls',
  'cat',
  'grep',
  'rg',
  'sed',
  'awk',
  'echo',
  'curl',
  'docker',
  'make',
  'bash',
  'sh',
  'timeout',
  'vitest',
  'tsc',
  'eslint',
  'prettier',
  'find',
  'head',
  'tail',
  'rm',
  'mv',
  'cp',
  'mkdir',
  'export',
  'sudo',
  'kill',
  'ps',
  'jq',
  'wc',
  'date',
  'touch',
  'chmod',
  'python',
  'python3',
]);

const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const FENCED_CODE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE = /`[^`\n]*`/g;
const URL = /\b(?:https?|ftp):\/\/\S+|\bwww\.\S+/g;
const LIST_MARKER = /^(?:[-*+]|\d+[.)])\s+/;
const PROMPT_MARKER = /^\$\s+/;
// 行頭が時刻（`2026-10-16T01:02:03Z`・`[12:34:56]`・`12:34`）の行はログとして外す
const TIMESTAMP_LINE = /^\[?(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2})?|\d{1,2}:\d{2}(?::\d{2})?)/;
// 拡張子の付いた語（`README.md`・`runner-pids-pressure.ts`）。文末の句点（`fails.`）は拡張子が無いので当たらない
const FILE_NAME = /^[^\s]*[\w-]\.[A-Za-z][A-Za-z0-9]{0,7}[)\]}"',;:]*$/;
const SENTENCE_BREAK = /[。.!?:\n]/;
const EDGE_PUNCTUATION = /^[("'[{<*_]+|[)"'\]}>*_,;]+$/g;
const ENGLISH_WORD = /^[A-Za-z]+(?:'[A-Za-z]+)?$/;

// 行頭がエラーや道具の出力の札（`TypeError:`・`AssertionError:`・`Error:`・`fatal:`・`ELIFECYCLE`・`npm ERR!` など）の行は、出力の引用として外す。
// 報告でエラーを引くのは正当で、ここで知らせると担当にとってうるさいだけになるため（開発マネージャーの下調べ、2026-10-16）
const OUTPUT_LINE =
  /^(?:[A-Za-z]*(?:Error|Exception)\b|error:|fatal:|warning:|warn:|hint:|ELIFECYCLE\b|FAIL\b|PASS\b|npm ERR!)/;
// 数字を含む語（`5000ms`・`1/2`・`v18`）がある文は、道具の出力の断片として外す: 担当の地の文の英語を少し見逃す側に倒す
const DIGIT_TOKEN = /\b\w*\d\w*\b/;

function isCommandOrLogLine(line: string): boolean {
  if (TIMESTAMP_LINE.test(line) || OUTPUT_LINE.test(line)) return true;
  const head = line.split(/\s+/, 1)[0] ?? '';
  return COMMAND_NAMES.has(head);
}

function dropPaths(line: string): string {
  return line
    .split(/\s+/)
    .filter((token) => !token.includes('/') && !FILE_NAME.test(token))
    .join(' ');
}

function isEnglishSentence(sentence: string): boolean {
  if (JAPANESE.test(sentence)) return false;
  if (DIGIT_TOKEN.test(sentence)) return false;
  const words = sentence
    .split(/\s+/)
    .map((token) => token.replace(EDGE_PUNCTUATION, ''))
    .filter((token) => ENGLISH_WORD.test(token));
  if (words.length < 2) return false;
  return words.some((word) => FUNCTION_WORDS.has(word.toLowerCase()));
}

/**
 * 本文から英語の文を拾う。コード・URL・パス・引用・コマンドやログに見える行は外す。
 * 日本語の文字を1字も含まず、英字だけの語が2語以上あり、英語の機能語を1つ以上含む文だけを数える。
 */
export function findEnglishSentences(text: string): string[] {
  const found: string[] = [];
  for (const rawLine of text.replace(FENCED_CODE, '\n').split('\n')) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('>')) continue;
    const line = trimmed.replace(LIST_MARKER, '').replace(PROMPT_MARKER, '');
    if (line.length === 0 || isCommandOrLogLine(line)) continue;
    const prose = dropPaths(line.replace(INLINE_CODE, ' ').replace(URL, ' '));
    for (const piece of prose.split(SENTENCE_BREAK)) {
      const sentence = piece.replace(/\s+/g, ' ').trim();
      if (isEnglishSentence(sentence)) found.push(sentence);
    }
  }
  return found;
}

// --- 知らせ ---

/** 同じ担い手へ知らせ直すまでの間隔（日誌の1行も同じ間隔）。 */
export const REPORT_LANGUAGE_NOTICE_INTERVAL_MS = 10 * 60_000;

/** 知らせ・日誌に載せる例の長さ。 */
export const REPORT_LANGUAGE_EXAMPLE_MAX_CHARS = 80;

export function excerptExample(sentence: string): string {
  return sentence.length > REPORT_LANGUAGE_EXAMPLE_MAX_CHARS
    ? `${sentence.slice(0, REPORT_LANGUAGE_EXAMPLE_MAX_CHARS)}…`
    : sentence;
}

export function describeReportLanguageNotice(example: string): string {
  return (
    `⚠ alteroid からの知らせ: 直前の文に英語が混ざっている（例: "${excerptExample(example)}"）。` +
    '途中の文も報告も日本語で書くこと。識別子・ファイル名・コマンドは英語のままでよい。これは知らせで、止める指示ではない。'
  );
}

/**
 * 担い手（担当本人は `manager`、作業者は agentId）ごとに、知らせる待ちと、最後に知らせた・日誌に書いた時刻を覚える。
 * 間隔の内に見つけた分は待ちに積まない: 間隔が明けた後に、もう直前ではない文の知らせが届くため。
 */
export class ReportLanguageNotices {
  readonly #pending = new Map<string, string>();
  readonly #lastNotifiedAt = new Map<string, number>();
  readonly #lastNotedAt = new Map<string, number>();

  /** 見つけた文を待ちに積む。日誌に1行書くべきなら `true` を返す（同じ担い手に間隔の内で1回まで）。 */
  observe(actor: string, found: readonly string[], nowMs: number): boolean {
    const first = found[0];
    if (first === undefined) return false;
    const notified = this.#lastNotifiedAt.get(actor);
    if (notified === undefined || nowMs - notified >= REPORT_LANGUAGE_NOTICE_INTERVAL_MS) {
      this.#pending.set(actor, first);
    }
    const noted = this.#lastNotedAt.get(actor);
    if (noted !== undefined && nowMs - noted < REPORT_LANGUAGE_NOTICE_INTERVAL_MS) return false;
    this.#lastNotedAt.set(actor, nowMs);
    return true;
  }

  /** 知らせるなら本文を、知らせないなら `null` を返す。 */
  next(actor: string, nowMs: number): string | null {
    const example = this.#pending.get(actor);
    if (example === undefined) return null;
    this.#pending.delete(actor);
    const last = this.#lastNotifiedAt.get(actor);
    if (last !== undefined && nowMs - last < REPORT_LANGUAGE_NOTICE_INTERVAL_MS) return null;
    this.#lastNotifiedAt.set(actor, nowMs);
    return describeReportLanguageNotice(example);
  }
}
