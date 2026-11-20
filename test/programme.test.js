import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProgrammeModel } from '../programme.js';
import { renderReport } from '../report.js';

function cast(rows) {
  return rows.map((row, index) => ({
    id: `slot${index + 1}`,
    performance: row.performance,
    act: row.act,
    role: row.role,
    performer: row.performer,
    stageName: row.stageName,
    locale: 'zh'
  }));
}

function note(id, date, authority, text) {
  return { id, date, authority, text };
}

function copyItem(id, language, context, text) {
  return { id, language, context, text };
}

const baseCast = cast([
  { performance: '河剧十八日晚', act: '第一幕', role: '渡人', performer: '卢遥', stageName: 'Lu Yao' },
  { performance: '河剧十八日晚', act: '第二幕', role: '渡人', performer: '卢遥', stageName: 'Lu Yao' },
  { performance: '河剧十九日晚', act: '第一幕', role: '渡人', performer: '宋遥', stageName: 'Song Yao' },
  { performance: '河剧十九日晚', act: '第二幕', role: '渡人', performer: '宋遥', stageName: 'Song Yao' },
  { performance: '河剧十九日晚', act: '第二幕', role: '河神', performer: '宋鹞', stageName: 'Song Yao' }
]);

const baseNotes = [
  note('rec1', '2026-10-12', '制作室', '十八日晚用甲组，卢遥唱渡人。乙组宋遥首演在十九日，河神宋鹞不变。'),
  note('rec2', '2026-10-17', '舞台监督', '十九日晚第二幕渡人改由程秋接演，第一幕照旧。印版应使用 Cheng Qiu。'),
  note('rec3', '2026-10-13', '排练员', '替补名册含许凌，只有准备信息。')
];

function modelOf({ castRows = baseCast, notes = baseNotes, copy = [], pageManifest = [] } = {}) {
  return buildProgrammeModel({ cast: castRows, notes, copy, pageManifest });
}

test('场次名解析出日号与场次，卡司按场次对齐', () => {
  const model = modelOf();
  assert.deepEqual(model.performances.map(item => item.label), ['河剧十八日晚', '河剧十九日晚']);
  const slots = model.schedule.forPerformance('河剧|19|晚场');
  assert.equal(slots.length, 3);
  assert.equal(model.schedule.byCell('河剧|18|晚场', '第一幕', '渡人').performer, '卢遥');
});

test('后句省略角色时沿用前句角色，但人名不跨句继承', () => {
  const model = modelOf();
  const change = model.statements.find(statement => statement.noteId === 'rec2' && statement.kind === 'change');
  assert.equal(change.role, '渡人');
  assert.deepEqual(change.acts, [2]);
  assert.equal(change.performer, '程秋');

  const unchanged = model.statements.find(statement =>
    statement.noteId === 'rec2' && statement.kind === 'unchanged'
  );
  assert.equal(unchanged.role, '渡人');
  assert.deepEqual(unchanged.acts, [1]);
  // “第一幕照旧”没有点名，不能凭空补一个演员当作确认。
  assert.equal(unchanged.performer, null);
  assert.equal(unchanged.inherited.role, true);
});

test('只更换第二幕时第一幕保留原安排，跨幕结论随之更新', () => {
  const model = modelOf();
  assert.equal(model.schedule.byCell('河剧|19|晚场', '第一幕', '渡人').performer, '宋遥');
  assert.equal(model.schedule.byCell('河剧|19|晚场', '第二幕', '渡人').performer, '程秋');

  const cross = model.schedule.crossAct('河剧|19|晚场', '渡人');
  assert.equal(cross.consistent, false);
  assert.deepEqual(cross.byAct.map(item => item.performer), ['宋遥', '程秋']);
});

test('印版拼写承接换角记录，成为该演员的印版署名', () => {
  const model = modelOf();
  const slot = model.schedule.byCell('河剧|19|晚场', '第二幕', '渡人');
  assert.equal(slot.stageName, 'Cheng Qiu');
  assert.equal(slot.stageNameSource.id, 'rec2');
});

test('同一艺名对应两位演员时保留候选与依据', () => {
  const model = modelOf();
  const candidates = model.roster.candidatesForStageName('Song Yao');
  assert.deepEqual(candidates.map(item => item.performer).sort(), ['宋鹞', '宋遥'].sort());
  const forSongYao = candidates.find(item => item.performer === '宋遥');
  assert.deepEqual(forSongYao.castRows.map(row => row.id).sort(), ['slot3', 'slot4'].sort());
  const forSongYao2 = candidates.find(item => item.performer === '宋鹞');
  assert.deepEqual(forSongYao2.castRows.map(row => row.id), ['slot5']);
});

test('首演经历不覆盖当前安排，替补名单也不补位', () => {
  const model = modelOf();
  assert.equal(model.schedule.byCell('河剧|18|晚场', '第一幕', '渡人').performer, '卢遥');
  const standby = model.statements.find(statement => statement.kind === 'standby');
  assert.equal(standby.performer, '许凌');
  assert.equal(standby.rosterOnly, true);
  assert.deepEqual(standby.performances, []);
  assert.ok(model.roster.isStandbyOnly('许凌'));
  assert.equal(model.roster.performers.get('许凌').castRows.length, 0);
});

test('通用页只要对一场不成立就不能共用，但干净场次仍可单页沿用', () => {
  const model = modelOf({
    copy: [
      copyItem('copy1', 'zh', '合印内页', '渡人两幕均由十九日的同一位演员担纲。'),
      copyItem('copy2', 'zh', '十九日电子页', '渡人由程秋担纲。'),
      copyItem('copy3', 'zh', '十八日电子页', '渡人由卢遥担纲。')
    ]
  });
  const [shared, changed, stillGood] = model.copyChecks;
  assert.equal(shared.canShare, false);
  assert.equal(shared.shareable, false);
  assert.deepEqual(shared.reusableFor, []);
  // “十九日”的句子不能印到十八日的页上。
  assert.ok(shared.failsFor.includes('河剧|18|晚场'));
  assert.ok(shared.failsFor.includes('河剧|19|晚场'));

  assert.equal(changed.scope.kind, 'performance');
  assert.equal(changed.shareable, false);
  assert.deepEqual(changed.failsFor, ['河剧|19|晚场']);

  assert.equal(stillGood.shareable, true);
  assert.deepEqual(stillGood.failsFor, []);
  assert.deepEqual(stillGood.reusableFor, ['河剧|18|晚场']);
});

test('“今晚”一类指示语不能对多场共用', () => {
  const model = modelOf({
    copy: [copyItem('copy1', 'zh', '合印内页', '渡人由卢遥担纲，今晚开演。')]
  });
  const check = model.copyChecks[0];
  assert.ok(check.reasons.some(reason => reason.code === 'deictic-on-shared-page'));
  assert.equal(check.canShare, false);
});

test('跨幕“同一位演员”被换角打破时判为不成立', () => {
  const model = modelOf({
    copy: [copyItem('copy1', 'en', '十九日电子页', 'The same performer plays the Ferryman in both acts.')]
  });
  const check = model.copyChecks[0];
  assert.equal(check.shareable, false);
  assert.equal(check.results[0].status, 'fails');
  assert.match(check.results[0].reasons[0].message, /同一位演员/);
});

test('人名歧义时候选与依据都出现在校对结果里', () => {
  const model = modelOf({
    copy: [copyItem('copy1', 'en', '十九日电子页', 'Song Yao appears as the Ferryman throughout Act Two.')]
  });
  const check = model.copyChecks[0];
  const reason = check.results[0].reasons.find(item => item.code === 'stage-name-ambiguous');
  assert.ok(reason);
  assert.deepEqual(reason.candidates.map(item => item.performer).sort(), ['宋鹞', '宋遥'].sort());
  const evidence = reason.candidates.flatMap(item => item.evidence.map(entry => entry.id));
  assert.ok(evidence.includes('slot5'));
  assert.ok(evidence.includes('slot3'));
});

test('未确认场次不出确认结论，文案不能替它落名', () => {
  const notes = [
    note('rec1', '2026-10-12', '制作室', '十八日晚用甲组，卢遥唱渡人。乙组宋遥首演在十九日，河神宋鹞不变。'),
    note('rec3', '2026-10-13', '排练员', '替补名册含许凌，只有准备信息。')
  ];
  const copyRows = [copyItem('copy1', 'zh', '十九日电子页', '渡人由许凌担纲。')];
  const model = modelOf({ notes, copy: copyRows });
  const slot = model.schedule.byCell('河剧|19|晚场', '第二幕', '渡人');
  // 没有换角记录时沿用卡司表，但这不妨碍检查替补被写进正文。
  assert.equal(slot.performer, '宋遥');
  const check = model.copyChecks[0];
  assert.equal(check.shareable, false);
  assert.equal(check.results[0].status, 'fails');
});

test('同名艺名用作署名时，按当班安排先取一位并列出另一候选', () => {
  const model = modelOf({
    copy: [copyItem('copy1', 'en', '十九日电子页', 'Song Yao appears as the River God in Act Two.')]
  });
  const check = model.copyChecks[0];
  // 河神确是宋鹞，按安排可以取定，但要留下提示。
  assert.equal(check.shareable, true);
  assert.ok(check.results[0].reasons.some(reason => reason.code === 'ambiguous-name-resolved-by-schedule'));
});

test('晚到的译审不能沿用到新署名', () => {
  const model = modelOf({
    copy: [copyItem('copy2', 'en', '十九日电子页', 'Cheng Qiu appears as the Ferryman in Act Two.')],
    pageManifest: [
      {
        id: 'paper-19',
        kind: 'paper',
        scope: { performanceIds: ['河剧|19|晚场'] },
        copyIds: ['copy2'],
        castCells: [
          { act: '第二幕', role: '渡人', performer: '程秋', stageName: 'Cheng Qiu' }
        ],
        translationReview: {
          signature: [
            { act: '第二幕', role: '渡人', performer: '宋遥', stageName: 'Song Yao' }
          ]
        },
        deliveredAt: '2026-10-19T12:00:00+08:00'
      }
    ]
  });
  const status = model.editions.pageStatus(model.editions.ledger.pages[0]);
  assert.ok(status.issues.some(issue => issue.code === 'translation-review-stale'));
  assert.equal(status.valid, false);
});

test('旧印页与小传互相引用时成组处理，十八日的页不被牵连', () => {
  const model = modelOf({
    copy: [copyItem('copy2', 'en', '十九日电子页', 'Song Yao appears as the Ferryman in Act Two.')],
    pageManifest: [
      {
        id: 'paper-18',
        kind: 'paper',
        scope: { performanceIds: ['河剧|18|晚场'] },
        castCells: [
          { act: '第一幕', role: '渡人', performer: '卢遥', stageName: 'Lu Yao' },
          { act: '第二幕', role: '渡人', performer: '卢遥', stageName: 'Lu Yao' }
        ],
        deliveredAt: '2026-10-18T17:30:00+08:00'
      },
      {
        id: 'paper-19-bio',
        kind: 'paper',
        scope: { performanceIds: ['河剧|19|晚场'] },
        castCells: [
          { act: '第一幕', role: '渡人', performer: '宋遥', stageName: 'Song Yao' },
          { act: '第二幕', role: '渡人', performer: '宋遥', stageName: 'Song Yao' }
        ],
        deliveredAt: '2026-10-19T12:00:00+08:00'
      },
      {
        id: 'paper-19-intro',
        kind: 'paper',
        scope: { performanceIds: ['河剧|19|晚场'] },
        copyIds: ['copy2'],
        castCells: [
          { act: '第二幕', role: '渡人', performer: '宋遥', stageName: 'Song Yao' }
        ],
        deliveredAt: '2026-10-19T12:00:00+08:00'
      }
    ]
  });
  const groups = model.editions.groupPages(model.editions.ledger.pages);
  const eighteenth = groups.find(group => group.pages.some(page => page.id === 'paper-18'));
  assert.equal(eighteenth.valid, true);

  const nineteenth = groups.find(group => group.pages.some(page => page.id === 'paper-19-bio'));
  assert.equal(nineteenth.valid, false);
  assert.deepEqual(nineteenth.replaced.sort(), ['paper-19-bio', 'paper-19-intro'].sort());
  // 两页同属一册，都带旧署名，必须一起换，不能只换一页留下旧名字。
  assert.equal(nineteenth.replacement, 'whole-group');
});

test('票面场次命中正确版次，未付印稿不混进观众版本', () => {
  const model = modelOf({
    pageManifest: [
      {
        id: 'draft',
        kind: 'draft',
        scope: { performanceIds: [] },
        copyIds: []
      },
      {
        id: 'electronic-18',
        kind: 'electronic',
        scope: { performanceIds: ['河剧|18|晚场'] },
        castCells: [{ act: '第一幕', role: '渡人', performer: '卢遥', stageName: 'Lu Yao' }]
      },
      {
        id: 'electronic-19',
        kind: 'electronic',
        scope: { performanceIds: ['河剧|19|晚场'] },
        castCells: [{ act: '第二幕', role: '渡人', performer: '程秋', stageName: 'Cheng Qiu' }]
      }
    ]
  });
  const ledger = model.editions.ledger;
  const eighteenth = ledger.forTicket('河剧十八日晚', model);
  assert.deepEqual(eighteenth.pages.map(page => page.id), ['electronic-18']);
  assert.deepEqual(eighteenth.drafts.map(page => page.id), ['draft']);

  const nineteenth = ledger.forTicket('河剧|19|晚场', model);
  assert.deepEqual(nineteenth.pages.map(page => page.id), ['electronic-19']);

  const missing = ledger.forTicket('河剧二十日晚', model);
  assert.equal(missing.performance, null);
});

test('勘误只覆盖写明场次，已演场次仍可还原当时文字', () => {
  const model = modelOf({
    pageManifest: [
      {
        id: 'paper-19',
        kind: 'paper',
        scope: { performanceIds: ['河剧|19|晚场'] },
        castCells: [
          { act: '第一幕', role: '渡人', performer: '宋遥', stageName: 'Song Yao' }
        ],
        deliveredAt: '2026-10-19T12:00:00+08:00',
        issuedAt: '2026-10-19T12:00:00+08:00'
      },
      {
        id: 'errata-19',
        kind: 'erratum',
        erratumFor: 'paper-19',
        scope: { performanceIds: ['河剧|19|晚场'], acts: ['第二幕'] },
        castCells: [{ act: '第二幕', role: '渡人', performer: '程秋', stageName: 'Cheng Qiu' }],
        revision: 2,
        issuedAt: '2026-10-19T18:30:00+08:00'
      }
    ]
  });
  const ledger = model.editions.ledger;
  const before = ledger.effectiveText('河剧|19|晚场', '2026-10-19T13:00:00+08:00', model);
  assert.equal(before.acts['第一幕'].performer, '宋遥');
  // 勘误还没到，第二幕仍是原纸本上的名字。
  assert.equal(before.acts['第二幕'].performer, null);

  const after = ledger.effectiveText('河剧|19|晚场', '2026-10-19T19:00:00+08:00', model);
  assert.equal(after.acts['第二幕'].performer, '程秋');
  // 勘误只改第二幕，第一幕仍取原纸本。
  assert.equal(after.acts['第一幕'].performer, '宋遥');
});

test('同日多场不能替编辑选一场', () => {
  const sameDay = cast([
    { performance: '河剧十九日午场', act: '第一幕', role: '渡人', performer: '宋遥', stageName: 'Song Yao' },
    { performance: '河剧十九日晚场', act: '第一幕', role: '渡人', performer: '宋遥', stageName: 'Song Yao' }
  ]);
  const notes = [
    note('rec1', '2026-10-17', '舞台监督', '十九日渡人改由程秋接演。')
  ];
  const model = modelOf({ castRows: sameDay, notes });
  assert.ok(model.noteIssues.some(issue => issue.code === 'day-ambiguous'));
  // 只写“十九日”不足以确认是午场还是晚场，两场都要保留原安排。
  assert.equal(model.schedule.byCell('河剧|19|午场', '第一幕', '渡人').performer, '宋遥');
  assert.equal(model.schedule.byCell('河剧|19|晚场', '第一幕', '渡人').performer, '宋遥');
  assert.ok(model.noteIssues.some(issue => issue.code === 'statement-needs-performance-choice'));
});

test('英文稿里对不上名册的拉丁名要提示核对拼写', () => {
  const model = modelOf({
    copy: [copyItem('copy1', 'en', '十九日电子页', 'Song Yoa appears as the Ferryman in Act Two.')]
  });
  const check = model.copyChecks[0];
  assert.equal(check.shareable, false);
  assert.ok(check.results[0].reasons.some(reason => reason.code === 'unknown-latin-name'));
});

test('报告列出依据与原文范围', () => {
  const model = modelOf({
    copy: [copyItem('copy1', 'zh', '合印内页', '渡人两幕均由今晚的同一位演员担纲。')],
    pageManifest: [
      {
        id: 'paper-19',
        kind: 'paper',
        scope: { performanceIds: ['河剧|19|晚场'] },
        castCells: [{ act: '第二幕', role: '渡人', performer: '宋遥', stageName: 'Song Yao' }]
      }
    ]
  });
  const report = renderReport(model);
  assert.match(report, /河剧十九日晚/);
  assert.match(report, /rec2/);
  assert.match(report, /Cheng Qiu/);
  assert.match(report, /成组替换/);
});
