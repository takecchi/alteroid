import { QUOTA_STOP_WINDOW_MS } from './quota-stop-notice.js';
import { QuotaStopWindows } from './quota-stop-windows.js';
import { RestoredWindows } from './restored-windows.js';
import { RESUME_CONFIRM_TIMEOUT_MS } from './resume-confirmation.js';
import { ResumeEventWindows } from './resume-event-windows.js';
import { SYNTHESIZED_NOTICE_WINDOW_MS } from './synthesized-notice.js';
import { SynthesizedNoticeWindows } from './synthesized-notice-windows.js';
import type { WithheldReportsStore } from './withheld-reports-store.js';

type QuotaPorts = ConstructorParameters<typeof QuotaStopWindows>[0];
type SynthesizedPorts = ConstructorParameters<typeof SynthesizedNoticeWindows>[0];
type RestoredPorts = ConstructorParameters<typeof RestoredWindows>[0];
type ResumePorts = ConstructorParameters<typeof ResumeEventWindows>[0];

/**
 * `Pool` の constructor の窓 4 種へ渡す口の束。口（関数）は `Pool` 側で作った物をそのまま渡す（このファイルは `Pool` を知らない）。
 * `records`・`tokenIdentities`・`supersedePending`・`withheld` は `Pool` の持つ同じ参照。
 * `withheld.carriedToWindow` はこの関数の中で 1 回だけ（構築の時点で）取り出す。
 * 窓の長さ・確認の待ち時間は未指定（`undefined`）なら既定値へ解決する（`synthesizedNoticeWindowMs` の既定は環境変数も読む）。
 */
export interface WindowsDeps {
  records: QuotaPorts['records'];
  tokenIdentities: SynthesizedPorts['tokenIdentities'];
  supersedePending: SynthesizedPorts['supersedePending'];
  withheld: WithheldReportsStore;
  quotaStopWindowMs: number | undefined;
  synthesizedNoticeWindowMs: number | undefined;
  resumeConfirmTimeoutMs: number | undefined;
  notifyExcerptLines: RestoredPorts['notifyExcerptLines'];
  trackedGenerationSilent: ResumePorts['trackedGenerationSilent'];
  now: QuotaPorts['now'];
  nowIso: QuotaPorts['nowIso'];
  post: QuotaPorts['post'];
  journalExchange: QuotaPorts['journalExchange'];
  listJobsOrNote: QuotaPorts['listJobsOrNote'];
  postReport: RestoredPorts['postReport'];
  queueNotice: RestoredPorts['queueNotice'];
  statusAtDelivery: SynthesizedPorts['statusAtDelivery'];
  stopped: RestoredPorts['stopped'];
  judgeSessionGeneration: ResumePorts['judgeSessionGeneration'];
  onEvent: ResumePorts['onEvent'];
  droppedReportFiles: ResumePorts['droppedReportFiles'];
  journal: ResumePorts['journal'];
}

export interface Windows {
  quotaWindows: QuotaStopWindows;
  synthesized: SynthesizedNoticeWindows;
  restored: RestoredWindows;
  resumeWindows: ResumeEventWindows;
}

/** 窓 4 種を `quotaWindows → synthesized → restored → resumeWindows` の順に 1 回ずつ作る（同期）。 */
export function createWindows(deps: WindowsDeps): Windows {
  const quotaWindowMs = deps.quotaStopWindowMs ?? QUOTA_STOP_WINDOW_MS;
  const quotaWindows = new QuotaStopWindows({
    records: deps.records,
    // 呼び出しの形にしない: exchange-kind-coverage.test.ts が書き込み箇所として数えるため（ここは束ねるだけ）
    journalExchange: deps.journalExchange,
    post: deps.post,
    listJobsOrNote: deps.listJobsOrNote,
    withheldCarriedToWindow: deps.withheld.carriedToWindow,
    now: deps.now,
    nowIso: deps.nowIso,
    windowMs: quotaWindowMs,
  });
  const synthesized = new SynthesizedNoticeWindows({
    records: deps.records,
    tokenIdentities: deps.tokenIdentities,
    supersedePending: deps.supersedePending,
    quotaWindows,
    takeWithheldForDelivery: (managerId, text, withheldSuffixDetail) =>
      deps.withheld.takeForDelivery(managerId, text, withheldSuffixDetail),
    post: deps.post,
    statusAtDelivery: deps.statusAtDelivery,
    // 呼び出しの形にしない: exchange-kind-coverage.test.ts が書き込み箇所として数えるため（ここは束ねるだけ）
    journalExchange: deps.journalExchange,
    now: deps.now,
    nowIso: deps.nowIso,
    windowMs: deps.synthesizedNoticeWindowMs ?? SYNTHESIZED_NOTICE_WINDOW_MS,
  });
  const restored = new RestoredWindows({
    records: deps.records,
    // 呼び出しの形にしない: exchange-kind-coverage.test.ts が書き込み箇所として数えるため（ここは束ねるだけ）
    journalExchange: deps.journalExchange,
    post: deps.post,
    postReport: deps.postReport,
    queueNotice: deps.queueNotice,
    notifyExcerptLines: deps.notifyExcerptLines,
    listJobsOrNote: deps.listJobsOrNote,
    trackFlush: (flush) => quotaWindows.trackFlush(flush),
    now: deps.now,
    nowIso: deps.nowIso,
    stopped: deps.stopped,
    windowMs: quotaWindowMs,
    confirmTimeoutMs: deps.resumeConfirmTimeoutMs ?? RESUME_CONFIRM_TIMEOUT_MS,
  });
  const resumeWindows = new ResumeEventWindows({
    records: deps.records,
    judgeSessionGeneration: deps.judgeSessionGeneration,
    trackedGenerationSilent: deps.trackedGenerationSilent,
    onEvent: deps.onEvent,
    droppedReportFiles: deps.droppedReportFiles,
    journal: deps.journal,
  });
  return { quotaWindows, synthesized, restored, resumeWindows };
}
