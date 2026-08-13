[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$Repository,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9][a-z0-9._-]{0,47}$')]
    [string]$Task,

    [string]$DestinationRoot,

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

function Quote-PowerShellLiteral {
    param([Parameter(Mandatory = $true)][string]$Value)
    return "'$($Value.Replace("'", "''"))'"
}

function Get-RecoveryInstructions {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][array]$Created
    )

    $lines = @(
        'The helper left partial state and did not delete it automatically.',
        'First verify each listed worktree is clean and still at the reported base commit. Then run:'
    )
    foreach ($item in $Created) {
        $quotedPath = Quote-PowerShellLiteral -Value $item.Path
        $quotedRoot = Quote-PowerShellLiteral -Value $Root
        $quotedBranch = Quote-PowerShellLiteral -Value $item.Branch
        $lines += "git -C $quotedPath status --porcelain"
        $lines += "git -C $quotedPath rev-parse HEAD"
        $lines += "git -C $quotedRoot worktree remove -- $quotedPath"
        $lines += "git -C $quotedRoot branch -d -- $quotedBranch"
    }
    return ($lines -join [Environment]::NewLine)
}

$resolvedInput = [System.IO.Path]::GetFullPath($Repository)
if (-not [System.IO.Directory]::Exists($resolvedInput)) {
    throw "Repository is not an existing directory: $resolvedInput"
}
$repoRootText = Invoke-Git -WorkingDirectory $resolvedInput -Arguments @('rev-parse', '--show-toplevel')
$repoRoot = [System.IO.Path]::GetFullPath($repoRootText)
if (-not [System.IO.Directory]::Exists($repoRoot)) {
    throw "Git reported a repository root that is not an existing directory: $repoRoot"
}

$dirty = Invoke-Git -WorkingDirectory $repoRoot -Arguments @('status', '--porcelain')
if ($dirty) {
    throw 'The repository is not clean. Commit or stash the current changes before creating parallel agent worktrees.'
}

$baseSha = Invoke-Git -WorkingDirectory $repoRoot -Arguments @('rev-parse', 'HEAD')
$repoName = [System.IO.Path]::GetFileName($repoRoot.TrimEnd('\', '/'))
if (-not $DestinationRoot) {
    $DestinationRoot = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($repoRoot), '.duet-worktrees', $repoName, $Task)
}
if ([System.IO.Path]::IsPathRooted($DestinationRoot)) {
    $destinationParent = [System.IO.Path]::GetFullPath($DestinationRoot)
} else {
    if ((Get-Location).Provider.Name -ne 'FileSystem') {
        throw 'A relative DestinationRoot requires the current PowerShell location to use the FileSystem provider.'
    }
    $destinationParent = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).ProviderPath $DestinationRoot))
}
$claudePath = Join-Path $destinationParent 'claude'
$codexPath = Join-Path $destinationParent 'codex'
$claudeBranch = "duet/claude/$Task"
$codexBranch = "duet/codex/$Task"

$trimCharacters = [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
$repoPrefix = $repoRoot.TrimEnd($trimCharacters) + [System.IO.Path]::DirectorySeparatorChar
if ($destinationParent.Equals($repoRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    $destinationParent.StartsWith($repoPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'DestinationRoot must be outside the repository so agent worktrees cannot appear as nested project content.'
}

foreach ($branch in @($claudeBranch, $codexBranch)) {
    $null = Invoke-Git -WorkingDirectory $repoRoot -Arguments @('check-ref-format', '--branch', $branch)
}

foreach ($target in @($claudePath, $codexPath)) {
    if ([System.IO.Directory]::Exists($target) -or [System.IO.File]::Exists($target)) {
        throw "Refusing to overwrite existing path: $target"
    }
}

foreach ($branch in @($claudeBranch, $codexBranch)) {
    & git -C $repoRoot show-ref --verify --quiet "refs/heads/$branch"
    if ($LASTEXITCODE -eq 0) {
        throw "Refusing to reuse existing branch: $branch"
    }
}

if (-not $PSCmdlet.ShouldProcess($repoRoot, "Create Claude and Codex worktrees at $destinationParent")) {
    return
}

$created = @()
try {
    $null = [System.IO.Directory]::CreateDirectory($destinationParent)

    $null = Invoke-Git -WorkingDirectory $repoRoot -Arguments @('worktree', 'add', '-b', $claudeBranch, $claudePath, $baseSha)
    $created += @{ Path = $claudePath; Branch = $claudeBranch }

    $null = Invoke-Git -WorkingDirectory $repoRoot -Arguments @('worktree', 'add', '-b', $codexBranch, $codexPath, $baseSha)
    $created += @{ Path = $codexPath; Branch = $codexBranch }

    $authorizeScript = Join-Path $PSScriptRoot 'authorize-claude-worktree.ps1'
    $authorization = & $authorizeScript `
        -Worktree $claudePath `
        -ClaudePaths $ClaudePaths `
        -AuthorizationHours $AuthorizationHours `
        -Confirm:$false
} catch {
    if ($created.Count -gt 0) {
        $recovery = Get-RecoveryInstructions -Root $repoRoot -Created $created
        throw "$($_.Exception.Message)$([Environment]::NewLine)$recovery$([Environment]::NewLine)Expected base commit: $baseSha"
    }
    throw
}

[pscustomobject]@{
    BaseCommit   = $baseSha
    ClaudeBranch = $claudeBranch
    ClaudePath   = [System.IO.Path]::GetFullPath($claudePath)
    CodexBranch  = $codexBranch
    CodexPath    = [System.IO.Path]::GetFullPath($codexPath)
    AllowedPaths = $authorization.AllowedPaths
    ExpiresAtUtc = $authorization.ExpiresAtUtc
    WriteMarker  = $authorization.Marker
}
