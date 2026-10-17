using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;

sealed class CaptureProtocolException : Exception {
    public readonly string Code;
    public CaptureProtocolException(string code,string message):base(message){Code=code;}
}
sealed partial class WebViewChatWindows {
    const int CaptureLimit=100,InboundMessageLimit=4*1024*1024;
    static readonly string captureDispatchInstance=Guid.NewGuid().ToString("D");
    static long captureDispatchSequence;
    static readonly object captureOperationGate=new object();
    static readonly Dictionary<string,long> activeCaptureOperations=new Dictionary<string,long>();
    static readonly SemaphoreSlim draftWriterGate=new SemaphoreSlim(1,1);
    static readonly object draftWriterStateGate=new object();
    static readonly Dictionary<string,CaptureDraftWriter> draftWriters=new Dictionary<string,CaptureDraftWriter>();
    readonly Dictionary<string,CaptureDraftClaim> captureDraftClaims=new Dictionary<string,CaptureDraftClaim>();
    readonly object captureGate=new object();
    readonly Dictionary<string,CaptureAttempt> captureStatus=new Dictionary<string,CaptureAttempt>();
    readonly Dictionary<string,string> captureOperations=new Dictionary<string,string>();
    readonly Dictionary<string,DraftRestoreAction> captureRestores=new Dictionary<string,DraftRestoreAction>();
    readonly Dictionary<string,CaptureDraftSave> captureDraftSaves=new Dictionary<string,CaptureDraftSave>();
    readonly Dictionary<string,CaptureDraftBuffer> captureDraftBuffers=new Dictionary<string,CaptureDraftBuffer>();
    readonly HashSet<string> retiredCapturePages=new HashSet<string>();
    readonly Queue<string> retiredCapturePageOrder=new Queue<string>();
    CaptureIdentity captureTarget;
    CoreWebView2 captureBrowser;
    int captureHostTicket;
    long captureDocumentEpoch;
    ulong captureNavigationId;
    string captureChallenge="";
    bool captureComposerReady;
    string captureComposerError="";
    string captureComposerDraftId="";
    string captureTransportError="";
    long captureWorkspaceRevision;
    string captureWorkspaceMode="closed";
    long conversationNavigationRevision;
    string newConversationFrom="",viewerInstance="";
    string viewerLessonKey="";
    Dictionary<string,object> viewerCourse=new Dictionary<string,object>();
    public string LessonKey {get{return viewerLessonKey;}}
    public void SetLessonContext(Dictionary<string,object> value){
        string previousKey=viewerLessonKey,previousCourse=new JavaScriptSerializer().Serialize(viewerCourse);
        viewerLessonKey=StudyLibrary.NormalizeLessonKey(CaptureEcho(value,"lessonKey",512));
        object raw;viewerCourse=value.TryGetValue("course",out raw)&&raw is Dictionary<string,object>?(Dictionary<string,object>)raw:new Dictionary<string,object>();
        if(previousKey==viewerLessonKey&&previousCourse!=new JavaScriptSerializer().Serialize(viewerCourse)&&captureBrowser!=null&&captureTarget!=null)
            CaptureReply(captureBrowser,captureHostTicket,new {kind="zjf-lesson-metadata",protocol=2,lessonKey=viewerLessonKey,course=viewerCourse,target=captureTarget.Snapshot()});
    }
    public void SetViewerInstance(string value){
        if(viewerInstance==value)return;viewerInstance=value;
        if(captureBrowser!=null&&captureTarget!=null)try{CaptureReply(captureBrowser,captureHostTicket,new {kind="zjf-viewer-instance",viewerInstance=viewerInstance,target=captureTarget.Snapshot()});}catch{}
    }
    public void SetWorkspaceState(string mode,long revision){
        lock(captureGate){
            if(captureWorkspaceMode==mode&&captureWorkspaceRevision==revision)return;
            captureWorkspaceMode=mode;captureWorkspaceRevision=revision;conversationNavigationRevision++;newConversationFrom="";AdvanceCaptureDraftStructure();
            foreach(var attempt in captureStatus.Values)if(attempt.State=="queued"||attempt.State=="working"){attempt.State="cancelled";attempt.ErrorCode="workspace_changed";attempt.Error="提问工作区已切换，原材料已保留。";attempt.Evidence="";attempt.Updated=CaptureClock();}
            if(captureBrowser!=null&&captureTarget!=null)CaptureReply(captureBrowser,captureHostTicket,new {kind="zjf-workspace-state",protocol=2,workspaceRevision=revision,mode=mode,target=captureTarget.Snapshot()});
        }
    }
    CaptureDraftSave captureDraftSave;
    long captureDraftStructureGeneration;
    TaskCompletionSource<object> captureDraftChanged=new TaskCompletionSource<object>();
    internal Func<DateTime> CaptureClock=delegate{return DateTime.UtcNow;};
    sealed class CaptureIdentity {
        public string ConversationId,Route,PageId;
        public long DocumentEpoch,RouteGeneration,ComposerGeneration;
        public Dictionary<string,object> Snapshot(){return new Dictionary<string,object>{{"conversationId",ConversationId},{"route",Route},{"pageId",PageId},{"documentEpoch",DocumentEpoch},{"routeGeneration",RouteGeneration},{"composerGeneration",ComposerGeneration}};}
        public bool Same(CaptureIdentity other){return other!=null&&ConversationId==other.ConversationId&&Route==other.Route&&PageId==other.PageId&&DocumentEpoch==other.DocumentEpoch&&RouteGeneration==other.RouteGeneration&&ComposerGeneration==other.ComposerGeneration;}
    }
    sealed class CaptureAttempt {
        public string MaterialId,OperationId,AttemptId,DraftId,State="queued",Error="",ErrorCode="",Evidence="",ReconcileFrom="",CompletionState="",CompletionEvidence="";
        public bool HasCompletion,IsPlan;
        public long DispatchSequence;
        public long WorkspaceRevision;
        public Func<bool> Current;
        public int Count,CompletionCount;
        public CaptureIdentity Target;
        public Dictionary<string,object> Delivery;
        public Task Dispatch,Projection,Acknowledgement;
        public DateTime Updated;
        public Dictionary<string,object> Snapshot(){
            string state=HasCompletion?CompletionState:State,evidence=HasCompletion?CompletionEvidence:Evidence;
            return new Dictionary<string,object>{{"protocol",2},{"id",MaterialId},{"materialId",MaterialId},{"operationId",OperationId},{"attemptId",AttemptId},{"target",Delivery==null?Target.Snapshot():Delivery["target"]},{"workspaceRevision",WorkspaceRevision},{"state",state},{"error",HasCompletion?"":Error},{"code",HasCompletion?"":ErrorCode},{"count",HasCompletion?CompletionCount:Count},{"evidence",evidence},{"verified",HasCompletion&&((state=="attached"&&evidence=="composer")||(state=="already-sent"&&evidence=="confirmed-message")||(state=="removed"&&evidence=="composer-removal"))}};
        }
    }
    sealed class DraftRestoreAction {
        public string ActionId,DraftId,MaterialId,ReferenceKey,SourceToken,PlanId,Purpose;
        public long StructureGeneration;
        public CaptureIdentity Target;
        public Task Projection,Changed;
        public DateTime Updated;
    }
    sealed class CaptureDraftSave {
        public string DraftId,Status,StructureKey;
        public long Revision;
        public CaptureIdentity Target;
        public Task Saving;
        public DateTime Updated;
    }
    sealed class CaptureDraftBuffer {
        public Dictionary<string,object> Question;public string DraftId;public long Revision;public CaptureIdentity Target;
        public Task Saving;public Task<Dictionary<string,object>> Recovery;public bool Accepted,Retired,Saved;
    }
    sealed class DraftProjectionReply {public string Json,PlanId;}
    sealed class CaptureDraftWriter {
        public WebViewChatWindows Owner;public CaptureIdentity Target;public string Status="draft";public int Pending;public bool Retired,Saved;
        public TaskCompletionSource<object> Idle=new TaskCompletionSource<object>();
    }
    sealed class CaptureDraftClaim {
        public string SourceId,SourceConversationId,DraftId,Disposition;public long SourceRevision,Revision;public CaptureIdentity Target;
        public object Snapshot(string requestId){return new {kind="zjf-draft-claimed",protocol=2,requestId=requestId,target=Target.Snapshot(),sourceId=SourceId,draftId=DraftId,disposition=Disposition,revision=Revision};}
    }
    static string CaptureReceiver(){using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("ZjfChatDraft.js"))using(var reader=new StreamReader(stream))return reader.ReadToEnd();}
    static bool ChatOrigin(string source){Uri uri;return Uri.TryCreate(source,UriKind.Absolute,out uri)&&uri.Scheme=="https"&&uri.Host=="chatgpt.com"&&uri.IsDefaultPort&&uri.UserInfo=="";}
    static string CaptureRoute(string source){return ChatOrigin(source)?new Uri(source).AbsolutePath.TrimEnd('/')==""?"/":new Uri(source).AbsolutePath.TrimEnd('/'):null;}
    static string CaptureConversation(string route){var match=Regex.Match(route??"",@"(?:^|/)c/([\w-]{1,128})$");return match.Success?"c:"+match.Groups[1].Value:null;}
    static bool CaptureId(object value){Guid parsed;return value is string&&Guid.TryParseExact((string)value,"D",out parsed);}
    static string CaptureText(Dictionary<string,object> data,string key,int limit,bool required=true){object value;if(data==null||!data.TryGetValue(key,out value)){if(!required)return "";throw new CaptureProtocolException("invalid_message","消息缺少 "+key+"。");}var text=value as string;if(text==null||text.Length>limit||(required&&text.Length==0))throw new CaptureProtocolException("invalid_message","消息字段 "+key+" 无效。");return text;}
    static long CaptureNumber(Dictionary<string,object> data,string key,long maximum,bool positive=false){object value;if(data==null||!data.TryGetValue(key,out value)||!(value is int||value is long))throw new CaptureProtocolException("invalid_message","消息数字字段 "+key+" 无效。");long number=Convert.ToInt64(value);if(number<(positive?1:0)||number>maximum)throw new CaptureProtocolException("invalid_message","消息数字字段 "+key+" 超出范围。");return number;}
    static string CaptureEcho(Dictionary<string,object> data,string key,int maximum){object value;return data!=null&&data.TryGetValue(key,out value)&&value is string&&((string)value).Length<=maximum?(string)value:"";}
    static List<Dictionary<string,object>> ReadProjectionRefs(Dictionary<string,object> data){
        object raw;if(!data.TryGetValue("keepRefs",out raw))throw new CaptureProtocolException("invalid_message","缺少图册保留范围。");var requested=raw as IList;if(requested==null||requested.Count>300)throw new CaptureProtocolException("invalid_message","本次图册的保留范围无效。");var refs=new List<Dictionary<string,object>>();
        foreach(var entry in requested){var reference=entry as Dictionary<string,object>;string snapshotId=CaptureText(reference,"snapshotId",36),itemId=CaptureText(reference,"itemId",300);if(!CaptureId(snapshotId))throw new CaptureProtocolException("invalid_message","图册来源编号无效。");var kept=new Dictionary<string,object>{{"snapshotId",snapshotId},{"itemId",itemId}};if(reference.ContainsKey("markId")){string markId=CaptureText(reference,"markId",36,false);if(markId!=""&&!CaptureId(markId))throw new CaptureProtocolException("invalid_message","图册标记编号无效。");kept["markId"]=markId;}refs.Add(kept);}return refs;
    }
    static CaptureIdentity ReadCaptureTarget(object raw){
        var data=raw as Dictionary<string,object>;var value=new CaptureIdentity{ConversationId=CaptureText(data,"conversationId",170),Route=CaptureText(data,"route",512),PageId=CaptureText(data,"pageId",36),DocumentEpoch=CaptureNumber(data,"documentEpoch",9007199254740991L),RouteGeneration=CaptureNumber(data,"routeGeneration",int.MaxValue,true),ComposerGeneration=CaptureNumber(data,"composerGeneration",int.MaxValue,true)};
        if(!CaptureId(value.PageId)||CaptureRoute("https://chatgpt.com"+value.Route)!=value.Route)throw new CaptureProtocolException("invalid_message","对话目标无效。");string canonical=CaptureConversation(value.Route);
        if(canonical!=null?value.ConversationId!=canonical:!value.ConversationId.StartsWith("provisional:")||!CaptureId(value.ConversationId.Substring("provisional:".Length)))throw new CaptureProtocolException("invalid_message","对话身份无效。");return value;
    }
    bool CurrentCaptureBrowser(CoreWebView2 browser,int ticket){return !disposed&&ticket==generation&&Exists(host)&&main!=null&&Object.ReferenceEquals(main.CoreWebView2,browser);}
    bool CurrentCaptureTarget(CoreWebView2 browser,int ticket,CaptureIdentity target){return CurrentCaptureBrowser(browser,ticket)&&captureTarget!=null&&captureTarget.Same(target)&&target.DocumentEpoch==captureDocumentEpoch&&CaptureRoute(browser.Source)==target.Route;}
    void PauseCaptureAttempts(string error){foreach(var attempt in captureStatus.Values)if(attempt.State!="error"&&attempt.State!="cancelled"){attempt.State="cancelled";attempt.Error=error;attempt.Evidence="";attempt.Updated=CaptureClock();}}
    void PruneCaptures(bool reserveSlot=false){
        var now=CaptureClock();var remove=new List<string>();foreach(var item in captureStatus){var age=(now-item.Value.Updated).TotalSeconds;if((item.Value.State=="queued"||item.Value.State=="working")&&age>120){item.Value.State="unknown";item.Value.Error="附图结果尚未确认，材料已保留，请重新验证。";item.Value.Updated=now;}else if(age>300)remove.Add(item.Key);}
        foreach(var key in remove)RemoveCapture(key);
        while(captureStatus.Count>=(reserveSlot?CaptureLimit:CaptureLimit+1)){CaptureAttempt oldest=null;foreach(var value in captureStatus.Values)if(value.State!="queued"&&value.State!="working"&&(oldest==null||value.Updated<oldest.Updated))oldest=value;if(oldest==null)break;RemoveCapture(oldest.AttemptId);}
    }
    static bool LatestCaptureOperation(CaptureAttempt attempt){lock(captureOperationGate){long latest;return activeCaptureOperations.TryGetValue(attempt.OperationId,out latest)&&latest==attempt.DispatchSequence;}}
    void SaveCaptureCompletion(CaptureAttempt attempt){
        if(!attempt.HasCompletion||attempt.Acknowledgement!=null)return;
        var payload=new Dictionary<string,object>{{"id",attempt.MaterialId},{"operationId",attempt.OperationId},{"attemptId",attempt.AttemptId},{"target",attempt.Delivery==null?attempt.Target.Snapshot():attempt.Delivery["target"]},{"receipt",attempt.Snapshot()}};
        StudyLibrary.PersistenceLease lease=null;
        try{
            // Acceptance precedes scheduling, so close/shutdown cannot discard
            // an already verified result while the page is being retired.
            lease=StudyLibrary.AcceptLibraryWork("/library/capture-ack",payload);var accepted=lease;
            attempt.Acknowledgement=Task.Run(delegate{using(accepted)return accepted.Execute(delegate{return StudyLibrary.AcknowledgeCapture(payload,true);});});
            attempt.Acknowledgement.ContinueWith(delegate(Task saved){if(saved.IsFaulted)Program.LogStartup(saved.Exception.GetBaseException());},TaskScheduler.Default);
        }catch(Exception error){if(lease!=null)lease.Dispose();Program.LogStartup(error);}
    }
    void AdvanceCaptureDraftStructure(){captureDraftStructureGeneration++;var changed=captureDraftChanged;captureDraftChanged=new TaskCompletionSource<object>();changed.TrySetResult(null);}
    void ClearCaptureDraft(CaptureIdentity next=null){
        bool sameDocument=next!=null&&captureTarget!=null&&next.PageId==captureTarget.PageId&&next.DocumentEpoch==captureTarget.DocumentEpoch;
        // The receiver caches canonical drafts while this document is alive.
        // Keep their writer ownership across SPA visits, but only retarget the
        // conversation actually being visited. A New chat retires provisional
        // ownership; a real navigation or controller teardown retires all.
        RetainRetiredDraftBuffers(sameDocument?next:null);RetireDraftWriters(sameDocument?next:null);
        AdvanceCaptureDraftStructure();captureDraftSave=null;captureDraftSaves.Clear();captureDraftClaims.Clear();
    }
    void RetireDraftWriters(CaptureIdentity next=null){lock(draftWriterStateGate){var remove=new List<string>();foreach(var entry in draftWriters)if(Object.ReferenceEquals(entry.Value.Owner,this)){
        var writer=entry.Value;if(next!=null&&!writer.Retired&&writer.Target.PageId==next.PageId&&writer.Target.DocumentEpoch==next.DocumentEpoch&&(writer.Target.ConversationId.StartsWith("c:")||writer.Target.ConversationId==next.ConversationId)){if(writer.Target.ConversationId==next.ConversationId)writer.Target=next;continue;}
        writer.Retired=true;if(writer.Pending==0){writer.Idle.TrySetResult(null);remove.Add(entry.Key);}
    }foreach(var id in remove)draftWriters.Remove(id);}}
    void RetireOtherDraftWriters(string draftId,CaptureIdentity target){
        var remove=new List<string>();foreach(var entry in draftWriters)if(entry.Key!=draftId&&Object.ReferenceEquals(entry.Value.Owner,this)&&entry.Value.Target.Same(target)&&entry.Value.Status=="draft"){entry.Value.Retired=true;if(entry.Value.Pending==0){entry.Value.Idle.TrySetResult(null);remove.Add(entry.Key);}}foreach(var id in remove)draftWriters.Remove(id);
    }
    CaptureDraftWriter HoldDraftWriter(string draftId,string status,CaptureIdentity target){lock(draftWriterStateGate){
        CaptureDraftWriter writer;if(draftWriters.TryGetValue(draftId,out writer)&&(writer.Retired||!Object.ReferenceEquals(writer.Owner,this)||!writer.Target.Same(target)))throw new CaptureProtocolException("draft_in_use","这份草稿正在另一处保存，原内容已保留，请重新选择草稿。");
        if(writer==null){writer=new CaptureDraftWriter{Owner=this,Target=target};draftWriters[draftId]=writer;}
        if(status=="draft")RetireOtherDraftWriters(draftId,target);writer.Status=status;if(writer.Pending++==0)writer.Idle=new TaskCompletionSource<object>();return writer;
    }}
    static void FinishDraftWriter(string draftId,CaptureDraftWriter writer,bool sent,bool saved=false){if(writer==null)return;lock(draftWriterStateGate){writer.Saved|=saved;if(sent)writer.Retired=true;writer.Pending--;if(writer.Pending==0){writer.Idle.TrySetResult(null);CaptureDraftWriter current;if(writer.Retired&&draftWriters.TryGetValue(draftId,out current)&&Object.ReferenceEquals(current,writer))draftWriters.Remove(draftId);}}}
    CaptureDraftClaim DecideDraftClaim(string sourceId,string sourceConversation,long sourceRevision,bool ordinaryResume,string composerText,CaptureIdentity target,Dictionary<string,object> metadata){
        if(metadata==null||CaptureText(metadata,"status",16)!="draft")throw new CaptureProtocolException("draft_changed","这份提问已不再是原草稿，当前输入已保留，请重新选择。");
        long revision=CaptureNumber(metadata,"revision",9007199254740991L,true);string storedConversation=CaptureText(metadata,"conversationId",170);object raw;var bound=metadata.TryGetValue("boundTarget",out raw)?raw as Dictionary<string,object>:null;
        bool sameConversation=storedConversation==target.ConversationId,reattach=false;
        if(ordinaryResume&&storedConversation.StartsWith("provisional:")&&target.ConversationId.StartsWith("provisional:")&&CaptureEcho(bound,"route",512)==target.Route&&!String.IsNullOrWhiteSpace(composerText))using(var hash=System.Security.Cryptography.SHA256.Create()){
            string rawHash=BitConverter.ToString(hash.ComputeHash(System.Text.Encoding.UTF8.GetBytes(composerText))).Replace("-","").ToLowerInvariant(),coreHash=BitConverter.ToString(hash.ComputeHash(System.Text.Encoding.UTF8.GetBytes(composerText.TrimEnd('\n')))).Replace("-","").ToLowerInvariant();
            reattach=CaptureEcho(metadata,"composerTextHash",64)==rawHash||CaptureEcho(metadata,"composerTextCoreHash",64)==coreHash;
            object history;var hashes=metadata.TryGetValue("previousComposerTextHashes",out history)?history as IList:null;if(!reattach&&hashes!=null)foreach(var value in hashes)if(value is string&&(string)value==coreHash){reattach=true;break;}
        }
        bool unsettled=metadata.TryGetValue("hasPending",out raw)&&raw is bool&&(bool)raw||metadata.TryGetValue("hasFailure",out raw)&&raw is bool&&(bool)raw;
        lock(draftWriterStateGate){
            CaptureDraftClaim cached;CaptureDraftWriter writer;
            if(captureDraftClaims.TryGetValue(sourceId,out cached)&&cached.SourceConversationId==sourceConversation&&cached.SourceRevision==sourceRevision&&cached.Revision==revision&&cached.Target.Same(target)&&(cached.Disposition=="copy"||!unsettled)&&draftWriters.TryGetValue(cached.DraftId,out writer)&&Object.ReferenceEquals(writer.Owner,this)&&writer.Target.Same(target)&&!writer.Retired)return cached;
            bool other=draftWriters.TryGetValue(sourceId,out writer)&&(writer.Retired||!Object.ReferenceEquals(writer.Owner,this)||!writer.Target.Same(target));
            bool sameLesson=viewerLessonKey==""||StudyLibrary.NormalizeLessonKey(CaptureEcho(metadata,"lessonKey",512))==viewerLessonKey;
            bool original=sameLesson&&!other&&!unsettled&&revision==sourceRevision&&storedConversation==sourceConversation&&(sameConversation||reattach);
            string id=original?sourceId:Guid.NewGuid().ToString("D");RetireOtherDraftWriters(id,target);
            if(!draftWriters.TryGetValue(id,out writer)){writer=new CaptureDraftWriter{Owner=this,Target=target};draftWriters[id]=writer;}
            var claim=new CaptureDraftClaim{SourceId=sourceId,SourceConversationId=sourceConversation,SourceRevision=sourceRevision,Revision=revision,DraftId=id,Disposition=original?"resume":"copy",Target=target};captureDraftClaims[sourceId]=claim;return claim;
        }
    }
    async Task ClaimCaptureDraft(CoreWebView2 browser,int ticket,CaptureIdentity target,string requestId,string sourceId,string sourceConversation,long sourceRevision,bool ordinaryResume,string composerText){
        await draftWriterGate.WaitAsync();try{
            Task pending=null;lock(draftWriterStateGate){CaptureDraftWriter writer;if(draftWriters.TryGetValue(sourceId,out writer)&&writer.Retired&&writer.Pending>0)pending=writer.Idle.Task;}
            if(pending!=null&&await Task.WhenAny(pending,Task.Delay(8000))!=pending)throw new CaptureProtocolException("draft_not_saved","原草稿仍在保存，当前输入已保留，请稍候重试。");
            var metadata=await Task.Run(delegate{return StudyLibrary.DraftClaimMetadata(sourceId);});lock(captureGate){if(!CurrentCaptureTarget(browser,ticket,target))return;}
            var claim=DecideDraftClaim(sourceId,sourceConversation,sourceRevision,ordinaryResume,composerText,target,metadata);CaptureReply(browser,ticket,claim.Snapshot(requestId));
        }finally{draftWriterGate.Release();}
    }
    Task SaveCaptureQuestion(Dictionary<string,object> question,string draftId,string status,CoreWebView2 browser,int ticket,CaptureIdentity target){
        var serializer=new JavaScriptSerializer{MaxJsonLength=InboundMessageLimit};var buffer=new CaptureDraftBuffer{Question=serializer.Deserialize<Dictionary<string,object>>(serializer.Serialize(question)),DraftId=draftId,Revision=CaptureNumber(question,"revision",9007199254740991L,true),Target=target};
        lock(captureGate){CaptureDraftBuffer prior;if(!captureDraftBuffers.TryGetValue(draftId,out prior)||buffer.Revision>=prior.Revision)captureDraftBuffers[draftId]=buffer;}
        var saving=SaveClaimedCaptureQuestion(buffer,status,browser,ticket);lock(captureGate)buffer.Saving=saving;return saving;
    }
    async Task SaveClaimedCaptureQuestion(CaptureDraftBuffer buffer,string status,CoreWebView2 browser,int ticket){
        string draftId=buffer.DraftId;var target=buffer.Target;
        Task saving;CaptureDraftWriter writer=null;await draftWriterGate.WaitAsync();try{
            Task retiring=null;lock(draftWriterStateGate){CaptureDraftWriter prior;if(status!="draft"&&draftWriters.TryGetValue(draftId,out prior)&&Object.ReferenceEquals(prior.Owner,this)&&prior.Retired&&prior.Pending>0)retiring=prior.Idle.Task;}
            if(retiring!=null&&await Task.WhenAny(retiring,Task.Delay(8000))!=retiring)throw new CaptureProtocolException("draft_not_saved","原提问仍在保存，请稍候核对发送记录。");
            bool unclaimed;lock(draftWriterStateGate)unclaimed=!draftWriters.ContainsKey(draftId);
            if(status=="draft"&&unclaimed){
                var stored=await Task.Run(delegate{return StudyLibrary.DraftClaimMetadata(draftId);});
                if(stored!=null){bool granted=false;lock(draftWriterStateGate){foreach(var claim in captureDraftClaims.Values)if(claim.DraftId==draftId&&claim.Target.Same(target)){granted=true;break;}}if(!granted)throw new CaptureProtocolException("draft_claim_required","这份草稿尚未取得当前编辑权，原内容已保留，请重新选择草稿。");}
            }
            lock(captureGate){if(buffer.Retired||!CurrentCaptureTarget(browser,ticket,target))throw new CaptureProtocolException("conversation_changed","草稿页面已变化，原内容已保留。");writer=HoldDraftWriter(draftId,status,target);saving=QueueCaptureQuestion(buffer.Question,draftId,status,target);buffer.Accepted=true;}
        }catch{FinishDraftWriter(draftId,writer,false);throw;}finally{draftWriterGate.Release();}
        bool sent=false,saved=false;try{await saving;saved=true;sent=status=="sent";lock(captureGate){buffer.Saved=true;CaptureDraftBuffer current;if(captureDraftBuffers.TryGetValue(draftId,out current)&&Object.ReferenceEquals(current,buffer))captureDraftBuffers.Remove(draftId);}}finally{FinishDraftWriter(draftId,writer,sent,saved);}
    }
    void RetainRetiredDraftBuffers(CaptureIdentity next=null){
        foreach(var buffer in captureDraftBuffers.Values){
            if(next!=null&&!buffer.Retired&&buffer.Target.PageId==next.PageId&&buffer.Target.DocumentEpoch==next.DocumentEpoch&&(buffer.Target.ConversationId.StartsWith("c:")||buffer.Target.ConversationId==next.ConversationId))continue;
            buffer.Retired=true;if(buffer.Saved||buffer.Recovery!=null&&!buffer.Recovery.IsFaulted&&!buffer.Recovery.IsCanceled)continue;
            try{
                // A not-yet-accepted editor save needs a persistence lease now,
                // before the renderer/owner is discarded. Accepted saves first
                // settle, then recover their exact failed payload if necessary.
                var accepted=buffer.Accepted?null:StudyLibrary.QueueQuestionRecovery(buffer.Question);buffer.Recovery=RecoverDraftBuffer(buffer,accepted);
            }catch(Exception error){var failed=new TaskCompletionSource<Dictionary<string,object>>();failed.SetException(error);buffer.Recovery=failed.Task;}
        }
    }
    async Task<Dictionary<string,object>> RecoverDraftBuffer(CaptureDraftBuffer buffer,Task<Dictionary<string,object>> accepted){
        if(accepted==null&&buffer.Saving!=null)try{await buffer.Saving;}catch{}
        if(accepted==null&&buffer.Saved)return null;
        var work=new List<Task<Dictionary<string,object>>>();foreach(var failed in StudyLibrary.RetainedQuestionFailures(buffer.DraftId))work.Add(StudyLibrary.QueueQuestionRecovery(failed));
        var latest=accepted??StudyLibrary.QueueQuestionRecovery(buffer.Question);work.Add(latest);await Task.WhenAll(work);return await latest;
    }
    async Task PreserveRetiredDraftBuffers(){
        Task[] work;lock(captureGate){RetainRetiredDraftBuffers();var pending=new List<Task>();foreach(var buffer in captureDraftBuffers.Values)if(buffer.Recovery!=null)pending.Add(buffer.Recovery);work=pending.ToArray();}
        await Task.WhenAll(work);
        lock(captureGate){var saved=new List<string>();foreach(var entry in captureDraftBuffers)if(entry.Value.Saved||entry.Value.Recovery!=null&&entry.Value.Recovery.Status==TaskStatus.RanToCompletion)saved.Add(entry.Key);foreach(var id in saved)captureDraftBuffers.Remove(id);}
    }
    static string DraftSourceText(Dictionary<string,object> value,string field){return CaptureEcho(value,field,2048);}
    static string DraftSourceId(Dictionary<string,object> value,string field){string text=DraftSourceText(value,field);Guid id;return Guid.TryParseExact(text,"D",out id)?id.ToString("D"):text;}
    static object DraftSourceValue(Dictionary<string,object> value,string field){object raw;return value!=null&&value.TryGetValue(field,out raw)?raw:null;}
    static string[] DraftSourceItems(object raw){
        var items=raw as IList;var keys=new SortedSet<string>(StringComparer.Ordinal);var serializer=new JavaScriptSerializer();if(items==null)return new string[0];
        foreach(var entry in items){var item=entry as Dictionary<string,object>;if(item==null){keys.Add("invalid");continue;}var reference=DraftSourceValue(item,"ref") as Dictionary<string,object>;
            string mark=DraftSourceId(reference,"markId");if(mark=="")mark=DraftSourceId(item,"markId");
            keys.Add(serializer.Serialize(new {id=DraftSourceText(item,"id"),kind=DraftSourceText(item,"kind"),snapshotId=DraftSourceId(reference??item,"snapshotId"),itemId=DraftSourceText(reference??item,reference==null?"id":"itemId"),markId=mark,attachmentId=DraftSourceText(item,"attachmentId"),materialId=DraftSourceId(item,"materialId"),sourceMaterialId=DraftSourceId(item,"sourceMaterialId"),removalGeneration=DraftSourceValue(item,"removalGeneration")}));
        }return new List<string>(keys).ToArray();
    }
    static string DraftSourceKey(Dictionary<string,object> question){
        var manifest=DraftSourceValue(question,"draftManifest") as Dictionary<string,object>;var draft=DraftSourceValue(manifest,"draft") as Dictionary<string,object>;var generations=DraftSourceValue(draft,"removalGenerations") as Dictionary<string,object>;var normalized=new SortedDictionary<string,object>(StringComparer.Ordinal);if(generations!=null)foreach(var entry in generations)normalized[entry.Key]=entry.Value;
        string url=DraftSourceText(question,"conversationUrl");var structure=new {conversationId=DraftSourceText(question,"conversationId"),conversationUrl=CaptureConversation(CaptureRoute(url))??url,version=DraftSourceValue(manifest,"version"),manifestConversation=DraftSourceText(manifest,"conversationId"),draftId=DraftSourceId(draft,"id"),hasLogicalItems=draft!=null&&draft.ContainsKey("logicalItems"),items=DraftSourceItems(DraftSourceValue(draft,"items")),logicalItems=DraftSourceItems(DraftSourceValue(draft,"logicalItems")),removed=DraftSourceItems(DraftSourceValue(draft,"removed")),removedLogical=DraftSourceItems(DraftSourceValue(draft,"removedLogical")),removalGenerations=normalized};
        byte[] bytes=System.Text.Encoding.UTF8.GetBytes(new JavaScriptSerializer{MaxJsonLength=InboundMessageLimit}.Serialize(structure));using(var hash=System.Security.Cryptography.SHA256.Create())return Convert.ToBase64String(hash.ComputeHash(bytes));
    }
    static async Task VerifyCaptureDraftSave(Task saving,string draftId,long revision,string structureKey,CaptureIdentity target){
        await saving.ConfigureAwait(false);
        await Task.Run(delegate{var stored=StudyLibrary.Run("/library/question",new Dictionary<string,object>{{"id",draftId}}) as Dictionary<string,object>;var manifest=DraftSourceValue(stored,"draftManifest") as Dictionary<string,object>;if(stored==null||CaptureEcho(stored,"status",16)!="draft"||CaptureNumber(stored,"revision",9007199254740991L,true)<revision||DraftSourceKey(stored)!=structureKey||!ReadCaptureTarget(DraftSourceValue(manifest,"boundTarget")).Same(target))throw new CaptureProtocolException("draft_not_saved","这次草稿来源没有保存为当前版本，请保留内容并重试。");}).ConfigureAwait(false);
    }
    Task QueueCaptureQuestion(Dictionary<string,object> question,string draftId,string status,CaptureIdentity target){
        var manifest=DraftSourceValue(question,"draftManifest") as Dictionary<string,object>;bool restorable=status=="draft"&&manifest!=null&&DraftSourceValue(manifest,"draft") is Dictionary<string,object>;
        long revision=CaptureNumber(question,"revision",9007199254740991L,true);string key=restorable?DraftSourceKey(question):"";CaptureDraftSave prior;
        if(captureDraftSaves.TryGetValue(draftId,out prior)&&revision<prior.Revision)return StudyLibrary.QueueQuestion(question);
        while(captureDraftSaves.Count>=CaptureLimit&&!captureDraftSaves.ContainsKey(draftId)){CaptureDraftSave oldest=null;foreach(var state in captureDraftSaves.Values)if(!Object.ReferenceEquals(state,captureDraftSave)&&(state.Saving==null||state.Saving.IsCompleted)&&(oldest==null||state.Updated<oldest.Updated))oldest=state;if(oldest==null)throw new CaptureProtocolException("draft_capacity","正在保存的草稿较多，请稍候重试。");captureDraftSaves.Remove(oldest.DraftId);}
        bool same=restorable&&captureDraftSave!=null&&captureDraftSave.DraftId==draftId&&captureDraftSave.Status==status&&captureDraftSave.StructureKey==key&&captureDraftSave.Target.Same(target);
        bool currentDraft=captureComposerDraftId==draftId||captureComposerDraftId==""&&restorable;
        if(currentDraft&&!same)AdvanceCaptureDraftStructure();
        var accepted=new CaptureDraftSave{DraftId=draftId,Status=status,StructureKey=key,Revision=revision,Target=target,Updated=CaptureClock()};captureDraftSaves[draftId]=accepted;if(currentDraft)captureDraftSave=restorable?accepted:null;
        try{var saving=StudyLibrary.QueueQuestion(question);accepted.Saving=restorable?VerifyCaptureDraftSave(saving,draftId,revision,key,target):saving;return accepted.Saving;}
        catch{if(same)AdvanceCaptureDraftStructure();throw;}
    }
    void ReadComposerState(Dictionary<string,object> data){
        object value;
        // Legacy readiness can describe the page, but delivery also requires
        // a bound logical question in CaptureReady.
        captureComposerReady=!data.TryGetValue("composerReady",out value)||(value is bool&&(bool)value);
        captureComposerError=CaptureText(data,"composerError",512,false);
        string draftId=CaptureText(data,"composerDraftId",36,false),next=CaptureId(draftId)?draftId:"";
        if(captureComposerDraftId!=next){
            AdvanceCaptureDraftStructure();CaptureDraftSave saved;
            captureDraftSave=next!=""&&captureDraftSaves.TryGetValue(next,out saved)&&saved.Status=="draft"&&saved.Target.Same(captureTarget)?saved:null;
            foreach(var attempt in captureStatus.Values)if((attempt.State=="queued"||attempt.State=="working")&&attempt.DraftId!=next){attempt.State="cancelled";attempt.ErrorCode="conversation_changed";attempt.Error="原提问已切换，材料已保留，请从学习记录重新选择。";attempt.Updated=CaptureClock();}
        }
        captureComposerDraftId=next;
    }
    void RetireCaptureBridge(){lock(captureGate){conversationNavigationRevision++;newConversationFrom="";PauseCaptureAttempts("提问页面已关闭，材料已保留。");lock(captureOperationGate){foreach(var attempt in captureStatus.Values){long latest;if(activeCaptureOperations.TryGetValue(attempt.OperationId,out latest)&&latest==attempt.DispatchSequence)activeCaptureOperations.Remove(attempt.OperationId);}}captureRestores.Clear();ClearCaptureDraft();captureTarget=null;captureBrowser=null;captureComposerReady=false;captureComposerError="";}}
    void RemoveCapture(string attemptId){CaptureAttempt value;if(!captureStatus.TryGetValue(attemptId,out value))return;captureStatus.Remove(attemptId);string latest;if(captureOperations.TryGetValue(value.OperationId,out latest)&&latest==attemptId)captureOperations.Remove(value.OperationId);lock(captureOperationGate){long sequence;if(activeCaptureOperations.TryGetValue(value.OperationId,out sequence)&&sequence==value.DispatchSequence)activeCaptureOperations.Remove(value.OperationId);}}
    void CaptureReply(CoreWebView2 browser,int ticket,object value,int maximum=InboundMessageLimit){
        if(!CurrentCaptureBrowser(browser,ticket)||!ChatOrigin(browser.Source))return;
        try{browser.PostWebMessageAsJson(new JavaScriptSerializer{MaxJsonLength=maximum}.Serialize(value));captureTransportError="";}
        catch(Exception error){
            captureTransportError="本次资料回执未能返回，原内容已保留。";
            var fallback=new Dictionary<string,object>{{"kind","zjf-bridge-error"},{"protocol",2},{"code",error is InvalidOperationException?"reply_too_large":"bridge_reply_failed"},{"error",captureTransportError}};
            foreach(string field in new[]{"requestId","attemptId","operationId","materialId","purpose","draftId","actionId","target"}){var map=value as Dictionary<string,object>;object entry=null;if(map!=null)map.TryGetValue(field,out entry);else if(value!=null){var property=value.GetType().GetProperty(field);if(property!=null)entry=property.GetValue(value,null);}if(entry!=null)fallback[field]=entry;}
            try{browser.PostWebMessageAsJson(new JavaScriptSerializer{MaxJsonLength=InboundMessageLimit}.Serialize(fallback));}
            catch{PauseCaptureAttempts(captureTransportError);}
        }
    }
    void ChallengeCapturePage(CoreWebView2 browser,int ticket){if(!CurrentCaptureBrowser(browser,ticket)||!ChatOrigin(browser.Source))return;lock(captureGate){captureChallenge=Guid.NewGuid().ToString("D");CaptureReply(browser,ticket,new {kind="zjf-bridge-challenge",protocol=2,challengeId=captureChallenge,documentEpoch=captureDocumentEpoch});}}
    async Task InitializeCaptureBridge(CoreWebView2 browser){
        int ticket=generation;
        var context=new JavaScriptSerializer().Serialize(new {lessonKey=viewerLessonKey,course=viewerCourse});
        await browser.AddScriptToExecuteOnDocumentCreatedAsync("window.__ZJF_LESSON_CONTEXT__="+context+";\n"+CaptureReceiver());
        if(!CurrentCaptureBrowser(browser,ticket))return;
        lock(captureGate){captureBrowser=browser;captureHostTicket=ticket;captureDocumentEpoch++;captureTarget=null;captureChallenge="";captureComposerReady=false;captureComposerError="";}
        browser.WebMessageReceived+=async delegate(object sender,CoreWebView2WebMessageReceivedEventArgs e){
            if(!CurrentCaptureBrowser(browser,ticket)||!ChatOrigin(e.Source)||CaptureRoute(e.Source)!=CaptureRoute(browser.Source))return;
            Dictionary<string,object> data=null;string requestId="";CaptureIdentity target=null;
            try{
                string json=e.WebMessageAsJson;if(json==null||json.Length>InboundMessageLimit)throw new CaptureProtocolException("message_too_large","提问消息过大，原内容已保留。");
                data=new JavaScriptSerializer{MaxJsonLength=InboundMessageLimit,RecursionLimit=48}.Deserialize<Dictionary<string,object>>(json);string kind=CaptureText(data,"kind",64);if(CaptureNumber(data,"protocol",2)!=2)throw new CaptureProtocolException("upgrade_required","请更新板书草稿页面后重试。");
                if(kind=="zjf-draft-ready"){if(ready)ChallengeCapturePage(browser,ticket);return;}
                object raw;if(!data.TryGetValue("target",out raw))throw new CaptureProtocolException("invalid_message","消息缺少对话目标。");target=ReadCaptureTarget(raw);
                if(target.Route!=CaptureRoute(e.Source))return;
                if(kind=="zjf-bridge-bind"){
                    string challenge=CaptureText(data,"challengeId",36);lock(captureGate){if(challenge!=captureChallenge||target.DocumentEpoch!=captureDocumentEpoch||retiredCapturePages.Contains(target.PageId))return;if(captureTarget==null||!captureTarget.Same(target))ClearCaptureDraft(target);captureTarget=target;ReadComposerState(data);}
                    CaptureReply(browser,ticket,new {kind="zjf-bridge-bound",protocol=2,challengeId=challenge,viewerInstance=viewerInstance,lessonKey=viewerLessonKey,course=viewerCourse,workspaceRevision=captureWorkspaceRevision,workspaceMode=captureWorkspaceMode,closeRevision=shutdownFreezeRevision,closeFrozen=shutdownFrozen,target=target.Snapshot()});return;
                }
                if(kind=="zjf-conversation-state"){
                    lock(captureGate){if(captureTarget==null||target.PageId!=captureTarget.PageId||target.DocumentEpoch!=captureDocumentEpoch||target.RouteGeneration<captureTarget.RouteGeneration||target.ComposerGeneration<captureTarget.ComposerGeneration)return;if(!captureTarget.Same(target)){PauseCaptureAttempts("对话或输入框已切换，材料已保留，请在目标对话重试。");ClearCaptureDraft(target);captureTarget=target;}ReadComposerState(data);}return;
                }
                lock(captureGate){if(!CurrentCaptureTarget(browser,ticket,target))return;}
                if(kind=="zjf-lesson-request"){
                    requestId=CaptureText(data,"requestId",36);if(!CaptureId(requestId))throw new CaptureProtocolException("invalid_message","讲次恢复请求无效。");
                    string text=CaptureText(data,"text",100000,false);var ids=new List<string>();object rawIds;
                    if(data.TryGetValue("resumeDraftIds",out rawIds)){var list=rawIds as IList;if(list==null||list.Count>100)throw new CaptureProtocolException("invalid_message","讲次草稿恢复范围无效。");foreach(var id in list){if(!CaptureId(id))throw new CaptureProtocolException("invalid_message","讲次草稿编号无效。");ids.Add((string)id);}}
                    string requestedLesson=viewerLessonKey;
                    var saved=await Task.Run(delegate{if(!StudyLibrary.FlushContextWrites(target.ConversationId,requestedLesson,text,ids))throw new Exception("原提问尚未保存，请稍后重试。");return StudyLibrary.LessonResume(requestedLesson,target.Route,text,ids);});
                    lock(captureGate){if(!CurrentCaptureTarget(browser,ticket,target))return;}
                    CaptureReply(browser,ticket,new {kind="zjf-lesson-resume",protocol=2,requestId=requestId,target=target.Snapshot(),lessonKey=viewerLessonKey,saved=saved},8*1024*1024);return;
                }
                if(kind=="zjf-draft-claim"){
                    requestId=CaptureText(data,"requestId",36);string sourceId=CaptureText(data,"sourceId",36),sourceConversation=CaptureText(data,"sourceConversationId",170),composerText=CaptureText(data,"composerText",100000,false);long sourceRevision=CaptureNumber(data,"sourceRevision",9007199254740991L,true);object resume;
                    if(!CaptureId(requestId)||!CaptureId(sourceId)||!data.TryGetValue("ordinaryResume",out resume)||!(resume is bool))throw new CaptureProtocolException("invalid_message","草稿恢复身份无效。");
                    await ClaimCaptureDraft(browser,ticket,target,requestId,sourceId,sourceConversation,sourceRevision,(bool)resume,composerText);return;
                }
                if(kind=="zjf-draft-release"){
                    string released=CaptureText(data,"draftId",36);if(!CaptureId(released))throw new CaptureProtocolException("invalid_message","草稿恢复身份无效。");lock(draftWriterStateGate){CaptureDraftWriter writer;if(draftWriters.TryGetValue(released,out writer)&&Object.ReferenceEquals(writer.Owner,this)&&writer.Target.Same(target)&&writer.Pending==0&&!writer.Saved)draftWriters.Remove(released);}return;
                }
                if(kind=="zjf-draft-background-request"){
                    requestId=CaptureText(data,"requestId",36);string draftId=CaptureText(data,"draftId",36),itemId=CaptureText(data,"itemId",300);var references=ReadProjectionRefs(data);if(!CaptureId(requestId)||!CaptureId(draftId)||references.Count!=1)throw new CaptureProtocolException("invalid_message","共享原图的选材请求无效。");long structure;
                    lock(captureGate){if(!CurrentSavedDraft(draftId,browser,ticket,target))throw new CaptureProtocolException("draft_not_saved","当前草稿尚未完成保存，请保留内容并重试。");structure=captureDraftStructureGeneration;}
                    var proof=await Task.Run(delegate{return StudyLibrary.ValidateSharedDraftBackground(draftId,target.Snapshot(),itemId,references[0]);});
                    lock(captureGate){if(!CurrentCaptureTarget(browser,ticket,target)||structure!=captureDraftStructureGeneration||!CurrentSavedDraft(draftId,browser,ticket,target))return;}
                    CaptureReply(browser,ticket,new {kind="zjf-draft-background-proof",protocol=2,requestId=requestId,draftId=draftId,itemId=itemId,target=target.Snapshot(),proof=proof["proof"],asset=proof["asset"]});return;
                }
                if(kind=="zjf-draft-project-request"){
                    requestId=CaptureText(data,"requestId",36);string projectMaterialId=CaptureText(data,"materialId",36),purpose=CaptureText(data,"purpose",16,false);
                    if(!CaptureId(requestId)||!CaptureId(projectMaterialId))throw new CaptureProtocolException("invalid_message","图册整理请求无效。");var keepRefs=ReadProjectionRefs(data);
                    if(purpose=="restore"||purpose=="edit"){
                        string restoreDraftId=CaptureText(data,"draftId",36),restoreActionId=CaptureText(data,"actionId",36);if(!CaptureId(restoreDraftId)||!CaptureId(restoreActionId)||keepRefs.Count==0||data.ContainsKey("operationId")||data.ContainsKey("attemptId"))throw new CaptureProtocolException("invalid_message","撤回请求身份或来源无效。");
                        DraftRestoreAction restore;lock(captureGate){if(!CurrentSavedDraft(restoreDraftId,browser,ticket,target))throw new CaptureProtocolException("draft_not_saved","当前草稿尚未完成保存，请保留内容并重试。");restore=BeginDraftRestore(restoreActionId,restoreDraftId,projectMaterialId,target,keepRefs,purpose);}
                        restore.Projection=ProjectDraftRestore(restore,browser,ticket,target,requestId,keepRefs);await restore.Projection;return;
                    }
                    if(purpose!=""&&purpose!="delivery")throw new CaptureProtocolException("invalid_message","图册整理用途无效。");
                    string projectOperationId=CaptureText(data,"operationId",36),projectAttemptId=CaptureText(data,"attemptId",36);if(!CaptureId(projectOperationId)||!CaptureId(projectAttemptId))throw new CaptureProtocolException("invalid_message","图册投递身份无效。");
                    CaptureAttempt projectAttempt;lock(captureGate){if(!captureStatus.TryGetValue(projectAttemptId,out projectAttempt)||projectAttempt.MaterialId!=projectMaterialId||projectAttempt.OperationId!=projectOperationId||!CurrentPlanProjection(projectAttempt,browser,ticket,target))return;projectAttempt.Updated=CaptureClock();}
                    projectAttempt.Projection=ProjectDraft(projectAttempt,browser,ticket,target,requestId,keepRefs);await projectAttempt.Projection;return;
                }
                if(kind=="zjf-draft-image-request"){
                    requestId=CaptureText(data,"requestId",36);if(!CaptureId(requestId)||!data.TryGetValue("ref",out raw))throw new CaptureProtocolException("invalid_message","原图请求无效。");var reference=raw as Dictionary<string,object>;
                    var imageReference=new Dictionary<string,object>();
                    if(reference!=null&&reference.ContainsKey("materialId")){string imageMaterialId=CaptureText(reference,"materialId",36),attachmentId=CaptureText(reference,"attachmentId",300);if(!CaptureId(imageMaterialId))throw new CaptureProtocolException("invalid_message","材料页编号无效。");imageReference["materialId"]=imageMaterialId;imageReference["attachmentId"]=attachmentId;}
                    else{string snapshotId=CaptureText(reference,"snapshotId",36),itemId=CaptureText(reference,"itemId",300);if(!CaptureId(snapshotId))throw new CaptureProtocolException("invalid_message","原图存档编号无效。");imageReference["snapshotId"]=snapshotId;imageReference["itemId"]=itemId;}
                    bool preview=data.ContainsKey("preview")&&data["preview"] is bool&&(bool)data["preview"];var imageRequest=new Dictionary<string,object>(imageReference);imageRequest["delivery"]=!preview;
                    var result=await Task.Run(delegate{return StudyLibrary.Run("/library/image",imageRequest);});lock(captureGate){if(!CurrentCaptureTarget(browser,ticket,target))return;}
                    int limit=preview?StudyLibrary.MaxOriginalImageChars:12*1024*1024;string image=(string)result.GetType().GetProperty("image").GetValue(result,null);if(image==null||image.Length>limit)throw new CaptureProtocolException("image_too_large","这张原图超过草稿恢复限制，原图仍保存在资料库。");
                    CaptureReply(browser,ticket,new {kind="zjf-draft-image",protocol=2,requestId=requestId,target=target.Snapshot(),@ref=imageReference,image=image},preview?StudyLibrary.MaxOriginalJsonBytes:16*1024*1024);return;
                }
                if(kind=="zjf-context-request"){
                    requestId=CaptureText(data,"requestId",36);if(!CaptureId(requestId))throw new CaptureProtocolException("invalid_message","背景请求编号无效。");string url=CaptureText(data,"url",2048);if(CaptureRoute(url)!=target.Route)throw new CaptureProtocolException("invalid_message","背景请求对话不一致。");
                    var resumeIds=new List<string>();object rawResume;if(data.TryGetValue("resumeDraftIds",out rawResume)){var list=rawResume as IList;if(list==null||list.Count>100)throw new CaptureProtocolException("invalid_message","草稿恢复范围无效。");foreach(var id in list){if(!CaptureId(id))throw new CaptureProtocolException("invalid_message","草稿恢复编号无效。");resumeIds.Add((string)id);}}
                    string resumeText=CaptureText(data,"resumeText",100000,false);
                    long cursor=data.ContainsKey("cursor")?CaptureNumber(data,"cursor",100):0;var interested=new HashSet<string>();object requestedKeys;if(data.TryGetValue("keysOfInterest",out requestedKeys)){var list=requestedKeys as IList;if(list==null||list.Count>600)throw new CaptureProtocolException("invalid_message","背景查询范围无效。");foreach(var key in list){if(!(key is string)||((string)key).Length>400)throw new CaptureProtocolException("invalid_message","背景查询编号无效。");interested.Add((string)key);}}
                    var ledger=await Task.Run(delegate{if(!StudyLibrary.FlushContextWrites(target.ConversationId,"",resumeText,resumeIds))throw new Exception("本对话的提问记录尚未保存，请稍后重试。");return StudyLibrary.ConversationLedger(url);});lock(captureGate){if(!CurrentCaptureTarget(browser,ticket,target))return;}
                    var resumeDrafts=new Dictionary<string,object>[0];if(resumeIds.Count>0)resumeDrafts=await Task.Run(delegate{return StudyLibrary.ResumeDrafts(target.Route,resumeText,resumeIds);});lock(captureGate){if(!CurrentCaptureTarget(browser,ticket,target))return;}
                    var type=ledger.GetType();var allKeys=(string[])type.GetProperty("keys").GetValue(ledger,null);var allQuestions=(Dictionary<string,object>[])type.GetProperty("questions").GetValue(ledger,null);var keys=new List<string>();foreach(var key in allKeys)if(key.Length<=400&&(interested.Count==0||interested.Contains(key))&&keys.Count<600)keys.Add(key);
                    var questions=new List<Dictionary<string,object>>();int budget=0,next=(int)cursor;var serializer=new JavaScriptSerializer{MaxJsonLength=InboundMessageLimit};while(next<allQuestions.Length){int length=serializer.Serialize(allQuestions[next]).Length;if(budget+length>3*1024*1024)break;questions.Add(allQuestions[next]);budget+=length;next++;}if(next<allQuestions.Length&&next==cursor)throw new CaptureProtocolException("message_too_large","待确认提问记录过大，请从资料库查看原记录。");
                    var draftsProperty=type.GetProperty("drafts");var truncatedProperty=type.GetProperty("draftsTruncated");var drafts=draftsProperty==null?new Dictionary<string,object>[0]:(Dictionary<string,object>[])draftsProperty.GetValue(ledger,null);bool draftsTruncated=truncatedProperty!=null&&(bool)truncatedProperty.GetValue(ledger,null);
                    // Both recovery arrays share one budget in this reply.
                    // Exact-text recovery gets priority; duplicate records use
                    // one slot, while unfinished sends continue via the cursor.
                    var included=new HashSet<string>(resumeDrafts.Select(draft=>CaptureText(draft,"id",36)));int draftBudget=3*1024*1024-resumeDrafts.Sum(draft=>serializer.Serialize(draft).Length);var compactDrafts=new List<Dictionary<string,object>>();
                    foreach(var draft in drafts){if(included.Contains(CaptureText(draft,"id",36)))continue;int length=serializer.Serialize(draft).Length;if(length>draftBudget){draftsTruncated=true;continue;}draftBudget-=length;compactDrafts.Add(draft);}drafts=compactDrafts.ToArray();
                    CaptureReply(browser,ticket,new {kind="zjf-context-ledger",protocol=2,requestId=requestId,url=url,target=target.Snapshot(),keys=keys,questions=questions,drafts=drafts,resumeDrafts=resumeDrafts,draftsTruncated=draftsTruncated,nextCursor=next<allQuestions.Length?next:0,ledgerVersion=DateTime.UtcNow.Ticks.ToString()},8*1024*1024);return;
                }
                if(kind=="zjf-question-save"){
                    requestId=CaptureText(data,"requestId",36);if(!CaptureId(requestId)||!data.TryGetValue("question",out raw)||!(raw is Dictionary<string,object>))throw new CaptureProtocolException("invalid_message","提问保存消息无效。");var question=(Dictionary<string,object>)raw;
                    string status=CaptureText(question,"status",16);if(status!="draft"&&status!="pending"&&status!="unknown"&&status!="sent")throw new CaptureProtocolException("invalid_message","提问状态无效。");string url=CaptureText(question,"conversationUrl",2048,false);if(url!=""&&CaptureRoute(url)!=target.Route)throw new CaptureProtocolException("conversation_changed","提问记录不能保存到其他对话。");
                    if(status=="sent"&&(url==""||CaptureConversation(target.Route)==null||CaptureText(question,"turnId",200)==""||(CaptureText(question,"confirmation",32)!="durable-history"&&CaptureText(question,"confirmation",32)!="user-confirmed")))throw new CaptureProtocolException("unconfirmed_send","发送结果尚未可靠确认。");
                    string declaredConversation=CaptureText(question,"conversationId",170,false);
                    if(declaredConversation!=""&&declaredConversation!=target.ConversationId){
                        object rawIntent,rawCandidate,rawFrom,rawIntentTarget;var sendIntent=question.TryGetValue("sendIntent",out rawIntent)?rawIntent as Dictionary<string,object>:null;var possible=sendIntent!=null&&sendIntent.TryGetValue("adoptionCandidate",out rawCandidate)?rawCandidate as Dictionary<string,object>:null;
                        if((status!="pending"&&status!="unknown")||url!=""||!declaredConversation.StartsWith("provisional:")||possible==null||!possible.TryGetValue("from",out rawFrom)||!sendIntent.TryGetValue("target",out rawIntentTarget))throw new CaptureProtocolException("conversation_changed","提问记录仍属于原对话，不能改写到当前对话。");
                        var from=ReadCaptureTarget(rawFrom);var intentTarget=ReadCaptureTarget(rawIntentTarget);
                        if(!from.Same(intentTarget)||from.ConversationId!=declaredConversation||from.PageId!=target.PageId||from.DocumentEpoch!=target.DocumentEpoch||from.RouteGeneration>target.RouteGeneration||from.ComposerGeneration>target.ComposerGeneration||CaptureText(possible,"to",170)!=target.ConversationId||CaptureText(possible,"route",512)!=target.Route||CaptureConversation(target.Route)==null||CaptureText(sendIntent,"status",16)!=status||CaptureText(sendIntent,"questionId",36)!=CaptureText(question,"id",36)||CaptureText(sendIntent,"id",36)!=CaptureText(question,"sendId",36))throw new CaptureProtocolException("conversation_changed","新对话的待确认关联无效，原记录已保留。");
                    }else question["conversationId"]=target.ConversationId;
                    string savedQuestionId=CaptureText(question,"id",36);if(!CaptureId(savedQuestionId))throw new CaptureProtocolException("invalid_message","提问编号无效。");object rawManifest;if(status=="draft"&&question.TryGetValue("draftManifest",out rawManifest)&&rawManifest is Dictionary<string,object>){var manifest=(Dictionary<string,object>)rawManifest;if(CaptureText(manifest,"conversationId",170)!=target.ConversationId)throw new CaptureProtocolException("conversation_changed","草稿来源与当前对话不一致。");manifest["boundTarget"]=target.Snapshot();}
                    await SaveCaptureQuestion(question,savedQuestionId,status,browser,ticket,target);
                    if(status=="sent")await Task.Run(delegate{var stored=StudyLibrary.Run("/library/question",new Dictionary<string,object>{{"id",savedQuestionId}}) as Dictionary<string,object>;if(stored==null||CaptureEcho(stored,"status",16)!="sent"||CaptureEcho(stored,"sendId",36)!=CaptureText(question,"sendId",36)||CaptureEcho(stored,"turnId",200)!=CaptureText(question,"turnId",200))throw new CaptureProtocolException("send_not_saved","发送确认仍未写入原提问记录，原文与确认已保留。");});
                    lock(captureGate){if(!CurrentCaptureTarget(browser,ticket,target))return;}CaptureReply(browser,ticket,new {kind="zjf-question-saved",protocol=2,requestId=requestId,target=target.Snapshot(),id=question["id"],status=status});
                    return;
                }
                if(kind!="zjf-draft-status")return;
                string attemptId=CaptureText(data,"attemptId",36),operationId=CaptureText(data,"operationId",36),materialId=CaptureText(data,"materialId",36),state=CaptureText(data,"state",16),error=CaptureText(data,"error",1024,false),evidence=CaptureText(data,"evidence",32,false);int count=(int)CaptureNumber(data,"count",300);long workspaceRevision=data.ContainsKey("workspaceRevision")?CaptureNumber(data,"workspaceRevision",9007199254740991L):0;
                if(!CaptureId(attemptId)||!CaptureId(operationId)||!CaptureId(materialId)||!(state=="working"||state=="attached"||state=="already-sent"||state=="removed"||state=="error"||state=="unknown"||state=="cancelled"))throw new CaptureProtocolException("invalid_message","附图回执无效。");
                bool complete=state=="attached"||state=="already-sent"||state=="removed";object verified;if(complete&&(!data.TryGetValue("verified",out verified)||!(verified is bool)||(bool)verified!=true||evidence!=(state=="attached"?"composer":state=="removed"?"composer-removal":"confirmed-message")||state=="removed"&&count!=0))throw new CaptureProtocolException("invalid_message","附图完成回执缺少验证。");
                lock(captureGate){CaptureAttempt attempt;string latest;if(!captureStatus.TryGetValue(attemptId,out attempt)||!captureOperations.TryGetValue(operationId,out latest)||latest!=attemptId||!LatestCaptureOperation(attempt)||!CurrentCaptureWorkspace(attempt)||attempt.WorkspaceRevision!=workspaceRevision||attempt.DraftId!=captureComposerDraftId||attempt.OperationId!=operationId||attempt.MaterialId!=materialId||!attempt.Target.Same(target)||!CurrentCaptureTarget(browser,ticket,target)||attempt.State=="cancelled"||attempt.State=="error"||attempt.HasCompletion)return;attempt.State=state;attempt.Error=error;attempt.Count=count;attempt.Evidence=evidence;if(complete){attempt.HasCompletion=true;attempt.CompletionState=state;attempt.CompletionEvidence=evidence;attempt.CompletionCount=count;SaveCaptureCompletion(attempt);}attempt.Updated=CaptureClock();}
            }catch(Exception error){var protocol=error as CaptureProtocolException;string message=protocol==null?"提问消息处理失败，原内容已保留。":protocol.Message;CaptureReply(browser,ticket,new {kind="zjf-bridge-error",protocol=2,requestId=requestId,attemptId=CaptureEcho(data,"attemptId",36),operationId=CaptureEcho(data,"operationId",36),materialId=CaptureEcho(data,"materialId",36),purpose=CaptureEcho(data,"purpose",16),draftId=CaptureEcho(data,"draftId",36),actionId=CaptureEcho(data,"actionId",36),code=protocol==null?"bridge_error":protocol.Code,error=message,target=target==null?null:target.Snapshot()});}
        };
        browser.NavigationStarting+=delegate(object sender,CoreWebView2NavigationStartingEventArgs e){
            if(!CurrentCaptureBrowser(browser,ticket))return;lock(captureGate){captureNavigationId=e.NavigationId;captureDocumentEpoch++;if(captureTarget!=null&&retiredCapturePages.Add(captureTarget.PageId)){retiredCapturePageOrder.Enqueue(captureTarget.PageId);while(retiredCapturePageOrder.Count>256)retiredCapturePages.Remove(retiredCapturePageOrder.Dequeue());}ClearCaptureDraft();captureTarget=null;captureChallenge="";captureComposerReady=false;captureComposerError="";PauseCaptureAttempts("ChatGPT 页面已切换，材料已保留，请在目标对话重试。");PruneCaptures();}
        };
        browser.NavigationCompleted+=delegate(object sender,CoreWebView2NavigationCompletedEventArgs e){
            if(CurrentCaptureBrowser(browser,ticket)&&e.NavigationId==captureNavigationId&&(e.IsSuccess||e.HttpStatusCode>0))ChallengeCapturePage(browser,ticket);
        };
    }
    public object QueueCapture(Dictionary<string,object> batch,string envelope){
        throw new CaptureProtocolException("upgrade_required","请更新观看器和板书草稿页面后重试附图。");
    }
    public object QueueCapture(Dictionary<string,object> batch,string envelope,Dictionary<string,object> delivery,Func<bool> current=null){
        object raw,material;if(batch==null||!batch.TryGetValue("id",out material)||!CaptureId(material)||delivery==null||CaptureNumber(delivery,"protocol",2)!=2||!delivery.TryGetValue("target",out raw))throw new CaptureProtocolException("invalid_delivery","投递身份不完整。");
        string materialId=CaptureText(delivery,"materialId",36),operationId=CaptureText(delivery,"operationId",36),attemptId=CaptureText(delivery,"attemptId",36);CaptureIdentity target=ReadCaptureTarget(raw);
        string requestedDraftId=CaptureText(raw as Dictionary<string,object>,"draftId",36,false);if(requestedDraftId!=""&&!CaptureId(requestedDraftId))throw new CaptureProtocolException("invalid_delivery","投递草稿身份无效。");var deliveryTarget=target.Snapshot();if(requestedDraftId!="")deliveryTarget["draftId"]=requestedDraftId;
        if(materialId!=(string)material||!CaptureId(operationId)||!CaptureId(attemptId)||string.IsNullOrWhiteSpace(envelope)||envelope.Length>StudyLibrary.MaxCaptureJsonBytes)throw new CaptureProtocolException("invalid_delivery","投递数据无效。");
        string reconcileFrom="";CaptureIdentity reconcileTarget=null;Dictionary<string,object> previousTarget=null;object reconcile;
        if(delivery.TryGetValue("reconcileOnly",out reconcile)){
            if(!(reconcile is bool))throw new CaptureProtocolException("invalid_delivery","投递核对状态无效。");
            if((bool)reconcile){if(!delivery.TryGetValue("previousTarget",out raw))throw new CaptureProtocolException("invalid_delivery","缺少原始对话身份。");reconcileTarget=ReadCaptureTarget(raw);if(!reconcileTarget.ConversationId.StartsWith("provisional:")||CaptureConversation(target.Route)==null)throw new CaptureProtocolException("invalid_delivery","对话核对身份无效。");reconcileFrom=reconcileTarget.ConversationId;previousTarget=reconcileTarget.Snapshot();string originalDraft=CaptureText(raw as Dictionary<string,object>,"draftId",36,false);if(originalDraft!=""){if(!CaptureId(originalDraft))throw new CaptureProtocolException("invalid_delivery","原投递草稿身份无效。");previousTarget["draftId"]=originalDraft;}}
        }
        lock(captureGate){if(current!=null&&!current())throw new CaptureProtocolException("workspace_changed","提问工作区已切换，原材料已保留。");if(!CaptureReady||!captureTarget.Same(target)||requestedDraftId!=""&&requestedDraftId!=captureComposerDraftId)throw new CaptureProtocolException("conversation_changed","目标对话或提问已切换，材料已保留。");CaptureAttempt existing;
            if(captureStatus.TryGetValue(attemptId,out existing)){if(existing.MaterialId!=materialId||existing.OperationId!=operationId||existing.ReconcileFrom!=reconcileFrom||existing.DraftId!=captureComposerDraftId||!existing.Target.Same(target))throw new CaptureProtocolException("invalid_delivery","重试编号不能用于其他投递。");if(existing.HasCompletion)return new {protocol=2,id=materialId,materialId=materialId,operationId=operationId,attemptId=attemptId,target=deliveryTarget,state="unknown",error="请使用新的尝试编号重新验证当前草稿。",count=0};return existing.Snapshot();}
            string previous;if(captureOperations.TryGetValue(operationId,out previous)&&captureStatus.TryGetValue(previous,out existing)){if(existing.MaterialId!=materialId||existing.Target.ConversationId!=target.ConversationId&&existing.Target.ConversationId!=reconcileFrom||existing.ReconcileFrom!=""&&existing.ReconcileFrom!=reconcileFrom)throw new CaptureProtocolException("invalid_delivery","投递操作不能改绑到其他材料或对话。");existing.State="cancelled";existing.Error="已有新的重试尝试。";existing.Updated=CaptureClock();}
            PruneCaptures(true);if(captureStatus.Count>=CaptureLimit)throw new CaptureProtocolException("capture_capacity","待处理附图较多，请先处理已有草稿。");
            long dispatchSequence=Interlocked.Increment(ref captureDispatchSequence);
            var identity=new Dictionary<string,object>{{"protocol",2},{"materialId",materialId},{"operationId",operationId},{"attemptId",attemptId},{"target",deliveryTarget},{"nativeDispatch",new Dictionary<string,object>{{"instance",captureDispatchInstance},{"sequence",dispatchSequence}}}};if(reconcileTarget!=null){identity["reconcileOnly"]=true;identity["previousTarget"]=previousTarget;}
            var attempt=new CaptureAttempt{MaterialId=materialId,OperationId=operationId,AttemptId=attemptId,DraftId=requestedDraftId!=""?requestedDraftId:captureComposerDraftId,WorkspaceRevision=captureWorkspaceRevision,Current=current,Target=target,ReconcileFrom=reconcileFrom,Delivery=identity,DispatchSequence=dispatchSequence,IsPlan=batch.ContainsKey("logicalItems")&&batch.ContainsKey("items"),Updated=CaptureClock()};captureStatus[attemptId]=attempt;captureOperations[operationId]=attemptId;lock(captureOperationGate)activeCaptureOperations[operationId]=dispatchSequence;
            attempt.Dispatch=DispatchCapture(attempt,batch,envelope,captureBrowser,captureHostTicket);
            return attempt.Snapshot();
        }
    }
    bool CanDispatchCapture(CaptureAttempt attempt,CoreWebView2 browser,int ticket){
        string latest;return attempt.State=="queued"&&CurrentCaptureWorkspace(attempt)&&attempt.DraftId==captureComposerDraftId&&captureOperations.TryGetValue(attempt.OperationId,out latest)&&latest==attempt.AttemptId&&LatestCaptureOperation(attempt)&&CurrentCaptureTarget(browser,ticket,attempt.Target)&&CaptureReady;
    }
    bool CurrentCaptureWorkspace(CaptureAttempt attempt){return (attempt.Current==null||attempt.Current())&&attempt.WorkspaceRevision==captureWorkspaceRevision&&captureWorkspaceMode=="chat";}
    async Task DispatchCapture(CaptureAttempt attempt,Dictionary<string,object> batch,string envelope,CoreWebView2 browser,int ticket){
        try{
            bool removed=false;
            var proof=await Task.Run(delegate{
                if(!StudyLibrary.FlushContextWrites(attempt.Target.ConversationId))throw new Exception("本对话的提问尚未保存，请稍后重试。");
                var savedDelivery=StudyLibrary.SaveCaptureDelivery(attempt.MaterialId,attempt.Delivery);if(savedDelivery!=null&&CaptureText(savedDelivery,"attemptId",36)!=attempt.AttemptId)throw new CaptureProtocolException("delivery_superseded","另一处重试已接手这次附图，本次不会重复上传。");
                if(savedDelivery!=null&&CaptureEcho(savedDelivery,"completedOutcome",16)=="removed"&&CaptureEcho(savedDelivery,"completionEvidence",32)=="composer-removal"){removed=true;return null;}
                if(attempt.IsPlan)StudyLibrary.SavePlanAttachments(batch);
                return StudyLibrary.ConfirmedDelivery("https://chatgpt.com"+attempt.Target.Route,attempt.OperationId,attempt.MaterialId);
            });
            lock(captureGate){
                if(!CanDispatchCapture(attempt,browser,ticket))return;
                if(removed){attempt.State="removed";attempt.Evidence="composer-removal";attempt.Count=0;attempt.HasCompletion=true;attempt.CompletionState=attempt.State;attempt.CompletionEvidence=attempt.Evidence;attempt.CompletionCount=0;attempt.Updated=CaptureClock();SaveCaptureCompletion(attempt);return;}
                if(proof!=null&&(attempt.ReconcileFrom==""||CaptureText(proof,"adoptedFrom",170,false)==attempt.ReconcileFrom)){
                    attempt.State="already-sent";attempt.Evidence="confirmed-message";attempt.HasCompletion=true;attempt.CompletionState=attempt.State;attempt.CompletionEvidence=attempt.Evidence;attempt.CompletionCount=attempt.Count;attempt.Updated=CaptureClock();SaveCaptureCompletion(attempt);return;
                }
                if(attempt.ReconcileFrom!=""){attempt.State="cancelled";attempt.Error="原操作的发送结果尚未确认，材料已保留；请在资料中明确选择目标对话。";attempt.Updated=CaptureClock();return;}
                var identity=new Dictionary<string,object>{{"protocol",2},{"materialId",attempt.MaterialId},{"operationId",attempt.OperationId},{"attemptId",attempt.AttemptId},{"draftId",attempt.DraftId},{"workspaceRevision",attempt.WorkspaceRevision},{"target",attempt.Target.Snapshot()}};
                try{if(!StudyLibrary.DispatchCaptureIfActive(attempt.MaterialId,attempt.OperationId,attempt.DraftId,delegate{browser.PostWebMessageAsJson("{\"kind\":\"zjf-delivery\",\"delivery\":"+new JavaScriptSerializer().Serialize(identity)+",\"payload\":"+envelope+"}");})){attempt.State="cancelled";attempt.ErrorCode="capture_dismissed";attempt.Error="这张图已留在学习记录中，原附图任务已结束。";attempt.Updated=CaptureClock();}}
                catch(Exception error){var protocol=error as CaptureProtocolException;attempt.State="error";attempt.ErrorCode=protocol==null?"":protocol.Code;attempt.Error=protocol==null?"附图消息未能送入页面，材料已保留，请重试。":protocol.Message;attempt.Updated=CaptureClock();}
            }
        }catch(Exception error){lock(captureGate){if(CanDispatchCapture(attempt,browser,ticket)){attempt.State="unknown";var protocol=error as CaptureProtocolException;attempt.ErrorCode=protocol==null?"":protocol.Code;attempt.Error=protocol==null?"投递记录暂时无法保存或核对，材料已保留，请稍后重试。":protocol.Message;attempt.Updated=CaptureClock();}}}
    }
    bool CurrentPlanProjection(CaptureAttempt attempt,CoreWebView2 browser,int ticket,CaptureIdentity target){
        CaptureAttempt registered;string latest;return attempt!=null&&attempt.IsPlan&&attempt.State=="working"&&CurrentCaptureWorkspace(attempt)&&attempt.DraftId==captureComposerDraftId&&attempt.ReconcileFrom==""&&captureStatus.TryGetValue(attempt.AttemptId,out registered)&&Object.ReferenceEquals(registered,attempt)&&captureOperations.TryGetValue(attempt.OperationId,out latest)&&latest==attempt.AttemptId&&LatestCaptureOperation(attempt)&&attempt.Target.Same(target)&&CurrentCaptureTarget(browser,ticket,target)&&CaptureReady;
    }
    static void CheckProjectedPlan(Dictionary<string,object> plan){
        object pages,logical,planId;if(plan==null||!plan.TryGetValue("id",out planId)||!CaptureId(planId)||!plan.TryGetValue("items",out pages)||!(pages is IList)||((IList)pages).Count>20||!plan.TryGetValue("logicalItems",out logical)||!(logical is IList)||((IList)logical).Count>300)throw new CaptureProtocolException("invalid_projection","图册整理结果不完整，现有草稿已保留。");
    }
    async Task ProjectDraft(CaptureAttempt attempt,CoreWebView2 browser,int ticket,CaptureIdentity target,string requestId,IList keepRefs){
        lock(captureGate){if(!CurrentPlanProjection(attempt,browser,ticket,target))return;}
        try{
            string reply=await Task.Run(delegate{
                var plan=StudyLibrary.ProjectPlan(attempt.MaterialId,keepRefs);CheckProjectedPlan(plan);
                return new JavaScriptSerializer{MaxJsonLength=64*1024*1024,RecursionLimit=48}.Serialize(new {kind="zjf-draft-project",protocol=2,purpose="delivery",requestId=requestId,target=target.Snapshot(),materialId=attempt.MaterialId,operationId=attempt.OperationId,attemptId=attempt.AttemptId,plan=plan});
            });
            lock(captureGate){if(!CurrentPlanProjection(attempt,browser,ticket,target))return;browser.PostWebMessageAsJson(reply);attempt.Updated=CaptureClock();}
        }catch(Exception error){lock(captureGate){if(!CurrentPlanProjection(attempt,browser,ticket,target))return;var protocol=error as CaptureProtocolException;CaptureReply(browser,ticket,new {kind="zjf-bridge-error",protocol=2,purpose="delivery",requestId=requestId,target=target.Snapshot(),materialId=attempt.MaterialId,operationId=attempt.OperationId,attemptId=attempt.AttemptId,code=protocol==null?"plan_projection_failed":protocol.Code,error=protocol==null?"本次图册整理失败，现有草稿和原始资料已保留，请重试。":protocol.Message});}}
    }
    bool CurrentDraftIdentity(string draftId,CoreWebView2 browser,int ticket,CaptureIdentity target){return captureWorkspaceMode=="chat"&&captureComposerDraftId==draftId&&captureDraftSave!=null&&captureDraftSave.DraftId==draftId&&captureDraftSave.Status=="draft"&&captureDraftSave.Saving!=null&&!captureDraftSave.Saving.IsFaulted&&!captureDraftSave.Saving.IsCanceled&&captureDraftSave.Target.Same(target)&&CurrentCaptureTarget(browser,ticket,target)&&CaptureReady;}
    bool CurrentSavedDraft(string draftId,CoreWebView2 browser,int ticket,CaptureIdentity target){return CurrentDraftIdentity(draftId,browser,ticket,target)&&captureDraftSave.Saving.Status==TaskStatus.RanToCompletion;}
    bool CurrentDraftRestore(DraftRestoreAction action,CoreWebView2 browser,int ticket,CaptureIdentity target){DraftRestoreAction current;return captureRestores.TryGetValue(action.ActionId,out current)&&Object.ReferenceEquals(current,action)&&action.StructureGeneration==captureDraftStructureGeneration&&action.Target.Same(target)&&CurrentDraftIdentity(action.DraftId,browser,ticket,target);}
    DraftRestoreAction BeginDraftRestore(string actionId,string draftId,string materialId,CaptureIdentity target,IList keepRefs,string purpose="restore"){
        var serializer=new JavaScriptSerializer();var normalized=new SortedSet<string>(StringComparer.Ordinal);foreach(Dictionary<string,object> reference in keepRefs)normalized.Add(serializer.Serialize(new[]{new Guid(CaptureText(reference,"snapshotId",36)).ToString("D"),CaptureText(reference,"itemId",300),CaptureText(reference,"markId",36,false)}));
        string referenceKey=serializer.Serialize(new {draftId=draftId,materialId=materialId,conversationId=target.ConversationId,purpose=purpose,refs=new List<string>(normalized)});DraftRestoreAction previous;
        if(captureRestores.TryGetValue(actionId,out previous)){if(previous.ReferenceKey!=referenceKey)throw new CaptureProtocolException("invalid_restore","这次撤回的来源已经变化，请从当前草稿重新操作。");if(previous.Target.Same(target)){if(previous.StructureGeneration!=captureDraftStructureGeneration)throw new CaptureProtocolException("restore_changed","已删除资料的来源已变化，请从当前草稿重新撤回。");previous.Updated=CaptureClock();return previous;}}
        var remove=new List<string>();foreach(var entry in captureRestores)if((entry.Value.Projection==null||entry.Value.Projection.IsCompleted)&&(CaptureClock()-entry.Value.Updated).TotalSeconds>300)remove.Add(entry.Key);foreach(var key in remove)captureRestores.Remove(key);
        while(captureRestores.Count>=CaptureLimit&&!captureRestores.ContainsKey(actionId)){DraftRestoreAction oldest=null;foreach(var action in captureRestores.Values)if((action.Projection==null||action.Projection.IsCompleted)&&(oldest==null||action.Updated<oldest.Updated))oldest=action;if(oldest==null)throw new CaptureProtocolException("restore_capacity","正在处理的撤回较多，请稍候重试。");captureRestores.Remove(oldest.ActionId);}
        var result=new DraftRestoreAction{ActionId=actionId,DraftId=draftId,MaterialId=materialId,Purpose=purpose,ReferenceKey=referenceKey,Target=target,StructureGeneration=captureDraftStructureGeneration,Changed=captureDraftChanged.Task,SourceToken=previous==null?null:previous.SourceToken,PlanId=previous==null?null:previous.PlanId,Updated=CaptureClock()};captureRestores[actionId]=result;return result;
    }
    async Task ProjectDraftRestore(DraftRestoreAction action,CoreWebView2 browser,int ticket,CaptureIdentity target,string requestId,IList keepRefs){
        lock(captureGate){if(!CurrentDraftRestore(action,browser,ticket,target))return;}
        try{
            string sourceToken=await Task.Run(delegate{if(!StudyLibrary.FlushQuestionWrites(action.DraftId))throw new CaptureProtocolException("draft_not_saved","当前草稿仍在保存，请稍候重试。");return StudyLibrary.ValidateDraftRestore(action.DraftId,target.Snapshot(),action.MaterialId,keepRefs,action.Purpose=="edit");});
            lock(captureGate){if(!CurrentDraftRestore(action,browser,ticket,target))return;if(string.IsNullOrEmpty(sourceToken)||action.SourceToken!=null&&action.SourceToken!=sourceToken)throw new CaptureProtocolException("restore_changed","待恢复的图片来源已变化，当前草稿已保留。");action.SourceToken=sourceToken;}
            var prepared=await Task.Run(delegate{
                var plan=StudyLibrary.ProjectPlan(action.MaterialId,keepRefs);CheckProjectedPlan(plan);
                string json=new JavaScriptSerializer{MaxJsonLength=64*1024*1024,RecursionLimit=48}.Serialize(new {kind="zjf-draft-project",protocol=2,purpose=action.Purpose,requestId=requestId,target=target.Snapshot(),draftId=action.DraftId,actionId=action.ActionId,materialId=action.MaterialId,plan=plan});
                if(!StudyLibrary.FlushQuestionWrites(action.DraftId)||StudyLibrary.ValidateDraftRestore(action.DraftId,target.Snapshot(),action.MaterialId,keepRefs,action.Purpose=="edit")!=sourceToken)throw new CaptureProtocolException("restore_changed","图片来源已变化，当前草稿已保留。");
                return new DraftProjectionReply{Json=json,PlanId=(string)plan["id"]};
            });
            var deadline=DateTime.UtcNow.AddSeconds(5);
            while(true){
                Task saving;lock(captureGate){if(!CurrentDraftRestore(action,browser,ticket,target))return;saving=captureDraftSave.Saving;}
                if(!saving.IsCompleted){int remaining=(int)Math.Max(0,(deadline-DateTime.UtcNow).TotalMilliseconds);if(remaining==0||await Task.WhenAny(saving,action.Changed,Task.Delay(remaining))!=saving){lock(captureGate){if(!CurrentDraftRestore(action,browser,ticket,target))return;}throw new CaptureProtocolException("draft_not_saved","当前草稿仍在保存，请稍候重试撤回。");}}
                await saving;
                lock(captureGate){if(!CurrentDraftRestore(action,browser,ticket,target))return;if(!Object.ReferenceEquals(saving,captureDraftSave.Saving))continue;if(!CurrentSavedDraft(action.DraftId,browser,ticket,target))return;if(action.PlanId!=null&&action.PlanId!=prepared.PlanId)throw new CaptureProtocolException("invalid_projection","同一次撤回的图册身份不一致，当前草稿已保留。");action.PlanId=prepared.PlanId;browser.PostWebMessageAsJson(prepared.Json);action.Updated=CaptureClock();return;}
            }
        }catch(Exception error){lock(captureGate){if(!CurrentDraftRestore(action,browser,ticket,target))return;var protocol=error as CaptureProtocolException;CaptureReply(browser,ticket,new {kind="zjf-bridge-error",protocol=2,purpose=action.Purpose,requestId=requestId,target=target.Snapshot(),draftId=action.DraftId,actionId=action.ActionId,materialId=action.MaterialId,code=protocol==null?"restore_projection_failed":protocol.Code,error=protocol==null?"选材调整尚未完成，现有草稿和原始资料已保留，请重试。":protocol.Message});}}
    }
    public bool VerifyCaptureAck(Dictionary<string,object> data){
        string materialId=CaptureText(data,"id",36),operationId=CaptureText(data,"operationId",36),attemptId=CaptureText(data,"attemptId",36);object raw;
        if(!CaptureId(materialId)||!CaptureId(operationId)||!CaptureId(attemptId)||!data.TryGetValue("target",out raw))throw new CaptureProtocolException("invalid_delivery","附图确认身份无效。");var target=ReadCaptureTarget(raw);
        var receipt=data.TryGetValue("receipt",out raw)?raw as Dictionary<string,object>:null;if(receipt==null||CaptureNumber(receipt,"protocol",2)!=2||CaptureText(receipt,"materialId",36)!=materialId||CaptureText(receipt,"operationId",36)!=operationId||CaptureText(receipt,"attemptId",36)!=attemptId||!receipt.TryGetValue("target",out raw)||!ReadCaptureTarget(raw).Same(target))throw new CaptureProtocolException("invalid_delivery","附图确认回执不属于这次操作。");
        string state=CaptureText(receipt,"state",16),evidence=CaptureText(receipt,"evidence",32);int count=(int)CaptureNumber(receipt,"count",300);object verified;if(!receipt.TryGetValue("verified",out verified)||!(verified is bool)||!(bool)verified)return false;
        lock(captureGate){CaptureAttempt attempt;if(!captureStatus.TryGetValue(attemptId,out attempt))return false;if(attempt.MaterialId!=materialId||attempt.OperationId!=operationId||!attempt.Target.Same(target))throw new CaptureProtocolException("invalid_delivery","附图确认不属于这次操作。");return attempt.HasCompletion&&state==attempt.CompletionState&&evidence==attempt.CompletionEvidence&&count==attempt.CompletionCount;}
    }
    public bool HasCaptureAttempt(string attemptId){lock(captureGate)return captureStatus.ContainsKey(attemptId);}
    public object CaptureStatus(string attemptId){lock(captureGate){PruneCaptures();CaptureAttempt value;if(captureStatus.TryGetValue(attemptId,out value)){if(!value.HasCompletion&&(!CaptureReady||!CurrentCaptureWorkspace(value)||value.DraftId!=captureComposerDraftId||!captureTarget.Same(value.Target)||!LatestCaptureOperation(value))){value.State="cancelled";value.Error="目标对话或投递尝试已切换，材料已保留。";value.Evidence="";}return value.Snapshot();}return new {protocol=2,attemptId=attemptId,state="unknown",error="附图结果已过期，材料已保留，请重新验证。",count=0,verified=false,evidence=""};}}
    public async Task<long> PrepareToClose(){
        if(disposed||main==null||!Exists(host)||!ChatOrigin(main.CoreWebView2.Source)){RetireDraftWriters();await PreserveRetiredDraftBuffers();return 0;}
        lock(captureGate){foreach(var attempt in captureStatus.Values)if(attempt.State=="queued"||attempt.State=="working")throw new Exception("材料仍在附入提问，请完成后再退出助手。");}
        var browser=main.CoreWebView2;int ticket=generation;long freeze=++shutdownFreezeRevision;
        var target=captureTarget;long document=captureDocumentEpoch;string route=CaptureRoute(browser.Source);
        Func<bool> current=delegate{return CurrentCaptureBrowser(browser,ticket)&&captureDocumentEpoch==document&&CaptureRoute(browser.Source)==route&&(target==null||captureTarget!=null&&captureTarget.Same(target));};
        if(Exists(host)&&IsWindowEnabled(host)){shutdownDisabledWindow=true;EnableWindow(host,false);}shutdownFrozen=true;
        try{
            if(Exists(host)&&IsWindowEnabled(host))throw new Exception("未能暂停提问输入，退出已取消。");
            if(captureTarget!=null)CaptureReply(browser,ticket,new {kind="zjf-close-state",protocol=2,closeRevision=freeze,frozen=true,target=captureTarget.Snapshot()});
            // The page must acknowledge its final editor revision before native
            // persistence acceptance closes. No arbitrary script is exposed.
            string script="(async()=>{try{if(typeof window.__ZJF_SET_CLOSE_STATE_V1__==='function')window.__ZJF_SET_CLOSE_STATE_V1__("+freeze+",true);if(typeof window.__ZJF_SAVE_BEFORE_CLOSE_V1__!=='function')return {error:'提问组件尚未就绪，请稍后再退出。'};return await window.__ZJF_SAVE_BEFORE_CLOSE_V1__();}catch(e){return {error:e.message};}})()";
            var pending=browser.CallDevToolsProtocolMethodAsync("Runtime.evaluate",new JavaScriptSerializer().Serialize(new {expression=script,awaitPromise=true,returnByValue=true,timeout=12000}));
            if(await Task.WhenAny(pending,Task.Delay(14000))!=pending)throw new Exception("草稿保存尚未确认，退出已取消。");
            if(!current())throw new CaptureProtocolException("conversation_changed","提问页面已变化，原关闭不再更改当前页面。");
            var response=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(await pending);object raw,value=null;response.TryGetValue("result",out raw);var result=raw as Dictionary<string,object>;if(result!=null)result.TryGetValue("value",out value);
            if(!current())throw new CaptureProtocolException("conversation_changed","提问页面已变化，原关闭不再更改当前页面。");
            if(!(value is bool&&(bool)value)){string message=CaptureEcho(value as Dictionary<string,object>,"error",1024);throw new Exception(message!=""?message:"草稿保存尚未确认，退出已取消。");}
            await PreserveRetiredDraftBuffers();
            if(freeze!=shutdownFreezeRevision||!current())throw new CaptureProtocolException("request_cancelled","已有更新的提问操作，原关闭不再改变当前页面。");
            return freeze;
        }catch{ResumeAfterFailedClose(freeze);throw;}
    }
    public async Task NavigateConversation(string target,Func<bool> current=null,long workspaceRevision=0){
        if(current!=null&&!current())throw new CaptureProtocolException("workspace_changed","提问工作区已切换，原草稿已保留。");
        if(main==null||popups.Count>0)throw new Exception("请先打开 ChatGPT 并完成登录。");
        string url=target=="new"?"https://chatgpt.com/":target;
        if(!ChatOrigin(url)||(target!="new"&&CaptureConversation(CaptureRoute(url))==null))throw new Exception("请选择有效的 ChatGPT 对话。");
        if(target=="new"&&!CaptureReady)throw new Exception("ChatGPT 输入框尚未就绪，请稍后重试。");
        long navigation=++conversationNavigationRevision;
        if(target!="new"){var original=main.CoreWebView2;int originalTicket=generation;long freeze=0;var originalTarget=captureTarget;long originalDocument=captureDocumentEpoch;try{freeze=await PrepareToClose();if(current!=null&&!current())throw new CaptureProtocolException("workspace_changed","提问工作区已切换，原草稿已保留。");if(navigation!=conversationNavigationRevision||!CurrentCaptureBrowser(original,originalTicket)||originalDocument!=captureDocumentEpoch||originalTarget!=null&&(captureTarget==null||!originalTarget.Same(captureTarget)))throw new CaptureProtocolException("conversation_changed","提问页面已切换，原草稿已保留。");newConversationFrom="";ready=false;original.Navigate(url);}finally{if(freeze!=0)ResumeAfterFailedClose(freeze);}return;}
        newConversationFrom=captureTarget.ConversationId;
        var browser=main.CoreWebView2;int ticket=generation;
        try{
            // Use the visible New chat action. Re-navigating to '/' can restore
            // the previous home-page composer, leaking unselected old questions.
            string script="(async()=>{try{if(typeof window.__ZJF_START_NEW_CHAT_V1__!=='function')return {error:'提问组件尚未就绪，请稍后重试。'};return await window.__ZJF_START_NEW_CHAT_V1__("+workspaceRevision+");}catch(e){return {error:e.message,code:e.code||''};}})()";
            var json=await browser.CallDevToolsProtocolMethodAsync("Runtime.evaluate",new JavaScriptSerializer().Serialize(new {expression=script,awaitPromise=true,returnByValue=true,timeout=12000}));
            var response=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(json);object raw,value;response.TryGetValue("result",out raw);var result=raw as Dictionary<string,object>;
            value=null;if(result!=null)result.TryGetValue("value",out value);bool clicked=value is bool&&(bool)value;
            if(navigation!=conversationNavigationRevision||!CurrentCaptureBrowser(browser,ticket))throw new CaptureProtocolException("conversation_changed","提问窗口已切换，所选资料已保留。");
            if(current!=null&&!current())throw new CaptureProtocolException("workspace_changed","提问工作区已切换，原草稿已保留。");
            string navigationError=CaptureEcho(value as Dictionary<string,object>,"error",1024);
            if(!clicked){string code=CaptureEcho(value as Dictionary<string,object>,"code",64),message=navigationError!=""?navigationError:"新聊天暂未打开，原草稿已保留，请重试。";if(code=="conversation_changed"||code=="workspace_changed")throw new CaptureProtocolException(code,message);throw new Exception(message);}
        }catch{if(navigation==conversationNavigationRevision)newConversationFrom="";throw;}
    }
    public async Task<object> RestoreSavedDraft(Dictionary<string,object> request,Func<bool> current=null,long workspaceRevision=0){
        string sourceId=CaptureText(request,"id",36);if(!CaptureId(sourceId))throw new CaptureProtocolException("invalid_message","草稿编号无效。");object raw;request.TryGetValue("target",out raw);var target=ReadCaptureTarget(raw);
        if(current!=null&&!current())throw new CaptureProtocolException("workspace_changed","提问工作区已切换，原草稿已保留。");
        string ownerDraftId=captureComposerDraftId,requestedDraftId=CaptureText(raw as Dictionary<string,object>,"draftId",36,false);
        if(!CaptureReady||!captureTarget.Same(target)||requestedDraftId!=""&&requestedDraftId!=ownerDraftId)throw new CaptureProtocolException("conversation_changed","提问目标已变化，请在当前页面重试。");
        var browser=main.CoreWebView2;int ticket=generation;
        var question=await Task.Run(delegate{return StudyLibrary.Run("/library/question",new Dictionary<string,object>{{"id",sourceId}}) as Dictionary<string,object>;});
        if(current!=null&&!current())throw new CaptureProtocolException("workspace_changed","提问工作区已切换，原草稿已保留。");
        if(!CaptureReady||!CurrentCaptureTarget(browser,ticket,target)||ownerDraftId!=captureComposerDraftId)throw new CaptureProtocolException("conversation_changed","提问目标已变化，原草稿已保留。");
        if(CaptureEcho(question,"status",16)!="draft")throw new Exception("这份提问不是未发送草稿，请从资料中选择要引用的内容。");
        var serializer=new JavaScriptSerializer{MaxJsonLength=InboundMessageLimit};
        string script="(async()=>{try{if(typeof window.__ZJF_RESTORE_SAVED_DRAFT_V1__!=='function')return {error:'请更新连接组件后继续草稿。'};return await window.__ZJF_RESTORE_SAVED_DRAFT_V1__("+serializer.Serialize(question)+","+serializer.Serialize(target.Snapshot())+","+workspaceRevision+");}catch(e){return {error:e.message,code:e.code||''};}})()";
        var json=await browser.CallDevToolsProtocolMethodAsync("Runtime.evaluate",serializer.Serialize(new {expression=script,awaitPromise=true,returnByValue=true,timeout=85000}));
        var response=serializer.Deserialize<Dictionary<string,object>>(json);response.TryGetValue("result",out raw);var evaluated=raw as Dictionary<string,object>;object value=null;if(evaluated!=null)evaluated.TryGetValue("value",out value);var result=value as Dictionary<string,object>;
        if(current!=null&&!current())throw new CaptureProtocolException("workspace_changed","提问工作区已切换，恢复的草稿仍已保留。");
        if(!CurrentCaptureTarget(browser,ticket,target))throw new CaptureProtocolException("conversation_changed","提问目标已变化，恢复的草稿仍已保留。");
        string error=CaptureEcho(result,"error",1024);if(error!=""){string code=CaptureEcho(result,"code",64);if(code=="conversation_changed"||code=="workspace_changed")throw new CaptureProtocolException(code,error);throw new Exception(error);}
        if(result==null)throw new Exception("草稿恢复尚未确认，当前内容和原记录都已保留，请在当前草稿重试。");
        if(result!=null&&result.TryGetValue("requiresNew",out raw)&&raw is bool&&(bool)raw)return new {requiresNew=true,target=target.Snapshot()};
        string draftId=CaptureText(result,"draftId",36);object verified;result.TryGetValue("target",out raw);
        if(!CaptureId(draftId)||CaptureText(result,"sourceId",36)!=sourceId||!result.TryGetValue("verified",out verified)||!(verified is bool)||(bool)verified!=true||!ReadCaptureTarget(raw).Same(target)||!CurrentSavedDraft(draftId,browser,ticket,target))throw new Exception("草稿恢复和保存尚未确认，请保留当前内容后重试。");
        return result;
    }
    public bool CaptureReady {get{lock(captureGate){return captureBrowser!=null&&CurrentCaptureBrowser(captureBrowser,captureHostTicket)&&ready&&popups.Count==0&&pendingPopups==0&&!shutdownFrozen&&captureComposerReady&&CaptureId(captureComposerDraftId)&&captureTransportError==""&&captureTarget!=null&&captureTarget.ConversationId!=newConversationFrom&&captureTarget.DocumentEpoch==captureDocumentEpoch&&CaptureRoute(main.CoreWebView2.Source)==captureTarget.Route;}}}
    public string CaptureError {get{lock(captureGate){return captureComposerError!=""?captureComposerError:captureTransportError;}}}
    public object CaptureTarget {get{lock(captureGate){if(!CaptureReady)return null;var target=captureTarget.Snapshot();if(captureComposerDraftId!="")target["draftId"]=captureComposerDraftId;return target;}}}
    public static void ValidatePlan(Dictionary<string,object> plan){
        object id,items,logical;if(plan==null||!plan.TryGetValue("id",out id)||!CaptureId(id)||!plan.TryGetValue("items",out items)||!plan.TryGetValue("logicalItems",out logical))throw new Exception("提问材料不完整。");
        var list=items as IList;var sources=logical as IList;if(list==null||list.Count>20||sources==null||sources.Count>300)throw new Exception("材料页数或来源数量超出范围。");var pages=new HashSet<string>();
        foreach(var raw in list){var item=raw as Dictionary<string,object>;ValidateCaptureImage(item,true);if(CaptureText(item,"kind",16)!="collection"||!pages.Add(CaptureText(item,"id",300)))throw new Exception("材料页身份无效。");}
        var ids=new HashSet<string>();foreach(var raw in sources){var item=raw as Dictionary<string,object>;string kind=CaptureText(item,"kind",16);CaptureText(item,"label",200);if((kind!="panorama"&&kind!="board"&&kind!="selection")||!ids.Add(CaptureText(item,"id",300))||!pages.Contains(CaptureText(item,"attachmentId",300)))throw new Exception("材料来源身份无效。");object ask;if(item.TryGetValue("ask",out ask)&&!(ask is bool))throw new Exception("材料提问状态无效。");}
        object carry;if(list.Count==0&&sources.Count==0&&(!plan.TryGetValue("carry",out carry)||!(carry is IList)||((IList)carry).Count==0))throw new Exception("请先选择材料或旧提问。");
    }
    public static void ValidateCapture(Dictionary<string,object> batch,bool allowAssets=false){
        object id,selection,context;
        if(batch==null||!batch.TryGetValue("id",out id)||!CaptureId(id)||!batch.TryGetValue("selection",out selection)||!batch.TryGetValue("context",out context))throw new Exception("截图数据不完整。");
        CaptureText(batch,"lessonKey",512);object course;if(!batch.TryGetValue("course",out course)||!(course is Dictionary<string,object>))throw new Exception("截图课程信息无效。");
        object complete,missing;bool partial=batch.TryGetValue("contextComplete",out complete)&&complete is bool&&!(bool)complete&&batch.TryGetValue("missingContext",out missing)&&missing is IList&&((IList)missing).Count>0;
        var list=context as IList;if(list==null||list.Count<(partial?0:1)||list.Count>7)throw new Exception("背景图数量不正确。");
        var selected=selection as Dictionary<string,object>;ValidateCaptureImage(selected,false,allowAssets);if(CaptureText(selected,"kind",16)!="selection")throw new Exception("圈选图片类型无效。");var ids=new HashSet<string>{CaptureText(selected,"id",300)};
        foreach(var raw in list){var item=raw as Dictionary<string,object>;ValidateCaptureImage(item,false,allowAssets);string kind=CaptureText(item,"kind",16);if((kind!="panorama"&&kind!="board")||!ids.Add(CaptureText(item,"id",300)))throw new Exception("背景图片身份无效。");}
    }
    static void ValidateCaptureImage(Dictionary<string,object> item,bool allowJpeg,bool allowAssets=false){
        CaptureText(item,"id",300);CaptureText(item,"label",200);CaptureText(item,"kind",16);
        int maximum=allowAssets?StudyLibrary.MaxOriginalImageChars:12*1024*1024;
        if(allowAssets&&CaptureText(item,"image",maximum,false)==""){StudyLibrary.ValidateCaptureAsset(CaptureText(item,"asset",64));return;}
        string image=CaptureText(item,"image",maximum);StudyLibrary.ValidateCaptureImageData(image,allowJpeg,maximum);
    }
}
