import {enableInlineDraft,inlineDraftPrompt,inlineTextParts,readInlineDraft,mergeInlineDraft,removeInlineQuestion,restoreInlineQuestions,moveInlineQuestion} from './inline-draft.js';

export const draftTime=seconds=>{const n=Math.max(0,Math.floor(Number(seconds)||0));return [Math.floor(n/3600),Math.floor(n/60)%60,n%60].map(x=>String(x).padStart(2,'0')).join(':')};
export const DRAFT_START='【课堂背景与图片说明】';
export const DRAFT_QUESTIONS='【我的问题】';
export const DRAFT_END='【补充问题】';
const NO_SELECTION='本次未保留圈选图，请以我的补充问题为准。';
export function newDraft({seeded=false,inline=false}={}){const draft={id:crypto.randomUUID(),items:[],removed:[],seen:[],next:1,course:{},lessonKey:'',contextKey:'',providedKeys:[],seeded,contextStarted:seeded,contextTime:null,questions:{},questionPrelude:'',extra:'',materialIds:{},removalGenerations:{},removalTimes:{},restoreIntents:{}};if(inline)enableInlineDraft(draft);return draft;}
export const logicalDraftItems=draft=>draft.logicalItems||draft.items;
export function applyDraftQuestionFields(draft,fields){for(const [id,text]of Object.entries(fields)){if(id==='questionPrelude')draft.questionPrelude=text;else draft.questions[id]=text;}}
export const draftQuestionItems=draft=>{const referenced=new Set((draft.inline?.refs||[]).map(ref=>ref.id)),active=logicalDraftItems(draft).filter(item=>item.ask||item.kind==='selection'||referenced.has(item.id)),questions=[...active,...(draft.detachedQuestions||[]).filter(item=>!active.some(value=>value.id===item.id)&&draft.questions[item.id]?.trim())],order=new Map((draft.questionOrder||[]).map((id,index)=>[id,index]));return questions.sort((a,b)=>(order.get(a.id)??Infinity)-(order.get(b.id)??Infinity));};
function retainImageQuestion(draft,item,keepQuestion){
  if(!keepQuestion){if(draft.detachedQuestions)draft.detachedQuestions=draft.detachedQuestions.filter(value=>value.id!==item.id);return;}
  if(!draft.questions[item.id]?.trim())return;
  draft.detachedQuestions??=[];
  if(!draft.detachedQuestions.some(value=>value.id===item.id)){const {image,thumbnail,...source}=item;draft.detachedQuestions.push(source);}
}
function removalPosition(items,item){const index=items.indexOf(item);return {index,before:items[index-1]?.id||'',after:items[index+1]?.id||''};}
function insertRestored(items,restored,position){
  const after=position?.after?items.findIndex(item=>item.id===position.after):-1,before=position?.before?items.findIndex(item=>item.id===position.before):-1;
  const index=after>=0?after:before>=0?before+1:Number.isSafeInteger(position?.index)?Math.min(Math.max(0,position.index),items.length):items.length;
  items.splice(index,0,...restored);
}
function questionImageSource(draft,item,positions){
  const attachment=item.attachmentId||item.id,index=draft.items.findIndex(value=>value.id===attachment);
  return index<0?'本次未附原图':`图${positions?.[attachment]??index+1}${item.region?' · '+item.region:''}`;
}
export function moveDraftQuestion(draft,id,direction){
  if(draft.inline)return moveInlineQuestion(draft,id,direction);
  const questions=draftQuestionItems(draft),from=questions.findIndex(item=>item.id===id),to=from+(direction<0?-1:1);
  if(from<0||to<0||to>=questions.length)return false;
  const order=[...new Set([...(draft.questionOrder||[]),...questions.map(item=>item.id)])],a=order.indexOf(questions[from].id),b=order.indexOf(questions[to].id);[order[a],order[b]]=[order[b],order[a]];draft.questionOrder=order;return true;
}
export function moveDraftImage(draft,id,direction){
  const from=draft.items.findIndex(item=>item.id===id),to=from+(direction<0?-1:1);if(from<0||to<0||to>=draft.items.length)return null;
  draft.questionOrder=[...new Set([...(draft.questionOrder||[]),...draftQuestionItems(draft).map(item=>item.id)])];
  [draft.items[from],draft.items[to]]=[draft.items[to],draft.items[from]];
  if(draft.logicalItems){const contents=draft.logicalItems;draft.logicalItems=draft.items.flatMap(physical=>contents.filter(item=>item.attachmentId===physical.id));}
  return draft.items[Math.min(from,to)];
}
export function replaceDraftMaterial(draft,item,removedId,plan,{removedAt=Date.now(),keepQuestion=true}={}){
  const original=logicalDraftItems(draft).filter(value=>(value.attachmentId||value.id)===item.id),removed=original.find(value=>value.id===removedId),retained=original.filter(value=>value!==removed);
  if(!draft.items.includes(item)||!removed||!retained.length||!draft.logicalItems)throw Error('本次选材已变化，请从当前草稿重试。');
  const keys=new Set(retained.map(draftMaterialKey));
  if(plan.logicalItems.length!==keys.size||new Set(plan.logicalItems.map(draftMaterialKey)).size!==keys.size||plan.logicalItems.some(value=>!keys.has(draftMaterialKey(value))))throw Error('整理后的材料与保留选择不一致。');
  const pages=plan.items.map(value=>({...value,materialId:plan.id,sourceMaterialId:plan.sourceMaterialId||plan.id,logicalKeys:plan.logicalItems.filter(logical=>logical.attachmentId===value.id).map(draftMaterialKey)}));
  if(pages.some(page=>draft.items.some(value=>value!==item&&value.id===page.id)))throw Error('整理后的材料页已在草稿中。');
  const replacements=new Map(retained.map(value=>{const next=plan.logicalItems.find(logical=>draftMaterialKey(logical)===draftMaterialKey(value)),page=pages.find(physical=>physical.id===next.attachmentId);if(!page)throw Error('整理后的图片缺少原图对应关系。');return [value.id,normalizedLogical(draft,{...value,region:next.region||'',thumbnail:next.thumbnail||value.thumbnail},page,value.course,true)];}));
  materialState(draft);const key=draftMaterialKey(removed);draft.removalGenerations[key]=(draft.removalGenerations[key]||0)+1;draft.removalTimes[key]=removedAt;
  if(!keepQuestion)removeInlineQuestion(draft,removed.id);
  draft.questionOrder??=draftQuestionItems(draft).map(value=>value.id);
  retainImageQuestion(draft,removed,keepQuestion);
  const excluded={...removed,removalGeneration:draft.removalGenerations[key],removedAt,removalPosition:removalPosition(draft.logicalItems,removed)};
  item.removalPosition=removalPosition(draft.items,item);
  includeLogicalKeys(item,original);draft.removed.push(item);draft.removedLogical??=[];draft.removedLogical.push(excluded);
  draft.items.splice(draft.items.indexOf(item),1,...pages);draft.logicalItems=draft.logicalItems.filter(value=>value!==removed).map(value=>replacements.get(value.id)||value);
  return pages;
}
export function removeSharedDraftBackground(draft,physical,logical,{removedAt=Date.now(),keepQuestion=true}={}){
  const contents=draft.logicalItems?.filter(item=>item.attachmentId===physical.id)||[];
  if(!draft.items.includes(physical)||!['panorama','board','collection'].includes(physical.kind)||physical.kind==='collection'&&(physical.format&&physical.format!=='png'||contents.some(item=>item.region||!['panorama','board'].includes(item.kind)))||contents.length<2||!contents.includes(logical))throw Error('共享原图的来源已变化，原材料已保留。');
  materialState(draft);const key=draftMaterialKey(logical),generation=(draft.removalGenerations[key]||0)+1;
  if(!keepQuestion)removeInlineQuestion(draft,logical.id);
  draft.removalGenerations[key]=generation;draft.removalTimes[key]=removedAt;draft.questionOrder??=draftQuestionItems(draft).map(item=>item.id);retainImageQuestion(draft,logical,keepQuestion);
  const marker={...physical,id:crypto.randomUUID(),image:'',logicalKeys:[key],removalPosition:removalPosition(draft.items,physical),sharedWith:physical.id,...physical.kind==='collection'?{sourceAttachmentId:physical.sourceAttachmentId||physical.id}:{}};delete marker.__fileName;delete marker.__fileToken;delete marker.__uploadRequested;delete marker.__targetStamp;
  const removed={...logical,attachmentId:marker.id,removalGeneration:generation,removedAt,removalPosition:removalPosition(draft.logicalItems,logical)};
  draft.logicalItems=draft.logicalItems.filter(item=>item!==logical);draft.removed.push(marker);draft.removedLogical??=[];draft.removedLogical.push(removed);return removed;
}
export const quoteDraftText=text=>String(text||'').split('\n').map(line=>'│ '+line).join('\n');
const itemRef=item=>item.ref||{markId:item.markId,snapshotId:item.snapshotId,itemId:item.id};
export const draftMaterialKey=item=>{const r=item.ref||item;const id=r.itemId||r.id;return r.snapshotId&&id?JSON.stringify([r.snapshotId,id]):'id:'+id};
export const draftContextKey=(item,fallback='')=>item.contextKey||item.markId||item.ref?.markId||fallback;
const backgroundSlot=item=>item.kind+':'+(item.boardId||item.kind==='panorama'&&'panorama'||item.id);
export const draftBackgroundKey=(item,fallback='')=>{const context=draftContextKey(item,fallback);return context?'background:'+context+':'+backgroundSlot(item):''};
const removedLogical=draft=>draft.logicalItems?draft.removedLogical||[]:draft.removed.filter(x=>x.kind!=='collection');
const allLogical=draft=>[...logicalDraftItems(draft),...removedLogical(draft)];
const assetDigest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value)?value.toLowerCase():'';
const originalImage=value=>typeof value==='string'&&/^data:image\/(?:png|jpeg);base64,/.test(value)&&value.length>32?value:'';
// A snapshot reference stays independent even when its complete automatic
// background can use an existing physical attachment. Atlas regions cannot.
function backgroundIdentity(item){
  if(!item||!['panorama','board'].includes(item.kind))return '';
  const mark=item.markId||item.ref?.markId,label=item.originalLabel||item.label,roi=item.roi;
  if(!mark||!label||item.kind==='board'&&!item.boardId)return '';
  if(roi&&(!['x','y','w','h'].every(k=>Number.isFinite(roi[k]))||roi.w<=0||roi.h<=0))return '';
  return JSON.stringify([mark,item.kind,item.boardId||'',label,roi?[roi.x,roi.y,roi.w,roi.h]:null]);
}
function backgroundSources(draft){
  const logical=allLogical(draft),result={active:[],removed:[]};
  for(const [state,items]of [['active',draft.items],['removed',draft.removed]])for(const physical of items){
    const contents=logical.filter(x=>(x.attachmentId||x.id)===physical.id),identity=backgroundIdentity(contents[0]);
    if(!identity||contents.some(x=>backgroundIdentity(x)!==identity||x.region))continue;
    if(physical.kind==='collection'&&(contents.some(x=>!assetDigest(x.asset))||physical.format&&physical.format!=='png'||originalImage(physical.image)&&!physical.image.startsWith('data:image/png;base64,')))continue;
    if(!['panorama','board','collection'].includes(physical.kind))continue;
    const digests=new Set([physical.asset,...contents.map(x=>x.asset)].map(assetDigest).filter(Boolean));if(digests.size>1)continue;
    const item=contents[0],key=draftMaterialKey(item),generation=draft.removalGenerations[key]||item.removalGeneration||0;
    if(state==='removed'&&!generation)continue;
    result[state].push({physical,identity,asset:physical.kind==='collection'?assetDigest(physical.asset):[...digests][0]||'',image:originalImage(physical.image),region:item.region||'',generation,removedAt:draft.removalTimes[key]||item.removedAt||0});
  }result.removed.sort((a,b)=>b.removedAt-a.removedAt||b.generation-a.generation);return result;
}
function reusableBackground(item,plan,sources){
  const identity=backgroundIdentity(item);if(!identity)return null;
  const asset=assetDigest(item.asset),contents=plan.logicalItems.filter(x=>x.attachmentId===item.attachmentId),physical=plan.items.find(x=>x.id===item.attachmentId),image=originalImage(item.image)||(!item.region&&contents.length===1?originalImage(physical?.image):'');
  return sources.find(source=>source.identity===identity&&(asset&&source.asset?asset===source.asset&&(!image||!source.image||image===source.image):!!image&&image===source.image))||null;
}
function shareBackgroundAsset(draft,physical,item){
  const asset=assetDigest(item.asset);if(!asset)return;
  if(!assetDigest(physical.asset))physical.asset=asset;for(const logical of allLogical(draft).filter(x=>(x.attachmentId||x.id)===physical.id))if(!assetDigest(logical.asset))logical.asset=asset;
}
function includeLogicalKeys(physical,logical){physical.logicalKeys=[...new Set([...(physical.logicalKeys||[]),...logical.map(draftMaterialKey)])]}
function materialState(draft){
  draft.materialIds??={};draft.removalGenerations??={};draft.removalTimes??={};draft.restoreIntents??={};
  for(const x of allLogical(draft)){const key=draftMaterialKey(x);draft.materialIds[key]??=x.id;const n=Number(x.label?.match(/^选区 (\d+)$/)?.[1]);if(n)draft.next=Math.max(draft.next,n+1);}
  for(const x of removedLogical(draft)){const key=draftMaterialKey(x);draft.removalGenerations[key]??=x.removalGeneration||1;draft.removalTimes[key]??=x.removedAt||0;}
}
function materialId(draft,item){
  materialState(draft);const key=draftMaterialKey(item);if(draft.materialIds[key])return draft.materialIds[key];
  const proposed=item.id||item.itemId||crypto.randomUUID(),taken=Object.values(draft.materialIds).includes(proposed)||allLogical(draft).some(x=>x.id===proposed&&draftMaterialKey(x)!==key);
  return draft.materialIds[key]=taken?crypto.randomUUID():proposed;
}
function normalizedLogical(draft,item,attachment,course={},preserve=false){
  const key=draftMaterialKey(item),known=allLogical(draft).find(x=>draftMaterialKey(x)===key),id=materialId(draft,item),ask=!!(item.ask||item.kind==='selection');
  const originalLabel=item.originalLabel||item.label||(item.kind==='selection'?'圈选图':item.kind==='panorama'?'全景':'板书'),boardSource=item.boardSource??item.source??'';
  const label=ask?(known?.ask||known?.kind==='selection'?known.label:preserve&&/^选区 \d+$/.test(item.label||'')?item.label:'选区 '+draft.next++):originalLabel;
  return {...item,id,ref:{...itemRef(item)},attachmentId:attachment.id,materialId:attachment.materialId,sourceMaterialId:attachment.sourceMaterialId,originalLabel,boardSource,label,ask,course:{...(item.course||course)},source:preserve?(item.originalLabel?item.source:[item.markTitle,item.source||originalLabel].filter(Boolean).join(' / ')):[item.markTitle,originalLabel,boardSource].filter(Boolean).join(' / ')};
}
function ensureLogicalDraft(draft){
  materialState(draft);
  if(!draft.logicalItems){const course=x=>x.lessonKey&&x.lessonKey!==draft.lessonKey?x.course:{...x.course,...draft.course};draft.logicalItems=draft.items.map(x=>normalizedLogical(draft,{...x,course:course(x)},x,course(x),true));draft.removedLogical=draft.removed.map(x=>normalizedLogical(draft,{...x,course:course(x)},x,course(x),true));}
  for(const physical of [...draft.items,...draft.removed]){if(physical.kind==='collection'){physical.materialId??=draft.plan?.id;physical.sourceMaterialId??=draft.plan?.sourceMaterialId||physical.materialId;}const contents=allLogical(draft).filter(x=>x.attachmentId===physical.id);includeLogicalKeys(physical,contents);for(const logical of contents){logical.materialId??=physical.materialId;logical.sourceMaterialId??=physical.sourceMaterialId;}}
}
function restoreKeys(draft,plan){
  materialState(draft);const keys=new Set(),members=new Set(plan.logicalItems.map(draftMaterialKey));
  for(const intent of plan.restoreRefs||[]){
    const key=draftMaterialKey(intent);if(!members.has(key))throw Error('恢复选择不属于本次材料，原草稿已保留。');
    if(typeof intent.intentId!=='string'||!intent.intentId)continue;
    const pair=JSON.stringify([key,intent.intentId]),generation=draft.removalGenerations[key]||0,legacy=draft.restoreIntents[intent.intentId],previous=draft.restoreIntents[pair]||(legacy?.key===key?legacy:null);
    const binding=previous||{key,generation,intentAt:Number(intent.intentAt)||0};draft.restoreIntents[pair]=binding;
    if(binding.generation===generation&&!(binding.intentAt>0&&(draft.removalTimes[key]||0)>binding.intentAt))keys.add(key);
  }return keys;
}
export function planDraftAppend(draft,plan){
  materialState(draft);const active=new Map(logicalDraftItems(draft).map(x=>[draftMaterialKey(x),x])),removed=new Set(removedLogical(draft).map(draftMaterialKey)),sources=backgroundSources(draft),removedSources=new Map();
  for(const item of plan.logicalItems){const key=draftMaterialKey(item);if(active.has(key)||removed.has(key)||reusableBackground(item,plan,sources.active))continue;const source=reusableBackground(item,plan,sources.removed);if(source){removedSources.set(key,source);draft.removalGenerations[key]=Math.max(draft.removalGenerations[key]||0,source.generation);draft.removalTimes[key]=Math.max(draft.removalTimes[key]||0,source.removedAt);}}
  const restore=restoreKeys(draft,plan),seen=new Set(),wanted=[],promote=[],shared=[],sharedRemoved=[];
  for(const item of plan.logicalItems){const key=draftMaterialKey(item);if(seen.has(key))continue;seen.add(key);const existing=active.get(key);if(existing){if(item.ask&&!existing.ask&&existing.kind!=='selection')promote.push(key);continue;}if(removed.has(key)&&!restore.has(key))continue;
    const source=reusableBackground(item,plan,sources.active);if(source){shared.push({item,...source});continue;}
    const deleted=removedSources.get(key);if(deleted&&!restore.has(key)){sharedRemoved.push({item,...deleted});continue;}wanted.push(item);
  }
  const wantedKeys=new Set(wanted.map(draftMaterialKey));let requiresProjection=false;const items=[];
  for(const physical of plan.items){const contents=plan.logicalItems.filter(x=>x.attachmentId===physical.id),selected=contents.filter(x=>wantedKeys.has(draftMaterialKey(x)));if(!selected.length)continue;if(selected.length!==contents.length||new Set(selected.map(draftMaterialKey)).size!==selected.length)requiresProjection=true;else items.push(physical);}
  return {wanted,promote,shared,sharedRemoved,requiresProjection,items,refs:wanted.map(x=>({...itemRef(x)}))};
}
const carryQuestions=old=>old.included===false?[]:(old.questions||[]).filter(q=>q.included!==false&&q.text?.trim());
const carryReference=ref=>ref?[ref.markId||'',ref.snapshotId||'',ref.itemId||ref.id||'']:null;
const carryQuestionIdentity=(q,index)=>JSON.stringify([q.id??index,q.text,carryReference(q.ref),(q.refs||[]).map(carryReference),q.source||'',q.label||'']);
const carryText=old=>old.included===false?'':old.extra||(!carryQuestions(old).length?old.text||'':'');
const carryTextIdentity=old=>JSON.stringify([carryText(old),(old.refs||[]).map(carryReference),old.source||'']);
const carryQuestionKey=(old,q,index)=>'carry:'+old.id+':'+(q.quoteId||(q.id??index));
function copyCarriedQuestion(q,distinct=false){
  const copy={...q};delete copy.quoteId;
  // Requoting a quotation must not grow the selection id at every level.
  if(distinct||q.carried===true||String(q.id??'').startsWith('carry:'))copy.quoteId=crypto.randomUUID();
  return copy;
}
function mergeCarry(current,incoming){
  const result=current.map(x=>({...x,questions:(x.questions||[]).map(q=>({...q}))}));
  for(const old of incoming||[]){const questions=carryQuestions(old),existing=questions.length&&result.find(x=>x.id===old.id&&carryQuestions(x).length);
    if(existing){for(const [index,q]of questions.entries()){
      if(existing.questions.some((value,i)=>carryQuestionIdentity(value,i)===carryQuestionIdentity(q,index)))continue;
      // A changed source part is another quotation, not a replacement for the
      // words already chosen. Keep its source id and give the copy its own key.
      const conflict=existing.questions.some((value,i)=>(value.id??i)===(q.id??index));
      existing.questions.push(copyCarriedQuestion(q,conflict));
    }}else if(questions.length)result.push({...old,questions:questions.map(q=>copyCarriedQuestion(q))});
    if(carryText(old)&&!result.some(x=>x.id===old.id&&carryTextIdentity(x)===carryTextIdentity(old)))result.push({...old,questions:[]});
  }return result;
}
function clearRestored(draft,keys){
  if(draft.detachedQuestions)draft.detachedQuestions=draft.detachedQuestions.filter(item=>!keys.has(draftMaterialKey(item)));
  if(draft.logicalItems){draft.removedLogical=(draft.removedLogical||[]).filter(x=>!keys.has(draftMaterialKey(x)));draft.removed=draft.removed.filter(x=>draft.removedLogical.some(l=>l.attachmentId===x.id));}
  else draft.removed=draft.removed.filter(x=>!keys.has(draftMaterialKey(x)));
}
export function carriedDraftQuestions(draft){
  return (draft.plan?.carry||[]).flatMap(old=>carryQuestions(old).map((q,i)=>{const part={...q,id:carryQuestionKey(old,q,i),originalId:q.id,recordId:old.id,carried:true,ref:q.ref?{...q.ref}:undefined};delete part.quoteId;return part;}));
}
export function draftCarryKeys(draft,records=draft.plan?.carry||[]){
  const all=draft.plan?.carry||[],keys=[];
  for(const old of records){
    for(const [i,q]of carryQuestions(old).entries()){
      const record=all.find(x=>x.id===old.id&&carryQuestions(x).some((value,index)=>carryQuestionIdentity(value,index)===carryQuestionIdentity(q,i))),parts=record&&carryQuestions(record),index=parts?.findIndex((value,index)=>carryQuestionIdentity(value,index)===carryQuestionIdentity(q,i));
      keys.push(record?carryQuestionKey(record,parts[index],index):'carry-missing:'+old.id+':'+i);
    }
    if(carryText(old)){const index=all.findIndex(x=>x.id===old.id&&carryTextIdentity(x)===carryTextIdentity(old));keys.push(index>=0?'carry-raw:'+old.id+':'+index:'carry-raw-missing:'+old.id);}
  }return [...new Set(keys)];
}
export function carriedQuestionSource(draft,question,positions){
  if(question.refs?.length)return [...new Set(question.refs.map(ref=>carriedQuestionSource(draft,{ref,source:question.source,label:question.label},positions)))].join('；');
  const ref=question.ref,logical=logicalDraftItems(draft);let item=ref&&logical.find(x=>{const r=itemRef(x);return r.snapshotId===ref.snapshotId&&r.itemId===ref.itemId});
  if(!item&&ref?.contextKey&&assetDigest(ref.asset)&&backgroundIdentity(ref))item=logical.find(x=>draftContextKey(x)===ref.contextKey&&backgroundIdentity(x)===backgroundIdentity(ref)&&(!assetDigest(x.asset)||assetDigest(x.asset)===assetDigest(ref.asset)));
  if(item){const attachment=item.attachmentId||item.id,n=positions?.[attachment]??draft.items.findIndex(x=>x.id===attachment)+1;
    if(n>0)return `图${n}${item.region?' · '+item.region:''}（${item.markTitle?item.markTitle+' / ':''}${item.originalLabel||item.label}${item.boardSource?' / '+item.boardSource:''}）`;
  }
  return '本次未附原图；原来源 '+(question.source||question.label||'原材料');
}
const quotedCarriedText=(draft,old,text,positions)=>quoteDraftText((old.refs?.length?carriedQuestionSource(draft,{refs:old.refs,source:old.source||old.title},positions)+'：\n':'')+text);
export function appendStudyPlan(draft,plan,{projection=null}={}){
  const diff=planDraftAppend(draft,plan);if(diff.requiresProjection&&!projection){const error=Error('材料页需要按新增图片重新整理。');error.code='draft_projection_required';error.refs=diff.refs;throw error;}
  const transport=projection||{...plan,items:diff.items,logicalItems:diff.wanted},wanted=new Map(diff.wanted.map(x=>[draftMaterialKey(x),x])),received=new Set(transport.logicalItems.map(draftMaterialKey));
  if(received.size!==wanted.size||transport.logicalItems.length!==wanted.size||[...received].some(key=>!wanted.has(key)))throw Error('新增材料与本次选择不一致，原草稿已保留。');
  ensureLogicalDraft(draft);const oldPlan=draft.plan;draft.plan={...oldPlan,id:oldPlan?.id||plan.id,title:oldPlan?.title||plan.title||'课后整理',carry:mergeCarry(oldPlan?.carry||[],plan.carry||[])};
  const additions=[];for(const physical of transport.items){const contents=transport.logicalItems.filter(x=>x.attachmentId===physical.id);if(!contents.length)continue;if(draft.items.some(x=>x.id===physical.id))throw Error('材料页编号重复，原草稿已保留。');const item={...physical,materialId:physical.materialId||transport.id,sourceMaterialId:physical.sourceMaterialId||plan.sourceMaterialId||plan.id,logicalKeys:contents.map(draftMaterialKey)};additions.push(item);}
  for(const key of diff.promote){const item=draft.logicalItems.find(x=>draftMaterialKey(x)===key);item.ask=true;item.label='选区 '+draft.next++;}
  const logical=transport.logicalItems.map(x=>{const original=wanted.get(draftMaterialKey(x)),attachment=additions.find(item=>item.id===x.attachmentId);if(!attachment)throw Error('新增图片缺少对应材料页，原草稿已保留。');return normalizedLogical(draft,{...original,attachmentId:x.attachmentId,region:x.region||'',thumbnail:x.thumbnail||original.thumbnail},attachment,original.course||draft.course);});
  for(const shared of diff.shared){const attachment=draft.items.find(x=>x.id===shared.physical.id);if(!attachment)throw Error('共享背景已变化，原草稿已保留。');shareBackgroundAsset(draft,attachment,shared.item);logical.push(normalizedLogical(draft,{...shared.item,region:shared.region},attachment,shared.item.course||draft.course));}
  for(const shared of diff.sharedRemoved){const attachment=draft.removed.find(x=>x.id===shared.physical.id);if(!attachment)throw Error('已删除的共享背景已变化，原草稿已保留。');shareBackgroundAsset(draft,attachment,shared.item);const key=draftMaterialKey(shared.item),item=normalizedLogical(draft,{...shared.item,region:shared.region,removalGeneration:draft.removalGenerations[key],removedAt:draft.removalTimes[key]},attachment,shared.item.course||draft.course);draft.removedLogical.push(item);}
  clearRestored(draft,new Set(logical.map(draftMaterialKey)));draft.items.push(...additions);draft.logicalItems.push(...logical);
  for(const physical of [...draft.items,...draft.removed])includeLogicalKeys(physical,allLogical(draft).filter(x=>x.attachmentId===physical.id));if(!draft.course.course)draft.course={...draft.course,course:plan.title||'课后整理'};if(!draft.lessonKey)draft.lessonKey='plan:'+plan.id;
  for(const selection of plan.logicalItems.filter(item=>item.kind==='selection'&&/^[a-f0-9-]{36}$/i.test(item.contextSupplementId||''))){const key=draftMaterialKey(selection);for(const item of allLogical(draft).filter(value=>draftMaterialKey(value)===key)){delete item.missingContext;item.contextKey=selection.contextKey;item.contextSupplementId=selection.contextSupplementId;}}
  if(plan.background)for(const selection of plan.logicalItems.filter(x=>x.kind==='selection')){const context=draftContextKey(selection);if(context&&!draft.providedKeys.includes(context))draft.providedKeys.push(context);}
  draft.seen.includes(plan.id)||draft.seen.push(plan.id);return additions;
}
function planPrompt(draft,positions){
  const rows=[DRAFT_START,'以下是我保存的课堂材料；图号对应本次附件，区域号对应图内标注。不同截取时刻的板书可能不同。'];
  if(draft.course.notes)rows.push('本次补充背景：'+draft.course.notes);
  let lastSource='';const materialRows=[],shown=new Set();
  for(const x of draft.logicalItems){const number=positions?.[x.attachmentId]??draft.items.findIndex(i=>i.id===x.attachmentId)+1;
    const c=x.course||{},source=[c.school,c.course?'《'+c.course+'》':'',c.teacher?'教师 '+c.teacher:'',x.markTitle,'视频时间 '+draftTime(x.time)].filter(Boolean).join(' · ');
    const row=`图${number}${x.region?' · '+x.region:''}：${x.originalLabel||x.label}${x.boardSource?'，来源 '+x.boardSource:''}。`,key=JSON.stringify([source,row]);if(shown.has(key))continue;shown.add(key);
    if(source!==lastSource){materialRows.push(source+'：');lastSource=source;}
    materialRows.push(row);
  }
  rows.push(materialRows.join('\n'),...missingContextNotes(draft),...referenceNotes(draft));
  if(Object.hasOwn(draft.plan,'carryTextOverride')){if(draft.plan.carryTextOverride)rows.push(draft.plan.carryTextOverride);}
  const activeCarry=(draft.plan.carry||[]).filter(old=>old.included!==false);
  if(activeCarry.length){if(!draft.plan.carryTextOverride)rows.push('【我选择带入的旧提问】','旧问题里的图号和先后顺序保留原文；下方来源对应本次附件，指向不明时请先确认。');for(const old of activeCarry){const questions=carryQuestions(old);for(const q of questions)rows.push(quoteDraftText(`${carriedQuestionSource(draft,q,positions)}：\n${q.text}`));if(old.extra)rows.push(quotedCarriedText(draft,old,old.extra,positions));if(!questions.length&&!old.extra&&old.text)rows.push('原提问原文（其中图号属于原消息）：\n'+quotedCarriedText(draft,old,old.text,positions));}}
  rows.push('请优先回答我的问题，说明符号、条件和必要推导；看不清或背景缺失时请指出，不要猜造。',DRAFT_QUESTIONS);
  if(draft.questionPrelude)rows.push(draft.questionPrelude);
  for(const x of draftQuestionItems(draft))rows.push(`针对${x.label}（${questionImageSource(draft,x,positions)}，来自 ${x.source}），我的问题：\n${draft.questions[x.id]||''}`);
  rows.push(DRAFT_END,draft.extra||'');return rows.join('\n\n');
}
export function appendCapture(draft,batch){
  if(draft.seen.includes(batch.id))return [];
  if(batch.contextFor){const reference=draftMaterialKey(batch.selection);for(const item of allLogical(draft))if(draftMaterialKey(item)===reference){delete item.missingContext;item.contextKey=batch.contextKey;}}
  materialState(draft);if(draft.lessonKey&&draft.lessonKey!==batch.lessonKey&&draft.items.length&&!draft.plan){ensureLogicalDraft(draft);draft.plan={id:draft.id,title:'课堂材料',carry:[]};}
  if(draft.lessonKey&&draft.lessonKey!==batch.lessonKey&&!draft.items.length&&!draft.plan){draft.course={};draft.seeded=false;draft.contextStarted=false;draft.contextTime=null}
  const contextKey=batch.contextKey||batch.lessonKey;
  if(draft.contextKey&&draft.contextKey!==contextKey){draft.seeded=!!batch.contextAlreadySent;draft.contextStarted=draft.seeded}
  draft.contextKey=contextKey;
  draft.seen.push(batch.id);if(!draft.plan)draft.course={...batch.course,...Object.fromEntries(Object.entries(draft.course).filter(([,v])=>v))};draft.lessonKey=batch.lessonKey;
  const added=[];
  const known=allLogical(draft),backgrounds=new Set(known.filter(x=>x.kind==='board'||x.kind==='panorama').map(x=>draftBackgroundKey(x,contextKey))),seenKeys=new Set(known.map(draftMaterialKey));
  if(!draft.contextStarted&&!draft.providedKeys.includes(contextKey)&&!batch.contextAlreadySent){draft.contextTime=batch.time;for(const x of batch.context)if(!backgrounds.has(draftBackgroundKey(x,contextKey))&&!seenKeys.has(draftMaterialKey(x))){const id=materialId(draft,x);added.push({...x,id,ref:{...itemRef(x)},course:{...batch.course},lessonKey:batch.lessonKey,contextKey,roi:x.roi?{...x.roi}:undefined});seenKeys.add(draftMaterialKey(x));}}
  draft.contextStarted=true;if(!draft.providedKeys.includes(contextKey))draft.providedKeys.push(contextKey);
  if(!seenKeys.has(draftMaterialKey(batch.selection))){const id=materialId(draft,batch.selection);added.push({...batch.selection,id,ref:{...itemRef(batch.selection)},course:{...batch.course},lessonKey:batch.lessonKey,contextKey,roi:{...batch.selection.roi},label:'选区 '+draft.next++});}
  if(draft.logicalItems)for(const item of added)draft.logicalItems.push(normalizedLogical(draft,item,item,batch.course,true));draft.items.push(...added);return added;
}
export function removeDraftItem(draft,id,{user=true,removedAt=Date.now(),keepQuestion=true}={}){
  const index=draft.items.findIndex(x=>x.id===id);if(index<0)return false;
  materialState(draft);const contents=draft.logicalItems?draft.logicalItems.filter(x=>x.attachmentId===id):[draft.items[index]];
  if(!keepQuestion)for(const item of contents)removeInlineQuestion(draft,item.id);
  draft.questionOrder??=draftQuestionItems(draft).map(value=>value.id);
  for(const item of contents)retainImageQuestion(draft,item,keepQuestion);
  draft.items[index].removalPosition=removalPosition(draft.items,draft.items[index]);
  if(draft.logicalItems)for(const item of contents)item.removalPosition=removalPosition(draft.logicalItems,item);
  for(const item of contents){const key=draftMaterialKey(item);if(user){draft.removalGenerations[key]=(draft.removalGenerations[key]||0)+1;draft.removalTimes[key]=Number.isFinite(removedAt)?removedAt:Date.now();}item.removalGeneration=draft.removalGenerations[key]||0;item.removedAt=draft.removalTimes[key]||0;}
  if(draft.logicalItems){draft.removedLogical??=[];draft.removedLogical.push(...contents);draft.logicalItems=draft.logicalItems.filter(x=>x.attachmentId!==id)}
  const physical=draft.items.splice(index,1)[0];includeLogicalKeys(physical,contents);draft.removed.push(physical);return true;
}
export function prepareDraftUndo(draft,id=draft.removed.at(-1)?.id){const item=draft.removed.find(x=>x.id===id);if(!item)return null;materialState(draft);const logical=draft.logicalItems?(draft.removedLogical||[]).filter(x=>x.attachmentId===item.id):[item],keys=logical.map(draftMaterialKey);return {item,logical,refs:logical.map(x=>({...itemRef(x)})),generations:Object.fromEntries(logical.map(x=>[draftMaterialKey(x),draft.removalGenerations?.[draftMaterialKey(x)]||x.removalGeneration||0])),requiresProjection:item.kind==='collection'&&(item.logicalKeys||keys).some(key=>!keys.includes(key))};}
export function draftUndoCurrent(draft,proposal){const current=prepareDraftUndo(draft,proposal.item.id);return !!current&&current.logical.length===proposal.logical.length&&current.logical.every(x=>proposal.generations[draftMaterialKey(x)]===(draft.removalGenerations[draftMaterialKey(x)]||0));}
export function applyDraftUndo(draft,proposal,projection=null){
  if(!draftUndoCurrent(draft,proposal)){const error=Error('删除状态已变化，保留当前草稿。');error.code='draft_restore_changed';throw error;}
  if(!draft.logicalItems&&draft.items.length&&proposal.logical.some(x=>x.lessonKey&&x.lessonKey!==draft.lessonKey)){ensureLogicalDraft(draft);draft.plan={id:draft.id,title:'课堂材料',carry:[]};proposal=prepareDraftUndo(draft,proposal.item.id);}
  if(proposal.requiresProjection&&!projection){const error=Error('撤回需要重新整理材料页。');error.code='draft_projection_required';throw error;}
  const originalItem={...proposal.item,logicalKeys:[...(proposal.item.logicalKeys||proposal.logical.map(draftMaterialKey))]},originalLogical=proposal.logical.map(x=>({...x,ref:{...itemRef(x)},course:x.course?{...x.course}:undefined})),originalIndex=draft.removed.indexOf(proposal.item),keys=new Set(proposal.logical.map(draftMaterialKey)),detachedQuestions=(draft.detachedQuestions||[]).filter(item=>keys.has(draftMaterialKey(item)));
  let items=[proposal.item],logical=proposal.logical;
  if(projection){
    const received=projection.logicalItems.map(draftMaterialKey);if(received.length!==keys.size||new Set(received).size!==keys.size||received.some(key=>!keys.has(key)))throw Error('撤回材料与当前删除记录不一致。');
    items=projection.items.map(x=>({...x,materialId:x.materialId||projection.id,sourceMaterialId:x.sourceMaterialId||proposal.item.sourceMaterialId||proposal.item.materialId,logicalKeys:projection.logicalItems.filter(l=>l.attachmentId===x.id).map(draftMaterialKey)}));
    logical=projection.logicalItems.map(x=>{const original=proposal.logical.find(l=>draftMaterialKey(l)===draftMaterialKey(x)),attachment=items.find(p=>p.id===x.attachmentId);if(!attachment)throw Error('撤回图片缺少对应材料页。');return normalizedLogical(draft,{...original,region:x.region||'',thumbnail:x.thumbnail||original.thumbnail},attachment,original.course,true);});
  }
  const sources=backgroundSources(draft).active,restoredPlan={items,logicalItems:logical};
  if(!draft.logicalItems&&logical.some(item=>reusableBackground(item,restoredPlan,sources)))ensureLogicalDraft(draft);
  logical=logical.map(item=>{const shared=reusableBackground(item,restoredPlan,sources);return shared?normalizedLogical(draft,{...item,region:shared.region},shared.physical,item.course,true):item});
  items=items.filter(item=>logical.some(value=>value.attachmentId===item.id||!value.attachmentId&&value.id===item.id));
  if(items.some(item=>draft.items.some(x=>x.id===item.id)))throw Error('撤回图片已在当前草稿中。');
  clearRestored(draft,keys);insertRestored(draft.items,items,proposal.item.removalPosition);
  if(draft.logicalItems)for(const item of logical)insertRestored(draft.logicalItems,[item],proposal.logical.find(value=>value.id===item.id)?.removalPosition);
  if(draft.detachedQuestions)draft.detachedQuestions=draft.detachedQuestions.filter(item=>!logical.some(value=>value.id===item.id));
  for(const item of draft.items)includeLogicalKeys(item,logical.filter(value=>(value.attachmentId||value.id)===item.id));
  restoreInlineQuestions(draft,logical.map(item=>item.id));
  return {items,logical,originalItem,originalLogical,originalIndex,detachedQuestions,generations:{...proposal.generations}};
}
export function rollbackDraftUndo(draft,transaction){
  const keys=new Set(transaction.originalLogical.map(draftMaterialKey)),restorable=new Set([...keys].filter(key=>(draft.removalGenerations[key]||0)===transaction.generations[key]&&logicalDraftItems(draft).some(x=>draftMaterialKey(x)===key))),current=new Map(logicalDraftItems(draft).filter(x=>restorable.has(draftMaterialKey(x))).map(x=>[draftMaterialKey(x),x]));
  if(draft.inline?.pendingRestores){const ids=new Set(transaction.originalLogical.filter(item=>restorable.has(draftMaterialKey(item))).map(item=>item.id));draft.inline={...draft.inline,pendingRestores:draft.inline.pendingRestores.filter(id=>!ids.has(id))};}
  const removedItems=[];for(const item of transaction.items){const contained=logicalDraftItems(draft).filter(x=>(x.attachmentId||x.id)===item.id);if(contained.length&&contained.every(x=>restorable.has(draftMaterialKey(x)))){draft.items=draft.items.filter(x=>x.id!==item.id);removedItems.push(item);}}
  if(draft.logicalItems)draft.logicalItems=draft.logicalItems.filter(x=>!restorable.has(draftMaterialKey(x)));
  for(const item of transaction.detachedQuestions||[])if(restorable.has(draftMaterialKey(item)))retainImageQuestion(draft,item,true);
  if(restorable.size){const restored=transaction.originalLogical.filter(x=>restorable.has(draftMaterialKey(x))).map(x=>({...x,course:current.get(draftMaterialKey(x))?.course||x.course}));if(draft.logicalItems){draft.removedLogical??=[];draft.removedLogical.push(...restored);}const item=transaction.originalItem;if(!draft.removed.some(x=>x.id===item.id))draft.removed.splice(Math.min(transaction.originalIndex,draft.removed.length),0,item);}
  return removedItems;
}
export function undoDraftItem(draft){const proposal=prepareDraftUndo(draft);if(!proposal)return;return applyDraftUndo(draft,proposal).items[0];}
export function draftPrompt(draft,positions){
  if(draft.inline)return inlineDraftPrompt(draft,compactDraftContext(draft,positions),positions);
  if(draft.plan)return planPrompt(draft,positions);
  const info=draft.course,context=draft.items.filter(x=>x.kind!=='selection'),selections=draftQuestionItems(draft);
  const rows=[DRAFT_START,`课程：${[info.school,info.course?'《'+info.course+'》':''].filter(Boolean).join(' · ')||'未识别'}。${info.teacher?'授课教师：'+info.teacher+'。':''}`];
  if(info.notes?.trim())rows.push('补充课程背景：'+info.notes.trim());
  rows.push(context.length?'背景图包括本次保留的全景或板书区域；各图的截取时刻与所属标记分别列在下方。':missingContextNotes(draft).length?'本次背景未完整采集，请依据保留的局部图和我的问题回答。':draft.seeded?'沿用本对话此前提供的课堂背景；本次只补充以下圈选内容。':'本次背景图已移除，请根据保留的圈选图与我的问题理解上下文。');
  rows.push('图号对应本次附件；选区名称固定。');
  rows.push(draft.items.map((x,i)=>`图${positions?.[x.id]??i+1}：${x.markTitle?x.markTitle+' / ':''}${x.label}${x.kind==='selection'?'，截自 '+x.source:''}；视频时间 ${draftTime(x.time)}。`).join('\n'));
  rows.push(...missingContextNotes(draft),...referenceNotes(draft));
  rows.push('不同截取时刻的板书可能不同。请结合背景优先回答我的问题，说明符号、条件和必要推导；看不清或背景缺失时请指出，不要猜造。',DRAFT_QUESTIONS);
  if(draft.questionPrelude)rows.push(draft.questionPrelude);
  for(const x of selections)rows.push(`针对${x.label}（${questionImageSource(draft,x,positions)}，来自 ${x.source}），我的问题：\n${draft.questions[x.id]||''}`);
  if(!selections.length)rows.push(NO_SELECTION);
  rows.push(DRAFT_END,draft.extra||'');return rows.join('\n\n');
}
function missingContextNotes(draft){const seen=new Set(),notes=[];for(const item of logicalDraftItems(draft))if(item.missingContext?.length){const key=draftContextKey(item)||item.snapshotId||item.id;if(seen.has(key))continue;seen.add(key);notes.push(`${item.markTitle||'截图'} · ${draftTime(item.time)}：未采集到${item.missingContext.map(x=>x.label).join('、')}，这些背景尚未提供。`);}return notes;}
function referenceNotes(draft){return draft.referenceNotice?[draft.referenceNotice]:[];}
function recordReferenceChange(draft,previous,positions){
  if(!previous||![draft.questionPrelude,draft.extra,...Object.values(draft.questions)].some(text=>text?.trim()))return;
  const old=canonicalQuestionSlots(previous),next=draftQuestionItems(draft),changes=[];
  for(const item of next){const prior=old.find(match=>match[1]===item.label)?.[0].match(/（(图\d+(?: · [^，]+)?)/)?.[1],current=questionImageSource(draft,item,positions);if(prior&&prior!==current)changes.push(item.label+'：'+prior+' → '+current);}
  const remaining=new Set(next.map(item=>item.label)),oldOrder=old.map(match=>match[1]).filter(label=>remaining.has(label)),nextOrder=next.map(item=>item.label).filter(label=>oldOrder.includes(label)),reordered=oldOrder.join('|')!==nextOrder.join('|');
  if(changes.length||reordered)draft.referenceNotice='材料调整：'+[...changes,reordered?'问题排列已调整':''].filter(Boolean).join('；')+'。用户原文未改写；其中“第几张图”“前面”等指向请结合来源核对，不明确时先确认。';
}
// Only standalone headings in the current block are syntax. Carried text is quoted.
const headingIndices=(text,heading)=>[...text.matchAll(new RegExp('^'+heading+'(?=\\n|$)','gm'))].map(x=>x.index);
const withoutSeparator=(text,leading=false)=>{if(leading&&text.startsWith('\n\n'))text=text.slice(2);return text.endsWith('\n\n')?text.slice(0,-2):text;};
const canonicalQuestionSlots=section=>[...section.matchAll(/^针对(选区 \d+)（[^\n]*?），我的问题：\n/gm)];
function questionSlots(section,template=''){
  const canonical=new Map(canonicalQuestionSlots(section).map(match=>[match.index,match]));
  const headers=new Map(canonicalQuestionSlots(template).map(match=>[match[1],match[0].slice(0,-1)]));
  return [...section.matchAll(/^针对(选区 \d+)（[^\n]*?），我的问题：[ \t]*(?:\n)?/gm)].map(match=>{
    const header=headers.get(match[1]);if(!header)return canonical.get(match.index)||match;
    // Use the saved header so punctuation in a source name or the question
    // cannot be mistaken for the boundary between them.
    if(!section.startsWith(header,match.index)){match.invalid=true;return match;}
    match[0]=header+section.slice(match.index+header.length).match(/^[ \t]*(?:\n)?/)[0];return match;
  });
}
export function draftTextParts(draft,text,previous=''){
  if(draft.inline)return inlineTextParts(draft,text,previous);
  text=String(text||'').replace(/\r/g,'');
  const starts=headingIndices(text,DRAFT_START),questions=headingIndices(text,DRAFT_QUESTIONS),ends=headingIndices(text,DRAFT_END);
  if(!starts.length)return {valid:false,freeform:true,reason:'提问草稿已改为自由文字，原文已保留。'};
  if(starts.length!==1||questions.length!==1||ends.length!==1||starts[0]>=questions[0]||questions[0]>=ends[0])return {valid:false,reason:'提问区的段落标题已修改或重复，原文已保留。'};
  const oldQuestions=headingIndices(previous,DRAFT_QUESTIONS),oldEnd=headingIndices(previous,DRAFT_END);
  const oldSection=oldQuestions.length===1&&oldEnd.length===1?previous.slice(oldQuestions[0]+DRAFT_QUESTIONS.length,oldEnd[0]):'';
  const start=starts[0],questionStart=questions[0],end=ends[0],section=text.slice(questionStart+DRAFT_QUESTIONS.length,end),matches=questionSlots(section,oldSection);
  const known=[...logicalDraftItems(draft),...draft.removed,...(draft.removedLogical||[]),...(draft.detachedQuestions||[]),...(draft.archivedQuestions||[])];
  const labels=new Set(),values={};
  for(let i=0;i<matches.length;i++){
    const m=matches[i],item=known.find(x=>x.label===m[1]);
    if(m.invalid||!item||labels.has(m[1]))return {valid:false,reason:'问题槽已修改或重复，原文已保留。'};
    labels.add(m[1]);values[item.id]=withoutSeparator(section.slice(m.index+m[0].length,matches[i+1]?.index??section.length));
  }
  if(oldQuestions.length===1&&oldEnd.length===1){
    const expected=questionSlots(oldSection);
    if(expected.some(x=>!labels.has(x[1])))return {valid:false,reason:'问题槽标题已修改，原文已保留。'};
  }
  let prelude=withoutSeparator(section.slice(0,matches[0]?.index??section.length),true);
  if(!matches.length&&oldQuestions.length===1&&oldEnd.length===1){
    if(!questionSlots(oldSection).length&&headingIndices(oldSection,NO_SELECTION).length){const note=headingIndices(prelude,NO_SELECTION).at(-1);if(note!==undefined){const tail=prelude.slice(note+NO_SELECTION.length);prelude=withoutSeparator(prelude.slice(0,note))+(tail.startsWith('\n\n')?tail.slice(2):tail);}}
  }
  const extra=text.slice(end+DRAFT_END.length);return {valid:true,start,prefix:text.slice(0,start),head:withoutSeparator(text.slice(start,questionStart)),questions:values,prelude,extra:extra.startsWith('\n\n')?extra.slice(2):extra};
}
function splitDraftHead(head){const start=head.indexOf('【我选择带入的旧提问】'),end=head.lastIndexOf('请优先回答我的问题，');return start<0?{base:head,carry:''}:{base:head.slice(0,start)+head.slice(end>start?end:head.length),carry:head.slice(start,end>start?end:head.length).replace(/\n\n$/,'')};}
function rollbackCarryHeadEdit(plan,edit){
  if(plan.carryTextOverride!==edit.current)return;
  for(const change of edit.effects||[]){const carried=plan.carry?.find(item=>item.headEditIdentity===change.id);if(!carried||carried.included!==false)continue;
    const restored={...carried};if(change.hadIncluded)restored.included=change.included;else delete restored.included;
    const questions=carryQuestions(restored),text=carryText(restored),alreadySelected=restored.included!==false&&plan.carry.some(other=>other!==carried&&other.included!==false&&other.id===carried.id&&questions.every((question,index)=>carryQuestions(other).some((candidate,n)=>carryQuestionIdentity(candidate,n)===carryQuestionIdentity(question,index)))&&(!text||carryTextIdentity(other)===carryTextIdentity(restored)));
    if(alreadySelected)continue;if(change.hadIncluded)carried.included=change.included;else delete carried.included;
  }
  if(edit.hadOverride)plan.carryTextOverride=edit.override;else delete plan.carryTextOverride;
}
function applyCarryHeadEdit(draft,before,current){
  if(!draft.plan)return;const plan=draft.plan,handled=plan.carryHeadEdit;
  if(before===current){if(handled?.before===before)rollbackCarryHeadEdit(plan,handled);delete plan.carryHeadEdit;return;}
  if(handled?.before===before&&handled.current===current)return;
  const sameBaseline=handled?.before===before;
  if(sameBaseline)rollbackCarryHeadEdit(plan,handled);
  const affected=sameBaseline?new Set((handled.effects||[]).map(change=>change.id)):null;
  const edit={before,current,hadOverride:Object.hasOwn(plan,'carryTextOverride'),override:plan.carryTextOverride,effects:[]};
  for(const carried of plan.carry||[]){if(affected&&!affected.has(carried.headEditIdentity))continue;carried.headEditIdentity??=crypto.randomUUID();edit.effects.push({id:carried.headEditIdentity,hadIncluded:Object.hasOwn(carried,'included'),included:carried.included});carried.included=false;}
  plan.carryTextOverride=current;plan.carryHeadEdit=edit;
}
export function readDraftQuestions(draft,text,{previous=''}={}){
  const parts=draftTextParts(draft,text,previous);if(!parts.valid)return false;
  if(draft.inline){
    const old=draftTextParts(draft,previous||draftPrompt(draft)),oldHead=splitDraftHead(old.head||''),nextHead=splitDraftHead(parts.head||'');
    if(draft.plan&&old.valid)applyCarryHeadEdit(draft,oldHead.carry,nextHead.carry);
    readInlineDraft(draft,text,previous);
    return true;
  }
  if(draft.plan){const old=draftTextParts(draft,previous||draftPrompt(draft));if(old.valid)applyCarryHeadEdit(draft,splitDraftHead(old.head).carry,splitDraftHead(parts.head).carry);}
  Object.assign(draft.questions,parts.questions);draft.questionPrelude=parts.prelude;draft.extra=parts.extra;return true;
}
export function mergeDraftPrompt(draft,current,previous,positions,{sourceDraft=draft,questionOverrides={},force=false,clear=false}={}){
  if(draft.inline){readDraftQuestions(sourceDraft,current,{previous});return mergeInlineDraft(draft,current,previous,positions,{sourceDraft,context:compactDraftContext(draft,positions),clear});}
  const parts=draftTextParts(sourceDraft,current,previous);
  let prefix=parts.valid?parts.prefix:(current.trim()?current.trim()+'\n\n':'');
  if(previous){
    if(!parts.valid){
      if(clear&&parts.freeform)return current;
      if(!force)throw Error(parts.reason);
      prefix=current.trim()?'【保留的原提问】\n'+quoteDraftText(current)+'\n\n':'';
      for(const item of draftQuestionItems(draft))draft.questions[item.id]='';
      draft.questionPrelude='';draft.extra='';
    }else{
      readDraftQuestions(sourceDraft,current,{previous});
      const oldParts=draftTextParts(sourceDraft,previous),oldHead=splitDraftHead(oldParts.head||''),editedHead=splitDraftHead(parts.head),changed=oldParts.valid&&(parts.head.replace(/\s+/g,' ')!==oldParts.head.replace(/\s+/g,' ')||oldHead.carry!==editedHead.carry);
      if(changed&&!force)throw Error('背景说明已被手动修改，原文已保留。');
      if(changed){
        if(draft.plan&&oldHead.carry!==editedHead.carry)applyCarryHeadEdit(draft,oldHead.carry,editedHead.carry);
        const previousParagraphs=new Set(oldHead.base.split('\n\n')),notes=editedHead.base.split('\n\n').filter(paragraph=>paragraph&&paragraph!==DRAFT_START&&!previousParagraphs.has(paragraph));
        if(notes.length){const note='【保留的原说明】\n'+quoteDraftText(notes.join('\n\n'))+'\n\n';if(!prefix.includes(note))prefix+=note;}
      }
      if(sourceDraft!==draft){
        draft.questions={...draft.questions,...sourceDraft.questions};draft.extra=sourceDraft.extra;draft.questionPrelude=sourceDraft.questionPrelude;
        const omitted=logicalDraftItems(sourceDraft).filter(x=>(x.kind==='selection'||x.ask)&&!logicalDraftItems(draft).some(y=>y.id===x.id)&&sourceDraft.questions[x.id]?.trim());
        if(omitted.length)draft.extra=[draft.extra,'【本次未附原图的既有问题】\n'+quoteDraftText(omitted.map(x=>(x.source||x.label)+'：\n'+sourceDraft.questions[x.id]).join('\n\n'))].filter(Boolean).join('\n\n');
      }
    }
  }else if(headingIndices(current,DRAFT_START).length)prefix='【保留的原提问】\n'+quoteDraftText(current)+'\n\n';
  applyDraftQuestionFields(draft,questionOverrides);
  if(clear)return prefix+[draft.plan?.carryTextOverride,draft.questionPrelude,...(draft.detachedQuestions||[]).filter(item=>draft.questions[item.id]?.trim()).map(item=>(item.source||item.label)+'：\n'+draft.questions[item.id]),draft.extra].filter(Boolean).join('\n\n');
  recordReferenceChange(draft,previous,positions);
  return prefix+draftPrompt(draft,positions);
}

// Recover only the old metadata-only draft shape whose generated footer was
// read back as question prose after the rich editor collapsed its first line.
// The saved history must prove the complete old formatter output; every other
// word, including hidden removed questions, prevents this migration.
export function repairLegacyInlineContext(draft,manifest,positions){
  const state=draft.inline,known=[...draft.items,...draft.removed],core=text=>String(text||'').replace(/\r/g,'').replace(/^\n+|\n+$/g,'');
  if(!state||state.suppressed!==true||state.context||state.customContext!==undefined||state.removedContext||draft.plan||draft.logicalItems||!known.length||known.some(item=>!['panorama','board','selection'].includes(item.kind)||item.region))return null;
  const snapshots=new Set(known.map(item=>(item.ref||item).snapshotId));if(snapshots.size!==1||snapshots.has(undefined)||snapshots.has(''))return null;
  const order=String(manifest.attachmentOrder||'').split('\n'),numbers={};if(order.length!==draft.items.length)return null;
  for(const item of known){const index=draft.items.includes(item)?order.indexOf(manifest.files?.[item.id]):item.nativeAttachmentIndex;if(!Number.isSafeInteger(index)||index<0)return null;numbers[item.id]=index+1;}
  if(new Set(Object.values(numbers)).size!==known.length||Object.values(numbers).some(number=>number>known.length))return null;
  const ordered=[],seenItems=new Set();for(const source of [...draft.contextMaterials||[],...known]){const item=known.find(value=>draftMaterialKey(value)===draftMaterialKey(source));if(item&&!seenItems.has(item.id)){seenItems.add(item.id);ordered.push(item);}}
  const rows=[],info=manifest.draft?.course||draft.course||{},course=[info.school,info.course,info.teacher].filter(Boolean).join(' · ');if(course)rows.push(course);if(info.notes?.trim())rows.push(info.notes.trim());
  let prior='';const seenRows=new Set();
  for(const item of ordered){const origin=[item.markTitle,Number.isFinite(item.time)?draftTime(item.time):''].filter(Boolean).join(' · ');if(origin&&origin!==prior){rows.push(origin);prior=origin;}const label=item.originalLabel||item.label,source=item.boardSource||item.source||'',row=['图 '+numbers[item.id],label,source&&!source.includes(label)?source:''].filter(Boolean).join(' · ');if(!seenRows.has(row)){rows.push(row);seenRows.add(row);}}
  rows.push(...missingContextNotes({...draft,items:ordered}));const canonical=core('\n\n—\n'+rows.join('\n'));
  if(!(manifest.previousComposerTexts||[]).some(text=>typeof text==='string'&&core(text)===canonical)||core(manifest.composerText)!==core(state.text))return null;
  const sourceMatches=ref=>{const item=known.find(item=>item.id===ref.id);return item&&draftMaterialKey(ref.ref||ref)===draftMaterialKey(item);};
  const refs=[...state.refs].sort((a,b)=>a.start-b.start);let cursor=0,plain='';const optionalSpaces=new Set();
  for(const ref of refs){if(!sourceMatches(ref)||ref.start<cursor||state.text.slice(ref.start,ref.end)!==ref.token)return null;plain+=state.text.slice(cursor,ref.start);if(plain.endsWith(' '))optionalSpaces.add(plain.length-1);cursor=ref.end+(state.text[ref.end]===' '?1:0);if(state.text[cursor]===' ')optionalSpaces.add(plain.length);}
  plain+=state.text.slice(cursor);const leading=plain.match(/^\n*/)[0].length;plain=core(plain);const optional=new Set([...optionalSpaces].map(index=>index-leading));
  let a=0,b=0;while(a<plain.length||b<canonical.length){if(plain[a]===' '){let end=a;while(plain[end]===' ')end++;let wanted=b;while(canonical[wanted]===' ')wanted++;const required=Array.from({length:end-a},(_,index)=>a+index).filter(index=>!optional.has(index)).length;if(wanted-b<required||wanted-b>end-a)return null;a=end;b=wanted;}else if(plain[a]!==canonical[b])return null;else{a++;b++;}}
  let legacyWords=state.text;for(const ref of [...refs].reverse())legacyWords=legacyWords.slice(0,ref.start)+legacyWords.slice(ref.end);legacyWords=legacyWords.trim();
  const parts=inlineTextParts(draft,state.text,manifest.previous||''),referenceIds=new Set(refs.map(ref=>ref.id));if((draft.questionPrelude||'')!==parts.prelude&&!(refs.length===0&&draft.questionPrelude===legacyWords)||draft.extra||Object.entries(draft.questions).some(([id,text])=>text&&text!==(parts.questions[id]||'')&&(!referenceIds.has(id)||text!==legacyWords)))return null;
  for(const removed of Object.values(state.removed||{}))for(const piece of removed.pieces||[]){let rest=piece.text,last=0;for(const ref of [...piece.refs||[]].sort((a,b)=>b.start-a.start)){if(!sourceMatches(ref)||ref.start<0||ref.end>piece.text.length||piece.text.slice(ref.start,ref.end)!==ref.token)return null;rest=rest.slice(0,ref.start)+rest.slice(ref.end);last++;}if(!last||rest.trim())return null;}
  let text='';const moved=refs.map(ref=>{if(text)text+=' ';const start=text.length;text+=ref.token;return {...ref,start,end:text.length};});if(text)text+=' ';
  const removed=Object.fromEntries(Object.entries(state.removed||{}).map(([id,value])=>[id,{...value,pieces:value.pieces.map(piece=>({...piece,at:moved.find(ref=>ref.id===piece.afterId)?.start??moved.findLast(ref=>ref.id===piece.beforeId)?.end??text.length,refs:piece.refs.map(ref=>({...ref}))}))}]));
  const nativeOrder=[...known].sort((a,b)=>numbers[a.id]-numbers[b.id]);draft.items=[...draft.items].sort((a,b)=>numbers[a.id]-numbers[b.id]);draft.removed=draft.removed.map(item=>{const index=nativeOrder.indexOf(item);return {...item,removalPosition:{index,before:nativeOrder[index-1]?.id||'',after:nativeOrder[index+1]?.id||''}};});
  draft.inline={...state,text,refs:moved,removed,suppressed:false,context:compactDraftContext(draft,positions),shared:[],sharedIds:{},singleQuestions:{}};draft.questions=Object.fromEntries(Object.keys(draft.questions).map(id=>[id,'']));draft.questionPrelude='';draft.extra='';
  return draftPrompt(draft,positions);
}

function compactDraftContext(draft,positions){
  if(!draft.items.length&&!draftCarryKeys(draft).length&&!draft.plan?.carryTextOverride)return '';
  const rows=[],info=draft.course||{},course=[info.school,info.course,info.teacher].filter(Boolean).join(' · ');
  if(info.notes?.trim())rows.push(info.notes.trim());
  const groups=new Map();
  for(const item of logicalDraftItems(draft)){
    const physical=item.attachmentId||item.id,index=draft.items.findIndex(image=>image.id===physical);if(index<0)continue;
    const origin=draft.plan?[item.course?.school,item.course?.course,item.course?.teacher].filter(Boolean).join(' · '):course,time=Number.isFinite(item.time)?draftTime(item.time):'',key=JSON.stringify([origin,time]);
    if(!groups.has(key))groups.set(key,{origin,time,items:[]});
    const label=item.originalLabel||item.label,source=item.boardSource||item.source||'',row='图 '+(positions?.[physical]||index+1)+(item.region?' · '+item.region:'')+' '+label+(source&&!source.includes(label)&&!source.includes(item.markTitle||'\u0000')?'（'+source+'）':'');
    if(!groups.get(key).items.includes(row))groups.get(key).items.push(row);
  }
  let previousCourse='';for(const group of groups.values()){if(group.origin&&group.origin!==previousCourse){rows.push(group.origin);previousCourse=group.origin;}rows.push([group.time,group.items.join(' / ')].filter(Boolean).join(' · '));}
  const carry=(draft.plan?.carry||[]).filter(old=>old.included!==false);
  if(carry.length||draft.plan?.carryTextOverride){
    rows.push('【我选择带入的旧提问】');
    if(draft.plan?.carryTextOverride)rows.push(draft.plan.carryTextOverride);
    for(const old of carry){const questions=carryQuestions(old);for(const q of questions)rows.push(quoteDraftText(carriedQuestionSource(draft,q,positions)+'：\n'+q.text));if(old.extra)rows.push(quotedCarriedText(draft,old,old.extra,positions));if(!questions.length&&!old.extra&&old.text)rows.push(quotedCarriedText(draft,old,old.text,positions));}
  }
  return rows.join('\n');
}

export function convertToInlineDraft(draft,text,previous='',positions){
  if(draft.inline)return mergeDraftPrompt(draft,text,previous,positions);
  const parts=draftTextParts(draft,text,previous);
  if(parts.valid){
    readDraftQuestions(draft,text,{previous});
    enableInlineDraft(draft,{prelude:[parts.prefix.trim(),parts.prelude].filter(Boolean).join('\n\n'),extra:parts.extra,questions:parts.questions,positions});
  }else enableInlineDraft(draft,{text,raw:true});
  draft.inline.context=draft.inline.suppressed?'':compactDraftContext(draft,positions);
  return draftPrompt(draft,positions);
}
