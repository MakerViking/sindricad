#!/bin/sh
# Post-install (deb/rpm): make the SpaceMouse udev rule take effect without a
# reboot or a replug.
#
# The rule itself is installed by the package to /usr/lib/udev/rules.d/ (the
# package-owned directory; /etc/udev/rules.d/ is reserved for admin overrides).
# systemd-udevd picks up new rules on its own in recent versions, but reloading
# explicitly means a SpaceMouse that is ALREADY plugged in starts working
# immediately rather than on next plug.
#
# Never fail the install over this: a container, a chroot, or a machine with no
# udev at all must still install the app cleanly. The app also detects the
# unreadable-device case at runtime and tells the user what to do, so a skipped
# reload degrades to a message, not a mystery.
set -e

if command -v udevadm >/dev/null 2>&1; then
  udevadm control --reload >/dev/null 2>&1 || true
  udevadm trigger --subsystem-match=hidraw >/dev/null 2>&1 || true
fi

exit 0
