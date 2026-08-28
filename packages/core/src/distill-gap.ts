import type { JournalEntry, JournalEntryInput } from './schema.js';
import type { JournalStore } from './store.js';

/**
 * 蒸留が間に合わなかった区間（＝記憶へ移らなかった区間）を、次のセッションが
 * 検出できるようにするための一式（Issue #564 の (b)）。
 *
 * ## 何を直しているか
 *
 * クローンが落ちる直前の蒸留は、必ず成功するとは限らない。失敗した回・そもそも
 * 走らなかった回があると、**その区間の出来事はどこにも残らない**（会話は消え、
 * 記憶にも入らない）。落ちたこと自体は誰も気づけないが、**次に起きたセッションが
 * 日誌を引き直せば「移せなかった区間」は後から見える**。それを見て断るための
 * 機構である。
 *
 * ## ⚠️ なぜ「蒸留を始めた時刻」ではなく「蒸留が成功で終わった時刻」なのか
 *
 * **ここを「開始」に戻すと、この機構は検出したいものをちょうど取り逃がす。**
 * 次に読む人が「既存の印で足りるのでは」と戻さないように、測った事実を逐語で
 * 残す。実装前に日誌の既存の痕跡を3つ数え、**どれも「成功で終わった」を指して
 * いなかった**（2026-08-28 観測）:
 *
 * 1. `clone.ts` の `#handle` の `'distill'` 分岐が書く
 *    `turnInputEntry({ type: 'distill', ... })` は、`#runInternal` を**呼ぶ前**に
 *    書いている ＝ **蒸留を「始めた」印**である。成功したかは1文字も載らない
 * 2. その手前の「蒸留（<reason>）は見送った」の行は、**見送った**印である
 * 3. `memory_update` の `cause: 'distill'` は、蒸留が**記憶を書いた**印である。
 *    書くものが無ければ痕跡が残らないので「成功したが何も書かなかった回」と
 *    「そもそも走らなかった回」が区別できない
 *
 * ⟹ 1 を使うと、**開始したが完了しなかった回**（＝プロセスが蒸留の途中で
 * 消えた回、SDK が失敗を返した回）が「蒸留した」として数えられる。**それは
 * まさにこの機構が検出したい形そのものである。** だから開始では駄目で、
 * `#runInternal` の戻り値が `answered` だったときにだけ印を書く
 * （`clone.ts` が `#hasUndistilledActivity` を下ろすのと**同じ条件・同じ場所**
 * に置いてある — 条件が2つに割れると、片方だけ直して残りが古い基準のまま、
 * という穴ができる）。
 *
 * ## 型は足さない
 *
 * 既存の `decision` を使う。`memory.ts` の索引の組み直しの記録（
 * `MEMORY_GUARD_REBUILD_*`）が同じ判断を逐語で持っている —— 「新しい
 * `JournalEntryType` も足さない。既存の `decision` で表現できる。種別を新設
 * すると `apps/web` とクローンの道具（`journal_read` の整形）が型で落ちる形に
 * なっているはずなので、そちらを直す作業が要る（PR #140）」。`turn-input.ts` も
 * 同じ理由で `exchange` を使い回している（「`journalEntrySchema` を広げると
 * `JOURNAL_ENTRY_TYPES` 経由で `openapi.json` ＝外向きの API 面が動く」）。
 * **跡を残すためだけに外へ出す面を広げない。**
 *
 * `decision` を選び、`exchange`（`with: 'self'`）を選ばなかった理由は、
 * 下の `countsAsUndistilledActivity` の doc に在る（`with: 'self'` の
 * `exchange` は器の記帳が使い倒している型なので、それを印にすると自分で自分を
 * 「活動」として数える形になる）。
 */

/**
 * 「蒸留が成功で終わった」の印の、本文の先頭に必ず置く語。
 *
 * **書く側と読む側が同じ定数を指す。** `turn-input.ts` が `ターンの入力:` で
 * 始めているのと同じ作法（「後から grep で全部拾えるように」）だが、こちらは
 * 見た目のためではなく**判定の基準**そのものなので、読む側（
 * `isDistillSucceededEntry`）も必ずこの定数を通す。文面を直すときは1か所で済む。
 */
export const DISTILL_SUCCEEDED_DECISION_PREFIX = '蒸留が成功で終わった:';

/**
 * 蒸留の契機。
 *
 * `conversation_end` / `shutdown` は受信箱の `distill` 事象が運んでくる値
 * （`schema.ts` の `distill` の `reason`）。`pre_compact` は受信箱を通らない
 * 別経路（`clone.ts` の `#distillFromTranscript`。要約に潰される直前に走る
 * 短命のサイドセッション）で、`buildDistillPrompt('pre_compact')` と同じ語を使う。
 *
 * **3つを1つの語に潰さない。** どの契機の蒸留が最後に成功したのかは、後から
 * 「落ち方」を見分けるための材料である（器の入れ替えで落ちたのか、会話が
 * 終わったのか、要約に潰されかけたのか）。`turn-input.ts` の `distill` が
 * `reason` を落とさずに載せているのと同じ理由。
 */
export type DistillReason = 'conversation_end' | 'shutdown' | 'pre_compact';

/**
 * 「蒸留が成功で終わった」を日誌へ残す1件を作る。
 *
 * 呼ぶのは2か所 —— `clone.ts` の `#handle` の `'distill'` 分岐（`outcome.status
 * === 'answered'` の枝）と `#distillFromTranscript`（サイドセッションの
 * `result` が成功だったとき）。**文面の組み立てを呼び出し側へ散らさない**
 * （`turnInputEntry` と同じ作法 —— 散らすと、経路が増えたときに片方だけ
 * 読めない文面になる）。
 */
export function distillSucceededEntry(reason: DistillReason): JournalEntryInput {
  return {
    type: 'decision',
    decision: `${DISTILL_SUCCEEDED_DECISION_PREFIX} reason=${reason}`,
    grounds:
      '蒸留のターンが成功（`answered`）で返った。**「始めた」ではなく「成功で終わった」印である** —— ' +
      '開始の印（日誌の `ターンの入力: distill`）は `#runInternal` を呼ぶ前に書かれるので、' +
      '途中でプロセスが消えた回も「蒸留した」と読めてしまう（`distill-gap.ts` の doc）。' +
      'クローンの判断ではなく器の記帳である。',
  };
}

/** その1件が「蒸留が成功で終わった」の印か。**判定はここだけが持つ。** */
export function isDistillSucceededEntry(entry: JournalEntry): boolean {
  return entry.type === 'decision' && entry.decision.startsWith(DISTILL_SUCCEEDED_DECISION_PREFIX);
}

/**
 * その1件を「まだ記憶へ移っていない活動」として数えるか。
 *
 * ## ⚠️ ここが偽陽性の全部である
 *
 * **素朴に「最後の蒸留の時刻 < 日誌の最終追記の時刻」で判定すると、毎回真に
 * なる。** 蒸留そのものが日誌へ書く（この機構が足す成功の印を含む）し、蒸留の
 * 後に器の片付けも走る。だから「日誌に何か在るか」ではなく、**何を数えるかを
 * 決める**必要がある。
 *
 * ## 数える基準（allowlist。型と構造化フィールドだけで決める）
 *
 * 数えるのは「**ターンが1本走った**」と言い切れる痕跡だけである:
 *
 * - `exchange` で `with !== 'self'` —— 人間・マネージャーとの往復。**器の記帳は
 *   すべて `with: 'self'`** なので（`schema.ts` の `exchange.with` の doc:
 *   「`self` は人間に見せない内部ターン」）、この1条件で蒸留自身が書く行・
 *   見送りの行・`turnInputEntry` の行がまとめて落ちる
 * - `turn_usage` で `site === 'session'` —— **これが在って初めて、人間以外の
 *   起点（発意 tick・定期ジョブ・日報）が拾える。** それらのターンは
 *   `turnInputEntry` も応答も `with: 'self'` の `exchange` で書くので、上の1条件
 *   だけでは1件も残らない。人間との会話も発意 tick も日報も同じ
 *   `site: 'session'` に入る（`schema.ts` の `turn_usage.site` の doc）
 * - `external_event` —— 外から届いた合図。これは器の記帳ではなく外の世界の出来事で、
 *   届いた時点で「移すべき中身」である
 *
 * ### ⚠️ `site` は「蒸留かどうか」の軸ではない（引き直して確かめた）
 *
 * **`conversation_end` / `shutdown` の蒸留は本セッションで走るので、その
 * `turn_usage` も `site: 'session'` である**（`clone.ts` の `#read` の
 * `case 'result'` が `#recordUsage(message, 'session', 'cumulative')` を呼ぶ。
 * `site: 'distill'` を名乗るのは PreCompact のサイドセッションだけである）。
 * **それでも蒸留が自分を数えることは無い。理由は `site` ではなく順序である** ——
 * `#recordUsage` は `#finishTurn()` より前に `await` されており、成功の印は
 * `#runInternal` が返った後（＝ `#finishTurn()` の後）に書かれる。⟹ 蒸留の
 * ターンの `turn_usage` は必ず**印より古い**ので、「印より後ろ」を見るこの窓には
 * 入らない。**`clone.ts` の `case 'result'` でこの2つの順序を入れ替えると、
 * 断り書きが毎回鳴るようになる**（歯4がそれを押している）。
 *
 * **本文は1文字も見ない。** 文言で判定すると、文言を直した瞬間に黙って数え方が
 * 変わる（`clone.ts` の `#foldsIntoHeldTick` が「文言では判定しない」と書いて
 * いるのと同じ理由）。上の印（`isDistillSucceededEntry`）だけは本文の先頭語を
 * 見るが、そちらは**書く側と読む側が同じ定数を指している**ので同じ穴ではない。
 *
 * ## 数えないもの と その理由
 *
 * `decision` / `escalation` / `tool_use` / `memory_update` / `daily_report` /
 * `worker_wait` / `token_rotation` / `exchange`(`with: 'self'`) /
 * `turn_usage`(`site: 'distill'`)。**どれも蒸留のターンそのものか、器の記帳が
 * 書きうる型である。** 数に入れると、正常に蒸留して静かに落ちただけの器でも
 * 毎回「ずれが在る」と言うことになる ＝ 断り書きが毎回出て、意味を失う。
 *
 * ## 取りこぼす側（正直に書く）
 *
 * **枠に当たって失敗したターンは `turn_usage` の行を1件も作らない**
 * （`schema.ts` の `turn_usage.models` の doc「失敗して終わったターンは行を1件も
 * 作らず、その消費は次に成功したターンへ合算される」）。その回の起点が人間・
 * マネージャー・外部事象なら `exchange` / `external_event` で拾えるが、
 * **発意 tick と定期ジョブが失敗して終わった回だけは、この基準では数えられない。**
 * 偽陰性（ずれが在るのに黙る）側へ倒してある —— 偽陽性で毎回鳴る断り書きは
 * 読まれなくなり、鳴っていること自体の意味が消えるからである。
 */
export function countsAsUndistilledActivity(entry: JournalEntry): boolean {
  switch (entry.type) {
    case 'exchange':
      return entry.with !== 'self';
    case 'turn_usage':
      return entry.site === 'session';
    case 'external_event':
      return true;
    default:
      return false;
  }
}

/**
 * 「最後に成功した蒸留」が見つからなかったときに、どこまで遡って活動を数えるか。
 *
 * **無制限に遡らない。** 印が1件も無い器（この機構が入る前から動いている
 * インスタンスの、最初の1回）で全件を読むと、日誌の大きさに比例した読み出しが
 * 起動直後に走る。**新しい順に N 件だけ見て、その窓の中で数える**
 * （`JournalStore.list` の既定は新しい順。`store.ts` の doc）。
 *
 * 窓で切ったことは断り書きにも出す（`describeDistillGap`）—— 「N 件の中に
 * 印が無かった」と「印が1件も無い」を混ぜて名乗らない。
 */
export const DISTILL_GAP_ACTIVITY_SCAN_LIMIT = 500;

/** 蒸留が間に合わなかった区間。 */
export interface DistillGap {
  /**
   * 最後に成功で終わった蒸留の時刻。**`null` は「見つからなかった」であって
   * 「無い」ではない**（`scanned` が窓で切れている場合がある）。
   */
  lastDistilledAt: string | null;
  /** 区間の終端 ＝ 数えた活動のうち最も新しいものの時刻。 */
  lastActivityAt: string;
  /** 区間の始端 ＝ 数えた活動のうち最も古いものの時刻。 */
  firstActivityAt: string;
  /** 数えた件数（`countsAsUndistilledActivity` が真だった行の数）。 */
  activityCount: number;
  /**
   * 数えた窓の取り方。
   *
   * - `'since_last_distill'` —— 印が見つかったので、そこから後だけを数えた
   * - `'newest_entries'` —— 印が見つからなかったので、新しい順に
   *   `DISTILL_GAP_ACTIVITY_SCAN_LIMIT` 件の窓で数えた
   */
  window: 'since_last_distill' | 'newest_entries';
}

/**
 * 日誌から「蒸留が間に合わなかった区間」を導出する。ずれが無ければ `null`。
 *
 * **判定基準の単一の実装である**（`memory.ts` の
 * `deriveHumanTouchedAtFromJournal` / `deriveMemoryCreatedAtFromJournal` と
 * 同じ形・同じ理由。あちらの doc に逐語で「3か所が別々に基準を書くと、片方だけ
 * 直して残りが古い基準のまま、という穴ができる」と在る）。呼ぶのはいまのところ
 * `clone.ts` の断り書きの組み立て1か所だけだが、**基準をそこへ直接書かない** ——
 * 断り書き以外にこの区間を見たい口（CLI・web・`self_status`）は後から必ず出る。
 *
 * ## `until` は何か（⚠️ 偽陽性を消しているのはここである）
 *
 * **「この器が起きるより前に書かれた行」だけを見るための境界である。**
 * 呼び出し側は `Clone` を組み立てた時刻を渡す。これが無いと、
 * **新しいセッションの最初のターンは必ず「ずれが在る」になる** —— その
 * ターンを起こした人間の発言は、断り書きを組み立てるより前に日誌へ入って
 * いる（`clone.ts` の `#record` は `post` の中で書く）ので、素朴に数えると
 * 自分自身を「移されなかった活動」として数えてしまう。**この器が書いた行は、
 * 定義上いまの会話の中に在る。**
 *
 * ### ⚠️ 境界は「以前」ではなく「より前」である（実測で直した）
 *
 * `JournalQuery.until` は**その時刻を含む**（`store.ts` の doc:「この時刻以前」）
 * ので、読み出しの上限としてだけ渡し、**数える側では `at < until` で切り直す。**
 *
 * **含む側にしていたら、既存の歯が1本落ちた**（`clone.test.ts` の「新規に開いた
 * セッションでは resume の断りを出さない」。単体では緑、全件を通したときだけ赤 ——
 * 2026-08-28 観測）。器の生成と、その直後に `post` された最初の発言の記帳が
 * **同じミリ秒に並んだ**ためである。`#record` は `post` の中で書き、`post` は
 * `createClone` の直後に来るので、**「実運用では1ミリ秒以上空く」は成り立たない**
 * —— 起動時に拾い直した未読（`#restoreUnread`）は `#pump` の中で `post` し直され、
 * まさに器の生成と同じミリ秒に記帳されうる。
 *
 * `at < until` なら、同じミリ秒に並んだ行は**すべて「この器が書いた」側へ倒れる**
 * ＝ 偽陽性ではなく偽陰性の側へぶれる。落ちたプロセスの最後の書き込みと、次の
 * プロセスの起動が同一ミリ秒に並ぶことはない（プロセスの入れ替えはミリ秒では
 * 終わらない）ので、**倒す向きとしてはこちらが正しい。**
 */
export async function deriveDistillGapFromJournal(
  journal: Pick<JournalStore, 'list'>,
  options: { until: string; activityScanLimit?: number },
): Promise<DistillGap | null> {
  const { until } = options;
  const scanLimit = options.activityScanLimit ?? DISTILL_GAP_ACTIVITY_SCAN_LIMIT;

  // **`decision` だけを引く。** 印は `decision` なので、他の種別を読む理由が無い
  // （`deriveHumanTouchedAtFromJournal` が `types: ['memory_update']` で引くのと
  // 同じ形）。新しい順に返るので、最初に当たったものが「最後に成功した蒸留」。
  //
  // **`until` は読み出しの上限としてだけ渡し、境界は `at < until` で切り直す**
  // （上の doc「境界は『以前』ではなく『より前』である」）。
  const beforeBoot = (entry: JournalEntry): boolean => entry.at < until;
  const decisions = await journal.list({ types: ['decision'], until });
  const marker = decisions.find((entry) => beforeBoot(entry) && isDistillSucceededEntry(entry));
  const lastDistilledAt = marker?.at ?? null;

  // 印が在れば、**その行より後ろ**だけを見る（窓は自然に小さい）。印が無ければ
  // 新しい順に窓で切る（`DISTILL_GAP_ACTIVITY_SCAN_LIMIT` の doc）。
  //
  // **⚠️ `since: lastDistilledAt` では駄目である。** `JournalQuery.since` は
  // 「この時刻**以降**」なので境界を含み、印と**同じミリ秒**に積まれた1つ前の行
  // （＝その蒸留がまさに移した活動）が窓へ入る ＝ 蒸留した直後の器でも
  // 「ずれが在る」と言う（実測で歯4がここで落ちた）。`after` は `id` を錨に
  // する形で、**同じミリ秒に積んだ2行をまたいでも飛ばさず重複しない**ことが
  // 3実装すべてで測ってある（`journal-order-with-contract.ts` の契約9）。
  // 錨はいま `list` から受け取った行そのものなので、`JournalAnchorNotFoundError`
  // にはならない。
  //
  // **`order` が枝で違う。** `after` の枝は `asc`（錨より後ろ＝新しい側を取る
  // ため）、窓の枝は既定の `desc`（新しい順に N 件）。取り出す端が逆になるので、
  // 下で明示的に分ける。
  const ascending = marker !== undefined;
  const entries =
    marker === undefined
      ? await journal.list({ until, limit: scanLimit })
      : await journal.list({ order: 'asc', after: { id: marker.id, at: marker.at }, until });

  const activity = entries.filter(
    (entry) => beforeBoot(entry) && countsAsUndistilledActivity(entry),
  );
  // 1件も無ければずれは無い ＝ 直前の蒸留が最後の活動まで持っていったということ。
  if (activity.length === 0) return null;
  const first = ascending ? activity[0] : activity.at(-1);
  const last = ascending ? activity.at(-1) : activity[0];
  if (first === undefined || last === undefined) return null;

  return {
    lastDistilledAt,
    lastActivityAt: last.at,
    firstActivityAt: first.at,
    activityCount: activity.length,
    window: lastDistilledAt === null ? 'newest_entries' : 'since_last_distill',
  };
}

/**
 * 断り書きの1行目。**テストと `clone.ts` が同じ語を指すための定数**でもある
 * （`RESUMED_MEMORY_NOTICE` が1つの定数で済んでいるのと違い、こちらは区間を
 * 埋め込むので文字列を組み立てる。見出しだけは定数で持つ）。
 */
export const DISTILL_GAP_NOTICE_HEAD =
  '[system] 前のセッションの終わりが記憶へ移りきっていない可能性がある。';

/**
 * 検出した区間を、次のセッションの最初のターンへ添える `[system]` の断り書きに
 * する。
 *
 * **全文を載せ直さない。** 区間の中身（何があったか）を本文へ写すと、日誌の
 * 大きさに比例して最初のターンが重くなり、しかも写した塊は会話の履歴として
 * 残って resume のたびに運ばれる（`RESUMED_MEMORY_NOTICE` が全文を載せ直さない
 * 理由と同じ）。**区間と件数と、掘るための道具の名前だけを渡す。**
 */
export function describeDistillGap(gap: DistillGap): string {
  // 印が見つからなかったときは窓で切っているので（`window` は必ず
  // `'newest_entries'`）、**「無い」ではなく「見た範囲には無かった」と名乗る。**
  const distilled =
    gap.lastDistilledAt === null
      ? '最後に蒸留が成功で終わった記録は、日誌の新しい方から' +
        `${DISTILL_GAP_ACTIVITY_SCAN_LIMIT}件を見た範囲には無かった`
      : `最後に蒸留が成功で終わったのは ${gap.lastDistilledAt}`;

  return [
    DISTILL_GAP_NOTICE_HEAD,
    `${distilled}。それより後、この器が起きるまでのあいだに、` +
      `記憶へ移された記録の無い活動が ${gap.activityCount} 件ある` +
      `（${gap.firstActivityAt} 〜 ${gap.lastActivityAt}）。`,
    '',
    '**これは「蒸留を始めた」ではなく「蒸留が成功で終わった」記録で数えている。**' +
      '前のプロセスが蒸留の途中で消えたか、蒸留が失敗して終わったか、そもそも走らなかった、' +
      'のいずれかである。この区間の出来事は**記憶（正本）には入っていない**' +
      '（前のセッションを引き継いで開き直していれば会話の履歴には残っているかもしれないが、' +
      'それは記憶ではない）。',
    '',
    `中身は日誌に在る。\`journal_read\` に \`since\`（${gap.firstActivityAt}）と ` +
      `\`until\`（${gap.lastActivityAt}）を渡せばその区間だけを読める。` +
      '記憶へ移すべきものが在れば `memory_write` / `memory_append` で移すこと。',
  ].join('\n');
}
