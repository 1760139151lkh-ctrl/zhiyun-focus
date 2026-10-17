// Share one verified helper startup between voice preparation and the course
// connection. A protocol request is only a request, never a ready acknowledgement.
export function createCompanionStartup({companion,signal,timeoutMs=12000}) {
  let pending=null,protocolRequested=false;
  const launchRequests=new Set();
  const check=()=>{if(signal?.aborted)throw signal.reason||new DOMException('Cancelled','AbortError')};
  function requestLaunch(){
    check();
    try{companion.launch();protocolRequested=true;}
    catch(error){throw Object.assign(Error('助手尚未启动，请打开本机助手后重试。'),{code:'companion_unavailable',action:'launch',cause:error})}
  }
  function ensure({launchIfNeeded=false,signal:callerSignal}={}) {
    check();if(callerSignal?.aborted)return Promise.reject(callerSignal.reason||new DOMException('Cancelled','AbortError'));
    const launchRequest=launchIfNeeded?{signal:callerSignal}:null;
    if(launchRequest)launchRequests.add(launchRequest);
    const release=()=>{if(launchRequest)launchRequests.delete(launchRequest)};
    if(!pending)pending=(async()=>{
      try{return await companion.waitForService({signal,timeoutMs:0})}
      catch(error){
        check();
        if(error.code!=='companion_unavailable')throw error;
        if(!protocolRequested){
          if(![...launchRequests].some(request=>!request.signal?.aborted))throw error;
          requestLaunch();
        }
        return companion.waitForService({signal,timeoutMs});
      }
    })().finally(()=>{pending=null;protocolRequested=false});
    if(!callerSignal)return pending.finally(release);
    return new Promise((resolve,reject)=>{
      const abort=()=>{release();reject(callerSignal.reason||new DOMException('Cancelled','AbortError'))};
      callerSignal.addEventListener('abort',abort,{once:true});
      pending.then(resolve,reject).finally(()=>{release();callerSignal.removeEventListener('abort',abort)});
      if(callerSignal.aborted)abort();
    });
  }
  return {
    ensure,
    launch(){try{requestLaunch();return ensure()}catch(error){return Promise.reject(error)}}
  };
}

// Begin Web Audio within the bookmark click, then wait for the local service.
// Opening a question, fullscreen and protection remain separate user actions.
export async function startImmersiveSession({audio,companion,signal,startService,clearInheritedProtection=()=>companion.guard(false)}) {
  const check=()=>{if(signal?.aborted)throw signal.reason||new DOMException('Cancelled','AbortError')};
  check();audio.start('clarity');
  if(startService){await startService();check();}
  const state=await companion.connect();check();
  // An upgrade can reconnect to a previous session before its disconnect
  // arrives. Clear that session's protection preference instead of inheriting it.
  if(state?.protected||state?.protectionRequested){await clearInheritedProtection(state);check();}
}
