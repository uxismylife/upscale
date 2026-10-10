// Layered vectorizer: posterize into K colours, stack the colour layers (no gaps), trace each layer
// with VTracer's spline tracer, and soften low-contrast shading layers with an SVG blur filter.
// Pure vector output: <path>, <g> and <filter> only.
//   px: RGBA Uint8Array/Uint8ClampedArray, w × h · toSvg: vtracer-wasm's to_svg
//   o: { colors, speckle, blur (0 = off, else stdDeviation in traced px), outW, outH }
function layeredSvg(px, w, h, o, toSvg, onProgress) {
  const n = w * h, K = Math.max(2, Math.min(64, o.colors | 0));
  const dist2 = (r1, g1, b1, r2, g2, b2) => { const dr = r1 - r2, dg = g1 - g2, db = b1 - b2; return 2 * dr * dr + 4 * dg * dg + 3 * db * db; };
  const opaque = (i) => px[i * 4 + 3] >= 128;

  // 1. Palette: k-means on a sample, seeded by farthest-point picks (deterministic).
  const step = Math.max(1, Math.floor(n / 80000));
  const sample = [];
  for (let i = 0; i < n; i += step) if (opaque(i)) sample.push(i);
  if (!sample.length) return '<svg xmlns="http://www.w3.org/2000/svg" width="' + o.outW + '" height="' + o.outH + '"/>';
  const cr = new Float64Array(K), cg = new Float64Array(K), cb = new Float64Array(K);
  { let sr = 0, sg = 0, sb = 0; for (const i of sample) { sr += px[i * 4]; sg += px[i * 4 + 1]; sb += px[i * 4 + 2]; }
    cr[0] = sr / sample.length; cg[0] = sg / sample.length; cb[0] = sb / sample.length; }
  const best = new Float64Array(sample.length).fill(Infinity);
  for (let k = 1; k < K; k++) {
    let far = 0, farD = -1;
    for (let s = 0; s < sample.length; s++) {
      const i = sample[s] * 4;
      const d = dist2(px[i], px[i + 1], px[i + 2], cr[k - 1], cg[k - 1], cb[k - 1]);
      if (d < best[s]) best[s] = d;
      if (best[s] > farD) { farD = best[s]; far = s; }
    }
    const i = sample[far] * 4; cr[k] = px[i]; cg[k] = px[i + 1]; cb[k] = px[i + 2];
  }
  const nearest = (r, g, b) => { let bk = 0, bd = Infinity; for (let k = 0; k < K; k++) { const d = dist2(r, g, b, cr[k], cg[k], cb[k]); if (d < bd) { bd = d; bk = k; } } return bk; };
  for (let it = 0; it < 12; it++) {
    const sr = new Float64Array(K), sg = new Float64Array(K), sb = new Float64Array(K), c = new Float64Array(K);
    for (const s of sample) { const i = s * 4, k = nearest(px[i], px[i + 1], px[i + 2]); sr[k] += px[i]; sg[k] += px[i + 1]; sb[k] += px[i + 2]; c[k]++; }
    for (let k = 0; k < K; k++) if (c[k]) { cr[k] = sr[k] / c[k]; cg[k] = sg[k] / c[k]; cb[k] = sb[k] / c[k]; }
  }
  if (onProgress) onProgress(0.1);

  // 2. Label every pixel (255 = transparent), then a 3×3 majority pass to remove speckle.
  let lab = new Uint8Array(n);
  for (let i = 0; i < n; i++) lab[i] = opaque(i) ? nearest(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) : 255;
  { const out = new Uint8Array(n), cnt = new Uint16Array(256);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const seen = [];
      for (let dy = -1; dy <= 1; dy++) { const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) { const l = lab[yy * w + Math.min(w - 1, Math.max(0, x + dx))]; if (!cnt[l]++) seen.push(l); } }
      let bl = lab[y * w + x], bc = cnt[bl];
      for (const l of seen) { if (cnt[l] > bc) { bc = cnt[l]; bl = l; } }
      out[y * w + x] = bl;
      for (const l of seen) cnt[l] = 0;
    }
    lab = out; }

  // 3. Stack order: biggest colour area at the bottom. rank[label] = position in the stack.
  const count = new Float64Array(K);
  for (let i = 0; i < n; i++) if (lab[i] !== 255) count[lab[i]]++;
  const order = [...Array(K).keys()].filter((k) => count[k] > 0).sort((a, b) => count[b] - count[a]);
  const rank = new Int16Array(256).fill(-1);
  order.forEach((k, r) => (rank[k] = r));
  const L = order.length;

  // 4. Shading groups: colours that meet each other along gentle, similar-colour borders (all the skin
  //    tones, all the shirt yellows) are joined with union-find.
  const LOW = 30 * 30 * 9; // squared weighted RGB distance counted as a "shading step"
  const adj = new Float64Array(K * K);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x, a = lab[p];
    if (a === 255) continue;
    if (x + 1 < w) { const b = lab[p + 1]; if (b !== a && b !== 255) { adj[a * K + b]++; adj[b * K + a]++; } }
    if (y + 1 < h) { const b = lab[p + w]; if (b !== a && b !== 255) { adj[a * K + b]++; adj[b * K + a]++; } }
  }
  const parent = [...Array(K).keys()];
  const find = (a) => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  const minAdj = Math.max(20, (w + h) / 50);
  // Complete linkage: two groups join only if every colour in one is close to every colour in the other,
  // so gradual chains (skin → brown → beard → hair) never collapse into one group.
  const members = new Map([...Array(K).keys()].map((k) => [k, [k]]));
  const pairs = [];
  for (let a = 0; a < K; a++) for (let b = a + 1; b < K; b++) {
    if (!count[a] || !count[b] || adj[a * K + b] < minAdj) continue;
    const d = dist2(cr[a], cg[a], cb[a], cr[b], cg[b], cb[b]);
    if (d < LOW) pairs.push([d, a, b]);
  }
  pairs.sort((x, y) => x[0] - y[0]);
  for (const [, a, b] of pairs) {
    const ga = find(a), gb = find(b);
    if (ga === gb) continue;
    const A = members.get(ga), B = members.get(gb);
    if (A.every((i) => B.every((j) => dist2(cr[i], cg[i], cb[i], cr[j], cg[j], cb[j]) < LOW))) {
      parent[ga] = gb; members.set(gb, B.concat(A)); members.delete(ga);
    }
  }
  const groups = new Map();
  for (const k of order) { const g = find(k); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(k); }

  // 5. Tracing. Base: every colour stacked (this colour plus every colour above it), sharp, gap-free.
  //    Then each shading group is redrawn on top with blurred transitions, clipped to the group's exact
  //    outline, so shading melts while real edges (eyes, brows, outline, background) stay sharp.
  const hex = (k) => "#" + [cr[k], cg[k], cb[k]].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const mask = new Uint8Array(n * 4);
  const cfg = { binary: true, mode: "spline", hierarchical: "stacked", cornerThreshold: 1.047, lengthThreshold: 4,
    maxIterations: 10, spliceThreshold: 0.785, filterSpeckle: o.speckle, colorPrecision: 2, layerDifference: 16, pathPrecision: 1 };
  const trace = (test) => {
    let inside = 0;
    for (let i = 0; i < n; i++) {
      const on = test(lab[i]);
      const v = on ? 0 : 255;
      mask[i * 4] = mask[i * 4 + 1] = mask[i * 4 + 2] = v; mask[i * 4 + 3] = 255;
      inside += on;
    }
    if (!inside) return [];
    if (inside === n) return ['<path d="M0 0H' + w + "V" + h + 'H0Z"/>'];
    return toSvg(mask, w, h, cfg).match(/<path[^>]*\/>/g) || [];
  };
  const fill = (paths, k) => paths.map((p) => p.replace(/ fill="[^"]*"/, "").replace("<path", '<path fill="' + hex(k) + '"')).join("");
  const softGroups = o.blur > 0 ? [...groups.values()].filter((m) => m.length > 1) : [];
  const total = L + softGroups.reduce((s, m) => s + m.length + 1, 0);
  let done = 0;
  const tick = () => { if (onProgress) onProgress(0.1 + 0.9 * ++done / total); };

  const base = [];
  for (let r = 0; r < L; r++) {
    base.push(fill(trace((l) => l !== 255 && rank[l] >= r), order[r]));
    tick();
  }
  const clips = [], overlays = [];
  softGroups.forEach((members, gi) => {
    const inGroup = new Uint8Array(256);
    for (const m of members) inGroup[m] = 1;
    const clip = trace((l) => inGroup[l] === 1);
    tick();
    clips.push('<clipPath id="g' + gi + '">' + clip.map((p) => p.replace(/ fill="[^"]*"/, "")).join("") + "</clipPath>");
    const body = members.map((m) => { const s = fill(trace((l) => inGroup[l] === 1 && rank[l] >= rank[m]), m); tick(); return s; }).join("");
    overlays.push('<g clip-path="url(#g' + gi + ')"><g filter="url(#soft)">' + body + "</g></g>");
  });

  const defs = softGroups.length
    ? '<defs><filter id="soft" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="' + o.blur + '"/></filter>' + clips.join("") + "</defs>"
    : "";
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + o.outW + '" height="' + o.outH + '" viewBox="0 0 ' + w + " " + h +
    '" preserveAspectRatio="none">' + defs + base.join("") + overlays.join("") + "</svg>";
}
if (typeof module !== "undefined") module.exports = { layeredSvg };
