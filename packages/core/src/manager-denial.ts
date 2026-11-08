import { shouldEscalateDenial } from './denial-escalation.js';
import {
  decodeDenialKey,
  DENIAL_REPLY_ROUTE,
  denialActorLayerOf,
  denialKey,
  denialReasonSnapshotOf,
} from './denial-key.js';
import { denialInputAbsence, denialInputShape } from './denial-shape.js';
import { EXCHANGE_KIND_DECISION_PREFIX, EXCHANGE_KIND_THINNING_PREFIX } from './exchange-kind.js';
import type { ManagerRecord } from './manager.js';
import { codeSpan } from './markdown-span.js';
import { createRecentMap, type RecentMap } from './recent.js';
import type { RunnerEvent } from './runner-protocol.js';

/** 道具の名前の種類なので、実際にはまず届かない（届いたら、それ自体が異常である）。 */
const DENIED_TOOL_LIMIT = 64;

/** `permission_denied` の日誌と知らせに載せる、拒否の詳細・入力の形・層の呼び名。 */
interface DenialTexts {
  denialSuffix: string;
  inputShape: string | undefined;
  inputText: string;
  actorLabel: string;
}

/**
 * `Pool` が口として渡すもの。いずれも呼ぶたびに `Pool` の側で引く（時計・窓の積みは構築の後でも差し替わりうる）。
 * 関数の口は async の皮で包まずに渡す（`await` の数と順を変えないため）。
 */
interface ManagerDenialReceiverPorts {
  /** `Pool#nowIso` を束ねたもの（器の時計を直に読まない）。 */
  nowIso: () => string;
  /** `Pool#journalExchange` を束ねたもの（呼び出しの形は `exchange-kind-coverage.test.ts` が数える）。 */
  journalExchange: (role: 'inbound' | 'outbound', text: string) => Promise<void>;
  /** `Pool#emit`（合成した知らせの窓を経由して受信箱へ積む。同期）。ここが渡すのは `report` だけ。 */
  emit: (managerId: string, kind: 'report', text: string) => void;
}

/**
 * 担当の出来事 `permission_denied` を受け取る側（`Pool#handleEvent` から切り出した。振る舞いは変えていない）。
 * 自前の欄は持たない: 数え上げは引数の `record`（`denied`・`deniedLastAt`・`deniedLastReason`・`deniedLastRequestId`）に書く。
 * 読み手は `DenialRenotifier`（`denial-renotify.ts`）・`Pool#denials`・`Pool#predatesLastDenialRenotify`。
 */
export class ManagerDenialReceiver {
  readonly #ports: ManagerDenialReceiverPorts;
  readonly #journalExchange: ManagerDenialReceiverPorts['journalExchange'];

  constructor(ports: ManagerDenialReceiverPorts) {
    this.#ports = ports;
    this.#journalExchange = ports.journalExchange;
  }

  /** 担当の出来事 `permission_denied` の1件を処理する（`Pool#handleEvent` が振り分ける）。 */
  async handle(
    event: Extract<RunnerEvent, { type: 'permission_denied' }>,
    record: ManagerRecord,
  ): Promise<void> {
    const { actorLayer, count, toolTotal } = this.#countDenial(record, event);
    const { denialSuffix, inputShape, inputText, actorLabel } = this.#denialTexts(
      event,
      actorLayer,
    );

    await this.#journalExchange(
      'inbound',
      `${EXCHANGE_KIND_DECISION_PREFIX}[${event.managerId}] ${event.tool} の実行が確認へ上がらずに止められた` +
        `（${actorLabel} / このマネージャーのこの組で ${count} 件目 / ` +
        `${event.via === 'live' ? '走行中の合図' : 'result の記録'}）: ` +
        `${inputText}${denialSuffix}`,
    );

    // 止めた委譲の拒否は受信箱へ回さない: クローンの判断材料にならず、`DENIED_ESCALATE_AT = 1` で1件目から `#emit` してしまう。日誌と数え上げは済んでいる。
    if (record.job.status === 'stopped') return;
    if (!shouldEscalateDenial(toolTotal)) return;
    this.#emitDenialNotice(event, actorLayer, toolTotal, {
      denialSuffix,
      inputShape,
      inputText,
      actorLabel,
    });
    return;
  }

  /** `permission_denied` の段1（同期）: 拒否を道具＋層の鍵で数え、記録を更新して件数を返す。 */
  #countDenial(
    record: ManagerRecord,
    event: Extract<RunnerEvent, { type: 'permission_denied' }>,
  ): { actorLayer: ReturnType<typeof denialActorLayerOf>; count: number; toolTotal: number } {
    // 日誌には全部残す: ここが無いと「静かになった」と「起きていない」が区別できない。受信箱へは繰り返しのときだけ（拒否は正常な運用でも起きるので、1件ずつ流すとクローンの判断が雑音で鈍る）。
    // 鍵は道具＋層: 層を分けないとマネージャー自身の拒否と作業者の拒否が同じ数へ畳まれる。`event.actor` が無い回は「取れていない」層として別枠で数え、マネージャー側へ黙って寄せない。
    const actorLayer = denialActorLayerOf(event.actor);
    const denied = this.#deniedOf(record);
    const key = denialKey(event.tool, actorLayer);
    const count = (denied.get(key) ?? 0) + 1;
    denied.set(key, count);
    (record.deniedLastAt ??= new Map()).set(key, this.#ports.nowIso());
    // この回に無ければ前回分を消す: 「最新1件」の像なので古い理由を持ち越さない。
    const reasonSnapshot = denialReasonSnapshotOf(event);
    if (reasonSnapshot === undefined) {
      record.deniedLastReason?.delete(key);
    } else {
      (record.deniedLastReason ??= new Map()).set(key, reasonSnapshot);
    }
    (record.deniedLastRequestId ??= new Map()).set(key, event.toolUseId);

    // escalation は layer 別ではなく道具ごとの合計で判定する: 層ごとだと頻度が下がりすぎてクローンに1件も上がらず「止まっていることが見える」を裏切る。合計は拒否1件ごとにちょうど1ずつ増えるので、`shouldEscalateDenial` の exact-equality（`step === count`）にそのまま渡せる。
    // 入力の中身ではなく道具の名前で束ねる: 1文字違う `Edit` を別物と数えると、同じファイルの編集が何度も拒否される形を取り逃す。
    const toolTotal = denied
      .entries()
      .reduce((sum, [k, v]) => (decodeDenialKey(k).tool === event.tool ? sum + v : sum), 0);
    return { actorLayer, count, toolTotal };
  }

  /** `permission_denied` の段2（同期）: 日誌と知らせに載せる拒否の詳細・入力の形・層の呼び名を作る。 */
  #denialTexts(
    event: Extract<RunnerEvent, { type: 'permission_denied' }>,
    actorLayer: ReturnType<typeof denialActorLayerOf>,
  ): DenialTexts {
    // 欠けているものは作り物を出さず、そのキーごと省く。
    const denialDetails = [
      event.reasonType === undefined ? undefined : `分類: ${event.reasonType}`,
      event.reason === undefined ? undefined : `理由: ${event.reason}`,
      event.message === undefined ? undefined : `モデルへの拒否文: ${event.message}`,
    ].filter((line): line is string => line !== undefined);
    const denialSuffix = denialDetails.length > 0 ? ` [${denialDetails.join(' / ')}]` : '';
    // 入力は値ではなく形だけ残す: 値に環境変数・トークン・URL 内の鍵が入りうる。それでも「何も分からない」へは戻さない（先頭の語・欄名・長さで良性の誤検知と拒否されるべきコマンドを分けられる）。
    // 「無い」の種類を潰さない: 空のコマンドと入力が届かない経路が同じ字面に見える。
    const inputShape = denialInputShape(event.input);
    const inputText = inputShape ?? denialInputAbsence(event.via);
    // `undefined`（取れていない）を「マネージャー」へ読み替えず、3値のまま言う。
    const actorLabel =
      actorLayer === 'manager'
        ? 'マネージャー自身'
        : actorLayer === 'worker'
          ? '作業者'
          : 'どちらの層か不明';
    return { denialSuffix, inputShape, inputText, actorLabel };
  }

  /** `permission_denied` の段3（同期）: 繰り返しの拒否をクローンへの知らせとして受信箱へ積む。 */
  #emitDenialNotice(
    event: Extract<RunnerEvent, { type: 'permission_denied' }>,
    actorLayer: ReturnType<typeof denialActorLayerOf>,
    toolTotal: number,
    { denialSuffix, inputShape, inputText, actorLabel }: DenialTexts,
  ): void {
    // 本文は Markdown で書いてあるので、Markdown ではない字面（入力の形・ツール名）は `codeSpan()` で包む: 形の欄名のアンダースコアが `<em>` になる。`markup` は立てられない（書き手が3人の1本の文字列）ので、混ざらないようにするだけ。
    // `denialSuffix` と入力が無い回の一文は包まない: 包むと等幅になり「文章」ではなく「コード」として描かれる。日誌も包まない（Markdown で描かれる面ではない）。
    // 層が取れているなら、その層だけを名指しする: 両論併記だとクローンが誤った相手へ指示しうる。取れていない回だけ両論を残し、分からないものを片方へ絞らない。
    const stuckWho =
      actorLayer === 'manager'
        ? 'マネージャー自身の手が止まっている可能性がある'
        : actorLayer === 'worker'
          ? '作業者の手が止まっている可能性がある'
          : 'マネージャーか作業者の手が止まっている可能性がある（どちらの層かはこの合図からは取れていない）';
    // 拒否の出所を断定しない: alteroid 自身の `PreToolUse` フック（`bash-wait-guard.ts` など）の拒否も同じ `case 'permission_denied'` を通り、帰結が違う（器の分類器 / deny 規則は担い手が本当に詰むが、フックは理由と代替案が担い手へ直接返り自力で抜けられる）。「クローンに回っていない」と決めつけず、まず担い手自身が受け取った拒否文を読ませる。
    this.#ports.emit(
      event.managerId,
      'report',
      `${codeSpan(event.tool)} の実行が確認へ上がらずに止められた（${actorLabel} / このマネージャーで ${toolTotal} 件目・道具ごとの合計）。` +
        'この合図だけでは拒否の出所は特定できない。**まず、担い手自身に返っている拒否の理由文を読ませること**。' +
        '(a) 器のモデル分類器か deny 規則がその場で拒否したのであれば、この確認はクローンには回ってきていない。' +
        '(b) alteroid 自身の `PreToolUse` フック（例: `bash-wait-guard.ts`）が拒否したのであれば、' +
        '理由と代替案は担い手へ直接返っているので、担い手はそれだけで自力で抜けられることがある。' +
        `${stuckWho}（(a) の場合）。` +
        `直近の入力の形: ${inputShape === undefined ? inputText : codeSpan(inputShape)}${denialSuffix}` +
        // 「先頭の語」は拒否の理由ではない（機械的に取った `command` の先頭の単語）が、形だけを見ると原因欄に読めるので、載っているときだけ断る。
        (inputShape !== undefined && inputShape.includes('先頭の語=')
          ? '（「先頭の語」は入力コマンドの先頭の単語であって、拒否の原因ではない）'
          : '') +
        // `inputHead` が欠ける回は作り物で埋めず「形」だけで案内する。出所（拒否の合図が運んだ値ではなく、同じ `tool_use_id` で `PreToolUse` フックが先に見た値）を明記して誤解させない。
        (event.inputHead === undefined
          ? ''
          : `\n拒否より前に見た入力の先頭（伏せ字・最大160字。この拒否の合図自体が` +
            `運んだ値ではなく、同じ tool_use_id で runner の \`PreToolUse\` フックが` +
            `拒否より前に見た値である）: ${codeSpan(event.inputHead)}`) +
        DENIAL_REPLY_ROUTE +
        '\n全件は日誌に残っている（`journal_read` で辿れる）。',
    );
  }

  // 上限で黙って忘れない: 忘れた道具の件数は 0 から数え直しになり、「何十回も止められている」形が受信箱に出るまでが伸びる。
  // `onForget` へ渡るのは生の鍵: journal の文面へ区切り文字を漏らさないよう `decodeDenialKey` で道具名へ戻す。
  #deniedOf(record: ManagerRecord): RecentMap<number> {
    const existing = record.denied;
    if (existing !== undefined) return existing;
    const managerId = record.job.id;
    const denied = createRecentMap<number>({
      limit: DENIED_TOOL_LIMIT,
      onForget: (keys) => {
        for (const key of keys) {
          record.deniedLastAt?.delete(key);
          record.deniedLastReason?.delete(key);
          // `deniedLastAt` と同じ鍵なので同時に消す。
          record.deniedRenotify?.delete(key);
          record.deniedLastRequestId?.delete(key);
          // `lastDenialRenotify` は単一値なので、忘れた鍵を指しているときだけ消す。
          if (record.lastDenialRenotify?.key === key) record.lastDenialRenotify = undefined;
        }
        const labels = keys.map((key) => {
          const { tool, actor } = decodeDenialKey(key);
          return actor === undefined ? tool : `${tool}（${actor}）`;
        });
        void this.#journalExchange(
          'inbound',
          `${EXCHANGE_KIND_THINNING_PREFIX}[${managerId}] 拒否の件数を覚えている道具×層の組が上限（${DENIED_TOOL_LIMIT}種）に` +
            `達したので、古い ${keys.length} 件を忘れた: ${labels.join(', ')}。` +
            'この組が次に止められたら 1 件目から数え直す（日誌には全件残っている）。',
        );
      },
    });
    record.denied = denied;
    return denied;
  }
}
