#!/bin/sh
# Install the Verxa SpaceMouse hidraw udev rule and apply it to the currently
# connected 3Dconnexion device — no replug/reboot needed. Run with sudo:
#   sudo sh /home/thomash/Koding/projects/Verxa/packaging/setup-spacemouse.sh
set -e

RULE=/home/thomash/Koding/projects/Verxa/packaging/99-spacemouse.rules
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
