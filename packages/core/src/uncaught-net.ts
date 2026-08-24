import { noteUncaught } from './dropped-record.js';

/**
 * 未捕捉の例外・未処理の Promise 拒否に、**観測だけの網**を張る（#438）。
 *
 * ## 何が問題だったか
 *
 * `process.on('uncaughtException')` / `process.on('unhandledRejection')` の登録が
 * **1つも無かった**（#438 の実測。`grep` に当たる `process.on(` は `SIGTERM` /
 * `SIGINT` の4件だけで、塞いであるのは `packages/storage-pg/src/index.ts` の
 * `pool.on('error')` という**1つの出所**のみ）。**落ちること自体は器の再起動で
 * 隠れる**ので、落ちた回も理由も残らない。しかも Node 既定のスタックには
 * `alteroid:` 系の接頭辞が付かないので、**`grep` にも当たらない。**
 *
 * ## ⚠️ なぜ `uncaughtException` ではなく `uncaughtExceptionMonitor` なのか
 *
 * **実測（`node v22.23.2`。`mise.toml` の pin と同版。2026-08-24 観測）:**
 *
 * | 登録するもの                      | 既定のスタックは出るか | プロセスは死ぬか |
 * | --------------------------------- | ---------------------- | ---------------- |
 * | （何も登録しない＝#438 以前）     | 出る（接頭辞なし）     | 死ぬ（exit 1）   |
 * | `process.on('uncaughtException')` | **出ない**             | **死なない**     |
 * | **`uncaughtExceptionMonitor`**    | **出る**               | **死ぬ（exit 1）** |
 *
 * - **`uncaughtExceptionMonitor` は両方の `origin` で発火する** —— 同期の throw は
 *   `origin='uncaughtException'`、未処理の Promise 拒否は
 *   `origin='unhandledRejection'`。**片方だけの網ではない。**
 * - **`uncaughtException` を登録すると、未処理の Promise 拒否もそこへ来る**（実測）。
 *   つまり「落ちなくなる」のは片方ではなく**両方**である。
 *
 * **⟹ この形は `uncaughtException` 版の劣化版ではない。`uncaughtException` 版が
 * 捨てるものを守っている形である。** 次に読む者が「A は中途半端だから B（記録して
 * から自分で `process.exit(1)` する形）へ上げよう」とやらないよう、捨てる理由を
 * 2つ書いておく。
 *
 * 1. **器が「壊れた」と判定できる材料は、いまプロセスの終了しか無い。**
 *    `railway/daemon.json` / `railway/runner.json` に `healthcheckPath` は無く
 *    （`grep -rni healthcheck railway/` は0件）、`compose.yaml` の healthcheck は
 *    `depends_on` の起動順ゲート専用である。**落ちるのを止めると、唯一の検知器を
 *    外すことになる。** 実際 `packages/core/src/clone.ts` の `void this.#pump()`
 *    が死んだまま生き延びると、HTTP は答え続け受信箱は積まれ続けたまま、**誰も
 *    気づかない。** いまは落ちて再起動し、`#restoreUnread()` が未読を本文ごと
 *    配り直して戻る —— **復旧機構がプロセスの消滅を契機に組んである**
 *    （`docs/architecture.md`「再起動後は生きているセッションへ繋ぎ直し、runner
 *    ごと落ちていた分だけ resume する」）。
 * 2. **`uncaughtException` を登録すると Node 既定のスタックが完全に消える**（実測）。
 *    これは「素のスタックが器のログへ出なくなる」という利得に見えるが、**利得と
 *    して数えないこと。** #249 が言う「本文を出さない」は **HTTP の応答本文**
 *    （呼んだ側へ届く）の話であって、**スタックは運用者のログへ出るだけである。
 *    同じ線ではない。** そして #438 が在る理由は「**落ちたことを追えない**」で
 *    あり、スタックを消すのは**追う材料を減らして**その Issue に答えることになる。
 *
 * ## ⚠️ この網が救わないもの（申し送り。別 Issue にしていない）
 *
 * **この網は、起動のたびに再発する例外を救わない。** Railway の
 * `restartPolicyMaxRetries` は `railway/daemon.json` / `railway/runner.json` の
 * どちらも **100** で、そこに到達すると**恒久停止して人間が押しに行くまで戻らない**
 * （根拠は `railway/README.md` の逐語 —— 既定の10回について「runner の不調が20分
 * 続いた時点で daemon が恒久停止し、人間が押しに行くまで戻らない」と書いてある。
 * だから 100 に上げてある）。**この網が足すのは跡の1行だけで、その穴は今日と同じ
 * だけ残る。** これは #438 以前から在る穴であって、この網が作ったものではない。
 *
 * ## 覆っていない窓
 *
 * **module の import 中に投げた例外は、この網より前である。** 登録は各 app の
 * `invokedDirectly()` の枝で `main()` を呼ぶ前に行うので、そこまでに走るのは
 * import だけだが、**import が投げたら今日と同じ（Node 既定のスタック + exit 1）
 * になる。悪化はしないが、覆ってはいない。**
 *
 * ## この関数がしないこと
 *
 * **listener は跡を1行書く以外を一切しない** —— `process.exit` を呼ばない・状態を
 * 触らない・非同期にしない。**ここで投げると Node は exit code 7（"Internal
 * Exception Handler Run-Time Failure"）で落ちる**（実測）ので、無限ループには
 * ならないが、跡のために本筋の落ち方を変えてはいけない。
 *
 * @param prefix 跡に出す接頭辞（`alteroidd` / `alteroid-runner`）。**末尾のコロンは
 *   付けない。**
 * @returns 網を外す関数。**テストの後始末のために在る**（外し忘れると
 *   `uncaughtExceptionMonitor` の listener が後続のテストへ漏れる）。本番の配線で
 *   呼ぶことは想定していない。
 */
export function installUncaughtNet(prefix: string): () => void {
  const listener = (error: Error, origin: string): void => {
    noteUncaught(prefix, origin, error);
  };
  process.on('uncaughtExceptionMonitor', listener);
  return () => {
    process.off('uncaughtExceptionMonitor', listener);
  };
}
