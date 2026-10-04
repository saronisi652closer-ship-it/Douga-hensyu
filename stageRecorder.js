// stageRecorder.js — 収録画面のキャンバスと音声を「1本の映像ストリーム」にまとめ、録画する
//
// 2つに分けてある:
//   createStageStream() … キャンバス＋音声 → MediaStream（出力先を選ばない）
//   StageRecorder       … その MediaStream を録画して Blob にする
// 将来ライブ配信を足すときは、同じ MediaStream を別の出力（配信用クラス）に渡せばよい。
//
// 書き出し形式の判定とビットレートの目安は、既存の export.js の関数をそのまま借りている
// （export.js 側は変更していない）。

import { resolveFormat, autoBitrate } from './export.js';

/** キャンバスの映像と音声トラックを1つのストリームにまとめる */
export function createStageStream(canvas, audioTrack, fps = 30) {
  const video = canvas.captureStream(fps);
  const tracks = [...video.getVideoTracks()];
  if (audioTrack) tracks.push(audioTrack);
  return new MediaStream(tracks);
}

export class StageRecorder {
  /**
   * @param stream  createStageStream() の結果
   * @param opts    { width, height, fps }
   */
  constructor(stream, { width, height, fps = 30 }) {
    const format = resolveFormat('auto'); // MP4(H.264) が録れるならMP4、無理ならWebM
    if (!format) throw new Error('このブラウザは録画（MediaRecorder）に対応していません');
    this.format = format;
    this.chunks = [];
    this.rec = new MediaRecorder(stream, {
      mimeType: format.mime,
      videoBitsPerSecond: autoBitrate(width, height, fps),
      audioBitsPerSecond: 128000,
    });
    // 1秒ごとに受け取っておく（途中で問題が起きても、そこまでの分は残る）
    this.rec.ondataavailable = (e) => { if (e.data?.size) this.chunks.push(e.data); };
    this.startedAt = 0;
  }

  get recording() { return this.rec.state === 'recording'; }
  /** 録画開始からの秒数 */
  get elapsed() { return this.startedAt ? (performance.now() - this.startedAt) / 1000 : 0; }

  start() {
    this.chunks.length = 0;
    this.rec.start(1000);
    this.startedAt = performance.now();
  }

  /** 録画を止めて結果を返す → { blob, ext, seconds } */
  stop() {
    return new Promise((resolve) => {
      const seconds = this.elapsed;
      const finish = () => resolve({
        blob: new Blob(this.chunks, { type: this.format.mime.split(';')[0] }),
        ext: this.format.ext,
        seconds,
      });
      if (this.rec.state === 'inactive') return finish();
      this.rec.onstop = finish;
      this.rec.onerror = finish; // エラーで止まっても、受け取り済みの分は返す
      this.rec.stop();
    });
  }
}
