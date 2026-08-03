@echo off
setlocal enabledelayedexpansion

:: ── Siftly Launcher ─────────────────────────────────────────────────────────
:: Run this once to set up and start Siftly.
:: After first run, just run it again to start the app.
:: ─────────────────────────────────────────────────────────────────────────────

echo.
echo   Siftly
echo   AI-powered bookmark manager
echo.

:: ── 1. Create .env if missing ───────────────────────────────────────────────
if not exist ".env" (
  echo   Creating .env with default DATABASE_URL...
  echo DATABASE_URL="file:./prisma/dev.db"> .env
  echo.
)

:: ── 2. Install dependencies if needed ───────────────────────────────────────
if not exist "node_modules" (
  echo   Installing dependencies...
  call npm install
  echo.
)

:: ── 3. Set up database ──────────────────────────────────────────────────────
if not exist "app\generated\prisma\client\index.js" (
  echo   Generating Prisma client...
  call npx prisma generate
)

if not exist "prisma\dev.db" (
  echo   Setting up database...
  call npx prisma migrate deploy 2>nul || call npx prisma db push
) else (
  call npx prisma migrate deploy 2>nul
)
echo.

:: ── 4. Check auth ───────────────────────────────────────────────────────────
where claude >nul 2>nul
if %errorlevel%==0 (
  echo   [OK] Claude CLI detected — AI features will use your subscription automatically
) else (
  echo   [i] Claude CLI not found. Add your API key in Settings after opening the app.
)
echo.

:: ── 5. Set port ─────────────────────────────────────────────────────────────
if not defined PORT set PORT=3000

:: ── 6. Open browser and start ───────────────────────────────────────────────
echo   Starting on http://localhost:%PORT%
echo   Press Ctrl+C to stop
echo.

:: Open browser after a short delay
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:%PORT%"

call npx next dev -p %PORT%
