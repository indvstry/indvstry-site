#!/bin/bash
#
# Extract tweet content from a Twitter/X URL
# Outputs static HTML ready to paste into index.html
#
# Usage: ./extract-tweet.sh <tweet-url> [caption]
# Example: ./extract-tweet.sh https://x.com/kepano/status/1675626836821409792 "File over app"

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <tweet-url> [caption]"
  echo "Example: $0 https://x.com/kepano/status/1675626836821409792 \"File over app\""
  exit 1
fi

TWEET_URL="$1"
CAPTION="${2:-}"

# Fetch oEmbed data
OEMBED_URL="https://publish.x.com/oembed?url=${TWEET_URL}&omit_script=true"
JSON=$(curl -sL "$OEMBED_URL")

if [ -z "$JSON" ] || echo "$JSON" | grep -q '"errors"'; then
  echo "Error: Could not fetch tweet. Check the URL." >&2
  exit 1
fi

# Extract fields
AUTHOR_NAME=$(echo "$JSON" | jq -r '.author_name')
AUTHOR_URL=$(echo "$JSON" | jq -r '.author_url')
HTML=$(echo "$JSON" | jq -r '.html')

# Extract tweet text from HTML (between <p> tags, before the &mdash;)
TWEET_TEXT=$(echo "$HTML" | sed -n 's/.*<p[^>]*>\(.*\)<\/p>.*/\1/p' | head -1)
# Clean up: remove links, convert <br> to newlines
TWEET_TEXT=$(echo "$TWEET_TEXT" | sed 's/<br>/\n/g' | sed 's/<[^>]*>//g' | sed 's/&amp;/\&/g')

# Extract date
TWEET_DATE=$(echo "$HTML" | grep -oE '[A-Z][a-z]+ [0-9]+, [0-9]+' | head -1)

# Generate today's date for the post
POST_DATE=$(date +%Y-%m-%d)
# Mirror generatePostId in add-tidbit.js: highest suffix for the day, plus one.
# $RANDOM collided with existing ids.
INDEX="$(dirname "$0")/../index.html"
DATE_COMPACT=$(date +%Y%m%d)
MAX=$(sed -n "s/.*id=\"post-${DATE_COMPACT}-\([0-9]\{1,\}\)\".*/\1/p" "$INDEX" 2>/dev/null | sort -n | tail -1)
POST_ID="${DATE_COMPACT}-$(( ${MAX:-0} + 1 ))"

# If no caption provided, use first line of tweet
if [ -z "$CAPTION" ]; then
  CAPTION=$(echo "$TWEET_TEXT" | head -1 | cut -c1-50)
fi

# Output the HTML
cat << EOF

      <article class="post post--expandable post--tweet" id="post-${POST_ID}">
        <details class="post__details">
          <summary class="post__summary">
            <span class="post__summary-title">${CAPTION}</span>
            <div class="post__summary-row">
              <span class="post__summary-domain">x.com</span>
              <span class="post__summary-toggle"></span>
            </div>
          </summary>
          <div class="post__expand-content">
            <blockquote class="post__static-tweet">
              <p>${TWEET_TEXT}</p>
              <footer>
                <a href="${AUTHOR_URL}">@${AUTHOR_NAME}</a> · ${TWEET_DATE} ·
                <a href="${TWEET_URL}">View on X</a>
              </footer>
            </blockquote>
          </div>
        </details>
        <footer class="post__meta">
          <time datetime="${POST_DATE}">${POST_DATE}</time>
        </footer>
      </article>

EOF
