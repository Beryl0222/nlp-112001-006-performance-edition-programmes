// 中文排演备忘的文本工具：只做定位与词面识别，不替编辑猜测语义。

export const ROLE_ALIASES = {
  渡人: ['ferryman'],
  河神: ['river god']
};

const CN_DIGITS = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9
};

const EN_ACT_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10
};

const TIME_WORDS = {
  早: '早场',
  日: '日场',
  午: '午场',
  晚: '晚场',
  夜: '夜场'
};

export const TIME_ORDER = ['早场', '日场', '午场', '晚场', '夜场'];

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function unique(values) {
  return [...new Set(values)];
}

export function parseChineseNumber(token) {
  if (!token) return null;
  if (token === '十') return 10;
  if (token.startsWith('廿')) return 20 + (CN_DIGITS[token[1]] ?? 0);
  if (token.startsWith('卅')) return 30 + (CN_DIGITS[token[1]] ?? 0);
  const ten = token.indexOf('十');
  if (ten >= 0) {
    const tens = ten === 0 ? 1 : (CN_DIGITS[token.slice(0, ten)] ?? 0);
    const ones = token.slice(ten + 1) ? (CN_DIGITS[token.slice(ten + 1)] ?? 0) : 0;
    return tens * 10 + ones;
  }
  return CN_DIGITS[token] ?? null;
}

export function numeralOfAct(act) {
  const match = /^第([零〇一二三四五六七八九十两]+)幕$/.exec(act);
  return match ? parseChineseNumber(match[1]) : null;
}

export function actLabel(number) {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (number >= 10) return `第${number}幕`;
  return `第${digits[number]}幕`;
}

// 按中文标点切分句读，保留在原文中的起止位置。
export function clauses(text) {
  const result = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index !== text.length && !'，。；;,\n！？!?'.includes(text[index])) continue;
    const raw = text.slice(start, index);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) {
      const offset = start + lead;
      result.push({
        text: trimmed,
        start: offset,
        end: offset + trimmed.length,
        terminatedBy: index < text.length ? text[index] : ''
      });
    }
    start = index + 1;
  }
  return result;
}

export function sentences(text) {
  const result = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index !== text.length && !'。！？!?\n'.includes(text[index])) continue;
    const raw = text.slice(start, index);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) {
      const offset = start + lead;
      result.push({
        text: trimmed,
        start: offset,
        end: offset + trimmed.length,
        clauses: clauses(trimmed).map(clause => ({
          ...clause,
          start: clause.start + offset,
          end: clause.end + offset
        }))
      });
    }
    start = index + 1;
  }
  return result;
}

// 日期：支持“十八日晚”“十九日晚场”“次日”“翌日”“第二天”。
export function dayRefs(text) {
  const found = [];
  const pattern = /(次日|翌日|第二天|([零〇一二三四五六七八九十廿卅两]{1,3})日)(早场|日场|午场|晚场|夜场|早|日|午|晚|夜)?/g;
  for (const match of text.matchAll(pattern)) {
    const relative = !match[2];
    const value = relative ? null : parseChineseNumber(match[2]);
    const timeToken = match[3] ?? '';
    found.push({
      relative,
      token: match[1],
      value,
      time: TIME_WORDS[timeToken] ?? (timeToken.endsWith('场') ? timeToken : null),
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return found;
}

export function groupRefs(text) {
  const found = [];
  for (const match of text.matchAll(/([甲乙丙丁戊己庚辛壬癸])组/g)) {
    found.push({
      group: `${match[1]}组`,
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return found;
}

// 幕次：显式第 X 幕、两幕、本幕/该幕（相对），以及英文 Act X。
export function actRefs(text) {
  const refs = [];
  for (const match of text.matchAll(/第([零〇一二三四五六七八九十百两]+)幕/g)) {
    const value = parseChineseNumber(match[1]);
    if (value !== null) {
      refs.push({ act: value, start: match.index, end: match.index + match[0].length, explicit: true });
    }
  }
  const both = /两幕|兩幕/.exec(text);
  if (both) {
    refs.push({ act: 'all', start: both.index, end: both.index + both[0].length, explicit: true });
  }
  for (const match of text.matchAll(/本幕|该幕|此幕|这一幕|該幕/g)) {
    refs.push({ act: 'current', start: match.index, end: match.index + match[0].length, explicit: true });
  }
  for (const match of text.matchAll(/\bAct\s+([A-Za-z]+|\d+)\b/gi)) {
    const token = match[1].toLowerCase();
    const value = /^\d+$/.test(token) ? Number(token) : EN_ACT_WORDS[token];
    if (value) {
      refs.push({ act: value, start: match.index, end: match.index + match[0].length, explicit: true });
    }
  }
  return refs.sort((a, b) => a.start - b.start);
}

export function roleRefs(text, roles) {
  const found = [];
  for (const role of roles) {
    let at = text.indexOf(role);
    while (at >= 0) {
      found.push({ role, start: at, end: at + role.length, text: role });
      at = text.indexOf(role, at + 1);
    }
    for (const alias of ROLE_ALIASES[role] ?? []) {
      const regex = new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'gi');
      for (const match of text.matchAll(regex)) {
        found.push({ role, start: match.index, end: match.index + match[0].length, text: match[0] });
      }
    }
  }
  return found.sort((a, b) => a.start - b.start || b.end - a.end);
}

// 在文本中定位已知人名/艺名。同一艺名可能对应多位演员，因此每个词面
// 返回全部候选，而不是先替编辑挑一个。
export function personRefs(text, people) {
  const byName = new Map();
  for (const person of people) {
    if (!byName.has(person.name)) byName.set(person.name, []);
    byName.get(person.name).push(person);
  }

  const found = [];
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  for (const name of names) {
    let at = text.indexOf(name);
    while (at >= 0) {
      const end = at + name.length;
      const overlaps = found.some(item => at < item.end && end > item.start);
      if (!overlaps) {
        const entries = byName.get(name);
        const keys = unique(entries.map(entry => entry.key));
        const performers = unique(entries.map(entry => entry.performer).filter(Boolean));
        found.push({
          name,
          start: at,
          end,
          text: name,
          key: keys.length === 1 ? keys[0] : 'mixed',
          performer: performers.length === 1 ? performers[0] : null,
          candidates: entries
        });
      }
      at = text.indexOf(name, at + 1);
    }
  }
  return found.sort((a, b) => a.start - b.start || b.end - a.end);
}

export function latinNames(text) {
  return [...text.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g)].map(match => ({
    name: match[0],
    start: match.index,
    end: match.index + match[0].length
  }));
}

export function hasAny(text, patterns) {
  return patterns.some(pattern => pattern.test(text));
}

export const MARKERS = {
  debut: [/首演/, /首次/, /第一次/, /\bdebut\b/i],
  standby: [/替补/, /候选/, /备选/, /备用/, /准备信息/, /\bstandby\b/i, /\balternate\b/i, /\bunderstudy\b/i],
  unchanged: [/不变/, /照旧/, /照常/, /如常/, /\bunchanged\b/i],
  change: [/改由/, /改为/, /换成/, /换由/, /接演/, /接替/, /替换/, /改派/, /\breplaced?\b/i],
  assign: [/唱/, /饰演/, /饰/, /出演/, /担任/, /担纲/, /负责/, /\bappears?\b/i, /\bplays?\b/i],
  historical: [/上一次/, /上次/, /此前/, /曾经/, /曾由/, /巡演/, /\bprevious\b/i, /\bformerly\b/i, /\blast\b/i],
  sameActor: [/两幕均/, /两幕都/, /同一位演员/, /同一演员/, /均由/, /\bthroughout\b/i, /\bsame (?:actor|performer)\b/i, /\bboth acts\b/i],
  romanization: [/印版/, /英文/, /拼写/, /应使用/, /\bprint(?:ed)? (?:as|name)\b/i],
  coBilling: [/合排/, /联合主演/, /\bco-?bill/i],
  deictic: [/今晚/, /本场/, /当日/, /今天/, /\btonight\b/i]
};

export function markerKinds(text) {
  const kinds = [];
  for (const [kind, patterns] of Object.entries(MARKERS)) {
    if (patterns.some(pattern => pattern.test(text))) kinds.push(kind);
  }
  return kinds;
}

export function compareTime(a, b) {
  const left = TIME_ORDER.indexOf(a);
  const right = TIME_ORDER.indexOf(b);
  return (left < 0 ? 99 : left) - (right < 0 ? 99 : right);
}
