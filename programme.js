import { readMaterials } from './materials.js';
import { buildPerformances } from './src/performances.js';
import { buildRoster, parseNotes } from './src/notes.js';
import { resolveAssignments } from './src/schedule.js';
import { proofCopy } from './src/copy.js';
import { buildEditions, readEditionManifest } from './src/editions.js';

// 不读文件，直接用已校验的资料构建模型；测试与会话内查询都走这里。
export function buildProgrammeModel({ cast, notes, copy, pageManifest = [] }) {
  const performances = buildPerformances(cast);
  const roles = [...new Set(cast.map(row => row.role))];
  const acts = [...new Set(cast.map(row => row.act))];
  const works = [...new Set(performances.map(performance => performance.work))];

  const model = {
    materials: {
      '卡司表.json': cast,
      '排演札记.json': notes,
      '连场文案.json': copy
    },
    cast,
    notes,
    copy,
    performances,
    roles,
    acts,
    works,
    pageManifest,
    extraPerformers: []
  };

  const parsed = parseNotes({ notes, cast, performances }, model);
  model.statements = parsed.statements;
  model.noteIssues = parsed.issues;
  model.roster = parsed.roster;

  model.schedule = resolveAssignments(model);
  model.copyChecks = proofCopy(model);
  model.editions = buildEditions(model);

  return model;
}

export async function loadProgrammeModel(directory) {
  const materials = await readMaterials(directory);
  const pageManifest = await readEditionManifest(directory);
  return buildProgrammeModel({
    cast: materials['卡司表.json'],
    notes: materials['排演札记.json'],
    copy: materials['连场文案.json'],
    pageManifest
  });
}

export { readMaterials };
