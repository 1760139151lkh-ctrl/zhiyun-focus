// One explicit session. Never restore protection from storage or resume data.
export function isTouchInput(event) {
  return event.pointerType === 'touch' || event.pointerType === 'pen' ||
    event.type.startsWith('touch') || event.sourceCapabilities?.firesTouchEvents === true;
}

export function protectionEntryEvent(event,entry) {
  if(!entry||(!event.type.startsWith('pointer')&&!event.type.startsWith('touch')))return false;
  return event.composedPath?.().includes(entry)===true;
}

export function createInputGuard({target=window, changed=()=>{}, unlock=()=>{},allowProtectedPointer=()=>false,allowProtectedKeyboard=()=>false,blocked=()=>{}}={}) {
  let active=false, disposed=false;
  const controller=new AbortController();
  const stop=e=>{if(e.cancelable)e.preventDefault();e.stopImmediatePropagation()};
  const intercept=e=>{
    if(!active)return;
    if(e.type.startsWith('key')){if(!allowProtectedKeyboard(e)){blocked(e);stop(e);}return;}
    if(isTouchInput(e)&&!allowProtectedPointer(e)){blocked(e);stop(e);}
  };
  for(const type of ['keydown','keyup','keypress','pointerdown','pointerup','pointermove','pointercancel','click','dblclick','contextmenu','touchstart','touchmove','touchend','touchcancel'])
    target.addEventListener(type,intercept,{capture:true,passive:false,signal:controller.signal});
  return {
    set(value){if(disposed)return;active=!!value;changed(active)},
    setPointerAllowance(value){allowProtectedPointer=typeof value==='function'?value:()=>false},
    get active(){return active},
    dispose(){if(disposed)return;disposed=true;active=false;controller.abort();unlock();changed(false)}
  };
}

export function studyViewport(width,height,sidebarWidth=0) {
  const aside=Math.max(0,Math.min(Number(sidebarWidth)||0,width-1));
  return {width:Math.max(1,width-aside),height,aside};
}
