#!/bin/sh
# Retira el toolkit en macOS o Linux (en Windows: uninstall.ps1). Opciones: --claude-dir D, --delete-data.
set -e
exec "${PYTHON:-python3}" -I "$(dirname "$0")/toolkit.py" uninstall "$@"
