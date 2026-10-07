import { z } from 'zod';

import { fingerprintOf } from './credentials.js';
import { nonBlankString } from './non-blank-string.js';
import { limitRecoveryOf, limitRecoverySchema, type LimitRecovery } from './usage-limits.js';

// 失効（invalidatedAt）を回す契機に含めない（人間の決定）: 現役が失効しても全層が止まったままになり、人間が手で外すまで復旧しない。「未実装」ではなくそう決めたもの
export const tokenRotationPolicySchema = z.enum(['free_exhausted', 'overage_exhausted', 'off']);
export type TokenRotationPolicy = z.infer<typeof tokenRotationPolicySchema>;

export const DEFAULT_TOKEN_ROTATION_POLICY: TokenRotationPolicy = 'free_exhausted';

// いちばん短い枠の単位（5時間）に寄せる: 早く起きすぎるほうが安全側で、長すぎると開いた枠を寝過ごすため。Anthropic 側の枠の仕様の主張ではない
export const DEFAULT_TOKEN_COOLDOWN_MS = 5 * 60 * 60 * 1000;

export const tokenRotationSettingsSchema = z.object({
  rotateOn: tokenRotationPolicySchema,
  cooldownMs: z.number().int().positive(),
  updatedAt: z.string().optional(),
});
export type TokenRotationSettings = z.infer<typeof tokenRotationSettingsSchema>;

export const DEFAULT_TOKEN_ROTATION_SETTINGS: TokenRotationSettings = {
  rotateOn: DEFAULT_TOKEN_ROTATION_POLICY,
  cooldownMs: DEFAULT_TOKEN_COOLDOWN_MS,
};

// notice_text を quota_reset や default と同じ値にしない: 文言から読んだ推測は権威ある値と外し方が違い（default は桁、こちらは日付の取り違え）、潰すとどちらから来たか言えなくなるため。
// 4値を権威ある/推測の2値へ畳まない: 枠と課金枠の食い違いが記録から消え、早いほうを採った理由を検算できなくなるため
export const cooldownSourceSchema = z.enum([
  'quota_reset',
  'overage_reset',
  'notice_text',
  'default',
]);
export type CooldownSource = z.infer<typeof cooldownSourceSchema>;

// 数え上げで書かず Exclude にする: CooldownSource に権威ある値が増えたとき自動で入るため。
// 推測の2値を含めない: default や notice_text を resets.source として渡せると、推測を権威ある値の顔で書き込めるため
export type AuthoritativeCooldownSource = Exclude<CooldownSource, 'default' | 'notice_text'>;

// value を持つのはデーモンの中だけにする: 外へ出す顔は別の型（AgentTokenView）にして、value を型として持たせず書き忘れて漏れる形を消すため
export interface AgentToken {
  id: string;
  label: string;
  // source: 'env' の行は読み捨てる（器の fs / pg 側）: value を持たず、stored の行は必ず値を持つという不変条件を満たさないため
  source?: 'stored';
  value?: string;
  order: number;
  disabledAt?: string;
  cooldownUntil?: number;
  // cooldownSource を default で埋めない: 「推測だと観測した」という嘘になるため。cooldownUntil と組で消す: 期限が無い行に出所だけ残ると指す先が無いため
  cooldownSource?: CooldownSource;
  lastRejectedAt?: string;
  lastRejectedReason?: string;
  // cooldownUntil や disabledAt へ潰さず3つ目の列を持つ: 前者は「待てば戻る」、後者は「人間が外した」という嘘になるため。人間の入力からは設定できない: 観測から立つ記録のため
  invalidatedAt?: string;
  // invalidatedReason を enum にせず観測した語をそのまま持つ: 向こうの語を数え上げると、向こうが増やすたびに静かに腐るため
  // invalidatedReason を switch や includes で判定しない: 解釈しない文字列で、分岐が要るなら構造化された印（SDKAssistantMessageError）を別に持つため
  invalidatedReason?: string;
  // createdAt が無い行を now() で埋め直さない: 「いま作られた」という嘘になるため
  createdAt?: string;
  // 全行に判を押さない: 全文置換なので押すと「最後に誰かが PUT を打った時刻」に化け、どの行がいつ変わったかが取れなくなるため
  updatedAt?: string;
}

export const agentTokenSchema = z.object({
  id: z.string(),
  label: z.string(),
  value: z.string().optional(),
  // 'env' を通さない: 過去の 'env' の行を読む緩い形は storage-fs 側のスキーマが extend して持つため
  source: z.enum(['stored']).optional(),
  order: z.number().int(),
  disabledAt: z.string().optional(),
  cooldownUntil: z.number().optional(),
  cooldownSource: cooldownSourceSchema.optional(),
  lastRejectedAt: z.string().optional(),
  lastRejectedReason: z.string().optional(),
  invalidatedAt: z.string().optional(),
  invalidatedReason: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

// value を持たない: 型として無ければ、書き忘れて漏れる形が作れないため
export const agentTokenViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  order: z.number().int(),
  sha256: z.string().optional(),
  source: z.enum(['stored']).optional(),
  disabledAt: z.string().optional(),
  cooldownUntil: z.number().optional(),
  // 権威ある値のときも必ず出す: 推測のときだけ書くと、欄が無いことが「推測ではない」と「未対応の版」の両方を意味するため
  cooldownSource: cooldownSourceSchema.optional(),
  lastRejectedAt: z.string().optional(),
  lastRejectedReason: z.string().optional(),
  invalidatedAt: z.string().optional(),
  invalidatedReason: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  // 保存せず読むたびに lastRejectedReason から導く: 保存すると分類の表を直したとき古い行だけ古い判定を持ち続け、行から読めないため。
  // lastRejectedReason が無ければ無い: 「拒否されていない」と「分類できない」を unknown に潰さないため
  recovery: limitRecoverySchema.optional(),
});
export type AgentTokenView = z.infer<typeof agentTokenViewSchema>;

export function toAgentTokenView(token: AgentToken): AgentTokenView {
  return agentTokenViewSchema.parse({
    id: token.id,
    label: token.label,
    order: token.order,
    ...(token.value === undefined ? {} : { sha256: fingerprintOf(token.value) }),
    ...(token.source === undefined ? {} : { source: token.source }),
    ...(token.disabledAt === undefined ? {} : { disabledAt: token.disabledAt }),
    ...(token.cooldownUntil === undefined ? {} : { cooldownUntil: token.cooldownUntil }),
    ...(token.cooldownSource === undefined ? {} : { cooldownSource: token.cooldownSource }),
    ...(token.lastRejectedAt === undefined ? {} : { lastRejectedAt: token.lastRejectedAt }),
    ...(token.lastRejectedReason === undefined
      ? {}
      : { lastRejectedReason: token.lastRejectedReason }),
    ...(token.invalidatedAt === undefined ? {} : { invalidatedAt: token.invalidatedAt }),
    ...(token.invalidatedReason === undefined
      ? {}
      : { invalidatedReason: token.invalidatedReason }),
    ...(token.createdAt === undefined ? {} : { createdAt: token.createdAt }),
    ...(token.updatedAt === undefined ? {} : { updatedAt: token.updatedAt }),
    ...(token.lastRejectedReason === undefined
      ? {}
      : { recovery: limitRecoveryOf(token.lastRejectedReason) }),
  });
}

export const agentTokenInputSchema = z.object({
  id: z.string().min(1).optional(),
  // label を trim しない: 検査だけで入力を黙って書き換えないため。保存済みの行の読み出し（agentTokenSchema）は検査しない: 既に空白だけの label が保存されていても読めなくならないため
  label: nonBlankString,
  // value を省略できる: 並べ替え・改名のたびに既存の秘密を貼り直さずに済むため
  value: z.string().min(1).optional(),
  order: z.number().int().optional(),
  disabled: z.boolean().optional(),
});
export type AgentTokenInput = z.infer<typeof agentTokenInputSchema>;

export interface NormalizeTokenPoolOptions {
  now: () => Date;
  newId: () => string;
}

// message をそのまま HTTP 応答へ返す型: 保存対象の値・資格・入力の本文を含めない（id / label だけ）。
// ドライバやライブラリが投げた例外をこの型で包み直さない: 返してよいという約束だけが残って中身の検査が消え、drizzle の束縛パラメータにトークンの値が並ぶため
export class TokenPoolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenPoolInputError';
  }
}

export function normalizeTokenPool(
  inputs: readonly AgentTokenInput[],
  existing: readonly AgentToken[],
  options: NormalizeTokenPoolOptions,
): AgentToken[] {
  const byId = new Map(existing.map((token) => [token.id, token] as const));
  const seenIds = new Set<string>();

  const built = inputs.map((input, index) => {
    if (input.id !== undefined) {
      if (seenIds.has(input.id)) {
        throw new TokenPoolInputError(`トークンの id が入力の中で重複している: ${input.id}`);
      }
      seenIds.add(input.id);
    }

    const current = input.id === undefined ? undefined : byId.get(input.id);
    if (input.id !== undefined && current === undefined) {
      throw new TokenPoolInputError(
        `id ${input.id} のトークンは既存の行に無い（消えた行を静かに作り直さない）`,
      );
    }

    // source は入力から設定させず既存の行から引き継ぐ（invalidatedAt と同じ）
    const source = current?.source;

    const value = input.value ?? current?.value;
    if (value === undefined) {
      throw new TokenPoolInputError(
        `新しいトークン（${input.label}）には value が要る` +
          '（省略できるのは、id で既存の行を指しているときだけ）',
      );
    }

    const nowIso = options.now().toISOString();

    const disabledAt =
      input.disabled === undefined
        ? current?.disabledAt
        : input.disabled
          ? (current?.disabledAt ?? nowIso)
          : undefined;

    const id = current?.id ?? input.id ?? options.newId();
    const order = input.order ?? index;

    // 比べるのはこの経路で変わりうる4つだけにする: 「全フィールド」だと、引き継ぎの側を直したときに黙って判定が変わるため
    const changed =
      current === undefined ||
      current.label !== input.label ||
      current.value !== value ||
      current.order !== order ||
      current.disabledAt !== disabledAt;

    const token: AgentToken = {
      id,
      label: input.label,
      ...(source === undefined ? {} : { source }),
      ...(value === undefined ? {} : { value }),
      order,
      ...(disabledAt === undefined ? {} : { disabledAt }),
      ...(current?.cooldownUntil === undefined ? {} : { cooldownUntil: current.cooldownUntil }),
      ...(current?.cooldownSource === undefined ? {} : { cooldownSource: current.cooldownSource }),
      ...(current?.lastRejectedAt === undefined ? {} : { lastRejectedAt: current.lastRejectedAt }),
      ...(current?.lastRejectedReason === undefined
        ? {}
        : { lastRejectedReason: current.lastRejectedReason }),
      ...(current?.invalidatedAt === undefined ? {} : { invalidatedAt: current.invalidatedAt }),
      ...(current?.invalidatedReason === undefined
        ? {}
        : { invalidatedReason: current.invalidatedReason }),
      ...(current === undefined
        ? { createdAt: nowIso }
        : current.createdAt === undefined
          ? {}
          : { createdAt: current.createdAt }),
      ...(changed
        ? { updatedAt: nowIso }
        : current?.updatedAt === undefined
          ? {}
          : { updatedAt: current.updatedAt }),
    };
    return { token, inputIndex: index };
  });

  // Array#sort の安定性に頼らず inputIndex で tie-break する: エンジンの安定性という間接的な保証に、この関数の契約を委ねないため
  return built
    .sort((a, b) => a.token.order - b.token.order || a.inputIndex - b.inputIndex)
    .map((entry) => entry.token);
}

export interface TokenFailureObservation {
  at: string;
  // 言い換えない: limitRecoveryOf が見る接頭辞が消えて分類が unknown へ落ち、落ちたことが行から分からないため
  message: string;
  // 時刻と出所を1つの組で受ける: 2つの欄に分けると出所の書き忘れが型で通り、「出所が言えなかった回」と見分けが付かないため。取れなかったら 0 や now で埋めず省略する
  resets?: { at: number; source: AuthoritativeCooldownSource };
  // resets と別の欄にする: 推測は記録との min を通る必要があり、同じ欄だと文字列から読んだ値が本物の期限を後ろへ押し出せるため。窓の挟みは渡す側の責任で、ここでは大きさを検査しない: 検査を2箇所に置くと静かにずれるため
  noticeResetsAt?: number;
  // ここで既定値を持たない: 設定を変えたのに片方の経路だけ古い値で動く形が作れるため。resets も無いのに省略しない: 候補が1つも残らず candidates.reduce が空配列で例外を投げるため
  fallbackCooldownMs?: number;
}

// 推測が記録を後ろへ動かさない: 本番で権威ある resetsAt が、後から来た now + 5時間の推測に上書きされて消えたため。
// min を採り据え置きにしない: 据え置きだと遠い期限を縮める経路が markTokenUsable だけになり、probe が判定を返さない器では一度も通らないため。
// resets は min を通さずそのまま採る: 通すといま効いている枠が記録より後ろを指すとき「もう開いた」と主張するため。
// 記録側の出所が無い行は出所を書かない: default で埋めると「推測だと観測した」という嘘になるため。
// 過去の記録を候補にしない: 採ると、止まったことを観測したのに行が ready のまま残るため
function nextCooldownUntil(
  recorded: { until: number | undefined; source: CooldownSource | undefined },
  observation: TokenFailureObservation,
): { until: number; source?: CooldownSource } {
  if (observation.resets !== undefined) {
    return { until: observation.resets.at, source: observation.resets.source };
  }
  const at = Date.parse(observation.at);
  // 並び順が同値のときの優先順: 記録の側は権威ある出所を持ちうるので、そちらを残すほうが失う情報が少ない
  const candidates: { until: number; source?: CooldownSource }[] = [
    ...(recorded.until !== undefined && recorded.until > at
      ? [
          {
            until: recorded.until,
            ...(recorded.source === undefined ? {} : { source: recorded.source }),
          },
        ]
      : []),
    ...(observation.noticeResetsAt === undefined
      ? []
      : [{ until: observation.noticeResetsAt, source: 'notice_text' as const }]),
    ...(observation.fallbackCooldownMs === undefined
      ? []
      : [{ until: at + observation.fallbackCooldownMs, source: 'default' as const }]),
  ];
  return candidates.reduce((best, one) => (one.until < best.until ? one : best));
}

// disabledAt に触れない: 観測が人間の判断を上書きしないため。
// invalidatedAt / invalidatedReason に値を入れない（人間の決定）: 種類で分けるのは記録までにして、扱いは一律で「時間で戻る」と仮定する。limitRecoveryOf が action を返す文言でも冷却へ倒す。
// 過去の resetsAt を未来へ丸めない: 過去の値は「もう戻っている」を正しく表すため
export function markTokenUnusable(
  token: AgentToken,
  observation: TokenFailureObservation,
): AgentToken {
  const cooldown = nextCooldownUntil(
    { until: token.cooldownUntil, source: token.cooldownSource },
    observation,
  );
  const next: AgentToken = {
    ...token,
    lastRejectedAt: observation.at,
    lastRejectedReason: observation.message,
    cooldownUntil: cooldown.until,
    updatedAt: observation.at,
  };
  // 出所が言えない回は欄を消す: 前の行の値が残ると、いま書いた期限の出所として読まれるため
  if (cooldown.source === undefined) delete next.cooldownSource;
  else next.cooldownSource = cooldown.source;
  return next;
}

// disabledAt は消さない: 人間の判断のため。
// 冷却が明けただけでは呼ばない: 観測していない成功を記録することになり、明けたかどうかは cooldownUntil を読めば分かるため
export function markTokenUsable(token: AgentToken, at: string): AgentToken {
  // 消す側を数え上げる（残す側ではなく）: 残す側を並べると、列が増えたとき成功したときだけ黙って落ち、いちばん気づきにくいため
  const next: AgentToken = { ...token, updatedAt: at };
  delete next.lastRejectedAt;
  delete next.lastRejectedReason;
  delete next.cooldownUntil;
  delete next.cooldownSource;
  delete next.invalidatedAt;
  delete next.invalidatedReason;
  return next;
}

export function tokenAvailabilityAt(
  // 実際に見る3つの列だけを受ける: AgentTokenView からも通せるようにするため。二重キャスト（as unknown as AgentToken）で通さない: 列が増えても黙って通り続けるため
  token: Pick<AgentToken, 'disabledAt' | 'invalidatedAt' | 'cooldownUntil'>,
  at: number,
): 'disabled' | 'invalidated' | 'cooling' | 'ready' {
  if (token.disabledAt !== undefined) return 'disabled';
  if (token.invalidatedAt !== undefined) return 'invalidated';
  if (token.cooldownUntil !== undefined && token.cooldownUntil > at) return 'cooling';
  return 'ready';
}

export function tokenRecoveryOf(token: AgentToken): LimitRecovery | undefined {
  return token.lastRejectedReason === undefined
    ? undefined
    : limitRecoveryOf(token.lastRejectedReason);
}

// 現役の指名をプールの行や設定と別に持つ: 行に active: boolean を置くと2行が同時に現役だと主張する形が作れ、設定の updatedAt に混ぜると回すたびに「人間が設定を変えた」ことになるため
export const activeAgentTokenSchema = z.object({
  tokenId: z.string().min(1),
  // 世代で照合する: id だけだと、冷却明けにもう一度選ばれた後の遅れた通知を現役の通知として受け取るため
  generation: z.number().int().nonnegative(),
  rotatedAt: z.string(),
});
export type ActiveAgentToken = z.infer<typeof activeAgentTokenSchema>;

export type TokenCredential = { kind: 'stored'; value: string };

// value が無い行を黙って空文字などへ倒さず投げる: 倒すと値を失った行がそのまま資格として撒かれるため
export function credentialOf(token: AgentToken): TokenCredential {
  if (token.value === undefined || token.value.length === 0) {
    // id と label しか含めない（TokenPoolInputError と同じ）
    throw new TokenPoolInputError(`トークン（id ${token.id} / ${token.label}）は値を持っていない`);
  }
  return { kind: 'stored', value: token.value };
}

// 行の中身（値・指紋）を持たない: 日誌へそのまま書けるよう、id・ラベル・操作の種類・理由だけで作るため
export interface TokenPoolChange {
  operation: 'add' | 'remove' | 'disable' | 'enable' | 'switch' | 'rename';
  id: string;
  label: string;
  reason?: 'value' | 'order';
  widens: boolean;
}

// 試す順は残った行どうしの並びが変わったときだけ switch にする: order の数値だけ変わって並びが同じなら現役は変わらないため
export function classifyTokenPoolChange(
  before: readonly AgentToken[],
  after: readonly AgentToken[],
): TokenPoolChange[] {
  const sortedIds = (rows: readonly AgentToken[], keep: ReadonlySet<string>): string[] =>
    rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => a.row.order - b.row.order || a.index - b.index)
      .map(({ row }) => row.id)
      .filter((id) => keep.has(id));
  const beforeById = new Map(before.map((row) => [row.id, row] as const));
  const afterById = new Map(after.map((row) => [row.id, row] as const));
  const changes: TokenPoolChange[] = [];

  for (const row of after) {
    const previous = beforeById.get(row.id);
    if (previous === undefined) {
      changes.push({ operation: 'add', id: row.id, label: row.label, widens: true });
      continue;
    }
    if (previous.disabledAt === undefined && row.disabledAt !== undefined) {
      changes.push({ operation: 'disable', id: row.id, label: row.label, widens: false });
    } else if (previous.disabledAt !== undefined && row.disabledAt === undefined) {
      changes.push({ operation: 'enable', id: row.id, label: row.label, widens: true });
    }
    if (previous.value !== row.value) {
      changes.push({
        operation: 'switch',
        id: row.id,
        label: row.label,
        reason: 'value',
        widens: true,
      });
    }
    if (previous.label !== row.label) {
      changes.push({ operation: 'rename', id: row.id, label: row.label, widens: false });
    }
  }
  for (const row of before) {
    if (!afterById.has(row.id)) {
      changes.push({ operation: 'remove', id: row.id, label: row.label, widens: false });
    }
  }

  const survivors = new Set(before.filter((row) => afterById.has(row.id)).map((row) => row.id));
  const beforeSequence = sortedIds(before, survivors);
  const afterSequence = sortedIds(after, survivors);
  afterSequence.forEach((id, position) => {
    if (beforeSequence[position] !== id) {
      const row = afterById.get(id);
      if (row !== undefined) {
        changes.push({ operation: 'switch', id, label: row.label, reason: 'order', widens: true });
      }
    }
  });
  return changes;
}

export interface TokenPolicyChange {
  field: 'rotateOn' | 'cooldownMs';
  from: string | undefined;
  to: string;
}

// 冷却の長短は判断せず広げる側（日誌先）に倒す: 安全側のため。after.rotateOn が off なら冷却を変えていても狭める側: 回さないので冷却は効かないため
export function classifyTokenPolicyChange(
  before: TokenRotationSettings | undefined,
  after: Pick<TokenRotationSettings, 'rotateOn' | 'cooldownMs'>,
): { changes: TokenPolicyChange[]; widens: boolean } {
  const changes: TokenPolicyChange[] = [];
  if (before === undefined || before.rotateOn !== after.rotateOn) {
    changes.push({ field: 'rotateOn', from: before?.rotateOn, to: after.rotateOn });
  }
  if (before === undefined || before.cooldownMs !== after.cooldownMs) {
    changes.push({
      field: 'cooldownMs',
      from: before === undefined ? undefined : String(before.cooldownMs),
      to: String(after.cooldownMs),
    });
  }
  return { changes, widens: changes.length > 0 && after.rotateOn !== 'off' };
}
