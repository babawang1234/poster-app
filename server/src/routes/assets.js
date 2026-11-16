import { Router } from 'express'
import { authRequired } from '../middleware/auth.js'
import { asyncHandler } from '../lib/http.js'
import { config } from '../config/index.js'
import { searchAssetImages, searchDesignAssets } from '../services/asset-search.js'
import { generateDesignBackdrops } from '../lib/design-backdrop.js'
import { encodeBufferToDataUrl } from '../lib/renderer.js'
import { getCachedGeneration, setCachedGeneration } from '../lib/gen-cache.js'
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
  // skipAi=1：素材融合模式下 AI 由前端并行单独发起，这里跳过以免把整体响应拖到 30 秒以上
  const skipAi = req.query.skipAi === '1'
  const result = await searchAssetImages({ query, originalQuery, orientation, perPage: limit })

  // 关键兜底：图库 + 本地池都无命中时（aiFallback），用真实 AI 生图按关键词生成贴题图，
  // 解决"换任意关键词搜不出、图文不符"的根本问题（AI 能理解"水厂"等具体实体词）。
  //
  // 三层策略（面向大众，避免免费额度被并发打爆）：
  //   1) 落盘缓存命中 → 直接复用，不消耗额度
  //   2) 智谱 CogView-3-Flash（免费、中文理解强、一次真出多张不同图）
  //   3) Pollinations 兜底（无 Key 时，1 真图 + 像素变体）
  let aiGeneratedPhotos = []
  if (!skipAi && result.aiFallback && result.photos.length === 0) {
    try {
      const { keywordToImagePrompt } = await import('../lib/image-prompt.js')
      const prompt = keywordToImagePrompt(query)
      if (prompt) {
        // 层 1：缓存命中
        const cached = getCachedGeneration(query, 1080, 1440)
        if (cached && cached.length) {
          aiGeneratedPhotos = cached.map((buf, i) => {
            const dataUrl = encodeBufferToDataUrl(buf, 'image/jpeg')
            return {
              id: `ai-cache-${Date.now()}-${i}`,
              provider: 'ai',
              sourceName: 'AI 生成',
              description: `${query} · AI 生成贴题图 ${i + 1}`,
              url: dataUrl, thumb: dataUrl,
              photographer: 'AI 生成',
              license: 'AI 生成 · 可商用',
            }
          })
        } else {
          // 层 2：智谱免费生图（串行多张不同图，免费档不支持 n 参数）
          const { ZhipuAdapter } = await import('../adapters/zhipu.js')
          const zhipu = new ZhipuAdapter()
          if (zhipu.available) {
            // 免费档串行限速，n=3 约需 30 秒内返回；配合缓存复用，实际只生成一次
            const { urls } = await zhipu.generateImage({ prompt, width: 1080, height: 1440, n: 3 })
            const buffers = await Promise.all(
              urls.map(async (u) => {
                const r = await fetch(u, { signal: AbortSignal.timeout(30000) })
                return Buffer.from(await r.arrayBuffer())
              })
            )
            setCachedGeneration(query, 1080, 1440, buffers)
            aiGeneratedPhotos = buffers.map((buf, i) => {
              const dataUrl = encodeBufferToDataUrl(buf, 'image/jpeg')
              return {
                id: `ai-zhipu-${Date.now()}-${i}`,
                provider: 'ai', sourceName: 'AI 生成',
                description: `${query} · AI 生成贴题图 ${i + 1}`,
                url: dataUrl, thumb: dataUrl,
                photographer: 'AI 生成',
                license: 'AI 生成 · 可商用',
              }
            })
          } else {
            // 层 3：Pollinations 兜底（无 Key 时）
            const { PollinationsAdapter, deriveVariants } = await import('../adapters/pollinations.js')
            const pollinations = new PollinationsAdapter()
            if (pollinations.available) {
              const { buffer } = await pollinations.generateImage({ prompt, width: 1080, height: 1440, seed: Math.floor(Math.random() * 1e9) })
              const variants = await deriveVariants(buffer, 6)
              setCachedGeneration(query, 1080, 1440, variants.map((v) => v.buffer))
              aiGeneratedPhotos = variants.map((v, i) => {
                const dataUrl = encodeBufferToDataUrl(v.buffer, 'image/jpeg')
                return {
                  id: `ai-search-${Date.now()}-${i}`,
                  provider: 'ai', sourceName: 'AI 生成',
                  description: `${query} · AI 生成贴题图 ${i + 1}`,
                  url: dataUrl, thumb: dataUrl,
                  photographer: 'AI 生成',
                  license: 'AI 生成 · 可商用',
                }
              })
            }
          }
        }
      }
    } catch (e) {
      console.warn('[assets] AI 兜底生图失败：', e.message)
    }
  }

  // 「设计底图」已被矢量背景取代：canvas 栅格化既慢又比 SVG 更重，仅保留 withDesign=1 的兼容开关，
  // 默认不再生成，避免每次检索都白白占用 CPU 与响应体积。
  let designBackdrops = []
  if (req.query.withDesign === '1') {
    try {
      const count = 6
      const backdrops = generateDesignBackdrops(query, { count })
      designBackdrops = backdrops.map((b) => {
        const dataUrl = encodeBufferToDataUrl(b.buffer, 'image/png')
        return {
          id: b.id,
          provider: 'design',
          sourceName: '设计底图',
          description: b.description,
          url: dataUrl,
          thumb: dataUrl,
          photographer: '幻象工坊 · 设计库',
          license: '设计底图 · 可商用',
          kind: 'design',
          width: b.width,
          height: b.height,
        }
      })
    } catch (e) {
      console.warn('[assets] 设计底图生成失败：', e.message)
    }
  }

  const photos = [...result.photos, ...aiGeneratedPhotos]

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
    aiFallback: !!aiGeneratedPhotos.length,
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

// 单独获取"设计底图"（虚拟背景）——供「设计底图」Tab 使用
router.get('/design-backdrops', asyncHandler(async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 100)
  if (!query) return res.json({ backdrops: [] })
  const count = Math.min(12, Math.max(4, Number(req.query.count) || 8))

  // 优先：从 Pixabay 搜真实设计类素材（abstract/pattern/texture），有设计感且区别于摄影图
  let designAssets = []
  try {
    designAssets = await searchDesignAssets(query, { count })
  } catch (e) {
    console.warn('[design-backdrops] 图库设计素材获取失败：', e.message)
  }

  // 兜底：程序化生成设计底图（渐变/孟菲斯/几何等），保证任何关键词都能出图
  const backdrops = generateDesignBackdrops(query, { count })

  const programmatic = backdrops.map((b) => {
    const dataUrl = encodeBufferToDataUrl(b.buffer, 'image/png')
    return {
      id: b.id,
      provider: 'design',
      sourceName: '设计底图',
      description: b.description,
      url: dataUrl,
      thumb: dataUrl,
      photographer: '幻象工坊 · 设计库',
      license: '设计底图 · 可商用',
      kind: 'design',
      width: b.width,
      height: b.height,
    }
  })

  // 真实设计素材在前（更有设计感），程序化生成在后（兜底）
  const items = [...designAssets, ...programmatic]
  res.json({ backdrops: items, fromGallery: !!designAssets.length })
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
