# Remove the policy entries written by install.ps1.
# Right-click -> "Run with PowerShell"

param(
    [string]$ExtensionId = '__EXT_ID__'
)

$ErrorActionPreference = 'Stop'

$keys = @(
    'HKCU:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist',
    'HKCU:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist'
)

$removed = 0
foreach ($key in $keys) {
    if (-not (Test-Path $key)) { continue }
    $props = (Get-Item -Path $key).Property
    foreach ($name in $props) {
        $value = (Get-ItemProperty -Path $key -Name $name).$name
        if ($value -like "$ExtensionId*") {
            Remove-ItemProperty -Path $key -Name $name -Force
            Write-Host ("[ok]   removed from {0}" -f $key) -ForegroundColor Green
            $removed++
        }
    }
    # Drop the key itself when nothing else is forced for that browser
    if (-not (Get-Item -Path $key).Property) {
        Remove-Item -Path $key -Force
    }
}

Write-Host ''
if ($removed -eq 0) {
    Write-Host 'No matching policy entry found.'
}
else {
    Write-Host 'Done. Restart the browser; the extension is removed automatically.'
}
Write-Host ''
Read-Host 'Press Enter to close'
