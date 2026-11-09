import type { AgentPreToolDecision, AgentPreToolRecord } from './agent-hooks.js';
import { resolveEffectiveBashShapeGuard, type BashGuardMode } from './bash-guard-mode.js';
import { inspectReleaseProdDispatch } from './bash-release-prod-guard.js';
import { inspectBashShape } from './bash-shape-guard.js';
import { inspectBashCommand } from './bash-wait-guard.js';
import { reasonOf } from './dropped-record.js';

/**
 * `RunnerSession` が口として渡すもの。6 本。
 * 値で渡すのは作った後に変わらない欄（`env`・`bashGuard`。`RunnerSession` では `readonly`）だけで、呼び出しのたびに読む `profileEnv` は関数のまま渡す。
 * 関数の口は async の皮で包まずに渡す（このブロックは同期で、`await` を足すと決定が返る周回と `note` が送られる周回が動くため）。
 */
interface RunnerBashGuardPorts {
  /** `RunnerSession#env`（形の歯の入り切りを読む。`ALTEROID_BASH_SHAPE_GUARD`）。 */
  env: NodeJS.ProcessEnv;
  /** `RunnerSession#profileEnv`（呼び出しのたびに読む。プロファイルに置いた値を次の呼び出しから効かせるため）。同期。 */
  profileEnv: () => Record<string, string>;
  /** `RunnerSession#bashGuard`（`ALTEROID_BASH_GUARD`。`off` / `ask` / `deny`）。 */
  bashGuard: BashGuardMode;
  /** `actorOf(RunnerSession#id, record)`（note の呼び手の名札）。同期。 */
  actorOf: (record: AgentPreToolRecord) => string;
  /** `RunnerSession#note`（担当の note を出す）。同期。 */
  note: (text: string) => void;
  /** `RunnerSession#tryObservation`（観測の副作用が投げても判定を止めない。握った失敗は標準エラーへ 1 行残す）。同期。 */
  tryObservation: (label: string, fn: () => void) => void;
}

/**
 * `decide` の結果。
 * - `none` — 何も起きない（`Bash` 以外・`command` が文字列でない・弾かない形）。呼び元は続ける
 * - `decided` — ここで返す決定（`deny`、または判定が例外のときの `ask`）。呼び元はそのまま返す（1回だけの許可を見ない）
 * - `guardAsk` — 確認に上げる理由。呼び元は1回だけの許可が `continue` のときだけ `ask` にする
 */
export type RunnerBashGuardOutcome =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'decided';
      readonly decision: Extract<AgentPreToolDecision, { kind: 'deny' | 'ask' }>;
    }
  | { readonly kind: 'guardAsk'; readonly guardAsk: { reason: string } };

/**
 * `RunnerSession#onPreToolUse` の `Bash` ブロック（release-prod → 形の歯 → `off` 判定 → `inspectBashCommand` → 判定の例外は確認へ倒す →
 * blocked なら note → deny を返すか確認に上げる理由を立てる）を受け持つ側。切り出し前の `onPreToolUse` から切り出した。振る舞いは変えていない。
 * 自前の欄は無い。`decide` は同期のまま保つ（`await` を足すと、呼び元の決定が返る周回と `note` が送られる周回が動く）。
 * 呼び元（`onPreToolUse`）は、`decided` をその位置で返し、`guardAsk` を1回だけの許可の消費の後で `ask` にするかを決める。
 */
export class RunnerBashGuard {
  readonly #env: RunnerBashGuardPorts['env'];
  readonly #profileEnv: RunnerBashGuardPorts['profileEnv'];
  readonly #bashGuard: RunnerBashGuardPorts['bashGuard'];
  readonly #actorOf: RunnerBashGuardPorts['actorOf'];
  readonly #note: RunnerBashGuardPorts['note'];
  readonly #tryObservation: RunnerBashGuardPorts['tryObservation'];

  constructor(ports: RunnerBashGuardPorts) {
    this.#env = ports.env;
    this.#profileEnv = ports.profileEnv;
    this.#bashGuard = ports.bashGuard;
    this.#actorOf = ports.actorOf;
    this.#note = ports.note;
    this.#tryObservation = ports.tryObservation;
  }

  // `Bash` 以外を弾かない: 他のツールまで巻き込むと「何でも弾きうる門」になり、確認が要る行為の一覧を作ることに近づくため
  // `decision: 'block'`（セッション全体を止める口）を使わない: この呼び出し1件だけを拒否する
  // `escalate` を立てない: 作業者が動けなくなったような危険の通知ではなく、ツール呼び出し1件が拒否に置き換わっただけの経過のため
  // 判定の周りの例外で deny を消さない: フックが例外で終わると CLI は「ブロックしない」として通常の許可の流れへ戻し、ガードが素通りになるため（観測の副作用は失敗しても判定を止めず、判定そのものが投げたら確認へ倒す）
  decide(record: AgentPreToolRecord): RunnerBashGuardOutcome {
    if (record.toolName === 'Bash') {
      const toolInput = record.toolInput as
        { command?: unknown; run_in_background?: unknown } | null | undefined;
      const command = toolInput?.command;
      if (typeof command === 'string') {
        // `run_in_background` を `=== true` で受ける: 欠けていても形が崩れていても前景になり、通す側へ倒れるため
        let verdict:
          ReturnType<typeof inspectBashCommand> | { blocked: true; form: string; reason: string };
        let shapeDeny: boolean;
        try {
          // 本番デプロイの起動（release-prod）は `off` でも確認に残す
          const releaseProd = inspectReleaseProdDispatch(command);
          // 形の歯は release-prod の後・wait-guard の前に置く: release-prod は `off` でも残す門で、形の歯は断る理由が単純（打ち直せば抜けられる）なため先に返す
          // マネージャーにも掛ける（#4949）: heosterra のマネージャーも同じ形を打っていて、オーナーの決まりはマネージャーにも同じ形を禁じているため
          // `ALTEROID_BASH_GUARD` から切り離す（#4949）: 形の歯は `ALTEROID_BASH_SHAPE_GUARD`（既定 off）だけで決まる。呼び出しのたびに読み、プロファイルの値を優先する（プロファイルに置けば次の呼び出しから効く）。不正な値はここで投げ、下の catch が確認（`deny` 設定なら deny）に倒す
          const shape =
            !releaseProd.matched &&
            resolveEffectiveBashShapeGuard(this.#env, this.#profileEnv()) === 'on'
              ? inspectBashShape(command)
              : { blocked: false as const };
          shapeDeny = shape.blocked;
          verdict = releaseProd.matched
            ? { blocked: true, form: releaseProd.form, reason: releaseProd.reason }
            : shape.blocked
              ? shape
              : this.#bashGuard === 'off'
                ? { blocked: false }
                : inspectBashCommand(command, {
                    backgrounded: toolInput?.run_in_background === true,
                  });
        } catch (error) {
          // 判定できなかった呼び出しを素通しにしない: 倒れる先は確認で、上がらずに止めて誰も開けられない形にしない（`deny` を選んだ人にだけ止める）
          const message = reasonOf(error);
          const reason = `Bash のガードの判定が例外で終わったので、安全側で確認に上げた（${message}）。形を変えずに打ち直さず、依頼者へ報告すること。`;
          if (this.#bashGuard === 'deny') {
            return {
              kind: 'decided',
              decision: {
                kind: 'deny',
                reason: `Bash のガードの判定が例外で終わったので、安全側で拒否した（${message}）。形を変えずに打ち直さず、依頼者へ報告すること。`,
              },
            };
          }
          return { kind: 'decided', decision: { kind: 'ask', reason } };
        }
        if (verdict.blocked) {
          const actor = this.#actorOf(record);
          // 形の歯は `ask` でも deny: 確認に上げると、打つたびにクローンへ確認が積み上がるため（#4947）
          const asked = this.#bashGuard !== 'deny' && !shapeDeny;

          this.#tryObservation('ガードの note の送り出し', () => {
            this.#note(
              asked
                ? `Bash の呼び出しを確認に上げた（${actor}・形=${verdict.form}）。${verdict.reason}`
                : `Bash の呼び出しを弾いた（${actor}・形=${verdict.form}）。${verdict.reason}`,
            );
          });

          if (!asked)
            return { kind: 'decided', decision: { kind: 'deny', reason: verdict.reason } };
          return { kind: 'guardAsk', guardAsk: { reason: verdict.reason } };
        }
      }
    }
    return { kind: 'none' };
  }
}
