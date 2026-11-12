/*!
 * svg-charts: dependency-free inline-SVG charts.
 * Every builder returns an SVG string. No runtime, no canvas, no DOM required
 * (render server-side or drop the string into innerHTML). Colors come from CSS
 * custom properties so the host page controls the theme, including dark mode.
 *
 * MIT licensed.
 */

// ---------- small helpers ----------
export const fin = v => typeof v === 'number' && Number.isFinite(v);
export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const round2 = v => fin(v) ? +v.toFixed(2) : 0;      // keep SVG coordinates compact
const num = v => fin(v) ? v.toLocaleString('en-US') : 'n/a';

// "Nice" axis ticks: round steps (1/2/5 x 10^n) spanning [lo, hi].
export function niceTicks(lo, hi, n = 5) {
  const span = (hi - lo) || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const r = step0 / mag;
  const step = (r > 5 ? 10 : r > 2 ? 5 : r > 1 ? 2 : 1) * mag;
  const out = [];
  const top = Math.ceil(hi / step - 1e-9) * step;
  for (let v = Math.floor(lo / step + 1e-9) * step; v <= top + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

// SVG wrapper. Every chart is labelled for screen readers (role="img").
export function svg(w, h, body, label) {
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" ` +
    `role="img" aria-label="${esc(label || 'chart')}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

// Theme hooks (override by setting these CSS custom properties on the page):
//   --chart-grid, --chart-axis-text, --chart-ink, --chart-target
const GRID = 'var(--chart-grid,#e4e6e5)';
const AXIS = 'var(--chart-axis-text,#6f7980)';
const INK = 'var(--chart-ink,#141716)';
const TGT = 'var(--chart-target,#c0392b)';
const PALETTE = ['var(--chart-1,#2a78d6)', 'var(--chart-2,#0ca37a)', 'var(--chart-3,#8d5bd6)',
  'var(--chart-4,#d98500)', 'var(--chart-5,#d03b3b)'];
export const palette = i => PALETTE[i % PALETTE.length];

// Axis-style text. `extra` holds attribute overrides (fill, font-size, font-weight);
// each name appears once in the output, with the override winning.
const axisText = (x, y, anchor, t, extra = '') => {
  const attrs = { 'font-size': '12', fill: AXIS };
  for (const m of extra.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
  return `<text x="${round2(x)}" y="${round2(y)}" text-anchor="${anchor}" ` +
    Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ') + `>${esc(t)}</text>`;
};

// Title, unit and source frame. The top band (22px) holds "Title · unit" and the
// bottom band (16px) holds "Source: ...". Builders add the bands to their own
// margins so the plot shrinks and the svg keeps the height the caller passed.
const TOP_BAND = 22, BOTTOM_BAND = 16;
function frame({ title, unit, source, H }) {
  const hasTop = title != null || unit != null;
  let deco = '';
  if (hasTop) {
    const u = unit != null ? `<tspan font-weight="400" fill="${AXIS}">${title != null ? ' · ' : ''}${esc(unit)}</tspan>` : '';
    deco += `<text x="4" y="15" font-size="14" font-weight="700" fill="${INK}">${title != null ? esc(title) : ''}${u}</text>`;
  }
  if (source != null) deco += `<text x="4" y="${H - 4}" font-size="10" fill="${AXIS}">Source: ${esc(source)}</text>`;
  const titleLine = (title != null ? String(title) : '') + (unit != null ? (title != null ? ' · ' : '') + unit : '');
  return { top: hasTop ? TOP_BAND : 0, bottom: source != null ? BOTTOM_BAND : 0, deco,
    titleBox: hasTop ? labelBox(4, 15, titleLine, 'start', 14, 0) : null };
}

// Builders draw their body twice when a band callout needs its own row under the
// title: the second pass shrinks the plot by that row (band.need is set in pass one).
function twoPass(body, band) {
  const g = body(0);
  return band.need ? body(LEGEND_ROW) : g;
}

// Colour of a named item: explicit `color` first, then the `colors` map by name,
// then the fallback (palette or kind colour). One name, one colour across charts.
const pickColor = (explicit, colors, names, fallback) =>
  explicit || names.map(n => n != null && colors ? colors[n] : undefined).find(Boolean) || fallback;

// Legend rows under the title band: per entry a 14x3 swatch (or a hollow/filled
// marker) in the entry colour and its name in 12px axis text, wrapped to the
// chart width. Returns the svg and the height the plot gives up.
const LEGEND_ROW = 16;
function legendRows(entries, W, y0) {
  let x = 4, row = 0, out = '';
  entries.forEach(e => {
    const w = 20 + textW(e.name, 12);
    if (x > 4 && x + w > W - 4) { x = 4; row++; }
    const y = y0 + row * LEGEND_ROW;
    out += e.marker === 'hollow' ? `<circle cx="${x + 7}" cy="${y + 8}" r="4" fill="var(--chart-paper,#fff)" stroke="${e.color}" stroke-width="2"/>`
      : e.marker === 'filled' ? `<circle cx="${x + 7}" cy="${y + 8}" r="4" fill="${e.color}"/>`
      : `<rect x="${x}" y="${y + 6.5}" width="14" height="3" rx="1.5" fill="${e.color}"/>`;
    out += `<text x="${x + 20}" y="${y + 12}" font-size="12" fill="${AXIS}">${esc(e.name)}</text>`;
    x += w + 16;
  });
  return { svg: out, height: entries.length ? (row + 1) * LEGEND_ROW + 2 : 0 };
}
// Legend entries for bar-type data that names a `series` per item; empty otherwise.
function seriesLegend(items, colors) {
  const names = [...new Set(items.map(d => d.series).filter(n => n != null))];
  return names.map((n, i) => ({ name: n, color: pickColor(null, colors, [n], palette(i)) }));
}

// Text width estimate (a string builder has no font metrics): 0.6em per character.
const textW = (s, fs) => String(s).length * fs * 0.6;
// Box of a text label with its baseline at (x, y). `m` is the clearance a callout
// keeps from it: 14px for the target label, 2px for value labels.
function labelBox(x, y, text, anchor = 'end', fs = 12, m = 14) {
  const w = textW(text, fs), x0 = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x;
  return { x0, x1: x0 + w, y0: y - fs, y1: y + 3, m };
}
// A drawn line segment a callout must not cross; sampled at 8 x positions.
const segment = (x1, y1, x2, y2, m = 2) => ({ seg: true, x1, y1, x2, y2, m });
// True when box a comes within b.m of box or segment b.
function nearBox(a, b) {
  if (!b.seg) return a.x0 < b.x1 + b.m && a.x1 > b.x0 - b.m && a.y0 < b.y1 + b.m && a.y1 > b.y0 - b.m;
  const lo = Math.max(a.x0 - b.m, Math.min(b.x1, b.x2)), hi = Math.min(a.x1 + b.m, Math.max(b.x1, b.x2));
  if (lo > hi) return false;
  for (let i = 0; i < 8; i++) {
    const x = lo + (hi - lo) * i / 7, y = b.y1 + (b.y2 - b.y1) * (x - b.x1) / ((b.x2 - b.x1) || 1);
    if (y > a.y0 - b.m && y < a.y1 + b.m) return true;
  }
  return false;
}

// One callout: a ring on the point, a leader, and the text. The text sits up and
// to the right, or up and to the left (right-aligned to the point) when the point
// is in the right 35% of the plot or the text would cross the plot's right edge.
// It never overlaps an entry of geo.avoid (target and value labels, data lines):
// it moves up in 16px steps, then tries below the point, and when nothing inside
// the plot is clear it goes to the band above the plot (right-aligned, on the
// title row) with a thin leader down to the point.
// In the band the text never overprints the title line: when it would, the
// callout takes a second band row under the title (band.need asks the builder for
// the row; extraTop > 0 means the row exists). `ringOnly` draws the ring alone,
// for an annotation whose text repeats the value label already on the point.
// When the point carries its own value label (`own`), the leader is an elbow that
// runs sideways past that label and then up, so it never crosses the number.
function callout(px, py, text, geo, own, ringOnly = false) {
  const { W, L, R, top = 0, plotTop = top, bottom = Infinity, avoid = [], title = null, extraTop = 0, band = {} } = geo;
  const ring = `<circle cx="${round2(px)}" cy="${round2(py)}" r="5" fill="none" stroke="${INK}" stroke-width="1.5"/>`;
  if (ringOnly) return ring;
  const tw = textW(text, 12);
  const reach = d => own ? (d > 0 ? Math.max(px + 17, own.x1 + 3) : Math.min(px - 17, own.x0 - 3)) : px + d * 17;
  let d = px > L + 0.65 * (W - L - R) ? -1 : 1;
  if (d > 0 && reach(1) + 3 + tw > W - R) d = -1;
  const ex = reach(d);
  let tx = ex + d * 3, x0 = d > 0 ? tx : tx - tw;
  const clear = base => !avoid.some(b => nearBox({ x0, x1: x0 + tw, y0: base - 12, y1: base + 3 }, b));
  let base = py - 13, below = false, inBand = false;
  while (!clear(base) && base - 28 >= plotTop) base -= 16;
  if (!clear(base)) {
    let b2 = py + 22;
    while (!clear(b2) && b2 + 19 <= bottom) b2 += 16;
    if (clear(b2)) { base = b2; below = true; }
    else {
      inBand = true; d = -1; tx = W - 4; x0 = tx - tw; base = top > 0 ? 15 : plotTop - 2;
      if (title && x0 < title.x1 + 8) { if (extraTop > 0) base = 15 + LEGEND_ROW; else band.need = true; }
    }
  }
  const y1 = below ? py + 4 : py - 4, y2 = below ? base - 13 : base - 4;
  let leader;
  if (inBand) {
    const kx = px < x0 ? x0 - 3 : px > tx ? tx + 3 : px, ky = base + 5;
    leader = `<polyline fill="none" stroke="${INK}" stroke-width="1" points="${round2(px)},${round2(py - 5)} ${round2(px)},${round2(ky)}` +
      (kx !== px ? ` ${round2(kx)},${round2(ky)}` : '') + `"/>`;
  } else if (own) {
    leader = `<polyline fill="none" stroke="${INK}" stroke-width="1.2" points="${round2(px + d * 5)},${round2(py)} ${round2(ex)},${round2(py)} ${round2(ex)},${round2(y2)}"/>`;
  } else {
    leader = `<line x1="${round2(px + d * 4)}" y1="${round2(y1)}" x2="${round2(ex)}" y2="${round2(y2)}" stroke="${INK}" stroke-width="1.2"/>`;
  }
  return ring + leader +
    `<text x="${round2(tx)}" y="${round2(base)}" text-anchor="${d < 0 ? 'end' : 'start'}" font-size="12" font-weight="700" fill="${INK}">${esc(text)}</text>`;
}

// Resolve each annotation to a point through `locate(a)`, which returns
// [x, y, ownLabelBox?, valueText?] or throws. A bad index is an error, not a
// missing callout. An annotation whose text equals the value label already drawn
// on that point keeps only the ring. geo describes the plot for callout placement.
function annotate(annotations, geo, locate) {
  return annotations.map((a, i) => {
    const pt = locate(a);
    if (!pt || !fin(pt[0]) || !fin(pt[1])) throw new RangeError(`annotation ${i} does not resolve to a point`);
    return callout(pt[0], pt[1], a.text, geo, pt[2], pt[3] != null && String(a.text) === String(pt[3]));
  }).join('');
}

const pick = (arr, i, what) => {
  if (!Number.isInteger(i) || i < 0 || i >= arr.length) throw new RangeError(`annotation ${what} ${i} is out of range`);
  return arr[i];
};

function gridY(ticks, L, R, W, Y, fmt) {
  return ticks.map(t =>
    `<line x1="${L}" x2="${W - R}" y1="${round2(Y(t))}" y2="${round2(Y(t))}" stroke="${GRID}" stroke-width="1"/>` +
    axisText(L - 6, Y(t) + 4, 'end', fmt(t))).join('');
}

// ---------- line chart (multi-series) ----------
// series: [{ name, color?, dash?, points:[{x,y}] }]; labels: the ordered x categories.
export function lineChart({ series = [], labels = [], label, width = 600, height = 280,
  target = null, fmtY = num, title, unit, source, annotations = [], legend = false, colors, valueLabels = false, area = false } = {}) {
  const f = frame({ title, unit, source, H: height }), lab = label ?? title ?? 'line chart';
  const colorOf = (s, si) => pickColor(s.color, colors, [s.name], palette(si));
  const entries = legend ? series.map((s, si) => ({ name: s.name, color: colorOf(s, si) })) : [], band = {}, W = width;
  const body = extraTop => {
    const lg = legendRows(entries, W, f.top + extraTop);
    const L = 54, R = 16, Tp = 14 + f.top + extraTop + lg.height, B = 34, H = height - f.bottom;
    const ys = series.flatMap(s => s.points.map(p => p.y)).filter(fin);
    if (!ys.length) return lg.svg + axisText(W / 2, H / 2, 'middle', 'no data');
    let ymax = Math.max(...ys) * 1.1;
    const tIn = target != null && fin(target) && target <= ymax * 2;
    if (tIn) ymax = Math.max(ymax, target * 1.1);
    const ticks = niceTicks(0, ymax); ymax = ticks[ticks.length - 1] || 1;
    const X = i => L + (labels.length < 2 ? 0 : i * (W - L - R) / (labels.length - 1));
    const Y = v => Tp + (1 - v / ymax) * (H - Tp - B);
    let g = gridY(ticks, L, R, W, Y, fmtY);
    const every = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor((W - L - R) / 72))));
    g += labels.map((x, i) => (i % every === 0 || i === labels.length - 1)
      ? axisText(X(i), H - 12, i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle', x) : '').join('');
    const avoid = [], placed = [], placedText = new Map();
    series.forEach((s, si) => {
      const col = colorOf(s, si);
      const pts = s.points.map(p => [labels.indexOf(p.x), p.y]).filter(p => p[0] >= 0 && fin(p[1]));
      if (area && pts.length > 1) g += `<polygon fill="${col}" fill-opacity=".14" points="${round2(X(pts[0][0]))},${round2(Y(0))} ` +
        `${pts.map(p => round2(X(p[0])) + ',' + round2(Y(p[1]))).join(' ')} ${round2(X(pts[pts.length - 1][0]))},${round2(Y(0))}"/>`;
      g += `<polyline fill="none" stroke="${col}" stroke-width="2.4" stroke-dasharray="${s.dash || ''}" ` +
        `points="${pts.map(p => round2(X(p[0])) + ',' + round2(Y(p[1]))).join(' ')}"/>`;
      g += pts.map(p => `<circle cx="${round2(X(p[0]))}" cy="${round2(Y(p[1]))}" r="3" fill="${col}">` +
        `<title>${esc(s.name)} ${esc(labels[p[0]])}: ${esc(fmtY(p[1]))}</title></circle>`).join('');
      for (let i = 1; i < pts.length; i++) avoid.push(segment(X(pts[i - 1][0]), Y(pts[i - 1][1]), X(pts[i][0]), Y(pts[i][1])));
      if (valueLabels) pts.forEach(p => {        // one 11px label above each point; a label that would overlap an earlier one is skipped
        const t = fmtY(p[1]), anchor = p[0] === 0 ? 'start' : p[0] === labels.length - 1 ? 'end' : 'middle';
        const box = labelBox(X(p[0]), Y(p[1]) - 7, t, anchor, 11, 2);
        if (placed.some(b => nearBox(box, b))) return;
        placed.push(box); avoid.push(box); placedText.set(si + ':' + p[0], t);
        g += axisText(X(p[0]), Y(p[1]) - 7, anchor, t, `fill="${INK}" font-weight="700" font-size="11"`);
      });
    });
    if (target != null && fin(target)) {
      const tl = 'target ' + fmtY(target);
      if (tIn) {
        g += `<line x1="${L}" x2="${W - R}" y1="${round2(Y(target))}" y2="${round2(Y(target))}" ` +
          `stroke="${TGT}" stroke-width="1.5" stroke-dasharray="5 4"/>` + axisText(W - R, Y(target) - 5, 'end', tl, `fill="${TGT}"`);
        avoid.push(labelBox(W - R, Y(target) - 5, tl));
      } else {
        g += axisText(W - R, Tp + 4, 'end', tl + ' is above the chart', `fill="${TGT}"`);
        avoid.push(labelBox(W - R, Tp + 4, tl + ' is above the chart'));
      }
    }
    g += annotate(annotations, { W, L, R, top: f.top, extraTop, title: f.titleBox, band, plotTop: Tp, bottom: H - B, avoid }, a => {
      const s = pick(series, a.series ?? 0, 'series'), x = pick(labels, a.index, 'index');
      const p = s.points.find(p => p.x === x);
      return p && [X(a.index), Y(p.y), undefined, placedText.get((a.series ?? 0) + ':' + a.index)];
    });
    return lg.svg + g;
  };
  return svg(W, height, f.deco + twoPass(body, band), lab);
}

// ---------- vertical bar chart ----------
// data: [{ label, value, color? }]
// Items may name a `series`; items of one series share a colour and `legend: true` lists the series.
export function barChart({ data = [], label, width = 600, height = 260,
  target = null, fmtY = num, title, unit, source, annotations = [], legend = false, colors } = {}) {
  const f = frame({ title, unit, source, H: height }), lab = label ?? title ?? 'bar chart';
  const groups = seriesLegend(data, colors), entries = legend ? groups : [], band = {}, W = width;
  const colorOf = (d, i) => pickColor(d.color, colors, [d.label, d.series],
    d.series != null ? groups.find(e => e.name === d.series).color : palette(i));
  const body = extraTop => {
    const lg = legendRows(entries, W, f.top + extraTop);
    const L = 54, R = 14, Tp = 16 + f.top + extraTop + lg.height, B = 34, H = height - f.bottom;
    const vals = data.map(d => d.value).filter(fin);
    if (!vals.length) return lg.svg + axisText(W / 2, H / 2, 'middle', 'no data');
    let ymax = Math.max(...vals, target != null && fin(target) ? target : 0) * 1.12;
    const ticks = niceTicks(0, ymax); ymax = ticks[ticks.length - 1] || 1;
    const Y = v => Tp + (1 - v / ymax) * (H - Tp - B);
    const bw = (W - L - R) / data.length, avoid = [];
    let g = gridY(ticks, L, R, W, Y, fmtY);
    data.forEach((d, i) => {
      const x = L + i * bw + bw * 0.16, w = bw * 0.68, y = Y(Math.max(0, d.value)), h = Math.max(1, Math.abs(Y(d.value) - Y(0)));
      const col = colorOf(d, i);
      g += `<rect x="${round2(x)}" y="${round2(y)}" width="${round2(w)}" height="${round2(h)}" rx="3" fill="${col}">` +
        `<title>${esc(d.label)}: ${esc(fmtY(d.value))}</title></rect>`;
      g += axisText(x + w / 2, y - 5, 'middle', fmtY(d.value), `fill="${INK}" font-weight="600"`);
      avoid.push(labelBox(x + w / 2, y - 5, fmtY(d.value), 'middle', 12, 2));
      g += axisText(x + w / 2, H - 12, 'middle', d.label);
    });
    if (target != null && fin(target)) {
      const tl = 'target ' + fmtY(target);
      g += `<line x1="${L}" x2="${W - R}" y1="${round2(Y(target))}" y2="${round2(Y(target))}" ` +
        `stroke="${TGT}" stroke-width="1.5" stroke-dasharray="5 4"/>` + axisText(W - R, Y(target) - 5, 'end', tl, `fill="${TGT}"`);
      avoid.push(labelBox(W - R, Y(target) - 5, tl));
    }
    g += annotate(annotations, { W, L, R, top: f.top, extraTop, title: f.titleBox, band, plotTop: Tp, bottom: H - B, avoid }, a => {
      const d = pick(data, a.index, 'index');
      return [L + a.index * bw + bw * 0.5, Y(Math.max(0, d.value)), avoid[a.index], fmtY(d.value)];
    });
    return lg.svg + g;
  };
  return svg(W, height, f.deco + twoPass(body, band), lab);
}

// ---------- waterfall / bridge ----------
// items: [{ label, value, total? }]  total bars are drawn from zero; others step the running sum.
// `zoom: true` starts the axis below the lowest level instead of at zero, so that small steps between
// large totals stay visible; the total bars then rise from that axis start, which the lowest tick names.
export function waterfall({ items = [], label, width = 600, height = 290, fmtY = num,
  title, unit, source, annotations = [], legend = false, colors, zoom = false } = {}) {
  const f = frame({ title, unit, source, H: height }), lab = label ?? title ?? 'waterfall';
  const groups = seriesLegend(items, colors), entries = legend ? groups : [], band = {}, W = width;
  const body = extraTop => {
    const lg = legendRows(entries, W, f.top + extraTop);
    const L = 54, R = 10, Tp = 18 + f.top + extraTop + lg.height, B = 46, H = height - f.bottom;
    const bars = []; let run = 0;
    for (const it of items) {
      if (it.total) { bars.push({ name: it.label, from: 0, to: it.value, kind: 'total', delta: it.value, it }); run = it.value; }
      else { bars.push({ name: it.label, from: run, to: run + it.value, kind: it.value < 0 ? 'down' : 'up', delta: it.value, it }); run += it.value; }
    }
    if (!bars.length) return lg.svg + axisText(W / 2, H / 2, 'middle', 'no data');
    const hiLevel = Math.max(...bars.map(b => Math.max(b.from, b.to)));
    const loLevel = Math.min(...bars.map(b => b.kind === 'total' ? b.to : Math.min(b.from, b.to)));
    let ymax = hiLevel * 1.12, ymin = 0;
    if (zoom && loLevel > 0 && hiLevel > loLevel) { ymin = Math.max(0, loLevel - (hiLevel - loLevel) * 0.6); ymax = hiLevel + (hiLevel - loLevel) * 0.25; }
    const ticks = niceTicks(ymin, ymax); ymax = ticks[ticks.length - 1] || 1; ymin = zoom ? ticks[0] : 0;
    const bw = (W - L - R) / bars.length, Y = v => Tp + (1 - (v - ymin) / (ymax - ymin)) * (H - Tp - B), avoid = [], valText = [];
    bars.forEach(b => { if (b.kind === 'total') b.from = ymin; });
    let g = gridY(ticks, L, R, W, Y, fmtY);
    bars.forEach((b, i) => {
      const x = L + i * bw + bw * 0.16, w = bw * 0.68, top = Y(Math.max(b.from, b.to)), h = Math.max(1, Math.abs(Y(b.from) - Y(b.to)));
      const kindCol = b.kind === 'total' ? 'var(--chart-total,#8d979d)' : b.kind === 'down' ? 'var(--chart-down,#0ca37a)' : 'var(--chart-up,#d03b3b)';
      const col = pickColor(b.it.color, colors, [b.name, b.it.series], b.it.series != null ? groups.find(e => e.name === b.it.series).color : kindCol);
      const val = b.kind === 'total' ? fmtY(b.to) : (b.delta < 0 ? '−' : '+') + fmtY(Math.abs(b.delta));
      const fs = bw < 90 ? 11 : 13;
      g += `<rect x="${round2(x)}" y="${round2(top)}" width="${round2(w)}" height="${round2(h)}" rx="3" fill="${col}">` +
        `<title>${esc(b.name)}: ${esc(val)}</title></rect>`;
      g += axisText(x + w / 2, top - 5, 'middle', val, `fill="${INK}" font-weight="600" font-size="${fs}"`);
      avoid.push(labelBox(x + w / 2, top - 5, val, 'middle', fs, 2)); valText.push(val);
      const words = String(b.name).split(' ');
      g += axisText(x + w / 2, H - 28, 'middle', words[0], `font-size="${fs}"`);
      if (words.length > 1) g += axisText(x + w / 2, H - 13, 'middle', words.slice(1).join(' '), `font-size="${fs}"`);
    });
    g += annotate(annotations, { W, L, R, top: f.top, extraTop, title: f.titleBox, band, plotTop: Tp, bottom: H - B, avoid }, a => {
      const b = pick(bars, a.index, 'index');
      return [L + a.index * bw + bw * 0.5, Y(Math.max(b.from, b.to)), avoid[a.index], valText[a.index]];
    });
    return lg.svg + g;
  };
  return svg(W, height, f.deco + twoPass(body, band), lab);
}

// ---------- scatter (optional fitted line per group) ----------
// groups: [{ name, color?, points:[{x,y, tip?}], line?:{from,to,fn} }]
export function scatter({ groups = [], label, width = 600, height = 330,
  xLabel = '', yLabel = '', fmtX = num, fmtY = num, title, unit, source, annotations = [], legend = false, colors } = {}) {
  const f = frame({ title, unit, source, H: height }), lab = label ?? title ?? 'scatter';
  const colorOf = (gr, gi) => pickColor(gr.color, colors, [gr.name], palette(gi));
  const entries = legend ? groups.map((gr, gi) => ({ name: gr.name, color: colorOf(gr, gi) })) : [], band = {}, W = width;
  const body = extraTop => {
    const lg = legendRows(entries, W, f.top + extraTop);
    const L = 54, R = 16, Tp = 22 + f.top + extraTop + lg.height, B = 38, H = height - f.bottom;
    const pts = groups.flatMap(g => g.points || []);
    if (!pts.length) return lg.svg + axisText(W / 2, H / 2, 'middle', 'no data');
    const xt = niceTicks(0, Math.max(...pts.map(p => p.x)) * 1.05), XM = xt[xt.length - 1] || 1;
    const yt = niceTicks(0, Math.max(...pts.map(p => p.y)) * 1.08), YM = yt[yt.length - 1] || 1;
    const X = v => L + v / XM * (W - L - R), Y = v => Tp + (1 - v / YM) * (H - Tp - B);
    let g = gridY(yt, L, R, W, Y, fmtY);
    g += xt.map((t, i) => axisText(X(t), H - 16, i === xt.length - 1 ? 'end' : 'middle', fmtX(t))).join('');
    if (xLabel) g += axisText(W - R, H - 2, 'end', xLabel);
    if (yLabel) g += axisText(L + 4, Tp + 10, 'start', yLabel, `font-weight="600"`);
    groups.forEach((gr, gi) => {
      const col = colorOf(gr, gi);
      if (gr.line && typeof gr.line.fn === 'function') {
        const n = 30, p = [];
        for (let i = 0; i <= n; i++) { const x = gr.line.from + (gr.line.to - gr.line.from) * i / n; p.push(round2(X(x)) + ',' + round2(Y(gr.line.fn(x)))); }
        g += `<polyline fill="none" stroke="${col}" stroke-width="1.8" stroke-dasharray="6 4" points="${p.join(' ')}"/>`;
      }
      g += (gr.points || []).map(p => `<circle cx="${round2(X(p.x))}" cy="${round2(Y(p.y))}" r="4.2" fill="${col}" fill-opacity=".85">` +
        `<title>${esc(p.tip || (gr.name + ': ' + fmtX(p.x) + ', ' + fmtY(p.y)))}</title></circle>`).join('');
    });
    g += annotate(annotations, { W, L, R, top: f.top, extraTop, title: f.titleBox, band, plotTop: Tp, bottom: H - B }, a => fin(a.x) && fin(a.y) ? [X(a.x), Y(a.y)] : null);
    return lg.svg + g;
  };
  return svg(W, height, f.deco + twoPass(body, band), lab);
}

// ---------- diverging bars (change, positive and negative from zero) ----------
// data: [{ label, value, color? }]
export function divergingBars({ data = [], label, width = 600, height = 280, fmtY = num,
  title, unit, source, annotations = [], legend = false, colors } = {}) {
  const f = frame({ title, unit, source, H: height }), lab = label ?? title ?? 'change';
  const groups = seriesLegend(data, colors), entries = legend ? groups : [], band = {}, W = width;
  const body = extraTop => {
    const lg = legendRows(entries, W, f.top + extraTop);
    const L = 54, R = 14, Tp = 16 + f.top + extraTop + lg.height, B = 20, H = height - f.bottom;
    const vals = data.map(d => d.value).filter(fin);
    if (!vals.length) return lg.svg + axisText(W / 2, H / 2, 'middle', 'no data');
    const lo = Math.min(0, ...vals) * 1.12, hi = Math.max(0, ...vals) * 1.12;
    const ticks = niceTicks(lo, hi); const tmin = ticks[0], tmax = ticks[ticks.length - 1] || 1;
    const Y = v => Tp + (1 - (v - tmin) / (tmax - tmin)) * (H - Tp - B);
    let g = ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${round2(Y(t))}" y2="${round2(Y(t))}" ` +
      `stroke="${t === 0 ? INK : GRID}" stroke-width="${t === 0 ? 1.4 : 1}"/>` + axisText(L - 6, Y(t) + 4, 'end', fmtY(t))).join('');
    const bw = (W - L - R) / data.length, zero = Y(0), avoid = [], valText = [];
    data.forEach((d, i) => {
      const x = L + i * bw + bw * 0.16, w = bw * 0.68, yv = Y(d.value);
      const top = Math.min(zero, yv), h = Math.max(1, Math.abs(yv - zero));
      const signCol = d.value < 0 ? 'var(--chart-down,#0ca37a)' : 'var(--chart-up,#2a78d6)';
      const col = pickColor(d.color, colors, [d.label, d.series], d.series != null ? groups.find(e => e.name === d.series).color : signCol);
      const val = (d.value < 0 ? '−' : '+') + fmtY(Math.abs(d.value)), vy = d.value >= 0 ? top - 5 : top + h + 13;
      g += `<rect x="${round2(x)}" y="${round2(top)}" width="${round2(w)}" height="${round2(h)}" rx="3" fill="${col}">` +
        `<title>${esc(d.label)}: ${esc(val)}</title></rect>`;
      g += axisText(x + w / 2, vy, 'middle', val, `fill="${INK}" font-weight="600" font-size="11"`);
      avoid.push(labelBox(x + w / 2, vy, val, 'middle', 11, 2)); valText.push(val);
      g += axisText(x + w / 2, H - 4, 'middle', d.label, `font-size="11"`);
    });
    g += annotate(annotations, { W, L, R, top: f.top, extraTop, title: f.titleBox, band, plotTop: Tp, bottom: H - B, avoid }, a => {
      const d = pick(data, a.index, 'index');
      return [L + a.index * bw + bw * 0.5, Y(d.value), avoid[a.index], valText[a.index]];
    });
    return lg.svg + g;
  };
  return svg(W, height, f.deco + twoPass(body, band), lab);
}

// ---------- dumbbell (two points per row, e.g. before vs after) ----------
// rows: [{ label, a, b, color? }]
// Height follows the row count, so here the bands add to the height instead of shrinking the plot.
// Its legend names the two ends: a hollow marker for `aLabel`, a filled one for `bLabel`.
export function dumbbell({ rows = [], label, width = 600, aLabel = 'A', bLabel = 'B', fmtY = num,
  title, unit, source, annotations = [], legend = false, colors } = {}) {
  const plotH = Math.max(120, 16 + 28 + rows.length * 38), bandTop = title != null || unit != null ? TOP_BAND : 0;
  const entries = legend ? [{ name: aLabel, color: INK, marker: 'hollow' }, { name: bLabel, color: INK, marker: 'filled' }] : [];
  const lab = label ?? title ?? 'dumbbell', W = width, band = {};
  const vals = rows.flatMap(r => [r.a, r.b]).filter(fin);
  // The body returns the whole svg: the height depends on the band row too.
  const body = extraTop => {
    const lg = legendRows(entries, W, bandTop + extraTop);
    const f = frame({ title, unit, source, H: plotH + bandTop + extraTop + lg.height + (source != null ? BOTTOM_BAND : 0) });
    const deco = f.deco + lg.svg;
    const L = 150, R = 20, Tp = 16 + f.top + extraTop + lg.height, B = 28, H = plotH + f.top + extraTop + lg.height, height = H + f.bottom;
    if (!vals.length) return svg(W, height, deco + axisText(W / 2, H / 2, 'middle', 'no data'), lab);
    const ticks = niceTicks(Math.min(0, ...vals), Math.max(...vals) * 1.05), xmax = ticks[ticks.length - 1] || 1, xmin = ticks[0];
    const X = v => L + (v - xmin) / (xmax - xmin) * (W - L - R);
    const rowH = (H - Tp - B) / rows.length;
    let g = ticks.map(t => `<line x1="${round2(X(t))}" x2="${round2(X(t))}" y1="${Tp}" y2="${H - B}" stroke="${GRID}"/>` +
      axisText(X(t), H - B + 16, 'middle', fmtY(t))).join('');
    rows.forEach((r, i) => {
      const y = Tp + (i + 0.5) * rowH, col = pickColor(r.color, colors, [r.label], palette(i));
      g += axisText(L - 10, y + 4, 'end', r.label, `fill="${INK}"`);
      g += `<line x1="${round2(X(r.a))}" x2="${round2(X(r.b))}" y1="${round2(y)}" y2="${round2(y)}" stroke="${col}" stroke-width="2"/>`;
      g += `<circle cx="${round2(X(r.a))}" cy="${round2(y)}" r="5" fill="var(--chart-paper,#fff)" stroke="${col}" stroke-width="2"><title>${esc(r.label)} ${esc(aLabel)}: ${esc(fmtY(r.a))}</title></circle>`;
      g += `<circle cx="${round2(X(r.b))}" cy="${round2(y)}" r="5" fill="${col}"><title>${esc(r.label)} ${esc(bLabel)}: ${esc(fmtY(r.b))}</title></circle>`;
    });
    g += annotate(annotations, { W, L, R, top: f.top, extraTop, title: f.titleBox, band, plotTop: Tp, bottom: H - B }, a => {
      const r = pick(rows, a.index, 'index'), s = pick([r.a, r.b], a.series ?? 0, 'series');
      return [X(s), Tp + (a.index + 0.5) * rowH];
    });
    return svg(W, height, deco + g, lab);
  };
  return twoPass(body, band);
}

// ---------- stacked bars (shares that sum per column) ----------
// columns: [{ label, parts: { key: value, ... } }]; keys give the stack order.
// colors: an array by key position, or an object by key name.
export function stackedBars({ columns = [], keys = [], colors = [], label, width = 600, height = 280, fmtY = v => Math.round(v * 100) + '%',
  title, unit, source, annotations = [], legend = false } = {}) {
  const f = frame({ title, unit, source, H: height }), lab = label ?? title ?? 'stacked';
  const colorOf = (k, ki) => (Array.isArray(colors) ? colors[ki] : colors[k]) || palette(ki);
  const entries = legend ? keys.map((k, ki) => ({ name: k, color: colorOf(k, ki) })) : [], band = {}, W = width;
  const body = extraTop => {
    const lg = legendRows(entries, W, f.top + extraTop);
    const L = 44, R = 14, Tp = 14 + f.top + extraTop + lg.height, B = 30, H = height - f.bottom;
    if (!columns.length || !keys.length) return lg.svg + axisText(W / 2, H / 2, 'middle', 'no data');
    const totals = columns.map(c => keys.reduce((a, k) => a + (c.parts[k] || 0), 0));
    const norm = columns.map((c, i) => totals[i] > 0 ? totals[i] : 1);
    const Y = v => Tp + (1 - v) * (H - Tp - B);               // v is a 0..1 share
    let g = [0, 0.25, 0.5, 0.75, 1].map(t => `<line x1="${L}" x2="${W - R}" y1="${round2(Y(t))}" y2="${round2(Y(t))}" stroke="${GRID}"/>` +
      axisText(L - 6, Y(t) + 4, 'end', fmtY(t))).join('');
    const bw = (W - L - R) / columns.length, tops = columns.map(() => []);   // segment top per column and key
    columns.forEach((c, i) => {
      const x = L + i * bw + bw * 0.16, w = bw * 0.68; let acc = 0;
      keys.forEach((k, ki) => {
        const share = (c.parts[k] || 0) / norm[i]; if (share <= 0) { tops[i][ki] = Y(acc); return; }
        const y0 = Y(acc + share), h = Math.abs(Y(acc) - Y(acc + share)); acc += share; tops[i][ki] = y0;
        g += `<rect x="${round2(x)}" y="${round2(y0)}" width="${round2(w)}" height="${round2(h)}" fill="${colorOf(k, ki)}">` +
          `<title>${esc(c.label)} ${esc(k)}: ${esc(fmtY(share))}</title></rect>`;
      });
      g += axisText(x + w / 2, H - 10, 'middle', c.label);
    });
    g += annotate(annotations, { W, L, R, top: f.top, extraTop, title: f.titleBox, band, plotTop: Tp, bottom: H - B }, a => {
      pick(columns, a.index, 'index'); pick(keys, a.series ?? 0, 'series');
      return [L + a.index * bw + bw * 0.5, tops[a.index][a.series ?? 0]];
    });
    return lg.svg + g;
  };
  return svg(W, height, f.deco + twoPass(body, band), lab);
}

const MUTED = 'var(--chart-muted,#b8c0c4)';
const PAPER = 'var(--chart-paper,#fff)';
// Shorten a label to the width it has (0.6em per character), with an ellipsis.
const fit = (s, px, fs = 12) => {
  const t = String(s), n = Math.max(1, Math.floor(px / (fs * 0.6)));
  return t.length > n ? t.slice(0, Math.max(1, n - 1)) + '…' : t;
};

// ---------- horizontal bar chart (ranked categories, long labels, narrow pages) ----------
// data: [{ label, value, color?, series? }]. Height follows the row count. All bars share one colour unless
// items name a `series` or a `color`; `highlight: [index, ...]` keeps those bars in colour and mutes the others.
// Values must be zero or more, unless `diverging: true`: then bars grow left and right from a zero line
// (signed change per category), coloured by sign (--chart-up, --chart-down) with signed value labels.
export function hbarChart({ data = [], label, width = 600, rowHeight = 28, fmtY = num,
  title, unit, source, legend = false, colors, highlight = null, diverging = false } = {}) {
  const lab = label ?? title ?? 'bar chart', W = width;
  const groups = seriesLegend(data, colors), entries = legend ? groups : [];
  const bandTop = title != null || unit != null ? TOP_BAND : 0;
  const lg = legendRows(entries, W, bandTop);
  const Tp = bandTop + lg.height + 6, plotH = Math.max(1, data.length) * rowHeight;
  const height = Tp + plotH + 6 + (source != null ? BOTTOM_BAND : 0);
  const f = frame({ title, unit, source, H: height });
  const vals = data.map(d => d.value);
  if (!vals.length) return svg(W, height + 24, f.deco + lg.svg + axisText(W / 2, Tp + 18, 'middle', 'no data'), lab);
  vals.forEach((v, i) => {
    if (!fin(v) || (!diverging && v < 0)) throw new RangeError(`hbarChart value ${i} must be a number${diverging ? '' : ' of zero or more (pass diverging: true for signed values)'}`);
  });
  if (highlight) highlight.forEach(i => pick(data, i, 'highlight'));
  const L = Math.min(Math.ceil(Math.max(...data.map(d => textW(d.label, 12)))) + 12, Math.round(W * 0.42));
  const text = d => diverging ? (d.value < 0 ? '−' : '+') + fmtY(Math.abs(d.value)) : fmtY(d.value);
  const side = keep => Math.max(0, ...data.filter(keep).map(d => textW(text(d), 12))) + 10;
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), span = (hi - lo) || 1;
  const x0 = L + (lo < 0 ? side(d => d.value < 0) : 0), x1 = W - side(d => d.value >= 0);
  const X = v => x0 + (v - lo) / span * (x1 - x0), zero = X(0);
  let g = diverging ? `<line x1="${round2(zero)}" x2="${round2(zero)}" y1="${Tp}" y2="${Tp + plotH}" stroke="${INK}" stroke-width="1.2"/>` : '';
  data.forEach((d, i) => {
    const bh = Math.min(18, rowHeight - 8), by = Tp + i * rowHeight + (rowHeight - bh) / 2;
    const base = d.series != null ? groups.find(e => e.name === d.series).color
      : diverging ? (d.value < 0 ? 'var(--chart-down,#0ca37a)' : 'var(--chart-up,#2a78d6)') : palette(0);
    const col = highlight && !highlight.includes(i) ? MUTED : pickColor(d.color, colors, [d.label, d.series], base);
    const w = Math.max(1, Math.abs(X(d.value) - zero)), bx = d.value < 0 ? zero - w : zero;
    g += axisText(L - 8, by + bh / 2 + 4, 'end', fit(d.label, L - 12), `fill="${INK}"`);
    g += `<rect x="${round2(bx)}" y="${round2(by)}" width="${round2(w)}" height="${bh}" rx="3" fill="${col}">` +
      `<title>${esc(d.label)}: ${esc(text(d))}</title></rect>`;
    g += d.value < 0 ? axisText(bx - 6, by + bh / 2 + 4, 'end', text(d), `fill="${INK}" font-weight="600"`)
      : axisText(bx + w + 6, by + bh / 2 + 4, 'start', text(d), `fill="${INK}" font-weight="600"`);
  });
  return svg(W, height, f.deco + lg.svg + g, lab);
}

// ---------- donut (shares of one total, few slices) ----------
// slices: [{ label, value, color? }]; values must be more than zero. The centre shows
// `centerValue` (default: the formatted total) over `centerLabel`. The list on the right
// gives each slice its value and its share. Slices after the fifth take the muted colour.
export function donut({ slices = [], label, width = 600, height = 220, fmtY = num,
  title, unit, source, colors, centerValue, centerLabel } = {}) {
  const f = frame({ title, unit, source, H: height }), lab = label ?? title ?? 'donut', W = width, H = height - f.bottom;
  if (!slices.length) return svg(W, height, f.deco + axisText(W / 2, H / 2, 'middle', 'no data'), lab);
  slices.forEach((s, i) => { if (!fin(s.value) || s.value <= 0) throw new RangeError(`donut slice ${i} must be a number above zero`); });
  const total = slices.reduce((a, s) => a + s.value, 0);
  const top = f.top + 8, avail = H - top - 8;
  const r = Math.min(avail / 2, W * 0.2), cx = r + 6, cy = top + avail / 2, sw = r * 0.36, rm = r - sw / 2, C = 2 * Math.PI * rm;
  let acc = 0, g = '';
  const colorOf = (s, i) => pickColor(s.color, colors, [s.label], i < 5 ? palette(i) : MUTED);
  slices.forEach((s, i) => {
    const frac = s.value / total, gap = slices.length > 1 ? 1.5 : 0;
    g += `<circle cx="${round2(cx)}" cy="${round2(cy)}" r="${round2(rm)}" fill="none" stroke="${colorOf(s, i)}" stroke-width="${round2(sw)}" ` +
      `stroke-dasharray="${round2(Math.max(0.5, frac * C - gap))} ${round2(C)}" stroke-dashoffset="${round2(-acc * C)}" ` +
      `transform="rotate(-90 ${round2(cx)} ${round2(cy)})"><title>${esc(s.label)}: ${esc(fmtY(s.value))} (${Math.round(frac * 100)}%)</title></circle>`;
    acc += frac;
  });
  const cv = centerValue ?? fmtY(total), inner = 2 * (r - sw) - 6;
  g += axisText(cx, cy + (centerLabel != null ? 2 : 6), 'middle', cv, `fill="${INK}" font-weight="700" font-size="${textW(cv, 17) > inner ? 12 : 17}"`);
  if (centerLabel != null) g += axisText(cx, cy + 16, 'middle', fit(centerLabel, inner, 10), `font-size="10"`);
  const x0 = cx + r + 18, rowH = Math.min(24, avail / slices.length), y0 = cy - rowH * slices.length / 2;
  slices.forEach((s, i) => {
    const y = y0 + i * rowH + rowH / 2, right = fmtY(s.value) + ' · ' + Math.round(s.value / total * 100) + '%';
    g += `<rect x="${round2(x0)}" y="${round2(y - 5)}" width="10" height="10" rx="2" fill="${colorOf(s, i)}"/>`;
    g += axisText(x0 + 16, y + 4, 'start', fit(s.label, W - 4 - textW(right, 12) - (x0 + 16) - 8), `fill="${INK}"`);
    g += axisText(W - 4, y + 4, 'end', right, `font-weight="600" fill="${INK}"`);
  });
  return svg(W, height, f.deco + g, lab);
}

// ---------- heatmap (a value per row and column: weekday by week, category by month) ----------
// rows: [name, ...]; cols: [name, ...]; cells: [{ row, col, value }]. A missing cell is drawn empty.
// One hue; the opacity follows the value from the lowest (or zero) to the highest. Height follows the rows.
export function heatmap({ rows = [], cols = [], cells = [], label, width = 600, cellHeight, fmtY = num,
  title, unit, source, color, cellLabels = true } = {}) {
  const lab = label ?? title ?? 'heatmap', W = width, bandTop = title != null || unit != null ? TOP_BAND : 0;
  const L = rows.length ? Math.min(Math.ceil(Math.max(...rows.map(r => textW(r, 11)))) + 10, Math.round(W * 0.3)) : 10;
  const cw = (W - L - 4) / Math.max(1, cols.length), ch = cellHeight ?? Math.max(18, Math.min(34, cw));
  const Tp = bandTop + 20, plotH = Math.max(1, rows.length) * ch, scaleY = Tp + plotH + 8;
  const height = scaleY + 14 + (source != null ? BOTTOM_BAND : 0);
  const f = frame({ title, unit, source, H: height }), col = color || palette(0);
  const at = new Map();
  cells.forEach((c, i) => {
    if (!rows.includes(c.row) || !cols.includes(c.col)) throw new RangeError(`heatmap cell ${i} names an unknown row or column`);
    if (c.value != null && !fin(c.value)) throw new RangeError(`heatmap cell ${i} value is not a number`);
    if (c.value != null) at.set(c.row + '\u0000' + c.col, c.value);
  });
  const vals = [...at.values()];
  if (!vals.length) return svg(W, height, f.deco + axisText(W / 2, Tp + plotH / 2, 'middle', 'no data'), lab);
  const lo = Math.min(0, ...vals), hi = Math.max(...vals), op = v => hi === lo ? 1 : 0.1 + 0.9 * (v - lo) / (hi - lo);
  const every = Math.max(1, Math.ceil((Math.max(...cols.map(c => textW(c, 11))) + 6) / cw));
  let g = cols.map((c, j) => j % every === 0 ? axisText(L + (j + 0.5) * cw, Tp - 6, 'middle', c, `font-size="11"`) : '').join('');
  const showVal = cellLabels && cw >= Math.max(...vals.map(v => textW(fmtY(v), 10))) + 4;
  rows.forEach((r, i) => {
    g += axisText(L - 6, Tp + (i + 0.5) * ch + 4, 'end', fit(r, L - 8, 11), `font-size="11"`);
    cols.forEach((c, j) => {
      const v = at.get(r + '\u0000' + c), x = L + j * cw + 1, y = Tp + i * ch + 1;
      const box = `x="${round2(x)}" y="${round2(y)}" width="${round2(cw - 2)}" height="${round2(ch - 2)}" rx="3"`;
      if (v == null) { g += `<rect ${box} fill="${GRID}" fill-opacity=".5"><title>${esc(r)} ${esc(c)}: no data</title></rect>`; return; }
      g += `<rect ${box} fill="${col}" fill-opacity="${round2(op(v))}"><title>${esc(r)} ${esc(c)}: ${esc(fmtY(v))}</title></rect>`;
      if (showVal) g += axisText(x + cw / 2 - 1, y + ch / 2 + 2.5, 'middle', fmtY(v), `font-size="10" font-weight="600" fill="${op(v) > 0.55 ? PAPER : INK}"`);
    });
  });
  const loW = textW(fmtY(lo), 10), sx = L + loW + 6;
  g += axisText(L, scaleY + 10, 'start', fmtY(lo), `font-size="10"`);
  for (let k = 0; k < 5; k++) g += `<rect x="${round2(sx + k * 16)}" y="${scaleY}" width="14" height="12" rx="2" fill="${col}" fill-opacity="${round2(0.1 + 0.9 * k / 4)}"/>`;
  g += axisText(sx + 5 * 16 + 4, scaleY + 10, 'start', fmtY(hi), `font-size="10"`);
  return svg(W, height, f.deco + g, lab);
}

// ---------- sparkline (the shape of a short series, no axes) ----------
// values: [number, ...]. A dot marks the last value.
export function sparkline({ values = [], width = 120, height = 32, color, label } = {}) {
  const v = values.filter(fin), col = color || palette(0);
  if (v.length < 2) return svg(width, height, '', label ?? 'sparkline');
  const lo = Math.min(...v), hi = Math.max(...v), pad = 4;
  const X = i => pad + i * (width - 2 * pad) / (v.length - 1);
  const Y = y => hi === lo ? height / 2 : pad + (1 - (y - lo) / (hi - lo)) * (height - 2 * pad);
  return svg(width, height,
    `<polyline fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${v.map((y, i) => round2(X(i)) + ',' + round2(Y(y))).join(' ')}"/>` +
    `<circle cx="${round2(X(v.length - 1))}" cy="${round2(Y(v[v.length - 1]))}" r="2.8" fill="${col}"/>`, label ?? 'sparkline');
}


// =====================================================================================
// Builders added in 0.4.0. All take label, width, fmtY, title, unit, source like the others.
// =====================================================================================
const noData = (W, H, deco, lab, y) => svg(W, H, deco + axisText(W / 2, y ?? H / 2, 'middle', 'no data'), lab);
const nonNeg = (v, what) => { if (!fin(v) || v < 0) throw new RangeError(`${what} must be a number of zero or more`); return v; };

// ---------- grouped bars (two or three series side by side per category) ----------
// categories: [name, ...]; series: [{ name, color?, values: [number per category] }]
export function groupedBars({ categories = [], series = [], label, width = 600, height = 260, fmtY = num,
  title, unit, source, legend = true, colors, valueLabels = true } = {}) {
  const f = frame({ title, unit, source, H: height }), lab = label ?? title ?? 'grouped bars', W = width;
  const colorOf = (s, si) => pickColor(s.color, colors, [s.name], palette(si));
  const lg = legendRows(legend ? series.map((s, si) => ({ name: s.name, color: colorOf(s, si) })) : [], W, f.top);
  const L = 54, R = 14, Tp = 16 + f.top + lg.height, B = 34, H = height - f.bottom;
  const vals = series.flatMap(s => s.values || []).filter(v => v != null);
  if (!vals.length || !categories.length) return noData(W, height, f.deco + lg.svg, lab);
  vals.forEach((v, i) => nonNeg(v, `groupedBars value ${i}`));
  const ticks = niceTicks(0, Math.max(...vals) * 1.12), ymax = ticks[ticks.length - 1] || 1;
  const Y = v => Tp + (1 - v / ymax) * (H - Tp - B), gw = (W - L - R) / categories.length, bw = gw * 0.78 / series.length;
  let g = gridY(ticks, L, R, W, Y, fmtY);
  categories.forEach((c, i) => {
    const x0 = L + i * gw + gw * 0.11;
    series.forEach((s, si) => {
      const v = s.values[i]; if (v == null) return;
      const x = x0 + si * bw, y = Y(v), h = Math.max(1, Y(0) - y), t = fmtY(v);
      g += `<rect x="${round2(x)}" y="${round2(y)}" width="${round2(Math.max(1, bw - 2))}" height="${round2(h)}" rx="2.5" fill="${colorOf(s, si)}">` +
        `<title>${esc(c)} ${esc(s.name)}: ${esc(t)}</title></rect>`;
      if (valueLabels && textW(t, 10) <= bw + 2) g += axisText(x + (bw - 2) / 2, y - 4, 'middle', t, `font-size="10" font-weight="600" fill="${INK}"`);
    });
    g += axisText(L + i * gw + gw / 2, H - 12, 'middle', fit(c, gw - 2));
  });
  return svg(W, height, f.deco + lg.svg + g, lab);
}

// ---------- stacked area (how a total and its parts move over time) ----------
// labels: [x, ...]; series: [{ name, color?, values: [number per label] }], drawn bottom to top in the order given.
export function stackedArea({ labels = [], series = [], label, width = 600, height = 280, fmtY = num,
  title, unit, source, legend = true, colors } = {}) {
  const f = frame({ title, unit, source, H: height }), lab = label ?? title ?? 'stacked area', W = width;
  const colorOf = (s, si) => pickColor(s.color, colors, [s.name], palette(si));
  const lg = legendRows(legend ? series.map((s, si) => ({ name: s.name, color: colorOf(s, si) })) : [], W, f.top);
  const L = 54, R = 16, Tp = 14 + f.top + lg.height, B = 34, H = height - f.bottom;
  if (labels.length < 2 || !series.length) return noData(W, height, f.deco + lg.svg, lab);
  series.forEach((s, si) => labels.forEach((_, i) => nonNeg(s.values[i] ?? 0, `stackedArea series ${si} value ${i}`)));
  const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const ticks = niceTicks(0, Math.max(...totals) * 1.08), ymax = ticks[ticks.length - 1] || 1;
  const X = i => L + i * (W - L - R) / (labels.length - 1), Y = v => Tp + (1 - v / ymax) * (H - Tp - B);
  let g = gridY(ticks, L, R, W, Y, fmtY), base = labels.map(() => 0);
  const every = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor((W - L - R) / 72))));
  series.forEach((s, si) => {
    const top = base.map((b, i) => b + (s.values[i] ?? 0)), col = colorOf(s, si);
    const up = top.map((v, i) => round2(X(i)) + ',' + round2(Y(v))), down = base.map((v, i) => round2(X(i)) + ',' + round2(Y(v))).reverse();
    g += `<polygon fill="${col}" fill-opacity=".78" points="${up.join(' ')} ${down.join(' ')}"><title>${esc(s.name)}</title></polygon>` +
      `<polyline fill="none" stroke="${col}" stroke-width="1.6" points="${up.join(' ')}"/>`;
    base = top;
  });
  g += labels.map((x, i) => (i % every === 0 || i === labels.length - 1)
    ? axisText(X(i), H - 12, i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle', x) : '').join('');
  return svg(W, height, f.deco + lg.svg + g, lab);
}

// ---------- slope chart (each item at two moments; rises and falls cross) ----------
// rows: [{ label, a, b, color? }]; aLabel and bLabel name the two moments. Lines are coloured by direction.
export function slope({ rows = [], label, width = 600, height = 300, aLabel = 'Before', bLabel = 'After', fmtY = num,
  title, unit, source, colors } = {}) {
  const f = frame({ title, unit, source, H: height }), lab = label ?? title ?? 'slope', W = width, H = height - f.bottom;
  const vals = rows.flatMap(r => [r.a, r.b]);
  if (!rows.length) return noData(W, height, f.deco, lab);
  vals.forEach((v, i) => { if (!fin(v)) throw new RangeError(`slope value ${i} is not a number`); });
  const leftW = Math.min(Math.max(...rows.map(r => textW(r.label + ' ' + fmtY(r.a), 11))) + 10, W * 0.46);
  const rightW = Math.max(...rows.map(r => textW(fmtY(r.b), 11))) + 10;
  const x1 = leftW, x2 = W - rightW, Tp = f.top + 30, B = 12, lo = Math.min(...vals), hi = Math.max(...vals);
  const Y = v => hi === lo ? (Tp + H - B) / 2 : Tp + (1 - (v - lo) / (hi - lo)) * (H - Tp - B);
  // Labels keep 13px between them on each side: pushed down in value order, then pulled back inside the plot.
  const spread = key => {
    const order = rows.map((r, i) => ({ i, y: Y(r[key]) })).sort((p, q) => p.y - q.y);
    for (let k = 1; k < order.length; k++) order[k].y = Math.max(order[k].y, order[k - 1].y + 13);
    const over = order.length ? order[order.length - 1].y - (H - B) : 0;
    if (over > 0) for (let k = order.length - 1; k >= 0; k--) order[k].y = Math.min(order[k].y, H - B - (order.length - 1 - k) * 13);
    const out = []; order.forEach(p => { out[p.i] = p.y; }); return out;
  };
  const ya = spread('a'), yb = spread('b');
  let g = axisText(x1, Tp - 14, 'end', aLabel, `font-weight="700" fill="${INK}"`) + axisText(x2, Tp - 14, 'start', bLabel, `font-weight="700" fill="${INK}"`) +
    `<line x1="${round2(x1)}" x2="${round2(x1)}" y1="${Tp - 6}" y2="${H - B + 6}" stroke="${GRID}"/><line x1="${round2(x2)}" x2="${round2(x2)}" y1="${Tp - 6}" y2="${H - B + 6}" stroke="${GRID}"/>`;
  rows.forEach((r, i) => {
    const dir = r.b > r.a ? 'var(--chart-up,#2a78d6)' : r.b < r.a ? 'var(--chart-down,#0ca37a)' : MUTED;
    const col = pickColor(r.color, colors, [r.label], dir);
    g += `<line x1="${round2(x1)}" y1="${round2(Y(r.a))}" x2="${round2(x2)}" y2="${round2(Y(r.b))}" stroke="${col}" stroke-width="2.2"><title>${esc(r.label)}: ${esc(fmtY(r.a))} to ${esc(fmtY(r.b))}</title></line>` +
      `<circle cx="${round2(x1)}" cy="${round2(Y(r.a))}" r="3.4" fill="${col}"/><circle cx="${round2(x2)}" cy="${round2(Y(r.b))}" r="3.4" fill="${col}"/>`;
    g += axisText(x1 - 8, ya[i] + 4, 'end', fit(r.label, leftW - 14 - textW(fmtY(r.a), 11), 11) + ' ' + fmtY(r.a), `font-size="11" fill="${INK}"`);
    g += axisText(x2 + 8, yb[i] + 4, 'start', fmtY(r.b), `font-size="11" font-weight="600" fill="${INK}"`);
  });
  return svg(W, height, f.deco + g, lab);
}

// ---------- bullet (a value against its target, one row per item) ----------
// rows: [{ label, value, target, color? }]. The bar is the value; the tick is the target. Height follows the rows.
export function bullet({ rows = [], label, width = 600, rowHeight = 40, fmtY = num, title, unit, source, colors, overColor = null } = {}) {
  const lab = label ?? title ?? 'bullet', W = width, bandTop = title != null || unit != null ? TOP_BAND : 0;
  const Tp = bandTop + 4, height = Tp + Math.max(1, rows.length) * rowHeight + 4 + (source != null ? BOTTOM_BAND : 0);
  const f = frame({ title, unit, source, H: height });
  if (!rows.length) return noData(W, height, f.deco, lab);
  rows.forEach((r, i) => { nonNeg(r.value, `bullet row ${i} value`); nonNeg(r.target, `bullet row ${i} target`); });
  const hi = Math.max(...rows.flatMap(r => [r.value, r.target])) * 1.08 || 1, X = v => 4 + v / hi * (W - 8);
  let g = '';
  rows.forEach((r, i) => {
    const y = Tp + i * rowHeight, over = r.value > r.target;
    const col = pickColor(r.color, colors, [r.label], over && overColor ? overColor : palette(0));
    const right = fmtY(r.value) + ' / ' + fmtY(r.target);
    g += axisText(4, y + 13, 'start', fit(r.label, W - 16 - textW(right, 12)), `fill="${INK}" font-weight="600"`);
    g += axisText(W - 4, y + 13, 'end', right, `fill="${over && overColor ? overColor : AXIS}"`);
    g += `<rect x="4" y="${y + 20}" width="${W - 8}" height="10" rx="5" fill="${GRID}"/>` +
      `<rect x="4" y="${y + 20}" width="${round2(Math.max(2, X(r.value) - 4))}" height="10" rx="5" fill="${col}"><title>${esc(r.label)}: ${esc(right)}</title></rect>` +
      `<rect x="${round2(X(r.target) - 1.25)}" y="${y + 16}" width="2.5" height="18" rx="1" fill="${INK}"/>`;
  });
  return svg(W, height, f.deco + g, lab);
}

// ---------- histogram (how the values of one measure are spread) ----------
// values: [number, ...] binned into `bins` equal bins, or bins: [{ from, to, count }]. `mark: { value, text }` draws a line.
export function histogram({ values = null, bins = 12, label, width = 600, height = 250, fmtX = num, fmtY = num,
  title, unit, source, color, mark = null } = {}) {
  const f = frame({ title, unit, source, H: height }), lab = label ?? title ?? 'histogram', W = width, H = height - f.bottom;
  let cells = Array.isArray(bins) ? bins.map(b => ({ from: b.from, to: b.to, count: b.count })) : [];
  if (Array.isArray(values)) {
    const v = values.filter(fin); if (v.length) {
      const t = niceTicks(Math.min(...v), Math.max(...v), Number.isInteger(bins) ? bins : 12), step = (t[1] - t[0]) || 1;
      cells = t.slice(0, -1).map(a => ({ from: a, to: +(a + step).toFixed(10), count: 0 }));
      v.forEach(x => { cells[Math.min(cells.length - 1, Math.max(0, Math.floor((x - t[0]) / step)))].count++; });
    }
  }
  if (!cells.length) return noData(W, height, f.deco, lab);
  cells.forEach((c, i) => { nonNeg(c.count, `histogram bin ${i} count`); if (!fin(c.from) || !fin(c.to) || c.to <= c.from) throw new RangeError(`histogram bin ${i} needs from < to`); });
  const L = 44, R = 12, Tp = 16 + f.top, B = 34, lo = cells[0].from, hi = cells[cells.length - 1].to;
  const ticks = niceTicks(0, Math.max(...cells.map(c => c.count)) * 1.1), ymax = ticks[ticks.length - 1] || 1;
  const X = v => L + (v - lo) / (hi - lo) * (W - L - R), Y = v => Tp + (1 - v / ymax) * (H - Tp - B), col = color || palette(0);
  let g = gridY(ticks, L, R, W, Y, fmtY);
  cells.forEach(c => {
    g += `<rect x="${round2(X(c.from) + 0.75)}" y="${round2(Y(c.count))}" width="${round2(Math.max(1, X(c.to) - X(c.from) - 1.5))}" height="${round2(Math.max(0, Y(0) - Y(c.count)))}" rx="2" fill="${col}">` +
      `<title>${esc(fmtX(c.from))} to ${esc(fmtX(c.to))}: ${esc(fmtY(c.count))}</title></rect>`;
  });
  const edges = [...cells.map(c => c.from), hi], every = Math.max(1, Math.ceil((Math.max(...edges.map(e => textW(fmtX(e), 12))) + 10) / ((W - L - R) / cells.length)));
  g += edges.map((e, i) => i % every === 0 ? axisText(X(e), H - 14, i === 0 ? 'start' : 'middle', fmtX(e)) : '').join('');
  if (mark && fin(mark.value) && mark.value >= lo && mark.value <= hi) {
    const x = X(mark.value), right = x < L + (W - L - R) * 0.6;
    g += `<line x1="${round2(x)}" x2="${round2(x)}" y1="${Tp - 4}" y2="${round2(Y(0))}" stroke="${INK}" stroke-width="1.4" stroke-dasharray="4 3"/>` +
      axisText(x + (right ? 5 : -5), Tp + 6, right ? 'start' : 'end', mark.text ?? fmtX(mark.value), `fill="${INK}" font-weight="700"`);
  }
  return svg(W, height, f.deco + g, lab);
}

// ---------- box plot (spread of a measure per group: min, quartiles, median, max) ----------
// groups: [{ label, values: [...] }] or [{ label, min, q1, median, q3, max }]. Horizontal; height follows the rows.
export function boxPlot({ groups = [], label, width = 600, rowHeight = 34, fmtY = num, title, unit, source, colors } = {}) {
  const lab = label ?? title ?? 'box plot', W = width, bandTop = title != null || unit != null ? TOP_BAND : 0;
  const Tp = bandTop + 6, plotH = Math.max(1, groups.length) * rowHeight, B = 22;
  const height = Tp + plotH + B + (source != null ? BOTTOM_BAND : 0), f = frame({ title, unit, source, H: height });
  const q = (v, p) => { const k = (v.length - 1) * p, a = Math.floor(k), b = Math.ceil(k); return v[a] + (v[b] - v[a]) * (k - a); };
  const boxes = groups.map((gr, i) => {
    if (Array.isArray(gr.values)) {
      const v = gr.values.filter(fin).sort((a, b) => a - b);
      if (!v.length) throw new RangeError(`boxPlot group ${i} has no values`);
      return { label: gr.label, min: v[0], q1: q(v, 0.25), median: q(v, 0.5), q3: q(v, 0.75), max: v[v.length - 1], color: gr.color };
    }
    const b = { label: gr.label, min: gr.min, q1: gr.q1, median: gr.median, q3: gr.q3, max: gr.max, color: gr.color };
    if (![b.min, b.q1, b.median, b.q3, b.max].every(fin) || !(b.min <= b.q1 && b.q1 <= b.median && b.median <= b.q3 && b.q3 <= b.max)) throw new RangeError(`boxPlot group ${i} needs min <= q1 <= median <= q3 <= max`);
    return b;
  });
  if (!boxes.length) return noData(W, height, f.deco, lab);
  const L = Math.min(Math.ceil(Math.max(...boxes.map(b => textW(b.label, 12)))) + 12, Math.round(W * 0.36)), R = 14;
  const ticks = niceTicks(Math.min(...boxes.map(b => b.min)), Math.max(...boxes.map(b => b.max)), 4), lo = ticks[0], hi = ticks[ticks.length - 1];
  const X = v => L + (v - lo) / ((hi - lo) || 1) * (W - L - R);
  let g = ticks.map(t => `<line x1="${round2(X(t))}" x2="${round2(X(t))}" y1="${Tp}" y2="${Tp + plotH}" stroke="${GRID}"/>` + axisText(X(t), Tp + plotH + 15, 'middle', fmtY(t))).join('');
  boxes.forEach((b, i) => {
    const y = Tp + (i + 0.5) * rowHeight, bh = Math.min(18, rowHeight - 12), col = pickColor(b.color, colors, [b.label], palette(0));
    g += axisText(L - 8, y + 4, 'end', fit(b.label, L - 12), `fill="${INK}"`);
    g += `<line x1="${round2(X(b.min))}" x2="${round2(X(b.max))}" y1="${round2(y)}" y2="${round2(y)}" stroke="${col}" stroke-width="1.6"/>` +
      [b.min, b.max].map(v => `<line x1="${round2(X(v))}" x2="${round2(X(v))}" y1="${round2(y - 5)}" y2="${round2(y + 5)}" stroke="${col}" stroke-width="1.6"/>`).join('') +
      `<rect x="${round2(X(b.q1))}" y="${round2(y - bh / 2)}" width="${round2(Math.max(2, X(b.q3) - X(b.q1)))}" height="${bh}" rx="3" fill="${col}" fill-opacity=".3" stroke="${col}" stroke-width="1.6">` +
      `<title>${esc(b.label)}: median ${esc(fmtY(b.median))}, middle half ${esc(fmtY(b.q1))} to ${esc(fmtY(b.q3))}, range ${esc(fmtY(b.min))} to ${esc(fmtY(b.max))}</title></rect>` +
      `<line x1="${round2(X(b.median))}" x2="${round2(X(b.median))}" y1="${round2(y - bh / 2)}" y2="${round2(y + bh / 2)}" stroke="${INK}" stroke-width="2.4"/>`;
  });
  return svg(W, height, f.deco + g, lab);
}

// ---------- calendar (one cell per day, weeks as columns: habits, streaks, seasons) ----------
// days: [{ date: 'YYYY-MM-DD', value }]. Covers the first to the last date given; a day without a value is empty.
export function calendar({ days = [], label, width = 600, fmtY = num, title, unit, source, color } = {}) {
  const lab = label ?? title ?? 'calendar', W = width, bandTop = title != null || unit != null ? TOP_BAND : 0, DAY = 86400000;
  const parse = (d, i) => { const t = Date.parse(d + 'T00:00:00Z'); if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d)) || Number.isNaN(t)) throw new RangeError(`calendar day ${i} date must be YYYY-MM-DD`); return t; };
  const at = new Map();
  days.forEach((d, i) => { const t = parse(d.date, i); if (d.value != null) { if (!fin(d.value)) throw new RangeError(`calendar day ${i} value is not a number`); at.set(t, d.value); } else if (!at.has(t)) at.set(t, null); });
  if (![...at.values()].some(v => v != null)) return noData(W, 120 + bandTop, frame({ title, unit, source, H: 120 + bandTop }).deco, lab);
  const first = Math.min(...at.keys()), last = Math.max(...at.keys()), dow = t => (new Date(t).getUTCDay() + 6) % 7;   // Monday = 0
  const start = first - dow(first) * DAY, weeks = Math.floor((last - start) / DAY / 7) + 1;
  const L = 22, cell = Math.min(22, (W - L - 2) / weeks), Tp = bandTop + 18, gridH = cell * 7, scaleY = Tp + gridH + 8;
  const height = scaleY + 14 + (source != null ? BOTTOM_BAND : 0), f = frame({ title, unit, source, H: height }), col = color || palette(0);
  const vals = [...at.values()].filter(v => v != null), lo = Math.min(0, ...vals), hi = Math.max(...vals), op = v => hi === lo ? 1 : 0.14 + 0.86 * (v - lo) / (hi - lo);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let g = ['M', '', 'W', '', 'F', '', ''].map((n, r) => n ? axisText(L - 6, Tp + (r + 0.5) * cell + 3.5, 'end', n, `font-size="10"`) : '').join(''), lastLabelX = -99;
  for (let w = 0; w < weeks; w++) for (let r = 0; r < 7; r++) {
    const t = start + (w * 7 + r) * DAY; if (t < first || t > last) continue;
    const d = new Date(t), x = L + w * cell, y = Tp + r * cell, v = at.get(t), iso = d.toISOString().slice(0, 10), pad = cell > 8 ? 1 : 0.5;
    if (d.getUTCDate() === 1 && x - lastLabelX > 26) { g += axisText(x, Tp - 6, 'start', MONTHS[d.getUTCMonth()], `font-size="10"`); lastLabelX = x; }
    g += v == null ? `<rect x="${round2(x + pad)}" y="${round2(y + pad)}" width="${round2(cell - 2 * pad)}" height="${round2(cell - 2 * pad)}" rx="${cell > 8 ? 2.5 : 1}" fill="${GRID}" fill-opacity=".55"><title>${iso}: no data</title></rect>`
      : `<rect x="${round2(x + pad)}" y="${round2(y + pad)}" width="${round2(cell - 2 * pad)}" height="${round2(cell - 2 * pad)}" rx="${cell > 8 ? 2.5 : 1}" fill="${col}" fill-opacity="${round2(op(v))}"><title>${iso}: ${esc(fmtY(v))}</title></rect>`;
  }
  const loT = fmtY(lo), sx = L + textW(loT, 10) + 6;
  g += axisText(L, scaleY + 10, 'start', loT, `font-size="10"`);
  for (let k = 0; k < 5; k++) g += `<rect x="${round2(sx + k * 16)}" y="${scaleY}" width="14" height="12" rx="2" fill="${col}" fill-opacity="${round2(0.14 + 0.86 * k / 4)}"/>`;
  g += axisText(sx + 84, scaleY + 10, 'start', fmtY(hi), `font-size="10"`);
  return svg(W, height, f.deco + g, lab);
}

// ---------- treemap (many parts of one total, area = value) ----------
// items: [{ label, value, color? }], values above zero. Squarified; a tile shows its name and value when they fit.
export function treemap({ items = [], label, width = 600, height = 260, fmtY = num, title, unit, source, colors, color } = {}) {
  const f = frame({ title, unit, source, H: height }), lab = label ?? title ?? 'treemap', W = width, H = height - f.bottom, Tp = f.top + 2;
  if (!items.length) return noData(W, height, f.deco, lab);
  items.forEach((it, i) => { if (!fin(it.value) || it.value <= 0) throw new RangeError(`treemap item ${i} must be a number above zero`); });
  const total = items.reduce((a, it) => a + it.value, 0), area = W * (H - Tp);
  let rest = items.map((it, i) => ({ it, i, area: it.value / total * area })).sort((a, b) => b.area - a.area), x = 0, y = Tp, w = W, h = H - Tp;
  const tiles = [], rank = new Map(rest.map((b, k) => [b.i, k]));
  while (rest.length) {
    const short = Math.min(w, h), worst = r => { const s = r.reduce((a, b) => a + b.area, 0); return Math.max(short * short * r[0].area / (s * s), s * s / (short * short * r[r.length - 1].area)); };
    let n = 1; while (n < rest.length && worst(rest.slice(0, n + 1)) <= worst(rest.slice(0, n))) n++;
    const row = rest.slice(0, n), s = row.reduce((a, b) => a + b.area, 0);
    if (w >= h) { const cw = s / h; let cy = y; row.forEach(b => { tiles.push({ ...b, x, y: cy, w: cw, h: b.area / cw }); cy += b.area / cw; }); x += cw; w -= cw; }
    else { const ch = s / w; let cx = x; row.forEach(b => { tiles.push({ ...b, x: cx, y, w: b.area / ch, h: ch }); cx += b.area / ch; }); y += ch; h -= ch; }
    rest = rest.slice(n);
  }
  const g = tiles.map(t => {
    const op = items.length === 1 ? 1 : 1 - 0.68 * rank.get(t.i) / (items.length - 1), own = pickColor(t.it.color, colors, [t.it.label], null);
    const val = fmtY(t.it.value), ink = own || op > 0.55 ? PAPER : INK, name = fit(t.it.label, t.w - 12, 12);
    let text = '';
    if (t.w >= 34 && t.h >= 20) text += axisText(t.x + 6, t.y + 15, 'start', name, `fill="${ink}" font-weight="700"`);
    if (t.w >= textW(val, 11) + 10 && t.h >= 36) text += axisText(t.x + 6, t.y + 29, 'start', val, `fill="${ink}" font-size="11"`);
    return `<rect x="${round2(t.x + 1)}" y="${round2(t.y + 1)}" width="${round2(Math.max(1, t.w - 2))}" height="${round2(Math.max(1, t.h - 2))}" rx="4" fill="${own || color || palette(0)}"${own ? '' : ` fill-opacity="${round2(op)}"`}>` +
      `<title>${esc(t.it.label)}: ${esc(val)} (${Math.round(t.it.value / total * 100)}%)</title></rect>` + text;
  }).join('');
  return svg(W, height, f.deco + g, lab);
}

// ---------- funnel (how many remain at each stage) ----------
// stages: [{ label, value }] in order. Each row shows its value and its share of the first stage.
export function funnel({ stages = [], label, width = 600, rowHeight = 44, fmtY = num, title, unit, source, color } = {}) {
  const lab = label ?? title ?? 'funnel', W = width, bandTop = title != null || unit != null ? TOP_BAND : 0;
  const Tp = bandTop + 4, height = Tp + Math.max(1, stages.length) * rowHeight + (source != null ? BOTTOM_BAND : 0), f = frame({ title, unit, source, H: height });
  if (!stages.length) return noData(W, height, f.deco, lab);
  stages.forEach((st, i) => nonNeg(st.value, `funnel stage ${i}`));
  const top = Math.max(...stages.map(st => st.value)) || 1, col = color || palette(0), maxW = W - 8;
  let g = '';
  stages.forEach((st, i) => {
    const y = Tp + i * rowHeight, w = Math.max(3, st.value / top * maxW), x = (W - w) / 2, bh = rowHeight - 20;
    const share = stages[0].value > 0 ? Math.round(st.value / stages[0].value * 100) + '%' : '';
    const right = fmtY(st.value) + (i > 0 && share ? ' · ' + share : '');
    g += axisText(4, y + 12, 'start', fit(st.label, W - 16 - textW(right, 12)), `fill="${INK}" font-weight="600"`) + axisText(W - 4, y + 12, 'end', right);
    g += `<rect x="${round2(x)}" y="${y + 17}" width="${round2(w)}" height="${bh}" rx="5" fill="${col}" fill-opacity="${round2(1 - 0.55 * i / Math.max(1, stages.length - 1))}"><title>${esc(st.label)}: ${esc(right)}</title></rect>`;
  });
  return svg(W, height, f.deco + g, lab);
}

// ---------- sankey, two columns (where an amount comes from and where it goes) ----------
// flows: [{ from, to, value }]. Sources stand on the left, targets on the right; a band's thickness is its value.
export function sankey({ flows = [], label, width = 600, height = 300, fmtY = num, title, unit, source, colors } = {}) {
  const f = frame({ title, unit, source, H: height }), lab = label ?? title ?? 'sankey', W = width, H = height - f.bottom, Tp = f.top + 6;
  if (!flows.length) return noData(W, height, f.deco, lab);
  flows.forEach((fl, i) => { if (!fin(fl.value) || fl.value <= 0) throw new RangeError(`sankey flow ${i} must be a number above zero`); });
  const sum = (list, key) => { const m = new Map(); list.forEach(fl => m.set(fl[key], (m.get(fl[key]) || 0) + fl.value)); return [...m].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value); };
  const left = sum(flows, 'from'), right = sum(flows, 'to'), total = left.reduce((a, n) => a + n.value, 0), gap = 6, nw = 9;
  const scale = (H - Tp - 4 - gap * (Math.max(left.length, right.length) - 1)) / total;
  if (scale <= 0) throw new RangeError('sankey has too many nodes for its height');
  const place = nodes => { let y = Tp + (H - Tp - 4 - (total * scale + gap * (nodes.length - 1))) / 2; nodes.forEach(n => { n.y = y; n.h = Math.max(1, n.value * scale); n.used = 0; y += n.h + gap; }); };
  place(left); place(right);
  const xl = 2, xr = W - 2 - nw, mid = W / 2;
  let bands = '', nodes = '';
  const colL = (n, i) => pickColor(null, colors, [n.name], palette(i));
  [...flows].sort((a, b) => left.findIndex(n => n.name === a.from) - left.findIndex(n => n.name === b.from) || right.findIndex(n => n.name === a.to) - right.findIndex(n => n.name === b.to)).forEach(fl => {
    const li = left.findIndex(n => n.name === fl.from), a = left[li], b = right.find(n => n.name === fl.to), h = fl.value * scale;
    const y0 = a.y + a.used, y1 = b.y + b.used; a.used += h; b.used += h;
    bands += `<path d="M${xl + nw},${round2(y0)} C${round2(mid)},${round2(y0)} ${round2(mid)},${round2(y1)} ${xr},${round2(y1)} L${xr},${round2(y1 + h)} C${round2(mid)},${round2(y1 + h)} ${round2(mid)},${round2(y0 + h)} ${xl + nw},${round2(y0 + h)} Z" ` +
      `fill="${colL(a, li)}" fill-opacity=".32"><title>${esc(fl.from)} to ${esc(fl.to)}: ${esc(fmtY(fl.value))}</title></path>`;
  });
  const half = W / 2 - nw - 14;
  left.forEach((n, i) => { nodes += `<rect x="${xl}" y="${round2(n.y)}" width="${nw}" height="${round2(n.h)}" rx="2" fill="${colL(n, i)}"/>`; if (n.h >= 11) nodes += axisText(xl + nw + 5, n.y + n.h / 2 + 4, 'start', fit(n.name + ' ' + fmtY(n.value), half, 11), `font-size="11" fill="${INK}" font-weight="600"`); });
  right.forEach(n => { nodes += `<rect x="${xr}" y="${round2(n.y)}" width="${nw}" height="${round2(n.h)}" rx="2" fill="var(--chart-total,#8d979d)"/>`; if (n.h >= 11) nodes += axisText(xr - 5, n.y + n.h / 2 + 4, 'end', fit(n.name + ' ' + fmtY(n.value), half, 11), `font-size="11" fill="${INK}" font-weight="600"`); });
  return svg(W, height, f.deco + bands + nodes, lab);
}

// ---------- gauge (one value on its way to a limit or a goal) ----------
// value, max, optional target (a tick on the arc) and caption (under the number).
export function gauge({ value, max, target = null, caption = null, label, width = 300, height = 190, fmtY = num, title, unit, source, color } = {}) {
  const f = frame({ title, unit, source, H: height }), lab = label ?? title ?? 'gauge', W = width, H = height - f.bottom;
  if (!fin(value) || !fin(max)) return noData(W, height, f.deco, lab);
  if (max <= 0 || value < 0) throw new RangeError('gauge needs value of zero or more and max above zero');
  const sw = 16, r = Math.min((W - 24) / 2, H - f.top - 34) - sw / 2, cx = W / 2, cy = f.top + 12 + r + sw / 2;
  const arc = `M${round2(cx - r)},${round2(cy)} A${round2(r)},${round2(r)} 0 0 1 ${round2(cx + r)},${round2(cy)}`, pct = Math.min(1, value / max) * 100;
  let g = `<path d="${arc}" fill="none" stroke="${GRID}" stroke-width="${sw}" stroke-linecap="round"/>` +
    `<path d="${arc}" fill="none" stroke="${color || palette(0)}" stroke-width="${sw}" stroke-linecap="round" pathLength="100" stroke-dasharray="${round2(Math.max(0.01, pct))} 100"><title>${esc(fmtY(value))} of ${esc(fmtY(max))}</title></path>`;
  if (target != null && fin(target) && target >= 0 && target <= max) {
    const a = Math.PI * (1 - target / max), c = Math.cos(a), s = Math.sin(a);
    g += `<line x1="${round2(cx + (r - sw / 2 - 3) * c)}" y1="${round2(cy - (r - sw / 2 - 3) * s)}" x2="${round2(cx + (r + sw / 2 + 3) * c)}" y2="${round2(cy - (r + sw / 2 + 3) * s)}" stroke="${INK}" stroke-width="2.5"/>`;
  }
  g += axisText(cx, cy - 8, 'middle', fmtY(value), `font-size="26" font-weight="700" fill="${INK}"`) +
    axisText(cx, cy + 12, 'middle', caption ?? ('of ' + fmtY(max)), `font-size="12"`) +
    axisText(cx - r, cy + 20, 'middle', fmtY(0), `font-size="10"`) + axisText(cx + r, cy + 20, 'middle', fmtY(max), `font-size="10"`);
  return svg(W, height, f.deco + g, lab);
}

// ---------- pareto (ranked bars with the running share: which few items make most of the total) ----------
// data: [{ label, value }]; sorted here from the largest. The line is the cumulative share; a rule marks 80%.
export function pareto({ data = [], label, width = 600, height = 270, fmtY = num, title, unit, source, color } = {}) {
  const f = frame({ title, unit, source, H: height }), lab = label ?? title ?? 'pareto', W = width, H = height - f.bottom;
  if (!data.length) return noData(W, height, f.deco, lab);
  data.forEach((d, i) => nonNeg(d.value, `pareto value ${i}`));
  const rows = [...data].sort((a, b) => b.value - a.value), total = rows.reduce((a, d) => a + d.value, 0) || 1;
  const L = 54, R = 40, Tp = 16 + f.top, B = 34, ticks = niceTicks(0, rows[0].value * 1.12), ymax = ticks[ticks.length - 1] || 1;
  const Y = v => Tp + (1 - v / ymax) * (H - Tp - B), P = p => Tp + (1 - p) * (H - Tp - B), bw = (W - L - R) / rows.length, col = color || palette(0);
  let g = gridY(ticks, L, R, W, Y, fmtY) + [0, 0.5, 1].map(p => axisText(W - R + 6, P(p) + 4, 'start', Math.round(p * 100) + '%')).join('');
  g += `<line x1="${L}" x2="${W - R}" y1="${round2(P(0.8))}" y2="${round2(P(0.8))}" stroke="${TGT}" stroke-width="1.2" stroke-dasharray="5 4"/>` + axisText(W - R + 6, P(0.8) + 4, 'start', '80%', `fill="${TGT}"`);
  let acc = 0; const pts = [];
  rows.forEach((d, i) => {
    const x = L + i * bw + bw * 0.14, w = bw * 0.72; acc += d.value; pts.push([x + w / 2, P(acc / total)]);
    g += `<rect x="${round2(x)}" y="${round2(Y(d.value))}" width="${round2(w)}" height="${round2(Math.max(1, Y(0) - Y(d.value)))}" rx="3" fill="${col}"><title>${esc(d.label)}: ${esc(fmtY(d.value))}, running share ${Math.round(acc / total * 100)}%</title></rect>`;
    g += axisText(x + w / 2, H - 12, 'middle', fit(d.label, bw - 2, 11), `font-size="11"`);
  });
  g += `<polyline fill="none" stroke="${INK}" stroke-width="2" points="${pts.map(p => round2(p[0]) + ',' + round2(p[1])).join(' ')}"/>` +
    pts.map(p => `<circle cx="${round2(p[0])}" cy="${round2(p[1])}" r="3" fill="${INK}"/>`).join('');
  return svg(W, height, f.deco + g, lab);
}

// ---------- word cloud (which words or names carry a body of text) ----------
// words: [{ text, value, color? }], value above zero. The largest word sits in the middle; the others are placed
// along a spiral, largest first, where their box touches no placed word. A word that finds no free place is left
// out and counted in the svg's data-omitted attribute, never drawn over another. Horizontal text only: it reads.
export function wordCloud({ words = [], label, width = 600, height = 300, minSize = 12, maxSize = 40, fmtY = num,
  title, unit, source, colors } = {}) {
  const f = frame({ title, unit, source, H: height }), lab = label ?? title ?? 'word cloud', W = width, H = height - f.bottom, Tp = f.top + 2;
  if (!words.length) return noData(W, height, f.deco, lab);
  words.forEach((w, i) => { if (!fin(w.value) || w.value <= 0 || !String(w.text ?? '').trim()) throw new RangeError(`wordCloud word ${i} needs a text and a value above zero`); });
  const sorted = [...words].sort((a, b) => b.value - a.value), hi = sorted[0].value, lo = sorted[sorted.length - 1].value;
  const size = v => hi === lo ? (minSize + maxSize) / 2 : minSize + (maxSize - minSize) * Math.sqrt((v - lo) / (hi - lo));
  const cx = W / 2, cy = Tp + (H - Tp) / 2, placed = [];
  let g = '', omitted = 0;
  sorted.forEach((w, i) => {
    const fs = Math.round(size(w.value)), tw = String(w.text).length * fs * 0.58 + 6, th = fs * 1.12;
    let box = null;
    for (let t = 0; t < 1400 && !box; t++) {                 // Archimedean spiral, wider than tall like the plot
      const a = t * 0.35, r = 1.6 * a, x = cx + r * Math.cos(a) * 1.5 - tw / 2, y = cy + r * Math.sin(a) * 0.8 - th / 2;
      if (x < 2 || y < Tp || x + tw > W - 2 || y + th > H - 2) continue;
      if (!placed.some(b => x < b.x + b.w && x + tw > b.x && y < b.y + b.h && y + th > b.y)) box = { x, y, w: tw, h: th };
    }
    if (!box) { omitted++; return; }
    placed.push(box);
    const col = pickColor(w.color, colors, [w.text], i < 3 ? palette(0) : palette(1 + (i % 4)));
    g += `<text x="${round2(box.x + tw / 2)}" y="${round2(box.y + th * 0.78)}" text-anchor="middle" font-size="${fs}" ` +
      `font-weight="${i < 3 ? 700 : 600}" fill="${col}" fill-opacity="${round2(i < 3 ? 1 : 0.55 + 0.45 * (fs - minSize) / ((maxSize - minSize) || 1))}">` +
      `${esc(w.text)}<title>${esc(w.text)}: ${esc(fmtY(w.value))}</title></text>`;
  });
  return svg(W, height, f.deco + g, lab).replace('<svg ', `<svg data-omitted="${omitted}" `);
}

export default { lineChart, barChart, waterfall, scatter, divergingBars, dumbbell, stackedBars, hbarChart, donut, heatmap, sparkline,
  groupedBars, stackedArea, slope, bullet, histogram, boxPlot, calendar, treemap, funnel, sankey, gauge, pareto, wordCloud,
  niceTicks, svg, esc, fin, palette };
