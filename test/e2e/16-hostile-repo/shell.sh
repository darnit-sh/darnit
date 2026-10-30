#!/bin/sh
touch "$(dirname "$0")/ran-script-shell"
exec /bin/sh "$@"
