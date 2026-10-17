export async function ensureClarityService(startService,{signal,request=fetch,endpoint='http://127.0.0.1:8771',timeoutMs=45000,connectTimeoutMs=4000,startTimeoutMs=connectTimeoutMs,progress=()=>{}}={}) {
  const check=()=>{if(signal?.aborted)throw signal.reason||new DOMException('Cancelled','AbortError')};
  const failure=message=>Object.assign(Error(message),{action:'retry'});
  const begin=Date.now(),deadline=begin+timeoutMs;
  let lastSeen=0,started=begin,lastMessage='',retried=false;
  function report(message){if(message!==lastMessage){lastMessage=message;progress(message)}}
  async function health() {
    check();let value;
    try {
      const timeout=AbortSignal.timeout(Math.max(1,Math.min(600,deadline-Date.now())));
      const response=await request(endpoint+'/health',{credentials:'omit',cache:'no-store',signal:signal?AbortSignal.any([signal,timeout]):timeout});
      if(!response.ok)return null;
      value=await response.json();check();
    }catch(error){check();return null}
    if(value.protocol!==1||value.engine!=='MossFormer2_SE_48K')throw failure('声音服务版本不兼容');
    lastSeen=Date.now();
    if(value.status==='error'){
      if(retried||!value.retry_initialization)throw failure(value.message||'声音组件加载失败');
      // A click on Retry must actually retry a failed model load. Reuse the
      // listening helper, and allow only one attempt per user startup request.
      retried=true;report('正在重新准备人声模型…');check();
      try{
        const timeout=AbortSignal.timeout(Math.max(1,Math.min(600,deadline-Date.now())));
        const response=await request(endpoint+'/retry',{method:'POST',credentials:'omit',cache:'no-store',
          headers:{'X-ZJF-Protocol':'1'},signal:signal?AbortSignal.any([signal,timeout]):timeout});
        if(!response.ok)throw failure('声音组件重试失败，请重试');
        const result=await response.json();check();
        if(result.protocol!==1)throw failure('声音服务版本不兼容');
        if(result.status==='error')throw failure(result.message||'声音组件加载失败');
        return result.status==='ready';
      }catch(error){check();throw error.action?error:failure('声音组件重试失败，请重试')}
    }
    // Older helpers load weights on the first range and have no status field.
    if(!value.status||value.status==='ready')return true;
    report(value.message||'正在准备人声模型…');return false;
  }
  let state=await health();
  if(state===true)return;
  if(state===null){
    report('正在启动声音服务…');check();
    const controller=new AbortController();
    const abort=()=>controller.abort(signal.reason);
    signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>controller.abort(failure('声音服务没有响应，请重试')),Math.max(1,Math.min(startTimeoutMs,timeoutMs)-(Date.now()-begin)));
    let rejectAbort;
    try{
      await Promise.race([Promise.resolve().then(()=>{check();return startService(controller.signal)}),new Promise((_,reject)=>{
        rejectAbort=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',rejectAbort,{once:true});
        if(controller.signal.aborted)rejectAbort();
      })]);
    }catch(error){check();throw error.action?error:Object.assign(Error(error.status?'声音服务启动失败：'+error.message:'尚未启用，请启动本机助手'),{action:error.status?'retry':'launch'})}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',rejectAbort)}
    // Waiting for Chrome/Windows to start the companion is a separate stage.
    // Give the newly requested audio process its own connection budget.
    started=Date.now();
  }
  while(Date.now()<deadline){
    if(await health()===true)return;
    if(Date.now()-(lastSeen||started)>=connectTimeoutMs)throw failure('声音服务没有响应，请重试');
    await new Promise((resolve,reject)=>{
      const abort=()=>{clearTimeout(timer);reject(signal.reason||new DOMException('Cancelled','AbortError'))};
      const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve()},Math.min(200,Math.max(1,deadline-Date.now())));
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    });
  }
  check();throw failure(lastSeen?'人声模型准备超时，请重试':'声音服务没有响应，请重试');
}
