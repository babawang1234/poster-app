import fs from 'node:fs'
import path from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'

/**
 * 把图片压缩到指定最长边，再转 base64，用于喂给视觉模型。
 *
 * 为什么这么做：视觉模型的图片 token 与像素数量正相关。
 * 一张 4000px 的摄影图和 768px 的缩略图，语义信息几乎一致，
 * 但 token 消耗可能相差十几倍。风格分析只需要色彩/构图信息，不需要原始分辨率。
 */

const DEFAULT_MAX_SIDE = 768
const DEFAULT_QUALITY = 80

export async function imageToCompactBase64(
  filePath,
  { maxSide = DEFAULT_MAX_SIDE, quality = DEFAULT_QUALITY } = {}
) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('图片文件不存在')
  }

  const raw = fs.readFileSync(filePath)
  const img = await loadImage(raw)

  const { width, height } = img
  const longest = Math.max(width, height)
  const scale = longest > maxSide ? maxSide / longest : 1
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))

  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  // JPEG 无透明通道，先铺白底，避免 PNG 透明区域变成黑块影响分析
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)

  const out = canvas.toBuffer('image/jpeg', quality)

  return {
    base64: out.toString('base64'),
    mime: 'image/jpeg',
    width: w,
    height: h,
    bytes: out.length,
    originalBytes: raw.length,
  }
}

export function mimeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  return 'image/jpeg'
}
