const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const deletionScopes=[['occurrence','仅选中的这次安排'],['future_pending','指定日期起的未完成安排'],['series','整个待办系列（含历史记录）']];
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const validRows=(rows,statuses)=>Array.isArray(rows)&&rows.every(row=>row&&typeof row.key==='string'&&typeof row.title==='string'&&statuses.includes(row.status));
export function checkedBatchPreview(value){
  if(!value||value.kind!=='task-delete-batch'||!deletionScopes.some(([key])=>key===value.scope)||!integer(value.total)||!value.total||!validRows(value.rows,['ready','merged','empty','error'])||value.rows.length!==value.total||new Set(value.rows.map(row=>row.key)).size!==value.total||!value.counts||typeof value.fingerprint!=='string'||!value.fingerprint)throw new Error('批量删除范围未能确认，请重新预览。');
  for(const key of ['targets','groups','ready','merged','empty','failed','occurrences','taskDefinitions','abandoned'])if(!integer(value.counts[key]))throw new Error('删除范围统计未能确认，请重新预览。');
  if(value.rows.some(row=>!integer(row.occurrenceCount)||typeof row.deletesTaskDefinition!=='boolean'))throw new Error('删除范围明细未能确认，请重新预览。');
  for(const [field,status]of [['ready','ready'],['merged','merged'],['empty','empty'],['failed','error']])if(value.counts[field]!==value.rows.filter(row=>row.status===status).length)throw new Error('删除范围计数与明细不一致，请重新预览。');
  if(value.counts.targets!==value.total)throw new Error('删除目标数量未能确认，请重新预览。');
  return value;
}
export function checkedBatchResult(value,total,{running=false}={}){
  if(!value||value.kind!=='task-delete-batch-result'||!validRows(value.rows,[...(running?['pending']:[]),'merged','empty','error','deleted','unknown','skipped'])||value.rows.length!==total||new Set(value.rows.map(row=>row.key)).size!==total||!value.counts||typeof value.requiresRecheck!=='boolean'||typeof value.stopped!=='boolean')throw new Error('批量删除结果未获确认，请刷新核查，勿重复提交。');
  for(const key of ['total','deleted','failed','unknown','merged','empty','skipped','removedOccurrences','removedTasks'])if(!integer(value.counts[key]))throw new Error('批量删除结果统计未获确认，请刷新核查。');
  if(value.counts.total!==total||value.total!==total)throw new Error('批量删除目标数量未获确认，请刷新核查。');
  for(const [field,status]of [['deleted','deleted'],['failed','error'],['unknown','unknown'],['merged','merged'],['empty','empty'],['skipped','skipped']])if(value.counts[field]!==value.rows.filter(row=>row.status===status).length)throw new Error('删除结果计数与明细不一致，请刷新核查。');
  if(value.counts.unknown&&!value.requiresRecheck)throw new Error('未知结果未明确核查状态，请刷新核查。');
  return value;
}
export function scopeControls(scope,fromDate,{single=false,disabled=false}={}){
  return `<fieldset class="bd-delete-scope"><legend>删除范围</legend><label>处理范围<select name="${single?'single-':'batch-'}delete-scope" ${disabled?'disabled':''}>${deletionScopes.map(([value,label])=>`<option value="${value}" ${scope===value?'selected':''}>${label}</option>`).join('')}</select></label><label data-delete-date ${scope==='future_pending'?'':'hidden'}>起始日期<input type="date" name="${single?'single-':'batch-'}delete-date" value="${escape(fromDate)}" ${disabled?'disabled':''}></label><p class="bd-form-hint">改变范围后将重新预览，确认前不执行删除。</p></fieldset>`;
}
const labels={ready:'待处理',pending:'等待处理',merged:'合并处理',empty:'无符合范围的记录',error:'未执行 · 错误',deleted:'已删除',unknown:'结果待核查',skipped:'未执行'};
function rowsHTML(rows,{unconfirmed=false}={}){return `<ol class="bd-delete-rows">${rows.map(row=>`<li data-delete-result="${escape(row.status)}"><div><strong>${escape(row.title||'未命名待办')}</strong><span>${unconfirmed&&row.status==='pending'?'结果未获确认':labels[row.status]||'待核查'}${row.status==='merged'&&row.groupStatus?` · ${labels[row.groupStatus]||'待核查'}`:''}</span></div>${integer(row.occurrenceCount)?`<p>${row.occurrenceCount} 次执行记录${row.deletesTaskDefinition?'，包含待办定义':''}${integer(row.abandonedCount)&&row.abandonedCount?`，含 ${row.abandonedCount} 次已放弃安排`:''}</p>`:''}${row.error?`<p class="bd-form-error">${escape(row.error)}</p>`:''}</li>`).join('')}</ol>`;}
export function previewHTML(plan){
  const count=plan.counts;
  return `<div class="bd-delete-summary"><strong>将删除 ${count.occurrences} 次执行记录</strong><span>${count.taskDefinitions} 个待办定义 · ${count.merged} 项合并 · ${count.empty} 项无符合记录${count.failed?` · ${count.failed} 项无法处理`:''}</span><span>其中包含 ${count.abandoned} 次已放弃安排。</span></div>${plan.cutoff?`<p class="bd-form-hint">本次预览的时间截点：${escape(plan.cutoff.date)} ${escape(plan.cutoff.time)}。确认时按此范围核对。</p>`:''}${rowsHTML(plan.rows)}<p class="bd-form-hint">删除后无法在插件内撤销。附件原资源与已有专注记录保留。</p>`;
}
export function resultHTML(result,{running=false,unconfirmed=false}={}){
  const c=result.counts;
  return `<div class="bd-delete-summary" role="status"><strong>${running?'正在处理所选项目':unconfirmed?'本次结果未获确认，请刷新核查':result.requiresRecheck?'结果待核查，已停止后续处理':result.stopped?'已停止后续处理':'批量处理已结束'}</strong><span>已删除 ${c.deleted} 项 · 错误 ${c.failed} 项 · 待核查 ${c.unknown} 项 · 未执行 ${c.skipped} 项</span><span>确认删除 ${c.removedOccurrences} 次记录、${c.removedTasks} 个待办定义</span></div>${result.requiresRecheck?'<p class="bd-form-error">部分结果尚未确认，请先刷新核查。不会自动重复删除。</p>':''}${rowsHTML(result.rows,{unconfirmed})}`;
}
