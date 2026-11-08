import { firstReportPerManager } from './clone-batch-prompts.js';
import { reasonOf } from './dropped-record.js';
import { INBOX_BACKLOG_LOUD_THRESHOLD, summarizeInboxBacklog } from './inbox-backlog.js';
import type { InboxBacklogBreakdown } from './inbox-backlog.js';
import { describeValidity, inboxEventValidity } from './inbox-validity.js';
import type { ManagerPool, ManagerSummary } from './manager.js';
import {
  describeQuotaRecovery,
  foldableQuotaStopTargetsOf,
  quotaFoldNoticeOf,
  quotaStopTargetsOf,
  recoveredNoticeFoldOf,
  type QuotaRecoverySummary,
} from './quota-recovery-notice.js';
import type { InboxEvent, JobStatus } from './schema.js';
import { describeSituation, describeSituationUnavailable } from './situation.js';
import type { Stores } from './store.js';
import { toAgentTokenView } from './token-pool.js';

// 戻っていた担当の知らせを畳む2組（`CloneTurnNotices.recoveredFoldFor`・`Clone` の `#foldRecoveredNotice`）。`#pump` はこの順に見る: 枠の知らせ（#4499）が先、枠以外の知らせ（#5048）が後
export const RECOVERED_FOLD_KINDS = ['quota', 'recovered'] as const;
export type RecoveredFoldKind = (typeof RECOVERED_FOLD_KINDS)[number];

/**
 * `Clone` が協力者へ渡す口。読むものは「呼ばれるまで読まない関数」で渡す（`#managers`・`#stores` は constructor の中で入る）。
 * 状態は書かない（読むだけ）。`queuedInMemory` は `#toolContext`・`#distillFromTranscript` も使うので `Clone` に残す。
 */
export interface CloneTurnNoticesPorts {
  /** `Clone` の `#managers`（`list`・`runners` だけ読む） */
  managers(): Pick<ManagerPool, 'list' | 'runners'>;
  /** `Clone` の `#stores`（鍵の `list`・`readActive` と、受信箱の `pending`・`peekPending` だけ読む） */
  stores(): {
    readonly tokens: Pick<Stores['tokens'], 'list' | 'readActive'>;
    readonly inbox: Pick<Stores['inbox'], 'pending' | 'peekPending'>;
  };
  /** `Clone` の `#queuedInMemoryCount()`（`manager_list` 側と件数の出どころを1箇所にするため `Clone` に残す） */
  queuedInMemory(): number;
}

/**
 * ターンの入口で組む断り書き4本（いまの全体の節・前提の断り・枠の回復の1節・戻っていた担当の知らせの畳みの判定）。
 * 状態は書かない。`list()` などの読み出しは口から呼ぶ。メソッドは元と同じ `async` のまま（呼び元 `#prepareTurn`・`#pump` の `await`・`.catch` は動かさない）。
 */
export class CloneTurnNotices {
  readonly #ports: CloneTurnNoticesPorts;

  constructor(ports: CloneTurnNoticesPorts) {
    this.#ports = ports;
  }

  // `runners()` の内訳から委譲を数え直さない: `unregister()` で名簿から消えた器を持つ委譲がどの束にも載らず落ち、分母が黙って縮むため（本数はいつも `list()` から取る）
  // 蒸留には載せない: 記憶へ移すためだけの内部ターンで、`stop()` 経由はこの直後にプロセスが消えるため
  // 読めなくても行を消さない: 0 で埋めるのも消すのも「全部片付いている」と読める側へ倒れるため。受信箱の滞留は読めなかったとき `undefined` でなく `'unreadable'` を渡す: `undefined` は「省略」に取ってあり、「0件だった」と見分けが付かなくなるため
  async situationFor(events: InboxEvent[]): Promise<string> {
    const event = events[0];
    if (event === undefined) return '';
    if (event.type === 'distill') return '';
    try {
      const managers = await this.#ports.managers().list();
      const fleet = await this.#ports.managers().runners();
      // 読めなくても状況ごと落とさない: 鍵だけ `undefined` で渡して「読めなかった」と書かせる。`catch` を外まで広げると、鍵の読みが落ちた回に委譲の本数も器の台数も消えるため
      const pool = await Promise.all([
        this.#ports
          .stores()
          .tokens.list()
          .then(
            (rows) => rows.map(toAgentTokenView),
            () => undefined,
          ),
        this.#ports
          .stores()
          .tokens.readActive()
          .then(
            (active) => active,
            () => undefined,
          ),
        // 受信箱の滞留も個別に catch する: 委譲・器・鍵の数え上げを道連れにしないため。安い `pending()` を使う: 内訳まで返す `peekPending()` は毎ターン呼ぶ口ではないため
        // このターンが処理している `events` 自身を引く: 消す `#forget()` はこの後（`#handle` の完了後）にしか呼ばれず、素で読むと処理中の1件が毎ターン「滞留」に数えられ、詰まっているときだけ膨らむという節の存在理由が壊れるため
        // `oldestAt` は補正しない: `events` の `at` は「いま」に近く、本物の滞留の方が古いため。件数が0まで落ちた回は `oldestAt` ごと消す
        this.#ports
          .stores()
          .inbox.pending()
          .then(
            async (
              backlog,
            ): Promise<{
              count: number;
              oldestAt?: string;
              typeBreakdown?: InboxBacklogBreakdown;
            }> => {
              const count = Math.max(0, backlog.count - events.length);
              if (count === 0) return { count: 0 };
              // `oldestAt: backlog.oldestAt` と素に書かない: 値が `undefined` でもキー自体が生えるため
              const base = {
                count,
                ...(backlog.oldestAt === undefined ? {} : { oldestAt: backlog.oldestAt }),
              };
              // 閾値を超えた回だけ重い `peekPending()` を呼ぶ: 費用は「詰まっている」と分かった回にしか掛けないため（`clone-situation-notice.test.ts` が固定する）
              if (count <= INBOX_BACKLOG_LOUD_THRESHOLD) return base;
              try {
                const peek = await this.#ports.stores().inbox.peekPending();
                return {
                  ...base,
                  typeBreakdown: summarizeInboxBacklog(peek.entries, Date.now(), peek.unreadable),
                };
              } catch {
                // 内訳が読めなくても件数は取れているので base のまま返す: 件数の行そのものを消さないため
                return base;
              }
            },
            (): 'unreadable' => 'unreadable',
          ),
      ]);
      return describeSituation({
        managers,
        runners: fleet.runners,
        tokens: pool[0],
        active: pool[1],
        at: Date.now(),
        backlog: pool[2],
        // このターン自身は引かない: `#pump` が取り出してからここへ来るので、`#inbox.size` は既にこのターンの分を含まないため
        // `queuedInMemory` 口（`Clone` の `#queuedInMemoryCount()`）を経由する: `manager_list` 側と件数の出どころを1箇所にするため
        queuedInMemory: this.#ports.queuedInMemory(),
      });
    } catch (error) {
      return describeSituationUnavailable(error);
    }
  }

  // `list()` の失敗を握り潰さず呼び出し側（`#pump`）へ返す: 握り潰すと呼び出し側の `.catch()` を外しても何も赤くならないため
  // 文言は「いまは」でなく「この断り書きを組んだ時点では」と言う: `situationFor` とは別々の `list()` 呼び出しで、まれに食い違うため
  // 担当ごとに最初の報告で見る: 起点の違う合図の束（`CloneBatchMerge.mixedSignalBatch`）には別々の担当の報告が混ざり、先頭だけ見ると他の担当の前提の変化が落ちるため。担当が1人の束は今までどおり先頭1件で見る
  async validityFor(events: InboxEvent[]): Promise<string> {
    // `kind` まで絞る: 質問・許可確認は `situationFor` 側で見ており、絞らないと `list()` を1本余計に引くため
    const firsts = firstReportPerManager(events);
    if (firsts.length === 0) return '';

    // `try` で囲う: `list()` は同期的に投げうり、`.catch()` だけでは拾えないため
    let managers: readonly ManagerSummary[] | { readonly detail: string };
    try {
      managers = await this.#ports.managers().list();
    } catch (error) {
      managers = { detail: reasonOf(error) };
    }

    return firsts
      .map((event) => {
        let now: { readonly status: JobStatus } | { readonly detail: string };
        if ('detail' in managers) {
          now = managers;
        } else {
          const found = managers.find((manager) => manager.managerId === event.managerId);
          now =
            found === undefined
              ? { detail: `${event.managerId} が一覧に居ない` }
              : { status: found.status };
        }
        return describeValidity(inboxEventValidity(event, now), event.managerId);
      })
      .join('');
  }

  // 積む側（デーモン）で畳まず、配る直前にここで見る: クローン自身が枠で止まっていた間は保持されて遅れて配られるので、積んだ時点の状態はもう古いため（#4497）
  async quotaRecoveryFor(events: InboxEvent[]): Promise<string> {
    const targets = quotaStopTargetsOf(events);
    if (targets === undefined) return '';
    // `try` で囲う: `list()` は同期的に投げうり、`.catch()` だけでは拾えないため
    let managers: readonly QuotaRecoverySummary[] | { readonly detail: string };
    try {
      managers = await this.#ports.managers().list();
    } catch (error) {
      managers = { detail: reasonOf(error) };
    }
    return describeQuotaRecovery(targets, managers, Date.now());
  }

  // 戻っていた担当の知らせを畳んでよいか（畳むなら日誌へ写す断り書き。畳まないなら `null`）。枠の知らせ（`quota`）とそれ以外（`recovered`）の2組を1本にした。違いは入口の印と判定の関数だけ:
  //   - quota: 印は `quotaSessionWindow` 等（`foldableQuotaStopTargetsOf`）、判定は `quotaFoldNoticeOf`。
  //   - recovered: 印は `foldWhenBack`（#5048）、判定は `recoveredNoticeFoldOf`（`movedFromGeneration`・`attached` はこちらだけが見る）。
  // 印の無い知らせでは一覧を引かない。一覧を引けなければ畳まない（`null`）: 確かめられないまま消すより、届けて `quotaRecoveryFor` の「確かめられなかった」を読ませる側へ倒すため
  async recoveredFoldFor(event: InboxEvent, kind: RecoveredFoldKind): Promise<string | null> {
    let decide: ((managers: readonly QuotaRecoverySummary[]) => string | null) | null = null;
    if (kind === 'quota') {
      const targets = foldableQuotaStopTargetsOf(event);
      if (targets !== undefined) {
        decide = (managers) => quotaFoldNoticeOf(targets, managers, Date.now());
      }
    } else if (event.type === 'manager_message' && event.foldWhenBack !== undefined) {
      decide = (managers) => recoveredNoticeFoldOf(event, managers, Date.now());
    }
    if (decide === null) return null;
    let managers: readonly QuotaRecoverySummary[];
    try {
      managers = await this.#ports.managers().list();
    } catch {
      return null;
    }
    return decide(managers);
  }
}
