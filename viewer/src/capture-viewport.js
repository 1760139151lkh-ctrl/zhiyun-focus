import {captureDimensionsValid,MAX_CAPTURE_IMAGE_CHARS} from './capture.js';

// Native content bounds are measured in physical desktop pixels. CSS geometry
// stays relative to that content surface, independent of browser window chrome.
const fail=message=>{throw Object.assign(Error(message),{code:'capture_viewport_unresolved'})};
const finiteRect=r=>r&&['x','y','width','height'].every(k=>Number.isFinite(r[k]))&&r.width>0&&r.height>0;
const geometryOf=metrics=>metrics.geometry||metrics;
const normalized=metrics=>viewportMetrics({...metrics,...geometryOf(metrics),width:metrics.width,height:metrics.height,dpr:metrics.dpr});
const validIdentity=g=>typeof g.instance==='string'&&g.instance.trim().length>0&&g.instance.length<=128&&Number.isSafeInteger(g.epoch)&&g.epoch>=1;
export function viewportMetrics({width,height,dpr=1,aside=0,visual,mainRect}){
  if(![width,height,dpr,aside].every(Number.isFinite)||width<=0||height<=0||dpr<=0||aside<0||(!mainRect&&aside>=width))fail('课程视区尺寸无效，请等窗口稳定后重试。');
  const scale=visual?.scale??1,v={offsetLeft:visual?.offsetLeft??0,offsetTop:visual?.offsetTop??0,width:visual?.width??width/scale,height:visual?.height??height/scale,scale};
  if(!Object.values(v).every(Number.isFinite)||!Number.isFinite(dpr*v.scale)||v.scale<=0||v.width<=0||v.height<=0||v.offsetLeft<0||v.offsetTop<0||v.width*v.scale>width+2/dpr||v.height*v.scale>height+2/dpr)fail('可见课程视区尺寸无效，请等缩放稳定后重试。');
  const main=mainRect?{...mainRect}:{x:v.offsetLeft,y:v.offsetTop,w:v.width-aside,h:v.height};
  if(!['x','y','w','h'].every(k=>Number.isFinite(main[k]))||main.w<=0||main.h<=0||main.x<v.offsetLeft-.01||main.y<v.offsetTop-.01||main.x+main.w>v.offsetLeft+v.width+.01||main.y+main.h>v.offsetTop+v.height+.01)fail('课程区域不在当前可见视区内。');
  return {width,height,dpr,aside,visual:v,mainRect:main,rasterDpr:dpr*v.scale,pixelWidth:Math.round(width*dpr),pixelHeight:Math.round(height*dpr)};
}
const sameBounds=(a,b,tolerance=.25)=>['x','y','width','height'].every(k=>Math.abs(a[k]-b[k])<=tolerance);
const groups=candidates=>candidates.reduce((list,c)=>{
  const group=list.find(g=>sameBounds(g[0],c));group?group.push(c):list.push([c]);return list;
},[]);
export function selectContentViewport(candidates,metrics,{marker='',ownerId}={}){
  const m=viewportMetrics(metrics);
  const matching=candidates.filter(c=>finiteRect(c)&&c.visible!==false&&(ownerId===undefined||c.ownerId===ownerId)&&Math.abs(c.width-m.pixelWidth)<=2&&Math.abs(c.height-m.pixelHeight)<=2);
  const documents=matching.filter(c=>c.kind==='uia-document'&&marker&&String(c.name||'').includes(marker));
  const documentGroups=groups(documents);
  if(documentGroups.length>1)fail('课程内容位置暂时不明确，请等画面稳定后重试。');
  if(documentGroups.length===1)return {...documentGroups[0][0],cssWidth:m.width,cssHeight:m.height,dpr:m.dpr,visual:m.visual};
  const nativeGroups=groups(matching.filter(c=>c.kind==='chrome-render-widget'));
  if(nativeGroups.length!==1)fail('暂时无法确认课程内容位置，请等窗口稳定后重试。');
  return {...nativeGroups[0][0],cssWidth:m.width,cssHeight:m.height,dpr:m.dpr,visual:m.visual};
}
export function contentPixelRect(viewport,rect,{aside=0,mainRect,screen}={}){
  if(!finiteRect(viewport))fail('课程内容位置无效。');
  const m=viewportMetrics({width:viewport.cssWidth,height:viewport.cssHeight,dpr:viewport.dpr,visual:viewport.visual,aside,mainRect}),main=m.mainRect;
  if(!rect||!['x','y','w','h'].every(k=>Number.isFinite(rect[k]))||rect.x<main.x-.01||rect.y<main.y-.01||rect.w<=0||rect.h<=0||rect.x+rect.w>main.x+main.w+.01||rect.y+rect.h>main.y+main.h+.01)fail('选区不在当前课程画面内。');
  const sx=Math.max(0,Math.round((rect.x-m.visual.offsetLeft)*m.rasterDpr)),sy=Math.max(0,Math.round((rect.y-m.visual.offsetTop)*m.rasterDpr));
  const ex=Math.min(Math.round(viewport.width),Math.round((rect.x+rect.w-m.visual.offsetLeft)*m.rasterDpr)),ey=Math.min(Math.round(viewport.height),Math.round((rect.y+rect.h-m.visual.offsetTop)*m.rasterDpr));
  const value={x:Math.round(viewport.x)+sx,y:Math.round(viewport.y)+sy,width:ex-sx,height:ey-sy,sx,sy};
  if(value.width<1||value.height<1||(screen&&(!finiteRect(screen)||value.x<screen.x||value.y<screen.y||value.x+value.width>screen.x+screen.width||value.y+value.height>screen.y+screen.height)))fail('截图区域当前不可见，请将课程区域移回屏幕后重试。');
  return value;
}
export function sameContentViewport(a,b){
  return !!a&&!!b&&a.identity===b.identity&&a.ownerId===b.ownerId&&a.kind===b.kind&&sameBounds(a,b)&&a.cssWidth===b.cssWidth&&a.cssHeight===b.cssHeight&&a.dpr===b.dpr&&['width','height','offsetLeft','offsetTop','scale'].every(k=>(a.visual?.[k]??(k==='scale'?1:k==='width'?a.cssWidth:k==='height'?a.cssHeight:0))===(b.visual?.[k]??(k==='scale'?1:k==='width'?b.cssWidth:k==='height'?b.cssHeight:0)));
}
// The companion freezes one metrics object for the HTTP request. Compare that
// exact identity after every asynchronous boundary, including reconnects.
export function sameCaptureMetrics(a,b){
  try{
    const ag=geometryOf(a),bg=geometryOf(b),left=normalized(a),right=normalized(b);
    return validIdentity(ag)&&validIdentity(bg)&&ag.instance===bg.instance&&ag.epoch===bg.epoch&&
      ['width','height','dpr','aside'].every(k=>left[k]===right[k])&&
      ['width','height','offsetLeft','offsetTop','scale'].every(k=>left.visual[k]===right.visual[k])&&
      ['x','y','w','h'].every(k=>left.mainRect[k]===right.mainRect[k]);
  }catch{return false}
}
export function validateNativeCapture(result,rect,metrics,paint){
  const m=normalized(metrics),expected=geometryOf(metrics),proof=result?.viewport;
  if(paint&&(!result?.paint?.verified||result.paint.nonce!==paint.nonce))fail('截图画面尚未完成刷新确认，请重试。');
  if((metrics.geometry||expected.instance!==undefined||expected.epoch!==undefined)&&(!validIdentity(expected)||result?.geometry?.instance!==expected.instance||result?.geometry?.epoch!==expected.epoch))fail('截图任务的画面身份已变化，请重新截图。');
  if(!proof||!['chrome-render-widget','uia-document'].includes(proof.kind)||typeof proof.identity!=='string'||!proof.identity||typeof proof.ownerId!=='string'||!proof.ownerId||!finiteRect(proof)||!['x','y','width','height'].every(k=>Number.isInteger(proof[k]))||Math.abs(proof.width-m.pixelWidth)>2||Math.abs(proof.height-m.pixelHeight)>2||proof.cssWidth!==m.width||proof.cssHeight!==m.height||proof.dpr!==m.dpr)fail('截图的课程视区已变化，请重新截图。');
  const actual=viewportMetrics({width:proof.cssWidth,height:proof.cssHeight,dpr:proof.dpr,visual:proof.visual,aside:m.aside,mainRect:m.mainRect});
  if(['width','height','offsetLeft','offsetTop','scale'].some(k=>actual.visual[k]!==m.visual[k]))fail('截图的可见视区已变化，请重新截图。');
  const pixels=contentPixelRect(proof,rect,{aside:m.aside,mainRect:m.mainRect});
  const raster=result.raster;
  if(!raster||!['x','y','width','height'].every(k=>Number.isFinite(raster[k])&&Math.abs(raster[k]-pixels[k])<.01))fail('截图的像素区域与圈选不一致，请重新截图。');
  if(!captureDimensionsValid(pixels.width,pixels.height)||result.width!==pixels.width||result.height!==pixels.height||typeof result.image!=='string'||!result.image.startsWith('data:image/png;base64,')||result.image.length>MAX_CAPTURE_IMAGE_CHARS)fail('截图尺寸与课程区域不一致，请重新截图。');
  return result;
}
