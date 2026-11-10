// Epoch for Hermes Desktop: how long a Kanban card could take, drawn from a Monte Carlo run
// over its `epoch: o/m/p` hint. Plain ESM, no build step. Every colour comes from the
// app's theme variables (var(--ui-*)), so the pane repaints with whatever theme is active.
import * as sdk from '@hermes/plugin-sdk'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const PATH = '/epoch'
const DAY_HOURS = 8
const MARKS = ['p10', 'p50', 'p80', 'p90', 'p95']
const DEFAULTS = { view: 'bars', colour: 'accent', custom: '#e0a030', shape: 'soft', marks: ['p50', 'p90'], band: 'on', unit: 'days' }
const HEX = /^#[0-9a-f]{6}$/i

// h(type, props, ...children): JSX without a compiler.
function h(type, props, ...children) {
  const { key, ...rest } = props || {}
  const kids = children.flat().filter(c => c !== null && c !== undefined && c !== false)
  if (kids.length === 1) rest.children = kids[0]
  else if (kids.length > 1) rest.children = kids
  return (kids.length > 1 ? jsxs : jsx)(type, rest, key)
}

const CSS = `
.ep{container-type:inline-size;height:100%;overflow:auto;color:var(--ui-text-primary);font-size:13.5px;line-height:1.5;
  --ep-mono:ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace;--ep-r:10px}
.ep *{box-sizing:border-box}
.ep-shell{display:grid;grid-template-columns:minmax(0,1fr) 260px;min-height:100%}
.ep-main{padding:20px 24px 28px;display:flex;flex-direction:column;gap:18px;min-width:0}
.ep-aside{border-left:1px solid var(--ui-stroke-tertiary);padding:18px 16px 24px;display:flex;flex-direction:column;gap:16px;min-width:0}
.ep-aside h3,.ep-card h3{margin:0;font-size:13px;font-weight:600}
.ep-top{display:flex;flex-wrap:wrap;gap:8px 10px;align-items:center}
.ep-select{font:inherit;font-size:13px;color:var(--ui-text-primary);background:transparent;color-scheme:inherit;border:1px solid var(--ui-stroke-secondary);
  border-radius:7px;padding:5px 8px;min-width:0;flex:1 1 260px;max-width:520px}
.ep-select option{background:var(--ui-bg-elevated,Canvas);color:var(--ui-text-primary,CanvasText)}
.ep-chip{font:600 11px/1 var(--ep-mono);padding:4px 7px;border-radius:5px;color:var(--ui-text-secondary);border:1px solid var(--ui-stroke-secondary)}
.ep-btn{font:inherit;font-size:12px;border:1px solid var(--ui-stroke-secondary);background:transparent;color:var(--ui-text-secondary);border-radius:6px;padding:4px 10px;cursor:pointer}
.ep-btn:hover{background:var(--ui-control-hover-background)}
.ep-lead h2{font-size:20px;line-height:1.25;margin:2px 0 4px;font-weight:600;text-wrap:balance}
.ep-lead h2 b{color:var(--ep-hue);font-weight:700}
.ep-lead p{margin:0;color:var(--ui-text-secondary)}
.ep-q{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border:1px solid var(--ui-stroke-tertiary);border-radius:var(--ep-r);overflow:hidden;background:var(--ui-bg-card)}
.ep-q div{padding:9px 12px;border-right:1px solid var(--ui-stroke-tertiary);min-width:0}
.ep-q div:last-child{border-right:0}
.ep-q small{display:block;font:600 10.5px/1 var(--ep-mono);letter-spacing:.06em;color:var(--ui-text-secondary);margin-bottom:5px}
.ep-q span{font:600 17px/1 var(--ep-mono);font-variant-numeric:tabular-nums}
.ep-q .on span{color:var(--ep-hue)}
.ep-q .off span{color:var(--ui-text-secondary);font-weight:500}
.ep-card{background:var(--ui-bg-card);border:1px solid var(--ui-stroke-tertiary);border-radius:var(--ep-r);padding:14px 16px;min-width:0}
.ep-chead{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;justify-content:space-between;margin-bottom:8px}
.ep-tabs{display:inline-flex;border:1px solid var(--ui-stroke-tertiary);border-radius:7px;padding:2px;gap:2px}
.ep-tabs button{font:inherit;font-size:12px;border:0;background:transparent;color:var(--ui-text-secondary);padding:4px 10px;white-space:nowrap;border-radius:5px;cursor:pointer}
.ep-tabs button[aria-pressed=true]{background:var(--ui-control-active-background);color:var(--ui-text-primary)}
.ep-chart{position:relative}
.ep-chart svg{display:block;width:100%;height:auto;overflow:visible}
.ep-chart text{font-family:var(--ep-mono);font-size:10.5px;fill:var(--ui-text-secondary)}
.ep-chart text.lbl{fill:var(--ui-text-primary);font-weight:600}
.ep-tip{position:absolute;pointer-events:none;background:var(--ui-bg-elevated);color:var(--ui-text-primary);border:1px solid var(--ui-stroke-secondary);border-radius:7px;
  padding:6px 9px;font:12px/1.4 var(--ep-mono);white-space:nowrap;box-shadow:0 6px 18px -6px rgba(0,0,0,.4);transform:translate(-50%,-115%);z-index:2}
.ep-foot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px 14px;margin-top:6px;font-size:11.5px;color:var(--ui-text-secondary)}
.ep-duo{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}
.ep-risk{display:flex;flex-direction:column;gap:10px;margin:0;padding:0;list-style:none}
.ep-risk li{display:grid;grid-template-columns:44px minmax(0,1fr);gap:10px;align-items:start;font-size:12.5px}
.ep-risk b{font:600 12px var(--ep-mono);color:color-mix(in srgb,var(--ui-red) 80%,var(--ui-base))}
.ep-meter{height:6px;border-radius:3px;background:var(--ui-stroke-tertiary);margin-top:6px;overflow:hidden}
.ep-meter i{display:block;height:100%;background:var(--ui-red)}
.ep-cal{display:flex;flex-direction:column;gap:6px}
.ep-cal .row{display:grid;grid-template-columns:minmax(0,1fr) 120px;gap:10px;align-items:center;font-size:12px}
.ep-cal .row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ep-cal svg{width:120px;height:14px;display:block}
.ep-muted{color:var(--ui-text-secondary);margin:0;font-size:12.5px}
.ep-muted code,.ep-empty code{font-family:var(--ep-mono);font-size:12px;padding:1px 5px;border-radius:4px;border:1px solid var(--ui-stroke-tertiary)}
.ep-empty{border:1px dashed var(--ui-stroke-secondary);border-radius:var(--ep-r);padding:22px;color:var(--ui-text-secondary);display:flex;flex-direction:column;gap:6px}
.ep-empty b{color:var(--ui-text-primary);font-size:14px}
.ep-err{color:color-mix(in srgb,var(--ui-red) 80%,var(--ui-base))}
.ep fieldset{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:7px}
.ep legend{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--ui-text-secondary);margin-bottom:6px;padding:0}
.ep-opts{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.ep-opt{font:inherit;font-size:12px;border:1px solid var(--ui-stroke-secondary);background:transparent;color:var(--ui-text-secondary);border-radius:6px;padding:4px 9px;cursor:pointer}
.ep-opt[aria-pressed=true]{color:var(--ui-text-primary);border-color:var(--ep-hue);background:color-mix(in oklab,var(--ep-hue) 16%,transparent)}
.ep-colour{width:34px;height:28px;border:1px solid var(--ui-stroke-secondary);border-radius:6px;background:transparent;padding:2px;cursor:pointer}
.ep-kcard{border:1px solid var(--ui-stroke-tertiary);border-radius:8px;padding:10px 11px;display:flex;flex-direction:column;gap:8px}
.ep-kcard p{margin:0;font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ep-badge{align-self:flex-start;display:inline-flex;gap:6px;align-items:center;font:600 11px/1 var(--ep-mono);padding:4px 7px;border-radius:5px;
  background:color-mix(in oklab,var(--ep-hue) 16%,transparent);color:var(--ep-hue);border:1px solid color-mix(in oklab,var(--ep-hue) 40%,var(--ui-stroke-tertiary))}
.ep-spark{display:block;width:100%;height:26px}
.ep :is(button,select,input):focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}
@container (max-width:820px){.ep-shell{grid-template-columns:minmax(0,1fr)}.ep-aside{border-left:0;border-top:1px solid var(--ui-stroke-tertiary)}}
@container (max-width:640px){.ep-duo{grid-template-columns:minmax(0,1fr)}.ep-main{padding:16px}.ep-q div{padding:8px 7px}.ep-q span{font-size:15px}.ep-tabs button{padding:4px 7px}}
@media (prefers-reduced-motion:reduce){.ep *{transition:none!important;animation:none!important}}
`

// ---------------------------------------------------------------------------- numbers

const unitOf = s => (s.unit === 'hours' ? { k: DAY_HOURS, short: 'h', long: 'hours' } : { k: 1, short: 'd', long: 'days' })
function fmt(days, s) {
  const v = days * unitOf(s).k
  return v.toFixed(v >= 100 ? 0 : 1)
}
const mix = (pct, base = 'transparent') => `color-mix(in oklab, var(--ep-hue) ${pct}%, ${base})`

function quantileFromBins(d, p, total) {
  let c = 0
  for (let i = 0; i < d.counts.length; i++) {
    const n = d.counts[i]
    if (c + n >= p * total) return d.edges[i] + (n ? (p * total - c) / n : 0) * (d.edges[i + 1] - d.edges[i])
    c += n
  }
  return d.edges[d.edges.length - 1]
}

function loadSettings(ctx) {
  let saved = {}
  try { saved = ctx.storage.get('chart', {}) || {} } catch { saved = {} }
  const s = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS)) if (k in saved && typeof saved[k] === typeof DEFAULTS[k]) s[k] = saved[k]
  if (!Array.isArray(s.marks)) s.marks = DEFAULTS.marks
  s.marks = s.marks.filter(m => MARKS.includes(m))
  if (!HEX.test(s.custom)) s.custom = DEFAULTS.custom
  return s
}

const hueOf = s => (s.colour === 'custom' ? s.custom : s.colour === 'ink' ? 'var(--ui-text-primary)' : 'var(--ui-accent)')

// ---------------------------------------------------------------------------- chart

// The SVG is drawn at its real pixel width so chart text stays 10.5px at any pane size.
function useWidth(ref) {
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    if (!ref.current) return undefined
    setW(Math.round(ref.current.getBoundingClientRect().width))
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [ref])
  return w
}

function Chart({ f, s }) {
  const box = useRef(null)
  const width = useWidth(box)
  const [tip, setTip] = useState(null)
  const d = f.distribution
  const Q = f.percentiles_days
  const total = d.counts.reduce((a, b) => a + b, 0) || 1
  const W = Math.max(200, width || 720), L = 40, R = 16, T = 40, B = 34
  const iw = W - L - R
  const lo = Math.floor(d.edges[0]), hi = Math.max(Math.ceil(d.edges[d.edges.length - 1]), lo + 1)
  const x = v => L + ((v - lo) / (hi - lo)) * iw
  // 50-dot view: stack first, then size the plot to the tallest stack so it isn't mostly empty.
  const N = 50, r = W < 560 ? 5 : 7, dots = []
  if (s.view === 'dots') {
    const col = {}
    for (let k = 0; k < N; k++) {
      const v = quantileFromBins(d, (k + 0.5) / N, total)
      const bx = Math.round((x(v) - L) / (2 * r + 1))
      col[bx] = (col[bx] || 0) + 1
      dots.push({ v, bx, row: col[bx] })
    }
  }
  const tallest = Math.max(1, ...dots.map(p => p.row))
  const ih = s.view === 'dots' ? Math.max(70, tallest * (2 * r + 1) + 10) : (W < 560 ? 250 : 290) - T - B
  const H = T + ih + B
  const us = unitOf(s).short
  const band = s.band === 'on' && Q.p50 != null && Q.p90 != null
  const inRange = (a, b) => !band || (b > Q.p50 && a < Q.p90)
  const show = (e, text) => {
    const bb = box.current.getBoundingClientRect()
    setTip({ x: e.clientX - bb.left, y: e.clientY - bb.top, text })
  }
  const hide = () => setTip(null)

  const grid = []
  const span = hi - lo
  // Whole-unit ticks at least 52px apart so labels never touch.
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500].find(n => (iw * n) / span >= 52) || Math.ceil(span / 4)
  for (let v = lo; v <= hi; v += step) {
    grid.push(h('line', { key: 'gx' + v, x1: x(v), x2: x(v), y1: T, y2: T + ih, stroke: 'var(--ui-stroke-tertiary)', strokeDasharray: '2 4' }))
    grid.push(h('text', { key: 'tx' + v, x: x(v), y: H - B + 18, textAnchor: 'middle' }, fmt(v, s) + us))
  }
  const marks = []
  if (band) {
    marks.push(h('rect', { key: 'band', x: x(Q.p50), y: T, width: Math.max(0, x(Q.p90) - x(Q.p50)), height: ih, fill: mix(10) }))
  }
  let title, foot
  const body = []
  if (s.view === 'bars') {
    title = 'How long it could take'
    foot = `Each bar counts simulated runs ending in that range · ${d.counts.length} bins`
    const ymax = Math.max(...d.counts, 1)
    const y = c => T + ih - (c / ymax) * ih
    const ystep = Math.max(1, Math.pow(10, Math.floor(Math.log10(ymax))) * (ymax / Math.pow(10, Math.floor(Math.log10(ymax))) > 4 ? 1 : 0.5))
    for (let c = 0; c <= ymax; c += ystep) {
      grid.push(h('line', { key: 'gy' + c, x1: L, x2: W - R, y1: y(c), y2: y(c), stroke: 'var(--ui-stroke-tertiary)', strokeWidth: c ? 0.6 : 1 }))
      grid.push(h('text', { key: 'ty' + c, x: L - 6, y: y(c) + 3.5, textAnchor: 'end' }, String(Math.round(c))))
    }
    d.counts.forEach((c, i) => {
      const a = d.edges[i], b = d.edges[i + 1], strong = inRange(a, b)
      const fill = s.shape === 'outline' ? 'transparent' : s.shape === 'solid' ? mix(strong ? 100 : 55) : mix(strong ? 62 : 28)
      body.push(h('rect', {
        key: 'b' + i, x: x(a) + 1, y: y(c), width: Math.max(1, x(b) - x(a) - 2), height: T + ih - y(c), rx: 2.5, fill,
        stroke: s.shape === 'outline' ? mix(strong ? 100 : 55) : 'none', strokeWidth: 1.5, style: { cursor: 'crosshair' },
        onMouseMove: e => show(e, `${fmt(a, s)}–${fmt(b, s)}${us} · ${c} runs (${((c / total) * 100).toFixed(1)}%)`),
        onMouseLeave: hide
      }))
    })
  } else if (s.view === 'cdf') {
    title = 'Chance it is done by'
    foot = 'Read across: pick a confidence, see the date it needs'
    const y = p => T + ih - p * ih
    ;[0, 0.25, 0.5, 0.75, 1].forEach(p => {
      grid.push(h('line', { key: 'gy' + p, x1: L, x2: W - R, y1: y(p), y2: y(p), stroke: 'var(--ui-stroke-tertiary)', strokeWidth: p ? 0.6 : 1 }))
      grid.push(h('text', { key: 'ty' + p, x: L - 6, y: y(p) + 3.5, textAnchor: 'end' }, `${p * 100}%`))
    })
    let c = 0
    const pts = [[x(d.edges[0]), y(0)]]
    d.counts.forEach((n, i) => { c += n; pts.push([x(d.edges[i + 1]), y(c / total)]) })
    const path = 'M' + pts.map(p => p.join(',')).join(' L')
    body.push(h('path', { key: 'area', d: `${path} L${pts[pts.length - 1][0]},${y(0)} Z`, fill: mix(14) }))
    body.push(h('path', { key: 'line', d: path, fill: 'none', stroke: mix(100), strokeWidth: 2.5, strokeLinejoin: 'round' }))
    if (tip && tip.sx != null) body.push(h('line', { key: 'cross', x1: tip.sx, x2: tip.sx, y1: T, y2: T + ih, stroke: 'var(--ui-text-tertiary)', strokeDasharray: '3 3' }))
    body.push(h('rect', {
      key: 'hit', x: L, y: T, width: iw, height: ih, fill: 'transparent',
      onMouseMove: e => {
        const bb = e.currentTarget.ownerSVGElement.getBoundingClientRect()
        const sx = ((e.clientX - bb.left) / bb.width) * W
        const v = lo + ((sx - L) / iw) * (hi - lo)
        let cc = 0
        for (let i = 0; i < d.counts.length; i++) {
          if (v >= d.edges[i + 1]) cc += d.counts[i]
          else { if (v > d.edges[i]) cc += d.counts[i] * (v - d.edges[i]) / (d.edges[i + 1] - d.edges[i]); break }
        }
        const bx = box.current.getBoundingClientRect()
        setTip({ x: e.clientX - bx.left, y: e.clientY - bx.top, sx, text: `${Math.round(Math.min(1, cc / total) * 100)}% chance done by ${fmt(Math.max(v, lo), s)}${us}` })
      },
      onMouseLeave: hide
    }))
  } else {
    title = '50 equally likely outcomes'
    foot = 'Each dot is a 2% chance · count the dots right of a date for the risk of missing it'
    grid.push(h('line', { key: 'base', x1: L, x2: W - R, y1: T + ih, y2: T + ih, stroke: 'var(--ui-stroke-tertiary)' }))
    dots.forEach(({ v, bx, row }, k) => {
      const strong = !band || (v >= Q.p50 && v <= Q.p90)
      body.push(h('circle', {
        key: 'd' + k, cx: L + bx * (2 * r + 1), cy: T + ih - (row - 0.5) * (2 * r + 1), r: r - 0.6,
        fill: s.shape === 'outline' ? 'transparent' : mix(strong ? (s.shape === 'solid' ? 100 : 70) : 30),
        stroke: mix(strong ? 100 : 50), strokeWidth: s.shape === 'outline' ? 1.5 : 0,
        onMouseMove: e => show(e, `1 in 50 · about ${fmt(v, s)}${us}`), onMouseLeave: hide
      }))
    })
  }
  // Marker labels live in the top margin, alternating two rows, so they never sit on the bars.
  MARKS.filter(k => s.marks.includes(k) && Q[k] != null).forEach((k, j) => {
    const xx = x(Q[k]), strong = k === 'p50' || k === 'p90'
    marks.push(h('line', { key: 'm' + k, x1: xx, x2: xx, y1: T - 8 - (j % 2) * 13, y2: T + ih, stroke: strong ? 'var(--ui-text-primary)' : 'var(--ui-text-tertiary)',
      strokeWidth: k === 'p50' ? 1.6 : 1.1, strokeDasharray: k === 'p50' ? undefined : '4 3' }))
    const flip = xx > W - R - 90
    marks.push(h('text', { key: 'ml' + k, className: 'lbl', x: flip ? xx - 4 : xx + 4, y: T - 10 - (j % 2) * 13, textAnchor: flip ? 'end' : 'start' },
      `${k.toUpperCase()} ${fmt(Q[k], s)}${us}`))
  })
  return h('section', { className: 'ep-card' },
    h('div', { className: 'ep-chead' },
      h('h3', null, title),
      h('div', { className: 'ep-tabs', role: 'group', 'aria-label': 'Chart view' },
        [['bars', 'Distribution'], ['cdf', 'Chance done by'], ['dots', '50 dots']].map(([v, label]) =>
          h('button', { key: v, type: 'button', 'aria-pressed': s.view === v, onClick: () => s.set({ view: v }) }, label)))),
    h('div', { className: 'ep-chart', ref: box },
      h('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${title}. P50 ${fmt(Q.p50, s)}${us}, P90 ${fmt(Q.p90, s)}${us}.` },
        h('g', null, grid), h('g', null, body), h('g', null, marks)),
      tip ? h('div', { className: 'ep-tip', style: { left: tip.x, top: tip.y } }, tip.text) : null),
    h('div', { className: 'ep-foot' }, h('span', null, foot),
      h('span', null, band ? 'Shaded: the likely range, P50 to P90 · ' : '', 'Simulated spread, not observed outcomes')))
}

// ---------------------------------------------------------------------------- side pieces

function Spark({ d, Q, band }) {
  const m = Math.max(...d.counts, 1), w = 200 / d.counts.length
  return h('svg', { className: 'ep-spark', viewBox: '0 0 200 26', preserveAspectRatio: 'none', 'aria-hidden': true },
    d.counts.map((c, i) => {
      const strong = !band || (d.edges[i + 1] > Q.p50 && d.edges[i] < Q.p90)
      return h('rect', { key: i, x: i * w + 0.5, y: 26 - (c / m) * 24, width: Math.max(0.5, w - 1), height: (c / m) * 24, fill: mix(strong ? 90 : 35) })
    }))
}

function Hourglass() {
  return h('svg', { width: 11, height: 11, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, 'aria-hidden': true },
    h('path', { d: 'M6 3h12M6 21h12M7.5 3.5 16.5 3.5 12 12zM12 12 16.5 20.5H7.5z', strokeLinejoin: 'round' }))
}

function Opts({ s, k, values, multi }) {
  return h('div', { className: 'ep-opts' }, values.map(([v, label]) => {
    const on = multi ? s[k].includes(v) : s[k] === v
    return h('button', {
      key: v, type: 'button', className: 'ep-opt', 'aria-pressed': on,
      onClick: () => s.set({ [k]: multi ? (on ? s[k].filter(x => x !== v) : [...s[k], v]) : v })
    }, label)
  }))
}

function Settings({ s, f, title }) {
  const Q = f && f.ok ? f.percentiles_days : null
  const us = unitOf(s).short
  return h('aside', { className: 'ep-aside', 'aria-label': 'Chart settings' },
    h('h3', null, 'Chart settings'),
    h('fieldset', null, h('legend', null, 'Colour'),
      h('div', { className: 'ep-opts' },
        h(Opts, { s, k: 'colour', values: [['accent', 'Theme accent'], ['ink', 'Ink only'], ['custom', 'Custom']] }),
        h('input', { type: 'color', className: 'ep-colour', value: s.custom, 'aria-label': 'Custom chart colour',
          onChange: e => HEX.test(e.target.value) && s.set({ custom: e.target.value, colour: 'custom' }) }))),
    h('fieldset', null, h('legend', null, 'Bars'), h(Opts, { s, k: 'shape', values: [['solid', 'Solid'], ['soft', 'Soft'], ['outline', 'Outline']] })),
    h('fieldset', null, h('legend', null, 'Markers'), h(Opts, { s, k: 'marks', multi: true, values: MARKS.map(m => [m, m.toUpperCase()]) })),
    h('fieldset', null, h('legend', null, 'Shade the likely range'), h(Opts, { s, k: 'band', values: [['on', 'P50 to P90'], ['off', 'Off']] })),
    h('fieldset', null, h('legend', null, 'Units'), h(Opts, { s, k: 'unit', values: [['days', 'Days'], ['hours', 'Hours']] })),
    Q && Q.p50 != null ? h('fieldset', null, h('legend', null, 'On the Kanban card'),
      h('div', { className: 'ep-kcard' },
        h('p', { title }, title),
        h('span', { className: 'ep-badge' }, h(Hourglass), `P50 ${fmt(Q.p50, s)}${us} · P90 ${fmt(Q.p90, s)}${us}`),
        f.distribution ? h(Spark, { d: f.distribution, Q, band: s.band === 'on' }) : null)) : null)
}

function Risks({ f, s }) {
  const us = unitOf(s).short
  return h('section', { className: 'ep-card' },
    h('div', { className: 'ep-chead' }, h('h3', null, 'What could push it out')),
    f.risks && f.risks.length
      ? h('ul', { className: 'ep-risk' }, f.risks.map((r, i) => {
        const p = Math.max(0, Math.min(1, r.probability || 0))
        return h('li', { key: i },
          h('b', null, `${Math.round(p * 100)}%`),
          h('div', null, r.impact_days ? `${r.description}, adding about ${fmt(r.impact_days, s)}${us}.` : r.description,
            h('div', { className: 'ep-meter' }, h('i', { style: { width: `${p * 100}%` } }))))
      }))
      : h('p', { className: 'ep-muted' }, 'Epoch flagged no single risk worth naming for this card.'))
}

function History({ items, s }) {
  const us = unitOf(s).short
  const cmax = Math.max(0.1, ...items.flatMap(c => [c.p90_days || c.p50_days, c.actual_days])) * 1.08
  const sx = v => 4 + (v / cmax) * 112
  return h('section', { className: 'ep-card' },
    h('div', { className: 'ep-chead' }, h('h3', null, 'Estimate vs actual')),
    items.length
      ? h('div', { className: 'ep-cal' }, items.map((c, i) => {
        const p90 = c.p90_days != null ? c.p90_days : c.p50_days, late = c.actual_days > p90
        return h('div', { key: i, className: 'row' },
          h('span', { title: c.name }, c.name),
          h('svg', { viewBox: '0 0 120 14', role: 'img', 'aria-label': `P50 ${fmt(c.p50_days, s)}${us}, P90 ${fmt(p90, s)}${us}, actual ${fmt(c.actual_days, s)}${us}` },
            h('line', { x1: 4, x2: 116, y1: 7, y2: 7, stroke: 'var(--ui-stroke-tertiary)' }),
            h('rect', { x: sx(c.p50_days), y: 3, width: Math.max(2, sx(p90) - sx(c.p50_days)), height: 8, rx: 3, fill: mix(45) }),
            h('circle', { cx: sx(c.actual_days), cy: 7, r: 3.6, fill: late ? 'var(--ui-red)' : 'var(--ui-text-primary)' })))
      }))
      : h('p', { className: 'ep-muted' }, 'Shows up once Epoch has recorded how long finished cards really took.'),
    items.length ? h('div', { className: 'ep-foot' }, h('span', null, 'Bar: P50 to P90 · dot: what it really took')) : null)
}

// ---------------------------------------------------------------------------- page

const keyOf = t => `${t.board}\u0000${t.id}`

function Page({ ctx }) {
  const [s, setS] = useState(() => loadSettings(ctx))
  const [tasks, setTasks] = useState({ loading: true, tasks: [], errors: [] })
  const [sel, setSel] = useState(() => { try { return ctx.storage.get('selected', '') || '' } catch { return '' } })
  const [f, setF] = useState(null)
  const [hist, setHist] = useState([])
  const seq = useRef(0)

  const sx = useMemo(() => ({
    ...s,
    set: patch => setS(prev => {
      const next = { ...prev, ...patch }
      try { ctx.storage.set('chart', next) } catch { /* storage full or unavailable: keep the session value */ }
      return next
    })
  }), [s, ctx])

  const loadTasks = () => {
    setTasks(t => ({ ...t, loading: true }))
    ctx.rest('/tasks')
      .then(r => setTasks({ loading: false, tasks: Array.isArray(r && r.tasks) ? r.tasks : [], errors: (r && r.errors) || [] }))
      .catch(e => setTasks({ loading: false, tasks: [], errors: [], fault: String((e && e.message) || e) }))
    ctx.rest('/history').then(r => setHist(Array.isArray(r && r.items) ? r.items : [])).catch(() => setHist([]))
  }
  useEffect(loadTasks, [])

  const current = tasks.tasks.find(t => keyOf(t) === sel) || tasks.tasks.find(t => t.hint) || null
  useEffect(() => {
    if (!current) { setF(null); return }
    const n = ++seq.current
    setF({ loading: true })
    ctx.rest(`/forecast?board=${encodeURIComponent(current.board)}&task_id=${encodeURIComponent(current.id)}`)
      .then(r => { if (n === seq.current) setF(r) })
      .catch(e => { if (n === seq.current) setF({ ok: false, error: String((e && e.message) || e) }) })
  }, [current && keyOf(current)])

  const choose = v => { setSel(v); try { ctx.storage.set('selected', v) } catch { /* ignore */ } }
  const style = { '--ep-hue': hueOf(s) }
  const us = unitOf(s)
  const withHint = tasks.tasks.filter(t => t.hint).length

  let main
  if (tasks.fault) {
    main = h('div', { className: 'ep-empty' }, h('b', null, 'Could not reach the Epoch backend.'),
      h('span', { className: 'ep-err' }, tasks.fault),
      h('span', null, 'The plugin must be enabled in Hermes for its backend to load.'))
  } else if (!tasks.loading && !tasks.tasks.length) {
    main = h('div', { className: 'ep-empty' }, h('b', null, 'No open Kanban cards.'),
      h('span', null, 'Epoch charts open cards. Add one with a three-point hint, for example ', h('code', null, 'epoch: 2/4/10h'), '.'))
  } else if (!current) {
    main = tasks.loading ? h('p', { className: 'ep-muted' }, 'Loading cards…')
      : h('div', { className: 'ep-empty' }, h('b', null, 'No card has an estimate hint yet.'),
        h('span', null, 'Add ', h('code', null, 'epoch: optimistic/likely/pessimistic'), ' to a card title or body, like ', h('code', null, 'epoch: 2/4/10h'), '.'))
  } else if (!f || f.loading) {
    main = h('p', { className: 'ep-muted' }, 'Running 5,000 simulations…')
  } else if (!f.ok) {
    const hinted = f.hint || current.hint
    main = h('div', { className: 'ep-empty' }, h('b', null, hinted ? 'Epoch could not run.' : 'This card has no estimate hint.'),
      h('span', { className: hinted ? 'ep-err' : '' }, f.error || f.hint_error || 'Unknown error'))
  } else {
    const Q = f.percentiles_days || {}
    main = [
      h('div', { key: 'lead', className: 'ep-lead' },
        h('h2', null, 'Likely done in ', h('b', null, `${fmt(Q.p50, s)} ${us.long}`), '. ',
          Q.p90 != null ? ['9 in 10 runs finish within ', h('b', { key: 'p90' }, `${fmt(Q.p90, s)} ${us.long}`), '.'] : null),
        h('p', null, `Monte Carlo over ${f.hint ? `the card's hint (${f.hint.optimistic}/${f.hint.most_likely}/${f.hint.pessimistic}h)` : "the card's hint"} · ${Number(f.iterations).toLocaleString()} runs${f.seed != null ? ` · seed ${f.seed}` : ''} · ${DAY_HOURS}-hour days`)),
      h('div', { key: 'q', className: 'ep-q' }, MARKS.map(k => h('div', { key: k, className: s.marks.includes(k) ? 'on' : 'off' },
        h('small', null, k.toUpperCase()), h('span', null, Q[k] != null ? `${fmt(Q[k], s)}${us.short}` : '—')))),
      f.distribution
        ? h(Chart, { key: 'chart', f, s: sx })
        : h('div', { key: 'old', className: 'ep-empty' }, h('b', null, 'The full spread needs Epoch 0.8.'),
          h('span', null, 'This Epoch returns percentiles only. Point ', h('code', null, 'epoch_command'), ' at Epoch 0.8 or later to draw the chart.')),
      h('div', { key: 'duo', className: 'ep-duo' }, h(Risks, { f, s }), h(History, { items: hist, s }))
    ]
  }

  return h('div', { className: 'ep', style },
    h('div', { className: 'ep-shell' },
      h('main', { className: 'ep-main' },
        h('div', { className: 'ep-top' },
          h('select', { className: 'ep-select', 'aria-label': 'Kanban card', value: current ? keyOf(current) : '', onChange: e => choose(e.target.value), disabled: !tasks.tasks.length },
            tasks.tasks.map(t => h('option', { key: keyOf(t), value: keyOf(t) }, `${t.title}${t.hint ? '' : '  (no hint)'}${t.board !== 'default' ? ` · ${t.board}` : ''}`))),
          current ? h('span', { className: 'ep-chip' }, current.board) : null,
          current ? h('span', { className: 'ep-chip' }, current.status) : null,
          h('button', { type: 'button', className: 'ep-btn', onClick: loadTasks }, tasks.loading ? 'Loading…' : 'Refresh'),
          tasks.tasks.length ? h('span', { className: 'ep-muted' }, `${withHint} of ${tasks.tasks.length} open cards have a hint`) : null),
        (tasks.errors || []).length ? h('p', { className: 'ep-muted ep-err' }, `Some boards could not be read: ${tasks.errors.join(', ')}`) : null,
        main),
      h(Settings, { s: sx, f, title: current ? current.title : '' })))
}

// ---------------------------------------------------------------------------- Kanban badge

function badgeLabel(t, unit) {
  const days = unit === 'hours' ? null : 1 / DAY_HOURS
  const show = v => (days ? (v * days).toFixed(1) + 'd' : v.toFixed(v >= 100 ? 0 : 1) + 'h')
  return `P50 ${show(t.p50_hours)} · P90 ${show(t.p90_hours)}`
}

export default {
  id: 'epoch',
  name: 'Epoch',
  register(ctx) {
    const style = document.createElement('style')
    style.dataset.plugin = 'epoch'
    style.textContent = CSS
    document.head.appendChild(style)
    ctx.onDispose(() => style.remove())

    ctx.registerMany([
      { id: 'page', area: sdk.ROUTES_AREA, data: { path: PATH }, render: () => jsx(Page, { ctx }) },
      { id: 'nav', area: sdk.SIDEBAR_NAV_AREA, data: { path: PATH, label: 'Epoch', codicon: 'watch' } }
    ])

    // P50/P90 on the cards Epoch has estimated. Older Desktops without the badge area skip this.
    const area = sdk.KANBAN_CARD_AREAS && sdk.KANBAN_CARD_AREAS.badges
    if (!area) return
    let byId = {}
    let drop = null
    const paint = () => {
      if (drop) drop()
      let unit = 'days'
      try { unit = (ctx.storage.get('chart', {}) || {}).unit === 'hours' ? 'hours' : 'days' } catch { /* default */ }
      drop = ctx.register({
        id: 'estimate', area,
        data: {
          decorate: card => {
            const t = card && byId[card.id]
            if (!t || card.status === 'done' || card.status === 'archived') return null
            return { label: badgeLabel(t, unit), tone: 'neutral', tooltip: `Epoch estimate posted when this card was claimed (${DAY_HOURS}-hour days).` }
          }
        }
      })
    }
    const pull = () => ctx.rest('/badges')
      .then(r => {
        const next = (r && r.tasks) || {}
        if (JSON.stringify(next) !== JSON.stringify(byId)) { byId = next; paint() }
      })
      .catch(() => { /* backend not loaded: no badges, nothing else breaks */ })
    paint()
    pull()
    ctx.setInterval(() => { if (!document.hidden) pull() }, 60000)
  }
}
