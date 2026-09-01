import { createBrowserClient } from '@supabase/ssr';

const DEFAULT_SUPABASE_URL = 'https://ivqaappnkyhvqwsptjmk.supabase.co';
const DEFAULT_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2cWFhcHBua3lodnF3c3B0am1rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgxNzk1MTQsImV4cCI6MjEwMzc1NTUxNH0.rac3oYjgd7avophr7QNTvypOV_y7rifwfKiFb-upA4c';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || DEFAULT_ANON_KEY
  );
}
