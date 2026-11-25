const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeURL = value => {
  const url=String(value || '').trim();
  return /^(?:https?:\/\/|mailto:|siyuan:\/\/blocks\/|(?:\.\.\/)?assets\/)/i.test(url)&&!/[\u0000-\u0020]/.test(url)?url:'';
};
function emphasis(value) {
  return escape(value).replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g,(_,a,b)=>`<strong>${a||b}</strong>`)
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g,'$1<em>$2</em>').replace(/~~([^~\n]+)~~/g,'<del>$1</del>');
}
function inline(value) {
  return String(value).split(/(`[^`\n]+`|!?\[[^\]\n]+\]\([^)\n]+\))/g).map(part=>{
    if(part.startsWith('`')&&part.endsWith('`'))return `<code>${escape(part.slice(1,-1))}</code>`;
    const link=part.match(/^(!?)\[([^\]\n]+)\]\(([^)\n]+)\)$/);
    if(link){const href=safeURL(link[3]);return href?`<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${emphasis((link[1]?'图片：':'')+link[2])}</a>`:emphasis(link[2]);}
    return emphasis(part);
  }).join('');
}

/** Small offline fallback; raw HTML stays text and images never auto-load. */
export function fallbackMarkdown(value) {
  const lines=String(value ?? '').replace(/\r\n?/g,'\n').split('\n');let html='',paragraph=[],list='',code=null;
  const flush=()=>{if(paragraph.length){html+='<p>'+paragraph.map(inline).join('<br>')+'</p>';paragraph=[];}if(list){html+=`</${list}>`;list='';}};
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(/^\s*```/.test(line)){flush();if(code!==null){html+='<pre><code>'+escape(code.join('\n'))+'</code></pre>';code=null;}else code=[];continue;}
    if(code!==null){code.push(line);continue;}
    if(!line.trim()){flush();continue;}
    const heading=line.match(/^(#{1,6})\s+(.+)$/);if(heading){flush();html+=`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`;continue;}
    if(/^\s*(?:---+|\*\*\*+)\s*$/.test(line)){flush();html+='<hr>';continue;}
    if(line.includes('|')&&/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i+1]||'')){
      flush();const cells=row=>row.trim().replace(/^\||\|$/g,'').split('|').map(x=>x.trim());
      const headers=cells(line);html+='<table><thead><tr>'+headers.map(x=>`<th>${inline(x)}</th>`).join('')+'</tr></thead><tbody>';i++;
      while(i+1<lines.length&&lines[i+1].includes('|')&&lines[i+1].trim()){const row=cells(lines[++i]);html+='<tr>'+headers.map((_,j)=>`<td>${inline(row[j]||'')}</td>`).join('')+'</tr>';}
      html+='</tbody></table>';continue;
    }
    const item=line.match(/^\s*(?:(\d+)\.|[-*+])\s+(.+)$/);
    if(item){if(paragraph.length){html+='<p>'+paragraph.map(inline).join('<br>')+'</p>';paragraph=[];}const kind=item[1]?'ol':'ul';if(list!==kind){if(list)html+=`</${list}>`;list=kind;html+=`<${list}>`;}html+='<li>'+inline(item[2]).replace(/^\[([ xX])\]\s*/,(_,mark)=>mark===' '?'☐ ':'☑ ')+'</li>';continue;}
    const quote=line.match(/^>\s?(.*)$/);if(quote){flush();html+='<blockquote>'+inline(quote[1])+'</blockquote>';continue;}
    if(list){html+=`</${list}>`;list='';}paragraph.push(line);
  }
  flush();if(code!==null)html+='<pre><code>'+escape(code.join('\n'))+'</code></pre>';return html;
}

/** Treat a host renderer as untrusted HTML too. Keep semantic content only. */
export function renderSafeMarkdown(document,value,renderer) {
  let html;
  try{html=typeof renderer==='function'?renderer(String(value ?? '')):fallbackMarkdown(value);}catch{html=fallbackMarkdown(value);}
  if(typeof html!=='string')html=fallbackMarkdown(value);
  const source=document.createElement('template'),target=document.createElement('div');source.innerHTML=html;
  const allowed=new Set(['P','BR','STRONG','B','EM','I','DEL','S','CODE','PRE','UL','OL','LI','BLOCKQUOTE','H1','H2','H3','H4','H5','H6','A','TABLE','THEAD','TBODY','TR','TH','TD','HR']);
  const discarded=new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','SVG','MATH','FORM','INPUT','BUTTON','TEXTAREA','SELECT']);
  const append=(node,parent)=>{
    if(node.nodeType===3){parent.appendChild(document.createTextNode(node.textContent||''));return;}
    if(node.nodeType!==1||discarded.has(node.tagName))return;
    if(node.tagName==='IMG'){const label=node.getAttribute('alt');if(label)parent.appendChild(document.createTextNode('图片：'+label));return;}
    if(!allowed.has(node.tagName)){for(const child of [...node.childNodes])append(child,parent);return;}
    const clean=document.createElement(node.tagName.toLowerCase());
    if(node.tagName==='A'){const href=safeURL(node.getAttribute('href'));if(href){clean.setAttribute('href',href);clean.setAttribute('target','_blank');clean.setAttribute('rel','noopener noreferrer');}}
    for(const child of [...node.childNodes])append(child,clean);parent.appendChild(clean);
  };
  for(const child of [...source.content.childNodes])append(child,target);
  return target.innerHTML;
}
