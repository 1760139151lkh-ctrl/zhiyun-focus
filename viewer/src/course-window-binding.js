// Keep this session's nonce when course metadata/player updates replace <title>.
export function createCourseWindowBinding({page,win,marker,Observer=globalThis.MutationObserver}) {
  let titlePage=page,observer=null,active=false;
  try{if(win.top?.document&&typeof win.top.document.title==='string')titlePage=win.top.document}catch{}
  const unmark=value=>value.split(' '+marker).join('').replace(marker+' ','');
  function ensure(){
    active=true;
    if(!observer&&Observer&&titlePage.head){
      observer=new Observer(()=>{if(active)ensure()});
      observer.observe(titlePage.head,{childList:true,subtree:true,characterData:true});
    }
    const current=titlePage.title;
    if(!current.endsWith(' '+marker))titlePage.title=unmark(current)+' '+marker;
  }
  function release(){
    active=false;observer?.disconnect();observer=null;
    const current=titlePage.title,plain=unmark(current);
    if(plain!==current)titlePage.title=plain;
  }
  return {ensure,release};
}
