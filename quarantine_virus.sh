#!/usr/bin/env bash

# Path to the suspected malicious file
TARGET="/home/rayu/Downloads/Telegram Desktop/ឯកសារ（1）.exe"

# Directory where we quarantine suspicious files
QUARANTINE_DIR="$HOME/quarantine"

if [[ -e "$TARGET" ]]; then
  # Ensure the quarantine directory exists
  mkdir -p "$QUARANTINE_DIR"
  # Move the file to quarantine
  mv -v "$TARGET" "$QUARANTINE_DIR/"
  echo "⚠️ Warning: The file \"$TARGET\" was identified as malicious and has been moved to \"$QUARANTINE_DIR\"."
else
  echo "✅ No malicious file found at the specified location."
fi
