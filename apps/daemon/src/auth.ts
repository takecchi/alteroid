import {
  createGoogleProvider,
  sha256Hex,
  timingSafeEqualHex,
  type AuthAccount,
  type AuthProvider,
  type IntegrationLimits,
} from '@alteroid/core';
import type { Context } from 'hono';

export const AUTH_ENV = 'ALTEROID_AUTH';
export const PUBLIC_URL_ENV = 'ALTEROID_PUBLIC_URL';
export const GOOGLE_CLIENT_ID_ENV = 'ALTEROID_GOOGLE_CLIENT_ID';
export const GOOGLE_CLIENT_SECRET_ENV = 'ALTEROID_GOOGLE_CLIENT_SECRET';
export const TOKEN_TTL_ENV = 'ALTEROID_ACCESS_TOKEN_TTL_DAYS';

// 素の `GOOGLE_CLIENT_ID` を伏せない: 人間が MCP サーバ等で使っているものを巻き添えにするとデグレードになるため。
export const AUTH_WITHHELD_ENV_KEYS = [GOOGLE_CLIENT_ID_ENV, GOOGLE_CLIENT_SECRET_ENV] as const;

export interface AuthPlan {
  enabled: boolean;
  providers: AuthProvider[];
  publicBaseUrl: string;
  tokenTtlDays: number | null;
  description: string;
}

// 設定していない人は有効にしない: `alteroid chat` が突然通らなくなるデグレードになるため。明示の `off` 以外は設定していれば自動で有効にする: 設定したのに有効にならない方が事故のため。
export function planAuth(
  env: NodeJS.ProcessEnv = process.env,
  options: { port: number } = { port: 4517 },
): AuthPlan {
  const providers: AuthProvider[] = [];

  const googleId = env[GOOGLE_CLIENT_ID_ENV];
  const googleSecret = env[GOOGLE_CLIENT_SECRET_ENV];
  if (
    googleId !== undefined &&
    googleId.length > 0 &&
    googleSecret !== undefined &&
    googleSecret.length > 0
  ) {
    providers.push(createGoogleProvider({ clientId: googleId, clientSecret: googleSecret }));
  }

  const mode = (env[AUTH_ENV] ?? '').trim().toLowerCase();
  const enabled = mode === 'off' ? false : mode === 'on' ? true : providers.length > 0;

  const publicBaseUrl = (env[PUBLIC_URL_ENV] ?? '').trim().replace(/\/+$/, '');

  return {
    enabled,
    providers,
    tokenTtlDays: parseTokenTtlDays(env[TOKEN_TTL_ENV]),
    publicBaseUrl: publicBaseUrl.length > 0 ? publicBaseUrl : `http://127.0.0.1:${options.port}`,
    description: describe(enabled, providers, mode),
  };
}

function parseTokenTtlDays(raw: string | undefined): number | null {
  const value = (raw ?? '').trim().toLowerCase();
  if (value.length === 0) return 30;
  if (value === 'off' || value === '0') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

function describe(enabled: boolean, providers: AuthProvider[], mode: string): string {
  if (!enabled) {
    return mode === 'off'
      ? `認証は無効（${AUTH_ENV}=off）。手前に境界を置くこと。`
      : `認証は無効（ログイン手段が未設定）。${GOOGLE_CLIENT_ID_ENV} と ${GOOGLE_CLIENT_SECRET_ENV} を設定すると有効になる。`;
  }
  if (providers.length === 0) {
    return `認証は有効だがログイン手段が無い（${AUTH_ENV}=on）。実行環境の持ち主（状態ファイルを読める者）だけが使える。`;
  }
  return `認証は有効。ログイン手段: ${providers.map((provider) => provider.id).join(', ')}`;
}

export type Principal =
  | { kind: 'operator'; auth: 'disabled' | 'operator-token' }
  | { kind: 'account'; account: AuthAccount }
  | {
      kind: 'integration';
      keyId: string;
      name: string;
      source: string;
      limits: IntegrationLimits;
    };

export interface AuthVariables {
  principal: Principal;
}

export function bearerOf(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

// 認証が無効のときもこの判定は素通しにしない: `/health` がこの結果で自分の起こしたデーモンかを答えており、素通しにすると PID 再利用の検知が壊れるため。
export function isOperator(c: Context, operatorToken: string): boolean {
  const presented = bearerOf(c.req.header('authorization'));
  if (presented === null) return false;
  return timingSafeEqualHex(sha256Hex(presented), sha256Hex(operatorToken));
}
