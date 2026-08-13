[CmdletBinding(PositionalBinding = $false)]
param(
    [Alias('Repository')]
    [string]$Workspace,

    [string[]]$AdditionalAllowedRoot = @(),

    [switch]$AllowAllRoots,

    [switch]$RestrictRoots,

    [switch]$EnableApps,

    [switch]$DisableApps,

    [switch]$DirectCodex,

    [ValidateRange(0, 1000)]
    [int]$AppsRetryLimit = 0,

    [ValidateRange(45, 600)]
    [int]$AppsAttemptTimeoutSeconds = 120,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CodexArguments = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($EnableApps -and $DisableApps) {
    throw 'EnableApps and DisableApps cannot be used together.'
}

if ($AllowAllRoots -and $RestrictRoots) {
    throw 'AllowAllRoots and RestrictRoots cannot be used together.'
}

# The middle directory name is exactly U+200E LEFT-TO-RIGHT MARK. Construct it
# from code points so copy/paste, fonts, and shell normalization cannot erase it.
$defaultWorkspace = [System.IO.Path]::GetFullPath(
    [System.IO.Path]::Combine($env:USERPROFILE, 'Desktop', [string][char]0x200E, 'Notes', 'AI')
)
if ([System.IO.File]::Exists($defaultWorkspace)) {
    throw "The default Claude workspace exists but is not a directory: $defaultWorkspace"
}
if (-not [System.IO.Directory]::Exists($defaultWorkspace)) {
    $null = [System.IO.Directory]::CreateDirectory($defaultWorkspace)
}

$codexBillingVariables = @('OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AZURE_OPENAI_API_KEY') |
    Where-Object { [Environment]::GetEnvironmentVariable($_) }
if ($codexBillingVariables) {
    throw "Subscription-only launch refused because Codex API-routing variables are present: $($codexBillingVariables -join ', '). Remove them from this PowerShell process before retrying."
}

function Find-WorkingCodex {
    $candidates = @()
    foreach ($command in (Get-Command codex -All -ErrorAction SilentlyContinue)) {
        if ($command.Source) { $candidates += $command.Source }
        elseif ($command.Path) { $candidates += $command.Path }
    }
    $candidates += @(
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\codex.exe'),
        (Join-Path $env:ProgramFiles 'WinGet\Links\codex.exe'),
        (Join-Path $env:APPDATA 'npm\codex.cmd')
    )

    foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        $previousPreference = $ErrorActionPreference
        $exitCode = -1
        try {
            $ErrorActionPreference = 'Continue'
            try {
                $null = & $candidate --version 2>&1
                $exitCode = $LASTEXITCODE
            } catch {
                # Packaged desktop aliases can exist but refuse child-process execution.
                $exitCode = -1
            }
        } finally {
            $ErrorActionPreference = $previousPreference
        }
        if ($exitCode -eq 0) { return [System.IO.Path]::GetFullPath($candidate) }
    }
    return $null
}

function Find-WorkingNode {
    $candidates = @()
    foreach ($command in (Get-Command node -All -ErrorAction SilentlyContinue)) {
        if ($command.Source) { $candidates += $command.Source }
        elseif ($command.Path) { $candidates += $command.Path }
    }
    $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe')

    foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
        if (-not [System.IO.File]::Exists($candidate)) { continue }
        $previousPreference = $ErrorActionPreference
        $exitCode = -1
        try {
            $ErrorActionPreference = 'Continue'
            try {
                $null = & $candidate --version 2>&1
                $exitCode = $LASTEXITCODE
            } catch {
                $exitCode = -1
            }
        } finally {
            $ErrorActionPreference = $previousPreference
        }
        if ($exitCode -eq 0) { return [System.IO.Path]::GetFullPath($candidate) }
    }
    return $null
}

if (-not $Workspace) { $Workspace = $defaultWorkspace }
$workspaceInput = [System.IO.Path]::GetFullPath($Workspace)
if (-not [System.IO.Directory]::Exists($workspaceInput)) {
    throw "Workspace is not an existing directory: $workspaceInput"
}
$previousPreference = $ErrorActionPreference
$gitExit = -1
$repoRootText = @()
try {
    $ErrorActionPreference = 'Continue'
    try {
        $repoRootText = & git -C $workspaceInput rev-parse --show-toplevel 2>&1
        $gitExit = $LASTEXITCODE
    } catch {
        $gitExit = -1
    }
} finally {
    $ErrorActionPreference = $previousPreference
}
if ($gitExit -eq 0) {
    $launchRoot = [System.IO.Path]::GetFullPath(($repoRootText -join [Environment]::NewLine).Trim())
    if (-not [System.IO.Directory]::Exists($launchRoot)) {
        throw "Git reported a repository root that is not an existing directory: $launchRoot"
    }
    $workspaceKind = 'Git repository'
} else {
    $launchRoot = $workspaceInput
    $workspaceKind = 'directory (non-Git is supported by the full Claude agent)'
}

$allowed = @($defaultWorkspace, $launchRoot)
foreach ($root in $AdditionalAllowedRoot) {
    $candidateRoot = [System.IO.Path]::GetFullPath($root)
    if (-not [System.IO.Directory]::Exists($candidateRoot)) {
        throw "AdditionalAllowedRoot is not an existing directory: $candidateRoot"
    }
    $allowed += $candidateRoot
}
$allowed = @($allowed | Select-Object -Unique)
$env:CLAUDE_PEER_ALLOWED_ROOTS = $allowed -join [System.IO.Path]::PathSeparator

# The persistent root policy lives in the operator's own AI workspace, not in the plugin cache, so
# it survives Codex restarts and plugin reinstalls and is re-read by the bridge on every call.
$rootPolicyPath = [System.IO.Path]::Combine($defaultWorkspace, 'claude-peer-config.json')

function Read-ClaudeRootPolicy {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not [System.IO.File]::Exists($Path)) { return $null }
    $text = [System.IO.File]::ReadAllText($Path)
    if (-not $text.Trim()) { return $null }
    try {
        return $text | ConvertFrom-Json
    } catch {
        throw "The Claude root policy file is not valid JSON: $Path"
    }
}

function Write-ClaudeRootPolicy {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][bool]$AllowAll
    )

    $existing = Read-ClaudeRootPolicy -Path $Path
    $document = [ordered]@{}
    if ($existing) {
        foreach ($property in $existing.PSObject.Properties) { $document[$property.Name] = $property.Value }
    }
    $document['allowAllRoots'] = $AllowAll
    if (-not $document.Contains('allowedRoots')) { $document['allowedRoots'] = @() }
    $json = $document | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

if ($AllowAllRoots) {
    Write-ClaudeRootPolicy -Path $rootPolicyPath -AllowAll $true
} elseif ($RestrictRoots) {
    Write-ClaudeRootPolicy -Path $rootPolicyPath -AllowAll $false
}

$rootPolicy = Read-ClaudeRootPolicy -Path $rootPolicyPath
$policyAllowsAllRoots = $false
if ($rootPolicy -and ($rootPolicy.PSObject.Properties.Name -contains 'allowAllRoots')) {
    $policyAllowsAllRoots = [bool]$rootPolicy.allowAllRoots
}

# Only the explicit switches pin the process-level override. Otherwise the file stays authoritative,
# so editing it takes effect for every bridge process started afterwards without another launch.
if ($AllowAllRoots) {
    $env:CLAUDE_PEER_ALLOW_ALL_ROOTS = '1'
} elseif ($RestrictRoots) {
    $env:CLAUDE_PEER_ALLOW_ALL_ROOTS = '0'
} elseif (Test-Path -LiteralPath 'Env:\CLAUDE_PEER_ALLOW_ALL_ROOTS') {
    Remove-Item -LiteralPath 'Env:\CLAUDE_PEER_ALLOW_ALL_ROOTS'
}

$codex = Find-WorkingCodex
if (-not $codex) {
    throw 'A working standalone Codex CLI was not found. Run setup.ps1 -InstallCLIs, then open a new PowerShell window.'
}

$previousPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    $codexLogin = & $codex login status 2>&1
    $loginExit = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousPreference
}
$safeLoginStatus = (($codexLogin -join ' ') -replace '[\w.+-]+@[\w.-]+', '[redacted-email]')
if ($loginExit -ne 0 -or $safeLoginStatus -notmatch 'ChatGPT') {
    throw 'Subscription-only launch refused because the standalone Codex CLI did not report a saved ChatGPT login. Run `codex login` and choose ChatGPT authentication.'
}

Write-Host "Starting Codex in $workspaceKind`: $launchRoot"
Write-Host "Default AI workspace (contains U+200E): $defaultWorkspace"
Write-Host "Persistent Claude root policy file: $rootPolicyPath"
if ($policyAllowsAllRoots) {
    Write-Host 'Claude workspace-root restriction: OFF (allowAllRoots = true). Claude accepts any existing directory as cwd.'
    Write-Host 'Still enforced: Claude Max OAuth only, billing-variable refusal, sensitive-path denials, worktree write authorization, secret redaction.'
} else {
    Write-Host 'Claude workspace-root restriction: ON. Claude agent workspace roots:'
    $allowed | ForEach-Object { Write-Host "  $_" }
    Write-Host 'The additional process allowlist exists only in this launcher process and its children.'
    Write-Host 'Run this launcher once with -AllowAllRoots to remove the root restriction permanently.'
}

$informationalOnly = $CodexArguments.Count -eq 1 -and $CodexArguments[0] -in @('--version', '-V', '--help', '-h')
if ($informationalOnly) {
    & $codex @CodexArguments
    exit $LASTEXITCODE
}

if ($DisableApps) {
    Write-Host 'Hosted Codex connector Apps are explicitly disabled for this session.'
    & $codex -C $launchRoot --disable apps @CodexArguments
    exit $LASTEXITCODE
}

if ($DirectCodex) {
    Write-Host 'Starting direct Codex with hosted Apps enabled; the resilient readiness supervisor is bypassed.'
    & $codex -C $launchRoot --enable apps @CodexArguments
    exit $LASTEXITCODE
}

$node = Find-WorkingNode
if (-not $node) {
    throw 'A working Node.js runtime was not found. Run setup.ps1 -InstallCLIs, then open a new PowerShell window.'
}
$appsSupervisor = [System.IO.Path]::Combine($PSScriptRoot, 'start-codex-with-apps.mjs')
if (-not [System.IO.File]::Exists($appsSupervisor)) {
    throw "The hosted Apps readiness supervisor is missing: $appsSupervisor"
}

if ($EnableApps) {
    Write-Host 'EnableApps is retained for compatibility; hosted Apps are now enabled and verified by default.'
}
Write-Host 'Hosted Codex connector Apps remain enabled.'
Write-Host 'The launcher will wait for the real terminal thread to report both codex_apps and Claude Peer ready, then attach to that same live thread.'
if ($AppsRetryLimit -eq 0) {
    Write-Host 'Apps readiness retries are unlimited; press Ctrl+C to cancel while waiting.'
} else {
    Write-Host "Apps readiness retry limit: $AppsRetryLimit"
}

$supervisorArguments = @(
    $appsSupervisor,
    '--codex', $codex,
    '--cwd', $launchRoot,
    '--retry-limit', [string]$AppsRetryLimit,
    '--attempt-timeout-seconds', [string]$AppsAttemptTimeoutSeconds
)
$supervisorArguments += '--'
$supervisorArguments += $CodexArguments
& $node @supervisorArguments
exit $LASTEXITCODE
