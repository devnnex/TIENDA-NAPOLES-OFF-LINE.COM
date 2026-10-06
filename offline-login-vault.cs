using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

// Credenciales de uso offline para este usuario de Windows. El PIN nunca se
// guarda; el token y el perfil quedan cifrados con DPAPI CurrentUser.
public static class OfflineLoginVault
{
    private const int Version = 1;
    // DPAPI aísla el fichero por usuario de Windows; PBKDF2 añade defensa
    // frente a intentos locales sin bloquear varios segundos cada acceso.
    private const int Iterations = 120000;
    private const int MaxFailures = 5;
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("TiendaNapolesOffline:login-v1");

    public sealed class Result
    {
        public string Status;
        public string Token;
        public string UserJson;
    }

    private sealed class Record
    {
        public string Username;
        public byte[] Salt;
        public byte[] Verifier;
        public string Token;
        public string UserJson;
        public long VerifiedAt;
        public int Failures;
        public long LockedUntil;
    }

    private static string Normalize(string username)
    {
        string normalized = (username ?? "").Trim().ToLowerInvariant();
        if (normalized.Length < 3 || normalized.Length > 40) throw new ArgumentException("Usuario no valido.");
        return normalized;
    }

    private static string FilePath(string username)
    {
        byte[] digest;
        using (var sha = SHA256.Create()) digest = sha.ComputeHash(Encoding.UTF8.GetBytes(Normalize(username)));
        string name = BitConverter.ToString(digest).Replace("-", "").ToLowerInvariant() + ".vault";
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Tienda Napoles Offline", "login-vault", name);
    }

    private static byte[] Derive(string pin, byte[] salt)
    {
        using (var pbkdf2 = new Rfc2898DeriveBytes(pin, salt, Iterations, HashAlgorithmName.SHA256))
            return pbkdf2.GetBytes(32);
    }

    private static bool Equal(byte[] left, byte[] right)
    {
        if (left.Length != right.Length) return false;
        int difference = 0;
        for (int i = 0; i < left.Length; i++) difference |= left[i] ^ right[i];
        return difference == 0;
    }

    private static Record Read(string username)
    {
        string path = FilePath(username);
        if (!File.Exists(path)) return null;
        byte[] plaintext = ProtectedData.Unprotect(File.ReadAllBytes(path), Entropy, DataProtectionScope.CurrentUser);
        using (var reader = new BinaryReader(new MemoryStream(plaintext), Encoding.UTF8))
        {
            if (reader.ReadInt32() != Version) throw new InvalidDataException("Version local no compatible.");
            var record = new Record {
                Username = reader.ReadString(), Salt = reader.ReadBytes(16), Verifier = reader.ReadBytes(32),
                Token = reader.ReadString(), UserJson = reader.ReadString(), VerifiedAt = reader.ReadInt64(),
                Failures = reader.ReadInt32(), LockedUntil = reader.ReadInt64()
            };
            if (record.Username != Normalize(username) || record.Salt.Length != 16 || record.Verifier.Length != 32)
                throw new InvalidDataException("Credencial local no valida.");
            return record;
        }
    }

    private static void Write(Record record)
    {
        byte[] plaintext;
        using (var memory = new MemoryStream())
        {
            using (var writer = new BinaryWriter(memory, Encoding.UTF8, true))
            {
                writer.Write(Version);
                writer.Write(record.Username);
                writer.Write(record.Salt);
                writer.Write(record.Verifier);
                writer.Write(record.Token);
                writer.Write(record.UserJson);
                writer.Write(record.VerifiedAt);
                writer.Write(record.Failures);
                writer.Write(record.LockedUntil);
            }
            plaintext = memory.ToArray();
        }
        byte[] protectedBytes = ProtectedData.Protect(plaintext, Entropy, DataProtectionScope.CurrentUser);
        string path = FilePath(record.Username);
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllBytes(temporary, protectedBytes);
            if (File.Exists(path)) File.Replace(temporary, path, null);
            else File.Move(temporary, path);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    public static void Enroll(string username, string pin, string token, string userJson)
    {
        username = Normalize(username);
        if (string.IsNullOrEmpty(pin) || pin.Length < 4 || pin.Length > 12 ||
            string.IsNullOrEmpty(token) || token.Length > 256 ||
            string.IsNullOrEmpty(userJson) || userJson.Length > 10000)
            throw new ArgumentException("Credencial no valida.");
        foreach (char digit in pin) if (digit < '0' || digit > '9') throw new ArgumentException("PIN no valido.");
        var salt = new byte[16];
        using (var random = RandomNumberGenerator.Create()) random.GetBytes(salt);
        Write(new Record {
            Username = username, Salt = salt, Verifier = Derive(pin, salt), Token = token,
            UserJson = userJson, VerifiedAt = DateTime.UtcNow.Ticks
        });
    }

    public static Result Verify(string username, string pin)
    {
        var record = Read(username);
        if (record == null) return new Result { Status = "missing" };
        long now = DateTime.UtcNow.Ticks;
        if (record.VerifiedAt > now || now - record.VerifiedAt > TimeSpan.FromDays(30).Ticks)
            return new Result { Status = "expired" };
        if (record.LockedUntil > now) return new Result { Status = "locked" };
        byte[] candidate = Derive(pin ?? "", record.Salt);
        if (!Equal(candidate, record.Verifier))
        {
            record.Failures++;
            if (record.Failures >= MaxFailures)
            {
                record.Failures = 0;
                record.LockedUntil = now + TimeSpan.FromMinutes(5).Ticks;
            }
            Write(record);
            return new Result { Status = "invalid" };
        }
        if (record.Failures != 0 || record.LockedUntil != 0)
        {
            record.Failures = 0;
            record.LockedUntil = 0;
            Write(record);
        }
        return new Result { Status = "ok", Token = record.Token, UserJson = record.UserJson };
    }

    public static void Forget(string username)
    {
        string path = FilePath(username);
        if (File.Exists(path)) File.Delete(path);
    }
}
