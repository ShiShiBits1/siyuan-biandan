/** A SiYuan Dialog owns the mobile page, including native back and unload.
 * openTab is intentionally not used: it is a no-op in SiYuan's mobile build. */
export function createMobilePage({Dialog,mount,unmount,canClose=()=>true,onBlocked=()=>{}}={}){
  let dialog=null,model=null,disposed=false;
  function open(){
    if(disposed)return;
    if(dialog)return model;
    let current,forceClose=false;
    current=new Dialog({
      title:'便单伴侣 · 第三方',width:'100vw',height:'100dvh',
      content:'<div data-biandan-mobile-page style="height:100%;min-height:0;overflow:hidden"></div>',
      beforeClose:()=>{if(disposed||forceClose||canClose(model))return true;onBlocked();return false;},
      destroyCallback:()=>{
        const previous=model;model=null;dialog=null;
        if(previous)unmount(previous);
      },
    });
    dialog=current;
    const container=current.element.querySelector('.b3-dialog__container');
    if(container){container.style.maxWidth='100vw';container.style.maxHeight='100dvh';container.style.borderRadius='0';container.style.margin='0';}
    const body=current.element.querySelector('.b3-dialog__body');
    if(body){body.style.padding='0';body.style.minHeight='0';body.style.overflow='hidden';body.style.flex='1';}
    model={element:current.element.querySelector('[data-biandan-mobile-page]')};
    try{if(!model.element)throw new Error('移动页面未能打开，请重新启用插件');mount(model);}
    catch(error){forceClose=true;current.destroy();throw error;}
    return model;
  }
  return {open,close(){dialog?.destroy();},dispose(){if(disposed)return;disposed=true;dialog?.destroy();}};
}
