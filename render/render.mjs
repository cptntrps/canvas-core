// Block spec -> HTML. The one place that validates a block and draws it.
// A defect in a spec throws SpecError with a message the agent can act on; nothing is drawn from a bad spec.
// CLI: reads one JSON spec on stdin, writes {"ok":true,"html":..,"kind":..,"chart":..} or {"ok":false,"error":..}.
import * as C from './charts.js';

export class SpecError extends Error {}
const fail = m => { throw new SpecError(m); };
const esc = C.esc;
export const WIDTH = 358;            // iPhone canvas column in points; the svg scales to the real width

export const CHARTS = ['line', 'area', 'stacked_area', 'bar', 'grouped', 'hbar', 'pareto', 'waterfall', 'diverging', 'dumbbell', 'slope',
  'stacked', 'donut', 'treemap', 'heatmap', 'calendar', 'histogram', 'boxplot', 'bullet', 'gauge', 'funnel', 'sankey', 'scatter', 'wordcloud',
  'combo', 'small_multiples', 'bump', 'bubbles', 'gantt', 'strip'];
export const KINDS = ['heading', 'kpi', 'insight', 'chart', 'table', 'map', 'timeline'];
const FORMATS = ['number', 'integer', 'usd', 'brl', 'percent'];

// ---------- field checks ----------
const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);
function str(o, k, { max = 80, optional = false, path = '' } = {}) {
  const v = o[k];
  if (v == null || v === '') { if (optional) return null; fail(`${path}${k} is required (text)`); }
  if (typeof v !== 'string') fail(`${path}${k} must be text`);
  if (v.length > max) fail(`${path}${k} has ${v.length} characters; the limit is ${max}. Shorten it.`);
  return v;
}
function num(o, k, { optional = false, path = '' } = {}) {
  const v = o[k];
  if (v == null) { if (optional) return null; fail(`${path}${k} is required (number)`); }
  if (!C.fin(v)) fail(`${path}${k} must be a finite number, not ${JSON.stringify(v)}. Send numbers as JSON numbers, not text.`);
  return v;
}
function list(o, k, { min = 1, max, path = '', hint = '' } = {}) {
  const v = o[k];
  if (!Array.isArray(v)) fail(`${path}${k} must be a list`);
  if (v.length < min) fail(`${path}${k} needs at least ${min} item${min > 1 ? 's' : ''}; it has ${v.length}`);
  if (max != null && v.length > max) fail(`${path}${k} has ${v.length} items; the limit is ${max}.${hint ? ' ' + hint : ''}`);
  return v;
}
function oneOf(o, k, allowed, { optional = false, path = '' } = {}) {
  const v = o[k];
  if (v == null) { if (optional) return null; fail(`${path}${k} is required: one of ${allowed.join(', ')}`); }
  if (!allowed.includes(v)) fail(`${path}${k} "${v}" is not valid: use one of ${allowed.join(', ')}`);
  return v;
}
function known(o, allowed, where) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${where} has an unknown field "${k}". Fields: ${allowed.join(', ')}`);
}

// ---------- number formats ----------
// A spec names a format, decimals and a suffix; the formatter is built here, never sent by the agent.
function formatter({ format = 'number', decimals = null, suffix = '' } = {}, { compact = false, values = null } = {}) {
  const cur = format === 'usd' ? '$' : format === 'brl' ? 'R$' : '';
  // One number of decimals for the whole set (axis ticks and labels agree): none when the set reaches 100
  // or holds only whole numbers; else 2 for money, 1 for the others.
  const set = (values || []).filter(C.fin).map(Math.abs);
  const whole = set.length > 0 && (Math.max(...set) >= 100 || set.every(Number.isInteger));
  const d = decimals ?? (format === 'integer' ? 0 : values ? (whole ? 0 : cur ? 2 : 1) : null);
  return v => {
    if (!C.fin(v)) return 'n/a';
    const a = Math.abs(v), sign = v < 0 ? '−' : '';
    let body;
    if (compact && a >= 1e6) body = (a / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    else if (compact && a >= 1e4) body = (a / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'k';
    else {
      const dd = d ?? (cur ? (a >= 1000 || Number.isInteger(a) ? 0 : 2) : (Number.isInteger(a) || a >= 100 ? 0 : a >= 10 ? 1 : 2));
      body = a.toLocaleString('en-US', { minimumFractionDigits: cur && dd === 2 ? 2 : 0, maximumFractionDigits: dd });
    }
    return sign + cur + body + (format === 'percent' ? '%' : '') + (suffix || '');
  };
}
function fmtFields(o, path = '') {
  const format = oneOf(o, 'format', FORMATS, { optional: true, path }) ?? 'number';
  const decimals = num(o, 'decimals', { optional: true, path });
  if (decimals != null && (!Number.isInteger(decimals) || decimals < 0 || decimals > 3)) fail(`${path}decimals must be 0, 1, 2 or 3`);
  const suffix = str(o, 'suffix', { optional: true, max: 8, path }) ?? '';
  return { format, decimals, suffix };
}
// The widest value label must fit its slot; when it does not, the chart uses compact values (12.3k).
function fitFormatter(f, values, slotPx, fs = 12) {
  const full = formatter(f, { values });
  const widest = Math.max(...values.map(v => full(v).length)) * fs * 0.6;
  return widest <= slotPx ? full : formatter(f, { compact: true, values });
}

// ---------- freshness: the date of the newest data behind a block ----------
// `data_through` is YYYY-MM-DD. The line says it in words; more than STALE_DAYS before today it turns into a
// warning, so a report drawn from a source that stopped never looks current.
export const STALE_DAYS = 30;
let TODAY = null;                                   // set by renderBlock; tests and fixtures pass a fixed day
function dataThrough(b, optional) {
  const v = b.data_through;
  if (v == null) { if (optional) return ''; fail('data_through is required: the date (YYYY-MM-DD) of the newest row behind this chart, from the query itself (max of its date column)'); }
  const t = /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? Date.parse(v + 'T00:00:00Z') : NaN;
  if (Number.isNaN(t)) fail(`data_through "${v}" must be a date as YYYY-MM-DD`);
  const days = Math.floor((TODAY - t) / 86400000);
  if (days < -1) fail(`data_through ${v} is in the future`);
  const when = new Date(t).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return days > STALE_DAYS
    ? `<p class="through stale"><span aria-hidden="true">!</span> Data ends ${when}, ${days} days ago</p>`
    : `<p class="through">Data through ${when}</p>`;
}

// ---------- inline text: escaped, with **bold** ----------
const inline = s => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

// ---------- blocks ----------
function heading(b) {
  known(b, ['kind', 'text', 'level'], 'heading');
  const level = b.level ?? 2;
  if (level !== 1 && level !== 2) fail('heading.level must be 1 or 2');
  return `<section class="block heading"><h${level + 1}>${inline(str(b, 'text', { max: 70 }))}</h${level + 1}></section>`;
}

function kpi(b) {
  known(b, ['kind', 'items'], 'kpi');
  const items = list(b, 'items', { max: 4, hint: 'Keep the 4 numbers that matter most.' });
  const wide = i => items.length === 1 || (items.length === 3 && i === 0);
  const cells = items.map((it, i) => {
    const path = `items[${i}].`;
    if (!isObj(it)) fail(`${path} must be an object`);
    known(it, ['label', 'value', 'format', 'decimals', 'suffix', 'delta', 'delta_format', 'delta_label', 'good_when', 'spark'], `kpi item ${i}`);
    const label = str(it, 'label', { max: 28, path }), value = num(it, 'value', { path });
    const f = fmtFields(it, path), text = formatter(f, { compact: Math.abs(value) >= 1e6 })(value);
    let delta = '';
    if (it.delta != null) {
      const dv = num(it, 'delta', { path });
      const df = oneOf(it, 'delta_format', FORMATS, { optional: true, path }) ?? 'percent';
      const good = oneOf(it, 'good_when', ['up', 'down', 'none'], { optional: true, path }) ?? 'none';
      const tone = dv === 0 || good === 'none' ? 'flat' : (dv > 0) === (good === 'up') ? 'good' : 'bad';
      const dl = str(it, 'delta_label', { optional: true, max: 24, path });
      const body = formatter({ ...f, format: df, suffix: df === f.format ? f.suffix : '' })(Math.abs(dv));
      delta = `<p class="delta ${tone}"><span class="arrow" aria-hidden="true">${dv > 0 ? '▲' : dv < 0 ? '▼' : '•'}</span>` +
        `<span class="sr">${dv > 0 ? 'up' : dv < 0 ? 'down' : 'no change'} </span>${esc(body)}${dl ? ` <span class="vs">${esc(dl)}</span>` : ''}</p>`;
    }
    let spark = '';
    if (it.spark != null) {
      const sv = list(it, 'spark', { min: 3, max: 60, path });
      sv.forEach((v, j) => { if (!C.fin(v)) fail(`${path}spark[${j}] must be a number`); });
      spark = `<div class="spark" aria-hidden="true">${C.sparkline({ values: sv, width: 150, height: 30, color: 'var(--accent)' })}</div>`;
    }
    return `<div class="kpi-cell${wide(i) ? ' wide' : ''}${spark ? ' has-spark' : ''}"><p class="kpi-label">${esc(label)}</p><p class="kpi-value">${esc(text)}</p>${delta}${spark}</div>`;
  });
  return `<section class="block kpi n${cells.length}">${cells.join('')}</section>`;
}

function insight(b) {
  known(b, ['kind', 'text', 'title', 'tone', 'basis'], 'insight');
  const tone = oneOf(b, 'tone', ['neutral', 'good', 'bad', 'warn'], { optional: true }) ?? 'neutral';
  const title = str(b, 'title', { optional: true, max: 70 }), basis = str(b, 'basis', { optional: true, max: 160 });
  const glyph = { neutral: 'M12 3l2.2 5.4L20 9.3l-4.3 3.9 1.3 5.8L12 16l-5 3 1.3-5.8L4 9.3l5.8-.9z', good: 'M5 12.5l4.5 4.5L19 7.5', bad: 'M12 5v9m0 4h.01', warn: 'M12 5v9m0 4h.01' }[tone];
  return `<section class="block insight ${tone}"><div class="tile" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="${tone === 'neutral' ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="${tone === 'neutral' ? 0 : 2.6}" stroke-linecap="round" stroke-linejoin="round"><path d="${glyph}"/></svg></div>` +
    `<div class="body">${title ? `<h4>${inline(title)}</h4>` : ''}<p>${inline(str(b, 'text', { max: 420 }))}</p>${basis ? `<p class="basis">${esc(basis)}</p>` : ''}</div></section>`;
}

function table(b) {
  known(b, ['kind', 'title', 'columns', 'rows', 'data_through'], 'table');
  const cols = list(b, 'columns', { max: 8, hint: 'Keep the 8 columns that matter most.' }).map((c, i) => {
    if (!isObj(c)) fail(`columns[${i}] must be an object {name, format?}`);
    known(c, ['name', 'format', 'decimals', 'suffix'], `table column ${i}`);
    return { name: str(c, 'name', { max: 18, path: `columns[${i}].` }), numeric: c.format != null, f: c.format != null ? formatter(fmtFields(c, `columns[${i}].`)) : null };
  });
  const rows = list(b, 'rows', { max: 20, hint: 'Show the top rows and say how many remain in an insight.' });
  const body = rows.map((r, i) => {
    if (!Array.isArray(r) || r.length !== cols.length) fail(`rows[${i}] must be a list of ${cols.length} values, one per column`);
    return '<tr>' + r.map((v, j) => {
      if (cols[j].numeric) { if (!C.fin(v)) fail(`rows[${i}][${j}] must be a number for the ${cols[j].name} column`); return `<td class="n">${esc(cols[j].f(v))}</td>`; }
      if (typeof v !== 'string' && !C.fin(v)) fail(`rows[${i}][${j}] must be text or a number`);
      if (String(v).length > 40) fail(`rows[${i}][${j}] has more than 40 characters`);
      return `<td>${esc(v)}</td>`;
    }).join('') + '</tr>';
  }).join('');
  const title = str(b, 'title', { optional: true, max: 60 });
  return `<section class="block table">${title ? `<h3>${inline(title)}</h3>` : ''}<table><thead><tr>` +
    cols.map(c => `<th${c.numeric ? ' class="n"' : ''}>${esc(c.name)}</th>`).join('') + `</tr></thead><tbody>${body}</tbody></table>${dataThrough(b, true)}</section>`;
}

// ---------- charts ----------
const labelled = (arr, name, { maxLabel = 24, signed = true, positive = false } = {}) => arr.map((d, i) => {
  if (!isObj(d)) fail(`${name}[${i}] must be an object`);
  const label = str(d, 'label', { max: maxLabel, path: `${name}[${i}].` }), value = num(d, 'value', { path: `${name}[${i}].` });
  if (!signed && value < 0) fail(`${name}[${i}].value is negative. This chart shows amounts of zero or more; use the diverging chart for changes.`);
  if (positive && value <= 0) fail(`${name}[${i}].value must be above zero`);
  return { label, value };
});
const annotations = (b, n, series = 1) => (b.annotations ?? []).map((a, i) => {
  if (!isObj(a)) fail(`annotations[${i}] must be an object {index, text}`);
  if (!Number.isInteger(a.index) || a.index < 0 || a.index >= n) fail(`annotations[${i}].index must be a position from 0 to ${n - 1}`);
  if (a.series != null && (!Number.isInteger(a.series) || a.series < 0 || a.series >= series)) fail(`annotations[${i}].series must be from 0 to ${series - 1}`);
  return { index: a.index, series: a.series ?? 0, text: str(a, 'text', { max: 22, path: `annotations[${i}].` }) };
});

const BUILD = {
  line(b, f, area = false) {
    const labels = list(b, 'labels', { min: 2, max: 90 }).map((x, i) => (typeof x === 'string' || C.fin(x)) ? String(x) : fail(`labels[${i}] must be text`));
    if (new Set(labels).size !== labels.length) fail('labels must be unique (one per x position)');
    const series = list(b, 'series', { max: 4, hint: 'More than 4 lines cannot be read on a phone; keep the top 3 and group the others.' }).map((s, i) => {
      if (!isObj(s)) fail(`series[${i}] must be an object {name, values}`);
      const values = list(s, 'values', { min: labels.length, max: labels.length, path: `series[${i}].` });
      values.forEach((v, j) => { if (v != null && !C.fin(v)) fail(`series[${i}].values[${j}] must be a number or null`); });
      if (values.some(v => v != null && v < 0)) fail(`series[${i}] has negative values; the line chart starts at zero. Use the diverging chart for signed change.`);
      return { name: str(s, 'name', { max: 22, path: `series[${i}].` }), points: labels.map((x, j) => ({ x, y: values[j] })).filter(p => p.y != null) };
    });
    const all = series.flatMap(s => s.points.map(p => p.y)), target = num(b, 'target', { optional: true });
    return C.lineChart({ labels, series, width: WIDTH, height: 240, fmtY: fitFormatter(f, all.concat(target ?? []), 44), area,
      target, legend: series.length > 1, valueLabels: labels.length <= 8 && series.length === 1,
      annotations: annotations(b, labels.length, series.length), label: b.title });
  },
  area(b, f) { return BUILD.line(b, f, true); },
  bar(b, f) {
    const data = labelled(list(b, 'data', { min: 2, max: 7, hint: 'Use chart "hbar" for more categories or long labels, or "line" for a time series.' }), 'data', { maxLabel: 14, signed: false });
    const slot = (WIDTH - 68) / data.length, target = num(b, 'target', { optional: true });
    const wide = data.find(d => d.label.length * 7.2 > slot + 6);
    if (wide) fail(`data label "${wide.label}" is too wide for ${data.length} bars. Shorten the labels (about ${Math.max(2, Math.floor(slot / 7.2))} characters) or use chart "hbar".`);
    data.forEach(d => { d.color = 'var(--chart-1)'; });
    return C.barChart({ data, width: WIDTH, height: 230, fmtY: fitFormatter(f, data.map(d => d.value), slot - 2), target, annotations: annotations(b, data.length), label: b.title });
  },
  hbar(b, f) {
    const data = labelled(list(b, 'data', { min: 2, max: 12, hint: 'Keep the top 10 and add one "Other" row.' }), 'data', { maxLabel: 40, signed: false });
    const highlight = b.highlight == null ? null : list(b, 'highlight', { min: 1, max: data.length });
    if (highlight) highlight.forEach(i => { if (!Number.isInteger(i) || i < 0 || i >= data.length) fail(`highlight holds ${JSON.stringify(i)}; it must be row positions from 0 to ${data.length - 1}`); });
    return C.hbarChart({ data, width: WIDTH, rowHeight: 30, fmtY: fitFormatter(f, data.map(d => d.value), 60), highlight, label: b.title });
  },
  waterfall(b, f) {
    const items = list(b, 'items', { min: 3, max: 7, hint: 'Group the small steps into one "Other" step.' }).map((d, i) => {
      if (!isObj(d)) fail(`items[${i}] must be an object {label, value, total?}`);
      return { label: str(d, 'label', { max: 16, path: `items[${i}].` }), value: num(d, 'value', { path: `items[${i}].` }), total: d.total === true };
    });
    if (!items[0].total) fail('items[0] must be a total bar ({"total": true}): the start value of the bridge');
    if (!items[items.length - 1].total) fail('the last item must be a total bar ({"total": true}): the end value of the bridge');
    let run = 0;
    items.forEach((it, i) => {
      if (it.total) { if (i > 0 && Math.abs(run - it.value) > Math.max(0.5, Math.abs(it.value) * 0.005)) fail(`items[${i}] is a total of ${it.value}, but the steps before it sum to ${+run.toFixed(2)}. The bridge must reconcile.`); run = it.value; }
      else run += it.value;
      if (run < 0) fail(`the running total goes below zero at items[${i}]; this chart cannot show that. Use the diverging chart.`);
    });
    const slot = (WIDTH - 64) / items.length;
    const levels = []; let lv = 0; items.forEach(it => { lv = it.total ? it.value : lv + it.value; levels.push(lv); });
    const zoom = Math.min(...levels) > 0.5 * Math.max(...levels);
    return C.waterfall({ items, zoom, width: WIDTH, height: 250, fmtY: fitFormatter(f, items.map(d => Math.abs(d.value)), slot - 8, 11), annotations: annotations(b, items.length), label: b.title });
  },
  diverging(b, f) {
    const data = labelled(list(b, 'data', { min: 2, max: 10, hint: 'Keep the largest changes and group the others.' }), 'data', { maxLabel: 28 });
    if (!data.some(d => d.value < 0) || !data.some(d => d.value > 0)) fail('the diverging chart needs both positive and negative values; use "bar" or "hbar" for one-sided data');
    return C.hbarChart({ data, diverging: true, width: WIDTH, rowHeight: 30, fmtY: fitFormatter(f, data.map(d => Math.abs(d.value)), 56), label: b.title });
  },
  dumbbell(b, f) {
    const rows = list(b, 'rows', { min: 2, max: 8 }).map((r, i) => {
      if (!isObj(r)) fail(`rows[${i}] must be an object {label, a, b}`);
      return { label: str(r, 'label', { max: 18, path: `rows[${i}].` }), a: num(r, 'a', { path: `rows[${i}].` }), b: num(r, 'b', { path: `rows[${i}].` }) };
    });
    return C.dumbbell({ rows, width: WIDTH, aLabel: str(b, 'a_label', { max: 16 }), bLabel: str(b, 'b_label', { max: 16 }), legend: true,
      colors: Object.fromEntries(rows.map(r => [r.label, 'var(--chart-1)'])), fmtY: fitFormatter(f, rows.flatMap(r => [r.a, r.b]), 40), label: b.title });
  },
  stacked(b, f) {
    const keys = list(b, 'keys', { min: 2, max: 5, hint: 'Keep the 4 largest parts and one "Other".' }).map((k, i) => typeof k === 'string' && k.length <= 18 ? k : fail(`keys[${i}] must be text of 18 characters or less`));
    const columns = list(b, 'columns', { min: 2, max: 8 }).map((c, i) => {
      if (!isObj(c) || !isObj(c.parts)) fail(`columns[${i}] must be an object {label, parts: {key: value}}`);
      for (const k of Object.keys(c.parts)) { if (!keys.includes(k)) fail(`columns[${i}].parts has "${k}", which is not in keys`); if (!C.fin(c.parts[k]) || c.parts[k] < 0) fail(`columns[${i}].parts.${k} must be a number of zero or more`); }
      return { label: str(c, 'label', { max: 8, path: `columns[${i}].` }), parts: c.parts };
    });
    return C.stackedBars({ columns, keys, colors: {}, width: WIDTH, height: 250, legend: true, label: b.title });
  },
  donut(b, f) {
    const slices = labelled(list(b, 'slices', { min: 2, max: 6, hint: 'Keep the 5 largest and one "Other".' }), 'slices', { maxLabel: 20, positive: true });
    return C.donut({ slices, width: WIDTH, height: 190, fmtY: formatter(f, { compact: true, values: slices.map(d => d.value) }), centerLabel: str(b, 'center_label', { optional: true, max: 12 }) ?? undefined, label: b.title });
  },
  heatmap(b, f) {
    const names = (k, max, m) => list(b, k, { max }).map((x, i) => (typeof x === 'string' || C.fin(x)) && String(x).length <= m ? String(x) : fail(`${k}[${i}] must be text of ${m} characters or less`));
    const rows = names('rows', 12, 14), cols = names('cols', 31, 6);
    const cells = list(b, 'cells', { max: rows.length * cols.length }).map((c, i) => {
      if (!isObj(c)) fail(`cells[${i}] must be an object {row, col, value}`);
      if (!rows.includes(String(c.row))) fail(`cells[${i}].row "${c.row}" is not in rows`);
      if (!cols.includes(String(c.col))) fail(`cells[${i}].col "${c.col}" is not in cols`);
      return { row: String(c.row), col: String(c.col), value: num(c, 'value', { path: `cells[${i}].` }) };
    });
    return C.heatmap({ rows, cols, cells, width: WIDTH, fmtY: formatter(f, { compact: true, values: cells.map(c => c.value) }), label: b.title });
  },
  scatter(b, f) {
    const xf = isObj(b.x) ? b.x : {}, groups = list(b, 'groups', { max: 6 }).map((g, i) => {
      if (!isObj(g)) fail(`groups[${i}] must be an object {name, points}`);
      const points = list(g, 'points', { min: 1, max: 300, path: `groups[${i}].` }).map((p, j) => {
        if (!isObj(p)) fail(`groups[${i}].points[${j}] must be an object {x, y}`);
        const x = num(p, 'x', { path: `groups[${i}].points[${j}].` }), y = num(p, 'y', { path: `groups[${i}].points[${j}].` });
        if (x < 0 || y < 0) fail(`groups[${i}].points[${j}] is negative; the scatter axes start at zero`);
        return { x, y, tip: p.label != null ? String(p.label).slice(0, 60) : undefined };
      });
      const out = { name: str(g, 'name', { max: 40, path: `groups[${i}].` }), points };
      if (b.trend === true) {                       // least-squares line, drawn over the x range of the group
        const n = points.length, mx = points.reduce((a, p) => a + p.x, 0) / n, my = points.reduce((a, p) => a + p.y, 0) / n;
        const sxx = points.reduce((a, p) => a + (p.x - mx) ** 2, 0), sxy = points.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0);
        if (sxx > 0) { const k = sxy / sxx, c = my - k * mx; out.line = { from: Math.min(...points.map(p => p.x)), to: Math.max(...points.map(p => p.x)), fn: x => Math.max(0, k * x + c) }; }
      }
      return out;
    });
    const all = groups.flatMap(g => g.points);
    return C.scatter({ groups, width: WIDTH, height: 270, xLabel: str(b, 'x_label', { max: 26 }), yLabel: str(b, 'y_label', { max: 26 }),
      fmtX: fitFormatter(fmtFields(xf, 'x.'), all.map(p => p.x), 44), fmtY: fitFormatter(f, all.map(p => p.y), 44), legend: groups.length > 1, label: b.title });
  },
  grouped(b, f) {
    const categories = list(b, 'categories', { min: 2, max: 6, hint: 'Use "line" for a longer time series.' }).map((c, i) => typeof c === 'string' && c.length <= 9 ? c : fail(`categories[${i}] must be text of 9 characters or less`));
    const series = seriesOf(b, categories.length, { min: 2, max: 3, hint: 'Three series per category is the limit on a phone.' });
    return C.groupedBars({ categories, series, width: WIDTH, height: 240, fmtY: fitFormatter(f, series.flatMap(s => s.values.filter(v => v != null)), 40, 10), label: b.title });
  },
  stacked_area(b, f) {
    const labels = list(b, 'labels', { min: 3, max: 90 }).map((x, i) => (typeof x === 'string' || C.fin(x)) ? String(x) : fail(`labels[${i}] must be text`));
    const series = seriesOf(b, labels.length, { min: 2, max: 5, hint: 'Keep the 4 largest parts and one "Other".' });
    const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
    return C.stackedArea({ labels, series, width: WIDTH, height: 250, fmtY: fitFormatter(f, totals, 44), label: b.title });
  },
  slope(b, f) {
    const rows = list(b, 'rows', { min: 2, max: 8 }).map((r, i) => {
      if (!isObj(r)) fail(`rows[${i}] must be an object {label, a, b}`);
      return { label: str(r, 'label', { max: 16, path: `rows[${i}].` }), a: num(r, 'a', { path: `rows[${i}].` }), b: num(r, 'b', { path: `rows[${i}].` }) };
    });
    return C.slope({ rows, width: WIDTH, height: Math.max(220, 90 + rows.length * 26), aLabel: str(b, 'a_label', { max: 14 }), bLabel: str(b, 'b_label', { max: 14 }),
      fmtY: formatter(f, { compact: true, values: rows.flatMap(r => [r.a, r.b]) }), label: b.title });
  },
  bullet(b, f) {
    const rows = list(b, 'rows', { max: 8 }).map((r, i) => {
      if (!isObj(r)) fail(`rows[${i}] must be an object {label, value, target}`);
      const value = num(r, 'value', { path: `rows[${i}].` }), target = num(r, 'target', { path: `rows[${i}].` });
      if (value < 0 || target <= 0) fail(`rows[${i}] needs a value of zero or more and a target above zero`);
      return { label: str(r, 'label', { max: 28, path: `rows[${i}].` }), value, target };
    });
    const over = oneOf(b, 'over_is', ['good', 'bad', 'neutral'], { optional: true }) ?? 'neutral';
    return C.bullet({ rows, width: WIDTH, overColor: over === 'bad' ? 'var(--bad)' : over === 'good' ? 'var(--good)' : null,
      fmtY: formatter(f, { compact: true, values: rows.flatMap(r => [r.value, r.target]) }), label: b.title });
  },
  histogram(b, f) {
    const fmtX = vals => formatter(f, { compact: true, values: vals });
    const mark = b.mark == null ? null : (isObj(b.mark) ? { value: num(b.mark, 'value', { path: 'mark.' }), text: str(b.mark, 'text', { max: 20, path: 'mark.' }) } : fail('mark must be an object {value, text}'));
    if (Array.isArray(b.bins)) {
      const bins = list(b, 'bins', { min: 3, max: 24 }).map((c, i) => {
        if (!isObj(c)) fail(`bins[${i}] must be an object {from, to, count}`);
        const from = num(c, 'from', { path: `bins[${i}].` }), to = num(c, 'to', { path: `bins[${i}].` }), count = num(c, 'count', { path: `bins[${i}].` });
        if (to <= from || count < 0) fail(`bins[${i}] needs from < to and a count of zero or more`);
        return { from, to, count };
      });
      bins.forEach((c, i) => { if (i && Math.abs(c.from - bins[i - 1].to) > 1e-9) fail(`bins[${i}].from must equal bins[${i - 1}].to (bins touch, in order)`); });
      return C.histogram({ bins, width: WIDTH, height: 230, fmtX: fmtX(bins.flatMap(c => [c.from, c.to])), fmtY: formatter({ format: 'integer' }, { compact: true }), mark, label: b.title });
    }
    const values = list(b, 'values', { min: 8, max: 5000, hint: 'Send the bins instead: "bins": [{"from", "to", "count"}] from a SQL width_bucket.' });
    values.forEach((v, i) => { if (!C.fin(v)) fail(`values[${i}] must be a number`); });
    const n = b.bins == null ? 10 : num(b, 'bins');
    if (!Number.isInteger(n) || n < 4 || n > 20) fail('bins must be a whole number from 4 to 20, or a list of bins');
    return C.histogram({ values, bins: n, width: WIDTH, height: 230, fmtX: fmtX(values), fmtY: formatter({ format: 'integer' }, { compact: true }), mark, label: b.title });
  },
  boxplot(b, f) {
    const all = [], groups = list(b, 'groups', { max: 8 }).map((g, i) => {
      if (!isObj(g)) fail(`groups[${i}] must be an object {label, values} or {label, min, q1, median, q3, max}`);
      const label = str(g, 'label', { max: 18, path: `groups[${i}].` });
      if (Array.isArray(g.values)) {
        const values = list(g, 'values', { min: 5, max: 5000, path: `groups[${i}].` });
        values.forEach((v, j) => { if (!C.fin(v)) fail(`groups[${i}].values[${j}] must be a number`); });
        all.push(...values); return { label, values };
      }
      const five = ['min', 'q1', 'median', 'q3', 'max'].map(k => num(g, k, { path: `groups[${i}].` }));
      if (five.some((v, k) => k && v < five[k - 1])) fail(`groups[${i}] needs min <= q1 <= median <= q3 <= max`);
      all.push(...five); return { label, min: five[0], q1: five[1], median: five[2], q3: five[3], max: five[4] };
    });
    return C.boxPlot({ groups, width: WIDTH, fmtY: formatter(f, { compact: true, values: all }), label: b.title });
  },
  calendar(b, f) {
    const days = list(b, 'days', { min: 14, max: 400, hint: 'One year of days is the limit.' }).map((d, i) => {
      if (!isObj(d) || !/^\d{4}-\d{2}-\d{2}$/.test(String(d.date))) fail(`days[${i}] must be an object {date: "YYYY-MM-DD", value}`);
      return { date: d.date, value: d.value == null ? null : num(d, 'value', { path: `days[${i}].` }) };
    });
    const span = (Date.parse(days.reduce((a, d) => d.date > a ? d.date : a, '0') + 'T00:00:00Z') - Date.parse(days.reduce((a, d) => d.date < a ? d.date : a, '9') + 'T00:00:00Z')) / 86400000;
    if (span > 380) fail('the days cover more than one year; a phone shows 53 weeks at most');
    return C.calendar({ days, width: WIDTH, fmtY: formatter(f, { compact: true, values: days.map(d => d.value) }), label: b.title });
  },
  treemap(b, f) {
    const items = labelled(list(b, 'items', { min: 3, max: 14, hint: 'Group the small parts into one "Other".' }), 'items', { maxLabel: 24, positive: true });
    return C.treemap({ items, width: WIDTH, height: 250, fmtY: formatter(f, { compact: true, values: items.map(d => d.value) }), label: b.title });
  },
  funnel(b, f) {
    const stages = labelled(list(b, 'stages', { min: 2, max: 7 }), 'stages', { maxLabel: 28, signed: false });
    return C.funnel({ stages, width: WIDTH, fmtY: formatter(f, { compact: true, values: stages.map(d => d.value) }), label: b.title });
  },
  sankey(b, f) {
    const flows = list(b, 'flows', { min: 2, max: 24 }).map((x, i) => {
      if (!isObj(x)) fail(`flows[${i}] must be an object {from, to, value}`);
      const value = num(x, 'value', { path: `flows[${i}].` });
      if (value <= 0) fail(`flows[${i}].value must be above zero`);
      return { from: str(x, 'from', { max: 18, path: `flows[${i}].` }), to: str(x, 'to', { max: 18, path: `flows[${i}].` }), value };
    });
    const left = new Set(flows.map(x => x.from)), right = new Set(flows.map(x => x.to));
    if (left.size > 6 || right.size > 7) fail(`the sankey has ${left.size} sources and ${right.size} targets; the limit is 6 and 7. Group the small ones into "Other".`);
    const sums = [...left].map(n => flows.filter(x => x.from === n).reduce((a, x) => a + x.value, 0));
    return C.sankey({ flows, width: WIDTH, height: 300, fmtY: formatter(f, { compact: true, values: sums }), label: b.title });
  },
  gauge(b, f) {
    const value = num(b, 'value'), max = num(b, 'max'), target = num(b, 'target', { optional: true });
    if (value < 0 || max <= 0) fail('the gauge needs a value of zero or more and a max above zero');
    if (target != null && (target < 0 || target > max)) fail('target must lie between 0 and max');
    return C.gauge({ value, max, target, caption: str(b, 'caption', { optional: true, max: 28 }) ?? undefined, width: WIDTH, height: 200,
      fmtY: formatter(f, { compact: true, values: [value, max] }), label: b.title });
  },
  wordcloud(b, f) {
    const words = list(b, 'words', { min: 8, max: 60, hint: 'Keep the 60 heaviest words.' }).map((w, i) => {
      if (!isObj(w)) fail(`words[${i}] must be an object {text, value}`);
      const text = str(w, 'text', { max: 24, path: `words[${i}].` }), value = num(w, 'value', { path: `words[${i}].` });
      if (value <= 0) fail(`words[${i}].value must be above zero`);
      if (/\s/.test(text.trim()) && text.trim().split(/\s+/).length > 3) fail(`words[${i}].text is a phrase; a cloud takes words or short names (3 words at most)`);
      return { text: text.trim(), value };
    });
    if (new Set(words.map(w => w.text.toLowerCase())).size !== words.length) fail('words must be unique: add up the counts of the same word (ignore case) before you send them');
    // The cloud adapts to the words instead of refusing them: taller and smaller type until at most a tenth
    // is left out. What still does not fit is said under the cloud, never dropped in silence.
    const fmt = formatter(f, { compact: true, values: words.map(w => w.value) });
    let svg = '', omitted = words.length;
    for (const [height, minSize, maxSize] of [[260, 12, 38], [300, 12, 32], [340, 11, 28], [380, 10, 24], [420, 10, 20]]) {
      svg = C.wordCloud({ words, width: WIDTH, height, minSize, maxSize, fmtY: fmt, label: b.title });
      omitted = +(svg.match(/data-omitted="(\d+)"/) || [0, 0])[1];
      if (omitted <= words.length * 0.1) break;
    }
    if (omitted > words.length * 0.3) fail(`${omitted} of the ${words.length} words do not fit on a phone even at the smallest size. Send about ${Math.max(8, words.length - omitted)} words, or shorter ones, and send the block again as a wordcloud.`);
    return svg + (omitted ? `<p class="through">${omitted} lighter word${omitted > 1 ? 's' : ''} did not fit</p>` : '');
  },
  pareto(b, f) {
    const data = labelled(list(b, 'data', { min: 3, max: 9, hint: 'Keep the top 8 and one "Other".' }), 'data', { maxLabel: 12, signed: false });
    return C.pareto({ data, width: WIDTH, height: 250, fmtY: fitFormatter(f, data.map(d => d.value), 44), label: b.title });
  },
  combo(b, f) {
    const labels = list(b, 'labels', { min: 2, max: 24, hint: 'Group the periods (months, not days).' }).map((x, i) => (typeof x === 'string' || C.fin(x)) ? String(x) : fail(`labels[${i}] must be text`));
    const one = k => {
      if (!isObj(b[k])) fail(`${k} must be an object {name, values}`);
      const values = list(b[k], 'values', { min: labels.length, max: labels.length, path: `${k}.` });
      values.forEach((v, j) => { if (v != null && (!C.fin(v) || v < 0)) fail(`${k}.values[${j}] must be a number of zero or more, or null`); });
      return { name: str(b[k], 'name', { max: 22, path: `${k}.` }), values };
    };
    const bars = one('bars'), line = one('line'), lf = isObj(b.line_axis) ? fmtFields(b.line_axis, 'line_axis.') : { format: 'number', decimals: null, suffix: '' };
    return C.comboChart({ labels, bars, line, width: WIDTH, height: 250, fmtY: fitFormatter(f, bars.values.filter(v => v != null), 44),
      fmtY2: formatter(lf, { compact: true, values: line.values.filter(v => v != null) }), label: b.title });
  },
  small_multiples(b, f) {
    const labels = list(b, 'labels', { min: 3, max: 90 }).map((x, i) => (typeof x === 'string' || C.fin(x)) ? String(x) : fail(`labels[${i}] must be text`));
    const series = seriesOf(b, labels.length, { min: 2, max: 9, hint: 'Keep the 8 largest and one "Other".' });
    return C.smallMultiples({ labels, series, width: WIDTH, fmtY: formatter(f, { compact: true, values: series.flatMap(s => s.values.filter(v => v != null)) }), label: b.title });
  },
  bump(b, f) {
    const labels = list(b, 'labels', { min: 2, max: 24 }).map((x, i) => (typeof x === 'string' || C.fin(x)) ? String(x) : fail(`labels[${i}] must be text`));
    const series = seriesOf(b, labels.length, { min: 2, max: 8, hint: 'Keep the 8 items that lead at the end.' });
    return C.bump({ labels, series, width: WIDTH, fmtY: formatter(f, { compact: true, values: series.flatMap(s => s.values.filter(v => v != null)) }), label: b.title });
  },
  bubbles(b, f) {
    const items = labelled(list(b, 'items', { min: 3, max: 24, hint: 'Keep the 23 largest and one "Other".' }), 'items', { maxLabel: 24, positive: true });
    return C.bubbles({ items, width: WIDTH, height: 270, fmtY: formatter(f, { compact: true, values: items.map(d => d.value) }), label: b.title });
  },
  gantt(b) {
    const date = (r, k, i) => /^\d{4}-\d{2}-\d{2}$/.test(String(r[k])) && !Number.isNaN(Date.parse(r[k] + 'T00:00:00Z')) ? String(r[k]) : fail(`rows[${i}].${k} must be a date as YYYY-MM-DD`);
    const rows = list(b, 'rows', { min: 2, max: 14, hint: 'Keep the 14 rows that matter most.' }).map((r, i) => {
      if (!isObj(r)) fail(`rows[${i}] must be an object {label, start, end, group?}`);
      const out = { label: str(r, 'label', { max: 28, path: `rows[${i}].` }), start: date(r, 'start', i), end: date(r, 'end', i) };
      if (out.end < out.start) fail(`rows[${i}] ends before it starts`);
      if (r.group != null) out.group = str(r, 'group', { max: 18, path: `rows[${i}].` });
      return out;
    });
    if (new Set(rows.map(r => r.group).filter(x => x != null)).size > 5) fail('the gantt has more than 5 groups; the colours cannot be told apart. Use 5 groups at most.');
    return C.gantt({ rows, width: WIDTH, today: TODAY != null ? new Date(TODAY).toISOString().slice(0, 10) : null, label: b.title });
  },
  strip(b, f) {
    const groups = new Map();
    list(b, 'points', { min: 5, max: 400, hint: 'Sample the rows, or use a boxplot.' }).forEach((p, i) => {
      if (!isObj(p)) fail(`points[${i}] must be an object {label, value, name?}`);
      const label = str(p, 'label', { max: 22, path: `points[${i}].` }), value = num(p, 'value', { path: `points[${i}].` });
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push({ value, name: p.name != null ? String(p.name).slice(0, 40) : undefined });
    });
    if (groups.size > 8) fail(`the strip plot has ${groups.size} categories; the limit is 8. Group the small ones.`);
    return C.strip({ groups: [...groups].map(([label, points]) => ({ label, points })), width: WIDTH,
      fmtY: formatter(f, { compact: true, values: [...groups.values()].flat().map(p => p.value) }), label: b.title });
  },
};

// series: [{ name, values: [one per x position] }] with values of zero or more (null = missing).
function seriesOf(b, n, { min, max, hint }) {
  return list(b, 'series', { min, max, hint }).map((s, i) => {
    if (!isObj(s)) fail(`series[${i}] must be an object {name, values}`);
    const values = list(s, 'values', { min: n, max: n, path: `series[${i}].` });
    values.forEach((v, j) => { if (v != null && (!C.fin(v) || v < 0)) fail(`series[${i}].values[${j}] must be a number of zero or more, or null`); });
    return { name: str(s, 'name', { max: 18, path: `series[${i}].` }), values };
  });
}

const CHART_FIELDS = {
  grouped: ['categories', 'series'], stacked_area: ['labels', 'series'], slope: ['rows', 'a_label', 'b_label', 'up_is'],
  bullet: ['rows', 'over_is'], histogram: ['values', 'bins', 'mark'], boxplot: ['groups'], calendar: ['days'], treemap: ['items'],
  funnel: ['stages'], sankey: ['flows'], gauge: ['value', 'max', 'target', 'caption'], pareto: ['data'], wordcloud: ['words'],
  line: ['labels', 'series', 'target', 'annotations'], area: ['labels', 'series', 'target', 'annotations'],
  bar: ['data', 'target', 'annotations'], hbar: ['data', 'highlight'], waterfall: ['items', 'annotations', 'up_is'],
  diverging: ['data', 'up_is'], dumbbell: ['rows', 'a_label', 'b_label'], stacked: ['columns', 'keys'],
  donut: ['slices', 'center_label'], heatmap: ['rows', 'cols', 'cells'], scatter: ['groups', 'x_label', 'y_label', 'x', 'trend'],
  combo: ['labels', 'bars', 'line', 'line_axis'], small_multiples: ['labels', 'series'], bump: ['labels', 'series'], bubbles: ['items'],
  gantt: ['rows'], strip: ['points'],
};

function chart(b) {
  const type = oneOf(b, 'chart', CHARTS);
  known(b, ['kind', 'chart', 'title', 'takeaway', 'unit', 'source', 'sql', 'repeat_reason', 'data_through', 'format', 'decimals', 'suffix', ...CHART_FIELDS[type]], `chart "${type}"`);
  const title = str(b, 'title', { max: 64 }), takeaway = str(b, 'takeaway', { max: 160 });
  const source = str(b, 'source', { max: 160 }), unit = str(b, 'unit', { optional: true, max: 24 });
  const through = dataThrough(b, false);
  const upIs = oneOf(b, 'up_is', ['good', 'bad', 'neutral'], { optional: true }) ?? 'neutral';
  let svg;
  try { svg = BUILD[type](b, fmtFields(b)); }
  catch (e) { if (e instanceof RangeError) fail(e.message); throw e; }
  if (svg.includes('>no data<')) fail('the chart has no data to draw');
  return `<section class="block chart" data-chart="${type}"><h3>${inline(title)}${unit ? ` <span class="unit">${esc(unit)}</span>` : ''}</h3>` +
    `<p class="takeaway">${inline(takeaway)}</p><div class="plot up-${upIs}">${svg}</div><p class="source">${esc(source)}</p>${through}</section>`;
}

// ---------- map: places and a route on a real street map (drawn by the page, interactive) ----------
// The block carries its data in data-map; the shell page builds the map (Leaflet) when the block arrives.
function map(b) {
  known(b, ['kind', 'title', 'takeaway', 'source', 'sql', 'data_through', 'format', 'decimals', 'suffix', 'points', 'path', 'value_label'], 'map');
  const title = str(b, 'title', { max: 64 }), takeaway = str(b, 'takeaway', { max: 160 }), source = str(b, 'source', { max: 160 });
  const f = fmtFields(b), raw = b.points == null ? [] : list(b, 'points', { min: 0, max: 150, hint: 'Group nearby points (round the coordinates) and keep the 150 that matter most.' });
  const coord = (o, path) => {
    const lat = num(o, 'lat', { path }), lng = num(o, 'lng', { path });
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) fail(`${path} is not a coordinate (lat -90 to 90, lng -180 to 180)`);
    return [+lat.toFixed(5), +lng.toFixed(5)];
  };
  const values = raw.filter(p => isObj(p) && C.fin(p.value)).map(p => p.value), fmt = formatter(f, { compact: true, values });
  const points = raw.map((p, i) => {
    if (!isObj(p)) fail(`points[${i}] must be an object {lat, lng, label, value?}`);
    const value = num(p, 'value', { optional: true, path: `points[${i}].` });
    if (value != null && value < 0) fail(`points[${i}].value must be zero or more`);
    return { at: coord(p, `points[${i}].`), label: str(p, 'label', { max: 40, path: `points[${i}].` }), value,
      text: value == null ? null : fmt(value), detail: str(p, 'detail', { optional: true, max: 80, path: `points[${i}].` }) };
  });
  const path = b.path == null ? [] : list(b, 'path', { min: 2, max: 1500, hint: 'Thin the route: one point per 5 minutes is enough.' }).map((p, i) => {
    if (Array.isArray(p) && p.length === 2) return coord({ lat: p[0], lng: p[1] }, `path[${i}] `);
    if (isObj(p)) return coord(p, `path[${i}].`);
    return fail(`path[${i}] must be [lat, lng]`);
  });
  if (!points.length && !path.length) fail('a map needs "points" (places) or "path" (a route), or both');
  const data = { points, path, valueLabel: str(b, 'value_label', { optional: true, max: 24 }) };
  // A list of the top places under the map: the map is the picture, the list carries the numbers for a reader
  // who does not touch the map (and for VoiceOver).
  const top = [...points].sort((x, y) => (y.value ?? 0) - (x.value ?? 0)).slice(0, 5).filter(p => p.value != null);
  const rows = top.map(p => `<li><span>${esc(p.label)}</span><b>${esc(p.text)}</b></li>`).join('');
  return `<section class="block chart map-block" data-chart="map"><h3>${inline(title)}</h3><p class="takeaway">${inline(takeaway)}</p>` +
    `<div class="map" role="img" aria-label="${esc(title)}: map with ${points.length} place${points.length === 1 ? '' : 's'}${path.length ? ' and a route' : ''}" data-map="${esc(JSON.stringify(data))}"></div>` +
    (rows ? `<ol class="map-top">${rows}</ol>` : '') + `<p class="source">${esc(source)}</p>${dataThrough(b, false)}</section>`;
}

// ---------- timeline: what happened when, one row per day (or per item), segments along the hours ----------
function timeline(b) {
  known(b, ['kind', 'title', 'takeaway', 'source', 'sql', 'data_through', 'rows', 'from_hour', 'to_hour'], 'timeline');
  const title = str(b, 'title', { max: 64 }), takeaway = str(b, 'takeaway', { max: 160 }), source = str(b, 'source', { max: 160 });
  const h0 = b.from_hour ?? 0, h1 = b.to_hour ?? 24;
  if (!Number.isInteger(h0) || !Number.isInteger(h1) || h0 < 0 || h1 > 24 || h1 - h0 < 2) fail('from_hour and to_hour must be whole hours from 0 to 24, at least 2 apart');
  const clock = (v, path) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? ''));
    if (!m || +m[1] > 24 || +m[2] > 59 || (+m[1] === 24 && +m[2] > 0)) fail(`${path} must be a time as HH:MM (00:00 to 24:00)`);
    return +m[1] + +m[2] / 60;
  };
  const rows = list(b, 'rows', { max: 14, hint: 'Show two weeks at most, or the days that matter.' }).map((r, i) => {
    if (!isObj(r)) fail(`rows[${i}] must be an object {label, segments}`);
    const segments = list(r, 'segments', { min: 0, max: 16, path: `rows[${i}].` }).map((sg, j) => {
      const path = `rows[${i}].segments[${j}].`;
      if (!isObj(sg)) fail(`${path} must be an object {from, to, label}`);
      const from = clock(sg.from, path + 'from'), to = clock(sg.to, path + 'to');
      if (to <= from) fail(`${path}to must be after from (split a segment that crosses midnight into two rows)`);
      return { from, to, label: str(sg, 'label', { max: 24, path }) };
    });
    return { label: str(r, 'label', { max: 12, path: `rows[${i}].` }), segments };
  });
  const names = [...new Set(rows.flatMap(r => r.segments.map(sg => sg.label)))];
  if (!names.length) fail('the timeline has no segment');
  const order = names.map(n => [n, rows.reduce((a, r) => a + r.segments.filter(sg => sg.label === n).reduce((x, sg) => x + sg.to - sg.from, 0), 0)]).sort((x, y) => y[1] - x[1]).map(x => x[0]);
  const color = n => { const k = order.indexOf(n); return k < 5 ? C.palette(k) : 'var(--chart-muted,#b8c0c4)'; };
  const W = WIDTH, L = Math.min(Math.max(...rows.map(r => r.label.length)) * 7 + 10, 92), R = 6, rowH = 26, top = 18;
  const H = top + rows.length * rowH + 4, X = h => L + (h - h0) / (h1 - h0) * (W - L - R), step = h1 - h0 > 12 ? 6 : h1 - h0 > 6 ? 3 : 1;
  const hh = h => String(Math.floor(h)).padStart(2, '0') + ':' + String(Math.round((h % 1) * 60)).padStart(2, '0');
  let g = '';
  for (let h = h0; h <= h1; h += step) g += `<line x1="${X(h).toFixed(1)}" x2="${X(h).toFixed(1)}" y1="${top - 3}" y2="${H - 4}" stroke="var(--chart-grid,#e4e6e5)"/>` +
    `<text x="${X(h).toFixed(1)}" y="10" text-anchor="${h === h0 ? 'start' : h === h1 ? 'end' : 'middle'}" font-size="10" fill="var(--chart-axis-text,#6f7980)">${String(h).padStart(2, '0')}h</text>`;
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    g += `<text x="${L - 6}" y="${y + rowH / 2 + 4}" text-anchor="end" font-size="11" fill="var(--chart-ink,#141716)">${esc(r.label)}</text>` +
      `<rect x="${L}" y="${y + 4}" width="${W - L - R}" height="${rowH - 8}" rx="4" fill="var(--chart-grid,#e4e6e5)" fill-opacity=".45"/>`;
    r.segments.forEach(sg => {
      const a = Math.max(h0, sg.from), z = Math.min(h1, sg.to);
      if (z <= a) return;
      g += `<rect x="${X(a).toFixed(1)}" y="${y + 4}" width="${Math.max(1.5, X(z) - X(a)).toFixed(1)}" height="${rowH - 8}" rx="4" fill="${color(sg.label)}">` +
        `<title>${esc(r.label)}: ${esc(sg.label)}, ${hh(sg.from)} to ${hh(sg.to)}</title></rect>`;
    });
  });
  const legend = order.slice(0, 6).map(n => `<span><i style="background:${color(n)}"></i>${esc(n)}</span>`).join('');
  return `<section class="block chart" data-chart="timeline"><h3>${inline(title)}</h3><p class="takeaway">${inline(takeaway)}</p>` +
    `<p class="legend">${legend}</p><div class="plot">${C.svg(W, H, g, title)}</div><p class="source">${esc(source)}</p>${dataThrough(b, false)}</section>`;
}

const RENDER = { heading, kpi, insight, chart, table, map, timeline };

export function renderBlock(spec, { today = null } = {}) {
  TODAY = today ? Date.parse(today + 'T00:00:00Z') : Date.now();
  if (!isObj(spec)) fail('a block must be a JSON object');
  const kind = oneOf(spec, 'kind', KINDS);
  return { kind, chart: kind === 'chart' ? spec.chart : null, html: RENDER[kind](spec) };
}

// ---------- CLI ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === '--catalog') { process.stdout.write(JSON.stringify({ chart: CHARTS, block: KINDS.filter(k => k !== 'chart') })); process.exit(0); }
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  let out;
  try { out = { ok: true, ...renderBlock(JSON.parse(input), { today: process.env.CANVAS_TODAY || null }) }; }
  catch (e) {
    if (e instanceof SpecError || e instanceof SyntaxError) out = { ok: false, error: e.message };
    else { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); }
  }
  process.stdout.write(JSON.stringify(out));
}
