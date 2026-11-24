$ErrorActionPreference = 'Stop'
$store = 'nha6ki-qa-lab.myshopify.com'
$oldToken = $env:SHOPIFY_ADMIN_READ_TOKEN
$oldFlag = $env:SHOPIFY_TEST_ORDER
try {
    if (-not $oldToken) {
        $folder = Join-Path $env:LOCALAPPDATA 'web-regression-shopify-secrets'
        $file = Join-Path $folder "$store-orders-app.xml"
        $new = -not (Test-Path -LiteralPath $file)
        if ($new) {
            $id = (Read-Host 'Shopify app Client ID').Trim()
            $secret = Read-Host 'Shopify app Client Secret' -AsSecureString
            $credential = [pscredential]::new($id, $secret)
        } else {
            $credential = Import-Clixml -LiteralPath $file
        }
        $body = @{grant_type='client_credentials'; client_id=$credential.UserName;
            client_secret=$credential.GetNetworkCredential().Password}
        $auth = Invoke-RestMethod -Uri "https://$store/admin/oauth/access_token" -Method Post -Body $body -MaximumRedirection 0
        if (-not $auth.access_token) { throw 'Shopify did not return an Admin API access token.' }
        if ($new) {
            New-Item -ItemType Directory -Force -Path $folder | Out-Null
            $credential | Export-Clixml -LiteralPath $file
        }
        $env:SHOPIFY_ADMIN_READ_TOKEN = $auth.access_token
    }
    $env:SHOPIFY_TEST_ORDER = '1'
    & (Join-Path $PSScriptRoot 'run-storefront.ps1') -Pattern 'SH-07'
    $result = $LASTEXITCODE
} finally {
    $env:SHOPIFY_ADMIN_READ_TOKEN = $oldToken
    $env:SHOPIFY_TEST_ORDER = $oldFlag
}
exit $result
