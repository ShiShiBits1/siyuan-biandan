const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const count=value=>Number.isSafeInteger(value)&&value>=0;
const statFields=[['total','涉及执行','次'],['changed','进度需调整','次'],['completed','当前已完成','次'],['abandoned','已放弃，保留','次'],['reopened','将重新打开','次'],['newCompleted','将转为完成','次'],['added','新增子计划','项'],['removed','移除子计划','项'],['renamed','改名子计划','项']];

export function checkedSeriesPreview(value) {
  if(!value||value.kind!=='series-subplans'||value.scope!=='series'||typeof value.fingerprint!=='string'||!value.fingerprint||typeof value.scopeFingerprint!=='string'||!value.scopeFingerprint||typeof value.title!=='string'||!value.stats||statFields.some(([key])=>!count(value.stats[key])))throw new Error('尚未核实整个系列的影响范围，请重新预览，未执行修改。');
  return value;
}
export function seriesPreviewHTML(preview,pendingFiles=[]) {
  const p=checkedSeriesPreview(preview),s=p.stats;
  return `<header><h3>确认修改整个系列</h3><span>${escape(p.title)}</span></header><p class="bd-series-scope-note">此次修改覆盖整个系列，包含已完成和历史执行记录。</p><dl class="bd-series-stats">${statFields.map(([key,label,unit])=>`<div><dt>${label}</dt><dd>${s[key]}<small>${unit}</small></dd></div>`).join('')}</dl>${s.reopened?`<p class="bd-series-reopen">将重新打开 ${s.reopened} 次已完成或历史执行记录。新增子计划默认为未完成。</p>`:'<p class="bd-series-preserve">新增子计划默认为未完成；已放弃状态和最近完成时间会保留。</p>'}${pendingFiles.length?`<div class="bd-series-files"><p>确认后还将上传 ${pendingFiles.length} 个思源附件：</p><ul>${pendingFiles.map(name=>`<li>${escape(name)}</li>`).join('')}</ul></div>`:''}<p class="bd-series-progress" data-series-progress role="status">尚未修改云端。返回修改可保留当前草稿。</p><div class="bd-series-actions"><button type="button" data-action="series-preview-back">返回修改</button><button type="button" class="bd-primary" data-action="series-confirm">确认修改整个系列</button><button type="button" data-action="series-stop" hidden>停止后续处理</button><button type="button" data-action="inspect-series-migrations" hidden>核查已保存结果</button></div>`;
}
export function checkedSeriesPending(value) {
  if(value===null||value===undefined)return {status:'none'};
  if(value.status==='none')return {status:'none'};
  if(!['ready','conflict'].includes(value.status))return {status:'unavailable'};
  if(typeof value.fingerprint!=='string'||!value.fingerprint||typeof value.taskRecordId!=='string'||!value.taskRecordId||typeof value.taskId!=='string'||!value.taskId||typeof value.title!=='string')return {status:'unavailable'};
  if(value.status==='conflict')return {...value,total:count(value.total)?value.total:null,confirmed:count(value.confirmed)?value.confirmed:null,remaining:count(value.remaining)?value.remaining:null,canResume:false};
  if(!count(value.total)||!count(value.confirmed)||!count(value.remaining)||value.confirmed>value.total||value.remaining>value.total)return {status:'unavailable'};
  return {...value,canResume:value.canResume===true};
}
export function checkedSeriesApplied(value,fingerprint) {
  if(value?.applied!==true||value.fingerprint!==fingerprint||!count(value.total)||!count(value.confirmed)||value.confirmed!==value.total)throw new Error('整个系列的保存结果尚未完整核实，请先核查已保存结果，勿重复提交。');
  return value;
}
export function seriesPendingHTML(value) {
  const pending=checkedSeriesPending(value);
  if(pending.status==='none')return '<p class="bd-series-empty">当前账号没有已核实的未完成系列调整。</p><button type="button" data-action="series-reconcile">重新核查</button>';
  if(pending.status==='unavailable')return '<p class="bd-series-empty">当前账号暂时无法核实该记录。已保留本机进度，未执行云端修改。</p><button type="button" data-action="series-reconcile">重新核查</button>';
  const shown=value=>count(value)?`${value}<small>次</small>`:'<small>待核查</small>';
  return `<h3 class="bd-series-recovery-title">${escape(pending.title)}</h3><p class="bd-series-scope-note">继续上次已确认的整个系列调整。</p><dl class="bd-series-stats"><div><dt>涉及执行</dt><dd>${shown(pending.total)}</dd></div><div><dt>已确认保存</dt><dd>${shown(pending.confirmed)}</dd></div><div><dt>尚待确认</dt><dd>${shown(pending.remaining)}</dd></div></dl>${pending.reason?`<p class="bd-series-preserve">${escape(pending.reason)}</p>`:''}<p class="bd-series-preserve">先核查已保存结果，再继续尚未确认的修改；不会新建待办或回滚其他客户端的更改。</p><p class="bd-series-progress" data-series-recovery-progress role="status"></p><div class="bd-series-actions"><button type="button" data-action="series-reconcile">核查已保存结果</button><button type="button" class="bd-primary" data-action="series-resume" ${pending.canResume?'':'disabled'}>核查并继续</button><button type="button" data-action="series-stop" hidden>停止后续处理</button></div>`;
}
export function seriesProgressText(value) {
  const phase={parent:'保存系列定义',instances:'更新执行记录',finalizing:'核对整个系列',complete:'核对完成'}[value?.phase]||'核查已保存结果';
  return count(value?.total)&&count(value?.confirmed)&&value.confirmed<=value.total?`${phase} · 已确认 ${value.confirmed}/${value.total} 次执行。`:phase+'…';
}
