import {
  jobSchema,
  journalRowType,
  noteDroppedJournalRow,
  noteDroppedJournalRowsSummary,
  pendingApprovalSchema,
} from '@alteroid/core';
import type { Job, JobStore, PendingApproval } from '@alteroid/core';
import { asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls } from './db.js';
import { approvals, jobs } from './schema.js';

/**
 * `#cache` の1行ぶん。**版（{@link jobRowVersion}）が変わっていなければ
 * jsonb を引き直さずにこれを使い回す**（Issue #900）。
 *
 * `ok: true` の `job` は {@link deepFreeze} で凍らせてある。読み出し側
 * （`listJobs()`）は毎回これの**浅いコピー**を返す——凍らせた理由と、浅い
 * コピーで足りる理由は `listJobs()` の doc に書く。
 */
type JobCacheEntry =
  | { version: string; ok: true; job: Job }
  | { version: string; ok: false; type: string | undefined; bytes: number };

/**
 * 行の「版」——`xmin`（システム列。UPDATE のたびに必ず変わる）と
 * `updated_at`（アプリが書く値）を連結した文字列。
 *
 * **なぜ両方要るか。** `updated_at` はミリ秒粒度なので、同じミリ秒に2回
 * 上書きされると衝突しうる（`putJob` は `#persist` / `#claimForResume` の
 * どちらの経路でも呼ぶ直前に `updatedAt` を進めるが、進め幅の保証は無い）。
 * `xmin` は PostgreSQL が UPDATE のたびに必ず新しい値へ進める行そのものの
 * 版なので衝突しない（PGlite で実測——817→818）。**どちらか一方だけが
 * 変わっても版は変わったと判定する**（`||` ではなく文字列の連結で比べる
 * ので、自然にそうなる）。
 *
 * **`VACUUM FREEZE` を経た行は `xmin` が凍結済みとして読み出され、値が
 * 変わりうる。** その行はこの覚えにとって「版が変わった」に見えるので、
 * 次の `listJobs()` で1回だけ余分に jsonb を引き直す。**倒れる向きは
 * 安全側である**——余分に引き直すだけで、古い値を返すことは無い。
 */
function jobRowVersion(xmin: string, updatedAt: Date): string {
  return `${xmin}|${updatedAt.toISOString()}`;
}

/**
 * `value` とその入れ子をすべて再帰的に凍らせる。
 *
 * **配列も凍らせる**（`typeof [] === 'object'` なので同じ枝を通る）。
 * 循環参照は無い前提——`Job` は `jobSchema.safeParse` を通した後の値で、
 * JSON（jsonb 由来）から作られているので循環しえない。
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * ジョブ台帳と承認待ちキュー。
 *
 * ジョブ行が持つ `session_id`（jsonb の中）が、デーモン再起動後にマネージャーの
 * 続きへ戻るための足がかりである（roadmap M4）。
 */
export class PgJobStore implements JobStore {
  readonly #db: Db;

  /**
   * 行の版を鍵にした覚え（memo。Issue #900）。**id → 最後に読めた版とその
   * 結果**を持つ。
   *
   * **なぜ要るか。** `listJobs()` は毎回全行の jsonb を引いていたが、
   * 実測（PR 本文）では508行・long profile で `SELECT` が中央値70.90msを
   * 占め、`safeParse`（1.24ms）はその1.7%でしかない。支配的なのは
   * 「同じ6.8MBを毎回引き直していること」であって parse の回数ではない
   * ——だから直すのは引き直しの頻度である。
   *
   * **上限（LRU 等）を置かない。** 置くと溢れた行だけ毎回引き直しに戻り、
   * しかもそれが出力のどこにも現れない（静かな部分退行）。id は
   * `listJobs()` を呼ぶたびに段1の結果（下）と突き合わせて縮められる——
   * 台帳に無くなった id をここで捨てるので、**この覚えは台帳より長生き
   * しない**。台帳自体に消す経路がいまは無い（`insert(jobs)` /
   * `update(jobs)` の呼び出しは `putJob` の1箇所だけ）ので、覚えは台帳と
   * 同じだけメモリを使う（508行×約13KB≈6.8MB）。**それでも status quo
   * より厳密に良い**——いまは同じバイト数を呼び出しごとに線の上へ流して
   * いる（このファイルの doc コメントを書いている最中の確認だけで3回）。
   *
   * **いま台帳の行を消す口は `JobStore` に無い**（2026-09-12 時点。`jobs`
   * テーブルを対象にした削除系の SQL——drizzle の delete 呼び出し・生 SQL
   * のいずれの形も——は repo 全体で0件。`JobStore` interface が持つのは
   * `listJobs` / `putJob` / `listApprovals` / `getApproval` /
   * `putApproval` の5つだけで、消す口がそもそも無い）。
   *
   * ⭐ **ただしこの覚えはその前提に依存していない。** 結果は**段1が返した
   * id の並び**から組む（下の `listJobs()` の「段1の順で結果を組む」）ので、
   * 台帳から消えた行は段2を待たずに結果から落ちる——覚えに残った entry は
   * 直後の「段1に無くなった id は覚えから落とす」で捨てられ、**二度と
   * 読まれない。** ⟹ **次に台帳の掃除（行を消す口）を実装する人へ**:
   * 行を消す口を足すこと自体はこの覚えを壊さない。壊れるのは「段1を通さず
   * 覚えの中身から結果を組む」形へ変えたときである（この境目を
   * 変異試験で確かめてある——下の `listJobs()` テストの節を見よ）。
   *
   * **`ok: true` の `job` は {@link deepFreeze} で凍らせてある。** 理由は
   * `manager.ts` の書き換え方にある——`ManagerPool` は `listJobs()` が
   * 返した `Job` を `#records` に積んでから直接書き換える
   * （`record.job.status = …` 等が20箇所以上）。凍らせた物体をそのまま
   * 返すと、その書き換えが覚えを汚染し、**まだ `putJob` していない値**が
   * 他の `listJobs()` 呼び手（`digest.ts` や `manager.ts` の `find` 群）に
   * 見えてしまう。いまは毎回 parse し直していたのでこの汚染が無かった。
   *
   * **深く凍らせて安全な理由——`manager.ts` を repo 全体で確認した。**
   * `record.job.lease` / `.workspace` / `.lastFailure` / `.lastSystemError`
   * / `.archiveIds` のような入れ子のプロパティへ直接代入する箇所
   * （`record.job.lease` のさらに1段下を書き換える形）は1つも無い。
   * 見つかったのは常に
   * **トップレベルの代入**（`record.job.lease = touchLease(...)` /
   * `record.job.lease = releaseLease(...)` /
   * `record.job.archiveIds = [...(record.job.archiveIds ?? []), id]` の
   * ように、入れ子そのものを新しい値で置き換える形）だけだった
   * （確認した生の grep は PR 本文）。トップレベルの代入は、覚えの中の
   * `Job` の**浅いコピー**（`{ ...entry.job }`）に対して行われる——コピーは
   * 凍っていない新しい物体なので、トップレベルのプロパティを自由に
   * 差し替えられる。差し替えた先の値（`touchLease` 等の戻り値）は
   * 新しく作った未凍結の物体である。**だから深く凍らせても、いま repo に
   * 在るどの書き換えも壊れない**——壊れるとしたら、将来だれかが
   * 「代入」ではなく「入れ子のプロパティへの直接代入」を新しく書いた
   * ときで、そのときは黙って壊れるのではなく `TypeError` で即座に落ちる
   * （strict mode の凍結オブジェクトへの書き込みが投げる）。
   *
   * **段1と段2は別クエリなので、そのあいだに更新された行は「段1の
   * スナップショットより新しい」値で返りうる。ただし古い値が返ることは
   * 無い**（版が変わっていれば必ず引き直すため）。いまの1本の `SELECT`
   * は原子的だったので、これは変わった点である——`ManagerPool.list()` は
   * 既に同じ幅の揺れを許容している（`clone.ts` の
   * `#validityNoticeFor` の doc「まれに、同じターンの本文の中で2つの
   * 断り書きが違う状態を名乗る」）。
   */
  readonly #cache = new Map<string, JobCacheEntry>();

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * スキーマに合わない行は**飛ばすが、飛ばしたことは跡に残す**
   * （Issue #224。日誌の `PgJournalStore#list` と同じ道具・同じ形で揃える —
   * 同じ欠陥に2つの形を作らない、という決裁）。
   *
   * `Job` は `journalEntrySchema` と違って判別子の `type` を持たないので、
   * `journalRowType` はほぼ常に `undefined` を返す（それでよい —
   * `journalRowType` は値を型で判定するだけで、`Job` を特別扱いしない）。
   *
   * `safeParse` の `error.message` は跡へ渡さない（失敗した値そのものを
   * 引用しうる。`packages/core/src/dropped-record.ts` の
   * `noteDroppedJournalRow` の doc）。載せるのは `journalRowType` で安全に
   * 取れた `type` とバイト数だけ。
   *
   * **段1（安い）→段2（普段は0件〜数件）の2段構え（Issue #900）。** 段1で
   * `id` / 版だけを引き、覚え（`#cache`）と版が一致する行は jsonb を
   * 引き直さない。版が変わった／覚えに無い id だけ、段2で jsonb を引く。
   * **段2の対象が0件なら段2のクエリ自体を撃たない**——普段の呼び出しでは
   * 508行のほぼ全部がここで止まる。
   */
  async listJobs(): Promise<Job[]> {
    // 段1: jsonb には触れない。508行でも数十KB程度で済む。
    const rows = await this.#db
      .select({ id: jobs.id, xmin: sql<string>`xmin::text`, updatedAt: jobs.updatedAt })
      .from(jobs)
      .orderBy(asc(jobs.createdAt));

    const versionById = new Map<string, string>();
    const staleIds: string[] = [];
    for (const row of rows) {
      const version = jobRowVersion(row.xmin, row.updatedAt);
      versionById.set(row.id, version);
      const cached = this.#cache.get(row.id);
      if (cached === undefined || cached.version !== version) staleIds.push(row.id);
    }

    // 段2: 版が変わった／覚えに無い行だけ jsonb を引き直す。
    //
    // **`staleIds.length === rows.length`（＝段1の全行が stale。冷たい起動が
    // これに当たる唯一の現実的な形）なら `WHERE id IN (...)` を経由しない。**
    // PostgreSQL のプロトコルはバインド変数を1クエリあたり65,535個までしか
    // 持てない——台帳が65,536行を超えた状態で冷たい1回目を呼ぶと、
    // `inArray(jobs.id, staleIds)` に全行ぶんのバインド変数を積むことになり
    // 落ちる（直す前のコードにはこの落ち方が無かったので、素朴に段2を
    // `inArray` だけで書くと新しい退行を持ち込むことになる）。素の
    // `SELECT id, job FROM jobs` に迂回すればバインド変数を1個も使わない
    // ので、この段差は消える。
    //
    // **`inArray` の側に残る上限はいまも在る。** ただしそちらの `staleIds`
    // は「前回この器が `listJobs()` を呼んで以降に書き換わった行」だけなので、
    // 1回の呼び出しのあいだに65,535行を超えて書き換わることは実運用では
    // 考えにくい。**それでも上限それ自体は消えていないので、ここに明記する**
    // ——起きたら `inArray` 側は素直に失敗する（黙って壊れはしない）。
    if (staleIds.length > 0) {
      const freshRows =
        staleIds.length === rows.length
          ? await this.#db.select({ id: jobs.id, job: jobs.job }).from(jobs)
          : await this.#db
              .select({ id: jobs.id, job: jobs.job })
              .from(jobs)
              .where(inArray(jobs.id, staleIds));
      for (const row of freshRows) {
        const version = versionById.get(row.id);
        // 段1と段2の間に消えた行。いまは台帳の行を消す口が無いので通らないが
        // （`#cache` の doc）、通ったときは（`version` が取れないので）この
        // 行を結果にもキャッシュにも積まない——落ちた行として結果から
        // 落ちるのが正しい振る舞いである。
        if (version === undefined) continue;
        const parsed = jobSchema.safeParse(row.job);
        this.#cache.set(
          row.id,
          parsed.success
            ? { version, ok: true, job: deepFreeze(parsed.data) }
            : { version, ok: false, type: journalRowType(row.job), bytes: byteLength(row.job) },
        );
      }
    }

    // 段1に無くなった id は覚えから落とす。**上限は置かない**——台帳と
    // 同じ大きさまでは伸ばしてよい、というのがここの決裁である
    // （`#cache` の doc）。
    for (const id of [...this.#cache.keys()]) {
      if (!versionById.has(id)) this.#cache.delete(id);
    }

    // 段1の順（`created_at` 昇順）で結果を組む。
    const found: Job[] = [];
    const dropped = new Map<string, number>();
    for (const row of rows) {
      const entry = this.#cache.get(row.id);
      // 段1に在ったのに覚えへ入らなかった行。**段1と段2の間に消えた行だけが
      // ここへ来る**（すぐ上の `version === undefined` の枝を通った行である）。
      // いま台帳の行を消す口は無いので通らないが、通ったときは結果から落ちるのが
      // 正しい（`#cache` の doc「覚えはその前提に依存していない」と同じ向き）。
      if (entry === undefined) continue;
      if (entry.ok) {
        // **浅いコピー。** 凍らせた覚えの中身をそのまま返すと、呼び出し側
        // （`manager.ts`）のトップレベルの書き換えが覚えを汚染する
        // （`#cache` の doc）。
        found.push({ ...entry.job });
      } else {
        noteDroppedJournalRow(dropped, 'unknown-shape', entry.type, entry.bytes);
      }
    }
    noteDroppedJournalRowsSummary(dropped);
    return found;
  }

  async putJob(job: Job): Promise<void> {
    // 依頼文や報告に NUL が混ざりうる（マネージャーの出力をそのまま持つため）
    const value = stripNulls(jobSchema.parse(job));
    await this.#db
      .insert(jobs)
      .values({
        id: value.id,
        status: value.status,
        createdAt: new Date(value.createdAt),
        updatedAt: new Date(value.updatedAt),
        job: value,
      })
      .onConflictDoUpdate({
        target: jobs.id,
        set: { status: value.status, updatedAt: new Date(value.updatedAt), job: value },
      });
  }

  async listApprovals(options: { pendingOnly?: boolean } = {}): Promise<PendingApproval[]> {
    const rows = await this.#db
      .select({ approval: approvals.approval })
      .from(approvals)
      .where(options.pendingOnly === true ? isNull(approvals.answeredAt) : undefined)
      .orderBy(asc(approvals.createdAt));
    return rows.flatMap((row) => {
      const parsed = pendingApprovalSchema.safeParse(row.approval);
      return parsed.success ? [parsed.data] : [];
    });
  }

  async getApproval(id: string): Promise<PendingApproval | null> {
    const rows = await this.#db
      .select({ approval: approvals.approval })
      .from(approvals)
      .where(eq(approvals.id, id))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const parsed = pendingApprovalSchema.safeParse(row.approval);
    return parsed.success ? parsed.data : null;
  }

  async putApproval(approval: PendingApproval): Promise<void> {
    const value = stripNulls(pendingApprovalSchema.parse(approval));
    const answeredAt = value.answeredAt === undefined ? null : new Date(value.answeredAt);
    await this.#db
      .insert(approvals)
      .values({
        id: value.id,
        createdAt: new Date(value.createdAt),
        answeredAt,
        approval: value,
      })
      .onConflictDoUpdate({
        target: approvals.id,
        set: { answeredAt, approval: value },
      });
  }
}

/**
 * jsonb から読み出した（既に解かれた）値のバイト数を測る。`PgJournalStore` の
 * 同名関数と同じ実装（jsonb は pg の駆動子が読み出す時点で JS の値へ解いて
 * しまっているので、`JSON.stringify` へ戻して UTF-8 バイト数を数える）。
 * ファイルをまたいで共有する口が無いので複製している — 跡へ渡すのは数値だけで、
 * 本文を載せないという契約はどちらの複製でも同じである。
 */
function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
}
