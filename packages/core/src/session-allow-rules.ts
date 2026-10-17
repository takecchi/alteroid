/**
 * クローンが分類器の拒否に allow した Bash 呼び出しを、同じ入力の1回だけ通す一時規則（#4905）。
 *
 * runner はこの一覧を丸ごと、セッションの flag 層の `permissions.allow` へ置き直す（`AgentManagerSession.setSessionAllowRules`）。
 * 規則は `Bash(<command の全文>)` の完全一致だけを作る。そのセッションの誰が撃っても1回で外す。
 */

/** 規則を作れない command の理由。日誌に載る。 */
export type SessionAllowRuleRefusal = 'command が文字列でない' | '`*` を含む' | '改行を含む';

export type SessionAllowRuleShape =
  | { readonly kind: 'rule'; readonly rule: string; readonly command: string }
  | { readonly kind: 'not-bash' }
  | { readonly kind: 'unruleable'; readonly reason: SessionAllowRuleRefusal };

/**
 * `*` と改行を含む command は規則にしない: Bash の規則の文法では `*` が wildcard、`:*` が前方一致になり、
 * 改行は複数の command を1本に束ねるので、どちらも完全一致より広い規則になりうるため（#4905 の設計）。
 */
export function sessionAllowRuleShapeOf(
  toolName: string | undefined,
  toolInput: unknown,
): SessionAllowRuleShape {
  if (toolName !== 'Bash') return { kind: 'not-bash' };
  const command =
    toolInput !== null && typeof toolInput === 'object' && !Array.isArray(toolInput)
      ? (toolInput as { command?: unknown }).command
      : undefined;
  if (typeof command !== 'string') return { kind: 'unruleable', reason: 'command が文字列でない' };
  if (command.includes('*')) return { kind: 'unruleable', reason: '`*` を含む' };
  if (/[\r\n]/.test(command)) return { kind: 'unruleable', reason: '改行を含む' };
  return { kind: 'rule', rule: `Bash(${command})`, command };
}

/**
 * 委譲先の許可規則（#4952。人間が承認した許可）と一時規則を、セッションへ置く1つの一覧にまとめる（重複は1つ）。
 * 置く口は一覧を丸ごと置き換えるので、片方だけを置くともう片方が消える。一時規則を外しても、同じ文字列の許可規則は残る。
 */
export function mergeSessionAllowRules(
  granted: readonly string[],
  temporary: readonly string[],
): string[] {
  return [...new Set([...granted, ...temporary])];
}

export interface SessionAllowRuleGrant {
  readonly rule: string;
  readonly expiresAt: number;
  /** 拒否されて規則を足させた呼び出しの担い手（`manager:…` / `worker:…`）。 */
  readonly grantActor: string;
  /** 伏せ字済みの入力の先頭（`buildDenialInputHead`）。生の入力は持たない。 */
  readonly inputHead: string | undefined;
}

export interface SessionAllowRuleUse {
  readonly grant: SessionAllowRuleGrant;
  /** 規則に当たる入力を撃った担い手。規則を足させた担い手と違うことがある。 */
  readonly useActor: string;
}

/** 撃ったまま決着しない呼び出しの印を溜め込まない上限。超えたら古い印から捨てる（規則そのものは期限で外れる）。 */
const USE_MARK_LIMIT = 256;

/** 規則の一覧と、規則に当たった呼び出しの印。時刻は呼び出し側から渡す（時計を持たない）。 */
export class SessionAllowRuleBook {
  readonly #grants = new Map<string, SessionAllowRuleGrant>();
  readonly #uses = new Map<string, { readonly rule: string; readonly useActor: string }>();

  get size(): number {
    return this.#grants.size;
  }

  rules(): string[] {
    return [...this.#grants.keys()];
  }

  /** 同じ規則が既に在れば置き換える（期限は新しい方）。 */
  add(grant: SessionAllowRuleGrant): void {
    this.#grants.delete(grant.rule);
    this.#grants.set(grant.rule, grant);
  }

  /** 足せなかった規則を一覧から戻す。 */
  remove(rule: string): SessionAllowRuleGrant | undefined {
    const grant = this.#grants.get(rule);
    if (grant === undefined) return undefined;
    this.#grants.delete(rule);
    this.#dropUsesOf(rule);
    return grant;
  }

  /** 寿命ちょうどのミリ秒も「過ぎた」側に含める（`#consumeOneShotAllow` と同じ）。 */
  sweepExpired(nowMs: number): SessionAllowRuleGrant[] {
    const expired: SessionAllowRuleGrant[] = [];
    for (const [rule, grant] of this.#grants) {
      if (grant.expiresAt > nowMs) continue;
      expired.push(grant);
      this.#grants.delete(rule);
      this.#dropUsesOf(rule);
    }
    return expired;
  }

  drainAll(): SessionAllowRuleGrant[] {
    const all = [...this.#grants.values()];
    this.#grants.clear();
    this.#uses.clear();
    return all;
  }

  /** 生きている規則と完全一致する Bash の呼び出しに印を付ける。付けたら true。 */
  markUse(input: {
    toolUseId: string | undefined;
    toolName: string | undefined;
    toolInput: unknown;
    useActor: string;
    nowMs: number;
  }): boolean {
    if (input.toolUseId === undefined) return false;
    const shape = sessionAllowRuleShapeOf(input.toolName, input.toolInput);
    if (shape.kind !== 'rule') return false;
    const grant = this.#grants.get(shape.rule);
    if (grant === undefined || grant.expiresAt <= input.nowMs) return false;
    this.#uses.set(input.toolUseId, { rule: shape.rule, useActor: input.useActor });
    while (this.#uses.size > USE_MARK_LIMIT) {
      const oldest = this.#uses.keys().next();
      if (oldest.done === true) break;
      this.#uses.delete(oldest.value);
    }
    return true;
  }

  /**
   * 印の付いた呼び出しが決着したら、その規則を外して返す。印が無い・規則が既に外れていれば undefined。
   * 同じ規則に当たった別の呼び出しの印も消す: 規則は1回で使い切るため。
   */
  settleUse(toolUseId: string | undefined): SessionAllowRuleUse | undefined {
    if (toolUseId === undefined) return undefined;
    const mark = this.#uses.get(toolUseId);
    if (mark === undefined) return undefined;
    this.#uses.delete(toolUseId);
    const grant = this.#grants.get(mark.rule);
    if (grant === undefined) return undefined;
    this.#grants.delete(mark.rule);
    this.#dropUsesOf(mark.rule);
    return { grant, useActor: mark.useActor };
  }

  #dropUsesOf(rule: string): void {
    for (const [toolUseId, mark] of this.#uses) {
      if (mark.rule === rule) this.#uses.delete(toolUseId);
    }
  }
}
