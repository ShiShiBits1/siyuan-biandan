function key(node) {
  if(node.nodeType!==1)return '';
  for(const attribute of ['data-occurrence','data-date','data-view','data-list','data-list-row']){
    if(node.hasAttribute(attribute))return attribute+':'+node.getAttribute(attribute);
  }
  if(node.hasAttribute('data-action'))return 'action:'+node.getAttribute('data-action')+':'+(node.getAttribute('data-id')||node.getAttribute('data-list-id')||node.getAttribute('data-attachment-key')||'')+':'+(node.getAttribute('data-attachment-index')||'');
  if(node.hasAttribute('data-attachment-key'))return 'attachment:'+node.getAttribute('data-attachment-key');
  if(node.hasAttribute('name'))return 'field:'+node.getAttribute('name');
  const className=node.getAttribute('class')?.split(/\s+/)[0];
  return className?'class:'+className:'';
}
const compatible=(current,wanted)=>current.nodeType===wanted.nodeType&&(current.nodeType!==1||current.tagName===wanted.tagName&&key(current)===key(wanted));

function patch(current,wanted) {
  if(current.nodeType===3){if(current.textContent!==wanted.textContent)current.textContent=wanted.textContent;return;}
  if(current.nodeType!==1)return;
  const editing=current===current.ownerDocument.activeElement&&['INPUT','TEXTAREA','SELECT'].includes(current.tagName);
  for(const attribute of [...current.attributes]){
    if((editing&&attribute.name==='value')||(current.tagName==='DETAILS'&&attribute.name==='open'))continue;
    if(!wanted.hasAttribute(attribute.name))current.removeAttribute(attribute.name);
  }
  for(const attribute of [...wanted.attributes]){
    if(editing&&attribute.name==='value')continue;
    if(current.getAttribute(attribute.name)!==attribute.value)current.setAttribute(attribute.name,attribute.value);
  }
  children(current,wanted);
}
function children(current,wanted) {
  const previous=[...current.childNodes],used=new Set();let cursor=current.firstChild;
  for(const child of [...wanted.childNodes]){
    const childKey=key(child);
    let existing=childKey?previous.find(node=>!used.has(node)&&compatible(node,child)):cursor&&!used.has(cursor)&&compatible(cursor,child)?cursor:previous.find(node=>!used.has(node)&&compatible(node,child));
    if(!existing)existing=child.cloneNode(true);
    if(existing!==cursor)current.insertBefore(existing,cursor);
    if(previous.includes(existing))patch(existing,child);
    used.add(existing);cursor=existing.nextSibling;
  }
  for(const child of [...current.childNodes])if(!used.has(child))child.remove();
}

/** Patch only changed view nodes; active inputs and expanded groups survive. */
export function reconcileHTML(element,html) {
  const template=element.ownerDocument.createElement('template');template.innerHTML=html;
  const scrollTop=element.scrollTop,scrollLeft=element.scrollLeft;
  children(element,template.content);
  element.scrollTop=scrollTop;element.scrollLeft=scrollLeft;
}
