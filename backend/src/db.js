import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import dotenv from 'dotenv';
dotenv.config();

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[db] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — DB calls will fail.');
}

// Node 20 doesn't have a native WebSocket global, which the Supabase client's
// realtime module expects. We don't use realtime features in this app, but
// the client initializes it anyway, so we hand it the "ws" package instead.
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { transport: ws } }
);
