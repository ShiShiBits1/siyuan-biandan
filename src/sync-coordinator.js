const TABLES={Task:'tasks',showTask:'occurrences',favorites:'lists',tomato:'focus'};
const clone=value=>structuredClone(value);
const validRecord=row=>row&&typeof row==='object'&&typeof row.id==='string'&&row.id&&row.attributes&&typeof row.attributes==='object'&&!Array.isArray(row.attributes)&&row.version!==undefined&&row.version!==null;
function validRows(rows){return Array.isArray(rows)&&rows.every(validRecord)&&new Set(rows.map(row=>row.id)).size===rows.length;}
function validateSnapshot(value){
  if(!value||!Object.values(TABLES).every(key=>validRows(value[key])))throw new Error('云端快照尚未完整确认，请稍后刷新');
  return clone(value);
}
const authorizationError=error=>error?.code==='AUTH_REQUIRED'||error?.code==='reauthorization_required'||error?.status===401;
const clearedError=()=>Object.assign(new Error('账号连接已变化，请重新读取便单'),{code:'AUTH_REQUIRED'});

/** A memory-only, shared view of verified cloud reads. Writes remain immediate;
 * only the redundant whole-account reconciliation waits for an idle moment. */
export function createSyncCoordinator({loadSnapshot,idleMs=3000,intervalMs=60000,now=Date.now,setTimer=globalThis.setTimeout,clearTimer=globalThis.clearTimeout,isInteracting=()=>false,isVisible=()=>true}={}){
  if(typeof loadSnapshot!=='function'||!Number.isFinite(idleMs)||idleMs<1||!Number.isFinite(intervalMs)||intervalMs<idleMs)throw new Error('便单空闲刷新配置无效');
  let snapshot=null,disposed=false,epoch=0,writeRevision=0,cacheRevision=0,invalidation=0,lastSyncedAt=null,lastActivity=now();
  let reading=null,writing=false,writeSettled=null,settleWrite=null,capture=null,status='cleared',lastError=null;
  let idleTimer=null,periodicTimer=null,wanted=false,active=false;
  const listeners=new Set();
  const currentSnapshot=()=>snapshot?clone(snapshot):null;
  function state(){return{snapshot:currentSnapshot(),status,error:lastError,revision:cacheRevision,writing,syncing:status==='syncing'&&!!reading,needsRefresh:wanted,lastSyncedAt};}
  function broadcast(){
    if(disposed)return;
    for(const listener of [...listeners]){try{listener(state());}catch{/* One closed view cannot interrupt a confirmed save. */}}
  }
  function cancelIdle(){if(idleTimer!==null){clearTimer(idleTimer);idleTimer=null;}}
  function armPeriodic(){
    if(disposed||!active||periodicTimer!==null)return;
    periodicTimer=setTimer(()=>{periodicTimer=null;if(disposed||!active)return;requestRefresh();armPeriodic();},intervalMs);
    periodicTimer?.unref?.();
  }
  function activate(){active=true;armPeriodic();}
  function scheduleIdle(delay){
    cancelIdle();if(disposed||!active||!wanted)return;
    const quietDelay=Math.max(0,idleMs-(now()-lastActivity));
    idleTimer=setTimer(async()=>{
      idleTimer=null;if(disposed||!wanted||!active)return;
      if(!isVisible()){scheduleIdle(intervalMs);return;}
      if(writing||isInteracting()||now()-lastActivity<idleMs){scheduleIdle(Math.max(1000,idleMs));return;}
      try{await load({force:true});}catch{/* Preserve the last verified snapshot and expose an error, never replay a write. */}
    },delay??quietDelay);
    idleTimer?.unref?.();
  }
  function requestRefresh(){if(disposed)return;invalidation++;wanted=true;scheduleIdle();}
  function noteActivity(){if(disposed)return;lastActivity=now();if(wanted)scheduleIdle();}
  function reset(){
    if(disposed)return;
    epoch++;writeRevision++;cacheRevision++;invalidation++;snapshot=null;lastSyncedAt=null;lastError=null;status='cleared';wanted=false;
    capture=null;cancelIdle();reading=null;broadcast();
  }
  async function load({force=false}={}){
    if(disposed)throw new Error('便单页面已关闭');
    activate();
    const requestedEpoch=epoch;
    if(writing){await writeSettled;if(disposed)throw new Error('便单页面已关闭');if(requestedEpoch!==epoch)throw clearedError();}
    if(snapshot&&!force)return currentSnapshot();
    if(reading)return reading.promise.then(clone);
    const token={epoch,writeRevision,invalidation,promise:null};
    token.promise=Promise.resolve().then(async()=>{
      try{
        const next=validateSnapshot(await loadSnapshot());
        if(disposed)throw new Error('便单页面已关闭');
        if(token.epoch!==epoch)throw clearedError();
        if(token.writeRevision!==writeRevision||writing){
          wanted=true;
          if(writing)await writeSettled;
          if(disposed||token.epoch!==epoch)throw clearedError();
          if(snapshot)return currentSnapshot();
          throw new Error('便单已发生保存，请稍后重新读取');
        }
        snapshot=next;cacheRevision++;lastSyncedAt=now();wanted=token.invalidation!==invalidation;status='ready';lastError=null;cancelIdle();broadcast();
        return currentSnapshot();
      }catch(error){
        if(!disposed&&token.epoch===epoch){
          if(authorizationError(error)){reset();lastError=clearedError();broadcast();}
          else{status='error';lastError=error;wanted=true;broadcast();}
        }
        throw error;
      }finally{
        if(reading===token){reading=null;if(wanted)scheduleIdle(status==='error'?intervalMs:undefined);}
      }
    });
    reading=token;
    status='syncing';lastError=null;broadcast();
    return token.promise.then(clone);
  }
  function observe(kind,type,value){
    if(disposed||!capture||capture.epoch!==epoch||!TABLES[kind])return;
    if(type==='replace'&&!validRows(value)||type==='upsert'&&!validRecord(value))return;
    capture.evidence.push({kind,type,value:clone(value)});
  }
  function observeClient(client){
    const wrapped={...client};
    for(const method of ['get','list','update','remove']){
      if(typeof client[method]!=='function')continue;
      wrapped[method]=async(...args)=>{
        const origin={epoch,batch:capture};
        const result=await client[method](...args),kind=args[0];
        if(origin.epoch!==epoch||!origin.batch||origin.batch!==capture)return result;
        if(method==='list')observe(kind,'replace',result);
        else if(method==='remove'){
          if(result?.deleted===true&&result.id===args[1])observe(kind,'remove',args[1]);
        }else observe(kind,'upsert',result);
        return result;
      };
    }
    // A POST acknowledgement is intentionally not a cache update. The business
    // writer verifies it with full records from subsequent list/get calls.
    return wrapped;
  }
  function mergeEvidence(batch){
    if(!snapshot||batch.epoch!==epoch)return;
    const next=clone(snapshot);
    for(const item of batch.evidence){
      const key=TABLES[item.kind];
      if(item.type==='replace')next[key]=clone(item.value);
      else if(item.type==='remove')next[key]=next[key].filter(row=>row.id!==item.value);
      else{
        const index=next[key].findIndex(row=>row.id===item.value.id);
        if(index<0)next[key].push(clone(item.value));else next[key][index]=clone(item.value);
      }
    }
    if(JSON.stringify(next)!==JSON.stringify(snapshot)){snapshot=next;cacheRevision++;}
  }
  async function performWrite(operation){
    if(disposed)throw new Error('便单页面已关闭');
    if(typeof operation!=='function')throw new Error('便单保存操作无效');
    if(writing)throw new Error('另一便单页面正在保存，请稍后再操作');
    if(!snapshot)await load();
    if(writing)throw new Error('另一便单页面正在保存，请稍后再操作');
    const batch={epoch,evidence:[]};
    writing=true;writeRevision++;capture=batch;
    writeSettled=new Promise(resolve=>{settleWrite=resolve;});
    let failure;
    try{return await operation();}
    catch(error){failure=error;throw error;}
    finally{
      if(capture===batch)capture=null;
      if(!disposed&&batch.epoch===epoch){
        mergeEvidence(batch);writeRevision++;
        if(authorizationError(failure)){reset();lastError=clearedError();}
        else{status=failure?'error':'ready';lastError=failure??null;wanted=true;}
      }
      writing=false;settleWrite?.();settleWrite=null;writeSettled=null;
      if(!disposed&&batch.epoch===epoch){lastActivity=now();broadcast();scheduleIdle();}
    }
  }
  function subscribe(listener){
    if(typeof listener!=='function'||disposed)return()=>{};
    activate();listeners.add(listener);listener(state());
    return()=>{
      listeners.delete(listener);
      if(!listeners.size){active=false;cancelIdle();if(periodicTimer!==null){clearTimer(periodicTimer);periodicTimer=null;}}
    };
  }
  function dispose(){
    if(disposed)return;disposed=true;epoch++;capture=null;cancelIdle();if(periodicTimer!==null)clearTimer(periodicTimer);
    listeners.clear();snapshot=null;active=false;
  }
  return{load,subscribe,getSnapshot:currentSnapshot,noteActivity,requestRefresh,performWrite,observeClient,reset,dispose,getState:state};
}
