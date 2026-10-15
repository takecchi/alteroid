import { stat } from 'node:fs';

/**
 * libuv のスレッドの枠（既定4本）を16本にする（#4890）。**副作用だけのモジュールで、自前のモジュールを import しない。**
 * デーモンと runner の入口（`apps/daemon/src/index.ts`・`apps/runner/src/index.ts`）が、最初の import として
 * `import '@alteroid/core/threadpool-size';` と置く。
 *
 * ファイルの非同期の読み書き・`dns.lookup`（runner への fetch と PostgreSQL の接続の名前解決）・crypto の非同期は、同じ枠で回る。
 * 器の I/O が詰まって4本がふさがると、イベントループは空いたまま（使用率 0%）、名乗りの確認も PostgreSQL への接続もそろって待たされ、
 * runner を8台同時に失う形に化けた。
 *
 * **なぜ起動スクリプト（`docker/alteroidd` 等）の `export` ではないか。** 環境変数は、デーモンと runner が起こす子のプロセス全部
 * （担い手の Bash から走る pnpm・vitest・dev サーバ・MCP の中継など Node 製のもの）へ受け継がれる。libuv は枠を初めて使った時点で
 * 全部のスレッドを一度に作るので、Node の子1つにつき最大16本のスレッドが増え、器の pids の上限（本番は飽和で困っている。#4511 ほか）を食う。
 * そこで、このプロセスの枠だけを16本にして、環境変数は子へ残さない。
 *
 * **やり方（順序が要点）。**
 * 1. 値が無ければ `process.env.UV_THREADPOOL_SIZE` に 16 を置く。
 * 2. 枠を使う呼び出しを1つ投げる。libuv は最初の作業を枠へ投げる時点（`uv__work_submit` の `uv_once`）で同期に環境変数を読み、
 *    そのとき大きさが決まる（その後に環境変数を変えても効かない）。
 * 3. 自分が置いた値なら、環境変数を消す。子には受け継がれない。人間が置いた値は触らない（消さない・変えない）。
 *
 * **なぜ入口の本文ではなく、別のモジュールか。** ESM の import は入口の本文より先に評価されるので、入口の本文で行うと、
 * 先に評価された import の中で枠を使う処理が走っていた場合に遅れる。import は書かれた順に評価されるので、これを最初に置けば、
 * 他のどのモジュールの評価よりも先に効く。入口はバンドルされ、外部パッケージ（`@alteroid/core` など）の import は
 * バンドル内の自前の本文より先に評価されるので、入口のファイルの中ではなく、core の別の入口（package の exports）にしてある。
 *
 * 人間が `UV_THREADPOOL_SIZE` を置いていればそれに従う（空文字は「置いていない」と読む: libuv は空を 0 と読み、既定の4へ戻るため）。
 */
export const DEFAULT_UV_THREADPOOL_SIZE = '16';

const current = process.env.UV_THREADPOOL_SIZE;
if (current === undefined || current === '') {
  process.env.UV_THREADPOOL_SIZE = DEFAULT_UV_THREADPOOL_SIZE;
  // この呼び出しの結果は要らない。枠へ作業を投げて、大きさを今ここで決めさせるためだけに投げる
  stat('/', () => undefined);
  delete process.env.UV_THREADPOOL_SIZE;
}
