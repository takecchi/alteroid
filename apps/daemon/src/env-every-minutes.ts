import { isEnvOffSpelling, placedEnvValue, readNumberEnv } from '@alteroid/core';

// 上限は 2^31-1 ms: `setTimeout` はそれを超える遅延を 1ms へ倒し、周期の処理が休みなく回ってしまうため。
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

// `intervalMs`（試験の差し替え）が無ければ分から作り、`setTimeout` の上限で頭打ちにする
export function clampedIntervalMs(intervalMs: number | undefined, everyMinutes: number): number {
  return Math.min(intervalMs ?? everyMinutes * 60_000, MAX_TIMER_DELAY_MS);
}

export interface EveryMinutesConfig {
  readonly everyMinutes: number | null;
  readonly notes: string[];
}

/**
 * 「何分ごと／off」の環境変数を読む。止める綴りなら `null`。読めない値と下限を下回る値は、切り上げて採らずに既定へ倒し、注意を残す。
 * 上限は既定では見ない: 呼び手が `setTimeout` へ渡す遅延の側で頭打ちにする（`clampedIntervalMs`）。
 * 呼び手が下流で値を切り捨てるときは `max`（超えたら既定へ倒す）と `noteNonInteger`（切り捨てた値を注意で言う）を渡す。
 */
export function readEveryMinutes(
  env: NodeJS.ProcessEnv,
  key: string,
  {
    defaultMinutes,
    minMinutes,
    max,
    noteNonInteger = false,
  }: {
    defaultMinutes: number;
    minMinutes: number;
    max?: { minutes: number; text: string };
    noteNonInteger?: boolean;
  },
): EveryMinutesConfig {
  const notes: string[] = [];
  const raw = placedEnvValue(env, key);
  if (raw === null) return { everyMinutes: defaultMinutes, notes };
  if (isEnvOffSpelling(raw)) return { everyMinutes: null, notes };
  let fellBack = false;
  const everyMinutes = readNumberEnv(raw, {
    fallback: defaultMinutes,
    min: minMinutes,
    max: max?.minutes,
    positive: true,
    onProblem: (problem, text) => {
      fellBack = true;
      if (problem === 'not-number' || problem === 'non-positive') {
        notes.push(`${key}="${text}" は分数として読めないので既定 ${defaultMinutes} を使う`);
      } else if (Number(text) < minMinutes) {
        notes.push(
          `${key}="${text}" は下限 ${minMinutes} 分を下回っているので既定 ${defaultMinutes} を使う`,
        );
      } else {
        notes.push(
          `${key}="${text}" は上限 ${max?.text ?? ''} を超えているので既定 ${defaultMinutes} を使う`,
        );
      }
    },
  });
  if (!fellBack && noteNonInteger && !Number.isInteger(everyMinutes)) {
    notes.push(`${key}="${raw}" は整数でないので ${Math.floor(everyMinutes)} 分として扱う`);
  }
  return { everyMinutes, notes };
}
