import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { planAuth } from '../apps/daemon/src/auth.js';
import { readScheduleConfig } from '../apps/daemon/src/schedule.js';
import { APP_ENV_VAR_DEFAULTS } from '../packages/core/src/app-env-var-defaults.js';
import { resolveInboxSettleMs, resolveReportSettleMs } from '../packages/core/src/clone.js';
import { parseTimeOfDay } from '../packages/core/src/schedule.js';
import { resolveTokenSavingExcerpt } from '../packages/core/src/token-saving-switches.js';
import { resolveWithheldReportFlushMs } from '../packages/core/src/withheld-reports.js';

// 既定値は、各読み手（コード）・`APP_ENV_VAR_DEFAULTS`（画面の「既定」と播種）・`compose.yaml` の `${VAR:-既定}` に写されている。
// どれかだけ変えると、画面の既定と実際に走る値が割れる。この試験は写しどうしが一致していることだけを見張る（コードは共通化しない）。

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NO_ENV: NodeJS.ProcessEnv = {};

const defaultOf = (name: string): string => {
  const entry = APP_ENV_VAR_DEFAULTS.find((it) => it.name === name);
  if (entry === undefined) throw new Error(`APP_ENV_VAR_DEFAULTS に ${name} が無い`);
  return entry.value;
};

// 名前 → 「env が空のときに読み手が実際に採る既定」を文字列で返す。TZ は読み手がコードに無い（播種と compose だけ）。
const READER_DEFAULTS: Record<string, (() => string) | null> = {
  TZ: null,
  ALTEROID_DAILY_REPORT_AT: () => JSON.stringify(readScheduleConfig(NO_ENV).dailyReportAt),
  ALTEROID_MEMORY_TIDY_AT: () => JSON.stringify(readScheduleConfig(NO_ENV).memoryTidyAt),
  ALTEROID_INITIATIVE_EVERY: () => String(readScheduleConfig(NO_ENV).initiativeEveryMinutes),
  ALTEROID_REPORT_LOOKBACK_DAYS: () => String(readScheduleConfig(NO_ENV).reportLookbackDays),
  ALTEROID_ACCESS_TOKEN_TTL_DAYS: () => String(planAuth(NO_ENV).tokenTtlDays),
  ALTEROID_INBOX_SETTLE_MS: () => String(resolveInboxSettleMs(NO_ENV)),
  ALTEROID_REPORT_SETTLE_MS: () => String(resolveReportSettleMs(NO_ENV)),
  ALTEROID_WITHHELD_REPORT_FLUSH_MS: () => String(resolveWithheldReportFlushMs(NO_ENV)),
  ALTEROID_TOKEN_SAVING_EXCERPT: () => (resolveTokenSavingExcerpt(NO_ENV) ? '1' : '0'),
};

// 時刻は `TimeOfDay` の形で比べる（文字列の綴りの違いで割れないように）
const expectedReaderValue = (name: string): string =>
  name === 'ALTEROID_DAILY_REPORT_AT' || name === 'ALTEROID_MEMORY_TIDY_AT'
    ? JSON.stringify(parseTimeOfDay(defaultOf(name)))
    : defaultOf(name);

describe('既定値の写しは一致している', () => {
  it('APP_ENV_VAR_DEFAULTS の全項目に、読み手の既定を引く行がこの試験にある（項目を足したら、ここも足す）', () => {
    expect(Object.keys(READER_DEFAULTS).sort()).toEqual(
      APP_ENV_VAR_DEFAULTS.map((entry) => entry.name).sort(),
    );
  });

  for (const [name, reader] of Object.entries(READER_DEFAULTS)) {
    if (reader === null) continue;
    it(`${name}: env が空のときに読み手が採る値は APP_ENV_VAR_DEFAULTS と同じ`, () => {
      expect(reader()).toBe(expectedReaderValue(name));
    });
  }

  it('compose.yaml の ${VAR:-既定}（空でないもの）は APP_ENV_VAR_DEFAULTS と同じ', () => {
    const compose = readFileSync(`${ROOT}compose.yaml`, 'utf8');
    const names = new Set(APP_ENV_VAR_DEFAULTS.map((entry) => entry.name));
    const found = new Map<string, string>();
    for (const match of compose.matchAll(/^\s*([A-Z][A-Z0-9_]*):\s*\$\{\1:-([^}]+)\}\s*$/gm)) {
      const [, name, value] = match;
      if (name !== undefined && value !== undefined && names.has(name)) found.set(name, value);
    }
    // 見つからなければ正規表現が空振りしている（空の一致で緑にしない）
    expect([...found.keys()].sort()).toEqual(
      ['ALTEROID_DAILY_REPORT_AT', 'ALTEROID_INITIATIVE_EVERY', 'TZ'].sort(),
    );
    for (const [name, value] of found) expect(value, name).toBe(defaultOf(name));
  });
});
