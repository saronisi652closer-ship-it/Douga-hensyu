// export.js — タイムラインを1本の動画として書き出す
//
// 方式: 隠し <video> をクリップ順に再生 → キャンバスに描画 → MediaRecorder で録画。
// ライブラリ不要・オフラインで動く代わりに、書き出しには動画の長さと同程度の時間がかかる。
// クリップの切れ目ではレコーダーを一時停止し、シーク中の絵が入らないようにしている。
// Phase 2 のテロップ・画面比率・速度変更は drawFrame() とここでの再生制御に足していく。

import { createHiddenVideo, disposeVideo } from './frames.js';
import { clipStarts, totalDuration } from './state.js';
import { once, sleep } from './utils.js';

const CANDIDATES = {
  // H.264 で録れる場合だけ MP4 を出す（中身が VP9 の MP4 は再生できない機器が多いため）
  mp4: ['video/mp4;codecs="avc1.640028,mp4a.40.2"', 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4;codecs="avc1.42E01E"', 'video/mp4;codecs=avc1'],
  webm: ['video/webm;codecs="vp9,opus"', 'video/webm;codecs="vp8,opus"', 'video/webm'],
};

/** このブラウザで書き出せる形式 */
export function supportedFormats() {
  if (typeof MediaRecorder === 'undefined') return [];
  const out = [];
  for (const [id, list] of Object.entries(CANDIDATES)) {
    const mime = list.find((m) => MediaRecorder.isTypeSupported(m));
    if (mime) out.push({ id, mime, ext: id, label: id === 'mp4' ? 'MP4' : 'WebM' });
  }
  // どちらも駄目だが MP4 だけは録れるブラウザ（Safari など）向け
  if (!out.length && MediaRecorder.isTypeSupported('video/mp4')) out.push({ id: 'mp4', mime: 'video/mp4', ext: 'mp4', label: 'MP4' });
  return out;
}
export function resolveFormat(id) {
  const all = supportedFormats();
  return all.find((f) => f.id === id) ?? all[0] ?? null;
}

/** 画質(短辺のピクセル数)から出力サイズを決める。元より大きくはしない */
export function outputSize(source, quality) {
  const short = Math.min(source.width, source.height);
  const scale = Math.min(1, quality / short);
  const even = (x) => Math.max(2, Math.round((x * scale) / 2) * 2);
  return { width: even(source.width), height: even(source.height) };
}
export function autoBitrate(width, height, fps) {
  return Math.round(Math.min(16e6, Math.max(1e6, width * height * fps * 0.15)));
}
/** 書き出し後のおおよそのファイルサイズ(バイト) */
export function estimateBytes(settings, source, seconds) {
  const { width, height } = outputSize(source, settings.quality);
  const v = settings.bitrate || autoBitrate(width, height, settings.fps);
  return ((v + 128000) / 8) * seconds;
}

/**
 * @param opts { url, clips, source, settings:{format,quality,fps,bitrate}, signal, onProgress(ratio) }
 * @returns { blob, ext, mime, width, height }
 */
export async function exportVideo({ url, clips, source, settings, signal, onProgress }) {
  const format = resolveFormat(settings.format);
  if (!format) throw new Error('このブラウザは動画の書き出し（MediaRecorder）に対応していません');
  const { width, height } = outputSize(source, settings.quality);
  const fps = settings.fps;
  const total = totalDuration(clips);
  const starts = clipStarts(clips);

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  const v = createHiddenVideo(url, { muted: false });
  let ac = null, rec = null, watchdog = null;
  const chunks = [];

  const drawFrame = () => ctx.drawImage(v, 0, 0, width, height);
  const aborted = () => signal?.aborted;
  const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

  try {
    if (v.readyState < 1) await once(v, 'loadedmetadata', 20000);

    // 音声: 動画の音をレコーダーへ直接つなぐ（スピーカーからは鳴らさない）
    const AC = window.AudioContext || window.webkitAudioContext;
    ac = new AC();
    const srcNode = ac.createMediaElementSource(v);
    const dest = ac.createMediaStreamDestination();
    srcNode.connect(dest);
    await ac.resume();

    const stream = new MediaStream([...canvas.captureStream(fps).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    rec = new MediaRecorder(stream, {
      mimeType: format.mime,
      videoBitsPerSecond: settings.bitrate || autoBitrate(width, height, fps),
      audioBitsPerSecond: 128000,
    });
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    const stopped = new Promise((resolve, reject) => {
      rec.onstop = resolve;
      rec.onerror = (e) => reject(e.error || new Error('録画中にエラーが発生しました'));
    });

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      if (aborted()) throw abortError();
      v.currentTime = clip.in;
      await once(v, 'seeked', 15000);
      drawFrame();
      if (i === 0) rec.start(1000); else rec.resume();
      await v.play();

      await new Promise((resolve, reject) => {
        let done = false;
        const finish = (err) => {
          if (done) return;
          done = true;
          clearInterval(watchdog);
          err ? reject(err) : resolve();
        };
        const report = () => onProgress?.(Math.min(1, (starts[i] + Math.max(0, v.currentTime - clip.in)) / total));
        // 新しいフレームが出るたびに描画（対応ブラウザ）。未対応なら rAF で代用
        const useVfc = 'requestVideoFrameCallback' in v;
        const onFrame = (_now, meta) => {
          if (done) return;
          drawFrame();
          const t = meta?.mediaTime ?? v.currentTime;
          if (t >= clip.out - 0.5 / fps) return finish();
          useVfc ? v.requestVideoFrameCallback(onFrame) : requestAnimationFrame(() => onFrame());
        };
        useVfc ? v.requestVideoFrameCallback(onFrame) : requestAnimationFrame(() => onFrame());
        // 終端・中止・停止の見張り（フレームコールバックは動画が終わると来ないため）
        let lastT = -1, lastMove = performance.now();
        watchdog = setInterval(() => {
          report();
          if (aborted()) return finish(abortError());
          if (v.ended || v.currentTime >= clip.out) return finish();
          if (v.currentTime !== lastT) { lastT = v.currentTime; lastMove = performance.now(); }
          else if (performance.now() - lastMove > 20000) finish(new Error('再生が進まなくなったため書き出しを中断しました'));
          else if (performance.now() - lastMove > 4000 && v.paused) v.play().catch(() => {});
        }, 100);
      });

      v.pause();
      if (rec.state === 'recording') rec.pause();
    }

    await sleep(50);
    rec.stop();
    await stopped;
    onProgress?.(1);
    return { blob: new Blob(chunks, { type: format.mime.split(';')[0] }), ext: format.ext, mime: format.mime, width, height };
  } finally {
    clearInterval(watchdog);
    try { if (rec && rec.state !== 'inactive') rec.stop(); } catch { /* noop */ }
    try { ac?.close(); } catch { /* noop */ }
    disposeVideo(v);
  }
}
