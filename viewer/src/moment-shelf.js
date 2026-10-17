import {toolbarIcon} from './toolbar-icons.js';

// A temporary working selection over the durable library. Dismissing a card
// never deletes its source image, mark or draft.
export function mountMomentShelf({root,lessonKey,win=window,copy,preview,ask,changed=()=>{}}){
  const stores=win.__ZJF_MOMENT_SHELVES_V1__||(win.__ZJF_MOMENT_SHELVES_V1__=new Map());
  const state=stores.get(lessonKey)||{items:[],undo:[]};stores.set(lessonKey,state);
  for(const item of state.items){delete item.batch;delete item.layout;delete item.sourcePage;item.selectionId||=crypto.randomUUID();item.selectedAt||=Date.now();}
  let busy=false,disposed=false;
  const failed=error=>{root.dataset.diagnostic=error?.message||'课堂材料操作未完成';};
  const current=()=>state.items.filter(item=>!item.dismissed&&!item.used);
  const button=(icon,label,action)=>{const node=root.ownerDocument.createElement('button');node.type='button';node.className='moment-action';node.innerHTML=toolbarIcon(icon);node.setAttribute('aria-label',label);node.addEventListener('click',event=>{event.stopPropagation();action(node);});return node;};
  function render(){
    if(disposed)return;const items=current();root.hidden=!items.length&&!state.undo.length;root.replaceChildren();
    root.setAttribute('aria-label','本次选用的课堂截图');
    const strip=root.ownerDocument.createElement('div');strip.className='moment-shelf-images';
    for(const item of items){
      const card=root.ownerDocument.createElement('div');card.className='moment-shelf-card';
      const show=button('library','查看截图 '+time(item.time),()=>Promise.resolve(preview(item)).catch(failed));show.className='moment-shelf-preview';
      const image=root.ownerDocument.createElement('img');image.src=item.image;image.alt='课堂截图 '+time(item.time);show.replaceChildren(image);
      const stamp=root.ownerDocument.createElement('span');stamp.textContent=time(item.time);show.append(stamp);
      const drop=button('close','移出本次选用，保留原图',()=>{item.dismissed=true;state.undo.push(item.id);render();changed();});drop.classList.add('moment-dismiss');
      card.append(show,drop);strip.append(card);
    }
    root.append(strip);
    const actions=root.ownerDocument.createElement('div');actions.className='moment-shelf-actions';
    if(state.undo.length){const undo=button('undo','撤销移出截图',()=>{const id=state.undo.pop(),item=state.items.find(value=>value.id===id);if(item){item.dismissed=false;item.selectionId=crypto.randomUUID();item.selectedAt=Math.max(Date.now(),item.selectedAt+1);}render();changed();});actions.append(undo);}
    if(items.length){
      actions.append(button('copy','复制最新截图',node=>{Promise.resolve(copy(items.at(-1))).then(()=>{delete root.dataset.diagnostic;if(node.isConnected){node.innerHTML=toolbarIcon('check');win.setTimeout(()=>{if(node.isConnected)node.innerHTML=toolbarIcon('copy');},1000);}}).catch(failed);}));
      const send=button('chat','用这些截图提问',()=>void submit());send.disabled=busy;send.setAttribute('aria-busy',String(busy));actions.append(send);
    }
    root.append(actions);
  }
  function time(value){const n=Math.max(0,Math.floor(value||0));return Math.floor(n/60)+':'+String(n%60).padStart(2,'0');}
  async function submit(){
    const chosen=current().map(item=>Object.freeze({...item,ref:item.ref?Object.freeze({...item.ref}):undefined}));if(busy||disposed||!chosen.length)return false;busy=true;render();
    const owns=item=>state.items.find(value=>value.id===item.id&&value.selectionId===item.selectionId&&!value.dismissed&&!value.used);
    try{const result=await ask(chosen,{isCurrent:()=>!disposed&&chosen.every(owns),selectionCurrent:()=>chosen.every(owns)});if(result){const consumed=new Set();for(const item of chosen){const owned=owns(item);if(owned){owned.used=true;consumed.add(item.id);}}state.undo=state.undo.filter(id=>!consumed.has(id));state.items=state.items.filter(item=>!item.used);}return !!result;}
    catch(error){failed(error);return false;}
    finally{busy=false;render();changed();}
  }
  render();
  async function add(item){
    if(disposed)return;
    let entry=state.items.find(value=>value.id===item.id);
    if(!entry){entry={...item,image:'',selectionId:crypto.randomUUID(),selectedAt:Date.now()};state.items.push(entry);render();changed();}
    // The durable library owns full pixels. Keep only a small visual proxy in
    // this cross-viewer selection; copy and preview read the original by ref.
    const source=root.ownerDocument.createElement('img');source.src=item.image;
    try{await source.decode();if(disposed||!state.items.includes(entry))return;const ratio=Math.min(1,320/Math.max(source.naturalWidth,source.naturalHeight)),canvas=root.ownerDocument.createElement('canvas');canvas.width=Math.max(1,Math.round(source.naturalWidth*ratio));canvas.height=Math.max(1,Math.round(source.naturalHeight*ratio));canvas.getContext('2d').drawImage(source,0,0,canvas.width,canvas.height);entry.image=canvas.toDataURL('image/jpeg',.85);}
    catch(error){if(disposed)return;failed(error);}
    render();if(!disposed)changed();
  }
  return {add,dispose(){disposed=true;root.replaceChildren();}};
}
