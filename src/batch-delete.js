import {businessID} from './model.js';
import {previewTaskDeletionGroup,deleteTaskDeletionGroup,verifyTaskDeletionPlan,taskDeletionCutoff} from './operations.js';

const clone=value=>structuredClone(value);
const attributes=row=>row?.attributes||{};
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const withoutFingerprint=value=>Object.fromEntries(Object.entries(value).filter(([key])=>key!=='fingerprint'));
async function hash(value){const bytes=new TextEncoder().encode(JSON.stringify(canonical(value)));return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');}
const conflict=()=>Object.assign(new Error('批量删除预览已变化，请重新核对并确认'),{status:409});
const message=error=>error?.message||'此项删除范围未能确认，请刷新后重新选择';
function countPreview(rows,groups){return {targets:rows.length,groups:groups.length,ready:rows.filter(row=>row.status==='ready').length,merged:rows.filter(row=>row.status==='merged').length,empty:rows.filter(row=>row.status==='empty').length,failed:rows.filter(row=>row.status==='error').length,occurrences:rows.reduce((sum,row)=>sum+row.occurrenceCount,0),taskDefinitions:rows.filter(row=>row.deletesTaskDefinition).length,abandoned:rows.reduce((sum,row)=>sum+row.abandonedCount,0)};}
function validateTargets(targets){
  if(!Array.isArray(targets)||!targets.length)throw new Error('请至少选择一项待办再预览删除');
  for(const target of targets){
    if(!target||typeof target.parentRecord?.id!=='string'||!target.parentRecord.id.trim()||!businessID(attributes(target.parentRecord).id1)||(target.expectedTaskVersion??target.parentRecord.version)===undefined)throw new Error('所选待办身份或版本无效，请刷新后重新选择');
  }
}
/** Preview every input, while grouping a shared parent so overlapping targets
 * never delete/reconcile the same record twice. Twenty is a processing chunk,
 * not a limit on the total selection. No official runtime is bundled here. */
export async function previewBatchTaskDeletion(client,targets,{scope='occurrence',fromDate,assertTargetAllowed}={}){
  validateTargets(targets);const captured=clone(targets),cutoff=taskDeletionCutoff(scope,fromDate),grouped=new Map(),groups=[],rows=Array(captured.length);
  captured.forEach((target,index)=>{const key=target.parentRecord.id;if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push({target,index});});
  const entries=[...grouped];
  for(let offset=0;offset<entries.length;offset+=20){
    for(const [groupKey,items] of entries.slice(offset,offset+20)){
      try{
        if(typeof assertTargetAllowed==='function')for(const item of items)await assertTargetAllowed(item.target);
        const plan=await previewTaskDeletionGroup(client,items.map(item=>item.target),{scope,fromDate,cutoff}),owners=new Map();
        const selectedByBusiness=new Map(plan.selected.map(row=>[businessID(attributes(row).id2),row]));
        for(const {target,index} of items){
          const targetKey=scope==='occurrence'?businessID(attributes(target.occurrenceRecord).id2):groupKey;
          const mergedInto=owners.get(targetKey),merged=mergedInto!==undefined;if(!merged)owners.set(targetKey,index);
          const chosen=merged?[]:scope==='occurrence'?[selectedByBusiness.get(targetKey)].filter(Boolean):plan.selected;
          const deletesTaskDefinition=!merged&&plan.deletesTaskDefinition;
          rows[index]={key:String(index),index,title:plan.title,scope,fromDate:plan.fromDate,occurrenceCount:chosen.length,deletesTaskDefinition,abandonedCount:chosen.filter(row=>Number(attributes(row).completedCount??0)<0).length,keys:chosen.map(row=>businessID(attributes(row).id2)),groupKey,status:merged?'merged':chosen.length||deletesTaskDefinition?'ready':'empty',...(merged?{mergedInto}:{})};
        }
        groups.push({groupKey,rowIndexes:items.map(item=>item.index),plan});
      }catch(error){for(const {target,index}of items)rows[index]={key:String(index),index,title:String(attributes(target.parentRecord).taskTitle||'未命名待办'),scope,fromDate:fromDate??null,occurrenceCount:0,deletesTaskDefinition:false,abandonedCount:0,keys:[],groupKey,status:'error',error:message(error),...(Number.isInteger(error?.status)?{errorStatus:error.status}:{})};}
    }
  }
  const preview={kind:'task-delete-batch',scope,fromDate:fromDate??null,cutoff,total:captured.length,rows,counts:countPreview(rows,groups),groups};preview.fingerprint=await hash(preview);return preview;
}
function resultCounts(rows,removedOccurrences,removedTasks){return {total:rows.length,deleted:rows.filter(row=>row.status==='deleted').length,failed:rows.filter(row=>row.status==='error').length,unknown:rows.filter(row=>row.status==='unknown').length,merged:rows.filter(row=>row.status==='merged').length,empty:rows.filter(row=>row.status==='empty').length,skipped:rows.filter(row=>row.status==='skipped').length,removedOccurrences,removedTasks};}
/** Each group takes the existing client write lock itself. Holding that lock
 * around this loop would deadlock its nested per-group queue. A stop finishes
 * the active group, then prevents all following groups; nothing is rolled back. */
export async function deleteTaskBatch(client,preview,{signal,onProgress,assertTargetAllowed}={}){
  let accepted;try{accepted=clone(preview);}catch{throw conflict();}
  if(accepted?.kind!=='task-delete-batch'||typeof accepted.fingerprint!=='string'||await hash(withoutFingerprint(accepted))!==accepted.fingerprint||!Array.isArray(accepted.rows)||!Array.isArray(accepted.groups)||accepted.total!==accepted.rows.length)throw conflict();
  // Check the complete opaque confirmation before the first business write,
  // even when the tampered group would otherwise appear late in the batch.
  for(const group of accepted.groups)await verifyTaskDeletionPlan(group.plan);
  const rows=accepted.rows.map(row=>({...row,status:row.status==='ready'?'pending':row.status,groupStatus:row.status==='error'?'error':'pending'}));
  let removedOccurrences=0,removedTasks=0,stopped=false,requiresRecheck=false;
  const snapshot=()=>({kind:'task-delete-batch-result',rows:clone(rows),counts:resultCounts(rows,removedOccurrences,removedTasks),stopped,requiresRecheck,processed:rows.filter(row=>row.groupStatus!=='pending').length,total:rows.length,chunkSize:20});
  const emit=()=>{if(typeof onProgress==='function')try{const pending=onProgress(snapshot());if(pending?.then)void Promise.resolve(pending).catch(()=>{});}catch{/* Presentation failures do not replay or reinterpret cloud writes. */}};
  function finishGroup(group,status,error){for(const index of group.rowIndexes){const row=rows[index];row.groupStatus=status;if(!['merged','empty'].includes(row.status))row.status=status;if(error){row.error=message(error);if(Number.isInteger(error.status))row.errorStatus=error.status;}}}
  function skipRemaining(start,reason){for(const group of accepted.groups.slice(start))finishGroup(group,'skipped',new Error(reason));}
  emit();
  for(let offset=0;offset<accepted.groups.length;offset+=20){
    for(let index=offset;index<Math.min(offset+20,accepted.groups.length);index++){
      const group=accepted.groups[index];
      if(signal?.aborted){stopped=true;skipRemaining(index,'已停止后续删除，之前确认的结果保留');emit();return snapshot();}
      try{
        const outcome=await deleteTaskDeletionGroup(client,group.plan,{assertTargetAllowed});
        removedOccurrences+=outcome.removedOccurrences;removedTasks+=outcome.removedTasks;
        finishGroup(group,outcome.empty?'empty':'deleted');
      }catch(error){
        if(['unknown','partial'].includes(error?.commitState)){
          if(Number.isSafeInteger(error.removedOccurrences)&&error.removedOccurrences>0)removedOccurrences+=error.removedOccurrences;
          if(Number.isSafeInteger(error.removedTasks)&&error.removedTasks>0)removedTasks+=error.removedTasks;
          stopped=true;requiresRecheck=true;finishGroup(group,'unknown',error);skipRemaining(index+1,'前一组删除结果需核查，未执行本组');emit();return snapshot();
        }
        // Read/preflight failures and explicitly rejected writes have no
        // confirmed mutation in this group; report them and continue others.
        finishGroup(group,'error',error);
      }
      emit();
    }
  }
  return snapshot();
}
