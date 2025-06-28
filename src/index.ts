export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Initialize D1 database schema
    await env.DB.exec(`
      CREATE TABLE IF NOT EXISTS votes (
        fingerprint TEXT PRIMARY KEY,
        vote TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS poll_metadata (
        id INTEGER PRIMARY KEY,
        question_hash TEXT,
        options_hash TEXT
      );
    `);

    // Read question.txt and options.txt from iil.pages.dev
    const questionResp = await fetch('https://iil.pages.dev/question.txt');
    const optionsResp = await fetch('https://iil.pages.dev/options.txt');
    if (!questionResp.ok || !optionsResp.ok) {
      return new Response(JSON.stringify({ error: 'Failed to fetch poll data' }), { status: 500 });
    }
    const question = await questionResp.text();
    const options = (await optionsResp.text()).split('\n').filter(opt => opt.trim());

    // Generate hashes for change detection
    const questionHash = await hash(question);
    const optionsHash = await hash(options.join('\n'));
    const metadata = await env.DB.prepare('SELECT * FROM poll_metadata WHERE id = 1').first();

    // Reset data if question or options changed
    if (!metadata || metadata.question_hash !== questionHash || metadata.options_hash !== optionsHash) {
      await env.DB.exec('DELETE FROM votes; DELETE FROM poll_metadata;');
      await env.DB.prepare('INSERT INTO poll_metadata (id, question_hash, options_hash) VALUES (1, ?, ?)')
        .bind(questionHash, optionsHash)
        .run();
    }

    // Handle poll data request
    if (url.pathname === '/poll' && request.method === 'GET') {
      return new Response(JSON.stringify({ question, options }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Handle vote submission
    if (url.pathname === '/vote' && request.method === 'POST') {
      const { fingerprint, vote } = await request.json();
      if (!fingerprint || !vote || !options.includes(vote)) {
        return new Response(JSON.stringify({ error: 'Invalid vote or fingerprint' }), { status: 400 });
      }

      // Check if fingerprint already voted
      const existingVote = await env.DB.prepare('SELECT vote FROM votes WHERE fingerprint = ?')
        .bind(fingerprint)
        .first();
      if (existingVote) {
        return new Response(JSON.stringify({ error: 'You have already voted' }), { status: 400 });
      }

      // Record vote
      await env.DB.prepare('INSERT INTO votes (fingerprint, vote) VALUES (?, ?)')
        .bind(fingerprint, vote)
        .run();

      // Get results
      const results = {};
      options.forEach(opt => (results[opt] = 0));
      const voteCounts = await env.DB.prepare('SELECT vote, COUNT(*) as count FROM votes GROUP BY vote').all();
      voteCounts.results.forEach(row => {
        if (options.includes(row.vote)) {
          results[row.vote] = row.count;
        }
      });

      return new Response(JSON.stringify({ results }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
};

// Simple hash function for change detection
async function hash(str) {
  const msgBuffer = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}