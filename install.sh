#!/bin/bash
# Install the Claude Usage GNOME Shell extension
set -e

EXT_UUID="claude-usage@tasta.space"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

echo "Installing Claude Usage extension..."

# Compile schemas
glib-compile-schemas "$(dirname "$0")/schemas/"

# Remove old version if present
rm -rf "$EXT_DIR"

# Copy extension files
mkdir -p "$EXT_DIR"
cp -r "$(dirname "$0")"/{metadata.json,extension.js,prefs.js,stylesheet.css,schemas,icons} "$EXT_DIR/"

echo "Installed to $EXT_DIR"
echo ""
echo "To activate, either:"
echo "  1. Log out and log back in, then run:"
echo "     gnome-extensions enable $EXT_UUID"
echo "  2. Or restart GNOME Shell (X11: Alt+F2, type 'r')"
echo ""
echo "The extension auto-reads your Claude Code OAuth token from:"
echo "  ~/.claude/.credentials.json"
echo ""
echo "If you don't use Claude Code, open extension preferences to set the token manually."
