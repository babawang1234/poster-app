/**
 * 图片代理与磁盘缓存。
 *
 * 背景：国内素材站（堆糖 dtstatic、站酷等）对图片做了 Referer 防盗链。
 * 浏览器从我们自己的域名去加载这些图片时，Referer 是本站域名，
 * 源站直接返回 403，表现为「摄影图一片空白 / 底图看起来全都一样（其实都是破图）」。
 *
 * 做法：前端统一加载 /api/img?u=<原始地址>，由服务端带上源站自己的 Referer 去取图，
 * 取回后落盘缓存，之后同域直出。顺带解决境外图库（Unsplash/Pexels）在国内加载慢的问题。
 *
 * 安全：严格域名白名单 + 内网地址拦截 + 体积与耗时上限，避免被当成任意 URL 的开放代理。
 */
import crypto from 'crypto'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { isIP } from 'net'
import { lookup } from 'dns/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const CACHE_DIR = path.resolve(__dirname, '../../cache/images')
const MAX_BYTES = 8 * 1024 * 1024
const FETCH_TIMEOUT = 15000
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

// 允许代理的图源域名后缀。新增图源时在这里追加，其余一律拒绝。
const ALLOWED_SUFFIXES = [
  'unsplash.com',
  'pexels.com',
  'pixabay.com',
  'dtstatic.com',
  'duitang.com',
  'zcool.com.cn',
  'zcool.cn',
  'pinimg.com',
  'alicdn.com',
  'hdslb.com',
  'qpic.cn',
  'byteimg.com',
]

export const PROXY_PATH = '/api/img'

/** 把外部图片地址改写为本站代理地址；data: / 站内相对路径 / 非 http(s) 原样返回。 */
export function proxyUrl(url) {
  if (typeof url !== 'string' || !url) return url
  if (url.startsWith('data:') || url.startsWith('/')) return url
  if (!/^https?:\/\//i.test(url)) return url
  return `${PROXY_PATH}?u=${encodeURIComponent(url)}`
}

/** 若 src 是代理地址，取出原始外部 URL；否则返回 null。 */
export function unwrapProxyUrl(src) {
  if (typeof src !== 'string') return null
  if (!src.startsWith(`${PROXY_PATH}?u=`)) return null
  try {
    const raw = decodeURIComponent(src.slice(`${PROXY_PATH}?u=`.length).split('&')[0])
    return /^https?:\/\//i.test(raw) ? raw : null
  } catch {
    return null
  }
}

function hostAllowed(hostname) {
  const host = hostname.toLowerCase()
  return ALLOWED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

function isPrivateAddress(address) {
  const a = address.toLowerCase()
  if (a.includes(':')) {
    if (a.startsWith('::ffff:')) return isPrivateAddress(a.slice(7))
    return a === '::1' || a === '::' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80')
  }
  const p = a.split('.').map(Number)
  if (p.length !== 4) return true
  if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
  if (p[0] === 192 && p[1] === 168) return true
  if (p[0] === 169 && p[1] === 254) return true
  if (p[0] >= 224) return true
  return false
}

async function assertSafeTarget(target) {
  const url = new URL(target)
  if (!/^https?:$/.test(url.protocol)) throw new Error('仅支持 http(s) 图片源')
  if (url.username || url.password) throw new Error('不允许带凭证的地址')
  if (!hostAllowed(url.hostname)) throw new Error(`图源域名不在白名单：${url.hostname}`)
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true })
  if (!addresses.length) throw new Error('图源域名解析失败')
  if (addresses.some(({ address }) => isPrivateAddress(address))) throw new Error('不允许访问内网地址')
  return url
}

function extFromContentType(ct, target) {
  const map = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/avif': '.avif',
  }
  const base = String(ct || '').split(';')[0].trim().toLowerCase()
  if (map[base]) return map[base]
  const m = /\.(jpe?g|png|webp|gif|avif)(?:$|\?)/i.exec(target)
  return m ? `.${m[1].toLowerCase().replace('jpeg', 'jpg')}` : '.jpg'
}

const MIME = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
}

function cacheKey(target) {
  return crypto.createHash('sha1').update(target).digest('hex')
}

/**
 * 拉取并缓存一张外部图片，返回 { filePath, mime }。
 * 命中磁盘缓存时直接返回，不再访问源站。
 */
export async function fetchToCache(target) {
  const url = await assertSafeTarget(target)
  const key = cacheKey(target)
  await fsp.mkdir(CACHE_DIR, { recursive: true })

  // 已缓存：按 hash 前缀找文件（扩展名不定）
  const existing = await fsp.readdir(CACHE_DIR).catch(() => [])
  const hit = existing.find((name) => name.startsWith(`${key}.`))
  if (hit) {
    return { filePath: path.join(CACHE_DIR, hit), mime: MIME[path.extname(hit)] || 'image/jpeg' }
  }

  // Referer 用图源自己的域名，规避 Referer 防盗链；部分站点对空 Referer 反而放行
  const headers = { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' }
  headers.Referer = `${url.protocol}//${url.hostname}/`

  const response = await fetch(target, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  })
  if (!response.ok) {
    // 有些站点拒绝自带 Referer，退回不带 Referer 再试一次
    const retry = await fetch(target, {
      headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    })
    if (!retry.ok) throw new Error(`图源返回 HTTP ${response.status}`)
    return persist(retry, key, '.jpg', target)
  }
  const ct = response.headers.get('content-type') || ''
  if (ct && !ct.startsWith('image/')) throw new Error('图源返回的不是图片')
  const ext = extFromContentType(ct, target)
  return persist(response, key, ext, target)
}

async function persist(response, key, ext, target) {
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > MAX_BYTES) throw new Error('图片超过体积上限')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > MAX_BYTES) throw new Error('图片超过体积上限')
  if (!buffer.length) throw new Error('图源返回空内容')
  const filePath = path.join(CACHE_DIR, `${key}${ext}`)
  await fsp.writeFile(filePath, buffer)
  return { filePath, mime: MIME[ext] || 'image/jpeg', bytes: buffer.length, target }
}

/** Express 处理函数：GET /api/img?u=... */
export async function handleImageProxy(req, res) {
  const target = String(req.query.u || '')
  if (!target) return res.status(400).json({ error: 'MISSING_URL', message: '缺少图片地址' })
  try {
    const { filePath, mime } = await fetchToCache(target)
    res.setHeader('Content-Type', mime)
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    if (!fs.existsSync(filePath)) return res.status(404).end()
    fs.createReadStream(filePath).pipe(res)
  } catch (err) {
    res.status(502).json({ error: 'IMAGE_FETCH_FAILED', message: err.message })
  }
}
