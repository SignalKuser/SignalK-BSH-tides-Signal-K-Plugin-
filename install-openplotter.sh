#!/usr/bin/env bash
set -euo pipefail
cd "$HOME/.signalk"
npm install "./signalk-bsh-tides-1.0.24.tgz"
echo "Installed signalk-bsh-tides 1.0.24. Restart Signal K afterwards."
