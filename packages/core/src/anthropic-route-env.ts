/**
 * SDK 子プロセスの env にある「接続先」と「モデルの別名」を、値を漏らさずに読む。
 *
 * **見るだけで、env は書き換えない・値を落とさない・名前を拒まない。** 置き場を狭めると
 * 人間の能力を削ることになる（north_star 禁止1）ので、出すのは事実と警告だけである。
 * `ALTEROID_*_MODEL`（`model-tier.ts`）は承認の置き場で、ここで見る `ANTHROPIC_DEFAULT_*_MODEL` は
 * その承認を通らずに帯を変えられる別の口である。
 */

/** 重なる順（後ろが勝つ）の1層。`source` は人間が出所を辿るための名前（器・袋・プロファイルなど）。 */
export interface AnthropicRouteLayer {
  source: string;
  env: NodeJS.ProcessEnv;
}

export interface AnthropicRouteInspection {
  /** 置かれていなければ省く。`origin` が `null` なら URL として解析できなかった値。 */
  baseUrl?: { origin: string | null; source: string };
  /** 置かれている接続先用の鍵の名前と出所。**値は持たない。** */
  endpointKeys: { name: string; source: string }[];
  /** Claude のログインの鍵。**値は持たない。** */
  oauth?: { source: string };
  /** `ANTHROPIC_DEFAULT_*_MODEL` と `ANTHROPIC_MODEL`（名前順）。モデル名は秘密ではないので値を持つ。 */
  modelAliases: { name: string; value: string; source: string }[];
}

export const ANTHROPIC_BASE_URL_ENV = 'ANTHROPIC_BASE_URL';
export const ANTHROPIC_ENDPOINT_KEY_ENV_NAMES = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
] as const;
export const CLAUDE_LOGIN_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
const ANTHROPIC_MODEL_ENV = 'ANTHROPIC_MODEL';
const ANTHROPIC_DEFAULT_MODEL_ENV_PATTERN = /^ANTHROPIC_DEFAULT_([A-Z0-9]+)_MODEL$/;

/**
 * 重ねた結果の実効値と、それを決めた層。空・空白だけは「置かれていない」（`placedModelTier` と同じ）。
 * 後ろの層が空文字を置いたら、実際の env でも空文字が勝つので、前の層の値へ戻らない。
 */
function effectiveValue(
  layers: readonly AnthropicRouteLayer[],
  name: string,
): { value: string; source: string } | undefined {
  let decided: { value: string | undefined; source: string } | undefined;
  for (const layer of layers) {
    if (!Object.hasOwn(layer.env, name)) continue;
    decided = { value: layer.env[name], source: layer.source };
  }
  if (decided?.value === undefined) return undefined;
  const trimmed = decided.value.trim();
  return trimmed.length === 0 ? undefined : { value: trimmed, source: decided.source };
}

/** userinfo・パス・クエリに秘密が入りうるので、`origin` 以外は返さない。 */
function originOf(raw: string): string | null {
  try {
    const { origin } = new URL(raw);
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

export function inspectAnthropicRoute(
  layers: readonly AnthropicRouteLayer[],
): AnthropicRouteInspection {
  const base = effectiveValue(layers, ANTHROPIC_BASE_URL_ENV);
  const oauth = effectiveValue(layers, CLAUDE_LOGIN_TOKEN_ENV);
  const endpointKeys: AnthropicRouteInspection['endpointKeys'] = [];
  for (const name of ANTHROPIC_ENDPOINT_KEY_ENV_NAMES) {
    const placed = effectiveValue(layers, name);
    if (placed !== undefined) endpointKeys.push({ name, source: placed.source });
  }
  const names = new Set<string>();
  for (const layer of layers) {
    for (const name of Object.keys(layer.env)) {
      if (name === ANTHROPIC_MODEL_ENV || ANTHROPIC_DEFAULT_MODEL_ENV_PATTERN.test(name)) {
        names.add(name);
      }
    }
  }
  const modelAliases: AnthropicRouteInspection['modelAliases'] = [];
  for (const name of [...names].sort()) {
    const placed = effectiveValue(layers, name);
    if (placed !== undefined) modelAliases.push({ name, ...placed });
  }
  return {
    ...(base === undefined
      ? {}
      : { baseUrl: { origin: originOf(base.value), source: base.source } }),
    endpointKeys,
    ...(oauth === undefined ? {} : { oauth: { source: oauth.source } }),
    modelAliases,
  };
}

/** 何も置かれていないときに self_status が出す1行（「無い」と「見ていない」を分けるため）。 */
export const ANTHROPIC_ROUTE_NONE_LINE =
  'ANTHROPIC_BASE_URL / ANTHROPIC_DEFAULT_*_MODEL / ANTHROPIC_MODEL はどれも置かれていない';

/**
 * 表示用の行（行頭に `- ` を付けない。字下げや接頭辞は呼ぶ側が付ける）。何も無ければ空配列。
 * `apiKeyHelper`（settings 側）は env ではないので見ていない。
 */
export function describeAnthropicRoute(inspection: AnthropicRouteInspection): string[] {
  const lines: string[] = [];
  const { baseUrl } = inspection;
  if (baseUrl !== undefined) {
    const origin = baseUrl.origin ?? '解析できない値';
    if (inspection.endpointKeys.length === 0) {
      lines.push(
        `⚠️ ANTHROPIC_BASE_URL が ${origin} を指しているが、接続先用の鍵（ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY）が置かれていない。` +
          `Claude のログインの鍵（CLAUDE_CODE_OAUTH_TOKEN）がこの接続先へ送られる（${
            inspection.oauth === undefined
              ? 'いまは置かれていないが、置かれれば送られる'
              : 'いま置かれている'
          }）。` +
          '接続先が Claude の鍵を中継する gateway でないなら、接続先用の鍵を置くこと' +
          '（settings の apiKeyHelper は見ていない）（#4263）',
      );
    }
    lines.push(
      `ANTHROPIC_BASE_URL=${origin}（出所: ${baseUrl.source}）— 送り先が変わっている。別名の先で Claude 以外のモデルが答えうる（#4261）`,
    );
  }
  for (const alias of inspection.modelAliases) {
    const match = ANTHROPIC_DEFAULT_MODEL_ENV_PATTERN.exec(alias.name);
    const meaning =
      match === null
        ? 'Claude Code の既定モデルが変わっている'
        : `別名 ${(match[1] as string).toLowerCase()} の行き先が変わっている`;
    lines.push(
      `${alias.name}=${alias.value}（出所: ${alias.source}）— ${meaning}。ALTEROID_*_MODEL の承認を通っていない（#4261）`,
    );
  }
  return lines;
}
