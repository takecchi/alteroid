import { readNumberEnv, unreadableEnvRecordNote } from './env-value-not-used.js';
import { fillListingBudget } from './excerpt.js';
import { formatDurationMinutes } from './format-elapsed.js';

/**
 * **なぜ30分か。** 背景処理は `pnpm test` で4分・作業者の委譲で10分規模が普通にある。
 * 短いと、正常に完了を待っているだけの積みまで「配っていない」と急かして握り潰しの意味が消える。
 * 長いと、次のターンが本当に来ない回で最終報告相当の知らせが30分近く寝る。
 */
export const WITHHELD_REPORT_FLUSH_MS = 30 * 60_000;

/** 30分が妥当かをまだ観測していないので、コード変更＋デプロイを待たずに済むよう口だけ開けてある。既定は動かさない。 */
export const WITHHELD_REPORT_FLUSH_MS_ENV_KEY = 'ALTEROID_WITHHELD_REPORT_FLUSH_MS';

/** **2箇所（数値として読めない／0以下）から呼ぶので定数に寄せる**: 書き写すと片方だけ直る形になる。 */
const WITHHELD_FLUSH_MS_UNREADABLE_WHAT = '握り潰しの配り直しの期限の設定';

/**
 * どの経路でも既定へ倒すが、「置かなかった」（未設定・空）は跡を出さず、「置いたのに読めなかった」
 * （数値でない・0以下）は跡を残す。跡が無いと、置いたのに効いていないことが置いた本人から見えない。
 * 正常な状態にまで鳴らすと跡がノイズで埋まる。
 * `noteDroppedRecord` ではなく `noteUnreadableRecord` を呼ぶ: 前者は「記録できませんでした」と書き、
 * 読み出しの失敗の跡が何が起きたかを取り違えさせる。**値そのものは跡に載せない**（env は器の外から来る任意の文字列）。
 */
export function resolveWithheldReportFlushMs(env: NodeJS.ProcessEnv = process.env): number {
  // **未設定と空は同じ「指定しない」である**（`readNumberEnv` が知らせずに既定へ返す）
  return readNumberEnv(env[WITHHELD_REPORT_FLUSH_MS_ENV_KEY], {
    fallback: WITHHELD_REPORT_FLUSH_MS,
    positive: true,
    onProblem: unreadableEnvRecordNote(
      WITHHELD_REPORT_FLUSH_MS_ENV_KEY,
      WITHHELD_FLUSH_MS_UNREADABLE_WHAT,
      {
        'not-number': `数値として読めない。既定の ${String(WITHHELD_REPORT_FLUSH_MS)}ms で走る`,
        'non-positive': `0 以下は期限にならない。既定の ${String(WITHHELD_REPORT_FLUSH_MS)}ms で走る`,
      },
    ),
  });
}

export const WITHHELD_REPORT_EXCERPT = 240;

/**
 * 畳んだ報告の冒頭の一覧に使う字数の予算。件数では締めない（件数だけだと何件で溢れるかが運任せになる）。
 * 600 にしてある理由: この注記は直後に本報告が続く回に付き、冒頭の抜粋は本報告と重なることが多い。1500 では 240 字の行が 5〜6 本
 * （約 1,700 字）載っていた。240 字の行は 2 本（約 530 字）までで、新しい側が残り、古い側は「古い N 本」の 1 行へ回る。
 * 全文は日誌に在るので、落ちた分は `journal_read` で読める。
 */
export const WITHHELD_REPORT_LISTING_BUDGET = 600;
/** #5414 の前の予算。`ALTEROID_TOKEN_SAVING_EXCERPT` が無効のときに戻す値。 */
export const WITHHELD_REPORT_LISTING_BUDGET_BEFORE_SAVING = 1500;

function withheldExcerptItem(entry: { at: string; line: string }): string {
  return `- ${entry.at} ${entry.line}`;
}

/**
 * 畳んだ報告の冒頭を、時刻つきで1行ずつ並べる。予算を超えたら**新しい側を残し**、古い側が何本落ちたかを必ず書く
 * （直近の報告ほど「次に何をするか」を持つので、末尾から詰める）。落ちた分の全文は日誌に在る。
 * `total` は畳んだ本数（`count`）: 在庫は台帳に写すために予算の内へ詰めてあり、詰めて落とした分は `excerpts` に無いので、本数は件数から数える。
 */
export function renderWithheldExcerpts(
  excerpts: readonly { at: string; line: string }[],
  total: number = excerpts.length,
  budget: number = WITHHELD_REPORT_LISTING_BUDGET,
): string {
  const { lines, shown } = fillListingBudget(excerpts.map(withheldExcerptItem), budget, true);
  const omitted = Math.max(0, total - shown);
  if (omitted > 0) {
    lines.unshift(
      `（古い ${String(omitted)} 本の冒頭は字数の予算で省いた。全文は日誌に在る（\`journal_read\`））`,
    );
  }
  return lines.join('\n');
}

// 配るときに予算から溢れる古い冒頭は、積む時点で落とす: 台帳の写し（`Job.withheldReports`）がエピソードの長さに比例して育たないため
export function trimWithheldExcerpts(
  excerpts: readonly { at: string; line: string }[],
  budget: number,
): { at: string; line: string }[] {
  const { shown } = fillListingBudget(excerpts.map(withheldExcerptItem), budget, true);
  return excerpts.slice(excerpts.length - shown);
}

/**
 * `Pool` の帳面は真の private field で外から壊れた値を注入できないので、判定だけを外へ出してある。
 * **`lastAt` が読めない（`NaN`）ときは期限切れとして「配る」側へ倒す**: 同じ知らせが1回多く付くのは許容し、
 * 在庫に永久に残って二度と配られないのは許さない。
 */
export function withheldReportOverdue(lastAt: string, now: number, flushMs: number): boolean {
  const parsed = Date.parse(lastAt);
  return Number.isNaN(parsed) || now - parsed >= flushMs;
}

/**
 * **見るのは `firstAt` の1つだけ**: `flushedAt` を経過を測る材料にすると、経過時間の出所が2つになり、どちらを信じるかという問いが生まれる。
 * **`firstAt` が読めない・未来を指している（経過が負）ときは、経過を捏造しない**: 0分のような「それらしい値」を作らず、
 * 読めないことそのものを出力へ書く（取れない軸に0の行を作らない）。
 */
export function describeBackgroundWaitElapsed(firstAt: string, now: number): string {
  const parsed = Date.parse(firstAt);
  if (Number.isNaN(parsed)) {
    return `この委譲は、背景処理待ちのまま（最初の時刻 ${firstAt} が読めないため、経過時間は不明）。`;
  }
  const elapsedMs = now - parsed;
  if (elapsedMs < 0) {
    return (
      `この委譲は、背景処理待ちのまま（最初 ${firstAt} が現在より未来のため、` +
      '経過時間は不明）。'
    );
  }
  return `この委譲は${formatDurationMinutes(elapsedMs)}、背景処理待ちのまま（最初 ${firstAt}）。`;
}
