const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeURL = value => {
  const url=String(value || '').trim();
  return /^(?:https?:\/\/|mailto:|siyuan:\/\/blocks\/|(?:\.\.\/)?assets\/)/i.test(url)&&!/[\u0000-\u0020]/.test(url)?url:'';
};
const COLORS=new Set(['red','orange','yellow','green','lakeBlue','lightBlue','darkBlue','purple']);
const punctuation=/[!-/:-@[-`{-~]/;
function closing(value,marker,start){
  let at=value.indexOf(marker,start);
  while(at>=0){let slashes=0;for(let i=at-1;i>=0&&value[i]==='\\';i--)slashes++;if(!(slashes%2))return at;at=value.indexOf(marker,at+marker.length);}return -1;
}
function nativeClosing(value,tag,start){
  const tokens=tag==='span'?/<span data-color=(["'])[A-Za-z]+\1>|<\/span>/g:new RegExp('</?'+tag+'>','g');tokens.lastIndex=start;let depth=1,match;
  while((match=tokens.exec(value))){depth+=match[0].startsWith('</')?-1:1;if(!depth)return match.index;}return -1;
}
/** Native tags are parsed as text tokens, never inserted as arbitrary HTML. */
function inline(value,depth=0) {
  const source=String(value);if(depth>16)return escape(source);let html='';
  for(let at=0;at<source.length;){
    const rest=source.slice(at);
    if(rest[0]==='\\'&&rest[1]&&punctuation.test(rest[1])){html+=escape(rest[1]);at+=2;continue;}
    const code=rest.match(/^`([^`\n]+)`/);if(code){html+='<code>'+escape(code[1])+'</code>';at+=code[0].length;continue;}
    const link=rest.match(/^(!?)\[([^\]\n]+)\]\(([^)\n]+)\)/);
    if(link){const href=safeURL(link[3]),label=inline((link[1]?'图片：':'')+link[2],depth+1);html+=href?`<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`:label;at+=link[0].length;continue;}
    const native=rest.match(/^<(b|i|u|s)>/),span=rest.match(/^<span data-color=(["'])([A-Za-z]+)\1>/);
    if(native||span&&COLORS.has(span[2])){
      const tag=native?.[1]||'span',open=native?.[0]||span[0],end=nativeClosing(rest,tag,open.length);
      if(end>=0){const inside=inline(rest.slice(open.length,end),depth+1),output={b:'strong',i:'em',u:'u',s:'del',span:'span'}[tag];html+=`<${output}${tag==='span'?` data-color="${span[2]}"`:''}>${inside}</${output}>`;at+=end+tag.length+3;continue;}
    }
    let formatted=false;
    for(const [marker,open,close]of [['***','<strong><em>','</em></strong>'],['**','<strong>','</strong>'],['__','<strong>','</strong>'],['~~','<del>','</del>'],['*','<em>','</em>']]){
      if(!rest.startsWith(marker))continue;const end=closing(rest,marker,marker.length),content=rest.slice(marker.length,end);
      if(end>marker.length&&!/^\s|\s$/.test(content)){html+=open+inline(content,depth+1)+close;at+=end+marker.length;formatted=true;break;}
    }
    if(formatted)continue;
    const url=rest.match(/^https?:\/\/[^\s<>`"']+/i);
    if(url){const raw=url[0].replace(/[.,;:!?]+$/,'').replace(/\)+$/,match=>{const text=url[0],opens=(text.match(/\(/g)||[]).length,closes=(text.match(/\)/g)||[]).length;return match.slice(0,Math.max(0,match.length-Math.max(0,closes-opens)));});if(raw&&safeURL(raw)){html+=`<a href="${escape(raw)}" target="_blank" rel="noopener noreferrer">${escape(raw)}</a>`;at+=raw.length;continue;}}
    html+=escape(rest[0]);at++;
  }
  return html;
}

/** Small offline fallback; raw HTML stays text and images never auto-load. */
export function fallbackMarkdown(value) {
  const lines=String(value ?? '').replace(/\r\n?/g,'\n').split('\n');let html='',paragraph=[],list='',listIndent=0;
  const flush=()=>{if(paragraph.length){html+='<p>'+paragraph.map(line=>inline(line)).join('<br>')+'</p>';paragraph=[];}if(list){html+=`</${list}>`;list='';}};
  for(let i=0;i<lines.length;i++){
    const original=lines[i],leading=original.match(/^ */)[0].length,prefix=original.match(/^<indent level=["']([1-4])["']>/),indent=prefix?Number(prefix[1]):Math.min(4,Math.floor(leading/2)),line=prefix?original.slice(prefix[0].length):original.slice(leading),attr=indent?` data-biandan-indent="${indent}"`:'';
    const fence=original.match(/^ *(`{3,})([^`]*)$/);
    if(fence){
      const bare=!fence[2].trim(),closingFence=new RegExp('^ *`{'+fence[1].length+'}\\s*$');
      let end=i+1;while(end<lines.length&&!closingFence.test(lines[end]))end++;
      if(end<lines.length||!bare){flush();html+='<pre'+attr+'><code>'+escape(lines.slice(i+1,end).join('\n'))+'</code></pre>';i=Math.min(end,lines.length);continue;}
    }
    if(!line.trim()){flush();continue;}
    const heading=line.match(/^(#{1,6})\s+(.+)$/);if(heading){flush();html+=`<h${heading[1].length}${attr}>${inline(heading[2])}</h${heading[1].length}>`;continue;}
    if(/^(?:---+|\*\*\*+|___+)\s*$/.test(line)){flush();html+='<hr'+attr+'>';continue;}
    if(line.includes('|')&&/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i+1]||'')){
      flush();const cells=row=>row.trim().replace(/^\||\|$/g,'').split('|').map(x=>x.trim());
      const headers=cells(line);html+='<table><thead><tr>'+headers.map(x=>`<th>${inline(x)}</th>`).join('')+'</tr></thead><tbody>';i++;
      while(i+1<lines.length&&lines[i+1].includes('|')&&lines[i+1].trim()){const row=cells(lines[++i]);html+='<tr>'+headers.map((_,j)=>`<td>${inline(row[j]||'')}</td>`).join('')+'</tr>';}
      html+='</tbody></table>';continue;
    }
    const item=line.match(/^(?:(\d+)[.)]|[-*+])\s+(.+)$/);
    if(item){if(paragraph.length){html+='<p>'+paragraph.map(line=>inline(line)).join('<br>')+'</p>';paragraph=[];}const kind=item[1]?'ol':'ul';if(list!==kind||listIndent!==indent){if(list)html+=`</${list}>`;list=kind;listIndent=indent;html+=`<${list}${attr}>`;}html+='<li>'+inline(item[2]).replace(/^\[([ xX])\]\s*/,(_,mark)=>mark===' '?'☐ ':'☑ ')+'</li>';continue;}
    const quote=line.match(/^>\s?(.*)$/);if(quote){flush();html+='<blockquote'+attr+'>'+inline(quote[1])+'</blockquote>';continue;}
    if(prefix){flush();html+='<p'+attr+'>'+inline(line)+'</p>';continue;}
    if(list){html+=`</${list}>`;list='';}paragraph.push(line);
  }
  flush();return html;
}

/** Treat a host renderer as untrusted HTML too. Keep semantic content only. */
export function renderSafeMarkdown(document,value,renderer) {
  let html;
  const native=/<(?:b|i|u|s)>|<span data-color=|^<indent level=|^ *`{4,}|^ *\d+\) |\\[!-/:-@[-`{-~]|\*\*\*/m.test(String(value??''));
  try{html=typeof renderer==='function'&&!native?renderer(String(value ?? '')):fallbackMarkdown(value);}catch{html=fallbackMarkdown(value);}
  if(typeof html!=='string')html=fallbackMarkdown(value);
  const source=document.createElement('template'),target=document.createElement('div');source.innerHTML=html;
  const allowed=new Set(['P','BR','STRONG','B','EM','I','U','DEL','S','SPAN','CODE','PRE','UL','OL','LI','BLOCKQUOTE','H1','H2','H3','H4','H5','H6','A','TABLE','THEAD','TBODY','TR','TH','TD','HR']);
  const discarded=new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','SVG','MATH','FORM','INPUT','BUTTON','TEXTAREA','SELECT']);
  const append=(node,parent)=>{
    if(node.nodeType===3){parent.appendChild(document.createTextNode(node.textContent||''));return;}
    if(node.nodeType!==1||discarded.has(node.tagName))return;
    if(node.tagName==='IMG'){const label=node.getAttribute('alt');if(label)parent.appendChild(document.createTextNode('图片：'+label));return;}
    if(!allowed.has(node.tagName)){for(const child of [...node.childNodes])append(child,parent);return;}
    const clean=document.createElement(node.tagName.toLowerCase());
    if(node.tagName==='SPAN'&&COLORS.has(node.getAttribute('data-color')))clean.setAttribute('data-color',node.getAttribute('data-color'));
    if(['P','H1','H2','H3','H4','H5','H6','UL','OL','BLOCKQUOTE','PRE','HR'].includes(node.tagName)&&/^[1-4]$/.test(node.getAttribute('data-biandan-indent')||''))clean.setAttribute('data-biandan-indent',node.getAttribute('data-biandan-indent'));
    if(node.tagName==='A'){const href=safeURL(node.getAttribute('href'));if(href){clean.setAttribute('href',href);clean.setAttribute('target','_blank');clean.setAttribute('rel','noopener noreferrer');}}
    for(const child of [...node.childNodes])append(child,clean);parent.appendChild(clean);
  };
  for(const child of [...source.content.childNodes])append(child,target);
  return target.innerHTML;
}
