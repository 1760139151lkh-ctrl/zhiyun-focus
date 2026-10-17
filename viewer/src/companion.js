import {createCourseWindowBinding} from './course-window-binding.js';
import {sameCaptureMetrics,validateNativeCapture} from './capture-viewport.js';
import {lessonLayoutKey} from './layouts.js';
import {captureCourseInfo} from './capture-course.js';
import {imageDataBlob} from './image-data.js';
const COMPANION_URL='http://127.0.0.1:8772';
const CHAT_FEATURES=['sidebar-resize','content-clip','lesson-drafts-v1'];
const DRAFT_FEATURES=['capture-drafts','capture-delivery-v2','draft-plan-projection','capture-question-v1'];
export function createStudyCompanion({changed=()=>{},request=fetch,page=document,win=window,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),connectTimeoutMs=10000,Observer=globalThis.MutationObserver,geometry=()=>null,mediaIdentity=()=>''}={}) {
  const marker=win.__ZJF_COMPANION_MARKER__||('[ZJF:'+crypto.randomUUID().replaceAll('-','')+']');
  win.__ZJF_COMPANION_MARKER__=marker;
  let auth='',serverToken='',features=[],session='',timer=0,disposed=false,inFlight=false,epoch=0;
  const binding=createCourseWindowBinding({page,win,marker,Observer});
  let authenticating=null,connecting=null,reconnectTimer=0,fullscreenRevision=0;
  const requiredFeatures=new Set();
  let state={connected:false,protected:false,chatOpen:false,chatVisible:false,chatAttached:false,sidebarWidth:0,reason:''};
  const geometryInstance=crypto.randomUUID();let geometryEpoch=0,geometrySignature='';
  const courseIdentity=()=>lessonLayoutKey(win.location?.href||page.location?.href||'')||'';
  function commandOwner({signal,isCurrent=()=>true}={}){
    const lesson=courseIdentity(),media=mediaIdentity();
    return ()=>!disposed&&!signal?.aborted&&isCurrent()&&courseIdentity()===lesson&&mediaIdentity()===media;
  }
  const checkOwner=(current,signal)=>{if(!current()||signal?.aborted)throw signal?.reason||new DOMException('Cancelled','AbortError')};
  const metrics=()=>{
    const value={width:win.innerWidth,height:win.innerHeight,dpr:win.devicePixelRatio||1,lessonKey:lessonLayoutKey(win.location?.href||page.location?.href||'')||'',course:captureCourseInfo(page)},layout=geometry();
    if(layout){
      const geometryLayout=JSON.parse(JSON.stringify(layout));
      const signature=JSON.stringify({width:value.width,height:value.height,dpr:value.dpr,course:value.course,layout:geometryLayout});if(signature!==geometrySignature){geometrySignature=signature;geometryEpoch++}
      value.geometry={...geometryLayout,instance:geometryInstance,epoch:geometryEpoch};
      value.headerHeight=Number(layout.headerHeight)||0;
      if(Number.isSafeInteger(state.workspaceRevision)&&state.workspaceRevision>0)value.workspaceRevision=state.workspaceRevision;
    }
    return value;
  };
  const publish=value=>{if(value.sequence&&value.sequence<(state.sequence||0))return;state={...state,...value};changed({...state})};
  async function assetCaptureRequest(data){
    const pixels=new Map(),batch={...data.batch},context=[];
    for(const [index,item]of [...batch.context,batch.selection].entries()){
      if(!item.image&&/^[a-f0-9]{64}$/.test(item.asset||'')){const stored={...item,image:''};if(index<batch.context.length)context.push(stored);else batch.selection=stored;continue;}
      let asset=pixels.get(item.image);
      if(!asset){
        if(!/^data:image\/png;base64,/.test(item.image||'')||item.image.length>96*1024*1024)throw Error('原图超过当前保存范围，已取得的材料仍保留在本页。');
        const bytes=await imageDataBlob(item.image).arrayBuffer();asset=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
        const saved=await call('/library/asset',{asset,image:item.image},false,30000);if(saved?.asset!==asset)throw Error('原图保存尚未确认，请保留本页并重试。');pixels.set(item.image,asset);
      }
      const stored={...item,asset,image:''};delete stored.thumbnail;if(index<batch.context.length)context.push(stored);else batch.selection=stored;
    }
    batch.context=context;return {...data,batch};
  }
  const restoreTitle=()=>binding.release(),markTitle=()=>binding.ensure();
  async function call(path,data,keepalive=false,timeoutMs=2500,signal,retainResult=false,onPost) {
    const abort=new AbortController(),deadline=Date.now()+timeoutMs,timeout=setTimeout(()=>abort.abort(),timeoutMs);
    try {
      let body;
      try{body=data?JSON.stringify({session,...data,_zjfDeadlineUtcMs:deadline}):undefined}catch{throw Object.assign(Error('请求数据无法编码，请重新整理本次材料后重试。'),{code:'invalid_payload'})}
      if(data)onPost?.();
      const response=await request(COMPANION_URL+path,{method:data?'POST':'GET',headers:{'X-ZJF-Protocol':'1',...(auth?{'X-ZJF-Companion':auth}:{}),...(data?{'Content-Type':'application/json'}:{})},body,signal:signal?AbortSignal.any([signal,abort.signal]):abort.signal,cache:'no-store',credentials:'omit',keepalive});
      const result=await response.json();
      if(signal?.aborted&&!retainResult)throw signal.reason||new DOMException('Cancelled','AbortError');
      if(!response.ok||result.error)throw Object.assign(new Error(result.error||'沉浸助手连接失败'),{status:response.status,code:result.code});return result;
    }catch(error){
      if(signal?.aborted)throw signal.reason||new DOMException('Cancelled','AbortError');
      if(data&&error.status===undefined&&(abort.signal.aborted||['AbortError','TimeoutError'].includes(error.name)))throw Object.assign(Error('本次操作等待超时。助手可能仍在完成已开始的操作，请先查看当前状态后再重试。'),{code:'companion_timeout',action:'check-status',uncertain:true});
      if(['TypeError','AbortError','TimeoutError'].includes(error.name))throw Object.assign(Error('暂时无法连接'),{code:'companion_unavailable',action:'launch'});
      throw error;
    }finally{clearTimeout(timeout)}
  }
  function lost(message){epoch++;clearTimeout(timer);session='';auth='';features=[];restoreTitle();publish({sequence:0,connected:false,protected:false,protectionRequested:false,chatOpen:false,chatVisible:false,chatOpening:false,chatAttached:false,chatDraftReady:false,chatDraftTarget:null,sidebarWidth:0,requiresUpdate:false,reason:message})}
  async function authenticate(refresh=false){
    if(disposed)throw Error('观看器已关闭');
    if(auth&&!refresh)return;
    if(!authenticating)authenticating=call('/hello').then(hello=>{
      if(hello.engine!=='zjf-companion'||typeof hello.token!=='string')throw Error('连接不兼容');
      if(hello.version!=='1.5.5')throw Object.assign(Error('需要更新连接组件'),{code:'companion_upgrade',action:'launch'});
      if(disposed)throw Error('操作已取消');
      if(session&&serverToken&&serverToken!==hello.token)lost('正在重新连接助手…');
      auth=serverToken=hello.token;features=Array.isArray(hello.features)?hello.features:[];
      if(state.requiresUpdate&&[...requiredFeatures].every(feature=>features.includes(feature)))publish({requiresUpdate:false});
    }).finally(()=>{authenticating=null});
    return authenticating;
  }
  async function requireChatSupport(){
    for(const feature of CHAT_FEATURES)requiredFeatures.add(feature);
    await authenticate();
    if(!CHAT_FEATURES.every(feature=>features.includes(feature))){
      publish({requiresUpdate:true});
      throw Object.assign(Error('提问需要更新'),{code:'companion_upgrade',action:'launch'});
    }
  }
  async function requireLibrarySupport(){
    requiredFeatures.add('study-library');requiredFeatures.add('library-course-scope-v1');await authenticate();
    if(!['study-library','library-course-scope-v1'].every(feature=>features.includes(feature))){
      publish({requiresUpdate:true});
      throw Object.assign(Error('资料需要更新'),{code:'companion_upgrade',action:'launch'});
    }
  }
  async function requireFeatures(needed,message='继续当前操作需要更新连接组件。'){
    for(const feature of needed)requiredFeatures.add(feature);await authenticate();
    if(!needed.every(feature=>features.includes(feature))){publish({requiresUpdate:true});throw Object.assign(Error(message),{code:'companion_upgrade',action:'launch'});}
  }
  async function requirePersistentCaptureSupport(){
    requiredFeatures.add('persistent-capture-outbox');await authenticate();
    if(!features.includes('persistent-capture-outbox')){
      publish({requiresUpdate:true});
      throw Object.assign(Error('保存需要更新'),{code:'companion_upgrade',action:'launch'});
    }
  }
  async function requireDraftSupport(){
    for(const feature of DRAFT_FEATURES)requiredFeatures.add(feature);await authenticate();
    if(!DRAFT_FEATURES.every(feature=>features.includes(feature))){publish({requiresUpdate:true});throw Object.assign(Error('附图需要更新'),{code:'companion_upgrade',action:'launch'})}
  }
  async function requireWorkspaceSupport(){
    requiredFeatures.add('workspace-v1');await authenticate();
    if(!features.includes('workspace-v1')){
      publish({requiresUpdate:true});
      throw Object.assign(Error('工作区需要更新'),{code:'companion_upgrade',action:'launch'});
    }
  }
  function reconnectQuietly(attempt=0){
    clearTimeout(reconnectTimer);if(disposed||attempt>=3)return;
    reconnectTimer=setTimeout(()=>{if(disposed||page.hidden||session)return;void connect().catch(()=>reconnectQuietly(attempt+1));},700*2**attempt);
  }
  async function pulse(){
    if(disposed||!session)return;
    if(inFlight){timer=setTimeout(pulse,700);return}
    const generation=epoch;inFlight=true;markTitle();
    try{const value=await call('/pulse',metrics());if(generation===epoch&&!disposed){if(!value.connected){lost(value.reason);reconnectQuietly();}else publish(value)}}
    catch{if(generation===epoch&&!disposed){lost('助手连接中断，保护已解除。');reconnectQuietly();}}
    finally{inFlight=false;if(!disposed&&generation===epoch&&session)timer=setTimeout(pulse,800)}
  }
  async function connectNow(){
    if(disposed)throw Error('观看器已关闭');if(session)return {...state};
    const generation=++epoch,current=commandOwner();
    try{
      await authenticate();
      if(!current()||generation!==epoch)throw new DOMException('Cancelled','AbortError');
      const deadline=Date.now()+connectTimeoutMs;
      let value,renewed=false,pendingError=null;
      for(let attempt=0;;attempt++){
        markTitle();
        await wait(Math.min(attempt?120:80,Math.max(0,deadline-Date.now())));
        if(!current()||generation!==epoch)throw new DOMException('Cancelled','AbortError');
        markTitle();
        const remaining=deadline-Date.now();if(pendingError&&remaining<=0)throw pendingError;
        try{value=await call('/connect',{marker,...metrics()},false,Math.max(1,Math.min(3000,remaining)));break}
        catch(error){
          if(error.status===403&&!renewed){renewed=true;auth='';await authenticate();continue;}
          const pending=['window_pending','companion_timeout'].includes(error.code)||/^(未找到当前课程窗口|课程窗口尚未就绪)/.test(error.message);
          if(!pending||Date.now()>=deadline)throw error;
          pendingError=error;
        }
      }
      if(!current()||generation!==epoch){call('/disconnect',{session:value.session},true).catch(()=>{});throw new DOMException('Cancelled','AbortError')}
      session=value.session;publish(value);timer=setTimeout(pulse,800);return {...state};
    }catch(error){if(!disposed&&generation===epoch)lost(error.message);throw error}
  }
  function connect(){if(!connecting)connecting=connectNow().finally(()=>{connecting=null});return connecting}
  async function waitForService({signal,timeoutMs=12000}={}){
    if(signal?.aborted)throw signal.reason||new DOMException('Cancelled','AbortError');
    let cancelled;
    const cancellation=signal?new Promise((_,reject)=>{cancelled=()=>reject(signal.reason||new DOMException('Cancelled','AbortError'));signal.addEventListener('abort',cancelled,{once:true})}):null;
    const deadline=Date.now()+timeoutMs;
    try{for(;;){
      if(disposed)throw Error('观看器已关闭');
      try{const request=authenticate(true);await (cancellation?Promise.race([request,cancellation]):request);return {...state}}
      catch(error){
        if(signal?.aborted)throw signal.reason||new DOMException('Cancelled','AbortError');
      if(!['companion_unavailable','companion_timeout','companion_upgrade'].includes(error.code)||Date.now()>=deadline)throw error;
        const delay=wait(Math.min(200,Math.max(0,deadline-Date.now())));await (cancellation?Promise.race([delay,cancellation]):delay);
      }
    }}finally{if(cancelled)signal.removeEventListener('abort',cancelled)}
  }
  async function waitUntilReady({timeoutMs=10000,forChat=false,forLibrary=false,forDraft=false}={}){
    const deadline=Date.now()+timeoutMs;
    for(;;){
      if(disposed)throw Error('观看器已关闭');
      try{await authenticate(true);const value=forLibrary&&!forChat&&!forDraft?{...state}:await connect();if(forChat)await requireChatSupport();if(forLibrary)await requireLibrarySupport();if(forDraft)await requireDraftSupport();const family=new Set([...(forLibrary?['study-library','library-course-scope-v1','persistent-capture-outbox','persistent-plan-outbox','capture-target-v1','capture-retire-v1','capture-reconcile-v1','capture-assets-v1','capture-context-v1','library-selections-v1']:[]),...(forChat?['sidebar-resize','content-clip','lesson-drafts-v1','workspace-v1','chat-keyboard-focus']:[]),...(forDraft?['capture-drafts','capture-delivery-v2','draft-plan-projection','capture-question-v1','capture-assets-v1','draft-reopen-v1']:[])]);await requireFeatures([...requiredFeatures].filter(feature=>family.has(feature)));return value}catch(error){
        if(!['companion_unavailable','companion_timeout','companion_upgrade','window_pending'].includes(error.code)||Date.now()>=deadline)throw error;
        await wait(Math.min(200,Math.max(0,deadline-Date.now())));
      }
    }
  }
  function commandFeatures(path,data){
    if(path==='/workspace')return ['workspace-v1',...(data.mode==='chat'?CHAT_FEATURES:[])];
    if(path==='/guard')return data.enabled&&state.workspaceMode&&state.workspaceMode!=='closed'?['protection-overlay-v1','protection-input-scope-v1']:[];
    if(path==='/sidebar')return data.enabled?CHAT_FEATURES:[];
    if(['/sidebar/resize','/sidebar/commit','/chat/navigate'].includes(path))return CHAT_FEATURES;
    if(path==='/chat/focus')return [...CHAT_FEATURES,'chat-keyboard-focus'];
    if(path==='/chat/restore-draft')return [...DRAFT_FEATURES,'draft-reopen-v1'];
    if(path==='/capture')return ['capture-viewport-v1',...(data.paint?['capture-paint-v1']:[])];
    if(path==='/capture/saved')return [...DRAFT_FEATURES,'capture-assets-v1'];
    if(['/capture/draft','/capture/plan'].includes(path))return DRAFT_FEATURES;
    return [];
  }
  async function command(path,data,stateResponse=true,timeoutMs=2500,signal,isCurrent=()=>true,acceptedResult=false,onPost){
    const current=commandOwner({signal,isCurrent});checkOwner(current,signal);
    if(disposed||!session)throw Error('请先连接沉浸助手。');
    const needed=commandFeatures(path,data);let generation=epoch;
    let value;
    try{value=await call(path,data,false,timeoutMs,signal,acceptedResult,onPost)}catch(error){
      if(signal?.aborted)throw signal.reason||new DOMException('Cancelled','AbortError');
      if((['window_pending','lesson_changed'].includes(error.code)||error.status===403||error.message.includes('课程连接已结束'))&&!disposed&&generation===epoch){
        checkOwner(current,signal);lost('正在重新连接助手…');await connect();checkOwner(current,signal);if(needed.length)await requireFeatures(needed);checkOwner(current,signal);generation=epoch;value=await call(path,data,false,timeoutMs,signal,acceptedResult,onPost);
      }else{if(error.code==='companion_unavailable'&&!disposed&&generation===epoch)lost(error.message);throw error}
    }
    // A capture response belongs to its frozen delivery, even after its UI
    // owner leaves. Return it for durable reconciliation without publishing UI.
    if(!acceptedResult){checkOwner(current,signal);if(disposed||generation!==epoch)throw Error('操作已取消');}
    if(stateResponse)publish(value);return stateResponse?{...state}:value;
  }
  return {
    connect,
    waitForService,
    launch:()=>win.location.assign('zhiyun-focus://start'),
    waitUntilReady,
    requireDraftSupport,
    requireWorkspaceSupport,
    refresh:()=>{markTitle();return command('/pulse',metrics())},
    async guard(enabled,seconds=0){
      const current=commandOwner();
      if(enabled&&state.workspaceMode&&state.workspaceMode!=='closed'){
        for(const feature of ['protection-overlay-v1','protection-input-scope-v1'])requiredFeatures.add(feature);await authenticate();
        checkOwner(current);
        if(!['protection-overlay-v1','protection-input-scope-v1'].every(feature=>features.includes(feature)))throw Object.assign(Error('更新本机助手后即可保留侧栏开启保护。'),{code:'companion_upgrade',action:'launch'});
      }
      const value=await command('/guard',{enabled,seconds,...metrics()},false,2500,undefined,current);
      if(typeof value?.protected!=='boolean')throw Object.assign(Error('连接不兼容'),{code:'invalid_ack'});
      publish(value);return {...state};
    },
    async fullscreen(enabled,{signal,isCurrent=()=>true}={}){const current=commandOwner({signal,isCurrent}),revision=++fullscreenRevision;await command('/fullscreen',{enabled,fullscreenRevision:revision},false,2500,signal,current);checkOwner(current,signal);markTitle();return command('/pulse',metrics(),true,2500,signal,current)},
    releaseNativeFullscreen(){const revision=++fullscreenRevision;if(!features.includes('fullscreen-intent-v1'))return Promise.resolve();return command('/fullscreen/release',{fullscreenRevision:revision},false);},
    async sidebar(enabled,chatMarker='',panelWidth=280,{signal,isCurrent}={}){const current=commandOwner({signal,isCurrent});if(enabled)await requireChatSupport();checkOwner(current,signal);return command('/sidebar',{enabled,chatMarker,panelWidth,...metrics()},true,2500,signal,current)},
    async workspace(mode,{revision,panelWidth=420,headerHeight=44,signal,isCurrent}={}){const current=commandOwner({signal,isCurrent});await requireWorkspaceSupport();checkOwner(current,signal);if(mode==='chat')await requireChatSupport();checkOwner(current,signal);return command('/workspace',{mode,revision,panelWidth,...metrics(),headerHeight},true,2500,signal,current)},
    async resizeSidebar(panelWidth,workspaceRevision=state.workspaceRevision,{signal,isCurrent}={}){const current=commandOwner({signal,isCurrent});await requireChatSupport();checkOwner(current,signal);return command('/sidebar/resize',{panelWidth,...metrics(),...(workspaceRevision?{workspaceRevision}:{})},true,2500,signal,current)},
    async presentChat(workspaceRevision=state.workspaceRevision,{signal,isCurrent}={}){const current=commandOwner({signal,isCurrent});await requireChatSupport();checkOwner(current,signal);return command('/sidebar/commit',{...metrics(),...(workspaceRevision?{workspaceRevision}:{})},true,2500,signal,current)},
    async capture(rect,{signal,paint}={}){
      const current=commandOwner({signal});checkOwner(current,signal);
      if(!session)await connect();
      checkOwner(current,signal);
      requiredFeatures.add('capture-viewport-v1');await authenticate();
      checkOwner(current,signal);
      if(!features.includes('capture-viewport-v1'))throw Object.assign(Error('截图需要更新'),{code:'companion_upgrade',action:'launch'});
      if(paint){requiredFeatures.add('capture-paint-v1');if(!features.includes('capture-paint-v1'))throw Object.assign(Error('背景截图需要更新'),{code:'companion_upgrade',action:'launch'});}
      const captured=metrics();
      if(!sameCaptureMetrics(captured,captured))throw Error('课程视区尚未就绪，请重新截图。');
      const result=await command('/capture',{...rect,...captured,...paint?{paint}:{}},false,30000,signal,current);
      if(!sameCaptureMetrics(captured,metrics()))throw Error('画面位置已变化，请重新框选。');
      return validateNativeCapture(result,rect,captured,paint);
    },
    async captureDraft(batch,delivery,{signal,isCurrent,onPost}={}){
      const current=commandOwner({signal,isCurrent}),workspaceRevision=state.workspaceRevision;
      if(!session)await connect();await requireDraftSupport();
      checkOwner(current,signal);
      if(batch.storedCapture){requiredFeatures.add('capture-assets-v1');if(!features.includes('capture-assets-v1'))throw Object.assign(Error('继续附图需要更新连接组件。'),{code:'companion_upgrade',action:'launch'});return command('/capture/saved',{id:batch.id,delivery,workspaceRevision},false,15000,signal,current,true,onPost);}
      return command('/capture/draft',{batch,delivery,workspaceRevision},false,15000,signal,current,true,onPost);
    },
    async captureDraftStatus(attemptId){if(!auth)await authenticate();return call('/capture/draft/status',{attemptId},false)},
    async settleCapture(delivery,receipt){
      if(!auth)await authenticate();
      const payload={id:delivery.materialId,operationId:delivery.operationId,...receipt?{attemptId:delivery.attemptId,target:delivery.target,receipt}:{}};
      return call('/library/'+(receipt?'capture-ack':'capture-reconcile'),payload,false,15000);
    },
    async settlePlan(id,scope,operationId,{dismiss=false}={}){if(!auth)await authenticate();return call('/library/plan-job-'+(dismiss?'dismiss':'retire'),{id,scope,operationId},false,15000)},
    async focusChat(direction,workspaceRevision,{signal}={}){
      const current=commandOwner({signal});
      if(!['forward','backward'].includes(direction)||!Number.isSafeInteger(workspaceRevision)||workspaceRevision<1)throw Error('提问焦点请求无效。');
      if(signal?.aborted)throw signal.reason||new DOMException('Cancelled','AbortError');
      requiredFeatures.add('chat-keyboard-focus');
      await requireChatSupport();
      checkOwner(current,signal);
      if(!features.includes('chat-keyboard-focus')){publish({requiresUpdate:true});throw Object.assign(Error('键盘提问需要更新'),{code:'companion_upgrade',action:'launch'})}
      return command('/chat/focus',{direction,workspaceRevision},true,800,signal,current);
    },
    async library(action,data={}){
      await requireLibrarySupport();if(['save','capture-list','capture','capture-ack'].includes(action))await requirePersistentCaptureSupport();const timeoutMs=action==='compose'||action==='backup'?60000:15000;
      const needed=['study-library','library-course-scope-v1',...(['save','capture-list','capture','capture-ack','capture-checkpoint'].includes(action)?['persistent-capture-outbox']:[]),...(action==='capture-checkpoint'?['capture-target-v1']:[]),...(action.startsWith('plan')?['persistent-plan-outbox']:[]),...(['selection','selection-save'].includes(action)?['library-selections-v1']:[]),...(action==='save'&&data.batch?.contextComplete===false?['capture-context-v1']:[])];
      if(action==='capture-dismiss')needed.push('capture-retire-v1');
      if(action==='capture-reconcile')needed.push('capture-reconcile-v1');
      if(action==='compose'&&data.questions?.some(question=>question.retainSupplementaryText===true))needed.push('library-question-supplement-v1');
      if(action.startsWith('plan')){requiredFeatures.add('persistent-plan-outbox');if(!features.includes('persistent-plan-outbox')){publish({requiresUpdate:true});throw Object.assign(Error('继续整理材料需要更新连接组件。'),{code:'companion_upgrade',action:'launch'});}}
      if(action==='selection'||action==='selection-save'){requiredFeatures.add('library-selections-v1');if(!features.includes('library-selections-v1')){publish({requiresUpdate:true});throw Object.assign(Error('保留未完成的勾选需要更新连接组件。'),{code:'companion_upgrade',action:'launch'});}}
      if(action==='save'&&data.batch?.contextComplete===false){requiredFeatures.add('capture-context-v1');if(!features.includes('capture-context-v1')){publish({requiresUpdate:true});throw Object.assign(Error('保存截图需要更新，已取得的图片仍保留在当前页面。'),{code:'companion_upgrade',action:'launch'});}}
      const keepalive=action==='selection-save'&&new TextEncoder().encode(JSON.stringify(data)).length<60000;
      const send=async()=>{await requireFeatures(needed);let payload=data;if(action==='save'){
        const items=[...data.batch.context,data.batch.selection],imageBytes=items.reduce((sum,item)=>sum+(item?.image?.length||0),0),metadataBytes=new TextEncoder().encode(JSON.stringify(data,(key,value)=>key==='image'||key==='thumbnail'?'':value)).length;
        const large=items.some(item=>(item?.image?.length||0)>12*1024*1024||!item?.image&&item?.asset)||imageBytes+metadataBytes>60*1024*1024;
        if(large){await requireFeatures(['capture-assets-v1'],'保存完整原图需要更新连接组件。');payload=await assetCaptureRequest(data);}
      }return call('/library/'+action,payload,keepalive,timeoutMs);};
      try{return await send()}catch(error){if(error.status!==403)throw error;auth='';await authenticate();await requireLibrarySupport();return send()}
    },
    async capturePlan(plan,delivery,{signal,isCurrent,onPost}={}){const current=commandOwner({signal,isCurrent}),workspaceRevision=state.workspaceRevision;await requireDraftSupport();checkOwner(current,signal);return command('/capture/plan',{plan,delivery,workspaceRevision},false,15000,signal,current,true,onPost)},
    navigateChat:(target,{signal,isCurrent}={})=>command('/chat/navigate',{target,workspaceRevision:state.workspaceRevision},false,15000,signal,isCurrent),
    async restoreDraft(id,target,{signal,isCurrent}={}){const current=commandOwner({signal,isCurrent}),workspaceRevision=state.workspaceRevision;await requireDraftSupport();checkOwner(current,signal);requiredFeatures.add('draft-reopen-v1');if(!features.includes('draft-reopen-v1')){publish({requiresUpdate:true});throw Object.assign(Error('继续草稿需要更新连接组件。'),{code:'companion_upgrade',action:'launch'})}return command('/chat/restore-draft',{id,target,workspaceRevision},false,95000,signal,current)},
    async startAudio(signal){await authenticate();if(signal?.aborted)throw signal.reason;if(disposed)throw Error('观看器已关闭');try{return await call('/audio/start',{},false,2500,signal)}catch(error){if(error.status!==403)throw error;auth='';await authenticate();return call('/audio/start',{},false,2500,signal)}},
    async shutdown(){await call('/shutdown',{},false,20000);lost('沉浸助手已关闭。')},
    snapshot:()=>({...state}),
    dispose(){if(disposed)return;disposed=true;epoch++;clearTimeout(timer);clearTimeout(reconnectTimer);if(session)call('/disconnect',{},true).catch(()=>{});restoreTitle();session='';state={...state,connected:false,protected:false,chatOpen:false,sidebarWidth:0}}
  };
}
