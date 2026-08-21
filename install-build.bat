@echo off
setlocal
cd /d "%~dp0"
set "EXIT_CODE=0"

call npm config set fetch-timeout 600000 >nul 2>&1

echo [MK_jianyi] 1/2 npm install ...
call npm install
if errorlevel 1 (
  set "EXIT_CODE=1"
  echo [MK_jianyi] npm install failed, build skipped
  goto end
)

echo [MK_jianyi] 2/2 npm run build ...
call npm run build
if errorlevel 1 (
  set "EXIT_CODE=1"
  echo [MK_jianyi] npm run build failed
  goto end
)

echo [MK_jianyi] build done -^> kakake-plugin-mkjianyi\

:end
echo.
pause
endlocal & exit /b %EXIT_CODE%
