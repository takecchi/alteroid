import { noteUnreadableRecord } from './dropped-record.js';
import { placedEnvValue } from './placed-env.js';

// 環境変数の on/off（有効・無効）の、たった1つの読み方。値は `placedEnvValue` を通す（空白だけは未設定、前後の空白は落とす）。
// 大文字小文字は問わない。知らない綴りは既定へ倒し、倒したことを呼び手へ返す。
// 門（`ALTEROID_MEMORY_GUARD`・`ALTEROID_BASH_GUARD` ほか）はここへ寄せない: 綴り違いを落として、守っているつもりの持ち主に気づかせる
// 作法（`resolveEnumEnv`）を持ち、ここの「受け付ける綴りを広げる」読み方だと、`false` / `OFF` で黙って門が外れる側に変わるため。
export const ENV_SWITCH_ON_SPELLINGS: readonly string[] = ['on', '1', 'true', 'yes', 'enabled'];
export const ENV_SWITCH_OFF_SPELLINGS: readonly string[] = ['off', '0', 'false', 'no', 'disabled'];

export interface EnvSwitchReading {
  readonly enabled: boolean;
  /** 読めなかった綴り（小文字にした値）。既定へ倒したときだけ載る。 */
  readonly unrecognized?: string;
}

export function readEnvSwitch(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultEnabled: boolean,
): EnvSwitchReading {
  const given = placedEnvValue(env, key)?.toLowerCase();
  if (given === undefined) return { enabled: defaultEnabled };
  if (ENV_SWITCH_ON_SPELLINGS.includes(given)) return { enabled: true };
  if (ENV_SWITCH_OFF_SPELLINGS.includes(given)) return { enabled: false };
  return { enabled: defaultEnabled, unrecognized: given };
}

const notedUnrecognized = new Set<string>();

// 読めない綴りは既定へ倒して stderr へ残す（投げない）。セッションを組むたびに呼ばれうるので、同じ名前・同じ値の痕跡は1プロセスで1回だけ。
export function resolveEnvSwitch(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultEnabled: boolean,
  what: string,
): boolean {
  const reading = readEnvSwitch(env, key, defaultEnabled);
  if (reading.unrecognized === undefined) return reading.enabled;
  const noteKey = `${key}=${reading.unrecognized}`;
  if (!notedUnrecognized.has(noteKey)) {
    notedUnrecognized.add(noteKey);
    noteUnreadableRecord(
      what,
      `${key} chars=${String(reading.unrecognized.length)}`,
      new Error(
        `${ENV_SWITCH_ON_SPELLINGS.join(' / ')} か ${ENV_SWITCH_OFF_SPELLINGS.join(' / ')} だけが読める。既定の ${defaultEnabled ? '有効' : '無効'}で走る`,
      ),
    );
  }
  return reading.enabled;
}

/** テスト用: 読めない綴りの痕跡の「1回だけ」の控えを空にする。 */
export function clearEnvSwitchNotesForTesting(): void {
  notedUnrecognized.clear();
}
