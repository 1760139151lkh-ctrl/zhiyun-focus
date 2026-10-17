// UI ownership comes from the shared intent scopes. Protection has its own
// explicit preference; temporary tasks borrow input without changing it.
export function createStudyInteraction({intents,changed=()=>{}}={}) {
  if(!intents?.observe)throw new TypeError('Study interaction requires shared intent scopes');
  const tasks=new Map();let next=0,wanted=false,active=false,disposed=false,pauseOwner=null,orphanPause=null;
  let context={connected:false,visible:true,foreground:true,mediaId:''};
  const available=()=>context.connected&&context.visible&&context.foreground;
  const guardTarget=()=>!disposed&&wanted&&available()&&context.canProtect!==false&&[...tasks.values()].every(task=>['chat','library','shot'].includes(task.kind));
  const current=task=>!disposed&&tasks.get(task.id)===task&&!task.owner.signal?.aborted&&task.owner.isCurrent();
  function snapshot(){const task=[...tasks.values()].at(-1);return {phase:task?'interacting':active?'protected':'viewing',task:task?.kind||null,protectionWanted:wanted,protectionActive:active,protectionTarget:guardTarget(),protectionPending:guardTarget()!==active,available:available()};}
  function publish(){if(!disposed)changed(snapshot())}
  function usable(record){return !!record&&!record.resumed&&record.ticket.isCurrent()&&record.mediaId===context.mediaId&&context.visible&&context.foreground;}
  const holdsPause=task=>task.pauseWanted&&task.playback.isCurrent()&&task.mediaId===context.mediaId;
  function outcome(record,shouldResume){return {resumePlayback:!!(shouldResume&&record?.resume&&usable(record)),playbackTicket:record?.ticket||null,
    restorePlayback(effect){if(disposed||!shouldResume||!record?.resume||!usable(record)||[...tasks.values()].some(holdsPause))return false;return record.ticket.commit(()=>{record.resumed=true;effect()});},protectionTarget:guardTarget()};}
  function finish(task,{resume=true}={}){
    if(tasks.get(task?.id)!==task)return outcome(null,false);
    tasks.delete(task.id);task.owner.signal?.removeEventListener('abort',task.aborted);task.controller.abort(new DOMException('Interaction ended','AbortError'));
    let record=null;
    if(pauseOwner===task){
      record=task.pauseRecord;pauseOwner=null;
      const nextPause=[...tasks.values()].reverse().find(holdsPause);
      if(nextPause){
        nextPause.pauseRecord=nextPause.pauseRecord||{ticket:nextPause.playback,resume:false,mediaId:nextPause.mediaId};
        if(usable(record)&&nextPause.pauseRecord.ticket.isCurrent())nextPause.pauseRecord.resume||=!!record.resume;
        pauseOwner=nextPause;record=null;
      }else if(!resume&&usable(record)){orphanPause=record;}
    }
    publish();return outcome(record,resume);
  }
  function begin(kind,{owner=intents.observe('workspace'),pausePlayback=false}={}){
    if(disposed)throw new DOMException('Viewer closed','AbortError');
    owner.assertCurrent();const task={id:++next,kind,owner,controller:new AbortController(),playback:intents.observe('playback'),mediaId:context.mediaId,pauseWanted:pausePlayback,pauseRecord:null};
    task.signal=task.controller.signal;
    task.aborted=()=>finish(task,{resume:false});
    task.isCurrent=()=>current(task);
    task.after=promise=>new Promise((resolve,reject)=>{
      const abort=()=>reject(task.signal.reason||new DOMException('Interaction ended','AbortError'));
      task.signal.addEventListener('abort',abort,{once:true});
      Promise.resolve(promise).then(value=>{task.signal.removeEventListener('abort',abort);current(task)?resolve(value):abort()},error=>{task.signal.removeEventListener('abort',abort);current(task)?reject(error):abort()});
      if(!current(task))abort();
    });
    task.claimPause=resume=>{
      if(!current(task)||!task.playback.isCurrent())return false;
      const previous=pauseOwner?.pauseRecord||orphanPause;
      task.pauseWanted=true;task.pauseRecord={ticket:task.playback,resume:!!resume||(usable(previous)&&!!previous.resume),mediaId:task.mediaId};
      pauseOwner=task;orphanPause=null;publish();return true;
    };
    // The pause itself must be inside the ownership check. Passing the result
    // of audio.pause() to claimPause after an await would pause too early.
    task.pause=effect=>{
      if(!current(task)||!task.playback.isCurrent()||task.mediaId!==context.mediaId||!context.visible||!context.foreground)return false;
      return task.claimPause(effect());
    };
    tasks.set(task.id,task);owner.signal?.addEventListener('abort',task.aborted,{once:true});publish();return task;
  }
  return {begin,end:finish,cancel:(task,options={})=>finish(task,{resume:false,...options}),
    setProtectionWanted(value){if(disposed)return;wanted=!!value;publish()},
    observeProtection(value){if(disposed||typeof value!=='boolean')return;active=value;publish()},
    setContext(value){if(disposed)return;context={...context,...value};if(orphanPause&&!usable(orphanPause))orphanPause=null;publish()},
    returnToStudy(){let result=outcome(orphanPause,true);for(const task of [...tasks.values()].reverse()){const ended=finish(task);if(ended.resumePlayback)result=ended;}if(orphanPause){result=outcome(orphanPause,true);orphanPause=null;}return result;},
    snapshot,
    dispose(){if(disposed)return;disposed=true;wanted=false;for(const task of [...tasks.values()])finish(task,{resume:false});active=false;orphanPause=null;pauseOwner=null;tasks.clear()}
  };
}

// Native input changes are serialized. A newer false target always follows an
// older enable that has already started; an old failure cannot win over it.
export function createProtectionReconciler({write,changed=()=>{}}={}) {
  if(typeof write!=='function')throw new TypeError('Protection reconciliation requires a native writer');
  let target=false,observed=false,revision=0,running=false,disposed=false,error=null;
  const waiting=[];
  const state=()=>({target,active:observed,busy:running,error});
  const publish=()=>{if(!disposed)changed(state())};
  function settle(failure){for(const waiter of waiting.splice(0))failure?waiter.reject(failure):waiter.resolve(state())}
  async function drain(){
    running=true;publish();
    try{for(;;){
      const ticket=revision,wanted=target;error=null;
      try{
        const result=await write(wanted);
        // A completed command is not proof that the native input guard moved.
        // Keep the last confirmed state when its acknowledgement is missing.
        if(typeof result?.protected!=='boolean')throw Error('写字保护状态尚未确认。');
        observed=result.protected;
        if(observed!==wanted)throw Error('写字保护尚未切换，请重试。');
      }catch(failure){if(ticket===revision){error=failure;settle(failure);return;}}
      if(ticket===revision){settle();return;}
    }}finally{running=false;publish();if(waiting.length&&!running)void drain()}
  }
  function request(value,{force=false}={}){
    if(disposed)return Promise.reject(new DOMException('Viewer closed','AbortError'));
    value=!!value;
    if(!force&&!running&&target===value&&observed===value&&!error)return Promise.resolve(state());
    if(force||target!==value||!running){target=value;revision++;}
    const promise=new Promise((resolve,reject)=>waiting.push({resolve,reject}));
    if(!running)void drain();return promise;
  }
  return {request,observe(value){if(disposed||typeof value!=='boolean')return;observed=value;publish()},inspect:state,
    dispose(){if(disposed)return;target=false;revision++;disposed=true;settle(new DOMException('Viewer closed','AbortError'));if(!running&&observed)Promise.resolve().then(()=>write(false)).catch(()=>{})}
  };
}
