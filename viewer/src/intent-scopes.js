// A task borrows one user-controlled resource. Only a new user intent advances
// it; finishing background work never takes ownership from a newer action.
export class IntentSupersededError extends Error {
  constructor(){super('已有新的操作。');this.name='AbortError';this.code='intent_superseded';}
}

export function createIntentScopes(){
  const resources=new Map();let disposed=false;
  const nameOf=name=>{if(typeof name!=='string'||!name)throw TypeError('An intent resource needs a name.');return name};
  const resource=name=>{nameOf(name);if(!resources.has(name))resources.set(name,{revision:0,controller:new AbortController()});return resources.get(name)};
  function ticket(name,entry){
    const current=()=>!disposed&&resources.get(name)===entry&&!entry.controller.signal.aborted;
    const assertCurrent=()=>{if(!current())throw new IntentSupersededError()};
    return Object.freeze({resource:name,revision:entry.revision,signal:entry.controller.signal,isCurrent:current,assertCurrent,
      after(promise){
        // Observe even a stale promise so its eventual rejection is handled.
        const pending=Promise.resolve(promise);
        return new Promise((resolve,reject)=>{
          const abort=()=>{cleanup();reject(new IntentSupersededError())};
          const cleanup=()=>entry.controller.signal.removeEventListener('abort',abort);
          entry.controller.signal.addEventListener('abort',abort,{once:true});
          pending.then(value=>{cleanup();current()?resolve(value):reject(new IntentSupersededError())},error=>{cleanup();reject(current()?error:new IntentSupersededError())});
          if(!current())abort();
        });
      },
      commit(effect){if(!current())return false;effect();return true;}
    });
  }
  function advance(names){
    if(disposed)throw new IntentSupersededError();
    const entries=[...new Set(names.map(nameOf))].map(name=>{const old=resource(name);return {name,old,next:{revision:old.revision+1,controller:new AbortController()}}});
    // Install every new owner before abort listeners run. Those listeners may
    // start another action; such a newer action must survive this invalidation.
    for(const entry of entries)resources.set(entry.name,entry.next);
    for(const entry of entries)entry.old.controller.abort(new IntentSupersededError());
    return entries.map(entry=>ticket(entry.name,entry.next));
  }
  return {
    begin:name=>advance([name])[0],
    observe(name){if(disposed)throw new IntentSupersededError();return ticket(name,resource(name))},
    invalidate(...names){advance(names)},
    dispose(){if(disposed)return;disposed=true;for(const entry of resources.values())entry.controller.abort(new IntentSupersededError())}
  };
}
