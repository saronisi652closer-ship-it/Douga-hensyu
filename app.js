// app.js — 起動処理と画面まわり（ホーム、タブ、編集ボタン、書き出し、保存）

import {
  state, on, newProject, setProject, locate, clipStarts, clipLen, totalDuration, selectedClip, selectedIndex,
  select, splitAt, setClipRange, removeClip, moveClip, resetClips, checkpoint, undo, redo, canUndo, canRedo,
  markDirty, MIN_CLIP,
} from './state.js';
import { Player } from './video.js';
import { Timeline } from './timeline.js';
import { FrameGrabber, buildThumbs, clearThumbs } from './frames.js';
import { initRecommend } from './recommend.js';
import { exportVideo, supportedFormats, resolveFormat, outputSize, estimateBytes } from './export.js';
import * as storage from './storage.js';
import { $, $$, el, fmtTime, fmtBytes, toast, debounce, keepAwake, clamp } from './utils.js';

const video = $('#preview');
const player = new Player(video);
const timeline = new Timeline($('#timeline'), player);
let grabber = null;
let expectedProjectId = null;   // 「続きから」で開こうとしているプロジェクト
let exportJob = null;
let exportUrl = null;

const recommend = initRecommend({ panel: $('#panel-recommend'), player, timeline, getGrabber: () => grabber });

// ================= ホーム =================
const fileInput = $('#file-input');
$('#pick').addEventListener('click', () => { expectedProjectId = null; fileInput.click(); });
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (file) openFile(file);
});
// VTuber収録。使わない人に影響しないよう、押したときに初めて vtuber.js を読み込む
$('#vtuber-open').addEventListener('click', async () => {
  try {
    const { openVtuber } = await import('./vtuber.js');
    $('#home').hidden = true;
    await openVtuber({
      root: $('#vtuber'),
      onClose: () => { $('#home').hidden = false; renderRecent(); },
      // 録画した動画を、通常の動画と同じ入口（openFile）から編集画面へ渡す
      onEdit: async (file) => { await openFile(file); return state.file === file; },
    });
  } catch (e) {
    console.error(e);
    $('#vtuber').hidden = true;
    $('#home').hidden = false;
    toast('VTuber収録を開けませんでした。通信状況を確認して、もう一度試してください。', null, 6000);
  }
});

// PC ではドラッグ＆ドロップでも開ける
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|mkv)$/i.test(f.name));
  if (file && !$('#home').hidden) openFile(file);
});

async function renderRecent() {
  let projects = [];
  try { projects = await storage.listProjects(); } catch { /* 保存領域が使えない環境 */ }
  $('#recent').hidden = projects.length === 0;
  $('#recent-list').replaceChildren(...projects.slice(0, 12).map((p) => el('li', {},
    el('button', {
      class: 'recent-open',
      onclick: () => { expectedProjectId = p.id; fileInput.click(); },
    },
      el('strong', {}, p.source.name),
      el('span', {}, `${fmtTime(totalDuration(p.clips))}（クリップ${p.clips.length}個）${p.analysis ? '・解析済み' : ''}`),
      el('span', {}, new Date(p.updatedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' に編集')),
    el('button', {
      class: 'icon-btn sm', 'aria-label': `${p.source.name} の保存データを消す`,
      onclick: async () => {
        if (!confirm(`「${p.source.name}」の編集内容を消しますか？（動画ファイルは消えません）`)) return;
        await storage.deleteProject(p.id);
        renderRecent();
      },
    }, svgIcon('M6 6l12 12M18 6L6 18')))));
}
function svgIcon(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

async function openFile(file) {
  const url = URL.createObjectURL(file);
  let meta;
  try {
    meta = await player.load(url);
  } catch (e) {
    URL.revokeObjectURL(url);
    video.removeAttribute('src'); video.load();
    toast('この動画はこのブラウザで再生できません。MP4（H.264）か WebM に変換すると読み込めます。', null, 8000);
    return;
  }

  let project = null, resumed = false;
  try { project = await storage.findByFile(file); } catch { /* noop */ }
  if (project && Math.abs(project.source.duration - meta.duration) > 0.5) project = null;
  if (project) resumed = true;
  else {
    project = newProject({
      name: file.name, size: file.size, lastModified: file.lastModified, type: file.type || '不明',
      duration: meta.duration, width: meta.width, height: meta.height,
    });
  }
  const mismatch = expectedProjectId && project.id !== expectedProjectId;
  expectedProjectId = null;

  grabber?.dispose();
  if (state.url) URL.revokeObjectURL(state.url);
  grabber = new FrameGrabber(url);
  clearThumbs();
  setProject(project, file, url);
  buildThumbs(grabber, project.source);

  $('#home').hidden = true;
  $('#editor').hidden = false;
  $('#title').textContent = file.name;
  showTab('edit');
  timeline.zoomFit();
  player.seek(0);
  renderInfo();
  syncExportForm();
  storage.requestPersist();

  if (mismatch) toast('保存してあるものとは別の動画です。新しいプロジェクトとして開きました。', null, 6000);
  else if (resumed) {
    toast('前回の続きから再開しました', {
      label: '最初からやり直す',
      fn: () => { resetClips(); toast('動画全体の状態に戻しました', { label: '元に戻す', fn: undo }); },
    }, 6000);
  }
}

/** 編集画面を閉じてホームへ。save=false なら保存せずに閉じる */
function closeEditor({ save = true } = {}) {
  exportJob?.abort.abort();
  recommend.cancel();
  player.pause();
  if (save) saveNow();
  grabber?.dispose(); grabber = null;
  clearThumbs();
  video.removeAttribute('src'); video.load();
  if (state.url) URL.revokeObjectURL(state.url);
  state.project = null; state.file = null; state.url = null;
  clearExportResult();
  $('#editor').hidden = true;
  $('#home').hidden = false;
  renderRecent();
}
function goHome() {
  if ((exportJob || recommend.isBusy()) && !confirm('処理の途中です。中止してホームに戻りますか？')) return;
  closeEditor();
}
$('#back').addEventListener('click', goHome);

// ================= 自動保存 =================
async function saveNow() {
  if (!state.project) return;
  try { await storage.saveProject(state.project); }
  catch (e) { console.warn('保存に失敗', e); }
}
const saveSoon = debounce(saveNow, 600);
on('dirty', saveSoon);
window.addEventListener('pagehide', saveNow);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

// ================= 再生まわり =================
const timeNow = $('#time-now'), timeTotal = $('#time-total');
$('#play').addEventListener('click', () => player.toggle());
video.addEventListener('click', () => player.toggle());
on('playstate', (p) => {
  $('#play').classList.toggle('playing', p);
  $('#play').setAttribute('aria-label', p ? '一時停止' : '再生');
});
on('time', (T) => { timeNow.textContent = fmtTime(T, true); });
on('sourcetime', (t) => { timeNow.textContent = fmtTime(t, true); });

const badge = $('#source-badge');
on('mode', (mode) => {
  badge.hidden = mode !== 'source';
  if (mode === 'source') {
    const { a, b } = player.range;
    badge.textContent = `元動画の ${fmtTime(a)}〜${fmtTime(b)} を確認中（タップで編集に戻る）`;
    timeTotal.textContent = fmtTime(b, true);
  } else timeTotal.textContent = fmtTime(totalDuration(), true);
});
badge.addEventListener('click', () => player.backToTimeline());

$('#zoom-in').addEventListener('click', () => timeline.zoom(1.6));
$('#zoom-out').addEventListener('click', () => timeline.zoom(1 / 1.6));
$('#zoom-fit').addEventListener('click', () => timeline.zoomFit());

// ================= 編集 =================
on('clips', (d) => {
  if (!state.project) return;
  if (player.mode === 'timeline') timeTotal.textContent = fmtTime(totalDuration(), true);
  // 構造が変わったら再生位置を合わせ直す（ドラッグ中は timeline 側で処理）
  if (d?.structural) player.seek(Math.min(player.T, totalDuration()));
  renderClipSummary();
  updateExportSummary();
});
on('selection', renderClipSummary);
on('history', () => { $('#undo').disabled = !canUndo(); $('#redo').disabled = !canRedo(); });
$('#undo').addEventListener('click', () => undo());
$('#redo').addEventListener('click', () => redo());

function renderClipSummary() {
  if (!state.project) return;
  const c = selectedClip();
  const n = state.project.clips.length;
  const i = selectedIndex();
  $('#clip-summary').textContent = c
    ? `クリップ ${i + 1} / ${n}：元動画の ${fmtTime(c.in, true)} から ${fmtTime(c.out, true)} まで（${fmtTime(clipLen(c), true)}）`
    : n ? 'タイムラインのクリップをタップして選んでください。' : 'クリップがありません。「動画全体の状態に戻す」か、おすすめから追加してください。';
  $('#clip-in').textContent = c ? fmtTime(c.in, true) : '-';
  $('#clip-out').textContent = c ? fmtTime(c.out, true) : '-';
  for (const id of ['act-delete', 'act-left', 'act-right']) $('#' + id).disabled = !c;
  if (c) { $('#act-left').disabled = i === 0; $('#act-right').disabled = i === n - 1; }
  $$('[data-nudge]').forEach((b) => { b.disabled = !c; });
  for (const id of ['act-split', 'act-in', 'act-out']) $('#' + id).disabled = n === 0;
}

function hereOrWarn() {
  const loc = locate(player.T);
  if (!loc) toast('クリップがありません');
  return loc;
}
$('#act-split').addEventListener('click', () => {
  if (!hereOrWarn()) return;
  if (!splitAt(player.T)) toast('クリップの端では分割できません。再生位置を少し動かしてください。');
});
$('#act-in').addEventListener('click', () => {
  const loc = hereOrWarn();
  if (!loc) return;
  if (loc.clip.out - loc.sourceTime < MIN_CLIP) return toast('ここから始めるとクリップが無くなります');
  if (loc.sourceTime - loc.clip.in < 0.01) return; // すでに先頭
  checkpoint();
  select(loc.clip.id);
  setClipRange(loc.clip.id, loc.sourceTime, loc.clip.out, { structural: true });
  player.seek(loc.start);
});
$('#act-out').addEventListener('click', () => {
  const loc = hereOrWarn();
  if (!loc) return;
  if (loc.sourceTime - loc.clip.in < MIN_CLIP) return toast('ここで終えるとクリップが無くなります');
  checkpoint();
  select(loc.clip.id);
  setClipRange(loc.clip.id, loc.clip.in, loc.sourceTime, { structural: true });
  player.seek(Math.max(0, loc.start + (loc.sourceTime - loc.clip.in) - 0.05));
});
$('#act-delete').addEventListener('click', () => { if (state.selectedClipId) removeClip(state.selectedClipId); });
$('#act-left').addEventListener('click', () => moveSelected(-1));
$('#act-right').addEventListener('click', () => moveSelected(1));
function moveSelected(dir) {
  const id = state.selectedClipId;
  if (!id || !moveClip(id, dir)) return;
  player.seek(clipStarts()[selectedIndex()]);
  timeline.reveal();
}
$('#act-reset').addEventListener('click', () => {
  resetClips();
  toast('動画全体の状態に戻しました', { label: '元に戻す', fn: undo });
});
$$('[data-nudge]').forEach((btn) => btn.addEventListener('click', () => {
  const c = selectedClip();
  if (!c) return;
  const d = Number(btn.dataset.d);
  checkpoint();
  if (btn.dataset.nudge === 'in') setClipRange(c.id, Math.min(c.in + d, c.out - MIN_CLIP), c.out, { structural: true });
  else setClipRange(c.id, c.in, Math.max(c.out + d, c.in + MIN_CLIP), { structural: true });
  const start = clipStarts()[selectedIndex()];
  player.seek(btn.dataset.nudge === 'in' ? start : Math.max(0, start + clipLen(c) - 0.05));
}));

// キーボード（PC 向け）
window.addEventListener('keydown', (e) => {
  if (!state.project || e.target.matches('input, select, textarea')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
  else if (e.key === 'ArrowLeft') player.seek(player.T - (e.shiftKey ? 5 : 1));
  else if (e.key === 'ArrowRight') player.seek(player.T + (e.shiftKey ? 5 : 1));
  else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (e.key.toLowerCase() === 's' && !mod) $('#act-split').click();
  else if (e.key === 'Delete' || e.key === 'Backspace') $('#act-delete').click();
});

// ================= タブ =================
function showTab(name) {
  $$('.tabs [role=tab]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  $$('.panel').forEach((p) => { p.hidden = p.id !== 'panel-' + name; });
  if (name !== 'recommend' && player.mode === 'source') player.backToTimeline();
  if (name === 'recommend') recommend.render();
  if (name === 'export') updateExportSummary();
  $('.panels').scrollTop = 0;
}
$$('.tabs [role=tab]').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

// ================= 書き出し =================
const exFormat = $('#ex-format'), exQuality = $('#ex-quality'), exFps = $('#ex-fps'), exBitrate = $('#ex-bitrate');

function syncExportForm() {
  const formats = supportedFormats();
  exFormat.replaceChildren(...formats.map((f) => el('option', { value: f.id }, f.label)));
  const s = state.project.exportSettings;
  const fmt = resolveFormat(s.format);
  if (fmt) exFormat.value = fmt.id;
  exQuality.value = String(s.quality); exFps.value = String(s.fps); exBitrate.value = String(s.bitrate);
  $('#ex-start').disabled = !formats.length;
  showExportView('form');
  updateExportSummary();
}
[exFormat, exQuality, exFps, exBitrate].forEach((sel) => sel.addEventListener('change', () => {
  const s = state.project.exportSettings;
  s.format = exFormat.value; s.quality = Number(exQuality.value); s.fps = Number(exFps.value); s.bitrate = Number(exBitrate.value);
  markDirty();
  updateExportSummary();
}));

function updateExportSummary() {
  const p = state.project;
  if (!p) return;
  const total = totalDuration();
  const box = $('#ex-summary');
  if (!supportedFormats().length) { box.textContent = 'このブラウザは動画の書き出しに対応していません。Chrome で開いてください。'; return; }
  const { width, height } = outputSize(p.source, p.exportSettings.quality);
  const shrunk = Math.min(p.source.width, p.source.height) < p.exportSettings.quality;
  box.textContent = total > 0
    ? `${width}×${height}、長さ ${fmtTime(total, true)}、およそ ${fmtBytes(estimateBytes(p.exportSettings, p.source, total))}` + (shrunk ? '（元の動画より大きくはしません）' : '')
    : 'タイムラインにクリップがありません。';
  if (!exportJob) $('#ex-start').disabled = total <= 0;
}

function showExportView(name) {
  $('#export-form').hidden = name !== 'form';
  $('#export-progress').hidden = name !== 'progress';
  $('#export-result').hidden = name !== 'result';
}
function clearExportResult() {
  if (exportUrl) { URL.revokeObjectURL(exportUrl); exportUrl = null; }
}

$('#ex-start').addEventListener('click', async () => {
  const p = state.project;
  if (exportJob || totalDuration() <= 0) return;
  if (recommend.isBusy()) return toast('解析が終わってから書き出してください');
  player.pause();
  clearExportResult();
  const abort = new AbortController();
  exportJob = { abort };
  showExportView('progress');
  const bar = $('#ex-bar'), pct = $('#ex-pct'), eta = $('#ex-eta');
  bar.style.width = '0%'; pct.textContent = '0%'; eta.textContent = '';
  const total = totalDuration();
  const release = await keepAwake();
  try {
    const result = await exportVideo({
      url: state.url, clips: structuredClone(p.clips), source: p.source, settings: { ...p.exportSettings },
      signal: abort.signal,
      onProgress: (r) => {
        const v = Math.round(r * 100);
        bar.style.width = v + '%'; pct.textContent = v + '%';
        eta.textContent = `残り 約${fmtTime(Math.max(0, total * (1 - r)))}`;
      },
    });
    const base = p.source.name.replace(/\.[^.]+$/, '');
    const name = `${base}_cut.${result.ext}`;
    exportUrl = URL.createObjectURL(result.blob);
    const save = $('#ex-save');
    save.href = exportUrl; save.download = name;
    $('#ex-result-info').textContent = `${name}（${result.width}×${result.height}、${fmtBytes(result.blob.size)}）`;
    const file = new File([result.blob], name, { type: result.blob.type });
    const share = $('#ex-share');
    const canShare = !!navigator.canShare?.({ files: [file] });
    share.hidden = !canShare;
    share.onclick = () => navigator.share({ files: [file], title: name }).catch(() => {});
    showExportView('result');
  } catch (e) {
    showExportView('form');
    if (e.name !== 'AbortError') { console.error(e); toast('書き出せませんでした: ' + e.message, null, 8000); }
    else toast('書き出しを中止しました');
  } finally {
    release();
    exportJob = null;
    updateExportSummary();
  }
});
$('#ex-cancel').addEventListener('click', () => exportJob?.abort.abort());
$('#ex-again').addEventListener('click', () => showExportView('form'));

// ================= 情報 =================
function renderInfo() {
  const s = state.project.source;
  const rows = [
    ['ファイル名', s.name],
    ['長さ', fmtTime(s.duration, true)],
    ['解像度', `${s.width}×${s.height}`],
    ['サイズ', fmtBytes(s.size)],
    ['形式', s.type],
  ];
  $('#info-list').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
}
$('#act-forget').addEventListener('click', async () => {
  if (!confirm('このプロジェクトの編集内容と解析結果を消してホームに戻りますか？（動画ファイルは消えません）')) return;
  const id = state.project.id;
  closeEditor({ save: false });
  await storage.deleteProject(id).catch(() => {});
  renderRecent();
});

// ================= PWA =================
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js').catch(() => {}));
}
let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  $('#install').hidden = false;
});
$('#install').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => {});
  installEvent = null;
  $('#install').hidden = true;
});
window.addEventListener('appinstalled', () => { $('#install').hidden = true; });

renderRecent();
