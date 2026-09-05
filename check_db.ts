import * as fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const envText = fs.readFileSync('.env.local', 'utf-8');
const env = envText.split('\n').reduce((acc, line) => {
  const [k, ...v] = line.split('=');
  if(k) acc[k.trim()] = v.join('=').trim().replace(/^['"]|['"]$/g, '');
  return acc;
}, {} as Record<string, string>);

const s = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function checkFiles() {
  const r = await s.from('file_records')
    .select('*, connected_accounts(google_email)')
    .eq('user_id', '3c7c0702-569c-4283-a2e1-c549c2b66ec3')
    .eq('in_trash', false)
    .is('virtual_folder_id', null)
    .order('uploaded_at', { ascending: false });
  console.log('Returned rows:', r.data?.length);
  if (r.data && r.data.length > 0) {
    console.log(JSON.stringify(r.data.slice(0, 3), null, 2));
  } else {
    console.log('Error:', r.error);
  }
}

checkFiles();
