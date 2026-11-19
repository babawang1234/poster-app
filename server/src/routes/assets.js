import { Router } from 'express'
import { authRequired } from '../middleware/auth.js'
import { asyncHandler } from '../lib/http.js'
import { config } from '../config/index.js'
import { searchAssetImages } from '../services/asset-search.js'
import { generateDesignBackdrops } from '../lib/design-backdrop.js'
import { scrapeImages, scraperStatus, ScrapeError, validateTarget } from '../lib/scraper.js'
import { generateVectorBackdrops } from '../lib/vector-backdrop.js'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { genId } from '../lib/util.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const router = Router()
router.use(authRequired)

const VECTOR_DIR = path.resolve(__dirname, '../../public/vector-backdrops')
const DESIGN_DIR = path.resolve(__dirname, '../../public/design-backdrops')

/**
 * 生成「设计底图」并落盘，返回站内 URL。
 * 引擎已按 GitHub 开源设计 Skill（canvas-design / algorithmic-art）的方法论重写：
 * 视觉哲学驱动 + 种子随机 + 噪声流场 + 有限配色 + 强制留白，且每张强制不同哲学。
 * 落盘而非 data URL：响应轻、可被浏览器缓存、海报导出时渲染器可直接按站内路径读取。
 */
function persistDesignBackdrops(keyword, { count = 6, width = 1080, height = 1440, variantOffset = 0 } = {}) {
  const items = generateDesignBackdrops(keyword, { count, width, height, variantOffset, distinct: true })
  try {
    fs.mkdirSync(DESIGN_DIR, { recursive: true })
  } catch {}
  return items.map((b) => {
    const url = `/design-backdrops/${b.id}.png`
    const file = path.join(DESIGN_DIR, `${b.id}.png`)
    try {
      if (!fs.existsSync(file)) fs.writeFileSync(file, b.buffer)
    } catch (e) {
      console.warn('[assets] 设计底图落盘失败：', e.message)
    }
    return {
      id: b.id,
      provider: 'design',
      sourceName: '设计底图',
      description: b.description,
      url,
      thumb: url,
      photographer: '幻象工坊 · 设计库',
      license: '设计底图 · 可商用',
      kind: 'design',
      width: b.width,
      height: b.height,
    }
  })
}

/**
 * 生成矢量背景并落盘，返回可直接给 <img> 用的站内路径。
 * 落盘而非内联 data URL：路径短（存进项目/图层不膨胀数据库）、可被浏览器与 CDN 缓存。
 */
function persistVectorBackdrops(keyword, { count = 6, width = 2160, height = 2880 } = {}) {
  const items = generateVectorBackdrops(keyword, { count, width, height })
  try {
    fs.mkdirSync(VECTOR_DIR, { recursive: true })
  } catch {}
  return items.map((v) => {
    const url = `/vector-backdrops/${v.id}.svg`
    const file = path.join(VECTOR_DIR, `${v.id}.svg`)
    try {
      if (!fs.existsSync(file)) fs.writeFileSync(file, v.svg, 'utf8')
    } catch (e) {
      console.warn('[assets] 矢量背景落盘失败：', e.message)
    }
    return {
      id: v.id,
      provider: 'vector',
      sourceName: '矢量背景',
      style: v.style,
      styleName: v.styleName,
      description: v.description,
      colors: v.colors,
      width: v.width,
      height: v.height,
      url,
      thumb: url,
      photographer: '幻象工坊 · 矢量引擎',
      license: '矢量背景 · 可商用 · 无损缩放',
      kind: 'vector',
    }
  })
}

// 图库可用状态：前端据此提前展示引导，而不是让用户搜索后报错
router.get('/status', asyncHandler(async (req, res) => {
  res.json({
    unsplash: !!config.providers.unsplash.accessKey,
    pexels: !!config.providers.pexels.apiKey,
    pixabay: !!config.providers.pixabay.apiKey,
    openverse: true,
    anyConfigured: !!(config.providers.unsplash.accessKey || config.providers.pexels.apiKey || config.providers.pixabay.apiKey),
  })
}))

router.get('/search', asyncHandler(async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 100)
  if (!query) return res.json({ photos: [] })
  const originalQuery = String(req.query.original || '').trim().slice(0, 160)
  const orientation = ['landscape', 'portrait', 'squarish'].includes(req.query.orientation) ? req.query.orientation : undefined
  const limit = Math.min(48, Math.max(12, Number(req.query.limit) || 36))
  const result = await searchAssetImages({ query, originalQuery, orientation, perPage: limit })

  // 素材生成链路已按需求取消 AI 生图能力：AI 生图只用于「一键成片」生成不同背景。
  // 图库无命中时不再触发任何生图模型，改由前端引导用户使用设计底图 / 矢量背景。

  // 设计底图已升级为独立素材来源（GET /assets/design），这里仅保留 withDesign=1 的兼容开关，
  // 默认不再内联生成 PNG data URL，避免每次检索都白白撑大响应体积。
  let designBackdrops = []
  if (req.query.withDesign === '1') {
    try {
      designBackdrops = persistDesignBackdrops(query, { count: 6 })
    } catch (e) {
      console.warn('[assets] 设计底图生成失败：', e.message)
    }
  }

  const photos = result.photos

  // 矢量背景：与图库检索同步返回，前端一次性拿到「实拍 + 矢量」两类候选。
  // 矢量图可控配色、成组统一，是不依赖生图模型的稳定底图来源。
  let vectors = []
  if (req.query.skipVector !== '1') {
    const [vw, vh] =
      orientation === 'landscape' ? [2880, 2160] : orientation === 'squarish' ? [2400, 2400] : [2160, 2880]
    try {
      vectors = persistVectorBackdrops(query, { count: Number(req.query.vectorCount) || 6, width: vw, height: vh })
    } catch (e) {
      console.warn('[assets] 矢量背景生成失败：', e.message)
    }
  }

  res.json({
    ...result,
    photos,
    aiFallback: false,
    message: photos.length || vectors.length ? '' : result.message,
    designBackdrops,
    vectors,
  })
}))

// 单独获取矢量背景：毫秒级返回，前端可让它先于图库检索上屏，避免用户干等外部图库
router.get('/vector', asyncHandler(async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 100)
  if (!query) return res.json({ vectors: [] })
  const orientation = ['landscape', 'portrait', 'squarish'].includes(req.query.orientation)
    ? req.query.orientation
    : 'portrait'
  const count = Math.min(12, Math.max(2, Number(req.query.count) || 6))
  const [vw, vh] =
    orientation === 'landscape' ? [2880, 2160] : orientation === 'squarish' ? [2400, 2400] : [2160, 2880]
  const vectors = persistVectorBackdrops(query, { count, width: vw, height: vh })
  res.json({ vectors })
}))

// 单独获取「设计底图」——升级后的哲学驱动引擎，每张强制不同构成语言。
// 落盘 URL 代替内联 data URL，前端 <img> 直接可用、不撑大响应。
router.get('/design-backdrops', asyncHandler(async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 100)
  if (!query) return res.json({ backdrops: [] })
  const count = Math.min(12, Math.max(2, Number(req.query.count) || 6))
  const orientation = ['landscape', 'portrait', 'squarish'].includes(req.query.orientation)
    ? req.query.orientation
    : 'portrait'
  const [w, h] = orientation === 'landscape' ? [1440, 1080] : orientation === 'squarish' ? [1200, 1200] : [1080, 1440]
  const variantOffset = Number(req.query.offset) || 0
  const backdrops = persistDesignBackdrops(query, { count, width: w, height: h, variantOffset })
  res.json({ backdrops, fromGallery: false, engine: 'design-philosophy-v2' })
}))

// /assets/design 与上面的语义一致，供前端「素材生成」统一入口调用
router.get('/design', asyncHandler(async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 100)
  if (!query) return res.json({ backdrops: [] })
  const count = Math.min(12, Math.max(2, Number(req.query.count) || 6))
  const orientation = ['landscape', 'portrait', 'squarish'].includes(req.query.orientation)
    ? req.query.orientation
    : 'portrait'
  const [w, h] = orientation === 'landscape' ? [1440, 1080] : orientation === 'squarish' ? [1200, 1200] : [1080, 1440]
  const backdrops = persistDesignBackdrops(query, { count, width: w, height: h })
  res.json({ backdrops, engine: 'design-philosophy-v2' })
}))

// Required by Unsplash API guidelines when a user selects a photo for use.
router.post('/select', asyncHandler(async (req, res) => {
  const id = String(req.body?.id || '')
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return res.status(400).json({ error: 'INVALID_PHOTO_ID', message: '素材 ID 无效' })
  if (req.body?.provider === 'unsplash' && config.providers.unsplash.accessKey) {
    const response = await fetch(`https://api.unsplash.com/photos/${encodeURIComponent(id)}/download`, { headers: { Authorization: `Client-ID ${config.providers.unsplash.accessKey}`, 'Accept-Version': 'v1' }, signal: AbortSignal.timeout(6500) })
    if (!response.ok) throw new Error(`Unsplash 素材确认失败（HTTP ${response.status}）`)
  }
  res.json({ ok: true })
}))

// 从指定页面抓取图片（Node 内置实现，含 robots.txt / 内网拦截 / 限速护栏）
router.get('/scraper-status', (req, res) => {
  res.json(scraperStatus())
})

router.post('/scrape', asyncHandler(async (req, res) => {
  const url = String(req.body?.url || '').trim().slice(0, 500)
  if (!url) return res.status(400).json({ error: 'INVALID_URL', message: '请先填写要抓取的页面网址' })
  const max = Math.min(60, Math.max(1, Number(req.body?.max) || 30))

  try {
    const result = await scrapeImages(url, { max })
    res.json(result)
  } catch (err) {
    if (err instanceof ScrapeError) {
      return res.status(err.status || 400).json({ error: 'SCRAPE_FAILED', message: err.message })
    }
    throw err
  }
}))

// 把抓取到的图片下载进本地素材库，之后就当成普通上传图片使用（可作参考图）
const IMAGE_EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

router.post('/scrape-save', asyncHandler(async (req, res) => {
  const imageUrl = String(req.body?.url || '').trim().slice(0, 1000)
  if (!imageUrl) return res.status(400).json({ error: 'INVALID_URL', message: '请提供图片地址' })

  let parsed
  try {
    parsed = validateTarget(imageUrl)
  } catch (err) {
    if (err instanceof ScrapeError) return res.status(err.status || 400).json({ error: 'SCRAPE_FAILED', message: err.message })
    throw err
  }

  const response = await fetch(parsed.toString(), {
    headers: { 'User-Agent': 'PosterStudioBot/1.0', Accept: 'image/*' },
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) {
    return res.status(502).json({ error: 'DOWNLOAD_FAILED', message: `下载图片失败（HTTP ${response.status}）` })
  }

  const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  const ext = IMAGE_EXT_BY_MIME[mime]
  if (!ext) return res.status(400).json({ error: 'NOT_IMAGE', message: '该地址不是支持的图片格式（jpg/png/webp/gif）' })

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > 10 * 1024 * 1024) {
    return res.status(413).json({ error: 'TOO_LARGE', message: '图片超过 10MB，请换一张' })
  }

  fs.mkdirSync(config.uploadDir, { recursive: true })
  const filename = `${genId('up')}${ext}`
  fs.writeFileSync(path.join(config.uploadDir, filename), buffer)

  res.status(201).json({
    file: {
      id: genId('file'),
      filename: path.basename(parsed.pathname) || `scraped${ext}`,
      url: `/uploads/${filename}`,
      mimetype: mime,
      size: buffer.length,
      sourceUrl: parsed.toString(),
    },
  })
}))

export default router
