import {
  actLabel,
  dayRefs,
  latinNames,
  markerKinds,
  personRefs,
  roleRefs,
  sentences,
  unique
} from './text.js';
import { performancesOnDay } from './performances.js';

const EN_ACT_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10
};

// 英文文案里的舞台词汇，不是人名，不能当成“找不到的署名”报错。
const EN_STOPWORDS = new Set([
  'Act', 'Scene', 'The', 'A', 'An', 'This', 'Tonight', 'Both', 'Two', 'One',
  'Ferryman', 'River', 'God', 'Programme', 'Program', 'Cast', 'Director',
  'Stage', 'Manager', 'She', 'He', 'They', 'Her', 'His', 'Their', 'In', 'On'
]);

const CN_ACT_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

// 文案自身的 context 决定它本来能覆盖哪些场次：
// 写明日期的只覆盖该场；写“合印/节目册”的是通用页；其余不擅自扩大。
// 只写日号而当日有多场时，先覆盖这几场，再由正文的场次字样收窄。
function contextScope(context, model) {
  const days = dayRefs(context);
  if (days.length) {
    const matches = performancesOnDay(model.performances, days[0].value, days[0].time);
    const saidTimes = unique(matches.map(match => match.time).filter(Boolean));
    const narrowed = matches.filter(match => {
      if (!saidTimes.length) return true;
      return match.time && context.includes(match.time);
    });
    const chosen = narrowed.length ? narrowed : matches;
    return {
      kind: chosen.length === 1 ? 'performance' : 'performances',
      performanceIds: chosen.map(performance => performance.id)
    };
  }
  if (/合印|通用|共用|内页|节目册|场刊/.test(context)) {
    return { kind: 'general', performanceIds: model.performances.map(performance => performance.id) };
  }
  return { kind: 'none', performanceIds: [] };
}

function roleActsFor(model, performanceId, role) {
  return model.schedule
    .forPerformance(performanceId)
    .filter(slot => slot.role === role)
    .map(slot => slot.act);
}

function claimsIn(text, model) {
  const roles = unique(roleRefs(text, model.roles).map(ref => ref.role));

  const acts = [];
  for (const sentence of sentences(text)) {
    for (const clause of sentence.clauses) {
      for (const match of clause.text.matchAll(/第([零〇一二三四五六七八九十两]+)幕/g)) {
        const value = CN_ACT_DIGITS[match[1]] ?? Number(match[1]);
        if (Number.isFinite(value)) acts.push(value);
      }
      if (/两幕|兩幕/.test(clause.text)) acts.push('all');
      for (const match of clause.text.matchAll(/\bAct\s+([A-Za-z]+|\d+)\b/gi)) {
        const token = match[1].toLowerCase();
        acts.push(/^\d+$/.test(token) ? Number(token) : EN_ACT_WORDS[token]);
      }
    }
  }

  // 正文自己点名了哪一天，就只能用于那一天；不能拿“十九日”的句子
  // 去印十八日的场次。相对说法（次日/今晚）不参与此判断。
  const days = dayRefs(text)
    .filter(ref => !ref.relative)
    .map(ref => ({
      token: ref.token,
      value: ref.value,
      performanceIds: performancesOnDay(model.performances, ref.value, ref.time)
        .map(performance => performance.id)
    }));

  const people = personRefs(text, model.roster.peopleForMatching()).map(ref => {
    const candidates = unique(
      ref.candidates
        .map(candidate => candidate.performer ?? candidate.name)
        .filter(Boolean)
    );
    return {
      name: ref.name,
      key: ref.key,
      performer: ref.performer,
      candidates,
      start: ref.start,
      end: ref.end,
      evidence: ref.candidates.map(candidate => ({
        stageName: candidate.stageName ?? null,
        castRowIds: (candidate.castRows ?? []).map(row => row.id)
      }))
    };
  });

  // 英文稿里出现了名册没有的拉丁名，可能是拼错或旧署名，提示编辑核对，
  // 而不是默默放过。只取像人名的词，跳过 Act/Ferryman 这类舞台词汇。
  const unknownNames = latinNames(text)
    .filter(ref => !people.some(person => person.start === ref.start))
    .filter(ref => {
      const words = ref.name.split(/\s+/);
      return words.every(word => !EN_STOPWORDS.has(word));
    })
    .map(ref => ref.name);

  const kinds = markerKinds(text);

  return {
    roles,
    acts: unique(acts),
    days,
    people,
    unknownNames,
    sameActor: kinds.includes('sameActor'),
    debut: kinds.includes('debut'),
    historical: kinds.includes('historical'),
    deictic: kinds.includes('deictic'),
    standbyClaim: kinds.includes('standby')
  };
}

function evidenceForPerformer(model, performer) {
  const record = model.roster.performers.get(performer);
  if (!record) return [];
  const evidence = record.castRows.map(row => ({
    type: 'cast',
    id: row.id,
    performance: row.performance,
    act: row.act,
    role: row.role,
    stageName: row.stageName
  }));
  for (const statement of model.statements) {
    if (statement.performer === performer && statement.performanceLabels.length) {
      evidence.push({
        type: 'note',
        id: statement.noteId,
        date: statement.date,
        kind: statement.kind,
        span: statement.span
      });
    }
  }
  return evidence;
}

function pickPerson(claims, role) {
  return claims.people.find(person => person.performer || person.candidates.length) ?? null;
}

// 一个署名是否对得上当前安排。艺名候选多于一位时不能替编辑拍板。
function judgeSignature(model, person, performance, act, role, slot) {
  const reasons = [];
  const candidates = person.candidates.length ? person.candidates : [person.performer].filter(Boolean);

  if (person.key === 'stageName') {
    if (!candidates.length) {
      return {
        status: 'fails',
        reasons: [{
          code: 'unknown-stage-name',
          severity: 'error',
          message: `“${person.name}”在资料中找不到对应演员`
        }]
      };
    }
    if (candidates.length > 1) {
      reasons.push({
        code: 'stage-name-ambiguous',
        severity: 'warning',
        message: `“${person.name}”在资料中同时对应 ${candidates.join('、')}，需编辑按场次与角色确认`,
        candidates: candidates.map(performer => ({
          performer,
          evidence: evidenceForPerformer(model, performer)
        }))
      });
    }
  }

  if (slot.status !== 'confirmed') {
    reasons.push({
      code: 'assignment-unconfirmed',
      severity: 'error',
      message: `${performance.label} ${act} ${role} 的安排尚未确认${slot.conflict ? `：${slot.conflict.message}` : ''}`,
      candidates: slot.conflict?.candidates ?? null
    });
    return { status: 'unknown', reasons };
  }

  if (!candidates.includes(slot.performer)) {
    reasons.push({
      code: 'stale-performer',
      severity: 'error',
      message: `${performance.label} ${act} ${role} 现为 ${slot.performer}${slot.stageName ? `（${slot.stageName}）` : ''}，文案却写 ${person.name}`,
      expected: slot.performer,
      found: person.name
    });
    return { status: 'fails', reasons, stale: true };
  }

  if (person.key === 'stageName' && slot.stageName && person.name.trim() !== slot.stageName) {
    reasons.push({
      code: 'spelling-mismatch',
      severity: 'error',
      message: `${slot.performer} 的印版拼写应为 ${slot.stageName}，文案写 ${person.name}`,
      expected: slot.stageName
    });
  }

  if (candidates.length > 1) {
    const resolved = candidates.includes(slot.performer)
      ? candidates.filter(candidate => candidate !== slot.performer)
      : [];
    if (resolved.length) {
      reasons.push({
        code: 'ambiguous-name-resolved-by-schedule',
        severity: 'warning',
        message: `按当前安排先取 ${slot.performer}；另一位候选 ${resolved.join('、')} 见名册。编辑仍需确认文案没有指错人`
      });
    }
  }

  return { status: reasons.some(reason => reason.severity === 'error') ? 'fails' : 'holds', reasons };
}

function judgeDebut(model, performanceId, performer, role) {
  const debuts = model.statements.filter(statement => statement.kind === 'debut');
  if (!debuts.length) {
    return {
      status: 'unknown',
      reason: {
        code: 'debut-unverified',
        severity: 'warning',
        message: '“首次/首演”在札记中没有依据，需人工核实，不能据以共用'
      }
    };
  }
  const confirmed = debuts.find(statement =>
    statement.performances.includes(performanceId) &&
    (!performer || statement.performer === performer) &&
    (!role || !statement.role || statement.role === role)
  );
  if (confirmed) {
    return {
      status: 'holds',
      reason: {
        code: 'debut-confirmed',
        severity: 'info',
        message: `“首次/首演”有札记依据：${confirmed.noteId} ${confirmed.date}`
      }
    };
  }
  // 札记里的首演属于别的场次/别的演员时，只能说“本场的首次尚无依据”，
  // 不能把别人的首演经历搬过来，也不能反过来断言本场一定不是首次。
  const elsewhere = debuts.find(statement =>
    statement.performer && (!performer || statement.performer !== performer)
  );
  const target = model.performances.find(item => item.id === performanceId)?.label ?? performanceId;
  return {
    status: 'unknown',
    reason: {
      code: 'debut-elsewhere',
      severity: 'warning',
      message: elsewhere
        ? `资料中的首演记录属于 ${elsewhere.performer} 的 ${elsewhere.performanceLabels.join('、')}，不能当作 ${target} 的依据`
        : `“首次/首演”没有对应到 ${target}${performer ? ` 的 ${performer}` : ''}，需人工核实`
    }
  };
}

function evaluateScope(performance, claims, model) {
  const results = [];

  for (const role of claims.roles) {
    const roleActs = roleActsFor(model, performance.id, role);
    if (!roleActs.length) {
      results.push({
        performanceId: performance.id,
        performanceLabel: performance.label,
        role,
        status: 'unknown',
        reasons: [{
          code: 'role-not-in-performance',
          severity: 'warning',
          message: `${performance.label} 的${role}没有对应的幕次资料`
        }]
      });
      continue;
    }

    let actList = roleActs;
    if (claims.acts.length && !claims.acts.includes('all')) {
      const wanted = claims.acts.map(act => actLabel(act));
      const narrowed = roleActs.filter(act => wanted.includes(act));
      actList = narrowed.length ? narrowed : wanted;
    }

    const person = pickPerson(claims, role);

    if (claims.sameActor) {
      const slots = actList
        .map(act => model.schedule.byCell(performance.id, act, role))
        .filter(Boolean);
      const performers = unique(slots.map(slot => slot.performer).filter(Boolean));
      const unconfirmed = slots.some(slot => slot.status !== 'confirmed');
      const reasons = [];

      if (slots.length !== actList.length) {
        reasons.push({
          code: 'missing-cast-slot',
          severity: 'error',
          message: `${performance.label} 有幕次缺少${role}的卡司资料`
        });
      }
      if (unconfirmed) {
        reasons.push({
          code: 'assignment-unconfirmed',
          severity: 'error',
          message: `${performance.label} 的${role}尚有未确认的幕次`
        });
      }
      if (!unconfirmed && performers.length > 1) {
        reasons.push({
          code: 'cross-act-claim-false',
          severity: 'error',
          message: `“${actList.join('、')}同一位演员”不成立：${slots.map(slot => `${slot.act} ${slot.performer}`).join('、')}`,
          expected: slots.map(slot => ({ act: slot.act, performer: slot.performer, stageName: slot.stageName }))
        });
      }

      let status = 'holds';
      if (unconfirmed || slots.length !== actList.length) status = 'unknown';
      else if (performers.length > 1) status = 'fails';

      const effective = performers.length === 1 ? performers[0] : null;

      // “两幕同一人”仍然要对得上具体署名；不能因为句式笼统就放过旧名字。
      if (status === 'holds' && person) {
        const representative = slots[0];
        const judged = judgeSignature(model, person, performance, actList[0], role, representative);
        reasons.push(...judged.reasons);
        if (judged.status !== 'holds') status = judged.status;
      }

      if (status === 'holds' && claims.debut) {
        const debut = judgeDebut(model, performance.id, effective, role);
        if (debut.status !== 'holds') status = debut.status;
        reasons.push(debut.reason);
      }

      results.push({
        performanceId: performance.id,
        performanceLabel: performance.label,
        act: actList.length === 1 ? actList[0] : 'all',
        acts: actList,
        role,
        status,
        expected: {
          byAct: slots.map(slot => ({
            act: slot.act,
            performer: slot.performer,
            stageName: slot.stageName
          })),
          performer: effective,
          confirmed: !unconfirmed
        },
        written: person?.name ?? null,
        reasons
      });
      continue;
    }

    for (const act of actList) {
      const slot = model.schedule.byCell(performance.id, act, role);
      if (!slot) {
        results.push({
          performanceId: performance.id,
          performanceLabel: performance.label,
          act,
          role,
          status: 'unknown',
          reasons: [{
            code: 'missing-cast-slot',
            severity: 'error',
            message: `${performance.label} ${act} 没有${role}的卡司资料`
          }]
        });
        continue;
      }

      if (person) {
        const judged = judgeSignature(model, person, performance, act, role, slot);
        const reasons = [...judged.reasons];
        let status = judged.status;
        if (status === 'holds' && claims.debut) {
          const debut = judgeDebut(model, performance.id, slot.performer, role);
          if (debut.status !== 'holds') status = debut.status;
          reasons.push(debut.reason);
        }
        results.push({
          performanceId: performance.id,
          performanceLabel: performance.label,
          act,
          role,
          status,
          expected: {
            performer: slot.performer,
            stageName: slot.stageName,
            confirmed: slot.status === 'confirmed'
          },
          written: person.name,
          reasons
        });
        continue;
      }

      results.push({
        performanceId: performance.id,
        performanceLabel: performance.label,
        act,
        role,
        status: slot.status === 'confirmed' ? 'holds' : 'unknown',
        expected: {
          performer: slot.performer,
          stageName: slot.stageName,
          confirmed: slot.status === 'confirmed'
        },
        reasons: slot.status === 'confirmed'
          ? []
          : [{
              code: 'assignment-unconfirmed',
              severity: 'error',
              message: `${performance.label} ${act} ${role} 的安排尚未确认`
            }]
      });
    }
  }

  return results;
}

export function checkCopyItem(item, model) {
  const scope = contextScope(item.context, model);
  const claims = claimsIn(item.text, model);
  const reasons = [];

  if (claims.historical) {
    for (const person of claims.people) {
      if (person.performer && model.roster.isStandbyOnly(person.performer)) {
        reasons.push({
          code: 'standby-in-current-copy',
          severity: 'warning',
          message: `${person.performer} 在资料中只出现在替补名单里，不能据此写成当前演员`
        });
      }
    }
    reasons.unshift({
      code: 'historical-claim',
      severity: 'warning',
      message: '这是以往演出的经历，不能并入当前演出资料'
    });
    return {
      id: item.id,
      language: item.language,
      context: item.context,
      text: item.text,
      scope,
      claims,
      results: [],
      applicable: false,
      shareable: false,
      notCurrent: true,
      needsTranslationReview: false,
      reasons
    };
  }

  const results = [];
  for (const performanceId of scope.performanceIds) {
    const performance = model.performances.find(candidate => candidate.id === performanceId);
    if (!performance) continue;
    results.push(...evaluateScope(performance, claims, model));
  }

  // 通用页上的“今晚/本场”对每一场都只能成立一次，不能一张纸供多场。
  if (claims.deictic && scope.performanceIds.length > 1) {
    reasons.push({
      code: 'deictic-on-shared-page',
      severity: 'error',
      message: '页面写“今晚/本场”，却要供多场共用：必须拆成按场的版本，或改写为无指示语的说法',
      performances: scope.performanceIds
    });
  }

  // 正文点名了某一天时，只有那一天能算成立。
  for (const day of claims.days) {
    const matching = results.filter(result => day.performanceIds.includes(result.performanceId));
    const stray = results.filter(result => !day.performanceIds.includes(result.performanceId));
    if (stray.length) {
      // 正文点名的是另一天，这页对剩余场次就是明确不成立，而不是“待核实”。
      for (const result of stray) {
        result.status = 'fails';
        result.reasons.push({
          code: 'day-claim-elsewhere',
          severity: 'error',
          message: `文案写的是${day.token}的事，不能印到${result.performanceLabel ?? result.performanceId}的页上`
        });
      }
    } else if (matching.length && results.length) {
      // 这句只可能属于另一天，说明本页引用它的那几场都不成立。
      for (const result of matching) {
        result.status = 'fails';
        result.reasons.push({
          code: 'day-claim-elsewhere',
          severity: 'error',
          message: `文案写的是${day.token}的事，与本场不符`
        });
      }
    }
  }

  // 角色未定或仍有冲突时，任何署名都不能算确认，替补名单也不能补位。
  for (const result of results) {
    if (result.expected?.confirmed === false || result.status === 'unknown') {
      const slot = result.act && result.act !== 'all'
        ? model.schedule.byCell(result.performanceId, result.act, result.role)
        : null;
      if (slot?.status === 'unconfirmed' && claims.people.length) {
        result.reasons.push({
          code: 'standby-cannot-confirm',
          severity: 'error',
          message: '角色尚未确定，替补/备用名单不得写入已确认的演出资料'
        });
        result.status = 'fails';
      }
    }
  }

  // 英文稿里的拉丁名对不上名册时，提示核对官方拼写，不能当作已校。
  for (const name of claims.unknownNames) {
    if (!results.length) {
      reasons.push({
        code: 'unknown-latin-name',
        severity: 'warning',
        message: `“${name}”不在名册中，需核对官方拼写或确认是否为旧署名`
      });
      continue;
    }
    for (const result of results) {
      result.reasons.push({
        code: 'unknown-latin-name',
        severity: 'warning',
        message: `“${name}”不在名册中，需核对官方拼写或确认是否为旧署名`
      });
      if (result.status === 'holds') result.status = 'unknown';
    }
  }

  const statuses = results.map(result => result.status);
  const allHold = results.length > 0 && statuses.every(status => status === 'holds');
  const shareable = allHold && reasons.every(reason => reason.severity !== 'error');

  return {
    id: item.id,
    language: item.language,
    context: item.context,
    text: item.text,
    scope,
    claims,
    results,
    applicable: true,
    shareable,
    general: scope.kind === 'general',
    perPerformance: scope.kind === 'performance',
    needsTranslationReview:
      item.language !== 'zh' &&
      results.some(result => result.status !== 'holds' || result.reasons.length > 0),
    reasons
  };
}

function summarise(check) {
  if (!check.applicable) return check;
  const idsWith = status => unique(
    check.results.filter(result => result.status === status).map(result => result.performanceId)
  );
  const failing = idsWith('fails');
  const unknown = idsWith('unknown');
  const holding = idsWith('holds');
  const clean = holding.filter(id => !failing.includes(id) && !unknown.includes(id));
  const deictic = check.reasons.some(reason => reason.code === 'deictic-on-shared-page');
  return {
    ...check,
    reusableFor: deictic ? [] : clean,
    failsFor: failing,
    unverifiedFor: unknown,
    needsReplacementFor: unique([...failing, ...unknown]),
    // 同一句文字只要有一场不成立，就不能整张共用；但干净的场次仍可单页沿用。
    canShare: check.shareable && clean.length === check.scope.performanceIds.length,
    canReuseForCleanPerformances: clean.length > 0 && (failing.length + unknown.length > 0 || deictic)
  };
}

export function proofCopy(model) {
  return model.copy.map(item => summarise(checkCopyItem(item, model)));
}
