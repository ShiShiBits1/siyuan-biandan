export const MAX_SUBTASKS = 20;

const integer = value => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
};
const titlesOf = content => {
  try {
    const parts = JSON.parse(content);
    return Array.isArray(parts) && parts.length > 0 && parts.every(value => typeof value === 'string') ? parts.slice(1) : [];
  } catch { return []; }
};
export function validateSubtaskTitles(value) {
  if (!Array.isArray(value) || value.length > MAX_SUBTASKS || value.some(title => typeof title !== 'string' || !title.trim() || title.length > 500 || /[\x00-\x1f\x7f]/.test(title))) throw new Error('子计划最多20项，每项须为不超过500字的非空单行内容');
  return value.slice();
}
export function subtaskGoal(length) {
  if (!Number.isInteger(length) || length < 0 || length > MAX_SUBTASKS) throw new Error('子计划数量无效');
  return length ? Number(((1n << BigInt(length))-1n)*100n) : 1;
}
export function validateSubtaskPatch(value,oldLength) {
  if (!Array.isArray(value)) throw new Error('子计划编辑格式无效');
  const used = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['title','sourceIndex'].includes(key))) throw new Error('子计划编辑格式无效');
    const source = entry.sourceIndex;
    if (source !== null && (!Number.isInteger(source) || source < 0 || source >= oldLength || used.has(source))) throw new Error('子计划原始位置已变化，请重新打开后编辑');
    if (source !== null) used.add(source);
  }
  validateSubtaskTitles(value.map(entry => entry.title));
  return value.map(entry => ({title:entry.title.trim(),sourceIndex:entry.sourceIndex}));
}

/** A read-only projection: unsupported native modes remain visible, while
 * writes fail closed instead of guessing how to rewrite their progress. */
export function inspectSubtasks(task = {},occurrence = {}) {
  const subtasks = titlesOf(task.taskContent),total = subtasks.length;
  const value = {subtasks,completed:subtasks.map(() => false),doneCount:0,total,canToggle:false,canEdit:false,canEditSeries:false,reason:''};
  try { validateSubtaskTitles(subtasks); } catch (error) { return {...value,reason:error.message}; }
  const goal = integer(task.unitTimeNumber),progress = integer(occurrence.completedCount),finish = integer(occurrence.isFinish);
  if (progress === -1) {
    const loop = integer(task.isLoop),loopSet = integer(task.loopSet);
    const validGoal = total ? goal === subtaskGoal(total) : goal === 1;
    if (validGoal && [0,1].includes(finish) && loop !== null && loopSet !== null && loop >= 0 && loopSet >= 0 && (loop > 0 || loopSet > 0)) return {...value,canEditSeries:true,reason:'本次已放弃；编辑整个系列将保留本次放弃状态'};
    return {...value,reason:'已放弃的待办请先在便单客户端核查，不能修改子计划'};
  }
  if (goal === null || progress === null || progress < 0 || ![0,1].includes(finish)) return {...value,reason:'已有完成进度无法确认，请先在便单客户端核查'};
  if (total) {
    if (goal !== subtaskGoal(total) || progress % 100 !== 0 || progress > goal || finish !== +(progress === goal)) return {...value,reason:'子计划目标或完成位不一致，请先在便单客户端核查'};
    const mask = BigInt(progress/100);
    value.completed = subtasks.map((_,index) => Boolean(mask & (1n << BigInt(index))));
    value.doneCount = value.completed.filter(Boolean).length;
    value.canToggle = true;
  } else if (goal !== 1 || progress > 1 || finish !== +(progress === 1)) {
    return {...value,reason:goal > 1 && goal < 100 ? '计次待办请在便单客户端转换为子计划' : '已有目标与子计划内容不一致，请先在便单客户端核查'};
  }
  const loop = integer(task.isLoop),loopSet = integer(task.loopSet);
  if (loop === null || loopSet === null || loop < 0 || loopSet < 0) return {...value,reason:'重复规则无法确认，暂不修改子计划结构'};
  if (loop > 0 || loopSet > 0) return {...value,canEditSeries:true,reason:'增删重复或习惯子计划将影响整个系列，保存前需核对影响范围'};
  return {...value,canEdit:true};
}
