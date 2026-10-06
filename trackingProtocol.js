// trackingProtocol.js — スマホ（顔トラッカー）→ タブレットに送るデータの形式
//
// タブレット側とスマホ側の両方がこのファイルを読み込む。通信方式（PeerJS など）には依存しない。
// STEP 3 のテスト用スライダーも、STEP 4 の MediaPipe も、同じ TrackingFrame を作って送る。
// カメラ映像は送らない。送るのは下の数値だけ。

export const PROTOCOL_VERSION = 1;
export const SEND_FPS = 30;            // 送信の上限（1秒あたり）
export const HEARTBEAT_MS = 1000;      // 送るものが無いときの生存確認の間隔
export const STALE_MS = 4000;          // これだけ何も届かなければ「切れた」とみなす

/**
 * TrackingFrame（1回分の顔データ）
 * 向きは「演者本人から見た」左右。角度は度。
 *   headYaw        左右の向き。＋で本人の右を向く        （-60〜60）
 *   headPitch      上下の向き。＋で下を向く              （-45〜45）
 *   headRoll       かしげ。＋で本人の右肩側へ傾く        （-45〜45）
 *   mouthOpen      口の開き      0=閉 〜 1=全開
 *   leftEyeOpen    本人の左目    0=閉 〜 1=開
 *   rightEyeOpen   本人の右目    0=閉 〜 1=開
 *   smile          笑顔          0〜1
 *   browUp         眉の上がり    0〜1
 *   faceDetected   顔を認識できているか
 *   timestamp      送信側の時刻（ミリ秒、Date.now()）
 *   seq            通し番号（順番が入れ替わった古いデータを捨てるため）
 */
export function createFrame() {
  return {
    headYaw: 0, headPitch: 0, headRoll: 0,
    mouthOpen: 0, leftEyeOpen: 1, rightEyeOpen: 1,
    smile: 0, browUp: 0,
    faceDetected: true,
    timestamp: 0, seq: 0,
  };
}

/** 各数値の範囲 [最小, 最大]。スライダーの範囲と、受信時の値の丸めに使う */
export const FRAME_RANGES = {
  headYaw: [-60, 60], headPitch: [-45, 45], headRoll: [-45, 45],
  mouthOpen: [0, 1], leftEyeOpen: [0, 1], rightEyeOpen: [0, 1],
  smile: [0, 1], browUp: [0, 1],
};

/** 送るメッセージの種類。すべて { t: 種類, ... } の形 */
export const MSG = {
  HELLO: 'hello',   // 接続直後の自己紹介 { t, v, role, source }
  FRAME: 'frame',   // 顔データ           { t, d: TrackingFrame }
  HEARTBEAT: 'hb',  // 生存確認           { t }
};

/**
 * 受信したデータを検査しながら into に書き込む（毎回オブジェクトを作らない）。
 * 数値でないもの・範囲外は安全な値にする。古い順番のデータなら false。
 */
export function readFrame(src, into) {
  if (!src || typeof src !== 'object') return false;
  const seq = Number(src.seq) || 0;
  if (seq && into.seq && seq < into.seq && into.seq - seq < 1000) return false; // 追い越された古いデータ
  for (const key in FRAME_RANGES) {
    const v = Number(src[key]);
    if (!Number.isFinite(v)) continue;            // 無い値は前回のまま
    const [lo, hi] = FRAME_RANGES[key];
    into[key] = v < lo ? lo : v > hi ? hi : v;
  }
  into.faceDetected = src.faceDetected !== false;
  into.timestamp = Number(src.timestamp) || 0;
  into.seq = seq;
  return true;
}

/**
 * TrackingFrame → キャラクター用の pose（avatarRenderer.js の形）に変換。
 * キャラクターは「鏡」のように動かす（本人が右を向くと、画面でも右へ動く）。
 */
export function frameToPose(f, pose) {
  pose.tracked = f.faceDetected;
  pose.yaw = f.headYaw / 45;
  pose.pitch = f.headPitch / 45;
  pose.roll = f.headRoll / 45;
  pose.mouthOpen = f.mouthOpen;
  pose.blinkL = 1 - f.leftEyeOpen;
  pose.blinkR = 1 - f.rightEyeOpen;
  pose.smile = f.smile;
  pose.browUp = f.browUp;
  return pose;
}
