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
 * 1. **人間がこの画面で選んだ接続先**（`localStorage`）— 同じ成果物のまま向き先を変えられる
 * 2. **ビルド時の `VITE_ALTEROID_API_URL`** — 自分でビルドして配る人向けの既定値
 * 3. **同一オリジンの `/api`** — 開発サーバの proxy と、画面の手前に置いた
 *    リバースプロキシが両方これで当たる
 *
 * ## 2つの問いを分けて持つ
 *
 * この文書は**2つの別の問い**に答える。混ぜると、片方を直したときにもう片方が
 * 黙って嘘になる。
 *
 * - **「いまどこへ繋いでいるか」** — `resolveApiBaseUrl`。上の3段を1つの値へ潰す
 * - **「どこへ繋げるか（選択肢）」** — `listEndpoints`。3段を*潰さずに*並べる
 *
 * 後者が要るのは、接続先が**複数あるのが普通**だからである（本番と手元、本番と
 * 検証）。潰した値しか持たないと、切り替えるたびに URL を打ち直すことになり、
 * 打ち間違いがそのまま「繋がらない」として返ってくる。
 *
 * ## ビルド時の値が複数持てる形
 *
 * `VITE_ALTEROID_API_URL` は**カンマ（または改行）区切りで複数**書ける。
 * それぞれ `ラベル=URL` の形でラベルを付けてもよい。
 *
 * ```
 * VITE_ALTEROID_API_URL=https://api.example.com
 * VITE_ALTEROID_API_URL=https://api.example.com,http://127.0.0.1:4517
 * VITE_ALTEROID_API_URL=本番=https://api.example.com,ローカル=http://127.0.0.1:4517
 * ```
 *
 * **1つだけ書いた形は今までと1バイトも変わらない**ので、既に配っている成果物の
 * ビルド設定を書き換える必要は無い。
 *
 * `ラベル=URL` と判定するのは、**`=` の右側が URL に見えるときだけ**である
 * （`looksLikeUrl`）。そうしないと `https://api.example.com/?x=1` のような
 * クエリ文字列付きの URL が、最初の `=` で勝手に切られる。
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
 * ## ⚠️ 接続先を「外から渡せる経路」から受け取らないこと
 *
 * クエリ文字列・ハッシュ・`document.referrer` ・ `postMessage` のような、リンクを
 * 踏ませるだけで値を注げる経路から接続先を受け取ってはならない。受け取ってよいのは
 * **人間がこの画面で打った値と選んだ値だけ**である。注げる形にすると、攻撃者の URL
 * を仕込んだリンクが、次のログインの資格情報を攻撃者のサーバへ渡す経路になる。
 * これは歯で固定してある（`scripts/web-api-base-url-no-external-input.test.ts`）。
 */

/** 人間がこの画面で選んだ接続先の置き場所。 */
const SELECTED_KEY = 'alteroid.apiBaseUrl';

/**
 * 人間がこの画面で保存した接続先の一覧の置き場所。
 *
 * **`SELECTED_KEY` とは別に持つ。** 同じ鍵に混ぜると「選んでいる」と「持っている」
 * が区別できなくなり、選び直した瞬間に前の接続先が消える（＝人間が自分で足した
 * ものが、切り替えただけで失われる）。
 */
const ENDPOINTS_KEY = 'alteroid.endpoints';

/** 同一オリジンに置かれた（proxy 済みの）デーモン。 */
export const SAME_ORIGIN_BASE_URL = '/api';

/** 人間がこのブラウザに保存した接続先1件。 */
export interface StoredEndpoint {
  /** 正規化済みの接続先（末尾のスラッシュは落としてある）。一覧の中で一意。 */
  url: string;
  /** 人間が付けた名前。**無くてよい**（無ければ画面は URL をそのまま出す）。 */
  label?: string;
}

/** その接続先が、上の3段のどこから来たか。 */
export type EndpointOrigin = 'buildTime' | 'sameOrigin' | 'stored';

export interface Endpoint extends StoredEndpoint {
  origin: EndpointOrigin;
}

/**
 * 接続先を1つに決める。
 *
 * 引数を取るのは、この判断を**ブラウザ無しで確かめられる**ようにするため
 * （`config.test.ts`）。実行時は引数なしで呼ぶ。
 *
 * **ビルド時の値が複数あるときは先頭が既定である。** 並べた順が優先順位そのもの
 * なので、既定にしたいものを先頭に書く。
 */
export function resolveApiBaseUrl(
  stored: string | null = readSelected(),
  buildTime: string | undefined = readBuildTime(),
): string {
  return normalize(stored) ?? parseBuildTimeEndpoints(buildTime)[0]?.url ?? SAME_ORIGIN_BASE_URL;
}

/**
 * 繋げる先を、**潰さずに**並べる。
 *
 * 並びは3段の順（ビルド時 → 同一オリジン → このブラウザに保存）で、**URL が同じ
 * ものは先に出たほうを残す**。人間がビルド時の既定と同じ URL を保存しても、一覧に
 * 同じ行が2つ出ることはない。
 *
 * **`selected` は、どこにも載っていなくても必ず一覧に入る。** 入れないと、
 * 「いま繋いでいる先が選択肢に無い」状態が作れてしまい、画面は選ばれていない
 * ふりをする（`select` の値がどの `option` とも一致しないと、ブラウザは黙って
 * 先頭を表示する ＝ **実際の接続先と表示が食い違う**）。
 *
 * 引数を取る理由は `resolveApiBaseUrl` と同じ（ブラウザ無しで確かめられるように）。
 */
export function listEndpoints(
  stored: StoredEndpoint[] = readStoredEndpoints(),
  buildTime: string | undefined = readBuildTime(),
  selected: string | null = readSelected(),
): Endpoint[] {
  const entries: Endpoint[] = [];
  const seen = new Set<string>();
  const push = (entry: StoredEndpoint, origin: EndpointOrigin): void => {
    if (seen.has(entry.url)) return;
    seen.add(entry.url);
    entries.push({ ...entry, origin });
  };

  for (const entry of parseBuildTimeEndpoints(buildTime)) push(entry, 'buildTime');
  push({ url: SAME_ORIGIN_BASE_URL }, 'sameOrigin');
  for (const entry of stored) push(entry, 'stored');

  const selectedUrl = normalize(selected);
  if (selectedUrl !== undefined) push({ url: selectedUrl }, 'stored');

  return entries;
}

/**
 * ビルド時の値を一覧へ解く。
 *
 * 壊れた項目（空・ラベルだけ）は落とすが、**URL として妥当かどうかの検査はしない。**
 * ここで弾くと、ビルドした人が書いた値が画面から1文字も見えないまま消える —
 * 「設定したのに出てこない」は、間違った値が出ているより直しにくい。
 */
export function parseBuildTimeEndpoints(
  raw: string | undefined = readBuildTime(),
): StoredEndpoint[] {
  if (raw === undefined || raw === null) return [];
  const out: StoredEndpoint[] = [];
  const seen = new Set<string>();
  for (const item of raw.split(/[,\n]/)) {
    const entry = parseBuildTimeItem(item);
    if (entry === undefined || seen.has(entry.url)) continue;
    seen.add(entry.url);
    out.push(entry);
  }
  return out;
}

function parseBuildTimeItem(item: string): StoredEndpoint | undefined {
  const trimmed = item.trim();
  if (trimmed === '') return undefined;

  const separator = trimmed.indexOf('=');
  if (separator > 0) {
    const label = trimmed.slice(0, separator).trim();
    const rest = trimmed.slice(separator + 1).trim();
    // **右側が URL に見えるときだけ**ラベル付きとして読む（doc 冒頭の理由）。
    if (label !== '' && looksLikeUrl(rest)) {
      const url = normalize(rest);
      return url === undefined ? undefined : { url, label };
    }
  }

  const url = normalize(trimmed);
  return url === undefined ? undefined : { url };
}

/**
 * `ラベル=URL` の右側として受け入れてよい形か。
 *
 * スキーム付き（`https://…`）か、同一オリジンの経路（`/api`）だけ。**ホスト名
 * だけの `example.com` を通さない** — 相対 URL として解決されて、画面と同じ
 * オリジンの `./example.com` を叩きに行く（そして 404 が「繋がらない」として
 * 返る）。
 */
export function looksLikeUrl(value: string): boolean {
  return value.startsWith('/') || /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
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

/** 画面が打った値を保存する前に通す口（`normalize` と同じ規則を外へ出したもの）。 */
export function normalizeEndpointUrl(value: string | null | undefined): string | undefined {
  return normalize(value);
}

function readSelected(): string | null {
  // SPA だが、prerender や typegen の都合で window の無い文脈で読まれうる。
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(SELECTED_KEY);
}

/**
 * ビルド時の値。
 *
 * **1箇所に閉じてある。** `import.meta.env` を各所で直に書くと、既定値を渡す形と
 * 渡さない形が混ざり、テストが `vi.stubEnv` で差し替えたつもりの経路だけが
 * 素通りする。
 */
function readBuildTime(): string | undefined {
  return import.meta.env.VITE_ALTEROID_API_URL;
}

/** 選んでいる接続先を保存する。`null` で「既定に戻す」。 */
export function storeApiBaseUrl(value: string | null): void {
  if (typeof localStorage === 'undefined') return;
  const normalized = normalize(value);
  if (normalized === undefined) localStorage.removeItem(SELECTED_KEY);
  else localStorage.setItem(SELECTED_KEY, normalized);
}

/**
 * いまの接続先が、3段のどこから来たか。
 *
 * `resolveApiBaseUrl` が「どの値か」を答えるのに対し、こちらは「なぜその値か」を
 * 答える。**両方要る** — 人間が値を消したとき、「既定に戻った」のか「消し損ねた」
 * のかは値だけでは区別できない（消えた結果が `buildTime` でも `sameOrigin` でも、
 * 見えている接続先の文字列だけでは同じに見えうる）。
 *
 * **⚠️ `Endpoint.origin` とは別の問いである。** こちらは「**明示の選択が在るか**」
 * を答え、`Endpoint.origin` は「**その接続先が一覧のどこに載っているか**」を答える。
 * 人間が一覧からビルド時の既定を選ぶと、この関数は `'stored'`（選択は在る）を
 * 返し、その行の `origin` は `'buildTime'`（載っているのは既定の段）になる。
 * 「既定に戻す」が押せるかどうかはこちらが決め、画面に出す出どころの文言は
 * `Endpoint.origin` が決める。
 *
 * 引数を取る理由は `resolveApiBaseUrl` と同じ（ブラウザ無しで確かめられるように）。
 */
export type ApiBaseUrlOrigin = 'stored' | 'buildTime' | 'sameOrigin';

export function resolveApiBaseUrlOrigin(
  stored: string | null = readSelected(),
  buildTime: string | undefined = readBuildTime(),
): ApiBaseUrlOrigin {
  if (normalize(stored) !== undefined) return 'stored';
  if (parseBuildTimeEndpoints(buildTime).length > 0) return 'buildTime';
  return 'sameOrigin';
}

/**
 * 人間が明示的に選んでいるか（「既定に戻す」が押せるか）。
 *
 * `resolveApiBaseUrlOrigin` の上に載せ直してある — 出所の判定を1本にするため
 * （前は `normalize(readStored()) !== undefined` を別に計算していた）。
 */
export function hasStoredApiBaseUrl(): boolean {
  return resolveApiBaseUrlOrigin() === 'stored';
}

// --- このブラウザに保存した接続先の一覧 --------------------------------------

/**
 * 保存済みの一覧を読む。
 *
 * **形の違うものを握り潰して「保存済みのつもり」にしない**（`auth.ts` の
 * `readCredential` と同じ方針）。壊れた行は落とすが、読めた行は残す — 1行
 * 壊れただけで人間の一覧が丸ごと消えるほうが害が大きい。
 */
export function readStoredEndpoints(): StoredEndpoint[] {
  if (typeof localStorage === 'undefined') return [];
  const raw = localStorage.getItem(ENDPOINTS_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? sanitizeEndpoints(parsed) : [];
  } catch {
    return [];
  }
}

/** 読み出した配列を `StoredEndpoint[]` に均す（壊れた行と重複を落とす）。 */
export function sanitizeEndpoints(value: unknown[]): StoredEndpoint[] {
  const out: StoredEndpoint[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const { url, label } = item as { url?: unknown; label?: unknown };
    const normalized = normalize(typeof url === 'string' ? url : null);
    if (normalized === undefined || seen.has(normalized)) continue;
    seen.add(normalized);
    const trimmed = typeof label === 'string' ? label.trim() : '';
    out.push(trimmed === '' ? { url: normalized } : { url: normalized, label: trimmed });
  }
  return out;
}

export function storeEndpoints(list: StoredEndpoint[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(ENDPOINTS_KEY, JSON.stringify(list));
}

/**
 * 一覧へ足す / 同じ URL の行の名前を差し替える。**純粋関数**（保存はしない）。
 *
 * 同じ URL を2行持たせない。持たせると、片方を消しても消えたように見えない。
 */
export function upsertEndpoint(list: StoredEndpoint[], entry: StoredEndpoint): StoredEndpoint[] {
  const url = normalize(entry.url);
  if (url === undefined) return list;
  const label = entry.label?.trim();
  const next: StoredEndpoint = label === undefined || label === '' ? { url } : { url, label };
  const index = list.findIndex((item) => item.url === url);
  if (index === -1) return [...list, next];
  // **順番は変えない。** 名前を直しただけで一覧の中で行が跳ぶと、人間は
  // 「別のものが増えた」と読む。
  return list.map((item, i) => (i === index ? next : item));
}

/** 一覧から落とす。**純粋関数**（保存はしない）。 */
export function withoutEndpoint(list: StoredEndpoint[], url: string): StoredEndpoint[] {
  const target = normalize(url);
  if (target === undefined) return list;
  return list.filter((item) => item.url !== target);
}

/**
 * 一覧が無かった頃の「選んでいる接続先」を、一覧へ写す。
 *
 * **この画面には、一覧を持たずに `alteroid.apiBaseUrl` だけを設定してある当事者が
 * 実在する**（入力欄が1つしか無かった頃に、コンソールから手で設定した人を含む）。
 * 写さないと、その人が一度でも別の接続先へ切り替えた瞬間に、元の接続先が一覧から
 * 消える ＝ **人間が自分で入れた値が、切り替えただけで失われる。**
 *
 * `listEndpoints` が「選んでいる先は必ず一覧に入れる」のは*表示*の保証であって、
 * *保存*の保証ではない。両方要る。
 *
 * 何度呼んでも同じ（冪等）。ビルド時の既定と同一オリジンは一覧の別の段が持って
 * いるので写さない。
 */
export function migrateSelectionIntoStoredEndpoints(): void {
  const selected = normalize(readSelected());
  if (selected === undefined || selected === SAME_ORIGIN_BASE_URL) return;
  if (parseBuildTimeEndpoints().some((entry) => entry.url === selected)) return;
  const list = readStoredEndpoints();
  if (list.some((entry) => entry.url === selected)) return;
  storeEndpoints([...list, { url: selected }]);
}
