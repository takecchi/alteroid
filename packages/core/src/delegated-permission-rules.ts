import { noteDroppedRecord, reasonOf } from './dropped-record.js';
import { parsePermissionRule } from './permission-rule.js';
import {
  RunnerPermissionRulesUnsupportedError,
  type RunnerClient,
  type RunnerPermissionRulesResult,
  type RunnerRegistry,
} from './runner-protocol.js';
import type { PermissionGrant } from './schema.js';
import { sessionAllowRuleShapeOf } from './session-allow-rules.js';
import type { Stores } from './store.js';

/**
 * 人間が `request_permission` で承認した許可（`stores.permissionGrants`）を、マネージャー・作業者のセッションの
 * flag 層の allow 規則にも載せる（#4952）。デーモンが一覧を丸ごと各 runner へ配り、runner が #4905 の一時規則と
 * 1つの一覧にまとめて置き直す。
 *
 * 載せるのは、取り消されていない許可のうち完全一致（`Bash(<command>)`）の規則だけである。
 * 前方一致（`Bash(<command>:*)`）は載せない: 委譲先へ広がる範囲が大きく、auto mode は危険な前方一致を捨てる
 * （`stripDangerousPermissionsForAutoMode`）ので載せても効かない規則が出うるため。載せるかはオーナーの判断を待つ（#4952 の「決めてほしいこと」）。
 * `*` と改行を含む command も載せない: #4905 の一時規則と同じ判定（`sessionAllowRuleShapeOf`）を通し、完全一致より広い規則を作らないため。
 */

export interface DelegatedPermissionRuleSet {
  /** 重複は1つにした規則の一覧。 */
  readonly rules: string[];
  /** 載せた許可の id（日誌に載せるのは規則の本文ではなくこちら）。 */
  readonly grantIds: string[];
}

/** 許可の規則（`PermissionGrant.rule`）から、委譲先へ載せる規則を作る。載せない形なら `undefined`。取り消しは見ない（`delegatedPermissionRulesOf` が見る）。 */
export function delegatedPermissionRuleOf(grantRule: string): string | undefined {
  const parsed = parsePermissionRule(grantRule);
  if (!parsed.ok || parsed.kind !== 'exact') return undefined;
  const shape = sessionAllowRuleShapeOf('Bash', { command: parsed.command });
  return shape.kind === 'rule' ? shape.rule : undefined;
}

export function delegatedPermissionRulesOf(
  grants: readonly PermissionGrant[],
): DelegatedPermissionRuleSet {
  const rules = new Set<string>();
  const grantIds: string[] = [];
  for (const grant of grants) {
    if (grant.revokedAt !== undefined) continue;
    const rule = delegatedPermissionRuleOf(grant.rule);
    if (rule === undefined) continue;
    rules.add(rule);
    grantIds.push(grant.id);
  }
  return { rules: [...rules], grantIds };
}

/**
 * runner が受けた一覧をもう一度検める（制御面の入口のため、届いたものを信じない）。不正なら投げて、前の一覧を残させる。
 * 断りの文言に規則の本文を載せない: 応答と日誌へ command の全文が流れるため。位置だけを言う。
 */
export function parseDelegatedPermissionRules(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error('許可規則の一覧が配列でない（置いていない）');
  const rules = new Set<string>();
  input.forEach((rule: unknown, index) => {
    if (typeof rule !== 'string' || !isDelegatableRule(rule)) {
      throw new Error(
        `許可規則の一覧の ${index} 番目が、載せてよい形（Bash(<command>) の完全一致・\`*\` と改行を含まない）でない（置いていない）`,
      );
    }
    rules.add(rule);
  });
  return [...rules];
}

function isDelegatableRule(rule: string): boolean {
  return delegatedPermissionRuleOf(rule) === rule;
}

export interface PermissionRulesRunnerResult {
  runnerId: string;
  ok: boolean;
  count?: number;
  changed?: boolean;
  /** 一時障害と混ぜない: 疑う先が「待てば直る」ではなく「runner の版」だから。 */
  unsupported?: true;
  error?: string;
}

// インスタンスは1つだけ作って全経路へ渡す（`McpServerService` と同じ）: 名乗りの降ろし直しと許可の足し引きの配布を同じ列で直列化し、古い一覧が新しい一覧を上書きしないため。
export interface DelegatedPermissionRuleService {
  /**
   * runner が名乗ったときに一覧を降ろす。口を持たない偽物へは `null`。失敗は投げる（日誌と挑み直しは `ManagerPool` が持つ）。
   * 一覧が変わった runner にだけ「配った」を日誌に残す: 名乗り直しのたびに同じ行が積まれないため。
   */
  syncRunner(runner: RunnerClient): Promise<RunnerPermissionRulesResult | null>;
  /**
   * 許可が足された・取り消されたときに、開いている全 runner へ配る。投げない（許可の記録・取り消しは既に効いている）。
   * 配った（runner ごとの件数）・配れなかった（理由）を日誌に残す。値は載せず、件数と許可の id だけにする。
   */
  pushAll(trigger: string): Promise<PermissionRulesRunnerResult[]>;
  // `ManagerPool` が購読して押し込みの帳面に積む（`McpServerService.onPushed` と同じ）。
  onPushed?(listener: (results: readonly PermissionRulesRunnerResult[]) => void): () => void;
}

export interface DelegatedPermissionRuleServiceOptions {
  stores: Pick<Stores, 'permissionGrants' | 'journal'>;
  runners?: RunnerRegistry;
}

export function createDelegatedPermissionRuleService(
  options: DelegatedPermissionRuleServiceOptions,
): DelegatedPermissionRuleService {
  const { stores, runners } = options;
  const pushListeners = new Set<(results: readonly PermissionRulesRunnerResult[]) => void>();

  // 前の失敗で列が止まらないように、常に解決する形で繋ぐ。
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work, work);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function journal(decision: string, grounds: string): Promise<void> {
    try {
      await stores.journal.append({ type: 'decision', decision, grounds });
    } catch (error) {
      noteDroppedRecord('委譲先の許可規則の配布の日誌', decision, error);
    }
  }

  function placedText(
    runnerId: string,
    count: number | undefined,
    set: DelegatedPermissionRuleSet,
  ): string {
    return (
      `${runnerId} へ委譲先の許可規則を ${String(count ?? set.rules.length)} 件配った` +
      `（許可 id: ${set.grantIds.length === 0 ? '(無し)' : set.grantIds.join(', ')}）`
    );
  }

  // 一覧を読む: 載せる許可が読めなければ投げる（空の一覧へ倒さない: 倒すと読めなかった回に全部の規則を外してしまう）。
  async function currentSet(): Promise<DelegatedPermissionRuleSet> {
    return delegatedPermissionRulesOf(await stores.permissionGrants.list());
  }

  return {
    syncRunner: (runner) =>
      serial(async () => {
        if (runner.setPermissionRules === undefined) return null;
        const set = await currentSet();
        const placed = await runner.setPermissionRules(set.rules);
        if (placed.changed) {
          await journal(
            placedText(runner.runnerId, placed.count, set),
            'runner が名乗った（繋がった・繋ぎ直した）ので、委譲先の許可規則を降ろした（#4952。前方一致は載せていない）',
          );
        }
        return placed;
      }),

    pushAll: (trigger) =>
      serial(async () => {
        if (runners === undefined) return [];
        let set: DelegatedPermissionRuleSet;
        try {
          set = await currentSet();
        } catch (error) {
          await journal(
            '委譲先の許可規則を配れなかった（許可の一覧を読めなかった）',
            `${trigger}。理由: ${reasonOf(error)}（#4952。各 runner には前の一覧が残っている）`,
          );
          return [];
        }
        const open = await runners.list().catch(() => []);
        const results = await Promise.all(
          open
            .filter((runner) => runner.setPermissionRules !== undefined)
            .map(async (runner): Promise<PermissionRulesRunnerResult> => {
              try {
                const placed = await runner.setPermissionRules?.(set.rules);
                if (placed === undefined) return { runnerId: runner.runnerId, ok: true };
                return {
                  runnerId: runner.runnerId,
                  ok: true,
                  count: placed.count,
                  changed: placed.changed,
                };
              } catch (error) {
                return {
                  runnerId: runner.runnerId,
                  ok: false,
                  ...(error instanceof RunnerPermissionRulesUnsupportedError
                    ? { unsupported: true as const }
                    : {}),
                  error: reasonOf(error),
                };
              }
            }),
        );
        for (const result of results) {
          if (result.ok) {
            await journal(
              placedText(result.runnerId, result.count, set),
              `${trigger}（#4952。前方一致は載せていない）`,
            );
          } else {
            await journal(
              `${result.runnerId} へ委譲先の許可規則を配れなかった（その runner のセッションには前の一覧が残っている）`,
              `${trigger}。理由: ${result.error ?? '理由不明'}（#4952）`,
            );
          }
        }
        for (const listener of pushListeners) {
          try {
            listener(results);
          } catch {
            // 帳面に積めなかっただけで、配布の結果そのものは返す。
          }
        }
        return results;
      }),

    onPushed: (listener) => {
      pushListeners.add(listener);
      return () => pushListeners.delete(listener);
    },
  };
}
