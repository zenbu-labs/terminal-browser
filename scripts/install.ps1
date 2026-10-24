param(
  [Parameter(Mandatory = $true)][string]$Zip,
  [string]$Manifest,
  [switch]$NoPath
)
$ErrorActionPreference = 'Stop'

# The Windows counterpart of install.sh: installs a release zip built by release-windows.mjs.
$Zip = (Resolve-Path $Zip).Path
if (-not $Manifest) {
  $Manifest = Join-Path (Split-Path $Zip) 'manifest-win32-x64.json'
}
if (Test-Path $Manifest) {
  $expected = (Get-Content $Manifest -Raw | ConvertFrom-Json).sha256
  $actual = (Get-FileHash $Zip -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected) { throw "the zip does not match its manifest (expected $expected, got $actual)" }
  "zip conferido contra o manifesto: sha256 $actual"
} else {
  "aviso: sem manifesto ao lado do zip; instalando sem conferir o sha256"
}

$home_ = Join-Path $env:LOCALAPPDATA 'terminal-browser'
$app = Join-Path $home_ 'app'
$staging = Join-Path $home_ 'app.new'
$bin = Join-Path $app 'bin'

# Files of a running browser are locked on Windows, so the old install's processes stop first.
$running = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($app + '\', [StringComparison]::OrdinalIgnoreCase) })
foreach ($process in $running) {
  "encerrando $($process.Name) ($($process.ProcessId)) da instalacao anterior"
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}

Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $staging | Out-Null
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
& $tar -xf $Zip -C $staging
if ($LASTEXITCODE -ne 0) { throw "could not extract $Zip" }
$unpacked = Join-Path $staging 'terminal-browser'
if (-not (Test-Path (Join-Path $unpacked 'bin\terminal-browser.exe'))) { throw "$Zip is not a terminal-browser release" }

Remove-Item $app -Recurse -Force -ErrorAction SilentlyContinue
Move-Item $unpacked $app
Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
"instalado em $app (versao $((Get-Content (Join-Path $app 'VERSION')).Trim()))"

if (-not $NoPath) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @($userPath -split ';' | Where-Object { $_ })
  if ($entries -notcontains $bin) {
    [Environment]::SetEnvironmentVariable('Path', (($entries + $bin) -join ';'), 'User')
    "adicionado ao PATH do usuario: $bin (abra um terminal novo para valer)"
  } else {
    "o PATH do usuario ja tem $bin"
  }
}

$capabilities = & (Join-Path $bin 'terminal-browser.exe') capabilities
"terminal-browser responde: $capabilities"
""
"Para o /browser do Claude Code usar esta instalacao, aponte CLAUDE_CODE_PLUGIN_DIRS para:"
"  $(Join-Path $app 'plugins\claude-code')"
