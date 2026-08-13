[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Root
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'The native Windows physical-safety check can run only on Windows.'
}

if (-not ('ClaudePeer.NativeFileLinks' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace ClaudePeer
{
    public static class NativeFileLinks
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct ByHandleFileInformation
        {
            public uint FileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle handle,
            out ByHandleFileInformation information
        );

        public static uint GetLinkCount(string path)
        {
            using (FileStream stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete))
            {
                ByHandleFileInformation information;
                if (!GetFileInformationByHandle(stream.SafeFileHandle, out information))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                return information.NumberOfLinks;
            }
        }
    }
}
'@
}

$resolvedRoot = [System.IO.Path]::GetFullPath($Root)
if (-not [System.IO.Directory]::Exists($resolvedRoot)) {
    throw "The implementation worktree root is not an existing directory: $resolvedRoot"
}
$rootAttributes = [System.IO.File]::GetAttributes($resolvedRoot)
if (($rootAttributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The implementation worktree root is a filesystem reparse point.'
}

$rootGitPath = [System.IO.Path]::GetFullPath((Join-Path $resolvedRoot '.git'))
$stack = New-Object 'System.Collections.Generic.Stack[string]'
$stack.Push($resolvedRoot)
$checkedFiles = 0
$checkedDirectories = 0

while ($stack.Count -gt 0) {
    $directory = $stack.Pop()
    $checkedDirectories += 1
    foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($directory)) {
        $fullPath = [System.IO.Path]::GetFullPath($entry)
        $relativePath = $fullPath.Substring($resolvedRoot.TrimEnd('\', '/').Length).TrimStart('\', '/')
        $attributes = [System.IO.File]::GetAttributes($fullPath)
        if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Filesystem reparse points and junctions are refused for Claude implementation: $relativePath"
        }

        if (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) {
            $canonicalName = [System.IO.Path]::GetFileName($fullPath).TrimEnd([char[]]@(' ', '.'))
            if ($canonicalName.Equals('.git', [System.StringComparison]::OrdinalIgnoreCase) -and
                -not $fullPath.Equals($rootGitPath, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Nested Git metadata is refused for Claude implementation: $relativePath"
            }
            $stack.Push($fullPath)
            continue
        }

        $checkedFiles += 1
        $linkCount = [ClaudePeer.NativeFileLinks]::GetLinkCount($fullPath)
        if ($linkCount -gt 1) {
            throw "Regular files with multiple hard links are refused for Claude implementation: $relativePath"
        }
    }
}

[pscustomobject]@{
    safe               = $true
    root               = $resolvedRoot
    checkedFiles       = $checkedFiles
    checkedDirectories = $checkedDirectories
} | ConvertTo-Json -Compress
