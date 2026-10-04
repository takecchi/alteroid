import { stdout } from 'node:process';

import { createClient } from './client.js';
import { withErrorReason } from './format.js';
import { redactBody, redactError } from './redact.js';
import { describeAuthFailure, resolveTarget } from './target.js';
import { readSSE } from './tui/sse.js';

/**
 * `alteroid topology` — 稼働の地図（人間 ↔ クローン ↔ 記憶、クローン ↔ マネージャー ↔
 * 作業者）を端末で読む。
 *
 * 経路は `GET /topology`（`--watch` は `GET /topology/stream`）の1本だけで、Web UI の
 * 地図も同じものを見る（PRD「インターフェース」— 片方の口でしかできないことを作らない）。
 *
 * **ここに判断は無い。** 「いま流れている」と読む閾値も持たない——線は**最後の活動からの
 * 経過**（`3s ago`）をそのまま出し、読むのは人間である。`unknown`（分からない）は
 * `unknown` のまま出し、`ok` / `idle` に化けさせない。
 */

/** `GET /topology` の応答のうち、この口が読む分（型の複製。生成元は daemon の `topologyResponseSchema`）。 */
export interface TopologyView {
  observedAt: string;
  clone: { state: string; turn?: { conversationId?: string; kind: string } };
  storage: { label?: string; state: string; checkedAt?: string; error?: string };
  runners: { label: string; runnerId?: string; state: string; since: string }[];
  managers: {
    managerId: string;
    status: string;
    live: boolean;
    runnerId?: string;
    request: string;
    startedAt: string;
    updatedAt: string;
    lastReportAt?: string;
    waiting: { requestId: string; kind?: string; summary: string; askedAt?: string }[];
    waitingOmitted?: number;
    workers: { agentType: string; lastTool?: string; lastToolAt?: string }[];
  }[];
  managersOmitted?: number;
  /** 台帳から読めなかった委譲の行（1件以上のときだけ載る。`GET /managers` の `unreadable` と同じ形）。 */
  unreadable?: { id?: string; reason: string }[];
  links: { key: string; lastDownAt?: string; lastUpAt?: string; lastActivityAt?: string }[];
}

/** 経過を `3s ago` の形にする。読めない時刻は「経過不明」。 */
export function formatAge(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '経過不明';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${String(seconds)}s ago`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m ago`;
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3600))}h ago`;
  return `${String(Math.floor(seconds / 86_400))}d ago`;
}

/** 線の向きごとの時刻。**無い向きは「観測していない」と言う**（0 や「流れていない」にしない）。 */
function renderLink(
  link: TopologyView['links'][number] | undefined,
  labels: { down: string; up: string; activity?: string },
  now: number,
): string {
  const part = (label: string, at: string | undefined): string =>
    `${label} ${at === undefined ? '—（未観測）' : formatAge(at, now)}`;
  const parts = [
    part(`↓ ${labels.down}`, link?.lastDownAt),
    part(`↑ ${labels.up}`, link?.lastUpAt),
  ];
  if (labels.activity !== undefined) {
    parts.push(part(`・ ${labels.activity}`, link?.lastActivityAt));
  }
  return parts.join('   ');
}

function renderClone(clone: TopologyView['clone']): string {
  const turn =
    clone.turn === undefined
      ? ''
      : `（${clone.turn.kind}${clone.turn.conversationId === undefined ? '' : `・会話 ${clone.turn.conversationId}`}）`;
  const note = clone.state === 'unknown' ? '（この器はターンの有無を答えられない）' : '';
  return `${clone.state}${turn}${note}`;
}

function renderStorage(storage: TopologyView['storage'], now: number): string {
  const label = storage.label === undefined ? '' : `${storage.label}: `;
  const checked =
    storage.checkedAt === undefined ? '' : `（${formatAge(storage.checkedAt, now)}に確認）`;
  const error = storage.error === undefined ? '' : `  理由: ${redactError(storage.error)}`;
  const note =
    storage.state === 'unknown' ? '（確かめる手段が無い、またはまだ確かめていない）' : '';
  return `${label}${storage.state}${checked}${note}${error}`;
}

/**
 * 地図を端末向けの木にする。**純粋関数**（`now` を引数で受け、時刻に依らず同じ入力から
 * 同じ出力を返す）。自由文（`request` と返事待ちの `summary`）には伏せ字を掛ける。
 */
export function renderTopology(view: TopologyView, now: number = Date.now()): string {
  const linkOf = (key: string) => view.links.find((link) => link.key === key);
  const lines: string[] = [
    `稼働の地図（${formatAge(view.observedAt, now)}に観測 / ${view.observedAt}）`,
    '',
    '人間',
    `  └ ${renderLink(linkOf('human~clone'), { down: '発言', up: '応答' }, now)}`,
    `クローン [${renderClone(view.clone)}]`,
    `  ├ 記憶 [${renderStorage(view.storage, now)}]`,
    `  │   ${renderLink(linkOf('clone~storage'), { down: '書き込み', up: '読み出し' }, now)}`,
  ];

  if (view.runners.length === 0) {
    lines.push('  ├ runner: 名簿に載っていない');
  } else {
    for (const runner of view.runners) {
      lines.push(
        `  ├ runner ${runner.runnerId ?? runner.label} [${runner.state}] ${formatAge(runner.since, now)}からこの状態`,
      );
    }
  }

  if (view.managers.length === 0) {
    lines.push('  └ マネージャー: 走行中・返事待ち・直近10分に終わった委譲は無い');
  } else {
    lines.push(`  └ マネージャー（${String(view.managers.length)} 本）`);
    for (const manager of view.managers) {
      const live = manager.live ? 'live' : 'not live';
      lines.push(
        `      ${manager.managerId} [${manager.status}・${live}]  ${redactBody(manager.request)}`,
      );
      lines.push(
        `        ${renderLink(
          linkOf(`clone~manager:${manager.managerId}`),
          { down: '指示', up: '報告・確認' },
          now,
        )}`,
      );
      if (manager.lastReportAt !== undefined) {
        lines.push(`        最後の報告 ${formatAge(manager.lastReportAt, now)}`);
      }
      for (const waiting of manager.waiting) {
        const asked =
          waiting.askedAt === undefined ? '' : `（${formatAge(waiting.askedAt, now)}から）`;
        lines.push(
          `        返事待ち ${waiting.kind ?? '種別不明'}${asked}: ${redactBody(waiting.summary)}`,
        );
      }
      if (manager.waitingOmitted !== undefined) {
        lines.push(
          `        …ほか返事待ち ${String(manager.waitingOmitted)} 件は省略（全件は GET /managers）`,
        );
      }
      for (const worker of manager.workers) {
        const tool =
          worker.lastTool === undefined || worker.lastToolAt === undefined
            ? '道具の実行はまだ観測していない'
            : `最後の道具 ${worker.lastTool}（${formatAge(worker.lastToolAt, now)}）`;
        lines.push(`        作業者 ${worker.agentType}（種類ごとに束ねた1行）: ${tool}`);
        lines.push(
          `          ${renderLink(
            linkOf(`manager:${manager.managerId}~worker:${worker.agentType}`),
            { down: '背景で起動', up: '結果が戻った', activity: '活動' },
            now,
          )}`,
        );
      }
    }
    if (view.managersOmitted !== undefined) {
      lines.push(
        `      …ほか ${String(view.managersOmitted)} 本は文字数の予算で省略（全件は GET /managers）`,
      );
    }
  }

  // 読めなかった行が在るときだけ言う（0件なら出力を変えない）。「居ない」と読ませない。
  if (view.unreadable !== undefined && view.unreadable.length > 0) {
    lines.push(
      '',
      `⚠️ 台帳から読めなかった委譲の行が ${String(view.unreadable.length)} 件ある。上の一覧には数えていない（「居ない」とは限らない）。`,
    );
    for (const row of view.unreadable) {
      lines.push(`    ${row.id ?? '（id 不明）'}: ${redactError(row.reason)}`);
    }
    lines.push('    詳細は GET /managers の unreadable');
  }

  lines.push(
    '',
    '（作業者は managerId × agentType で束ねた行で、個体は見分けない。' +
      '作業者の線の ↓ は背景で起こした時刻、↑ は前景の呼び出しが終わって結果が戻った時刻。' +
      '前景で起こした瞬間は日誌に載らない）',
  );
  return lines.join('\n');
}

export interface TopologyOptions {
  json?: boolean;
  watch?: boolean;
}

/** 画面を消して先頭へ戻す（端末のときだけ）。 */
const CLEAR_SCREEN = '\u001b[2J\u001b[H';

export async function topologyCommand(options: TopologyOptions = {}): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }

  if (options.watch === true) {
    await watchTopology(target, options.json === true);
    return;
  }

  const client = createClient(target.baseUrl, target.headers);
  const response = await client.topology.$get();
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `稼働の地図を読めませんでした（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  const view = await response.json();
  if (options.json === true) {
    stdout.write(`${JSON.stringify(view, null, 2)}\n`);
    return;
  }
  stdout.write(`${renderTopology(view as TopologyView)}\n`);
}

/**
 * `--watch`: `GET /topology/stream` を読み続けて描き直す。
 *
 * - 端末（TTY）では、スナップショットが届くたびと**1秒ごと**に描き直す。ストリームは
 *   **内容が変わったときだけ**届くので、経過（`3s ago`）は最後の内容を使って手元で進める。
 * - 端末でないとき（パイプ・ファイル）は、届いたスナップショットを描き足すだけ。
 *   `--json` は1スナップショット1行（NDJSON）。
 * - デーモンが地図を組めなくなると `unavailable` が1回届く（`notice`／`--json` は `type` 付きの1行）。
 * - Ctrl-C（SIGINT）で終わる。接続が切れたら理由つきで落とす（黙って止まらない）。
 */
async function watchTopology(
  target: Awaited<ReturnType<typeof resolveTarget>>,
  json: boolean,
): Promise<void> {
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once('SIGINT', onSigint);

  let latest: TopologyView | null = null;
  /** デーモンが「組めない」と知らせている間の1行（次のスナップショットで消える）。 */
  let notice: string | null = null;
  const tty = stdout.isTTY === true;
  const paint = (): void => {
    if (latest === null) return;
    const warning = notice === null ? '' : `\n${notice}`;
    stdout.write(
      `${tty ? CLEAR_SCREEN : ''}${renderTopology(latest)}${warning}\n${tty ? '' : '\n'}`,
    );
  };
  const ticker = !json && tty ? setInterval(paint, 1000) : null;

  try {
    let response: Response;
    try {
      response = await fetch(`${target.baseUrl}/topology/stream`, {
        method: 'GET',
        headers: { ...target.headers, 'content-type': 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      throw new Error(`稼働の地図の購読: デーモンに繋がりません（${redactError(String(error))}）`, {
        cause: error,
      });
    }
    if (!response.ok || response.body === null) {
      const described = describeAuthFailure(response.status, target);
      if (described !== null) throw new Error(described);
      throw new Error(
        await withErrorReason(
          `稼働の地図の購読に失敗しました（HTTP ${String(response.status)}）`,
          response,
        ),
      );
    }
    try {
      for await (const event of readSSE(response.body)) {
        if (event.name === 'unavailable') {
          // デーモンが地図を組めなくなった（失敗の最初の1回だけ届く。理由は種別だけ）。
          // `--json` は1行の `{"type":"unavailable","error":"<種別>"}`。**スナップショットの行は
          // `type` 欄を持たない**ので、読み手は `type` の有無で見分けられる。
          const body = event.json<{ error?: unknown }>();
          const kind = typeof body?.error === 'string' ? body.error : 'unknown';
          if (json) {
            stdout.write(`${JSON.stringify({ type: 'unavailable', error: kind })}\n`);
          } else {
            notice = `⚠️ デーモンが地図を組めていない（理由の種別: ${redactError(kind)}）。復旧すると続きを描く。`;
            if (latest === null) stdout.write(`${notice}\n`);
            else paint();
          }
          continue;
        }
        if (event.name !== 'snapshot') continue;
        const view = event.json<TopologyView>();
        if (view === null) continue;
        notice = null;
        latest = view;
        if (json) stdout.write(`${JSON.stringify(view)}\n`);
        else paint();
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      throw new Error(`稼働の地図の購読: 接続が切れました（${redactError(String(error))}）`, {
        cause: error,
      });
    }
    if (!controller.signal.aborted) {
      throw new Error('稼働の地図の購読: デーモンが接続を閉じました');
    }
  } finally {
    if (ticker !== null) clearInterval(ticker);
    process.off('SIGINT', onSigint);
  }
}
