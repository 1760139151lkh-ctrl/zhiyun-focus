const copy=value=>JSON.parse(JSON.stringify(value));
const encode=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const same=(a,b)=>encode(a)===encode(b);
const refKey=reference=>reference.snapshotId+'/'+reference.itemId;
const intentTime=value=>Number(value?.intentAt)||0;

// Merge against the revision each window actually saw. Unchanged choices follow
// the other window, including a clear; a reorder does not renew authorization.
export function mergeLibraryChoices(base,local,remote){
  const order=(before,left,right,keys)=>{
    const changed=values=>!same(values.filter(key=>before.includes(key)),before.filter(key=>values.includes(key)));
    const primary=changed(left)||!changed(right)?left:right,secondary=primary===left?right:left,result=primary.filter(key=>keys.has(key));
    for(let index=0;index<secondary.length;index++){
      const key=secondary[index];if(!keys.has(key)||result.includes(key))continue;
      const preceding=secondary.slice(0,index).reverse().find(value=>result.includes(value)),following=secondary.slice(index+1).find(value=>result.includes(value));
      result.splice(preceding?result.indexOf(preceding)+1:following?result.indexOf(following):result.length,0,key);
    }
    return result;
  };
  const choose=(before,left,right,time=intentTime)=>{
    if(same(left,before))return right;if(same(right,before))return left;
    if(!left)return right&&time(right)>time(before)?right:null;
    if(!right)return time(left)>time(before)?left:null;
    return time(right)>time(left)?right:left;
  };
  const entries=choice=>new Map(choice.refs.map(reference=>{const intent=choice.restoreRefs.find(value=>refKey(value)===refKey(reference));return [refKey(reference),{reference,intent:intent?{intentId:intent.intentId,intentAt:intent.intentAt}:null}]}));
  const b=entries(base),l=entries(local),r=entries(remote),refs=new Map();
  for(const key of new Set([...b.keys(),...l.keys(),...r.keys()])){const value=choose(b.get(key),l.get(key),r.get(key),entry=>intentTime(entry?.intent));if(value)refs.set(key,value);}
  const refOrder=order([...b.keys()],[...l.keys()],[...r.keys()],new Set(refs.keys()));
  const questions=choice=>new Map(choice.questions.map(question=>[question.questionId,question])),bq=questions(base),lq=questions(local),rq=questions(remote),mergedQuestions=new Map();
  const partIntent=(question,id)=>question?.restorePartIntents?.find(value=>value.itemId===id)||(question?.restoreIntentId?{intentId:question.restoreIntentId,intentAt:question.restoreIntentAt}:null);
  const additional=question=>question?.additionalItemIds||[],whole=question=>question&&!question.itemIds.length&&!question.retainSupplementaryText?{intentId:question.restoreIntentId,intentAt:question.restoreIntentAt}:undefined;
  const supplementary=question=>question?.retainSupplementaryText?{intentId:question.restoreIntentId,intentAt:question.restoreIntentAt}:undefined;
  const newest=(left,right)=>!left?right:!right?left:(right.sourceRevision||0)>(left.sourceRevision||0)||right.sourceUpdatedAt>left.sourceUpdatedAt?right:left;
  const listed=question=>[...(question?.itemIds||[]),...additional(question)];
  const partEntry=(question,itemId,implicit=false)=>question&&(question.itemIds.includes(itemId)||additional(question).includes(itemId)||whole(question)&&implicit)?{itemId,...partIntent(question,itemId)}:undefined;
  for(const id of new Set([...bq.keys(),...lq.keys(),...rq.keys()])){
    const before=bq.get(id),left=lq.get(id),right=rq.get(id);let value;
    if(same(left,before))value=right;
    else if(same(right,before))value=left;
    else{
      const wholeIntent=choose(whole(before),whole(left),whole(right)),ids=new Set([...listed(before),...listed(left),...listed(right)]),parts=new Map();
      if(wholeIntent){
        // Preserve the whole record's text and extra. Only independently
        // selected parts can extend its default set, each with its own intent.
        const fresh=(question,itemId)=>question?.itemIds.includes(itemId)&&(!before||before.itemIds.length&&!before.itemIds.includes(itemId)||intentTime(partIntent(question,itemId))>intentTime(partIntent(before,itemId)));
        for(const itemId of ids){
          const old=whole(before)&&additional(before).includes(itemId)?partEntry(before,itemId):undefined;
          const entry=question=>additional(question).includes(itemId)||fresh(question,itemId)?partEntry(question,itemId):undefined;
          const selected=choose(old,entry(left),entry(right));if(selected?.intentId)parts.set(itemId,selected);
        }
        const source=same(whole(left),wholeIntent)?same(whole(right),wholeIntent)?newest(left,right):left:right;
        const itemIds=order(additional(before),listed(left),listed(right),new Set(parts.keys()));
        value={...source,itemIds:[],additionalItemIds:itemIds,restorePartIntents:itemIds.map(itemId=>parts.get(itemId))};delete value.retainSupplementaryText;
      }else{
        for(const itemId of ids){
          const oldIntent=partIntent(before,itemId),leftIntent=partIntent(left,itemId),rightIntent=partIntent(right,itemId);
          // A whole-question selection has an implicit default. A subsequently
          // explicit part is an addition, even if that old default excluded it.
          const implicit=whole(before)&&!additional(before).includes(itemId)&&Math.max(intentTime(leftIntent),intentTime(rightIntent))<=intentTime(oldIntent);
          const selected=choose(partEntry(before,itemId,implicit),partEntry(left,itemId,implicit),partEntry(right,itemId,implicit));
          if(selected)parts.set(itemId,selected);
        }
        const retained=supplementary(before),supplement=choose(retained,supplementary(left),supplementary(right));
        if(parts.size||supplement){
          const latest=newest(left,right);
          value={...latest,itemIds:order(listed(before),listed(left),listed(right),new Set(parts.keys())),restorePartIntents:[...parts.values()].filter(part=>part.intentId)};
          delete value.additionalItemIds;
          if(supplement){value.retainSupplementaryText=true;value.restoreIntentId=supplement.intentId;value.restoreIntentAt=supplement.intentAt;}else delete value.retainSupplementaryText;
        }
      }
    }
    if(value)mergedQuestions.set(id,value);
  }
  return copy({refs:refOrder.map(key=>refs.get(key).reference),restoreRefs:refOrder.flatMap(key=>{const entry=refs.get(key);return entry.intent?[{...entry.reference,...entry.intent}]:[]}),questions:order([...bq.keys()],[...lq.keys()],[...rq.keys()],new Set(mergedQuestions.keys())).map(id=>mergedQuestions.get(id)),...Object.fromEntries(['target','background','questionImages'].map(key=>[key,same(local[key],base[key])?remote[key]:local[key]]))});
}

// Native storage owns unfinished choices. Immutable write receipts distinguish
// an uncertain old success from a later clear in another window.
export function createLibrarySelectionStore({scope,companion,readChoice,applyChoice,changed,win=globalThis}){
  let ready=!scope,revision=0,baseChoice=null,saved='',pending=null,loading=null,writing=null,error='',conflict=null,disposed=false,failedChoice='';
  const initialChoice=copy(readChoice()),owner=crypto.randomUUID(),prefix='__zjf_library_choice_pending_v1:'+encodeURIComponent(scope)+':',journalKey=prefix+owner;
  const owners=win.__ZJF_LIBRARY_SELECTION_OWNERS_V1__||(win.__ZJF_LIBRARY_SELECTION_OWNERS_V1__=new Map());if(scope)owners.set(scope,owner);
  let journalText='',journalChoice='',journalNativeId='',journalRevision=-1,journalVersion=0,journalProtectedVersion=0,journalConfirmedVersion=0,journalError='',recoveryError='';
  const current=()=>!disposed&&(!scope||owners.get(scope)===owner);
  const encoded=()=>encode(readChoice());
  const unsaved=()=>!!scope&&(ready?!!pending||encoded()!==saved:encoded()!==encode(initialChoice));
  const notify=()=>{if(current())changed()};
  function clearJournal({acknowledged=false}={}){
    if(!scope||!current()||!journalText)return;
    try{if(win.localStorage?.getItem(journalKey)===journalText){win.localStorage.removeItem(journalKey);if(acknowledged)journalConfirmedVersion=journalProtectedVersion;}journalText='';journalChoice='';journalNativeId='';journalRevision=-1;journalError='';}catch(failure){journalError=failure.message||'选材暂存尚未清理';}
  }
  function protect(){
    if(!scope)return true;if(!current())return false;if(!unsaved()){clearJournal({acknowledged:ready&&revision>journalRevision});return true;}
    try{
      const storage=win.localStorage;if(!storage)throw Error('本页暂存不可用');
      const choice=copy(readChoice()),choiceKey=encode(choice),nativeId=pending?.writeId||'';if(journalText&&journalChoice===choiceKey&&journalNativeId===nativeId&&journalRevision===revision&&storage.getItem(journalKey)===journalText)return true;
      const record={schema:1,scope,owner,version:++journalVersion,updatedAt:Date.now(),revision,baseChoice:copy(baseChoice||initialChoice),choice,pending:pending?copy(pending):null},text=JSON.stringify(record);
      storage.setItem(journalKey,text);if(storage.getItem(journalKey)!==text)throw Error('本页暂存尚未确认');
      journalText=text;journalChoice=choiceKey;journalNativeId=nativeId;journalRevision=revision;journalProtectedVersion=record.version;journalError='';return true;
    }catch(failure){journalError=failure.message||'本页暂存不可用';return false;}
  }
  function recoveryJournals(){
    const records=[];try{const storage=win.localStorage;if(!storage)return records;for(let index=0;index<storage.length;index++){
      const key=storage.key(index);if(!key?.startsWith(prefix))continue;const text=storage.getItem(key);let record;try{record=JSON.parse(text);}catch{recoveryError='先前的选材暂存尚未读取';continue;}
      if(record?.schema!==1||record.scope!==scope||!Number.isSafeInteger(record.revision)||record.revision<0||!Array.isArray(record.choice?.refs)||!Array.isArray(record.choice?.questions)||!Array.isArray(record.baseChoice?.refs)||!Array.isArray(record.baseChoice?.questions)){recoveryError='先前的选材暂存尚未核对';continue;}
      records.push({key,text,record});
    }}catch(failure){recoveryError=failure.message||'先前的选材暂存尚未读取';}return records.sort((a,b)=>(a.record.updatedAt||0)-(b.record.updatedAt||0)||a.key.localeCompare(b.key));
  }
  function retireJournals(records){
    if(!current()||unsaved())return;try{const storage=win.localStorage;for(const {key,text}of records)if(key!==journalKey&&storage?.getItem(key)===text)storage.removeItem(key);}catch(failure){journalError=failure.message||'先前的选材暂存尚未清理';}
  }
  const pause=ms=>new Promise(resolve=>typeof win.setTimeout==='function'?win.setTimeout(resolve,ms):setTimeout(resolve,ms));
  async function retry(operation){let failure;for(let attempt=0;attempt<3;attempt++){try{return await operation()}catch(error){failure=error;if(['companion_upgrade','companion_unauthorized','library_invalid'].includes(error.code)||attempt===2)break;await pause(400*2**attempt);}}throw failure;}
  function accept(record,choice=record.choice){revision=record.revision||0;baseChoice=copy(record.choice);saved=encode(baseChoice);pending=null;conflict=null;error='';failedChoice='';applyChoice(choice);ready=true;}
  async function load(){
    if(ready){if(unsaved())return flush();return;}if(loading)return loading;
    const before=copy(readChoice()),journals=recoveryJournals();error='';loading=(async()=>{try{
      let record=await retry(()=>companion.library('selection',{scope})),choice=record.choice;if(!current())return;
      for(const journal of journals){
        const retained=journal.record,issued=retained.pending;let recoveryBase=retained.baseChoice;
        if(issued){
          if(issued.scope!==scope||!Number.isSafeInteger(issued.baseRevision)||issued.baseRevision<0||typeof issued.writeId!=='string'||!Array.isArray(issued.choice?.refs)||!Array.isArray(issued.choice?.questions))throw Error('先前的选材写入身份尚未核对');
          const result=await retry(()=>companion.library('selection-save',{scope,baseRevision:issued.baseRevision,writeId:issued.writeId,choice:issued.choice}));if(!current())return;
          const next=result.conflict?result.record:{revision:result.revision,choice:issued.choice};choice=mergeLibraryChoices(record.choice,choice,next.choice);record=next;recoveryBase=!result.conflict||result.accepted===true?issued.choice:issued.baseChoice||retained.baseChoice;
        }
        choice=mergeLibraryChoices(recoveryBase,retained.choice,choice);
      }
      const local=readChoice();accept(record,same(local,before)?choice:mergeLibraryChoices(before,local,choice));protect();notify();
      if(unsaved())await flush();if(current())retireJournals(journals);
    }catch(failure){error='勾选恢复失败：'+failure.message;protect();notify();throw failure}finally{loading=null}})();return loading;
  }
  async function flush(){
    if(!scope||!current())return;if(!ready)await load();if(!current())return;if(writing)return writing;
    error='';failedChoice='';if(!unsaved())return;
    writing=(async()=>{
      let conflicts=0;
      try{while(current()&&unsaved()){
        if(!pending){const choice=copy(readChoice());pending={scope,baseRevision:revision,writeId:crypto.randomUUID(),choice,baseChoice:copy(baseChoice),encoded:encode(choice)};}
        protect();
        const result=await retry(()=>companion.library('selection-save',{scope:pending.scope,baseRevision:pending.baseRevision,writeId:pending.writeId,choice:pending.choice}));
        if(!current())return;
        if(result.conflict){
          conflict=result.record;const merged=mergeLibraryChoices(result.accepted===true?pending.choice:pending.baseChoice,readChoice(),result.record.choice);accept(result.record,merged);protect();notify();
          if(++conflicts>=4&&unsaved())throw Error('勾选正在另一窗口更新，本页改动已保留。');
          continue;
        }
        revision=result.revision;baseChoice=pending.choice;saved=pending.encoded;pending=null;protect();
      }if(current()){error='';clearJournal({acknowledged:true});notify();}
      }catch(failure){if(current()){error='勾选尚未保存：'+failure.message;failedChoice=encoded();protect();notify();}throw failure}
      finally{writing=null;}
    })();return writing;
  }
  function sync(){if(!current())return;protect();if(ready&&unsaved()&&!writing&&(!error||encoded()!==failedChoice))void flush().catch(()=>{})}
  const resume=()=>{if(current())void (ready?unsaved()?flush():Promise.resolve():load()).catch(()=>{})};
  const checkpoint=()=>{if(unsaved())protect();};
  const hasLocalRecovery=()=>{try{return current()&&!!journalText&&journalChoice===encoded()&&win.localStorage?.getItem(journalKey)===journalText;}catch(failure){journalError=failure.message||'本页暂存尚未核对';return false;}};
  if(scope){win.addEventListener?.('pagehide',checkpoint);win.addEventListener?.('online',resume);win.addEventListener?.('focus',resume);}
  return {load,sync,flush,resolve:flush,unsaved,protect,hasLocalRecovery,state:()=>({ready,revision,error:error||journalError||recoveryError,conflict:!!conflict,pending:unsaved(),localRecovery:hasLocalRecovery(),journalProtectedVersion,journalConfirmedVersion}),dispose(){checkpoint();disposed=true;win.removeEventListener?.('pagehide',checkpoint);win.removeEventListener?.('online',resume);win.removeEventListener?.('focus',resume)}};
}
