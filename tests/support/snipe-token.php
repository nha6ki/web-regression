<?php
// The runner reserves fd 3 for the credential and stderr for safe diagnostics.
$stage = 'bootstrap';
try {
    require 'vendor/autoload.php';
    $app = require 'bootstrap/app.php';
    $app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

    $stage = 'installation settings';
    $settings = App\Models\Setting::first() ?? new App\Models\Setting();
    $settings->site_name = 'QA Asset Inventory';
    $settings->brand = 1;
    $settings->default_currency = 'USD';
    if (!$settings->save()) {
        throw new RuntimeException('Settings validation failed');
    }

    $stage = 'find QA operator';
    $user = App\Models\User::where('username', 'qaoperator')->firstOrFail();
    $stage = 'issue personal access token';
    $token = $user->createToken('Regression tests')->accessToken;
    if (!is_string($token) || $token === '' || preg_match('/\s/', $token)) {
        throw new UnexpectedValueException('No bearer token returned');
    }

    $stage = 'validate token with Snipe-IT';
    $response = Illuminate\Support\Facades\Http::acceptJson()
        ->withToken($token)->timeout(10)->get('http://snipe/api/v1/users/me');
    if (!$response->successful() || (int) $response->json('id') !== (int) $user->id) {
        file_put_contents('php://stderr', 'Snipe-IT identity check: HTTP ' . $response->status() . PHP_EOL);
        // Report only exception types and source locations, never full log lines.
        $logs = glob(storage_path('logs/*.log')) ?: [];
        usort($logs, fn ($a, $b) => filemtime($b) <=> filemtime($a));
        $log = $logs ? file_get_contents($logs[0], false, null, max(0, filesize($logs[0]) - 131072)) : '';
        $found = preg_match_all('~\[object\] \(([A-Za-z_\\\\][A-Za-z0-9_\\\\]*)\(code: [^)]*\): [^\r\n]*? at [^\r\n]*?/([A-Za-z0-9_.-]+\.php):(\d+)~', (string) $log, $errors, PREG_SET_ORDER);
        $summary = $found ? array_slice($errors, -1)[0] : null;
        file_put_contents('php://stderr', $summary
            ? "Latest Laravel exception: {$summary[1]} in {$summary[2]}:{$summary[3]}" . PHP_EOL
            : "No Laravel exception location found in the latest file log." . PHP_EOL);
        throw new RuntimeException('Unexpected API identity');
    }

    $stage = 'transfer token';
    if (file_put_contents('php://fd/3', $token) !== strlen($token)) {
        throw new RuntimeException('Incomplete transfer');
    }
} catch (Throwable $error) {
    // SQL and HTTP exception messages can contain credentials.
    $detail = get_class($error) . ', code ' . $error->getCode();
    if ($stage === 'installation settings' && isset($settings) && method_exists($settings, 'getErrors')) {
        $detail .= ', fields: ' . implode(', ', $settings->getErrors()->keys());
    }
    file_put_contents('php://stderr', "Snipe-IT setup failed at $stage ($detail)." . PHP_EOL);
    exit(1);
}
