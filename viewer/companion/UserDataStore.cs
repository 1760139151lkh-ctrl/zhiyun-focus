using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

// AppData can be redirected when a desktop program is started by an MSIX host.
// Keep the application's own data outside that host's private storage.
static class UserDataStore {
    static readonly object gate=new object();
    static string readyRoot;
    public static string Root {get{EnsureReady();return readyRoot;}}
    public static void EnsureReady(){lock(gate){if(readyRoot==null)readyRoot=Prepare();}}

    static string Prepare(){
        string home=Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
        string target=Path.GetFullPath(Path.Combine(home,".zhiyun-focus"));
        if(!String.Equals(Path.GetDirectoryName(target),home,StringComparison.OrdinalIgnoreCase))throw new IOException("学习资料目录无效。");
        if(Directory.Exists(target))return target;
        var sources=LegacySources(home);
        if(sources.Count==0){Directory.CreateDirectory(target);return target;}

        var original=Inventory(sources[0]);
        foreach(string other in sources.Skip(1))if(!SameFiles(original,Inventory(other)))
            throw new IOException("发现多份不同的旧学习资料，未自动合并。原目录均已保留： "+String.Join("；",sources.ToArray()));

        string stage=Path.GetFullPath(target+".import-"+Guid.NewGuid().ToString("N"));
        if(!String.Equals(Path.GetDirectoryName(stage),home,StringComparison.OrdinalIgnoreCase)||!Path.GetFileName(stage).StartsWith(".zhiyun-focus.import-",StringComparison.Ordinal))throw new IOException("资料迁移目录无效。");
        Directory.CreateDirectory(stage);
        try{
            foreach(string relative in original.Keys){
                string source=Path.Combine(sources[0],relative),destination=Path.Combine(stage,relative);
                Directory.CreateDirectory(Path.GetDirectoryName(destination));
                using(var input=new FileStream(source,FileMode.Open,FileAccess.Read,FileShare.Read))
                using(var output=new FileStream(destination,FileMode.CreateNew,FileAccess.Write,FileShare.None)){input.CopyTo(output);output.Flush(true);}
                File.SetLastWriteTimeUtc(destination,File.GetLastWriteTimeUtc(source));
            }
            if(!SameFiles(original,Inventory(stage))||sources.Any(source=>!SameFiles(original,Inventory(source))))throw new IOException("复制期间旧资料发生变化，未切换资料目录。");
            byte[] record=Encoding.UTF8.GetBytes("Completed UTC: "+DateTime.UtcNow.ToString("o")+"\r\nFiles copied: "+original.Count+"\r\nSources:\r\n"+String.Join("\r\n",sources.ToArray())+"\r\n");
            using(var file=new FileStream(Path.Combine(stage,"migration.txt"),FileMode.CreateNew,FileAccess.Write,FileShare.None)){file.Write(record,0,record.Length);file.Flush(true);}
            // Both absolute paths were checked above. Only this newly created,
            // verified staging directory is moved; legacy data is never moved.
            Directory.Move(stage,target);
            return target;
        }catch(Exception error){throw new IOException("学习资料迁移未完成，原资料保留；复制结果位于 "+stage+"。 "+error.Message,error);}
    }

    static List<string> LegacySources(string home){
        var candidates=new List<string>{Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"ZhiyunFocus")};
        string packages=Path.Combine(home,@"AppData\Local\Packages");
        if(Directory.Exists(packages))foreach(string package in Directory.GetDirectories(packages,"OpenAI.Codex_*"))
            candidates.Add(Path.Combine(package,@"LocalCache\Local\ZhiyunFocus"));
        candidates=candidates.Where(Directory.Exists).Select(Path.GetFullPath).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        // A primary JSON can be missing while its recoverable backup, original
        // pixels or accepted delivery still remain. Never mistake that store
        // for an empty installation and start a replacement library.
        var records=candidates.Where(path=>{
            string folder=Path.Combine(path,"StudyLibrary");return Directory.Exists(folder)&&Inventory(path).Keys.Any(name=>name.StartsWith("StudyLibrary\\",StringComparison.OrdinalIgnoreCase));
        }).ToList();
        if(records.Count>0)return records;
        return candidates.Where(path=>Directory.Exists(Path.Combine(path,"ChatGPT"))&&Inventory(path).Any(file=>file.Key.StartsWith("ChatGPT\\",StringComparison.OrdinalIgnoreCase))).ToList();
    }

    static Dictionary<string,string> Inventory(string root){
        root=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
        var result=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
        var directories=new Stack<string>();directories.Push(root);
        while(directories.Count>0){
            string directory=directories.Pop();
            if((File.GetAttributes(directory)&FileAttributes.ReparsePoint)!=0)throw new IOException("旧资料含目录链接，未自动复制： "+directory);
            foreach(string child in Directory.GetDirectories(directory))directories.Push(child);
            foreach(string file in Directory.GetFiles(directory)){
                if((File.GetAttributes(file)&FileAttributes.ReparsePoint)!=0)throw new IOException("旧资料含文件链接，未自动复制： "+file);
                string full=Path.GetFullPath(file),prefix=root+Path.DirectorySeparatorChar;
                if(!full.StartsWith(prefix,StringComparison.OrdinalIgnoreCase))throw new IOException("旧资料路径超出原目录。");
                using(var input=new FileStream(full,FileMode.Open,FileAccess.Read,FileShare.Read))
                using(var sha=SHA256.Create())result.Add(full.Substring(prefix.Length),BitConverter.ToString(sha.ComputeHash(input)).Replace("-",""));
            }
        }
        return result;
    }

    static bool SameFiles(Dictionary<string,string> left,Dictionary<string,string> right){
        return left.Count==right.Count&&left.All(pair=>right.ContainsKey(pair.Key)&&right[pair.Key]==pair.Value);
    }
}
