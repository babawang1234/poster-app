import { Router } from 'express'
import { authRequired } from '../middleware/auth.js'
import { asyncHandler } from '../lib/http.js'
import { db } from '../lib/db.js'
import { draftCopy, parseBrief, scoreTemplates } from '../skills/poster/interpret.js'
import { autoRoute, invoke } from '../adapters/index.js'
import { searchLocalPool, toPhoto } from '../lib/local-image-pool.js'
import { generateLayouts } from '../lib/layouts.js'
import { renderPoster, encodeBufferToDataUrl } from '../lib/renderer.js'
import { proxyUrl } from '../lib/image-proxy.js'
import { buildSearchTerms } from '../lib/search-terms.js'
import { generateDesignBackdrops } from '../lib/design-backdrop.js'

const router = Router()
router.use(authRequired)

// 同一 prompt 的生图请求合并：并发点击只触发一次真实生成，避免撞上匿名层限速。
const aiInflight = new Map()
// 一键成片底图轮转游标：保证连续多次成片不会反复用同一张底图
let poolCursor = 0

const PURPOSES = new Set(['活动宣传', '产品推广', '电商促销', '社媒运营', '品牌宣传', '招聘启事', '节日祝福'])
const RATIOS = new Set(['3:4', '9:16', '1:1', '16:9'])

function parseModelJson(content) {
  if (content && typeof content === 'object') return content
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try { return JSON.parse(text) } catch { return null }
}

async function interpretWithTextModel(description) {
  const model = autoRoute('text')
  if (!model || model.is_mock) return null
  try {
    const result = await invoke(model, 'text', {
      model: model.model_id,
      system: [
        '你是中文商业海报创意总监。先理解用户的真实商品、活动或场景，再给出高度贴合的创意 brief。',
        '严禁编造日期、地点、折扣、产品功效、品牌名、数字和事实；没有提供就留空。',
        '标题与短文案需要有创意、自然、简短且符合具体行业，禁止万能模板话术。',
        '图像检索词只描述用户明确提到的主体、动作、物体和视觉风格。除非用户明确提出，不要加入国家、城市、地标、旗帜、民族服饰等地域或文化符号；优先中性、无文字的摄影背景。',
        '只返回 JSON，不要 markdown。字段：purpose, ratioHint, styleKey, subject, keywords, imageSearchQuery, understanding, content。',
        'purpose 必须是：活动宣传、产品推广、电商促销、社媒运营、品牌宣传、招聘启事、节日祝福。ratioHint 只能是 3:4、9:16、1:1、16:9 或 null。',
        'content 必须包含 headline, subheadline, body, datetime, location, brand, cta，所有值为字符串；headline 必须有内容，其余未知信息留空。',
        'imageSearchQuery 请给 3 到 6 个英文词，描述应检索到的实景摄影主体与美术方向，不要搜索海报或设计稿。',
      ].join('\n'),
      prompt: `用户需求：\n${description}\n\n返回严格 JSON。`,
    })
    return parseModelJson(result.content)
  } catch (error) {
    console.warn(`[inspire] 文本模型不可用，切换本地创意解析：${error.message}`)
    return null
  }
}

function stockAssetFromTemplate(template) {
  const layers = JSON.parse(template.layers || '[]')
  const photo = layers.find((layer) => layer.type === 'image' && /^https:\/\/images\.unsplash\.com\//.test(layer.src || ''))
  const credit = layers.find((layer) => layer.type === 'text' && layer.photographer)
  if (!photo || !credit) return null
  return {
    id: photo.src.match(/photo-([a-zA-Z0-9-]+)/)?.[0] || 'curated-template-photo',
    provider: 'unsplash',
    sourceName: 'Unsplash',
    url: photo.src,
    photographer: credit.photographer,
    profileUrl: credit.sourceUrl,
    unsplashUrl: credit.unsplashUrl,
    sourceUrl: credit.unsplashUrl,
    templateStyle: photo.templateStyle,
    curated: true,
    license: 'Unsplash License',
  }
}

/**
 * 自然语言需求解析 + 模板检索。
 * 流程：parseBrief（确定性解析，mock）→ 检索灵感库模板打分 → 返回理解结果与推荐模板。
 * 未接入真实语言模型时，understanding 全部标注为演示解析，不伪装成真实 AI 思考。
 */
router.post(
  '/interpret',
  asyncHandler(async (req, res) => {
    const description = String(req.body?.description || '').trim().slice(0, 500)
    if (!description) {
      return res.status(400).json({ error: 'EMPTY_DESCRIPTION', message: '请先描述你想做的海报' })
    }

    const fallback = parseBrief(description)
    const ai = await interpretWithTextModel(description)
    const exactTopicOnly = fallback.concepts[0]?.key === 'teachers-day'
    const brief = ai ? {
      ...fallback,
      purpose: exactTopicOnly ? '节日祝福' : PURPOSES.has(ai.purpose) ? ai.purpose : fallback.purpose,
      ratioHint: RATIOS.has(ai.ratioHint) ? ai.ratioHint : fallback.ratioHint,
      styleKey: typeof ai.styleKey === 'string' ? ai.styleKey : fallback.styleKey,
      subject: typeof ai.subject === 'string' ? ai.subject.slice(0, 80) : fallback.subject,
      keywords: Array.isArray(ai.keywords) ? ai.keywords.map(String).map((word) => word.slice(0, 32)).slice(0, 10) : fallback.keywords,
      understanding: Array.isArray(ai.understanding) ? ai.understanding.map(String).slice(0, 4) : fallback.understanding,
      mock: false,
    } : fallback
    const content = !exactTopicOnly && ai?.content && typeof ai.content === 'object' ? {
      headline: String(ai.content.headline || '').slice(0, 24) || fallback.subject || '灵感即刻发生',
      subheadline: String(ai.content.subheadline || '').slice(0, 48),
      body: String(ai.content.body || '').slice(0, 100),
      datetime: String(ai.content.datetime || '').slice(0, 40),
      location: String(ai.content.location || '').slice(0, 40),
      brand: String(ai.content.brand || '').slice(0, 40),
      cta: String(ai.content.cta || '了解详情').slice(0, 16),
    } : null
    const draft = content?.headline ? content : draftCopy(description, brief.purpose, fallback.concepts)

    // 模板检索（本地灵感库）
    const rows = db
      .prepare(
        `SELECT id, name, category, purpose, description, thumbnail_path, tags, canvas, badge, design_notes, sample_content
         FROM templates`
      )
      .all()
    const templates = rows.map((t) => ({
      ...t,
      tags: JSON.parse(t.tags || '[]'),
      canvas: JSON.parse(t.canvas || '{}'),
      designNotes: t.design_notes ? JSON.parse(t.design_notes) : null,
      sampleContent: t.sample_content ? JSON.parse(t.sample_content) : null,
      stockAsset: stockAssetFromTemplate(t),
    }))
    const scored = scoreTemplates(templates, brief)
    const ranked = scored.filter((r) => r.score >= 4 && r.template.stockAsset).slice(0, 4)
    const recommendations = ranked.map(({ template, matched }) => ({
      id: template.id,
      name: template.name,
      category: template.category,
      purpose: template.purpose,
      badge: template.badge,
      thumbnail: template.thumbnail_path,
      tags: template.tags,
      canvas: template.canvas,
      designNotes: template.designNotes,
      sampleContent: template.sampleContent,
      stockAsset: template.stockAsset,
      matchedWords: matched,
      matchReason: matched.length
        ? `与「${matched.join('、')}」相关`
        : `符合「${template.purpose}」用途`,
    }))
    res.json({
      brief: {
        ...brief,
        mock: !ai,
        mockNote: ai ? '' : '本地语义规则解析；配置 DeepSeek/OpenAI 文本模型后会使用真实模型理解需求。',
      },
      content: content || draft,
      // Specific subject terms must win over broad intent concepts such as "new product".
      // When no text model is configured, preserve the user's concrete subject instead of
      // falling back to generic stock phrases like "premium product still life".
      imageSearchQuery: String(exactTopicOnly
        ? fallback.concepts[0].query
        : ai?.imageSearchQuery || [fallback.subject, ...(fallback.keywords || [])].filter(Boolean).join(' ') || description).slice(0, 160),
      templates: recommendations,
    })
  })
)

/**
 * AI 生成海报底图（双链路之一）
 * 输入关键词 → 真实 AI 文生图 → 下载到本地 → 返回可选的底图 URL 列表。
 * 生成优先级：通义万相（DASHSCOPE_API_KEY）→ Pollinations（免 Key 免费兜底）→ 本地设计底图引擎（最后兜底）。
 * 确保用户始终看到「AI 按关键词真实生图」，而非仅返回渐变/照片。
 */
router.post(
  '/ai-background',
  asyncHandler(async (req, res) => {
    const keyword = String(req.body?.keyword || '').trim().slice(0, 100)
    const count = Math.min(4, Math.max(1, Number(req.body?.count) || 3))
    if (!keyword) return res.status(400).json({ error: 'EMPTY_KEYWORD', message: '请提供关键词' })

    // 0) 尝试智谱 CogView-3-Flash（免费、中文理解强、国内直连）—— 优先
    const { ZhipuAdapter } = await import('../adapters/zhipu.js')
    const { getCachedGeneration, setCachedGeneration } = await import('../lib/gen-cache.js')
    const zhipu = new ZhipuAdapter()
    if (zhipu.available) {
      // 缓存命中：同一关键词直接复用，不消耗免费额度
      const cached = getCachedGeneration(keyword, 1024, 1024)
      if (cached && cached.length) {
        const images = cached.map((buf, i) => {
          const dataUrl = encodeBufferToDataUrl(buf, 'image/jpeg')
          return {
            id: `ai-zhipu-cache-${Date.now()}-${i}`,
            provider: 'ai', sourceName: 'AI 生成',
            url: dataUrl, thumb: dataUrl,
            description: `${keyword} · AI 生成底图 ${i + 1}`,
            photographer: 'AI 生成', license: 'AI 生成 · 可商用',
          }
        })
        return res.json({ images, provider: 'zhipu', message: '', cached: true })
      }
      // 未命中：真实生成多张（串行，免费档限速）
      try {
        // 关键：cogview 对「纯关键词」+「方版 1024x1024」理解最稳，竖版跑题率高。
        // 用方版生成（海报场景下留白可后期裁剪），避免竖版导致火锅→山水画。
        const { urls } = await zhipu.generateImage({ prompt: keyword, width: 1024, height: 1024, n: count })
        if (urls.length) {
          const buffers = []
          for (const u of urls) {
            try {
              const r = await fetch(u, { signal: AbortSignal.timeout(30000) })
              if (r.ok) buffers.push(Buffer.from(await r.arrayBuffer()))
            } catch (e) { console.warn('[inspire] 下载智谱图失败：', e.message) }
          }
          if (buffers.length) setCachedGeneration(keyword, 1024, 1024, buffers)
          const images = buffers.map((buf, i) => {
            const dataUrl = encodeBufferToDataUrl(buf, 'image/jpeg')
            return {
              id: `ai-zhipu-${Date.now()}-${i}`,
              provider: 'ai', sourceName: 'AI 生成',
              url: dataUrl, thumb: dataUrl,
              description: `${keyword} · AI 生成底图 ${i + 1}`,
              photographer: 'AI 生成', license: 'AI 生成 · 可商用',
            }
          })
          if (images.length) {
            return res.json({ images, provider: 'zhipu', message: '' })
          }
        }
      } catch (e) {
        console.warn('[inspire] 智谱生成失败：', e.message)
      }
      // 智谱失败 → 继续降级万相
    }

    // 1) 尝试通义万相（真实 AI 生图，中文理解最好）
    const { WanxAdapter } = await import('../adapters/wanx.js')
    const wanx = new WanxAdapter()
    if (wanx.available) {
      const prompts = [
        `${keyword}主题海报背景图，高级设计感，构图留白充足便于叠加标题，色彩协调，专业平面设计，高清，无文字无字母无logo，竖版构图`,
        `${keyword}创意视觉背景，抽象艺术与主题融合，大气留白，现代简约风，高清，无文字无水印，竖版`,
        `${keyword}氛围场景背景，质感光影，主题突出，适合海报留白排版，专业设计感，高清，无文字，竖版`,
        `${keyword}氛围场景背景，质感光影，主题突出，适合海报留白排版，专业设计感，高清，无文字，竖版`,
      ]
      const images = []
      for (let i = 0; i < count; i++) {
        try {
          const prompt = prompts[i % prompts.length]
          const { url } = await wanx.generateImage({ prompt, width: 1080, height: 1920 })
          const res2 = await fetch(url, { signal: AbortSignal.timeout(30000) })
          if (!res2.ok) throw new Error(`下载 AI 图失败 HTTP ${res2.status}`)
          const bytes = Buffer.from(await res2.arrayBuffer())
          const dataUrl = encodeBufferToDataUrl(bytes, 'image/png')
          images.push({
            id: `ai-${Date.now()}-${i}`,
            provider: 'ai',
            sourceName: 'AI 生成',
            url: dataUrl,
            thumb: dataUrl,
            description: `${keyword} · AI 生成底图 ${i + 1}`,
            photographer: 'AI 生成',
            license: 'AI 生成 · 可商用',
          })
        } catch (e) {
          console.warn(`[inspire] 万相生成第 ${i + 1} 张失败：${e.message}`)
        }
      }
      if (images.length) {
        return res.json({ images, provider: 'wanx', message: '' })
      }
      // 万相全部失败 → 继续降级 Pollinations
    }

    // 2) 尝试 Pollinations（免 Key 免费真实生图，英文 prompt）
    const { PollinationsAdapter, deriveVariants } = await import('../adapters/pollinations.js')
    const { buildImagePromptVariants } = await import('../lib/image-prompt.js')
    const pollinations = new PollinationsAdapter()
    if (pollinations.available) {
      // Pollinations 匿名层限速 45 秒/张。策略：只真实生成 1 张，再派生多张视觉变体，
      // 让用户一次看到多张贴题、可用的底图（而非只返回 1 张）。
      // 关键补充：结果落盘缓存 + 同 prompt 并发合并。
      // 否则用户等不及而连点几次，会连续撞上限速，表现就是「AI 生图生成不了」。
      const prompt = buildImagePromptVariants(keyword, 1)[0]
      const W = 1080
      const H = 1440
      let baseBuffers = getCachedGeneration(prompt, W, H) || []
      const fromCache = baseBuffers.length > 0

      if (!fromCache) {
        const flightKey = `${prompt}|${W}|${H}`
        if (!aiInflight.has(flightKey)) {
          aiInflight.set(
            flightKey,
            (async () => {
              const { buffer } = await pollinations.generateImage({
                prompt,
                width: W,
                height: H,
                seed: Math.floor(Math.random() * 1e9),
              })
              setCachedGeneration(prompt, W, H, [buffer])
              return [buffer]
            })()
          )
        }
        try {
          baseBuffers = await aiInflight.get(flightKey)
        } catch (e) {
          console.warn(`[inspire] Pollinations 生成失败：${e.message}`)
          // 限速时给出可操作提示，而不是笼统的「失败」
          if (e.status === 402) {
            return res.status(429).json({
              error: 'AI_RATE_LIMITED',
              message: '免费 AI 生图通道受限速（约 45 秒 1 张），请稍等约 1 分钟再试，或换个关键词。',
              images: [],
            })
          }
        } finally {
          aiInflight.delete(flightKey)
        }
      }

      let images = []
      if (baseBuffers.length) {
        const variants = await deriveVariants(baseBuffers[0], Math.max(1, count))
        images = variants.map((v, i) => {
          const dataUrl = encodeBufferToDataUrl(v.buffer, 'image/jpeg')
          return {
            id: `ai-p-${Date.now()}-${i}`,
            provider: 'ai',
            sourceName: 'AI 生成',
            url: dataUrl,
            thumb: dataUrl,
            description: `${keyword} · AI 生成底图 ${i + 1}`,
            photographer: 'AI 生成',
            license: 'AI 生成 · 可商用',
          }
        })
      }
      if (images.length) {
        return res.json({
          images,
          provider: 'pollinations',
          cached: fromCache,
          message: images.length >= count ? '' : `已生成 ${images.length} 张（免费 AI 生图限速，可再次点击生成新的一组）`,
        })
      }
    }

    // 3) 最后兜底：本地设计底图引擎（保证有结果，但明确标注非 AI 生图）
    const { generateDesignBackdrops } = await import('../lib/design-backdrop.js')
    const backdrops = generateDesignBackdrops(keyword, { count })
    const images = backdrops.map((b) => {
      const dataUrl = encodeBufferToDataUrl(b.buffer, 'image/png')
      return {
        id: b.id,
        provider: 'ai-design',
        sourceName: '设计底图',
        description: `${keyword} · 设计背景 ${b.variant + 1}`,
        url: dataUrl,
        thumb: dataUrl,
        photographer: '幻象工坊 · 设计库',
        license: '设计底图 · 可商用',
        kind: 'design',
        width: b.width,
        height: b.height,
      }
    })
    res.json({
      images,
      fallback: 'local-design',
      provider: 'local-design',
      message: 'AI 生图服务暂不可用，已返回设计底图（非 AI 生成）。',
    })
  })
)

/**
 * 一键成片 AI 背景：按精准主体词文生图，限时参与（不拖慢出片）。
 * 每次换 seed → 与图库/设计底图凑成的同批背景必然各不相同。
 * 免费生图通道有 ~45s/张 限速，故给 8 秒预算：命中就用，超时静默降级。
 */
const oneShotAiFlight = new Map()
async function oneShotAiBackdrop(subject) {
  const key = `oneshot:${subject}`
  if (!oneShotAiFlight.has(key)) {
    oneShotAiFlight.set(key, (async () => {
      try {
        const { PollinationsAdapter } = await import('../adapters/pollinations.js')
        const { buildImagePromptVariants } = await import('../lib/image-prompt.js')
        const adapter = new PollinationsAdapter()
        if (!adapter.available) return null
        const prompt = buildImagePromptVariants(subject, 1)[0]
        if (!prompt) return null
        const { buffer } = await adapter.generateImage({
          prompt, width: 1080, height: 1440,
          seed: Math.floor(Math.random() * 1e9),
        })
        return buffer
      } catch (e) {
        console.warn('[inspire] one-shot AI 背景生成失败：', e.message)
        return null
      } finally {
        oneShotAiFlight.delete(key)
      }
    })())
  }
  return Promise.race([
    oneShotAiFlight.get(key),
    new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
  ])
}

/**
 * 一键成片：输入一句需求 → 自动完成「理解 → 生成多张不同背景 → 排版成海报」。
 *
 * 修复两个体验问题：
 *  1) 底图不精准：用 search-terms 从整句需求里抽出「主体词」（去掉「帮我做张海报」等意图词），
 *     再分别用于图库精确匹配、AI 生图英文 prompt、设计底图主题色。
 *  2) 底图都一样：以前只挑 1 张图给 4 个方案共用。现在为每个方案准备**不同**背景，
 *     来源混合「AI 生图 / 精准图库实拍 / 升级版设计底图（不同设计哲学）」，保证视觉差异。
 */
router.post(
  '/one-shot',
  asyncHandler(async (req, res) => {
    const description = String(req.body?.description || '').trim().slice(0, 500)
    if (!description) return res.status(400).json({ error: 'EMPTY_DESCRIPTION', message: '请描述你想做的海报' })

    // 1) 理解需求
    const brief = parseBrief(description)
    const content = draftCopy(description, brief.purpose, brief.concepts)
    const { subject, enTerms } = buildSearchTerms(description)
    // 精准主体词：优先清洗结果，退回到 brief 的 subject，最后才用原文
    const subjectQuery = (subject || brief.subject || description).slice(0, 60)

    const canvas = { width: 1080, height: 1440 }
    const LAYOUT_COUNT = 4
    const candidates = []

    // (a) 精准图库实拍：用清洗后的主体词精确匹配，取「不同」的两张照片
    try {
      const hits = searchLocalPool(subjectQuery, { limit: 8 })
      const start = poolCursor++ % Math.max(1, Math.min(6, hits.length || 1))
      const rotated = [...hits.slice(start), ...hits.slice(0, start)]
      for (const img of rotated.slice(0, 2)) {
        const p = toPhoto(img)
        p.url = proxyUrl(p.url)
        p.thumb = proxyUrl(p.thumb)
        candidates.push({ asset: p, origin: '图库实拍' })
      }
    } catch (e) {
      console.warn('[inspire] one-shot 图库匹配失败：', e.message)
    }

    // (b) AI 生图：按主体词现画一张，作为其中一个方案的背景（限时，不阻塞出片）
    try {
      const aiBuffer = await oneShotAiBackdrop(subjectQuery)
      if (aiBuffer) {
        const dataUrl = encodeBufferToDataUrl(aiBuffer, 'image/jpeg')
        candidates.unshift({
          asset: {
            id: `ai-shot-${Date.now()}`, provider: 'ai', sourceName: 'AI 生成',
            url: dataUrl, thumb: dataUrl, photographer: 'AI 生成',
            license: 'AI 生成 · 可商用',
          },
          origin: 'AI 生图',
        })
      }
    } catch (e) {
      console.warn('[inspire] one-shot AI 背景异常：', e.message)
    }

    // (c) 升级版设计底图补足到 4 张：distinct 模式强制每张用不同设计哲学
    const need = LAYOUT_COUNT - candidates.length
    if (need > 0) {
      try {
        const backdrops = generateDesignBackdrops(subjectQuery, {
          count: need, width: 1080, height: 1440,
          variantOffset: Math.floor(Math.random() * 6), distinct: true,
        })
        for (const b of backdrops) {
          const dataUrl = encodeBufferToDataUrl(b.buffer, 'image/png')
          candidates.push({
            asset: {
              id: b.id, provider: 'design', sourceName: '设计底图',
              url: dataUrl, thumb: dataUrl,
              photographer: '幻象工坊 · 设计库', license: '设计底图 · 可商用',
            },
            origin: '设计底图',
          })
        }
      } catch (e) {
        console.warn('[inspire] one-shot 设计底图生成失败：', e.message)
      }
    }

    // 保证 4 个方案各有背景：极端情况下用不同哲学的另一张设计底图补齐
    while (candidates.length > 0 && candidates.length < LAYOUT_COUNT) {
      const b = generateDesignBackdrops(subjectQuery, {
        count: 1, width: 1080, height: 1440,
        variantOffset: LAYOUT_COUNT + candidates.length, distinct: true,
      })[0]
      const dataUrl = encodeBufferToDataUrl(b.buffer, 'image/png')
      candidates.push({
        asset: { id: b.id, provider: 'design', sourceName: '设计底图', url: dataUrl, thumb: dataUrl, photographer: '幻象工坊 · 设计库', license: '设计底图 · 可商用' },
        origin: '设计底图',
      })
    }

    const stockAssets = candidates.slice(0, LAYOUT_COUNT).map((c) => c.asset)
    const backgroundOrigins = candidates.slice(0, LAYOUT_COUNT).map((c) => c.origin)
    const backgroundSource = backgroundOrigins[0] || 'none'

    // 3) 生成版式方案：每个方案各用一张不同底图（排版逻辑保持不变）
    const styleAnalysis = brief.styleKey ? { preset: brief.styleKey } : undefined
    const layouts = generateLayouts({
      content, purpose: brief.purpose, canvas, styleAnalysis,
      stockAsset: stockAssets[0] || null,
      stockAssets,
    })

    // 4) 渲染缩略图，并把「背景来源」标注到每个方案上
    const results = []
    for (let i = 0; i < layouts.length; i++) {
      const l = layouts[i]
      const buf = await renderPoster({ width: canvas.width, height: canvas.height, background: l.background, layers: l.layers })
      results.push({
        name: l.name,
        feature: l.feature,
        palette: l.palette,
        canvas: l.canvas,
        background: l.background,
        layers: l.layers,
        stockAttribution: l.stockAttribution,
        backgroundAsset: l.backgroundAsset,
        backgroundOrigin: backgroundOrigins[i] || '',
        thumbnail: encodeBufferToDataUrl(buf),
      })
    }

    res.json({
      brief: { ...brief, mock: true, subject: subjectQuery, enTerms },
      content,
      backgroundSource,
      backgroundOrigins,
      stockAsset: stockAssets[0] || null,
      stockAssets,
      layouts: results,
      message: results.length ? '' : '生成失败，请重试。',
    })
  })
)

export default router
