const fields=['conversationId','route','pageId','documentEpoch','routeGeneration','composerGeneration'];
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const sameTarget=(a,b)=>!!a&&!!b&&fields.every(key=>a[key]===b[key])&&(a.draftId===undefined||b.draftId===undefined||a.draftId===b.draftId);

export function captureTarget(value){
  if(!value||typeof value.conversationId!=='string'||!value.conversationId||typeof value.route!=='string'||!uuid(value.pageId)||!['documentEpoch','routeGeneration','composerGeneration'].every(key=>Number.isSafeInteger(value[key])&&value[key]>0))throw Object.assign(Error('ChatGPT 输入框仍在准备，请稍后重试。'),{code:'draft_not_ready'});
  if(value.draftId!==undefined&&!uuid(value.draftId))throw Object.assign(Error('提问草稿身份尚未确认。'),{code:'draft_not_ready'});
  return Object.freeze({...Object.fromEntries(fields.map(key=>[key,value[key]])),...(value.draftId?{draftId:value.draftId}:{})});
}

// A provisional first chat may acquire a canonical route after sending. That
// change permits a read-only reconciliation, never a replay into the new route.
export function captureDelivery(materialId,target,previous=null){
  if(!uuid(materialId))throw Error('材料编号无效。');
  const next=captureTarget(target);
  const changed=previous&&previous.target.conversationId!==next.conversationId;
  const firstReconciliation=!!changed&&previous.target.conversationId.startsWith('provisional:')&&uuid(previous.target.conversationId.slice('provisional:'.length))&&next.conversationId.startsWith('c:');
  const reconcileOnly=firstReconciliation||previous?.reconcileOnly===true&&!changed;
  if(previous?.target.draftId&&next.draftId&&previous.target.draftId!==next.draftId&&!reconcileOnly)throw Object.assign(Error('原问题已结束，原材料仍保留。'),{code:'conversation_changed'});
  if(previous&&(previous.materialId!==materialId||!uuid(previous.operationId)||changed&&!firstReconciliation))throw Object.assign(Error('目标对话已切换。材料已保存在“资料”中；请回到原对话重试，或从资料中选择新的目标。'),{code:'conversation_changed'});
  return {protocol:2,materialId,operationId:previous?.operationId||crypto.randomUUID(),attemptId:crypto.randomUUID(),target:next,...reconcileOnly?{reconcileOnly:true,previousTarget:captureTarget(previous.previousTarget||previous.target)}:{}};
}

export function captureReceipt(receipt,delivery){
  if(!receipt||receipt.protocol!==2||receipt.materialId!==delivery.materialId||receipt.operationId!==delivery.operationId||receipt.attemptId!==delivery.attemptId||!sameTarget(receipt.target,delivery.target))throw Object.assign(Error('收到的附图回执不属于本次操作；材料已保留，请检查目标对话后重试。'),{code:'delivery_mismatch'});
  if(['queued','working'].includes(receipt.state))return 'pending';
  if(receipt.verified===true&&((receipt.state==='attached'&&receipt.evidence==='composer')||(receipt.state==='already-sent'&&receipt.evidence==='confirmed-message')||(receipt.state==='removed'&&receipt.evidence==='composer-removal')))return 'complete';
  throw Object.assign(Error(receipt.error||'材料尚未确认加入目标对话。请查看 ChatGPT 后重试。'),{code:receipt.code||'delivery_unconfirmed'});
}
