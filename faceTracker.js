// faceTracker.js — スマホのフロントカメラで顔を解析し、数値（TrackingFrame の中身）を作る
//
// ・MediaPipe Face Landmarker を使う。読み込むのは「カメラを開始」を押したときだけ
// ・カメラ映像はこの端末の中で解析するだけ。録画・保存・送信はしない
//   （外へ出るのは onValues に渡す数値だけ）
// ・通信のことは何も知らない。数値を作って呼び出し元に渡すだけ

// MediaPipe の読み込み元。自分のリポジトリに置く場合はここを書き換えるか、
// localStorage の 'kiritoru.mediapipe' に {"lib":"…","wasm":"…","model":"…"} を入れる。
// delegate は 'GPU'（既定。だめなら自動で CPU）か 'CPU'（最初から CPU を使う）
const SOURCES = {
  delegate: 'GPU',
  lib: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs',
  wasm: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm',
  model: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
};
function sources() {
  try { return { ...SOURCES, ...JSON.parse(localStorage.getItem('kiritoru.mediapipe') || '{}') }; }
  catch { return SOURCES; }
}

const DEG = 180 / Math.PI;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** v が lo のとき 0、hi のとき 1 になるように引き伸ばす */
const remap = (v, lo, hi) => clamp((v - lo) / (hi - lo), 0, 1);

// なめらかにする時間（秒）。小さいほど機敏、大きいほど安定
const TAU = { head: 0.07, mouth: 0.04, eye: 0.03, face: 0.10 };
const LOST_MS = 300;      // これだけ顔が見つからない状態が続いたら「見失った」とする（一瞬の検出漏れは無視）

export class FaceTracker {
  /**
   * @param opts { video: プレビュー用の <video>,
   *               onValues(values): 解析のたびに呼ばれる。values は毎回同じオブジェクト,
   *               onStatus(status): 'loading' | 'running' | 'stopped' }
   */
  constructor({ video, onValues, onStatus }) {
    this.video = video;
    this.onValues = onValues;
    this.onStatus = onStatus || (() => {});
    this.landmarker = null;
    this.delegate = '';
    this.stream = null;
    this.running = false;
    this.startId = 0;
    this.headGain = 1;       // 頭の動きの大きさ
    this.mouthGain = 1;      // 口の開きやすさ
    this.maxFps = 30;
    // 出力（毎回同じオブジェクトを書き換える）
    this.values = { headYaw: 0, headPitch: 0, headRoll: 0, mouthOpen: 0, leftEyeOpen: 1, rightEyeOpen: 1, smile: 0, browUp: 0, faceDetected: false };
    this.raw = { yaw: 0, pitch: 0, roll: 0 };      // 補正前の角度（「正面を合わせる」用）
    this.zero = { yaw: 0, pitch: 0, roll: 0 };     // 正面とみなす角度
    this.shapeIndex = null;                        // 表情の名前 → 配列の位置
    this.lost = true; this.lastSeen = 0;
    this.lastRun = 0; this.lastVideoTime = -1;
    this.costMs = 0;                               // 1回の解析にかかる時間（平均）
    this.count = 0;                                // 解析回数（呼び出し元が1秒ごとに読んで0に戻す）
    this._loop = this._loop.bind(this);
  }

  /** カメラを開いて解析を始める */
  async start() {
    if (this.running) return;
    const id = ++this.startId;           // 準備中に停止されたら、その後の処理をやめるための番号
    this.onStatus('loading');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no camera api'), { name: 'NotSupportedError' });
      // 解析には小さい映像で十分。大きくすると負荷だけ増える
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
      });
      if (id !== this.startId) { stream.getTracks().forEach((t) => t.stop()); return; }
      this.stream = stream;
      this.video.srcObject = stream;
      this.video.muted = true; this.video.playsInline = true;
      await this.video.play();
      if (!this.landmarker) await this._load();
    } catch (e) {
      if (id !== this.startId) return;   // 利用者が中止した
      this.stop();
      throw e;
    }
    if (id !== this.startId) return;
    this.running = true;
    this.lost = true; this.lastSeen = 0; this.lastRun = 0; this.lastVideoTime = -1;
    this.onStatus('running');
    this._schedule();
  }

  /** 解析を止めてカメラを閉じる */
  stop() {
    this.startId++;
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.values.faceDetected = false;
    this.onStatus('stopped');
  }

  /** いまの顔の向きを「正面」として覚える */
  calibrate() {
    if (!this.values.faceDetected) return false;
    Object.assign(this.zero, this.raw);
    return true;
  }
  resetCalibration() { this.zero.yaw = this.zero.pitch = this.zero.roll = 0; }

  async _load() {
    const src = sources();
    const { FilesetResolver, FaceLandmarker } = await import(src.lib);
    const fileset = await FilesetResolver.forVisionTasks(src.wasm);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: src.model, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
    // まず GPU で試し、使えない端末では CPU に切り替える
    try {
      if (src.delegate === 'CPU') throw new Error('CPU 指定');
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options('GPU'));
      this.delegate = 'GPU';
    } catch (e) {
      console.warn('GPU で開始できなかったため CPU を使います', e);
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options('CPU'));
      this.delegate = 'CPU';
    }
  }

  _schedule() {
    if (!this.running) return;
    // カメラの新しいコマが来たときだけ動く（対応していなければ画面の更新に合わせる）
    if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(this._loop);
    else requestAnimationFrame(this._loop);
  }

  _loop() {
    if (!this.running) return;
    this._schedule();
    const v = this.video;
    if (document.hidden || v.readyState < 2 || v.currentTime === this.lastVideoTime) return;
    const now = performance.now();
    // 負荷対策: 上限fpsを守る。解析が重い端末では自動で間隔を空け、常に余力を残す
    const interval = Math.max(1000 / this.maxFps, this.costMs * 1.5);
    if (now - this.lastRun < interval - 4) return;
    const dt = this.lastRun ? Math.min(0.25, (now - this.lastRun) / 1000) : 1 / 30;
    this.lastRun = now;
    this.lastVideoTime = v.currentTime;

    let result;
    try { result = this.landmarker.detectForVideo(v, now); }
    catch (e) { console.warn(e); return; }
    const cost = performance.now() - now;
    this.costMs = this.costMs ? this.costMs * 0.9 + cost * 0.1 : cost;
    this.count++;

    this._update(result, dt, now);
    this.onValues(this.values);
  }

  /** 解析結果 → 数値 */
  _update(result, dt, now) {
    const out = this.values;
    const matrix = result.facialTransformationMatrixes?.[0]?.data;
    const shapes = result.faceBlendshapes?.[0]?.categories;
    if (!matrix || !shapes) {
      // 一瞬の見失いでは値を保ち、続いたら faceDetected=false にする（値はそのまま。戻し方は受信側が決める）
      if (now - this.lastSeen > LOST_MS) { this.lost = true; out.faceDetected = false; }
      return;
    }
    const wasLost = this.lost;
    this.lost = false; this.lastSeen = now;
    out.faceDetected = true;

    // --- 頭の向き: 顔の向きを表す行列から計算 ---
    // カメラから見た座標は x=映像の右、y=上、z=カメラ側。
    // 顔の「正面方向」f と「頭の上方向」u を取り出す（行列は列優先で並んでいる）
    const fx = matrix[8], fy = matrix[9], fz = matrix[10];
    const ux = matrix[4], uy = matrix[5];
    // 映像の右 = 本人の左なので、符号を反転して「本人から見た向き」にそろえる
    this.raw.yaw = -Math.atan2(fx, fz) * DEG;                      // ＋で本人の右
    this.raw.pitch = -Math.atan2(fy, Math.hypot(fx, fz)) * DEG;    // ＋で下
    this.raw.roll = -Math.atan2(ux, uy) * DEG;                     // ＋で本人の右肩側
    const g = this.headGain;
    const yaw = clamp((this.raw.yaw - this.zero.yaw) * g, -60, 60);
    const pitch = clamp((this.raw.pitch - this.zero.pitch) * g, -45, 45);
    const roll = clamp((this.raw.roll - this.zero.roll) * g, -45, 45);

    // --- 表情: MediaPipe の表情スコア(0〜1)から計算。Left/Right は本人から見た左右 ---
    if (!this.shapeIndex) {
      this.shapeIndex = {};
      shapes.forEach((c, i) => { this.shapeIndex[c.categoryName] = i; });
    }
    const s = (name) => shapes[this.shapeIndex[name]]?.score ?? 0;
    // スコアは「完全に閉じても0.6前後」「力を抜いていても0.1前後」になるので、その幅を0〜1に伸ばす
    let eyeL = 1 - remap(s('eyeBlinkLeft'), 0.15, 0.55);
    let eyeR = 1 - remap(s('eyeBlinkRight'), 0.15, 0.55);
    // 左右の差が小さいときは同じ値にそろえる（片目だけ半開きに見えるのを防ぐ）。ウインクは差が大きいので残る
    if (Math.abs(eyeL - eyeR) < 0.25) eyeL = eyeR = (eyeL + eyeR) / 2;
    const mouth = clamp(remap(s('jawOpen'), 0.04, 0.55) * this.mouthGain, 0, 1);
    const smile = remap((s('mouthSmileLeft') + s('mouthSmileRight')) / 2, 0.1, 0.7);
    const brow = remap(Math.max(s('browInnerUp'), (s('browOuterUpLeft') + s('browOuterUpRight')) / 2), 0.1, 0.7);

    // --- なめらかにする（見失った直後は一気に合わせる）---
    const k = (tau) => (wasLost ? 1 : 1 - Math.exp(-dt / tau));
    const kh = k(TAU.head), km = k(TAU.mouth), ke = k(TAU.eye), kf = k(TAU.face);
    out.headYaw += (yaw - out.headYaw) * kh;
    out.headPitch += (pitch - out.headPitch) * kh;
    out.headRoll += (roll - out.headRoll) * kh;
    out.mouthOpen += (mouth - out.mouthOpen) * km;
    out.leftEyeOpen += (eyeL - out.leftEyeOpen) * ke;
    out.rightEyeOpen += (eyeR - out.rightEyeOpen) * ke;
    out.smile += (smile - out.smile) * kf;
    out.browUp += (brow - out.browUp) * kf;
  }

  dispose() {
    this.stop();
    try { this.landmarker?.close(); } catch { /* noop */ }
    this.landmarker = null;
  }
}
