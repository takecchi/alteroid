import { readNumberEnv, unreadableEnvRecordNote } from './env-value-not-used.js';
import type { QuotaMark } from './quota-stop-notice.js';
import type { RestoredEntry } from './restored-notice.js';
import { MAX_RESCUE_INTERVAL_MS } from './rescue-ref.js';

/**
 * **`string` にしてあるのは、`runner-protocol.ts` の `report.synthesized` と同じ語彙を共有するため**:
 * 版のずれで知らない族の名前が届いても型では落ちず、{@link describeSynthesizedNoticeLabel} の未知語フォールバックで吸収する。
 * 日誌の内訳と見出しにだけ使い、畳む判定には使わない（時刻の窓だけで行う）。
 */
export type SynthesizedNoticeLabel = string;

/** **網羅ではない**: `report.synthesized` は `z.string()` なので、ここに無い値が届くことがある。 */
const KNOWN_SYNTHESIZED_NOTICE_LABELS: Record<string, string> = {
  rate_limit: '枠の遷移（追い返された／課金枠へ入った）',
  usage_notice: '利用上限の通知',
  closed_failed: 'セッションが落ちた',
  closed_done_silent: 'report を出さないまま閉じた（done）',
  turn_failed: '応答を返さずに終わったターンの報告',
  closed_withheld_flush: '委譲の終了と、背景処理の完了待ちで畳んでいた報告の配り',
  usage_rewoken: '枠で落ちていた failed / lost の委譲を、新しい鍵で自動で起こし直した',
  usage_rewoken_folded:
    '鍵の入れ替えで背景処理を畳み、新しい鍵で起こし直して、自分で確かめて進めるよう促した',
  resume_fallback: '器の入れ替えで前のセッションへ戻れず、生ログから作り直して続けた',
  resume_failed: '器の入れ替えで前のセッションへ戻れず、再開そのものに失敗した',
  resume_unconfirmed: '器の入れ替えの後の再開が、期限までに戻れたと確かめられなかった',
  held_stuck: '預かった伝言が待ちの上限を過ぎても畳めず、届けられないまま',
};

/**
 * 担当が戻っていればクローンが畳んでよい合成の知らせの族（#5048）。ここに無い族が1つでも混ざる束には印を付けない。
 * - `usage_rewoken`: 枠で落ちていた委譲を新しい鍵で起こし直した（後継が居ない回だけ。呼び手が確かめる）
 * - `closed_failed`: セッションが落ちた（担当が戻って走っていれば、手を打つことが無い）
 * - `usage_rewoken_folded`: 鍵の入れ替えで背景処理を畳んで起こし直した（結果を確かめて進めるのは担当自身。担当が現役の鍵で戻っていれば、クローンが止まったと見誤る余地も無い）
 */
export const FOLD_WHEN_BACK_SYNTHESIZED_LABELS: ReadonlySet<string> = new Set([
  'usage_rewoken',
  'closed_failed',
  'usage_rewoken_folded',
]);

/** 担当が戻っていればクローンが畳んでよい印（`manager_message.foldWhenBack`。#5048）。 */
export type FoldWhenBack = { movedFromGeneration?: number; attached?: true };

/**
 * **未知の族は素の値をそのまま返す。** 落とさず表示することが「版がずれている」という事実の唯一の跡になる
 * （例外を投げる・既定の1語へ潰すとその跡が消える）。
 */
function describeSynthesizedNoticeLabel(label: SynthesizedNoticeLabel): string {
  return KNOWN_SYNTHESIZED_NOTICE_LABELS[label] ?? label;
}

/**
 * **完全な重複（族も本文もバイト単位で同一）だけ1件へ寄せて数だけ持つ**（情報が失われないから畳んでよい）。
 * **本文が1バイトでも違えば別の断片として残す**（代表を選べない）。
 * **通数そのものは捨てない**: 「4通が3通に減ったのか、1回が3回に増えたのか」を区別する材料になる。
 */
export interface SynthesizedNoticeFragment {
  label: SynthesizedNoticeLabel;
  text: string;
  /** 1以上。 */
  count: number;
  /**
   * 枠（利用上限）だけが理由の断片につける印。**積む呼び手が付ける**（`#queueSynthesizedNotice` の第4引数）。
   * 全断片に印が付いた束だけがプール全体の1通へ回る（{@link QuotaStopWindow}）。1つでも欠ければ担当ごとに配る。
   */
  quota?: QuotaMark;
}

/**
 * 枠だけの束をプール全体で1通にまとめる窓。最初の束が来た時点で開き、{@link QUOTA_STOP_WINDOW_MS} 後に閉じる固定窓
 * （延長しない: 届き続ける限り閉じなくなり、配る保証が崩れる。north_star 禁止2）。
 * **1本目はすぐ、残りは1通**: 窓を開けた担当（`openerId`）の束は今までどおり担当ごとに配る（窓へは一覧の材料として覚えるだけ）。
 * 窓が開いている間に来た**別の担当**の束は、担当ごとには配らずここへ貯める。窓が閉じたとき、貯めた担当が居なければ何も配らない
 * （担当1本だけの回は今までと完全に同じ）。居れば窓を開けた担当も含めた一覧を1通にして配る。
 */
export interface QuotaStopWindow {
  timer: ReturnType<typeof setTimeout>;
  openedAt: number;
  /** 窓を開けた担当。この担当の束は配り済み。 */
  openerId: string;
  /** 担当ごと。同じ担当の束が窓の中で複数来たら断片を足す（到着順のまま）。 */
  entries: Map<
    string,
    {
      fragments: SynthesizedNoticeFragment[];
      arrived: number;
      /** 貯めた担当が抱えていた、畳んでいた報告（一覧の行に添える。窓を開けた担当には付かない）。 */
      withheld?: { count: number; lastExcerpt: string };
    }
  >;
}

/**
 * 「取り戻した」知らせの窓。{@link QuotaStopWindow} と同じ形（1本目はすぐ担当ごとに配り、窓が開いている間の別の担当は貯めて、
 * 閉じたとき1本以上貯まっていれば窓を開けた担当も含めた一覧を1通にする。固定窓で延長しない）。
 */
export interface RestoredWindow {
  timer: ReturnType<typeof setTimeout>;
  openedAt: number;
  openerId: string;
  /** 見出し（`#notifyRestored` の `head`）。cause ごとに決まる。 */
  head: string;
  /** 担当ごとの最新の1行ぶん。 */
  entries: Map<string, RestoredEntry>;
}

export interface SynthesizedNoticeWindow {
  /** **到着順のまま持つ（並べ替えない）。** */
  fragments: SynthesizedNoticeFragment[];
  /** flush で必ず `clearTimeout`。 */
  timer: ReturnType<typeof setTimeout>;
  /**
   * 観測用の記録だけで、畳み込みの鍵・判定・配り方には使わない。
   * 1件だけの窓は「合流しなかった」として日誌へ書かない（0件という値を作らず、行自体を出さない）。
   */
  arrivedAt: number[];
}

/**
 * **「連続するかぎり畳む」ための記憶であって、上限ではない。** 合流窓（既定3000ms）の中の畳み込みは窓が閉じると消えるので、
 * 429 のように同じ失敗が何分も繰り返されると同じ本文が窓の数だけ受信箱へ積まれ、クローンの文脈窓を埋める。
 *
 * **黙らせるのではない。1件目は必ず配る**（枠で落ちたことはクローンが知らなければならない）。消すのは2件目以降の
 * 完全な重複だけで、件数は日誌の1束1行と次に配る `manager_message` の末尾の1行（`#deliver`）に残る。
 * **窓を広げて解く道は採らない**: 広げると無関係な出来事が混ざる。こちらはバイト単位で同一の束だけを扱うので時間の窓が要らない。
 *
 * **実際に読み書きするのは `turn_failed` 単独の束だけ**（{@link isCrossWindowStreakEligible}）。
 * `rate_limit` / `usage_notice` は別の専用の記憶で「配る価値があるか」を判定済みなので、
 * 文字列一致を掛けると状態ベースの判定を上書きして壊れる。
 */
export interface SynthesizedNoticeStreak {
  signature: string;
  /** 束の数。 */
  suppressed: number;
  /** **通数**の総和（束の数ではない）。 */
  suppressedArrived: number;
  /** `suppressed === 0` のあいだは持たない。 */
  firstAt?: string;
  lastAt?: string;
}

/**
 * **`count` は入れない。** 入れると「同文が3通の束」と「同文が1通の束」が別物になり、通数が回によって違う枠落ちでは畳めなくなる。
 * 通数は `suppressedArrived` の側で保存する。**正規化も切り詰めもしない**（1バイトでも違えば別のことを言っている側へ倒す）。
 */
export function synthesizedNoticeSignature(
  fragments: readonly SynthesizedNoticeFragment[],
): string {
  return JSON.stringify(fragments.map((fragment) => [fragment.label, fragment.text]));
}

/**
 * **窓をまたいだ抑制の対象を `turn_failed` 単独の束に絞る。**
 * `rate_limit` と `usage_notice` は専用の記憶（`usageTransitionOf` / `#usageNoticeMemoryOf().delivered`）で
 * 状態に基づいて「配る価値があるか」を判定済みで、文字列一致の抑制を重ねると、文字列は同一でも
 * 意味的には新しい出来事（rejected → allowed → rejected）を握りつぶして壊れる。
 * `resume_fallback` / `resume_failed` / `closed_failed` は広げない: 窓をまたいだ抑制が要るという実測が無く、
 * 要ると分かってから広げる。混ざった束も対象にしない。
 */
export function isCrossWindowStreakEligible(
  fragments: readonly SynthesizedNoticeFragment[],
): boolean {
  return fragments.length === 1 && fragments[0]?.label === 'turn_failed';
}

/**
 * 広ければ良い値ではない: 広すぎると無関係な束を1件にまとめて情報が混ざる（狭すぎは畳めないだけで情報は消えない）。
 * 窓の役目は一度に吐かれた束を捕まえることで、離れて届いたものを繋ぐことではない。
 * 実測の最大間隔に合わせて数十秒の桁へ広げない。既定は実測の最大の列（1,682ms）に余裕を持たせた値で、
 * 原理から出た値ではない（だから環境変数で差し替えられる）。窓が割れても畳める件数が減るだけでデータは失われない。
 * 「最大でこれだけ待つ」であって「この間隔で配る」ではない（`#emit` が窓の満了を待たずに配り切る）。
 */
const SYNTHESIZED_NOTICE_WINDOW_MS = 3_000;

export const SYNTHESIZED_NOTICE_WINDOW_MS_ENV_KEY = 'ALTEROID_SYNTHESIZED_NOTICE_WINDOW_MS';

/** 2箇所（数値として読めない／0以下）から呼ぶので定数に寄せる。 */
const SYNTHESIZED_NOTICE_WINDOW_MS_UNREADABLE_WHAT = '機構合成の知らせをまとめる窓の長さの設定';

/** `resolveWithheldReportFlushMs` と同じ形（跡の出し方・値そのものを載せないことも同じ理由）。 */
export function resolveSynthesizedNoticeWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  return readNumberEnv(env[SYNTHESIZED_NOTICE_WINDOW_MS_ENV_KEY], {
    fallback: SYNTHESIZED_NOTICE_WINDOW_MS,
    positive: true,
    // **上限で挟む（黙って）。運用の上限ではなく、タイマーの仕様の範囲を守るためのもの**——`setTimeout` は
    // 2^31-1 ms を超える値を 1ms へ倒し、窓が効かなくなる。
    max: MAX_RESCUE_INTERVAL_MS,
    clamp: true,
    onProblem: unreadableEnvRecordNote(
      SYNTHESIZED_NOTICE_WINDOW_MS_ENV_KEY,
      SYNTHESIZED_NOTICE_WINDOW_MS_UNREADABLE_WHAT,
      {
        'not-number': `数値として読めない。既定の ${String(SYNTHESIZED_NOTICE_WINDOW_MS)}ms で走る`,
        'non-positive': `0 以下は期限にならない。既定の ${String(SYNTHESIZED_NOTICE_WINDOW_MS)}ms で走る`,
      },
    ),
  });
}

/**
 * **要約も間引きもしない。ただ1つの例外は完全な重複**（本文が1バイトでも違えば寄せない）。族ごとに断片は違うことを
 * 答えているので、全文を到着順のまま連結する。
 * **1件のときは前置きを付けない**（いちばん多い「1件だけ」の本文に断り書きが載る形にしない。`clone.ts` の `#mergedHumanBatch` と同じ）。
 * 到着順は実測であって保証ではないので、断片ごとに `label` を見出しに出して境目を見つけられるようにする。
 */
export function mergeSynthesizedNoticeFragments(fragments: readonly SynthesizedNoticeFragment[]): {
  text: string;
  breakdown: string;
  /** **実際に届いた通数**（断片の本数ではない）。 */
  arrived: number;
} {
  const arrived = fragments.reduce((sum, fragment) => sum + fragment.count, 0);
  const describe = (fragment: SynthesizedNoticeFragment): string =>
    `${describeSynthesizedNoticeLabel(fragment.label)}${
      fragment.count > 1 ? ` ×${String(fragment.count)}` : ''
    }`;
  const first = fragments[0];
  // 断片の本数ではなく通数で見る: 同文が3通なら断片は1本だが、3通あったことは情報である。
  if (arrived <= 1) {
    return {
      text: first?.text ?? '',
      breakdown: first === undefined ? '' : describe(first),
      arrived,
    };
  }
  const breakdown = fragments.map(describe).join('、');
  const folded = arrived - fragments.length;
  const header =
    `（1つの出来事について ${String(arrived)} 件の知らせをまとめた` +
    (folded === 0 ? '' : `。うち同文の重複 ${String(folded)} 件は数だけ残して畳んだ`) +
    '）';
  const body = fragments
    .map(
      (fragment, i) =>
        `--- ${String(i + 1)}/${String(fragments.length)}（${describe(fragment)}） ---\n${fragment.text}`,
    )
    .join('\n\n');
  return { text: `${header}\n\n${body}`, breakdown, arrived };
}

/**
 * **1件しか無いときは `undefined` を返す**: 合流しなかったことは0件という値ではなく行が無いことで表す（取れない軸に0の行を作らない）。
 * **畳み込みの判定にも配り方にも使わない**（日誌へ書く計器だけの入力）。
 */
export function synthesizedNoticeArrivalIntervals(
  arrivedAt: readonly number[],
): { count: number; maxIntervalMs: number; minIntervalMs: number } | undefined {
  if (arrivedAt.length <= 1) return undefined;
  let maxIntervalMs = -Infinity;
  let minIntervalMs = Infinity;
  for (let i = 1; i < arrivedAt.length; i += 1) {
    const interval = (arrivedAt[i] ?? 0) - (arrivedAt[i - 1] ?? 0);
    if (interval > maxIntervalMs) maxIntervalMs = interval;
    if (interval < minIntervalMs) minIntervalMs = interval;
  }
  return { count: arrivedAt.length, maxIntervalMs, minIntervalMs };
}
