// avatarRenderer.js — キャラクター描画の「共通の形」と、ダミーキャラクター
//
// ■ AvatarRenderer（描画側の約束）
//   update(pose, dt)      … 姿勢データを受け取って内部状態を進める（dt は秒）
//   draw(ctx, w, h)       … 2Dキャンバスの (0,0)-(w,h) にキャラクターを描く（背景は描かない）
//   dispose()             … 後片付け
//   STEP 5 の VRMRenderer、将来の Live2DRenderer も同じ3つを実装すれば差し替えられる。
//   （3D の場合は自分の WebGL キャンバスに描いてから draw() で ctx に転写する想定）
//
// ■ pose（姿勢データ）
//   スマホの顔トラッカーが送ってくる数値と同じ形にしてある。映像は含まない。
//   角度は -1〜1 に正規化（おおよそ ±45度）、それ以外は 0〜1。

/** 何もしていないときの姿勢。毎フレーム作り直さず、同じオブジェクトを書き換えて使う */
export function neutralPose() {
  return {
    tracked: false,   // 顔を認識できているか
    yaw: 0,           // 左右の向き（＋で画面右）
    pitch: 0,         // 上下の向き（＋で下）
    roll: 0,          // かしげ（＋で時計回り）
    blinkL: 0,        // 左目の閉じ具合
    blinkR: 0,        // 右目の閉じ具合
    mouthOpen: 0,     // 口の開き
    smile: 0,         // 笑顔
    browUp: 0,        // 眉の上がり
  };
}

const lerp = (a, b, k) => a + (b - a) * k;

/** ライブラリ不要のダミーキャラクター（2D）。収録画面の動作確認用 */
export class DummyAvatar {
  constructor() {
    this.p = neutralPose(); // なめらかに追従させた現在値
  }

  update(pose, dt) {
    const p = this.p;
    const k = Math.min(1, dt * 14);       // 頭はゆっくり追従
    const kf = Math.min(1, dt * 30);      // 目と口は速く追従
    p.yaw = lerp(p.yaw, pose.yaw, k);
    p.pitch = lerp(p.pitch, pose.pitch, k);
    p.roll = lerp(p.roll, pose.roll, k);
    p.smile = lerp(p.smile, pose.smile, k);
    p.browUp = lerp(p.browUp, pose.browUp, k);
    p.blinkL = lerp(p.blinkL, pose.blinkL, kf);
    p.blinkR = lerp(p.blinkR, pose.blinkR, kf);
    p.mouthOpen = lerp(p.mouthOpen, pose.mouthOpen, kf);
  }

  draw(ctx, w, h) {
    const p = this.p;
    const u = h / 720;                    // 720p を基準にした拡大率
    const cx = w / 2, cy = h * 0.47;

    // 体（頭の動きに少しだけついてくる）
    ctx.fillStyle = '#5563d8';
    ctx.beginPath();
    ctx.ellipse(cx + p.yaw * 14 * u, h + 40 * u, 250 * u, 230 * u, 0, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = '#f3cfae';
    ctx.fillRect(cx - 34 * u + p.yaw * 20 * u, cy + 110 * u, 68 * u, 90 * u);

    // 頭
    ctx.save();
    ctx.translate(cx + p.yaw * 46 * u, cy + p.pitch * 26 * u);
    ctx.rotate(p.roll * 0.5);

    ctx.fillStyle = '#3d2b63';            // 後ろ髪
    ctx.beginPath(); ctx.ellipse(0, 6 * u, 176 * u, 182 * u, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffe3c8';            // 顔
    ctx.beginPath(); ctx.ellipse(0, 14 * u, 146 * u, 152 * u, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#3d2b63';            // 前髪
    ctx.beginPath();
    ctx.ellipse(0, 6 * u, 160 * u, 166 * u, 0, Math.PI * 1.02, Math.PI * 1.98);
    ctx.quadraticCurveTo(70 * u - p.yaw * 30 * u, -50 * u, -p.yaw * 40 * u, -66 * u);
    ctx.quadraticCurveTo(-80 * u - p.yaw * 30 * u, -48 * u, -158 * u, -4 * u);
    ctx.fill();

    // 顔のパーツは向きに合わせて少しずらす
    const fx = p.yaw * 30 * u, fy = p.pitch * 20 * u;
    for (const side of [-1, 1]) {
      const blink = side < 0 ? p.blinkL : p.blinkR;
      const ex = fx + side * 58 * u, ey = fy + 20 * u;
      const open = Math.max(0.08, 1 - blink);
      ctx.fillStyle = '#2a1f45';
      ctx.beginPath(); ctx.ellipse(ex, ey, 17 * u, 24 * u * open, 0, 0, Math.PI * 2); ctx.fill();
      if (open > 0.5) {
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.ellipse(ex + 5 * u, ey - 8 * u, 5 * u, 6 * u, 0, 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = '#3d2b63'; ctx.lineWidth = 6 * u; ctx.lineCap = 'round';   // 眉
      ctx.beginPath();
      ctx.moveTo(ex - 20 * u, ey - (40 + p.browUp * 12) * u);
      ctx.lineTo(ex + 20 * u, ey - (40 + p.browUp * 12) * u);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 120, 140, .28)';                                   // ほお
      ctx.beginPath(); ctx.ellipse(ex + side * 22 * u, ey + 46 * u, 22 * u, 12 * u, 0, 0, Math.PI * 2); ctx.fill();
    }

    // 口: 閉じているときは線、開くと楕円
    const mx = fx, my = fy + 84 * u;
    const mw = (24 + p.smile * 10) * u;
    if (p.mouthOpen < 0.06) {
      ctx.strokeStyle = '#a8455c'; ctx.lineWidth = 5 * u;
      ctx.beginPath(); ctx.arc(mx, my - 10 * u, mw, Math.PI * 0.2, Math.PI * 0.8); ctx.stroke();
    } else {
      ctx.fillStyle = '#a8455c';
      ctx.beginPath(); ctx.ellipse(mx, my + 4 * u, mw, (5 + p.mouthOpen * 30) * u, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  dispose() { /* 2D なので解放するものはない */ }
}

/** 選べるキャラクターの一覧。STEP 5 で VRM をここに足す */
export const AVATARS = [
  { id: 'dummy', label: 'ダミーキャラクター', create: () => new DummyAvatar() },
];
