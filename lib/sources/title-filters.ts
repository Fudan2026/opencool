/**
 * Shared finance allow / entertainment deny title filters.
 * Used by DailyHot fetchers and optional groupRaw pass-through.
 * Distilled from TrendRadar / NewsHub-style keyword gates — no AI.
 */

/** Must match at least one to keep (after blacklist). */
export const FINANCE_WHITELIST =
  /央行|美联储|降息|加息|降准|国债|债券|股市|A股|港股|美股|纳斯达克|道琼斯|标普|沪深|创业板|科创板|北交所|期货|原油|黄金|白银|外汇|汇率|人民币|美元|欧元|日元|IPO|财报|营收|利润|市值|融资|并购|破产|违约|通胀|CPI|PPI|GDP|失业率|非农|财联社|金十|华尔街|见闻|券商|基金|私募|公募|ETF|期权|分红|回购|减持|增持|主力|北向|南向|两融|杠杆|做空|做多|牛市|熊市|崩盘|暴涨|暴跌|涨停|跌停|板块|概念股|茅台|宁德|比亚迪|腾讯|阿里|美团|京东|银行|保险|地产|楼市|房价|利率|LPR|MLF|逆回购|财政|税收|关税|贸易战|制裁|油价|天然气|铜|铁矿|锂电|芯片股|半导体股|新能源车|光伏|储能|碳中和|碳交易|加密货币|比特币|以太坊|BTC|ETH|监管|证监会|银保监|外管局|财政部|商务部|发改委|宏观|流动性|社融|M2|PMI|采购经理|出口|进口|逆差|顺差|地缘|冲突.*油|制裁.*俄|Fed|Powell|Treasury|yield|stock|market|earnings|inflation|recession|rate cut|rate hike|Nasdaq|S&P|Dow|Bitcoin|crypto|forex|commodity|tariff|WTO|IMF|World Bank|bond|equity|IPO|SEC|FOMC/i;

/** Drop immediately if matched (entertainment / games / celebrity noise). */
export const ENTERTAINMENT_BLACKLIST =
  /综艺|明星|演员|歌手|偶像|追剧|剧综|恋综|选秀|粉丝|磕糖|官宣|分手|结婚|离婚|孕|生子|出轨|八卦|热搜榜首.*剧|电影票房(?!相关股)|短剧|网红|直播带货(?!监管)|美食探店|穿搭|护肤|彩妆|旅游攻略|游戏皮肤|电竞选手|电竞赛事|游戏上线|新游|手游|端游|主机游戏|Steam|原神|王者荣耀|英雄联盟|LOL|DOTA|CSGO|绝地求生|崩坏|鸣潮|三角洲行动|演唱会|音乐节|脱口秀|相声|春晚|奥运会.*金牌(?!概念)|世界杯.*进球|足球明星|篮球明星|流量|塌房|翻车.*娱|恋情|绯闻|娱乐圈|爱豆|男团|女团|票房冠军|档期|首映|追剧|番剧|动漫(?!概念股)|二次元(?!概念)|Cosplay|街舞|选美|恋综|真人秀|跑男|极限挑战|密室|剧本杀|小红书种草|带货主播|美妆|穿搭|减肥食谱|宠物日常|萌娃|八卦|狗仔/i;

export function isEntertainmentTitle(title: string): boolean {
  return !!title && ENTERTAINMENT_BLACKLIST.test(title);
}

/** Finance-relevant after entertainment deny. */
export function isFinanceTitle(title: string): boolean {
  if (!title) return false;
  if (isEntertainmentTitle(title)) return false;
  return FINANCE_WHITELIST.test(title);
}

/** Has CJK characters — used for CN-first hero preference. */
export function hasCjk(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}
