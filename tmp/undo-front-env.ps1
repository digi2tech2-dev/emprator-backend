$root = (Resolve-Path -LiteralPath 'D:\projects\emrator\emrator front').Path
$gitignore = (Resolve-Path -LiteralPath (Join-Path $root '.gitignore')).Path
$production = (Resolve-Path -LiteralPath (Join-Path $root '.env.production')).Path
$local = (Resolve-Path -LiteralPath (Join-Path $root '.env.production.local')).Path
foreach ($path in @($gitignore, $production, $local)) {
    if (-not $path.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unexpected path: $path"
    }
}
$linefeed = [string][char]10
$expected = @(
    'VITE_DATA_PROVIDER=real'
    'VITE_API_BASE_URL=https://ms-store-backend-1.onrender.com/api'
    'VITE_APP_ENV=production'
    'VITE_APP_MODE=production'
) -join $linefeed
foreach ($path in @($production, $local)) {
    $actual = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8).Replace(([string][char]13 + [char]10), $linefeed).TrimEnd([char]10)
    if ($actual -cne $expected) { throw "Unexpected edits in $path" }
}
$ignoreContent = [IO.File]::ReadAllText($gitignore, [Text.Encoding]::UTF8)
$suffix = '!.env.production' + [string][char]13 + $linefeed
if (-not $ignoreContent.EndsWith($suffix, [StringComparison]::Ordinal)) {
    throw 'Expected .gitignore suffix missing'
}
$restoredIgnore = $ignoreContent.Substring(0, $ignoreContent.Length - $suffix.Length)
[IO.File]::WriteAllText($gitignore, $restoredIgnore, [Text.UTF8Encoding]::new($false))
Remove-Item -LiteralPath $production
Remove-Item -LiteralPath $local
Write-Output 'Reverted only the frontend production API configuration from the previous turn'
