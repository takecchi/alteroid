/**
 * `main-ci-alarm.mjs` の判定だけを切り出したもの（Issue #1207）。
 *
 * ## 何を塞ぐために在るか
 *
 * **`main` の post-merge CI が落ちても、それを知らせる経路が repo の中に1本も
 * 無かった。** #1207 の実測（2026-08-18〜09-17 の28日）:
 *
 * - `workflow=CI` かつ `event=push`（＝ post-merge）の失敗が **6回**
 * - `.github/workflows/` の8本のどこにも `if: failure()` の step も、失敗に
 *   反応する workflow も無い
 * - ⚠️ **repo の外は見えていない。** GitHub は既定で、失敗した run を**起こした
 *   人**へメールを送る設定を持つ。有効かどうかはアカウント側の設定なので、
 *   **「誰も気づかない」とまでは言えない。** 言えるのは **「repo の中に自動の
 *   経路は1本も無い」** までである ⟹ **ここが足すのはその1本目である。**
 *
 * ## ⛔ この道具が「知らせる」だけで、何も止めないこと
 *
 * **これは警報であって門ではない。** ⛔ **止める門は存在しない** —— 赤い `main`
 * はそのまま `release/prod` へ流れる。「赤なら止める」門は Issue #1207 の (3) で
 * 検討し、実測（28日で門の発動0回／発動していたとしても6件中5件は flaky による
 * 誤停止／唯一の本物の障害 #734 はこの手の門では拾えない／止まると反映は夜1回
 * しか無いので空白は最長で丸1日）を根拠に**作らないと決めている**（出典は
 * Issue #1207 のコメント群、および `.github/scripts/record-release-prod-ci-core.mjs`
 * の doc）。**この理由を再検討せずに「やっぱり門を足す」へ戻さないこと。**
 *
 * 対になるのは門ではなく**記録**である（`release-prod.yml` の記録 step。
 * `.github/scripts/record-release-prod-ci.mjs`）——反映した sha が実際に赤かった
 * 晩は、その記録がここの立てた警報 Issue へ「この赤は本番へ出た」と足す。
 * **片方（知らせるだけ、記録するだけ）で「塞いだ」と言わないこと**（詳しくは
 * `.github/workflows/main-ci-alarm.yml` の doc）。
 *
 * ## 宛先を1つに絞ってある（この repo の既存の方針に合わせる）
 *
 * この repo は「**新しい自動投稿の宛先を無断で作らない**」という方針を明文で
 * 持っている（逐語は
 * `grep -Fn -- '新しい自動投稿の宛先を無断で作らない' scripts/check-scripts-wired.test.ts`）。
 * ⟹ **宛先は「この repo の Issue」1つだけにする。** Slack も、外部の
 * `POST /events` も叩かない（#896 の受け口は source の検証が無いと自認されて
 * いるので、警報の経路には選ばない）。
 *
 * ## 同じ赤で Issue を増やさない鍵は「workflow 名 ＋ head_sha」である
 *
 * ⛔ **「open な警報 Issue が1つでも在れば黙る」形にしないこと。** それだと、
 * 誰も閉じないまま残った1本が**以後すべての警報を飲み込む**（＝
 * `AGENTS.md`「静かに失敗する道具」そのもの）。
 *
 * ⛔ **run ごとに1本立てる形にもしないこと。** `main` が赤いまま何晩か続くと、
 * 夜の反映が止まるたびに新しい Issue が生える。
 *
 * ⟹ **鍵は「どの workflow が、どの sha で落ちたか」にする。**
 *
 * - 同じ sha で同じ workflow がまた落ちた（再実行・翌晩の反映）⟹ 既存の Issue へ
 *   **コメントを足す**
 * - `main` が進んで sha が変わった ⟹ **別の Issue を立てる**（別の赤である）
 * - **同じ run を二度書かない**（警報 workflow 自体が再実行されても増えない）
 *
 * ## 閉じるのは人である（自動で閉じない）
 *
 * `main` が緑へ戻ったら自動で閉じる形も考えたが、**採らなかった。** 理由は2つ:
 *
 * 1. `workflow_run` の `success` にも反応することになり、**マージのたびに job が
 *    1本起きる**（実測 2026-09-17 の `main` への push は16時間で30回）。警報1回の
 *    ために毎回の成功で器を立てるのは釣り合わない
 * 2. 「反映した sha が実際に赤かったか」を毎晩判定して記録するのは記録 step
 *    （`.github/scripts/record-release-prod-ci.mjs`）の役目であって、警報 Issue
 *    の役目ではない。⟹ 警報 Issue が現在地の正本である必要が無い
 *
 * ⟹ **Issue の本文に「直したら閉じてよい」と書いておく**（`buildIssueBody`）。
 */

/**
 * Issue 本文へ埋める印の接頭辞。**この文字列で探す**ので、変えると過去の警報
 * Issue が見つからなくなり、同じ赤で2本目が立つ（壊れはしないが増える）。
 */
export const ALARM_MARKER_PREFIX = 'alteroid:main-ci-alarm';

/**
 * 「どの workflow が、どの sha で落ちたか」を1つの文字列にする。
 *
 * workflow 名はそのまま入れる（`release/prod へ反映` のように空白も日本語も
 * 含むが、埋める先が HTML コメントなので害は無い）。**slug へ潰さない** ——
 * 潰すと `CI` と `C-I` のような別物が同じ鍵になりうるし、人が Issue の本文を
 * 読んだときにどの workflow の話か分からなくなる。
 */
export function alarmKey(workflowName, headSha) {
  return `${workflowName}@${headSha}`;
}

/** Issue 本文へ埋める印。`findOpenAlarmIssue` はこの文字列の完全一致で探す。 */
export function alarmMarker(key) {
  return `<!-- ${ALARM_MARKER_PREFIX} key=${key} -->`;
}

/**
 * open な Issue 群から、この鍵の警報 Issue を1本選ぶ。
 *
 * ⚠️ **`gh api repos/{repo}/issues` は Pull Request も混ぜて返す。** PR には
 * `pull_request` プロパティが付くので、それで落とす —— 落とさないと、たまたま
 * 本文に印を含む PR（この PR 自身がそうなりうる）を警報 Issue と取り違える。
 *
 * @param {{number:number, body?:string|null, pull_request?:unknown}[]} issues
 * @param {string} marker `alarmMarker()` の戻り値
 */
export function findOpenAlarmIssue(issues, marker) {
  return (
    issues.find(
      (issue) =>
        issue.pull_request === undefined &&
        typeof issue.body === 'string' &&
        issue.body.includes(marker),
    ) ?? null
  );
}

/**
 * この run の話が既に書かれているか。
 *
 * **警報 workflow 自身が再実行されても増やさない**ために要る。`texts` には
 * Issue 本文と既存コメントの本文を全部渡す。
 */
export function runAlreadyMentioned(texts, runId) {
  const needle = runMention(runId);
  return texts.some((text) => typeof text === 'string' && text.includes(needle));
}

/**
 * run を指す文字列。**本文にもコメントにも同じ形で埋める**ので、ここを変える
 * ときは両方が変わる（`runAlreadyMentioned` が探すのもこれである）。
 */
export function runMention(runId) {
  return `run ${runId}`;
}

/**
 * 警報を出す状況かどうか。
 *
 * **workflow 側の `if:` と二重になっているのは承知のうえである。** `if:` は
 * YAML 式で、外した／書き間違えたときに**静かに全部通す**側へ倒れる。ここで
 * もう一度見ておけば、少なくとも「関係ない run で Issue を立てた」は起きない。
 *
 * @param {{conclusion:string|null, headBranch:string|null, defaultBranch:string}} input
 */
export function shouldAlarm({ conclusion, headBranch, defaultBranch }) {
  if (conclusion !== 'failure') {
    return { alarm: false, reason: `conclusion=${conclusion} は failure ではない` };
  }
  if (headBranch !== defaultBranch) {
    // PR の run はここで落ちる。**PR の赤は PR の画面に出ているので、警報の
    // 対象ではない** —— 知らせる経路が無いのは main のほうである。
    return {
      alarm: false,
      reason: `head_branch=${headBranch} は default branch（${defaultBranch}）ではない`,
    };
  }
  return { alarm: true, reason: `${defaultBranch} の run が failure で終わった` };
}

/**
 * 既存の Issue とそのコメントを見て、次の一手を決める。
 *
 * @param {{issue: {number:number, body?:string|null}|null, commentBodies: string[], runId: number|string}} input
 * @returns {{kind:'create'|'comment'|'skip', issueNumber?:number, reason:string}}
 */
export function decideAlarmAction({ issue, commentBodies, runId }) {
  if (issue === null) {
    return { kind: 'create', reason: 'この鍵の open な警報 Issue が無い' };
  }
  const texts = [issue.body ?? '', ...commentBodies];
  if (runAlreadyMentioned(texts, runId)) {
    return {
      kind: 'skip',
      issueNumber: issue.number,
      reason: `#${issue.number} に ${runMention(runId)} が既に書かれている`,
    };
  }
  return {
    kind: 'comment',
    issueNumber: issue.number,
    reason: `#${issue.number} が同じ鍵で open なので、そこへ足す`,
  };
}

/**
 * Issue のタイトル。**sha を12桁入れる** —— 一覧で見たときに、同じ赤の続きか
 * 別の赤かがタイトルだけで分かるようにするため。
 */
export function buildIssueTitle({ workflowName, headSha }) {
  return `${workflowName} が main で落ちた（${headSha.slice(0, 12)}）`;
}

/**
 * Issue の本文。
 *
 * **「次の一手」を必ず書く。** 警報が「赤いですよ」だけを言って消えると、読んだ
 * 側は結局 Actions を開いて自分で辿り直すことになる ⟹ run の URL、落ちた
 * workflow、sha、そして**この Issue を閉じてよい条件**まで書く。
 */
export function buildIssueBody({ workflowName, headSha, runId, runUrl, key, extraLines = [] }) {
  return [
    `**\`main\` で \`${workflowName}\` が失敗した。**`,
    '',
    `- sha: \`${headSha}\``,
    `- ${runMention(runId)}: ${runUrl}`,
    '',
    ...extraLines,
    ...(extraLines.length > 0 ? [''] : []),
    '## これは何か',
    '',
    '`main` の post-merge CI が落ちても知らせる経路が repo の中に1本も無かった',
    '（#1207。28日で6回落ちていた）。**この Issue はその経路そのものである** ——',
    '`.github/workflows/main-ci-alarm.yml` が `workflow_run` で失敗を拾って立てている。',
    '',
    '## 閉じてよいとき',
    '',
    '**直したら手で閉じてよい。** この仕掛けは Issue を自動では閉じない',
    "（理由の逐語は `grep -Fn -- '閉じるのは人である' scripts/main-ci-alarm-core.mjs`）。",
    '同じ sha で同じ workflow がまた落ちた場合は、新しい Issue ではなく',
    'この Issue へコメントが足される。**`main` が進めば別の Issue になる。**',
    '',
    alarmMarker(key),
  ].join('\n');
}

/** 同じ鍵の赤がまた出たときに足すコメント。 */
export function buildCommentBody({ workflowName, headSha, runId, runUrl, extraLines = [] }) {
  return [
    `**同じ sha でまた失敗した。** \`${workflowName}\` / \`${headSha.slice(0, 12)}\``,
    '',
    `- ${runMention(runId)}: ${runUrl}`,
    ...(extraLines.length > 0 ? ['', ...extraLines] : []),
  ].join('\n');
}
