@echo off
cd /d C:\Users\tom-a\werwolf-app

:: Auto-increment service worker cache version
for /f "tokens=2 delims=-" %%A in ('findstr /r "werwolf-v[0-9]*" sw.js') do set OLD=%%A
for /f "tokens=2 delims=v" %%B in ('findstr /r "werwolf-v[0-9]*" sw.js') do set /a NEW=%%B+1
powershell -Command "(Get-Content sw.js) -replace 'werwolf-v[0-9]+', 'werwolf-v%NEW%' | Set-Content sw.js"
powershell -Command "[IO.File]::WriteAllText('js/buildinfo.js', \"export const BUILD = '0.%NEW%';`n\", [Text.Encoding]::UTF8)"
echo Deployed: v%NEW%

git add .
git commit -m "Deploy %date% %time%"
git push
