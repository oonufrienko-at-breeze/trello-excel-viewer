// Vercel Serverless Function — Fetch Trello attachment by cardId + attachmentId
// Calls Trello REST API server-side to get fresh URL, then proxies the binary.
// This avoids:
//   1. CORS issues calling api.trello.com from GitHub Pages
//   2. Corrupted/truncated URLs passed through Power-Up modal args

const TRELLO_API_KEY = process.env.TRELLO_API_KEY || 'eaa6d0d7c57218139af1b772bbd777cb';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const { cardId, attachmentId, token } = req.query;

  if (!cardId || !attachmentId) {
    return res.status(400).json({ error: 'Missing cardId or attachmentId parameter' });
  }

  // Validate IDs: MongoDB ObjectId format (24 hex chars)
  const idRegex = /^[a-f0-9]{24}$/i;
  if (!idRegex.test(cardId) || !idRegex.test(attachmentId)) {
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

    const metaResp = await fetch(metaUrl, {
      headers: { 'User-Agent': 'TrelloExcelPreview/1.0' }
    });

    if (!metaResp.ok) {
      const errBody = await metaResp.text().catch(() => '');
      return res.status(metaResp.status).json({
        error: `Trello API error: ${metaResp.status} ${metaResp.statusText}`,
        details: errBody.slice(0, 500),
        stage: 'metadata'
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

    const fileResp = await fetch(meta.url, { headers, redirect: 'follow' });

    if (!fileResp.ok) {
      return res.status(fileResp.status).json({
        error: `File download failed: ${fileResp.status} ${fileResp.statusText}`,
        attachmentUrl: meta.url,
        stage: 'download'
      });
    }

    // Forward headers
    const contentType = fileResp.headers.get('content-type') ||
                        'application/octet-stream';
    res.setHeader('Content-Type', contentType);

    const disposition = fileResp.headers.get('content-disposition');
    if (disposition) res.setHeader('Content-Disposition', disposition);

    const buffer = await fileResp.arrayBuffer();
    res.setHeader('Content-Length', buffer.byteLength);
    res.setHeader('Cache-Control', 'private, max-age=300');

    return res.send(Buffer.from(buffer));
  } catch (error) {
    console.error('attachment proxy error:', error);
    return res.status(500).json({
      error: 'Internal error: ' + error.message,
      stack: (error.stack || '').split('\n').slice(0, 5).join('\n')
    });
  }
}
