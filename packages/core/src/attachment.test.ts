import { describe, expect, it } from 'vitest';

import {
  ATTACHMENT_RETENTION_DAYS_DEFAULT,
  ATTACHMENT_RETENTION_DAYS_ENV,
  AttachmentCursorError,
  AttachmentRejectedError,
  DEFAULT_ATTACHMENT_LIMITS,
  attachmentDiskName,
  classifyAttachmentFrom,
  decodeAttachmentCursor,
  encodeAttachmentCursor,
  normalizeAttachmentName,
  readAttachmentLimits,
  sniffAttachmentImageType,
  validateAttachmentBatch,
  validateAttachmentInput,
} from './attachment.js';
import { MemoryAttachmentStore } from './attachment-memory.js';
import { verifyAttachmentStoreContract } from './attachment-contract.js';
import { createMemoryStores } from './testing.js';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const WEBP = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50];
const bytes = (...parts: number[][]) => Uint8Array.from(parts.flat());

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof AttachmentRejectedError ? error.code : `other:${String(error)}`;
  }
  return undefined;
}

describe('添付: マジックバイト', () => {
  it('png / jpeg / gif / webp を判定する', () => {
    expect(sniffAttachmentImageType(bytes(PNG))).toBe('image/png');
    expect(sniffAttachmentImageType(bytes(JPEG))).toBe('image/jpeg');
    expect(sniffAttachmentImageType(bytes(GIF))).toBe('image/gif');
    expect(sniffAttachmentImageType(bytes([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))).toBe('image/gif');
    expect(sniffAttachmentImageType(bytes(WEBP))).toBe('image/webp');
  });

  it('どれでもなければ undefined（RIFF だけの WAV も webp にしない）', () => {
    expect(sniffAttachmentImageType(bytes([1, 2, 3]))).toBeUndefined();
    expect(sniffAttachmentImageType(new Uint8Array())).toBeUndefined();
    expect(
      sniffAttachmentImageType(bytes([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45])),
    ).toBeUndefined();
  });

  it('宣言が画像なのに中身が一致しなければ拒否する', () => {
    const run = (mediaType: string, b: Uint8Array) =>
      codeOf(() => validateAttachmentInput({ name: 'x', mediaType, bytes: b }));
    expect(run('image/png', bytes(JPEG))).toBe('magic_mismatch');
    expect(run('image/webp', bytes([1, 2, 3]))).toBe('magic_mismatch');
    expect(run('image/png', bytes(PNG))).toBeUndefined();
    // 画像でない宣言は中身を問わない
    expect(run('application/pdf', bytes([1, 2, 3]))).toBeUndefined();
  });
});

function messageOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

/** IHDR だけの小さな png。寸法の検査には大きなバッファは要らない。 */
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const pngOf = (width: number, height: number) =>
  bytes(PNG, be32(13), [0x49, 0x48, 0x44, 0x52], be32(width), be32(height), [8, 6, 0, 0, 0]);

describe('添付: 画像の寸法（#3697）', () => {
  const put = (mediaType: string, b: Uint8Array) =>
    validateAttachmentInput({ name: 'x', mediaType, bytes: b });

  it('幅・高さとも 8000px ちょうどは通る', () => {
    expect(codeOf(() => put('image/png', pngOf(8000, 8000)))).toBeUndefined();
  });

  it('幅だけ・高さだけ 8001px でも断り、何が超えたか実際の値で言う', () => {
    expect(codeOf(() => put('image/png', pngOf(8001, 10)))).toBe('image_dimension_too_large');
    expect(codeOf(() => put('image/png', pngOf(10, 8001)))).toBe('image_dimension_too_large');
    expect(messageOf(() => put('image/png', pngOf(8001, 10)))).toBe(
      '画像の寸法は幅・高さとも 8000 px まで（8001 × 10 px ある）',
    );
    expect(messageOf(() => put('image/png', pngOf(10, 9000)))).toBe(
      '画像の寸法は幅・高さとも 8000 px まで（10 × 9000 px ある）',
    );
  });

  it('寸法が読めない画像（ヘッダが切れている）は今までどおり通る', () => {
    expect(codeOf(() => put('image/png', pngOf(8001, 10).subarray(0, 20)))).toBeUndefined();
    expect(codeOf(() => put('image/png', bytes(PNG)))).toBeUndefined();
  });

  it('宣言が画像以外なら、中身が 8001px の png でも通る（ターンでファイルとして渡る）', () => {
    expect(codeOf(() => put('application/octet-stream', pngOf(8001, 8001)))).toBeUndefined();
  });

  it('大きさの上限が先（両方に当たる画像は too_large）', () => {
    const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxImageBytes: 30 };
    const big = Uint8Array.from([...pngOf(8001, 1), ...new Array<number>(20).fill(0)]);
    expect(
      codeOf(() =>
        validateAttachmentInput({ name: 'x', mediaType: 'image/png', bytes: big }, limits),
      ),
    ).toBe('too_large');
  });
});

describe('添付: 上限', () => {
  it('画像は 5 MiB、その他は 25 MiB まで', () => {
    const png = (n: number) => {
      const b = new Uint8Array(n);
      b.set(PNG);
      return b;
    };
    const run = (mediaType: string, b: Uint8Array) =>
      codeOf(() => validateAttachmentInput({ name: 'x', mediaType, bytes: b }));
    expect(run('image/png', png(5 * 1024 * 1024))).toBeUndefined();
    expect(run('image/png', png(5 * 1024 * 1024 + 1))).toBe('too_large');
    expect(run('video/mp4', new Uint8Array(25 * 1024 * 1024))).toBeUndefined();
    expect(run('video/mp4', new Uint8Array(25 * 1024 * 1024 + 1))).toBe('too_large');
  });

  it('1つの大きさを断る文は、上限を人が読める単位で言い、実際の大きさをバイトで言う', () => {
    const over = Uint8Array.from([...PNG, ...new Array<number>(5 * 1024 * 1024).fill(0)]);
    expect(
      messageOf(() => validateAttachmentInput({ name: 'x', mediaType: 'image/png', bytes: over })),
    ).toBe(`画像は 1 つ 5 MiB まで（${over.length} バイトある）`);
    const file = new Uint8Array(25 * 1024 * 1024 + 1);
    expect(
      messageOf(() => validateAttachmentInput({ name: 'x', mediaType: 'video/mp4', bytes: file })),
    ).toBe(`ファイルは 1 つ 25 MiB まで（${file.length} バイトある）`);
  });

  it('1発言は 10 個・合計 50 MiB まで', () => {
    const mib = 1024 * 1024;
    expect(codeOf(() => validateAttachmentBatch(Array(10).fill(mib)))).toBeUndefined();
    expect(codeOf(() => validateAttachmentBatch(Array(11).fill(1)))).toBe('too_many');
    expect(codeOf(() => validateAttachmentBatch([25 * mib, 25 * mib]))).toBeUndefined();
    expect(codeOf(() => validateAttachmentBatch([25 * mib, 25 * mib, 1]))).toBe('total_too_large');
  });

  it('環境変数で変えられる。読めない値は notes に落として既定へ倒す', () => {
    const ok = readAttachmentLimits({ [ATTACHMENT_RETENTION_DAYS_ENV]: '7' });
    expect(ok.limits.retentionDays).toBe(7);
    expect(ok.limits.maxImageBytes).toBe(DEFAULT_ATTACHMENT_LIMITS.maxImageBytes);
    expect(ok.notes).toEqual([]);
    const bad = readAttachmentLimits({ ALTEROID_ATTACHMENT_MAX_PER_MESSAGE: 'many' });
    expect(bad.limits.maxPerMessage).toBe(10);
    expect(bad.notes).toHaveLength(1);
  });

  it('ターンの画像の枚数・合計は既定 20 枚・16 MiB で、環境変数で変えられる（#3696）', () => {
    const defaults = readAttachmentLimits({});
    expect(defaults.limits.maxTurnImages).toBe(20);
    expect(defaults.limits.maxTurnImageBytes).toBe(16 * 1024 * 1024);
    // 入口の検査の上限（`GET /attachments/limits` の形。CLI が欄の有無で読む）には、ターンの欄を混ぜない。
    expect(Object.keys(DEFAULT_ATTACHMENT_LIMITS)).not.toContain('maxTurnImages');
    const changed = readAttachmentLimits({
      ALTEROID_ATTACHMENT_MAX_TURN_IMAGES: '5',
      ALTEROID_ATTACHMENT_MAX_TURN_IMAGE_BYTES: '1000',
    });
    expect(changed.limits.maxTurnImages).toBe(5);
    expect(changed.limits.maxTurnImageBytes).toBe(1000);
    expect(changed.notes).toEqual([]);
    const bad = readAttachmentLimits({
      ALTEROID_ATTACHMENT_MAX_TURN_IMAGES: '0',
      ALTEROID_ATTACHMENT_MAX_TURN_IMAGE_BYTES: 'big',
    });
    expect(bad.limits.maxTurnImages).toBe(20);
    expect(bad.limits.maxTurnImageBytes).toBe(16 * 1024 * 1024);
    expect(bad.notes).toHaveLength(2);
  });

  it('保持日数は上限（36500 日）まで。超えたら notes に落として既定へ倒し、put が RangeError にならない（#3326）', async () => {
    const atMax = readAttachmentLimits({
      [ATTACHMENT_RETENTION_DAYS_ENV]: '36500',
    });
    expect(atMax.limits.retentionDays).toBe(36500);
    expect(atMax.notes).toEqual([]);
    const over = readAttachmentLimits({
      [ATTACHMENT_RETENTION_DAYS_ENV]: '36501',
    });
    expect(over.limits.retentionDays).toBe(ATTACHMENT_RETENTION_DAYS_DEFAULT);
    expect(over.notes).toHaveLength(1);
    expect(over.notes[0]).toContain(ATTACHMENT_RETENTION_DAYS_ENV);
    const huge = readAttachmentLimits({ [ATTACHMENT_RETENTION_DAYS_ENV]: '1000000000000000' });
    expect(huge.limits.retentionDays).toBe(ATTACHMENT_RETENTION_DAYS_DEFAULT);
    expect(huge.notes).toHaveLength(1);
    // 上限の他の項目（バイト数など）は上限を掛けない。
    expect(
      readAttachmentLimits({ ALTEROID_ATTACHMENT_MAX_FILE_BYTES: '1000000000000' }).notes,
    ).toEqual([]);
    const store = new MemoryAttachmentStore({ limits: huge.limits });
    const meta = await store.put({ name: 'a', mediaType: 'text/plain', bytes: Uint8Array.of(1) });
    expect(Date.parse(meta.expiresAt!)).toBeGreaterThan(Date.parse(meta.createdAt));
  });
});

describe('添付: ファイル名', () => {
  it('NUL・パス区切り・孤立サロゲートを除く', () => {
    expect(normalizeAttachmentName('a\u0000b.txt')).toBe('ab.txt');
    expect(normalizeAttachmentName('../etc/passwd')).toBe('.._etc_passwd');
    expect(normalizeAttachmentName('C:\\x\\y.png')).toBe('C:_x_y.png');
    expect(normalizeAttachmentName('a\ud83d.txt')).toBe('a\ufffd.txt');
    expect(normalizeAttachmentName('..')).toBe('file');
    expect(normalizeAttachmentName('')).toBe('file');
    expect(normalizeAttachmentName('日本語.pdf')).toBe('日本語.pdf');
  });

  it('書式制御文字（双方向制御など）と C1 制御文字を _ にする。通常の文字は残す（#3332）', () => {
    expect(normalizeAttachmentName('evil\u202Efdp.exe')).toBe('evil_fdp.exe');
    expect(normalizeAttachmentName('a\u200Eb\u200Fc\u2066d\u2069e\u200Bf\uFEFFg')).toBe(
      'a_b_c_d_e_f_g',
    );
    expect(normalizeAttachmentName('a\u0080b\u009Fc')).toBe('a_b_c');
    // 通常の非 ASCII 文字は残す。
    expect(normalizeAttachmentName('日本語\u00e9.pdf')).toBe('日本語\u00e9.pdf');
  });

  it('文脈上正当な ZWJ・ZWNJ は残す（IDNA ContextJ と絵文字の連結。#3882）', () => {
    const kept = [
      // 絵文字の ZWJ 連結（家族・肌色の修飾子つき・異体字セレクタつき）
      '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}.png',
      '\u{1F469}\u{1F3FD}\u{200D}\u{1F4BB}.png',
      '\u{2764}\u{FE0F}\u{200D}\u{1F525}.png',
      // ペルシア語: アラビア文字（D）と D のあいだの ZWNJ（RFC 5892 A.1 の結合型の規則）
      '\u{0645}\u{06CC}\u{200C}\u{062E}\u{0648}\u{0627}\u{0647}\u{0645}.pdf',
      // 結合型 T（Mn）を挟んでも残す
      '\u{0628}\u{064E}\u{200C}\u{0628}.pdf',
      // デーヴァナーガリー: Virama の後の ZWJ・ZWNJ（RFC 5892 A.1・A.2）
      '\u{0915}\u{094D}\u{200D}\u{0937}.txt',
      '\u{0915}\u{094D}\u{200C}\u{0937}.txt',
    ];
    for (const name of kept) {
      expect(normalizeAttachmentName(name)).toBe(name);
    }
  });

  it('文脈の無い ZWJ・ZWNJ は今までどおり _ にする（見えない文字による偽装を防ぐ。#3882）', () => {
    // 同じに見えて違う名前を作れる位置
    expect(normalizeAttachmentName('report\u{200D}.pdf')).toBe('report_.pdf');
    expect(normalizeAttachmentName('a\u{200C}b')).toBe('a_b');
    expect(normalizeAttachmentName('a\u{200D}b')).toBe('a_b');
    // 先頭・末尾・連続
    expect(normalizeAttachmentName('\u{200D}\u{1F468}.png')).toBe('_\u{1F468}.png');
    expect(normalizeAttachmentName('\u{1F468}\u{200D}')).toBe('\u{1F468}_');
    expect(normalizeAttachmentName('\u{1F468}\u{200D}\u{200D}\u{1F469}')).toBe(
      '\u{1F468}__\u{1F469}',
    );
    // 絵文字と文字のあいだの ZWJ、アラビア文字の R（右にだけつながる）の後の ZWNJ
    expect(normalizeAttachmentName('\u{1F468}\u{200D}a')).toBe('\u{1F468}_a');
    expect(normalizeAttachmentName('\u{062F}\u{200C}\u{0628}')).toBe('\u{062F}_\u{0628}');
    // ZWNJ は Virama が無いとラテン文字のあいだでは残さない。ZWJ はアラビア文字のあいだでも残さない
    expect(normalizeAttachmentName('\u{0628}\u{200D}\u{0628}')).toBe('\u{0628}_\u{0628}');
    // ほかの書式制御文字は、文脈があっても _ にする
    expect(normalizeAttachmentName('\u{0915}\u{094D}\u{200B}\u{0937}')).toBe(
      '\u{0915}\u{094D}_\u{0937}',
    );
    expect(normalizeAttachmentName('\u{1F468}\u{202E}\u{1F469}')).toBe('\u{1F468}_\u{1F469}');
  });

  it('ZWJ・ZWNJ を残しても冪等である。255 単位の切り口に残った ZWJ も、もう一度通して変わらない（#3882・#3524）', () => {
    const names = [
      '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}.png',
      '\u{0645}\u{06CC}\u{200C}\u{062E}.pdf',
      'report\u{200D}.pdf',
      `${'a'.repeat(253)}\u{1F468}\u{200D}\u{1F469}`,
    ];
    for (const name of names) {
      const once = normalizeAttachmentName(name);
      expect(normalizeAttachmentName(once)).toBe(once);
    }
    // 切り口の直前に ZWJ が来る（後ろの絵文字が切り落とされる）ときは _ にする
    expect(normalizeAttachmentName(`${'a'.repeat(252)}\u{1F468}\u{200D}\u{1F469}`)).toBe(
      `${'a'.repeat(252)}\u{1F468}_`,
    );
  });

  it('normalizeAttachmentName は冪等である: 255 単位で切った結果が空白で終わっても、もう一度通すと名前が変わらない（#3524）', () => {
    const once = normalizeAttachmentName(`${'a'.repeat(254)} b`);
    expect(normalizeAttachmentName(once)).toBe(once);
    expect(once).toBe('a'.repeat(254));
  });

  it('ディスク名: 200 バイトまでは触らず、超えたら拡張子を残してコードポイントの途中で切らずに丸める（#3324）', () => {
    expect(attachmentDiskName('日本語.pdf')).toBe('日本語.pdf');
    const long = attachmentDiskName(`${'あ'.repeat(100)}.pdf`);
    expect(long.endsWith('.pdf')).toBe(true);
    expect(Buffer.byteLength(long, 'utf8')).toBeLessThanOrEqual(200);
    expect(long).toBe(`${'あ'.repeat(65)}.pdf`);
    // 4 バイト文字（サロゲートペア）も途中で切らない。
    const emoji = attachmentDiskName('😀'.repeat(100));
    expect(Buffer.byteLength(emoji, 'utf8')).toBeLessThanOrEqual(200);
    expect(emoji).toBe('😀'.repeat(50));
    expect(emoji).not.toContain('\ufffd');
    // 長すぎる「拡張子」は拡張子とみなさない。ドットだけ・先頭ドットでも空にならない。
    expect(
      Buffer.byteLength(attachmentDiskName(`a.${'b'.repeat(250)}`), 'utf8'),
    ).toBeLessThanOrEqual(200);
    expect(
      Buffer.byteLength(attachmentDiskName(`.${'b'.repeat(250)}`), 'utf8'),
    ).toBeLessThanOrEqual(200);
    expect(attachmentDiskName('')).toBe('file');
  });

  it('ディスク名: 切り口が ZWJ・ZWNJ の直後に来ても、孤立した ZWJ・ZWNJ は残さない（#3998）', () => {
    const lone = /[‌‍]/;
    // 絵文字（4 バイト）+ ZWJ（3 バイト）で 189 + 4 + 3 = 196 バイト。次の絵文字は切り落とされる。
    const zwj = `${'a'.repeat(189)}\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}.png`;
    // ペルシア語の ی（2 バイト）+ ZWNJ で 191 + 2 + 3 = 196 バイト。次の文字は切り落とされる。
    const zwnj = `${'a'.repeat(191)}\u{06CC}\u{200C}\u{062E}\u{0648}\u{0627}\u{0647}.pdf`;
    for (const [input, ext, expected] of [
      [zwj, '.png', `${'a'.repeat(189)}\u{1F468}_.png`],
      [zwnj, '.pdf', `${'a'.repeat(191)}\u{06CC}_.pdf`],
    ] as const) {
      const out = attachmentDiskName(input);
      expect(out).toBe(expected);
      expect(out).not.toMatch(lone);
      expect(out.endsWith(ext)).toBe(true);
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(200);
      expect(attachmentDiskName(out)).toBe(out);
    }
    // 切り口から離れた文脈のある ZWJ は残す。
    const kept = `\u{1F468}\u{200D}\u{1F469}${'a'.repeat(220)}.png`;
    const keptOut = attachmentDiskName(kept);
    expect(keptOut.startsWith('\u{1F468}\u{200D}\u{1F469}a')).toBe(true);
    expect(keptOut.endsWith('.png')).toBe(true);
    expect(Buffer.byteLength(keptOut, 'utf8')).toBeLessThanOrEqual(200);
    expect(attachmentDiskName(keptOut)).toBe(keptOut);
  });
});

describe('添付: インメモリ実装の契約', () => {
  it('verifyAttachmentStoreContract を通る', async () => {
    await verifyAttachmentStoreContract(createMemoryStores().attachments, {
      createStore: (options) => new MemoryAttachmentStore(options),
    });
  });
});

describe('添付: インメモリ実装は期限（expiresAt）を過ぎたものを読ませない（#3522）', () => {
  const PNG_BYTES = Uint8Array.from([...PNG, 7]);
  const DAY = 86_400_000;

  it('getMeta / get は、prune が走る前でも「無い」と答える', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const store = new MemoryAttachmentStore({ now: () => now });
    const meta = await store.put({ name: 'a.png', mediaType: 'image/png', bytes: PNG_BYTES });
    now = new Date(Date.parse(meta.expiresAt!) + 1000);
    expect(await store.getMeta(meta.id)).toBeUndefined();
    expect(await store.get(meta.id)).toBeUndefined();
  });

  it('bind は missing にする（結んだ直後の prune で発言の添付が黙って消えるのを避ける）', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const store = new MemoryAttachmentStore({ now: () => now });
    const meta = await store.put({ name: 'a.png', mediaType: 'image/png', bytes: PNG_BYTES });
    now = new Date(Date.parse(meta.expiresAt!) + DAY);
    const result = await store.bind([meta.id], 'conv-1');
    expect(result.bound).toEqual([]);
    expect(result.missing).toEqual([meta.id]);
  });
});

describe('添付: 出所の分類（#4126 P4）', () => {
  it('operator と account:* は human、clone は clone、manager:* は manager、integration:* は integration', () => {
    expect(classifyAttachmentFrom('operator')).toBe('human');
    expect(classifyAttachmentFrom('account:a1')).toBe('human');
    expect(classifyAttachmentFrom('clone')).toBe('clone');
    expect(classifyAttachmentFrom('manager:m1')).toBe('manager');
    expect(classifyAttachmentFrom('integration:k1')).toBe('integration');
  });

  it('無い・上の形に当たらないものは unknown（接頭辞の取り違えもここ）', () => {
    expect(classifyAttachmentFrom(undefined)).toBe('unknown');
    expect(classifyAttachmentFrom('')).toBe('unknown');
    expect(classifyAttachmentFrom('something')).toBe('unknown');
    expect(classifyAttachmentFrom('operator2')).toBe('unknown');
    expect(classifyAttachmentFrom('clone-x')).toBe('unknown');
    expect(classifyAttachmentFrom('account')).toBe('unknown');
    expect(classifyAttachmentFrom('manager')).toBe('unknown');
    expect(classifyAttachmentFrom('Operator')).toBe('unknown');
  });
});

describe('添付: 一覧の cursor（#4126 P4）', () => {
  it('encode したものを decode で戻せる', () => {
    const cursor = encodeAttachmentCursor({ createdAt: '2031-03-01T00:00:00.000Z', id: 'abc' });
    expect(decodeAttachmentCursor(cursor)).toEqual({
      createdAt: '2031-03-01T00:00:00.000Z',
      id: 'abc',
    });
  });

  it('読めない形は AttachmentCursorError（日時でない・形が違う・空）', () => {
    for (const raw of [
      '',
      'これは cursor ではない',
      Buffer.from('{}').toString('base64url'),
      Buffer.from('["not-a-date","x"]').toString('base64url'),
      Buffer.from('["2031-03-01T00:00:00.000Z"]').toString('base64url'),
      Buffer.from('["2031-03-01T00:00:00.000Z",1]').toString('base64url'),
    ]) {
      expect(() => decodeAttachmentCursor(raw), raw).toThrow(AttachmentCursorError);
    }
  });
});
