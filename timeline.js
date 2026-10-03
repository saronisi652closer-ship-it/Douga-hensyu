// timeline.js — タイムラインの表示と操作（再生位置の移動・クリップ選択・端をドラッグしてトリミング）
//
// 構成: 横スクロールする箱の中に
//   ・背景キャンバス（目盛りとサムネイル。見えている範囲だけ描く）
//   ・クリップ（DOM。選択中だけ左右にハンドルが出る）
//   ・再生ヘッド
// Phase 2 でテロップ/BGM のトラックを足すときは TRACKS に行を追加する。

import { state, on, clipStarts, clipLen, totalDuration, select, checkpoint, setClipRange, MIN_CLIP } from './state.js';
import { clamp, fmtTime, el } from './utils.js';
import { thumbs, nearestThumb } from './frames.js';

const PAD = 20;        // 左の余白(px)
const PAD_R = 36;      // 右の余白(px)
const RULER_H = 22;
const TRACK_Y = 26;
const TRACK_H = 52;
const MAX_PPS = 120;

export class Timeline {
  /** @param root 入れ物の要素  @param player Player */
  constructor(root, player) {
    this.player = player;
    this.pps = 10;         // 1秒あたりのピクセル数
    this.fit = true;       // 全体表示を維持するか
    this.drag = null;      // トリミング中の情報
    this.T = 0;

    this.canvas = el('canvas', { class: 'tl-canvas' });
    this.rulerHit = el('div', { class: 'tl-ruler-hit' });
    this.clipLayer = el('div', { class: 'tl-clips' });
    this.playhead = el('div', { class: 'tl-playhead' });
    this.content = el('div', { class: 'tl-content' }, this.canvas, this.rulerHit, this.clipLayer, this.playhead);
    this.scroll = el('div', { class: 'tl-scroll' }, this.content);
    root.append(this.scroll);
    this.ctx = this.canvas.getContext('2d');

    this.scroll.addEventListener('scroll', () => this.draw(), { passive: true });
    new ResizeObserver(() => { if (this.fit) this.zoomFit(); else this.layout(); }).observe(this.scroll);
    this._bindPointer();

    on('clips', (d) => { if (this.fit && !this.drag) this.zoomFit(); else this.layout(); });
    on('selection', () => this.layout());
    on('time', (T) => this.setTime(T, true));
    on('project', () => { this.fit = true; this.T = 0; });
    thumbs.onUpdate = () => this.draw();
  }

  get viewW() { return this.scroll.clientWidth; }
  xOf(T) { return PAD + T * this.pps; }
  tOf(x) { return (x - PAD) / this.pps; }
  /** ポインタ位置 → コンテンツ内の x */
  _localX(e) { return e.clientX - this.scroll.getBoundingClientRect().left + this.scroll.scrollLeft; }

  // ---------- ズーム ----------
  fitPps() {
    const total = Math.max(0.1, totalDuration());
    return clamp((this.viewW - PAD - PAD_R) / total, 0.01, MAX_PPS);
  }
  zoomFit() { this.fit = true; this.pps = this.fitPps(); this.layout(); }
  zoom(factor) {
    const min = Math.min(this.fitPps(), MAX_PPS);
    const next = clamp(this.pps * factor, min, MAX_PPS);
    this.fit = next <= min * 1.001;
    // 再生ヘッドの画面上の位置を保ったまま拡大縮小
    const anchor = this.xOf(this.T) - this.scroll.scrollLeft;
    this.pps = next;
    this.layout();
    this.scroll.scrollLeft = this.xOf(this.T) - anchor;
    this.draw();
  }

  // ---------- レイアウト ----------
  layout() {
    if (!state.project) return;
    const clips = state.project.clips;
    const starts = clipStarts(clips);
    const total = totalDuration(clips);
    this.content.style.width = Math.max(this.viewW, PAD + PAD_R + total * this.pps) + 'px';

    const nodes = clips.map((c, i) => {
      const selected = c.id === state.selectedClipId;
      let left = this.xOf(starts[i]);
      // 左端をドラッグ中は、指に端が付いてくるように対象以降をずらして見せる
      if (this.drag?.side === 'l' && i >= this.drag.index) left += (clips[this.drag.index].in - this.drag.in0) * this.pps;
      const w = clipLen(c) * this.pps;
      const node = el('div', {
        class: 'tl-clip' + (selected ? ' selected' : ''),
        style: { left: left + 'px', width: Math.max(2, w) + 'px' },
        dataset: { id: c.id },
      });
      if (w > 46) node.append(el('span', { class: 'tl-clip-label' }, fmtTime(clipLen(c), clipLen(c) < 60)));
      if (selected) {
        node.append(el('div', { class: 'tl-handle l', dataset: { side: 'l' } }), el('div', { class: 'tl-handle r', dataset: { side: 'r' } }));
      }
      return node;
    });
    this.clipLayer.replaceChildren(...nodes);
    this.setTime(Math.min(this.T, total), false);
    this.draw();
  }

  setTime(T, follow) {
    this.T = T;
    const x = this.xOf(T);
    this.playhead.style.transform = `translateX(${x}px)`;
    if (follow && this.player.playing) {
      const sl = this.scroll.scrollLeft, vw = this.viewW;
      if (x > sl + vw - 24 || x < sl) this.scroll.scrollLeft = x - vw * 0.2;
    }
  }
  /** 再生ヘッドが見える位置までスクロール */
  reveal() {
    const x = this.xOf(this.T), sl = this.scroll.scrollLeft, vw = this.viewW;
    if (x > sl + vw - 24 || x < sl + 8) this.scroll.scrollLeft = x - vw / 2;
  }

  // ---------- 背景の描画（目盛り＋サムネイル） ----------
  draw() {
    if (!state.project) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.viewW, h = TRACK_Y + TRACK_H + 6;
    if (!w) return;
    const cv = this.canvas;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
    }
    const ctx = this.ctx;
    const css = getComputedStyle(document.documentElement);
    const sl = this.scroll.scrollLeft;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 目盛り
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const step = steps.find((s) => s * this.pps >= 64) ?? 3600;
    ctx.fillStyle = css.getPropertyValue('--muted').trim() || '#99a';
    ctx.strokeStyle = css.getPropertyValue('--line').trim() || '#445';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const total = totalDuration();
    const t0 = Math.max(0, Math.floor(this.tOf(sl) / step) * step);
    ctx.beginPath();
    for (let t = t0; t <= total + 1e-6 && this.xOf(t) - sl < w + 40; t += step) {
      const x = Math.round(this.xOf(t) - sl) + 0.5;
      ctx.moveTo(x, RULER_H - 6); ctx.lineTo(x, RULER_H);
      ctx.fillText(fmtTime(t, step < 1), x + 4, RULER_H / 2 - 1);
    }
    ctx.stroke();

    // クリップのサムネイル
    const clips = state.project.clips;
    const starts = clipStarts(clips);
    const tw = thumbs.w ? thumbs.w * (TRACK_H / thumbs.h) : 80;
    clips.forEach((c, i) => {
      let x0 = this.xOf(starts[i]) - sl;
      if (this.drag?.side === 'l' && i >= this.drag.index) x0 += (clips[this.drag.index].in - this.drag.in0) * this.pps;
      const cw = clipLen(c) * this.pps;
      if (x0 + cw < 0 || x0 > w) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, TRACK_Y, cw, TRACK_H);
      ctx.clip();
      ctx.fillStyle = css.getPropertyValue('--clip').trim() || '#334';
      ctx.fillRect(x0, TRACK_Y, cw, TRACK_H);
      const first = Math.max(0, Math.floor(-x0 / tw));
      for (let k = first; k * tw < cw && x0 + k * tw < w; k++) {
        const srcT = c.in + ((k + 0.5) * tw) / this.pps;
        const img = nearestThumb(Math.min(srcT, c.out));
        if (img) ctx.drawImage(img, x0 + k * tw, TRACK_Y, tw, TRACK_H);
      }
      ctx.restore();
    });
  }

  // ---------- 操作 ----------
  _bindPointer() {
    const content = this.content;
    let tap = null, scrub = false;

    content.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('.tl-handle');
      if (handle) { this._startTrim(e, handle); return; }
      if (e.target === this.rulerHit || e.pointerType === 'mouse') {
        // 目盛り部分（マウスならどこでも）はドラッグで再生位置を動かす
        scrub = true;
        content.setPointerCapture(e.pointerId);
        this._seekFromEvent(e, true);
        e.preventDefault();
        return;
      }
      tap = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    content.addEventListener('pointermove', (e) => {
      if (this.drag) this._moveTrim(e);
      else if (scrub) this._seekFromEvent(e, false);
    });
    const end = (e) => {
      if (this.drag) { this._endTrim(); return; }
      if (scrub) { scrub = false; return; }
      if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 8 && performance.now() - tap.t < 600) {
        this._seekFromEvent(e, true);
      }
      tap = null;
    };
    content.addEventListener('pointerup', end);
    content.addEventListener('pointercancel', () => { if (this.drag) this._endTrim(); scrub = false; tap = null; });
  }

  _seekFromEvent(e, selectClip) {
    const total = totalDuration();
    const T = clamp(this.tOf(this._localX(e)), 0, total);
    this.player.seek(T);
    if (selectClip) {
      const node = e.target.closest?.('.tl-clip');
      if (node) select(node.dataset.id);
      else {
        // 目盛りをタップしたときは、その位置のクリップを選ぶ
        const starts = clipStarts();
        const i = starts.findLastIndex((s) => s <= T);
        if (i >= 0) select(state.project.clips[Math.min(i, starts.length - 1)].id);
      }
    }
  }

  _startTrim(e, handle) {
    const id = handle.parentElement.dataset.id;
    const clips = state.project.clips;
    const index = clips.findIndex((c) => c.id === id);
    const c = clips[index];
    checkpoint();
    this.player.pause();
    this.drag = { id, index, side: handle.dataset.side, x0: e.clientX, in0: c.in, out0: c.out, scroll0: this.scroll.scrollLeft };
    this.content.setPointerCapture(e.pointerId);
    this.content.classList.add('trimming');
    e.preventDefault();
  }
  _moveTrim(e) {
    const d = this.drag;
    const dt = (e.clientX - d.x0 + (this.scroll.scrollLeft - d.scroll0)) / this.pps;
    const dur = state.project.source.duration;
    if (d.side === 'l') {
      const inT = clamp(d.in0 + dt, 0, d.out0 - MIN_CLIP);
      setClipRange(d.id, inT, d.out0, { trimming: true });
      this.player.showSourceFrame(inT);
    } else {
      const outT = clamp(d.out0 + dt, d.in0 + MIN_CLIP, dur);
      setClipRange(d.id, d.in0, outT, { trimming: true });
      this.player.showSourceFrame(Math.max(d.in0, outT - 0.05));
    }
  }
  _endTrim() {
    const d = this.drag;
    this.drag = null;
    this.content.classList.remove('trimming');
    // 端を動かしたクリップの、動かした側へ再生位置を合わせる
    const starts = clipStarts();
    const c = state.project.clips[d.index];
    const T = d.side === 'l' ? starts[d.index] : starts[d.index] + clipLen(c) - 0.05;
    if (this.fit) this.zoomFit(); else this.layout();
    this.player.seek(Math.max(0, T));
  }
}
