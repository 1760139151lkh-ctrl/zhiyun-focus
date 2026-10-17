// Optional local, buffered speech enhancement. The original video owns time.
// No MediaElementAudioSource binding; no microphone or external upload.
export function createClarityAudio(video, notify, {prepare:prepareService=async()=>{},endpoint='http://127.0.0.1:8771',request=fetch,contextFactory=()=>new AudioContext({latencyHint:'interactive'}),sourceAllowed}={}) {
  const ENDPOINT=endpoint;
  let session=null,generation=0,lastInfo=null;
  const listeners=new AbortController();
  const on=(name,fn)=>video.addEventListener(name,fn,{signal:listeners.signal});
  function report(s,message='',phase='ready',action=null){
    if(session!==s)return;
    if(s.failure&&!message){message='后续人声暂不可用';action='retry';}
    const detail={actualRoute:s.ownsMute?'clarity':'original',phase,action,paused:video.paused};
    const key=JSON.stringify([message,detail]);if(key===s.reportKey)return;s.reportKey=key;notify('clarity',message,detail);
  }
  function silenceGraph(s) {
    if(!s)return;
    try{s.node?.stop()}catch{};try{s.node?.disconnect()}catch{};s.node=null;s.playing=null;
    try{s.output?.gain.cancelScheduledValues(s.ctx.currentTime);s.output?.gain.setValueAtTime(0,s.ctx.currentTime)}catch{}
  }
  function native(s) {
    if(!s)return;
    silenceGraph(s);
    if(s.ownsMute){s.ownsMute=false;video.muted=s.originalMuted;}
  }
  function parkOutput(s){
    native(s);if(!s.ctx.suspend||s.suspending||s.ctx.state!=='running')return;
    s.suspending=true;Promise.resolve(s.ctx.suspend()).catch(()=>{}).finally(()=>{s.suspending=false;if(session===s&&!video.paused&&video.volume>0)resumeOutput(s)});
  }
  function resumeOutput(s){
    if(session!==s)return;waiting(s);if(s.resuming)return;s.resuming=true;
    const timeout=setTimeout(()=>{if(session===s&&s.ctx.state!=='running')stop('声音输出暂不可用，已恢复原声。',{action:'retry'});},1800);
    Promise.resolve().then(()=>s.ctx.resume()).then(()=>{if(session===s)tick(s)}).catch(()=>{if(session===s)stop('声音输出暂不可用，已恢复原声。',{action:'retry'})}).finally(()=>{clearTimeout(timeout);s.resuming=false});
  }
  function stop(message='',detail={}) {
    generation++;const s=session;session=null;
    if(s){
      clearInterval(s.timer);s.controller.abort();s.work?.controller.abort();native(s);s.cache.clear();s.ctx.close().catch(()=>{});
    }
    notify('original',message,{actualRoute:'original',phase:message?'failed':'ready',action:null,...detail});
  }
  function waiting(s) {
    if(session!==s)return;
    // Preparation never takes ownership of the user's playback state.
    // Keep original sound audible and identify the actual route honestly.
    native(s);
    s.waiting=true;report(s,video.paused?'声音准备中…':'原声播放 · 人声准备中…',s.ready?'buffering':'preparing');
  }
  function matching(s,time) {
    return [...s.cache.values()].filter(b=>time>=b.start&&time<b.start+b.duration-.06)
      .sort((a,b)=>b.start-a.start)[0];
  }
  function outputClock(s){
    const render=s.ctx.currentTime,now=performance.now();
    const latency=Math.max(0,Number(s.ctx.baseLatency)||0)+Math.max(0,Number(s.ctx.outputLatency)||0);
    let audible=render-latency;
    try{
      const stamp=s.ctx.getOutputTimestamp?.(),age=stamp?now-stamp.performanceTime:Infinity;
      // A device can report the pre-suspend timestamp immediately after a
      // long pause. Use it only while it describes the current output stream.
      if(stamp&&stamp.performanceTime>0&&Number.isFinite(stamp.contextTime)&&age>=0&&age<500&&stamp.contextTime<=render){
        audible=Math.min(render,stamp.contextTime+age/1000);
      }
    }catch{}
    return {render,audible,lead:Math.max(0,render-audible)};
  }
  function playBuffer(s,b) {
    const clock=outputClock(s),now=video.currentTime+clock.lead*s.rate,offset=(now-b.start)/s.rate;
    if(offset<0||offset>=b.buffer.duration-.04){waiting(s);return;}
    // A buffer transition must not briefly unmute the native media. That
    // toggles the browser's audio clock/output path and can cause repeated drift.
    silenceGraph(s);
    const n=s.ctx.createBufferSource();n.buffer=b.buffer;n.connect(s.output);
    s.output.gain.setValueAtTime(0,s.ctx.currentTime);
    n.start(clock.render,offset);
    s.node=n;s.playing={buffer:b,media:now,context:clock.render};
    s.ownsMute=true;video.muted=true;
    s.output.gain.linearRampToValueAtTime(video.volume,s.ctx.currentTime+.025);
    n.onended=()=>{if(session===s&&s.node===n){s.node=null;s.playing=null;tick(s)}};
    s.switches++;
    report(s,'','ready');
  }
  function waitForRetry(signal,milliseconds) {
    return new Promise((resolve,reject)=>{
      const abort=()=>{clearTimeout(timer);reject(signal.reason)};
      const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve()},milliseconds);
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    });
  }
  async function prepare(s,start,seconds=8) {
    if(!s.authorized||s.busy||s.failure||s.cache.has(start)||session!==s)return;
    s.busy=true;const epoch=s.epoch,rate=s.rate,work={controller:new AbortController()};s.work=work;
    try{
      const deadline=AbortSignal.any([s.controller.signal,work.controller.signal,AbortSignal.timeout(20000)]);
      for(let attempt=0;attempt<2;attempt++){
        try{
          let r;
          for(;;){
            try{r=await request(ENDPOINT+'/enhance',{method:'POST',credentials:'omit',
              headers:{'Content-Type':'application/json','X-ZJF-Protocol':'1'},
              body:JSON.stringify({url:s.sourceKey,start,rate,seconds}),signal:deadline});}
            catch(error){throw Object.assign(Error('request'),{retryable:!deadline.aborted})}
            if(r.status!==429)break;
            await r.body?.cancel().catch(()=>{});await waitForRetry(deadline,500);
            if(session!==s||epoch!==s.epoch||s.work!==work)return;
          }
          if(!r.ok){await r.body?.cancel().catch(()=>{});throw Object.assign(Error('helper'),{retryable:r.status>=500})}
          const meta=JSON.parse(r.headers.get('X-ZJF-Result')||'null');
          let bytes;try{bytes=await r.arrayBuffer()}catch(error){throw Object.assign(Error('request'),{retryable:!deadline.aborted})}
          if(session!==s||epoch!==s.epoch||s.work!==work)return;
          if(bytes.byteLength>5_000_000||!meta||meta.start!==start||meta.rate!==rate)throw Error('response');
          let buffer,aborted;
          try{buffer=await Promise.race([s.ctx.decodeAudioData(bytes),new Promise((_,reject)=>{aborted=()=>reject(deadline.reason);deadline.addEventListener('abort',aborted,{once:true});if(deadline.aborted)aborted()})])}
          finally{deadline.removeEventListener('abort',aborted)}
          if(session!==s||epoch!==s.epoch||s.work!==work)return;
          if(deadline.aborted)throw deadline.reason;
          const samples=buffer.getChannelData(0);
          if(buffer.numberOfChannels!==1||!samples.length||samples.some(x=>!Number.isFinite(x)||Math.abs(x)>.84))throw Error('signal');
          if(start+buffer.duration*rate<=video.currentTime+.06)throw Object.assign(Error('obsolete buffer'),{retryable:true});
          const b={start,rate,duration:buffer.duration*rate,buffer};s.cache.set(start,b);
          while(s.cache.size>2)s.cache.delete(Math.min(...s.cache.keys()));
          s.requests++;s.maxProcessingMs=Math.max(s.maxProcessingMs,meta.processing_ms||0);
          s.ready=true;s.failure='';s.healthFailures=0;s.recoveringHealth=false;
          lastInfo={engine:'MossFormer2_SE_48K',sampleRate:s.ctx.sampleRate,
            processingMs:meta.processing_ms,baseLatency:s.ctx.baseLatency,
            outputLatency:s.ctx.outputLatency??null};
          return;
        }catch(error){
          if(session!==s||epoch!==s.epoch||s.work!==work)return;
          if(attempt||!error.retryable||deadline.aborted)throw error;
          // One retry shares the original deadline. Recalculate its range so
          // normal playback cannot turn recovery into repeated obsolete work.
          await waitForRetry(deadline,1000);
          if(session!==s||epoch!==s.epoch||s.work!==work)return;
          const current=matching(s,video.currentTime);
          start=current?Math.floor(current.start+current.duration-2):Math.max(0,Math.floor(video.currentTime));seconds=current?24:8;
          if(start>=video.duration)return;
        }
      }
    }catch(e){if(session===s&&epoch===s.epoch&&s.work===work)s.failure='处理已中断';}
    finally{if(session===s&&s.work===work){s.work=null;s.busy=false;tick(s)}}
  }
  function tick(s) {
    if(session!==s)return;
    try{updateOutput(s)}catch{
      // A device/graph failure must never strand the video behind our mute.
      if(session===s)stop('声音输出已中断，已恢复原声。',{action:'retry'});
    }
  }
  function updateOutput(s) {
    if(!s.authorized){waiting(s);return;}
    if(!video.isConnected||video.error||video.currentSrc!==s.sourceKey){stop('声音来源已变，已恢复原声。');return;}
    if(s.ctx.state==='suspended'&&!video.paused&&video.volume>0){resumeOutput(s);return;}
    // A paused context can decode and prefetch. Seeking while paused must not
    // strand an empty cache until playback resumes.
    if(s.ctx.state!=='running'&&s.ctx.state!=='suspended'){stop('声音输出已中断，已恢复原声。');return;}
    // The first model load can occupy the local service for several seconds.
    // An in-flight enhance request already detects a stopped service; don't
    // cancel it because a competing two-second health probe times out.
    if(!s.healthBusy&&!s.busy&&(!s.failure||s.recoveringHealth)&&s.ready&&performance.now()-s.lastHealth>5000){
      s.healthBusy=true;s.lastHealth=performance.now();
      const healthEpoch=s.epoch,healthRequests=s.requests;
      request(ENDPOINT+'/health',{credentials:'omit',signal:AbortSignal.any([s.controller.signal,AbortSignal.timeout(2000)])})
        .then(async r=>{
          if(!r.ok)throw Error('helper');const state=await r.json();
          if(!state||state.protocol!==1||state.engine&&state.engine!=='MossFormer2_SE_48K')throw Object.assign(Error('helper'),{terminal:true});
          if(state.status==='error')throw Error('helper');
          if(session===s&&healthEpoch===s.epoch&&healthRequests===s.requests){s.healthFailures=0;if(s.recoveringHealth){s.recoveringHealth=false;s.failure='';tick(s)}}
        })
        .catch(error=>{if(session===s&&healthEpoch===s.epoch&&healthRequests===s.requests&&!s.busy){
          if(error.terminal){stop('声音服务已变，已恢复原声。');return;}
          if(++s.healthFailures<2)return;
          // Recheck this same connection once while native sound remains
          // available. Never launch another helper or restart exhausted work.
          s.failure='连接已中断';
          if(s.healthFailures>2){stop(s.failure,{action:'retry'});return;}
          s.recoveringHealth=true;tick(s);
        }})
        .finally(()=>{s.healthBusy=false});
    }
    const t=video.currentTime;
    if(Number.isFinite(video.duration)&&t>=video.duration-.08){stop('',{phase:'ended'});return;}
    s.meter.getFloatTimeDomainData(s.meterData);s.outputPeak=0;
    for(const x of s.meterData)s.outputPeak=Math.max(s.outputPeak,Math.abs(x));
    s.maxOutputPeak=Math.max(s.maxOutputPeak,s.outputPeak);
    for(const [key,b]of s.cache)if(b.start+b.duration<t-.1)s.cache.delete(key);
    const b=matching(s,t);
    if(!b&&s.failure&&!s.recoveringHealth){stop(s.failure,{action:'retry'});return;}
    if(!b||video.seeking||s.mediaWaiting||s.recoveringHealth){
      waiting(s);
    }else if(video.paused||video.readyState<3||video.volume===0){
      // Silent AudioContexts may not advance at the audible hardware clock.
      // Keep prefetching, but don't repeatedly restart an inaudible source.
      if(video.paused||video.volume===0)parkOutput(s);else native(s);
      s.waiting=false;report(s,'','ready');
    }else{
      s.waiting=false;
      const clock=outputClock(s);
      const drift=s.playing?Math.abs(t-(s.playing.media+(clock.audible-s.playing.context)*s.rate)):0;
      s.maxObservedDrift=Math.max(s.maxObservedDrift,drift);
      if(!s.playing||s.playing.buffer!==b||drift>.10)playBuffer(s,b);
      else report(s,'','ready');
    }
    // Two short overlapping ranges, requested sequentially. Never an entire lesson.
    if(!video.seeking&&!s.busy&&!s.failure&&video.volume>0){
      if(!b)prepare(s,Math.max(0,Math.floor(t)));
      else {const next=Math.floor(b.start+b.duration-2);if(next>b.start&&next<video.duration&&!s.cache.has(next))prepare(s,next,24)}
    }
  }
  async function start() {
    if(session)return;
    if(video.muted||video.volume===0){notify('original','请先解除静音');return;}
    const other=[...document.querySelectorAll('audio,video')].some(v=>v!==video&&!v.paused&&!v.muted&&v.volume>0&&(v.webkitAudioDecodedByteCount>0||v.tagName==='AUDIO'));
    if(other){notify('original','请先暂停另一段声音，再继续清晰人声。',{actualRoute:'original',phase:'waiting',action:'retry'});return;}
    const u=new URL(video.currentSrc,location.href);
    const allowed=sourceAllowed?sourceAllowed(u):u.protocol==='https:'&&['vod.cmc.zju.edu.cn','resource.cmc.zju.edu.cn'].includes(u.hostname)&&u.pathname.toLowerCase().endsWith('.mp4')&&!u.username&&!u.password&&(!u.port||u.port==='443');
    if(!allowed){notify('original','此音源暂不支持',{actualRoute:'original',phase:'failed',action:null});return;}
    const ticket=++generation;
    let ctx;try{ctx=contextFactory()}catch{notify('original','声音输出暂不可用',{actualRoute:'original',phase:'failed',action:'retry'});return;}
    const s={ctx,controller:new AbortController(),sourceKey:video.currentSrc,
      originalMuted:video.muted,ownsMute:false,cache:new Map(),rate:video.playbackRate,
      epoch:0,authorized:false,busy:false,ready:false,waiting:true,mediaWaiting:false,work:null,failure:'',requests:0,switches:0,fallbacks:0,maxProcessingMs:0,maxObservedDrift:0,outputPeak:0,maxOutputPeak:0,lastHealth:performance.now(),healthBusy:false,healthFailures:0,recoveringHealth:false};
    session=s;
    let step='output';
    try{
      s.output=ctx.createGain();s.output.gain.value=0;
      s.meter=ctx.createAnalyser();s.meter.fftSize=512;s.meterData=new Float32Array(512);
      s.output.connect(s.meter);s.meter.connect(ctx.destination);
      ctx.addEventListener?.('statechange',()=>{if(session===s){if(ctx.state!=='running')native(s);tick(s)}},{signal:s.controller.signal});
      report(s,'人声准备中…','preparing');
      waiting(s);
      const outputDeadline=AbortSignal.any([s.controller.signal,AbortSignal.timeout(1800)]);let aborted;
      try{await Promise.race([ctx.resume(),new Promise((_,reject)=>{aborted=()=>reject(outputDeadline.reason);outputDeadline.addEventListener('abort',aborted,{once:true});if(outputDeadline.aborted)aborted()})])}
      finally{outputDeadline.removeEventListener('abort',aborted)}
      step='startup';await prepareService(s.controller.signal);
      if(ticket!==generation)return;
      if(!video.isConnected||video.currentSrc!==s.sourceKey)throw Error('source changed');
      step='health';
      const health=await request(ENDPOINT+'/health',{credentials:'omit',signal:AbortSignal.any([s.controller.signal,AbortSignal.timeout(4000)])});
      if(!health.ok)throw Error('helper');const state=await health.json();
      if(!state||state.protocol!==1||state.engine&&state.engine!=='MossFormer2_SE_48K'||state.status==='error')throw Error('helper');
      // A positive browser CORS/range probe is required before sending this URL
      // to the local decoder. It is never a fallback around a CORS rejection.
      step='source';
      const readable=await request(s.sourceKey,{credentials:'omit',mode:'cors',headers:{Range:'bytes=0-1023'},signal:AbortSignal.any([s.controller.signal,AbortSignal.timeout(8000)])});
      if(readable.status!==206){await readable.body?.cancel();throw Error('range');}
      if((await readable.arrayBuffer()).byteLength!==1024)throw Error('range');
      if(ticket!==generation)return;
      if(!video.isConnected||video.currentSrc!==s.sourceKey)throw Error('source changed');
      s.authorized=true;
      report(s,video.paused?'声音准备中…':'原声播放 · 人声准备中…','preparing');
      s.timer=setInterval(()=>tick(s),120);
      await prepare(s,Math.max(0,Math.floor(video.currentTime)));
    }catch(error){if(ticket===generation){
      const sourceRetry=step==='source'&&['TimeoutError','TypeError'].includes(error.name);
      const message=step==='source'?(sourceRetry?'媒体读取暂时中断，已保留原声。':'此音源暂不可处理'):step==='startup'?error.message:step==='output'?'声音输出未开启':'连接已中断';
      stop(message,{action:error.action||(step==='source'&&!sourceRetry?undefined:'retry')});
    }else ctx.close().catch(()=>{});}
  }
  function reset() {
    const s=session;if(!s)return;
    waiting(s);s.epoch++;s.work?.controller.abort();s.work=null;s.busy=false;s.failure='';s.healthFailures=0;s.recoveringHealth=false;s.cache.clear();s.rate=video.playbackRate;s.ready=false;
    // Pending work may finish, but its epoch can no longer enter the cache.
    if(!video.seeking)prepare(s,Math.max(0,Math.floor(video.currentTime)));
  }
  on('seeking',reset);on('seeked',()=>{if(session)tick(session)});on('ratechange',reset);
  on('pause',()=>{const s=session;if(s&&video.paused){parkOutput(s);report(s,'',s.ready?'ready':'preparing')}});
  on('waiting',()=>{if(session){session.mediaWaiting=true;waiting(session)}});
  on('play',()=>{if(session)tick(session)});on('playing',()=>{if(session){session.mediaWaiting=false;tick(session)}});
  on('volumechange',()=>{const s=session;if(!s)return;if(s.ownsMute&&!video.muted){stop('已恢复原声，可重新启用清晰人声。',{action:'retry'});return;}if(!s.ownsMute&&video.muted){stop('视频已静音，解除静音后可继续清晰人声。',{phase:'paused'});return;}s.output.gain.setTargetAtTime(s.ownsMute?video.volume:0,s.ctx.currentTime,.015);tick(s)});
  on('error',()=>stop('媒体中断，已恢复原声。'));on('emptied',()=>stop());on('ended',()=>stop('',{phase:'ended'}));
  function pauseForInteraction(){
    const s=session,resume=!video.paused;
    if(s)native(s);
    video.pause();return resume;
  }
  return {start,stop,pause:pauseForInteraction,dispose(){stop();listeners.abort()},inspect:()=>({
    mode:session?'clarity':'original',route:session?(session.waiting?'original-preparing':session.ownsMute?'processed':'paused'):'original',actualRoute:session?.ownsMute?'clarity':'original',context:session?.ctx.state||'none',ownsMute:!!session?.ownsMute,
    ready:!!session?.ready,busy:!!session?.busy,failed:!!session?.failure,buffered:session?[...session.cache.values()].map(b=>({start:b.start,duration:b.duration})):[],
    requests:session?.requests||0,switches:session?.switches||0,fallbacks:session?.fallbacks||0,
    maxProcessingMs:session?.maxProcessingMs||0,maxObservedDrift:session?.maxObservedDrift||0,
    outputPeak:session?.outputPeak||0,maxOutputPeak:session?.maxOutputPeak||0,
    outputGain:session?.output.gain.value||0,contextTime:session?.ctx.currentTime||0,
    playing:session?.playing?{media:session.playing.media,context:session.playing.context,bufferStart:session.playing.buffer.start}:null,lastInfo})};
}
