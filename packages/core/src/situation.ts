// lost の判定はここで書き下ろさず isManagerAwaitingJudgement から取る: 2箇所に status === 'lost' を書くと分け方が割れるため
import { isManagerAwaitingJudgement } from './digest.js';
import { reasonOf } from './dropped-record.js';
import {
  INBOX_BACKLOG_LOUD_THRESHOLD,
  describeInboxBacklogQueuedInMemory,
  foldInboxBacklogByType,
} from './inbox-backlog.js';
import type { InboxBacklogBreakdown } from './inbox-backlog.js';
import type { ManagerSummary } from './manager.js';
import type { RunnerLiveness } from './runner-protocol.js';
import type { CooldownSource } from './token-pool.js';
import { RESTART_BEFORE_CHECK_ADVICE_CODE_SPAN } from './usage-limits.js';

// 節はターンの入口に置く: プロンプトの組み立ては起点の数だけ散っていて、1か所入れ忘れるとその起点にだけ全体の見えないターンが生まれるため。
// #commitmentNoticeFor に混ぜない: 材料の器も読めなかったときの倒れ先も違い、規則が違うものを同じ場所に置かないため。
// 「空き枠」を作らない: 「手が空いている」は「置ける」ではなく、置けるかどうかは答えないため。
// 指図を書かない: 出すのは数と、その数が何を意味しないかの断りだけにするため。
// 起床を増やさない: 新しい受信箱イベントも post もポーラーも足さず、既に走ると決まったターンの本文だけに足すため

// 後から grep で全部拾えるように固定する
const SITUATION_HEAD = '[system] いまの全体';

// 数えた時刻を名乗る: 節は会話履歴に溜まり、数が変わらなければ古い節と新しい節が1バイトも違わず、どれが最新か判定できないため。
// 秒までしか出さず日付を出さない: 毎ターンの文字数を増やさないことを優先したため。
// export して使い回す: 同じ判定関数を2つ持つと、片方だけ直して忘れる形が再発するため
export function readAtLabel(at: number): string {
  return `${new Date(at).toISOString().slice(11, 19)}Z`;
}

// status の綴りを括弧で添える: 本数の隣に無いと、日本語の見出しから status の値を推測することになるため
const LOST_LABEL = '戻れなかった(lost)';

// 「起こし直せ」と書かない: 確かめる前に manager_start を撃つと同じ仕事が2本になるため。
// 本数ではなく到達口を書く: 本数だけだと名指しできず、manager_list の本文は予算で切られるので status で絞る綴りを渡すため
const LOST_NOTICE =
  `**${LOST_LABEL} は「終わった」ではない。** 見ているのは「前のセッションへ戻れたか」だけで、` +
  '**成果の有無は1度も観測していない** — 落ちる前に成果が既に外へ出ていた（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）' +
  '実例がある。⟹ 誰かがそこを確かめるまで終われない。' +
  '名指しで引くなら `manager_list` に status: ["lost"] を渡す（絞りは文字数の予算より前に効くので、' +
  '古いものも本文に出る）。中身は `manager_report <managerId>` で読める。' +
  RESTART_BEFORE_CHECK_ADVICE_CODE_SPAN;

// status の区分にしない: 軸の実体は lastFailure で status と独立に立ち、枠(429)で畳まれた回も status は done のままのため
const LAST_FAILURE_LABEL = '直近のターンが失敗で終わっている';

// idle から外さない: 外すと「置けない」と読まれ、空き枠を作らない原則を壊すため。
// status で切り出せると書かない: この軸には絞りの綴りが無く、引けるのは各行の ⚠ だけのため
const LAST_FAILURE_NOTICE =
  `**${LAST_FAILURE_LABEL}委譲は、区分の中では見分けが付かない。** ` +
  'とくに `done`（手が空いている）が数えているのは「ターンが1回終わった」ことだけで、' +
  'そのターンが枠(429)などの失敗で畳まれた回も同じ `done` に座る' +
  '——セッションは生きているので `status` は動かさない（それは仕様である）。' +
  '⟹ **この本数のぶん、「手が空いている」は「仕事を終えて空いた」を意味しない。** ' +
  '名指しで引くなら `manager_list` の各行に付く ⚠（`直近のターンは報告ではなく失敗で終わっている`）を見る' +
  '——**この軸で絞る綴りは無い**（`status` の値ではないので絞りでは切り出せない）。' +
  '中身は `manager_report <managerId>` で読める。';

// lastTurnFailed と排他にしない: 利用上限で止まった委譲は通常 lastTurnFailed 側にも数えられ、走行中は usage_notice が先に届いて重ならないこともあり、片方からもう一方を推測できないため
const USAGE_STOPPED_LABEL = '枠(利用上限)で止まっている';

// idle から外さない: 外すと「置けない」と読まれ、空き枠を作らない原則を壊すため。
// 「ずっと done/running のまま座る」と書き切らない: 印が下りる前に failed / lost / stopped へ確定することがあり、集計からは見分けられないため
const USAGE_STOPPED_NOTICE =
  `**${USAGE_STOPPED_LABEL}委譲は、区分の中では見分けが付かない。** ` +
  '通常は鍵が回ってこの委譲が起こし直されるまで、その間ずっと `done`（手が空いている）または' +
  '`running` のまま座る——セッションが生きている間は `status` を動かさない（それは仕様である）。' +
  '⟹ **この本数のぶん、「手が空いている」は「仕事を終えて空いた」を意味しない。** ' +
  '**ただし、印が下りる前にセッションそのものが `failed` / `lost` / `stopped` として' +
  '畳まれることがある**（Issue #1796）——その回は `status` がそちらへ確定していて、' +
  'この本数の集計だけではどの委譲がそれかは見分けられない。' +
  `${LAST_FAILURE_LABEL}（上）と重なることが多いが同じ軸ではない` +
  '——あちらは失敗の理由を問わない全体、こちらは利用上限に当たった委譲だけを名指しする。' +
  '中身は `manager_report <managerId>` で読める' +
  '——絞りでは切り出せないが（`status` の値ではないため）、' +
  '`manager_list` の各行に付く注記（⚠ 枠(利用上限)で止まっている）で名指しされる' +
  '（`status` も一緒に読めば、生きているか否かはその行だけで判定できる）。';

// lost に数えない: lost は resume を試して戻れなかったと確かめた事実に付く名前で、器の判定がそこまで進んでいない委譲は lost の絞りに掛からないため
const RUNNER_VANISHED_LABEL = '宛先の runner が名簿から entry ごと消えている';

// running から外さない: 外すと「置けない」と読まれ、空き枠を作らない原則を壊すため
const RUNNER_VANISHED_NOTICE =
  `**${RUNNER_VANISHED_LABEL}委譲は、\`manager_list status: ["lost"]\` の絞りでは見えない。** ` +
  '`lost` が数えているのは「resume を試して前のセッションへ戻れなかった」という' +
  '確かめた事実だけで、この本数は器（runner）が黙って名簿から entry ごと消えたのに' +
  '`status` は `running` のまま残っているものである' +
  '——`isLive()` は動かしていない（宛先を失っていても `sessionId` が残っていれば' +
  '`manager_send` で resume を試せることがある）。' +
  `⟹ **${RUNNER_VANISHED_LABEL}分は、必ず「走行中」の内側に座る**（区分とは足し合わせない）。` +
  '名指しで引くなら `manager_list` の各行に付く注記（⚠ 宛先の runner が名簿から消えている）を見る' +
  '——絞りでは切り出せない（`status` の値ではないため）。' +
  '中身は `manager_report <managerId>` で読める。';

// 横断する軸（reachable / lastTurnFailed* / usageStopped* / runnerVanished）を6つの区分と足し合わせない: status と独立に立ち、走行中にも返事待ちにも重なりうるため。
// lost を other に入れない: 毎ターン載る節で other に潰れて、どの面からも本数が読めなかったため。
// lastTurnFailed / usageStopped を区分にしない: done のまま座るのは仕様で、idle から外すと「置けない」と読まれるため。
// lastUnreported / lastSystemError を lastTurnFailed に畳まない: 別の軸で、畳むと本数と ⚠ 行がまた食い違うため。
// *Idle に割る: 食い違いが起きるのは「手が空いている」と並んだときだけのため
export interface ManagerSituationCounts {
  readonly total: number;
  readonly running: number;
  readonly waitingHuman: number;
  readonly awaitingBackground: number;
  readonly idle: number;
  readonly lost: number;
  readonly other: number;
  readonly reachable: number;
  readonly lastTurnFailed: number;
  readonly lastTurnFailedIdle: number;
  readonly usageStopped: number;
  readonly usageStoppedIdle: number;
  // runnerVanished に idle 側の部分集合を作らない: status === 'running' のときしか立たず、値が常に 0 になる軸の行を作ることになるため
  readonly runnerVanished: number;
}

// 背景処理待ちを status より先に見る: case 'report' は status を awaitingBackground の分岐より前に書くので握り潰された回の status は done へ潰れており、先に status を見ると idle へ吸い込まれて問いが消えるため。
// lost は背景処理待ちより後ろで見る: 印が立ったまま lost へ落ちた回で、握り潰しのほうが消えるため
export function countManagerSituation(managers: readonly ManagerSummary[]): ManagerSituationCounts {
  let running = 0;
  let waitingHuman = 0;
  let awaitingBackground = 0;
  let idle = 0;
  let lost = 0;
  let other = 0;
  let reachable = 0;
  let lastTurnFailed = 0;
  let lastTurnFailedIdle = 0;
  let usageStopped = 0;
  let usageStoppedIdle = 0;
  let runnerVanished = 0;
  for (const manager of managers) {
    if (manager.live) reachable += 1;
    // 区分の分岐より前に数える: 横断する軸を else if の鎖に混ぜると、どの区分に入ったかでこの軸が落ちるため
    if (manager.lastFailure !== undefined) lastTurnFailed += 1;
    if (manager.usageStoppedAt !== undefined) usageStopped += 1;
    if (manager.runnerVanished !== undefined) runnerVanished += 1;
    if (manager.awaitingBackground !== undefined) awaitingBackground += 1;
    else if (manager.status === 'running') running += 1;
    else if (manager.status === 'waiting_human') waitingHuman += 1;
    else if (manager.status === 'done' && manager.live) {
      idle += 1;
      // idle の枝の中で数える: 外側で条件を書き直すと、status が done へ潰れた握り潰しの回（awaitingBackground）までここへ数えることになるため
      if (manager.lastFailure !== undefined) lastTurnFailedIdle += 1;
      if (manager.usageStoppedAt !== undefined) usageStoppedIdle += 1;
    } else if (isManagerAwaitingJudgement(manager.status)) lost += 1;
    else other += 1;
  }
  return {
    total: managers.length,
    running,
    waitingHuman,
    awaitingBackground,
    idle,
    lost,
    other,
    reachable,
    lastTurnFailed,
    lastTurnFailedIdle,
    usageStopped,
    usageStoppedIdle,
    runnerVanished,
  };
}

// 実測（4時間36分）より意図して短く取る: 低稼働が事故の水準へ育つ前に、少なくとも1回は「0本」を見せるため。
// 閾値と ⚠ を持たせない: 持たせた瞬間、この節が低稼働を判定する側へ回るため。出すのは数え上げの材料だけで、判定はクローンに委ねる
export const RECENT_MANAGER_START_WINDOW_MS = 3 * 60 * 60 * 1000;

const RECENT_MANAGER_START_WINDOW_HOURS = RECENT_MANAGER_START_WINDOW_MS / (60 * 60 * 1000);

// at を自分で引き直さない: この節が名乗る「いつ数えたか」と数えた瞬間がずれ、1つの節が2つの「いま」を持つため。
// 壊れた startedAt は数えず専用の「読めなかった」状態も持たせない: startedAt は job.createdAt を直接写すだけで壊れる経路が無いため
export function countRecentManagerStarts(managers: readonly ManagerSummary[], at: number): number {
  const from = at - RECENT_MANAGER_START_WINDOW_MS;
  let count = 0;
  for (const manager of managers) {
    const startedAtMs = Date.parse(manager.startedAt);
    if (Number.isNaN(startedAtMs)) continue;
    if (startedAtMs >= from && startedAtMs <= at) count += 1;
  }
  return count;
}

// 窓を掛けない: 窓の外にこそ値が要り、掛けるといちばん見たい「直近の開始が窓の外にあること」が消えるため。
// 1本も居ない・全部 NaN なら undefined: 「経過を言えない」を 0 や -Infinity のような偽の値と取り違えない形で返すため
export function latestManagerStartAt(managers: readonly ManagerSummary[]): number | undefined {
  let latest: number | undefined;
  for (const manager of managers) {
    const startedAtMs = Date.parse(manager.startedAt);
    if (Number.isNaN(startedAtMs)) continue;
    if (latest === undefined || startedAtMs > latest) latest = startedAtMs;
  }
  return latest;
}

// 既存の経過の字面関数と共有しない: 新しい依存を増やさず、丸め方の粒度が違うため。
// 負の経過は「1分未満前」へ丸める: 経過を省くと「最後はいつだったか」の合図そのものが消えるため
function formatElapsedSinceLastStart(elapsedMs: number): string {
  const minutes = Math.floor(elapsedMs / 60000);
  if (minutes < 1) return '1分未満前';
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  if (hours < 24) return `${hours}時間${remainderMinutes}分前`;
  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return `${days}日${remainderHours}時間前`;
}

// RunnerLiveness の6値は畳まない: unreachable / unusable / lost / vacating の違いはクローンの判断材料そのものため
export function countRunnerStates(
  runners: readonly { readonly state: RunnerLiveness }[],
): ReadonlyMap<RunnerLiveness, number> {
  const byState = new Map<RunnerLiveness, number>();
  for (const runner of runners) byState.set(runner.state, (byState.get(runner.state) ?? 0) + 1);
  return byState;
}

// 委譲の5区分は 0 でも全部書く: 「手が空いている」の行を消すとこの節が在る理由そのものが消えるため。
// **`lost`（判断待ち）だけは、0 のときに書かない。** 他の5区分は0でも必ず出るので行が無いことは算術で 0 と確定し、毎ターン載る節に変わらない行を足すと変わる行が読まれなくなるため。この規則を残りの5区分へ広げない: あちらは 0 そのものが判断材料のため。
// 器の行は 0 の state を書かない: 6値ぜんぶを並べると state の一覧に化けて実際に居る state が読みにくくなるため。
// 数えられなかったときは 0 で埋めず、この関数を呼ばずに describeSituationUnavailable が「数えられなかった」と名乗る
// 「必ず通る」へ反転させない: 現役の鍵が通るとは言えず、言えるのは「1手も始まらない、とは言えない」までのため
export function describeTokenSituation(input: {
  readonly tokens: readonly TokenSituationRow[] | undefined;
  readonly active: { readonly tokenId: string } | null | undefined;
  readonly at: number;
}): string {
  // 読めなかったことを 0 や「無し」で埋めない。それでも不変条件の行は落とさない: プールの状態に依存しないので、読めなくても真のため。
  // tokens と active を1つの「プールを読めなかった」に潰さない: tokens が読めていた回にも「読めなかった」という嘘が出るため
  if (input.tokens === undefined) {
    return (
      '認証トークン: **プールを読めなかった**（塞がっているかどうかは、ここからは言えない）。' +
      TOKEN_INVARIANT
    );
  }

  const ready = input.tokens.filter((row) => tokenStateOf(row, input.at) === 'ready');
  const cooling = input.tokens.filter((row) => tokenStateOf(row, input.at) === 'cooling');
  // disabled と invalidated を1つの「外されている」へ合算しない: token_list が別の語で分けており、プール全体の内訳だけが潰れるため
  const disabled = input.tokens.filter((row) => tokenStateOf(row, input.at) === 'disabled');
  const invalidated = input.tokens.filter((row) => tokenStateOf(row, input.at) === 'invalidated');
  const active = input.active;

  const current = ((): string => {
    if (active === undefined) {
      // 「プールを読めなかった」と書かない: 読めた内訳と同じ行の中で矛盾した2つの主張が並ぶため
      return '**現役の指名を読めなかった**（プールの内訳は下のとおり読めている）';
    }
    if (active === null) {
      // 「1本目が現役」と書かない（TokenPoolStore.readActive の doc）
      return '現役の指名は**まだ一度も無い**（器の環境変数のまま走っている）';
    }
    const row = input.tokens.find((token) => token.id === active.tokenId);
    if (row === undefined) {
      return '現役として記録された行がプールに無い（人間が消した）';
    }
    const state = tokenStateOf(row, input.at);
    const until =
      state === 'cooling' && row.cooldownUntil !== undefined
        ? '。冷却明けは ' +
          new Date(row.cooldownUntil).toISOString() +
          // 出所を添える: その期限が推測なのかどうかが判断に効くため
          '（' +
          (TOKEN_COOLDOWN_SOURCE_LABEL[row.cooldownSource ?? 'unrecorded'] ?? '出所の記録が無い') +
          '）'
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
    // 語は TOKEN_STATE_LABEL を使い回す: 文言を複製すると token_list 側の語と字面が割れるため
    ' / ' +
    TOKEN_STATE_LABEL.disabled +
    ' ' +
    String(disabled.length) +
    ' / ' +
    TOKEN_STATE_LABEL.invalidated +
    ' ' +
    String(invalidated.length) +
    '。' +
    TOKEN_INVARIANT
  );
}

// 値は受けない
export interface TokenSituationRow {
  readonly id: string;
  readonly label: string;
  readonly disabledAt?: string;
  readonly invalidatedAt?: string;
  readonly cooldownUntil?: number;
  // 既定で埋めない: 「推測だと観測した」という嘘になるため
  readonly cooldownSource?: CooldownSource;
}

// 入れ子の三項演算子で書かず Record にする: 値が増えたとき tsc が落ち、新しい値だけが静かに嘘を言わないため。
// unrecorded を鍵に持つ: 「出所が無い」は取れなかったことで、default（推測だと観測した）ではないため
const TOKEN_COOLDOWN_SOURCE_LABEL: Record<CooldownSource | 'unrecorded', string> = {
  quota_reset: '出所は枠のリセット時刻（権威ある値）',
  overage_reset: '出所は課金枠のリセット時刻（権威ある値）',
  notice_text: '**出所は上限の文言に書かれていた時刻。推測である**',
  default: '**出所は設定の既定。ただの推測である**',
  unrecorded: '出所の記録が無い',
};

const TOKEN_STATE_LABEL: Record<'ready' | 'cooling' | 'disabled' | 'invalidated', string> = {
  ready: '使える',
  cooling: '冷却中',
  disabled: '人間が外している',
  invalidated: '失効',
};

// 枠が閉じているあいだクローンのターンは走らないので、書けているなら枠は全面的には閉じていない。プールの状態に依存しないので、読めなかった回でも落とさない
const TOKEN_INVARIANT =
  '\n**⚠️ 枠を理由に仕事を見送らないこと。** 枠が閉じているあいだ、あなたのターンは' +
  '1つも走らない（`#usageBlocked`）—— **いまあなたが書けているなら、枠は全面的には' +
  '閉じていない。** ⟹「枠が塞がっているので何もしない」は、書ける状況では必ず偽である。' +
  'そして**過去に受け取った上限の文言は、既に降りた鍵についての事実でありうる**' +
  '（回っても文言は文脈に残る）—— 現役の状態は上の行か `token_list` で見る。' +
  '**冷却中でも「1手も始まらない」とは言えない**（記録の冷却は観測から書いた見立てで、' +
  '実際に通るかは試すまで分からない）。**心配なら本数を絞る。見送りは選ばない。**';

// 判定順を崩さない
function tokenStateOf(
  row: TokenSituationRow,
  at: number,
): 'ready' | 'cooling' | 'disabled' | 'invalidated' {
  if (row.disabledAt !== undefined) return 'disabled';
  if (row.invalidatedAt !== undefined) return 'invalidated';
  if (row.cooldownUntil !== undefined && row.cooldownUntil > at) return 'cooling';
  return 'ready';
}

// 「読めなかった」と「0件」を同じ「行が無い」に潰さない: 受信箱の pending() は読めないことがあり、潰すと「読めなかった」が「0件」と見分けが付かなくなるため。
// 閾値 50: 詰まりとした28件の倍を超えたら、詰まりでは説明が付かないため。
// 指図を書かない・本文を載せない: 毎ターン載るので行の肥大がそのままトークンの肥大になるため。
// メモリの配達待ち行列を器の行数と合算しない: 器が詰まっているのかメモリの配達が詰まっているのか区別できなくなるため。
// typeBreakdown は閾値超えの回だけ埋める: 重い peekPending() を平常時に呼ばないため。見出しの件数と typeBreakdown.total は最大 events.length 件ずれうるので、行の文言に明記する
function describeSituationInboxBacklog(
  backlog:
    | {
        readonly count: number;
        readonly oldestAt?: string;
        readonly typeBreakdown?: InboxBacklogBreakdown;
      }
    | 'unreadable'
    | undefined,
): string | null {
  if (backlog === undefined) return null;
  if (backlog === 'unreadable') {
    // 0 という数字を書かない: 「数えられなかった」を「0件」と見分けられなくなるため
    return '受信箱の未処理を数えられなかった（`manager_list` で自分で引くこと）。';
  }
  if (backlog.count === 0) return null;
  const oldest =
    backlog.oldestAt === undefined ? '' : `（最も古いものは ${backlog.oldestAt} から）`;
  const base = `受信箱の未処理 ${backlog.count} 件${oldest}。`;
  if (backlog.count <= INBOX_BACKLOG_LOUD_THRESHOLD) return base;
  // 古い軸名（配達回数）を名乗らない: クローンが manager_list を引く前にその名前を覚え、誤った名前で読んだ数字から誤った結論が立つため
  if (backlog.typeBreakdown === undefined) {
    return (
      `⚠ ${base}` + '内訳（種類 / 同一本文 / 器の入れ替え回数 / 齢）は `manager_list` で割れる。'
    );
  }
  const typeLine = foldInboxBacklogByType(backlog.typeBreakdown.byType);
  // 読めない行が在るときはその数を言う: 言わないと、ずれの理由が「1件前後」に見えるため
  const unreadableCount = backlog.typeBreakdown.unreadable?.length ?? 0;
  const unreadableClause =
    unreadableCount === 0
      ? ''
      : `（このほか読めない行が ${unreadableCount} 件あり、この数にも種類にも入っていない。` +
        '壊れた行であって、処理済みではない。`manager_list` で id が分かる）';
  return (
    `⚠ ${base}種類: ${typeLine}` +
    `（器の生の行 ${backlog.typeBreakdown.total} 件を数えた${unreadableClause}——このターン自身の分は` +
    '引いていないので、上の件数と1件前後ずれることがある。本文は載せない。' +
    '残り（送信元 / 同一本文 / 器の入れ替え回数 / 齢）は `manager_list` で見る）。'
  );
}

export function describeSituation(input: {
  readonly managers: readonly ManagerSummary[];
  readonly runners: readonly { readonly state: RunnerLiveness }[];
  readonly tokens?: readonly TokenSituationRow[] | undefined;
  readonly active?: { readonly tokenId: string } | null | undefined;
  readonly at?: number;
  // 'unreadable' を「省略」と同じ undefined へ潰さない: 「0件」と見分けが付かなくなるため
  readonly backlog?:
    | {
        readonly count: number;
        readonly oldestAt?: string;
        readonly typeBreakdown?: InboxBacklogBreakdown;
      }
    | 'unreadable'
    | undefined;
  readonly queuedInMemory?: number | undefined;
}): string {
  const counts = countManagerSituation(input.managers);
  const byState = countRunnerStates(input.runners);
  const runnerBreakdown = [...byState.entries()]
    .map(([state, count]) => `${state} ${count}`)
    .join(' / ');
  const inboxBacklogLine = describeSituationInboxBacklog(input.backlog);
  const inboxQueuedLine = describeInboxBacklogQueuedInMemory(input.queuedInMemory);
  const at = input.at ?? Date.now();
  // at をそのまま渡す: ここで Date.now() を引き直すと、節が名乗る時刻とこの本数の観測時刻がずれるため
  const recentStarts = countRecentManagerStarts(input.managers, at);
  const latestStart = latestManagerStartAt(input.managers);
  const lastStartClause =
    latestStart === undefined
      ? ''
      : `（最後に起こしたのは ${formatElapsedSinceLastStart(at - latestStart)}）`;
  return block([
    `${SITUATION_HEAD}（${readAtLabel(at)} に数えた材料だけ。ここから何をするかは決めない）。`,
    // lost は「その他」の直前に置く: lost はそこから切り出したもので、隣に並べば「その他が減って lost が増えた」と読めるため
    `委譲 全 ${counts.total} 本: 走行中 ${counts.running} / 返事待ち ${counts.waitingHuman} / ` +
      `背景処理待ち ${counts.awaitingBackground} / 手が空いている ${counts.idle} / ` +
      (counts.lost === 0 ? '' : `${LOST_LABEL} ${counts.lost} / `) +
      `その他 ${counts.other}。話しかけられるのは ${counts.reachable} 本。` +
      // 横断する軸は分割の後ろに置く: 区分の並びの中へ差し込むと、足せば total になる数の列に別の軸が混ざるため
      (counts.lastTurnFailed === 0
        ? ''
        : `${LAST_FAILURE_LABEL}のは ${counts.lastTurnFailed} 本` +
          `（うち「手が空いている」に数えたものが ${counts.lastTurnFailedIdle} 本。` +
          '上の区分とは足し合わせない）。') +
      // lastTurnFailed の直後に置く: 離すと片方だけが「唯一の失敗の軸」に見えるため
      (counts.usageStopped === 0
        ? ''
        : `${USAGE_STOPPED_LABEL}のは ${counts.usageStopped} 本` +
          `（うち「手が空いている」に数えたものが ${counts.usageStoppedIdle} 本。` +
          '上の区分とは足し合わせない）。') +
      (counts.runnerVanished === 0
        ? ''
        : `${RUNNER_VANISHED_LABEL}のは ${counts.runnerVanished} 本` +
          '（必ず「走行中」の内側。上の区分とは足し合わせない）。') +
      // 0 本でも出す: 0 が合図で、閾値も ⚠ も持たないため
      `直近${RECENT_MANAGER_START_WINDOW_HOURS}時間に新しく起こした委譲: ${recentStarts} 本${lastStartClause}。`,
    // 断りは本数の直後に並べる: 数と、そこから何を確かめるかを離すと数だけが読まれるため。0 のときは1文字も出さない
    ...(counts.lost === 0 ? [] : [LOST_NOTICE]),
    ...(counts.lastTurnFailed === 0 ? [] : [LAST_FAILURE_NOTICE]),
    ...(counts.usageStopped === 0 ? [] : [USAGE_STOPPED_NOTICE]),
    ...(counts.runnerVanished === 0 ? [] : [RUNNER_VANISHED_NOTICE]),
    `器 ${input.runners.length} 台${runnerBreakdown === '' ? '' : `: ${runnerBreakdown}`}。`,
    '**「手が空いている」は「空き枠」ではない** — この器に定員は無いので、' +
      '置けるかどうかはここでは答えていない。' +
      // この一文は本数が 0 でも出す: 出ていないことが「数えていない」と読める余地が残り、横断する軸には算術で 0 と確定する手が無いため
      '**「手が空いている」は「終わった」でもない** — 直近のターンが報告ではなく' +
      '失敗で終わった委譲も `done` のまま座る（セッションが生きているためで、仕様である）。' +
      'その本数は1本以上あるときだけ上の行に出る。' +
      '**「手が空いている」は「枠が空いた」でもない** — 直近のターンが利用上限' +
      'そのもので止まった委譲も `done` のまま座る（鍵の回転を待っているだけで、' +
      'セッションは生きている。仕様である）。その本数も1本以上あるときだけ上の行に出る。' +
      '**「背景処理待ち」は器が名乗った分だけである** — この印を送らない古い器では、' +
      '待っていても「手が空いている」側に数える。' +
      '**「走行中」は「進んでいる」ではないし、「背景処理待ち」を含まない** — ' +
      '`status` が `running` でも、背景処理待ちの印が立っていればそちらへ数える。' +
      '**「走行中」は「宛先の runner が名簿に居る」でもない** — 名簿から entry ごと' +
      '消えた宛先を持つ委譲も `running` のまま座る（`isLive()` は動かさない。仕様である）。' +
      'その本数も1本以上あるときだけ上の行に出る。' +
      // 「その他」に lost を含めない: 成果の有無を観測していないのは lost だけで、failed / stopped と同じ袋に入れると「終わったもの」として読み飛ばされるため
      '「その他」は終端したもの（failed / stopped）と、done だが話しかけられないものである。' +
      '個別の状態は `manager_list` / `runner_list` で見る。',
    ...(inboxBacklogLine === null ? [] : [inboxBacklogLine]),
    // メモリの配達待ち行列は器の行数の直後に置く: 離すと器の行数の1行だけが「受信箱の全部」に見えるため
    ...(inboxQueuedLine === null ? [] : [inboxQueuedLine]),
    // 鍵の行は最後に置く: 数えた材料の後に、判断を縛る不変条件が来る順にするため
    ...(input.tokens === undefined && input.active === undefined
      ? []
      : [
          describeTokenSituation({
            tokens: input.tokens,
            active: input.active,
            at,
          }),
        ]),
  ]);
}

// 行を消さず、0 でも埋めない: 0 で埋めると「全部片付いている」と読め、いちばん見落としたい向きへ倒れるため
export function describeSituationUnavailable(error: unknown, at: number = Date.now()): string {
  return block([
    // こちらも時刻を名乗る: 数えられた節だけが名乗る形にすると非対称そのものが理由を要求するため
    `${SITUATION_HEAD}を数えられなかった（${readAtLabel(at)} 時点）: ${reasonOf(error)}`,
    'これは「全部片付いている」ではなく「**数えられなかった**」である。' +
      '本数が要るなら `manager_list` / `runner_list` を自分で呼ぶこと。',
  ]);
}

// 末尾の区切り（---）まで含めて返す: 呼び出し側で足すと、節を足すたびに #runTurn の連結にも手が要るため
function block(lines: readonly string[]): string {
  return [...lines, '', '---', ''].join('\n');
}
