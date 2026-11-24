param(
    [string]$Pattern = 'SH-01',
    [switch]$UpdatePassword
)
$ErrorActionPreference = 'Stop'
$store = 'nha6ki-qa-lab.myshopify.com'
$settings = Join-Path $env:LOCALAPPDATA 'web-regression-shopify-secrets'
$file = Join-Path $settings "$store.xml"
if ($UpdatePassword -or -not (Test-Path -LiteralPath $file)) {
    $secret = Read-Host "Storefront password for $store" -AsSecureString
    if ($secret.Length -eq 0) { throw 'The password is empty.' }
    New-Item -ItemType Directory -Path $settings -Force | Out-Null
    $secret | Export-Clixml -LiteralPath $file
}
$secret = Import-Clixml -LiteralPath $file
$oldStore = $env:SHOPIFY_QA_STORE
$oldVideo = $env:SHOPIFY_QA_VIDEO
$oldCache = $env:PLAYWRIGHT_BROWSERS_PATH
$oldPassword = $env:SHOPIFY_STOREFRONT_PASSWORD
Push-Location (Join-Path $PSScriptRoot '..\..')
try {
    $env:SHOPIFY_QA_STORE = $store
    $env:SHOPIFY_QA_VIDEO = '1'
    $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $env:LOCALAPPDATA 'web-regression-shopify-recorders'
    $env:SHOPIFY_STOREFRONT_PASSWORD = ([System.Net.NetworkCredential]::new('', $secret)).Password
    node.exe .\node_modules\playwright\cli.js test -c external/shopify/playwright.config.ts --grep $Pattern
    $result = $LASTEXITCODE
} finally {
    $env:SHOPIFY_STOREFRONT_PASSWORD = $oldPassword
    $env:SHOPIFY_QA_STORE = $oldStore
    $env:SHOPIFY_QA_VIDEO = $oldVideo
    $env:PLAYWRIGHT_BROWSERS_PATH = $oldCache
    Pop-Location
}
exit $result
