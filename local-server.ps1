$ErrorActionPreference = 'Stop'
$publicFolder = Join-Path $PSScriptRoot 'public'
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add('http://localhost:3000/')
$listener.Start()
Write-Host 'Website running at http://localhost:3000'
Write-Host 'Press Ctrl+C to stop the server.'

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $path = $context.Request.Url.AbsolutePath
        $fileName = switch ($path) {
            '/' { 'index.html' }
            '/index.html' { 'index.html' }
            '/styles.css' { 'styles.css' }
            '/app.js' { 'app.js' }
            '/karvishit-logo.svg' { 'karvishit-logo.svg' }
            default { $null }
        }

        if ($null -eq $fileName) {
            $context.Response.StatusCode = 404
            $context.Response.Close()
            continue
        }

        $filePath = Join-Path $publicFolder $fileName
        $contentType = switch ([System.IO.Path]::GetExtension($fileName)) {
            '.css' { 'text/css; charset=utf-8' }
            '.js' { 'application/javascript; charset=utf-8' }
            '.svg' { 'image/svg+xml' }
            default { 'text/html; charset=utf-8' }
        }
        $bytes = [System.IO.File]::ReadAllBytes($filePath)
        $context.Response.ContentType = $contentType
        $context.Response.ContentLength64 = $bytes.Length
        $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        $context.Response.Close()
    }
}
finally {
    $listener.Stop()
    $listener.Close()
}
