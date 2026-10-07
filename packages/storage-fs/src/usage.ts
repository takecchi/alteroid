import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  USAGE_ESTIMATE_NOTICE,
  stripNul,
  stripNulFromUnmeteredRecord,
  stripNulFromUsageQuery,
  stripNulFromUsageRecord,
  addUnreadableCounts,
  foldRecordForStore,
  isRealUsageDate,
  usageAggregateSchema,
  usageBaselineSchema,
  usageDate,
  usageLayerSchema,
  usageRowSchema,
  usageSiteSchema,
  usageTurnRowSchema,
  usageUnmeteredRowSchema,
  compareCodeUnits,
} from '@alteroid/core';
import type {
  UnreadableUsageRow,
  UsageAccumulation,
  UsageAggregate,
  UsageBaseline,
  UsageFold,
  UsageRecordRunner,
  UsageLayer,
  UsageQuery,
  UsageSite,
  UsageSnapshot,
  UsageStore,
  UsageTotals,
  UsageUnmeteredRow,
} from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

// 層と場所は既定を入れて読む: 既定無しだと、`layer` / `site` の無い既存の `usage.json` が起動時に台帳ごと読めなくなるため
const storedRowSchema = usageRowSchema.extend({
  layer: usageLayerSchema.default('manager'),
  site: usageSiteSchema.default('session'),
});

const storedBaselineSchema = usageBaselineSchema.extend({
  layer: usageLayerSchema.default('manager'),
});

const storedTurnRowSchema = usageTurnRowSchema;

const typedFileSchema = z.object({
  // 層と場所を鍵から外さない: 増分が先にある行へ足し込まれ、層と場所が先に入った側の値のまま残る誤帰属になるため
  rows: z.record(z.string(), storedRowSchema).default({}),
  // 基準の鍵は「層 × actor」: actor の id だけだと、層をまたいで同じ id が来たとき別の累積が1つの基準を共有して差分が嘘になるため
  baselines: z.record(z.string(), storedBaselineSchema).default({}),
  startedAt: z.string().datetime({ offset: true }).nullable().default(null),
  // `startedAt` と分けて持つ: 層の軸は台帳より後から入ったので、1つにすると層を足す前の期間が「クローンは使っていなかった」と読めるため
  layeredAt: z.string().datetime({ offset: true }).nullable().default(null),
  tokensAt: z.string().datetime({ offset: true }).nullable().default(null),
  turns: z.record(z.string(), storedTurnRowSchema).default({}),
  turnsAt: z.string().datetime({ offset: true }).nullable().default(null),
  unmetered: z.record(z.string(), usageUnmeteredRowSchema).default({}),
});

type UsageFile = z.infer<typeof typedFileSchema>;

// 各エントリはここで検査しない: 行の schema を1回に当てると、1エントリの不正でファイルごと parse が落ちるため
const fileSchema = typedFileSchema.extend({
  rows: z.record(z.string(), z.unknown()).default({}),
  baselines: z.record(z.string(), z.unknown()).default({}),
  turns: z.record(z.string(), z.unknown()).default({}),
});

interface InvalidUsageEntries {
  rows: Record<string, unknown>;
  baselines: Record<string, unknown>;
  turns: Record<string, unknown>;
}

const NO_INVALID: InvalidUsageEntries = { rows: {}, baselines: {}, turns: {} };

function splitRecord<T>(
  label: 'rows' | 'baselines' | 'turns',
  raw: Record<string, unknown>,
  schema: z.ZodType<T>,
): {
  valid: Record<string, T>;
  invalid: Record<string, unknown>;
  unreadable: UnreadableEntry[];
} {
  const valid: Record<string, T> = {};
  const invalid: Record<string, unknown> = {};
  const unreadable: UnreadableEntry[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const result = schema.safeParse(value);
    if (result.success) {
      valid[key] = result.data;
      continue;
    }
    invalid[key] = value;
    const fields = [
      ...new Set(
        result.error.issues.map((issue) =>
          issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)',
        ),
      ),
    ];
    unreadable.push({ raw: value, fields });
    process.stderr.write(
      `alteroid: 使用量台帳の不正なエントリを読み飛ばしました（${label}、鍵=${JSON.stringify(key)}、不正な欄: ${fields.join(',') || '(不明)'}）\n`,
    );
  }
  return { valid, invalid, unreadable };
}

interface UnreadableEntry {
  raw: unknown;
  fields: string[];
}

interface UnreadableUsageEntries {
  rows: UnreadableEntry[];
  turns: UnreadableEntry[];
}

const NO_UNREADABLE: UnreadableUsageEntries = { rows: [], turns: [] };

// 欄が読めない・無いときは残す: 範囲外と言い切れないため
function toUnreadableRows(
  table: 'usage_daily' | 'usage_turns',
  entries: readonly UnreadableEntry[],
  query: UsageQuery,
): UnreadableUsageRow[] {
  const out: UnreadableUsageRow[] = [];
  for (const { raw, fields } of entries) {
    const record =
      typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined;
    const str = (name: string): string | undefined => {
      const value = record?.[name];
      return typeof value === 'string' ? value : undefined;
    };
    const date = str('date');
    if (date !== undefined) {
      if (query.from !== undefined && date < query.from) continue;
      if (query.to !== undefined && date > query.to) continue;
    }
    const differs = (name: string, wanted: string | undefined): boolean => {
      const value = str(name);
      return wanted !== undefined && value !== undefined && value !== wanted;
    };
    if (differs('managerId', query.managerId)) continue;
    if (differs('layer', query.layer)) continue;
    if (differs('site', query.site)) continue;
    if (differs('tokenId', query.tokenId)) continue;
    out.push({
      table,
      ...(date !== undefined && isRealUsageDate(date) ? { date } : {}),
      fields,
    });
  }
  return out;
}

function withInvalid<T>(
  next: Record<string, T>,
  invalid: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(invalid)) {
    if (!(key in next)) merged[key] = value;
  }
  return { ...merged, ...next };
}

const EMPTY: UsageFile = {
  rows: {},
  baselines: {},
  startedAt: null,
  layeredAt: null,
  tokensAt: null,
  turns: {},
  turnsAt: null,
  unmetered: {},
};

function rowKey(
  date: string,
  managerId: string,
  model: string,
  layer: UsageLayer,
  site: UsageSite,
  tokenId: string | undefined,
): string {
  // 生の NUL ではなくエスケープで書く: 生のバイトをソースへ置くと git がこのファイルを binary と判定し、PR の差分が読めなくなるため
  // トークンは省略されうるので、空の区画として鍵へ入れる: 鍵から外すと、回した前後の増分が同じ行へ足し込まれて誤帰属になるため
  return `${date}\u0000${managerId}\u0000${model}\u0000${layer}\u0000${site}\u0000${tokenId ?? ''}`;
}

function turnKey(
  date: string,
  managerId: string,
  layer: UsageLayer,
  site: UsageSite,
  tokenId: string | undefined,
): string {
  return `${date}\u0000${managerId}\u0000${layer}\u0000${site}\u0000${tokenId ?? ''}`;
}

function unmeteredKey(
  date: string,
  managerId: string,
  layer: UsageLayer,
  site: UsageSite,
  provider: string,
  tokenId: string | undefined,
): string {
  return `${date}\u0000${managerId}\u0000${layer}\u0000${site}\u0000${provider}\u0000${tokenId ?? ''}`;
}

function baselineKey(layer: UsageLayer, managerId: string): string {
  return `${layer}\u0000${managerId}`;
}

// 読むたびに鍵を値から引き直す: 古い鍵のままだと同じ行が2つに割れ、基準が引けず次の1回で全量が増分として二重計上されるため
function normalizeKeys(file: UsageFile): UsageFile {
  const rows: UsageFile['rows'] = {};
  for (const row of Object.values(file.rows)) {
    rows[rowKey(row.date, row.managerId, row.model, row.layer, row.site, row.tokenId)] = row;
  }
  const baselines: UsageFile['baselines'] = {};
  for (const baseline of Object.values(file.baselines)) {
    baselines[baselineKey(baseline.layer, baseline.managerId)] = baseline;
  }
  const turns: UsageFile['turns'] = {};
  for (const turn of Object.values(file.turns)) {
    turns[turnKey(turn.date, turn.managerId, turn.layer, turn.site, turn.tokenId)] = turn;
  }
  return { ...file, rows, baselines, turns };
}

// 番兵の文字で代用しない: U+FFFF のような最大文字へ倒すと、その文字が id に現れたときだけ静かに順序が壊れるため
// pg 側と向きを揃える: 器が違うだけで行の並びが変わると、同じ照会が口によって違う順で出るため
function compareTokenId(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return compareCodeUnits(a, b);
}

function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  const unreadable = addUnreadableCounts(a.unreadable, b.unreadable);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    webSearchRequests: a.webSearchRequests + b.webSearchRequests,
    costUsd: a.costUsd + b.costUsd,
    ...(unreadable === undefined ? {} : { unreadable }),
  };
}

function isBeforeLedger(since: string | null, from: string | undefined): boolean {
  if (since === null) return true;
  if (from === undefined) return true;
  return from < usageDate(new Date(since));
}

function isBeforeLayers(layeredAt: string | null, from: string | undefined): boolean {
  if (layeredAt === null) return true;
  if (from === undefined) return true;
  return from < usageDate(new Date(layeredAt));
}

function isBeforeTokens(tokensAt: string | null, from: string | undefined): boolean {
  if (tokensAt === null) return true;
  if (from === undefined) return true;
  return from < usageDate(new Date(tokensAt));
}

function isBeforeTurns(turnsAt: string | null, from: string | undefined): boolean {
  if (turnsAt === null) return true;
  if (from === undefined) return true;
  return from < usageDate(new Date(turnsAt));
}

export class FsUsageStore implements UsageStore {
  readonly #dir: string;
  readonly #path: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'usage.json');
  }

  // 読み（基準を引く）と書き（増分を積む）を同じ排他区間に閉じる: 分けると、隙間で次の result が届いたとき同じ増分が2回積まれるため
  async record(rawInput: {
    layer: UsageLayer;
    site: UsageSite;
    managerId: string;
    date: string;
    at: string;
    snapshot: UsageSnapshot;
    accumulation: UsageAccumulation;
    tokenId?: string;
    runner?: UsageRecordRunner;
  }): Promise<UsageFold> {
    const input = stripNulFromUsageRecord(rawInput);
    return this.#mutate((file) => {
      // `oneshot` には基準を持たせない: 1回で閉じる呼び出しに基準を持たせると、前回より高くついた回だけが差に縮んで黙って目減りするため
      const baseKey = baselineKey(input.layer, input.managerId);
      const baseline = input.accumulation === 'oneshot' ? null : (file.baselines[baseKey] ?? null);
      const { fold, nextBaseline } = foldRecordForStore(baseline, {
        layer: input.layer,
        managerId: input.managerId,
        snapshot: input.snapshot,
        at: input.at,
        accumulation: input.accumulation,
        ...(input.runner === undefined ? {} : { runner: input.runner }),
      });

      const rows = { ...file.rows };
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
          // 無いときはキーそのものを置かない: `tokenId: undefined` だと、`storedRowSchema` を通した後のオブジェクトの形が呼び出しごとに揺れるため
          ...(input.tokenId === undefined ? {} : { tokenId: input.tokenId }),
          totals: existing === undefined ? delta : addTotals(existing.totals, delta),
          updatedAt: input.at,
        };
      }

      const turned = Object.keys(fold.delta).length > 0;
      const turns = { ...file.turns };
      if (turned) {
        const key = turnKey(input.date, input.managerId, input.layer, input.site, input.tokenId);
        const existing = turns[key];
        turns[key] = {
          date: input.date,
          managerId: input.managerId,
          layer: input.layer,
          site: input.site,
          ...(input.tokenId === undefined ? {} : { tokenId: input.tokenId }),
          turns: (existing?.turns ?? 0) + 1,
          updatedAt: input.at,
        };
      }

      return {
        next: {
          rows,
          // `oneshot` でも既にある基準を消さない: 同じ主体が cumulative でも記録していることがあるため
          baselines:
            nextBaseline === null ? file.baselines : { ...file.baselines, [baseKey]: nextBaseline },
          startedAt: file.startedAt ?? input.at,
          // `startedAt` と揃えて入れない: 台帳のほうが先に始まっている DB では別の時刻になるため
          layeredAt: file.layeredAt ?? input.at,
          // トークンの軸は帰属が付いた record でだけ始める: `?? input.at` だけだと、プールを持たない器が「トークン軸を観測している」と名乗るため
          tokensAt: file.tokensAt ?? (input.tokenId === undefined ? null : input.at),
          turns,
          // 回数の軸は「起きた record」でだけ始める: `?? input.at` だと、増分が空の record でも軸が始まったことになるため
          turnsAt: file.turnsAt ?? (turned ? input.at : null),
          unmetered: file.unmetered,
        },
        result: {
          delta: fold.delta,
          baseline: nextBaseline,
          reset: fold.reset,
          ...(fold.skipped === undefined ? {} : { skipped: fold.skipped }),
        },
      };
    });
  }

  async recordUnmetered(rawInput: {
    layer: UsageLayer;
    site: UsageSite;
    managerId: string;
    date: string;
    at: string;
    provider: string;
    tokenId?: string;
  }): Promise<void> {
    const input = stripNulFromUnmeteredRecord(rawInput);
    await this.#mutate((file) => {
      const key = unmeteredKey(
        input.date,
        input.managerId,
        input.layer,
        input.site,
        input.provider,
        input.tokenId,
      );
      const existing = file.unmetered[key];
      return {
        next: {
          ...file,
          unmetered: {
            ...file.unmetered,
            [key]: {
              date: input.date,
              managerId: input.managerId,
              layer: input.layer,
              site: input.site,
              provider: input.provider,
              ...(input.tokenId === undefined ? {} : { tokenId: input.tokenId }),
              turns: (existing?.turns ?? 0) + 1,
              updatedAt: input.at,
            },
          },
        },
        result: undefined,
      };
    });
  }

  async aggregate(rawQuery: UsageQuery): Promise<UsageAggregate> {
    // 絞り込みも NUL を落としてから引く: 書き込みが鍵列の NUL を落として残すため
    const query = stripNulFromUsageQuery(rawQuery);
    const { file, unreadable } = await this.#readAll();
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
          compareCodeUnits(a.date, b.date) ||
          compareCodeUnits(a.managerId, b.managerId) ||
          compareCodeUnits(a.model, b.model) ||
          compareCodeUnits(a.layer, b.layer) ||
          compareCodeUnits(a.site, b.site) ||
          compareTokenId(a.tokenId, b.tokenId),
      );

    const turnRows = Object.values(file.turns)
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
          compareCodeUnits(a.date, b.date) ||
          compareCodeUnits(a.managerId, b.managerId) ||
          compareCodeUnits(a.layer, b.layer) ||
          compareCodeUnits(a.site, b.site) ||
          compareTokenId(a.tokenId, b.tokenId),
      );

    const unmeteredRows: UsageUnmeteredRow[] = Object.values(file.unmetered)
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
          compareCodeUnits(a.date, b.date) ||
          compareCodeUnits(a.managerId, b.managerId) ||
          compareCodeUnits(a.layer, b.layer) ||
          compareCodeUnits(a.site, b.site) ||
          compareCodeUnits(a.provider, b.provider) ||
          compareTokenId(a.tokenId, b.tokenId),
      );

    const unreadableRows = [
      ...toUnreadableRows('usage_daily', unreadable.rows, query),
      ...toUnreadableRows('usage_turns', unreadable.turns, query),
    ];

    return usageAggregateSchema.parse({
      rows,
      ...(unreadableRows.length === 0 ? {} : { unreadableRows }),
      ...(unmeteredRows.length === 0 ? {} : { unmeteredRows }),
      since: file.startedAt,
      layersSince: file.layeredAt,
      tokensSince: file.tokensAt,
      beforeLedger: isBeforeLedger(file.startedAt, query.from),
      beforeLayers: isBeforeLayers(file.layeredAt, query.from),
      beforeTokens: isBeforeTokens(file.tokensAt, query.from),
      turnRows,
      turnsSince: file.turnsAt,
      beforeTurns: isBeforeTurns(file.turnsAt, query.from),
      notice: USAGE_ESTIMATE_NOTICE,
    });
  }

  async baseline(layer: UsageLayer, managerId: string): Promise<UsageBaseline | null> {
    managerId = stripNul(managerId);
    const file = await this.#read();
    return file.baselines[baselineKey(layer, managerId)] ?? null;
  }

  // 引数を持たず全期間から作る: `from` / `to` を渡せる形にすると、絞り込みが「行が在る managerId の集合」へ紛れ込むため
  async recordedManagerIds(): Promise<Set<string>> {
    const file = await this.#read();
    return new Set(Object.values(file.rows).map((row) => row.managerId));
  }

  async clear(): Promise<{ daily: number; baseline: number; ledger: number; turns: number }> {
    // 壊れたエントリも消し、件数に数える: pg の `DELETE … RETURNING` と揃えるため
    return this.#mutate(
      (file, invalid) => ({
        next: EMPTY,
        result: {
          daily: Object.keys(file.rows).length + Object.keys(invalid.rows).length,
          baseline: Object.keys(file.baselines).length + Object.keys(invalid.baselines).length,
          ledger: file.startedAt === null ? 0 : 1,
          turns: Object.keys(file.turns).length + Object.keys(invalid.turns).length,
        },
      }),
      { dropInvalid: true },
    );
  }

  async #read(): Promise<UsageFile> {
    return (await this.#readAll()).file;
  }

  async #readAll(): Promise<{
    file: UsageFile;
    invalid: InvalidUsageEntries;
    unreadable: UnreadableUsageEntries;
  }> {
    let top: z.infer<typeof fileSchema>;
    try {
      const raw = await readFile(this.#path, 'utf8');
      top = fileSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { file: EMPTY, invalid: NO_INVALID, unreadable: NO_UNREADABLE };
      throw error;
    }
    const rows = splitRecord('rows', top.rows, storedRowSchema);
    const baselines = splitRecord('baselines', top.baselines, storedBaselineSchema);
    const turns = splitRecord('turns', top.turns, storedTurnRowSchema);
    return {
      file: normalizeKeys({
        ...top,
        rows: rows.valid,
        baselines: baselines.valid,
        turns: turns.valid,
      }),
      invalid: { rows: rows.invalid, baselines: baselines.invalid, turns: turns.invalid },
      unreadable: { rows: rows.unreadable, turns: turns.unreadable },
    };
  }

  // 読んだ結果に基づいて書く操作（`record` など）を、この区間の外へ出さない: 読んでから書くまでに割り込まれるため
  async #mutate<T>(
    mutate: (file: UsageFile, invalid: InvalidUsageEntries) => { next: UsageFile; result: T },
    options: { dropInvalid?: boolean } = {},
  ): Promise<T> {
    return withPathLock(this.#path, async () => {
      const { file, invalid } = await this.#readAll();
      const { next, result } = mutate(file, invalid);
      const kept = options.dropInvalid === true ? NO_INVALID : invalid;
      // 空の `unmetered` は書き出さない: 無報告の provider を使わない器の `usage.json` を1バイトも変えないため
      const { unmetered, ...nextWithoutUnmetered } = next;
      const onDisk = {
        ...nextWithoutUnmetered,
        ...(Object.keys(unmetered).length === 0 ? {} : { unmetered }),
        rows: withInvalid(next.rows, kept.rows),
        baselines: withInvalid(next.baselines, kept.baselines),
        turns: withInvalid(next.turns, kept.turns),
      };
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(this.#path, `${JSON.stringify(onDisk, null, 2)}\n`);
      return result;
    });
  }
}
