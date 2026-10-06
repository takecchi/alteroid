import { Cron } from 'croner';

/**
 * cron 式の解釈（継続中の依頼の周期のひとつ）。
 *
 * **人間が cron で書けることを、この階層でも書けるようにするためだけの薄い層。**
 * 自前で解釈すると、曜日の別名・`*&#47;5`・範囲・`L` のような細部でじわじわ嘘をつく
 * ようになる（人間が慣れている書き方が通らない＝デグレード）。croner は依存ゼロ・
 * ESM・型付きなのでそのまま埋め込める。
 *
 * ここに「何回まで」を表す形を足さないこと。表すのは「いつ起こすか」だけである
 * （north_star 禁止2）。
 */

/** 人間が書ける長さの上限。式そのものの妥当性は croner に見せて決める。 */
export const CRON_EXPRESSION_MAX = 120;

/** 受け付ける欄の数（分 時 日 月 曜）。秒つき（6欄）・年つき（7欄）は読めない式として扱う。 */
const CRON_FIELD_COUNT = 5;

export interface CronSchedule {
  /** `after` より後の最初の発火時刻。もう発火しない式なら null。 */
  nextAfter(after: Date): Date | null;
}

/**
 * 読めれば予定を返し、読めなければ null。
 *
 * **例外を投げない。** 呼び出し側（スキーマの検査・仕込みの組み立て）はどちらも
 * 「読めたかどうか」だけを知りたいので、try/catch を各所に散らさせない。
 */
export function parseCron(expression: string): CronSchedule | null {
  const trimmed = expression.trim();
  if (trimmed.length === 0 || trimmed.length > CRON_EXPRESSION_MAX) return null;

  // **5欄（分 時 日 月 曜）だけを読む。** croner は6欄を「先頭が秒」、7欄を「末尾が年」として
  // 受け付けるが、案内している形（例 `0 10 * * 1`）は5欄で、`*/5 * * * * *` を通すと
  // 秒の周期で起こす仕込みが入口をすり抜ける（#3387）。`@daily` のような別名も1欄なので読まない
  // （人間が書く形を5欄に閉じる）。
  if (trimmed.split(/\s+/).length !== CRON_FIELD_COUNT) return null;

  let job: Cron;
  try {
    // `paused` にしないと、この場でタイマーが動き出す（読むだけのつもりで走らせない）
    job = new Cron(trimmed, { paused: true });
  } catch {
    return null;
  }

  // 式として通っても「二度と来ない」ものがある（過去の年を指定した場合など）。
  // 仕込めてしまうと、時刻が来れば必ず届くという約束が静かに破れる。
  if (job.nextRun(new Date()) === null) return null;

  return {
    nextAfter(after) {
      return job.nextRun(after);
    },
  };
}

/** 読める cron 式か（スキーマの検査用）。 */
export function isCronExpression(expression: string): boolean {
  return parseCron(expression) !== null;
}
