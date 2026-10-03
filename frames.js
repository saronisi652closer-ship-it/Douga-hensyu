// frames.js — 表示用とは別の隠し <video> からフレームを取り出す
// （タイムラインのサムネイル、候補のプレビュー画像、映像解析で共用）

import { once, clamp } from './utils.js';

function hiddenHost() {
  let host = document.getElementById('hidden-media');
  if (!host) {
    host = document.createElement('div');
    host.id = 'hidden-media';
    host.setAttribute('aria-hidden', 'true');
    document.body.append(host);
  }
  return host;
}

/** 画面に見えない <video> を作る（display:none だとフレームが更新されないため極小で配置） */
export function createHiddenVideo(url, { muted = true } = {}) {
  const v = document.createElement('video');
  v.muted = muted;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = url;
  hiddenHost().append(v);
  return v;
}
export function disposeVideo(v) {
  try { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); } catch { /* noop */ }
}

export class FrameGrabber {
  constructor(url) {
    this.video = createHiddenVideo(url);
    this.queue = this.video.readyState >= 1 ? Promise.resolve() : once(this.video, 'loadedmetadata', 20000).catch(() => {});
    this.dead = false;
  }
  async _seek(t) {
    const v = this.video;
    t = clamp(t, 0, Math.max(0, (v.duration || t) - 0.05));
    if (Math.abs(v.currentTime - t) < 0.005 && v.readyState >= 2) return;
    v.currentTime = t;
    await once(v, 'seeked', 8000);
  }
  /** 時刻 t のフレームを ctx に描く。順番待ちで1枚ずつ処理する */
  draw(t, ctx, w, h) {
    const job = this.queue.then(async () => {
      if (this.dead) throw new Error('disposed');
      await this._seek(t);
      ctx.drawImage(this.video, 0, 0, w, h);
    });
    this.queue = job.catch(() => {});
    return job;
  }
  dispose() { this.dead = true; disposeVideo(this.video); }
}

// ---------- タイムライン用サムネイル ----------
export const thumbs = { times: [], images: [], w: 0, h: 0, onUpdate: null };
let thumbRun = 0;

export function nearestThumb(t) {
  const { times, images } = thumbs;
  if (!times.length) return null;
  let lo = 0, hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1; else hi = mid;
  }
  const i = lo > 0 && Math.abs(times[lo - 1] - t) <= Math.abs(times[lo] - t) ? lo - 1 : lo;
  return images[i];
}

/** 動画全体から等間隔にサムネイルを作る（バックグラウンドで少しずつ） */
export async function buildThumbs(grabber, source) {
  const run = ++thumbRun;
  thumbs.times = []; thumbs.images = [];
  const h = 64;
  const w = Math.round(clamp(h * (source.width / source.height || 16 / 9), 36, 140));
  thumbs.w = w; thumbs.h = h;
  const count = clamp(Math.ceil(source.duration / 4), 8, 48);
  // 粗く全体 → 間を埋める順に取ると、途中でもタイムライン全体に絵が出る
  const order = [];
  for (let stride = 8; stride >= 1; stride >>= 1) {
    for (let i = 0; i < count; i++) if (i % stride === 0 && !order.includes(i)) order.push(i);
  }
  for (const i of order) {
    if (run !== thumbRun) return;
    const t = (i + 0.5) * (source.duration / count);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    try { await grabber.draw(t, c.getContext('2d'), w, h); } catch { continue; }
    if (run !== thumbRun) return;
    let pos = thumbs.times.findIndex((x) => x > t);
    if (pos < 0) pos = thumbs.times.length;
    thumbs.times.splice(pos, 0, t);
    thumbs.images.splice(pos, 0, c);
    thumbs.onUpdate?.();
  }
}
export function clearThumbs() { thumbRun++; thumbs.times = []; thumbs.images = []; }
