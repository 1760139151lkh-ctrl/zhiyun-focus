export const studyActionTitle=kind=>({connection:'连接助手',fullscreen:'全屏',chat:'提问',guard:'写字保护'}[kind]||'连接助手');

// An error and its retry belong to the initiating operation, never to whichever
// settings tab happened to have been opened previously.
export function createStudyActions(changed=()=>{}) {
  let active=null,disposed=false,sequence=0;
  const failed=new Map();
  function cancel(kind=active?.kind){
    if(kind)failed.delete(kind);
    if(!active||(kind&&active.kind!==kind))return false;
    const operation=active;active=null;
    operation.owner?.signal?.removeEventListener('abort',operation.cancel);
    changed({kind:operation.kind,busy:false,message:'',error:false,cancelled:true,id:operation.id});
    operation.controller.abort(new DOMException('Operation cancelled','AbortError'));return true;
  }
  async function run(kind,action,prepare,{owner,replace=false,message='正在连接…'}={}){
    if(disposed||owner?.isCurrent()===false)return false;
    if(active){if(replace||active.owner?.isCurrent()===false)cancel();else return false;}
    if(disposed||active||owner?.isCurrent()===false)return false;
    const operation={kind,id:++sequence,owner,controller:new AbortController()};active=operation;failed.delete(kind);
    operation.cancel=()=>{if(active===operation)cancel(kind)};
    owner?.signal?.addEventListener('abort',operation.cancel,{once:true});
    const signal=operation.controller.signal;
    changed({kind,busy:true,message,error:false,id:operation.id});
    let error=null;
    const check=()=>{if(signal.aborted)throw signal.reason;owner?.assertCurrent();};
    let rejectAbort;
    try{
      const abort=new Promise((_,reject)=>{rejectAbort=()=>reject(signal.reason);signal.addEventListener('abort',rejectAbort,{once:true});if(signal.aborted)rejectAbort()});
      const work=Promise.resolve().then(async()=>{check();if(prepare)await prepare(signal,owner);check();await action(signal,owner);check()});
      await Promise.race([work,abort]);return true;
    }catch(value){if(active===operation&&value.name!=='AbortError'){error=value;failed.set(kind,action)}return false;}
    finally{
      signal.removeEventListener('abort',rejectAbort);owner?.signal?.removeEventListener('abort',operation.cancel);
      if(active===operation){active=null;changed({kind,busy:false,message:error?.message||'',error:!!error,id:operation.id})}
    }
  }
  return {run,cancel,retry(kind,fallback,prepare,options){return run(kind,failed.get(kind)||fallback,prepare,options)},
    inspect:()=>({busy:!!active,kind:active?.kind||null,failed:[...failed.keys()]}),
    dispose(){if(disposed)return;disposed=true;cancel();failed.clear()}
  };
}
