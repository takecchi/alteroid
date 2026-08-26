import { fingerprintOf } from './credentials.js';
import type { JournalEntryInput } from './schema.js';

/**
 * クローンのターンへ**何が入力されたか**を日誌の1行へ写す（Issue #243）。
 *
 * 日誌は「起きたこと」（応答・判断・記憶の更新・失敗）は持っていたが、
 * **そのターンが何を読んで動いたか**を持っていない経路が7本あった。とくに
 * `digest`（`digest.ts`）経由でマネージャーの `直近の報告:`（200字の抜粋）が
 * クローンのターンへ入るのに、日誌には1行も残らない。そのせいで
 * 「受け取ったと思っていた報告が、実際に出されていたか」が後から判定できない。
 *
 * ## 何を書くかは経路で分ける（この関数の中身そのもの）
 *
 * | 経路 | 書くもの | 理由 |
 * | --- | --- | --- |
 * | 人間の回答（`human_answer`） | **全文** | 入力そのものがそのターンにしか無い |
 * | `distill` / `timer` / `self_initiative` / `daily_report` | **形＋材料の id ＋ `chars=N`** | 中身は `digest` ＝**既存の記録（日誌と台帳）の寄せ集め**だから |
 * | `pre_compact_distill`（PreCompact のサイドセッション、`#distillFromTranscript`） | **形＋`chars=N`＋指紋** | 材料は**会話の生ログの末尾**で、`digest` のように器から組み直せる寄せ集めではなく、任意の道具の出力を含みうる（#52 と同種の懸念）。全文も抜粋も採れないので、長さに加えて指紋を残す（決裁 2026-08-26） |
 *
 * **形と材料の id と長さだけを残せば、そのターンへ何が入ったかは後から組み直せる。**
 * digest は日誌・台帳・承認待ち・継続中の依頼・消費から組み直したもので、材料は
 * どれも器の側に在る（マネージャーの `直近の報告:` の元は、`manager.ts` が受信の
 * 瞬間に `exchange with=manager role=inbound` として書いた全文である）。
 *
 * ### ⚠️ 「日誌が自分自身を再帰的に太らせるから」ではない（引き直して確かめた）
 *
 * この doc は一度そう書いていたが、**その再帰は起きない。** `digest.ts` は
 * `journal.list` で全件を取るものの、`exchange` については
 * `with === 'human' && role === 'inbound'` に絞ったうえで**件数しか使っていない**
 * （`humanTurns.length`）。**`with: 'self'` の行は digest に本文でも件数でも
 * 入らない**ので、ここへ何を書いても次の digest はそれを読まない。日誌が自動で
 * プロンプトへ戻る他の口も無い（`tools.ts` の `journal_read` はクローンが明示的に
 * 呼ぶ道具、`schedule.ts` は `daily_report` 型だけ、`memory.ts` は
 * `memory_update` 型だけ、`apps/daemon/src/app.ts` の会話2口は `conversation.ts`
 * の `humanExchanges` が `with === 'human'` で落とす）。
 *
 * ### 成り立つ理由は2つ
 *
 * 1. **まるごと重複だから。** 上のとおり材料は器に在るので、写した分は二重に持つ
 *    だけである。量は 1 回あたり digest 1本ぶん（実測で 1,800 字前後）で、発意
 *    tick は既定 55 分ごと（`DEFAULT_INITIATIVE_EVERY_MINUTES`）、ほかに定期
 *    ジョブと日報がある。**再構成できるものを二重に持たない。**
 * 2. **外から来た文字列の写しを増やさないため。** digest の `直近の報告:` は
 *    マネージャーの報告＝**外の世界から拾ってきた任意の文字列**の抜粋である
 *    （テスト出力に `GH_TOKEN` が全文で出た前例がある。`railway/setup.test.ts`
 *    の差分アサーション、#52）。写しを増やすと、消す必要が出たときに消す先が増える。
 *
 * ### 理由にならなかった: 会話の走査窓（#243 当時）／いまは前提ごと変わった（#418）
 *
 * **この節はここに書いた時点（#243）では正しく、いまは前提が変わっている。**
 * 元の主張を消さずに残し、何が変わったかを追記する — 「腐った」のではなく
 * 「直った」ケースなので、書き換えるのではなくここに経緯を積む。
 *
 * **#243 当時の状態。** `GET /conversations` と `GET /conversations/:id` は
 * `journal.list` へ `{ limit: scan, types: ['exchange'] }` を渡し、＝**件数**で
 * 窓を切ってから `with === 'human'` に絞っていた（`app.ts`。`scan` の既定は
 * 2000）。だから
 * `with: 'self'` の行はこの窓を確かに食っていた — **が、食う量は行数で決まり、
 * 1行の長さには依らない。** そして行数はこの改修（#243）で増える側だったので、
 * 本文を形だけにしても1件も減らなかった。**この費用は、形にしたことで避けられた
 * のではなく、払うと決めたものだった。**
 *
 * **#418 で変わったこと。** `with: 'self'` / `with: 'manager'` の行が窓の予算を
 * 食い尽くし、人間との会話が窓の外へ落ちる欠陥そのものが直された
 * （`conversation.ts` の `readConversationWindow`。`with: ['human']` を
 * `limit` より前 ＝ ストアの `WHERE` 相当で効かせる）。**だからいまは
 * `with: 'self'` の行はこの窓をもう食わない。** ただし、これは上の段落の結論を
 * 覆さない — 上の段落が言っているのは「本文を短くしても、この窓の重さは
 * `with: 'self'` の行数がある限り変わらない」であって、#418 は行数を1件も
 * 減らさずに窓の重さそのものを直した（絞りの**順序**を直しただけである）。
 * つまり「本文を形だけにする理由として会話の走査窓を挙げるのは的外れである」
 * という結論は #418 の後もそのまま成り立つ——的外れになった理由が「費用が
 * 減らせないから」から「費用がそもそも別の場所（絞りの順序）で解消したから」
 * へ変わっただけである。
 *
 * ## 判断はここ1か所に閉じる
 *
 * `dropped-record.ts` の `inboxEventShape` と同じ作法である —「何を載せてよいか」
 * の判断を呼び出し側に散らすと、経路が増えたときに片方だけ全文を書く形が静かに
 * 混ざる。呼び出し側（`clone.ts` の6か所）は**この関数を呼ぶだけ**にする。
 *
 * **`dropped-record.ts` へ足さなかったのは、あちらが `stderr` へ出す跡であって
 * 「本文は出さない」を不変条件として持っているからである**（doc に逐語で書いて
 * ある。#52 の再発防止）。ここは**日誌**へ書く関数で、人間の回答の全文を載せる
 * ＝あちらの不変条件を破る。同じファイルに置くと、次に読む者にはどちらの規則が
 * 効いているのか判別できない。**規則が違うものを同じ場所に置かない。**
 *
 * ## 型は足さない
 *
 * 既存の `exchange`（`with: 'self'`）を使う。`journalEntrySchema` を広げると
 * `JOURNAL_ENTRY_TYPES` 経由で `openapi.json` ＝外向きの API 面が動く
 * （`dropped-record.ts` の `noteDroppedInboxEvent` の doc）。跡を残すためだけに
 * 外へ出す面を広げない。
 *
 * ## `role` は `'inbound'`
 *
 * `role` の意味は `conversation.ts` が決めている —「`inbound` = 人間の発言 /
 * `outbound` = クローンの返答」＝**クローンから見て入ってきた側か、出ていった側
 * か**である。ここで書くのは、そのターンへ**入ってきたもの**なので `inbound`。
 *
 * 既存の `with: 'self'` の行の多くが `outbound` なのは、それらが「クローンが
 * 自分に向けて書いた記録」（枠の解除を試す・見送った・記録できなかった）だから
 * であって、`self` が `outbound` と対になっているからではない。実際
 * `clone.ts` の `#deniedToolUses` の `onForget` は `self` / `inbound` で書いて
 * いる。
 *
 * **`with` は `'self'` のまま**（人間の回答であっても）。`with: 'human'` は
 * `GET /conversations/:id` が会話として返す側で（`clone.ts` の `#reportFailure`
 * の doc）、内部ターンの入力をそこへ混ぜると、人間の画面に会話として並ぶ。
 */
export type TurnInput =
  /**
   * 蒸留のターン（`buildDistillPrompt` の定型文だけ。digest は載らない）。
   *
   * **`reason` は合図が運んできた値をそのまま載せる。** `shutdown` と
   * `conversation_end` は同じ文面へ写る（`clone.ts` の `'distill'` 分岐）が、
   * **どちらで起きたかは日誌にしか残らない**（器の入れ替えで落ちたのか、会話が
   * 終わったのかは、後から見分けたい側である）。
   */
  | { type: 'distill'; reason: 'conversation_end' | 'shutdown'; prompt: string }
  /**
   * PreCompact のサイドセッション（`#distillFromTranscript`）が、要約に潰される
   * 直前の会話ログの末尾を渡して起こすターン（Issue #243 の7本目）。
   *
   * **上の `distill` とは材料の性質が違う。** あちらの本文は `buildDistillPrompt`
   * の定型文で、発火ごとに変わるのは `reason` だけだった。こちらの
   * `transcriptTail` は**会話の生ログの末尾**そのものであり、`digest` のように
   * 日誌・台帳・承認待ちから組み直した寄せ集めではない——任意の道具の出力を
   * 含みうる（`dropped-record.ts` が退けている #52 と同種の懸念）。
   *
   * **だから `chars=N` だけでは足りない。** `chars` が同じ2つの入力が同じ内容とは
   * 限らないので、内容が変わったこと自体を後から確かめる手段が要る。**全文も
   * 抜粋も採らず、長さに加えて指紋（`credentials.ts` の `fingerprintOf` と同じ
   * sha256 先頭12桁）を残す**（決裁 2026-08-26、Issue #243 のフォローアップ
   * コメント）。
   */
  | { type: 'pre_compact_distill'; transcriptTail: string }
  /** 人間が承認待ちへ答えた分を配ったターン。 */
  | { type: 'human_answer'; approvalId: string; text: string }
  /** 片付け済みの配り直しで、本文の代わりに断り書きだけを配ったターン。 */
  | { type: 'human_answer_closed'; approvalId: string; text: string }
  /** 日報以外の定期ジョブ（`buildTimerPrompt`）。 */
  | {
      type: 'timer';
      kind: string;
      cause: 'schedule' | 'manual';
      target?: string;
      /** 継続中の依頼の本文を渡したか（本文そのものは器＝`schedules` に在る）。 */
      request: boolean;
      digest: string;
    }
  /** 発意 tick（`buildSelfInitiativePrompt`）。 */
  | { type: 'self_initiative'; reason: string; digest: string }
  /** 日報（`buildDailyReportPrompt`）。 */
  | { type: 'daily_report'; date: string; digest: string };

/**
 * ターンの入力から、日誌へ追記する1件を作る。
 *
 * 呼び出し側は `#journal(turnInputEntry({...}))` と書くだけでよい
 * （`with` / `role` / 何を載せるかの判断は全部この中に在る）。
 */
export function turnInputEntry(input: TurnInput): JournalEntryInput {
  return { type: 'exchange', with: 'self', role: 'inbound', text: describeTurnInput(input) };
}

/**
 * 材料が digest である行に必ず付ける断り書き。
 *
 * **「短いから省いた」と読ませないための1文である。** これが無いと、後から読む
 * 者には「入力が短かった」のか「長い本文を写さなかった」のかが区別できず、
 * `chars=N` の意味も伝わらない。
 */
const DIGEST_NOTE =
  '（本文は digest ＝この日誌・台帳・承認待ちの記録を寄せ直したものなので、ここへは写さない。' +
  '材料はそれぞれの器に在る）';

/** 日誌の1行にする。**`ターンの入力:` で始める**（後から grep で全部拾えるように）。 */
function describeTurnInput(input: TurnInput): string {
  switch (input.type) {
    case 'distill':
      return (
        `ターンの入力: distill reason=${tag(input.reason)} ${size(input.prompt, 'prompt')}` +
        '（本文は `buildDistillPrompt` の定型文で、この発火ごとに変わるものは reason だけである）'
      );
    // **`digest` の4本とは違い、`chars=N` だけでなく指紋も残す。** 材料が会話の
    // 生ログの末尾で、器から組み直せる寄せ集めではないため（`TurnInput` の doc）。
    case 'pre_compact_distill':
      return (
        `ターンの入力: pre_compact_distill ${size(input.transcriptTail, 'tail')} ` +
        `tail.fp=${fingerprintOf(input.transcriptTail)}` +
        '（本文は要約直前の会話ログの末尾で、任意の道具の出力を含みうる。' +
        '全文も抜粋も載せず、長さと指紋だけを残す）'
      );
    // **全文を写す。** 人間の回答は、そのターンへ入った形（質問・回答・宛先を
    // 1本にしたもの）としてはここにしか無い。回答そのものは承認待ちの器
    // （`approvals_list`）と `escalation` の行にも在るが、**どのターンへ何が
    // 入ったか**はそちらからは出てこない — `Clone#answerApproval` が書く
    // `escalation` は `question` / `approvalId` / `answeredAt` / `answer` の4つ
    // だけで、**宛先（`managerId` / `requestId`）も `[system]` の前置きも入らない。
    // `at` も受理の瞬間であって、この合図が配られてターンが回った時刻ではない**
    // （配り直しなら器の入れ替えを跨いで離れる）。
    case 'human_answer':
      return (
        `ターンの入力: human_answer approvalId=${tag(input.approvalId)}` +
        `（質問と人間の回答の全文。回答そのものは \`approvals_list\` でも取れる）\n\n${input.text}`
      );
    // 断り書きは `clone.ts` がその場で組み立てた文字列で、どこにも保存されない。
    // だから全文を写す（`human_answer` と同じ理由）。
    case 'human_answer_closed':
      return (
        `ターンの入力: human_answer approvalId=${tag(input.approvalId)}` +
        `（片付け済みの配り直し。回答の全文は配らず、断り書きだけを配った）\n\n${input.text}`
      );
    // `kind` は `scheduleKindSchema` の値、`cause` と `target` は起こした側が
    // 決めて運んでくる値なので載せる（`inboxEventShape` の `timer` と同じ判断）。
    // 依頼の本文（`request`）は器に在るので、渡したかどうかだけにする。
    case 'timer':
      return (
        `ターンの入力: timer kind=${tag(input.kind)} cause=${tag(input.cause)}` +
        (input.target === undefined ? '' : ` target=${tag(input.target)}`) +
        ` request=${input.request ? 'yes' : 'no'} ${size(input.digest, 'digest')}${DIGEST_NOTE}`
      );
    case 'self_initiative':
      return (
        `ターンの入力: self_initiative reason=${tag(input.reason)} ` +
        `${size(input.digest, 'digest')}${DIGEST_NOTE}`
      );
    case 'daily_report':
      return (
        `ターンの入力: daily_report date=${tag(input.date)} ` +
        `${size(input.digest, 'digest')}${DIGEST_NOTE}`
      );
  }
}

/**
 * id・列挙値を1行に収める上限。
 *
 * `dropped-record.ts` の `TAG_LIMIT` と同じ値だが、**あちらは stderr の1行に
 * 収めるための上限**で、こちらは日誌の見出しが本文に化けないための上限である
 * （切る理由が違うので、共有せず同じ値を置く）。
 */
const TAG_LIMIT = 64;

/** 列挙値・id を1行に収める（改行を持ち込ませない）。 */
function tag(value: string): string {
  const flat = value.replaceAll(/\s+/gu, ' ');
  return flat.length > TAG_LIMIT ? `${flat.slice(0, TAG_LIMIT)}…` : flat;
}

/** 写さない本文の長さだけを出す（`chars=0` と「書き損ねた」を区別できるように）。 */
function size(text: string, name: string): string {
  return `${name}.chars=${text.length}`;
}
