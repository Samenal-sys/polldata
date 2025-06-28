interface Env {
  DB: D1Database;
}

interface PollData {
  question: string;
  options: string[];
}

interface VoteData {
  fingerprint: string;
  vote: string;
}

interface VoteResult {
  [option: string]: number;
}

interface Metadata {
  id: number;
  question_hash: string;
  options_hash: string;
}

async function hash(str: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Initialize D1 database schema with separate exec calls
    try {
      await env.DB.exec(`
        CREATE TABLE IF NOT EXISTS votes (
          fingerprint TEXT PRIMARY KEY,
          vote TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await env.DB.exec(`
        CREATE TABLE IF NOT EXISTS poll_metadata (
          id INTEGER PRIMARY KEY,
          question_hash TEXT,
          options_hash TEXT
        )
      `);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Database initialization failed: ' + (e as Error).message }), { status: 500 });
    }

    // Read question.txt and options.txt from iil.pages.dev
    let question: string, options: string[];
    try {
      const questionResp = await fetch('https://iil.pages.dev/question.txt');
      const optionsResp = await fetch('https://iil.pages.dev/options.txt');
      if (!questionResp.ok || !optionsResp.ok) {
        return new Response(JSON.stringify({ error: 'Failed to fetch poll data' }), { status: 500 });
      }
      question = await questionResp.text();
      options = (await optionsResp.text()).split('\n').filter(opt => opt.trim());
      if (options.length === 0) {
        return new Response(JSON.stringify({ error: 'No valid options found' }), { status: 400 });
      }
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Failed to fetch files: ' + (e as Error).message }), { status: 500 });
    }

    // Generate hashes for change detection
    const questionHash = await hash(question);
    const optionsHash = await hash(options.join('\n'));

    // Check for poll changes
    let metadata: Metadata | null;
    try {
      metadata = await env.DB.prepare('SELECT * FROM poll_metadata WHERE id = 1').first() as Metadata | null;
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Metadata query failed: ' + (e as Error).message }), { status: 500 });
    }

    // Reset data if question or options changed
    if (!metadata || metadata.question_hash !== questionHash || metadata.options_hash !== optionsHash) {
      try {
        await env.DB.exec('DELETE FROM votes');
        await env.DB.exec('DELETE FROM poll_metadata');
        await env.DB.prepare('INSERT INTO poll_metadata (id, question_hash, options_hash) VALUES (1, ?, ?)')
          .bind(questionHash, optionsHash)
          .run();
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Data reset failed: ' + (e as Error).message }), { status: 500 });
      }
    }

    // Handle poll data request
    if (url.pathname === '/poll' && request.method === 'GET') {
      const pollData: PollData = { question, options };
      return new Response(JSON.stringify(pollData), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Handle vote submission
    if (url.pathname === '/vote' && request.method === 'POST') {
      let voteData: VoteData;
      try {
        voteData = await request.json() as VoteData;
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
      }
      const { fingerprint, vote } = voteData;
      if (!fingerprint || !vote || !options.includes(vote)) {
        return new Response(JSON.stringify({ error: 'Invalid vote or fingerprint' }), { status: 400 });
      }

      // Check if fingerprint already voted
      let existingVote: { vote?: string } | null;
      try {
        existingVote = await env.DB.prepare('SELECT vote FROM votes WHERE fingerprint = ?')
          .bind(fingerprint)
          .first();
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Vote check failed: ' + (e as Error).message }), { status: 500 });
      }
      if (existingVote && existingVote.vote) {
        return new Response(JSON.stringify({ error: 'You have already voted' }), { status: 400 });
      }

      // Record vote
      try {
        await env.DB.prepare('INSERT INTO votes (fingerprint, vote) VALUES (?, ?)')
          .bind(fingerprint, vote)
          .run();
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Vote recording failed: ' + (e as Error).message }), { status: 500 });
      }

      // Get results
      let results: VoteResult = {};
      options.forEach(opt => (results[opt] = 0));
      try {
        const voteCounts = await env.DB.prepare('SELECT vote, COUNT(*) as count FROM votes GROUP BY vote').all();
        voteCounts.results.forEach((row: { vote: string; count: number }) => {
          if (options.includes(row.vote)) {
            results[row.vote] = row.count;
          }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Results fetch failed: ' + (e as Error).message }), { status: 500 });
      }

      return new Response(JSON.stringify({ results }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
};