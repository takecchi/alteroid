import { noteUnreadableRecord, writeStderrLine } from './dropped-record.js';

// 同じ変数・同じ値では1回だけ出す: 読みは担当（セッション）ごとに呼ばれるので、毎回出すと埋もれるため
const noted = new Set<string>();

/**
 * 環境変数に置かれた値を使わず、既定の値や範囲の端へ倒したときに stderr へ1行残す（#5976）。
 * 黙って倒さない: 人間は「置いたのに効いていない」ことに気づけないため。
 * 文の形は `attachment.ts` の環境変数の注意（`${name}="${raw}" は…既定 N を使う`）にそろえる。
 */
export function noteEnvValueNotUsed(name: string, raw: string, what: string): void {
  const key = `${name}\u0000${raw}`;
  if (noted.has(key)) return;
  noted.add(key);
  writeStderrLine(`alteroid: ${name}="${raw}" は${what}\n`);
}

export type EnvNumberProblem = 'not-number' | 'non-positive' | 'out-of-range' | 'clamped';

export interface EnvNumberSpec {
  readonly fallback: number;
  /** 下限・上限（含む）。 */
  readonly min?: number;
  readonly max?: number;
  /** 0 以下を読めない側へ倒す（0 を有効にする読み手は付けない）。 */
  readonly positive?: boolean;
  /** 通った値を切り捨てる。省略は小数のまま。 */
  readonly floor?: boolean;
  /** 範囲外を端へ挟む（挟んだ値が `used`）。省略は既定へ戻す: 猶予のように短すぎる値が危ない読み手のため。 */
  readonly clamp?: boolean;
  /** 使われなかった・挟まれたときの知らせ（`raw` は trim 済み。文面は呼び手が持つ）。省略すれば黙る。 */
  readonly onProblem?: (problem: EnvNumberProblem, raw: string, used: number) => void;
}

/** 環境変数を数として読む。未設定・空は黙って既定。読めない → 0以下 → 範囲外、の順に見る。 */
export function readNumberEnv(raw: string | undefined, spec: EnvNumberSpec): number {
  const { fallback, min = -Infinity, max = Infinity, onProblem } = spec;
  const text = raw?.trim();
  if (text === undefined || text === '') return fallback;
  const parsed = Number(text);
  const unused = (problem: EnvNumberProblem): number => {
    onProblem?.(problem, text, fallback);
    return fallback;
  };
  if (!Number.isFinite(parsed)) return unused('not-number');
  if (spec.positive === true && parsed <= 0) return unused('non-positive');
  if (parsed >= min && parsed <= max) return spec.floor === true ? Math.floor(parsed) : parsed;
  if (spec.clamp !== true) return unused('out-of-range');
  const clamped = Math.min(max, Math.max(min, parsed));
  onProblem?.('clamped', text, clamped);
  return clamped;
}

/** `readNumberEnv` の知らせを `noteUnreadableRecord` へ流す（値そのものは載せず長さだけ）。文が無い種類は黙る。 */
export function unreadableEnvRecordNote(
  key: string,
  what: string,
  messages: Partial<Record<EnvNumberProblem, string>>,
): (problem: EnvNumberProblem, raw: string) => void {
  return (problem, raw) => {
    const message = messages[problem];
    if (message === undefined) return;
    noteUnreadableRecord(what, `${key} chars=${String(raw.length)}`, new Error(message));
  };
}

/** 試験専用: 1回だけの記憶を消す。 */
export function resetEnvValueNotUsedForTesting(): void {
  noted.clear();
}
