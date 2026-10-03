// recommend.js — 「おすすめ」タブ: 解析の実行、候補一覧、採用・除外

import { state, on, markDirty, addClipFromSource, undo, clipStarts } from './state.js';
import { analyze, chooseMethod } from './sceneAnalyzer.js';
import { pickScenes, REASONS } from './scoring.js';
import { el, fmtTime, toast, keepAwake, clamp } from './utils.js';

const COUNTS = [3, 5, 10, 20];
const LENGTHS = [[15, '15秒'], [30, '30秒'], [60, '60秒'], ['auto', '自動']];
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

export function initRecommend({ panel, player, getGrabber, timeline }) {
  let job = null;            // 解析中: { abort, stageEl, pctEl, barEl }
  let scenes = [];
  let score = null;
  let mode = 'auto';
  let short = false;         // 指定した数より候補が少なかった
  let graph = null;          // { canvas, marker }
  const thumbCache = new Map();

  const isAdopted = (s) => state.project.clips.some((c) => Math.abs(c.in - s.in) < 0.02 && Math.abs(c.out - s.out) < 0.02);

  function recompute() {
    const p = state.project;
    if (!p?.analysis) { scenes = []; score = null; return; }
    const r = pickScenes(p.analysis, p.recommend);
    scenes = r.scenes; score = r.score;
    short = scenes.length < p.recommend.count;
  }

  // ---------- 解析 ----------
  async function run() {
    const p = state.project;
    const abort = new AbortController();
    job = { abort };
    render();
    player.pause();
    const release = await keepAwake();
    try {
      const analysis = await analyze({
        file: state.file, url: state.url, duration: p.source.duration, mode,
        signal: abort.signal,
        onProgress: (stage, ratio) => {
          if (!job?.stageEl) return;
          const pct = Math.round(clamp(ratio, 0, 1) * 100);
          job.stageEl.textContent = stage;
          job.pctEl.textContent = pct + '%';
          job.barEl.style.width = pct + '%';
        },
      });
      if (state.project !== p) return; // 解析中に別の動画へ切り替えた
      p.analysis = analysis;
      p.recommend.excluded = [];
      markDirty();
      toast('解析が終わりました');
    } catch (e) {
      if (e.name !== 'AbortError') { console.error(e); toast('解析できませんでした: ' + e.message, null, 7000); }
    } finally {
      release();
      job = null;
      recompute();
      render();
    }
  }

  // ---------- 表示 ----------
  function render() {
    const p = state.project;
    if (!p) { panel.replaceChildren(); return; }
    if (job) return renderProgress();
    if (!p.analysis) return renderIntro();
    renderResults();
  }

  function renderIntro() {
    const p = state.project;
    const select = el('select', { id: 'an-mode', onchange: (e) => { mode = e.target.value; render(); } },
      el('option', { value: 'auto' }, '自動で選ぶ'),
      el('option', { value: 'fast' }, '高速（メモリを多く使う）'),
      el('option', { value: 'play' }, '省メモリ（4倍速で再生しながら解析）'));
    select.value = mode;
    const method = chooseMethod(state.file, mode);
    const est = method === 'play'
      ? `この動画は約 ${fmtTime(Math.max(5, p.source.duration / 4))} かかる見込みです。`
      : '短い動画なら数十秒ほどで終わります。';
    panel.replaceChildren(
      el('p', { class: 'lead' }, '音量の変化と映像の変化から、盛り上がっていそうな場面を探します。'),
      el('label', { class: 'field' }, '解析方式', select),
      el('p', { class: 'hint' }, est + ' 解析中はこの画面を開いたままにしてください。'),
      el('button', { class: 'btn primary', id: 'an-start', onclick: run }, '動画を解析'),
    );
  }

  function renderProgress() {
    job.stageEl = el('span', {}, '準備中');
    job.pctEl = el('span', {}, '0%');
    job.barEl = el('i');
    panel.replaceChildren(
      el('p', { class: 'progress-label' }, job.stageEl, job.pctEl),
      el('div', { class: 'progress' }, job.barEl),
      el('p', { class: 'hint' }, '画面を閉じたり別のアプリに切り替えると、解析が止まることがあります。'),
      el('button', { class: 'btn ghost', onclick: () => job?.abort.abort() }, '解析を中止'),
    );
  }

  function segmented(options, current, onPick, label) {
    return el('div', { class: 'seg', role: 'group', 'aria-label': label },
      options.map(([value, text]) => el('button', {
        class: value === current ? 'on' : '',
        'aria-pressed': String(value === current),
        onclick: () => onPick(value),
      }, text)));
  }

  function renderResults() {
    const p = state.project;
    const rec = p.recommend;
    const update = () => { markDirty(); recompute(); render(); };

    const canvas = el('canvas', { class: 'heat', onclick: onGraphTap });
    const marker = el('i', { class: 'heat-marker', hidden: true });
    graph = { canvas, marker };

    const list = el('ol', { class: 'scenes' }, scenes.map(sceneCard));
    if (!scenes.length) list.append(el('li', { class: 'hint' }, '候補が見つかりませんでした。長さや数を変えてみてください。'));

    panel.replaceChildren(
      el('div', { class: 'rec-settings' },
        el('div', { class: 'rec-set' }, el('span', {}, '候補の数'),
          segmented(COUNTS.map((c) => [c, String(c)]), rec.count, (v) => { rec.count = v; update(); }, '候補の数')),
        el('div', { class: 'rec-set' }, el('span', {}, '1本の長さ'),
          segmented(LENGTHS, rec.length, (v) => { rec.length = v; update(); }, '1本の長さ'))),
      el('div', { class: 'heat-wrap' }, canvas, marker),
      el('p', { class: 'hint heat-caption' }, '動画全体の盛り上がり。山が高いほど音や映像の変化が大きい場面です。タップするとその場面を確認できます。'),
      list,
      short && scenes.length ? el('p', { class: 'hint' }, `はっきり盛り上がっている場面は${scenes.length}件でした。1本の長さを短くすると増えることがあります。`) : null,
      el('div', { class: 'rec-foot' },
        rec.excluded.length ? el('button', { class: 'link', onclick: () => { rec.excluded = []; update(); } }, `除外した${rec.excluded.length}件を戻す`) : null,
        el('button', { class: 'link', onclick: () => { p.analysis = null; markDirty(); recompute(); render(); } }, '解析をやり直す')),
      el('p', { class: 'hint' }, '盛り上がり度はこの動画の中での相対的な目安です。音と映像の変化だけで判定しているため、内容までは見ていません。'),
    );
    requestAnimationFrame(drawGraph);
  }

  function sceneCard(s, i) {
    const adopted = isAdopted(s);
    const thumb = thumbFor(s);
    const play = () => player.previewSource(s.in, s.out, true);
    return el('li', { class: 'scene' + (adopted ? ' adopted' : '') },
      el('button', { class: 'scene-thumb', onclick: play, 'aria-label': `候補${i + 1}を再生` }, thumb),
      el('div', { class: 'scene-body' },
        el('div', { class: 'scene-head' },
          el('span', { class: 'scene-rank' }, CIRCLED[i] ?? String(i + 1)),
          el('span', { class: 'scene-time' }, `${fmtTime(s.in)}〜${fmtTime(s.out)}`),
          el('span', { class: 'scene-len' }, `${Math.round(s.out - s.in)}秒`)),
        el('div', { class: 'hype' },
          el('span', { class: 'hype-label' }, '盛り上がり度'),
          el('b', {}, String(s.hype)),
          el('span', { class: 'hype-bar' }, el('i', { style: { width: s.hype + '%' } }))),
        el('ul', { class: 'reasons' }, s.reasons.map((r) => el('li', {}, REASONS[r])))),
      el('div', { class: 'scene-actions' },
        el('button', { class: 'chip-btn', onclick: play }, '再生'),
        el('button', { class: 'chip-btn solid', disabled: adopted, onclick: () => adopt(s) }, adopted ? '採用済み' : '採用'),
        el('button', { class: 'chip-btn', onclick: () => exclude(s) }, '除外')),
    );
  }

  function thumbFor(s) {
    const key = s.peak.toFixed(2);
    if (thumbCache.has(key)) return thumbCache.get(key);
    const src = state.project.source;
    const c = el('canvas');
    c.height = 72;
    c.width = Math.round(clamp(72 * (src.width / src.height), 40, 128));
    thumbCache.set(key, c);
    getGrabber()?.draw(s.peak, c.getContext('2d'), c.width, c.height).catch(() => {});
    return c;
  }

  function adopt(s) {
    const { replaced } = addClipFromSource(s.in, s.out);
    const starts = clipStarts();
    player.seek(starts[starts.length - 1]);
    timeline.reveal();
    toast(replaced ? 'タイムラインをこの場面に置き換えました' : 'タイムラインの最後に追加しました',
      { label: '元に戻す', fn: () => { undo(); } });
    render();
  }

  function exclude(s) {
    state.project.recommend.excluded.push({ in: s.in, out: s.out });
    markDirty(); recompute(); render();
  }

  // ---------- 盛り上がりグラフ ----------
  function drawGraph() {
    if (!graph || !score) return;
    const cv = graph.canvas;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    const dur = state.project.source.duration;
    const n = score.length;
    let max = 0.3;
    for (let i = 0; i < n; i++) if (score[i] > max) max = score[i];

    // 候補の範囲
    ctx.fillStyle = css.getPropertyValue('--band').trim();
    scenes.forEach((s) => ctx.fillRect((s.in / dur) * w, 0, Math.max(2, ((s.out - s.in) / dur) * w), h));

    // 山（ピクセルごとの最大値）
    const grad = ctx.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, css.getPropertyValue('--heat-lo').trim());
    grad.addColorStop(0.55, css.getPropertyValue('--heat-mid').trim());
    grad.addColorStop(1, css.getPropertyValue('--heat-hi').trim());
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x++) {
      const a = Math.floor((x / w) * n), b = Math.max(a + 1, Math.floor(((x + 1) / w) * n));
      let m = 0;
      for (let i = a; i < b && i < n; i++) if (score[i] > m) m = score[i];
      ctx.lineTo(x, h - 2 - (m / max) * (h - 6));
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();

    // 候補の番号
    ctx.fillStyle = css.getPropertyValue('--text').trim();
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    scenes.forEach((s, i) => ctx.fillText(String(i + 1), ((s.in + s.out) / 2 / dur) * w, 3));
  }

  function onGraphTap(e) {
    const r = graph.canvas.getBoundingClientRect();
    const dur = state.project.source.duration;
    const t = clamp(((e.clientX - r.left) / r.width) * dur, 0, dur);
    const hit = scenes.find((s) => t >= s.in && t <= s.out);
    if (hit) player.previewSource(hit.in, hit.out, true);
    else player.previewSource(t, Math.min(dur, t + 15), true);
  }

  on('sourcetime', (t) => {
    if (!graph?.marker.isConnected) return;
    graph.marker.hidden = false;
    graph.marker.style.left = (t / state.project.source.duration) * 100 + '%';
  });
  on('mode', (m) => { if (m === 'timeline' && graph) graph.marker.hidden = true; });
  on('project', () => { job?.abort.abort(); thumbCache.clear(); recompute(); render(); });
  on('clips', (d) => { if (d?.structural && !job && state.project?.analysis && !panel.hidden) render(); });
  window.addEventListener('resize', () => { if (!panel.hidden) drawGraph(); });

  return { render: () => { recompute(); render(); }, isBusy: () => !!job, cancel: () => job?.abort.abort() };
}
