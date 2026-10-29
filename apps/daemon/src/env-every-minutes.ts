// 止める綴りを1か所に置く: 綴りが割れると人間が覚えることが増えるため。
export const OFF_SPELLINGS: ReadonlySet<string> = new Set(['off', 'none', 'false', '0']);

/** 前後の空白を落とす。空白だけなら置かれていないのと同じに扱う。 */
export function envValue(raw: string | undefined): string | undefined {
  return raw !== undefined && raw.trim().length > 0 ? raw.trim() : undefined;
}

export interface EveryMinutesConfig {
  readonly everyMinutes: number | null;
  readonly notes: string[];
}

/**
 * 「何分ごと／off」の環境変数を読む。止める綴りなら `null`。読めない値と下限を下回る値は、切り上げて採らずに既定へ倒し、注意を残す。
 * 上限はここで見ない: 呼び手が `setTimeout` へ渡す遅延の側で頭打ちにする。
 */
export function readEveryMinutes(
  env: NodeJS.ProcessEnv,
  key: string,
  { defaultMinutes, minMinutes }: { defaultMinutes: number; minMinutes: number },
): EveryMinutesConfig {
  const notes: string[] = [];
  const raw = envValue(env[key]);
  if (raw === undefined) return { everyMinutes: defaultMinutes, notes };
  if (OFF_SPELLINGS.has(raw.toLowerCase())) return { everyMinutes: null, notes };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    notes.push(`${key}="${raw}" は分数として読めないので既定 ${defaultMinutes} を使う`);
    return { everyMinutes: defaultMinutes, notes };
  }
  if (parsed < minMinutes) {
    notes.push(
      `${key}="${raw}" は下限 ${minMinutes} 分を下回っているので既定 ${defaultMinutes} を使う`,
    );
    return { everyMinutes: defaultMinutes, notes };
  }
  return { everyMinutes: parsed, notes };
}
