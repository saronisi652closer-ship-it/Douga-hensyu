// sceneAnalyzer.js — 動画から「音量」と「映像の変化」を取り出す（AI・外部サーバー不使用）
//
// 2つの方式がある:
//  fast … 音声をまるごとデコード＋映像は飛び飛びにシークして取得。速いがメモリを使う
//  play … 隠し <video> を4倍速で再生しながら音と映像を同時に読む。大きな動画でも省メモリ
// どちらも全フレームは見ず、一定間隔でサンプリングする。

import { GRID } from './scoring.js';
import { decodeLevels, createLiveMeter, toDb } from './audio.js';
import { FrameGrabber, createHiddenVideo, disposeVideo } from './frames.js';
import { clamp, once, sleep } from './utils.js';

const FW = 48, FH = 27; // 解析用に縮小したフレームサイズ
const PLAY_RATE = 4;    // これ以上はブラウザが音を消すため 4 倍まで

class Aborted extends Error { constructor() { super('aborted'); this.name = 'AbortError'; } }
const check = (signal) => { if (signal?.aborted) throw new Aborted(); };

/** 縮小フレームから 明るさ・彩度・前フレームとの差 を計算 */
function makeFrameMeter() {
  const canvas = document.createElement('canvas');
  canvas.width = FW; canvas.height = FH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let prev = null;
  return {
    ctx,
    measure() {
      const d = ctx.getImageData(0, 0, FW, FH).data;
      const gray = new Uint8Array(FW * FH);
      let lumaSum = 0, satSum = 0, diffSum = 0;
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const y = (r * 77 + g * 150 + b * 29) >> 8;
        gray[p] = y;
        lumaSum += y;
        satSum += Math.max(r, g, b) - Math.min(r, g, b);
        if (prev) diffSum += Math.abs(y - prev[p]);
      }
      const px = FW * FH;
      const out = { luma: lumaSum / px / 255, sat: satSum / px / 255, diff: prev ? diffSum / px / 255 : 0 };
      prev = gray;
      return out;
    },
  };
}

function fillForward(arr, has) {
  let last = 0, seen = false;
  for (let i = 0; i < arr.length; i++) {
    if (has[i]) { last = arr[i]; seen = true; } else if (seen) arr[i] = last;
  }
  // 先頭の空きは最初の値で埋める
  const first = has.indexOf(1);
  if (first > 0) for (let i = 0; i < first; i++) arr[i] = arr[first];
}

// ---------- fast: シークしながら映像を取得 ----------
async function videoBySeeking({ url, duration, n, signal, onProgress }) {
  const step = clamp(duration / 900, GRID, 4);
  const grabber = new FrameGrabber(url);
  const meter = makeFrameMeter();
  const diff = new Float32Array(n), luma = new Float32Array(n), sat = new Float32Array(n);
  const has = new Uint8Array(n);
  try {
    const total = Math.max(1, Math.floor(duration / step));
    for (let s = 0; s < total; s++) {
      check(signal);
      const t = Math.min(duration - 0.05, s * step + step / 2);
      try { await grabber.draw(t, meter.ctx, FW, FH); } catch { continue; }
      const m = meter.measure();
      const bin = Math.min(n - 1, Math.floor(t / GRID));
      diff[bin] = m.diff; luma[bin] = m.luma; sat[bin] = m.sat; has[bin] = 1;
      onProgress?.(s / total);
    }
  } finally { grabber.dispose(); }
  fillForward(diff, has); fillForward(luma, has); fillForward(sat, has);
  return { diff, luma, sat, videoStep: step };
}

// ---------- play: 4倍速再生で音と映像を同時に取得 ----------
async function byPlayback({ url, duration, n, signal, onProgress }) {
  const step = clamp(duration / 1500, GRID, 2);
  const v = createHiddenVideo(url, { muted: false });
  const meter = makeFrameMeter();
  let live = null, timer = null;
  const sumsq = new Float64Array(n), cnt = new Uint32Array(n);
  const diff = new Float32Array(n), luma = new Float32Array(n), sat = new Float32Array(n);
  const has = new Uint8Array(n);
  try {
    if (v.readyState < 1) await once(v, 'loadedmetadata', 20000);
    live = createLiveMeter(v);
    await live.resume();
    v.playbackRate = PLAY_RATE;
    let nextSample = 0;
    timer = setInterval(() => {
      const t = v.currentTime;
      const bin = Math.min(n - 1, Math.floor(t / GRID));
      sumsq[bin] += live.read(); cnt[bin]++;
      if (t >= nextSample && v.readyState >= 2) {
        meter.ctx.drawImage(v, 0, 0, FW, FH);
        const m = meter.measure();
        diff[bin] = m.diff; luma[bin] = m.luma; sat[bin] = m.sat; has[bin] = 1;
        nextSample = t + step;
      }
    }, 12);
    await v.play();

    let lastT = -1, lastMove = performance.now();
    while (!v.ended && v.currentTime < duration - 0.15) {
      check(signal);
      await sleep(200);
      if (v.currentTime !== lastT) { lastT = v.currentTime; lastMove = performance.now(); }
      else {
        const idle = performance.now() - lastMove;
        if (idle > 6000 && v.paused) v.play().catch(() => {});
        if (idle > 25000) throw new Error('再生が進まなくなったため解析を中断しました');
      }
      onProgress?.(v.currentTime / duration);
    }
  } finally {
    clearInterval(timer);
    live?.close();
    disposeVideo(v);
  }
  const level = new Float32Array(n);
  let heard = false, last = -80;
  for (let i = 0; i < n; i++) {
    if (cnt[i]) { last = toDb(sumsq[i] / cnt[i]); if (last > -70) heard = true; }
    level[i] = last;
  }
  fillForward(diff, has); fillForward(luma, has); fillForward(sat, has);
  return { level, diff, luma, sat, videoStep: step, hasAudio: heard };
}

/** 自動選択時に fast を使うファイルサイズ上限（端末メモリに応じて変える） */
function fastLimitBytes() {
  const mem = navigator.deviceMemory || 4;
  return (mem >= 8 ? 700 : 200) * 1024 * 1024;
}
export function chooseMethod(file, mode = 'auto') {
  if (mode === 'fast' || mode === 'play') return mode;
  return file.size <= fastLimitBytes() ? 'fast' : 'play';
}

/**
 * 動画を解析する
 * @param opts { file, url, duration, mode:'auto'|'fast'|'play', signal, onProgress(stage, ratio) }
 * @returns analysis（state.project.analysis にそのまま保存できる形）
 */
export async function analyze({ file, url, duration, mode = 'auto', signal, onProgress }) {
  const n = Math.max(1, Math.ceil(duration / GRID));
  let method = chooseMethod(file, mode);
  let result = null;

  if (method === 'fast') {
    let level = null;
    onProgress?.('音声を解析', 0);
    try {
      level = await decodeLevels(file, n);
    } catch (e) {
      // 音声なし、またはメモリ不足・非対応。自動のときは省メモリ方式に切り替える
      if (mode === 'auto') method = 'play';
    }
    check(signal);
    if (method === 'fast') {
      const vid = await videoBySeeking({ url, duration, n, signal, onProgress: (r) => onProgress?.('映像を解析', r) });
      result = { ...vid, level: level ?? new Float32Array(n).fill(-80), hasAudio: !!level };
    }
  }
  if (method === 'play') {
    result = await byPlayback({ url, duration, n, signal, onProgress: (r) => onProgress?.('音声と映像を解析', r) });
  }
  return { grid: GRID, n, duration, method, ...result };
}
