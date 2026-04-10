import { graphql } from 'graphql';
import { typeDefs } from '@/services/github-follower-cache/graphql';
import { buildResolvers } from '@/services/github-follower-cache/resolvers';
import { CacheDatabase } from '@/services/github-follower-cache/db';

let db: CacheDatabase | null = null;

function getDb(): CacheDatabase {
  if (!db) {
    const url = process.env.POSTGRES_URL;
    if (!url) throw new Error('POSTGRES_URL not configured');
    db = new CacheDatabase(url);
  }
  return db;
}

async function handleGraphQL(request: Request): Promise<Response> {
  let query: string;
  let variables: Record<string, unknown> | undefined;
  let operationName: string | undefined;

  if (request.method === 'POST') {
    const body = await request.json();
    query = body.query;
    variables = body.variables;
    operationName = body.operationName;
  } else {
    const url = new URL(request.url);
    query = url.searchParams.get('query') ?? '';
    const vars = url.searchParams.get('variables');
    variables = vars ? JSON.parse(vars) : undefined;
    operationName = url.searchParams.get('operationName') ?? undefined;
  }

  if (!query) {
    return new Response(JSON.stringify({ errors: [{ message: 'Missing query' }] }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const database = getDb();
  const rootValue = buildResolvers(database);

  const result = await graphql({
    schema: typeDefs,
    source: query,
    rootValue,
    variableValues: variables,
    operationName,
  });

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
    },
  });
}

export const GET = handleGraphQL;
export const POST = handleGraphQL;
