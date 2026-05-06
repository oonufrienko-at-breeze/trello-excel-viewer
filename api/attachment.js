// Vercel Serverless Function — Fetch Trello attachment by cardId + attachmentId
// Calls Trello REST API server-side to get fresh URL, then proxies the binary.
// This avoids:
//   1. CORS issues calling api.trello.com from GitHub Pages
//   2. Corrupted/truncated URLs passed through Power-Up modal args
//
// Fallback chain when token is missing or lacks `read` scope:
//   1. Try metadata + signed URL via Trello API (best UX, freshest URL)
//   2. If that returns 401 (no/invalid token, missing scopes) AND the
//      caller passed a fallbackUrl param (the original att.url from
//      the Power-Up client), download that URL directly using only the
//      app key — works for any attachment whose direct URL is reachable.

const TRELLO_API_KEY = process.env.TRELLO_API_KEY || process.env.TRELLO_APP_KEY || '';

// Hobby plan caps serverless functions at 10s — we need internal timeouts below that
const META_TIMEOUT_MS = 6000;
const DOWNLOAD_TIMEOUT_MS = 7000;

const ALLOWED_DOMAINS = [
  'trello.com',
  'api.trello.com',
  'trello-attachments.s3.amazonaws.com',
  'trello-backgrounds.s3.amazonaws.com',
];

function fetchWithTimeout(url, options = {}, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  return fetch(url, { ...options, signal: ctl.signal })
    .finally(() => clearTimeout(timer));
}

function isTrelloUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return ALLOWED_DOMAINS.some(
      (d) => u.hostname === d || u.hostname.endsWith('.' + d)
    );
  } catch (e) {
    return false;
  }
}

// Stream the upstream response back to the client.
async function streamFile(fileResp, res) {
  const contentType = fileResp.headers.get('content-type') ||
                      'application/octet-stream';
  res.setHeader('Content-Type', contentType);

  const disposition = fileResp.headers.get('content-disposition');
  if (disposition) res.setHeader('Content-Disposition', disposition);

  const buffer = await fileResp.arrayBuffer();
  res.setHeader('Content-Length', buffer.byteLength);
  res.setHeader('Cache-Control', 'private, max-age=300');

  return res.send(Buffer.from(buffer));
}

// Download a Trello attachment URL directly (no metadata round-trip).
// Used when token+scopes are missing — we don't need to call api.trello.com
// at all because the original att.url was already passed to us.
async function downloadDirect(attUrl, token, res) {
  const headers = { 'User-Agent': 'TrelloExcelPreview/1.0' };
  if (token && TRELLO_API_KEY) {
    headers['Authorization'] =
      `OAuth oauth_consumer_key="${TRELLO_API_KEY}", oauth_token="${token}"`;
  }

  let fileResp;
  try {
    fileResp = await fetchWithTimeout(
      attUrl,
      { headers, redirect: 'follow' },
      DOWNLOAD_TIMEOUT_MS
    );
  } catch (e) {
    return res.status(504).json({
      error: `Direct download timed out (${DOWNLOAD_TIMEOUT_MS}ms)`,
      details: e.message,
      stage: 'direct-download-timeout'
    });
  }

  if (!fileResp.ok) {
    const errBody = await fileResp.text().catch(() => '');
    return res.status(fileResp.status).json({
      error: `Direct download failed: ${fileResp.status} ${fileResp.statusText}`,
      details: errBody.slice(0, 300),
      stage: 'direct-download'
    });
  }

  return streamFile(fileResp, res);
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const { cardId, attachmentId, token, fallbackUrl } = req.query;

  // If we have a direct attachment URL and no usable token, skip the
  // metadata round-trip entirely and just download the file. This is
  // the path that handles "missing scopes" gracefully — we never even
  // call api.trello.com so there's nothing to be unauthorized for.
  const haveFallback = fallbackUrl && isTrelloUrl(fallbackUrl);

  if (!cardId || !attachmentId) {
    if (haveFallback) {
      return downloadDirect(fallbackUrl, token, res);
    }
    return res.status(400).json({ error: 'Missing cardId or attachmentId parameter' });
  }

  // Validate IDs: MongoDB ObjectId format (24 hex chars)
  const idRegex = /^[a-f0-9]{24}$/i;
  if (!idRegex.test(cardId) || !idRegex.test(attachmentId)) {
    if (haveFallback) {
      return downloadDirect(fallbackUrl, token, res);
    }
    return res.status(400).json({
      error: 'Invalid ID format. Expected 24-char hex string.',
      cardId,
      attachmentId,
      cardIdLength: cardId.length,
      attachmentIdLength: attachmentId.length
    });
  }

  try {
    // Step 1: Call Trello API to get the fresh attachment URL
    const metaUrl = `https://api.trello.com/1/cards/${cardId}/attachments/${attachmentId}` +
                    `?key=${TRELLO_API_KEY}` +
                    (token ? `&token=${encodeURIComponent(token)}` : '');

    let metaResp;
    try {
      metaResp = await fetchWithTimeout(metaUrl, {
        headers: { 'User-Agent': 'TrelloExcelPreview/1.0' }
      }, META_TIMEOUT_MS);
    } catch (e) {
      // Network/timeout — try direct download as fallback
      if (haveFallback) {
        return downloadDirect(fallbackUrl, token, res);
      }
      return res.status(504).json({
        error: `Trello API metadata request timed out (${META_TIMEOUT_MS}ms)`,
        details: e.message,
        stage: 'metadata-timeout'
      });
    }

    if (!metaResp.ok) {
      // Most common case: 401 "missing scopes" because user hasn't granted
      // the Power-Up read access (or the in-iframe authorize flow was
      // blocked by the browser). When that happens we still have the
      // original att.url from the Power-Up client, so just download it
      // directly without going through api.trello.com at all.
      const errBody = await metaResp.text().catch(() => '');
      const isAuthFail = metaResp.status === 401 || metaResp.status === 403;

      if (isAuthFail && haveFallback) {
        return downloadDirect(fallbackUrl, token, res);
      }

      return res.status(metaResp.status).json({
        error: `Trello API error: ${metaResp.status} ${metaResp.statusText}`,
        details: errBody.slice(0, 500),
        stage: 'metadata',
        hint: isAuthFail
          ? 'Power-Up token missing or lacks read scope; pass fallbackUrl=<att.url> to bypass.'
          : undefined
      });
    }

    const meta = await metaResp.json();

    if (!meta.url) {
      return res.status(500).json({
        error: 'Attachment has no URL',
        meta: { id: meta.id, name: meta.name }
      });
    }

    // Step 2: Download the binary with OAuth auth
    const headers = {
      'User-Agent': 'TrelloExcelPreview/1.0'
    };
    if (token) {
      headers['Authorization'] =
        `OAuth oauth_consumer_key="${TRELLO_API_KEY}", oauth_token="${token}"`;
    }

    let fileResp;
    try {
      fileResp = await fetchWithTimeout(meta.url, { headers, redirect: 'follow' }, DOWNLOAD_TIMEOUT_MS);
    } catch (e) {
      return res.status(504).json({
        error: `File download timed out (${DOWNLOAD_TIMEOUT_MS}ms)`,
        details: e.message,
        attachmentUrl: meta.url,
        fileName: meta.name,
        fileBytes: meta.bytes,
        stage: 'download-timeout'
      });
    }

    if (!fileResp.ok) {
      // Last-chance fallback: maybe the OAuth header on the S3 redirect
      // is what's failing; retry once without auth headers.
      if ((fileResp.status === 401 || fileResp.status === 403) && haveFallback) {
        return downloadDirect(fallbackUrl, '', res);
      }
      return res.status(fileResp.status).json({
        error: `File download failed: ${fileResp.status} ${fileResp.statusText}`,
        attachmentUrl: meta.url,
        stage: 'download'
      });
    }

    return streamFile(fileResp, res);
  } catch (error) {
    console.error('attachment proxy error:', error);
    return res.status(500).json({
      error: 'Internal error: ' + error.message,
      name: error.name,
      stack: (error.stack || '').split('\n').slice(0, 5).join('\n')
    });
  }
}
