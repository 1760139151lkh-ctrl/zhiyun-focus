// Conversation/delivery identity is independent of screenshot and draft text models.
export const CONVERSATION_PROTOCOL=2;
const uuid=()=>crypto.randomUUID();
const id=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const copy=value=>JSON.parse(JSON.stringify(value));
const normalize=text=>text.replace(/\s+/g,' ').trim();
const targetFields=['conversationId','route','pageId','documentEpoch','routeGeneration','composerGeneration'];
export function conversationRoute(url){
  const u=new URL(url,'https://chatgpt.com/');
  if(u.origin!=='https://chatgpt.com'||u.username||u.password)throw Error('请选择有效的 ChatGPT 对话。');
  return u.pathname.replace(/\/+$/,'')||'/';
}
export function canonicalConversationId(url){
  const match=conversationRoute(url).match(/(?:^|\/)c\/([\w-]{1,128})$/);
  return match?'c:'+match[1]:null;
}
export function sameConversationTarget(a,b){return !!a&&!!b&&targetFields.every(key=>a[key]===b[key]);}
export class ConversationChangedError extends Error {
  constructor(){super('对话或输入框已切换，材料已保留，请在原目标对话重试。');this.name='ConversationChangedError';this.code='conversation_changed';}
}
function validTarget(target){
  if(!target||typeof target.conversationId!=='string'||target.conversationId.length>170||typeof target.route!=='string'||!id(target.pageId)||!integer(target.documentEpoch)||!integer(target.routeGeneration)||target.routeGeneration<1||!integer(target.composerGeneration)||target.composerGeneration<1)return false;
  try{const canonical=canonicalConversationId('https://chatgpt.com'+target.route);return conversationRoute('https://chatgpt.com'+target.route)===target.route&&(canonical?target.conversationId===canonical:target.conversationId.startsWith('provisional:')&&id(target.conversationId.slice('provisional:'.length)));}catch{return false;}
}
function validIntent(value){return value&&id(value.id)&&id(value.questionId)&&validTarget(value.target)&&typeof value.raw==='string'&&value.raw.length<=100000&&Array.isArray(value.contextKeys)&&value.contextKeys.length<=600&&value.contextKeys.every(x=>typeof x==='string'&&x.length<=400)&&Array.isArray(value.operationIds)&&value.operationIds.length<=300&&value.operationIds.every(id)&&(!value.deliveries||Array.isArray(value.deliveries)&&value.deliveries.length<=300&&value.deliveries.every(x=>x&&id(x.operationId)&&id(x.materialId)&&value.operationIds.includes(x.operationId)))&&Array.isArray(value.beforeTurnIds)&&value.beforeTurnIds.length<=3000&&value.beforeTurnIds.every(x=>typeof x==='string'&&x.length<=200)&&['pending','unknown','sent'].includes(value.status)&&(!value.observedTurnId||typeof value.observedTurnId==='string'&&value.observedTurnId.length<=200);}
function hasSendConfirmation(value){return value.target.conversationId.startsWith('c:')&&typeof value.turnId==='string'&&value.turnId.length>0&&value.turnId.length<=200&&!value.beforeTurnIds.includes(value.turnId)&&usableSendProof(value)&&(value.confirmation==='user-confirmed'||value.confirmation==='durable-history'&&value.observedTurnId===value.turnId);}
const usableSendProof=value=>value.confirmation==='user-confirmed'||value.sendCorrelation?.kind==='submit-linked'&&value.sendCorrelation.sendId===value.id&&value.sendCorrelation.turnId===value.turnId;
function savedAdoptionCandidate(intent){
  const value=intent?.adoptionCandidate;if(!value||!validTarget(value.from)||!sameConversationTarget(value.from,intent.target)||!value.from.conversationId.startsWith('provisional:')||typeof value.to!=='string'||!value.to.startsWith('c:')||typeof value.route!=='string')return null;
  try{return value.to===canonicalConversationId('https://chatgpt.com'+value.route)&&conversationRoute('https://chatgpt.com'+value.route)===value.route?value:null;}catch{return null;}
}

export function createConversationState({url='https://chatgpt.com/',storage=null,makeId=uuid,now=Date.now,liveUrl=null,maxIntents=100}={}){
  const pageId=makeId(),storageKey='__zjf_send_intents_v2';
  let route=conversationRoute(url),conversationId=canonicalConversationId(url)||'provisional:'+makeId();
  let documentEpoch=0,routeGeneration=1,composerGeneration=1,bound=false,challengeId='',candidate=null,ledgerRequest=null,ledgerVersion='';
  let contextKeys=new Set();
  const attempts=new Map(),operations=new Map(),intents=new Map();
  try{const saved=JSON.parse(storage?.getItem(storageKey)||'[]');if(Array.isArray(saved))for(const x of saved.slice(-maxIntents))if(validIntent(x)){if(x.status==='sent'&&!hasSendConfirmation(x)){x.legacySendProof={turnId:x.turnId,confirmation:x.confirmation,observedTurnId:x.observedTurnId};x.status='unknown';delete x.nativeSaved;x.reason='本地发送记录缺少可靠确认，已保留待核对。';}intents.set(x.id,x)}}catch{}
  const snapshot=()=>Object.freeze({conversationId,route,pageId,documentEpoch,routeGeneration,composerGeneration});
  let storageWarning='';
  const persist=()=>{
    if(!storage)return;
    const disposable=()=>[...intents.values()].filter(intent=>intent.status==='sent'&&intent.nativeSaved===true);
    let encoded=JSON.stringify([...intents.values()]);
    while(encoded.length*2>2*1024*1024){const oldest=disposable()[0];if(!oldest)break;intents.delete(oldest.id);encoded=JSON.stringify([...intents.values()]);}
    for(;;){try{storage.setItem(storageKey,encoded);storageWarning='';return;}catch{const oldest=disposable()[0];if(!oldest){storageWarning='本页发送记录暂存失败，请确认资料库保存提示。';return;}intents.delete(oldest.id);encoded=JSON.stringify([...intents.values()]);}}
  };
  const current=target=>bound&&sameConversationTarget(target,snapshot())&&(!liveUrl||conversationRoute(liveUrl())===target.route);
  const guard=attempt=>{const value=attempts.get(typeof attempt==='string'?attempt:attempt?.attemptId);if(!value||!current(value.target)||operations.get(value.operationId)?.attemptId!==value.attemptId||['cancelled','error'].includes(value.state))throw new ConversationChangedError();return value;};
  const invalidate=reason=>{for(const attempt of attempts.values())if(['queued','working','attached'].includes(attempt.state))attempt.state='cancelled';for(const intent of intents.values())if(intent.status==='pending'&&intent.target.conversationId===conversationId){intent.status='unknown';intent.reason=reason;}ledgerRequest=null;contextKeys=new Set();ledgerVersion='';persist();};
  function transition(nextUrl,{newConversation=false,composerChanged=true,cause='route'}={}){
    const nextRoute=conversationRoute(nextUrl),canonical=canonicalConversationId(nextUrl),old=snapshot();
    if(nextRoute===route&&!newConversation&&!composerChanged)return snapshot();
    invalidate(cause);
    const priorCandidate=candidate;
    candidate=!newConversation&&cause==='route'&&old.conversationId.startsWith('provisional:')&&canonical?{from:old,to:canonical,route:nextRoute}:!newConversation&&nextRoute===route&&cause==='composer-replaced'?priorCandidate:null;
    if(newConversation||nextRoute!==route)conversationId=canonical||'provisional:'+makeId();
    if(newConversation||nextRoute!==route)routeGeneration++;route=nextRoute;if(composerChanged)composerGeneration++;
    if(candidate){for(const intent of intents.values())if(intent.status!=='sent'&&intent.target.conversationId===candidate.from.conversationId&&intent.target.pageId===candidate.from.pageId&&intent.target.documentEpoch===candidate.from.documentEpoch)intent.adoptionCandidate={from:copy(intent.target),to:candidate.to,route:candidate.route};persist();}
    // The same document can publish a new route identity immediately; a new
    // document must answer its own native challenge before it can deliver.
    return snapshot();
  }
  function beginQuestion(){
    // A reused editor is still a new destination after Send or an explicit
    // clear. Keep conversation history and pending send evidence independent.
    for(const attempt of attempts.values())if(['queued','working'].includes(attempt.state))attempt.state='cancelled';
    composerGeneration++;ledgerRequest=null;return snapshot();
  }
  function answerChallenge(message){
    if(message?.protocol!==2||!id(message.challengeId)||!integer(message.documentEpoch)||message.documentEpoch<1||message.documentEpoch<documentEpoch)return null;
    if(documentEpoch&&message.documentEpoch!==documentEpoch){invalidate('document_changed');candidate=null;}
    documentEpoch=message.documentEpoch;challengeId=message.challengeId;bound=false;
    return {kind:'zjf-bridge-bind',protocol:2,challengeId,url:'https://chatgpt.com'+route,target:snapshot()};
  }
  function acceptBinding(message){if(message?.protocol!==2||message.challengeId!==challengeId||!sameConversationTarget(message.target,snapshot()))return false;bound=true;return true;}
  function beginDelivery(delivery){
    if(delivery?.protocol!==2||!id(delivery.materialId)||!id(delivery.operationId)||!id(delivery.attemptId)||!current(delivery.target))throw new ConversationChangedError();
    const old=operations.get(delivery.operationId);
    const confirmed=[...intents.values()].find(x=>x.status==='sent'&&usableSendProof(x)&&x.target.conversationId===delivery.target.conversationId&&x.deliveries?.some(d=>d.operationId===delivery.operationId&&d.materialId===delivery.materialId));
    if(delivery.reconcileOnly===true&&!confirmed)throw new ConversationChangedError();
    if(old&&(old.materialId!==delivery.materialId||old.target.conversationId!==delivery.target.conversationId&&confirmed?.adoptedFrom!==old.target.conversationId))throw new ConversationChangedError();
    const reused=attempts.get(delivery.attemptId);
    if(reused&&(reused.materialId!==delivery.materialId||reused.operationId!==delivery.operationId||!sameConversationTarget(reused.target,delivery.target)))throw new ConversationChangedError();
    if(old&&old.attemptId!==delivery.attemptId){const previous=attempts.get(old.attemptId);if(previous)previous.state='cancelled';}
    const attempt={...copy(delivery),target:Object.freeze(copy(delivery.target)),state:'queued'};
    if(attempts.size>=200)for(const [key,previous]of attempts)if(['cancelled','error','unknown','attached','already-sent','removed'].includes(previous.state)){attempts.delete(key);if(operations.get(previous.operationId)?.attemptId===key)operations.delete(previous.operationId);}
    if(attempts.size>=200&&!attempts.has(attempt.attemptId))throw Error('待处理的投递较多，请先处理已有草稿。');
    attempts.set(attempt.attemptId,attempt);operations.set(attempt.operationId,attempt);return Object.freeze({...attempt});
  }
  function receipt(attempt,state,{count=0,error='',evidence=''}={}){
    const value=guard(attempt);if(!integer(count)||count>300||typeof error!=='string'||error.length>1024)throw Error('投递回执无效。');value.state=state;
    return {kind:'zjf-draft-status',protocol:2,id:value.materialId,materialId:value.materialId,operationId:value.operationId,attemptId:value.attemptId,target:copy(value.target),state,count,error,evidence,verified:['attached','already-sent','removed'].includes(state)};
  }
  function finishDelivery(attempt,{verifyDraft,verifyRemoved,count}={}){
    guard(attempt);if(typeof verifyRemoved==='function'&&verifyRemoved()===true){guard(attempt);return receipt(attempt,'removed',{evidence:'composer-removal'});}
    if(typeof verifyDraft!=='function'||verifyDraft()!==true)throw Error('本次材料尚未完整出现在目标输入框。');guard(attempt);return receipt(attempt,'attached',{count,evidence:'composer'});
  }
  function reuseDelivery(attempt,{verifyDraft,verifySent,verifyRemoved,count=0}={}){
    const value=guard(attempt),sent=[...intents.values()].find(x=>x.status==='sent'&&usableSendProof(x)&&x.target.conversationId===value.target.conversationId&&x.deliveries?.some(d=>d.operationId===value.operationId&&d.materialId===value.materialId));
    if(sent&&typeof verifySent==='function'&&verifySent(copy(sent))===true){guard(attempt);return receipt(attempt,'already-sent',{evidence:'confirmed-message'});}
    if(typeof verifyRemoved==='function'&&verifyRemoved()===true){guard(attempt);return receipt(attempt,'removed',{evidence:'composer-removal'});}
    if(typeof verifyDraft==='function'&&verifyDraft()===true){guard(attempt);return receipt(attempt,'attached',{count,evidence:'composer'});}
    return null;
  }
  function beginSend({questionId,raw,contextKeys:keys=[],operationIds=[],beforeTurnIds=[],questionSnapshot=null}={}){
    if(!bound||typeof raw!=='string'||!raw.trim()||raw.length>100000||!id(questionId)||!Array.isArray(keys)||!Array.isArray(operationIds)||!Array.isArray(beforeTurnIds))throw Error('发送记录无效。');
    if(intents.size>=maxIntents){const sent=[...intents.values()].filter(x=>x.status==='sent'&&x.nativeSaved);if(!sent.length)throw Error('待确认保存的发送记录较多，请先完成已有记录的保存。');intents.delete(sent[0].id);}
    const selectedOperations=[...new Set(operationIds.filter(id))],deliveries=selectedOperations.map(operationId=>operations.get(operationId)).filter(x=>x&&x.target.conversationId===conversationId&&x.state==='attached').map(x=>({operationId:x.operationId,materialId:x.materialId}));
    const intent={id:makeId(),questionId,raw,target:copy(snapshot()),contextKeys:[...new Set(keys.filter(x=>typeof x==='string'&&x.length<=200))],operationIds:selectedOperations,deliveries,beforeTurnIds:beforeTurnIds.filter(x=>typeof x==='string'),createdAt:now(),status:'pending'};
    if(questionSnapshot)intent.questionSnapshot=copy(questionSnapshot);
    intents.set(intent.id,intent);persist();return copy(intent);
  }
  function markUnknown(sendId,reason='发送结果尚未确认。'){const intent=intents.get(sendId);if(!intent||intent.status==='sent')return false;intent.status='unknown';intent.reason=reason;persist();return true;}
  function confirmSavedQuestion(questionId,sendId,revision){
    const intent=intents.get(sendId);if(!intent||intent.questionId!==questionId||intent.status!=='sent'||!hasSendConfirmation(intent)||!Number.isSafeInteger(revision)||revision<(intent.questionSnapshot?.revision||0))return false;
    intent.nativeSaved=true;delete intent.questionSnapshot;persist();return true;
  }
  function observeSendTurn(sendId,observation){
    const intent=intents.get(sendId);if(!current(snapshot())||!intent||intent.status==='sent'||intent.target.pageId!==pageId||intent.target.documentEpoch!==documentEpoch||observation?.author!=='user'||typeof observation.turnId!=='string'||!observation.turnId||intent.beforeTurnIds.includes(observation.turnId)||typeof observation.text!=='string'||normalize(observation.text)!==normalize(intent.raw))return null;
    const own=intent.target.conversationId===conversationId&&intent.target.route===route&&intent.target.routeGeneration===routeGeneration,root=candidate&&sameConversationTarget(candidate.from,intent.target)&&candidate.to===conversationId;
    if((!own&&!root)||conversationRoute(observation.url)!==route||intent.observedTurnId&&intent.observedTurnId!==observation.turnId)return null;
    if(intent.observedTurnId)return null;intent.observedTurnId=observation.turnId;persist();return copy(intent);
  }
  function confirmSend(sendId,proof){
    const intent=intents.get(sendId);if(!current(snapshot())||!intent||intent.status==='sent'||!proof||!['durable-history','user-confirmed'].includes(proof.confirmation)||proof.author!=='user'||typeof proof.turnId!=='string'||!proof.turnId||proof.turnId.length>200||intent.beforeTurnIds.includes(proof.turnId)||typeof proof.text!=='string'||normalize(proof.text)!==normalize(intent.raw))return null;
    const canonical=canonicalConversationId(proof.url);if(!canonical||canonical!==conversationId||conversationRoute(proof.url)!==route)return null;
    if(proof.confirmation==='durable-history'&&(!intent.observedTurnId||intent.observedTurnId!==proof.turnId||proof.correlation!=='submit-linked'||proof.sendId!==intent.id))return null;
    if([...intents.values()].some(x=>x.id!==sendId&&x.status==='sent'&&x.target.conversationId===canonical&&x.turnId===proof.turnId))return null;
    const retained=savedAdoptionCandidate(intent);
    const liveAdoption=candidate&&candidate.from.conversationId===intent.target.conversationId&&candidate.from.pageId===pageId&&candidate.from.documentEpoch===documentEpoch&&candidate.to===canonical&&candidate.route===route;
    const adopting=intent.target.conversationId.startsWith('provisional:')&&(liveAdoption||retained&&retained.to===canonical&&retained.route===route);
    if(intent.target.conversationId!==canonical&&!adopting)return null;
    if(adopting){const provisional=intent.target.conversationId;for(const saved of intents.values())if(saved.target.conversationId===provisional){saved.target={...saved.target,conversationId:canonical,route};saved.adoptedFrom=provisional;saved.adoptionTurnId=proof.turnId;saved.adoptionConfirmation=proof.confirmation;delete saved.adoptionCandidate;}candidate=null;}
    intent.status='sent';intent.turnId=proof.turnId;intent.confirmation=proof.confirmation;intent.confirmedAt=now();delete intent.reason;
    if(proof.confirmation==='durable-history')intent.sendCorrelation={kind:'submit-linked',sendId:intent.id,turnId:proof.turnId};
    for(const key of intent.contextKeys)contextKeys.add(key);persist();return copy(intent);
  }
  function requestLedger(){if(!bound)throw new ConversationChangedError();ledgerRequest={requestId:makeId(),target:copy(snapshot())};return {kind:'zjf-context-request',protocol:2,...copy(ledgerRequest),url:'https://chatgpt.com'+route};}
  function applyLedger(message){
    if(message?.protocol!==2||!ledgerRequest||message.requestId!==ledgerRequest.requestId||!current(message.target)||!sameConversationTarget(message.target,ledgerRequest.target)||!Array.isArray(message.keys)||message.keys.length>600||!message.keys.every(x=>typeof x==='string'&&x.length<=400)||typeof message.ledgerVersion!=='string'||message.ledgerVersion.length>80)return false;
    const local=[...intents.values()].filter(x=>x.status==='sent'&&usableSendProof(x)&&x.target.conversationId===conversationId).flatMap(x=>x.contextKeys);
    contextKeys=new Set([...message.keys,...local]);ledgerVersion=message.ledgerVersion;ledgerRequest=null;return true;
  }
  function hydrateQuestions(questions){
    if(!Array.isArray(questions))return 0;let count=0;
    for(const question of questions.slice(0,maxIntents)){
      const saved=question?.sendIntent;if(!validIntent(saved)||saved.target.conversationId!==conversationId&&savedAdoptionCandidate(saved)?.to!==conversationId||!conversationId.startsWith('c:')||!['pending','unknown'].includes(saved.status))continue;
      const local=intents.get(saved.id);if(local){if(local.questionId===question.id&&!local.questionSnapshot&&normalize(question.text||'')===normalize(local.raw)&&(local.status!=='sent'||!local.nativeSaved&&hasSendConfirmation(local))){const snapshot=copy(question);delete snapshot.sendIntent;local.questionSnapshot=snapshot;count++;}continue;}
      if(intents.size>=maxIntents){const confirmed=[...intents.values()].find(intent=>intent.status==='sent'&&intent.nativeSaved);if(!confirmed){storageWarning='待确认记录较多，尚有记录保留在学习资料中。';break;}intents.delete(confirmed.id);}
      const snapshot=copy(question);delete snapshot.sendIntent;intents.set(saved.id,{...copy(saved),status:'unknown',questionSnapshot:snapshot});count++;
    }if(count)persist();return count;
  }
  return {
    snapshot,transition,beginQuestion,answerChallenge,acceptBinding,isCurrent:current,assertCurrent:guard,
    async after(attempt,promise){const value=await promise;guard(attempt);return value;},
    mutate(attempt,action){guard(attempt);return action();},
    beginDelivery,receipt,finishDelivery,reuseDelivery,beginSend,markUnknown,confirmSavedQuestion,observeSendTurn,confirmSend,requestLedger,applyLedger,hydrateQuestions,
    handshake:()=>({kind:'zjf-conversation-state',protocol:2,url:'https://chatgpt.com'+route,target:snapshot()}),
    ownsSendIntent:intent=>intent?.target?.conversationId===conversationId||!!candidate&&candidate.from.conversationId===intent?.target?.conversationId&&candidate.from.pageId===pageId&&candidate.from.documentEpoch===documentEpoch||savedAdoptionCandidate(intent)?.to===conversationId,
    providedContext:()=>[...contextKeys],ledgerVersion:()=>ledgerVersion,
    sendIntents:()=>[...intents.values()].map(copy),storageWarning:()=>storageWarning,dispose(){invalidate('document_closed');bound=false;}
  };
}
