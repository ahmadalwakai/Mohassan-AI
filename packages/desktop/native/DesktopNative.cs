// Mohassan desktop native helper. Compiled once by host.ps1 (Windows PowerShell 5.1, C# 5 syntax only).
// Everything here acts on the owner's own session: windows, input, screen, clipboard.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

namespace MohassanDesktop
{
    public class WindowInfo
    {
        public long Handle { get; set; }
        public string Title { get; set; }
        public int ProcessId { get; set; }
        public string ProcessName { get; set; }
        public string ClassName { get; set; }
        public int X { get; set; }
        public int Y { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public bool Minimized { get; set; }
        public bool Maximized { get; set; }
        public bool Foreground { get; set; }
    }

    public class ElementInfo
    {
        public string Name { get; set; }
        public string Type { get; set; }
        public int X { get; set; }
        public int Y { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public bool Password { get; set; }
        public bool Enabled { get; set; }
    }

    public class ScreenshotInfo
    {
        public string Png { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public int ScaledWidth { get; set; }
        public int ScaledHeight { get; set; }
        public int Left { get; set; }
        public int Top { get; set; }
    }

    public class ScreenInfo
    {
        public string Device { get; set; }
        public int X { get; set; }
        public int Y { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public bool Primary { get; set; }
    }

    public static class Native
    {
        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
        [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
        [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }

        delegate bool EnumCallback(IntPtr handle, IntPtr data);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr data);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr handle);
        [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr handle);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr handle);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr handle, StringBuilder text, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr handle, StringBuilder text, int max);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle, out RECT rect);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr handle, int command);
        [DllImport("user32.dll")] static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int processId);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
        [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code, uint mapType);
        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
        [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr handle, int index);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr handle, int attribute, out RECT rect, int size);
        [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr handle, uint flags);

        const int SW_MINIMIZE = 6, SW_MAXIMIZE = 3, SW_RESTORE = 9, SW_SHOW = 5;
        const uint WM_CLOSE = 0x0010;
        const int GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x00000080;
        const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
        const uint KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
        const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004, MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010,
            MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040, MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_VIRTUALDESK = 0x4000, MOUSEEVENTF_ABSOLUTE = 0x8000;
        const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;

        static readonly Dictionary<string, ushort> KeyCodes = BuildKeys();

        public static string Init()
        {
            try { SetProcessDPIAware(); } catch { }
            return "READY";
        }

        static Dictionary<string, ushort> BuildKeys()
        {
            var map = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase);
            string[][] pairs = new string[][] {
                new[] { "enter", "13" }, new[] { "return", "13" }, new[] { "tab", "9" }, new[] { "esc", "27" }, new[] { "escape", "27" }, new[] { "space", "32" }, new[] { "backspace", "8" },
                new[] { "delete", "46" }, new[] { "del", "46" }, new[] { "insert", "45" }, new[] { "home", "36" }, new[] { "end", "35" }, new[] { "pageup", "33" }, new[] { "pagedown", "34" },
                new[] { "up", "38" }, new[] { "down", "40" }, new[] { "left", "37" }, new[] { "right", "39" }, new[] { "win", "91" }, new[] { "windows", "91" }, new[] { "ctrl", "17" }, new[] { "control", "17" },
                new[] { "alt", "18" }, new[] { "shift", "16" }, new[] { "printscreen", "44" }, new[] { "capslock", "20" }, new[] { "numlock", "144" }, new[] { "menu", "93" }, new[] { "apps", "93" },
                new[] { "plus", "187" }, new[] { "minus", "189" }, new[] { "comma", "188" }, new[] { "period", "190" }, new[] { "slash", "191" }, new[] { "backslash", "220" }, new[] { "semicolon", "186" },
                new[] { "quote", "222" }, new[] { "lbracket", "219" }, new[] { "rbracket", "221" }, new[] { "grave", "192" }, new[] { "volumeup", "175" }, new[] { "volumedown", "174" }, new[] { "mute", "173" },
                new[] { "playpause", "179" }, new[] { "nexttrack", "176" }, new[] { "prevtrack", "177" }
            };
            foreach (var pair in pairs) map[pair[0]] = ushort.Parse(pair[1]);
            for (int i = 1; i <= 24; i++) map["f" + i] = (ushort)(0x6F + i);
            for (char c = 'a'; c <= 'z'; c++) map[c.ToString()] = (ushort)(0x41 + (c - 'a'));
            for (char c = '0'; c <= '9'; c++) map[c.ToString()] = (ushort)(0x30 + (c - '0'));
            return map;
        }

        static string WindowText(IntPtr handle)
        {
            var builder = new StringBuilder(512);
            GetWindowTextW(handle, builder, builder.Capacity);
            return builder.ToString();
        }

        static string WindowClass(IntPtr handle)
        {
            var builder = new StringBuilder(256);
            GetClassNameW(handle, builder, builder.Capacity);
            return builder.ToString();
        }

        static RECT Bounds(IntPtr handle)
        {
            RECT rect;
            try { if (DwmGetWindowAttribute(handle, 9, out rect, Marshal.SizeOf(typeof(RECT))) == 0 && rect.Right > rect.Left) return rect; } catch { }
            GetWindowRect(handle, out rect);
            return rect;
        }

        static WindowInfo Describe(IntPtr handle, IntPtr foreground)
        {
            uint pid;
            GetWindowThreadProcessId(handle, out pid);
            string processName = "";
            try { processName = Process.GetProcessById((int)pid).ProcessName; } catch { }
            var rect = Bounds(handle);
            var info = new WindowInfo();
            info.Handle = handle.ToInt64();
            info.Title = WindowText(handle);
            info.ProcessId = (int)pid;
            info.ProcessName = processName;
            info.ClassName = WindowClass(handle);
            info.X = rect.Left; info.Y = rect.Top; info.Width = Math.Max(0, rect.Right - rect.Left); info.Height = Math.Max(0, rect.Bottom - rect.Top);
            info.Minimized = IsIconic(handle);
            info.Maximized = IsZoomed(handle);
            info.Foreground = handle == foreground;
            return info;
        }

        public static WindowInfo[] ListWindows()
        {
            var result = new List<WindowInfo>();
            var foreground = GetForegroundWindow();
            int self = Process.GetCurrentProcess().Id;
            EnumWindows(delegate(IntPtr handle, IntPtr data)
            {
                try
                {
                    if (!IsWindowVisible(handle)) return true;
                    if ((GetWindowLongW(handle, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return true;
                    var title = WindowText(handle);
                    if (title.Length == 0) return true;
                    var info = Describe(handle, foreground);
                    if (info.ProcessId == self) return true;
                    if (info.ClassName == "Progman" || info.ClassName == "WorkerW" || info.ClassName == "Shell_TrayWnd") return true;
                    result.Add(info);
                }
                catch { }
                return result.Count < 200;
            }, IntPtr.Zero);
            return result.ToArray();
        }

        public static WindowInfo Foreground()
        {
            var handle = GetForegroundWindow();
            if (handle == IntPtr.Zero) return null;
            return Describe(handle, handle);
        }

        public static WindowInfo Window(long handle)
        {
            var pointer = new IntPtr(handle);
            if (!IsWindow(pointer)) return null;
            return Describe(pointer, GetForegroundWindow());
        }

        public static string Focus(long handle)
        {
            var pointer = new IntPtr(handle);
            if (!IsWindow(pointer)) return "NOT_FOUND";
            if (IsIconic(pointer)) ShowWindow(pointer, SW_RESTORE);
            // Windows lets the process that received the last input change the foreground window; a harmless Alt tap is that input.
            try { AllowSetForegroundWindow(-1); } catch { }
            keybd_event(0x12, 0, 0, UIntPtr.Zero);
            keybd_event(0x12, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            SetForegroundWindow(pointer);
            var deadline = DateTime.UtcNow.AddMilliseconds(1500);
            while (DateTime.UtcNow < deadline)
            {
                if (GetForegroundWindow() == pointer) return "FOCUSED";
                Thread.Sleep(50);
                SetForegroundWindow(pointer);
            }
            return GetForegroundWindow() == pointer ? "FOCUSED" : "NOT_FOCUSED";
        }

        public static string Show(long handle, string mode)
        {
            var pointer = new IntPtr(handle);
            if (!IsWindow(pointer)) return "NOT_FOUND";
            switch ((mode ?? "").ToLowerInvariant())
            {
                case "minimize": ShowWindow(pointer, SW_MINIMIZE); return "MINIMIZED";
                case "maximize": ShowWindow(pointer, SW_MAXIMIZE); return "MAXIMIZED";
                case "restore": ShowWindow(pointer, SW_RESTORE); return "RESTORED";
                case "show": ShowWindow(pointer, SW_SHOW); return "SHOWN";
                case "close": PostMessage(pointer, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); return "CLOSE_REQUESTED";
                default: return "UNKNOWN_MODE";
            }
        }

        public static ScreenshotInfo Screenshot(long handle, int maxWidth)
        {
            Rectangle area;
            if (handle != 0)
            {
                var pointer = new IntPtr(handle);
                if (!IsWindow(pointer)) throw new InvalidOperationException("WINDOW_NOT_FOUND");
                if (IsIconic(pointer)) throw new InvalidOperationException("WINDOW_MINIMIZED");
                var rect = Bounds(pointer);
                area = Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);
            }
            else
            {
                area = new Rectangle(GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN), GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN));
            }
            if (area.Width <= 0 || area.Height <= 0) throw new InvalidOperationException("EMPTY_AREA");
            using (var bitmap = new Bitmap(area.Width, area.Height, PixelFormat.Format32bppArgb))
            {
                using (var graphics = Graphics.FromImage(bitmap))
                {
                    graphics.CopyFromScreen(area.Left, area.Top, 0, 0, area.Size, CopyPixelOperation.SourceCopy);
                }
                int width = area.Width, height = area.Height;
                if (maxWidth > 0 && width > maxWidth)
                {
                    height = Math.Max(1, (int)Math.Round(height * (maxWidth / (double)width)));
                    width = maxWidth;
                }
                var info = new ScreenshotInfo();
                info.Width = area.Width; info.Height = area.Height; info.ScaledWidth = width; info.ScaledHeight = height; info.Left = area.Left; info.Top = area.Top;
                using (var output = new MemoryStream())
                {
                    if (width == area.Width) bitmap.Save(output, ImageFormat.Png);
                    else
                    {
                        using (var scaled = new Bitmap(bitmap, new Size(width, height))) scaled.Save(output, ImageFormat.Png);
                    }
                    info.Png = Convert.ToBase64String(output.ToArray());
                }
                return info;
            }
        }

        static INPUT KeyInput(ushort vk, bool up, bool extended)
        {
            var input = new INPUT();
            input.type = INPUT_KEYBOARD;
            input.u.ki.wVk = vk;
            input.u.ki.wScan = (ushort)MapVirtualKeyW(vk, 0);
            input.u.ki.dwFlags = (up ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0);
            return input;
        }

        static INPUT UnicodeInput(char character, bool up)
        {
            var input = new INPUT();
            input.type = INPUT_KEYBOARD;
            input.u.ki.wVk = 0;
            input.u.ki.wScan = character;
            input.u.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
            return input;
        }

        static string Send(List<INPUT> inputs)
        {
            if (inputs.Count == 0) return "NOTHING";
            uint sent = SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
            return sent == inputs.Count ? "APPLIED" : "PARTIAL:" + sent + "/" + inputs.Count;
        }

        public static string TypeText(string text)
        {
            if (string.IsNullOrEmpty(text)) return "NOTHING";
            int total = 0;
            foreach (char character in text)
            {
                var batch = new List<INPUT>();
                if (character == '\n')
                {
                    batch.Add(KeyInput(13, false, false)); batch.Add(KeyInput(13, true, false));
                }
                else if (character == '\r') continue;
                else if (character == '\t')
                {
                    batch.Add(KeyInput(9, false, false)); batch.Add(KeyInput(9, true, false));
                }
                else
                {
                    batch.Add(UnicodeInput(character, false)); batch.Add(UnicodeInput(character, true));
                }
                var result = Send(batch);
                if (result != "APPLIED") return result;
                total++;
                if (total % 40 == 0) Thread.Sleep(5);
            }
            return "APPLIED";
        }

        static bool Extended(ushort vk)
        {
            return vk == 45 || vk == 46 || vk == 36 || vk == 35 || vk == 33 || vk == 34 || vk == 37 || vk == 38 || vk == 39 || vk == 40 || vk == 91 || vk == 93 || vk == 144 || vk == 44;
        }

        public static string PressKeys(string combo)
        {
            if (string.IsNullOrEmpty(combo)) return "NOTHING";
            var parts = combo.Split(new[] { '+' }, StringSplitOptions.RemoveEmptyEntries);
            var codes = new List<ushort>();
            foreach (var raw in parts)
            {
                var part = raw.Trim();
                ushort code;
                if (!KeyCodes.TryGetValue(part, out code))
                {
                    if (part.Length == 1) { var batch = new List<INPUT>(); batch.Add(UnicodeInput(part[0], false)); batch.Add(UnicodeInput(part[0], true)); return Send(batch); }
                    return "UNKNOWN_KEY:" + part;
                }
                codes.Add(code);
            }
            var inputs = new List<INPUT>();
            foreach (var code in codes) inputs.Add(KeyInput(code, false, Extended(code)));
            for (int i = codes.Count - 1; i >= 0; i--) inputs.Add(KeyInput(codes[i], true, Extended(codes[i])));
            return Send(inputs);
        }

        static void Absolute(INPUT[] inputs, int x, int y)
        {
            int left = GetSystemMetrics(SM_XVIRTUALSCREEN), top = GetSystemMetrics(SM_YVIRTUALSCREEN);
            int width = Math.Max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN)), height = Math.Max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN));
            int dx = (int)Math.Round((x - left) * 65535.0 / (width - 1));
            int dy = (int)Math.Round((y - top) * 65535.0 / (height - 1));
            for (int i = 0; i < inputs.Length; i++) { inputs[i].u.mi.dx = dx; inputs[i].u.mi.dy = dy; inputs[i].u.mi.dwFlags |= MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK; }
        }

        static INPUT Mouse(uint flags)
        {
            var input = new INPUT();
            input.type = INPUT_MOUSE;
            input.u.mi.dwFlags = flags;
            return input;
        }

        public static string MoveMouse(int x, int y)
        {
            var inputs = new[] { Mouse(MOUSEEVENTF_MOVE) };
            Absolute(inputs, x, y);
            SetCursorPos(x, y);
            return Send(new List<INPUT>(inputs));
        }

        public static string Click(int x, int y, string button, bool doubleClick)
        {
            uint down = MOUSEEVENTF_LEFTDOWN, up = MOUSEEVENTF_LEFTUP;
            var kind = (button ?? "left").ToLowerInvariant();
            if (kind == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
            else if (kind == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }
            var move = new[] { Mouse(MOUSEEVENTF_MOVE) };
            Absolute(move, x, y);
            SetCursorPos(x, y);
            Send(new List<INPUT>(move));
            Thread.Sleep(30);
            var clicks = new List<INPUT>();
            clicks.Add(Mouse(down)); clicks.Add(Mouse(up));
            if (doubleClick) { clicks.Add(Mouse(down)); clicks.Add(Mouse(up)); }
            return Send(clicks);
        }

        public static string Scroll(int delta)
        {
            var input = Mouse(MOUSEEVENTF_WHEEL);
            input.u.mi.mouseData = (uint)(delta * 120);
            return Send(new List<INPUT> { input });
        }

        public static int[] CursorPosition()
        {
            POINT point;
            GetCursorPos(out point);
            return new[] { point.X, point.Y };
        }

        public static ScreenInfo[] Screens()
        {
            var result = new List<ScreenInfo>();
            foreach (var screen in Screen.AllScreens)
            {
                var info = new ScreenInfo();
                info.Device = screen.DeviceName; info.X = screen.Bounds.X; info.Y = screen.Bounds.Y; info.Width = screen.Bounds.Width; info.Height = screen.Bounds.Height; info.Primary = screen.Primary;
                result.Add(info);
            }
            return result.ToArray();
        }

        public static ElementInfo[] Elements(long handle, int limit)
        {
            var result = new List<ElementInfo>();
            var pointer = handle == 0 ? GetForegroundWindow() : new IntPtr(handle);
            if (pointer == IntPtr.Zero || !IsWindow(pointer)) return result.ToArray();
            uint pid;
            GetWindowThreadProcessId(pointer, out pid);
            if (limit <= 0) limit = 150;
            try
            {
                var root = AutomationElement.FromHandle(pointer);
                var queue = new Queue<AutomationElement>();
                queue.Enqueue(root);
                int visited = 0;
                while (queue.Count > 0 && result.Count < limit && visited++ < 600)
                {
                    var item = queue.Dequeue();
                    try
                    {
                        var current = item.Current;
                        if (current.ProcessId != (int)pid) continue;
                        if (!current.IsOffscreen)
                        {
                            var rect = current.BoundingRectangle;
                            var info = new ElementInfo();
                            info.Password = current.IsPassword;
                            info.Name = info.Password ? "[password]" : (current.Name ?? "");
                            if (info.Name.Length > 160) info.Name = info.Name.Substring(0, 160);
                            info.Type = current.ControlType.ProgrammaticName.Replace("ControlType.", "");
                            info.Enabled = current.IsEnabled;
                            if (!double.IsInfinity(rect.Left) && !double.IsNaN(rect.Left))
                            {
                                info.X = (int)rect.Left; info.Y = (int)rect.Top; info.Width = (int)Math.Max(0, rect.Width); info.Height = (int)Math.Max(0, rect.Height);
                            }
                            if (info.Name.Length > 0 || info.Type == "Edit" || info.Type == "Document") result.Add(info);
                        }
                        var child = TreeWalker.ControlViewWalker.GetFirstChild(item);
                        int siblings = 0;
                        while (child != null && siblings++ < 150 && queue.Count < 600)
                        {
                            queue.Enqueue(child);
                            child = TreeWalker.ControlViewWalker.GetNextSibling(child);
                        }
                    }
                    catch { }
                }
            }
            catch { }
            return result.ToArray();
        }

        public static bool FocusedIsPassword()
        {
            try
            {
                var focused = AutomationElement.FocusedElement;
                return focused != null && focused.Current.IsPassword;
            }
            catch { return false; }
        }

        static T Sta<T>(Func<T> work)
        {
            T value = default(T);
            Exception failure = null;
            var thread = new Thread(delegate() { try { value = work(); } catch (Exception error) { failure = error; } });
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            thread.Join();
            if (failure != null) throw failure;
            return value;
        }

        public static string ClipboardGet()
        {
            return Sta<string>(delegate() { return Clipboard.ContainsText() ? Clipboard.GetText() : ""; });
        }

        public static string ClipboardSet(string text)
        {
            return Sta<string>(delegate() { if (string.IsNullOrEmpty(text)) Clipboard.Clear(); else Clipboard.SetText(text); return "SET"; });
        }
    }
}
