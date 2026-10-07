export const PORT_ENV_KEY = 'ALTEROID_PORT';
export const DEFAULT_PORT = 4517;
export const MIN_PORT = 1;
export const MAX_PORT = 65535;

const MAX_SHOWN_CHARS = 40;

export type PortResolution = { ok: true; port: number } | { ok: false; message: string };

function showSafely(raw: string): string {
  const chars = Array.from(raw);
  const shown = chars.slice(0, MAX_SHOWN_CHARS).join('');
  const escaped = shown.replace(/[\p{Cc}\u2028\u2029"\\]/gu, (ch) => {
    if (ch === '"' || ch === '\\') return `\\${ch}`;
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
  return `"${escaped}"${chars.length > MAX_SHOWN_CHARS ? `…（全${chars.length}文字、先頭${MAX_SHOWN_CHARS}文字のみ表示）` : ''}`;
}

// 読めない値は既定へ倒さず断る: 設定の誤りが成功に見え、0 を通すと OS が選んだ port で黙って動くため。
export function resolvePort(env: NodeJS.ProcessEnv = process.env): PortResolution {
  const raw = env[PORT_ENV_KEY];
  const trimmed = raw?.trim() ?? '';
  if (raw === undefined || trimmed === '') return { ok: true, port: DEFAULT_PORT };
  const parsed = /^[0-9]+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (Number.isInteger(parsed) && parsed >= MIN_PORT && parsed <= MAX_PORT) {
    return { ok: true, port: parsed };
  }
  return {
    ok: false,
    message:
      `${PORT_ENV_KEY}=${showSafely(raw)} は待ち受け port として使えません` +
      `（${MIN_PORT}〜${MAX_PORT} の整数が要ります）。` +
      `${MIN_PORT}〜${MAX_PORT} の整数を置くか、${PORT_ENV_KEY} を未設定にしてください` +
      `（未設定なら ${DEFAULT_PORT}）。`,
  };
}
