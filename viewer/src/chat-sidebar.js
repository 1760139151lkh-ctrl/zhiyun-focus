// The native pane is a child of this course window. No browser popup is opened
// from the page, so opening a question cannot drop document/native fullscreen.
export async function openChatSidebar({companion,width=280,reserve=()=>{},signal,timeoutMs=12000,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  const check=()=>{if(signal?.aborted)throw signal.reason||new DOMException('Cancelled','AbortError')};
  let started=false,commitSent=false,releaseReservation=true;
  try{
    check();
    if(!companion.snapshot().connected)await companion.connect();
    check();started=true;
    let state=await companion.sidebar(true,'',width);
    const deadline=Date.now()+timeoutMs;
    while(state.chatOpening){
      check();if(Date.now()>=deadline)throw Error('提问区域准备超时，请重试。');
      await wait(150);check();state=await companion.refresh();
    }
    check();
    if(!state.chatOpen||!(state.sidebarWidth>0))throw Error(state.chatError||'提问区域未能展开，请重试。');
    reserve(state.sidebarWidth);commitSent=true;
    state=await companion.presentChat();check();return state;
  }catch(error){
    if(started)try{await companion.sidebar(false)}catch{releaseReservation=!commitSent}
    throw error;
  }finally{if(releaseReservation)reserve(0)}
}
