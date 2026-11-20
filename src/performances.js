import { dayRefs, parseChineseNumber, unique } from './text.js';

const TIME_SUFFIX = /(早场|日场|午场|晚场|夜场|早|日|午|晚|夜)$/;
const TIME_NORMAL = {
  早: '早场', 日场: '日场', 日: '日场', 午: '午场',
  晚: '晚场', 夜: '夜场', 早场: '早场', 午场: '午场', 晚场: '晚场', 夜场: '夜场'
};

// “河剧十八日晚” → 作品“河剧”、18 日、晚场。日期本身沿用资料中的日号，
// 不擅自补年月；同一天有两个场次时靠后缀区分。
export function parsePerformanceName(name) {
  const original = name;
  let rest = name.trim();
  let time = null;
  const timeMatch = TIME_SUFFIX.exec(rest);
  if (timeMatch) {
    time = TIME_NORMAL[timeMatch[1]] ?? timeMatch[1];
    rest = rest.slice(0, -timeMatch[1].length);
  }

  let day = null;
  const arabic = /(?:^|[^\d])(\d{1,2})日/.exec(rest);
  const chinese = /([零〇一二三四五六七八九十廿卅两]{1,3})日/.exec(rest);
  let dayText = null;
  if (arabic) {
    day = Number(arabic[1]);
    dayText = `${arabic[1]}日`;
  } else if (chinese) {
    day = parseChineseNumber(chinese[1]);
    dayText = `${chinese[1]}日`;
  }

  let work = rest;
  if (dayText) {
    work = rest.slice(0, rest.indexOf(dayText)).replace(/[《》\s]/g, '');
  } else {
    work = work.replace(/[《》\s]/g, '');
  }
  if (!work) work = rest.replace(/[《》\s]/g, '') || original;

  return {
    original,
    work,
    day,
    time,
    label: original,
    key: `${work}|${day ?? '?'}|${time ?? '?'}`
  };
}

export function buildPerformances(castRows) {
  const byKey = new Map();
  for (const row of castRows) {
    const parsed = parsePerformanceName(row.performance);
    if (!byKey.has(parsed.key)) {
      byKey.set(parsed.key, {
        ...parsed,
        id: parsed.key,
        names: new Set(),
        slots: []
      });
    }
    const performance = byKey.get(parsed.key);
    performance.names.add(row.performance);
    performance.slots.push(row);
  }
  const list = [...byKey.values()].map(performance => ({
    ...performance,
    names: [...performance.names]
  }));

  // 卡司表里的场次写法（如“河剧十八日晚”）可能带作品名，
  // 统一补上解析后的 id 与 label，后续都按 id 对齐。
  for (const performance of list) {
    for (const row of performance.slots) {
      row.performanceId = performance.id;
      row.performanceLabel = performance.label;
    }
  }

  return Object.assign(list, {
    byId(id) {
      return list.find(performance => performance.id === id) ?? null;
    },
    ofRow(row) {
      return list.find(performance => performance.id === row.performanceId) ?? null;
    }
  });
}

// 把札记里的“十八日晚”“次日”“十九日”解析到具体场次。
// anchor 是同一札记内上文的绝对日号，用于“次日”这类省略。
export function resolveDayReference(ref, performances, anchor = null) {
  let day = ref.value;
  if (ref.relative) {
    if (anchor === null || anchor === undefined) {
      return { performances: [], day: null, reason: '缺少可参照的日期' };
    }
    day = anchor + 1;
  }
  if (day === null) return { performances: [], day, reason: '无法解析日号' };

  let candidates = performances.filter(performance => performance.day === day);
  if (ref.time) {
    const byTime = candidates.filter(performance => performance.time === ref.time);
    if (byTime.length) candidates = byTime;
    else return { performances: [], day, reason: `当日没有${ref.time}` };
  }
  return {
    performances: candidates,
    day,
    reason: candidates.length ? null : '没有对应场次',
    ambiguous: candidates.length > 1
  };
}

export function performancesOnDay(performances, day, time = null) {
  if (day === null || day === undefined) return [];
  return performances.filter(performance =>
    performance.day === day && (!time || performance.time === time)
  );
}

export function findPerformance(performances, query) {
  const normalized = query.trim();
  const direct = performances.filter(performance =>
    performance.id === normalized || performance.label === normalized ||
    performance.names.includes(normalized)
  );
  if (direct.length) return direct;
  const parsed = parsePerformanceName(normalized);
  return performances.filter(performance =>
    performance.work === parsed.work &&
    (parsed.day === null || performance.day === parsed.day) &&
    (parsed.time === null || performance.time === parsed.time)
  );
}

export { dayRefs };
