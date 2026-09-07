import type { ManagerSummary } from './manager.js';
import type { RunnerLiveness } from './runner-protocol.js';

/**
 * クローンのターンの入口（`clone.ts` の `#runTurn`）に載せる「いまの全体」。
 *
 * ## なぜ在るのか（この節が塞いでいる穴）
 *
 * **クローンは、自分が空いていることに気づけない。** 実測（2026-09-05）で、
 * runner 3台が `connected` のまま `runner_list` の47本のマネージャーが全部
 * `[done]` で、能動的に動いていたのは1本だけだった。それでもクローンの側には
 * 何も見えていない——クローンを起こす合図は7型あり、そのうち**全体が載るのは
 * digest を持つ3つ（日報・継続中の依頼・発意 tick）だけ**で、`manager_message`
 * （報告・質問・許可確認）のプロンプトには稼働本数も器の状態も1文字も入らない。
 * 終端（最後の `report`）に至っては、それが最後だということすら伝えない。
 *
 * ## 置き場所は「ターンの入口」である
 *
 * `clone.ts` の `#redeliveryNotice` / `#commitmentNotice` が逐語で持っている
 * 理由と同じ——**プロンプトの組み立ては起点の数だけ散っていて、どれか1か所へ
 * 入れ忘れると、その起点にだけ全体の見えないターンが生まれる。ターンの入口は
 * 1か所しかない。**
 *
 * ## `#commitmentNoticeFor` に混ぜない
 *
 * あちらは**台帳**（引き受けたまま終わっていない仕事）の話で、こちらは
 * **委譲と器の現在の状態**の話である。材料の器も、読めなかったときの倒れ先も
 * 違う（あちらは空文字を返してターンを進める＝節が消える。こちらは
 * 「数えられなかった」と書いた行を必ず出す。下の {@link describeSituationUnavailable}）。
 * `turn-input.ts` が逐語で言う「**規則が違うものを同じ場所に置かない**」に従い、
 * 別の組み立て関数として隣に置く。
 *
 * ## 「空き枠」を作らない（north_star 禁止2）
 *
 * クローンからは「枠がいくつ空いているか教えてほしい」と要望が出ているが、
 * **この repo に「枠」「定員」は意図的に存在しない。** `runner-protocol.ts` は
 * 資源の欄を `capacity` と名付けないことを逐語で意図だと書いており、
 * `apps/runner/src/app.ts` の `/health` は「あと何本置けるか」に答えないと書き、
 * `runner-count-equivalence.test.ts` は「定員で断らない」を歯で固定している。
 * **⟹ ここが出すのは観測値の軸だけである**——「手が空いている」は「置ける」
 * ではなく「そのマネージャーが手を動かしていない」であって、置けるかどうかは
 * 1文字も答えない。
 *
 * ## 指図を書かない
 *
 * 「空いているから何か始めろ」「新しい委譲を置け」の類は1文字も書かない。
 * 出すのは**数と、その数が何を意味しないかの断り**だけで、何をするかは
 * クローンが記憶と台帳に照らして決める（`#commitmentNoticeFor` が
 * 「どれを先にやるかは……毎回決め直すこと」と書いているのと同じ線である）。
 *
 * ## 起床を増やさない
 *
 * ここが足すのは**既に走ると決まったターンの本文**だけである。新しい受信箱
 * イベントも、新しい `post` も、新しいポーラーも1つも足していない。
 */

/** ターンの入口へ載せる節の先頭（後から grep で全部拾えるように固定する）。 */
const SITUATION_HEAD = '[system] いまの全体';

/**
 * 委譲の数え上げ。**5つの区分は同じ1回の数え上げの「分割」である**——どの
 * マネージャーもちょうど1つに入り、合計は `total` に一致する。
 *
 * `reachable`（話しかけられる）だけは**分割ではなく横断する軸**である。
 * 走行中でも返事待ちでも `live` は立ちうるので、他の5つと足し合わせないこと。
 */
export interface ManagerSituationCounts {
  readonly total: number;
  /** `status === 'running'`。**「進んでいる」ではない**（`describeManagerCounts` と同じ断り）。 */
  readonly running: number;
  /** `status === 'waiting_human'`。 */
  readonly waitingHuman: number;
  /**
   * 背景処理（`run_in_background` の子・作業者への委譲）の完了待ちで畳んだ報告が
   * 握り潰されているもの（`ManagerSummary.awaitingBackground`）。
   *
   * **器が名乗った分だけである。** この欄を送らない古い runner では、実際に
   * 待っていてもここには数えられない（`runner-protocol.ts` の
   * `report.awaitingBackground` の `.optional()` の doc）。
   */
  readonly awaitingBackground: number;
  /**
   * **手が空いている**＝ `status === 'done'` かつ背景処理待ちではなく、かつ
   * `live`（このデーモンから話しかけられる）。
   *
   * **「置ける」ではない。** 置けるかどうかはこの数からは決まらない
   * （このファイル冒頭の「空き枠を作らない」）。
   */
  readonly idle: number;
  /** 上の4つのどれでもないもの（終端したもの・`done` だが話しかけられないもの）。 */
  readonly other: number;
  /** `live` が立っているもの（**上の5つと足し合わせない**。横断する軸である）。 */
  readonly reachable: number;
}

/**
 * `ManagerSummary` の並びを数える。**分類は上から順に「最初に当たったもの」で
 * 決め、区分どうしを重ねない。**
 *
 * **背景処理待ちを `status` より先に見る。** `case 'report'`（`manager.ts`）は
 * `record.job.status = event.status;` を `awaitingBackground` の分岐より前に
 * 実行するので、握り潰された回の `status` は必ず `'done'` へ潰れている——
 * `status` を先に見ると、この区分が `idle`（手が空いている）へ吸い込まれて
 * **この節が答えようとしている問いそのものが消える。**
 */
export function countManagerSituation(managers: readonly ManagerSummary[]): ManagerSituationCounts {
  let running = 0;
  let waitingHuman = 0;
  let awaitingBackground = 0;
  let idle = 0;
  let other = 0;
  let reachable = 0;
  for (const manager of managers) {
    if (manager.live) reachable += 1;
    if (manager.awaitingBackground !== undefined) awaitingBackground += 1;
    else if (manager.status === 'running') running += 1;
    else if (manager.status === 'waiting_human') waitingHuman += 1;
    else if (manager.status === 'done' && manager.live) idle += 1;
    else other += 1;
  }
  return {
    total: managers.length,
    running,
    waitingHuman,
    awaitingBackground,
    idle,
    other,
    reachable,
  };
}

/**
 * 器の state ごとの本数。**`RunnerLiveness` の6値は畳まない**（`manager.ts` の
 * `RunnerOverview` の doc——`unreachable` / `unusable` / `lost` / `vacating` の
 * 違いはクローンの判断材料そのものである）。
 *
 * **並びは渡された順ではなく、最初に現れた順で固定する。** `Map` の反復順は
 * 挿入順なので、同じ器の集まりなら同じ並びが出る。
 */
export function countRunnerStates(
  runners: readonly { readonly state: RunnerLiveness }[],
): ReadonlyMap<RunnerLiveness, number> {
  const byState = new Map<RunnerLiveness, number>();
  for (const runner of runners) byState.set(runner.state, (byState.get(runner.state) ?? 0) + 1);
  return byState;
}

/**
 * ターンの入口へ載せる節を組み立てる。**I/O をしない純関数である**——呼び出し側
 * （`clone.ts` の `#situationNoticeFor`）が `ManagerPool` を読んでから渡す
 * （`runner-swap-notice.ts` の `decideRunnerSwapNotice` と同じ作法。判定と
 * 副作用を分けておけば、分岐それぞれに歯を直接通せる）。
 *
 * ## 0 を書く軸と、書かない軸（軸ごとに規則が違う）
 *
 * **委譲の行は 0 でも全部書く。** 5つの区分は同じ1回の数え上げの分割で、合計
 * （`全 N 本`）も並んでいるので、「0 と書いた」を「数えていない」と読む余地が
 * 無い。そして**「手が空いている」の行を消すと、この節が在る理由そのものが
 * 消える**——0件でも必ず1行出す `describeInboxBacklog`（`tools.ts`）が #562 で
 * 直したのと同じ形で、行が無いことは「機能が無い」と同じ顔になる。
 *
 * **器の行は、0 の state を書かない。** こちらは `RunnerLiveness` の6値ぜんぶを
 * 毎ターン並べると、行が「state の一覧」に化けて実際に居る state が読みにくく
 * なる。台数の合計（`器 N 台`）は必ず書くので、ここでも「数えていない」とは
 * 読めない——`describeManagerCounts`（`tools.ts`）が「0 の行は作らない」を
 * 選んでいるのと同じ規則である。
 *
 * **どちらの行も、数えられなかったときは 0 で埋めない。** そのときはこの関数を
 * 呼ばず、{@link describeSituationUnavailable} が「数えられなかった」と名乗る
 * 行を出す（`runner-swap-notice.ts` の `affected: number | undefined` —— 数え
 * 切れたときだけ本数——と同じ向きの判断である）。
 */
/**
 * 認証トークンの1行（人間の決定 2026-09-07）。**数えた材料だけを書く。**
 *
 * ## なぜ毎ターン注入するのか —— クローンが「枠が塞がっている」を*記憶*から書いた
 *
 * 実運用の事故（2026-09-07）: 巡回の番でクローンが**新しい委譲を1本も出さず**、
 * 理由をこう書いた ——
 *
 * > 枠が JST 19:30 まで塞がっているので、出しても1手も始まらずに落ちます。
 *
 * **その 19:30 は、既に降りた鍵（`production`）の reset である。** そのとき現役は
 * `staging` で、記録の上では `ready` だった。⟹ **前提が事実と違っていた。**
 *
 * 前提が作られた機構は3つ重なっている:
 *
 * 1. **毎ターンの文脈に鍵の話が1文字も無かった**（この関数が無かった）⟹ 手元の
 *    材料は自分が食らった 429 の文言だけになる
 * 2. **その文言は「アカウントの枠」ではなく「そのとき走っていた鍵の枠」である。**
 *    回っても文言は文脈に残るので、**降りた鍵の事実が現在形で読まれる**
 * 3. 回転は受信箱へ入らない（人間の決定 2026-08-25。2026-09-07 に「通る鍵に
 *    戻った」だけ覆した）⟹ 鍵が変わったことを否定する材料が文脈に来ない
 *
 * **⟹ 直すのは判断ではなく材料である。** 事実を隣に置けば、記憶から書けなくなる。
 *
 * ## ⭐ 「枠を理由に見送る」は、書ける状況では必ず偽である
 *
 * これは推論ではなく機構から出る**不変条件**である ——
 * **枠が閉じているあいだ、クローンのターンは1つも走らない**
 * （逐語は `grep -Fn -- '枠（利用上限）が閉じている間はターンを回さない' packages/core/src/clone.ts`）。
 *
 * ⟹ **クローンが何かを書けているなら、枠は全面的には閉じていない。**
 * だから最後の行でそれを名指しする（{@link TOKEN_INVARIANT}）。
 *
 * ## ⚠️ 「だから必ず通る」とは書かない
 *
 * このターンが走っていることが証明するのは「**このセッションが持っている鍵**が
 * いま受け入れられている」までで、これから起こす委譲が受け取る**現役の鍵**が通ると
 * は言えない（世代がずれている状態が実際にあった）。⟹ 言えるのは
 * **「1手も始まらない、とは言えない」**までである。**確実性を反転させないこと。**
 */
export function describeTokenSituation(input: {
  /** プールの行（外向きの顔。**値は持たない**）。読めなかったときは `undefined`。 */
  readonly tokens: readonly TokenSituationRow[] | undefined;
  /** 現役の指名。まだ一度も回していなければ `null`。読めなかったときは `undefined`。 */
  readonly active: { readonly tokenId: string } | null | undefined;
  /** 判定の基準時刻（epoch ミリ秒）。 */
  readonly at: number;
}): string {
  // **読めなかったことを 0 や「無し」で埋めない**（`AGENTS.md` の地雷
  // 「取れない軸に 0 の行を作る」）。**それでも不変条件の行は落とさない** ——
  // あれはプールの状態に依存しないので、読めなくても真である。
  if (input.tokens === undefined || input.active === undefined) {
    return (
      '認証トークン: **プールを読めなかった**（塞がっているかどうかは、ここからは言えない）。' +
      TOKEN_INVARIANT
    );
  }

  const ready = input.tokens.filter((row) => tokenStateOf(row, input.at) === 'ready');
  const cooling = input.tokens.filter((row) => tokenStateOf(row, input.at) === 'cooling');
  const withheld = input.tokens.length - ready.length - cooling.length;
  const active = input.active;

  const current = ((): string => {
    if (active === null) {
      // **「1本目が現役」と書かない**（`TokenPoolStore.readActive` の doc）。
      return '現役の指名は**まだ一度も無い**（器の環境変数のまま走っている）';
    }
    const row = input.tokens.find((token) => token.id === active.tokenId);
    if (row === undefined) {
      return '現役として記録された行がプールに無い（人間が消した）';
    }
    const state = tokenStateOf(row, input.at);
    const until =
      state === 'cooling' && row.cooldownUntil !== undefined
        ? '。冷却明けは ' + new Date(row.cooldownUntil).toISOString()
        : '';
    return '現役は「' + row.label + '」（記録の上では ' + TOKEN_STATE_LABEL[state] + until + '）';
  })();

  return (
    '認証トークン: ' +
    current +
    '。プール ' +
    String(input.tokens.length) +
    ' 本: いま使える ' +
    String(ready.length) +
    ' / 冷却中 ' +
    String(cooling.length) +
    ' / 外されている ' +
    String(withheld) +
    '。' +
    TOKEN_INVARIANT
  );
}

/** {@link describeTokenSituation} が見る列だけ。**値は受けない。** */
export interface TokenSituationRow {
  readonly id: string;
  readonly label: string;
  readonly disabledAt?: string;
  readonly invalidatedAt?: string;
  readonly cooldownUntil?: number;
}

const TOKEN_STATE_LABEL: Record<'ready' | 'cooling' | 'disabled' | 'invalidated', string> = {
  ready: '使える',
  cooling: '冷却中',
  disabled: '人間が外している',
  invalidated: '失効',
};

/**
 * **枠を理由に見送らないための1行。** プールの状態に依存しないので、読めなかった
 * 回でも落とさない（{@link describeTokenSituation} の doc「不変条件」）。
 *
 * **⚠️ 「必ず通る」へ反転させないこと。** 言えるのは「1手も始まらない、とは
 * 言えない」までである（同じ doc の最後の節）。
 */
const TOKEN_INVARIANT =
  '\n**⚠️ 枠を理由に仕事を見送らないこと。** 枠が閉じているあいだ、あなたのターンは' +
  '1つも走らない（`#usageBlocked`）—— **いまあなたが書けているなら、枠は全面的には' +
  '閉じていない。** ⟹「枠が塞がっているので何もしない」は、書ける状況では必ず偽である。' +
  'そして**過去に受け取った上限の文言は、既に降りた鍵についての事実でありうる**' +
  '（回っても文言は文脈に残る）—— 現役の状態は上の行か `token_list` で見る。' +
  '**冷却中でも「1手も始まらない」とは言えない**（記録の冷却は観測から書いた見立てで、' +
  '実際に通るかは試すまで分からない）。**心配なら本数を絞る。見送りは選ばない。**';

/** {@link TokenSituationRow} から状態を出す。**判定順を崩さないこと。** */
function tokenStateOf(
  row: TokenSituationRow,
  at: number,
): 'ready' | 'cooling' | 'disabled' | 'invalidated' {
  if (row.disabledAt !== undefined) return 'disabled';
  if (row.invalidatedAt !== undefined) return 'invalidated';
  if (row.cooldownUntil !== undefined && row.cooldownUntil > at) return 'cooling';
  return 'ready';
}

export function describeSituation(input: {
  readonly managers: readonly ManagerSummary[];
  readonly runners: readonly { readonly state: RunnerLiveness }[];
  /**
   * 認証トークンの材料（人間の決定 2026-09-07）。**省略できる** ——
   * 省略すると鍵の行が出ない（既存の呼び出しを1つも壊さない）。
   */
  readonly tokens?: readonly TokenSituationRow[] | undefined;
  readonly active?: { readonly tokenId: string } | null | undefined;
  readonly at?: number;
}): string {
  const counts = countManagerSituation(input.managers);
  const byState = countRunnerStates(input.runners);
  const runnerBreakdown = [...byState.entries()]
    .map(([state, count]) => `${state} ${count}`)
    .join(' / ');
  return block([
    `${SITUATION_HEAD}（数えた材料だけ。ここから何をするかは決めない）。`,
    `委譲 全 ${counts.total} 本: 走行中 ${counts.running} / 返事待ち ${counts.waitingHuman} / ` +
      `背景処理待ち ${counts.awaitingBackground} / 手が空いている ${counts.idle} / ` +
      `その他 ${counts.other}。話しかけられるのは ${counts.reachable} 本。`,
    `器 ${input.runners.length} 台${runnerBreakdown === '' ? '' : `: ${runnerBreakdown}`}。`,
    '**「手が空いている」は「空き枠」ではない** — この器に定員は無いので、' +
      '置けるかどうかはここでは答えていない。' +
      '**「背景処理待ち」は器が名乗った分だけである** — この印を送らない古い器では、' +
      '待っていても「手が空いている」側に数える。' +
      '**「走行中」は「進んでいる」ではない。**' +
      '「その他」は終端したもの（failed / lost / stopped）と、done だが話しかけられないものである。' +
      '個別の状態は `manager_list` / `runner_list` で見る。',
    // **鍵の行は最後に置く。** 数えた材料（委譲・器）の後に、判断を縛る不変条件が
    // 来る順にしてある（{@link describeTokenSituation}）。**省略した呼びでは出ない。**
    ...(input.tokens === undefined && input.active === undefined
      ? []
      : [
          describeTokenSituation({
            tokens: input.tokens,
            active: input.active,
            at: input.at ?? Date.now(),
          }),
        ]),
  ]);
}

/**
 * 数えられなかったときの節。**行を消さず、0 でも埋めない。**
 *
 * `describeSituation` が出す形と**見分けが付くこと**がこの関数の全部である
 * ——`AGENTS.md` の地雷「取れない軸に 0 の行を作る」がそのまま当たる場所で、
 * 0 で埋めれば「全部片付いている」と読める（いちばん見落としたい向きへ倒れる）。
 * `runner-swap-notice.ts` が `'none-affected'`（0本と数え切れた）と
 * `'ledger-unreadable'`（数えられなかった）を型で分けているのと同じ理由である。
 */
export function describeSituationUnavailable(error: unknown): string {
  return block([
    `${SITUATION_HEAD}を数えられなかった: ${String(error)}`,
    'これは「全部片付いている」ではなく「**数えられなかった**」である。' +
      '本数が要るなら `manager_list` / `runner_list` を自分で呼ぶこと。',
  ]);
}

/**
 * 節を1つの塊にする。**末尾の区切り（`---`）まで含めて返す**——
 * `#commitmentNoticeFor`（`clone.ts`）が同じ形（`'', '---', ''` で終わる配列を
 * `join('\n')` する）で返しており、区切りを呼び出し側で足す形にすると、節を1つ
 * 足すたびに `#runTurn` の連結の側にも手が要る。
 */
function block(lines: readonly string[]): string {
  return [...lines, '', '---', ''].join('\n');
}
