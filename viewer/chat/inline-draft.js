// The native composer owns all question text. Only references inserted by our
// controls are tracked; words and image numbers typed by the user stay theirs.
export const INLINE_DIVIDER='\n\n—\n';
const logicalItems=draft=>draft.logicalItems||draft.items;
const knownItems=draft=>[...logicalItems(draft),...draft.removed,...draft.removedLogical||[],...draft.detachedQuestions||[],...draft.archivedQuestions||[]];
const blockCache=new WeakMap();
const inputEdits=new WeakMap(),referenceHistory=new WeakMap();
const copyState=draft=>({...draft.inline,refs:(draft.inline?.refs||[]).map(ref=>({...ref})),removed:Object.fromEntries(Object.entries(draft.inline?.removed||{}).map(([id,value])=>[id,{pieces:(value.pieces||[]).map(piece=>({...piece,refs:(piece.refs||[]).map(ref=>({...ref}))}))}]))});

function editRange(before,after){
  let start=0,end=before.length,nextEnd=after.length;
  while(start<end&&start<nextEnd&&before[start]===after[start])start++;
  while(end>start&&nextEnd>start&&before[end-1]===after[nextEnd-1]){end--;nextEnd--;}
  return {start,end,nextEnd,delta:nextEnd-end};
}
export function noteInlineInput(draft,edit){if(draft.inline)inputEdits.set(draft,edit);}
function preciseInputEdit(draft,before,after){
  const hint=inputEdits.get(draft);if(!hint||hint.before!==before||/^history/.test(hint.type))return null;
  let start=hint.start,end=hint.end;const delta=after.length-before.length;
  if(start===end&&delta<0){if(/Backward$/.test(hint.type))start+=delta;else if(/Forward$/.test(hint.type))end-=delta;else return null;}
  const nextEnd=end+delta;if(start<0||end<start||end>before.length||nextEnd<start)return null;
  return before.slice(0,start)===after.slice(0,start)&&before.slice(end)===after.slice(nextEnd)?{start,end,nextEnd,delta}:null;
}
function rememberReferences(draft,state){
  const history=referenceHistory.get(draft)||[],signature=JSON.stringify(state.refs.map(ref=>[ref.id,ref.start,ref.end,ref.token]));
  if(!history.some(value=>value.text===state.text&&value.signature===signature))history.push({text:state.text,refs:state.refs.map(ref=>({...ref})),signature});
  referenceHistory.set(draft,history.slice(-32));
}
function undoReferences(draft,text){
  if(!/^history(?:Undo|Redo)$/.test(inputEdits.get(draft)?.type||''))return null;
  const matches=(referenceHistory.get(draft)||[]).filter(value=>value.text===text&&(draft.inline.refs||[]).every(ref=>value.refs.some(old=>old.id===ref.id)));
  return matches.length&&new Set(matches.map(value=>value.signature)).size===1?matches[0].refs.map(ref=>({...ref})):null;
}
function rebaseReferences(refs,before,after,precise=null){
  if(before===after)return refs.map(ref=>({...ref}));
  const edit=precise||editRange(before,after),result=[];
  for(const ref of refs){
    let next={...ref};
    if(ref.end<=edit.start){}
    else if(ref.start>=edit.end){next.start+=edit.delta;next.end+=edit.delta;}
    else{
      if(precise)continue;
      const index=after.indexOf(ref.token);
      // A uniquely moved citation keeps its source (for native text dragging).
      // Duplicate or edited tokens are not inferred from matching numbers.
      if(index<0||after.indexOf(ref.token,index+ref.token.length)>=0||before.indexOf(ref.token)!==before.lastIndexOf(ref.token))continue;
      next.start=index;next.end=index+ref.token.length;
    }
    if(after.slice(next.start,next.end)===next.token)result.push(next);
  }
  return result.sort((a,b)=>a.start-b.start);
}
function shiftRemoved(state,before,after,precise=null){
  if(before===after)return;const change=precise||editRange(before,after);
  for(const value of Object.values(state.removed||{}))for(const piece of value.pieces){if(piece.at>=change.end)piece.at+=change.delta;else if(piece.at>change.start)piece.at=change.nextEnd;}
}
function bodyParts(draft,text,previous=''){
  const state=draft.inline||{},old=state.context||state.suppressed&&state.removedContext||'',marker=INLINE_DIVIDER;
  text=String(text||'').replace(/\r/g,'');
  const footer=context=>{
    if(!context)return null;
    const content=text.replace(/\n+$/,''),expected=context.replace(/\n+$/,'');
    if(content.endsWith(marker+expected))return {body:content.slice(0,-marker.length-expected.length),head:context};
    // A rich editor may collapse the leading empty paragraph when the first
    // material has no question yet. This is still the exact owned footer.
    if(content==='\n—\n'+expected||content==='—\n'+expected)return {body:'',head:context};
    return null;
  };
  const owned=footer(old);if(owned)return owned;
  // The first generated prompt has not necessarily been read back yet. Its
  // footer is still ours; comparing only state.context misclassified it as
  // user prose and duplicated the entire background on the next image edit.
  const previousMarker=previous.lastIndexOf(marker),generated=previousMarker>=0?previous.slice(previousMarker+marker.length):'';
  const first=!old&&footer(generated);if(first)return first;
  const hadContext=!!old||previous.includes(marker),index=hadContext?text.lastIndexOf(marker):-1;
  if(index>=0)return {body:text.slice(0,index),head:text.slice(index+marker.length),edited:true};
  const leading=hadContext&&text.match(/^\n?—\n/);if(leading)return {body:'',head:text.slice(leading[0].length),edited:true};
  return {body:text,head:'',suppressed:hadContext||state.suppressed===true};
}
function paragraphSpans(text){
  const result=[];let start=0;
  for(const match of text.matchAll(/\n[ \t]*\n/g)){result.push({start,end:match.index});start=match.index+match[0].length;}
  result.push({start,end:text.length});return result;
}
function withoutReferences(text,refs,offset){
  let result='',cursor=offset;
  for(const ref of refs){result+=text.slice(cursor,ref.start);cursor=ref.end+(text[ref.end]===' '?1:0);}
  return result+text.slice(cursor);
}
export function inlineTextParts(draft,text,previous=''){
  const parts=bodyParts(draft,text,previous),refs=undoReferences(draft,parts.body)||rebaseReferences(draft.inline?.refs||[],draft.inline?.text||'',parts.body,preciseInputEdit(draft,draft.inline?.text||'',parts.body)),questions={},singleQuestions={},shared=[],common=[],occurrences=new Map();
  for(const span of paragraphSpans(parts.body)){
    const linked=refs.filter(ref=>ref.start>=span.start&&ref.end<=span.end);
    const value=withoutReferences(parts.body.slice(0,span.end),linked,span.start);
    if(!linked.length){if(value.trim())common.push(value);continue;}
    const ids=[...new Set(linked.map(ref=>ref.id))];
    for(const id of ids)if(value.trim())questions[id]=[questions[id],value].filter(Boolean).join('\n\n');
    if(value.trim()&&ids.length===1)singleQuestions[ids[0]]=[singleQuestions[ids[0]],value].filter(Boolean).join('\n\n');
    else if(value.trim()){const identity=JSON.stringify([...ids].sort()),index=occurrences.get(identity)||0;occurrences.set(identity,index+1);shared.push({key:identity+':'+index,ids,text:value,refs:ids.map(id=>linked.find(ref=>ref.id===id)?.ref).filter(ref=>ref?.snapshotId)});}
  }
  return {...parts,valid:true,start:0,prefix:'',questions,singleQuestions,shared,prelude:common.join('\n\n'),extra:'',refs};
}
export function readInlineDraft(draft,text,previous=''){
  const parts=inlineTextParts(draft,text,previous),state=copyState(draft);
  if(JSON.stringify(state.refs.map(ref=>[ref.id,ref.token]))!==JSON.stringify(parts.refs.map(ref=>[ref.id,ref.token])))rememberReferences(draft,state);
  // Keep removed/archived sources available for history and Undo. A live
  // citation that was explicitly edited/deleted no longer owns that wording.
  const ids=new Set([...(state.referenceIds||[]),...(state.refs||[]).map(ref=>ref.id),...parts.refs.map(ref=>ref.id)]);state.referenceIds=[...ids];
  for(const id of ids)draft.questions[id]=parts.questions[id]||'';
  draft.questionPrelude=parts.prelude;draft.extra='';
  shiftRemoved(state,state.text||'',parts.body,preciseInputEdit(draft,state.text||'',parts.body));state.text=parts.body;state.refs=parts.refs;
  if(/^history(?:Undo|Redo)$/.test(inputEdits.get(draft)?.type||''))for(const ref of state.refs)delete state.removed[ref.id];
  state.singleQuestions=parts.singleQuestions;state.sharedIds={...state.sharedIds};
  const assigned=new Set(),matches=parts.shared.map(part=>{const old=(state.shared||[]).find(value=>!assigned.has(value.id)&&value.text===part.text&&value.ids.length===part.ids.length&&value.ids.every(id=>part.ids.includes(id)));if(old)assigned.add(old.id);return old?.id;});
  state.shared=parts.shared.map((part,index)=>{const id=matches[index]||(!assigned.has(state.sharedIds[part.key])&&state.sharedIds[part.key])||crypto.randomUUID();assigned.add(id);state.sharedIds[part.key]=id;return {...part,id};});
  draft.questionOrder=[...new Set([...parts.refs.map(ref=>ref.id),...(draft.questionOrder||[])])];
  if(parts.edited)state.customContext=parts.head;
  if(parts.suppressed){if(state.context)state.removedContext=state.context;state.suppressed=true;}
  else if(parts.head||parts.edited){state.suppressed=false;delete state.removedContext;}
  state.context=parts.head;draft.inline=state;inputEdits.delete(draft);return true;
}
export function inlineReferenceLabel(draft,ref,positions){
  const item=logicalItems(draft).find(item=>item.id===ref.id),physical=item&&(item.attachmentId||item.id),index=draft.items.findIndex(item=>item.id===physical);
  if(index<0){
    const original=item||knownItems(draft).find(item=>item.id===ref.id),source=original?.boardSource||original?.source||original?.originalLabel||'',mark=original?.markTitle,seconds=original?.time;
    const time=Number.isFinite(seconds)?[Math.floor(Math.max(0,seconds)/3600),Math.floor(Math.max(0,seconds)/60)%60,Math.floor(Math.max(0,seconds))%60].map(value=>String(value).padStart(2,'0')).join(':'):'';
    const origin=[original?.course?.course,mark&&!source.includes(mark)?mark:'',source,time].filter(Boolean).join(' / ');
    return '〔'+(ref.label||original?.label||'图片')+' · 未附图'+(origin?' · '+origin:'')+'〕';
  }
  return '〔图 '+(positions?.[physical]||index+1)+(item.region?' · '+item.region:'')+'〕';
}
function relabel(draft,state,positions){
  let text='',cursor=0;const refs=[],changes=[];
  for(const ref of [...state.refs].sort((a,b)=>a.start-b.start)){
    if(state.text.slice(ref.start,ref.end)!==ref.token)continue;
    text+=state.text.slice(cursor,ref.start);const token=inlineReferenceLabel(draft,ref,positions),start=text.length;
    text+=token;refs.push({...ref,start,end:text.length,token});changes.push({start:ref.start,end:ref.end,delta:token.length-ref.token.length});cursor=ref.end;
  }
  for(const value of Object.values(state.removed||{}))for(const piece of value.pieces){const at=piece.at;piece.at+=changes.filter(change=>change.end<=at).reduce((sum,change)=>sum+change.delta,0);}
  return {...state,text:text+state.text.slice(cursor),refs};
}
export function inlineDraftPrompt(draft,context,positions){
  const state=relabel(draft,copyState(draft),positions),footer=state.suppressed?'':state.customContext??context;
  return state.text+(footer?INLINE_DIVIDER+footer:'');
}
export function mergeInlineDraft(draft,current,previous,positions,{sourceDraft=draft,context='',clear=false}={}){
  readInlineDraft(sourceDraft,current,previous);
  if(sourceDraft!==draft){const pending=copyState(draft);draft.inline={...copyState(sourceDraft),pendingRemovals:pending.pendingRemovals,pendingRestores:pending.pendingRestores,pendingMoves:pending.pendingMoves};draft.questions={...draft.questions,...sourceDraft.questions};draft.questionPrelude=sourceDraft.questionPrelude;draft.extra='';}
  const original=copyState(draft),removals=[...(draft.inline.pendingRemovals||[])].sort((a,b)=>Math.max(-1,...draft.inline.refs.filter(ref=>ref.id===b).map(ref=>ref.start))-Math.max(-1,...draft.inline.refs.filter(ref=>ref.id===a).map(ref=>ref.start))),restores=draft.inline.pendingRestores||[];
  for(const id of removals)removeInlineQuestion(draft,id,{apply:true});
  if(restores.length)restoreInlineQuestions(draft,restores,{apply:true});
  for(const move of draft.inline.pendingMoves||[])moveInlineQuestion(draft,move.id,move.direction,{apply:true});
  delete draft.inline.pendingRemovals;delete draft.inline.pendingRestores;
  delete draft.inline.pendingMoves;
  const state=relabel(draft,copyState(draft),positions);
  // A manually edited background is the user's replacement, not a second
  // block to copy into the question. Source identities remain in the draft.
  state.context=state.suppressed||clear?'':state.customContext??context;if(original.text!==state.text)rememberReferences(draft,original);draft.inline=state;
  return state.text+(state.context?INLINE_DIVIDER+state.context:'');
}
export function enableInlineDraft(draft,{text='',questions={},prelude='',extra='',positions,raw=false}={}){
  if(draft.inline)return;
  draft.inline={version:1,text:raw?text:[prelude,extra].filter(Boolean).join('\n\n'),refs:[],context:'',removed:{},suppressed:raw};
  if(raw)return;
  for(const [id,question]of Object.entries(questions)){
    if(!question?.trim())continue;const item=knownItems(draft).find(item=>item.id===id);if(!item)continue;
    const state=draft.inline;if(state.text.trim())state.text+='\n\n';
    const start=state.text.length,ref={id,label:item.label,ref:item.ref||{markId:item.markId,snapshotId:item.snapshotId,itemId:item.id}},token=inlineReferenceLabel(draft,ref,positions);
    state.text+=token+' '+question;state.refs.push({...ref,start,end:start+token.length,token});
  }
  draft.inline.referenceIds=draft.inline.refs.map(ref=>ref.id);
  const removedIds=new Set([...draft.removed,...draft.removedLogical||[]].map(item=>item.id)),order=draft.questionOrder||knownItems(draft).map(item=>item.id);
  for(const [id,question]of Object.entries(draft.questions)){
    if(!question?.trim()||Object.hasOwn(questions,id)||!removedIds.has(id))continue;const item=knownItems(draft).find(item=>item.id===id);if(!item)continue;
    const later=draft.inline.refs.find(ref=>order.indexOf(ref.id)>order.indexOf(id)),at=later?later.start:draft.inline.text.length,lead=later?'':at?'\n\n':'',tail=later?'\n\n':'',ref={id,label:item.label,ref:item.ref||{markId:item.markId,snapshotId:item.snapshotId,itemId:item.id}},token=inlineReferenceLabel(draft,ref,positions);
    draft.inline.removed[id]={pieces:[{at,order:order.indexOf(id),paragraph:true,afterId:later?.id,beforeId:draft.inline.refs.filter(ref=>ref.end<=at).at(-1)?.id,text:lead+token+' '+question+tail,refs:[{...ref,token,start:lead.length,end:lead.length+token.length}]}]};
  }
}
export function insertInlineReference(draft,item,start,positions){
  const state=copyState(draft);let at=Math.max(0,Math.min(state.text.length,Number.isFinite(start)?start:state.text.length));
  const existing=state.refs.find(ref=>ref.id===item.id&&at>=ref.start&&at<=ref.end+1);
  if(existing)return existing.end+1;
  const enclosing=state.refs.find(ref=>at>ref.start&&at<ref.end);if(enclosing)at=enclosing.end;
  rememberReferences(draft,state);
  const target={id:item.id,label:item.label,ref:item.ref||{markId:item.markId,snapshotId:item.snapshotId,itemId:item.id}},token=inlineReferenceLabel(draft,target,positions);
  const lead=at===state.text.length&&state.text.trim()&&!/\n[ \t]*\n$/.test(state.text)?'\n\n':at>0&&!/\s/.test(state.text[at-1])?' ':'',insert=lead+token+' ';
  state.refs=state.refs.map(ref=>ref.start>=at?{...ref,start:ref.start+insert.length,end:ref.end+insert.length}:ref);
  // Inserting a reference never replaces selected question text.
  const before=state.text;state.text=state.text.slice(0,at)+insert+state.text.slice(at);shiftRemoved(state,before,state.text,{start:at,end:at,nextEnd:at+insert.length,delta:insert.length});
  state.refs.push({...target,token,start:at+lead.length,end:at+lead.length+token.length});state.refs.sort((a,b)=>a.start-b.start);draft.inline=state;
  state.referenceIds=[...new Set([...(state.referenceIds||[]),item.id])];
  return at+insert.length;
}
export function removeInlineQuestion(draft,id,{apply=false}={}){
  if(!draft.inline)return;const state=copyState(draft),edits=[];
  if(!apply){state.pendingRemovals=[...new Set([...(state.pendingRemovals||[]),id])];state.pendingRestores=(state.pendingRestores||[]).filter(value=>value!==id);draft.inline=state;return;}
  const spans=paragraphSpans(state.text);
  for(const [index,span]of spans.entries()){
    const linked=state.refs.filter(ref=>ref.start>=span.start&&ref.end<=span.end);
    if(!linked.some(ref=>ref.id===id))continue;
    if(linked.every(ref=>ref.id===id))edits.push(index<spans.length-1?{start:span.start,end:spans[index+1].start,paragraph:true}:{start:index?spans[index-1].end:span.start,end:span.end,paragraph:true});
    else for(const ref of linked.filter(ref=>ref.id===id))edits.push({start:ref.start,end:ref.end+(state.text[ref.end]===' '?1:0)});
  }
  if(!edits.length)return;
  // Adjacent paragraphs can share their separating newline range. Keep one
  // removal piece so Undo restores their original sequence and separators.
  const ranges=[];for(const edit of edits.sort((a,b)=>a.start-b.start)){const prior=ranges.at(-1);if(prior&&edit.start<=prior.end){prior.end=Math.max(prior.end,edit.end);prior.paragraph=prior.paragraph&&edit.paragraph;}else ranges.push({...edit});}
  const trailing=ranges.at(-1),trailingSpan=trailing?.paragraph&&trailing.end===state.text.length?spans.findIndex(span=>span.start===trailing.start):-1;
  if(trailingSpan>0)trailing.start=spans[trailingSpan-1].end;
  state.removed[id]={pieces:[]};
  for(const edit of ranges.reverse()){
    const before=state.text,piece={at:edit.start,order:edit.start,paragraph:!!edit.paragraph,beforeId:state.refs.filter(ref=>ref.end<=edit.start).at(-1)?.id,afterId:state.refs.find(ref=>ref.start>=edit.end)?.id,text:before.slice(edit.start,edit.end),refs:state.refs.filter(ref=>ref.start>=edit.start&&ref.end<=edit.end).map(ref=>({...ref,start:ref.start-edit.start,end:ref.end-edit.start}))};
    const end=Math.min(edit.end,before.length),change={start:edit.start,end,nextEnd:edit.start,delta:edit.start-end};
    state.text=before.slice(0,edit.start)+before.slice(end);state.refs=rebaseReferences(state.refs,before,state.text,change);shiftRemoved(state,before,state.text,change);state.removed[id].pieces.push(piece);
  }
  draft.inline=state;
}
export function restoreInlineQuestions(draft,ids,{apply=false}={}){
  if(!draft.inline)return;let state=copyState(draft);
  if(!apply){state.pendingRestores=[...new Set([...(state.pendingRestores||[]),...ids])];state.pendingRemovals=(state.pendingRemovals||[]).filter(id=>!ids.includes(id));draft.inline=state;return;}
  const pending=ids.flatMap(id=>(state.removed[id]?.pieces||[]).map(piece=>({id,piece}))).sort((a,b)=>a.piece.at-b.piece.at||a.piece.order-b.piece.order);
  for(const {id,piece}of pending){
    state.removed[id].pieces=state.removed[id].pieces.filter(value=>value!==piece);
    let start=Math.max(0,Math.min(piece.at,state.text.length)),lead='',tail='';const before=state.text;
    if(piece.paragraph){
      // The rebased gap includes unreferenced prose between image questions.
      // A distant image citation must not pull this piece across that prose.
      const spans=paragraphSpans(before);start=spans.find(span=>start>span.start&&start<span.end)?.end??start;
      if(start>0&&!before.slice(0,start).endsWith('\n\n')&&!piece.text.startsWith('\n\n'))lead='\n\n';
      if(start<before.length&&!before.slice(start).startsWith('\n\n')&&!piece.text.endsWith('\n\n'))tail='\n\n';
    }
    const inserted=lead+piece.text+tail;state.text=before.slice(0,start)+inserted+before.slice(start);
    state.refs=state.refs.map(ref=>ref.start>=start?{...ref,start:ref.start+inserted.length,end:ref.end+inserted.length}:ref);
    shiftRemoved(state,before,state.text,{start,end:start,nextEnd:start+inserted.length,delta:inserted.length});state.refs.push(...piece.refs.map(ref=>({...ref,start:ref.start+start+lead.length,end:ref.end+start+lead.length})));
    if(!state.removed[id].pieces.length)delete state.removed[id];
  }
  state.refs.sort((a,b)=>a.start-b.start);draft.inline=state;
}

function questionSpans(state){const cached=blockCache.get(state);if(cached?.text===state.text&&cached.refs===state.refs)return cached.spans;const spans=paragraphSpans(state.text).filter(span=>{const linked=state.refs.filter(ref=>ref.start>=span.start&&ref.end<=span.end);return linked.length&&withoutReferences(state.text.slice(0,span.end),linked,span.start).trim();});blockCache.set(state,{text:state.text,refs:state.refs,spans});return spans;}
export function inlineQuestionNeighbours(draft,id){if(!draft.inline)return {before:false,after:false};const linked=questionSpans(draft.inline),index=linked.findIndex(span=>draft.inline.refs.some(ref=>ref.id===id&&ref.start>=span.start&&ref.end<=span.end));return {before:index>0,after:index>=0&&index<linked.length-1};}
export function moveInlineQuestion(draft,id,direction,{apply=false}={}){
  if(!draft.inline)return false;const state=copyState(draft),spans=paragraphSpans(state.text),linked=questionSpans(state),from=linked.findIndex(span=>state.refs.some(ref=>ref.id===id&&ref.start>=span.start&&ref.end<=span.end)),to=from+(direction<0?-1:1);
  if(from<0||to<0||to>=linked.length)return false;
  if(!apply){state.pendingMoves=[...(state.pendingMoves||[]),{id,direction}];draft.inline=state;return true;}
  const pieces=spans.map((span,index)=>({text:state.text.slice(span.start,span.end),separator:state.text.slice(span.end,spans[index+1]?.start??state.text.length),refs:state.refs.filter(ref=>ref.start>=span.start&&ref.end<=span.end).map(ref=>({...ref,start:ref.start-span.start,end:ref.end-span.start}))})),a=spans.findIndex(span=>span.start===linked[from].start),b=spans.findIndex(span=>span.start===linked[to].start);
  const first=pieces[a],second=pieces[b];pieces[a]={...second,separator:first.separator,source:b};pieces[b]={...first,separator:second.separator,source:a};
  state.text='';state.refs=[];
  const offsets=new Map();for(const [index,piece]of pieces.entries()){const offset=state.text.length;offsets.set(piece.source??index,offset);state.refs.push(...piece.refs.map(ref=>({...ref,start:ref.start+offset,end:ref.end+offset})));state.text+=piece.text+piece.separator;}
  for(const value of Object.values(state.removed||{}))for(const piece of value.pieces){const index=spans.findIndex((span,index)=>piece.at>=span.start&&(index===spans.length-1?piece.at<=span.end:piece.at<spans[index+1].start));if(index>=0)piece.at=offsets.get(index)+piece.at-spans[index].start;}
  draft.inline=state;return true;
}
