// audio.js — 音量の解析（Phase 2 で BGM・音量調整もここに追加する想定）

import { GRID } from './scoring.js';

const FLOOR_DB = -80;
export const toDb = (meanSquare) => Math.max(FLOOR_DB, 10 * Math.log10(meanSquare + 1e-9));

/**
 * 高速方式: ファイルの音声をまるごとデコードして、0.5秒ごとの音量(dB)を返す。
 * メモリを食うので小さめのファイル専用。音声が無い／読めない場合は例外。
 */
export async function decodeLevels(file, n) {
  const bytes = await file.arrayBuffer();
  // 低いサンプルレートで受け取り、デコード後のメモリを抑える
  let ctx;
  try { ctx = new OfflineAudioContext(1, 1, 8000); }
  catch { ctx = new OfflineAudioContext(1, 1, 22050); }
  const buf = await ctx.decodeAudioData(bytes);
  const sr = buf.sampleRate;
  const per = Math.round(sr * GRID);
  const level = new Float32Array(n).fill(FLOOR_DB);
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  const bins = Math.min(n, Math.ceil(buf.length / per));
  for (let b = 0; b < bins; b++) {
    const s0 = b * per, s1 = Math.min(buf.length, s0 + per);
    let sum = 0;
    for (const ch of chans) for (let i = s0; i < s1; i++) sum += ch[i] * ch[i];
    level[b] = toDb(sum / Math.max(1, (s1 - s0) * chans.length));
  }
  return level;
}

/**
 * 省メモリ方式: 再生中の <video> の音量をリアルタイムに読む。
 * スピーカーには出さない（無音のまま解析する）。
 */
export function createLiveMeter(mediaEl) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  const src = ctx.createMediaElementSource(mediaEl);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(analyser);
  analyser.connect(mute);
  mute.connect(ctx.destination); // 出力につながないと処理されないブラウザがあるため
  const buf = new Float32Array(analyser.fftSize);
  return {
    ctx,
    resume: () => ctx.resume(),
    /** 直近の平均二乗値 */
    read() {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      return sum / buf.length;
    },
    close() { try { src.disconnect(); ctx.close(); } catch { /* noop */ } },
  };
}
