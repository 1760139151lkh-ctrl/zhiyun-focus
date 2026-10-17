import {imageFrame,captureDimensionsValid,MAX_CAPTURE_BYTES} from './capture.js';

export async function sourceFrameIdentity(source){
  const url=new URL(source),bytes=new TextEncoder().encode(url.origin+url.pathname);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
}

// This reads one authorized MP4 frame. It never seeks, clones, mutes or changes
// the geometry of the user's player, and never persists an expiring media URL.
export async function readSourceFrame(source,time,{signal,prepare=async()=>{},request=fetch,endpoint='http://127.0.0.1:8771'}={}){
  const url=new URL(source);
  if(url.protocol!=='https:'||!['vod.cmc.zju.edu.cn','resource.cmc.zju.edu.cn'].includes(url.hostname)||url.username||url.password||url.port&&url.port!=='443'||!url.pathname.toLowerCase().endsWith('.mp4')||!Number.isFinite(time)||time<0||time>=86400)throw Error('此视频暂不能读取原始帧。');
  const deadline=AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(30000)]);
  const readable=await request(url.href,{credentials:'omit',mode:'cors',headers:{Range:'bytes=0-1023'},signal:AbortSignal.any([deadline,AbortSignal.timeout(5000)])});
  if(readable.status!==206){await readable.body?.cancel();throw Error('此视频未允许读取原始帧。');}
  if((await readable.arrayBuffer()).byteLength!==1024)throw Error('视频原始帧读取尚未就绪。');
  // No local source request is made if the browser rejected source access.
  const ready=async()=>{try{const response=await request(endpoint+'/health',{credentials:'omit',signal:AbortSignal.any([deadline,AbortSignal.timeout(1500)])});if(!response.ok)return false;const state=await response.json();return state.frame_decode===1&&state.build>=9&&state.frame_original_pixels===true;}catch(error){deadline.throwIfAborted();return false;}};
  if(!await ready()){
    await prepare(deadline);deadline.throwIfAborted();
    const end=Date.now()+8000;
    while(!await ready()){
      if(Date.now()>=end)throw Error('原始帧读取组件尚未就绪。');
      await new Promise(resolve=>setTimeout(resolve,200));deadline.throwIfAborted();
    }
  }
  const response=await request(endpoint+'/frame',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json','X-ZJF-Protocol':'1'},body:JSON.stringify({url:url.href,start:time}),signal:deadline});
  if(!response.ok){await response.body?.cancel();throw Error('视频原始帧暂时无法读取。');}
  const metadata=JSON.parse(response.headers.get('X-ZJF-Result')||'null'),bytes=await response.blob();
  const indexed=metadata?.indexed===true&&(metadata.next_time===null||Number.isFinite(metadata.next_time)&&metadata.next_time>time);
  if(bytes.size>MAX_CAPTURE_BYTES||bytes.type!=='image/png'||metadata?.original_pixels!==true||!captureDimensionsValid(metadata.width,metadata.height))throw Error('原始帧尺寸或容量未能核对，已取得的局部材料仍保留。');
  if(metadata.video_tracks!==1||metadata.requested!==time||!Number.isFinite(metadata.time)||metadata.time<0||metadata.time>time+.000002||!indexed)throw Error('截图时间未能核对。');
  deadline.throwIfAborted();const object=URL.createObjectURL(bytes);
  try{
    const frame=await imageFrame(object);deadline.throwIfAborted();
    if(frame.width!==metadata.width||frame.height!==metadata.height)throw Error('截图尺寸未能核对。');
    const canvas=document.createElement('canvas');canvas.width=frame.width;canvas.height=frame.height;canvas.getContext('2d').drawImage(frame.source,0,0);
    const original=await new Promise((resolve,reject)=>{const reader=new FileReader(),abort=()=>reader.abort(),finish=(error,value)=>{deadline.removeEventListener('abort',abort);error?reject(error):resolve(value);};reader.onload=()=>finish(null,reader.result);reader.onerror=()=>finish(reader.error||Error('原始帧暂时无法读取。'));reader.onabort=()=>finish(deadline.reason||new DOMException('Cancelled','AbortError'));deadline.addEventListener('abort',abort,{once:true});reader.readAsDataURL(bytes);});
    deadline.throwIfAborted();return {source:canvas,width:frame.width,height:frame.height,image:original,time:metadata.time,indexed,requested:metadata.requested,nextTime:metadata.next_time};
  }finally{URL.revokeObjectURL(object);}
}
