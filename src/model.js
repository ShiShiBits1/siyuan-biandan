import {parseManagedAttachments,composeManagedAttachments} from './attachments.js';
import {inspectSubtasks,validateSubtaskTitles} from './subtasks.js';

export const DEFAULT_LIST_ID = '1';
export const businessID = value => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return '';
  try { return BigInt(text).toString(); } catch { return ''; }
};
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const localDate = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const localTimestamp = date => `${localDate(date)} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}:00`;
const pendingCreates = new WeakMap();
const serialWrites = new WeakMap();

export function decodeContent(content) {
  const raw = typeof content === 'string' ? content : '';
  try {
    const parts = JSON.parse(raw);
    if (!Array.isArray(parts) || !parts.length || parts.some(value => typeof value !== 'string')) return {remark:raw,subtasks:[],attachments:[]};
    let remark = parts[0],attachments = [];
    try { const bundle = JSON.parse(remark); if (Array.isArray(bundle) && bundle.length === 2 && typeof bundle[0] === 'string' && Array.isArray(bundle[1])) {remark = bundle[0];attachments = bundle[1];} } catch {}
    return {remark,subtasks:parts.slice(1),attachments};
  } catch { return {remark:raw,subtasks:[],attachments:[]}; }
}

/** Edit only the remark and this plugin's SiYuan-link segment. Native Biandan
 * file references (including unrecognized legacy values) and subtask ordering
 * stay byte-for-value intact inside the original outer encoding. */
export function encodeTaskContent(content,patch = {}) {
  const hasRemark = Object.prototype.hasOwnProperty.call(patch,'remark'),hasAttachments = Object.prototype.hasOwnProperty.call(patch,'attachments'),hasSubtasks = Object.prototype.hasOwnProperty.call(patch,'subtasks');
  if (!hasRemark && !hasAttachments && !hasSubtasks) return content;
  if (typeof content !== 'string' && content !== null && content !== undefined) throw new Error('已有待办正文格式无法确认，已保留原值');
  const raw = content ?? '',decoded = decodeContent(raw),managed = parseManagedAttachments(decoded.remark);
  const subtasks = hasSubtasks ? validateSubtaskTitles(patch.subtasks) : decoded.subtasks;
  if (managed.invalid) {
    if (hasAttachments || (hasRemark && patch.remark !== decoded.remark)) throw new Error('思源附件段已被修改，请先核查；原备注和附件均已保留');
    if (!hasSubtasks) return raw;
    let original;
    try {original = JSON.parse(raw);} catch {}
    const first = Array.isArray(original) && original.length && original.every(value => typeof value === 'string') ? original[0] : raw;
    return JSON.stringify([first,...subtasks]);
  }
  const remark = hasRemark ? patch.remark : managed.remark;
  if (typeof remark !== 'string' || remark.length > 20000) throw new Error('备注格式或长度无效');
  const nextRemark = composeManagedAttachments(remark,hasAttachments ? patch.attachments : managed.attachments);
  let parts;
  try {parts = JSON.parse(raw);} catch {}
  if (!Array.isArray(parts) || !parts.length || parts.some(value => typeof value !== 'string')) return subtasks.length ? JSON.stringify([nextRemark,...subtasks]) : nextRemark;
  if (!hasRemark && !hasAttachments) return JSON.stringify([parts[0],...subtasks]);
  let first = nextRemark;
  try {
    const bundle = JSON.parse(parts[0]);
    if (Array.isArray(bundle) && bundle.length === 2 && typeof bundle[0] === 'string' && Array.isArray(bundle[1])) first = JSON.stringify([nextRemark,bundle[1]]);
  } catch {}
  return JSON.stringify([first,...subtasks]);
}
function bitCount(value) {
  let bits = BigInt(Math.max(0,Math.floor(value))),count = 0;
  while (bits) {count += Number(bits & 1n);bits >>= 1n;}
  return count;
}
function target(task) {
  const value = number(task.unitTimeNumber);
  return value > 0 ? value : 1;
}
export function toTasks(tasks = [],occurrences = [],lists = []) {
  const definitions = new Map(tasks.map(record => [businessID(record.attributes?.id1),record]));
  const categories = new Map(lists.map(record => [businessID(record.attributes?.id3),record.attributes]));
  return occurrences.flatMap(record => {
    const attrs = record.attributes || {},taskRecord = definitions.get(businessID(attrs.id1));
    if (!taskRecord) return [];
    const task = taskRecord.attributes,content = decodeContent(task.taskContent),listId = businessID(task.id3) || DEFAULT_LIST_ID;
    const category = categories.get(listId),goal = target(task),progress = number(attrs.completedCount),steps = goal >= 100;
    const completedSteps = content.subtasks.map((_,index) => progress >= 0 && (BigInt(Math.floor(progress/100)) & (1n << BigInt(index))) !== 0n);
    return [{id:String(record.id),recordId:String(record.id),occurrenceId:businessID(attrs.id2),taskId:businessID(task.id1),taskRecordId:String(taskRecord.id),version:record.version,
      title:String(task.taskTitle || '未命名待办'),...content,done:number(attrs.isFinish) === 1,abandoned:progress < 0,
      important:number(task.isImportant) === 1,urgent:number(task.isUrgency) === 1,collectible:number(task.isCollectible) === 1,
      listId,listName:category?.favoritesName || '未分类',colorIndex:Math.max(0,number(category?.favoritesColor))%100,
      startDate:String(attrs.startTime ?? task.startTime ?? ''),endDate:String(attrs.endTime ?? task.endTime ?? ''),
      startTime:String(attrs.validStartTime ?? task.validStartTime ?? '00:00:00'),endTime:String(attrs.validEndTime ?? task.validEndTime ?? '23:59:59'),
      allDay:number(task.haveNoTime) === 1 || ((attrs.validStartTime || task.validStartTime) === '00:00:00' && (attrs.validEndTime || task.validEndTime) === '23:59:59'),
      noTime:number(task.haveNoTime) === 1,habit:number(task.isLoop) >= 2,
      completedCount:steps ? bitCount(Math.floor(Math.max(0,progress)/100)) : Math.max(0,progress),targetCount:steps ? bitCount(Math.floor(goal/100)) : goal,completedSteps,
      rawTask:taskRecord,rawOccurrence:record}];
  });
}
function serialize(client,operation) {
  const previous = serialWrites.get(client) || Promise.resolve();
  const result = previous.catch(() => {}).then(operation);serialWrites.set(client,result);
  return result;
}
export {serialize as serializeBiandanWrite};
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value+'T12:00:00');return !Number.isNaN(date.getTime()) && localDate(date) === value;
}
function validTime(value) { return /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value); }
function newID() {
  const bytes = new Uint32Array(1);globalThis.crypto.getRandomValues(bytes);
  return Date.now()*1000 + bytes[0]%1000;
}

/** A once-only task and its instance. Failures retain identities for manual reconciliation. */
export async function createOneOff(client,draft = {}) {
  return serialize(client,async () => {
    const title = typeof draft.title === 'string' ? draft.title.trim() : '';
    if (!title || title.length > 500) throw new Error('请输入不超过 500 字的待办标题');
    let remark = draft.remark ?? draft.content ?? '';
    if (typeof remark !== 'string' || remark.length > 20000) throw new Error('备注格式或长度无效');
    if (Object.prototype.hasOwnProperty.call(draft,'attachments')) remark = composeManagedAttachments(remark,draft.attachments);
    const subtasks = validateSubtaskTitles(draft.subtasks ?? []).map(value => value.trim());
    const noTime = Boolean(draft.noTime ?? draft.unscheduled);
    const startDate = noTime ? '1970-01-01' : draft.startDate || localDate(new Date());
    const endDate = noTime ? '2100-12-31' : draft.endDate || startDate;
    const startTime = draft.startTime ? draft.startTime.length === 5 ? draft.startTime+':00' : draft.startTime : '00:00:00';
    const endTime = draft.endTime ? draft.endTime.length === 5 ? draft.endTime+':00' : draft.endTime : '23:59:59';
    if (!validDate(startDate) || !validDate(endDate) || !validTime(startTime) || !validTime(endTime) || startDate+' '+startTime > endDate+' '+endTime) throw new Error('待办起止日期或时间无效');
    const listId = businessID(draft.listId ?? DEFAULT_LIST_ID);
    if (!listId || !Number.isSafeInteger(Number(listId)) || Number(listId) < 1) throw new Error('待办单 ID 无效');
    const [tasks,occurrences,lists] = await Promise.all(['Task','showTask','favorites'].map(kind => client.list(kind)));
    if (listId !== DEFAULT_LIST_ID && !lists.some(row => businessID(row.attributes.id3) === listId)) throw new Error('待办单已变更，请刷新后重新选择');
    const fields = {title,remark,subtasks,noTime,startDate,endDate,startTime,endTime,listId,important:!!draft.important,urgent:!!draft.urgent,collectible:!!draft.collectible};
    const source = new TextEncoder().encode(JSON.stringify(fields));
    const fingerprint = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',source)),value => value.toString(16).padStart(2,'0')).join('');
    let pending = pendingCreates.get(client);
    if (!pending) {
      pending = new Map();
      if (typeof client.loadPendingWrites === 'function') {
        const stored = await client.loadPendingWrites();
        if (stored !== undefined && stored !== null) {
          if (stored.version !== 1 || !Array.isArray(stored.entries) || stored.entries.length > 50 || stored.entries.some(entry => !/^[a-f0-9]{64}$/.test(entry?.fingerprint) || !businessID(entry?.taskId) || !businessID(entry?.occurrenceId))) throw new Error('待核查创建记录无法读取，已停止创建以避免重复');
          for (const {fingerprint,...entry} of stored.entries) pending.set(fingerprint,entry);
        }
      }
      pendingCreates.set(client,pending);
    }
    const persist = () => typeof client.savePendingWrites === 'function' ? client.savePendingWrites({version:1,entries:[...pending].map(([fingerprint,state]) => ({fingerprint,...state}))}) : undefined;
    if (pending.has(fingerprint)) throw Object.assign(new Error('此前创建结果尚待核查，请刷新确认，未重复创建'),pending.get(fingerprint));
    if (pending.size >= 50) throw new Error('待核查创建已达上限，请先处理已有记录');
    const used = new Set([...tasks.map(row => businessID(row.attributes.id1)),...occurrences.map(row => businessID(row.attributes.id2))]);
    let id;
    for (let attempt = 0; attempt < 10; attempt++) {const value = newID();if (Number.isSafeInteger(value) && value > 0 && !used.has(String(value))) {id=value;break;}}
    if (!id) throw new Error('无法分配不冲突的待办 ID，请稍后重试');
    const task = {id1:id,taskTitle:title,taskContent:subtasks.length ? JSON.stringify([remark,...subtasks]) : remark,id3:Number(listId),
      isCollectible:+fields.collectible,isImportant:+fields.important,isUrgency:+fields.urgent,startTime:startDate,endTime:endDate,isLoop:0,haveNoTime:+noTime,
      unitTimeNumber:subtasks.length ? Number(((1n << BigInt(subtasks.length))-1n)*100n) : 1,validStartTime:startTime,validEndTime:endTime,
      loopSet:0,loopBaseNumber:1,loopUnit:0,loopDate:'',duration:0,isRemind:0,remindDate:'',remindTime:'',isFinish:0,latitude:-1,longitude:-1,location:''};
    const occurrence = {id2:id,id1:id,startTime:startDate,endTime:endDate,validStartTime:startTime,validEndTime:endTime,completedCount:0,recentFinishedTime:'',isFinish:0};
    const state = {taskId:String(id),occurrenceId:String(id),commitState:'unknown'};pending.set(fingerprint,state);
    try {await persist();} catch (cause) {pending.delete(fingerprint);throw Object.assign(new Error('无法保存创建检查记录，未发起云端写入'),{cause});}
    try {
      await client.create('Task',task);
      await client.create('showTask',occurrence);
      const [savedTasks,savedOccurrences] = await Promise.all(['Task','showTask'].map(kind => client.list(kind)));
      const foundTasks = savedTasks.filter(row => businessID(row.attributes.id1) === String(id));
      const foundOccurrences = savedOccurrences.filter(row => businessID(row.attributes.id2) === String(id) && businessID(row.attributes.id1) === String(id));
      if (foundTasks.length !== 1 || foundOccurrences.length !== 1 || foundTasks[0].attributes.taskTitle !== title) throw new Error('尚未核对到完整的待办定义和执行实例');
      pending.delete(fingerprint);
      await persist();
      return {task:foundTasks[0],occurrence:foundOccurrences[0],taskId:String(id),occurrenceId:String(id)};
    } catch (cause) {
      pending.set(fingerprint,state);
      throw Object.assign(new Error(`创建结果待核查，任务 ID ${id}。请刷新并检查便单客户端，勿重复提交。`),state,{cause});
    }
  });
}

export function setOccurrenceCompleted(client,value,done,{expectedVersion} = {}) {
  return serialize(client,async () => {
    const recordId = typeof value === 'string' ? value : value?.recordId ?? value?.id;
    if (typeof recordId !== 'string' || typeof done !== 'boolean') throw new Error('待办完成操作参数无效');
    const current = await client.get('showTask',recordId);
    const expected = expectedVersion ?? (typeof value === 'object' ? value.version : undefined);
    if (expected !== undefined && String(expected) !== String(current.version)) throw Object.assign(new Error('该执行实例已被修改，请刷新后重试'),{status:409});
    const parents = (await client.list('Task')).filter(row => businessID(row.attributes.id1) === businessID(current.attributes.id1));
    if (parents.length !== 1) throw new Error('找不到唯一的父任务，请刷新核查');
    const parent = await client.get('Task',parents[0].id),goal = target(parent.attributes);
    if (!Number.isSafeInteger(goal) || goal < 1) throw new Error('此任务的完成目标无效，请在便单原生客户端检查');
    const count = done ? goal : 0;
    let updated = current;
    if (number(current.attributes.isFinish) !== +done || number(current.attributes.completedCount) !== count) {
      updated = await client.update('showTask',recordId,current.version,{completedCount:count,isFinish:+done,recentFinishedTime:localTimestamp(new Date())});
    }
    try {
      const siblings = (await client.list('showTask')).filter(row => businessID(row.attributes.id1) === businessID(parent.attributes.id1));
      const freshParent = await client.get('Task',parent.id);
      if (target(freshParent.attributes) !== goal) throw new Error('父任务完成目标已变化');
      if (siblings.filter(row => row.id === recordId).length !== 1) throw new Error('执行实例列表尚未完整同步');
      const verifiedSiblings = siblings.map(row => row.id === recordId ? updated : row);
      const finish = verifiedSiblings.some(row => number(row.attributes.isFinish) === 0 && number(row.attributes.completedCount) >= 0) ? 0 : 1;
      if (number(freshParent.attributes.isFinish) !== finish) await client.update('Task',freshParent.id,freshParent.version,{isFinish:finish});
      return updated;
    } catch (cause) {
      throw Object.assign(new Error('本次实例进度已提交，父任务汇总尚待核查；请刷新，勿重复勾选'),{cause,recordId,commitState:'partial'});
    }
  });
}

/** Toggle one native checklist bit for the selected occurrence only. The
 * definition and selected occurrence versions are both checked before writing. */
export function setSubtaskCompleted(client,value,index,done,{expectedVersion,expectedTaskVersion} = {}) {
  return serialize(client,async () => {
    const recordId = typeof value === 'string' ? value : value?.recordId ?? value?.id;
    const expected = expectedVersion ?? value?.version;
    const conflict = () => Object.assign(new Error('子计划或执行实例已被其他客户端修改，请刷新后重试'),{status:409});
    if (typeof recordId !== 'string' || !recordId || !Number.isInteger(index) || index < 0 || typeof done !== 'boolean') throw new Error('子计划勾选参数无效');
    if (expected === undefined || expected === null || expectedTaskVersion === undefined || expectedTaskVersion === null) throw new Error('勾选子计划前请先读取任务和执行实例版本');
    const current = await client.get('showTask',recordId);
    if (String(current.version) !== String(expected)) throw conflict();
    const taskId = businessID(current.attributes?.id1),occurrenceId = businessID(current.attributes?.id2);
    if (!taskId || taskId === '0' || !occurrenceId || occurrenceId === '0') throw new Error('子计划执行实例身份无法确认');
    if (value?.attributes && (businessID(value.attributes.id1) !== taskId || businessID(value.attributes.id2) !== occurrenceId)) throw conflict();
    const parents = (await client.list('Task')).filter(row => businessID(row.attributes?.id1) === taskId);
    if (parents.length !== 1) throw new Error('找不到唯一的父任务，请刷新核查');
    const parent = await client.get('Task',parents[0].id);
    if (String(parent.version) !== String(expectedTaskVersion) || businessID(parent.attributes?.id1) !== taskId) throw conflict();
    const state = inspectSubtasks(parent.attributes,current.attributes);
    if (!state.canToggle || index >= state.total) throw new Error(state.reason || '找不到可勾选的子计划，请刷新核查');
    const beforeOccurrences = await client.list('showTask');
    const sameBusinessId = beforeOccurrences.filter(row => businessID(row.attributes?.id2) === occurrenceId);
    if (sameBusinessId.length !== 1 || sameBusinessId[0].id !== recordId || businessID(sameBusinessId[0].attributes?.id1) !== taskId || String(sameBusinessId[0].version) !== String(current.version)) throw conflict();
    const bit = 1n << BigInt(index),mask = BigInt(Number(current.attributes.completedCount)/100);
    const nextMask = done ? mask | bit : mask & ~bit;
    if (mask === nextMask) return current;
    const nextCount = Number(nextMask*100n),finish = +(nextCount === Number(parent.attributes.unitTimeNumber));
    // Recheck the other table immediately before the conditional instance
    // update. Cloud records remain separate transactions; uncertainty is explicit.
    const beforeWrite = await client.get('Task',parent.id);
    if (String(beforeWrite.version) !== String(parent.version) || businessID(beforeWrite.attributes?.id1) !== taskId) throw conflict();
    let updated,confirmedWrites = 0;
    try {
      updated = await client.update('showTask',recordId,current.version,{completedCount:nextCount,isFinish:finish,recentFinishedTime:localTimestamp(new Date())});
      confirmedWrites++;
      const afterOccurrences = await client.list('showTask');
      const matchingOccurrence = afterOccurrences.filter(row => businessID(row.attributes?.id2) === occurrenceId);
      if (matchingOccurrence.length !== 1 || matchingOccurrence[0].id !== recordId || businessID(matchingOccurrence[0].attributes?.id1) !== taskId || String(matchingOccurrence[0].version) !== String(updated.version)) throw new Error('执行实例列表尚未唯一同步');
      const siblings = afterOccurrences.filter(row => businessID(row.attributes?.id1) === taskId);
      const freshParent = await client.get('Task',parent.id);
      if (String(freshParent.version) !== String(parent.version) || businessID(freshParent.attributes?.id1) !== taskId) throw conflict();
      const verified = siblings.map(row => row.id === recordId ? updated : row);
      const validInteger = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isSafeInteger(Number(value));
      if (verified.some(row => !validInteger(row.attributes?.isFinish) || ![0,1].includes(Number(row.attributes.isFinish)) || !validInteger(row.attributes?.completedCount) || Number(row.attributes.completedCount) < -1)) throw new Error('其他执行实例的状态无法确认');
      const siblingIds = new Set();
      for (const row of verified) {
        const siblingId = businessID(row.attributes?.id2);
        if (!siblingId || siblingId === '0' || siblingIds.has(siblingId)) throw new Error('其他执行实例身份无法唯一确认');
        siblingIds.add(siblingId);
        if (Number(row.attributes.completedCount) !== -1 && !inspectSubtasks(freshParent.attributes,row.attributes).canToggle) throw new Error('其他执行实例的子计划目标、完成位或状态不一致，请先核查');
      }
      const summary = verified.some(row => Number(row.attributes.isFinish) === 0 && Number(row.attributes.completedCount) >= 0) ? 0 : 1;
      if (number(freshParent.attributes.isFinish) !== summary) await client.update('Task',freshParent.id,freshParent.version,{isFinish:summary});
      return updated;
    } catch (cause) {
      if (!confirmedWrites && cause.status === 409) throw cause;
      throw Object.assign(new Error(confirmedWrites ? '本次子计划进度已提交，父任务汇总尚待核查；请刷新，勿重复勾选' : '子计划保存结果尚待核查；请刷新，未自动重试'),{cause,recordId,confirmedWrites,commitState:confirmedWrites ? 'partial' : 'unknown'});
    }
  });
}
