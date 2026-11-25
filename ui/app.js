import {icon} from './icons.js';
import {brandIcon} from './brand.js';
import {businessID,decodeContent} from '../src/model.js';
import {ATTACHMENT_ACCEPT,MAX_ATTACHMENT_COUNT,MAX_ATTACHMENT_BYTES,parseManagedAttachments,getSiyuanAssetURL} from '../src/attachments.js';
import {renderSafeMarkdown} from './markdown.js';
import {reconcileHTML} from './reconcile.js';
import {createAttachmentDraft,formatBytes} from './attachment-draft.js';
import {MAX_SUBTASKS,inspectSubtasks,validateSubtaskTitles} from '../src/subtasks.js';
import {checkedSeriesPreview,seriesPreviewHTML,checkedSeriesPending,seriesPendingHTML,seriesProgressText,checkedSeriesApplied} from './series-view.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const attrs = record => record?.attributes || record || {};
const id = businessID;
const dateText = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const today = () => dateText(new Date());
const navigation = [['day','今日','sun'],['all','全部待办','list'],['calendar','日历','calendar'],['quadrant','四象限','grid'],['habits','习惯打卡','habit'],['focus','专注','timer']];
const emptySnapshot = () => ({tasks:[],occurrences:[],lists:[],focus:[]});
const quadrantDefinitions=[['重要且紧急','1:1','red'],['重要不紧急','1:0','amber'],['紧急不重要','0:1','blue'],['不重要且不紧急','0:0','green']];
const palette=['#84734b','#d84b43','#df8429','#c79c18','#5a9a58','#319a91','#479bc0','#5474be','#a06ab0','#b46c67','#bb8b55','#ae9b4e','#7a9c73','#5d9c94','#729cb1','#7b8eb5','#9d83ab','#ad7772','#b6966e','#aaa06b','#8d9f82','#7c9c95','#829fa9','#909bb2','#a18eaa'];
function normalizeDate(value) {
  const match=String(value ?? '').match(/^(\d{4}-\d{2}-\d{2})(?:$|[ T])/);if(!match)return '';
  const date=new Date(match[1]+'T12:00:00');return Number.isNaN(date.getTime())||dateText(date)!==match[1]?'':match[1];
}
function remarkOf(task) {
  const content=decodeContent(task.taskContent),managed=parseManagedAttachments(content.remark);
  return managed.invalid?content.remark:managed.remark;
}

/** Render cloud data without creating a second local task database. */
export function mountBiandanApp(host, options = {}) {
  const doc = host.ownerDocument;
  const win = doc.defaultView;
  const hadHostClass = host.classList.contains('bd-plugin-host');
  host.classList.add('bd-plugin-host');
  host.innerHTML = `<div class="bd-app"><aside class="bd-nav" aria-label="便单导航"><div class="bd-brand"><img src="${escape(brandIcon)}" alt="" width="36" height="36"><div><strong>便单伴侣</strong><small>思源 · 第三方客户端</small></div></div><nav></nav><div class="bd-nav__foot"><button data-action="connect">${icon('cloud')}连接便单</button><button data-action="settings">${icon('settings')}连接设置</button></div></aside><div class="bd-lists"><div class="bd-lists__title"><h2>待办单</h2><button data-action="new-list" title="新建待办单" aria-label="新建待办单">${icon('plus')}</button></div><div class="bd-lists__items"></div><div class="bd-source"><span class="bd-source__dot"></span><span data-sync-text>尚未连接云端</span></div></div><main class="bd-main"><header class="bd-top"><div><div class="bd-top__date"></div><h1>今日</h1></div><div class="bd-top__actions"><button class="bd-nav-toggle" data-action="navigation" aria-label="展开导航" aria-expanded="false">${icon('list')}</button><button class="bd-series-recovery-button" data-action="inspect-series-migrations" aria-label="核查未完成的系列调整" title="核查未完成的系列调整">${icon('important')}</button><button data-action="refresh" aria-label="刷新便单" title="刷新便单">${icon('refresh')}</button></div></header><div class="bd-feedback" role="status" hidden></div><div class="bd-body"></div></main><button class="bd-fab" data-action="new-task" aria-label="新建待办" title="新建待办">${icon('plus')}</button><aside class="bd-editor" aria-label="待办编辑" tabindex="-1" hidden></aside></div>`;
  const root = host.querySelector('.bd-app');
  const body = root.querySelector('.bd-body');
  const listHost = root.querySelector('.bd-lists__items');
  const feedback = root.querySelector('.bd-feedback');
  const editor = root.querySelector('.bd-editor');
  let snapshot = emptySnapshot(), ready = false, disposed = false, loading = false, stale = false, syncing=false,viewUpdatePending=false;
  let generation = 0, view = 'day', listFilter = 'all', selectedDate = today(), month = today().slice(0,7);
  let writeBusy = false, editorOpen = false, feedbackMessage = '', statusFilter='pending';
  let editorTarget=null,deletePreview=null,editorGeneration=0,draggingId='',focusBeforeEditor=null,editorDirty=false;
  let attachmentDraft=null,attachmentInvalid=false,nativeAttachmentCount=0,uploadAbort=null,uploading=false,attachmentPreviewKey='',previewFocus=null;
  let subplanDraft=null,subplanSequence=0;
  const collapsedSubplans=new Set();
  let seriesPreview=null,seriesAbort=null,seriesPreviewGeneration=0,recoveryState=null,recoveryGeneration=0;
  let affectedSeriesTask=null,seriesMarkerKnown=typeof options.onSeriesAffectedTask!=='function',seriesMarkerGeneration=0;
  const timer = {minutes:25, remaining:25*60, running:false, deadline:0, startedAt:0, elapsed:0, related:'', saved:false};
  const taskMap = () => new Map((snapshot.tasks || []).map(record => [id(attrs(record).id1),record]).filter(([key])=>key));
  function seriesTaskLocked(record) {
    if(!seriesMarkerKnown)return true;
    return Boolean(affectedSeriesTask&&record?.id===affectedSeriesTask.taskRecordId&&id(attrs(record).id1)===affectedSeriesTask.taskId);
  }
  async function refreshSeriesMarker({renderView=true}={}) {
    if(typeof options.onSeriesAffectedTask!=='function')return;
    const generation=++seriesMarkerGeneration;
    try{
      const marker=await options.onSeriesAffectedTask();
      if(disposed||generation!==seriesMarkerGeneration)return;
      if(marker!==null&&marker!==undefined&&(typeof marker.taskRecordId!=='string'||!marker.taskRecordId||!id(marker.taskId)||id(marker.taskId)==='0'))throw new Error('未确认系列状态');
      affectedSeriesTask=marker?{taskRecordId:marker.taskRecordId,taskId:id(marker.taskId)}:null;seriesMarkerKnown=true;
    }catch{if(disposed||generation!==seriesMarkerGeneration)return;seriesMarkerKnown=false;}
    if(renderView)render();else updateEditorSeriesLock();
  }
  function lockSeriesTarget(target) {
    if(typeof options.onSeriesAffectedTask!=='function')return;
    affectedSeriesTask={taskRecordId:target.taskRecordId,taskId:id(target.taskId)};seriesMarkerKnown=true;render();
  }
  function updateEditorSeriesLock() {
    const section=editor.querySelector('[data-subplan-editor]');if(!section||!editorTarget?.item||!subplanDraft)return;
    const locked=seriesTaskLocked(editorTarget.record);
    if(locked&&seriesMarkerKnown)subplanDraft.wasSeriesLocked=true;
    if(!locked&&!subplanDraft.wasSeriesLocked){
      const previous=subplanDraft.lockRestore;if(!previous)return;
      section.removeAttribute('data-series-state-lock');section.querySelector('[data-subplan-progress]').textContent=previous.progress;section.querySelector('[data-subplan-edit-hint]').textContent=previous.hint;
      section.querySelector('[data-subplan-draft-list]').hidden=previous.hidden;const label=section.querySelector('.bd-subplan-new');if(label)label.hidden=previous.newHidden;
      section.querySelector('[data-action="add-subplan"]').disabled=previous.addDisabled||writeBusy;
      for(const [button,disabled]of previous.footer)if(button.isConnected)button.disabled=disabled||writeBusy||viewUpdatePending;
      section.querySelector('[data-editor-series-inspect]')?.remove();
      if(previous.focus?.isConnected&&(!doc.activeElement||doc.activeElement===doc.body)){previous.focus.focus();if(previous.selection&&typeof previous.focus.setSelectionRange==='function')previous.focus.setSelectionRange(...previous.selection);}
      subplanDraft.lockRestore=null;return;
    }
    if(!subplanDraft.lockRestore){const focus=section.contains(doc.activeElement)?doc.activeElement:null;subplanDraft.lockRestore={progress:section.querySelector('[data-subplan-progress]').textContent,hint:section.querySelector('[data-subplan-edit-hint]').textContent,hidden:section.querySelector('[data-subplan-draft-list]').hidden,newHidden:Boolean(section.querySelector('.bd-subplan-new')?.hidden),addDisabled:section.querySelector('[data-action="add-subplan"]').disabled,footer:[...editor.querySelectorAll('form>footer button[type="submit"]')].map(button=>[button,button.disabled]),focus,selection:focus&&typeof focus.selectionStart==='number'?[focus.selectionStart,focus.selectionEnd]:null};}
    section.setAttribute('data-series-state-lock','');
    section.querySelector('[data-subplan-progress]').textContent=locked?'完成状态待核查':'请重新打开核对';
    section.querySelector('[data-subplan-draft-list]').hidden=true;section.querySelector('.bd-subplan-new')?.setAttribute('hidden','');
    section.querySelector('[data-action="add-subplan"]').disabled=true;
    section.querySelector('[data-subplan-edit-hint]').textContent=locked?'该系列调整尚未全部确认，暂不显示完成进度。当前草稿保留，请先核查。':'系列状态已更新。当前草稿保留，请重新打开待办核对子计划结构。';
    if(!section.querySelector('[data-editor-series-inspect]'))section.insertAdjacentHTML('beforeend','<button type="button" class="bd-series-editor-inspect" data-editor-series-inspect data-action="inspect-series-migrations">核查系列调整</button>');
    for(const button of editor.querySelectorAll('form>footer button[type="submit"]'))button.disabled=true;
  }

  function entries() {
    const parents = taskMap();
    return (snapshot.occurrences || []).map(record => {
      const instance = attrs(record), parentRecord = parents.get(id(instance.id1));
      if (!parentRecord) return null;
      const task = attrs(parentRecord);
      return {record, instance, task, parentRecord, id:id(instance.id2), title:task.taskTitle || '未命名待办', done:Number(instance.isFinish)===1, abandoned:Number(instance.completedCount)<0,stateLocked:seriesTaskLocked(parentRecord)};
    }).filter(Boolean);
  }
  function selectedEntries() {
    return entries().filter(item => {
      const task = item.task;
      if (item.abandoned) return false;
      if (listFilter==='favorite') return Number(task.isCollectible)===1;
      if (listFilter==='important') return Number(task.isImportant)===1;
      if (listFilter==='unclassified') return Number(task.id3 || 1)<=1;
      return listFilter==='all' || id(task.id3)===listFilter;
    });
  }
  function onDate(item, date) {
    if(Number(item.task.haveNoTime)===1)return false;
    // An instance's own range takes precedence over the whole series. An
    // explicit invalid value is not a missing field and must not expand it.
    const start=normalizeDate(item.instance.startTime??item.task.startTime);
    const end=normalizeDate(item.instance.endTime??item.task.endTime);
    return Boolean(start&&end&&start<=date&&end>=date);
  }
  function notify(message = '', error = false) {
    feedbackMessage = message;
    feedback.textContent = message;
    feedback.hidden = !message;
    feedback.dataset.error = String(error);
  }
  function authenticationRequired(error) {
    return error?.code==='AUTH_REQUIRED'||error?.code==='reauthorization_required';
  }
  function clearAccount() {
    ++seriesMarkerGeneration;affectedSeriesTask=null;seriesMarkerKnown=typeof options.onSeriesAffectedTask!=='function';
    ready=false;stale=false;syncing=false;viewUpdatePending=false;snapshot=emptySnapshot();listFilter='all';
    timer.running=false;timer.deadline=0;timer.startedAt=0;timer.elapsed=0;timer.remaining=timer.minutes*60;timer.related='';timer.saved=false;
    disposeSeriesState();disposeAttachments();subplanDraft=null;collapsedSubplans.clear();editorOpen=false;editorTarget=null;deletePreview=null;editorDirty=false;++editorGeneration;editor.hidden=true;editor.replaceChildren();root.classList.remove('bd-app--editor-open');
  }
  function controls() {
    root.querySelectorAll('[data-action="new-task"],[data-action="new-list"],[data-action="complete"],[data-action="edit-task"],[data-action="delete-task"],[data-action="edit-list"],[data-action="delete-list"]').forEach(button => button.disabled = !ready || writeBusy||viewUpdatePending||Boolean(seriesPreview));
    root.querySelectorAll('[data-action="complete-subplan"]').forEach(button=>button.disabled=!ready||writeBusy||viewUpdatePending||Boolean(seriesPreview)||button.dataset.available!=='true');
    if(!seriesMarkerKnown)root.querySelectorAll('[data-action="new-task"],[data-action="new-list"],[data-action="complete"],[data-action="complete-subplan"],[data-action="edit-task"],[data-action="delete-task"],[data-action="edit-list"],[data-action="delete-list"]').forEach(button=>button.disabled=true);
    const currentItems=new Map(entries().map(item=>[item.id,item]));
    root.querySelectorAll('[data-action="complete"],[data-action="delete-task"]').forEach(button=>{if(currentItems.get(button.dataset.id)?.stateLocked)button.disabled=true;});
    root.querySelectorAll('[data-action="inspect-series-migrations"]').forEach(button=>button.disabled=!ready||writeBusy||Boolean(seriesPreview&&seriesPreview.status!=='error'));
    const recoveryButton=root.querySelector('.bd-series-recovery-button');if(recoveryButton)recoveryButton.hidden=typeof options.onSeriesPending!=='function';
    root.setAttribute('aria-busy',String(loading||writeBusy));
    root.querySelectorAll('[draggable]').forEach(card=>card.setAttribute('draggable',String(ready&&!writeBusy&&!viewUpdatePending&&!seriesPreview)));
    root.querySelector('[data-action="refresh"]').disabled = loading || syncing || writeBusy||Boolean(seriesPreview);
    root.querySelectorAll('[data-action="connect"]').forEach(button=>button.disabled=loading||writeBusy||Boolean(seriesPreview));
    root.querySelector('[data-sync-text]').textContent = loading||syncing ? ready?'正在同步 · 保留当前内容':'正在读取便单…' : ready ? stale?'刷新失败 · 显示上次读取':'便单云端 · 已读取' : '尚未连接云端';
    root.querySelector('.bd-source').dataset.ready = String(ready);
    root.querySelector('.bd-source').dataset.stale = String(stale);
  }
  function renderNavigation() {
    reconcileHTML(root.querySelector('nav'),navigation.map(([key,label,glyph]) => `<button data-view="${key}" aria-current="${view===key?'page':'false'}">${icon(glyph)}<span>${label}</span>${view===key?'<span class="bd-nav__mark"></span>':''}</button>`).join(''));
    const specials = [['all','全部待办','folder'],['unclassified','未分类','folder'],['favorite','我的收藏','star'],['important','重要待办','important']];
    const lists = (snapshot.lists || []).map(record => attrs(record)).sort((a,b) => Number(a.favoritesColor || 0)-Number(b.favoritesColor || 0));
    reconcileHTML(listHost,`<div class="bd-list-group">${specials.map(([key,label,glyph]) => `<button data-list="${key}" aria-pressed="${listFilter===key}">${icon(glyph)}<span>${label}</span></button>`).join('')}</div><div class="bd-list-group">${lists.filter(list => Number(list.id3)>1).map(list => `<div class="bd-list-row" data-list-row="${escape(id(list.id3))}"><button data-list="${escape(id(list.id3))}" aria-pressed="${listFilter===id(list.id3)}"><span class="bd-list-color" style="--bd-list-color:${listColor(list.favoritesColor)}">${icon('folder')}</span><span>${escape(list.favoritesName || '未命名清单')}</span></button><button class="bd-list-edit" data-action="edit-list" data-list-id="${escape(id(list.id3))}" aria-label="编辑待办单：${escape(list.favoritesName||'未命名清单')}" title="编辑待办单">${icon('more')}</button></div>`).join('')}${ready?`<button data-action="new-list">${icon('plus')}<span>添加待办单</span></button>`:''}</div>`);
  }
  function listColor(value) {
    const index = Number(value || 0)%100;
    return palette[Number.isInteger(index)&&index>=0&&index<palette.length?index:0];
  }
  function titleForView() {
    return navigation.find(([key]) => key===view)?.[1] || '今日';
  }
  function taskRow(item) {
    const task = item.task, instance = item.instance;
    const dated = Number(task.haveNoTime)!==1;
    const start=normalizeDate(instance.startTime)||normalizeDate(task.startTime);
    const clock=instance.validStartTime||task.validStartTime||'';
    const time = dated ? `${start||'日期未设置'} ${clock==='00:00:00'?'全天':String(clock).slice(0,5)}` : '未安排日期';
    const urgency = Number(task.isImportant)===1 && Number(task.isUrgency)===1;
    const content=remarkOf(task), draggable=view==='quadrant';
    const completeControl=item.stateLocked?`<span class="bd-task__state-unknown" aria-label="完成状态待核查">${icon('important')}</span>`:`<button class="bd-task__check" data-action="complete" data-id="${escape(item.id)}" aria-label="${item.done?'撤销完成':'完成'}：${escape(item.title)}" aria-pressed="${item.done}" ${writeBusy?'disabled':''}>${item.done?icon('check'):''}</button>`;
    return `<article class="bd-task ${item.done&&!item.stateLocked?'bd-task--done':''}" data-occurrence="${escape(item.id)}" ${draggable?`draggable="${!writeBusy}"`:''}>${draggable?`<button class="bd-task__drag" data-action="move-task" data-id="${escape(item.id)}" aria-label="移动待办：${escape(item.title)}" title="拖到另一象限；也可点击后选择象限">${icon('grip')}</button>`:''}${completeControl}<div class="bd-task__content"><button class="bd-task__title" data-action="edit-task" data-id="${escape(item.id)}" title="编辑待办">${escape(item.title)}</button><div class="bd-task__meta">${urgency?'<span class="bd-urgent">重要且紧急</span>':Number(task.isImportant)===1?'<span class="bd-important">重要</span>':''}${Number(task.isCollectible)===1?`<span title="已收藏">${icon('star')}</span>`:''}<span>${escape(time)}</span></div>${content?`<div class="bd-task__note bd-markdown">${renderSafeMarkdown(doc,content,options.renderMarkdown)}</div>`:''}${taskAttachments(item)}${cardSubplans(item)}</div><div class="bd-task__actions"><button data-action="edit-task" data-id="${escape(item.id)}" aria-label="编辑待办：${escape(item.title)}" title="编辑">${icon('edit')}</button><button data-action="delete-task" data-id="${escape(item.id)}" aria-label="删除待办：${escape(item.title)}" title="删除">${icon('trash')}</button></div></article>`;
  }
  function subplanState(item) {
    const state=inspectSubtasks(item.task,item.instance);
    if(seriesTaskLocked(item.parentRecord))return {...state,canToggle:false,canEdit:false,canEditSeries:false,reason:'该系列的完成状态待核查，请先核查未完成的系列调整。',stateLocked:true};
    if(state.canEdit&&snapshot.occurrences.filter(record=>id(attrs(record).id1)===id(item.task.id1)).length!==1)return {...state,canEdit:false,reason:'当前待办包含多个执行实例，子计划结构请在便单客户端修改。'};
    return state;
  }
  function cardSubplans(item) {
    if(item.stateLocked)return '<div class="bd-series-state-lock" data-series-state-lock><span>完成状态待核查</span><button type="button" data-action="inspect-series-migrations">核查系列调整</button></div>';
    const state=subplanState(item);if(!state.total)return '';
    const progress=state.canToggle?`${state.doneCount}/${state.total}`:'状态待核查';
    return `<details class="bd-subplans" data-subplans="${escape(item.id)}" ${collapsedSubplans.has(item.id)?'':'open'}><summary>子计划 <span>${progress}</span></summary><div class="bd-subplans__items">${state.subtasks.slice(0,MAX_SUBTASKS).map((title,index)=>`<div class="bd-subplans__row ${state.completed[index]?'bd-subplans__row--done':''}"><button type="button" class="bd-subplan-check" data-action="complete-subplan" data-id="${escape(item.id)}" data-subplan-index="${index}" data-available="${state.canToggle}" aria-label="${state.completed[index]?'撤销完成子计划':'完成子计划'}：${escape(title)}" aria-pressed="${state.completed[index]}" ${!state.canToggle||writeBusy||viewUpdatePending?'disabled':''}>${state.completed[index]?icon('check'):''}</button><span>${escape(title)}</span></div>`).join('')}</div><p class="bd-subplans__hint">${state.canToggle?'全部步骤完成后，待办会自动完成。':escape(state.reason||'已有子计划保持原样，请在便单客户端核查。')}</p></details>`;
  }
  function empty(message = '这里还没有待办') {
    return `<div class="bd-empty">${icon('check')}<h2>${message}</h2><p>把下一步记下来，留出专心做事的空间。</p><button class="bd-primary" data-action="new-task">${icon('plus')}新建待办</button></div>`;
  }
  function taskGroups(items,filter='all') {
    const pending = items.filter(item => !item.stateLocked&&!item.done), complete = items.filter(item => !item.stateLocked&&item.done),unknown=items.filter(item=>item.stateLocked);
    const notice=unknown.length?`<section class="bd-task-group bd-task-group--unknown"><header><h2>完成状态待核查</h2></header>${unknown.map(taskRow).join('')}</section>`:'';
    if(filter==='completed')return `${complete.length||!unknown.length?`<section class="bd-task-group"><header><h2>已完成 <span>${complete.length}</span></h2></header>${complete.length?complete.map(taskRow).join(''):empty('还没有已完成的待办')}</section>`:''}${notice}`;
    return `${pending.length||!unknown.length?`<section class="bd-task-group"><header><h2>待完成 <span>${pending.length}</span></h2></header>${pending.length?pending.map(taskRow).join(''):empty('这一页已经清空')}</section>`:''}${notice}${filter==='all'&&complete.length?`<details class="bd-completed"><summary>已完成 <span>${complete.length}</span></summary>${complete.map(taskRow).join('')}</details>`:''}`;
  }
  function allTasks(items) {
    const unknown=items.filter(item=>item.stateLocked).length;
    return `<div class="bd-filter-bar"><label>状态<select name="status-filter" aria-label="待办状态筛选"><option value="pending" ${statusFilter==='pending'?'selected':''}>未完成</option><option value="all" ${statusFilter==='all'?'selected':''}>全部状态</option><option value="completed" ${statusFilter==='completed'?'selected':''}>已完成</option></select></label><span>${items.filter(item=>!item.stateLocked&&(statusFilter==='all'||item.done===(statusFilter==='completed'))).length} 项${unknown?` · ${unknown} 项待核查`:''}</span></div>${taskGroups(items,statusFilter)}`;
  }
  function welcome() {
    return `<section class="bd-welcome"><div class="bd-welcome__symbol">${icon('cloud')}</div><h2>让便单，留在你的工作现场</h2><p>连接后，在思源里查看清单、安排日期和开始专注。<br>数据来自你授权的便单账号。</p><button class="bd-primary" data-action="connect">${icon('cloud')}连接便单账号</button><small>独立第三方客户端 · 不会导入示例任务到你的账号</small></section>`;
  }
  function daily(items) {
    const chosen = items.filter(item => onDate(item,today()));
    const known=chosen.filter(item=>!item.stateLocked),unknown=chosen.length-known.length,done=known.filter(item=>item.done).length,pending=known.length-done,allUnknown=unknown&&!known.length;
    return `<div class="bd-day-brief"><div><p>今天，按自己的节奏来</p><h2>${allUnknown?'正在核查今日完成状态':pending ? `${pending} 件事，逐一完成` : known.length ? '今天的安排，已完成' : '留一点空白，给今天'}</h2><span>${allUnknown?'待核查记录未计入完成进度':known.length?`已完成 ${done} / ${known.length} 项`:'可以从一件小事开始'}</span></div><div class="bd-day-completion" aria-label="${allUnknown?'完成状态待核查':`完成率 ${known.length?Math.round(done/known.length*100):0}%`}"><span>${allUnknown?'—':`${known.length?Math.round(done/known.length*100):0}<small>%</small>`}</span><span>${allUnknown?'待核查':'完成进度'}</span></div></div>${unknown?'<p class="bd-quiet bd-day-undated">部分系列执行状态待核查，未计入完成进度。</p>':''}${items.some(item=>Number(item.task.haveNoTime)===1)?'<p class="bd-quiet bd-day-undated">未安排日期的待办不计入今日，可在全部待办安排日期。</p>':''}${taskGroups(chosen)}`;
  }
  function calendar(items) {
    const [year,mon]=month.split('-').map(Number), first=new Date(year,mon-1,1), offset=(first.getDay()+6)%7;
    const start=new Date(year,mon-1,1-offset);
    const cells=Array.from({length:42},(_,index)=>{
      const date=new Date(start);date.setDate(start.getDate()+index);const key=dateText(date), dayItems=items.filter(item=>Number(item.task.haveNoTime)!==1&&onDate(item,key));
      const unknown=dayItems.some(item=>item.stateLocked);
      return `<button type="button" class="bd-calendar__day ${date.getMonth()!==mon-1?'bd-calendar__day--outside':''} ${key===today()?'bd-calendar__day--today':''}" data-date="${key}" tabindex="${selectedDate===key?'0':'-1'}" aria-pressed="${selectedDate===key}" aria-label="${key}，${dayItems.length}项待办"><span>${date.getDate()}</span><span class="bd-calendar__previews">${dayItems.slice(0,2).map(item=>`<span class="${item.done&&!item.stateLocked?'is-done':''}" title="${escape(item.title)}">${escape(item.title)}</span>`).join('')}</span>${dayItems.length?`<small>${unknown?'含待核查':`${dayItems.filter(item=>!item.done).length} 未完成`}</small>`:''}</button>`;
    });
    return `<section class="bd-calendar"><header><h2>${year}<span> / </span>${String(mon).padStart(2,'0')}</h2><div><button data-action="month-prev" aria-label="上个月">${icon('arrow')}</button><button data-action="today">今天</button><button data-action="month-next" aria-label="下个月">${icon('arrow')}</button></div></header><div class="bd-calendar__week">${['一','二','三','四','五','六','日'].map(day=>`<span>周${day}</span>`).join('')}</div><div class="bd-calendar__grid">${cells.join('')}</div></section><section class="bd-day-agenda"><h2>${escape(selectedDate)} 的安排</h2>${taskGroups(items.filter(item=>Number(item.task.haveNoTime)!==1&&onDate(item,selectedDate)))}</section>`;
  }
  function quadrants(items) {
    return `<p class="bd-quadrant-help">拖动待办到另一象限，或点击拖动手柄选择象限。修改会同步该待办的所有执行实例。</p><div class="bd-quadrants">${quadrantDefinitions.map(([label,key,color])=>{const rows=items.filter(item=>(item.stateLocked||!item.done)&&`${Number(item.task.isImportant)===1?1:0}:${Number(item.task.isUrgency)===1?1:0}`===key);return `<section class="bd-quadrant bd-quadrant--${color}" data-quadrant="${key}" aria-label="${label}"><header><h2>${label}</h2><span>${rows.some(item=>item.stateLocked)?'含待核查':rows.length}</span></header>${rows.length?rows.map(taskRow).join(''):'<p class="bd-quiet">可将待办拖到这里。</p>'}</section>`;}).join('')}</div>`;
  }
  function habits(items) {
    const habitIDs=[...new Set(items.filter(item=>Number(item.task.isLoop)>=2).map(item=>id(item.task.id1)))];
    if(!habitIDs.length)return `<div class="bd-empty">${icon('habit')}<h2>你的习惯，会在这里积累</h2><p>在便单中创建的习惯，连接后会显示执行记录。</p></div>`;
    return `<div class="bd-habits">${habitIDs.map(taskID=>{const instances=items.filter(item=>id(item.task.id1)===taskID),complete=instances.filter(item=>!item.stateLocked&&item.done),current=instances.find(item=>onDate(item,selectedDate)),unknown=instances.some(item=>item.stateLocked);return `<section class="bd-habit"><header><div><h2>${escape(instances[0].title)}</h2><p>${unknown?'完成状态待核查':current?'今日有执行记录':'所选日期没有执行实例'}</p></div>${current?(current.stateLocked?'<button type="button" data-action="inspect-series-migrations">核查系列调整</button>':`<button class="bd-task__check" data-action="complete" data-id="${escape(current.id)}" aria-label="${current.done?'撤销打卡':'完成打卡'}：${escape(current.title)}" aria-pressed="${current.done}">${current.done?icon('check'):''}</button>`):''}</header><div class="bd-habit__stats"><div><strong>${instances.length}</strong><span>已记录实例</span></div><div><strong>${unknown?'待核查':complete.length}</strong><span>已完成</span></div><div><strong>${unknown?'待核查':`${Math.round(complete.length/instances.length*100)}<small>%</small>`}</strong><span>记录完成率</span></div></div></section>`;}).join('')}</div>`;
  }
  function focus(items) {
    return `<section class="bd-focus"><p class="bd-quiet">把注意力，交给眼前这一件事</p><div class="bd-focus__dial"><span data-focus-label>${timer.running?'正在专注':timer.elapsed?'休息一下，随时继续':'准备开始'}</span><strong data-focus-time>${formatTime(timer.remaining)}</strong><span>专注时间</span></div><div class="bd-focus__actions"><button class="bd-primary" data-action="focus-toggle">${icon(timer.running?'pause':'play')}${timer.running?'暂停专注':'开始专注'}</button><button data-action="focus-reset">重置</button></div><div class="bd-focus__settings"><label>专注时长<span><input type="number" name="focus-minutes" min="1" max="180" value="${timer.minutes}" ${timer.running?'disabled':''}>分钟</span></label><label>关联待办<select name="focus-related" ${timer.running?'disabled':''}><option value="">不关联待办</option>${items.filter(item=>!item.done&&!item.stateLocked).map(item=>`<option value="${escape(item.id)}" ${timer.related===item.id?'selected':''}>${escape(item.title)}</option>`).join('')}</select></label></div><div class="bd-focus__save"><p>专注记录由你确认后保存到便单。</p><button data-action="focus-save" ${timer.running||timer.elapsed<60||timer.saved||writeBusy?'disabled':''}>${timer.saved?'已保存':'保存本次专注'}</button></div></section>`;
  }
  function formatTime(seconds) {const value=Math.max(0,Math.ceil(seconds));return `${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;}
  function render() {
    if(disposed)return;
    renderNavigation();controls();
    root.querySelector('h1').textContent=titleForView();
    const displayDate=view==='day'?today():selectedDate;
    root.querySelector('.bd-top__date').textContent=new Date(displayDate+'T12:00:00').toLocaleDateString('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long'});
    if(!ready){reconcileHTML(body,welcome());controls();return;}
    const items=selectedEntries();
    reconcileHTML(body,view==='day'?daily(items):view==='calendar'?calendar(items):view==='quadrant'?quadrants(items):view==='habits'?habits(items):view==='focus'?focus(items):allTasks(items));
    controls();updateEditorSeriesLock();
  }
  const validSnapshot=result=>result&&['tasks','occurrences','lists','focus'].every(key=>Array.isArray(result[key]));
  function applySnapshot(result,{clearFeedback=false}={}) {
    if(disposed)return false;
    if(!validSnapshot(result))throw new Error('云端返回不完整，请重新连接后刷新。');
    if(typeof options.onSeriesAffectedTask==='function'){seriesMarkerKnown=false;void refreshSeriesMarker();}
    snapshot=result;ready=true;stale=false;viewUpdatePending=false;
    if(clearFeedback)notify('');render();return true;
  }
  function receiveSnapshot(event) {
    if(disposed||!event||typeof event!=='object')return;
    syncing=event.status==='syncing';
    if(event.status==='cleared'){
      clearAccount();notify(event.error?.message||'账号连接已清除，请重新连接。',Boolean(event.error));render();return;
    }
    if(event.status==='error'){
      if(typeof options.onSeriesAffectedTask==='function'){seriesMarkerKnown=false;void refreshSeriesMarker();}
      if(authenticationRequired(event.error))clearAccount();
      else{if(validSnapshot(event.snapshot)){snapshot=event.snapshot;ready=true;}stale=ready;}
      notify(event.error?.message||'同步暂未完成，当前内容已保留。',true);render();return;
    }
    if(event.status==='syncing'){
      if(!ready&&validSnapshot(event.snapshot))applySnapshot(event.snapshot);else controls();return;
    }
    if(validSnapshot(event.snapshot))applySnapshot(event.snapshot);
    else controls();
  }
  async function refresh({force=true}={}) {
    if(disposed)return false;
    const request=++generation;loading=true;controls();
    try {
      const result=await options.load?.({force});
      if(disposed||request!==generation)return false;
      return applySnapshot(result,{clearFeedback:true});
    } catch(error) {
      if(disposed||request!==generation)return false;
      if(authenticationRequired(error))clearAccount();else stale=ready;
      notify(error?.message||'暂时无法读取便单，请稍后刷新。',true);render();
      return false;
    } finally {if(!disposed&&request===generation){loading=false;controls();}}
  }
  async function mutation(operation, success) {
    if(writeBusy||disposed||viewUpdatePending)return false;
    writeBusy=true;controls();
    try {
      const result=await operation();if(disposed)return false;
      if(typeof options.afterMutation==='function'){
        let local;
        try{local=await options.afterMutation(result);if(!validSnapshot(local?.snapshot))throw new Error('missing confirmed snapshot');}
        catch{viewUpdatePending=true;throw new Error('操作返回后，页面更新尚未确认。请先刷新核对，不要重复提交。');}
        if(disposed)return false;applySnapshot(local.snapshot);notify(success);
      }else{const refreshed=await refresh();if(refreshed)notify(success);}
      return true;
    }
    catch(error){if(!disposed){if(authenticationRequired(error)){clearAccount();render();}notify(error?.message||'保存未确认，请先刷新核对后再重试。',true);}return false;}
    finally{writeBusy=false;if(!disposed){controls();if(view==='focus')render();}}
  }
  function invoke(name,...args) {
    if(typeof options[name]!=='function')throw new Error('当前插件尚未连接此操作，请更新插件后重试。');
    return options[name](...args);
  }
  function taskAttachments(item) {
    const native=decodeContent(item.task.taskContent),managed=parseManagedAttachments(native.remark);
    if(managed.invalid)return `<p class="bd-task__attachment-note">附件记录待核查，原内容已保留。</p>`;
    if(!managed.attachments.length&&!native.attachments.length)return '';
    return `<div class="bd-task__attachments">${managed.attachments.slice(0,3).map((descriptor,index)=>`<button class="bd-task__asset" data-action="open-task-attachment" data-id="${escape(item.id)}" data-attachment-index="${index}" title="思源附件：${escape(descriptor.name)}">${icon('attachment')}<span>${escape(descriptor.name)}</span></button>`).join('')}${managed.attachments.length>3?`<button data-action="edit-task" data-id="${escape(item.id)}">还有 ${managed.attachments.length-3} 个附件</button>`:''}${native.attachments.length?`<span class="bd-task__attachment-note">便单原附件 ${native.attachments.length} 个</span>`:''}</div>`;
  }
  function disposeAttachments() {
    uploadAbort?.abort();uploadAbort=null;uploading=false;attachmentDraft?.dispose();attachmentDraft=null;attachmentInvalid=false;nativeAttachmentCount=0;closeAttachmentPreview();
  }
  function attachmentSection() {
    return `<section class="bd-attachments" data-attachment-zone aria-label="附件与图片"><header><h3>${icon('attachment')}附件与图片</h3><button type="button" data-action="choose-attachments" ${attachmentInvalid?'disabled':''}>${icon('plus')}添加</button></header><input type="file" name="attachmentFiles" accept="${escape(ATTACHMENT_ACCEPT)}" multiple hidden ${attachmentInvalid?'disabled':''}><p class="bd-attachment-scope">保存到当前思源工作区；便单其他端不会同步文件内容。</p>${attachmentInvalid?'<p class="bd-form-error">附件记录格式尚未确认，备注与附件保持原样；仍可修改其他属性。</p>':`<p class="bd-attachment-hint">选择文件，或在此粘贴、拖入图片。最多 ${MAX_ATTACHMENT_COUNT} 个，每个不超过 ${formatBytes(MAX_ATTACHMENT_BYTES)}。</p>`}<div class="bd-attachment-list" data-attachment-list></div><button type="button" class="bd-upload-cancel" data-action="cancel-upload" hidden>取消上传</button>${nativeAttachmentCount?`<p class="bd-form-hint">已有 ${nativeAttachmentCount} 个便单附件，原引用会保留。</p>`:''}<p class="bd-attachment-hint">移除关联在保存后生效，已经上传的文件仍保留在思源中。</p></section>`;
  }
  function renderAttachments() {
    const list=editor.querySelector('[data-attachment-list]');if(!list)return;
    const rows=attachmentDraft?.entries||[];
    reconcileHTML(list,rows.map(entry=>{
      const descriptor=entry.descriptor,metadata=descriptor||entry.metadata,preview=attachmentDraft.preview(entry),state=entry.state==='saved'?'思源附件':entry.state==='uploaded'?'已上传，待保存关联':uploading?'正在上传':'待保存上传';
      return `<div class="bd-attachment" data-attachment-key="${escape(entry.key)}"><button type="button" class="bd-attachment__preview" data-action="preview-attachment" data-attachment-key="${escape(entry.key)}" aria-label="预览附件：${escape(metadata.name)}">${preview?`<img src="${escape(preview)}" alt="">`:icon('file')}</button><div class="bd-attachment__info"><strong>${escape(metadata.name)}</strong><span>${formatBytes(metadata.size)} · ${state}</span></div><button type="button" class="bd-attachment__remove" data-action="remove-attachment" data-attachment-key="${escape(entry.key)}" aria-label="移除关联：${escape(metadata.name)}" title="保存后取消关联" ${writeBusy||editorTaskLocked()?'disabled':''}>${icon('close')}</button></div>`;
    }).join(''));
    const cancel=editor.querySelector('[data-action="cancel-upload"]');if(cancel){cancel.hidden=!uploading;cancel.disabled=false;}
    const choose=editor.querySelector('[data-action="choose-attachments"]');if(choose)choose.disabled=attachmentInvalid||writeBusy||Boolean(seriesPreview)||editorTaskLocked()||rows.length>=MAX_ATTACHMENT_COUNT;
  }
  function attachmentError(message) {
    const error=editor.querySelector('.bd-form-error[role="alert"]');if(error){error.textContent=message;error.hidden=!message;}
  }
  function stageAttachments(files) {
    if(seriesPreview&&!writeBusy){cancelSeriesPreview();notify('附件草稿已变化，请重新预览整个系列。',true);}
    if(!attachmentDraft||attachmentInvalid||writeBusy||editorTaskLocked())return;
    const result=attachmentDraft.add(files);if(result.added)editorDirty=true;renderAttachments();attachmentError(result.errors.join(' '));
  }
  function closeAttachmentPreview() {
    const overlay=root.querySelector('.bd-attachment-preview');overlay?.remove();attachmentPreviewKey='';if(overlay&&previewFocus?.isConnected)previewFocus.focus();previewFocus=null;
  }
  async function showAttachment(descriptor,{previewURL='',name='',state='',key=''}={}) {
    const image=['image/png','image/jpeg','image/gif','image/webp'].includes(descriptor?.mime),url=image?getSiyuanAssetURL(descriptor):previewURL;
    if(url){
      closeAttachmentPreview();attachmentPreviewKey=key;previewFocus=doc.activeElement;
      const overlay=doc.createElement('div');overlay.className='bd-attachment-preview';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-label','图片预览');
      overlay.innerHTML=`<div><header><div><strong>${escape(descriptor?.name||name)}</strong><small>${escape(state||'思源工作区附件')}</small></div><button type="button" data-action="close-attachment-preview" aria-label="关闭图片预览">${icon('close')}</button></header><img src="${escape(url)}" alt="${escape(descriptor?.name||name)}"></div>`;
      root.appendChild(overlay);overlay.querySelector('button')?.focus();return;
    }
    if(descriptor){try{await invoke('onOpenAttachment',descriptor);}catch(error){notify(error?.message||'附件暂时无法打开，请确认当前思源工作区。',true);}}
    else attachmentError('保存待办并确认上传后，可打开此附件。');
  }
  async function uploadAttachments(currentGeneration) {
    if(editorTaskLocked())throw new Error('该系列的状态待核查，请重新打开待办核对后再保存附件。');
    const draft=attachmentDraft;if(!draft||attachmentInvalid)return undefined;
    const pending=draft.pending();
    if(pending.length){
      const controller=new AbortController();uploadAbort=controller;uploading=true;renderAttachments();
      try{
        const descriptors=await invoke('onUploadAttachments',pending.map(entry=>entry.file),{signal:controller.signal});
        if(!Array.isArray(descriptors)||descriptors.length!==pending.length)throw new Error('附件上传结果尚未完整确认，请保留草稿并核对。');
        if(!disposed&&currentGeneration===editorGeneration&&draft===attachmentDraft)draft.confirmed(pending,descriptors.map((descriptor,index)=>({index,descriptor})));
        if(disposed||currentGeneration!==editorGeneration||draft!==attachmentDraft||controller.signal.aborted)throw new Error('上传已取消，未向其他待办添加附件。');
      }catch(error){
        if(!disposed&&currentGeneration===editorGeneration&&draft===attachmentDraft){
          const uploaded=Array.isArray(error?.uploadedEntries)?error.uploadedEntries:Array.isArray(error?.uploaded)?error.uploaded.map((descriptor,index)=>({index,descriptor})):[];
          if(uploaded.length)draft.confirmed(pending,uploaded);
        }
        throw error;
      }finally{
        if(uploadAbort===controller){uploadAbort=null;uploading=false;renderAttachments();}
      }
    }
    if(disposed||currentGeneration!==editorGeneration||draft!==attachmentDraft)throw new Error('编辑已关闭，未向其他待办添加附件。');
    return draft.descriptors();
  }
  function closeEditor() {
    if(writeBusy)return;if(seriesPreview){cancelSeriesPreview();return;}disposeAttachments();subplanDraft=null;editorOpen=false;editorTarget=null;deletePreview=null;editorDirty=false;++editorGeneration;
    editor.hidden=true;editor.replaceChildren();root.classList.remove('bd-app--editor-open');if(focusBeforeEditor?.isConnected)focusBeforeEditor.focus();else root.querySelector('.bd-fab')?.focus();
  }
  function beginEditor(title,target=null) {
    if(!ready||writeBusy)return false;
    if(seriesPreview){seriesPreview.box?.querySelector('button')?.focus();return false;}
    if(editorOpen&&editorDirty&&!win.confirm('放弃当前尚未保存的修改，打开另一项？'))return false;
    if(!editorOpen)focusBeforeEditor=doc.activeElement;
    disposeAttachments();subplanDraft=null;
    editorOpen=true;editorTarget=target;deletePreview=null;editorDirty=false;++editorGeneration;editor.hidden=false;root.classList.add('bd-app--editor-open');editor.setAttribute('aria-label',title);
    editor.innerHTML=`<header><h2>${escape(title)}</h2><span class="bd-editor-header-actions">${typeof options.onSeriesPending==='function'?`<button type="button" data-action="inspect-series-migrations" aria-label="核查系列调整" title="核查未完成的系列调整">${icon('important')}</button>`:''}<button data-action="close-editor" aria-label="关闭编辑">${icon('close')}</button></span></header>`;
    return true;
  }
  function colorOptions(selected) {
    const names=['默认','鲜红','橙色','黄色','绿色','湖蓝','浅蓝','深蓝','紫色','柔红','柔橙','柔黄','柔绿','柔湖蓝','柔浅蓝','柔深蓝','柔紫','莫兰迪红','莫兰迪橙','莫兰迪黄','莫兰迪绿','莫兰迪湖蓝','莫兰迪浅蓝','莫兰迪深蓝','莫兰迪紫'];
    return `<fieldset class="bd-color-picker"><legend>待办单颜色</legend><div>${palette.map((color,index)=>`<label title="${names[index]}"><input type="radio" name="color" value="${index}" aria-label="${names[index]}" ${index===selected?'checked':''}><span style="--bd-swatch:${color}">${icon('check')}</span></label>`).join('')}</div></fieldset>`;
  }
  function scheduleFields(item) {
    const task=item?.task||{},instance=item?.instance||{},repeating=Number(task.isLoop)>0||Number(task.loopSet)>0;
    const defaultDate=view==='day'?today():selectedDate;
    const noTime=Number(task.haveNoTime)===1,start=noTime?defaultDate:normalizeDate(instance.startTime)||normalizeDate(task.startTime)||defaultDate,end=noTime?defaultDate:normalizeDate(instance.endTime)||normalizeDate(task.endTime)||start;
    if(item&&repeating)return `<p class="bd-form-hint">重复排期保持不变。名称等属性按整个系列保存；子计划结构修改须先预览并确认整个系列。<br>当前安排：${noTime?'未安排日期':escape(start+' 至 '+end)}</p>`;
    const startTime=String(instance.validStartTime||task.validStartTime||'00:00:00'),endTime=String(instance.validEndTime||task.validEndTime||'23:59:59');
    const allDay=!item||noTime||startTime==='00:00:00'&&endTime==='23:59:59';
    return `<label class="bd-checkbox"><input type="checkbox" name="noTime" ${noTime?'checked':''}>待安排：暂不安排日期</label><div class="bd-form-row"><label>开始日期<input name="startDate" type="date" value="${escape(start)}" required ${noTime?'disabled':''}></label><label>结束日期<input name="endDate" type="date" value="${escape(end)}" required ${noTime?'disabled':''}></label></div><label class="bd-checkbox"><input type="checkbox" name="allDay" ${allDay?'checked':''} ${noTime?'disabled':''}>全天</label><div class="bd-form-row"><label>开始时间<input name="startTime" type="time" value="${escape(item?startTime.slice(0,5):'09:00')}" ${noTime||allDay?'disabled':''}></label><label>结束时间<input name="endTime" type="time" value="${escape(item?endTime.slice(0,5):'10:00')}" ${noTime||allDay?'disabled':''}></label></div>`;
  }
  function prepareSubplans(item) {
    const state=item?subplanState(item):{subtasks:[],completed:[],canEdit:true,canToggle:false,reason:''};
    const editable=state.canEdit||state.canEditSeries;
    subplanDraft={baseline:state.subtasks.slice(),canEdit:editable,series:Boolean(state.canEditSeries),hasKnownProgress:!item||state.canToggle||editable&&state.total===0,reason:state.reason,items:state.subtasks.slice(0,MAX_SUBTASKS).map((title,index)=>({key:'original-'+index,title,sourceIndex:index,done:Boolean(state.completed[index])}))};
    return `<section class="bd-subplan-editor" data-subplan-editor aria-label="子计划"><header><h3>子计划 <span data-subplan-progress></span>${state.canEditSeries?'<small class="bd-series-scope">整个系列</small>':''}</h3><button type="button" class="bd-subplan-add" data-action="add-subplan" aria-label="添加子计划" title="添加子计划" ${editable?'':'disabled'}>${icon('plus')}</button></header><div class="bd-subplan-editor__items" data-subplan-draft-list></div>${editable?'<label class="bd-subplan-new"><span class="bd-sr-only">新子计划内容</span><input name="subplan-title" maxlength="500" placeholder="下一步要做什么？按 Enter 添加"></label>':`<p class="bd-form-hint">${escape(state.reason||'此待办暂不支持修改子计划结构。')}</p>`}<p class="bd-subplan-editor__hint" data-subplan-edit-hint></p><p class="bd-subplan-error" data-subplan-error role="status" hidden></p></section>`;
  }
  function editorTaskLocked() {return Boolean(editorTarget?.item&&(seriesTaskLocked(editorTarget.record)||subplanDraft?.wasSeriesLocked));}
  function captureSubplanNames() {
    if(!subplanDraft?.canEdit)return;
    for(const input of editor.querySelectorAll('[name="subplan-name"]')){const item=subplanDraft.items.find(item=>item.key===input.dataset.subplanKey);if(item)item.title=input.value;}
  }
  function renderSubplanDraft() {
    const section=editor.querySelector('[data-subplan-editor]');if(!section||!subplanDraft)return;
    const draft=subplanDraft,progress=section.querySelector('[data-subplan-progress]');
    progress.textContent=draft.hasKnownProgress?`${draft.items.filter(item=>item.done).length}/${draft.items.length}`:'状态只读';
    section.querySelector('[data-subplan-draft-list]').innerHTML=draft.items.length?draft.items.map(item=>`<div class="bd-subplan-draft-row" data-subplan-key="${escape(item.key)}">${draft.hasKnownProgress?`<input class="bd-subplan-status" type="checkbox" disabled ${item.done?'checked':''} aria-label="${item.done?'已完成':'未完成'}，请在列表修改完成状态">`:'<span class="bd-subplan-status" title="状态待核查">'+icon('important')+'</span>'}${draft.canEdit?`<input name="subplan-name" data-subplan-key="${escape(item.key)}" value="${escape(item.title)}" maxlength="500" required aria-label="子计划内容"><button type="button" class="bd-subplan-remove" data-action="remove-subplan" data-subplan-key="${escape(item.key)}" aria-label="移除子计划：${escape(item.title)}" title="保存后移除子计划">${icon('close')}</button>`:`<span class="bd-subplan-readonly">${escape(item.title)}</span>`}</div>`).join(''):'<p class="bd-form-hint">尚未添加子计划。</p>';
    const add=section.querySelector('[data-action="add-subplan"]');add.disabled=!draft.canEdit||writeBusy||draft.items.length>=MAX_SUBTASKS;
    const input=section.querySelector('[name="subplan-title"]');if(input)input.disabled=writeBusy||draft.items.length>=MAX_SUBTASKS;
    section.querySelector('[data-subplan-edit-hint]').textContent=draft.canEdit?(draft.series?'修改会应用于整个系列。保存前先预览受影响次数，确认后才修改；新增步骤可能重新打开历史已完成记录。':draft.items.length>=MAX_SUBTASKS?'已达 20 项上限；修改在保存待办后生效。':draft.baseline.length&&!draft.items.length?'保存后移除全部子计划，并保留当前待办完成状态。':'最多 20 项，修改在保存后生效。完成状态请在列表勾选；新增未完成步骤会重新打开已完成待办。'):'已有子计划保持原样；合法步骤可在列表勾选本次完成状态。';
  }
  function subplanError(message) {const error=editor.querySelector('[data-subplan-error]');if(error){error.textContent=message;error.hidden=!message;}}
  function addSubplan() {
    if(!subplanDraft?.canEdit||writeBusy||viewUpdatePending||seriesPreview||editorTaskLocked())return;
    captureSubplanNames();const input=editor.querySelector('[name="subplan-title"]'),title=String(input?.value||'').trim();
    if(!title){subplanError('请填写子计划内容。');input?.focus();return;}
    try{validateSubtaskTitles([...subplanDraft.items.map(item=>item.title.trim()),title]);}catch(error){subplanError(error.message);return;}
    subplanDraft.items.push({key:'new-'+(++subplanSequence),title,sourceIndex:null,done:false});editorDirty=true;input.value='';subplanError('');renderSubplanDraft();if(!input.disabled)input.focus();else [...editor.querySelectorAll('[name="subplan-name"]')].at(-1)?.focus();
  }
  function resetSeriesPreview({restore=true}={}) {
    const state=seriesPreview;seriesPreview=null;++seriesPreviewGeneration;
    state?.box?.remove();
    if(restore)for(const [field,disabled]of state?.fields||[])if(field.isConnected)field.disabled=disabled;
  }
  function cancelSeriesPreview() {
    if(writeBusy)return;const focus=seriesPreview?.focus;
    resetSeriesPreview();controls();renderAttachments();
    if(focus?.isConnected)focus.focus();
  }
  function disposeSeriesState() {
    seriesAbort?.abort();seriesAbort=null;resetSeriesPreview({restore:false});++recoveryGeneration;
    recoveryState?.layer?.remove();recoveryState=null;
  }
  function currentConfirmedAttachments() {
    const seen=new Set();return (attachmentDraft?.entries||[]).flatMap(entry=>{if(!entry.descriptor||seen.has(entry.descriptor.path))return [];seen.add(entry.descriptor.path);return [entry.descriptor];});
  }
  async function previewSeriesChange(form,target,patch) {
    if(writeBusy||seriesPreview||!ready)return;
    const generation=++seriesPreviewGeneration,editorVersion=editorGeneration;
    const metadata=structuredClone(patch),subtaskPlan=metadata.subtasks;delete metadata.subtasks;
    for(const field of ['startDate','endDate','startTime','endTime','noTime'])delete metadata[field];
    if(!attachmentInvalid)metadata.attachments=structuredClone(currentConfirmedAttachments());
    const fields=[...form.querySelectorAll('button,input,textarea,select')].map(field=>[field,field.disabled]);fields.forEach(([field])=>field.disabled=true);
    const box=doc.createElement('section');box.className='bd-series-preview';box.setAttribute('data-series-preview','');box.setAttribute('aria-label','整个系列修改预览');
    box.innerHTML='<p class="bd-series-progress" role="status">正在核对整个系列的影响范围，尚未修改云端…</p><button type="button" data-action="series-preview-back">返回修改</button>';
    form.insertBefore(box,form.querySelector('footer'));
    const state={status:'loading',form,fields,box,focus:doc.activeElement,editorVersion,context:{parent:target.record,subtaskPlan,options:{expectedVersion:target.record.version,occurrence:target.item.record,expectedOccurrenceVersion:target.item.record.version,patch:metadata}},pendingFiles:attachmentDraft?.pending().map(entry=>entry.metadata.name)||[]};
    seriesPreview=state;controls();box.scrollIntoView?.({block:'nearest'});box.querySelector('button')?.focus();
    try{
      const plan=checkedSeriesPreview(await invoke('onPreviewSeriesSubtasks',state.context.parent,state.context.subtaskPlan,state.context.options));
      if(disposed||generation!==seriesPreviewGeneration||editorVersion!==editorGeneration||seriesPreview!==state)return;
      if(plan.taskRecordId!==state.context.parent.id||id(plan.taskId)!==id(attrs(state.context.parent).id1))throw new Error('预览目标与当前待办不一致，请返回修改并重新核查。');
      state.plan=plan;state.status='ready';box.innerHTML=seriesPreviewHTML(plan,state.pendingFiles);controls();box.scrollIntoView?.({block:'nearest'});box.querySelector('[data-action="series-preview-back"]')?.focus();
    }catch(error){
      if(disposed||generation!==seriesPreviewGeneration||seriesPreview!==state)return;
      resetSeriesPreview();
      if(authenticationRequired(error)){clearAccount();render();}
      else{const message=form.querySelector('.bd-form-error[role="alert"]');if(message){message.textContent=error?.message||'尚未核实整个系列范围，请稍后重新预览。';message.hidden=false;}}
      notify(error?.message||'尚未核实整个系列范围，未执行修改。',true);controls();
    }
  }
  function markSeriesRunning(state) {
    state.status='running';state.box.querySelectorAll('[data-action="series-confirm"],[data-action="series-preview-back"]').forEach(button=>button.disabled=true);
    const stop=state.box.querySelector('[data-action="series-stop"]');stop.hidden=false;stop.disabled=false;
    const status=state.box.querySelector('[data-series-progress]');if(status)status.textContent='正在保存已确认的整个系列调整…';
  }
  async function confirmSeriesChange() {
    const state=seriesPreview;if(!state||state.status!=='ready'||writeBusy||viewUpdatePending||!ready)return;
    const abort=new AbortController();seriesAbort=abort;markSeriesRunning(state);
    const onProgress=progress=>{if(disposed||seriesPreview!==state)return;state.progress=seriesProgressText(progress);const node=state.box.querySelector('[data-series-progress]');if(node)node.textContent=state.progress;};
    const saved=await mutation(async()=>{
      let plan=state.plan;
      if(attachmentDraft?.pending().length){
        const attachments=await uploadAttachments(state.editorVersion);
        if(abort.signal.aborted)throw new Error('已停止后续处理；已上传的附件保留在思源中。');
        const finalOptions={...state.context.options,patch:{...state.context.options.patch,attachments}};
        const finalPlan=checkedSeriesPreview(await invoke('onPreviewSeriesSubtasks',state.context.parent,state.context.subtaskPlan,finalOptions));
        if(finalPlan.taskRecordId!==state.context.parent.id||id(finalPlan.taskId)!==id(attrs(state.context.parent).id1))throw new Error('附件保存后未核实到相同的待办，未继续修改整个系列。');
        if(finalPlan.scopeFingerprint!==state.plan.scopeFingerprint)throw new Error('整个系列的范围或进度已变化，请返回修改并重新预览；已上传附件会保留。');
        plan=finalPlan;
      }
      if(disposed||seriesPreview!==state||state.editorVersion!==editorGeneration||abort.signal.aborted)throw new Error('已停止后续处理，已提交的内容会保留。');
      lockSeriesTarget(plan);
      return checkedSeriesApplied(await invoke('onApplySeriesSubtasks',plan,{signal:abort.signal,onProgress}),plan.fingerprint);
    },'整个系列的子计划已更新');
    if(seriesAbort===abort)seriesAbort=null;
    await refreshSeriesMarker();
    if(disposed||seriesPreview!==state)return;
    if(saved){resetSeriesPreview();closeEditor();return;}
    state.status='error';const progress=state.box.querySelector('[data-series-progress]');if(progress)progress.textContent=(state.progress?state.progress+' ':'')+(feedbackMessage||'修改尚未全部确认，已提交内容会保留。');
    state.box.querySelector('[data-action="series-stop"]').hidden=true;
    state.box.querySelector('[data-action="series-confirm"]').disabled=true;
    state.box.querySelector('[data-action="series-preview-back"]').disabled=false;
    const inspect=state.box.querySelector('[data-action="inspect-series-migrations"]');inspect.hidden=false;inspect.disabled=false;controls();
  }
  function closeSeriesRecovery() {
    if(writeBusy)return;const focus=recoveryState?.focus;++recoveryGeneration;recoveryState?.layer?.remove();recoveryState=null;if(focus?.isConnected)focus.focus();
  }
  function renderSeriesRecovery() {
    const state=recoveryState;if(!state)return;
    const body=state.layer.querySelector('[data-series-recovery-content]');
    body.innerHTML=state.loading?'<p class="bd-series-progress" role="status">正在通过当前账号核查本机未完成记录…</p>':state.complete?'<p class="bd-series-empty">上次已确认的整个系列调整已完成。现有编辑草稿保持不变；请重新打开待办查看最新结构。</p>':seriesPendingHTML(state.summary);
  }
  async function readSeriesRecovery(reconcile=false) {
    if(writeBusy||!ready||disposed)return;
    if(!recoveryState){
      const layer=doc.createElement('div');layer.className='bd-series-recovery-layer';layer.setAttribute('data-series-recovery','');
      layer.innerHTML=`<aside class="bd-series-recovery-panel" role="dialog" aria-modal="true" aria-label="核查未完成的系列调整"><header><h2>未完成的系列调整</h2><button type="button" data-action="series-recovery-close" aria-label="关闭系列核查">${icon('close')}</button></header><div data-series-recovery-content></div></aside>`;
      recoveryState={layer,summary:null,loading:true,focus:doc.activeElement};root.appendChild(layer);
    }
    const state=recoveryState,generation=++recoveryGeneration;state.loading=true;state.complete=false;renderSeriesRecovery();state.layer.querySelector('[data-action="series-recovery-close"]')?.focus();
    try{
      const result=await invoke(reconcile?'onReconcileSeries':'onSeriesPending');
      if(disposed||recoveryState!==state||generation!==recoveryGeneration||!ready)return;
      await refreshSeriesMarker();
      if(disposed||recoveryState!==state||generation!==recoveryGeneration||!ready)return;
      state.summary=checkedSeriesPending(result);state.loading=false;renderSeriesRecovery();
    }catch(error){
      if(disposed||recoveryState!==state||generation!==recoveryGeneration)return;
      if(authenticationRequired(error)){clearAccount();render();return;}
      state.summary={status:'unavailable'};state.loading=false;renderSeriesRecovery();
    }
  }
  async function resumeSeriesChange() {
    const state=recoveryState,summary=state?.summary;if(!summary?.canResume||writeBusy||!ready||viewUpdatePending)return;
    const generation=recoveryGeneration,abort=new AbortController();seriesAbort=abort;state.running=true;
    lockSeriesTarget(summary);
    state.layer.querySelectorAll('button').forEach(button=>button.disabled=true);const stop=state.layer.querySelector('[data-action="series-stop"]');stop.hidden=false;stop.disabled=false;
    const onProgress=value=>{if(disposed||recoveryState!==state||generation!==recoveryGeneration)return;const node=state.layer.querySelector('[data-series-recovery-progress]');if(node)node.textContent=seriesProgressText(value);};
    const saved=await mutation(async()=>checkedSeriesApplied(await invoke('onResumeSeries',{fingerprint:summary.fingerprint,signal:abort.signal,onProgress}),summary.fingerprint),'已核查并完成上次系列调整');
    if(seriesAbort===abort)seriesAbort=null;
    await refreshSeriesMarker();
    if(disposed||recoveryState!==state||generation!==recoveryGeneration)return;
    state.running=false;state.layer.querySelector('[data-action="series-recovery-close"]').disabled=false;
    if(saved){state.complete=true;state.summary=null;renderSeriesRecovery();}
    else{
      const progress=state.layer.querySelector('[data-series-recovery-progress]');if(progress)progress.textContent=feedbackMessage||'尚未全部确认，已提交内容保留，请先重新核查。';
      state.summary={...summary,canResume:false};state.layer.querySelector('[data-action="series-resume"]').disabled=true;state.layer.querySelector('[data-action="series-reconcile"]').disabled=false;stop.hidden=true;
    }
  }
  function stopSeriesChange() {
    if(!seriesAbort||seriesAbort.signal.aborted)return;seriesAbort.abort();uploadAbort?.abort();
    root.querySelectorAll('[data-action="series-stop"]').forEach(button=>button.disabled=true);
    const node=seriesPreview?.status==='running'?seriesPreview.box.querySelector('[data-series-progress]'):recoveryState?.layer.querySelector('[data-series-recovery-progress]');
    if(node)node.textContent='已请求停止后续处理。当前已发请求会核查结果，已提交内容保留。';
  }
  function openEditor(kind,target=null) {
    if(editorOpen&&!target){editor.querySelector('input')?.focus();return;}
    const editing=Boolean(target),isList=kind==='list',record=isList?target:target?.parentRecord,task=attrs(record);
    if(!beginEditor(isList?(editing?'编辑待办单':'新建待办单'):(editing?'编辑待办':'新建待办'),{kind,record,item:isList?null:target}))return;
    const lists=(snapshot.lists||[]).map(attrs).filter(list=>Number(list.id3)>1),listId=editing?id(task.id3):listFilter;
    const title=isList?task.favoritesName:target?.title,remark=editing&&!isList?remarkOf(task):'';
    if(!isList){const content=decodeContent(task.taskContent),managed=parseManagedAttachments(content.remark);attachmentInvalid=Boolean(managed.invalid);nativeAttachmentCount=content.attachments.length;attachmentDraft=createAttachmentDraft(attachmentInvalid?[]:managed.attachments,{urlAPI:win.URL||globalThis.URL});}
    const quadrant=`${Number(task.isImportant)===1?1:0}:${Number(task.isUrgency)===1?1:0}`;
    editor.insertAdjacentHTML('beforeend',`<form data-form="${editing?'edit-':''}${kind}"><label>名称<input name="title" required maxlength="${isList?200:500}" value="${escape(title||'')}" placeholder="${isList?'例如：工作计划':'记下下一步要做的事'}"></label>${isList?colorOptions(Number(task.favoritesColor||0)%100):`<label>待办单<select name="listId"><option value="1">未分类</option>${lists.map(list=>`<option value="${escape(id(list.id3))}" ${id(list.id3)===listId?'selected':''}>${escape(list.favoritesName||'未命名清单')}</option>`).join('')}</select></label><label>备注 · 支持 Markdown<textarea name="content" rows="6" maxlength="20000" placeholder="用 Markdown 记录说明、步骤与链接…">${escape(remark)}</textarea></label><details class="bd-note-preview" ${remark?'open':''}><summary>备注预览</summary><div class="bd-markdown" data-note-preview>${renderSafeMarkdown(doc,remark,options.renderMarkdown)}</div></details>${scheduleFields(editing?target:null)}<div class="bd-form-row"><label class="bd-checkbox"><input type="checkbox" name="important" ${Number(task.isImportant)===1?'checked':''}>重要</label><label class="bd-checkbox"><input type="checkbox" name="urgent" ${Number(task.isUrgency)===1?'checked':''}>紧急</label></div>${editing?`<label>移动至象限<select name="quadrant">${quadrantDefinitions.map(([label,key])=>`<option value="${key}" ${quadrant===key?'selected':''}>${label}</option>`).join('')}</select></label>`:''}`}<p class="bd-form-error" role="alert" hidden></p><footer>${editing?`<button type="button" class="bd-danger-text" data-action="${isList?'delete-list':'delete-task'}" ${isList?`data-list-id="${escape(id(task.id3))}"`:`data-id="${escape(target.id)}"`}>${icon('trash')}删除${isList?'待办单':'待办'}</button>`:''}<button type="button" data-action="close-editor">取消</button><button class="bd-primary" type="submit">${isList?(editing?'保存待办单':'创建待办单'):'保存待办'}</button></footer></form>`);
    if(!isList){const textarea=editor.querySelector('[name="content"]');if(attachmentInvalid)textarea.readOnly=true;textarea.closest('label').insertAdjacentHTML('afterend',prepareSubplans(editing?target:null)+attachmentSection());renderSubplanDraft();renderAttachments();updateEditorSeriesLock();}
    editor.querySelector('input')?.focus();
  }
  async function openDelete(kind,target) {
    if(!target||!beginEditor(kind==='list'?'删除待办单':'删除待办',{kind,record:kind==='list'?target:target.parentRecord,item:kind==='list'?null:target}))return;
    const current=editorGeneration;
    editor.insertAdjacentHTML('beforeend','<p class="bd-delete-loading" role="status">正在核对删除范围…</p>');
    try{
      const plan=kind==='list'?await invoke('onPreviewDeleteList',target,{expectedVersion:target.version}):await invoke('onPreviewDeleteTask',target.parentRecord,target.record,{expectedTaskVersion:target.parentRecord.version,expectedOccurrenceVersion:target.record.version});
      if(disposed||!editorOpen||current!==editorGeneration)return;
      if(!plan||typeof plan!=='object')throw new Error('未能核对删除范围，请刷新后重试。');
      deletePreview=plan;editor.querySelector('.bd-delete-loading')?.remove();
      const list=attrs(target),name=kind==='list'?list.favoritesName:target.title;
      const description=kind==='list'?`待办单内 ${Number.isInteger(plan.taskCount)?plan.taskCount:'所含'} 项任务将移到「未分类」，任务和执行记录会保留。`:plan.deletesTaskDefinition?'将删除这条一次性待办及其执行记录。':`只删除当前执行实例（${escape(normalizeDate(target.instance.startTime)||'未安排日期')}），保留系列和其他执行实例。`;
      editor.insertAdjacentHTML('beforeend',`<form data-form="delete-${kind}"><h3 class="bd-delete-title">${escape(name||'未命名')}</h3><p class="bd-delete-explanation">${description}</p><p class="bd-form-hint">删除后无法在插件内撤销，请确认范围。</p><p class="bd-form-error" role="alert" hidden></p><footer><button type="button" data-action="close-editor">取消</button><button class="bd-danger" type="submit">确认删除${kind==='list'?'待办单':'本条待办'}</button></footer></form>`);
      editor.querySelector('[data-form] button')?.focus();
    }catch(error){if(disposed||current!==editorGeneration)return;editor.querySelector('.bd-delete-loading')?.remove();const message=doc.createElement('p');message.className='bd-form-error';message.setAttribute('role','alert');message.textContent=error?.message||'未能核对删除范围，请刷新后重试。';editor.appendChild(message);}
  }
  async function submit(event) {
    const form=event.target.closest('form[data-form]');if(!form)return;
    event.preventDefault();if(writeBusy||!ready||viewUpdatePending||seriesPreview)return;
    const values=new win.FormData(form),kind=form.dataset.form,target=editorTarget,error=form.querySelector('[role="alert"]');
    if(editorTaskLocked()){error.textContent='该系列状态尚待核查，当前草稿保留。请先核查调整结果，再重新打开待办保存。';error.hidden=false;return;}
    let operation,success='已保存';
    if(kind.startsWith('delete-')){
      if(!deletePreview)return;const plan=deletePreview;
      operation=kind==='delete-list'?()=>invoke('onDeleteList',target.record,{expectedVersion:target.record.version,preview:plan,taskAction:'move_to_default'}):()=>invoke('onDeleteTask',target.record,target.item.record,{expectedTaskVersion:target.record.version,expectedOccurrenceVersion:target.item.record.version,preview:plan});
      success=kind==='delete-list'?'待办单已删除，原任务已移到未分类':'本条待办已删除';
    }else{
      const title=String(values.get('title')||'').trim();if(!title)return;
      if(kind==='list'||kind==='edit-list'){
        const color=Number(values.get('color')||0);operation=kind==='list'?()=>invoke('onCreateList',title,{color}):()=>invoke('onEditList',target.record,{name:title,color},{expectedVersion:target.record.version});success=kind==='list'?'待办单已创建':'待办单已保存';
      }else{
        const draft={title,content:String(values.get('content')||''),listId:String(values.get('listId')||'1'),startDate:String(values.get('startDate')||selectedDate),endDate:String(values.get('endDate')||selectedDate),startTime:values.has('allDay')?'00:00:00':String(values.get('startTime')||'09:00')+':00',endTime:values.has('allDay')?'23:59:59':String(values.get('endTime')||'10:00')+':00',noTime:values.has('noTime'),important:values.has('important'),urgent:values.has('urgent')};
        if(form.querySelector('[name="startDate"]')&&!draft.noTime&&(draft.endDate<draft.startDate||draft.startDate===draft.endDate&&draft.endTime<draft.startTime)){error.textContent='结束日期或时间不能早于开始。';error.hidden=false;return;}
        const patch={title,remark:draft.content,listId:draft.listId,important:draft.important,urgent:draft.urgent};
        if(subplanDraft?.canEdit&&editor.querySelector('[name="subplan-title"]')?.value.trim()){
          const before=subplanDraft.items.length;addSubplan();if(subplanDraft.items.length===before)return;
        }
        captureSubplanNames();
        if(subplanDraft?.canEdit){
          const titles=subplanDraft.items.map(item=>item.title.trim());
          try{validateSubtaskTitles(titles);}catch(problem){subplanError(problem.message);return;}
          if(kind==='task')draft.subtasks=titles;
          else if(titles.length!==subplanDraft.baseline.length||subplanDraft.items.some((item,index)=>item.sourceIndex!==index||item.title.trim()!==subplanDraft.baseline[index]?.trim()))patch.subtasks=subplanDraft.items.map(item=>({title:item.title.trim(),sourceIndex:item.sourceIndex}));
        }
        if(form.querySelector('[name="startDate"]'))Object.assign(patch,{startDate:draft.startDate,endDate:draft.endDate,startTime:draft.startTime,endTime:draft.endTime,noTime:draft.noTime});
        if(attachmentInvalid)delete patch.remark;
        if(kind==='edit-task'&&subplanDraft?.series&&Object.hasOwn(patch,'subtasks')){await previewSeriesChange(form,target,patch);return;}
        const currentGeneration=editorGeneration;
        operation=async()=>{
          const attachments=await uploadAttachments(currentGeneration);
          if(attachments!==undefined){draft.attachments=attachments;patch.attachments=attachments;}
          if(disposed||currentGeneration!==editorGeneration)throw new Error('编辑已关闭，未保存到其他待办。');
          return kind==='edit-task'?invoke('onEditTask',target.record,patch,{expectedVersion:target.record.version,occurrence:target.item.record,expectedOccurrenceVersion:target.item.record.version}):invoke('onCreate',draft);
        };success='待办已保存';
      }
    }
    const fields=[...form.querySelectorAll('button,input,textarea,select')].filter(field=>field.dataset.action!=='cancel-upload'),disabled=fields.map(field=>field.disabled);fields.forEach(field=>field.disabled=true);
    const saved=await mutation(operation,success);fields.forEach((field,index)=>field.disabled=disabled[index]||viewUpdatePending&&field.tagName==='BUTTON'&&field.type==='submit');
    if(disposed)return;
    if(saved){if(kind==='delete-list'&&listFilter===id(attrs(target.record).id3)){listFilter='all';render();}closeEditor();}else{error.textContent=feedbackMessage;error.hidden=false;renderAttachments();}
  }
  async function click(event) {
    if(event.target.classList?.contains('bd-series-recovery-layer')){closeSeriesRecovery();return;}
    if(event.target.classList?.contains('bd-attachment-preview')){closeAttachmentPreview();return;}
    const button=event.target.closest?.('button');if(!button||!root.contains(button)||button.disabled)return;
    if(button.dataset.view){view=button.dataset.view;root.classList.remove('bd-app--nav-open');render();return;}
    if(button.dataset.list){listFilter=button.dataset.list;render();return;}
    if(button.dataset.date){selectedDate=button.dataset.date;month=selectedDate.slice(0,7);render();return;}
    const action=button.dataset.action;
    if((writeBusy||viewUpdatePending||seriesPreview)&&['new-task','new-list','edit-task','edit-list','delete-task','delete-list','complete','complete-subplan','move-task','add-subplan','remove-subplan'].includes(action)||writeBusy&&['close-editor','refresh'].includes(action))return;
    if(writeBusy&&action?.startsWith('focus-'))return;
    if(action==='navigation'){const open=root.classList.toggle('bd-app--nav-open');button.setAttribute('aria-expanded',String(open));return;}
    if(action==='refresh')return refresh();
    if(action==='settings')return options.onOpenSettings?.();
    if(action==='connect'){
      if(loading)return;loading=true;controls();notify('请在授权窗口完成账号连接。');
      try{await options.connect?.();if(!disposed)await refresh();}catch(error){if(!disposed)notify(error?.message||'连接尚未完成，请重试。',true);}finally{loading=false;if(!disposed)controls();}return;
    }
    if(action==='new-task')return openEditor('task');
    if(action==='new-list')return openEditor('list');
    if(action==='close-editor')return closeEditor();
    if(action==='series-preview-back'){cancelSeriesPreview();return;}
    if(action==='series-confirm')return confirmSeriesChange();
    if(action==='series-stop'){stopSeriesChange();return;}
    if(action==='inspect-series-migrations')return readSeriesRecovery();
    if(action==='series-recovery-close'){closeSeriesRecovery();return;}
    if(action==='series-reconcile')return readSeriesRecovery(true);
    if(action==='series-resume')return resumeSeriesChange();
    if(action==='add-subplan'){addSubplan();return;}
    if(action==='remove-subplan'){
      if(!subplanDraft?.canEdit||writeBusy||editorTaskLocked())return;
      captureSubplanNames();const index=subplanDraft.items.findIndex(item=>item.key===button.dataset.subplanKey);if(index<0)return;
      subplanDraft.items.splice(index,1);editorDirty=true;subplanError('');renderSubplanDraft();
      const fields=[...editor.querySelectorAll('[name="subplan-name"]')];(fields[Math.min(index,fields.length-1)]||editor.querySelector('[name="subplan-title"]'))?.focus();return;
    }
    if(action==='choose-attachments'){if(!writeBusy&&!attachmentInvalid&&!editorTaskLocked())editor.querySelector('[name="attachmentFiles"]')?.click();return;}
    if(action==='cancel-upload'){uploadAbort?.abort();return;}
    if(action==='close-attachment-preview'){closeAttachmentPreview();return;}
    if(action==='remove-attachment'){
      if(writeBusy||attachmentInvalid||editorTaskLocked())return;
      if(attachmentDraft?.remove(button.dataset.attachmentKey)){editorDirty=true;if(attachmentPreviewKey===button.dataset.attachmentKey)closeAttachmentPreview();renderAttachments();}return;
    }
    if(action==='preview-attachment'){
      const entry=attachmentDraft?.entries.find(entry=>entry.key===button.dataset.attachmentKey);if(!entry)return;
      try{await showAttachment(entry.descriptor,{previewURL:attachmentDraft.preview(entry),name:entry.metadata?.name,state:entry.state==='saved'?'思源工作区附件':entry.descriptor?'已上传，待保存关联':'本机预览，尚未上传',key:entry.key});}catch(error){attachmentError(error?.message||'图片暂时无法预览。');}return;
    }
    if(action==='open-task-attachment'){
      const item=entries().find(item=>item.id===button.dataset.id),index=Number(button.dataset.attachmentIndex);if(!item||!Number.isInteger(index))return;
      const managed=parseManagedAttachments(decodeContent(item.task.taskContent).remark),descriptor=managed.invalid?null:managed.attachments[index];
      if(descriptor){try{await showAttachment(descriptor);}catch(error){notify(error?.message||'附件暂时无法打开。',true);}}return;
    }
    if(action==='edit-task'||action==='move-task'){
      const item=entries().find(item=>item.id===button.dataset.id);if(item){openEditor('task',item);if(action==='move-task')editor.querySelector('[name="quadrant"]')?.focus();}return;
    }
    if(action==='delete-task')return openDelete('task',entries().find(item=>item.id===button.dataset.id));
    if(action==='edit-list'||action==='delete-list'){
      const record=snapshot.lists.find(record=>id(attrs(record).id3)===button.dataset.listId);if(record)return action==='edit-list'?openEditor('list',record):openDelete('list',record);return;
    }
    if(action==='complete'){
      const item=entries().find(item=>item.id===button.dataset.id);if(!item)return;
      if(item.stateLocked){notify('该系列完成状态待核查，请先核查系列调整。',true);return;}
      button.disabled=true;await mutation(()=>invoke('onComplete',item.record,!item.done),item.done?'已撤销完成':'已记录完成');if(!disposed)render();return;
    }
    if(action==='complete-subplan'){
      const item=entries().find(item=>item.id===button.dataset.id),index=Number(button.dataset.subplanIndex);if(!item||!Number.isInteger(index))return;
      const state=subplanState(item);if(!state.canToggle||index<0||index>=state.total)return;
      const done=!state.completed[index];button.disabled=true;
      await mutation(()=>invoke('onSubtaskComplete',item.record,index,done,{expectedVersion:item.record.version,expectedTaskVersion:item.parentRecord.version}),done?'子计划已完成':'已撤销子计划完成');if(!disposed)render();return;
    }
    if(action==='today'){selectedDate=today();month=selectedDate.slice(0,7);render();return;}
    if(action==='month-prev'||action==='month-next'){const [year,mon]=month.split('-').map(Number);const next=new Date(year,mon-1+(action==='month-next'?1:-1),1);selectedDate=dateText(next);month=selectedDate.slice(0,7);render();return;}
    if(action==='focus-toggle'){
      if(timer.running){tick();timer.running=false;timer.deadline=0;}
      else{if(timer.saved){notify('本次记录已保存，请先重置再开始。');return;}if(timer.remaining<=0){notify('本次专注已结束，请保存记录或重置。');return;}if(!timer.startedAt)timer.startedAt=Date.now();timer.deadline=Date.now()+timer.remaining*1000;timer.running=true;}render();return;
    }
    if(action==='focus-reset'){
      if(timer.elapsed>=60&&!timer.saved&&!win.confirm('放弃本次尚未保存的专注记录？'))return;
      timer.remaining=timer.minutes*60;timer.elapsed=0;timer.startedAt=0;timer.running=false;timer.saved=false;render();return;
    }
    if(action==='focus-save'&&!timer.running&&timer.elapsed>=60&&!timer.saved){
      const item=entries().find(item=>item.id===timer.related), started=timer.startedAt || Date.now()-timer.elapsed*1000;
      const eventId=item?Number(item.instance.id2):null, eventType=item?Number(item.task.id3 || 1):null;
      if(item&&(!Number.isSafeInteger(eventId)||eventId<=0||!Number.isSafeInteger(eventType)||eventType<=0)){notify('关联事项的业务标识无效，请刷新后重新选择。',true);return;}
      const record={time:started,date:dateText(new Date(started)),goodCount:timer.remaining<=0?1:0,badCount:0,minutes:timer.elapsed/60,log:item?JSON.stringify({eventId,eventTitle:item.title,eventType,endTime:new Date().toString()}):new Date().toString()};
      const saved=await mutation(()=>invoke('onSaveFocus',record),'专注记录已保存');if(saved)timer.saved=true;render();
    }
  }
  function change(event) {
    if(seriesPreview&&!writeBusy&&editor.contains(event.target)){cancelSeriesPreview();notify('草稿已变化，请重新预览整个系列。',true);}
    if(event.target.name==='attachmentFiles'){stageAttachments(event.target.files);event.target.value='';return;}
    if(editor.contains(event.target))editorDirty=true;
    if(writeBusy&&event.target.name?.startsWith('focus-'))return;
    if(event.target.name==='status-filter'){
      if(['pending','all','completed'].includes(event.target.value)){statusFilter=event.target.value;render();root.querySelector('[name="status-filter"]')?.focus();}return;
    }
    if(event.target.name==='noTime'||event.target.name==='allDay'){
      const form=event.target.closest('form'),noTime=Boolean(form.querySelector('[name="noTime"]')?.checked),allDay=Boolean(form.querySelector('[name="allDay"]')?.checked);
      for(const name of ['startDate','endDate','allDay']){const field=form.querySelector(`[name="${name}"]`);if(field)field.disabled=noTime;}
      for(const name of ['startTime','endTime']){const field=form.querySelector(`[name="${name}"]`);if(field)field.disabled=noTime||allDay;}return;
    }
    if(event.target.name==='quadrant'){
      const form=event.target.closest('form'),[important,urgent]=event.target.value.split(':');form.querySelector('[name="important"]').checked=important==='1';form.querySelector('[name="urgent"]').checked=urgent==='1';return;
    }
    if(event.target.name==='important'||event.target.name==='urgent'){
      const form=event.target.closest('form'),select=form.querySelector('[name="quadrant"]');if(select)select.value=`${+form.querySelector('[name="important"]').checked}:${+form.querySelector('[name="urgent"]').checked}`;
    }
    if(event.target.name==='focus-minutes'&&!timer.running){const value=Number(event.target.value);if(!Number.isInteger(value)||value<1||value>180){event.target.value=String(timer.minutes);return;}if(timer.elapsed&&!timer.saved){event.target.value=String(timer.minutes);notify('请先保存或重置本次专注，再修改时长。');return;}timer.minutes=value;timer.remaining=value*60;timer.elapsed=0;timer.startedAt=0;timer.saved=false;render();}
    if(event.target.name==='focus-related'&&!timer.running)timer.related=event.target.value;
  }
  function input(event) {
    activity();
    if(seriesPreview&&!writeBusy&&editor.contains(event.target)){cancelSeriesPreview();notify('草稿已变化，请重新预览整个系列。',true);}
    if(editor.contains(event.target))editorDirty=true;
    if(event.target.name==='subplan-name'&&subplanDraft?.canEdit){const item=subplanDraft.items.find(item=>item.key===event.target.dataset.subplanKey);if(item)item.title=event.target.value;subplanError('');}
    if(event.target.name==='content'){const preview=editor.querySelector('[data-note-preview]');if(preview)preview.innerHTML=renderSafeMarkdown(doc,event.target.value,options.renderMarkdown);}
  }
  function keydown(event) {
    activity();
    if(recoveryState){
      if(event.key==='Escape'){event.preventDefault();closeSeriesRecovery();return;}
      if(event.key==='Tab'){
        const buttons=[...recoveryState.layer.querySelectorAll('button')].filter(button=>!button.disabled&&!button.hidden);if(!buttons.length){event.preventDefault();return;}
        const current=buttons.indexOf(doc.activeElement),next=event.shiftKey?(current<=0?buttons.length-1:current-1):(current+1)%buttons.length;event.preventDefault();buttons[next].focus();return;
      }
    }
    const imagePreview=root.querySelector('.bd-attachment-preview');
    if(imagePreview){if(event.key==='Escape'){event.preventDefault();closeAttachmentPreview();}else if(event.key==='Tab'){event.preventDefault();imagePreview.querySelector('button')?.focus();}return;}
    if(event.key==='Escape'&&editorOpen){event.preventDefault();closeEditor();return;}
    if(event.key==='Enter'&&!event.isComposing&&event.keyCode!==229&&event.target.name==='subplan-title'){event.preventDefault();addSubplan();return;}
    if(event.key==='Enter'&&!event.isComposing&&event.keyCode!==229&&event.target.name==='subplan-name'){event.preventDefault();editor.querySelector('[name="subplan-title"]')?.focus();return;}
    const cell=event.target.closest?.('button[data-date]');if(!cell)return;
    const movements={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7};
    if(!(event.key in movements)&&!['Home','End'].includes(event.key))return;
    event.preventDefault();const date=new Date(selectedDate+'T12:00:00'),weekday=(date.getDay()+6)%7;
    date.setDate(date.getDate()+(event.key==='Home'?-weekday:event.key==='End'?6-weekday:movements[event.key]));selectedDate=dateText(date);month=selectedDate.slice(0,7);render();root.querySelector(`[data-date="${selectedDate}"]`)?.focus();
  }
  function dragStart(event) {
    activity();
    const card=event.target.closest?.('[data-occurrence][draggable]');if(!card||writeBusy||!ready||view!=='quadrant'){event.preventDefault();return;}
    const action=event.target.closest?.('button');if(action&&action.dataset.action!=='move-task'){event.preventDefault();return;}
    draggingId=card.dataset.occurrence;card.classList.add('bd-task--dragging');
    if(event.dataTransfer){event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-biandan-occurrence',draggingId);event.dataTransfer.setData('text/plain','biandan:'+draggingId);}
  }
  function dragOver(event) {
    if(editor.contains(event.target)&&editor.querySelector('form[data-form$="task"]')&&Array.from(event.dataTransfer?.types||[]).includes('Files')){event.preventDefault();editor.querySelector('[data-attachment-zone]')?.classList.add('bd-attachments--drop');return;}
    const quadrant=event.target.closest?.('[data-quadrant]');if(!quadrant||!draggingId||writeBusy)return;
    event.preventDefault();root.querySelectorAll('.bd-quadrant--drop').forEach(node=>node.classList.remove('bd-quadrant--drop'));quadrant.classList.add('bd-quadrant--drop');if(event.dataTransfer)event.dataTransfer.dropEffect='move';
  }
  function dragEnd() {draggingId='';root.querySelectorAll('.bd-quadrant--drop,.bd-task--dragging').forEach(node=>node.classList.remove('bd-quadrant--drop','bd-task--dragging'));}
  async function drop(event) {
    activity();
    if(editor.contains(event.target)&&editor.querySelector('form[data-form$="task"]')&&event.dataTransfer?.files?.length){event.preventDefault();editor.querySelector('[data-attachment-zone]')?.classList.remove('bd-attachments--drop');stageAttachments(event.dataTransfer.files);return;}
    const quadrant=event.target.closest?.('[data-quadrant]'),businessId=draggingId;if(!quadrant||!businessId||writeBusy)return;
    event.preventDefault();const item=entries().find(item=>item.id===businessId),key=quadrant.dataset.quadrant;dragEnd();
    if(!item||!quadrantDefinitions.some(def=>def[1]===key))return;
    const [important,urgent]=key.split(':').map(value=>value==='1');if((Number(item.task.isImportant)===1)===important&&(Number(item.task.isUrgency)===1)===urgent)return;
    await mutation(()=>invoke('onMoveQuadrant',item.parentRecord,{important,urgent},{expectedVersion:item.parentRecord.version}),'待办已移到新的象限');if(!disposed)render();
  }
  function paste(event) {
    if(!editor.contains(event.target)||!editor.querySelector('form[data-form$="task"]'))return;
    const files=Array.from(event.clipboardData?.items||[]).filter(item=>item.kind==='file'&&String(item.type).startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);
    if(!files.length)return;
    event.preventDefault();activity();stageAttachments(files);
  }
  function toggle(event) {
    if(!event.target.matches?.('details[data-subplans]'))return;
    const id=event.target.dataset.subplans;if(event.target.open)collapsedSubplans.delete(id);else collapsedSubplans.add(id);
  }
  function dragLeave(event) {
    const zone=editor.querySelector('[data-attachment-zone]');if(zone&&!zone.contains(event.relatedTarget))zone.classList.remove('bd-attachments--drop');
  }
  function tick() {
    if(disposed||!timer.running)return;
    const remaining=Math.max(0,(timer.deadline-Date.now())/1000), consumed=Math.max(0,timer.remaining-remaining);
    timer.elapsed+=consumed;timer.remaining=remaining;
    const display=root.querySelector('[data-focus-time]');if(display)display.textContent=formatTime(timer.remaining);
    if(remaining<=0){timer.running=false;timer.deadline=0;notify('本次专注已结束，可以保存记录。');if(view==='focus')render();}
  }
  const interval=win.setInterval(tick,500);
  function activity(){options.noteActivity?.();}
  const listeners={click,submit,change,input,keydown,paste,toggle,pointerdown:activity,scroll:activity,dragstart:dragStart,dragover:dragOver,dragleave:dragLeave,drop,dragend:dragEnd};
  for(const [name,listener]of Object.entries(listeners))root.addEventListener(name,listener,name==='scroll'||name==='toggle');
  render();
  const unsubscribe=typeof options.subscribeSnapshots==='function'?options.subscribeSnapshots(receiveSnapshot):null;
  void refreshSeriesMarker();
  void refresh({force:false});
  return {refresh,applySnapshot,isInteracting:()=>writeBusy||editorOpen||Boolean(draggingId)||Boolean(seriesPreview)||Boolean(recoveryState)||Boolean(root.querySelector('.bd-attachment-preview')),dispose(){if(disposed)return;disposed=true;++generation;++editorGeneration;++seriesMarkerGeneration;subplanDraft=null;disposeSeriesState();disposeAttachments();win.clearInterval(interval);if(typeof unsubscribe==='function')unsubscribe();for(const [name,listener]of Object.entries(listeners))root.removeEventListener(name,listener,name==='scroll'||name==='toggle');root.remove();if(!hadHostClass)host.classList.remove('bd-plugin-host');}};
}
