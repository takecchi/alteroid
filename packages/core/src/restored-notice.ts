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
  /**
   * 器の作り直し・移送の後の resume を、預かった生ログ無しで出した（#4501）。新しい器の CLI に会話が無いので、戻れない見込みが高い。
   * 立っていないときは `undefined` でも `false` でもよい。
   */
  withoutLog?: boolean;
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
/**
 * 生ログ無しで resume を出した委譲に添える1文（#4501）。担当への知らせ・まとめの1通・日誌で同じ文を使う。
 * 「戻せなかった」の語を使わない: 失敗の知らせを見分ける語なので、受理の知らせに混ぜると読み手と試験の両方が取り違える。
 */
export const RESUMED_WITHOUT_LOG_CLAUSE =
  '前の会話の生ログを預かっていない（器の中の会話も入れ替えで消えている）ので、戻れない見込みが高い。' +
  '戻れなければ lost になる。起こし直す前に、成果がもう外へ出ていないか（PR・ブランチなど）を確かめること。';
// 「再開させた」と言い切らない: 受理は「戻れた」ではなく、前の会話が無ければ後から lost になる（#4501）。
const RESUMED_GUIDANCE =
  '再開を指示した委譲: runner が resume を受け付けただけで、前の会話が戻ったかはまだ確かめていない。' +
  '戻れなければ、この後に担当ごとの知らせが別に届き、状態は lost になる。' +
  '返事待ちだった確認は器と一緒に失われているので、必要ならマネージャーが聞き直してくる。';

function howPhrase(how: RestoredEntry['how']): string {
  return how === 'attached'
    ? '走り続けている（attached）'
    : '前のセッションからの再開を指示した（resume は受理された。会話が戻ったかは未確認）';
}

/** resume の受理の後の `running` は「生きている」と言わない: CLI が会話を見つけられずに終わるまで、台帳は `running` のままである（#4501）。 */
function itemStatusPhrase(item: RestoredListItem): string {
  return item.how === 'resumed' && item.status === 'running'
    ? 'running（resume を受理しただけ。会話が戻ったかは未確認）'
    : statusPhrase(item.status);
}

/** 同じ出来事（同じ cause）で取り戻した委譲の一覧。全文は載せない（担当ごとの詳細は `manager_report` で読める）。 */
export function renderRestoredNotice(head: string, items: readonly RestoredListItem[]): string {
  const lines = [`${head}: ${String(items.length)} 本の委譲に当たった`, ''];
  for (const item of items) {
    const firstNote = item.first ? '（最初の1本。担当への報告としては先に届けてある）' : '';
    lines.push(
      `- ${item.managerId}: 器 ${item.runnerId ?? '(不明)'} / ${howPhrase(item.how)} / 状態 ${itemStatusPhrase(item)}${firstNote}`,
      `  作業ディレクトリ: ${item.cwd ?? '(不明)'}`,
    );
    if (item.workspaceLine !== '') {
      lines.push(...item.workspaceLine.split('\n').map((line) => `  ${line}`));
    }
    if (item.excerpt !== undefined) lines.push(`  直近の報告（抜粋）: ${item.excerpt}`);
    // 配る時点で既に lost なら添えない: 見込みではなく結果が出ている。
    if (item.withoutLog === true && item.status !== 'lost') {
      lines.push(`  ⚠ ${RESUMED_WITHOUT_LOG_CLAUSE}`);
    }
  }
  lines.push('');
  if (items.some((item) => item.how === 'attached')) lines.push(ATTACHED_GUIDANCE);
  if (items.some((item) => item.how === 'resumed')) lines.push(RESUMED_GUIDANCE);
  lines.push('担当ごとの詳細は manager_report で読める。');
  return lines.join('\n');
}
