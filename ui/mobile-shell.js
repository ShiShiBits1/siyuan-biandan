/** Mobile presentation only: no native host, credentials, or task persistence. */
export function mountAdaptiveShell(root,host,options={}) {
  const doc=host.ownerDocument,win=doc.defaultView;
  const nav=root.querySelector('.bd-nav'),lists=root.querySelector('.bd-lists'),main=root.querySelector('.bd-main'),fab=root.querySelector('.bd-fab');
  const backdrop=root.querySelector('.bd-drawer-backdrop');
  const closeHost=root.querySelector('[data-action="close-host"]');
  let disposed=false,mobile=false,drawer='',previousFocus=null,frame=0;
  if(closeHost)closeHost.hidden=typeof options.onClose!=='function';
  root.dataset.platform=['ios','android','harmony'].includes(options.platform)?options.platform:'web';
  function resetInert(){for(const element of [nav,lists,main,fab])element.inert=false;}
  function closeDrawer(restore=true) {
    if(!drawer)return;
    drawer='';root.classList.remove('bd-app--nav-open','bd-app--lists-open');backdrop.hidden=true;resetInert();
    root.querySelector('[data-action="navigation"]')?.setAttribute('aria-expanded','false');
    root.querySelector('[data-action="list-navigation"]')?.setAttribute('aria-expanded','false');
    if(restore&&previousFocus?.isConnected)previousFocus.focus();
  }
  function toggleDrawer(next) {
    if(drawer===next){closeDrawer();return;}
    closeDrawer(false);drawer=next;previousFocus=doc.activeElement;
    root.classList.add(next==='navigation'?'bd-app--nav-open':'bd-app--lists-open');backdrop.hidden=false;
    if(mobile){resetInert();main.inert=true;fab.inert=true;(next==='navigation'?lists:nav).inert=true;}
    root.querySelector(`[data-action="${next==='navigation'?'navigation':'list-navigation'}"]`)?.setAttribute('aria-expanded','true');
    (next==='navigation'?nav:lists).querySelector('button')?.focus();
  }
  function update() {
    frame=0;if(disposed)return;
    const bounds=host.getBoundingClientRect(),width=bounds.width||win.innerWidth;
    const next=Boolean(options.mobile)||width<=600,changed=next!==mobile;mobile=next;
    root.classList.toggle('bd-app--mobile',mobile);
    const viewport=win.visualViewport;
    if(mobile&&viewport&&viewport.scale===1&&bounds.height>0){
      const height=Math.max(0,Math.min(bounds.bottom,viewport.offsetTop+viewport.height)-Math.max(bounds.top,viewport.offsetTop));
      if(height>0)root.style.setProperty('--bd-viewport-height',`${Math.round(height)}px`);
    }else root.style.removeProperty('--bd-viewport-height');
    root.classList.toggle('bd-app--keyboard',Boolean(mobile&&viewport&&viewport.height<win.innerHeight-120&&/^(INPUT|TEXTAREA|SELECT)$/.test(doc.activeElement?.tagName||'')));
    if(changed){closeDrawer(false);options.onModeChange?.();}
  }
  function schedule(){if(!disposed&&!frame)frame=win.requestAnimationFrame?win.requestAnimationFrame(update):win.setTimeout(update,0);}
  const observer=typeof win.ResizeObserver==='function'?new win.ResizeObserver(schedule):null;
  observer?.observe(host);win.addEventListener('resize',schedule);win.visualViewport?.addEventListener('resize',schedule);win.visualViewport?.addEventListener('scroll',schedule);
  root.addEventListener('focusin',schedule);root.addEventListener('focusout',schedule);schedule();
  return {
    touchOnly:()=>mobile||Boolean(win.matchMedia?.('(pointer:coarse)').matches),isOpen:()=>Boolean(drawer),toggleDrawer,closeDrawer,
    keydown(event){
      if(!drawer)return false;
      if(event.key==='Escape'){event.preventDefault();closeDrawer();return true;}
      if(event.key!=='Tab')return false;
      const panel=drawer==='navigation'?nav:lists,buttons=[...panel.querySelectorAll('button')].filter(button=>!button.disabled&&!button.hidden);
      if(!buttons.length){event.preventDefault();return true;}
      const index=buttons.indexOf(doc.activeElement),next=event.shiftKey?(index<=0?buttons.length-1:index-1):(index+1)%buttons.length;
      event.preventDefault();buttons[next].focus();return true;
    },
    dispose(){disposed=true;observer?.disconnect();win.removeEventListener('resize',schedule);win.visualViewport?.removeEventListener('resize',schedule);win.visualViewport?.removeEventListener('scroll',schedule);root.removeEventListener('focusin',schedule);root.removeEventListener('focusout',schedule);if(frame){win.cancelAnimationFrame?.(frame);win.clearTimeout(frame);}resetInert();}
  };
}
