using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;

// One shared UIA lane. A hung provider occupies that lane; timing out never
// creates another worker. Fast native probes do not use this class.
sealed class ViewportResolverCache<T> where T:class {
    public sealed class Result {public string State;public T Value;public Exception Error;}
    sealed class Entry {public T Value;public Exception Error;public long Expires;}
    sealed class Work {public string Key;public readonly ManualResetEventSlim Done=new ManualResetEventSlim(false);}
    readonly object gate=new object();readonly Dictionary<string,Entry> cache=new Dictionary<string,Entry>();
    readonly Stopwatch clock=Stopwatch.StartNew();readonly Func<long> now;Work running;int started;
    public ViewportResolverCache(Func<long> time=null){now=time??delegate{return clock.ElapsedMilliseconds;};}
    public int Started {get{lock(gate)return started;}}
    public bool InFlight {get{lock(gate)return running!=null;}}
    public Result Peek(string key,Func<T,bool> valid) {
        Entry entry;
        lock(gate){if(!cache.TryGetValue(key,out entry)||entry.Expires<=now()){cache.Remove(key);return new Result{State="pending"};}}
        if(entry.Error!=null)return new Result{State="failed",Error=entry.Error};
        if(!valid(entry.Value)){lock(gate)cache.Remove(key);return new Result{State="pending"};}
        return new Result{State="ready",Value=entry.Value};
    }
    public Result Resolve(string key,Func<T> provider,Func<T,bool> valid,int waitMilliseconds=0) {
        var found=Peek(key,valid);if(found.State!="pending")return found;
        Work work=null;bool start=false;Entry completed=null;
        lock(gate){
            if(cache.TryGetValue(key,out completed)&&completed.Expires>now()){}
            else if(running==null){work=running=new Work{Key=key};started++;start=true;}
            else work=running;
        }
        if(completed!=null&&completed.Expires>now()){
            if(completed.Error!=null)return new Result{State="failed",Error=completed.Error};
            if(valid(completed.Value))return new Result{State="ready",Value=completed.Value};
            lock(gate)cache.Remove(key);return new Result{State="pending"};
        }
        if(start)Task.Run(delegate{
            T value=null;Exception error=null;
            try{value=provider();if(value==null||!valid(value))throw new Exception("课程内容位置已变化，请重试。");}catch(Exception e){error=e;}
            lock(gate){
                var expired=new List<string>();foreach(var p in cache)if(p.Value.Expires<=now())expired.Add(p.Key);foreach(var k in expired)cache.Remove(k);
                if(cache.Count>=32)cache.Clear();
                cache[work.Key]=new Entry{Value=value,Error=error,Expires=now()+(error==null?1500:400)};
                if(running==work)running=null;
            }
            work.Done.Set();
        });
        // Never wait from a UI timer or input hook. Only the capture worker may
        // choose a short bounded wait, while the provider stays on its sole lane.
        if(work!=null&&work.Key==key&&waitMilliseconds>0)work.Done.Wait(Math.Min(300,waitMilliseconds));
        return Peek(key,valid);
    }
}
