import {draftIcon} from './draft-icons.js';
import {imageDataBlob} from '../src/image-data.js';

// Adds contextual controls and original-image previews to managed attachment
// cards. Upload progress, native removal controls and manually added files stay
// owned by the site. No duplicate gallery is rendered for an existing card.
export function createAttachmentUI({page,win,read,reference,remove,moveImage,moveQuestion,clear,undo,metadata,restoreDraft,keepDraft,review,loadImage,error}){
  let root=null,popup=null,view=null,owner='',signature='',popupSignature='',drag=null,returnFocus=null,popupAnchor=null,disposed=false;
  const decorations=new Map(),images=new WeakMap(),imageTargets=new WeakMap(),rows=new Set(),scrollHosts=new Set();let imageObserver=null;
  const el=(tag,className='')=>{const node=page.createElement(tag);node.className=className;return node;};
  const current=key=>!disposed&&read().key===key;
  function run(fn,...args){if(disposed)return;const key=read().key;Promise.resolve().then(()=>{if(current(key))return fn(...args);}).catch(problem=>{if(current(key)&&problem.code!=='conversation_changed'&&problem.name!=='AbortError')error(problem);});}
  function button(icon,label,fn){
    const control=el('button','zjf-icon');control.type='button';control.innerHTML=draftIcon(icon);control.setAttribute('aria-label',label);
    control.addEventListener('pointerdown',event=>{if(event.pointerType==='mouse')event.preventDefault();event.stopPropagation();});
    control.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' ')event.stopPropagation();});
    control.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();run(fn,event);});return control;
  }
  function close({focus=false}={}){
    const old=popup,owned=current(owner);popup=null;view=null;popupSignature='';if(old){if(owned&&old.contains(page.activeElement)&&page.activeElement?.matches('input'))page.activeElement.dispatchEvent(new win.Event('change',{bubbles:true}));if(old.matches?.(':popover-open'))old.hidePopover();releaseImages(old);old.remove();}
    if(focus&&owned&&returnFocus?.isConnected)returnFocus.focus({preventScroll:true});returnFocus=null;popupAnchor=null;
  }
  function position(){
    if(!popup)return;const trigger=popupAnchor?.isConnected?popupAnchor:root;if(!trigger){close();return;}const anchor=trigger.getBoundingClientRect(),width=Math.max(0,Math.min(440,win.innerWidth-16)),height=Math.max(0,Math.min(420,win.innerHeight-24));
    popup.style.width=width+'px';popup.style.maxHeight=height+'px';
    popup.style.left=Math.max(8,Math.min(anchor.left,win.innerWidth-width-8))+'px';
    const box=popup.getBoundingClientRect(),above=anchor.top-box.height-8,below=anchor.bottom+8;popup.style.top=Math.max(8,Math.min(above>=8?above:below,win.innerHeight-box.height-8))+'px';
  }
  function preview(img,material,item,{original=false}={}){
    const source=original?'':item.thumbnail||item.image||(!item.region&&(material.image||material.thumbnail));
    if(source){img.src=source;return;}
    const key=read().key,sourceItem=item.raw||item;
    const load=()=>{
      if(!current(key)||!img.isConnected)return;img.setAttribute('aria-busy','true');let cached=images.get(sourceItem);
      if(!cached||cached.key!==key){cached={key,promise:Promise.resolve().then(()=>loadImage(material,item))};images.set(sourceItem,cached);}
      cached.promise.then(source=>{if(current(key)&&img.isConnected){img.src=source;img.removeAttribute('aria-busy');}}).catch(()=>{
        if(images.get(sourceItem)===cached)images.delete(sourceItem);
        if(!current(key)||!img.isConnected)return;img.removeAttribute('aria-busy');img.hidden=true;
        const missing=el('span','zjf-missing-image');missing.innerHTML=draftIcon('imageOff');missing.setAttribute('aria-label','图片预览不可用');img.after(missing);
      });
    };
    if(win.IntersectionObserver){
      imageObserver??=new win.IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){imageObserver.unobserve(entry.target);imageTargets.get(entry.target)?.();}},{rootMargin:'80px'});
      imageTargets.set(img,load);imageObserver.observe(img);
    }else win.setTimeout(load,0);
  }
  function releaseImages(container){for(const img of container?.querySelectorAll('img')||[])imageObserver?.unobserve(img);}
  function select(material,item){close();reference(material.id,item.id);}
  function copyMaterial(material,item,control){
    const Clipboard=win.ClipboardItem||globalThis.ClipboardItem;if(!Clipboard||!win.navigator.clipboard?.write)throw Error('当前无法复制原图。');
    const key=read().key,check=()=>{if(!current(key))throw new win.DOMException('图片操作已取消。','AbortError');};
    const value=Promise.resolve().then(()=>{check();return loadImage(material,item);}).then(source=>{check();return imageDataBlob(source);}).then(async blob=>{if(blob.type==='image/png')return blob;const bitmap=await win.createImageBitmap(blob),canvas=page.createElement('canvas');try{check();canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);}finally{bitmap.close();}return new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error('原图暂不能复制。')),'image/png'));}).then(blob=>{check();return blob;});
    return win.navigator.clipboard.write([new Clipboard({'image/png':value})]).then(()=>{if(current(key)&&control?.isConnected){control.innerHTML=draftIcon('check');win.setTimeout(()=>{if(current(key)&&control.isConnected)control.innerHTML=draftIcon('copy');},1000);}});
  }
  function tile(material,item,state){
    const card=el('div','zjf-material');card.dataset.zjfItem=item.id;
    const pick=button('image','查看 '+item.label,()=>open({kind:'preview',id:material.id,logicalId:item.id},pick));pick.className='zjf-material-image';pick.replaceChildren();
    const img=el('img');img.alt=item.label;pick.append(img);card.append(pick);preview(img,material,item);
    const controls=el('div','zjf-material-actions'),quote=button('quote','引用 '+item.label,()=>select(material,item)),drop=button('close','移除 '+item.label+'，保留问题',()=>remove(material.id,item.id)),copy=button('copy','复制 '+item.label,()=>copyMaterial(material,item,copy));
    quote.disabled=drop.disabled=!state.editable;controls.append(quote,copy,drop);card.append(controls);
    if(item.region){const badge=el('span','zjf-region');badge.textContent=item.region;card.append(badge);}
    if(item.question?.trim()){
      const question=el('button','zjf-question-excerpt');question.type='button';question.textContent=item.question;question.setAttribute('aria-label','编辑 '+item.label+' 的问题');question.addEventListener('click',()=>{close();run(reference,material.id,item.id,{existing:true});});card.append(question);
      const order=el('div','zjf-question-actions');
      for(const [direction,icon,label]of [[-1,'up','问题前移'],[1,'down','问题后移']]){const action=button(icon,label,()=>moveQuestion(item.id,direction));action.disabled=!state.editable||(direction<0?!item.questionBefore:!item.questionAfter);order.append(action);}
      const discard=button('removeQuestion','移除 '+item.label+' 及其独立问题',()=>remove(material.id,item.id,{keepQuestion:false}));discard.disabled=!state.editable;order.append(discard);card.append(order);
    }
    return card;
  }
  function populate(){
    if(!popup||!view)return;const state=read();if(state.key!==owner){close();return;}
    if(popup.contains(page.activeElement)&&page.activeElement?.matches('input,textarea'))return;
    const next=JSON.stringify([view,state.editable,state.canClear,state.reviewKey,state.materials.map(item=>[item.id,!!item.native?.isConnected,item.logical.map(value=>[value.id,value.question,value.questionBefore,value.questionAfter])]),state.fields]);if(next===popupSignature)return;popupSignature=next;
    const active=popup.contains(page.activeElement)?page.activeElement:null,focusLabel=active?.getAttribute('aria-label'),focusItem=active?.closest('[data-zjf-item]')?.getAttribute('data-zjf-item'),scroll=popup.scrollTop;releaseImages(popup);popup.replaceChildren();const top=el('div','zjf-popup-bar');
    const exit=button('close','关闭图片操作',()=>close({focus:true}));exit.classList.add('zjf-popup-close');
    if(view.kind==='review'){top.append(exit);popup.append(top);review(popup,state);position();return;}
    const chosen=view.id?(state.materials.find(item=>item.id===view.id)||state.materials.find(item=>item.logical.some(value=>view.logicalIds?.includes(value.id)))):null;
    if(view.id&&!chosen){close();return;}if(chosen)view.id=chosen.id;
    if(chosen){
      for(const [direction,icon,label]of [[-1,'left','图片前移'],[1,'right','图片后移']]){const action=button(icon,label,()=>moveImage(chosen.id,{direction}));const index=state.materials.indexOf(chosen);action.disabled=!state.editable||index+direction<0||index+direction>=state.materials.length;top.append(action);}
      if(chosen.native&&view.kind!=='preview'){const show=button('image','查看原图',()=>open({kind:'preview',id:chosen.id},show));top.append(show);}
    }else{
      const erase=button('trash','清空当前草稿',()=>{close();clear();});erase.disabled=!state.canClear;top.append(erase);
    }
    top.append(exit);popup.append(top);
    popup.classList.toggle('zjf-image-preview',view.kind==='preview');
    if(chosen&&view.kind==='preview'){
      const item=chosen.logical.find(item=>item.id===view.logicalId)||(chosen.logical.length===1?chosen.logical[0]:chosen),picture=el('img','zjf-preview-image');picture.alt=item.label;popup.append(picture);preview(picture,chosen,item,{original:true});
      const controls=el('div','zjf-preview-actions'),quote=button('quote','引用这张图片',()=>item!==chosen?select(chosen,item):chosen.logical.length===1?select(chosen,chosen.logical[0]):open({kind:'material',id:chosen.id},quote)),copy=button('copy','复制原图',()=>copyMaterial(chosen,item,copy));quote.disabled=!state.editable;
      const download=button('download','下载原图',async()=>{const key=read().key,source=await loadImage(chosen,item);if(!current(key))return;const link=el('a');link.href=source;link.download=(item.label||'课堂片段')+'.png';link.click();});
      controls.append(quote,copy,download);popup.append(controls);position();return;
    }
    const grid=el('div','zjf-material-grid');
    for(const material of chosen?[chosen]:state.materials)for(const item of material.logical)grid.append(tile(material,item,state));
    popup.append(grid);
    if(!chosen){
      const fields=el('div','zjf-course-fields');
      for(const field of state.fields){const label=el('label');label.textContent=field.label;const input=el('input');input.value=field.value||'';input.setAttribute('aria-label',field.label);input.disabled=!state.editable;input.addEventListener('input',()=>run(metadata,field.key,input.value,false));input.addEventListener('change',()=>run(metadata,field.key,input.value,true));label.append(input);fields.append(label);}
      popup.append(fields);
    }
    popup.scrollTop=scroll;position();
    if(focusLabel){const scope=focusItem?[...popup.querySelectorAll('[data-zjf-item]')].find(item=>item.getAttribute('data-zjf-item')===focusItem):popup;const next=[...(scope?.querySelectorAll('button')||[])].find(button=>button.getAttribute('aria-label')===focusLabel&&!button.disabled);(next||popup).focus({preventScroll:true});}
  }
  function open(next,anchor){
    const priorAnchor=popupAnchor,priorFocus=returnFocus;close();const state=read();owner=state.key;view={...next,logicalIds:state.materials.find(item=>item.id===next.id)?.logical.map(item=>item.id)||[]};returnFocus=anchor?.isConnected?anchor:priorFocus?.isConnected?priorFocus:page.activeElement;popupAnchor=anchor?.isConnected?anchor:priorAnchor?.isConnected?priorAnchor:root;
    popup=el('div','zjf-attachment-popup');popup.setAttribute('role','dialog');popup.setAttribute('aria-label',next.kind==='review'?'发送记录':'图片操作');popup.tabIndex=-1;
    // Top-layer popovers are not clipped by the site's scrolling composer.
    if(typeof popup.showPopover==='function')popup.setAttribute('popover','auto');
    (page.body||page.documentElement).append(popup);populate();
    if(typeof popup.showPopover==='function'){popup.showPopover();const opened=popup;popup.addEventListener('toggle',event=>{if(event.newState==='closed'&&popup===opened)close();});}
    position();popup.focus({preventScroll:true});
  }
  function removeDecoration(node,entry){
    entry.tools.remove();for(const [event,fn]of entry.events)entry.host.removeEventListener(event,fn,true);
    if(entry.positionChanged&&entry.host.style.position==='relative')entry.host.style.position=entry.position;
    if(entry.draggable===null)entry.host.removeAttribute('draggable');else entry.host.setAttribute('draggable',entry.draggable);
    entry.host.classList.remove('zjf-managed-attachment');entry.host.removeAttribute('data-zjf-referenced');entry.host.removeAttribute('data-zjf-drop');entry.host.removeAttribute('data-zjf-number');decorations.delete(node);
  }
  function decorate(state){
    const live=new Set(state.materials.map(item=>item.native).filter(node=>node?.isConnected));
    for(const [node,entry]of decorations)if(!live.has(node)||entry.key!==state.key||!entry.tools.isConnected)removeDecoration(node,entry);
    for(const row of rows)if(![...row.children].some(node=>node.classList?.contains('zjf-managed-attachment'))){row.classList.remove('zjf-attachment-row');rows.delete(row);}
    for(const material of state.materials){
      const node=material.native;if(!node?.isConnected)continue;let entry=decorations.get(node);
      if(entry&&entry.materialId!==material.id){removeDecoration(node,entry);entry=null;}
      if(!entry){
        const host=node.closest('[class~="group/composer-attachment"]')||node,position=host.style.position,positionChanged=win.getComputedStyle(host).position==='static';
        if(positionChanged)host.style.position='relative';host.classList.add('zjf-managed-attachment');
        const tools=el('div','zjf-native-tools');tools.setAttribute('contenteditable','false');
        const quote=button('quote','引用这张图片',()=>{const latest=read().materials.find(item=>item.id===material.id);if(!latest)return;if(latest.logical.length===1)select(latest,latest.logical[0]);else open({kind:'material',id:material.id},quote);});
        const copy=button('copy','复制这张图片',()=>{const latest=read().materials.find(item=>item.id===material.id);if(latest)return copyMaterial(latest,latest.logical.length===1?latest.logical[0]:latest,copy);});
        const drop=button('close','移出这张图片，保留问题',()=>remove(material.id));
        const more=button('more','这张图片的操作',()=>open({kind:'material',id:material.id},more));tools.append(quote,copy,drop,more);host.append(tools);
        const row=host.parentElement;if(row&&!row.matches('form,[data-composer-body]')){row.classList.add('zjf-attachment-row');rows.add(row);}
        const events=[],listen=(type,fn)=>{host.addEventListener(type,fn,true);events.push([type,fn]);},key=state.key;
        const nativeRemove=target=>target.closest?.('button[aria-label^="移除"],button[aria-label^="Remove"],button[aria-label^="删除"]');
        listen('pointerdown',event=>{if(event.button===0&&!event.target.closest?.('.zjf-native-tools')&&!nativeRemove(event.target)&&current(key))event.stopImmediatePropagation();});
        listen('click',event=>{if(event.target.closest?.('.zjf-native-tools')||nativeRemove(event.target)||!current(key))return;event.preventDefault();event.stopImmediatePropagation();open({kind:'preview',id:material.id},node);});
        const draggable=host.getAttribute('draggable');host.draggable=true;
        listen('keydown',event=>{if(!current(key)||event.isComposing||event.keyCode===229||event.target.closest?.('.zjf-native-tools')||nativeRemove(event.target))return;if(['Enter',' '].includes(event.key)&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey){event.preventDefault();event.stopImmediatePropagation();open({kind:'preview',id:material.id},event.target);return;}if(!event.altKey||!['ArrowLeft','ArrowRight'].includes(event.key)||!read().editable)return;event.preventDefault();event.stopPropagation();run(moveImage,material.id,{direction:event.key==='ArrowLeft'?-1:1});});
        listen('dragstart',event=>{if(event.target.closest?.('.zjf-native-tools')||!current(key)||!read().editable)return;drag={key,id:material.id};event.dataTransfer.setData('application/x-zhiyun-image',material.id);event.dataTransfer.effectAllowed='move';event.stopPropagation();});
        listen('dragover',event=>{if(!drag||drag.key!==key||!current(key)||drag.id===material.id)return;event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='move';host.dataset.zjfDrop=event.clientX>host.getBoundingClientRect().left+host.clientWidth/2?'after':'before';});
        listen('dragleave',event=>{if(!host.contains(event.relatedTarget))host.removeAttribute('data-zjf-drop');});
        listen('drop',event=>{if(!drag||drag.key!==key||!current(key))return;event.preventDefault();event.stopPropagation();const source=drag.id,after=host.dataset.zjfDrop==='after';drag=null;host.removeAttribute('data-zjf-drop');run(moveImage,source,{target:material.id,after});});
        listen('dragend',()=>{drag=null;for(const value of decorations.values())value.host.removeAttribute('data-zjf-drop');});
        entry={key,materialId:material.id,host,tools,quote,copy,drop,more,events,position,positionChanged,draggable};decorations.set(node,entry);
      }
      entry.host.dataset.zjfNumber=String(material.number||state.materials.indexOf(material)+1);
      if(entry.quote.disabled===state.editable)entry.quote.disabled=!state.editable;entry.drop.disabled=!state.editable;entry.copy.disabled=!state.ready;if(entry.more.disabled===state.ready)entry.more.disabled=!state.ready;
    }
  }
  function refresh({force=false}={}){
    if(disposed)return;const state=read();if(owner&&owner!==state.key){close();signature='';}owner=state.key;decorate(state);
    if(!state.editor||!state.ready){releaseImages(root);root?.remove();root=null;close();return;}
    const visible=state.materials.length||state.removed||state.choices.length||state.waiting||state.hasText||state.clearUndo;
    if(!visible){releaseImages(root);root?.remove();root=null;close();return;}
    if(!root?.isConnected){root=el('div');root.id='zjf-capture-draft';const anchor=state.editor.closest('[data-composer-body]')||state.editor.closest('form')||state.editor.parentElement;anchor.before(root);signature='';}
    const scroll=state.editor.closest('[data-rich-text-layout]')||state.editor.parentElement;if(scroll){scroll.classList.add('zjf-composer-scroll');scrollHosts.add(scroll);}
    root.dataset.diagnostic=state.warning||'';
    const missing=state.materials.filter(item=>!item.native?.isConnected),next=JSON.stringify([state.key,state.editable,state.canClear,state.removed,state.clearUndo,state.warning,state.waiting,missing.map(item=>item.id),state.choices.map(item=>item.id),!!state.hasText]);
    if(force||next!==signature){
      const active=root.contains(page.activeElement)?page.activeElement?.getAttribute('aria-label'):null;signature=next;releaseImages(root);root.replaceChildren();
      if(missing.length){const rail=el('div','zjf-pending-images');for(const material of missing){const item=material.logical[0]||material,card=el('div','zjf-pending-image'),pick=button('image','查看 '+item.label,()=>open({kind:'preview',id:material.id},pick));pick.className='zjf-pending-preview';pick.replaceChildren();const img=el('img');img.alt=item.label;pick.append(img);preview(img,material,item);const drop=button('close','移除 '+material.label+'，保留问题',()=>remove(material.id));drop.disabled=!state.editable;card.append(pick,drop);rail.append(card);}root.append(rail);}
      const bar=el('div','zjf-draft-bar');
      if(state.removed||state.clearUndo){const restore=button('undo',state.clearUndo?'撤销清空':'撤销图片调整',()=>undo());restore.disabled=!state.canUndo;bar.append(restore);}
      if(state.waiting){const history=button('history','查看待确认的发送记录',()=>open({kind:'review'},history));bar.append(history);}
      const more=button('more','图片与草稿操作',()=>open({kind:'materials'},more));more.classList.add('zjf-more');bar.append(more);root.append(bar);
      if(state.choices.length){const choices=el('div','zjf-recovery-choices');for(const saved of state.choices){const choice=button('edit',saved.title,()=>restoreDraft(saved.id));const title=el('span');title.textContent=saved.title;choice.append(title);choice.disabled=!state.editable;choices.append(choice);}const keep=button('close','保留当前输入',()=>keepDraft());choices.append(keep);root.append(choices);}
      if(active)[...root.querySelectorAll('button')].find(button=>button.getAttribute('aria-label')===active&&!button.disabled)?.focus({preventScroll:true});
    }
    if(popup){populate();position();}
  }
  function highlight(ids){const materials=new Map(read().materials.map(item=>[item.native,item]));for(const [node,entry]of decorations){const active=!!materials.get(node)?.logical.some(item=>ids.includes(item.id));if(entry.host.hasAttribute('data-zjf-referenced')!==active)entry.host.toggleAttribute('data-zjf-referenced',active);}}
  const outside=event=>{if(popup&&!popup.contains(event.target)&&!root?.contains(event.target)&&![...decorations.values()].some(entry=>entry.tools.contains(event.target)))close();};
  const keydown=event=>{if(popup&&event.key==='Escape'&&!event.isComposing&&event.keyCode!==229){event.preventDefault();event.stopPropagation();close({focus:true});}};
  page.addEventListener('pointerdown',outside,true);page.addEventListener('focusin',outside,true);page.addEventListener('scroll',position,true);page.addEventListener('keydown',keydown,true);win.addEventListener('resize',position);win.addEventListener('blur',close);
  return {refresh,highlight,open,close,get element(){return root;},get popup(){return popup;},dispose(){disposed=true;close();imageObserver?.disconnect();for(const [node,entry]of decorations)removeDecoration(node,entry);for(const row of rows)row.classList.remove('zjf-attachment-row');for(const node of scrollHosts)node.classList.remove('zjf-composer-scroll');root?.remove();page.removeEventListener('pointerdown',outside,true);page.removeEventListener('focusin',outside,true);page.removeEventListener('scroll',position,true);page.removeEventListener('keydown',keydown,true);win.removeEventListener('resize',position);win.removeEventListener('blur',close);}};
}
