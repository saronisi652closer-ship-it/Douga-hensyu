// utils.js — 小さな共通関数

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function uid(prefix = 'id') {
  return prefix + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

/** 秒 → "m:ss" / "h:mm:ss"。tenths=true で 0.1 秒まで表示 */
export function fmtTime(sec, tenths = false) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const totalTenths = Math.floor(sec * 10 + 1e-6);
  const t = totalTenths % 10;
  const whole = Math.floor(totalTenths / 10);
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  const ss = String(s).padStart(2, '0');
  let out = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  if (tenths) out += '.' + t;
  return out;
}

export function fmtBytes(n) {
  if (!isFinite(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)) + ' ' + units[i];
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** 要素生成ヘルパー: el('div', {class:'a', onclick:fn}, child, 'text') */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** 画面下のトースト。action = {label, fn} を付けられる */
let toastTimer;
export function toast(msg, action = null, ms = 4000) {
  const box = $('#toast');
  if (!box) return;
  box.replaceChildren(el('span', {}, msg));
  if (action) {
    box.append(el('button', {
      class: 'toast-action',
      onclick: () => { box.classList.remove('show'); action.fn(); },
    }, action.label));
  }
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), ms);
}

/** 画面スリープ防止（解析・書き出し中）。解除関数を返す */
export async function keepAwake() {
  let lock = null;
  try { lock = await navigator.wakeLock?.request('screen'); } catch { /* 未対応でも続行 */ }
  return () => { try { lock?.release(); } catch { /* noop */ } };
}

/** イベント1回待ち（タイムアウト付き） */
export function once(target, event, timeoutMs = 0, errorEvent = 'error') {
  return new Promise((resolve, reject) => {
    let timer;
    const ok = (e) => { cleanup(); resolve(e); };
    const ng = () => { cleanup(); reject(new Error(`${event} を待機中にエラーが発生しました`)); };
    const cleanup = () => {
      target.removeEventListener(event, ok);
      if (errorEvent) target.removeEventListener(errorEvent, ng);
      clearTimeout(timer);
    };
    target.addEventListener(event, ok);
    if (errorEvent) target.addEventListener(errorEvent, ng);
    if (timeoutMs) timer = setTimeout(() => { cleanup(); reject(new Error(`${event} がタイムアウトしました`)); }, timeoutMs);
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
