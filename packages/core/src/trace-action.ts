/**
 * 承認の行動一覧の1件を「何をしたか」の1文にする、**実行時の import を1つも
 * 持たない**ブラウザが読める軽い口（issue #1528。`@alteroid/core/trace-action`）。
 *
 * 正本は `approval-trace.ts` の `describeTraceAction`——中身をここへ移し、
 * `approval-trace.ts` はここから再輸出するだけにした（`answered-via.ts` /
 * `schema.ts` の `describeAnsweredVia` と同じ形。PR #1526 の続き）。
 *
 * ## なぜ移すのか
 *
 * `apps/web/app/routes/approvals.tsx` は元々 `describeAction` という名前の
 * 複製を画面側に持っていた（`journal-search.ts` の doc が指す「同じ壁」——
 * `apps/web` が持つ `JournalEntry` は `@alteroid/core` の（zod 由来・12種の
 * 判別可能ユニオンの）`JournalEntry` ではなく、`@alteroid/api-client`
 * （OpenAPI 生成）の別の型なので、正本をそのまま渡すには画面側でキャストが
 * 要る）。複製は2箇所が別々に腐りうる形で、実際に腐っていた——正本は
 * `tool_use` に `outcome` を括弧で足し、`exchange` の前に
 * 「人間への返答/発言: 」を付けるが、複製にはどちらも無かった（issue
 * #1528 の実測）。
 *
 * ## `TraceActionLike` は12種を丸ごと複製しない
 *
 * `describeTraceAction` が実際に読むのは `decision` / `memory_update` /
 * `tool_use` / `exchange` の4種の特定の欄だけで、残り8種は `type` の値を
 * そのまま返すだけである（`default: return entry.type`）。**⟹ 4種だけを
 * 手で書き写し、残りは「この4種以外の型名」という1行で受ける。**
 *
 * かつて `apps/web/app/routes/approvals.tsx` がこの移設を見送った理由の
 * 1つが「`AnsweredViaLike` と同じ手法（構造的に一致する型を手で書き写す）を
 * 採ると、12種を丸ごと複製することになり『複製をやめる』という目的そのものに
 * 反する」だった。**この形はその12種を複製していない**——4種の実際に使う
 * 欄だけを書き、残りは型の名前（文字列）だけで受ける。
 *
 * **⚠️ 素朴に `{ type: string }` を足すだけでは足りない。** それだと
 * `switch (entry.type) { case 'decision': ... }` の分岐で `entry.decision`
 * のようなその型固有の欄へ触れなくなる——TypeScript は「`type` が
 * `'decision'` という値だけを持つ、`decision` / `grounds` を持たない
 * オブジェクト」を排除できないため（`{ type: string }` は decision 型の
 * 欄を1つも約束しない）。だから最後の枝は `JournalEntryType`（`schema.ts`
 * の型エイリアス。**値ではなく型だけ**——`import type` は build で消えるので
 * バンドルサイズに影響しない）から4種を除いた**残りの型名の合併**にする。
 * これなら判別可能ユニオンとして正しく閉じ、分岐の中で他の3種のように
 * 欄へ触れる必要が無い（`entry.type` を返すだけ）ことと矛盾しない。
 *
 * ## 構造的な一致の検査
 *
 * `schema.ts` の `_AssertTraceActionMatchesLikeType`（ここは zod を知らない
 * ので、ここでは検査できない——`answered-via.ts` と同じ理由）が、実際の
 * `JournalEntry`（12種）がこの `TraceActionLike` へ構造的に渡せることを
 * `typecheck` で強制する。**`AnsweredViaLike` の検査と違い、双方向の
 * 完全一致ではなく片方向**（`JournalEntry extends TraceActionLike`）——
 * `TraceActionLike` は意図して「必要な欄だけの最小の型」であって
 * `JournalEntry` の完全な写しではないので、双方向にすると `TraceActionLike`
 * が持たない欄（`id` / `at` / `actor` など）のぶんで必ず落ちる。
 */
import type { JournalEntryType } from './schema.js';

/**
 * `describeTraceAction` が受け付ける最小の構造型。
 *
 * `decision` / `memory_update` / `tool_use` / `exchange` の4種は
 * `JournalEntry`（`schema.ts`）の同名の型から実際に読む欄だけを書き写した
 * もの——欄の意味はそちらの doc を見よ（ここでは繰り返さない）。それ以外の
 * 8種（`daily_report` / `escalation` / `token_rotation` / `subagent_stall` /
 * `external_event` / `worker_wait` / `turn_usage` / `context_usage`。
 * `journal-search.ts` の `SEARCHABLE_FIELDS_BY_TYPE` が同じ8種を列挙して
 * いる）は `type` の値だけで受ける——`Exclude` なので `journalEntrySchema`
 * に種別が増減しても手で追随する必要は無い（`JournalEntryType` から自動で
 * 増減する）。
 */
export type TraceActionLike =
  | { type: 'decision'; decision: string; grounds: string }
  | { type: 'memory_update'; action?: string; slug: string; summary: string }
  | { type: 'tool_use'; tool: string; outcome?: 'failed' | 'interrupted'; input?: unknown }
  | { type: 'exchange'; with: 'human' | 'manager' | 'self'; text: string }
  | { type: Exclude<JournalEntryType, 'decision' | 'memory_update' | 'tool_use' | 'exchange'> };

/**
 * 行動1件を「何をしたか」の1文にする（抜粋はしない。切るかどうかは呼び手が
 * 決める）。
 *
 * **型ごとの主たる本文をそのまま出すだけで、解釈を足さない**
 * （`approval-trace.ts` 冒頭の doc「一般化した基準をここで作らない」）。
 *
 * CLI・クローンの道具（`approval-trace.ts` 経由）と Web UI
 * （`apps/web/app/routes/approvals.tsx`）が同じこの関数を通る（PRD
 * 「インターフェース」——片方でしかできないことを作らない）。**この関数は
 * 移設だけで、出す文言は1文字も変えていない**（`approval-trace.ts` の
 * 呼び手が確認する CLI の出力は変わらない）。**Web の表示は変わる**——
 * `describeAction`（複製。廃止）にはこの2つが無かった。
 */
export function describeTraceAction(entry: TraceActionLike): string {
  switch (entry.type) {
    case 'decision':
      return `判断: ${entry.decision}（根拠: ${entry.grounds}）`;
    case 'memory_update':
      return `記憶の更新 ${entry.action ?? 'write'} ${entry.slug}: ${entry.summary}`;
    case 'tool_use':
      return (
        `道具 ${entry.tool}` +
        (entry.outcome === undefined ? '' : `（${entry.outcome}）`) +
        (entry.input === undefined ? '' : `: ${JSON.stringify(entry.input)}`)
      );
    case 'exchange':
      return `${entry.with === 'human' ? '人間への返答' : '発言'}: ${entry.text}`;
    default:
      return entry.type;
  }
}
