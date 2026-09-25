/**
 * 承認の答えの後にクローンが取った行動（`ApprovalTrace.actions`）1件を
 * 「何をしたか」の1文にする、**ブラウザが読める軽い口**（issue #1528）。
 *
 * 正本の実装はここに在り、`approval-trace.ts` の `describeTraceAction` は
 * ここから再輸出するだけである（`schema.ts` が `describeAnsweredVia` を
 * `answered-via.ts` から再輸出するのと同じ形。そちらの doc を見よ）。
 *
 * **実行時の依存を1つも持たない。** これは意図的な分離である —
 * `@alteroid/core/trace-action-format` として subpath で出しており、
 * `usage-format.ts` / `revision-format.ts` / `permission-rule.ts` /
 * `answered-via.ts` と同じ理由（`packages/core/tsup.config.ts` の doc）。
 *
 * 正本の元の実装は `JournalEntry`（`schema.ts` の判別可能ユニオン。zod を
 * import する）を直接受けていたので、`apps/web/app/routes/approvals.tsx` は
 * 長らくこの関数を画面側に複製して持っていた（`describeAction`。#1514 の
 * 前後）。見送っていた理由は3つあり、うち2つ（引数の型が重い・
 * `apps/web` が持つ `JournalEntry` は `@alteroid/core/api-client`（OpenAPI
 * 生成）の別の型）はこのファイルで解消した——`answered-via.ts` と同じ手法
 * （構造的に一致する最小の型をここへ手で書く）を、`journal-search.ts` の
 * doc が指摘する「12種を丸ごと複製すると『複製をやめる』という目的に
 * 反する」という懸念に当たらない形で採る: **実際に文字へ変換する4種類
 * （`decision` / `memory_update` / `tool_use` / `exchange`）の欄だけを
 * 型で言い、残りは「`entry.type` をそのまま返す」という関数の実際の
 * 振る舞いに合わせて、型の欄を持たない判別子の列挙で受ける。**
 *
 * 3つ目の理由（複製した2つの実装が既に文言違いを持っていた——`tool_use` の
 * `outcome` と `exchange` の接頭辞）は Issue #1528 の依頼者の判断で解消した:
 * **Web の表示を core の正本に揃える。表示が変わってよい。**
 */

/**
 * {@link describeTraceAction} が受ける最小の構造型。
 *
 * **`decision` / `memory_update` / `tool_use` / `exchange` の4種類は、実際に
 * 読む欄だけを型で言う。** 残りの判別子はこの関数の中で分岐せず
 * `entry.type` をそのまま返す（`journalEntrySchema` の判別可能ユニオンが
 * 種類を増やしても、この関数の default 分岐はそのまま正しく動く）ので、
 * 欄を持たない判別子の列挙として受ける。
 *
 * **`schema.ts` の `_AssertJournalEntryMatchesTraceActionLike` が、この型が
 * 本物の `JournalEntry`（zod スキーマから推論した型）と食い違っていないか
 * を強制する。** ここは zod を import できないので、ここでは検査できない
 * （`answered-via.ts` の `AnsweredViaLike` と同じ理由・同じ形）。
 *
 * **列挙した9つの判別子（4種類の外）に新しい種類が足りない・多い場合、
 * `_AssertJournalEntryMatchesTraceActionLike` が typecheck を落とす。** その
 * ときにこの一覧を直す——数え上げの持ち主はあくまで `journalEntrySchema`
 * （`schema.ts`）であり、ここは追随するだけである。
 */
export type TraceActionLike =
  | { type: 'decision'; decision: string; grounds: string }
  | {
      type: 'memory_update';
      action?: 'write' | 'append' | 'remove' | 'describe' | 'move_in' | 'move_out';
      slug: string;
      summary: string;
    }
  | { type: 'tool_use'; tool: string; outcome?: 'failed' | 'interrupted'; input?: unknown }
  | { type: 'exchange'; with: 'human' | 'manager' | 'self'; text: string }
  | {
      type:
        | 'token_rotation'
        | 'subagent_stall'
        | 'escalation'
        | 'daily_report'
        | 'external_event'
        | 'worker_wait'
        | 'turn_usage'
        | 'context_usage'
        | 'inbox_flow';
    };

/**
 * 行動1件を「何をしたか」の1文にする（抜粋はしない。切るかどうかは呼び手が決める）。
 *
 * **型ごとの主たる本文をそのまま出すだけで、解釈を足さない**
 * （`approval-trace.ts` の冒頭の doc「一般化した基準をここで作らない」）。
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
