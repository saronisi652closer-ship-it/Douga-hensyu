// tracker.js — スマホ側（顔トラッカー）の画面
//
// 送るデータ(TrackingFrame)の出どころは2つ。どちらも同じ frame に書き込むだけで、
// 接続・送信の処理は共通:
//   ・カメラ（faceTracker.js が MediaPipe で顔を解析）… STEP 4
//   ・手動テスト用のスライダー                       … STEP 3
// カメラ映像はこの端末の外へ出さない。送るのは frame の数値だけ。

import { createTransport, normalizeRoomCode } from './trackingTransport.js';
import { PROTOCOL_VERSION, SEND_FPS, MSG, FRAME_RANGES, createFrame } from './trackingProtocol.js';
import { toast, keepAwake } from './utils.js';
import { FaceTracker } from './faceTracker.js';

const $ = (id) => document.getElementById(id);
const LAST_ROOM_KEY = 'kiritoru.lastRoom';

// スライダーの定義: [frame のキー, ラベル, 最小, 最大, 刻み, 初期値]
const SLIDERS = [
  ['headYaw', '頭の左右（＋で右）', -45, 45, 1, 0],
  ['headPitch', '頭の上下（＋で下）', -30, 30, 1, 0],
  ['headRoll', '頭の傾き（＋で右へ）', -30, 30, 1, 0],
  ['mouthOpen', '口の開き', 0, 1, 0.01, 0],
  ['leftEyeOpen', '左目（1で開く）', 0, 1, 0.01, 1],
  ['rightEyeOpen', '右目（1で開く）', 0, 1, 0.01, 1],
];

const frame = createFrame();      // 送るデータ。同じオブジェクトを書き換えて使い回す
let transport = null;
let state = 'closed', info = {}, route = '';
let dirty = true;                 // 前回の送信から値が変わったか
let auto = false, autoStart = 0;
let sent = 0;                     // 直近1秒の送信回数
let releaseWake = null;
let camera = 'stopped';           // カメラの状態: 'stopped' | 'loading' | 'running'

// ---------- スライダー ----------
const inputs = {};
for (const [key, label, min, max, step, init] of SLIDERS) {
  const out = document.createElement('output');
  const input = Object.assign(document.createElement('input'), { type: 'range', min, max, step, value: init });
  input.setAttribute('aria-label', label);
  const row = document.createElement('label');
  row.className = 'tk-slider';
  row.append(document.createTextNode(label), out, input);
  $('sliders').append(row);
  inputs[key] = { input, out, init, step };
  input.addEventListener('input', () => { setValue(key, Number(input.value), false); });
  setValue(key, init, true);
}
function setValue(key, v, moveSlider) {
  const [lo, hi] = FRAME_RANGES[key];
  frame[key] = Math.min(hi, Math.max(lo, v));
  const it = inputs[key];
  it.out.textContent = it.step < 1 ? frame[key].toFixed(2) : String(Math.round(frame[key]));
  if (moveSlider) it.input.value = frame[key];
  dirty = true;
}
function setSlidersEnabled(on) {
  for (const key in inputs) inputs[key].input.disabled = !on;
  $('reset').disabled = $('auto').disabled = !on;
}
$('reset').addEventListener('click', () => { for (const key in inputs) setValue(key, inputs[key].init, true); });
$('auto').addEventListener('click', () => {
  auto = !auto; autoStart = performance.now();
  $('auto').setAttribute('aria-pressed', String(auto));
  $('auto').textContent = auto ? '自動を止める' : '自動で動かす';
});
/** 手を離して動作確認できるよう、それらしい動きを作る */
function autoMove(now) {
  const t = (now - autoStart) / 1000;
  setValue('headYaw', Math.sin(t * 0.9) * 30, true);
  setValue('headPitch', Math.sin(t * 0.6 + 1) * 15, true);
  setValue('headRoll', Math.sin(t * 0.7 + 2) * 15, true);
  setValue('mouthOpen', Math.max(0, Math.sin(t * 5)) * 0.8, true);
  const blink = t % 3 < 0.15 ? 0 : 1;
  setValue('leftEyeOpen', blink, true);
  setValue('rightEyeOpen', blink, true);
}

// ---------- 送信（30fps前後・値が変わったときだけ）----------
/** 今の frame を送る（つながっていて、値が変わっているときだけ）*/
function flush() {
  if (state !== 'connected' || !dirty) return; // 変化が無いときの生存確認は通信側が自動で送る
  frame.timestamp = Date.now();
  frame.seq++;
  if (transport.send({ t: MSG.FRAME, d: frame })) { dirty = false; sent++; }
}
// スライダー・自動のときは一定間隔で送る。カメラのときは解析が終わるたびにすぐ送る（下の onValues）
setInterval(() => {
  if (camera !== 'stopped') return;
  if (auto) autoMove(performance.now());
  flush();
}, 1000 / SEND_FPS);
setInterval(() => { $('rate').textContent = String(sent); sent = 0; }, 1000);

// ---------- 接続 ----------
const roomInput = $('room');
roomInput.addEventListener('input', () => { roomInput.value = normalizeRoomCode(roomInput.value); });
$('connect').addEventListener('click', () => {
  if (state === 'closed' || state === 'error') connect(); else disconnect();
});

async function connect() {
  const room = normalizeRoomCode(roomInput.value);
  if (room.length !== 6) { toast('タブレットに表示されている6文字のコードを入力してください'); return; }
  try { localStorage.setItem(LAST_ROOM_KEY, room); } catch { /* noop */ }
  transport?.close();
  const tr = transport = createTransport('peerjs');
  tr.onState = async (st, inf) => {
    if (transport !== tr) return;
    state = st; info = inf;
    if (st === 'connected') {
      tr.send({ t: MSG.HELLO, v: PROTOCOL_VERSION, role: 'tracker', source: camera === 'running' ? 'mediapipe' : 'test-sliders' });
      dirty = true; // 今の値をすぐ送る
      updateWake();
      tr.describeRoute().then((r) => { if (transport === tr) { route = r; render(); } });
      setTimeout(() => tr.describeRoute().then((r) => { if (transport === tr && r) { route = r; render(); } }), 3000);
    }
    render();
  };
  tr.onMessage = () => {};
  try { await tr.join(room); }
  catch (e) { console.error(e); if (transport === tr) { state = 'error'; info = { code: 'load' }; render(); } }
}
function disconnect() {
  transport?.close();
  transport = null;
  state = 'closed'; info = {}; route = '';
  updateWake();
  render();
}

function render() {
  const TEXT = {
    closed: '未接続',
    starting: '準備中…',
    connecting: 'タブレットに接続しています…',
    connected: 'タブレットと接続中',
    reconnecting: '接続が切れました。つなぎ直しています…',
    error: info.code === 'not-found' ? 'タブレットが見つかりません' : '接続できませんでした',
  };
  $('status').textContent = TEXT[state] ?? '未接続';
  $('dot').className = 'tk-dot' + (state === 'connected' ? ' on' : state === 'closed' || state === 'error' ? '' : ' warn');
  $('method').textContent = state === 'connected' ? `接続方式: ${transport.label}${route ? '・' + route : ''}` : '';
  $('connect').textContent = state === 'closed' ? '接続' : state === 'error' ? 'もう一度接続する' : state === 'connected' || state === 'reconnecting' ? '切断' : '接続をやめる';
  $('connect').className = 'btn ' + (state === 'closed' || state === 'error' ? 'primary' : 'ghost');
  roomInput.disabled = !(state === 'closed' || state === 'error');
  $('hint').textContent =
    state === 'error' && info.code === 'not-found' ? 'コードが合っているか確認し、タブレットの VTuber収録 画面で「スマホを接続」を押してから、もう一度試してください。'
    : state === 'error' ? '接続用のファイルを読み込めませんでした。通信状況を確認してください。'
    : state === 'reconnecting' ? 'このまま待つと自動でつながります。タブレット側の画面はそのまま動いています。'
    : state === 'connected' ? '接続中は画面が消えないようにしています。'
    : '';
}

/** 接続中またはカメラ使用中は画面を消さない */
async function updateWake() {
  const need = state === 'connected' || state === 'reconnecting' || camera !== 'stopped';
  if (need && !releaseWake) releaseWake = await keepAwake();
  else if (!need && releaseWake) { releaseWake(); releaseWake = null; }
}
// 別のアプリから戻ってきたときは、画面を消さない設定が外れているので掛け直す
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && releaseWake) { releaseWake(); releaseWake = null; updateWake(); }
});

// ---------- カメラで顔トラッキング ----------
const KEYS = ['headYaw', 'headPitch', 'headRoll', 'mouthOpen', 'leftEyeOpen', 'rightEyeOpen', 'smile', 'browUp'];
const tracker = new FaceTracker({
  video: $('cam'),
  // 解析のたびに、結果を送信用の frame に写す
  onValues: (v) => {
    for (let i = 0; i < KEYS.length; i++) frame[KEYS[i]] = v[KEYS[i]];
    frame.faceDetected = v.faceDetected;
    dirty = true;
    flush(); // 解析は最大30回/秒なので、送信もそれを超えない
  },
  onStatus: (st) => { camera = st; renderCamera(); updateWake(); },
});

$('cam-toggle').addEventListener('click', async () => {
  if (camera !== 'stopped') { stopCamera(); return; }
  if (auto) $('auto').click();
  try {
    await tracker.start();
    if (state === 'connected') transport.send({ t: MSG.HELLO, v: PROTOCOL_VERSION, role: 'tracker', source: 'mediapipe' });
  } catch (e) {
    console.error(e);
    toast(e.name === 'NotAllowedError' ? 'カメラの使用が許可されていません。ブラウザのサイト設定でカメラを許可してください。'
      : e.name === 'NotFoundError' || e.name === 'NotSupportedError' ? 'カメラが見つかりませんでした。'
      : '顔トラッキングを開始できませんでした。通信状況を確認して、もう一度試してください。', null, 8000);
  }
});
function stopCamera() {
  tracker.stop();
  // スライダーの値に戻す
  for (const key in inputs) setValue(key, Number(inputs[key].input.value), false);
  frame.smile = 0; frame.browUp = 0; frame.faceDetected = true;
  dirty = true;
  flush();
}
$('calibrate').addEventListener('click', () => {
  toast(tracker.calibrate() ? 'いまの向きを正面にしました' : '顔が見つかってから押してください');
});
$('head-gain').addEventListener('input', (e) => { tracker.headGain = Number(e.target.value); $('head-gain-out').textContent = tracker.headGain.toFixed(1); });
$('mouth-gain').addEventListener('input', (e) => { tracker.mouthGain = Number(e.target.value); $('mouth-gain-out').textContent = tracker.mouthGain.toFixed(1); });
$('max-fps').addEventListener('change', (e) => { tracker.maxFps = Number(e.target.value); });

let faceShown = null;
function renderCamera() {
  $('cam-toggle').textContent = camera === 'stopped' ? 'カメラを開始' : camera === 'loading' ? '準備中…（押すと中止）' : 'カメラを停止';
  $('cam-toggle').className = 'btn ' + (camera === 'stopped' ? 'primary' : 'ghost');
  $('calibrate').disabled = camera !== 'running';
  setSlidersEnabled(camera === 'stopped');
  faceShown = null;
  renderFace();
}
/** 顔の検出状態と現在の値（1秒に数回だけ書き換える）*/
function renderFace() {
  const found = camera === 'running' && tracker.values.faceDetected;
  const key = camera + found;
  if (key !== faceShown) {
    faceShown = key;
    $('face-status').textContent = camera === 'stopped' ? '停止中'
      : camera === 'loading' ? '読み込み中…（初回は少し時間がかかります）'
      : found ? '顔を検出しています' : '顔が見つかりません';
    $('face-dot').className = 'tk-dot' + (found ? ' on' : camera === 'stopped' ? '' : ' warn');
  }
  const v = tracker.values;
  $('values').textContent = found
    ? `左右 ${v.headYaw.toFixed(0)}°　上下 ${v.headPitch.toFixed(0)}°　傾き ${v.headRoll.toFixed(0)}°\n口 ${v.mouthOpen.toFixed(2)}　左目 ${v.leftEyeOpen.toFixed(2)}　右目 ${v.rightEyeOpen.toFixed(2)}`
    : camera === 'running' ? '顔全体がカメラに映るようにしてください。' : '';
}
setInterval(() => { if (camera !== 'stopped') renderFace(); }, 200);
setInterval(() => {
  $('track-rate').textContent = String(tracker.count);
  $('track-cost').textContent = camera === 'running' && tracker.costMs ? `（1回 ${tracker.costMs.toFixed(0)} ミリ秒・${tracker.delegate}）` : '';
  tracker.count = 0;
}, 1000);
renderCamera();

// QRコードから開いたときはコードが付いているので、そのまま接続する
const fromUrl = normalizeRoomCode(new URLSearchParams(location.search).get('room'));
let lastRoom = '';
try { lastRoom = normalizeRoomCode(localStorage.getItem(LAST_ROOM_KEY)); } catch { /* noop */ }
roomInput.value = fromUrl || lastRoom;
render();
if (fromUrl.length === 6) connect();
