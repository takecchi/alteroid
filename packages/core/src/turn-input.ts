import type { JournalEntryInput } from './schema.js';

/**
 * クローンのターンへ**何が入力されたか**を日誌の1行へ写す（Issue #243）。
 *
 * 日誌は「起きたこと」（応答・判断・記憶の更新・失敗）は持っていたが、
 * **そのターンが何を読んで動いたか**を持っていない経路が6本あった。とくに
 * `digest`（`digest.ts`）経由でマネージャーの `直近の報告:`（200字の抜粋）が
 * クローンのターンへ入るのに、日誌には1行も残らない。そのせいで
 * 「受け取ったと思っていた報告が、実際に出されていたか」が後から判定できない。
 *
 * ## 何を書くかは経路で分ける（この関数の中身そのもの）
 *
 * | 経路 | 書くもの | 理由 |
 * | --- | --- | --- |
 * | 人間の回答（`human_answer`） | **全文** | 入力そのものがそのターンにしか無い |
 * | `distill` / `timer` / `self_initiative` / `daily_report` | **形＋材料の id ＋ `chars=N`** | 中身は `digest` ＝**この日誌の既存の記録の寄せ集め**だから |
 *
 * **digest の全文を日誌へ書かないのは、日誌が自分自身を再帰的に太らせるからで
 * ある。** digest は日誌・台帳・承認待ちから組み直したもので、材料は必ず日誌の
 * 中に在る（マネージャーの `直近の報告:` も `manager.ts` が受信時に
 * `exchange with=manager role=inbound` として全文を書いている）。**だから形と
 * 材料の id と長さだけを残せば、そのターンへ何が入ったかは後から組み直せる。**
 * 逆に全文を写すと、次の digest がそれを含む日誌からまた作られる。
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
  '材料は同じ日誌の中に在る）';

/** 日誌の1行にする。**`ターンの入力:` で始める**（後から grep で全部拾えるように）。 */
function describeTurnInput(input: TurnInput): string {
  switch (input.type) {
    case 'distill':
      return (
        `ターンの入力: distill reason=${tag(input.reason)} ${size(input.prompt, 'prompt')}` +
        '（本文は `buildDistillPrompt` の定型文で、この発火ごとに変わるものは reason だけである）'
      );
    // **全文を写す。** 人間の回答は、そのターンへ入った形（質問・回答・宛先を
    // 1本にしたもの）としてはここにしか無い。回答そのものは承認待ちの器
    // （`approvals_list`）と `escalation` の行にも在るが、**どのターンへ何が
    // 入ったか**はそちらからは出てこない。
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
