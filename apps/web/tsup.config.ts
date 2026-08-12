import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/server.ts'],
    format: ['esm'],
    // CLI（`alteroid web`）が startWebServer を呼ぶため型定義を出す
    dts: true,
    clean: true,
    sourcemap: true,
  },
  {
    // 画面側。ブラウザ向けに束ねて dist/public へ出し、public/ の
    // index.html・styles.css を同じ場所へ写す（配信するのはこの1ディレクトリだけ）。
    entry: { main: 'src/client/main.ts' },
    outDir: 'dist/public',
    format: ['esm'],
    platform: 'browser',
    target: 'es2022',
    publicDir: 'public',
    // 1つ目の設定が dist/ を消したあとに走るので、ここで消すと写した分まで失う
    clean: false,
    sourcemap: true,
  },
]);
