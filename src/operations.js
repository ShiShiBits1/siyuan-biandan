import {businessID,encodeTaskContent,serializeBiandanWrite} from './model.js';
import {inspectSubtasks,subtaskGoal,validateSubtaskPatch} from './subtasks.js';

const attributes = record => record?.attributes || {};
const has = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const conflict = () => Object.assign(new Error('记录或操作范围已在其他客户端变更，请刷新后重新确认'),{status:409});
function identity(record) {
  const id = typeof record === 'string' ? record : record?.id;
  if (typeof id !== 'string' || !id.trim()) throw new Error('云记录身份无效，请刷新后重试');
  return id;
}
async function fresh(client,kind,record,expectedVersion) {
  const expected = expectedVersion ?? record?.version;
  if (expected === undefined || expected === null) throw new Error('操作前请先读取记录版本');
  const current = await client.get(kind,identity(record));
  if (String(current.version) !== String(expected)) throw conflict();
  const field = kind === 'Task' ? 'id1' : kind === 'showTask' ? 'id2' : 'id3';
  const currentId = businessID(attributes(current)[field]);
  if (!currentId || currentId === '0') throw new Error('记录业务身份无法确认，请在便单客户端核查');
  if (record?.attributes && businessID(record.attributes[field]) !== currentId) throw conflict();
  return current;
}
function title(value,label,max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`请输入不超过 ${max} 字的${label}`);
  return value.trim();
}
function color(value) {
  if (!Number.isInteger(value) || value < 0 || value > 24) throw new Error('请选择 0–24 范围内的待办单颜色');
  return value;
}
function encodedColor(value) {
  const numeric = Number(value ?? 0);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric % 100 > 24) throw new Error('待办单已有排序或颜色无效，请先在便单客户端核查');
  return numeric;
}
const validListId = value => {
  const id = businessID(value);
  if (!id || !Number.isSafeInteger(Number(id)) || Number(id) < 1) throw new Error('待办单 ID 无效');
  return id;
};
async function signature(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value => value.toString(16).padStart(2,'0')).join('');
}
function recordIdentity(record) { return [String(record.id),String(record.version)]; }
const sortedIdentities = records => records.map(recordIdentity).sort((a,b) => a[0].localeCompare(b[0]));
const scheduleFields = ['startDate','endDate','startTime','endTime','noTime'];
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value+'T12:00:00');
  return Number.isFinite(parsed.getTime()) && `${parsed.getFullYear()}-${String(parsed.getMonth()+1).padStart(2,'0')}-${String(parsed.getDate()).padStart(2,'0')}` === value;
}
function clock(value) {
  const text = typeof value === 'string' && value.length === 5 ? value+':00' : value;
  if (typeof text !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(text)) throw new Error('请输入有效的待办时段');
  return text;
}
function taskWindow(parent,occurrence,patch) {
  const original = attributes(parent),instance = attributes(occurrence);
  if (has(patch,'noTime') && typeof patch.noTime !== 'boolean') throw new Error('待安排状态必须为勾选状态');
  const noTime = has(patch,'noTime') ? patch.noTime : number(original.haveNoTime) === 1;
  const startTime = noTime ? '1970-01-01' : patch.startDate ?? instance.startTime ?? original.startTime;
  const endTime = noTime ? '2100-12-31' : patch.endDate ?? instance.endTime ?? original.endTime ?? startTime;
  const validStartTime = noTime ? '00:00:00' : clock(patch.startTime ?? instance.validStartTime ?? original.validStartTime ?? '00:00:00');
  const validEndTime = noTime ? '23:59:59' : clock(patch.endTime ?? instance.validEndTime ?? original.validEndTime ?? '23:59:59');
  if (!date(startTime) || !date(endTime) || startTime+' '+validStartTime > endTime+' '+validEndTime) throw new Error('待办起止日期或时间无效');
  return {noTime,fields:{startTime,endTime,validStartTime,validEndTime}};
}
function changedAttributes(record,changes) {
  return Object.fromEntries(Object.entries(changes).filter(([key,value]) => {
    const previous = attributes(record)[key];
    return typeof value === 'number' ? !(previous !== null && previous !== undefined && String(previous).trim() !== '' && Number(previous) === value) : previous !== value;
  }));
}
function verifyPreview(preview,current,kind) {
  if (!preview || preview.kind !== kind || typeof preview.fingerprint !== 'string' || preview.fingerprint !== current.fingerprint) throw conflict();
}
function uncertain(error,message,progress = {}) {
  const partial = Object.values(progress).some(value => typeof value === 'number' && value > 0);
  return Object.assign(new Error(message),{commitState:partial ? 'partial' : 'unknown',...progress,cause:error});
}

/** Patch shared definition fields only; preserve attachments, checklists,
 * recurrence, reminders, history and unrecognized properties. */
export function updateTask(client,parentRecord,patch,{expectedVersion,occurrence,expectedOccurrenceVersion} = {}) {
  return serializeBiandanWrite(client,async () => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !['title','remark','attachments','subtasks','important','urgent','collectible','listId',...scheduleFields].includes(key))) throw new Error('待办编辑字段无效');
    const parent = await fresh(client,'Task',parentRecord,expectedVersion),changes = {};
    const editingSubtasks = has(patch,'subtasks'),editingSchedule = scheduleFields.some(key => has(patch,key));
    if (has(patch,'title')) changes.taskTitle = title(patch.title,'待办标题',500);
    if (has(patch,'remark') || has(patch,'attachments')) {
      const contentPatch = {...(has(patch,'remark') ? {remark:patch.remark} : {}),...(has(patch,'attachments') ? {attachments:patch.attachments} : {})};
      changes.taskContent = encodeTaskContent(attributes(parent).taskContent,contentPatch);
    }
    for (const [source,destination] of [['important','isImportant'],['urgent','isUrgency'],['collectible','isCollectible']]) {
      if (!has(patch,source)) continue;
      if (typeof patch[source] !== 'boolean') throw new Error('待办标志必须为勾选状态');
      changes[destination] = +patch[source];
    }
    if (has(patch,'listId')) {
      const id = validListId(patch.listId);
      if (id !== '1' && (await client.list('favorites')).filter(row => businessID(attributes(row).id3) === id).length !== 1) throw new Error('找不到唯一的待办单，请刷新后重新选择');
      changes.id3 = Number(id);
    }
    let selected,window,subtaskChanges = {};
    if (editingSchedule || editingSubtasks) {
      if (number(attributes(parent).isLoop) > 0 || number(attributes(parent).loopSet) > 0) throw new Error(editingSubtasks ? '重复或习惯待办的子计划增删请在便单客户端操作；本次未写入' : '重复或习惯待办的排期请在便单客户端修改；本次未写入');
      if (!occurrence) throw new Error('修改排期或子计划前请先读取唯一执行实例及版本');
      selected = await fresh(client,'showTask',occurrence,expectedOccurrenceVersion);
      const taskId = businessID(attributes(parent).id1);
      const siblings = (await client.list('showTask')).filter(row => businessID(attributes(row).id1) === taskId);
      if (businessID(attributes(selected).id1) !== taskId || siblings.length !== 1 || siblings[0].id !== selected.id || businessID(attributes(siblings[0]).id2) !== businessID(attributes(selected).id2)) throw new Error('一次性待办包含额外或不匹配实例，不能修改排期或子计划，请先核查');
      if (String(siblings[0].version) !== String(selected.version)) throw conflict();
    }
    if (editingSchedule) {
      window = taskWindow(parent,selected,patch);
      Object.assign(changes,window.fields,{haveNoTime:+window.noTime});
      if (window.noTime) {
        const flags = number(attributes(parent).isRemind);
        if (!Number.isSafeInteger(flags) || flags < 0) throw new Error('已有提醒标志无法确认，请先核查');
        // Native clear-schedule disables only its time reminder. Preserve the
        // independent location reminder and all unknown bits.
        changes.isRemind = flags % 2 ? flags-1 : flags;
      }
    }
    if (editingSubtasks) {
      const state = inspectSubtasks(attributes(parent),attributes(selected));
      if (!state.canEdit) throw new Error(state.reason || '此待办暂不能修改子计划');
      const plan = validateSubtaskPatch(patch.subtasks,state.total),goal = subtaskGoal(plan.length);
      const completed = plan.map(entry => entry.sourceIndex === null ? false : state.completed[entry.sourceIndex]);
      const progress = plan.length ? Number(completed.reduce((mask,done,index) => done ? mask | (1n << BigInt(index)) : mask,0n)*100n) : +Boolean(Number(attributes(selected).isFinish));
      const finish = +(progress === goal);
      // Edit content once so simultaneous remark/attachment/subplan changes
      // retain the original native bundle and unrelated fields.
      changes.taskContent = encodeTaskContent(attributes(parent).taskContent,{
        ...(has(patch,'remark') ? {remark:patch.remark} : {}),
        ...(has(patch,'attachments') ? {attachments:patch.attachments} : {}),
        subtasks:plan.map(entry => entry.title),
      });
      changes.unitTimeNumber = goal;changes.isFinish = finish;
      subtaskChanges = {completedCount:progress,isFinish:finish};
      if (Number(attributes(selected).completedCount) !== progress || Number(attributes(selected).isFinish) !== finish) {
        const now = new Date(),date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
        subtaskChanges.recentFinishedTime = `${date} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:00`;
      }
    }
    const parentChanges = changedAttributes(parent,changes);
    let saved = parent,confirmedWrites = 0;
    try {
      if (Object.keys(parentChanges).length) {saved = await client.update('Task',parent.id,parent.version,parentChanges);confirmedWrites++;}
      if (selected) {
        if (editingSubtasks) {
          const currentParent = await fresh(client,'Task',saved,saved.version);
          if (attributes(currentParent).taskContent !== attributes(saved).taskContent || Number(attributes(currentParent).unitTimeNumber) !== Number(attributes(saved).unitTimeNumber)) throw conflict();
        }
        const instanceChanges = changedAttributes(selected,{...(window?.fields || {}),...subtaskChanges});
        if (Object.keys(instanceChanges).length) {selected = await client.update('showTask',selected.id,selected.version,instanceChanges);confirmedWrites++;}
        if (editingSubtasks) {
          await fresh(client,'Task',saved,saved.version);
          const finalSiblings = (await client.list('showTask')).filter(row => businessID(attributes(row).id1) === businessID(attributes(saved).id1));
          if (finalSiblings.length !== 1 || finalSiblings[0].id !== selected.id || String(finalSiblings[0].version) !== String(selected.version)) throw new Error('子计划保存期间执行实例范围已变化，请刷新核查');
        }
        return {...saved,occurrence:selected};
      }
      return saved;
    } catch (error) {
      if (!confirmedWrites && error.status === 409) throw error;
      throw uncertain(error,'待办保存尚待核查，标题/备注、子计划或排期可能已部分提交；请刷新核对后再操作',{confirmedWrites});
    }
  });
}

export function updateList(client,listRecord,patch,{expectedVersion} = {}) {
  return serializeBiandanWrite(client,async () => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !['name','color'].includes(key))) throw new Error('待办单编辑字段无效');
    const current = await fresh(client,'favorites',listRecord,expectedVersion);
    if (businessID(attributes(current).id3) === '1') throw new Error('默认待办单不能编辑');
    const changes = {};
    if (has(patch,'name')) changes.favoritesName = title(patch.name,'待办单名称',200);
    if (has(patch,'color')) changes.favoritesColor = Math.floor(encodedColor(attributes(current).favoritesColor)/100)*100 + color(patch.color);
    return client.update('favorites',current.id,current.version,changes);
  });
}

const deletionScopes = new Set(['occurrence','future_pending','series']);
const canonicalDeletionValue = value => Array.isArray(value) ? value.map(canonicalDeletionValue) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalDeletionValue(value[key])])) : value;
const deletionRecord = row => [String(row.id),String(row.version),attributes(row)];
const sortedDeletionRecords = rows => rows.map(deletionRecord).sort((left,right)=>left[0].localeCompare(right[0]));
const deletionHash = value => signature(canonicalDeletionValue(value));
const unsignedDeletionPlan = plan => Object.fromEntries(Object.entries(plan).filter(([key])=>key!=='fingerprint'));
export async function verifyTaskDeletionPlan(plan) {
  if (!plan || !['task-delete','task-delete-group'].includes(plan.kind) || typeof plan.fingerprint !== 'string' || await deletionHash(unsignedDeletionPlan(plan)) !== plan.fingerprint) throw conflict();
}
export function taskDeletionCutoff(scope,fromDate,cutoff) {
  if (!deletionScopes.has(scope)) throw new Error('请选择本次、指定日期起未完成或整个系列的删除范围');
  if (scope !== 'future_pending') {
    if (fromDate !== undefined && fromDate !== null) throw new Error('起始日期仅适用于指定日期起删除');
    return null;
  }
  if (fromDate !== undefined && fromDate !== null) {
    if (!date(fromDate)) throw new Error('请选择有效的删除起始日期');
    return {date:fromDate,time:'00:00:00'};
  }
  if (cutoff) {
    if (!date(cutoff.date) || clock(cutoff.time) !== cutoff.time) throw new Error('删除预览的截止时刻无效');
    return {date:cutoff.date,time:cutoff.time};
  }
  const now=new Date(),pad=value=>String(value).padStart(2,'0');
  return {date:`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`,time:`${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`};
}
function deletionTargets(targets) {
  if (!Array.isArray(targets) || !targets.length) throw new Error('请选择需要删除的待办');
  const parentId=identity(targets[0]?.parentRecord);
  for (const target of targets) {
    if (!target || identity(target.parentRecord)!==parentId) throw new Error('同一删除计划只能包含一个父待办');
    if ((target.expectedTaskVersion??target.parentRecord?.version)===undefined) throw new Error('删除前请读取父待办版本');
  }
  return parentId;
}
function validateDeletionMembers(rows) {
  const records=new Set(),business=new Set();
  for (const row of rows) {
    const recordId=identity(row),id=businessID(attributes(row).id2);
    if (!id || id==='0' || row.version===undefined || row.version===null || records.has(recordId) || business.has(id)) throw new Error('执行实例身份重复或无法确认，已停止删除');
    records.add(recordId);business.add(id);
  }
}
function deletionProgress(row) {
  const finish=Number(attributes(row).isFinish??0),progress=Number(attributes(row).completedCount??0);
  if (![0,1].includes(finish) || !Number.isSafeInteger(progress)) throw new Error('执行实例完成状态无法确认，请先核查');
  return {finish,progress};
}
async function uniqueDeletionParent(client,parent,taskId) {
  const definitions=(await client.list('Task')).filter(row=>businessID(attributes(row).id1)===taskId);
  if(definitions.length!==1 || definitions[0].id!==parent.id || await deletionHash(deletionRecord(definitions[0]))!==await deletionHash(deletionRecord(parent))) throw conflict();
}
async function buildTaskDeletionPlan(client,targets,{scope='occurrence',fromDate,cutoff,legacy=false,kind='task-delete-group'}={}) {
  deletionTargets(targets);const fixedCutoff=taskDeletionCutoff(scope,fromDate,cutoff);
  const parent=await fresh(client,'Task',targets[0].parentRecord,targets[0].expectedTaskVersion),taskId=businessID(attributes(parent).id1);
  await uniqueDeletionParent(client,parent,taskId);
  const normalizedTargets=[],selectedById=new Map();
  for (const target of targets) {
    if (String(target.expectedTaskVersion??target.parentRecord.version)!==String(parent.version) || businessID(attributes(target.parentRecord).id1)!==taskId) throw conflict();
    let occurrence=null;
    if (target.occurrenceRecord) {
      occurrence=await fresh(client,'showTask',target.occurrenceRecord,target.expectedOccurrenceVersion);
      if (businessID(attributes(occurrence).id1)!==taskId) throw new Error('执行实例不属于所选待办，请刷新核查');
      selectedById.set(occurrence.id,occurrence);
    } else if (scope==='occurrence') throw new Error('删除本次待办前请选择具体执行实例');
    normalizedTargets.push({parentRecord:structuredClone(parent),occurrenceRecord:occurrence?structuredClone(occurrence):null,expectedTaskVersion:parent.version,...(occurrence?{expectedOccurrenceVersion:occurrence.version}:{})});
  }
  const siblings=(await client.list('showTask')).filter(row=>businessID(attributes(row).id1)===taskId).sort((left,right)=>String(left.id).localeCompare(String(right.id)));
  validateDeletionMembers(siblings);
  for (const occurrence of selectedById.values()) {
    const member=siblings.find(row=>row.id===occurrence.id && businessID(attributes(row).id2)===businessID(attributes(occurrence).id2));
    if (!member || String(member.version)!==String(occurrence.version) || await deletionHash(deletionRecord(member))!==await deletionHash(deletionRecord(occurrence))) throw conflict();
  }
  const repeating=number(attributes(parent).isLoop)>0 || number(attributes(parent).loopSet)>0;
  if (scope==='occurrence' && !repeating && (siblings.length!==1 || selectedById.size!==1 || !selectedById.has(siblings[0]?.id))) throw new Error('一次性待办包含额外实例，不能按当前范围删除，请在便单客户端核查');
  let chosen=scope==='occurrence'?siblings.filter(row=>selectedById.has(row.id)):siblings;
  if (scope==='future_pending') chosen=siblings.filter(row=>{
    const {finish}=deletionProgress(row);if (finish)return false;
    const start=attributes(row).startTime,time=attributes(row).validStartTime??'00:00:00';
    if (!date(start)) throw new Error('执行实例日期无效，不能确定后续删除范围');
    const at=clock(time);return start>fixedCutoff.date || start===fixedCutoff.date && at>=fixedCutoff.time;
  });
  chosen.sort((left,right)=>String(left.id).localeCompare(String(right.id)));
  const deletesTaskDefinition=scope==='series' || scope==='occurrence'&&!repeating || scope==='future_pending'&&chosen.length>0&&chosen.length===siblings.length;
  const first=normalizedTargets.find(target=>target.occurrenceRecord)?.occurrenceRecord;
  const plan={kind,scope:legacy&&!repeating?'one-off':scope,requestedScope:scope,legacy,fromDate:fromDate??null,cutoff:fixedCutoff,title:String(attributes(parent).taskTitle||'未命名待办'),taskId,taskRecordId:parent.id,occurrenceId:first?businessID(attributes(first).id2):null,occurrenceRecordId:first?.id??null,occurrenceCount:chosen.length,deletesTaskDefinition,abandonedCount:chosen.filter(row=>deletionProgress(row).progress<0).length,keys:chosen.map(row=>businessID(attributes(row).id2)),parentRecord:structuredClone(parent),members:structuredClone(siblings),selected:structuredClone(chosen),targets:normalizedTargets};
  plan.fingerprint=await deletionHash(plan);return plan;
}
/** A single parent plan merges overlapping selected occurrences. Other tables,
 * attachments, recurrence rules and manual fields are never cleanup targets. */
export function previewTaskDeletionGroup(client,targets,options={}) {return buildTaskDeletionPlan(client,targets,options);}
async function checkDeletionState(client,plan,removed) {
  const parent=await fresh(client,'Task',plan.parentRecord,plan.parentRecord.version);
  if (await deletionHash(deletionRecord(parent))!==await deletionHash(deletionRecord(plan.parentRecord))) throw conflict();
  await uniqueDeletionParent(client,parent,plan.taskId);
  const remaining=(await client.list('showTask')).filter(row=>businessID(attributes(row).id1)===plan.taskId);
  validateDeletionMembers(remaining);
  const expected=plan.members.filter(row=>!removed.has(row.id));
  if (await deletionHash(sortedDeletionRecords(remaining))!==await deletionHash(sortedDeletionRecords(expected))) throw conflict();
  return {parent,remaining};
}
async function executeTaskDeletionPlan(client,plan,{assertTargetAllowed}={}) {
  // A zero-range future preview is a true no-op, unlike the reference MCP's
  // optional aggregate reconciliation. No unrelated parent field is rewritten.
  if (!plan.selected.length && !plan.deletesTaskDefinition) return {...plan,deleted:true,empty:true,removedOccurrences:0,removedTasks:0};
  const removed=new Set();let removedTasks=0;
  const guard=async()=>{if(typeof assertTargetAllowed==='function')for(const target of plan.targets)await assertTargetAllowed(target);};
  await guard();await checkDeletionState(client,plan,removed);
  try {
    for (const occurrence of plan.selected) {
      await guard();await checkDeletionState(client,plan,removed);
      const current=await fresh(client,'showTask',occurrence,occurrence.version);
      if (await deletionHash(deletionRecord(current))!==await deletionHash(deletionRecord(occurrence))) throw conflict();
      await client.remove('showTask',occurrence.id,occurrence.version);removed.add(occurrence.id);
    }
    await guard();const {parent,remaining}=await checkDeletionState(client,plan,removed);
    if (plan.deletesTaskDefinition) {
      if (remaining.length) throw new Error('删除期间出现其他实例，已保留父待办');
      await client.remove('Task',parent.id,parent.version);removedTasks++;
      if ((await client.list('Task')).some(row=>row.id===parent.id || businessID(attributes(row).id1)===plan.taskId)) throw new Error('父待办删除结果尚未确认');
    } else {
      const summary=remaining.length&&!remaining.some(row=>{const state=deletionProgress(row);return !state.finish&&state.progress>=0;})?1:0;
      if (number(attributes(parent).isFinish)!==summary) await client.update('Task',parent.id,parent.version,{isFinish:summary});
    }
    return {...plan,deleted:true,removedOccurrences:removed.size,removedTasks};
  } catch (error) {
    if (!removed.size && !removedTasks && !['unknown','partial'].includes(error.commitState) && error.status>=400 && error.status<500) throw error;
    throw uncertain(error,'删除结果尚待核查，可能已有部分实例删除；请先刷新核对，不会自动重试',{removedOccurrences:removed.size,removedTasks});
  }
}
export function deleteTaskDeletionGroup(client,preview,{assertTargetAllowed}={}) {
  return serializeBiandanWrite(client,async()=>{
    await verifyTaskDeletionPlan(preview);
    const current=await buildTaskDeletionPlan(client,preview.targets,{scope:preview.requestedScope,fromDate:preview.fromDate,cutoff:preview.cutoff,legacy:preview.legacy,kind:preview.kind});
    verifyPreview(preview,current,preview.kind);
    return executeTaskDeletionPlan(client,current,{assertTargetAllowed});
  });
}
export function previewTaskDeletion(client,parentRecord,occurrenceRecord,{expectedTaskVersion,expectedOccurrenceVersion,scope,fromDate}={}) {
  return buildTaskDeletionPlan(client,[{parentRecord,occurrenceRecord,expectedTaskVersion,expectedOccurrenceVersion}],{scope:scope??'occurrence',fromDate,legacy:scope===undefined,kind:'task-delete'});
}
export function deleteTask(client,parentRecord,occurrenceRecord,{preview,expectedTaskVersion,expectedOccurrenceVersion,scope,fromDate,assertTargetAllowed}={}) {
  return serializeBiandanWrite(client,async()=>{
    await verifyTaskDeletionPlan(preview);
    const current=await buildTaskDeletionPlan(client,[{parentRecord,occurrenceRecord,expectedTaskVersion,expectedOccurrenceVersion}],{scope:scope??'occurrence',fromDate,cutoff:preview.cutoff,legacy:scope===undefined,kind:'task-delete'});
    verifyPreview(preview,current,'task-delete');
    return executeTaskDeletionPlan(client,current,{assertTargetAllowed});
  });
}

export async function previewListDeletion(client,listRecord,{expectedVersion,taskAction = 'move_to_default'} = {}) {
  if (taskAction !== 'move_to_default') throw new Error('此入口仅支持保留待办并移到未分类');
  const current = await fresh(client,'favorites',listRecord,expectedVersion);
  const listId = businessID(attributes(current).id3);
  if (listId === '1') throw new Error('默认待办单不能删除');
  const tasks = (await client.list('Task')).filter(row => businessID(attributes(row).id3) === listId);
  if (tasks.length > 100) throw new Error('该待办单超过 100 个任务，请先分批移动任务后再删除');
  if (new Set(tasks.map(row => businessID(attributes(row).id1))).size !== tasks.length) throw new Error('待办单包含重复业务身份，请先核查，未执行删除');
  return {kind:'list-delete',listId,listRecordId:current.id,name:String(attributes(current).favoritesName || '未命名待办单'),taskCount:tasks.length,taskAction,fingerprint:await signature([recordIdentity(current),sortedIdentities(tasks)])};
}

/** Keep every Task and showTask. Only move definition references to id3=1,
 * then delete the custom list after confirming no remaining references. */
export function deleteList(client,listRecord,{preview,expectedVersion,taskAction = 'move_to_default'} = {}) {
  return serializeBiandanWrite(client,async () => {
    const plan = await previewListDeletion(client,listRecord,{expectedVersion,taskAction});
    verifyPreview(preview,plan,'list-delete');
    const current = await fresh(client,'favorites',listRecord,expectedVersion);
    const tasks = (await client.list('Task')).filter(row => businessID(attributes(row).id3) === plan.listId);
    // Recheck the confirmation again after the extra preflight read.
    if (await signature([recordIdentity(current),sortedIdentities(tasks)]) !== plan.fingerprint) throw conflict();
    let movedTasks = 0;
    try {
      for (const row of tasks) {
        const task = await client.get('Task',row.id);
        if (String(task.version) !== String(row.version) || businessID(attributes(task).id3) !== plan.listId) throw conflict();
        await client.update('Task',row.id,row.version,{id3:1});movedTasks++;
      }
      if ((await client.list('Task')).some(row => businessID(attributes(row).id3) === plan.listId)) throw new Error('仍有任务引用待办单，已保留待办单');
      await client.remove('favorites',current.id,current.version);
      if ((await client.list('favorites')).some(row => row.id === current.id || businessID(attributes(row).id3) === plan.listId)) throw new Error('待办单删除尚未确认');
      return {...plan,movedTasks,deleted:true};
    } catch (error) {
      throw uncertain(error,`待办单删除尚待核查，已确认 ${movedTasks} 项待办移到未分类；请刷新核对，未自动重试`,{movedTasks});
    }
  });
}
