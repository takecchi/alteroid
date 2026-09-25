import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { CGROUP_ROOT } from '@alteroid/core';

/**
 * この器（cgroup）が抱えるタスクの state 別内訳（#315「器の pids の合計が
 * どこからも見えない」の実装側。案1が出した「器の合計しか見えない」を埋める）。
 *
 * `/proc` を走査して集計する。ここで数える `threads` は
 * `readExecutionResources`（`packages/core/src/runner-resources.ts`）が cgroup
 * から読む `pids.current` と**同じ軸**（プロセス＋スレッドの総数）だが、
 * **厳密に一致するとは限らない** —— 測る主体（この走査そのもの）が走査中に
 * 増減するため、1〜数本ずれる（`packages/core/src/runner-protocol.ts` の
 * `tasks` の doc に転記してある）。
 *
 * **⚠️ 生きているプロセスの素性は一切含めない。** 出力に載るのは数と、
 * ゾンビの `comm`（コマンド名）だけである —— 他のマネージャーの仕事がここから
 * 覗ける形にしない。だから `cmdline` / `cwd` / `environ` は絶対に読まない
 * （読むのは `stat` と `uptime` だけ）。
 *
 * **孤児の回収（#315 段0）を足したが、この約束は1文字も緩めていない。**
 * 回収の候補を数えるのに使う材料は `stat`（`ppid` / `state` / `num_threads` /
 * `starttime` / `session`）と、**`/proc/<pid>` ディレクトリそのものの所有 UID**
 * だけである（{@link ReclaimObservation} の doc）。所有 UID は `statSync` が返す
 * ディレクトリの属性であって、プロセスの素性が書かれたファイル
 * （`cmdline` / `cwd` / `environ`）ではない —— **そのどれも開いていない。**
 *
 * **段1（実際に撃つ）を足しても、この約束は変わらない（#1334）。** 撃ってよいかの
 * 判定に使う材料も `stat` の6列目（`session`＝セッション ID）だけで、新しいファイルは
 * 1つも開かない。セッション ID そのものの素性（それがどの委譲のものか）は、
 * **runner がプロセスを起こした瞬間に自分で控えた pid の集合**（`cmdline` 等を
 * 読み返して突き止めたものではない）と突き合わせるだけである
 * （{@link ReclaimReapOptions} の doc）。
 *
 * **走査が「読めなかった」で欠けたときは、回収の欄を出さない**
 * （{@link TaskBreakdown.reclaim} の doc）。
 */
export interface TaskBreakdown {
  /** Σ num_threads。cgroup の pids.current と同じ軸で数えたもの。 */
  threads: number;
  /** `/proc/<pid>` の数（スレッドではなくプロセス）。 */
  processes: number;
  /** State=Z のプロセス数。ゾンビは常に1スレッドなので、そのままスレッド数でもある。 */
  zombies: number;
  /**
   * ゾンビの comm 別の内訳。多い順。**ゾンビだけ** —— 生存プロセスの素性は
   * 1バイトも含めない。上位 {@link ZOMBIE_COMMAND_LIMIT} 件までで、超えた分は
   * 黙って切り捨てず {@link ZOMBIE_COMMAND_OTHER_LABEL} へまとめる
   * （AGENTS.md「一覧の上限を件数だけで決める」と同じ理由 —— 黙って切り捨てない）。
   * ゾンビが1本も無ければ欄ごと省く。
   */
  zombieCommands?: Array<{ command: string; count: number }>;
  /**
   * いちばん古いゾンビの年齢（秒）。ゾンビが0本なら欄ごと省く
   * （AGENTS.md「取れない軸に0の行を作る」——0本のときの0秒は「取れた0」では
   * なく「そもそも対象が無い」なので、値そのものを作らない）。
   */
  oldestZombieSeconds?: number;
  /**
   * 孤児プロセス木の回収（#315 段0）。**切ってあるか、降ろす UID が
   * 分かっていなければ欄ごと出ない**（{@link ReclaimScanOptions}）。
   *
   * **⚠️ 走査が「読めなかった」で欠けたときも、欄ごと出ない。**「0本だった」と
   * 「数えられなかった」は別のことである —— pids が枯れた器では
   * `/proc/<pid>/stat` が `EAGAIN` で開けないことがあり、**そこを黙って飛ばして
   * 数えると「孤児は居ない」という嘘になる。** だから `ENOENT`（走査中に消えた。
   * これは正常）とそれ以外を分け、**それ以外が1件でもあればこの欄を出さない**
   * （{@link VANISHED_ERROR_CODES}）。
   *
   * ⚠️ **この規律が効くのはこの欄だけである。** 同じ走査から出る
   * {@link TaskBreakdown.threads} / {@link TaskBreakdown.processes} は、読めなかった
   * ぶんを飛ばしたまま数を名乗る（この機能より前からの振る舞い）。**揃えるかどうかは
   * まだ決めていない** —— 揃えると、前からある欄が新しく消えるようになる。
   */
  reclaim?: ReclaimObservation;
}

/**
 * 回収の動作段階。
 *
 * **段0（観測のみ）と段1（実際に撃つ。#1334）の両方が出るようになった。**
 * `reclaim.reap`（{@link ReclaimScanOptions.reap}）を渡さなければ `'observe'` の
 * ままで、いまも撃つ経路は無い。渡した回だけ `'reclaim'` を名乗る——**渡した
 * その回に1本も撃たなかった（候補が0本だった等）としても `'reclaim'` のまま**
 * である。「その回に何本撃ったか」は `signalled` / `killed` が持つので、
 * `mode` は「撃てる構えになっているか」だけを答える。
 *
 * 型に先に `'reclaim'` を置いてあったのは、段1 を載せた runner と、まだ古い版の
 * デーモンが同時に居る窓を作らないためである（AGENTS.md「Web UI とデーモンの
 * ように別デプロイなら版がずれる」——runner が先に新しい値を返し、受け取る側の
 * 型定義がまだ古い、という順序が実在する）。**受け取る側（`runner-protocol.ts`
 * の `runnerExecutionResourcesSchema`）は既にこの2値を受け付けており、この PR で
 * 変えたのは出す側だけである。**
 */
export type ReclaimMode = 'observe' | 'reclaim';

/**
 * 孤児プロセス木の観測（#315 段0）。**この段は1本も撃たない —— 数えるだけである。**
 *
 * **何を候補と呼ぶか。** `ppid == 1`（親が既に居らず tini へ里子に出ている）かつ
 * **`/proc/<pid>` の所有 UID が、子プロセスを降ろす UID と一致する**もの
 * （＝ alteroid がこの器で起こしたものの残骸）を「孤児ルート」とし、
 * **その部分木を丸ごと**候補にする。部分木で取るのは、孤児ルートの子孫が
 * 親と違うディレクトリで働いていることがあるからで、**親子関係だけで拾えば
 * 作業ディレクトリを読まずに済む。**
 *
 * **⚠️ 名前・コマンド・パスで選ばない。** 選別の材料は所有 UID と親子関係だけである。
 * これは上のファイル doc の約束（素性を読まない）と、AGENTS.md「パターンで
 * プロセスを選ぶ操作は使わないこと」の**両方が同じ設計を指している**ためで、
 * どちらか一方のための妥協ではない。
 *
 * **⚠️ この判定は「終わった仕事の残骸」と「生きた委譲が切り離した、CPU をほとんど
 * 使わない孫」を区別しない。** `ppid == 1` になった時点で親が誰だったかは辿れず、
 * 辿るには `cwd` か `environ` を読むしかない（＝上の約束を破る）。**だからこの段は
 * 数えるだけで、撃つかどうかの判断はここに無い。**
 */
export interface ReclaimObservation {
  /** いまの段階。**段0 では常に `'observe'`**（{@link ReclaimMode} の doc）。 */
  mode: ReclaimMode;
  /** 候補のプロセス数。 */
  candidates: number;
  /** 候補の num_threads の合計。**`pids.current` と同じ軸**なので、返せる量の見積りになる。 */
  candidateThreads: number;
  /**
   * 孤児ルート（`ppid == 1` かつ `/proc/<pid>` の所有 UID が降ろす UID と一致する）
   * の本数（#1334）。**素性を読まずに「1本の巨大な木か、バラバラな木が大量にあるか」
   * を見分けるための3欄**（{@link ReclaimObservation.largestTreeCandidates}・
   * {@link ReclaimObservation.singletonTrees} と組で読む）——409本が1本の孤児ルート
   * から伸びた部分木なのか、409本の孤児ルートがそれぞれ単独で立っているのかは、
   * `candidates` の合計だけでは区別できない。
   *
   * **候補が0本の木もここには数える。** ルート自身が {@link RECLAIM_EXCLUDED_STATES}
   * （`D` / `Z`）で子も居なければ、その木の候補数は0だが、**木そのものは実在する**
   * ので `roots` の本数からは落とさない（`largestTreeCandidates` /
   * `singletonTrees` の側には効かない——後述）。
   */
  roots: number;
  /**
   * 1本の木が抱える候補数の最大値（#1334）。**木ごとに候補を数え直し、その最大を
   * 取る**——全体の合計（`candidates`）を1つの木に見立てる退化をしていないことを、
   * `roots` / `singletonTrees` と組で確かめられるようにするための欄である。
   *
   * `roots` が0本（＝孤児が1本も無い）なら0のまま出す（「取れない軸」ではなく
   * 「対象が無いので最大値も無い」——`candidates` が0本のときと同じ扱い）。
   */
  largestTreeCandidates: number;
  /**
   * 候補がちょうど1本だけの木の本数（#1334）。**「候補を1本だけ抱える木」を数える
   * のであって「プロセスが1つだけの木」ではない**——ルートに除外 state（`D` / `Z`）
   * の子孫が何本ぶら下がっていても、候補としてカウントされるのが1本だけならここに
   * 数える。逆に候補が0本の木（`roots` の doc を参照）は「単独」ではない
   * （単独＝候補1本、0本でも2本以上でもない）。
   */
  singletonTrees: number;
  /**
   * いちばん古い候補の年齢（秒）。**候補が0本なら欄ごと省く**
   * （`oldestZombieSeconds` と同じ理由 —— 0本のときの0秒は「取れた0」ではない）。
   * `/proc/uptime` が読めないときも省く。
   *
   * **⚠️ これは「孤児になってからの齢」ではなく「プロセスが起動してからの齢」である。**
   * 材料は `/proc/<pid>/stat` の22列目（`starttime`）と `/proc/uptime` の差だけで、
   * **`ppid` が 1 へ移った時刻はどこにも記録されていない**（`/proc` がその時刻を
   * 持たない）。⟹ **この欄は「孤児がどれだけ滞留しているか」を答えていない。**
   *
   * [#1334](https://github.com/takecchi/alteroid/issues/1334) が、器の外からの観測
   * （`runner_list`）だけでこの2つを分けようとして分けられなかった —— 「孤児0本」と
   * 観測した22分後に「いちばん古い2時間55分」が出た件が、**判定のぶれ**なのか
   * **起動時刻を見ているから**なのかを、外からは決められなかった。**現物では後者である。**
   * ⟹ 年齢を材料にする欄（この下に足す分布も含む）は、すべて同じ軸であり、同じ但し書きが掛かる。
   */
  oldestAgeSec?: number;
  /**
   * 候補の齢（秒）の中央値（#1334）。**⚠️ これも `oldestAgeSec` と同じ軸**——
   * 「プロセスが起動してからの齢」であって「孤児になってからの齢」ではない
   * （直上の但し書きがそのまま掛かる）。
   *
   * **偶数本なら中間2つの平均を `Math.floor` する。** 省く条件は `oldestAgeSec`
   * と完全に同じ——候補が0本、または `/proc/uptime` が読めないときは欄ごと省く
   * （0秒は「取れた0」ではないので書かない）。
   */
  medianAgeSec?: number;
  /**
   * 候補の齢（秒）の段階別の本数（#1334）。**⚠️ これも「起動からの齢」であって
   * 「孤児になってからの齢」ではない**（`oldestAgeSec` の但し書きがそのまま掛かる）。
   *
   * 境界は 60 / 600 / 3600 / 21600 秒。**最後の1つは `upToSec` を持たず、それが
   * 「それ以上」を意味する**——境界を超えた分を黙って切り捨てず、必ずどれか1つの
   * バケツへ入れる（`topZombieCommands` が上位8件を超えた分を「その他」へまとめる
   * のと同じ作法。AGENTS.md「一覧の上限を件数だけで決める」）。
   *
   * **各バケツの `count` の合計は必ず `candidates` と一致する**——脱落は無い。
   *
   * 省く条件は `oldestAgeSec` / `medianAgeSec` と完全に同じ（候補0本、または
   * `/proc/uptime` が読めないときは欄ごと省く。`[]` を出さない——
   * AGENTS.md「取れない軸に0の行を作る」の禁止は空配列にも同じく効く）。
   */
  ageBuckets?: Array<{ upToSec?: number; count: number }>;
  /**
   * この回（1回の `scanTasks` 呼び出し）で SIGTERM を送った本数。
   *
   * **`reclaim.reap`（{@link ReclaimScanOptions.reap}）を渡していなければ常に 0**
   * である（送出の経路が無い。`apps/runner/src/tasks.test.ts` の「段0 は撃たない」
   * がそれを振る舞いで固定する）。**累積ではなく、この回だけの本数**——`candidates`
   * など他の欄と同じく、毎回その場で数え直す値である。
   *
   * **0でも欄を省かないのは、段1 で欄が生えたように見せないためである。**
   * 「前は無かった欄が増えた」と読まれると、段0 の観測と段1 の観測が別物に見える。
   */
  signalled: number;
  /**
   * この回で SIGKILL を送った本数（{@link ReclaimObservation.signalled} と同じ
   * 「累積ではなくこの回だけ」）。**猶予（`ReclaimReapOptions.graceMs}）を過ぎても
   * まだ居る候補にだけ送る**——新規に撃った回はまだ 0 のことが多い。
   */
  killed: number;
  /**
   * この回で「もう居なくなった」と確認できた、以前 SIGTERM/SIGKILL を送った
   * プロセスの num_threads の合計（{@link ReclaimObservation.signalled} と同じ
   * 「累積ではなくこの回だけ」）。**自然死（相手が自分で畳んだ）と、撃って
   * 消えたものを区別していない**——次の走査で `/proc/<pid>` が消えていれば
   * 「返った」と数える。
   */
  freedThreads: number;
  /** この観測を取った時刻（epoch ms）。**TTL のメモを返したときは、メモを取った時刻である。** */
  lastRunAt: number;
  /**
   * **走査したのと同じ瞬間の** `pids.current` / `pids.max`。
   *
   * `resources.pids`（`readExecutionResources`）とは別に、ここでもう一度読んでいる。
   * **理由は時刻を揃えるためである** —— あちらは `/health` の中で別に読まれるので、
   * 「候補が何本居たとき pids がいくつだったか」を1組で言えない。
   *
   * ⚠️ **そのために `cgroupDirs` / `readText` を `runner-resources.ts` から
   * 約15行複製している**（住所: `packages/core/src/runner-resources.ts` の
   * `cgroupDirs` と `readText`）。**複製であることを承知で置いてある** —— 畳むなら
   * core 側に口を作る話になるので、別の変更として扱う。
   *
   * 読めなければ欄ごと省く（`pids.max` が `max`＝上限なしの器を含む。判定は
   * `runner-resources.ts` の `pidsOf` と同じ形にしてある）。
   */
  pidsAtScan?: { current: number; max: number };
}

/** 回収の観測を有効にする設定。**渡さなければ観測そのものが動かない**（＝切ってある）。 */
export interface ReclaimScanOptions {
  /**
   * 子プロセスを降ろす UID（`ALTEROID_RUNNER_CHILD_UID`）。
   *
   * **これが分からない器では観測しない。** 降ろす UID が無い器では、器の常設物と
   * alteroid が起こしたものを所有 UID で分けられず、候補が「この器に居る `ppid == 1`
   * のプロセス全部」になってしまう。取れない軸に数を作らない（AGENTS.md）。
   */
  childUid: number;
  /**
   * 段1（実際に撃つ。#1334）を有効にする設定。**省略すれば段0（観測のみ）のまま**
   * ——`mode` は `'observe'` を名乗り続け、`process.kill` は一度も呼ばれない
   * （既存の「段0 は撃たない」歯がそのまま固定する）。
   */
  reap?: ReclaimReapOptions;
}

/**
 * 段1（実際に撃つ）を有効にする設定（#1334）。
 *
 * **撃ってよいかどうかは、候補プロセスの「セッション ID」（`/proc/<pid>/stat`
 * 6列目 `session`）と、ここで渡す2つの集合との照合だけで決める。** セッション ID
 * そのものは、runner が委譲の Claude Code プロセスを起こすとき（`@alteroid/core`
 * の `RunnerSession`）にそのプロセスを新しいセッションの長にしておく
 * （`setsid` 相当）ことで、**そのプロセス自身の pid と一致する**ようにしてある
 * ——子孫が `setsid` で自分から抜けない限り、`ppid` が `1` へ付け替わっても
 * セッション ID は起源の委譲プロセスの pid のまま残る。
 *
 * **判定は5分岐（保守的な側へ倒す。全部 {@link reapDecisionFor} が持つ）:**
 *
 * 1. runner がいま把握している委譲（`managerId`）が1本も無い ⟹ セッション ID を
 *    問わず撃ってよい（属す先が無いのだから、どのセッション ID であっても孤児で
 *    確定している）
 * 2. セッション ID が読めない ⟹ 撃たない（観測だけ続ける）
 * 3. セッション ID が「いま生きている委譲」のものと一致する ⟹ 撃たない
 *    （`setsid` で自分から抜けて生きている委譲の下で働いている孫を、誤って
 *    孤児として撃たないため）
 * 4. セッション ID が「このrunnerが起こしたが、既に終端したと分かっている委譲」の
 *    ものと一致する ⟹ 撃ってよい（終端した委譲の残骸そのもの）
 * 5. 上のどれでもない（`setsid` で抜けた・このrunnerの記憶に無い等）⟹ 撃たない
 *
 * **この5分岐のうち「撃つ」のは1と4だけである。** 迷う形（2・3・5のどれでもない
 * 未知の形）は全部「撃たない」側へ倒してある。
 *
 * **⚠️ 2026-09（レビュー指摘・#1334）で分岐1・4の定義を直した。** 直す前は
 * どちらも「プロセスの生死」だけで判定していた——**「委譲（`managerId`）が
 * 終端したか」と「そのプロセス自身が `exit` したか」は別のことである。**
 * マネージャーがターンを終えて次の指示を待つ（`done`）間や、作業者が並列で
 * 走っている間も、その委譲は生きたまま runner に残る一方、**そのプロセス自身は
 * ごく普通に `exit` する**（1回の呼び出しが終わっただけ）。旧い定義だと、
 * 後者が起きた瞬間にその孫（`nohup` で起こしたサーバ等）まで「終端済み」の
 * 側へ回っていた——委譲そのものは何も終わっていないのに、である。**いまは
 * `@alteroid/core` の `RunnerHost.delegationSessionPids()` が「その pid を
 * 起こした `managerId` が、いま runner に生きたセッションとして残っているか」
 * を毎回その場で判定する**（固定した「終端済み」集合を持たない——resume で
 * 同じ委譲に新しいプロセスが立てば、古いプロセスの孤児も次の判定からは
 * 「終端していない」側へ戻る）。分岐1 の「委譲が1本も無い」も同じ定義を使う
 * （`anyTrackedDelegationsOf`）。
 *
 * **⚠️ 分岐4には、それとは別に pid 使い回しの守りが入る（レビュー指摘・#1334）。**
 * `knownTerminatedSessionPids` に載っている sid（＝ pid）は「起源のプロセスは
 * 終わっている」ことしか意味しないので、OS が同じ pid を**生きた別の委譲の
 * 配下**（`setsid` したプロセス）へ使い回した場合、素朴な分岐4はそれを誤って
 * 撃ってしまう。守りは「その sid と同じ pid が、今回の走査に実在するなら
 * 撃たない」——詳しい理由は {@link reapDecisionFor} の doc を見よ。**この守りは
 * 分岐1には適用しない**（同じ doc）。
 */
export interface ReclaimReapOptions {
  /**
   * いま生きている（まだ終端していない）委譲のセッション pid。呼ぶたびに
   * **現在値**を返す関数で受ける——`TaskBreakdownReader` は1度だけ構築されて
   * 走り続けるので、値ではなく関数でなければ起動時点の空集合に固定されてしまう。
   */
  liveSessionPidsOf: () => ReadonlySet<number>;
  /**
   * **その pid を起こした委譲（`managerId`）自身が、いま runner に生きた
   * セッションとして残っていない** セッション pid。呼ぶたびに現在値を返す
   * （{@link ReclaimReapOptions.liveSessionPidsOf} と同じ理由）。
   *
   * **runner プロセスを跨いで持ち越さない。** runner 自身が作り直された直後は
   * この集合が空で始まる——その窓に居る古い孤児は、セッション ID が「このrunnerの
   * 記憶に無い」側に落ちるので段1でも撃たれない（分岐5）。撃たれるとしたら、
   * その時点で runner が把握している委譲が0本のとき（分岐1）だけである。
   */
  knownTerminatedSessionPidsOf: () => ReadonlySet<number>;
  /**
   * runner がいま把握している委譲（`managerId`）が1本でもあるか（分岐1）。
   * **省略時は `true`**（安全側——「無い」と確信できないなら在るとみなし、
   * 分岐1で無条件に撃つ経路へ進まない）。
   *
   * **`liveSessionPidsOf()` の集合の大きさでは代用できない。** `done`（ターンを
   * 終えて次を待つ）委譲はプロセスを持ったまま生きているので通常は問題ないが、
   * `childUser` を渡さない構成（プロセス追跡そのものを行わない——
   * `RunnerHost.delegationSessionPids` の doc）では `liveSessionPidsOf()` は
   * 委譲の本数に関係なく常に空集合を返す。その状態を「委譲が0本」と読むと、
   * 生きている委譲がいくつあっても分岐1が無条件で発砲してしまう。
   */
  anyTrackedDelegationsOf?: () => boolean;
  /**
   * SIGTERM を送ってから SIGKILL へ昇格するまでの猶予（ms）。省略時は
   * {@link DEFAULT_REAP_GRACE_MS}。**主にテスト用**（既定は本番向けの値）。
   */
  graceMs?: number;
}

export interface TaskBreakdownOptions {
  /** `/proc` のマウント先。**主にテスト用で、既定はコードに固定である。** */
  procRoot?: string;
  /**
   * USER_HZ（1秒あたりの clock tick 数）。`/proc/<pid>/stat` の `starttime`
   * （22列目）はこの単位の tick 数で書かれる。**Linux/glibc では慣行的に100
   * 固定**（`sysconf(_SC_CLK_TCK)` がカーネルの実際の `HZ` 設定に関わらず
   * ユーザ空間へ返す値が、ほぼ全ての実運用環境で100に正規化されている）。
   * 既定は100だが、テストから固定できるように引数で差し替え可能にする。
   */
  clockTicksPerSecond?: number;
  /**
   * 1回の走査結果を保持する時間（ms）。既定 {@link DEFAULT_TTL_MS}。
   *
   * **`/health` は heartbeat の経路にあり、頻繁に叩かれる。** `/proc` の全走査は
   * O(pids) で、この器が数百〜千のタスクを抱えていると軽くない —— 毎回律儀に
   * 数え直すと heartbeat そのものを遅くする。短い TTL のメモを1つ持てば、
   * 同じ瞬間に何度呼ばれても実際の走査は1回で済む。テストから固定できるように
   * 引数で差し替え可能にする。
   */
  ttlMs?: number;
  /** いまの時刻（ms epoch）。**主にテスト用**（TTL が効くことを固定して確かめる）。 */
  now?: () => number;
  /**
   * 孤児プロセス木の観測（#315 段0）。**省略すると {@link TaskBreakdown.reclaim} が
   * 欄ごと出ない。** 切る口はここ1つで、`apps/runner/src/index.ts` の
   * `reclaimScanOf` が環境変数から組み立てる。
   */
  reclaim?: ReclaimScanOptions;
  /** cgroup v2 のマウント先。**主にテスト用で、既定はコードに固定である。** */
  cgroupRoot?: string;
  /** 自分がどの cgroup に居るかが書いてある場所。主にテスト用。 */
  procCgroupPath?: string;
  /**
   * `/proc/<pid>` の所有 UID の読み方。既定は {@link readOwnerUid}（実際に `statSync` する）。
   *
   * **主にテスト用**（`now` と同じ理由）。一時ディレクトリへ偽装した `/proc` は
   * 全部テスト実行者が所有するので、**「器の常設物（root が所有）と alteroid の子
   * （降ろした UID が所有）が混ざっている器」を実物のファイルでは作れない** ——
   * 特権が無ければ `chown` できないからである。**いちばん撃ってはいけないもの
   * （root の `ppid == 1` の下に居る、生きたセッション）を候補に数えないことを
   * 固定するには、ここを差し替えるしかない。**
   */
  ownerUidOf?: (procRoot: string, pid: string) => Promise<number | undefined>;
  /**
   * SIGTERM / SIGKILL の送り方。既定は `process.kill(pid, signal)`。
   *
   * **主にテスト用**（`ownerUidOf` と同じ理由——本物の `process.kill` を実際の
   * pid へ打つ歯は、候補を実プロセスで作らないと固定できず、しかもこの器の
   * ユーザで撃ってよいプロセスを都合よく用意できない）。差し替えれば、
   * 「どの pid へ・どの signal を・何回」を実プロセス無しで固定できる。
   */
  killFn?: (pid: number, signal: NodeJS.Signals) => void;
}

const DEFAULT_CLOCK_TICKS_PER_SECOND = 100;
const DEFAULT_TTL_MS = 1000;
const DEFAULT_PROC_CGROUP_PATH = '/proc/self/cgroup';

/** ゾンビの comm 別内訳を出す上限件数。超えた分は {@link ZOMBIE_COMMAND_OTHER_LABEL} へまとめる。 */
const ZOMBIE_COMMAND_LIMIT = 8;
const ZOMBIE_COMMAND_OTHER_LABEL = 'その他';

/**
 * SIGTERM → SIGKILL の既定の猶予（ms）。**10秒。**
 *
 * 相手（委譲の残骸）が自分で畳んでいる最中（fs のフラッシュ・git の後始末等）を
 * 巻き込まないだけの長さを見込みつつ、pids が枯れかけた器で悠長に待ちすぎない
 * 長さに寄せた——**厳密な実測に基づく値ではない**。`ReclaimReapOptions.graceMs`
 * で上書きできる（north_star 禁止2「方針は設定で開けられなければならない」の
 * 精神——固定値にすると人間が調整できなくなる）。
 */
const DEFAULT_REAP_GRACE_MS = 10_000;

/** 里子の引き取り手（init）の pid。`ppid` がこれなら、元の親はもう居ない。 */
const INIT_PID = 1;

/**
 * 回収の候補から外す state。
 *
 * - `D`（uninterruptible sleep）: シグナルが届かない。撃てないものを候補に数えると、
 *   段1 で「送ったのに減らない」が候補の数え方の問題として現れて切り分けを潰す
 * - `Z`（ゾンビ）: tini の領分である（`docker/alteroid-runner` が pid 1 に tini を
 *   据えている理由そのもの）。ここで二重に数えない
 */
const RECLAIM_EXCLUDED_STATES = new Set(['D', 'Z']);

/**
 * 齢の分布（#1334）の境界（秒）。**最後の境界（21600秒＝6時間）を超えた分は
 * 「それ以上」として `upToSec` を持たない末尾のバケツへ入る**——`bucketAges` の doc。
 */
const RECLAIM_AGE_BUCKET_BOUNDARIES_SEC = [60, 600, 3600, 21600] as const;

/**
 * `/proc` を走査してタスクの内訳を測るリーダー。**短い TTL のメモを1つ持つ**
 * （{@link TaskBreakdownOptions.ttlMs} の doc）。`apps/runner/src/app.ts` は
 * このインスタンスを1つだけ作り、`/health` のたびに {@link TaskBreakdownReader.read} を呼ぶ。
 */
export class TaskBreakdownReader {
  readonly #root: string;
  readonly #clockTicksPerSecond: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #reclaim: ReclaimScanOptions | undefined;
  readonly #cgroupRoot: string;
  readonly #procCgroupPath: string;
  readonly #ownerUidOf: (procRoot: string, pid: string) => Promise<number | undefined>;
  readonly #killFn: (pid: number, signal: NodeJS.Signals) => void;
  #cache: { at: number; value: TaskBreakdown | undefined } | undefined;
  /**
   * 段1（実際に撃つ）の状態帳。**このインスタンスの寿命ぶんだけ持つ**
   * （`TaskBreakdownReader` 自体が `apps/runner/src/app.ts` で1個だけ作られ、
   * 走り続けるオブジェクトなので、runner プロセスが生きているあいだは残る）。
   * `reclaim.reap` を渡していなければ一度も書き込まれない。
   */
  readonly #reaper = new Map<number, ReaperEntry>();

  constructor(options: TaskBreakdownOptions = {}) {
    this.#root = options.procRoot ?? '/proc';
    this.#clockTicksPerSecond = options.clockTicksPerSecond ?? DEFAULT_CLOCK_TICKS_PER_SECOND;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#reclaim = options.reclaim;
    this.#cgroupRoot = options.cgroupRoot ?? CGROUP_ROOT;
    this.#procCgroupPath = options.procCgroupPath ?? DEFAULT_PROC_CGROUP_PATH;
    this.#ownerUidOf = options.ownerUidOf ?? readOwnerUid;
    this.#killFn = options.killFn ?? ((pid, signal) => process.kill(pid, signal));
  }

  /**
   * いまのタスクの内訳。**`/proc` が読めない環境（macOS のローカル開発など）
   * では `undefined` を返す**（欄ごと出さない。`readExecutionResources` が
   * pids について書いている「倒れ先が無いものは名乗らない」と同じ作法）。
   *
   * **中身は非同期 I/O のままにしてある**（`node:fs/promises`）。同期
   * （`readdirSync` 等）にすれば「新しいタスクを1本も要求しない」形にはできるが、
   * **代償が重い** —— 走査は O(pids) なので、pids が枯れた器では `/health` が
   * 丸ごと長時間止まる。**`/health` は生存確認の口である。** 止まった器は
   * 「黙った器」として `lost` / `unreachable` へ倒れるので、**「pids が枯れた器」が
   * 「消えた器」に化ける。**
   *
   * **非同期なら、枯渇時は走査そのものが失敗する。** そしてそれは
   * {@link TaskBreakdown.reclaim} を欄ごと落とすので、**「0本だった」と
   * 「数えられなかった」が読む側で分かれる。** 同期にすると、その区別のほうが消える。
   *
   * ⚠️ **「同期のほうが枯渇に強い」は推論であって実測ではない**（libuv の
   * スレッドプールが遅延生成される性質からの外挿）。**実測でそう分かったときに
   * 変える** —— 推論だけで、区別できる形を捨てない。
   */
  async read(): Promise<TaskBreakdown | undefined> {
    const now = this.#now();
    if (this.#cache !== undefined && now - this.#cache.at < this.#ttlMs) {
      return this.#cache.value;
    }
    const value = await scanTasks(this.#root, this.#clockTicksPerSecond, now, this.#reclaim, {
      cgroupRoot: this.#cgroupRoot,
      procCgroupPath: this.#procCgroupPath,
      ownerUidOf: this.#ownerUidOf,
      killFn: this.#killFn,
      reaper: this.#reaper,
    });
    this.#cache = { at: now, value };
    return value;
  }
}

/** 走査の途中で持つ1プロセスぶんの値。**素性は1つも持たない**（`comm` はゾンビのときだけ使う）。 */
interface ScannedProcess {
  pid: number;
  ppid: number;
  state: string;
  numThreads: number;
  starttime: number;
  /**
   * セッション ID（`/proc/<pid>/stat` 6列目 `session`。#1334）。**素性ではない**
   * ——読んでいるのは同じ `stat` の中の1つの数値で、新しいファイルは開いていない。
   * パースできなければ `undefined`（そのときは撃つ側で「不明」として保守的に扱う。
   * {@link ReclaimReapOptions} の doc）。
   */
  sid: number | undefined;
  /** `/proc/<pid>` ディレクトリの所有 UID。回収の観測が切ってあるときは読まない（`undefined`）。 */
  ownerUid: number | undefined;
}

/**
 * 走査中に起きても「異常ではない」エラー。**走査しているあいだにプロセスが消えるのは
 * 正常である**（`/proc/<pid>` は生き死にのたびに現れて消える）。
 *
 * **これ以外のエラーは「読めなかった」として扱う** —— pids が枯れた器で
 * `EAGAIN` / `EMFILE` が返るのがその形で、**黙って飛ばすと「孤児は居ない」という
 * 嘘になる**（{@link TaskBreakdown.reclaim} の doc）。
 */
const VANISHED_ERROR_CODES = new Set(['ENOENT', 'ESRCH']);

/** 走査が「読めなかった」で欠けたかどうか。**1件でも欠けたら回収の欄を出さない。** */
interface ScanHealth {
  degraded: boolean;
}

/** `ENOENT` 等（走査中に消えた）なら true。**それ以外は「読めなかった」である。** */
function isVanished(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code !== undefined && VANISHED_ERROR_CODES.has(code);
}

/** `/proc` を1回だけ走査する。**メモは持たない** —— それは {@link TaskBreakdownReader} の役目。 */
async function scanTasks(
  root: string,
  clockTicksPerSecond: number,
  nowMs: number,
  reclaim: ReclaimScanOptions | undefined,
  deps: {
    cgroupRoot: string;
    procCgroupPath: string;
    ownerUidOf: (procRoot: string, pid: string) => Promise<number | undefined>;
    killFn: (pid: number, signal: NodeJS.Signals) => void;
    /** 段1の状態帳。`TaskBreakdownReader` の寿命ぶんだけ持ち回す（{@link ReaperEntry}）。 */
    reaper: Map<number, ReaperEntry>;
  },
): Promise<TaskBreakdown | undefined> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    // `/proc` 自体が無い環境（macOS のローカル開発）。倒れ先が無いので名乗らない。
    return undefined;
  }

  const health: ScanHealth = { degraded: false };
  const uptimeSeconds = await readUptimeSeconds(root);

  let threads = 0;
  let processes = 0;
  let zombies = 0;
  const zombieCommandCounts = new Map<string, number>();
  // 「いちばん古い」= starttime（起動からの経過 tick 数）がいちばん小さいもの。
  let oldestZombieStarttime: number | undefined;
  const scanned: ScannedProcess[] = [];

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue; // `self` / `uptime` 等、pid でないものを飛ばす
    const parsed = await readStat(root, entry, health);
    if (parsed === undefined) continue; // 読めなければ黙って飛ばす（走査中に消えるのは正常）

    processes += 1;
    threads += parsed.numThreads;

    if (parsed.state === 'Z') {
      zombies += 1;
      zombieCommandCounts.set(parsed.comm, (zombieCommandCounts.get(parsed.comm) ?? 0) + 1);
      if (oldestZombieStarttime === undefined || parsed.starttime < oldestZombieStarttime) {
        oldestZombieStarttime = parsed.starttime;
      }
    }

    if (reclaim !== undefined) {
      scanned.push({
        pid: Number(entry),
        ppid: parsed.ppid,
        state: parsed.state,
        numThreads: parsed.numThreads,
        starttime: parsed.starttime,
        sid: parsed.sid,
        ownerUid: await ownerUidOrDegraded(deps.ownerUidOf, root, entry, health),
      });
    }
  }

  const result: TaskBreakdown = { threads, processes, zombies };

  if (zombieCommandCounts.size > 0) {
    result.zombieCommands = topZombieCommands(zombieCommandCounts);
  }

  if (oldestZombieStarttime !== undefined && uptimeSeconds !== undefined) {
    const ageSeconds = Math.floor(uptimeSeconds - oldestZombieStarttime / clockTicksPerSecond);
    if (Number.isFinite(ageSeconds)) {
      result.oldestZombieSeconds = Math.max(0, ageSeconds);
    }
  }

  // **「0本だった」と「数えられなかった」を分ける。** 1件でも読めなかったなら、
  // 数は名乗らない（{@link TaskBreakdown.reclaim} の doc）。
  if (reclaim !== undefined && !health.degraded) {
    result.reclaim = await observeReclaim(
      scanned,
      reclaim,
      clockTicksPerSecond,
      uptimeSeconds,
      nowMs,
      deps,
    );
  }

  return result;
}

/**
 * 所有 UID を読む。**投げたら「読めなかった」として数える** —— ここで握り潰して
 * `undefined` にすると、候補から静かに漏れて「孤児は居ない」に化ける
 * （{@link TaskBreakdown.reclaim} の doc）。
 */
async function ownerUidOrDegraded(
  ownerUidOf: (procRoot: string, pid: string) => Promise<number | undefined>,
  root: string,
  pid: string,
  health: ScanHealth,
): Promise<number | undefined> {
  try {
    return await ownerUidOf(root, pid);
  } catch (error) {
    if (!isVanished(error)) health.degraded = true;
    return undefined;
  }
}

/**
 * 孤児プロセス木を数え、`reclaim.reap` が渡っていれば撃つ（#315 段0 / #1334 段1）。
 *
 * **`reclaim.reap` が無ければ、この呼び出しは `process.kill` を1度も呼ばない。**
 * それを `grep` ではなく振る舞いで固定してある —— `tasks.test.ts` の「段0 は
 * 撃たない」が、候補が実在する器を走査させたうえで `process.kill` が1度も
 * 呼ばれないことを見る。**撃つ判断そのもの（どの候補が対象か）は
 * {@link reapDecisionFor}、実際に送る／昇格させる手順は {@link reconcileReaper}
 * が持つ**——ここは木を辿って候補と発砲対象を集めるだけである。
 */
async function observeReclaim(
  scanned: readonly ScannedProcess[],
  reclaim: ReclaimScanOptions,
  clockTicksPerSecond: number,
  uptimeSeconds: number | undefined,
  nowMs: number,
  deps: {
    cgroupRoot: string;
    procCgroupPath: string;
    killFn: (pid: number, signal: NodeJS.Signals) => void;
    reaper: Map<number, ReaperEntry>;
  },
): Promise<ReclaimObservation> {
  const children = new Map<number, ScannedProcess[]>();
  for (const entry of scanned) {
    const siblings = children.get(entry.ppid);
    if (siblings === undefined) children.set(entry.ppid, [entry]);
    else siblings.push(entry);
  }

  // 孤児ルート: 親が既に居らず（`ppid == 1`）、かつ降ろす UID が所有しているもの。
  // **root が所有する `ppid == 1` のプロセス（runner 自身など）を種にしない** ——
  // 種にすると、その部分木に居る**生きたセッション**まで候補に入る。
  const roots = scanned.filter(
    (entry) =>
      entry.ppid === INIT_PID && entry.ownerUid === reclaim.childUid && entry.pid !== INIT_PID,
  );

  // **撃ってよいかの判定材料は、reap が渡っているときだけ1回ずつ取る。**
  // 呼ぶたびに現在値を返す関数なので、同じ回のあいだは1つの値で揃える
  // （BFS の途中で値が動くと、同じ回の中で判定がぶれる）。
  const liveSessionPids = reclaim.reap?.liveSessionPidsOf() ?? new Set<number>();
  const knownTerminatedSessionPids =
    reclaim.reap?.knownTerminatedSessionPidsOf() ?? new Set<number>();
  // **省略時は `true`（安全側）——doc は {@link ReclaimReapOptions.anyTrackedDelegationsOf}。**
  const anyTrackedDelegations = reclaim.reap?.anyTrackedDelegationsOf?.() ?? true;
  // **pid 使い回しの守り（分岐4だけに効く。レビュー指摘・#1334）。** `scanned` は
  // UID を問わず今回の走査に写った全 pid——`sid` と同じ値の pid がここに実在する
  // なら、そのプロセスがいま session leader そのものである（`setsid` すると
  // 自分の pid がそのまま sid になる、という OS の規則）。`knownTerminatedSessionPids`
  // に載っている sid は「起源の長は終わっている」前提でしかないので、**いま
  // 同じ pid が実在するなら、それは (a) pid が使い回されて生きた別の委譲の配下が
  // 新しいセッションを開いたか (b) 何らかの理由で判定が追いついていないだけで
  // 本人がまだ生きているかのどちらかであり、どちらでも撃たない側へ倒す。**
  // 詳しい理由は {@link reapDecisionFor} の doc を見よ。
  const scannedPids = new Set(scanned.map((entry) => entry.pid));

  let candidates = 0;
  let candidateThreads = 0;
  let oldestStarttime: number | undefined;
  let largestTreeCandidates = 0;
  let singletonTrees = 0;
  // 候補（撃てる=数える対象）の starttime だけを集める。**素性は一切入らない**
  // ——ここに積むのは `starttime`（数値）だけで、`comm` はどのエントリにも持たせて
  // いない（{@link ScannedProcess} 自体が `comm` を持たない）。
  const candidateStarttimes: number[] = [];
  // **撃ってよいと判定した候補だけを積む**（{@link reapDecisionFor}）。
  // `reclaim.reap` が無ければ、この判定自体を呼ばないので常に空のまま。
  const fireCandidates: Array<{ pid: number; starttime: number; numThreads: number }> = [];

  // **木ごとに辿る。** `visited` は全体で共有し、二重計上だけを防ぐ
  // （通常の `/proc` ツリーではルートをまたいだ重複は起きないが、壊れた `/proc`
  // が輪を作った場合の保険として残す）。除外 state のプロセスも「通り抜ける」——
  // 撃てない親の下に撃てる子が居ることがあるので、数えないだけで辿るのはやめない。
  const visited = new Set<number>();
  for (const root of roots) {
    let treeCandidates = 0;
    const queue = [root];
    for (let entry = queue.pop(); entry !== undefined; entry = queue.pop()) {
      if (visited.has(entry.pid)) continue; // 壊れた `/proc` が輪を作っても回り続けない
      visited.add(entry.pid);

      if (entry.ownerUid === reclaim.childUid && !RECLAIM_EXCLUDED_STATES.has(entry.state)) {
        candidates += 1;
        candidateThreads += entry.numThreads;
        treeCandidates += 1;
        candidateStarttimes.push(entry.starttime);
        if (oldestStarttime === undefined || entry.starttime < oldestStarttime) {
          oldestStarttime = entry.starttime;
        }

        // **撃ってよいかは候補ごとに独立して決める（親の判定を継承しない）。**
        // `setsid` で自分から抜けた子孫は、親（孤児ルート）とは別のセッション ID を
        // 持ちうる——親が「終端した委譲の残骸」でも、その子孫だけが生きた委譲の
        // セッションへ属していれば、その子孫は撃たない。
        if (
          reclaim.reap !== undefined &&
          reapDecisionFor(
            entry.sid,
            liveSessionPids,
            knownTerminatedSessionPids,
            anyTrackedDelegations,
            scannedPids,
          ) === 'fire'
        ) {
          fireCandidates.push({
            pid: entry.pid,
            starttime: entry.starttime,
            numThreads: entry.numThreads,
          });
        }
      }

      for (const child of children.get(entry.pid) ?? []) {
        if (child.pid !== entry.pid) queue.push(child);
      }
    }

    if (treeCandidates > largestTreeCandidates) largestTreeCandidates = treeCandidates;
    if (treeCandidates === 1) singletonTrees += 1;
  }

  // **発砲（SIGTERM → 猶予 → SIGKILL）は reap が渡っているときだけ行う。**
  // 渡っていなければ `fireCandidates` は常に空なので、`reconcileReaper` を
  // 呼んでも signalled/killed/freedThreads は 0 のままである——それでも
  // 「reap が無ければ呼ばない」ほうを選んでいるのは、`process.kill` へ触れる
  // 経路そのものを reap 無効時には存在させないため（「段0 は撃たない」歯が
  // 見ているのはまさにこの経路の有無である）。
  const stillPresentStarttimes = new Map(scanned.map((entry) => [entry.pid, entry.starttime]));
  const fired =
    reclaim.reap === undefined
      ? { signalled: 0, killed: 0, freedThreads: 0 }
      : reconcileReaper(
          deps.reaper,
          fireCandidates,
          stillPresentStarttimes,
          nowMs,
          reclaim.reap.graceMs ?? DEFAULT_REAP_GRACE_MS,
          deps.killFn,
        );

  const observation: ReclaimObservation = {
    mode: reclaim.reap === undefined ? 'observe' : 'reclaim',
    candidates,
    candidateThreads,
    roots: roots.length,
    largestTreeCandidates,
    singletonTrees,
    signalled: fired.signalled,
    killed: fired.killed,
    freedThreads: fired.freedThreads,
    lastRunAt: nowMs,
  };

  if (oldestStarttime !== undefined && uptimeSeconds !== undefined) {
    const ageSeconds = Math.floor(uptimeSeconds - oldestStarttime / clockTicksPerSecond);
    if (Number.isFinite(ageSeconds)) observation.oldestAgeSec = Math.max(0, ageSeconds);
  }

  if (candidateStarttimes.length > 0 && uptimeSeconds !== undefined) {
    const ages = candidateStarttimes.map((starttime) =>
      Math.max(0, Math.floor(uptimeSeconds - starttime / clockTicksPerSecond)),
    );
    observation.medianAgeSec = medianAgeOf(ages);
    observation.ageBuckets = bucketAges(ages);
  }

  const pids = await readPidsAtScan(deps.cgroupRoot, deps.procCgroupPath);
  if (pids !== undefined) observation.pidsAtScan = pids;

  return observation;
}

/**
 * ある候補（孤児候補として既に選ばれたプロセス）を撃ってよいか（#1334）。
 *
 * **5分岐（詳しい理由は {@link ReclaimReapOptions} の doc）:**
 *
 * 1. runner がいま把握している委譲が0本 ⟹ `'fire'`（属す先が無いので、sid を
 *    問わず孤児で確定）
 * 2. `sid` が読めない ⟹ `'hold'`
 * 3. `sid` が生きている委譲のものと一致 ⟹ `'hold'`
 * 4. `sid` が終端済みと分かっている委譲のものと一致 ⟹ `'fire'`（**ただし
 *    pid 使い回しの守りが挟まる。下の doc）
 * 5. どれでもない（`setsid` で抜けた等） ⟹ `'hold'`
 *
 * **迷う形（2・3・5）は全部 `'hold'` に倒してある。** 撃つのは 1 と 4 だけ。
 *
 * **分岐1 は `liveSessionPids` の大きさでは判定しない**（レビュー指摘・#1334）。
 * `anyTrackedDelegations` を別に受け取るのはそのため——理由は
 * {@link ReclaimReapOptions.anyTrackedDelegationsOf} の doc を見よ。
 *
 * **⚠️ pid 使い回しの守り（分岐4だけに効く。レビュー指摘・#1334）。** `knownTerminatedSessionPids`
 * に載っている sid（＝ pid）は「その pid の *起源の* プロセスは終わっている」
 * ことしか意味しない。OS の pid は有限なので、**その pid が別の（生きた）委譲の
 * 配下で `setsid` したプロセスへ使い回されることがありうる**——`setsid` は自分の
 * pid をそのまま新しいセッションの sid にするので、使い回された pid のプロセスは
 * 「終端済みのはずの sid」を再び名乗る。その配下が孤児になれば、素朴な分岐4は
 * それを「終端済み委譲の残骸」として撃ってしまう。
 *
 * **守り: `scannedPids`（今回の走査に写った全 pid。UID を問わない）に `sid` と
 * 同じ pid が実在するなら、分岐4では撃たない（`'hold'`）。** `sid` は session
 * leader 自身の pid なので、それが実在するなら (a) 使い回されて生きた委譲の
 * 配下が新しいセッションを開いた場合と (b) 何らかの理由で本人がまだ生きている
 * 場合のどちらかにしかならず、**どちらでも撃たない側が正しい。** 候補自身が
 * `pid === sid`（自分がセッションの長で、`setsid` して自ら孤立した形）のときも
 * 必ずこの守りに掛かる——候補自身は常に `scannedPids` に居るからである。
 *
 * **⚠️ この守りは分岐1には適用しない**（依頼者の判断・#1334）。分岐1は「runner が
 * 把握している委譲が1本も無い」場合で、そのときはどの `sid` も生きた委譲の配下に
 * 属しようが無いので使い回しの危険が無い。むしろ `setsid nohup` で起こしたまま
 * 孤立したサーバの残骸（自分がセッションの長で `ppid == 1`）こそ分岐1で片付け
 * たい主対象であり、ここに守りを入れると**それが永久に残ってしまう**。
 */
function reapDecisionFor(
  sid: number | undefined,
  liveSessionPids: ReadonlySet<number>,
  knownTerminatedSessionPids: ReadonlySet<number>,
  anyTrackedDelegations: boolean,
  scannedPids: ReadonlySet<number>,
): 'fire' | 'hold' {
  if (!anyTrackedDelegations) return 'fire';
  if (sid === undefined) return 'hold';
  if (liveSessionPids.has(sid)) return 'hold';
  if (knownTerminatedSessionPids.has(sid)) return scannedPids.has(sid) ? 'hold' : 'fire';
  return 'hold';
}

/**
 * 段1の状態帳の1エントリ。SIGTERM を送ってから、猶予を過ぎたら SIGKILL へ
 * 昇格させるまでを覚える。
 */
interface ReaperEntry {
  /**
   * SIGTERM を送った時点のプロセスの `starttime`（`/proc/<pid>/stat` の22列目）。
   * **pid だけでは同じプロセスかが決まらない**ので、帳の行は pid と starttime の組で
   * 1つのプロセスを指す（#1544）。同じ pid でも starttime が違えば、送った相手は
   * もう居ない（pid が別のプロセスへ使い回された）とみなす。
   */
  starttime: number;
  /** SIGTERM を送った時刻（ms）。 */
  sigtermAt: number;
  /** SIGKILL を送った時刻（ms）。まだなら `undefined`。 */
  sigkillAt: number | undefined;
  /** 送った時点の num_threads。消えたと確認できた回に {@link freedThreads} へ足す。 */
  numThreads: number;
}

/**
 * 発砲を進める（#1334）。**この回の `signalled` / `killed` / `freedThreads` だけを
 * 返す**（累積は状態帳＝ `reaper` 引数の側が持ち、呼び出しごとに直接書き換える）。
 *
 * 手順は3段（この順でなければならない——1)を先に済ませないと、同じ回に
 * 「消えた」と「まだ発砲していない」が両方成り立つ pid が生まれうる）:
 *
 * 1. **もう居ない**状態帳のエントリを片付け、その `numThreads` を `freedThreads`
 *    へ足す。「もう居ない」は、今回の走査にその pid が無いか、**在っても
 *    starttime が帳の値と違う**（pid が別のプロセスへ使い回された。#1544）こと
 *    である。自然死か、撃って消えたかは区別しない——どちらでも「返った」という
 *    事実は同じである。
 * 2. **まだ状態帳に居ない発砲対象**へ SIGTERM を送り、状態帳へ登録する。
 *    1) で使い回しの古い行を消してあるので、同じ pid の新しい占有者はここで
 *    初めて SIGTERM を受け、猶予も自分の SIGTERM から数え始める。
 * 3. **猶予（`graceMs`）を過ぎてもまだ発砲対象である**エントリへ SIGKILL を送る。
 *    「まだ発砲対象である」を毎回この回の `fireCandidates`（＝いま読み直した
 *    /proc の情報から再判定した結果）で、pid と starttime の両方で確かめ直す。
 */
function reconcileReaper(
  reaper: Map<number, ReaperEntry>,
  fireCandidates: readonly { pid: number; starttime: number; numThreads: number }[],
  stillPresentStarttimes: ReadonlyMap<number, number>,
  nowMs: number,
  graceMs: number,
  killFn: (pid: number, signal: NodeJS.Signals) => void,
): { signalled: number; killed: number; freedThreads: number } {
  let freedThreads = 0;
  for (const [pid, entry] of [...reaper.entries()]) {
    if (stillPresentStarttimes.get(pid) === entry.starttime) continue;
    freedThreads += entry.numThreads;
    reaper.delete(pid);
  }

  let signalled = 0;
  for (const candidate of fireCandidates) {
    if (reaper.has(candidate.pid)) continue;
    try {
      killFn(candidate.pid, 'SIGTERM');
    } catch {
      continue; // 送る前に消えていた等。次回の 1) がまだ残っていれば片付ける。
    }
    reaper.set(candidate.pid, {
      starttime: candidate.starttime,
      sigtermAt: nowMs,
      sigkillAt: undefined,
      numThreads: candidate.numThreads,
    });
    signalled += 1;
  }

  let killed = 0;
  const fireByPid = new Map(fireCandidates.map((candidate) => [candidate.pid, candidate]));
  for (const [pid, entry] of reaper) {
    if (entry.sigkillAt !== undefined) continue;
    if (nowMs - entry.sigtermAt < graceMs) continue;
    // 今回は発砲対象でない（か、同じ pid の別のプロセスである）。撃たずに保留を続ける。
    if (fireByPid.get(pid)?.starttime !== entry.starttime) continue;
    try {
      killFn(pid, 'SIGKILL');
    } catch {
      continue;
    }
    entry.sigkillAt = nowMs;
    killed += 1;
  }

  return { signalled, killed, freedThreads };
}

/**
 * 齢（秒）の配列から中央値を出す。**偶数本なら中間2つの平均を `Math.floor`。**
 * 空配列は呼び出し側（{@link observeReclaim}）が既に弾いている前提——ここでは扱わない。
 */
function medianAgeOf(ages: readonly number[]): number {
  const sorted = [...ages].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted.at(mid) ?? 0; // 空配列は呼び出し側が弾いている前提（doc）なので、0 は理論上到達しない。
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted.at(mid - 1) ?? 0;
  return Math.floor((lower + upper) / 2);
}

/**
 * 齢（秒）の配列を段階別に数える。境界は {@link RECLAIM_AGE_BUCKET_BOUNDARIES_SEC}
 * （60 / 600 / 3600 / 21600 秒）。**最後の1つは `upToSec` を持たず、境界を超えた分を
 * 黙って切り捨てずにそこへ集める**——`topZombieCommands` が上位8件を超えた分を
 * 「その他」へまとめるのと同じ作法。**各バケツの `count` の合計は、渡した配列の
 * 長さ（＝ `candidates`）と必ず一致する。**
 */
function bucketAges(ages: readonly number[]): Array<{ upToSec?: number; count: number }> {
  const buckets = RECLAIM_AGE_BUCKET_BOUNDARIES_SEC.map((upToSec) => ({ upToSec, count: 0 }));
  const tail: { upToSec?: number; count: number } = { count: 0 };
  for (const age of ages) {
    const bucket = buckets.find((candidate) => age < candidate.upToSec);
    if (bucket !== undefined) bucket.count += 1;
    else tail.count += 1;
  }
  return [...buckets, tail];
}

/**
 * `/proc/<pid>` ディレクトリの所有 UID。**これが本番の経路である**
 * （{@link TaskBreakdownOptions.ownerUidOf} の既定）。
 *
 * **これは「プロセスの素性」ではない。** 読んでいるのはディレクトリの inode 属性で、
 * `cmdline` / `cwd` / `environ` はどれも開いていない（ファイル doc の約束）。
 *
 * **ここでは握り潰さない。** 消えた（`ENOENT`）のか読めなかった（`EAGAIN` 等）のかを
 * 分けるのは呼び出し側（`ownerUidOrDegraded`）の仕事で、ここで `catch` すると
 * その区別が生まれる前に消える。
 */
async function readOwnerUid(root: string, pid: string): Promise<number | undefined> {
  return (await stat(join(root, pid))).uid;
}

/**
 * 走査したのと同じ瞬間の `pids.current` / `pids.max`。
 *
 * **`runner-resources.ts` の `readExecutionResources` を呼ばずに、ここで小さく
 * 読み直している。** 理由は {@link ReclaimObservation.pidsAtScan} の doc に在る
 * （時刻を揃えること・同期で読むこと）。判定（`max` が数として読めなければ欄ごと
 * 省く）は向こうの `pidsOf` と同じ形にしてある。
 */
async function readPidsAtScan(
  cgroupRoot: string,
  procCgroupPath: string,
): Promise<{ current: number; max: number } | undefined> {
  const dirs = await cgroupDirs(cgroupRoot, procCgroupPath);
  const currentValue = Number(await readFirstText(dirs, 'pids.current'));
  const maxValue = Number(await readFirstText(dirs, 'pids.max'));
  if (!Number.isSafeInteger(maxValue) || maxValue <= 0) return undefined;
  if (!Number.isFinite(currentValue) || currentValue < 0) return undefined;
  return { current: currentValue, max: maxValue };
}

/**
 * cgroup のファイルがある場所。**2箇所を見る**（`runner-resources.ts` の
 * `cgroupDirs` と同じ理由 —— 器の cgroup 名前空間が分かれているかで在り処が変わる）。
 */
async function cgroupDirs(root: string, procCgroupPath: string): Promise<readonly string[]> {
  const own = (await readText(procCgroupPath))
    ?.split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('0::'))
    ?.slice('0::'.length);
  if (own === undefined || own === '' || own === '/') return [root];
  return [join(root, own), root];
}

async function readFirstText(dirs: readonly string[], name: string): Promise<string | undefined> {
  for (const dir of dirs) {
    const text = await readText(join(dir, name));
    if (text !== undefined) return text;
  }
  return undefined;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return undefined;
  }
}

/** `/proc/uptime` の1つ目のフィールド（起動からの経過秒数）。読めなければ `undefined`。 */
async function readUptimeSeconds(root: string): Promise<number | undefined> {
  const raw = await readText(join(root, 'uptime'));
  if (raw === undefined) return undefined;
  const value = Number(raw.split(/\s+/)[0]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * `/proc/<pid>/stat` を1件読む。**`cmdline` / `cwd` / `environ` は絶対に読まない**
 * （生きているプロセスの素性を出力に含めないため。ファイル doc を参照）。
 *
 * **フォーマットの罠。** 2列目 `comm` は括弧で囲まれ、中に空白や `)` を含みうる
 * （例: `(sh (weird) name)`）。だから先頭からの素朴な空白分割はできない ——
 * **必ず最後の `) ` で切ってから残りを空白分割する。**
 */
async function readStat(
  root: string,
  pid: string,
  health: ScanHealth,
): Promise<
  | {
      comm: string;
      state: string;
      ppid: number;
      numThreads: number;
      starttime: number;
      sid: number | undefined;
    }
  | undefined
> {
  let raw: string;
  try {
    raw = (await readFile(join(root, pid, 'stat'), 'utf8')).trim();
  } catch (error) {
    // **走査中に消えた（ENOENT）のは正常。それ以外は「読めなかった」である。**
    if (!isVanished(error)) health.degraded = true;
    return undefined;
  }
  const openIdx = raw.indexOf('(');
  const closeIdx = raw.lastIndexOf(') ');
  if (openIdx === -1 || closeIdx === -1 || closeIdx < openIdx) return undefined;
  const comm = raw.slice(openIdx + 1, closeIdx);
  const rest = raw
    .slice(closeIdx + 2)
    .trimEnd()
    .split(/\s+/);
  // 切った後の配列: [0]=state(3列目) [1]=ppid(4列目) [2]=pgrp(5列目)
  // [3]=session(6列目) … [17]=num_threads(20列目) … [19]=starttime(22列目)。
  const state = rest[0];
  const ppid = Number(rest[1]);
  const sidRaw = Number(rest[3]);
  const numThreads = Number(rest[17]);
  const starttime = Number(rest[19]);
  if (state === undefined || state.length === 0) return undefined;
  if (!Number.isFinite(ppid) || ppid < 0) return undefined;
  if (!Number.isFinite(numThreads) || numThreads <= 0) return undefined;
  if (!Number.isFinite(starttime) || starttime < 0) return undefined;
  // **sid が壊れていても、レコード全体は捨てない。** 数え上げ（threads/processes/
  // 候補数）は sid に依存しないので、既存の挙動を保つ。sid が要るのは撃つ判定
  // （{@link reapDecisionFor}）だけで、そちらは `undefined` を「不明」として
  // 保守的に扱う。
  const sid = Number.isFinite(sidRaw) && sidRaw >= 0 ? sidRaw : undefined;
  return { comm, state, ppid, numThreads, starttime, sid };
}

/** 多い順。上限を超えた分は {@link ZOMBIE_COMMAND_OTHER_LABEL} へまとめる（黙って切り捨てない）。 */
function topZombieCommands(counts: Map<string, number>): Array<{ command: string; count: number }> {
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length <= ZOMBIE_COMMAND_LIMIT) {
    return sorted.map(([command, count]) => ({ command, count }));
  }
  const top = sorted.slice(0, ZOMBIE_COMMAND_LIMIT);
  const restCount = sorted.slice(ZOMBIE_COMMAND_LIMIT).reduce((sum, [, count]) => sum + count, 0);
  return [
    ...top.map(([command, count]) => ({ command, count })),
    { command: ZOMBIE_COMMAND_OTHER_LABEL, count: restCount },
  ];
}
