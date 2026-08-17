@echo off
cd /d C:\signalk\signalkhome\.signalk
npm install "%~dp0signalk-bsh-tides-1.0.24.tgz"
echo Installed signalk-bsh-tides 1.0.24. Restart Signal K afterwards.
