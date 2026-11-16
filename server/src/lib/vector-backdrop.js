// 矢量背景引擎：直接生成 SVG，而不是用 canvas 画位图。
//
// 相比原来的「设计底图」（canvas → PNG），矢量方案的收益：
//   1) 体积小、瞬时返回（无需栅格化），前端点击即出，不占用生图额度；
//   2) 无限缩放不失真，导出 3x 大图依然锐利；
//   3) 与主题色强绑定，同一关键词下的多张背景天然属于同一色系——
//      这正是「AI 生图背景不一致」的替代解法：可控、可预期、成组统一。
//
// 输出同时带 svg 文本与 base64 data URL；服务端渲染海报时 @napi-rs/canvas
// 可直接 loadImage(SVG buffer)，无需额外转换。

import { pickTheme, DEFAULT_THEME } from './design-backdrop.js'

const DEFAULT_W = 1080
const DEFAULT_H = 1440

/* ---------- 确定性随机：同一关键词+变体永远得到同一张图 ---------- */

function hashStr(s) {
  let h = 2166136261
  const str = String(s || '')
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const r2 = (n) => Math.round(n * 100) / 100

/* ---------- 各风格：返回 SVG 内部片段 ---------- */

// 1) 弥散网格：多层径向渐变叠加，最接近「高级感背景」的通用解
function buildMesh(rng, [c1, c2, c3], w, h) {
  const blobs = [
    { x: 0.18 + rng() * 0.1, y: 0.15 + rng() * 0.1, r: 0.72, c: c1, o: 0.95 },
    { x: 0.82 - rng() * 0.12, y: 0.28 + rng() * 0.12, r: 0.62, c: c2, o: 0.8 },
    { x: 0.35 + rng() * 0.25, y: 0.78 - rng() * 0.1, r: 0.68, c: c1, o: 0.6 },
    { x: 0.72 - rng() * 0.2, y: 0.88, r: 0.5, c: c2, o: 0.55 },
  ]
  const defs = blobs
    .map(
      (b, i) => `<radialGradient id="mb${i}" cx="${r2(b.x * 100)}%" cy="${r2(b.y * 100)}%" r="${r2(b.r * 100)}%">
      <stop offset="0" stop-color="${b.c}" stop-opacity="${b.o}"/>
      <stop offset="0.55" stop-color="${b.c}" stop-opacity="${r2(b.o * 0.35)}"/>
      <stop offset="1" stop-color="${b.c}" stop-opacity="0"/>
    </radialGradient>`,
    )
    .join('')
  const rects = blobs.map((_, i) => `<rect width="${w}" height="${h}" fill="url(#mb${i})"/>`).join('')
  return {
    defs: `${defs}<filter id="mgrain"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3"/><feColorMatrix type="saturate" values="0"/></filter>`,
    body: `<rect width="${w}" height="${h}" fill="${c3}"/>${rects}
      <rect width="${w}" height="${h}" filter="url(#mgrain)" opacity="0.05"/>`,
  }
}

// 2) 流体色块：有机曲线path拼贴。块要小而多、边缘轻微柔化，
//    模糊过强会糊成一片纯渐变，丢失设计感。
function buildBlobs(rng, [c1, c2, c3], w, h) {
  const defs = `<linearGradient id="bg1" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}" stop-opacity="0.95"/><stop offset="1" stop-color="${c2}" stop-opacity="0.8"/>
    </linearGradient>
    <linearGradient id="bg2" x1="1" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${c2}" stop-opacity="0.9"/><stop offset="1" stop-color="${c1}" stop-opacity="0.55"/>
    </linearGradient>
    <filter id="bsoft"><feGaussianBlur stdDeviation="20"/></filter>`
  const blob = (cx, cy, rx, ry, fill) => {
    const k = () => r2(0.7 + rng() * 0.6)
    return `<path d="M ${r2(cx - rx)} ${r2(cy)}
      C ${r2(cx - rx)} ${r2(cy - ry * k())}, ${r2(cx - rx * 0.3)} ${r2(cy - ry * k())}, ${r2(cx)} ${r2(cy - ry)}
      C ${r2(cx + rx * k())} ${r2(cy - ry)}, ${r2(cx + rx)} ${r2(cy - ry * 0.4)}, ${r2(cx + rx)} ${r2(cy)}
      C ${r2(cx + rx)} ${r2(cy + ry * k())}, ${r2(cx + rx * 0.3)} ${r2(cy + ry * k())}, ${r2(cx)} ${r2(cy + ry)}
      C ${r2(cx - rx * k())} ${r2(cy + ry)}, ${r2(cx - rx)} ${r2(cy + ry * 0.4)}, ${r2(cx - rx)} ${r2(cy)} Z"
      fill="${fill}"/>`
  }
  // 5 块错落分布：大块定基调，小块提层次，避免整屏只有两三团糊影
  const parts = [
    blob(w * (0.28 + rng() * 0.12), h * (0.22 + rng() * 0.1), w * 0.38, h * 0.2, 'url(#bg1)'),
    blob(w * (0.74 - rng() * 0.1), h * (0.38 + rng() * 0.1), w * 0.32, h * 0.17, 'url(#bg2)'),
    blob(w * (0.3 + rng() * 0.15), h * (0.66 + rng() * 0.08), w * 0.3, h * 0.15, 'url(#bg2)'),
    blob(w * (0.78 - rng() * 0.12), h * (0.8 + rng() * 0.06), w * 0.28, h * 0.14, 'url(#bg1)'),
    blob(w * (0.5 + rng() * 0.12), h * (0.95 - rng() * 0.05), w * 0.36, h * 0.16, c2),
  ].join('')
  return {
    defs,
    body: `<rect width="${w}" height="${h}" fill="${c3}"/><g filter="url(#bsoft)" opacity="0.9">${parts}</g>`,
  }
}

// 3) 同心圆：批量圆环，节奏感强，适合做底
function buildConcentric(rng, [c1, c2, c3], w, h) {
  const cx = w * (0.3 + rng() * 0.4)
  const cy = h * (0.25 + rng() * 0.35)
  const rings = []
  const total = 16 + Math.floor(rng() * 8)
  const maxR = Math.max(w, h) * 0.78
  for (let i = total; i > 0; i--) {
    const t = i / total
    const rad = maxR * t
    const col = i % 2 === 0 ? c1 : c2
    rings.push(
      `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(rad)}" fill="none" stroke="${col}" stroke-width="${r2(
        2 + (1 - t) * 9,
      )}" stroke-opacity="${r2(0.1 + (1 - t) * 0.5)}"/>`,
    )
  }
  return {
    defs: `<radialGradient id="cg" cx="50%" cy="50%" r="70%">
      <stop offset="0" stop-color="${c1}" stop-opacity="0.35"/><stop offset="1" stop-color="${c3}" stop-opacity="0"/>
    </radialGradient>`,
    body: `<rect width="${w}" height="${h}" fill="${c3}"/><rect width="${w}" height="${h}" fill="url(#cg)"/>${rings.join('')}`,
  }
}

// 4) 波形层叠：多条贝塞尔色带，流动感
function buildWaves(rng, [c1, c2, c3], w, h) {
  const layers = 6
  const paths = []
  for (let i = 0; i < layers; i++) {
    const t = i / (layers - 1)
    const baseY = h * (0.28 + t * 0.62)
    const amp = h * (0.06 + rng() * 0.09)
    const col = i % 2 === 0 ? c1 : c2
    paths.push(
      `<path d="M 0 ${r2(baseY - amp)} C ${r2(w * 0.28)} ${r2(baseY - amp * 2.1)}, ${r2(w * 0.62)} ${r2(
        baseY + amp * 1.8,
      )}, ${w} ${r2(baseY - amp * 0.4)} L ${w} ${h} L 0 ${h} Z" fill="${col}" fill-opacity="${r2(
        0.14 + t * 0.22,
      )}"/>`,
    )
  }
  return {
    defs: `<linearGradient id="wg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${c3}"/><stop offset="1" stop-color="${c1}" stop-opacity="0.55"/>
    </linearGradient>`,
    body: `<rect width="${w}" height="${h}" fill="url(#wg)"/>${paths.join('')}`,
  }
}

// 5) 孟菲斯几何：圆点/三角/十字/波浪线散落，年轻活泼
function buildMemphis(rng, [c1, c2, c3], w, h) {
  const items = []
  const n = 36 + Math.floor(rng() * 14)
  for (let i = 0; i < n; i++) {
    const x = rng() * w
    const y = rng() * h
    const col = [c1, c2, '#ffffff'][Math.floor(rng() * 3)]
    const size = 10 + rng() * 52
    const kind = Math.floor(rng() * 4)
    const op = r2(0.3 + rng() * 0.5)
    if (kind === 0) {
      items.push(`<circle cx="${r2(x)}" cy="${r2(y)}" r="${r2(size / 2)}" fill="${col}" fill-opacity="${op}"/>`)
    } else if (kind === 1) {
      const s = size
      items.push(
        `<path d="M ${r2(x)} ${r2(y - s / 2)} L ${r2(x + s / 2)} ${r2(y + s / 2)} L ${r2(x - s / 2)} ${r2(
          y + s / 2,
        )} Z" fill="${col}" fill-opacity="${op}"/>`,
      )
    } else if (kind === 2) {
      const s = size / 2
      items.push(
        `<path d="M ${r2(x - s)} ${r2(y)} L ${r2(x + s)} ${r2(y)} M ${r2(x)} ${r2(y - s)} L ${r2(x)} ${r2(
          y + s,
        )}" stroke="${col}" stroke-opacity="${op}" stroke-width="6" stroke-linecap="round"/>`,
      )
    } else {
      const seg = 3 + Math.floor(rng() * 3)
      let d = `M ${r2(x - size)} ${r2(y)}`
      for (let s = 1; s <= seg; s++) {
        d += ` q ${r2(size / seg / 2)} ${s % 2 ? -size * 0.34 : size * 0.34} ${r2(size / seg)} 0`
      }
      items.push(`<path d="${d}" stroke="${col}" stroke-opacity="${op}" stroke-width="5" fill="none" stroke-linecap="round"/>`)
    }
  }
  return {
    defs: `<linearGradient id="mg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c3}"/><stop offset="1" stop-color="${c1}" stop-opacity="0.42"/>
    </linearGradient>`,
    body: `<rect width="${w}" height="${h}" fill="url(#mg)"/>${items.join('')}`,
  }
}

// 6) 网格节点：细线网格 + 亮点，理性/科技
function buildGrid(rng, [c1, c2, c3], w, h) {
  const step = 72 + Math.floor(rng() * 40)
  const lines = []
  for (let x = step; x < w; x += step) {
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="${c2}" stroke-opacity="0.14" stroke-width="1.5"/>`)
  }
  for (let y = step; y < h; y += step) {
    lines.push(`<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="${c2}" stroke-opacity="0.14" stroke-width="1.5"/>`)
  }
  const dots = []
  const dn = 14 + Math.floor(rng() * 10)
  for (let i = 0; i < dn; i++) {
    const gx = Math.round((rng() * w) / step) * step
    const gy = Math.round((rng() * h) / step) * step
    const rad = 4 + rng() * 12
    dots.push(`<circle cx="${gx}" cy="${gy}" r="${r2(rad)}" fill="${c1}" fill-opacity="${r2(0.4 + rng() * 0.5)}"/>`)
  }
  return {
    defs: `<radialGradient id="gg" cx="50%" cy="40%" r="75%">
      <stop offset="0" stop-color="${c3}"/><stop offset="1" stop-color="#000000" stop-opacity="0.35"/>
    </radialGradient>`,
    body: `<rect width="${w}" height="${h}" fill="url(#gg)"/>${lines.join('')}${dots.join('')}`,
  }
}

// 7) 斜向条纹：宽条带 + 柔化，克制的高级感
function buildStripe(rng, [c1, c2, c3], w, h) {
  const bandW = 90 + Math.floor(rng() * 70)
  const gap = bandW * (1.6 + rng())
  const angle = -30 + rng() * 60
  const items = []
  const diag = Math.sqrt(w * w + h * h)
  for (let x = -diag; x < diag; x += gap) {
    items.push(
      `<rect x="${r2(x)}" y="${-diag}" width="${r2(bandW)}" height="${r2(diag * 2)}" fill="${
        rng() > 0.5 ? c1 : c2
      }" fill-opacity="${r2(0.2 + rng() * 0.28)}"/>`,
    )
  }
  return {
    defs: `<linearGradient id="sg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c3}"/><stop offset="1" stop-color="${c1}" stop-opacity="0.5"/>
    </linearGradient><filter id="ssoft"><feGaussianBlur stdDeviation="8"/></filter>`,
    body: `<rect width="${w}" height="${h}" fill="url(#sg)"/>
      <g transform="rotate(${r2(angle)} ${w / 2} ${h / 2})" filter="url(#ssoft)">${items.join('')}</g>`,
  }
}

// 8) 极光光带：大弧度渐变带，梦幻
function buildAurora(rng, [c1, c2, c3], w, h) {
  const bands = []
  for (let i = 0; i < 4; i++) {
    const y = h * (0.18 + i * 0.2) + rng() * 60
    const amp = h * (0.08 + rng() * 0.1)
    const col = i % 2 === 0 ? c1 : c2
    bands.push(
      `<path d="M ${-w * 0.1} ${r2(y)} C ${r2(w * 0.3)} ${r2(y - amp * 2.4)}, ${r2(w * 0.7)} ${r2(
        y + amp * 2.2,
      )}, ${r2(w * 1.1)} ${r2(y - amp)}" stroke="${col}" stroke-width="${r2(56 + rng() * 96)}" stroke-opacity="${r2(
        0.34 + rng() * 0.36,
      )}" fill="none" stroke-linecap="round"/>`,
    )
  }
  return {
    defs: `<linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${c3}"/><stop offset="1" stop-color="${c2}" stop-opacity="0.3"/>
    </linearGradient><filter id="asoft"><feGaussianBlur stdDeviation="34"/></filter>`,
    body: `<rect width="${w}" height="${h}" fill="url(#ag)"/><g filter="url(#asoft)">${bands.join('')}</g>`,
  }
}

const STYLES = [
  { key: 'mesh', name: '弥散网格', build: buildMesh },
  { key: 'blobs', name: '流体色块', build: buildBlobs },
  { key: 'concentric', name: '同心圆环', build: buildConcentric },
  { key: 'waves', name: '波形层叠', build: buildWaves },
  { key: 'memphis', name: '孟菲斯几何', build: buildMemphis },
  { key: 'grid', name: '网格节点', build: buildGrid },
  { key: 'stripe', name: '斜向条纹', build: buildStripe },
  { key: 'aurora', name: '极光光带', build: buildAurora },
]

/**
 * 生成单张矢量背景
 * @param {{keyword:string, width?:number, height?:number, variant?:number}} opts
 */
export function renderVectorBackdrop({ keyword = '', width = DEFAULT_W, height = DEFAULT_H, variant = 0 } = {}) {
  const style = STYLES[((variant % STYLES.length) + STYLES.length) % STYLES.length]
  const seed = hashStr(`${keyword}|${variant}`)
  const rng = mulberry32(seed)
  const colors = pickTheme(keyword) || DEFAULT_THEME
  const { defs, body } = style.build(rng, colors, width, height)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs>${defs}</defs>
${body}
</svg>`
  return {
    id: `vec-${hashStr(`${keyword}|${variant}|${style.key}`).toString(36)}`,
    style: style.key,
    styleName: style.name,
    colors,
    width,
    height,
    svg,
  }
}

/**
 * 一批矢量背景（默认 6 张，覆盖不同风格）
 */
export function generateVectorBackdrops(keyword, { count = 6, width = DEFAULT_W, height = DEFAULT_H, variantOffset = 0 } = {}) {
  const out = []
  for (let i = 0; i < count; i++) {
    const variant = i + variantOffset
    const one = renderVectorBackdrop({ keyword, width, height, variant })
    out.push({
      ...one,
      description: `${one.styleName} · ${keyword || '主题'}矢量背景`,
    })
  }
  return out
}

export function svgToDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

export { STYLES as VECTOR_STYLES }
