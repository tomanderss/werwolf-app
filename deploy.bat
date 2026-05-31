@echo off
cd /d C:\Users\tom-a\werwolf-app

:: Auto-increment version via PowerShell
for /f %%V in ('powershell -Command "[regex]::Match((Get-Content sw.js -Raw), 'werwolf-v(\d+)').Groups[1].Value"') do set CURR=%%V
set /a NEW=%CURR%+1
powershell -Command "(Get-Content sw.js -Raw) -replace 'werwolf-v\d+', 'werwolf-v%NEW%' | Set-Content sw.js -NoNewline"
powershell -Command "[IO.File]::WriteAllText((Resolve-Path 'js/buildinfo.js'), \"export const BUILD = '0.%NEW%';`n\", [Text.Encoding]::UTF8)"
del /q 0.*.txt 2>nul
echo.> 0.%NEW%.txt
echo Deployed: 0.%NEW%

git add .
git commit -m "Deploy %date% %time%"
git push
