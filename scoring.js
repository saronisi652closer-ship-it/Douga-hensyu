// scoring.js — 解析データから「盛り上がり度」を計算し、おすすめシーンを選ぶ
// DOM に依存しない純粋な計算だけを置く（将来 AI 判定を足すときもここに重みを追加する）。

export const GRID = 0.5; // 解析の時間刻み（秒）

function percentile(arr, p) {
  const a = Float32Array.from(arr).sort();
  if (!a.length) return 0;
  const i = Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)));
  return a[i];
}

/** 中央値→0、95パーセンタイル→1 になるよう正規化（0〜1.5）。
 *  minRange は「ほとんど変化のない動画」でノイズを拡大しないための下限。 */
function normalize(arr, minRange) {
  const p50 = percentile(arr, 0.5);
  const p95 = percentile(arr, 0.95);
  const range = Math.max(p95 - p50, minRange);
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = Math.min(1.5, Math.max(0, (arr[i] - p50) / range));
  return out;
}

function smooth(arr, radius) {
  const n = arr.length;
  const out = new Float32Array(n);
  let sum = 0, cnt = 0;
  for (let i = 0; i < Math.min(n, radius + 1); i++) { sum += arr[i]; cnt++; }
  for (let i = 0; i < n; i++) {
    out[i] = sum / cnt;
    const add = i + radius + 1, sub = i - radius;
    if (add < n) { sum += arr[add]; cnt++; }
    if (sub >= 0) { sum -= arr[sub]; cnt--; }
  }
  return out;
}

export const REASONS = {
  onset: '音量が急に上がった',
  loud: '大きな音・声が続く',
  change: '画面の動き・変化が大きい',
  cut: 'シーンの切り替わりが多い',
  lum: '明るさ・色が大きく変化',
};

/** 特徴量と、0.5秒ごとの盛り上がりスコアを作る */
export function buildScore(an) {
  const n = an.n;
  const k = Math.max(1, Math.round((an.videoStep || GRID) / GRID));

  // --- 音 ---
  const audioOk = an.hasAudio && percentile(an.level, 0.95) > -60;
  let loud = new Float32Array(n), onset = new Float32Array(n);
  if (audioOk) {
    loud = normalize(an.level, 6);
    const rise = new Float32Array(n);
    const W = 6; // 直前3秒の平均と比べた上昇量(dB)
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const cnt = Math.min(i, W);
      rise[i] = cnt ? Math.max(0, an.level[i] - sum / cnt) : 0;
      sum += an.level[i];
      if (i >= W) sum -= an.level[i - W];
    }
    const p95 = Math.max(percentile(rise, 0.95), 6);
    for (let i = 0; i < n; i++) onset[i] = Math.min(1.5, rise[i] / p95);
  }

  // --- 映像 ---
  const change = normalize(an.diff, 0.02);
  const lumRaw = new Float32Array(n);
  const cut = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = Math.max(0, i - k);
    lumRaw[i] = Math.abs(an.luma[i] - an.luma[j]) + Math.abs(an.sat[i] - an.sat[j]);
    const prev = an.diff[Math.max(0, i - k)];
    const next = an.diff[Math.min(n - 1, i + k)];
    if (an.diff[i] > 0.12 && an.diff[i] > 2.5 * Math.min(prev, next)) cut[i] = 1;
  }
  const lum = normalize(lumRaw, 0.03);

  const weights = audioOk
    ? { loud: 0.28, onset: 0.22, change: 0.32, lum: 0.10, cut: 0.08 }
    : { loud: 0, onset: 0, change: 0.60, lum: 0.20, cut: 0.20 };

  const feats = { loud, onset, change, lum, cut };
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const key in weights) s += weights[key] * feats[key][i];
    raw[i] = s;
  }
  return { score: smooth(raw, 2), feats, weights, audioOk, k };
}

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * おすすめシーンを選ぶ
 * @param an       解析データ
 * @param opts     { count, length: 15|30|60|'auto', excluded:[{in,out}] }
 * @returns {scenes:[{in,out,hype,reasons,peak}], score}
 */
export function pickScenes(an, opts) {
  const built = buildScore(an);
  const { score, feats, weights } = built;
  const n = an.n;
  const duration = an.duration;
  const excluded = opts.excluded || [];
  const picked = []; // {a, b} ビン番号 [a, b)

  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + score[i];
  const meanOf = (a, b) => (prefix[b] - prefix[a]) / Math.max(1, b - a);
  const maxOf = (a, b) => { let m = 0; for (let i = a; i < b; i++) if (score[i] > m) m = score[i]; return m; };
  const windowScore = (a, b) => 0.65 * meanOf(a, b) + 0.35 * maxOf(a, b);
  // 盛り上がりの重心が区間の前寄り〜中央に来る切り方を少しだけ優先（前フリを残す）
  const prefixW = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefixW[i + 1] = prefixW[i] + score[i] * i;
  const framing = (a, b) => {
    const mass = prefix[b] - prefix[a];
    if (mass <= 1e-6 || b - a < 2) return 0;
    const pos = ((prefixW[b] - prefixW[a]) / mass - a) / (b - a - 1);
    return -0.03 * Math.abs(pos - 0.5);
  };

  const blocked = (a, b) => {
    const gap = 2; // 候補どうしは1秒以上あける
    for (const p of picked) if (overlap(a - gap, b + gap, p.a, p.b) > 0) return true;
    for (const e of excluded) {
      const ea = e.in / GRID, eb = e.out / GRID;
      if (overlap(a, b, ea, eb) > 0.25 * Math.min(b - a, eb - ea)) return true;
    }
    return false;
  };

  if (opts.length === 'auto') {
    // ピークから左右に広げて、盛り上がりが続いている範囲を切り出す
    const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => score[y] - score[x]);
    const floor = percentile(score, 0.6);
    const minB = Math.min(n, Math.round(10 / GRID)), maxB = Math.min(n, Math.round(60 / GRID));
    const lead = Math.round(3 / GRID), tail = Math.round(2 / GRID);
    for (const peak of order) {
      if (picked.length >= opts.count) break;
      if (blocked(peak, peak + 1)) continue;
      const thr = Math.max(0.55 * score[peak], floor);
      let a = peak, b = peak + 1;
      while (a > 0 && score[a - 1] > thr && b - a < maxB) a--;
      while (b < n && score[b] > thr && b - a < maxB) b++;
      a = Math.max(0, a - lead); b = Math.min(n, b + tail);
      while (b - a < minB) { // 短すぎるときは前後に広げる
        if (a > 0) a--;
        if (b - a < minB && b < n) b++;
        if (a === 0 && b === n) break;
      }
      if (b - a > maxB) b = a + maxB;
      if (blocked(a, b)) continue;
      picked.push({ a, b, ws: windowScore(a, b) });
    }
  } else {
    const L = Math.min(n, Math.max(1, Math.round(opts.length / GRID)));
    const starts = [];
    for (let a = 0; a + L <= n; a++) starts.push({ a, b: a + L, ws: windowScore(a, a + L), fr: framing(a, a + L) });
    starts.sort((x, y) => (y.ws + y.fr) - (x.ws + x.fr));
    for (const w of starts) {
      if (picked.length >= opts.count) break;
      if (blocked(w.a, w.b)) continue;
      picked.push(w);
    }
  }

  picked.sort((x, y) => y.ws - x.ws);

  // 盛り上がりがほとんど無い区間は候補にしない（最低1件は残す）
  const MIN_WS = 0.1;
  const strong = picked.filter((w, i) => i === 0 || w.ws >= MIN_WS);
  const weak = picked.length - strong.length;

  const scenes = strong.map(({ a, b, ws }) => {
    // 理由: 区間内の各特徴の平均が高いものを寄与の大きい順に
    const stats = [];
    for (const key of ['onset', 'loud', 'change', 'lum']) {
      let s = 0;
      for (let i = a; i < b; i++) s += feats[key][i];
      const mean = s / (b - a);
      stats.push({ key, mean, contrib: mean * weights[key] });
    }
    // onset は瞬間的なので、区間内の最大値でも判定する
    let onsetMax = 0;
    for (let i = a; i < b; i++) if (feats.onset[i] > onsetMax) onsetMax = feats.onset[i];
    let cuts = 0;
    for (let i = a; i < b; i++) if (feats.cut[i] && !(i > a && feats.cut[i - 1])) cuts++;

    stats.sort((x, y) => y.contrib - x.contrib);
    let reasons = stats
      .filter((s) => s.contrib > 0 && (s.mean >= 0.4 || (s.key === 'onset' && onsetMax >= 1)))
      .slice(0, 3).map((s) => s.key);
    if (cuts >= 2 && weights.cut > 0 && reasons.length < 3) reasons.push('cut');
    if (!reasons.length && stats[0]) reasons = [stats[0].key];

    let peak = a;
    for (let i = a; i < b; i++) if (score[i] > score[peak]) peak = i;

    return {
      in: +(a * GRID).toFixed(2),
      out: +Math.min(duration, b * GRID).toFixed(2),
      hype: Math.min(99, Math.round(100 * (1 - Math.exp(-2.2 * ws)))),
      reasons,
      peak: Math.min(duration, (peak + 0.5) * GRID),
    };
  });

  return { scenes, score, weak };
}
