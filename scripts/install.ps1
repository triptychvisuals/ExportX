<#
Install ExportX into DaVinci Resolve's Workflow Integration Plugins folder (Windows).

  powershell -ExecutionPolicy Bypass -File scripts\install.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Link       # junction to the repo for development
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Uninstall

Run from an elevated (Administrator) PowerShell; the target folder lives under ProgramData.
#>
param(
  [switch]$Link,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Support = Join-Path $env:ProgramData 'Blackmagic Design\DaVinci Resolve\Support'
$PluginRoot = Join-Path $Support 'Workflow Integration Plugins'
$DevRoot = Join-Path $Support 'Developer'
$Target = Join-Path $PluginRoot 'ExportX'
$NodeModule = Join-Path $DevRoot 'Workflow Integrations\Examples\SamplePlugin\WorkflowIntegration.node'

if ($Uninstall) {
  if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
  Write-Host "Removed $Target. Restart Resolve."
  exit 0
}

if (-not (Test-Path $DevRoot)) {
  Write-Error "Resolve's Developer folder was not found at $DevRoot. Is DaVinci Resolve Studio 18+ installed?"
}

$LocalNode = Join-Path $Here 'WorkflowIntegration.node'
if (-not (Test-Path $LocalNode)) {
  if (Test-Path $NodeModule) {
    Write-Host "Copying WorkflowIntegration.node from Resolve's sample plugin"
    Copy-Item $NodeModule $LocalNode
  } else {
    Write-Error "WorkflowIntegration.node not found at $NodeModule. Copy it into $Here and run again."
  }
}

New-Item -ItemType Directory -Force -Path $PluginRoot | Out-Null
if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }

if ($Link) {
  Write-Host "Linking $Target -> $Here"
  New-Item -ItemType Junction -Path $Target -Target $Here | Out-Null
} else {
  Write-Host "Installing to $Target"
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  foreach ($item in @('manifest.xml','package.json','main.js','preload.js','WorkflowIntegration.node','src','ui','profiles','LICENSE')) {
    Copy-Item -Recurse -Force (Join-Path $Here $item) $Target
  }
}

Write-Host ""
Write-Host "Installed. Restart DaVinci Resolve Studio, then open Workspace > Workflow Integrations > ExportX."
