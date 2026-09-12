#!/bin/bash
#
# Archive the videos this site links to — outside the repo.
#
# The site stores a poster frame for each video post, which is enough to keep
# the post meaningful if the original disappears. The video itself is a
# different matter: one YouTube post measured ~295MB against a 2.9MB .git for
# the entire site, and GitHub hard-rejects files over 100MB. So videos go to a
# synced folder instead of into version control.
#
# Usage:
#   ./archive-videos.sh              # archive every video post in index.html
#   ./archive-videos.sh --dry-run    # list what would be downloaded
#   ./archive-videos.sh <url> ...    # archive specific urls
#
# Override the destination with INDVSTRY_ARCHIVE, e.g. an S3 mount or another
# synced folder:
#   INDVSTRY_ARCHIVE=~/somewhere/else ./archive-videos.sh

set -euo pipefail

ARCHIVE_DIR="${INDVSTRY_ARCHIVE:-$HOME/Library/CloudStorage/Dropbox/indvstry-archive}"
INDEX="$(cd "$(dirname "$0")/.." && pwd)/index.html"
# yt-dlp records what it has already fetched here, so re-running is cheap and
# idempotent rather than re-downloading everything.
SEEN="$ARCHIVE_DIR/.downloaded"

DRY_RUN=0
URLS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 1 ;;
    *) URLS+=("$arg") ;;
  esac
done

command -v yt-dlp >/dev/null || { echo "yt-dlp not installed (brew install yt-dlp)" >&2; exit 1; }

# With no urls given, take every video the site links to. Posters live in the
# repo; the source urls are what we need here.
if [ ${#URLS[@]} -eq 0 ]; then
  [ -f "$INDEX" ] || { echo "index.html not found at $INDEX" >&2; exit 1; }
  while IFS= read -r u; do URLS+=("$u"); done < <(
    {
      grep -oE 'href="https://www\.tiktok\.com/@[^"]+/video/[0-9]+"' "$INDEX" | sed 's/href="//; s/"$//'
      grep -oE 'src="https://www\.youtube\.com/embed/[A-Za-z0-9_-]{11}"' "$INDEX" \
        | sed 's|src="https://www.youtube.com/embed/|https://www.youtube.com/watch?v=|; s/"$//'
      grep -oE 'href="https://www\.instagram\.com/(p|reel)/[A-Za-z0-9_-]+/?"' "$INDEX" | sed 's/href="//; s/"$//'
    } | sort -u
  )
fi

if [ ${#URLS[@]} -eq 0 ]; then
  echo "No video posts found in index.html — nothing to archive."
  exit 0
fi

echo "Archive: $ARCHIVE_DIR"
echo "Found ${#URLS[@]} video(s)."

if [ "$DRY_RUN" -eq 1 ]; then
  printf '  %s\n' "${URLS[@]}"
  echo "(dry run — nothing downloaded)"
  exit 0
fi

mkdir -p "$ARCHIVE_DIR"

for u in "${URLS[@]}"; do
  echo "--- $u"
  # Keep the metadata alongside the file: if the post ever needs rebuilding,
  # the description, thumbnail and upload date are all that is left.
  yt-dlp \
    --no-warnings \
    --no-playlist \
    --download-archive "$SEEN" \
    --write-info-json \
    --write-thumbnail \
    --restrict-filenames \
    --output "$ARCHIVE_DIR/%(extractor)s/%(id)s - %(title).80s.%(ext)s" \
    "$u" || echo "  (failed: $u)"
done

# yt-dlp marks a truncated title with an ellipsis, which runs into the
# extension separator and yields "name....mp4". Collapse the run of dots.
find "$ARCHIVE_DIR" -type f -name '*....*' | while IFS= read -r f; do
  tidy="$(echo "$f" | sed 's/\.\{2,\}/./g')"
  [ "$f" != "$tidy" ] && mv -n "$f" "$tidy"
done

echo
echo "Done. $(find "$ARCHIVE_DIR" -type f ! -name '.downloaded' | wc -l | tr -d ' ') file(s) in archive."
du -sh "$ARCHIVE_DIR" 2>/dev/null | awk '{print "Size: "$1}'
