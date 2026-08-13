[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$InstallCLIs,
    [switch]$LoginClaude,
    [switch]$InstallCodexPlugin,
    [switch]$InstallClaudePlugin
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$BundleRoot = $PSScriptRoot
$WingetLinks = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'
$MachineWingetLinks = Join-Path $env:ProgramFiles 'WinGet\Links'
$ClaudeNativeBin = Join-Path $env:USERPROFILE '.local\bin'
$NpmUserBin = Join-Path $env:APPDATA 'npm'
$DefaultClaudeWorkspace = [System.IO.Path]::GetFullPath(
    [System.IO.Path]::Combine($env:USERPROFILE, 'Desktop', [string][char]0x200E, 'Notes', 'AI')
)
$env:PATH = (@($WingetLinks, $MachineWingetLinks, $ClaudeNativeBin, $NpmUserBin, $env:PATH) -join [System.IO.Path]::PathSeparator)

function Invoke-NativeCapture {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @()
    )

    # Windows PowerShell 5.1 turns redirected native stderr into error records.
    # Temporarily continue so callers can classify the real process exit code.
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & $FilePath @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } catch {
        return [pscustomobject]@{
            ExitCode = -1
            Output   = $_.Exception.Message
        }
    } finally {
        $ErrorActionPreference = $previousPreference
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        Output   = ($output -join [Environment]::NewLine)
    }
}

function Invoke-NativePassthrough {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @()
    )

    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $FilePath @Arguments | Out-Host
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    return [int]$exitCode
}

function Find-WorkingBinary {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string[]]$CommonPaths,
        [switch]$RequireNativeExecutable
    )

    $candidates = @()
    $commands = Get-Command $Name -All -ErrorAction SilentlyContinue
    foreach ($command in $commands) {
        if ($command.Source) { $candidates += $command.Source }
        elseif ($command.Path) { $candidates += $command.Path }
    }
    $candidates += $CommonPaths

    foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        if ($RequireNativeExecutable -and [System.IO.Path]::GetExtension($candidate) -ne '.exe') { continue }
        $probe = Invoke-NativeCapture -FilePath $candidate -Arguments @('--version')
        if ($probe.ExitCode -eq 0) { return (Resolve-Path -LiteralPath $candidate).Path }
    }
    return $null
}

function Get-ClaudeBinary {
    $binary = Find-WorkingBinary -Name 'claude' -RequireNativeExecutable -CommonPaths @(
        (Join-Path $ClaudeNativeBin 'claude.exe'),
        (Join-Path $WingetLinks 'claude.exe'),
        (Join-Path $MachineWingetLinks 'claude.exe')
    )
    if (-not $binary) { return $null }
    $help = Invoke-NativeCapture -FilePath $binary -Arguments @('--help')
    # Anthropic documents --max-turns, but the current native CLI omits it from --help.
    foreach ($requiredFlag in @('--safe-mode', '--setting-sources', '--permission-mode', '--tools', '--allowedTools', '--disallowedTools', '--model', '--effort', '--fallback-model')) {
        if ($help.ExitCode -ne 0 -or -not $help.Output.Contains($requiredFlag)) { return $null }
    }
    return $binary
}

function Get-CodexBinary {
    return Find-WorkingBinary -Name 'codex' -CommonPaths @(
        (Join-Path $WingetLinks 'codex.exe'),
        (Join-Path $NpmUserBin 'codex.cmd')
    )
}

function Get-NodeBinary {
    return Find-WorkingBinary -Name 'node' -CommonPaths @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe')
    )
}

function Get-CompatibleNodeBinary {
    $binary = Get-NodeBinary
    if (-not $binary) { return $null }
    $version = Invoke-NativeCapture -FilePath $binary -Arguments @('--version')
    $match = [regex]::Match($version.Output, '^v(?<major>\d+)\.')
    if ($version.ExitCode -ne 0 -or -not $match.Success) { return $null }
    if ([int]$match.Groups['major'].Value -lt 18) { return $null }
    return $binary
}

function Ensure-WinGetPackage {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)][string]$PackageId,
        [Parameter(Mandatory = $true)][scriptblock]$ResolveBinary
    )

    $working = & $ResolveBinary
    if ($working) {
        Write-Host "$PackageId already has a working CLI at $working; leaving it unchanged."
        return
    }

    $listed = Invoke-NativeCapture -FilePath 'winget' -Arguments @(
        'list', '--id', $PackageId, '--exact', '--source', 'winget',
        '--accept-source-agreements', '--disable-interactivity'
    )
    if ($listed.ExitCode -eq 0) {
        throw "$PackageId is registered as installed, but its CLI is not callable. Open a new terminal or run ``winget upgrade --id $PackageId --exact --source winget`` before retrying."
    }

    if ($PSCmdlet.ShouldProcess($PackageId, 'Install user-scoped package from the WinGet community source')) {
        $exitCode = Invoke-NativePassthrough -FilePath 'winget' -Arguments @(
            'install', '--id', $PackageId, '--exact', '--source', 'winget', '--scope', 'user',
            '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'
        )
        if ($exitCode -ne 0) { throw "$PackageId installation failed with exit code $exitCode." }

        $working = & $ResolveBinary
        if (-not $working) {
            throw "$PackageId installed, but its CLI is not callable in this process. Start a new PowerShell window and rerun the doctor."
        }
    }
}

function Get-NormalizedExistingPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $withoutDevicePrefix = $Path -replace '^\\\\\?\\', ''
    $trimCharacters = [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    return (Resolve-Path -LiteralPath $withoutDevicePrefix).Path.TrimEnd($trimCharacters)
}

function Get-CodexMarketplace {
    param(
        [Parameter(Mandatory = $true)][string]$CodexBinary,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $result = Invoke-NativeCapture -FilePath $CodexBinary -Arguments @('plugin', 'marketplace', 'list', '--json')
    if ($result.ExitCode -ne 0) {
        throw "Could not inspect Codex marketplaces: $($result.Output)"
    }
    try {
        $data = $result.Output | ConvertFrom-Json
    } catch {
        throw 'Codex marketplace listing was not valid JSON.'
    }
    return @($data.marketplaces | Where-Object { $_.name -eq $Name }) | Select-Object -First 1
}

function Get-CodexInstalledPlugin {
    param(
        [Parameter(Mandatory = $true)][string]$CodexBinary,
        [Parameter(Mandatory = $true)][string]$PluginId
    )

    $result = Invoke-NativeCapture -FilePath $CodexBinary -Arguments @('plugin', 'list', '--json')
    if ($result.ExitCode -ne 0) {
        throw "Could not inspect installed Codex plugins: $($result.Output)"
    }
    try {
        $data = $result.Output | ConvertFrom-Json
    } catch {
        throw 'Codex plugin listing was not valid JSON.'
    }
    return @($data.installed | Where-Object { $_.pluginId -eq $PluginId }) | Select-Object -First 1
}

function Get-ClaudeMarketplaces {
    param([Parameter(Mandatory = $true)][string]$ClaudeBinary)

    $result = Invoke-NativeCapture -FilePath $ClaudeBinary -Arguments @('plugin', 'marketplace', 'list', '--json')
    if ($result.ExitCode -ne 0) { throw "Could not inspect Claude Code marketplaces: $($result.Output)" }
    try { return @($result.Output | ConvertFrom-Json) }
    catch { throw 'Claude Code marketplace listing was not valid JSON.' }
}

function Get-ClaudeInstalledPlugins {
    param([Parameter(Mandatory = $true)][string]$ClaudeBinary)

    $result = Invoke-NativeCapture -FilePath $ClaudeBinary -Arguments @('plugin', 'list', '--json')
    if ($result.ExitCode -ne 0) { throw "Could not inspect installed Claude Code plugins: $($result.Output)" }
    try { return @($result.Output | ConvertFrom-Json) }
    catch { throw 'Claude Code plugin listing was not valid JSON.' }
}

function Get-RawSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        try {
            return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '')
        } finally {
            $stream.Dispose()
        }
    } finally {
        $algorithm.Dispose()
    }
}

function Test-PluginCacheMatches {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$CacheRoot
    )

    if (-not [System.IO.Directory]::Exists($SourceRoot) -or -not [System.IO.Directory]::Exists($CacheRoot)) {
        return $false
    }
    $sourceFiles = @([System.IO.Directory]::EnumerateFiles($SourceRoot, '*', [System.IO.SearchOption]::AllDirectories))
    $cacheFiles = @([System.IO.Directory]::EnumerateFiles($CacheRoot, '*', [System.IO.SearchOption]::AllDirectories))
    $sourceRelative = @($sourceFiles | ForEach-Object { $_.Substring($SourceRoot.Length + 1) })
    $cacheRelative = @($cacheFiles | ForEach-Object { $_.Substring($CacheRoot.Length + 1) })
    if ($sourceRelative.Count -ne $cacheRelative.Count) { return $false }
    foreach ($relativePath in $sourceRelative) {
        if ($relativePath -notin $cacheRelative) { return $false }
        $sourcePath = [System.IO.Path]::Combine($SourceRoot, $relativePath)
        $cachePath = [System.IO.Path]::Combine($CacheRoot, $relativePath)
        if ((Get-RawSha256 -Path $sourcePath) -ne (Get-RawSha256 -Path $cachePath)) { return $false }
    }
    return $true
}

if ($InstallCLIs) {
    $installationFailures = @()
    foreach ($package in @(
        @{ Id = 'Anthropic.ClaudeCode'; Resolver = { Get-ClaudeBinary } },
        @{ Id = 'OpenAI.Codex'; Resolver = { Get-CodexBinary } }
    )) {
        try {
            Ensure-WinGetPackage -PackageId $package.Id -ResolveBinary $package.Resolver
        } catch {
            $installationFailures += "$($package.Id): $($_.Exception.Message)"
            Write-Warning $installationFailures[-1]
        }
    }
    if ($installationFailures.Count -gt 0) {
        throw "One or more CLI installations need attention:`n$($installationFailures -join [Environment]::NewLine)"
    }
}

$claude = Get-ClaudeBinary
$codex = Get-CodexBinary

if ($LoginClaude) {
    if (-not $claude) { throw 'Claude Code is not installed or not callable.' }
    if ($PSCmdlet.ShouldProcess('Claude Max account', 'Open interactive Claude Code login')) {
        $exitCode = Invoke-NativePassthrough -FilePath $claude -Arguments @('auth', 'login')
        if ($exitCode -ne 0) { throw 'Claude login did not complete successfully.' }
    }
}

if ($InstallCodexPlugin) {
    if (-not $codex) { throw 'A standalone Codex CLI is not installed or callable.' }
    if (-not (Get-CompatibleNodeBinary)) { throw 'Node.js 18 or newer is required to run the claude-peer MCP server.' }
    if ([System.IO.File]::Exists($DefaultClaudeWorkspace)) {
        throw "The default Claude workspace exists but is not a directory: $DefaultClaudeWorkspace"
    }
    if (-not [System.IO.Directory]::Exists($DefaultClaudeWorkspace) -and $PSCmdlet.ShouldProcess($DefaultClaudeWorkspace, 'Create the default full-agent AI workspace (the parent path contains U+200E)')) {
        $null = [System.IO.Directory]::CreateDirectory($DefaultClaudeWorkspace)
    }

    $marketplaceName = 'codex-claude-duo-local'
    $canonicalBundle = Get-NormalizedExistingPath -Path $BundleRoot
    $registration = Get-CodexMarketplace -CodexBinary $codex -Name $marketplaceName
    if ($registration) {
        $registeredRoot = Get-NormalizedExistingPath -Path $registration.root
        if (-not $registeredRoot.Equals($canonicalBundle, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Marketplace $marketplaceName already points to '$registeredRoot', not this reviewed bundle '$canonicalBundle'. It was left unchanged."
        }
        Write-Host "Confirmed marketplace $marketplaceName at $canonicalBundle."
    } elseif ($PSCmdlet.ShouldProcess($canonicalBundle, "Register local Codex marketplace $marketplaceName")) {
        $added = Invoke-NativeCapture -FilePath $codex -Arguments @('plugin', 'marketplace', 'add', $canonicalBundle, '--json')
        if ($added.ExitCode -ne 0) { throw "Marketplace registration failed: $($added.Output)" }

        $registration = Get-CodexMarketplace -CodexBinary $codex -Name $marketplaceName
        if (-not $registration) { throw 'Marketplace registration reported success but could not be verified.' }
        $registeredRoot = Get-NormalizedExistingPath -Path $registration.root
        if (-not $registeredRoot.Equals($canonicalBundle, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Marketplace registration resolved to '$registeredRoot', not '$canonicalBundle'. Plugin installation was stopped."
        }
    }

    if ($PSCmdlet.ShouldProcess('claude-peer@codex-claude-duo-local', 'Install local Codex plugin')) {
        $pluginId = 'claude-peer@codex-claude-duo-local'
        $pluginSource = [System.IO.Path]::Combine($BundleRoot, 'plugins', 'claude-peer')
        $pluginManifestPath = [System.IO.Path]::Combine($pluginSource, '.codex-plugin', 'plugin.json')
        try {
            $expectedVersion = (Get-Content -Raw -LiteralPath $pluginManifestPath | ConvertFrom-Json).version
        } catch {
            throw "Could not read the claude-peer plugin version from '$pluginManifestPath'."
        }
        $installed = Invoke-NativeCapture -FilePath $codex -Arguments @(
            'plugin', 'add', $pluginId, '--json'
        )
        $selectedPlugin = Get-CodexInstalledPlugin -CodexBinary $codex -PluginId $pluginId
        $cacheRoot = [System.IO.Path]::Combine(
            $env:USERPROFILE, '.codex', 'plugins', 'cache', $marketplaceName, 'claude-peer', $expectedVersion
        )
        $postconditionVerified = $selectedPlugin -and $selectedPlugin.installed -and $selectedPlugin.enabled -and
            $selectedPlugin.version -eq $expectedVersion -and
            (Test-PluginCacheMatches -SourceRoot $pluginSource -CacheRoot $cacheRoot)
        if (-not $postconditionVerified) {
            throw "claude-peer plugin installation did not reach a verified final state: $($installed.Output)"
        }
        if ($installed.ExitCode -ne 0) {
            Write-Warning "Codex reported a cache-backup error after activating the new plugin, but the selected version and every cached file were independently verified. Continuing with $expectedVersion."
        } else {
            Write-Host "Installed and verified claude-peer $expectedVersion."
        }
    }
}

if ($InstallClaudePlugin) {
    if (-not $claude) { throw 'Claude Code is not installed or not callable.' }
    if (-not $codex) { throw 'A standalone Codex CLI is required by the reciprocal Claude Code plugin.' }
    if (-not (Get-CompatibleNodeBinary)) { throw 'Node.js 18 or newer is required to run the reciprocal Codex MCP bridge.' }

    $marketplaceName = 'codex-claude-duo'
    $pluginId = "codex-peer@$marketplaceName"
    $canonicalBundle = Get-NormalizedExistingPath -Path $BundleRoot
    $marketplaces = Get-ClaudeMarketplaces -ClaudeBinary $claude
    $registration = @($marketplaces | Where-Object { $_.name -eq $marketplaceName }) | Select-Object -First 1
    if ($registration) {
        if ($registration.source -ne 'directory' -or -not $registration.path) {
            throw "Claude Code marketplace $marketplaceName is already registered from a non-local source; it was left unchanged."
        }
        $registeredRoot = Get-NormalizedExistingPath -Path $registration.path
        if (-not $registeredRoot.Equals($canonicalBundle, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Claude Code marketplace $marketplaceName points to '$registeredRoot', not this reviewed bundle '$canonicalBundle'. It was left unchanged."
        }
        Write-Host "Confirmed Claude Code marketplace $marketplaceName at $canonicalBundle."
    } elseif ($PSCmdlet.ShouldProcess($canonicalBundle, "Register user-scoped Claude Code marketplace $marketplaceName")) {
        $added = Invoke-NativeCapture -FilePath $claude -Arguments @('plugin', 'marketplace', 'add', '--scope', 'user', $canonicalBundle)
        if ($added.ExitCode -ne 0) { throw "Claude Code marketplace registration failed: $($added.Output)" }
    }

    $installedPlugins = Get-ClaudeInstalledPlugins -ClaudeBinary $claude
    $installedPeer = @($installedPlugins | Where-Object { $_.id -eq $pluginId -and $_.scope -eq 'user' }) | Select-Object -First 1
    if ($installedPeer) {
        if ($PSCmdlet.ShouldProcess($pluginId, 'Refresh user-scoped Claude Code plugin from the reviewed local marketplace')) {
            $updated = Invoke-NativeCapture -FilePath $claude -Arguments @('plugin', 'update', '--scope', 'user', $pluginId)
            if ($updated.ExitCode -ne 0) { throw "Claude Code plugin update failed: $($updated.Output)" }
        }
    } elseif ($PSCmdlet.ShouldProcess($pluginId, 'Install user-scoped Claude Code plugin')) {
        $installed = Invoke-NativeCapture -FilePath $claude -Arguments @('plugin', 'install', '--scope', 'user', $pluginId)
        if ($installed.ExitCode -ne 0) { throw "Claude Code plugin installation failed: $($installed.Output)" }
    }

    $selected = @(Get-ClaudeInstalledPlugins -ClaudeBinary $claude | Where-Object {
        $_.id -eq $pluginId -and $_.scope -eq 'user' -and $_.enabled
    }) | Select-Object -First 1
    if (-not $selected) { throw 'Claude Code reported installation success, but the reciprocal codex-peer plugin is not enabled at user scope.' }
    Write-Host "Installed and verified Claude Code plugin $($selected.id) $($selected.version)."
}

$billingVariables = @(
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'AWS_ACCESS_KEY_ID',
    'AWS_PROFILE',
    'AWS_BEARER_TOKEN_BEDROCK',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'AZURE_CLIENT_ID',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'AZURE_OPENAI_API_KEY'
) | Where-Object { [Environment]::GetEnvironmentVariable($_) }

$claudeAuth = 'not installed'
if ($claude) {
    try {
        $result = Invoke-NativeCapture -FilePath $claude -Arguments @('auth', 'status', '--json')
        $status = $result.Output | ConvertFrom-Json
        $claudeAuth = if ($status.loggedIn) { "logged in via $($status.authMethod)" } else { 'login required' }
    } catch {
        $claudeAuth = 'status unavailable'
    }
}

$codexAuth = 'not installed'
if ($codex) {
    try {
        $result = Invoke-NativeCapture -FilePath $codex -Arguments @('login', 'status')
        $codexAuth = (($result.Output -replace '[\w.+-]+@[\w.-]+', '[redacted-email]') -replace '\s+', ' ').Trim()
    } catch {
        $codexAuth = 'status unavailable'
    }
}

$node = Get-CompatibleNodeBinary

[pscustomobject]@{
    ClaudeCLI                = if ($claude) { $claude } else { 'NOT FOUND' }
    ClaudeAuthentication     = $claudeAuth
    CodexCLI                 = if ($codex) { $codex } else { 'NOT FOUND' }
    CodexAuthentication      = $codexAuth
    NodeJS                   = if ($node) { $node } else { 'NOT FOUND' }
    BillingOverrideVariables = if ($billingVariables) { $billingVariables -join ', ' } else { 'none detected' }
    Bundle                   = $BundleRoot
    DefaultClaudeWorkspace   = $DefaultClaudeWorkspace
    DefaultWorkspaceExists   = [System.IO.Directory]::Exists($DefaultClaudeWorkspace)
    ClaudeCodexPeer          = if ($InstallClaudePlugin) { 'installed and enabled at user scope' } else { 'not changed' }
} | Format-List

if ($InstallCodexPlugin) {
    Write-Host 'Start a new Codex task after installation so the plugin tools and skill are loaded.'
}
if ($InstallClaudePlugin) {
    Write-Host 'Start a new Claude Code window after installation so the reciprocal Codex tools and skill are loaded.'
}
