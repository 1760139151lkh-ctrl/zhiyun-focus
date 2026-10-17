import {createClarityAudio} from './clarity.js';
export function createViewerAudio(video,notify,{prepareClarity,clarityOptions={}}={}) {
  let active=null,requested=null,pending=null,disposed=false,deferredStart=null,routes,events;
  const report=kind=>(mode,message,detail)=>{if(active!==kind||disposed)return;if(mode==='original'){active=null;if(requested){if(video.muted||video.volume===0)deferredStart='volume';else if(detail?.phase==='ended')deferredStart='play';}}notify(mode,message,detail)};
  function bind(){
    routes={clarity:createClarityAudio(video,report('clarity'),{...clarityOptions,prepare:prepareClarity})};
    events=new AbortController();video.addEventListener('loadedmetadata',()=>{if(requested&&!active&&!disposed)start(requested)},{signal:events.signal});
    const resume=event=>{if(deferredStart&&(event.type==='play'||deferredStart==='volume')&&requested&&!active&&!disposed&&!video.muted&&video.volume>0){deferredStart=null;void start(requested)}};
    video.addEventListener('volumechange',resume,{signal:events.signal});video.addEventListener('play',resume,{signal:events.signal});
  }
  function stopRoutes(){active=null;pending=null;deferredStart=null;Object.values(routes).forEach(r=>r.stop())}
  function stop(message=''){requested=null;stopRoutes();notify('original',message,{actualRoute:'original',phase:'ready',action:null})}
  function start(kind='clarity'){
    if(disposed)return Promise.resolve();requested=kind;if(active===kind&&!routes[active].inspect().failed)return pending;
    stopRoutes();if(!routes[kind]){requested=null;return Promise.resolve()}active=kind;deferredStart=video.muted||video.volume===0?'volume':null;
    const route=routes[kind];pending=Promise.resolve(route.start());return pending;
  }
  function rebind(next=video){
    if(disposed)return Promise.resolve();const desired=requested;stopRoutes();events.abort();if(next!==video&&!video.paused)video.pause();Object.values(routes).forEach(r=>r.dispose());video=next;bind();
    if(desired)return start(desired);notify('original','',{actualRoute:'original',phase:'ready',action:null});return Promise.resolve();
  }
  function sourceChanged(next=video){if(next!==video)return rebind(next);const desired=requested;stopRoutes();return desired?start(desired):Promise.resolve()}
  bind();
  return {start,stop,sourceChanged,rebind,
    pause(){if(active&&routes[active].pause)return routes[active].pause();const resume=!video.paused;video.pause();return resume},
    dispose(){disposed=true;active=null;requested=null;events.abort();Object.values(routes).forEach(r=>r.dispose())},
    inspect:()=>({...active?routes[active].inspect():{mode:'original',route:'original',actualRoute:'original',context:'none',ownsMute:false},requestedMode:requested||'original'})};
}
