interface Env {
  KV_POLLS: KVNamespace;
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
      const metadataStr = await env.KV_POLLS.get('metadata');
      metadata = metadataStr ? JSON.parse(metadataStr) as Metadata : null;
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Metadata fetch failed: ' + (e as Error).message }), { status: 500 });
    }

    // Reset data if question or options changed
    if (!metadata || metadata.question_hash !== questionHash || metadata.options_hash !== optionsHash) {
      try {
        // List all keys and delete votes (KV prefix 'votes:')
        const voteKeys = await env.KV_POLLS.list({ prefix: 'votes:' });
        const deletePromises = voteKeys.keys.map(key => env.KV_POLLS.delete(key.name));
        await Promise.all(deletePromises);
        await env.KV_POLLS.put('metadata', JSON.stringify({ question_hash: questionHash, options_hash: optionsHash }));
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
      let existingVote: string | null;
      try {
        existingVote = await env.KV_POLLS.get(`votes:${fingerprint}`);
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Vote check failed: ' + (e as Error).message }), { status: 500 });
      }
      if (existingVote) {
        return new Response(JSON.stringify({ error: 'You have already voted' }), { status: 400 });
      }

      // Record vote
      try {
        await env.KV_POLLS.put(`votes:${fingerprint}`, vote);
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Vote recording failed: ' + (e as Error).message }), { status: 500 });
      }

      // Get results
      let results: VoteResult = {};
      options.forEach(opt => (results[opt] = 0));
      try {
        const voteKeys = await env.KV_POLLS.list({ prefix: 'votes:' });
        voteKeys.keys.forEach(key => {
          const voteValue = key.name.split(':')[1];
          if (options.includes(voteValue)) {
            results[voteValue] = (results[voteValue] || 0) + 1;
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