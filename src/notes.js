import {
  actRefs,
  dayRefs,
  groupRefs,
  latinNames,
  markerKinds,
  personRefs,
  roleRefs,
  sentences,
  unique
} from './text.js';
import { resolveDayReference } from './performances.js';

// 资料自带的 authority 字段并不统一，这里只用于同一日期内的先后取舍。
const AUTHORITY_RANK = {
  舞台监督: 3,
  制作室: 2,
  排练员: 1
};

const NAME_STOPWORDS = new Set([
  '今晚', '本场', '当日', '今天', '本幕', '该幕', '此幕', '印版', '英文', '拼写',
  '演出', '演员', '节目', '名单', '替补', '名册', '准备', '信息', '首演', '接演',
  '不变', '照旧', '照常', '如常', '制作', '监督', '排练', '剧院', '巡演', '电子',
  '通用', '合印', '内页', '卡司', '角色', '场次', '版本', '校对', '编辑', '导演',
  '舞台', '观众', '票面', '纸本', '印厂', '更正', '确认', '安排', '第一', '第二',
  '第三', '两幕', '同一位', '首次', '第一次', '上一次', '此前', '曾经'
]);

export function authorityRank(authority) {
  return AUTHORITY_RANK[authority] ?? 0;
}

export function buildRoster(castRows, extraPerformers = []) {
  const performers = new Map();
  const stageNames = new Map();

  const addPerformer = (name, stageName = null) => {
    if (!performers.has(name)) {
      performers.set(name, { name, stageNames: new Set(), castRows: [] });
    }
    const record = performers.get(name);
    if (stageName) record.stageNames.add(stageName);
    return record;
  };

  for (const row of castRows) {
    addPerformer(row.performer, row.stageName).castRows.push(row);
    if (!stageNames.has(row.stageName)) stageNames.set(row.stageName, new Set());
    stageNames.get(row.stageName).add(row.performer);
  }
  for (const extra of extraPerformers) {
    addPerformer(extra.name, extra.stageName ?? null);
  }

  return {
    performers,
    stageNames,
    // 同一艺名指向多位演员时，全部候选都要交给编辑，不擅自择一。
    candidatesForStageName(stageName) {
      return [...(stageNames.get(stageName) ?? [])].map(name => ({
        performer: name,
        stageNames: [...(performers.get(name)?.stageNames ?? [])],
        castRows: performers.get(name)?.castRows ?? []
      }));
    },
    isStandbyOnly(name) {
      const record = performers.get(name);
      return !!record && record.castRows.length === 0;
    },
    registerSpelling(performer, stageName) {
      const record = addPerformer(performer);
      record.stageNames.add(stageName);
      if (!stageNames.has(stageName)) stageNames.set(stageName, new Set());
      stageNames.get(stageName).add(performer);
    },
    peopleForMatching() {
      const people = [];
      for (const performer of performers.values()) {
        people.push({
          name: performer.name,
          key: 'performer',
          performer: performer.name,
          stageName: null,
          castRows: performer.castRows
        });
        for (const stageName of performer.stageNames) {
          people.push({
            name: stageName,
            key: 'stageName',
            performer: performer.name,
            stageName,
            castRows: performer.castRows
          });
        }
      }
      return people;
    }
  };
}

function discoverPeople(text, roster, roleNames) {
  const people = [];
  const push = (name, start, end, key, performer = null, candidates = null) => {
    if (!name || NAME_STOPWORDS.has(name)) return;
    if (roleNames.includes(name)) return;
    if (people.some(item => start < item.end && end > item.start)) return;
    people.push({ name, start, end, key, performer, ...(candidates ? { candidates } : {}) });
  };

  for (const ref of personRefs(text, roster.peopleForMatching())) {
    // 一个词面命中多位演员（通常是同名艺名）时，保持候选，不择一。
    if (ref.candidates.length > 1) {
      push(
        ref.name,
        ref.start,
        ref.end,
        ref.key === 'mixed' ? 'performer' : ref.key,
        ref.performer,
        unique(ref.candidates.map(candidate => candidate.performer ?? candidate.name))
      );
    } else {
      push(ref.name, ref.start, ref.end, ref.key, ref.performer);
    }
  }

  const patterns = [
    /(?:改由|换由|改派|由)\s*([一-鿿]{2,3})\s*(?=接演|接替|替换|饰演|出演|担任|唱)/g,
    /([一-鿿]{2,3})\s*(?=接演|接替|替换)/g,
    /名册含\s*([一-鿿]{2,3})/g,
    /([一-鿿]{2,3})\s*(?=饰演|饰|出演|担任|唱)/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      const start = match.index + match[0].lastIndexOf(name);
      push(name, start, start + name.length, 'performer');
    }
  }

  for (const ref of latinNames(text)) {
    const known = roster.candidatesForStageName(ref.name);
    if (known.length > 1) {
      push(ref.name, ref.start, ref.end, 'stageName', null, known.map(item => item.performer));
    } else if (known.length === 1) {
      push(ref.name, ref.start, ref.end, 'stageName', known[0].performer);
    } else {
      push(ref.name, ref.start, ref.end, 'stageName');
    }
  }

  return people.sort((a, b) => a.start - b.start || b.end - a.end);
}

// 角色与人的对应：逐项配对，人比角色多时保留候选而不择一。
function pairRolesAndPeople(roles, people) {
  if (roles.length === 0) return people.map(person => ({ role: null, person }));
  if (people.length === 0) return roles.map(role => ({ role, person: null }));
  if (roles.length === people.length) {
    return roles.map((role, index) => ({ role, person: people[index] }));
  }
  if (people.length === 1) {
    return roles.map(role => ({ role, person: people[0] }));
  }
  if (roles.length === 1) {
    return [{ role: roles[0], person: null, candidates: people, ambiguous: true }];
  }
  return roles.flatMap(role => people.map(person => ({ role, person })));
}

function locate(note, record, clause) {
  if (!record) {
    return { id: note.id, start: clause.start, end: clause.end, text: clause.text };
  }
  const at = clause.text.indexOf(record.name);
  return at < 0
    ? { id: note.id, start: clause.start, end: clause.end, text: clause.text }
    : {
        id: note.id,
        start: clause.start + at,
        end: clause.start + at + record.name.length,
        text: record.name
      };
}

export function parseNotes(materials, model) {
  const { notes, cast, performances } = materials;
  const roleNames = model.roles;
  const roster = buildRoster(cast, model.extraPerformers ?? []);

  const statements = [];
  const issues = [];

  for (const note of notes) {
    // 只继承场次、组别、幕次和角色；“次日”“本幕”这类省略靠它补全。
    // 人名不跨句读继承，避免把上一句的演员带到“第一幕照旧”这种句子上。
    const context = {
      day: null,
      performances: [],
      pendingPerformances: [],
      group: null,
      act: null,
      role: null,
      lastAbsoluteDay: null
    };

    for (const sentence of sentences(note.text)) {
      // 角色与幕次都可承接上文（“本幕”“次日”“她…”）。只在遇到新的
      // 显式幕次时更新，避免把上一句的幕次误当成新一句的限定。
      context.role = null;

      for (const clause of sentence.clauses) {
        const days = dayRefs(clause.text);
        let dayRef = null;
        if (days.length) {
          dayRef = days[0];
          const resolved = resolveDayReference(dayRef, performances, context.lastAbsoluteDay);
          if (!resolved.performances.length) {
            issues.push({
              code: dayRef.relative ? 'relative-day-without-anchor' : 'day-without-performance',
              severity: 'error',
              noteId: note.id,
              span: { id: note.id, start: clause.start, end: clause.end, text: clause.text },
              message: dayRef.relative
                ? '“次日”类说法前文没有绝对日期，无法确定场次'
                : `找不到${dayRef.token}${dayRef.time ?? ''}对应的场次：${resolved.reason}`
            });
          } else if (resolved.ambiguous) {
            issues.push({
              code: 'day-ambiguous',
              severity: 'warning',
              noteId: note.id,
              span: { id: note.id, start: clause.start, end: clause.end, text: clause.text },
              message: `${dayRef.token}${dayRef.time ?? ''}对应多场，需由编辑指定`,
              candidates: resolved.performances.map(performance => performance.label)
            });
          }
          context.day = resolved.day;
          if (!dayRef.relative) context.lastAbsoluteDay = resolved.day;
          // 日号对应多场时不能替编辑挑一场：保留候选，并让句子里的安排
          // 只作为候选场次的待定记录，不写进任何一场的确认安排。
          context.performances = resolved.ambiguous ? [] : resolved.performances;
          context.pendingPerformances = resolved.ambiguous ? resolved.performances : [];
        }

        const groups = groupRefs(clause.text);
        if (groups.length) {
          context.group = groups[0].group;
          statements.push({
            kind: 'group',
            group: groups[0].group,
            noteId: note.id,
            date: note.date,
            authority: note.authority,
            authorityRank: authorityRank(note.authority),
            performances: context.performances.map(performance => performance.id),
            performanceLabels: context.performances.map(performance => performance.label),
            span: {
              id: note.id,
              start: clause.start + groups[0].start,
              end: clause.start + groups[0].end,
              text: groups[0].group
            },
            text: clause.text
          });
        }

        const acts = actRefs(clause.text);
        let actList = null;
        if (acts.length) {
          actList = [];
          for (const ref of acts) {
            if (ref.act === 'current') {
              if (context.act !== null) {
                actList.push(context.act);
              } else {
                issues.push({
                  code: 'relative-act-without-anchor',
                  severity: 'error',
                  noteId: note.id,
                  span: { id: note.id, start: clause.start, end: clause.end, text: clause.text },
                  message: '“本幕”前文没有可继承的幕次，无法确定适用幕'
                });
              }
            } else if (ref.act === 'all') {
              actList.push('all');
            } else {
              actList.push(ref.act);
              context.act = ref.act;
            }
          }
        }

        const roles = roleRefs(clause.text, roleNames);
        const explicitRoles = unique(roles.map(ref => ref.role));
        if (explicitRoles.length) context.role = explicitRoles[explicitRoles.length - 1];

        const people = discoverPeople(clause.text, roster, roleNames);
        const kinds = markerKinds(clause.text);

        // 后句省略角色时，沿用前句的角色；人名只在本身出现时才算。
        const resolvedRoles = explicitRoles.length
          ? explicitRoles
          : (context.role ? [context.role] : []);
        const pairs = pairRolesAndPeople(resolvedRoles, people);

        for (const pair of pairs) {
          const person = pair.person;
          const role = pair.role;
          if (!role && !person && !kinds.length) continue;

          let kind = 'mention';
          if (kinds.includes('standby')) kind = 'standby';
          else if (kinds.includes('coBilling')) kind = 'co-billing';
          else if (kinds.includes('historical')) kind = 'historical';
          else if (kinds.includes('debut')) kind = 'debut';
          else if (kinds.includes('romanization') && person) kind = 'spelling';
          else if (kinds.includes('change')) kind = 'change';
          else if (kinds.includes('unchanged')) kind = 'unchanged';
          else if (kinds.includes('assign')) kind = 'assign';

          const statement = {
            kind,
            noteId: note.id,
            date: note.date,
            authority: note.authority,
            authorityRank: authorityRank(note.authority),
            text: clause.text,
            role,
            performer: person?.performer ?? (person?.key === 'performer' ? person.name : null),
            name: person?.name ?? null,
            nameKey: person?.key ?? null,
            candidates: person?.candidates ?? null,
            group: context.group,
            performances: context.performances.map(performance => performance.id),
            performanceLabels: context.performances.map(performance => performance.label),
            day: context.day,
            acts: actList,
            inherited: {
              day: !dayRef,
              role: !explicitRoles.length && !!role,
              act: !actList && !!context.act
            },
            span: locate(note, person, clause)
          };

          if (pair.ambiguous) {
            statement.kind = 'co-billing';
            statement.ambiguousPeople = pair.candidates.map(candidate => ({
              name: candidate.name,
              performer: candidate.performer,
              stageName: candidate.key === 'stageName' ? candidate.name : null
            }));
            issues.push({
              code: 'co-billing-role',
              severity: 'warning',
              noteId: note.id,
              span: statement.span,
              message: `一条记录为角色“${role}”列出多人，不能据此确认当晚人选`,
              candidates: statement.ambiguousPeople.map(candidate => candidate.name)
            });
          }

          if (kind === 'spelling') {
            const latin = latinNames(clause.text)[0];
            statement.stageName = latin?.name ?? null;
          }

          if (kind === 'standby') statement.rosterOnly = true;
          if (kind === 'debut') statement.eventOnly = true;
          if (kind === 'historical') statement.notCurrent = true;

          if (!statement.performances.length &&
              !['standby', 'historical', 'spelling', 'group'].includes(kind)) {
            issues.push({
              code: context.pendingPerformances.length
                ? 'statement-needs-performance-choice'
                : 'statement-without-performance',
              severity: context.pendingPerformances.length ? 'error' : 'warning',
              noteId: note.id,
              span: statement.span,
              message: context.pendingPerformances.length
                ? `这条记录涉及的场次未定（${context.pendingPerformances.map(item => item.label).join('、')}），需编辑指定后才会写入安排`
                : '这条记录没有可对应的场次，未并入当前安排'
            });
          }

          // 拼写记录可能要靠后文/前文承接演员，留到最后统一判定。
          if (person && person.key === 'stageName' && !statement.performer &&
              person.candidates?.length > 1 && kind !== 'spelling') {
            issues.push({
              code: 'stage-name-without-performer',
              severity: 'warning',
              noteId: note.id,
              span: statement.span,
              message: `艺名“${person.name}”对应多位演员，需编辑按场次与角色确认`,
              candidates: person.candidates
            });
          }

          statements.push(statement);
        }
      }
    }
  }

  // “印版应使用 Cheng Qiu”这类句子不重述人名，承接同一札记中最近一次换角。
  for (const note of notes) {
    const inNote = statements.filter(statement => statement.noteId === note.id);
    for (let index = 0; index < inNote.length; index += 1) {
      const statement = inNote[index];
      if (statement.kind !== 'spelling' || statement.performer || !statement.stageName) continue;
      for (let back = index - 1; back >= 0; back -= 1) {
        const prior = inNote[back];
        if (prior.performer && ['change', 'assign'].includes(prior.kind)) {
          statement.performer = prior.performer;
          statement.span = prior.span;
          break;
        }
      }
    }
  }

  // 札记里首次出现、卡司表没有的人名（如接演者、替补）也要进入名册。
  for (const statement of statements) {
    if (statement.kind === 'spelling' && statement.stageName && !statement.performer) {
      issues.push({
        code: 'spelling-without-performer',
        severity: 'warning',
        noteId: statement.noteId,
        span: statement.span,
        message: `拼写“${statement.stageName}”前文没有可承接的演员`
      });
      continue;
    }
    if (statement.performer && !roster.performers.has(statement.performer)) {
      roster.performers.set(statement.performer, {
        name: statement.performer,
        stageNames: new Set(),
        castRows: []
      });
    }
    if (statement.kind === 'spelling' && statement.stageName && statement.performer) {
      roster.registerSpelling(statement.performer, statement.stageName);
    }
  }

  return { statements, issues, roster };
}
