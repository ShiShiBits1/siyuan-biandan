import {createMobileCredentialStore} from './mobile-store.js';

const CLIENT_ID='5765880207852987515';
const REDIRECT_URI='https://www.biandangroup.com/#/biandan_online';
const AUTHORIZE_URL='https://oauth-login.cloud.huawei.com/oauth2/v3/authorize';
const TOKEN_URL='https://oauth-login.cloud.huawei.com/oauth2/v3/token';
const RENEWAL_ROOT='https://auth.biandangroup.com/v1';
const STATE_PATTERN=/^biandan-local-v1\.[A-Za-z0-9_-]{43}$/;
const VERIFIER_PATTERN=/^[A-Za-z0-9_-]{43}$/;
const emptyPacket=()=>({version:1,credentials:null,attempt:null});
const textEncoder=new TextEncoder();
export class BiandanMobileAuthError extends Error{constructor(message,code='AUTH_ERROR'){super(message);this.name='BiandanMobileAuthError';this.code=code;}}
const error=(message,code)=>new BiandanMobileAuthError(message,code);
const base64url=bytes=>{let text='';for(const byte of bytes)text+=String.fromCharCode(byte);return btoa(text).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};
function checkedPacket(value){
  if(value===null||value===undefined)return emptyPacket();
  if(value.version!==1||!Object.hasOwn(value,'credentials')||!Object.hasOwn(value,'attempt'))throw error('本机移动授权格式无效，原数据已保留；请明确断开后重新授权','STATE_INVALID');
  const credential=value.credentials,attempt=value.attempt;
  if(credential!==null&&(!credential||typeof credential.refresh_token!=='string'||!credential.refresh_token||credential.refresh_token.length>16384||typeof credential.device_grant!=='string'||credential.device_grant.length>16384))throw error('移动续期凭据格式无效，未读取桌面授权','STATE_INVALID');
  if(attempt!==null&&(!attempt||!STATE_PATTERN.test(attempt.state)||!VERIFIER_PATTERN.test(attempt.verifier)||!Number.isSafeInteger(attempt.expiresAt)||!['pending','consuming'].includes(attempt.phase)))throw error('移动授权流程记录无法确认，请明确取消后重新授权','STATE_INVALID');
  return structuredClone({version:1,credentials:credential,attempt});
}
function authorizationURL(attempt,challenge){
  const url=new URL(AUTHORIZE_URL);
  for(const [key,value]of Object.entries({response_type:'code',client_id:CLIENT_ID,redirect_uri:REDIRECT_URI,scope:'openid profile',state:attempt.state,code_challenge:challenge,code_challenge_method:'S256',access_type:'offline'}))url.searchParams.set(key,value);
  return url.href;
}
function callbackValue(value,state){
  if(typeof value!=='string'||value.length>16384)throw error('请粘贴浏览器地址栏中的完整本机回调地址，不要只填写授权码','AUTH_CALLBACK_INVALID');
  let url;try{url=new URL(value.trim());}catch{throw error('回调地址格式无效，请复制完整地址','AUTH_CALLBACK_INVALID');}
  if(url.origin!=='http://127.0.0.1:42681'||url.pathname!=='/biandan/callback'||url.username||url.password||url.hash)throw error('只接受本次授权生成的127.0.0.1:42681本机回调地址','AUTH_CALLBACK_INVALID');
  const fields=url.searchParams;
  if([...fields.keys()].some(key=>!['state','code','error'].includes(key))||fields.getAll('state').length!==1||fields.get('state')!==state)throw error('回调与本机本次授权不匹配，请回到当前授权页重新复制','AUTH_STATE_MISMATCH');
  const codes=fields.getAll('code'),errors=fields.getAll('error');
  if(errors.length===1&&errors[0]&&codes.length===0)return {denied:true};
  if(codes.length!==1||!codes[0]||errors.length!==0)throw error('回调必须包含唯一授权码或唯一拒绝状态','AUTH_CALLBACK_INVALID');
  return {code:codes[0]};
}
function waitFor(promise,signal){
  if(signal.aborted)return Promise.reject(error('授权请求已取消','AUTH_CANCELLED'));
  return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(error('授权请求已取消或超时，请重新操作；未自动重试','AUTH_CANCELLED'));};signal.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},failure=>{signal.removeEventListener('abort',abort);reject(failure);});});
}

/** Independent mobile OAuth. Only its own device-local encrypted store is
 * used; desktop refresh/device grants and workspace auth files are untouched. */
export function createMobileBiandanAuth({fetcher=globalThis.fetch,store=createMobileCredentialStore(),openExternal,cryptoProvider=globalThis.crypto,timeoutMs=300000,requestTimeoutMs=30000,now=Date.now}={}){
  let packet=emptyPacket(),loaded=false,loading=null,disposed=false,generation=0,connecting=null,completing=null,refreshing=null;
  let accessToken='',expiresAt=0,authorizationUrl='',saveQueue=Promise.resolve(),controlQueue=Promise.resolve(),controlTransitions=0;
  const requests=new Set();
  const current=epoch=>{if(disposed||epoch!==generation)throw error('本次授权流程已结束，请重新操作','AUTH_CANCELLED');};
  const capability=()=>{if(!cryptoProvider?.subtle||!cryptoProvider?.getRandomValues||typeof fetcher!=='function'||!store?.load||!store?.save||!store?.clear||typeof now!=='function'||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>300000||!Number.isFinite(requestTimeoutMs)||requestTimeoutMs<1||requestTimeoutMs>60000)throw error('当前思源移动环境缺少安全授权能力，未使用明文保存；请更新客户端','SECURE_STORAGE_UNAVAILABLE');};
  const noControlTransition=()=>{if(controlTransitions)throw error('本机授权正在切换，请等待连接或取消操作结束','AUTH_PENDING');};
  async function challenge(verifier){return base64url(new Uint8Array(await cryptoProvider.subtle.digest('SHA-256',textEncoder.encode(verifier))));}
  async function ensureLoaded(){
    capability();if(disposed)throw error('便单移动连接已关闭','AUTH_CANCELLED');if(loaded)return;if(loading)return loading;
    const epoch=generation;
    const task=(async()=>{
      let stored;
      try{stored=await store.load();}catch(failure){throw error(failure?.message||'本机加密授权无法读取，原数据已保留','STATE_READ_FAILED');}
      current(epoch);packet=checkedPacket(stored);loaded=true;
      if(packet.attempt?.phase==='pending'&&packet.attempt.expiresAt>now())authorizationUrl=authorizationURL(packet.attempt,await challenge(packet.attempt.verifier));
      current(epoch);
    })().finally(()=>{if(loading===task)loading=null;});loading=task;return task;
  }
  function persist(next,epoch){
    current(epoch);
    const intended=checkedPacket(next);
    const result=saveQueue.catch(()=>{}).then(async()=>{
      current(epoch);try{await store.save(intended);}catch(failure){throw error(failure?.message||'本机授权保存未确认，未保存明文','STATE_SAVE_FAILED');}current(epoch);packet=intended;loaded=true;
    });saveQueue=result;return result;
  }
  function controlTransition(operation,{reload=true}={}){
    if(disposed)return Promise.reject(error('便单移动连接已关闭','AUTH_CANCELLED'));
    // Abort old network work immediately, but wait for any already dispatched
    // encrypted save before reading the latest pair and constructing a change.
    // A committed rotation must never be replaced by an old in-memory packet.
    controlTransitions++;generation++;const epoch=generation;
    for(const request of requests)request.abort();
    loaded=false;loading=null;refreshing=null;
    const result=controlQueue.catch(()=>{}).then(async()=>{
      current(epoch);await saveQueue.catch(()=>{});current(epoch);
      if(reload){
        capability();let latest;
        try{latest=await store.load();}catch(failure){throw error(failure?.message||'本机加密授权无法重新核实，未覆盖原数据','STATE_READ_FAILED');}
        current(epoch);packet=checkedPacket(latest);loaded=true;
      }
      return operation(epoch);
    }).finally(()=>{controlTransitions--;});
    controlQueue=result;return result;
  }
  async function requestJSON(url,init,epoch){
    current(epoch);const controller=new AbortController();requests.add(controller);
    const timer=setTimeout(()=>controller.abort(),requestTimeoutMs);
    try{
      const response=await waitFor(fetcher(url,{...init,signal:controller.signal,redirect:'error'}),controller.signal);current(epoch);
      let body;try{body=await waitFor(response.json(),controller.signal);}catch(failure){if(controller.signal.aborted)throw failure;throw error('授权服务返回格式无效，请重新操作','AUTH_RESPONSE_INVALID');}
      current(epoch);return {response,body};
    }catch(failure){current(epoch);if(failure instanceof BiandanMobileAuthError)throw failure;throw error('移动授权服务暂时无法连接；已有授权已保留，未自动重试','AUTH_NETWORK_ERROR');}
    finally{clearTimeout(timer);requests.delete(controller);}
  }
  function tokenFields(body,fallbackRefresh=''){
    const seconds=Number(body?.expires_in),refresh=body?.refresh_token===undefined?fallbackRefresh:body.refresh_token;
    if(typeof body?.access_token!=='string'||!body.access_token||!['number','string'].includes(typeof body?.expires_in)||!Number.isFinite(seconds)||seconds<=0||typeof refresh!=='string'||!refresh||refresh.length>16384)throw error('授权服务没有返回有效的配套凭据，原数据未替换','AUTH_RESPONSE_INVALID');
    return {token:body.access_token,refresh,expiresAt:now()+Math.max(0,seconds-Math.min(60,seconds/10))*1000};
  }
  async function renew(){
    noControlTransition();await ensureLoaded();noControlTransition();if(packet.attempt)throw error('请先完成或取消当前移动授权，再访问便单','AUTH_PENDING');
    if(!packet.credentials)throw error('请在这台移动设备上单独连接便单，不会复用桌面凭据','AUTH_REQUIRED');if(refreshing)return refreshing;
    const epoch=generation,previous={...packet.credentials};
    const renewal=(async()=>{
      const headers={'Content-Type':'application/json',Accept:'application/json'};if(previous.device_grant)headers.Authorization='Bearer '+previous.device_grant;
      const {response,body}=await requestJSON(RENEWAL_ROOT+(previous.device_grant?'/refresh':'/device'),{method:'POST',headers,body:JSON.stringify({refresh_token:previous.refresh_token})},epoch);
      if(!response.ok){
        if(response.status===401&&[body?.error,body?.code,body?.error_code].includes('reauthorization_required')){await persist({...packet,credentials:null},epoch);accessToken='';expiresAt=0;throw error('这台移动设备的便单授权已失效，请重新授权','AUTH_REQUIRED');}
        if(response.status===403)throw error('本机续期凭据不匹配，请重新授权；未反复登记设备','AUTH_FORBIDDEN');
        if(response.status===429){const failure=error('续期请求过于频繁，请稍后重试','AUTH_RATE_LIMITED'),retry=Number(response.headers?.get?.('retry-after'));if(Number.isFinite(retry)&&retry>=0)failure.retryAfterSeconds=retry;throw failure;}
        throw error('移动授权续期暂未成功，原凭据已保留','AUTH_RENEWAL_FAILED');
      }
      const fields=tokenFields(body,previous.refresh_token);
      if(typeof body.device_grant!=='string'||!body.device_grant||body.device_grant.length>16384)throw error('续期响应缺少配套设备凭据，未覆盖原授权','AUTH_RESPONSE_INVALID');
      await persist({...packet,credentials:{refresh_token:fields.refresh,device_grant:body.device_grant}},epoch);accessToken=fields.token;expiresAt=fields.expiresAt;return accessToken;
    })().finally(()=>{if(refreshing===renewal)refreshing=null;});refreshing=renewal;return renewal;
  }
  async function connect(){
    if(connecting)return connecting;
    connecting=controlTransition(async epoch=>{
      let attempt=packet.attempt;
      if(!attempt||attempt.phase!=='pending'||attempt.expiresAt<=now()){
        const state='biandan-local-v1.'+base64url(cryptoProvider.getRandomValues(new Uint8Array(32))),verifier=base64url(cryptoProvider.getRandomValues(new Uint8Array(32)));
        attempt={state,verifier,expiresAt:Math.floor(now()+timeoutMs),phase:'pending'};
        await persist({...packet,attempt},epoch);
      }
      current(epoch);authorizationUrl=authorizationURL(attempt,await challenge(attempt.verifier));current(epoch);accessToken='';expiresAt=0;
      if(typeof openExternal==='function'){try{await openExternal(authorizationUrl);}catch{/* The returned explicit link remains usable when a popup is blocked. */}}
      current(epoch);return {pending:true,manual:true,authorizationUrl,expiresAt:attempt.expiresAt};
    }).finally(()=>{connecting=null;});return connecting;
  }
  async function completeAuthorization(value){
    noControlTransition();
    if(completing)return completing;
    completing=(async()=>{
      await ensureLoaded();noControlTransition();const epoch=generation,attempt=packet.attempt;
      if(!attempt)throw error('本机没有待完成的移动授权，请先点击连接便单','AUTH_REQUIRED');
      if(attempt.expiresAt<=now()){await persist({...packet,attempt:null},epoch);authorizationUrl='';throw error('本次授权已超过5分钟，请重新打开授权页','AUTH_TIMEOUT');}
      if(attempt.phase!=='pending')throw error('本次授权码已尝试换取凭据，结果不确定时不能重复使用；请重新授权','AUTH_CODE_CONSUMED');
      const received=callbackValue(value,attempt.state);
      if(received.denied){await persist({...packet,attempt:null},epoch);authorizationUrl='';throw error('华为授权已取消或被拒绝，可重新连接','AUTH_DENIED');}
      // Persist one-time consumption before dispatch, including across WebView
      // reloads. A timeout never causes an automatic code-exchange replay.
      await persist({...packet,attempt:{...attempt,phase:'consuming'}},epoch);authorizationUrl='';
      const form=new URLSearchParams({grant_type:'authorization_code',client_id:CLIENT_ID,redirect_uri:REDIRECT_URI,code:received.code,code_verifier:attempt.verifier});
      const {response,body}=await requestJSON(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:form.toString()},epoch);
      if(!response.ok)throw error('授权码换取凭据未成功，请重新授权；未重复使用该授权码','AUTH_EXCHANGE_FAILED');
      const fields=tokenFields(body);
      await persist({version:1,credentials:{refresh_token:fields.refresh,device_grant:''},attempt:null},epoch);accessToken=fields.token;expiresAt=fields.expiresAt;return {connected:true};
    })().finally(()=>{completing=null;});return completing;
  }
  async function cancelAuthorization(){
    return controlTransition(async epoch=>{await persist({...packet,attempt:null},epoch);authorizationUrl='';});
  }
  async function disconnect(){
    accessToken='';expiresAt=0;authorizationUrl='';
    return controlTransition(async epoch=>{
      const result=saveQueue.catch(()=>{}).then(async()=>{current(epoch);await store.clear();current(epoch);packet=emptyPacket();loaded=true;});saveQueue=result;return result;
    },{reload:false});
  }
  return {connect,completeAuthorization,cancelAuthorization,
    async getAccessToken({forceRefresh=false}={}){noControlTransition();await ensureLoaded();noControlTransition();if(packet.attempt)throw error('请先完成或取消当前移动授权','AUTH_PENDING');if(!forceRefresh&&accessToken&&now()<expiresAt)return accessToken;return renew();},
    disconnect,
    async status(){if(controlTransitions)await controlQueue.catch(()=>{});await ensureLoaded();const pendingAuthorization=Boolean(packet.attempt);return {connected:Boolean(packet.credentials||accessToken),pendingAuthorization,loaded,...(pendingAuthorization&&authorizationUrl?{authorizationUrl,expiresAt:packet.attempt.expiresAt}:{})};},
    dispose(){if(disposed)return;disposed=true;generation++;for(const request of requests)request.abort();store.dispose?.();},
  };
}
