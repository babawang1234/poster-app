/**
 * 一键成片「主体词 ↔ 背景」精准匹配层。
 *
 * 背景（本轮要解决的问题）：
 * 以前 /one-shot 只从本地预置图库池取 2 张，凑不够 4 张就用「抽象设计底图」补，
 * 而且检索词是整句需求清洗后的残串（如「咖啡新品上市」「中秋月饼」），
 * 导致「搜月饼 → 给春节灯笼 / 抽象色块」，用户拿到 4 个方案没一个能用。
 *
 * 本模块做两件事：
 *  1) resolveSubject：把需求整句收敛到「最具体的主体名词」（去掉营销词与意图词），
 *     这是检索与生图唯一可信的输入；
 *  2) visualConcepts + isRelevant：建立该主体的中英文视觉概念，并对每张候选图做
 *     **硬性准入**——只有描述里真的出现主体（或其英文主词）才放行。
 *
 * 设计原则：宁可少给方案，也绝不用不相关的图凑数。抽象设计底图不再作为场景背景。
 */
import { extractSubject, toEnglishTerms } from './search-terms.js'

// 营销 / 促销 / 活动话术：这些词描述「要做什么」，不描述「画面里是什么」，必须剔除。
// 否则「中秋月饼促销」会让堆糖去搜一整串营销词，返回一堆无关图。
const MARKETING = /(?:新品上市|新品|上市|首发|新店|开业|促销|大促|特惠|优惠|折扣|限时|秒杀|爆款|热卖|热销|狂欢|盛典|招募|报名|预定|预售|团购|满减|赠礼|福利|钜惠|特价|清仓|焕新|升级|来袭|发布|推出|震撼|劲爆|超值|抢购|开售|开抢|专场|季|节|活动|策划|方案|系列|定制|专属|精品|爆款推荐)/gu

// 「最具体主体名词」表：按长度降序匹配。
// 用途：「中秋月饼」→ 主体是「月饼」而不是泛化的「中秋」；「新能源汽车充电桩」→「充电桩」。
// 这些词同时也是中文素材站搜索命中最稳的词。
const PRIMARY_NOUNS = [
  '空气净化器', '珍珠奶茶', '电动牙刷', '净水设备', '智能手机',
  '月饼', '粽子', '汤圆', '元宵', '饺子', '大闸蟹', '小龙虾', '冰淇淋',
  '充电桩', '充电站', '净化器', '水厂', '污水处理厂', '自来水厂', '马拉松', '演唱会',
  '咖啡馆', '咖啡豆', '拿铁', '咖啡', '奶茶', '奶盖', '茶叶', '茶园', '龙井', '茶杯',
  '火锅', '蛋糕', '甜点', '面包', '烘焙', '寿司', '披萨', '汉堡', '烧烤', '啤酒', '红酒',
  '玫瑰', '花束', '鲜花', '樱花', '灯笼', '春联', '舞狮', '圣诞树',
  '跑车', '轿车', '汽车', '楼盘', '房产', '别墅', '办公室', '会议室',
  '口红', '粉底', '护肤品', '香水', '手表', '球鞋', '背包',
  '宠物狗', '宠物猫', '婴儿', '宝宝', '瑜伽', '健身', '跑步', '篮球', '足球',
  '钢琴', '吉他', '耳机', '相机', '笔记本', '显示器', '机器人', '芯片',
  '森林', '瀑布', '海滩', '雪山', '日落', '日出', '星空', '湖泊',
  '招聘', '面试', '医生', '护士', '课堂', '书本', '图书馆',
].sort((a, b) => b.length - a.length)

// 少数主体补充「上位/联想词」，只用于加分，不允许单独通过准入闸门
const HINTS = {
  月饼: ['中秋', '糕点', '点心', '团圆'],
  粽子: ['端午', '龙舟', '传统'],
  咖啡: ['拿铁', '咖啡杯', '咖啡豆'],
  奶茶: ['珍珠', '茶饮', '饮品'],
  马拉松: ['跑步', '比赛', '运动'],
  水厂: ['水处理', '净水', '污水'],
  火锅: ['麻辣', '美食', '餐饮'],
  玫瑰: ['鲜花', '花束', '爱情'],
  充电桩: ['电动车', '新能源', '充电'],
  春节: ['新年', '灯笼', '国风'],
}

const PUNCT = /[，,。.!！?？；;：:、\n\r\t\s]+/gu

/** 整句需求 → 干净的中文主体词 */
export function resolveSubject(text) {
  const base = extractSubject(text)
  let s = String(base || '')
    .replace(MARKETING, ' ')
    .replace(PUNCT, ' ')
    .trim()
  // 清洗过头时退回原始清洗结果，保证永远有检索词
  if (s.length < 2) s = String(base || String(text || '').trim()).replace(PUNCT, ' ').trim()
  return s.slice(0, 20) || String(text || '').trim().slice(0, 20)
}

/** 主体词 → 最具体的核心名词（用于准入判断与中文素材检索） */
export function primaryNoun(subject) {
  const s = String(subject || '').trim()
  if (!s) return ''
  for (const noun of PRIMARY_NOUNS) {
    if (s.includes(noun)) return noun
  }
  return s
}

/**
 * 主体词 → 视觉概念集合。
 * @returns {{ primary: string, subject: string, zh: string[], en: string[], enPrimary: string }}
 */
export function visualConcepts(subject) {
  const s = String(subject || '').trim()
  const primary = primaryNoun(s)
  const primaryEn = toEnglishTerms(primary)
  const enTerms = primaryEn.length ? primaryEn : toEnglishTerms(s)
  const enPrimary = enTerms[0] || ''
  const zh = [primary, s, ...(HINTS[primary] || [])].filter(Boolean)
  return {
    primary,
    subject: s,
    zh: [...new Set(zh)],
    en: [...new Set([...enTerms, ...toEnglishTerms(s)])].filter(Boolean),
    enPrimary,
  }
}

function haystack(photo) {
  return [photo?.description, photo?.title, photo?.label, photo?.category,
    photo?.alt, photo?.tags, photo?.sourceName]
    .filter(Boolean).join(' ').toLowerCase()
}

/**
 * 硬性准入：描述里必须真的出现主体（中文主词 / 英文主词 / 中文逐字全命中）。
 * 这是「不搭配」的关键闸门——「节日 · 节日」「传统装饰 · 春节」对「月饼」一律 false。
 */
export function isRelevant(photo, concepts) {
  const hay = haystack(photo)
  if (!hay) return false
  const primary = String(concepts.primary || '').toLowerCase()
  if (primary && hay.includes(primary)) return true
  for (const en of concepts.en || []) {
    const term = String(en).trim().toLowerCase()
    if (term.length >= 3 && hay.includes(term)) return true
  }
  // 中文逐字全命中（描述被空格/符号拆开时仍能识别，如「月 饼」）
  if (/^[\u4e00-\u9fa5]{2,}$/u.test(concepts.primary || '')) {
    const chars = [...concepts.primary]
    if (chars.every((ch) => hay.includes(ch))) return true
  }
  return false
}

/** 相关性打分，用于在已放行的图里排序（贴题程度高、本地实拍优先） */
export function matchScore(photo, concepts) {
  const hay = haystack(photo)
  if (!hay) return 0
  let score = 0
  const primary = String(concepts.primary || '').toLowerCase()
  if (primary && hay.includes(primary)) score += 20
  if (concepts.enPrimary && hay.includes(String(concepts.enPrimary).toLowerCase())) score += 12
  for (const zh of concepts.zh || []) {
    const t = String(zh).toLowerCase()
    if (t && t !== primary && t.length >= 2 && hay.includes(t)) score += 5
  }
  for (const en of concepts.en || []) {
    const t = String(en).trim().toLowerCase()
    if (t.length >= 3 && hay.includes(t)) score += 3
  }
  // 真实照片图库略优先于整页抓取的中文素材
  if (photo?.provider && photo.provider !== 'cn') score += 2
  return score
}
