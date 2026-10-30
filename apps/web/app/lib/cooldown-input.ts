import { isTokenCooldownMs } from '@alteroid/core/token-cooldown-ms';

// 休止の既定は、画面では「時」と「分」の2つの欄で入れ、daemon へはミリ秒（cooldownMs）で送る。
// 範囲の規則（整数で、0 より大きい）は core の `isTokenCooldownMs`（daemon の zod と同じ判定を試験で突き合わせてある）。ここへ数値を写さない
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export interface CooldownDraft {
  hours: string;
  minutes: string;
}

export const EMPTY_COOLDOWN_DRAFT: CooldownDraft = { hours: '', minutes: '' };

// 保存済みの値を時・分に割って、欄の初期値にする。分に満たない端数（ミリ秒）は欄に出ない: 触らずに保存したときは送らないので、そのまま残る
export function cooldownDraftOf(cooldownMs: number): CooldownDraft {
  const hours = Math.floor(cooldownMs / HOUR_MS);
  const minutes = Math.floor((cooldownMs % HOUR_MS) / MINUTE_MS);
  return { hours: String(hours), minutes: String(minutes) };
}

export function isEmptyCooldownDraft(draft: CooldownDraft): boolean {
  return draft.hours.trim() === '' && draft.minutes.trim() === '';
}

export type CooldownCheck = { ok: true; ms: number } | { ok: false; message: string };

const WHOLE_NUMBER = /^[0-9]+$/;

// 1つの欄が空なら 0 として数える（「2 時間ちょうど」を、分の欄を 0 にしなくても入れられるように）
function partOf(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  if (!WHOLE_NUMBER.test(trimmed)) return undefined;
  return Number(trimmed);
}

// 送る前に形を見る。サーバーの失敗の文は書き換えない: ここで言うのは送らずに止めたときの、画面の語の直し方だけ
export function checkCooldownDraft(draft: CooldownDraft): CooldownCheck {
  const hours = partOf(draft.hours);
  const minutes = partOf(draft.minutes);
  if (hours === undefined || minutes === undefined) {
    return {
      ok: false,
      message: '休止の既定の時と分は、0 以上の整数（半角の数字）で入れる。',
    };
  }
  const ms = hours * HOUR_MS + minutes * MINUTE_MS;
  if (isTokenCooldownMs(ms)) return { ok: true, ms };
  // 整数で書いた時と分の合計が通らないのは、0 のとき（正でない）か、大きすぎて整数として扱えないとき
  return {
    ok: false,
    message:
      ms > 0
        ? '休止の既定が長すぎる。時と分を小さくして入れ直す。'
        : '休止の既定は 0 分より長くする。時か分に 1 以上を入れる。',
  };
}

// 保存済みの値の表示。欄と同じ「時間・分」で言う。分に満たない端数があるときは、ミリ秒で添える
export function describeCooldown(cooldownMs: number): string {
  const hours = Math.floor(cooldownMs / HOUR_MS);
  const minutes = Math.floor((cooldownMs % HOUR_MS) / MINUTE_MS);
  const rest = cooldownMs % MINUTE_MS;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours.toLocaleString('ja-JP')}時間`);
  if (minutes > 0) parts.push(`${minutes}分`);
  if (rest > 0) parts.push(`${rest.toLocaleString('ja-JP')}ミリ秒`);
  return parts.length === 0 ? '0分' : parts.join('');
}
