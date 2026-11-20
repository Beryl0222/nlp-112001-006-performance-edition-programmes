import { readFile } from 'node:fs/promises';
import { actLabel, unique } from './text.js';

const defaultDirectory = new URL('../资料/', import.meta.url);

export const PAGE_KINDS = {
  draft: '未付印稿',
  electronic: '电子页',
  paper: '已送达纸本',
  erratum: '勘误页'
};

export const PAGE_LABELS = {
  draft: '未付印稿',
  electronic: '电子页',
  paper: '已送达纸本',
  erratum: '勘误页'
};

export function makePage(input) {
  const kind = input.kind ?? 'draft';
  if (!PAGE_KINDS[kind]) throw new TypeError(`未知页面类型：${kind}`);
  return {
    id: input.id,
    title: input.title ?? input.id,
    kind,
    scope: {
      performanceIds: input.scope?.performanceIds ?? [],
      acts: input.scope?.acts ?? null
    },
    copyIds: input.copyIds ?? [],
    castCells: input.castCells ?? [],
    deliveredAt: input.deliveredAt ?? null,
    issuedAt: input.issuedAt ?? input.deliveredAt ?? null,
    revision: input.revision ?? 1,
    supersedes: input.supersedes ?? null,
    erratumFor: input.erratumFor ?? null,
    translationReview: input.translationReview ?? null,
    note: input.note ?? null
  };
}

export function coversPerformance(page, performanceId) {
  if (!page.scope.performanceIds.length) return true;
  return page.scope.performanceIds.includes(performanceId);
}

export function coversAct(page, act) {
  if (!page.scope.acts || !page.scope.acts.length) return true;
  return page.scope.acts.includes(act);
}

function signatureOfCell(cell) {
  return `${cell.act}|${cell.role}|${cell.performer}|${cell.stageName ?? ''}`;
}

// 一个页面在某一场是否仍成立：文案检查通过、所印署名与当前安排一致、
// 译审签样签的是当前署名而不是旧署名。
export function pageStatus(page, model) {
  const issues = [];
  const performanceIds = page.scope.performanceIds.length
    ? page.scope.performanceIds
    : model.performances.map(performance => performance.id);

  for (const performanceId of performanceIds) {
    const performance = model.performances.find(item => item.id === performanceId);
    if (!performance) continue;

    for (const copyId of page.copyIds) {
      const check = model.copyChecks.find(item => item.id === copyId);
      if (!check) {
        issues.push({
          code: 'missing-copy',
          severity: 'error',
          performanceId,
          copyId,
          message: `页面引用的文案 ${copyId} 不存在`
        });
        continue;
      }
      if (!check.applicable) {
        issues.push({
          code: 'copy-not-current',
          severity: 'error',
          performanceId,
          copyId,
          message: `文案 ${copyId} 是历史/非当前内容，不能印入当前页面`
        });
        continue;
      }
      const result = check.results.find(item => item.performanceId === performanceId);
      if (!result) {
        issues.push({
          code: 'copy-scope-mismatch',
          severity: 'warning',
          performanceId,
          copyId,
          message: `文案 ${copyId} 没有覆盖${performance.label}的检查结果`
        });
        continue;
      }
      if (result.status !== 'holds') {
        issues.push({
          code: result.status === 'fails' ? 'copy-fails' : 'copy-unverified',
          severity: 'error',
          performanceId,
          copyId,
          message: `文案 ${copyId} 在${performance.label}不成立：${result.reasons.map(reason => reason.message).join('；')}`
        });
      }
    }

    for (const cell of page.castCells) {
      if (!coversAct(page, cell.act)) continue;
      const slot = model.schedule.byCell(performanceId, cell.act, cell.role);
      if (!slot) {
        issues.push({
          code: 'missing-slot',
          severity: 'error',
          performanceId,
          message: `页面上的 ${cell.act} ${cell.role} 在该场没有卡司资料`
        });
        continue;
      }
      if (slot.status !== 'confirmed') {
        issues.push({
          code: 'unconfirmed-slot',
          severity: 'error',
          performanceId,
          act: cell.act,
          role: cell.role,
          message: `${performance.label} ${cell.act} ${cell.role} 尚未确认，不能付印`
        });
        continue;
      }
      if (cell.performer !== slot.performer || (cell.stageName ?? null) !== (slot.stageName ?? null)) {
        issues.push({
          code: 'stale-signature',
          severity: 'error',
          performanceId,
          act: cell.act,
          role: cell.role,
          message: `${performance.label} ${cell.act} ${cell.role} 页面署名 ${cell.performer}${cell.stageName ? ` / ${cell.stageName}` : ''}，现为 ${slot.performer}${slot.stageName ? ` / ${slot.stageName}` : ''}`,
          printed: { performer: cell.performer, stageName: cell.stageName ?? null },
          current: { performer: slot.performer, stageName: slot.stageName }
        });
      }
    }
  }

  // 译审只对签样时的署名负责；换了人就不能沿用旧签样。
  if (page.translationReview?.signature?.length) {
    for (const review of page.translationReview.signature) {
      for (const performanceId of performanceIds) {
        if (!coversPerformance(page, performanceId)) continue;
        const slot = model.schedule.byCell(performanceId, review.act, review.role);
        if (!slot || slot.status !== 'confirmed') continue;
        if (slot.performer !== review.performer || (slot.stageName ?? null) !== (review.stageName ?? null)) {
          issues.push({
            code: 'translation-review-stale',
            severity: 'error',
            performanceId,
            act: review.act,
            role: review.role,
            message: `${performanceId} ${review.act} ${review.role} 的旧译审签样针对 ${review.performer}${review.stageName ? ` / ${review.stageName}` : ''}，不能沿用到 ${slot.performer}${slot.stageName ? ` / ${slot.stageName}` : ''}`,
            review: review
          });
        }
      }
    }
  }

  const failing = unique(
    issues.filter(issue => issue.severity === 'error' && issue.performanceId).map(issue => issue.performanceId)
  );
  return {
    pageId: page.id,
    title: page.title,
    kind: page.kind,
    valid: issues.length === 0,
    issues,
    affectedPerformances: failing,
    // 只为某一场/某一幕印的页面失效时，改动可以只落在这一处。
    replaceablePerPerformance:
      failing.length > 0 && failing.length < performanceIds.length,
    scopedPerformances: performanceIds
  };
}

// 互相引用的页面必须成组处理：共享同一段文案、同一场同一角色的署名，
// 或同属一册（同一场、同一交付批次）的承印物。同册的页要一起替换，
// 否则介绍页换了署名、小传页还留着旧名字。
// 只按“场次范围 + 幕 + 角色”耦合，十八日晚的页不会被十九日晚的换角牵连。
export function couplingKeys(page) {
  const keys = [];
  const scopeKey = page.scope.performanceIds.length
    ? [...page.scope.performanceIds].sort().join(',')
    : '*';
  for (const copyId of page.copyIds) keys.push(`copy:${copyId}`);
  for (const cell of page.castCells) {
    keys.push(`cell:${scopeKey}|${cell.act}|${cell.role}`);
  }
  if (page.deliveredAt) keys.push(`batch:${page.deliveredAt}|${scopeKey}`);
  return unique(keys);
}

export function groupPages(pages, model) {
  const checks = pages.map(page => ({ page, status: pageStatus(page, model) }));
  const parent = new Map(pages.map(page => [page.id, page.id]));

  const find = id => {
    let current = id;
    while (parent.get(current) !== current) current = parent.get(current);
    return current;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  const byKey = new Map();
  for (const page of pages) {
    for (const key of couplingKeys(page)) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(page.id);
    }
  }
  for (const ids of byKey.values()) {
    for (let index = 1; index < ids.length; index += 1) union(ids[0], ids[index]);
  }

  // 已发出的页若已被有效勘误覆盖，就不再要求替换；但纸面原文仍是唯一依据。
  // 勘误只改它写明的幕与署名，文案与译审问题不会被“顺带”修好。
  const errata = checks.filter(entry =>
    entry.page.kind === 'erratum' && entry.page.erratumFor && entry.status.valid
  );
  const remediedIssues = entry => entry.status.issues.filter(issue => {
    if (issue.severity !== 'error') return false;
    if (issue.code !== 'stale-signature') return true;
    return !errata.some(candidate =>
      candidate.page.erratumFor === entry.page.id &&
      coversAct(candidate.page, issue.act) &&
      (!issue.performanceId || coversPerformance(candidate.page, issue.performanceId)) &&
      candidate.page.castCells.some(cell =>
        cell.act === issue.act && cell.role === issue.role
      )
    );
  });

  const groups = new Map();
  for (const entry of checks) {
    const root = find(entry.page.id);
    if (!groups.has(root)) groups.set(root, { id: root, pages: [], statuses: [], keys: new Set() });
    const group = groups.get(root);
    group.pages.push(entry.page);
    group.statuses.push(entry.status);
    for (const key of couplingKeys(entry.page)) group.keys.add(key);
  }

  return [...groups.values()].map(group => {
    const invalid = group.statuses.filter(status => !status.valid);
    const affected = unique(invalid.flatMap(status => status.affectedPerformances));
    const allInvalid = invalid.length === group.pages.length;
    const generalInvalid = invalid.some(status => {
      const page = group.pages.find(item => item.id === status.pageId);
      return page && page.scope.performanceIds.length === 0;
    });
    const narrowOnly = invalid.length > 0 && !generalInvalid && invalid.length < group.pages.length;

    const replaced = invalid
      .filter(status => {
        const entry = checks.find(item => item.page.id === status.pageId);
        return remediedIssues(entry).length > 0;
      })
      .map(status => status.pageId);
    const unaffected = group.pages
      .filter(page => !replaced.includes(page.id))
      .map(page => ({
        id: page.id,
        title: page.title,
        kind: page.kind,
        scope: page.scope,
        reason: group.statuses.find(status => status.pageId === page.id)?.valid
          ? '该页所印署名与文案对本页场次仍成立'
          : '该页的缺陷已由有效勘误覆盖'
      }));

    // 未付印的稿子改稿即可，不存在“作废重印”或“勘误”。
    const kinds = new Set(invalid.map(status => {
      const page = group.pages.find(item => item.id === status.pageId);
      return page?.kind;
    }));
    const draftOnly = kinds.size > 0 && [...kinds].every(kind => kind === 'draft');
    const paperOnly = kinds.size > 0 && [...kinds].every(kind => kind === 'paper');

    let replacement = 'none';
    let action = '该组页面均与当前安排一致，无需替换';
    if (replaced.length > 0) {
      if (draftOnly) {
        replacement = 'revise-before-print';
        action = '尚未付印，按新署名改稿后再付印，无需作废或勘误';
      } else if (narrowOnly) {
        replacement = 'single-page';
        action = '失效页面的生效范围较窄，可只替换这些页；同组未失效的场次页继续使用';
      } else if (paperOnly) {
        replacement = allInvalid || generalInvalid ? 'whole-group' : 'group';
        action = '已送达的纸本需按组替换或出勘误，未受影响场次的纸本继续使用';
      } else {
        replacement = 'group';
        action = '这些页面互相引用同一署名/文案，必须成组替换，避免一页改了另一页还留旧署名';
      }
    }

    return {
      id: group.id,
      pages: group.pages.map(page => ({
        id: page.id,
        title: page.title,
        kind: page.kind,
        scope: page.scope,
        revision: page.revision,
        deliveredAt: page.deliveredAt,
        valid: group.statuses.find(status => status.pageId === page.id)?.valid ?? true
      })),
      keys: [...group.keys],
      valid: invalid.length === 0,
      invalidPages: invalid.map(status => status.pageId),
      affectedPerformances: affected,
      replacement,
      replaced,
      unaffected,
      note: action
    };
  });
}

export class EditionLedger {
  constructor(pages) {
    this.pages = pages.map(makePage);
  }

  add(page) {
    const created = makePage(page);
    this.pages.push(created);
    return created;
  }

  revisionsOf(pageId) {
    const family = this.pages.filter(page => page.id === pageId || page.supersedes === pageId);
    return family.sort((a, b) => a.revision - b.revision);
  }

  // 票面场次 → 当场可用的版本。通用印本、按场电子页与勘误分开呈现；
  // 已送达纸本即便失效也列出来，编辑才能看到当场发出去的是什么。
  // 未付印稿不会发到观众手里，只单独提示。
  forTicket(query, model) {
    const matches = model.performances.filter(performance =>
      performance.id === query || performance.label === query || performance.names.includes(query)
    );
    if (matches.length !== 1) {
      return {
        query,
        performance: matches[0] ?? null,
        ambiguous: matches.length > 1,
        candidates: matches.map(performance => performance.label),
        pages: [],
        drafts: []
      };
    }
    const performance = matches[0];
    const applicable = this.pages.filter(page => coversPerformance(page, performance.id));

    const describe = page => ({
      id: page.id,
      title: page.title,
      kind: page.kind,
      kindLabel: PAGE_LABELS[page.kind],
      revision: page.revision,
      scope: page.scope,
      deliveredAt: page.deliveredAt,
      issuedAt: page.issuedAt,
      status: pageStatus(page, model),
      erratumFor: page.erratumFor,
      text: this.printedText(page, model)
    });

    return {
      query,
      performance: { id: performance.id, label: performance.label },
      ambiguous: false,
      pages: applicable.filter(page => page.kind !== 'draft').map(describe),
      drafts: applicable.filter(page => page.kind === 'draft').map(describe)
    };
  }

  // 某场观众在某个时间点实际拿到的文字：按交付/发行时间把各页叠起来，
  // 勘误只覆盖它写明的幕/场，其余幕仍取原页。已经演完的场次据此还原。
  // 未付印稿不属于已发出的印本，观众不可能拿到。
  snapshot(performanceId, at) {
    const applicable = this.pages
      .filter(page => page.kind !== 'draft')
      .filter(page => coversPerformance(page, performanceId))
      .filter(page => !at || (page.issuedAt ?? page.deliveredAt ?? '') <= at)
      .sort((a, b) =>
        (a.revision - b.revision) ||
        String(a.issuedAt ?? '').localeCompare(String(b.issuedAt ?? ''))
      );

    const acts = [...new Set(applicable.flatMap(page =>
      page.scope.acts?.length ? page.scope.acts : (page.castCells.map(cell => cell.act))
    ))];
    return { performanceId, at: at ?? null, pages: applicable, acts };
  }

  // 按幕还原纸面：每幕的署名取该幕最新的印页，文案取最新的、覆盖该场该幕的印页。
  effectiveText(performanceId, at, model) {
    const snapshot = this.snapshot(performanceId, at);
    const catalogue = model.schedule.catalogue;
    const byAct = {};

    // 一段文案可能只讲某一幕（“throughout Act Two”），不能贴到别的幕上。
    const copyActs = copyId => {
      const check = model.copyChecks.find(item => item.id === copyId);
      const acts = check?.claims?.acts ?? [];
      if (!acts.length) return catalogue;
      const labels = [];
      for (const act of acts) {
        if (act === 'all') return catalogue;
        const label = typeof act === 'number' ? actLabel(act) : act;
        if (catalogue.includes(label)) labels.push(label);
      }
      return labels.length ? labels : catalogue;
    };

    for (const act of catalogue) {
      const relevant = snapshot.pages.filter(page => coversAct(page, act));
      const withSignature = [...relevant]
        .reverse()
        .find(page => page.castCells.some(cell => cell.act === act));
      const signature = withSignature?.castCells.find(cell => cell.act === act) ?? null;
      const copyPages = [...relevant]
        .reverse()
        .map(page => ({
          page,
          ids: page.copyIds.filter(copyId => copyActs(copyId).includes(act))
        }))
        .filter(entry => entry.ids.length);
      const latestCopyPage = copyPages[0] ?? null;

      byAct[act] = {
        pageId: withSignature?.id ?? null,
        performer: signature?.performer ?? null,
        stageName: signature?.stageName ?? null,
        copy: latestCopyPage
          ? latestCopyPage.ids.map(copyId => {
              const item = model.copy.find(entry => entry.id === copyId);
              return { id: copyId, language: item?.language ?? null, text: item?.text ?? null };
            })
          : [],
        copyPageId: latestCopyPage?.page.id ?? null,
        // 文字页自己的署名若与当前生效署名不符，这份译文就不能算已更新。
        copyPageSignatureStale: Boolean(
          latestCopyPage &&
          signature &&
          latestCopyPage.page.castCells.some(cell =>
            cell.act === act && (cell.performer !== signature.performer ||
              (cell.stageName ?? null) !== (signature.stageName ?? null))
          )
        )
      };
    }

    return {
      performanceId,
      at: at ?? null,
      pages: snapshot.pages.map(page => ({
        id: page.id,
        title: page.title,
        kind: page.kind,
        kindLabel: PAGE_LABELS[page.kind],
        revision: page.revision,
        acts: page.scope.acts,
        issuedAt: page.issuedAt ?? page.deliveredAt
      })),
      acts: byAct
    };
  }

  // 还原纸面文字：页面所印文案 + 页面所印署名。资料中的文案即当初付印文本。
  printedText(page, model) {
    return {
      copy: page.copyIds.map(copyId => {
        const item = model.copy.find(entry => entry.id === copyId);
        return { id: copyId, text: item?.text ?? null, language: item?.language ?? null };
      }),
      signatures: page.castCells.map(cell => ({
        act: cell.act,
        role: cell.role,
        performer: cell.performer,
        stageName: cell.stageName ?? null
      }))
    };
  }

  // 晚到的勘误只能覆盖其写明场次；已演场次仍保留当场版本。
  erratumPlan(pageId, model) {
    const page = this.pages.find(item => item.id === pageId);
    if (!page) return null;
    const status = pageStatus(page, model);
    const affected = status.affectedPerformances;
    return {
      page: { id: page.id, title: page.title, kind: page.kind },
      affectedPerformances: affected,
      scope: affected.length === 0
        ? 'none'
        : affected.length === page.scope.performanceIds.length && page.scope.performanceIds.length
          ? 'whole-page'
          : 'narrow',
      suggestion: affected.length === 0
        ? '无需勘误'
        : `只为 ${affected.join('、')} 出勘误，其它场次沿用原页`
    };
  }
}

export async function readEditionManifest(directory = defaultDirectory) {
  try {
    const rows = JSON.parse(await readFile(new URL('版次.json', directory), 'utf8'));
    if (!Array.isArray(rows)) throw new TypeError('版次.json 应为数组');
    return rows;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function buildEditions(model) {
  return {
    ledger: new EditionLedger(model.pageManifest ?? []),
    pageStatus: page => pageStatus(page, model),
    groupPages: pages => groupPages(pages, model),
    describeScope(page) {
      if (!page.scope.performanceIds.length && (!page.scope.acts || !page.scope.acts.length)) {
        return '全部场次';
      }
      const performances = page.scope.performanceIds.length
        ? page.scope.performanceIds.map(id => model.performances.find(item => item.id === id)?.label ?? id)
        : model.performances.map(item => item.label);
      const acts = page.scope.acts?.length ? `（${page.scope.acts.join('、')}）` : '';
      return `${performances.join('、')}${acts}`;
    }
  };
}
