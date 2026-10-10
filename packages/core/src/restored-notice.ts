import type { JobStatus } from './schema.js';
import { statusPhrase } from './quota-stop-notice.js';

/**
 * 器の作り直し・別の器での開き直し・デーモンの再起動の後に、委譲ごとに届いていた「取り戻した」知らせの、
 * 同じ出来事の2本目以降を1通にまとめる窓の1行ぶん。**積む時点の値を持つ**（文面を作る側は台帳を読み直さない。
 * 状態だけは配る時点の台帳から読むので、ここには持たない）。
 */
export interface RestoredEntry {
  managerId: string;
  /** `job.runnerId`。無ければ `undefined`。 */
  runnerId: string | undefined;
  how: 'attached' | 'resumed';
  cwd: string | undefined;
  /** 直近の報告の抜粋（1行）。無ければ `undefined`。 */
  excerpt: string | undefined;
  /** 作業場の行（`cloneWorkspaceAfterSwapLine` が出すもの）。cause がデーモンのときは空。 */
  workspaceLine: string;
}

export interface RestoredListItem extends RestoredEntry {
  /** 窓を開けた担当。この担当の知らせは、担当への報告として先に届けてある。 */
  first: boolean;
  /** 配る時点の台帳の `job.status`。読めなければ `undefined`（既定値は作らない）。 */
  status: JobStatus | undefined;
}

const ATTACHED_GUIDANCE =
  '走り続けている委譲: 返事待ちがあれば改めて届く。`manager_send` で追加の指示も送れる。';
const RESUMED_GUIDANCE =
  '再開させた委譲: 再開の指示は送信済み。返事待ちだった確認は器と一緒に失われているので、必要ならマネージャーが聞き直してくる。';

function howPhrase(how: RestoredEntry['how']): string {
  return how === 'attached'
    ? '走り続けている（attached）'
    : '前のセッションから再開させた（resumed）';
}

/** 同じ出来事（同じ cause）で取り戻した委譲の一覧。全文は載せない（担当ごとの詳細は `manager_report` で読める）。 */
export function renderRestoredNotice(head: string, items: readonly RestoredListItem[]): string {
  const lines = [`${head}: ${String(items.length)} 本の委譲に当たった`, ''];
  for (const item of items) {
    const firstNote = item.first ? '（最初の1本。担当への報告としては先に届けてある）' : '';
    lines.push(
      `- ${item.managerId}: 器 ${item.runnerId ?? '(不明)'} / ${howPhrase(item.how)} / 状態 ${statusPhrase(item.status)}${firstNote}`,
      `  作業ディレクトリ: ${item.cwd ?? '(不明)'}`,
    );
    if (item.workspaceLine !== '') {
      lines.push(...item.workspaceLine.split('\n').map((line) => `  ${line}`));
    }
    if (item.excerpt !== undefined) lines.push(`  直近の報告（抜粋）: ${item.excerpt}`);
  }
  lines.push('');
  if (items.some((item) => item.how === 'attached')) lines.push(ATTACHED_GUIDANCE);
  if (items.some((item) => item.how === 'resumed')) lines.push(RESUMED_GUIDANCE);
  lines.push('担当ごとの詳細は manager_report で読める。');
  return lines.join('\n');
}
