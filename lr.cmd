@echo off
REM One-command LienRadar local control. Examples:
REM   lr start
REM   lr stop
REM   lr restart
REM   lr status
REM   lr setup
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\lienradar.ps1" %*
