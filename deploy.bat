@echo off
cd /d C:\Users\tom-a\werwolf-app
git add .
git commit -m "Deploy %date% %time%"
git push
pause