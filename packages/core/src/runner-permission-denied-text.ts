import {
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH,
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE,
} from './classifier-denial-streak.js';
import { clipWithEllipsis } from './excerpt.js';

/** `ClassifierDenialStreaks.view` の戻り（その型は非公開なので、読む欄だけ同じ形で受ける）。 */
export interface DenialStreakViewLike {
  readonly consecutive: number;
  readonly total: number;
  readonly firstReason: string | undefined;
}

/** `#onPermissionDenied` の note #1（連続拒否）。`view` は `#denialStreaks.view(streakActor)` の結果。 */
export function buildDenialStreakNote(
  actor: string,
  streakActor: string,
  view: DenialStreakViewLike | undefined,
): string {
  return (
    `分類器の拒否が ${actor} で続けて ${String(view?.consecutive ?? 0)} 回になった（累計 ${String(view?.total ?? 0)} 回。runner の数え）。` +
    'CLI はこの後、分類器が止めた操作を確認へ回すので、ふだんは通る操作の確認も上がりうる。' +
    `${streakActor === 'manager' ? '担当' : 'この作業者'}には、次に道具が通ったとき、その事情と取れる道（クローンに確かめてもらう・新しい作業者へ渡す・区切りで報告して後継を起こしてもらう）を添える。` +
    `最初に引っかかった理由: ${view?.firstReason ?? '(取れなかった)'}`
  );
}

// `tool_input` を載せない（理由は先頭だけ）
/** note #2（フックが届いた入口）。 */
export function buildDenialEntryNote(
  actor: string,
  toolName: string | undefined,
  toolUseId: string | undefined,
  reason: string | undefined,
): string {
  const flat = (reason ?? '').replace(/\s+/g, ' ').trim();
  return (
    `分類器の拒否のフックが届いた（${actor}・${toolName ?? '道具名なし'}・` +
    `tool_use_id=${toolUseId ?? '無し'}）。理由の先頭: ` +
    `${flat === '' ? '(無し)' : clipWithEllipsis(flat, 80)}（issue #1766）`
  );
}

/** note #3（道具名なし）。 */
export function buildDenialNoToolNameNote(actor: string): string {
  return (
    `分類器の拒否（${actor}）が道具名を持たない合図で届いたので、クローンへは確認を上げず、` +
    `1回だけの許可も出さない（issue #1105 P1）。`
  );
}

/** note #4（入力が1回だけの許可の鍵へ畳めない）。 */
export function buildDenialNoMatchKeyNote(actor: string, toolName: string): string {
  return (
    `分類器が ${actor} の ${toolName} 呼び出しを拒否したが、入力を1回だけの許可の鍵へ畳め` +
    `なかったため、クローンへは確認を上げず1回だけの許可も出さない（issue #1105 P1）。`
  );
}

/** note #5（allow を返した撃ち直しの再拒否）。 */
export function buildDenialAllowedButDeniedNote(actor: string, toolName: string): string {
  return (
    `分類器が ${actor} の ${toolName} 呼び出しを、allow を返した撃ち直しのあとでも再び止めた。` +
    `同じ呼び出しの確認は重ねて上げない（allow しても通らなかった。人間が止められた中身を見て` +
    `誤検知だと確かめるまで、同じ入力は通らないことがある。#4904）。`
  );
}

/** クローンへ上げる確認の `summary`。`ruleable` は一時規則を足せる Bash の回か。 */
export function buildDenialAskSummary(
  streakNote: string | null,
  actor: string,
  toolName: string,
  ruleable: boolean,
  reason: string | undefined,
  inputHead: string | undefined,
): string {
  return (
    (streakNote === null ? '' : `${streakNote}\n\n`) +
    // 段落を空行で分ける（#4943）: 変わる値の行・固定の長い段落・変わる値（理由・入力の先頭）の行を別の段落にし、クローンの入力で固定の段落だけを同じ会話の2回目から参照にできるようにする
    `分類器が ${actor} の ${toolName} 呼び出しを拒否した。この1回だけ許可しますか。\n\n` +
    `${ruleable ? DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE : DENIAL_ASK_AFTER_ANSWER_PARAGRAPH}\n\n` +
    `理由: ${reason ?? '(無し)'}\n` +
    `入力の先頭（伏せ字・最大160字。issue #1105 P0）: ${inputHead ?? '(取れなかった)'}`
  );
}

/** note #6（フックの持ち時間切れ）。 */
export function buildDenialTimedOutNote(actor: string, toolName: string): string {
  return (
    `分類器の拒否（${actor}・${toolName}）への1回だけの許可の確認が、フックの持ち時間切れで` +
    `終わった。安全側で retry は返さない。答えが遅れて届いても、この確認は既に解決済みなので` +
    `反映しない（issue #1105 P1）。`
  );
}

/** note #7（クローンが deny）。 */
export function buildDenialDeniedByCloneNote(
  actor: string,
  toolName: string,
  message: string,
): string {
  return `クローンが分類器の拒否（${actor}・${toolName}）への1回だけの許可を出さなかった: ${message}`;
}

/** note #8（クローンが allow）。`ruleAdded` で一時規則を足せたかの2種の文面。 */
export function buildDenialAllowedByCloneNote(
  actor: string,
  toolName: string,
  ttlMinutes: number,
  ruleAdded: boolean,
): string {
  return (
    `クローンが分類器の拒否（${actor}・${toolName}）を1回だけ許可した。同じ入力で撃ち直された` +
    `ときにだけ、${ttlMinutes}分以内なら1回通す（issue #1105 P1）。` +
    `撃ち直すかどうかは担い手のモデルが決めることで、retry は「もう一度試してよい」という助言でしかない` +
    `（撃ち直しが来なければ、この許可は使われないまま期限が切れる）。` +
    (ruleAdded
      ? `同じ入力の1回だけを${ttlMinutes}分通す一時規則をこのセッションに足した` +
        `（そのセッションの他の作業者にも効く。#4905）。撃ち直すなら入力を1字も変えないこと。` +
        `それでも拒否されたら、別の手（入力を変える・手順を分ける・人間に頼む）を取ること。`
      : `同じ入力で撃ち直しても、分類器にまた止められうる（迂回・敵対の型で止めた呼び出しは、` +
        `クローンの allow や担当の伝言を人間の確認と見なさない）。続けて同じ入力を撃たず、` +
        `別の手（入力を変える・手順を分ける・人間に頼む）を取ること（#4904）。`) +
    `担い手へ manager_send で伝えるときも、この趣旨で書く。これで通るかは確かめていない。`
  );
}
