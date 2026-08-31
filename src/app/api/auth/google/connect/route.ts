import { NextResponse } from 'next/server';
import { generateAuthUrl } from '@/lib/google-drive';

export async function GET() {
  try {
    const url = generateAuthUrl();
    return NextResponse.redirect(url);
  } catch (error) {
    console.error('Failed to generate auth URL:', error);
    return NextResponse.json({ error: 'OAuth initialization failed' }, { status: 500 });
  }
}
