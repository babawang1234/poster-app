import { load } from 'cheerio'

/**
 * 页面图片抓取（Node 内置实现，替代独立的 Python Scrapling 服务）
 *
 * 定位：给「素材库」补一条「从指定设计网站页面提取图片」的通道。
 *
 * 合规护栏（硬性，不可绕过）：
 *   1. 只允许 http/https，拒绝内网/本机地址（防 SSRF）
 *   2. robots.txt 禁止抓取的路径直接拒绝
 *   3. 可选域名白名单（SCRAPER_ALLOWED_DOMAINS，逗号分隔）
 *   4. 同域名最小请求间隔，避免给对方站点造成压力
 *   5. 请求超时 + 响应体积上限
 *
 * 不做的事：不绕过登录墙、付费墙、验证码，不做反爬对抗。
 * 遇到 403/401 一律如实返回错误。
 */

const UA = 'PosterStudioBot/1.0 (asset discovery; respects robots.txt)'
const MIN_INTERVAL_MS = Number(process.env.SCRAPER_MIN_INTERVAL_MS || 1500)
const MAX_BYTES = Number(process.env.SCRAPER_MAX_BYTES || 3 * 1024 * 1024)
const ALLOWED_DOMAINS = (process.env.SCRAPER_ALLOWED_DOMAINS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

const lastHit = new Map() // host -> timestamp
const robotsCache = new Map() // origin -> rules|null

export class ScrapeError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

function isPrivateHost(host) {
  const h = host.toLowerCase()
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(h)) return true
  if (h.endsWith('.local')) return true
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a === 10 || a === 127) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true
  }
  return false
}

export function validateTarget(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new ScrapeError('网址格式不正确')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new ScrapeError('仅支持 http/https 网址')
  const host = parsed.hostname
  if (isPrivateHost(host)) throw new ScrapeError('不允许访问内网或本机地址')
  if (ALLOWED_DOMAINS.length && !ALLOWED_DOMAINS.some((d) => host === d || host.endsWith('.' + d))) {
    throw new ScrapeError(`该域名不在允许列表内：${host}`, 403)
  }
  return parsed
}

/** 解析 robots.txt 中与 * 相关的规则，返回 { disallow: [], allow: [] } */
function parseRobots(text) {
  const rules = { disallow: [], allow: [] }
  let applies = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim()
    if (!line) continue
    const [rawKey, ...rest] = line.split(':')
    const key = rawKey.trim().toLowerCase()
    const value = rest.join(':').trim()
    if (key === 'user-agent') {
      applies = value === '*' || UA.toLowerCase().includes(value.toLowerCase())
    } else if (applies && key === 'disallow' && value) {
      rules.disallow.push(value)
    } else if (applies && key === 'allow' && value) {
      rules.allow.push(value)
    }
  }
  return rules
}

function isAllowedByRobots(rules, pathname) {
  if (!rules) return true // 拿不到 robots.txt 时按允许处理
  const match = (list) =>
    list
      .filter((p) => pathname.startsWith(p.replace(/\*.*$/, '')))
      .sort((a, b) => b.length - a.length)[0]
  const allowHit = match(rules.allow)
  const disallowHit = match(rules.disallow)
  if (!disallowHit) return true
  if (allowHit && allowHit.length >= disallowHit.length) return true
  return false
}

async function checkRobots(parsed) {
  const origin = parsed.origin
  if (robotsCache.has(origin)) {
    return isAllowedByRobots(robotsCache.get(origin), parsed.pathname)
  }
  let rules = null
  try {
    const res = await fetch(new URL('/robots.txt', origin), {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(8000),
    })
    if (res.ok) {
      const text = (await res.text()).slice(0, 200 * 1024)
      rules = parseRobots(text)
    }
  } catch {
    rules = null // 网络失败不影响主流程，按允许处理
  }
  robotsCache.set(origin, rules)
  return isAllowedByRobots(rules, parsed.pathname)
}

async function throttle(host) {
  const last = lastHit.get(host) || 0
  const wait = MIN_INTERVAL_MS - (Date.now() - last)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastHit.set(host, Date.now())
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  })
  if (res.status === 401 || res.status === 403) {
    throw new ScrapeError('目标站点拒绝访问（可能需要登录或禁止抓取），不做对抗处理', 403)
  }
  if (!res.ok) throw new ScrapeError(`目标站点返回 HTTP ${res.status}`, 502)

  const contentType = res.headers.get('content-type') || ''
  if (!contentType.includes('html')) throw new ScrapeError('目标地址不是网页（content-type 不是 HTML）')

  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_BYTES) throw new ScrapeError('网页体积超出限制')
  return { html: buf.toString('utf8'), finalUrl: res.url || url }
}

function collectImages(html, baseUrl, max) {
  const $ = load(html)
  const out = []
  const seen = new Set()

  const push = (raw, alt = '') => {
    if (!raw) return
    const value = String(raw).trim()
    if (!value || value.startsWith('data:') || value.startsWith('blob:')) return
    let abs
    try {
      abs = new URL(value, baseUrl).toString()
    } catch {
      return
    }
    if (!/^https?:\/\//i.test(abs) || seen.has(abs)) return
    seen.add(abs)
    out.push({ url: abs, alt: alt || '' })
  }

  $('img').each((_, el) => {
    const $el = $(el)
    const alt = ($el.attr('alt') || '').trim()
    push($el.attr('src'), alt)
    push($el.attr('data-src'), alt)
    push($el.attr('data-original'), alt)
    const srcset = $el.attr('srcset')
    if (srcset) push(srcset.split(',')[0]?.trim().split(/\s+/)[0], alt)
  })

  // 背景图
  $('[style*="background"]').each((_, el) => {
    const style = $(el).attr('style') || ''
    const m = style.match(/url\((['"]?)(.*?)\1\)/)
    if (m) push(m[2])
  })

  // og:image（社媒主图，通常质量较高）
  $('meta[property="og:image"]').each((_, el) => push($(el).attr('content')))

  return out.slice(0, max)
}

/**
 * 抓取一个页面上的图片
 * @param {string} url 目标页面
 * @param {{ max?: number }} options
 */
export async function scrapeImages(url, { max = 30 } = {}) {
  const parsed = validateTarget(url)
  const allowed = await checkRobots(parsed)
  if (!allowed) throw new ScrapeError('目标站点 robots.txt 禁止抓取该页面', 403)

  await throttle(parsed.host)

  const { html, finalUrl } = await fetchHtml(parsed.toString())
  const images = collectImages(html, finalUrl, Math.min(100, Math.max(1, max)))

  return {
    ok: true,
    requestedUrl: url,
    finalUrl,
    count: images.length,
    images,
  }
}

export function scraperStatus() {
  return {
    enabled: true,
    minIntervalMs: MIN_INTERVAL_MS,
    allowedDomains: ALLOWED_DOMAINS,
  }
}
