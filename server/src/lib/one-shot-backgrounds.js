/**
 * 一键成片背景组装器。
 *
 * 取代旧的「本地池 2 张 + 8 秒限时 AI + 抽象设计底图补足」拼盘逻辑：
 *  - 走完整摄影图检索（本地图库池 + 外部图库 + 中文素材站），中文站长尾覆盖由 cnLimit 放大；
 *  - 所有候选必须过 isRelevant 硬性闸门，只放行与主体词强相关的图；
 *  - 抽象设计底图彻底退出「场景背景」（它留在素材生成里做通用底纹才合适）；
 *  - 贴题实拍不足时才用 AI 生图补，AI 优先智谱 CogView（中文 prompt 直接吃主体词），
 *    Pollinations 降级并落盘缓存；
 *  - 仍不足则**按实际数量出方案并明确说明**，绝不再用无关图凑满 4 张。
 */
import { searchAssetImages } from '../services/asset-search.js'
import { resolveSubject, visualConcepts, isRelevant, matchScore } from './subject-match.js'
import { encodeBufferToDataUrl } from './renderer.js'
import { getCachedGeneration, setCachedGeneration } from './gen-cache.js'

const AI_W = 1024
const AI_H = 1024
const aiFlights = new Map()

export function describeOneShotSubject(description) {
  const subject = resolveSubject(description)
  return { subject, concepts: visualConcepts(subject) }
}

function originOf(photo) {
  const p = String(photo?.provider || '')
  if (p === 'ai' || p === 'ai-design') return 'AI 生图'
  if (p === 'cn') return '中文素材'
  if (p === 'design' || p === 'vector') return '设计底图'
  return '图库实拍'
}

function aiAsset(buffer, subject, index) {
  const dataUrl = encodeBufferToDataUrl(buffer, 'image/jpeg')
  return {
    id: `ai-oneshot-${Date.now()}-${index}`,
    provider: 'ai',
    sourceName: 'AI 生成',
    description: `${subject} · AI 生成背景`,
    url: dataUrl,
    thumb: dataUrl,
    photographer: 'AI 生成',
    license: 'AI 生成 · 可商用',
  }
}

/**
 * 按主体词生成贴题 AI 背景。
 * - 命中落盘缓存：立即返回（不消耗免费额度、不等待）；
 * - 未命中：后台生成并写缓存；waitMs>0 时在预算内同步等待（用于实拍不足时的补足）。
 */
async function aiBackdrops(subject, count, { waitMs = 0 } = {}) {
  const cached = getCachedGeneration(subject, AI_W, AI_H)
  if (cached?.length) return cached.slice(0, count)

  const key = `oneshot:${subject}`
  if (!aiFlights.has(key)) {
    aiFlights.set(key, (async () => {
      try {
        // 1) 智谱 CogView：中文理解准、国内直连，prompt 直接用最具体主体词
        const { ZhipuAdapter } = await import('../adapters/zhipu.js')
        const zhipu = new ZhipuAdapter()
        if (zhipu.available) {
          const { urls } = await zhipu.generateImage({
            prompt: subject, width: AI_W, height: AI_H, n: Math.min(2, Math.max(1, count)),
          })
          const buffers = []
          for (const u of urls || []) {
            try {
              const r = await fetch(u, { signal: AbortSignal.timeout(30000) })
              if (r.ok) buffers.push(Buffer.from(await r.arrayBuffer()))
            } catch (e) { console.warn('[one-shot] 下载 AI 背景失败：', e.message) }
          }
          if (buffers.length) {
            setCachedGeneration(subject, AI_W, AI_H, buffers)
            return buffers
          }
        }
        // 2) 降级 Pollinations（免 Key，英文 prompt）
        const { PollinationsAdapter } = await import('../adapters/pollinations.js')
        const { keywordToImagePrompt } = await import('./image-prompt.js')
        const adapter = new PollinationsAdapter()
        if (adapter.available) {
          const prompt = keywordToImagePrompt(subject)
          const { buffer } = await adapter.generateImage({
            prompt, width: AI_W, height: AI_H, seed: Math.floor(Math.random() * 1e9),
          })
          if (buffer?.length) {
            setCachedGeneration(subject, AI_W, AI_H, [buffer])
            return [buffer]
          }
        }
      } catch (e) {
        console.warn('[one-shot] AI 背景生成失败：', e.message)
      } finally {
        aiFlights.delete(key)
      }
      return []
    })())
  }

  if (waitMs <= 0) return [] // 只预热，不阻塞本次出片
  return Promise.race([
    aiFlights.get(key),
    new Promise((resolve) => setTimeout(() => resolve([]), waitMs)),
  ])
}

/**
 * 组装一键成片背景。
 * @returns {{ subject, concepts, backgrounds, matchInfo, message }}
 */
export async function buildOneShotBackgrounds(description, { count = 4, offset = 0 } = {}) {
  const { subject, concepts } = describeOneShotSubject(description)
  // 用「最具体主体名词」检索：避免「中秋月饼」把「中秋」泛化词带进中文素材站，
  // 也避免本地池把「春节灯笼」当成匹配结果返回。
  const query = concepts.primary || subject

  let pool = []
  try {
    const result = await searchAssetImages({
      query, originalQuery: description,
      orientation: 'portrait', perPage: 40, cnLimit: 18,
    })
    pool = result.photos || []
  } catch (e) {
    console.warn('[one-shot] 摄影图检索失败：', e.message)
  }

  // 硬性闸门 + 去重 + 相关性排序
  const seen = new Set()
  const ranked = []
  for (const photo of pool) {
    if (!photo?.url) continue
    const key = `${photo.provider}:${photo.id}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!isRelevant(photo, concepts)) continue
    ranked.push({
      asset: photo,
      origin: originOf(photo),
      score: matchScore(photo, concepts),
    })
  }
  ranked.sort((a, b) => b.score - a.score)

  // offset 轮转：点「换一批」时给出同主题的另外几张，而不是反复同一张
  const start = ranked.length ? offset % ranked.length : 0
  const rotated = [...ranked.slice(start), ...ranked.slice(0, start)]
  const chosen = rotated.slice(0, count)

  // 贴题实拍不足 → 用 AI 按主体词现画补足（同步等待，因为此时确实缺图）
  if (chosen.length < count) {
    const need = count - chosen.length
    const buffers = await aiBackdrops(query, need, { waitMs: 35000 })
    buffers.slice(0, need).forEach((buf, i) => {
      chosen.push({ asset: aiAsset(buf, query, i), origin: 'AI 生图', score: 100 })
    })
  }

  const sources = [...new Set(chosen.map((c) => c.origin))]
  const matchInfo = {
    subject: query,
    totalRelevant: ranked.length,
    used: chosen.length,
    sources,
    complete: chosen.length >= count,
    offset: start,
  }
  const message = chosen.length === 0
    ? `暂未找到与「${query}」匹配的背景素材。建议换一个更具体的主体词（如「月饼」「拿铁」「马拉松」），或稍后重试让 AI 生成。`
    : chosen.length < count
      ? `只找到 ${chosen.length} 张与「${query}」匹配的背景，已按实际数量生成方案——不再用无关图片凑数。`
      : ''

  return { subject, concepts, backgrounds: chosen, matchInfo, message }
}
