#!/bin/sh
# Install the SindriCAD SpaceMouse hidraw udev rule and apply it to the currently
# connected 3Dconnexion device — no replug/reboot needed. Run with sudo:
#   sudo sh packaging/setup-spacemouse.sh
set -e

# Resolve the rule next to THIS script rather than hardcoding a path. It used to
# point at one developer's home directory (and at the project's former name), so
# the script failed for everyone who ran it as documented.
RULE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/99-spacemouse.rules"
[ -f "$RULE" ] || { echo "can't find 99-spacemouse.rules next to $0" >&2; exit 1; }
install -m644 "$RULE" /etc/udev/rules.d/
udevadm control --reload
udevadm trigger --subsystem-match=hidraw

# Apply immediately to any plugged 3Dconnexion device (vendor 046d or 256f),
# located by walking hidraw nodes rather than assuming a fixed hidrawN number.
found=0
for ue in /sys/class/hidraw/*/device/uevent; do
  if grep -qiE "v0000046D|v0000256F" "$ue" 2>/dev/null; then
    node="/dev/$(basename "$(dirname "$(dirname "$ue")")")"
    chgrp input "$node"
    chmod 660 "$node"
    echo "applied to $node:"
    ls -l "$node"
    found=1
  fi
done
[ "$found" = 1 ] || echo "no 3Dconnexion hidraw node found (is it plugged in?)"
