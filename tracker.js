// tracker.js — スマホ側（顔トラッカー）の画面
//
// STEP 3: テスト用のスライダーで TrackingFrame を作り、タブレットへ送る。
// STEP 4 では、スライダーの代わりに MediaPipe の結果を同じ frame に書き込むだけでよい
// （接続・送信の処理はそのまま使う）。

import { createTransport, normalizeRoomCode } from './trackingTransport.js';
import { PROTOCOL_VERSION, SEND_FPS, MSG, FRAME_RANGES, createFrame } from './trackingProtocol.js';
import { toast, keepAwake } from './utils.js';

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
setInterval(() => {
  if (auto) autoMove(performance.now());
  if (state !== 'connected' || !dirty) return; // 変化が無いときの生存確認は通信側が自動で送る
  frame.timestamp = Date.now();
  frame.seq++;
  if (transport.send({ t: MSG.FRAME, d: frame })) { dirty = false; sent++; }
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
      tr.send({ t: MSG.HELLO, v: PROTOCOL_VERSION, role: 'tracker', source: 'test-sliders' });
      dirty = true; // 今の値をすぐ送る
      releaseWake ??= await keepAwake();
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
  releaseWake?.(); releaseWake = null;
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

// QRコードから開いたときはコードが付いているので、そのまま接続する
const fromUrl = normalizeRoomCode(new URLSearchParams(location.search).get('room'));
let lastRoom = '';
try { lastRoom = normalizeRoomCode(localStorage.getItem(LAST_ROOM_KEY)); } catch { /* noop */ }
roomInput.value = fromUrl || lastRoom;
render();
if (fromUrl.length === 6) connect();
