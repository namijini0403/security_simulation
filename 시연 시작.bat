@echo off
setlocal
chcp 65001 >nul

rem ===========================================================================
rem  Launcher for double-click on Windows. (Korean description: end of file.)
rem
rem  What it does: goes to the folder this file is in, finds Node.js, checks
rem  that it is version 22 or newer, then runs the program below. Nothing else.
rem  It never changes network or firewall settings, never asks for
rem  administrator rights, and never downloads or installs anything.
rem
rem  IMPORTANT for anyone editing this file:
rem   - Everything ABOVE the line "exit /b %RC%" must stay plain ASCII.
rem     cmd.exe loses its place in a batch file that has non-ASCII bytes in
rem     the part it executes once the code page is switched to UTF-8.
rem   - All Korean text lives in the "::[name]text" lines at the very end.
rem     They are never executed; they are printed with findstr.
rem   - No goto and no :labels, so the file also works with LF line endings.
rem   - Save as UTF-8 without BOM.
rem ===========================================================================

set "PROGRAM=src\demo.js"
set "SELF=%~f0"
set "FAIL="
set "NODE_RUN="
set "OLD_RUN="
rem Exit code 0 when Node.js is 22 or newer, 3 when it is older.
set NODE_CHECK=-e "process.exit(Math.floor(parseInt(process.versions.node)/22)?0:3)"

for /f "tokens=1* delims=]" %%a in ('findstr /l /b /c:"::[title]" "%SELF%"') do title %%b

cd /d "%~dp0" 2>nul || set "FAIL=folder"
if not defined FAIL if not exist "%PROGRAM%" set "FAIL=files"

rem ---- 1. node on PATH
set "CAND="
set "RC="
where node >nul 2>nul && set "CAND=node"
if defined CAND call %CAND% %NODE_CHECK% >nul 2>nul
if defined CAND set "RC=%errorlevel%"
if "%RC%"=="0" if not defined NODE_RUN set "NODE_RUN=%CAND%"
if "%RC%"=="3" if not defined OLD_RUN set "OLD_RUN=%CAND%"

rem ---- 2. fnm (a Node.js version manager): on PATH, then its usual install folders
set "FNM_EXE="
where fnm >nul 2>nul && set "FNM_EXE=fnm"
if not defined FNM_EXE if exist "%LOCALAPPDATA%\Programs\fnm\fnm.exe" set "FNM_EXE=%LOCALAPPDATA%\Programs\fnm\fnm.exe"
if not defined FNM_EXE if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\fnm.exe" set "FNM_EXE=%LOCALAPPDATA%\Microsoft\WinGet\Links\fnm.exe"
if not defined FNM_EXE if exist "%USERPROFILE%\scoop\shims\fnm.exe" set "FNM_EXE=%USERPROFILE%\scoop\shims\fnm.exe"
if not defined FNM_EXE if exist "%USERPROFILE%\.cargo\bin\fnm.exe" set "FNM_EXE=%USERPROFILE%\.cargo\bin\fnm.exe"

rem      try fnm's default version, then 22, then 24
set "CAND="
set "RC="
if not defined NODE_RUN if defined FNM_EXE set CAND="%FNM_EXE%" exec --using=default node
if defined CAND call %CAND% %NODE_CHECK% >nul 2>nul
if defined CAND set "RC=%errorlevel%"
if "%RC%"=="0" if not defined NODE_RUN set NODE_RUN=%CAND%
if "%RC%"=="3" if not defined OLD_RUN set OLD_RUN=%CAND%

set "CAND="
set "RC="
if not defined NODE_RUN if defined FNM_EXE set CAND="%FNM_EXE%" exec --using=22 node
if defined CAND call %CAND% %NODE_CHECK% >nul 2>nul
if defined CAND set "RC=%errorlevel%"
if "%RC%"=="0" if not defined NODE_RUN set NODE_RUN=%CAND%

set "CAND="
set "RC="
if not defined NODE_RUN if defined FNM_EXE set CAND="%FNM_EXE%" exec --using=24 node
if defined CAND call %CAND% %NODE_CHECK% >nul 2>nul
if defined CAND set "RC=%errorlevel%"
if "%RC%"=="0" if not defined NODE_RUN set NODE_RUN=%CAND%

rem ---- 3. the folder nvm-windows links to
set "CAND="
set "RC="
if not defined NODE_RUN if defined NVM_SYMLINK if exist "%NVM_SYMLINK%\node.exe" set CAND="%NVM_SYMLINK%\node.exe"
if defined CAND call %CAND% %NODE_CHECK% >nul 2>nul
if defined CAND set "RC=%errorlevel%"
if "%RC%"=="0" if not defined NODE_RUN set NODE_RUN=%CAND%
if "%RC%"=="3" if not defined OLD_RUN set OLD_RUN=%CAND%

rem ---- 4. the default folder of the official installer
set "CAND="
set "RC="
if not defined NODE_RUN if exist "%ProgramFiles%\nodejs\node.exe" set CAND="%ProgramFiles%\nodejs\node.exe"
if defined CAND call %CAND% %NODE_CHECK% >nul 2>nul
if defined CAND set "RC=%errorlevel%"
if "%RC%"=="0" if not defined NODE_RUN set NODE_RUN=%CAND%
if "%RC%"=="3" if not defined OLD_RUN set OLD_RUN=%CAND%

set "CAND="
set "RC="
if not defined NODE_RUN if exist "%ProgramW6432%\nodejs\node.exe" set CAND="%ProgramW6432%\nodejs\node.exe"
if defined CAND call %CAND% %NODE_CHECK% >nul 2>nul
if defined CAND set "RC=%errorlevel%"
if "%RC%"=="0" if not defined NODE_RUN set NODE_RUN=%CAND%
if "%RC%"=="3" if not defined OLD_RUN set OLD_RUN=%CAND%

if not defined FAIL if not defined NODE_RUN if defined OLD_RUN set "FAIL=old"
if not defined FAIL if not defined NODE_RUN set "FAIL=none"

rem ---- could not start: say why (in Korean) and keep the window open
if defined FAIL for /f "tokens=1* delims=]" %%a in ('findstr /l /b /c:"::[%FAIL%]" "%SELF%"') do echo(%%b
if "%FAIL%"=="old" call %OLD_RUN% --version
if "%FAIL%"=="old" for /f "tokens=1* delims=]" %%a in ('findstr /l /b /c:"::[old-how]" "%SELF%"') do echo(%%b
if defined FAIL for /f "tokens=1* delims=]" %%a in ('findstr /l /b /c:"::[close]" "%SELF%"') do echo(%%b
if defined FAIL pause >nul
if defined FAIL exit /b 1

rem ---- run
for /f "tokens=1* delims=]" %%a in ('findstr /l /b /c:"::[start]" "%SELF%"') do echo(%%b

call %NODE_RUN% "%PROGRAM%"
set "RC=%errorlevel%"

echo(
if "%RC%"=="0" for /f "tokens=1* delims=]" %%a in ('findstr /l /b /c:"::[done]" "%SELF%"') do echo(%%b
if not "%RC%"=="0" for /f "tokens=1* delims=]" %%a in ('findstr /l /b /c:"::[stopped]" "%SELF%"') do echo(%%b
for /f "tokens=1* delims=]" %%a in ('findstr /l /b /c:"::[close]" "%SELF%"') do echo(%%b
pause >nul
exit /b %RC%

===========================================================================
 여기부터는 실행되지 않는 부분입니다. 화면에 보여 줄 한국어 문구만 들어 있습니다.

 이 파일은 Windows에서 더블클릭해 시연 프로그램을 실행하는 파일입니다.
 하는 일: 이 파일이 있는 폴더로 가서 Node.js를 찾고, 22 이상인지 확인한 뒤 프로그램을 실행합니다.
 하지 않는 일: 네트워크와 방화벽 설정을 바꾸지 않습니다. 관리자 권한을 요청하지 않습니다.
               아무것도 내려받거나 설치하지 않습니다.

 문구를 고치려면 아래의 "::[이름]문구" 줄만 고치면 됩니다. 위쪽 실행 부분에는 한글을 넣지 마세요.
===========================================================================

::[title]시연 프로그램 - 교육용 가상 데이터

::[start]
::[start]시연 프로그램을 시작합니다. 이 창은 발표가 끝날 때까지 닫지 마세요.
::[start]끝낼 때는 이 창을 닫으면 됩니다.

::[done]시연 프로그램이 끝났습니다.
::[stopped]시연 프로그램이 시작되지 못했거나 도중에 멈췄습니다. 위에 나온 안내를 읽어 주세요.
::[close]이 창은 아무 키나 누르면 닫힙니다.

::[folder]
::[folder][시작하지 못했습니다]
::[folder]이 파일이 있는 폴더로 들어가지 못했습니다.
::[folder]내려받은 폴더 전체를 바탕 화면이나 문서 폴더로 옮긴 뒤 다시 더블클릭해 주세요.
::[folder]

::[files]
::[files][시작하지 못했습니다]
::[files]프로그램 파일을 찾지 못했습니다. 이 파일 옆에 src 폴더가 있어야 합니다.
::[files]
::[files] - 압축 파일 안에서 바로 더블클릭했다면, 먼저 압축을 모두 푼 뒤
::[files]   풀린 폴더 안에 있는 이 파일을 더블클릭해 주세요.
::[files] - 이 파일만 다른 곳으로 옮겼다면, 원래 폴더에 다시 넣어 주세요.
::[files]

::[none]
::[none][시작하지 못했습니다]
::[none]이 컴퓨터에서 Node.js를 찾지 못했습니다.
::[none]이 프로그램은 Node.js 22 이상이 있어야 실행됩니다.
::[none]
::[none]설치 방법
::[none]  1. 브라우저에서 Node.js 공식 사이트 https://nodejs.org 를 엽니다.
::[none]  2. "LTS"라고 적힌 Windows 설치 파일을 내려받아 실행합니다.
::[none]     설치 화면에서는 설정을 바꾸지 않고 계속 넘기면 됩니다.
::[none]  3. 설치가 끝나면 이 창을 닫고 이 파일을 다시 더블클릭합니다.
::[none]
::[none]자세한 안내는 같은 폴더의 README.md 에 있습니다.
::[none]

::[old]
::[old][시작하지 못했습니다]
::[old]이 컴퓨터의 Node.js가 너무 오래된 버전입니다.
::[old]이 프로그램은 Node.js 22 이상이 있어야 실행됩니다.
::[old]
::[old]지금 설치된 버전:
::[old-how]
::[old-how]고치는 방법
::[old-how]  1. 브라우저에서 Node.js 공식 사이트 https://nodejs.org 를 엽니다.
::[old-how]  2. "LTS"라고 적힌 Windows 설치 파일을 내려받아 실행합니다.
::[old-how]     예전 버전 위에 그대로 설치하면 됩니다.
::[old-how]  3. 설치가 끝나면 이 창을 닫고 이 파일을 다시 더블클릭합니다.
::[old-how]
