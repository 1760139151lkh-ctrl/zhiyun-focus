// Page fullscreen belongs to the click that requests it. Never wait for a
// helper, audio, window binding, or feature handshake before this call.
export function createViewerFullscreen({page=document,target=page.documentElement,inheritOwned=false,inheritPending=null,nativeActive=()=>false,enterNative,exitNative,releaseNative,refreshNative,changed=()=>{}}={}){
  let busy=false,owned=inheritOwned&&page.fullscreenElement===target,disposed=false,documentMode=owned,nativeEpoch=0,nativeWait=null,nativeError=null,documentRequest=null;
  let pendingTask=null,nativeReleaseTask=null,latest=null,nativeCommand=null,inheritedPending=inheritPending&&typeof inheritPending.then==='function'?inheritPending:null;
  const view=page.defaultView;
  const active=()=>!!page.fullscreenElement||(!documentMode&&nativeActive());
  const publish=()=>{if(!disposed)changed({active:active(),busy:busy||!!inheritedPending,nativeError})};
  if(inheritedPending)Promise.resolve(inheritedPending).catch(()=>{}).finally(()=>{inheritedPending=null;if(current(latest))start(latest);publish();});
  function observeNative(state){
    if(!nativeWait?.confirmed||page.fullscreenElement||state?.fullscreen!==false||!Number.isSafeInteger(state.sequence)||state.sequence<=nativeWait.sequence)return;
    documentMode=false;nativeWait=null;nativeError=null;publish();
  }
  async function reconcileNative({allowActive=false}={}){
    if(allowActive)nativeCommand=null;
    if(disposed||page.fullscreenElement||typeof refreshNative!=='function')return false;
    const epoch=++nativeEpoch;nativeWait={epoch,confirmed:false,sequence:0};nativeError=null;
    try{
      // Only a request initiated after this exit can establish the baseline.
      // Arbitrary native echoes received while an old request settles cannot.
      const state=await Promise.resolve().then(refreshNative);
      if(disposed||epoch!==nativeEpoch||page.fullscreenElement||typeof state?.fullscreen!=='boolean')return false;
      if(allowActive||!state.fullscreen){documentMode=false;nativeWait=null;}
      else nativeWait={epoch,confirmed:true,sequence:state.sequence||0};
      publish();return true;
    }catch(error){if(!disposed&&epoch===nativeEpoch){nativeWait=null;nativeError=error;publish()}return false;}
  }
  const updated=()=>{
    if(page.fullscreenElement===target&&documentRequest)documentRequest.entered=true;
    if(page.fullscreenElement!==target)owned=false;
    if(!page.fullscreenElement&&documentMode)void reconcileNative();
    else if(page.fullscreenElement){nativeEpoch++;nativeWait=null;}
    publish();
  };
  page.addEventListener('fullscreenchange',updated);
  view?.addEventListener('resize',publish);
  const current=operation=>!!operation&&!disposed&&operation.options.isCurrent?.()!==false&&!operation.options.signal?.aborted;
  const keepDocumentEntry=()=>current(latest)&&latest.wanted;
  async function enterWindowFullscreen(operation){
    const isCurrent=()=>current(operation),signal=operation.options.signal;
    if(disposed||!isCurrent())return;
    if(typeof enterNative!=='function')throw Error('全屏未开启，请按 F11 切换。');
    nativeCommand=operation;
    await enterNative(isCurrent,signal);
    if(disposed||!isCurrent())return;
    documentMode=false;nativeEpoch++;nativeWait=null;
    if(!nativeActive())throw Error('全屏未开启，请按 F11 切换。');
    if(nativeCommand===operation)nativeCommand=null;
  }
  async function transition(operation){
    const isCurrent=()=>current(operation),signal=operation.options.signal;
    if(!isCurrent())return false;
    try{
      if(!operation.wanted&&page.fullscreenElement&&(!operation.releasePending||owned)){
        documentMode=true;owned=false;await page.exitFullscreen();
      }else if(!operation.wanted&&(nativeCommand||!documentMode&&nativeActive())){
        // Native state must be known here, or belong to an older compatibility
        // request that the latest off intent is responsible for releasing.
        if(!exitNative)throw Error('请按 F11 退出浏览器窗口全屏。');
        nativeCommand=operation;
        await exitNative(isCurrent,signal);if(disposed||!isCurrent())return false;nativeCommand=null;documentMode=true;void reconcileNative();
      }else if(operation.wanted&&nativeCommand){
        // A cancelled compatibility request may already have posted F11.
        // Confirm the latest target through that same native path.
        await enterWindowFullscreen(operation);
      }else if(operation.wanted&&!active()){
        if(typeof target.requestFullscreen!=='function')throw Error('此页面无法自动全屏，请按 F11 切换。');
        documentMode=true;owned=true;nativeEpoch++;nativeWait=null;
        // Initial entry runs in its click. A queued reversal waits only for
        // the browser exit already in progress before making its new request.
        const request={entered:false};documentRequest=request;
        try{await target.requestFullscreen({navigationUI:'hide'});}
        catch{
          if(!request.entered)owned=false;
          // Compatibility is allowed only if the browser never entered. A
          // successful entry is never undone or followed by another toggle.
          if(isCurrent()&&!request.entered&&!page.fullscreenElement){await enterWindowFullscreen(operation);return true;}
        }finally{if(documentRequest===request)documentRequest=null;}
        if(!keepDocumentEntry()&&owned&&page.fullscreenElement===target){owned=false;await page.exitFullscreen();if(!disposed)void reconcileNative({allowActive:true});}
      }
      return !disposed&&isCurrent();
    }catch(error){
      if(!page.fullscreenElement)owned=false;
      if(!disposed)throw Error(error.message?.includes('F11')?error.message:'全屏未开启，请再点一次或按 F11。');
      return false;
    }
  }
  async function drain(operation){
    busy=true;publish();
    try{for(;;){
      try{await transition(operation)}catch(error){if(operation===latest&&current(operation)){nativeError=error;publish();throw error;}}
      // Closing, Escape and loss of the requesting intent also own the late
      // native effect. A deliberate F11 handoff releases that ownership first.
      if(!disposed&&!current(latest)&&nativeCommand)latest={wanted:false,options:{},releasePending:true};
      if(disposed||operation===latest||!current(latest))return current(operation);
      operation=latest;
    }}finally{busy=false;publish()}
  }
  function start(operation){
    nativeError=null;
    const task=drain(operation);pendingTask=task;task.finally(()=>{if(pendingTask===task)pendingTask=null;}).catch(()=>{});return task;
  }
  function toggle(options={}){
    if(disposed||options.isCurrent?.()===false||options.signal?.aborted)return Promise.resolve(false);
    const waiting=busy||!!inheritedPending,wanted=waiting&&latest?!latest.wanted:!active();latest={wanted,options,releasePending:waiting&&!wanted};
    // Coalesce pending reversals without overlapping document requests. An
    // in-flight entry can satisfy a newer entry, or release only its own entry.
    if(waiting)return Promise.resolve(false);
    return start(latest);
  }
  function releaseNativeOwnership(){
    nativeCommand=null;const epoch=++nativeEpoch,operation=latest;
    const failed=error=>{if(!disposed&&epoch===nativeEpoch&&operation===latest){nativeError=error;publish()}return false;};
    try{return Promise.resolve(releaseNative?.()).then(()=>true,failed)}catch(error){return Promise.resolve(failed(error))}
  }
  function pendingCompletion(){
    const task=pendingTask||inheritedPending;
    if(!task)return nativeReleaseTask;
    // A handoff snapshot is taken before disposal. Read its cleanup only after
    // the original transition settles, so the replacement also waits for off.
    const completion=Promise.resolve(task).finally(()=>nativeReleaseTask);
    completion.catch(()=>{});return completion;
  }
  return {toggle,active,observeNative,reconcileNative,releaseNativeOwnership,get busy(){return busy||!!inheritedPending},get pending(){return pendingCompletion()},get error(){return nativeError},get ownsDocument(){return owned&&page.fullscreenElement===target},dispose({preserve=false}={}){
    if(disposed)return;disposed=true;nativeEpoch++;nativeWait=null;page.removeEventListener('fullscreenchange',updated);view?.removeEventListener('resize',publish);
    if(nativeCommand){nativeCommand=null;try{nativeReleaseTask=Promise.resolve(exitNative?.(()=>true)).catch(()=>{})}catch{}}
    // A replacement can inherit only fullscreen that has actually entered.
    // Retain ownership of a pending request so its late entry is cleaned up.
    if(preserve&&page.fullscreenElement===target){owned=false;return;}
    if(owned&&page.fullscreenElement===target){owned=false;try{Promise.resolve(page.exitFullscreen()).catch(()=>{})}catch{}}
  }};
}
