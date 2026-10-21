/**
 * 分類器（auto mode）の拒否が続いた担当を見分け、クローンへの確認と担当への知らせに事情を添える（2026-10-12 の WORLDBUILD-2・LAND-7）。
 *
 * CLI（SDK 0.3.296 に同梱）は、分類器の拒否をセッションごとに数え、**連続3回・累計20回**に達すると「Classifier denial limit exceeded,
 * falling back to prompting」として、以後の分類器の拒否を確認（`canUseTool`）へ倒す。連続の数えは分類器が許可すると0に戻る。
 * 作業者（Task）は自分の数えを新しく持つ。runner からは CLI の内部の数えを読めないので、ここで同じ形を数え直す（**一致は保証しない**）。
 *
 * **分類器の判定には触れない。** 確認を通りやすくすることも、分類器へ同意を伝えることもしない。事情を知らせるだけである。
 */

/** CLI の上限（SDK 0.3.296 の `{maxConsecutive:3,maxTotal:20}`）。SDK を上げたら確かめ直す。 */
export const CLI_CLASSIFIER_DENIAL_LIMITS = { consecutive: 3, total: 20 } as const;

/**
 * 分類器の拒否の確認（runner の `#onPermissionDenied`）の、alteroid が組んだ固定の1段落（#4943）。変わる値を1つも含まない。
 * 前後は空行で区切る: クローンの入力の段落の単位（空行）で、同じ会話の2回目から短い参照にできるように（`DigestSessionDelta#foldParagraphs`）。
 * こちらは一時規則を足せない呼び出し（Bash 以外・規則にできない command・口を持たない provider）の段落。足せるときは `DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE`。
 */
export const DENIAL_ASK_AFTER_ANSWER_PARAGRAPH =
  `答えたあと: allow しても、この呼び出しは自動では撃ち直されない。` +
  `allow は「同じ入力での撃ち直しを、10分以内に1回だけ通そうとする」許可で、撃ち直すかは担い手が決める` +
  `（拒否文が再試行を禁じていると撃ち直されないことがある）。` +
  `分類器が迂回・敵対の型で止めた場合は、allow しても撃ち直しは通らないことがある` +
  `（分類器は、クローンの allow や担当からの伝言を人間の確認と見なさない）。` +
  `通すには、人間が止められた中身を見て誤検知だと確かめる必要がある。` +
  `allow の後は、担当・作業者へ「同じ入力で撃ち直しても、分類器にまた止められうる。` +
  `続けて同じ入力を撃たず、別の手（入力を変える・手順を分ける・人間に頼む）を取ること」と伝える（#4904）。` +
  `この許可で通るかは確かめていない。同じ呼び出しがそれでも拒否されても、確認は重ねて上げない。`;

/**
 * 同じ確認の、一時規則を足せる Bash 呼び出し用の固定の1段落（#4905）。変わる値を1つも含まない。
 * `DENIAL_ASK_AFTER_ANSWER_PARAGRAPH` と1本にまとめない: 1字一致で畳む単位（#4943）なので、呼び出しで分岐する文を混ぜると畳めなくなるため。
 */
export const DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE =
  `答えたあと: allow しても、この呼び出しは自動では撃ち直されない。撃ち直すかは担い手が決める` +
  `（拒否文が再試行を禁じていると撃ち直されないことがある）。` +
  `allow すると、同じ入力の1回だけを10分通す一時規則がこのセッションに足される` +
  `（そのセッションの他の作業者にも効く。#4905）。` +
  `allow の後は、担当・作業者へ「撃ち直すなら入力を1字も変えないこと。それでも拒否されたら、` +
  `別の手（入力を変える・手順を分ける・人間に頼む）を取ること」と伝える。` +
  `この規則で分類器を通れるかは実機では確かめていない。同じ呼び出しがそれでも拒否されても、確認は重ねて上げない。`;

/** 同じ相手へ担当向けの知らせを出し直すまでの間隔。拒否が続く間、道具を使うたびに同じ段落が積まれないため。 */
export const DENIAL_STREAK_NOTICE_INTERVAL_MS = 30 * 60_000;

const REASON_HEAD = 120;

interface StreakState {
  consecutive: number;
  total: number;
  /** いまの連続が始まった拒否の理由（先頭だけ）。 */
  firstReason: string | undefined;
  /** 担当へ知らせる段落を、次の道具の結果に添える。上限に達した時点の数を写して持つ（後で連続が0に戻っても、知らせの数は変わらない）。 */
  owedNotice: DenialStreakView | undefined;
  lastNoticeAt: number | undefined;
}

export interface DenialStreakView {
  readonly consecutive: number;
  readonly total: number;
  readonly firstReason: string | undefined;
}

/** runner が `/managers` で名乗る1件（`runnerManagerStateSchema.classifierDenials`）。`actor` は `'manager'` か作業者の agent id。 */
export interface ClassifierDenialOverLimit {
  readonly actor: string;
  readonly consecutive: number;
  readonly total: number;
  readonly firstReason?: string;
}

/**
 * `manager_list` の1行。越えている相手が居ない・欄を名乗らない古い runner のときは `null`（行を出さない）。
 * 行が無いことを「越えていない」と言い切らない: 古い runner では数えていない。
 */
export function describeDenialStreakForList(
  entries: readonly ClassifierDenialOverLimit[] | undefined,
): string | null {
  if (entries === undefined || entries.length === 0) return null;
  const parts = entries.map((entry) => {
    const who = entry.actor === 'manager' ? '担当本人' : `作業者 ${entry.actor}`;
    return (
      `${who} 連続 ${String(entry.consecutive)}・累計 ${String(entry.total)}` +
      (entry.firstReason === undefined ? '' : `（最初の理由: ${entry.firstReason}）`)
    );
  });
  return (
    `  ⚠ 分類器（auto mode）の拒否が上限（連続${String(CLI_CLASSIFIER_DENIAL_LIMITS.consecutive)}・累計${String(CLI_CLASSIFIER_DENIAL_LIMITS.total)}）を越えている: ${parts.join(' / ')}。` +
    'この後は、ふだん通る操作の確認も1件ずつ上がりうる。担当には、作業者へ渡す・区切りで報告して止まる道を知らせてある。' +
    '確認が積み上がる前に、後継の担当へ切り替えるかを考えること（runner の数え。CLI の内部の数えとは一致しないことがある）'
  );
}

function reasonHead(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const chars = Array.from(reason.replace(/\s+/g, ' ').trim());
  if (chars.length === 0) return undefined;
  return chars.length > REASON_HEAD ? `${chars.slice(0, REASON_HEAD).join('')}…` : chars.join('');
}

export function overDenialLimit(view: DenialStreakView): boolean {
  return (
    view.consecutive >= CLI_CLASSIFIER_DENIAL_LIMITS.consecutive ||
    view.total >= CLI_CLASSIFIER_DENIAL_LIMITS.total
  );
}

/** 相手は担当本人なら `'manager'`、作業者なら agent id。 */
export class ClassifierDenialStreaks {
  readonly #byActor = new Map<string, StreakState>();

  /** 分類器の拒否を1回数える。連続が上限にちょうど達した回は `true`（日誌へ1行残す契機）。 */
  noteDenial(actor: string, reason: string | undefined): boolean {
    const state = this.#byActor.get(actor) ?? {
      consecutive: 0,
      total: 0,
      firstReason: undefined,
      owedNotice: undefined,
      lastNoticeAt: undefined,
    };
    if (state.consecutive === 0) state.firstReason = reasonHead(reason);
    state.consecutive += 1;
    state.total += 1;
    this.#byActor.set(actor, state);
    const crossed = state.consecutive === CLI_CLASSIFIER_DENIAL_LIMITS.consecutive;
    if (crossed) {
      state.owedNotice = {
        consecutive: state.consecutive,
        total: state.total,
        firstReason: state.firstReason,
      };
    }
    return crossed;
  }

  /** 道具が通った。連続を0に戻す（累計は残す）。 */
  noteProgress(actor: string): void {
    const state = this.#byActor.get(actor);
    if (state === undefined) return;
    state.consecutive = 0;
  }

  view(actor: string): DenialStreakView | undefined {
    const state = this.#byActor.get(actor);
    if (state === undefined) return undefined;
    return { consecutive: state.consecutive, total: state.total, firstReason: state.firstReason };
  }

  /** 上限を越えている相手だけを返す（担当本人を先に）。空配列は「数えたが、越えている相手は居ない」。 */
  overLimit(): ClassifierDenialOverLimit[] {
    const entries: ClassifierDenialOverLimit[] = [];
    for (const [actor, state] of this.#byActor) {
      const view = {
        consecutive: state.consecutive,
        total: state.total,
        firstReason: state.firstReason,
      };
      if (!overDenialLimit(view)) continue;
      entries.push({
        actor,
        consecutive: view.consecutive,
        total: view.total,
        ...(view.firstReason === undefined ? {} : { firstReason: view.firstReason }),
      });
    }
    return entries.sort((a, b) => Number(b.actor === 'manager') - Number(a.actor === 'manager'));
  }

  /**
   * 担当へ添える段落を取り出す（取り出したら借りは消える）。間隔の内側なら出さずに借りも消す: 拒否が続く間に同じ段落を何度も積まないため。
   */
  takeNotice(actor: string, nowMs: number): string | null {
    const state = this.#byActor.get(actor);
    const owed = state?.owedNotice;
    if (state === undefined || owed === undefined) return null;
    state.owedNotice = undefined;
    if (
      state.lastNoticeAt !== undefined &&
      nowMs - state.lastNoticeAt < DENIAL_STREAK_NOTICE_INTERVAL_MS
    ) {
      return null;
    }
    state.lastNoticeAt = nowMs;
    return describeDenialStreakForManager(owed);
  }
}

/** クローンへの確認の頭に付ける1段落。上限を越えていなければ `null`。 */
export function describeDenialStreakForClone(
  actor: string,
  view: DenialStreakView | undefined,
): string | null {
  if (view === undefined || !overDenialLimit(view)) return null;
  const who = actor === 'manager' ? '担当本人' : `作業者 ${actor} `;
  return (
    `⚠ この${who}は、分類器（auto mode）の拒否が連続 ${String(view.consecutive)} 回・累計 ${String(view.total)} 回続いている（runner の数え。CLI の内部の数えとは一致しないことがある）。` +
    `CLI は連続${String(CLI_CLASSIFIER_DENIAL_LIMITS.consecutive)}回・累計${String(CLI_CLASSIFIER_DENIAL_LIMITS.total)}回で、分類器が止めた操作を確認へ回す。` +
    '分類器は会話の文脈全体を見て判断するので、この後の確認には、ふだんは通る操作（読む・整形・push）も混ざりうる。' +
    `いまの連続の最初に引っかかった理由: ${view.firstReason ?? '(取れなかった)'}`
  );
}

export function describeDenialStreakForManager(view: DenialStreakView): string {
  return [
    `⚠ alteroid からの知らせ: このセッションで、auto mode の分類器があなたの操作を続けて ${String(view.consecutive)} 回止めた（累計 ${String(view.total)} 回）。` +
      `いまの連続の最初に引っかかった理由: ${view.firstReason ?? '(取れなかった)'}`,
    '分類器は、この会話の文脈全体を見て判断している。引っかかった型が会話に残っている間は、ふだんは通る操作（読む・整形・push）まで止められやすい。' +
      `CLI は連続${String(CLI_CLASSIFIER_DENIAL_LIMITS.consecutive)}回・累計${String(CLI_CLASSIFIER_DENIAL_LIMITS.total)}回で、止めた操作をクローンへの確認に回すので、確認が1件ずつ積み上がる。`,
    '次のどれかを考えること（どれを選ぶかはあなたが決める）:',
    '1. 引っかかった操作そのものは、何をなぜするのか・止められた理由が当たらないと考える根拠を報告に書き、クローンに確かめてもらう。',
    '2. 残りのふつうの作業（読む・整形・テスト・push）は、新しい作業者に、何をなぜするかを書いて渡す。引っかかった操作そのものは作業者へ回さない。',
    '3. 区切りが付いたら報告して止まり、クローンに後継の担当を起こしてもらう（未 push の作業を残さない。後継へ渡すことを報告に書く）。',
    '言い換え・別の道具・別の手段で、止められた操作を回り込んで通そうとしないこと。',
    // 回り込みの禁止と取り違えさせない: 道具へ寄せるのは巻き添えになった読むだけの照会で、止められた操作ではないため（#5138）
    'ただし、巻き添えになりやすい読むだけの確認（ファイルを読む・語を探す・ファイルを探す）は、Bash ではなく `Read`・`Grep`・`Glob` の道具で行うこと。これは止められた操作の回り込みではない。',
  ].join('\n');
}
