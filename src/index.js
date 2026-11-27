import {Plugin,openTab,Setting,showMessage,Dialog,getFrontend,getBackend,platformUtils} from 'siyuan';
import {createBiandanAuth} from './auth.js';
import {createBiandanClient} from './cloud.js';
import {businessID,createOneOff,setOccurrenceCompleted,setSubtaskCompleted} from './model.js';
import {createDesktopFetch} from './desktop-fetch.js';
import {createSiyuanProxyFetch} from './platform-fetch.js';
import {createMobileCredentialStore} from './mobile-store.js';
import {createMobileBiandanAuth} from './mobile-auth.js';
import {createMobilePage} from './mobile-page.js';
import {createVerifiedWriter} from './verified-create.js';
import {createPluginStateReader} from './plugin-state.js';
import {updateTask,previewTaskDeletion,deleteTask,updateList,previewListDeletion,deleteList} from './operations.js';
import {previewBatchTaskDeletion,deleteTaskBatch} from './batch-delete.js';
import {createSyncCoordinator} from './sync-coordinator.js';
import {createSiyuanAttachmentStore} from './attachments.js';
import {createSeriesSubplanEditor} from './series-subplans.js';
import {mountBiandanApp} from '../ui/app.js';
import {brandIcon} from '../ui/brand.js';
import '../ui/app.css';
const ICON=`<symbol id="iconBiandanCompanion" viewBox="0 0 24 24"><image href="${brandIcon}" width="24" height="24" preserveAspectRatio="xMidYMid meet"/></symbol>`;
export default class BiandanCompanion extends Plugin{
  async onload(){
    this.dead=false;this.controllers=new Map();this.attachmentSettings={notebookId:''};
    this.isMobile=['mobile','browser-mobile'].includes(getFrontend());this.platform=getBackend();
    const nodeRequire=this.isMobile?undefined:globalThis.require||globalThis.window?.require;
    const fetcher=this.isMobile?createSiyuanProxyFetch():createDesktopFetch(nodeRequire);
    const state=createPluginStateReader();
    const saveState=(name,value)=>state.saveChecked(name,value,(file,data)=>this.saveData(file,data));
    let preferencesTimeout;
    this.attachmentSettingsReady=Promise.race([state.load('attachment-settings.json'),new Promise((_,reject)=>{preferencesTimeout=setTimeout(()=>reject(new Error('附件设置读取超时')),10000);})]).then(value=>{
      if(value!==null&&(value?.version!==1||typeof value.notebookId!=='string'||value.notebookId!==''&&!/^\d{14}-[a-z0-9]{7}$/.test(value.notebookId)))throw new Error('附件保存设置格式无效');
      if(!this.dead&&value)this.attachmentSettings={version:1,notebookId:value.notebookId};
    }).catch(()=>{if(!this.dead)this.attachmentSettingsError='附件保存设置无法读取，原文件已保留；请在设置中重新选择笔记本';}).finally(()=>clearTimeout(preferencesTimeout));
    this.attachments=createSiyuanAttachmentStore({getNotebook:async()=>{await this.attachmentSettingsReady;if(this.dead)throw new Error('插件已关闭');if(this.attachmentSettingsError)throw new Error(this.attachmentSettingsError);return this.attachmentSettings.notebookId;},loadIndex:()=>state.load('attachment-index.json'),saveIndex:value=>saveState('attachment-index.json',value)});
    const openExternal=url=>{if(this.isMobile)return platformUtils.openByMobile(url);if(!nodeRequire)throw new Error('请在思源客户端连接便单');return nodeRequire('electron').shell.openExternal(url);};
    this.auth=this.isMobile?createMobileBiandanAuth({fetcher,store:createMobileCredentialStore(),openExternal}):createBiandanAuth({fetcher,nodeRequire,openExternal,loadState:()=>state.load('cloud-auth.json'),saveState:value=>saveState('cloud-auth.json',value)});
    const rawClient=createBiandanClient({fetcher,getAccessToken:options=>this.auth.getAccessToken(options),loadPendingWrites:()=>state.load('pending-writes.json'),savePendingWrites:value=>saveState('pending-writes.json',value)});
    this.sync=createSyncCoordinator({loadSnapshot:()=>rawClient.snapshot(),isInteracting:()=>[...this.controllers.values()].some(controller=>controller.isInteracting?.()),isVisible:()=>document.visibilityState!=='hidden'&&[...this.controllers.keys()].some(model=>model.element.isConnected&&model.element.getClientRects().length>0)});
    this.client=this.sync.observeClient(rawClient);
    this.seriesSubplans=createSeriesSubplanEditor({client:this.client,loadPending:()=>state.load('series-subplans.json'),savePending:value=>saveState('series-subplans.json',value)});
    this.onVisibilityChange=()=>{if(document.visibilityState!=='hidden')this.sync.noteActivity();};
    document.addEventListener('visibilitychange',this.onVisibilityChange);
    this.verified=createVerifiedWriter({client:this.client,loadPending:()=>state.load('simple-pending.json'),savePending:value=>saveState('simple-pending.json',value)});
    this.addIcons(ICON);
    const plugin=this;
    if(this.isMobile){
      this.mobilePage=createMobilePage({Dialog,mount:model=>this.mount(model),unmount:model=>{this.controllers.get(model)?.dispose();this.controllers.delete(model);},canClose:model=>!this.sync.getState().writing&&!this.controllers.get(model)?.isInteracting?.(),onBlocked:()=>showMessage('请先保存或取消当前编辑、授权或核查操作，再关闭便单页面。')});
    }else this.addTab({type:'companion',init(){plugin.mount(this);},destroy(){plugin.controllers.get(this)?.dispose();plugin.controllers.delete(this);}});
    this.addTopBar({icon:'iconBiandanCompanion',title:'便单伴侣 · 第三方',callback:()=>this.open()});
    this.addCommand({langKey:'openBiandan',langText:'打开便单伴侣',hotkey:'',callback:()=>this.open()});
    this.setting=new Setting({width:'min(600px,90vw)'});
    this.setting.addItem({title:'便单云端连接',description:this.isMobile?'第三方客户端移动候选版。在系统浏览器授权后，将最终本机回调地址粘回插件。授权加密保存在当前设备的 WebView 中，不与桌面共享；清除应用数据后需要重新连接。':'第三方客户端。授权在华为页面完成，刷新凭据经系统加密后保存在当前设备。无需另启MCP服务。',createActionElement:()=>{const button=document.createElement('button');button.className='b3-button';button.textContent='打开便单伴侣';button.onclick=()=>this.open();return button;}});
    this.setting.addItem({title:'附件保存笔记本',description:'文件保存在思源资源库，首次上传时在所选笔记本生成附件索引，避免被清理未引用资源。随思源工作区同步；便单其他客户端不能保证打开。',createActionElement:()=>{
      const container=document.createElement('div'),select=document.createElement('select'),message=document.createElement('small');
      select.className='b3-select';select.setAttribute('aria-label','附件保存笔记本');select.disabled=true;message.setAttribute('role','status');message.style.display='block';message.style.marginTop='6px';message.textContent='正在读取笔记本…';container.append(select,message);
      void(async()=>{
        try{
          await this.attachmentSettingsReady;
          const response=await fetch('/api/notebook/lsNotebooks',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}'}),value=await response.json();
          if(!response.ok||value.code!==0||!Array.isArray(value.data?.notebooks))throw new Error('无法读取思源笔记本');
          if(this.dead)return;
          const empty=document.createElement('option');empty.value='';empty.textContent='请选择附件保存笔记本';select.append(empty);
          for(const book of value.data.notebooks){if(book.closed!==false)continue;const option=document.createElement('option');option.value=book.id;option.textContent=book.name;select.append(option);}
          if(this.attachmentSettings.notebookId&&![...select.options].some(option=>option.value===this.attachmentSettings.notebookId)){const original=document.createElement('option');original.value=this.attachmentSettings.notebookId;original.textContent='原保存笔记本未打开';original.disabled=true;select.append(original);}
          select.value=this.attachmentSettings.notebookId;select.disabled=false;message.textContent=this.attachmentSettingsError||'仅在保存任务时上传，移除关联或取消编辑不会删除源文件。';
        }catch{message.textContent='无法读取笔记本，请稍后重新打开设置。';}
      })();
      select.onchange=async()=>{
        const previous=this.attachmentSettings.notebookId,next={version:1,notebookId:select.value};select.disabled=true;
        try{if(this.dead)throw new Error('插件已关闭');if(window.siyuan?.config?.readonly)throw new Error('当前工作区为只读');if(this.sync.getState().writing)throw new Error('请等待当前保存结束后再更换笔记本');if(next.notebookId&&!/^\d{14}-[a-z0-9]{7}$/.test(next.notebookId))throw new Error('请选择有效笔记本');await saveState('attachment-settings.json',next);this.attachmentSettings=next;this.attachmentSettingsError=null;message.textContent='附件保存设置已保存；已有附件和索引不移动。';}
        catch(error){select.value=previous;message.textContent=error.message||'附件保存设置未获确认，请重试。';}
        finally{select.disabled=false;}
      };
      return container;
    }});
    this.setting.addItem({title:'断开连接',description:'清除本机保存的授权，不删除云端任务。',createActionElement:()=>{const button=document.createElement('button');button.className='b3-button b3-button--outline';button.textContent='清除本机授权';button.onclick=async()=>{try{if(this.sync.getState().writing)throw new Error('请等待当前保存结束后再断开连接');this.sync.reset();await this.auth.disconnect();}catch(e){showMessage(e.message);}};return button;}});
  }
  open(){if(this.isMobile)return this.mobilePage?.open();return openTab({app:this.app,custom:{id:this.name+'companion',icon:'iconBiandanCompanion',title:'便单伴侣',data:{}}});}
  mount(model){
    if(this.dead)return;
    const assertWrite=()=>{if(this.dead)throw new Error('插件已关闭');if(window.siyuan?.config?.readonly)throw new Error('当前工作区为只读');if(this.sync.getState().writing)throw new Error('另一便单页面正在保存，请稍后再操作');};
    const runWrite=operation=>{assertWrite();return this.sync.performWrite(operation);};
    const guardSeries=async(record,all=false)=>{
      const pending=await this.seriesSubplans.pendingLocal();
      if(!pending)return;
      const currentParent=this.sync.getSnapshot()?.tasks?.find(parent=>String(parent.id)===pending.taskRecordId&&businessID(parent.attributes?.id1)===pending.taskId);
      if(String(record?.id??'')===pending.taskRecordId&&businessID(record?.attributes?.id1)===pending.taskId||currentParent&&(all||businessID(record?.attributes?.id1)===pending.taskId))throw new Error('该系列有尚未完成的子计划调整，请先核查并继续；已保存的结果会保留。');
    };
    let markdownEngine;
    try{markdownEngine=window.Lute?.New?.();markdownEngine?.SetSanitize?.(true);markdownEngine?.SetHeadingID?.(false);}catch{/* The UI has a safe Markdown fallback. */}
    const controller=mountBiandanApp(model.element,{
      mobile:this.isMobile,platform:this.platform,onClose:this.isMobile?()=>this.mobilePage?.close():undefined,
      load:options=>this.sync.load(options),
      connect:()=>{if(this.connectionPromise)return this.connectionPromise;assertWrite();this.sync.reset();const connection=this.auth.connect().finally(()=>{if(this.connectionPromise===connection)this.connectionPromise=null;});this.connectionPromise=connection;return connection;},
      authorizationStatus:this.isMobile?()=>this.auth.status():undefined,
      completeAuthorization:this.isMobile?async url=>{assertWrite();const result=await this.auth.completeAuthorization(url);this.sync.reset();return result;}:undefined,
      cancelAuthorization:this.isMobile?()=>this.auth.cancelAuthorization():undefined,
      subscribeSnapshots:listener=>this.sync.subscribe(listener),
      noteActivity:()=>this.sync.noteActivity(),
      afterMutation:()=>{this.sync.requestRefresh();return {snapshot:this.sync.getSnapshot()};},
      renderMarkdown:source=>markdownEngine?.Md2HTML?.(String(source??''))??null,
      onCreate:draft=>runWrite(()=>createOneOff(this.client,{...draft,remark:draft.content??draft.remark})),
      onComplete:(record,done)=>runWrite(async()=>{await guardSeries(record);return setOccurrenceCompleted(this.client,record,done,{expectedVersion:record.version});}),
      onSubtaskComplete:(record,index,done,options)=>runWrite(async()=>{await guardSeries(record);return setSubtaskCompleted(this.client,record,index,done,options);}),
      onCreateList:(name,options)=>runWrite(()=>this.verified.createList(name,options)),
      onEditTask:(record,patch,options)=>runWrite(async()=>{await guardSeries(record);return updateTask(this.client,record,patch,options);}),
      onMoveQuadrant:(record,patch,options)=>runWrite(async()=>{await guardSeries(record);return updateTask(this.client,record,patch,options);}),
      onPreviewSeriesSubtasks:async(record,plan,options)=>{assertWrite();return this.seriesSubplans.preview(record,plan,options);},
      onApplySeriesSubtasks:(preview,options)=>runWrite(()=>this.seriesSubplans.apply(preview,options)),
      onSeriesPending:()=>this.seriesSubplans.pending(),
      onSeriesAffectedTask:async()=>{const pending=await this.seriesSubplans.pendingLocal();return pending?{taskRecordId:pending.taskRecordId,taskId:pending.taskId}:null;},
      onReconcileSeries:()=>this.seriesSubplans.reconcile(),
      onResumeSeries:options=>runWrite(()=>this.seriesSubplans.resume(options)),
      onPreviewDeleteTask:async(parent,occurrence,options)=>{assertWrite();await guardSeries(parent);return previewTaskDeletion(this.client,parent,occurrence,options);},
      onDeleteTask:(parent,occurrence,options)=>runWrite(async()=>{await guardSeries(parent);return deleteTask(this.client,parent,occurrence,{...options,assertTargetAllowed:target=>guardSeries(target.parentRecord)});}),
      onPreviewBatchDelete:async(targets,options)=>{assertWrite();return previewBatchTaskDeletion(this.client,targets,{...options,assertTargetAllowed:target=>guardSeries(target.parentRecord)});},
      onDeleteBatch:(preview,options)=>runWrite(()=>deleteTaskBatch(this.client,preview,{...options,assertTargetAllowed:target=>guardSeries(target.parentRecord)})),
      onEditList:(record,patch,options)=>runWrite(()=>updateList(this.client,record,patch,options)),
      onPreviewDeleteList:async(record,options)=>{assertWrite();await guardSeries(record,true);return previewListDeletion(this.client,record,options);},
      onDeleteList:(record,options)=>runWrite(async()=>{await guardSeries(record,true);return deleteList(this.client,record,options);}),
      onSaveFocus:attributes=>runWrite(()=>this.verified.saveFocus(attributes)),
      onUploadAttachments:(files,options)=>runWrite(()=>this.attachments.upload(files,options)),
      onOpenAttachment:descriptor=>this.attachments.open(descriptor,{openAsset:({path,url,name,mime})=>{
        if(this.isMobile){platformUtils.openByMobile(path);return {opened:true};}
        if(mime==='application/pdf')return openTab({app:this.app,pdf:{path}});
        if(mime.startsWith('image/'))return openTab({app:this.app,asset:{path}});
        const link=document.createElement('a');link.href=url;link.download=name;link.hidden=true;document.body.append(link);link.click();link.remove();
        return {downloadStarted:true};
      }}),
      onOpenSettings:()=>this.setting.open('便单伴侣 · 设置'),
    });
    this.controllers.set(model,controller);
  }
  onDataChanged(){}
  onunload(){this.dead=true;this.mobilePage?.dispose();this.sync?.dispose();document.removeEventListener('visibilitychange',this.onVisibilityChange);for(const c of this.controllers.values())c.dispose();this.controllers.clear();this.auth?.dispose();}
}
