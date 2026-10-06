using System;
using System.ComponentModel;
using System.Drawing.Printing;
using System.Runtime.InteropServices;

// Envia exclusivamente el pulso ESC/POS al cajon conectado a una impresora
// instalada en Windows. El spooler resuelve USB, red y puertos serie.
public static class CashDrawerPrinter
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DocInfo
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string Name;
        [MarshalAs(UnmanagedType.LPWStr)] public string OutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string DataType;
    }

    [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenPrinter(string name, out IntPtr printer, IntPtr defaults);

    [DllImport("winspool.drv", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ClosePrinter(IntPtr printer);

    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int StartDocPrinter(IntPtr printer, int level, ref DocInfo info);

    [DllImport("winspool.drv", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EndDocPrinter(IntPtr printer);

    [DllImport("winspool.drv", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WritePrinter(IntPtr printer, byte[] data, int count, out int written);

    public static string[] InstalledPrinters()
    {
        var names = new System.Collections.Generic.List<string>();
        foreach (string name in PrinterSettings.InstalledPrinters) names.Add(name);
        return names.ToArray();
    }

    public static void Open(string name, int pin)
    {
        if (pin != 0 && pin != 1) throw new ArgumentOutOfRangeException("pin");
        bool installed = false;
        foreach (string candidate in InstalledPrinters())
        {
            if (string.Equals(name, candidate, StringComparison.OrdinalIgnoreCase))
            {
                name = candidate;
                installed = true;
                break;
            }
        }
        if (!installed) throw new InvalidOperationException("La impresora seleccionada ya no esta instalada en Windows.");

        IntPtr printer;
        if (!OpenPrinter(name, out printer, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var info = new DocInfo { Name = "Tienda Napoles - abrir cajon", DataType = "RAW" };
            if (StartDocPrinter(printer, 1, ref info) == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                // ESC p m t1 t2: pin 2/5, pulso de 100 ms y pausa de 100 ms.
                byte[] command = { 0x1B, 0x70, (byte)pin, 0x32, 0x32 };
                int written;
                if (!WritePrinter(printer, command, command.Length, out written) || written != command.Length)
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows no acepto la orden completa de apertura.");
            }
            finally { EndDocPrinter(printer); }
        }
        finally { ClosePrinter(printer); }
    }
}
