using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;
using Microsoft.Win32;

namespace MohassanWindows {
  static class Json {
    public static JavaScriptSerializer Codec(){return new JavaScriptSerializer{MaxJsonLength=500000,RecursionLimit=30};}
    public static Dictionary<string,object> O(object value){return value as Dictionary<string,object>??new Dictionary<string,object>();}
    public static string S(Dictionary<string,object> value,string key){object item;return value.TryGetValue(key,out item)&&item!=null?Convert.ToString(item,CultureInfo.InvariantCulture):"";}
    public static bool B(Dictionary<string,object> value,string key){object item;return value.TryGetValue(key,out item)&&item is bool&&(bool)item;}
    public static double N(Dictionary<string,object> value,string key){double number;return Double.TryParse(S(value,key),NumberStyles.Float,CultureInfo.InvariantCulture,out number)?number:Double.NaN;}
    public static object V(Dictionary<string,object> value,string key){object item;return value.TryGetValue(key,out item)?item:null;}
    public static Dictionary<string,object> D(params object[] pairs){var result=new Dictionary<string,object>();for(int i=0;i<pairs.Length;i+=2)result.Add((string)pairs[i],pairs[i+1]);return result;}
  }
  sealed class Target {
    public IntPtr Handle; public int ProcessId; public long ProcessStart; public string Mode,Title,Key; public int Width,Height;
    public override string ToString(){return Title;}
    public Dictionary<string,object> Dto(){return Json.D("key",Key,"mode",Mode,"title",Title,"width",Width,"height",Height);}
  }
  sealed class ImageFrame {
    public string Id,Hash,TargetKey; public DateTime CapturedAt; public int Width,Height; public string Jpeg; public object[] Elements;
    public Dictionary<string,object> Dto(){return Json.D("id",Id,"targetKey",TargetKey,"capturedAt",CapturedAt.ToString("o"),"width",Width,"height",Height,"jpeg",Jpeg,"elements",Elements);}
  }
  static class Native {
    [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left,Top,Right,Bottom;}
    [StructLayout(LayoutKind.Sequential)] public struct Point {public int X,Y;}
    [StructLayout(LayoutKind.Sequential)] struct Mouse {public int X,Y;public uint Data,Flags,Time;public UIntPtr Extra;}
    [StructLayout(LayoutKind.Sequential)] struct Keyboard {public ushort Vk,Scan;public uint Flags,Time;public UIntPtr Extra;}
    [StructLayout(LayoutKind.Explicit)] struct InputUnion {[FieldOffset(0)]public Mouse Mouse;[FieldOffset(0)]public Keyboard Key;}
    [StructLayout(LayoutKind.Sequential)] struct Input {public uint Type;public InputUnion Value;}
    public delegate bool EnumCallback(IntPtr handle,IntPtr data);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback callback,IntPtr data);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle,StringBuilder value,int maximum);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle,out uint pid);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr handle,out Rect rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr handle,ref Point point);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle,int command);
    [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr handle,uint message,UIntPtr wParam,IntPtr lParam,uint flags,uint timeout,out UIntPtr result);
    [DllImport("kernel32.dll",SetLastError=true)] static extern void SetLastError(uint error);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr handle,uint flags);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr handle,IntPtr hdc,uint flags);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr handle);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder information,int length,out int needed);
    [DllImport("user32.dll")] static extern bool SwitchDesktop(IntPtr handle);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint number,Input[] values,int size);
    public static string Hash(byte[] value){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(value)).Replace("-","").ToLowerInvariant();}
    public static bool SafeDesktop(){
      if(!Environment.UserInteractive||Process.GetCurrentProcess().SessionId==0)return false;
      IntPtr desktop=OpenInputDesktop(0,false,0x0001|0x0100);
      if(desktop==IntPtr.Zero)return false;
      try{var name=new StringBuilder(100);int needed;if(!GetUserObjectInformation(desktop,2,name,200,out needed))return false;return String.Equals(name.ToString(),"Default",StringComparison.OrdinalIgnoreCase)&&SwitchDesktop(desktop);}finally{CloseDesktop(desktop);}
    }
    public static Target WindowTarget(IntPtr handle){
      uint pid;GetWindowThreadProcessId(handle,out pid);if(pid==0||!IsWindow(handle)||!IsWindowVisible(handle)||IsIconic(handle))throw new InvalidOperationException("WINDOW_UNAVAILABLE");
      var process=Process.GetProcessById((int)pid);var rect=new Rect();GetClientRect(handle,out rect);var title=new StringBuilder(161);GetWindowText(handle,title,161);
      var target=new Target{Handle=handle,ProcessId=(int)pid,ProcessStart=process.StartTime.ToUniversalTime().Ticks,Mode="window",Title=title.ToString(),Width=rect.Right,Height=rect.Bottom};
      target.Key=Hash(Encoding.UTF8.GetBytes(handle.ToInt64()+":"+pid+":"+target.ProcessStart+":"+Process.GetCurrentProcess().SessionId));return target;
    }
    public static Target DesktopTarget(){var area=Screen.PrimaryScreen.Bounds;return new Target{Mode="desktop",Title="سطح المكتب كاملًا — يتطلب موافقة محلية صريحة",Width=area.Width,Height=area.Height,Key=Hash(Encoding.UTF8.GetBytes("desktop:"+Process.GetCurrentProcess().SessionId+":"+area.ToString()))};}
    public static List<Target> Windows(){var values=new List<Target>();EnumWindows(delegate(IntPtr handle,IntPtr data){try{var target=WindowTarget(handle);if(target.ProcessId!=Process.GetCurrentProcess().Id&&target.Title.Length>0&&target.Width>30&&target.Height>30)values.Add(target);}catch{}return values.Count<100;},IntPtr.Zero);return values;}
    static bool SameTarget(Target target){try{return target.Mode=="desktop"||WindowTarget(target.Handle).Key==target.Key;}catch{return false;}}
    static Rect Area(Target target){
      if(target.Mode=="desktop"){var screen=Screen.PrimaryScreen.Bounds;return new Rect{Left=screen.Left,Top=screen.Top,Right=screen.Right,Bottom=screen.Bottom};}
      Rect client;if(!GetClientRect(target.Handle,out client))throw new InvalidOperationException("WINDOW_UNAVAILABLE");var point=new Point();if(!ClientToScreen(target.Handle,ref point))throw new InvalidOperationException("WINDOW_UNAVAILABLE");return new Rect{Left=point.X,Top=point.Y,Right=point.X+client.Right,Bottom=point.Y+client.Bottom};
    }
    public static ImageFrame Capture(Target target,bool accessibility){
      if(!SafeDesktop()||!SameTarget(target))throw new InvalidOperationException("UNSAFE_DESKTOP");
      var area=Area(target);int width=area.Right-area.Left,height=area.Bottom-area.Top;if(width<1||height<1||width>8192||height>8192||(long)width*height>16000000)throw new InvalidOperationException("CAPTURE_SIZE");
      using(var bitmap=new Bitmap(width,height,PixelFormat.Format32bppArgb)){
        using(var graphics=Graphics.FromImage(bitmap)){
          if(target.Mode=="desktop")graphics.CopyFromScreen(area.Left,area.Top,0,0,new Size(width,height),CopyPixelOperation.SourceCopy);
          else {IntPtr dc=graphics.GetHdc();bool ok;try{ok=PrintWindow(target.Handle,dc,1);}finally{graphics.ReleaseHdc(dc);}if(!ok)throw new InvalidOperationException("CAPTURE_FAILED");}
        }
        string contentHash;var bits=bitmap.LockBits(new Rectangle(0,0,width,height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);try{var raw=new byte[Math.Abs(bits.Stride)*height];Marshal.Copy(bits.Scan0,raw,0,raw.Length);contentHash=Hash(raw);}finally{bitmap.UnlockBits(bits);}
        double ratio=Math.Min(1d,1024d/Math.Max(width,height));int outputWidth=Math.Max(1,(int)(width*ratio)),outputHeight=Math.Max(1,(int)(height*ratio));
        using(var scaled=new Bitmap(outputWidth,outputHeight))using(var graphics=Graphics.FromImage(scaled))using(var stream=new MemoryStream()){
          graphics.DrawImage(bitmap,0,0,outputWidth,outputHeight);var codec=ImageCodecInfo.GetImageEncoders().First(item=>item.MimeType=="image/jpeg");var parameters=new EncoderParameters(1);parameters.Param[0]=new EncoderParameter(System.Drawing.Imaging.Encoder.Quality,50L);scaled.Save(stream,codec,parameters);var jpeg=stream.ToArray();if(jpeg.Length>200000)throw new InvalidOperationException("CAPTURE_TOO_LARGE");
          return new ImageFrame{Id=Guid.NewGuid().ToString(),Hash=contentHash,TargetKey=target.Key,CapturedAt=DateTime.UtcNow,Width=outputWidth,Height=outputHeight,Jpeg=Convert.ToBase64String(jpeg),Elements=accessibility?Elements(target,area):new object[0]};
        }
      }
    }
    static object[] Elements(Target target,Rect area){
      var result=new List<object>();try{IntPtr handle=target.Mode=="desktop"?GetForegroundWindow():target.Handle;uint pid;GetWindowThreadProcessId(handle,out pid);var root=AutomationElement.FromHandle(handle);var queue=new Queue<AutomationElement>();queue.Enqueue(root);int checkedNodes=0;while(queue.Count>0&&result.Count<100&&checkedNodes++<200){var item=queue.Dequeue();try{var current=item.Current;if(current.ProcessId!=(int)pid)continue;bool password=current.IsPassword;var rect=current.BoundingRectangle;string name=password?"[password]":current.Name??"";if(name.Length>160)name=name.Substring(0,160);result.Add(Json.D("name",name,"type",current.ControlType.ProgrammaticName,"x",rect.Left-area.Left,"y",rect.Top-area.Top,"width",Math.Max(0,rect.Width),"height",Math.Max(0,rect.Height),"password",password));var child=TreeWalker.ControlViewWalker.GetFirstChild(item);int siblings=0;while(child!=null&&siblings++<100&&queue.Count<200){queue.Enqueue(child);child=TreeWalker.ControlViewWalker.GetNextSibling(child);}}catch{}}}catch{}return result.ToArray();
    }
    static Input MouseInput(uint flags,uint data){return new Input{Type=0,Value=new InputUnion{Mouse=new Mouse{Flags=flags,Data=data}}};}
    static Input KeyInput(ushort key,ushort scan,uint flags){return new Input{Type=1,Value=new InputUnion{Key=new Keyboard{Vk=key,Scan=scan,Flags=flags}}};}
    static string Send(Input[] input){return SendInput((uint)input.Length,input,Marshal.SizeOf(typeof(Input)))==input.Length?"APPLIED":"INPUT_PARTIAL";}
    static bool Foreground(Target target){return target.Mode=="desktop"||GetForegroundWindow()==target.Handle;}
    static bool FocusResult(Dictionary<string,object> diagnostic,bool allowed,string outcome){if(diagnostic!=null)diagnostic["outcome"]=outcome;return allowed;}
    static bool RequestForeground(Target target,Func<bool> permission,Dictionary<string,object> diagnostic=null){
      if(Foreground(target))return FocusResult(diagnostic,true,"already_foreground");
      if(!permission())return FocusResult(diagnostic,false,"permission_denied_before_request");
      if(!SafeDesktop())return FocusResult(diagnostic,false,"unsafe_desktop_before_request");
      if(!SameTarget(target))return FocusResult(diagnostic,false,"target_changed_before_request");
      bool accepted=SetForegroundWindow(target.Handle);if(diagnostic!=null)diagnostic["setForegroundAccepted"]=accepted;
      // Cross-thread activation is asynchronous. WM_NULL waits only for the target's queue;
      // it grants no focus privilege and never attaches input queues or sends synthetic keys.
      // Clear last error only for the local diagnostic. A zero error on failure is ambiguous,
      // so it must not be represented as a confirmed timeout.
      if(diagnostic!=null)SetLastError(0);
      UIntPtr ignored;var wait=Stopwatch.StartNew();IntPtr response=SendMessageTimeout(target.Handle,0,UIntPtr.Zero,IntPtr.Zero,3,300,out ignored);int waitError=Marshal.GetLastWin32Error();wait.Stop();
      if(diagnostic!=null){diagnostic["wmNullCompleted"]=response!=IntPtr.Zero;diagnostic["wmNullElapsedMs"]=wait.ElapsedMilliseconds;diagnostic["wmNullError"]=response==IntPtr.Zero?waitError:0;}
      if(response==IntPtr.Zero)return FocusResult(diagnostic,false,waitError==1460?"wm_null_timeout":"wm_null_failed_or_unreported_timeout");
      if(!permission())return FocusResult(diagnostic,false,"permission_denied_after_wait");
      if(!SafeDesktop())return FocusResult(diagnostic,false,"unsafe_desktop_after_wait");
      if(!SameTarget(target))return FocusResult(diagnostic,false,"target_changed_after_wait");
      bool foreground=Foreground(target);return FocusResult(diagnostic,foreground,foreground?"foreground_acquired":accepted?"final_foreground_mismatch":"set_foreground_refused");
    }
    public static Dictionary<string,object> DiagnoseFixtureFocus(Target target){
      var diagnostic=Json.D("inputAttempted",false,"wmNullTimeoutMs",300);
      // This entry point is reachable only from the local fixture command, and cannot
      // diagnose or request focus for another process, desktop, or stale target.
      if(target.Mode!="window"||target.ProcessId!=Process.GetCurrentProcess().Id||!SameTarget(target)){diagnostic["outcome"]="fixture_scope_denied";diagnostic["focusGranted"]=false;return diagnostic;}
      DateTime expires=DateTime.UtcNow.AddSeconds(2);diagnostic["foregroundInitially"]=Foreground(target);
      diagnostic["focusGranted"]=RequestForeground(target,delegate{return DateTime.UtcNow<expires;},diagnostic);
      diagnostic["permissionExpired"]=DateTime.UtcNow>=expires;diagnostic["foregroundFinally"]=Foreground(target);return diagnostic;
    }
    static string SendToTarget(Target target,Input[] input,Func<bool> permission){
      if(!permission()||!SafeDesktop())return "CONTROL_DENIED";
      if(!SameTarget(target))return "UNSAFE_DESKTOP";
      if(!Foreground(target))return "FOCUS_DENIED";
      foreach(int key in new[]{0x10,0x11,0x12,0x5b,0x5c})if((GetAsyncKeyState(key)&0x8000)!=0)return "LOCAL_MODIFIER_DOWN";
      return Send(input);
    }
    static bool PointerOnTarget(Target target,Point point){return target.Mode=="desktop"||GetAncestor(WindowFromPoint(point),2)==target.Handle;}
    public static string Apply(Target target,ImageFrame expected,Dictionary<string,object> action,bool fixtureOnly,Func<bool> permission){
      if(!permission())return "CONTROL_DENIED";
      if(!SafeDesktop()||!SameTarget(target))return "UNSAFE_DESKTOP";
      if(fixtureOnly&&(target.Mode!="window"||target.ProcessId!=Process.GetCurrentProcess().Id))return "FIXTURE_SCOPE_DENIED";
      if(!RequestForeground(target,permission))return "FOCUS_DENIED";
      foreach(int key in new[]{0x10,0x11,0x12,0x5b,0x5c})if((GetAsyncKeyState(key)&0x8000)!=0)return "LOCAL_MODIFIER_DOWN";
      var fresh=Capture(target,false);if(fresh.Hash!=expected.Hash)return "SCREEN_CHANGED";
      if(!permission()||!SafeDesktop())return "CONTROL_DENIED";
      string type=Json.S(action,"type");
      if(type=="click"){double x=Json.N(action,"x"),y=Json.N(action,"y");if(Double.IsNaN(x)||Double.IsNaN(y)||x<0||x>1||y<0||y>1)return "INPUT_INVALID";var area=Area(target);var point=new Point{X=area.Left+(int)((area.Right-area.Left-1)*x),Y=area.Top+(int)((area.Bottom-area.Top-1)*y)};if(!PointerOnTarget(target,point)||!SetCursorPos(point.X,point.Y))return "INPUT_BLOCKED";if(!PointerOnTarget(target,point))return "INPUT_BLOCKED";bool right=Json.S(action,"button")=="right";return SendToTarget(target,new[]{MouseInput(right?8u:2u,0),MouseInput(right?16u:4u,0)},permission);}
      if(type=="text"){string text=Json.S(action,"text");if(text.Length<1||text.Length>120||text.Any(character=>character<32||character==127))return "INPUT_INVALID";var input=new List<Input>();foreach(char character in text){input.Add(KeyInput(0,character,4));input.Add(KeyInput(0,character,6));}return SendToTarget(target,input.ToArray(),permission);}
      if(type=="key"){var keys=new Dictionary<string,ushort>{{"Enter",13},{"Tab",9},{"Escape",27},{"Backspace",8},{"Delete",46},{"ArrowLeft",37},{"ArrowRight",39},{"ArrowUp",38},{"ArrowDown",40},{"Home",36},{"End",35},{"PageUp",33},{"PageDown",34},{"Space",32}};ushort key;if(!keys.TryGetValue(Json.S(action,"key"),out key))return "INPUT_INVALID";return SendToTarget(target,new[]{KeyInput(key,0,0),KeyInput(key,0,2)},permission);}
      if(type=="scroll"){double delta=Json.N(action,"delta");if(Double.IsNaN(delta)||delta==0||Math.Abs(delta)>3||delta!=Math.Truncate(delta))return "INPUT_INVALID";var area=Area(target);var point=new Point{X=(area.Left+area.Right)/2,Y=(area.Top+area.Bottom)/2};if(!PointerOnTarget(target,point)||!SetCursorPos(point.X,point.Y)||!PointerOnTarget(target,point))return "INPUT_BLOCKED";return SendToTarget(target,new[]{MouseInput(0x0800,unchecked((uint)((int)delta*120)))},permission);}
      return "INPUT_INVALID";
    }
  }
  sealed class Consent {
    public bool View,Control;public string Epoch=Guid.NewGuid().ToString();public Target Target;
    public void Stop(){View=false;Control=false;Epoch=Guid.NewGuid().ToString();}
  }
  sealed class CompanionForm:Form {
    readonly object gate=new object();readonly Consent consent=new Consent();readonly HttpClient client=new HttpClient(new HttpClientHandler{AllowAutoRedirect=false,UseCookies=false,UseProxy=false,CheckCertificateRevocationList=true});readonly string store;
    readonly TextBox code=new TextBox(),name=new TextBox();readonly ComboBox targets=new ComboBox();readonly CheckBox view=new CheckBox(),control=new CheckBox();readonly Label status=new Label();readonly Button pair=new Button();
    string deviceId="",deviceKey="",currentGrant="";long lastSequence=0;Dictionary<string,object> grant,ack;ImageFrame latest;readonly Dictionary<string,ImageFrame> frames=new Dictionary<string,ImageFrame>();
    bool busy,closing,updatingControls;DateTime workStarted;readonly System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer();
    public CompanionForm(string server,string directory,bool fixture=false){
      var uri=new Uri(server);if(uri.Scheme!="https"&&!(uri.Scheme=="http"&&uri.IsLoopback))throw new InvalidOperationException("HTTPS_REQUIRED");client.BaseAddress=uri;client.Timeout=TimeSpan.FromSeconds(2);store=Path.Combine(directory,"device.dat");if(!fixture)Directory.CreateDirectory(directory);
      Text="Mohassan — Windows Companion";Width=440;Height=550;TopMost=true;StartPosition=FormStartPosition.CenterScreen;FormBorderStyle=FormBorderStyle.FixedDialog;MaximizeBox=false;RightToLeft=RightToLeft.Yes;
      var layout=new FlowLayoutPanel{Dock=DockStyle.Fill,FlowDirection=FlowDirection.TopDown,WrapContents=false,Padding=new Padding(18),AutoScroll=true};Controls.Add(layout);
      layout.Controls.Add(new Label{Text="ربط محلي مرئي — لا إدخال دون موافقتك",Width=380,Height=28});
      name.Text=Environment.MachineName;name.Width=380;layout.Controls.Add(new Label{Text="اسم الجهاز",Width=380});layout.Controls.Add(name);
      code.Width=380;layout.Controls.Add(new Label{Text="رمز الربط من مساحة العمل (دقيقتان)",Width=380});layout.Controls.Add(code);pair.Text="ربط الجهاز محليًا";pair.Width=380;pair.Height=35;pair.Click+=async delegate{await Pair();};layout.Controls.Add(pair);
      var refresh=new Button{Text="تحديث النوافذ المتاحة",Width=380,Height=32};refresh.Click+=delegate{RefreshTargets();};layout.Controls.Add(refresh);targets.Width=380;targets.DropDownStyle=ComboBoxStyle.DropDownList;targets.SelectedIndexChanged+=delegate{LocalStop();lock(gate){consent.Target=targets.SelectedItem as Target;}};layout.Controls.Add(targets);
      view.Text="أوافق محليًا على مشاهدة النطاق المحدد";view.Width=380;view.Height=30;control.Text="أوافق محليًا على الإدخال ضمن هذا النطاق";control.Width=380;control.Height=30;view.CheckedChanged+=delegate{Approve();};control.CheckedChanged+=delegate{Approve();};layout.Controls.Add(view);layout.Controls.Add(control);
      var stop=new Button{Text="STOP — إيقاف محلي فوري",BackColor=Color.Firebrick,ForeColor=Color.White,Width=380,Height=60,Font=new Font(Font.FontFamily,13,FontStyle.Bold)};stop.Click+=delegate{LocalStop();status.Text="متوقف محليًا. يلزم إذن محلي جديد.";};layout.Controls.Add(stop);status.Width=380;status.Height=65;layout.Controls.Add(status);
      if(!fixture){LoadCredentials();RefreshTargets();}timer.Interval=1000;timer.Tick+=async delegate{if(busy){if((DateTime.UtcNow-workStarted).TotalSeconds>4){LocalStop();status.Text="توقف آمن: تعثر الالتقاط أو الاتصال.";}return;}if(deviceKey.Length==0)return;busy=true;workStarted=DateTime.UtcNow;try{await Task.Run(async delegate{await Poll();});}catch(UnauthorizedAccessException){LocalStop();deviceId="";deviceKey="";try{File.Delete(store);}catch{}if(!closing){pair.Enabled=true;status.Text="أُلغي ربط الجهاز؛ أنشئ ربطًا جديدًا.";}}catch{LocalStop();if(!closing)status.Text="الاتصال منقطع؛ الإدخال متوقف.";}finally{busy=false;}};if(!fixture)timer.Start();
      SystemEvents.SessionSwitch+=SessionChanged;FormClosing+=delegate{closing=true;LocalStop();timer.Stop();client.CancelPendingRequests();SystemEvents.SessionSwitch-=SessionChanged;};Resize+=delegate{lock(gate){if(consent.View&&WindowState==FormWindowState.Minimized)WindowState=FormWindowState.Normal;}};
    }
    void SessionChanged(object sender,SessionSwitchEventArgs args){if(args.Reason==SessionSwitchReason.SessionLock||args.Reason==SessionSwitchReason.SessionLogoff)BeginInvoke((Action)delegate{LocalStop();status.Text="قفل الجلسة أوقف التحكم. أعد الموافقة بعد فتحها.";});}
    void RefreshTargets(){targets.Items.Clear();targets.Items.Add(Native.DesktopTarget());foreach(var target in Native.Windows())targets.Items.Add(target);targets.SelectedIndex=-1;}
    void LocalStop(){lock(gate){consent.Stop();grant=null;latest=null;frames.Clear();}if(closing||IsDisposed)return;Action update=delegate{updatingControls=true;try{view.Checked=false;control.Checked=false;}finally{updatingControls=false;}};if(InvokeRequired){if(IsHandleCreated)BeginInvoke(update);}else update();}
    void Approve(){if(updatingControls)return;if(deviceKey.Length==0||targets.SelectedItem==null||!Native.SafeDesktop()){if(view.Checked||control.Checked){updatingControls=true;view.Checked=false;control.Checked=false;updatingControls=false;status.Text="اربط الجهاز واختر نافذة في جلسة مفتوحة أولًا.";}return;}var target=(Target)targets.SelectedItem;if(target.Mode=="desktop"&&(view.Checked||control.Checked)){if(MessageBox.Show(this,"هذا النطاق يشمل سطح المكتب الظاهر كاملًا. هل توافق محليًا على هذا النطاق؟","موافقة محلية",MessageBoxButtons.YesNo,MessageBoxIcon.Warning)!=DialogResult.Yes){updatingControls=true;view.Checked=false;control.Checked=false;updatingControls=false;return;}}lock(gate){consent.View=view.Checked;consent.Control=view.Checked&&control.Checked;consent.Epoch=Guid.NewGuid().ToString();consent.Target=target;grant=null;frames.Clear();latest=null;}status.Text="موافقة محلية جاهزة. يلزم إذن قصير من مساحة العمل.";}
    void LoadCredentials(){try{var bytes=ProtectedData.Unprotect(File.ReadAllBytes(store),null,DataProtectionScope.CurrentUser);var value=Json.O(Json.Codec().DeserializeObject(Encoding.UTF8.GetString(bytes)));deviceId=Json.S(value,"deviceId");deviceKey=Json.S(value,"deviceKey");pair.Enabled=false;status.Text="الجهاز مرتبط؛ اختر نطاقًا ووافق محليًا.";}catch{deviceId="";deviceKey="";status.Text="أنشئ رمز ربط من مساحة العمل ثم ألصقه هنا.";}}
    async Task Pair(){try{if(!Native.SafeDesktop())throw new InvalidOperationException();pair.Enabled=false;var payload=Json.D("code",code.Text.Trim(),"name",name.Text.Trim());var result=await Post("/api/windows/companion/pair",payload,false);deviceId=Json.S(result,"deviceId");deviceKey=Json.S(result,"deviceKey");var bytes=Encoding.UTF8.GetBytes(Json.Codec().Serialize(Json.D("deviceId",deviceId,"deviceKey",deviceKey)));File.WriteAllBytes(store,ProtectedData.Protect(bytes,null,DataProtectionScope.CurrentUser));code.Clear();status.Text="تم الربط. اختر نافذة وحدد الموافقة المحلية.";}catch{pair.Enabled=true;status.Text="تعذر الربط. تحقق من الرمز والاتصال.";}}
    async Task<Dictionary<string,object>> Post(string path,object body,bool authenticate){var message=new HttpRequestMessage(HttpMethod.Post,path);if(authenticate)message.Headers.TryAddWithoutValidation("Authorization","Bearer "+deviceId+"."+deviceKey);message.Content=new StringContent(Json.Codec().Serialize(body),Encoding.UTF8,"application/json");using(var result=await client.SendAsync(message)){if(result.StatusCode==System.Net.HttpStatusCode.Unauthorized&&authenticate)throw new UnauthorizedAccessException();if(!result.IsSuccessStatusCode)throw new InvalidOperationException("SERVER_DENIED");var value=await result.Content.ReadAsStringAsync();if(value.Length>400000)throw new InvalidOperationException("RESPONSE_LIMIT");return Json.O(Json.Codec().DeserializeObject(value));}}
    async Task Poll(){
      Target target;string epoch;bool localView,localControl;object frame=null,acknowledgement;lock(gate){target=consent.Target;epoch=consent.Epoch;localView=consent.View;localControl=consent.Control;frame=latest==null?null:latest.Dto();acknowledgement=ack;}
      bool safe=Native.SafeDesktop();if(!safe){LocalStop();localView=false;localControl=false;}
      var state=Json.D("approvalNonce",epoch,"sessionId",Process.GetCurrentProcess().SessionId,"safeDesktop",safe,"localView",localView,"localControl",localControl,"target",!localView||target==null?null:target.Dto(),"status",safe?"جلسة تفاعلية مفتوحة":"جلسة مقفلة أو سطح مكتب آمن");
      var result=await Post("/api/windows/companion/poll",Json.D("nonce",Guid.NewGuid().ToString(),"sentAt",DateTime.UtcNow.ToString("o"),"state",state,"frame",frame,"ack",acknowledgement),true);
      lock(gate){if(ack==acknowledgement)ack=null;if(epoch!=consent.Epoch||closing)return;}
      if(Json.B(result,"stop")){LocalStop();return;}
      var nextGrant=Json.O(Json.V(result,"grant"));if(nextGrant.Count==0){lock(gate){grant=null;latest=null;frames.Clear();}return;}
      lock(gate){grant=nextGrant;if(currentGrant!=Json.S(grant,"id")){currentGrant=Json.S(grant,"id");lastSequence=0;}}
      var command=Json.O(Json.V(result,"command"));if(command.Count>0){string code=Execute(command,nextGrant,false);lock(gate){ack=Json.D("id",Json.S(command,"id"),"status",code=="APPLIED"?"applied":code=="INPUT_PARTIAL"?"unknown":"rejected","code",code);latest=null;frames.Clear();}}
      lock(gate){if(!consent.View||epoch!=consent.Epoch||!GrantAllows(nextGrant,false))return;}
      var captured=Native.Capture(target,true);lock(gate){if(epoch!=consent.Epoch||!consent.View||closing)return;latest=captured;frames[captured.Id]=captured;foreach(var key in frames.Where(pair=>(DateTime.UtcNow-pair.Value.CapturedAt).TotalSeconds>4).Select(pair=>pair.Key).ToArray())frames.Remove(key);while(frames.Count>5)frames.Remove(frames.Keys.First());}
      if(!closing)BeginInvoke((Action)delegate{status.Text=Json.S(nextGrant,"scope")=="control"?"تحكم مصرح مؤقتًا — STOP يوقفه فورًا":"مشاهدة فقط — الإدخال معطل";});
    }
    bool GrantAllows(Dictionary<string,object> value,bool input){DateTime expiry;return consent.View&&(!input||consent.Control&&Json.S(value,"scope")=="control")&&consent.Target!=null&&Json.S(value,"approvalNonce")==consent.Epoch&&Json.S(value,"targetKey")==consent.Target.Key&&DateTime.TryParse(Json.S(value,"expiresAt"),CultureInfo.InvariantCulture,DateTimeStyles.AdjustToUniversal,out expiry)&&expiry.ToUniversalTime()>DateTime.UtcNow;}
    public string Execute(Dictionary<string,object> command,Dictionary<string,object> approved,bool fixtureOnly){Target target;ImageFrame expected;string epoch;DateTime expires;lock(gate){if(!GrantAllows(approved,true)||Json.S(command,"grantId")!=Json.S(approved,"id"))return "CONTROL_DENIED";double sequence=Json.N(command,"sequence");if(Double.IsNaN(sequence)||sequence<=lastSequence||sequence!=Math.Truncate(sequence))return "SEQUENCE_REPLAY";lastSequence=(long)sequence;if(!DateTime.TryParse(Json.S(command,"expiresAt"),CultureInfo.InvariantCulture,DateTimeStyles.AdjustToUniversal,out expires)||expires.ToUniversalTime()<=DateTime.UtcNow)return "COMMAND_EXPIRED";if(!frames.TryGetValue(Json.S(command,"frameId"),out expected)||(DateTime.UtcNow-expected.CapturedAt).TotalSeconds>3||expected.TargetKey!=consent.Target.Key)return "FRESH_SCREEN_REQUIRED";target=consent.Target;epoch=consent.Epoch;}try{return Native.Apply(target,expected,Json.O(Json.V(command,"action")),fixtureOnly,delegate{lock(gate)return epoch==consent.Epoch&&GrantAllows(approved,true)&&expires.ToUniversalTime()>DateTime.UtcNow&&(DateTime.UtcNow-expected.CapturedAt).TotalSeconds<=3;});}catch{return "NATIVE_BOUNDARY_FAILED";}}
    public void ConfigureFixture(Target target,bool allowControl,ImageFrame captured){lock(gate){consent.Target=target;consent.View=true;consent.Control=allowControl;grant=Json.D("id",Guid.NewGuid().ToString(),"scope",allowControl?"control":"view","targetKey",target.Key,"approvalNonce",consent.Epoch,"expiresAt",DateTime.UtcNow.AddSeconds(30).ToString("o"));currentGrant=Json.S(grant,"id");lastSequence=0;frames.Clear();frames[captured.Id]=captured;}}
    public Dictionary<string,object> FixtureGrant(){lock(gate)return grant==null?new Dictionary<string,object>():new Dictionary<string,object>(grant);}
    public void StopFixture(){LocalStop();}
  }
  static class Fixture {
    public static void DiagnoseFocus(string resultPath){
      var form=new Form{Text="Mohassan focus diagnostic — no input",Width=450,Height=150,StartPosition=FormStartPosition.CenterScreen};
      form.Controls.Add(new Label{Text="Local fixture only. No mouse or keyboard input is sent.",Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleCenter});
      form.Shown+=async delegate{var report=Json.D("diagnosticCompleted",false,"fixtureOnly",true,"inputAttempted",false,"nativeAcceptanceProven",false,"startedAt",DateTime.UtcNow.ToString("o"));try{
        await Task.Delay(200);Native.ShowWindow(form.Handle,4);var target=Native.WindowTarget(form.Handle);
        report["safeDesktop"]=Native.SafeDesktop();report["sessionId"]=Process.GetCurrentProcess().SessionId;
        report["focus"]=await Task.Run(()=>Native.DiagnoseFixtureFocus(target));
        report["desktopScopeDenied"]=Json.S(Native.DiagnoseFixtureFocus(Native.DesktopTarget()),"outcome")=="fixture_scope_denied";
        report["diagnosticCompleted"]=true;
      }catch(Exception error){report["error"]=error.GetType().Name+":"+error.Message;}finally{
        report["finishedAt"]=DateTime.UtcNow.ToString("o");
        try{using(var stream=new FileStream(resultPath,FileMode.CreateNew,FileAccess.Write,FileShare.None))using(var writer=new StreamWriter(stream,new UTF8Encoding(false)))writer.Write(Json.Codec().Serialize(report));}finally{form.Close();}
      }};
      Application.Run(form);
    }
    public static void Run(string resultPath){
      var form=new Form{Text="Mohassan native fixture — this window only",Width=450,Height=250,StartPosition=FormStartPosition.CenterScreen,TopMost=true};var box=new TextBox{Left=25,Top=25,Width=350,Text=""};var button=new Button{Left=25,Top=80,Width=200,Height=45,Text="Fixture button"};var label=new Label{Left=25,Top=140,Width=350,Text="Clicks: 0"};int clicks=0;button.Click+=delegate{clicks++;label.Text="Clicks: "+clicks;};form.Controls.Add(box);form.Controls.Add(button);form.Controls.Add(label);
      var companion=new CompanionForm("http://127.0.0.1:4000",Path.Combine(Path.GetTempPath(),"mohassan-windows-fixture-unused-"+Guid.NewGuid().ToString("N")),true);companion.ShowInTaskbar=false;companion.Show();companion.Hide();
      form.Shown+=async delegate{await Task.Delay(200);var report=Json.D("ok",false,"fixtureOnly",true);try{
        // An interactive harness may activate this fixture. A background process cannot
        // override Windows foreground policy; timeout remains a real test failure.
        Native.ShowWindow(form.Handle,4);form.Activate();var focusDeadline=DateTime.UtcNow.AddSeconds(20);while(Native.GetForegroundWindow()!=form.Handle&&DateTime.UtcNow<focusDeadline)await Task.Delay(100);
        report["foregroundReady"]=Native.GetForegroundWindow()==form.Handle;
        form.Activate();box.Focus();await Task.Delay(150);var target=Native.WindowTarget(form.Handle);var first=await Task.Run(()=>Native.Capture(target,true));report["captureBytes"]=Convert.FromBase64String(first.Jpeg).Length;report["safeDesktop"]=Native.SafeDesktop();report["accessibleElements"]=first.Elements.Length;
        Func<int,ImageFrame,object,Dictionary<string,object>> command=(sequence,image,action)=>Json.D("id",Guid.NewGuid().ToString(),"grantId",Json.S(companion.FixtureGrant(),"id"),"sequence",sequence,"frameId",image.Id,"expiresAt",DateTime.UtcNow.AddSeconds(2).ToString("o"),"action",action);
        companion.ConfigureFixture(target,false,first);var denied=companion.Execute(command(1,first,Json.D("type","text","text","DENIED")),companion.FixtureGrant(),true);report["viewOnlyDenied"]=denied=="CONTROL_DENIED";
        form.Activate();var clickFrame=await Task.Run(()=>Native.Capture(target,false));companion.ConfigureFixture(target,true,clickFrame);var approved=companion.FixtureGrant();var click=command(1,clickFrame,Json.D("type","click","x",(button.Left+button.Width/2d)/form.ClientSize.Width,"y",(button.Top+button.Height/2d)/form.ClientSize.Height,"button","left"));var clicked=await Task.Run(()=>companion.Execute(click,approved,true));await Task.Delay(150);report["mouseResult"]=clicked;report["clicks"]=clicks;report["replayDenied"]=companion.Execute(click,approved,true)=="SEQUENCE_REPLAY";
        form.Activate();box.Focus();await Task.Delay(100);var textFrame=await Task.Run(()=>Native.Capture(target,false));companion.ConfigureFixture(target,true,textFrame);approved=companion.FixtureGrant();var typed=await Task.Run(()=>companion.Execute(command(1,textFrame,Json.D("type","text","text","fixture typed")),approved,true));await Task.Delay(150);report["keyboardResult"]=typed;report["typedText"]=box.Text;
        var expired=command(2,textFrame,Json.D("type","text","text","DENIED"));expired["expiresAt"]=DateTime.UtcNow.AddSeconds(-1).ToString("o");report["expiredDenied"]=companion.Execute(expired,approved,true)=="COMMAND_EXPIRED";
        textFrame.CapturedAt=DateTime.UtcNow.AddSeconds(-5);report["staleFrameDenied"]=companion.Execute(command(3,textFrame,Json.D("type","text","text","DENIED")),approved,true)=="FRESH_SCREEN_REQUIRED";
        var freshFrame=await Task.Run(()=>Native.Capture(target,false));companion.ConfigureFixture(target,true,freshFrame);approved=companion.FixtureGrant();var wrong=new Dictionary<string,object>(approved);wrong["id"]=Guid.NewGuid().ToString();report["wrongGrantDenied"]=companion.Execute(command(1,freshFrame,Json.D("type","text","text","DENIED")),wrong,true)=="CONTROL_DENIED";
        box.Text="changed locally";report["screenChangedDenied"]=await Task.Run(()=>companion.Execute(command(2,freshFrame,Json.D("type","text","text","DENIED")),approved,true))=="SCREEN_CHANGED";box.Text="fixture typed";
        report["fixtureScopeDenied"]=Native.Apply(Native.DesktopTarget(),freshFrame,Json.D("type","text","text","DENIED"),true,delegate{return true;})=="FIXTURE_SCOPE_DENIED";
        companion.StopFixture();report["localStopDenied"]=companion.Execute(command(2,textFrame,Json.D("type","text","text","DENIED")),approved,true)=="CONTROL_DENIED";
        report["ok"]=clicks==1&&box.Text=="fixture typed"&&clicked=="APPLIED"&&typed=="APPLIED"&&(bool)report["viewOnlyDenied"]&&(bool)report["replayDenied"]&&(bool)report["localStopDenied"]&&(bool)report["expiredDenied"]&&(bool)report["staleFrameDenied"]&&(bool)report["wrongGrantDenied"]&&(bool)report["screenChangedDenied"]&&(bool)report["fixtureScopeDenied"];
      }catch(Exception error){report["error"]=error.GetType().Name+":"+error.Message;}finally{File.WriteAllText(resultPath,Json.Codec().Serialize(report),new UTF8Encoding(false));companion.Close();form.Close();}};
      Application.Run(form);
    }
  }
  static class Program {
    [STAThread] static void Main(string[] args){System.Net.ServicePointManager.SecurityProtocol=System.Net.SecurityProtocolType.Tls12;Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);try{if(args.Length==2&&args[0]=="--fixture-self-test"){Fixture.Run(Path.GetFullPath(args[1]));return;}if(args.Length==2&&args[0]=="--fixture-focus-diagnostic"){Fixture.DiagnoseFocus(Path.GetFullPath(args[1]));return;}string server="http://127.0.0.1:4000",directory=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"MohassanAI","WindowsCompanion");for(int index=0;index<args.Length-1;index+=2){if(args[index]=="--server")server=args[index+1];else if(args[index]=="--state")directory=Path.GetFullPath(args[index+1]);else throw new InvalidOperationException("UNSUPPORTED_ARGUMENT");}if(!Native.SafeDesktop())throw new InvalidOperationException("INTERACTIVE_UNLOCKED_SESSION_REQUIRED");Application.Run(new CompanionForm(server,directory));}catch(Exception error){MessageBox.Show("تعذر بدء المرافق: "+error.Message,"Mohassan Windows",MessageBoxButtons.OK,MessageBoxIcon.Error);Environment.ExitCode=1;}}
  }
}
