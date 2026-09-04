// 詞表（norm 形式：小寫、無標點）。台灣口語為主，含常見英文口頭禪。

/** 純語助詞：幾乎永遠是贅字（除非是問句後的單字回答）。 */
export const ZH_PURE_FILLERS = new Set(["嗯", "呃", "欸", "ㄟ", "唔", "呣", "嗯嗯", "呃呃", "痾", "厄", "呃呃呃", "嗯嗯嗯", "額", "誒", "欸欸"]);

/** 軟贅詞：要看語境。 */
export const ZH_SOFT_FILLERS = new Set([
  "那個", "這個", "就是", "就是說", "然後", "對", "對啊", "對對", "對對對", "好", "ok", "okay", "反正", "基本上", "其實",
  "你知道", "你知道嗎", "怎麼講", "怎麼說", "我覺得", "所以說", "那", "嘛", "齁", "厚", "啊", "哦", "喔", "呢", "啦", "吼",
]);

export const EN_PURE_FILLERS = new Set(["um", "uh", "uhm", "erm", "er", "ah", "hmm", "mm", "mhm", "umm", "uhh"]);
export const EN_SOFT_FILLERS = new Set(["like", "you know", "i mean", "sort of", "kind of", "basically", "actually", "so", "right", "okay", "ok", "well"]);

/** Whisper 可能把多字詞拆開；依序比對 norm 串接。 */
export const MULTI_TOKEN: string[][] = [
  ["就是", "說"], ["你", "知道", "嗎"], ["你", "知道"], ["怎麼", "講"], ["怎麼", "說"], ["所以", "說"], ["基本", "上"],
  ["you", "know"], ["i", "mean"], ["sort", "of"], ["kind", "of"],
];

/** 「對」後接這些字 → 詞彙用法（對的 / 對於 / 對面…），保留。 */
export const DUI_KEEP_NEXT = new Set(["的", "於", "面", "方", "象", "話", "比", "應", "焦", "準", "手", "策", "待", "抗", "立", "照", "不對", "吧", "了", "嗎", "啊嗎"]);

/** 疊字白名單：不是口吃。 */
export const REDUP_WHITELIST = new Set([
  "謝謝", "看看", "慢慢", "常常", "天天", "剛剛", "漸漸", "往往", "偏偏", "稍稍", "好好", "等等", "想想", "試試", "聊聊", "走走", "談談", "說說",
  "媽媽", "爸爸", "哥哥", "姊姊", "姐姐", "弟弟", "妹妹", "寶寶", "星星", "一一", "年年", "人人", "處處", "時時", "緩緩", "輕輕", "深深", "久久", "悄悄",
  "漸漸地", "慢慢來", "拜拜", "掰掰", "怪怪", "多多", "少少", "大大", "小小", "剛好", "哈哈", "呵呵", "嘿嘿",
]);

/** 肯定 / 附和用語的重複（對對對、好好好）：保留一個。 */
export const AFFIRMATION = new Set(["對", "好", "是", "嗯", "恩", "yes", "yeah", "right", "ok", "okay"]);

/** 自我修正標記：restart 若夾這些，前後語意可能不同 → 只建議。 */
export const SELF_CORRECTION = new Set(["不是", "不對", "應該說", "我是說", "我的意思是", "或者說", "再講一次", "重講", "再來一次", "sorry", "抱歉", "等一下", "等等我重講", "更正", "correction"]);

/** 講者明確要求重錄的標記。 */
export const REDO_MARKERS = ["再來一次", "重講", "重來", "再講一次", "剛剛那段不算", "cut掉", "這段剪掉", "重錄", "再一次", "重新來"];

/** 「就是」前面是這些 → 係詞用法（我就是…），保留。 */
export const COPULA_SUBJECTS = new Set(["我", "他", "她", "它", "這", "那", "這個", "那個", "重點", "目的", "原因", "問題", "答案", "意思", "也", "不", "本來", "根本", "才", "你", "我們", "他們", "這樣", "那樣"]);

/** like 前面是這些 → 動詞 / 比喻用法，保留。 */
export const LIKE_KEEP_PREV = new Set(["i", "you", "we", "they", "he", "she", "would", "dont", "don't", "really", "just", "looks", "look", "sounds", "sound", "feels", "feel", "something", "anything"]);

/** 過度使用計數的連接詞。 */
export const OVERUSE_MARKERS = new Set(["然後", "就是", "其實"]);

/** 段落轉場語。 */
export const TRANSITION_WORDS = new Set(["好", "ok", "okay", "那"]);

export function isPureFiller(norm: string): boolean {
  return ZH_PURE_FILLERS.has(norm) || EN_PURE_FILLERS.has(norm);
}

export function isAnyFiller(norm: string): boolean {
  return isPureFiller(norm) || ZH_SOFT_FILLERS.has(norm) || EN_SOFT_FILLERS.has(norm);
}

/** Whisper 非語音標記：[音樂]、(笑聲)、♪ … */
export const NON_SPEECH_RE = /^[\s]*([\[(（【].*[\])）】]|♪+)[\s]*$/;
