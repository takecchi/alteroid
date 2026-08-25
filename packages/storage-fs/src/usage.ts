import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  USAGE_ESTIMATE_NOTICE,
  foldOneshotUsage,
  foldUsageSnapshot,
  usageAggregateSchema,
  usageBaselineSchema,
  usageDate,
  usageLayerSchema,
  usageRowSchema,
  usageSiteSchema,
} from '@alteroid/core';
import type {
  UsageAccumulation,
  UsageAggregate,
  UsageBaseline,
  UsageFold,
  UsageLayer,
  UsageQuery,
  UsageSite,
  UsageSnapshot,
  UsageStore,
  UsageTotals,
} from '@alteroid/core';
import { z } from 'zod';

/**
 * ファイルに載っている行。**層と場所は既定を入れて読む。**
 *
 * 層の軸はこの機能より後から入ったので、既にある `usage.json` の行には
 * `layer` / `site` が無い。既定無しで読むと**起動時に台帳が丸ごと読めなくなる**
 * （既存の記録が消えたのと同じことになる）。pg 側の
 * `alter table … add column … default 'manager'` と同じ扱いである。
 *
 * **この既定は観測ではない。** どこからが観測かは `layeredAt` が持っていて、
 * `aggregate` が `beforeLayers` として返す。
 */
const storedRowSchema = usageRowSchema.extend({
  layer: usageLayerSchema.default('manager'),
  site: usageSiteSchema.default('session'),
});

/** 同じ理由で、既にある基準にも層の既定を入れて読む。 */
const storedBaselineSchema = usageBaselineSchema.extend({
  layer: usageLayerSchema.default('manager'),
});

const fileSchema = z.object({
  // 日 × actor × モデル × 層 × 場所の複合キーで持つ（rowKey）。配列を毎回全走査
  // せず、増分を足し込む先を鍵で直接引ける。
  //
  // **層と場所を鍵から外さないこと。** クローンは自分のセッション本体と要約の
  // 蒸留の両方で使うので、同じ actor・同じ日・同じモデルで意味の違う行が2つ立つ。
  // 鍵が足りないと増分が先にある行へ足し込まれ、層と場所は先に入った側の値の
  // まま残る ＝ 出力から見分けられない誤帰属になる（pg 側の一意索引と同じ話）。
  rows: z.record(z.string(), storedRowSchema).default({}),
  // 累積の基準は「層 × actor」ごと（baselineKey）。actor の id だけを鍵にすると、
  // 層をまたいで同じ id が来たときに別の累積が1つの基準を共有して差分が嘘になる。
  baselines: z.record(z.string(), storedBaselineSchema).default({}),
  /** 台帳が記録を始めた時刻。1件も record していなければ null。 */
  startedAt: z.string().datetime({ offset: true }).nullable().default(null),
  /**
   * **層と場所の軸**が記録を始めた時刻。まだ1件も record していなければ null。
   *
   * `startedAt` と分けて持つ。台帳（#45）より層の軸のほうが後から入ったので、
   * その間の行の `layer` / `site` は既定値であって観測ではない。1つにすると、
   * 層を足す前の期間が「クローンは使っていなかった」と読める。
   */
  layeredAt: z.string().datetime({ offset: true }).nullable().default(null),
  /**
   * **認証トークンの軸**が記録を始めた時刻。まだ1件も**帰属付きで**記録して
   * いなければ null（Issue #393 受け入れ基準6）。
   *
   * **`layeredAt` と入れる時機が違う。** あちらは最初の `record` で入る（層と場所は
   * 必ず取れるので、記録が始まった時点で軸も始まっている）。こちらは
   * **`tokenId` が付いた `record` で初めて入る** — プールを使っていない器では
   * `record` が何万回来ても最後まで null である。ここを `layeredAt` と揃えて
   * 入れると、**トークンを1本も持っていない器が「トークン軸を観測している」と
   * 名乗る**（そして `byToken` は `null` の1件だけを返すので、出力からは
   * 「1本のトークンで全部使った」と読める）。
   */
  tokensAt: z.string().datetime({ offset: true }).nullable().default(null),
});

type UsageFile = z.infer<typeof fileSchema>;

const EMPTY: UsageFile = {
  rows: {},
  baselines: {},
  startedAt: null,
  layeredAt: null,
  tokensAt: null,
};

function rowKey(
  date: string,
  managerId: string,
  model: string,
  layer: UsageLayer,
  site: UsageSite,
  tokenId: string | undefined,
): string {
  // date / managerId / model は人間や SDK が決める自由な文字列なので、区切りに
  // 使わない制御文字（U+0000）を挟む。layer / site は enum なので自由な文字列では
  // ないが、鍵の作り方を1つに保つために同じ区切りで揃える。
  //
  // **エスケープで書くこと（生のバイトをソースへ置かない）。** 生の NUL を埋めると
  // git がこのファイルを binary と判定し、**PR の差分が1行も読めなくなる**（実際に
  // なっていた）。grep / sed も黙って外す。実行時の値はどちらでも同じなので、
  // 壊れていることが出力に出てこない側の失敗である。
  //
  // **トークンは省略されうるので、空の区画として鍵へ入れる。** 鍵から外すと、
  // 回した前後の増分が同じ行へ足し込まれ、`tokenId` は先に入った側の値のまま
  // 残る ＝ 出力から見分けられない誤帰属になる（層と場所と同じ話）。**空文字を
  // 「トークンが無い」の印として使うのは鍵の中だけで、値には持ち込まない**
  // （`rows` の要素は `tokenId` を持たないままである）。
  return `${date}\u0000${managerId}\u0000${model}\u0000${layer}\u0000${site}\u0000${tokenId ?? ''}`;
}

/**
 * 累積の基準の鍵。**主体は「層 × actor」である**（fileSchema のコメント参照）。
 *
 * actor の id だけを鍵にすると、層をまたいで同じ id が来たときに別の累積が1つの
 * 基準を共有し、差分がまるごと嘘になる。いまは `mgr-` と `clone` で衝突しないが、
 * **衝突しないことに頼らず鍵の側で閉じる。**
 */
function baselineKey(layer: UsageLayer, managerId: string): string {
  return `${layer}\u0000${managerId}`;
}

/**
 * 鍵を値から引き直す。**読むたびに必ず通すこと。**
 *
 * 層の軸が入る前の `usage.json` は、行の鍵が `date/actor/model` の3つ組で、基準の
 * 鍵は actor の id そのものだった。いまの鍵は層と場所を含む。**古い鍵をそのまま
 * 使うと、同じ論理的な1行が古い鍵と新しい鍵の2つに割れる**（合計は
 * `summarizeUsage` が足すので合うが、行の一覧に同じものが2つ並ぶ）。基準に至って
 * は古い鍵が引けなくなり、「基準が無い」と読まれて**次の1回でスナップショットの
 * 全量が増分として積まれる ＝ 記録済みの分の二重計上**になる。
 *
 * だから移行の手順を別に持たず、**鍵を値の純関数にする。** 値の側は
 * `storedRowSchema` / `storedBaselineSchema` が既定を入れて読めるようにしてあるので、
 * 古いファイルも新しいファイルも同じ形に落ちる。
 */
function normalizeKeys(file: UsageFile): UsageFile {
  const rows: UsageFile['rows'] = {};
  for (const row of Object.values(file.rows)) {
    rows[rowKey(row.date, row.managerId, row.model, row.layer, row.site, row.tokenId)] = row;
  }
  const baselines: UsageFile['baselines'] = {};
  for (const baseline of Object.values(file.baselines)) {
    baselines[baselineKey(baseline.layer, baseline.managerId)] = baseline;
  }
  return { ...file, rows, baselines };
}

/**
 * 帰属の無い行を最後に置く並び（`usage-format.ts` の `groupByToken` と同じ向き）。
 *
 * **番兵の文字で代用しないこと。** `??` で U+FFFF のような「いちばん大きい文字」へ
 * 倒すと、その文字が実際に id に現れたときだけ静かに順序が壊れる（id の作り方は
 * ここの管轄ではない）。**pg 側と向きを揃えること**（あちらは列が `not null` で
 * 空文字が入るので、`nullif` を通してから nulls last で並べている）。器が違うだけで
 * 行の並びが変わると、同じ照会が口によって違う順で出る。
 */
function compareTokenId(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a.localeCompare(b);
}

function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    webSearchRequests: a.webSearchRequests + b.webSearchRequests,
    costUsd: a.costUsd + b.costUsd,
  };
}

/**
 * 照会範囲の一部でも台帳の始点より前にかかっていたか。
 *
 * 台帳が一度も record していなければ（`since === null`）、始まっている期間が
 * そもそも無いので常に真。始まっていても、下限の無い照会（`from` 省略）は
 * その前を含みうるので真。下限があるときだけ、始点の日付と比べる。
 *
 * pg 版（`@alteroid/storage-pg` の `usage.ts`）にも同じ関数がある。**器ごとに
 * 別の場所へ書く**のは、`LOGIN_REQUEST_RETENTION_MS` が fs / pg の `auth.ts` に
 * それぞれ独立して置かれているのと同じ判断（共有先は `@alteroid/core` だが、
 * この関数はどちらのドライバの内部実装にも属さない補助でしかない）。
 */
function isBeforeLedger(since: string | null, from: string | undefined): boolean {
  if (since === null) return true;
  if (from === undefined) return true;
  return from < usageDate(new Date(since));
}

/**
 * 照会範囲の一部でも**層と場所の軸**の始点より前にかかっていたか。
 *
 * `isBeforeLedger` と同じ形だが、守っているものが違う — あちらは「合計が 0 なのか
 * 記録が無いのか」、こちらは「層と場所の内訳が本物の観測か、後から入れた既定値か」
 * である。層の軸は台帳より後から入ったので、それより前の行は全部 `manager` /
 * `session` に見える。それは「クローンが使っていなかった」ではない。
 */
function isBeforeLayers(layeredAt: string | null, from: string | undefined): boolean {
  if (layeredAt === null) return true;
  if (from === undefined) return true;
  return from < usageDate(new Date(layeredAt));
}

/**
 * 照会範囲の一部でも**認証トークンの軸**の始点より前にかかっていたか。
 *
 * 上の2つと同じ形だが、**null で真を返す道がいちばんよく通る。** 層の軸は最初の
 * record で始まるので `layeredAt` が null なのは記録が1件も無いときだけだが、
 * トークンの軸は**プールを使っていない器では最後まで始まらない**（`tokensAt` の
 * doc）。だからここは「まだ始まっていない」ではなく「この器では取れない」の
 * 意味で真になることがあり、それを出力に出すのは呼び出し側である。
 */
function isBeforeTokens(tokensAt: string | null, from: string | undefined): boolean {
  if (tokensAt === null) return true;
  if (from === undefined) return true;
  return from < usageDate(new Date(tokensAt));
}

/**
 * 利用状況の台帳 = 1枚の JSON（`~/.alteroid/usage/usage.json`）。
 *
 * pg 版と同じ4つの概念を1ファイルに持つ: 日次の増分（`rows`）、累積を持つ主体
 * ごとの基準（`baselines`）、台帳の開始時刻（`startedAt`）、層と場所の軸が
 * 始まった時刻（`layeredAt`）。
 */
export class FsUsageStore implements UsageStore {
  readonly #dir: string;
  readonly #path: string;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'usage.json');
  }

  /**
   * 累積スナップショットを畳んで書く。
   *
   * **読み（基準を引く）と書き（増分を積む）を同じ排他区間に閉じる。** 分けると、
   * 隙間で同じマネージャーの次の result が届いたときに同じ増分が2回積まれる
   * （`store.ts` の `UsageStore.record` 契約）。差分の計算そのものは
   * `foldUsageSnapshot` に任せ、ここでロジックを二重に持たない。
   */
  async record(input: {
    layer: UsageLayer;
    site: UsageSite;
    managerId: string;
    date: string;
    at: string;
    snapshot: UsageSnapshot;
    accumulation: UsageAccumulation;
    tokenId?: string;
  }): Promise<UsageFold> {
    return this.#mutate((file) => {
      // **累積の器は `query()` 呼び出しの寿命で閉じる**（`usage.ts` の
      // `usageAccumulationSchema`）。1回で閉じる呼び出しに基準を持たせると、
      // 前回より高くついた回だけが差に縮んで黙って目減りする。
      const baseKey = baselineKey(input.layer, input.managerId);
      const baseline = input.accumulation === 'oneshot' ? null : (file.baselines[baseKey] ?? null);
      const fold =
        input.accumulation === 'oneshot'
          ? foldOneshotUsage(input.snapshot)
          : foldUsageSnapshot(baseline, input.snapshot, input.at);
      // foldUsageSnapshot は基準が無ければ layer / managerId を空で返す
      // （呼び出し側が知っている値を後から入れる契約 — usage.ts 参照）。
      const nextBaseline: UsageBaseline | null =
        fold.baseline === null
          ? null
          : { ...fold.baseline, layer: input.layer, managerId: input.managerId };

      const rows = { ...file.rows };
      // 増えていないモデルの行は作らない。fold が既に 0 のモデルを delta から
      // 落としているので、ここは delta にある分だけを足し込めばよい。
      for (const [model, delta] of Object.entries(fold.delta)) {
        const key = rowKey(
          input.date,
          input.managerId,
          model,
          input.layer,
          input.site,
          input.tokenId,
        );
        const existing = rows[key];
        rows[key] = {
          date: input.date,
          managerId: input.managerId,
          model,
          layer: input.layer,
          site: input.site,
          // **無いときはキーそのものを置かない。** `tokenId: undefined` を書くと
          // JSON へは出ないので同じに見えるが、`storedRowSchema` を通した後の
          // オブジェクトの形が呼び出しごとに揺れる。取れない軸に値を作らない。
          ...(input.tokenId === undefined ? {} : { tokenId: input.tokenId }),
          totals: existing === undefined ? delta : addTotals(existing.totals, delta),
          updatedAt: input.at,
        };
      }

      return {
        next: {
          rows,
          // `oneshot` は基準を持たない。既にある基準を消しもしない
          // （同じ主体が cumulative でも記録していることがある）。
          baselines:
            nextBaseline === null ? file.baselines : { ...file.baselines, [baseKey]: nextBaseline },
          // 最初の record で1度だけ入れる。既にあれば上書きしない。
          startedAt: file.startedAt ?? input.at,
          // 層の軸が始まった時刻も同じく1度だけ。**`startedAt` と揃えて入れない**
          // — 台帳のほうが先に始まっている DB では別の時刻になる。
          layeredAt: file.layeredAt ?? input.at,
          // **トークンの軸は「帰属が付いた record」でだけ始まる**（`tokensAt` の doc）。
          // ここを `?? input.at` だけにすると、プールを1本も持っていない器が
          // 「トークン軸を観測している」と名乗る。
          tokensAt: file.tokensAt ?? (input.tokenId === undefined ? null : input.at),
        },
        result: { delta: fold.delta, baseline: nextBaseline, reset: fold.reset },
      };
    });
  }

  async aggregate(query: UsageQuery): Promise<UsageAggregate> {
    const file = await this.#read();
    const rows = Object.values(file.rows)
      .filter((row) => {
        if (query.from !== undefined && row.date < query.from) return false;
        if (query.to !== undefined && row.date > query.to) return false;
        if (query.managerId !== undefined && row.managerId !== query.managerId) return false;
        if (query.layer !== undefined && row.layer !== query.layer) return false;
        if (query.site !== undefined && row.site !== query.site) return false;
        if (query.tokenId !== undefined && row.tokenId !== query.tokenId) return false;
        return true;
      })
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          a.managerId.localeCompare(b.managerId) ||
          a.model.localeCompare(b.model) ||
          a.layer.localeCompare(b.layer) ||
          a.site.localeCompare(b.site) ||
          compareTokenId(a.tokenId, b.tokenId),
      );

    return usageAggregateSchema.parse({
      rows,
      since: file.startedAt,
      layersSince: file.layeredAt,
      tokensSince: file.tokensAt,
      beforeLedger: isBeforeLedger(file.startedAt, query.from),
      beforeLayers: isBeforeLayers(file.layeredAt, query.from),
      beforeTokens: isBeforeTokens(file.tokensAt, query.from),
      notice: USAGE_ESTIMATE_NOTICE,
    });
  }

  async baseline(layer: UsageLayer, managerId: string): Promise<UsageBaseline | null> {
    const file = await this.#read();
    return file.baselines[baselineKey(layer, managerId)] ?? null;
  }

  async #read(): Promise<UsageFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      return normalizeKeys(fileSchema.parse(JSON.parse(raw)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
      throw error;
    }
  }

  /**
   * read-modify-write を直列化する（デーモン1プロセス前提の最小の排他）。
   *
   * `mutate` は書き込む内容と、呼び出し側へ返す値の両方を同じ関数の中で決める。
   * `record` のような「読んだ結果に基づいて書くかどうか・何を書くかを決める操作」
   * を、この区間の外へ出さないこと（`schedules.ts` の `#update` と同じ作法）。
   */
  async #mutate<T>(mutate: (file: UsageFile) => { next: UsageFile; result: T }): Promise<T> {
    const run = this.#chain.then(async () => {
      const { next, result } = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      const tmp = `${this.#path}.tmp`;
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await rename(tmp, this.#path);
      return result;
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }
}
