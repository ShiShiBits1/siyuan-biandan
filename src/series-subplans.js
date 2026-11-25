import {businessID,decodeContent,encodeTaskContent,serializeBiandanWrite} from './model.js';
import {inspectSubtasks,subtaskGoal,validateSubtaskPatch} from './subtasks.js';

const MAX_INSTANCES = 500;
const has = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const integerColumns = new Set(['id1','id2','id3','isCollectible','isImportant','isUrgency','isLoop','haveNoTime','unitTimeNumber','loopSet','loopBaseNumber','loopUnit','duration','isRemind','isFinish','completedCount']);
const metadataKeys = new Set(['title','remark','attachments','important','urgent','collectible','listId']);
const parentKeys = new Set(['taskContent','unitTimeNumber','isFinish','taskTitle','isCollectible','isImportant','isUrgency','id3']);
const hashPattern = /^[a-f0-9]{64}$/;
const versionOf = record => {
  const value = record?.version;
  if (!['string','number'].includes(typeof value) || !String(value).trim() || String(value).length > 200) throw new Error('系列记录版本无法确认');
  return String(value);
};
function canonical(value) {
  if (value === null || ['string','boolean'].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (object(value)) return '{'+Object.keys(value).sort().map(key => JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  throw new Error('系列记录包含无法确认的JSON值');
}
async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value)))),value => value.toString(16).padStart(2,'0')).join('');
}
function normalizedAttributes(attributes) {
  if (!object(attributes)) throw new Error('系列记录属性无法确认');
  return Object.fromEntries(Object.entries(attributes).map(([key,value]) => {
    if (integerColumns.has(key) && (typeof value === 'number' && Number.isSafeInteger(value) || typeof value === 'string' && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)))) return [key,Number(value)];
    return [key,value];
  }));
}
const attributesHash = record => digest(normalizedAttributes(record.attributes));
function ensureIdentity(record,kind,taskId,recordId,businessId) {
  if (!object(record) || typeof record.id !== 'string' || !record.id || !object(record.attributes)) throw new Error('系列记录身份无法确认');
  versionOf(record);
  if (recordId !== undefined && record.id !== recordId) throw new Error('系列云记录身份发生变化');
  const parentId = businessID(record.attributes.id1),own = businessID(record.attributes[kind === 'Task' ? 'id1' : 'id2']);
  if (!parentId || parentId === '0' || !own || own === '0' || taskId !== undefined && parentId !== taskId || businessId !== undefined && own !== businessId) throw new Error('系列业务身份无法确认');
  return own;
}
const conflict = message => Object.assign(new Error(message || '系列或执行实例已在其他客户端变化，请重新预览后确认'),{status:409,code:'SERIES_CONFLICT'});
function stopped(signal) {
  if (signal?.aborted) throw Object.assign(new Error('已停止后续系列更新；已确认结果保留，请核查后继续'),{name:'AbortError',code:'SERIES_STOPPED'});
}
function sourceRef(operation) {return {kind:operation.kind,id:operation.id,businessId:operation.businessId,beforeVersion:operation.beforeVersion,beforeHash:operation.beforeHash};}
const scopeInput = entry => ({taskId:entry.taskId,parent:sourceRef(entry.parent),instances:entry.instances.map(sourceRef),subtasks:entry.subtasks});
const intentInput = entry => ({scopeFingerprint:entry.scopeFingerprint,title:entry.title,stats:entry.stats,parent:{afterHash:entry.parent.afterHash,changes:entry.parent.changes},instances:entry.instances.map(operation => ({id:operation.id,afterHash:operation.afterHash,changes:operation.changes}))});
const publicPlan = entry => ({kind:'series-subplans',scope:'series',fingerprint:entry.fingerprint,scopeFingerprint:entry.scopeFingerprint,taskRecordId:entry.parent.id,taskId:entry.taskId,title:entry.title,subtasks:clone(entry.subtasks),stats:clone(entry.stats)});

/** Explicit, resumable whole-series migrations. No operation runs on load or
 * during pending/reconcile reads. Only the confirmed target fields are saved
 * in the local intent; unrelated source attributes are represented by hashes. */
export function createSeriesSubplanEditor({client,loadPending,savePending} = {}) {
  if (!client || typeof loadPending !== 'function' || typeof savePending !== 'function') throw new Error('系列子计划检查配置不完整');
  const previews = new Map();

  async function readJournal() {
    const value = await loadPending();
    if (value === null || value === undefined) return {version:1,entry:null};
    if (!object(value) || value.version !== 1 || !has(value,'entry') || value.entry !== null && !object(value.entry)) throw new Error('系列子计划恢复日志无效，已停止写入并保留原文件');
    if (!value.entry) return {version:1,entry:null};
    const entry = clone(value.entry);
    if (!hashPattern.test(entry.fingerprint) || !hashPattern.test(entry.scopeFingerprint) || !businessID(entry.taskId) || typeof entry.title !== 'string' || entry.title.length > 500 || !Array.isArray(entry.instances) || !entry.instances.length || entry.instances.length > MAX_INSTANCES || !Array.isArray(entry.subtasks) || !object(entry.stats)) throw new Error('系列子计划恢复日志无效，已保留原文件');
    if (!object(entry.parent) || entry.parent.kind !== 'Task' || !Array.isArray(entry.progress?.instances) || !object(entry.progress?.parent)) throw new Error('系列子计划恢复步骤无效');
    const operations = [entry.parent,...entry.instances];
    for (const operation of operations) {
      if (!object(operation) || !['Task','showTask'].includes(operation.kind) || typeof operation.id !== 'string' || !operation.id || !businessID(operation.businessId) || !hashPattern.test(operation.beforeHash) || !hashPattern.test(operation.afterHash) || typeof operation.beforeVersion !== 'string' || !operation.beforeVersion || !object(operation.changes)) throw new Error('系列子计划恢复步骤无效');
      const keys = Object.keys(operation.changes);
      if (keys.some(key => operation.kind === 'Task' ? !parentKeys.has(key) : !['completedCount','isFinish'].includes(key))) throw new Error('恢复步骤包含不允许改动的字段');
    }
    if (entry.parent.businessId !== entry.taskId || entry.instances.some(operation => operation.kind !== 'showTask') || new Set(operations.map(operation => operation.kind+':'+operation.id)).size !== operations.length || new Set(entry.instances.map(operation => operation.businessId)).size !== entry.instances.length) throw new Error('恢复日志包含重复或不匹配身份');
    if (entry.progress.instances.length !== entry.instances.length || entry.progress.instances.some((step,index) => !object(step) || step.id !== entry.instances[index].id || !['pending','inflight','confirmed'].includes(step.phase)) || !['pending','inflight','confirmed'].includes(entry.progress.parent.phase)) throw new Error('恢复进度无法确认');
    if (await digest(scopeInput(entry)) !== entry.scopeFingerprint || await digest(intentInput(entry)) !== entry.fingerprint) throw new Error('系列子计划恢复意图已变化，已保留原文件');
    return {version:1,entry};
  }
  async function persist(journal) {
    const intended = clone(journal);
    await savePending(clone(intended));
    const stored = await loadPending();
    if (canonical(stored) !== canonical(intended)) throw new Error('系列恢复日志保存未确认，已停止后续写入');
  }
  function localSummary(entry) {
    return entry ? {fingerprint:entry.fingerprint,taskRecordId:entry.parent.id,taskId:entry.taskId,total:entry.instances.length,confirmed:entry.progress.instances.filter(step => step.phase === 'confirmed').length,parentConfirmed:entry.progress.parent.phase === 'confirmed',status:'pending'} : null;
  }
  async function pendingLocal() {return localSummary((await readJournal()).entry);}

  async function readScope(entry,{sourceOnly = false} = {}) {
    const parent = await client.get('Task',entry.parent.id);
    ensureIdentity(parent,'Task',entry.taskId,entry.parent.id,entry.taskId);
    const parentHash = await attributesHash(parent);
    const parentKnown = parentHash === entry.parent.afterHash || parentHash === entry.parent.beforeHash && versionOf(parent) === entry.parent.beforeVersion;
    if (!parentKnown) throw conflict('当前账号中的系列内容与待恢复记录不一致；已保留本机记录，未显示旧内容或写入');
    const [parents,allInstances] = await Promise.all([client.list('Task'),client.list('showTask')]);
    const matches = parents.filter(row => businessID(row.attributes?.id1) === entry.taskId);
    if (matches.length !== 1 || matches[0].id !== parent.id) throw conflict('父任务业务身份不唯一，已停止系列更新');
    const siblings = allInstances.filter(row => businessID(row.attributes?.id1) === entry.taskId);
    if (siblings.length !== entry.instances.length || siblings.some(row => !entry.instances.some(operation => operation.id === row.id))) throw conflict('系列执行实例范围已变化，请先核查，未扩大写入范围');
    const records = new Map([['Task:'+parent.id,parent]]),states = new Map();
    async function classify(operation,record,step) {
      ensureIdentity(record,operation.kind,entry.taskId,operation.id,operation.businessId);
      const hash = await attributesHash(record),version = versionOf(record);
      if (sourceOnly) {
        if (hash !== operation.beforeHash || version !== operation.beforeVersion) throw conflict();
        return 'source';
      }
      if (hash === operation.afterHash) return 'target';
      if (hash === operation.beforeHash && version === operation.beforeVersion && step.phase !== 'confirmed') return 'source';
      throw conflict('部分记录已有后续人工修改，已停止续写，不会覆盖');
    }
    states.set('Task:'+parent.id,await classify(entry.parent,parent,entry.progress.parent));
    for (let index = 0; index < entry.instances.length; index++) {
      const operation = entry.instances[index];
      const duplicates = allInstances.filter(row => businessID(row.attributes?.id2) === operation.businessId);
      if (duplicates.length !== 1 || duplicates[0].id !== operation.id || businessID(duplicates[0].attributes?.id1) !== entry.taskId) throw conflict('执行实例业务身份不唯一，已停止系列更新');
      const record = await client.get('showTask',operation.id);
      records.set('showTask:'+record.id,record);
      states.set('showTask:'+record.id,await classify(operation,record,entry.progress.instances[index]));
    }
    // A second version/membership pass closes changes that occurred while the
    // bounded full series was being read. It does not claim a cross-table lock.
    const [lastParent,lastInstances] = await Promise.all([client.get('Task',parent.id),client.list('showTask')]);
    if (versionOf(lastParent) !== versionOf(parent) || await attributesHash(lastParent) !== parentHash) throw conflict();
    const lastSiblings = lastInstances.filter(row => businessID(row.attributes?.id1) === entry.taskId);
    if (lastSiblings.length !== entry.instances.length || lastSiblings.some(row => {
      const known = records.get('showTask:'+row.id);
      return !known || versionOf(row) !== versionOf(known) || businessID(row.attributes?.id2) !== businessID(known.attributes.id2);
    })) throw conflict('读取期间系列实例或版本发生变化，请重新核查');
    for (const operation of entry.instances) if (lastInstances.filter(row => businessID(row.attributes?.id2) === operation.businessId).length !== 1) throw conflict('执行实例业务身份不唯一');
    return {parent,records,states};
  }

  async function metadataChanges(parent,patch) {
    if (!object(patch) || Object.keys(patch).some(key => !metadataKeys.has(key))) throw new Error('系列预览只支持子计划和普通属性；排期或重复规则未改动');
    const changes = {};
    if (has(patch,'title')) {
      if (typeof patch.title !== 'string' || !patch.title.trim() || patch.title.trim().length > 500 || /[\x00-\x1f\x7f]/.test(patch.title)) throw new Error('请输入不超过500字的待办名称');
      changes.taskTitle = patch.title.trim();
    }
    for (const [input,column] of [['important','isImportant'],['urgent','isUrgency'],['collectible','isCollectible']]) {
      if (!has(patch,input)) continue;
      if (typeof patch[input] !== 'boolean') throw new Error('待办标志必须为勾选状态');
      changes[column] = +patch[input];
    }
    if (has(patch,'listId')) {
      const listId = businessID(patch.listId);
      if (!listId || listId === '0' || !Number.isSafeInteger(Number(listId))) throw new Error('待办单身份无效');
      if (listId !== '1' && (await client.list('favorites')).filter(row => businessID(row.attributes?.id3) === listId).length !== 1) throw new Error('找不到唯一的待办单，请重新选择');
      changes.id3 = Number(listId);
    }
    return changes;
  }
  async function operation(kind,record,changes) {
    const before = normalizedAttributes(record.attributes),after = normalizedAttributes({...record.attributes,...changes});
    const actualChanges = Object.fromEntries(Object.entries(changes).filter(([key,value]) => canonical(normalizedAttributes({[key]:value})[key]) !== canonical(before[key] ?? null)));
    return {kind,id:record.id,businessId:ensureIdentity(record,kind),beforeVersion:versionOf(record),beforeHash:await digest(before),afterHash:await digest(after),changes:actualChanges};
  }
  async function preview(parentRecord,subtaskPlan,{expectedVersion,occurrence,expectedOccurrenceVersion,patch = {}} = {}) {
    if ((await readJournal()).entry) throw new Error('已有待核查的系列更新，请先核查并继续');
    const recordId = parentRecord?.id,expected = expectedVersion ?? parentRecord?.version;
    if (typeof recordId !== 'string' || expected === undefined || expected === null || !occurrence || typeof occurrence.id !== 'string') throw new Error('系列预览前请先读取任务和所选执行实例版本');
    const parent = await client.get('Task',recordId),taskId = ensureIdentity(parent,'Task');
    if (versionOf(parent) !== String(expected) || parentRecord.attributes && businessID(parentRecord.attributes.id1) !== taskId) throw conflict();
    const loop = Number(parent.attributes.isLoop),loopSet = Number(parent.attributes.loopSet);
    if (!Number.isSafeInteger(loop) || !Number.isSafeInteger(loopSet) || loop < 0 || loopSet < 0 || !(loop > 0 || loopSet > 0)) throw new Error('此入口仅用于重复或习惯待办的整个系列');
    const [parents,allInstances] = await Promise.all([client.list('Task'),client.list('showTask')]);
    if (parents.filter(row => businessID(row.attributes?.id1) === taskId).length !== 1) throw new Error('父任务业务身份不唯一，未进行系列更新');
    const siblings = allInstances.filter(row => businessID(row.attributes?.id1) === taskId).sort((a,b) => a.id.localeCompare(b.id));
    if (!siblings.length || siblings.length > MAX_INSTANCES) throw new Error(`系列实例数量须为1–${MAX_INSTANCES}，没有截断或分批冒充全系列`);
    if (new Set(siblings.map(row => row.id)).size !== siblings.length) throw new Error('系列存在重复云记录身份');
    const oldSubtasks = decodeContent(parent.attributes.taskContent).subtasks,subtasks = validateSubtaskPatch(subtaskPlan,oldSubtasks.length),goal = subtaskGoal(subtasks.length);
    const stats = {total:siblings.length,completed:0,abandoned:0,reopened:0,newCompleted:0,changed:0,added:subtasks.filter(step => step.sourceIndex === null).length,removed:oldSubtasks.length-new Set(subtasks.filter(step => step.sourceIndex !== null).map(step => step.sourceIndex)).size,renamed:subtasks.filter(step => step.sourceIndex !== null && step.title !== oldSubtasks[step.sourceIndex]).length};
    const instances = [],targetStates = [];
    let selectedFound = false;
    for (const row of siblings) {
      const record = await client.get('showTask',row.id),businessId = ensureIdentity(record,'showTask',taskId,row.id);
      if (versionOf(record) !== versionOf(row) || await attributesHash(record) !== await attributesHash(row) || allInstances.filter(item => businessID(item.attributes?.id2) === businessId).length !== 1) throw conflict('实例身份或版本不唯一，请重新预览');
      if (record.id === occurrence.id) {
        selectedFound = true;
        if (versionOf(record) !== String(expectedOccurrenceVersion ?? occurrence.version) || occurrence.attributes && (businessID(occurrence.attributes.id1) !== taskId || businessID(occurrence.attributes.id2) !== businessId)) throw conflict();
      }
      const state = inspectSubtasks(parent.attributes,record.attributes);
      if (!state.canEditSeries) throw new Error(state.reason || '系列包含无法确认的子计划进度，整批未写入');
      const abandoned = Number(record.attributes.completedCount) === -1,oldFinish = Number(record.attributes.isFinish);
      let progress = Number(record.attributes.completedCount),finish = oldFinish;
      if (abandoned) stats.abandoned++;
      else {
        if (oldFinish === 1) stats.completed++;
        progress = subtasks.length ? Number(subtasks.reduce((mask,step,index) => step.sourceIndex !== null && state.completed[step.sourceIndex] ? mask | (1n << BigInt(index)) : mask,0n)*100n) : oldFinish;
        finish = +(progress === goal);
        if (oldFinish === 1 && finish === 0) stats.reopened++;
        if (oldFinish === 0 && finish === 1) stats.newCompleted++;
        if (progress !== Number(record.attributes.completedCount) || finish !== oldFinish) stats.changed++;
      }
      instances.push(await operation('showTask',record,abandoned ? {} : {completedCount:progress,isFinish:finish}));
      targetStates.push({abandoned,finish});
    }
    if (!selectedFound) throw new Error('所选实例不属于当前系列');
    const changes = await metadataChanges(parent,patch);
    changes.taskContent = encodeTaskContent(parent.attributes.taskContent,{...(has(patch,'remark') ? {remark:patch.remark} : {}),...(has(patch,'attachments') ? {attachments:patch.attachments} : {}),subtasks:subtasks.map(step => step.title)});
    changes.unitTimeNumber = goal;
    changes.isFinish = targetStates.some(state => !state.abandoned && state.finish === 0) ? 0 : 1;
    const parentOperation = await operation('Task',parent,changes);
    const entry = {taskId,title:String(parent.attributes.taskTitle || '未命名待办'),subtasks,stats,parent:parentOperation,instances,progress:{parent:{phase:parentOperation.beforeHash === parentOperation.afterHash ? 'confirmed' : 'pending'},instances:instances.map(operation => ({id:operation.id,phase:operation.beforeHash === operation.afterHash ? 'confirmed' : 'pending'}))}};
    entry.scopeFingerprint = await digest(scopeInput(entry));
    entry.fingerprint = await digest(intentInput(entry));
    await readScope(entry,{sourceOnly:true});
    previews.set(entry.fingerprint,clone(entry));
    if (previews.size > 10) previews.delete(previews.keys().next().value);
    return publicPlan(entry);
  }

  function details(entry,inspection) {
    const confirmed = [...inspection.states].filter(([key,state]) => key.startsWith('showTask:') && state === 'target').length;
    const parentConfirmed = inspection.states.get('Task:'+entry.parent.id) === 'target',remaining = entry.instances.length-confirmed;
    return {status:'ready',fingerprint:entry.fingerprint,taskRecordId:entry.parent.id,taskId:entry.taskId,title:entry.title,total:entry.instances.length,confirmed,remaining,parentConfirmed,remainingRecords:remaining + +!parentConfirmed,canResume:true,reason:'核查后可继续尚未完成的确定目标；不会回滚人工修改',stats:clone(entry.stats)};
  }
  async function reconcile() {
    const entry = (await readJournal()).entry;
    if (!entry) return null;
    // No old task title, counts or contents are exposed until the current
    // authenticated cloud parent matches a known source or target fingerprint.
    try {
      const parent = await client.get('Task',entry.parent.id);
      ensureIdentity(parent,'Task',entry.taskId,entry.parent.id,entry.taskId);
      const hash = await attributesHash(parent);
      if (!(hash === entry.parent.afterHash || hash === entry.parent.beforeHash && versionOf(parent) === entry.parent.beforeVersion)) return {status:'unavailable',canResume:false,reason:'当前账号或系列内容无法核实，已保留恢复记录，未显示旧内容'};
      try {return details(entry,await readScope(entry));}
      catch {return {status:'conflict',fingerprint:entry.fingerprint,taskRecordId:entry.parent.id,taskId:entry.taskId,title:entry.title,total:entry.instances.length,canResume:false,reason:'系列范围、身份或记录已有后续变化；未覆盖，请先核查'};}
    } catch {return {status:'unavailable',canResume:false,reason:'当前账号或连接尚无法核实恢复记录，未显示旧内容'};}
  }
  const pending = () => reconcile();
  function progress(entry,phase,callback) {
    if (typeof callback !== 'function') return;
    try {callback({fingerprint:entry.fingerprint,total:entry.instances.length,confirmed:entry.progress.instances.filter(step => step.phase === 'confirmed').length,phase});} catch {/* Display callbacks cannot change the committed cloud result. */}
  }
  async function execute(entry,{signal,onProgress} = {}) {
    const journal = {version:1,entry};
    let inspection = await readScope(entry);
    stopped(signal);
    progress(entry,'parent',onProgress);
    const operations = [entry.parent,...entry.instances];
    const steps = [entry.progress.parent,...entry.progress.instances];
    for (let index = 0; index < operations.length; index++) {
      stopped(signal);
      const operation = operations[index],step = steps[index];
      // The complete source set is checked at entry and completion. Before
      // each write, independently read this record and the shared definition;
      // this stays linear in series size and never writes an unconfirmed row.
      const currentParent = await client.get('Task',entry.parent.id);
      ensureIdentity(currentParent,'Task',entry.taskId,entry.parent.id,entry.taskId);
      const currentParentHash = await attributesHash(currentParent);
      if (!(currentParentHash === entry.parent.afterHash || currentParentHash === entry.parent.beforeHash && versionOf(currentParent) === entry.parent.beforeVersion)) throw conflict('系列定义已有后续修改，已停止续写');
      if (index > 0 && currentParentHash !== entry.parent.afterHash) throw conflict('系列定义尚未达到确认目标，已停止实例更新');
      const source = operation.kind === 'Task' ? currentParent : await client.get('showTask',operation.id);
      ensureIdentity(source,operation.kind,entry.taskId,operation.id,operation.businessId);
      const sourceHash = await attributesHash(source);
      const state = sourceHash === operation.afterHash ? 'target' : sourceHash === operation.beforeHash && versionOf(source) === operation.beforeVersion && step.phase !== 'confirmed' ? 'source' : 'conflict';
      if (state === 'conflict') throw conflict('部分记录已有后续人工修改，已停止续写，不会覆盖');
      if (state === 'target') {
        if (step.phase !== 'confirmed') {step.phase = 'confirmed';await persist(journal);}
        progress(entry,index ? 'instances' : 'parent',onProgress);continue;
      }
      if (step.phase === 'confirmed') throw conflict('已确认记录不再匹配目标，已停止续写');
      step.phase = 'inflight';await persist(journal);stopped(signal);
      // An unknown prior PATCH is retried only inside this explicit apply or
      // user-triggered resume, using the same fully checked source/baseversion.
      await client.update(operation.kind,operation.id,versionOf(source),clone(operation.changes));
      const saved = await client.get(operation.kind,operation.id);
      ensureIdentity(saved,operation.kind,entry.taskId,operation.id,operation.businessId);
      if (await attributesHash(saved) !== operation.afterHash) throw new Error('系列更新返回结果与确定目标不一致，请核查后继续');
      step.phase = 'confirmed';await persist(journal);
      progress(entry,index ? 'instances' : 'parent',onProgress);
    }
    stopped(signal);progress(entry,'finalizing',onProgress);
    inspection = await readScope(entry);
    if ([...inspection.states.values()].some(state => state !== 'target')) throw new Error('系列尚未全部达到已确认目标');
    await persist({version:1,entry:null});previews.delete(entry.fingerprint);progress(entry,'complete',onProgress);
    return {applied:true,fingerprint:entry.fingerprint,total:entry.instances.length,confirmed:entry.instances.length,parent:inspection.parent,occurrences:entry.instances.map(operation => inspection.records.get('showTask:'+operation.id))};
  }
  function migrationError(error,entry) {
    const confirmed = entry.progress.instances.filter(step => step.phase === 'confirmed').length,parentConfirmed = entry.progress.parent.phase === 'confirmed';
    return Object.assign(new Error(error?.code === 'SERIES_STOPPED' ? error.message : '系列更新尚待核查，已保留本机恢复记录；请核查并继续，不会自动重发或回滚'),{cause:error,code:error?.code || 'SERIES_PENDING',status:error?.status,commitState:confirmed || parentConfirmed ? 'partial' : 'unknown',fingerprint:entry.fingerprint,confirmed,total:entry.instances.length});
  }
  function apply(previewPlan,options = {}) {
    return serializeBiandanWrite(client,async () => {
      if ((await readJournal()).entry) throw new Error('已有待核查的系列更新，请先核查并继续');
      const entry = previews.get(previewPlan?.fingerprint);
      if (!entry || previewPlan.kind !== 'series-subplans' || previewPlan.scope !== 'series' || previewPlan.scopeFingerprint !== entry.scopeFingerprint) throw conflict('预览已失效，请重新预览并明确确认整个系列');
      const intended = clone(entry);
      stopped(options.signal);
      await readScope(intended,{sourceOnly:true});
      stopped(options.signal);
      await persist({version:1,entry:intended});
      try {return await execute(intended,options);} catch (error) {throw migrationError(error,intended);}
    });
  }
  function resume({fingerprint,signal,onProgress} = {}) {
    return serializeBiandanWrite(client,async () => {
      const entry = (await readJournal()).entry;
      if (!entry || fingerprint !== entry.fingerprint) throw conflict('恢复记录已变化，请重新核查后确认');
      stopped(signal);
      try {return await execute(entry,{signal,onProgress});} catch (error) {throw migrationError(error,entry);}
    });
  }
  return {preview,apply,pendingLocal,pending,reconcile,resume};
}
