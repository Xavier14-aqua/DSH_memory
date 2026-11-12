// v0.10.1 保守型消息过滤器：只丢弃确定无长期价值的内容；拿不准一律 normal。

const IMPORTANT_PATTERNS = [
  /我(?:喜欢|讨厌|不喜欢|最爱|害怕|怕)(?![吗么？?])/,
  /以后(?:不要|别|记得|打算|准备)/,
  /(?:下周|下个月|明天|后天|今年|最近).{0,12}(?:准备|计划|要去|考试|面试|搬家|旅行)/,
  /(?:换工作|辞职|入职|毕业|结婚|分手|生病|住院|搬家|退群)/,
  /(?:刚才|之前).{0,8}(?:说错|记错|不是|其实)/,
  /(?:我们|他俩|她俩).{0,8}(?:吵架|和好|冷战|闹翻)/,
  /(?:群规|规矩|雷区|禁止|不许|别聊)/
];

const LOW_VALUE = /^(?:哈{1,12}|哈哈哈+|呵呵+|嘿嘿+|嗯+|哦+|噢+|啊+|好+|行|可以|收到|知道了|来了|走了|睡了|晚安|早|早安|\+1|1|6{2,6}|草+|笑死|确实|对|是的|没事|谢谢|谢了)[。！!？?~～…]*$/i;
const MEDIA_ONLY = /^(?:\[(?:图片|表情|视频|语音|动画表情|文件)\]|【(?:图片|表情|视频|语音)】|\[CQ:[^\]]+\])$/i;
const PUNCT_ONLY = /^[\s\p{P}\p{S}]+$/u;
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\uFE0F|\u200D|\s)+$/u;

function textOf(message) {
  return String(message?.text ?? message?.plain ?? '').replace(/\s+/g, ' ').trim();
}

export function classifyMessage(message, { previous = null } = {}) {
  const text = textOf(message);
  if (message?.recalled === true || message?.withdrawn === true || message?.isRecalled === true || message?.recalledAt) {
    return { level: 'ignore', reason: 'recalled', text };
  }
  if (!text) return { level: 'ignore', reason: 'empty', text };
  if (/^\/[a-z][\w-]*(?:\s|$)/i.test(text)) return { level: 'ignore', reason: 'command', text };
  if (PUNCT_ONLY.test(text) || EMOJI_ONLY.test(text)) return { level: 'ignore', reason: 'symbol-only', text };
  if (MEDIA_ONLY.test(text)) return { level: 'low', reason: 'media-placeholder', text };
  if (LOW_VALUE.test(text)) return { level: 'low', reason: 'short-ack', text };
  if (previous) {
    const sameSender = String(previous.userId ?? '') === String(message?.userId ?? '');
    const sameText = textOf(previous) === text;
    const within = Math.abs((Number(message?.time) || 0) - (Number(previous.time) || 0)) <= 30_000;
    if (sameSender && sameText && within && text.length <= 30) return { level: 'low', reason: 'rapid-duplicate', text };
  }
  if (IMPORTANT_PATTERNS.some((pattern) => pattern.test(text))) return { level: 'important', reason: 'long-term-signal', text };
  return { level: 'normal', reason: 'substantive', text };
}

export function isInformative(level) {
  return level === 'normal' || level === 'important';
}
