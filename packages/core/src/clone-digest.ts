import type { CloneDistillMemoryState } from './clone-distill-memory-state.js';
import {
  buildActivityDigest,
  type DigestShape,
  type ManagerAwaitingBackgroundMap,
  type ManagerLiveness,
  TASK_QUEUE_SECTION_HEADING_HEAD,
} from './digest.js';
import { reasonOf } from './dropped-record.js';
import type { ManagerPool } from './manager.js';
import { describeMemorySessionDelta, measureMemoryFloor } from './memory.js';
import type { MemoryDocument } from './schema.js';
import type { Stores } from './store.js';
import { describeTaskQueueHead, TASK_QUEUE_HEAD_LIMIT } from './task-tools.js';

const RECENT_DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

const MEMORY_FLOOR_SESSION_GROWTH_LINE_PERCENT = 10;

function formatMemoryCharCountLocal(value: number): string {
  return value.toLocaleString('en-US');
}

function formatSignedMemoryCharCount(delta: number): string {
  return delta >= 0 ? `+${formatMemoryCharCountLocal(delta)}` : formatMemoryCharCountLocal(delta);
}

function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * `Clone` が協力者へ渡す口。
 * 構築の途中でこの協力者を作る（`#stores`・`#managers`・`#tokenSavingExcerpt` は constructor の中で入る）ので、値ではなく読む関数にする。
 */
export interface CloneDigestPorts {
  /** `Clone` の `#stores` */
  stores(): Stores;
  /** `Clone` の `#managers` */
  managers(): ManagerPool;
  /** `Clone` の `#tokenSavingExcerpt` */
  tokenSavingExcerpt(): boolean;
}

/**
 * 直近の状況の要約（digest）を組み立てる協力者。日誌は書かない（`#journal`・`#journalSelf` は呼ばない）。
 * 書く状態は `distillMemory.recordTick`（記憶の床の行が tick ごとの差分を控える）だけ。
 * メソッドは `Clone` の呼びと同じ段数で `await` される（呼び元で包み直さない）。
 */
export class CloneDigest {
  readonly #ports: CloneDigestPorts;
  readonly #distillMemory: CloneDistillMemoryState;

  constructor(ports: CloneDigestPorts, distillMemory: CloneDistillMemoryState) {
    this.#ports = ports;
    this.#distillMemory = distillMemory;
  }

  // `list()` が失敗しても digest を壊さず空の Map を返す: 全件 `/セッション不明` になり、黙って「繋がっている」に倒れないため
  // 2つの軸を別の `Map` にする: 1つに畳むと、`live` は取れたが握り潰しは無かった委譲と、何も取れなかった委譲が同じ「載っていない」になるため。`list()` を2回呼ばない: 軸の数だけ台帳を読むことになるため
  async axes(): Promise<{
    liveness: ManagerLiveness;
    awaitingBackground: ManagerAwaitingBackgroundMap;
  }> {
    try {
      const managers = await this.#ports.managers().list();
      return {
        liveness: new Map(managers.map((manager) => [manager.managerId, manager.live])),
        // 握り潰しが在る分だけを載せる: `Map` の側で「載っていない」と「`undefined` が載っている」が別の意味を持たないようにするため
        awaitingBackground: new Map(
          managers.flatMap((manager) =>
            manager.awaitingBackground === undefined
              ? []
              : [[manager.managerId, manager.awaitingBackground] as const],
          ),
        ),
      };
    } catch {
      return { liveness: new Map(), awaitingBackground: new Map() };
    }
  }

  async recent(): Promise<string> {
    return `${await this.#memoryFloorDigestLine()}\n\n${await this.bare()}`;
  }

  // 日報は「記憶の床」の1行を付けない: tick という区切りに数を出す仕組みで、日報はその区切りではないため
  async bare(shape: DigestShape = 'full'): Promise<string> {
    try {
      const axes = await this.axes();
      return await buildActivityDigest(
        this.#ports.stores(),
        { since: new Date(Date.now() - RECENT_DIGEST_WINDOW_MS) },
        axes.liveness,
        axes.awaitingBackground,
        { shape, trimHistory: this.#ports.tokenSavingExcerpt() },
      );
    } catch (error) {
      // 件数の形（定期の依頼の tick）は断り書き側が先頭を持つので足さない
      const head = shape === 'full' ? await this.taskQueueHeadAfterFailure() : '';
      return `（直近の状況をまとめられなかった: ${reasonOf(error)}）${head}`;
    }
  }

  /**
   * 要約が組めなかった回に、待ち行列の先頭だけを添える。
   * 発意・日報の tick は、要約が先頭を載せる前提で断り書き側の先頭を出さない（`tickDigestCarriesTaskQueueHead`）ので、要約が失敗するとどこにも載らなくなるため。
   * 読めなかったときは 0 件と書かず、読めなかったと名乗る。要約が組めた回は呼ばれず、入力は変わらない。
   */
  async taskQueueHeadAfterFailure(): Promise<string> {
    try {
      const taskList = await this.#ports.stores().tasks.list();
      return [
        '',
        '',
        TASK_QUEUE_SECTION_HEADING_HEAD,
        ...describeTaskQueueHead(taskList, { limit: TASK_QUEUE_HEAD_LIMIT, nowMs: Date.now() }),
      ].join('\n');
    } catch (error) {
      return `\n\n${TASK_QUEUE_SECTION_HEADING_HEAD}\n- 待ち行列を読めなかった（理由: ${reasonOf(error)}）。開いている仕事が 0 件だったのではない。読み直す手は \`task_list\` である。`;
    }
  }

  // #4938 の案2: 定期の依頼の tick は、要約の全体ではなく担当の節・継続中の依頼の節と、他の節の件数の行を付ける
  async recentCounts(): Promise<string> {
    return `${await this.#memoryFloorDigestLine()}\n\n${await this.bare('counts')}`;
  }

  // 書き込みを止める門にしない・畳むことを強制しない: 数を1行足すだけで、判断は常にクローンが下すため。
  // `injectedMemoryChars` が0（まだセッション未構築）のときは `null` を渡し線の判定も出さない: 0を基準に「n 文字増えた」と名乗らせないため。
  // 線の判定は表示と同じ丸め後の値で `>=` を使う: 読み手の語が「達した」であり、生の値や `>` だと表示と印が食い違うため。
  async #memoryFloorDigestLine(): Promise<string> {
    let documents: MemoryDocument[];
    try {
      documents = await this.#ports.stores().persona.documents();
    } catch (error) {
      return `記憶の床: 測れなかった（理由: ${reasonOf(error)}）。`;
    }

    const afterChars = measureMemoryFloor(documents).totalChars;
    const injectedMemoryChars = this.#distillMemory.promptMemoryChars;
    const sessionDelta = describeMemorySessionDelta({
      afterChars,
      injectedMemoryChars: injectedMemoryChars === 0 ? null : injectedMemoryChars,
    });

    const tickDiffNote =
      this.#distillMemory.lastTickMemoryFloorChars === null
        ? '前回の tick が無いので差分は出せない（このプロセスでの最初の tick）。'
        : `前回の tick から ${formatSignedMemoryCharCount(afterChars - this.#distillMemory.lastTickMemoryFloorChars)} 文字。`;

    const thresholdNote =
      injectedMemoryChars === 0
        ? '基準がまだ無いので線の判定は出せない。'
        : roundToOneDecimal(((afterChars - injectedMemoryChars) / injectedMemoryChars) * 100) >=
            MEMORY_FLOOR_SESSION_GROWTH_LINE_PERCENT
          ? `⚠️ 線（セッション構築時点から +${MEMORY_FLOOR_SESSION_GROWTH_LINE_PERCENT}%）に達している。`
          : '';

    const rebasedNote =
      this.#distillMemory.lastTickMemoryBaselineChars !== null &&
      this.#distillMemory.lastTickMemoryBaselineChars !== 0 &&
      injectedMemoryChars !== 0 &&
      this.#distillMemory.lastTickMemoryBaselineChars !== injectedMemoryChars
        ? `⚠️ セッションが組み直されて基準が ${formatMemoryCharCountLocal(this.#distillMemory.lastTickMemoryBaselineChars)} → ${formatMemoryCharCountLocal(injectedMemoryChars)} 文字へ取り直された（% が下がったのは畳んだからではない）。`
        : '';

    this.#distillMemory.recordTick(afterChars, injectedMemoryChars);

    return ['記憶の床:', sessionDelta, tickDiffNote, thresholdNote, rebasedNote]
      .filter((part) => part !== '')
      .join(' ');
  }
}
