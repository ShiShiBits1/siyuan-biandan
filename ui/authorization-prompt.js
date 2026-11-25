import {icon} from './icons.js';
/** A callback URL remains only in this short-lived input; never log or persist it. */
export function mountAuthorizationPrompt(root,options={}) {
  const doc=root.ownerDocument;
  let layer=null,generation=0,disposed=false,busy=false,previousFocus=null,busyAction='';
  function clear(){++generation;busy=false;if(layer){const input=layer.querySelector('textarea');if(input)input.value='';layer.remove();layer=null;}if(previousFocus?.isConnected)previousFocus.focus();}
  function status(message){const node=layer?.querySelector('[data-authorization-status]');if(node)node.textContent=message;}
  function controls(){layer?.querySelectorAll('button,textarea,a').forEach(node=>{
    const disabled=busy&&!(node.dataset.authAction==='cancel'&&busyAction!=='cancel');
    if(node.tagName==='A'){node.setAttribute('aria-disabled',String(disabled));node.style.pointerEvents=disabled?'none':'';node.tabIndex=disabled?-1:0;}else node.disabled=disabled;
  });}
  function authorizationLink(details){
    try{const url=new URL(details?.authorizationUrl);if(url.protocol==='https:'&&url.hostname==='oauth-login.cloud.huawei.com'&&(!url.port||url.port==='443')&&!url.username&&!url.password&&url.pathname==='/oauth2/v3/authorize')return url.href;}catch{}return '';
  }
  function open(details={}){
    if(disposed)return;if(layer){layer.querySelector('textarea')?.focus();return;}
    previousFocus=doc.activeElement;layer=doc.createElement('section');layer.className='bd-authorization-layer';layer.dataset.authorization='pending';
    layer.innerHTML=`<div class="bd-authorization-panel" role="dialog" aria-modal="true" aria-labelledby="bd-authorization-title"><header><h2 id="bd-authorization-title">完成便单授权</h2><button type="button" data-auth-action="cancel" aria-label="取消授权">${icon('close')}</button></header><div class="bd-authorization-content"><p>在系统浏览器完成华为账号授权。跳转后，复制浏览器地址栏的完整地址，返回思源粘贴到下方。</p><p class="bd-form-hint">最后的本机地址可能显示无法访问，这是正常的；仍请复制完整地址。授权地址包含临时凭据，请勿发给他人。</p><label>授权回调地址<textarea name="authorizationCallback" rows="4" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="在此粘贴完整回调地址"></textarea></label><p data-authorization-status role="status">等待系统浏览器授权。</p><button type="button" data-auth-action="reopen">重新打开授权页</button></div><footer><button type="button" data-auth-action="cancel">取消授权</button><button class="bd-primary" type="button" data-auth-action="complete">完成授权</button></footer></div>`;
    layer.addEventListener('click',click);layer.addEventListener('keydown',keydown);layer.addEventListener('input',()=>options.noteActivity?.());root.append(layer);
    const href=authorizationLink(details);if(href){const link=doc.createElement('a');link.href=href;link.target='_blank';link.rel='noopener noreferrer';link.className='bd-authorization-link';link.textContent='在系统浏览器打开授权页';layer.querySelector('.bd-authorization-content').append(link);}
    layer.querySelector('textarea')?.focus();
  }
  async function click(event){
    const button=event.target.closest?.('[data-auth-action]');if(!button||button.disabled)return;event.stopPropagation();options.noteActivity?.();
    const action=button.dataset.authAction,current=++generation;busy=true;busyAction=action;controls();
    if(action==='cancel'){
      const input=layer?.querySelector('textarea');if(input)input.value='';
      try{if(typeof options.cancelAuthorization==='function')await options.cancelAuthorization();if(!disposed&&current===generation)clear();}
      catch{if(!disposed&&current===generation)status('取消尚未确认，请重试。');}
    }else if(action==='reopen'){
      try{if(typeof options.connect!=='function')throw new Error();const details=await options.connect();if(!disposed&&current===generation){const href=authorizationLink(details),link=layer.querySelector('.bd-authorization-link');if(link&&href)link.href=href;}if(!disposed&&current===generation)status('已请求打开系统浏览器；如果没有打开，请检查系统的浏览器权限。');}
      catch{if(!disposed&&current===generation)status('授权页没有打开，请检查系统浏览器设置后重试。');}
    }else if(action==='complete'){
      const input=layer?.querySelector('textarea'),url=input?.value.trim()||'';if(input)input.value='';
      try{if(!url||typeof options.completeAuthorization!=='function')throw new Error();await options.completeAuthorization(url);if(!disposed&&current===generation){clear();await options.onConnected?.();}}
      catch{if(!disposed&&current===generation)status('授权未完成。请重新复制浏览器的最终完整地址，或重新打开授权页。');}
    }
    if(!disposed&&current===generation){busy=false;controls();}
  }
  function keydown(event){
    event.stopPropagation();if(event.key==='Escape'){event.preventDefault();layer.querySelector('[data-auth-action="cancel"]:not(:disabled)')?.click();return;}
    if(event.key==='Tab'){
      const nodes=[...layer.querySelectorAll('button,textarea,a')].filter(node=>!node.disabled&&node.getAttribute('aria-disabled')!=='true'),index=nodes.indexOf(doc.activeElement);
      if(!nodes.length){event.preventDefault();return;}
      if(event.shiftKey&&index<=0){event.preventDefault();nodes.at(-1).focus();}else if(!event.shiftKey&&index===nodes.length-1){event.preventDefault();nodes[0].focus();}
    }
  }
  return {open,clear,isOpen:()=>Boolean(layer),async restore(){
    if(typeof options.authorizationStatus!=='function')return;const current=++generation;
    try{const state=await options.authorizationStatus();if(!disposed&&current===generation&&state?.pendingAuthorization)open(state);}catch{/* Status probes must never expose callback or account values. */}
  },dispose(){disposed=true;clear();}};
}
