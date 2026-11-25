/** SiYuan assets only. This module never sends file bytes or credentials to
 * Biandan/Huawei and never treats a local asset URL as a native cloud file ID. */
export const MAX_ATTACHMENT_COUNT = 5;
export const MAX_ATTACHMENT_BYTES = 20*1024*1024;
export const ATTACHMENT_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip';
const TYPES = {
  png:['image/png'],jpg:['image/jpeg','image/pjpeg'],jpeg:['image/jpeg','image/pjpeg'],gif:['image/gif'],webp:['image/webp'],
  pdf:['application/pdf'],txt:['text/plain'],md:['text/markdown','text/plain','text/x-markdown'],csv:['text/csv','application/csv','text/plain','application/vnd.ms-excel'],
  doc:['application/msword'],docx:['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xls:['application/vnd.ms-excel'],xlsx:['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ppt:['application/vnd.ms-powerpoint'],pptx:['application/vnd.openxmlformats-officedocument.presentationml.presentation'],zip:['application/zip','application/x-zip-compressed'],
};
const IMAGES = new Set(['png','jpg','jpeg','gif','webp']);
const NODE_ID = /^\d{14}-[a-z0-9]{7}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const START = '<!-- siyuan-biandan-attachments:v1 -->';
const END = '<!-- /siyuan-biandan-attachments:v1 -->';
const META = '<!-- siyuan-biandan-attachments-data:v1:';
const HEADING = '### 思源附件（仅对应思源工作区可用）';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const safeName = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\\/\x00-\x1f\x7f]/.test(value) && value !== '.' && value !== '..';
const extension = value => String(value).split('.').at(-1).toLowerCase();
const aborted = signal => {if (signal?.aborted) throw Object.assign(new Error('附件上传已取消；已保存的资源不会删除'),{name:'AbortError',canceled:true});};
const markdownName = value => value.replace(/[\\`*_[\]{}<>!]/g,character => '\\'+character);
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value => value.toString(16).padStart(2,'0')).join('');

export function isSiyuanAssetPath(value) {
  if (typeof value !== 'string' || !value.startsWith('assets/') || value.length > 1000) return false;
  let decoded = value;
  try {
    for (let count=0;count<4;count++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {return false;}
  return !/[\\\x00-\x1f\x7f?#:%]/.test(decoded) && decoded.startsWith('assets/') && decoded.split('/').every(part => part && part !== '.' && part !== '..');
}

export function validateAttachmentFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function' || !safeName(file.name) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_ATTACHMENT_BYTES) throw new Error('请选择有效文件；每个附件须大于 0 字节且不超过 20 MiB');
  const ext = extension(file.name),allowed = TYPES[ext];
  if (!allowed) throw new Error('不支持此附件格式，请选择图片、PDF、文本、Office 文档或 ZIP');
  const declared = String(file.type || '').toLowerCase().split(';')[0].trim();
  if (declared && declared !== 'application/octet-stream' && !allowed.includes(declared)) throw new Error('文件类型与扩展名不一致，请核对原文件');
  return {name:file.name,size:file.size,mime:allowed[0],extension:ext,image:IMAGES.has(ext)};
}

export function validateAttachmentDescriptor(value) {
  if (!object(value) || value.kind !== 'siyuan-asset' || !safeName(value.name) || !isSiyuanAssetPath(value.path) || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_ATTACHMENT_BYTES || typeof value.mime !== 'string' || typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) throw new Error('思源附件引用无效；原引用已保留');
  const ext = extension(value.name),allowed = TYPES[ext];
  if (!allowed || !allowed.includes(value.mime) || extension(decodeURIComponent(value.path)) !== ext) throw new Error('思源附件格式或类型无法核对；原引用已保留');
  try {JSON.stringify(value);} catch {throw new Error('思源附件引用不是有效数据');}
  return clone(value);
}

function validateDescriptors(values) {
  if (!Array.isArray(values) || values.length > MAX_ATTACHMENT_COUNT) throw new Error('每条待办最多关联 5 个思源附件');
  const descriptors = values.map(validateAttachmentDescriptor);
  if (new Set(descriptors.map(value => value.path)).size !== descriptors.length) throw new Error('同一个思源附件不能重复关联');
  return descriptors;
}

export function getSiyuanAssetURL(value) {
  const path = typeof value === 'string' ? value : validateAttachmentDescriptor(value).path;
  if (!isSiyuanAssetPath(path) || !TYPES[extension(decodeURIComponent(path))]) throw new Error('只能打开当前思源工作区内受支持的附件资源');
  // Decode once for normal percent-encoded filenames, then encode each path
  // segment. Validation above rejects nested escapes, traversal and protocols.
  return '/'+decodeURIComponent(path).split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g,character => '%'+character.charCodeAt(0).toString(16).toUpperCase())).join('/');
}

function attachmentSegment(descriptors) {
  const metadata = JSON.stringify(descriptors).replace(/[<>&]/g,character => ({'<':'\\u003c','>':'\\u003e','&':'\\u0026'}[character]));
  const links = descriptors.map(value => `- [${markdownName(value.name)}](${getSiyuanAssetURL(value).slice(1)})`).join('\n');
  return `${START}\n${HEADING}\n${links}\n${META}${metadata} -->\n${END}`;
}

/** A damaged/foreign managed segment is never stripped or silently repaired. */
export function parseManagedAttachments(value) {
  const raw = typeof value === 'string' ? value : '';
  const invalid = () => ({remark:raw,attachments:[],hasManaged:false,invalid:true});
  const start = raw.indexOf(START),end = raw.indexOf(END);
  if (start < 0 && end < 0 && !raw.includes(META)) return {remark:raw,attachments:[],hasManaged:false,invalid:false};
  if (start < 0 || end < start || raw.indexOf(START,start+START.length) >= 0 || raw.indexOf(END,end+END.length) >= 0) return invalid();
  const segment = raw.slice(start,end+END.length),metadataStart = segment.indexOf(META),metadataEnd = segment.indexOf(' -->',metadataStart+META.length);
  if (metadataStart < 0 || metadataEnd < 0) return invalid();
  let descriptors;
  try {
    descriptors = validateDescriptors(JSON.parse(segment.slice(metadataStart+META.length,metadataEnd)));
    if (!descriptors.length || attachmentSegment(descriptors) !== segment) return invalid();
  } catch {return invalid();}
  const prefix = raw.slice(0,start),separator = prefix.endsWith('\n\n') ? 2 : 0;
  return {remark:raw.slice(0,start-separator)+raw.slice(end+END.length),attachments:descriptors,hasManaged:true,invalid:false};
}

export function stripManagedAttachmentSegment(value) {
  const parsed = parseManagedAttachments(value);
  if (parsed.invalid) throw new Error('思源附件段已被修改，已保留原文；请先核查再编辑附件');
  return parsed.remark;
}

export function composeManagedAttachments(value,attachments) {
  if (typeof value !== 'string' || value.length > 20000) throw new Error('备注格式或长度无效');
  const remark = stripManagedAttachmentSegment(value),descriptors = validateDescriptors(attachments);
  const result = descriptors.length ? remark+(remark?'\n\n':'')+attachmentSegment(descriptors) : remark;
  if (result.length > 20000) throw new Error('备注和附件引用合计超过 20000 字符，请缩短备注或附件文件名');
  return result;
}

function validateMagic(bytes,ext) {
  const prefix = (...expected) => expected.every((value,index) => bytes[index] === value);
  const text = (start,length) => String.fromCharCode(...bytes.subarray(start,start+length));
  const valid = ext === 'png' ? prefix(137,80,78,71,13,10,26,10)
    : ['jpg','jpeg'].includes(ext) ? prefix(255,216,255)
    : ext === 'gif' ? ['GIF87a','GIF89a'].includes(text(0,6))
    : ext === 'webp' ? text(0,4) === 'RIFF' && text(8,4) === 'WEBP'
    : ext === 'pdf' ? text(0,5) === '%PDF-'
    : ['zip','docx','xlsx','pptx'].includes(ext) ? prefix(80,75,3,4) || prefix(80,75,5,6)
    : ['doc','xls','ppt'].includes(ext) ? prefix(208,207,17,224,161,177,26,225)
    : true;
  if (!valid) throw new Error('文件内容与所选图片或文档格式不一致，请核对原文件');
}

const API_PATHS = new Set(['/api/notebook/lsNotebooks','/api/filetree/getIDsByHPath','/api/filetree/createDocWithMd','/api/block/getBlockInfo','/api/block/getBlockKramdown','/api/block/appendBlock','/api/attr/getBlockAttrs','/api/attr/setBlockAttrs','/api/asset/upload']);
const INDEX_MARKER = 'siyuan-biandan-attachment-index:v1:';
const UPLOAD_PHASES = new Set(['uploading','uploaded','indexing','ready']);
function validateIndex(value) {
  if (value === null || value === undefined) return {version:1,notebooks:{}};
  if (!object(value) || value.version !== 1 || !object(value.notebooks) || Object.keys(value.notebooks).length > 100) throw new Error('附件索引状态无效，已停止写入；请保留原状态文件');
  for (const [notebook,entry] of Object.entries(value.notebooks)) {
    if (!NODE_ID.test(notebook) || !object(entry) || entry.notebookId !== notebook || !/^\/便单附件索引-[a-f0-9]{12}$/.test(entry.path) || !/^[a-f0-9]{32}$/.test(entry.owner) || !['creating','ready'].includes(entry.status) || (entry.documentId !== '' && !NODE_ID.test(entry.documentId)) || !Array.isArray(entry.uploads) || entry.uploads.length > 20000) throw new Error('附件索引身份无效，已保留原状态文件');
    const seen = new Set();
    for (const upload of entry.uploads) {
      if (!object(upload) || !SHA256.test(upload.fingerprint) || seen.has(upload.fingerprint) || !UPLOAD_PHASES.has(upload.phase) || !safeName(upload.name) || !Number.isSafeInteger(upload.size) || upload.size < 1 || upload.size > MAX_ATTACHMENT_BYTES || !SHA256.test(upload.sha256) || !TYPES[extension(upload.name)]?.includes(upload.mime)) throw new Error('已有附件上传检查记录无效，已停止写入');
      seen.add(upload.fingerprint);
      if (upload.phase !== 'uploading') {
        const descriptor = validateAttachmentDescriptor(upload.descriptor);
        if (descriptor.name !== upload.name || descriptor.size !== upload.size || descriptor.mime !== upload.mime || descriptor.sha256 !== upload.sha256) throw new Error('已有附件上传检查记录身份不匹配');
      }
    }
  }
  return clone(value);
}

/** The store uses only the current SiYuan origin. Each upload is durably
 * tracked, verified byte-for-byte, then anchored in an owned native document
 * before it can be returned to a task editor as a confirmed descriptor. */
export function createSiyuanAttachmentStore({fetcher = globalThis.fetch,getNotebook,loadIndex,saveIndex,FormDataClass = globalThis.FormData} = {}) {
  if (typeof fetcher !== 'function' || typeof getNotebook !== 'function' || typeof loadIndex !== 'function' || typeof saveIndex !== 'function' || typeof FormDataClass !== 'function') throw new Error('思源附件配置不完整');
  let queue = Promise.resolve();
  const serial = operation => {const result = queue.catch(() => {}).then(operation);queue = result;return result;};
  async function consume(path,options,signal,read) {
    aborted(signal);
    const controller = new AbortController(),cancel = () => controller.abort();
    const timeout = setTimeout(cancel,30000);signal?.addEventListener('abort',cancel,{once:true});
    try {
      const response = await fetcher(path,{...options,credentials:'same-origin',redirect:'error',cache:'no-store',signal:controller.signal});
      if (!response?.ok || response.redirected) throw new Error('思源未确认附件请求结果');
      return await read(response);
    } catch (error) {aborted(signal);throw error;}
    finally {clearTimeout(timeout);signal?.removeEventListener('abort',cancel);}
  }
  async function api(path,body,{signal,multipart = false} = {}) {
    if (!API_PATHS.has(path)) throw new Error('附件请求目标无效');
    aborted(signal);
    let value;
    try {
      value = await consume(path,{method:'POST',...(multipart ? {body} : {headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})},signal,response => response.json());
    } catch {
      aborted(signal);
      throw new Error('思源未确认附件请求结果，请先核查；未自动重复提交');
    }
    if (!object(value) || value.code !== 0) throw new Error('思源附件操作未获确认，请检查笔记本和写入权限');
    return value.data;
  }
  const readIndex = async () => {
    let value;
    try {value = await loadIndex();}
    catch {throw new Error('附件索引状态暂时无法读取，已停止写入并保留原记录');}
    return validateIndex(value);
  };
  async function persist(previous,next) {
    if (JSON.stringify(await readIndex()) !== JSON.stringify(previous)) throw new Error('附件索引已在其他前端变化，请刷新后重试');
    try {await saveIndex(clone(next));}
    catch {throw new Error('附件索引保存未获确认，已停止后续操作并保留原记录');}
    if (JSON.stringify(await readIndex()) !== JSON.stringify(next)) throw new Error('附件索引保存未获确认，已停止后续操作');
    return next;
  }
  async function notebookReady(notebook,{signal} = {}) {
    if (typeof notebook !== 'string' || !NODE_ID.test(notebook)) throw new Error('请先在插件设置中选择附件保存笔记本');
    const data = await api('/api/notebook/lsNotebooks',{}, {signal});
    const entries = data?.notebooks;
    if (!Array.isArray(entries) || entries.filter(value => value.id === notebook && value.closed === false).length !== 1) throw new Error('附件保存笔记本未打开或无法确认，请先在思源打开该笔记本');
  }
  async function verifyDocument(entry,{signal} = {}) {
    const [info,body] = await Promise.all([
      api('/api/block/getBlockInfo',{id:entry.documentId},{signal}),
      api('/api/block/getBlockKramdown',{id:entry.documentId},{signal}),
    ]);
    const marker = `<!-- ${INDEX_MARKER}${entry.notebookId}:${entry.owner} -->`;
    if (info?.box !== entry.notebookId || info?.rootID !== entry.documentId || body?.id !== entry.documentId || typeof body.kramdown !== 'string' || !body.kramdown.includes(marker)) throw new Error('附件索引文档身份不匹配，已停止写入并保留原文');
    return body.kramdown;
  }
  async function recoverDocument(state,notebook,{signal} = {}) {
    const entry = state.notebooks[notebook];
    if (entry.status === 'ready') {await verifyDocument(entry,{signal});return state;}
    const ids = await api('/api/filetree/getIDsByHPath',{notebook,path:entry.path},{signal});
    if (!Array.isArray(ids) || ids.length !== 1 || !NODE_ID.test(ids[0])) throw new Error('此前创建附件索引的结果尚待核查；未重复新建索引文档');
    const next = clone(state);next.notebooks[notebook].documentId = ids[0];
    await verifyDocument(next.notebooks[notebook],{signal});
    next.notebooks[notebook].status = 'ready';
    return persist(state,next);
  }
  async function ensureDocument(notebook,{signal} = {}) {
    let state = await readIndex();
    if (state.notebooks[notebook]) return recoverDocument(state,notebook,{signal});
    const random = new Uint8Array(16);crypto.getRandomValues(random);
    const owner = Array.from(random,value => value.toString(16).padStart(2,'0')).join('');
    const path = '/便单附件索引-'+owner.slice(0,12);
    const existing = await api('/api/filetree/getIDsByHPath',{notebook,path},{signal});
    if (!Array.isArray(existing) || existing.length) throw new Error('附件索引路径已被占用，未覆盖已有文档，请重试分配新路径');
    const next = clone(state);
    next.notebooks[notebook] = {notebookId:notebook,path,owner,status:'creating',documentId:'',uploads:[]};
    state = await persist(state,next);
    const markdown = `# 便单附件索引\n\n<!-- ${INDEX_MARKER}${notebook}:${owner} -->\n\n此文档保留便单伴侣上传的思源附件引用，避免资源被当作未引用文件清理。附件保存在当前思源工作区；其他便单客户端不能保证打开。取消编辑或移除关联不会删除源文件。\n`;
    let created;
    try {created = await api('/api/filetree/createDocWithMd',{notebook,path,markdown},{signal});}
    catch {return recoverDocument(state,notebook,{signal});}
    if (!NODE_ID.test(created)) throw new Error('附件索引创建身份未确认，请先核查，未再次创建');
    const ready = clone(state);ready.notebooks[notebook].documentId = created;
    await verifyDocument(ready.notebooks[notebook],{signal});
    ready.notebooks[notebook].status = 'ready';
    return persist(state,ready);
  }
  async function assetBytes(descriptor,{signal} = {}) {
    aborted(signal);
    try {
      await consume(getSiyuanAssetURL(descriptor),{method:'GET'},signal,async response => {
        const advertised = response.headers?.get?.('content-length');
        if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_ATTACHMENT_BYTES)) throw new Error('思源附件返回大小超出限制');
        let bytes;
        if (response.body?.getReader) {
          const reader = response.body.getReader(),chunks = [];let length = 0;
          try {
            while (true) {
              aborted(signal);const chunk = await reader.read();if (chunk.done) break;
              length += chunk.value.byteLength;
              if (length > descriptor.size || length > MAX_ATTACHMENT_BYTES) throw new Error('思源附件内容大小不一致');
              chunks.push(chunk.value);
            }
          } catch (error) {try {await reader.cancel();} catch {}throw error;}
          bytes = new Uint8Array(length);let offset = 0;for (const chunk of chunks) {bytes.set(chunk,offset);offset += chunk.length;}
        } else {
          if (typeof response.arrayBuffer !== 'function') throw new Error('思源附件响应无法核对');
          bytes = new Uint8Array(await response.arrayBuffer());
        }
        aborted(signal);
        if (bytes.byteLength !== descriptor.size || await digest(bytes) !== descriptor.sha256) throw new Error('思源附件内容核对不一致，未保存到待办');
      });
    } catch {aborted(signal);throw new Error('无法核对思源附件内容或文件已变化，尚未确认上传完成');}
  }
  function confirmedPath(data,name) {
    if (!object(data) || (Array.isArray(data.errFiles) && data.errFiles.length) || (Array.isArray(data.failedFiles) && data.failedFiles.length)) return '';
    if (Array.isArray(data.succFiles)) {
      if (data.succFiles.length !== 1) return '';
      const row = data.succFiles[0];
      return row?.index === 0 && row.name === name && isSiyuanAssetPath(row.path) ? row.path : '';
    }
    if (!object(data.succMap)) return '';
    const entries = Object.entries(data.succMap);
    return entries.length === 1 && entries[0][0] === name && isSiyuanAssetPath(entries[0][1]) ? entries[0][1] : '';
  }
  async function updateUpload(state,notebook,fingerprint,changes) {
    const next = clone(state),entry = next.notebooks[notebook].uploads.find(value => value.fingerprint === fingerprint);
    if (!entry) throw new Error('附件上传检查身份丢失，已停止后续操作');
    Object.assign(entry,changes);
    return persist(state,next);
  }
  async function register(state,notebook,upload,{signal} = {}) {
    const descriptor = validateAttachmentDescriptor(upload.descriptor);
    await assetBytes(descriptor,{signal});
    const entry = state.notebooks[notebook],marker = `<!-- siyuan-biandan-asset:v1:${upload.fingerprint}:${descriptor.sha256} -->`;
    const link = `[${markdownName(descriptor.name)}](${getSiyuanAssetURL(descriptor).slice(1)})`;
    let body = await verifyDocument(entry,{signal});
    if (!body.includes(marker)) {
      if (upload.phase === 'indexing') throw new Error('此前附件索引追加结果尚待核查，未重复追加；请稍后刷新核对');
      state = await updateUpload(state,notebook,upload.fingerprint,{phase:'indexing'});
      let appendError;
      try {await api('/api/block/appendBlock',{dataType:'markdown',data:`${link}\n\n${marker}`,parentID:entry.documentId},{signal});}
      catch (error) {appendError = error;}
      body = await verifyDocument(entry,{signal});
      if (!body.includes(marker) || !body.includes(getSiyuanAssetURL(descriptor).slice(1))) throw appendError || new Error('附件索引追加尚未核对，已保留上传检查记录');
    } else if (!body.includes(getSiyuanAssetURL(descriptor).slice(1))) throw new Error('附件索引标记存在但资源链接不匹配，已保留原文');
    const key = 'custom-data-assets-biandan-'+upload.fingerprint;
    const before = await api('/api/attr/getBlockAttrs',{id:entry.documentId},{signal});
    if (!object(before) || (before[key] !== undefined && before[key] !== descriptor.path)) throw new Error('附件索引引用属性已变化，已保留原值');
    if (before[key] !== descriptor.path) await api('/api/attr/setBlockAttrs',{id:entry.documentId,attrs:{[key]:descriptor.path}},{signal});
    const after = await api('/api/attr/getBlockAttrs',{id:entry.documentId},{signal});
    if (after?.[key] !== descriptor.path) throw new Error('思源未确认附件引用保护，尚未保存到待办');
    return updateUpload(state,notebook,upload.fingerprint,{phase:'ready'});
  }
  return {
    getAssetURL:getSiyuanAssetURL,
    async open(descriptor,{openAsset} = {}) {
      const verified = validateAttachmentDescriptor(descriptor);await assetBytes(verified);
      if (typeof openAsset !== 'function') return {url:getSiyuanAssetURL(verified),descriptor:verified};
      return openAsset({path:verified.path,url:getSiyuanAssetURL(verified),name:verified.name,mime:verified.mime});
    },
    upload(files,{signal} = {}) {
      return serial(async () => {
        const list = Array.from(files || []),uploaded = [];
        if (!list.length || list.length > MAX_ATTACHMENT_COUNT) throw new Error('每次请选择 1–5 个附件');
        const metadata = list.map(validateAttachmentFile);
        aborted(signal);
        const notebook = await getNotebook();await notebookReady(notebook,{signal});
        const hashes = [];
        for (let index=0;index<list.length;index++) {
          aborted(signal);
          const bytes = new Uint8Array(await list[index].arrayBuffer());
          if (bytes.byteLength !== metadata[index].size) throw new Error('所选附件内容大小无法核对');
          validateMagic(bytes,metadata[index].extension);hashes.push(await digest(bytes));
        }
        let state = await ensureDocument(notebook,{signal});
        try {
          for (let index=0;index<list.length;index++) {
            aborted(signal);
            if (await getNotebook() !== notebook) throw new Error('附件保存笔记本已变化，请重新确认后保存');
            const meta = metadata[index],sha256 = hashes[index];
            const fingerprint = await digest(new TextEncoder().encode(JSON.stringify([meta.name,meta.size,meta.mime,sha256])));
            let upload = state.notebooks[notebook].uploads.find(value => value.fingerprint === fingerprint);
            if (!upload) {
              const next = clone(state);
              upload = {fingerprint,phase:'uploading',name:meta.name,size:meta.size,mime:meta.mime,sha256};
              next.notebooks[notebook].uploads.push(upload);state = await persist(state,next);
              aborted(signal);
              // Native assets use a controlled basename. Keep the user's
              // display name in the descriptor, while %, brackets, spaces and
              // same-name inputs cannot affect URL parsing or response identity.
              const uploadName = `biandan-${sha256}.${meta.extension}`;
              const form = new FormDataClass();form.append('assetsDirPath','/assets/');form.append('file[]',list[index],uploadName);
              const result = await api('/api/asset/upload',form,{signal,multipart:true});
              const path = confirmedPath(result,uploadName);
              if (!path) throw new Error('思源未唯一确认附件上传身份，请核查；未自动重复上传');
              const descriptor = validateAttachmentDescriptor({kind:'siyuan-asset',name:meta.name,path,size:meta.size,mime:meta.mime,sha256});
              state = await updateUpload(state,notebook,fingerprint,{phase:'uploaded',descriptor});
              upload = state.notebooks[notebook].uploads.find(value => value.fingerprint === fingerprint);
            } else if (upload.phase === 'uploading') throw new Error('此前同一附件的上传结果尚待核查，未重复上传');
            state = await register(state,notebook,upload,{signal});
            uploaded.push(validateAttachmentDescriptor(state.notebooks[notebook].uploads.find(value => value.fingerprint === fingerprint).descriptor));
          }
          return uploaded;
        } catch (error) {
          throw Object.assign(new Error(error?.message || '附件保存尚待核查，请保留当前草稿'),{uploaded:clone(uploaded),uploadedEntries:uploaded.map((descriptor,index) => ({index,descriptor:clone(descriptor)})),canceled:Boolean(signal?.aborted || error?.canceled),commitState:'unknown'});
        }
      });
    },
  };
}
