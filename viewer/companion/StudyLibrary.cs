using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

// User material lives outside the installation and bookmark bundle. Version 1
// documents are additive; updating the executable never recreates this folder.
static class StudyLibrary {
    static readonly object gate=new object();
    static readonly object pendingGate=new object();
    static readonly Dictionary<long,PersistenceLease> pending=new Dictionary<long,PersistenceLease>();
    static readonly Dictionary<string,WorkFailure> failures=new Dictionary<string,WorkFailure>();
    static readonly Dictionary<string,long> provenVersions=new Dictionary<string,long>();
    static readonly Dictionary<string,long> provenSequences=new Dictionary<string,long>();
    static readonly Dictionary<string,string> verifiedSourceFrames=new Dictionary<string,string>();
    static readonly Dictionary<string,QuestionJob> questionJobs=new Dictionary<string,QuestionJob>();
    static readonly Dictionary<string,Task<Dictionary<string,object>>> recoveryJobs=new Dictionary<string,Task<Dictionary<string,object>>>();
    static readonly Queue<QuestionJob> questionOrder=new Queue<QuestionJob>();
    static long acceptedSequence;
    static int queuedQuestionBytes;
    static bool accepting=true,draining,questionWorker;
    [ThreadStatic] static PersistenceLease currentLease;
    public const int MaxQueuedQuestionIds=64;
    public const int MaxQueuedQuestionBytes=16*1024*1024;
    public const int MaxQuestionInputBytes=2*1024*1024;
    public const int MaxComposeJsonBytes=60*1024*1024;
    // Saved capture requests can contain 64 MiB. Recovery adds immutable source
    // references and mark metadata; its transport must retain that whole batch.
    public const int MaxCaptureJsonBytes=66*1024*1024;
    public const int MaxOriginalImageChars=96*1024*1024;
    public const int MaxOriginalJsonBytes=MaxOriginalImageChars+65536;
    const int MaxOriginalImageBytes=72*1024*1024-65536;
    const int MaxImageDimension=16384;
    const long MaxImagePixels=32L*1024*1024;

    sealed class WorkFailure {public long Sequence,Revision;public string Error,SelectionProof;public bool SnapshotCommitted;public Dictionary<string,object> Question;}
    sealed class QuestionJob {
        public string Id;public Dictionary<string,object> Latest;public long Revision;public int Bytes;
        public PersistenceLease Lease;public readonly TaskCompletionSource<object> Completion=new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
    }
    public sealed class DrainResult {
        public readonly bool Success,TimedOut;public readonly int Pending;public readonly string Error;
        internal DrainResult(bool success,bool timedOut,int count,string error){Success=success;TimedOut=timedOut;Pending=count;Error=error;}
    }
    // Register on the accepting thread, before dispatching a DeferredWork. Execute
    // releases the registration even on failure. Dispose cancels an unused lease.
    public sealed class PersistenceLease : IDisposable {
        internal readonly long Sequence;internal readonly string Key;internal readonly bool Intent;
        internal long Revision,CommittedRevision;internal bool Started,Finished,Wrote,SnapshotCommitted;internal string SelectionProof;
        internal Dictionary<string,object> Question;
        internal PersistenceLease(long sequence,string key,long revision,bool intent){Sequence=sequence;Key=key;Revision=revision;Intent=intent;}
        public T Execute<T>(Func<T> action){
            lock(pendingGate){if(Started||Finished)throw new InvalidOperationException("持久化工作已执行或取消。");Started=true;}
            var previous=currentLease;currentLease=this;Exception failure=null;
            try{return action();}catch(Exception error){failure=error;throw;}finally{currentLease=previous;Finish(this,failure);}
        }
        public void Execute(Action action){Execute<object>(delegate{action();return null;});}
        public void Dispose(){lock(pendingGate){if(Finished||Started)return;Finish(this,new OperationCanceledException("已接受的保存工作在执行前被取消。"));}}
    }
    static PersistenceLease AcceptLocked(string key,long revision,bool intent){
        if(!accepting)throw new InvalidOperationException("资料库正在保存并退出，请稍后再试。");
        var lease=new PersistenceLease(++acceptedSequence,key,revision,intent);pending.Add(lease.Sequence,lease);return lease;
    }
    public static PersistenceLease AcceptLibraryWork(string path,Dictionary<string,object> p){
        lock(pendingGate)if(!accepting)throw new InvalidOperationException("资料库正在保存并退出，请稍后再试。");
        bool save=path=="/library/save",selection=path=="/library/selection-save";if(selection){SelectionId(Text(p,"scope"));Id(Text(p,"writeId"));Integer(Value(p,"baseRevision"),"selection revision");ValidateSelectionChoice(Object(Value(p,"choice")));}string key=save?"snapshot:"+Id(Text(Object(Value(p,"batch")),"id")):selection?"selection:"+SelectionId(NormalizeLessonKey(Text(p,"scope"))):"library:"+path+":"+Text(p,"id");
        if(path=="/library/selection")key="library:selection-read:"+SelectionId(NormalizeLessonKey(Text(p,"scope")));
        if(path=="/library/plan-job")key="plan:"+Id(Text(Object(Value(p,"plan")),"id"));
        if(path=="/library/asset")key="asset:"+Text(p,"asset");
        if(save){
            // Source validation can recover an original snapshot from backup.
            // Register that read before it can write, and serialize its cache
            // changes. Its success is not proof that this capture was saved.
            PersistenceLease validation;lock(pendingGate)validation=AcceptLocked("library:validate-save:"+Id(Text(Object(Value(p,"batch")),"id")),0,false);
            using(validation)validation.Execute(delegate{lock(gate)ValidateSaveInput(p);});
        }
        string selectionProof=selection?Id(Text(p,"writeId"))+":"+ValueDigest(Value(p,"choice")):null;
        lock(pendingGate){var lease=AcceptLocked(key,0,save||selection||path=="/library/plan-job"||path=="/library/asset");lease.SelectionProof=selectionProof;return lease;}
    }
    static void Finish(PersistenceLease lease,Exception error){lock(pendingGate){
        if(lease.Finished)return;lease.Finished=true;pending.Remove(lease.Sequence);
        long version,sequence;provenVersions.TryGetValue(lease.Key,out version);provenSequences.TryGetValue(lease.Key,out sequence);
        if(error==null){version=Math.Max(version,lease.CommittedRevision);sequence=Math.Max(sequence,lease.Sequence);provenVersions[lease.Key]=version;provenSequences[lease.Key]=sequence;}
        bool question=lease.Key.StartsWith("question:",StringComparison.Ordinal);
        bool proved=question?version>=lease.Revision:sequence>=lease.Sequence;
        WorkFailure prior;
        if(error!=null&&(lease.Intent||lease.Wrote)&&!proved){
            if(!failures.TryGetValue(lease.Key,out prior)||prior.Revision<=lease.Revision)failures[lease.Key]=new WorkFailure{Sequence=lease.Sequence,Revision=lease.Revision,Error=error.Message,SnapshotCommitted=lease.SnapshotCommitted,Question=lease.Question,SelectionProof=lease.SelectionProof};
        }else if(error==null&&failures.TryGetValue(lease.Key,out prior)&&(question?version>=prior.Revision:sequence>=prior.Sequence))failures.Remove(lease.Key);
        if(!pending.Values.Any(x=>x.Key==lease.Key)){provenVersions.Remove(lease.Key);provenSequences.Remove(lease.Key);}
        Monitor.PulseAll(pendingGate);
    }}
    static void CanWait(){if(Monitor.IsEntered(gate)||currentLease!=null)throw new InvalidOperationException("不能在资料锁或持久化工作内部等待排空。");}
    static string FailureText(long before){var errors=failures.Values.Where(x=>x.Sequence<before).ToArray();return errors.Length==0?"":"有 "+errors.Length+" 项资料未保存："+errors[0].Error;}
    public static DrainResult StopAcceptingAndDrain(int timeoutMilliseconds){
        CanWait();if(timeoutMilliseconds<0)throw new ArgumentOutOfRangeException("timeoutMilliseconds");var watch=Stopwatch.StartNew();
        lock(pendingGate){
            if(draining)return new DrainResult(false,false,pending.Count,"资料库已经在等待保存完成。");
            draining=true;accepting=false;
            try{
                while(pending.Count!=0){int remaining=Math.Max(0,timeoutMilliseconds-(int)Math.Min(int.MaxValue,watch.ElapsedMilliseconds));if(remaining==0||!Monitor.Wait(pendingGate,remaining)){accepting=true;return new DrainResult(false,true,pending.Count,"资料仍在保存，已恢复服务；请稍后再退出。");}}
                string error=FailureText(long.MaxValue);if(error!=""){accepting=true;return new DrainResult(false,false,0,error);}
                return new DrainResult(true,false,0,"");
            }finally{draining=false;}
        }
    }
    public static void ResumeAccepting(){lock(pendingGate){if(draining)throw new InvalidOperationException("资料库仍在排空。");accepting=true;}}
    public static bool FlushPending(){
        CanWait();var watch=Stopwatch.StartNew();lock(pendingGate){while(pending.Count!=0){int remaining=Math.Max(0,5000-(int)watch.ElapsedMilliseconds);if(remaining==0||!Monitor.Wait(pendingGate,remaining))return false;}return failures.Count==0;}
    }
    internal static bool FlushQuestionWrites(){
        CanWait();var watch=Stopwatch.StartNew();lock(pendingGate){while(pending.Values.Any(x=>x.Key.StartsWith("question:",StringComparison.Ordinal))){int remaining=Math.Max(0,5000-(int)watch.ElapsedMilliseconds);if(remaining==0||!Monitor.Wait(pendingGate,remaining))return false;}return !failures.Keys.Any(x=>x.StartsWith("question:",StringComparison.Ordinal));}
    }
    internal static bool FlushQuestionWrites(string draftId){
        CanWait();string key="question:"+Id(draftId);var watch=Stopwatch.StartNew();lock(pendingGate){while(pending.Values.Any(x=>x.Key==key)){int remaining=Math.Max(0,5000-(int)watch.ElapsedMilliseconds);if(remaining==0||!Monitor.Wait(pendingGate,remaining))return false;}return !failures.ContainsKey(key);}
    }
    internal static bool FlushContextWrites(string conversationId,string lessonKey="",string composerText="",IEnumerable<string> draftIds=null){
        CanWait();var requested=new HashSet<string>(draftIds??Enumerable.Empty<string>());string lesson=NormalizeLessonKey(lessonKey);
        Func<Dictionary<string,object>,bool> matches=delegate(Dictionary<string,object> question){
            if(question==null)return false;if(requested.Contains(Text(question,"id")))return true;
            if(Text(question,"conversationId")==conversationId||Text(Object(Value(Object(Value(question,"sendIntent")),"adoptionCandidate")),"to")==conversationId)return true;
            var manifest=Object(Value(question,"draftManifest"));return lesson!=""&&!String.IsNullOrWhiteSpace(composerText)&&NormalizeLessonKey(Text(question,"lessonKey"))==lesson&&manifest!=null&&DraftComposerMatches(manifest,composerText);
        };
        var watch=Stopwatch.StartNew();lock(pendingGate){
            while(pending.Values.Any(lease=>lease.Key.StartsWith("question:",StringComparison.Ordinal)&&matches(lease.Question))){int remaining=Math.Max(0,5000-(int)watch.ElapsedMilliseconds);if(remaining==0||!Monitor.Wait(pendingGate,remaining))return false;}
            return !failures.Any(pair=>pair.Key.StartsWith("question:",StringComparison.Ordinal)&&matches(pair.Value.Question));
        }
    }
    static void WaitBefore(PersistenceLease lease){
        if(Monitor.IsEntered(gate))throw new InvalidOperationException("不能持有资料锁等待备份。");var watch=Stopwatch.StartNew();
        lock(pendingGate){while(pending.Keys.Any(x=>x<lease.Sequence)){int remaining=Math.Max(0,5000-(int)watch.ElapsedMilliseconds);if(remaining==0||!Monitor.Wait(pendingGate,remaining))throw new Exception("较早接受的资料仍在保存，请稍后再备份。");}string error=FailureText(lease.Sequence);if(error!="")throw new Exception(error);}
    }
    internal static string TestRoot=null;
    sealed class LibraryCatalogue {
        public string Root;public bool Dirty=true,Building;public long MarksStamp,SnapshotsStamp;
        public FileSystemWatcher Watcher;public LibraryState State;
        public readonly Dictionary<string,string> Stamps=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
        public readonly Dictionary<string,Dictionary<string,object>> Orphans=new Dictionary<string,Dictionary<string,object>>();
        public readonly Dictionary<string,Dictionary<string,object>> Captures=new Dictionary<string,Dictionary<string,object>>();
    }
    static LibraryCatalogue catalogue;
    sealed class QuestionCatalogue {
        public string Root,Error="";public bool Dirty=true,Building,NeedsWrite,Background;public long Stamp,Version;public int Completed,Total;public FileSystemWatcher Watcher;public Task BackgroundTask;
        public readonly Dictionary<string,string> Stamps=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string,Dictionary<string,object>> Records=new Dictionary<string,Dictionary<string,object>>();
    }
    static QuestionCatalogue questionCatalogue;
    static string FileStamp(string path){try{var file=new FileInfo(path);return file.Exists?file.Length+":"+file.LastWriteTimeUtc.Ticks:"";}catch{return "";}}
    static long DirectoryStamp(string name){return Directory.GetLastWriteTimeUtc(Folder(name)).Ticks;}
    static Dictionary<string,object> SnapshotSummary(Dictionary<string,object> snapshot){
        return new Dictionary<string,object>{{"id",Text(snapshot,"id")},{"markId",Text(snapshot,"markId")},{"createdAt",Text(snapshot,"createdAt")},{"items",Array(Value(snapshot,"items")).Cast<object>().Where(x=>Text(Object(x),"kind")=="selection").Select(x=>(object)new Dictionary<string,object>{{"kind","selection"}}).ToArray()}};
    }
    static void CatalogueChanged(LibraryCatalogue source,string path){lock(gate){
        if(catalogue!=source||source.Dirty||source.Building)return;
        string parent=Path.GetFileName(Path.GetDirectoryName(path));if(parent!="marks"&&parent!="snapshots")return;
        string name=Path.GetFileName(path);if(!name.EndsWith(".json",StringComparison.OrdinalIgnoreCase)&&!name.EndsWith(".json.bak",StringComparison.OrdinalIgnoreCase))return;
        string primary=name.EndsWith(".bak",StringComparison.OrdinalIgnoreCase)?path.Substring(0,path.Length-4):path;string known;
        if(!source.Stamps.TryGetValue(primary,out known)||known!=FileStamp(primary))source.Dirty=true;
    }}
    static void CatalogueDocument(string folder,string id,Dictionary<string,object> document){
        if((folder=="capture-meta"||folder=="capture-deliveries"||folder=="capture-completed")&&captureOrderRoot==Path.GetFullPath(Root)){string field=folder=="capture-meta"?"nextOrder":"order";captureOrderFloor=Math.Max(captureOrderFloor,Integer(Value(document,field),field));}
        if(folder=="questions"){CatalogueQuestion(id,document);return;}
        var current=catalogue;if(current==null||current.Dirty||current.Building||current.Root!=Path.GetFullPath(Root)||(folder!="marks"&&folder!="snapshots"))return;
        var rows=folder=="marks"?current.State.Marks:current.State.Snapshots;var prior=rows.Find(x=>Text(x,"id")==id);
        var copy=folder=="marks"?Json().Deserialize<Dictionary<string,object>>(Json().Serialize(document)):SnapshotSummary(document);
        if(prior==null)rows.Add(copy);else rows[rows.IndexOf(prior)]=copy;
        current.Stamps[FileFor(folder,id)]=FileStamp(FileFor(folder,id));current.MarksStamp=DirectoryStamp("marks");current.SnapshotsStamp=DirectoryStamp("snapshots");
        if(folder=="snapshots"&&!current.State.Marks.Any(x=>Text(x,"id")==Text(document,"markId")))current.Orphans[Text(document,"markId")]=Json().Deserialize<Dictionary<string,object>>(Json().Serialize(Value(document,"markHeader")));
        if(folder=="snapshots"&&Object(Value(document,"captureIntent"))!=null)current.Captures[id]=Object(Value(document,"captureIntent"));
        if(folder=="marks")current.Orphans.Remove(id);
    }
    static Dictionary<string,object> QuestionSummary(Dictionary<string,object> question){
        var summary=new Dictionary<string,object>();foreach(string field in new[]{"id","revision","title","status","conversationUrl","conversationId","markTitles","updatedAt","contextKeys","sendId","turnId","confirmation","adoptedFrom","adoptionTurnId","adoptionConfirmation"})if(question.ContainsKey(field))summary[field]=question[field];
        var original=Object(Value(question,"sendIntent"));if(original!=null){var intent=new Dictionary<string,object>();foreach(string field in new[]{"id","questionId","status","target","turnId","confirmation","operationIds","deliveries","adoptedFrom","adoptionTurnId","adoptionConfirmation","adoptionCandidate","observedTurnId","sendCorrelation"})if(original.ContainsKey(field))intent[field]=original[field];summary["sendIntent"]=intent;}
        var recovery=Object(Value(question,"recoveryOf"));if(recovery!=null)summary["recoveryOf"]=new Dictionary<string,object>{{"id",Text(recovery,"id")},{"revision",Value(recovery,"revision")}};
        var manifest=Object(Value(question,"draftManifest"));var draft=Object(Value(manifest,"draft"));
        summary["hasDraftManifest"]=manifest!=null;
        var inline=Object(Value(draft,"inline"));bool inlineComposer=Text(inline,"version")=="1";
        string questionText=Text(inlineComposer?inline:question,"text").TrimStart();
        summary["hasQuestionText"]=Array(Value(question,"questions")).Cast<object>().Select(Object).Any(part=>part!=null&&!String.IsNullOrWhiteSpace(Text(part,"text")))||(!String.IsNullOrWhiteSpace(questionText)&&(inlineComposer||!questionText.StartsWith("【课堂背景与图片说明】")&&!questionText.StartsWith("【保留的原提问】")));
        summary["imageCount"]=Array(Value(draft,"items")).Count;
        summary["lessonKey"]=NormalizeLessonKey(Text(manifest,"viewerLessonKey",Text(draft,"lessonKey")));
        summary["course"]=Value(manifest,"viewerCourse",Value(draft,"course",new Dictionary<string,object>()));
        summary["workspaceReset"]=Text(manifest,"workspaceReset")=="True";
        summary["hasContent"]=!String.IsNullOrWhiteSpace(Text(question,"text"))||Array(Value(question,"refs")).Count>0;
        return Json().Deserialize<Dictionary<string,object>>(Json().Serialize(summary));
    }
    static void CatalogueQuestion(string id,Dictionary<string,object> question){
        var current=questionCatalogue;if(current==null||current.Building||current.Root!=Path.GetFullPath(Root))return;string path=FileFor("questions",id),stamp=QuestionFileStamp(path),known;if(current.Records.ContainsKey(id)&&current.Stamps.TryGetValue(path,out known)&&known==stamp)return;current.Version++;current.Records[id]=QuestionSummary(question);current.Stamps[path]=stamp;if(!current.Background)current.Stamp=DirectoryStamp("questions");current.NeedsWrite=true;
    }
    static void QuestionsChanged(QuestionCatalogue source,string path){lock(gate){
        if(questionCatalogue!=source||source.Building)return;string name=Path.GetFileName(path);if(!name.EndsWith(".json",StringComparison.OrdinalIgnoreCase)&&!name.EndsWith(".json.bak",StringComparison.OrdinalIgnoreCase))return;string primary=name.EndsWith(".bak",StringComparison.OrdinalIgnoreCase)?path.Substring(0,path.Length-4):path;string known;if(!source.Stamps.TryGetValue(primary,out known)||known!=QuestionFileStamp(primary)){source.Dirty=true;source.Version++;}
    }}
    static string QuestionFileStamp(string path){return FileStamp(path)+"|"+FileStamp(path+".bak");}
    static string QuestionIndexPath(){return Path.Combine(Root,".question-index-v1.json");}
    static bool LoadQuestionIndex(QuestionCatalogue current){
        foreach(string path in new[]{QuestionIndexPath(),QuestionIndexPath()+".bak"}){if(!File.Exists(path))continue;try{
            if(new FileInfo(path).Length>32*1024*1024)continue;var envelope=Json().Deserialize<Dictionary<string,object>>(File.ReadAllText(path,Encoding.UTF8));if(Text(envelope,"schema")!="1")continue;string payload=Text(envelope,"payload");if(payload==""||Digest(Encoding.UTF8.GetBytes(payload))!=Text(envelope,"checksum"))continue;
            var rows=Json().DeserializeObject(payload) as IList;if(rows==null)continue;var records=new Dictionary<string,Dictionary<string,object>>();var stamps=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
            foreach(var value in rows){var row=Object(value);string id=Id(Text(row,"id"));var summary=Object(Value(row,"summary"));if(summary==null||Text(summary,"id")!=id||!summary.ContainsKey("lessonKey")||!summary.ContainsKey("revision")||!(Value(row,"stamp") is string))throw new InvalidDataException("Invalid question index");records.Add(id,summary);stamps.Add(FileFor("questions",id),Text(row,"stamp"));}
            current.Records=records;current.Stamps.Clear();foreach(var stamp in stamps)current.Stamps.Add(stamp.Key,stamp.Value);current.NeedsWrite=path.EndsWith(".bak",StringComparison.OrdinalIgnoreCase);return true;
        }catch(OutOfMemoryException){throw;}catch{/* A derived index is disposable; source documents are still read below. */}}
        return false;
    }
    static void SaveQuestionIndex(QuestionCatalogue current){
        if(!current.NeedsWrite)return;string path=QuestionIndexPath(),temp=path+"."+Guid.NewGuid().ToString("N")+".tmp";
        try{string payload=Json().Serialize(current.Records.OrderBy(x=>x.Key).Select(x=>new {id=x.Key,stamp=current.Stamps[FileFor("questions",x.Key)],summary=x.Value}).ToArray());if(Encoding.UTF8.GetByteCount(payload)>24*1024*1024){current.NeedsWrite=false;return;}byte[] bytes=Encoding.UTF8.GetBytes(Json().Serialize(new {schema=1,checksum=Digest(Encoding.UTF8.GetBytes(payload)),payload=payload}));if(bytes.Length>32*1024*1024){current.NeedsWrite=false;return;}
            // Cache persistence is not a source-material write and must not make
            // an otherwise successful read look like an unsaved user operation.
            DurableBytes(temp,bytes);if(File.Exists(path))File.Replace(temp,path,path+".bak");else File.Move(temp,path);current.NeedsWrite=false;
        }catch(IOException){}catch(UnauthorizedAccessException){}catch(InvalidOperationException){current.NeedsWrite=false;}finally{RemoveTemp(temp);}
    }
    sealed class IndexedQuestion {public string Id,Stamp;public Dictionary<string,object> Document;public Exception Error;}
    static IndexedQuestion ReadQuestionForIndex(string id){
        var result=new IndexedQuestion{Id=id};string path=FileFor("questions",id);try{string before=QuestionFileStamp(path);result.Document=ReadValid(path,"questions",id);result.Stamp=QuestionFileStamp(path);if(before!=result.Stamp)throw new IOException("问题记录正在变化，请稍后重试。");}catch(Exception error){result.Error=error;}return result;
    }
    static void RebuildQuestions(QuestionCatalogue current,Action<int,int> progress=null){
        if(current.Records.Count==0)LoadQuestionIndex(current);var ids=new HashSet<string>();string folder=Folder("questions");long directoryStamp=DirectoryStamp("questions");foreach(string path in Directory.GetFiles(folder,"*.json"))ids.Add(Id(Path.GetFileNameWithoutExtension(path)));foreach(string path in Directory.GetFiles(folder,"*.json.bak")){string name=Path.GetFileName(path);ids.Add(Id(name.Substring(0,name.Length-9)));}if(progress!=null)progress(0,ids.Count);
        var records=new Dictionary<string,Dictionary<string,object>>();var stamps=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);var changed=new List<string>();
        foreach(var file in ids.AsParallel().WithDegreeOfParallelism(4).Select(id=>{string path=Path.Combine(folder,id+".json");return new {Id=id,Path=path,Stamp=QuestionFileStamp(path)};}).ToArray()){string known;Dictionary<string,object> summary;if(current.Records.TryGetValue(file.Id,out summary)&&current.Stamps.TryGetValue(file.Path,out known)&&file.Stamp==known&&summary.ContainsKey("hasQuestionText")&&summary.ContainsKey("imageCount")){records[file.Id]=summary;stamps[file.Path]=file.Stamp;}else changed.Add(file.Id);}
        // Only independent reads and schema checks run in parallel. Recovery,
        // cache mutation and any source-file replacement stay under the gate.
        int completed=records.Count;if(progress!=null)progress(completed,ids.Count);
        foreach(var read in changed.AsParallel().WithDegreeOfParallelism(4).Select(id=>{var item=ReadQuestionForIndex(id);if(item.Error==null){int count=Interlocked.Increment(ref completed);if(progress!=null)progress(count,ids.Count);}return item;}).ToArray()){
            Dictionary<string,object> document;if(read.Error==null)document=read.Document;else{lock(gate)document=Read("questions",read.Id);int count=Interlocked.Increment(ref completed);if(progress!=null)progress(count,ids.Count);}records[read.Id]=QuestionSummary(document);stamps[FileFor("questions",read.Id)]=read.Error==null?read.Stamp:QuestionFileStamp(FileFor("questions",read.Id));
        }
        current.NeedsWrite|=changed.Count!=0||records.Count!=current.Records.Count;current.Records=records;current.Stamps.Clear();foreach(var stamp in stamps)current.Stamps.Add(stamp.Key,stamp.Value);current.Stamp=directoryStamp;current.Dirty=false;
    }
    static QuestionCatalogue QuestionsCatalogue(){
        string root=Path.GetFullPath(Root);if(questionCatalogue==null||questionCatalogue.Root!=root){if(questionCatalogue!=null&&questionCatalogue.Watcher!=null)questionCatalogue.Watcher.Dispose();var created=new QuestionCatalogue{Root=root};var watcher=new FileSystemWatcher(Folder("questions")){NotifyFilter=NotifyFilters.FileName|NotifyFilters.LastWrite|NotifyFilters.Size,InternalBufferSize=32*1024};created.Watcher=watcher;questionCatalogue=created;
            watcher.Changed+=delegate(object sender,FileSystemEventArgs e){QuestionsChanged(created,e.FullPath);};watcher.Created+=delegate(object sender,FileSystemEventArgs e){QuestionsChanged(created,e.FullPath);};watcher.Deleted+=delegate(object sender,FileSystemEventArgs e){QuestionsChanged(created,e.FullPath);};watcher.Renamed+=delegate(object sender,RenamedEventArgs e){QuestionsChanged(created,e.OldFullPath);QuestionsChanged(created,e.FullPath);};watcher.Error+=delegate{lock(gate){if(questionCatalogue==created){created.Dirty=true;created.Version++;}}};watcher.EnableRaisingEvents=true;
        }
        var current=questionCatalogue;if(current.Stamp!=DirectoryStamp("questions"))current.Dirty=true;
        return current;
    }
    sealed class QuestionReadScope : IDisposable {
        public QuestionReadScope(){while(true){Monitor.Enter(gate);if(questionCatalogue==null||!questionCatalogue.Background)return;var task=questionCatalogue.BackgroundTask;Monitor.Exit(gate);if(Monitor.IsEntered(gate))throw new InvalidOperationException("不能持有资料锁等待提问索引。");task.GetAwaiter().GetResult();}}
        public void Dispose(){Monitor.Exit(gate);}
    }
    static List<Dictionary<string,object>> CachedQuestions(){
        var current=QuestionsCatalogue();if(current.Background)throw new InvalidOperationException("旧提问仍在整理，请稍后重试。");
        if(current.Dirty){current.Building=true;try{RebuildQuestions(current);current.Error="";}finally{current.Building=false;}}
        SaveQuestionIndex(current);
        return current.Records.Values.ToList();
    }
    static void IndexProgress(QuestionCatalogue current,int completed,int total){Volatile.Write(ref current.Total,total);int prior;do{prior=Volatile.Read(ref current.Completed);if(prior>=completed)return;}while(Interlocked.CompareExchange(ref current.Completed,completed,prior)!=prior);}
    static void StartQuestionIndex(QuestionCatalogue current){
        PersistenceLease lease;lock(pendingGate){if(!accepting&&currentLease==null)throw new InvalidOperationException("资料库正在保存并退出，请稍后再试。");lease=new PersistenceLease(++acceptedSequence,"library:question-index:"+current.Root,0,false);pending.Add(lease.Sequence,lease);}
        current.Background=true;current.Completed=current.Total=0;current.Error="";
        try{current.BackgroundTask=Task.Run(delegate{try{lease.Execute(delegate{
            while(true){QuestionCatalogue build;long version;lock(gate){if(questionCatalogue!=current||Path.GetFullPath(Root)!=current.Root)throw new InvalidOperationException("资料库已切换，请重新打开旧提问。");version=current.Version;current.Completed=current.Total=0;build=new QuestionCatalogue{Root=current.Root,NeedsWrite=current.NeedsWrite,Records=new Dictionary<string,Dictionary<string,object>>(current.Records)};foreach(var stamp in current.Stamps)build.Stamps[stamp.Key]=stamp.Value;}
                RebuildQuestions(build,delegate(int done,int total){IndexProgress(current,done,total);});
                lock(gate){if(questionCatalogue!=current||Path.GetFullPath(Root)!=current.Root)throw new InvalidOperationException("资料库已切换，请重新打开旧提问。");current.Records=build.Records;current.Stamps.Clear();foreach(var stamp in build.Stamps)current.Stamps[stamp.Key]=stamp.Value;current.Stamp=build.Stamp;current.NeedsWrite=build.NeedsWrite;
                    if(current.Version!=version||DirectoryStamp("questions")!=build.Stamp){current.Dirty=true;continue;}current.Dirty=false;current.Completed=current.Total=current.Records.Count;SaveQuestionIndex(current);return;
                }
            }
        });}catch(Exception error){lock(gate){current.Error=error.Message;current.Dirty=true;}}finally{lock(gate)current.Background=false;}});}catch{current.Background=false;lease.Dispose();throw;}
    }
    static object QuestionIndexStatus(bool retry,out List<Dictionary<string,object>> questions){
        var current=QuestionsCatalogue();if(retry&&!current.Background){current.Error="";current.Dirty=true;}if(current.Dirty&&!current.Background&&current.Error=="")StartQuestionIndex(current);
        string state=current.Background?"building":current.Error!=""?"error":"ready";questions=state=="ready"?current.Records.Values.ToList():new List<Dictionary<string,object>>();if(state=="ready")SaveQuestionIndex(current);
        return new {state=state,completed=state=="ready"?questions.Count:Volatile.Read(ref current.Completed),total=state=="ready"?questions.Count:Volatile.Read(ref current.Total),error=current.Error};
    }
    static LibraryState CachedLibrary(){
        string root=Path.GetFullPath(Root);
        if(catalogue==null||catalogue.Root!=root){if(catalogue!=null&&catalogue.Watcher!=null)catalogue.Watcher.Dispose();Directory.CreateDirectory(root);var created=new LibraryCatalogue{Root=root};
            var watcher=new FileSystemWatcher(root){IncludeSubdirectories=true,NotifyFilter=NotifyFilters.FileName|NotifyFilters.LastWrite|NotifyFilters.Size,InternalBufferSize=32*1024};created.Watcher=watcher;catalogue=created;
            watcher.Changed+=delegate(object sender,FileSystemEventArgs e){CatalogueChanged(created,e.FullPath);};watcher.Created+=delegate(object sender,FileSystemEventArgs e){CatalogueChanged(created,e.FullPath);};watcher.Deleted+=delegate(object sender,FileSystemEventArgs e){CatalogueChanged(created,e.FullPath);};watcher.Renamed+=delegate(object sender,RenamedEventArgs e){CatalogueChanged(created,e.OldFullPath);CatalogueChanged(created,e.FullPath);};watcher.Error+=delegate{lock(gate){if(catalogue==created)created.Dirty=true;}};watcher.EnableRaisingEvents=true;
        }
        var current=catalogue;if(current.MarksStamp!=DirectoryStamp("marks")||current.SnapshotsStamp!=DirectoryStamp("snapshots"))current.Dirty=true;
        if(current.Dirty){current.Building=true;try{var rebuilt=RebuildLibrary();current.State=new LibraryState{Marks=rebuilt.Marks,Snapshots=rebuilt.Snapshots.Select(SnapshotSummary).ToList()};current.Stamps.Clear();current.Orphans.Clear();current.Captures.Clear();foreach(var mark in current.State.Marks)current.Stamps[FileFor("marks",Text(mark,"id"))]=FileStamp(FileFor("marks",Text(mark,"id")));foreach(var snapshot in current.State.Snapshots)current.Stamps[FileFor("snapshots",Text(snapshot,"id"))]=FileStamp(FileFor("snapshots",Text(snapshot,"id")));current.MarksStamp=DirectoryStamp("marks");current.SnapshotsStamp=DirectoryStamp("snapshots");current.Dirty=false;}finally{current.Building=false;}}
        foreach(var orphan in current.Orphans.ToArray()){Write("marks",orphan.Key,orphan.Value);ProveRecoveredSnapshot(Read("snapshots",Text(orphan.Value,"initialSnapshotId")));}
        foreach(var capture in current.Captures.ToArray()){EnsureCaptureReceipt(capture.Value);ProveRecoveredSnapshot(Read("snapshots",capture.Key));current.Captures.Remove(capture.Key);}
        return current.State;
    }
    public static string Root {get{return TestRoot??Path.Combine(UserDataStore.Root,"StudyLibrary");}}
    static JavaScriptSerializer Json(){return new JavaScriptSerializer{MaxJsonLength=MaxCaptureJsonBytes};}
    static string Text(IDictionary<string,object> p,string key,string fallback=""){object value;return p!=null&&p.TryGetValue(key,out value)?Convert.ToString(value):fallback;}
    static Dictionary<string,object> Object(object value){return value as Dictionary<string,object>;}
    static IList Array(object value){return value as IList??new object[0];}
    static object Value(IDictionary<string,object> p,string key,object fallback=null){object value;return p!=null&&p.TryGetValue(key,out value)?value:fallback;}
    static bool Equivalent(object left,object right){
        if(left==null||right==null)return left==right;var a=Object(left);var b=Object(right);
        if(a!=null||b!=null)return a!=null&&b!=null&&a.Count==b.Count&&a.All(x=>b.ContainsKey(x.Key)&&Equivalent(x.Value,b[x.Key]));
        var xlist=left as IList;var ylist=right as IList;if(xlist!=null||ylist!=null){if(xlist==null||ylist==null||xlist.Count!=ylist.Count)return false;for(int i=0;i<xlist.Count;i++)if(!Equivalent(xlist[i],ylist[i]))return false;return true;}
        double leftNumber,rightNumber;if(Number(left,out leftNumber)&&Number(right,out rightNumber))return leftNumber==rightNumber;return left.Equals(right);
    }
    static string Id(string value){Guid id;if(!Guid.TryParseExact(value,"D",out id))throw new Exception("资料编号无效。");return id.ToString("D");}
    static string Folder(string name){var path=Path.Combine(Root,name);Directory.CreateDirectory(path);return path;}
    static string FileFor(string folder,string id){return Path.Combine(Folder(folder),Id(id)+".json");}
    sealed class UnsupportedSchema : Exception {public UnsupportedSchema():base("这份资料使用了当前程序不支持的版本；原文件和备份均已保留。"){}}
    static void Require(bool ok,string field){if(!ok)throw new Exception("资料结构无效："+field+"。");}
    static bool Number(object value,out double number){
        number=0;if(!(value is byte||value is short||value is int||value is long||value is float||value is double||value is decimal))return false;
        try{number=Convert.ToDouble(value,CultureInfo.InvariantCulture);return !double.IsNaN(number)&&!double.IsInfinity(number);}catch{return false;}
    }
    static long Integer(object value,string field){double n;Require(Number(value,out n)&&n>=0&&n<=long.MaxValue&&n==Math.Truncate(n),field);try{return Convert.ToInt64(value,CultureInfo.InvariantCulture);}catch{throw new Exception("资料结构无效："+field+"。");}}
    static void StringField(Dictionary<string,object> p,string field,bool nonempty){object value;Require(p!=null&&p.TryGetValue(field,out value)&&value is string&&(!nonempty||((string)value).Length!=0),field);}
    static IList ListField(Dictionary<string,object> p,string field){var list=Value(p,field) as IList;Require(list!=null,field);return list;}
    static void TimeField(Dictionary<string,object> p,string field){double n;Require(Number(Value(p,field),out n)&&n>=0,field);}
    static void Stamp(Dictionary<string,object> p,string field){StringField(p,field,true);DateTime time;Require(DateTime.TryParse(Text(p,field),CultureInfo.InvariantCulture,DateTimeStyles.RoundtripKind,out time),field);}
    static void Schema(Dictionary<string,object> p){Require(p!=null&&p.ContainsKey("schema"),"schema");long schema=Integer(p["schema"],"schema");if(schema!=1)throw new UnsupportedSchema();}
    static void Roi(object value){var r=Object(value);Require(r!=null,"roi");foreach(string key in new[]{"x","y","w","h"}){double n;Require(Number(Value(r,key),out n),"roi."+key);}double w,h;Number(Value(r,"w"),out w);Number(Value(r,"h"),out h);Require(w>0&&h>0,"roi size");}
    static void Layout(object value){
        var layout=Object(value);Schema(layout);var dimensions=ListField(layout,"dimensions");Require(dimensions.Count==2,"dimensions");foreach(var dimension in dimensions){double n;Require(Number(dimension,out n)&&n>0,"dimensions");}
        if(layout.ContainsKey("mediaIdentity"))Require(Regex.IsMatch(Text(layout,"mediaIdentity"),"^[a-f0-9]{64}$"),"media identity");
        var boards=ListField(layout,"boards");Require(boards.Count<=6,"boards");var ids=new HashSet<string>();foreach(var valueBoard in boards){var board=Object(valueBoard);StringField(board,"id",true);StringField(board,"name",false);Require(ids.Add(Text(board,"id")),"duplicate board id");Roi(Value(board,"roi"));if(board.ContainsKey("view"))Roi(Value(board,"view"));}
    }
    static void ContextCoverage(Dictionary<string,object> document,object layout,IList items){
        if(!document.ContainsKey("contextComplete")&&!document.ContainsKey("missingContext"))return;
        Require(Value(document,"contextComplete") is bool,"context complete");var missing=ListField(document,"missingContext");Require(missing.Count<=7,"missing context count");
        var expected=new Dictionary<string,string>{{"panorama","全景"}};foreach(var raw in ListField(Object(layout),"boards")){var board=Object(raw);expected["board:"+Text(board,"id")]=Text(board,"name");}
        var covered=new HashSet<string>();
        foreach(var raw in items){var item=Object(raw);if(Text(item,"kind")=="selection")continue;string key=Text(item,"kind")=="panorama"?"panorama":"board:"+Text(item,"boardId");Require(expected.ContainsKey(key)&&covered.Add(key),"context source");}
        foreach(var raw in missing){var item=Object(raw);string kind=Text(item,"kind"),key=kind=="panorama"?"panorama":"board:"+Text(item,"boardId");Require((kind=="panorama"||kind=="board")&&expected.ContainsKey(key)&&covered.Add(key)&&Text(item,"label")==expected[key],"missing context source");}
        Require(covered.Count==expected.Count&&(bool)document["contextComplete"]==(missing.Count==0),"context coverage");
    }
    static void Reference(object value){var reference=Object(value);Require(reference!=null,"reference");Id(Text(reference,"snapshotId"));StringField(reference,"itemId",true);if(Text(reference,"markId")!="")Id(Text(reference,"markId"));}
    static void ValidateMark(Dictionary<string,object> mark,string id){
        Schema(mark);Require(Id(Text(mark,"id"))==id,"mark identity");long number=Integer(Value(mark,"number"),"number");Require(number>0&&number<int.MaxValue,"number");
        foreach(string field in new[]{"title","note","lessonKey","sourcePage"})StringField(mark,field,field=="lessonKey");Require(Object(Value(mark,"course"))!=null,"course");TimeField(mark,"time");Stamp(mark,"createdAt");Id(Text(mark,"initialSnapshotId"));
    }
    static void ValidateQuestion(Dictionary<string,object> q,string id){
        Schema(q);Require(Id(Text(q,"id"))==id,"question identity");Require(Integer(Value(q,"revision"),"revision")>0,"revision");
        StringField(q,"text",false);StringField(q,"title",false);Require(Text(q,"text").Length<=100000,"text size");Require(new[]{"draft","pending","unknown","sent"}.Contains(Text(q,"status")),"status");
        var refs=ListField(q,"refs");Require(refs.Count<=300,"refs size");foreach(var reference in refs)Reference(reference);
        foreach(var value in ListField(q,"questions")){var part=Object(value);StringField(part,"id",true);StringField(part,"text",false);if(Text(Object(Value(part,"ref")),"snapshotId")!="")Reference(Value(part,"ref"));if(part.ContainsKey("refs")){var images=ListField(part,"refs");Require(images.Count<=300,"question part references");foreach(var image in images)Reference(image);}}
        foreach(string field in new[]{"contextKeys","markTitles"})if(q.ContainsKey(field))foreach(var item in ListField(q,field))Require(item is string,field);
        var manifest=Object(Value(q,"draftManifest"));if(manifest!=null&&manifest.ContainsKey("previousComposerTexts")){var previous=ListField(manifest,"previousComposerTexts");Require(previous.Count<=4,"composer history size");foreach(var text in previous)Require(text is string&&((string)text).Length<=100000,"composer history text");}
        if(manifest!=null&&manifest.ContainsKey("metadataEditedKeys")){var edited=ListField(manifest,"metadataEditedKeys");var keys=new HashSet<string>();Require(edited.Count<=4&&edited.Cast<object>().All(value=>value is string&&new[]{"school","course","teacher","notes"}.Contains((string)value)&&keys.Add((string)value)),"edited course metadata");}
        Stamp(q,"createdAt");Stamp(q,"updatedAt");
    }
    static void ValidateItem(Dictionary<string,object> item,string snapshotId,string markId,HashSet<string> ids,bool stored){
        StringField(item,"id",true);Require(ids.Add(Text(item,"id")),"duplicate item id");string kind=Text(item,"kind");Require(kind=="panorama"||kind=="board"||kind=="selection","item kind");StringField(item,"label",false);TimeField(item,"time");
        if(kind=="board"){StringField(item,"boardId",true);Roi(Value(item,"roi"));}else if(kind=="selection")Roi(Value(item,"roi"));
        if(stored){Require(Id(Text(item,"snapshotId"))==snapshotId&&Id(Text(item,"markId"))==markId,"item identity");AssetPath(Text(item,"asset"));}
    }
    static void ValidateDelivery(Dictionary<string,object> delivery,string id,string operation){
        Require(delivery!=null&&Integer(Value(delivery,"protocol"),"delivery protocol")==2&&Id(Text(delivery,"materialId"))==id&&Id(Text(delivery,"operationId"))==operation,"capture delivery identity");Id(Text(delivery,"attemptId"));var target=Object(Value(delivery,"target"));Require(target!=null,"delivery target");StringField(target,"conversationId",true);StringField(target,"route",true);Id(Text(target,"pageId"));foreach(string field in new[]{"documentEpoch","routeGeneration","composerGeneration"})Require(Integer(Value(target,field),field)>0,field);
        if(Text(delivery,"reconcileOnly")=="True")Require(Object(Value(delivery,"previousTarget"))!=null,"delivery previous target");Require(Encoding.UTF8.GetByteCount(Json().Serialize(delivery))<=16384,"delivery metadata size");
        if(delivery.ContainsKey("nativeDispatch")){var dispatch=Object(delivery["nativeDispatch"]);Id(Text(dispatch,"instance"));Require(Integer(Value(dispatch,"sequence"),"dispatch sequence")>0,"dispatch sequence");}
    }
    static void ValidateDocument(string folder,string id,Dictionary<string,object> document){
        if(folder=="media-proofs"){
            Schema(document);Require(Id(Text(document,"id"))==id&&Text(document,"kind")=="decoded-frame-v1","media proof identity");Reference(Value(document,"ref"));Require(Text(Object(Value(document,"ref")),"snapshotId")==id,"media proof snapshot");foreach(string field in new[]{"snapshotSha256","panoramaAsset","sourceFrameAsset"})Require(Regex.IsMatch(Text(document,field),"^[a-f0-9]{64}$"),"media proof digest");Stamp(document,"createdAt");TimeField(document,"originalTime");
            Uri source=null,decoded=null;Require(Uri.TryCreate(Text(document,"sourceUrl"),UriKind.Absolute,out source)&&Uri.TryCreate(Text(document,"decodedUrl"),UriKind.Absolute,out decoded),"media proof source");Require(source.Scheme=="https"&&source.Host=="vod.cmc.zju.edu.cn"&&source.IsDefaultPort&&source.UserInfo==""&&source.Query==""&&source.Fragment==""&&source.AbsolutePath.EndsWith(".mp4",StringComparison.OrdinalIgnoreCase),"media proof source URL");Require(decoded.Scheme=="https"&&decoded.Host=="resource.cmc.zju.edu.cn"&&decoded.IsDefaultPort&&decoded.UserInfo==""&&decoded.Query==""&&decoded.Fragment==""&&new[]{"/play/1/content/video","/play/2/content/video"}.Any(prefix=>decoded.AbsolutePath==prefix+source.AbsolutePath),"media proof mirror");
            var frame=Object(Value(document,"frame"));Require(Text(frame,"indexed")=="True"&&Integer(Value(frame,"video_tracks"),"media proof video tracks")==1,"media proof frame index");foreach(string field in new[]{"requested","time"})TimeField(frame,field);foreach(string field in new[]{"width","height"})Require(Integer(Value(frame,field),field)>0,"media proof dimensions");double requested=Convert.ToDouble(frame["requested"],CultureInfo.InvariantCulture),time=Convert.ToDouble(frame["time"],CultureInfo.InvariantCulture),next;Require(time<=requested+.000002&&requested-time<.5&&(Value(frame,"next_time")==null||Number(Value(frame,"next_time"),out next)&&next>requested),"media proof frame time");return;
        }
        if(folder=="selection-writes"){Schema(document);Require(Id(Text(document,"id"))==id&&Id(Text(document,"selectionId"))==SelectionId(Text(document,"scope")),"selection write identity");long revision=Integer(Value(document,"revision"),"selection write revision");Require(revision>0&&Integer(Value(document,"baseRevision"),"selection write base revision")==revision-1,"selection write revision");Require(Regex.IsMatch(Text(document,"choiceHash"),@"\A[a-f0-9]{64}\z"),"selection write contents");if(document.ContainsKey("choice")){ValidateSelectionChoice(Object(document["choice"]));Require(ValueDigest(document["choice"])==Text(document,"choiceHash"),"selection write choice");}Stamp(document,"createdAt");return;}
        if(folder=="selections"){Schema(document);Require(Id(Text(document,"id"))==id&&SelectionId(Text(document,"scope"))==id,"selection identity");Integer(Value(document,"revision"),"selection revision");Stamp(document,"updatedAt");Id(Text(document,"writeId"));ValidateSelectionChoice(Object(Value(document,"choice")));return;}
        if(folder=="plans"){
            Schema(document);Require(Id(Text(document,"id"))==id,"plan identity");Stamp(document,"createdAt");var pages=ListField(document,"items");Require(pages.Count<=20,"plan pages");var pageIds=new HashSet<string>();string origin=Id(Text(document,"sourceMaterialId",id));
            foreach(var page in pages){var item=Object(page);StringField(item,"id",true);Require(pageIds.Add(Text(item,"id")),"duplicate plan page");Require(Text(item,"kind")=="collection","plan page kind");StringField(item,"label",false);TimeField(item,"time");AttachmentPath(Text(item,"asset"),Text(item,"format"));if(item.ContainsKey("materialId"))Require(Id(Text(item,"materialId"))==id,"plan page material");if(item.ContainsKey("sourceMaterialId"))Require(Id(Text(item,"sourceMaterialId"))==origin,"plan page origin");}
            // Legacy pages can still be retrieved without a logical map. When
            // a map is present, validate it before accepting this revision so a
            // broken association can recover from the intact previous copy.
            if(document.ContainsKey("logicalItems")){var logical=PlanLogicalItems(document);foreach(var item in logical){var reference=ItemReference(item);string snapshot=Id(Text(item,"snapshotId")),mark=Id(Text(item,"markId"));ValidateItem(item,snapshot,mark,new HashSet<string>(),true);Require(Text(reference,"snapshotId")==snapshot&&Text(reference,"itemId")==Text(item,"id")&&Text(reference,"markId")==mark,"plan source identity");Require(pageIds.Contains(Text(item,"attachmentId")),"plan source page");if(item.ContainsKey("ask"))Require(item["ask"] is bool,"plan ask");}if(document.ContainsKey("restoreRefs"))NormalizeRestoreRefs(ListField(document,"restoreRefs"),logical);}
            return;
        }
        if(folder=="capture-meta"){Schema(document);Require(Id(Text(document,"id"))==id,"capture counter identity");Integer(Value(document,"nextOrder"),"nextOrder");Stamp(document,"updatedAt");return;}
        if(folder=="delivery-dispositions"){Schema(document);Require(Id(Text(document,"id"))==id&&new[]{"capture","plan"}.Contains(Text(document,"materialKind"))&&Text(document,"state")=="dismissed","delivery disposition identity");Id(Text(document,"operationId"));Stamp(document,"createdAt");return;}
        if(folder=="capture-deliveries"||folder=="capture-completed"||folder=="plan-deliveries"||folder=="plan-completed"){
            bool plan=folder.StartsWith("plan-",StringComparison.Ordinal),completed=folder.EndsWith("completed",StringComparison.Ordinal);
            Schema(document);Require(Id(Text(document,"id"))==id&&Id(Text(document,"snapshotId"))==id,"capture delivery identity");
            if(plan){Require(Text(document,"materialKind")=="plan","plan delivery kind");SelectionId(Text(document,"selectionScope"));Require(Regex.IsMatch(Text(document,"signature"),@"\A[a-f0-9]{64}\z"),"plan selection signature");Require(new[]{"new","current"}.Contains(Text(document,"planDestination")),"plan destination");Require(Object(Value(document,"choiceSnapshot"))!=null&&Encoding.UTF8.GetByteCount(Json().Serialize(document["choiceSnapshot"]))<=512*1024,"plan selection checkpoint");if(document.ContainsKey("plannedDelivery"))ValidateDelivery(Object(document["plannedDelivery"]),id,Id(Text(document,"operationId")));}
            else Id(Text(document,"markId"));
            StringField(document,"lessonKey",true);Require(Text(document,"state")==(completed?"completed":"ready"),"capture delivery state");Require(Text(document,"destination")=="direct","capture destination");Require(Integer(Value(document,"order"),"order")>0,"capture order");if(document.ContainsKey("sourceSequence"))Integer(document["sourceSequence"],"sourceSequence");Stamp(document,"createdAt");Stamp(document,"updatedAt");if(Value(document,"target")!=null)Require(Object(Value(document,"target"))!=null&&Encoding.UTF8.GetByteCount(Json().Serialize(document["target"]))<=4096,"capture target");if(document.ContainsKey("operationId"))Id(Text(document,"operationId"));if(document.ContainsKey("delivery"))ValidateDelivery(Object(document["delivery"]),id,Id(Text(document,"operationId")));
            if(document.ContainsKey("outcome")){string outcome=Text(document,"outcome");Require(completed&&CompletionEvidence(outcome)==Text(document,"completionEvidence")&&CompletionEvidence(outcome)!="","capture completion outcome");if(outcome=="removed"||outcome=="retained-draft"){var delivery=Object(Value(document,"delivery"));Require(Object(Value(document,"completedTarget"))!=null&&Equivalent(Value(document,"completedTarget"),Value(delivery,"target"))&&Text(document,"attemptId")==Text(delivery,"attemptId"),"capture completion identity");}if(outcome=="retained-draft")ValidateRetainedDraftProof(document);}return;
        }
        if(folder=="marks"){ValidateMark(document,id);return;}if(folder=="questions"){ValidateQuestion(document,id);return;}
        Require(folder=="snapshots","document kind");Schema(document);Require(Id(Text(document,"id"))==id,"snapshot identity");string markId=Id(Text(document,"markId"));ValidateMark(Object(Value(document,"markHeader")),markId);Require(Object(Value(document,"course"))!=null,"course");TimeField(document,"time");Stamp(document,"createdAt");Layout(Value(document,"layout"));
        var items=ListField(document,"items");bool pixelFree=items.Count==0&&Value(document,"markOnly") is bool&&(bool)document["markOnly"];Require(items.Count<=8&&(items.Count>=1||pixelFree),"items count");if(pixelFree)Require(Text(document,"contextComplete")=="False"&&document.ContainsKey("missingContext")&&!document.ContainsKey("captureIntent")&&!document.ContainsKey("contextFor"),"pixel-free mark");var ids=new HashSet<string>();foreach(var item in items)ValidateItem(Object(item),id,markId,ids,true);
        if(document.ContainsKey("contextFor")){Require(Id(Text(document,"contextFor"))!=id,"capture context parent");Require(Object(Value(document,"contextProof"))!=null,"capture frame proof");}
        ContextCoverage(document,Value(document,"layout"),items);
        if(document.ContainsKey("captureIntent")){var intent=Object(document["captureIntent"]);ValidateDocument("capture-deliveries",id,intent);Require(Text(intent,"state")=="ready"&&Text(intent,"markId")==markId&&Text(intent,"lessonKey")==Text(Object(document["markHeader"]),"lessonKey"),"snapshot capture intent");}
    }
    static Dictionary<string,object> ReadValid(string path,string folder,string id){var document=Json().Deserialize<Dictionary<string,object>>(File.ReadAllText(path,Encoding.UTF8));ValidateDocument(folder,id,document);return document;}
    static void DurableBytes(string path,byte[] bytes){using(var file=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.None)){file.Write(bytes,0,bytes.Length);file.Flush(true);}}
    static void RemoveTemp(string path){try{if(File.Exists(path))File.Delete(path);}catch{}}
    static void CommitBytes(string path,byte[] bytes,string backup){
        if(currentLease!=null)currentLease.Wrote=true;string temp=path+"."+Guid.NewGuid().ToString("N")+".tmp";
        try{DurableBytes(temp,bytes);if(File.Exists(path))File.Replace(temp,path,backup);else File.Move(temp,path);}finally{RemoveTemp(temp);}
    }
    static bool Exists(string folder,string id){string path=FileFor(folder,id);return File.Exists(path)||File.Exists(path+".bak");}
    static Dictionary<string,object> Read(string folder,string id){
        id=Id(id);string path=FileFor(folder,id);Exception failure=null;
        if(File.Exists(path)){try{var valid=ReadValid(path,folder,id);CatalogueDocument(folder,id,valid);return valid;}catch(UnsupportedSchema){throw;}catch(UnauthorizedAccessException){throw;}catch(IOException error){if(!(error is FileNotFoundException)&&!(error is DirectoryNotFoundException))throw;failure=error;}catch(Exception error){failure=error;}}
        if(File.Exists(path+".bak")){
            Dictionary<string,object> recovered=null;
            try{recovered=ReadValid(path+".bak",folder,id);}catch(UnsupportedSchema){throw;}catch(UnauthorizedAccessException){throw;}catch(IOException error){if(!(error is FileNotFoundException)&&!(error is DirectoryNotFoundException))throw;failure=error;}catch(Exception error){failure=error;}
            if(recovered!=null){
                // The bad primary is quarantined, not copied over the healthy .bak.
                string quarantine=File.Exists(path)?path+".corrupt-"+Guid.NewGuid().ToString("N"):null;
                CommitBytes(path,Encoding.UTF8.GetBytes(Json().Serialize(recovered)),quarantine);CatalogueDocument(folder,id,recovered);return recovered;
            }
        }
        // A file watcher can arrive after this read, and editing an existing
        // file need not change its directory timestamp. Mark recovery must use
        // the immutable snapshot headers even while the catalogue looks warm.
        if(folder=="marks"&&(catalogue==null||catalogue.Root!=Path.GetFullPath(Root)||!catalogue.Building)){
            if(catalogue!=null&&catalogue.Root==Path.GetFullPath(Root))catalogue.Dirty=true;
            CachedLibrary();
            if(File.Exists(path)){var recovered=ReadValid(path,folder,id);CatalogueDocument(folder,id,recovered);return recovered;}
        }
        if(failure!=null)throw new Exception("资料损坏且没有可用备份，原文件已保留："+Path.GetFileName(path),failure);
        throw new Exception("未找到这份已保存资料。");
    }
    static void Write(string folder,string id,object value){
        id=Id(id);var document=Object(value);ValidateDocument(folder,id,document);string path=FileFor(folder,id);
        if(Exists(folder,id))Read(folder,id); // Validate/repair before retaining the previous revision.
        CommitBytes(path,Encoding.UTF8.GetBytes(Json().Serialize(document)),path+".bak");
        CatalogueDocument(folder,id,document);
    }
    static List<Dictionary<string,object>> All(string folder,Func<string,bool> include=null){
        var list=new List<Dictionary<string,object>>();
        var ids=new HashSet<string>();string directory=Folder(folder);
        foreach(var path in Directory.GetFiles(directory,"*.json"))ids.Add(Id(Path.GetFileNameWithoutExtension(path)));
        foreach(var path in Directory.GetFiles(directory,"*.json.bak")){string name=Path.GetFileName(path);ids.Add(Id(name.Substring(0,name.Length-9)));}
        foreach(var id in ids){try{if(include==null||include(id))list.Add(Read(folder,id));}catch(UnsupportedSchema){throw;}catch(Exception error){throw new Exception("有一份资料暂时无法读取，原文件已保留："+id+".json",error);}}
        return list;
    }
    static string AssetPath(string digest){if(!Regex.IsMatch(digest??"",@"\A[a-f0-9]{64}\z"))throw new Exception("图片编号无效。");return Path.Combine(Folder("images"),digest+".png");}
    static string Digest(byte[] bytes){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();}
    static string SelectionId(string scope){Require(!String.IsNullOrWhiteSpace(scope)&&scope.Length<=2048,"selection scope");return Guid.ParseExact(Digest(Encoding.UTF8.GetBytes("selection:"+scope)).Substring(0,32),"N").ToString("D");}
    static string[] AdditionalQuestionParts(Dictionary<string,object> choice,IList parts){
        if(choice==null||!choice.ContainsKey("additionalItemIds"))return new string[0];var additional=ListField(choice,"additionalItemIds");Require(parts.Count==0&&additional.Count<=300&&(Text(choice,"retainSupplementaryText")!="True"||additional.Count==0),"additional question parts");var ids=new HashSet<string>();
        foreach(var value in additional)Require(value is string&&((string)value).Length>0&&((string)value).Length<=300&&ids.Add((string)value),"additional question part identity");return additional.Cast<string>().ToArray();
    }
    static bool RetainSupplementaryText(Dictionary<string,object> choice){
        if(choice==null||!choice.ContainsKey("retainSupplementaryText"))return false;Require(choice["retainSupplementaryText"] is bool,"supplementary question text");return (bool)choice["retainSupplementaryText"];
    }
    static void ValidateSelectionChoice(Dictionary<string,object> choice){
        Require(choice!=null&&Encoding.UTF8.GetByteCount(Json().Serialize(choice))<=512*1024,"selection size");
        var refs=ListField(choice,"refs");Require(refs.Count<=300,"selected references");var keys=new HashSet<string>();foreach(var value in refs)Require(keys.Add(ReferenceKey(Object(value))),"duplicate selected reference");
        foreach(var value in ListField(choice,"restoreRefs")){var reference=Object(value);Require(keys.Contains(ReferenceKey(reference)),"selected restore reference");RestoreIntent(reference);}
        var questions=ListField(choice,"questions");Require(questions.Count<=300,"selected questions");keys.Clear();
        foreach(var value in questions){var question=Object(value);Require(keys.Add(Id(Text(question,"questionId"))),"duplicate selected question");if(question.ContainsKey("sourceRevision"))Require(Integer(question["sourceRevision"],"selected question revision")>0,"selected question revision");if(question.ContainsKey("sourceUpdatedAt"))Stamp(question,"sourceUpdatedAt");var parts=ListField(question,"itemIds");Require(parts.Count<=300&&parts.Cast<object>().All(x=>x is string&&((string)x).Length>0&&((string)x).Length<=300),"selected question parts");RetainSupplementaryText(question);var additional=AdditionalQuestionParts(question,parts);RestoreIntent(question,"restoreIntentId","restoreIntentAt");var restored=new HashSet<string>();foreach(var raw in ListField(question,"restorePartIntents")){var intent=Object(raw);string part=Text(intent,"itemId");Require(parts.Cast<object>().Contains(part)||additional.Contains(part),"selected question intent");if(RestoreIntent(intent)!=null)restored.Add(part);}Require(additional.All(restored.Contains),"additional question restore intent");}
        Require(new[]{"new","current"}.Contains(Text(choice,"target"))&&Value(choice,"background") is bool&&Value(choice,"questionImages") is bool,"selection options");
    }
    static Dictionary<string,object> SelectionRecord(string scope,List<Dictionary<string,object>> proofs){
        string id=SelectionId(scope);Dictionary<string,object> record=null;Exception failure=null;
        if(Exists("selections",id)){try{record=Read("selections",id);}catch(UnsupportedSchema){throw;}catch(UnauthorizedAccessException){throw;}catch(IOException){throw;}catch(Exception error){failure=error;}}
        if(record!=null){var proof=RecordSelectionWrite(record);if(proof!=null&&!proofs.Any(value=>Text(value,"id")==Text(proof,"id")))proofs.Add(proof);}
        var writes=proofs.Where(proof=>Text(proof,"selectionId")==id&&Text(proof,"scope")==scope).OrderByDescending(proof=>Integer(Value(proof,"revision"),"selection write revision")).ToArray();
        var latest=writes.FirstOrDefault();long revision=record==null?0:Integer(Value(record,"revision"),"selection revision");
        if(latest!=null){
            long committed=Integer(Value(latest,"revision"),"selection write revision");
            Require(!writes.Any(proof=>Integer(Value(proof,"revision"),"selection write revision")==committed&&(Text(proof,"id")!=Text(latest,"id")||Text(proof,"choiceHash")!=Text(latest,"choiceHash"))),"conflicting selection writes");
            if(committed==revision)Require(Text(record,"writeId")==Text(latest,"id")&&ValueDigest(Value(record,"choice"))==Text(latest,"choiceHash"),"selection commit contents");
            if(committed>revision){
                // A previous selection backup cannot undo a later clear,
                // removal or reorder. The immutable receipt owns that choice.
                Require(latest.ContainsKey("choice"),"selection recovery choice unavailable");
                record=new Dictionary<string,object>{{"schema",1},{"id",id},{"scope",scope},{"revision",committed},{"writeId",Text(latest,"id")},{"choice",Value(latest,"choice")},{"updatedAt",Text(latest,"createdAt")}};
                ValidateDocument("selections",id,record);string path=FileFor("selections",id);
                CommitBytes(path,Encoding.UTF8.GetBytes(Json().Serialize(record)),File.Exists(path)?path+".recovered-"+Guid.NewGuid().ToString("N"):null);CatalogueDocument("selections",id,record);ProveRecoveredSelection(record);return record;
            }
        }
        if(failure!=null)throw failure;if(record!=null)ProveRecoveredSelection(record);return record;
    }
    static void ProveRecoveredSelection(Dictionary<string,object> record){
        // A successful read is not a save acknowledgement. Resolve only the
        // exact failed choice whose immutable receipt and primary were checked.
        string key="selection:"+Text(record,"id"),proof=Text(record,"writeId")+":"+ValueDigest(Value(record,"choice"));
        lock(pendingGate){WorkFailure failed;if(failures.TryGetValue(key,out failed)&&failed.SelectionProof==proof)failures.Remove(key);}
    }
    static Dictionary<string,object> Selection(string scope){
        scope=NormalizeLessonKey(scope);string id=SelectionId(scope);var proofs=All("selection-writes");var current=SelectionRecord(scope,proofs);if(current!=null)return current;
        var choice=new Dictionary<string,object>{{"refs",new object[0]},{"restoreRefs",new object[0]},{"questions",new object[0]},{"target","new"},{"background",true},{"questionImages",true}};
        if(scope.StartsWith("__zjf_layout_v1:",StringComparison.Ordinal)){
            // DOM video order is not a lecture identity. Keep every legacy file
            // and resume the latest explicit choice, including an empty clear.
            foreach(string legacyScope in proofs.Select(proof=>Text(proof,"scope")).Where(value=>value!=scope&&NormalizeLessonKey(value)==scope).Distinct().ToArray())SelectionRecord(legacyScope,proofs);
            var legacy=All("selections").Where(record=>Text(record,"scope")!=scope&&NormalizeLessonKey(Text(record,"scope"))==scope).Select(record=>SelectionRecord(Text(record,"scope"),proofs)).OrderByDescending(record=>Text(record,"updatedAt")).FirstOrDefault();if(legacy!=null)choice=new Dictionary<string,object>(Object(Value(legacy,"choice")));
        }
        return new Dictionary<string,object>{{"id",id},{"scope",scope},{"revision",0},{"choice",choice}};
    }
    static Dictionary<string,object> RecordSelectionWrite(Dictionary<string,object> record){
        long revision=Integer(Value(record,"revision"),"selection revision");if(revision==0)return null;string id=Id(Text(record,"writeId"));
        var proof=new Dictionary<string,object>{{"schema",1},{"id",id},{"selectionId",Text(record,"id")},{"scope",Text(record,"scope")},{"baseRevision",revision-1},{"revision",revision},{"choiceHash",ValueDigest(Value(record,"choice"))},{"createdAt",Text(record,"updatedAt")},{"choice",Value(record,"choice")}};
        if(Exists("selection-writes",id)){var old=Read("selection-writes",id);var comparable=new Dictionary<string,object>(proof);if(!old.ContainsKey("choice"))comparable.Remove("choice");Require(Equivalent(old,comparable),"selection write retry contents");if(!old.ContainsKey("choice"))Write("selection-writes",id,proof);}else Write("selection-writes",id,proof);
        string backup=FileFor("selection-writes",id)+".bak";Dictionary<string,object> priorBackup=null;
        if(File.Exists(backup)){try{priorBackup=ReadValid(backup,"selection-writes",id);}catch(UnsupportedSchema){throw;}catch(UnauthorizedAccessException){throw;}catch(IOException){throw;}catch{}}
        if(!Equivalent(priorBackup,proof)){if(priorBackup!=null){var comparable=new Dictionary<string,object>(proof);if(!priorBackup.ContainsKey("choice"))comparable.Remove("choice");Require(Equivalent(priorBackup,comparable),"selection write backup contents");}CommitBytes(backup,Encoding.UTF8.GetBytes(Json().Serialize(proof)),File.Exists(backup)?backup+".previous-"+Guid.NewGuid().ToString("N"):null);}
        return proof;
    }
    static object SaveSelection(Dictionary<string,object> request){
        string scope=NormalizeLessonKey(Text(request,"scope")),writeId=Id(Text(request,"writeId"));var previous=Selection(scope);long revision=Integer(Value(previous,"revision"),"selection revision");var choice=Object(Value(request,"choice"));ValidateSelectionChoice(choice);
        long baseRevision=Integer(Value(request,"baseRevision"),"selection revision");
        // Selection has protected the current revision before accepting a
        // replacement. A retry can still prove its original accepted choice.
        if(Exists("selection-writes",writeId)){var proof=Read("selection-writes",writeId);Require(Text(proof,"scope")==scope&&Text(proof,"selectionId")==Text(previous,"id")&&Integer(Value(proof,"baseRevision"),"selection write base revision")==baseRevision&&Text(proof,"choiceHash")==ValueDigest(choice),"selection retry contents");if(Text(previous,"writeId")==writeId)return previous;return new {conflict=true,accepted=true,record=previous};}
        if(baseRevision!=revision)return new {conflict=true,record=previous};
        var record=new Dictionary<string,object>{{"schema",1},{"id",Text(previous,"id")},{"scope",scope},{"revision",revision+1},{"writeId",writeId},{"choice",choice},{"updatedAt",DateTime.UtcNow.ToString("o")}};
        RecordSelectionWrite(record);Write("selections",Text(previous,"id"),record);return record;
    }
    static void ValidatePng(byte[] bytes){
        byte[] signature={137,80,78,71,13,10,26,10};Require(bytes.Length>=33&&bytes.Length<=MaxOriginalImageBytes&&bytes.Take(8).SequenceEqual(signature)&&bytes[8]==0&&bytes[9]==0&&bytes[10]==0&&bytes[11]==13&&bytes[12]==73&&bytes[13]==72&&bytes[14]==68&&bytes[15]==82,"PNG image");
        long width=((long)bytes[16]<<24)|((long)bytes[17]<<16)|((long)bytes[18]<<8)|bytes[19],height=((long)bytes[20]<<24)|((long)bytes[21]<<16)|((long)bytes[22]<<8)|bytes[23];ValidateImageDimensions(width,height);
        using(var memory=new MemoryStream(bytes))using(var image=Image.FromStream(memory,false,true)){Require(image.RawFormat.Guid==ImageFormat.Png.Guid&&image.Width==width&&image.Height==height,"PNG image dimensions");}
    }
    static void ValidateImageDimensions(long width,long height){Require(width>0&&height>0&&width<=MaxImageDimension&&height<=MaxImageDimension&&width*height<=MaxImagePixels,"image dimensions");}
    internal static void ValidateCaptureImageData(string data,bool allowJpeg,int maximum=12*1024*1024){
        if(data==null||data.Length>maximum||!Regex.IsMatch(data,@"\Adata:image/(png|jpeg);base64,[A-Za-z0-9+/]+=*\z"))throw new Exception("图片格式或大小不受支持。");
        bool png=data.StartsWith("data:image/png;base64,",StringComparison.Ordinal);if(!png&&!allowJpeg)throw new Exception("原始截图必须是 PNG 图片。");byte[] bytes=Convert.FromBase64String(data.Substring(png?22:23));
        if(png){ValidatePng(bytes);return;}using(var stream=new MemoryStream(bytes))using(var image=Image.FromStream(stream,false,true)){Require(image.RawFormat.Guid==ImageFormat.Jpeg.Guid,"JPEG image");ValidateImageDimensions(image.Width,image.Height);}
    }
    static byte[] AssetBytes(string digest){
        string path=AssetPath(digest);try{byte[] bytes=File.ReadAllBytes(path);Require(Digest(bytes)==digest,"image digest");ValidatePng(bytes);return bytes;}catch(Exception error){throw new Exception("已保存原图缺失或损坏，原文件已保留："+digest+".png",error);}
    }
    static void VerifySourceFrame(string panorama,string decoded){
        string stamp=FileStamp(AssetPath(panorama))+"|"+FileStamp(AssetPath(decoded)),key=panorama+"/"+decoded,known;if(verifiedSourceFrames.TryGetValue(key,out known)&&known==stamp)return;
        using(var aStream=new MemoryStream(AssetBytes(panorama)))using(var bStream=new MemoryStream(AssetBytes(decoded)))using(var aImage=new Bitmap(aStream))using(var bImage=new Bitmap(bStream)){
            Require(aImage.Width==bImage.Width&&aImage.Height==bImage.Height&&aImage.Width>=640&&aImage.Height>=360,"media proof full panorama");var rect=new Rectangle(0,0,aImage.Width,aImage.Height);
            using(var a=aImage.Clone(rect,PixelFormat.Format24bppRgb))using(var b=bImage.Clone(rect,PixelFormat.Format24bppRgb)){
                var left=a.LockBits(rect,ImageLockMode.ReadOnly,PixelFormat.Format24bppRgb);BitmapData right=null;
                long total=0,squares=0,large=0,green=0,greenSquares=0;int peak=0;var x=new byte[rect.Width*3];var y=new byte[x.Length];
                try{right=b.LockBits(rect,ImageLockMode.ReadOnly,PixelFormat.Format24bppRgb);for(int row=0;row<rect.Height;row++){System.Runtime.InteropServices.Marshal.Copy(IntPtr.Add(left.Scan0,row*left.Stride),x,0,x.Length);System.Runtime.InteropServices.Marshal.Copy(IntPtr.Add(right.Scan0,row*right.Stride),y,0,y.Length);for(int col=0;col<x.Length;col++){int delta=Math.Abs(x[col]-y[col]);total+=delta;squares+=(long)delta*delta;if(delta>16)large++;peak=Math.Max(peak,delta);if(col%3==1){green+=x[col];greenSquares+=(long)x[col]*x[col];}}}}finally{a.UnlockBits(left);if(right!=null)b.UnlockBits(right);}
                double pixels=(double)rect.Width*rect.Height,count=pixels*3,meanGreen=green/pixels;
                // Hardware and software YUV-to-RGB conversion differ slightly.
                // The bound admits that rounding, not a different picture or a
                // featureless black frame that could match unrelated videos.
                Require(total/count<=2&&Math.Sqrt(squares/count)<=3&&large/count<=.001&&peak<=64&&greenSquares/pixels-meanGreen*meanGreen>=100,"source frame differs from saved panorama");
            }
        }
        if(verifiedSourceFrames.Count>=256)verifiedSourceFrames.Clear();verifiedSourceFrames[key]=stamp;
    }
    static object VerifiedMediaProof(Dictionary<string,object> snapshot,Dictionary<string,object> proof){
        string id=Text(snapshot,"id");ValidateDocument("media-proofs",id,proof);Require(Digest(File.ReadAllBytes(FileFor("snapshots",id)))==Text(proof,"snapshotSha256"),"media proof original snapshot");var reference=Object(Value(proof,"ref"));var panorama=Array(Value(snapshot,"items")).Cast<object>().Select(Object).FirstOrDefault(x=>Text(x,"kind")=="panorama"&&Text(x,"id")==Text(reference,"itemId"));
        Require(panorama!=null&&Text(reference,"markId")==Text(snapshot,"markId")&&Text(panorama,"asset")==Text(proof,"panoramaAsset"),"media proof original panorama");var frame=Object(Value(proof,"frame"));var dimensions=Array(Value(Object(Value(snapshot,"layout")),"dimensions"));double originalTime=Convert.ToDouble(Value(snapshot,"time"),CultureInfo.InvariantCulture),frameTime=Convert.ToDouble(Value(frame,"time"),CultureInfo.InvariantCulture);Require(Equivalent(Value(proof,"originalTime"),Value(snapshot,"time"))&&Math.Abs(Convert.ToDouble(Value(frame,"requested"),CultureInfo.InvariantCulture)-originalTime)<.5&&Math.Abs(frameTime-originalTime)<.5&&Equivalent(Value(frame,"width"),dimensions[0])&&Equivalent(Value(frame,"height"),dimensions[1]),"media proof classroom frame");
        // Legacy captures sampled the player clock separately from its pixels.
        // Preserve that original clock; recovery uses the verified image's PTS.
        VerifySourceFrame(Text(proof,"panoramaAsset"),Text(proof,"sourceFrameAsset"));return new {schema=1,snapshotId=id,markId=Text(snapshot,"markId"),time=frameTime,identities=new[]{Text(proof,"sourceUrl"),Text(proof,"decodedUrl")}.Select(url=>Digest(Encoding.UTF8.GetBytes(new Uri(url).GetLeftPart(UriPartial.Path)))).ToArray()};
    }
    static object SaveMediaProof(Dictionary<string,object> p){
        var proof=Object(Value(p,"proof"));string id=Id(Text(proof,"id"));var snapshot=Read("snapshots",id);var verified=VerifiedMediaProof(snapshot,proof);Write("media-proofs",id,proof);return new {id=id,verified=true,mediaProof=verified};
    }
    static string SaveImage(string data,int maximum=MaxOriginalImageChars){
        if(data==null||!data.StartsWith("data:image/png;base64,",StringComparison.Ordinal)||data.Length>maximum)throw new Exception("图片格式或大小不受支持。");
        byte[] bytes=Convert.FromBase64String(data.Substring(22));ValidatePng(bytes);string hash=Digest(bytes),path=AssetPath(hash);
        if(File.Exists(path)){try{AssetBytes(hash);return hash;}catch{CommitBytes(path,bytes,path+".corrupt-"+Guid.NewGuid().ToString("N"));}}
        else CommitBytes(path,bytes,null);return hash;
    }
    static string ImageData(string digest){return "data:image/png;base64,"+Convert.ToBase64String(AssetBytes(digest));}
    internal static void ValidateCaptureAsset(string digest){AssetBytes(digest);}
    static string CaptureItemAsset(Dictionary<string,object> item){if(Text(item,"image")!="")return Digest(Convert.FromBase64String(Text(item,"image").Substring(22)));string digest=Text(item,"asset");AssetBytes(digest);return digest;}
    static object SaveCaptureAsset(Dictionary<string,object> request){string image=Text(request,"image");ValidateCaptureImageData(image,false,MaxOriginalImageChars);string expected=Text(request,"asset");Require(Digest(Convert.FromBase64String(image.Substring(22)))==expected,"capture asset digest");return new {asset=SaveImage(image,MaxOriginalImageChars)};}
    static string DeliveryImage(string digest){
        string original=ImageData(digest);if(original.Length<=12*1024*1024)return original;
        // Keep the full-resolution original PNG in the library. Only the
        // upload representation changes, with no resizing or omitted region.
        using(var memory=new MemoryStream(AssetBytes(digest)))using(var image=Image.FromStream(memory))using(var output=new MemoryStream())using(var parameters=new EncoderParameters(1)){
            parameters.Param[0]=new EncoderParameter(System.Drawing.Imaging.Encoder.Quality,100L);image.Save(output,ImageCodecInfo.GetImageEncoders().First(codec=>codec.FormatID==ImageFormat.Jpeg.Guid),parameters);
            string encoded="data:image/jpeg;base64,"+Convert.ToBase64String(output.ToArray());if(encoded.Length>12*1024*1024)throw new Exception("这张原图超过附图大小，原图已完整保存。请从原图圈选需要的部分。");return encoded;
        }
    }
    static string AttachmentPath(string digest,string format){
        if(format=="png")return AssetPath(digest);Require(format=="jpeg"&&Regex.IsMatch(digest??"",@"\A[a-f0-9]{64}\z"),"attachment identity");return Path.Combine(Folder("attachments"),digest+".jpg");
    }
    static byte[] AttachmentBytes(string digest,string format){
        if(format=="png")return AssetBytes(digest);byte[] bytes=File.ReadAllBytes(AttachmentPath(digest,format));Require(Digest(bytes)==digest,"attachment digest");using(var stream=new MemoryStream(bytes))using(var image=Image.FromStream(stream,false,true)){Require(image.RawFormat.Guid==ImageFormat.Jpeg.Guid,"JPEG attachment");ValidateImageDimensions(image.Width,image.Height);}return bytes;
    }
    internal static void SavePlanAttachments(Dictionary<string,object> plan){
        if(currentLease==null){using(var lease=AcceptLibraryWork("/library/plan-attachments",new Dictionary<string,object>{{"id",Text(plan,"id")}}))lease.Execute(delegate{SavePlanAttachments(plan);});return;}
        lock(gate){
            string id=Id(Text(plan,"id"));var raw=ListField(plan,"items");Require(raw.Count<=20,"plan pages");var images=new List<byte[]>();var pages=new List<Dictionary<string,object>>();long total=0;
            foreach(var value in raw){var source=Object(value);StringField(source,"id",true);string data=Text(source,"image");ValidateCaptureImageData(data,true);total+=data.Length;if(total>MaxComposeJsonBytes)throw new Exception("本次图册较大，请分组选取；原始资料已保留。");string format=data.StartsWith("data:image/png;base64,",StringComparison.Ordinal)?"png":"jpeg";byte[] bytes=Convert.FromBase64String(data.Substring(format=="png"?22:23));var item=new Dictionary<string,object>(source);item.Remove("image");item.Remove("thumbnail");item["asset"]=Digest(bytes);item["format"]=format;images.Add(bytes);pages.Add(item);}
            var stored=new Dictionary<string,object>{{"schema",1},{"id",id},{"items",pages},{"createdAt",DateTime.UtcNow.ToString("o")}};foreach(string field in new[]{"title","refs","carry","background","restoreRefs","sourceMaterialId","projection"})if(plan.ContainsKey(field))stored[field]=plan[field];
            if(plan.ContainsKey("logicalItems"))stored["logicalItems"]=Array(plan["logicalItems"]).Cast<object>().Select(value=>{var item=new Dictionary<string,object>(Object(value));item.Remove("image");item.Remove("thumbnail");return item;}).ToArray();ValidateDocument("plans",id,stored);
            bool exists=Exists("plans",id);if(exists){var previous=Read("plans",id);stored["createdAt"]=previous["createdAt"];if(!Equivalent(previous,stored))throw new Exception("同一份图册的内容已经变化，请重新选取；原图册已保留。");}
            for(int i=0;i<pages.Count;i++){var item=pages[i];string digest=Text(item,"asset"),format=Text(item,"format"),path=AttachmentPath(digest,format);bool healthy=false;if(File.Exists(path)){try{AttachmentBytes(digest,format);healthy=true;}catch{}}
                if(!healthy)CommitBytes(path,images[i],File.Exists(path)?path+".corrupt-"+Guid.NewGuid().ToString("N"):null);
            }
            if(!exists)Write("plans",id,stored);
        }
    }
    static string Thumbnail(string digest){
        using(var original=new MemoryStream(AssetBytes(digest)))using(var image=Image.FromStream(original)){double scale=Math.Min(180.0/image.Width,100.0/image.Height);
            using(var bmp=new Bitmap(Math.Max(1,(int)(image.Width*scale)),Math.Max(1,(int)(image.Height*scale))))using(var g=Graphics.FromImage(bmp))using(var stream=new MemoryStream()){
                g.DrawImage(image,0,0,bmp.Width,bmp.Height);bmp.Save(stream,ImageFormat.Jpeg);return "data:image/jpeg;base64,"+Convert.ToBase64String(stream.ToArray());
            }
        }
    }
    static string Clock(object time){double seconds;double.TryParse(Convert.ToString(time),out seconds);return TimeSpan.FromSeconds(Math.Max(0,seconds)).ToString(@"hh\:mm\:ss");}
    sealed class LibraryState {public List<Dictionary<string,object>> Marks,Snapshots;}
    static bool PixelFreeMark(Dictionary<string,object> request,Dictionary<string,object> batch){return Value(request,"markOnly") is bool&&(bool)request["markOnly"]&&batch!=null&&Value(batch,"context") is IList&&Array(batch["context"]).Count==0&&batch.ContainsKey("selection")&&batch["selection"]==null;}
    public static void ValidateSaveInput(Dictionary<string,object> p){
        var batch=Object(Value(p,"batch"));bool pixelFree=PixelFreeMark(p,batch);if(!pixelFree)WebViewChatWindows.ValidateCapture(batch,true);string snapshotId=Id(Text(batch,"id"));StringField(batch,"lessonKey",true);Require(Text(batch,"lessonKey").Length<=512,"lesson key");Require(Object(Value(batch,"course"))!=null,"course");TimeField(batch,"time");Layout(Value(p,"layout"));
        if(Text(p,"markId")!="")Id(Text(p,"markId"));foreach(string field in new[]{"title","note","sourcePage"})if(p.ContainsKey(field))StringField(p,field,false);
        var ids=new HashSet<string>();foreach(var itemValue in ListField(batch,"context")){var item=Object(itemValue);ValidateItem(item,snapshotId,"",ids,false);Require(Text(item,"kind")!="selection","context kind");CaptureItemAsset(item);}
        if(pixelFree)Require(Text(batch,"contextComplete")=="False"&&batch.ContainsKey("missingContext")&&!p.ContainsKey("contextFor"),"pixel-free mark");
        else{var selection=Object(Value(batch,"selection"));ValidateItem(selection,snapshotId,"",ids,false);Require(Text(selection,"kind")=="selection","selection kind");CaptureItemAsset(selection);}
        ContextCoverage(batch,Value(p,"layout"),ListField(batch,"context"));
        if(p.ContainsKey("retry")){var retry=Object(p["retry"]);Schema(retry);Require(Text(retry,"destination")=="direct"||Text(retry,"destination")=="later","retry destination");if(Value(retry,"target")!=null)Require(Object(Value(retry,"target"))!=null&&Encoding.UTF8.GetByteCount(Json().Serialize(retry["target"]))<=4096,"retry target");if(retry.ContainsKey("operationId"))Id(Text(retry,"operationId"));if(retry.ContainsKey("issuedAt"))Stamp(retry,"issuedAt");if(retry.ContainsKey("sequence"))Integer(retry["sequence"],"retry sequence");Require(Encoding.UTF8.GetByteCount(Json().Serialize(retry))<=8192,"retry metadata size");}
        if(p.ContainsKey("acquisition")){var acquisition=Object(p["acquisition"]);Require(acquisition!=null&&Regex.IsMatch(Text(acquisition,"source"),@"\A[a-f0-9]{64}\z")&&Text(acquisition,"source")==Text(Object(Value(p,"layout")),"mediaIdentity"),"capture source identity");TimeField(acquisition,"time");Require(new[]{"direct","later"}.Contains(Text(acquisition,"destination")),"capture source destination");if(acquisition.ContainsKey("contextId"))Id(Text(acquisition,"contextId"));if(acquisition.ContainsKey("contextOperationId"))Id(Text(acquisition,"contextOperationId"));}
        if(p.ContainsKey("contextFor"))ValidateContextSupplement(p);
    }
    const string CaptureCounterId="cd441fa5-11ea-44e4-8db8-32569604db8b";
    static string captureOrderRoot;
    static void ValidateContextSupplement(Dictionary<string,object> request){
        var original=Read("snapshots",Id(Text(request,"contextFor")));var acquisition=Object(Value(original,"acquisition"));var batch=Object(Value(request,"batch"));
        Require(acquisition!=null&&Id(Text(acquisition,"contextId"))==Id(Text(batch,"id"))&&Text(request,"markOnly")=="True"&&Text(request,"markId")==Text(original,"markId"),"capture context continuation");
        if(acquisition.ContainsKey("contextOperationId"))Require(Text(Object(Value(request,"retry")),"operationId")==Text(acquisition,"contextOperationId"),"capture context operation");
        Require(Text(batch,"contextComplete")=="True"&&Array(Value(batch,"missingContext")).Count==0&&Equivalent(Value(batch,"course"),Value(original,"course"))&&Equivalent(Value(request,"layout"),Value(original,"layout")),"capture context source");
        double before,after;Require(Number(Value(original,"time"),out before)&&Number(Value(batch,"time"),out after)&&Math.Abs(before-after)<=.000002,"capture context time");
        var selection=Array(Value(original,"items")).Cast<object>().Select(Object).FirstOrDefault(item=>Text(item,"kind")=="selection");Require(selection!=null&&CaptureItemAsset(Object(Value(batch,"selection")))==Text(selection,"asset")&&Equivalent(Value(Object(Value(batch,"selection")),"roi"),Value(selection,"roi")),"capture context selection");
        Require(Object(Value(request,"contextProof"))!=null,"capture frame proof");ValidateContextProof(original,Object(Value(request,"contextProof")));
    }
    static void ValidateContextProof(Dictionary<string,object> original,Dictionary<string,object> proof){
        Require(proof!=null,"capture frame proof");var acquisition=Object(Value(original,"acquisition"));double requested=0,time=0,clock=0,next=0;
        Require(acquisition!=null&&Text(acquisition,"source")==Text(Object(Value(original,"layout")),"mediaIdentity")&&Regex.IsMatch(Text(proof,"source"),@"\A[a-f0-9]{64}\z")&&Text(proof,"source")==Text(acquisition,"source")&&Number(Value(proof,"requested"),out requested)&&requested>=0&&Number(Value(acquisition,"time"),out clock)&&clock>=0&&Math.Abs(requested-clock)<=.000002&&Number(Value(proof,"time"),out time)&&time>=0,"capture frame proof");
        if(Text(acquisition,"exact")=="True")Require(Math.Abs(time-clock)<=.000002,"capture exact frame");
        else Require(Text(proof,"indexed")=="True"&&time<=clock+.000002&&(Value(proof,"nextTime")==null||Number(Value(proof,"nextTime"),out next)&&next>clock),"capture clock interval");
    }
    static void VerifyContextSupplement(Dictionary<string,object> original,Dictionary<string,object> supplement){
        var acquisition=Object(Value(original,"acquisition"));double before,after;
        Require(acquisition!=null&&Text(acquisition,"contextId")==Text(supplement,"id")&&Text(supplement,"contextFor")==Text(original,"id")&&Text(supplement,"markId")==Text(original,"markId")&&Text(supplement,"contextComplete")=="True"&&Array(Value(supplement,"missingContext")).Count==0&&Equivalent(Value(original,"course"),Value(supplement,"course"))&&Equivalent(Value(original,"layout"),Value(supplement,"layout"))&&Number(Value(original,"time"),out before)&&Number(Value(supplement,"time"),out after)&&Math.Abs(before-after)<=.000002,"saved context continuation");
        Require(Array(Value(supplement,"items")).Cast<object>().Select(Object).Any(item=>Text(item,"kind")=="panorama")&&!Array(Value(supplement,"items")).Cast<object>().Select(Object).Any(item=>Text(item,"kind")=="selection"),"saved context coverage");ValidateContextProof(original,Object(Value(supplement,"contextProof")));
        var intent=Object(Value(supplement,"captureIntent"));if(intent!=null&&Text(acquisition,"contextOperationId")!="")Require(Text(intent,"operationId")==Text(acquisition,"contextOperationId"),"saved context operation");
    }
    static Dictionary<string,object> ContextSupplement(Dictionary<string,object> original){
        string id=Text(Object(Value(original,"acquisition")),"contextId");if(id==""||!Exists("snapshots",id))return null;var supplement=Read("snapshots",Id(id));VerifyContextSupplement(original,supplement);return supplement;
    }
    static long captureOrderFloor;
    static long NextCaptureOrder(){
        string root=Path.GetFullPath(Root);
        if(captureOrderRoot!=root){
            // A recovered counter can be older than already archived captures.
            // Read their high-water mark once per library, then advance it with
            // every validated receipt and counter read or write.
            captureOrderFloor=ReadyCaptures(true).Concat(All("capture-completed")).Concat(ReadyPlans()).Concat(All("plan-completed")).Select(x=>Integer(Value(x,"order"),"order")).DefaultIfEmpty(0).Max();captureOrderRoot=root;
        }
        long order=Exists("capture-meta",CaptureCounterId)?Integer(Read("capture-meta",CaptureCounterId)["nextOrder"],"nextOrder"):0;
        long next=checked(Math.Max(order,captureOrderFloor)+1);Write("capture-meta",CaptureCounterId,new Dictionary<string,object>{{"schema",1},{"id",CaptureCounterId},{"nextOrder",next},{"updatedAt",DateTime.UtcNow.ToString("o")}});captureOrderFloor=next;return next;
    }
    static string DeliveryFolder(Dictionary<string,object> receipt,bool completed=false){return (Text(receipt,"materialKind")=="plan"?"plan-":"capture-")+(completed?"completed":"deliveries");}
    static void RecordDeliveryDisposition(Dictionary<string,object> receipt,string stamp){
        string id=Id(Text(receipt,"id")),operation=Id(Text(receipt,"operationId")),kind=Text(receipt,"materialKind")=="plan"?"plan":"capture";
        Dictionary<string,object> disposition;
        if(Exists("delivery-dispositions",id)){disposition=Read("delivery-dispositions",id);Require(Text(disposition,"operationId")==operation&&Text(disposition,"materialKind")==kind,"delivery disposition operation");}
        else{disposition=new Dictionary<string,object>{{"schema",1},{"id",id},{"operationId",operation},{"materialKind",kind},{"state","dismissed"},{"createdAt",stamp}};Write("delivery-dispositions",id,disposition);}
        // The first backup is the same terminal fact, never an older ready state.
        string backup=FileFor("delivery-dispositions",id)+".bak";if(!File.Exists(backup))CommitBytes(backup,Encoding.UTF8.GetBytes(Json().Serialize(disposition)),null);
    }
    static Dictionary<string,object> ApplyDeliveryDisposition(Dictionary<string,object> receipt){
        if(receipt==null)return null;string id=Id(Text(receipt,"id"));
        if(Exists("delivery-dispositions",id)){var disposition=Read("delivery-dispositions",id);Require(Text(disposition,"operationId")==Text(receipt,"operationId")&&Text(disposition,"materialKind")== (Text(receipt,"materialKind")=="plan"?"plan":"capture"),"delivery disposition operation");receipt["dismissed"]=true;receipt["dismissedAt"]=Text(disposition,"createdAt");}
        else if(Text(receipt,"dismissed")=="True")RecordDeliveryDisposition(receipt,Text(receipt,"dismissedAt",Text(receipt,"updatedAt")));
        return receipt;
    }
    static Dictionary<string,object> CaptureReceipt(string id){foreach(string folder in new[]{"capture-completed","plan-completed","capture-deliveries","plan-deliveries"})if(Exists(folder,id))return ApplyDeliveryDisposition(Read(folder,id));return null;}
    static List<Dictionary<string,object>> ReadyCaptures(bool includeDismissed=false){
        // Cleanup can leave an older ready file behind. Validate the terminal
        // authority before ignoring that obsolete file, even if it is damaged.
        return All("capture-deliveries",id=>{if(!Exists("capture-completed",id))return true;Read("capture-completed",id);return false;}).Select(ApplyDeliveryDisposition).Where(receipt=>includeDismissed||Text(receipt,"dismissed")!="True"&&!CaptureFamilyDismissed(Text(receipt,"id"))).ToList();
    }
    static List<Dictionary<string,object>> ReadyPlans(){return All("plan-deliveries",id=>{if(!Exists("plan-completed",id))return true;Read("plan-completed",id);return false;}).Select(ApplyDeliveryDisposition).ToList();}
    static bool CaptureFamilyDismissed(string id){
        var visited=new HashSet<string>();bool ancestor=false;while(id!=""){Require(visited.Add(id),"capture continuation cycle");var receipt=CaptureReceipt(id);if(Text(receipt,"dismissed")=="True"||ancestor&&Text(receipt,"state")=="completed")return true;if(receipt==null&&Exists("delivery-dispositions",id)){Read("delivery-dispositions",id);return true;}if(!Exists("snapshots",id))return false;var snapshot=Read("snapshots",id);string parent=Text(snapshot,"contextFor");if(parent=="")return false;VerifyContextSupplement(Read("snapshots",parent),snapshot);id=parent;ancestor=true;}return false;
    }
    static bool CaptureSuperseded(Dictionary<string,object> receipt){
        string successor=Text(receipt,"supersededBy");if(receipt==null||Text(receipt,"materialKind")=="plan"||successor=="")return false;
        VerifyContextSupplement(Read("snapshots",Text(receipt,"id")),Read("snapshots",Id(successor)));return true;
    }
    static void MarkCaptureDismissed(Dictionary<string,object> receipt,string stamp){if(receipt==null)return;RecordDeliveryDisposition(receipt,stamp);if(Text(receipt,"dismissed")=="True")return;receipt["dismissed"]=true;receipt["dismissedAt"]=stamp;receipt["updatedAt"]=stamp;Write(DeliveryFolder(receipt,Text(receipt,"state")=="completed"),Text(receipt,"id"),receipt);}
    static Dictionary<string,object> NewCaptureIntent(Dictionary<string,object> p,Dictionary<string,object> mark,string id){
        var retry=Object(Value(p,"retry"));if(retry==null||Text(retry,"destination")!="direct"||Text(p,"markOnly")=="True"&&Text(p,"contextFor")=="")return null;
        string now=DateTime.UtcNow.ToString("o");var intent=new Dictionary<string,object>{{"schema",1},{"id",id},{"snapshotId",id},{"markId",Text(mark,"id")},{"lessonKey",Text(mark,"lessonKey")},{"state","ready"},{"destination","direct"},{"target",Value(retry,"target")},{"operationId",retry.ContainsKey("operationId")?Id(Text(retry,"operationId")):Guid.NewGuid().ToString("D")},{"order",NextCaptureOrder()},{"createdAt",Text(retry,"issuedAt",now)},{"updatedAt",now}};if(retry.ContainsKey("sequence"))intent["sourceSequence"]=retry["sequence"];
        if(Text(p,"contextFor")!=""){var original=Read("snapshots",Text(p,"contextFor"));var prior=CaptureReceipt(Text(p,"contextFor"))??Object(Value(original,"captureIntent"));if(prior!=null){intent["order"]=prior["order"];intent["createdAt"]=prior["createdAt"];if(prior.ContainsKey("sourceSequence"))intent["sourceSequence"]=prior["sourceSequence"];}if(Text(prior,"state")=="completed"||CaptureFamilyDismissed(Text(p,"contextFor"))){intent["dismissed"]=true;intent["dismissedAt"]=now;}}
        return intent;
    }
    static Dictionary<string,object> EnsureCaptureReceipt(Dictionary<string,object> intent){
        if(intent==null)return null;string id=Text(intent,"id");var receipt=CaptureReceipt(id);if(receipt==null){receipt=ApplyDeliveryDisposition(new Dictionary<string,object>(intent));Write("capture-deliveries",id,receipt);}return StableCaptureReceipt(receipt);
    }
    static Dictionary<string,object> StableCaptureReceipt(Dictionary<string,object> receipt){if(receipt!=null&&Text(receipt,"operationId")==""){receipt["operationId"]=Guid.NewGuid().ToString("D");Write(DeliveryFolder(receipt,Text(receipt,"state")=="completed"),Text(receipt,"id"),receipt);}return receipt;}
    static void ProveRecoveredSnapshot(Dictionary<string,object> snapshot){
        string key="snapshot:"+Text(snapshot,"id");WorkFailure failed;lock(pendingGate){if(!failures.TryGetValue(key,out failed)||!failed.SnapshotCommitted)return;}
        Read("marks",Text(snapshot,"markId"));foreach(var item in Array(Value(snapshot,"items")))AssetBytes(Text(Object(item),"asset"));EnsureCaptureReceipt(Object(Value(snapshot,"captureIntent")));FinishContextSupplement(snapshot);
        lock(pendingGate){WorkFailure current;if(failures.TryGetValue(key,out current)&&object.ReferenceEquals(current,failed))failures.Remove(key);}
    }
    static void FinishContextSupplement(Dictionary<string,object> snapshot){
        if(Text(snapshot,"contextFor")=="")return;var original=Read("snapshots",Text(snapshot,"contextFor"));VerifyContextSupplement(original,snapshot);string id=Text(snapshot,"id");var prior=CaptureReceipt(Text(snapshot,"contextFor"));if(Text(prior,"state")=="completed"||CaptureFamilyDismissed(Text(snapshot,"contextFor")))MarkCaptureDismissed(CaptureReceipt(id),DateTime.UtcNow.ToString("o"));if(prior==null||Text(prior,"supersededBy")==id)return;
        prior["supersededBy"]=id;prior["updatedAt"]=DateTime.UtcNow.ToString("o");Write(DeliveryFolder(prior,Text(prior,"state")=="completed"),Text(prior,"id"),prior);
    }
    static object CaptureReply(Dictionary<string,object> p,Dictionary<string,object> mark,string id){
        var snapshot=Read("snapshots",id);var receipt=StableCaptureReceipt(CaptureReceipt(id));if(receipt==null)receipt=EnsureCaptureReceipt(Object(Value(snapshot,"captureIntent"))??NewCaptureIntent(p,mark,id));
        if(catalogue!=null)catalogue.Captures.Remove(id);ProveRecoveredSnapshot(snapshot);
        return new {mark=mark,snapshotId=id,contextKey=SnapshotContextKey(snapshot),assetBacked=Text(snapshot,"assetBacked")=="True",captureReceipt=receipt};
    }
    static object CaptureList(Dictionary<string,object> p){
        RecoverLibrary();
        string lesson=Text(p,"lessonKey");var jobs=new List<object>();foreach(var receipt in ReadyCaptures()){
            string id=Text(receipt,"id");if(lesson!=""&&NormalizeLessonKey(Text(receipt,"lessonKey"))!=NormalizeLessonKey(lesson))continue;
            if(CaptureSuperseded(receipt))continue;
            StableCaptureReceipt(receipt);var snapshot=Read("snapshots",id);var mark=Read("marks",Text(snapshot,"markId"));jobs.Add(new {id=id,snapshotId=id,markId=Text(mark,"id"),markTitle=Text(mark,"title"),lessonKey=Text(receipt,"lessonKey"),assetBacked=Text(snapshot,"assetBacked")=="True",target=Value(receipt,"target"),operationId=Text(receipt,"operationId"),delivery=Value(receipt,"delivery"),order=Value(receipt,"order"),sourceSequence=Value(receipt,"sourceSequence"),createdAt=Text(receipt,"createdAt"),state="ready"});
        }
        return new {schema=1,jobs=jobs.ToArray()};
    }
    internal static object CapturePayload(string id,bool lightweight=false){
        RecoverLibrary();
        var snapshot=Read("snapshots",id);lightweight=lightweight||Text(snapshot,"assetBacked")=="True";var mark=Read("marks",Text(snapshot,"markId"));var items=Array(Value(snapshot,"items")).Cast<object>().Select(x=>SnapshotItem(snapshot,Object(x))).ToArray();
        foreach(var item in items){item["image"]=lightweight?"":ImageData(Text(item,"asset"));item["markTitle"]=Text(mark,"title");item["ref"]=new Dictionary<string,object>{{"markId",Text(mark,"id")},{"snapshotId",id},{"itemId",Text(item,"id")}};}
        var selected=items.FirstOrDefault(x=>Text(x,"kind")=="selection");
        if(Text(snapshot,"contextFor")!=""){var original=Read("snapshots",Text(snapshot,"contextFor"));selected=SnapshotItem(original,Array(Value(original,"items")).Cast<object>().Select(Object).First(item=>Text(item,"kind")=="selection"));selected["image"]=lightweight?"":ImageData(Text(selected,"asset"));selected["ref"]=ItemReference(selected);selected.Remove("missingContext");}
        var batch=new Dictionary<string,object>{{"id",id},{"lessonKey",Text(mark,"lessonKey")},{"course",Value(snapshot,"course")},{"time",Value(snapshot,"time")},{"context",items.Where(x=>Text(x,"kind")!="selection").ToArray()},{"selection",selected},{"markId",Text(mark,"id")},{"markTitle",Text(mark,"title")},{"contextKey",SnapshotContextKey(snapshot)}};
        if(Text(snapshot,"contextFor")!="")batch["contextFor"]=Text(snapshot,"contextFor");
        if(snapshot.ContainsKey("missingContext")){batch["missingContext"]=snapshot["missingContext"];batch["contextComplete"]=snapshot["contextComplete"];}
        if(lightweight)batch["storedCapture"]=true;
        var result=new {mark=mark,snapshotId=id,batch=batch,layout=Value(snapshot,"layout"),acquisition=Value(snapshot,"acquisition"),sourcePage=Text(mark,"sourcePage"),captureReceipt=StableCaptureReceipt(CaptureReceipt(id))};
        if(Encoding.UTF8.GetByteCount(Json().Serialize(result))>MaxCaptureJsonBytes)throw new Exception("这份截图材料超过恢复上限，原始图片已保留。");return result;
    }
    static object SavePlanJob(Dictionary<string,object> request){
        var plan=Object(Value(request,"plan"));WebViewChatWindows.ValidatePlan(plan);SavePlanAttachments(plan);
        string id=Id(Text(plan,"id")),scope=Text(request,"scope"),operation=Id(Text(request,"operationId")),signature=Text(request,"signature"),destination=Text(request,"destination");SelectionId(scope);
        var choice=Object(Value(request,"choiceSnapshot"));Require(choice!=null&&Encoding.UTF8.GetByteCount(Json().Serialize(choice))<=512*1024,"plan choice snapshot");Require(Regex.IsMatch(signature,@"\A[a-f0-9]{64}\z")&&new[]{"new","current"}.Contains(destination),"plan choice identity");
        var previous=CaptureReceipt(id);if(previous!=null){Require(Text(previous,"materialKind")=="plan"&&Text(previous,"selectionScope")==scope&&Text(previous,"operationId")==operation&&Text(previous,"signature")==signature&&Text(previous,"planDestination")==destination&&Equivalent(Value(previous,"choiceSnapshot"),choice),"plan job retry");return previous;}
        string now=DateTime.UtcNow.ToString("o");var receipt=new Dictionary<string,object>{{"schema",1},{"id",id},{"snapshotId",id},{"materialKind","plan"},{"selectionScope",scope},{"lessonKey",NormalizeLessonKey(scope)},{"state","ready"},{"destination","direct"},{"planDestination",destination},{"signature",signature},{"choiceSnapshot",choice},{"operationId",operation},{"target",Value(request,"target")},{"logicalCount",Array(Value(plan,"logicalItems")).Count},{"order",NextCaptureOrder()},{"createdAt",now},{"updatedAt",now}};
        receipt=ApplyDeliveryDisposition(receipt);Write("plan-deliveries",id,receipt);return receipt;
    }
    static object PlanJobs(string scope){
        SelectionId(scope);var completed=All("plan-completed").Select(ApplyDeliveryDisposition).Where(record=>Text(record,"selectionScope")==scope&&Text(record,"choiceConsumed")!="True"&&Text(record,"dismissed")!="True").ToList();
        var pendingJobs=ReadyPlans().Where(record=>Text(record,"selectionScope")==scope&&Text(record,"dismissed")!="True");
        return new {schema=1,jobs=pendingJobs.Concat(completed).OrderBy(record=>Integer(Value(record,"order"),"order")).ToArray()};
    }
    static object PlanPayload(string id){
        var stored=Read("plans",id);var plan=new Dictionary<string,object>(stored);var pages=new List<Dictionary<string,object>>();
        foreach(var value in Array(Value(stored,"items"))){var item=new Dictionary<string,object>(Object(value));string format=Text(item,"format");item["image"]="data:image/"+format+";base64,"+Convert.ToBase64String(AttachmentBytes(Text(item,"asset"),format));pages.Add(item);}plan["items"]=pages.ToArray();CheckPlanResponseBudget(plan);return new {plan=plan,captureReceipt=CaptureReceipt(id)};
    }
    static object CheckpointDelivery(Dictionary<string,object> request,bool plan){
        string id=Id(Text(request,"id"));var receipt=CaptureReceipt(id);Require(receipt!=null&&(Text(receipt,"materialKind")=="plan")==plan,"material delivery checkpoint");var delivery=Object(Value(request,"delivery"));ValidateDelivery(delivery,id,Id(Text(receipt,"operationId")));
        if(Text(receipt,"dismissed")=="True"||!plan&&CaptureFamilyDismissed(id))throw new CaptureProtocolException("capture_dismissed","原附图任务已结束，原图仍保留在学习记录中。");
        if(CaptureSuperseded(receipt))throw new CaptureProtocolException("capture_superseded","这次截图的完整背景已保存，原待办已由完整材料接续。");
        var prior=Object(Value(Object(Value(receipt,"delivery")),"target"))??Object(Value(Object(Value(receipt,"plannedDelivery")),"target"))??Object(Value(receipt,"target"));var next=Object(Value(delivery,"target"));string source=Text(prior,"conversationId");
        if(source!=""&&source!=Text(next,"conversationId")&&!(source.StartsWith("provisional:",StringComparison.Ordinal)&&Text(delivery,"reconcileOnly")=="True"&&Equivalent(Value(delivery,"previousTarget"),prior)))throw new CaptureProtocolException("conversation_changed","原材料属于另一段对话，请回到原对话继续或重新选取。");
        string draftId=Text(request,"draftId");if(draftId!=""){Id(draftId);if(Text(delivery,"reconcileOnly")!="True"){var savedTarget=Object(Value(receipt,"target"));if(savedTarget!=null&&Text(savedTarget,"draftId")!=""&&Text(savedTarget,"draftId")!=draftId)throw new CaptureProtocolException("conversation_changed","原问题已经结束，材料仍保留。");if(Text(savedTarget,"draftId")==""&&(Value(receipt,"delivery")!=null||Value(receipt,"plannedDelivery")!=null))throw new CaptureProtocolException("conversation_changed","原附图任务的问题身份尚未核定，原图已保留；请从学习记录重新选取。");if(savedTarget==null){savedTarget=new Dictionary<string,object>(next);receipt["target"]=savedTarget;}if(Text(savedTarget,"draftId")=="")savedTarget["draftId"]=draftId;}}
        receipt["plannedDelivery"]=delivery;if(Value(receipt,"target")==null)receipt["target"]=next;receipt["updatedAt"]=DateTime.UtcNow.ToString("o");Write(DeliveryFolder(receipt,Text(receipt,"state")=="completed"),id,receipt);return receipt;
    }
    static object RetirePlanJob(Dictionary<string,object> request,bool dismiss){
        string id=Id(Text(request,"id")),scope=Text(request,"scope"),operation=Id(Text(request,"operationId"));SelectionId(scope);var receipt=CaptureReceipt(id);
        if(dismiss&&receipt==null){
            // A previously accepted plan save can still be waiting for its
            // turn. End its identity before that save can create a ready job.
            RecordDeliveryDisposition(new Dictionary<string,object>{{"id",id},{"operationId",operation},{"materialKind","plan"}},DateTime.UtcNow.ToString("o"));return new {retired=true,id=id};
        }
        Require(receipt!=null&&Text(receipt,"materialKind")=="plan"&&Text(receipt,"selectionScope")==scope&&Text(receipt,"operationId")==operation,"plan choice completion");
        bool completed=Text(receipt,"state")=="completed";Require(dismiss||completed,"unconfirmed plan completion");if(dismiss)MarkCaptureDismissed(receipt,DateTime.UtcNow.ToString("o"));else{receipt["choiceConsumed"]=true;receipt["updatedAt"]=DateTime.UtcNow.ToString("o");Write(DeliveryFolder(receipt,completed),id,receipt);}return new {retired=true,id=id};
    }
    static object DismissCapture(Dictionary<string,object> request){
        string id=Id(Text(request,"id")),operation=Id(Text(request,"operationId"));Read("snapshots",id);var receipt=CaptureReceipt(id);
        Require(receipt!=null&&Text(receipt,"materialKind")!="plan"&&Text(receipt,"operationId")==operation,"capture disposition identity");
        string stamp=DateTime.UtcNow.ToString("o");MarkCaptureDismissed(receipt,stamp);var snapshot=Read("snapshots",id);string root=Text(snapshot,"contextFor");if(root!=""){VerifyContextSupplement(Read("snapshots",root),snapshot);MarkCaptureDismissed(CaptureReceipt(root),stamp);snapshot=Read("snapshots",root);}var supplement=ContextSupplement(snapshot);if(supplement!=null)MarkCaptureDismissed(CaptureReceipt(Text(supplement,"id")),stamp);return new {id=id,operationId=operation,dismissed=true};
    }
    static void ValidateRetainedDraftProof(Dictionary<string,object> receipt){
        var proof=Object(Value(receipt,"retainedDraftProof"));Schema(proof);Id(Text(proof,"questionId"));Require(Text(receipt,"retainedQuestionId")==Text(proof,"questionId")&&Integer(Value(proof,"revision"),"retained question revision")>0,"retained question identity");Stamp(proof,"updatedAt");Require(Regex.IsMatch(Text(proof,"questionHash"),"^[a-f0-9]{64}$"),"retained question digest");
        Require(Text(proof,"materialId")==Text(receipt,"id")&&Text(proof,"operationId")==Text(receipt,"operationId")&&Text(proof,"attemptId")==Text(receipt,"attemptId")&&Equivalent(Value(proof,"target"),Value(receipt,"completedTarget")),"retained delivery identity");
        var sources=ListField(proof,"sources");Require(sources.Count>0&&sources.Count<=8,"retained sources");var keys=new HashSet<string>();foreach(var value in sources){var source=Object(value);var reference=Object(Value(source,"ref"));Require(keys.Add(ReferenceKey(reference))&&Text(reference,"snapshotId")==Text(receipt,"id")&&Text(reference,"markId")==Text(receipt,"markId"),"retained source identity");AssetPath(Text(source,"asset"));StringField(source,"fileName",true);}
    }
    static Dictionary<string,object> RetainedCaptureDraft(Dictionary<string,object> receipt){
        // A saved ready manifest proves an earlier composer state, not a sent
        // message or the contents of the currently open composer. Keep that
        // distinction when retiring an obsolete retry after a lost receipt.
        var delivery=Object(Value(receipt,"delivery"));var target=Object(Value(delivery,"target"));string id=Text(receipt,"id"),operation=Text(receipt,"operationId");
        if(delivery==null||target==null||Text(receipt,"materialKind")=="plan"||!Equivalent(Value(receipt,"target"),target))return null;
        var snapshot=Read("snapshots",id);if(Text(snapshot,"contextFor")!=""||ContextSupplement(snapshot)!=null)return null;
        var items=Array(Value(snapshot,"items")).Cast<object>().Select(Object).ToArray();string lesson=NormalizeLessonKey(Text(receipt,"lessonKey"));
        string stamp=Text(target,"conversationId")+":"+Text(target,"pageId")+":"+Text(target,"documentEpoch")+":"+Text(target,"routeGeneration")+":"+Text(target,"composerGeneration");
        Dictionary<string,object> result=null;
        foreach(var summary in CachedQuestions().Where(q=>Text(q,"status")=="draft"&&Text(q,"hasDraftManifest")=="True"&&Text(q,"conversationId")==Text(target,"conversationId")&&Text(q,"lessonKey")==lesson)){
            var question=Read("questions",Text(summary,"id"));var manifest=Object(Value(question,"draftManifest"));var draft=Object(Value(manifest,"draft"));
            if(Text(question,"status")!="draft"||Text(manifest,"version")!="1"||Text(manifest,"ready")!="True"||Text(draft,"id")!=Text(question,"id")||Text(manifest,"conversationId")!=Text(target,"conversationId")||!Equivalent(Value(manifest,"boundTarget"),target)||draft.ContainsKey("logicalItems"))continue;
            if(Text(target,"draftId")!=""&&Text(target,"draftId")!=Text(question,"id")||NormalizeLessonKey(Text(draft,"lessonKey"))!=lesson||DateTime.Parse(Text(question,"updatedAt"),CultureInfo.InvariantCulture,DateTimeStyles.RoundtripKind).ToUniversalTime()<DateTime.Parse(Text(receipt,"updatedAt"),CultureInfo.InvariantCulture,DateTimeStyles.RoundtripKind).ToUniversalTime())continue;
            var operations=Array(Value(manifest,"operationItems")).Cast<object>().Select(Object).Where(x=>Text(x,"operationId")==operation).ToArray();
            if(operations.Length!=1||Text(operations[0],"materialId")!=id)continue;
            var operationItems=new HashSet<string>(Array(Value(operations[0],"itemIds")).Cast<object>().OfType<string>());if(!items.Where(x=>Text(x,"kind")=="selection").All(x=>operationItems.Contains(Text(x,"id"))))continue;
            var refs=Array(Value(question,"refs")).Cast<object>().Select(Object).ToArray();var active=Array(Value(draft,"items")).Cast<object>().Select(Object).ToArray();var files=Object(Value(manifest,"files"));var order=Text(manifest,"attachmentOrder").Split(new[]{'\n'},StringSplitOptions.RemoveEmptyEntries);var sources=new List<object>();var names=new HashSet<string>();
            foreach(var item in items){
                var reference=ItemReference(item);var matches=active.Where(x=>Equivalent(Value(x,"ref"),reference)).ToArray();if(matches.Length!=1||!refs.Any(x=>Equivalent(x,reference)))break;var saved=matches[0];
                if(new[]{"id","snapshotId","markId","kind","boardId","roi","time","sourceBoardIds"}.Any(field=>!Equivalent(Value(saved,field),Value(item,field)))||Text(saved,"__uploadRequested")!="True"||Text(saved,"__targetStamp")!=stamp)break;
                string file=Text(files,Text(item,"id")),token=Text(saved,"__fileToken");Guid parsed;if(!Guid.TryParseExact(token,"D",out parsed)||!file.StartsWith("zjf-"+Text(item,"id")+"-"+token+"-",StringComparison.Ordinal)||!file.EndsWith(".png",StringComparison.Ordinal)||order.Count(x=>x.TrimEnd('\r')==file)!=1||!names.Add(file))break;
                AssetBytes(Text(item,"asset"));sources.Add(new Dictionary<string,object>{{"ref",reference},{"asset",Text(item,"asset")},{"fileName",file}});
            }
            if(sources.Count!=items.Length)continue;if(result!=null)throw new Exception("这次附图对应多份原草稿，请从学习记录查看；原图和待办均已保留。");
            result=new Dictionary<string,object>{{"schema",1},{"questionId",Text(question,"id")},{"revision",Value(question,"revision")},{"updatedAt",Text(question,"updatedAt")},{"questionHash",ValueDigest(question)},{"materialId",id},{"operationId",operation},{"attemptId",Text(delivery,"attemptId")},{"target",target},{"sources",sources}};
        }
        return result;
    }
    static object ReconcileCapture(Dictionary<string,object> request){
        string id=Id(Text(request,"id")),operation=Id(Text(request,"operationId"));var receipt=CaptureReceipt(id);Require(receipt!=null&&Text(receipt,"operationId")==operation,"capture history identity");
        if(Text(receipt,"state")=="completed")return new {id=id,operationId=operation,completed=true,outcome=Text(receipt,"outcome"),questionId=Text(receipt,"retainedQuestionId")};
        if(Text(receipt,"dismissed")=="True")return new {id=id,operationId=operation,dismissed=true};
        var target=Object(Value(Object(Value(receipt,"delivery")),"target"))??Object(Value(Object(Value(receipt,"plannedDelivery")),"target"))??Object(Value(receipt,"target"));
        var proof=ConfirmedDelivery("https://chatgpt.com"+Text(target,"route"),operation,id);string outcome="already-sent",questionId="";
        if(proof!=null){receipt["confirmedSendProof"]=proof;receipt["completedTarget"]=Value(proof,"target");}
        else{proof=RetainedCaptureDraft(receipt);if(proof==null)return new {id=id,operationId=operation,completed=false};outcome="retained-draft";questionId=Text(proof,"questionId");receipt["retainedQuestionId"]=questionId;receipt["retainedDraftProof"]=proof;receipt["completedTarget"]=Value(proof,"target");receipt["attemptId"]=Text(proof,"attemptId");}
        receipt["state"]="completed";receipt["outcome"]=outcome;receipt["completionEvidence"]=CompletionEvidence(outcome);receipt["updatedAt"]=DateTime.UtcNow.ToString("o");Write(DeliveryFolder(receipt,true),id,receipt);
        return new {id=id,operationId=operation,completed=true,outcome=outcome,questionId=questionId};
    }
    internal static void RequireDeliveryQuestion(Dictionary<string,object> receipt,string draftId){
        string current=Id(draftId);if(receipt==null||Text(Object(Value(receipt,"target")),"draftId")!=current)throw new CaptureProtocolException("conversation_changed","原附图任务未绑定当前提问，原图已保留；请从学习记录重新选取。");
    }
    internal static bool DispatchCaptureIfActive(string id,string operation,string draftId,Action dispatch){
        lock(gate){var receipt=CaptureReceipt(Id(id));if(receipt==null&&Exists("delivery-dispositions",id)){Read("delivery-dispositions",id);return false;}if(receipt!=null&&(Text(receipt,"operationId")!=Id(operation)||Text(receipt,"dismissed")=="True"||Text(receipt,"materialKind")!="plan"&&CaptureFamilyDismissed(id)||CaptureSuperseded(receipt)))return false;RequireDeliveryQuestion(receipt,draftId);dispatch();return true;}
    }
    internal static Dictionary<string,object> SaveCaptureDelivery(string materialId,Dictionary<string,object> delivery){
        if(currentLease==null){using(var lease=AcceptLibraryWork("/library/capture-delivery",new Dictionary<string,object>{{"id",materialId}}))return lease.Execute(delegate{return SaveCaptureDelivery(materialId,delivery);});}
        lock(gate){
            string id=Id(materialId);RecoverLibrary();var receipt=StableCaptureReceipt(CaptureReceipt(id));
            if(receipt==null){if(!Exists("snapshots",id))return null;string supplied=Id(Text(delivery,"operationId"));ValidateDelivery(delivery,id,supplied);var snapshot=Read("snapshots",id);var mark=Read("marks",Text(snapshot,"markId"));var request=new Dictionary<string,object>{{"retry",new Dictionary<string,object>{{"schema",1},{"destination","direct"},{"target",Value(delivery,"target")},{"operationId",supplied}}}};receipt=EnsureCaptureReceipt(NewCaptureIntent(request,mark,id));}
            string operation=Text(receipt,"operationId");ValidateDelivery(delivery,id,operation);
            if(Text(receipt,"dismissed")=="True"||Text(receipt,"materialKind")!="plan"&&CaptureFamilyDismissed(id))throw new CaptureProtocolException("capture_dismissed","这张图已留在学习记录中，原附图任务已结束。可重新选取用于新的提问。");
            if(CaptureSuperseded(receipt))throw new CaptureProtocolException("capture_superseded","这次截图的完整背景已保存，原待办已由完整材料接续。");
            if(Text(receipt,"state")=="completed"&&Text(receipt,"outcome")=="retained-draft")throw new CaptureProtocolException("capture_retained","这张图已保存在原草稿中，请从学习记录继续原提问。");
            if(Text(receipt,"state")=="completed"&&Text(receipt,"outcome")=="removed"){
                if(!CompatibleRemovedTarget(receipt,Object(Value(delivery,"target"))))throw new Exception("这份截图已在原对话中移除，请从资料中重新选择；原始记录已保留。");
                // Keep the first durable removal proof. The bridge turns this
                // disposition into a fresh identity-bound receipt without upload.
                var completed=Json().Deserialize<Dictionary<string,object>>(Json().Serialize(delivery));completed["completedOutcome"]="removed";completed["completionEvidence"]="composer-removal";return completed;
            }
            var previous=Object(Value(receipt,"delivery"));var priorDispatch=Object(Value(previous,"nativeDispatch"));var nextDispatch=Object(Value(delivery,"nativeDispatch"));
            if(priorDispatch!=null){if(nextDispatch==null)throw new Exception("附图重试缺少本地顺序信息，请更新观看器后重试。");if(Text(priorDispatch,"instance")==Text(nextDispatch,"instance")){long before=Integer(Value(priorDispatch,"sequence"),"dispatch sequence"),next=Integer(Value(nextDispatch,"sequence"),"dispatch sequence");if(next<before)return Json().Deserialize<Dictionary<string,object>>(Json().Serialize(previous));if(next==before&&!Equivalent(previous,delivery))throw new Exception("同一次附图重试的内容不一致，原记录已保留。");}}
            var original=Object(Value(previous,"previousTarget"))??Object(Value(previous,"target"))??Object(Value(receipt,"target"));var target=Object(delivery["target"]);string source=Text(original,"conversationId"),destination=Text(target,"conversationId");
            if(source!=""&&source!=destination){
                var prior=Object(Value(delivery,"previousTarget"));if(!source.StartsWith("provisional:",StringComparison.Ordinal)||!destination.StartsWith("c:",StringComparison.Ordinal)||Text(delivery,"reconcileOnly")!="True"||!Equivalent(prior,original))throw new Exception("这份材料的投递目标已经固定，请回到原对话重试或从资料中重新选择。");
                string priorDestination=Text(Object(Value(previous,"target")),"conversationId");if(priorDestination.StartsWith("c:",StringComparison.Ordinal)&&priorDestination!=destination)throw new Exception("这份材料不能改投另一段对话，原记录已保留。");
            }else if(Text(previous,"reconcileOnly")=="True"&&Text(delivery,"reconcileOnly")!="True")throw new Exception("这次重试只能核对已发送记录，不能重新附图。");
            var copy=Json().Deserialize<Dictionary<string,object>>(Json().Serialize(delivery));if(Equivalent(previous,copy))return copy;receipt["delivery"]=copy;if(Value(receipt,"target")==null)receipt["target"]=Value(copy,"target");receipt["updatedAt"]=DateTime.UtcNow.ToString("o");Write(DeliveryFolder(receipt,Text(receipt,"state")=="completed"),id,receipt);return copy;
        }
    }
    public static object AcknowledgeCapture(Dictionary<string,object> p,bool verified){
        if(currentLease==null){using(var lease=AcceptLibraryWork("/library/capture-ack",p))return lease.Execute(delegate{return AcknowledgeCapture(p,verified);});}
        lock(gate)return CompleteCapture(p,verified);
    }
    static string CompletionEvidence(string outcome){return outcome=="attached"?"composer":outcome=="already-sent"?"confirmed-message":outcome=="removed"?"composer-removal":outcome=="retained-draft"?"saved-draft":"";}
    static bool CompatibleRemovedTarget(Dictionary<string,object> receipt,Dictionary<string,object> target){
        var original=Object(Value(receipt,"completedTarget"));if(original==null||target==null)return false;string source=Text(original,"conversationId"),canonical=CanonicalConversation("https://chatgpt.com"+Text(original,"route"));
        if(canonical!="")return source=="c:"+canonical&&Text(target,"conversationId")==source&&CanonicalConversation("https://chatgpt.com"+Text(target,"route"))==canonical;
        return source.StartsWith("provisional:",StringComparison.Ordinal)&&Text(target,"conversationId")==source&&Text(target,"route")==Text(original,"route")&&Text(target,"pageId")==Text(original,"pageId")&&Equivalent(Value(target,"documentEpoch"),Value(original,"documentEpoch"));
    }
    static object CompleteCapture(Dictionary<string,object> p,bool verified){
        RecoverLibrary();
        string id=Id(Text(p,"id"));var receipt=CaptureReceipt(id);if(receipt==null)throw new Exception("未找到这份待附图资料。");if(Text(receipt,"operationId")!=Text(p,"operationId"))throw new Exception("附图确认的操作编号不匹配，材料已保留。");if(Text(receipt,"state")=="completed"){if(Text(receipt,"outcome")=="removed"&&!CompatibleRemovedTarget(receipt,Object(Value(p,"target"))))throw new Exception("这份已移除材料的确认属于另一段对话，原记录已保留。");return new {completed=true,id=id,outcome=Text(receipt,"outcome"),cleanupPending=false};}
        if(!verified)return new {completed=false,id=id,requiresVerification=true};
        var delivery=Object(Value(receipt,"delivery"));if(delivery==null||Text(delivery,"attemptId")!=Text(p,"attemptId")||!Equivalent(Value(delivery,"target"),Value(p,"target")))return new {completed=false,id=id,requiresVerification=true};
        var proof=Object(Value(p,"receipt"));string outcome=Text(proof,"state"),evidence=CompletionEvidence(outcome);double protocol;
        if(proof==null||!Number(Value(proof,"protocol"),out protocol)||protocol!=2||Text(proof,"materialId")!=id||Text(proof,"operationId")!=Text(p,"operationId")||Text(proof,"attemptId")!=Text(p,"attemptId")||!Equivalent(Value(proof,"target"),Value(p,"target"))||!(Value(proof,"verified") is bool)||(bool)proof["verified"]!=true||evidence==""||Text(proof,"evidence")!=evidence)return new {completed=false,id=id,requiresVerification=true};
        receipt["state"]="completed";receipt["updatedAt"]=DateTime.UtcNow.ToString("o");receipt["attemptId"]=Text(p,"attemptId");receipt["completedTarget"]=Value(p,"target");receipt["outcome"]=outcome;receipt["completionEvidence"]=evidence;Write(DeliveryFolder(receipt,true),id,receipt);
        bool cleanup=false;foreach(string suffix in new[]{"",".bak"}){string source=FileFor(DeliveryFolder(receipt),id)+suffix;if(File.Exists(source))try{File.Move(source,FileFor(DeliveryFolder(receipt,true),id)+"."+Guid.NewGuid().ToString("N")+".retired");}catch{cleanup=true;}}
        return new {completed=true,id=id,outcome=outcome,cleanupPending=cleanup};
    }
    static LibraryState RecoverLibrary(){return CachedLibrary();}
    static LibraryState RebuildLibrary(){
        var snapshots=All("snapshots");var headers=snapshots.OrderBy(s=>Text(s,"createdAt")).GroupBy(s=>Id(Text(s,"markId"))).ToDictionary(g=>g.Key,g=>Object(Value(g.First(),"markHeader")));
        // Repair missing or unreadable mark files from immutable snapshot headers.
        foreach(var pair in headers){string path=FileFor("marks",pair.Key);bool repair=!Exists("marks",pair.Key);
            if(!repair){try{Read("marks",pair.Key);}catch(UnsupportedSchema){throw;}catch(UnauthorizedAccessException){throw;}catch(IOException){throw;}catch{repair=true;}}
            if(repair)CommitBytes(path,Encoding.UTF8.GetBytes(Json().Serialize(pair.Value)),File.Exists(path)?path+".corrupt-"+Guid.NewGuid().ToString("N"):null);
        }
        var marks=All("marks");int maximum=marks.Select(m=>Convert.ToInt32(m["number"])).DefaultIfEmpty(0).Max();var numbers=new HashSet<int>();
        foreach(var mark in marks.OrderBy(m=>Text(m,"createdAt")).ThenBy(m=>Text(m,"id"))){int number=Convert.ToInt32(mark["number"]);if(!numbers.Add(number)){mark["number"]=checked(++maximum);numbers.Add(maximum);Write("marks",Text(mark,"id"),mark);}}
        foreach(var snapshot in snapshots){EnsureCaptureReceipt(Object(Value(snapshot,"captureIntent")));ProveRecoveredSnapshot(snapshot);}
        foreach(var snapshot in snapshots.Where(value=>Text(value,"contextFor")!=""))FinishContextSupplement(snapshot);
        return new LibraryState{Marks=marks,Snapshots=snapshots};
    }
    static void ValidateSnapshotRetry(Dictionary<string,object> p,Dictionary<string,object> snapshot,IList incoming){
        var batch=Object(p["batch"]);var header=Object(snapshot["markHeader"]);string requested=Text(p,"markId");
        Require(requested==""||Id(requested)==Text(snapshot,"markId"),"snapshot id reused with different mark");
        Require(NormalizeLessonKey(Text(batch,"lessonKey"))==NormalizeLessonKey(Text(header,"lessonKey"))&&Equivalent(Value(batch,"course"),Value(snapshot,"course"))&&Equivalent(Value(batch,"time"),Value(snapshot,"time"))&&Equivalent(Value(p,"layout"),Value(snapshot,"layout")),"snapshot id reused with different classroom state");
        Require(Equivalent(Value(batch,"missingContext",new object[0]),Value(snapshot,"missingContext",new object[0])),"snapshot id reused with different missing context");
        Require(Text(p,"contextFor")==Text(snapshot,"contextFor")&&Equivalent(Value(p,"contextProof"),Value(snapshot,"contextProof")),"snapshot id reused with different continuation proof");
        var stored=Array(snapshot["items"]);Require(stored.Count==incoming.Count,"snapshot id reused with different items");
        for(int i=0;i<stored.Count;i++){
            var before=new Dictionary<string,object>(Object(stored[i]));var after=new Dictionary<string,object>(Object(incoming[i]));string data=Text(after,"image"),asset=Text(before,"asset");
            before.Remove("asset");before.Remove("snapshotId");before.Remove("markId");before.Remove("ref");before.Remove("contextKey");after.Remove("image");after.Remove("snapshotId");after.Remove("markId");after.Remove("asset");after.Remove("ref");after.Remove("contextKey");
            if(Text(before,"kind")=="selection"){before.Remove("label");after.Remove("label");}
            Require(Equivalent(before,after),"snapshot id reused with different item identity or position");Require(CaptureItemAsset(Object(incoming[i]))==asset,"snapshot id reused with different pixels");
        }
    }
    public static object SaveSnapshot(Dictionary<string,object> p){
        if(currentLease==null){using(var lease=AcceptLibraryWork("/library/save",p))return lease.Execute(delegate{return SaveSnapshot(p);});}
        lock(gate){
        ValidateSaveInput(p);
        var batch=Object(Value(p,"batch"));bool pixelFree=PixelFreeMark(p,batch);if(!pixelFree)WebViewChatWindows.ValidateCapture(batch,true);string snapshotId=Id(Text(batch,"id"));
        StringField(batch,"lessonKey",true);Require(Object(Value(batch,"course"))!=null,"course");TimeField(batch,"time");Layout(Value(p,"layout"));
        var raw=new List<object>();foreach(var item in ListField(batch,"context"))raw.Add(item);if(Text(p,"markOnly")!="True")raw.Add(Value(batch,"selection"));
        var itemIds=new HashSet<string>();foreach(var item in raw)ValidateItem(Object(item),snapshotId,"",itemIds,false);
        var state=RecoverLibrary();
        if(Exists("snapshots",snapshotId)){
            var old=Read("snapshots",snapshotId);ValidateSnapshotRetry(p,old,raw);foreach(var source in raw)if(Text(Object(source),"image")!="")SaveImage(Text(Object(source),"image"));currentLease.SnapshotCommitted=true;
            FinishContextSupplement(old);return CaptureReply(p,Read("marks",Text(old,"markId")),snapshotId);
        }
        string requested=Text(p,"markId"),markId=requested==""?Guid.NewGuid().ToString("D"):Id(requested);Dictionary<string,object> mark;
        if(requested!=""){
            mark=Read("marks",markId);if(NormalizeLessonKey(Text(mark,"lessonKey"))!=NormalizeLessonKey(Text(batch,"lessonKey")))throw new Exception("这个标记属于另一节课，请先新建标记。");
        }else{
            int number=checked(state.Marks.Select(x=>Convert.ToInt32(Value(x,"number",0))).DefaultIfEmpty(0).Max()+1);
            mark=new Dictionary<string,object>{{"schema",1},{"id",markId},{"number",number},{"title",Text(p,"title","标记 "+number)},{"note",Text(p,"note")},{"lessonKey",Text(batch,"lessonKey")},{"course",Value(batch,"course")},{"time",Value(batch,"time",0)},{"createdAt",DateTime.UtcNow.ToString("o")},{"sourcePage",Text(p,"sourcePage")},{"initialSnapshotId",snapshotId}};
        }
        var items=new List<Dictionary<string,object>>();
        int ordinal=state.Snapshots.Where(s=>Text(s,"markId")==markId).Sum(s=>Array(Value(s,"items")).Cast<object>().Count(i=>Text(Object(i),"kind")=="selection"))+1;
        foreach(var value in raw){var item=Object(value);var saved=new Dictionary<string,object>(item);saved.Remove("image");saved.Remove("ref");if(Text(item,"kind")=="selection")saved["label"]="截图 "+ordinal;saved["asset"]=Text(item,"image")!=""?SaveImage(Text(item,"image")):CaptureItemAsset(item);saved["markId"]=markId;saved["snapshotId"]=snapshotId;items.Add(saved);}
        var snapshot=new Dictionary<string,object>{{"schema",1},{"id",snapshotId},{"markId",markId},{"markHeader",mark},{"course",Value(batch,"course")},{"time",Value(batch,"time",0)},{"layout",Value(p,"layout")},{"items",items},{"createdAt",DateTime.UtcNow.ToString("o")}};
        if(pixelFree)snapshot["markOnly"]=true;
        if(batch.ContainsKey("missingContext")){snapshot["missingContext"]=batch["missingContext"];snapshot["contextComplete"]=batch["contextComplete"];}
        if(raw.Cast<object>().Any(value=>Text(Object(value),"image")==""||Text(Object(value),"image").Length>12*1024*1024))snapshot["assetBacked"]=true;
        if(p.ContainsKey("acquisition"))snapshot["acquisition"]=Value(p,"acquisition");
        if(p.ContainsKey("contextFor"))snapshot["contextFor"]=Id(Text(p,"contextFor"));
        if(p.ContainsKey("contextProof"))snapshot["contextProof"]=Value(p,"contextProof");
        var captureIntent=NewCaptureIntent(p,mark,snapshotId);if(captureIntent!=null)snapshot["captureIntent"]=captureIntent;
        Write("snapshots",snapshotId,snapshot);currentLease.SnapshotCommitted=true;if(requested=="")Write("marks",markId,mark);
        if(Text(p,"contextFor")!=""){EnsureCaptureReceipt(captureIntent);FinishContextSupplement(snapshot);}
        return CaptureReply(p,mark,snapshotId);
    }}
    static object ListLibrary(Dictionary<string,object> p){
        var state=RecoverLibrary();var snapshots=state.Snapshots;var marks=state.Marks;
        var groups=snapshots.ToLookup(s=>Text(s,"markId"));
        List<Dictionary<string,object>> questions;object index=null;if(Text(p,"indexStatus")=="True")index=QuestionIndexStatus(Text(p,"retryQuestionIndex")=="True",out questions);else questions=CachedQuestions();
        var result=new {schema=1,marks=marks.OrderBy(m=>Convert.ToInt32(Value(m,"number",0))).Select(m=>new {id=Text(m,"id"),title=Text(m,"title"),number=Value(m,"number"),course=Value(m,"course"),time=Value(m,"time"),note=Text(m,"note"),lessonKey=Text(m,"lessonKey"),sourcePage=Text(m,"sourcePage"),snapshots=groups[Text(m,"id")].Count(),selections=groups[Text(m,"id")].Sum(s=>Array(Value(s,"items")).Count)}).ToArray(),questions=questions.OrderByDescending(q=>Text(q,"updatedAt")).Select(q=>new {id=Text(q,"id"),revision=Value(q,"revision"),title=Text(q,"title","未命名提问"),status=Text(q,"status")=="sent"&&ConfirmedQuestionConversation(q)==""?"unknown":Text(q,"status"),conversationUrl=Text(q,"conversationUrl"),lessonKey=Text(q,"lessonKey"),course=Value(q,"course",new Dictionary<string,object>()),hasQuestionText=Value(q,"hasQuestionText",true),imageCount=Value(q,"imageCount",0),markTitles=Value(q,"markTitles",new object[0]),updatedAt=Text(q,"updatedAt")}).ToArray()};
        if(index!=null)return new {schema=result.schema,marks=result.marks,questions=result.questions,questionIndex=index};return result;
    }
    static object Mark(string id){var state=RecoverLibrary();var mark=Read("marks",id);var snapshots=state.Snapshots.Where(s=>Text(s,"markId")==id).OrderBy(s=>Text(s,"createdAt")).Select(s=>Read("snapshots",Text(s,"id"))).ToArray();
        foreach(var s in snapshots){if(Exists("media-proofs",Text(s,"id"))){try{s["mediaProof"]=VerifiedMediaProof(s,Read("media-proofs",Text(s,"id")));}catch(Exception error){s["mediaProofError"]=error.Message;}}if(Text(s,"contextFor")!=""){VerifyContextSupplement(Read("snapshots",Text(s,"contextFor")),s);s["contextVerified"]=true;}var items=Array(Value(s,"items")).Cast<object>().Select(x=>SnapshotItem(s,Object(x))).ToArray();foreach(var item in items)item["thumbnail"]=Thumbnail(Text(item,"asset"));s["items"]=items;}
        return new {mark=mark,snapshots=snapshots};
    }
    static Dictionary<string,object> QuestionInput(Dictionary<string,object> q,out string id,out long revision,out int bytes){
        id=Id(Text(q,"id"));revision=Integer(Value(q,"revision"),"revision");Require(revision>0,"revision");
        string serialized=Json().Serialize(q);bytes=Encoding.UTF8.GetByteCount(serialized);if(bytes>MaxQuestionInputBytes)throw new Exception("单份问题记录过大，请分组整理。");
        var copy=Json().Deserialize<Dictionary<string,object>>(serialized);if(copy.ContainsKey("schema"))Schema(copy);var checkedInput=new Dictionary<string,object>(copy);checkedInput["schema"]=1;checkedInput["id"]=id;checkedInput["updatedAt"]=DateTime.UtcNow.ToString("o");checkedInput["createdAt"]=Value(copy,"createdAt",checkedInput["updatedAt"]);ValidateQuestion(checkedInput,id);return copy;
    }
    static bool SameQuestionRevision(Dictionary<string,object> left,Dictionary<string,object> right){
        var a=new Dictionary<string,object>(left);var b=new Dictionary<string,object>(right);foreach(string field in new[]{"schema","createdAt","updatedAt"}){a.Remove(field);b.Remove(field);}a["id"]=Id(Text(a,"id"));b["id"]=Id(Text(b,"id"));return Equivalent(a,b);
    }
    static bool Confirmed(string value){return value=="durable-history"||value=="user-confirmed";}
    static bool AdoptionProof(Dictionary<string,object> q,string source){
        var intent=Object(Value(q,"sendIntent"));string turn=Text(q,"adoptionTurnId"),proof=Text(q,"adoptionConfirmation");
        return source.StartsWith("provisional:",StringComparison.Ordinal)&&Text(q,"adoptedFrom")==source&&Text(intent,"adoptedFrom")==source&&turn!=""&&turn.Length<=200&&Text(intent,"adoptionTurnId")==turn&&Confirmed(proof)&&Text(intent,"adoptionConfirmation")==proof;
    }
    static void CheckQuestionBinding(Dictionary<string,object> q,Dictionary<string,object> old){
        string canonical=CanonicalConversation(Text(q,"conversationUrl")),bound=Text(q,"conversationId");
        if(canonical!=""&&bound!=""&&bound!="c:"+canonical)throw new Exception("提问的对话身份不一致，原记录已保留。");
        if(old==null)return;string priorCanonical=CanonicalConversation(Text(old,"conversationUrl")),priorBound=Text(old,"conversationId");
        if(priorCanonical==""&&priorBound.StartsWith("c:",StringComparison.Ordinal))priorCanonical=priorBound.Substring(2);
        string nextCanonical=canonical;if(nextCanonical==""&&bound.StartsWith("c:",StringComparison.Ordinal))nextCanonical=bound.Substring(2);
        if(priorCanonical!=""&&priorCanonical!=nextCanonical)throw new Exception("这份提问已经属于另一段对话，请保留原记录并新建提问。");
        if(priorBound.StartsWith("provisional:",StringComparison.Ordinal)&&nextCanonical!=""&&!AdoptionProof(q,priorBound))throw new Exception("新对话尚未确认与这份提问关联，原记录已保留。");
        if(Text(old,"status")=="sent"){
            if(Text(q,"status")!="sent")throw new Exception("已发送的提问不能退回草稿，请新建提问继续编辑。");
            foreach(string field in new[]{"text","questions","refs","carry","extra","format"})if(!Equivalent(Value(q,field),Value(old,field)))throw new Exception("已发送的提问内容不能被覆盖，请新建提问继续编辑。");
            if(ConfirmedQuestionConversation(old)!=""){
                if(ConfirmedQuestionConversation(q)=="")throw new Exception("已确认的发送凭据不能被未核对的状态覆盖，原记录已保留。");
                foreach(string field in new[]{"sendId","turnId","contextKeys"})if(!Equivalent(Value(q,field),Value(old,field)))throw new Exception("已发送的提问不能改绑到另一条消息或背景资料。");
                foreach(string field in new[]{"operationIds","deliveries"})if(!Equivalent(Value(Object(Value(q,"sendIntent")),field),Value(Object(Value(old,"sendIntent")),field)))throw new Exception("已发送的材料对应关系不能被覆盖，原记录已保留。");
            }
        }
    }
    public static void SaveQuestion(Dictionary<string,object> q){
        if(currentLease==null){string inputId;long inputRevision;int inputBytes;var copy=QuestionInput(q,out inputId,out inputRevision,out inputBytes);PersistenceLease lease;lock(pendingGate){lease=AcceptLocked("question:"+inputId,inputRevision,true);lease.Question=copy;}using(lease)lease.Execute(delegate{SaveQuestion(copy);});return;}
        lock(gate){
        string id=Id(Text(q,"id"));if(Text(q,"text").Length>100000||Array(Value(q,"refs")).Count>300)throw new Exception("提问内容过长。");
        long revision=Integer(Value(q,"revision"),"revision");Require(revision>0,"revision");var old=Exists("questions",id)?Read("questions",id):null;
        if(old!=null&&Integer(Value(old,"revision"),"revision")>revision){if(currentLease!=null)currentLease.CommittedRevision=Integer(old["revision"],"revision");return;}
        q=new Dictionary<string,object>(q);q["schema"]=1;q["id"]=id;q["updatedAt"]=DateTime.UtcNow.ToString("o");q["createdAt"]=old!=null?old["createdAt"]:Value(q,"createdAt",q["updatedAt"]);
        string url=Text(q,"conversationUrl");Uri u;if(url!=""&&(!Uri.TryCreate(url,UriKind.Absolute,out u)||u.Host!="chatgpt.com"||u.Scheme!="https"))q["conversationUrl"]="";
        CheckQuestionBinding(q,old);
        if(old!=null&&Integer(Value(old,"revision"),"revision")==revision){if(!SameQuestionRevision(old,q))throw new Exception("这份提问的同一版本包含不同内容，原记录已保留，请重试最新编辑。");if(currentLease!=null)currentLease.CommittedRevision=revision;return;}
        Write("questions",id,q);if(currentLease!=null)currentLease.CommittedRevision=revision;
    }}
    public static Task QueueQuestion(Dictionary<string,object> q){
        lock(pendingGate)if(!accepting)throw new InvalidOperationException("资料库正在保存并退出，请稍后再试。");
        string id;long revision;int bytes;var copy=QuestionInput(q,out id,out revision,out bytes);bool start=false;QuestionJob job;
        lock(pendingGate){
            if(!accepting)throw new InvalidOperationException("资料库正在保存并退出，请稍后再试。");
            if(questionJobs.TryGetValue(id,out job)){
                if(revision==job.Revision&&!SameQuestionRevision(job.Latest,copy))throw new Exception("这份提问的同一版本包含不同内容，请重试最新编辑。");
                if(revision>job.Revision){CheckQuestionBinding(copy,job.Latest);if(queuedQuestionBytes-job.Bytes+bytes>MaxQueuedQuestionBytes)throw new Exception("问题保存队列已满，请稍后重试。");queuedQuestionBytes+=bytes-job.Bytes;job.Latest=copy;job.Revision=revision;job.Bytes=bytes;job.Lease.Revision=revision;job.Lease.Question=copy;}
                return job.Completion.Task;
            }
            if(questionJobs.Count>=MaxQueuedQuestionIds||queuedQuestionBytes+bytes>MaxQueuedQuestionBytes)throw new Exception("问题保存队列已满，请稍后重试。");
            job=new QuestionJob{Id=id,Latest=copy,Revision=revision,Bytes=bytes,Lease=AcceptLocked("question:"+id,revision,true)};
            job.Lease.Question=copy;
            questionJobs.Add(id,job);questionOrder.Enqueue(job);queuedQuestionBytes+=bytes;if(!questionWorker){questionWorker=true;start=true;}
        }
        if(start){try{Task.Run((Action)QuestionPump);}catch(Exception error){QuestionJob[] abandoned;lock(pendingGate){questionWorker=false;abandoned=questionJobs.Values.ToArray();questionJobs.Clear();questionOrder.Clear();queuedQuestionBytes=0;foreach(var unused in abandoned)Finish(unused.Lease,error);}foreach(var unused in abandoned)unused.Completion.TrySetException(error);throw;}}
        return job.Completion.Task;
    }
    static void QuestionPump(){
        while(true){QuestionJob job;lock(pendingGate){if(questionOrder.Count==0){questionWorker=false;return;}job=questionOrder.Dequeue();}
            try{job.Lease.Execute(delegate{try{while(true){Dictionary<string,object> latest;long revision;lock(pendingGate){latest=job.Latest;revision=job.Revision;}SaveQuestion(latest);lock(pendingGate){if(job.Revision==revision){questionJobs.Remove(job.Id);queuedQuestionBytes-=job.Bytes;return;}}}}catch{lock(pendingGate){questionJobs.Remove(job.Id);queuedQuestionBytes-=job.Bytes;}throw;}});job.Completion.TrySetResult(null);}
            catch(Exception error){job.Completion.TrySetException(error);}
        }
    }
    public static string[] ContextKeys(string url){
        if(currentLease==null){using(var lease=AcceptLibraryWork("/library/contexts",new Dictionary<string,object>{{"id",url}}))return lease.Execute(delegate{return ContextKeys(url);});}
        using(new QuestionReadScope()){
        string requested=CanonicalConversation(url);if(requested=="")return new string[0];var keys=new HashSet<string>();
        foreach(var q in CachedQuestions()){if(ConfirmedQuestionConversation(q)!=requested)continue;foreach(var value in Array(Value(q,"contextKeys")))keys.Add(Convert.ToString(value));}
        return keys.ToArray();
    }}
    static string CanonicalConversation(string url){
        Uri uri;if(!Uri.TryCreate(url,UriKind.Absolute,out uri)||uri.Scheme!="https"||uri.Host!="chatgpt.com"||!uri.IsDefaultPort||uri.UserInfo!="")return "";
        string path=uri.AbsolutePath.TrimEnd('/');int at=path.LastIndexOf("/c/",StringComparison.Ordinal);if(at<0)return "";string id=path.Substring(at+3);return id!=""&&id.IndexOf('/')<0?id:"";
    }
    internal static string NormalizeLessonKey(string key){
        var match=Regex.Match(key??"","^__zjf_layout_v1:(\\d{1,12}):(\\d{1,12}):(\\d{1,12})(?::|$)");
        return match.Success?"__zjf_layout_v1:"+match.Groups[1].Value+":"+match.Groups[2].Value+":"+match.Groups[3].Value:key??"";
    }
    internal static Dictionary<string,object> LatestLessonQuestion(string lessonKey,string route=null){
        if(currentLease==null){using(var lease=AcceptLibraryWork("/library/lesson-resume",new Dictionary<string,object>()))return lease.Execute(delegate{return LatestLessonQuestion(lessonKey,route);});}
        using(new QuestionReadScope()){
            string scope=NormalizeLessonKey(lessonKey);if(scope=="")return null;
            string canonical=route==null?"":CanonicalConversation("https://chatgpt.com"+route);
            foreach(var summary in CachedQuestions().Where(q=>NormalizeLessonKey(Text(q,"lessonKey"))==scope).OrderByDescending(q=>Text(q,"updatedAt"))){
                if(route!=null&&(canonical!=""?CanonicalConversation(Text(summary,"conversationUrl"))!=canonical:CanonicalConversation(Text(summary,"conversationUrl"))!=""))continue;
                var question=Read("questions",Text(summary,"id"));
                if(NormalizeLessonKey(Text(QuestionSummary(question),"lessonKey"))==scope)return question;
            }return null;
        }
    }
    internal static string LessonConversationUrl(string lessonKey){
        var question=LatestLessonQuestion(lessonKey);string url=Text(question,"conversationUrl");
        return CanonicalConversation(url)!=""?url:"https://chatgpt.com/";
    }
    internal static object LessonResume(string lessonKey,string route,string text,List<string> resumeIds){
        if(currentLease==null){using(var lease=AcceptLibraryWork("/library/lesson-resume",new Dictionary<string,object>()))return lease.Execute(delegate{return LessonResume(lessonKey,route,text,resumeIds);});}
        var latest=LatestLessonQuestion(lessonKey,route);
        var current=latest!=null&&Text(latest,"status")=="draft"?latest:null;
        var known=ResumeDrafts(route,text,resumeIds);
        Dictionary<string,object> cleared=null;var manifest=Object(Value(current,"draftManifest"));string clearedId=Text(manifest,"clearedFrom");
        if(clearedId!=""){cleared=Read("questions",Id(clearedId));if(Text(cleared,"status")!="draft"||NormalizeLessonKey(Text(QuestionSummary(cleared),"lessonKey"))!=NormalizeLessonKey(lessonKey))cleared=null;}
        return new {current=current,known=known,cleared=cleared};
    }
    static string ConfirmedQuestionConversation(Dictionary<string,object> q){
        var intent=Object(Value(q,"sendIntent"));var target=Object(Value(intent,"target"));string canonical=CanonicalConversation(Text(q,"conversationUrl")),conversation="c:"+canonical,turn=Text(q,"turnId"),confirmation=Text(q,"confirmation");
        if(canonical==""||Text(q,"status")!="sent"||Text(intent,"status")!="sent"||Text(q,"conversationId")!=conversation||Text(target,"conversationId")!=conversation||CanonicalConversation("https://chatgpt.com"+Text(target,"route"))!=canonical)return "";
        if(Text(intent,"questionId")!=Text(q,"id")||Text(intent,"id")!=Text(q,"sendId")||turn==""||turn.Length>200||Text(intent,"turnId")!=turn||!Confirmed(confirmation)||Text(intent,"confirmation")!=confirmation)return "";
        if(confirmation=="durable-history"){var correlation=Object(Value(intent,"sendCorrelation"));if(Text(intent,"observedTurnId")!=turn||Text(correlation,"kind")!="submit-linked"||Text(correlation,"sendId")!=Text(intent,"id")||Text(correlation,"turnId")!=turn)return "";}return canonical;
    }
    internal static Dictionary<string,object> ConfirmedDelivery(string url,string operationId,string materialId){
        if(currentLease==null){using(var lease=AcceptLibraryWork("/library/confirmed-delivery",new Dictionary<string,object>{{"id",operationId}}))return lease.Execute(delegate{return ConfirmedDelivery(url,operationId,materialId);});}
        using(new QuestionReadScope()){
            string canonical=CanonicalConversation(url);if(canonical==""||operationId==""||materialId=="")return null;
            foreach(var summary in CachedQuestions().Where(x=>Array(Value(Object(Value(x,"sendIntent")),"operationIds")).Cast<object>().Any(value=>Convert.ToString(value)==operationId)).OrderByDescending(x=>Text(x,"updatedAt"))){
                var q=Read("questions",Text(summary,"id")); // A derived index is never itself proof that a send succeeded.
                var intent=Object(Value(q,"sendIntent"));string turn=Text(q,"turnId"),confirmation=Text(q,"confirmation"),savedCanonical=ConfirmedQuestionConversation(q),conversation="c:"+savedCanonical;if(savedCanonical=="")continue;
                if(!Array(Value(intent,"operationIds")).Cast<object>().Any(x=>Convert.ToString(x)==operationId))continue;var deliveries=Array(Value(intent,"deliveries")).Cast<object>().Select(Object).Where(x=>Text(x,"operationId")==operationId).ToArray();if(deliveries.Length==0)continue;
                if(savedCanonical!=canonical||deliveries.Any(x=>Text(x,"materialId")!=materialId))throw new Exception("这次附图操作已关联其他材料或对话，请重新选择；原记录已保留。");
                string adoptedFrom=Text(q,"adoptedFrom");if(!AdoptionProof(q,adoptedFrom))adoptedFrom="";
                return new Dictionary<string,object>{{"operationId",operationId},{"materialId",materialId},{"conversationId",conversation},{"questionId",Text(q,"id")},{"target",Value(intent,"target")},{"turnId",turn},{"confirmation",confirmation},{"adoptedFrom",adoptedFrom}};
            }return null;
        }
    }
    // Query persisted send intents; correlation and confirmation remain the chat
    // adapter's responsibility. A root/provisional URL never matches another tab.
    static bool PendingAdoptionCandidate(Dictionary<string,object> question,string url,string canonical){
        if(canonical==""||CanonicalConversation(Text(question,"conversationUrl"))!="")return false;var intent=Object(Value(question,"sendIntent"));var candidate=Object(Value(intent,"adoptionCandidate"));var origin=Object(Value(candidate,"from"));string source=Text(origin,"conversationId");Uri requested;
        return Uri.TryCreate(url,UriKind.Absolute,out requested)&&source.StartsWith("provisional:",StringComparison.Ordinal)&&source==Text(question,"conversationId")&&Equivalent(origin,Value(intent,"target"))&&Text(candidate,"to")=="c:"+canonical&&Text(candidate,"route").TrimEnd('/')==requested.AbsolutePath.TrimEnd('/')&&CanonicalConversation("https://chatgpt.com"+Text(candidate,"route"))==canonical;
    }
    internal static object ConversationLedger(string url){
        if(currentLease==null){using(var lease=AcceptLibraryWork("/library/ledger",new Dictionary<string,object>{{"id",url}}))return lease.Execute(delegate{return ConversationLedger(url);});}
        using(new QuestionReadScope()){string conversation=CanonicalConversation(url);var keys=new HashSet<string>();var unresolved=new List<Dictionary<string,object>>();var drafts=new List<Dictionary<string,object>>();
            if(conversation!="")foreach(var question in CachedQuestions()){
                if(CanonicalConversation(Text(question,"conversationUrl"))!=conversation){if((Text(question,"status")=="pending"||Text(question,"status")=="unknown")&&PendingAdoptionCandidate(question,url,conversation))unresolved.Add(question);continue;}
                string status=Text(question,"status");if(status=="sent"&&ConfirmedQuestionConversation(question)==conversation)foreach(var value in Array(Value(question,"contextKeys")))keys.Add(Convert.ToString(value));
                else if((status=="pending"||status=="unknown"||status=="sent"&&ConfirmedQuestionConversation(question)=="")&&Object(Value(question,"sendIntent"))!=null)unresolved.Add(question);
                else if(status=="draft"&&Text(question,"hasDraftManifest")=="True")drafts.Add(question);
            }
            var resumable=new List<Dictionary<string,object>>();int bytes=0;foreach(var summary in drafts.OrderByDescending(q=>Text(q,"updatedAt"))){if(resumable.Count>=20)break;var draft=Read("questions",Text(summary,"id"));int size=Encoding.UTF8.GetByteCount(Json().Serialize(draft));if(bytes+size>3*1024*1024)break;resumable.Add(draft);bytes+=size;}
            return new {keys=keys.ToArray(),questions=unresolved.OrderByDescending(q=>Text(q,"updatedAt")).Take(100).Select(q=>UnresolvedQuestionView(Read("questions",Text(q,"id")))).ToArray(),drafts=resumable.ToArray(),draftsTruncated=resumable.Count<drafts.Count};
        }
    }
    static Dictionary<string,object> UnresolvedQuestionView(Dictionary<string,object> question){
        if(Text(question,"status")!="sent"||ConfirmedQuestionConversation(question)!="")return question;
        var view=new Dictionary<string,object>(question);var source=Object(Value(question,"sendIntent"));if(source==null)return question;var intent=new Dictionary<string,object>(source);intent["status"]="unknown";intent["legacySendProof"]=new Dictionary<string,object>{{"turnId",Text(source,"turnId")},{"confirmation",Text(source,"confirmation")},{"observedTurnId",Text(source,"observedTurnId")}};view["storedStatus"]="sent";view["status"]="unknown";view["sendIntent"]=intent;return view;
    }
    internal static Dictionary<string,object>[] ResumeDrafts(string route,string composerText,List<string> ids){
        if(currentLease==null){using(var lease=AcceptLibraryWork("/library/resume",new Dictionary<string,object>{{"id",route}}))return lease.Execute(delegate{return ResumeDrafts(route,composerText,ids);});}
        using(new QuestionReadScope()){
            var result=new List<Dictionary<string,object>>();if(String.IsNullOrWhiteSpace(composerText))return result.ToArray();string canonical=CanonicalConversation("https://chatgpt.com"+route);int bytes=0;
            var requested=new HashSet<string>(ids.Select(Id));var candidates=ids.Select(Id).Distinct().Reverse().ToList();
            foreach(var recovery in CachedQuestions().Where(x=>Text(x,"status")=="draft"&&requested.Contains(Text(Object(Value(x,"recoveryOf")),"id"))).OrderByDescending(x=>Text(x,"updatedAt")))if(!candidates.Contains(Text(recovery,"id")))candidates.Add(Text(recovery,"id"));
            foreach(string candidate in candidates){
                string id=Id(candidate);if(!Exists("questions",id))continue;var question=Read("questions",id);var manifest=Object(Value(question,"draftManifest"));
                if(Text(question,"status")!="draft"||manifest==null||Text(manifest,"version")!="1"||!DraftComposerMatches(manifest,composerText))continue;
                string prior=Text(question,"conversationId");bool compatible=canonical!=""?prior=="c:"+canonical:prior.StartsWith("provisional:",StringComparison.Ordinal)&&Text(Object(Value(manifest,"boundTarget")),"route")==route;
                if(!compatible)continue;
                bytes+=Encoding.UTF8.GetByteCount(Json().Serialize(question));if(result.Count>=20||bytes>3*1024*1024)throw new Exception("可恢复的同文草稿较多，请从资料库选择要继续的那一份。");
                result.Add(question);
            }
            return result.ToArray();
        }
    }
    static bool DraftComposerMatches(Dictionary<string,object> manifest,string text){
        string core=text.TrimEnd('\n');if(Text(manifest,"composerText").TrimEnd('\n')==core)return true;
        return Array(Value(manifest,"previousComposerTexts")).Cast<object>().Any(value=>value is string&&((string)value).TrimEnd('\n')==core);
    }
    internal static Dictionary<string,object> DraftClaimMetadata(string draftId){
        string id=Id(draftId);
        if(currentLease==null){using(var lease=AcceptLibraryWork("/library/draft-claim-metadata",new Dictionary<string,object>{{"id",id}}))return lease.Execute(delegate{return DraftClaimMetadata(id);});}
        lock(gate){
            if(!Exists("questions",id)){if(Directory.Exists(FileFor("questions",id))||Directory.Exists(FileFor("questions",id)+".bak"))throw new IOException("提问记录路径无法读取，原内容已保留。");return null;}
            var question=Read("questions",id);var manifest=Object(Value(question,"draftManifest"));string composer=Value(manifest,"composerText") as string;
        var result=new Dictionary<string,object>{{"id",id},{"status",Text(question,"status")},{"revision",Integer(Value(question,"revision"),"revision")},{"conversationId",Text(question,"conversationId")},{"conversationUrl",Text(question,"conversationUrl")},{"lessonKey",Text(QuestionSummary(question),"lessonKey")},{"boundTarget",Value(manifest,"boundTarget")},{"composerTextHash",String.IsNullOrWhiteSpace(composer)?"":Digest(Encoding.UTF8.GetBytes(composer))}};
            result["composerTextCoreHash"]=String.IsNullOrWhiteSpace(composer)?"":Digest(Encoding.UTF8.GetBytes(composer.TrimEnd('\n')));
            result["previousComposerTextHashes"]=Array(Value(manifest,"previousComposerTexts")).Cast<object>().OfType<string>().Select(text=>Digest(Encoding.UTF8.GetBytes(text.TrimEnd('\n')))).ToArray();
            // A retired renderer can still have accepted writes. The bridge's
            // claim gate must also serialize grants with every save acceptance.
            lock(pendingGate){string key="question:"+id;result["hasPending"]=pending.Values.Any(x=>x.Key==key||String.Equals(Text(x.Question,"id"),id,StringComparison.OrdinalIgnoreCase));result["hasFailure"]=failures.ContainsKey(key)||failures.Values.Any(x=>String.Equals(Text(x.Question,"id"),id,StringComparison.OrdinalIgnoreCase));}
            return result;
        }
    }
    // Acceptance happens before returning this task, even when its owner HWND
    // has vanished. The ordinary question store is also the recovery store.
    internal static Task<Dictionary<string,object>> QueueQuestionRecovery(Dictionary<string,object> question){
        string sourceId;long revision;int bytes;var copy=QuestionInput(question,out sourceId,out revision,out bytes);string hash=ValueDigest(copy),id=RecoveryQuestionId(sourceId,hash);Task<Dictionary<string,object>> task;
        lock(pendingGate){
            if(recoveryJobs.TryGetValue(id,out task))return task;var lease=AcceptLocked("question-recovery:"+id,revision,true);lease.Question=copy;
            try{task=Task.Run(delegate{try{return lease.Execute(delegate{return PersistQuestionRecovery(copy,sourceId,revision,hash,id);});}finally{lock(pendingGate)recoveryJobs.Remove(id);}});recoveryJobs[id]=task;return task;}
            catch(Exception error){Finish(lease,error);throw;}
        }
    }
    internal static Dictionary<string,object>[] RetainedQuestionFailures(string draftId){
        string id=Id(draftId);Dictionary<string,object>[] snapshots;
        lock(pendingGate)snapshots=failures.Values.Where(x=>x.Question!=null&&String.Equals(Text(x.Question,"id"),id,StringComparison.OrdinalIgnoreCase)).Select(x=>x.Question).ToArray();
        return snapshots.GroupBy(ValueDigest).Select(x=>Json().Deserialize<Dictionary<string,object>>(Json().Serialize(x.First()))).ToArray();
    }
    static string RecoveryQuestionId(string sourceId,string hash){
        string digest=ValueDigest(new object[]{"zjf-question-recovery-v1",sourceId,hash});char variant="89ab"[Convert.ToInt32(digest.Substring(16,1),16)&3];return digest.Substring(0,8)+"-"+digest.Substring(8,4)+"-8"+digest.Substring(13,3)+"-"+variant+digest.Substring(17,3)+"-"+digest.Substring(20,12);
    }
    static Dictionary<string,object> PersistQuestionRecovery(Dictionary<string,object> source,string sourceId,long revision,string hash,string recoveryId){
        lock(gate){
            Dictionary<string,object> committed=null;if(Exists("questions",sourceId)){try{committed=Read("questions",sourceId);}catch(UnsupportedSchema){}catch(IOException){}catch(Exception){/* Preserve the original; a separate recovery must remain possible. */}}
            string id=sourceId;bool copied=committed==null||!SameQuestionRevision(committed,source);
            if(copied){
                id=recoveryId;var recovered=Json().Deserialize<Dictionary<string,object>>(Json().Serialize(source));string now=DateTime.UtcNow.ToString("o");recovered["id"]=id;recovered["revision"]=1;recovered["schema"]=1;recovered["createdAt"]=now;recovered["updatedAt"]=now;recovered["status"]=Text(source,"status")=="draft"?"draft":"unknown";
                string title=Text(source,"title","未命名提问");recovered["title"]=title.Substring(0,Math.Min(title.Length,64))+"（恢复）";var provenance=new Dictionary<string,object>{{"id",sourceId},{"revision",revision},{"payloadHash",hash},{"status",Text(source,"status")}};recovered["recoveryOf"]=provenance;
                var manifest=Object(Value(recovered,"draftManifest"));var draft=Object(Value(manifest,"draft"));if(draft!=null)draft["id"]=id;
                if(manifest!=null&&manifest.ContainsKey("operationItems")){provenance["operationItems"]=manifest["operationItems"];manifest["operationItems"]=new object[0];}
                var sendRecord=new Dictionary<string,object>();foreach(string field in new[]{"sendIntent","sendId","turnId","confirmation","adoptedFrom","adoptionTurnId","adoptionConfirmation","contextKeys"})if(recovered.ContainsKey(field)){sendRecord[field]=recovered[field];recovered.Remove(field);}if(sendRecord.Count!=0)provenance["sendRecord"]=sendRecord;
                SaveQuestion(recovered);committed=Read("questions",id);Require(SameQuestionRevision(committed,recovered),"recovery commit");
            }
            lock(pendingGate){var resolved=failures.Where(x=>x.Value.Question!=null&&String.Equals(Text(x.Value.Question,"id"),sourceId,StringComparison.OrdinalIgnoreCase)&&x.Value.Revision==revision&&ValueDigest(x.Value.Question)==hash).Select(x=>x.Key).ToArray();foreach(string key in resolved)failures.Remove(key);}
            return new Dictionary<string,object>{{"id",id},{"sourceId",sourceId},{"sourceRevision",revision},{"payloadHash",hash},{"copied",copied}};
        }
    }
    // Snapshot identity comes from the validated archive, never from a nested
    // reference supplied with a capture. Plan references still name their source.
    // A mark can contain captures from different moments. Only the same frozen
    // time, source facts, layout and background pixels authorize context reuse.
    // Derive this for older snapshots too, without rewriting historical data.
    static string SnapshotContextKey(Dictionary<string,object> snapshot){
        var context=Array(Value(snapshot,"items")).Cast<object>().Select(Object).Where(x=>Text(x,"kind")!="selection")
            .OrderBy(x=>Text(x,"kind"),StringComparer.Ordinal).ThenBy(x=>Text(x,"boardId"),StringComparer.Ordinal)
            .Select(x=>(object)new object[]{Text(x,"kind"),Text(x,"boardId"),Text(x,"label"),Value(x,"roi"),Value(x,"time"),Text(x,"asset")}).ToArray();
        var layout=Object(Value(snapshot,"layout"));var boards=Array(Value(layout,"boards")).Cast<object>().Select(Object).OrderBy(x=>Text(x,"id"),StringComparer.Ordinal).Select(x=>(object)new object[]{Text(x,"id"),Text(x,"name"),Value(x,"roi")}).ToArray();
        return "context:"+ValueDigest(new object[]{"zjf-frame-context-v1",Text(snapshot,"markId"),Text(Object(Value(snapshot,"markHeader")),"lessonKey"),Value(snapshot,"time"),Value(snapshot,"course"),Text(layout,"mediaIdentity"),Value(layout,"dimensions"),boards,context});
    }
    static Dictionary<string,object> SnapshotItem(Dictionary<string,object> snapshot,Dictionary<string,object> item){
        var result=new Dictionary<string,object>(item);string snapshotId=Id(Text(snapshot,"id")),markId=Id(Text(snapshot,"markId"));result["snapshotId"]=snapshotId;result["markId"]=markId;result["contextKey"]=SnapshotContextKey(snapshot);
        var supplement=Text(item,"kind")=="selection"?ContextSupplement(snapshot):null;if(supplement!=null){result["contextKey"]=SnapshotContextKey(supplement);result["contextSupplementId"]=Text(supplement,"id");result.Remove("missingContext");}
        else if(Array(Value(snapshot,"missingContext")).Count>0)result["missingContext"]=snapshot["missingContext"];
        result["ref"]=new Dictionary<string,object>{{"snapshotId",snapshotId},{"itemId",Text(item,"id")},{"markId",markId}};return result;
    }
    static List<Dictionary<string,object>> ResolveItems(IList refs,bool background,HashSet<string> automaticRefs=null){
        var selected=new List<Dictionary<string,object>>();var keys=new HashSet<string>();
        var requested=new HashSet<string>(refs.Cast<object>().Select(value=>ReferenceKey(Object(value))));
        foreach(var value in refs){Reference(value);var reference=Object(value);var snapshot=Read("snapshots",Text(reference,"snapshotId"));if(Text(reference,"markId")!=""&&Id(Text(reference,"markId"))!=Text(snapshot,"markId"))throw new Exception("所选图片与标记不匹配，请重新选择；原始资料已保留。");var mark=Read("marks",Text(snapshot,"markId"));
            var item=Array(Value(snapshot,"items")).Cast<object>().Select(Object).FirstOrDefault(x=>Text(x,"id")==Text(reference,"itemId"));if(item==null)throw new Exception("所选图片不存在。");
            var included=new List<Dictionary<string,object>>();var backgroundSnapshot=snapshot;
            if(background&&Text(item,"kind")=="selection"){
                backgroundSnapshot=ContextSupplement(snapshot)??snapshot;included.AddRange(Array(Value(backgroundSnapshot,"items")).Cast<object>().Select(Object).Where(x=>Text(x,"kind")!="selection"));
            }
            included.Add(item);
            foreach(var candidate in included){var sourceSnapshot=candidate==item?snapshot:backgroundSnapshot;string key=Text(sourceSnapshot,"id")+"/"+Text(candidate,"id");bool asked=candidate==item&&(automaticRefs==null||!automaticRefs.Contains(ReferenceKey(reference)));
                // An automatic background must not take the earlier position of
                // a source the user explicitly placed later in this selection.
                if(candidate!=item&&requested.Contains(key))continue;
                if(keys.Add(key)){var result=SnapshotItem(sourceSnapshot,candidate);result["markTitle"]=Text(mark,"title");result["course"]=Value(sourceSnapshot,"course");result["ask"]=asked;selected.Add(result);}
                else if(asked)selected.First(x=>Text(x,"snapshotId")+"/"+Text(x,"id")==key)["ask"]=true;
            }
        }
        // Explicit image choices remain independent. Only automatically added
        // backgrounds in the same frozen context, with the same original
        // pixels, board and crop, are shared.
        Func<Dictionary<string,object>,string> backgroundKey=x=>Text(x,"contextKey")+"|"+Text(x,"markId")+"|"+Text(x,"kind")+"|"+Text(x,"boardId")+"|"+Text(x,"label")+"|"+Text(x,"asset")+"|"+Json().Serialize(Value(x,"roi"));
        var explicitBackgrounds=new HashSet<string>(selected.Where(x=>Text(x,"kind")!="selection"&&Text(x,"ask")=="True").Select(backgroundKey));
        var automaticBackgrounds=new HashSet<string>();
        return selected.Where(x=>Text(x,"kind")=="selection"||Text(x,"ask")=="True"||!explicitBackgrounds.Contains(backgroundKey(x))&&automaticBackgrounds.Add(backgroundKey(x))).ToList();
    }
    static string ReferenceKey(Dictionary<string,object> reference){Reference(reference);Require(Text(reference,"itemId").Length<=300,"reference item id");return Id(Text(reference,"snapshotId"))+"/"+Text(reference,"itemId");}
    static Dictionary<string,object> ItemReference(Dictionary<string,object> item){
        var reference=Object(Value(item,"ref"));string snapshot=reference==null?Text(item,"snapshotId"):Text(reference,"snapshotId"),itemId=reference==null?Text(item,"id"):Text(reference,"itemId"),mark=reference==null?Text(item,"markId"):Text(reference,"markId");if(mark=="")mark=Text(item,"markId");
        var result=new Dictionary<string,object>{{"snapshotId",Id(snapshot)},{"itemId",itemId}};if(mark!="")result["markId"]=Id(mark);ReferenceKey(result);return result;
    }
    static Dictionary<string,object> RestoreIntent(object raw,string idField="intentId",string atField="intentAt"){
        var value=Object(raw);if(value==null||(!value.ContainsKey(idField)&&!value.ContainsKey(atField)))return null;string id=Id(Text(value,idField));double at;Require(Number(Value(value,atField),out at)&&at>=0&&at<=9007199254740991L,"restore intent time");return new Dictionary<string,object>{{"intentId",id},{"intentAt",value[atField]}};
    }
    static Dictionary<string,object> WithRestoreIntent(Dictionary<string,object> reference,Dictionary<string,object> intent){var result=new Dictionary<string,object>(reference);result["intentId"]=intent["intentId"];result["intentAt"]=intent["intentAt"];return result;}
    static List<Dictionary<string,object>> NormalizeRestoreRefs(IList proposed,List<Dictionary<string,object>> logical){
        var available=logical.ToDictionary(x=>ReferenceKey(ItemReference(x)),ItemReference);var result=new List<Dictionary<string,object>>();var seen=new Dictionary<string,Dictionary<string,object>>();
        foreach(var value in proposed){var reference=Object(value);string key=ReferenceKey(reference);Dictionary<string,object> source;if(!available.TryGetValue(key,out source)||Text(reference,"markId")!=""&&Id(Text(reference,"markId"))!=Text(source,"markId"))throw new Exception("恢复选择不属于本次资料，请重新选择；原始资料已保留。");var intent=RestoreIntent(reference);if(intent==null)continue;var normalized=WithRestoreIntent(source,intent);string pair=key+"/"+Text(intent,"intentId");Dictionary<string,object> prior;if(seen.TryGetValue(pair,out prior)){if(!Equivalent(prior,normalized))throw new Exception("同一次恢复选择的时间信息不一致，请重新选择。");continue;}seen[pair]=normalized;result.Add(normalized);}
        return result;
    }
    static Dictionary<string,object> RenderPlan(string id,string title,List<Dictionary<string,object>> selected,IList carry,IList refs,bool background,IList restoreRefs,bool forceAtlas=false,string sourceMaterialId="",long responseBytes=0){
        if(selected.Count>300)throw new Exception("本次资料来源较多，请分组选取；原始资料已保留。");
        Action<string> imageBudget=delegate(string image){if(image.Length>12*1024*1024)throw new Exception("单张材料页超过 12 MiB 图片预算，请分组整理；原始标记、图片和问题均已保留。");responseBytes+=Encoding.UTF8.GetByteCount(image);if(responseBytes>MaxComposeJsonBytes-4*1024*1024)throw new Exception("本次材料超过可返回的 60 MiB 预算，请分组整理；原始标记、图片和问题均已保留。");};
        string origin=sourceMaterialId==""?id:sourceMaterialId;var logical=new List<Dictionary<string,object>>();var pages=new List<object>();
        if(selected.Count<=8&&(!forceAtlas||selected.Count==1)){
            for(int i=0;i<selected.Count;i++){var x=selected[i];string pageId=id+"-p"+(i+1),image=DeliveryImage(Text(x,"asset"));imageBudget(image);pages.Add(new Dictionary<string,object>{{"id",pageId},{"kind","collection"},{"label",Text(x,"markTitle")+" · "+Text(x,"label")},{"image",image},{"asset",Text(x,"asset")},{"format",image.StartsWith("data:image/jpeg",StringComparison.Ordinal)?"jpeg":"png"},{"time",Value(x,"time",0)},{"materialId",id},{"sourceMaterialId",origin}});var item=new Dictionary<string,object>(x);item["attachmentId"]=pageId;item["region"]="";item["thumbnail"]=Thumbnail(Text(x,"asset"));item["ref"]=ItemReference(x);logical.Add(item);}
        }else if(selected.Count>0){
            // Keep pages readable at ordinary chat image sizes. Small formula
            // crops need visible space too; unused canvas is not source content.
            const int cell=1024,width=2048,height=2048,caption=90;Bitmap page=null;Graphics g=null;int y=0,column=0,rowHeight=0,number=0,pageItems=0;
            Action flush=delegate{if(page==null)return;int usedHeight=Math.Max(1,Math.Min(height,y+rowHeight));using(var cropped=page.Clone(new Rectangle(0,0,pageItems==1?cell:width,usedHeight),PixelFormat.Format24bppRgb))using(var memory=new MemoryStream())using(var options=new EncoderParameters(1)){options.Param[0]=new EncoderParameter(System.Drawing.Imaging.Encoder.Quality,94L);cropped.Save(memory,ImageCodecInfo.GetImageEncoders().First(x=>x.MimeType=="image/jpeg"),options);string image="data:image/jpeg;base64,"+Convert.ToBase64String(memory.ToArray());imageBudget(image);pages.Add(new Dictionary<string,object>{{"id",id+"-p"+number},{"kind","collection"},{"label","材料页 "+number},{"image",image},{"time",0},{"materialId",id},{"sourceMaterialId",origin}});}g.Dispose();page.Dispose();page=null;};
            try{foreach(var x in selected){using(var original=new MemoryStream(AssetBytes(Text(x,"asset"))))using(var source=Image.FromStream(original)){
                double readableScale=Math.Min(4,Math.Max(1,768.0/Math.Max(source.Width,source.Height))),scale=Math.Min(readableScale,Math.Min((cell-32.0)/source.Width,(height-caption-32.0)/source.Height));int w=Math.Max(1,(int)(source.Width*scale)),h=Math.Max(1,(int)(source.Height*scale))+caption;
                if(page==null||y+h>height){flush();number++;page=new Bitmap(width,height);g=Graphics.FromImage(page);g.Clear(Color.White);g.InterpolationMode=System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;g.PixelOffsetMode=System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;y=column=rowHeight=pageItems=0;}
                string region="区域 "+(logical.Count+1),label=region+" · "+Text(x,"markTitle")+" / "+Text(x,"label")+" / "+Clock(Value(x,"time",0));
                using(var font=new Font("Microsoft YaHei",18))g.DrawString(label,font,Brushes.Black,new RectangleF(column*cell+16,y+8,cell-32,caption-12));g.DrawImage(source,column*cell+16,y+caption,w,h-caption);
                var item=new Dictionary<string,object>(x);item["attachmentId"]=id+"-p"+number;item["region"]=region;item["thumbnail"]=Thumbnail(Text(x,"asset"));item["ref"]=ItemReference(x);logical.Add(item);pageItems++;rowHeight=Math.Max(rowHeight,h);if(column==1){column=0;y+=rowHeight+12;rowHeight=0;}else column=1;
            }}flush();}finally{if(page!=null){g.Dispose();page.Dispose();}}
        }
        if(pages.Count>20)throw new Exception("所选资料超过 20 页图册，请分成几组；原始标记和图片都已保留。");
        var result=new Dictionary<string,object>{{"id",id},{"title",title},{"items",pages},{"logicalItems",logical},{"carry",carry},{"refs",refs},{"background",background},{"restoreRefs",restoreRefs},{"sourceMaterialId",origin}};CheckPlanResponseBudget(result);return result;
    }
    static void CheckPlanResponseBudget(Dictionary<string,object> result){try{if(Encoding.UTF8.GetByteCount(Json().Serialize(result))>MaxComposeJsonBytes)throw new InvalidOperationException();}catch(InvalidOperationException){throw new Exception("本次材料超过可返回的 60 MiB 预算，请分组整理；原始标记、图片和问题均已保留。");}}
    static object CanonicalValue(object value){
        var dictionary=value as IDictionary<string,object>;if(dictionary!=null){var ordered=new SortedDictionary<string,object>(StringComparer.Ordinal);foreach(var entry in dictionary)ordered[entry.Key]=CanonicalValue(entry.Value);return ordered;}var list=value as IList;if(list!=null)return list.Cast<object>().Select(CanonicalValue).ToArray();return value;
    }
    static string ValueDigest(object value){return Digest(Encoding.UTF8.GetBytes(Json().Serialize(CanonicalValue(value))));}
    static List<Dictionary<string,object>> PlanLogicalItems(Dictionary<string,object> plan){
        var raw=Value(plan,"logicalItems") as IList;if(raw==null)throw new Exception("这份旧图册缺少来源对应关系，请从资料库重新选择；原图册已保留。");Require(raw.Count<=300,"plan logical items");var keys=new HashSet<string>();var result=new List<Dictionary<string,object>>();
        foreach(var value in raw){var item=Object(value);Require(item!=null,"plan logical item");string key=ReferenceKey(ItemReference(item));if(!keys.Add(key))throw new Exception("这份图册的来源对应关系重复，请重新选择；原图册已保留。");result.Add(item);}return result;
    }
    static Dictionary<string,object> PlanReferenceSource(Dictionary<string,object> reference,Dictionary<string,Dictionary<string,object>> snapshots){
        string snapshotId=Id(Text(reference,"snapshotId"));Dictionary<string,object> snapshot;if(!snapshots.TryGetValue(snapshotId,out snapshot)){snapshot=Read("snapshots",snapshotId);snapshots[snapshotId]=snapshot;}
        var item=Array(Value(snapshot,"items")).Cast<object>().Select(Object).FirstOrDefault(x=>Text(x,"id")==Text(reference,"itemId"));if(item==null)throw new Exception("图册对应的课堂原图不存在，原图册已保留。");
        if(Text(reference,"markId")!=""&&Id(Text(reference,"markId"))!=Text(snapshot,"markId"))throw new Exception("图册与课堂原图的对应关系不一致，原资料已保留。");
        var source=SnapshotItem(snapshot,item);source["course"]=Value(snapshot,"course");source["markTitle"]=Text(Object(Value(snapshot,"markHeader")),"title");return source;
    }
    static bool SameBackgroundSource(Dictionary<string,object> a,Dictionary<string,object> b){
        string kind=Text(a,"kind"),labelA=Text(a,"originalLabel"),labelB=Text(b,"originalLabel");if(labelA=="")labelA=Text(a,"label");if(labelB=="")labelB=Text(b,"label");
        return (kind=="panorama"||kind=="board")&&kind==Text(b,"kind")&&Text(a,"asset")==Text(b,"asset")&&Text(a,"markId")==Text(b,"markId")&&Text(a,"boardId")==Text(b,"boardId")&&labelA==labelB&&Equivalent(Value(a,"roi"),Value(b,"roi"));
    }
    // A full PNG background can serve another frozen background ref while
    // each logical ref retains its own question. Atlas regions cannot.
    static Dictionary<string,object> FullBackgroundAlias(Dictionary<string,object> plan,Dictionary<string,object> requested,Dictionary<string,Dictionary<string,object>> snapshots){
        if(Text(requested,"region")!="")return null;
        var logical=PlanLogicalItems(plan);var matches=new List<Dictionary<string,object>>();
        foreach(var source in logical.Where(x=>Text(x,"region")==""&&SameBackgroundSource(x,requested))){
            string pageId=Text(source,"attachmentId");if(logical.Count(x=>Text(x,"attachmentId")==pageId)!=1)continue;
            var page=Array(Value(plan,"items")).Cast<object>().Select(Object).FirstOrDefault(x=>Text(x,"id")==pageId);if(page==null||Text(page,"format")!="png"||Text(page,"asset")!=Text(source,"asset"))continue;
            var frozen=PlanReferenceSource(ItemReference(source),snapshots);if(!SameBackgroundSource(source,frozen)||!SameBackgroundSource(frozen,requested)||Text(frozen,"contextKey")!=Text(requested,"contextKey"))continue;
            AttachmentBytes(Text(page,"asset"),"png");matches.Add(source);
        }
        if(matches.Count!=1)return null;var result=new Dictionary<string,object>(requested);result["ask"]=Text(requested,"ask")=="True";result["attachmentId"]=Text(matches[0],"attachmentId");result["region"]="";return result;
    }
    static List<Dictionary<string,object>> SelectPlanItems(Dictionary<string,object> plan,IList keepRefs){
        if(keepRefs==null||keepRefs.Count>300)throw new Exception("本次新增资料范围无效，请重新选择。");var original=PlanLogicalItems(plan);var byKey=original.ToDictionary(x=>ReferenceKey(ItemReference(x)));var keys=new HashSet<string>();
        foreach(var value in keepRefs)keys.Add(ReferenceKey(Object(value)));
        var selected=new List<Dictionary<string,object>>();var snapshots=new Dictionary<string,Dictionary<string,object>>();
        foreach(var source in original.Where(x=>keys.Contains(ReferenceKey(ItemReference(x))))){var reference=ItemReference(source);var frozen=PlanReferenceSource(reference,snapshots);string snapshotId=Text(frozen,"snapshotId"),mark=Text(frozen,"markId");
            if(Text(source,"markId")!=""&&Id(Text(source,"markId"))!=mark||Text(source,"snapshotId")!=""&&Id(Text(source,"snapshotId"))!=snapshotId||Text(source,"asset")!=""&&Text(source,"asset")!=Text(frozen,"asset")||Text(source,"kind")!=Text(frozen,"kind"))throw new Exception("图册与课堂原图的对应关系不一致，原资料已保留。");
            StringField(source,"id",true);StringField(source,"label",false);TimeField(source,"time");if(source.ContainsKey("ask"))Require(source["ask"] is bool,"plan ask");var saved=new Dictionary<string,object>(source);reference["markId"]=mark;saved["ref"]=reference;saved["snapshotId"]=snapshotId;saved["markId"]=mark;saved["asset"]=frozen["asset"];selected.Add(saved);
        }
        var aliases=new HashSet<string>();foreach(var value in keepRefs){var reference=Object(value);string key=ReferenceKey(reference);if(byKey.ContainsKey(key)||!aliases.Add(key))continue;var requested=PlanReferenceSource(reference,snapshots);requested["ask"]=false;var alias=FullBackgroundAlias(plan,requested,snapshots);if(alias==null)throw new Exception("所选来源不属于这份已保存图册或完整背景，原资料已保留。");selected.Add(alias);}
        var selectedRefs=selected.ToDictionary(x=>ReferenceKey(ItemReference(x)),ItemReference);foreach(var value in keepRefs){var reference=Object(value);if(Text(reference,"markId")!=""&&Id(Text(reference,"markId"))!=Text(selectedRefs[ReferenceKey(reference)],"markId"))throw new Exception("所选来源与标记不匹配，原资料已保留。");}return selected;
    }
    static string ProjectedPlanId(string materialId,IList refs){
        string hash=ValueDigest(new object[]{"zjf-plan-projection-v2",materialId,refs.Cast<object>().Select(value=>{var reference=Object(value);return new[]{Text(reference,"snapshotId"),Text(reference,"itemId")};}).ToArray()});char variant="89ab"[Convert.ToInt32(hash.Substring(16,1),16)&3];return hash.Substring(0,8)+"-"+hash.Substring(8,4)+"-8"+hash.Substring(13,3)+"-"+variant+hash.Substring(17,3)+"-"+hash.Substring(20,12);
    }
    static Dictionary<string,object> PlanReply(Dictionary<string,object> stored){
        var result=Json().Deserialize<Dictionary<string,object>>(Json().Serialize(stored));result.Remove("schema");result.Remove("createdAt");foreach(var value in Array(Value(result,"items"))){var item=Object(value);string format=Text(item,"format");item["image"]="data:image/"+format+";base64,"+Convert.ToBase64String(AttachmentBytes(Text(item,"asset"),format));}
        foreach(var value in Array(Value(result,"logicalItems"))){var item=Object(value);item["thumbnail"]=Thumbnail(Text(item,"asset"));}CheckPlanResponseBudget(result);return result;
    }
    internal static Dictionary<string,object> ProjectPlan(string materialId,IList keepRefs,IList restoreRefs=null){
        if(currentLease==null){using(var lease=AcceptLibraryWork("/library/project-plan",new Dictionary<string,object>{{"id",materialId}}))return lease.Execute(delegate{return ProjectPlan(materialId,keepRefs,restoreRefs);});}
        lock(gate){
            string sourceId=Id(materialId);var source=Read("plans",sourceId);string originId=Id(Text(source,"sourceMaterialId",sourceId));var all=PlanLogicalItems(source);var selected=SelectPlanItems(source,keepRefs);var refs=selected.Select(ItemReference).ToArray();var keepKeys=new HashSet<string>(refs.Select(ReferenceKey));
            var authorized=NormalizeRestoreRefs(Array(Value(source,"restoreRefs")),all).Where(x=>keepKeys.Contains(ReferenceKey(x))).ToList();var echoes=restoreRefs==null?authorized:NormalizeRestoreRefs(restoreRefs,selected);var authorizedPairs=authorized.ToDictionary(x=>ReferenceKey(x)+"/"+Text(x,"intentId"));
            foreach(var echo in echoes){Dictionary<string,object> authority;if(!authorizedPairs.TryGetValue(ReferenceKey(echo)+"/"+Text(echo,"intentId"),out authority)||!Equivalent(authority,echo))throw new Exception("本次恢复选择没有对应的原始操作，请重新选择。");}
            string id=ProjectedPlanId(sourceId,refs);var content=selected.Select(x=>{var item=new Dictionary<string,object>(x);foreach(string field in new[]{"attachmentId","region","thumbnail","image"})item.Remove(field);return item;}).ToArray();string fingerprint=ValueDigest(content);Dictionary<string,object> plan;
            Func<Dictionary<string,object>> build=delegate{var created=RenderPlan(id,Text(source,"title","课后提问"),selected,new object[0],refs,Text(source,"background")=="True",authorized,true,originId);created["projection"]=new Dictionary<string,object>{{"schema",1},{"sourceMaterialId",sourceId},{"sourceHash",fingerprint},{"refs",refs}};SavePlanAttachments(created);return created;};
            if(Exists("plans",id)){var stored=Read("plans",id);var projection=Object(Value(stored,"projection"));if(Text(projection,"schema")!="1"||Text(projection,"sourceMaterialId")!=sourceId||Text(stored,"sourceMaterialId")!=originId||Text(projection,"sourceHash")!=fingerprint||!Equivalent(Value(projection,"refs"),refs))throw new Exception("这份派生图册的来源已变化，请重新选择；已有图册已保留。");
                try{plan=PlanReply(stored);}catch{bool damaged=false;foreach(var value in Array(Value(stored,"items"))){var item=Object(value);try{AttachmentBytes(Text(item,"asset"),Text(item,"format"));}catch{damaged=true;break;}}if(!damaged)throw;plan=build();}
            }else plan=build();
            plan["restoreRefs"]=echoes;CheckPlanResponseBudget(plan);return plan;
        }
    }
    internal static Dictionary<string,object> ValidateSharedDraftBackground(string draftId,Dictionary<string,object> target,string physicalId,Dictionary<string,object> reference){
        lock(gate){
            var question=Read("questions",Id(draftId));var manifest=Object(Value(question,"draftManifest"));var draft=Object(Value(manifest,"draft"));
            Require(Text(question,"status")=="draft"&&draft!=null&&Text(draft,"id")==draftId&&Text(question,"conversationId")==Text(target,"conversationId")&&Equivalent(Value(manifest,"boundTarget"),target),"shared background draft target");
            var physical=Array(Value(draft,"items")).Cast<object>().Select(Object).FirstOrDefault(item=>Text(item,"id")==physicalId);Require(physical!=null&&(Text(physical,"kind")=="panorama"||Text(physical,"kind")=="board"||Text(physical,"kind")=="collection"&&(Text(physical,"format")==""||Text(physical,"format")=="png")),"shared original background");
            var contents=Array(Value(draft,"logicalItems")).Cast<object>().Select(Object).Where(item=>Text(item,"attachmentId")==physicalId).ToArray();string removed=ReferenceKey(reference);Require(contents.Length>1&&contents.Any(item=>ReferenceKey(ItemReference(item))==removed),"shared background source member");
            var snapshots=new Dictionary<string,Dictionary<string,object>>();Dictionary<string,object> source;
            if(Text(physical,"kind")=="collection"){var plan=Read("plans",Id(Text(physical,"materialId")));string attachment=Text(physical,"sourceAttachmentId",physicalId);var page=Array(Value(plan,"items")).Cast<object>().Select(Object).FirstOrDefault(item=>Text(item,"id")==attachment);var origins=PlanLogicalItems(plan).Where(item=>Text(item,"attachmentId")==attachment).ToArray();Require(page!=null&&Text(page,"format")=="png"&&origins.Length==1&&Text(origins[0],"region")=="","shared full PNG page");source=PlanReferenceSource(ItemReference(origins[0]),snapshots);Require(Text(page,"asset")==Text(source,"asset"),"shared PNG original pixels");AttachmentBytes(Text(page,"asset"),"png");}
            else source=PlanReferenceSource(ItemReference(physical),snapshots);AssetBytes(Text(source,"asset"));var proof=new List<object>();
            foreach(var item in contents){var original=PlanReferenceSource(ItemReference(item),snapshots);Require(Text(item,"region")==""&&SameBackgroundSource(source,original)&&Text(source,"contextKey")==Text(original,"contextKey"),"shared background original pixels");proof.Add(new object[]{ItemReference(item),Text(original,"asset")});}
            return new Dictionary<string,object>{{"proof",ValueDigest(new object[]{draftId,physicalId,removed,proof})},{"asset",Text(source,"asset")}};
        }
    }
    internal static string ValidateDraftRestore(string draftId,Dictionary<string,object> target,string materialId,IList keepRefs,bool editing=false){
        if(currentLease==null){using(var lease=AcceptLibraryWork("/library/draft-restore",new Dictionary<string,object>{{"id",draftId}}))return lease.Execute(delegate{return ValidateDraftRestore(draftId,target,materialId,keepRefs,editing);});}
        lock(gate){
            string id=Id(draftId),sourceId=Id(materialId);var question=Read("questions",id);var manifest=Object(Value(question,"draftManifest"));var draft=Object(Value(manifest,"draft"));string conversation=Text(target,"conversationId"),canonical=CanonicalConversation("https://chatgpt.com"+Text(target,"route"));
            if(Text(question,"status")!="draft"||manifest==null||draft==null||Text(draft,"id")!=id||Text(manifest,"version")!="1"||Text(question,"conversationId")!=conversation||Text(manifest,"conversationId")!=conversation)throw new Exception("这份资料不属于当前未发送草稿，原内容已保留。");
            Id(Text(target,"pageId"));foreach(string field in new[]{"documentEpoch","routeGeneration","composerGeneration"})Require(Integer(Value(target,field),field)>0,field);
            if(conversation.StartsWith("c:",StringComparison.Ordinal)){if(canonical==""||conversation!="c:"+canonical||CanonicalConversation(Text(question,"conversationUrl"))!=canonical)throw new Exception("草稿与当前对话不匹配，原内容已保留。");}
            else{if(!conversation.StartsWith("provisional:",StringComparison.Ordinal))throw new Exception("草稿对话身份无效。");Id(conversation.Substring(12));if(canonical!=""||Text(question,"conversationUrl")!=""||!Equivalent(Value(manifest,"boundTarget"),target))throw new Exception("新对话的草稿页面已变化，请在原页面重试。");}
            var selected=SelectPlanItems(Read("plans",sourceId),keepRefs);var active=new HashSet<string>();foreach(var value in Array(Value(draft,"logicalItems",Value(draft,"items")))){var item=Object(value);if(item==null)continue;if(Object(Value(item,"ref"))!=null||Text(item,"snapshotId")!="")active.Add(ReferenceKey(ItemReference(item)));}
            var removedPages=Array(Value(draft,editing?"items":"removed")).Cast<object>().Select(Object).Where(x=>x!=null&&Text(x,"kind")=="collection").ToArray();var removed=Array(Value(draft,editing?"logicalItems":"removedLogical")).Cast<object>().Select(Object).Where(x=>x!=null).ToArray();var proof=new List<object>();var physicalPlans=new Dictionary<string,Dictionary<string,object>>();var aliasSnapshots=new Dictionary<string,Dictionary<string,object>>();
            foreach(var item in selected){var reference=ItemReference(item);string key=ReferenceKey(reference);if(editing?!active.Contains(key):active.Contains(key))throw new Exception("这项资料的选中状态已变化，请从当前草稿重试。");var matches=new List<Dictionary<string,object>>();
                foreach(var candidate in removed){if(ReferenceKey(ItemReference(candidate))!=key)continue;string pageId=Text(candidate,"attachmentId");var page=removedPages.FirstOrDefault(x=>Text(x,"id")==pageId);if(page==null||Text(page,"materialId")!=Text(candidate,"materialId")||Text(page,"sourceMaterialId")!=Text(candidate,"sourceMaterialId")||(Text(page,"materialId")!=sourceId&&Text(page,"sourceMaterialId")!=sourceId))continue;
                    string pageMaterial=Id(Text(page,"materialId"));Dictionary<string,object> physical;if(!physicalPlans.TryGetValue(pageMaterial,out physical)){physical=Read("plans",pageMaterial);physicalPlans[pageMaterial]=physical;}if(Text(page,"sourceMaterialId")!=Text(physical,"sourceMaterialId",pageMaterial)||!Array(Value(physical,"items")).Cast<object>().Select(Object).Any(x=>Text(x,"id")==pageId))continue;
                    var physicalLogical=PlanLogicalItems(physical);Dictionary<string,object> alias=null;if(!physicalLogical.Any(x=>Text(x,"attachmentId")==pageId&&ReferenceKey(ItemReference(x))==key)){if(Text(candidate,"region")!=""||!SameBackgroundSource(candidate,item))continue;alias=FullBackgroundAlias(physical,item,aliasSnapshots);if(alias==null||Text(alias,"attachmentId")!=pageId)continue;}
                    var candidateRef=ItemReference(candidate);if(Text(candidateRef,"markId")!=""&&Text(candidateRef,"markId")!=Text(reference,"markId"))continue;long generation=editing?0:Integer(Value(candidate,"removalGeneration"),"removal generation");Require(editing||generation>0,"removal generation");var removedProof=new Dictionary<string,object>{{"ref",reference},{"attachmentId",pageId},{"materialId",pageMaterial},{"sourceMaterialId",Text(page,"sourceMaterialId")},{"removalGeneration",generation},{"editing",editing}};if(alias!=null){removedProof["physicalRef"]=ItemReference(physicalLogical.Single(x=>Text(x,"attachmentId")==pageId));removedProof["backgroundAsset"]=Text(alias,"asset");}matches.Add(removedProof);}
                if(matches.Count==0)throw new Exception("这项资料已不在草稿的已删除范围，原内容已保留。");long latest=matches.Max(x=>Convert.ToInt64(x["removalGeneration"]));var newest=matches.Where(x=>Convert.ToInt64(x["removalGeneration"])==latest).ToArray();if(newest.Skip(1).Any(x=>!Equivalent(newest[0],x)))throw new Exception("已删除资料的来源不唯一，请在当前草稿重新操作。");proof.Add(newest[0]);
            }
            return ValueDigest(new object[]{id,sourceId,proof});
        }
    }
    static Dictionary<string,object> SelectableQuestion(Dictionary<string,object> stored){
        var manifest=Object(Value(stored,"draftManifest"));var draft=Object(Value(manifest,"draft"));string common=Text(draft,"questionPrelude");
        if(Text(stored,"format")!="structured"||String.IsNullOrWhiteSpace(common)||Array(Value(stored,"questions")).Cast<object>().Any(x=>Text(Object(x),"id")=="questionPrelude"))return stored;
        // Older records kept the common question in extra. Expose a selectable
        // part on read without rewriting the original record or its revision.
        var result=Json().Deserialize<Dictionary<string,object>>(Json().Serialize(stored));var questions=Array(Value(result,"questions")).Cast<object>().ToList();
        var logical=Array(Value(draft,"logicalItems",Value(draft,"items"))).Cast<object>().Select(Object).ToArray();var asked=logical.Where(x=>Text(x,"kind")=="selection"||Text(x,"ask")=="True").ToArray();var order=Array(Value(draft,"questionOrder")).Cast<object>().Select(Convert.ToString).ToList();
        var refs=(asked.Length>0?asked:logical).OrderBy(x=>{int index=order.IndexOf(Text(x,"id"));return index<0?int.MaxValue:index;}).Select(x=>(object)ItemReference(x)).ToArray();
        questions.Insert(0,new Dictionary<string,object>{{"id","questionPrelude"},{"label","共同问题"},{"source","本次所选材料"},{"text",common},{"included",true},{"refs",refs}});result["questions"]=questions;
        string extra=Text(result,"extra");int at=extra.IndexOf(common,StringComparison.Ordinal);
        while(at>=0){int end=at+common.Length;if((at==0||at>=2&&extra.Substring(at-2,2)=="\n\n")&&(end==extra.Length||end+2<=extra.Length&&extra.Substring(end,2)=="\n\n")){result["extra"]=(extra.Substring(0,at)+extra.Substring(end)).Trim();break;}at=extra.IndexOf(common,at+1,StringComparison.Ordinal);}
        return result;
    }
    static object Compose(Dictionary<string,object> p){
        RecoverLibrary();
        var refs=Array(Value(p,"refs")).Cast<object>().ToList();if(refs.Count>200)throw new Exception("一次最多选择 200 项资料，请分组整理。");var directKeys=new HashSet<string>(refs.Select(x=>ReferenceKey(Object(x))));var askedRefs=new HashSet<string>(directKeys);var automaticRefs=new HashSet<string>();var restoreCandidates=new List<object>();
        foreach(var value in p.ContainsKey("restoreRefs")?ListField(p,"restoreRefs"):refs){var reference=Object(value);if(!directKeys.Contains(ReferenceKey(reference)))throw new Exception("恢复选择不是本次明确勾选的资料，请重新选择。");if(RestoreIntent(reference)!=null)restoreCandidates.Add(reference);}
        var carry=new List<object>();long responseBytes=0;if(Array(Value(p,"questions")).Count>200)throw new Exception("一次最多选择 200 份旧提问，请分组整理。");
        Action<string> budget=delegate(string text){responseBytes+=Encoding.UTF8.GetByteCount(text);if(responseBytes>MaxComposeJsonBytes-4*1024*1024)throw new Exception("本次材料超过可返回的 60 MiB 预算，请分组整理；原始标记、图片和问题均已保留。");};
        foreach(var selectedQuestion in Array(Value(p,"questions"))){var choice=Object(selectedQuestion);var q=SelectableQuestion(Read("questions",choice==null?Convert.ToString(selectedQuestion):Text(choice,"questionId")));
            if(Text(q,"status")!="sent"&&(choice==null||!choice.ContainsKey("sourceRevision")&&!choice.ContainsKey("sourceUpdatedAt")))throw new CaptureProtocolException("library_question_changed","这份旧选择尚未核定问题版本，请先查看当前内容；原选材已保留。");
            if(choice!=null&&(choice.ContainsKey("sourceRevision")&&Integer(choice["sourceRevision"],"selected question revision")!=Integer(Value(q,"revision"),"question revision")||choice.ContainsKey("sourceUpdatedAt")&&Text(choice,"sourceUpdatedAt")!=Text(q,"updatedAt")))throw new CaptureProtocolException("library_question_changed","所选问题已有更新，原选材已保留，请查看当前内容。");
            var parts=Array(Value(choice,"itemIds")).Cast<object>().Select(Convert.ToString).ToArray();var additional=AdditionalQuestionParts(choice,parts);bool supplementary=RetainSupplementaryText(choice),whole=parts.Length==0&&!supplementary,freeformSupplementary=supplementary&&Text(q,"format")=="freeform";
            if(parts.Concat(additional).Any(part=>!Array(Value(q,"questions")).Cast<object>().Select(Object).Any(x=>Text(x,"id")==part)))throw new Exception("所选旧问题已变化或不存在，请重新选择；原始提问已保留。");
            var questions=Array(Value(q,"questions")).Cast<object>().Select(Object).Where(x=>whole||parts.Contains(Text(x,"id"))).ToArray();
            if(parts.Length>0)foreach(var question in questions)question["included"]=true;
            var additionalQuestions=additional.Select(part=>{var question=new Dictionary<string,object>(Array(Value(q,"questions")).Cast<object>().Select(Object).Single(x=>Text(x,"id")==part));question["included"]=true;return question;}).ToArray();
            var partIntents=new Dictionary<string,Dictionary<string,object>>();
            if(choice!=null&&choice.ContainsKey("restorePartIntents"))foreach(var value in ListField(choice,"restorePartIntents")){var candidate=Object(value);StringField(candidate,"itemId",true);string partId=Text(candidate,"itemId");if(!Array(Value(q,"questions")).Cast<object>().Select(Object).Any(x=>Text(x,"id")==partId))throw new Exception("恢复选择对应的旧问题已不存在，请重新选择。");var intent=RestoreIntent(candidate);Require(intent!=null,"restore part intent");Dictionary<string,object> prior;if(partIntents.TryGetValue(partId,out prior)&&!Equivalent(prior,intent))throw new Exception("同一旧问题有冲突的恢复选择，请重新选择。");partIntents[partId]=intent;}
            Require(additional.All(partIntents.ContainsKey),"additional question restore intent");
            if(Text(p,"questionImages")=="True"){
                var defaultIntent=RestoreIntent(choice,"restoreIntentId","restoreIntentAt");
                // Blank image-question slots still own their source roles. An
                // excluded slot must not trigger a fallback to every saved ref.
                var imageQuestions=questions.Where(x=>Text(Object(Value(x,"ref")),"snapshotId")!=""||Array(Value(x,"refs")).Count>0).ToArray();
                bool freeform=Text(q,"format")=="freeform"&&whole;
                if(freeform){
                    // Free text no longer has included question slots. Its active
                    // attachment refs still belong to the whole saved question.
                    var draft=Object(Value(Object(Value(q,"draftManifest")),"draft"));var roles=Array(Value(draft,"logicalItems",Value(draft,"items"))).Cast<object>().Select(Object).Where(x=>x!=null&&(Text(Object(Value(x,"ref")),"snapshotId")!=""||Text(x,"snapshotId")!="")).ToDictionary(x=>ReferenceKey(ItemReference(x)));
                    foreach(var value in Array(Value(q,"refs"))){var reference=Object(value);string key=ReferenceKey(reference);Dictionary<string,object> role;bool known=roles.TryGetValue(key,out role),asked=!known||Text(role,"kind")=="selection"||Text(role,"ask")=="True";refs.Add(reference);if(asked){askedRefs.Add(key);if(defaultIntent!=null)restoreCandidates.Add(WithRestoreIntent(reference,defaultIntent));}else automaticRefs.Add(key);}
                }
                var chosenImages=(freeform?Enumerable.Empty<Dictionary<string,object>>():imageQuestions.Where(x=>Text(x,"included")!="False")).Concat(additionalQuestions.Where(x=>Text(Object(Value(x,"ref")),"snapshotId")!=""||Array(Value(x,"refs")).Count>0));
                foreach(var question in chosenImages){var associated=Text(Object(Value(question,"ref")),"snapshotId")!=""?new object[]{Value(question,"ref")}:Array(Value(question,"refs")).Cast<object>().ToArray();Dictionary<string,object> intent;if(!partIntents.TryGetValue(Text(question,"id"),out intent))intent=defaultIntent;foreach(var value in associated){var reference=Object(value);refs.Add(reference);askedRefs.Add(ReferenceKey(reference));if(intent!=null)restoreCandidates.Add(WithRestoreIntent(reference,intent));}}
                if(!freeform&&imageQuestions.Length==0&&whole)foreach(var value in Array(Value(q,"refs"))){var reference=Object(value);refs.Add(reference);askedRefs.Add(ReferenceKey(reference));if(defaultIntent!=null)restoreCandidates.Add(WithRestoreIntent(reference,defaultIntent));}
            }
            var sourceRefs=new List<object>();
            if((whole||freeformSupplementary)&&Text(q,"format")=="freeform"){
                var snapshots=new Dictionary<string,Dictionary<string,object>>();
                foreach(var value in Array(Value(q,"refs"))){var reference=new Dictionary<string,object>(Object(value));if(Text(p,"questionImages")=="True"){var source=PlanReferenceSource(reference,snapshots);foreach(string field in new[]{"kind","asset","boardId","label","roi","contextKey"})if(source.ContainsKey(field))reference[field]=source[field];}sourceRefs.Add(reference);}
            }
            // Parts can be removed without consuming independent prose. Raw
            // freeform text has no safe substring relationship to old slots;
            // structured full text must not revive a deselected question.
            string supplementaryText=supplementary?Text(q,"extra"):"";if(freeformSupplementary&&supplementaryText=="")supplementaryText=Text(q,"text");
            var previousQuestion=new {id=Text(q,"id"),title=whole?Text(q,"title"):"",questions=questions,extra=whole?Text(q,"extra"):supplementaryText,text=whole||freeformSupplementary?Text(q,"text"):"",conversationUrl=Text(q,"conversationUrl"),refs=sourceRefs.ToArray(),source=String.Join(" / ",Array(Value(q,"markTitles")).Cast<object>().Select(Convert.ToString))};budget(Json().Serialize(previousQuestion));carry.Add(previousQuestion);
            // An extra part must not switch the whole quotation away from its
            // original text/extra fallback or revive other excluded slots.
            if(additionalQuestions.Length>0){var addedQuestion=new {id=Text(q,"id"),title="",questions=additionalQuestions,extra="",text="",conversationUrl=Text(q,"conversationUrl"),refs=new object[0],source=previousQuestion.source};budget(Json().Serialize(addedQuestion));carry.Add(addedQuestion);}
        }
        if(refs.Count>300)throw new Exception("本次材料较多，请分组整理。");
        automaticRefs.ExceptWith(askedRefs);bool includeBackground=Text(p,"background")=="True";if(!includeBackground)refs=refs.Where(value=>!automaticRefs.Contains(ReferenceKey(Object(value)))).ToList();var selected=ResolveItems(refs,includeBackground,automaticRefs);
        if(selected.Count==0&&carry.Count==0)throw new Exception("请先勾选图片或以前的提问。");
        var restoreRefs=NormalizeRestoreRefs(restoreCandidates,selected);
        return RenderPlan(Guid.NewGuid().ToString("D"),Text(p,"title","课后提问"),selected,carry,refs,Text(p,"background")=="True",restoreRefs,false,"",responseBytes);
    }
    static object Backup(){
        WaitBefore(currentLease);
        lock(gate){RecoverLibrary();All("questions");foreach(var snapshot in All("snapshots"))foreach(var item in Array(Value(snapshot,"items")))AssetBytes(Text(Object(item),"asset"));
            foreach(var plan in All("plans"))foreach(var value in Array(Value(plan,"items"))){var item=Object(value);AttachmentBytes(Text(item,"asset"),Text(item,"format"));}
            All("capture-meta");ReadyCaptures();All("capture-completed");ReadyPlans();All("plan-completed");All("delivery-dispositions");All("selections");All("selection-writes");foreach(var proof in All("media-proofs"))VerifiedMediaProof(Read("snapshots",Text(proof,"id")),proof);
            string folder=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),"智云学习资料备份");Directory.CreateDirectory(folder);
            string zip=Path.Combine(folder,"学习资料-"+DateTime.Now.ToString("yyyyMMdd-HHmmss")+"-"+Guid.NewGuid().ToString("N").Substring(0,6)+".zip"),temp=zip+".tmp";
            try{ZipFile.CreateFromDirectory(Root,temp,CompressionLevel.Optimal,false);using(var file=new FileStream(temp,FileMode.Open,FileAccess.ReadWrite,FileShare.None))file.Flush(true);File.Move(temp,zip);return new {path=zip};}finally{RemoveTemp(temp);}
        }
    }
    public static object Run(string path,Dictionary<string,object> p){
        if(currentLease==null){using(var lease=AcceptLibraryWork(path,p))return lease.Execute(delegate{return Run(path,p);});}
        if(path=="/library/backup"){
            return Backup();
        }
        if(path=="/library/list"&&Text(p,"indexStatus")!="True"){using(new QuestionReadScope())return ListLibrary(p);}
        if(path=="/library/capture-reconcile"){using(new QuestionReadScope())return ReconcileCapture(p);}
        lock(gate){
        if(path=="/library/list")return ListLibrary(p);
        if(path=="/library/selection")return Selection(Text(p,"scope"));
        if(path=="/library/selection-save")return SaveSelection(p);
        if(path=="/library/save")return SaveSnapshot(p);
        if(path=="/library/asset")return SaveCaptureAsset(p);
        if(path=="/library/media-proof")return SaveMediaProof(p);
        if(path=="/library/mark")return Mark(Id(Text(p,"id")));
        if(path=="/library/question"){var question=SelectableQuestion(Read("questions",Text(p,"id")));if(Text(question,"status")=="sent"&&ConfirmedQuestionConversation(question)==""){question["storedStatus"]="sent";question["status"]="unknown";question["confirmationRequired"]=true;}return question;}
        if(path=="/library/image"){
            if(Text(p,"materialId")!=""){var plan=Read("plans",Text(p,"materialId"));var attachment=Array(Value(plan,"items")).Cast<object>().Select(Object).FirstOrDefault(x=>Text(x,"id")==Text(p,"attachmentId"));if(attachment==null)throw new Exception("未找到这张图册原页。");string format=Text(attachment,"format");return new {image="data:image/"+format+";base64,"+Convert.ToBase64String(AttachmentBytes(Text(attachment,"asset"),format)),item=attachment};}
            var snapshot=Read("snapshots",Text(p,"snapshotId"));var item=Array(Value(snapshot,"items")).Cast<object>().Select(Object).FirstOrDefault(x=>Text(x,"id")==Text(p,"itemId"));if(item==null)throw new Exception("未找到这张原图。");return new {image=Text(p,"delivery")=="True"?DeliveryImage(Text(item,"asset")):ImageData(Text(item,"asset")),item=SnapshotItem(snapshot,item)};
        }
        if(path=="/library/compose")return Compose(p);
        if(path=="/library/plan-job")return SavePlanJob(p);
        if(path=="/library/plan-jobs")return PlanJobs(Text(p,"scope"));
        if(path=="/library/plan")return PlanPayload(Id(Text(p,"id")));
        if(path=="/library/plan-job-checkpoint")return CheckpointDelivery(p,true);
        if(path=="/library/plan-job-retire")return RetirePlanJob(p,false);
        if(path=="/library/plan-job-dismiss")return RetirePlanJob(p,true);
        if(path=="/library/capture-list")return CaptureList(p);
        if(path=="/library/capture")return CapturePayload(Id(Text(p,"id")),Text(p,"lightweight")=="True");
        if(path=="/library/capture-checkpoint")return CheckpointDelivery(p,false);
        if(path=="/library/capture-dismiss")return DismissCapture(p);
        if(path=="/library/capture-ack")return AcknowledgeCapture(p,false);
        throw new Exception("不支持的资料操作。");
    }}
}


