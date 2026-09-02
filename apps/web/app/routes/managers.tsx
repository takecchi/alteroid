import { Link } from 'react-router';

import { Page } from '~/components/page';
import { Badge, Card, Empty, ErrorNote, Spinner } from '~/components/ui';
import { useManagers } from '~/hooks/queries';
import { formatRelative } from '~/lib/format';
import type { ManagerDenial, ManagerStatus, ManagerSummary } from '~/lib/types';

const STATUS: Record<ManagerStatus, { tone: 'ok' | 'warn' | 'danger' | 'neutral'; label: string }> =
  {
    running: { tone: 'ok', label: '実行中' },
    waiting_human: { tone: 'warn', label: '人間待ち' },
    // **「完了」と書かない。** `done` はマネージャー自身のターンが終わって待機して
    // いるだけで、仕事が終わったとは限らない（その下で作業者が走っているかも、
    // ここからは見えていない）。`schema.ts` の定義も「待機中」である — 画面だけが
    // 「完了」と言っていた。
    done: { tone: 'neutral', label: '待機中' },
    failed: { tone: 'danger', label: '失敗' },
    // **「完了」の側に寄せない。** 戻れなかった仕事は `done`（終えて待っている）
    // ではない。人間が画面で見たときに「起こし直す対象」だと分かる言葉にする。
    //
    // **かといって「復旧不能」でもない。** 観測したのは「前のセッションへ戻れ
    // なかった」ことだけで、成果の有無は見ていない（デーモンは PR もブランチも
    // 知らない）。落ちる直前にマージまで届いていた仕事がこの札を貼られている。
    lost: { tone: 'danger', label: 'セッションへ戻れず' },
    // **`done`（待機中）と混ぜない。** `done` は自分から手を離しただけで話しかけ
    // れば続くが、`stopped` は外から止められ、runner のセッション一覧から実際に
    // 消えたことを確かめた終端である（`schema.ts` の `jobStatusSchema` の doc）。
    // 「完了」と読ませないのは `done` と同じ理由。
    //
    // **「話しかけても続かない」ではない（2026-08-22 訂正）。** デーモンは自動では
    // 起こし直さないが、`session_id` は残っているので、人間・クローンが明示的に
    // 続きを送れば `lost` と同じく戻る（`schema.ts` の `jobStatusSchema` の doc）。
    // ここの画面はその「デーモンが勝手には起こさない」側だけを表す。
    stopped: { tone: 'neutral', label: '停止済み' },
  };

export function ManagerStatusBadge({ status }: { status: ManagerStatus }) {
  const view = STATUS[status];
  return <Badge tone={view.tone}>{view.label}</Badge>;
}

/**
 * 一覧に添える拒否は、**新しい側から**この件数まで。
 *
 * 1本の異常が一覧を食い潰さないためだが、**切ったことは必ず言う**。黙って落とすと
 * 「3種類しか止められていない」に見える（`manager_list` の `LIST_DENIED_TOOLS` と
 * 同じ理由・同じ数）。
 */
const LIST_DENIED_TOOLS = 3;

/**
 * 拒否を「新しい側から」畳んだ像。
 *
 * デーモンは**古い順**で返す（`ManagerPool.denials()`）。読む側が知りたいのは
 * いま何で止まっているかなので、末尾から採る。
 */
export function summarizeDenials(denials: ManagerDenial[]) {
  const recent = [...denials].reverse();
  return {
    shown: recent.slice(0, LIST_DENIED_TOOLS),
    rest: Math.max(recent.length - LIST_DENIED_TOOLS, 0),
    total: denials.reduce((sum, entry) => sum + entry.count, 0),
  };
}

/**
 * `ManagerDenial.actor` を一覧の1件に添える短い印にする。
 *
 * **3値が字面の上でも3値のまま出ること。** `undefined`（層が取れていない。
 * `via: 'result'` は SDK 側に判定材料が無いので常にここに落ちる）を、
 * 黙って消したりマネージャー側へ混ぜたりしないこと（Issue #373、
 * 2026-08-24 コメント #5393921053 が指摘した実害と同じ形を再現しないため）。
 * `packages/core/src/tools.ts` / `apps/cli/src/chat.ts` の同名の書式と
 * 逐語で揃えてある——片方だけ直すと、クローン・CLI・Web UI で数字の意味が
 * ずれる。
 *
 * **export してあるのは `manager-detail.tsx`（`DenialsCard`）から再利用する
 * ため。** 同じ画面（Web UI）の中で同じ書式を2箇所に書き写すと、直すときに
 * 片方だけ直る形が起きる——`tools.ts`/`chat.ts` を分けているのはプロセスが
 * 別だからで、同一プロセス内の2ファイルにはその理由が無い。
 */
export function denialActorTag(actor: ManagerDenial['actor']): string {
  return actor === 'manager' ? ' [マネージャー]' : actor === 'worker' ? ' [作業者]' : ' [層不明]';
}

/**
 * 「確認へ上がらず止められた」件数を、**状態に添えて**出す一行。
 *
 * **状態を置き換えない。** 分類器か deny 規則がその場で拒否すると、その仕事は
 * `running`（＝画面では「実行中」）のまま手が止まる。だから札は札のまま残し、
 * その隣にこれを並べる。
 *
 * **これが無いと、人間の画面にだけ見えないものができる。** クローンは同じ状態を
 * `manager_list` で読み、そこには拒否件数が出ている（PR #60）。人間の画面が
 * 「実行中」としか言わないと、同じ仕事を見て人間とクローンが違う判断をする
 * — 北極星 禁止1（デグレード禁止）を、いつもと逆の向きに踏むことになる。
 *
 * **ここでも観測した分しか言わない。** 数えているのは拒否そのものであって、それで
 * 止まったかどうかは見ていない（デーモンに動きを見る手が無い）。だから「止まって
 * いる」ではなく「止まっている可能性がある」と書く。
 *
 * **各件に `denialActorTag` で層を添える（Issue #373）。** #549 が `actor` を
 * デーモンから API まで通したのに、この画面だけが `tool` / `count` の2値の
 * ままだった——値は届いていたのに描いていなかっただけである。
 */
export function ManagerDenialNote({ denials }: { denials: ManagerDenial[] }) {
  if (denials.length === 0) return null;
  const { shown, rest, total } = summarizeDenials(denials);
  return (
    <p className="mt-1 text-[11px] text-warn">
      ⚠ 確認へ上がらず止められた道具:{' '}
      {shown
        .map((entry) => `${entry.tool} ${entry.count}件${denialActorTag(entry.actor)}`)
        .join(' / ')}
      {rest > 0 && `（ほか ${rest} 種、全 ${total} 件）`}
      。この確認はクローンには回ってきていないので、手が止まっている可能性がある。
    </p>
  );
}

/**
 * 直近の1ターンが**報告ではなく失敗**で終わったことを、**状態に添えて**出す一行。
 *
 * **状態の札を置き換えない。** 支出上限に当たった回もセッションは生きているので、
 * 台帳の `status` は `done`（＝画面では「待機中」）のままである
 * （`packages/core/src/schema.ts` の `lastFailure` の doc）。札を「失敗」へ倒すと
 * 嘘になり、人間は続けられる仕事をそこで閉じる。
 *
 * **これが無いと、人間の画面には「報告が来た」としか出ない。** 直す前は
 * `You've hit your org's monthly spend limit …` が最後の報告としてそのまま出て
 * いた（`packages/core/src/sdk-failure.ts` の doc）。本文の側は runner が包んで
 * あるが、包みだけに頼ると読む側は本文の先頭を読んで判定することになる。
 *
 * **SDK の語（`code` / `via`）をそのまま出す。** 言い換えると人間が SDK の型定義や
 * ログで引ける手がかりが消える。`billing_error` と `rate_limit` は次の一手が違う。
 */
export function ManagerFailureNote({
  failure,
}: {
  failure: ManagerSummary['lastFailure'] | undefined;
}) {
  if (failure === undefined || failure === null) return null;
  return (
    <p className="mt-1 text-[11px] text-danger">
      ⚠ 直近のターンは報告ではなく失敗で終わっている: {failure.code}（{failure.via}）
      。セッションは生きているので、原因が解ければ話しかければ続く。
    </p>
  );
}

/**
 * **宛先の器そのものが名乗らなくなった**ことを、**状態に添えて**出す一行
 * （`ManagerSummary.runnerLostSince`）。
 *
 * **`ManagerSessionMissingNote` と1つの部品に畳んでいない。違う主張だからである。**
 *
 * | | `runnerLostSince` | `sessionMissingSince` |
 * | --- | --- | --- |
 * | 源 | **名簿**（`ManagerPool#silentRunners()` = 名簿の entry が `state: 'lost'`） | **台帳の像**（`record.sessionMissingSince`） |
 * | `live` との関係 | **`live: false` を引き起こす側**（`isLive()` が `silentRunners.has(runnerId)` で false を返す） | **`live` を落とさない**ことがその欄の主眼 |
 * | 次の一手 | 器の側を見る | この委譲の生ログを見る |
 *
 * 1つに畳むと、doc が「いまどちらの主張をしているか」を毎回条件で言い分けること
 * になる。repo の既存の形も「主張1つにつき部品1つ」である（`ManagerDenialNote` /
 * `ManagerFailureNote` であって汎用の `ManagerNote` ではない）。**`denialActorTag`
 * の doc が防いでいる「片方だけ直る形」は *同じ* 書式が2ファイルに散ることであって、
 * *違う* 主張が2つの部品に分かれることではない** — どちらもこのファイルに置いて
 * `manager-detail.tsx` から import すれば、ファイル間の重複は起きない。
 *
 * **2つは排他ではない。同時に立つ**（`packages/core/src/manager.ts` を `ff24ded9`
 * で引いて確かめた）。`summaryOf()` は2つを独立した spread で組み立てており、排他を
 * 課している行は1行も無い。`record.sessionMissingSince` を消すのは「resume で戻れた」
 * ＝ runner が実際に答えた回の2箇所だけなので、**runner が黙っても消えない。** ⟹
 * 到達順序は「runner がこの委譲について答えない → `sessionMissingSince` が立つ
 * （`live` は true のまま）→ その後 同じ runner が名乗らなくなる → `runnerLostSince`
 * が立ち、同時に `live: false`」。**札は「セッション切断」、その下に注記が2本並ぶ。**
 * CLI（`chat.ts`）が2つを独立した `if` で（`else` 無しで）積み、`tools.ts` も別々の
 * 配列要素にしているのと同じ形である。
 *
 * **⚠️ 「この委譲が失われた」と書かないこと。理由は `sessionMissingSince` とは中身が
 * 違う。** こちらは「黙っているのが器なのか経路なのかは片側からは決められず、**器の
 * 中でまだ走っている可能性が残る**」からである（`packages/core/src/manager.ts` の
 * `ManagerSummary.runnerLostSince` の doc）。⟹ **`status: lost` の札の言葉に寄せない
 * こと。** `lost` は resume を試して戻れなかったという**確かめた事実**に付く名前で、
 * ここはまだ何も確かめていない。
 *
 * **⚠️ 「いま話しかけられない」と書かないこと。実測して嘘だと分かっている。**
 *
 * CLI（`chat.ts`）と `manager_list`（`tools.ts`）はこの節を「新しい委譲の宛先からも
 * 外れているので、**いま話しかけられない**」と書いているが、**Web の面へそのまま
 * 持ってくると `ba4053d`（#67「「いま送っても届かず」の真下に、届く送信ボタンが
 * 並んでいた」）が閉じた欠陥の再発になる。** 詳細画面ではこの注記のすぐ下に
 * `SendMessage` の送信欄が在る。#67 はボタンを塞がずに**注記のほうを直した**
 * （塞ぐと「人間が自分の言葉で繋ぎ直す唯一の手」が消える。north_star 禁止1）。
 *
 * **⚠️ #67 の commit 本文が持つ実測表（`delivered` / `unknown` の2値）を
 * そのまま当てないこと。あれは古い。** `0fb068f`（PR #571「manager_send が
 * [running] の相手へ 404 を貫通させる」#563）で `ManagerSendResult.outcome` は
 * **4値**（`answered` / `delivered` / `session_missing` / `unknown`）になった。
 * **commit 本文は書き換わらないので、いつ偽になったかが本文からは読めない。**
 *
 * **実測（`packages/core` の足場で書き捨ての試験を走らせた。2026-08-28。
 * commit していない）——名簿が `state: 'lost'` と判定した器に `send()` を撃った:**
 *
 * | 場面 | `outcome` |
 * | --- | --- |
 * | `session_id` あり／器の口は応える | **`delivered`**「追加指示として届けた。」 |
 * | attached な記録で器が 404 を返す | **`session_missing`**（「そのものは居る」側） |
 * | `session_id` 無し | `unknown`「session_id を持っておらず、続きへ戻れない」 |
 * | （対照）**一度も開けていない**宛先 | `unknown`「いま名簿に開いていない」 |
 *
 * ⟹ **「名簿に開いていない」による `unknown` は `lost` では出ない**——出たのは
 * *一度も開けていない*宛先（`entry.client === null`）だけである。理由: `#markSilent` は
 * `state` を `'lost'` にするだけで **`entry.client` を落とさず**、`Registry#get()` は
 * `entry.state` を見ない（`entry.client?.runnerId` の一致だけ）。`list()` は明示的に
 * `lost` を除くが `get()` は除かない。`send()` は `job.runnerId` が在れば
 * `#runnerOf` → `get()` を通り、**`runnerLostSince` が立つのは `runnerId` が在るとき
 * だけ**（`lostSinceOf`）なので必ずこちら側である。
 *
 * ⟹ **デーモンは拒まない。実際に resume を試す。** だからここは送信可否を推論せず、
 * 「新しい委譲の宛先からは外れている」（`list()` が `lost` を除くので真）までに留める。
 * **`session_missing` が返る場合はなおさらである**——その doc は逐語で「そのものは
 * 居る」「`sessionId` が残っていればもう一度 resume を試せる」と言い、`'unknown'` へ
 * 畳むことを名指しで禁じている。
 *
 * **仮に `unknown` が返る場合でも「話しかけられない」とは書けない。** デーモン自身の
 * 文言（`#runnerNotOpenDetail`）が逐語で「これは『いま開いた宛先が無い』という観測で
 * あって、**戻せないことの証明ではない**」と言っており、言い切るのはデーモンが自分の口で
 * 言っている強さより1段強い。
 *
 * **`DisconnectedNote` と矛盾しないのは、擦り合わせたからではなく実測がそう
 * だったからである。**
 *
 * 文言の核は CLI（`apps/cli/src/chat.ts`）と `manager_list`（`packages/core/src/tools.ts`）
 * から逐語で取ってある。**「次の一手」の節だけ画面の語へ置き換えた** — CLI にも
 * `tools.ts` にも器を見に行く道具の名前が出るが、**Web UI には runner の画面が無い**
 * （`apps/web/app/routes.ts` に `runners` は無い）ので、画面に無いものを名指ししない。
 *
 * **時刻の連結詞だけ CLI と違う。** CLI は ISO なので「{ISO} 以降」で読めるが、この
 * 画面は `formatRelative`（相対時刻）なので「3時間前以降」が日本語として壊れる。
 * 「から」にしてある——主張は同一である。
 */
export function ManagerRunnerLostNote({
  runnerLostSince,
  className = 'mt-1 text-[11px] text-danger',
}: {
  runnerLostSince: string | undefined;
  className?: string;
}) {
  if (runnerLostSince === undefined || runnerLostSince === null) return null;
  return (
    <p className={className}>
      ⚠ 宛先の器は{formatRelative(runnerLostSince)}
      から名乗っていない。新しい委譲の宛先からは外れている（置き先として数えない）。この委譲が失われたという意味ではない
      —
      黙っているのが器なのか経路なのかは、ここからは言えない（器の中でまだ走っていることもある）。話しかけることは塞いでいない
      — 戻る先（session_id）が在れば、送ると resume
      を試みる（届くとは限らない）。打つ手はこの委譲の側ではなく器の側にある —
      名乗らなくなった器そのものを確かめること。
    </p>
  );
}

/**
 * **runner は答えたが、この委譲のセッションだけが無かった**ことを、**状態に添えて**
 * 出す一行（`ManagerSummary.sessionMissingSince`）。
 *
 * **`ManagerRunnerLostNote` とは別の部品である**（畳まない理由はあちらの doc の表）。
 * **2つは排他ではなく、同時に並ぶことがある。**
 *
 * **状態の札も `live` の描き方も置き換えない。** `status` は `running`（＝画面では
 * 「実行中」）のままだし、`live` も落ちない——`sessionId` が残っていれば
 * `manager_send` が resume から入り直せるので「話しかけられるか」＝`live` は真の
 * ままで正しい。⟹ **`live: true` とこの行の組が5つ目の形**（runner に生きた
 * セッションはもう無いが、まだ話しかけられる）**を名指しする**
 * （`packages/core/src/tools.ts` の `manager_list` の doc が逐語でそう書いている）。
 *
 * **⚠️ 「この委譲が失われた」と書かないこと。** 由来が少なくとも2つあり、デーモンは
 * 台帳から区別できない——(1) 仕事の途中でセッションが失われた、(2) **仕事が完遂した
 * 後にセッションが畳まれ、終端の合図だけが届かなかった**。どちらも `lastReport` は
 * 空のまま `status: running` で残る（`packages/core/src/manager.ts` の
 * `ManagerSummary.sessionMissingSince` / `sendFailureDetail` の doc）。読み手が (1) と
 * 決めつけると**完遂済みの仕事を委譲し直す**ので、この幅を潰さない。
 *
 * **`text-danger` ではなく `text-warn` にしてある。** `lost`（戻れなかったことを
 * 確かめた事実）と `lastFailure`（SDK が応答ではないと言った事実）は danger だが、
 * ここは「失われたとは言えない」ことのほうが主張なので、色で言い切らない。
 *
 * **主張の核はクローンの `manager_list`（`tools.ts`）と CLI（`chat.ts`）と逐語で
 * 揃えてある**（「runner がそう答えた。聞けなかったのではない」「この委譲が失われた
 * という意味ではない」「完遂した後にセッションが畳まれ、終端の合図だけが届かなかった
 * 回も同じ形に見える」）。**「次の一手」の節だけは面ごとに語が違う** — CLI は
 * `/manager`、`tools.ts` は `manager_report` / `manager_send` / `manager_start` と、
 * それぞれ自分の面に在る操作を名指ししている。Web UI にはそのどれも無いので、この
 * 画面に在るもの（最後の報告・セッションログ・話しかける）で言う。これは既存の
 * 前例に沿う判断で、下の `status === 'lost'` の注記が CLI 版とは違う語で同じ主張を
 * 出しているのと同じ形である。**ただし「先に起こし直さない（同じ仕事が2本になる）」
 * は落とさない** — 人間が実際に踏める地雷で、Web の画面にも同じ操作の入口が在る
 * （`manager-detail.tsx` の `SendMessage`）。
 *
 * **時刻は `formatRelative` で出す。** この画面の作法である（`updatedAt` と同じ）。
 * CLI / `manager_list` は ISO をそのまま出しており、**書式が違うのは意図である。**
 *
 * **`className` を受けるのは、一覧と詳細で置き場所（余白と字の大きさ）だけが違う
 * から。** 文言は1箇所にしか無い——同じ画面（Web UI）の中で同じ書式を2箇所に書き
 * 写すと、直すときに片方だけ直る形が起きる（`denialActorTag` の doc と同じ理由。
 * `tools.ts`/`chat.ts` を分けているのはプロセスが別だからで、同一プロセス内の
 * 2ファイルにはその理由が無い）。**export してあるのは `manager-detail.tsx` から
 * 再利用するためである。**
 *
 * **由来（`sessionMissingKind`）も同じ主行に添える（#579）。** 「resume でも
 * 入り直せなかった」（`'resume-failed'`）と「名簿に載っていなかっただけ、resume
 * はまだ試していない」（`'unlisted'`）では読み手の次の一手が違うので、1つの ⚠ に
 * 畳まない——`packages/core/src/manager.ts` の `ManagerSummary.sessionMissingKind`
 * の doc と同じ理由。文言は `describeSessionMissingKindNote`（このファイル）が持つ。
 */
export function ManagerSessionMissingNote({
  sessionMissingSince,
  sessionMissingKind,
  className = 'mt-1 text-[11px] text-warn',
}: {
  sessionMissingSince: string | undefined;
  sessionMissingKind?: ManagerSummary['sessionMissingKind'];
  className?: string;
}) {
  if (sessionMissingSince === undefined || sessionMissingSince === null) return null;
  return (
    <p className={className}>
      ⚠ 宛先の runner は{formatRelative(sessionMissingSince)}
      の時点で、この委譲のセッションを持っていなかった（runner
      がそう答えた。聞けなかったのではない）。{describeSessionMissingKindNote(sessionMissingKind)}
      この委譲が失われたという意味ではない —
      完遂した後にセッションが畳まれ、終端の合図だけが届かなかった回も同じ形に見える。まず最後の報告とセッションログ（生）を確かめること（報告が届いていなくても、書き終えた報告がそこに残っていることがある）。話しかければ
      resume から入り直すので、同じ依頼をもう一度出して起こし直さないこと — 同じ仕事が2本になる。
    </p>
  );
}

/**
 * `sessionMissingKind` の由来を一言で言う（#579）。
 *
 * **`export` してあるのは歯のためである。** 下の doc のとおり字面は2箇所に
 * 在り、**揃っていることを規約（「直すときは両方見ること」）で守ると、片方
 * だけ直しても両方の面のテストが自分の literal を見て緑のまま通る。** だから
 * `managers.test.tsx` が core の `describeSessionMissingKind` を import して
 * **2つが文字列として等しいことを直接測る**（テストファイルは
 * `@alteroid/core` の値 import の禁止から明示的に外してある——`eslint.config.js`
 * の該当ルールの doc。先例は `journal.test.tsx` の `JOURNAL_ENTRY_TYPES`）。
 *
 * **字面は `packages/core/src/digest.ts` の `describeSessionMissingKind` と
 * 揃えてある。** ここで自前に書いている理由は、`packages/core` を Web の
 * バンドルへ引き込まないためである（`pnpm check:web-bundle-node-traces` /
 * `check:web-bundle-size` がそれを守る）。**文言を直すときは両方見ること**
 * （`grep -Fn -- 'resume でも入り直せなかった' packages/core/src/digest.ts`）。
 *
 * **`undefined` は空文字にする（「不明」と書かない）。** 由来を持たない印は、
 * この欄が足される前の版のデーモンが立てたものだけである。そこへ新しい語を
 * 出すと、実際には2つしかない区別が3つに見える（`describeSessionMissingKind`
 * の doc と同じ理由）。
 *
 * **型の網羅性で塞いだうえで、実行時の倒れ先も足す**（AGENTS.md「型で塞いだ
 * 分岐にも、実行時の倒れ先の歯を足す」）。デーモンと Web は別デプロイなので
 * 版がずれうる——デーモンが先に3つ目の値を返し、この画面の型定義（生成 spec）
 * がまだ2値のままという順序が実在しうる。`default` 節は `never` 型の変数へ
 * 代入するだけで、**その値をそのまま画面に出さない**（#285 で実際に踏まれた
 * 間違い——`never` 型の変数を本文として描いてしまい、画面に分岐キーの生の値が
 * 出た。ここでは主行の主張（この委譲のセッションが無かった、という事実）だけを
 * 残し、由来の一言を静かに省く——データを1文字も消さない安全側）。
 */
export function describeSessionMissingKindNote(kind: ManagerSummary['sessionMissingKind']): string {
  switch (kind) {
    case 'resume-failed':
      return 'resume でも入り直せなかった。';
    case 'unlisted':
      return '名簿に載っていなかった。resume はまだ試していない。';
    case undefined:
      return '';
    default: {
      const unreachable: never = kind;
      void unreachable;
      return '';
    }
  }
}

export default function Managers() {
  const { data, error, isLoading } = useManagers();
  const managers = data?.managers ?? [];

  return (
    <Page
      title="マネージャー"
      description="クローンが起こした仕事。人間が Claude Code に頼んだのと同じ位置にいる"
    >
      <ErrorNote error={error} className="mb-4" />
      {isLoading ? (
        <Spinner />
      ) : managers.length === 0 ? (
        <Card>
          <Empty>まだ1体も起きていない。会話で依頼するか、発意 tick を待つ。</Empty>
        </Card>
      ) : (
        <Card>
          <ul>
            {managers.map((manager) => (
              <li key={manager.managerId} className="border-b border-border last:border-b-0">
                <Link
                  to={`/managers/${manager.managerId}`}
                  className="flex items-start gap-3 px-4 py-3 hover:bg-surface-2"
                >
                  <div className="mt-0.5 shrink-0">
                    <ManagerStatusBadge status={manager.status} />
                  </div>
                  <div className="min-w-0 flex-1">
                    {/* 一覧の1行は Markdown 化の対象外（`components/markdown.tsx` の doc） */}
                    <p className="truncate text-sm">{manager.request}</p>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted">
                      {manager.cwd}
                    </p>
                    {manager.waiting.length > 0 && (
                      // 一覧の1行は Markdown 化の対象外（`components/markdown.tsx` の doc）
                      <p className="mt-1 text-[11px] text-warn">
                        {manager.waiting.length} 件の確認待ち: {manager.waiting[0]?.summary}
                      </p>
                    )}
                    {/*
                      拒否は `status` に映らない。札は「実行中」のまま、その隣に
                      添える（状態を置き換えるものではない）。
                    */}
                    <ManagerDenialNote denials={manager.denials ?? []} />
                    {/*
                      失敗も `status` に映らない（上限に当たった回も `done` の
                      まま）。札はそのまま残し、その隣に添える。
                    */}
                    <ManagerFailureNote failure={manager.lastFailure} />
                    {/*
                      `live: false` の理由を、分かる分だけ名指しする。「セッション
                      切断」の札だけだと、セッションが終わったのか宛先の器が消えた
                      のかが読めず、打つ手が決まらない。**CLI と `manager_list` は
                      両方描いていて、この画面だけが両方とも描いていなかった。**
                    */}
                    <ManagerRunnerLostNote runnerLostSince={manager.runnerLostSince} />
                    {/*
                      これも `status` に映らないし、`live` も落ちない（`sessionId`
                      が在れば resume から入り直せる）。⟹ 右の「接続あり」の緑と
                      **同時に**出るのが正しい形である。札は差し替えず隣に添える。

                      **上の `ManagerRunnerLostNote` と排他ではない。** 2本並ぶ形が
                      在る（`ManagerRunnerLostNote` の doc の到達順序）。CLI も
                      `manager_list` も `else` を使わず2行積んでいる。
                    */}
                    <ManagerSessionMissingNote
                      sessionMissingSince={manager.sessionMissingSince}
                      sessionMissingKind={manager.sessionMissingKind}
                    />
                    {/*
                      札だけでは「で、どうすればいいのか」が伝わらない。クローンは
                      `manager_list` で同じ案内を受け取る — 人間の画面にだけ無いと、
                      同じ状態を見て人間とクローンが違う判断をすることになる。
                    */}
                    {manager.status === 'lost' && (
                      <p className="mt-1 text-[11px] text-danger">
                        前のセッションへ戻れなかっただけで、成果が残っているかは見ていない。起こし直す前にリモート（PR・ブランチ）を確かめること。
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-right text-[11px] text-muted">
                    <p>{formatRelative(manager.updatedAt)}</p>
                    {/*
                      `live` はデーモンが今この瞬間その runner と繋がっているか。
                      status と別に出す — 「走っている扱いだが繋がっていない」を
                      隠すと、再起動後の引き取りが効いたのか分からなくなる。

                      `live && <札>` の形は書かない。それだと `live === false`
                      を「札が無い」でしか表せず、読む側は「切断されている」と
                      「この画面が接続状態を報告していない」を区別できない。
                      だから両側を描く。文言はクローンの `manager_list`
                      （`tools.ts`）と CLI（`chat.ts`）に合わせてある
                      （どちらも `/セッション切断`）。
                    */}
                    {manager.live ? (
                      <p className="text-ok">接続あり</p>
                    ) : (
                      <p className="text-danger">セッション切断</p>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Page>
  );
}
