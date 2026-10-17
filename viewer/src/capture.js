import {imageDataBlob} from './image-data.js';

export const MAX_CAPTURE_EDGE=16384;
export const MAX_CAPTURE_PIXELS=33554432;
export const MAX_CAPTURE_BYTES=72*1024*1024-65536;
export const MAX_CAPTURE_IMAGE_CHARS=22+4*Math.ceil(MAX_CAPTURE_BYTES/3);
export function captureDimensionsValid(width,height){
  return Number.isInteger(width)&&Number.isInteger(height)&&width>0&&height>0&&width<=MAX_CAPTURE_EDGE&&height<=MAX_CAPTURE_EDGE&&width*height<=MAX_CAPTURE_PIXELS;
}
const captureBudgetError=()=>Object.assign(Error('原图超出当前保存容量，已取得的局部材料仍会保留。'),{code:'capture_image_budget'});
function capturePng(canvas){
  const image=canvas.toDataURL('image/png');
  if(image==='data:,'||image.length>MAX_CAPTURE_IMAGE_CHARS)throw captureBudgetError();
  return image;
}
export function frameDimensions(roi,videoWidth,videoHeight,maxEdge=Infinity) {
  const w=videoWidth*roi.w,h=videoHeight*roi.h,scale=Math.min(1,maxEdge/Math.max(w,h));
  const width=Math.max(1,Math.round(w*scale)),height=Math.max(1,Math.round(h*scale));
  if(!captureDimensionsValid(width,height))throw captureBudgetError();
  return {sx:videoWidth*roi.x,sy:videoHeight*roi.y,sw:w,sh:h,width,height};
}
export function captureBoard(video,roi) {
  if(video.readyState<2||!video.videoWidth||!video.videoHeight||video.seeking)throw Error('等待课程画面和跳转完成后再截图。');
  const size=frameDimensions(roi,video.videoWidth,video.videoHeight),canvas=document.createElement('canvas');
  canvas.width=size.width;canvas.height=size.height;
  canvas.getContext('2d').drawImage(video,size.sx,size.sy,size.sw,size.sh,0,0,size.width,size.height);
  return capturePng(canvas);
}
export function selectionRectangle(a,b,view,minSize=8){
  const clip=(n,min,max)=>Math.min(max,Math.max(min,n));
  const x1=clip(a.x,view.x,view.x+view.w),x2=clip(b.x,view.x,view.x+view.w);
  const y1=clip(a.y,view.y,view.y+view.h),y2=clip(b.y,view.y,view.y+view.h);
  const rect={x:Math.min(x1,x2),y:Math.min(y1,y2),w:Math.abs(x1-x2),h:Math.abs(y1-y2)};
  return rect.w>=minSize&&rect.h>=minSize?rect:null;
}
export function captureRegion(rect,layout){
  const visible=selectionRectangle({x:rect.x,y:rect.y},{x:rect.x+rect.w,y:rect.y+rect.h},layout.view,1);
  if(!visible)throw Error('请在视频画面内框选截图区域。');
  return {x:(visible.x-layout.left)/layout.width,y:(visible.y-layout.top)/layout.height,w:visible.w/layout.width,h:visible.h/layout.height};
}
export async function captureSelection({video,rect,layout,read=captureBoard,prepareNative=async()=>{},nativeCapture,check=()=>{}}){
  check();
  const area=selectionRectangle({x:rect.x,y:rect.y},{x:rect.x+rect.w,y:rect.y+rect.h},layout.view,1);
  if(!area)throw Error('请在视频画面内框选截图区域。');
  try{return read(video,captureRegion(area,layout))}catch(error){
    if(error.name!=='SecurityError'&&error.code!=='capture_image_budget')throw error;
    await prepareNative();check();
    const image=await nativeCapture(area);check();return image.image;
  }
}
export async function imageBlob(image){
  if(typeof image!=='string'||!image.startsWith('data:image/png;base64,'))throw Error('原 PNG 暂不可复制，原图仍保存在学习记录中。');
  return imageDataBlob(image);
}
export async function copyBoard(image) {
  if(!navigator.clipboard?.write||typeof ClipboardItem==='undefined')throw Error('此浏览器不支持图片复制，请保存图片后拖入 ChatGPT。');
  // Begin the clipboard request inside the pointer gesture, even when the
  // actual PNG comes back asynchronously from the local screenshot helper.
  await navigator.clipboard.write([new ClipboardItem({'image/png':Promise.resolve(image).then(imageBlob)})]);
}

// Freeze one source frame before making crops; a playing video must not give
// the panorama, boards and question different timestamps.
export function captureFrame(video){
  if(video.readyState<2||!video.videoWidth||!video.videoHeight||video.seeking)throw Error('等待课程画面和跳转完成后再截图。');
  const canvas=document.createElement('canvas'),size=frameDimensions({x:0,y:0,w:1,h:1},video.videoWidth,video.videoHeight);
  canvas.width=size.width;canvas.height=size.height;
  canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
  const image=capturePng(canvas);
  return {source:canvas,width:canvas.width,height:canvas.height,image};
}
// Chromium exposes the media time of the presented frame separately from the
// playback clock. Invalidate it across seeks and source changes.
export function createCaptureClock(video){
  let last=null,request=null,disposed=false,generation=0;
  const cancel=()=>{if(request!==null&&typeof video.cancelVideoFrameCallback==='function')video.cancelVideoFrameCallback(request);request=null};
  const next=()=>{if(!disposed&&typeof video.requestVideoFrameCallback==='function'){
    const ticket=generation,source=video.currentSrc;
    request=video.requestVideoFrameCallback((_,metadata)=>{
      if(disposed||ticket!==generation)return;
      request=null;
      if(!video.seeking&&video.currentSrc===source&&Number.isFinite(metadata.mediaTime))last={time:metadata.mediaTime,frame:metadata.presentedFrames,source,width:video.videoWidth,height:video.videoHeight};
      else last=null;
      next();
    });
  }};
  next();
  return {read(){return last&&last.source===video.currentSrc&&last.width===video.videoWidth&&last.height===video.videoHeight&&!video.seeking?last:null},
    invalidate(){generation++;last=null;cancel();next()},dispose(){disposed=true;generation++;cancel();last=null}};
}
export async function imageFrame(image){
  const source=new Image();source.src=image;await source.decode();
  if(!captureDimensionsValid(source.naturalWidth,source.naturalHeight))throw captureBudgetError();
  return {source,width:source.naturalWidth,height:source.naturalHeight,image};
}
export function cropFrame(frame,roi){
  const size=frameDimensions(roi,frame.width,frame.height),canvas=document.createElement('canvas');
  canvas.width=size.width;canvas.height=size.height;
  canvas.getContext('2d').drawImage(frame.source,size.sx,size.sy,size.sw,size.sh,0,0,size.width,size.height);
  return capturePng(canvas);
}
export function frameBundle(frame,{selection,boards,active,time,course,lessonKey,id=crypto.randomUUID(),images=null}){
  const area=selection.w*selection.h;
  const overlap=roi=>Math.max(0,Math.min(selection.x+selection.w,roi.x+roi.w)-Math.max(selection.x,roi.x))*Math.max(0,Math.min(selection.y+selection.h,roi.y+roi.h)-Math.max(selection.y,roi.y));
  const containing=boards.filter(b=>overlap(b.roi)/area>.96).sort((a,b)=>a.roi.w*a.roi.h-b.roi.w*b.roi.h);
  const source=containing.find(b=>b.id===active)||containing[0];
  const sources=source?[source]:boards.filter(b=>overlap(b.roi)/area>.08);
  const pixels=images||{panorama:frame.image,boards:Object.fromEntries(boards.map(b=>[b.id,cropFrame(frame,b.roi)])),selection:cropFrame(frame,selection)};
  if(!pixels.selection)throw Error('圈选图尚未取得，请重新截图。');
  const missingContext=[...pixels.panorama?[]:[{kind:'panorama',label:'全景'}],...boards.filter(b=>!pixels.boards?.[b.id]).map(b=>({kind:'board',boardId:b.id,label:b.name}))];
  return {id,lessonKey:lessonKey||course.course||'当前课程',course:{...course},time,contextComplete:!missingContext.length,missingContext,
    context:[...pixels.panorama?[{id:id+'-panorama',kind:'panorama',label:'全景',image:pixels.panorama,time}]:[],...boards.filter(b=>pixels.boards?.[b.id]).map(b=>({id:id+'-'+b.id,kind:'board',label:b.name,boardId:b.id,roi:{...b.roi},image:pixels.boards[b.id],time}))],
    selection:{id,kind:'selection',label:'圈选',source:sources.map(b=>b.name).join('、')||'全景',sourceBoardIds:sources.map(b=>b.id),roi:{...selection},image:pixels.selection,time,...missingContext.length?{missingContext}:{}}};
}
