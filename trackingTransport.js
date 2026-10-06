// trackingTransport.js — 端末どうしの通信。方式を差し替えられるよう「共通の形」を決めてある
//
// ■ TrackingTransport（通信側の約束）
//   kind / label            方式の名前（画面の「接続方式」に出す）
//   host(room)              タブレット側: room の名前で待ち受ける
//   join(room)              スマホ側: room へつなぐ。切れたら自動でつなぎ直す
//   send(msg)               オブジェクトを1つ送る（送れたら true）
//   close()                 利用者が切断した。以後つなぎ直さない
//   describeRoute()         経路の説明（'同じネットワーク内で直接' など）。分からなければ ''
//   onState(state, info)    状態が変わったら呼ばれる
//   onMessage(msg)          メッセージが届いたら呼ばれる
//
//   state: 'starting'      準備中
//          'waiting'       （タブレット）スマホからの接続待ち
//          'connecting'    （スマホ）接続中
//          'connected'     つながっている
//          'reconnecting'  切れた。つなぎ直し中／待ち
//          'error'         続けられない問題。info.code に理由
//          'closed'        利用者が切断した
//
// いま実装しているのは PeerJsTransport だけ。USBテザリングは同じ PeerJsTransport のまま
// ネットワークだけが変わる想定。別のシグナリング方式や自前サーバーを足すときは、
// 同じ約束を満たすクラスを作って TRANSPORTS に登録すれば、画面側のコードは変えずに済む。

import { MSG, HEARTBEAT_MS, STALE_MS } from './trackingProtocol.js';

const ROOM_PREFIX = 'kiritoru-';   // 他の PeerJS 利用者と名前がぶつからないように付ける
const SIGNALING_KEY = 'kiritoru.signaling';

/**
 * シグナリングサーバー（端末どうしが相手を見つけるための仲介）の設定。
 * 既定は PeerJS の公開サーバー。自前サーバーに替えるときは、ここを書き換えるか、
 * localStorage の 'kiritoru.signaling' に {"host":"example.com","port":443,"path":"/","secure":true} を入れる。
 */
function signalingOptions() {
  try {
    const custom = JSON.parse(localStorage.getItem(SIGNALING_KEY));
    if (custom?.host) return custom;
  } catch { /* 既定を使う */ }
  return {}; // {} = PeerJS 公開サーバー
}

let peerJsLoading = null;
/** PeerJS 本体は、接続を使うときに初めて読み込む */
function loadPeerJs() {
  if (window.Peer) return Promise.resolve();
  peerJsLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'peerjs.min.js';
    s.onload = resolve;
    s.onerror = () => { peerJsLoading = null; s.remove(); reject(new Error('peerjs.min.js を読み込めませんでした')); };
    document.head.append(s);
  });
  return peerJsLoading;
}

class PeerJsTransport {
  constructor() {
    this.kind = 'peerjs';
    this.label = 'Wi-Fi（PeerJS）';
    this.onState = () => {};
    this.onMessage = () => {};
    this.state = 'closed';
    this.role = null; this.room = null;
    this.peer = null; this.conn = null;
    this.stopped = true;        // 利用者が切断した／まだ始めていない
    this.everConnected = false;
    this.everOpened = false;
    this.attempt = 0;
    this.lastRx = 0; this.lastTx = 0;
    this.timer = null; this.retryTimer = null; this.connectTimer = null;
  }

  // ---------- 公開している操作 ----------
  async host(room) { await this._begin('host', room); this._openHost(); }
  async join(room) { await this._begin('join', room); this._openJoin(); }

  send(msg) {
    const c = this.conn;
    if (!c || !c.open) return false;
    try { c.send(msg); this.lastTx = performance.now(); return true; }
    catch { return false; }
  }

  close() {
    this.stopped = true;
    this._clearTimers();
    this._destroyPeer();
    this._set('closed');
  }

  async describeRoute() {
    const pc = this.conn?.peerConnection;
    if (!pc) return '';
    try {
      const stats = await pc.getStats();
      let pair = null;
      stats.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId) ?? pair;
      });
      if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
      const type = pair && stats.get(pair.localCandidateId)?.candidateType;
      if (type === 'host') return '同じネットワーク内で直接';
      if (type === 'srflx' || type === 'prflx') return 'インターネット経由で直接';
      if (type === 'relay') return '中継サーバー経由';
    } catch { /* 取れなくても動作に影響なし */ }
    return '';
  }

  // ---------- 内部 ----------
  async _begin(role, room) {
    this._clearTimers();
    this._destroyPeer();
    this.role = role; this.room = room;
    this.stopped = false; this.everConnected = false; this.everOpened = false; this.attempt = 0;
    this._set('starting');
    await loadPeerJs();
    // 生存確認: 送るものが無ければ合図だけ送り、しばらく何も届かなければ切れたとみなす
    this.timer = setInterval(() => this._tick(), HEARTBEAT_MS / 2);
  }

  _set(state, info = {}) {
    this.state = state;
    try { this.onState(state, info); } catch (e) { console.error(e); }
  }
  _clearTimers() {
    clearInterval(this.timer); clearTimeout(this.retryTimer); clearTimeout(this.connectTimer);
    this.timer = this.retryTimer = this.connectTimer = null;
  }
  _destroyPeer() {
    const p = this.peer;
    this.peer = null; this.conn = null;
    try { p?.destroy(); } catch { /* noop */ }
  }

  _newPeer(id) {
    const peer = new window.Peer(id, { debug: 0, ...signalingOptions() });
    this.peer = peer;
    // シグナリングサーバーとの接続だけが切れた場合（端末どうしの通信は生きていることが多い）
    peer.on('disconnected', () => {
      if (this.stopped || this.peer !== peer || peer.destroyed) return;
      setTimeout(() => { if (!this.stopped && this.peer === peer && !peer.destroyed && peer.disconnected) { try { peer.reconnect(); } catch { /* noop */ } } }, 2000);
    });
    return peer;
  }

  // --- タブレット側 ---
  _openHost() {
    if (this.stopped) return;
    const peer = this._newPeer(ROOM_PREFIX + this.room);
    peer.on('open', () => {
      if (this.peer !== peer) return;
      this.everOpened = true; this.attempt = 0;
      if (!this.conn?.open) this._set(this.everConnected ? 'reconnecting' : 'waiting');
    });
    peer.on('connection', (conn) => { if (this.peer === peer) this._adopt(conn); });
    peer.on('error', (err) => {
      if (this.peer !== peer || this.stopped) return;
      if (err.type === 'unavailable-id' && !this.everOpened) {
        // 同じコードがすでに使われている → 呼び出し側が別のコードで host し直す
        this._destroyPeer();
        this._set('error', { code: 'id-taken' });
        return;
      }
      if (['network', 'server-error', 'socket-error', 'socket-closed', 'unavailable-id'].includes(err.type)) {
        // サーバーに届かない。端末どうしの通信が生きていればそのまま、待ち受けだけ作り直す
        if (this.conn?.open) return;
        this._destroyPeer();
        this._set(this.everConnected ? 'reconnecting' : 'starting', { code: 'no-server' });
        this._retry(() => this._openHost());
      }
    });
  }

  // --- スマホ側 ---
  _openJoin() {
    if (this.stopped) return;
    this._set(this.everConnected ? 'reconnecting' : 'connecting');
    const peer = this._newPeer(undefined);
    peer.on('open', () => {
      if (this.peer !== peer) return;
      const conn = peer.connect(ROOM_PREFIX + this.room, { serialization: 'json', reliable: false });
      this._adopt(conn);
      // 返事が来ないまま止まることがあるので、時間切れでやり直す
      this.connectTimer = setTimeout(() => { if (this.conn === conn && !conn.open) this._lost(); }, 8000);
    });
    peer.on('error', (err) => {
      if (this.peer !== peer || this.stopped) return;
      if (err.type === 'peer-unavailable' && !this.everConnected) {
        // コード違い、またはタブレットがまだ待ち受けていない
        this._destroyPeer();
        this._set('error', { code: 'not-found' });
        this.stopped = true; this._clearTimers();
        return;
      }
      if (!this.conn?.open) this._lost();
    });
  }

  _adopt(conn) {
    const old = this.conn;
    this.conn = conn;
    if (old && old !== conn) { try { old.close(); } catch { /* noop */ } }
    conn.on('open', () => {
      if (this.conn !== conn) return;
      clearTimeout(this.connectTimer);
      this.everConnected = true; this.attempt = 0;
      this.lastRx = this.lastTx = performance.now();
      this._set('connected');
    });
    conn.on('data', (msg) => {
      if (this.conn !== conn) return;
      this.lastRx = performance.now();
      if (msg && msg.t !== MSG.HEARTBEAT) { try { this.onMessage(msg); } catch (e) { console.error(e); } }
    });
    const gone = () => { if (this.conn === conn) this._lost(); };
    conn.on('close', gone);
    conn.on('error', gone);
  }

  _tick() {
    const c = this.conn;
    if (!c || !c.open) return;
    const now = performance.now();
    if (now - this.lastRx > STALE_MS) { this._lost(); return; }
    if (now - this.lastTx > HEARTBEAT_MS) this.send({ t: MSG.HEARTBEAT });
  }

  /** 相手との通信が切れた */
  _lost() {
    if (this.stopped) return;
    const c = this.conn;
    this.conn = null;
    clearTimeout(this.connectTimer);
    try { c?.close(); } catch { /* noop */ }
    if (this.state !== 'reconnecting') this._set('reconnecting');
    if (this.role === 'join') {
      // スマホ側がつなぎ直す。毎回まっさらな接続を作る
      this._destroyPeer();
      this._retry(() => this._openJoin());
    } else if (!this.peer || this.peer.destroyed) {
      this._retry(() => this._openHost());
    }
    // タブレット側は同じコードで待ち受け続けるだけでよい
  }

  _retry(fn) {
    clearTimeout(this.retryTimer);
    this.attempt++;
    const delay = Math.min(5000, 1000 * this.attempt); // 1秒, 2秒, … 最大5秒おき
    this.retryTimer = setTimeout(() => { if (!this.stopped) fn(); }, delay);
  }
}

/** 使える通信方式の一覧。方式を足すときはここに登録する */
const TRANSPORTS = {
  peerjs: () => new PeerJsTransport(),
};

export function createTransport(kind = 'peerjs') {
  const make = TRANSPORTS[kind];
  if (!make) throw new Error(`未対応の通信方式です: ${kind}`);
  return make();
}

/** 接続コード（6文字。読み間違えやすい 0/O/1/I は使わない） */
export function newRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let out = '';
  for (const b of bytes) out += chars[b % chars.length];
  return out;
}
export const normalizeRoomCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
