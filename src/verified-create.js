/** Verified single-table creates. The durable journal never contains names,
 * notes, logs or credentials: only a SHA-256 fingerprint and business identity. */
export function createVerifiedWriter({client,loadPending,savePending}) {
  if (!client || typeof loadPending !== 'function' || typeof savePending !== 'function') throw new Error('新增记录的检查配置不完整');
  let queue = Promise.resolve();
  const serialize = operation => {const result = queue.catch(() => {}).then(operation);queue = result;return result;};
  const id = value => {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
    if (!/^\d+$/.test(String(value ?? ''))) return '';
    try {const result = BigInt(value);return result > 0n && result <= BigInt(Number.MAX_SAFE_INTEGER) ? result.toString() : '';} catch {return '';}
  };
  const identityField = kind => kind === 'favorites' ? 'id3' : 'time';
  async function fingerprint(kind,fields) {
    const bytes = new TextEncoder().encode(JSON.stringify([kind,fields]));
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value => value.toString(16).padStart(2,'0')).join('');
  }
  async function journal() {
    const stored = await loadPending();
    if (stored === undefined || stored === null) return {version:1,entries:[]};
    if (stored.version !== 1 || !Array.isArray(stored.entries) || stored.entries.length > 50 || stored.entries.some(entry =>
      !entry || !['favorites','tomato'].includes(entry.kind) || !/^[a-f0-9]{64}$/.test(entry.fingerprint) || !id(entry.businessId) ||
      (entry.sortIndex !== undefined && (entry.kind !== 'favorites' || !Number.isInteger(entry.sortIndex) || entry.sortIndex < 0 || entry.sortIndex > 999999)))) throw new Error('新增记录检查日志无效，已停止写入');
    if (new Set(stored.entries.map(entry => entry.kind+':'+entry.businessId)).size !== stored.entries.length || new Set(stored.entries.map(entry => entry.fingerprint)).size !== stored.entries.length) throw new Error('新增记录检查日志有重复项，已停止写入');
    return structuredClone(stored);
  }
  async function save(value) {await savePending(structuredClone(value));}
  function sameFields(record,expected) {
    const attrs = record?.attributes;
    if (!attrs || !record.id) return false;
    return Object.entries(expected).every(([key,value]) => {
      if (key === 'id3' || key === 'time') return id(attrs[key]) === id(value);
      if (['favoritesColor','goodCount','badCount'].includes(key) && Number.isSafeInteger(value) && /^\d+$/.test(String(attrs[key]))) {
        try { return BigInt(attrs[key]) === BigInt(value); } catch {}
      }
      return JSON.stringify(attrs[key]) === JSON.stringify(value);
    });
  }
  function byIdentity(rows,kind,businessId) {
    if (!Array.isArray(rows)) throw new Error('便单记录列表无效，未进行新增');
    return rows.filter(row => id(row?.attributes?.[identityField(kind)]) === businessId);
  }
  function uncertain(entry,cause) {
    return Object.assign(new Error(`新增结果尚待核查，业务 ID ${entry.businessId}。请刷新核对，未重复提交。`),{kind:entry.kind,businessId:entry.businessId,commitState:'unknown',...(cause ? {cause} : {})});
  }
  async function clear(pending,entry) {
    const next = {...pending,entries:pending.entries.filter(item => item.fingerprint !== entry.fingerprint)};
    await save(next);
  }
  async function recover(pending,entry,fields,rows) {
    const matches = byIdentity(rows,entry.kind,entry.businessId);
    if (matches.length !== 1 || !sameFields(matches[0],fields)) throw uncertain(entry);
    try {await clear(pending,entry);} catch (cause) {throw uncertain(entry,cause);}
    return matches[0];
  }
  async function create(kind,fieldsWithoutIdentity,{stableId} = {}) {
    const key = await fingerprint(kind,fieldsWithoutIdentity);
    const pending = await journal();
    const rows = await client.list(kind);
    const previous = pending.entries.find(entry => entry.fingerprint === key || (stableId && entry.kind === kind && entry.businessId === stableId));
    if (previous) {
      if (previous.fingerprint !== key) throw uncertain(previous);
      const fields = {...fieldsWithoutIdentity,...(kind === 'favorites' ? {favoritesColor:(previous.sortIndex ?? 0)*100+fieldsWithoutIdentity.favoritesColor} : {}),[identityField(kind)]:Number(previous.businessId)};
      return recover(pending,previous,fields,rows);
    }
    if (stableId) {
      const existing = byIdentity(rows,kind,stableId);
      if (existing.length) {
        if (existing.length === 1 && sameFields(existing[0],fieldsWithoutIdentity)) return existing[0];
        throw new Error('该时刻已有不同的专注记录，请刷新核对，不会覆盖或重复新增');
      }
    }
    if (pending.entries.length >= 50) throw new Error('待核查新增已达上限，请先核对已有结果');
    let businessId = stableId;
    if (!businessId) {
      const used = new Set(rows.map(row => id(row?.attributes?.id3)));
      for (let attempt=0;attempt<10;attempt++) {
        const random = new Uint32Array(1);crypto.getRandomValues(random);
        const candidate = Date.now()*1000 + random[0]%1000;
        if (Number.isSafeInteger(candidate) && candidate > 1 && !used.has(String(candidate))) {businessId=String(candidate);break;}
      }
      if (!businessId) throw new Error('无法分配待办单 ID，请稍后重试');
    }
    // Keep the input fingerprint stable across retries. The selected append
    // position is stored alongside the allocated ID so a newly committed list
    // cannot change its own recovery fingerprint or be submitted twice.
    const sortIndex = kind === 'favorites' ? rows.reduce((max,row) => {
      const value = Number(row?.attributes?.favoritesColor ?? 0);
      return Number.isSafeInteger(value) && value >= 0 ? Math.max(max,Math.floor(value/100)) : max;
    },0)+1 : undefined;
    if (sortIndex !== undefined && sortIndex > 999999) throw new Error('待办单排序已超出可用范围，请先核查已有清单');
    const fields = {...fieldsWithoutIdentity,...(kind === 'favorites' ? {favoritesColor:sortIndex*100+fieldsWithoutIdentity.favoritesColor} : {}),[identityField(kind)]:Number(businessId)};
    const entry = {kind,fingerprint:key,businessId,...(sortIndex === undefined ? {} : {sortIndex})};
    pending.entries.push(entry);
    // Failure to save this intent must stop before any cloud write.
    await save(pending);
    let writeError;
    try {await client.create(kind,fields);} catch (cause) {writeError=cause;}
    // An ACK is never proof. Even a timed-out POST may already have committed.
    try {return await recover(pending,entry,fields,await client.list(kind));}
    catch (cause) {throw uncertain(entry,writeError || cause);}
  }
  return {
    createList(name,{color = 0} = {}) {
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 200 || /[\x00-\x1f\x7f]/.test(name)) return Promise.reject(new Error('请输入不超过 200 字的待办单名称'));
      if (!Number.isInteger(color) || color < 0 || color > 24) return Promise.reject(new Error('请选择 0–24 范围内的待办单颜色'));
      const fields = {favoritesName:name.trim(),favoritesColor:color};
      return serialize(() => create('favorites',fields));
    },
    saveFocus(attributes) {
      if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes) || Object.keys(attributes).some(key => !['time','date','goodCount','badCount','minutes','log'].includes(key))) return Promise.reject(new Error('专注记录字段无效'));
      const stableId = id(attributes.time),date = attributes.date;
      const parsed = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(date+'T12:00:00') : null;
      const dateValid = parsed && !Number.isNaN(parsed.getTime()) && `${parsed.getFullYear()}-${String(parsed.getMonth()+1).padStart(2,'0')}-${String(parsed.getDate()).padStart(2,'0')}` === date;
      const started = stableId ? new Date(Number(stableId)) : null;
      const startDate = started && !Number.isNaN(started.getTime()) ? `${started.getFullYear()}-${String(started.getMonth()+1).padStart(2,'0')}-${String(started.getDate()).padStart(2,'0')}` : '';
      if (!stableId || !dateValid || startDate !== date || !Number.isFinite(attributes.minutes) || attributes.minutes < 1 || !['goodCount','badCount'].every(key => Number.isSafeInteger(attributes[key]) && attributes[key] >= 0) || typeof attributes.log !== 'string' || attributes.log.length > 20000) return Promise.reject(new Error('专注记录的日期、时长或计数无效'));
      const fields = {time:Number(stableId),date,goodCount:attributes.goodCount,badCount:attributes.badCount,minutes:attributes.minutes,log:attributes.log};
      return serialize(() => create('tomato',fields,{stableId}));
    },
  };
}
