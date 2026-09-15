$ErrorActionPreference = 'Stop'
$backendDirectory = Split-Path -Parent $PSScriptRoot
$rulesSource = Join-Path (Split-Path -Parent $backendDirectory) 'Mobile/firestore.rules'
if (-not (Test-Path -LiteralPath $rulesSource)) { throw 'O teste usa as regras reais do projeto Mobile ao lado do Backend.' }
New-Item -ItemType Directory -Force -Path (Join-Path $backendDirectory 'tmp') | Out-Null
Copy-Item -LiteralPath $rulesSource -Destination (Join-Path $backendDirectory 'tmp/firestore.rules')
Push-Location $backendDirectory
try {
    npx -y firebase-tools@latest emulators:exec --config firebase.test.json --project demo-agenda-usage --only 'firestore,auth' 'npm run test:emulator'
    if ($LASTEXITCODE -ne 0) { throw 'Os testes com emuladores falharam.' }
} finally { Pop-Location }
