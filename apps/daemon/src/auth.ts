import {
  createGoogleProvider,
  sha256Hex,
  timingSafeEqualHex,
  type AuthAccount,
  type AuthProvider,
} from '@alteroid/core';
import type { Context } from 'hono';

/**
 * 「誰がこの API を叩いているか」の設定。
 *
 * **これは実行環境の境界であって、能力の削除ではない**（north_star 禁止2 が
 * 制限の表現方法として認めているのは方針と境界の2つで、認証情報の配布範囲は
 * 後者そのものである）。クローン・マネージャー・作業者の道具は1つも減らない。
 *
 * **PRD「権限境界」とは別の層である。** あちらは「クローンが何を人間へ確認するか」
 * を記憶で決める話で、行為の一覧を持ってはいけない。こちらは入口の話であり、
 * 持っているのは許可されているか否かの2値だけである。
 */

export const AUTH_ENV = 'ALTEROID_AUTH';
export const PUBLIC_URL_ENV = 'ALTEROID_PUBLIC_URL';
export const GOOGLE_CLIENT_ID_ENV = 'ALTEROID_GOOGLE_CLIENT_ID';
export const GOOGLE_CLIENT_SECRET_ENV = 'ALTEROID_GOOGLE_CLIENT_SECRET';
export const TOKEN_TTL_ENV = 'ALTEROID_ACCESS_TOKEN_TTL_DAYS';

/**
 * マネージャー子プロセスへ渡さない鍵。
 *
 * `credentials.ts` の言い方に合わせると、これは**上（記憶）へ到達する鍵**である。
 * ここを握られると誰でもアクセストークンを発行できてしまい、API 経由で記憶へ
 * 届く。下（外の世界）へ手を伸ばす鍵（`GH_TOKEN` など）とは扱いが逆になる。
 *
 * 環境変数名に `ALTEROID_` を付けてあるのは、人間が MCP サーバ等で使っている
 * 素の `GOOGLE_CLIENT_ID` を巻き添えで伏せないためである（それはデグレードになる）。
 */
export const AUTH_WITHHELD_ENV_KEYS = [GOOGLE_CLIENT_ID_ENV, GOOGLE_CLIENT_SECRET_ENV] as const;

export interface AuthPlan {
  /** 認証を要求するか。 */
  enabled: boolean;
  providers: AuthProvider[];
  /** ブラウザから戻ってくる先の起点（`https://…`）。 */
  publicBaseUrl: string;
  /** 発行するアクセストークンの寿命（日）。`null` で無期限。 */
  tokenTtlDays: number | null;
  /** 人間に見せる一行説明（なぜ有効/無効なのか）。 */
  description: string;
}

/**
 * 環境変数から認証の構成を決める（接続はしない純粋関数）。
 *
 * **既定は「プロバイダが設定されていれば有効」。** 設定していない人の
 * `alteroid chat` が突然通らなくなるのは、境界の導入が実質のデグレードになる
 * 典型例である（north_star「立ち戻るための問い」の最後）。逆に設定したのに
 * 有効にならない方が事故なので、明示の `off` 以外は自動で有効にする。
 */
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

/**
 * 認証を通った相手。
 *
 * `operator` は**実行環境の持ち主**である。`~/.alteroid/state/daemon.json` を
 * 読めることをもって本人とみなす — つまり守っているのはファイルの許可であって、
 * 新しい秘密ではない。ここが「最初の許可を誰が与えるか」の鶏卵問題の出口で、
 * これが無いと誰も `access grant` を実行できない。
 */
export type Principal = { kind: 'operator' } | { kind: 'account'; account: AuthAccount };

export interface AuthVariables {
  principal: Principal;
}

/** `Authorization: Bearer xxx` の値を取り出す。 */
export function bearerOf(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/**
 * 実行環境の持ち主かどうか。
 *
 * **認証が無効のときも、この判定だけは素通しにしない。** `/health` はこの結果で
 * 「いま応答しているのが自分の起こしたデーモンか」を CLI に答えており、
 * 認証の有無で意味が変わってはいけない（PID 再利用の検知が壊れる）。
 */
export function isOperator(c: Context, operatorToken: string): boolean {
  const presented = bearerOf(c.req.header('authorization'));
  if (presented === null) return false;
  return timingSafeEqualHex(sha256Hex(presented), sha256Hex(operatorToken));
}
