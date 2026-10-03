// video.js — プレビュー再生。タイムライン上の時間と元動画の時間を対応させる
//
// 2つのモードがある:
//  timeline … クリップを順番につないで再生（編集結果のプレビュー）
//  source   … 元動画の指定範囲だけを再生（おすすめ候補の確認用）

import { state, locate, clipStarts, totalDuration, emit } from './state.js';
import { clamp, once } from './utils.js';

const EPS = 0.03;

export class Player {
  constructor(video) {
    this.video = video;
    this.mode = 'timeline';
    this.T = 0;              // タイムライン上の再生位置（秒）
    this.index = 0;          // 再生中のクリップ番号
    this.range = null;       // source モードの {a, b}
    this.playing = false;
    this._raf = 0;
    this._pendingSeek = null;
    this._switchedAt = 0;
    video.addEventListener('seeked', () => {
      if (this._pendingSeek != null) {
        const t = this._pendingSeek; this._pendingSeek = null;
        this.video.currentTime = t;
      }
    });
    // 外部要因（イヤホン抜けなど）で止まったときに表示を合わせる。クリップ切替直後の pause は無視
    video.addEventListener('pause', () => {
      if (this.playing && !video.ended && performance.now() - this._switchedAt > 400) this._setPlaying(false);
    });
  }

  /** 動画ファイルを読み込み、情報を返す */
  async load(url) {
    const v = this.video;
    this.pause();
    v.src = url;
    await once(v, 'loadedmetadata', 30000);
    // 一部の WebM は長さが Infinity になるので、末尾へシークして確定させる
    if (!isFinite(v.duration)) {
      v.currentTime = 1e9;
      await once(v, 'durationchange', 10000).catch(() => {});
      v.currentTime = 0;
      await once(v, 'seeked', 5000).catch(() => {});
    }
    if (!isFinite(v.duration) || v.duration <= 0) throw new Error('動画の長さを取得できませんでした');
    if (!v.videoWidth) throw new Error('映像トラックを読み込めませんでした');
    this.mode = 'timeline'; this.T = 0; this.index = 0;
    return { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
  }

  /** シークが重なったら最後の1つだけ実行する（スクラブを滑らかに） */
  _seekSource(t) {
    const v = this.video;
    t = clamp(t, 0, Math.max(0, v.duration - 0.01));
    if (v.seeking) this._pendingSeek = t;
    else v.currentTime = t;
  }

  _setPlaying(p) {
    if (this.playing === p) return;
    this.playing = p;
    cancelAnimationFrame(this._raf);
    if (p) this._raf = requestAnimationFrame(() => this._tick());
    emit('playstate', p);
  }

  /** タイムライン位置へ移動 */
  seek(T, { keepPlaying = false } = {}) {
    if (!keepPlaying) this.pause();
    this._exitSource();
    const total = totalDuration();
    this.T = clamp(T, 0, total);
    const loc = locate(Math.min(this.T, Math.max(0, total - 0.001)));
    if (loc) { this.index = loc.index; this._seekSource(loc.sourceTime); }
    emit('time', this.T);
  }

  async play() {
    const v = this.video;
    if (this.mode === 'source') {
      if (v.currentTime >= this.range.b - EPS) v.currentTime = this.range.a;
    } else {
      const total = totalDuration();
      if (total <= 0) return;
      if (this.T >= total - 0.05) this.T = 0;
      const loc = locate(this.T);
      this.index = loc.index;
      if (Math.abs(v.currentTime - loc.sourceTime) > 0.05) v.currentTime = loc.sourceTime;
    }
    try { await v.play(); this._setPlaying(true); }
    catch { this._setPlaying(false); }
  }
  pause() {
    this._setPlaying(false);
    if (!this.video.paused) this.video.pause();
  }
  toggle() { this.playing ? this.pause() : this.play(); }

  _tick() {
    if (!this.playing) return;
    const v = this.video;
    const s = v.currentTime;
    if (this.mode === 'source') {
      if (s >= this.range.b - EPS || v.ended) { this.pause(); emit('sourcetime', this.range.b); return; }
      emit('sourcetime', s);
    } else {
      const clips = state.project.clips;
      const clip = clips[this.index];
      if (!clip) { this.pause(); return; }
      const starts = clipStarts(clips);
      if (!v.seeking && (s >= clip.out - EPS || v.ended)) {
        // クリップの終わり → 次のクリップの頭へ
        if (this.index + 1 < clips.length) {
          this.index++;
          this._switchedAt = performance.now();
          v.currentTime = clips[this.index].in;
          if (v.paused || v.ended) v.play().catch(() => {});
          this.T = starts[this.index];
        } else {
          this.T = totalDuration(clips);
          this.pause();
          emit('time', this.T);
          return;
        }
      } else if (!v.seeking) {
        this.T = starts[this.index] + clamp(s - clip.in, 0, clip.out - clip.in);
      }
      emit('time', this.T);
    }
    this._raf = requestAnimationFrame(() => this._tick());
  }

  // ---------- source モード ----------
  /** 元動画の a〜b を確認再生 */
  previewSource(a, b, autoplay = true) {
    this.pause();
    this.mode = 'source';
    this.range = { a, b };
    this.video.currentTime = a;
    emit('mode', this.mode);
    emit('sourcetime', a);
    if (autoplay) this.play();
  }
  /** 元動画の1コマを表示（トリミング中の確認用。再生位置は動かさない） */
  showSourceFrame(t) {
    this.pause();
    this._seekSource(t);
  }
  _exitSource() {
    if (this.mode === 'source') {
      this.mode = 'timeline';
      this.range = null;
      emit('mode', this.mode);
    }
  }
  backToTimeline() { this.seek(this.T); }
}
