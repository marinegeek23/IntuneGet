/**
 * Guards for API routes backed by tables that only exist in the Supabase schema.
 *
 * The sqlite adapter (self-hosted mode) creates exactly two tables:
 * packaging_jobs and upload_history. Everything else - user settings, update
 * policies, notifications, webhooks, community content, SCCM migrations, and
 * the whole MSP surface - has no sqlite equivalent, so those routes cannot be
 * made to work by swapping the client. What they can do is fail predictably:
 * a read returns an empty/default payload so the UI renders as "nothing here",
 * and a write reports plainly that the feature needs Supabase instead of
 * throwing an opaque 500 from createServerClient().
 */

import { NextResponse } from 'next/server';
import { isSupabaseConfigured } from '@/lib/supabase';

/**
 * Returns a response to send when the feature is unavailable, or null when
 * Supabase is configured and the caller should proceed normally.
 *
 * Pass `emptyResult` for read endpoints to degrade to a valid empty payload;
 * omit it for mutations, which get a 501 so the caller knows nothing was saved.
 */
export function supabaseOnlyGuard(
  feature: string,
  emptyResult?: unknown
): NextResponse | null {
  if (isSupabaseConfigured()) {
    return null;
  }

  if (emptyResult !== undefined) {
    return NextResponse.json(emptyResult);
  }

  return NextResponse.json(
    {
      error: `${feature} is not available in self-hosted (SQLite) mode.`,
      message:
        `${feature} requires the Supabase-backed database. This deployment runs ` +
        `in SQLite mode, which stores packaging jobs and upload history only.`,
      selfHostedUnsupported: true,
    },
    { status: 501 }
  );
}
