using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Tienda Napoles Offline")]
[assembly: AssemblyDescription("Iniciador de Tienda Napoles Offline sin consola")]
[assembly: AssemblyCompany("Tienda Napoles")]
[assembly: AssemblyProduct("Tienda Napoles Offline")]
[assembly: AssemblyVersion("1.0.9.0")]
[assembly: AssemblyFileVersion("1.0.9.0")]

internal static class TiendaNapolesOffline
{
    private const string HealthUrl = "http://127.0.0.1:8766/__tienda_napoles_health";
    private const string AppUrl = "http://127.0.0.1:8766/admin.html";
    private const string InstallMarkerUrl = "http://127.0.0.1:8766/tienda-napoles-installed.marker";
    private const string DrawerHealthUrl = "http://127.0.0.1:8766/__tienda_napoles_drawer_health";
    private const string LoginHealthUrl = "http://127.0.0.1:8766/__tienda_napoles_login_health";
    private const string InstallMarker = "TiendaNapolesOffline:1B759C3D-EEAC-42F1-8C91-A400775027C1";

    [STAThread]
    private static void Main()
    {
        try
        {
            string appDirectory = AppDomain.CurrentDomain.BaseDirectory;
            string serverScript = Path.Combine(appDirectory, "offline-server.ps1");
            if (!File.Exists(serverScript))
            {
                ShowError("Falta el servidor local de Tienda Napoles. Reinstala la aplicacion.");
                return;
            }

            if (ServerIsReady() && (!ServerIsInstalledCopy() || !ServerSupportsDrawer() || !ServerSupportsLogin()))
            {
                if (!TryStopPreviousServer(appDirectory, !ServerSupportsDrawer() || !ServerSupportsLogin()))
                {
                    ShowError("El puerto local esta ocupado por otro proceso que no se pudo identificar como Tienda Napoles. Cierra esa aplicacion e intenta de nuevo.");
                    return;
                }
            }

            if (!ServerIsReady())
            {
                var server = new ProcessStartInfo("powershell.exe")
                {
                    Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + serverScript + "\"",
                    WorkingDirectory = appDirectory,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                Process.Start(server);

                DateTime deadline = DateTime.UtcNow.AddSeconds(15);
                while (DateTime.UtcNow < deadline && !ServerIsReady())
                {
                    Thread.Sleep(250);
                }
                if (!ServerIsReady())
                {
                    ShowError("No fue posible iniciar el servidor local. Cierra Tienda Napoles e intenta abrirla nuevamente.");
                    return;
                }
            }

            if (!ServerIsInstalledCopy())
            {
                ShowError("No fue posible verificar el servidor instalado. Cierra Tienda Napoles e intenta abrirla nuevamente.");
                return;
            }

            string url = AppUrl + "?forceLogin=" + Guid.NewGuid().ToString("N");
            string browser = FindBrowser();
            if (browser != null)
            {
                HashSet<IntPtr> previousWindows = TaskbarIdentity.WindowHandles();
                Process.Start(new ProcessStartInfo(browser, "--app=\"" + url + "\"")
                {
                    UseShellExecute = true
                });
                TaskbarIdentity.AttachToNewAppWindow(browser, appDirectory, previousWindows);
            }
            else
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
        }
        catch (Exception error)
        {
            ShowError("No fue posible abrir Tienda Napoles. " + error.Message);
        }
    }

    private static bool ServerIsReady()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(HealthUrl);
            request.Proxy = null;
            request.Timeout = 1000;
            request.ReadWriteTimeout = 1000;
            using (var response = (HttpWebResponse)request.GetResponse())
            {
                return response.StatusCode == HttpStatusCode.OK;
            }
        }
        catch (WebException)
        {
            return false;
        }
    }

    private static bool ServerIsInstalledCopy()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(InstallMarkerUrl);
            request.Proxy = null;
            request.Timeout = 1000;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream()))
            {
                return response.StatusCode == HttpStatusCode.OK && reader.ReadToEnd().Trim() == InstallMarker;
            }
        }
        catch (WebException)
        {
            return false;
        }
    }

    private static bool ServerSupportsDrawer()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(DrawerHealthUrl);
            request.Proxy = null;
            request.Timeout = 1000;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream()))
                return response.StatusCode == HttpStatusCode.OK && reader.ReadToEnd().Trim() == "OK_DRAWER_V2";
        }
        catch (WebException) { return false; }
    }

    private static bool ServerSupportsLogin()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(LoginHealthUrl);
            request.Proxy = null;
            request.Timeout = 1000;
            using (var response = (HttpWebResponse)request.GetResponse())
                return response.StatusCode == HttpStatusCode.OK;
        }
        catch (WebException) { return false; }
    }

    private static bool TryStopPreviousServer(string appDirectory, bool allowInstalledDirectory)
    {
        Process previous = null;
        int matches = 0;
        int currentSession = Process.GetCurrentProcess().SessionId;
        using (var searcher = new ManagementObjectSearcher(
            "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'powershell.exe' OR Name = 'pwsh.exe'"))
        using (var processes = searcher.Get())
        {
            foreach (ManagementObject entry in processes)
            {
                try
                {
                    string scriptPath = GetServerScriptPath(entry["CommandLine"] as string);
                    if (scriptPath == null || !File.Exists(scriptPath)) continue;
                    if (!allowInstalledDirectory && string.Equals(Path.GetDirectoryName(scriptPath).TrimEnd(Path.DirectorySeparatorChar),
                        appDirectory.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)) continue;

                    int processId = Convert.ToInt32(entry["ProcessId"]);
                    Process candidate = Process.GetProcessById(processId);
                    if (candidate.SessionId != currentSession || candidate.HasExited)
                    {
                        candidate.Dispose();
                        continue;
                    }
                    if (!ServesFileFrom(Path.Combine(Path.GetDirectoryName(scriptPath), "admin.html")))
                    {
                        candidate.Dispose();
                        continue;
                    }
                    matches++;
                    if (matches == 1) previous = candidate;
                    else candidate.Dispose();
                }
                catch (Exception)
                {
                    // Ignore processes that cannot be inspected; never stop an unverified one.
                }
            }
        }

        if (matches != 1)
        {
            if (previous != null) previous.Dispose();
            return false;
        }

        using (previous)
        {
            try
            {
                previous.Kill();
                previous.WaitForExit(5000);
                DateTime deadline = DateTime.UtcNow.AddSeconds(5);
                while (DateTime.UtcNow < deadline && ServerIsReady()) Thread.Sleep(200);
                return !ServerIsReady();
            }
            catch (Exception)
            {
                return false;
            }
        }
    }

    private static string GetServerScriptPath(string commandLine)
    {
        if (string.IsNullOrEmpty(commandLine)) return null;
        Match match = Regex.Match(commandLine,
            @"(?:^|\s)-File\s+(?:""(?<quoted>[^""]+offline-server\.ps1)""|(?<plain>\S+offline-server\.ps1))(?=\s|$)",
            RegexOptions.IgnoreCase);
        if (!match.Success) return null;
        Match port = Regex.Match(commandLine, @"(?:^|\s)-Port\s+(?<port>\d+)(?=\s|$)", RegexOptions.IgnoreCase);
        if (port.Success && port.Groups["port"].Value != "8766") return null;
        return Path.GetFullPath(match.Groups["quoted"].Success
            ? match.Groups["quoted"].Value : match.Groups["plain"].Value);
    }

    private static bool ServesFileFrom(string path)
    {
        if (!File.Exists(path)) return false;
        byte[] expected = File.ReadAllBytes(path);
        if (expected.Length == 0 || expected.Length > 2 * 1024 * 1024) return false;
        var request = (HttpWebRequest)WebRequest.Create(AppUrl);
        request.Proxy = null;
        request.Timeout = 1500;
        request.ReadWriteTimeout = 1500;
        using (var response = (HttpWebResponse)request.GetResponse())
        using (var stream = response.GetResponseStream())
        {
            if (response.StatusCode != HttpStatusCode.OK) return false;
            for (int i = 0; i < expected.Length; i++)
            {
                if (stream.ReadByte() != expected[i]) return false;
            }
            return stream.ReadByte() == -1;
        }
    }

    private static string FindBrowser()
    {
        string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string[] candidates = {
            Path.Combine(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(programFiles, "Microsoft", "Edge", "Application", "msedge.exe")
        };
        foreach (string candidate in candidates)
        {
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    private static void ShowError(string message)
    {
        MessageBox.Show(message, "Tienda Napoles Offline", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}

// El navegador es el anfitrion; la ventana y los accesos directos deben
// compartir identidad y relanzar este iniciador al anclarlos en Windows.
internal static class TaskbarIdentity
{
    internal const string AppId = "TiendaNapoles.Offline";
    private static readonly Guid PropertyFormat = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    private delegate bool EnumWindowCallback(IntPtr window, IntPtr parameter);

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct PropertyKey
    {
        internal Guid Format;
        internal uint Id;
        internal PropertyKey(uint id) { Format = PropertyFormat; Id = id; }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropVariant
    {
        internal ushort Type;
        private ushort reserved1, reserved2, reserved3;
        internal IntPtr Value;
        private IntPtr unionRemainder;
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder value, int maxCount);
    [DllImport("shell32.dll")] private static extern int SHGetPropertyStoreForWindow(IntPtr window, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
    [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PropVariant value);

    internal static HashSet<IntPtr> WindowHandles()
    {
        var result = new HashSet<IntPtr>();
        EnumWindows(delegate(IntPtr window, IntPtr parameter) { result.Add(window); return true; }, IntPtr.Zero);
        return result;
    }

    internal static void AttachToNewAppWindow(string browser, string directory, HashSet<IntPtr> previousWindows)
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(15);
        IntPtr attached = IntPtr.Zero;
        while (DateTime.UtcNow < deadline)
        {
            EnumWindows(delegate(IntPtr window, IntPtr parameter)
            {
                if (previousWindows.Contains(window) || (attached != IntPtr.Zero && window != attached)) return true;
                IPropertyStore store = null;
                try
                {
                    var className = new StringBuilder(128);
                    GetClassName(window, className, className.Capacity);
                    if (className.ToString() != "Chrome_WidgetWin_1") return true;
                    uint processId;
                    GetWindowThreadProcessId(window, out processId);
                    using (Process process = Process.GetProcessById((int)processId))
                    {
                        if (process.SessionId != Process.GetCurrentProcess().SessionId ||
                            !string.Equals(process.MainModule.FileName, browser, StringComparison.OrdinalIgnoreCase)) return true;
                    }
                    Guid iid = typeof(IPropertyStore).GUID;
                    if (SHGetPropertyStoreForWindow(window, ref iid, out store) < 0) return true;
                    var key = new PropertyKey(5);
                    PropVariant current;
                    Marshal.ThrowExceptionForHR(store.GetValue(ref key, out current));
                    string identity;
                    try { identity = current.Type == 31 ? Marshal.PtrToStringUni(current.Value) : null; }
                    finally { PropVariantClear(ref current); }
                    // Chromium genera el nombre de --app con host + '_' + ruta.
                    // Nunca modificar una ventana normal del navegador.
                    const string appComponent = ".127.0.0.1_admin.html";
                    if (identity == null || !(identity.EndsWith(appComponent, StringComparison.Ordinal) ||
                        identity.Contains(appComponent + ".") || (window == attached && identity == AppId))) return true;
                    SetString(store, 2, "\"" + Path.Combine(directory, "TiendaNapolesOffline.exe") + "\"");
                    SetString(store, 4, "Tienda N\u00e1poles");
                    SetString(store, 3, Path.Combine(directory, "tienda-napoles.ico") + ",0");
                    SetString(store, 5, AppId);
                    Marshal.ThrowExceptionForHR(store.Commit());
                    if (attached == IntPtr.Zero) { attached = window; deadline = DateTime.UtcNow.AddSeconds(3); }
                }
                catch (Exception) { /* Un fallo del icono no impide abrir ni sincronizar la aplicacion. */ }
                finally { if (store != null) Marshal.ReleaseComObject(store); }
                return true;
            }, IntPtr.Zero);
            Thread.Sleep(250);
        }
    }

    private static void SetString(IPropertyStore store, uint id, string text)
    {
        var key = new PropertyKey(id);
        var value = new PropVariant { Type = 31, Value = Marshal.StringToCoTaskMemUni(text) };
        try { Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref value)); }
        finally { PropVariantClear(ref value); }
    }
}
