#!/bin/sh
# Instala o actualiza el toolkit en macOS o Linux (en Windows: install.ps1). La lógica está en toolkit.py.
# Opciones: ./install.sh --help. Otro Python: PYTHON=/ruta/python3 ./install.sh
set -e
exec "${PYTHON:-python3}" -I "$(dirname "$0")/toolkit.py" install "$@"
