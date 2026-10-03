// state.js — プロジェクトの状態・元に戻す履歴・タイムライン計算
//
// project = {
//   id, updatedAt,
//   source:   { name, size, lastModified, type, duration, width, height },
//   clips:    [{ id, in, out }]            // in/out は元動画の秒。並び順 = タイムライン順
//   analysis: null | { grid, n, level, diff, luma, sat, hasAudio, method }
//   recommend:{ count, length, excluded:[{in,out}] }
//   exportSettings: { format, quality, fps, bitrate }
// }
// Phase 2 以降はここに texts / bgm / speed / aspect を追加していく想定。

import { uid, clamp } from './utils.js';

export const MIN_CLIP = 0.1;

const listeners = new Map();
export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type).delete(fn);
}
export function emit(type, detail) {
  listeners.get(type)?.forEach((fn) => fn(detail));
}

export const state = {
  project: null,
  file: null,        // 選択中の動画 File（保存しない）
  url: null,         // その Object URL
  selectedClipId: null,
};

const history = { undo: [], redo: [] };
const HISTORY_MAX = 60;

export function newProject(source) {
  return {
    id: uid('prj'),
    updatedAt: Date.now(),
    source,
    clips: [{ id: uid('clip'), in: 0, out: source.duration }],
    analysis: null,
    recommend: { count: 5, length: 30, excluded: [] },
    exportSettings: { format: 'auto', quality: 720, fps: 30, bitrate: 0 },
  };
}

export function setProject(project, file, url) {
  state.project = project;
  state.file = file;
  state.url = url;
  state.selectedClipId = project?.clips[0]?.id ?? null;
  history.undo.length = 0;
  history.redo.length = 0;
  emit('project');
  emit('clips', { structural: true });
  emit('history');
}

// ---------- 履歴 ----------
const snapshot = () => JSON.stringify({ clips: state.project.clips, sel: state.selectedClipId });

/** クリップを変更する前に呼ぶ */
export function checkpoint() {
  history.undo.push(snapshot());
  if (history.undo.length > HISTORY_MAX) history.undo.shift();
  history.redo.length = 0;
  emit('history');
}
function restore(json) {
  const s = JSON.parse(json);
  state.project.clips = s.clips;
  state.selectedClipId = s.sel;
  touch({ structural: true });
}
export function undo() {
  if (!history.undo.length) return false;
  history.redo.push(snapshot());
  restore(history.undo.pop());
  emit('history');
  return true;
}
export function redo() {
  if (!history.redo.length) return false;
  history.undo.push(snapshot());
  restore(history.redo.pop());
  emit('history');
  return true;
}
export const canUndo = () => history.undo.length > 0;
export const canRedo = () => history.redo.length > 0;

/** 変更通知（保存のトリガーにもなる） */
export function touch(detail = {}) {
  state.project.updatedAt = Date.now();
  emit('clips', detail);
  emit('dirty');
}
export function markDirty() {
  state.project.updatedAt = Date.now();
  emit('dirty');
}

// ---------- タイムライン計算 ----------
export const clipLen = (c) => c.out - c.in;
export function totalDuration(clips = state.project?.clips ?? []) {
  return clips.reduce((a, c) => a + clipLen(c), 0);
}
/** 各クリップのタイムライン上の開始秒 */
export function clipStarts(clips = state.project.clips) {
  const out = [];
  let t = 0;
  for (const c of clips) { out.push(t); t += clipLen(c); }
  return out;
}
/** タイムライン秒 T → {index, clip, sourceTime, start} */
export function locate(T, clips = state.project.clips) {
  if (!clips.length) return null;
  let t = 0;
  for (let i = 0; i < clips.length; i++) {
    const len = clipLen(clips[i]);
    if (T < t + len || i === clips.length - 1) {
      return { index: i, clip: clips[i], start: t, sourceTime: clamp(clips[i].in + (T - t), clips[i].in, clips[i].out) };
    }
    t += len;
  }
  return null;
}
export const selectedIndex = () => state.project.clips.findIndex((c) => c.id === state.selectedClipId);
export const selectedClip = () => state.project.clips.find((c) => c.id === state.selectedClipId) ?? null;

export function select(id) {
  if (state.selectedClipId === id) return;
  state.selectedClipId = id;
  emit('selection');
}

// ---------- 編集操作 ----------
/** タイムライン秒 T の位置でクリップを分割 */
export function splitAt(T) {
  const loc = locate(T);
  if (!loc) return false;
  const { clip, index, sourceTime } = loc;
  if (sourceTime - clip.in < MIN_CLIP || clip.out - sourceTime < MIN_CLIP) return false;
  checkpoint();
  const right = { id: uid('clip'), in: sourceTime, out: clip.out };
  clip.out = sourceTime;
  state.project.clips.splice(index + 1, 0, right);
  state.selectedClipId = right.id;
  touch({ structural: true });
  return true;
}

/** in / out を設定（checkpoint は呼び出し側で） */
export function setClipRange(id, inT, outT, detail = {}) {
  const c = state.project.clips.find((x) => x.id === id);
  if (!c) return;
  const dur = state.project.source.duration;
  inT = clamp(inT, 0, dur - MIN_CLIP);
  outT = clamp(outT, inT + MIN_CLIP, dur);
  c.in = inT; c.out = outT;
  touch(detail);
}

export function removeClip(id) {
  const i = state.project.clips.findIndex((c) => c.id === id);
  if (i < 0) return false;
  checkpoint();
  state.project.clips.splice(i, 1);
  const next = state.project.clips[Math.min(i, state.project.clips.length - 1)];
  state.selectedClipId = next?.id ?? null;
  touch({ structural: true });
  return true;
}

export function moveClip(id, dir) {
  const clips = state.project.clips;
  const i = clips.findIndex((c) => c.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= clips.length) return false;
  checkpoint();
  [clips[i], clips[j]] = [clips[j], clips[i]];
  touch({ structural: true });
  return true;
}

/** 元動画の範囲をクリップとして末尾に追加。
 *  タイムラインが「未編集の動画全体」だけのときは、それを置き換える。 */
export function addClipFromSource(inT, outT) {
  const p = state.project;
  checkpoint();
  const only = p.clips.length === 1 ? p.clips[0] : null;
  const untouched = only && only.in <= 0.01 && Math.abs(only.out - p.source.duration) <= 0.01;
  const clip = { id: uid('clip'), in: inT, out: outT };
  let replaced = false;
  if (untouched) { p.clips = [clip]; replaced = true; }
  else p.clips.push(clip);
  state.selectedClipId = clip.id;
  touch({ structural: true });
  return { clip, replaced };
}

export function resetClips() {
  checkpoint();
  const p = state.project;
  p.clips = [{ id: uid('clip'), in: 0, out: p.source.duration }];
  state.selectedClipId = p.clips[0].id;
  touch({ structural: true });
}
