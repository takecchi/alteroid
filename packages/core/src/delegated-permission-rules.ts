import {
  AUTO_MODE_STRIP_PREDICTION_SDK_VERSION,
  autoModeStripsDelegatedRule,
} from './auto-mode-strip-prediction.js';
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
 * 載せるのは、取り消されていない許可のうち完全一致（`Bash(<command>)`）と前方一致（`Bash(<prefix>:*)`）の規則である。
 * 前方一致も載せるのはオーナーの決定（#5435・承認 589d747b。人間が承認した許可は全部効かせる）。
 * 前方一致の prefix に `*`・改行を含むもの、空の prefix（`Bash(:*)`・`Bash(*)`）は載せない: 規則の文法の上で意図より広くなるため。
 * 完全一致は #4905 の一時規則と同じ判定（`sessionAllowRuleShapeOf`）を通す。その判定は緩めない（一時規則は完全一致のまま）。
 *
 * auto mode は危険な規則（解釈器・シェルの前方一致など）を捨てる（SDK の `stripDangerousPermissionsForAutoMode`）。
 * 捨てられるのを回り道で防がない（配る一覧から外さない・書き換えない）。代わりに、捨てられる見込みの規則を
 * 許可 id と規則の名前で日誌に残し、クローンが追えるようにする（`autoModeStripsDelegatedRule`。判定は SDK 0.3.312 の写し）。
 */

export interface DelegatedPermissionRuleSet {
  /** 重複は1つにした規則の一覧。 */
  readonly rules: string[];
  /** 載せた許可の id（日誌に載せるのは規則の本文ではなくこちら。例外は `autoModeStripped`）。 */
  readonly grantIds: string[];
  /** 載せた許可のうち、auto mode で SDK に捨てられる見込みのもの（許可 id と規則）。配る一覧からは外していない。 */
  readonly autoModeStripped: { readonly grantId: string; readonly rule: string }[];
}

/**
 * 許可の規則（`PermissionGrant.rule`）から、委譲先へ載せる規則を作る。載せない形なら `undefined`。取り消しは見ない（`delegatedPermissionRulesOf` が見る）。
 * 前方一致は委譲側だけの形の判定をここで持つ（`sessionAllowRuleShapeOf` は完全一致専用のまま）。
 */
export function delegatedPermissionRuleOf(grantRule: string): string | undefined {
  const parsed = parsePermissionRule(grantRule);
  if (!parsed.ok) return undefined;
  if (parsed.kind === 'exact') {
    const shape = sessionAllowRuleShapeOf('Bash', { command: parsed.command });
    return shape.kind === 'rule' ? shape.rule : undefined;
  }
  if (parsed.command.trim() === '' || parsed.command.includes('*')) return undefined;
  if (/[\r\n]/.test(parsed.command)) return undefined;
  return `Bash(${parsed.command}:*)`;
}

export function delegatedPermissionRulesOf(
  grants: readonly PermissionGrant[],
): DelegatedPermissionRuleSet {
  const rules = new Set<string>();
  const grantIds: string[] = [];
  const autoModeStripped: { grantId: string; rule: string }[] = [];
  for (const grant of grants) {
    if (grant.revokedAt !== undefined) continue;
    const rule = delegatedPermissionRuleOf(grant.rule);
    if (rule === undefined) continue;
    rules.add(rule);
    grantIds.push(grant.id);
    if (autoModeStripsDelegatedRule(rule)) autoModeStripped.push({ grantId: grant.id, rule });
  }
  return { rules: [...rules], grantIds, autoModeStripped };
}

/**
 * 捨てられる見込みの規則の日誌の文言。ここだけ規則の名前（command）を載せる: 「規則の本文を日誌に載せない」方針の例外で、
 * 人間が承認した規則そのものであり、捨てられた事実をクローンが名前で追えるようにするため（オーナーの決定、#5435）。
 * 載せるのは述語に当たった規則だけ。完全一致の本文はこれまでどおり載せない（当たるのは `python` などの全消しだけ）。
 */
function autoModeStrippedText(set: DelegatedPermissionRuleSet): string | undefined {
  if (set.autoModeStripped.length === 0) return undefined;
  const names = set.autoModeStripped.map((s) => `${s.grantId} \`${s.rule}\``).join(', ');
  return (
    `auto mode のセッションでは SDK（${AUTO_MODE_STRIP_PREDICTION_SDK_VERSION} の判定）に捨てられる見込みの規則が在る: ${names}` +
    '（配る一覧からは外していない。runner の mode はデーモンから見えないので「見込み」）'
  );
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
        `許可規則の一覧の ${index} 番目が、載せてよい形（Bash(<command>) の完全一致か Bash(<prefix>:*) の前方一致・\`*\`（前方一致の末尾の :* を除く）と改行を含まず、中身が空でない）でない（置いていない）`,
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

  // 捨てられる見込みの規則を日誌に1本残す（無ければ何もしない）。呼ぶのは一覧が変わったときだけ
  async function journalAutoModeStripped(
    set: DelegatedPermissionRuleSet,
    runnerId: string,
    trigger: string,
  ): Promise<void> {
    const text = autoModeStrippedText(set);
    if (text === undefined) return;
    await journal(`${runnerId} へ配った許可規則に、${text}`, `${trigger}（#5435）`);
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
            'runner が名乗った（繋がった・繋ぎ直した）ので、委譲先の許可規則を降ろした（#4952。前方一致も載せる: #5435）',
          );
          await journalAutoModeStripped(
            set,
            runner.runnerId,
            'runner が名乗った（繋がった・繋ぎ直した）ので、委譲先の許可規則を降ろした',
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
              `${trigger}（#4952。前方一致も載せる: #5435）`,
            );
            // 一覧が変わった runner にだけ残す（`syncRunner` と同じ。同じ一覧を何度配っても積まない）
            if (result.changed !== false) {
              await journalAutoModeStripped(set, result.runnerId, trigger);
            }
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
