# Install the "Asset Ledger Quick Capture" extension through browser policy.
# Writes to HKCU only, so no administrator rights are required.
# Usage: right-click this file -> "Run with PowerShell"

param(
    [string]$ExtensionId = '__EXT_ID__',
    [string]$UpdateUrl   = 'https://github.com/FUJIWARESHINE/asset-ledger/releases/latest/download/update.xml'
)

$ErrorActionPreference = 'Stop'

$targets = @(
    @{ Name = 'Microsoft Edge'; Key = 'HKCU:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist' },
    @{ Name = 'Google Chrome';  Key = 'HKCU:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist' }
)

Write-Host ''
Write-Host "Extension ID : $ExtensionId"
Write-Host "Update URL   : $UpdateUrl"
Write-Host ''

$failed = 0
foreach ($t in $targets) {
    try {
        New-Item -Path $t.Key -Force | Out-Null
        # Use the next free value name so users with other forced extensions keep theirs
        $existing = (Get-Item -Path $t.Key).Property
        $name = '1'
        if ($existing) {
            $index = 1
            while ($existing -contains "$index") { $index++ }
            $name = "$index"
        }
        Set-ItemProperty -Path $t.Key -Name $name -Value "$ExtensionId;$UpdateUrl"
        Write-Host ("[ok]   {0}" -f $t.Name) -ForegroundColor Green
    }
    catch {
        $failed++
        Write-Host ("[fail] {0}: {1}" -f $t.Name, $_.Exception.Message) -ForegroundColor Yellow
    }
}

Write-Host ''
if ($failed -gt 0) {
    Write-Host 'Some browsers could not be configured. If access was denied, your machine'
    Write-Host 'may be locking the Policies registry key. Use the zip (Load unpacked) instead.'
    Write-Host 'See INSTALL.md, method A.'
}
else {
    Write-Host 'Done. Now FULLY quit the browser (tray icon -> Exit), then start it again.'
    Write-Host 'The extension installs itself on next launch and keeps updating from the URL above.'
}
Write-Host ''
Write-Host 'To remove it later, run uninstall.ps1.'
Read-Host 'Press Enter to close'
