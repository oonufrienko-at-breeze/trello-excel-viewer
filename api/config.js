// Vercel Serverless Function — returns Trello Power-Up public config
// Exposes ONLY the Trello app key (which is public by design in Trello Power-Ups)
// but keeps it out of committed client-side code so GitHub secret scanner stays quiet.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, max-age=300');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const appKey = process.env.TRELLO_APP_KEY || '';
  if (!appKey) {
    return res.status(500).json({ error: 'TRELLO_APP_KEY env not configured' });
  }

  return res.status(200).json({
    appKey,
    appName: 'Excel Preview'
  });
}
