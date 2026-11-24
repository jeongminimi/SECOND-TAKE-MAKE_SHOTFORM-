@echo off
chcp 65001 >nul
cd /d "%~dp0"
title SECOND TAKE - 점검 및 복구
echo.
echo ================================================
echo   SECOND TAKE  점검 및 복구
echo ================================================
echo.
echo [1단계] 아직 켜져 있는 서버가 있는지 확인합니다.
echo.
powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' }; if($p){ $p | ForEach-Object { Write-Host ('  켜져 있음 - 프로세스 번호 ' + $_.ProcessId) } } else { Write-Host '  켜져 있는 서버 없음 (정상)' }"
echo.
set /p K="  켜져 있는 서버를 모두 종료할까요? [Y/N] "
if /i not "%K%"=="Y" goto STEP2
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo   종료했습니다.
timeout /t 2 >nul

:STEP2
echo.
echo [2단계] 데이터베이스를 점검합니다.
echo.
node --disable-warning=ExperimentalWarning tools\db-doctor.js
if errorlevel 1 goto ASKREPAIR
goto DONE

:ASKREPAIR
echo.
echo ------------------------------------------------
set /p A="  복구할까요? 기존 파일은 지우지 않고 보관합니다 [Y/N] "
if /i not "%A%"=="Y" goto DONE
echo.
node --disable-warning=ExperimentalWarning tools\db-doctor.js --repair

:DONE
echo.
echo ------------------------------------------------
set /p S="  지금 프로그램을 켤까요? [Y/N] "
if /i "%S%"=="Y" start "" "%~dp0start-studio.bat"
echo.
pause
