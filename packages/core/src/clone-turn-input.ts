import { describeReopenNotice } from './clone-reopen.js';
import {
  describeMemoryIndexRefresh,
  type CloneDistillMemoryState,
} from './clone-distill-memory-state.js';
import {
  HUMAN_ACTION_WINDOW,
  composeFreshMemoryInput,
  describeContextWindowFoldNotice,
  describeMemoryEditAttribution,
  prependResumedMemoryNotice,
  renderHumanActionSection,
} from './clone-turn-input-text.js';
import { redactErrorText } from './denial-input-head.js';
import {
  DISTILL_GAP_ACTIVITY_SCAN_LIMIT,
  deriveDistillGapFromJournal,
  describeDistillGap,
} from './distill-gap.js';
import { noteDroppedRecord } from './dropped-record.js';
import { EXCHANGE_KIND_GAUGE_PREFIX } from './exchange-kind.js';
import { renderMemoryDocuments } from './memory.js';
import type { JournalEntry, JournalEntryInput, MemoryDocument } from './schema.js';
import type { Stores } from './store.js';

/**
 * `Clone` が協力者へ渡す口。読むものは「呼ばれるまで読まない関数」で渡す（`#stores` は constructor の中で入り、`#sessionOrdinal` は動く）。
 * 口の戻りは Promise を直に返す（`(entry) => this.#journal(entry)`）: 間に `async` の関数を挟むと `await` の段が増え、`#runTurn` の 1 式の評価の時機が動く。
 */
export interface CloneTurnInputPorts {
  /** `Clone` の `#stores`（記憶の `persona.documents` と、日誌の `list`・`listPage` だけ読む） */
  stores(): {
    readonly persona: Pick<Stores['persona'], 'documents'>;
    readonly journal: Pick<Stores['journal'], 'list' | 'listPage'>;
  };
  /** `Clone` の `#env`（日誌の行の伏せ字 `redactErrorText` にだけ渡す） */
  env(): NodeJS.ProcessEnv;
  /** `Clone` の `#sessionOrdinal`（開き直しの断りが「いまのセッションのもの」かの判定に渡す。`#ensureQuery` が進める） */
  sessionOrdinal(): number;
  /** `Clone` の `#journal` */
  journal(entry: JournalEntryInput): Promise<void>;
}

/**
 * ターンの入力を組む殻（蒸留の区間の断り・文脈窓の畳みの断り・記憶の載せ直し・人間の操作の節）。文面の本文は `clone-turn-input-text.ts` の純関数が持ち、
 * ここは読み出し・控えの更新・日誌 1 行だけを持つ。状態は 3 本（記憶と人間の操作の控えの時刻・人間の操作の控えの id）で、この中だけで書く
 * （`Clone` の `#buildSessionSpec` が読み始めの時刻へ戻すのは `resetCarriedAt`）。
 * 呼び元は `#runTurn` の 1 式だけ。`contextWindowFoldNotice` は同期で、呼ぶこと自体が遷移（pending を倒す）なので、呼ぶ順と回数を動かさない。
 * メソッドは元と同じ `async`／同期のまま（呼び元の `await` の段を増やさない）。
 */
export class CloneTurnInput {
  readonly #ports: CloneTurnInputPorts;
  readonly #distillMemory: CloneDistillMemoryState;

  // 記憶を読み始めた時刻を控える（載せた後の時刻にしない）: 読んでから載せるまでの間の人間の書き込みを、次の帰属の窓から落とさないため。
  #memoryCarriedAt = new Date().toISOString();
  // `#memoryCarriedAt` と別に持つ: 記憶に差分が無いターンでは後者が進まず、人間の操作の窓だけが古いまま残るため。
  #humanActionCarriedAt = new Date().toISOString();
  // 時刻の控えだけで切らない: `since` は境目を含むので、読み始めと同じミリ秒の行は次の回にも引かれ、二度載るため。前回引いた印の行の id で外す
  #humanActionCarriedIds: ReadonlySet<string> = new Set();

  constructor(ports: CloneTurnInputPorts, distillMemory: CloneDistillMemoryState) {
    this.#ports = ports;
    this.#distillMemory = distillMemory;
  }

  /** `Clone` の `#buildSessionSpec` から: 組んだセッションが載せた記憶の時刻へ、両方の控えを戻す */
  resetCarriedAt(readAt: string): void {
    this.#memoryCarriedAt = readAt;
    this.#humanActionCarriedAt = readAt;
  }

  // 判定をここに書かない: 基準は `distill-gap.ts` の `deriveDistillGapFromJournal` が1本で持つ（散ると片方だけ直して残りが古い基準のまま残る）。蒸留のターンには載せず印も下ろさない: 内部ターンで、`stop()` 経由はこの直後にプロセスが消えるため。読めなくても空文字でターンを進める・印は読む前に下ろす: 日誌が壊れていると毎ターン同じ読み出しを繰り返すため。
  async distillGapNotice(kind: 'normal' | 'distill'): Promise<string> {
    if (kind === 'distill') return '';
    if (!this.#distillMemory.takeDistillGapNoticePending()) return '';

    try {
      const gap = await deriveDistillGapFromJournal(this.#ports.stores().journal, {
        until: this.#distillMemory.bootAt,
        activityScanLimit: DISTILL_GAP_ACTIVITY_SCAN_LIMIT,
      });
      if (gap === null) return '';
      return `${describeDistillGap(gap)}\n\n---\n\n`;
    } catch (error) {
      noteDroppedRecord('蒸留の区間の読み出し', `until=${this.#distillMemory.bootAt}`, error);
      return '';
    }
  }

  // 読み直す口の名前（`conversation_read`）を書く: 「読み直せる」だけだと次のターンで口を探すところから始めるため。「読め」とは書かない: 読み直すかどうかはクローンの判断のため（`usage-limits.ts` の `describeUsageNotice`）。
  contextWindowFoldNotice(kind: 'normal' | 'distill'): string {
    if (kind === 'distill') return '';
    // 人間の操作による開き直しの断りも、文脈窓の畳みと同じ経路で、同じ1度きりの形で添える。
    // 文脈窓の断りの文言は変えない（下の固定文）。両方立っていれば開き直しを先に置く。
    const reopened = this.#distillMemory.takeReopenNotice(this.#ports.sessionOrdinal());
    const reopenText = reopened === null ? '' : describeReopenNotice(reopened);
    if (!this.#distillMemory.takeContextWindowFoldNoticePending()) return reopenText;
    return reopenText + describeContextWindowFoldNotice();
  }

  // 載せ直すのは変わった文書の、変わった範囲だけにする: 全文を置くと、載せた塊が会話の履歴として残り、直すたびに写しが増えて resume でも運ばれる（1回の費用が「変えた量」でなく「文書の大きさ」で決まる）ため。
  // 削除は名前だけで伝える: 本文を載せると「消したのに文脈には居る」状態になるため。
  // `presentInMemory` に記憶の全体（`documents`）を渡す: 差分だけだと、親が今回変わっていないだけで「親が無い」と出て「ここに出ていない文書は変わっていない」と矛盾するため。
  // `head` で「変わった範囲だけが載る」と「システムプロンプトの記憶はセッション構築時点のもの」を明言する: 省略が黙って行われると記憶の破損と読まれ、システムプロンプトは `#buildSessionSpec` が1回だけ焼くので「現在の内容」と言うのは嘘になるため。
  async withFreshMemory(text: string): Promise<string> {
    const readAt = new Date().toISOString();
    let documents: MemoryDocument[];
    try {
      documents = await this.#ports.stores().persona.documents();
    } catch {
      // 記憶が読めないことでターンまで止めない。ただし `#memoryOnRecord` は触らない: 触ると「載せた」ことになり次のターンで差分が消えるため。
      return text;
    }

    const { changed, removed } = this.#distillMemory.diffAgainstRecorded(documents);

    const resumed = this.#distillMemory.takeResumedHistoryHasMemory();

    // 印は載せ直すものが無くても下ろす（`#memoryIndexRefreshPending`）: 下ろさないと、何ターンも先の無関係な更新に相乗りして載るため。
    const refreshIndex = this.#distillMemory.takeMemoryIndexRefreshPending();

    if (!refreshIndex && changed.length === 0 && removed.length === 0) {
      return prependResumedMemoryNotice(resumed, text);
    }

    // 控えを差し替える前に、いまの控えを退避する: 順序を逆にすると差分が常に空になり、何も載らないのに「更新された」とだけ言うため。
    const seenContent = this.#distillMemory.commitMemory(documents);
    const since = this.#memoryCarriedAt;
    this.#memoryCarriedAt = readAt;

    // 載せる文字列を先に作って長さを日誌へ残す: 数える対象が実際に会話へ載る文字列そのものになるため。
    // 要約の後は全文書の索引を丸ごと載せ直す: 「出ていない文書はシステムプロンプトのまま」と言える根拠（焼いた控え）を持たないため。
    const reinjectedIndex = refreshIndex ? renderMemoryDocuments(documents) : null;
    if (reinjectedIndex !== null) {
      await this.#journalSelf(
        'outbound',
        EXCHANGE_KIND_GAUGE_PREFIX +
          redactErrorText(
            describeMemoryIndexRefresh({
              slugs: documents.map((doc) => doc.slug),
              renderedChars: reinjectedIndex.length,
              totalDocuments: documents.length,
            }),
            this.#env,
          ),
      );
    }

    const attribution = refreshIndex
      ? []
      : await this.#memoryEditAttribution([...changed.map((doc) => doc.slug), ...removed], since);

    return composeFreshMemoryInput({
      resumed,
      refreshIndex,
      attribution,
      reinjectedIndex,
      documents,
      changed,
      removed,
      seenContent,
      text,
    });
  }

  // 日誌が読めなければ1行も返さない: 書き手を推測で名指しすると、人間の書き込みでないものを人間のものと言うため。
  // 引いた行が `limit` 件ちょうどなら untraced を作らない: 窓の外に書き手の行があるかもしれず、「残っていない」と言えないため。
  async #memoryEditAttribution(slugs: readonly string[], since: string): Promise<string[]> {
    const limit = 200;
    let rows: JournalEntry[];
    try {
      rows = await this.#ports.stores().journal.list({ types: ['memory_update'], since, limit });
    } catch {
      return [];
    }
    return describeMemoryEditAttribution(rows, slugs, limit);
  }

  // 日誌が読めなければ1行も出さない: 読めない理由を「人間の操作は無い」と読ませないため（ターンも止めない）。
  // 控えは読み始めた時刻へ進める（載せた後にしない）: 読んでから載せるまでの間の操作を、次の窓から落とさないため。
  // 受信箱には積まない: 人間の操作1件ごとにターンを起こすと、人間が画面を触るたびにクローンの時間を使うため。次に起きるターンの頭で足りる。
  async withHumanActions(text: string): Promise<string> {
    const readAt = new Date().toISOString();
    const since = this.#humanActionCarriedAt;
    const { lines: section, readIds } = await this.#humanActionSection(
      since,
      this.#humanActionCarriedIds,
    );
    this.#humanActionCarriedAt = readAt;
    // 読めなかった回は控えを残す: 空で上書きすると、境目の行を次の回にもう一度載せるため
    if (readIds !== undefined) this.#humanActionCarriedIds = readIds;
    return section.length === 0 ? text : [...section, '', '---', '', text].join('\n');
  }

  // 件数の窓（`limit`）は `types` で切った後に効き、`humanAction` の有無では切れない: 引いた行が `limit` 件ちょうどなら窓の外にも在りうるので「これで全部」と言わない。
  async #humanActionSection(
    since: string,
    carriedIds: ReadonlySet<string>,
  ): Promise<{ lines: string[]; readIds?: ReadonlySet<string> }> {
    let rows: JournalEntry[];
    try {
      rows = await this.#ports.stores().journal.list({
        types: ['decision'],
        since,
        limit: HUMAN_ACTION_WINDOW,
      });
    } catch {
      return { lines: [] };
    }
    const marked = rows.flatMap((row) =>
      row.type === 'decision' && row.humanAction !== undefined
        ? [{ id: row.id, decision: row.decision, action: row.humanAction }]
        : [],
    );
    const readIds = new Set(marked.map((row) => row.id));
    const fresh = marked.filter((row) => !carriedIds.has(row.id));
    if (fresh.length === 0) return { lines: [], readIds };
    return { lines: renderHumanActionSection(fresh, rows.length), readIds };
  }

  // `Clone` の `#env` と同じ名前で読む: 日誌の文面の式（`this.#env`）を移す前と一字も変えないため。値でなく口越しに読むのは、`Clone` の constructor の中で入る値だから
  get #env(): NodeJS.ProcessEnv {
    return this.#ports.env();
  }

  // `Clone` の `#journalSelf` と同じ形で置く（走査の試験は、この private な helper の呼び出しの字面を数える。口を直に呼ぶ字面だと拾わない）。
  // async にせず口の Promise をそのまま返す: `await` の呼び出し側のタイミングを変えない。
  // 接頭辞（EXCHANGE_KIND_*_PREFIX）は呼び出し箇所の text に字面で置く（exchange-kind-coverage.test.ts が第2引数を走査する）。
  #journalSelf(role: 'inbound' | 'outbound', text: string): Promise<void> {
    return this.#ports.journal({ type: 'exchange', with: 'self', role, text });
  }
}
