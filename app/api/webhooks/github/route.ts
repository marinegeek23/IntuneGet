/**
 * GitHub Webhook Handler
 * Processes /implemented and /declined commands on app-request issues.
 */

import crypto from 'crypto';
import { supabaseOnlyGuard } from '@/lib/api/supabase-only';
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';
import { addIssueComment, closeIssueWithLabel } from '@/lib/github-issues';

const VALID_COMMANDS = {
  '/implemented': { status: 'implemented' as const, label: 'implemented' },
  '/declined': { status: 'rejected' as const, label: 'declined' },
};

function verifyGitHubSignature(body: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (sigBuffer.length !== expectedBuffer.length) return false;

  return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
}

export async function POST(request: NextRequest) {
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('GITHUB_WEBHOOK_SECRET is not configured');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  // Verify signature
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');

  if (!verifyGitHubSignature(rawBody, signature, webhookSecret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Only process issue_comment events
  const event = request.headers.get('x-github-event');
  if (event !== 'issue_comment') {
    return NextResponse.json({ message: `Ignored event: ${event}` }, { status: 200 });
  }

  const payload = JSON.parse(rawBody);

  // Only process newly created comments
  if (payload.action !== 'created') {
    return NextResponse.json({ message: 'Ignored action' }, { status: 200 });
  }

  // Parse command from comment body
  const commentBody = (payload.comment?.body || '').trim();
  const command = Object.keys(VALID_COMMANDS).find((cmd) => commentBody.startsWith(cmd));

  if (!command) {
    return NextResponse.json({ message: 'No command found' }, { status: 200 });
  }

  // Verify the commenter is the repo owner
  const commenter = payload.comment?.user?.login;
  const owner = process.env.GITHUB_OWNER;

  if (!owner || commenter !== owner) {
    return NextResponse.json({ message: 'Unauthorized user' }, { status: 200 });
  }

  // Check that the issue has the app-request label
  const issueLabels: string[] = (payload.issue?.labels || []).map(
    (l: { name: string }) => l.name
  );
  if (!issueLabels.includes('app-request')) {
    return NextResponse.json({ message: 'Not an app-request issue' }, { status: 200 });
  }

  const issueNumber: number = payload.issue?.number;
  if (!issueNumber) {
    return NextResponse.json({ error: 'Missing issue number' }, { status: 400 });
  }

  const { status, label } = VALID_COMMANDS[command as keyof typeof VALID_COMMANDS];

  // Look up the suggestion in Supabase
  const guard = supabaseOnlyGuard('GitHub webhook intake');
  if (guard) return guard;

  const supabase = createServerClient();
  const { data: suggestion, error: lookupError } = await supabase
    .from('app_suggestions')
    .select('id, winget_id, status')
    .eq('github_issue_number', issueNumber)
    .single();

  if (lookupError || !suggestion) {
    console.error('Suggestion not found for issue #' + issueNumber, lookupError);
    return NextResponse.json({ error: 'Suggestion not found' }, { status: 404 });
  }

  // Update the suggestion status
  const { error: updateError } = await supabase
    .from('app_suggestions')
    .update({
      status,
      reviewed_at: new Date().toISOString(),
      reviewed_by: commenter,
    })
    .eq('id', suggestion.id);

  if (updateError) {
    console.error('Failed to update suggestion:', updateError);
    return NextResponse.json({ error: 'Failed to update suggestion' }, { status: 500 });
  }

  // Post confirmation comment and close the issue with label
  try {
    const confirmationMessage = `Status updated to **${status}** for \`${suggestion.winget_id}\`.`;
    await Promise.all([
      addIssueComment(issueNumber, confirmationMessage),
      closeIssueWithLabel(issueNumber, label),
    ]);
  } catch (githubError) {
    console.error('Failed to update GitHub issue:', githubError);
    // The Supabase update succeeded, so return success but log the GitHub error
  }

  return NextResponse.json({
    message: `Suggestion ${suggestion.winget_id} updated to ${status}`,
  });
}
