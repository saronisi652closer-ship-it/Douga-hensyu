// vtuber.js — VTuber収録画面（タブレット側）
//
// STEP 2: 画面と基本動作。外部ライブラリなし。
//   ・ダミーキャラクターが待機モーションで動き、マイクの音量で口が動く
//   ・背景（色 / 画像）、キャラクター選択、マイクON/OFFと音量表示
//   ・スマホ接続は「枠」だけ（STEP 3 で中身を入れる）
// STEP 6・7: 録画と、編集画面への受け渡し。
//   ・録画中は「録画中モード」（プレビューを大きく、設定は隠す）
//   ・停止後は 編集する / 端末に保存 / 撮り直す
//   ・「編集する」は録画データを File にして、app.js から渡された onEdit(file) を呼ぶ
//     （中身は既存の openFile(file)）
//
// 作りの方針:
//   ・姿勢データ(pose)を作る部分 / キャラクターを描く部分 / 画面に出す部分 を分けてある。
//     pose の出どころを「待機モーション」から「スマホの顔トラッキング」に替えるだけで STEP 5 に進める。
//   ・合成先は1枚のキャンバス(stage)。録画はこのキャンバスと音声を stageRecorder.js に渡すだけ。
//   ・編集画面の状態（state.js / video.js / timeline.js）には触らない。

import { toast, clamp, fmtTime, fmtBytes, keepAwake } from './utils.js';
import { AVATARS, neutralPose } from './avatarRenderer.js';
import { createStageStream, StageRecorder } from './stageRecorder.js';

const STAGE_W = 1280, STAGE_H = 720, STAGE_FPS = 30;
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
    <span class="vt-badge vt-timer"><i></i><span data-out="timer">0:00</span></span>
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
      <div class="vt-rec-main">
        <button class="vt-rec" data-act="record" aria-label="録画開始"><i></i></button>
        <div class="vt-rec-text">
          <strong data-out="rec-title">録画開始</strong>
          <span data-out="rec-sub"></span>
        </div>
      </div>
      <div class="vt-rec-chips" hidden>
        <button class="chip-btn" data-act="mic-chip" aria-pressed="false">マイク OFF</button>
        <span class="vt-chip"><i class="vt-dot"></i><span data-out="conn-chip">スマホ 未接続</span></span>
        <button class="chip-btn" data-act="settings" aria-pressed="false">設定</button>
      </div>
      <div class="vt-result" hidden>
        <p class="vt-result-title"><strong>録画しました</strong><span data-out="result-info"></span></p>
        <button class="btn primary" data-act="edit">編集する</button>
        <div class="vt-result-row">
          <a class="btn ghost" data-act="save">端末に保存</a>
          <button class="btn ghost" data-act="retake">撮り直す</button>
        </div>
        <p class="hint">「編集する」でそのまま編集画面に移ります。あとで続きから編集したいときは、先に端末に保存しておいてください。</p>
      </div>
    </div>
  </div>
`;

/**
 * 収録画面を開く
 * @param opts { root: 入れ物の要素,
 *               onClose: ホームへ戻るときに呼ぶ関数,
 *               onEdit(file): 録画を編集画面で開く関数。開けたら true を返す }
 */
export async function openVtuber({ root, onClose, onEdit }) {
  if (session) return;
  await loadCss();
  root.innerHTML = TEMPLATE;
  root.hidden = false;

  const q = (sel) => root.querySelector(sel);
  const prefs = loadPrefs();
  const canvas = q('.vt-canvas');
  const ctx = canvas.getContext('2d', { alpha: false });

  const s = session = {
    root, onClose, onEdit, canvas, ctx, q,
    pose: neutralPose(),
    avatar: null,
    bg: { color: BG_COLORS.some(([c]) => c === prefs.color) ? prefs.color : BG_COLORS[0][0], image: null, imageUrl: null },
    audio: null,   // { ctx, dest } 録画用の音声の出口。最初に必要になったとき作る
    mic: { on: false, stream: null, source: null, analyser: null, buf: null, level: 0 },
    rec: null,     // 録画中の StageRecorder
    result: null,  // 録画結果 { file, url, seconds, saved }
    releaseWake: null, timerShown: -1,
    timerEl: q('[data-out=timer]'),
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

  // ----- マイク（設定欄のボタンと、録画中モードのチップは同じ処理）-----
  q('[data-act=mic]').addEventListener('click', () => toggleMic(s));
  q('[data-act=mic-chip]').addEventListener('click', () => toggleMic(s));

  // ----- 録画 -----
  q('[data-act=record]').addEventListener('click', () => (s.rec ? stopRecording(s) : startRecording(s)));
  q('[data-act=settings]').addEventListener('click', (e) => {
    const open = root.classList.toggle('show-settings');
    e.currentTarget.setAttribute('aria-pressed', String(open));
    e.currentTarget.textContent = open ? '設定を閉じる' : '設定';
  });
  q('[data-act=edit]').addEventListener('click', () => editResult(s));
  q('[data-act=save]').addEventListener('click', () => { if (s.result) s.result.saved = true; });
  q('[data-act=retake]').addEventListener('click', () => {
    if (!s.result.saved && !confirm('この録画は保存されていません。破棄して撮り直しますか？')) return;
    clearResult(s);
    renderRecState(s);
  });
  window.addEventListener('beforeunload', onBeforeUnload);
  renderRecState(s);

  q('[data-act=close]').addEventListener('click', () => {
    if (s.rec && !confirm('録画中です。録画を破棄してホームに戻りますか？')) return;
    if (!s.rec && s.result && !s.result.saved && !confirm('録画が保存されていません。破棄してホームに戻りますか？')) return;
    closeVtuber();
  });

  s.last = performance.now();
  s.raf = requestAnimationFrame(frame);
}

/** 収録画面を閉じる。toHome=false は「編集画面へ移る」ときに使う（ホームは出さない） */
export function closeVtuber({ toHome = true } = {}) {
  const s = session;
  if (!s) return;
  session = null;
  cancelAnimationFrame(s.raf);
  window.removeEventListener('beforeunload', onBeforeUnload);
  if (s.rec) { s.rec.stop(); s.rec = null; }   // 破棄
  s.releaseWake?.();
  stopMic(s);
  try { s.audio?.ctx.close(); } catch { /* noop */ }
  s.avatar?.dispose();
  if (s.bg.imageUrl) URL.revokeObjectURL(s.bg.imageUrl);
  if (s.result) URL.revokeObjectURL(s.result.url);
  s.root.hidden = true;
  s.root.classList.remove('recording', 'show-settings');
  s.root.replaceChildren();
  if (toHome) s.onClose?.();
}

function onBeforeUnload(e) {
  const s = session;
  if (s && (s.rec || (s.result && !s.result.saved))) { e.preventDefault(); e.returnValue = ''; }
}

// ---------- 音声 ----------
/** 録画に渡す音声の出口を用意する。マイクはここにつなぐ（OFFのときは無音が流れる） */
function ensureAudio(s) {
  if (s.audio) return s.audio;
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  const dest = ctx.createMediaStreamDestination();
  // 何もつながっていなくても音声トラックが止まらないよう、無音を流し続ける
  const silence = ctx.createConstantSource();
  silence.offset.value = 0;
  silence.connect(dest);
  silence.start();
  s.audio = { ctx, dest };
  return s.audio;
}

async function startMic(s) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('このブラウザはマイク入力に対応していません');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
  if (session !== s) { stream.getTracks().forEach((t) => t.stop()); return; }
  const { ctx, dest } = ensureAudio(s);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  const source = ctx.createMediaStreamSource(stream);
  source.connect(analyser);   // 音量表示・口パク用
  source.connect(dest);       // 録画用（スピーカーにはつながない＝ハウリングしない）
  await ctx.resume();
  Object.assign(s.mic, { on: true, stream, source, analyser, buf: new Float32Array(analyser.fftSize), level: 0 });
}
function stopMic(s) {
  const m = s.mic;
  try { m.source?.disconnect(); } catch { /* noop */ }
  m.stream?.getTracks().forEach((t) => t.stop());
  Object.assign(m, { on: false, stream: null, source: null, analyser: null, buf: null, level: 0 });
}
async function toggleMic(s) {
  const btn = s.q('[data-act=mic]'), chip = s.q('[data-act=mic-chip]');
  btn.disabled = chip.disabled = true;
  try { s.mic.on ? stopMic(s) : await startMic(s); }
  catch (e) {
    console.warn(e);
    toast(e.name === 'NotAllowedError'
      ? 'マイクの使用が許可されていません。ブラウザのサイト設定でマイクを許可してください。'
      : 'マイクを開始できませんでした。マイクが接続されているか確認してください。', null, 7000);
  }
  if (session !== s) return;
  btn.disabled = chip.disabled = false;
  btn.textContent = s.mic.on ? 'マイクをOFFにする' : 'マイクをONにする';
  btn.setAttribute('aria-pressed', String(s.mic.on));
  btn.classList.toggle('solid', s.mic.on);
  chip.textContent = s.mic.on ? 'マイク ON' : 'マイク OFF';
  chip.setAttribute('aria-pressed', String(s.mic.on));
  chip.classList.toggle('solid', s.mic.on);
  renderRecState(s);
}

// ---------- 録画 ----------
/** 録画まわりの表示を、今の状態（待機 / 録画中 / 録画済み）に合わせる */
function renderRecState(s) {
  const { q, root } = s;
  const recording = !!s.rec, done = !recording && !!s.result;
  root.classList.toggle('recording', recording);
  if (!recording) {
    root.classList.remove('show-settings');
    const set = q('[data-act=settings]');
    set.textContent = '設定'; set.setAttribute('aria-pressed', 'false');
  }
  q('.vt-rec-main').hidden = done;
  q('.vt-rec-chips').hidden = !recording;
  q('.vt-result').hidden = !done;
  q('.vt-timer').classList.toggle('rec', recording);

  const btn = q('[data-act=record]');
  btn.classList.toggle('stop', recording);
  btn.setAttribute('aria-label', recording ? '録画を停止' : '録画開始');
  q('[data-out=rec-title]').textContent = recording ? '録画中' : '録画開始';
  q('[data-out=rec-sub]').textContent = recording
    ? '四角いボタンで停止します'
    : s.mic.on ? '背景・キャラクター・マイクの音声を録画します' : 'マイクがOFFです。このままだと音声なしで録画されます';
  if (!recording && !done) { s.timerShown = -1; s.timerEl.textContent = '0:00'; }
}

async function startRecording(s) {
  if (s.rec) return;
  try {
    const { ctx, dest } = ensureAudio(s);
    await ctx.resume();
    const stream = createStageStream(s.canvas, dest.stream.getAudioTracks()[0], STAGE_FPS);
    const rec = new StageRecorder(stream, { width: STAGE_W, height: STAGE_H, fps: STAGE_FPS });
    rec.start();
    s.rec = rec;
  } catch (e) {
    console.error(e);
    toast('録画を開始できませんでした: ' + e.message, null, 7000);
    return;
  }
  s.releaseWake = await keepAwake();   // 録画中は画面を消さない
  if (session === s) renderRecState(s);
}

async function stopRecording(s) {
  const rec = s.rec;
  if (!rec) return;
  s.q('[data-act=record]').disabled = true;
  const out = await rec.stop();
  s.releaseWake?.(); s.releaseWake = null;
  if (session !== s) return;
  s.rec = null;
  s.q('[data-act=record]').disabled = false;
  if (!out.blob.size) {
    toast('録画データが空でした。もう一度録画してください。', null, 6000);
    renderRecState(s);
    return;
  }
  // 録画データはこの画面が持ち続ける。File にしておけば、そのまま編集画面へ渡せる
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `vtuber_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${out.ext}`;
  const file = new File([out.blob], name, { type: out.blob.type, lastModified: d.getTime() });
  clearResult(s);
  s.result = { file, url: URL.createObjectURL(file), seconds: out.seconds, saved: false };
  const save = s.q('[data-act=save]');
  save.href = s.result.url; save.download = name;
  s.q('[data-out=result-info]').textContent = `${fmtTime(out.seconds)}、${fmtBytes(file.size)}`;
  s.timerEl.textContent = fmtTime(out.seconds);
  renderRecState(s);
}

function clearResult(s) {
  if (!s.result) return;
  URL.revokeObjectURL(s.result.url);
  s.result = null;
  const save = s.q('[data-act=save]');
  save.removeAttribute('href'); save.removeAttribute('download');
}

/** 「編集する」: 録画を既存の編集画面で開く。開けたら収録画面を閉じる */
async function editResult(s) {
  if (!s.result || !s.onEdit) return;
  const btn = s.q('[data-act=edit]');
  btn.disabled = true; btn.textContent = '編集画面を開いています…';
  let ok = false;
  try { ok = await s.onEdit(s.result.file); } catch (e) { console.error(e); }
  if (session !== s) return;
  if (ok) { closeVtuber({ toHome: false }); return; }
  // 開けなかったときは録画を失わないよう、この画面に残る
  btn.disabled = false; btn.textContent = '編集する';
  toast('編集画面で開けませんでした。「端末に保存」で録画を保存できます。', null, 8000);
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

  // 録画時間（秒が変わったときだけ書き換える）
  if (s.rec) {
    const sec = Math.floor(s.rec.elapsed);
    if (sec !== s.timerShown) { s.timerShown = sec; s.timerEl.textContent = fmtTime(sec); }
  }

  // 音量メーターは値が変わったときだけ書き換える
  const shown = Math.round(s.mic.level * 100);
  if (shown !== s.meterShown) {
    s.meterShown = shown;
    s.meterBar.style.transform = `scaleX(${shown / 100})`;
    s.meterEl.setAttribute('aria-valuenow', String(shown));
  }
}

