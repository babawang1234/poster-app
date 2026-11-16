import { config } from '../config/index.js'
import fs from 'fs'
import { posterSkills } from '../skills/poster/index.js'
import { makeKey, getCached, setCached, hashImage } from '../lib/llm-cache.js'
import { imageToCompactBase64 } from '../lib/image-compress.js'

/**
 * DeepSeek Adapter —— 仅接入官方 API。
 * 注意：ChatGPT 网页订阅不能当作 API 使用；此处仅在有 API Key 时启用。
 *
 * 节省 token 的两处设计：
 * 1) analyzeImage 先压缩图片（长边 ≤ 768），再 base64，图片 token 大幅下降；
 * 2) analyzeImage 结果按「模型 + system + prompt + 图片指纹」缓存，同一张图不重复计费。
 *    文本生成默认不缓存，保证用户点「换一换」能拿到不同结果。
 */
export class DeepSeekAdapter {
  constructor() {
    this.provider = 'deepseek'
    this.baseUrl = config.providers.deepseek.baseUrl
    this.apiKey = config.providers.deepseek.apiKey
  }

  get available() {
    return !!this.apiKey
  }

  async _chat(messages, model, { cacheKey = '', scope = 'text' } = {}) {
    if (cacheKey) {
      const hit = getCached(cacheKey, scope)
      if (hit) return { content: hit, cached: true }
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model, messages }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`DeepSeek API ${res.status}: ${text.slice(0, 300)}`)
    }
    const data = await res.json()
    const content = data.choices?.[0]?.message?.content ?? ''

    if (cacheKey && content) {
      setCached({ key: cacheKey, model, scope, content })
    }
    return { content, cached: false }
  }

  async text({ prompt, system, model, cache: useCache = false }) {
    const cacheKey = useCache
      ? makeKey({ model, scope: 'text', system: system || '', prompt })
      : ''
    const { content, cached } = await this._chat(
      [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
      model,
      { cacheKey, scope: 'text' }
    )
    return { mock: false, model, content, cached }
  }

  async analyzeImage({ imagePath, prompt, model, cache: useCache = true }) {
    if (!imagePath || !fs.existsSync(imagePath)) throw new Error('参考图文件不存在，无法进行风格分析')

    // 压缩后再送模型：风格分析不需要原始分辨率
    const compact = await imageToCompactBase64(imagePath)
    const imageHash = hashImage(Buffer.from(compact.base64, 'base64'))

    const system = posterSkills.referenceAnalysis
    const userPrompt = `${prompt}\n只分析视觉风格，不复刻海报文字或构图。返回 JSON：palette（3 个十六进制色值）、dark（布尔值）、paletteNotes、composition、typography、whitespace、decoration。`

    const cacheKey = useCache
      ? makeKey({ model, scope: 'analyze', system, prompt: userPrompt, imageHash })
      : ''

    const { content, cached } = await this._chat(
      [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: userPrompt },
            {
              type: 'image_url',
              image_url: { url: `data:${compact.mime};base64,${compact.base64}` },
            },
          ],
        },
      ],
      model,
      { cacheKey, scope: 'analyze' }
    )

    return {
      mock: false,
      model,
      content,
      cached,
      image: { width: compact.width, height: compact.height, bytes: compact.bytes, originalBytes: compact.originalBytes },
    }
  }
}
