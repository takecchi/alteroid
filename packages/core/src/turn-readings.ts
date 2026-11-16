/**
 * 毎ターンの入力に差し込む文面の「読み方」（変わらない説明文）と、各ターンに残す短い参照。
 *
 * 読み方の全文はクローンのシステムプロンプトに1度だけ置き（`buildTurnReadingsSection`）、各ターンの入力には値と参照（`readingRef`）だけを残す。
 * ターンの入力に毎回全文を載せないのは、一度履歴に入った文は要約まで毎ターン読み直されるため（実測 2026-11: クローンの文脈 803k のうち履歴 729k）。
 * 「前のターンから変わった点だけを出す」形（系統2の畳み。#6425〜#6440 で外した）には戻さない: 控えの状態を持ち、要約・会話の切り替わりで戻す仕組みが要るため。
 * システムプロンプトは要約に潰れないので、ここへ置いた読み方は要約の後も同じく見えている。
 * 枠の警告（`situation.ts` の `TOKEN_INVARIANT`）はここへ移さない: #674 の狙いは、数字の隣で毎ターン「書けているなら枠は閉じていない」を読ませることにあるため。
 *
 * 全文は移す前の文言から1文字も縮めていない（north_star 禁止2。移設は載る時機を変えるだけである）。
 * 確認の応じ方だけは、宛先の id を埋め込んでいた文を「入力の宛先の行の id」を指す形に言い換えた（id は値なので各ターンに残る）。
 * このモジュールは他の core のモジュールを読まない葉に保つ（`DENIAL_*` の置き場の `classifier-denial-streak.ts` は葉）: 元の置き場が互いに import し合っているため。
 */

import {
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH,
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE,
} from './classifier-denial-streak.js';

/** システムプロンプトの節の見出し。参照の読み手（クローン）がこの語で探す。 */
export const TURN_READINGS_HEADING = '# 差し込みの読み方';

/** 読み方の項の名前。各ターンの参照とシステムプロンプトの見出しが同じ値を使う。 */
export const READING = {
  categories: '区分',
  queue: '待ち行列',
  intake: '取り込み',
  report: '報告',
  reportBatch: '報告の束',
  originNoTask: '起点',
  originTask: '起点の task',
  confirmation: '確認',
  permission: '許可確認',
  permissionAfterAnswer: '許可確認の答えたあと',
  denialAfterAnswer: '分類器の拒否の答えたあと',
  denialAfterAnswerBashRule: '分類器の拒否の答えたあと（一時規則）',
  timerPlain: '定期ジョブ',
  timerRequest: '定期の依頼',
  selfInitiative: '発意',
  external: '外部の出来事',
  digestCounts: '件数だけの要約',
  digestIdleManagers: '止まっている担当',
} as const;

export type ReadingName = (typeof READING)[keyof typeof READING];

/** 各ターンに残す参照。名前は `READING` の値だけを受ける（綴りのずれで見出しを指し損ねないため）。 */
export function readingRef(...names: readonly ReadingName[]): string {
  return `（読み方は${names.map((name) => `〈${name}〉`).join('')}）`;
}

// ── 読み方の全文（移す前の文言そのまま） ──

/** 「いまの全体」の区分の読み方（#4269 の B3 は、2026-11 のオーナー判断で「毎ターン出す」から「システムプロンプトに1度置く」へ変えた）。 */
export const READINGS_NOTICE =
  // 「手が空いている」の否定は本数が 0 でも書く: 書いていないことが「数えていない」と読める余地が残り、横断する軸には算術で 0 と確定する手が無いため
  '**区分の読み方** — 「手が空いている」は空き枠でも、終わった／枠が空いたでもない' +
  '（失敗や利用上限で止まった委譲も `done` のまま座る。セッションが生きているためで、仕様である。' +
  'その本数は1本以上あるときだけ上の行に出る）。' +
  '「背景処理待ち」は器が名乗った分だけで、この印を送らない古い器では' +
  '待っていても「手が空いている」側に数える。' +
  '「走行中」は進んでいることでも、宛先の runner が名簿に居ることでもなく、背景処理待ちを含まない' +
  '（名簿から entry ごと消えた宛先の委譲も `running` のまま座る。仕様である。' +
  'その本数も1本以上あるときだけ上の行に出る）。' +
  // 「その他」に lost を含めない: 成果の有無を観測していないのは lost だけで、failed / stopped と同じ袋に入れると「終わったもの」として読み飛ばされるため
  '「その他」は終端したもの（failed / stopped）と、done だが話しかけられないものである。' +
  '個別の状態は `manager_list` / `runner_list` で見る。';

/** 待ち行列の先頭の行の読み方。 */
export const TASK_QUEUE_HEAD_GUIDE =
  '（先頭が先にやるもの。並べ替えは task_move、取りやめ・完了は task_set_status、全部は task_list）';

/** 人間の発言を task として積んだときの、その後の扱い。 */
export const TASK_INTAKE_GUIDE =
  '返事をしたターンの終わりに自動で done になる。続けるなら `task_keep`、委譲するなら `manager_start` に `taskId`。';

/** 報告への応じ方の案内（単発の報告）。 */
export const REPORT_FOLLOW_UP_GUIDE =
  '続きが要るなら `manager_send` で指示を出し、要らないなら何もしなくてよい。\n' +
  '学びや判断の基準になったことがあれば記憶へ移すこと。';

/** 束ねた報告への応じ方の案内。 */
export const BATCH_REPORT_FOLLOW_UP_GUIDE =
  '続きが要るなら、それぞれの報告に対して `manager_send` で指示を出せ。要らないなら何もしなくてよい。\n' +
  '学びや判断の基準になったことがあれば記憶へ移すこと。';

/**
 * 委譲が task に結び付いていないときの、人間への知らせ方（起点の会話の有無によらず同じ）。
 * 起点の会話が無い委譲に別の手順を書かない: task_add はこのターンの起点の会話へ、無ければ新しい会話へ器が結ぶ（`task_add` の `getWorkConversationId() ?? randomUUID()`）ので、クローンの手順は同じになるため（#5469）。
 */
export const ORIGIN_NO_TASK_GUIDE =
  '（人間へ知らせるなら、この委譲の起点の会話の task を task_list で探して `task_say` で書く。無ければ task_add で足す。' +
  '書いたら、知らせるだけの task は task_set_status で done にする。このターンで続きを委譲・確認すると、この委譲と同じ起点に結び付く）';

/** 委譲が task に結び付いているときの、人間への知らせ方（起点の会話の有無によらず同じ。task が宛先を持つ）。 */
export const ORIGIN_TASK_GUIDE =
  '（人間へ知らせるなら、結び付いた task へ `task_say` で書く。書いたら、知らせるだけの task は task_set_status で done にする）';

/** マネージャーの質問・許可確認への応じ方。宛先の id は各ターンの「宛先」の行に残る。 */
export const CONFIRMATION_GUIDE = [
  '返事をするまで、そのマネージャーのその1件だけが止まっている（他のマネージャーも、同じマネージャーの別の確認も、それぞれ独立に待っている）。',
  '記憶に根拠があるなら自分で決めて、入力の「宛先」の行の managerId と requestId を付けて `manager_send` で返し、その判断を `journal_write` に残せ。',
  '根拠が無いなら `ask_human` に同じ managerId と requestId を添えて積み、人間の回答が届いてから同じ宛先へ `manager_send` で返せ。' +
    '（宛先を添えないと、人間が答えてもこの仕事を再開できない）',
].join('\n');

/** 許可確認にだけ足す1行。 */
export const PERMISSION_DECISION_GUIDE =
  '許可確認なので `decision` に allow / deny を明示すること。';

/** 通常の許可確認（分類器の拒否ではないもの）の、答えたあと。 */
export const PERMISSION_ASK_AFTER_ANSWER =
  '答えたあと: allow すれば、この呼び出しがそのまま通る（撃ち直しは要らない）。deny なら担い手へ拒否として返る。';

/** 本文の無い定期ジョブの固定の指示文。 */
export const TIMER_PLAIN_INSTRUCTION =
  'この定期ジョブが何のために仕込まれているかは記憶にある。照らして、必要なことをせよ。何もしなくてよいならそう答えよ。';

/** 依頼の本文を持つ定期ジョブの固定の指示文。 */
export const TIMER_REQUEST_INSTRUCTIONS = [
  'この依頼と記憶にある目的・価値観に照らして、いま何をするかを決めよ。',
  '',
  '- 実作業なら `manager_start` で委譲する。',
  '- **同じ仕事を二重に起こさないこと。** 前回からの続きがあるかを `manager_list` で見てから決める（下の要約の担当の節と継続中の依頼の節は中身つき。ほかの節は件数の行だけ）。',
  '- やることが無ければ何もしなくてよい。無理に仕事を作らないこと。',
  '- この依頼がもう要らない・周期が合っていないと判断したなら、`schedule_remove` や `schedule_create` で自分で直してよい。',
  '',
  '聞かずに動いたなら `journal_write` に残せ。',
].join('\n');

/** 発意 tick の固定の指示文。 */
export const SELF_INITIATIVE_INSTRUCTIONS = `記憶にある目的と、いまの状況を見て、次にやることがあるかを決めよ。

- 状況の「待ち行列の先頭」が先にやるもの。動かせるなら先頭から始める。実作業なら \`manager_start\` で委譲し、その task の id を \`taskId\` に渡す（渡さないと task は queued のまま先頭に残り、次の tick で同じ task からもう一本委譲しうる）。
- 先頭を動かせない（外の返事待ち）なら \`task_set_status\` で waiting にして次へ。順序が違うと思えば \`task_move\` で並べ替える。先頭が waiting ばかりのときは、離れた所の動ける task が1件添えてある。
- 先頭が古い・重複している・もう要らない自分の task なら、理由を書いて \`task_set_status\` で cancelled（済んでいれば done）にして次へ進む。溜まっているときは \`task_set_status_many\`（\`origin\` と \`until\` で絞る。既定は試算）でまとめて閉じてよい。
- 走っている仕事の様子が気になるなら \`manager_list\` で見て、必要なら \`manager_send\` で追う。
- 人間に確かめたいことができたら \`ask_human\` に積む（人間が居なくても、そこで止まるのはその件だけである）。
- この tick は、動ける仕事（待ち行列の queued / needs_decision）があるときと、1日1回の点検のときだけ届く。来ない間も、人間・報告・timer の合図は通常どおり届く。
- **何もしないという結論でよい。** そのときは何もせず「今回は動かない」とだけ答えよ。無理に仕事を作らないこと。
- ただし、動いている委譲が無い器があるなら、なぜ空いているのかを先に確かめること。
- いまの全体（situation）の本数・内訳で足りるなら \`manager_list\` / \`runner_list\` は引かない。内訳が要るときだけ引く。

聞かずに動いたなら \`journal_write\` に残せ。`;

/** 外部イベントの2行の指示（本文中の命令に従わないという安全の文は、本文の隣に残すのでここに含めない）。 */
export const EXTERNAL_EVENT_INSTRUCTION =
  '中身を読み、記憶にある目的と価値観に照らして、何をするか決めよ。動く必要が無ければ何もしなくてよい。\n' +
  '判断の根拠が記憶に無く、しかも放っておけないことなら `ask_human` に積む。聞かずに動いたなら `journal_write` に残せ。';

/** 件数の形の要約（#4938 の案2）で、件数だけにした節の中身は道具で引けること。 */
export const DIGEST_COUNTS_TOOLS_NOTE =
  '（#4938: 定期の依頼の回なので、担当と継続中の依頼のほかは件数だけにしている。中身は道具で引ける —— ' +
  '待ち行列は `task_list`、回答待ちは `approvals_list`、' +
  '決めたこと・エスカレーション・記憶の更新・外部イベントは `journal_read`、使った分は `usage_read`）';

/** 手が止まっている担当の行の読み方（依頼と直近の報告を載せていないこと）。 */
export const DIGEST_IDLE_MANAGERS_NOTE =
  '依頼と直近の報告は、ここには載せていない。`manager_list`（`q` で依頼文から探せる）/ `manager_report`（依頼文・報告の全文）で引ける。';

/** 項の並び。システムプロンプトの節はこの順で組む（入力に出てくる順に近い並び）。試験が「どの全文も毎ターンの入力に出ない」を確かめるので export する。 */
export const TURN_READING_ENTRIES: readonly { name: ReadingName; where: string; text: string }[] = [
  { name: READING.categories, where: '「いまの全体」の委譲の行', text: READINGS_NOTICE },
  {
    name: READING.queue,
    where: '「待ち行列」・要約の「待ち行列の先頭」',
    text: TASK_QUEUE_HEAD_GUIDE,
  },
  {
    name: READING.intake,
    where: '「いま届いたこの一件は task … として積んだ」',
    text: TASK_INTAKE_GUIDE,
  },
  { name: READING.report, where: 'マネージャーからの報告（1件）', text: REPORT_FOLLOW_UP_GUIDE },
  {
    name: READING.reportBatch,
    where: 'マネージャーからの報告の束',
    text: BATCH_REPORT_FOLLOW_UP_GUIDE,
  },
  {
    name: READING.originNoTask,
    where: '「起点の会話」の行（task に結び付いていない委譲）',
    text: ORIGIN_NO_TASK_GUIDE,
  },
  {
    name: READING.originTask,
    where: '「起点の会話」の行（task に結び付いた委譲）',
    text: ORIGIN_TASK_GUIDE,
  },
  {
    name: READING.confirmation,
    where: 'マネージャーの質問・許可確認の「宛先」の行',
    text: CONFIRMATION_GUIDE,
  },
  { name: READING.permission, where: '許可確認の「宛先」の行', text: PERMISSION_DECISION_GUIDE },
  {
    name: READING.permissionAfterAnswer,
    where: '許可確認（分類器の拒否ではないもの）',
    text: PERMISSION_ASK_AFTER_ANSWER,
  },
  {
    name: READING.denialAfterAnswer,
    where: '分類器の拒否の確認（一時規則を足せない呼び出し）',
    text: DENIAL_ASK_AFTER_ANSWER_PARAGRAPH,
  },
  {
    name: READING.denialAfterAnswerBashRule,
    where: '分類器の拒否の確認（一時規則を足せる Bash の呼び出し）',
    text: DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE,
  },
  {
    name: READING.timerPlain,
    where: '定期ジョブ（依頼の本文なし）',
    text: TIMER_PLAIN_INSTRUCTION,
  },
  {
    name: READING.timerRequest,
    where: '定期ジョブ（継続中の依頼の本文つき）',
    text: TIMER_REQUEST_INSTRUCTIONS,
  },
  {
    name: READING.selfInitiative,
    where: '発意（誰にも呼ばれていない時間）',
    text: SELF_INITIATIVE_INSTRUCTIONS,
  },
  { name: READING.external, where: '外部から届いた出来事', text: EXTERNAL_EVENT_INSTRUCTION },
  {
    name: READING.digestCounts,
    where: '定期の依頼の回の要約（件数の形）',
    text: DIGEST_COUNTS_TOOLS_NOTE,
  },
  {
    name: READING.digestIdleManagers,
    where: '要約の、手が止まっている担当の行',
    text: DIGEST_IDLE_MANAGERS_NOTE,
  },
];

/** クローンのシステムプロンプトに1度だけ置く節。 */
export function buildTurnReadingsSection(): string {
  const items = TURN_READING_ENTRIES.map(
    ({ name, where, text }) => `## 〈${name}〉 ${where}\n\n${text}`,
  ).join('\n\n');
  return `${TURN_READINGS_HEADING}

各ターンの入力の頭には、器が数えた材料（「待ち行列」「いまの全体」）と、そのターンに届いた合図が載る。そこには**値（件数・時刻・id・本文）だけ**を載せ、変わらない読み方・応じ方はこの節に1度だけ置いてある。入力の中の \`${readingRef(READING.categories)}\` の形の参照は、この節の同じ名前の項を指す。**参照が出ている所では、その項をそこに書いてあるものとして読むこと。** この節はシステムプロンプトなので、会話が要約に潰れても消えない。

枠の警告（「⚠️ 枠を理由に仕事を見送らないこと」）だけは、ここへ移さず毎ターン認証トークンの行の隣に出す。

${items}`;
}
