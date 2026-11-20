import { actLabel, numeralOfAct, unique } from './text.js';

const CHANGE_KINDS = new Set(['change', 'assign', 'unchanged']);

function expandActs(actList, catalogue) {
  if (!actList || !actList.length) return [...catalogue];
  if (actList.includes('all')) return [...catalogue];
  const values = [];
  for (const act of actList) {
    if (act === 'current') continue;
    const number = typeof act === 'number' ? act : numeralOfAct(act);
    if (number !== null && !values.includes(number)) values.push(number);
  }
  return values.sort((a, b) => a - b);
}

function cellKey(performanceId, act, role) {
  return `${performanceId}|${act}|${role}`;
}

export function actCatalogue(model) {
  const numbers = unique(model.cast.map(row => numeralOfAct(row.act)).filter(value => value !== null));
  return numbers.sort((a, b) => a - b).map(actLabel);
}

function rosterStageName(roster, performer) {
  const record = roster.performers.get(performer);
  if (!record) return null;
  const names = [...record.stageNames];
  return names.length === 1 ? names[0] : (names.length ? names : null);
}

// 把每条札记记录落实为“场次 × 幕 × 角色”的候选，再按日期和 authority 取舍。
export function resolveAssignments(model) {
  const catalogue = actCatalogue(model);
  const cells = new Map();

  for (const row of model.cast) {
    const key = cellKey(row.performanceId ?? row.performance, row.act, row.role);
    cells.set(key, {
      performanceId: row.performanceId ?? row.performance,
      act: row.act,
      role: row.role,
      base: {
        performer: row.performer,
        stageName: row.stageName,
        source: { type: 'cast', id: row.id }
      },
      overrides: [],
      sources: [{ type: 'cast', id: row.id }],
      statements: []
    });
  }

  let order = 0;
  const spellingStatements = [];

  for (const statement of model.statements) {
    if (statement.kind === 'spelling') {
      spellingStatements.push(statement);
      continue;
    }
    if (!CHANGE_KINDS.has(statement.kind)) continue;
    if (!statement.role || !statement.performances.length) continue;

    const targetActs = expandActs(statement.acts, catalogue);
    for (const performanceId of statement.performances) {
      for (const actNumber of targetActs) {
        const act = actLabel(actNumber);
        let cell = cells.get(cellKey(performanceId, act, statement.role));
        if (!cell) {
          // 札记可能提到卡司表没有的幕/角色；保留为空位，让编辑看到缺口。
          if (!catalogue.includes(act)) continue;
          cell = {
            performanceId,
            act,
            role: statement.role,
            base: null,
            overrides: [],
            sources: [],
            statements: []
          };
          cells.set(cellKey(performanceId, act, statement.role), cell);
        }
        cell.overrides.push({
          kind: statement.kind,
          date: statement.date,
          authorityRank: statement.authorityRank,
          authority: statement.authority,
          performer: statement.performer,
          noteId: statement.noteId,
          span: statement.span,
          text: statement.text,
          order: order++
        });
        cell.statements.push(statement);
        cell.sources.push({ type: 'note', id: statement.noteId, span: statement.span });
      }
    }
  }

  const slots = [];
  for (const cell of cells.values()) {
    const overrides = [...cell.overrides].sort((a, b) =>
      a.date.localeCompare(b.date) || a.authorityRank - b.authorityRank || a.order - b.order
    );
    const substantive = overrides.filter(override => override.performer);
    const last = substantive[substantive.length - 1] ?? null;

    let performer = last?.performer ?? cell.base?.performer ?? null;
    let status = performer ? 'confirmed' : 'unconfirmed';
    let conflict = null;

    if (substantive.length >= 2) {
      const previous = substantive[substantive.length - 2];
      const samePriority = last.date === previous.date && last.authorityRank === previous.authorityRank;
      if (samePriority && last.performer !== previous.performer) {
        status = 'conflict';
        conflict = {
          code: 'equal-priority-assignments',
          message: `${last.date} 有两条同级记录为${cell.role}指定不同演员`,
          candidates: unique([previous.performer, last.performer]),
          spans: [previous.span, last.span]
        };
      }
    }

    // “不变/照旧”若点名与人选不符，不能当作确认，交给编辑核对。
    const unchangedMismatch = overrides.find(override =>
      override.kind === 'unchanged' && override.performer && override.performer !== performer
    );
    if (unchangedMismatch) {
      status = status === 'confirmed' ? 'conflict' : status;
      conflict = conflict ?? {
        code: 'unchanged-contradicts-assignment',
        message: `“照旧/不变”所述 ${unchangedMismatch.performer} 与该场实际安排 ${performer ?? '（未定）'} 不一致`,
        candidates: unique([unchangedMismatch.performer, performer].filter(Boolean)),
        spans: [unchangedMismatch.span]
      };
    }

    let stageName = null;
    let stageNameSource = null;
    if (performer) {
      const spellings = spellingStatements
        .filter(statement =>
          statement.performer === performer &&
          statement.performances.includes(cell.performanceId) &&
          (!statement.role || statement.role === cell.role) &&
          (!statement.acts || expandActs(statement.acts, catalogue).map(actLabel).includes(cell.act))
        )
        .sort((a, b) => a.date.localeCompare(b.date));
      const spelling = spellings[spellings.length - 1];
      if (spelling?.stageName) {
        stageName = spelling.stageName;
        stageNameSource = { type: 'note', id: spelling.noteId, span: spelling.span };
      } else {
        stageName = rosterStageName(model.roster, performer);
      }
    }

    slots.push({
      performanceId: cell.performanceId,
      act: cell.act,
      role: cell.role,
      performer,
      stageName,
      status,
      conflict,
      base: cell.base,
      assignment: last
        ? {
            kind: last.kind,
            date: last.date,
            authority: last.authority,
            noteId: last.noteId,
            span: last.span
          }
        : null,
      stageNameSource,
      provenance: [
        ...(cell.base ? [{ type: 'cast', id: cell.base.source.id, performer: cell.base.performer, stageName: cell.base.stageName }] : []),
        ...overrides.map(override => ({
          type: 'note',
          id: override.noteId,
          date: override.date,
          authority: override.authority,
          kind: override.kind,
          performer: override.performer,
          span: override.span
        }))
      ]
    });
  }

  slots.sort((a, b) =>
    a.performanceId.localeCompare(b.performanceId) ||
    numeralOfAct(a.act) - numeralOfAct(b.act) ||
    a.role.localeCompare(b.role)
  );

  return {
    catalogue,
    slots,
    byCell(performanceId, act, role) {
      return slots.find(slot =>
        slot.performanceId === performanceId && slot.act === act && slot.role === role
      ) ?? null;
    },
    forPerformance(performanceId) {
      return slots.filter(slot => slot.performanceId === performanceId);
    },
    crossAct(performanceId, role) {
      const relevant = slots.filter(slot => slot.performanceId === performanceId && slot.role === role);
      const performers = unique(relevant.map(slot => slot.performer).filter(Boolean));
      return {
        role,
        byAct: relevant.map(slot => ({ act: slot.act, performer: slot.performer })),
        performers,
        consistent: performers.length <= 1,
        unconfirmed: relevant.some(slot => slot.status !== 'confirmed')
      };
    }
  };
}
