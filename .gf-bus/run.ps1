# Lanceur gf-bus pour PowerShell — voir USAGE.md
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Output "gf-bus : Node.js >= 22 introuvable, bus des agents désactivé."; exit 0 }
& $node.Source (Join-Path $PSScriptRoot 'gf-bus.mjs') @args
exit $LASTEXITCODE
