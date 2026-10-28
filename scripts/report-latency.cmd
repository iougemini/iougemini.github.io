@echo off
cd /d E:\repo\iougemini.github.io
git pull --rebase origin main >nul 2>&1
node scripts\report-latency.mjs
