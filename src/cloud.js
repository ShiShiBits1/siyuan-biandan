const BASE = 'https://driveapis.cloud.huawei.com.cn/sync/v1/rongqi';
const KINDS = new Set(['Task', 'showTask', 'favorites', 'tomato']);
const RECORD_FIELDS = 'kind,id,attributes,createdTime,editedTime,version';
const LIST_FIELDS = `nextCursor,records(${RECORD_FIELDS})`;

export class BiandanCloudError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'BiandanCloudError'; this.status = status; }
}
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const hasFailure = value => Array.isArray(value) ? value.length > 0 : object(value) ? Object.keys(value).length > 0 : Boolean(value);
const INTEGER_COLUMNS = new Set(['id1','id2','id3','time','isCollectible','isImportant','isUrgency','isLoop','haveNoTime','unitTimeNumber','loopSet','loopBaseNumber','loopUnit','duration','isRemind','isFinish','completedCount','favoritesColor','goodCount','badCount']);
function sameAttribute(key,actual,expected) {
  // The native sync service may represent INTEGER columns as decimal strings.
  // Compare only known integer columns semantically; notes and unknown fields
  // still require an exact JSON match.
  if (INTEGER_COLUMNS.has(key) && Number.isSafeInteger(expected) && /^-?\d+$/.test(String(actual))) {
    try { return BigInt(actual) === BigInt(expected); } catch {}
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}
function normalizeRecord(value) {
  if (!object(value)) throw new BiandanCloudError('便单返回了无效记录');
  const record = {...value};
  const id = value.recordID ?? value.id;
  if (typeof id === 'number' && !Number.isSafeInteger(id)) throw new BiandanCloudError('云记录 ID 超出安全整数范围，请使用字符串 ID');
  if (id !== undefined && id !== null) record.id = String(id);
  if (!object(value.attributes) && object(value.fields)) {
    record.attributes = Object.fromEntries(Object.entries(value.fields).map(([key,item]) => [key,object(item) && Object.hasOwn(item,'value') ? item.value : item]));
  }
  return record;
}
function unwrap(value) {
  if (object(value?.record)) return normalizeRecord(value.record);
  if (Array.isArray(value?.records) && value.records.length === 1) return normalizeRecord(value.records[0]);
  return normalizeRecord(value);
}
function validateAttributes(value) {
  if (!object(value) || !Object.keys(value).length) throw new BiandanCloudError('记录属性不能为空');
  const visit = (item,seen = new Set()) => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') {if (!Number.isFinite(item)) throw new BiandanCloudError('记录不能包含无效数值');return;}
    if (typeof item !== 'object' || seen.has(item)) throw new BiandanCloudError('记录必须是有效 JSON 属性');
    seen.add(item);for (const child of Object.values(item)) visit(child,seen);seen.delete(item);
  };
  visit(value);
  for (const key of ['id1','id2','id3','time']) if (typeof value[key] === 'number' && !Number.isSafeInteger(value[key])) throw new BiandanCloudError('业务 ID 超出安全整数范围');
}
function pathFor(kind,id) {
  if (!KINDS.has(kind)) throw new BiandanCloudError('不支持的便单数据表');
  if (id === undefined) return `/kinds/${kind}/record`;
  if (typeof id !== 'string' || !id.trim()) throw new BiandanCloudError('云记录 ID 无效');
  return `/kinds/${kind}/record/${encodeURIComponent(id)}`;
}

/** Direct Huawei sync client. Tokens never leave the fixed sync origin. */
export function createBiandanClient({fetcher = globalThis.fetch, getAccessToken, timeoutMs = 25000, loadPendingWrites, savePendingWrites} = {}) {
  if (typeof fetcher !== 'function' || typeof getAccessToken !== 'function') throw new Error('便单授权配置无效');
  async function request(method,path,params = {},attributes) {
    const url = new URL(BASE + path);
    for (const [name,value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(name,String(value));
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await getAccessToken(attempt ? {forceRefresh:true} : undefined);
      if (typeof token !== 'string' || !token) throw new BiandanCloudError('请先授权便单云端账号',401);
      const headers = {Accept:'application/json',Authorization:`Bearer ${token}`,'x-hw-sync-env':'dataSync2DP','x-hw-app-version':'16.3.0.001','x-hw-trace-id':`07200_02_${Date.now()}_${Math.floor(Math.random()*1e8).toString().padStart(8,'0')}`};
      if (attributes !== undefined) headers['Content-Type'] = 'application/json';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(),timeoutMs);
      let response;
      try { response = await fetcher(url.href,{method,headers,redirect:'error',signal:controller.signal,...(attributes !== undefined ? {body:JSON.stringify({attributes})} : {})}); }
      catch { throw new BiandanCloudError(['POST','PATCH','DELETE'].includes(method) ? '便单写入结果未确认，请刷新核查后再操作' : '便单云端连接失败，请稍后重试'); }
      finally { clearTimeout(timer); }
      if (response.status === 401 && !attempt) continue;
      if (!response.ok) {
        const messages = {401:'便单授权已失效，请重新授权',403:'当前授权不能访问便单数据',409:'记录已在其他客户端修改，请刷新后重试',429:'便单请求过于频繁，请稍后重试'};
        throw new BiandanCloudError(messages[response.status] || `便单云端请求失败（${response.status}）`,response.status);
      }
      let value;
      try {
        if (typeof response.text === 'function') {
          const raw = await response.text();
          value = raw ? JSON.parse(raw) : ['POST','PATCH','DELETE'].includes(method) ? {} : null;
        } else if (response.status === 204 && ['POST','PATCH','DELETE'].includes(method)) value = {};
        else value = await response.json();
      } catch { throw new BiandanCloudError('便单返回格式无效；写入操作请先刷新核查'); }
      if (!object(value) || hasFailure(value.error) || hasFailure(value.errors)) throw new BiandanCloudError('便单未确认本次请求，请刷新核查结果');
      return value;
    }
  }
  async function get(kind,id) {
    const record = unwrap(await request('GET',pathFor(kind,id),{fields:RECORD_FIELDS}));
    if (record.id !== id || !object(record.attributes) || record.version === undefined || record.version === null) throw new BiandanCloudError('云记录身份、属性或版本无法确认');
    return record;
  }
  async function list(kind,{pageSize = 100} = {}) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new BiandanCloudError('单页数量应为 1–100');
    pathFor(kind);
    const records = [],seen = new Set(),cursors = new Set();
    let cursor;
    for (let page = 0; page < 10000; page++) {
      const data = await request('GET',pathFor(kind),{fields:LIST_FIELDS,pageSize,cursor});
      const rows = data?.records ?? data?.recordList;
      if (!Array.isArray(rows)) throw new BiandanCloudError('便单列表响应无效，未显示不完整结果');
      for (const row of rows) {
        let record = normalizeRecord(row);
        if (!record.id || seen.has(record.id)) throw new BiandanCloudError('便单返回重复或无效记录，结果不完整');
        if (!object(record.attributes) || record.version === undefined || record.version === null) record = await get(kind,record.id);
        seen.add(record.id); records.push(record);
      }
      const next = data.nextCursor;
      if (next === undefined || next === null || next === '') return records;
      if (typeof next !== 'string' || cursors.has(next)) throw new BiandanCloudError('便单分页游标重复或无效，结果不完整');
      cursors.add(next); cursor = next;
    }
    throw new BiandanCloudError('便单分页超出安全上限，结果不完整');
  }
  async function create(kind,attributes) {
    validateAttributes(attributes);
    const value = await request('POST',pathFor(kind),{fields:RECORD_FIELDS},attributes);
    return unwrap(value);
  }
  async function update(kind,id,expectedVersion,changes) {
    validateAttributes(changes);
    if (expectedVersion === undefined || expectedVersion === null) throw new BiandanCloudError('修改前请先读取记录版本');
    const identities = {Task:['id1'],showTask:['id1','id2'],favorites:['id3'],tomato:['time']};
    pathFor(kind,id);
    if (identities[kind].some(key => Object.hasOwn(changes,key))) throw new BiandanCloudError('不能修改记录业务 ID');
    const current = await get(kind,id);
    if (String(current.version) !== String(expectedVersion)) throw new BiandanCloudError('记录已在其他客户端修改，请刷新后重试',409);
    const merged = {...current.attributes,...changes};
    const raw = await request('PATCH',pathFor(kind,id),{baseversion:current.version},merged);
    // Even when PATCH returns only an acknowledgement, expose verified current data.
    const result = await get(kind,id);
    for (const [key,value] of Object.entries(changes)) if (!sameAttribute(key,result.attributes[key],value)) throw new BiandanCloudError('便单保存结果尚未核对，请刷新查看');
    return {...result,acknowledgement:raw};
  }
  async function remove(kind,id,expectedVersion) {
    pathFor(kind,id);
    if (expectedVersion === undefined || expectedVersion === null) throw new BiandanCloudError('删除前请先读取记录版本');
    const current = await get(kind,id);
    if (String(current.version) !== String(expectedVersion)) throw new BiandanCloudError('记录已在其他客户端修改，请刷新后重新确认删除',409);
    if (kind === 'favorites' && /^0*1$/.test(String(current.attributes.id3))) throw new BiandanCloudError('不能删除默认待办单');
    let writeError;
    try { await request('DELETE',pathFor(kind,id),{baseversion:current.version}); }
    catch (error) {
      if (error.status >= 400 && error.status < 500) throw error;
      writeError = error;
    }
    // A timeout can follow a committed DELETE. Reconcile using read-only
    // pagination, never send another DELETE to resolve an uncertain result.
    try {
      if ((await list(kind)).some(record => record.id === id)) throw new Error('record remains');
      return {id,deleted:true};
    } catch {
      throw Object.assign(new BiandanCloudError('删除结果尚未核对，请刷新检查；未重复发送删除请求'),{recordId:id,commitState:'unknown',...(writeError ? {cause:writeError} : {})});
    }
  }
  return {get,list,create,update,remove,loadPendingWrites,savePendingWrites,checkConnection:() => request('GET','/about'),async snapshot() {
    const [tasks,occurrences,lists,focus] = await Promise.all(['Task','showTask','favorites','tomato'].map(kind => list(kind)));
    return {tasks,occurrences,lists,focus};
  }};
}
