import {FULL,clamp,placement,imagePlacement,sourcePoint,between,pan,zoom} from './geometry.js';
import {restoredView,resetForMedia,sameMediaResource} from './view-state.js';
import {MAX_BOARDS,lessonLayoutKey,cleanLayout,layoutMatches,layoutRepository} from './layouts.js';
import {controlsLocked,pointerIntent,editableTarget,viewerShortcutAllowed} from './controls.js';
import {createViewerAudio} from './audio-manager.js';
import {createInputGuard,studyViewport,protectionEntryEvent} from './input-guard.js';
import {createStudyCompanion} from './companion.js';
import {copyBoard,selectionRectangle,captureRegion,captureFrame,imageFrame,cropFrame,frameBundle,createCaptureClock} from './capture.js';
import {captureCourseInfo} from './capture-course.js';
import {mountStudyLibrary} from './study-library-ui.js';
import {resolveLibraryRestore} from './library-restore.js';
import {captureOutbox} from './capture-outbox.js';
import {readSourceFrame,sourceFrameIdentity} from './source-frame.js';
import {captureTarget,captureDelivery,captureReceipt} from './capture-delivery.js';
import {DEFAULT_SIDEBAR_RATIO,sidebarSize,sidebarLimits,viewerPreferences,createSidebarResizer} from './sidebar-layout.js';
import {ensureClarityService} from './voice-startup.js';
import {startImmersiveSession,createCompanionStartup} from './immersive-session.js';
import {createViewerFullscreen} from './fullscreen.js';
import {WORKSPACE_CSS} from './workspace-style.js';
import {PLAYER_CSS} from './player-style.js';
import {createIntentScopes} from './intent-scopes.js';
import {createStudyInteraction,createProtectionReconciler} from './study-interaction.js';
import {createProtectionDoor,createProtectionKeyboardDoor} from './protection-door.js';
import {toolbarIcon,boardMap} from './toolbar-icons.js';
import {studyLessonScope} from './study-context.js';
import {mountMomentShelf} from './moment-shelf.js';

export function mountViewer(p) {
  const {video,host,css,background,chain,token,oldPage,oldChain,oldVideoMark,originalControls,oldProperties,hadStyle,KEY,VERSION,BUILD,previous,visible,activateFocus}=p;
  const shadow=host.attachShadow({mode:'open'});
  shadow.innerHTML=`<style>
  ${PLAYER_CSS}
  ${WORKSPACE_CSS}
  </style>
  <div id="surface" role="region" aria-label="课程聚焦区域。Tab显示操作，F临时全景，S框选截图，数字键切板位" tabindex="0"></div>
  <div id="regions" hidden></div><div id="selection"></div><div id="hint" class="quiet" role="status"></div><aside id="chat-space" hidden aria-label="学习工作区">
    <header id="workspace-header"><nav aria-label="学习工作区"><button id="chat-workspace" aria-label="提问">${toolbarIcon('chat')}</button><button id="materials-workspace" aria-label="课堂片段">${toolbarIcon('library')}</button></nav><div class="workspace-actions"><button id="chat-close" aria-label="收起学习工作区">${toolbarIcon('close')}</button></div></header>
    <div id="workspace-tools" hidden></div>
    <div id="chat-resize" role="separator" aria-label="调节学习工作区宽度" aria-orientation="vertical" tabindex="0"><span id="chat-ratio"></span></div>
    <div id="workspace-status" hidden role="status"><p id="workspace-message"></p><button id="workspace-retry">重试</button><a id="workspace-launch" href="zhiyun-focus://start" hidden>连接</a></div>
    <section id="library-panel" aria-label="课堂标记与提问" hidden></section>
    <span id="chat-focus" tabindex="0" role="group" aria-label="ChatGPT 提问区域" hidden></span>
  </aside>
  <div id="viewer-menu" hidden role="dialog" aria-label="板位操作"><p id="menu-status" class="status" hidden role="status"></p>
    <section id="watch-panel" class="panel" aria-label="观看操作" hidden>
      <div id="board-grid"><button id="overview" class="board-card"><span class="board-mini">${boardMap()}</span><span>全景</span></button><div id="quick-boards"></div></div><button id="boards-toggle" class="board-edit-action" aria-expanded="false">${toolbarIcon('edit')}<span id="board-edit-label">编辑板位</span></button>
    </section>
    <section id="boards-panel" class="panel" aria-label="板位布局" hidden>
      <button id="watch-workspace" class="text-action">‹ 板位列表</button>
      <details id="board-chooser"><summary id="board-choice">选择板位</summary><div id="board-list" class="boards"></div></details>
      <div class="row"><input id="board-name" type="text" maxlength="24" aria-label="板位名称"><button id="redraw">重圈范围</button></div>
      <div class="board-management"><button id="add">新增</button><button id="last">上个视角</button><button id="remove">删除此板位</button></div>
      <details id="board-reset"><summary>重置…</summary><div class="reset-actions"><button id="clear-course">本节板位</button><button id="clear-all">全部板位</button></div></details>
      <p id="save-status" class="help"></p>

    </section>
    <section id="settings-panel" class="panel" aria-label="更多操作" hidden>
      <div class="watch-actions utility-actions"><button id="shot-last" hidden>上次截图</button></div>
      <div class="setting-group"><div class="row setting"><button id="audio" role="switch" aria-checked="true" aria-label="清晰人声">清晰人声</button></div>
      <p id="audio-status" class="status" role="status"></p><a id="audio-launch" class="button" href="zhiyun-focus://audio" hidden>启用清晰人声</a><button id="audio-retry" hidden>重试</button>
      </div>
      <div class="setting-group">
      <div class="row setting"><span aria-hidden="true">${toolbarIcon('rewind')}</span><div id="back-seconds" class="choice-row" role="group" aria-label="回听秒数">${[5,8,10].map(seconds=>`<button data-back-seconds="${seconds}" aria-pressed="false">${seconds}秒</button>`).join('')}</div></div>
      </div>
    </section>
    <section id="edit-panel" class="panel" aria-label="圈选板位" hidden><button id="cancel-edit">取消圈选</button></section>
</div>
  <section id="shot-panel" aria-label="板书截图" hidden><div class="panel-head"><h2>板书截图 <span id="shot-time"></span></h2><button id="done-shot" aria-label="返回资料">返回资料</button></div><p id="shot-source" hidden></p><img id="shot-image" alt="板书原图，可拖动框选公式" draggable="false"><div class="row"><button id="shot-crop" hidden>保存选区</button><button id="shot-copy">复制</button><a id="shot-save" class="button" download="板书.png">下载</a><button id="shot-ask" class="primary">用这张图提问</button><button id="shot-retry" hidden>重试</button><button id="shot-keep" hidden aria-label="将截图留在学习记录中，不再重试原附图任务">保留原图</button><a id="shot-launch" class="button" href="zhiyun-focus://start" hidden>重试保存</a></div><p id="shot-status" class="status" role="status"></p></section><div id="image-selection" hidden></div>
  <div id="protection-strip" hidden><button id="protection-door" aria-label="退出写字保护。鼠标点击；键盘长按Esc后松开"><span id="protection-door-label">退出保护</span><span aria-hidden="true">→</span></button><span id="protection-info" hidden><span id="protection-status" role="status"></span></span><button id="protection-retry" hidden>重试开启</button></div>
  <div id="capture-layer" hidden aria-label="拖动框选截图区域"><div id="capture-rect" hidden></div></div><div id="capture-tools" hidden><button id="capture-cancel" aria-label="取消框选">取消</button></div><div id="capture-paint" aria-hidden="true" hidden></div>
  <div id="dock"><div id="moment-shelf" hidden></div>
    <div id="shot-toast" hidden role="status"><span id="shot-toast-message"></span><button id="shot-preview">查看</button></div>
    <div id="bar" role="toolbar" aria-label="观看操作">
      <input id="seek" type="range" min="0" step=".1" aria-label="课程进度">
      <div class="actions" id="playback-actions"><button id="play" class="icon-button" aria-label="播放或暂停">${toolbarIcon('play')}${toolbarIcon('pause')}</button><button id="rewind" class="icon-button" aria-label="回听8秒">${toolbarIcon('rewind')}<span id="rewind-seconds" class="icon-number" aria-hidden="true">8</span></button><button id="return-time" class="icon-button" aria-label="回到刚才" hidden>${toolbarIcon('return')}</button><span id="time"></span><button id="rate" aria-label="播放速度" aria-expanded="false" aria-controls="rate-menu">1×</button></div>
      <div class="actions" id="study-actions"><button id="mark" class="icon-button" aria-label="标记此刻">${toolbarIcon('mark')}${toolbarIcon('check')}</button><button id="capture" class="icon-button" aria-label="框选截图并提问" aria-keyshortcuts="S">${toolbarIcon('capture')}</button><button id="chat-toggle" class="icon-button" aria-label="提问" aria-expanded="false">${toolbarIcon('chat')}</button></div><div class="actions" id="player-options"><button id="library" class="icon-button" aria-label="课堂片段" aria-expanded="false">${toolbarIcon('library')}</button><button id="view-toggle" class="icon-button" aria-expanded="false" aria-label="选择板位">${toolbarIcon('boards')}</button><button id="guard-toggle" class="icon-button" aria-label="写字保护" aria-pressed="false">${toolbarIcon('guard')}</button><button id="settings-toggle" class="icon-button" aria-label="设置" aria-expanded="false">${toolbarIcon('settings')}</button><button id="fullscreen" class="icon-button" aria-label="全屏">${toolbarIcon('fullscreen')}${toolbarIcon('fullscreenExit')}</button></div><button id="reconnect" hidden>重新连接视频</button>
    </div>
  </div><div id="rate-menu" hidden role="group" aria-label="播放速度">${[.75,1,1.25,1.5,2].map(rate=>`<button data-rate="${rate}" aria-pressed="false">${rate}×</button>`).join('')}</div>`;
  const $=id=>shadow.getElementById(id),surface=$('surface'),dock=$('dock'),bar=$('bar'),selection=$('selection'),hint=$('hint');
  $('chat-space').append($('shot-panel'),$('chat-focus'));
  for(const [id,icon,label]of [['shot-copy','copy','复制图片'],['shot-save','download','下载图片'],['shot-crop','capture','保存圈选'],['shot-last','library','最近的课堂片段'],['capture-cancel','close','取消圈选'],['audio','sound','清晰人声'],['protection-door','guard','退出写字保护'],['watch-workspace','back','返回板位'],['redraw','capture','重圈范围'],['add','mark','新增板位'],['last','undo','上个视角'],['remove','trash','删除此板位'],['cancel-edit','close','取消圈选']]){
    $(id).innerHTML=toolbarIcon(icon)+(id==='protection-door'?toolbarIcon('forward'):'');$(id).setAttribute('aria-label',label);$(id).classList.add('icon-button');
  }

  const controller=new AbortController(),signal=controller.signal,on=(e,n,f,o={})=>e.addEventListener(n,f,{...o,signal});
  const role='video-'+[...document.querySelectorAll('video')].indexOf(video),identity=()=>lessonLayoutKey(location.href,role);
  const memory=window.__ZJF_LAYOUT_SESSION_V1__ instanceof Map?window.__ZJF_LAYOUT_SESSION_V1__:(window.__ZJF_LAYOUT_SESSION_V1__=new Map());
  const repo=layoutRepository(()=>window.localStorage,memory);
  let key=identity(),dimensions=[video.videoWidth,video.videoHeight],sourceKey=video.currentSrc,courseContext=captureCourseInfo();
  let mediaProof=null;
  function identifyMedia(source){
    if(mediaProof?.source===source)return mediaProof.promise;
    const proof={source,identity:'',promise:null};mediaProof=proof;
    proof.promise=sourceFrameIdentity(source).then(value=>{proof.identity=value;return value;});proof.promise.catch(()=>{});return proof.promise;
  }
  const initialMediaSource=sourceKey,initialMediaProof=identifyMedia(sourceKey);
  const sameLesson=(!previous?.key||studyLessonScope(previous.key)===studyLessonScope(key))&&!previous?.reviewPending;
  const sameRole=!previous?.key||previous.key===key;
  const migrated=sameLesson&&(sameRole||previous?.layout?.mediaIdentity)?cleanLayout(previous?.layout):null,stored=repo.read(key),compatible=stored&&layoutMatches(stored,dimensions,video.duration);
  const legacy=sameLesson&&sameRole?restoredView(previous,dimensions):null,seed=migrated&&layoutMatches(migrated,dimensions,video.duration)?migrated:compatible?stored:null;
  const cloneBoard=board=>({...board,roi:{...board.roi},...(board.view?{view:{...board.view}}:{})});
  const boardSignature=items=>JSON.stringify(items.map(({id,name,roi})=>({id,name,roi})));
  let boards=seed?seed.boards.map(cloneBoard):legacy?[{id:'b1',name:'板位1',roi:{...legacy.roi}}]:[];
  const boardView=board=>board?.view||board?.roi||FULL;
  let active=seed?.active||boards[0]?.id||null,roi={...boardView(boards.find(b=>b.id===active))};
  let mode='overview',editing=null,editOrigin=null,reviewPending=!!boards.length||!!stored&&!compatible&&!migrated&&!legacy;
  let menu=null,menuTrigger=null,menuDismissTimer=0,controlsRevealTimer=0,markFlashTimer=0,peek=null,returnView=null,lastView=null,replayReturn=null,drag=null,layout=null;
  let closed=false,disconnected=false,reconnecting=false,hover=false,scrubbing=false,keyboardMode=false,suppressHover=false,controlsVisible=true,protectionMouseUntil=0;
  let hideTimer=0,cursorTimer=0,hintTimer=0,saveTimer=0,visibilityTimer=0,frameRequest=0;
  let shotTimer=0,shotNoticeAction='shot',shotNoticeMarkId='',shotNoticeQuestionId='',shotReturnPage='library';
  let sidebarWidth=0,pendingSidebarWidth=0,shotImage='',matteKey='';
  let companionState={connected:false,protected:false,chatOpen:false,chatAttached:false};
  let wantClarity=true;
  let preferences=viewerPreferences(null),sidebarDrag=null,captureSelecting=false,captureWorking=false,captureDrag=null,captureView=null,captureEpoch=0;
  let transferBusy=false,queuedTransfer=null;
  let headerLayoutSync=null;
  let captureTransaction=null,captureSourceTask=null,captureOverlayHidden=false,capturePaintActive=false;
  const captureClock=createCaptureClock(video);
  const outbox=captureOutbox(window),captureQueue=outbox.deliveries;
  let retryingSaves=false,restoreEpoch=0,restoreTimer=0,recoveryError=null,localRecoveryError=null,mediaPositionEpoch=0;
  let currentMark=null,currentMarkTask=null,currentMarkBoards='',captureDestination='later',shotBatch=null,shotLayout=null,shotSourcePage='',imageDrag=null,imageCrop=null,imageCropView=null,imageCropData='',imageCropId=null,savingImageCrop=null,shotPreviewEpoch=0,captureRecoveryJob=null,askingShot=null,shotPlanAction=null;
  const shotReferenceKey=()=>shotBatch?.selection?.ref?JSON.stringify([shotBatch.selection.ref.markId||'',shotBatch.selection.ref.snapshotId,shotBatch.selection.ref.itemId]):'';
  const pendingShotPlan=()=>shotPlanAction&&shotPlanAction.reference===shotReferenceKey()&&!imageCrop&&(!companionState.chatDraftTarget?.draftId||shotPlanAction.target?.draftId===companionState.chatDraftTarget.draftId)?shotPlanAction:null;
  const captureLesson=()=>studyLessonScope(key)||(captureCourseInfo().course+':'+role);
  const recoveryCapture=()=>captureRecoveryJob?.preview===shotPreviewEpoch&&(!captureRecoveryJob.cropId||captureRecoveryJob.cropId===imageCropId)&&outbox.pending.includes(captureRecoveryJob.job)?captureRecoveryJob.job:null;
  const pendingCaptures=()=>outbox.pending.filter(job=>studyLessonScope(job.request.batch.lessonKey)===captureLesson()||job.request.batch.id===shotBatch?.id||job===recoveryCapture());
  const queuedCaptures=()=>captureQueue.filter(job=>studyLessonScope(job.lessonKey||job.batch?.lessonKey)===captureLesson());
  let localCaptureReady=Promise.resolve();
  const intents=createIntentScopes(),initialProtection=intents.observe('protection'),initialWorkspace=intents.observe('workspace'),initialView=intents.observe('view');
  let workspacePage='closed',workspaceRevision=0,workspaceOwner=intents.observe('workspace'),workspacePending=null,workspaceError=null,workspaceSupported=null,closingReservation=0;
  let captureTask=null,captureReady=false,foreground=document.hasFocus?.()??true,composing=false,boardNameComposing=false;
  let interactionRequest=null,interactionSession=null,protectionPromise=Promise.resolve(),protectionRequested=null,protectionFailure=null,protectionOperation=0,protectionConnecting=false;
  let chatFocusSequence=null,chatFocusSession=null,chatFocusBackward=false,nativeFocusOwner=null,pendingNativeFocusReturn=null,lastParentInputAt=0;
  const expectedPlayback=new Map(),expectedSeeks=[];
  // Capturing never changes the active workspace. Sending is a separate intent.
  const auxiliaryInput=event=>sideWorkspace(workspacePage)&&event.composedPath?.().includes($('chat-space'));
  const guard=createInputGuard({allowProtectedPointer:event=>auxiliaryInput(event)||protectionEntryEvent(event,$('protection-door'))||protectionEntryHit(event),
    allowProtectedKeyboard:event=>{
      if(auxiliaryInput(event))return true;
      if(event.key==='Tab'&&!event.ctrlKey&&!event.altKey&&!event.metaKey&&sideWorkspace(workspacePage)){
        if(event.type==='keydown'){event.preventDefault();(workspacePage==='chat'?$('chat-focus'):$('materials-workspace')).focus({preventScroll:true});}
        return true;
      }
      return false;
    },
    blocked:event=>{protectionDoor?.observePointer(event);keyboardDoor?.handle(event)}});
  let protectionDoor=null,keyboardDoor=null;
  const study=createStudyInteraction({intents,changed:state=>{
    if(closed)return;guard.set(state.protectionActive&&state.protectionTarget);refreshStudy();requestRender();queueProtection(state.protectionTarget);
  }});
  const companion=createStudyCompanion({mediaIdentity:()=>video.currentSrc,geometry:viewerGeometry,changed:state=>{
    if(closed)return;
    const wasConnected=companionState.connected,wasProtected=companionState.protected;
    companionState=state;protectionWriter.observe(state.protected);
    fullscreen.observeNative(state);
    if(typeof state.foreground==='boolean')foreground=!document.hidden&&state.foreground;
    if(workspacePage==='closed'&&state.workspaceMode==='closed'&&state.workspaceRevision===workspaceRevision){if(closingReservation)beginLayoutMotion();closingReservation=0;sidebarWidth=0;pendingSidebarWidth=0}
    if(protectionFailure&&state.protected===protectionRequested){protectionFailure=null;protectionPromise=Promise.resolve({active:state.protected})}
    study.setContext({connected:state.connected,visible:!document.hidden,foreground,mediaId:key+'|'+sourceKey,
      canProtect:protectionAllowed()});
    study.observeProtection(state.protected);
    if(wasProtected&&!state.protected&&state.protectionRequested===false&&protectionRequested===true&&!protectionWriter.inspect().busy){intents.invalidate('protection');study.setProtectionWanted(false)}
    if(state.workspaceRevision===workspaceRevision&&sideWorkspace(workspacePage)&&state.sidebarWidth>0&&!pendingSidebarWidth)sidebarWidth=state.sidebarWidth;
    if(!state.connected){interactionSession=null;interactionRequest=null;chatFocusSession=null;chatFocusSequence=null;nativeFocusOwner=null;pendingNativeFocusReturn=null}
    else if(Number.isSafeInteger(state.interactionRequested)){
      if(!wasConnected||interactionSession!==state.session||interactionRequest===null){interactionSession=state.session;interactionRequest=state.interactionRequested}
      else if(state.interactionRequested>interactionRequest){interactionRequest=state.interactionRequested;if(study.snapshot().protectionWanted||state.protected)exitProtection()}
    }
    if(state.connected&&Number.isSafeInteger(state.chatFocusRequested)){
      if(!wasConnected||chatFocusSession!==state.session||chatFocusSequence===null){chatFocusSession=state.session;chatFocusSequence=state.chatFocusRequested;pendingNativeFocusReturn=null;}
      else if(state.chatFocusRequested>chatFocusSequence){chatFocusSequence=state.chatFocusRequested;returnNativeFocus(state);}
    }
    if(!wasConnected&&state.connected&&wantClarity&&audio.inspect().mode==='original')audio.start('clarity');
    refreshStudy();render();libraryUI.refreshContext();
  }});
  const protectionWriter=createProtectionReconciler({changed:()=>{if(!closed)refreshStudy()},write:async enabled=>{
    if(!companion.snapshot().connected){if(!enabled)return {protected:false};await companion.connect()}
    return companion.guard(enabled);
  }});
  const helperStartup=createCompanionStartup({companion,signal});
  const audio=createViewerAudio(video,(value,message,detail={})=>{
    if(closed)return;$('audio').setAttribute('aria-checked',String(wantClarity));$('audio').setAttribute('aria-label',wantClarity?'关闭清晰人声':'开启清晰人声');$('audio-status').textContent=message?(value==='original'&&wantClarity&&!message.includes('原声')?'原声 · '+message:message):value==='clarity'&&detail.phase!=='ready'?'人声准备中…':'';
    $('audio').dataset.route=detail.actualRoute||'original';$('audio').dataset.phase=detail.phase||'ready';
    $('audio').setAttribute('aria-description',detail.actualRoute==='clarity'?'当前播放清晰人声':'当前保留原声');
    $('audio').setAttribute('aria-busy',String(wantClarity&&['preparing','loading','waiting'].includes(detail.phase)));
    $('audio-launch').hidden=detail.action!=='launch';$('audio-retry').hidden=detail.action!=='retry';
  },{prepareClarity:signal=>ensureClarityService(async launchSignal=>{await helperStartup.ensure({launchIfNeeded:true,signal:launchSignal});return companion.startAudio(launchSignal)},{signal,startTimeoutMs:18000,progress:message=>{if(!closed)$('audio-status').textContent=message}})});
  let resizingOwner=null,resizingRevision=0;
  const sidebarResizer=createSidebarResizer({resize:async width=>{
      const owner=resizingOwner,revision=resizingRevision;if(!owner?.isCurrent())return;
      const state=await owner.after(companion.resizeSidebar(width,revision,{signal:owner.signal,isCurrent:owner.isCurrent}));if(owner.isCurrent()&&workspaceRevision===revision)sidebarWidth=state.sidebarWidth||width;
    },
    preview:width=>{pendingSidebarWidth=width;if(!closed){render();refreshStudy()}},
    settled:()=>{pendingSidebarWidth=0;if(!closed){render();refreshStudy()}},
    failed:error=>{if(!closed&&error.name!=='AbortError')tell(error.message)}});
  const fullscreen=createViewerFullscreen({inheritOwned:previous?.fullscreenOwned===true,inheritPending:previous?.fullscreenPending,nativeActive:()=>companionState.connected&&!!companionState.fullscreen,
    enterNative:async (isCurrent,signal)=>{if(!companion.snapshot().connected)throw Error('请按 F11 切换全屏。');if(isCurrent())return companion.fullscreen(true,{isCurrent,signal})},
    exitNative:(isCurrent,signal)=>companion.fullscreen(false,{isCurrent,signal}),releaseNative:()=>companion.releaseNativeFullscreen(),refreshNative:()=>companion.snapshot().connected?companion.refresh():null,changed:()=>{if(!closed){refreshStudy();requestRender()}}});
  const libraryUI=mountStudyLibrary({root:$('library-panel'),companion,selectionKey:studyLessonScope(key)||location.origin+location.pathname,currentContext:()=>{if(identity()===key)courseContext=captureCourseInfo();return {lessonKey:key,course:courseContext}},close:()=>closeWorkspace(),restore:restoreLibraryMark,send:sendLibraryPlan,resumeDraft:resumeLibraryDraft,crop:cropLibraryImage,capture:beginCapture,
    openDraft:async({requestOwner}={})=>{const opening=openChat({requestOwner}),owner=workspaceOwner;await owner.after(opening);return readyDraftTarget(owner)},
    getRestoreIntent:()=>({workspace:intents.observe('workspace'),view:intents.observe('view'),playback:intents.observe('playback')}),
    openConversation:async url=>{const opening=openChat(),owner=workspaceOwner;await owner.after(opening);await owner.after(companion.navigateChat(url,{signal:owner.signal,isCurrent:owner.isCurrent}))}});
  const doorEvidence=()=>[intents.observe('protection').revision,workspaceOwner.revision,key,sourceKey].join(':');
  const doorEnabled=()=>!closed&&host.dataset.narrowVideo!=='true'&&!localPanel(workspacePage)&&(study.snapshot().protectionWanted||study.snapshot().protectionActive)&&!document.hidden&&foreground;
  function protectionEntryHit(event){
    if(!doorEnabled())return false;
    if(protectionDoor?.holding&&event.type.startsWith('touch'))return true;
    if(event.type!=='pointerdown')return false;
    const r=$('protection-door').getBoundingClientRect();return r.width>0&&r.height>0&&event.clientX>=r.left&&event.clientX<=r.right&&event.clientY>=r.top&&event.clientY<=r.bottom;
  }
  protectionDoor=createProtectionDoor({element:$('protection-door'),eventTarget:window,enabled:doorEnabled,evidence:doorEvidence,
    activate:exitProtection,changed:state=>{
      $('protection-door').style.setProperty('--door-progress',String(state.progress||0));
      $('protection-strip').dataset.engaged=String(state.phase!=='idle');
      $('protection-door').dataset.phase=state.phase;
    }});
  keyboardDoor=createProtectionKeyboardDoor({target:window,enabled:doorEnabled,evidence:doorEvidence,activate:exitProtection});
  on(window,'pointermove',event=>{
    if(event.pointerType&&event.pointerType!=='mouse'||event.sourceCapabilities?.firesTouchEvents)return;
    const viewport=viewportArea(),strip=$('protection-strip'),r=strip.getBoundingClientRect(),inside=strip.dataset.revealed==='true'&&event.clientX>=r.left&&event.clientX<=r.right&&event.clientY>=r.top&&event.clientY<=r.bottom;
    strip.dataset.revealed=String(doorEnabled()&&(inside||event.clientX>=viewport.x+Math.max(0,viewport.width-200)&&event.clientX<=viewport.x+viewport.width&&event.clientY>=viewport.y&&event.clientY<=viewport.y+44));
  },{capture:true});
  function protectionKey(event){
    if(guard.active||!doorEnabled()||captureNeedsFrame()||composing||event.isComposing||event.keyCode===229)return false;
    keyboardDoor.handle(event);if(event.key!=='Escape')return false;event.preventDefault();event.stopImmediatePropagation();return true;
  }
  function queueProtection(target,attempt=0){
    const forceRelease=!target&&companionState.protectionRequested===true&&!protectionWriter.inspect().busy;
    if(closed||protectionRequested===target&&!forceRelease)return protectionPromise;
    const operation=++protectionOperation,owner=intents.observe('protection');protectionRequested=target;protectionFailure=null;
    const current=()=>!closed&&owner.isCurrent()&&operation===protectionOperation&&protectionRequested===target;
    protectionPromise=protectionWriter.request(target,{force:forceRelease}).then(result=>{if(current()){protectionFailure=null;refreshStudy()}return result}).catch(error=>{
      if(current()&&error.name!=='AbortError'){protectionFailure={error,target};refreshStudy();if(attempt<2)setTimeout(()=>{if(current()&&study.snapshot().protectionTarget===target){protectionRequested=null;void queueProtection(target,attempt+1).catch(()=>{});}},600*2**attempt);}
      throw error;
    });
    // A state reconciliation can be initiated by an observer rather than a
    // button. Callers may await this same promise; its failure is still shown.
    protectionPromise.catch(()=>{});return protectionPromise;
  }
  function visualArea(){
    const v=window.visualViewport;return {offsetLeft:v?.offsetLeft||0,offsetTop:v?.offsetTop||0,width:v?.width||innerWidth,height:v?.height||innerHeight,scale:v?.scale||1};
  }
  function contentWorkspace(page){return page==='chat'||page==='library'}
  function sideWorkspace(page){return contentWorkspace(page)||page==='shot'}
  function localPanel(page){return ['watch','boards','settings'].includes(page)}
  function panelPage(){return localPanel(menu)?menu:workspacePage}
  function protectionAllowed(){return !localPanel(panelPage())&&$('rate-menu').hidden;}
  let layoutMotionTimer=0;
  function beginLayoutMotion(){
    if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;
    clearTimeout(layoutMotionTimer);video.setAttribute('data-zjf-moving','true');host.dataset.moving='true';
    layoutMotionTimer=setTimeout(()=>{video.removeAttribute('data-zjf-moving');delete host.dataset.moving;},340);
  }
  const momentShelf=mountMomentShelf({root:$('moment-shelf'),lessonKey:captureLesson(),copy:item=>copyBoard(companion.library('image',item.ref).then(value=>value.image)),changed:()=>{wake();requestRender();},
    preview:async item=>{
      const owner=workspaceOwner,preview=++shotPreviewEpoch;
      const saved=await owner.after(companion.library('capture',{id:item.id,lightweight:true}));
      const original=await owner.after(companion.library('image',item.ref));
      if(preview!==shotPreviewEpoch)return;
      showCapturePreview({...saved.batch,selection:{...saved.batch.selection,image:original.image}},saved);
      await changeWorkspace('shot',{requestOwner:owner});
    },
    ask:async(items,{isCurrent=()=>true,selectionCurrent=isCurrent}={})=>{
      const current=()=>{if(!isCurrent())throw new DOMException('Material selection changed','AbortError')};
      current();const opening=openChat(),owner=workspaceOwner;await owner.after(opening);current();
      const target=await readyDraftTarget(owner);current();const refs=items.map(item=>item.ref).filter(Boolean);
      if(refs.length!==items.length)return false;
      const plan=await owner.after(companion.library('compose',{refs,restoreRefs:refs.map((ref,index)=>({...ref,intentId:items[index].selectionId,intentAt:items[index].selectedAt})),questions:[],background:true,questionImages:false,title:'课堂片段'}));
      current();const receipt=await sendLibraryPlan(plan,'current',{target,requestOwner:owner,isCurrent,selectionCurrent,directSelection:{items:items.map(item=>({ref:item.ref,selectionId:item.selectionId,selectedAt:item.selectedAt}))}});
      return receipt?.durable===true&&receipt.completed===true&&['attached','already-sent','removed'].includes(receipt.outcome)||receipt?.verified===true&&['attached','already-sent','removed'].includes(receipt.state);
    }});
  function viewportArea(){
    const visual=visualArea(),strip=0;
    const reservedAside=sideWorkspace(workspacePage)?Math.max(pendingSidebarWidth,sidebarWidth)||sidebarSize(visual.width,preferences.sidebarRatio):closingReservation;
    const viewport=studyViewport(visual.width,Math.max(1,visual.height-strip),reservedAside);
    return {...viewport,x:visual.offsetLeft,y:visual.offsetTop,strip,visual};
  }
  function viewerGeometry(){
    const viewport=viewportArea(),r=$('protection-door').getBoundingClientRect(),door=doorEnabled()&&!closingReservation;
    return {aside:viewport.aside,mainRect:{x:viewport.x,y:viewport.y,w:viewport.width,h:viewport.height},visual:viewport.visual,revision:captureEpoch,headerHeight:workspaceHeaderHeight(),auxiliaryInput:document.hasFocus()&&sideWorkspace(workspacePage)&&$('chat-space').contains(shadow.activeElement),
      protectionDoor:door&&r.width>0&&r.height>0?{x:r.left??r.x,y:r.top??r.y,w:r.width,h:r.height}:null};
  }
  function workspaceHeaderHeight(){return 44+(!$('workspace-tools').hidden?$('workspace-tools').getBoundingClientRect().height:0)+(!$('workspace-status').hidden?$('workspace-status').getBoundingClientRect().height:0);}
  function automaticPause(){
    if(video.paused)return false;
    expectPlayback('pause');
    return audio.pause();
  }
  function expectPlayback(type){const record={owner:intents.observe('playback')},queue=expectedPlayback.get(type)||[];queue.push(record);expectedPlayback.set(type,queue);return record}
  function forgetPlayback(type,record){const queue=expectedPlayback.get(type)||[],index=queue.indexOf(record);if(index>=0)queue.splice(index,1);if(!queue.length)expectedPlayback.delete(type)}
  function automaticPlay(){
    if(closed||document.hidden||!foreground||!video.isConnected||video.error||!video.paused)return;
    const expected=expectPlayback('play');
    video.play().catch(()=>{forgetPlayback('play',expected);if(expected.owner.isCurrent()&&!closed)tell('点播放继续课程。')});
  }
  function notePlaybackIntent(){intents.invalidate('playback')}
  function noteViewIntent(){intents.invalidate('view');restoreEpoch++;clearTimeout(restoreTimer);selection.style.display='none'}
  function workspaceBusy(){return !!workspacePending&&workspacePending.owner===workspaceOwner}
  function noteFocusIntent(){lastParentInputAt=Date.now();intents.invalidate('chat-focus');nativeFocusOwner=null;pendingNativeFocusReturn=null;}
  function returnNativeFocus(state){
    if(workspacePage!=='chat'||state.session!==chatFocusSession||state.chatFocusRevision!==workspaceRevision||state.chatFocusAt<=lastParentInputAt||Date.now()-state.chatFocusAt>1500||document.hidden){pendingNativeFocusReturn=null;return;}
    pendingNativeFocusReturn=state;if(!document.hasFocus())return;
    pendingNativeFocusReturn=null;intents.invalidate('chat-focus');nativeFocusOwner=null;wake();
    const focusable=[...shadow.querySelectorAll('button,input,select,textarea,a[href],summary,[tabindex]')].filter(node=>node.tabIndex>=0&&!node.disabled&&node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden');
    const index=focusable.indexOf($('chat-focus')),target=index>=0?focusable[index+(state.chatFocusBackward?-1:1)]:null;
    (target||surface).focus({preventScroll:true});
  }
  on($('chat-focus'),'focus',()=>{
    if(nativeFocusOwner||workspacePage!=='chat'||!companionState.chatOpen||document.hidden||!document.hasFocus())return;
    const focusOwner=intents.begin('chat-focus'),owner=workspaceOwner,revision=workspaceRevision;nativeFocusOwner=focusOwner;
    void owner.after(focusOwner.after(companion.focusChat(chatFocusBackward?'backward':'forward',revision,{signal:AbortSignal.any([focusOwner.signal,owner.signal])}))).catch(error=>{
      if(!closed&&owner.isCurrent()&&focusOwner.isCurrent()&&error.name!=='AbortError'){nativeFocusOwner=null;$('chat-workspace').focus({preventScroll:true});tell(error.message);}
    });
  });
  function changeWorkspace(page,{force=false,requestOwner=null,cancelSelection=true,focusOnClose=true}={}){
    if(closed||requestOwner?.isCurrent()===false)return Promise.resolve(false);
    closeRateMenu();
    if(!['closed','chat','library','boards','settings','shot','watch'].includes(page))page='watch';
    // Player menus stay over the course while the conversation keeps its space.
    if(localPanel(page)&&sideWorkspace(workspacePage)){
      intents.invalidate('chat-focus');nativeFocusOwner=null;pendingNativeFocusReturn=null;
      if(cancelSelection&&(captureSelecting||captureWorking))cancelCapture();
      const changed=menu!==page;menu=page;refreshLists();render();if(changed)$('viewer-menu').scrollTop=0;wake();cursorWake();return Promise.resolve(true);
    }
    if(page===workspacePage&&!force){
      if(localPanel(menu)){menu=page;refreshLists();render();}
      const native=companion.snapshot();
      if(page!=='chat')return workspacePending?.promise||Promise.resolve(!workspaceError);
      if(workspacePending||native.connected&&!workspaceError&&(native.chatOpen||native.workspaceMode!=='chat'))return syncMenuWorkspace();
      // A selected tab is also a valid reconnect action after the helper exits.
    }
    if(page==='shot'&&workspacePage!=='shot')shotReturnPage=contentWorkspace(workspacePage)?workspacePage:'library';
    if(page==='closed'||page==='library'&&shotNoticeAction==='library'){$('shot-toast').hidden=true;clearTimeout(shotTimer);}
    beginLayoutMotion();
    finishPan();const oldAside=viewportArea().aside,nativePending=!!workspacePending&&sideWorkspace(workspacePending.page);
    if(page==='closed'||page==='library')outbox.releasePixels();
    study.setContext({canProtect:false});
    if(cancelSelection&&(captureSelecting||captureWorking))cancelCapture();
    if(workspacePage==='library'&&page!=='library')libraryUI.suspend();
    sidebarResizer.cancel();sidebarDrag=null;$('chat-resize').classList.remove('dragging');
    protectionDoor.cancel();keyboardDoor.cancel();
    intents.invalidate('chat-focus');nativeFocusOwner=null;pendingNativeFocusReturn=null;
    const owner=intents.begin('workspace');workspaceOwner=owner;workspacePage=page;menu=page==='closed'?null:page;closingReservation=sideWorkspace(page)?0:oldAside;
    imageDrag=null;imageCropView=null;$('image-selection').hidden=true;
    let revision=workspaceRevision=Math.max(workspaceRevision,Number(companion.snapshot().workspaceRevision)||0)+1;
    if(page==='chat')study.returnToStudy().restorePlayback(automaticPlay);
    if(page!=='closed')study.begin(page,{owner});workspaceError=null;
    const width=sideWorkspace(page)?sidebarSize(visualArea().width,preferences.sidebarRatio):0;
    pendingSidebarWidth=width;sidebarWidth=sideWorkspace(page)?sidebarWidth||width:0;
    if(page==='closed')study.returnToStudy().restorePlayback(automaticPlay);
    const operation={owner,page,revision,promise:null};workspacePending=operation;
    refreshLists();render();if(localPanel(page))$('viewer-menu').scrollTop=0;if(page==='closed'){if(focusOnClose)surface.focus({preventScroll:true});suppressHover=false;wake();cursorWake()}else{wake();cursorWake()}
    if(page==='library')void libraryUI.open().catch(error=>owner.commit(()=>{workspaceError=error;refreshStudy()}));
    operation.promise=(async()=>{
      try{
        const native=companion.snapshot();
        if(page!=='chat'&&(!native.connected||!sideWorkspace(page))&&!nativePending&&!native.chatOpen&&!native.chatOpening&&(!native.workspaceMode||native.workspaceMode==='closed')&&!study.snapshot().protectionActive&&!study.snapshot().protectionWanted){
          pendingSidebarWidth=0;sidebarWidth=width;closingReservation=0;
          study.setContext({canProtect:protectionAllowed()});
          owner.commit(()=>{workspaceError=null;refreshStudy();render()});return true;
        }
        for(let attempt=0;;attempt++){
          try{
            if(!companion.snapshot().connected){await owner.after(helperStartup.ensure({launchIfNeeded:true,signal:owner.signal}));await owner.after(companion.connect());}
            const nativeRevision=Number(companion.snapshot().workspaceRevision)||0;
            if(nativeRevision>=revision){revision=workspaceRevision=nativeRevision+1;operation.revision=revision;}
            await owner.after(queueProtection(study.snapshot().protectionTarget));
            let state=await owner.after(companion.workspace(sideWorkspace(page)?page==='chat'?'chat':'materials':'closed',{revision,panelWidth:width,headerHeight:viewerGeometry().headerHeight,signal:owner.signal,isCurrent:owner.isCurrent}));
            workspaceSupported=true;
            if(page==='chat')await presentWorkspaceChat(state,owner,revision);
            else{pendingSidebarWidth=0;sidebarWidth=sideWorkspace(page)?state.sidebarWidth||width:0;if(!sideWorkspace(page))closingReservation=0;}
            break;
          }catch(error){if(page!=='chat'||attempt>=2||['AbortError'].includes(error.name)||error.code==='companion_upgrade')throw error;await owner.after(new Promise(resolve=>setTimeout(resolve,600*2**attempt)));}
        }
        owner.commit(()=>{workspaceError=null;refreshStudy();render()});return true;
      }catch(error){
        if(owner.isCurrent()&&!closed&&error.name!=='AbortError'){
          if(error.code==='companion_upgrade')workspaceSupported=false;
          const native=companion.snapshot();
          if(!sideWorkspace(page)&&error.code==='companion_upgrade'&&!native.chatOpen&&!native.chatOpening&&(!native.workspaceMode||native.workspaceMode==='closed')){
            pendingSidebarWidth=0;sidebarWidth=0;closingReservation=0;workspaceError=null;study.setContext({canProtect:protectionAllowed()});render();return true;
          }
          workspaceError=error;pendingSidebarWidth=0;sidebarWidth=width;refreshStudy();render();
        }
        return false;
      }finally{if(workspacePending===operation){workspacePending=null;if(!closed)refreshStudy()}}
    })();return operation.promise;
  }
  function closeWorkspace(options){return changeWorkspace('closed',options)}
  async function presentWorkspaceChat(state,owner,revision){
    const deadline=Date.now()+12000;
    while(state.chatOpening){
      if(state.chatError&&(!state.chatLayoutPending||state.chatError!==state.chatLayoutError))throw Error(state.chatError);
      if(Date.now()>=deadline)throw Error(state.chatLayoutError||'提问区域准备超时，请重试。');
      await owner.after(new Promise(resolve=>setTimeout(resolve,150)));state=await owner.after(companion.refresh());
    }
    if(state.workspaceRevision!==revision||!state.chatOpen||!(state.sidebarWidth>0))throw Error(state.chatError||'提问区域未能展开，请重试。');
    pendingSidebarWidth=0;sidebarWidth=state.sidebarWidth;render();await owner.after(companion.presentChat(revision,{signal:owner.signal,isCurrent:owner.isCurrent}));
  }
  function syncMenuWorkspace(){
    if(closed||workspacePage!=='chat')return Promise.resolve(false);
    const owner=workspaceOwner;
    if(workspacePending)return workspacePending.promise.then(result=>result&&owner.isCurrent()?syncMenuWorkspace():false);
    if(!companion.snapshot().connected)return Promise.resolve(false);
    const native=companion.snapshot(),mode='chat';
    if(native.workspaceMode===mode&&(mode!=='chat'||native.chatOpen))return Promise.resolve(true);
    const revision=workspaceRevision=Math.max(workspaceRevision,Number(native.workspaceRevision)||0)+1,operation={owner,page:'chat',revision,menu:true,promise:null};workspacePending=operation;
    operation.promise=(async()=>{try{
      const state=await owner.after(companion.workspace(mode,{revision,panelWidth:sidebarSize(visualArea().width,preferences.sidebarRatio),headerHeight:workspaceHeaderHeight(),signal:owner.signal,isCurrent:owner.isCurrent}));
      if(mode==='chat')await presentWorkspaceChat(state,owner,revision);
      owner.commit(()=>{workspaceError=null;refreshStudy();render()});return true;
    }catch(error){if(owner.isCurrent()&&!closed&&error.name!=='AbortError'){workspaceError=error;refreshStudy()}return false;}
    finally{if(workspacePending===operation){workspacePending=null;refreshStudy()}}})();return operation.promise;
  }
  function closeMenu({returnFocus=true}={}){
    clearTimeout(menuDismissTimer);
    const focus=keyboardMode&&menuTrigger?.isConnected?menuTrigger:surface;
    if(sideWorkspace(workspacePage)&&localPanel(menu)){if(editing)cancelEdit({keepWorkspace:true});menu=workspacePage;refreshLists();render();const result=workspacePage==='chat'?syncMenuWorkspace():Promise.resolve(true);if(returnFocus)focus.focus({preventScroll:true});scheduleHide();return result;}
    const result=closeWorkspace({focusOnClose:returnFocus});if(returnFocus)focus.focus({preventScroll:true});return result;
  }
  function openChat(options={}){if(identity()!==key){tell('课程正在切换，画面就绪后再提问。');return Promise.resolve(false)}return changeWorkspace('chat',options)}
  const snapshot=()=>({mode,active,roi:{...roi}});
  const pack=()=>({schema:1,dimensions:[...dimensions],duration:video.duration,active,boards:boards.map(cloneBoard),updated:Date.now(),...(!reviewPending&&mediaProof?.source===sourceKey&&mediaProof.identity?{mediaIdentity:mediaProof.identity}:{})});
  const keyboardFocus=()=>keyboardMode&&dock.contains(shadow.activeElement);
  const locked=()=>controlsLocked({editing,menu:localPanel(menu)||!$('rate-menu').hidden,hover:hover&&!suppressHover,keyboardFocus:keyboardFocus(),scrubbing,dragging:!!drag,error:disconnected||!!video.error});
  function tell(message,sticky=false) {host.dataset.diagnostic=String(message||'');}

  function hideControls(force=false) {
    if(!closed&&host.dataset.narrowVideo==='true'){controlsVisible=true;dock.classList.remove('quiet');dock.inert=false;dock.removeAttribute('aria-hidden');return;}
    if(closed||(!force&&locked()))return;
    controlsVisible=false;dock.classList.add('quiet');dock.inert=true;dock.setAttribute('aria-hidden','true');
  }
  function scheduleHide() {clearTimeout(hideTimer);if(!locked())hideTimer=setTimeout(()=>hideControls(),1900)}
  function wake(focus=false,fromPointer=false) {
    if(closed||captureOverlayHidden||guard.active&&!fromPointer&&!hover&&!localPanel(menu))return;if(fromPointer)protectionMouseUntil=Date.now()+1900;controlsVisible=true;dock.inert=false;dock.removeAttribute('aria-hidden');dock.classList.remove('quiet');
    if(focus){keyboardMode=true;$('play').focus({preventScroll:true})}scheduleHide();
  }
  function revealFromPointer(event){
    const viewport=viewportArea(),bounds=dock.getBoundingClientRect(),inside=(pointerIntent(event.clientY,viewport.y+viewport.height,event.pointerType,event.buttons)||event.clientY>=bounds.top-16)&&event.clientX>=bounds.left-20&&event.clientX<=bounds.right+20;
    if(!inside){clearTimeout(controlsRevealTimer);controlsRevealTimer=0;return;}
    if(controlsVisible||event.pointerType==='touch'||event.buttons){suppressHover=false;wake(false,event.pointerType==='mouse'||!event.pointerType);return;}
    if(controlsRevealTimer)return;
    controlsRevealTimer=setTimeout(()=>{controlsRevealTimer=0;if(!closed&&!document.hidden&&foreground&&!drag&&!editing){suppressHover=false;wake(false,event.pointerType==='mouse'||!event.pointerType);}},180);
  }
  function cursorWake() {surface.classList.remove('idle');clearTimeout(cursorTimer);if(!editing&&!menu&&!drag)cursorTimer=setTimeout(()=>{if(!editing&&!menu&&!drag)surface.classList.add('idle')},2200)}
  function save() {
    clearTimeout(saveTimer);if(!boards.length||reviewPending)return;
    const ok=repo.write(key,pack());$('save-status').textContent=ok?'':'本次保留板位；当前无法写入持久存储。';
  }
  function updateCurrent() {const b=boards.find(b=>b.id===active);if(b)b.view={...roi};clearTimeout(saveTimer);saveTimer=setTimeout(save,350)}
  function finishPan({revert=false,event}={}){
    const previous=drag;if(!previous||event?.pointerId!==undefined&&previous.pointer!==event.pointerId)return false;
    drag=null;selection.style.display='none';
    if(revert&&!previous.editing&&previous.owner.isCurrent()&&previous.active===active&&previous.mode===mode&&previous.key===key&&previous.source===video.currentSrc){roi={...previous.original};updateCurrent();}
    if(surface.hasPointerCapture?.(previous.pointer))surface.releasePointerCapture(previous.pointer);
    return true;
  }
  function restoreView(v) {if(!v)return;finishPan();noteViewIntent();if(captureNeedsFrame())cancelCapture();mode=v.mode;active=v.active;roi={...v.roi};if(mode==='focus')updateCurrent();peek=null;editing=null;render();refreshLists()}
  function commitBoard(id) {
    beginLayoutMotion();
    const b=boards.find(x=>x.id===id);if(!b)return;
    finishPan();
    noteViewIntent();
    if(captureNeedsFrame())cancelCapture();
    lastView=peek?.origin||snapshot();active=id;roi={...boardView(b)};mode='focus';peek=null;editing=null;reviewPending=false;
    returnView=snapshot();render();refreshLists();save();wake();surface.focus({preventScroll:true});
    if(!disconnected&&!video.error){clearTimeout(hintTimer);hint.classList.add('quiet')}
  }
  function toggleOverview() {
    finishPan();
    beginLayoutMotion();
    noteViewIntent();
    if(captureNeedsFrame())cancelCapture();
    if(peek){endPeek();return;}
    if(mode==='overview'&&returnView){reviewPending=false;restoreView(returnView);save()}else if(mode==='overview'&&active){commitBoard(active);return}else{returnView=snapshot();mode='overview';}
    render();refreshLists();wake();if(mode==='focus'&&!disconnected&&!video.error)hint.classList.add('quiet');
  }
  function beginPeek() {if(peek||editing)return;finishPan();noteViewIntent();if(captureNeedsFrame())cancelCapture();peek={origin:snapshot()};render();wake()}
  function endPeek() {if(!peek)return;const v=peek.origin;peek=null;restoreView(v);scheduleHide()}
  function refreshLists() {
    study.setContext({canProtect:protectionAllowed()});
    for(const list of [$('board-list'),$('quick-boards')]){
      list.replaceChildren();
      for(const [i,b] of boards.entries()){
        const button=document.createElement('button');button.dataset.board=b.id;button.setAttribute('aria-label',b.name);button.setAttribute('aria-keyshortcuts',String(i+1));button.setAttribute('aria-current',String(active===b.id&&mode==='focus'&&!peek));
        if(list===$('quick-boards')){button.className='board-card';const preview=document.createElement('span');preview.className='board-mini';preview.innerHTML=boardMap(b.roi);const name=document.createElement('span');name.setAttribute('data-board-label','');name.textContent=b.name;button.append(preview,name);}else button.textContent=b.name;
        list.append(button);
      }
    }
    $('board-grid').style.gridTemplateColumns=`repeat(${Math.min(3,boards.length+1)},minmax(0,1fr))`;
    if(shadow.activeElement!==$('board-name')&&!boardNameComposing)$('board-name').value=boards.find(b=>b.id===active)?.name||'';
    $('board-name').disabled=!active||reviewPending;$('remove').disabled=!active||reviewPending;$('redraw').disabled=!active;$('add').disabled=boards.length>=MAX_BOARDS;$('last').disabled=!lastView;$('last').hidden=!lastView;
    const panel=panelPage();
    $('board-choice').textContent=boards.find(b=>b.id===active)?.name||'选择板位';
    $('boards-panel').hidden=panel!=='boards'||!!editing;$('settings-panel').hidden=panel!=='settings';$('edit-panel').hidden=!editing||!['watch','boards'].includes(panel);
    $('boards-toggle').setAttribute('aria-expanded',String(panel==='boards'));$('settings-toggle').setAttribute('aria-expanded',String(panel==='settings'));
    $('boards-toggle').setAttribute('aria-label',boards.length?'编辑板位':'添加板位');
    $('save-status').textContent=reviewPending?'请先核对板位。':key&&repo.persistent?'':'当前布局尚未持久保存。';
    refreshStudy();
  }
  function refreshStudy(){
    const interaction=study.snapshot(),wanted=interaction.protectionWanted,busy=workspaceBusy(),writer=protectionWriter.inspect(),panel=panelPage(),temporaryMenu=sideWorkspace(workspacePage)&&localPanel(menu);
    $('library-panel').hidden=workspacePage!=='library';$('watch-panel').hidden=panel!=='watch'||!!editing;
    $('viewer-menu').hidden=!localPanel(panel);
    $('viewer-menu').setAttribute('aria-label',({watch:'选择板位',boards:editing==='add'?'添加板位':'编辑板位',settings:'更多操作'})[panel]||'板位操作');
    $('capture').setAttribute('aria-label','截取课堂片段');
    $('shot-panel').hidden=workspacePage!=='shot';
    $('done-shot').innerHTML=toolbarIcon('back');$('done-shot').setAttribute('aria-label',shotReturnPage==='chat'?'返回提问':'返回课堂片段');
    $('shot-copy').disabled=!shotImage;$('shot-save').hidden=!shotImage;
    $('shot-ask').innerHTML=toolbarIcon('chat');$('shot-ask').setAttribute('aria-label','用这张图提问');
    $('guard-toggle').setAttribute('aria-pressed',String(interaction.protectionActive&&interaction.protectionTarget));$('guard-toggle').setAttribute('aria-label',wanted?'退出写字保护':'写字保护');
    $('chat-toggle').setAttribute('aria-expanded',String(workspacePage==='chat'));$('chat-toggle').setAttribute('aria-label',workspacePage==='chat'?'收起提问':'提问');
    $('view-toggle').setAttribute('aria-expanded',String(['watch','boards'].includes(panel)));$('library').setAttribute('aria-expanded',String(workspacePage==='library'));
    for(const [id,selected]of [['materials-workspace',workspacePage==='library'||workspacePage==='shot'],['chat-workspace',workspacePage==='chat']])$(id).setAttribute('aria-current',String(selected));
    $('chat-toggle').disabled=false;$('guard-toggle').disabled=false;$('chat-space').hidden=!sideWorkspace(workspacePage)&&!closingReservation;$('chat-space').setAttribute('aria-busy',String(busy));
    $('chat-focus').hidden=workspacePage!=='chat'||!companionState.chatOpen;
    const nativeChatError=workspacePage==='chat'&&(!busy||!companionState.chatLayoutPending||companionState.chatError!==companionState.chatLayoutError)?companionState.chatError:'';
    const connectionError=workspaceError?.action==='launch'||['companion_upgrade','companion_unavailable'].includes(workspaceError?.code)||workspacePage==='chat'&&!busy&&!companionState.connected;
    const chatPending=workspacePage==='chat'&&companionState.connected&&(companionState.chatOpening||companionState.chatLayoutPending);
    const status=temporaryMenu?(workspaceError?'暂未切换':busy?'切换中…':''):workspaceError||nativeChatError?(workspacePage==='chat'?(connectionError?'提问未连接':'提问暂未打开'):'暂未切换'):connectionError?'提问未连接':workspacePage!=='closed'&&protectionFailure?'保护未生效':workspacePage!=='closed'&&writer.busy&&interaction.protectionActive&&!interaction.protectionTarget?'正在恢复输入…':workspacePage==='chat'&&(busy||chatPending)?'连接中…':workspacePage==='chat'&&!companionState.chatOpen?'提问暂未打开':workspacePage==='closed'&&closingReservation&&busy?'正在收起…':'';
    $('workspace-status').hidden=true;$('workspace-message').textContent=status;
    $('menu-status').hidden=true;$('menu-status').textContent=status;
    $('workspace-message').title=workspaceError?.message||nativeChatError||protectionFailure?.error.message||companionState.reason||'';
    $('workspace-launch').hidden=true;$('workspace-retry').hidden=true;
    $('chat-toggle').setAttribute('aria-busy',String(workspacePage==='chat'&&(busy||chatPending)));
    $('chat-workspace').setAttribute('aria-busy',String(workspacePage==='chat'&&(busy||chatPending)));
    const nativeActive=interaction.protectionActive,touchDoorReady=nativeActive&&companionState.protectionDoorReady===true;
    const protectionStatus=protectionFailure?`${nativeActive?'写字保护仍未解除':'写字保护未生效'} · ${protectionFailure.error.message}`:
      nativeActive?(interaction.protectionTarget?'写字保护已开启':wanted?'正在暂停写字保护…':'正在解除写字保护…'):
      protectionConnecting?'正在连接写字保护…':interaction.protectionTarget&&writer.busy?'正在开启写字保护…':interaction.task?'写字保护暂时暂停':'写字保护尚未开启';
    $('protection-strip').hidden=!((wanted||nativeActive)&&!localPanel(workspacePage)&&!closingReservation);$('protection-door').disabled=!doorEnabled();
    if($('protection-status').textContent!==protectionStatus)$('protection-status').textContent=protectionStatus;
    $('protection-info').hidden=true;
    $('protection-door').setAttribute('aria-label','退出写字保护。鼠标点击；'+(touchDoorReady?'触笔或触摸按住后向右滑；':'')+'键盘长按Esc后松开');
    $('protection-retry').hidden=true;$('protection-retry').disabled=writer.busy||protectionConnecting;$('protection-retry').textContent=protectionFailure?.target===false?(wanted?'重试暂停':'重试解除'):'重试开启';
    host.dataset.protectionState=protectionFailure?'failed':nativeActive&&interaction.protectionTarget?'active':writer.busy?'pending':'inactive';
    if(guard.active&&!hover&&!localPanel(menu)&&Date.now()>protectionMouseUntil)hideControls(true);
    $('boards-toggle').disabled=false;
    $('fullscreen').setAttribute('aria-label',fullscreen.active()?'退出全屏':'全屏');$('fullscreen').setAttribute('aria-pressed',String(fullscreen.active()));
    $('fullscreen').disabled=false;
  }
  function drawRegions() {
    const regions=$('regions');regions.hidden=captureOverlayHidden||!!editing||!(peek||mode==='overview');
    if(regions.hidden||!layout)return;
    const existing=new Map([...regions.children].map(node=>[node.dataset.board,node])),ordered=[];
    for(const b of [...boards].sort((a,b)=>b.roi.w*b.roi.h-a.roi.w*a.roi.h)){
      let node=existing.get(b.id);
      if(!node){node=document.createElement('button');node.className='region';node.dataset.board=b.id;node.append(document.createElement('span'));}
      node.setAttribute('aria-label','切换到'+b.name);const label=node.querySelector('span');if(label.textContent!==b.name)label.textContent=b.name;
      Object.assign(node.style,{left:layout.left+b.roi.x*layout.width+'px',top:layout.top+b.roi.y*layout.height+'px',width:b.roi.w*layout.width+'px',height:b.roi.h*layout.height+'px'});ordered.push(node);
    }
    if(regions.children.length!==ordered.length||ordered.some((node,index)=>regions.children[index]!==node))regions.replaceChildren(...ordered);
  }
  function render() {
    if(closed)return;
    const viewport=viewportArea(),right=innerWidth-(viewport.x+viewport.visual.width),bottom=innerHeight-(viewport.y+viewport.visual.height);
    if(captureView&&captureNeedsFrame()&&([innerWidth,innerHeight,viewport.aside,viewport.height,window.devicePixelRatio||1].some((value,i)=>Math.abs(value-captureView.viewport[i])>.01)||Object.keys(viewport.visual).some(key=>Math.abs(viewport.visual[key]-captureView.visual[key])>.01)))cancelCapture({reason:'画面尺寸已变化，请重新框选。'});
    host.style.setProperty('--zjf-aside',viewport.aside+'px');Object.assign(surface.style,{left:viewport.x+'px',top:viewport.y+'px',right:right+viewport.aside+'px',bottom:bottom+viewport.strip+'px'});
    Object.assign($('chat-space').style,{right:right+'px',top:viewport.y+'px',bottom:bottom+'px'});Object.assign($('protection-strip').style,{right:right+viewport.aside+'px',top:viewport.y+'px',maxWidth:Math.max(1,viewport.width-8)+'px'});
    const toolArea=$('workspace-tools'),activeControl=shadow.activeElement,controlNodes=[dock,$('viewer-menu'),$('rate-menu')];
    let headerTools=viewport.width<220&&sideWorkspace(workspacePage);
    if((composing||scrubbing)&&controlNodes.some(node=>node.contains(activeControl))&&typeof toolArea.moveBefore!=='function')headerTools=host.dataset.narrowVideo==='true';
    const toolbarWidth=headerTools?Math.max(1,viewport.aside-20):viewport.width;
    host.dataset.narrowVideo=String(headerTools);toolArea.hidden=!headerTools;toolArea.style.maxHeight=Math.max(1,viewport.visual.height-164-(!$('workspace-status').hidden?$('workspace-status').getBoundingClientRect().height:0))+'px';
    if(headerTools){controlsVisible=true;dock.inert=false;dock.removeAttribute('aria-hidden');dock.classList.remove('quiet');}
    for(const node of controlNodes){const parent=headerTools?toolArea:shadow;if((node.parentNode||node.parentElement)===parent)continue;
      if(typeof parent.moveBefore==='function'){parent.moveBefore(node,null);continue;}
      const focused=node.contains(activeControl),selection=focused&&typeof activeControl.selectionStart==='number'?{start:activeControl.selectionStart,end:activeControl.selectionEnd,direction:activeControl.selectionDirection}:null;
      parent.append(node);if(focused){activeControl.focus({preventScroll:true});if(selection)activeControl.setSelectionRange(selection.start,selection.end,selection.direction);}
    }
    dock.style.left=viewport.x+viewport.width/2+'px';dock.style.maxWidth=Math.min(720,Math.max(1,toolbarWidth-16))+'px';dock.classList.toggle('compact',toolbarWidth<720);dock.classList.toggle('narrow',toolbarWidth<600);dock.classList.toggle('tiny',toolbarWidth<360);hint.style.left=viewport.x+viewport.width/2+'px';hint.style.maxWidth=Math.max(1,viewport.width-16)+'px';
    const percent=Math.round((pendingSidebarWidth||viewport.aside||sidebarSize(viewport.visual.width,preferences.sidebarRatio))/viewport.visual.width*100);
    const limits=sidebarLimits(viewport.visual.width);
    $('chat-ratio').textContent=percent+'%';$('chat-resize').setAttribute('aria-valuenow',String(percent));$('chat-resize').setAttribute('aria-valuemin',String(Number((limits.minimum/viewport.visual.width*100).toFixed(6))));$('chat-resize').setAttribute('aria-valuemax',String(Number((limits.maximum/viewport.visual.width*100).toFixed(6))));
    if(video.isConnected){layout=placement(mode==='focus'&&!peek&&!editing?roi:FULL,video.videoWidth,video.videoHeight,viewport.width,Math.max(1,viewport.height-(capturePaintActive?12:0)));
      if(layout){layout.left+=viewport.x;layout.top+=viewport.y;layout.view.x+=viewport.x;layout.view.y+=viewport.y}
      if(layout){for(const[n,v]of[['left',layout.left],['top',layout.top],['width',layout.width],['height',layout.height]])video.style.setProperty('--zjf-'+n,v+'px');video.style.setProperty('--zjf-clip','inset('+layout.crop.map(x=>Math.max(0,x)+'px').join(' ')+')');
        const space=viewport.y+viewport.height-(layout.view.y+layout.view.h),height=bar.getBoundingClientRect().height||54;dock.style.setProperty('--bottom',Math.round(bottom+viewport.strip+(space>height+24?Math.max(12,(space-height)/2):12))+'px');}
    }
    surface.style.cursor=editing?'crosshair':mode==='focus'?'grab':'default';host.dataset.mode=peek?'peek':mode;host.dataset.protected=String(guard.active);host.dataset.workspace=workspacePage;
    $('overview').setAttribute('aria-current',String(mode==='overview'||!!peek));drawRegions();
    $('view-toggle').setAttribute('aria-label','选择板位，当前'+(mode==='focus'&&!peek?boards.find(b=>b.id===active)?.name||'板位':'全景'));
    positionPlayerMenu($('viewer-menu'),panelPage()==='settings'?$('settings-toggle'):$('view-toggle'));
    positionPlayerMenu($('rate-menu'),$('rate'));
    const dockRect=dock.getBoundingClientRect();hint.style.bottom=Math.max(8,headerTools?bottom+12:innerHeight-dockRect.top+8)+'px';
    if(workspacePage==='chat'&&companionState.connected&&!workspacePending&&!headerLayoutSync&&Math.abs((companionState.workspaceHeaderHeight??44)-workspaceHeaderHeight())>.5){headerLayoutSync=companion.refresh().catch(()=>{}).finally(()=>{headerLayoutSync=null;});}
    if(!imageDrag)renderImageCrop();
    const currentMatte=[mode,active,dimensions.join('x')].join(':');
    if(currentMatte!==matteKey&&video.readyState>=2){
      matteKey=currentMatte;let shade=34;
      try{const sample=document.createElement('canvas');sample.width=24;sample.height=16;const ctx=sample.getContext('2d',{willReadFrequently:true}),r=mode==='focus'?roi:FULL;ctx.drawImage(video,r.x*video.videoWidth,r.y*video.videoHeight,r.w*video.videoWidth,r.h*video.videoHeight,0,0,24,16);const data=ctx.getImageData(0,0,24,16).data,values=[];for(let i=0;i<data.length;i+=4)values.push(data[i]*.2126+data[i+1]*.7152+data[i+2]*.0722);values.sort((a,b)=>a-b);shade=Math.round(clamp(values[values.length>>1]*.8,26,48))}catch{}
      background.style.setProperty('background',`rgb(${shade},${shade},${shade})`,'important');
    }
  }
  function requestRender(){if(!frameRequest)frameRequest=requestAnimationFrame(()=>{frameRequest=0;render()})}
  const fmt=n=>Number.isFinite(n)?`${Math.floor(n/60)}:${String(Math.floor(n%60)).padStart(2,'0')}`:'--:--';
  function positionPlayerMenu(node,anchor){
    if(node.hidden){node.dataset.headerOpen='false';return;}
    if(host.dataset.narrowVideo==='true'){
      Object.assign(node.style,{width:'100%',left:'',top:'',bottom:'',maxHeight:'none'});
      if(node.dataset.headerOpen!=='true'){$('workspace-tools').scrollTop=node.offsetTop;node.dataset.headerOpen='true';}
      return;
    }
    node.dataset.headerOpen='false';const viewport=viewportArea(),rect=anchor.getBoundingClientRect(),barRect=bar.getBoundingClientRect(),width=Math.min(node.id==='rate-menu'||editing?112:panelPage()==='watch'?Math.min(304,(boards.length+1)*92+16):panelPage()==='settings'?264:292,Math.max(1,viewport.width-24));
    const left=node.id==='rate-menu'?(rect.left+rect.right-width)/2:rect.right-width;
    const above=Math.max(1,barRect.top-viewport.y-20),below=Math.max(1,viewport.y+viewport.height-barRect.bottom-20),openBelow=above<80&&below>above;
    Object.assign(node.style,{width:width+'px',left:clamp(left,viewport.x+12,Math.max(viewport.x+12,viewport.x+viewport.width-width-12))+'px',top:openBelow?barRect.bottom+8+'px':'',bottom:openBelow?'':Math.max(12,innerHeight-barRect.top+8)+'px',maxHeight:(openBelow?below:above)+'px'});
  }
  function closeRateMenu(focus=false){$('rate-menu').hidden=true;$('rate').setAttribute('aria-expanded','false');study.setContext({canProtect:protectionAllowed()});if(focus)$('rate').focus({preventScroll:true})}
  function dismissPlayerMenus(){closeRateMenu();if(localPanel(menu)&&!editing)void closeMenu({returnFocus:false});scheduleHide();}
  function scheduleMenuDismiss(event){
    clearTimeout(menuDismissTimer);
    if(keyboardMode||editing||event.pointerType&&event.pointerType!=='mouse')return;
    menuDismissTimer=setTimeout(()=>{if(!closed&&!keyboardMode&&!editing&&shadow.activeElement!==$('board-name'))dismissPlayerMenus();},220);
  }
  function sync(){if(closed)return;const error=disconnected||!!video.error;$('play').classList.toggle('is-playing',!video.paused);$('play').setAttribute('aria-label',video.paused?'播放':'暂停');$('time').textContent=fmt(video.currentTime)+' / '+fmt(video.duration);$('seek').disabled=error||!Number.isFinite(video.duration);$('seek').max=Number.isFinite(video.duration)?String(video.duration):'0';if(!scrubbing&&shadow.activeElement!==$('seek'))$('seek').value=String(video.currentTime);$('seek').style.setProperty('--progress',video.duration>0?100*Number($('seek').value)/video.duration+'%':'0%');$('rate').textContent=video.playbackRate+'×';for(const option of $('rate-menu').querySelectorAll('[data-rate]'))option.setAttribute('aria-pressed',String(Number(option.dataset.rate)===video.playbackRate));$('play').disabled=error;$('rate').disabled=error;$('rewind').disabled=error;$('reconnect').hidden=!error;$('return-time').hidden=!replayReturn;if(error)closeRateMenu();}
  function setMenu(name){
    if(editing)cancelEdit({keepWorkspace:true});suppressHover=false;
    if(panelPage()===name){void closeMenu();return}
    if(!localPanel(menu)||bar.contains(shadow.activeElement))menuTrigger=shadow.activeElement;void changeWorkspace(name);
    if(keyboardMode){const panel=$(({watch:'watch-panel',boards:'boards-panel',settings:'settings-panel',shot:'shot-panel'})[name]);[...panel.querySelectorAll('button,input,summary')].find(node=>!node.disabled&&node.getClientRects().length)?.focus({preventScroll:true})}
  }
  function startEdit(kind){if(kind==='add'&&boards.length>=MAX_BOARDS)return;finishPan();noteViewIntent();if(captureSelecting||captureWorking)cancelCapture();editOrigin=snapshot();editing=kind;mode='select';peek=null;selection.style.display='none';hint.classList.add('quiet');void changeWorkspace('boards');render();refreshLists();wake();cursorWake();surface.focus({preventScroll:true})}
  function cancelEdit({keepWorkspace=false}={}){finishPan();noteViewIntent();editing=null;selection.style.display='none';if(editOrigin){restoreView(editOrigin);editOrigin=null}else{mode=boards.length?'focus':'overview';render()}if(!keepWorkspace&&panelPage()!=='closed')void changeWorkspace('watch');refreshLists();scheduleHide()}
  function escape(){
    if(!$('rate-menu').hidden){closeRateMenu(true);scheduleHide();return}
    if(captureSelecting||captureWorking){cancelCapture();return}
    if(editing){cancelEdit();wake();return}
    if(drag){finishPan({revert:true});render()}
    if(peek){endPeek();return}
    const details=shadow.activeElement?.closest?.('details[open]');
    if(details&&$('viewer-menu').contains(details)){details.open=false;details.querySelector('summary')?.focus({preventScroll:true});return}
    if(localPanel(menu)){void closeMenu();return}
    if(workspacePage!=='closed'){void closeWorkspace();return}
    if(controlsVisible){surface.focus({preventScroll:true});suppressHover=true;hideControls(true);hint.classList.add('quiet')}else wake();
  }
  async function togglePlay(){
    notePlaybackIntent();if(captureNeedsFrame())cancelCapture({resume:false});
    const owner=intents.observe('playback'),type=video.paused?'play':'pause',expected=expectPlayback(type);
    try{
      // Apply the click immediately, including the separate enhanced-audio
      // route. A pending play promise must not delay the button's state.
      const pending=type==='play'?video.play():(audio.pause(),null);
      if(!closed){sync();wake()}
      if(pending)await pending;
    }catch{forgetPlayback(type,expected);if(owner.isCurrent())tell('视频暂时无法播放，请稍后重试。')}
    if(!closed&&owner.isCurrent()){sync();wake()}
  }
  function seek(time){if(captureNeedsFrame())cancelCapture();notePlaybackIntent();if(!disconnected&&!video.error&&Number.isFinite(video.duration)){const target=clamp(time,0,video.duration);if(Math.abs(video.currentTime-target)>.000001){mediaPositionEpoch++;currentMark=null;currentMarkBoards='';expectedSeeks.push({time:target});video.currentTime=target}}}
  function reconnect(){
    if(closed||reconnecting)return;
    const found=[...document.querySelectorAll('video')].some(v=>v.isConnected&&!v.error&&visible(v)&&v.readyState>=2);
    if(!found){tell('新视频尚未就绪，板位保留。',true);return}
    reconnecting=true;const current=window[KEY],closing=close({preserveFullscreen:true});
    if(closing?.then)void closing.then(done=>{if(done)activateFocus(current.inspect());else reconnecting=false});else if(closing!==false)activateFocus(current.inspect());else reconnecting=false;
  }
  let handoffSnapshot=null;
  function close({preserveFullscreen=false}={}){
    if(closed)return true;
    finishPan();
    const saving=[];
    try{libraryUI.protectSelection();if(libraryUI.hasUnsaved())saving.push(libraryUI.flush());}catch(error){console.debug('[智云聚焦]',error.message);}
    if(outbox.hasUnprotected())saving.push(outbox.flush());
    void Promise.allSettled(saving).then(results=>{for(const result of results)if(result.status==='rejected')console.debug('[智云聚焦]',result.reason?.message||result.reason);});
    save();handoffSnapshot={...window[KEY]?.inspect?.(),closed:true,fullscreenPending:fullscreen.pending};cancelCapture({resume:false});closed=true;controller.abort();outbox.releasePixels();intents.dispose();libraryUI.suspend();libraryUI.dispose();momentShelf.dispose();clearTimeout(layoutMotionTimer);video.removeAttribute('data-zjf-moving');study.dispose();protectionDoor.dispose();keyboardDoor.dispose();protectionWriter.dispose();captureEpoch++;restoreEpoch++;clearTimeout(restoreTimer);captureClock.dispose();sidebarResizer.cancel();fullscreen.dispose({preserve:preserveFullscreen});companion.dispose();guard.dispose();audio.dispose();observer.disconnect();resizeObserver.disconnect();
    [hideTimer,cursorTimer,hintTimer,saveTimer,visibilityTimer,shotTimer,menuDismissTimer,controlsRevealTimer,markFlashTimer].forEach(clearTimeout);cancelAnimationFrame(frameRequest);
    for(const[name,value,priority]of oldProperties)value?video.style.setProperty(name,value,priority):video.style.removeProperty(name);
    if(!hadStyle&&!video.getAttribute('style')?.trim())video.removeAttribute('style');
    oldVideoMark===null?video.removeAttribute('data-zjf-video'):video.setAttribute('data-zjf-video',oldVideoMark);
    for(const[e,old]of oldChain)old===null?e.removeAttribute('data-zjf-raise'):e.setAttribute('data-zjf-raise',old);
    for(const[e,old]of oldPage)old===null?e.removeAttribute('data-zjf-page'):e.setAttribute('data-zjf-page',old);
    css.remove();background.remove();host.remove();if(!video.controls)video.controls=originalControls;if(window[KEY]?.close===close)delete window[KEY];return true;
  }
  function attachViewerHost(){
    const full=document.fullscreenElement,parent=full&&full!==video&&full!==document.documentElement&&full.contains(video)?full:document.body;
    if(host.parentElement!==parent)parent.append(host);
    if(full===video&&typeof host.showPopover==='function'){host.setAttribute('popover','manual');if(!host.matches(':popover-open'))host.showPopover();}
    else if(host.hasAttribute('popover')){if(host.matches(':popover-open'))host.hidePopover();host.removeAttribute('popover');}
  }
  const observer=new MutationObserver(()=>{if(closed)return;attachViewerHost();if(!background.isConnected)(video.isConnected?video.parentElement:document.body).append(background);if(!video.isConnected&&!disconnected){cancelCapture({resume:false});captureClock.invalidate();disconnected=true;video.pause();audio.stop();sync();wake()}if(disconnected&&[...document.querySelectorAll('video')].some(v=>v.isConnected&&!v.error&&visible(v)&&v.readyState>=2))reconnect()});
  const resizeObserver=new ResizeObserver(requestRender);
  try {
    document.head.append(css);chain.forEach(e=>e.setAttribute('data-zjf-raise',token));oldPage.forEach(([e])=>e.setAttribute('data-zjf-page',token));video.setAttribute('data-zjf-video',token);video.controls=false;video.parentElement.append(background);attachViewerHost();
    observer.observe(document.body,{childList:true,subtree:true});resizeObserver.observe(document.documentElement);resizeObserver.observe($('protection-strip'));resizeObserver.observe(bar);resizeObserver.observe($('workspace-tools'));resizeObserver.observe($('workspace-status'));
    window[KEY]={version:VERSION,build:BUILD,close,reveal:()=>wake(),inspect:()=>handoffSnapshot||({build:BUILD,mode,roi:{...roi},boards:boards.map(cloneBoard),active,peeking:!!peek,editing,menu,workspacePage,workspaceRevision,workspaceBusy:workspaceBusy(),workspaceError:workspaceError?.message||'',controlsVisible,reviewPending,layout:pack(),key,storagePersistent:!!key&&repo.persistent,sourceTime:video.currentTime,videoConnected:video.isConnected,sourceCount:document.querySelectorAll('video').length,hasOwnCanvas:false,duration:video.duration,paused:video.paused,rate:video.playbackRate,dimensions:[...dimensions],fullscreen:fullscreen.active(),fullscreenOwned:fullscreen.ownsDocument,fullscreenError:fullscreen.error?.message||'',disconnected,closed,protected:guard.active,protection:study.snapshot(),sidebarWidth:viewportArea().aside,geometry:viewerGeometry(),companionConnected:companionState.connected,companion:{...companionState,session:undefined},audio:audio.inspect()})};
    render();refreshLists();sync();if(getComputedStyle(video).position!=='fixed')throw Error('页面未允许显示样式');
  }catch(e){close();p.onError?.(e);console.debug('[智云聚焦]',e);return}
  // Events on the UI never reach a platform player underneath it.
  for(const name of ['click','dblclick','pointerdown','pointerup','pointermove','wheel','keydown','keyup'])on(host,name,e=>e.stopPropagation());
  on(host,'pointerdown',()=>{keyboardMode=false;clearTimeout(controlsRevealTimer);controlsRevealTimer=0;noteFocusIntent()},{capture:true});
  on(host,'pointermove',event=>{const target=event.composedPath()[0];if(!drag&&!editing&&(target===surface||$('regions').contains(target)))revealFromPointer(event);else{clearTimeout(controlsRevealTimer);controlsRevealTimer=0;}},{capture:true});
  on(host,'pointerleave',()=>{clearTimeout(controlsRevealTimer);controlsRevealTimer=0;});
  const syncInputScope=()=>{if(companionState.connected&&(study.snapshot().protectionWanted||companionState.protected))void companion.refresh().catch(error=>{if(!closed&&error.name!=='AbortError')tell(error.message);});};
  on(host,'focusin',event=>{if(event.composedPath()[0]!==$('chat-focus'))noteFocusIntent();syncInputScope();},{capture:true});
  on(host,'focusout',()=>queueMicrotask(syncInputScope),{capture:true});
  on(dock,'pointerenter',()=>{hover=true;if(!suppressHover)wake()});on(dock,'pointerleave',()=>{hover=false;suppressHover=false;scheduleHide()});
  on(dock,'focusin',()=>wake());on(dock,'focusout',()=>{queueMicrotask(scheduleHide)});
  on(bar,'click',e=>{if(!keyboardMode&&!/INPUT|SELECT|OPTION/.test(e.target.tagName)){surface.focus({preventScroll:true});scheduleHide()}});
  on($('play'),'click',togglePlay);on($('overview'),'click',()=>{finishPan();noteViewIntent();if(captureSelecting||captureWorking)cancelCapture();if(mode==='focus')returnView=peek?.origin||snapshot();mode='overview';peek=null;editing=null;render();refreshLists();void closeMenu()});on($('boards-toggle'),'click',()=>boards.length?setMenu('boards'):startEdit('add'));on($('settings-toggle'),'click',()=>setMenu('settings'));
  on($('view-toggle'),'click',()=>setMenu('watch'));
  on($('watch-workspace'),'click',()=>{if(editing)cancelEdit({keepWorkspace:true});void changeWorkspace('watch')});
  on($('materials-workspace'),'click',()=>{if(editing)cancelEdit({keepWorkspace:true});void changeWorkspace('library')});
  on($('chat-workspace'),'click',()=>{if(editing)cancelEdit({keepWorkspace:true});void openChat()});
  on($('workspace-retry'),'click',()=>{protectionRequested=null;void changeWorkspace(workspacePage,{force:true})});
  on($('workspace-launch'),'click',event=>{
    event.preventDefault();const owner=workspaceOwner,page=workspacePage;
    const starting=companion.snapshot().requiresUpdate?helperStartup.launch():helperStartup.ensure({launchIfNeeded:true,signal:owner.signal});$('workspace-message').textContent='连接中…';
    void owner.after(starting.then(()=>companion.waitUntilReady({forChat:page==='chat'}))).then(()=>changeWorkspace(page,{force:true,requestOwner:owner})).catch(error=>{if(owner.isCurrent()){workspaceError=error;refreshStudy()}});
  });
  on($('fullscreen'),'click',async()=>{
    if(closed)return;
    const owner=intents.begin('fullscreen');if(captureNeedsFrame())cancelCapture();
    try{await fullscreen.toggle({isCurrent:owner.isCurrent,signal:owner.signal});if(owner.isCurrent()&&!closed)refreshStudy()}
    catch(error){if(owner.isCurrent()&&!closed){tell(error.message);wake()}}
  });
  on($('done-shot'),'click',()=>{void changeWorkspace(shotReturnPage)});
  function setProtectionWanted(value){
    $('protection-strip').dataset.revealed='false';
    const owner=intents.begin('protection'),connected=companion.snapshot().connected;protectionRequested=null;protectionFailure=null;protectionConnecting=false;
    study.setContext({canProtect:protectionAllowed()});
    study.setProtectionWanted(value);
    if(value){
      cancelTransient();if(editing)cancelEdit({keepWorkspace:true});if(localPanel(menu))void closeMenu();
      if(!connected){
        const workspace=workspaceOwner;protectionConnecting=true;refreshStudy();
        void owner.after(helperStartup.ensure({launchIfNeeded:true,signal:owner.signal}).then(()=>companion.connect())).then(()=>{
          workspace.assertCurrent();if(study.snapshot().protectionWanted)return queueProtection(study.snapshot().protectionTarget);
        }).catch(error=>{if(owner.isCurrent()&&workspace.isCurrent()&&!closed&&error.name!=='AbortError'){protectionFailure={error,target:true};refreshStudy()}})
          .finally(()=>{if(owner.isCurrent()&&!closed){protectionConnecting=false;refreshStudy()}});
      }
    }
    void queueProtection(study.snapshot().protectionTarget).catch(()=>{});
  }
  function exitProtection(){
    setProtectionWanted(false);protectionDoor?.cancel();keyboardDoor?.cancel();
    wake();cursorWake();surface.focus({preventScroll:true});
  }
  function retryProtection(){
    if(closed)return;
    setProtectionWanted(study.snapshot().protectionWanted);
  }
  on($('guard-toggle'),'click',()=>setProtectionWanted(!study.snapshot().protectionWanted));
  on($('protection-retry'),'click',retryProtection);
  on($('chat-close'),'click',()=>{void closeWorkspace()});
  on($('chat-toggle'),'click',()=>{if(workspacePage==='chat'){void closeWorkspace();return}if(editing)cancelEdit({keepWorkspace:true});void openChat()});
  function captureNeedsFrame(){return captureSelecting||captureWorking&&!captureTransaction?.frozen;}
  function cancelCapture({resume=true,reason=''}={}){
    if(closed)return;
    const wasSelecting=captureSelecting||captureWorking,transaction=captureTransaction;captureEpoch++;captureSelecting=false;captureReady=false;captureDrag=null;captureView=null;
    if(transaction){transaction.resume=resume;transaction.restoreChrome?.();transaction.controller.abort(new DOMException('Capture cancelled','AbortError'))}
    captureSourceTask?.controller.abort();captureSourceTask=null;
    if(captureTask){study.end(captureTask,{resume}).restorePlayback(automaticPlay);captureTask=null}
    intents.invalidate('capture');
    $('capture-layer').hidden=true;$('capture-tools').hidden=true;$('capture-rect').hidden=true;$('capture').disabled=captureWorking;
    if(reason&&wasSelecting&&!closed)tell(reason);
  }
  function captureLayout(){
    return {...layout,view:{...layout.view},source:video.currentSrc,element:video,sourceWidth:video.videoWidth,sourceHeight:video.videoHeight,rate:video.playbackRate,
      viewport:[innerWidth,innerHeight,viewportArea().aside,viewportArea().height,window.devicePixelRatio||1],visual:visualArea()};
  }
  function sameCaptureLayout(expected){
    return !!layout&&['left','top','width','height'].every(k=>Math.abs(layout[k]-expected[k])<.01)&&['x','y','w','h'].every(k=>Math.abs(layout.view[k]-expected.view[k])<.01);
  }
  function requestSourceFrame(view,time,owner){
    const controller=new AbortController(),task={source:view.source,time,controller,owner,promise:null,identity:sourceFrameIdentity(view.source)};task.identity.catch(()=>{});
    task.promise=readSourceFrame(view.source,time,{signal:AbortSignal.any([controller.signal,signal]),prepare:async deadline=>{await helperStartup.ensure({launchIfNeeded:true,signal:deadline});await companion.startAudio(deadline);}}).then(frame=>{task.frame=frame;return frame;});
    task.promise.catch(()=>{});return task;
  }
  function capturePaintProof(avoid){
    const viewport=viewportArea(),scale=(window.devicePixelRatio||1)*viewport.visual.scale;
    if(viewport.width<68||viewport.height<20)throw Error('课程区域太小，请扩大窗口后再截取背景。');
    const align=(value,offset)=>offset+Math.round((value-offset)*scale)/scale;
    const candidates=[{x:viewport.x+(viewport.width-64)/2,y:viewport.y+viewport.height-10},{x:viewport.x+2,y:viewport.y+viewport.height-10},{x:viewport.x+viewport.width-66,y:viewport.y+2},{x:viewport.x+2,y:viewport.y+2}];
    const point=candidates.find(p=>!avoid||p.x+66<=avoid.x||p.x>=avoid.x+avoid.w+2||p.y+10<=avoid.y||p.y>=avoid.y+avoid.h+2);if(!point)return null;
    const proof={nonce:crypto.randomUUID().replaceAll('-',''),x:align(point.x,viewport.visual.offsetLeft),y:align(point.y,viewport.visual.offsetTop)};
    const marker=$('capture-paint');marker.replaceChildren();
    for(const hex of proof.nonce){const value=parseInt(hex,16);for(let bit=3;bit>=0;bit--){const pixel=document.createElement('i');pixel.style.background=value&(1<<bit)?'#fff':'#000';marker.append(pixel);}}
    Object.assign(marker.style,{left:proof.x+'px',top:proof.y+'px'});marker.hidden=false;return proof;
  }
  async function beginCapture(){
    if(captureSelecting){cancelCapture();return}if(captureWorking)return;
    finishPan();
    if(identity()!==key){tell('课程正在切换，画面就绪后再截图。');return;}
    if(editing)cancelEdit({keepWorkspace:true});
    clearTimeout(layoutMotionTimer);video.removeAttribute('data-zjf-moving');delete host.dataset.moving;
    closeRateMenu();if(localPanel(menu)&&!await closeMenu())return;if(captureSelecting||captureWorking)return;
    render();if(!layout||disconnected||video.readyState<2||video.seeking){tell('等待视频画面和跳转完成后再框选。');return}
    const owner=intents.begin('capture');captureTask=study.begin('capture',{owner});captureTask.pause(automaticPause);captureEpoch++;captureSelecting=true;captureReady=!companionState.protected;captureView=captureLayout();captureDrag=null;
    const targetView=captureView,targetWorkspace=workspaceOwner;
    targetView.targetReady=companion.snapshot().connected?owner.after(companion.refresh()).then(state=>{
      if(!targetWorkspace.isCurrent()||workspacePage!=='chat')return null;
      if(state.chatDraftReady&&state.chatDraftTarget)return {...captureTarget(state.chatDraftTarget),...state.chatDraftTarget.draftId?{draftId:state.chatDraftTarget.draftId}:{}};
      targetView.needsTargetReview=true;return null;
    },error=>{if(error.name==='AbortError'||!owner.isCurrent())throw error;targetView.needsTargetReview=workspacePage==='chat';return null;}):Promise.resolve(null);
    targetView.targetReady.catch(()=>{});
    // Start the one-frame decode while the user draws. Native canvas access,
    // when available, remains immediate and does not need this fallback.
    try{captureFrame(video);}catch(error){if(error.name==='SecurityError'||error.code==='capture_image_budget')captureSourceTask=requestSourceFrame(captureView,captureClock.read()?.time??video.currentTime,owner);}
    const v=captureView.view;
    Object.assign($('capture-layer').style,{left:v.x+'px',top:v.y+'px',width:v.w+'px',height:v.h+'px'});
    const tools=$('capture-tools'),mainRight=viewportArea().width,leftGap=v.x,rightGap=mainRight-v.x-v.w,bottomGap=innerHeight-v.y-v.h;
    let toolLeft=Math.max(12,v.x+10),toolTop=Math.max(12,innerHeight-50),toolWidth=Math.max(100,mainRight-toolLeft-12);
    if(bottomGap>=50)toolTop=v.y+v.h+8;
    else if(v.y>=50)toolTop=v.y-44;
    else if(Math.max(leftGap,rightGap)>=130){
      const right=rightGap>=leftGap;toolLeft=right?v.x+v.w+12:12;toolTop=Math.max(12,v.y+8);toolWidth=(right?rightGap:leftGap)-24;
    }
    Object.assign(tools.style,{left:toolLeft+'px',top:toolTop+'px',maxWidth:toolWidth+'px'});
    $('capture-layer').hidden=false;$('capture-tools').hidden=false;
    refreshLists();hideControls(true);hint.classList.add('quiet');
    try{await owner.after(queueProtection(false));if(captureSelecting&&owner.isCurrent())captureReady=true}
    catch(error){if(owner.isCurrent()){cancelCapture();if(error.name!=='AbortError')tell(error.message)}}
  }
  function drawCapture(point){
    if(!captureDrag||!captureView)return;
    const rect=selectionRectangle(captureDrag,point,captureView.view,1);$('capture-rect').hidden=!rect;
    if(rect)Object.assign($('capture-rect').style,{left:rect.x+'px',top:rect.y+'px',width:rect.w+'px',height:rect.h+'px'});
  }
  function recordCaptureStatus(message,{persistent=false,actionLabel='查看',action='shot',markId='',questionId=''}={}){
    // Material and control states give feedback; diagnostics never interrupt.
    host.dataset.captureStatus=message;
    $('shot-toast').hidden=true;
  }

  on($('shot-preview'),'click',()=>{
    $('shot-toast').hidden=true;clearTimeout(shotTimer);if(shotNoticeAction==='pending'){void retryCaptures();return}
    const markId=shotNoticeMarkId,questionId=shotNoticeQuestionId,opening=changeWorkspace(shotNoticeAction==='library'?'library':'shot'),owner=workspaceOwner;
    if(questionId||markId)void owner.after(opening).then(()=>owner.after(questionId?libraryUI.revealQuestion(questionId):libraryUI.revealMark(markId))).catch(error=>{if(owner.isCurrent()&&error.name!=='AbortError')tell(error.message)});
  });
  function reportCaptureResolution(proof){
    if(proof.outcome==='retained-draft')recordCaptureStatus('已保存在原草稿',{persistent:true,action:'library',actionLabel:'查看原草稿',questionId:proof.questionId});
    else recordCaptureStatus(proof.outcome==='already-sent'?'已核对原提问，这张图此前已发送':proof.outcome==='removed'?'已从草稿移除，原图保留':proof.dismissed?'原图已留在学习记录中':'原附图记录已处理');
  }
  function showCapturePreview(batch,{layout:savedLayout=null,sourcePage='',markOnly=false}={}){
    captureRecoveryJob=null;
    shotPreviewEpoch++;
    if(markOnly){const item=savedLayout?.view?.mode==='focus'?batch.context.find(x=>x.boardId===savedLayout.view.active):null;batch={...batch,selection:{...(item||batch.context[0])}};}
    shotLayout=savedLayout;shotSourcePage=sourcePage;
    shotBatch=batch;imageDrag=null;imageCropView=null;const staged=outbox.staged.find(crop=>crop.sourceSnapshotId===batch.id&&crop.sourceItemId===batch.selection.id);
    const queued=captureQueue.find(job=>(job.id||job.batch?.id)===batch.id),pending=outbox.pending.some(job=>job.request.batch.id===batch.id);
    $('shot-keep').hidden=!queued?.canKeep;$('shot-keep').disabled=false;
    $('shot-retry').hidden=!queued&&!pending;$('shot-retry').textContent=pending?'保存':'附图';
    if(pendingShotPlan()){$('shot-retry').hidden=false;$('shot-retry').textContent='重新选用';}
    if(queued?.requiresReview)$('shot-status').textContent='已保存，尚未附入原对话';
    imageCrop=staged?{...staged.area}:null;imageCropData=staged?.image||'';imageCropId=staged?.id||null;$('image-selection').hidden=true;$('shot-crop').hidden=!staged;$('shot-crop').disabled=false;
    shotImage=batch.selection.image;const name='板书-'+fmt(batch.time).replace(':','-')+'.png';
    $('shot-image').hidden=false;$('shot-image').src=shotImage;for(const id of ['shot-save']){$(id).href=imageCropData||shotImage;$(id).download=name}
    $('shot-time').textContent=fmt(batch.time);updateShotSource();$('shot-last').hidden=false;$('shot-last').innerHTML=toolbarIcon('library');refreshStudy();
  }
  function updateShotSource(){const source=[shotBatch?.markTitle,shotBatch?.selection.source||shotBatch?.selection.label].filter(Boolean).join(' · '),missing=shotBatch?.missingContext||shotBatch?.selection.missingContext||[];$('shot-source').textContent=source+(missing.length?'\n背景未采集：'+missing.map(item=>item.label).join('、'):'');$('shot-source').hidden=true;}
  async function cropLibraryImage(item,image,{isCurrent=()=>true}={}){
    const owner=workspaceOwner,preview=++shotPreviewEpoch;
    const saved=await owner.after(companion.library('capture',{id:item.snapshotId}));
    if(!isCurrent()||preview!==shotPreviewEpoch)return;
    await owner.after(outbox.restoreLocal(saved.batch.lessonKey).catch(()=>{}));if(!isCurrent()||preview!==shotPreviewEpoch)return;
    const source=[...saved.batch.context,saved.batch.selection].find(value=>value?.id===item.id);
    if(!source)throw Error('原图暂时无法读取，请重试。');
    const opening=changeWorkspace('shot',{requestOwner:owner}),shotOwner=workspaceOwner;await opening;
    if(!shotOwner.isCurrent()||workspacePage!=='shot'||closed||preview!==shotPreviewEpoch)return;
    showCapturePreview({...saved.batch,selection:{...source,kind:'selection',image,roi:source.roi||{...FULL}}},saved);
    $('shot-status').textContent='';
  }
  const cropSavePending=()=>savingImageCrop?.preview===shotPreviewEpoch&&savingImageCrop.cropId===imageCropId&&savingImageCrop.owner.isCurrent();
  async function saveImageCrop(){
    if(!imageCrop||!imageCropData||!shotBatch||cropSavePending())return !imageCrop;
    const batch=shotBatch,area={...imageCrop},image=imageCropData,owner=workspaceOwner,id=imageCropId||crypto.randomUUID();imageCropId=id;
    const task={owner,preview:shotPreviewEpoch,cropId:id},current=()=>!closed&&owner.isCurrent()&&task.preview===shotPreviewEpoch&&shotBatch===batch&&imageCropId===id&&imageCropData===image;
    const base=batch.selection.roi||FULL;
    const selection={...batch.selection,id,kind:'selection',label:'圈选',source:batch.selection.source||batch.selection.label||'全景',sourceBoardIds:batch.selection.sourceBoardIds||(batch.selection.boardId?[batch.selection.boardId]:[]),roi:{x:base.x+area.x*base.w,y:base.y+area.y*base.h,w:area.w*base.w,h:area.h*base.h},image};
    delete selection.ref;delete selection.asset;delete selection.snapshotId;delete selection.contextKey;const value={...batch,id,selection};delete value.contextKey;delete value.contextFor;
    savingImageCrop=task;$('shot-crop').disabled=true;$('shot-status').textContent='正在保存…';
    try{
      let original={layout:shotLayout,sourcePage:shotSourcePage};
      if(!original.layout){const pending=outbox.pending.find(job=>job.request.batch.id===batch.id);original=pending?.request||await owner.after(companion.library('capture',{id:batch.id}))}
      const job=outbox.pending.find(job=>job.request.batch.id===id)||outbox.add({batch:value,markId:batch.markId||'',markOnly:false,historical:true,layout:original.layout,sourcePage:original.sourcePage},{destination:'later'});
      task.job=job;
      const saved=await outbox.save(job,(...args)=>companion.library(...args));
      outbox.unstage(id);
      if(!current())return false;
      showCapturePreview(job.request.batch,job.request);$('shot-status').textContent='已保存';$('shot-status').title=saved.mark.title;
      return true;
    }catch(error){if(current())captureFailure(error,{saveJob:task.job});return false}
    finally{if(savingImageCrop===task)savingImageCrop=null;if(!closed&&!cropSavePending())$('shot-crop').disabled=false}
  }
  function drawImageCrop(point){
    if(!imageDrag||!imageCropView)return;
    if(!imageDragGeometryCurrent()){cancelImageDrag();return;}
    const rect=selectionRectangle(imageDrag,point,imageCropView.view,1);
    $('image-selection').hidden=!rect;
    if(rect){const v=imageCropView.view;Object.assign($('image-selection').style,{left:rect.x+'px',top:rect.y+'px',width:rect.w+'px',height:rect.h+'px',clipPath:`inset(${v.y-rect.y}px ${rect.x+rect.w-v.x-v.w}px ${rect.y+rect.h-v.y-v.h}px ${v.x-rect.x}px)`})}
  }
  function imageDragGeometryCurrent(){
    if(!imageDrag)return true;const image=$('shot-image'),box=image.getBoundingClientRect(),old=imageDrag.box;
    return !!old&&image.currentSrc===imageDrag.source&&['left','top','width','height'].every(key=>Math.abs(box[key]-old[key])<.5);
  }
  function renderImageCrop(){
    const image=$('shot-image');$('shot-crop').hidden=!imageCrop;
    if(workspacePage!=='shot'||!imageCrop||!image.complete||!image.naturalWidth){$('image-selection').hidden=true;return;}
    const box=image.getBoundingClientRect(),view=imagePlacement(image.naturalWidth,image.naturalHeight,box.width,box.height);if(!view)return;
    const rect={x:box.left+view.left+imageCrop.x*view.width,y:box.top+view.top+imageCrop.y*view.height,w:imageCrop.w*view.width,h:imageCrop.h*view.height};
    $('image-selection').hidden=false;Object.assign($('image-selection').style,{left:rect.x+'px',top:rect.y+'px',width:rect.w+'px',height:rect.h+'px',clipPath:'none'});
  }
  on($('shot-image'),'load',()=>{if(imageDrag)cancelImageDrag();renderImageCrop();});on($('shot-panel'),'scroll',()=>{if(imageDrag)cancelImageDrag();else renderImageCrop()});
  on($('shot-image'),'pointerdown',event=>{
    const image=$('shot-image');
    if(event.isPrimary===false||imageDrag&&imageDrag.id!==event.pointerId){cancelImageDrag();return;}
    if(event.button!==0||cropSavePending()&&!savingImageCrop.job||!shotImage||!image.complete||image.currentSrc!==shotImage||!image.naturalWidth)return;
    event.preventDefault();
    const box=image.getBoundingClientRect(),view=imagePlacement(image.naturalWidth,image.naturalHeight,box.width,box.height);
    if(!view)return;view.left+=box.left;view.top+=box.top;view.view.x+=box.left;view.view.y+=box.top;
    imageCropView=view;imageDrag={id:event.pointerId,x:event.clientX,y:event.clientY,box:{left:box.left,top:box.top,width:box.width,height:box.height},source:image.currentSrc};
    image.setPointerCapture(event.pointerId);$('shot-crop').hidden=true;drawImageCrop(imageDrag);
  });
  on($('shot-image'),'pointermove',event=>{if(imageDrag?.id===event.pointerId)drawImageCrop({x:event.clientX,y:event.clientY})});
  on($('shot-image'),'pointerup',event=>{
    if(imageDrag?.id!==event.pointerId||!imageCropView)return;
    if(!imageDragGeometryCurrent()){cancelImageDrag();return;}
    const rect=selectionRectangle(imageDrag,{x:event.clientX,y:event.clientY},imageCropView.view);imageDrag=null;
    if(!rect){renderImageCrop();return}
    imageCrop=captureRegion(rect,imageCropView);
    const image=$('shot-image');imageCropData=cropFrame({source:image,width:image.naturalWidth,height:image.naturalHeight},imageCrop);
    imageCropId=crypto.randomUUID();outbox.stage({id:imageCropId,lessonKey:shotBatch.lessonKey,sourceSnapshotId:shotBatch.id,sourceItemId:shotBatch.selection.id,area:imageCrop,image:imageCropData,preview:{batch:shotBatch,layout:shotLayout,sourcePage:shotSourcePage}});
    captureRecoveryJob=null;$('shot-retry').hidden=true;$('shot-launch').hidden=true;
    $('shot-save').href=imageCropData;$('shot-crop').hidden=false;$('shot-status').textContent='';
  });
  function cancelImageDrag(event){if(event&&imageDrag?.id!==event.pointerId)return;const pointer=imageDrag?.id;imageDrag=null;if(pointer!==undefined&&$('shot-image').hasPointerCapture(pointer))$('shot-image').releasePointerCapture(pointer);renderImageCrop();$('shot-save').href=imageCropData||shotImage;}
  on($('shot-image'),'pointercancel',cancelImageDrag);on($('shot-image'),'lostpointercapture',cancelImageDrag);
  on($('shot-crop'),'click',saveImageCrop);
  async function askFromShot({fresh=false}={}){
    if(!shotBatch||cropSavePending())return;
    const visibleDraft=companion.snapshot().chatDraftTarget?.draftId;if(askingShot?.batch===shotBatch&&askingShot.cropId===imageCropId&&askingShot.draftId===visibleDraft)return;
    const task={batch:shotBatch,cropId:imageCropId,draftId:visibleDraft,restoreIntent:{intentId:crypto.randomUUID(),intentAt:Date.now()}};askingShot=task;const owner=workspaceOwner;let operationOwner=owner;
    try{
      if(imageCrop&&!(await saveImageCrop()))return;if(!owner.isCurrent())return;
      let batch=shotBatch,preview=shotPreviewEpoch,cropId=imageCropId;task.batch=batch;task.cropId=cropId;
      const selectionCurrent=()=>askingShot===task&&shotBatch===batch&&shotPreviewEpoch===preview&&imageCropId===cropId;
      const isCurrent=()=>!closed&&selectionCurrent();
      const current=()=>{if(!isCurrent())throw new DOMException('Material selection changed','AbortError')};
      const pending=outbox.pending.find(job=>job.request.batch.id===batch.id);
      if(pending){await owner.after(outbox.save(pending,(...args)=>companion.library(...args)));current();showCapturePreview(pending.request.batch,pending.request);batch=shotBatch;preview=shotPreviewEpoch;cropId=imageCropId;task.batch=batch;task.cropId=cropId;}
      if(!batch.selection.ref)throw Error('请先保存这张截图。');
      const reference=shotReferenceKey(),scope=captureLesson(),ref=Object.freeze({...batch.selection.ref});current();
      const opening=openChat(),chatOwner=workspaceOwner;operationOwner=chatOwner;
      await chatOwner.after(opening);current();
      const target=await readyDraftTarget(chatOwner);current();
      if(visibleDraft&&target.draftId!==visibleDraft)throw Object.assign(Error('原问题已结束，原材料仍保留；可重新选取到新的提问。'),{code:'conversation_changed'});
      task.draftId=target.draftId;
      let action=!fresh&&shotPlanAction?.reference===reference&&shotPlanAction.target?.draftId===target.draftId?shotPlanAction:null;
      if(fresh&&shotPlanAction?.plan){const old=shotPlanAction,saved=await chatOwner.after(companion.library('plan-jobs',{scope:old.scope}));current();if(saved?.schema!==1||!Array.isArray(saved.jobs))throw Error('先前附图状态尚未读取，原记录已保留。');if(saved.jobs.some(job=>job.id===old.plan.id&&job.operationId===old.operationId)){await chatOwner.after(companion.library('plan-job-dismiss',{id:old.plan.id,scope:old.scope,operationId:old.operationId}));current();}}
      if(!action&&!fresh){const saved=await chatOwner.after(companion.library('plan-jobs',{scope}));current();if(saved?.schema!==1||!Array.isArray(saved.jobs))throw Error('先前附图状态尚未读取，原记录已保留。');const previous=saved.jobs.find(job=>job.choiceSnapshot?.directSelection?.reference===reference&&job.target?.draftId===target.draftId);if(previous){const stored=await chatOwner.after(companion.library('plan',{id:previous.id}));current();if(stored.plan?.id!==previous.id||stored.captureReceipt?.operationId!==previous.operationId)throw Error('先前附图材料未完整读取，原记录已保留。');action={reference,scope,target:previous.target,plan:stored.plan,operationId:previous.operationId,previous:previous.delivery||previous.plannedDelivery||null,persisted:true};}}
      if(!action){action={reference,scope,target,operationId:crypto.randomUUID(),restoreIntent:task.restoreIntent,plan:null,previous:null,persisted:false};}
      shotPlanAction=action;
      if(!action.plan){action.plan=await chatOwner.after(companion.library('compose',{refs:[ref],restoreRefs:[{...ref,...action.restoreIntent}],questions:[],background:true,questionImages:false,title:'板书提问'}));current();}
      await sendLibraryPlan(action.plan,'current',{requestOwner:chatOwner,isCurrent,selectionCurrent,target:action.target,operationId:action.operationId,previous:action.previous,directSelection:{reference},onDirectJob:delivery=>{action.previous=delivery;action.persisted=true;}});if(shotPlanAction===action&&isCurrent())shotPlanAction=null;
    }catch(error){if(!closed&&operationOwner.isCurrent()&&error.name!=='AbortError')host.dataset.captureDiagnostic=error.message;}finally{if(askingShot===task)askingShot=null;if(!closed)refreshStudy();}
  }
  on($('shot-ask'),'click',()=>askFromShot());
  function captureFailure(error,{saveJob=null}={}){
    if(closed)return;const needsConnection=['companion_upgrade','companion_unavailable','upgrade_required'].includes(error.code)||error.action==='launch';
    captureRecoveryJob=saveJob&&outbox.pending.includes(saveJob)?{job:saveJob,preview:shotPreviewEpoch,cropId:saveJob.request.historical?imageCropId:null}:null;
    $('shot-status').textContent=error.message|| (pendingCaptures().length?'截图未保存':'截图未附入提问');$('shot-status').title=error.message;
    $('shot-retry').hidden=true;$('shot-retry').textContent=pendingCaptures().length?'保存':recoveryError?'重试读取':'附图';
    $('shot-last').hidden=false;
    $('shot-launch').hidden=true;$('shot-launch').textContent=pendingCaptures().length?'连接并保存':'连接并附图';
    if(workspacePage==='shot'){clearTimeout(shotTimer)}else recordCaptureStatus(pendingCaptures().length?'截图未保存':'截图未附入提问',{persistent:true});
  }
  async function showPendingCapture({open=true}={}){
    const job=pendingCaptures()[0];if(!job)return;const owner=workspaceOwner,preview=shotPreviewEpoch;
    try{const batch=await owner.after(outbox.loadPending(job));if(closed||!owner.isCurrent()||preview!==shotPreviewEpoch)return;showCapturePreview(batch,job.request);$('shot-status').textContent='未保存';$('shot-retry').textContent='保存';$('shot-retry').hidden=!$('shot-launch').hidden;
      if(open)void changeWorkspace('shot');else{recordCaptureStatus('未保存');$('shot-last').hidden=false}
    }catch(error){if(!closed&&owner.isCurrent()&&error.name!=='AbortError')captureFailure(error);}
  }
  async function recoverCaptures({strict=false}={}){
    const lesson=key||(captureCourseInfo().course+':'+role),owner=intents.begin('library-recovery');
    try{
      await localCaptureReady;const jobs=await outbox.recover((...args)=>companion.library(...args),lesson);
      if(closed||!owner.isCurrent())return;recoveryError=null;$('shot-last').innerHTML=toolbarIcon('library');
      if(!jobs.length){if(strict&&!queuedCaptures().length)$('shot-status').textContent='暂无待附图。';return;}
      if(!shotImage)$('shot-image').hidden=true;$('shot-last').hidden=false;$('shot-retry').hidden=false;
      $('shot-last').innerHTML=toolbarIcon('library');
      $('shot-status').textContent='待附图';$('shot-retry').textContent='附图';
      recordCaptureStatus('待附图');
    }catch(error){
      if(owner.isCurrent()&&!closed){recoveryError=error;$('shot-last').hidden=false;$('shot-last').innerHTML=toolbarIcon('library');$('shot-status').textContent='暂时无法读取待附图。'+error.message;$('shot-status').title=error.message;
        if(!shotImage)$('shot-image').hidden=true;$('shot-launch').hidden=error.action!=='launch'&&!['companion_upgrade','companion_unavailable'].includes(error.code);
        $('shot-launch').textContent='连接';$('shot-retry').hidden=!$('shot-launch').hidden;$('shot-retry').textContent='重试读取';
      }
      if(strict)throw error;
    }
  }
  async function retryCaptures({explicit=true,captureJob=recoveryCapture()}={}){
    if(retryingSaves||captureWorking||closed)return;const owner=workspaceOwner,recoveryPreview=shotPreviewEpoch,recoveryCrop=imageCropId,recoveryImage=imageCropData,recoveryBatch=shotBatch,currentRecovery=()=>!captureJob||recoveryPreview===shotPreviewEpoch&&recoveryCrop===imageCropId&&recoveryImage===imageCropData&&recoveryBatch===shotBatch;retryingSaves=true;$('shot-retry').hidden=true;
    try{
      await localCaptureReady;if(closed||!owner.isCurrent())return;
      if(localRecoveryError){try{await owner.after(outbox.restoreLocal(captureLesson()));localRecoveryError=null;restoreCapturePreview();}catch(error){if(error.name==='AbortError')throw error;localRecoveryError=error;}}
      if(recoveryError){await recoverCaptures({strict:true});if(closed||!owner.isCurrent())return;}
      for(const job of captureJob?[captureJob]:pendingCaptures()){
        await owner.after(outbox.loadPending(job));
        if(job.request.acquisition&&!job.nativeIssued&&studyLessonScope(job.request.batch.lessonKey)===captureLesson()){
          const acquisition=job.request.acquisition,batch=job.request.batch;
          try{
            if(acquisition.source!==await owner.after(sourceFrameIdentity(video.currentSrc)))throw Error('课程视频来源已变化，原圈选已保留。');
            const source=requestSourceFrame({source:video.currentSrc},acquisition.time,owner);let frame;
            try{frame=await owner.after(source.promise);}finally{source.controller.abort();}
            if(Math.abs(frame.width/frame.height-acquisition.width/acquisition.height)>.002)throw Error('原始帧与保存的课程画面比例不一致。');
            if(acquisition.exact&&Math.abs(frame.time-acquisition.time)>.000002)throw Error('原始帧与保存的圈选时刻不一致，原圈选已保留。');
            const complete=frameBundle(frame,{selection:batch.selection.roi,boards:job.request.layout.boards,active:job.request.layout.active,time:frame.time,course:batch.course,lessonKey:batch.lessonKey,id:batch.id});
            outbox.finishAcquisition(job,complete,{destination:acquisition.destination});
          }catch(error){if(error.name==='AbortError'||!owner.isCurrent())throw error;}
        }
        const saved=await outbox.save(job,(...args)=>companion.library(...args));outbox.enqueueDelivery(job);if(closed||!owner.isCurrent())return;
        outbox.unstage(job.request.batch.id);
        if(!currentRecovery())return;
        if(!job.request.historical&&Math.abs(video.currentTime-job.request.batch.time)<.15&&job.previousMarkId===(currentMark?.id||'')&&(!currentMarkTask||[job.request.batch.id,job.request.markSourceSnapshotId].includes(currentMarkTask.snapshotId))&&boardSignature(boards)===boardSignature(job.request.layout.boards)&&studyLessonScope(saved.mark.lessonKey)===captureLesson()){currentMark=saved.mark;currentMarkBoards=boardSignature(job.request.layout.boards);currentMarkTask=null;}
        if(explicit||!shotImage||shotBatch?.id===job.request.batch.id)showCapturePreview(job.request.batch,job.request);outbox.enqueueDelivery(job);$('shot-status').textContent=job.request.batch.contextComplete===false?'已保存 · 背景不完整':'已保存';$('shot-status').title=saved.mark.title;
      }
      $('shot-launch').hidden=true;if(!captureJob)await transferCaptures({explicit,requestOwner:owner});if(localRecoveryError&&explicit)captureFailure(Error('部分截图暂存尚未读取，原记录仍保留。'));
    }catch(error){if(owner.isCurrent()&&currentRecovery())captureFailure(error,{saveJob:captureJob})}finally{retryingSaves=false}
  }
  async function finishCapture(rect,{markOnly=false}={}){
    if(captureWorking||!captureView)return;
    const view=captureView,ticket=++captureEpoch,owner=intents.observe('capture'),task=captureTask||study.begin('capture',{owner}),transaction={ticket,owner,workspace:intents.observe('workspace'),positionEpoch:mediaPositionEpoch,controller:new AbortController(),task,pauseTask:null,resume:true,native:false,frozen:false,restoring:false,frame:null,time:video.currentTime};
    captureTask=task;
    captureTransaction=transaction;
    const presented=captureClock.read();let time=presented?.time??video.currentTime;
    const courseInfo=captureCourseInfo(),capturedLesson=captureLesson();let selectedTarget=null,destination=captureDestination;
    const savedLayout={...pack(),view:{...snapshot(),mode:peek?'overview':mode}};
    const layoutProof=identifyMedia(view.source).catch(error=>{if(!markOnly)throw error;transaction.contextError=error.message;return null;});
    const captureBoards=boards.map(cloneBoard),captureActive=active,selectionArea=captureRegion(rect,view);
    const captureMark=studyLessonScope(currentMark?.lessonKey)===capturedLesson&&currentMarkBoards===boardSignature(savedLayout.boards)?currentMark:null;
    const markSource=!markOnly&&!captureMark&&currentMarkTask&&currentMarkTask.lessonKey===capturedLesson&&currentMarkTask.boards===boardSignature(savedLayout.boards)&&currentMarkTask.positionEpoch===mediaPositionEpoch?currentMarkTask.snapshotId:null;
    const pageUrl=new URL(location.href),safePage=new URL(pageUrl.origin+pageUrl.pathname),hashRoute=pageUrl.hash.split('?')[0],hashParams=new URLSearchParams(pageUrl.hash.split('?')[1]||'');
    const sourceParams=new URLSearchParams();for(const name of ['course_id','sub_id','tenant_code']){const value=pageUrl.searchParams.get(name)||hashParams.get(name);if(/^\d{1,12}$/.test(value||''))sourceParams.set(name,value);}
    if(/^#\/[a-zA-Z0-9/_-]*$/.test(hashRoute))safePage.hash=hashRoute+(sourceParams.size?'?'+sourceParams:'');else safePage.search=sourceParams.toString();
    const captureRequest=value=>({batch:value,markId:!markOnly&&captureMark?captureMark.id:'',...markSource?{markSourceSnapshotId:markSource}:{},markOnly,layout:savedLayout,sourcePage:safePage.href});
    const reserveMark=job=>{if(!closed&&owner.isCurrent()&&capturedLesson===captureLesson()&&(markOnly||!captureMark&&!markSource)){currentMark=null;currentMarkTask={snapshotId:job.request.batch.id,lessonKey:capturedLesson,boards:boardSignature(savedLayout.boards),positionEpoch:transaction.positionEpoch};currentMarkBoards=currentMarkTask.boards;}};
    const releaseCaptureUI=()=>{
      if(captureTransaction!==transaction||!transaction.frozen)return;
      captureTransaction=null;captureWorking=false;captureView=null;
      if(captureSourceTask?.owner===owner)captureSourceTask=null;
      if(!closed){$('capture').disabled=false;$('mark').disabled=false;}
    };
    captureSelecting=false;captureWorking=true;captureDrag=null;$('capture').disabled=true;$('mark').disabled=true;
    $('capture-layer').hidden=true;$('capture-tools').hidden=true;$('capture-rect').hidden=true;
    const check=(expected=view)=>{
      if(closed||transaction.controller.signal.aborted)throw new DOMException('Cancelled','AbortError');
      if(transaction.frozen)return;
      if(captureTransaction!==transaction||ticket!==captureEpoch||!owner.isCurrent()||identity()!==key)throw new DOMException('Cancelled','AbortError');
      if(video!==view.element||!video.isConnected||disconnected||video.error||video.readyState<2||video.seeking||video.currentSrc!==view.source||video.videoWidth!==view.sourceWidth||video.videoHeight!==view.sourceHeight||video.playbackRate!==view.rate)throw Error('课程画面已变化，请等画面稳定后重新截图。');
      const viewport=[innerWidth,innerHeight,viewportArea().aside,viewportArea().height,window.devicePixelRatio||1],visual=visualArea();
      if(viewport.some((n,i)=>Math.abs(n-view.viewport[i])>.01)||Object.keys(visual).some(key=>Math.abs(visual[key]-view.visual[key])>.01)||!sameCaptureLayout(expected))throw Error('画面位置已变化，请重新框选。');
      if(transaction.native&&!transaction.frozen){
        const frame=captureClock.read();
        if(!video.paused||Math.abs(video.currentTime-transaction.time)>.000001||(transaction.frame&&(!frame||frame.frame!==transaction.frame.frame||frame.time!==transaction.frame.time)))throw Error('视频时间已变化，请重新截图。');
      }
    };
    const batch=(async()=>{
      render();check();let frame,nativeImages=null;
      try{frame=captureFrame(video)}catch(error){
        if(error.name!=='SecurityError'&&error.code!=='capture_image_budget')throw error;
        let sourceTask=captureSourceTask?.owner.isCurrent()&&captureSourceTask.source===view.source?captureSourceTask:requestSourceFrame(view,time,owner);captureSourceTask=sourceTask;
        if(Math.abs(sourceTask.time-time)>.000002){sourceTask.controller.abort();sourceTask=captureSourceTask=requestSourceFrame(view,time,owner);}
        const sourceBundle=frame=>{if(Math.abs(frame.width/frame.height-view.sourceWidth/view.sourceHeight)>.002)throw Error('原始帧与课程画面比例不一致。');if((presented||transaction.frame)&&Math.abs(frame.time-time)>.000002)throw Error('原始帧与圈选时刻不一致，原圈选已保留。');return frameBundle(frame,{selection:selectionArea,boards:captureBoards,active:captureActive,time:frame.time,course:courseInfo,lessonKey:capturedLesson,id:transaction.partialJob?.request.batch.id});};
        if(sourceTask.frame){
          check();let complete=null;try{complete=sourceBundle(sourceTask.frame);}catch(sourceError){transaction.contextError=sourceError.message;}
          if(complete){transaction.frozen=true;captureSourceTask=null;sourceTask.controller.abort();return complete;}
        }
        transaction.native=true;nativeImages={selection:'',panorama:'',boards:{}};captureOverlayHidden=true;hideControls(true);hint.classList.add('quiet');selection.style.display='none';
        const chrome=[dock,hint],styles=chrome.map(node=>['visibility','opacity','transition'].map(name=>[name,node.style.getPropertyValue(name),node.style.getPropertyPriority(name)]));
        for(const node of chrome){node.style.setProperty('visibility','hidden','important');node.style.setProperty('opacity','0','important');node.style.setProperty('transition','none','important')}
        transaction.pauseTask=study.begin('capture-frame',{owner});transaction.pauseTask.pause(automaticPause);transaction.time=video.currentTime;
        let chromeRestored=false;
        transaction.restoreChrome=()=>{
          if(chromeRestored)return;chromeRestored=true;transaction.restoring=true;
          if(captureTransaction===transaction){captureOverlayHidden=false;capturePaintActive=false;$('capture-paint').hidden=true;chrome.forEach((node,i)=>styles[i].forEach(([name,value,priority])=>value?node.style.setProperty(name,value,priority):node.style.removeProperty(name)));if(!closed)render()}
          study.end(transaction.pauseTask,{resume:transaction.resume}).restorePlayback(automaticPlay);
        };
        try{
          if(!companionState.connected)await owner.after(companion.connect());check();
          const settled=async expected=>{
            await owner.after(new Promise(resolve=>{const timer=setTimeout(resolve,150);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve()}))}));
            check(expected);
          };
          // The marker is outside the video crop. The native reader waits for
          // this exact compositor state, rather than treating rAF as screen proof.
          $('regions').hidden=true;let paint=capturePaintProof(rect);
          if(!paint){capturePaintActive=true;render();paint=capturePaintProof();}
          let expected=captureLayout();await settled(expected);transaction.frame=captureClock.read();time=transaction.frame?.time??transaction.time;
          if(Math.abs(sourceTask.time-time)>.000002){sourceTask.controller.abort();sourceTask=captureSourceTask=requestSourceFrame(view,time,owner);}
          const selectedRect=capturePaintActive?{x:expected.left+selectionArea.x*expected.width,y:expected.top+selectionArea.y*expected.height,w:selectionArea.w*expected.width,h:selectionArea.h*expected.height}:rect;
          const selected=await companion.capture(selectedRect,{signal:transaction.controller.signal,paint});check(expected);nativeImages.selection=selected.image;
          if(markOnly){if(savedLayout.view.mode==='focus'&&captureActive){const board=captureBoards.find(value=>value.id===captureActive);if(board&&['x','y','w','h'].every(key=>Math.abs(board.roi[key]-selectionArea[key])<.000001))nativeImages.boards[captureActive]=selected.image;}else nativeImages.panorama=selected.image;}
          // If original-frame access fails, preserve the verified visible crop.
          // Never cycle the user's viewport through overview and every board.
          // A full visible panorama can still supply all board crops safely.
          if(nativeImages.panorama){frame=await owner.after(imageFrame(nativeImages.panorama));check(expected);for(const board of captureBoards)nativeImages.boards[board.id]=cropFrame(frame,board.roi);}
          transaction.frozen=true;
        }catch(error){
          // A failed background request must not discard a crop whose source
          // and viewport were already verified. Explicit cancellation still wins.
          if(error.name==='AbortError'||!owner.isCurrent()||transaction.controller.signal.aborted)throw error;
          if(!nativeImages.selection){
            // The original-frame decoder is independent of native window
            // binding. Let it finish instead of discarding a valid capture
            // just because the screen fallback could not find the window.
            transaction.restoreChrome();transaction.native=false;
            const original=await owner.after(sourceTask.promise);check();
            const complete=sourceBundle(original);transaction.frozen=true;return complete;
          }
          transaction.frozen=true;transaction.contextError=error.message;
        }finally{
          transaction.restoreChrome();
        }
        check();const partial=frameBundle(frame,{selection:selectionArea,boards:captureBoards,active:captureActive,time,course:courseInfo,lessonKey:capturedLesson,images:nativeImages});
        savedLayout.mediaIdentity=await owner.after(layoutProof);
        selectedTarget=await owner.after(view.targetReady||Promise.resolve(null));
        transaction.partialJob=outbox.add({...captureRequest(partial),acquisition:{time:sourceTask.time,exact:!!(presented||transaction.frame),source:await owner.after(sourceTask.identity),width:view.sourceWidth,height:view.sourceHeight,destination:markOnly?'later':destination,...!markOnly?{contextId:crypto.randomUUID(),contextOperationId:crypto.randomUUID()}:{}}},{destination:markOnly?'later':destination,target:selectedTarget});
        transaction.partialJob.requiresReview=!!view.needsTargetReview;
        reserveMark(transaction.partialJob);
        if(!markOnly){showCapturePreview(partial,transaction.partialJob.request);$('shot-status').textContent='正在准备背景…';}
        study.end(task).restorePlayback(automaticPlay);if(captureTask===task)captureTask=null;
        releaseCaptureUI();
        try{
          frame=await sourceTask.promise;check();const complete=sourceBundle(frame);
          outbox.finishAcquisition(transaction.partialJob,complete,{destination:markOnly?'later':destination});return complete;
        }catch(sourceError){if(sourceError.name==='AbortError'||transaction.controller.signal.aborted||closed)throw sourceError;transaction.contextError=sourceError.message;return transaction.partialJob.request.batch;}
        finally{sourceTask.controller.abort();if(captureSourceTask===sourceTask)captureSourceTask=null;}
      }
      check();transaction.frozen=true;return frameBundle(frame,{selection:selectionArea,boards:captureBoards,active:captureActive,time,course:courseInfo,lessonKey:capturedLesson,images:nativeImages});
    })().catch(error=>{
      if(!markOnly||closed||error.name==='AbortError'||!owner.isCurrent()||transaction.controller.signal.aborted)throw error;
      transaction.contextError=error.message;transaction.frozen=true;
      return {id:crypto.randomUUID(),lessonKey:capturedLesson,course:{...courseInfo},time,context:[],selection:null,contextComplete:false,missingContext:[{kind:'panorama',label:'全景'},...captureBoards.map(board=>({kind:'board',boardId:board.id,label:board.name}))]};
    });
    if(!markOnly)void copyBoard(batch.then(value=>value.selection.image)).catch(()=>{});
    let readyBatch=null,recordSaved=false,saveJob=null;
    try{
      readyBatch=await batch;check();if(transaction.partialJob?.localPixels)readyBatch=await outbox.loadPending(transaction.partialJob);
      // Pixel acquisition owns the temporary pause. Storage and clipboard
      // latency do not keep a playing lesson frozen after its frame is safe.
      study.end(task).restorePlayback(automaticPlay);if(captureTask===task)captureTask=null;
      savedLayout.mediaIdentity=await layoutProof;
      selectedTarget=await (view.targetReady||Promise.resolve(null));
      if(owner.isCurrent()&&!markOnly)showCapturePreview(readyBatch,{layout:savedLayout});
      if(owner.isCurrent())shotSourcePage=safePage.href;saveJob=transaction.partialJob||outbox.add(captureRequest(readyBatch),{destination:markOnly?'later':destination,target:selectedTarget});
      saveJob.requiresReview=!!view.needsTargetReview;
      saveJob.previousMarkId??=currentMark?.id||'';
      if(!transaction.partialJob)reserveMark(saveJob);
      releaseCaptureUI();
      const saved=await outbox.save(saveJob,(...args)=>companion.library(...args));
      outbox.enqueueDelivery(saveJob);
      recordSaved=true;
      if(!closed&&!markOnly&&owner.isCurrent()&&transaction.workspace.isCurrent()&&capturedLesson===captureLesson()){const value=saveJob.request.batch;momentShelf.add({id:value.id,time:value.time,image:value.selection.thumbnail||value.selection.image,ref:value.selection.ref});}
      if(!closed&&currentMarkTask?.snapshotId===readyBatch.id&&currentMarkTask.positionEpoch===mediaPositionEpoch&&currentMarkTask.boards===boardSignature(boards)&&studyLessonScope(saved.mark.lessonKey)===captureLesson()){currentMark=saved.mark;currentMarkBoards=currentMarkTask.boards;currentMarkTask=null;}
      if(closed||!transaction.workspace.isCurrent()){const queued=captureQueue.find(job=>(job.id||job.batch?.id)===readyBatch.id);if(queued)queued.requiresReview=true;return;}
      if(!owner.isCurrent())return;
      check();
      if(transaction.positionEpoch===mediaPositionEpoch){currentMark=saved.mark;currentMarkBoards=boardSignature(savedLayout.boards);}recordSaved=true;readyBatch=saveJob.request.batch;if(!markOnly){shotBatch=readyBatch;updateShotSource()}
      $('shot-status').textContent='';$('shot-launch').hidden=true;
      check();
      const incomplete=readyBatch.contextComplete===false;
      $('shot-status').textContent=incomplete?'截图已保存。'+(transaction.contextError||'背景不完整。'):'已保存';$('shot-status').title=saved.mark.title;
      if(saveJob.requiresReview){$('shot-retry').hidden=false;$('shot-retry').textContent='附图';}
      if(markOnly){$('mark').dataset.saved='true';clearTimeout(markFlashTimer);markFlashTimer=setTimeout(()=>{$('mark').dataset.saved='false'},1200);if(incomplete)host.dataset.captureDiagnostic=transaction.contextError||'标记已保存，原时刻图片未取得';}
      else recordCaptureStatus(incomplete?saved.mark.title+' 已保存 · 背景不完整':destination==='later'?'已存到 '+saved.mark.title:saveJob.requiresReview?'截图已保存 · 请确认目标对话':'已保存',{persistent:incomplete||saveJob.requiresReview,...markOnly?{action:'library',actionLabel:'查看资料',markId:saved.mark.id}:{}});
      if(markOnly&&workspacePage==='library')void libraryUI.revealMark(saved.mark.id);
    }catch(error){if(!closed&&owner.isCurrent()&&error.name!=='AbortError'){if(saveJob){if(shotBatch?.id===saveJob.request.batch.id)captureFailure(error,{saveJob});}else tell(error.message);}}
    finally{study.end(task).restorePlayback(automaticPlay);if(captureTask===task)captureTask=null;if(captureSourceTask?.owner===owner){captureSourceTask.controller.abort();captureSourceTask=null;}if(captureTransaction===transaction){captureTransaction=null;captureWorking=false;captureView=null;if(!closed){$('capture').disabled=false;$('mark').disabled=false;}}if(!closed&&recordSaved&&transaction.workspace.isCurrent()&&queuedCaptures().length)void transferCaptures({requestOwner:transaction.workspace});}
  }
  on($('mark'),'click',async()=>{
    if(captureWorking||!layout||video.readyState<2||video.seeking)return;
    if(identity()!==key){tell('课程正在切换，画面就绪后再标记。');return;}
    if(localPanel(menu)&&!await closeMenu())return;if(captureWorking)return;
    if(editing)cancelEdit({keepWorkspace:true});cancelCapture();const owner=intents.begin('capture');captureTask=study.begin('capture',{owner});if(study.snapshot().protectionWanted)captureTask.pause(automaticPause);
    try{await owner.after(queueProtection(false));render();captureView=captureLayout();refreshLists();hideControls(true);await finishCapture({...layout.view},{markOnly:true})}
    catch(error){if(owner.isCurrent()){cancelCapture();if(error.name!=='AbortError')tell(error.message)}}
  });
  on($('library'),'click',()=>{if(editing)cancelEdit({keepWorkspace:true});void changeWorkspace(workspacePage==='library'?'closed':'library')});
  async function restoreLibraryMark(mark,saved,item,{intent,isCurrent=()=>true}={}){
    if(closed||!isCurrent())throw new DOMException('Library location cancelled','AbortError');
    for(const owner of Object.values(intent||{}))owner?.assertCurrent();
    const lesson=key||(captureCourseInfo().course+':'+role);
    if(!video.isConnected||disconnected||video.error)throw Error('请先重新连接原课程视频，再恢复标记。');
    const restoredSource=video.currentSrc,restoredKey=key,mediaIdentity=await identifyMedia(restoredSource);
    for(const owner of Object.values(intent||{}))owner?.assertCurrent();
    if(closed||!isCurrent()||video.currentSrc!==restoredSource||key!==restoredKey)throw new DOMException('Course changed','AbortError');
    const restored=resolveLibraryRestore({lessonKey:lesson,dimensions:[video.videoWidth,video.videoHeight],duration:video.duration,mediaIdentity,mark,snapshot:saved,item}),ticket=++restoreEpoch;
    cancelCapture();notePlaybackIntent();noteViewIntent();clearTimeout(restoreTimer);selection.style.display='none';
    finishPan();returnView=null;lastView=null;replayReturn=null;peek=null;editOrigin=null;editing=null;scrubbing=false;
    boards=restored.layout.boards.map(cloneBoard);({active,mode,roi}=restored.view);if(mode==='focus'){updateCurrent();returnView=snapshot();}reviewPending=false;
    let viewOwner,playbackOwner,workspaceAtRestore;
    const draw=()=>{if(closed||!viewOwner?.isCurrent()||!playbackOwner?.isCurrent()||!workspaceAtRestore?.isCurrent()||key!==restoredKey||identity()!==restoredKey||video.currentSrc!==restoredSource||!video.isConnected||video.error||editing||drag||mode!==restored.view.mode||active!==restored.view.active||['x','y','w','h'].some(k=>roi[k]!==restored.view.roi[k])||video.seeking||Math.abs(video.currentTime-restored.time)>.15)return;render();if(!restored.highlight||!layout)return;const r=restored.highlight;Object.assign(selection.style,{display:'block',left:(layout.left+r.x*layout.width)+'px',top:(layout.top+r.y*layout.height)+'px',width:r.w*layout.width+'px',height:r.h*layout.height+'px'});restoreTimer=setTimeout(()=>{if(!closed&&viewOwner.isCurrent()&&!editing&&!drag)selection.style.display='none'},5000)};
    on(video,'seeked',draw,{once:true});seek(restored.time);currentMark=mark;currentMarkBoards=boardSignature(boards);if(!video.seeking)requestAnimationFrame(draw);
    viewOwner=intents.observe('view');playbackOwner=intents.observe('playback');workspaceAtRestore=workspaceOwner;save();render();refreshLists();sync();tell('已恢复 '+mark.title+' · '+fmt(restored.time));
  }
  async function readyDraftTarget(owner=workspaceOwner){
    await owner.after(companion.requireDraftSupport());
    const deadline=Date.now()+18000;
    while(!closed){await owner.after(companion.refresh());const state=companion.snapshot();if(workspacePage!=='chat'||state.workspaceRevision!==workspaceRevision)throw new DOMException('Question workspace changed','AbortError');if(state.chatDraftReady&&state.chatDraftTarget)return {...captureTarget(state.chatDraftTarget),...state.chatDraftTarget.draftId?{draftId:state.chatDraftTarget.draftId}:{}};if(state.chatDraftError)throw Error(state.chatDraftError);if(Date.now()>deadline)throw Error('ChatGPT 输入框尚未就绪，请完成登录后重试；所选材料已保留。');await owner.after(new Promise(r=>setTimeout(r,250)))}
    throw new DOMException('Cancelled','AbortError');
  }
  const unknownCapture=cause=>Object.assign(Error(cause?.message||'附图结果尚未确认。材料已保存在资料库，请查看 ChatGPT 后重试。'),{code:'delivery_unconfirmed',uncertain:true,cause});
  function durableCaptureCompletion(value,delivery){
    if(value?.id!==delivery.materialId||value.operationId!==delivery.operationId)throw Object.assign(Error('收到的附图回执不属于本次操作；材料已保留，请检查目标对话后重试。'),{code:'delivery_mismatch'});
    if(value.completed!==true)return null;
    if(!['attached','already-sent','removed','retained-draft'].includes(value.outcome))throw unknownCapture();
    return Object.freeze({durable:true,completed:true,id:value.id,operationId:value.operationId,outcome:value.outcome,...value.questionId?{questionId:value.questionId}:{}});
  }
  async function readCaptureCompletion(delivery){
    const value=await companion.settleCapture(delivery),completed=durableCaptureCompletion(value,delivery);
    if(completed)return completed;
    if(value.dismissed===true)throw Object.assign(Error('这批材料的附图任务已结束，勾选和原图仍保留。'),{code:'capture_dismissed'});
    return null;
  }
  const captureSettlementLibrary=(action,data)=>action==='capture-ack'?companion.settleCapture({materialId:data.id,operationId:data.operationId,attemptId:data.attemptId,target:data.target},data.receipt):action==='capture-reconcile'?companion.settleCapture({materialId:data.id,operationId:data.operationId}):companion.library(action,data);
  async function acknowledgeCapture(delivery,receipt){
    if(captureReceipt(receipt,delivery)!=='complete')throw unknownCapture();
    const saved=await companion.settleCapture(delivery,receipt);
    if(saved?.id!==delivery.materialId)throw Object.assign(Error('收到的附图回执不属于本次操作；材料已保留，请检查目标对话后重试。'),{code:'delivery_mismatch'});
    if(saved.completed===true){
      if(!saved.outcome||saved.outcome===receipt.state)return receipt;
      return durableCaptureCompletion({...saved,operationId:delivery.operationId},delivery);
    }
    const completed=await readCaptureCompletion(delivery);if(completed)return completed;throw unknownCapture();
  }
  async function settleOriginalCapture(delivery,{status,timeoutMs=90000,onProgress=()=>{}}={}){
    const deadline=Date.now()+timeoutMs;
    for(;;){
      if(status===undefined){
        try{status=await companion.captureDraftStatus(delivery.attemptId);}
        catch(error){const completed=await readCaptureCompletion(delivery);if(completed)return completed;throw unknownCapture(error);}
      }
      if(status?.attemptId!==delivery.attemptId)throw Object.assign(Error('收到的附图回执不属于本次操作；材料已保留，请检查目标对话后重试。'),{code:'delivery_mismatch'});
      if(status.state==='unknown'&&!status.materialId)return readCaptureCompletion(delivery);
      let phase;
      try{phase=captureReceipt(status,delivery);}
      catch(error){if(error.code==='delivery_mismatch')throw error;return readCaptureCompletion(delivery);}
      if(phase==='complete'){
        const completed=await acknowledgeCapture(delivery,status);try{onProgress(status);}catch(error){console.debug('[智云聚焦]',error.message);}return completed;
      }
      try{onProgress(status);}catch(error){console.debug('[智云聚焦]',error.message);}
      if(Date.now()>=deadline){const completed=await readCaptureCompletion(delivery);if(completed)return completed;throw unknownCapture();}
      await new Promise(resolve=>setTimeout(resolve,Math.min(350,Math.max(1,deadline-Date.now()))));status=undefined;
    }
  }
  async function postCapture(delivery,post,{onProgress=()=>{},posted=()=>true}={}){
    let status;
    try{status=await post();}
    catch(error){
      if(!posted())throw error;
      try{const completed=await settleOriginalCapture(delivery,{onProgress});if(completed)return completed;}catch(readError){console.debug('[智云聚焦]',readError.message);}
      throw unknownCapture(error);
    }
    const completed=await settleOriginalCapture(delivery,{status,onProgress});if(completed)return completed;throw unknownCapture();
  }
  async function sendLibraryPlan(plan,target,choice={}){
    choice.requestOwner?.assertCurrent();
    const choiceActive=()=>!choice.isCurrent||choice.isCurrent(),selectionCurrent=()=>choice.selectionCurrent?choice.selectionCurrent():choiceActive();
    const choiceCurrent=()=>{if(!choiceActive())throw new DOMException('Material selection changed','AbortError')};
    choiceCurrent();
    if(target==='current'&&!choice.target&&!choice.previous)throw Error('请先打开要加入的 ChatGPT 草稿，再重试。');
    $('shot-toast').hidden=true;clearTimeout(shotTimer);
    const direct=!choice.onSubmission,scope=captureLesson(),originalOperation=choice.previous?.operationId||choice.operationId;
    let owner=workspaceOwner,delivery=null,recordedPlan=originalOperation?{id:plan.id,operationId:originalOperation}:null,posting=false,preflightAttempt='';
    const retireDirect=async result=>{if(direct){const retired=await companion.settlePlan(plan.id,scope,delivery.operationId);if(retired?.retired!==true||retired.id!==plan.id)throw unknownCapture();}return result;};
    try{
      if(choice.previous?.attemptId){
        delivery=choice.previous;const completed=await settleOriginalCapture(delivery,{onProgress:choice.onProgress});preflightAttempt=delivery.attemptId;
        if(completed)return retireDirect(completed);
      }
      choice.requestOwner?.assertCurrent();choiceCurrent();
      const opening=openChat({requestOwner:choice.requestOwner});owner=workspaceOwner;
      const current=()=>{owner.assertCurrent();choiceCurrent()},captureOptions={signal:owner.signal,isCurrent:()=>owner.isCurrent()&&choiceActive(),onPost:()=>{posting=true;}};
      await owner.after(opening);current();if(!companion.snapshot().chatOpen)throw Error(workspaceError?.message||'请先展开 ChatGPT。');
      let draftTarget=await readyDraftTarget(owner);current();
      if(choice.previous?.target?.conversationId.startsWith('c:')&&choice.previous.target.conversationId!==draftTarget.conversationId){await owner.after(companion.navigateChat('https://chatgpt.com'+choice.previous.target.route,captureOptions));draftTarget=await readyDraftTarget(owner);current();}
      if(target==='new'&&!choice.previous){await owner.after(companion.navigateChat('new',captureOptions));draftTarget=await readyDraftTarget(owner);current();}
      const reconciling=choice.previous&&(choice.previous.reconcileOnly||choice.previous.target.conversationId.startsWith('provisional:')&&draftTarget.conversationId.startsWith('c:'));
      if(!reconciling&&choice.target?.draftId&&draftTarget.draftId&&choice.target.draftId!==draftTarget.draftId)throw Object.assign(Error('原问题已结束，原材料仍保留；可重新选取到新的提问。'),{code:'conversation_changed'});
      let destination=target==='current'&&!choice.previous?choice.target:draftTarget;
      const live=companion.snapshot().chatDraftTarget;
      if(destination&&destination.composerGeneration!==draftTarget.composerGeneration&&destination.draftId&&destination.draftId===live?.draftId&&['conversationId','route','pageId','documentEpoch','routeGeneration'].every(key=>destination[key]===draftTarget[key]))destination=draftTarget;
      let directSignature='';
      if(direct){
        const identity=destination?.draftId?{conversationId:destination.conversationId,draftId:destination.draftId}:destination,reference=value=>[value?.markId||'',value?.snapshotId||'',value?.itemId||value?.id||''];
        directSignature=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({direct:true,refs:(plan.refs||[]).map(reference),restoreRefs:(plan.restoreRefs||[]).map(item=>[reference(item),item.intentId,item.intentAt]),logical:plan.logicalItems.map(item=>reference(item.ref)),background:plan.background,target:identity,destination:target}))))].map(value=>value.toString(16).padStart(2,'0')).join('');
        current();const saved=await owner.after(companion.library('plan-jobs',{scope}));current();if(saved?.schema!==1||!Array.isArray(saved.jobs))throw Error('先前附图状态尚未读取，原图已保留，请稍后重试。');
        const prior=saved.jobs.find(job=>job.signature===directSignature);
        if(prior){recordedPlan={id:prior.id,operationId:prior.operationId};const original=await owner.after(companion.library('plan',{id:prior.id}));current();if(original.plan?.id!==prior.id||original.captureReceipt?.operationId!==prior.operationId)throw Error('先前材料尚未完整读取，原记录已保留。');plan=original.plan;choice={...choice,target:prior.target||choice.target,previous:original.captureReceipt.delivery||original.captureReceipt.plannedDelivery||prior.delivery||prior.plannedDelivery||null,operationId:prior.operationId};if(original.captureReceipt.state==='completed'){delivery=choice.previous||{materialId:plan.id,operationId:prior.operationId};const completed=await readCaptureCompletion(delivery);if(completed)return retireDirect(completed);throw unknownCapture();}}
      }
      const previous=choice.previous||(choice.operationId?{materialId:plan.id,operationId:choice.operationId,target:destination}:null);
      if(previous?.attemptId&&previous.attemptId!==preflightAttempt){delivery=previous;const completed=await settleOriginalCapture(previous,{onProgress:choice.onProgress});if(completed)return retireDirect(completed);current();}
      delivery=captureDelivery(plan.id,destination,previous);
      current();
      recordedPlan={id:plan.id,operationId:delivery.operationId};
      if(direct){const saved=await companion.library('plan-job',{plan,scope,destination:target,target:destination,signature:directSignature,operationId:delivery.operationId,choiceSnapshot:{refs:[],questions:[],...(choice.directSelection?{directSelection:choice.directSelection}:{})}});if(saved?.id!==plan.id||saved.operationId!==delivery.operationId)throw unknownCapture();if(saved.state==='completed'){const completed=await readCaptureCompletion(delivery);if(completed)return retireDirect(completed);throw unknownCapture();}if(saved.dismissed===true)throw Object.assign(unknownCapture(),{code:'capture_dismissed'});choice.onDirectJob?.(delivery);current();await companion.library('plan-job-checkpoint',{id:plan.id,delivery,...draftTarget.draftId?{draftId:draftTarget.draftId}:{}});current();}
      else{await Promise.resolve(choice.onSubmission(delivery,draftTarget));current();}
      const completed=await readCaptureCompletion(delivery);if(completed)return retireDirect(completed);current();
      const receipt=await postCapture(delivery,()=>companion.capturePlan(plan,delivery,captureOptions),{onProgress:choice.onProgress,posted:()=>posting});
      return retireDirect(receipt);
    }catch(error){
      if(recordedPlan&&!posting&&!selectionCurrent())try{await companion.settlePlan(recordedPlan.id,scope,recordedPlan.operationId,{dismiss:true});}catch(saveError){console.debug('[智云聚焦]',saveError.message);}
      if(!closed&&owner.isCurrent()&&error.name!=='AbortError')host.dataset.captureDiagnostic=error.message;
      throw error;
    }
  }
  async function resumeLibraryDraft(id){
    const opening=openChat(),owner=workspaceOwner;
    try{
      await owner.after(opening);let target=await readyDraftTarget(owner);
      const restoreCurrent=async()=>{try{return await owner.after(companion.restoreDraft(id,target,{signal:owner.signal,isCurrent:owner.isCurrent}))}catch(error){
        if(error.code!=='conversation_changed')throw error;const next=await readyDraftTarget(owner);
        if(!['conversationId','route','pageId','documentEpoch','routeGeneration'].every(key=>next[key]===target[key])||next.composerGeneration===target.composerGeneration)throw error;
        target=next;return owner.after(companion.restoreDraft(id,target,{signal:owner.signal,isCurrent:owner.isCurrent}));
      }};
      let result=await restoreCurrent();
      if(result.requiresNew){await owner.after(companion.navigateChat('new',{signal:owner.signal,isCurrent:owner.isCurrent}));target=await readyDraftTarget(owner);result=await restoreCurrent();}
      if(result.sourceId!==id||result.verified!==true||!['conversationId','route','pageId','documentEpoch','routeGeneration','composerGeneration'].every(key=>result.target?.[key]===target[key]))throw Error('草稿恢复结果尚未确认，原记录仍保留。');
      recordCaptureStatus(result.copy?'已恢复草稿副本':'已打开草稿');return result;
    }catch(error){if(!closed&&owner.isCurrent()&&error.name!=='AbortError')recordCaptureStatus(error.message,{persistent:true,action:'library',actionLabel:'返回资料'});throw error;}
  }
  async function completeSavedContext(job,owner){
    const original=await owner.after(outbox.load(job,(...args)=>companion.library(...args)));if(!original||original.contextComplete!==false||!job.acquisition?.contextId)return job;
    const acquisition=job.acquisition,source=video.currentSrc;
    if(acquisition.source!==await owner.after(sourceFrameIdentity(source)))throw Error('原截图已保存。请打开原课程视频后补齐背景，或从原图继续选材。');
    const sourceTask=requestSourceFrame({source},acquisition.time,owner);let frame;
    try{frame=await owner.after(sourceTask.promise);}finally{sourceTask.controller.abort();}
    const sameTime=Math.abs(frame.time-original.time)<=.000002,clockFrame=!acquisition.exact&&frame.indexed&&frame.requested===acquisition.time&&frame.time<=original.time+.000002&&(frame.nextTime===null||frame.nextTime>original.time);
    if((!sameTime&&!clockFrame)||Math.abs(frame.width/frame.height-acquisition.width/acquisition.height)>.002)throw Error('背景与原圈选时刻尚未核对，原图仍保留。');
    const batch=frameBundle(frame,{selection:original.selection.roi,boards:job.layout.boards,active:job.layout.active,time:original.time,course:original.course,lessonKey:original.lessonKey,id:acquisition.contextId});
    batch.selection={...original.selection,image:original.selection.image};delete batch.selection.missingContext;
    const continuation=outbox.add({batch,contextFor:job.id,markId:original.markId,markOnly:true,layout:job.layout,sourcePage:job.sourcePage,contextProof:{source:acquisition.source,requested:frame.requested,time:frame.time,nextTime:frame.nextTime,indexed:!!frame.indexed}},{destination:acquisition.destination,target:job.target,operationId:acquisition.contextOperationId||null,issuedAt:job.createdAt,sequence:job.sourceSequence});
    await outbox.save(continuation,(...args)=>companion.library(...args));
    const next=outbox.replaceContext(job,continuation);if(next)next.batch=null;return next;
  }
  async function transferCaptures({explicit=false,requestOwner=null}={}){
    if(closed||captureWorking||captureSelecting||!queuedCaptures().length||requestOwner?.isCurrent()===false)return;
    if(transferBusy){queuedTransfer={explicit,requestOwner:requestOwner||workspaceOwner};return;}
    const release=outbox.claimDelivery();if(!release){captureFailure(Error('上一次附图仍在确认，请稍后重试。'));return}
    transferBusy=true;$('shot-retry').hidden=true;const invocationOwner=requestOwner||workspaceOwner,preview=shotPreviewEpoch,cropId=imageCropId;let owner=null,activeJob=null;
    try{
      while(!closed){
        let job=outbox.next({explicit,lessonKey:key||(captureCourseInfo().course+':'+role)});if(!job)break;
        activeJob=job;
        if(!explicit&&studyLessonScope(job.lessonKey)!==captureLesson()){job.requiresReview=true;continue}
        if(job.receipt){await outbox.prepare(job,null,captureSettlementLibrary,{explicit});continue}
        if(job.delivery?.attemptId){
          const completed=await settleOriginalCapture(job.delivery);
          if(completed){if(completed.durable)await outbox.reconcile(job,captureSettlementLibrary);else await outbox.complete(job,completed,captureSettlementLibrary);continue;}
          if(!explicit){job.requiresReview=true;continue;}
        }
        if(closed||!(owner||invocationOwner).isCurrent())break;
        if(explicit&&job.delivery){const proof=await (owner||invocationOwner).after(outbox.reconcile(job,captureSettlementLibrary));if(proof){reportCaptureResolution(proof);continue;}}
        if(!owner){const opening=openChat({requestOwner});owner=workspaceOwner;await owner.after(opening);if(!companion.snapshot().chatOpen)throw Error(workspaceError?.message||'截图已保留，请展开 ChatGPT 后重试附图。')}
        let current=await readyDraftTarget(owner);
        const original=job.delivery?.target||job.target;
        if(explicit&&job.requiresReview&&original?.conversationId.startsWith('c:')&&original.conversationId!==current.conversationId){await owner.after(companion.navigateChat('https://chatgpt.com'+original.route,{signal:owner.signal,isCurrent:owner.isCurrent}));current=await readyDraftTarget(owner);}
        const reconciling=job.delivery&&(job.delivery.reconcileOnly||job.delivery.target.conversationId.startsWith('provisional:')&&current.conversationId.startsWith('c:'));
        if(!reconciling&&job.target?.draftId&&current.draftId&&job.target.draftId!==current.draftId){const proof=await owner.after(outbox.reconcile(job,(...args)=>companion.library(...args)));if(proof){reportCaptureResolution(proof);continue;}throw Object.assign(Error('原提问已结束，截图仍保留在学习记录中；可从原图选择新提问。'),{code:'conversation_changed'});}
        if(explicit){
          const frozen=current,loaded=await owner.after(outbox.load(job,(...args)=>companion.library(...args)));if(!loaded)continue;
          if(loaded.contextComplete===false&&job.acquisition?.contextId){if(!job.target)job.target={...frozen};$('shot-status').textContent='正在补齐背景…';job=await completeSavedContext(job,owner);if(!job)continue;activeJob=job;current=await readyDraftTarget(owner);
            if(['conversationId','route','pageId','documentEpoch','routeGeneration'].some(key=>current[key]!==frozen[key])||current.draftId&&frozen.draftId&&current.draftId!==frozen.draftId||current.composerGeneration!==frozen.composerGeneration&&(!current.draftId||current.draftId!==frozen.draftId))throw Object.assign(Error('提问已切换，补齐的背景和原图仍保留。'),{code:'conversation_changed'});
          }
        }
        const prepared=await owner.after(outbox.prepare(job,current,(...args)=>companion.library(...args),{explicit}));if(!prepared)continue;
        const {batch,delivery}=prepared;showCapturePreview(batch);$('shot-status').textContent='附图中…';$('shot-status').title='';owner.assertCurrent();
        let posting=false;
        const receipt=await postCapture(delivery,()=>companion.captureDraft(batch,delivery,{signal:owner.signal,isCurrent:owner.isCurrent,onPost:()=>{posting=true;}}),{posted:()=>posting});
        if(receipt.durable)await outbox.reconcile(job,captureSettlementLibrary);else await outbox.complete(job,receipt,captureSettlementLibrary);
        if(owner.isCurrent()&&!closed)delete host.dataset.captureDiagnostic;
      }
    }catch(error){
      if(error.code==='capture_retained'&&activeJob){try{const proof=await outbox.reconcile(activeJob,(...args)=>companion.library(...args));if(proof&&!closed&&(owner||invocationOwner).isCurrent())reportCaptureResolution(proof);}catch(readError){if(!closed&&(owner||invocationOwner).isCurrent())captureFailure(readError);}return;}
      const intended=activeJob?.delivery?.target||activeJob?.target,live=companion.snapshot().chatDraftTarget,sameConversation=!intended||live&&intended.conversationId===live.conversationId;
      if(error.code==='conversation_changed'&&activeJob){
        activeJob.requiresReview=true;activeJob.canKeep=true;
        if(explicit&&!closed&&(owner||invocationOwner).isCurrent()&&preview===shotPreviewEpoch&&cropId===imageCropId&&!captureWorking&&!captureSelecting&&shotBatch?.id!==activeJob.id){try{const batch=await outbox.load(activeJob,(...args)=>companion.library(...args));if(batch&&!closed&&(owner||invocationOwner).isCurrent()&&preview===shotPreviewEpoch&&cropId===imageCropId)showCapturePreview(batch,{layout:activeJob.layout,sourcePage:activeJob.sourcePage});}catch(readError){activeJob.previewError=readError.message;if(!closed&&(owner||invocationOwner).isCurrent()&&preview===shotPreviewEpoch)recordCaptureStatus('原截图暂未读出，可从学习记录继续查看。',{persistent:true,action:'library',actionLabel:'学习记录'});}}
        if(!closed&&(owner||invocationOwner).isCurrent()&&shotBatch?.id===(activeJob.id||activeJob.batch?.id)){
          $('shot-status').textContent='已保存，尚未附入原对话';$('shot-retry').hidden=false;$('shot-retry').textContent=intended?.conversationId.startsWith('c:')?'继续原提问':'附图';
          $('shot-keep').hidden=false;
          recordCaptureStatus('截图已保存 · 未附入原对话',{persistent:true,actionLabel:'查看'});
        }
      }
      if(error.code==='capture_dismissed'&&activeJob){outbox.retireLocal(activeJob);if(!closed&&(owner||invocationOwner).isCurrent()&&shotBatch?.id===activeJob.id){$('shot-retry').hidden=true;$('shot-keep').hidden=true;$('shot-status').textContent='原图已留在学习记录中';}}
      if(error.name!=='AbortError'&&!['conversation_changed','capture_dismissed','capture_acquiring'].includes(error.code)&&(owner||invocationOwner).isCurrent()&&sameConversation&&(!activeJob||shotBatch?.id===(activeJob.id||activeJob.batch?.id)))host.dataset.captureDiagnostic=error.message;
    }
    finally{transferBusy=false;release();const next=queuedTransfer;queuedTransfer=null;if(next&&!closed&&next.requestOwner.isCurrent())void transferCaptures(next)}
  }
  on($('shot-keep'),'click',async()=>{
    const job=captureQueue.find(value=>value.canKeep&&value.id===shotBatch?.id);if(!job||transferBusy)return;
    const owner=workspaceOwner,preview=shotPreviewEpoch;$('shot-keep').disabled=true;
    try{await outbox.dismiss(job,(...args)=>companion.library(...args));if(closed||!owner.isCurrent()||preview!==shotPreviewEpoch)return;
      $('shot-status').textContent='原图已留在学习记录中';$('shot-keep').hidden=true;$('shot-retry').hidden=true;$('shot-launch').hidden=true;
      let next;try{next=outbox.next({explicit:true,lessonKey:captureLesson()});}catch{}if(next){const batch=await owner.after(outbox.load(next,(...args)=>companion.library(...args)));if(batch&&!closed&&owner.isCurrent()&&preview===shotPreviewEpoch){showCapturePreview(batch,{layout:next.layout,sourcePage:next.sourcePage});$('shot-status').textContent='下一张待附图';}}
    }catch(error){if(!closed&&owner.isCurrent()&&preview===shotPreviewEpoch)captureFailure(error);}
    finally{if(!closed&&owner.isCurrent())$('shot-keep').disabled=false;}
  });
  on($('shot-retry'),'click',()=>pendingShotPlan()?askFromShot({fresh:true}):retryCaptures());
  on($('shot-launch'),'click',async event=>{
    event.preventDefault();
    const owner=workspaceOwner,captureJob=recoveryCapture(),planAction=pendingShotPlan(),preview=shotPreviewEpoch,cropId=imageCropId,cropImage=imageCropData,batch=shotBatch,forDraft=!!planAction||!captureJob||captureJob.destination==='direct',currentRecovery=()=>!captureJob&&!planAction||preview===shotPreviewEpoch&&cropId===imageCropId&&cropImage===imageCropData&&batch===shotBatch;
    try{
      try{await owner.after(companion.waitUntilReady({forLibrary:true,forDraft,timeoutMs:0}))}
      catch(error){if(error.action!=='launch'&&!['companion_unavailable','companion_upgrade'].includes(error.code))throw error;await owner.after(helperStartup.launch());await owner.after(companion.waitUntilReady({forLibrary:true,forDraft,timeoutMs:18000}))}
      if(!currentRecovery())return;if(planAction)await askFromShot();else await retryCaptures({captureJob});
    }catch(error){if(owner.isCurrent()&&error.name!=='AbortError'&&currentRecovery())captureFailure(error,{saveJob:captureJob})}
  });
  on($('capture'),'click',beginCapture);on($('capture-cancel'),'click',cancelCapture);
  on($('capture-layer'),'pointerdown',e=>{
    if(e.button!==0||!captureSelecting||!captureReady)return;e.preventDefault();
    if(e.isPrimary===false||captureDrag&&captureDrag.id!==e.pointerId){cancelCapture({reason:'多点触摸已取消本次框选。'});return}
    $('capture-layer').setPointerCapture(e.pointerId);captureDrag={id:e.pointerId,x:e.clientX,y:e.clientY};drawCapture(captureDrag);
  });
  on($('capture-layer'),'pointermove',e=>{if(captureDrag?.id===e.pointerId)drawCapture({x:e.clientX,y:e.clientY})});
  on($('capture-layer'),'pointerup',e=>{
    if(!captureDrag||!captureView||e.pointerId!==captureDrag.id)return;const rect=selectionRectangle(captureDrag,{x:e.clientX,y:e.clientY},captureView.view);captureDrag=null;
    if(rect)void finishCapture(rect);else $('capture-rect').hidden=true;
  });
  on($('capture-layer'),'pointercancel',cancelCapture);on($('capture-layer'),'lostpointercapture',event=>{if(captureDrag?.id===event.pointerId)cancelCapture()});on($('capture-layer'),'contextmenu',e=>{e.preventDefault();cancelCapture()});
  const previewShot=()=>{if(!shotImage&&!pendingCaptures().length&&!queuedCaptures().length&&!recoveryError)return;setMenu('shot')};
  on($('shot-last'),'click',previewShot);
  on($('shot-copy'),'click',async()=>{const owner=workspaceOwner,preview=shotPreviewEpoch,image=imageCropData||shotImage,current=()=>!closed&&owner.isCurrent()&&preview===shotPreviewEpoch&&image===(imageCropData||shotImage);try{await copyBoard(image);if(current()){$('shot-status').textContent='已复制';$('shot-status').title=''}}catch(error){if(current()){$('shot-status').textContent='复制未完成';$('shot-status').title=error.message}}});
  on($('add'),'click',()=>startEdit('add'));on($('redraw'),'click',()=>startEdit('replace'));on($('cancel-edit'),'click',cancelEdit);
  for(const el of [$('board-list'),$('regions'),$('quick-boards')])on(el,'click',e=>{const id=e.target.closest('[data-board]')?.dataset.board;if(id){commitBoard(id);$('board-chooser').open=false;if(el===$('quick-boards'))void closeMenu()}});
  function renameBoard(){if(boardNameComposing)return;const b=boards.find(b=>b.id===active);if(!b)return;noteViewIntent();b.name=$('board-name').value.trim().slice(0,24)||'板位';for(const list of [$('board-list'),$('quick-boards')])for(const button of list.querySelectorAll('[data-board]')){const i=boards.findIndex(x=>x.id===button.dataset.board);if(i>=0){const label=button.querySelector('[data-board-label]');if(label)label.textContent=boards[i].name;else button.textContent=boards[i].name;button.setAttribute('aria-label',boards[i].name)}}$('board-choice').textContent=b.name;if(mode==='focus'&&!peek)$('view-toggle').setAttribute('aria-label','选择板位，当前'+b.name);clearTimeout(saveTimer);saveTimer=setTimeout(save,350)}
  on($('board-name'),'input',e=>{if(!e.isComposing)renameBoard()});on($('board-name'),'change',renameBoard);
  on($('board-name'),'compositionstart',()=>{boardNameComposing=true});on($('board-name'),'compositionend',()=>{boardNameComposing=false;renameBoard()});
  on($('last'),'click',()=>{if(lastView){const current=snapshot();restoreView(lastView);lastView=current;refreshLists();save();wake()}});
  on($('remove'),'click',()=>{finishPan();noteViewIntent();if(captureSelecting||captureWorking)cancelCapture();boards=boards.filter(b=>b.id!==active);active=boards[0]?.id||null;roi={...boardView(boards[0])};mode=active?'focus':'overview';returnView=null;lastView=null;if(boards.length)save();else repo.clear(key);refreshLists();render()});
  function clearLayouts(all){if(!confirm(all?'清除本工具保存的全部板位布局？平台数据不受影响。':'清除本节保存的板位布局？'))return;noteViewIntent();cancelCapture();const cleared=repo.clear(all?null:key);boards=[];active=null;roi={...FULL};mode='overview';returnView=null;lastView=null;peek=null;reviewPending=false;refreshLists();render();tell(cleared?'布局已清除，可重新添加板位。':'本次已清空；浏览器未允许删除已存数据，刷新后可能再次出现。');wake()}
  on($('clear-course'),'click',()=>clearLayouts(false));on($('clear-all'),'click',()=>clearLayouts(true));
  on($('reconnect'),'click',e=>{e.stopPropagation();reconnect()});
  function startClarity(){wantClarity=true;audio.start('clarity')}
  on($('audio'),'click',()=>{wantClarity=!wantClarity;wantClarity?startClarity():audio.stop();void closeMenu()});
  on($('audio-retry'),'click',startClarity);
  on($('audio-launch'),'click',event=>{
    event.preventDefault();
    // Begin/resume Web Audio in this click, then wait for the protocol-launched helper.
    audio.stop();const ready=helperStartup.launch();startClarity();
    ready.catch(error=>{if(!closed&&wantClarity&&audio.inspect().mode==='original'){$('audio-status').textContent='人声暂未就绪';$('audio-status').title=error.message;$('audio-launch').hidden=false;$('audio-retry').hidden=true}});
  });
  on($('rate'),'click',()=>{const open=$('rate-menu').hidden;if(localPanel(menu))void closeMenu();$('rate-menu').hidden=!open;$('rate').setAttribute('aria-expanded',String(open));study.setContext({canProtect:protectionAllowed()});if(open){wake();positionPlayerMenu($('rate-menu'),$('rate'));if(keyboardMode)$('rate-menu').querySelector('[aria-pressed="true"]')?.focus({preventScroll:true})}else scheduleHide()});
  on($('rate-menu'),'click',event=>{const option=event.target.closest('[data-rate]');if(!option)return;video.playbackRate=Number(option.dataset.rate);sync();closeRateMenu(keyboardMode);scheduleHide()});
  on($('rate-menu'),'keydown',event=>{const options=[...$('rate-menu').querySelectorAll('[data-rate]')],index=options.indexOf(shadow.activeElement);if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();event.stopPropagation();options[event.key==='Home'?0:event.key==='End'?options.length-1:(index+(event.key==='ArrowUp'?-1:1)+options.length)%options.length]?.focus()});
  on(host,'pointerdown',event=>{const hit=event.composedPath()[0],target=hit.closest?.('button')||hit;if(!$('rate-menu').contains(target)&&target!==$('rate'))closeRateMenu();if(localPanel(menu)&&!editing&&!$('viewer-menu').contains(target)&&target!==$('view-toggle')&&target!==$('settings-toggle'))void closeMenu({returnFocus:false})},{capture:true});
  for(const node of [bar,$('viewer-menu'),$('rate-menu')]){on(node,'pointerenter',()=>clearTimeout(menuDismissTimer));on(node,'pointerleave',scheduleMenuDismiss);}
  try{preferences=viewerPreferences(JSON.parse(localStorage.getItem('__zjf_preferences_v1')||'null'))}catch{}
  function syncBackSeconds(){$('rewind-seconds').textContent=String(preferences.backSeconds);$('rewind').setAttribute('aria-label','回听'+preferences.backSeconds+'秒');for(const option of $('back-seconds').querySelectorAll('[data-back-seconds]'))option.setAttribute('aria-pressed',String(Number(option.dataset.backSeconds)===preferences.backSeconds))}
  syncBackSeconds();
  function savePreferences(){try{localStorage.setItem('__zjf_preferences_v1',JSON.stringify(preferences))}catch{}}
  function setSidebarRatio(ratio){
    finishPan();
    noteViewIntent();if(captureNeedsFrame())cancelCapture();const width=visualArea().width,limits=sidebarLimits(width);preferences.sidebarRatio=Math.max(limits.minimum/width,Math.min(limits.maximum/width,Number(ratio)||preferences.sidebarRatio));
    if(sideWorkspace(workspacePage)){
      const width=sidebarSize(visualArea().width,preferences.sidebarRatio);resizingOwner=workspaceOwner;resizingRevision=workspaceRevision;
      if(companionState.connected&&workspaceSupported!==false)sidebarResizer.set(width);else{pendingSidebarWidth=0;sidebarWidth=width;render();refreshStudy()}
    }
  }
  on($('chat-resize'),'pointerdown',e=>{if(e.button!==0||e.isPrimary===false||sidebarDrag!==null||!sideWorkspace(workspacePage))return;e.preventDefault();finishPan();clearTimeout(layoutMotionTimer);video.removeAttribute('data-zjf-moving');sidebarDrag=e.pointerId;$('chat-resize').setPointerCapture(e.pointerId);$('chat-resize').classList.add('dragging');hideControls(true);if(captureNeedsFrame())cancelCapture()});
  on($('chat-resize'),'pointermove',e=>{if(sidebarDrag===e.pointerId){const visual=visualArea();setSidebarRatio((visual.offsetLeft+visual.width-e.clientX)/visual.width)}});
  const finishSidebarDrag=event=>{if(sidebarDrag===null||event?.pointerId!==undefined&&event.pointerId!==sidebarDrag)return;const pointer=sidebarDrag;sidebarDrag=null;if($('chat-resize').hasPointerCapture?.(pointer))$('chat-resize').releasePointerCapture(pointer);$('chat-resize').classList.remove('dragging');savePreferences()};
  for(const event of ['pointerup','pointercancel','lostpointercapture'])on($('chat-resize'),event,finishSidebarDrag);
  on($('chat-resize'),'dblclick',()=>{setSidebarRatio(DEFAULT_SIDEBAR_RATIO);preferences.sidebarRatio=DEFAULT_SIDEBAR_RATIO;savePreferences()});
  on($('back-seconds'),'click',event=>{const option=event.target.closest('[data-back-seconds]');if(!option)return;preferences.backSeconds=Number(option.dataset.backSeconds);syncBackSeconds();savePreferences();void closeMenu()});
  on($('rewind'),'click',()=>{if(!replayReturn)replayReturn={time:video.currentTime,view:snapshot(),board:boards.find(board=>board.id===active)||null};seek(video.currentTime-preferences.backSeconds);sync();wake()});
  on($('return-time'),'click',()=>{if(!replayReturn)return;const r=replayReturn;replayReturn=null;const sameBoard=!r.view.active||r.board&&boards.includes(r.board)&&r.board.id===r.view.active;restoreView(sameBoard?r.view:{mode:'overview',active:boards[0]?.id||null,roi:{...boardView(boards[0])}});seek(r.time);sync();if(keyboardMode)$('rewind').focus({preventScroll:true});wake()});
  let seekPointer=null,seekValue=null;
  on($('seek'),'pointerdown',event=>{if(event.isPrimary===false||seekPointer!==null)return;seekPointer=event.pointerId;seekValue=Number($('seek').value);scrubbing=true;wake()});
  on($('seek'),'input',()=>{if(scrubbing)seekValue=Number($('seek').value);$('seek').style.setProperty('--progress',Number($('seek').max)>0?100*Number($('seek').value)/Number($('seek').max)+'%':'0%')});
  const releaseSeek=event=>{if(!scrubbing||event?.pointerId!=null&&event.pointerId!==seekPointer)return;if(event?.type==='pointerup'&&Number.isFinite(seekValue)){replayReturn=null;seek(seekValue);}scrubbing=false;seekPointer=null;seekValue=null;setTimeout(()=>{if(closed||scrubbing)return;if(!keyboardMode&&shadow.activeElement===$('seek'))surface.focus({preventScroll:true});sync();scheduleHide();},0)};
  on(window,'pointerup',releaseSeek,{capture:true});on(window,'pointercancel',releaseSeek,{capture:true});on($('seek'),'lostpointercapture',releaseSeek);on($('seek'),'blur',releaseSeek);
  on($('seek'),'change',()=>{replayReturn=null;seek(Number($('seek').value));releaseSeek();sync()});
  on(surface,'pointerdown',e=>{if(e.button!==0||!layout||e.isPrimary===false||drag)return;noteViewIntent();if(captureNeedsFrame())cancelCapture();surface.setPointerCapture(e.pointerId);cursorWake();drag={pointer:e.pointerId,x:e.clientX,y:e.clientY,lastX:e.clientX,lastY:e.clientY,point:sourcePoint({x:e.clientX,y:e.clientY},layout),original:{...roi},active,mode,key,source:video.currentSrc,editing,owner:intents.observe('view'),moved:false};if(editing){selection.style.display='block';Object.assign(selection.style,{left:e.clientX+'px',top:e.clientY+'px',width:'0',height:'0'})}});
  on(surface,'pointermove',e=>{
    cursorWake();if(!drag)return;if(e.pointerId!==drag.pointer)return;if(!drag.owner.isCurrent()){finishPan();return;}if((e.pointerType==='mouse'||e.pointerType==='pen')&&e.buttons===0){cancelTransient(e);return;}
    drag.moved ||= Math.hypot(e.clientX-drag.x,e.clientY-drag.y)>7;
    if(editing)Object.assign(selection.style,{left:Math.min(drag.x,e.clientX)+'px',top:Math.min(drag.y,e.clientY)+'px',width:Math.abs(drag.x-e.clientX)+'px',height:Math.abs(drag.y-e.clientY)+'px'});
    else if(mode==='focus'&&!peek&&drag.moved){roi=pan(roi,e.clientX-drag.lastX,e.clientY-drag.lastY,layout);updateCurrent();requestRender()}
    drag.lastX=e.clientX;drag.lastY=e.clientY;
  });
  on(surface,'pointerup',e=>{
    if(!drag||e.pointerId!==drag.pointer)return;if(!drag.owner.isCurrent()){finishPan();return;}const moved=drag.moved;
    if(editing&&Math.abs(e.clientX-drag.x)>=12&&Math.abs(e.clientY-drag.y)>=12){
      roi=between(drag.point,sourcePoint({x:e.clientX,y:e.clientY},layout));
      if(editing==='add'){const id='b'+(Math.max(0,...boards.map(b=>Number(b.id.slice(1))))+1);active=id;boards.push({id,name:'板位'+(boards.length+1),roi:{...roi}})}else{const board=boards.find(b=>b.id===active);if(board){board.roi={...roi};board.view={...roi};}}
      editing=null;editOrigin=null;reviewPending=false;mode='focus';returnView=snapshot();save();refreshLists();
    }else if(!editing&&!moved&&!peek){wake()}
    finishPan();render();surface.focus({preventScroll:true});scheduleHide();cursorWake();
  });
  function cancelTransient(event){if(event?.pointerId!==undefined&&drag?.pointer!==event.pointerId)return;finishPan({revert:true,event});scrubbing=false;seekPointer=null;seekValue=null;selection.style.display='none';endPeek();render();scheduleHide()}
  on(surface,'pointercancel',cancelTransient);
  on(surface,'lostpointercapture',event=>{if(drag?.pointer===event.pointerId)cancelTransient()});
  on(surface,'wheel',e=>{if(e.ctrlKey||e.metaKey||e.altKey||mode!=='focus'||editing||peek)return;e.preventDefault();finishPan();noteViewIntent();if(captureNeedsFrame())cancelCapture();roi=zoom(roi,sourcePoint({x:e.clientX,y:e.clientY},layout),Math.exp(clamp(e.deltaY,-120,120)*.0015));updateCurrent();requestRender();cursorWake()},{passive:false});
  on(window,'keydown',e=>{
    if(e.isTrusted){noteFocusIntent();if(e.key==='Tab')chatFocusBackward=e.shiftKey;}
    if(e.defaultPrevented||composing||e.isComposing||e.keyCode===229||['Process','Dead','Unidentified'].includes(e.key))return;
    if(protectionKey(e))return;
    keyboardMode=true;
    if(e.ctrlKey||e.metaKey||e.altKey)return;
    if(e.key==='F11'){
      const owner=intents.begin('fullscreen');fullscreen.releaseNativeOwnership();requestAnimationFrame(()=>{if(owner.isCurrent()&&!closed&&!document.fullscreenElement)void fullscreen.reconcileNative({allowActive:true})});return;
    }
    if(e.key==='Escape'&&fullscreen.busy)intents.invalidate('fullscreen');
    const path=e.composedPath();if(editableTarget(path))return;
    if(guard.active&&path.includes($('chat-space'))&&e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();escape();return;}
    if(path.includes($('chat-resize'))&&['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){
      const width=visualArea().width,limits=sidebarLimits(width),current=sidebarSize(width,preferences.sidebarRatio)/width;
      e.preventDefault();e.stopImmediatePropagation();setSidebarRatio(e.key==='Home'?limits.minimum/width:e.key==='End'?limits.maximum/width:current+(e.key==='ArrowLeft'?.01:-.01));savePreferences();return;
    }
    if(e.key==='Tab'){
      if(!controlsVisible){
        // Keep the toolbar in the keyboard path while a sidebar is open. The
        // sidebar keeps its current focus; Tab can then reach playback too.
        if(workspacePage==='closed'&&!e.shiftKey){e.preventDefault();e.stopImmediatePropagation();wake(true)}
        else wake();
      }
      return;
    }
    if(!viewerShortcutAllowed(e,{protectedInput:guard.active,path}))return;
    if(captureSelecting){if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();cancelCapture()}return}
    const k=e.key.toLowerCase();
    if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();escape();return}
    if(!['f','r','s',' ','arrowleft','arrowright','0','1','2','3','4','5','6'].includes(k))return;
    e.preventDefault();e.stopImmediatePropagation();if(e.repeat)return;
    if(k==='f')beginPeek();else if(k==='r')startEdit(active?'replace':'add');else if(k==='s')beginCapture();else if(k===' ')togglePlay();else if(k==='0')toggleOverview();else if(/^\d$/.test(k)){const b=boards[Number(k)-1];if(b)commitBoard(b.id)}else{seek(video.currentTime+(k==='arrowright'?5:-5));wake()}
  },{capture:true});
  on(window,'keyup',e=>{if(protectionKey(e))return;if(!composing&&!e.isComposing&&e.keyCode!==229&&e.key.toLowerCase()==='f'&&peek){if(viewerShortcutAllowed(e)){e.preventDefault();e.stopImmediatePropagation()}endPeek()}},{capture:true});
  on(window,'compositionstart',()=>{composing=true;keyboardDoor.cancel();if(peek)endPeek()},{capture:true});on(window,'compositionend',()=>{composing=false;requestRender()},{capture:true});
  on(window,'blur',()=>{queueMicrotask(async()=>{
    if(closed||!document.hidden&&document.hasFocus?.())return;
    clearTimeout(controlsRevealTimer);controlsRevealTimer=0;
    $('protection-strip').dataset.revealed='false';
    finishSidebarDrag();cancelTransient();keyboardDoor.cancel();protectionDoor.cancel();
    if(workspacePage==='chat'&&companionState.connected&&!document.hidden){
      const owner=workspaceOwner;
      try{
        const state=await companion.refresh();
        if(closed||!owner.isCurrent()||document.hasFocus?.())return;
        if(state.foreground&&state.chatFocused){
          foreground=true;hover=false;keyboardMode=false;composing=false;pendingNativeFocusReturn=null;keyboardDoor.cancel();protectionDoor.cancel();study.setContext({foreground:true});
          if(captureNeedsFrame())cancelCapture();
          refreshStudy();return;
        }
      }catch(error){if(closed||!owner.isCurrent()||document.hasFocus?.())return;}
    }
    foreground=false;pendingNativeFocusReturn=null;study.setContext({foreground:false});intents.invalidate('chat-focus','fullscreen');noteViewIntent();cancelCapture({resume:false,reason:'截图已取消，回到课程后可重新框选。'});finishSidebarDrag();cancelTransient();hover=false;keyboardMode=false;composing=false;refreshLists();if(!editing){dismissPlayerMenus();hideControls(true);}
    if(companionState.connected)void companion.refresh().catch(()=>{});
  })});
  on(window,'focus',()=>{foreground=true;study.setContext({foreground:true,visible:!document.hidden});refreshStudy();if(pendingNativeFocusReturn)returnNativeFocus(pendingNativeFocusReturn);if(workspacePage==='chat'&&companionState.connected)void companion.refresh().catch(()=>{});});
  const viewportChanged=()=>{finishPan();pendingNativeFocusReturn=null;intents.invalidate('chat-focus');noteViewIntent();if(imageDrag)cancelImageDrag();if(captureNeedsFrame())cancelCapture({reason:'窗口尺寸已变化，请重新框选。'});protectionDoor.cancel();if(sideWorkspace(workspacePage)){const width=sidebarSize(visualArea().width,preferences.sidebarRatio);resizingOwner=workspaceOwner;resizingRevision=workspaceRevision;if(companionState.connected&&workspaceSupported!==false)sidebarResizer.set(width);else{pendingSidebarWidth=0;sidebarWidth=width}}requestRender()};
  on(window,'resize',viewportChanged);if(window.visualViewport){on(window.visualViewport,'resize',viewportChanged);on(window.visualViewport,'scroll',viewportChanged)}
  on(document,'fullscreenchange',()=>{beginLayoutMotion();attachViewerHost();if(captureNeedsFrame())cancelCapture();protectionDoor.cancel();refreshStudy();requestRender()});on(window,'pagehide',()=>{close();companion.dispose();audio.dispose()});
  on(document,'visibilitychange',()=>{study.setContext({visible:!document.hidden});if(document.hidden){pendingNativeFocusReturn=null;intents.invalidate('chat-focus');noteViewIntent();cancelCapture({resume:false});captureClock.invalidate();keyboardDoor.cancel();protectionDoor.cancel()}cancelTransient();if(document.hidden){hover=false;keyboardMode=false;if(!editing&&!menu)hideControls(true)}else{clearTimeout(visibilityTimer);visibilityTimer=setTimeout(()=>{render();sync();scheduleHide()},0)}});
  function reconcileMedia(event){
    finishPan();
    pendingNativeFocusReturn=null;mediaPositionEpoch++;noteViewIntent();notePlaybackIntent();expectedPlayback.clear();expectedSeeks.length=0;cancelCapture({resume:false});captureClock.invalidate();intents.invalidate('library-recovery','chat-focus');
    const next=[video.videoWidth,video.videoHeight],nextKey=identity();if(!next.every(n=>n>0))return;
    const changed=sourceKey!==video.currentSrc;
    if(key!==nextKey){
      if(event?.type!=='loadedmetadata'&&sourceKey===video.currentSrc)return;
      reconnect();return;
    }
    else if(resetForMedia(dimensions,next,changed,!!key)){mode='overview';peek=null;editing=null;returnView=null;lastView=null;replayReturn=null;currentMark=null;currentMarkBoards='';reviewPending=true;audio.sourceChanged();tell('画面比例或来源已变，请在全景核对并重新圈选。',true)}
    else if(changed){audio.sourceChanged();if(!sameMediaResource(sourceKey,video.currentSrc)){mode='overview';peek=null;editing=null;returnView=null;lastView=null;replayReturn=null;currentMark=null;currentMarkBoards='';reviewPending=true;tell('媒体已更新，当前视角保留。按F核对机位；有变化时重新圈选。')}}
    dimensions=next;sourceKey=video.currentSrc;const proofSource=sourceKey,proofView=intents.observe('view');void identifyMedia(proofSource).then(value=>{if(closed||sourceKey!==proofSource)return;if(!reviewPending){save();return;}if(!proofView.isCurrent())return;const matched=repo.readForMedia(key,value,dimensions,video.duration);if(!matched)return;boards=matched.boards.map(board=>({...board,roi:{...board.roi},...(board.view?{view:{...board.view}}:{})}));active=matched.active;roi={...boardView(boards.find(board=>board.id===active))};mode=boards.length?'focus':'overview';reviewPending=false;returnView=boards.length?snapshot():null;render();refreshLists();}).catch(error=>{if(!closed&&sourceKey===proofSource)host.dataset.mediaDiagnostic=error.message;});study.setContext({mediaId:key+'|'+sourceKey});render();refreshLists();wake();void recoverCaptures();
  }
  on(window,'hashchange',reconcileMedia);on(window,'popstate',reconcileMedia);on(video,'loadedmetadata',reconcileMedia);on(video,'resize',reconcileMedia);
  on(document,'loadedmetadata',event=>{if(disconnected&&event.target!==video&&event.target?.tagName==='VIDEO')reconnect()},{capture:true});
  for(const n of ['timeupdate','ratechange','durationchange','seeked','loadeddata'])on(video,n,sync);
  for(const n of ['play','pause'])on(video,n,()=>{
    const queue=(expectedPlayback.get(n)||[]).filter(record=>record.owner.isCurrent()),expected=queue.shift(),matches=n==='pause'?video.paused:!video.paused;if(queue.length)expectedPlayback.set(n,queue);else expectedPlayback.delete(n);
    if(matches&&!expected)notePlaybackIntent();
    if(n==='play'&&captureTransaction?.native&&!captureTransaction.frozen&&!captureTransaction.restoring)cancelCapture({resume:false});sync();wake();
  });
  on(video,'seeking',()=>{if(!expectedSeeks.shift()){mediaPositionEpoch++;notePlaybackIntent();currentMark=null;currentMarkBoards='';}if(captureNeedsFrame())cancelCapture({resume:false});captureClock.invalidate();finishPan();selection.style.display='none';sync()});on(video,'emptied',()=>{finishPan();notePlaybackIntent();expectedPlayback.clear();expectedSeeks.length=0;cancelCapture({resume:false});captureClock.invalidate();sync()});
  on(video,'error',()=>{notePlaybackIntent();cancelCapture({resume:false});sync();wake();tell('视频暂时中断，画面恢复后可重新连接。',true)});
  if(stored&&!compatible)tell('找到旧布局，但画面比例或时长已变；请重新圈选。',true);
  void initialMediaProof.then(value=>{
    if(closed||sourceKey!==initialMediaSource)return;if(!initialView.isCurrent()){if(!reviewPending)save();return;}
    const matched=seed?.mediaIdentity===value?seed:repo.readForMedia(key,value,dimensions,video.duration);
    if(matched){boards=matched.boards.map(cloneBoard);active=matched.active;roi={...boardView(boards.find(board=>board.id===active))};mode=boards.length&&!(sameLesson&&previous?.mode==='overview')?'focus':'overview';const inherited=sameLesson&&migrated?.mediaIdentity===value&&previous?.mode==='focus'?restoredView(previous,dimensions):null;if(inherited){active=boards.some(board=>board.id===previous.active)?previous.active:null;roi={...inherited.roi};mode='focus';}reviewPending=false;returnView=mode==='focus'?snapshot():boards.length?{mode:'focus',active,roi:{...roi}}:null;render();refreshLists();}
  }).catch(error=>{if(!closed&&sourceKey===initialMediaSource){host.dataset.mediaDiagnostic=error.message;}});
  wake();cursorWake();surface.focus({preventScroll:true});
  function restoreCapturePreview(){
    if(closed||shotImage)return;
    if(pendingCaptures().length){for(const job of pendingCaptures())job.restored=true;showPendingCapture({open:false});}
    else if(queuedCaptures().length){const jobs=queuedCaptures();for(const job of jobs)job.requiresReview=true;if(jobs[0].batch)showCapturePreview(jobs[0].batch);else $('shot-image').hidden=true;$('shot-last').hidden=false;$('shot-status').textContent='待附图';$('shot-retry').hidden=false;}
    else{const crop=outbox.staged.filter(item=>studyLessonScope(item.lessonKey)===captureLesson()).at(-1);if(crop)showCapturePreview(crop.preview.batch,crop.preview);}
  }
  restoreCapturePreview();
  localCaptureReady=outbox.restoreLocal(captureLesson()).then(restoreCapturePreview).catch(error=>{if(!closed){localRecoveryError=error;$('shot-last').hidden=false;$('shot-status').textContent='部分截图暂存尚未读取，已存档资料可照常使用。';$('shot-retry').hidden=false;$('shot-retry').textContent='读取截图';}});
  refreshStudy();
  if(editing)void changeWorkspace('watch');
  startImmersiveSession({audio,companion,signal,startService:()=>helperStartup.ensure({launchIfNeeded:true}),clearInheritedProtection:()=>initialProtection.isCurrent()?queueProtection(false):Promise.resolve()}).then(()=>{
    if(closed)return;void localCaptureReady.then(()=>{if(!closed&&pendingCaptures().length)void retryCaptures({explicit:false});});void recoverCaptures();
    if(sameLesson&&contentWorkspace(previous?.workspacePage)&&initialWorkspace.isCurrent())void changeWorkspace(previous.workspacePage,{requestOwner:initialWorkspace});
  }).catch(()=>{}).finally(()=>{if(!closed)refreshStudy()});
}
