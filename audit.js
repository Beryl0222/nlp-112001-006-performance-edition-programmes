import { readFile } from 'node:fs/promises';
import { loadProgrammeModel } from './programme.js';
import { renderReport } from './report.js';

const args = process.argv.slice(2);

function usage() {
  return [
    '用法：node audit.js [--json] [--ticket <场次>] [--at <时间>]',
    '',
    '  --json            输出结构化结果',
    '  --ticket 场次     查询票面场次对应的版本（场次名或 id）',
    '  --at 时间         配合 --ticket，还原该时间点的印面文字',
    '  --report          输出完整校对报告（默认）'
  ].join('\n');
}

function flag(name) {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1] ?? null;
}

try {
  const model = await loadProgrammeModel();
  const json = args.includes('--json');
  const ticket = flag('--ticket');
  const at = flag('--at');

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
  } else if (ticket) {
    const ledger = model.editions.ledger;
    const lookup = ledger.forTicket(ticket, model);
    const effective = at && lookup.performance
      ? ledger.effectiveText(lookup.performance.id, at, model)
      : null;
    if (json) {
      process.stdout.write(`${JSON.stringify({ lookup, effective }, null, 2)}\n`);
    } else if (lookup.ambiguous) {
      process.stdout.write(`票面场次“${ticket}”对应多场：${lookup.candidates.join('、')}\n`);
    } else if (!lookup.performance) {
      process.stdout.write(`找不到票面场次“${ticket}”\n`);
      process.exitCode = 2;
    } else {
      process.stdout.write(`# ${lookup.performance.label}\n`);
      for (const page of lookup.pages) {
        process.stdout.write(`- ${page.kindLabel} ${page.id}（第 ${page.revision} 版）${page.status.valid ? '' : ' 已失效'}\n`);
        for (const copy of page.text.copy) process.stdout.write(`  文案 ${copy.id}：${copy.text ?? '（缺）'}\n`);
        for (const signature of page.text.signatures) {
          process.stdout.write(`  印面 ${signature.act} ${signature.role}：${signature.performer}${signature.stageName ? ` / ${signature.stageName}` : ''}\n`);
        }
      }
      if (effective) {
        process.stdout.write(`\n## ${at} 生效文字\n`);
        for (const [act, value] of Object.entries(effective.acts)) {
          process.stdout.write(`- ${act}：${value.performer ?? '（无署名）'}${value.stageName ? ` / ${value.stageName}` : ''}（${value.pageId ?? '无页'}）\n`);
          for (const copy of value.copy) process.stdout.write(`  文案 ${copy.id}：${copy.text}\n`);
          if (value.copyPageSignatureStale) process.stdout.write('  ! 文字页署名与生效署名不一致，译文需重签\n');
        }
      }
    }
  } else if (json) {
    process.stdout.write(`${JSON.stringify(model, (key, value) => {
      if (value instanceof Map) return Object.fromEntries(value);
      if (value instanceof Set) return [...value];
      return value;
    }, 2)}\n`);
  } else {
    process.stdout.write(`${renderReport(model)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
