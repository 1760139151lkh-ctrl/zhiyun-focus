import {captureReceipt} from './capture-delivery.js';
import {createLibrarySelectionStore} from './library-selection.js';
import {studyRecordContext} from './study-context.js';
import {toolbarIcon} from './toolbar-icons.js';
import {copyBoard} from './capture.js';

const libraryTime=n=>{n=Math.max(0,Math.floor(Number(n)||0));return [Math.floor(n/3600),Math.floor(n/60)%60,n%60].map(x=>String(x).padStart(2,'0')).join(':')};
export function mountStudyLibrary({root,companion,close,restore,send,openConversation,openDraft,resumeDraft,getRestoreIntent,crop,capture,selectionKey='',currentContext=()=>({})}){
  const selected=new Map(),selectedQuestions=new Map(),loaded=new Map(),questions=new Map(),markLoads=new Map(),questionLoads=new Map(),readFailures=new Map();
  const selectionIntents=new Map(),selectionVersions=new Map(),questionSelectionIntents=new Map();let selectionVersion=0,selectionIntentAt=0,composingChoice=null;
  let listing={marks:[],questions:[]},busy=false,status='',target='current',background=true,questionImages=true;
  const selectionUndo=[];
  let listingState='unread',listingError='',listingNeedsLaunch=false,launchRequired=false,launching=false,statusNeedsLaunch=false;
  let cacheEpoch=0,questionCacheEpoch=0,selectionEpoch=0,selectAllEpoch=0,refreshEpoch=0;
  let tab='marks',previewState=null,previewEpoch=0,renderEpoch=0,composeEpoch=0,draftEpoch=0,deliveryEpoch=0,phase='',statusKind='',bulk=null;
  let visible=false,sessionEpoch=0,locateEpoch=0,launchEpoch=0,optionsOpen=false,managementOpen=false,selectionOpen=false,backupBusy=false,selectionMode=false,otherDraftsOpen=false;
  let managementDismissTimer=0,askEpoch=0;
  const eventView=root.ownerDocument?.defaultView||globalThis;
  let questionIndex={state:'unread',completed:0,total:0},questionWaitEpoch=0,questionPollTimer=null,questionPollInFlight=null,questionRetryRequested=false,questionReadAttempts=0,questionReadFailures=0;
  const collapsedMoments=new Set(),openQuestions=new Set(),openContexts=new Set(),jobs=new Map(),retiredJobs=new Set(),scrollPositions=new Map(),scrollAnchors=new Map(),displayMarks=new Map(),displayQuestions=new Map();
  let jobsReady=false,jobsLoading=null;
  const recentMarks=new Map();let markUpdateVersion=0;
  const recordScope=record=>studyRecordContext(record).lessonKey;
  const compareMoments=(a,b)=>recordScope(a).localeCompare(recordScope(b))||(Number(a.time)||0)-(Number(b.time)||0)||(a.number||0)-(b.number||0)||String(a.id).localeCompare(String(b.id));
  const resumeLabel=record=>currentContext().lessonKey&&recordScope(record)!==recordScope(currentContext())?'复制到本讲':'继续草稿';
  let browseScope=currentContext().lessonKey?recordScope(currentContext()):'all',scopePickerOpen=false,contextSignature=JSON.stringify(currentContext());
  const openCourseGroups=new Set();
  const inScope=record=>browseScope==='all'||recordScope(record)===browseScope;
  const visibleMarks=()=>listing.marks.filter(inScope).sort((a,b)=>(browseScope==='all'?recordScope(a).localeCompare(recordScope(b)):0)||(Number(a.time)||0)-(Number(b.time)||0)||(a.number||0)-(b.number||0));
  const el=(tag,text)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n};
  const refKey=x=>x.snapshotId+'/'+x.id;
  const ref=x=>({snapshotId:x.snapshotId,itemId:x.id,markId:x.markId});
  const referenceKey=x=>x.snapshotId+'/'+x.itemId;
  const newSelectionIntent=()=>Object.freeze({version:++selectionVersion,intentId:crypto.randomUUID(),intentAt:selectionIntentAt=Math.max(Date.now(),selectionIntentAt+1)});
  // Reordering is a new choice for consumption, not a new permission to
  // restore an image removed after the original selection.
  const reorderedIntent=intent=>Object.freeze({...intent,version:++selectionVersion,intentId:crypto.randomUUID()});
  const intentPayload=intent=>({intentId:intent.intentId,intentAt:intent.intentAt});
  function questionSelectionIntent(id){if(!questionSelectionIntents.has(id))questionSelectionIntents.set(id,{whole:null,parts:new Map()});return questionSelectionIntents.get(id)}
  function reviewQuestionVersion(intents,data){
    if(intents.sourceRevision!==data.revision||intents.sourceUpdatedAt!==data.updatedAt){if(intents.whole)intents.whole=reorderedIntent(intents.whole);for(const [id,intent]of intents.parts)intents.parts.set(id,reorderedIntent(intent));}
    intents.sourceRevision=data.revision;intents.sourceUpdatedAt=data.updatedAt;
  }
  function putSelection(key,value,intent){selected.set(key,value);selectionIntents.set(key,intent);selectionVersions.set(key,intent.version)}
  function rememberRemoved(refs=[],questionIds=[]){
    const keys=new Set(refs),ids=new Set(questionIds),choice=selectionChoice();
    const removed={refs:choice.refs.filter(value=>keys.has(referenceKey(value))),refOrder:choice.refs.map(referenceKey),questions:choice.questions.filter(value=>ids.has(value.questionId)),questionOrder:choice.questions.map(value=>value.questionId)};
    if(removed.refs.length||removed.questions.length)selectionUndo.push(removed);
  }
  function removeRefs(keys){
    for(const key of keys){selected.delete(key);selectionIntents.delete(key);selectionVersions.set(key,++selectionVersion);}
  }
  function removeQuestion(id){selectedQuestions.delete(id);questionSelectionIntents.delete(id);}
  // Preserve the current order of surviving choices, including later additions.
  // Restore between surviving original neighbours; a conflicting later reorder
  // keeps its own order and receives the removed choice at its original index.
  function restorePositions(values,order,restored){
    const entries=[...values].filter(([key])=>!restored.has(key));
    for(const [index,key]of order.entries())if(restored.has(key)){
      const previous=order.slice(0,index).reverse().find(value=>entries.some(([id])=>id===value)),next=order.slice(index+1).find(value=>entries.some(([id])=>id===value));
      const before=entries.findIndex(([id])=>id===previous),after=entries.findIndex(([id])=>id===next);
      const position=before>=0&&(after<0||before<after)?before+1:before<0&&after>=0?after:Math.min(index,entries.length);
      entries.splice(position,0,[key,values.get(key)]);
    }
    values.clear();for(const [key,value]of entries)values.set(key,value);
  }
  function undoSelection(){
    const removed=selectionUndo.pop();if(!removed)return;
    interruptBulk();selectionEpoch++;const restoredRefs=new Set(),restoredQuestions=new Set();
    for(const reference of removed.refs){const key=referenceKey(reference);if(!selected.has(key)){putSelection(key,reference,newSelectionIntent());restoredRefs.add(key);}}
    restorePositions(selected,removed.refOrder,restoredRefs);
    for(const part of removed.parts||[]){
      const current=questionChoicePayload().find(choice=>choice.questionId===part.before.questionId),unchanged=JSON.stringify(current||null)===part.after;
      const choice=unchanged?part.before:{...part.before,itemIds:[part.itemId],restorePartIntents:[]};if(!unchanged)delete choice.additionalItemIds;
      removed.questions.push(choice);
    }
    for(const choice of removed.questions){
      const id=choice.questionId,exists=selectedQuestions.has(id),current=selectedQuestions.get(id),intents=exists?questionSelectionIntent(id):{sourceRevision:choice.sourceRevision,sourceUpdatedAt:choice.sourceUpdatedAt,retainSupplementaryText:choice.retainSupplementaryText===true,whole:choice.restoreIntentId?reorderedIntent({intentId:choice.restoreIntentId,intentAt:choice.restoreIntentAt}):null,parts:new Map()};
      if(!exists){restoredQuestions.add(id);selectedQuestions.set(id,choice.itemIds.length||choice.retainSupplementaryText?new Set(choice.itemIds):null);}
      if(!choice.itemIds.length&&!choice.retainSupplementaryText){if(!exists||current!==null){selectedQuestions.set(id,null);intents.whole=newSelectionIntent();}for(const part of choice.restorePartIntents)if(!intents.parts.has(part.itemId))intents.parts.set(part.itemId,newSelectionIntent());}
      else if(!exists||current!==null){const parts=selectedQuestions.get(id);for(const part of choice.itemIds)if(!exists||!parts.has(part)){parts.add(part);intents.parts.set(part,newSelectionIntent());}}
      if(current!==null&&(choice.retainSupplementaryText||intents.retainSupplementaryText)){intents.retainSupplementaryText=true;if(intents.whole)intents.whole=reorderedIntent(intents.whole);}
      questionSelectionIntents.set(id,intents);
    }
    restorePositions(selectedQuestions,removed.questionOrder,restoredQuestions);selectionMode=!!(selected.size||selectedQuestions.size);render(selectionUndo.length?'undo-selection':'selection-order');
  }
  const selectionStore=createLibrarySelectionStore({scope:selectionKey,companion,readChoice:selectionChoice,applyChoice:restoreChoice,changed:()=>render(),win:root.ownerDocument?.defaultView||globalThis});
  function selectionChoice(){return {refs:[...selected.values()],restoreRefs:[...selected].flatMap(([key,reference])=>{const intent=selectionIntents.get(key);return intent?[{...reference,...intentPayload(intent)}]:[]}),questions:questionChoicePayload(),target,background,questionImages}}
  function restoreChoice(choice){
    const previousRefs=new Map(selectionIntents),previousVersions=new Map(selectionVersions),previousQuestions=new Map(questionSelectionIntents);
    selected.clear();selectedQuestions.clear();selectionIntents.clear();selectionVersions.clear();questionSelectionIntents.clear();
    const restoredIntent=(id,time,previous)=>{selectionIntentAt=Math.max(selectionIntentAt,Number(time)||0);return previous&&previous.intentId===id&&previous.intentAt===(time||0)?previous:{version:++selectionVersion,intentId:id||crypto.randomUUID(),intentAt:time||0}},restores=new Map(choice.restoreRefs.map(value=>[referenceKey(value),value]));
    for(const reference of choice.refs){const key=referenceKey(reference),intent=restores.get(key),previous=previousRefs.get(key),restored=restoredIntent(intent?.intentId,intent?.intentAt,previous);putSelection(key,reference,restored);if(restored===previous)selectionVersions.set(key,previousVersions.get(key)??restored.version);}
    for(const question of choice.questions){const previous=previousQuestions.get(question.questionId);selectedQuestions.set(question.questionId,question.itemIds.length||question.retainSupplementaryText?new Set(question.itemIds):null);questionSelectionIntents.set(question.questionId,{sourceRevision:question.sourceRevision,sourceUpdatedAt:question.sourceUpdatedAt,retainSupplementaryText:question.retainSupplementaryText===true,whole:question.restoreIntentId?restoredIntent(question.restoreIntentId,question.restoreIntentAt,previous?.whole):null,parts:new Map(question.restorePartIntents.map(value=>[value.itemId,restoredIntent(value.intentId,value.intentAt,previous?.parts.get(value.itemId)||previous?.whole)]))});}
    target=choice.target;background=choice.background;questionImages=choice.questionImages;
  }
  function touchDefaultSelections(markIds,intent){
    for(const id of markIds){const data=loaded.get(id)||displayMarks.get(id),defaults=data?new Set(defaultItems(data).map(refKey)):null;for(const [key,value]of selected)if(value.markId===id&&(!defaults||defaults.has(key)))selectionVersions.set(key,intent.version)}
  }
  const orderedSnapshots=data=>[...data.snapshots].sort((a,b)=>(Number(a.time)||0)-(Number(b.time)||0)||String(a.createdAt||'').localeCompare(String(b.createdAt||''))||String(a.id).localeCompare(String(b.id)));
  function momentSnapshots(data){
    const supplements=new Map(data.snapshots.filter(snapshot=>snapshot.contextVerified&&snapshot.contextFor).map(snapshot=>[snapshot.contextFor,snapshot]));
    return orderedSnapshots(data).filter(snapshot=>!snapshot.contextVerified||!snapshot.contextFor).map(snapshot=>{const supplement=supplements.get(snapshot.id);return supplement?{...snapshot,items:[...supplement.items.filter(item=>item.kind!=='selection'),...snapshot.items.filter(item=>item.kind==='selection')]}:snapshot;});
  }
  const defaultItems=data=>{const supplements=new Map(data.snapshots.filter(s=>s.contextVerified&&s.contextFor).map(s=>[s.contextFor,s]));return orderedSnapshots(data).flatMap(s=>s.id===data.mark.initialSnapshotId?[...(supplements.get(s.id)?.items||s.items).filter(item=>item.kind!=='selection'),...s.items.filter(item=>item.kind==='selection')]:s.items.filter(item=>item.kind==='selection'));};
  const primaryItems=snapshot=>{const selections=snapshot.items.filter(item=>item.kind==='selection');if(selections.length)return selections;const context=snapshot.items.filter(item=>item.kind!=='selection'),active=snapshot.layout?.view?.mode==='overview'?null:context.find(item=>item.boardId===snapshot.layout?.view?.active)||context.find(item=>item.boardId===snapshot.layout?.active);return active?[active]:context.length?[context.find(item=>item.kind==='panorama')||context[0]]:[];};
  const focusKeyWithin=container=>{const active=root.getRootNode?.().activeElement||document.activeElement;return active&&container.contains?.(active)?active.dataset.libraryFocus:null};
  function focusByKey(key,fallbacks=[]){if(!visible)return;const controls=[...root.querySelectorAll('[data-library-focus]')];for(const candidate of [key,...fallbacks]){const node=controls.find(value=>value.dataset.libraryFocus===candidate&&!value.disabled);if(node){node.focus?.({preventScroll:true});return;}}}
  function closeManagement(returnFocus=false){
    clearTimeout(managementDismissTimer);managementDismissTimer=0;
    const menu=root.querySelector('[data-library-management]');if(!menu?.open){managementOpen=false;return false;}
    menu.open=false;managementOpen=false;if(returnFocus)menu.querySelector('summary')?.focus({preventScroll:true});return true;
  }
  function outsideManagement(event){
    if(!visible)return;clearTimeout(managementDismissTimer);managementDismissTimer=0;
    const target=event.composedPath?.()[0]||event.target,menu=root.querySelector('[data-library-management]');if(menu?.open&&!menu.contains(target))closeManagement();
    const choices=root.querySelector('.library-picked');if(choices?.open&&!choices.contains(target)&&!target.closest?.('[data-selection-undo]')){selectionOpen=false;choices.open=false;}
  }
  function escapeManagement(event){if(!visible||event.key!=='Escape'||event.isComposing)return;const choices=root.querySelector('.library-picked');if(choices?.open){selectionOpen=false;choices.open=false;choices.querySelector('summary')?.focus({preventScroll:true});event.preventDefault();event.stopImmediatePropagation();}else if(closeManagement(true)){event.preventDefault();event.stopImmediatePropagation();}}
  const blurManagement=()=>{closeManagement();const choices=root.querySelector('.library-picked');if(choices?.open){selectionOpen=false;choices.open=false;}};
  eventView.addEventListener?.('pointerdown',outsideManagement,true);eventView.addEventListener?.('keydown',escapeManagement,true);eventView.addEventListener?.('blur',blurManagement);
  function button(label,action,key=label){const b=el('button',label);b.type='button';b.dataset.libraryFocus=key;b.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();const session=sessionEpoch;if(!b.disabled)Promise.resolve().then(action).catch(error=>{if(session===sessionEpoch)failed(error)})});return b}
  const needsLaunch=error=>error?.action==='launch'||['companion_upgrade','companion_unavailable'].includes(error?.code);
  function iconButton(icon,label,action,key=label){const node=button('',action,key);node.innerHTML=toolbarIcon(icon);node.classList.add('library-icon');node.setAttribute('aria-label',label);return node;}
  function loadingImage(){const node=el('div');node.className='library-image-wait';node.setAttribute('aria-busy','true');return node;}
  async function askItem(item){
    const ticket=++askEpoch,reference=ref(item),intent=newSelectionIntent();
    // Opening the draft intentionally changes the workspace. Capture that new
    // owner before waiting, so a later close cannot lend us its newer owner.
    const opening=openDraft?.(),requestOwner=getRestoreIntent?.()?.workspace;
    const destination=openDraft?await opening:companion.snapshot?.()?.chatDraftTarget;
    if(ticket!==askEpoch||requestOwner?.isCurrent()===false)return;
    const plan=await companion.library('compose',{refs:[reference],restoreRefs:[{...reference,...intentPayload(intent)}],questions:[],background:true,questionImages:false,title:'课堂片段'});
    if(ticket!==askEpoch||requestOwner?.isCurrent()===false)return;
    return send(plan,destination?'current':'new',{target:destination,requestOwner});
  }
  function recordFailure(error){status=error?.message||'操作未完成';root.dataset.diagnostic=status;statusKind='error';statusNeedsLaunch=needsLaunch(error);if(statusNeedsLaunch)launchRequired=true}
  function failed(error){recordFailure(error);render()}
  async function resumeLibrary(){
    const ticket=++launchEpoch;status='连接中…';statusKind='';render();
    try{await companion.waitUntilReady({forLibrary:true});if(ticket===launchEpoch&&visible)await refresh()}catch(error){if(ticket===launchEpoch)recordFailure(error)}finally{if(ticket===launchEpoch){launching=false;render()}}
  }
  function clearSelection(){rememberRemoved([...selected.keys()],[...selectedQuestions.keys()]);selectionEpoch++;selectAllEpoch++;bulk=null;selected.clear();selectedQuestions.clear();selectionIntents.clear();selectionVersions.clear();questionSelectionIntents.clear();status='';statusKind='';render(selectionUndo.length?'undo-selection':'selection-mode')}
  function interruptBulk(){selectAllEpoch++;const interrupted=!!bulk;bulk=null;return interrupted}
  function cancelPreviewCrop(){if(previewState?.cropping){previewEpoch++;previewState.cropping=false}}
  function cancelCompose(){if(phase!=='compose')return;composeEpoch++;phase='';busy=false;status='已取消整理';statusKind='';render()}
  function rememberView(){
    if(!visible)return;
    const browser=root.querySelector('[data-library-scroll]');if(browser){
      const tab=browseScope+'|'+browser.dataset.libraryScroll;scrollPositions.set(tab,browser.scrollTop||0);const bounds=browser.getBoundingClientRect?.();
      if(bounds){const entry=[...browser.querySelectorAll('[data-library-focus]')].find(node=>{if(!/^(?:mark|moment|question)-title:/.test(node.dataset.libraryFocus))return false;const r=node.parentElement?.getBoundingClientRect?.();return r&&r.bottom>bounds.top&&r.top<bounds.bottom});if(entry)scrollAnchors.set(tab,{key:entry.dataset.libraryFocus,offset:entry.getBoundingClientRect().top-bounds.top});}
    }
    const choices=root.querySelector('[data-selection-items]');if(choices?.childElementCount)scrollPositions.set('selection',choices.scrollTop||0);
    // Native details.toggle is queued; read the current disclosure before an
    // asynchronous result can replace it ahead of that event.
    for(const check of root.querySelectorAll('input[data-question-check]')){const details=check.parentElement?.parentElement;if(details?.open)openQuestions.add(check.dataset.questionCheck);else openQuestions.delete(check.dataset.questionCheck);}
    for(const details of root.querySelectorAll('[data-library-moment]'))details.open?collapsedMoments.delete(details.dataset.libraryMoment):collapsedMoments.add(details.dataset.libraryMoment);
    for(const context of root.querySelectorAll('[data-library-context]'))context.open?openContexts.add(context.dataset.libraryContext):openContexts.delete(context.dataset.libraryContext);
    const options=root.querySelector('[data-library-options]'),management=root.querySelector('[data-library-management]');if(options)optionsOpen=options.open;if(management)managementOpen=management.open;
    const otherDrafts=root.querySelector('[data-library-other-drafts]');if(otherDrafts)otherDraftsOpen=otherDrafts.open;
    const picker=root.querySelector('[data-library-scope-picker]');if(picker)scopePickerOpen=picker.open;
    for(const group of root.querySelectorAll('[data-library-course-group]'))group.open?openCourseGroups.add(group.dataset.libraryCourseGroup):openCourseGroups.delete(group.dataset.libraryCourseGroup);
  }
  function restoreScroll(){
    const browser=root.querySelector('[data-library-scroll]');if(browser){const key=browseScope+'|'+browser.dataset.libraryScroll;browser.scrollTop=scrollPositions.get(key)||0;const anchor=scrollAnchors.get(key),entry=anchor&&[...browser.querySelectorAll('[data-library-focus]')].find(node=>node.dataset.libraryFocus===anchor.key);if(entry&&browser.getBoundingClientRect)browser.scrollTop+=entry.getBoundingClientRect().top-browser.getBoundingClientRect().top-anchor.offset;}
    const choices=root.querySelector('[data-selection-items]');if(choices)choices.scrollTop=scrollPositions.get('selection')||0;
  }
  function suspend(){
    stopQuestionPolling();
    closeManagement();
    rememberView();visible=false;sessionEpoch++;renderEpoch++;locateEpoch++;refreshEpoch++;launchEpoch++;launching=false;selectionEpoch++;selectAllEpoch++;bulk=null;
    if(phase==='compose'){composeEpoch++;phase='';busy=false;status='已取消整理';statusKind=''}
    else if(phase==='resume'||phase==='open'){draftEpoch++;phase='';busy=false;status='';statusKind=''}
    else if(phase==='send'){deliveryEpoch++;phase='';busy=false;status='';statusKind=''}
    else if(status==='正在定位原图…'||status==='连接中…'){status='';statusKind=''}
    if(previewState?.loading){previewEpoch++;previewState=null}
    else cancelPreviewCrop();
    if(listingState==='loading')listingState=listing.marks.length||listing.questions.length?'ready':'unread';
  }
  function dismiss(){suspend();close()}
  function setTab(value){rememberView();stopQuestionPolling();tab=value;questionReadAttempts=0;questionReadFailures=0;locateEpoch++;previewEpoch++;previewState=null;render('tab:'+value);scheduleQuestionPoll(true)}
  async function selectAll(){
    const marks=visibleMarks(),ticket=++selectAllEpoch,epoch=++selectionEpoch,generation=cacheEpoch,intent=newSelectionIntent(),operation={ticket,done:0,total:marks.length};touchDefaultSelections(marks.map(mark=>mark.id),intent);bulk=operation;render();
    const staged=new Map(),current=()=>bulk===operation&&ticket===selectAllEpoch&&epoch===selectionEpoch&&generation===cacheEpoch;
    try{for(const mark of marks){const data=await loadMark(mark.id);if(!current())return;for(const item of defaultItems(data))staged.set(refKey(item),ref(item));operation.done++;updateBulkProgress()}
      if(current()){for(const [key,value]of staged)putSelection(key,value,intent);status='';statusKind=''}
    }catch(error){if(current())recordFailure(error)}finally{if(bulk===operation){bulk=null;render()}}
  }
  function choose(item,checked){interruptBulk();const key=refKey(item);if(checked)putSelection(key,ref(item),newSelectionIntent());else{rememberRemoved([key]);removeRefs([key]);}updateCount()}
  function chooseMoment(snapshot,checked){interruptBulk();const items=primaryItems(snapshot);if(checked){const intent=newSelectionIntent();for(const item of items)putSelection(refKey(item),ref(item),intent);}else{const keys=items.map(refKey);rememberRemoved(keys);removeRefs(keys);}updateCount();}
  function moveSelection(key,direction){
    const entries=[...selected],from=entries.findIndex(([id])=>id===key),to=from+direction;if(from<0||to<0||to>=entries.length)return;
    [entries[from],entries[to]]=[entries[to],entries[from]];selected.clear();for(const [id,value]of entries)selected.set(id,value);
    for(const index of [from,to]){const [id,value]=entries[index];putSelection(id,value,reorderedIntent(selectionIntents.get(id)));}updateCount();focusByKey('order:'+key+':'+direction,['order:'+key+':'+(-direction),'unselect:'+key,'selection-order']);
  }
  function moveQuestionSelection(id,direction){
    const entries=[...selectedQuestions],from=entries.findIndex(([key])=>key===id),to=from+direction;if(from<0||to<0||to>=entries.length)return;
    [entries[from],entries[to]]=[entries[to],entries[from]];selectedQuestions.clear();for(const [key,parts]of entries)selectedQuestions.set(key,parts);
    for(const index of [from,to]){const intents=questionSelectionIntent(entries[index][0]);if(intents.whole)intents.whole=reorderedIntent(intents.whole);for(const [key,intent]of intents.parts)intents.parts.set(key,reorderedIntent(intent));}
    updateCount();focusByKey('question-order:'+id+':'+direction,['question-order:'+id+':'+(-direction),'unselect-question:'+id,'selection-order']);
  }
  function renderSelection(){
    const list=root.querySelector('[data-selection-items]');if(!list)return;const focused=focusKeyWithin(list),scroll=list.childElementCount?list.scrollTop:scrollPositions.get('selection')||0;if(list.childElementCount)scrollPositions.set('selection',scroll);list.replaceChildren();
    const pickedItem=reference=>{const data=loaded.get(reference.markId)||displayMarks.get(reference.markId);return data?.snapshots.find(snapshot=>snapshot.id===reference.snapshotId)?.items.find(value=>value.id===reference.itemId);};
    const peek=root.querySelector('[data-selection-peek]');if(peek){peek.replaceChildren();for(const reference of [...selected.values()].slice(0,3)){const item=pickedItem(reference);if(item?.thumbnail){const image=el('img');image.src=item.thumbnail;image.alt='';peek.append(image);}}}
    if(!selectionOpen)return;
    const toolbar=el('div');toolbar.className='library-picked-toolbar';toolbar.append(iconButton('close','收起选材',()=>{selectionOpen=false;const choices=root.querySelector('.library-picked');if(choices)choices.open=false;focusByKey('selection-order');}));list.append(toolbar);
    const entries=[...selected];for(const [index,[key,reference]]of entries.entries()){
      const data=loaded.get(reference.markId)||displayMarks.get(reference.markId),item=pickedItem(reference);
      if(!data&&!readFailures.has('mark:'+reference.markId))void loadMark(reference.markId).catch(()=>{if(visible)renderSelection()});
      const at=Number.isFinite(item?.time)?libraryTime(item.time):'',row=el('div'),label=[item?.label||'已选图片',at].filter(Boolean).join(' · ');row.className='library-picked-row';row.dataset.selectionKey=key;
      const show=button('',()=>{if(item){selectionOpen=false;return preview(item);}},'picked-preview:'+key);show.className='library-picked-image';show.setAttribute('aria-label','查看第 '+(index+1)+' 张 · '+label);show.disabled=!item;
      if(item?.thumbnail){const image=el('img');image.src=item.thumbnail;image.alt='';show.append(image);}else show.innerHTML=toolbarIcon('library');
      const number=el('span',String(index+1));number.className='library-picked-index';show.append(number);row.append(show);
      const text=el('span');text.append(el('time',at));row.append(text);
      const actions=el('div');actions.className='library-picked-actions';for(const [direction,labelText]of [[-1,'上移'],[1,'下移']]){const control=iconButton('back',labelText+' '+label,()=>moveSelection(key,direction),'order:'+key+':'+direction);control.classList.add(direction<0?'library-order-up':'library-order-down');control.disabled=index+direction<0||index+direction>=entries.length;actions.append(control);}
      const remove=iconButton('close','移出选材 '+label,()=>{const neighbor=entries[index+1]?.[0]||entries[index-1]?.[0];rememberRemoved([key]);removeRefs([key]);updateCount();focusByKey(neighbor?'unselect:'+neighbor:'undo-selection');},'unselect:'+key);actions.append(remove);row.append(actions);list.append(row);
    }
    for(const [index,[id,parts]]of [...selectedQuestions].entries()){
      const data=questions.get(id)||displayQuestions.get(id);if(!data&&!readFailures.has('question:'+id))void loadQuestion(id).catch(()=>{if(visible)renderSelection()});
      const summary=listing.questions.find(question=>question.id===id),text=data?.questions?.find(part=>(parts?parts.has(part.id):part.included!==false)&&part.text?.trim())?.text||data?.draftManifest?.draft?.inline?.text||'',savedTitle=data?.title||summary?.title||'',title=text||(/^(?:【|课后提问$|板书提问$|未命名提问$)/.test(savedTitle)||summary?.hasQuestionText===false?'':savedTitle);
      const row=el('div');row.className='library-picked-row library-picked-question';const show=iconButton('chat','查看提问 · '+title,()=>{selectionOpen=false;return revealQuestion(id);},'picked-question:'+id);show.classList.add('library-picked-image');row.append(show,el('span',title));
      const actions=el('div');actions.className='library-picked-actions';for(const [direction,label]of [[-1,'上移提问'],[1,'下移提问']]){const control=iconButton('back',label+' · '+title,()=>moveQuestionSelection(id,direction),'question-order:'+id+':'+direction);control.classList.add(direction<0?'library-order-up':'library-order-down');control.disabled=index+direction<0||index+direction>=selectedQuestions.size;actions.append(control);}
      const remove=iconButton('close','移出选材 · '+title,()=>{const entries=[...selectedQuestions],neighbor=entries[index+1]?.[0]||entries[index-1]?.[0];rememberRemoved([],[id]);removeQuestion(id);updateCount();focusByKey(neighbor?'unselect-question:'+neighbor:'undo-selection');},'unselect-question:'+id);actions.append(remove);row.append(actions);list.append(row);
    }list.scrollTop=scroll;focusByKey(focused);
  }
  function updateBulkProgress(){const progress=root.querySelector('[data-bulk-progress]');if(progress)progress.textContent=bulk?`读取标记 ${bulk.done} / ${bulk.total}`:''}
  function updateCount(){
    const selectionState=selectionStore.state(),selectionReady=selectionState.ready;root.dataset.selectionDiagnostic=selectionState.error;
    root.dataset.selectionRevision=String(selectionState.revision);root.dataset.selectionJournal=String(selectionState.journalProtectedVersion);root.dataset.selectionJournalConfirmed=String(selectionState.journalConfirmedVersion);
    if(phase==='compose'&&composingChoice&&(composingChoice!==JSON.stringify(selectionChoice())||bulk)){composeEpoch++;composingChoice=null;phase='';busy=false;status='';statusKind='';}
    const hasSelection=!!selected.size||!!selectedQuestions.size||!!bulk,choosing=selectionMode||hasSelection;
    root.dataset.selecting=String(choosing);root.dataset.hasSelection=String(hasSelection);
    const selectionToggle=root.querySelector('[data-library-focus="selection-mode"]');if(selectionToggle){selectionToggle.innerHTML=toolbarIcon(choosing?'close':'select');selectionToggle.setAttribute('aria-label',choosing?'取消选择':'选择材料');}
    const footer=root.querySelector('[data-library-footer]');if(footer)footer.hidden=!hasSelection&&!selectionUndo.length;
    const undo=root.querySelector('[data-selection-undo]');if(undo)undo.hidden=!selectionUndo.length;
    const n=root.querySelector('[data-selection-count]');if(n){n.textContent=String(selected.size+selectedQuestions.size);n.setAttribute('aria-label',selected.size+' 张图，'+selectedQuestions.size+' 份提问');}
    root.querySelector('[data-library-focus="selection-order"]')?.setAttribute('aria-label','查看与调整选材顺序，'+selected.size+' 张图，'+selectedQuestions.size+' 份提问');
    for(const check of root.querySelectorAll('input[data-moment-check]')){const data=loaded.get(check.dataset.markId)||displayMarks.get(check.dataset.markId),snapshot=data&&momentSnapshots(data).find(value=>value.id===check.dataset.momentCheck),items=snapshot?primaryItems(snapshot):[];check.checked=items.length>0&&items.every(item=>selected.has(refKey(item)));check.indeterminate=!check.checked&&!!snapshot?.items.some(item=>selected.has(refKey(item)));}
    for(const check of root.querySelectorAll('input[data-image-check]'))check.checked=selected.has(check.dataset.imageCheck);
    for(const control of root.querySelectorAll('[data-image-toggle]'))control.setAttribute('aria-pressed',String(selected.has(control.dataset.imageToggle)));
    for(const check of root.querySelectorAll('input[data-question-check]')){const id=check.dataset.questionCheck,picked=selectedQuestions.get(id);check.checked=selectedQuestions.has(id)&&picked===null;check.indeterminate=selectedQuestions.has(id)&&picked!==null;}
    for(const check of root.querySelectorAll('input[data-question-part]')){const id=check.dataset.questionId,picked=selectedQuestions.get(id);check.checked=selectedQuestions.has(id)&&(picked===null?check.dataset.defaultIncluded==='true'||questionSelectionIntents.get(id)?.parts.has(check.dataset.questionPart):picked.has(check.dataset.questionPart))}
    for(const row of root.querySelectorAll('[data-material-key]'))row.dataset.selected=String(selected.has(row.dataset.materialKey));
    updateBulkProgress();
    renderSelection();
    for(const input of root.querySelectorAll('input[data-moment-check],input[data-image-check],input[data-question-check],input[data-question-part],.library-destination button,.library-options-body input,[data-library-focus="清空勾选"]')){
      const materialChoice=input.dataset.momentCheck||input.dataset.imageCheck||input.dataset.questionCheck||input.dataset.questionPart;
      input.disabled=!selectionReady||!!materialChoice&&!choosing&&input.dataset.libraryFocus!=='preview-choice';
    }
    const submit=root.querySelector('[data-library-submit]');if(submit){submit.disabled=!selectionReady||busy||!!bulk||(!selected.size&&!selectedQuestions.size);submit.setAttribute('aria-disabled',String(submit.disabled))}
    selectionStore.sync();
  }
  async function loadRecord(action,id,cache,pending){
    if(cache.has(id))return cache.get(id);
    if(!pending.has(id)){
      const currentEpoch=()=>action==='question'?questionCacheEpoch:cacheEpoch,epoch=currentEpoch(),request=(async()=>{let failure;for(let attempt=0;attempt<3;attempt++){try{return await companion.library(action,{id});}catch(error){failure=error;if(epoch!==currentEpoch())throw error;if(attempt<2)await new Promise(resolve=>eventView.setTimeout(resolve,400*2**attempt));}}throw failure;})().then(data=>{if(epoch===currentEpoch()){cache.set(id,data);readFailures.delete(action+':'+id);if(!bulk)updateCount()}return data}).catch(error=>{if(epoch===currentEpoch())readFailures.set(action+':'+id,error);throw error}).finally(()=>{if(pending.get(id)===request)pending.delete(id)});
      pending.set(id,request);
    }
    return pending.get(id);
  }
  const loadMark=id=>loadRecord('mark',id,loaded,markLoads),loadQuestion=id=>loadRecord('question',id,questions,questionLoads);
  function revealReviewedQuestion(data){
    questions.set(data.id,data);displayQuestions.set(data.id,data);const manifest=data.draftManifest||{},draft=manifest.draft||{},text=(data.text||'').trimStart();
    const hasTypedQuestion=draft.inline?.version===1?!!draft.inline.text?.trim():!!text&&!/^【(?:课堂背景与图片说明|保留的原提问)】/.test(text);
    const summary={id:data.id,revision:data.revision,title:data.title,status:data.status,conversationUrl:data.conversationUrl,lessonKey:recordScope(data),course:data.course||manifest.viewerCourse||draft.course||{},markTitles:data.markTitles||[],updatedAt:data.updatedAt,imageCount:draft.items?.length||0,hasQuestionText:(data.questions||[]).some(part=>part.text?.trim())||hasTypedQuestion};
    const index=listing.questions.findIndex(record=>record.id===data.id);if(index<0)listing.questions.push(summary);else listing.questions[index]=summary;
    openQuestions.add(data.id);tab='questions';browseScope='all';previewState=null;previewEpoch++;
    return 'question-title:'+data.id;
  }
  function showReadFailure(body,error,retry,key,hasPrevious){
    body.setAttribute('aria-busy','false');body.dataset.readError=error.message||'';
    if(needsLaunch(error))launchRequired=true;
    if(!hasPrevious){const unavailable=el('div');unavailable.className='library-image-unavailable';unavailable.innerHTML=toolbarIcon('library');body.replaceChildren(unavailable);}
  }

  function recoveredRead(error){if(!error)return;if(needsLaunch(error))launchRequired=false;if(statusKind==='error'&&status===error.message){status='';statusKind=''}render()}
  function normalizeQuestionIndex(value){
    if(!value)return {state:'ready',completed:0,total:0};
    const count=n=>Number.isFinite(n)&&n>=0?Math.floor(n):0;
    return {state:['building','ready','error'].includes(value.state)?value.state:'error',completed:count(value.completed),total:count(value.total),error:value.error||'提问记录暂时未能读取。'};
  }
  function stopQuestionPolling(){questionWaitEpoch++;clearTimeout(questionPollTimer);questionPollTimer=null}
  const canObserveQuestions=()=>visible&&tab==='questions'&&!previewState&&listingState==='ready'&&['building','error'].includes(questionIndex.state);
  function scheduleQuestionPoll(immediate=false){
    if(!canObserveQuestions()||questionPollInFlight||questionPollTimer!==null||questionReadAttempts>=60||questionReadFailures>=3)return;
    questionPollTimer=setTimeout(()=>{questionPollTimer=null;void pollQuestionIndex()},immediate?0:questionReadFailures?400*2**questionReadFailures:1000);
  }
  function updateQuestionIndexStatus(){
    const row=root.querySelector('[data-question-index]');if(row){row.dataset.state=questionIndex.state;row.dataset.readError=questionIndex.state==='error'?questionIndex.error||'':'';row.setAttribute('aria-busy',String(questionIndex.state==='building'&&questionReadAttempts<60&&questionReadFailures<3));}
    root.dataset.questionReadBudget=String(questionReadAttempts);root.dataset.questionReadFailures=String(questionReadFailures);
  }
  function renderQuestionIndex(browser){
    if(listingState==='failed'||!['building','error'].includes(questionIndex.state)||listing.questions.some(inScope))return;
    const waiting=questionIndex.state==='building'&&questionReadAttempts<60&&questionReadFailures<3,row=waiting?loadingImage():el('div');row.classList.add('library-load-row');row.dataset.questionIndex='true';if(!waiting){row.classList.add('library-image-unavailable');row.innerHTML=toolbarIcon('history');}browser.append(row);
  }
  function acceptQuestionList(next){
    for(const [id,data]of questions)displayQuestions.set(id,data);
    listing={...listing,questions:next.questions};questionCacheEpoch++;questions.clear();questionLoads.clear();for(const key of readFailures.keys())if(key.startsWith('question:'))readFailures.delete(key);
  }
  async function pollQuestionIndex(){
    if(!canObserveQuestions()||questionPollInFlight||questionReadAttempts>=60||questionReadFailures>=3)return;
    const ticket=questionWaitEpoch,params={indexStatus:true,...questionRetryRequested?{retryQuestionIndex:true}:{}};questionRetryRequested=false;
    questionReadAttempts++;
    const request=Promise.resolve().then(()=>companion.library('list',params));questionPollInFlight=request;
    try{
      const next=await request;if(ticket!==questionWaitEpoch||!canObserveQuestions())return;
      questionIndex=normalizeQuestionIndex(next.questionIndex);questionRetryRequested=questionIndex.state==='error';questionReadFailures=questionIndex.state==='error'?questionReadFailures+1:0;
      if(questionIndex.state==='ready'){acceptQuestionList(next);render()}else if(questionIndex.state==='error'||questionReadAttempts>=60)render();else updateQuestionIndexStatus();
    }catch(error){
      if(ticket!==questionWaitEpoch||!canObserveQuestions())return;questionIndex={...questionIndex,state:'error',error:error.message||'提问记录暂时未能读取。'};questionRetryRequested=false;questionReadFailures++;if(needsLaunch(error))launchRequired=true;render();
    }finally{if(questionPollInFlight===request)questionPollInFlight=null;scheduleQuestionPoll()}
  }
  function itemRow(item){
    const row=el('div');row.className='library-material';row.dataset.materialKey=refKey(item);row.dataset.kind=item.kind;
    const open=iconButton('library','查看 '+item.label+' · '+libraryTime(item.time),()=>preview(item),'preview:'+refKey(item));open.className='library-thumbnail';
    const image=el('img');image.src=item.thumbnail;image.alt=item.label;image.loading='lazy';image.decoding='async';open.replaceChildren(image);row.append(open);
    const actions=el('div');actions.className='library-card-actions';
    const select=iconButton('select','选择 '+item.label,()=>{selectionMode=true;choose(item,!selected.has(refKey(item)));},'choose:'+refKey(item));select.dataset.imageToggle=refKey(item);select.setAttribute('aria-pressed',String(selected.has(refKey(item))));
    const copy=iconButton('copy','复制 '+item.label,node=>copyBoard(companion.library('image',ref(item)).then(value=>value.image)),'copy:'+refKey(item));
    const ask=iconButton('chat','用 '+item.label+' 提问',()=>askItem(item),'ask:'+refKey(item));
    actions.append(select,copy,ask);row.append(actions);return row;
  }

  async function locate(reference){
    cancelPreviewCrop();
    const ticket=++locateEpoch,session=sessionEpoch,intent=getRestoreIntent?.();
    status='正在定位原图…';statusKind='';render();
    try{
      const data=await loadMark(reference.markId);if(ticket!==locateEpoch||session!==sessionEpoch||!visible)return;
      const snapshot=data.snapshots.find(s=>s.id===reference.snapshotId),item=reference.itemId?snapshot?.items.find(x=>x.id===reference.itemId):undefined;
      if(!snapshot||reference.itemId&&!item)throw Error('没有找到这张原图的位置记录，请刷新后重选。');
      await restore(data.mark,snapshot,item,{intent,isCurrent:()=>ticket===locateEpoch&&session===sessionEpoch&&visible});
      if(ticket===locateEpoch&&session===sessionEpoch){status='';render()}
    }catch(error){if(ticket===locateEpoch&&session===sessionEpoch){if(error.name!=='AbortError')throw error;status='';statusKind='';render()}}
  }
  async function preview(item){
    rememberView();const ticket=++previewEpoch;previewState={item,loading:true,image:'',error:''};render('preview-back');
    try{const data=await companion.library('image',ref(item));if(ticket!==previewEpoch)return;previewState={item,loading:false,image:data.image,error:''};render()}
    catch(error){if(ticket!==previewEpoch)return;previewState={item,loading:false,image:'',error:error.message};if(needsLaunch(error))launchRequired=true;render()}
  }
  function returnFromPreview(){const key=previewState?'preview:'+refKey(previewState.item):null;previewEpoch++;previewState=null;render(key)}
  async function cropPreview(){
    const state=previewState;if(!crop||!state?.image||state.loading||state.error||state.cropping)return;
    const ticket=previewEpoch,session=sessionEpoch,current=()=>visible&&session===sessionEpoch&&ticket===previewEpoch&&previewState===state;
    state.cropping=true;render();
    try{await crop(state.item,state.image,{isCurrent:current})}catch(error){if(current()&&error.name!=='AbortError')recordFailure(error)}finally{if(current()){state.cropping=false;render()}}
  }
  function fillMark(mark,data,body){
    const focused=focusKeyWithin(body);body.replaceChildren();body.setAttribute('aria-busy','false');
    for(const snapshot of orderedSnapshots(data)){
      const group=el('section');group.className='library-snapshot';
      const context=snapshot.items.filter(item=>item.kind!=='selection'),primary=primaryItems(snapshot);
      const grid=el('div');grid.className='library-grid';
      for(const item of primary)grid.append(itemRow({...item,markTitle:data.mark.title,course:snapshot.course||data.mark.course}));
      const head=el('div');head.className='library-snapshot-head';
      head.append(iconButton('return','回到 '+libraryTime(snapshot.time),()=>locate({markId:data.mark.id,snapshotId:snapshot.id}),'snapshot:'+snapshot.id));
      group.append(head,grid);
      const rest=context.filter(item=>!primary.includes(item));
      if(rest.length){const background=el('div');background.className='library-context-strip';for(const item of rest)background.append(itemRow({...item,markTitle:data.mark.title,course:snapshot.course||data.mark.course}));group.append(background);}
      body.append(group);
    }
    if(focused)focusByKey(focused);
  }

  function markRow(mark,data,snapshot){
    const details=el('details'),summary=el('summary');details.className='library-mark';details.dataset.libraryMark=mark.id;details.open=!snapshot||!collapsedMoments.has(snapshot.id);
    if(snapshot)details.dataset.libraryMoment=snapshot.id;else details.setAttribute('aria-busy',String(!readFailures.has('mark:'+mark.id)));
    if(snapshot&&primaryItems(snapshot).length){const check=el('input');check.type='checkbox';check.dataset.momentCheck=snapshot.id;check.dataset.markId=mark.id;check.dataset.libraryFocus='moment:'+snapshot.id;check.setAttribute('aria-label','选择 '+libraryTime(snapshot.time)+' 的材料');check.addEventListener('click',e=>e.stopPropagation());check.addEventListener('change',()=>chooseMoment(snapshot,check.checked));summary.append(check);}
    details.addEventListener('toggle',()=>{if(snapshot&&root.contains(details))details.open?collapsedMoments.delete(snapshot.id):collapsedMoments.add(snapshot.id);});
    const text=el('span'),title=el('span',libraryTime(snapshot?.time??mark.time)),meta=el('span',/^标记\s*\d+$/.test(mark.title||'')?'':mark.title);text.className='library-entry-text';title.className='library-entry-title';meta.className='library-entry-meta';text.append(title,meta);summary.title=mark.course?.course||'';summary.dataset.libraryFocus=snapshot?'moment-title:'+snapshot.id:'mark-title:'+mark.id;summary.append(text);details.append(summary);
    const body=el('div');body.className='library-mark-body';details.append(body);
    if(data&&snapshot)fillMark(mark,{...data,snapshots:[snapshot]},body);else{const failure=readFailures.get('mark:'+mark.id);if(failure)showReadFailure(body,failure,null,'mark-retry:'+mark.id,false);else body.append(loadingImage());}
    return details;
  }
  function renderMoments(browser){
    const entries=[];let unread=0;
    for(const mark of visibleMarks()){
      const data=loaded.get(mark.id)||displayMarks.get(mark.id);if(!loaded.has(mark.id))unread++;
      const snapshots=data&&momentSnapshots(data);if(snapshots?.length)for(const snapshot of snapshots)entries.push({mark,data,snapshot,time:snapshot.time,id:snapshot.id});else entries.push({mark,time:mark.time,id:mark.id});
    }
    entries.sort((a,b)=>recordScope(a.mark).localeCompare(recordScope(b.mark))||(Number(a.time)||0)-(Number(b.time)||0)||String(a.id).localeCompare(String(b.id)));
    browser.dataset.momentsComplete=String(listingState==='ready'&&!unread);browser.setAttribute('aria-busy',String(listingState==='loading'||unread>0&&visibleMarks().some(mark=>!loaded.has(mark.id)&&!readFailures.has('mark:'+mark.id))));
    let course='';for(const entry of entries){const name=entry.mark.course?.course||'课程';if(browseScope==='all'&&name!==course){course=name;const heading=el('h3',name);heading.className='library-course';browser.append(heading);}browser.append(markRow(entry.mark,entry.data,entry.snapshot));}
  }
  function scheduleMomentReads(){
    if(!visible||tab!=='marks'||previewState||listingState!=='ready')return;
    const epoch=cacheEpoch,waiting=visibleMarks().filter(mark=>!loaded.has(mark.id)&&!markLoads.has(mark.id)&&!readFailures.has('mark:'+mark.id));
    for(const mark of waiting.slice(0,Math.max(0,4-markLoads.size)))void loadMark(mark.id).then(()=>{if(epoch===cacheEpoch)displayMarks.delete(mark.id);}).catch(()=>{}).finally(()=>{if(epoch===cacheEpoch&&visible&&tab==='marks'&&!previewState)render();});
  }
  function fillQuestion(q,data,body){
      const focused=focusKeyWithin(body);body.replaceChildren();body.setAttribute('aria-busy','false');
      if(data.conversationUrl)body.append(button('打开原对话',()=>openConversation(data.conversationUrl),'conversation:'+q.id));
      if(resumeDraft&&data.status==='draft'&&data.draftManifest?.version===1){const resume=button(resumeLabel(data),()=>continueDraft(q.id),'resume-draft:'+q.id);resume.disabled=busy;body.append(resume);}
      const parts=(data.questions||[]).filter(x=>x.text?.trim());
      for(const part of parts){const label=el('label');label.className='library-old-question';const check=el('input');check.type='checkbox';check.dataset.questionId=q.id;check.dataset.questionPart=part.id;check.dataset.libraryFocus='part:'+q.id+'/'+part.id;check.dataset.defaultIncluded=String(part.included!==false);const picked=selectedQuestions.get(q.id);check.checked=selectedQuestions.has(q.id)&&(picked===null?part.included!==false||questionSelectionIntents.get(q.id)?.parts.has(part.id):picked.has(part.id));
        check.addEventListener('change',()=>{
          const intents=questionSelectionIntent(q.id),wasWhole=selectedQuestions.get(q.id)===null;let subset=selectedQuestions.get(q.id);subset=subset===null?new Set([...parts.filter(x=>x.included!==false).map(x=>x.id),...intents.parts.keys()]):subset||new Set();reviewQuestionVersion(intents,data);
          const before=!check.checked&&subset.has(part.id)?questionChoicePayload().find(choice=>choice.questionId===q.id):null,removed=before?{refs:[],refOrder:[],questions:[],questionOrder:[...selectedQuestions.keys()],parts:[{before,itemId:part.id,after:null}]}:null;
          if(check.checked){subset.add(part.id);intents.parts.set(part.id,newSelectionIntent());}else{subset.delete(part.id);intents.parts.delete(part.id);if(wasWhole)intents.retainSupplementaryText=true;}
          if(intents.retainSupplementaryText&&intents.whole)intents.whole=reorderedIntent(intents.whole);
          if(subset.size||intents.retainSupplementaryText)selectedQuestions.set(q.id,subset);else removeQuestion(q.id);
          if(removed){removed.parts[0].after=JSON.stringify(questionChoicePayload().find(choice=>choice.questionId===q.id)||null);selectionUndo.push(removed);}updateCount();
        });
        const text=el('span'),source=el('span',(part.included===false?'曾移出 · ':'')+(part.source||part.label||'提问记录'));source.className='library-old-source';text.append(el('span',part.text),source);label.append(check,text);body.append(label);if(part.ref?.markId)body.append(button('定位原处',()=>locate(part.ref),'old-locate:'+q.id+'/'+part.id));
      }
      if(parts.length&&data.extra){const extra=el('p',data.extra);extra.className='library-question-extra';body.append(extra)}
      if(!parts.length)body.append(el('pre',data.text||'这份草稿还没有填写具体问题。'));focusByKey(focused);
  }
  function questionRow(q){
    const titleText=/^【(?:课堂背景与图片说明|保留的原提问)】/.test(q.title||'')||q.hasQuestionText===false?(q.imageCount?'附图草稿 · '+q.imageCount+' 张图':'已保存的草稿'):q.title||'提问记录',updated=new Date(q.updatedAt);
    const when=Number.isFinite(updated.getTime())?updated.toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';
    const rowVersion=renderEpoch,details=el('details'),summary=el('summary'),select=el('input');details.className='library-question';details.open=openQuestions.has(q.id);select.type='checkbox';select.checked=selectedQuestions.has(q.id);
    select.dataset.questionCheck=q.id;select.dataset.libraryFocus='question:'+q.id;select.setAttribute('aria-label','选择提问记录：'+titleText+(when?'，'+when:''));
    select.addEventListener('click',e=>e.stopPropagation());select.addEventListener('change',()=>{if(select.checked){selectedQuestions.set(q.id,null);questionSelectionIntents.set(q.id,{sourceRevision:q.revision,sourceUpdatedAt:q.updatedAt,whole:newSelectionIntent(),parts:new Map()})}else{rememberRemoved([],[q.id]);removeQuestion(q.id);}updateCount()});
    const text=el('span'),title=el('span',q.hasQuestionText===false?'':titleText),meta=el('span',when);text.className='library-entry-text';title.className='library-entry-title';meta.className='library-entry-meta';text.append(title,meta);summary.dataset.libraryFocus='question-title:'+q.id;summary.append(select,text);
    if(q.status==='draft'&&resumeDraft){const resume=iconButton('edit',resumeLabel(q),()=>continueDraft(q.id),'open-draft:'+q.id);resume.className='library-continue';resume.disabled=busy;summary.append(resume);}
    else if(q.conversationUrl){const open=iconButton('chat','继续对话',()=>openConversation(q.conversationUrl),'open-conversation:'+q.id);open.className='library-continue';summary.append(open);}
    details.append(summary);
    const body=el('div');body.className='library-question-body';details.append(body);
    const populate=async(retry=false)=>{const version=renderEpoch,previous=questions.get(q.id)||displayQuestions.get(q.id);try{if(previous)fillQuestion(q,previous,body);else body.replaceChildren(loadingImage());if(questions.has(q.id))return;const failedRead=readFailures.get('question:'+q.id);if(failedRead&&!retry){showReadFailure(body,failedRead,()=>populate(true),'question-retry:'+q.id,!!previous);return}body.setAttribute('aria-busy','true');const data=await loadQuestion(q.id);if(version===renderEpoch&&details.open){displayQuestions.delete(q.id);fillQuestion(q,data,body);updateCount();recoveredRead(failedRead)}}catch(error){if(version!==renderEpoch||!details.open)return;showReadFailure(body,error,()=>populate(true),'question-retry:'+q.id,!!previous)}};
    details.addEventListener('toggle',()=>{if(rowVersion!==renderEpoch)return;if(details.open){openQuestions.add(q.id);void populate()}else openQuestions.delete(q.id)});
    if(details.open)void populate();return details;
  }
  function questionChoicePayload(){return [...selectedQuestions].map(([questionId,parts])=>{const intents=questionSelectionIntent(questionId),explicit=[...intents.parts].filter(([id])=>parts===null||parts.has(id));return {questionId,itemIds:parts?[...parts]:[],...parts&&intents.retainSupplementaryText?{retainSupplementaryText:true}:{},...parts===null&&explicit.length?{additionalItemIds:explicit.map(([id])=>id)}:{},...(intents.sourceRevision?{sourceRevision:intents.sourceRevision}:{}),...(intents.sourceUpdatedAt?{sourceUpdatedAt:intents.sourceUpdatedAt}:{}),...intents.whole?{restoreIntentId:intents.whole.intentId,restoreIntentAt:intents.whole.intentAt}:{},restorePartIntents:explicit.map(([itemId,intent])=>({itemId,...intentPayload(intent)}))}})}
  async function continueDraft(id){
    if(busy)return;const ticket=++draftEpoch,session=sessionEpoch,current=()=>ticket===draftEpoch&&session===sessionEpoch&&visible;busy=true;phase='resume';status='正在恢复草稿…';statusKind='';render();
    try{const data=await loadQuestion(id);if(!current())return;if(data.draftManifest?.version!==1){openQuestions.add(id);status='';return;}const result=await resumeDraft(id);if(current())status=result.copy?'已恢复为可编辑副本，原记录保留':'已打开草稿'}
    catch(error){if(current()){if(error.name==='AbortError'){status='恢复尚未确认，可重新打开这份草稿核对。';statusKind='waiting'}else recordFailure(error)}}
    finally{if(ticket===draftEpoch){busy=false;phase='';render()}}
  }
  async function openCurrentDraft(){
    if(busy||!openDraft)return;const ticket=++draftEpoch,session=sessionEpoch,current=()=>ticket===draftEpoch&&session===sessionEpoch&&visible;busy=true;phase='open';status='正在打开当前草稿…';statusKind='';render();
    try{await openDraft();if(current())status='已打开当前草稿'}catch(error){if(current()){if(error.name==='AbortError'){status='勾选已保留';statusKind=''}else recordFailure(error)}}
    finally{if(ticket===draftEpoch){busy=false;phase='';render()}}
  }
  function selectionSnapshot(){return {refs:new Map([...selected.keys()].map(key=>[key,selectionVersions.get(key)])),refIntents:new Map([...selected.keys()].map(key=>[key,selectionIntents.get(key)?.intentId])),questions:new Map([...selectedQuestions].map(([id,parts])=>{const intents=questionSelectionIntent(id);return [id,{whole:parts===null,supplementary:parts!==null&&intents.retainSupplementaryText===true,parts:parts?new Set(parts):null,defaultVersion:intents.whole?.version,defaultIntentId:intents.whole?.intentId,partVersions:new Map([...intents.parts].map(([key,intent])=>[key,intent.version])),partIntentIds:new Map([...intents.parts].map(([key,intent])=>[key,intent.intentId]))}]}))}}
  function savedChoiceSnapshot(snapshot){return {refs:[...snapshot.refIntents],questions:[...snapshot.questions].map(([id,choice])=>[id,{whole:choice.whole,...choice.supplementary?{supplementary:true}:{},parts:choice.parts?[...choice.parts]:null,defaultIntentId:choice.defaultIntentId||'',partIntentIds:[...choice.partIntentIds]}])};}
  function restoreChoiceSnapshot(saved){
    if(!saved||!Array.isArray(saved.refs)||!Array.isArray(saved.questions))throw Error('保留的选材记录尚未读取完整，原材料已保留。');
    return {refs:new Map(saved.refs.map(([key])=>[key,undefined])),refIntents:new Map(saved.refs),questions:new Map(saved.questions.map(([id,choice])=>[id,{...choice,parts:choice.parts?new Set(choice.parts):null,partVersions:new Map(),partIntentIds:new Map(choice.partIntentIds||[])}]))};
  }
  async function loadJobs({force=false}={}){
    if(jobsLoading){try{await jobsLoading}catch(error){if(!force)throw error;}return force?loadJobs({force:true}):undefined;}if(jobsReady&&!force)return;
    const known=new Set([...jobs].filter(([,job])=>job.persisted&&job.state!=='working').map(([id])=>id));
    jobsLoading=(async()=>{const result=await companion.library('plan-jobs',{scope:selectionKey});if(result?.schema!==1||!Array.isArray(result.jobs))throw Error('先前的选材暂未读取，当前材料仍保留。');
      const ready=new Set(result.jobs.map(record=>record.id));for(const id of known)if(!ready.has(id)&&jobs.get(id)?.state!=='working')jobs.delete(id);
      for(const record of result.jobs){if(retiredJobs.has(record.id))continue;const existing=jobs.get(record.id);if(existing){if(existing.state!=='working'&&record.state==='completed'){existing.completed=true;existing.outcome=record.outcome;existing.state='complete';existing.submission=record.delivery||record.plannedDelivery||existing.submission;}continue;}const snapshot=restoreChoiceSnapshot(record.choiceSnapshot);jobs.set(record.id,{plan:{id:record.id,logicalItems:[]},needsLoad:true,persisted:true,destination:record.planDestination,target:record.target,signature:record.signature,operationId:record.operationId,choiceSnapshot:snapshot,state:record.state==='completed'?'complete':'unknown',completed:record.state==='completed',outcome:record.outcome,submission:record.delivery||record.plannedDelivery||null,logicalCount:record.logicalCount||0});}
      jobsReady=true;render();
    })().finally(()=>{jobsLoading=null;retiredJobs.clear();});return jobsLoading;
  }
  // An in-flight list may still contain a task that has just been retired.
  function retireJob(id){if(jobsLoading)retiredJobs.add(id);jobs.delete(id);}
  async function persistPlanJob(job){
    if(job.persisted)return;
    const result=await companion.library('plan-job',{plan:job.plan,scope:selectionKey,destination:job.destination,target:job.target,signature:job.signature,operationId:job.operationId,choiceSnapshot:savedChoiceSnapshot(job.choiceSnapshot)});
    if(result?.id!==job.plan.id||result.operationId!==job.operationId)throw Error('本次材料的保存尚未确认，原选材已保留。');job.persisted=true;if(result.dismissed===true)throw Object.assign(Error('这批材料的附图任务已结束，勾选和原图仍保留。'),{code:'capture_dismissed'});job.completed=result.state==='completed';job.outcome=result.outcome;
  }
  async function loadJobPlan(job){if(!job.needsLoad)return;const result=await companion.library('plan',{id:job.plan.id});if(result?.plan?.id!==job.plan.id||result.captureReceipt?.operationId!==job.operationId)throw Error('原材料尚未完整恢复，请稍后重试。');if(result.captureReceipt.dismissed===true)throw Object.assign(Error('这批材料的附图任务已结束，勾选和原图仍保留。'),{code:'capture_dismissed'});job.plan=result.plan;job.needsLoad=false;job.completed=result.captureReceipt.state==='completed';job.outcome=result.captureReceipt.outcome;job.submission=result.captureReceipt.delivery||result.captureReceipt.plannedDelivery||job.submission;}
  async function finishPlanJob(job){consumeSelection(job);render();await selectionStore.flush();const result=await companion.library('plan-job-retire',{id:job.plan.id,scope:selectionKey,operationId:job.operationId});if(result?.retired!==true||result.id!==job.plan.id)throw Error('材料已加入草稿，选材记录尚未完成保存。');retireJob(job.plan.id);if(!selected.size&&!selectedQuestions.size)selectionMode=false;}
  function consumeSelection(job){
    if(!job.choiceSnapshot)return;
    for(const [key,version]of job.choiceSnapshot.refs){const intent=job.choiceSnapshot.refIntents?.get(key);if(selected.has(key)&&(intent?selectionIntents.get(key)?.intentId===intent:version!==undefined&&selectionVersions.get(key)===version)&&(version===undefined||selectionVersions.get(key)===version)){selected.delete(key);selectionIntents.delete(key);selectionVersions.delete(key)}}
    for(const [id,choice]of job.choiceSnapshot.questions){
      if(!selectedQuestions.has(id))continue;const current=selectedQuestions.get(id),intents=questionSelectionIntent(id);
      if(current===null){if(choice.whole&&(choice.defaultIntentId?intents.whole?.intentId===choice.defaultIntentId:choice.defaultVersion!==undefined&&intents.whole?.version===choice.defaultVersion)&&(choice.defaultVersion===undefined||intents.whole?.version===choice.defaultVersion)){
        const remaining=[...intents.parts].filter(([part,intent])=>{const submittedIntent=choice.partIntentIds?.get(part),version=choice.partVersions.get(part);return submittedIntent!==intent.intentId||version!==undefined&&version!==intent.version;});
        if(remaining.length){selectedQuestions.set(id,new Set(remaining.map(([part])=>part)));intents.whole=null;intents.parts=new Map(remaining);}else{selectedQuestions.delete(id);questionSelectionIntents.delete(id);}
      }continue}
      const submitted=choice.parts||new Set([...(job.plan.carry||[]).filter(question=>question.id===id).flatMap(question=>(question.questions||[]).filter(part=>part.included!==false).map(part=>part.id)),...choice.partIntentIds.keys()]);
      for(const part of submitted){const intent=choice.partIntentIds?.get(part)||choice.defaultIntentId,currentIntent=intents.parts.get(part)?.intentId||intents.whole?.intentId,version=choice.partVersions.get(part)??choice.defaultVersion,currentVersion=intents.parts.get(part)?.version??intents.whole?.version;if(current.has(part)&&(intent?currentIntent===intent:version!==undefined&&currentVersion===version)&&(version===undefined||currentVersion===version)){current.delete(part);intents.parts.delete(part)}}
      if(choice.supplementary&&intents.retainSupplementaryText&&(choice.defaultIntentId?intents.whole?.intentId===choice.defaultIntentId:choice.defaultVersion!==undefined&&intents.whole?.version===choice.defaultVersion)&&(choice.defaultVersion===undefined||intents.whole?.version===choice.defaultVersion))intents.retainSupplementaryText=false;
      if(!current.size&&!intents.retainSupplementaryText){selectedQuestions.delete(id);questionSelectionIntents.delete(id)}
    }
  }
  async function retargetJob(job){
    if(busy||!selectionStore.state().ready)return;const session=sessionEpoch;busy=true;phase='retarget';status='正在保留选材…';statusKind='';render();
    try{
      for(const [key,value]of selected)putSelection(key,value,reorderedIntent(selectionIntents.get(key)));
      for(const [id,intents]of questionSelectionIntents)if(selectedQuestions.has(id)){if(intents.whole)intents.whole=reorderedIntent(intents.whole);for(const [part,intent]of intents.parts)intents.parts.set(part,reorderedIntent(intent));}
      await selectionStore.flush();
      if(job.persisted)await companion.library('plan-job-dismiss',{id:job.plan.id,scope:selectionKey,operationId:job.operationId});
      retireJob(job.plan.id);if(session===sessionEpoch){status='原草稿和勾选仍保留';statusKind='';}
    }finally{if(status==='正在保留选材…'){status='';statusKind='';}busy=false;phase='';render();}
  }
  function jobSignature(request,destination,context){const identity=context?.draftId?Object.fromEntries(['conversationId','route','pageId','documentEpoch','routeGeneration','draftId'].map(key=>[key,context[key]])):context;return JSON.stringify({refs:request.refs,restoreRefs:request.restoreRefs,questions:request.questions,background:request.background,questionImages:request.questionImages,destination,target:destination==='current'&&identity?Object.fromEntries(Object.keys(identity).sort().map(key=>[key,identity[key]])):null})}
  const completionStatus=outcome=>outcome==='removed'?'已移出本次材料':outcome==='already-sent'?'这批材料已在目标对话中':outcome==='attached'?'已加入提问草稿':'已核对材料记录';
  async function deliver(job,{requestOwner=getRestoreIntent?.()?.workspace,isCurrent=()=>true}={}){
    if(busy||job.state==='working'||!selectionStore.state().ready)return;const ticket=++deliveryEpoch,current=()=>ticket===deliveryEpoch;busy=true;phase='send';job.state='working';status='正在加入提问草稿…';statusKind='';render();
    try{await loadJobPlan(job);await persistPlanJob(job);if(job.completed){await finishPlanJob(job);if(current()){status=completionStatus(job.outcome);statusKind='';}return;}
      requestOwner?.assertCurrent();if(!isCurrent())throw new DOMException('Material choice changed','AbortError');
      const receipt=await send(job.plan,job.destination,{requestOwner,isCurrent,target:job.target,operationId:job.operationId,previous:job.submission||null,onSubmission:(value,current)=>{job.submission=value;if(!job.target)job.target=current;return companion.library('plan-job-checkpoint',{id:job.plan.id,delivery:value,...current?.draftId?{draftId:current.draftId}:{}});},onProgress:value=>{job.receipt=value}});
      if(receipt?.durable===true){if(receipt.completed!==true||receipt.id!==job.plan.id||receipt.operationId!==job.operationId||!['attached','already-sent','removed'].includes(receipt.outcome))throw Object.assign(Error('保留的完成记录不属于本次选材。'),{code:'delivery_mismatch'});job.completed=true;job.outcome=receipt.outcome;job.state='complete';await finishPlanJob(job);if(current()){status=completionStatus(job.outcome);statusKind='';}return;}
      job.receipt=receipt||job.receipt;const result=job.receipt,confirmed=result?.verified===true&&((result.state==='attached'&&result.evidence==='composer')||(result.state==='already-sent'&&result.evidence==='confirmed-message')||(result.state==='removed'&&result.evidence==='composer-removal'));
      if(confirmed&&job.submission)captureReceipt(result,job.submission);
      job.state=result?.state==='paused'?'paused':confirmed?'complete':'unknown';
      if(current()){status=job.state==='paused'?'这批材料已暂停，可继续。':job.state==='unknown'?'附件结果还未确认，可继续核对。':completionStatus(result?.state);statusKind=job.state==='complete'?'':'waiting';}if(job.state==='complete'){
        const acknowledgement=await companion.library('capture-ack',{id:job.plan.id,operationId:job.submission.operationId,attemptId:job.submission.attemptId,target:job.submission.target,receipt:result});if(acknowledgement?.completed!==true)throw Error('附图结果尚未完成核对，原任务已保留。');job.completed=true;job.outcome=result.state;await finishPlanJob(job);
      }
    }catch(error){job.state='failed';job.errorCode=error.code;if(error.code==='capture_dismissed')retireJob(job.plan.id);if(current())recordFailure(error)}finally{if(job.persisted){job.logicalCount=job.plan.logicalItems?.length||job.logicalCount||0;job.plan={id:job.plan.id,logicalItems:[]};job.needsLoad=true;}if(current()){busy=false;phase='';render()}}
  }
  async function prepare({openCurrent=false}={}){
    if(!selectionStore.state().ready||busy||bulk||(!selected.size&&!selectedQuestions.size))return;
    const carry=questionChoicePayload(),request={refs:[...selected.values()],restoreRefs:[...selected].flatMap(([key,reference])=>{const intent=selectionIntents.get(key);return intent?[{...reference,...intentPayload(intent)}]:[]}),questions:carry,background,questionImages,title:'课后提问'};
    const choiceSnapshot=selectionSnapshot(),destination=target,invocation=++askEpoch,choiceSignature=JSON.stringify(selectionChoice());
    let currentTarget=destination==='current'?companion.snapshot?.()?.chatDraftTarget:null;
    let requestOwner=getRestoreIntent?.()?.workspace;
    if(destination==='current'&&openCurrent&&openDraft){const opening=openDraft();requestOwner=getRestoreIntent?.()?.workspace;currentTarget=await opening;}
    if(invocation!==askEpoch||requestOwner?.isCurrent()===false||choiceSignature!==JSON.stringify(selectionChoice()))return;
    const frozenTarget=currentTarget?{...currentTarget}:null;
    if(destination==='current'&&!frozenTarget){recordFailure(Error('当前提问尚未就绪，所选材料仍保留。'));render();return}
    const ticket=++composeEpoch;composingChoice=choiceSignature;const current=()=>ticket===composeEpoch&&invocation===askEpoch&&requestOwner?.isCurrent()!==false&&choiceSignature===JSON.stringify(selectionChoice());let reviewFocus;busy=true;phase='compose';status='正在整理所选材料…';statusKind='';render();
    try{
      const legacy=carry.filter(choice=>!choice.sourceRevision&&!choice.sourceUpdatedAt).map(choice=>({id:choice.questionId,intents:questionSelectionIntents.get(choice.questionId),selection:JSON.stringify(choice)}));
      if(legacy.length){
        for(const choice of legacy){const data=await companion.library('question',{id:choice.id});if(!current())return;if(!selectedQuestions.has(choice.id)||questionSelectionIntents.get(choice.id)!==choice.intents||JSON.stringify(questionChoicePayload().find(item=>item.questionId===choice.id))!==choice.selection)continue;
          if(!reviewFocus)rememberView();reviewQuestionVersion(choice.intents,data);const focus=revealReviewedQuestion(data);if(!reviewFocus)reviewFocus=focus;
        }
        status='已载入所选问题的当前内容；查看后可整理。';statusKind='';return;
      }
      await loadJobs();if(!current())return;
      const signature=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(jobSignature(request,destination,frozenTarget))))].map(value=>value.toString(16).padStart(2,'0')).join('');
      if(!current())return;const previous=[...jobs.values()].find(job=>job.signature===signature),choiceCurrent=()=>invocation===askEpoch&&choiceSignature===JSON.stringify(selectionChoice());if(previous){busy=false;await deliver(previous,{requestOwner,isCurrent:choiceCurrent});return;}
      await selectionStore.flush();if(!current())return;
      const plan=await companion.library('compose',request);
      if(!current())return;const job={plan,destination,target:frozenTarget,signature,choiceSnapshot,state:'ready',submission:null,operationId:crypto.randomUUID(),logicalCount:plan.logicalItems?.length||0};jobs.set(plan.id,job);busy=false;await deliver(job,{requestOwner,isCurrent:choiceCurrent});
    }catch(error){if(current()){if(error.code==='library_question_changed'){const choices=questionChoicePayload().map(item=>({id:item.questionId,intents:questionSelectionIntents.get(item.questionId),selection:JSON.stringify(item)}));for(const choice of choices){const data=await companion.library('question',{id:choice.id});if(!current())return;if(!selectedQuestions.has(choice.id)||questionSelectionIntents.get(choice.id)!==choice.intents||JSON.stringify(questionChoicePayload().find(item=>item.questionId===choice.id))!==choice.selection)continue;if(!reviewFocus)rememberView();reviewQuestionVersion(choice.intents,data);const focus=revealReviewedQuestion(data);if(!reviewFocus)reviewFocus=focus;}status='所选问题已有更新，已展示新内容；查看后可重新整理。';statusKind='';}else recordFailure(error);}}finally{if(ticket===composeEpoch&&phase==='compose'){busy=false;phase='';composingChoice=null;render(reviewFocus,!reviewFocus)}}
  }
  function renderLaunch(container,key='launch'){
    if(!launchRequired||root.querySelector('[data-library-launch]'))return;const launch=el('a',launching?'连接中…':'连接');launch.href='zhiyun-focus://start';launch.className='button';launch.dataset.libraryFocus=key;launch.dataset.libraryLaunch='true';launch.setAttribute('aria-disabled',String(launching));
    launch.addEventListener('click',e=>{e.stopPropagation();if(launching){e.preventDefault();return}launching=true;const session=sessionEpoch;Promise.resolve().then(()=>{if(session===sessionEpoch)void resumeLibrary()})});container.append(launch);
  }
  async function backup(){
    if(backupBusy)return;backupBusy=true;status='正在导出备份…';statusKind='';render();
    try{const result=await companion.library('backup');status='备份已保存：'+result.path}catch(error){recordFailure(error)}finally{backupBusy=false;render()}
  }
  function renderPreview(){
    const {item,image,loading,error}=previewState,head=el('div');head.className='library-preview-head';
    head.append(iconButton('back','返回课堂片段',returnFromPreview,'preview-back'),el('time',libraryTime(item.time)));root.append(head);
    const content=el('div');content.className='library-preview-content';
    if(image){const picture=el('img');picture.src=image;picture.alt=item.label;content.append(picture);}else content.append(loading?loadingImage():el('div'));
    root.append(content);const actions=el('div');actions.className='library-preview-actions';
    actions.append(iconButton('return','回到此刻',()=>locate(ref(item)),'preview-locate'));
    if(image&&!loading&&!error){actions.append(iconButton('copy','复制图片',()=>copyBoard(image),'preview-copy'));
      const download=el('a');download.className='library-icon';download.href=image;download.download='课堂-'+libraryTime(item.time).replaceAll(':','-')+'.png';download.setAttribute('aria-label','下载图片');download.innerHTML=toolbarIcon('download');actions.append(download);
      if(crop){const control=iconButton('capture','从原图圈选',cropPreview,'preview-crop');control.disabled=!!previewState.cropping;actions.append(control);}
      const select=iconButton('select','选择 '+item.label,()=>{selectionMode=true;choose(item,!selected.has(refKey(item)));},'preview-choice');select.dataset.imageToggle=refKey(item);select.setAttribute('aria-pressed',String(selected.has(refKey(item))));actions.append(select);
      actions.append(iconButton('chat','用这张图提问',()=>askItem(item),'preview-ask'));
    }root.append(actions);
  }

  function renderFooter(){
    const footer=el('div');footer.className='library-footer';footer.dataset.libraryFooter='true';
    const undo=iconButton('undo','撤销移出选材',undoSelection,'undo-selection');undo.dataset.selectionUndo='true';undo.hidden=!selectionUndo.length;footer.append(undo);
    const selection=el('div'),choices=el('details'),count=el('summary'),label=el('span'),peek=el('span'),chosen=el('div');selection.className='library-selection-row';choices.className='library-picked';choices.open=selectionOpen;label.dataset.selectionCount='true';peek.dataset.selectionPeek='true';peek.className='library-selection-peek';count.dataset.libraryFocus='selection-order';count.setAttribute('aria-label','查看与调整选材顺序');count.append(peek,label);chosen.dataset.selectionItems='true';choices.append(count,chosen);choices.addEventListener('toggle',()=>{if(!root.contains(choices))return;selectionOpen=choices.open;renderSelection()});selection.append(choices);footer.append(selection);
    const actions=el('div');actions.className='library-send-row';
    const submit=iconButton('chat','将所选材料带入提问',()=>{target='current';return prepare({openCurrent:true});},'submit');submit.dataset.librarySubmit='true';submit.classList.add('library-primary');actions.append(submit);
    const fresh=iconButton('newChat','在新对话中提问',()=>{target='new';return prepare();},'new-question');fresh.disabled=busy;actions.append(fresh);
    const options=el('details');options.className='library-options';options.open=optionsOpen;options.dataset.libraryOptions='true';const summary=el('summary');summary.innerHTML=toolbarIcon('boards');summary.setAttribute('aria-label','选择附带的背景');options.append(summary);options.addEventListener('toggle',()=>optionsOpen=options.open);
    const body=el('div');body.className='library-options-body';
    for(const [key,label,value,change,icon]of [['background','附带当时的全景与板位',background,value=>background=value,'boards'],['question-images','附带旧问题的原图',questionImages,value=>questionImages=value,'library']]){const control=iconButton(icon,label,()=>{change(!value);selectionStore.sync();render();},key);control.setAttribute('aria-pressed',String(value));body.append(control);}options.append(body);actions.append(options);footer.append(actions);
    root.append(footer);
  }

  function renderScopePicker(toolbar){
    const context=currentContext(),groups=new Map(),scopes=new Map();
    for(const record of [context,...listing.marks,...listing.questions]){
      if(record===context&&!record.lessonKey)continue;
      const value=studyRecordContext(record),scope=value.lessonKey,courseKey=value.courseKey;
      if(!groups.has(courseKey))groups.set(courseKey,{name:value.courseName,lessons:new Map()});
      const group=groups.get(courseKey),placeholder='课程 '+scope.split(':')[2];
      if(group.name===placeholder&&value.courseName!==placeholder){group.name=value.courseName;for(const lesson of group.lessons.values())lesson.course=group.name;}
      const info={key:scope,course:group.name,lesson:value.lessonName},existing=group.lessons.get(scope);
      if(existing&&/^讲次 \d+$/.test(existing.lesson)&&!/^讲次 \d+$/.test(info.lesson))existing.lesson=info.lesson;
      if(!group.lessons.has(scope)){group.lessons.set(scope,info);scopes.set(scope,info);}
    }
    const picker=el('details'),selected=scopes.get(browseScope);picker.className='library-scope-picker';picker.dataset.libraryScopePicker='true';picker.open=scopePickerOpen;
    const summary=el('summary');summary.innerHTML=toolbarIcon('boards');summary.setAttribute('aria-label',browseScope==='all'?'全部课程':selected?[selected.course,selected.lesson].join(' · '):'本讲');summary.dataset.libraryFocus='scope-picker';picker.append(summary);picker.addEventListener('toggle',()=>scopePickerOpen=picker.open);
    const choices=el('div');choices.className='library-scope-choices';
    const choose=scope=>{rememberView();browseScope=scope;scopePickerOpen=false;picker.open=false;previewState=null;previewEpoch++;selectionEpoch++;selectAllEpoch++;bulk=null;render('scope-picker',false)};
    choices.append(button('全部课程',()=>choose('all'),'scope:all'));
    for(const [key,group]of groups){const course=el('details');course.dataset.libraryCourseGroup=key;course.open=openCourseGroups.has(key)||[...group.lessons.keys()].includes(browseScope);course.append(el('summary',group.name));course.addEventListener('toggle',()=>course.open?openCourseGroups.add(key):openCourseGroups.delete(key));for(const info of group.lessons.values()){const control=button(info.lesson,()=>choose(info.key),'scope:'+info.key);control.setAttribute('aria-current',String(info.key===browseScope));course.append(control)}choices.append(course);}
    picker.append(choices);toolbar.append(picker);
  }
  function render(focus,remember=true){
    const focused=focus||focusKeyWithin(root);if(remember)rememberView();renderEpoch++;root.replaceChildren();if(root.classList)root.classList.add('library-workspace');else root.className='library-workspace';
    const toolbar=el('div'),heading=el('div');toolbar.className='library-toolbar';heading.className='library-topline';heading.append(el('h2','课堂资料'),button('收起',dismiss));toolbar.append(heading);
    if(!previewState)renderScopePicker(toolbar);
    if(!previewState){
      const tabs=el('div');tabs.className='library-tabs';const history=iconButton('history',tab==='questions'?'返回课堂片段':'查看提问历史',()=>setTab(tab==='questions'?'marks':'questions'),'tab:questions');history.setAttribute('aria-pressed',String(tab==='questions'));tabs.append(history);toolbar.append(tabs);
    }
    root.append(toolbar);
    if(previewState)renderPreview();else{
      const browser=el('div');browser.className='library-browser';browser.dataset.libraryScroll=tab;browser.setAttribute('role','tabpanel');root.append(browser);
      const hasRecords=!!(listing.marks.length||listing.questions.length),management=el('details');management.className='library-management';management.dataset.libraryManagement='true';management.open=managementOpen;const summary=el('summary');summary.innerHTML=toolbarIcon('more');summary.setAttribute('aria-label','记录管理');summary.dataset.libraryFocus='management';management.append(summary);management.addEventListener('toggle',()=>{if(root.contains(management))managementOpen=management.open;});
      management.addEventListener('pointerenter',()=>{clearTimeout(managementDismissTimer);managementDismissTimer=0;});
      management.addEventListener('pointerleave',event=>{if(event.pointerType!=='mouse')return;clearTimeout(managementDismissTimer);managementDismissTimer=setTimeout(()=>closeManagement(),220);});
      const actions=el('div');actions.className='library-management-actions';const all=button('全选标记',()=>{closeManagement();selectionMode=true;return selectAll()}),refreshButton=button('刷新',()=>{closeManagement();return refresh()}),exportButton=button('导出备份',()=>{closeManagement();return backup()});all.disabled=!selectionStore.state().ready||!!bulk||!visibleMarks().length;exportButton.disabled=backupBusy;actions.append(all,refreshButton,exportButton);management.append(actions);
      if(hasRecords||listingState==='ready'){const tools=el('div');tools.className='library-browse-tools';const choose=iconButton('select','选择',()=>{if(selectionMode||selected.size||selectedQuestions.size){selectionMode=false;clearSelection()}else{selectionMode=true;render('selection-mode')}},'selection-mode');choose.disabled=!selectionStore.state().ready;choose.hidden=tab==='marks'?!visibleMarks().length:!listing.questions.some(inScope);tools.append(choose,management);toolbar.append(tools);}
      if(listingState==='loading'&&!hasRecords){const loading=loadingImage();loading.classList.add('library-load-row');loading.setAttribute('role','status');browser.append(loading)}
      if(listingState==='failed')browser.dataset.readError=listingError;
      if(tab==='marks'){renderMoments(browser);if(listingState==='ready'&&!visibleMarks().length){const empty=el('div');empty.className='library-empty';if(capture)empty.append(iconButton('capture','截取课堂片段',capture));browser.append(empty)}}
      else{
        renderQuestionIndex(browser);const other=[],questions=listing.questions.filter(inScope);
        for(const question of questions){if(question.status==='draft'&&question.hasQuestionText===false)other.push(question);else browser.append(questionRow(question));}
        if(other.length){const group=el('details');group.className='library-other-drafts';group.dataset.libraryOtherDrafts='true';group.open=otherDraftsOpen||other.some(question=>selectedQuestions.has(question.id)||openQuestions.has(question.id));const heading=el('summary');heading.innerHTML=toolbarIcon('library');heading.setAttribute('aria-label','仅附图的草稿 '+other.length);group.append(heading);for(const question of other)group.append(questionRow(question));group.addEventListener('toggle',()=>otherDraftsOpen=group.open);browser.append(group);}
        if(listingState==='ready'&&questionIndex.state==='ready'&&!questions.length){const empty=el('div');empty.className='library-empty';if(openDraft)empty.append(iconButton('chat','开始提问',openDraft));browser.append(empty)}
      }
      browser.scrollTop=scrollPositions.get(tab)||0;
    }
    renderFooter();updateCount();updateQuestionIndexStatus();restoreScroll();focusByKey(focused);scheduleMomentReads();scheduleQuestionPoll();
  }
  async function refresh(){
    void selectionStore.load().catch(()=>{});
    stopQuestionPolling();questionReadAttempts=0;questionReadFailures=0;questionRetryRequested=false;
    const ticket=++refreshEpoch,markVersion=markUpdateVersion;selectionEpoch++;selectAllEpoch++;bulk=null;listingState='loading';listingError='';listingNeedsLaunch=false;render();
    let next,failure;for(let attempt=0;attempt<3;attempt++){if(ticket!==refreshEpoch)return;try{next=await companion.library('list',{indexStatus:true});break}catch(error){failure=error;if(needsLaunch(error)||attempt===2)break;await new Promise(resolve=>eventView.setTimeout(resolve,400*2**attempt));}}
    if(!next){if(ticket===refreshEpoch){listingState='failed';listingError=failure?.message||'课堂资料暂未读取。';listingNeedsLaunch=needsLaunch(failure);if(listingNeedsLaunch)launchRequired=true;render()}return}
    if(ticket!==refreshEpoch)return;
    for(const [id,data]of loaded)displayMarks.set(id,data);
    questionIndex=normalizeQuestionIndex(next.questionIndex);questionRetryRequested=questionIndex.state==='error';
    const marks=new Map(next.marks.map(mark=>[mark.id,mark]));for(const [id,update]of recentMarks)if(update.version>markVersion)marks.set(id,update.mark);else recentMarks.delete(id);
    listing={...next,marks:[...marks.values()].sort(compareMoments),questions:questionIndex.state==='ready'?next.questions:listing.questions};if(questionIndex.state==='ready')acceptQuestionList(next);
    listingState='ready';launchRequired=false;if(status==='连接中…'||statusKind==='error'&&statusNeedsLaunch){status='';statusKind='';statusNeedsLaunch=false}cacheEpoch++;loaded.clear();markLoads.clear();readFailures.clear();render();scheduleQuestionPoll(true);
    try{await loadJobs({force:true});}catch(error){if(ticket===refreshEpoch)failed(error);}
  }
  async function revealMark(id){
    const session=sessionEpoch,intent=++locateEpoch,preview=previewEpoch;
    try{
      const data=await companion.library('mark',{id});if(!visible||session!==sessionEpoch)return;
      const mark={...data.mark,snapshots:data.snapshots.length,selections:data.snapshots.reduce((count,snapshot)=>count+snapshot.items.filter(item=>item.kind==='selection').length,0)};
      recentMarks.set(id,{mark,version:++markUpdateVersion});loaded.set(id,data);
      listing.marks=[...listing.marks.filter(value=>value.id!==id),mark].sort(compareMoments);
      const reveal=intent===locateEpoch&&preview===previewEpoch;
      if(reveal){rememberView();stopQuestionPolling();previewState=null;previewEpoch++;tab='marks';browseScope=recordScope(mark);for(const snapshot of momentSnapshots(data))collapsedMoments.delete(snapshot.id);}
      render(reveal?'moment-title:'+momentSnapshots(data)[0]?.id:undefined,!reveal);
      if(reveal)root.querySelector('[data-library-mark="'+id+'"]')?.scrollIntoView?.({block:'nearest'});
    }catch(error){if(visible&&session===sessionEpoch)failed(Object.assign(Error('标记已保存，暂时无法读取：'+error.message),{code:error.code,action:error.action}));}
  }
  async function revealQuestion(id){
    const session=sessionEpoch,intent=++locateEpoch,preview=previewEpoch;
    try{
      const data=await companion.library('question',{id});if(!visible||session!==sessionEpoch||intent!==locateEpoch||preview!==previewEpoch)return;
      rememberView();stopQuestionPolling();const focus=revealReviewedQuestion(data);render(focus,false);
      root.querySelector('[data-library-focus="question-title:'+id+'"]')?.scrollIntoView?.({block:'nearest'});
    }catch(error){if(visible&&session===sessionEpoch&&intent===locateEpoch)failed(Object.assign(Error('原草稿暂时无法读取：'+error.message),{code:error.code,action:error.action}));}
  }
  function refreshContext(){const next=JSON.stringify(currentContext());if(next===contextSignature)return;contextSignature=next;if(visible)render();}
  return {async open(){if(!visible){visible=true;sessionEpoch++;if(!busy&&!phase&&!jobs.size&&!statusKind)status='';}root.hidden=false;restoreScroll();await Promise.all([refresh(),selectionStore.load().catch(()=>{}),loadJobs().catch(error=>{if(visible)failed(error);})]);if(visible&&selectionStore.state().ready&&!busy)for(const job of [...jobs.values()].filter(value=>value.completed)){await deliver(job);if(!visible||busy)break;}},suspend,refresh,refreshContext,revealMark,revealQuestion,selection:()=>[...selected.values()],hasUnsaved:selectionStore.unsaved,protectSelection:selectionStore.protect,hasLocalRecovery:selectionStore.hasLocalRecovery,flush:selectionStore.flush,dispose(){suspend();eventView.removeEventListener?.('pointerdown',outsideManagement,true);eventView.removeEventListener?.('keydown',escapeManagement,true);eventView.removeEventListener?.('blur',blurManagement);selectionStore.dispose();}};
}
