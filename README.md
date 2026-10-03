# キリトル（フォルダなし版）

すべてのファイルを **リポジトリの直下に同じ階層で** 置く版です。フォルダは作りません。

1. このフォルダの全ファイル（22個）をリポジトリ直下にアップロード
2. 以前アップロードした同名ファイルは上書きされます
3. Settings → Pages で `main` / `(root)` を公開
4. ページを開き直す（表示が変わらないときは再読み込み）

ファイルを更新したら `service-worker.js` の `VERSION` の数字を変えてください。

| ファイル | 役割 |
|---|---|
| `index.html` | 画面の骨組み |
| `style.css` | 見た目 |
| `app.js` | 起動、ホーム、タブ、編集ボタン、書き出し画面、自動保存 |
| `state.js` | プロジェクトの状態、元に戻す履歴、編集操作 |
| `video.js` | プレビュー再生 |
| `timeline.js` | タイムライン |
| `frames.js` | フレーム取得、サムネイル |
| `audio.js` | 音量解析 |
| `sceneAnalyzer.js` | 音と映像の特徴抽出 |
| `scoring.js` | 盛り上がり度の計算と候補選び |
| `recommend.js` | おすすめタブ |
| `export.js` | 書き出し |
| `storage.js` | IndexedDB 保存 |
| `utils.js` | 共通関数 |
| `manifest.json` / `service-worker.js` / `icon*.png` / `icon.svg` / `apple-touch-icon.png` | PWA |
