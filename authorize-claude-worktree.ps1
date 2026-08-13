[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$Worktree,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string[]]$ClaudePaths,

    [ValidateRange(1, 168)]
    [int]$AuthorizationHours = 24
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & git -C $WorkingDirectory @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) {
        throw "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)"
    }
    return ($output -join [Environment]::NewLine).Trim()
}

function Get-NormalizedAllowedPath {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$Root
    )

    if ([System.IO.Path]::IsPathRooted($Value)) {
        throw "ClaudePaths entries must be relative to the worktree: $Value"
    }
    $normalized = ($Value -replace '\\', '/').Trim()
    if ($normalized.StartsWith('./')) { $normalized = $normalized.Substring(2) }
    $normalized = $normalized.TrimEnd('/')
    if (-not $normalized) {
        throw "Invalid ClaudePaths entry: $Value"
    }
    if ($normalized -match '[\x00-\x1f*?\[\]()~<>:"|!#]') {
        throw "ClaudePaths contains characters that are unsafe in Claude permission patterns or Win32 aliases: $Value"
    }

    $segments = @($normalized.Split('/'))
    foreach ($segment in $segments) {
        if (-not $segment -or $segment -eq '.' -or $segment -eq '..') {
            throw "ClaudePaths cannot contain empty, current-directory, or parent-directory segments: $Value"
        }
        $win32CanonicalSegment = $segment.TrimEnd([char[]]@(' ', '.'))
        if ($win32CanonicalSegment.Length -ne $segment.Length) {
            throw "ClaudePaths segments cannot end in a dot or space on Windows: $Value"
        }
        if ($win32CanonicalSegment.Equals('.git', [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'ClaudePaths cannot authorize the Git administration directory or any Win32 alias of it.'
        }
        $deviceBase = ($win32CanonicalSegment -split '\.', 2)[0]
        if ($deviceBase -match '^(?i:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$') {
            throw "ClaudePaths cannot authorize a reserved Win32 device name: $Value"
        }
    }

    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $candidateFull = [System.IO.Path]::GetFullPath((Join-Path $rootFull ($normalized -replace '/', [System.IO.Path]::DirectorySeparatorChar)))
    $rootPrefix = $rootFull + [System.IO.Path]::DirectorySeparatorChar
    if ($candidateFull.Equals($rootFull, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $candidateFull.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "ClaudePaths must resolve strictly inside the linked worktree: $Value"
    }
    return $normalized
}

$worktreeInput = [System.IO.Path]::GetFullPath($Worktree)
if (-not [System.IO.Directory]::Exists($worktreeInput)) {
    throw "Worktree is not an existing directory: $worktreeInput"
}
$rootText = Invoke-Git -WorkingDirectory $worktreeInput -Arguments @('rev-parse', '--show-toplevel')
$root = [System.IO.Path]::GetFullPath($rootText)
$gitDirText = Invoke-Git -WorkingDirectory $root -Arguments @('rev-parse', '--path-format=absolute', '--git-dir')
$commonDirText = Invoke-Git -WorkingDirectory $root -Arguments @('rev-parse', '--path-format=absolute', '--git-common-dir')
$gitDir = [System.IO.Path]::GetFullPath($gitDirText)
$commonDir = [System.IO.Path]::GetFullPath($commonDirText)
foreach ($requiredDirectory in @($root, $gitDir, $commonDir)) {
    if (-not [System.IO.Directory]::Exists($requiredDirectory)) {
        throw "Git reported an administration path that is not an existing directory: $requiredDirectory"
    }
}

if ($gitDir.Equals($commonDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Write authorization is restricted to a linked Git worktree, not a primary checkout.'
}
$expectedAdminPrefix = (Join-Path $commonDir 'worktrees').TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
if (-not $gitDir.StartsWith($expectedAdminPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The Git directory is not a standard linked-worktree administration directory.'
}

$branch = Invoke-Git -WorkingDirectory $root -Arguments @('branch', '--show-current')
if ($branch -notmatch '^(duet|duo)/claude/[a-z0-9][a-z0-9._-]*$') {
    throw 'The worktree branch must be named duet/claude/<task> or duo/claude/<task>.'
}
$dirty = Invoke-Git -WorkingDirectory $root -Arguments @('status', '--porcelain')
if ($dirty) { throw 'The Claude worktree must be clean before write authorization is issued.' }

$ignored = Invoke-Git -WorkingDirectory $root -Arguments @(
    'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--'
)
if ($ignored) {
    throw 'The Claude worktree contains ignored files or directories. Use a fresh worktree before issuing write authorization.'
}
$indexEntries = Invoke-Git -WorkingDirectory $root -Arguments @('ls-files', '--stage', '--')
if ($indexEntries -match '(?m)^160000 ') {
    throw 'Repositories containing Git submodules are refused for Claude implementation.'
}
if ($indexEntries -match '(?m)^120000 ') {
    throw 'Repositories containing tracked symbolic links are refused for Claude implementation.'
}

$indexFlags = Invoke-Git -WorkingDirectory $root -Arguments @('ls-files', '-v', '--')
$unsafeIndexFlags = @($indexFlags -split '\r?\n' | Where-Object {
    $_ -and (($_[0] -cmatch '[a-z]') -or $_[0] -ceq 'S')
})
if ($unsafeIndexFlags.Count -gt 0) {
    throw 'Assume-unchanged and skip-worktree index flags are refused for Claude implementation.'
}
if ((Invoke-Git -WorkingDirectory $root -Arguments @('config', '--bool', '--default=false', 'core.sparseCheckout')) -eq 'true') {
    throw 'Sparse checkouts are refused for Claude implementation.'
}

$physicalSafetyScript = Join-Path $PSScriptRoot 'plugins\claude-peer\scripts\worktree-physical-safety.ps1'
if (-not (Test-Path -LiteralPath $physicalSafetyScript -PathType Leaf)) {
    throw 'The bundled physical-safety checker is missing; write authorization is refused.'
}
$physicalSafety = (& $physicalSafetyScript -Root $root | ConvertFrom-Json)
if ($physicalSafety.safe -ne $true) {
    throw 'The physical-safety checker did not certify this worktree.'
}

$allowedPaths = @($ClaudePaths | ForEach-Object { Get-NormalizedAllowedPath -Value $_ -Root $root } | Select-Object -Unique)
if ($allowedPaths.Count -eq 0) { throw 'At least one ClaudePaths entry is required.' }

$baseCommit = Invoke-Git -WorkingDirectory $root -Arguments @('rev-parse', 'HEAD')
$markerText = Invoke-Git -WorkingDirectory $root -Arguments @('rev-parse', '--git-path', 'claude-peer-write-ok.json')
$markerPath = if ([System.IO.Path]::IsPathRooted($markerText)) {
    [System.IO.Path]::GetFullPath($markerText)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $root $markerText))
}

$issuedAt = (Get-Date).ToUniversalTime()
$authorization = [ordered]@{
    version       = 1
    nonce         = [guid]::NewGuid().ToString()
    worktreeRoot  = $root
    commonGitDir  = $commonDir
    branch        = $branch
    baseCommit    = $baseCommit
    allowedPaths  = $allowedPaths
    issuedAtUtc   = $issuedAt.ToString('o')
    expiresAtUtc  = $issuedAt.AddHours($AuthorizationHours).ToString('o')
}

if ($PSCmdlet.ShouldProcess($markerPath, "Issue one-use Claude write authorization for: $($allowedPaths -join ', ')")) {
    $json = $authorization | ConvertTo-Json -Depth 4
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($markerPath, $json, $utf8WithoutBom)
}

[pscustomobject]@{
    Worktree      = $root
    Branch        = $branch
    BaseCommit    = $baseCommit
    AllowedPaths  = $allowedPaths -join ', '
    ExpiresAtUtc  = $authorization.expiresAtUtc
    Marker        = $markerPath
    OneUse        = $true
}
