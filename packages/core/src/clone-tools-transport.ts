import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * クローンの道具（MCP サーバ）を、今日どおりインプロセス（`type: 'sdk'`。SDK が
 * `createSdkMcpServer` で組む、生きた `McpServer` インスタンスを直接渡す形）で
 * 渡すか、`clone-tool-relay-*`（Issue #486 48(a) 案D）越しの stdio 中継へ
 * 出すかを、環境変数1本で切り替えるための判定（`model-tier.ts` の
 * `resolveModelTier` / `permission-mode.ts` の `resolvePermissionModeFor` と
 * 同じ形）。
 *
 * **ここに居るのは間接層のためではない。** `clone.ts` の本セッションと蒸留の
 * サイドクエリ、両方の組み立て点がこの1本の判定を通すことで、「本セッションは
 * 中継越しなのに蒸留だけインプロセス」のような、層の中でさらに割れた状態を
 * 作らない。
 *
 * ## 既定は今日と1バイトも変えない
 *
 * 未設定・空・空白は `'sdk'`——このファイルが無かった頃と同じインプロセスの
 * 経路をそのまま通る。**中継のホストも子プロセスも一切起こさない。**
 *
 * ## 黙って `stdio` へ倒さない
 *
 * 綴りを間違えた値（例: `stido`）を `stdio` 側へ倒すと、「今日と変わらない
 * つもりが、ある日から気づかないまま中継越しになった」という見えにくい変化が
 * 起きる。かといって黙って `sdk` に倒すのも同じ理由で危うい——`stdio` を
 * 効かせたいと思って綴りを間違えた人間が、変わっていないことに気づけない。
 * **`permission-mode.ts` の `resolvePermissionModeFor` と同じ判断を採る**——
 * 未知の値は例外にして起動を止める。不正な値を確実に人間の目に触れさせる側を、
 * 「とりあえず動かす」側より優先する。
 */
export const CLONE_TOOLS_TRANSPORT_ENV_KEY = 'ALTEROID_CLONE_TOOLS_TRANSPORT';

/** SDK が受け取れる2つの経路。 */
export const CLONE_TOOLS_TRANSPORTS = ['sdk', 'stdio'] as const;

export type CloneToolsTransport = (typeof CLONE_TOOLS_TRANSPORTS)[number];

/** 既定。ここを動かすと「今日と1バイトも変えない」が壊れる。 */
export const DEFAULT_CLONE_TOOLS_TRANSPORT: CloneToolsTransport = 'sdk';

/**
 * 環境変数を見て、クローンの道具の経路を決める。空・空白なら既定（`sdk`）。
 *
 * **未知の値は落とす。** 上の doc の「黙って倒さない」をコードにしたもの——
 * `resolvePermissionModeFor` と同じ理由・同じ形（SDK 側の閉じた列挙とは違い、
 * ここは alteroid 自身が定義する閉じた2値なので、検証しない `resolveModelTier`
 * 側の理由（SDK が増やすモデル名を人間が選べる必要がある）は当たらない）。
 */
export function resolveCloneToolsTransport(
  env: NodeJS.ProcessEnv = process.env,
): CloneToolsTransport {
  const given = env[CLONE_TOOLS_TRANSPORT_ENV_KEY]?.trim();
  if (given === undefined || given.length === 0) return DEFAULT_CLONE_TOOLS_TRANSPORT;
  if ((CLONE_TOOLS_TRANSPORTS as readonly string[]).includes(given)) {
    return given as CloneToolsTransport;
  }
  throw new Error(
    `${CLONE_TOOLS_TRANSPORT_ENV_KEY} の値が不正: ${given}` +
      `（使えるのは ${CLONE_TOOLS_TRANSPORTS.join(' / ')}。既定は ${DEFAULT_CLONE_TOOLS_TRANSPORT}）`,
  );
}

/**
 * クローンの道具の中継（`clone-tool-relay-host.ts`）が listen するソケットを
 * 収める専用ディレクトリ。**同一 UID 以外は traverse できないよう 0700 にする**
 * ——実際に 0700 へ絞るのは `createCloneToolRelayHost` 自身（`socketPath` の
 * 親ディレクトリを常に 0700 にする）。ここは production の既定の置き場を1箇所に
 * 決めるだけである。
 *
 * `credentials.ts` の `DEFAULT_CREDENTIAL_DIR` / `profile.ts` の
 * `DEFAULT_PROFILE_PATH` と同じ `/run/alteroid/...` の並びに揃えてある
 * （`Dockerfile` が `install -d` で先に作る2つと同じ実行時ディレクトリの下）。
 * **あちらの2つは 0711**（クローンとは別 UID で走る runner からも読む必要が
 * あるため）だが、**こちらは同一 UID からしか繋がない**（`clone-tool-relay-host.ts`
 * の doc「UID を跨いで守る形は、このPRの範囲外である」）ので、より狭い 0700 が
 * 正しい。
 */
export const DEFAULT_CLONE_TOOL_RELAY_SOCKET_DIR = '/run/alteroid/clone-tool-relay';

/** そのディレクトリの中の、ソケットファイル自体の名前。 */
export const CLONE_TOOL_RELAY_SOCKET_FILENAME = 'relay.sock';

/**
 * `clone-tool-relay-child.ts` の実行専用の成果物の絶対パスを、呼び出し側
 * （`clone.ts`）の `import.meta.url` から組み立てる。
 *
 * ## なぜ2箇所を候補にするか —— 1本の相対パスでは両方を通せない
 *
 * `packages/core/tsup.config.ts` の doc のとおり、本番のビルドでは `clone.ts` の
 * コードは他の大半のモジュールと一緒に `dist/index.js` へバンドルされ、
 * `clone-tool-relay-child.ts` は（`package.json` の `exports` に載らない、実行
 * 専用の）単独の成果物 `dist/clone-tool-relay-child.js` として**同じ
 * ディレクトリ**に並ぶ。⟹ そのときの相対パスは `./clone-tool-relay-child.js`。
 *
 * ところが vitest はバンドルせず `src/clone.ts` を直接読むので、そちらの
 * `import.meta.url` は `src/` を指す。`src/` に居るのは `.ts` のソース
 * （`clone-tool-relay-child.ts`）だけで、実際に子プロセスとして spawn できる
 * 成果物はビルド済みの `../dist/clone-tool-relay-child.js` の方——
 * `clone-tool-relay-integration.test.ts`（PR1）が同じ相対パスを使っている。
 *
 * **どちらの層にいるかを型やビルド設定からではなく、実際にファイルが在るかで
 * 決める。** 存在するほうを先勝ちで選ぶので、本番（バンドル後）でも試験
 * （バンドル前）でも同じ関数がそのまま両方を解決する。どちらにも無ければ
 * ビルドを忘れていること（`AGENTS.md`「開発手順」の「build が先」）を名指しで
 * 伝える——`spawn` が ENOENT で黙って落ちるより、ここで理由を言うほうが
 * 探しやすい。
 */
export function resolveCloneToolRelayChildEntry(callerModuleUrl: string): string {
  const candidates = [
    new URL('./clone-tool-relay-child.js', callerModuleUrl),
    new URL('../dist/clone-tool-relay-child.js', callerModuleUrl),
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) return path;
  }
  throw new Error(
    'clone-tool-relay-child.js が見つからない' +
      `（試した場所: ${candidates.map((candidate) => fileURLToPath(candidate)).join(', ')}）。` +
      '`pnpm build`（`pnpm --filter @alteroid/core build`）を先に走らせること。',
  );
}
