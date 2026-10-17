// A deliberate press, slide and release. A static book/palm contact cannot
// activate it, and holding alone never invokes a command.
export function createProtectionDoor({element,eventTarget=element,activate,changed=()=>{},enabled=()=>true,evidence=()=>'',now=()=>performance.now(),holdMs=350,maxMs=2600,schedule=setTimeout,unschedule=clearTimeout}={}) {
  if(!element||typeof activate!=='function')throw new TypeError('Protection door requires an element and action');
  const controller=new AbortController(),blockedPointers=new Set();let press=null,timer=0,epoch=0,disposed=false;
  const on=(target,type,handler,options={})=>target?.addEventListener(type,handler,{...options,signal:controller.signal});
  const bounds=()=>element.getBoundingClientRect();
  const inside=(r,x,y)=>x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom;
  const emit=state=>{if(!disposed)changed(state)};
  function cancel(){
    epoch++;unschedule(timer);timer=0;const previous=press;press=null;
    if(previous)try{element.releasePointerCapture?.(previous.id)}catch{}
    emit({phase:'idle',progress:0});
  }
  function fresh(){
    if(!press||disposed||!enabled()||element.isConnected===false||press.evidence!==evidence()||now()-press.time>maxMs)return false;
    const current=bounds();return ['left','top','width','height'].every(key=>Math.abs(current[key]-press.bounds[key])<1);
  }
  function down(event){
    if(disposed||!enabled())return;
    const r=bounds(),kind=event.sourceCapabilities?.firesTouchEvents?'touch':event.pointerType;
    if(!['mouse','touch','pen'].includes(kind))return;
    if(kind==='mouse'&&eventTarget!==element&&!event.composedPath?.().includes(element))return;
    if(!inside(r,event.clientX,event.clientY)||r.width<=0||r.height<=0)return;
    // Native protection passes this rectangle through. Even a rejected palm
    // contact must finish here rather than starting a drag on the video below.
    if(kind!=='mouse'){blockedPointers.add(event.pointerId);event.preventDefault();event.stopPropagation();}
    if(press){if(event.pointerId!==press.id)cancel();return;}
    if(event.button!==0||event.isPrimary===false)return;
    if(kind!=='mouse'&&event.clientX>r.left+r.width*.28)return;
    event.preventDefault();event.stopPropagation();
    const ticket=++epoch;press={id:event.pointerId,kind,x:event.clientX,y:event.clientY,time:now(),bounds:r,evidence:evidence(),ready:false};
    element.setPointerCapture?.(event.pointerId);emit({phase:kind==='mouse'?'pressed':'holding',progress:0});
    if(kind!=='mouse')timer=schedule(()=>{
      timer=0;if(ticket!==epoch||!press)return;if(!fresh()){cancel();return;}
      emit({phase:'sliding',progress:0});timer=schedule(()=>{timer=0;if(ticket===epoch&&press)cancel()},Math.max(0,maxMs-(now()-press.time)));
    },holdMs);
  }
  function move(event){
    if(blockedPointers.has(event.pointerId)){event.preventDefault();event.stopPropagation();}
    if(!press||event.pointerId!==press.id)return;
    if(!fresh()){cancel();return;}
    const r=press.bounds,dx=event.clientX-press.x,dy=event.clientY-press.y;
    if(!inside(r,event.clientX,event.clientY)||Math.abs(dy)>r.height*.45||dx<-6){cancel();return;}
    if(press.kind==='mouse')return;
    if(now()-press.time<holdMs&&Math.abs(dx)>8){cancel();return;}
    const travel=Math.max(64,r.width*.58);
    press.ready=now()-press.time>=holdMs&&dx>=travel&&event.clientX>=r.left+r.width*.78;
    emit({phase:press.ready?'ready':now()-press.time>=holdMs?'sliding':'holding',progress:Math.max(0,Math.min(1,dx/travel))});
  }
  function up(event){
    if(blockedPointers.delete(event.pointerId)){event.preventDefault();event.stopPropagation();}
    if(!press||event.pointerId!==press.id)return;
    move(event);if(!press)return;
    const current=press,valid=fresh()&&inside(current.bounds,event.clientX,event.clientY)&&(current.kind==='mouse'||current.ready);
    event.preventDefault();event.stopPropagation();cancel();
    if(valid)activate({input:current.kind,gesture:current.kind==='mouse'?'click':'press-slide-release'});
  }
  function observePointer(event){if(press&&event.type==='pointerdown'&&event.pointerId!==press.id)cancel()}
  const capture={capture:eventTarget!==element};
  on(eventTarget,'pointerdown',down,capture);on(eventTarget,'pointermove',move,capture);on(eventTarget,'pointerup',up,capture);
  for(const type of ['pointercancel','lostpointercapture'])on(eventTarget,type,event=>{blockedPointers.delete(event.pointerId);if(press?.id===event.pointerId)cancel();},capture);
  // Pointer activation already happened on release. Compatibility clicks must
  // not activate a second time or turn a static touch into an unlock.
  on(element,'click',event=>{event.preventDefault();event.stopImmediatePropagation();if(!press&&element.isConnected!==false&&event.detail===0&&!event.pointerType&&!event.sourceCapabilities?.firesTouchEvents&&enabled())activate({input:'keyboard',gesture:'activate'})});
  on(element.ownerDocument?.defaultView,'blur',cancel);
  on(element.ownerDocument,'visibilitychange',()=>{if(element.ownerDocument.hidden)cancel()});
  return {cancel,observePointer,get holding(){return !!press},dispose(){if(disposed)return;cancel();blockedPointers.clear();disposed=true;controller.abort()}};
}

// Native protection consumes keys before the page sees them. This identical
// release gesture also covers the page guard while native state is settling.
// Holding alone never returns to the controls or exits document fullscreen.
export function createProtectionKeyboardDoor({activate,enabled=()=>true,evidence=()=>'',now=()=>performance.now(),holdMs=1200,maxMs=6000,target,changed=()=>{}}={}) {
  if(typeof activate!=='function')throw new TypeError('Keyboard protection door requires an action');
  const controller=new AbortController();let press=null,disposed=false;
  function cancel(){if(!press)return;press=null;changed({phase:'idle'})}
  function handle(event){
    if(disposed)return false;
    if(!enabled()||event.isComposing||event.keyCode===229||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey){cancel();return false}
    if(event.type!=='keydown'&&event.type!=='keyup')return false;
    if(event.key!=='Escape'){cancel();return false}
    if(event.type==='keydown'){
      if(press)return true;
      if(event.repeat)return false;
      press={time:now(),evidence:evidence()};changed({phase:'holding'});return true;
    }
    const current=press;if(!current)return false;
    const duration=now()-current.time,valid=current.evidence===evidence()&&duration>=holdMs&&duration<=maxMs;
    cancel();if(valid)activate({input:'keyboard',gesture:'hold-release'});return valid;
  }
  target?.addEventListener('blur',cancel,{signal:controller.signal});
  const page=target?.document;page?.addEventListener('visibilitychange',()=>{if(page.hidden)cancel()},{signal:controller.signal});
  target?.addEventListener('compositionstart',cancel,{signal:controller.signal});
  return {handle,cancel,get holding(){return !!press},dispose(){if(disposed)return;cancel();disposed=true;controller.abort()}};
}
