@echo off
rem Double-click to install ExportX into DaVinci Resolve Studio (Windows).
rem Windows asks for administrator rights once: the plugin folder lives under ProgramData.
rem A PowerShell window stays open afterwards so you can read what it did.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -NoExit -File \"%~dp0scripts\install.ps1\"'"
