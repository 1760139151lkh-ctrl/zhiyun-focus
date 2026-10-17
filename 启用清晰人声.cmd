@echo off
chcp 65001 >nul
python -X utf8 "%~dp0viewer\audio-helper\launcher.py"
set "ZJF_AUDIO_EXIT=%errorlevel%"
if not "%ZJF_AUDIO_EXIT%"=="0" pause
exit /b %ZJF_AUDIO_EXIT%
