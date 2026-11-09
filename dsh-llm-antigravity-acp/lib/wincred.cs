using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

class Program {
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredWrite([In] ref CREDENTIAL userCredential, int flags);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredDelete(string target, int type, int flags);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern void CredFree(IntPtr credentialPtr);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    static int Main(string[] args) {
        if (args.Length < 2) return 1;
        string action = args[0].ToLowerInvariant();
        string target = args[1];

        if (action == "read") {
            IntPtr credPtr;
            if (CredRead(target, 1, 0, out credPtr)) {
                var cred = (CREDENTIAL)Marshal.PtrToStructure(credPtr, typeof(CREDENTIAL));
                byte[] blob = new byte[cred.CredentialBlobSize];
                Marshal.Copy(cred.CredentialBlob, blob, 0, cred.CredentialBlobSize);
                CredFree(credPtr);
                using (var stdout = Console.OpenStandardOutput()) {
                    stdout.Write(blob, 0, blob.Length);
                }
                return 0;
            }
            return 2;
        }

        if (action == "write") {
            string username = args.Length > 2 ? args[2] : "antigravity";
            byte[] blob;
            using (var stdin = Console.OpenStandardInput())
            using (var ms = new MemoryStream()) {
                stdin.CopyTo(ms);
                blob = ms.ToArray();
            }

            var cred = new CREDENTIAL();
            cred.Type = 1; // CRED_TYPE_GENERIC
            cred.TargetName = target;
            cred.UserName = username;
            cred.Persist = 2; // CRED_PERSIST_LOCAL_MACHINE
            cred.CredentialBlobSize = blob.Length;
            cred.CredentialBlob = Marshal.AllocHGlobal(blob.Length);
            Marshal.Copy(blob, 0, cred.CredentialBlob, blob.Length);

            bool ok = CredWrite(ref cred, 0);
            Marshal.FreeHGlobal(cred.CredentialBlob);
            return ok ? 0 : 3;
        }

        if (action == "delete") {
            return CredDelete(target, 1, 0) ? 0 : 4;
        }

        return 1;
    }
}
