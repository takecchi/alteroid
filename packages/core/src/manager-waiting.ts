import {
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH,
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE,
} from './classifier-denial-streak.js';
import { excerptLine } from './excerpt.js';
import { EXCHANGE_KIND_THINNING_PREFIX } from './exchange-kind.js';
import type { ManagerRecord } from './manager.js';
import { createRecentMap, type RecentMap } from './recent.js';
import type { RunnerEvent } from './runner-protocol.js';
import type { JournalEntryInput, TextMarkup } from './schema.js';

const ASKED_MEMORY_LIMIT = 512;

/**
 * `onForget` は最大 `ASKED_MEMORY_LIMIT` 件をまとめて渡しうるので、`ids.join(", ")` をそのまま繋ぐと
 * 件数に比例して伸びるのに上限も省略の合図も持たない列挙になる。
 * 兄弟の `REPORTED_FORGOTTEN_BUDGET` とは締め方が違う（こちらは文字数、あちらは件数）が、設計の判断ではない。
 */
const ASKED_FORGOTTEN_EXCERPT = 400;

/**
 * **この合図そのものには答える先が無い。** 答えられるのは、runner が分類器の拒否から別に上げる「この1回だけ許可しますか」の確認
 * （`requestId` は `tool_use_id` の `toolu_…`）だけで、それが届かない拒否（道具名や入力が取れない回・deny 規則）もある。
 * `manager_send` は `requestId` 無しの `decision` を、待ちがちょうど1件なら黙ってその1件へ当てる（`#choosePending`）。
 * 答え方を書かないと、同じマネージャーが別に待っている無関係の確認を許可してしまう。
 * 分類器の判定には触らず、既に在る口（確認への回答・追加指示）を指すだけにする。
 * Markdown の記号を散文に混ぜない（識別子だけをバッククォートで包む）。
 */
/** runner の `#onPermissionDenied` が上げる確認の書き出し。ここで見分けて、通常の許可確認にだけ答えたあとを足す。 */
const CLASSIFIER_DENIAL_ASK_HEAD = '分類器が ';

/**
 * 分類器の拒否の確認かどうか。書き出しだけでは見分けない: 拒否が続くと runner が連続の注記（`describeDenialStreakForClone`）を先頭に付け、書き出しが変わるため（#4945）。
 * 固定の段落（`DENIAL_ASK_AFTER_ANSWER_PARAGRAPH` と、一時規則を足せる Bash 用の `DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE`。#4905）のどちらかを含むかでも見る。書き出しの判定は、固定の段落を切り出す前の runner が組んだ待ち（再起動の引き取りで配り直す）のために残す。
 */
function isClassifierDenialAsk(summary: string): boolean {
  return (
    summary.startsWith(CLASSIFIER_DENIAL_ASK_HEAD) ||
    summary.includes(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH) ||
    summary.includes(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE)
  );
}

const PERMISSION_ASK_AFTER_ANSWER =
  '\n答えたあと: allow すれば、この呼び出しがそのまま通る（撃ち直しは要らない）。deny なら担い手へ拒否として返る。';

/**
 * 確認（`ask`）をクローンへ配る本文と描き方。届いたときと、再起動の引き取りで配り直すときの両方がここを通る。
 *
 * - `markup: 'none'` は `permission` のときだけ立てる: `summary` は道具の呼び出し引数の JSON ダンプで、バッククォートや `*` が入っていても Markdown ではなく、`<Markdown>` で描くと `<code>` に食われて字面から消える。
 *   `runner.ts` 側で包まない: `<Markdown>` で描くのは1面だけで、残り5面は素テキストなので記号が増える。`runner` が文面を Markdown に変えたら黙って外れるので `runner-permission-summary-markup.test.ts` が固定している。
 *   `question` でも立てない（モデルが書いた文章）。ただし `describeQuestions()` が `brief(input)` へ落ちた回は `kind` が同じ `'question'` のままで、この層には区別する材料が無く化けが残る。塞ぐなら `ask` イベントへ欄を足す（`runner-protocol.ts` の版ずれの窓が開く別作業）。
 * - 配る本文にだけ答えたあとを足す（待ちと日誌の `summary` は runner の文のまま）: 分類器の拒否の確認（`toolu_…`）とは答えたあとが違うのに、本文から見分けられないため。
 *   分類器の拒否の確認は runner が自分の本文で言っているので足さない。
 *
 * `Pool#redeliverWaitingAfterRestore` も使うので export する（定義はここに置く: `manager.ts` から値を import すると循環する）。
 */
export function askDeliveryOf(
  kind: 'question' | 'permission',
  summary: string,
): { text: string; markup: TextMarkup | undefined } {
  const markup: TextMarkup | undefined = kind === 'permission' ? 'none' : undefined;
  const text =
    kind === 'permission' && !isClassifierDenialAsk(summary)
      ? `${summary}${PERMISSION_ASK_AFTER_ANSWER}`
      : summary;
  return { text, markup };
}

/**
 * `Pool` が口として渡すもの。いずれも呼ぶたびに `Pool` の側で引く（時計・窓の積みは構築の後でも差し替わりうる）。
 * 関数の口は async の皮で包まずに渡す（`await` の数と順を変えないため）。
 */
interface ManagerWaitingReceiverPorts {
  /** `Pool#persist` を束ねたもの（第2引数は渡さない）。 */
  persist: (record: ManagerRecord) => Promise<void>;
  /** `Pool#journal`（記録できなくても投げない）。 */
  journal: (entry: JournalEntryInput) => Promise<void>;
  /** `Pool#journalExchange` を束ねたもの（呼び出しの形は `exchange-kind-coverage.test.ts` が数える）。 */
  journalExchange: (role: 'inbound' | 'outbound', text: string) => Promise<void>;
  /** `Pool#emit`（合成した知らせの窓を経由して受信箱へ積む。同期）。ここが渡すのは確認（`question` / `permission`）だけ。 */
  emit: (
    managerId: string,
    kind: 'question' | 'permission',
    text: string,
    requestId: string,
    markup: TextMarkup | undefined,
  ) => void;
  /** `Pool#nowIso` を束ねたもの（器の時計を直に読まない）。 */
  nowIso: () => string;
}

/**
 * 担当の出来事 `ask` / `settled` を受け取る側（`Pool#handleEvent` から切り出した。振る舞いは変えていない）。
 * 自前の欄は持たない: 待ちの列と「配り終えた id の記憶」は引数の `record`（`waiting`・`asked`）に書く。
 * `withdrawWaiting` / `dropUndeliveredWaiting`（5 箇所から呼ぶ共有）は `Pool` に残してある。
 */
export class ManagerWaitingReceiver {
  readonly #ports: ManagerWaitingReceiverPorts;
  readonly #journalExchange: ManagerWaitingReceiverPorts['journalExchange'];

  constructor(ports: ManagerWaitingReceiverPorts) {
    this.#ports = ports;
    this.#journalExchange = ports.journalExchange;
  }

  /** 担当の出来事 `ask` の1件を処理する（`Pool#handleEvent` が振り分ける）。 */
  async handleAsk(
    event: Extract<RunnerEvent, { type: 'ask' }>,
    record: ManagerRecord,
  ): Promise<void> {
    // 止めたマネージャーの確認要求を待ちへ積まない: `#retire()` 後も `#load()` が像を作り直すので、積むと `waiting` / `status` を `stopped` から動かしクローンへも `#emit()` してしまう。日誌には残す。
    if (record.job.status === 'stopped') {
      await this.#ports.journal({
        type: 'escalation',
        question: event.summary,
        approvalId: event.requestId,
        managerId: event.managerId,
      });
      return;
    }
    // `requestId` で冪等にする: 二度配ると、答えたはずの確認がクローンへもう一度届き、答えても runner 側は中断済みで「待っていない」と返る。
    const asked = this.askedOf(record);
    if (asked.has(event.requestId)) return;
    asked.set(event.requestId, true);

    record.waiting.push({
      requestId: event.requestId,
      summary: event.summary,
      kind: event.kind,
      // デーモン側で `new Date().toISOString()` を作らない: 値の意味が経路によって変わる。
      askedAt: event.askedAt,
    });
    // 終端を `waiting_human` で書き戻さない: 待つ間に `closed(failed / lost)` が書いていると、台帳が非終端へ戻り `lost` の引き取りの契機も消える。
    if (record.job.status !== 'failed' && record.job.status !== 'lost') {
      record.job.status = 'waiting_human';
    }
    await this.#ports.persist(record);
    await this.#ports.journal({
      type: 'escalation',
      question: event.summary,
      approvalId: event.requestId,
      managerId: event.managerId,
    });
    const delivered = askDeliveryOf(event.kind, event.summary);
    this.#ports.emit(
      event.managerId,
      event.kind,
      delivered.text,
      event.requestId,
      delivered.markup,
    );
    return;
  }

  /** 担当の出来事 `settled` の1件を処理する（`Pool#handleEvent` が振り分ける）。 */
  async handleSettled(
    event: Extract<RunnerEvent, { type: 'settled' }>,
    record: ManagerRecord,
  ): Promise<void> {
    // 外す前に `summary` を控える: `withdrawn` の journal に「何の確認だったか」を残すのに要る（`abort()` が既に空にしていれば拾えず、その旨も書く）。
    const pendingSummary = record.waiting.find(
      (item) => item.requestId === event.requestId,
    )?.summary;

    // 止めたマネージャーへの専用ガードを足さない: `abort()` が `waiting` も `[]` にするので `'waiting_human'` の条件が `'stopped'` から甦らせる余地を持たず、「外す」操作だけなので足しても観測できる差が無い。`withdrawn` の記録は止めた後でも残す。
    record.waiting = record.waiting.filter((item) => item.requestId !== event.requestId);
    if (record.job.status === 'waiting_human' && record.waiting.length === 0) {
      record.job.status = 'running';
    }
    await this.#ports.persist(record);

    // 新しい日誌の種別を作らず `escalation` を再利用する: `approvalId` は承認待ちキューの項目 id もマネージャーの確認の id も受ける欄で、`withdrawnAt` の形がそのまま使える。
    if (event.withdrawn !== undefined) {
      await this.#ports.journal({
        type: 'escalation',
        question: pendingSummary ?? '（不明 — 台帳の該当行が settled より先に消えていた）',
        approvalId: event.requestId,
        managerId: event.managerId,
        withdrawnAt: this.#ports.nowIso(),
        withdrawnReason:
          `この確認への答えは CLI へ届いていない（セッションを畳んだため）。` +
          `理由: ${event.withdrawn.reason}`,
      });
    }
    return;
  }

  // 上限で黙って忘れない: 忘れた id の `ask` の再送は新しい確認として再度回るので、日誌に跡が無いと理由を辿れない。
  askedOf(record: ManagerRecord): RecentMap<true> {
    const existing = record.asked;
    if (existing !== undefined) return existing;
    const managerId = record.job.id;
    const asked = createRecentMap<true>({
      limit: ASKED_MEMORY_LIMIT,
      onForget: (ids) => {
        void this.#journalExchange(
          'inbound',
          `${EXCHANGE_KIND_THINNING_PREFIX}[${managerId}] 配り終えた確認の記憶が上限（${ASKED_MEMORY_LIMIT}件）に達したので、` +
            `古い ${ids.length} 件を忘れた: ${excerptLine(ids.join(', '), ASKED_FORGOTTEN_EXCERPT)}。` +
            'この id の確認が再送されると、新しい確認としてもう一度回る。',
        );
      },
    });
    record.asked = asked;
    return asked;
  }
}
