import {MAX_ATTACHMENT_COUNT,validateAttachmentFile,getSiyuanAssetURL} from '../src/attachments.js';

const imageMimes=new Set(['image/png','image/jpeg','image/gif','image/webp']);
export const formatBytes=value=>value<1024?`${value} B`:value<1024*1024?`${Math.round(value/1024)} KB`:`${(value/1024/1024).toFixed(1)} MB`;

/** Files stay in memory until the user saves; cancel never uploads them. */
export function createAttachmentDraft(existing=[],{urlAPI=globalThis.URL}={}) {
  let sequence=0,disposed=false;
  const entries=existing.map(descriptor=>({key:'saved-'+(++sequence),descriptor,file:null,previewURL:'',state:'saved'}));
  function preview(entry){
    const mime=entry.descriptor?.mime||entry.metadata?.mime;if(!imageMimes.has(mime))return '';
    if(entry.previewURL)return entry.previewURL;
    if(entry.descriptor){try{return getSiyuanAssetURL(entry.descriptor);}catch{return '';}}
    if(entry.file&&typeof urlAPI?.createObjectURL==='function'){
      try{entry.previewURL=urlAPI.createObjectURL(entry.file);return entry.previewURL;}catch{return '';}
    }
    return '';
  }
  function release(entry){if(entry.previewURL){urlAPI?.revokeObjectURL?.(entry.previewURL);entry.previewURL='';}}
  return {
    entries,
    preview,
    add(files){
      if(disposed)return {added:0,errors:['编辑已关闭，请重新打开待办。']};
      const errors=[];let added=0;
      for(const file of Array.from(files||[])){
        if(entries.some(entry=>entry.file===file))continue;
        try{
          const metadata=validateAttachmentFile(file);
          if(entries.length>=MAX_ATTACHMENT_COUNT)throw new Error(`每条待办最多关联 ${MAX_ATTACHMENT_COUNT} 个思源附件。`);
          entries.push({key:'local-'+(++sequence),descriptor:null,file,metadata,previewURL:'',state:'pending'});added++;
        }catch(error){errors.push(error?.message||'此文件暂不能上传。');}
      }
      return {added,errors};
    },
    remove(key){const index=entries.findIndex(entry=>entry.key===key);if(index<0)return false;release(entries[index]);entries.splice(index,1);return true;},
    pending(){return entries.filter(entry=>entry.file&&!entry.descriptor);},
    confirmed(pending,uploaded){
      for(const {index,descriptor}of uploaded){
        const entry=pending[index];if(!entry||!entries.includes(entry))continue;
        if(descriptor?.kind!=='siyuan-asset'||typeof descriptor.name!=='string'||typeof descriptor.mime!=='string'||!Number.isFinite(descriptor.size))throw new Error('附件上传结果尚未核实，请保留草稿后刷新核对。');
        getSiyuanAssetURL(descriptor);
        if(descriptor.name!==entry.metadata?.name||descriptor.size!==entry.metadata?.size||descriptor.mime!==entry.metadata?.mime)throw new Error('附件上传结果与所选文件不匹配，请保留草稿并核对。');
        entry.descriptor=descriptor;entry.state='uploaded';
      }
    },
    descriptors(){
      if(entries.some(entry=>!entry.descriptor))throw new Error('仍有附件尚未确认上传，请先完成上传或移除该附件。');
      const paths=new Set();return entries.flatMap(entry=>{const descriptor=entry.descriptor;if(paths.has(descriptor.path))return [];paths.add(descriptor.path);return [descriptor];});
    },
    dispose(){if(disposed)return;disposed=true;entries.forEach(release);entries.length=0;},
  };
}
