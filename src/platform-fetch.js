class MobileTransportError extends Error{}
const HOSTS=new Set(['oauth-login.cloud.huawei.com','auth.biandangroup.com','driveapis.cloud.huawei.com.cn']);
const HEADERS=new Set(['accept','content-type','authorization','x-hw-sync-env','x-hw-app-version','x-hw-trace-id']);
const QUERIES=new Set(['fields','pageSize','cursor','baseversion']);
const abortError=()=>Object.assign(new MobileTransportError('请求已取消；写入结果请先核查'),{name:'AbortError'});
const utf8Length=value=>new TextEncoder().encode(value).length;
function trustedOrigin(value){
  let url;try{url=new URL(value);}catch{throw new MobileTransportError('无法确认思源连接地址，未发送便单凭据');}
  const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback))throw new MobileTransportError('请使用思源本机客户端或HTTPS连接便单，未通过局域网明文发送凭据');
  return url.origin;
}
function destination(input,method){
  let url;try{url=new URL(String(input));}catch{throw new MobileTransportError('便单请求地址无效');}
  if(url.protocol!=='https:'||!HOSTS.has(url.hostname)||url.username||url.password||url.port||url.hash)throw new MobileTransportError('便单请求目标不受支持');
  if(url.hostname==='oauth-login.cloud.huawei.com'){
    if(method!=='POST'||url.pathname!=='/oauth2/v3/token'||url.search)throw new MobileTransportError('不支持的华为授权接口');
  }else if(url.hostname==='auth.biandangroup.com'){
    if(method!=='POST'||!['/v1/device','/v1/refresh'].includes(url.pathname)||url.search)throw new MobileTransportError('不支持的便单续期接口');
  }else{
    const base='/sync/v1/rongqi';
    const record=new RegExp('^'+base+'/kinds/(Task|showTask|favorites|tomato)/record(?:/([^/]+))?$').exec(url.pathname);
    if(url.pathname===base+'/about'){if(method!=='GET')throw new MobileTransportError('不支持的便单容器请求');}
    else if(!record||(record[2]?!['GET','PATCH','DELETE'].includes(method):!['GET','POST'].includes(method)))throw new MobileTransportError('不支持的便单数据接口');
    if(record?.[2]){let segment;try{segment=decodeURIComponent(record[2]);}catch{throw new MobileTransportError('云记录路径编码无效');}if(!segment||['.','..'].includes(segment)||/[\\/\x00-\x1f\x7f]/.test(segment))throw new MobileTransportError('云记录路径无效');}
    for(const key of url.searchParams.keys())if(!QUERIES.has(key)||url.searchParams.getAll(key).length!==1)throw new MobileTransportError('便单请求参数不受支持');
  }
  return url;
}
function base64(text){
  const bytes=new TextEncoder().encode(text);let binary='';
  for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
  return btoa(binary);
}
async function responseText(response,limit,signal){
  if(response.body?.getReader){
    const reader=response.body.getReader(),decoder=new TextDecoder();let bytes=0,text='',completed=false;
    try{while(true){if(signal.aborted)throw abortError();const result=await waitFor(reader.read(),signal);if(result.done){completed=true;break;}bytes+=result.value.byteLength;if(bytes>limit)throw new MobileTransportError('便单响应超过读取上限');text+=decoder.decode(result.value,{stream:true});}return text+decoder.decode();}
    finally{if(!completed)void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{/* A cancelled pending read may release asynchronously. */}}
  }
  const text=await waitFor(response.text(),signal);if(utf8Length(text)>limit)throw new MobileTransportError('便单响应超过读取上限');return text;
}
function waitFor(promise,signal){
  if(signal.aborted)return Promise.reject(abortError());
  return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(abortError());};signal.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});});
}

/** Same-origin kernel transport for mobile WebViews. Upstream redirects are
 * disabled; no credential is put in the proxy URL or a synced configuration. */
export function createSiyuanProxyFetch({fetcher=globalThis.fetch,origin=globalThis.location?.origin,timeoutMs=30000,maxResponseBytes=16*1024*1024}={}){
  return async(input,options={})=>{
    if(typeof fetcher!=='function'||!Number.isFinite(timeoutMs)||timeoutMs<1||!Number.isSafeInteger(maxResponseBytes)||maxResponseBytes<1||maxResponseBytes>16*1024*1024)throw new MobileTransportError('移动网络配置无效');
    const source=trustedOrigin(origin),method=String(options.method||'GET').toUpperCase(),url=destination(input,method);
    if(options.signal?.aborted)throw abortError();
    let headers;try{headers=new Headers(options.headers||{});}catch{throw new MobileTransportError('便单请求头格式无效，未发送请求');}
    const forwarded={};
    for(const [key,value]of headers){if(!HEADERS.has(key)||/[\r\n]/.test(value))throw new MobileTransportError('便单请求头不受支持');forwarded[key]=value;}
    const body=options.body??'';
    if(typeof body!=='string'||utf8Length(body)>16*1024*1024||['GET','HEAD'].includes(method)&&body)throw new MobileTransportError('便单请求正文不受支持');
    const controller=new AbortController(),cancel=()=>controller.abort();options.signal?.addEventListener('abort',cancel,{once:true});
    const timer=setTimeout(cancel,timeoutMs);
    try{
      const response=await waitFor(fetcher(source+'/api/network/forwardProxy',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({url:url.href,method,timeout:timeoutMs,headers:[forwarded],contentType:headers.get('content-type')||'application/json',payloadEncoding:'base64',payload:base64(body),responseEncoding:'text',redirect:false})}),controller.signal);
      if(!response.ok)throw new MobileTransportError('思源网络代理不可用，请检查当前客户端连接');
      const raw=await responseText(response,maxResponseBytes*2+65536,controller.signal);let envelope;
      try{envelope=JSON.parse(raw);}catch{throw new MobileTransportError('思源网络代理返回格式无效');}
      const data=envelope?.data;
      if(envelope?.code!==0||!data||data.url!==url.href||!Number.isInteger(data.status)||data.status<100||data.status>599||data.bodyEncoding!=='text'||typeof data.body!=='string'||!data.headers||typeof data.headers!=='object'||Array.isArray(data.headers))throw new MobileTransportError('思源网络代理未确认便单响应，请先核查');
      if(utf8Length(data.body)>maxResponseBytes)throw new MobileTransportError('便单响应超过读取上限');
      const resultHeaders=new Map();for(const [key,values]of Object.entries(data.headers)){if(!Array.isArray(values)||values.some(value=>typeof value!=='string'))throw new MobileTransportError('便单响应头无法确认');resultHeaders.set(key.toLowerCase(),values.join(', '));}
      if(controller.signal.aborted)throw abortError();
      return {ok:data.status>=200&&data.status<300,status:data.status,headers:{get:key=>resultHeaders.get(String(key).toLowerCase())??null},text:async()=>data.body,json:async()=>JSON.parse(data.body)};
    }catch(error){if(controller.signal.aborted)throw abortError();if(error instanceof MobileTransportError)throw error;throw new MobileTransportError('便单移动网络连接失败；写操作请先刷新核查，未自动重试');}
    finally{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);}
  };
}
