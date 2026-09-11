const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PREVIEWS_DIR = path.join(__dirname, '..', 'images', 'previews');

const PORT = 3333;
const TIDBITS_PATH = path.join(__dirname, '..', 'index.html');

// Extract domain from URL
function extractDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// The preview re-renders as you type; without this every keystroke would be
// another round trip to a rate-limited third-party API.
const oembedCache = new Map();

// Fetch oEmbed data from a platform
function fetchOEmbed(url, platform) {
  const key = `${platform}|${url}`;
  if (oembedCache.has(key)) return Promise.resolve(oembedCache.get(key));
  return fetchOEmbedUncached(url, platform).then((data) => {
    oembedCache.set(key, data);
    return data;
  });
}

function fetchOEmbedUncached(url, platform) {
  return new Promise((resolve, reject) => {
    let oembedUrl;
    if (platform === 'tiktok') {
      oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
    } else if (platform === 'twitter') {
      // publish.twitter.com now 301s to publish.x.com
      oembedUrl = `https://publish.x.com/oembed?url=${encodeURIComponent(url)}&omit_script=true`;
    } else {
      return reject(new Error('Unsupported platform for oEmbed'));
    }
    // https.get does not follow redirects, and a redirect body is not JSON —
    // without this the parse throws and the caller silently degrades the post.
    const get = (target, hops = 0) => {
      if (hops > 3) return reject(new Error('Too many redirects'));
      https.get(target, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return get(new URL(res.headers.location, target).href, hops + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`oEmbed returned HTTP ${res.statusCode}`));
        }
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        });
      }).on('error', reject);
    };
    get(oembedUrl);
  });
}

// Download image from URL, following redirects
function downloadImage(imageUrl, destPath) {
  return new Promise((resolve, reject) => {
    const get = (url) => {
      https.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location);
          return;
        }
        const fileStream = fs.createWriteStream(destPath);
        res.pipe(fileStream);
        fileStream.on('finish', () => { fileStream.close(); resolve(); });
      }).on('error', reject);
    };
    get(imageUrl);
  });
}

// Detect video/social platform and return embed code
function getVideoEmbed(url) {
  if (!url) return null;

  // YouTube detection
  const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/);
  if (ytMatch) {
    return {
      platform: 'youtube',
      containerClass: 'post__embed-container',
      embed: `<iframe width="560" height="315" src="https://www.youtube.com/embed/${ytMatch[1]}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`
    };
  }

  // TikTok detection - returns async flag for thumbnail fetch
  const ttMatch = url.match(/tiktok\.com\/@([^/]+)\/video\/(\d+)/);
  if (ttMatch) {
    const videoId = ttMatch[2];
    return {
      platform: 'tiktok',
      videoId,
      async: true,
      containerClass: 'post__embed-container post__embed-container--tiktok'
    };
  }

  // X/Twitter detection - use oEmbed for full tweet content
  const xMatch = url.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/);
  if (xMatch) {
    return {
      platform: 'twitter',
      async: true,
      containerClass: 'post__embed-container post__embed-container--tweet'
    };
  }

  // Instagram detection
  const igMatch = url.match(/instagram\.com\/(?:p|reel)\/([A-Za-z0-9_-]+)/);
  if (igMatch) {
    return {
      platform: 'instagram',
      containerClass: 'post__embed-container post__embed-container--instagram',
      embed: `<blockquote class="instagram-media" data-instgrm-permalink="${url}" data-instgrm-version="14"><a href="${url}"></a></blockquote>`
    };
  }

  return null;
}

// Matches any modifier combination, e.g. "post--link" or "post--embed post--tweet".
// Anything narrower misses the variants the Twitter/TikTok paths emit.
const POST_CLASS_RE = 'post--[a-z-]+(?:\\s+post--[a-z-]+)*';

// A pasted platform blockquote is an empty shell: it only renders if that
// platform's script is on the page, and index.html deliberately loads none of
// them (see d439b1a, and the widgets.js removal). Recover the source URL so the
// static path handles it instead of writing markup that renders as nothing.
function urlFromPastedEmbed(body) {
  if (!body) return null;
  const tiktok = body.match(/tiktok-embed[^>]*cite="([^"]+)"/);
  if (tiktok) return tiktok[1];
  const tweet = body.match(/twitter-tweet[\s\S]*?href="(https:\/\/(?:twitter\.com|x\.com)\/\w+\/status\/\d+)[^"]*"/);
  if (tweet) return tweet[1];
  return null;
}

// Parse all tidbits from HTML
function parseTidbits() {
  const html = fs.readFileSync(TIDBITS_PATH, 'utf-8');
  const tidbits = [];

  // Match all article elements
  const articleRegex = new RegExp(
    `<article class="post (${POST_CLASS_RE})" id="(post-\\d{8}-\\d+)">([\\s\\S]*?)<\\/article>`,
    'g'
  );
  let match;

  while ((match = articleRegex.exec(html)) !== null) {
    const classes = match[1];
    const id = match[2];
    const content = match[3];

    // Hand-authored shapes have no generator counterpart, so an edit would
    // rewrite them into something else entirely. Keep them out of the editor.
    if (/\bpost--expandable\b/.test(classes)) continue;

    const dateMatch = content.match(/<time datetime="([^"]+)">/);
    const date = dateMatch ? dateMatch[1] : undefined;

    // Tweet and TikTok posts are both produced by the "link" path from a source
    // URL, so round-trip them as links — saving then regenerates the same markup
    // instead of collapsing them into a bare embed container.
    const tweetUrl = /\bpost--tweet\b/.test(classes)
      ? content.match(/https:\/\/(?:twitter\.com|x\.com)\/\w+\/status\/\d+/)?.[0]
      : null;
    const previewUrl = content.match(
      /<a href="([^"]+)"[^>]*class="post__embed-preview">/
    )?.[1];
    const sourceUrl = tweetUrl || previewUrl;

    if (sourceUrl) {
      const captions = [
        ...content.matchAll(/<p class="post__embed-caption">([^<]+)<\/p>/g)
      ];
      tidbits.push({
        id,
        type: 'link',
        date,
        url: sourceUrl,
        title: captions[0] ? decodeHtml(captions[0][1]) : undefined,
        description: captions[1] ? decodeHtml(captions[1][1]) : undefined
      });
      continue;
    }

    const baseType = classes.match(/^post--(link|quote|text|embed)\b/);
    if (!baseType) continue;
    const type = baseType[1];

    const tidbit = { id, type };
    if (date) tidbit.date = date;

    // Extract based on type
    if (type === 'link') {
      const urlMatch = content.match(/<a href="([^"]+)" class="post__link-card">/);
      const titleMatch = content.match(/<span class="post__link-title">([^<]+)<\/span>/);
      const descMatch = content.match(/<p class="post__link-commentary">([^<]+)<\/p>/);
      if (urlMatch) tidbit.url = urlMatch[1];
      if (titleMatch) tidbit.title = decodeHtml(titleMatch[1]);
      if (descMatch) tidbit.description = decodeHtml(descMatch[1]);
    } else if (type === 'quote') {
      const bodyMatch = content.match(/<blockquote>\s*<p>([^<]+)<\/p>\s*<\/blockquote>/);
      const urlMatch = content.match(/<cite><a href="([^"]+)">/);
      const titleMatch = content.match(/<cite><a href="[^"]+">([^<]+)<\/a><\/cite>/);
      if (bodyMatch) tidbit.body = decodeHtml(bodyMatch[1]);
      if (urlMatch) tidbit.url = urlMatch[1];
      if (titleMatch) tidbit.title = decodeHtml(titleMatch[1]);
    } else if (type === 'text') {
      const bodyMatch = content.match(/<div class="post__content">\s*<p>([^<]+)<\/p>/);
      if (bodyMatch) tidbit.body = decodeHtml(bodyMatch[1]);
    } else if (type === 'embed') {
      const titleMatch = content.match(/<p class="post__embed-caption">([^<]+)<\/p>/);
      const embedMatch = content.match(/<div class="post__embed-container[^"]*">([\s\S]*?)<\/div>/);
      // No recoverable embed code means a save would emit an empty container.
      if (!embedMatch) continue;
      if (titleMatch) tidbit.title = decodeHtml(titleMatch[1]);
      tidbit.body = embedMatch[1].trim();
    }

    tidbits.push(tidbit);
  }

  return tidbits;
}

// Decode HTML entities
function decodeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

// Generate post ID based on date and existing posts
function generatePostId(dateStr, html) {
  const dateCompact = dateStr.replace(/-/g, '');
  const regex = new RegExp(`id="post-${dateCompact}-(\\d+)"`, 'g');
  let maxNum = 0;
  let match;
  while ((match = regex.exec(html)) !== null) {
    maxNum = Math.max(maxNum, parseInt(match[1], 10));
  }
  return `post-${dateCompact}-${maxNum + 1}`;
}

// Generate article HTML based on type
async function generateArticleHtml(data, existingId = null, dryRun = false) {
  let { type, url, title, description, body, date } = data;
  if (type === 'embed') {
    const recovered = urlFromPastedEmbed(body);
    if (recovered) {
      console.log('Pasted embed code detected, using static path for', recovered);
      type = 'link';
      url = recovered;
      body = '';
    }
  }
  const html = fs.readFileSync(TIDBITS_PATH, 'utf-8');
  const postId = existingId || generatePostId(date, html);

  let contentHtml = '';

  if (type === 'link') {
    // Check if URL is embeddable (YouTube, TikTok, X, Instagram)
    const videoEmbed = getVideoEmbed(url);

    if (videoEmbed) {
      // TikTok: fetch thumbnail via oEmbed
      if (videoEmbed.platform === 'tiktok') {
        try {
          console.log('Fetching TikTok oEmbed data...');
          const oembed = await fetchOEmbed(url, 'tiktok');
          const thumbFilename = `tiktok-${videoEmbed.videoId}.jpg`;
          const thumbPath = path.join(PREVIEWS_DIR, thumbFilename);
          const thumbUrl = `images/previews/${thumbFilename}`;

          // A preview must not litter images/previews/ — it still renders the
          // local path the real save would write, just without creating it.
          if (!dryRun) {
            console.log('Downloading thumbnail...');
            await downloadImage(oembed.thumbnail_url, thumbPath);
            console.log('Thumbnail saved to', thumbPath);
          }

          contentHtml = `
          ${title ? `<p class="post__embed-caption">${escapeHtml(title)}</p>` : ''}
          <a href="${url}" target="_blank" rel="noopener" class="post__embed-preview">
            <img src="${thumbUrl}" alt="${escapeHtml(title || oembed.title)}" loading="lazy">
            <span class="post__embed-play"></span>
          </a>
          <span class="post__embed-source">tiktok.com</span>${description ? `
          <p class="post__embed-caption">${escapeHtml(description)}</p>` : ''}`;

          return `
      <article class="post post--embed" id="${postId}">
        <div class="post__content">${contentHtml}
        </div>
        <footer class="post__meta">
          <time datetime="${date}">${date}</time>
        </footer>
      </article>`;
        } catch (err) {
          console.error('TikTok oEmbed failed, falling back to link:', err.message);
        }
      }

      // Twitter/X: fetch full embed HTML via oEmbed, wrap in expandable details
      if (videoEmbed.platform === 'twitter') {
        try {
          console.log('Fetching Twitter oEmbed data...');
          const oembed = await fetchOEmbed(url, 'twitter');

          return `
      <article class="post post--embed post--tweet" id="${postId}">
        ${title ? `<p class="post__embed-caption">${escapeHtml(title)}</p>` : ''}
        <details class="post__tweet-details">
          <summary>
            ${oembed.html.trim()}
            <span class="post__tweet-expand">Show more</span>
          </summary>
        </details>
        <span class="post__embed-source">x.com</span>${description ? `
        <p class="post__embed-caption">${escapeHtml(description)}</p>` : ''}
        <footer class="post__meta">
          <time datetime="${date}">${date}</time>
        </footer>
      </article>`;
        } catch (err) {
          console.error('Twitter oEmbed failed, falling back to link:', err.message);
        }
      }

      // YouTube, X, Instagram: use iframe/embed
      if (videoEmbed.embed) {
        const domain = extractDomain(url);
        contentHtml = `
          ${title ? `<p class="post__embed-caption">${escapeHtml(title)}</p>` : ''}
          <div class="${videoEmbed.containerClass}">
            ${videoEmbed.embed}
          </div>
          <span class="post__embed-source">${domain}</span>${description ? `
          <p class="post__embed-caption">${escapeHtml(description)}</p>` : ''}`;

        return `
      <article class="post post--embed" id="${postId}">
        <div class="post__content">${contentHtml}
        </div>
        <footer class="post__meta">
          <time datetime="${date}">${date}</time>
        </footer>
      </article>`;
      }
    }

    // Regular link post
    const domain = extractDomain(url);
    contentHtml = `
          <a href="${url}" class="post__link-card">
            <span class="post__link-title">${escapeHtml(title)}</span>
          </a>${description ? `
          <p class="post__link-commentary">${escapeHtml(description)}</p>` : ''}
          <span class="post__link-domain">${domain}</span>`;
  } else if (type === 'embed') {
    // Check if URL provided, auto-generate embed code
    let embedCode = body;
    let containerClass = 'post__embed-container';

    if (url && !body) {
      const videoEmbed = getVideoEmbed(url);
      if (videoEmbed) {
        embedCode = videoEmbed.embed;
        if (videoEmbed.platform === 'tiktok') {
          containerClass = 'post__embed-container post__embed-container--tiktok';
        }
      }
    } else if (body && body.includes('tiktok-embed')) {
      containerClass = 'post__embed-container post__embed-container--tiktok';
    }

    contentHtml = `
          ${title ? `<p class="post__embed-caption">${escapeHtml(title)}</p>` : ''}
          <div class="${containerClass}">
            ${embedCode}
          </div>${description ? `
          <p class="post__embed-caption">${escapeHtml(description)}</p>` : ''}`;
  } else if (type === 'text') {
    contentHtml = `
          <p>${escapeHtml(body)}</p>`;
  } else if (type === 'quote') {
    contentHtml = `
        <figure class="post__content">
          <blockquote>
            <p>${escapeHtml(body)}</p>
          </blockquote>
          <figcaption>
            <cite><a href="${url}">${escapeHtml(title)}</a></cite>
          </figcaption>
        </figure>`;

    return `
      <article class="post post--quote" id="${postId}">
        <div class="post__pattern"></div>${contentHtml}
        <footer class="post__meta">
          <time datetime="${date}">${date}</time>
        </footer>
      </article>`;
  }

  const postClass = type === 'embed' ? 'post--embed' : type === 'text' ? 'post--text' : 'post--link';
  const patternDiv = type === 'embed' ? '' : '\n        <div class="post__pattern"></div>';

  return `
      <article class="post ${postClass}" id="${postId}">${patternDiv}
        <div class="post__content">${contentHtml}
        </div>
        <footer class="post__meta">
          <time datetime="${date}">${date}</time>
        </footer>
      </article>`;
}

// Strip the file's base indentation so a preview reads flush-left without
// distorting the relative structure of what will actually be written.
function dedent(text) {
  const lines = text.replace(/^\n+|\s+$/g, '').split('\n');
  const indents = lines.filter(l => l.trim()).map(l => l.match(/^ */)[0].length);
  const base = Math.min(...indents);
  return lines.map(l => l.slice(base)).join('\n');
}

// Escape HTML entities
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Insert article into tidbits.html
function insertTidbit(articleHtml, date) {
  let html = fs.readFileSync(TIDBITS_PATH, 'utf-8');
  const year = date.substring(0, 4);
  const article = articleHtml.trim();

  const yearSectionRegex = new RegExp(`<section class="posts-year" aria-labelledby="year-${year}">`);

  if (yearSectionRegex.test(html)) {
    const sectionStart = html.search(yearSectionRegex);
    const sectionEnd = html.indexOf('</section>', sectionStart);
    const section = html.slice(sectionStart, sectionEnd);

    // Posts run newest-first, so sit above the first post older than this one.
    // Prepending unconditionally only looks right when every post is same-day
    // or newer, which stops being true the moment one is back-dated.
    const articleRe = new RegExp(
      `<article class="post ${POST_CLASS_RE}" id="post-\\d{8}-\\d+">[\\s\\S]*?<\\/article>`,
      'g'
    );
    let match, insertAt = null;
    while ((match = articleRe.exec(section)) !== null) {
      const when = match[0].match(/<time datetime="([^"]+)">/);
      if (when && when[1] < date) {
        insertAt = sectionStart + match.index;
        break;
      }
    }

    if (insertAt === null) {
      // Older than everything already in the year — goes last.
      const head = html.slice(0, sectionEnd).replace(/\s*$/, '');
      html = head + '\n\n      ' + article + '\n    ' + html.slice(sectionEnd);
    } else {
      html = html.slice(0, insertAt) + article + '\n\n      ' + html.slice(insertAt);
    }
  } else {
    const newSection = `
    <!-- ${year} -->
    <section class="posts-year" aria-labelledby="year-${year}">
      <h2 id="year-${year}" class="posts-year__heading">${year}</h2>
      ${article}
    </section>
`;
    // Year sections are newest-first too; land above the first older year, or
    // after the last section when this is the oldest year on the page.
    const years = [...html.matchAll(/\n    <!-- (\d{4}) -->/g)];
    const older = years.find(m => m[1] < year);
    if (older) {
      html = html.slice(0, older.index) + newSection.replace(/\n$/, '') + html.slice(older.index);
    } else if (years.length) {
      const lastEnd = html.lastIndexOf('</section>') + '</section>'.length;
      html = html.slice(0, lastEnd) + '\n' + newSection.replace(/\n$/, '') + html.slice(lastEnd);
    }
  }

  fs.writeFileSync(TIDBITS_PATH, html);
  return true;
}

// Update existing tidbit by ID
function updateTidbit(postId, articleHtml) {
  let html = fs.readFileSync(TIDBITS_PATH, 'utf-8');

  // Find and replace the existing article
  const articleRegex = new RegExp(
    `<article class="post ${POST_CLASS_RE}" id="${postId}">[\\s\\S]*?<\\/article>`
  );

  if (articleRegex.test(html)) {
    html = html.replace(articleRegex, articleHtml.trim());
    fs.writeFileSync(TIDBITS_PATH, html);
    return true;
  }
  return false;
}

// Delete tidbit by ID
function deleteTidbit(postId) {
  let html = fs.readFileSync(TIDBITS_PATH, 'utf-8');

  const articleRegex = new RegExp(
    `\\s*<article class="post ${POST_CLASS_RE}" id="${postId}">[\\s\\S]*?<\\/article>`
  );

  if (articleRegex.test(html)) {
    html = html.replace(articleRegex, '');
    fs.writeFileSync(TIDBITS_PATH, html);
    return true;
  }
  return false;
}

// Serve HTML form
function serveForm(res) {
  const today = new Date().toISOString().split('T')[0];

  const formHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tidbits Manager</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 700px;
      margin: 2rem auto;
      padding: 1rem;
      background: #e8eff8;
      color: #2a3f55;
    }
    h1 { margin-bottom: 0.5rem; color: #1a2f45; }
    .subtitle { color: #5a7a9a; margin-bottom: 1.5rem; }
    label {
      display: block;
      margin-top: 1rem;
      margin-bottom: 0.25rem;
      font-weight: 500;
      color: #3a5a7a;
    }
    input, textarea, select {
      width: 100%;
      padding: 0.75rem;
      border: 1px solid #b8ccdf;
      border-radius: 4px;
      font-size: 1rem;
      background: #f5f8fc;
      color: #2a3f55;
    }
    input:focus, textarea:focus, select:focus {
      outline: none;
      border-color: #7a9fc0;
    }
    textarea { min-height: 100px; resize: vertical; font-family: monospace; }
    .btn {
      margin-top: 1.5rem;
      padding: 0.75rem 1.5rem;
      background: #4a7eb8;
      color: white;
      border: none;
      border-radius: 4px;
      font-size: 1rem;
      cursor: pointer;
    }
    .btn:hover { background: #3a6ea8; }
    .btn-delete {
      background: #3a5570;
      margin-left: 0.5rem;
    }
    .btn-delete:hover { background: #2a4560; }
    .btn-new {
      background: #5a9ac0;
    }
    .btn-new:hover { background: #4a8ab0; }
    .field-group { margin-bottom: 0.5rem; }
    .hint { font-size: 0.85rem; color: #6a8aaa; margin-top: 0.25rem; }
    .hidden { display: none; }
    .mode-toggle {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
    }
    .mode-btn {
      padding: 0.5rem 1rem;
      background: #d0dcea;
      border: 1px solid #b8ccdf;
      color: #3a5a7a;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.9rem;
    }
    .mode-btn.active {
      background: #4a7eb8;
      border-color: #4a7eb8;
      color: white;
    }
    .mode-btn:hover:not(.active) {
      background: #c0d0e2;
    }
    #editSelector {
      margin-bottom: 1rem;
      padding: 1rem;
      background: #d8e4f0;
      border-radius: 4px;
    }
    #editSelector select {
      margin-top: 0.5rem;
    }
    .tidbit-option {
      padding: 0.25rem 0;
    }
    .actions {
      display: flex;
      gap: 0.5rem;
      margin-top: 1.5rem;
    }
    #preview {
      margin-top: 1.5rem;
      padding: 1rem;
      background: #f5f8fc;
      border: 1px solid #b8ccdf;
      border-radius: 4px;
    }
    #preview h3 { margin-top: 0; color: #5a7a9a; font-size: 0.9rem; }
    #preview-content { font-family: monospace; font-size: 0.85rem; white-space: pre-wrap; color: #3a6ea8; }
  </style>
</head>
<body>
  <h1>Tidbits Manager</h1>
  <p class="subtitle">Add new or edit existing tidbits</p>

  <div class="mode-toggle">
    <button type="button" class="mode-btn active" data-mode="add">+ Add New</button>
    <button type="button" class="mode-btn" data-mode="edit">Edit Existing</button>
  </div>

  <div id="editSelector" class="hidden">
    <label for="tidbitSelect">Select tidbit to edit:</label>
    <select id="tidbitSelect">
      <option value="">-- Loading tidbits --</option>
    </select>
  </div>

  <form id="tidbitForm">
    <input type="hidden" name="editId" id="editId" value="">

    <div class="field-group">
      <label for="type">Type</label>
      <select name="type" id="type" required>
        <option value="link">Link</option>
        <option value="embed">Embed (iframe, video, etc.)</option>
        <option value="text">Text</option>
        <option value="quote">Quote</option>
      </select>
    </div>

    <div class="field-group" id="urlGroup">
      <label for="url">URL</label>
      <input type="url" name="url" id="url" placeholder="https://example.com/article">
    </div>

    <div class="field-group" id="titleGroup">
      <label for="title">Title</label>
      <input type="text" name="title" id="title" placeholder="Article title">
    </div>

    <div class="field-group" id="descGroup">
      <label for="description">Description <span style="color:#666">(optional)</span></label>
      <input type="text" name="description" id="description" placeholder="Brief commentary">
    </div>

    <div class="field-group hidden" id="bodyGroup">
      <label for="body">Body / Embed Code</label>
      <textarea name="body" id="body" placeholder="Paste iframe code or write text..."></textarea>
      <p class="hint">For embeds: paste the full iframe/embed code. For text/quote: write the content.</p>
    </div>

    <div class="field-group">
      <label for="date">Date</label>
      <input type="date" name="date" id="date" value="${today}" required>
    </div>

    <div class="actions">
      <button type="submit" class="btn" id="submitBtn">Add Tidbit</button>
      <button type="button" class="btn btn-delete hidden" id="deleteBtn">Delete</button>
      <button type="button" class="btn btn-new hidden" id="newBtn">+ New Tidbit</button>
    </div>
  </form>

  <div id="preview">
    <h3>Preview</h3>
    <pre id="preview-content"></pre>
  </div>

  <script>
    const form = document.getElementById('tidbitForm');
    const typeSelect = document.getElementById('type');
    const urlGroup = document.getElementById('urlGroup');
    const titleGroup = document.getElementById('titleGroup');
    const descGroup = document.getElementById('descGroup');
    const bodyGroup = document.getElementById('bodyGroup');
    const previewContent = document.getElementById('preview-content');
    const editSelector = document.getElementById('editSelector');
    const tidbitSelect = document.getElementById('tidbitSelect');
    const editIdInput = document.getElementById('editId');
    const submitBtn = document.getElementById('submitBtn');
    const deleteBtn = document.getElementById('deleteBtn');
    const newBtn = document.getElementById('newBtn');
    const modeBtns = document.querySelectorAll('.mode-btn');

    let tidbits = [];
    let currentMode = 'add';

    // Load tidbits on start
    async function loadTidbits() {
      const response = await fetch('/tidbits');
      tidbits = await response.json();
      populateTidbitSelect();
    }

    function populateTidbitSelect() {
      tidbitSelect.innerHTML = '<option value="">-- Select a tidbit --</option>';
      tidbits.forEach(t => {
        const label = t.title || t.body?.substring(0, 50) || t.id;
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = '[' + t.date + '] ' + label;
        tidbitSelect.appendChild(opt);
      });
    }

    function setMode(mode) {
      currentMode = mode;
      modeBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
      });

      if (mode === 'edit') {
        editSelector.classList.remove('hidden');
        deleteBtn.classList.remove('hidden');
        newBtn.classList.remove('hidden');
        submitBtn.textContent = 'Update Tidbit';
      } else {
        editSelector.classList.add('hidden');
        deleteBtn.classList.add('hidden');
        newBtn.classList.add('hidden');
        submitBtn.textContent = 'Add Tidbit';
        resetForm();
      }
    }

    function resetForm() {
      form.reset();
      editIdInput.value = '';
      document.getElementById('date').value = '${today}';
      tidbitSelect.value = '';
      updateFieldVisibility();
      updatePreview();
    }

    function loadTidbitIntoForm(tidbit) {
      editIdInput.value = tidbit.id;
      typeSelect.value = tidbit.type;
      document.getElementById('url').value = tidbit.url || '';
      document.getElementById('title').value = tidbit.title || '';
      document.getElementById('description').value = tidbit.description || '';
      document.getElementById('body').value = tidbit.body || '';
      document.getElementById('date').value = tidbit.date || '';
      updateFieldVisibility();
      updatePreview();
    }

    modeBtns.forEach(btn => {
      btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });

    tidbitSelect.addEventListener('change', () => {
      const selected = tidbits.find(t => t.id === tidbitSelect.value);
      if (selected) {
        loadTidbitIntoForm(selected);
      }
    });

    newBtn.addEventListener('click', () => {
      setMode('add');
    });

    deleteBtn.addEventListener('click', async () => {
      const id = editIdInput.value;
      if (!id) return alert('No tidbit selected');
      if (!confirm('Delete this tidbit permanently?')) return;

      const response = await fetch('/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      const result = await response.json();
      if (result.success) {
        alert('Tidbit deleted!');
        await loadTidbits();
        resetForm();
      } else {
        alert('Error: ' + result.error);
      }
    });

    function updateFieldVisibility() {
      const type = typeSelect.value;
      urlGroup.classList.toggle('hidden', type === 'text');
      titleGroup.classList.toggle('hidden', type === 'text');
      bodyGroup.classList.toggle('hidden', type === 'link');
      descGroup.classList.toggle('hidden', type === 'text' || type === 'quote');

      // Update URL label for embed type
      const urlLabel = urlGroup.querySelector('label');
      if (type === 'embed') {
        urlLabel.textContent = 'Video URL (YouTube/TikTok)';
        document.getElementById('url').placeholder = 'Paste YouTube or TikTok URL - embed code auto-generates';
      } else {
        urlLabel.textContent = 'URL';
        document.getElementById('url').placeholder = 'https://example.com/article';
      }
    }

    // Auto-detect video URL and generate embed
    document.getElementById('url').addEventListener('input', async (e) => {
      if (typeSelect.value !== 'embed') return;
      const url = e.target.value;
      if (!url) return;

      // Check for YouTube
      const ytMatch = url.match(/(?:youtube\\.com\\/watch\\?v=|youtu\\.be\\/|youtube\\.com\\/embed\\/)([a-zA-Z0-9_-]{11})/);
      if (ytMatch) {
        document.getElementById('body').value = \`<iframe width="560" height="315" src="https://www.youtube.com/embed/\${ytMatch[1]}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>\`;
        updatePreview();
        return;
      }

      // Check for TikTok
      const ttMatch = url.match(/tiktok\\.com\\/@([^/]+)\\/video\\/(\\d+)/);
      if (ttMatch) {
        const username = ttMatch[1];
        const videoId = ttMatch[2];
        document.getElementById('body').value = \`<blockquote class="tiktok-embed" cite="https://www.tiktok.com/@\${username}/video/\${videoId}" data-video-id="\${videoId}" style="max-width:605px;min-width:325px;"><section></section></blockquote>\`;
        updatePreview();
      }
    });

    typeSelect.addEventListener('change', updateFieldVisibility);
    updateFieldVisibility();

    let previewTimer = null;
    let previewSeq = 0;

    function updatePreview() {
      const payload = Object.fromEntries(new FormData(form));
      const ready = payload.type === 'link'
        ? Boolean(payload.url && payload.title)
        : Boolean(payload.body);

      if (!ready) {
        clearTimeout(previewTimer);
        previewSeq++;
        previewContent.textContent = '(fill in fields to see preview)';
        return;
      }

      // Ask the server to render it, so the preview is the real generator
      // output — auto-embeds included — rather than a guess that drifts.
      clearTimeout(previewTimer);
      previewTimer = setTimeout(async () => {
        const seq = ++previewSeq;
        try {
          const res = await fetch('/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const result = await res.json();
          if (seq !== previewSeq) return; // superseded by a newer keystroke
          previewContent.textContent = result.success
            ? result.html
            : 'Preview unavailable: ' + result.error;
        } catch (err) {
          if (seq !== previewSeq) return;
          previewContent.textContent = 'Preview unavailable: ' + err.message;
        }
      }, 400);
    }

    form.addEventListener('input', updatePreview);
    updatePreview();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = new FormData(form);
      const payload = Object.fromEntries(data);
      const isEdit = currentMode === 'edit' && payload.editId;

      const endpoint = isEdit ? '/update' : '/add';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (result.success) {
        alert(isEdit ? 'Tidbit updated!' : 'Tidbit added!');
        await loadTidbits();
        if (!isEdit) resetForm();
      } else {
        alert('Error: ' + result.error);
      }
    });

    // Init
    loadTidbits();
  </script>
</body>
</html>`;

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(formHtml);
}

// Create server
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    serveForm(res);
  } else if (req.method === 'GET' && req.url === '/tidbits') {
    // Return all tidbits as JSON
    const tidbits = parseTidbits();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tidbits));
  } else if (req.method === 'POST' && req.url === '/preview') {
    // Same generator as /add and /update, side effects suppressed — so the
    // preview cannot drift from what actually gets written.
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const articleHtml = await generateArticleHtml(data, data.editId || null, true);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, html: dedent(articleHtml) }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  } else if (req.method === 'POST' && req.url === '/add') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        console.log('\n--- ADD REQUEST ---');
        console.log('Type:', data.type);
        console.log('URL:', data.url);
        const videoEmbed = getVideoEmbed(data.url);
        console.log('Video embed detected:', videoEmbed ? videoEmbed.platform : 'none');
        const articleHtml = await generateArticleHtml(data);
        console.log('Generated HTML starts with:', articleHtml.substring(0, 100));
        insertTidbit(articleHtml, data.date);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        console.error('Error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  } else if (req.method === 'POST' && req.url === '/update') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        console.log('\n--- UPDATE REQUEST ---');
        console.log('Type:', data.type);
        console.log('URL:', data.url);
        console.log('Edit ID:', data.editId);
        const articleHtml = await generateArticleHtml(data, data.editId);
        console.log('Generated HTML starts with:', articleHtml.substring(0, 100));
        const success = updateTidbit(data.editId, articleHtml);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success }));
      } catch (err) {
        console.error('Error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  } else if (req.method === 'POST' && req.url === '/delete') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const success = deleteTidbit(data.id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n  Tidbits Manager running at http://localhost:${PORT}\n`);
  console.log(`  This will edit: ${TIDBITS_PATH}\n`);
});
