import { PanelLeft, Plus, Send, Square } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { Drawer } from '~/components/drawer';
import { Markdown } from '~/components/markdown';
import { Button, Card, Empty, ErrorNote, Spinner, Textarea } from '~/components/ui';
import { useEndConversation, useRecordOwnMessage } from '~/hooks/mutations';
import { useConversation, useConversations } from '~/hooks/queries';
import { useIsMobile } from '~/hooks/use-is-mobile';
import { useApi } from '~/lib/api';
import { cn } from '~/lib/cn';
import { formatRelative } from '~/lib/format';

import type { Route } from './+types/chat';

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return { conversationId: params.conversationId };
}

/**
 * 「最下部にいるか」の余裕（px）。**厳密一致（`scrollTop + clientHeight ===
 * scrollHeight`）は小数の丸めで成立しないことがある**ので余裕を持たせる。
 *
 * 32px にしたのは、この画面の行間・パディング（やりとりの `gap-3` = 12px、
 * 吹き出しの `py-2` など）を見て、1行ぶん未満の隙間であればブラウザの丸め・
 * サブピクセルのずれを吸収するのに足り、かつ「実質的にもう1行分スクロール
 * しないと最下部が見えない」ほど手前では反応しない値だと判断したため
 * （深い理由がある値ではない。広すぎると「読み返している」を誤って
 * 「最下部にいる」と判定し、狭すぎると丸め誤差で最下部にいるのに追従
 * しない、の両方に転びうる）。
 */
const BOTTOM_THRESHOLD_PX = 32;

/** 画面に出す1行。届いた順に並べる。 */
interface Line {
  key: string;
  role: 'human' | 'clone' | 'system';
  text: string;
  /** 進行中の合図（考え中・ツール実行中）。落ち着いたら消す。 */
  transient?: boolean;
  /**
   * **この行がどの会話のものか**（会話 id。まだ id が決まっていなければ `undefined`）。
   *
   * **画面に出すかどうかは、これといま見ている会話の一致だけで決まる**（下の
   * `ownedBy`）。**省略できない形にしてあるのは、行を作る場所を型に数えさせる
   * ためである** —— 足し忘れた行は「持ち主なし」として黙って混ざるのではなく、
   * ビルドで落ちる。
   *
   * **⚠️ 画面の中だけのものである。** サーバの応答にも、保存される形にも、
   * API の契約（`apps/daemon/openapi.json`）にも出ない。
   */
  of: string | undefined;
}

/**
 * **いま見ている会話のものだけを返す。**
 *
 * ⚠️ **これが「前の会話の中身を出さない」ことの本体である**（#437）。
 * 会話を切り替えたときに `lines` を捨てる処理（下の「人間が別の会話を選んだ
 * ときだけ状態を捨てる」）は残してあるが、**保証はそちらが持っていない** ——
 * 捨てた後に React が「切り替えより前に積まれていた更新」を基底の値から
 * 貼り直すと、前の会話の `lines` が丸ごと戻ってくることがあるからである
 * （実測: 60回中11回。既定の並列度の全スイートでも捕まえた。生の観測は #437）。
 * **戻ってきても持ち主が違うので、ここで落ちる。**
 *
 * **⚠️ そして、ここは何も壊さない（filter であって破壊ではない）。** これが
 * 2つ目の条件である —— React は**古い props で描き直す**ことがあり
 * （実測: `main` で40記録中7回、`routeId` が定義済みの後に `undefined` へ
 * 戻る描画が起きている）、その回に `lines` を壊す形にしていると、**人間が
 * 送ったばかりの発言ごと消える。** ここは選ぶだけなので、次の描画で戻る。
 */
export function ownedBy(lines: Line[], shownId: string | undefined): Line[] {
  return lines.filter((line) => line.of === shownId);
}

/**
 * **`lines` に保ち続けてよい行を、いま見ている会話・直前に見ていた会話・
 * まだ持ち主の決まっていない行に絞る**（issue #446）。
 *
 * ⚠️ **`ownedBy` と役目が違う。** `ownedBy` は「いま画面に出す」を決め、
 * こちらは「state（`lines`）に保ち続けてよいか」を決める。会話を何度も
 * 行き来すると `lines` が単調に増え続けたのが #446 の症状で、これは
 * その上限を「持ち主の集合」で切る側である。使い方は下の `ChatPane` の
 * 不変条件チェックを参照。
 *
 * **なぜ「いま」だけでなく「直前」も残すか。** 会話を切り替える処理
 * （下の `routeId !== lastRouteId` のブロック）は、`shownId` を進めるのと
 * **同じ render で** `previousShownId` も進める。だから React が
 * 「切り替えの直前まで積まれていた更新」を古い基底から貼り直しても
 * （#437 の実測: 60回中11回）、貼り直された回でも `shownId`／
 * `previousShownId` の組は直前の会話をまだ憶えている。**もし直前を
 * 落として「いま」だけで刈ると、貼り直しで `shownId` が一瞬古い値へ
 * 戻る回（`main` で40記録中7回観測）に「いま見ている会話」そのものが
 * 入れ替わり、その回の刈りが本物の行まで落としてしまう** — #437 の
 * 回帰テスト「古い routeId で描き直されても、送った発言も届いた本文も
 * 消えない」が守っているのはまさにこの経路である。
 *
 * **なぜ `of === undefined` を残すか。** 新しい会話では、送った発言の
 * ほうが会話 id より先に画面へ乗る（`open` が届いて `of` を付け直すまでの
 * 窓。下の「まだ持ち主の無い行に、決まった id を付け直す」参照）。ここを
 * 落とすと、送ったばかりの発言が消える — #437 で実際に踏んだ形そのもの
 * である。
 *
 * **同じ会話へ戻って続けた分の手元の写しは、ここでは刈らない。** 上限は
 * 「見ている会話の数」であって「行の古さ」ではないので、同じ2つの会話を
 * 何度往復しても手元の写しは増え続けうる（issue #446 の筋書き2）。
 * 刈るには「サーバの履歴が既にその行を引き取ったか」を見るしかないが、
 * それは履歴の再取得がまだ空を返している窓で、届いたばかりの行を画面
 * から消す形になる — 別の失敗を持ち込むので、今回は入れない。
 */
export function retainedBy(
  lines: Line[],
  shownId: string | undefined,
  previousShownId: string | undefined,
): Line[] {
  return lines.filter(
    (line) => line.of === undefined || line.of === shownId || line.of === previousShownId,
  );
}

export default function Chat({ loaderData }: Route.ComponentProps) {
  const { conversationId } = loaderData;

  /*
   * 狭い画面では会話一覧も畳む。**shell の nav と2枚重なると本文が残らない** —
   * 幅 375px で nav 208px ＋ 会話一覧 256px なので、そのままでは足りない。
   */
  const isMobile = useIsMobile();
  const [listOpen, setListOpen] = useState(false);
  const closeList = () => setListOpen(false);

  return (
    /*
     * **`h-dvh` ではなく `h-full`。** 高さの出どころは shell（`AuthedShell`）の
     * `h-dvh` 1つにまとめてある。ここでも viewport を取ると、狭い画面で上端に
     * 出す帯のぶんだけ画面からはみ出す（帯は shell が持っていて、この部品からは
     * 見えない）。
     */
    <div className="flex h-full">
      {isMobile ? (
        <Drawer open={listOpen} onClose={closeList} label="会話一覧">
          <ConversationList activeId={conversationId} onNavigate={closeList} />
        </Drawer>
      ) : (
        <ConversationList activeId={conversationId} />
      )}
      {/*
        **`key` を付けてはいけない。** 新しい会話は受信の途中（`open`）で id が決まり、
        URL をそこへ揃える。`key={conversationId}` にすると、その同期で作り直しが起きて
        受信中のストリームが中断され、続く text / done が画面に出ない。
        会話の切り替えは ChatPane が自分で見分ける。
      */}
      <ChatPane
        routeId={conversationId}
        onOpenList={isMobile ? () => setListOpen(true) : undefined}
      />
    </div>
  );
}

/**
 * 会話の一覧。
 *
 * **広い画面では脇に、狭い画面ではドロワーの中に、同じものを置く**（`shell.tsx`
 * の `Nav` と同じ形）。別々に書くと、一覧に何か足したときに片方だけ増える。
 */
function ConversationList({
  activeId,
  onNavigate,
}: {
  activeId: string | undefined;
  /**
   * 行き先を押したとき。ドロワーの中では閉じる。
   *
   * **`useEffect` で URL の変化を見る形にしていない。** いま開いている会話を
   * もう一度押すと URL が変わらず、覆ったまま残る。
   */
  onNavigate?: (() => void) | undefined;
}) {
  const { data, error, isLoading } = useConversations(30);

  return (
    <aside
      className={cn(
        'flex flex-col bg-surface',
        // ドロワーの中では枠と幅は Drawer 側が持っている。
        onNavigate === undefined ? 'w-64 shrink-0 border-r border-border' : 'min-h-0 flex-1',
      )}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-3">
        <span className="text-sm font-semibold">会話</span>
        <Link to="/chat" onClick={onNavigate}>
          <Button size="sm" variant="ghost" aria-label="新しい会話">
            <Plus className="size-4" aria-hidden />
          </Button>
        </Link>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <ErrorNote error={error} className="m-3" />
        {isLoading ? (
          <Spinner />
        ) : data === undefined || data.conversations.length === 0 ? (
          <Empty>まだ会話がない。</Empty>
        ) : (
          <ul aria-label="会話">
            {data.conversations.map((conversation) => (
              <li key={conversation.conversationId}>
                <Link
                  to={`/chat/${conversation.conversationId}`}
                  onClick={onNavigate}
                  className={cn(
                    'block border-b border-border px-3 py-2 hover:bg-surface-2',
                    conversation.conversationId === activeId && 'bg-surface-2',
                  )}
                >
                  {/* 一覧の1行は Markdown 化の対象外（`components/markdown.tsx` の doc） */}
                  <p className="truncate text-xs">{conversation.preview}</p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    {formatRelative(conversation.updatedAt)} · {conversation.messages} 往復
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/*
        `scanned` は「人間との往復をどこまで遡ったか」（マネージャーとの往復・
        内部ターンは数えない。issue #418）。全部を見たとは限らないので、
        黙って切らずに出す（掘れば降りられる、が要件）。
      */}
      {data !== undefined && (
        <p className="border-t border-border px-3 py-2 text-[11px] text-muted">
          人間との往復 {data.scanned} 件を走査
        </p>
      )}
      {/*
        **窓（`scan`）が日誌の先頭に届いていないことを言う。** 下の `ChatPane`
        の「先頭には届いていない」と同じ作法 — `reachedStart` が真のときは
        出さない（窓が先頭に届いているなら、そこに但し書きを出すと「常に
        出ているもの」になって情報でなくなる）。
      */}
      {data?.reachedStart === false && (
        <p className="border-t border-border px-3 py-2 text-[11px] text-muted">
          {`人間との往復を ${data.scanned} 件遡ったが、先頭には届いていない。これより古いやりとりが残っている可能性がある。`}
        </p>
      )}
      {/*
        **窓の中で `limit` に収まらず落とした会話があることを言う（#418 の
        裏返し）。** #418 は「他の種別に食われる」窓、こちらは「自分の種別で
        溢れる」窓 — 人間との会話は増え続けるので、時間が経てば必ず踏む。
        語彙はクローンの道具（`tools.ts` の「…ほか N 件は省略」）に寄せる。
        `reachedStart` とは別の条件なので、両方出ることも片方だけのこともある。
      */}
      {data !== undefined && data.hiddenByLimit > 0 && (
        <p className="border-t border-border px-3 py-2 text-[11px] text-muted">
          {`…ほか ${data.hiddenByLimit} 件は省略（この窓に ${data.conversations.length + data.hiddenByLimit} 件あり、新しい順に ${data.conversations.length} 件だけ出した）。`}
        </p>
      )}
    </aside>
  );
}

/**
 * 走っているストリーム1本ぶん。
 *
 * `opened` を持つのは**追送**（受信中に続けて打った発言）のためである。追送は
 * 自分では購読を張らず、走っているこのストリームへ応答を流させるので、投函先の
 * 会話 id が要る。新しい会話では id が `open` まで決まらないので、約束として持つ。
 */
interface Stream {
  controller: AbortController;
  /** このストリームが**どの会話のものか**。`open` で確定したらここも移す。 */
  id: string | undefined;
  /** 会話 id が確定したら解決する。確定しないまま終わったら reject する。 */
  opened: Promise<string>;
  settleOpen: (conversationId: string) => void;
  failOpen: (reason: unknown) => void;
}

function createStream(controller: AbortController, id: string | undefined): Stream {
  let settleOpen: (conversationId: string) => void = () => {};
  let failOpen: (reason: unknown) => void = () => {};
  const opened = new Promise<string>((resolve, reject) => {
    settleOpen = resolve;
    failOpen = reject;
  });
  /*
   * **読み手が居なくても reject する約束なので、ここで受けておく。** 追送が
   * 一度も無ければ `opened` を待つ者は居ないが、ストリームが `open` を見ないまま
   * 終われば下の `failOpen` は呼ばれる。受け手の無い reject は unhandled rejection
   * になり、テストでは実行そのものを落とす。
   */
  opened.catch(() => {});
  const stream: Stream = { controller, id, opened, settleOpen, failOpen };
  // 既存の会話なら id は最初から分かっている。追送を `open` まで待たせない。
  if (id !== undefined) settleOpen(id);
  return stream;
}

/** 会話1つ分の画面。**作り直しに弱いので**、回帰テストから直接組み立てられるようにしてある。 */
export function ChatPane({
  routeId,
  onOpenList,
}: {
  routeId: string | undefined;
  /** 会話一覧を開く口。狭い画面でドロワーに畳んだときだけ渡ってくる。 */
  onOpenList?: (() => void) | undefined;
}) {
  const api = useApi();
  const navigate = useNavigate();
  const endConversation = useEndConversation();
  const recordOwnMessage = useRecordOwnMessage();

  /**
   * この画面が見せている会話。
   *
   * 新しい会話の id は受信の途中（`open`）で決まるので、**URL より先にここが決まる**。
   * URL は後から追いつく。逆にすると、追いついた瞬間が「別の会話に変わった」と
   * 区別できなくなる。
   */
  const [shownId, setShownId] = useState(routeId);
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  /** スクロールする器そのもの。「最下部にいるか」を見るのに要る（#247 の 1）。 */
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  /**
   * 直近に分かっている「最下部にいるか」。
   *
   * 効果（下の `useEffect`）はこの値だけを見て追従するかを決める — 効果が
   * 走る時点では新しい行が既に描かれた後で、器の `scrollHeight` はもう
   * 伸びているので、そこで測っても「新しい行が来る前にどこにいたか」は
   * 分からない。だから測定は `onScroll` 側（ユーザーの操作、および自分で
   * 呼んだ `scrollIntoView` が発火させる `scroll` イベント）で行い、ここへ
   * 持ち越す。既定は `true`（＝初回描画は最下部から始まる。旧来どおり）。
   */
  const isAtBottomRef = useRef(true);
  /**
   * 直前の `setLines` が自分の発言を積んだものかどうか。
   *
   * 自分が送った直後は遡って読んでいる最中ではない（入力欄を使うのに画面を
   * 触っているので、読み返しの途中ではなく会話に参加しようとしている）。
   * だから最下部にいなくても、送った直後だけは追従してよいと判断した。
   */
  const justSentOwnLineRef = useRef(false);
  /**
   * 追従の効果が直前に見た `shownId`。
   *
   * **`isAtBottomRef` は `ChatPane` が生きているあいだ値を保つ ref であり、
   * `ChatPane` は会話を切り替えても作り直されない**（`key` を付けない理由は
   * 上のコメントのとおり、受信中のストリームを切らないためである）。つまり
   * 会話 A で上へ遡って `isAtBottomRef.current` が `false` になったあと、
   * 会話 B へ移っても ref はそのまま `false` を持ち越す — 直さなければ、
   * 開いたばかりの会話 B が最下部から始まらない。
   *
   * **他の効果（`shownId` を見て前の会話のストリームを止める効果）の宣言順に
   * 依存させない。** 会話の切り替わりをこの効果自身の中で見分けることで、
   * 同じコミットでどちらの効果が先に走っても結果が変わらないようにしてある。
   */
  const lastSeenShownIdRef = useRef(shownId);

  /** 走っているストリーム。無ければ `undefined`。 */
  const streamRef = useRef<Stream | undefined>(undefined);
  /**
   * いま見えている会話を、受信の途中からも読めるようにしたもの。
   *
   * ストリームの後片付けは「**この結果を今の画面へ書いてよいか**」で決まるが、
   * 判断する時点は非同期の奥なので、閉じ込めた `shownId` は古くなっている。
   */
  const shownIdRef = useRef(shownId);

  /**
   * 直前に見ていた会話。`retainedBy`（上）が「いま」に加えて残す2つ目の持ち主。
   *
   * **`shownId` を進めるのと同じ、この下のブロックでだけ更新する。**
   * `open`（新しい会話の id が決まるところ）では触らない — 触る箇所を
   * 増やすほど #437 の再発面が広がる。この結果、保つ持ち主は「いま」
   * 「直前」に加えて `of === undefined`（まだ id の付いていない、送った
   * ばかりの発言）を合わせて一時的に3つになることがあるが、それ以上には
   * 増えない（このブロックが走るたびに1つ前の `shownId` で上書きされる
   * だけで、積み上がらない）。
   */
  const [previousShownId, setPreviousShownId] = useState<string | undefined>(undefined);
  /**
   * 人間が別の会話を選んだときだけ状態を捨てる。
   *
   * **見るのは「URL が変わったか」であって「shownId と一致するか」ではない。**
   * `open` で id を決めてから URL が追いつくまでのあいだ、shownId は URL より
   * 先へ進んでいる。そこで一致だけを見ると、その隙間を「別の会話へ移った」と
   * 誤って読み、送ったばかりの発言ごと消してしまう。
   *
   * （React の「props が変わったら state を調整する」パターン。effect でやると
   * 一度古い内容を描いてから消すことになる。）
   */
  const [lastRouteId, setLastRouteId] = useState(routeId);
  if (routeId !== lastRouteId) {
    setLastRouteId(routeId);
    // URL が自分の採番に追いついただけなら、捨てるものは何も無い。
    if (routeId !== shownId) {
      setPreviousShownId(shownId);
      setShownId(routeId);
      /*
       * **この `setLines([])` は、下の `owns()`/`stopped()`（`writable()` の
       * 中身）と同じ役目の二重書きではない。守っている失敗が違う。**
       *
       * - **ここ（render 時の同期リセット）** — 会話を切り替えた**瞬間**に、
       *   前の会話の `lines`（自分の発言・受信中の合図・進行中の transient
       *   な行）を消す。ストリームが動いているかどうかとは無関係——
       *   ただ会話を切り替えただけで、静的にでも古い内容が新しい会話の
       *   画面に残るのを防ぐのはこちらの役目。
       * - **`owns()`/`stopped()`（`writable()`。この下の `send()` 参照）** —
       *   切り替えた**後**に、前の会話のストリームがなおも `setLines(...)`
       *   を呼ぼうとするのを止める。**動いているストリームがあって初めて
       *   意味を持つ**、上とは別の失敗を防いでいる。
       *
       * `git log -S` で確かめた限り、この3つ（この `setLines([])` /
       * `owns()` / `stopped()`）は同じ初期コミット（`04c1049`、#27）で
       * 同時に入った——「後から別の障害を踏んで1枚ずつ足した」歴史ではない。
       * それでも上のとおり守備範囲は最初から別である。
       *
       * **ただし変異試験（#363）は、この2つが実際には独立して働いていない
       * ことを見つけている。** 詳しい構造は下の `owns()`/`stopped()` の
       * doc（`writable()` の直前）にまとめてある。
       */
      /*
       * **⚠️ ここで `lines` を捨てない（#437 で外した）。**
       *
       * 前は `setLines([])` が在った。外したのは、**この判定が「一度きりの
       * edge」だからである** —— `routeId !== lastRouteId` は切り替わった瞬間に
       * 1回しか真にならないので、その1回の結果が失われると二度と走らない。
       * そして実測（#437）で、失われる経路が2つあることが分かっている:
       *
       * - **貼り直しで無かったことにされる** — 切り替えより前に積まれていた
       *   `lines` の更新が、捨てた後に基底の値から再適用される（60回中11回）
       * - **古い props で描き直された回に誤って当たる** — React は `routeId` が
       *   確定した後でも、古い基底から描き直すことがある（`main` で40記録中
       *   7回観測）。そこで破壊すると、**人間が送ったばかりの発言ごと消える**
       *
       * **⟹ 前の会話の中身を出さないことは `ownedBy`（持ち主で絞る）が持つ。**
       * あちらは選ぶだけで何も壊さないので、どちらの経路でも結果が変わらない。
       *
       * **`setFailure(undefined)` は残す。** 失敗の表示は次の送信で立て直せる
       * （消えても情報が失われない）ので、`lines` とは事情が違う。
       *
       * **`lines` 自体が増え続けないことは、下の不変条件チェック（`retainedBy`）
       * が別に持つ（#446）。** ここは「出す/出さない」だけで「保つ/捨てる」を
       * 持たないので、会話を行き来するたびに手元へ積まれた行そのものは、
       * この render リセットだけでは減らない。
       */
      setFailure(undefined);
    }
  }

  /**
   * **不変条件として毎 render 確かめる（issue #446。#440 の指摘への直接の答え）。**
   *
   * #440 は「一度きりの edge を印で見分けて、当たったら破壊する形は、React の
   * 貼り直しに対して成立しない」と指摘していた——直上の旧 `setLines([])` が
   * #437 でまさにこの形で壊れている。ここは逆に、**毎 render で `retainedBy`
   * の結果と現在の `lines` を比べるだけ**にしてある。貼り直しで前の会話の
   * 行が戻ってきても、次の render でまた同じ比較を通るので自己修復する——
   * 一度きりの `setLines([])` との決定的な違いはここにある。
   *
   * **刈っても、その render で画面に出せる行は1つも減らない。** `ownedBy`
   * が出すのは `of === shownId` の行だけで、`retainedBy` はそれに加えて
   * `previousShownId` と `undefined` の行を残すので、刈った後の集合は常に
   * `ownedBy` の出力を（部分集合として）含む。
   *
   * `previous` をそのまま返す分岐は、`retainedBy` が何も落とさなかった
   * render で `setLines` を無意味に呼んで再描画を増やさないためのもの
   * （長さが変わらない＝何も落ちていない、で判定する）。
   */
  if (retainedBy(lines, shownId, previousShownId).length !== lines.length) {
    setLines((previous) => {
      const next = retainedBy(previous, shownId, previousShownId);
      return next.length === previous.length ? previous : next;
    });
  }

  /*
   * **この画面で始めた会話でも履歴を読む（#92 で変えた）。**
   *
   * 直す前は `startedHere` を立てて `useConversation(null)` にしていた
   * （手元の `lines` が全文だから重ねると二重に出る、という理由）。だがそれは
   * 「サーバ側で後から進んだぶんを、この画面は永久に受け取らない」ことでもあった。
   * 枠（利用上限）で保持された発言は、枠が開いてから再試行されて返信が日誌へ載る
   * — その返信は `use-journal-live.ts` の無効化を経てここへ届くはずだったが、
   * **購読していない画面には無効化が効かない。** 同じタブに居続ける限り、遅れた
   * 返信は出ないままだった（人間の「あとで良いのでちゃんと返信してほしい」が
   * 満たされていなかった経路がここである）。
   *
   * 二重描画は購読をやめることではなく、下の `all` の重ね合わせで防ぐ。
   */
  const history = useConversation(shownId ?? null);

  // 履歴（日誌から再構成されたもの）＋この画面で流れてきた分。
  const historyLines = useMemo<Line[]>(
    () =>
      (history.data?.messages ?? []).map((message) => ({
        key: message.id,
        role: message.role === 'inbound' ? 'human' : 'clone',
        text: message.text,
        of: shownId,
      })),
    [history.data, shownId],
  );

  /*
   * 履歴（サーバが日誌から再構成したもの）と、この画面で流れてきた分を重ねる。
   *
   * **同じやりとりが両側に載る。** 人間の発言は受理した時点で日誌へ載り
   * （`clone.ts` の `#record`）、クローンの返信もターンの終わりに載る。一方この
   * 画面は送った発言と届いた本文を手元の `lines` にも積んでいるので、履歴を
   * 読み直した瞬間に同じものが2つになる。だから**重ねる時に消す。**
   *
   * 突き合わせるのは `role` と本文の組で、**同じ本文が複数あっても1件ずつしか
   * 消さない**（多重集合の照合）。「ok」を2回送ったのに履歴側が1件しか返して
   * いないなら、手元の2件目は残す — 集合として引くと、繰り返した発言が黙って
   * 1件に潰れる。
   *
   * **id では突き合わせられない。** 履歴側の `key` は日誌の id、手元は
   * `h-<index>-…` / `c-<時刻>` で、同じやりとりに同じ id が付く経路が無い
   * （手元で採番した時点ではサーバの id を知らない）。
   *
   * 進行中の合図（`transient`）と `system` の行は履歴に相当するものが無いので
   * そのまま残る（`role` が一致しないので照合の対象にならない）。
   *
   * **区切りの NUL は `\u0000` のエスケープで書く。生の NUL 文字をソースへ
   * 置かないこと。** 本文に現れない区切りが要るのは正しいが、生のまま置くと
   * その1バイトで grep / ripgrep がこのファイルを「バイナリ」と判定して丸ごと
   * 飛ばす — `chat.tsx` が検索結果から静かに消え、「その実装は無い」と読める
   * 状態になっていた（実際に一度そう読みかけた）。
   */
  const all = useMemo(() => {
    const remaining = new Map<string, number>();
    for (const line of historyLines) {
      const key = `${line.role}\u0000${line.text}`;
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    const pending: Line[] = [];
    for (const line of ownedBy(lines, shownId)) {
      const key = `${line.role}\u0000${line.text}`;
      const count = remaining.get(key) ?? 0;
      // 履歴側に同じものがある＝サーバが既に持っているやりとりなので、手元の
      // 写しは落とす（履歴側の並び順の方が正しい。日誌の時刻で並んでいる）。
      if (count > 0) {
        remaining.set(key, count - 1);
        continue;
      }
      pending.push(line);
    }
    return [...historyLines, ...pending];
  }, [historyLines, lines, shownId]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (el === null) return;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX;
  }, []);

  useEffect(() => {
    // **会話を切り替えたら、前の会話でどこを読んでいたかは持ち越さない。**
    // `lastSeenShownIdRef` と `shownId` が違えば「今回の実行で会話が変わった」
    // と分かる（他の効果の実行順には依存しない、この効果だけで完結する判定）。
    // 新しい会話は常に最下部から始まる（初回描画と同じ扱いにする）。
    if (lastSeenShownIdRef.current !== shownId) {
      lastSeenShownIdRef.current = shownId;
      isAtBottomRef.current = true;
    }
    if (isAtBottomRef.current || justSentOwnLineRef.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
      // `scrollIntoView` が発火させる `scroll` イベント（延いては上の
      // `handleScroll`）を待たずに確定させる。ストリーミングでチャンクが
      // 立て続けに届くと、イベントが次の効果の実行に間に合わないことがある。
      isAtBottomRef.current = true;
    }
    justSentOwnLineRef.current = false;
  }, [all.length, lines, shownId]);

  /**
   * 別の会話へ移ったら、**前の会話の**ストリームだけを止める。
   *
   * `open` で自分が採番した id へ同期したときは、ストリームの所属も同時に
   * その id へ移してあるので、ここは何もしない（止めると、続く text / done が
   * 画面に出ないまま会話が終わったように見える）。
   *
   * **`shownIdRef.current` の更新と `abort()` は、この1つの効果の中で
   * 同じ同期実行の中にある。** これが下の `owns()`/`stopped()` の関係を
   * 決めている——`owns()` は `shownIdRef.current` を、`stopped()` は
   * `controller.signal.aborted` を見るが、**この効果が走った後は、両方が
   * 同時に切り替わる。** `owns()` が「別の会話へ移った」と言えるようになる
   * 瞬間には、`stopped()` も既に「止まった」と言えるようになっている
   * （順序ではなく同一関数呼び出しの中での事実）。**`owns()` だけを壊しても
   * `stopped()` が代わりに `writable()` を締める、が起きる構造的な理由は
   * ここにある。**
   *
   * 加えて、この効果は React の受動的 effect なので **render の commit より
   * 後に走る**。commit そのもの（`routeId` の変化を見て `setLines([])` を
   * 呼ぶ、上の「捨てる」ブロック）と、この効果が走るまでの短い窓では
   * `shownIdRef.current`・`controller.signal.aborted` のどちらも**まだ
   * 古い値のまま**である。詳細と実測は下の `owns()`/`stopped()` の doc。
   */
  useEffect(() => {
    shownIdRef.current = shownId;
    const stream = streamRef.current;
    if (stream !== undefined && stream.id !== shownId) stream.controller.abort();
  }, [shownId]);

  // 画面を離れたら読むのをやめる（クローンのターンは止まらない。購読を外すだけ）。
  useEffect(() => () => streamRef.current?.controller.abort(), []);

  /** 打った本文を画面へ積む。送信の入口が2つ（新規・追送）あるので1本にしてある。 */
  const showOwnLine = useCallback((text: string) => {
    // 最下部にいなくても、送った直後だけは追従してよい（上の
    // `justSentOwnLineRef` のコメント参照）。
    justSentOwnLineRef.current = true;
    setLines((previous) => [
      ...previous,
      {
        key: `h-${previous.length}-${text.slice(0, 8)}`,
        role: 'human',
        text,
        of: shownIdRef.current,
      },
    ]);
  }, []);

  /**
   * **受信中に続けて打った発言を、購読を張らずに投函だけする。**
   *
   * ここが無いと、人間は返事が返るまで次を打てない（入力欄を閉じるしかない）。
   * だが**サーバは、順番待ちのあいだに積み上がった同じ会話の発言を1ターンに
   * まとめて読む**（`packages/core/src/clone.ts` の `#mergedHumanBatch` /
   * `humanTurnText`）。人間が Claude Code に立て続けに3行打ったときと同じ振る舞い
   * がサーバ側には既にあり、**それを引き出せないのは画面の側の都合だけ**だった。
   *
   * **2本目の SSE を張らないのが要点である。** `POST /chat` は投函と購読が一体で、
   * 購読は会話単位（`clone.subscribe`）なので、2本張ると同じ応答が両方に流れて
   * 画面に二度出る。かといって走っている方を止めて張り替えると、止めてから
   * 繋がるまでの隙間に届いた分を取りこぼす。**だから追送は `open` を見た時点で
   * 接続を捨てる** — サーバは `open` を書く前に受信箱へ積んでいる（`app.ts` の
   * `POST /chat`。この順序はあちらのコメントが理由ごと持っている）ので、
   * `open` が届いた＝投函は済んだ、と言い切れる。応答は走っている方に流れてくる。
   */
  const followUp = useCallback(
    async (text: string, running: Stream) => {
      setFailure(undefined);
      setDraft('');
      showOwnLine(text);

      try {
        // 新しい会話は `open` まで id が決まらない。決まるまで待ってから投函する
        // （id 無しで送ると、続きのつもりの発言が別の会話として立つ）。
        const conversationId = await running.opened;
        const controller = new AbortController();
        try {
          for await (const message of api.chat(
            { text, conversationId },
            {
              signal: controller.signal,
            },
          )) {
            if (message.event === 'open') break;
          }
        } finally {
          // `break` でも generator は畳まれるが、本文の読み取りを確実に閉じる。
          controller.abort();
        }
        recordOwnMessage(conversationId, text);
      } catch (caught) {
        setFailure(caught);
      }
    },
    [api, recordOwnMessage, showOwnLine],
  );

  const send = useCallback(
    async (text: string) => {
      if (text.trim() === '') return;

      /*
       * **走っているストリームがあるなら、張り替えずに投函だけする。**
       * `sending` で弾いていた頃は、ここが「返事が返るまで次を打てない」の実体
       * だった（`followUp` の doc に理由）。
       */
      const running = streamRef.current;
      if (running !== undefined) {
        await followUp(text, running);
        return;
      }

      const controller = new AbortController();
      const stream = createStream(controller, shownId);
      streamRef.current = stream;
      setSending(true);
      setFailure(undefined);
      setDraft('');
      showOwnLine(text);

      /**
       * このストリームの結果を、いま見えている画面へ書いてよいか。
       *
       * **「止まったか」と混ぜてはいけない。** 混ぜると、人間が受信をやめたときに
       * 進行中の合図（考えている… / 実行中…）を片付ける処理まで飛ばしてしまい、
       * 入力欄は戻るのに本文にだけ合図が residue として残り続ける。
       *
       * - `owns()` — まだこの会話を見ている（別の会話へ移っていない）
       * - `stopped()` — 人間が受信をやめた
       *
       * ---
       *
       * **⚠️ #363（変異試験）: `owns()` 単独の効きは、いまの構造では測れない。
       * 「歯が無い」わけではない——測定そのものが成立しない。歯を無理に
       * 生やしてもいない。**
       *
       * 変異試験（`.claude/skills/mutation-testing/`）で `owns()` を
       * `() => true` に固定する変異（`chat-owns-always-true`）を当てると、
       * 既存のテスト（`chat.test.tsx`。#356 で足した、navigate と同じ tick
       * で前の会話のストリームからチャンクが届く回帰テストを含む）が
       * 1本も落ちない（生存）。一方、切り替え時の `setLines([])`
       * （上の「捨てる」ブロック）を消す変異（`chat-discard-setlines-removed`）
       * は、まさにその回帰テストを含む2本を落とす（検出）。
       *
       * **理由は「壁が1枚しか無い」からではない。** 上の切り替え検知の
       * `useEffect`（`shownIdRef.current = shownId; ...abort()...`）の
       * doc に書いたとおり、`shownIdRef.current` の更新と `abort()` は
       * **同じ effect の中で同期している**——`owns()` が「移った」と
       * 言えるようになる瞬間には、`stopped()` も既に「止まった」と
       * 言えるようになっている。だから **その effect が走った後**は、
       * `owns()` を壊しても `stopped()` が `writable()` を締め続ける。
       *
       * **そしてその effect が走る前（render の commit から、この
       * 受動的 effect が走るまでの短い窓）は、`owns()`/`stopped()` の
       * どちらも本物のままで「まだ移っていない」側の値を返す** ——
       * `shownIdRef.current`/`controller.signal.aborted` がまだ更新されて
       * いないため。この窓で `append()`（`text` チャンク）が実際には
       * 漏れないのは、`owns()`/`stopped()` が締めているからではなく、
       * 上の「捨てる」ブロックが**同じ render の中で同期的に** `lines` を
       * `[]` にしていて、`append()` の `findIndex(line => line.key ===
       * replyKey)` が対象を見失い無害な no-op になるからである
       * （`setTransient()` は既存の行を探さず無条件に積むので、この
       * 窓ではこの保護を受けない——これは #363 とは別に見つかった実際の
       * 描画バグとして別途報告する。ここでは「この窓で owns()/stopped()
       * は保護していない」ことの裏付けとしてだけ書く）。
       *
       * **つまり `owns()` が単独で効く窓は、いまの実装には無い。** 効果が
       * 走った後は `stopped()` に隠れ、効果が走る前は `setLines([])` に
       * 隠れる（`append()` の場合）か、そもそも保護されていない
       * （`setTransient()` の場合）。`owns()` を壊しても壊さなくても、
       * 既存のどのテストの結果も変わらない——これは
       * `.claude/skills/mutation-testing/SKILL.md` の生存の4分類のうち
       * **3（テストの構造が観測不能にしている）** であって、2（歯が無い）
       * ではない。**`owns()` を残しているのは、いま測れているからではなく、
       * `stopped()` だけでは説明が付かない前提——`shownIdRef` と
       * `controller` の同期がこの1つの effect に将来も乗り続けるという
       * 前提——が崩れたときの保険であり、その保険の効きは今回の変異試験の
       * 対象にできなかった、というだけである。** 歯を追加で書けば
       * 「この性質は測って確認した」と嘘をつくことになるので、足していない
       * （同 SKILL.md「2 と判断しても、歯を無理に生やさないこと」）。
       */
      const owns = () => stream.id === shownIdRef.current;
      const stopped = () => controller.signal.aborted;
      /** 新しい中身を足してよいのは、見ていて、かつ止めていないときだけ。 */
      const writable = () => owns() && !stopped();

      // クローンの応答は細切れで届く。1行に継ぎ足していく。
      let replyKey: string | undefined;
      const append = (chunk: string) => {
        if (!writable()) return;
        setLines((previous) => {
          const index = previous.findIndex((line) => line.key === replyKey);
          if (index === -1) return previous;
          const next = [...previous];
          const current = next[index];
          if (current === undefined) return previous;
          next[index] = { ...current, text: current.text + chunk, transient: false };
          return next;
        });
      };

      const setTransient = (text: string) => {
        if (!writable()) return;
        setLines((previous) => {
          const withoutTransient = previous.filter((line) => line.transient !== true);
          return [
            ...withoutTransient,
            { key: `t-${Date.now()}`, role: 'system', text, transient: true, of: stream.id },
          ];
        });
      };

      /*
       * **送ると決めた瞬間から「考えている…」を出す。サーバの `thinking` を待たない。**
       *
       * 待つと、**待ち時間が長いときにこそ出ない。** クローンは受信箱を一件ずつ
       * 取り出して直列に処理していて（`docs/architecture.md` の同時実行モデル）、
       * `thinking` を送るのは自分のターンが**始まってから**である。先客（蒸留・
       * マネージャーとの往復・自律の起点）が走っているあいだ、こちらの発言は
       * 受信箱で待つだけなので、`thinking` は来ない。**その直列は意図された
       * 設計なので壊さない。** 出せないのは画面の側の都合なので、画面で直す。
       *
       * **サーバは `queued`（積んだ＝順番待ち）を返すが、それも待たない。** ここが
       * 埋めているのは「往復そのものが失敗する」窓（デーモンが応答しない・認証で
       * 弾かれる）で、そのときは `queued` すら来ない。届いたら下の `case 'queued'`
       * がより正確な表示へ差し替える。
       *
       * **これは虚偽表示ではない。** ここが主張しているのは「この画面は発言を
       * 渡して応答を待っている」であって、`sending` が真であるあいだ、それは
       * 実際に起きている。渡すのに失敗すれば `catch` が `failure` を立て、
       * `finally` がこの合図を畳む（＝嘘のまま残らない）。
       *
       * **サーバの `thinking` を受ける経路（下の `case 'thinking'`）は消さない。**
       * あちらは「クローンが実際に入力を受け取ってターンを始めた」という別の事実で、
       * クライアントに言えるのは「送った」までである。2つは別のことを証拠立てて
       * いるので、片方で片方を置き換えない — 後から来たら上書きされるだけ。
       */
      setTransient('考えている…');

      try {
        for await (const message of api.chat(
          { text, ...(shownId === undefined ? {} : { conversationId: shownId }) },
          { signal: controller.signal },
        )) {
          if (message.event === 'open') {
            if (stream.id === undefined) {
              // **順番が大事。** 先にストリームの所属を新しい id へ移してから
              // state を動かす。逆にすると、上の effect がこのストリームを
              // 「前の会話のもの」と見なして止めてしまう。
              stream.id = message.data.conversationId;
              // ref も同時に進める。effect が回るのは描き直しの後なので、
              // それを待つと、その隙間に届いた分が `owns()` に弾かれる。
              shownIdRef.current = stream.id;
              /*
               * **まだ持ち主の無い行に、決まった id を付け直す。** 新しい会話では
               * 送った発言のほうが id より先に画面へ乗るので、ここで揃えないと
               * 「持ち主なし」の行が出なくなる（`ownedBy`）。
               *
               * **これは普通の更新なので、貼り直されても replay されるだけで
               * 消えない**（render の中でやると、貼り直しで無かったことにされる）。
               */
              const settled = stream.id;
              setLines((previous) =>
                previous.some((line) => line.of === undefined)
                  ? previous.map((line) =>
                      line.of === undefined ? { ...line, of: settled } : line,
                    )
                  : previous,
              );
              setShownId(stream.id);
              // URL は後から追いつかせるだけ。作り直しは起きない（key を付けていない）。
              void navigate(`/chat/${stream.id}`, { replace: true });
            }
            // 新規・既存どちらでも、ここで会話 id が確定する。会話一覧が
            // SSE の往復を待たずに動くよう、暫定値で先に反映しておく
            // （`useRecordOwnMessage` のコメントに詳細）。
            recordOwnMessage(message.data.conversationId, text);
            // 追送（`followUp`）は投函先の id をここから受け取る。既に確定して
            // いれば二度目は無視される（`Promise` の resolve は1回きり）。
            stream.settleOpen(message.data.conversationId);
            continue;
          }

          const event = message.data;
          switch (event.type) {
            /*
             * **`queued` は「考えている」ではない。** サーバが言っているのは
             * 「受理したが、まだ順番が来ていない」である（先客のターンが走って
             * いれば、ここで数分待つ）。上の楽観的な「考えている…」は、この画面が
             * 言える範囲＝「送った」までの表示なので、サーバから届いた**より
             * 正確な事実**で上書きする。続けて `thinking` が来たら、そのときに
             * 初めて「考えている…」へ戻る。
             */
            case 'queued':
              setTransient('順番を待っている…');
              break;
            case 'thinking':
              setTransient('考えている…');
              break;
            case 'tool':
              setTransient(`${event.tool} を実行中…`);
              break;
            case 'text':
              if (replyKey === undefined) {
                replyKey = `c-${Date.now()}`;
                const key = replyKey;
                setLines((previous) => [
                  ...previous.filter((line) => line.transient !== true),
                  { key, role: 'clone', text: '', of: stream.id },
                ]);
              }
              append(event.text);
              break;
            case 'ask_human':
              setLines((previous) => [
                ...previous.filter((line) => line.transient !== true),
                {
                  key: `a-${event.approvalId}`,
                  role: 'system',
                  of: stream.id,
                  text: `確認したいことがある: ${event.question}\n（承認待ちの画面から答えられる）`,
                },
              ]);
              break;
            /*
             * **枠（利用上限）が閉じていて、この合図はモデルへ一度も渡っていない
             * ことを画面に残す。** 終端ではない — 直後に必ず `error` が続く
             * （`schema.ts` の `usage_limited` の doc。送り主を待たせないための
             * 終端で、枠が閉じたこと自体はターンの失敗とは別の事実）。
             *
             * **`setTransient(...)` にしないこと。** transient で出すと、続く
             * `error` はこの行に触れないが、この `switch` の下にある `case 'done'`
             * と、ストリーム終了時の `finally` の両方が `line.transient !== true`
             * で transient な行を残らず消す（filter が2か所ある）。枠が閉じている
             * ことは「そのとき考え中だった」ような一時的な状態ではなく、人間が
             * あとから検索して追うべき事実なので、`ask_human` と同じ**残る行**
             * として積む。
             *
             * 文言は要約しない。`event.message`（`describeUsageNotice()` が作った、
             * SDK 自身の文言をそのまま含む文字列）をそのまま出す — 言い換えると
             * `usage-limits.ts` が約束している「人間が検索できる形」が崩れる。
             * 加えて、この発言は**捨てられておらず**次に届く合図（人間の発言・
             * 自律の発意など）で配り直されて試し直されることを一文添える。ここが
             * 欠けると、人間が「届いていない」と誤解してもう一度同じ発言を
             * 送り直してしまう（すでに保持されている分と重複する）。
             */
            case 'usage_limited':
              setLines((previous) => [
                ...previous.filter((line) => line.transient !== true),
                {
                  key: `u-${Date.now()}`,
                  role: 'system',
                  of: stream.id,
                  text: `${event.message}\n（この発言は保持されていて、次に枠が開いたときに配り直されて試し直される）`,
                },
              ]);
              break;
            case 'error':
              setFailure(new Error(event.message));
              break;
            case 'done':
              setLines((previous) => previous.filter((line) => line.transient !== true));
              break;
          }
        }
      } catch (caught) {
        if (!controller.signal.aborted) setFailure(caught);
      } finally {
        // `open` を一度も見ないまま終わったなら、追送は投函先を持てない。
        // 待たせたままにすると、続けて打った発言が永久に返ってこない
        // （既に確定していれば、この reject は無視される）。
        stream.failOpen(new Error('会話が始まらないまま接続が終わったので、続きを送れなかった'));
        // 進行中の合図は、**まだこの会話を見ているなら必ず**畳む。人間が止めた
        // 場合も畳む対象である（止めた瞬間に「考えている…」で固まらせない）。
        // 見ていない＝別の会話へ移った場合だけ、向こうの内容を触らない。
        /*
         * **自分の会話に積んだ進行中の合図だけを畳む。**
         *
         * 前は `owns()`（まだこの会話を見ているか）で囲っていた。理由は
         * 「見ていない＝別の会話へ移った場合に、向こうの内容を触らない」で、
         * **その理由はいまも正しい。変えたのは絞り方だけである** ——
         * `line.of === stream.id` は「このストリームが積んだ行」だけを指すので、
         * 向こうの内容には最初から届かない。
         *
         * **囲いを外したのは、#437 で `lines` を捨てなくなったからである。**
         * 捨てていた頃は、別の会話へ移れば合図ごと消えていた。いまは残るので、
         * 畳まないと「考えている…」が、その会話へ戻ったときに残ったまま出る。
         */
        setLines((previous) =>
          previous.filter((line) => !(line.transient === true && line.of === stream.id)),
        );
        // 入力欄の状態は会話ではなくこの画面のもの。ただし、切り替えた先で既に
        // 別の送信が始まっているなら、そちらの「受信中」を消さない。
        if (streamRef.current === stream) {
          setSending(false);
          streamRef.current = undefined;
        }
      }
    },
    [api, shownId, navigate, recordOwnMessage, showOwnLine, followUp],
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border py-4 pl-[calc(1rem+var(--safe-left))] pr-[calc(1rem+var(--safe-right))] md:pl-[calc(1.5rem+var(--safe-left))] md:pr-[calc(1.5rem+var(--safe-right))]">
        {onOpenList !== undefined && (
          <button
            type="button"
            onClick={onOpenList}
            aria-label="会話一覧を開く"
            className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <PanelLeft className="size-5" aria-hidden />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold">クローンと話す</h1>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted">
            {shownId ?? '新しい会話'}
          </p>
        </div>
        {shownId !== undefined && (
          <Button
            size="sm"
            className="shrink-0"
            onClick={() => {
              void endConversation(shownId).then(() => navigate('/chat'));
            }}
            title="クローンがここまでの学びを記憶へ蒸留する"
          >
            会話を終える
          </Button>
        )}
      </header>

      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto py-4 pl-[calc(1rem+var(--safe-left))] pr-[calc(1rem+var(--safe-right))] md:pl-[calc(1.5rem+var(--safe-left))] md:pr-[calc(1.5rem+var(--safe-right))]"
      >
        {/*
          **遡り切れていないことを言う。** サーバは人間との往復の新しい方から
          `scan` 件しか見ない（マネージャーとの往復・内部ターンは数えない。
          issue #418）ので、古い会話は「続きがあるのに出ていない」状態になり
          うる。ここが無いと、出ている分が全部だと読める（下の `Empty` は
          「まだ何も話していない」と読めるので、空のときこそ効く）。

          `reachedStart` が真のときは出さない。**窓が先頭に届いているなら、出ている
          分が全部である**ことが言えていて、そこに但し書きを出すと「常に出ている
          もの」になって情報でなくなる。
        */}
        {history.data?.reachedStart === false && (
          <p className="mb-3 text-[11px] text-muted">
            {`人間との往復を ${history.data.scanned} 件遡ったが、先頭には届いていない。これより古いやりとりが残っている可能性がある。`}
          </p>
        )}
        {/*
          **読み込み中の表示は、見せるものが何も無いときだけ。** この画面で始めた
          会話でも履歴を読むようになったので（上の `useConversation` のコメント）、
          `open` の直後に履歴の取得が始まる。手元に流れてきた分があるのに
          スピナーへ差し替えると、受信中の本文が一度消えてから戻ることになる。
        */}
        {history.isLoading && shownId !== undefined && ownedBy(lines, shownId).length === 0 ? (
          <Spinner label="履歴を読み込み中" />
        ) : all.length === 0 ? (
          <Card>
            <Empty>目的や価値観を伝えると、クローンはそれを記憶に蒸留して次の判断に使う。</Empty>
          </Card>
        ) : (
          <ul aria-label="やりとり" className="flex flex-col gap-3">
            {all.map((line) => (
              <li
                key={line.key}
                className={cn('flex', line.role === 'human' ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={cn(
                    // `break-words`: クローンの行は `Markdown`（components/markdown.tsx）
                    // が自前で `min-w-0 ... break-words` を持つが、人間・システムの行は
                    // 素のテキストを直接ここへ置くだけなので、同じ指定がここに無いと
                    // 長い一続きの文字列（URL・パス等）で吹き出しがはみ出す。
                    'min-w-0 max-w-[46rem] rounded-lg px-3 py-2 text-sm leading-relaxed break-words',
                    // クローンの本文だけ Markdown で描く（下のコメント参照）。
                    // 人間・システムの行は素のテキストのままなので、これまでどおり
                    // 改行をそのまま見せる。
                    line.role !== 'clone' && 'whitespace-pre-wrap',
                    line.role === 'human' && 'bg-accent text-accent-fg',
                    line.role === 'clone' && 'bg-surface',
                    line.role === 'system' && 'bg-transparent text-muted italic',
                  )}
                >
                  {line.role === 'clone' ? (
                    line.text === '' ? (
                      <span className="text-muted">…</span>
                    ) : (
                      /*
                       * **クローンの行だけを Markdown にする。** 人間が打った本文
                       * （`role === 'human'`）は素のテキストのままにする —
                       * 自分が書いた文字が勝手に化けないため。
                       *
                       * **受信中かどうかを見分ける信号は無い。** `Line` には
                       * `role` / `text` / `transient` しか無く、`transient` は
                       * 「考えている…」のような進行中の合図（`role: 'system'`）
                       * にしか立たない。クローンの返信行（`role: 'clone'`）は
                       * チャンクが届くたびに `text` を継ぎ足すだけで、「まだ
                       * 受信中か」を示す専用のフィールドを持たない。信号を
                       * 新設するには `packages/` や API 側の変更が要るが、
                       * それは今回の対象外（画面側だけで完結させる）。
                       *
                       * だから毎チャンク、届いた分だけの文字列を Markdown として
                       * パースし直すことになる。**まだ閉じていない ``` や `**`
                       * が受信の途中では正しく解釈されず、閉じた瞬間に表示が
                       * 変わって見える揺れが起きうる**（受信が終われば安定する）。
                       */
                      <Markdown>{line.text}</Markdown>
                    )
                  ) : (
                    line.text
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 border-t border-border pt-3 pb-[calc(0.75rem+var(--safe-bottom))] pl-[calc(1rem+var(--safe-left))] pr-[calc(1rem+var(--safe-right))] md:pl-[calc(1.5rem+var(--safe-left))] md:pr-[calc(1.5rem+var(--safe-right))]">
        <ErrorNote error={failure} className="mb-2" />
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            {/*
              **受信中も打てる。** 塞ぐと、順番待ちのあいだに言い足したいことが
              あっても待つしかなく、サーバ側にある「まとめて1ターンで読む」機構
              （`followUp` の doc）へ一度も届かない。
            */}
            <Textarea
              rows={2}
              value={draft}
              placeholder="クローンに話しかける（⌘/Ctrl + Enter で送信）"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                /*
                  **IME で変換している最中の Enter では送らない。**

                  ⭐ **いまこの門を踏む経路は無い。** 送信条件は `⌘/Ctrl + Enter` だけで、
                  Enter 単体で送る道がまだ存在しないからである（#247 の 2）。それでも
                  先に置くのは、**Enter 単体送信を足した瞬間に、この門が無いと IME の
                  「変換を確定する Enter」がそのまま誤送信になる**からで、しかも足す人が
                  そのときに門の不在へ気づく契機を持たない（この Issue を読む理由が無い）。
                  ＝ **後から足すものではなく、Enter 単体送信の前提条件として先に満たして
                  おくものである。** 下の `chat.ime-enter.test.tsx` の「Enter 単体では
                  送らない」が、Enter 単体送信を足した人をここへ連れてくる網である。

                  **いま既に効く分もある** — `⌘/Ctrl + Enter` を変換中に打った場合である。
                  変換中でも `input` は飛ぶ（Chrome）ので `draft` には確定前の途中の文字列
                  （「こんにちh」のような）が入っており、そのまま投函されていた。

                  `event.isComposing` ではなく **`event.nativeEvent.isComposing` を見る** —
                  React の合成イベントの型は `isComposing` を持たない（DOM の
                  `KeyboardEvent` の側にしか無い）。

                  **`keyCode === 229` を併せて見るのは、`isComposing` が false のまま
                  変換確定の Enter を配る実装が在るからである**（Android の IME や古い
                  WebKit で報告されている形。229 は「IME が処理中」を表す慣用の値）。
                  PR #53 がこの項目を予告したときに挙げた既存実装（virchamate の
                  `isIMEActive`）も、この2つを併用している。⚠️ **実機での確認はしていない**
                  — 229 を配るブラウザをこの器から触れないので、ここで測れているのは
                  「229 が来たら送らない」という分岐の存在だけである。
                */
                if (
                  event.key === 'Enter' &&
                  (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
                ) {
                  return;
                }
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void send(draft);
                }
              }}
            />
          </div>
          {/*
            **「受信をやめる」は「送る」の代わりではない。** 並べて出す —
            受信中でも続けて送れるので、送る口を消してしまうと、追送するには
            いったん受信を捨てるしかなくなる（捨てているあいだに届いた応答は画面に出ない）。

            **狭い画面ではラベルだけ畳み、アイコンは常に出す**（`hidden md:inline`）。
            2つ並ぶと入力欄と幅を取り合うため、本3 で `h-11` になったこのボタンは
            アイコン化しないと狭い画面で収まらない。`aria-label` は明示する —
            ラベルの `<span>` を隠しても中の文字は DOM から消えないので付けなくても
            アクセシブルネームは保たれるが、実機（Tailwind が効く環境）で見出しの
            文字が本当に消えたときに備え、頼らない形にしてある。
          */}
          {sending && (
            <Button
              variant="default"
              onClick={() => streamRef.current?.controller.abort()}
              title="読むのをやめる。クローンのターンは止まらない"
              aria-label="受信をやめる"
            >
              <Square className="size-3.5" aria-hidden />
              <span className="hidden md:inline">受信をやめる</span>
            </Button>
          )}
          <Button
            variant="primary"
            disabled={draft.trim() === ''}
            onClick={() => void send(draft)}
            aria-label="送る"
          >
            <Send className="size-3.5" aria-hidden />
            <span className="hidden md:inline">送る</span>
          </Button>
        </div>
        {/*
          進行中かどうかは、やりとりの中の「考えている…」と「受信をやめる」で
          既に見えている。ここに残すのは**他に書いてある場所が無い事実**だけ。
        */}
        {sending && (
          <p className="mt-1.5 text-[11px] text-muted">
            画面を閉じてもクローンは考え続ける。順番待ちのあいだに続けて送った分は、まとめて1つの応答になる
          </p>
        )}
      </div>
    </div>
  );
}
