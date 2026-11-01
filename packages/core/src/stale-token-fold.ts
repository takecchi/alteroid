import { reasonOf } from './dropped-record.js';
import { HELD_FORCE_FOLD_AFTER_MS, type StaleHoldStuck } from './held-messages.js';
import type { ManagerRecord, ManagerSendResult } from './manager.js';
import { describeHeldTokenState, redactedBackgroundCommands } from './manager-notices.js';
import { tokenGenerationMismatched } from './manager-summary.js';
import { listRunnerManagers } from './runner-protocol.js';
import type { RunnerClient, RunnerManagerListing } from './runner-protocol.js';
import type { JournalEntryInput } from './schema.js';
import { UNPUSHED_WORK_OBSERVATION_TIMEOUT_MS } from './unpushed-work-observation.js';

/**
 * `Pool` が口として渡すもの。欄は参照で渡す（ここで別に持たない）: `resumedCount` は `#resume` が書く欄で、先頭と畳む直前の2回、
 * その時点の値を読むので値では渡さない。`rotationFoldDueAt` は書く側（`UsageWakeSweeper` が同じ参照を読む）。
 * `tokenIdentity`・`tokenAvailability`・`lastStaleDecline` は呼ぶたびに引く。
 */
export interface StaleTokenFoldPorts {
  resumedCount: ReadonlyMap<string, number>;
  rotationFoldDueAt: Map<string, number>;
  tokenIdentities: ReadonlyMap<string, { tokenId: string; generation: number }>;
  tokenIdentity: () => { tokenId: string; generation: number; fingerprint?: string } | undefined;
  tokenAvailability:
    | ((tokenId: string) => Promise<'ready' | 'cooling' | 'disabled' | 'invalidated' | undefined>)
    | undefined;
  sessionTokenFingerprintOf: (managerId: string) => string | undefined;
  /** 生存確認の観測（10秒ごとの `/managers`）が名乗った、セッションの env の鍵の指紋。 */
  observedTokenFingerprint: (runnerId: string | undefined, managerId: string) => string | undefined;
  journal: (entry: JournalEntryInput) => Promise<void>;
  lastStaleDecline: (managerId: string) => string | undefined;
  rememberStaleDecline: (managerId: string, declineRecord: string) => void;
  unpushedWork: (
    managerId: string,
    options: { signal: AbortSignal; source: 'stop' },
  ) => Promise<unknown>;
}

export interface StaleTokenFoldOptions {
  foldBackgroundAfterWait?: boolean;
  /** 鍵の回転・枠の起こし直しの回だけ真（#4850）。抱えている古い鍵が ready でなければ、背景処理ごと畳む。ready なら今までどおり旧セッションへ届ける。 */
  foldBackgroundIfHeldTokenNotReady?: boolean;
  /**
   * 鍵の回転の起こし直しで、まだ待ちの上限に届いていない回の、上限の時刻（epoch ms。#5044）。
   * peer 以外の背景処理が残っていれば、この時刻までは畳まずに断る: 背景処理を待つ間、担当は鍵を使わないので枠は焼かず、畳むと結果を失うため。
   */
  rotationFoldDueAt?: number;
  /** 見回りの届け直しの回だけ真（#4982）。前に書いた断りと本文が同じなら、断りの decision を書かない（断る判定そのものは変えない）。 */
  skipUnchangedDeclineRecord?: boolean;
}

export interface StaleTokenFoldResult {
  /** 背景処理ごと畳んだ本数（待ちの上限 `HELD_FORCE_FOLD_AFTER_MS` を過ぎた回か、鍵の回転の回）。 */
  foldedBackground?: number;
  /** 畳まずに預けた peer の本数（`foldedBackground` には含めない。#4881） */
  foldedPeers?: number;
  /** 畳んだ背景処理のうち、コマンドが分かったもの（伏せ字済み・字数を切ってある）。 */
  foldedBackgroundCommands?: string[];
  declined?: ManagerSendResult;
  /** 断った理由だけ（取れる手を含まない）。預かる回の応答に使う: 断る回の detail は「送り直すこと」と言い、預かった回とは逆の手になるため。 */
  declinedReason?: string;
  /** 断った回の材料（#5041）。断る判定には使わない。 */
  stuck?: StaleHoldStuck;
  fingerprintMatched?: true;
  staleDelivery?: { generation: number; blockers: string[] };
}

/**
 * 古い鍵で走っている done の委譲を、畳んで新しい鍵で起こし直してよいかの判定と、畳む操作（`Pool` から切り出した。振る舞いは変えていない）。
 */
export class StaleTokenFold {
  readonly #ports: StaleTokenFoldPorts;

  constructor(ports: StaleTokenFoldPorts) {
    this.#ports = ports;
  }

  /**
   * 畳むのは「失うものが無い」と分かったときだけで、1つでも欠けていれば断る（`declined`）: 畳むと SDK 子プロセスごと
   * 確認待ち（`canUseTool`）と起こしっぱなしの背景処理が道連れになる。古い鍵のまま流し込むこともしない。
   *
   * - 背景処理は runner の応答の `liveBackgroundTasks` だけが材料: `report.awaitingBackground` は失敗で終わった回
   *   （枠で終わった回）には立たない。欄は runner が必ず返す。欄の無い応答（古い runner）は
   *   スキーマが落とし、読めない委譲として断る側に数える（0 と読むと背景処理を黙って殺す）。
   * - `sessionId` が無いまま畳むと会話が切れる。
   *
   * 順序に依存している（`runner-stop-finish-order.test.ts` が固定）: `runner.stop()` は子プロセスを閉じた後に生ログを送り出し、
   * 未報告の本文を flush してから `onClosed` する。一覧から消えたと確かめられなければ resume しない（二重に起こさない）。
   * `attached` を false にするが貸し出しは返さない: `abort()` を流用しない（`stopConfirmedAt` を立てて `#resume` に resume を断らせる）。
   */
  async fold(
    record: ManagerRecord,
    runner: RunnerClient,
    managerId: string,
    options: StaleTokenFoldOptions = {},
  ): Promise<StaleTokenFoldResult> {
    const ports = this.#ports;
    // 判断を始めた時点の resume の回数を控える（#5207）: 畳む直前に読み直し、その間に別の経路が起こし直していたら畳まない
    const resumedAtStart = ports.resumedCount.get(managerId) ?? 0;
    const held = ports.tokenIdentities.get(managerId)?.generation;
    const identity = ports.tokenIdentity();
    const active = identity?.generation;
    const activeFingerprint = identity?.fingerprint;

    // 繋がっていて世代を覚えている回だけ世代で比べ、それ以外は鍵の指紋で比べる。
    // 再起動で引き取っただけのセッション（繋がっているが世代を覚えていない）も指紋で比べる（#4643）: 世代で比べると「分からない」で素通りし、
    // 古い鍵のセッションへ送ってまた枠に当たる。再起動の前なら同じ委譲は世代の食い違いで畳まれて新しい鍵で起こし直されていた。
    const byGeneration = record.attached && held !== undefined;
    if (byGeneration) {
      // 一覧の ⚠ と同じ判定（`tokenGenerationMismatched`）を使う。ここで別の式を書かない。
      if (
        !tokenGenerationMismatched({ tokenGeneration: held, activeTokenGeneration: active }) ||
        active === undefined
      ) {
        return {};
      }
    } else {
      // 台帳が「繋がっていない」done は、まず10秒ごとの生存確認の観測で見る: 普段の経路で `runner.list()` を増やさない
      // （`manager-lease.test.ts` が固定）。観測は最大10秒古いので、食い違いのときだけ下で取り直して確かめる。
      // 指紋が分からないときは断らず流し、世代は書かない。
      const observed = record.attached
        ? ports.sessionTokenFingerprintOf(managerId)
        : ports.observedTokenFingerprint(record.job.runnerId, managerId);
      if (observed === undefined || activeFingerprint === undefined) return {};
      if (observed === activeFingerprint) return { fingerprintMatched: true };
    }

    let listing: RunnerManagerListing;
    try {
      listing = await listRunnerManagers(runner);
    } catch (error) {
      if (!record.attached) return {};
      // 指紋で比べた回（再起動で引き取っただけ）は世代を覚えていないので、世代を言わない（#4643）
      const mismatch = byGeneration
        ? `認証トークンの世代が食い違っている（世代 ${String(held)} を抱えたまま、現役は世代 ${String(active)}）`
        : '認証トークンの鍵の指紋が現役と食い違っている';
      const reason =
        `${managerId} は${mismatch}が、runner の状態を読めなかった（${reasonOf(error)}）ため、` +
        '背景処理や確認待ちが残っているか分からない。畳んでいないし、古い鍵のセッションへも送っていない。';
      return {
        declined: { outcome: 'declined', detail: `${reason}少し置いてから送り直すこと。` },
        declinedReason: reason,
        stuck: { blockers: [reason], generation: held, backgroundCommands: [] },
      };
    }
    const state = listing.states.find((entry) => entry.managerId === managerId);
    if (state === undefined) {
      if (!listing.unreadableIds.includes(managerId)) return {};
      // 読めない形で在るなら「居る」側に数える: 数えずに通すと旧セッションへ送りうる。
      if (!record.attached) return {};
      const reason =
        `${managerId} は認証トークンの世代が食い違っているが、runner が返した状態が読めず、` +
        '背景処理や確認待ちが残っているか分からない。送っていない。';
      return {
        declined: { outcome: 'declined', detail: reason },
        declinedReason: reason,
        stuck: { blockers: [reason], generation: held, backgroundCommands: [] },
      };
    }

    // 台帳が「繋がっていない」のに旧プロセスが生きている回は、世代が再起動で失われているので鍵の指紋で比べる。
    // 読めないときは断らず流す（再起動後の done へ送れなくなるのは能力の削除になる）。
    let staleness: string;
    if (byGeneration) {
      staleness =
        `認証トークンの世代が食い違っている（世代 ${String(held)} を抱えたまま、` +
        `現役は世代 ${String(active)}）`;
    } else {
      const sessionFingerprint = state.tokenFingerprint;
      if (sessionFingerprint === undefined || activeFingerprint === undefined) return {};
      if (sessionFingerprint === activeFingerprint) return { fingerprintMatched: true };
      // 出してよいのは指紋だけ（sha256 の先頭12桁）。鍵の値は出さない。
      staleness =
        '生きている旧セッションが起動時に掴んだ鍵の指紋が現役と食い違っている' +
        `（セッション ${sessionFingerprint} / 現役 ${activeFingerprint}）`;
    }

    const blockers: string[] = [];
    const waitingCount = Math.max(state.waiting.length, record.waiting.length);
    if (waitingCount > 0) blockers.push(`確認待ちが ${String(waitingCount)} 件残っている`);
    if (state.liveBackgroundTasks > 0) {
      blockers.push(`起こしっぱなしの背景処理が ${String(state.liveBackgroundTasks)} 本残っている`);
    }
    if (record.job.sessionId === undefined) {
      blockers.push('会話を引き継ぐ sessionId が無い（畳むと会話が切れる）');
    }
    if (!record.attached && state.status === 'running') {
      blockers.push('runner のセッションはいまターンが走っている（畳むと走っている仕事を失う）');
    }
    // 背景処理だけが理由で、話しかけたい伝言が待ちの上限を過ぎたときは背景処理ごと畳む: 背景処理が終わらない（dev サーバ・見張り）か、
    // 終わったのに静かなセッションへ変化が届かず本数が古いまま残ると、時間では解けず、古い鍵のまま居座るため。
    // 確認待ち・走っているターン・状態が読めない回は畳まない（答えを待っているのはクローンで、分からないものは捨てない）。
    // 鍵の回転の回は、peer 以外の背景処理を待ちの上限（`rotationFoldDueAt`）まで待つ（#5044。#4850 は待たなかった）: 待つ間は鍵を使わず枠を焼かない。
    // 待たずに畳むと、長い検証は鍵が回るたびに途中で失われ、続けて回ると終わらない。上限を過ぎたら、終わらない背景処理（dev サーバ・見張り）とみなして畳む。
    // ここへ来るのは抱えている鍵が ready でない回だけ（ready なら下で旧セッションへ流して返る）。冷却中・失効・分からないは同じく畳む側に倒す。
    // peer だけなら待たない: peer は畳まずに預けて続くため（#4734）
    const peersInBackground = Math.min(state.liveBackgroundPeers ?? 0, state.liveBackgroundTasks);
    const heldTokenId = ports.tokenIdentities.get(managerId)?.tokenId;
    // 断る回にも鍵の状態を言うために外へ出す: 言わないと、クローンはいつ送り直せばよいかを決められず、
    // 段1（ready なら届ける）で足りているのかを日誌から数えられない（#4441 の段2の判断材料）。
    let heldTokenState: string | undefined;
    // 抱えている鍵が使えないと分かったか（冷却中・止めてある・無効）。読めなかった・聞いていない回は偽（分からないものは「使えない」に倒さない）
    let heldTokenUnusable = false;
    if (blockers.length > 0) {
      // 抱えている鍵がいま ready なら断らず旧セッションへ流す: その鍵ならまた枠に当たらず、畳めば確認待ち・背景処理を失うため。
      // 指紋で判定した回（attached=false）は鍵が分からないので流さない。sessionId が無い回も流さない（保守側に倒す）。
      if (
        record.attached &&
        record.job.sessionId !== undefined &&
        heldTokenId !== undefined &&
        held !== undefined &&
        ports.tokenAvailability !== undefined
      ) {
        const availability = await ports.tokenAvailability(heldTokenId).catch(() => undefined);
        heldTokenState = describeHeldTokenState(availability);
        heldTokenUnusable = availability !== undefined && availability !== 'ready';
        if (availability === 'ready') {
          await ports.journal({
            type: 'decision',
            decision: `[${managerId}] done の委譲を、古い鍵（世代 ${String(held)}）のまま旧セッションへ届ける（${staleness}）`,
            grounds:
              `managerId=${managerId} tokenId=${heldTokenId} 鍵の状態=ready ` +
              `畳めない理由=${blockers.join('。')}（#4441。畳むと残っているものを失い、その鍵はいま使える）`,
          });
          return { staleDelivery: { generation: held, blockers } };
        }
      }
    }
    // 残っている背景処理（peer を除く）が全部作業者（サブエージェント）で、抱えている鍵が使えないと分かっていれば待たない（#5109）:
    // 作業者は担当と同じ古い鍵で走るので、待っても進まず、本数だけが残って上限まで待つことになる（2026-10-20 の PARTY-6・MVP-4 は 16 分）。
    // テスト・ビルドのような子プロセスは鍵を使わずに最後まで走るので、今までどおり待つ。種類の分からない runner（欄が無い）も今までどおり待つ。
    const nonPeerBackground = state.liveBackgroundTasks - peersInBackground;
    const agentsStuckOnUnusableKey =
      heldTokenUnusable &&
      state.liveBackgroundAgents !== undefined &&
      nonPeerBackground > 0 &&
      state.liveBackgroundAgents >= nonPeerBackground;
    const rotationWaiting =
      options.foldBackgroundIfHeldTokenNotReady === true &&
      options.rotationFoldDueAt !== undefined &&
      blockers.length === 1 &&
      nonPeerBackground > 0 &&
      !agentsStuckOnUnusableKey;
    const foldBackground =
      (options.foldBackgroundAfterWait === true ||
        (options.foldBackgroundIfHeldTokenNotReady === true && !rotationWaiting) ||
        agentsStuckOnUnusableKey) &&
      blockers.length === 1 &&
      state.liveBackgroundTasks > 0
        ? state.liveBackgroundTasks
        : undefined;
    if (blockers.length > 0 && foldBackground === undefined) {
      const tokenClause =
        heldTokenState === undefined
          ? ''
          : `抱えている古い鍵（${heldTokenId ?? '?'}）は${heldTokenState}ので、そのまま旧セッションへ届けることもしない。`;
      const rotationWaitClause =
        rotationWaiting && options.rotationFoldDueAt !== undefined
          ? `鍵の回転の起こし直しは、背景処理が終わるのを待ちの上限（${String(HELD_FORCE_FOLD_AFTER_MS / 60_000)} 分、` +
            `${new Date(options.rotationFoldDueAt).toISOString()}）まで待つ。終わればそのまま、上限を過ぎれば背景処理ごと畳んで起こし直す（#5044）。`
          : '';
      if (rotationWaiting && options.rotationFoldDueAt !== undefined) {
        // 挑み直しの時刻を上限へ寄せる（`UsageWakeSweeper#noteOutcome`）: 倍々の間隔のままだと、上限を最大30分越えて待つため
        ports.rotationFoldDueAt.set(managerId, options.rotationFoldDueAt);
      }
      const declineDecision = rotationWaiting
        ? `[${managerId}] 鍵の回転の起こし直しを、背景処理が終わるまで待つ（${staleness}）`
        : `[${managerId}] done の委譲へ送られた本文を、届けずに断った（${staleness}）`;
      const declineGrounds =
        `managerId=${managerId} tokenId=${heldTokenId ?? '（分からない）'} ` +
        `鍵の状態=${heldTokenState ?? '（聞いていない）'} 畳めない理由=${blockers.join('。')}（#4441）` +
        (rotationWaitClause === '' ? '' : ` ${rotationWaitClause}`);
      const declineRecord = `${declineDecision}\u0000${declineGrounds}`;
      // 見回りの届け直しが前と同じ判定をやり直しただけの回は書かない（#4982）: 新しい判断ではなく、書くと見回りごと（60秒）に同じ行が積まれるため。
      // decision の行は畳まない（#1311）ので、要約も作らず、繰り返しの元（見回りの再判定）の側で書かない。人・クローンの送信と、理由・鍵の状態が変わった回は書く。
      if (
        options.skipUnchangedDeclineRecord !== true ||
        ports.lastStaleDecline(managerId) !== declineRecord
      ) {
        await ports.journal({
          type: 'decision',
          decision: declineDecision,
          grounds: declineGrounds,
        });
        ports.rememberStaleDecline(managerId, declineRecord);
      }
      const reason =
        `${managerId} は${staleness}。古い鍵のセッションへ流すとまた枠に当たるので、` +
        '畳んで新しい鍵で起こし直したいが、畳めない理由が残っている: ' +
        `${blockers.join('。')}。${tokenClause}${rotationWaitClause}畳んでいないし、送ってもいない。`;
      return {
        declined: {
          outcome: 'declined',
          detail:
            reason +
            '取れる手: (1) 背景処理・確認待ちが終わるのを待ってから送り直す。' +
            '(2) 残っているものを捨ててよいなら manager_stop → manager_start で後継を起こす' +
            '（manager_stop は残っている仕事ごと畳む）。',
        },
        declinedReason: reason,
        stuck: {
          blockers,
          ...(held === undefined ? {} : { generation: held }),
          ...(heldTokenId === undefined ? {} : { heldTokenId }),
          ...(heldTokenState === undefined ? {} : { heldTokenState }),
          backgroundTasks: state.liveBackgroundTasks,
          backgroundCommands: redactedBackgroundCommands(state.backgroundTaskCommands),
        },
      };
    }

    // best-effort: 失敗しても畳みの判断は変えない。
    await ports
      .unpushedWork(managerId, {
        signal: AbortSignal.timeout(UNPUSHED_WORK_OBSERVATION_TIMEOUT_MS),
        source: 'stop',
      })
      .catch(() => undefined);

    // 畳む直前に読み直す（#5207）: ここまでに runner の一覧・鍵の状態・未 push の観測を待っており、その間に別の経路（枠の回復と鍵の世代の食い違い）が
    // 同じ担当を新しい鍵で起こし直していることがある。頭で読んだ古い値のまま畳むと、起きたばかりのセッションを壊してもう一度起こし直す
    // （2026-10-23 heosterra。担当のターンが1つ壊れ、#5205 の引き金にもなった）。畳まなければ、呼び手はいまのセッションへそのまま届ける
    const resumedMeanwhile = (ports.resumedCount.get(managerId) ?? 0) !== resumedAtStart;
    const heldNow = ports.tokenIdentities.get(managerId)?.generation;
    const activeNow = ports.tokenIdentity()?.generation;
    const caughtUp =
      byGeneration &&
      heldNow !== undefined &&
      activeNow !== undefined &&
      !tokenGenerationMismatched({ tokenGeneration: heldNow, activeTokenGeneration: activeNow });
    if (resumedMeanwhile || caughtUp) {
      await ports.journal({
        type: 'decision',
        decision: `[${managerId}] 畳む直前に、別の経路が新しい鍵で起こし直していたので、畳まずにいまのセッションへ届ける（#5207）`,
        grounds:
          `managerId=${managerId} 判断を始めたときの理由=${staleness} ` +
          `resume の回数=${String(resumedAtStart)}→${String(ports.resumedCount.get(managerId) ?? 0)} ` +
          `抱えている鍵の世代=${heldNow === undefined ? '（分からない）' : String(heldNow)} 現役=${activeNow === undefined ? '（分からない）' : String(activeNow)}`,
      });
      return {};
    }

    let stopError: unknown;
    try {
      // peer は閉じずに預けさせる（#4734）: 畳むのは担当の Claude の鍵を付け替えるためだけで、peer は鍵と関係の無い資格で走っているため
      await runner.stop(managerId, { keepPeers: true });
    } catch (error) {
      stopError = error;
    }
    // 読めなかった委譲は居る側に数える（`abort()` と同じ）。
    const gone = await listRunnerManagers(runner)
      .then(
        ({ states, unreadableIds }) =>
          !states.some((entry) => entry.managerId === managerId) &&
          !unreadableIds.includes(managerId),
      )
      .catch(() => undefined);
    if (gone !== true) {
      const reason =
        `${managerId} の旧セッションを畳めたと確かめられなかった` +
        `（${gone === false ? 'runner の一覧にまだ残っている' : '一覧を読めなかった'}` +
        `${stopError === undefined ? '' : `。runner.stop() が例外を投げた: ${reasonOf(stopError)}`}）。` +
        '二重に起こさないので resume していないし、送ってもいない。';
      return {
        declined: { outcome: 'declined', detail: `${reason}少し置いてから送り直すこと。` },
        declinedReason: reason,
        stuck: { blockers: [reason], generation: held, backgroundCommands: [] },
      };
    }

    record.attached = false;
    if (foldBackground !== undefined) {
      // 待ちの上限を過ぎた回と、鍵の回転の回と、作業者だけが古い鍵で止まっている回を言い分ける: 後の2つは待っていない
      const byAgents = agentsStuckOnUnusableKey && options.foldBackgroundAfterWait !== true;
      const byRotation = !byAgents && options.foldBackgroundAfterWait !== true;
      await ports.journal({
        type: 'decision',
        decision:
          `[${managerId}] done の委譲を、残っていた背景処理 ${String(foldBackground)} 本ごと畳んで新しい鍵で起こし直す` +
          (byAgents
            ? `（${staleness}。残っている背景処理は作業者だけで、抱えている古い鍵は使えないので、待っても進まない）`
            : byRotation
              ? `（${staleness}。鍵の回転の起こし直しで、抱えている古い鍵は使えない）`
              : `（${staleness}。預かった伝言が ${String(HELD_FORCE_FOLD_AFTER_MS / 60_000)} 分届かなかった）`),
        grounds:
          `managerId=${managerId} liveBackgroundTasks=${String(foldBackground)} ` +
          `liveBackgroundAgents=${state.liveBackgroundAgents === undefined ? '（分からない）' : String(state.liveBackgroundAgents)} 確認待ち=0 ` +
          `鍵の状態=${heldTokenState ?? '（聞いていない）'}` +
          (byAgents
            ? '（#5109。作業者は担当と同じ古い鍵で走るので、背景処理の終わりを待たない。子プロセスの背景処理なら待ちの上限まで待つ）'
            : byRotation
              ? `（#4850 / #5044。鍵の回転の起こし直しは、背景処理を待ちの上限（${String(HELD_FORCE_FOLD_AFTER_MS / 60_000)} 分）までしか待たない` +
                '（待ち始めが分からない回は待たない）。古い背景処理は runner が止める）'
              : '（#4472。背景処理が終わらない・終わったのに本数が下りないと、古い鍵のまま居座るため）'),
      });
      const commands = redactedBackgroundCommands(state.backgroundTaskCommands);
      // 本数の内数。欄が無い古い runner は 0 本（今までどおり全部を畳んだと書く）
      const keptPeers = Math.min(state.liveBackgroundPeers ?? 0, foldBackground);
      return {
        foldedBackground: foldBackground - keptPeers,
        ...(keptPeers === 0 ? {} : { foldedPeers: keptPeers }),
        ...(commands.length === 0 ? {} : { foldedBackgroundCommands: commands }),
      };
    }
    await ports.journal({
      type: 'decision',
      decision: `[${managerId}] done の委譲を、畳んで新しい鍵で起こし直す（${staleness}）`,
      grounds:
        `managerId=${managerId} liveBackgroundTasks=0 確認待ち=0` +
        '（#2851 / #2877。旧セッションへ流すと古い鍵のまま走る）',
    });
    return {};
  }
}
