using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Threading.Tasks;
using System.Diagnostics;
using System.ComponentModel;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public sealed class MohassanRunResult {
 public int? exitCode {get;set;} public string stdout {get;set;}=""; public string stderr {get;set;}="";
 public bool timedOut {get;set;} public long durationMs {get;set;} public bool isolationVerified {get;set;}
 public bool tokenIsAppContainer {get;set;} public int integrityRid {get;set;} public int capabilityCount {get;set;}
 public bool jobAssigned {get;set;}
 public uint activeProcessLimit {get;set;} public ulong memoryLimitBytes {get;set;} public bool jobLimitsVerified {get;set;}
}
public static class MohassanNativeSandbox {
 [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
 [StructLayout(LayoutKind.Sequential)] struct SC {public IntPtr sid,caps;public uint count,reserved;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct SI {public int cb; public string reserved,desktop,title; public int x,y,xSize,ySize,xChars,yChars,fill,flags;public short show,reserved2;public IntPtr reservedPtr,input,output,error;}
 [StructLayout(LayoutKind.Sequential)] struct SIX {public SI startup; public IntPtr attributes;}
 [StructLayout(LayoutKind.Sequential)] struct PI {public IntPtr process,thread;public uint processId,threadId;}
 [StructLayout(LayoutKind.Sequential)] struct BL {public long processTime,jobTime;public uint flags;public UIntPtr minWorking,maxWorking;public uint activeProcesses;public UIntPtr affinity;public uint priority,scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct IO {public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes;}
 [StructLayout(LayoutKind.Sequential)] struct EL {public BL basic;public IO io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}
 [StructLayout(LayoutKind.Sequential)] struct CPU {public uint flags,rate;}
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string n,string d,string x,IntPtr caps,uint count,out IntPtr sid);
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string n);
 [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processSA,IntPtr threadSA,bool inherit,uint flags,IntPtr env,string cwd,ref SIX startup,out PI info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SA security,int size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string name,uint access,uint share,ref SA security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,IntPtr value,uint length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,IntPtr value,uint length,out uint returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int info,IntPtr buffer,int size,out int returned);
 [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
 [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string s,uint rev,out IntPtr sd,out uint size);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool SetFileSecurity(string name,uint info,IntPtr sd);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 static void Check(bool ok,string step){if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error(),step);}
 static void Close(ref IntPtr p){if(p!=IntPtr.Zero&&p!=new IntPtr(-1)){CloseHandle(p);p=IntPtr.Zero;}}
 static string Quote(string s){var b=new StringBuilder("\"");int slashes=0;foreach(char c in s){if(c=='\\'){slashes++;continue;}if(c=='\"'){b.Append('\\',slashes*2+1);b.Append(c);}else{b.Append('\\',slashes);b.Append(c);}slashes=0;}b.Append('\\',slashes*2);return b.Append('"').ToString();}
 static void Grant(string path,SecurityIdentifier sid,FileSystemRights rights){var dir=new DirectoryInfo(path);var acl=dir.GetAccessControl();acl.AddAccessRule(new FileSystemAccessRule(sid,rights,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));dir.SetAccessControl(acl);}
 static void LowLabel(string path){IntPtr sd;uint size;Check(ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;OICI;NW;;;LW)",1,out sd,out size),"Create low-integrity label");try{Check(SetFileSecurity(path,0x10,sd),"Set low-integrity temporary directory");}finally{LocalFree(sd);}}
 static IntPtr TokenInfo(IntPtr token,int kind){int size;GetTokenInformation(token,kind,IntPtr.Zero,0,out size);var data=Marshal.AllocHGlobal(size);try{Check(GetTokenInformation(token,kind,data,size,out size),"Read isolation token");return data;}catch{Marshal.FreeHGlobal(data);throw;}}
 static Task<string> Drain(IntPtr pipe){return Task.Run(()=>{using(var safe=new SafeFileHandle(pipe,true))using(var file=new FileStream(safe,FileAccess.Read))using(var bytes=new MemoryStream()){var block=new byte[4096];int read;while((read=file.Read(block,0,block.Length))>0){int keep=Math.Min(read,65536-(int)bytes.Length);if(keep>0)bytes.Write(block,0,keep);}return Encoding.UTF8.GetString(bytes.ToArray());}});}
 static void SetJob<T>(IntPtr job,int kind,T value) where T:struct{int size=Marshal.SizeOf<T>();var p=Marshal.AllocHGlobal(size);try{Marshal.StructureToPtr(value,p,false);Check(SetInformationJobObject(job,kind,p,(uint)size),"Apply job resource limit");}finally{Marshal.FreeHGlobal(p);}}
 public static MohassanRunResult Run(string node,string work,string temp,string[] arguments,int timeoutMs,string cancelPath){
  string profile="Mohassan.Run."+Guid.NewGuid().ToString("N");IntPtr sid=IntPtr.Zero,attrs=IntPtr.Zero,caps=IntPtr.Zero,handles=IntPtr.Zero,env=IntPtr.Zero,job=IntPtr.Zero;
  IntPtr outRead=IntPtr.Zero,outWrite=IntPtr.Zero,errRead=IntPtr.Zero,errWrite=IntPtr.Zero,input=IntPtr.Zero,token=IntPtr.Zero;PI process=new PI();bool createdProfile=false,attributesInitialized=false;
  var result=new MohassanRunResult();var watch=new Stopwatch();
  try{
   int hr=CreateAppContainerProfile(profile,"Mohassan isolated test","Ephemeral zero-capability test execution",IntPtr.Zero,0,out sid);if(hr<0)Marshal.ThrowExceptionForHR(hr);createdProfile=true;
   var identity=new SecurityIdentifier(sid);Grant(work,identity,FileSystemRights.ReadAndExecute);Grant(Path.GetDirectoryName(node),identity,FileSystemRights.ReadAndExecute);Grant(temp,identity,FileSystemRights.Modify);LowLabel(temp);
   // Ancestors get traversal/read only, never DELETE_CHILD or inherited write access.
   string root=Directory.GetParent(work).FullName;var rootDir=new DirectoryInfo(root);var rootAcl=rootDir.GetAccessControl();rootAcl.AddAccessRule(new FileSystemAccessRule(identity,FileSystemRights.ReadAndExecute,AccessControlType.Allow));rootDir.SetAccessControl(rootAcl);
   var sa=new SA{length=Marshal.SizeOf<SA>(),inherit=true};Check(CreatePipe(out outRead,out outWrite,ref sa,0),"Create stdout pipe");Check(SetHandleInformation(outRead,1,0),"Protect stdout handle");Check(CreatePipe(out errRead,out errWrite,ref sa,0),"Create stderr pipe");Check(SetHandleInformation(errRead,1,0),"Protect stderr handle");input=CreateFile("NUL",0x80000000,3,ref sa,3,0,IntPtr.Zero);if(input==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error(),"Open input sink");
   IntPtr bytes=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref bytes);attrs=Marshal.AllocHGlobal(bytes);Check(InitializeProcThreadAttributeList(attrs,2,0,ref bytes),"Initialize process attributes");attributesInitialized=true;
   var sc=new SC{sid=sid,caps=IntPtr.Zero,count=0};caps=Marshal.AllocHGlobal(Marshal.SizeOf<SC>());Marshal.StructureToPtr(sc,caps,false);Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20009),caps,new IntPtr(Marshal.SizeOf<SC>()),IntPtr.Zero,IntPtr.Zero),"Set AppContainer security capabilities");
   handles=Marshal.AllocHGlobal(IntPtr.Size*3);Marshal.WriteIntPtr(handles,0,input);Marshal.WriteIntPtr(handles,IntPtr.Size,outWrite);Marshal.WriteIntPtr(handles,IntPtr.Size*2,errWrite);Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"Limit inherited handles");
   var si=new SIX{startup=new SI{cb=Marshal.SizeOf<SIX>(),flags=0x100,input=input,output=outWrite,error=errWrite},attributes=attrs};
   // Windows redirects AppContainer TEMP below LOCALAPPDATA/Packages/<profile>/AC/Temp.
   Directory.CreateDirectory(Path.Combine(temp,"Packages",profile.ToLowerInvariant(),"AC","Temp"));
   string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows);string environment="HOME="+temp+"\0LOCALAPPDATA="+temp+"\0PATH="+Path.GetDirectoryName(node)+"\0SystemRoot="+windows+"\0TEMP="+temp+"\0TMP="+temp+"\0WINDIR="+windows+"\0\0";env=Marshal.StringToHGlobalUni(environment);
   job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error(),"Create resource job");SetJob(job,9,new EL{basic=new BL{flags=0x2000|0x100|0x200|0x8,activeProcesses=1},processMemory=new UIntPtr(512u*1024*1024),jobMemory=new UIntPtr(512u*1024*1024)});SetJob(job,15,new CPU{flags=0x1|0x4,rate=2500});
   var command=new StringBuilder(string.Join(" ",new[]{node}.Concat(arguments).Select(Quote)));Check(CreateProcess(node,command,IntPtr.Zero,IntPtr.Zero,true,0x80000|0x4|0x08000000|0x400,env,work,ref si,out process),"Create suspended AppContainer process");
   Check(AssignProcessToJobObject(job,process.process),"Assign process to resource job");result.jobAssigned=true;
   IntPtr jobData=Marshal.AllocHGlobal(Marshal.SizeOf<EL>());try{uint returned;Check(QueryInformationJobObject(job,9,jobData,(uint)Marshal.SizeOf<EL>(),out returned),"Verify native job resource limits");var limits=Marshal.PtrToStructure<EL>(jobData);result.activeProcessLimit=limits.basic.activeProcesses;result.memoryLimitBytes=limits.processMemory.ToUInt64();result.jobLimitsVerified=result.activeProcessLimit==1&&result.memoryLimitBytes==512u*1024*1024&&(limits.basic.flags&0x2000)!=0&&(limits.basic.flags&(0x800|0x1000))==0;}finally{Marshal.FreeHGlobal(jobData);}
   Check(OpenProcessToken(process.process,8,out token),"Open child token");
   IntPtr info=TokenInfo(token,29);try{result.tokenIsAppContainer=Marshal.ReadInt32(info)!=0;}finally{Marshal.FreeHGlobal(info);}info=TokenInfo(token,25);try{var label=Marshal.ReadIntPtr(info);byte count=Marshal.ReadByte(GetSidSubAuthorityCount(label));result.integrityRid=Marshal.ReadInt32(GetSidSubAuthority(label,(uint)(count-1)));}finally{Marshal.FreeHGlobal(info);}info=TokenInfo(token,30);try{result.capabilityCount=Marshal.ReadInt32(info);}finally{Marshal.FreeHGlobal(info);}
   info=TokenInfo(token,31);bool ownSid;try{ownSid=new SecurityIdentifier(Marshal.ReadIntPtr(info)).Value==identity.Value;}finally{Marshal.FreeHGlobal(info);}
   result.isolationVerified=result.tokenIsAppContainer&&result.integrityRid<=4096&&result.capabilityCount==0&&result.jobAssigned&&result.jobLimitsVerified&&ownSid;if(!result.isolationVerified)throw new InvalidOperationException("OS token isolation checks failed before execution.");
   Close(ref outWrite);Close(ref errWrite);Close(ref input);var stdout=Drain(outRead);outRead=IntPtr.Zero;var stderr=Drain(errRead);errRead=IntPtr.Zero;watch.Start();if(ResumeThread(process.thread)==0xFFFFFFFF)throw new Win32Exception(Marshal.GetLastWin32Error(),"Resume isolated process");
   bool cancelled=false;while(WaitForSingleObject(process.process,50)==0x102){if(File.Exists(cancelPath)){cancelled=true;TerminateJobObject(job,130);break;}if(watch.ElapsedMilliseconds>=timeoutMs){result.timedOut=true;TerminateJobObject(job,124);break;}}WaitForSingleObject(process.process,2000);uint exit;GetExitCodeProcess(process.process,out exit);result.exitCode=result.timedOut?124:cancelled?130:(int)exit;TerminateJobObject(job,0);watch.Stop();result.durationMs=watch.ElapsedMilliseconds;Task.WaitAll(new Task[]{stdout,stderr},2000);result.stdout=stdout.IsCompletedSuccessfully?stdout.Result:"";result.stderr=stderr.IsCompletedSuccessfully?stderr.Result:"";return result;
  }finally{
   if(process.process!=IntPtr.Zero){TerminateProcess(process.process,125);WaitForSingleObject(process.process,2000);}Close(ref token);Close(ref process.thread);Close(ref process.process);Close(ref job);Close(ref outRead);Close(ref outWrite);Close(ref errRead);Close(ref errWrite);Close(ref input);
   if(attributesInitialized)DeleteProcThreadAttributeList(attrs);if(attrs!=IntPtr.Zero)Marshal.FreeHGlobal(attrs);if(caps!=IntPtr.Zero)Marshal.FreeHGlobal(caps);if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);if(env!=IntPtr.Zero)Marshal.FreeHGlobal(env);if(sid!=IntPtr.Zero)FreeSid(sid);if(createdProfile)DeleteAppContainerProfile(profile);
  }
 }
}
