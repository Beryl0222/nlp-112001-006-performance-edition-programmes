import { loadProgrammeModel } from './programme.js';

const STATUS_LABEL = {
  confirmed: '已确认',
  unconfirmed: '未确认',
  conflict: '有冲突'
};

const CHECK_LABEL = {
  holds: '成立',
  fails: '不成立',
  unknown: '待核实'
};

const REPLACEMENT_LABEL = {
  none: '无需替换',
  'single-page': '可只换失效页',
  group: '成组替换',
  'whole-group': '整组作废重印',
  'revise-before-print': '付印前改稿'
};

function formatSpan(span) {
  if (!span) return '';
  return `${span.id}:${span.start}-${span.end}“${span.text}”`;
}

function labelOf(model, performanceId) {
  return model.performances.find(item => item.id === performanceId)?.label ?? performanceId;
}

function printPeople(model) {
  const lines = ['## 名册与拼写', ''];
  for (const performer of model.roster.performers.values()) {
    const stageNames = [...performer.stageNames];
    const row = performer.castRows.length
      ? `卡司表 ${performer.castRows.map(item => item.id).join('、')}`
      : '仅见于札记';
    lines.push(`- ${performer.name} — ${stageNames.join(' / ') || '（无艺名）'} — ${row}`);
  }
  for (const [stageName, performers] of model.roster.stageNames) {
    if (performers.size > 1) {
      lines.push('');
      lines.push(`  ! 艺名“${stageName}”对应多位演员：${[...performers].join('、')}。编辑需按场次与角色判定。`);
      for (const performer of performers) {
        const evidence = model.roster.performers.get(performer)?.castRows
          .map(row => `${row.performance} ${row.act} ${row.role}`) ?? [];
        lines.push(`    - ${performer}：${evidence.join('；') || '无卡司表记录'}`);
      }
    }
  }
  return lines;
}

function printSchedule(model) {
  const lines = ['', '## 各场次适用版（当前安排）', ''];
  for (const performance of model.performances) {
    lines.push(`### ${performance.label}`);
    for (const slot of model.schedule.forPerformance(performance.id)) {
      const marker = slot.status === 'confirmed' ? '' : ` **${STATUS_LABEL[slot.status]}**`;
      lines.push(`- ${slot.act} ${slot.role}：${slot.performer ?? '（未定）'}${slot.stageName ? ` / ${slot.stageName}` : ''}${marker}`);
      if (slot.assignment) {
        lines.push(`  - 依据 ${slot.assignment.noteId} ${slot.assignment.date} ${slot.assignment.authority} ${formatSpan(slot.assignment.span)}`);
      }
      if (slot.conflict) lines.push(`  - 冲突：${slot.conflict.message}`);
    }
    for (const role of model.roles) {
      const cross = model.schedule.crossAct(performance.id, role);
      if (cross.byAct.length > 1 && !cross.unconfirmed) {
        lines.push(`- 跨幕（${role}）：${cross.consistent ? '各幕同一人' : '各幕不同人'} — ${cross.byAct.map(item => `${item.act} ${item.performer}`).join('、')}`);
      } else if (cross.byAct.length > 1) {
        lines.push(`- 跨幕（${role}）：尚有未确认的幕，不能写“同一人” — ${cross.byAct.map(item => `${item.act} ${item.performer ?? '未定'}`).join('、')}`);
      }
    }
    lines.push('');
  }
  return lines;
}

function printCopy(model) {
  const lines = ['## 文案校对', ''];
  for (const check of model.copyChecks) {
    lines.push(`### ${check.id}（${check.language}，${check.context}）`);
    lines.push(`> ${check.text}`);
    if (check.notCurrent) {
      lines.push('- 结论：非当前演出内容，不得印入当前页面');
      for (const reason of check.reasons) lines.push(`  - ${reason.message}`);
      lines.push('');
      continue;
    }
    const seen = new Set();
    for (const result of check.results) {
      const key = `${result.performanceId}|${result.act}|${result.role}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const label = result.performanceLabel ?? labelOf(model, result.performanceId);
      lines.push(`- ${label} ${result.act === 'all' ? '各幕' : result.act ?? ''} ${result.role ?? ''}：${CHECK_LABEL[result.status]}`);
      if (result.expected) {
        const expected = result.expected.byAct
          ? result.expected.byAct.map(item => `${item.act} ${item.performer}${item.stageName ? ` / ${item.stageName}` : ''}`).join('、')
          : `${result.expected.performer ?? '（未定）'}${result.expected.stageName ? ` / ${result.expected.stageName}` : ''}`;
        lines.push(`  - 当前安排：${expected}`);
      }
      for (const reason of result.reasons) {
        lines.push(`  - ${reason.message}`);
        if (reason.candidates && reason.code === 'stage-name-ambiguous') {
          for (const candidate of reason.candidates) {
            lines.push(`    - 候选 ${candidate.performer}：${candidate.evidence.map(item => item.id).join('、') || '仅见札记'}`);
          }
        }
      }
    }
    for (const reason of check.reasons) lines.push(`- ! ${reason.message}`);
    lines.push(`- 可共用：${check.canShare ? '是' : '否'}`);
    if (check.reusableFor.length) lines.push(`- 仍可用的场次：${check.reusableFor.map(id => labelOf(model, id)).join('、')}`);
    if (check.failsFor.length) lines.push(`- 必须替换的场次：${check.failsFor.map(id => labelOf(model, id)).join('、')}`);
    if (check.unverifiedFor.length) lines.push(`- 待核实的场次：${check.unverifiedFor.map(id => labelOf(model, id)).join('、')}`);
    if (check.needsTranslationReview) lines.push('- 译审：署名或文字有变化，旧译审不能沿用，需重新签样');
    lines.push('');
  }
  return lines;
}

function printEditions(model) {
  const ledger = model.editions.ledger;
  const lines = ['', '## 版次与生效范围', ''];
  if (!ledger.pages.length) {
    lines.push('- 资料中没有版次清单');
    return lines;
  }

  for (const page of ledger.pages) {
    const status = model.editions.pageStatus(page);
    const scope = model.editions.describeScope(page);
    const kind = page.kind;
    lines.push(`### ${page.id} — ${page.title}`);
    lines.push(`- 类型：${kind}；生效范围：${scope}；第 ${page.revision} 版`);
    if (page.deliveredAt) lines.push(`- 交付：${page.deliveredAt}`);
    lines.push(`- 当前是否成立：${status.valid ? '是' : '否'}`);
    for (const issue of status.issues) {
      lines.push(`  - [${issue.code}] ${issue.message}`);
    }
    lines.push('');
  }

  const groups = model.editions.groupPages(ledger.pages);
  lines.push('## 成组替换', '');
  for (const group of groups) {
    lines.push(`### ${group.pages.map(page => page.id).join(' + ')}`);
    lines.push(`- 处置：${REPLACEMENT_LABEL[group.replacement]}；${group.note}`);
    if (group.replaced.length) lines.push(`- 需替换：${group.replaced.join('、')}`);
    if (group.unaffected.length) {
      lines.push(`- 可继续使用：${group.unaffected.map(page => `${page.id}（${page.reason}）`).join('；')}`);
    }
    lines.push('');
  }

  lines.push('## 票面场次查询', '');
  for (const performance of model.performances) {
    const lookup = ledger.forTicket(performance.label, model);
    lines.push(`### ${performance.label}`);
    for (const page of lookup.pages) {
      lines.push(`- ${page.kindLabel} ${page.id}（第 ${page.revision} 版，${page.status.valid ? '与当前安排一致' : '与当前安排不符'}）`);
      if (page.text.copy.length) {
        for (const copy of page.text.copy) lines.push(`  - 文案 ${copy.id}：${copy.text ?? '（缺）'}`);
      }
      for (const signature of page.text.signatures) {
        lines.push(`  - 印面 ${signature.act} ${signature.role}：${signature.performer}${signature.stageName ? ` / ${signature.stageName}` : ''}`);
      }
    }
    if (!lookup.pages.length) lines.push('- 该场没有已发出的版本，需新制');
    for (const draft of lookup.drafts) {
      lines.push(`- （未付印，不会发到观众手里）${draft.id}：${draft.status.valid ? '可用于付印' : '需改稿'}`);
    }
    lines.push('');
  }

  lines.push('## 已演场次还原', '');
  const issued = ledger.pages.filter(page => page.kind !== 'draft');
  if (!issued.length) {
    lines.push('- 没有已发出的印本');
    return lines;
  }
  for (const performance of model.performances) {
    const snapshot = ledger.snapshot(performance.id);
    if (!snapshot.pages.length) continue;
    lines.push(`### ${performance.label}`);
    for (const page of snapshot.pages) {
      const signatures = page.castCells
        .map(cell => `${cell.act} ${cell.role} ${cell.performer}${cell.stageName ? ` / ${cell.stageName}` : ''}`)
        .join('；');
      const kindLabel = page.kind === 'erratum' ? '勘误' : page.kind === 'electronic' ? '电子页' : '纸本';
      lines.push(`- ${kindLabel} ${page.id}（${page.issuedAt ?? page.deliveredAt ?? '未记时间'}）：${signatures || '（仅文字，无署名）'}`);
    }
    // 按幕取当时生效的最新印页，得到观众最终读到的署名。
    const effective = ledger.effectiveText(performance.id, null, model);
    const summary = Object.entries(effective.acts)
      .map(([act, value]) => `${act} ${value.performer ?? '（无署名）'}${value.stageName ? ` / ${value.stageName}` : ''}`)
      .join('；');
    lines.push(`- 最终生效署名：${summary}`);
    lines.push('');
  }
  return lines;
}

function printIssues(model) {
  const lines = ['', '## 需编辑处理的问题', ''];
  const found = [];
  for (const issue of model.noteIssues) {
    found.push(`- [${issue.severity}] ${issue.noteId} ${formatSpan(issue.span)} ${issue.message}`);
  }
  for (const slot of model.schedule.slots) {
    if (slot.status === 'conflict') {
      found.push(`- [error] ${slot.performanceId} ${slot.act} ${slot.role} ${slot.conflict.message}`);
    }
    if (slot.status === 'unconfirmed') {
      found.push(`- [warn] ${slot.performanceId} ${slot.act} ${slot.role} 尚无确认人选，替补名单不能写入`);
    }
  }
  if (!found.length) lines.push('- 没有遗留问题');
  lines.push(...found);
  return lines;
}

export function renderReport(model) {
  return [
    '# 节目册演出版本校对',
    '',
    `作品：${model.works.join('、')}`,
    `场次：${model.performances.map(performance => performance.label).join('、')}`,
    `幕次：${model.schedule.catalogue.join('、')}`,
    '',
    ...printPeople(model),
    ...printSchedule(model),
    ...printCopy(model),
    ...printEditions(model),
    ...printIssues(model)
  ].join('\n');
}

export { loadProgrammeModel };
