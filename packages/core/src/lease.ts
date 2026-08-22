import type { JobLease } from './schema.js';

/**
 * 貸し出し期限（lease）の判定 — **引き取ってよいかを、片側だけで言えるようにする**
 * （roadmap M5 PR4）。
 *
 * ## この文書が答える問い
 *
 * 「黙った器／入れ替わった器で走っていた委譲を、別のプロセスで起こし直してよいか」。
 * **「落ちた」は観測の欠落であって停止の証明ではない。** 見えないことと動いていない
 * ことを同じに扱うと、実は生きていた器と合わせて同じマネージャーが2台で走り、
 * `gh pr create` のような取り返しのつかない操作が二重に走る。
 *
 * ## 材料は3つあり、どれも「デーモンが自分で観測した事実」である
 *
 * 1. **入れ替えの観測** — 同じ宛先に別のプロセス（`instanceId`）が応え始めた。
 *    そのとき古いプロセスは**その宛先では到達できない**。器の側は入れ替えのときに
 *    古い器へ畳む猶予（`LEASE_DRAIN_MS`）を与えてから殺すので、猶予を過ぎたら
 *    「もう動いていない」と言える
 * 2. **貸し出し先の約束** — runner は「デーモンと連絡が取れないまま `ttlMs` 過ぎたら
 *    自分でセッションを畳む」（`runner.ts` の自己失効）。**この約束は相手の時計で
 *    数えられる**ので、経路が分かれていても効く。器が古い器を殺さない構成
 *    （入れ替えを観測できない経路の付け替えなど）で効くのはこちらである
 * 3. **同一性** — いま応えているプロセスが持ち主そのものなら、奪う話ではなく
 *    繋ぎ直しである
 *
 * **1 と 2 はどちらか片方で足りる**（どちらも「もう動いていない」の根拠になる）ので、
 * 引き取れる時刻は2つの期限の**早い方**である。
 *
 * ## 判定できないことを、判定の結果に混ぜない
 *
 * `identity()` を持たない runner（同一プロセスの `runner-local` や古い器）は
 * `instanceId` を名乗らない。そのとき言えるのは「分からない」だけである。
 * `judgeLease` はそれを `undecidable` として返し、**引き取り自体は許す** — 許さないと
 * 名乗らない runner のジョブが永久に引き取れなくなる（能力の削除。north_star 禁止1）。
 * ただし呼び出し側は「たまたま踏まなかった」と「仕組みで塞げている」を分けて報告
 * できる（AGENTS.md「報告の形」）。
 */

/**
 * 器が入れ替わるとき、古い器が畳まれるまでに与えられている猶予。
 *
 * **ここにあるのは写しである。** 正本は `railway/runner.json` の `drainingSeconds`
 * と `compose.yaml`（`runner`）の `stop_grace_period` で、どちらも実行中のプロセスから
 * は読めない。runner 自身も同じ数の写しを持っている（`apps/runner/src/index.ts` の
 * `SHUTDOWN_GRACE_MS`。あちらは「猶予より5秒早く自分で exit する」形）。
 * **あちらを変えるならここも変えること。**
 */
export const LEASE_DRAIN_MS = 60_000;

/**
 * 貸し出し先が「デーモンと連絡が取れないまま自分で畳む」までの猶予（既定）。
 *
 * **デーモン自身の入れ替えより長くしてある。** 短くすると、デーモンだけを再デプロイ
 * している間に runner が走行中のマネージャーを自分で畳んでしまう — それは
 * 「デーモンの都合で人の仕事を殺さない」の反対であり、既存の受け入れ基準
 * （デーモンだけが再起動したら、走っているマネージャーへ繋ぎ直す）を壊す。
 *
 * **代償は2つあり、長さはその間の選択である。**
 *
 * - **長すぎると**、経路だけが分かれたときに二重実行が起きうる窓がこの長さになる。
 *   器が古い器を殺す構成（Railway / compose）では `LEASE_DRAIN_MS` の側が先に効くので、
 *   この長さは「器が殺してくれなかった場合の上限」である
 * - **短すぎると**、連絡が切れただけで**走行中のターンが畳まれる**。畳むのは自己
 *   失効の側（`runner.ts` の `RunnerSession#selfFence`）で、生ログは畳む前に渡すので
 *   材料は残るが、**そのターンでやりかけていた手は止まる。** これは「連絡が切れた」
 *   という観測だけで仕事を止めるということなので、短くするほど「たまたま10秒繋がら
 *   なかった」で止まる方向へ寄る
 * **ここは能力の上限ではない**（north_star 禁止2 が禁じているのは仕事の回数・
 * ターン数の制限であって、二重実行を止めるための期限ではない）。
 */
export const LEASE_TTL_MS = 10 * 60_000;

/**
 * 期限に足す余裕。**時計とネットワークのぶれのぶんである。**
 *
 * 期限ちょうどで引き取ると、相手が自分で畳み終わる前に新しい方が動き出しうる
 * （畳むのにも時間がかかる）。ここを 0 にしないこと。
 */
export const LEASE_MARGIN_MS = 30_000;

/** いまその宛先に応えているプロセス（名簿の観測をそのまま渡す）。 */
export interface LeaseSighting {
  /** 台帳の鎖と同じ宛先の名前。 */
  runnerId: string;
  /**
   * いま応えているプロセスの識別子。**名乗らない runner では無い。**
   */
  instanceId?: string;
  /**
   * **そのプロセスを最初に見た時刻**（ミリ秒。デーモンの時計）。
   *
   * 「入れ替えを観測した時刻」ではなく「いまの相手を初めて見た時刻」である点が要る
   * — デーモンが再起動した直後は入れ替えの瞬間を知らないので、**自分が初めて見た
   * 時刻から猶予を数える**（知らない時刻を過去に見積もると、まだ畳まれていない器の
   * 仕事を奪いに行く）。
   */
  instanceSince?: number;
}

/** 引き取ってよいかの答え。**「分からない」を2値へ潰さない。** */
export type LeaseVerdict =
  /** 貸し出しの記録が無い。引き取ってよい（この欄より前に作られたジョブを含む）。 */
  | { kind: 'unheld' }
  /** いま応えているプロセスが持ち主。**奪う話ではなく繋ぎ直しである。** */
  | { kind: 'same-holder'; lease: JobLease }
  /** もう動いていないと言える。`because` はどちらの材料で言えたか。 */
  | { kind: 'expired'; because: 'drained' | 'ttl'; lease: JobLease }
  /** まだ握られている。`claimableAt` を過ぎるまで引き取らない。 */
  | { kind: 'held'; claimableAt: number; lease: JobLease }
  /**
   * 判定材料が無い（どちらかが `instanceId` を名乗らない）。
   *
   * **引き取ってよい**（名乗らない runner のジョブを永久に引き取れなくしないため）。
   * ただし「奪っていない」ことは言えていない。
   */
  | { kind: 'undecidable'; lease: JobLease };

/** 引き取り（または繋ぎ直し）に進んでよい判定か。 */
export function mayClaim(verdict: LeaseVerdict): boolean {
  return verdict.kind !== 'held';
}

/**
 * 貸し出しを見て、引き取ってよいかを答える。**時刻は呼び出し側から渡す**
 * （テストが時計を持てるようにするため。器の時計に依存した判定を書かない）。
 */
export function judgeLease(input: {
  lease: JobLease | undefined;
  now: number;
  answering: LeaseSighting;
}): LeaseVerdict {
  const { lease, now, answering } = input;
  if (lease === undefined) return { kind: 'unheld' };

  const seenAt = Date.parse(lease.seenAt);
  /*
   * **読めない時刻で断言しない。**
   *
   * 「まだ握られている」と言うと、直せる者が居ないままその委譲が永久に引き取れなく
   * なる（時刻を直せるのは書いた側だけである）。だから引き取りは許す。**ただし
   * `expired` とは言わない** — あれは「もう動いていないと言える」という主張で、
   * 読めない時刻からはその主張が出てこない。`undecidable` はどちらも満たす
   * （引き取りは許し、奪っていないとは言わない）。
   *
   * ここを `expired` にしていた版があり、`describeVerdict` が「自分で失効したと
   * 言える」と逐語で報告していた。**能力を1文字も落とさずに正直な形にできるのに、
   * 断言する側を選んでいた**（AGENTS.md 地雷表「判定できないことを判定できたように
   * 見せる」）。
   *
   * 実運用での到達性は低い（`jobLeaseSchema.seenAt` は `isoDateTime` を通り、
   * プロセス内の値は `grantLease` / `touchLease` の `toISOString()` しか作らない）が、
   * **到達性の低さは断言してよい理由ではない。**
   */
  if (Number.isNaN(seenAt)) return { kind: 'undecidable', lease };
  const ttlDeadline = seenAt + lease.ttlMs + LEASE_MARGIN_MS;

  // 台帳が別の宛先を指している。ここからはその宛先を観測できないので、言えるのは
  // 「相手が自分で畳むと約束した時刻を過ぎたか」だけである。
  if (lease.runnerId !== answering.runnerId) {
    return now >= ttlDeadline
      ? { kind: 'expired', because: 'ttl', lease }
      : { kind: 'held', claimableAt: ttlDeadline, lease };
  }

  // どちらかが名乗らない。**「入れ替わっていない」と読まないこと。**
  if (lease.instanceId === undefined || answering.instanceId === undefined) {
    return { kind: 'undecidable', lease };
  }

  if (lease.instanceId === answering.instanceId) return { kind: 'same-holder', lease };

  // 同じ宛先に別のプロセスが応えている。古い方は、器が畳んだか（`drained`）、
  // 自分で失効したか（`ttl`）のどちらか早い方で「もう動いていない」と言える。
  const drainDeadline = (answering.instanceSince ?? now) + LEASE_DRAIN_MS + LEASE_MARGIN_MS;
  if (now >= drainDeadline) return { kind: 'expired', because: 'drained', lease };
  if (now >= ttlDeadline) return { kind: 'expired', because: 'ttl', lease };
  return { kind: 'held', claimableAt: Math.min(drainDeadline, ttlDeadline), lease };
}

/**
 * 新しく貸し出す（または引き取って貸し直す）。**世代番号は必ず1つ進める。**
 *
 * 進めないと、引き取りの後に遅れて届いた古い命令を runner が見分けられない
 * （`fence` は runner 側で「これより古い命令は拒む」に使われる）。
 */
export function grantLease(input: {
  previous: JobLease | undefined;
  runnerId: string;
  instanceId?: string;
  now: number;
  ttlMs?: number;
}): JobLease {
  const at = new Date(input.now).toISOString();
  return {
    runnerId: input.runnerId,
    ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
    fence: (input.previous?.fence ?? 0) + 1,
    grantedAt: at,
    seenAt: at,
    ttlMs: input.ttlMs ?? LEASE_TTL_MS,
  };
}

/**
 * 生存を確かめた時刻を進める（世代は進めない）。
 *
 * **世代を進めないのが要点である。** 生存の確認は引き取りではないので、進めると
 * runner が持っている世代より新しい世代が台帳に載り、次の命令が拒まれる。
 */
export function touchLease(lease: JobLease, now: number): JobLease {
  return { ...lease, seenAt: new Date(now).toISOString() };
}

/**
 * 判定を人間とクローンへ出す1行にする。
 *
 * **「分からない」を「大丈夫」と書かない。** ここが要約になると、依頼者は
 * 「仕組みで塞げている」と読むしかなくなる（AGENTS.md「報告の形」）。
 */
export function describeVerdict(verdict: LeaseVerdict): string {
  switch (verdict.kind) {
    case 'unheld':
      return '貸し出しの記録が無い（この欄より前の委譲か、まだ貸し出していない）';
    case 'same-holder':
      return `いま応えているプロセスが持ち主である（instanceId=${verdict.lease.instanceId ?? '未名乗り'} / 世代=${verdict.lease.fence}）。奪ってはいない`;
    case 'expired':
      return verdict.because === 'drained'
        ? `持ち主のプロセスは器の入れ替えで畳まれている（畳む猶予を過ぎた。前の instanceId=${verdict.lease.instanceId ?? '未名乗り'}）`
        : `持ち主のプロセスは自分で失効したと言える（貸し出し期限 ${verdict.lease.ttlMs}ms を過ぎた。最後の生存確認=${verdict.lease.seenAt}）`;
    case 'held':
      return `まだ持ち主が握っている（instanceId=${verdict.lease.instanceId ?? '未名乗り'} / 引き取れるのは ${new Date(verdict.claimableAt).toISOString()} 以降）`;
    case 'undecidable':
      return `入れ替わったかを**判定できない**（どちらかが instanceId を名乗らない）。引き取るが、生きている器の仕事を奪っていないことは確かめられていない`;
  }
}
