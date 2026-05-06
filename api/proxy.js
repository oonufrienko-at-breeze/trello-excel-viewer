// Vercel Serverless Function — Proxy for fetching Trello attachments
// Needed because Trello attachment URLs require authentication and have CORS restrictions
//
// Usage: GET /api/proxy?url=<trello_attachment_url>&token=<user_trello_token>
// The API key is stored server-side. The user token comes from t.getRestApi().getToken()

const TRELLO_API_KEY = process.env.TRELLO_API_KEY || process.env.TRELLO_APP_KEY || '';

export default async function handler(req, res) {
  // CORS headers — allow requests from GitHub Pages
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { url, token } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  // Validate URL — only allow Trello domains
  const allowedDomains = [
    'trello.com',
    'api.trello.com',
    'trello-attachments.s3.amazonaws.com',
    'trello-backgrounds.s3.amazonaws.com',
  ];

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const isAllowed = allowedDomains.some(
    (domain) =>
      parsedUrl.hostname === domain ||
      parsedUrl.hostname.endsWith('.' + domain)
  );

  if (!isAllowed) {
    return res.status(403).json({
      error: 'Domain not allowed. Only Trello attachment URLs are supported.',
    });
  }

  // Build headers for Trello API authentication. Only attach the OAuth
  // header for api.trello.com — for S3 attachment URLs the OAuth header
  // is rejected by AWS and breaks the request.
  const isApiTrello = parsedUrl.hostname === 'api.trello.com' ||
                      parsedUrl.hostname === 'trello.com';

  async function tryFetch(withAuth) {
    const headers = { 'User-Agent': 'TrelloExcelPreview/1.0' };
    if (withAuth && token && isApiTrello && TRELLO_API_KEY) {
      headers['Authorization'] =
        `OAuth oauth_consumer_key="${TRELLO_API_KEY}", oauth_token="${token}"`;
    }
    return fetch(url, { headers, redirect: 'follow' });
  }

  try {
    let response = await tryFetch(true);

    // If auth failed, retry once without the OAuth header — works for
    // public boards / direct S3 URLs where the header was the problem.
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      const retry = await tryFetch(false);
      if (retry.ok) response = retry;
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      return res.status(response.status).json({
        error: `Upstream error: ${response.status} ${response.statusText}`,
        details: errBody.slice(0, 300),
      });
    }

    // Forward content type
    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }

    // Forward content disposition if present
    const contentDisposition = response.headers.get('content-disposition');
    if (contentDisposition) {
      res.setHeader('Content-Disposition', contentDisposition);
    }

    // Stream the response
    const buffer = await response.arrayBuffer();
    res.setHeader('Content-Length', buffer.byteLength);
    res.setHeader('Cache-Control', 'private, max-age=300'); // Cache 5 min

    return res.send(Buffer.from(buffer));
  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ error: 'Failed to fetch file: ' + error.message });
  }
}
