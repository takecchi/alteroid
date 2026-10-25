import { basename, join, relative, sep } from 'node:path';

import { chunkMirrorEntries, MIRROR_EVENT_MAX_CHARS } from './mirror-chunks.js';
import { localRolloutIo, type RolloutIo } from './runner-child-fs.js';
import { PEER_META_ENTRY_TYPE, PEER_SUBPATH_PREFIX, type PeerMetaEntry } from './resume-peers.js';

/** 1回の読みで取り込む最大バイト数。1つのターンで巨大な rollout を丸ごとメモリへ載せない。続きは次の止まりどころで読む。 */
const READ_CHUNK_BYTES = 8 * 1024 * 1024;

export interface PeerRolloutKey {
  readonly projectKey: string;
  readonly sessionId: string;
}

export interface PeerRolloutDeps {
  /** peer の Codex が使う `CODEX_HOME`（peer の spawn と同じ値）。分からなければ `undefined`（預けない）。 */
  readonly codexHome: () => string | undefined;
  /** 担当の主の記録の鍵。まだ分からなければ `undefined`（分かるまでメモリに溜める）。 */
  readonly mainKey: () => PeerRolloutKey | undefined;
  readonly mirror: (key: PeerRolloutKey & { subpath: string }, entries: unknown[]) => void;
  readonly note: (text: string) => void;
  /** rollout の解決と読み取りの口。子を別 UID で起こす構成では子の uid の子プロセスで行う口を渡す（#5259）。無ければ runner 自身で読む。 */
  readonly io?: RolloutIo;
}

interface TrackedPeer {
  readonly peerId: string;
  readonly provider: string;
  readonly threadId: string;
  readonly file: string;
  readonly relPath: string;
  offset: number;
  metaPending: boolean;
  /** 鍵が分かる前に読んだ行（メタの行を含む）。 */
  buffered: unknown[];
  chain: Promise<void>;
}

/**
 * rollout の置き場として読んでよいか検める。通れば実体のパスと `sessions/` からの相対パス、通らなければ理由。
 * 資格（`auth.json`・`config.toml` など）を読まない・預けないための守り: `transcriptLocation` は相手（Codex）が名乗った値で、
 * runner（root のことがある）がそれを開くので、名前と実体の両方で「`CODEX_HOME/sessions/` の下の `rollout-…<threadId>.jsonl`」だけに絞る。
 * 実体（realpath）で見るので、`sessions/` の外を指す symlink（資格への symlink を含む）も通らない。
 */
export async function resolveRolloutFile(
  codexHome: string,
  location: string,
  threadId: string,
  io: RolloutIo = localRolloutIo,
): Promise<
  { ok: true; file: string; relPath: string } | { ok: false; reason: string; missing?: true }
> {
  const matches = (name: string): boolean =>
    name.startsWith('rollout-') && name.endsWith(`${threadId}.jsonl`);
  if (location.includes('\0')) return { ok: false, reason: 'パスに NUL を含む' };
  if (!matches(basename(location))) {
    return { ok: false, reason: 'ファイル名が rollout-…<thread id>.jsonl ではない' };
  }
  let realSessions: string;
  let realFile: string;
  try {
    // 子を別 UID で起こす構成では、実体の解決も子の uid の子プロセスで行う（#5259）: 子が `sessions` を symlink にしても、子が読めない場所へは届かない
    const [sessionsResult, fileResult] = await io.realpaths([
      join(codexHome, 'sessions'),
      location,
    ]);
    if (sessionsResult === undefined || fileResult === undefined) throw new Error('missing result');
    for (const result of [sessionsResult, fileResult]) {
      if ('code' in result) {
        return {
          ok: false,
          reason: `実体を解決できない: ${result.code}`,
          // まだ書かれていない（Codex が最初のターンまで rollout を作らない場合）。呼び出し側は後でもう一度検める
          ...(result.code === 'ENOENT' ? { missing: true as const } : {}),
        };
      }
    }
    realSessions = (sessionsResult as { path: string }).path;
    realFile = (fileResult as { path: string }).path;
  } catch (error) {
    return { ok: false, reason: `実体を解決できない: ${errorCode(error)}` };
  }
  if (!realFile.startsWith(`${realSessions}${sep}`)) {
    return { ok: false, reason: 'CODEX_HOME/sessions/ の下ではない（symlink の先を含む）' };
  }
  if (!matches(basename(realFile))) {
    return { ok: false, reason: '実体のファイル名が rollout-…<thread id>.jsonl ではない' };
  }
  const relPath = relative(realSessions, realFile).split(sep).join('/');
  return { ok: true, file: realFile, relPath };
}

/**
 * peer（Codex）の rollout の増えた行だけを、担当の主の記録の隣（`subpath: 'peers/<peerId>'`）へ預ける（`mirror` の出来事）。
 * peer のターンが止まるたびと畳むときに {@link PeerRolloutMirror.collect} を呼ぶ。読み済みのバイト位置を覚え、改行で終わった行だけを読む。
 */
export class PeerRolloutMirror {
  readonly #deps: PeerRolloutDeps;
  readonly #peers = new Map<string, TrackedPeer>();
  readonly #untracked = new Set<string>();
  readonly #tracking = new Map<string, Promise<void>>();
  readonly #waiting = new Map<
    string,
    {
      peerId: string;
      provider: string;
      threadId: string;
      transcriptLocation: string | undefined;
      resumed: boolean;
    }
  >();
  #closed = false;

  constructor(deps: PeerRolloutDeps) {
    this.#deps = deps;
  }

  /** peer のセッションが始まった（続きから起こした回を含む）。続きの回は、いまのファイルの終わりから読む（置いた分は預け済み）。 */
  track(info: {
    peerId: string;
    provider: string;
    threadId: string;
    transcriptLocation: string | undefined;
    resumed: boolean;
  }): Promise<void> {
    // 検めの途中に止まりどころが来ても取りこぼさないよう、`collect` はこの完了を待つ
    const tracking = this.#trackNow(info).catch((error: unknown) => {
      this.#skip(info.peerId, `記録の置き場を検められない: ${errorCode(error)}`);
    });
    this.#tracking.set(info.peerId, tracking);
    return tracking;
  }

  async #trackNow(info: {
    peerId: string;
    provider: string;
    threadId: string;
    transcriptLocation: string | undefined;
    resumed: boolean;
  }): Promise<void> {
    const { peerId } = info;
    const home = this.#deps.codexHome();
    if (info.transcriptLocation === undefined || home === undefined) {
      this.#skip(
        peerId,
        info.transcriptLocation === undefined
          ? '相手が記録の置き場を名乗らなかった'
          : 'CODEX_HOME が分からない',
      );
      return;
    }
    const io = this.#deps.io ?? localRolloutIo;
    const resolved = await resolveRolloutFile(home, info.transcriptLocation, info.threadId, io);
    if (!resolved.ok) {
      // 記録がまだ無いだけなら、次の止まりどころでもう一度検める（断ったとは数えない）
      if (resolved.missing === true) this.#waiting.set(peerId, info);
      else this.#skip(peerId, resolved.reason);
      return;
    }
    this.#waiting.delete(peerId);
    // 同じ peer を同じ記録で起こし直した回は、読み済みの位置を引き継ぐ（作り直すと、閉じる間際に書かれた分を読み飛ばす）
    if (this.#peers.get(peerId)?.file === resolved.file) {
      this.#untracked.delete(peerId);
      return;
    }
    let offset = 0;
    if (info.resumed) {
      try {
        offset = (await io.readChunk(resolved.file, 0, 0)).size;
      } catch (error) {
        this.#skip(peerId, `記録を開けない: ${errorCode(error)}`);
        return;
      }
    }
    this.#untracked.delete(peerId);
    this.#peers.set(peerId, {
      peerId,
      provider: info.provider,
      threadId: info.threadId,
      file: resolved.file,
      relPath: resolved.relPath,
      offset,
      metaPending: true,
      buffered: [],
      chain: Promise.resolve(),
    });
  }

  #skip(peerId: string, reason: string): void {
    if (this.#untracked.has(peerId)) return;
    this.#untracked.add(peerId);
    this.#deps.note(`peer [${peerId}] の記録を預けない（続きから起こせなくなる）: ${reason}`);
  }

  /** 増えた行を読んで預ける。同じ peer への呼び出しは順に行う。 */
  collect(peerId: string): Promise<void> {
    return (this.#tracking.get(peerId) ?? Promise.resolve()).then(async () => {
      const waiting = this.#waiting.get(peerId);
      if (waiting !== undefined) {
        this.#waiting.delete(peerId);
        await this.#trackNow(waiting).catch(() => undefined);
      }
      const peer = this.#peers.get(peerId);
      if (peer === undefined || this.#closed) return undefined;
      const run = peer.chain.then(() => this.#collectNow(peer));
      peer.chain = run.catch(() => undefined);
      return run.catch((error: unknown) => {
        this.#deps.note(`peer [${peerId}] の記録を読めなかった: ${errorCode(error)}`);
      });
    });
  }

  /** 畳むとき: 増えた分を最後に預けてから、以後の読みを止める（閉じた後に届く止まりどころで、畳んだ後の出来事を出さない）。 */
  async closeAfterCollecting(): Promise<void> {
    await this.collectAll();
    this.#closed = true;
  }

  /** 担当の主の記録の鍵が分かったとき: 溜めていた分を預ける。 */
  flushBuffered(): void {
    for (const peer of this.#peers.values()) {
      peer.chain = peer.chain.then(() => this.#emitBuffered(peer));
    }
  }

  collectAll(): Promise<void> {
    return Promise.all([...this.#tracking.keys()].map((id) => this.collect(id))).then(
      () => undefined,
    );
  }

  async #collectNow(peer: TrackedPeer): Promise<void> {
    const io = this.#deps.io ?? localRolloutIo;
    // 読むたびに大きさも返る: 子の uid の子プロセスで読む構成では、1回の読みで1本の子プロセスなので、大きさだけを別に問わない
    for (;;) {
      const { size, data: text } = await io.readChunk(peer.file, peer.offset, READ_CHUNK_BYTES);
      if (text.length === 0) break;
      // 改行で終わった行だけ取る: 書きかけの最後の行を読んで欠けた JSON にしない
      const lastNewline = text.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        // 改行が無いまま塊が尽きた: 書きかけ（次の止まりどころで読む）か、1行が塊より大きい（読めない）
        if (text.length === READ_CHUNK_BYTES) {
          this.#deps.note(
            `peer [${peer.peerId}] の記録に ${String(READ_CHUNK_BYTES)} バイトを超える1行があり、以降は預けない`,
          );
        }
        break;
      }
      peer.offset += lastNewline + 1;
      const lines: unknown[] = [];
      for (const raw of text.subarray(0, lastNewline).toString('utf8').split('\n')) {
        if (raw.trim() === '') continue;
        try {
          lines.push(JSON.parse(raw));
        } catch {
          this.#deps.note(`peer [${peer.peerId}] の記録に読めない行があったので飛ばした`);
        }
      }
      if (lines.length > 0) {
        if (peer.metaPending) {
          const meta: PeerMetaEntry = {
            type: PEER_META_ENTRY_TYPE,
            provider: peer.provider,
            threadId: peer.threadId,
            relPath: peer.relPath,
          };
          peer.buffered.push(meta);
          peer.metaPending = false;
        }
        peer.buffered.push(...lines);
        this.#emitBuffered(peer);
      }
      if (peer.offset >= size) break;
    }
  }

  #emitBuffered(peer: TrackedPeer): void {
    const key = this.#deps.mainKey();
    if (key === undefined || peer.buffered.length === 0) return;
    const entries = peer.buffered;
    peer.buffered = [];
    for (const chunk of chunkMirrorEntries(entries, MIRROR_EVENT_MAX_CHARS)) {
      this.#deps.mirror({ ...key, subpath: `${PEER_SUBPATH_PREFIX}${peer.peerId}` }, chunk);
    }
  }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : 'unknown';
}
