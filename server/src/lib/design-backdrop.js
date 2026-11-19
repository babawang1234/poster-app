// 设计底图生成器：用 @napi-rs/canvas 现场生成"虚拟设计背景"。
// 与真实摄影图区分——这是"设计师制作好的抽象设计底图"，用于海报留白排版。
// 无需外部服务、无版权风险、可按关键词匹配主题色。
// 本版本引入多种高级设计风格：流体渐变、孟菲斯拼贴、弥散光晕、噪点纹理、
// 几何构图、网格大字、双色渐变、同心圆射线等，摆脱"纯渐变太简单"的观感。

import { createCanvas } from '@napi-rs/canvas'

// 关键词 → 主题色映射（设计底图配色）
const THEME_COLORS = {
  // 环保/自然 → 绿
  '环保': ['#16a34a', '#86efac', '#052e16'],
  '自然': ['#059669', '#a7f3d0', '#022c22'],
  '森林': ['#15803d', '#4ade80', '#052e16'],
  '绿色': ['#22c55e', '#86efac', '#052e16'],
  // 科技 → 蓝紫
  '科技': ['#2563eb', '#6366f1', '#1e1b4b'],
  'AI': ['#4f46e5', '#8b5cf6', '#1e1b4b'],
  '人工智能': ['#6d28d9', '#a78bfa', '#2e1065'],
  '智能': ['#3b82f6', '#60a5fa', '#172554'],
  // 咖啡/美食 → 暖棕
  '咖啡': ['#92400e', '#d97706', '#431407'],
  '美食': ['#ea580c', '#fbbf24', '#431407'],
  '餐饮': ['#dc2626', '#f87171', '#450a0a'],
  '咖啡店': ['#a16207', '#eab308', '#422006'],
  // 金融 → 金
  '金融': ['#b45309', '#facc15', '#422006'],
  '理财': ['#ca8a04', '#fde047', '#3f2d06'],
  // 招聘/商务 → 蓝灰
  '招聘': ['#1d4ed8', '#38bdf8', '#0c1a3a'],
  '商务': ['#334155', '#64748b', '#0f172a'],
  '求职': ['#2563eb', '#7dd3fc', '#0c1a3a'],
  // 医疗/健康 → 青
  '医疗': ['#0891b2', '#67e8f9', '#083344'],
  '健康': ['#0d9488', '#5eead4', '#042f2e'],
  // 美妆 → 粉
  '美妆': ['#db2777', '#f9a8d4', '#500724'],
  '护肤': ['#ec4899', '#fbcfe8', '#500724'],
  // 母婴 → 柔粉
  '母婴': ['#f472b6', '#fbcfe8', '#4a0e2e'],
  '亲子': ['#fb7185', '#fecdd3', '#4c0519'],
  // 教育 → 蓝
  '教育': ['#0369a1', '#7dd3fc', '#082f49'],
  '学习': ['#1e40af', '#93c5fd', '#172554'],
  // 房产 → 蓝灰金
  '房产': ['#1e3a5f', '#93c5fd', '#0b1e33'],
  // 婚庆 → 红金
  '婚庆': ['#dc2626', '#fca5a5', '#450a0a'],
  '婚礼': ['#e11d48', '#fda4af', '#4c0519'],
  // 旅游 → 蓝绿
  '旅游': ['#0284c7', '#5eead4', '#082f49'],
  '旅行': ['#0ea5e9', '#86efac', '#082f49'],
  // 音乐 → 紫
  '音乐': ['#7c3aed', '#c4b5fd', '#2e1065'],
  // 汽车 → 深灰
  '汽车': ['#374151', '#9ca3af', '#111827'],
  // 运动 → 橙
  '运动': ['#ea580c', '#fdba74', '#431407'],
  '健身': ['#f97316', '#fdba74', '#431407'],
  // 宠物 → 暖
  '宠物': ['#f59e0b', '#fde68a', '#451a03'],
  // 节日 → 红
  '节日': ['#dc2626', '#fca5a5', '#450a0a'],
  '春节': ['#dc2626', '#fbbf24', '#450a0a'],
  '春天': ['#16a34a', '#fde047', '#14532d'],
  '冬天': ['#0284c7', '#e0f2fe', '#082f49'],
  // 情人节 / 爱情 → 浪漫暖红粉金（不再落到默认蓝紫）
  '情人节': ['#e11d48', '#fb7185', '#4c0519'],
  '七夕': ['#e11d48', '#f9a8d4', '#4c0519'],
  '520': ['#e11d48', '#fb7185', '#4c0519'],
  '告白': ['#e11d48', '#fb7185', '#4c0519'],
  '爱情': ['#e11d48', '#fb7185', '#4c0519'],
  '恋爱': ['#e11d48', '#f9a8d4', '#4c0519'],
  '玫瑰': ['#dc2626', '#fb7185', '#450a0a'],
  '爱心': ['#e11d48', '#fb7185', '#4c0519'],
  '情侣': ['#e11d48', '#f9a8d4', '#4c0519'],
  '浪漫': ['#db2777', '#f9a8d4', '#500724'],
  // 其他节日
  '圣诞': ['#dc2626', '#86efac', '#1a2e05'],
  '圣诞节': ['#dc2626', '#86efac', '#1a2e05'],
  '中秋': ['#b45309', '#fde68a', '#1c1917'],
  '国庆': ['#dc2626', '#fbbf24', '#450a0a'],
  '母亲节': ['#db2777', '#f9a8d4', '#500724'],
  '父亲节': ['#1d4ed8', '#93c5fd', '#0c1a3a'],
  '感恩': ['#b45309', '#fde68a', '#1c1917'],
  // 艺术
  '艺术': ['#9333ea', '#f472b6', '#2e1065'],
  '设计': ['#6366f1', '#22d3ee', '#1e1b4b'],
  // 水厂 / 工厂 / 工业 → 青蓝工业风（不再是默认蓝紫，且区别于"水"的海洋蓝）
  '水厂': ['#0891b2', '#67e8f9', '#0c1a2e'],
  '净水': ['#0ea5e9', '#a5f3fc', '#082f49'],
  '水处理': ['#0284c7', '#7dd3fc', '#082f49'],
  '污水处理': ['#0e7490', '#a5f3fc', '#0c1a2e'],
  '水务': ['#0891b2', '#67e8f9', '#0c1a2e'],
  '工厂': ['#475569', '#94a3b8', '#0f172a'],
  '工业': ['#334155', '#64748b', '#0f172a'],
  '制造': ['#475569', '#cbd5e1', '#0f172a'],
  '车间': ['#475569', '#94a3b8', '#0f172a'],
  // 茶 / 奶茶 → 暖棕青绿（茶香雅致，区别于咖啡的深棕）
  '茶': ['#0f766e', '#a7f3d0', '#0c1a1a'],
  '茶叶': ['#15803d', '#bbf7d0', '#052e16'],
  '龙井': ['#16a34a', '#bbf7d0', '#052e16'],
  '绿茶': ['#16a34a', '#bbf7d0', '#052e16'],
  '红茶': ['#b45309', '#fcd34d', '#3f1d0a'],
  '奶茶': ['#c77b30', '#f5d0a9', '#3a2412'],
  '茶饮': ['#0f766e', '#a7f3d0', '#0c1a1a'],
  // 火锅 / 美食 → 暖红橙（麻辣热烈）
  '火锅': ['#dc2626', '#fb923c', '#450a0a'],
  '麻辣': ['#dc2626', '#fb923c', '#450a0a'],
  // 马拉松 / 跑步 → 活力橙红
  '马拉松': ['#ea580c', '#fdba74', '#431407'],
  '跑步': ['#ea580c', '#fdba74', '#431407'],
  // 鲜花 → 粉紫
  '鲜花': ['#db2777', '#f9a8d4', '#500724'],
  '花': ['#ec4899', '#fbcfe8', '#500724'],
  // 春节 / 新年 / 国风 → 红金
  '春节': ['#dc2626', '#fbbf24', '#450a0a'],
  '新年': ['#dc2626', '#fbbf24', '#450a0a'],
  '国风': ['#b91c1c', '#fbbf24', '#1c1917'],
  '端午': ['#16a34a', '#fde047', '#14532d'],
  '中秋': ['#b45309', '#fde68a', '#1c1917'],
}

export const DEFAULT_THEME = ['#7c5cff', '#38d9f5', '#1e1b4b']

export function pickTheme(keyword) {
  const q = String(keyword || '').toLowerCase()
  for (const [key, colors] of Object.entries(THEME_COLORS)) {
    if (q.includes(key)) return colors
  }
  return DEFAULT_THEME
}

function hexToRgb(hex) {
  const raw = hex.replace('#', '')
  return [parseInt(raw.slice(0, 2), 16), parseInt(raw.slice(2, 4), 16), parseInt(raw.slice(4, 6), 16)]
}
function rgba(hex, a) {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r},${g},${b},${a})`
}
function lerpColor(c1, c2, t) {
  const [r1, g1, b1] = hexToRgb(c1)
  const [r2, g2, b2] = hexToRgb(c2)
  const r = Math.round(r1 + (r2 - r1) * t)
  const g = Math.round(g1 + (g2 - g1) * t)
  const b = Math.round(b1 + (b2 - b1) * t)
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

// 色相旋转：让同一主题下的多张底图配色有区分度，
// 否则 8 种图案共用一套配色，视觉上仍然"看起来都一样"。
function shiftHue(hex, deg) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
  }
  h = ((h + deg / 360) % 1 + 1) % 1
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  let nr = l
  let ng = l
  let nb = l
  if (s !== 0) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    nr = hue2rgb(p, q, h + 1 / 3)
    ng = hue2rgb(p, q, h)
    nb = hue2rgb(p, q, h - 1 / 3)
  }
  return `#${[nr, ng, nb].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`
}

// ============================================================================
// 设计底图引擎 v2 —— 方法论来源（已检索并提炼自 GitHub 开源设计 Skill）：
//   · anthropics/skills / canvas-design  —— 先确立「视觉哲学」再表达；严格有限配色、
//     大量负空间、精确边距、系统性极简标记、纸纹质感、元素绝不溢出画布。
//   · anthropics/skills / algorithmic-art —— 种子随机（seeded randomness）、多八度噪声场、
//     流场粒子轨迹、密度累积、参数化受控混沌；颜色由密度/速度涌现。
// 落地为纯服务端、零外部依赖、确定性可复现的程序化设计引擎：
//   同一「关键词 + variant」永远出同一张图（成组统一），不同 variant 有真实差异，
//   且每张都强制预留标题安全区，直接可用作海报底图。
// ============================================================================

// —— 种子随机（algorithmic-art 的可复现性要求）——
function hash32(str) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
// 二维值噪声 + 多八度叠加（fbm）：产生湍流区与静区，而非均匀随机噪点
const noiseLattice = (ix, iy, seed) => {
  let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041)
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}
function valueNoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = x - ix, fy = y - iy
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy)
  const a = noiseLattice(ix, iy, seed), b = noiseLattice(ix + 1, iy, seed)
  const c = noiseLattice(ix, iy + 1, seed), d = noiseLattice(ix + 1, iy + 1, seed)
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy
}
function fbm(x, y, seed, octaves = 4) {
  let sum = 0, amp = 0.5, freq = 1
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, y * freq, seed + i * 977) * amp
    amp *= 0.5
    freq *= 2
  }
  return sum
}

// —— 视觉哲学：由关键词语义 + variant 共同决定构成语汇，而非套固定模板 ——
// 每套哲学 = 有限配色 + 形状语汇 + 留白比例 + 运动参数。
const PHILOSOPHIES = [
  { key: 'organic', name: 'Organic Systems', tests: /环保|自然|森林|山|水|海洋|生态|绿|春|花|茶|植物|旅行|风景/u, vocab: 'flow', safe: 0.42 },
  { key: 'silence', name: 'Geometric Silence', tests: /科技|AI|人工智能|数字|数据|代码|芯片|智能|建筑|城市/u, vocab: 'grid', safe: 0.46 },
  { key: 'meditation', name: 'Analog Meditation', tests: /咖啡|美食|餐饮|书|阅读|教育|烘焙|甜|面包|火锅/u, vocab: 'diffuse', safe: 0.50 },
  { key: 'chromatic', name: 'Chromatic Language', tests: /情人节|爱情|玫瑰|浪漫|春节|新年|节日|婚|中秋|国风|艺术|设计/u, vocab: 'fields', safe: 0.44 },
  { key: 'concrete', name: 'Concrete Poetry', tests: /金融|商务|招聘|企业|办公|房产|理财|工业|工厂|制造|汽车/u, vocab: 'blocks', safe: 0.48 },
  { key: 'harmonics', name: 'Quantum Harmonics', tests: /音乐|演唱会|运动|健身|马拉松|跑步|节|庆典/u, vocab: 'contours', safe: 0.45 },
]
function derivePhilosophy(keyword, variant, rng, philosophyIndex) {
  const q = String(keyword || '')
  const matched = PHILOSOPHIES.filter((p) => p.tests.test(q))
  // philosophyIndex：一键成片可为同批的每张图强制指定不同哲学，保证视觉差异极大；
  // 未指定时命中语义优先，否则按 variant 在 6 套之间轮换。
  const base = Number.isInteger(philosophyIndex)
    ? PHILOSOPHIES[philosophyIndex % PHILOSOPHIES.length]
    : (matched.length ? matched[variant % matched.length] : PHILOSOPHIES[variant % PHILOSOPHIES.length])
  return {
    ...base,
    // 受控混沌：密度/尺度/旋转都由种子决定，同一 variant 稳定复现
    density: 0.75 + rng() * 0.5,
    scale: 0.9 + rng() * 0.7,
    rotation: (rng() - 0.5) * 0.8,
    accent: rng() > 0.5 ? 0 : 1,
  }
}

// 生成一张"设计底图"PNG，返回 Buffer。
export function renderDesignBackdrop({ keyword, width = 1080, height = 1440, variant = 0, philosophyIndex }) {
  const [t1, t2, t3] = pickTheme(keyword)
  const seed = hash32(`${keyword}|${variant}|${philosophyIndex ?? 'auto'}`)
  const rng = mulberry32(seed)
  const ph = derivePhilosophy(keyword, variant, rng, philosophyIndex)
  // 有限配色：主题 3 色 + 温和色相偏移（±20° 内），绝不引入第四种随机色
  const rot = ((variant % 5) - 2) * 5
  const c1 = shiftHue(t1, rot)
  const c2 = shiftHue(t2, rot * 0.6)
  const c3 = t3
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')

  // 1) 底色：深色基底 + 极缓的垂直明度渐变，避免死板的纯色填充
  const bg = ctx.createLinearGradient(0, 0, width * 0.35, height)
  bg.addColorStop(0, c3)
  bg.addColorStop(1, lerpColor(c3, '#000000', 0.18))
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, width, height)

  // 2) 主体构成语汇
  switch (ph.vocab) {
    case 'flow': renderFlowField(ctx, width, height, c1, c2, ph, seed); break
    case 'grid': renderSwissGrid(ctx, width, height, c1, c2, ph, rng); break
    case 'diffuse': renderChromaticDiffuse(ctx, width, height, c1, c2, ph, rng); break
    case 'fields': renderColorFields(ctx, width, height, c1, c2, ph, rng); break
    case 'blocks': renderMonolith(ctx, width, height, c1, c2, ph, rng); break
    default: renderContours(ctx, width, height, c1, c2, ph, seed); break
  }

  // 3) 强制标题安全区：海报文字主要落在中下部，用柔和暗场把该区域的对比度压下来，
  //    让底图"设计感强"但"不抢文字"——这是"底图不精准"的关键修正。
  renderSafeArea(ctx, width, height, ph.safe, c3)

  // 4) 系统性极简标记（canvas-design：sparse clinical typography / systematic markers）
  renderSystemMarks(ctx, width, height, variant, ph.name, rng)

  // 5) 确定性纸纹颗粒（不再用 Math.random，保证可复现）
  addGrain(ctx, width, height, 0.05, rng)

  return canvas.toBuffer('image/png')
}

// —— 语汇 1：流场粒子轨迹（algorithmic-art 的 flow field / density accumulation）——
function renderFlowField(ctx, w, h, c1, c2, ph, seed) {
  const particles = Math.round(420 * ph.density)
  const steps = 42
  ctx.lineCap = 'round'
  for (let p = 0; p < particles; p++) {
    let x = (p / particles) * w + (noiseLattice(p, 7, seed) - 0.5) * w * 0.12
    let y = noiseLattice(p, 19, seed) * h
    ctx.beginPath()
    ctx.moveTo(x, y)
    for (let s = 0; s < steps; s++) {
      // 多八度噪声驱动方向，产生湍流带与静区的对比
      const n = fbm(x / (w * 0.28 * ph.scale), y / (h * 0.28 * ph.scale), seed, 3)
      const angle = n * Math.PI * 4 + ph.rotation
      x += Math.cos(angle) * (w * 0.011)
      y += Math.sin(angle) * (h * 0.009)
      if (x < 0 || x > w || y < 0 || y > h) break
      ctx.lineTo(x, y)
    }
    // 颜色随粒子序号在 2 色间交替，透明度低 → 密度累积出层次
    ctx.strokeStyle = rgba(p % 3 === 0 ? c2 : c1, 0.10 + (p % 5) * 0.014)
    ctx.lineWidth = 0.7 + (p % 7) * 0.18
    ctx.stroke()
  }
  // 一处聚焦光晕，作为视觉锚点（构图重心）
  const gx = w * (0.3 + ph.accent * 0.4), gy = h * 0.34
  const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, w * 0.55)
  g.addColorStop(0, rgba(c1, 0.30))
  g.addColorStop(1, rgba(c1, 0))
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
}

// —— 语汇 2：瑞士网格 + 精确刻度（Geometric Silence）——
function renderSwissGrid(ctx, w, h, c1, c2, ph, rng) {
  const cols = 8, rows = 11
  const m = w * 0.075
  const cw = (w - m * 2) / cols, ch = (h - m * 2) / rows
  // 极细网格线：秩序感，而非装饰
  ctx.strokeStyle = rgba('#ffffff', 0.055)
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = 0; i <= cols; i++) { ctx.moveTo(m + i * cw, m); ctx.lineTo(m + i * cw, h - m) }
  for (let j = 0; j <= rows; j++) { ctx.moveTo(m, m + j * ch); ctx.lineTo(w - m, m + j * ch) }
  ctx.stroke()
  // 少量色块（严格对齐网格交点），体现「有限信息、精确放置」
  const blockCount = 5 + Math.floor(rng() * 3)
  for (let i = 0; i < blockCount; i++) {
    const cx = m + Math.floor(rng() * cols) * cw
    const cy = m + Math.floor(rng() * rows) * ch
    const bw = cw * (1 + Math.floor(rng() * 2))
    const bh = ch * (1 + Math.floor(rng() * 3))
    ctx.fillStyle = rgba(i % 2 ? c1 : c2, 0.12 + rng() * 0.18)
    ctx.fillRect(cx, cy, Math.min(bw, w - m - cx), Math.min(bh, h - m - cy))
  }
  // 节点圆环：科学图谱语言
  ctx.strokeStyle = rgba(c1, 0.5)
  for (let i = 0; i < 9; i++) {
    const nx = m + Math.floor(rng() * (cols + 1)) * cw
    const ny = m + Math.floor(rng() * (rows + 1)) * ch
    ctx.beginPath(); ctx.arc(nx, ny, 2 + rng() * 4, 0, Math.PI * 2); ctx.lineWidth = 1.2; ctx.stroke()
  }
}

// —— 语汇 3：弥散光域 + 大留白（Analog Meditation）——
function renderChromaticDiffuse(ctx, w, h, c1, c2, ph, rng) {
  const glows = [
    { x: 0.28, y: 0.26, r: 0.85, c: c1, a: 0.55 },
    { x: 0.78, y: 0.18, r: 0.60, c: c2, a: 0.38 },
    { x: 0.62, y: 0.72, r: 0.70, c: c1, a: 0.26 },
  ]
  for (const g0 of glows) {
    const r = Math.max(w, h) * g0.r * ph.scale
    const g = ctx.createRadialGradient(w * g0.x, h * g0.y, 0, w * g0.x, h * g0.y, r)
    g.addColorStop(0, rgba(g0.c, g0.a))
    g.addColorStop(0.55, rgba(g0.c, g0.a * 0.35))
    g.addColorStop(1, rgba(g0.c, 0))
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h)
  }
  // 一条极细的水平分割线：纸本印刷的克制感
  ctx.strokeStyle = rgba('#ffffff', 0.12); ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(w * 0.12, h * 0.62); ctx.lineTo(w * 0.88, h * 0.62); ctx.stroke()
}

// —— 语汇 4：Albers 式色域交互（Chromatic Language）——
function renderColorFields(ctx, w, h, c1, c2, ph, rng) {
  const m = w * 0.09
  const bands = 4
  for (let i = 0; i < bands; i++) {
    const x = m + (i * (w - m * 2)) / bands
    const bw = (w - m * 2) / bands
    const mix = i / (bands - 1)
    const col = lerpColor(c1, c2, mix)
    ctx.fillStyle = rgba(col, 0.20 + 0.18 * mix)
    ctx.fillRect(x, m + h * (0.08 + 0.05 * i), bw, h * (0.52 - 0.06 * i))
  }
  // 内嵌矩形：色彩相互作用产生深度
  ctx.fillStyle = rgba(c1, 0.30)
  ctx.fillRect(w * 0.28, h * 0.30, w * 0.44, h * 0.20)
  ctx.fillStyle = rgba('#ffffff', 0.06)
  ctx.fillRect(w * 0.36, h * 0.35, w * 0.28, h * 0.10)
}

// —— 语汇 5：纪念碑式色块（Concrete Poetry）——
function renderMonolith(ctx, w, h, c1, c2, ph, rng) {
  const m = w * 0.08
  ctx.fillStyle = rgba(c1, 0.55)
  ctx.fillRect(m, h * 0.10, w * 0.30, h * 0.46)
  ctx.fillStyle = rgba(c2, 0.32)
  ctx.fillRect(m + w * 0.30, h * 0.22, w * 0.62 - m, h * 0.26)
  ctx.fillStyle = rgba('#ffffff', 0.05)
  ctx.fillRect(w * 0.62, h * 0.10, w * 0.30, h * 0.08)
  // 硬边细线强调结构
  ctx.strokeStyle = rgba('#ffffff', 0.18); ctx.lineWidth = 1.5
  ctx.beginPath(); ctx.moveTo(m, h * 0.56); ctx.lineTo(w - m, h * 0.56); ctx.stroke()
}

// —— 语汇 6：等值线地形（Quantum Harmonics 的干涉图样）——
function renderContours(ctx, w, h, c1, c2, ph, seed) {
  const lines = 22
  for (let i = 0; i < lines; i++) {
    const baseY = h * (0.10 + (i / lines) * 0.66)
    ctx.beginPath()
    for (let x = 0; x <= w; x += 8) {
      const n = fbm(x / (w * 0.16 * ph.scale), (i + 1) * 0.32, seed, 3)
      const y = baseY + (n - 0.5) * h * 0.14 * (1 + i * 0.02)
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    ctx.strokeStyle = rgba(i % 3 === 0 ? c2 : c1, 0.10 + (i % 6) * 0.022)
    ctx.lineWidth = 0.9 + (i % 4) * 0.35
    ctx.stroke()
  }
}

// 标题安全区：中下部柔和压暗，保证叠字可读（不是硬遮罩，保留底图纹理）
function renderSafeArea(ctx, w, h, strength, c3) {
  const g = ctx.createLinearGradient(0, h * 0.34, 0, h)
  g.addColorStop(0, rgba(c3, 0))
  g.addColorStop(0.55, rgba(c3, strength * 0.55))
  g.addColorStop(1, rgba('#000000', strength * 0.72))
  ctx.fillStyle = g
  ctx.fillRect(0, h * 0.34, w, h * 0.66)
}

// 系统性极简标记：角标编号 + 细刻度，克制且不越界
function renderSystemMarks(ctx, w, h, variant, label, rng) {
  const m = w * 0.075
  ctx.strokeStyle = rgba('#ffffff', 0.18)
  ctx.lineWidth = 1
  // 左上短刻度
  ctx.beginPath(); ctx.moveTo(m, m); ctx.lineTo(m + w * 0.06, m); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(m, m); ctx.lineTo(m, m + w * 0.06); ctx.stroke()
  // 右下角对齐线
  ctx.beginPath(); ctx.moveTo(w - m, h - m); ctx.lineTo(w - m - w * 0.06, h - m); ctx.stroke()
  // 侧边一排细刻度（科学图谱感）
  for (let i = 0; i < 12; i++) {
    const y = m + (i / 12) * (h - m * 2)
    const len = i % 4 === 0 ? w * 0.018 : w * 0.008
    ctx.beginPath(); ctx.moveTo(w - m, y); ctx.lineTo(w - m - len, y); ctx.stroke()
  }
  // 极简编号（ASCII，避免中文字体依赖）；字体不可用时静默跳过，不影响整张底图
  try {
    ctx.fillStyle = rgba('#ffffff', 0.30)
    ctx.font = `${Math.max(10, Math.round(w * 0.012))}px sans-serif`
    ctx.fillText(`PLATE ${String(variant + 1).padStart(2, '0')}`, m + 2, h - m - 10)
  } catch { /* 云端字体缺失时仅省略编号 */ }
}

// 确定性纸纹颗粒
function addGrain(ctx, w, h, alpha, rng) {
  ctx.globalAlpha = alpha
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = rng() > 0.5 ? '#ffffff' : '#000000'
    ctx.fillRect(rng() * w, rng() * h, 1.2, 1.2)
  }
  ctx.globalAlpha = 1
}

// 生成多张设计底图（不同 variant）
// variantOffset 用于让不同请求拿到不同的起始风格（一键成片等单图场景可随机化）
export function generateDesignBackdrops(keyword, { count = 4, width = 1080, height = 1440, variantOffset = 0, distinct = false } = {}) {
  const backdrops = []
  for (let i = 0; i < count; i++) {
    const variant = variantOffset + i
    // distinct：同批每张强制不同哲学，避免「几张看起来都一样」
    const philosophyIndex = distinct ? (variantOffset + i) % PHILOSOPHIES.length : undefined
    const buf = renderDesignBackdrop({ keyword, width, height, variant, philosophyIndex })
    backdrops.push({
      id: `design-${Date.now()}-${variant}-${i}`,
      provider: 'design',
      sourceName: '设计底图',
      description: `${keyword} · 设计背景 ${variant + 1}`,
      buffer: buf,
      width,
      height,
      variant,
      license: '设计底图 · 可商用',
    })
  }
  return backdrops
}
