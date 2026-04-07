@echo off
if not exist "node_modules" (
    npm install
)
"C:\Program Files\nodejs\node.exe" --no-warnings server.js
pause
