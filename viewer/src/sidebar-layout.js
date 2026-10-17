export const DEFAULT_SIDEBAR_RATIO=.26;
export const SIDEBAR_RAIL=20;
export function sidebarLimits(width){
  const available=Math.max(1,Number(width)||1),minimum=Math.min(200,available/2);
  return {minimum,maximum:Math.max(minimum,available-1)};
}
export function sidebarSize(width,ratio=DEFAULT_SIDEBAR_RATIO){
  const fraction=Number.isFinite(ratio)?Math.max(0,Math.min(1,ratio)):DEFAULT_SIDEBAR_RATIO;
  const limits=sidebarLimits(width);
  return Math.max(limits.minimum,Math.min(limits.maximum,width*fraction));
}
export function viewerPreferences(value){
  return {schema:2,backSeconds:[5,8,10].includes(value?.backSeconds)?value.backSeconds:8,
    sidebarRatio:value?.schema===2&&Number.isFinite(value.sidebarRatio)?Math.max(0,Math.min(1,value.sidebarRatio)):DEFAULT_SIDEBAR_RATIO};
}

// Keep only the latest drag position while a native resize is in flight.
// A resize never opens, hides, recreates or focuses a question window.
export function createSidebarResizer({resize,preview,settled=()=>{},failed=()=>{}}){
  let latest=null,running=false,epoch=0;
  async function drain(){
    running=true;const ticket=epoch;
    try{
      while(ticket===epoch&&latest!==null){
        const width=latest;latest=null;await resize(width);
      }
      if(ticket===epoch)settled();
    }catch(error){if(ticket===epoch&&latest===null){settled();failed(error)}}
    finally{running=false;if(latest!==null)void drain()}
  }
  return {set(width){latest=width;preview(width);if(!running)void drain()},cancel(){epoch++;latest=null;settled()}};
}
