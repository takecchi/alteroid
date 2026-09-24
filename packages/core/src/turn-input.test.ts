import { describe, expect, it } from 'vitest';

import { fingerprintOf } from './credentials.js';
import { turnInputEntry, type TurnInput } from './turn-input.js';

/**
 * `describeTurnInput`（`turn-input.ts`）の名簿——`dropped-record.ts` の
 * `INBOX_SHAPE_PLAN` / `JOURNAL_SHAPE_PLAN` / `APPROVAL_SHAPE_PLAN` と同じ
 * 作り・同じ理由で、`TurnInput` に型や欄を足したときの書き忘れを赤くする
 * （Issue #1397 の c16-2 の残り2か所のうち1つ）。
 *
 * **`describeTurnInput` 自身は export されていない。** `dropped-record.ts` の
 * 3関数と違い直接は呼べないので、export されている `turnInputEntry(input)` の
 * 戻り値（`JournalEntryInput` の `exchange` ケース）の `text` を通して確かめる
 * ——`turnInputEntry` は `describeTurnInput(input)` を `text` へそのまま渡すだけ
 * （`with: 'self'`, `role: 'inbound'` は固定値）なので、`text` を見れば
 * `describeTurnInput` の出力そのものが見える。
 *
 * **`TurnInput` は zod ではなく TypeScript の union（判別共用体）。** だから
 * `inboxEventSchema`/`journalEntrySchema`/`pendingApprovalSchema` のように
 * 「zod から実装側の欄を機械的に引いて名簿と両方向に突き合わせる」実行時の歯は
 * 書けない——引ける schema が無い。**代わりに型の側で縛る**——名簿を
 * `satisfies { [T in TurnInput['type']]: Record<ShapedFieldsOf<T>, FieldPlan> }`
 * の形にし、`TurnInput` のどれかの型に欄が増えると `pnpm typecheck` が落ちる。
 * `FULL_FIXTURES` も型ごとに `Required<Extract<TurnInput, { type: T }>>` で
 * 全欄必須にしてあるので、同じく欄の増減で型が落ちる。
 *
 * **この歯が測るもの:**
 *
 * 1. 名簿（`TURN_INPUT_SHAPE_PLAN`）が `TurnInput` の全型・全欄を型レベルで
 *    覆っていること（上の `satisfies` と `Required<>`）。
 * 2. 名簿の各欄が言うとおりに `describeTurnInput` が振る舞うこと——`tag`/`raw`
 *    は目印が出る・`size` は長さだけ出る・`size-with-fingerprint` は長さと
 *    指紋だけが出て本文は出ない・`full` は全文がそのまま出る（`human_answer.text`
 *    だけが該当し、これは欠陥ではなく設計——`turn-input.ts` の doc が「全文を
 *    写す」と明記している）。全欄を埋めた `FULL_FIXTURES` に対して
 *    `turnInputEntry` を呼び、名簿どおりかを確かめる。
 * 3. `full` を持たない型では、`size`/`size-with-fingerprint` 欄に置いた自由文
 *    がどこにも現れないこと。
 *
 * **分類は `describeTurnInput`（`turn-input.ts`）の現在の実装から写した**
 * （挙動は変えていない）。⚠️ **`self_initiative.reason` は `tag`（`journalEntryShape`/
 * `inboxEventShape` の対応欄が `size-unnamed` なのとは違う）。** これは取り違え
 * ではなく実装の現状そのもの——`describeTurnInput` の `case 'self_initiative'` は
 * `reason=${tag(input.reason)}` と書いており、自由文としては扱っていない
 * （`digest.ts` が組み立てた短い定型文が渡る経路であり、`InboxEvent.self_initiative.reason`
 * のような外部由来の自由文とは別物）。この名簿は「本体が実際にどう振る舞うか」を
 * 写すものであって、他関数の分類と揃える場ではない。
 *
 * ⚠️ **この歯が守れないもの——`journalEntryShape`/`inboxEventShape` の名簿と同じ
 * 限界。** 欄が出ることまでしか見ない。`tag(input.kind)` を `tag(input.cause)` と
 * 取り違えて書いても、この歯は緑のままである（値の取り違えは見ない）。
 *
 * ⛔ **#981 の選択肢(B)（入れ子を再帰的に自動で辿る門）の形にはしない。**
 * `TurnInput` の各欄はここでは第1階層のみで（入れ子オブジェクトを持つ欄が無い）
 * ので該当しないが、念のため明記する——名簿は明示的に置くもので、新しい型・欄が
 * 「黙って通る」側へ倒れる自動網羅の仕組みは採らない。
 */
describe('describeTurnInput の名簿（turnInputEntry 経由。schema に足した型・欄の足し忘れを赤くする。Issue #1397 c16-2）', () => {
  /** 跡へ欄をどう出すか。**理由なしの `full`/`raw` は無い前提**（本体の出し方を写すだけ）。 */
  type FieldPlan =
    | { readonly emit: 'tag'; readonly token: string }
    /**
     * `raw` は「値を決めるのが呼び出し元（システム）で、自由文ではない」欄。
     * `literal` に**変換後**の期待値を書く——`request`（`boolean`）は
     * `tag()` を通さず `input.request ? 'yes' : 'no'` へ直接変換されるので、
     * fixture の生値（`true`）をそのまま比較には使えない。
     */
    | { readonly emit: 'raw'; readonly token: string; readonly literal: string }
    | { readonly emit: 'size'; readonly token: string }
    | {
        readonly emit: 'size-with-fingerprint';
        readonly sizeToken: string;
        readonly fingerprintToken: string;
      }
    /** 本文がそのまま出る欄。`human_answer.text` だけが該当（設計。doc 参照）。 */
    | { readonly emit: 'full' };

  /** その型が持つ欄（`type` は判別子なので除く）。 */
  type ShapedFieldsOf<T extends TurnInput['type']> = Exclude<
    keyof Extract<TurnInput, { type: T }>,
    'type'
  >;

  const TURN_INPUT_SHAPE_PLAN = {
    distill: {
      reason: { emit: 'tag', token: 'reason' },
      prompt: { emit: 'size', token: 'prompt' },
    },
    pre_compact_distill: {
      transcriptTail: {
        emit: 'size-with-fingerprint',
        sizeToken: 'tail',
        fingerprintToken: 'tail.fp',
      },
    },
    human_answer: {
      approvalId: { emit: 'tag', token: 'approvalId' },
      text: { emit: 'full' },
    },
    timer: {
      kind: { emit: 'tag', token: 'kind' },
      cause: { emit: 'tag', token: 'cause' },
      target: { emit: 'tag', token: 'target' },
      // 値を決めるのはこの合図を起こした側（システム）で、自由文ではない
      // （`worker_wait`/`turn_usage` の数値欄と同じ判断基準——
      // `journalEntryShape` の `FieldPlan` の `raw` に対応）。
      // fixture では request: true を使うので、期待される変換後の値は 'yes'。
      request: { emit: 'raw', token: 'request', literal: 'yes' },
      digest: { emit: 'size', token: 'digest' },
    },
    self_initiative: {
      reason: { emit: 'tag', token: 'reason' },
      cause: { emit: 'tag', token: 'cause' },
      digest: { emit: 'size', token: 'digest' },
    },
    daily_report: {
      date: { emit: 'tag', token: 'date' },
      cause: { emit: 'tag', token: 'cause' },
      digest: { emit: 'size', token: 'digest' },
    },
  } satisfies { [T in TurnInput['type']]: Record<ShapedFieldsOf<T>, FieldPlan> };

  const SECRET = 'ghp_666666666666666666666666666666666666';

  /** `TURN_INPUT_SHAPE_PLAN` と同じキー集合を、`satisfies` が守る順序付き一覧として持つ。 */
  const TURN_INPUT_TYPES = Object.keys(TURN_INPUT_SHAPE_PLAN) as TurnInput['type'][];

  /**
   * 全欄を埋めた見本。**`Required<>` で optional（`timer.target`）も必須になる**
   * ので、`TurnInput` に欄が増えると `pnpm typecheck` が落ちる。値が跡に出ない欄
   * （`size`/`size-with-fingerprint`）と全文が出る欄（`full`）には `SECRET` を
   * 入れ、下の振る舞いテストで漏れ方・出方の両方を確かめる。
   */
  const FULL_FIXTURES: { [T in TurnInput['type']]: Required<Extract<TurnInput, { type: T }>> } = {
    distill: { type: 'distill', reason: 'scheduled', prompt: SECRET },
    pre_compact_distill: { type: 'pre_compact_distill', transcriptTail: SECRET },
    human_answer: { type: 'human_answer', approvalId: 'ap-1', text: SECRET },
    timer: {
      type: 'timer',
      kind: 'daily_report',
      cause: 'manual',
      target: 'target-1',
      request: true,
      digest: SECRET,
    },
    self_initiative: {
      type: 'self_initiative',
      reason: 'manual-check',
      cause: 'manual',
      digest: SECRET,
    },
    daily_report: { type: 'daily_report', date: '2026-08-20', cause: 'manual', digest: SECRET },
  };

  /**
   * `describeTurnInput` は export されていない。`turnInputEntry` は常に
   * `type: 'exchange'` の行を返すので、そこから `text`（＝`describeTurnInput`
   * の戻り値そのもの）を取り出す。
   */
  function shapeOf(input: TurnInput): string {
    const entry = turnInputEntry(input);
    if (entry.type !== 'exchange') {
      throw new Error(`unreachable: turnInputEntry は常に exchange を返す（実際は ${entry.type}）`);
    }
    return entry.text;
  }

  it('名簿のキー集合は空でない（走査が空振りして0件のまま緑になる形を作らない）', () => {
    expect(TURN_INPUT_TYPES.length).toBeGreaterThan(0);
    expect(new Set(TURN_INPUT_TYPES).size).toBe(TURN_INPUT_TYPES.length);
  });

  it('名簿の各欄について describeTurnInput が plan どおりに振る舞う（tag/raw は目印・size は長さだけ・size-with-fingerprint は長さ+指紋のみ・full は全文）', () => {
    for (const type of TURN_INPUT_TYPES) {
      const shape = shapeOf(FULL_FIXTURES[type]);
      const plan: Record<string, FieldPlan> = TURN_INPUT_SHAPE_PLAN[type];

      for (const [field, fieldPlan] of Object.entries(plan)) {
        switch (fieldPlan.emit) {
          case 'tag': {
            // **`token=` だけでなく値そのものまで固定する**（Issue #1397
            // c16-2）。`tag()` の代わりに `size()` を通す変異（同じ
            // `${token}=` という周囲の定型文はそのまま残る）は、`token=`
            // だけを見る判定では拾えない——`size()` は名前を埋め込まないので
            // `kind=kind.chars=12` のような形になり、`token=` という
            // 前置き自体は消えないため。値まで見れば「値でなく chars=… が
            // 出ている」ことを直接検出できる。
            const rawValue = String((FULL_FIXTURES[type] as Record<string, unknown>)[field]);
            expect(shape, `${type}.${field}`).toContain(`${fieldPlan.token}=${rawValue}`);
            break;
          }
          case 'raw':
            expect(shape, `${type}.${field}`).toContain(`${fieldPlan.token}=${fieldPlan.literal}`);
            break;
          case 'size':
            expect(shape, `${type}.${field}`).toContain(
              `${fieldPlan.token}.chars=${SECRET.length}`,
            );
            break;
          case 'size-with-fingerprint':
            expect(shape, `${type}.${field}`).toContain(
              `${fieldPlan.sizeToken}.chars=${SECRET.length}`,
            );
            expect(shape, `${type}.${field}`).toContain(
              `${fieldPlan.fingerprintToken}=${fingerprintOf(SECRET)}`,
            );
            break;
          case 'full':
            expect(shape, `${type}.${field}`).toContain(SECRET);
            break;
        }
      }
    }
  });

  it('size/size-with-fingerprint の欄に置いた自由文は、full 欄を持たない型の跡には一切現れない', () => {
    for (const type of TURN_INPUT_TYPES) {
      const plan: Record<string, FieldPlan> = TURN_INPUT_SHAPE_PLAN[type];
      const hasFullField = Object.values(plan).some((fieldPlan) => fieldPlan.emit === 'full');
      if (hasFullField) continue; // human_answer は全文が出る設計なので対象外（上のテストで別途確認済み）

      const shape = shapeOf(FULL_FIXTURES[type]);
      expect(shape, type).not.toContain(SECRET);
    }
  });
});
