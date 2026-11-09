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
 public int? exitCode {get;set;} public string stdout {get;set;} public string stderr {get;set;}
 public bool timedOut {get;set;} public long durationMs {get;set;} public bool isolationVerified {get;set;}
 public bool tokenIsAppContainer {get;set;} public int integrityRid {get;set;} public int capabilityCount {get;set;}
 public bool jobAssigned {get;set;}
 public uint activeProcessLimit {get;set;} public ulong memoryLimitBytes {get;set;} public bool jobLimitsVerified {get;set;}
 public uint uiRestrictionMask {get;set;} public bool uiRestrictionsVerified {get;set;}
 public bool lowPrivilegeRequested {get;set;} public bool tokenIsLessPrivilegedAppContainer {get;set;}
 public bool outputComplete {get;set;}
 public ulong quotaVolumeBytes {get;set;}
 public string capabilitySid {get;set;}
}
public static class MohassanNativeSandbox {
 // LPAC runs carry exactly this one capability (registryRead), approved by the owner on 2026-11-09.
 // Without it ws2_32 cannot read HKLM\...\WinSock2\Parameters and Node aborts with WSAStartup 10107.
 // No network, file or other capability is ever added; ordinary AppContainer runs keep zero.
 public const string RegistryReadCapability="S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-3456934681";
 [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
 [StructLayout(LayoutKind.Sequential)] struct SC {public IntPtr sid,caps;public uint count,reserved;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct SI {public int cb; public string reserved,desktop,title; public int x,y,xSize,ySize,xChars,yChars,fill,flags;public short show,reserved2;public IntPtr reservedPtr,input,output,error;}
 [StructLayout(LayoutKind.Sequential)] struct SIX {public SI startup; public IntPtr attributes;}
 [StructLayout(LayoutKind.Sequential)] struct PI {public IntPtr process,thread;public uint processId,threadId;}
 [StructLayout(LayoutKind.Sequential)] struct BL {public long processTime,jobTime;public uint flags;public UIntPtr minWorking,maxWorking;public uint activeProcesses;public UIntPtr affinity;public uint priority,scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct IO {public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes;}
 [StructLayout(LayoutKind.Sequential)] struct EL {public BL basic;public IO io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}
 [StructLayout(LayoutKind.Sequential)] struct CPU {public uint flags,rate;}
 [StructLayout(LayoutKind.Sequential)] struct UI {public uint restrictions;}
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string n,string d,string x,IntPtr caps,uint count,out IntPtr sid);
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string n);
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int GetAppContainerFolderPath(string sid,out IntPtr path);
 [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr p);
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
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern int GetCurrentPackageFullName(ref int length,StringBuilder name);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumePathName(string path,StringBuilder volume,int length);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetDiskFreeSpaceEx(string path,out ulong free,out ulong total,out ulong totalFree);
 static void Check(bool ok,string step){if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error(),step);}
 static void Close(ref IntPtr p){if(p!=IntPtr.Zero&&p!=new IntPtr(-1)){CloseHandle(p);p=IntPtr.Zero;}}
 static string Quote(string s){var b=new StringBuilder("\"");int slashes=0;foreach(char c in s){if(c=='\\'){slashes++;continue;}if(c=='\"'){b.Append('\\',slashes*2+1);b.Append(c);}else{b.Append('\\',slashes);b.Append(c);}slashes=0;}b.Append('\\',slashes*2);return b.Append('"').ToString();}
 static void Grant(string path,SecurityIdentifier sid,FileSystemRights rights){var dir=new DirectoryInfo(path);var acl=dir.GetAccessControl();acl.AddAccessRule(new FileSystemAccessRule(sid,rights,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));dir.SetAccessControl(acl);}
 // CreateProcess needs the profile to exist, but its AC folder is writable by the container on the
 // system volume, outside any disk quota. A deny ACE for the package SID was measured to have no
 // effect, so the container's allow entries are removed and the DACL is protected before the process exists.
 static void RevokeProfileStorage(SecurityIdentifier sid){
  IntPtr native;int hr=GetAppContainerFolderPath(sid.Value,out native);if(hr<0)Marshal.ThrowExceptionForHR(hr);
  string path;try{path=Marshal.PtrToStringUni(native);}finally{CoTaskMemFree(native);}
  var owner=WindowsIdentity.GetCurrent().User;var system=new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null);
  var folders=new[]{path}.Concat(Directory.GetDirectories(path,"*",SearchOption.AllDirectories)).ToArray();
  // Deepest first, so the container cannot reach a child through a parent still being changed.
  foreach(string folder in folders.Reverse()){var dir=new DirectoryInfo(folder);var acl=new DirectorySecurity();acl.SetAccessRuleProtection(true,false);foreach(var id in new[]{owner,system})acl.AddAccessRule(new FileSystemAccessRule(id,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));dir.SetAccessControl(acl);}
 }
 static string VolumeOf(string path){var name=new StringBuilder(1024);Check(GetVolumePathName(path,name,name.Capacity),"Read volume path");return name.ToString().TrimEnd(Path.DirectorySeparatorChar).ToLowerInvariant();}
 // A hard quota is the capacity Windows reports for a volume that holds every writable path.
 // An ordinary folder shares the system volume and is refused before any process exists.
 static ulong VerifyQuotaVolume(string temp,string output,string work,long quotaBytes){
  string volume=VolumeOf(temp);
  if(String.IsNullOrEmpty(output)||VolumeOf(output)!=volume)throw new InvalidOperationException("Every writable path must be on the quota volume.");
  if(volume==VolumeOf(Environment.GetFolderPath(Environment.SpecialFolder.Windows))||volume==VolumeOf(work))throw new InvalidOperationException("The quota path is not a separate bounded volume.");
  ulong free,total,totalFree;Check(GetDiskFreeSpaceEx(temp,out free,out total,out totalFree),"Read quota volume capacity");
  if(total==0||total>(ulong)quotaBytes)throw new InvalidOperationException("The quota volume exceeds the declared bound.");
  return total;
 }
 static void LowLabel(string path){IntPtr sd;uint size;Check(ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;OICI;NW;;;LW)",1,out sd,out size),"Create low-integrity label");try{Check(SetFileSecurity(path,0x10,sd),"Set low-integrity temporary directory");}finally{LocalFree(sd);}}
 static IntPtr TokenInfo(IntPtr token,int kind){int size;GetTokenInformation(token,kind,IntPtr.Zero,0,out size);var data=Marshal.AllocHGlobal(size);try{Check(GetTokenInformation(token,kind,data,size,out size),"Read isolation token class "+kind);return data;}catch{Marshal.FreeHGlobal(data);throw;}}
 // GetTokenInformation rejects TokenIsLessPrivilegedAppContainer (46) with Win32 87 on this
 // Windows build, so the kernel's own LPAC marker is read from TokenSecurityAttributes (39):
 // the WIN://NOALLAPPPKG attribute. A missing attribute means an ordinary AppContainer.
 static bool IsLpac(IntPtr token){
  if(IntPtr.Size!=8)throw new InvalidOperationException("LPAC token parsing requires a 64-bit host.");
  IntPtr info=TokenInfo(token,39);try{
   int count=Marshal.ReadInt32(info,4);if(count<0||count>256)throw new InvalidOperationException("Token security attribute count is invalid.");
   IntPtr entry=Marshal.ReadIntPtr(info,8);
   // TOKEN_SECURITY_ATTRIBUTE_V1 on x64: UNICODE_STRING Name@0 (Buffer@8), ValueType@16, ValueCount@24, Values@32, size 40.
   for(int i=0;i<count;i++,entry=IntPtr.Add(entry,40)){
    int nameBytes=Marshal.ReadInt16(entry,0)&0xffff;
    if(Marshal.PtrToStringUni(Marshal.ReadIntPtr(entry,8),nameBytes/2)!="WIN://NOALLAPPPKG")continue;
    int type=Marshal.ReadInt16(entry,16),values=Marshal.ReadInt32(entry,24);
    if((type!=1&&type!=2)||values!=1)throw new InvalidOperationException("LPAC token attribute has an invalid shape.");
    long flag=Marshal.ReadInt64(Marshal.ReadIntPtr(entry,32));if(flag!=0&&flag!=1)throw new InvalidOperationException("LPAC token attribute has an invalid value.");return flag==1;
   }
   return false;
  }finally{Marshal.FreeHGlobal(info);}
 }
 sealed class Drained {public string text;public bool truncated;}
 static Task<Drained> Drain(IntPtr pipe){return Task.Run(()=>{using(var safe=new SafeFileHandle(pipe,true))using(var file=new FileStream(safe,FileAccess.Read))using(var bytes=new MemoryStream()){var block=new byte[4096];int read;bool truncated=false;while((read=file.Read(block,0,block.Length))>0){int keep=Math.Min(read,65536-(int)bytes.Length);if(keep>0)bytes.Write(block,0,keep);if(keep<read)truncated=true;}return new Drained{text=Encoding.UTF8.GetString(bytes.ToArray()),truncated=truncated};}});}
 static void SetJob<T>(IntPtr job,int kind,T value) where T:struct{int size=Marshal.SizeOf<T>();var p=Marshal.AllocHGlobal(size);try{Marshal.StructureToPtr(value,p,false);Check(SetInformationJobObject(job,kind,p,(uint)size),"Apply job resource limit");}finally{Marshal.FreeHGlobal(p);}}
 public static MohassanRunResult Run(string node,string work,string temp,string[] arguments,int timeoutMs,string cancelPath,string output,int memoryMb,bool lowPrivilege,bool publicResourceProbe,long quotaBytes){
  string profile="Mohassan.Run."+Guid.NewGuid().ToString("N");IntPtr sid=IntPtr.Zero,attrs=IntPtr.Zero,caps=IntPtr.Zero,handles=IntPtr.Zero,env=IntPtr.Zero,job=IntPtr.Zero;
  IntPtr lpacPolicy=IntPtr.Zero,capabilityArray=IntPtr.Zero,capabilitySid=IntPtr.Zero;
  IntPtr outRead=IntPtr.Zero,outWrite=IntPtr.Zero,errRead=IntPtr.Zero,errWrite=IntPtr.Zero,input=IntPtr.Zero,token=IntPtr.Zero;PI process=new PI();bool createdProfile=false,attributesInitialized=false;
  var result=new MohassanRunResult();var watch=new Stopwatch();
  try{
   if(memoryMb<16||memoryMb>512)throw new InvalidOperationException("Invalid job memory bound.");
   if(File.Exists(cancelPath))throw new OperationCanceledException("Cancelled before native process creation.");
   ulong memoryBytes=(ulong)memoryMb*1024*1024;result.lowPrivilegeRequested=lowPrivilege;if(quotaBytes>0)result.quotaVolumeBytes=VerifyQuotaVolume(temp,output,work,quotaBytes);
   // A packaged host creates a child AppContainer that inherits package capabilities.
   int packageLength=0;if(GetCurrentPackageFullName(ref packageLength,null)!=15700)throw new InvalidOperationException("Sandbox host must be unpackaged.");
   int hr=CreateAppContainerProfile(profile,"Mohassan isolated test","Ephemeral pinned-capability test execution",IntPtr.Zero,0,out sid);if(hr<0)Marshal.ThrowExceptionForHR(hr);createdProfile=true;
   var identity=new SecurityIdentifier(sid);RevokeProfileStorage(identity);Grant(work,identity,FileSystemRights.ReadAndExecute);Grant(Path.GetDirectoryName(node),identity,FileSystemRights.ReadAndExecute);Grant(temp,identity,FileSystemRights.Modify);LowLabel(temp);
   if(!String.IsNullOrEmpty(output)){Grant(output,identity,FileSystemRights.Modify);LowLabel(output);}
   // Ancestors get traversal/read only, never DELETE_CHILD or inherited write access.
   string root=Directory.GetParent(work).FullName;var rootDir=new DirectoryInfo(root);var rootAcl=rootDir.GetAccessControl();rootAcl.AddAccessRule(new FileSystemAccessRule(identity,FileSystemRights.ReadAndExecute,AccessControlType.Allow));rootDir.SetAccessControl(rootAcl);
   // A synthetic resource exists only under this run's newly created TEMP root.
   // Its broad package read ACL is deliberate positive-control data, never a
   // grant on a host project, system directory, user file or existing resource.
   string publicResource="";
   if(publicResourceProbe){string publicDir=Path.Combine(root,"public-probe");Directory.CreateDirectory(publicDir);publicResource=Path.Combine(publicDir,"synthetic.txt");File.WriteAllText(publicResource,"synthetic-public-resource");Grant(publicDir,new SecurityIdentifier("S-1-15-2-1"),FileSystemRights.ReadAndExecute);}
   var sa=new SA{length=Marshal.SizeOf<SA>(),inherit=true};Check(CreatePipe(out outRead,out outWrite,ref sa,0),"Create stdout pipe");Check(SetHandleInformation(outRead,1,0),"Protect stdout handle");Check(CreatePipe(out errRead,out errWrite,ref sa,0),"Create stderr pipe");Check(SetHandleInformation(errRead,1,0),"Protect stderr handle");input=CreateFile("NUL",0x80000000,3,ref sa,3,0,IntPtr.Zero);if(input==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error(),"Open input sink");
   IntPtr bytes=IntPtr.Zero;int attributeCount=lowPrivilege?3:2;InitializeProcThreadAttributeList(IntPtr.Zero,attributeCount,0,ref bytes);attrs=Marshal.AllocHGlobal(bytes);Check(InitializeProcThreadAttributeList(attrs,attributeCount,0,ref bytes),"Initialize process attributes");attributesInitialized=true;
   uint capabilityCount=0;if(lowPrivilege){var pinned=new SecurityIdentifier(RegistryReadCapability);var binary=new byte[pinned.BinaryLength];pinned.GetBinaryForm(binary,0);capabilitySid=Marshal.AllocHGlobal(binary.Length);Marshal.Copy(binary,0,capabilitySid,binary.Length);capabilityArray=Marshal.AllocHGlobal(IntPtr.Size*2);Marshal.WriteIntPtr(capabilityArray,0,capabilitySid);Marshal.WriteInt64(capabilityArray,IntPtr.Size,0x4);capabilityCount=1;}var sc=new SC{sid=sid,caps=capabilityArray,count=capabilityCount};caps=Marshal.AllocHGlobal(Marshal.SizeOf<SC>());Marshal.StructureToPtr(sc,caps,false);Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20009),caps,new IntPtr(Marshal.SizeOf<SC>()),IntPtr.Zero,IntPtr.Zero),"Set AppContainer security capabilities");
   // PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, opt out of the
   // broad ALL APPLICATION PACKAGES group. No host ACL or global policy changes.
   if(lowPrivilege){lpacPolicy=Marshal.AllocHGlobal(4);Marshal.WriteInt32(lpacPolicy,1);Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x2000f),lpacPolicy,new IntPtr(4),IntPtr.Zero,IntPtr.Zero),"Request LPAC token");}
   handles=Marshal.AllocHGlobal(IntPtr.Size*3);Marshal.WriteIntPtr(handles,0,input);Marshal.WriteIntPtr(handles,IntPtr.Size,outWrite);Marshal.WriteIntPtr(handles,IntPtr.Size*2,errWrite);Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"Limit inherited handles");
   var si=new SIX{startup=new SI{cb=Marshal.SizeOf<SIX>(),flags=0x100,input=input,output=outWrite,error=errWrite},attributes=attrs};
   // Windows redirects AppContainer TEMP below LOCALAPPDATA/Packages/<profile>/AC/Temp.
   Directory.CreateDirectory(Path.Combine(temp,"Packages",profile.ToLowerInvariant(),"AC","Temp"));
   string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows);string environment="HOME="+temp+"\0LOCALAPPDATA="+temp+"\0PATH="+Path.GetDirectoryName(node)+"\0SystemRoot="+windows+"\0TEMP="+temp+"\0TMP="+temp+"\0WINDIR="+windows+"\0";
   if(!String.IsNullOrEmpty(output))environment+="MOHASSAN_INPUT_PATH="+Path.Combine(work,".mohassan-input.json")+"\0MOHASSAN_OUTPUT_DIR="+output+"\0";if(publicResourceProbe)environment+="MOHASSAN_PUBLIC_RESOURCE="+publicResource+"\0";env=Marshal.StringToHGlobalUni(environment+"\0");
   job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error(),"Create resource job");SetJob(job,9,new EL{basic=new BL{flags=0x2000|0x100|0x200|0x8,activeProcesses=1},processMemory=new UIntPtr(memoryBytes),jobMemory=new UIntPtr(memoryBytes)});SetJob(job,15,new CPU{flags=0x1|0x4,rate=2500});
   // Restrict handles, clipboard reads/writes, system/display settings, global atoms,
   // desktop creation/switching and ExitWindows. Query the OS value before resuming.
   SetJob(job,4,new UI{restrictions=0xff});
   var command=new StringBuilder(string.Join(" ",new[]{node}.Concat(arguments).Select(Quote)));Check(CreateProcess(node,command,IntPtr.Zero,IntPtr.Zero,true,0x80000|0x4|0x08000000|0x400,env,work,ref si,out process),"Create suspended AppContainer process");
   Check(AssignProcessToJobObject(job,process.process),"Assign process to resource job");result.jobAssigned=true;
   IntPtr jobData=Marshal.AllocHGlobal(Marshal.SizeOf<EL>());try{uint returned;Check(QueryInformationJobObject(job,9,jobData,(uint)Marshal.SizeOf<EL>(),out returned),"Verify native job resource limits");var limits=Marshal.PtrToStructure<EL>(jobData);result.activeProcessLimit=limits.basic.activeProcesses;result.memoryLimitBytes=limits.processMemory.ToUInt64();result.jobLimitsVerified=result.activeProcessLimit==1&&result.memoryLimitBytes==memoryBytes&&limits.jobMemory.ToUInt64()==memoryBytes&&(limits.basic.flags&0x2308)==0x2308&&(limits.basic.flags&(0x800|0x1000))==0;}finally{Marshal.FreeHGlobal(jobData);}
   IntPtr uiData=Marshal.AllocHGlobal(Marshal.SizeOf<UI>());try{uint returned;Check(QueryInformationJobObject(job,4,uiData,(uint)Marshal.SizeOf<UI>(),out returned),"Verify native job UI restrictions");result.uiRestrictionMask=Marshal.PtrToStructure<UI>(uiData).restrictions;result.uiRestrictionsVerified=result.uiRestrictionMask==0xff;}finally{Marshal.FreeHGlobal(uiData);}
   Check(OpenProcessToken(process.process,8,out token),"Open child token");
   IntPtr info=TokenInfo(token,29);try{result.tokenIsAppContainer=Marshal.ReadInt32(info)!=0;}finally{Marshal.FreeHGlobal(info);}info=TokenInfo(token,25);try{var label=Marshal.ReadIntPtr(info);byte count=Marshal.ReadByte(GetSidSubAuthorityCount(label));result.integrityRid=Marshal.ReadInt32(GetSidSubAuthority(label,(uint)(count-1)));}finally{Marshal.FreeHGlobal(info);}info=TokenInfo(token,30);bool capabilityEnabled=false;try{result.capabilityCount=Marshal.ReadInt32(info);result.capabilitySid="";if(result.capabilityCount==1){result.capabilitySid=new SecurityIdentifier(Marshal.ReadIntPtr(info,8)).Value;capabilityEnabled=(Marshal.ReadInt32(info,16)&0x4)!=0;}}finally{Marshal.FreeHGlobal(info);}
   info=TokenInfo(token,31);bool ownSid;try{ownSid=new SecurityIdentifier(Marshal.ReadIntPtr(info)).Value==identity.Value;}finally{Marshal.FreeHGlobal(info);}
   // Read on every run so an ordinary AppContainer is a negative control for the LPAC marker.
   result.tokenIsLessPrivilegedAppContainer=IsLpac(token);
   result.isolationVerified=result.tokenIsAppContainer&&result.integrityRid<=4096&&(lowPrivilege?result.capabilityCount==1&&capabilityEnabled&&result.capabilitySid==RegistryReadCapability:result.capabilityCount==0)&&result.jobAssigned&&result.jobLimitsVerified&&result.uiRestrictionsVerified&&ownSid&&result.tokenIsLessPrivilegedAppContainer==lowPrivilege;if(!result.isolationVerified)throw new InvalidOperationException("OS token isolation checks failed before execution.");
   Close(ref outWrite);Close(ref errWrite);Close(ref input);var stdout=Drain(outRead);outRead=IntPtr.Zero;var stderr=Drain(errRead);errRead=IntPtr.Zero;if(File.Exists(cancelPath))throw new OperationCanceledException("Cancelled before native process resume.");watch.Start();if(ResumeThread(process.thread)==0xFFFFFFFF)throw new Win32Exception(Marshal.GetLastWin32Error(),"Resume isolated process");
   bool cancelled=false;while(WaitForSingleObject(process.process,50)==0x102){if(File.Exists(cancelPath)){cancelled=true;TerminateJobObject(job,130);break;}if(watch.ElapsedMilliseconds>=timeoutMs){result.timedOut=true;TerminateJobObject(job,124);break;}}
   if(WaitForSingleObject(process.process,2000)!=0)throw new InvalidOperationException("Isolated process termination was not confirmed.");
   uint exit;Check(GetExitCodeProcess(process.process,out exit),"Read isolated process exit code");result.exitCode=result.timedOut?124:cancelled?130:(int)exit;Check(TerminateJobObject(job,0),"Terminate all job processes");watch.Stop();result.durationMs=watch.ElapsedMilliseconds;Task.WaitAll(new Task[]{stdout,stderr},2000);result.stdout=stdout.Status==TaskStatus.RanToCompletion?stdout.Result.text:"";result.stderr=stderr.Status==TaskStatus.RanToCompletion?stderr.Result.text:"";result.outputComplete=stdout.Status==TaskStatus.RanToCompletion&&stderr.Status==TaskStatus.RanToCompletion&&!stdout.Result.truncated&&!stderr.Result.truncated;return result;
  }finally{
   if(process.process!=IntPtr.Zero){TerminateProcess(process.process,125);WaitForSingleObject(process.process,2000);}Close(ref token);Close(ref process.thread);Close(ref process.process);Close(ref job);Close(ref outRead);Close(ref outWrite);Close(ref errRead);Close(ref errWrite);Close(ref input);
   if(attributesInitialized)DeleteProcThreadAttributeList(attrs);if(attrs!=IntPtr.Zero)Marshal.FreeHGlobal(attrs);if(caps!=IntPtr.Zero)Marshal.FreeHGlobal(caps);if(lpacPolicy!=IntPtr.Zero)Marshal.FreeHGlobal(lpacPolicy);if(capabilityArray!=IntPtr.Zero)Marshal.FreeHGlobal(capabilityArray);if(capabilitySid!=IntPtr.Zero)Marshal.FreeHGlobal(capabilitySid);if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);if(env!=IntPtr.Zero)Marshal.FreeHGlobal(env);if(sid!=IntPtr.Zero)FreeSid(sid);if(createdProfile)DeleteAppContainerProfile(profile);
  }
 }
}
