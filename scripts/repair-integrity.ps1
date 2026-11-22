param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'

# Only the distributed executable's mandatory label is changed. No recursion,
# elevation, process termination, ownership changes, or DACL modifications.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class PetFileIntegrity {
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)]
    static extern uint GetNamedSecurityInfoW(string name, int type, uint info,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr sd);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
        IntPtr sd, uint revision, uint info, out IntPtr text, out uint length);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
    public static string Read(string path) {
        IntPtr owner, group, dacl, sacl, sd;
        uint error = GetNamedSecurityInfoW(path, 1, 0x10, out owner, out group,
            out dacl, out sacl, out sd);
        if (error != 0) throw new Win32Exception((int)error);
        try {
            IntPtr text; uint length;
            if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, 1, 0x10,
                out text, out length)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try { return Marshal.PtrToStringUni(text); }
            finally { LocalFree(text); }
        } finally { LocalFree(sd); }
    }
}
'@

$root = Split-Path -Parent $PSScriptRoot
$name = -join ([char[]](0x966A,0x4F34,0x684C,0x5BA0))
$exe = Join-Path $root ("release\$name.exe")
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "Missing executable: $exe" }
$label = [PetFileIntegrity]::Read($exe)
Write-Output "Executable integrity: $label"
if ($label -notmatch '\(ML;[^)]*;;;(?:LW|S-1-16-4096|UN|S-1-16-0)\)') {
    Write-Output 'No low/untrusted integrity label found. No change needed.'
    exit 0
}
if ($CheckOnly) {
    Write-Error 'Executable is low integrity. Repair it in a normal user PowerShell before launching.'
    exit 1
}

$backup = Join-Path $root 'work\integrity-repair-20261110'
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$label | Out-File -LiteralPath (Join-Path $backup 'mandatory-label-before.txt') -Encoding UTF8
$daclBefore = (Get-Acl -LiteralPath $exe).Sddl
$hashBefore = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
$icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
& $icacls $exe /setintegritylevel M
if ($LASTEXITCODE -ne 0) {
    throw 'Cannot restore executable integrity here. Run this script from your normal Windows PowerShell. No program has been stopped.'
}
$labelAfter = [PetFileIntegrity]::Read($exe)
if ($labelAfter -notmatch '\(ML;[^)]*;;;(?:ME|S-1-16-8192)\)') {
    throw "Expected medium integrity after repair, found: $labelAfter"
}
if ((Get-Acl -LiteralPath $exe).Sddl -ne $daclBefore) { throw 'Unexpected DACL change.' }
if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne $hashBefore) { throw 'Unexpected executable content change.' }
$labelAfter | Out-File -LiteralPath (Join-Path $backup 'mandatory-label-after.txt') -Encoding UTF8
Write-Output 'Restored this executable to medium integrity. Executable bytes and DACL are unchanged.'
Write-Output 'No applications were launched or stopped. Start the desktop pet normally to verify.'
