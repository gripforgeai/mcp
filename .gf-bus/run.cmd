@echo off
rem Lanceur gf-bus pour cmd.exe — voir USAGE.md
where node >nul 2>nul || (echo gf-bus : Node.js ^>= 22 introuvable, bus des agents desactive. & exit /b 0)
node "%~dp0gf-bus.mjs" %*
