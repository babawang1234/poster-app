/**
 * 检索词理解层 —— 修复「摄影图搜索与输入关键词毫无关联」。
 *
 * 根因：此前把用户输入的中文整句（如「帮我做一张中秋月饼海报」）直接作为 query
 * 丢给 Openverse / Pixabay / Unsplash / Pexels 这些英文图库，中文 query 几乎零命中；
 * 于是结果全部落到「堆糖/站酷整页抓图」兜底，而那些 URL 不校验相关性、还被排序置顶，
 * 表现就是搜什么词都返回同一批无关图。
 *
 * 本模块把中文需求解析成：
 *  - subject：干净的中文主体词（给本地图库池 / 中文源，走精确匹配）
 *  - enTerms：贴题的英文短检索词（给英文图库，真正能命中）
 *  - 并提供相关性打分，用于把无法验证内容的中抓结果降权。
 *
 * 设计上不依赖任何在线模型：纯词典 + 最长匹配，服务端毫秒级、可离线、零成本。
 */

// 需求里的「意图词/版式词」不应进入图片检索词
const NOISE = /(?:我想|我想要|我要|帮我|请帮我|请|给我|帮忙|麻烦|来|做|制作|设计|生成|出|弄|一张|一个|一款|一组|一幅|一杯|一碗|一份|一片|一朵|张|个|幅|杯|清晨|午后|傍晚|热|冰|新鲜|美味|的|了|海报|宣传图|宣传海报|主视觉|封面|配图|底图|背景|背景素材|素材|图片|图|版式|模板|风格|高级|简约|大气|清新|复古|竖版|横版|方版|竖构图|横构图|比例|尺寸|以及|还有|加上|需要|想要|关于|主题|系列|活动|宣传|推广|促销|文案|标题|文字|加点|配个|来点)/gu

// 中文主体词 → 英文短检索词。数组顺序即优先级；同组内长词优先由 sort 保证。
const CN_TO_EN = [
  // 饮品 / 餐饮（长词在前，避免「奶茶」被「茶」截走）
  { keys: ['珍珠奶茶', '奶茶', '奶盖', '波霸'], en: 'bubble milk tea' },
  { keys: ['咖啡豆', '拿铁', '卡布奇诺', '美式咖啡', '咖啡馆', '咖啡店', '咖啡'], en: 'coffee latte' },
  { keys: ['茶叶', '茶园', '龙井', '绿茶', '红茶', '茶具', '茶杯', '茶饮', '喝茶', '茶'], en: 'chinese tea ceremony' },
  { keys: ['火锅', '麻辣', '涮锅'], en: 'chinese hot pot' },
  { keys: ['蛋糕', '甜点', '甜品', '烘焙', '面包'], en: 'dessert cake bakery' },
  { keys: ['水果', '果园', '橙子', '苹果'], en: 'fresh fruit' },
  { keys: ['美食', '餐饮', '料理', '餐厅', '食物', '大餐'], en: 'gourmet food' },
  // 节庆 / 情感
  { keys: ['情人节', '七夕', '520', '告白', '表白', '爱情', '恋爱', '情侣'], en: 'valentine roses love' },
  { keys: ['玫瑰', '鲜花', '花束', '花朵'], en: 'rose flower bouquet' },
  { keys: ['婚礼', '婚庆', '结婚', '新娘'], en: 'wedding ceremony' },
  { keys: ['中秋', '月饼', '月亮', '团圆'], en: 'mid autumn moon festival' },
  { keys: ['春节', '新年', '过年', '春联', '灯笼', '国风'], en: 'chinese new year lanterns' },
  { keys: ['圣诞', '圣诞节'], en: 'christmas decoration' },
  { keys: ['端午', '元宵', '母亲节', '父亲节', '感恩'], en: 'festival celebration' },
  // 自然 / 环保
  { keys: ['森林', '树林', '树木'], en: 'green forest trees' },
  { keys: ['环保', '环境', '生态', '低碳', '绿色'], en: 'nature ecology green' },
  { keys: ['海洋', '大海', '海边', '海滩'], en: 'ocean beach' },
  { keys: ['瀑布', '溪流', '湖', '山水'], en: 'mountain lake landscape' },
  { keys: ['自然', '风景', '风光', '日落', '日出'], en: 'natural landscape' },
  { keys: ['春天', '春季', '樱花'], en: 'spring cherry blossom' },
  { keys: ['冬天', '雪景', '下雪'], en: 'winter snow' },
  // 科技 / 商务
  { keys: ['人工智能', 'AI', '芯片', '电路', '机器人'], en: 'artificial intelligence technology' },
  { keys: ['充电桩', '充电站', '新能源汽车', '电动车'], en: 'electric car charging station' },
  { keys: ['光伏', '太阳能', '清洁能源', '新能源'], en: 'solar panels clean energy' },
  { keys: ['科技', '数码', '数据', '编程', '代码', '互联网'], en: 'technology digital' },
  { keys: ['招聘', '求职', '面试', '岗位'], en: 'job interview office' },
  { keys: ['金融', '理财', '投资', '财富', '股票', '银行'], en: 'finance investment' },
  { keys: ['商务', '办公', '职场', '企业', '会议', '团队'], en: 'business office meeting' },
  // 工业 / 市政（具体实体词，避免被「水」「工厂」泛化）
  { keys: ['污水处理', '自来水厂', '水厂', '净水', '水处理', '水务'], en: 'water treatment plant' },
  { keys: ['工厂', '工业', '制造', '车间', '厂房'], en: 'industrial factory' },
  { keys: ['电力', '发电', '电站', '能源'], en: 'power plant energy' },
  // 生活 / 消费
  { keys: ['空气净化器', '净化器', '家电', '家居', '客厅', '沙发'], en: 'modern minimal interior' },
  { keys: ['美妆', '护肤', '化妆', '美容', '彩妆', '口红'], en: 'cosmetics makeup beauty' },
  { keys: ['母婴', '宝宝', '婴儿', '亲子', '育儿'], en: 'baby care' },
  { keys: ['宠物狗', '宠物猫', '萌宠', '宠物'], en: 'cute pet dog cat' },
  { keys: ['马拉松', '长跑', '越野跑', '跑步'], en: 'marathon running' },
  { keys: ['瑜伽', '健身', '锻炼', '健身房'], en: 'fitness gym yoga' },
  { keys: ['篮球', '足球', '球赛', '运动', '体育'], en: 'sports action' },
  { keys: ['汽车', '跑车', '轿车', '驾驶'], en: 'modern car' },
  { keys: ['房产', '楼盘', '住宅', '房屋', '建筑'], en: 'modern architecture building' },
  { keys: ['城市', '都市', '高楼', '夜景'], en: 'city skyline night' },
  { keys: ['旅游', '旅行', '度假', '户外'], en: 'travel landscape' },
  // 文化 / 教育 / 医疗
  { keys: ['教育', '学习', '读书', '阅读', '课堂', '学校', '培训', '知识'], en: 'education books study' },
  { keys: ['演唱会', '音乐', '乐器', '钢琴', '演出'], en: 'music concert stage' },
  { keys: ['艺术', '设计', '创意', '插画', '美学'], en: 'abstract art design' },
  { keys: ['中医', '养生', '针灸', '保健'], en: 'traditional medicine wellness' },
  { keys: ['医院', '医生', '护士', '医疗', '健康'], en: 'healthcare medical' },
]

// 预先按 key 长度降序，保证「污水处理」优先于「水」、「奶茶」优先于「茶」
const ENTRIES = CN_TO_EN.flatMap((e) => e.keys.map((key) => ({ key, en: e.en })))
  .sort((a, b) => b.key.length - a.key.length)

/** 从自然语言中提取干净的中文主体词（供本地图库池 / 中文源精确匹配） */
export function extractSubject(text) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  const cleaned = raw.replace(NOISE, ' ').replace(/[，,。.!！?？；;：:、\n\r\t]/gu, ' ')
    .replace(/\s+/gu, ' ').trim()
  // 若清洗后几乎为空（用户只说了「做张海报」），退回原文去掉意图词后的前 12 字
  if (cleaned.length < 2) return raw.slice(0, 12)
  return cleaned.slice(0, 24)
}

/**
 * 把中文主体词转成英文短检索词。
 * 返回 1-2 个词：主词 + 可选的补充场景词，避免长句再次导致零命中。
 */
export function toEnglishTerms(subject) {
  const s = String(subject || '').trim()
  if (!s) return []
  // 本身已是英文 → 直接用（前端输入框常直接写 coffee / architecture）
  if (!/[\u4e00-\u9fa5]/.test(s)) {
    return [s.toLowerCase().replace(/[^a-z0-9\s-]/gi, ' ').replace(/\s+/g, ' ').trim()].filter(Boolean).slice(0, 1)
  }
  // 海报检索是「单主体」：只取最长、最贴题的那一个英文词。
  // 否则「新能源汽车充电桩」会同时命中「新能源」→ 太阳能图，把噪声带回结果。
  for (const { key, en } of ENTRIES) {
    if (s.includes(key)) return [en]
  }
  return []
}

/**
 * 主入口：把 (query, originalQuery) 解析成可直接用于各数据源的检索词。
 * @returns {{ subject: string, enTerms: string[], terms: string[], original: string }}
 */
export function buildSearchTerms(query, originalQuery = '') {
  const q = String(query || '').trim()
  const original = String(originalQuery || '').trim()
  // query 通常是用户手填的关键词，优先用它；为空时才从完整描述里抽
  const subject = extractSubject(q || original)
  const enTerms = toEnglishTerms(subject)
  // 英文图库用英文词；若没映射出来，退回清洗后的中文（至少比整句干净）
  const terms = enTerms.length ? enTerms : [subject].filter(Boolean)
  return { subject, enTerms, terms, original }
}

/**
 * 相关性打分：用于把「无法验证内容」的抓取结果降权、把贴题结果提前。
 * 只做轻量字符串匹配，不依赖网络。
 */
export function relevanceScore(photo, { enTerms = [], subject = '' } = {}) {
  const hay = [photo?.description, photo?.title, photo?.tags, photo?.alt, photo?.sourceName]
    .filter(Boolean).join(' ').toLowerCase()
  if (!hay) return 0
  let score = 0
  for (const term of enTerms) {
    for (const word of String(term).split(/\s+/).filter((w) => w.length >= 3)) {
      if (hay.includes(word)) score += 2
    }
  }
  if (subject && /[\u4e00-\u9fa5]/.test(subject)) {
    for (const ch of [...subject].filter((c) => /[\u4e00-\u9fa5]/.test(c)).join('')) {
      // 中文逐字命中即可，主体词通常 2-4 字
      if (hay.includes(ch)) score += 0.5
    }
  }
  return score
}
