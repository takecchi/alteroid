/**
 * 接続先（デーモンの所在）の決め方。
 *
 * ## なぜ「ビルド時の環境変数」だけにしないか
 *
 * デーモンと画面の配置は人によって違う。同じホストに両方置く人、`api.example.com`
 * と `www.example.com` に分ける人、デーモンは自宅で画面だけ静的ホスティングに置く人。
 * 接続先をビルドに焼き込むと、**配置ごとに別のビルドが要る**ことになり、公式が配る
 * 成果物が「自分の配置用に自分でビルドし直すもの」に変わる。
 *
 * そこで3段にした。上が勝つ。
 *
 * 1. **人間がこの画面で設定した値**（`localStorage`）— 同じ成果物のまま向き先を変えられる
 * 2. **ビルド時の `VITE_ALTEROID_API_URL`** — 自分でビルドして配る人向けの既定値
 * 3. **同一オリジンの `/api`** — 開発サーバの proxy と、画面の手前に置いた
 *    リバースプロキシが両方これで当たる
 *
 * ## なぜ Cookie を使わないか
 *
 * 3 の同一オリジンに収まる限り Cookie でも困らないが、1 と 2 では画面と API の
 * オリジンが違う。**別ドメイン間の Cookie は成立しない** — `SameSite=None; Secure`
 * にしてもサードパーティ Cookie の廃止と ITP で消えていく経路であり、そもそも
 * `www.hoge.vercel.app` と `api.example.com` のように登録可能ドメインが違えば
 * `Domain` 属性で共有することもできない。
 *
 * だから資格情報は Cookie ではなく**リクエストヘッダ**で運ぶ形にしてある
 * （`app/lib/api.tsx` の `headers`）。ヘッダはオリジンに縛られないのでどの配置でも
 * 同じように動き、かつ**単純リクエストでは付けられない**ので、人間が開いた無関係な
 * ページから勝手に投げられることもない（CSRF が構造的に成立しない）。
 *
 * 認証そのものはこの画面では実装しない（別途進行中）。ここは接続先を決めるところまで。
 */

/** 人間がこの画面で設定した接続先の置き場所。 */
const STORAGE_KEY = 'alteroid.apiBaseUrl';

/** 同一オリジンに置かれた（proxy 済みの）デーモン。 */
export const SAME_ORIGIN_BASE_URL = '/api';

/**
 * 接続先を1つに決める。
 *
 * 引数を取るのは、この判断を**ブラウザ無しで確かめられる**ようにするため
 * （`config.test.ts`）。実行時は引数なしで呼ぶ。
 */
export function resolveApiBaseUrl(
  stored: string | null = readStored(),
  buildTime: string | undefined = import.meta.env.VITE_ALTEROID_API_URL,
): string {
  return normalize(stored) ?? normalize(buildTime) ?? SAME_ORIGIN_BASE_URL;
}

/**
 * 末尾のスラッシュを落とし、空白だけの値を「未設定」に倒す。
 *
 * `''` を通してしまうと「同一オリジン」と区別が付かないまま設定済み扱いになり、
 * 人間が消したつもりの値が残る。
 */
function normalize(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed === '' ? undefined : trimmed;
}

function readStored(): string | null {
  // SPA だが、prerender や typegen の都合で window の無い文脈で読まれうる。
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(STORAGE_KEY);
}

/** 接続先を保存する。`null` で「既定に戻す」。 */
export function storeApiBaseUrl(value: string | null): void {
  if (typeof localStorage === 'undefined') return;
  const normalized = normalize(value);
  if (normalized === undefined) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, normalized);
}

/** 人間が明示的に設定しているか（設定画面の表示に使う）。 */
export function hasStoredApiBaseUrl(): boolean {
  return normalize(readStored()) !== undefined;
}
