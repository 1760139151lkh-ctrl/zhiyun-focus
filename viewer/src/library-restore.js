import {FULL,bounded} from './geometry.js';
import {cleanLayout,layoutMatches} from './layouts.js';
import {studyLessonScope} from './study-context.js';

const validSize=size=>Array.isArray(size)&&size.length===2&&size.every(n=>Number.isFinite(n)&&n>0);
function cleanRoi(value){
  if(!value||!['x','y','w','h'].every(k=>Number.isFinite(value[k]))||value.w<=0||value.h<=0)return null;
  if(value.x>=0&&value.y>=0&&value.x+value.w<=1&&value.y+value.h<=1)return {x:value.x,y:value.y,w:value.w,h:value.h};
  const x=Math.max(0,value.x),y=Math.max(0,value.y),right=Math.min(1,value.x+value.w),bottom=Math.min(1,value.y+value.h);
  return right>x&&bottom>y?{x,y,w:right-x,h:bottom-y}:null;
}
const contains=(outer,inner)=>outer.x<=inner.x+1e-9&&outer.y<=inner.y+1e-9&&outer.x+outer.w>=inner.x+inner.w-1e-9&&outer.y+outer.h>=inner.y+inner.h-1e-9;
function combinedRoi(regions){
  const x=Math.min(...regions.map(r=>r.x)),y=Math.min(...regions.map(r=>r.y));
  return bounded({x,y,w:Math.max(...regions.map(r=>r.x+r.w))-x,h:Math.max(...regions.map(r=>r.y+r.h))-y});
}
const boardView=board=>({mode:'focus',active:board.id,roi:{...board.roi}});

// Decide the restored view without touching video, audio, DOM, or saved input.
// Normalized coordinates permit resolution changes with the same aspect ratio.
export function resolveLibraryRestore({lessonKey,dimensions,duration,mediaIdentity='',mark,snapshot,item}={}){
  if(!lessonKey||studyLessonScope(mark?.lessonKey)!==studyLessonScope(lessonKey))throw Error('这是另一节课的标记。请先打开对应课程，再从资料库恢复；图片和问题仍可直接选用。');
  if(!validSize(dimensions)||!Number.isFinite(duration)||duration<=0)throw Error('当前视频尚未就绪，请等画面和时长加载后再恢复。');
  if(snapshot?.markId&&snapshot.markId!==mark.id)throw Error('这个时刻不属于所选标记。');
  const layout=cleanLayout(snapshot?.layout);
  if(!layout)throw Error('这个标记的布局记录不完整，图片仍已保存。');
  if(snapshot.mediaProofError&&!layout.mediaIdentity)throw Error('视频来源核验记录暂不可用：'+snapshot.mediaProofError);
  const proof=snapshot.mediaProof;
  const verifiedLegacy=!layout.mediaIdentity&&proof?.schema===1&&proof.snapshotId===snapshot.id&&proof.markId===mark.id&&/^[a-f0-9]{64}$/.test(mediaIdentity)&&proof.identities?.includes(mediaIdentity)&&Number.isFinite(proof.time)&&Math.abs(proof.time-snapshot.time)<.5;
  if(verifiedLegacy)layout.mediaIdentity=mediaIdentity;
  if(!layout.mediaIdentity)throw Error('这份旧记录没有保存视频来源，无法确认当前画面。原图和问题仍可查看、圈选与提问。');
  if(layout.mediaIdentity!==mediaIdentity)throw Error('当前视频来源与这个时刻不一致，不能恢复旧板位。保存的原图和问题仍可查看、圈选与提问。');
  if(!layoutMatches(layout,dimensions,duration))throw Error('当前视频的比例或时长与保存的标记不一致。请打开原课程视频后恢复；图片仍可选用。');
  if(!Number.isFinite(snapshot.time)||snapshot.time<0)throw Error('这个标记的时间记录不完整，图片仍已保存。');
  if((item?.snapshotId&&item.snapshotId!==snapshot.id)||(item?.markId&&item.markId!==mark.id))throw Error('所选原图不属于这个时刻的标记。');
  if(item&&Array.isArray(snapshot.items)){
    const stored=snapshot.items.find(x=>x.id===item.id);
    if(!stored)throw Error('未找到这个时刻的所选原图。');
    item=stored;
  }
  let view,highlight=null;
  if(!item){
    const saved=snapshot.layout.view,active=saved?.active===null?null:layout.boards.find(b=>b.id===saved?.active)?.id??layout.active;
    const board=layout.boards.find(b=>b.id===active),roi=cleanRoi(saved?.roi)||cleanRoi(board?.view)||board?.roi||FULL;
    view={mode:saved?.mode==='overview'?'overview':saved?.mode==='focus'||layout.boards.length?'focus':'overview',active,roi:bounded(roi)};
  }else if(item.kind==='panorama'){
    view={mode:'overview',active:null,roi:{...FULL}};
  }else if(item.kind==='board'){
    const board=layout.boards.find(b=>b.id===item.boardId);
    if(!board)throw Error('这个板位不在保存的布局中，原图仍可选用。');
    view=boardView(board);highlight=cleanRoi(item.roi)||{...board.roi};
  }else if(item.kind==='selection'){
    highlight=cleanRoi(item.roi);
    const ids=new Set([item.boardId,...(Array.isArray(item.sourceBoardIds)?item.sourceBoardIds:[])].filter(Boolean));
    const sources=layout.boards.filter(b=>ids.has(b.id));
    const fitting=highlight?sources.filter(b=>contains(b.roi,highlight)).sort((a,b)=>a.roi.w*a.roi.h-b.roi.w*b.roi.h)[0]:sources.length===1?sources[0]:null;
    if(fitting)view=boardView(fitting);
    else{
      const regions=[...sources.map(b=>b.roi),...(highlight?[highlight]:[])];
      if(!regions.length)throw Error('这张截图没有可恢复的位置记录，原图仍可选用。');
      const roi=combinedRoi(regions);
      view={mode:contains(roi,FULL)?'overview':'focus',active:null,roi};
    }
  }else throw Error('这份材料没有可恢复的原图位置。');
  layout.active=view.active;
  return {layout,view,time:Math.min(verifiedLegacy?proof.time:snapshot.time,duration),highlight};
}
