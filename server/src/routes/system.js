import { Router } from 'express'
import { authRequired, adminRequired } from '../middleware/auth.js'
import { asyncHandler } from '../lib/http.js'
import { config } from '../config/index.js'

const router = Router()
router.use(authRequired, adminRequired)

// 云端最容易出问题的地方就是「出网能力」和「密钥是否随部署带上」。
// 这个端点只回连通性与配置布尔值，不暴露任何密钥内容，便于线上排查。
const PROBES = [
  { name: '智谱 CogView', url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions' },
  { name: 'Pollinations 免Key生图', url: 'https://image.pollinations.ai/prompt/test?width=64&height=64' },
  { name: 'Unsplash CDN', url: 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=64' },
  { name: 'Pexels CDN', url: 'https://images.pexels.com/photos/312418/pexels-photo-312418.jpeg?w=64' },
  { name: 'Openverse API', url: 'https://api.openverse.org/v1/images/?q=test&page_size=1' },
  { name: '堆糖 CN 素材', url: 'https://www.duitang.com/search/?kw=%E5%92%96%E5%95%A1&type=feed' },
]

router.get(
  '/net',
  asyncHandler(async (req, res) => {
    const results = await Promise.all(
      PROBES.map(async (probe) => {
        const started = Date.now()
        try {
          const response = await fetch(probe.url, {
            method: 'GET',
            signal: AbortSignal.timeout(9000),
            headers: { 'User-Agent': 'Mozilla/5.0 (poster-studio health probe)' },
          })
          return { name: probe.name, ok: true, status: response.status, ms: Date.now() - started }
        } catch (err) {
          return { name: probe.name, ok: false, code: err.name, ms: Date.now() - started }
        }
      })
    )
    res.json({
      providers: {
        zhipu: !!config.providers.zhipu.apiKey,
        pollinations: config.providers.pollinations.enabled !== false,
        pixabay: !!config.providers.pixabay.apiKey,
        unsplash: !!config.providers.unsplash.accessKey,
        pexels: !!config.providers.pexels.apiKey,
        dashscope: !!config.providers.dashscope.apiKey,
      },
      net: results,
    })
  })
)

export default router
