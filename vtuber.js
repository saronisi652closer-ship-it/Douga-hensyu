// vtuber.js — VTuber収録画面（タブレット側）
//
// STEP 2: 画面と基本動作だけ。外部ライブラリなし。
//   ・ダミーキャラクターが待機モーションで動き、マイクの音量で口が動く
//   ・背景（色 / 画像）、キャラクター選択、マイクON/OFFと音量表示
//   ・スマホ接続と録画は「枠」だけ（STEP 3 / STEP 6 で中身を入れる）
//
// 作りの方針:
//   ・姿勢データ(pose)を作る部分 / キャラクターを描く部分 / 画面に出す部分 を分けてある。
//     pose の出どころを「待機モーション」から「スマホの顔トラッキング」に替えるだけで STEP 5 に進める。
//   ・合成先は1枚のキャンバス(stage)。STEP 6 ではこのキャンバスとマイクを録画に渡す。
//   ・編集画面のコード（state.js / video.js / timeline.js / export.js など）は一切読み込まない。

import { toast, clamp } from './utils.js';
import { AVATARS, neutralPose } from './avatarRenderer.js';

const STAGE_W = 1280, STAGE_H = 720;
const BG_COLORS = [
  ['#20243c', '藍'], ['#00b140', 'グリーンバック'], ['#2f6fd6', '青'], ['#ffd9e4', '桜'], ['#f4f4f6', '白'],
];
const PREF_KEY = 'kiritoru.vtuber';

let session = null;

function loadCss() {
  if (document.getElementById('vtuber-css')) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.id = 'vtuber-css'; link.rel = 'stylesheet'; link.href = 'vtuber.css';
    link.onload = resolve;
    link.onerror = () => { link.remove(); reject(new Error('vtuber.css を読み込めませんでした')); };
    document.head.append(link);
  });
}
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* 保存できなくても動作に影響なし */ }
}

const TEMPLATE = `
  <header class="bar">
    <button class="icon-btn" data-act="close" aria-label="ホームに戻る">
      <svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>
    </button>
    <div class="bar-title">VTuber収録</div>
  </header>

  <section class="vt-stage">
    <canvas class="vt-canvas" width="${STAGE_W}" height="${STAGE_H}"></canvas>
    <span class="vt-badge vt-track">待機モーション</span>
    <span class="vt-badge vt-timer">0:00</span>
  </section>

  <div class="vt-side">
    <div class="vt-controls">
      <section class="vt-group">
        <h2>スマホ（顔トラッカー）</h2>
        <p class="vt-status"><i class="vt-dot"></i><span data-out="conn">未接続</span><span class="vt-method" data-out="method">接続方式 —</span></p>
        <button class="btn ghost" data-act="connect" disabled>スマホを接続（準備中）</button>
        <p class="hint">接続は次の段階で追加します。今は待機モーションで動きます。</p>
      </section>

      <section class="vt-group">
        <h2>キャラクター</h2>
        <select data-in="avatar" aria-label="キャラクター"></select>
      </section>

      <section class="vt-group">
        <h2>背景</h2>
        <div class="vt-swatches" role="group" aria-label="背景の色"></div>
        <div class="vt-row">
          <button class="chip-btn" data-act="bg-image">画像を選ぶ</button>
          <button class="chip-btn" data-act="bg-clear" hidden>画像を外す</button>
        </div>
        <input type="file" accept="image/*" data-in="bg-file" hidden>
      </section>

      <section class="vt-group">
        <h2>マイク</h2>
        <div class="vt-row">
          <button class="chip-btn" data-act="mic" aria-pressed="false">マイクをONにする</button>
          <div class="vt-meter" role="meter" aria-label="マイク音量" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div>
        </div>
        <p class="hint">ONにすると、声の大きさに合わせてキャラクターの口が動きます。</p>
      </section>
    </div>

    <div class="vt-recbar">
      <button class="vt-rec" data-act="record" disabled aria-label="録画開始（準備中）"><i></i></button>
      <p>録画は次の段階で追加します</p>
    </div>
  </div>
`;

/**
 * 収録画面を開く
 * @param opts { root: 入れ物の要素, onClose: 閉じたときに呼ぶ関数 }
 */
export async function openVtuber({ root, onClose }) {
  if (session) return;
  await loadCss();
  root.innerHTML = TEMPLATE;
  root.hidden = false;

  const q = (sel) => root.querySelector(sel);
  const prefs = loadPrefs();
  const canvas = q('.vt-canvas');
  const ctx = canvas.getContext('2d', { alpha: false });

  const s = session = {
    root, onClose, canvas, ctx,
    pose: neutralPose(),
    avatar: null,
    bg: { color: BG_COLORS.some(([c]) => c === prefs.color) ? prefs.color : BG_COLORS[0][0], image: null, imageUrl: null },
    mic: { on: false, stream: null, ctx: null, analyser: null, buf: null, level: 0 },
    meterEl: q('.vt-meter'), meterBar: q('.vt-meter i'), meterShown: -1,
    raf: 0, last: 0, start: performance.now(),
    nextBlink: 2, blinkT: -1,
  };

  // ----- キャラクター -----
  const avatarSel = q('[data-in=avatar]');
  for (const a of AVATARS) avatarSel.append(new Option(a.label, a.id));
  const vrmOpt = new Option('VRMファイルを読み込む（準備中）', 'vrm');
  vrmOpt.disabled = true;
  avatarSel.append(vrmOpt);
  const setAvatar = (id) => {
    const def = AVATARS.find((a) => a.id === id) ?? AVATARS[0];
    s.avatar?.dispose();
    s.avatar = def.create();
    avatarSel.value = def.id;
  };
  avatarSel.addEventListener('change', () => setAvatar(avatarSel.value));
  setAvatar(AVATARS[0].id);

  // ----- 背景 -----
  const swatches = q('.vt-swatches');
  const paintSwatches = () => {
    for (const b of swatches.children) b.setAttribute('aria-pressed', String(!s.bg.image && b.dataset.color === s.bg.color));
  };
  for (const [color, name] of BG_COLORS) {
    const b = document.createElement('button');
    b.className = 'vt-swatch'; b.style.background = color; b.dataset.color = color;
    b.setAttribute('aria-label', `背景色: ${name}`);
    b.addEventListener('click', () => { clearBgImage(); s.bg.color = color; savePrefs({ color }); paintSwatches(); });
    swatches.append(b);
  }
  const bgFile = q('[data-in=bg-file]'), bgClear = q('[data-act=bg-clear]');
  const clearBgImage = () => {
    if (s.bg.imageUrl) URL.revokeObjectURL(s.bg.imageUrl);
    s.bg.image = null; s.bg.imageUrl = null;
    bgClear.hidden = true;
  };
  q('[data-act=bg-image]').addEventListener('click', () => bgFile.click());
  bgFile.addEventListener('change', () => {
    const file = bgFile.files[0];
    bgFile.value = '';
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (session !== s) { URL.revokeObjectURL(url); return; }
      clearBgImage();
      s.bg.image = img; s.bg.imageUrl = url;
      bgClear.hidden = false;
      paintSwatches();
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast('この画像は読み込めませんでした'); };
    img.src = url;
  });
  bgClear.addEventListener('click', () => { clearBgImage(); paintSwatches(); });
  paintSwatches();

  // ----- マイク -----
  const micBtn = q('[data-act=mic]');
  micBtn.addEventListener('click', async () => {
    micBtn.disabled = true;
    try { s.mic.on ? stopMic(s) : await startMic(s); }
    catch (e) {
      console.warn(e);
      toast(e.name === 'NotAllowedError'
        ? 'マイクの使用が許可されていません。ブラウザのサイト設定でマイクを許可してください。'
        : 'マイクを開始できませんでした。マイクが接続されているか確認してください。', null, 7000);
    }
    micBtn.disabled = false;
    micBtn.textContent = s.mic.on ? 'マイクをOFFにする' : 'マイクをONにする';
    micBtn.setAttribute('aria-pressed', String(s.mic.on));
    micBtn.classList.toggle('solid', s.mic.on);
  });

  q('[data-act=close]').addEventListener('click', closeVtuber);

  s.last = performance.now();
  s.raf = requestAnimationFrame(frame);
}

export function closeVtuber() {
  const s = session;
  if (!s) return;
  session = null;
  cancelAnimationFrame(s.raf);
  stopMic(s);
  s.avatar?.dispose();
  if (s.bg.imageUrl) URL.revokeObjectURL(s.bg.imageUrl);
  s.root.hidden = true;
  s.root.replaceChildren();
  s.onClose?.();
}

// ---------- マイク ----------
async function startMic(s) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('このブラウザはマイク入力に対応していません');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
  if (session !== s) { stream.getTracks().forEach((t) => t.stop()); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  const analyser = ac.createAnalyser();
  analyser.fftSize = 1024;
  ac.createMediaStreamSource(stream).connect(analyser); // スピーカーにはつながない（ハウリング防止）
  await ac.resume();
  Object.assign(s.mic, { on: true, stream, ctx: ac, analyser, buf: new Float32Array(analyser.fftSize), level: 0 });
}
function stopMic(s) {
  const m = s.mic;
  m.stream?.getTracks().forEach((t) => t.stop());
  try { m.ctx?.close(); } catch { /* noop */ }
  Object.assign(m, { on: false, stream: null, ctx: null, analyser: null, buf: null, level: 0 });
}
/** 現在の音量を 0〜1 で返す（-55dB→0、-15dB→1） */
function readMic(m) {
  if (!m.on) return 0;
  m.analyser.getFloatTimeDomainData(m.buf);
  let sum = 0;
  for (let i = 0; i < m.buf.length; i++) sum += m.buf[i] * m.buf[i];
  const db = 10 * Math.log10(sum / m.buf.length + 1e-10);
  return clamp((db + 55) / 40, 0, 1);
}

// ---------- 姿勢データの出どころ: 待機モーション ----------
// STEP 5 では、スマホから届いた数値で同じ pose を書き換える処理に差し替える。
function idlePose(s, t, dt) {
  const p = s.pose;
  p.tracked = false;
  p.yaw = Math.sin(t * 0.6) * 0.16;
  p.pitch = Math.sin(t * 0.43 + 1) * 0.08;
  p.roll = Math.sin(t * 0.5 + 2) * 0.06;
  // まばたき: 数秒おきに 0.15 秒だけ閉じる
  if (s.blinkT < 0 && t >= s.nextBlink) s.blinkT = 0;
  let blink = 0;
  if (s.blinkT >= 0) {
    s.blinkT += dt;
    blink = s.blinkT < 0.15 ? 1 : 0;
    if (s.blinkT >= 0.15) { s.blinkT = -1; s.nextBlink = t + 2.5 + Math.random() * 3; }
  }
  p.blinkL = p.blinkR = blink;
  // 口: マイクの音量。上がるときは速く、下がるときはゆっくり
  const target = s.mic.level;
  p.mouthOpen += (target - p.mouthOpen) * Math.min(1, dt * (target > p.mouthOpen ? 30 : 12));
  p.smile = 0.3;
  p.browUp = p.mouthOpen * 0.4;
}

// ---------- 毎フレームの処理 ----------
function drawBackground(s) {
  const { ctx, bg } = s;
  if (bg.image) {
    // 画像は切り抜いて画面いっぱいに（cover）
    const iw = bg.image.naturalWidth, ih = bg.image.naturalHeight;
    const scale = Math.max(STAGE_W / iw, STAGE_H / ih);
    const dw = iw * scale, dh = ih * scale;
    ctx.drawImage(bg.image, (STAGE_W - dw) / 2, (STAGE_H - dh) / 2, dw, dh);
  } else {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);
  }
}

function frame(now) {
  const s = session;
  if (!s) return;
  s.raf = requestAnimationFrame(frame);
  if (document.hidden) { s.last = now; return; } // 裏にいる間は描かない
  const dt = Math.min(0.1, (now - s.last) / 1000);
  s.last = now;
  const t = (now - s.start) / 1000;

  s.mic.level = readMic(s.mic);
  idlePose(s, t, dt);
  s.avatar.update(s.pose, dt);

  drawBackground(s);
  s.avatar.draw(s.ctx, STAGE_W, STAGE_H);

  // 音量メーターは値が変わったときだけ書き換える
  const shown = Math.round(s.mic.level * 100);
  if (shown !== s.meterShown) {
    s.meterShown = shown;
    s.meterBar.style.transform = `scaleX(${shown / 100})`;
    s.meterEl.setAttribute('aria-valuenow', String(shown));
  }
}

