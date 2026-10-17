import {captureDelivery,captureReceipt} from './capture-delivery.js';
import {studyLessonScope} from './study-context.js';

// Browser storage protects full pixels before the native library acknowledges
// them. A viewer replacement shares the same in-flight work; a new page reads
// only its own lesson. Native receipts remain the authority for saved material.
const slot='__ZJF_PENDING_CAPTURES_V1__';
export function captureOutbox(win=window){
  const copy=value=>value==null?null:JSON.parse(JSON.stringify(value));
  const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
  const savedError=()=>Error('存档回执不完整，原截图已保留，请重试保存。');
  const state=win[slot]&&Array.isArray(win[slot].pending)&&Array.isArray(win[slot].deliveries)?win[slot]:(win[slot]={pending:[],deliveries:[]});
  const active=state.active||(state.active=new Map());
  const recoveries=state.recoveries||(state.recoveries=new Map());
  const payloads=state.payloads||(state.payloads=new Map());
  const acknowledgements=state.acknowledgements||(state.acknowledgements=new Map());
  const staged=state.staged||(state.staged=[]),durable=state.durable||(state.durable=new Set()),writes=state.writes||(state.writes=new Map()),versions=state.versions||(state.versions=new Map()),retired=state.retired||(state.retired=new Set()),localLoads=state.localLoads||(state.localLoads=new Map());
  const persisted=state.persisted||(state.persisted=new Set(durable));
  const pendingReads=state.pendingReads||(state.pendingReads=new Map());
  const terminal=state.terminal||(state.terminal=new Set());
  const pixelChars=batch=>[...(batch?.context||[]),batch?.selection].filter(Boolean).reduce((sum,item)=>sum+(item.image?.length||0),0);
  function trimPendingPixels(keep=null,all=false){
    const cached=state.pending.filter(job=>!job.localPixels).sort((a,b)=>(a.lastRead||0)-(b.lastRead||0));let bytes=cached.reduce((sum,job)=>sum+pixelChars(job.request.batch)*2,0);
    for(const job of cached){if(!all&&bytes<=16*1024*1024)break;const id='capture:'+job.request.batch.id;if(job===keep||active.has(job.request.batch.id)||pendingReads.has(job.request.batch.id)||writes.has(id)||!durable.has(id))continue;
      if(!pixelChars(job.request.batch))continue;
      bytes-=pixelChars(job.request.batch)*2;job.request.batch={...job.request.batch,context:job.request.batch.context.map(item=>({...item,image:''})),selection:job.request.batch.selection?{...job.request.batch.selection,image:''}:null};job.localPixels=true;
    }
  }
  async function loadPending(job){
    if(!job.localPixels){job.lastRead=Date.now();return job.request.batch;}
    const id=job.request.batch.id;if(pendingReads.has(id))return pendingReads.get(id);const before=job.request.batch,version=versions.get('capture:'+id),issued=job.nativeIssued;
    const task=(async()=>{const row=await transact('readonly',store=>store.get('capture:'+id));
      if(job.request.batch!==before||!job.localPixels||versions.get('capture:'+id)!==version||job.nativeIssued!==issued||job.saved)return job.request.batch;
      if(row?.schema!==1||row.kind!=='capture'||row.job?.request?.batch?.id!==id||studyLessonScope(row.lessonKey)!==lesson(job))throw storageError();
      job.request.batch=copy(row.job.request.batch);delete job.localPixels;job.lastRead=Date.now();trimPendingPixels(job);return job.request.batch;
    })().finally(()=>pendingReads.delete(id));pendingReads.set(id,task);return task;
  }
  function trimPixels(keep=null){
    let bytes=0;const cached=state.deliveries.filter(job=>job.batch).sort((a,b)=>(a.lastRead||0)-(b.lastRead||0));
    const size=job=>[...job.batch.context,job.batch.selection].filter(Boolean).reduce((sum,item)=>sum+(item.image?.length||0)*2,0);
    for(const job of cached)bytes+=size(job);
    for(const job of cached){if(bytes<=16*1024*1024)break;if(job===keep||job===state.deliveryJob||payloads.has(job.id))continue;bytes-=size(job);job.batch=null;}
  }
  function releasePixels(){for(const job of state.deliveries)if(job!==state.deliveryJob&&!payloads.has(job.id))job.batch=null;trimPendingPixels(null,true);}
  const storageError=()=>Error('截图尚未完成暂存，请保留此页面；连接学习助手后可继续保存。');
  const records=()=>[...state.pending.map(job=>({id:'capture:'+job.request.batch.id,kind:'capture',lessonKey:lesson(job),job})),...staged.map(crop=>({id:'crop:'+crop.id,kind:'crop',lessonKey:studyLessonScope(crop.lessonKey),crop}))];
  const hasUnprotected=()=>records().some(record=>!durable.has(record.id));
  function database(){
    if(state.database)return state.database;
    const opening=new Promise((resolve,reject)=>{
      let request,settled=false;
      const timer=setTimeout(()=>finish(storageError()),4000);
      function finish(error,db){if(settled){db?.close();return;}settled=true;clearTimeout(timer);error?reject(error):resolve(db);}
      try{if(!win.indexedDB)throw storageError();request=win.indexedDB.open('zhiyun-focus-captures',1);}catch(error){finish(error);return;}
      request.onupgradeneeded=()=>{const store=request.result.createObjectStore('pending',{keyPath:'id'});store.createIndex('lessonKey','lessonKey');};
      request.onerror=()=>finish(request.error||storageError());request.onblocked=()=>finish(storageError());
      request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();state.database=null;};finish(null,db);};
    });
    state.database=opening;opening.catch(()=>{if(state.database===opening)state.database=null;});return opening;
  }
  async function transact(mode,operation){
    const db=await database();return new Promise((resolve,reject)=>{
      let transaction,result;
      try{transaction=db.transaction('pending',mode);const request=operation(transaction.objectStore('pending'));if(request)request.onsuccess=()=>{result=request.result;};}
      catch(error){reject(error);return;}
      transaction.oncomplete=()=>resolve(result);transaction.onabort=transaction.onerror=()=>reject(transaction.error||storageError());
    });
  }
  function write(record){
    const id=record.id,payload=copy({...record,schema:1}),previous=writes.get(id)||Promise.resolve(),version=(versions.get(id)||0)+1;versions.set(id,version);durable.delete(id);
    const task=previous.catch(()=>{}).then(()=>transact('readwrite',store=>store.put(payload))).then(()=>{persisted.add(id);if(!retired.has(id)&&versions.get(id)===version)durable.add(id);}).finally(()=>{if(writes.get(id)===task)writes.delete(id);trimPendingPixels(state.pending.find(job=>'capture:'+job.request.batch.id===id));});
    writes.set(id,task);task.catch(()=>{});return task;
  }
  function forget(id){
    retired.add(id);durable.delete(id);const previous=writes.get(id)||Promise.resolve();
    const task=previous.catch(()=>{}).then(()=>transact('readwrite',store=>store.delete(id))).then(()=>persisted.delete(id)).finally(()=>{if(writes.get(id)===task)writes.delete(id);});
    writes.set(id,task);task.catch(()=>{});
  }
  async function flush(){
    await Promise.allSettled(records().filter(record=>!durable.has(record.id)).map(record=>writes.get(record.id)||write(record)));
    if(hasUnprotected())throw storageError();
  }
  async function restoreLocal(lessonKey){
    if(!lessonKey)return [];
    lessonKey=studyLessonScope(lessonKey);
    if(localLoads.has(lessonKey))return localLoads.get(lessonKey);
    const task=(async()=>{
      const restored=[];
      const receive=record=>{
        if(record?.schema!==1||studyLessonScope(record.lessonKey)!==lessonKey||retired.has(record.id))return;
        if(record.kind==='capture'&&uuid(record.job?.request?.batch?.id)&&record.id==='capture:'+record.job.request.batch.id&&lesson(record.job)===lessonKey){
          if(!state.pending.some(job=>job.request.batch.id===record.job.request.batch.id)&&!state.deliveries.some(job=>(job.id||job.batch?.id)===record.job.request.batch.id)){
            const job=copy(record.job);job.restored=true;
            // Older records did not distinguish an unissued request from a
            // lost native acknowledgement. Keep their original payload fixed.
            job.nativeIssued=job.nativeIssued!==false;
            state.pending.push(job);restored.push(job);durable.add(record.id);persisted.add(record.id);
          }
        }else if(record.kind==='crop'&&uuid(record.crop?.id)&&record.id==='crop:'+record.crop.id&&studyLessonScope(record.crop.lessonKey)===lessonKey&&record.crop.preview?.batch&&record.crop.area&&record.crop.image){
          state.cropIssuedAt=Math.max(state.cropIssuedAt||0,Date.parse(record.crop.createdAt)||0);
          const previous=staged.find(crop=>crop.sourceSnapshotId===record.crop.sourceSnapshotId&&crop.sourceItemId===record.crop.sourceItemId);
          if(!previous)staged.push(copy(record.crop));else if((record.crop.createdAt||'')>(previous.createdAt||'')){unstage(previous.id);staged.push(copy(record.crop));}else if(previous.id!==record.crop.id)forget(record.id);
          if(!retired.has(record.id)){durable.add(record.id);persisted.add(record.id);}
        }
        trimPendingPixels();
      };
      const scan=range=>transact('readonly',store=>{const index=store.index('lessonKey');if(typeof index.openCursor==='function'){const request=index.openCursor(range);request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;try{receive(cursor.value);cursor.continue();}catch{store.transaction.abort();}};}else{const request=index.getAll(range);request.onsuccess=()=>{for(const row of request.result||[])receive(row);};}return null;});
      await scan(lessonKey);if(/^__zjf_layout_v1:\d+:\d+:\d+$/.test(lessonKey)&&win.IDBKeyRange)await scan(win.IDBKeyRange.bound(lessonKey+':',lessonKey+':\uffff'));
      state.pending.sort(compare);restored.sort(compare);return restored;
    })().finally(()=>localLoads.delete(lessonKey));localLoads.set(lessonKey,task);return task;
  }
  function unstage(id){const index=staged.findIndex(crop=>crop.id===id);if(index>=0){staged.splice(index,1);forget('crop:'+id);}}
  function stage(crop){
    if(!uuid(crop?.id)||!crop.lessonKey||!crop.preview?.batch||!crop.area||!crop.image)throw Error('圈选来源不完整。');
    const latest=Math.max(0,...staged.map(value=>Date.parse(value.createdAt||'')).filter(Number.isFinite));
    for(const old of [...staged])if(old.sourceSnapshotId===crop.sourceSnapshotId&&old.sourceItemId===crop.sourceItemId)unstage(old.id);
    state.cropIssuedAt=Math.max(Date.now(),Math.max(state.cropIssuedAt||0,latest)+1);
    const value=copy({...crop,createdAt:new Date(state.cropIssuedAt).toISOString()});staged.push(value);write({id:'crop:'+value.id,kind:'crop',lessonKey:studyLessonScope(value.lessonKey),crop:value});return value;
  }
  // Issuance precedes save acceptance; saves and recovery may complete later.
  const issued=value=>Date.parse(value.createdAt||value.request?.retry?.issuedAt||'');
  const compare=(a,b)=>{
    const left=issued(a),right=issued(b);
    if(Number.isFinite(left)!==Number.isFinite(right))return Number.isFinite(left)?1:-1;
    if(Number.isFinite(left)&&Number.isFinite(right)&&left!==right)return left-right;
    return (a.order||0)-(b.order||0);
  };
  const lesson=job=>studyLessonScope(job.lessonKey||job.batch?.lessonKey||job.request?.batch?.lessonKey);
  const sameStream=(a,b)=>{
    const left=a.target?.conversationId,right=b.target?.conversationId;
    if(lesson(a)!==lesson(b))return false;if(!left&&!right)return true;if(!left||!right||left!==right||!['route','pageId','documentEpoch','routeGeneration'].every(key=>a.target[key]===b.target[key]))return false;
    if(a.target.draftId&&b.target.draftId)return a.target.draftId===b.target.draftId;
    return a.target.composerGeneration===b.target.composerGeneration;
  };
  function retryMetadata(job){
    if(!job.request.retry){
      const latest=Math.max(0,...state.pending.map(issued).filter(Number.isFinite),...state.deliveries.map(issued).filter(Number.isFinite));
      state.issuedAt=Math.max(Date.now(),(state.issuedAt||latest)+1);
      job.request.retry={schema:1,destination:job.destination,target:job.target?copy(job.target):null,issuedAt:new Date(state.issuedAt).toISOString(),sequence:state.sequence=(state.sequence||0)+1,operationId:crypto.randomUUID()};
    }
    return job.request.retry;
  }
  function add(request,{destination='direct',target=null,operationId=null,issuedAt=null,sequence=null}={}){
    if(!uuid(request?.batch?.id)||!['direct','later'].includes(destination))throw Error('截图存档请求无效。');
    const existing=state.pending.find(x=>x.request.batch.id===request.batch.id);if(existing)return existing;
    const job={request:copy(request),destination,target:target?copy(target):null,nativeIssued:false};retryMetadata(job);if(operationId!==null){if(!uuid(operationId))throw Error('截图操作身份无效。');job.request.retry.operationId=operationId;}if(issuedAt&&Number.isFinite(Date.parse(issuedAt)))job.request.retry.issuedAt=issuedAt;if(Number.isSafeInteger(sequence)&&sequence>0)job.request.retry.sequence=sequence;state.pending.push(job);write({id:'capture:'+request.batch.id,kind:'capture',lessonKey:lesson(job),job});return job;
  }
  function finishAcquisition(job,batch,{destination=job.destination}={}){
    // A verified visible crop can protect the user's work while its full source
    // frame decodes. Payload enrichment stops permanently at the first native
    // save attempt, so retries can never change an issued snapshot's meaning.
    if(!state.pending.includes(job)||job.nativeIssued||job.saved||active.has(job.request.batch.id)||batch.id!==job.request.batch.id||studyLessonScope(batch.lessonKey)!==lesson(job))throw Error('截图已开始存档，不能更改原材料。');
    job.request.batch=copy(batch);job.destination=destination;job.request.retry.destination=destination;
    delete job.localPixels;
    delete job.request.acquisition;
    const id='capture:'+batch.id;durable.delete(id);write({id,kind:'capture',lessonKey:lesson(job),job});return job;
  }
  function associate(batch,mark,contextKey){
    // Older helpers do not prove equivalent backgrounds; keep each snapshot
    // independent rather than treating a whole mark as one unchanging frame.
    contextKey=/^context:[a-f0-9]{64}$/.test(contextKey||'')?contextKey:'snapshot:'+batch.id;
    Object.assign(batch,{markId:mark.id,markTitle:mark.title,contextKey});
    for(const item of [...batch.context,batch.selection].filter(Boolean)){
      const sourceSnapshot=item===batch.selection&&batch.contextFor?batch.contextFor:batch.id;
      Object.assign(item,{markId:mark.id,markTitle:mark.title,contextKey,snapshotId:sourceSnapshot,ref:{markId:mark.id,snapshotId:sourceSnapshot,itemId:item.id},...batch.missingContext?.length?{missingContext:copy(batch.missingContext)}:{}});
    }
  }
  async function save(job,library){
    if(job.saved)return job.saved;
    const id=job.request.batch.id;if(active.has(id))return active.get(id);
    const retry=retryMetadata(job);let checkpointError=null;
    // Store issuance before the native side effect. If browser storage fails,
    // the native library can still protect the same fixed pixels. A failed
    // native save then retains the explicit unsaved/unprotected state.
    const task=Promise.resolve().then(async()=>{
      if(job.localPixels)await loadPending(job);else job.lastRead=Date.now();
      if(!job.nativeIssued&&job.request.markSourceSnapshotId&&!job.request.markId){
        const sourceId=job.request.markSourceSnapshotId;if(!uuid(sourceId)||sourceId===id)throw Error('标记来源尚未核对，截图已保留。');
        // Restored dependency records are not a trusted graph. A cycle would
        // otherwise make two active saves await each other indefinitely.
        const visited=new Set([id]);let parent=job;
        while(parent&&!parent.nativeIssued&&!parent.request.markId&&parent.request.markSourceSnapshotId){const source=parent.request.markSourceSnapshotId;if(!uuid(source)||visited.has(source))throw Error('标记来源顺序尚未核对，截图已保留。');visited.add(source);parent=state.pending.find(value=>value.request.batch.id===source);if(parent&&lesson(parent)!==lesson(job))throw Error('先前标记属于另一节课，截图已保留。');}
        const previous=state.pending.find(value=>value.request.batch.id===sourceId),source=previous?await save(previous,library):await library('capture',{id:sourceId,lightweight:true});
        if(!uuid(source?.mark?.id)||studyLessonScope(source.mark.lessonKey)!==lesson(job))throw Error('先前标记尚未保存，后续截图已保留。');
        job.request.markId=source.mark.id;
      }
      const previouslyIssued=job.nativeIssued===true;job.nativeIssued=true;const request=copy(job.request),checkpoint=win.indexedDB?write({id:'capture:'+id,kind:'capture',lessonKey:lesson(job),job}):null;checkpointError=checkpoint?null:storageError();
      if(checkpoint)try{await checkpoint;}catch(error){checkpointError=error;}
      if(checkpointError&&!previouslyIssued&&persisted.has('capture:'+id)){
        // The older unissued row may be the only durable copy of these pixels.
        // Keep it and defer the native side effect until issuance can be saved;
        // recovery may then safely complete this still-unissued acquisition.
        job.nativeIssued=false;throw storageError();
      }
      return library('save',request);
    }).catch(error=>{
      if(checkpointError)throw Object.assign(Error(error.message+' 截图暂存尚未完成，请保留此页面。'),{code:error.code,action:error.action,cause:error});
      throw error;
    }).then(saved=>{
      if(!uuid(saved?.mark?.id)||saved.snapshotId!==id)throw savedError();
      if(job.destination==='direct'&&(!job.request.markOnly||job.request.contextFor)){const receipt=saved.captureReceipt;if(!receipt||receipt.id!==id||receipt.snapshotId!==id||receipt.operationId!==retry.operationId||!['ready','completed'].includes(receipt.state))throw savedError();}
      associate(job.request.batch,saved.mark,saved.contextKey);job.saved=saved;
      const index=state.pending.indexOf(job);if(index>=0)state.pending.splice(index,1);
      forget('capture:'+id);
      return saved;
    }).finally(()=>active.delete(id));active.set(id,task);return task;
  }
  function enqueueDelivery(job){
    if(!job.saved||terminal.has(job.request.batch.id)||job.request.markOnly&&!job.request.contextFor||job.destination!=='direct'||job.saved.captureReceipt?.state==='completed'||job.saved.captureReceipt?.dismissed)return;
    const receipt=job.saved.captureReceipt;
    if(!state.deliveries.some(x=>(x.id||x.batch?.id)===job.request.batch.id)){const entry={id:job.request.batch.id,lessonKey:job.request.batch.lessonKey,batch:job.saved.assetBacked?null:job.request.batch,assetBacked:!!job.saved.assetBacked,acquisition:copy(job.request.acquisition),layout:copy(job.request.layout),sourcePage:job.request.sourcePage,lastRead:Date.now(),target:copy(receipt?.target||job.target),operationId:receipt?.operationId||retryMetadata(job).operationId,delivery:receipt?.delivery?copy(receipt.delivery):null,order:receipt?.order||0,createdAt:receipt?.createdAt||retryMetadata(job).issuedAt,restored:!!job.restored,requiresReview:!!(job.restored||job.requiresReview||job.request.batch.contextComplete===false)};state.deliveries.push(entry);trimPixels(entry);}
  }
  async function recover(library,lessonKey){
    if(typeof lessonKey!=='string'||!lessonKey)return [];
    lessonKey=studyLessonScope(lessonKey);
    if(recoveries.has(lessonKey))return recoveries.get(lessonKey);
    const known=new Set(state.deliveries.filter(job=>lesson(job)===lessonKey).map(job=>job.id));
    const task=Promise.resolve().then(()=>library('capture-list',{lessonKey})).then(result=>{
      if(result?.schema!==1||!Array.isArray(result.jobs))throw Error('待附图记录尚未读取完成，请稍后重试；原资料已保留。');
      const jobs=result.jobs.filter(x=>studyLessonScope(x?.lessonKey)===lessonKey&&!terminal.has(x.id));
      if(jobs.some(x=>!uuid(x.id)||x.snapshotId!==x.id||!uuid(x.operationId)||x.state!=='ready'||!Number.isSafeInteger(x.order)||x.order<1))throw Error('待附图记录不完整，请从资料中查看原截图。');
      const restored=[];
      const ready=new Set(jobs.map(job=>job.id));for(const job of [...state.deliveries])if(known.has(job.id)&&!ready.has(job.id)&&job!==state.deliveryJob){terminal.add(job.id);remove(job);}
      for(const item of jobs.sort(compare)){
        if(state.pending.some(x=>x.request.batch.id===item.id)||state.deliveries.some(x=>(x.id||x.batch?.id)===item.id))continue;
        const job={...copy(item),batch:null,delivery:item.delivery?copy(item.delivery):null,restored:true,requiresReview:true};state.deliveries.push(job);restored.push(job);
      }
      return restored;
    }).finally(()=>recoveries.delete(lessonKey));recoveries.set(lessonKey,task);return task;
  }
  const remove=job=>{const index=state.deliveries.indexOf(job);if(index>=0)state.deliveries.splice(index,1);};
  const retireLocal=job=>{terminal.add(job.id||job.batch?.id);remove(job);};
  function replaceContext(job,savedJob){const id=job.id||job.batch?.id;if(!savedJob.saved||savedJob.request.contextFor!==id)throw Error('背景补充的来源尚未确认。');if(terminal.has(id))return null;enqueueDelivery(savedJob);retireLocal(job);return state.deliveries.find(entry=>entry.id===savedJob.request.batch.id)||null;}
  async function load(job,library){
    if(terminal.has(job.id||job.batch?.id))return null;
    if(job.batch){job.lastRead=Date.now();trimPixels(job);return job.batch;}
    if(payloads.has(job.id))return payloads.get(job.id);
    const task=Promise.resolve().then(()=>library('capture',{id:job.id,...job.assetBacked?{lightweight:true}:{}})).then(async result=>{
      if(terminal.has(job.id))return null;const batch=result?.batch,receipt=result?.captureReceipt;
      if(result?.snapshotId!==job.id||batch?.id!==job.id||studyLessonScope(batch.lessonKey)!==lesson(job)||!Array.isArray(batch.context)||!batch.selection||!uuid(result?.mark?.id)||!receipt||receipt.id!==job.id||receipt.operationId!==job.operationId)throw Error('原截图或投递记录尚未完整恢复，资料已保留，请稍后重试。');
      if(receipt.state==='completed'||receipt.dismissed){terminal.add(job.id);remove(job);return null;}
      job.acquisition=copy(result.acquisition)||job.acquisition;job.layout=copy(result.layout)||job.layout;job.sourcePage=result.sourcePage||job.sourcePage;
      if(batch.storedCapture){const reference=batch.selection.ref||{snapshotId:job.id,itemId:batch.selection.id};const image=await library('image',reference);if(terminal.has(job.id))return null;if(typeof image?.image!=='string'||!image.image.startsWith('data:image/png;base64,'))throw Error('原圈选图尚未读取完整，原记录仍保留。');batch.selection.image=image.image;}
      if(receipt.state!=='ready'||[...batch.context,batch.selection].some(x=>typeof x?.image!=='string'||!x.image&&!batch.storedCapture))throw Error('原始图片尚未读取完整，资料已保留，请稍后重试。');
      associate(batch,result.mark,batch.contextKey);job.batch=batch;job.lastRead=Date.now();trimPixels(job);job.target=copy(receipt.target);job.delivery=receipt.delivery?copy(receipt.delivery):job.delivery;return batch;
    }).finally(()=>payloads.delete(job.id));payloads.set(job.id,task);return task;
  }
  async function complete(job,receipt,library){
    if(!job.delivery||captureReceipt(receipt,job.delivery)!=='complete')throw Error('本次附图仍未确认，待办记录已保留。');
    const id=job.id||job.batch?.id;job.receipt=copy(receipt);
    if(acknowledgements.has(id))return acknowledgements.get(id);
    const task=Promise.resolve().then(()=>library('capture-ack',{id,operationId:job.delivery.operationId,attemptId:job.delivery.attemptId,target:job.delivery.target,receipt:job.receipt})).then(reply=>{
      if(reply?.requiresVerification===true&&reply.id===id){delete job.receipt;throw Object.assign(Error('先前操作回执已过期，请重试以重新核对当前草稿；材料已保留。'),{code:'capture_receipt_expired'});}
      if(reply?.completed!==true||reply.id!==id)throw Error((receipt.state==='removed'?'移除':'附图')+'已确认，待办记录尚未完成保存，请重试确认。');terminal.add(id);remove(job);return receipt;
    }).finally(()=>acknowledgements.delete(id));acknowledgements.set(id,task);return task;
  }
  async function dismiss(job,library){
    const id=job.id||job.batch?.id,result=await library('capture-dismiss',{id,operationId:job.operationId});
    if(result?.id!==id||result.operationId!==job.operationId||result.dismissed!==true)throw Error('截图已保存，停止待附图的操作尚未确认。');
    terminal.add(id);remove(job);
  }
  async function reconcile(job,library){
    const id=job.id||job.batch?.id,result=await library('capture-reconcile',{id,operationId:job.operationId});
    if(result?.id!==id||result.operationId!==job.operationId)throw Error('原附图记录尚未核对，材料已保留。');
    if(result.completed===true||result.dismissed===true){retireLocal(job);return result;}return null;
  }
  async function prepare(job,currentTarget,library,{explicit=false}={}){
    if(terminal.has(job.id||job.batch?.id))return null;
    state.deliveryJob=job;
    if(job.requiresReview&&!explicit)throw Error('有上次保留的待附图，请确认目标对话后点重试。');
    if(job.receipt){await complete(job,job.receipt,library);return null;}
    const batch=await load(job,library);if(!batch||terminal.has(job.id||batch.id))return null;
    if(currentTarget?.draftId&&job.delivery&&!job.target?.draftId){if(await reconcile(job,library))return null;job.requiresReview=true;throw Object.assign(Error('原附图任务的问题身份尚未核定，原图已保留；请从学习记录重新选取。'),{code:'conversation_changed'});}
    const reconciling=job.delivery&&(job.delivery.reconcileOnly||job.delivery.target.conversationId.startsWith('provisional:')&&currentTarget?.conversationId.startsWith('c:'));
    if(!reconciling&&job.target?.draftId&&currentTarget?.draftId&&job.target.draftId!==currentTarget.draftId){if(await reconcile(job,library))return null;job.requiresReview=true;throw Object.assign(Error('原提问已切换，原图已保留；请从学习记录选择新的提问。'),{code:'conversation_changed'});}
    const sameQuestion=job.target?.draftId&&job.target.draftId===currentTarget?.draftId&&['conversationId','route','pageId','documentEpoch','routeGeneration'].every(key=>job.target[key]===currentTarget[key])&&currentTarget.composerGeneration>=job.target.composerGeneration;
    if(!explicit&&!job.delivery&&job.target&&!sameQuestion&&['conversationId','route','pageId','documentEpoch','routeGeneration','composerGeneration'].some(key=>job.target[key]!==currentTarget?.[key])){job.requiresReview=true;throw Object.assign(Error('原问题已切换，截图保留在学习记录中。'),{code:'conversation_changed'});}
    const previous=job.delivery||{materialId:batch.id,operationId:job.operationId||crypto.randomUUID(),target:job.target||currentTarget};
    let delivery;try{delivery=captureDelivery(batch.id,currentTarget,previous);}catch(error){if(error.code==='conversation_changed')job.requiresReview=true;throw error;}
    if(currentTarget?.draftId&&!reconciling){
      let saved;try{saved=await library('capture-checkpoint',{id:batch.id,delivery,draftId:currentTarget.draftId});}catch(error){if(['capture_dismissed','capture_superseded'].includes(error.code)){retireLocal(job);return null;}throw error;}
      if(terminal.has(job.id||batch.id))return null;
      if(saved?.id!==batch.id||saved.operationId!==delivery.operationId||saved.target?.draftId!==currentTarget.draftId)throw Error('原问题的附图目标尚未保存，材料已保留。');
      job.target=copy(saved.target);
    }
    job.operationId=delivery.operationId;job.delivery=delivery;job.requiresReview=false;
    return {batch,delivery};
  }
  function next({explicit=false,lessonKey=''}={}){
    const job=state.deliveries.filter(x=>(!lessonKey||lesson(x)===studyLessonScope(lessonKey))&&(explicit||!x.requiresReview)).sort(compare)[0];
    if(!job)return null;
    const earlier=!job.receipt&&state.pending.find(x=>(x.destination==='direct'||x.request.acquisition?.destination==='direct')&&!x.request.markOnly&&sameStream(x,job)&&compare(x,job)<0);
    if(earlier)throw Object.assign(Error('较早截图未保存，请先重试保存。'),{code:earlier.request.acquisition&&!earlier.nativeIssued?'capture_acquiring':'capture_save_pending'});
    return job;
  }
  function claimDelivery(){
    if(state.deliveryOwner)return null;const owner=crypto.randomUUID();state.deliveryOwner=owner;
    return ()=>{if(state.deliveryOwner===owner){state.deliveryOwner=null;state.deliveryJob=null;trimPixels();}};
  }
  return {pending:state.pending,deliveries:state.deliveries,staged,stage,unstage,restoreLocal,flush,hasUnprotected,releasePixels,loadPending,add,finishAcquisition,save,enqueueDelivery,replaceContext,recover,load,prepare,complete,dismiss,reconcile,retireLocal,next,claimDelivery};
}
