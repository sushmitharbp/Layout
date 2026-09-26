@echo off
title SheetLayout AI Production Server
echo Starting SheetLayout AI with Waitress WSGI Server...
pip install -r requirements.txt >nul 2>&1
python run_production_windows.py
pause
