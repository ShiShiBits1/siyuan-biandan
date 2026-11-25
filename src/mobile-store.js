const STORE='vault',KEY='device-key',STATE='state';
const textEncoder=new TextEncoder(),textDecoder=new TextDecoder();
const stateError=(message,code='MOBILE_STORAGE_UNAVAILABLE')=>Object.assign(new Error(message),{code});
const validKey=key=>key&&key.type==='secret'&&key.extractable===false&&key.algorithm?.name==='AES-GCM'&&key.algorithm.length===256&&Array.isArray(key.usages)&&key.usages.length===2&&key.usages.includes('encrypt')&&key.usages.includes('decrypt');
const bytes=value=>value instanceof Uint8Array||value instanceof ArrayBuffer;
const asBytes=value=>value instanceof Uint8Array?value:new Uint8Array(value);
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);

/** Device-local WebView storage, not an OS keychain. The non-exportable key
 * and authenticated ciphertext live only in IndexedDB, never plugin.saveData. */
export function createMobileCredentialStore({indexedDB=globalThis.indexedDB,cryptoProvider=globalThis.crypto,dbName='siyuan-biandan-mobile-v1',timeoutMs=10000}={}){
  let database=null,opening=null,disposed=false,queue=Promise.resolve();
  const serialize=operation=>{const result=queue.catch(()=>{}).then(operation);queue=result;return result;};
  function capability(){
    if(disposed)throw stateError('移动端凭据存储已关闭');
    if(!indexedDB?.open||!cryptoProvider?.subtle||!cryptoProvider?.getRandomValues||typeof dbName!=='string'||!/^siyuan-biandan-mobile[-A-Za-z0-9._]*$/.test(dbName)||!Number.isFinite(timeoutMs)||timeoutMs<1)throw stateError('当前思源移动环境缺少WebCrypto或IndexedDB，未保存明文凭据；请更新客户端');
  }
  function open(){
    capability();if(database)return Promise.resolve(database);if(opening)return opening;
    opening=new Promise((resolve,reject)=>{
      let request,settled=false;
      const finish=(error,value)=>{if(settled){value?.close();return;}settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
      const timer=setTimeout(()=>finish(stateError('移动端本地数据库打开超时，请关闭其他便单授权页面后重试')),timeoutMs);
      try{request=indexedDB.open(dbName,1);}catch{finish(stateError('无法打开设备本地数据库，未使用明文保存'));return;}
      request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'id'});};
      request.onerror=()=>finish(stateError('设备本地数据库打开失败，原数据未重置'));
      request.onblocked=()=>finish(stateError('设备本地数据库被其他页面占用，请关闭后重试'));
      request.onsuccess=()=>{
        const db=request.result;
        if(settled){db.close();return;}
        if(disposed){db.close();finish(stateError('移动端凭据存储已关闭'));return;}
        db.onversionchange=()=>{db.close();if(database===db)database=null;};database=db;finish(null,db);
      };
    }).finally(()=>{opening=null;});
    return opening;
  }
  async function transaction(mode,run){
    const db=await open();capability();
    return new Promise((resolve,reject)=>{
      let tx,result,settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
      const timer=setTimeout(()=>{try{tx?.abort();}catch{}finish(stateError('设备本地存储事务超时，保存结果未确认'));},timeoutMs);
      try{
        tx=db.transaction(STORE,mode);tx.oncomplete=()=>finish(null,result);tx.onerror=()=>finish(stateError('设备本地存储事务失败，原数据未覆盖'));tx.onabort=()=>finish(stateError('设备本地存储事务已中止，保存结果未确认'));
        const setResult=value=>{result=value;};
        run(tx.objectStore(STORE),setResult,error=>{try{tx.abort();}catch{}finish(error);});
      }catch{try{tx?.abort();}catch{}finish(stateError('当前WebView无法持久化加密密钥，未降级为明文'));}
    });
  }
  async function read(){
    return transaction('readonly',(store,result,fail)=>{
      let key,state,received=0;
      const complete=()=>{if(++received===2)result({key,state});};
      for(const [id,set]of [[KEY,value=>{key=value;}],[STATE,value=>{state=value;}]]){
        const request=store.get(id);request.onsuccess=()=>{set(request.result);complete();};request.onerror=()=>fail(stateError('无法读取设备本地加密数据'));
      }
    });
  }
  function validate(records){
    const key=records.key,state=records.state;
    if(key&&(key.version!==1||key.id!==KEY||typeof key.keyId!=='string'||!key.keyId||!validKey(key.key)))throw stateError('本机加密密钥格式异常，已保留原数据；请明确断开后重新授权','MOBILE_STORAGE_INVALID');
    if(state&&!key)throw stateError('已保存授权的本机密钥缺失，未创建新密钥覆盖旧数据；请明确断开后重新授权','MOBILE_STORAGE_INVALID');
    if(state&&(state.version!==1||state.id!==STATE||state.keyId!==key.keyId||typeof state.revision!=='string'||!state.revision||!bytes(state.iv)||asBytes(state.iv).length!==12||!bytes(state.ciphertext)||asBytes(state.ciphertext).length<16||asBytes(state.ciphertext).length>65536))throw stateError('本机加密授权格式异常，已保留原数据','MOBILE_STORAGE_INVALID');
    return records;
  }
  async function decrypt(records){
    validate(records);if(!records.state)return null;
    try{
      const plain=await cryptoProvider.subtle.decrypt({name:'AES-GCM',iv:asBytes(records.state.iv),additionalData:textEncoder.encode('siyuan-biandan-mobile-v1:'+records.key.keyId)},records.key.key,asBytes(records.state.ciphertext));
      const value=JSON.parse(textDecoder.decode(plain));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;
    }catch{throw stateError('本机授权无法通过加密校验，原数据已保留；请明确断开后重新授权','MOBILE_STORAGE_INVALID');}
  }
  async function load(){capability();return decrypt(await read());}
  async function save(value){
    return serialize(async()=>{
      capability();let intended,plain;
      try{plain=JSON.stringify(value);intended=JSON.parse(plain);}catch{throw stateError('授权状态无法序列化，未开始保存');}
      if(!intended||typeof intended!=='object'||Array.isArray(intended)||textEncoder.encode(plain).length>32768)throw stateError('授权状态格式或长度无效');
      const previous=validate(await read());
      // Existing ciphertext is checked before any replacement. A missing or
      // incompatible old key never causes silent regeneration.
      if(previous.state)await decrypt(previous);
      const random=length=>cryptoProvider.getRandomValues(new Uint8Array(length));
      const identifier=()=>Array.from(random(16),value=>value.toString(16).padStart(2,'0')).join('');
      let key=previous.key;
      if(!key){let generated;try{generated=await cryptoProvider.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);}catch{throw stateError('设备不支持所需加密，未保存明文授权');}if(!validKey(generated))throw stateError('设备返回了不受支持的加密密钥');key={id:KEY,version:1,keyId:identifier(),key:generated};}
      const iv=random(12);let ciphertext;
      try{ciphertext=new Uint8Array(await cryptoProvider.subtle.encrypt({name:'AES-GCM',iv,additionalData:textEncoder.encode('siyuan-biandan-mobile-v1:'+key.keyId)},key.key,textEncoder.encode(plain)));}catch{throw stateError('授权加密失败，未保存明文');}
      const state={id:STATE,version:1,keyId:key.keyId,revision:identifier(),iv,ciphertext};
      await transaction('readwrite',(store,result,fail)=>{
        let currentKey,currentState,received=0;
        const commit=()=>{
          if(++received!==2)return;
          if((currentKey?.keyId??null)!==(previous.key?.keyId??null)||(currentState?.revision??null)!==(previous.state?.revision??null)){fail(stateError('本机授权已在另一页面更新，请重新读取后重试','MOBILE_STORAGE_CONFLICT'));return;}
          try{store.put(key);store.put(state);result(true);}catch{fail(stateError('当前WebView无法持久化加密密钥，未降级为明文'));}
        };
        const k=store.get(KEY),s=store.get(STATE);k.onsuccess=()=>{currentKey=k.result;commit();};s.onsuccess=()=>{currentState=s.result;commit();};k.onerror=s.onerror=()=>fail(stateError('保存前无法核对设备本地授权'));
      });
      const confirmedRecords=await read();validate(confirmedRecords);
      if(confirmedRecords.key?.keyId!==key.keyId||confirmedRecords.state?.revision!==state.revision||!same(await decrypt(confirmedRecords),intended))throw stateError('本机授权保存未获独立确认，请先核查，未覆盖为明文');
    });
  }
  const clear=()=>serialize(()=>transaction('readwrite',(store,result)=>{store.delete(STATE);store.delete(KEY);result(true);}).then(async()=>{const records=await read();if(records.key||records.state)throw stateError('本机授权清除未获确认');}));
  return {load,save,clear,dispose(){disposed=true;database?.close();database=null;}};
}
