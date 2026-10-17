import {newDraft,appendCapture,appendStudyPlan,planDraftAppend,logicalDraftItems,draftQuestionItems,applyDraftQuestionFields,moveDraftQuestion,moveDraftImage,replaceDraftMaterial,removeSharedDraftBackground,removeDraftItem,prepareDraftUndo,draftUndoCurrent,applyDraftUndo,rollbackDraftUndo,draftMaterialKey,draftContextKey,draftBackgroundKey,draftCarryKeys,draftPrompt,mergeDraftPrompt,readDraftQuestions,draftTextParts,carriedDraftQuestions,convertToInlineDraft,repairLegacyInlineContext,DRAFT_START} from './draft-model.js';
import {createConversationState,ConversationChangedError,canonicalConversationId} from './conversation-state.js';
import {studyLessonScope} from '../src/study-context.js';
import {DRAFT_PANEL_CSS} from './draft-style.js';
import {imageDataBlob} from '../src/image-data.js';
import {insertInlineReference,inlineQuestionNeighbours,inlineReferenceLabel,noteInlineInput} from './inline-draft.js';
import {draftIcon} from './draft-icons.js';
import {createAttachmentUI} from './attachment-ui.js';

// Runs inside the owned ChatGPT WebView. It uses visible composer controls;
// it never calls private ChatGPT endpoints and never presses Send.
export function installDraftReceiver({page=document,win=window,post=message=>window.chrome.webview.postMessage(message)}={}){
  const drafts=new Map(),operations=new WeakMap(),operationItems=new WeakMap(),questionSnapshots=new Map();
  const conversation=createConversationState({url:win.location.href,storage:win.sessionStorage,liveUrl:()=>win.location.href});
  const workspaceLeases=new WeakMap();
  let workspaceRevision=null,workspaceMode='chat',workspaceEpoch=0,restoreRevision=0,closeRevision=null,closeFrozen=false;
  const workspaceActive=()=>!closeFrozen&&(workspaceRevision===null||workspaceMode==='chat');
  function workspaceCurrent(value){const lease=value&&(workspaceLeases.get(value)||workspaceLeases.get(value.target)),revision=value?.workspaceRevision;return workspaceActive()&&(!lease||lease.epoch===workspaceEpoch&&(lease.restoreRevision===undefined||lease.restoreRevision===restoreRevision))&&(!Number.isSafeInteger(revision)||revision===workspaceRevision);}
  function operationTarget(target=conversation.snapshot(),expectedRevision){
    if(Number.isSafeInteger(expectedRevision)&&expectedRevision!==workspaceRevision)throw new ConversationChangedError();
    if(!workspaceLeases.has(target))workspaceLeases.set(target,{epoch:workspaceEpoch});
    if(!workspaceCurrent(target))throw new ConversationChangedError();return target;
  }
  function restoreTarget(target=operationTarget(),advance=false){if(advance)restoreRevision++;workspaceLeases.set(target,{epoch:workspaceEpoch,restoreRevision});return target;}
  function acceptWorkspace(message){
    const revision=message.workspaceRevision,mode=message.workspaceMode||message.mode;
    if(!Number.isSafeInteger(revision)||revision<0||!['closed','materials','chat'].includes(mode)||!conversation.isCurrent(message.target)||workspaceRevision!==null&&(revision<workspaceRevision||revision===workspaceRevision&&mode!==workspaceMode&&mode!=='closed'))return;
    if(revision===workspaceRevision&&mode===workspaceMode)return;
    const reopening=mode==='chat'&&workspaceMode!=='chat';workspaceRevision=revision;workspaceMode=mode;workspaceEpoch++;preparedNewChat=null;preparedHistory=null;
    if(!workspaceActive()){attachmentUI.close();if(fieldCommitTimer)win.clearTimeout(fieldCommitTimer);fieldCommitTimer=0;if(lessonRequest){win.clearTimeout(lessonRequest.timer);retireRequest(lessonRequest.requestId);lessonRequest=null;lessonError='';}}
    if(reopening&&workspaceActive()&&(resumeNeeded===draft||draft.items.some(item=>!findNode(item)?.isConnected))){needImageResume(draft,operationTarget(),true);editState().imageResumeFailed=false;editState().imageResumeRetry=null;}
    publishComposer(true);renderPanel();if(workspaceActive())win.setTimeout(observe,0);
  }
  function setCloseState(revision,frozen){
    if(!Number.isSafeInteger(revision)||revision<0||typeof frozen!=='boolean'||closeRevision!==null&&(revision<closeRevision||revision===closeRevision&&frozen!==closeFrozen))return false;
    if(revision===closeRevision&&frozen===closeFrozen)return true;
    closeRevision=revision;closeFrozen=frozen;workspaceEpoch++;preparedNewChat=null;preparedHistory=null;
    if(frozen){attachmentUI.close();if(fieldCommitTimer)win.clearTimeout(fieldCommitTimer);fieldCommitTimer=0;if(lessonRequest){win.clearTimeout(lessonRequest.timer);retireRequest(lessonRequest.requestId);lessonRequest=null;lessonError='';}}
    publishComposer(true);renderPanel();if(workspaceActive())win.setTimeout(observe,0);return true;
  }
  let route=win.location.pathname,draft=newDraft({inline:true}),previous='',busy=false,serial=Promise.resolve(),panel=null,warning='',pendingSend=null,activeDelivery=null,knownEditor=null,navigationCause='route';
  const attachedItems=new Set();
  let replacing=false;
  let savedVersion=0,disposed=false;
  let contextQueryEpoch=0,deferredLedgerPage=null;
  const resolvedLedgers=new Set(),ledgerRequests=new Map(),recoveryCandidates=new Map(),imageRequests=new Map(),projectRequests=new Map(),claimRequests=new Map(),retiredRequests=new Set(),saveRequests=new Map(),savedRevisions=new Map(),sendSaveRetries=new Map(),removingItems=new Set();
  const isolationNames=new Set();
  let writing=false,composition=null,deferredSync=false,deferredPanel=false,sendGesture=null,saveWarning=null;
  let preparedNewChat=null,newChatPreparation=null,preparedHistory=null,fieldCommitTimer=0;
  let allowResume=true,resumeProbeText='',resumeTask=null,resumeNeeded=null,resumeCacheError='',unboundDraftWarning=false;
  let resumeOwner=null,resumeTarget=null,resumeWait=null,resumeQueryError='',resumeQueryRetries=0,resumeQueryRetryTimer=0;
  const resumeCandidates=new Set(),resumeStorageKey='__zjf_draft_resume_v1';
  let recoveryWork=null,recoveryBlocked='';
  let explicitRestore=null,clearedDraft=null,viewerInstance='',sendReviewId=null,sendReviewPage=0;
  const lessonContext=win.__ZJF_LESSON_CONTEXT__||{},viewerLesson=studyLessonScope(lessonContext.lessonKey),hasLessonContext=Object.hasOwn(lessonContext,'lessonKey');
  let viewerCourse=lessonContext.course||{};
  let lessonReady=!hasLessonContext,lessonRequest=null,lessonWork=null,lessonError='',lessonInputVersion=0,lessonSaving=false,lessonRetries=0,lessonRetryTimer=0;
  if(viewerLesson)draft.course={...viewerCourse};
  const layoutWindow=page.defaultView||win;
  let attachmentStyle=null,reportedComposer='';
  let savedCaret=null,attachmentUndo=null,draftSaveRetry=null;
  const edits=new WeakMap();
  const attachmentUI=createAttachmentUI({page,win,read:attachmentState,reference:referenceImage,remove:removeImageChoice,moveImage:moveImageChoice,moveQuestion:moveQuestionChoice,clear:clearCurrentDraft,undo:undoAttachmentAction,metadata:updateMetadataField,restoreDraft:async id=>{warning='';await recoverDraft(id);renderPanel();},keepDraft:()=>{allowResume=false;editState().ignoreRecovery=true;unboundDraftWarning=false;warning='';persistQuestion();renderPanel();},review:renderSendReview,loadImage:async(physical,item)=>{const target=operationTarget(),value=(item.ref?.snapshotId?item:physical).raw||item;await originalImage(value,target,{preview:true});checkpoint(target);return value.image;},error:problem=>{warning=problem.message;renderPanel();}});
  function editState(value=draft){if(!edits.has(value))edits.set(value,{fields:new Map(),valid:true,saved:false,lastText:'',editorNode:null,order:'',pendingRemovals:new Map(),missingAttachments:new Map(),imageResumeFailed:false,imageResumeError:'',imageResumeRetry:null,imageResumeTarget:null,uploadDiagnostic:null,source:null,metadataDirty:false,metadataEditedKeys:new Set(),restoreAction:null,ignoreRecovery:false,needsSync:false,clearedText:null,clearedPrefix:null});return edits.get(value)}
  function needImageResume(owner=draft,target=operationTarget(),renew=false){
    if(owner!==draft||!workspaceCurrent(target)||!conversation.isCurrent(target))return false;const state=editState(owner);if(renew){state.imageResumeFailed=false;state.imageResumeRetry=null;}if(renew||!state.imageResumeTarget)state.imageResumeTarget=restoreTarget(target);
    if(!workspaceCurrent(state.imageResumeTarget)||!conversation.isCurrent(state.imageResumeTarget))return false;state.imageResumeRetry??={target:state.imageResumeTarget,attempts:0,after:Date.now()+500};resumeNeeded=owner;return true;
  }
  const editSource=()=>editState().source?.draft||draft;
  const editPrevious=()=>editState().source?.previous??previous;
  const fieldValues=()=>Object.fromEntries(editState(editSource()).fields);
  const belongsToLesson=question=>!!viewerLesson&&studyLessonScope(question.draftManifest?.viewerLessonKey??question.draftManifest?.draft?.lessonKey)===viewerLesson;
  function freshLessonDraft(){const value=newDraft({inline:true});if(viewerLesson)value.course={...viewerCourse};return value;}
  function mergeLessonMetadata(before){
    let changed=false;if(!draft.plan)for(const key of ['school','course','teacher'])if(typeof viewerCourse[key]==='string'&&!editState().metadataEditedKeys.has(key)&&(draft.course[key]??'')===(before[key]??'')&&draft.course[key]!==viewerCourse[key]){draft.course[key]=viewerCourse[key];changed=true;}return changed;
  }
  function updateLessonMetadata(message){
    if(studyLessonScope(message.lessonKey)!==viewerLesson||!message.course||typeof message.course!=='object')return;
    const before=viewerCourse;viewerCourse=message.course;const changed=mergeLessonMetadata(before);
    if(changed&&lessonReady){if(draft.items.length){editState().metadataDirty=true;commitFieldsAfterFocus()}else persistQuestion();}
  }
  function requestLesson(){
    if(!workspaceActive()||lessonReady||lessonRequest||lessonWork||lessonError||!editor()||!conversation.isCurrent(conversation.snapshot()))return;
    const requestId=crypto.randomUUID(),target=operationTarget();
    lessonRequest={requestId,target,text:editorText(),order:attachmentOrder(),input:editor(),version:lessonInputVersion};
    post({kind:'zjf-lesson-request',protocol:2,requestId,target,text:lessonRequest.text,resumeDraftIds:storedDraftIds()});
    lessonRequest.timer=win.setTimeout(()=>{if(lessonRequest?.requestId===requestId){lessonError='本讲草稿读取超时，当前输入已保留。';warning=lessonError;publishComposer(true);scheduleLessonRetry();renderPanel();}},12000);
  }
  function retryLesson(){if(lessonWork)return;if(lessonRequest?.timer)win.clearTimeout(lessonRequest.timer);lessonRequest=null;if(warning===lessonError)warning='';lessonError='';requestLesson();renderPanel();}
  function scheduleLessonRetry(){
    win.clearTimeout(lessonRetryTimer);
    if(disposed||lessonReady||lessonRetries>=3||!workspaceActive())return;
    const target=operationTarget();lessonRetryTimer=win.setTimeout(()=>{lessonRetryTimer=0;if(!disposed&&!lessonReady&&workspaceCurrent(target)&&conversation.isCurrent(target))retryLesson();},[250,1000,3000][lessonRetries++]);
  }
  function keepVisibleDraft(){
    if(lessonRequest?.timer)win.clearTimeout(lessonRequest.timer);win.clearTimeout(lessonRetryTimer);lessonRequest=null;
    if(warning===lessonError)warning='';lessonError='';lessonReady=true;allowResume=false;
    const state=editState();if(!draft.items.length&&!draft.removed.length&&!previous&&!draft.plan)state.unclassified=true;state.ignoreRecovery=true;state.saved=true;publishComposer(true);
  }
  async function removeAttachmentNames(names,target,unchanged=()=>true){
    const selected=new Set(names),deadline=Date.now()+Math.max(3000,Math.min(30000,selected.size*1500));let emptySince=0;
    for(;;){
      checkpoint(target);if(!unchanged())throw Error('问题已有新修改，停止清空并保留内容。');
      const node=attachmentNodes().find(value=>selected.has(attachmentName(value)));
      if(!node){if(!emptySince)emptySince=Date.now();if(Date.now()-emptySince>=250)return;await new Promise(resolve=>win.setTimeout(resolve,80));continue;}
      if(Date.now()>deadline)throw Error('图片仍在更新，清空尚未完成，原草稿已保留。');
      emptySince=0;const name=attachmentName(node);
      const remove=removeControl(node);if(!remove)throw Error('图片移除入口尚未就绪，当前草稿已保留。');
      replacing=true;try{remove.click()}finally{replacing=false}
      await waitFor(()=>{if(!unchanged())throw Error('问题已有新修改，停止清空并保留内容。');return !attachmentNodes().some(value=>attachmentName(value)===name)},3000,target);
    }
  }
  async function installLessonResume(message,request){
    busy=true;let changed=false;
    try{
      checkpoint(request.target);
      if(lessonInputVersion!==request.version){
        // Only an actual edit owns the new words. A platform refill or replaced
        // editor must be classified again, never assigned to this lecture.
        const saved=message.saved||{},cleared=new Set(clearedDraftIds()),candidates=[saved.current,...saved.known||[]],obsolete=new Set(candidates.filter(question=>validSavedDraft(question)&&cleared.has(question.id)).flatMap(question=>Object.values(question.draftManifest.files||{})));
        const removed=new Set(attachmentNodes().map(attachmentName).filter(name=>obsolete.has(name)));for(const name of removed)isolationNames.add(name);
        if(removed.size)await removeAttachmentNames(removed,request.target);
        const visible=attachmentNodes(),source=candidates.find(question=>validSavedDraft(question)&&!cleared.has(question.id)&&(matchesSavedText(question.draftManifest,request.text)||belongsToLesson(question)&&hasSavedAttachments(question,visible))&&visible.every(node=>Object.values(question.draftManifest.files||{}).includes(attachmentName(node))));
        if(source&&visible.length){
          installRecoveredDraft({question:source,resumable:false},{draftId:crypto.randomUUID(),disposition:'copy',revision:source.revision});
          const state=editState();state.unclassified=!belongsToLesson(source);state.fields.clear();state.metadataDirty=false;state.needsSync=false;
        }
        lessonReady=true;editState().saved=true;await waitForSaved(persistQuestion(),conversation.snapshot());return;
      }
      if(editor()!==request.input||editorText()!==request.text||attachmentOrder()!==request.order)return;
      const saved=message.saved||{},savedCurrent=validSavedDraft(saved.current)&&belongsToLesson(saved.current)?saved.current:null,clearedCurrent=savedCurrent&&clearedDraftIds().includes(savedCurrent.id)?savedCurrent:null,current=clearedCurrent?null:savedCurrent;
      const names=new Set(Object.values(current?.draftManifest.files||{})),nodes=attachmentNodes();
      const emptyReset=!!current&&current.draftManifest.workspaceReset&&!current.draftManifest.composerText.trim()&&!current.draftManifest.draft.items.length&&!request.text.trim()&&nodes.every(node=>!attachmentName(node).startsWith('zjf-'));
      const same=emptyReset||!!current&&(matchesSavedText(current.draftManifest,request.text)||hasSavedAttachments(current,nodes))&&nodes.every(node=>names.has(attachmentName(node)));
      if(!same&&(request.text.trim()||nodes.length)){
        const known=[...saved.known||[],...clearedCurrent?[clearedCurrent]:[]].filter(question=>validSavedDraft(question)&&matchesSavedText(question.draftManifest,request.text)&&nodes.every(node=>Object.values(question.draftManifest.files||{}).includes(attachmentName(node))));
        if(known.length){
          const removeNames=new Set(nodes.map(attachmentName));
          for(const name of removeNames)if(!names.has(name))isolationNames.add(name);
          await removeAttachmentNames(removeNames,request.target,()=>lessonInputVersion===request.version&&editorText()===request.text);
        }else{
          // Unknown platform-refilled words are archived separately. They must
          // neither vanish nor acquire an invented classroom identity.
          draft=freshLessonDraft();previous='';attachedItems.clear();
          const state=editState();state.unclassified=true;state.saved=true;state.valid=false;lessonSaving=true;
          await waitForSaved(persistQuestion('draft',request.text,false),request.target);lessonSaving=false;
          checkpoint(request.target);if(lessonInputVersion!==request.version||editorText()!==request.text)throw Error('问题已有新修改，当前输入已保留。');
          if(nodes.length){
            // Existing native attachments can still be sent normally. Keep
            // unproven sources unclassified instead of blocking the composer.
            state.ignoreRecovery=true;lessonReady=true;allowResume=false;warning='';return;
          }
        }
        writeText('',{replace:true});changed=true;draft=freshLessonDraft();previous='';attachedItems.clear();
      }
      lessonReady=true;publishComposer(true);
      if(current){
        if(saved.cleared&&current.draftManifest.workspaceReset&&!current.draftManifest.composerText.trim()&&!current.draftManifest.draft.items.length){
          // A durable empty workspace is an intentional clear, not a lost draft.
          const manifest=current.draftManifest;draft.course={...manifest.draft.course};for(const key of ['lessonKey','contextKey'])if(typeof manifest.draft[key]==='string')draft[key]=manifest.draft[key];editState().metadataEditedKeys=new Set(manifest.metadataEditedKeys||[]);mergeLessonMetadata(manifest.viewerCourse||{});
          editState().saved=true;editState().workspaceReset=true;editState().clearedFrom=saved.cleared.id;
          clearedDraft={question:saved.cleared,text:saved.cleared.draftManifest.composerText,empty:draft,target:conversation.snapshot(),foreignNames:nodes.map(attachmentName),keyboardUndo:true};
          await waitForSaved(persistQuestion(),conversation.snapshot());
        }else{busy=false;const result=await restoreSavedDraft(current,conversation.snapshot());if(result.requiresNew)throw Error('当前内容已保留，请从本讲提问记录继续草稿。');}
      }else{editState().saved=true;editState().workspaceReset=true;if(clearedCurrent){editState().clearedFrom=clearedCurrent.id;clearedDraft={question:clearedCurrent,text:clearedCurrent.draftManifest.composerText,empty:draft,target:conversation.snapshot(),foreignNames:attachmentNodes().map(attachmentName),keyboardUndo:true};}await waitForSaved(persistQuestion(),conversation.snapshot());}
      allowResume=false;resumeCandidates.clear();recoveryCandidates.clear();warning='';
    }catch(error){
      if((!conversation.isCurrent(request.target)||!workspaceCurrent(request.target))&&lessonInputVersion===request.version){lessonReady=false;lessonError='';warning='';return;}
      lessonError=error.message;warning=lessonError;
      if(changed&&editorText().trim())lessonReady=true;
    }finally{lessonSaving=false;busy=false;if(lessonRequest===request)lessonRequest=null;}
  }
  function storedDraftIds(){try{const value=JSON.parse(win.localStorage?.getItem(resumeStorageKey)||'[]');return Array.isArray(value)?value.filter(id=>typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id)).slice(-100):[]}catch{return []}}
  function rememberDraft(question){
    if(!question)return;
    try{if(!win.localStorage)return;const m=question.draftManifest,source=m?.draft?.restoredFrom?.id,ids=storedDraftIds().filter(id=>id!==question.id&&id!==source);
      if(question.status==='draft'&&m?.draft&&(m.composerText?.trim()||m.draft.items?.length||m.draft.removed?.length||draftCarryKeys(m.draft).length))ids.push(question.id);
      win.localStorage.setItem(resumeStorageKey,JSON.stringify(ids.slice(-100)));resumeCacheError='';
    }catch{resumeCacheError='草稿恢复位置未保存。';}
  }
  function resumeRequest(){
    if(!allowResume||!conversation.isCurrent(conversation.snapshot())||resumeQueryError||draft.items.length||draft.removed.length||previous||draft.plan||editState().ignoreRecovery)return null;
    const text=editorText(),cleared=new Set(clearedDraftIds()),ids=storedDraftIds().filter(id=>!cleared.has(id));if(!text.trim()||text===resumeProbeText||!ids.length)return null;
    resumeProbeText=text;return {resumeDraftIds:ids,resumeText:text};
  }
  function activeImageResume(){return resumeTask&&resumeOwner===draft&&workspaceCurrent(resumeTarget)&&conversation.isCurrent(resumeTarget)?resumeTask:null}
  function activeResume(){return recoveryWork&&recoveryWork.owner===draft&&workspaceCurrent(recoveryWork.target)&&conversation.isCurrent(recoveryWork.target)?recoveryWork.task:activeImageResume()}
  function resumeQueryFailed(requestId,message){
    const pending=resumeWait;if(!pending||pending.requestId!==requestId)return;
    win.clearTimeout(pending.timer);resumeWait=null;ledgerRequests.delete(requestId);
    if(!allowResume||!workspaceCurrent(pending.target)||!conversation.isCurrent(pending.target)||editorText()!==pending.resumeText)return;
    resumeQueryError='草稿恢复未完成：'+message;warning=resumeQueryError;renderPanel();
    win.clearTimeout(resumeQueryRetryTimer);
    if(resumeQueryRetries<3)resumeQueryRetryTimer=win.setTimeout(()=>{resumeQueryRetryTimer=0;if(!disposed&&allowResume&&conversation.isCurrent(pending.target)&&editorText()===pending.resumeText)retryResumeQuery();},[250,1000,3000][resumeQueryRetries++]);
  }
  function retryResumeQuery(){
    if(warning===resumeQueryError)warning='';resumeQueryError='';resumeProbeText='';allowResume=true;
    const request=resumeRequest();if(request)requestContext([],0,request);else{resumeQueryError='未找到可自动恢复的草稿，请从资料库选择。';warning=resumeQueryError;}renderPanel();
  }
  const clearedStorageKey='__zjf_cleared_drafts_v1';
  function clearedDraftIds(){try{const ids=JSON.parse(win.localStorage?.getItem(clearedStorageKey)||'[]');return Array.isArray(ids)?ids.filter(id=>typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id)).slice(-100):[]}catch{return []}}
  function rememberCleared(id,cleared){
    if(!win.localStorage)throw Error('暂时无法记住清空操作，当前草稿已保留。');
    const ids=clearedDraftIds().filter(value=>value!==id);if(cleared)ids.push(id);
    try{win.localStorage.setItem(clearedStorageKey,JSON.stringify(ids.slice(-100)))}catch{throw Error('清空操作尚未保存，当前草稿已保留。')}
  }
  const backgroundKey=draftBackgroundKey;
  function retainedContextKeys(){
    const logical=logicalDraftItems(draft),background=logical.filter(x=>x.kind==='board'||x.kind==='panorama'),keys=background.map(x=>backgroundKey(x,draft.contextKey||draft.lessonKey)).filter(Boolean);
    const required=draft.contextMaterials||draft.plan?.background&&draft.plan.logicalItems.filter(x=>x.kind==='board'||x.kind==='panorama')||[];
    const incomplete=new Set([...logical,...required].filter(x=>x.missingContext?.length).map(x=>draftContextKey(x,draft.contextKey||draft.lessonKey)));
    for(const context of new Set(required.map(x=>draftContextKey(x,draft.contextKey||draft.lessonKey)))){
      const sources=required.filter(x=>draftContextKey(x,draft.contextKey||draft.lessonKey)===context);
      if(!incomplete.has(context)&&sources.every(x=>background.some(y=>backgroundKey(y,context)===backgroundKey(x,context))||conversation.providedContext().includes(backgroundKey(x,context))))keys.push(context);
    }
    return [...new Set(keys)];
  }
  function operationSet(value=draft){if(!operations.has(value))operations.set(value,new Set());return operations.get(value)}
  function activeCarryKeys(){if(draft.inline&&(draft.inline.suppressed||!draft.inline.context))return [];const actual=draftTextParts(draft,editorText(),previous),expected=draftTextParts(draft,previous);return actual.valid&&expected.valid&&normalize(actual.head)===normalize(expected.head)?draftCarryKeys(draft):[];}
  function activeOperationIds(){const present=new Set([...logicalDraftItems(draft).map(x=>x.id),...activeCarryKeys()]),materials=operationItems.get(draft);return [...operationSet()].filter(id=>materials?.get(id)?.itemIds.some(itemId=>present.has(itemId)))}
  function deliveryContents(batch,isPlan){
    const requested=new Set((isPlan?batch.logicalItems:[batch.selection]).map(draftMaterialKey)),logical=logicalDraftItems(draft),active=logical.filter(x=>requested.has(draftMaterialKey(x))),present=new Set(active.map(draftMaterialKey));
    const tombstones=draft.logicalItems?draft.removedLogical||[]:draft.removed.filter(x=>x.kind!=='collection'),removed=new Set(tombstones.filter(x=>requested.has(draftMaterialKey(x))&&!present.has(draftMaterialKey(x))&&(draft.removalGenerations?.[draftMaterialKey(x)]||x.removalGeneration||0)>0).map(draftMaterialKey));
    const carry=isPlan?draftCarryKeys(draft,batch.carry||[]):[],presentCarry=new Set(activeCarryKeys()),hasCarry=isPlan&&(batch.carry||[]).some(x=>(x.questions||[]).some(q=>q.included!==false&&q.text?.trim())||x.extra||x.text);
    const complete=[...requested].every(key=>present.has(key)||removed.has(key))&&carry.every(key=>presentCarry.has(key))&&(!hasCarry||carry.length>0);
    return {removed:requested.size>0&&!active.length&&!hasCarry&&removed.size===requested.size,attached:complete&&!!(active.length||carry.length),count:new Set(active.map(x=>x.attachmentId||x.id)).size};
  }
  const composing=()=>composition?.draft===draft&&composition.node.isConnected;
  function draftManifest(){
    return {version:1,viewerInstance,viewerLessonKey:editState().unclassified?'':viewerLesson||draft.lessonKey,viewerCourse:editState().unclassified?{}:viewerLesson?viewerCourse:draft.course,workspaceReset:!!editState().workspaceReset,clearedFrom:editState().clearedFrom||'',conversationId:conversation.snapshot().conversationId,composerText:editorText(),previousComposerTexts:editState().previousTexts||[],previous,attachmentOrder:editState().order,pendingRemovals:[...editState().pendingRemovals].map(([name,value])=>[name,{itemId:value.itemId,time:value.time,keepQuestion:value.keepQuestion!==false}]),ready:!editState().source&&draft.items.every(x=>findNode(x)?.isConnected)&&!uploadState().pending&&!uploadState().error,draft:JSON.parse(JSON.stringify(draft,(key,value)=>key==='image'||key==='thumbnail'?undefined:value)),files:Object.fromEntries(draft.items.map(x=>[x.id,fileName(x)])),operationItems:[...(operationItems.get(draft)||new Map())].map(([operationId,value])=>({operationId,...value})),pendingFields:fieldValues(),metadataDirty:!!editState().metadataDirty,metadataEditedKeys:[...editState().metadataEditedKeys],clearedText:editState().clearedText,clearedPrefix:editState().clearedPrefix};
  }
  function recoveryOptions(){
    const target=conversation.snapshot();if(!target.conversationId.startsWith('c:')&&!resumeCandidates.size||draft.items.length||draft.removed.length||previous||editState().saved&&!resumeCandidates.size||editState().ignoreRecovery||!editor())return [];
    const options=[];for(const question of [...recoveryCandidates.values()].sort((a,b)=>(Date.parse(b.updatedAt)||b.revision||0)-(Date.parse(a.updatedAt)||a.revision||0))){
      const m=question.draftManifest,items=m?.draft?.items,resumable=resumeCandidates.has(question.id);
      if(!belongsToLesson(question)||clearedDraftIds().includes(question.id)||!validSavedDraft(question)||conversation.sendIntents().some(x=>x.questionId===question.id&&x.status==='sent')||question.conversationId!==target.conversationId&&!resumable||!(sameRecoveryText(m.composerText,editorText())||resumable&&matchesSavedText(m,editorText())))continue;
      if(items.length&&!m.ready&&!resumable||!items.length&&!m.draft.removed.length&&!draftCarryKeys(m.draft).length&&!m.composerText.trim())continue;
      if(!resumable&&items.some(x=>!attachmentNodes().some(node=>attachmentName(node)===m.files[x.id]&&node.querySelector('img'))))continue;
      const pendingNames=new Set([...(m.draft.materialEdit?.items||[]).map(fileName),...(m.draft.retiredUploads||[])]);
      const foreign=attachmentNodes().some(node=>!items.some(x=>m.files[x.id]===attachmentName(node))&&!pendingNames.has(attachmentName(node)));
      // Reconnect the same mounted classroom without asking again. A new
      // classroom instance requires Continue before missing images are uploaded.
      const present=items.every(item=>attachmentNodes().some(node=>attachmentName(node)===m.files[item.id]&&node.querySelector('img')));
      options.push({question,resumable,automatic:!foreign&&(present||!!viewerInstance&&m.viewerInstance===viewerInstance)&&(!!items.length||!!m.composerText.trim()&&!attachmentNodes().length)});
    }return options;
  }
  function validSavedDraft(question){
    const m=question?.draftManifest,d=m?.draft,items=d?.items;
    if(m?.pendingRemovals!==undefined&&(!Array.isArray(m.pendingRemovals)||m.pendingRemovals.length>300||m.pendingRemovals.some(entry=>!Array.isArray(entry)||entry.length!==2||typeof entry[0]!=='string'||!entry[1]||typeof entry[1].itemId!=='string'||!Number.isFinite(entry[1].time)||typeof entry[1].keepQuestion!=='boolean'||m.files?.[entry[1].itemId]!==entry[0])))return false;
    if(m?.metadataEditedKeys!==undefined&&(!Array.isArray(m.metadataEditedKeys)||m.metadataEditedKeys.length>4||new Set(m.metadataEditedKeys).size!==m.metadataEditedKeys.length||m.metadataEditedKeys.some(key=>!['school','course','teacher','notes'].includes(key))))return false;
    if(d?.inline&&(d.inline.version!==1||typeof d.inline.text!=='string'||!Array.isArray(d.inline.refs)||d.inline.refs.some(ref=>!ref||typeof ref.id!=='string'||typeof ref.token!=='string'||!Number.isSafeInteger(ref.start)||!Number.isSafeInteger(ref.end)||ref.start<0||ref.end<ref.start||d.inline.text.slice(ref.start,ref.end)!==ref.token)))return false;
    return question?.status==='draft'&&m?.version===1&&m.conversationId===question.conversationId&&d?.id===question.id&&typeof m.composerText==='string'&&typeof m.previous==='string'&&Array.isArray(items)&&items.length<=300&&Array.isArray(d.removed)&&d.removed.length<=300&&d.course&&d.questions&&Array.isArray(m.operationItems)&&(!d.logicalItems||Array.isArray(d.logicalItems))&&(!d.plan?.carry||Array.isArray(d.plan.carry))&&new Set(items.map(x=>x.id)).size===items.length&&items.every(x=>typeof x.id==='string'&&typeof x.label==='string'&&typeof m.files?.[x.id]==='string'&&m.files[x.id].startsWith('zjf-'+x.id+'-'));
  }
  const sameRecoveryText=(a,b)=>a.replace(/\n+$/,'')===b.replace(/\n+$/,'');
  const matchesSavedText=(manifest,text)=>sameRecoveryText(manifest.composerText,text)||(manifest.previousComposerTexts||[]).some(previous=>typeof previous==='string'&&sameRecoveryText(previous,text));
  function hasSavedAttachments(question,nodes=attachmentNodes()){
    const manifest=question.draftManifest,names=new Set(Object.values(manifest.files||{}));
    return !!manifest.draft.items.length&&names.size===manifest.draft.items.length&&nodes.length===names.size&&nodes.every(node=>names.has(attachmentName(node)))&&[...names].every(name=>nodes.some(node=>attachmentName(node)===name));
  }
  const sameRestoreContext=(a,b)=>!!a&&!!b&&['conversationId','route','pageId','documentEpoch','routeGeneration'].every(key=>a[key]===b[key]);
  async function restoreSavedDraft(question,target,expectedWorkspaceRevision){
    target=restoreTarget(operationTarget(target,expectedWorkspaceRevision),true);
    reconcileIdentity();checkpoint(target);
    if(!validSavedDraft(question))throw Error('这份草稿的恢复记录不完整，原文和图片仍在资料中。');
    if(recoveryWork?.sourceId===question.id&&workspaceCurrent(recoveryWork.target))await recoveryWork.task;checkpoint(target);
    if(busy||draft.materialEdit||composing())throw Error('请先完成当前输入或材料调整，再继续草稿。');
    if(draft.id===question.id||explicitRestore?.sourceId===question.id&&explicitRestore.draftId===draft.id&&conversation.isCurrent(explicitRestore.target)){
      if(activeResume())await activeResume();checkpoint(target);
      if(resumeNeeded===draft||draft.items.some(item=>!findNode(item)?.isConnected||!findNode(item).querySelector('img'))){needImageResume(draft,target,true);editState().imageResumeFailed=false;editState().imageResumeRetry=null;await resumeImages(target);}
      const uploads=uploadState();if(uploads.pending||uploads.error)throw Error(uploads.message);
      await waitForSaved(persistQuestion(),target);
    }else{
      const pending=explicitRestore?.sourceId===question.id&&sameRestoreContext(explicitRestore.target,conversation.snapshot())&&typeof explicitRestore.text==='string'&&sameRecoveryText(explicitRestore.text,editorText());
      if(target.conversationId.startsWith('c:')&&question.conversationId!==target.conversationId)return {requiresNew:true,target:conversation.snapshot()};
      const undoingClear=clearedDraft?.question?.id===question.id&&clearUndoAvailable();
      const names=new Set(Object.values(question.draftManifest.files||{})),matchesSource=(matchesSavedText(question.draftManifest,editorText())||belongsToLesson(question)&&hasSavedAttachments(question))&&attachmentNodes().every(node=>names.has(attachmentName(node)));
      if(!pending&&!matchesSource&&!undoingClear&&(editorText().trim()||attachmentNodes().length||draft.items.length||draft.removed.length||previous||draft.plan||editState().saved))return {requiresNew:true,target:conversation.snapshot()};
      if(activeResume())throw Error('另一份草稿仍在恢复，请稍候再试。');
      if(!pending){if(!matchesSource)writeText(question.draftManifest.composerText);explicitRestore={sourceId:question.id,target:conversation.snapshot(),text:editorText()};}
      allowResume=true;editState().ignoreRecovery=false;
      const restored=await recoverDraft(question.id,question,target);
      if(workspaceCurrent(target)&&conversation.isCurrent(target)&&(draft.id===question.id||draft.restoredFrom?.id===question.id))explicitRestore={sourceId:question.id,target:conversation.snapshot(),draftId:draft.id};
      if(!restored){checkpoint(target);throw Error(warning||'草稿恢复尚未确认，原记录已保留。');}
    }
    checkpoint(target);if(clearedDraftIds().includes(question.id))rememberCleared(question.id,false);return {restored:true,verified:true,sourceId:question.id,draftId:draft.id,target:conversation.snapshot(),count:draft.items.length,copy:draft.id!==question.id};
  }
  win.__ZJF_RESTORE_SAVED_DRAFT_V1__=restoreSavedDraft;
  function bindRecordedOperations(){
    const active=new Set(activeOperationIds());if(!editorText().trim()||uploadState().pending||uploadState().error)return;
    for(const [operationId,record]of operationItems.get(draft)||[]){if(!active.has(operationId)||activeDelivery?.operationId===operationId)continue;try{const delivery=conversation.beginDelivery({protocol:2,operationId,materialId:record.materialId,attemptId:crypto.randomUUID(),target:conversation.snapshot()});conversation.finishDelivery(delivery,{verifyDraft:()=>!!editorText().trim()&&draft.items.every(x=>findNode(x)?.isConnected)&&activeOperationIds().includes(operationId),count:draft.items.length});}catch(error){warning='草稿已保留，但投递记录需重新核对：'+error.message;}}
  }
  function recoverDraft(chosenId,explicitQuestion=null,restoreOwner=null){
    if(chosenId&&!restoreOwner)restoreOwner=restoreTarget(operationTarget(),true);
    if(recoveryWork&&recoveryWork.owner===draft&&workspaceCurrent(recoveryWork.target)&&conversation.isCurrent(recoveryWork.target))return recoveryWork.task;
    const options=recoveryOptions(),automatic=options.filter(x=>x.automatic),selected=explicitQuestion?{question:explicitQuestion,resumable:true,automatic:true}:chosenId?options.find(x=>x.question.id===chosenId):automatic.length===1?automatic[0]:null;if(!selected)return false;
    if(!chosenId&&(recoveryBlocked===selected.question.id||selected.resumable&&!allowResume))return false;
    if(chosenId)recoveryBlocked='';
    if(!workspaceActive())return false;
    const target=restoreOwner||restoreTarget(),owner=draft,text=editorText(),input=editor(),saved=editState().saved,order=attachmentNodes().map(x=>attachmentName(x)).join('\n'),requestId=crypto.randomUUID(),pending={target,sourceId:selected.question.id,result:null};claimRequests.set(requestId,pending);
    const work={target,owner,sourceId:selected.question.id,installed:false,task:null};recoveryWork=work;
    work.task=(async()=>{
      let claim=null;
      try{
        post({kind:'zjf-draft-claim',protocol:2,requestId,target,sourceId:selected.question.id,sourceConversationId:selected.question.conversationId,sourceRevision:selected.question.revision,ordinaryResume:!!selected.resumable&&allowResume,composerText:text});
        claim=await waitFor(()=>{if(pending.result?.error)throw Error(pending.result.error);return pending.result},12000,target);checkpoint(target);
        if(disposed||owner!==draft||editor()!==input||!sameRecoveryText(editorText(),text)||editState().saved!==saved||editState().ignoreRecovery||composing()||selected.resumable&&!allowResume||attachmentNodes().map(x=>attachmentName(x)).join('\n')!==order)throw Error('输入或附件已有变化，当前内容已保留。');
        installRecoveredDraft(selected,claim,target);work.owner=draft;work.installed=true;await discardMaterialEdit(draft,target);
        if(selected.resumable)await resumeImages(target);else{await waitForComposition(target);if(editState().needsSync)syncText();await waitForSaved(persistQuestion(),target);bindRecordedOperations();}
        checkpoint(target);if(work.owner!==draft)throw new ConversationChangedError();recoveryBlocked='';return true;
      }catch(error){if(!disposed&&work.owner===draft&&conversation.isCurrent(target)&&workspaceCurrent(target)){recoveryBlocked=selected.question.id;warning='草稿恢复未完成：'+error.message;renderPanel();}return false;}
      finally{claimRequests.delete(requestId);retireRequest(requestId);if(claim&&!work.installed&&workspaceCurrent(target)&&conversation.isCurrent(target))post({kind:'zjf-draft-release',protocol:2,target,draftId:claim.draftId});if(recoveryWork===work)recoveryWork=null;renderPanel();}
    })();renderPanel();return work.task;
  }
  function installRecoveredDraft(selected,claim,target=operationTarget()){
    const question=selected.question,m=question.draftManifest;draft={...newDraft(),...JSON.parse(JSON.stringify(m.draft)),id:claim.draftId};if(claim.disposition==='copy')draft.restoredFrom={id:question.id,revision:question.revision};previous=m.previous;attachedItems.clear();
    for(const name of draft.retiredUploads||[])if(typeof name==='string'&&name.startsWith('zjf-'))isolationNames.add(name);cleanIsolatedAttachments();
    for(const item of [...draft.items,...draft.removed]){item.image='';if(item.kind==='collection'){item.materialId??=draft.plan?.id;item.sourceMaterialId??=draft.plan?.sourceMaterialId||item.materialId;}if(draft.items.includes(item)){const node=attachmentNodes().find(x=>attachmentName(x)===m.files[item.id]);item.__fileName=m.files[item.id];if(node){item.thumbnail=node.querySelector('img')?.src||'';attachedItems.add(item.id);}else{delete item.__fileName;item.__fileToken='';item.__targetStamp='';item.__uploadRequested=false;}}}
    for(const logical of [...(draft.logicalItems||[]),...(draft.removedLogical||[])]){const physical=[...draft.items,...draft.removed].find(x=>x.id===logical.attachmentId);logical.materialId??=physical?.materialId;logical.sourceMaterialId??=physical?.sourceMaterialId;}
    const state=editState();state.saved=true;state.lastText=editorText();state.editorNode=editor();state.previousTexts=[...(m.previousComposerTexts||[])];state.fields=new Map(Object.entries(m.pendingFields||{}));state.metadataDirty=!!m.metadataDirty;state.metadataEditedKeys=new Set(m.metadataEditedKeys||[]);state.order=typeof m.attachmentOrder==='string'?m.attachmentOrder:'';state.needsSync=!!(state.fields.size||state.metadataDirty||!draft.inline);state.clearedText=typeof m.clearedText==='string'?m.clearedText:null;state.clearedPrefix=typeof m.clearedPrefix==='string'?m.clearedPrefix:null;state.workspaceReset=!!m.workspaceReset;state.clearedFrom=m.clearedFrom||'';
    if(belongsToLesson(question)&&mergeLessonMetadata(m.viewerCourse||{})){state.metadataDirty=true;state.needsSync=true;}
    state.pendingRemovals=new Map((m.pendingRemovals||[]).map(([name,value])=>[name,{...value,attempts:0,after:0}]));
    if(selected.resumable&&!sameRecoveryText(editorText(),m.composerText)&&matchesSavedText(m,editorText()))writeText(m.composerText);
    if(sameRecoveryText(editorText(),m.composerText)){
      const candidate={...draft,inline:structuredClone(draft.inline),questions:{...draft.questions}},repaired=repairLegacyInlineContext(candidate,m,positions());
      if(repaired!==null){writeText(repaired,{replace:true});for(const key of ['inline','questions','questionPrelude','extra','items','removed'])draft[key]=candidate[key];previous=repaired;state.needsSync=true;}
    }
    const materials=new Map();for(const record of m.operationItems){if(typeof record.operationId!=='string'||typeof record.materialId!=='string'||!Array.isArray(record.itemIds))continue;operationSet().add(record.operationId);materials.set(record.operationId,{materialId:record.materialId,itemIds:record.itemIds});}
    operationItems.set(draft,materials);savedVersion=Math.max(savedVersion,question.revision||0,claim.revision||0);const currentParts=getQuestions(),oldHead=draftTextParts(draft,previous),nextHead=draftTextParts(draft,draftPrompt(draft,positions()));if(currentParts.valid&&oldHead.valid&&nextHead.valid&&normalize(currentParts.head)===normalize(oldHead.head)&&normalize(oldHead.head)!==normalize(nextHead.head))state.needsSync=true;
    if(claim.disposition==='copy'||question.conversationId!==conversation.snapshot().conversationId){operations.set(draft,new Set());operationItems.set(draft,new Map());}
    if(selected.resumable){allowResume=false;unboundDraftWarning=false;warning='';needImageResume(draft,target,true);}
    else bindRecordedOperations();warning=saveWarning?.message||warning;renderPanel();return true;
  }
  function resumeImages(restoreOwner=null){
    const pending=activeImageResume();if(pending)return pending;const owner=resumeNeeded;if(!owner||owner!==draft)return Promise.resolve();const state=editState(owner),target=restoreOwner||state.imageResumeTarget;if(!target||target!==state.imageResumeTarget||!workspaceCurrent(target)||!conversation.isCurrent(target))return Promise.resolve();
    const task=(async()=>{if(owner.attachmentOrderPending&&owner.items.length){const first=owner.items.find(item=>item.id===owner.attachmentOrderPending)||owner.items[0];await restoreAttachmentOrder({items:[first]},target);checkpoint(target);if(owner!==draft)throw new ConversationChangedError();delete owner.attachmentOrderPending;}for(const item of [...owner.items]){checkpoint(target);if(owner!==draft)throw new ConversationChangedError();if(owner.items.includes(item))await attach(item,target);}await waitForUploads(target);await waitForComposition(target);checkpoint(target);if(owner!==draft||target!==editState().imageResumeTarget)throw new ConversationChangedError();if(editState().needsSync)syncText();else{getQuestions();editState().order=attachmentOrder();}await waitForSaved(persistQuestion(),target);checkpoint(target);if(owner!==draft||target!==editState().imageResumeTarget)throw new ConversationChangedError();resumeNeeded=null;const state=editState(),failure=state.imageResumeError;if(failure&&[failure,'草稿恢复未完成：'+failure,'图片未附齐：'+failure].includes(lessonError))lessonError='';state.imageResumeFailed=false;state.imageResumeError='';state.imageResumeRetry=null;state.imageResumeTarget=null;state.missingAttachments.clear();state.uploadDiagnostic=null;warning='';publishComposer(true);bindRecordedOperations();})()
      .catch(error=>{if(owner===draft&&conversation.isCurrent(target)&&workspaceCurrent(target)&&target===editState().imageResumeTarget){const state=editState();state.imageResumeFailed=true;state.imageResumeError||=error.message;const retry=state.imageResumeRetry;if(!retry)state.imageResumeRetry={target,attempts:0,after:Date.now()+500};else retry.after=Date.now()+[500,1500,3500][Math.min(retry.attempts,2)];warning='图片未附齐：'+error.message;persistQuestion();}throw error;})
      .finally(()=>{if(resumeTask===task){resumeTask=null;if(owner===draft)renderPanel();}});resumeOwner=owner;resumeTarget=target;resumeTask=task;renderPanel();return task;
  }
  function postQuestion(question,target=conversation.snapshot()){
    if(question.status!=='draft')rememberDraft(question);
    savedVersion=Math.max(savedVersion,question.revision||0);questionSnapshots.set(question.id,JSON.parse(JSON.stringify(question)));if(conversation.isCurrent(target)){const requestId=crypto.randomUUID();saveRequests.set(requestId,{id:question.id,revision:question.revision,status:question.status,sendId:question.sendId,at:Date.now(),target});post({kind:'zjf-question-save',protocol:2,requestId,target,question});}
  }
  function persistQuestion(status='draft',rawText,readEditor=true){
    if(hasLessonContext&&!lessonReady&&!lessonSaving)return;
    const state=editState();let text=rawText??editorText();if(!draft.items.length&&!draft.removed.length&&!previous&&!draft.plan&&!state.saved&&!text.trim())return;
    if(readEditor)getQuestions(text);const logical=logicalDraftItems(draft),fields=fieldValues();let structured=state.valid&&!Object.keys(fields).length;
    if(rawText===undefined&&status==='draft'&&(Object.keys(fields).length||state.metadataDirty)){
      const preview={...draft,questions:{...draft.questions}},source=editSource(),previewSource=source===draft?preview:{...source,questions:{...source.questions}};
      try{text=mergeDraftPrompt(preview,text,editPrevious(),positions(),{sourceDraft:previewSource,questionOverrides:fields});structured=true;}
      catch{structured=false;if(Object.keys(fields).length)text+='\n\n【面板中待合并的问题】\n'+Object.entries(fields).map(([id,value])=>(id==='questionPrelude'?'共同问题':(logical.find(x=>x.id===id)||logicalDraftItems(source).find(x=>x.id===id))?.label||'问题')+'：\n'+value).join('\n\n');}
    }
    const activeQuestions=draftQuestionItems(draft),materialQuestions=[...activeQuestions,...draft.removed,...(draft.removedLogical||[]),...(draft.archivedQuestions||[])].filter(x=>x.kind==='selection'||x.ask||activeQuestions.includes(x)).filter((x,i,list)=>list.findIndex(y=>y.id===x.id)===i).map(x=>({id:x.id,label:x.label,source:draft.plan?x.source:[x.markTitle,x.source||x.label].filter(Boolean).join(' / '),text:(draft.inline?draft.inline.singleQuestions?.[x.id]:draft.questions[x.id])||'',included:structured&&activeQuestions.includes(x),ref:x.ref||{markId:x.markId,snapshotId:x.snapshotId,itemId:x.id}}));
    const asked=draftQuestionItems(draft),commonItems=asked.length?asked:logical;
    const common=draft.questionPrelude?.trim()?[{id:'questionPrelude',label:draft.inline?'问题':'共同问题',source:draft.inline?'提问正文':'本次所选材料',text:draft.questionPrelude,included:structured,refs:draft.inline?[]:commonItems.map(x=>x.ref||{markId:x.markId,snapshotId:x.snapshotId,itemId:x.id}).filter(x=>x.snapshotId)}]:[];
    const shared=(draft.inline?.shared||[]).map(part=>({id:part.id,label:'共同问题',source:'本次所选材料',text:part.text,refs:part.refs,included:structured}));
    const carried=carriedDraftQuestions(draft).map(q=>({...q,included:structured})),questions=[...common,...materialQuestions,...shared,...carried],carry=(draft.plan?.carry||[]).map(old=>({...old,included:structured&&old.included!==false,questions:(old.questions||[]).filter(q=>q.included!==false&&q.text?.trim()).map(q=>({...q,ref:q.ref?{...q.ref}:undefined,included:structured&&old.included!==false}))}));
    const refs=logical.map(x=>x.ref||{markId:x.markId,snapshotId:x.snapshotId,itemId:x.id}).filter(x=>x.snapshotId);
    const prefix=structured?draftTextParts(draft,text,editPrevious()).prefix?.trim():'';
    const prefixTitle=prefix&&!prefix.includes(DRAFT_START)?prefix.replace(/^【保留的原提问】\s*\n/,'').replace(/^│ ?/gm,'').trim():'';
    const target=conversation.snapshot(),data={id:draft.id,revision:++savedVersion,status,title:(structured?draft.questionPrelude||questions.find(x=>x.included&&x.text.trim())?.text||prefixTitle||draft.extra?.trim()||carry.find(x=>x.included&&x.title?.trim())?.title||draft.plan?.title||draft.course.course||'板书提问':text.trim()||'板书提问').slice(0,70),questions,carry,refs,format:structured?'structured':'freeform',pendingFields:fieldValues(),contextKeys:retainedContextKeys(),markTitles:[...new Set(logical.map(x=>x.markTitle).filter(Boolean))],extra:structured?[prefix,draft.plan?.carryTextOverride,draft.extra].filter(Boolean).join('\n\n'):text,text,conversationId:target.conversationId,conversationUrl:canonicalConversationId(win.location.href)?win.location.href:'',draftManifest:draftManifest()};
    state.saved=true;postQuestion(data);return data;
  }
  const normalize=text=>text.replace(/\s+/g,' ').trim();
  const editor=()=>[...page.querySelectorAll('[data-composer-markdown][contenteditable="true"],#prompt-textarea[contenteditable="true"],textarea#prompt-textarea,textarea#mobile-composer-prompt')].find(e=>e.isConnected&&!e.disabled&&!e.readOnly&&e.getClientRects().length&&layoutWindow.getComputedStyle(e).visibility!=='hidden')||null;
  function composerUploadInputs(){
    const input=editor(),form=input?.closest('form'),body=input?.closest('[data-composer-body]');
    const controls=[...(form?.elements||[]),...(body?.querySelectorAll('input[type="file"]')||[])];
    return {input,form,body,controls:[...new Set(controls)].filter(control=>control.matches?.('input[type="file"]')&&(form&&control.form===form||body&&control.closest('[data-composer-body]')===body&&(!control.form||control.form===form)))};
  }
  function uploadInput(mime){
    const own=composerUploadInputs(),extension=mime==='image/jpeg'?'.jpg':'.png',aliases=mime==='image/jpeg'?['.jpg','.jpeg']:['.png'],choices=[];
    for(const input of own.controls){
      if(input.matches(':disabled'))continue;const accept=input.accept.trim().toLowerCase(),types=accept.split(',').map(type=>type.trim()).filter(Boolean),direct=types.includes(mime),image=types.includes('image/*')||types.includes('*/*'),suffix=aliases.find(alias=>types.includes(alias));
      if(!accept||direct||image||suffix)choices.push({input,extension:!accept||direct||image?extension:suffix,rank:(own.form&&input.form===own.form?10:0)+(!accept?3:direct?2:image?1:0)});
    }
    const rank=Math.max(-1,...choices.map(choice=>choice.rank)),best=choices.filter(choice=>choice.rank===rank);return best.length===1?best[0]:null;
  }
  function unavailableUpload(mime,target){
    const own=composerUploadInputs(),all=[...page.querySelectorAll('input[type="file"]')],ancestors=[];for(let node=own.input;node&&ancestors.length<6;node=node.parentElement)ancestors.push(node);
    const path=ancestors.map(node=>node.tagName+(node.hasAttribute('data-composer-body')?'[composer]':'')),details={mime,files:all.length,owned:own.controls.length,path,inputs:all.slice(0,2).map(input=>({accept:input.accept.slice(0,40),disabled:input.matches(':disabled'),form:own.form&&input.form===own.form?'editor':input.form?'other':'none',body:!!own.body&&input.closest('[data-composer-body]')===own.body,shared:ancestors.findIndex(node=>node.contains(input))}))};
    editState().uploadDiagnostic={target,message:'upload-input:'+JSON.stringify(details).slice(0,360)};publishComposer(true);
    const error=Error('ChatGPT 当前无法接收图片，截图和问题已保留。');error.code='upload_input_unavailable';return error;
  }
  function composerState(){
    const e=editor(),loginRequired=!!e?.closest('form[data-logged-out]'),diagnostic=editState().uploadDiagnostic;
    return {composerReady:workspaceActive()&&!!e&&!loginRequired&&lessonReady&&!lessonWork,composerDraftId:draft.id,composerError:loginRequired?'请先登录 ChatGPT，再附上截图。':[lessonError,diagnostic&&workspaceCurrent(diagnostic.target)&&conversation.isCurrent(diagnostic.target)?diagnostic.message:''].filter(Boolean).join(' | ').slice(0,512)};
  }
  function publishComposer(force=false){
    if(!conversation.isCurrent(conversation.snapshot()))return;
    const state=composerState(),signature=JSON.stringify(state);
    if(force||signature!==reportedComposer){reportedComposer=signature;post({...conversation.handshake(),...state});}
  }
  const editorText=()=>{const e=editor();return e?('value'in e?e.value:e.innerText).replace(/\r/g,''):''};
  function removeControl(node){
    return node?.querySelector('button[aria-label^="移除"],button[aria-label^="Remove"],button[aria-label^="删除"]')||node?.closest('[class~="group/composer-attachment"]')?.querySelector('button[aria-label^="移除"],button[aria-label^="Remove"],button[aria-label^="删除"]')||null;
  }
  const attachmentName=node=>node.getAttribute('aria-label')||node.querySelector('.composer-attachment-surface[aria-label]')?.getAttribute('aria-label')||removeControl(node)?.getAttribute('aria-label')?.replace(/^(?:移除|Remove|删除)\s*[“"]?/,'').replace(/[”"]$/,'')||'';
  const attachmentFailed=node=>/上传失败|上传未成功|无法上传|upload failed|upload unsuccessful|error uploading/i.test(node?.innerText||'')||!!node?.querySelector('[aria-invalid="true"],[role="alert"]');
  function attachmentNodes(){
    const e=editor(),scope=e?.closest('form')||e?.closest('[data-composer-body]')||e?.parentElement;if(!scope)return [];
    const nodes=[...scope.querySelectorAll('.composer-attachment-surface[role="button"][aria-label]')];
    for(const surface of scope.querySelectorAll('.composer-attachment-surface')){const container=surface.closest('[class~="group/composer-attachment"]');if(container&&scope.contains(container)&&!nodes.some(node=>container===node||container.contains(node))&&attachmentName(container))nodes.push(container);}
    return nodes.filter(node=>node.getClientRects().length&&layoutWindow.getComputedStyle(node).visibility!=='hidden');
  }
  const attachments=()=>attachmentNodes().filter(e=>e.querySelector('img'));
  const findNode=item=>attachmentNodes().find(e=>attachmentName(e)===fileName(item));
  const fileName=item=>item.__fileName||'zjf-'+item.id+(item.__fileToken?'-'+item.__fileToken:'')+'-'+item.label.replace(/[^\p{L}\p{N}-]/gu,'')+(item.image?.startsWith('data:image/jpeg')?'.jpg':'.png');
  function compactInactiveDraft(value,seen=new Set(),activeItems=new Set([...draft.items,...draft.removed,...draft.logicalItems||[],...draft.removedLogical||[],...draft.materialEdit?.items||[]])){
    if(!value||value===draft||seen.has(value))return;seen.add(value);
    const state=edits.get(value);if(state){state.editorNode=null;compactInactiveDraft(state.source?.draft,seen,activeItems);}
    for(const item of [...value.items,...value.removed,...value.logicalItems||[],...value.removedLogical||[],...value.detachedQuestions||[],...value.materialEdit?.items||[]]){
      const reference=item.ref||item,restorable=reference.snapshotId&&(reference.itemId||reference.id)||item.kind==='collection'&&(item.materialId||value.plan?.id);
      if(restorable&&!activeItems.has(item)){item.__fileName??=fileName(item);delete item.image;delete item.thumbnail;}
    }
  }
  function trimDraftCache(){
    const protectedIds=new Set([draft.id,clearedDraft?.question?.id,...conversation.sendIntents().filter(intent=>intent.status!=='sent').map(intent=>intent.questionId),...[...saveRequests.values()].map(request=>request.id)]);
    let bytes=0;const sizes=new Map();
    for(const [key,entry]of drafts){if(entry.bytes===undefined){compactInactiveDraft(entry.draft);const state=edits.get(entry.draft);entry.bytes=new TextEncoder().encode(JSON.stringify({draft:entry.draft,previous:entry.previous,text:state?.lastText,previousTexts:state?.previousTexts,fields:state?[...state.fields]:[],source:state?.source})).length;}sizes.set(key,entry.bytes);bytes+=entry.bytes;}
    for(const [key,entry]of drafts){
      if(drafts.size<=8&&bytes<=4*1024*1024)break;
      const snapshot=questionSnapshots.get(entry.draft.id);
      if(protectedIds.has(entry.draft.id)||!snapshot||(savedRevisions.get(snapshot.id)||0)<snapshot.revision)continue;
      drafts.delete(key);bytes-=sizes.get(key)||0;
    }
    const retained=new Set([...protectedIds,...[...drafts.values()].map(entry=>entry.draft.id)]);
    for(const [id,question]of questionSnapshots)if(!retained.has(id)&&(savedRevisions.get(id)||0)>=question.revision){questionSnapshots.delete(id);savedRevisions.delete(id);}
  }
  const userMessages=()=>[...page.querySelectorAll('[data-message-author-role="user"],[data-testid="user-message"],[data-chatgpt-search-unit-key$=":user"][data-chatgpt-search-message-ids]')];
  const userMessageText=node=>node.querySelector('[data-markdown-text-tone="user-message"],[data-user-message-bubble] .whitespace-pre-wrap')?.innerText??node.innerText;
  const seeded=key=>conversation.providedContext().includes(key);
  function mapCaret(index,before,after){
    let prefix=0,suffix=0;while(prefix<before.length&&prefix<after.length&&before[prefix]===after[prefix])prefix++;
    while(suffix<before.length-prefix&&suffix<after.length-prefix&&before[before.length-1-suffix]===after[after.length-1-suffix])suffix++;
    if(index<=prefix)return index;if(index>=before.length-suffix)return Math.max(0,after.length-(before.length-index));
    const left=before.slice(Math.max(0,index-24),index),right=before.slice(index,index+24),match=after.indexOf(left+right);
    return match>=0?match+left.length:Math.min(index,after.length);
  }
  // Unique unchanged lines anchor separate edits, so an updated image number
  // and an appended question never replace the user's text between them.
  function textEdits(before,after){
    const lines=text=>{let offset=0;return (text.match(/[^\n]*\n|[^\n]+$/g)||[]).map(text=>{const line={text,start:offset};offset+=text.length;return line})},left=lines(before),right=lines(after),a=new Map(),b=new Map();
    for(const line of left)a.set(line.text,a.has(line.text)?null:line);
    for(const line of right)b.set(line.text,b.has(line.text)?null:line);
    const matches=left.filter(line=>line.text.trim()&&a.get(line.text)&&b.get(line.text)).map(line=>({left:line,right:b.get(line.text)})),tails=[],links=[];
    for(let i=0;i<matches.length;i++){let lo=0,hi=tails.length;while(lo<hi){const mid=(lo+hi)>>1;if(matches[tails[mid]].right.start<matches[i].right.start)lo=mid+1;else hi=mid}links[i]=lo?tails[lo-1]:-1;tails[lo]=i;}
    const anchors=[];for(let i=tails.at(-1);i!==undefined&&i>=0;i=links[i])anchors.push(matches[i]);anchors.reverse();
    const edits=[];let start=0,next=0;
    for(const anchor of [...anchors,{left:{start:before.length,text:''},right:{start:after.length,text:''}}]){
      let end=anchor.left.start,value=after.slice(next,anchor.right.start),old=before.slice(start,end),prefix=0,suffix=0;
      while(prefix<old.length&&prefix<value.length&&old[prefix]===value[prefix])prefix++;
      while(suffix<old.length-prefix&&suffix<value.length-prefix&&old[old.length-1-suffix]===value[value.length-1-suffix])suffix++;
      if(prefix+suffix<old.length||prefix+suffix<value.length)edits.push({start:start+prefix,end:end-suffix,text:value.slice(prefix,value.length-suffix)});
      start=anchor.left.start+anchor.left.text.length;next=anchor.right.start+anchor.right.text.length;
    }
    return edits;
  }
  function richTextPoints(e,text,selection){
    const points=[[e,0]],walker=page.createTreeWalker(e,win.NodeFilter.SHOW_TEXT|win.NodeFilter.SHOW_ELEMENT);let node;
    while((node=walker.nextNode())){if(node.nodeType===3)points.push([node,0],[node,node.length]);else if(node.tagName==='BR'){const index=[...node.parentNode.childNodes].indexOf(node);points.push([node.parentNode,index],[node.parentNode,index+1]);}}
    points.push([e,e.childNodes.length]);
    const lengths=new Map(),lengthAt=index=>{if(lengths.has(index))return lengths.get(index);const range=page.createRange();range.setStart(e,0);range.setEnd(...points[index]);selection.removeAllRanges();selection.addRange(range);const prefix=selection.toString().replace(/\r/g,'');if(!text.startsWith(prefix))throw Error('输入框格式暂不支持局部更新，原文已保留。');lengths.set(index,prefix.length);return prefix.length};
    return index=>{
      let lo=0,hi=points.length-1;while(lo<hi){const mid=(lo+hi)>>1;if(lengthAt(mid)<index)lo=mid+1;else hi=mid}
      if(lengthAt(lo)===index)return points[lo];
      const prior=points[lo-1],point=points[lo];if(prior&&prior[0]===point[0]&&point[0].nodeType===3){const offset=prior[1]+index-lengthAt(lo-1);if(offset>=prior[1]&&offset<=point[1])return [point[0],offset]}
      if(index>=lengthAt(points.length-1)&&!text.slice(lengthAt(points.length-1),index).replace(/\n/g,''))return points.at(-1);
      throw Error('输入框段落边界暂不能可靠更新，原文已保留。');
    };
  }
  function outsideFocusOwner(){
    if(page.hasFocus?.())return null;
    try{let owner=page;for(let view=page.defaultView;view?.frameElement;view=view.frameElement.ownerDocument.defaultView)owner=view.frameElement.ownerDocument;if(owner===page)return null;
      let active=owner.activeElement;while(active?.contentDocument?.activeElement){owner=active.contentDocument;active=owner.activeElement;}return owner===page?null:active;
    }catch{return null}
  }
  function writeText(text,{replace=false}={}){
    if(!workspaceActive())throw new ConversationChangedError();
    const owner=draft;reconcileIdentity();if(owner!==draft)throw new ConversationChangedError();
    if(activeDelivery)checkpoint(activeDelivery);
    if(composing())throw Error('请完成当前文字输入后再整理说明。');
    const e=editor();if(!e)throw Error('ChatGPT 输入框尚未就绪，请先完成登录。');
    const old=page.activeElement,externalFocus=outsideFocusOwner(),hadPageFocus=page.hasFocus?.()??true,before=editorText(),selection=win.getSelection(),savedRanges=selection?[...Array(selection.rangeCount)].map((_,i)=>selection.getRangeAt(i).cloneRange()):[],ranges=old!==e?savedRanges:null,oldCaret=typeof old?.selectionStart==='number'?[old.selectionStart,old.selectionEnd]:null;let caret=null;
    // The site's trailing placeholder BR is not user text. Leave it alone.
    if(!replace&&before.trim())text=text.replace(/\n+$/,'')+(before.match(/\n+$/)?.[0]||'');
    if(before===text)return;
    if(old===e){if('value'in e)caret=[e.selectionStart,e.selectionEnd];else if(selection?.rangeCount&&e.contains(selection.anchorNode)&&e.contains(selection.focusNode)){const r=selection.getRangeAt(0).cloneRange(),prefix=page.createRange();prefix.selectNodeContents(e);prefix.setEnd(r.startContainer,r.startOffset);selection.removeAllRanges();selection.addRange(prefix);const start=selection.toString().length;prefix.setEnd(r.endContainer,r.endOffset);selection.removeAllRanges();selection.addRange(prefix);caret=[start,selection.toString().length];selection.removeAllRanges();selection.addRange(r);}}
    writing=true;
    try{
      const changes=replace||!before?[{start:0,end:before.length,text}]:textEdits(before,text);
      if('value'in e){for(const change of changes.reverse())e.setRangeText(change.text,change.start,change.end,'preserve');e.dispatchEvent(new win.Event('input',{bubbles:true}))}
      else{
        const point=richTextPoints(e,before,selection),patches=changes.map(change=>{const range=page.createRange();if(replace||!before)range.selectNodeContents(e);else{range.setStart(...point(change.start));range.setEnd(...point(change.end));}return {...change,range}});
        for(const change of patches.reverse()){
          selection.removeAllRanges();selection.addRange(change.range);
          const safe=change.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),html=(replace||!before)?safe?'<p>'+safe.replace(/\n/g,'<br>')+'</p>':'':safe.replace(/\n/g,'<br>');
          const insert=()=>page.execCommand(html?'insertHTML':'delete',false,html);
          let inserted=insert();if(!inserted&&hadPageFocus){e.focus({preventScroll:true});inserted=insert()}if(!inserted)throw Error('ChatGPT 输入框暂不支持局部更新，图片和现有文字已保留。');
        }
      }
      if(!sameRecoveryText(editorText(),text))throw Error('输入框更新未完成，原文和图片已保留。');
      if(caret&&page.activeElement===e){const after=editorText(),a=mapCaret(caret[0],before,after),b=mapCaret(caret[1],before,after);if('value'in e)e.setSelectionRange(a,b);else{const point=richTextPoints(e,after,selection),range=page.createRange();range.setStart(...point(a));range.setEnd(...point(b));selection.removeAllRanges();selection.addRange(range)}}
    }finally{
      writing=false;
      const mayRestore=(page.hasFocus?.()??true)&&(page.activeElement===e||page.activeElement===page.body);
      if(mayRestore&&ranges&&!('value'in e)){selection.removeAllRanges();for(const range of ranges)if(range.commonAncestorContainer.isConnected)selection.addRange(range);}
      if(mayRestore&&hadPageFocus&&old&&old!==e&&old.isConnected){old.focus({preventScroll:true});if(oldCaret)old.setSelectionRange(...oldCaret);}
      if(mayRestore&&old===page.body&&page.activeElement===e)e.blur();
      if(mayRestore&&externalFocus?.isConnected&&page.hasFocus?.())externalFocus.focus({preventScroll:true});
    }
    const state=editState();state.editorNode=e;state.lastText=editorText();
    if(state.saved&&before.trim()&&before.length<=100000&&!sameRecoveryText(before,state.lastText))state.previousTexts=[...(state.previousTexts||[]).filter(value=>!sameRecoveryText(value,before)),before].slice(-4);
  }
  function positions(){const all=attachments();return Object.fromEntries(draft.items.map(x=>[x.id,all.indexOf(findNode(x))+1]).filter(([,n])=>n>0))}
  function prepareNewChat({savingOnly=false,saveBudget=8000}={}){
    if(newChatPreparation)return newChatPreparation;
    newChatPreparation=(async()=>{
      if(!savingOnly)reconcileIdentity();if(composing())throw Error('请先完成当前输入，再切换对话。');if(!savingOnly)flushFieldCommit();
      const owner=draft,target=savingOnly?conversation.snapshot():operationTarget(),input=editor(),text=editorText(),fields=JSON.stringify(fieldValues()),course=JSON.stringify(draft.course),items=draft.items.map(x=>x.id).join('|');
      const state=editState(),known=!!(draft.items.length||draft.removed.length||previous||draft.plan||state.saved);
      if(known&&!input)throw Error('提问输入框尚未就绪，原草稿已保留。');
      // ChatGPT can restore home-page text across WebView restarts. Archive that
      // otherwise unbound text before honoring an explicit clean New chat.
      if(!known&&text.trim()){state.saved=true;state.valid=false;}
      if(savingOnly&&!lessonReady&&!known)state.unclassified=true;
      const sending=conversation.sendIntents().find(x=>x.questionId===owner.id&&x.status!=='sent');
      const saved=sending?saveIntent(sending):known?persistQuestion():text.trim()?persistQuestion('draft',text,false):null;
      if(saved)await waitFor(()=>{if(disposed||!conversation.isCurrent(target))throw new ConversationChangedError();if(saveWarning?.id===saved.id&&saveWarning.revision>=saved.revision)throw Error(saveWarning.message);return (savedRevisions.get(saved.id)||0)>=saved.revision},Math.min(8000,saveBudget),savingOnly?null:target);
      if(disposed||owner!==draft||!savingOnly&&!workspaceCurrent(target)||!conversation.isCurrent(target)||input!==editor()||text!==editorText()||fields!==JSON.stringify(fieldValues())||course!==JSON.stringify(draft.course)||items!==draft.items.map(x=>x.id).join('|'))throw Error('草稿已有新修改，当前内容已保留。');
      const prepared={target,owner,input,text,fields,course,items,cleared:false};if(!savingOnly)preparedNewChat=prepared;return prepared;
    })().finally(()=>{newChatPreparation=null});return newChatPreparation;
  }
  function newChatVisible(node){const r=node.getBoundingClientRect();return r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<win.innerWidth&&r.top<win.innerHeight&&win.getComputedStyle(node).visibility!=='hidden'}
  const preparedNavigationCurrent=(prepared,button)=>prepared===preparedNewChat&&!disposed&&prepared.owner===draft&&workspaceCurrent(prepared.target)&&conversation.isCurrent(prepared.target)&&prepared.input===editor()&&prepared.text===editorText()&&prepared.fields===JSON.stringify(fieldValues())&&prepared.course===JSON.stringify(draft.course)&&prepared.items===draft.items.map(x=>x.id).join('|')&&button.isConnected&&newChatVisible(button);
  async function commitNewChat(button){
    const prepared=await prepareNewChat();
    if(!preparedNavigationCurrent(prepared,button))throw new ConversationChangedError();
    prepared.cleared=true;button.click();return true;
  }
  async function commitHistoryNavigation(anchor){const prepared=await prepareNewChat();if(!preparedNavigationCurrent(prepared,anchor))throw new ConversationChangedError();preparedHistory={anchor,prepared};anchor.click();}
  async function startNewChat(expectedWorkspaceRevision){
    const target=operationTarget(undefined,expectedWorkspaceRevision);reconcileIdentity();checkpoint(target);const text=editorText();
    const find=pattern=>[...page.querySelectorAll('button,a')].find(node=>newChatVisible(node)&&pattern.test((node.getAttribute('aria-label')||node.textContent||'').trim()));
    const name=/^(?:新聊天|New chat)(?:\s*[（(].*[)）])?$/i;let button=find(name);
    if(!button){const toggle=find(/^(?:显示侧边栏|打开侧边栏|Show sidebar|Open sidebar)$/i);if(!toggle)throw Error('新对话入口暂不可用。');toggle.click();button=await waitFor(()=>find(name),1500,target);}
    checkpoint(target);if(editorText()!==text)throw new ConversationChangedError();
    return commitNewChat(button);
  }
  win.__ZJF_START_NEW_CHAT_V1__=startNewChat;
  async function saveBeforeClose(){
    const hidden=!workspaceActive(),deadline=Date.now()+10000,remaining=()=>Math.max(1,deadline-Date.now());
    if(closeFrozen){const target=conversation.snapshot();await waitFor(()=>{if(disposed||!conversation.isCurrent(target))throw new ConversationChangedError();return !busy&&!removingItems.size&&!newChatPreparation&&!lessonWork;},Math.min(3000,remaining()),null);}
    if(!hidden&&hasLessonContext&&!lessonReady){requestLesson();await waitFor(()=>{if(lessonError)throw Error(lessonError);return lessonReady&&!lessonWork},remaining(),operationTarget());}
    if(busy||(!hidden&&draft.materialEdit)||activeResume()||removingItems.size||newChatPreparation||composing())throw Error('请先完成当前输入或附图，再退出助手。');
    const uploads=uploadState();if(!hidden&&(uploads.pending||uploads.error))throw Error(uploads.message);
    checkSent();
    if(hidden&&reconcileAttachments())editState().needsSync=true;
    const wasSaving=lessonSaving;if(hidden&&!lessonReady)lessonSaving=true;
    try{
      const prepared=await prepareNewChat({savingOnly:true,saveBudget:remaining()});
      const target=conversation.snapshot();
      await waitFor(()=>{
        if(disposed||!conversation.isCurrent(target))throw new ConversationChangedError();
        if(saveWarning&&conversation.isCurrent(saveWarning.target))throw Error(saveWarning.message);
        return ![...saveRequests.values()].some(request=>conversation.isCurrent(request.target)&&(savedRevisions.get(request.id)||0)<request.revision);
      },remaining(),null);
      const currentUploads=uploadState();if(!hidden&&(currentUploads.pending||currentUploads.error))throw Error(currentUploads.message);
      if(resumeCacheError&&(draft.items.length||draft.removed.length||draftCarryKeys(draft).length))throw Error(resumeCacheError);
      if(prepared===preparedNewChat)preparedNewChat=null;
      return true;
    }finally{lessonSaving=wasSaving;}
  }
  win.__ZJF_SAVE_BEFORE_CLOSE_V1__=saveBeforeClose;
  win.__ZJF_SET_CLOSE_STATE_V1__=setCloseState;
  function syncText(force=false){
    const current=editorText();getQuestions(current);const source=editSource(),fields=fieldValues();
    const conflictingFields=force&&Object.keys(fields).length&&warning;
    // Editing the native composer does not opt out of later captures. Preserve
    // modified/freeform words while rebuilding our image labels and slots.
    const state=editState();let text;if(!editPrevious()&&state.clearedText!==null){if(current===state.clearedText&&state.clearedPrefix!==null){applyDraftQuestionFields(draft,fields);text=state.clearedPrefix+draftPrompt(draft,positions());}else{draft.questionPrelude='';draft.extra='';text=mergeDraftPrompt(draft,current,'',positions(),{questionOverrides:fields,force:true});}}
    else text=mergeDraftPrompt(draft,current,editPrevious(),positions(),{sourceDraft:source,questionOverrides:fields,force:true});
    if(!draft.inline)text=convertToInlineDraft(draft,text,editPrevious(),positions());
    writeText(conflictingFields?'【保留的原提问】\n'+current.split('\n').map(x=>'│ '+x).join('\n')+'\n\n'+text:text,{replace:force});
    if(draft.plan)delete draft.plan.carryHeadEdit;if(source!==draft&&source.plan)delete source.plan.carryHeadEdit;
    editState(source).fields.clear();state.source=null;state.valid=true;state.metadataDirty=false;state.needsSync=false;state.clearedText=null;state.clearedPrefix=null;state.order=attachmentOrder();previous=draftPrompt(draft,positions());const uploads=uploadState();warning=saveWarning?.message||(uploads.error?uploads.message:'');
  }
  function postReceipt(receipt,delivery){post({...receipt,...(Number.isSafeInteger(delivery?.workspaceRevision)?{workspaceRevision:delivery.workspaceRevision}:{})});}
  function report(delivery,state,error=''){
    try{postReceipt(conversation.receipt(delivery,state,{count:state==='attached'?draft.items.length:0,error}),delivery)}
    catch{postReceipt({kind:'zjf-draft-status',...delivery,id:delivery?.materialId,state:'cancelled',count:0,error:error||'目标对话已切换，材料已保留。',evidence:'',verified:false},delivery)}
  }
  function safeSync(deferPanel=false){
    if(composing()){deferredSync=true;persistQuestion();return}
    try{
      if(!draft.items.length&&!draftCarryKeys(draft).length){
        const state=editState(),current=editorText(),parts=getQuestions(current);let text=current;
        if(editPrevious()){text=mergeDraftPrompt(draft,current,editPrevious(),positions(),{sourceDraft:editSource(),questionOverrides:fieldValues(),clear:true,force:true});state.clearedPrefix=parts.valid?parts.prefix:null;}
        if(!parts.valid&&(!editPrevious()||parts.freeform)&&state.clearedText!==current){draft.questionPrelude='';draft.extra='';state.clearedPrefix=current?current+'\n\n':'';}
        if(text!==current)writeText(text);if(draft.plan){delete draft.plan.carryTextOverride;delete draft.plan.carryHeadEdit;}state.clearedText=editorText();previous='';draft.contextStarted=draft.seeded;editState(editSource()).fields.clear();state.source=null;state.needsSync=false;state.metadataDirty=false;state.order=attachmentOrder();const uploads=uploadState();warning=saveWarning?.message||(uploads.error?uploads.message:'');
      }
      else syncText();
    }catch(e){warning=e.message;editState().editWarning=e.message}persistQuestion();if(deferPanel)renderAfterFieldCommit();else renderPanel();
  }
  function getQuestions(text=editorText()){
    const source=editSource(),state=editState(),sourceState=editState(source),template=editPrevious();
    if(composing()&&source.inline)return draftTextParts(source,draftPrompt(source,positions()));
    const parts=draftTextParts(source,text,template);state.valid=parts.valid;
    if(parts.valid&&sourceState.fields.size&&sourceState.lastText!==text){
      const before=draftTextParts(source,sourceState.lastText,template);
      if(before.valid)for(const id of sourceState.fields.keys()){
        const current=id==='questionPrelude'?parts.prelude:parts.questions[id]||'',previous=id==='questionPrelude'?before.prelude:before.questions[id]||'';
        if(current!==previous)sourceState.fields.delete(id);
      }
    }
    if(parts.valid){readDraftQuestions(source,text,{previous:template});applyDraftQuestionFields(source,Object.fromEntries(sourceState.fields));if(source!==draft){Object.assign(draft.questions,source.questions);draft.extra=source.extra;draft.questionPrelude=source.questionPrelude}}
    if(source===draft&&draft.inline&&draft.inline.refs.some(ref=>ref.token!==inlineReferenceLabel(draft,ref,positions())))state.needsSync=true;
    state.editorNode=editor();state.lastText=text;sourceState.lastText=text;return parts;
  }
  function element(tag,text){const el=page.createElement(tag);if(text)el.textContent=text;return el}
  function renderAfterFieldCommit(){
    deferredPanel=true;if(!workspaceActive())return;const owner=draft,target=operationTarget();
    // change fires during blur, before the next field/button receives focus.
    // Do not replace that destination while the browser is transferring focus.
    win.setTimeout(()=>{if(!disposed&&owner===draft&&workspaceCurrent(target)&&conversation.isCurrent(target))renderPanel();},0);
  }
  function flushFieldCommit(){
    if(fieldCommitTimer){win.clearTimeout(fieldCommitTimer);fieldCommitTimer=0;}
    if(!composing()&&!busy&&!activeResume()&&(editState(editSource()).fields.size||editState().metadataDirty||editState().needsSync))safeSync(true);
  }
  function commitFieldsAfterFocus(){
    editState().needsSync=true;if(!workspaceActive())return;const owner=draft,target=operationTarget();
    if(fieldCommitTimer)win.clearTimeout(fieldCommitTimer);
    // A rich composer can take focus when insertHTML selects its contents.
    // Let the browser finish blur/click/Tab before restoring that destination.
    fieldCommitTimer=win.setTimeout(()=>{fieldCommitTimer=0;if(disposed||owner!==draft||!workspaceCurrent(target)||!conversation.isCurrent(target))return;if(composing()){deferredSync=true;return;}flushFieldCommit();},0);
  }
  function action(text,fn){const b=element('button',text);b.type='button';b.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();if(!workspaceActive())return;const owner=draft,target=operationTarget();Promise.resolve().then(()=>{if(!disposed&&owner===draft&&workspaceCurrent(target)&&conversation.isCurrent(target))return fn(e);}).catch(error=>{if(!disposed&&owner===draft&&workspaceCurrent(target)&&conversation.isCurrent(target)&&error.name!=='AbortError'&&error.code!=='conversation_changed'){warning=error.message;renderPanel();}})});return b}
  async function moveImageTo(item,destination){
    if(busy||composing()||activeResume()||draft.materialEdit)return;const owner=draft,target=operationTarget(),index=owner.items.indexOf(item);if(index<0||index===destination||destination<0||destination>=owner.items.length)return;const start=Math.min(index,destination),nativeIndex=checkAttachmentOrderSource(owner,owner.items.slice(start));getQuestions();
    const direction=destination>index?1:-1;for(let step=index;step!==destination;step+=direction)moveDraftImage(owner,item.id,direction);const first=owner.items[start];
    owner.attachmentOrderPending=first.id;owner.attachmentOrderNativeIndex=nativeIndex;busy=true;renderPanel();
    try{await restoreAttachmentOrder({items:[first]},target);await waitForUploads(target);await waitForComposition(target);checkpoint(target);if(owner!==draft)throw new ConversationChangedError();delete owner.attachmentOrderPending;delete owner.attachmentOrderNativeIndex;safeSync();await waitForSaved(persistQuestion(),target);}
    catch(error){if(owner===draft&&conversation.isCurrent(target)){needImageResume(owner,target);editState().imageResumeFailed=workspaceCurrent(target);persistQuestion();}throw error;}
    finally{busy=false;if(owner===draft)renderPanel();}
  }
  function checkAttachmentOrderSource(owner,suffix,nativeIndex){
    const nodes=attachmentNodes().filter(node=>!isolationNames.has(attachmentName(node))),names=new Set([...owner.items,...owner.materialEdit?.items||[]].map(fileName)),foreign=nodes.map((node,index)=>names.has(attachmentName(node))?-1:index).filter(index=>index>=0),positions=suffix.map(item=>nodes.indexOf(findNode(item))).filter(index=>index>=0);
    const start=Math.min(...positions,...(Number.isSafeInteger(nativeIndex)&&nativeIndex>=0?[nativeIndex]:[]),nodes.length);
    if(foreign.length&&(suffix.some(item=>!findNode(item)?.isConnected)&&!Number.isSafeInteger(nativeIndex)||foreign.some(index=>index>=start)))throw Object.assign(Error('当前无法在保持手工附件位置的情况下调整这组图片；原图与文字已保留。'),{code:'draft_order_source_required'});
    return start;
  }
  async function cancelImageOrder(){
    if(busy||composing()||activeResume()||!draft.attachmentOrderPending)return;const owner=draft,target=operationTarget();busy=true;renderPanel();
    try{for(const item of [...owner.items]){checkpoint(target);if(owner!==draft)throw new ConversationChangedError();await attach(item,target);}await waitForUploads(target);await waitForComposition(target);checkpoint(target);
      const nodes=attachmentNodes(),positions=new Map(owner.items.map(item=>[item.id,nodes.indexOf(findNode(item))]));if([...positions.values()].some(index=>index<0))throw Error('图片尚未恢复完整，原图与文字已保留。');
      owner.items.sort((a,b)=>positions.get(a.id)-positions.get(b.id));if(owner.logicalItems){const logical=owner.logicalItems;owner.logicalItems=owner.items.flatMap(item=>logical.filter(value=>value.attachmentId===item.id));}
      delete owner.attachmentOrderPending;delete owner.attachmentOrderNativeIndex;resumeNeeded=null;safeSync();await waitForSaved(persistQuestion(),target);
    }finally{busy=false;if(owner===draft)renderPanel();}
  }
  function moveQuestion(logical,direction){
    if(busy||composing()||draft.materialEdit)return;getQuestions();if(!moveDraftQuestion(draft,logical.id,direction))return;safeSync();
  }
  function clearUndoAvailable(){
    return clearedDraft&&draft===clearedDraft.empty&&sameRestoreContext(clearedDraft.target,conversation.snapshot())&&conversation.isCurrent(conversation.snapshot())&&!draft.items.length&&!draft.removed.length&&JSON.stringify(attachmentNodes().map(attachmentName))===JSON.stringify(clearedDraft.foreignNames||[])&&(!editorText().trim()||matchesSavedText(clearedDraft.question.draftManifest,editorText()));
  }
  function clearContentStamp(){return JSON.stringify([draft.course,fieldValues(),draft.items.map(item=>item.id),draft.removed.map(item=>item.id),previous]);}
  function clearCurrentDraft(){
    if(busy||activeResume()||removingItems.size||hasPendingRemovals()||draft.materialEdit||pendingSend?.questionId===draft.id||composing())throw Error('请先完成当前输入、附图或发送，再清空。');
    reconcileIdentity();if(reconcileAttachments())safeSync();
    const intent={owner:draft,target:operationTarget(),text:editorText(),order:attachmentOrder(),stamp:clearContentStamp()};
    const task=serial.then(()=>clearCurrentDraftNow(intent));serial=task.catch(()=>{});return task;
  }
  async function clearCurrentDraftNow({owner,target,text,order,stamp}){
    checkpoint(target);if(owner!==draft||text!==editorText()||order!==attachmentOrder()||stamp!==clearContentStamp())throw Error('本次内容已有变化，未执行清空。');
    busy=true;let saved=null,marked=false,mutating=false,committed=false;
    try{
      const choices=recoveryOptions(),candidate=!owner.items.length&&!owner.removed.length&&choices.length===1?choices[0].question:null;
      saved=candidate||persistQuestion();if(!saved)return;
      if(!candidate)await waitForSaved(saved,target);
      checkpoint(target);if(owner!==draft||text!==editorText()||order!==attachmentOrder()||stamp!==clearContentStamp()||composing())throw Error('清空前内容已有新修改，原内容已保留。');
      const names=new Set(Object.values(saved.draftManifest.files||{})),nodes=attachmentNodes(),foreignNames=nodes.map(attachmentName).filter(name=>!names.has(name));
      const foreignCurrent=()=>JSON.stringify(attachmentNodes().map(attachmentName).filter(name=>!names.has(name)))===JSON.stringify(foreignNames);
      if(nodes.some(node=>names.has(attachmentName(node))&&!removeControl(node)))throw Error('附件移除入口尚未就绪，当前草稿已保留。');
      rememberCleared(saved.id,true);marked=true;
      // The native acknowledgement above makes this a recoverable clear. Do
      // not save a blank revision over the old question or its source assets.
      mutating=true;
      await removeAttachmentNames(names,target,()=>owner===draft&&text===editorText()&&stamp===clearContentStamp()&&!composing()&&foreignCurrent());
      checkpoint(target);if(text!==editorText()||stamp!==clearContentStamp())throw Error('问题已有新修改，原内容已保留。');
      if(!foreignCurrent())throw Error('清空期间附件已有变化，当前内容已保留。');
      writeText('',{replace:true});
      const empty=newDraft({seeded:seeded(owner.contextKey||owner.lessonKey),inline:true});
      for(const key of ['course','lessonKey','contextKey'])if(owner[key]!==undefined)empty[key]=owner[key];
      draft=empty;previous='';attachedItems.clear();editState().ignoreRecovery=true;editState().lastText='';editState().editorNode=editor();editState().saved=true;editState().workspaceReset=true;editState().clearedFrom=saved.id;
      editState().metadataEditedKeys=new Set(editState(owner).metadataEditedKeys);
      conversation.beginQuestion();publishComposer(true);
      const completionTarget=operationTarget();clearedDraft={question:JSON.parse(JSON.stringify(saved)),text,empty,target:completionTarget,foreignNames,keyboardUndo:true};committed=true;
      await waitForSaved(persistQuestion(),completionTarget);checkpoint(completionTarget);
      allowResume=false;resumeProbeText='';resumeCandidates.clear();recoveryCandidates.clear();resumeNeeded=null;recoveryBlocked='';unboundDraftWarning=false;resumeQueryError='';warning='';preparedNewChat=null;explicitRestore=null;
      if(resumeWait)win.clearTimeout(resumeWait.timer);resumeWait=null;
      for(const name of names)isolationNames.add(name);
      await waitFor(()=>{if(!workspaceCurrent(completionTarget))throw new ConversationChangedError();reconcileIdentity();if(!sameRestoreContext(target,conversation.snapshot()))throw new ConversationChangedError();cleanIsolatedAttachments();return !attachmentNodes().some(node=>names.has(attachmentName(node)))},3000,null);
      post({kind:'zjf-draft-release',protocol:2,target:conversation.snapshot(),draftId:owner.id});
      attachmentUI.close();
      if(page.hasFocus?.()&&(!page.activeElement||page.activeElement===page.body||panel?.contains(page.activeElement)))editor()?.focus({preventScroll:true});
    }catch(error){
      if(!committed&&marked){try{rememberCleared(saved.id,false)}catch{}}
      if(mutating&&!committed&&owner===draft&&conversation.isCurrent(target)){
        // A partial native removal keeps the saved question and restores its
        // images without replacing any text the user may have typed meanwhile.
        for(const item of owner.items)if(!findNode(item)?.isConnected&&!editState(owner).pendingRemovals.has(fileName(item))){retireUpload(item);await attach(item,target);}
      }
      throw error;
    }finally{busy=false;renderPanel();}
  }
  function undoClear(){
    if(busy||activeResume()||!clearUndoAvailable())return;
    const saved=clearedDraft;
    const task=serial.then(async()=>{
      if(saved!==clearedDraft||!clearUndoAvailable())return;
      const target=operationTarget(),result=await restoreSavedDraft(saved.question,target);
      checkpoint(target);if(saved!==clearedDraft)throw new ConversationChangedError();
      if(result.requiresNew)throw Error('当前已在编辑新问题，原草稿仍可从提问记录继续。');
      if(sameRecoveryText(editorText(),saved.question.draftManifest.composerText)&&saved.text!==editorText())writeText(saved.text,{replace:true});
      await waitForSaved(persistQuestion(),target);checkpoint(target);if(saved!==clearedDraft)throw new ConversationChangedError();rememberCleared(saved.question.id,false);clearedDraft=null;renderPanel();
    });serial=task.catch(()=>{});return task;
  }
  function attachmentState(){
    const e=editor(),target=conversation.snapshot(),logical=logicalDraftItems(draft),order=draftQuestionItems(draft).filter(item=>draft.questions[item.id]?.trim()).map(item=>item.id),native=new Map(attachmentNodes().map(node=>[attachmentName(node),node])),numbers=positions();
    const ready=workspaceActive()&&!!e&&lessonReady&&!lessonWork,editable=ready&&!busy&&!activeResume()&&!composing()&&!draft.materialEdit&&!removingItems.size&&!hasPendingRemovals()&&pendingSend?.questionId!==draft.id;
    const waiting=conversation.sendIntents().filter(intent=>intent.status!=='sent'&&conversation.ownsSendIntent(intent));
    return {key:[draft.id,target.conversationId,target.pageId,target.documentEpoch,target.routeGeneration,target.composerGeneration,workspaceEpoch].join(':'),editor:e,ready,editable,canClear:editable,canUndo:ready&&!busy&&!activeResume()&&!composing()&&!removingItems.size&&!hasPendingRemovals()&&(!draft.materialEdit||draft.materialEdit.recoveryFailed),materials:draft.items.map(item=>({...item,raw:item,native:native.get(fileName(item)),number:numbers[item.id],logical:logical.filter(value=>(value.attachmentId||value.id)===item.id).map(value=>{const index=order.indexOf(value.id),neighbours=draft.inline?inlineQuestionNeighbours(draft,value.id):{before:index>0,after:index>=0&&index<order.length-1};return {...value,raw:value,question:draft.inline?[draft.inline.singleQuestions?.[value.id],...(draft.inline.shared||[]).filter(part=>part.ids.includes(value.id)).map(part=>part.text)].filter(Boolean).join('\n\n'):draft.questions[value.id]||'',questionBefore:neighbours.before,questionAfter:neighbours.after};})})),removed:draft.removed.length||!!draft.attachmentOrderPending||!!draft.materialEdit?.recoveryFailed,clearUndo:!!clearUndoAvailable(),warning:warning||saveWarning?.message||'',waiting:waiting.length,reviewKey:JSON.stringify([sendReviewId,sendReviewPage,waiting.map(value=>[value.id,value.status]),sendReviewId?userMessages().map(turnId):[]]),hasText:!!editorText().trim(),choices:recoveryOptions().map(({question})=>({id:question.id,title:question.questions?.find(item=>item.text?.trim())?.text||question.title||question.draftManifest.draft.course?.course||'草稿'})),fields:(draft.plan?[['notes','补充背景']]:[['school','学校'],['course','课程'],['teacher','教师'],['notes','补充背景']]).map(([key,label])=>({key,label,value:draft.course[key]||''}))};
  }
  function rememberCaret(){
    if(writing||composing())return;const input=editor();if(!input)return;const text=editorText();let start,end;
    if('selectionStart'in input){if(page.activeElement!==input)return;start=input.selectionStart;end=input.selectionEnd;}
    else{const selection=win.getSelection();if(!selection?.rangeCount||!input.contains(selection.anchorNode)||!input.contains(selection.focusNode))return;const range=selection.getRangeAt(0),prefix=page.createRange();prefix.selectNodeContents(input);prefix.setEnd(range.startContainer,range.startOffset);start=prefix.toString().replace(/\r/g,'').length;prefix.setEnd(range.endContainer,range.endOffset);end=prefix.toString().replace(/\r/g,'').length;}
    savedCaret={owner:draft,input,text,start,end};
    const body=draft.inline?.text||text,left=body.lastIndexOf('\n\n',Math.max(0,start-1)),right=body.indexOf('\n\n',start),ids=start<=body.length?(draft.inline?.refs||[]).filter(ref=>ref.start>=(left<0?0:left+2)&&ref.end<=(right<0?body.length:right)).map(ref=>ref.id):[];attachmentUI.highlight(ids);
  }
  function focusComposerAt(index){
    const input=editor();if(!input)return;const text=editorText(),at=Math.max(0,Math.min(index,text.length));input.focus({preventScroll:true});
    if('setSelectionRange'in input)input.setSelectionRange(at,at);
    else{const selection=win.getSelection(),point=richTextPoints(input,text,selection),range=page.createRange();range.setStart(...point(at));range.collapse(true);selection.removeAllRanges();selection.addRange(range);const caret=range.getBoundingClientRect();for(let node=input;node&&node!==input.closest('form');node=node.parentElement){if(node.scrollHeight<=node.clientHeight||!/auto|scroll/.test(layoutWindow.getComputedStyle(node).overflowY))continue;const box=node.getBoundingClientRect();if(caret.bottom>box.bottom)node.scrollTop+=caret.bottom-box.bottom+8;else if(caret.top<box.top)node.scrollTop-=box.top-caret.top+8;break;}}
    rememberCaret();
  }
  function referenceImage(physicalId,logicalId,{existing=false}={}){
    if(!attachmentState().editable)return;const material=draft.items.find(item=>item.id===physicalId),item=logicalDraftItems(draft).find(item=>item.id===logicalId&&(item.attachmentId||item.id)===physicalId);if(!material||!item)return;
    const current=editorText(),caret=savedCaret?.owner===draft&&savedCaret.input===editor()?mapCaret(savedCaret.start,savedCaret.text,current):current.length;
    getQuestions();if(!draft.inline){const converted=convertToInlineDraft(draft,current,previous,positions());writeText(converted);previous=converted;}
    const ref=existing&&draft.inline.refs.find(ref=>ref.id===item.id);let at;
    if(ref)at=ref.end+1;else at=insertInlineReference(draft,item,Math.min(caret,draft.inline.text.length),positions());
    const text=draftPrompt(draft,positions());writeText(text);previous=text;editState().order=attachmentOrder();persistQuestion();renderPanel();focusComposerAt(at);
  }
  async function removeImageChoice(physicalId,logicalId,options){const material=draft.items.find(item=>item.id===physicalId);if(!material)return;const owner=draft,target=operationTarget(),version=lessonInputVersion,item=logicalId&&logicalDraftItems(draft).find(item=>item.id===logicalId&&(item.attachmentId||item.id)===physicalId);await (item?removeMaterial(material,item,options):remove(material,options));if(owner===draft&&workspaceCurrent(target)&&version===lessonInputVersion)attachmentUndo={owner,text:editorText()};}
  function moveImageChoice(id,{direction,target,after=false}){
    const item=draft.items.find(item=>item.id===id),from=draft.items.indexOf(item);if(!item)return;let destination;
    if(target){destination=draft.items.findIndex(item=>item.id===target);if(destination<0)return;destination+=after?1:0;if(from<destination)destination--;}
    else destination=from+(direction<0?-1:1);
    return moveImageTo(item,destination);
  }
  function moveQuestionChoice(id,direction){const logical=[...logicalDraftItems(draft),...draft.detachedQuestions||[]].find(item=>item.id===id);if(logical)return moveQuestion(logical,direction);}
  async function undoAttachmentAction(){
    if(busy||composing()||activeResume()||removingItems.size||hasPendingRemovals())return;
    if(draft.materialEdit?.recoveryFailed){const owner=draft,target=operationTarget();busy=true;try{await discardMaterialEdit(owner,target);warning='';safeSync();}finally{busy=false;renderPanel();}return;}
    if(draft.attachmentOrderPending)return cancelImageOrder();if(clearUndoAvailable())return undoClear();return restore();
  }
  function updateMetadataField(key,value,commit){
    if(!['school','course','teacher','notes'].includes(key))return;restoreRevision++;draft.course[key]=value;editState().metadataEditedKeys.add(key);editState().metadataDirty=true;persistQuestion('draft',undefined,false);if(commit)commitFieldsAfterFocus();
  }
  function renderPanel(){
    if(disposed)return;const e=editor();if(e&&!attachmentStyle){attachmentStyle=element('style');attachmentStyle.textContent=DRAFT_PANEL_CSS;(page.head||page.documentElement).append(attachmentStyle);}
    if(e)e.toggleAttribute('data-zjf-question-editor',!!draft.inline&&!!draft.items.length);
    attachmentUI.refresh();panel=attachmentUI.element;deferredPanel=false;
  }
  function attachmentOrder(){return attachments().map(x=>attachmentName(x)).join('\n')}
  const hasPendingRemovals=()=>attachmentNodes().some(node=>editState().pendingRemovals.has(attachmentName(node)));
  function uploadState({includeOrder=true}={}){
    if(attachmentNodes().some(node=>isolationNames.has(attachmentName(node))))return {pending:true,message:'正在移除已取消的图片，请稍候再发送。'};
    if(hasPendingRemovals())return {pending:true,message:'正在移除图片，请稍候再发送。'};
    if(includeOrder&&draft.attachmentOrderPending)return {pending:true,message:'图片顺序尚未调整完成，请继续调整后再发送。'};
    for(const node of attachmentNodes()){
      if(attachmentFailed(node))return {error:true,message:'图片上传失败，截图和问题已保留。'};
      if(node.querySelector('[role="progressbar"]'))return {pending:true,message:'图片仍在上传，请完成上传后发送。'};
    }
    for(const item of [...draft.items,...draft.materialEdit?.items||[]]){const node=findNode(item),image=node?.querySelector('img');if(!node?.isConnected||!image?.complete||!image.naturalWidth)return {pending:true,message:'图片尚未附齐，截图和问题已保留。'};}
    return {};
  }
  function reconcileAttachments(){
    let changed=false;const state=editState(),present=new Set(attachmentNodes().map(attachmentName));
    for(const [name,removed]of state.pendingRemovals){if(present.has(name))continue;const item=draft.items.find(x=>removed.itemId?x.id===removed.itemId:fileName(x)===name);if(item){getQuestions();retireUpload(item);removeDraftItem(draft,item.id,{removedAt:removed.time,keepQuestion:removed.keepQuestion!==false});attachedItems.delete(item.id);state.missingAttachments.delete(item.id);state.needsSync=true;changed=true}state.pendingRemovals.delete(name);changed=true}
    // A rebuilt or vanished attachment is not proof that the user removed it.
    // Keep its source and question active so a retry can restore the missing chip.
    for(const item of draft.items){
      if(findNode(item)?.isConnected){state.missingAttachments.delete(item.id);continue;}
      if(!attachedItems.has(item.id))continue;
      if(!state.missingAttachments.has(item.id)){state.missingAttachments.set(item.id,Date.now());if(!state.imageResumeTarget&&workspaceActive())state.imageResumeTarget=restoreTarget();}
      else if(Date.now()-state.missingAttachments.get(item.id)>=800&&editorText().trim()&&pendingSend?.questionId!==draft.id&&workspaceActive())needImageResume();
    }
    if(!state.missingAttachments.size&&resumeNeeded!==draft&&!activeResume())state.imageResumeTarget=null;
    return changed;
  }
  async function waitForUploads(target=activeDelivery){let settledSince=0;await waitFor(()=>{reconcileAttachments();const status=uploadState({includeOrder:false});if(status.error)throw Error(status.message);if(status.pending){settledSince=0;return false}if(!settledSince)settledSince=Date.now();return Date.now()-settledSince>=400},20000,target)}
  function restoreEditor(){
    const e=editor(),state=editState();if(!e)return;
    if(state.returnText!==undefined){const text=state.returnText;if(!editorText()&&text){writeText(text);renderPanel()}delete state.returnText;}
    else if(state.editorNode&&state.editorNode!==e&&!editorText()&&state.lastText){writeText(state.lastText);persistQuestion();renderPanel()}
    state.editorNode=e;
  }
  async function waitFor(fn,ms=15000,target=activeDelivery){const end=Date.now()+ms;for(;;){if(target)checkpoint(target);const value=fn();if(value)return value;if(Date.now()>end)throw Error('提问处理未完成，截图和问题已保留。');await new Promise(r=>setTimeout(r,100));if(target)checkpoint(target)}}
  async function waitForComposition(target){while(composing()){checkpoint(target);await new Promise(r=>win.setTimeout(r,50))}checkpoint(target)}
  function retireRequest(id){retiredRequests.add(id);if(retiredRequests.size>500)retiredRequests.delete(retiredRequests.values().next().value);}
  const sameRefSet=(left,right)=>left.length===right.length&&new Set(left.map(draftMaterialKey)).size===left.length&&left.every(x=>right.some(y=>draftMaterialKey(x)===draftMaterialKey(y)));
  function projectResponseMatches(request,message){return message.requestId===request.requestId&&message.materialId===request.materialId&&message.purpose===request.purpose&&(request.purpose==='delivery'?message.operationId===request.operationId&&message.attemptId===request.attemptId:message.draftId===request.draftId&&message.actionId===request.actionId);}
  async function requestProjection(details,target,current=()=>true){
    const requestId=crypto.randomUUID(),request={kind:'zjf-draft-project-request',protocol:2,requestId,target:target.target||target,...details},pending={...request,result:null,current};projectRequests.set(requestId,pending);post(request);
    try{const plan=await waitFor(()=>{if(reconcileAttachments())safeSync();if(hasPendingRemovals())return false;if(!current()){const error=Error('本次材料选择已变化，保留当前草稿。');error.code=details.purpose==='restore'?'draft_restore_changed':'draft_projection_changed';throw error;}if(pending.result?.error){const error=Error(pending.result.error);error.code=pending.result.code;throw error;}return pending.result?.plan},30000,target);checkpoint(target);if(!plan||!Array.isArray(plan.items)||!Array.isArray(plan.logicalItems)||!sameRefSet(plan.logicalItems,details.keepRefs))throw Error('整理后的材料与本次选择不一致，原草稿已保留。');return plan;}
    finally{projectRequests.delete(requestId);retireRequest(requestId);}
  }
  async function waitForSaved(question,target){if(!question)throw Error('当前草稿尚未保存，原内容已保留。');await waitFor(()=>{if((savedRevisions.get(question.id)||0)>=question.revision)return true;if(saveWarning?.id===question.id&&saveWarning.revision>=question.revision)throw Error(saveWarning.message);return false},10000,target);}
  function retireUploadName(owner,name){isolationNames.add(name);owner.retiredUploads??=[];if(!owner.retiredUploads.includes(name))owner.retiredUploads.push(name);}
  function retireUpload(item){if(item.__fileToken||item.__fileName)retireUploadName(draft,fileName(item));delete item.__fileName;item.__uploadRequested=false;item.__targetStamp='';attachedItems.delete(item.id)}
  async function originalImage(item,target,{preview=false}={}){
    if(/^data:image\/(?:png|jpeg);base64,/.test(item.image||'')&&(preview?item.image.startsWith('data:image/png')||item.format==='jpeg':item.image.length<=12*1024*1024))return;
    const ref=item.kind==='collection'?{materialId:item.materialId||draft.plan?.id,attachmentId:item.sourceAttachmentId||item.id}:item.ref||{snapshotId:item.snapshotId,itemId:item.id},requestId=crypto.randomUUID(),identity=target.target||target;
    if(!(ref.snapshotId&&ref.itemId||ref.materialId&&ref.attachmentId))throw Error('这张图片的原图记录不完整，请从资料库重新选入。');
    const request={target:identity,ref,result:null,preview};imageRequests.set(requestId,request);post({kind:'zjf-draft-image-request',protocol:2,requestId,target:identity,ref,preview:!!preview});
    try{const result=await waitFor(()=>{if(request.result?.error)throw Error(request.result.error);return request.result?.image},10000,target);checkpoint(target);item.image=result;}finally{imageRequests.delete(requestId);retireRequest(requestId)}
  }
  async function attach(item,target,{beforeUpload=()=>{}}={}){
    const owner=draft,present=()=>owner.items.includes(item)||owner.materialEdit?.items.includes(item),removed=()=>[...editState(owner).pendingRemovals.values()].some(value=>value.itemId===item.id);checkpoint(target);reconcileAttachments();if(!present()||removed())return;
    const existing=findNode(item);if(existing?.isConnected){
      if(!attachmentFailed(existing)){attachedItems.add(item.id);return}
      const remove=removeControl(existing);if(!remove)throw Error('图片尚未上传，原图和问题已保留。');
      replacing=true;try{remove.click()}finally{replacing=false}
      await waitFor(()=>!findNode(item),3000,target);checkpoint(target);retireUpload(item);
    }
    await originalImage(item,target);checkpoint(target);reconcileAttachments();if(!present()||removed())return;
    const returned=findNode(item);if(returned?.isConnected&&!attachmentFailed(returned)){attachedItems.add(item.id);return;}
    const identity=target.target||target,stamp=[identity.conversationId,identity.pageId,identity.documentEpoch,identity.routeGeneration,identity.composerGeneration].join(':');
    if(item.__targetStamp!==stamp){item.__targetStamp=stamp;item.__fileToken=crypto.randomUUID();item.__uploadRequested=false;}
    if(!item.__uploadRequested){
      item.__fileName=fileName(item);
      const blob=imageDataBlob(item.image);checkpoint(target);reconcileAttachments();if(!present()||removed())return;
      let binding=uploadInput(blob.type);
      if(!binding){try{binding=await waitFor(()=>uploadInput(blob.type),12000,target);}catch(error){if(error.code==='conversation_changed')throw error;throw unavailableUpload(blob.type,target);}checkpoint(target);reconcileAttachments();if(!present()||removed())return;}
      const input=binding.input;editState(owner).uploadDiagnostic=null;item.__fileName=item.__fileName.replace(/\.(?:png|jpe?g)$/i,binding.extension);
      const transfer=new DataTransfer();transfer.items.add(new File([blob],fileName(item),{type:blob.type}));
      checkpoint(target);beforeUpload();if(!input.isConnected||input.matches(':disabled')||uploadInput(blob.type)?.input!==input)throw unavailableUpload(blob.type,target);input.files=transfer.files;item.__uploadRequested=true;input.dispatchEvent(new Event('change',{bubbles:true}));
    }
    try{
      const node=await waitFor(()=>{reconcileAttachments();return !present()||removed()||attachmentNodes().find(e=>attachmentName(e)===fileName(item));},7000,target);checkpoint(target);if(!present()||removed())return;
      attachedItems.add(item.id);
    }catch(error){
      // An upload can be accepted without ever producing its attachment chip.
      // Retire that filename before retrying, so a late old chip is removed and
      // the next attempt can upload a fresh token without duplicating it.
      if(owner===draft&&!attachmentNodes().some(e=>attachmentName(e)===fileName(item)))retireUpload(item);
      throw error;
    }
  }
  async function discardMaterialEdit(owner=draft,target=operationTarget()){
    const edit=owner.materialEdit;if(!edit||owner!==draft)return;checkpoint(target);
    const names=new Set(edit.items.map(fileName));for(const name of names)retireUploadName(owner,name);
    cleanIsolatedAttachments();await waitFor(()=>{cleanIsolatedAttachments();return !attachmentNodes().some(node=>names.has(attachmentName(node)))},3000,target);
    checkpoint(target);if(owner!==draft||owner.materialEdit!==edit)return;
    delete owner.materialEdit;
    const original=owner.items.find(item=>item.id===edit.itemId);if(original&&!findNode(original)?.isConnected){retireUpload(original);try{await attach(original,target);await waitForUploads(target)}catch(error){needImageResume(owner,target);throw error;}}
    safeSync();await waitForSaved(persistQuestion(),target);
  }
  function removeMaterial(item,logical,{keepQuestion=true}={}){
    const contents=logicalDraftItems(draft).filter(value=>(value.attachmentId||value.id)===item.id);
    if(contents.length<=1)return remove(item,{keepQuestion});
    if(busy||draft.materialEdit)return;
    if(['panorama','board'].includes(item.kind)||item.kind==='collection'&&(!item.format||item.format==='png')&&contents.every(value=>!value.region&&['panorama','board'].includes(value.kind)))return detachSharedBackground(item,logical,{keepQuestion});
    const owner=draft,target=operationTarget();const task=serial.then(()=>editMaterial(owner,target,item,logical,{keepQuestion}));serial=task.catch(()=>{});return task;
  }
  async function detachSharedBackground(item,logical,{keepQuestion=true}={}){
    if(busy||composing()||activeResume())return;const owner=draft,target=operationTarget(),signature=logicalDraftItems(owner).filter(value=>value.attachmentId===item.id).map(draftMaterialKey).join('|'),current=()=>owner===draft&&owner.items.includes(item)&&![...editState(owner).pendingRemovals.values()].some(value=>value.itemId===item.id)&&logicalDraftItems(owner).filter(value=>value.attachmentId===item.id).map(draftMaterialKey).join('|')===signature;
    const requestId=crypto.randomUUID(),request={target,current,purpose:'shared-background',draftId:owner.id,itemId:item.id,result:null};busy=true;renderPanel();
    try{getQuestions();await waitForSaved(persistQuestion(),target);projectRequests.set(requestId,request);post({kind:'zjf-draft-background-request',protocol:2,requestId,target,draftId:owner.id,itemId:item.id,keepRefs:[logical.ref]});
      const proof=await waitFor(()=>{if(!current())throw new ConversationChangedError();if(request.result?.error)throw Error(request.result.error);return request.result?.proof&&request.result;},15000,target);
      checkpoint(target);reconcileAttachments();if(!current())throw new ConversationChangedError();item.asset=proof.asset;if(item.kind==='collection')item.format='png';for(const source of logicalDraftItems(owner).filter(value=>value.attachmentId===item.id))source.asset=proof.asset;removeSharedDraftBackground(owner,item,logical,{keepQuestion});safeSync();await waitForSaved(persistQuestion(),target);
    }finally{projectRequests.delete(requestId);retireRequest(requestId);busy=false;if(owner===draft)renderPanel();}
  }
  async function editMaterial(owner,target,item,logical,{keepQuestion=true}={}){
    if(owner!==draft||draft.materialEdit)return;checkpoint(target);
    checkAttachmentOrderSource(owner,owner.items.slice(owner.items.indexOf(item)));item.nativeAttachmentIndex=attachmentNodes().indexOf(findNode(item));
    const contents=logicalDraftItems(owner).filter(value=>value.attachmentId===item.id),retained=contents.filter(value=>value.id!==logical.id);
    if(!contents.includes(logical)||!retained.length)return;
    const signature=contents.map(draftMaterialKey).join('|'),current=()=>owner===draft&&owner.items.includes(item)&&![...editState(owner).pendingRemovals.values()].some(value=>value.itemId===item.id)&&logicalDraftItems(owner).filter(value=>value.attachmentId===item.id).map(draftMaterialKey).join('|')===signature;
    busy=true;renderPanel();
    try{
      getQuestions();await waitForSaved(persistQuestion(),target);
      const plan=await requestProjection({purpose:'edit',draftId:owner.id,actionId:crypto.randomUUID(),materialId:item.materialId||owner.plan?.id,keepRefs:retained.map(value=>({...value.ref}))},target,current);
      checkpoint(target);if(!current())throw Error('本次选材已变化，原材料已保留。');
      if(plan.items.some(page=>owner.items.some(value=>value.id===page.id)))throw Error('整理后的图片已在本次材料中，原材料已保留。');
      const stamp=[target.conversationId,target.pageId,target.documentEpoch,target.routeGeneration,target.composerGeneration].join(':');
      const edit={itemId:item.id,items:plan.items.map(value=>({...value,materialId:plan.id,sourceMaterialId:plan.sourceMaterialId||plan.id,__fileToken:crypto.randomUUID(),__targetStamp:stamp,__uploadRequested:false}))};
      owner.materialEdit=edit;await waitForSaved(persistQuestion(),target);
      for(const page of edit.items){await attach(page,target);checkpoint(target);if(!current())throw Error('选材已变化，原材料已保留。');}
      await waitForUploads(target);await waitForComposition(target);checkpoint(target);
      if(!current()||edit.items.some(page=>!findNode(page)?.isConnected||!findNode(page).querySelector('img')))throw Error('新图片尚未就绪，原材料已保留。');
      getQuestions();const node=findNode(item),button=removeControl(node);
      if(!node?.isConnected||!button)throw Error('附件状态已变化，原材料已保留。');
      reconcileAttachments();if(!current())throw Error('本次选材已变化，原材料已保留。');
      checkAttachmentOrderSource(owner,owner.items.slice(owner.items.indexOf(item)));item.nativeAttachmentIndex=attachmentNodes().indexOf(node);
      replacing=true;try{button.click()}finally{replacing=false}
      await waitFor(()=>!findNode(item),3000,target);checkpoint(target);
      const pages=replaceDraftMaterial(owner,item,logical.id,{...plan,items:edit.items},{keepQuestion});retireUpload(item);delete owner.materialEdit;
      if(pages.length){owner.attachmentOrderPending=pages[0].id;await restoreAttachmentOrder({items:[pages[0]],nativeIndex:item.nativeAttachmentIndex},target);await waitForUploads(target);delete owner.attachmentOrderPending;delete owner.attachmentOrderNativeIndex;}
      safeSync();await waitForSaved(persistQuestion(),target);
    }catch(error){
      if(owner===draft&&conversation.isCurrent(target)&&!workspaceCurrent(target)){persistQuestion();return;}
      if(owner===draft&&conversation.isCurrent(target)){try{await discardMaterialEdit(owner,target)}catch(recovery){persistQuestion();warning='选材调整未完成，原图已保存；恢复原附件时遇到：'+recovery.message;renderPanel();return;}}
      if(owner===draft&&conversation.isCurrent(target)){if(owner.attachmentOrderPending)needImageResume(owner,target);if(error.message==='图片上传失败，截图和问题已保留。')error.message='图片上传失败，原材料已保留。';editState().editWarning=error.message;}
      throw error;
    }finally{busy=false;if(owner===draft)renderPanel();}
  }
  async function remove(item,{keepQuestion=true}={}){
    if(removingItems.has(item.id))return;getQuestions();const node=findNode(item);
    item.nativeAttachmentIndex=attachmentNodes().indexOf(node);
    const button=removeControl(node);
    if(node?.isConnected&&!button)throw Error('未找到这张图片的移除按钮，请在 ChatGPT 附件上移除。');
    removingItems.add(item.id);const target=operationTarget(),removedAt=Date.now(),name=fileName(item),state=editState();
    try{checkpoint(target);state.pendingRemovals.set(name,{time:removedAt,itemId:item.id,keepQuestion,attempts:1,after:Date.now()+250});persistQuestion('draft',undefined,false);replacing=true;try{button?.click();}finally{replacing=false;}if(node?.isConnected)await waitFor(()=>!findNode(item),3000,target);checkpoint(target);state.pendingRemovals.delete(name);retireUpload(item);removeDraftItem(draft,item.id,{removedAt,keepQuestion});safeSync()}finally{removingItems.delete(item.id);renderPanel()}
  }
  function restore(){
    if(busy||composing()||activeResume()||removingItems.size||hasPendingRemovals()||!draft.removed.length)return;getQuestions();const intent={owner:draft,target:operationTarget(),proposal:prepareDraftUndo(draft)};
    const task=serial.then(()=>restoreNow(intent));serial=task.catch(()=>{});return task;
  }
  async function restoreAttachmentOrder(transaction,target){
    if(!transaction.items.length)return;
    const owner=draft,ids=new Set(transaction.items.map(item=>item.id)),start=owner.items.findIndex(item=>ids.has(item.id)),suffix=owner.items.slice(start);
    owner.attachmentOrderNativeIndex=checkAttachmentOrderSource(owner,suffix,transaction.nativeIndex??transaction.originalItem?.nativeAttachmentIndex??(owner.attachmentOrderPending?owner.attachmentOrderNativeIndex:undefined));
    // Only our own attachments are rebuilt. Original files and the current
    // words are protected before removing any surviving attachment chip.
    await waitForSaved(persistQuestion(),target);
    for(const item of suffix){reconcileAttachments();if(!owner.items.includes(item))continue;await originalImage(item,target);checkpoint(target);if(owner!==draft)throw new ConversationChangedError();reconcileAttachments();const node=findNode(item);if(node?.isConnected&&!removeControl(node))throw Error('原附件暂不能调整顺序，原图与问题已保留。');}
    checkAttachmentOrderSource(owner,suffix,owner.attachmentOrderNativeIndex);
    for(const item of suffix){
      reconcileAttachments();if(!owner.items.includes(item))continue;
      const node=findNode(item);if(!node?.isConnected)continue;const name=attachmentName(node);
      checkAttachmentOrderSource(owner,suffix,owner.attachmentOrderNativeIndex);
      replacing=true;try{removeControl(node).click();}finally{replacing=false;}
      await waitFor(()=>!attachmentNodes().some(value=>attachmentName(value)===name),3000,target);checkpoint(target);retireUpload(item);
    }
    for(const item of suffix){reconcileAttachments();if(!owner.items.includes(item))continue;checkAttachmentOrderSource(owner,suffix,owner.attachmentOrderNativeIndex);await attach(item,target,{beforeUpload:()=>checkAttachmentOrderSource(owner,suffix,owner.attachmentOrderNativeIndex)});checkpoint(target);reconcileAttachments();}
  }
  async function restoreNow({owner,target,proposal}){
    if(owner!==draft||!conversation.isCurrent(target)||!draftUndoCurrent(draft,proposal))return;
    busy=true;renderPanel();let transaction=null;
    try{
      let projection=null;
      if(proposal.requiresProjection){
        const state=editState(),materialId=proposal.item.materialId||proposal.item.sourceMaterialId,signature=JSON.stringify([proposal.item.id,materialId,proposal.generations]);
        if(state.restoreAction?.signature!==signature)state.restoreAction={signature,actionId:crypto.randomUUID()};const actionId=state.restoreAction.actionId;
        await waitForSaved(persistQuestion(),target);checkpoint(target);if(!draftUndoCurrent(draft,proposal))return;
        projection=await requestProjection({purpose:'restore',draftId:draft.id,actionId,materialId,keepRefs:proposal.refs},target,()=>owner===draft&&editState().restoreAction?.actionId===actionId&&draftUndoCurrent(draft,proposal));
      }
      checkpoint(target);if(!draftUndoCurrent(draft,proposal))return;getQuestions();transaction=applyDraftUndo(draft,proposal,projection);renderPanel();
      await restoreAttachmentOrder(transaction,target);await waitForUploads(target);await waitForComposition(target);checkpoint(target);if(owner!==draft)throw new ConversationChangedError();safeSync();bindRecordedOperations();editState().restoreAction=null;
    }catch(error){
      if(owner===draft&&conversation.isCurrent(target)){
        if(transaction){const rolledBack=rollbackDraftUndo(draft,transaction);editState().restoreAction=null;replacing=true;try{for(const item of rolledBack){const node=findNode(item);retireUpload(item);if(workspaceCurrent(target))removeControl(node)?.click();}}finally{replacing=false}}
        if(draft.items.some(item=>!findNode(item)?.isConnected))needImageResume(draft,target);
        persistQuestion();if(error.code!=='draft_restore_changed'&&error.code!=='conversation_changed')throw error;
      }
    }finally{busy=false;if(owner===draft)renderPanel();observe();}
  }
  const turnId=node=>{const article=node.closest?.('article[data-testid^="conversation-turn"],article[data-turn-id]'),persistent=node.getAttribute?.('data-message-id')||node.closest?.('[data-message-id]')?.getAttribute('data-message-id')||article?.getAttribute('data-turn-id'),ids=[...new Set((node.getAttribute?.('data-chatgpt-search-message-ids')||'').split(/\s+/).filter(Boolean))];return persistent||ids.length===1&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(ids[0])&&ids[0]||article?.getAttribute('data-testid')&&'page:'+conversation.snapshot().pageId+':'+article.getAttribute('data-testid')||''};
  function userTurn(intent){
    // Text and late DOM insertion cannot bind a submit to a historical turn.
    // Only revisit the exact message of an already confirmed record here.
    if(intent.status!=='sent'||!intent.turnId)return null;
    const user=userMessages().find(node=>turnId(node)===intent.turnId&&normalize(userMessageText(node))===normalize(intent.raw));return user?{author:'user',turnId:turnId(user),text:userMessageText(user),url:win.location.href}:null;
  }
  function renderSendReview(container){
    const waiting=conversation.sendIntents().filter(value=>value.status!=='sent'&&conversation.ownsSendIntent(value));
    const intent=waiting.find(value=>value.id===sendReviewId)||waiting[0];if(!intent){sendReviewId=null;return;}
    sendReviewId=intent.id;
    const icon=(name,label,fn)=>{const control=action('',fn);control.className='zjf-icon';control.innerHTML=draftIcon(name);control.setAttribute('aria-label',label);return control;};
    if(waiting.length>1){const choices=element('div');for(const item of waiting){const when=new Date(item.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}),pick=action(when+' · '+(item.questionSnapshot?.title||item.raw).slice(0,70),()=>{sendReviewId=item.id;sendReviewPage=0;renderPanel();});pick.className='zjf-review-record';pick.setAttribute('aria-pressed',String(item.id===intent.id));choices.append(pick);}container.append(choices);}
    container.append(element('pre',intent.raw));
    const candidates=userMessages().filter(node=>turnId(node)&&!intent.beforeTurnIds.includes(turnId(node))&&normalize(userMessageText(node))===normalize(intent.raw));
    if(!candidates.length)container.append(element('p','未找到对应消息'));
    sendReviewPage=Math.min(sendReviewPage,Math.max(0,Math.ceil(candidates.length/20)-1));const end=candidates.length-sendReviewPage*20,start=Math.max(0,end-20);
    if(candidates.length>20){const navigation=element('div');navigation.className='zjf-review-actions';navigation.append(element('span',`${start+1}–${end} / ${candidates.length}`));if(start>0)navigation.append(icon('left','较早的匹配消息',()=>{sendReviewPage++;renderPanel();}));if(sendReviewPage>0)navigation.append(icon('right','较新的匹配消息',()=>{sendReviewPage--;renderPanel();}));container.append(navigation);}
    for(const node of candidates.slice(start,end)){const messageId=turnId(node),row=element('div'),article=node.closest?.('article[data-testid^="conversation-turn"],article[data-turn-id]')||node,following=article.nextElementSibling?.innerText?.trim().slice(0,100),controls=element('div');row.className='zjf-review-message';controls.className='zjf-review-actions';row.append(element('p',userMessageText(node).slice(0,120)));if(following)row.append(element('small',following));controls.append(icon('locate','在对话中查看',()=>{attachmentUI.close();node.scrollIntoView({block:'center'});}),icon('check','确认是这一条发送记录',event=>{
        if(!event?.isTrusted)throw Error('请查看原对话后亲自确认对应消息。');checkpoint(conversation.snapshot());if(!node.isConnected||turnId(node)!==messageId||normalize(userMessageText(node))!==normalize(intent.raw))throw Error('消息显示已变化，请重新核对。');
        const confirmed=conversation.confirmSend(intent.id,{author:'user',turnId:messageId,text:userMessageText(node),url:win.location.href,confirmation:'user-confirmed'});if(!confirmed)throw Error('这条消息不能关联到所选发送记录，原记录仍待核对。');sendReviewId=null;finishConfirmedIntent(confirmed);
      }));row.append(controls);container.append(row);}
  }
  function durableTurn(intent){
    const proof=userTurn(intent);if(!proof)return null;if(intent.confirmation==='user-confirmed')return {...proof,confirmation:'user-confirmed'};if(intent.sendCorrelation?.kind!=='submit-linked'||intent.sendCorrelation.sendId!==intent.id||intent.sendCorrelation.turnId!==proof.turnId||proof.turnId!==intent.observedTurnId)return null;const user=userMessages().find(node=>turnId(node)===proof.turnId);
    const article=user.closest?.('article[data-testid^="conversation-turn"],article[data-turn-id]'),next=article?.nextElementSibling;
    const turn=user.closest?.('[data-talvt-turn-state="complete"]'),modern=turn?.querySelector('[data-chatgpt-search-unit-key$=":assistant"][data-chatgpt-search-message-ids]');
    const assistant=article?.querySelector('[data-message-author-role="assistant"]')||next?.querySelector('[data-message-author-role="assistant"]')||modern?.querySelector('[data-conversation-role="assistant"]')?.nextElementSibling;
    if(!assistant?.innerText.trim()||modern&&!(user.compareDocumentPosition(modern)&4)||(article||turn)?.querySelector('[role="alert"],[data-testid="conversation-turn-error"]')||assistant.querySelector('[role="alert"]'))return null;
    return {...proof,confirmation:'durable-history'};
  }
  function saveIntent(intent){
    const original=intent.questionSnapshot||questionSnapshots.get(intent.questionId);if(!original)return;
    const bare={...intent};delete bare.questionSnapshot;savedVersion=Math.max(savedVersion,original.revision||0)+1;
    const data={...original,revision:savedVersion,status:intent.status,sendId:intent.id,sendIntent:bare,conversationId:intent.target.conversationId,conversationUrl:intent.target.conversationId.startsWith('c:')?'https://chatgpt.com'+intent.target.route:'',contextKeys:intent.contextKeys,turnId:intent.turnId||'',confirmation:intent.confirmation||'',adoptedFrom:intent.adoptedFrom||'',adoptionTurnId:intent.adoptionTurnId||'',adoptionConfirmation:intent.adoptionConfirmation||''};
    if(conversation.ownsSendIntent(intent)){sendSaveRetries.set(intent.id,Date.now());postQuestion(data);return data;}
  }
  function splitUnknownDraft(){
    if(!conversation.sendIntents().some(x=>x.questionId===draft.id&&x.status==='unknown'))return;
    const old=draft,set=operationSet(old),state=editState(old);
    if(!editorText().trim()&&!attachments().length){draft=newDraft({inline:true});previous='';attachedItems.clear();panel?.remove();panel=null;}
    else{draft={...structuredClone(old),id:crypto.randomUUID()};edits.set(draft,{...state,fields:new Map(state.fields),metadataEditedKeys:new Set(state.metadataEditedKeys),pendingRemovals:new Map(state.pendingRemovals),missingAttachments:new Map(state.missingAttachments)});operations.set(draft,new Set(set));operationItems.set(draft,new Map(operationItems.get(old)));}
    conversation.beginQuestion();publishComposer(true);
  }
  function nextQuestionDraft(source){
    const {next,lessonKey,contextKey}=source;
    const value=Object.assign(newDraft({seeded:seeded(contextKey),inline:true}),{next,course:{...source.course},lessonKey,contextKey});editState(value).metadataEditedKeys=new Set(editState(source).metadataEditedKeys);draft=value;conversation.beginQuestion();publishComposer(true);return value;
  }
  function advanceClearedSend(){
    if(!pendingSend||pendingSend.questionId!==draft.id||editorText().trim()||attachmentNodes().length)return false;
    pendingSend.composerCleared=true;draft=nextQuestionDraft(draft);previous='';attachedItems.clear();panel?.remove();panel=null;renderPanel();return true;
  }
  function finishConfirmedIntent(confirmed){
    recoveryCandidates.delete(confirmed.questionId);resumeCandidates.delete(confirmed.questionId);
    saveIntent(confirmed);for(const migrated of conversation.sendIntents())if(migrated.id!==confirmed.id&&migrated.adoptedFrom===confirmed.adoptedFrom&&confirmed.adoptedFrom)saveIntent(migrated);
    if(draft.id===confirmed.questionId){draft=nextQuestionDraft(draft);previous='';attachedItems.clear();panel?.remove();panel=null;}
    if(pendingSend?.id===confirmed.id)pendingSend=null;renderPanel();
  }
  function checkSent(){
    for(const [id,request]of saveRequests)if(request.status==='sent'&&Date.now()-(request.at||0)>15000)saveRequests.delete(id);
    for(const intent of conversation.sendIntents().filter(value=>value.status==='sent'&&!value.nativeSaved&&(value.confirmation==='user-confirmed'||value.sendCorrelation?.kind==='submit-linked'&&value.sendCorrelation.sendId===value.id&&value.sendCorrelation.turnId===value.turnId)&&conversation.ownsSendIntent(value))){if(Date.now()-(sendSaveRetries.get(intent.id)||0)>=5000&&![...saveRequests.values()].some(request=>request.sendId===intent.id))saveIntent(intent);}
    // There is no submit/message causal token in the supported visible UI.
    // Keep unbound sends unknown instead of using matching historical text.
    if(pendingSend&&Date.now()-pendingSend.createdAt>30000){const current=pendingSend.questionId===draft.id;conversation.markUnknown(pendingSend.id);saveIntent(conversation.sendIntents().find(x=>x.id===pendingSend.id));pendingSend=null;splitUnknownDraft();if(current)warning='发送结果尚未确认，记录已保留；请查看当前对话的发送或失败提示。';renderPanel();return true;}
    return false;
  }
  function rememberSendGesture(type){const gesture={type,clicked:false};sendGesture=gesture;win.setTimeout(()=>{if(sendGesture===gesture)sendGesture=null},0)}
  function onSend(event){
    if(event.type==='keydown'&&event.isTrusted&&!activeResume()&&editor()?.contains(event.target))allowResume=false;
    if(event.type==='keydown'&&(event.isComposing||event.keyCode===229||composing()||['Process','Dead','Unidentified'].includes(event.key)))return;
    if(event.type==='keydown'&&panel?.contains(event.target)){if(event.key==='Enter'&&!event.isComposing&&event.target.tagName==='INPUT')event.preventDefault();return;}
    const input=editor(),scope=input?.closest('form')||input?.closest('[data-composer-body]')||input?.parentElement,button=event.type==='click'?event.target.closest?.('button[aria-label="发送"],button[aria-label="Send prompt"],button[data-testid="send-button"],button[type="submit"]'):null;
    const submit=event.type==='keydown'?event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&input?.contains(event.target):button&&scope?.contains(button);
    if(!submit)return;
    reconcileIdentity();
    // A student's own Send action may proceed with the visible native draft
    // when only our record classification is unavailable. Save its raw words
    // without inventing a lecture; this never generates a Send action itself.
    if(!lessonReady&&!lessonWork&&!busy)keepVisibleDraft();
    if(!busy&&!activeResume()&&!draft.items.length&&!draft.removed.length&&!previous&&!draft.plan&&!editState().ignoreRecovery&&editorText().startsWith(DRAFT_START)){
      editState().unclassified=true;editState().ignoreRecovery=true;editState().saved=true;unboundDraftWarning=false;warning=saveWarning?.message||'';
    }
    cleanIsolatedAttachments();
    if(pendingSend){
      if(sendGesture?.type==='keydown'&&event.type==='click'&&!sendGesture.clicked){sendGesture.clicked=true;return}
      if(!sendGesture&&draft.id===pendingSend.questionId&&normalize(editorText())===normalize(pendingSend.raw)&&!userTurn(pendingSend)){rememberSendGesture(event.type);renderPanel();return}
      if(!sendGesture&&draft.id!==pendingSend.questionId){conversation.markUnknown(pendingSend.id);saveIntent(conversation.sendIntents().find(x=>x.id===pendingSend.id));pendingSend=null;}
      else{event.preventDefault();event.stopImmediatePropagation();renderPanel();return}
    }
    if(!draft.items.length&&!previous&&!editState().saved&&!busy&&!editorText().trim())return;
    if(!busy){restoreEditor();const changed=reconcileAttachments();if(changed||draft.items.length&&editState().order!==attachmentOrder()||editState(editSource()).fields.size||editState().metadataDirty||editState().needsSync)safeSync()}
    const uploads=uploadState();if(uploads.error||uploads.pending){event.preventDefault();event.stopImmediatePropagation();warning=uploads.message;editState().uploadWarning=true;renderPanel();return}
    if(!busy&&!draft.materialEdit&&editState().editWarning===warning){warning=saveWarning?.message||'';editState().editWarning='';}
    if(editState().uploadWarning&&!busy){warning=saveWarning?.message||'';editState().uploadWarning=false}
    if(busy||draft.materialEdit||activeResume()||resumeNeeded===draft||removingItems.size||saveWarning){event.preventDefault();event.stopImmediatePropagation();if(busy||draft.materialEdit||activeResume()||removingItems.size)warning='正在整理本次图片，请稍候再发送。';renderPanel();return}
    if(draft.items.length&&!normalize(editorText())){event.preventDefault();event.stopImmediatePropagation();warning='请在 ChatGPT 输入框填写问题。';renderPanel();return}
    if(previous||draft.items.length||editState().saved||editorText().trim()){
      try{reconcileIdentity();getQuestions();const raw=editorText(),snapshot=persistQuestion('draft',raw);pendingSend=conversation.beginSend({questionId:draft.id,raw,contextKeys:retainedContextKeys(),operationIds:activeOperationIds(),beforeTurnIds:userMessages().map(turnId).filter(Boolean),questionSnapshot:snapshot});rememberSendGesture(event.type);saveIntent(pendingSend);renderPanel();}
      catch(error){event.preventDefault();event.stopImmediatePropagation();warning=error.message;renderPanel();}
    }
  }
  function onNativeRemove(event){
    if(replacing)return;
    if(event.target.closest?.('.zjf-native-tools'))return;
    const byKey=event.type==='keydown'&&['Delete','Backspace'].includes(event.key)&&!event.isComposing&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey&&!event.target.isContentEditable&&!['INPUT','TEXTAREA'].includes(event.target.tagName);
    if(event.type==='keydown'&&!byKey)return;
    const button=event.target.closest?.('button[aria-label^="移除"],button[aria-label^="Remove"],button[aria-label^="删除"]');
    const root=(button||byKey&&event.target)?.closest?.('.composer-attachment-surface[role="button"],[class~="group/composer-attachment"]');if(!root)return;
    if(event.isTrusted)restoreRevision++;
    if(event.isTrusted&&clearedDraft)clearedDraft.keyboardUndo=false;
    if(byKey){const remove=removeControl(root);if(remove){event.preventDefault();event.stopImmediatePropagation();remove.click();}return;}
    getQuestions();const name=attachmentName(root),item=draft.items.find(value=>fileName(value)===name);if(!item)return;item.nativeAttachmentIndex=attachmentNodes().indexOf(root);editState().pendingRemovals.set(name,{time:Date.now(),itemId:item.id,keepQuestion:true,attempts:1,after:Date.now()+250});persistQuestion('draft',undefined,false);
    const removedFrom=draft,version=lessonInputVersion;win.setTimeout(()=>{if(!busy)observe();if(removedFrom===draft&&version===lessonInputVersion)attachmentUndo={owner:draft,text:editorText()};},0);
  }
  page.addEventListener('keydown',onSend,true);page.addEventListener('click',onSend,true);
  page.addEventListener('click',onNativeRemove,true);
  page.addEventListener('keydown',onNativeRemove,true);
  function requestContext(keysOfInterest=[],cursor=0,resume=cursor===0?resumeRequest():null){
    if(!workspaceActive())return '';
    let request;
    try{
      const pending=allowResume&&[...ledgerRequests.values()].find(request=>request.resumeText===editorText()&&conversation.isCurrent(request.target));
      if(cursor===0){contextQueryEpoch++;deferredLedgerPage=null;for(const id of ledgerRequests.keys())retireRequest(id);ledgerRequests.clear();}
      request={...conversation.requestLedger(),queryEpoch:contextQueryEpoch,keysOfInterest:[...new Set(keysOfInterest)].slice(0,600),cursor,...(resume||pending&&{resumeDraftIds:pending.resumeDraftIds,resumeText:pending.resumeText})};operationTarget(request.target);ledgerRequests.set(request.requestId,request);
      if(request.resumeDraftIds){if(resumeWait)win.clearTimeout(resumeWait.timer);resumeWait={...request,timer:win.setTimeout(()=>resumeQueryFailed(request.requestId,'资料读取未完成，当前草稿已保留。'),5000)};}
      post(request);return request.requestId;
    }catch(error){if(request?.resumeDraftIds)resumeQueryFailed(request.requestId,error.message||'连接已中断，当前草稿已保留。');return '';}
  }
  function continueContextPage(pageRequest){
    if(!pageRequest||!workspaceCurrent(pageRequest.target)||pageRequest.queryEpoch!==contextQueryEpoch||!conversation.isCurrent(pageRequest.target))return false;
    if(busy||activeResume()){deferredLedgerPage=pageRequest;return false;}
    deferredLedgerPage=null;requestContext(pageRequest.keysOfInterest,pageRequest.cursor,null);return true;
  }
  function isolateOutgoingComposer(outgoing,oldEditor,currentEditor){
    const names=new Set([...outgoing.items,...outgoing.materialEdit?.items||[]].map(fileName));let unresolved=false;
    for(const name of names)isolationNames.add(name);
    replacing=true;
    try{for(const node of attachmentNodes().filter(x=>names.has(attachmentName(x)))){isolationNames.add(attachmentName(node));const remove=removeControl(node);if(remove)remove.click();else unresolved=true;}}
    finally{replacing=false;}
    const fresh=navigationCause==='new-chat',prepared=fresh&&preparedNewChat?.cleared&&preparedNewChat.owner===outgoing?preparedNewChat:null;
    const last=fresh?prepared?.text:editState(outgoing).lastText;
    if(currentEditor&&(fresh?!!prepared:currentEditor===oldEditor)&&last&&editorText()===last){
      writing=true;
      try{if('value'in currentEditor){Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype,'value').set.call(currentEditor,'');currentEditor.dispatchEvent(new win.Event('input',{bubbles:true}));}
        else{const selection=win.getSelection(),range=page.createRange();currentEditor.focus({preventScroll:true});range.selectNodeContents(currentEditor);selection.removeAllRanges();selection.addRange(range);if(!page.execCommand('delete',false)||editorText().trim())unresolved=true;}}
      finally{writing=false;}
    }else if(currentEditor&&editorText().includes(DRAFT_START)&&(fresh||currentEditor===oldEditor&&last))unresolved=true;
    return unresolved?'输入框仍有旧对话材料，请先保留并清理旧草稿，再向新对话附图。':'';
  }
  function reconcileIdentity(){
    const now=win.location.pathname,e=editor(),newRoot=navigationCause==='new-chat'&&!canonicalConversationId(win.location.href);
    if(now!==route||newRoot){
      if(fieldCommitTimer){win.clearTimeout(fieldCommitTimer);fieldCommitTimer=0;}deferredSync=false;composition=null;
      allowResume=false;resumeCandidates.clear();resumeNeeded=null;recoveryBlocked='';unboundDraftWarning=false;if(resumeWait)win.clearTimeout(resumeWait.timer);resumeWait=null;resumeQueryError='';
      const old=conversation.snapshot(),knownCandidates=new Set(conversation.sendIntents().filter(x=>x.adoptionCandidate).map(x=>x.id)),isolationWarning=isolateOutgoingComposer(draft,knownEditor,e);preparedNewChat=null;if(old.conversationId.startsWith('c:'))drafts.set(old.conversationId,{draft,previous,cleared:clearedDraft?.empty===draft?clearedDraft:null});conversation.transition(win.location.href,{newConversation:newRoot,cause:newRoot?'new-chat':navigationCause});navigationCause='route';route=now;
      const saved=conversation.snapshot().conversationId.startsWith('c:')?drafts.get(conversation.snapshot().conversationId):null;draft=saved?.draft||freshLessonDraft();previous=saved?.previous||'';attachedItems.clear();panel?.remove();panel=null;pendingSend=null;warning=isolationWarning;saveWarning=null;knownEditor=e;resolvedLedgers.clear();ledgerRequests.clear();recoveryCandidates.clear();trimDraftCache();
      clearedDraft=saved?.cleared||null;if(clearedDraft?.empty===draft&&!draft.items.length&&!draft.removed.length&&!editState().lastText.trim())clearedDraft.target=conversation.snapshot();
      if(saved){editState().returnText=editState().lastText;editState().returnRestore=true;for(const item of draft.items)retireUpload(item);needImageResume(draft,operationTarget(),true);}
      if(viewerLesson&&newRoot){editState().saved=true;editState().workspaceReset=true;persistQuestion();}
      if(conversation.isCurrent(conversation.snapshot())){publishComposer(true);requestContext();for(const intent of conversation.sendIntents())if(intent.adoptionCandidate&&!knownCandidates.has(intent.id)&&intent.status!=='sent')saveIntent(intent);}return true;
    }
    if(knownEditor&&e&&knownEditor!==e){conversation.transition(win.location.href,{cause:'composer-replaced'});knownEditor=e;publishComposer(true);requestContext();return true;}if(e)knownEditor=e;publishComposer();return false;
  }
  function checkpoint(value){if(!workspaceCurrent(value))throw new ConversationChangedError();reconcileIdentity();if(value?.attemptId){conversation.assertCurrent(value);if(value.draftId&&value.draftId!==draft.id)throw new ConversationChangedError();}else if(!conversation.isCurrent(value))throw new ConversationChangedError();}
  function cleanIsolatedAttachments(){replacing=true;try{for(const node of attachmentNodes().filter(x=>isolationNames.has(attachmentName(x))))removeControl(node)?.click();}finally{replacing=false;}}
  function cleanPendingRemovals(){
    if(!workspaceActive())return;const state=editState(),nodes=new Map(attachmentNodes().map(node=>[attachmentName(node),node]));
    for(const [name,intent]of state.pendingRemovals){const node=nodes.get(name);if(!node||intent.attempts>=3||Date.now()<(intent.after||0)||!draft.items.some(item=>item.id===intent.itemId&&fileName(item)===name))continue;const button=removeControl(node);if(!button)continue;intent.attempts=(intent.attempts||0)+1;intent.after=Date.now()+1000*intent.attempts;replacing=true;try{button.click();}finally{replacing=false;}}
  }
  function observe(){
    if(disposed||!workspaceActive())return;
    reconcileIdentity();renderPanel();
    if(saveWarning&&conversation.isCurrent(saveWarning.target)&&draft.id===saveWarning.id){
      const latest=questionSnapshots.get(draft.id),key=latest&&latest.id+':'+latest.revision;
      if(key&&draftSaveRetry?.key!==key)draftSaveRetry={key,count:0,after:Date.now()+500};
      if(latest&&draftSaveRetry.count<3&&Date.now()>=draftSaveRetry.after&&![...saveRequests.values()].some(request=>request.id===latest.id&&request.revision===latest.revision)){
        draftSaveRetry.after=Date.now()+700*2**draftSaveRetry.count;draftSaveRetry.count++;postQuestion(latest,conversation.snapshot());
      }
    }
    if(!lessonReady){if(lessonRequest&&!conversation.isCurrent(lessonRequest.target)){win.clearTimeout(lessonRequest.timer);lessonRequest=null;lessonError='';}requestLesson();return;}
    if(lessonWork)return;
    cleanIsolatedAttachments();cleanPendingRemovals();if(busy||activeResume())return;
    if(deferredLedgerPage){const pending=deferredLedgerPage;deferredLedgerPage=null;if(continueContextPage(pending))return;}
    const resuming=resumeRequest();if(resuming)requestContext([],0,resuming);recoverDraft();if(activeResume())return;
    if(draft.materialEdit&&!draft.materialEdit.recoveryFailed){
      const owner=draft,target=operationTarget();busy=true;
      void discardMaterialEdit(owner,target).catch(error=>{if(owner===draft){if(owner.materialEdit)owner.materialEdit.recoveryFailed=true;warning='选材调整未完成，原图已保留：'+error.message;persistQuestion();}}).finally(()=>{busy=false;if(owner===draft)renderPanel();});return;
    }
    if(checkSent())return;
    if(pendingSend&&pendingSend.questionId===draft.id){
      advanceClearedSend();
      return;
    }
    if(!editorText().trim()&&!attachments().length&&conversation.sendIntents().some(x=>x.questionId===draft.id&&x.status==='unknown'))return;
    if(resumeNeeded===draft){
      const state=editState(),target=state.imageResumeTarget,uploads=uploadState();
      if(!target||!workspaceCurrent(target)||!conversation.isCurrent(target))return;
      if(!composing()&&state.returnRestore){restoreEditor();state.returnRestore=false;}
      if(!composing()){
        const retry=state.imageResumeRetry,due=state.imageResumeFailed&&retry&&retry.attempts<3&&Date.now()>=retry.after&&workspaceCurrent(retry.target)&&conversation.isCurrent(retry.target);
        // A failed attempt retains its original composer and accepted images.
        // Upload completion and durable saving share these three bounded
        // continuations; neither grants a new draft or route target.
        if(!uploads.error&&!state.imageResumeFailed||due){if(due){retry.attempts++;state.imageResumeFailed=false;}void resumeImages(target).catch(()=>{});}
      }
      return;
    }
    restoreEditor();
    // The lecture was established at the document boundary. Dictation and
    // editor transforms can change text without a trusted DOM input event;
    // that is still an edit of this draft, not evidence of another lecture.
    if(editState().saved&&!composing()&&editorText()!==editState().lastText)persistQuestion();
    const changed=reconcileAttachments();
    if(changed||draft.items.length&&editState().order!==attachmentOrder()||editState().needsSync||editState().metadataDirty&&!attachmentUI.popup?.contains(page.activeElement))safeSync();
  }
  const timer=win.setInterval(observe,400);
  async function receive(batch,isPlan=false,delivery){
    const id=batch?.id;if(typeof id!=='string')return;
    if(!workspaceCurrent(delivery)){report(delivery,'cancelled');return;}
    observe();
    if(hasLessonContext&&(!lessonReady||lessonWork)){requestLesson();try{await waitFor(()=>{if(lessonError)throw Error(lessonError);return lessonReady&&!lessonWork},15000,operationTarget(delivery?.target));}catch(error){report(delivery,error.code==='conversation_changed'?'cancelled':'error',error.message);return;}}
    if(viewerLesson&&!isPlan&&studyLessonScope(batch.lessonKey)!==viewerLesson){report(delivery,'error','这批截图属于另一讲，原材料已保留。请从资料库明确选择要引用的内容。');return;}
    observe();let attempt;
    try{if(!delivery||delivery.materialId!==id)throw Error('提问组件需要更新，原图已保留。');if(delivery.draftId!==draft.id)throw new ConversationChangedError();attempt=conversation.beginDelivery(delivery);workspaceLeases.set(attempt,workspaceLeases.get(delivery)||{epoch:workspaceEpoch});checkpoint(attempt);}catch(error){report(delivery,'cancelled',error.message);return;}
    busy=true;activeDelivery=attempt;editState().imageResumeFailed=false;editState().imageResumeRetry=null;report(attempt,'working');renderPanel();
    try{
      if(pendingSend&&pendingSend.questionId===draft.id){await waitFor(()=>{advanceClearedSend();checkSent();return !pendingSend||pendingSend.questionId!==draft.id;},31000,attempt);checkpoint(attempt);}
      splitUnknownDraft();
      const resuming=activeResume();if(resuming)await resuming;checkpoint(attempt);
      await waitFor(editor,12000,attempt);checkpoint(attempt);
      const interested=isPlan?[...batch.logicalItems.filter(x=>x.kind==='board'||x.kind==='panorama').map(x=>backgroundKey(x)),...batch.logicalItems.map(x=>draftContextKey(x)).filter(Boolean)]:[batch.contextKey||batch.lessonKey,...batch.context.map(x=>backgroundKey(x,batch.contextKey||batch.lessonKey))].filter(Boolean);
      const requestId=requestContext(interested);if(!requestId)throw Error('提问资料尚未就绪。');await waitFor(()=>resolvedLedgers.has(requestId),5000,attempt);checkpoint(attempt);
      await waitFor(()=>{if(reconcileAttachments())safeSync();return !hasPendingRemovals()},3000,attempt);checkpoint(attempt);
      recoverDraft();const recovered=activeResume();if(recovered)await recovered;checkpoint(attempt);if(recoveryOptions().length)throw Error('当前草稿尚未确定，所选材料已保留。');const images=new Map((isPlan?batch.items:[...batch.context,batch.selection]).map(x=>[x.id,x.image]));for(const item of [...draft.items,...draft.removed])if(images.has(item.id))item.image=images.get(item.id);
      if(!draft.items.length&&attachmentNodes().some(node=>!isolationNames.has(attachmentName(node))&&attachmentName(node)?.startsWith('zjf-')))throw Error('输入框里已有未核对的板书草稿。当前内容已保留，请先处理现有草稿。');
      await waitFor(()=>!attachmentNodes().some(x=>isolationNames.has(attachmentName(x))),5000,attempt);checkpoint(attempt);
      if(warning.startsWith('输入框仍有旧对话材料')&&editorText().includes(DRAFT_START))throw Error(warning);
      const recorded=operationItems.get(draft)?.get(attempt.operationId);if(recorded&&recorded.materialId!==attempt.materialId)throw Error('投递编号不能改绑到另一份材料，原草稿已保留。');
      if(recorded)await waitForSaved(persistQuestion(),attempt);checkpoint(attempt);
      const existing=conversation.reuseDelivery(attempt,{verifySent:intent=>!!durableTurn(intent),verifyRemoved:()=>recorded?.materialId===attempt.materialId&&deliveryContents(batch,isPlan).removed,verifyDraft:()=>operationSet().has(attempt.operationId)&&recorded?.materialId===attempt.materialId&&deliveryContents(batch,isPlan).attached&&!!editorText().trim()&&editState().order===attachmentOrder()&&!editState(editSource()).fields.size&&!editState().metadataDirty&&!editState().needsSync&&draft.items.every(x=>findNode(x)?.isConnected)&&!uploadState().pending&&!uploadState().error,count:deliveryContents(batch,isPlan).count});
      if(existing){postReceipt(existing,attempt);return;}
      if(attempt.reconcileOnly===true)throw Error('尚未找到这次发送的确认记录，现有草稿已保留。');
      getQuestions();
      if(isPlan){
        for(;;){
          const diff=planDraftAppend(draft,batch);let projection=null;
          if(diff.requiresProjection){const owner=draft;persistQuestion();try{projection=await requestProjection({purpose:'delivery',operationId:attempt.operationId,attemptId:attempt.attemptId,materialId:attempt.materialId,keepRefs:diff.refs},attempt,()=>owner===draft&&sameRefSet(planDraftAppend(draft,batch).refs,diff.refs));}catch(error){if(error.code==='draft_projection_changed')continue;throw error;}checkpoint(attempt);}
          getQuestions();appendStudyPlan(draft,batch,{projection});break;
        }
      }else{
        const key=batch.contextKey||batch.lessonKey,known=seeded(key),context=batch.context.filter(x=>!seeded(backgroundKey(x,key))),provided=known||batch.contextComplete!==false&&batch.context.length>0&&!context.length;
        if(!draft.items.length&&!draft.removed.length&&!draft.plan&&!previous&&!editState().saved&&draft.lessonKey!==batch.lessonKey){draft=newDraft({seeded:provided,inline:true});attachedItems.clear()}
        draft.contextMaterials??=[];for(const {image,thumbnail,...item}of batch.context)if(!draft.contextMaterials.some(x=>draftMaterialKey(x)===draftMaterialKey(item)))draft.contextMaterials.push({...item,contextKey:key});appendCapture(draft,{...batch,context,contextAlreadySent:provided});
      }
      const requested=new Set((isPlan?batch.logicalItems:[batch.selection]).map(draftMaterialKey)),itemIds=[...logicalDraftItems(draft),...(draft.removedLogical||[]),...draft.removed].filter(x=>requested.has(draftMaterialKey(x))).map(x=>x.id);if(isPlan)itemIds.push(...draftCarryKeys(draft,batch.carry||[]));
      // Keep the operation's source membership even when upload only partly
      // succeeds. A later append can finish those sources in the same draft.
      operationSet().add(attempt.operationId);if(!operationItems.has(draft))operationItems.set(draft,new Map());operationItems.get(draft).set(attempt.operationId,{materialId:attempt.materialId,itemIds:[...new Set(itemIds)]});persistQuestion();renderPanel();
      for(const item of [...draft.items]){checkpoint(attempt);reconcileAttachments();if(draft.items.includes(item))await attach(item,attempt);checkpoint(attempt)}
      await waitForUploads(attempt);await waitForComposition(attempt);syncText();checkpoint(attempt);
      await waitForSaved(persistQuestion(),attempt);checkpoint(attempt);const receipt=conversation.finishDelivery(attempt,{verifyRemoved:()=>deliveryContents(batch,isPlan).removed,verifyDraft:()=>deliveryContents(batch,isPlan).attached&&!!editorText().trim()&&draft.items.every(x=>findNode(x)?.isConnected)&&!uploadState().pending&&!uploadState().error,count:deliveryContents(batch,isPlan).count});bindRecordedOperations();renderPanel();postReceipt(receipt,attempt);
    }catch(e){if(conversation.isCurrent(attempt.target)){if(workspaceCurrent(attempt)){warning=e.message;editState().uploadWarning=!!(uploadState().pending||uploadState().error);if(editState().uploadWarning)editState().imageResumeFailed=true;}persistQuestion();renderPanel();}report(attempt,e.code==='conversation_changed'?'cancelled':'error',e.message)}finally{activeDelivery=null;busy=false;observe();renderPanel()}
  }
  function queueReceive(batch,isPlan,delivery){
    if(delivery&&typeof delivery==='object'){const lease={epoch:workspaceEpoch};workspaceLeases.set(delivery,lease);if(delivery.target&&typeof delivery.target==='object')workspaceLeases.set(delivery.target,lease);}
    const task=serial.then(()=>receive(batch,isPlan,delivery));serial=task.catch(()=>{});return task;
  }
  const listener=e=>{
    const message=e.data;if(disposed||!message)return;
    if(message.kind==='zjf-close-state'){if(conversation.isCurrent(message.target))setCloseState(message.closeRevision,message.frozen);return;}
    if(message.kind==='zjf-workspace-state'){acceptWorkspace(message);return;}
    if(message.kind==='zjf-pane-visible'){if(!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches)page.documentElement.animate?.([{opacity:0,transform:'translateX(10px)'},{opacity:1,transform:'translateX(0)'}],{duration:220,easing:'cubic-bezier(.22,1,.36,1)'});return;}
    if(message.kind==='zjf-lesson-resume'&&lessonRequest?.requestId===message.requestId&&conversation.isCurrent(message.target)&&workspaceCurrent(lessonRequest.target)&&conversation.isCurrent(lessonRequest.target)&&studyLessonScope(message.lessonKey)===viewerLesson){
      const request=lessonRequest;win.clearTimeout(request.timer);lessonError='';const work={request};lessonWork=work;
      void installLessonResume(message,request).finally(()=>{if(lessonWork===work)lessonWork=null;if(lessonReady){lessonRetries=0;win.clearTimeout(lessonRetryTimer);}else if(lessonError)scheduleLessonRetry();publishComposer(true);renderPanel();});return;
    }
    if(message.kind==='zjf-bridge-challenge'){const bind=conversation.answerChallenge(message);if(bind)post({...bind,...composerState()});return;}
    if(message.kind==='zjf-bridge-error'&&lessonRequest?.requestId===message.requestId){win.clearTimeout(lessonRequest.timer);lessonRequest=null;lessonError=message.error||'草稿读取未完成，当前输入已保留。';warning=lessonError;publishComposer(true);scheduleLessonRetry();renderPanel();return;}
    if(message.kind==='zjf-bridge-bound'){if(conversation.acceptBinding(message)){acceptWorkspace(message);setCloseState(message.closeRevision,message.closeFrozen);viewerInstance=typeof message.viewerInstance==='string'?message.viewerInstance:'';updateLessonMetadata(message);publishComposer(true);if(!lessonReady){lessonRetries=0;if(lessonError&&workspaceActive())retryLesson();else requestLesson();}else{requestContext();if(editState().saved)persistQuestion();}}return;}
    if(message.kind==='zjf-lesson-metadata'&&conversation.isCurrent(message.target)){updateLessonMetadata(message);return;}
    if(message.kind==='zjf-viewer-instance'&&conversation.isCurrent(message.target)){viewerInstance=typeof message.viewerInstance==='string'?message.viewerInstance:'';if(editState().saved)persistQuestion();return;}
    if(message.kind==='zjf-question-saved'){
      const request=saveRequests.get(message.requestId),matches=request&&message.id===request.id&&['conversationId','route','pageId','documentEpoch','routeGeneration','composerGeneration'].every(key=>message.target?.[key]===request.target[key]);
      if(matches){saveRequests.delete(message.requestId);savedRevisions.set(request.id,Math.max(savedRevisions.get(request.id)||0,request.revision));if(request.status==='sent'&&message.status==='sent')conversation.confirmSavedQuestion(request.id,request.sendId,request.revision);const saved=questionSnapshots.get(request.id);if(saved?.revision===request.revision)rememberDraft(saved);if(conversation.isCurrent(request.target)&&saveWarning?.id===request.id&&saveWarning.revision<=request.revision){if(warning===saveWarning.message)warning='';saveWarning=null;renderPanel();}trimDraftCache();}return;
    }
    if(message.kind==='zjf-draft-claimed'){const request=claimRequests.get(message.requestId);if(request&&conversation.isCurrent(message.target)&&conversation.isCurrent(request.target)&&message.sourceId===request.sourceId&&/^[a-f0-9-]{36}$/i.test(message.draftId||'')&&['resume','copy'].includes(message.disposition)&&Number.isSafeInteger(message.revision)&&message.revision>0)request.result=message;return;}
    if(message.kind==='zjf-draft-image'){const request=imageRequests.get(message.requestId);if(request&&conversation.isCurrent(message.target)&&conversation.isCurrent(request.target)&&typeof message.image==='string'&&/^data:image\/(?:png|jpeg);base64,/.test(message.image)&&message.image.length<=(request.preview?96:12)*1024*1024)request.result={image:message.image};return;}
    if(message.kind==='zjf-draft-project'){const request=projectRequests.get(message.requestId);if(request&&conversation.isCurrent(message.target)&&conversation.isCurrent(request.target)&&projectResponseMatches(request,message)&&request.current())request.result={plan:message.plan};return;}
    if(message.kind==='zjf-draft-background-proof'){const request=projectRequests.get(message.requestId);if(request?.purpose==='shared-background'&&request.draftId===message.draftId&&request.itemId===message.itemId&&conversation.isCurrent(message.target)&&conversation.isCurrent(request.target)&&request.current()&&/^[a-f0-9]{64}$/.test(message.proof||'')&&/^[a-f0-9]{64}$/.test(message.asset||''))request.result={proof:message.proof,asset:message.asset};return;}
    if(message.kind==='zjf-delivery'){
      const {delivery,payload}=message;
      if(payload?.kind==='zjf-capture')void queueReceive(payload.batch,false,delivery).catch(()=>{});
      if(payload?.kind==='zjf-study-plan')void queueReceive(payload.plan,true,delivery).catch(()=>{});
    }
    if(message.kind==='zjf-bridge-error'&&ledgerRequests.get(message.requestId)?.resumeDraftIds){resumeQueryFailed(message.requestId,message.error||'资料读取未完成。');ledgerRequests.delete(message.requestId);return;}
    if(message.kind==='zjf-bridge-error'&&saveRequests.has(message.requestId)){
      const save=saveRequests.get(message.requestId);if(message.target&&!['conversationId','route','pageId','documentEpoch','routeGeneration','composerGeneration'].every(key=>message.target[key]===save.target[key]))return;
      saveRequests.delete(message.requestId);if((savedRevisions.get(save.id)||0)>=save.revision)return;
      if(conversation.isCurrent(save.target)&&draft.id===save.id){saveWarning={...save,message:'提问记录尚未保存：'+message.error};warning=saveWarning.message;renderPanel();}return;
    }
    if(message.kind==='zjf-bridge-error'&&(!message.target||conversation.isCurrent(message.target))){if(retiredRequests.has(message.requestId))return;const claim=claimRequests.get(message.requestId);if(claim){claim.result={error:message.error,code:message.code};return;}const project=projectRequests.get(message.requestId);if(project){if((project.purpose==='shared-background'||projectResponseMatches(project,message))&&project.current())project.result={error:message.error,code:message.code};return;}const request=imageRequests.get(message.requestId);if(request){request.result={error:message.error};if(request.preview)return;}warning='提问记录或附图处理失败：'+message.error;renderPanel()}
    if(message.kind==='zjf-context-ledger'&&ledgerRequests.has(message.requestId)&&workspaceCurrent(ledgerRequests.get(message.requestId).target)&&conversation.applyLedger(message)){
      const resumeQuery=ledgerRequests.get(message.requestId),resumeAllowed=allowResume&&resumeQuery?.resumeText===editorText();
      if(resumeWait?.requestId===message.requestId){win.clearTimeout(resumeWait.timer);win.clearTimeout(resumeQueryRetryTimer);resumeQueryRetries=0;resumeWait=null;if(warning===resumeQueryError)warning='';resumeQueryError='';}
      resolvedLedgers.add(message.requestId);if(resolvedLedgers.size>20)resolvedLedgers.delete(resolvedLedgers.values().next().value);
      conversation.hydrateQuestions(message.questions||[]);for(const intent of conversation.sendIntents())if(intent.questionSnapshot){questionSnapshots.set(intent.questionId,intent.questionSnapshot);savedVersion=Math.max(savedVersion,intent.questionSnapshot.revision||0);}
      for(const record of message.drafts||[])if(record?.conversationId===message.target.conversationId&&record?.status==='draft'&&record?.draftManifest){const previous=recoveryCandidates.get(record.id);if(!previous||(record.revision||0)>(previous.revision||0))recoveryCandidates.set(record.id,record);}recoverDraft();
      if(resumeAllowed)for(const record of message.resumeDrafts||[]){if(!resumeQuery.resumeDraftIds?.includes(record.id)&&!resumeQuery.resumeDraftIds?.includes(record.recoveryOf?.id)||record.status!=='draft'||typeof record.draftManifest?.composerText!=='string'||!matchesSavedText(record.draftManifest,editorText()))continue;resumeCandidates.add(record.id);recoveryCandidates.set(record.id,record);}
      if(resumeAllowed)recoverDraft();
      if(resumeAllowed&&!draft.items.length&&!draft.removed.length&&!recoveryOptions().length&&editorText().startsWith(DRAFT_START)){resumeQueryError='未找到对应草稿，当前文字已保留。';warning=resumeQueryError;}
      renderPanel();
      const request=ledgerRequests.get(message.requestId);ledgerRequests.delete(message.requestId);
      if(Number.isInteger(message.nextCursor)&&message.nextCursor>request?.cursor)win.setTimeout(()=>continueContextPage({...request,target:message.target,cursor:message.nextCursor}),0);
    }
  };
  const onBeforeInput=event=>{
    const input=editor();if(writing||!draft.inline||!input?.contains(event.target))return;noteInlineInput(draft,null);if(composing())return;
    const parts=draftTextParts(draft,editorText(),previous);if(parts.body!==draft.inline.text)return;rememberCaret();
    if(/^history(?:Undo|Redo)$/.test(event.inputType||'')){noteInlineInput(draft,{before:parts.body,start:0,end:0,type:event.inputType});return;}
    let start=savedCaret?.owner===draft?savedCaret.start:null,end=savedCaret?.owner===draft?savedCaret.end:null;
    try{const target=event.getTargetRanges?.()[0];if(target&&input.contains(target.startContainer)&&input.contains(target.endContainer)){const prefix=page.createRange();prefix.selectNodeContents(input);prefix.setEnd(target.startContainer,target.startOffset);start=prefix.toString().replace(/\r/g,'').length;prefix.setEnd(target.endContainer,target.endOffset);end=prefix.toString().replace(/\r/g,'').length;}}catch{}
    if(Number.isInteger(start)&&Number.isInteger(end)&&start>=0&&end<=parts.body.length)noteInlineInput(draft,{before:parts.body,start,end,type:event.inputType||''});
  };page.addEventListener('beforeinput',onBeforeInput,true);
  const onInput=e=>{
    if(writing)return;if(e.isTrusted&&clearedDraft)clearedDraft.keyboardUndo=false;if(panel?.contains(e.target)){preparedNewChat=null;return;}if(!editor()?.contains(e.target))return;if(e.isTrusted)attachmentUndo=null;reconcileIdentity();
    if(editorText()!==editState().lastText)restoreRevision++;
    if(e.isTrusted)lessonInputVersion++;
    if(!lessonReady)return;
    if(editorText().trim())editState().workspaceReset=false;
    if(e.isTrusted&&!activeResume()&&['insertFromPaste','insertFromDrop'].includes(e.inputType))allowResume=false;if(unboundDraftWarning&&!editorText().startsWith(DRAFT_START)){unboundDraftWarning=false;warning='';}
    if(!preparedNewChat?.cleared||e.isTrusted||editorText()&&editorText()!==preparedNewChat.text)preparedNewChat=null;
    if(pendingSend&&pendingSend.questionId===draft.id){
      if(!editorText().trim()){advanceClearedSend();return;}
      if(normalize(editorText())===normalize(pendingSend.raw))return;
      const old=draft,state=editState(old),originalAttachments=attachmentNodes().some(node=>old.items.some(item=>fileName(item)===attachmentName(node)));
      if(pendingSend.composerCleared||userTurn(pendingSend)&&!originalAttachments){
        draft=nextQuestionDraft(old);previous='';attachedItems.clear();
      }else{
        draft={...structuredClone(old),id:crypto.randomUUID()};
        conversation.beginQuestion();publishComposer(true);
        edits.set(draft,{...state,fields:new Map(state.fields),metadataEditedKeys:new Set(state.metadataEditedKeys),pendingRemovals:new Map(state.pendingRemovals),missingAttachments:new Map(state.missingAttachments)});operations.set(draft,new Set(operationSet(old)));operationItems.set(draft,new Map(operationItems.get(old)));reconcileAttachments();
      }
    }
    splitUnknownDraft();persistQuestion();renderPanel();
  };page.addEventListener('input',onInput);
  const onCompositionStart=e=>{if(editor()?.contains(e.target)||panel?.contains(e.target)||attachmentUI.popup?.contains(e.target)){if(!activeResume())allowResume=false;composition={draft,node:e.target}}};
  const onCompositionEnd=()=>{composition=null;const owner=draft,target=conversation.snapshot();workspaceLeases.set(target,{epoch:workspaceEpoch});win.setTimeout(()=>{if(disposed||composing()||owner!==draft||!conversation.isCurrent(target))return;if(deferredSync&&workspaceCurrent(target)){deferredSync=false;safeSync()}else{persistQuestion();renderPanel()}},0)};
  const onFocusOut=()=>{win.setTimeout(()=>{if(!disposed&&!composing()&&deferredPanel&&!panel?.contains(page.activeElement))renderPanel()},0)};
  page.addEventListener('selectionchange',rememberCaret);page.addEventListener('compositionstart',onCompositionStart);page.addEventListener('compositionend',onCompositionEnd);page.addEventListener('focusout',onFocusOut);

  const onNavigation=e=>{
    if(e.target.closest?.('.zjf-native-tools,.zjf-attachment-popup,#zjf-capture-draft'))return;
    const button=e.target.closest?.('button,a'),label=(button?.getAttribute('aria-label')||button?.textContent||'').trim();
    if(/^(?:新聊天|New chat)(?:\s*[（(].*[)）])?$/i.test(label)||/^在.*中(?:开启|开始)新聊天$/.test(label)||/^New chat in .+$/i.test(label)){
      if(!preparedNewChat?.cleared||!conversation.isCurrent(preparedNewChat.target)||editorText()!==preparedNewChat.text){
        e.preventDefault();e.stopImmediatePropagation();const owner=draft;
        void commitNewChat(button).catch(error=>{if(!disposed&&owner===draft&&error.code!=='conversation_changed'){warning=error.message;renderPanel()}});return;
      }
      navigationCause='new-chat';win.setTimeout(observe,0);return;
    }
    const anchor=e.target.closest?.('a[href]');if(!anchor)return;try{const url=new URL(anchor.href,win.location.href);if(url.origin==='https://chatgpt.com'){
      const history=canonicalConversationId(url.href);
      if(history&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey&&!e.altKey){
        if(preparedHistory?.anchor===anchor&&preparedNavigationCurrent(preparedHistory.prepared,anchor))preparedHistory=null;
        else{e.preventDefault();e.stopImmediatePropagation();const owner=draft;void commitHistoryNavigation(anchor).catch(error=>{if(!disposed&&owner===draft&&error.code!=='conversation_changed'){warning=error.message;renderPanel()}});return;}
      }else persistQuestion();
      navigationCause=history?'history':'new-chat';win.setTimeout(observe,0);
    }}catch{}
  };
  const onComposerKey=e=>{
    if(e.isComposing||e.keyCode===229||composing())return;
    const key=e.key?.toLowerCase();
    if(key==='z'&&(e.ctrlKey||e.metaKey)&&!e.shiftKey&&!e.altKey&&!busy&&!activeResume()&&editor()?.contains(e.target)&&attachmentUndo?.owner===draft&&attachmentUndo.text===editorText()&&draft.removed.length){
      e.preventDefault();e.stopImmediatePropagation();attachmentUndo=null;void Promise.resolve(undoAttachmentAction()).catch(error=>{warning=error.message;renderPanel();});return;
    }
    if(key==='z'&&(e.ctrlKey||e.metaKey)&&!e.shiftKey&&!e.altKey&&!busy&&!activeResume()&&clearedDraft?.keyboardUndo&&clearUndoAvailable()&&editor()?.contains(e.target)){
      e.preventDefault();e.stopImmediatePropagation();const cleared=clearedDraft;cleared.keyboardUndo=false;
      void Promise.resolve(undoClear()).catch(error=>{if(!disposed&&clearedDraft===cleared){cleared.keyboardUndo=!!clearUndoAvailable();warning=error.message;renderPanel()}});return;
    }
    // Once another edit starts, native Undo owns that edit. The saved clear
    // remains available through the existing draft control and history.
    if(e.isTrusted&&clearedDraft&&!['control','shift','alt','meta'].includes(key))clearedDraft.keyboardUndo=false;
    if(key==='o'&&e.shiftKey&&(e.ctrlKey||e.metaKey)&&!e.altKey){e.preventDefault();e.stopImmediatePropagation();const owner=draft;void startNewChat().catch(error=>{if(!disposed&&owner===draft&&error.code!=='conversation_changed'){warning=error.message;renderPanel()}})}
  };
  const onPopState=()=>{navigationCause='history';observe()};page.addEventListener('click',onNavigation,true);win.addEventListener?.('popstate',onPopState);
  page.addEventListener('keydown',onComposerKey,true);
  win.chrome?.webview?.addEventListener('message',listener);
  knownEditor=editor();post({kind:'zjf-draft-ready',protocol:2,url:win.location.href});
return {receive:(batch,delivery)=>queueReceive(batch,false,delivery),receivePlan:(plan,delivery)=>queueReceive(plan,true,delivery),target:conversation.snapshot,sendIntents:conversation.sendIntents,dispose(){disposed=true;win.clearTimeout(lessonRetryTimer);win.clearTimeout(resumeQueryRetryTimer);if(lessonRequest?.timer)win.clearTimeout(lessonRequest.timer);if(win.__ZJF_RESTORE_SAVED_DRAFT_V1__===restoreSavedDraft)delete win.__ZJF_RESTORE_SAVED_DRAFT_V1__;if(fieldCommitTimer)win.clearTimeout(fieldCommitTimer);if(resumeWait)win.clearTimeout(resumeWait.timer);if(win.__ZJF_START_NEW_CHAT_V1__===startNewChat)delete win.__ZJF_START_NEW_CHAT_V1__;if(win.__ZJF_SAVE_BEFORE_CLOSE_V1__===saveBeforeClose)delete win.__ZJF_SAVE_BEFORE_CLOSE_V1__;if(win.__ZJF_SET_CLOSE_STATE_V1__===setCloseState)delete win.__ZJF_SET_CLOSE_STATE_V1__;conversation.dispose();attachmentUI.dispose();editor()?.removeAttribute("data-zjf-question-editor");page.removeEventListener("selectionchange",rememberCaret);win.clearInterval(timer);page.removeEventListener('input',onInput);page.removeEventListener('beforeinput',onBeforeInput,true);page.removeEventListener('compositionstart',onCompositionStart);page.removeEventListener('compositionend',onCompositionEnd);page.removeEventListener('focusout',onFocusOut);page.removeEventListener('keydown',onSend,true);page.removeEventListener('keydown',onComposerKey,true);page.removeEventListener('click',onSend,true);page.removeEventListener('click',onNativeRemove,true);page.removeEventListener('keydown',onNativeRemove,true);page.removeEventListener('click',onNavigation,true);win.removeEventListener?.('popstate',onPopState);win.chrome?.webview?.removeEventListener('message',listener);panel?.remove();attachmentStyle?.remove()}};
}
