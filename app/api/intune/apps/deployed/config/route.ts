import { NextRequest, NextResponse } from 'next/server';
import { createServerClient, isSupabaseConfigured } from '@/lib/supabase';
import { getDatabase } from '@/lib/db';
import { parseAccessToken } from '@/lib/auth-utils';
import { resolveTargetTenantId } from '@/lib/msp/tenant-resolution';

export async function GET(request: NextRequest) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const wingetId = searchParams.get('wingetId');

    if (!wingetId) {
      return NextResponse.json(
        { error: 'wingetId parameter required' },
        { status: 400 }
      );
    }

    // Self-hosted sqlite deployments have no Supabase - same pattern as the
    // sibling /api/intune/apps/deployed route.
    let tenantId = user.tenantId;

    if (isSupabaseConfigured()) {
      const supabase = createServerClient();
      const mspTenantId = request.headers.get('X-MSP-Tenant-Id');

      const tenantResolution = await resolveTargetTenantId({
        supabase,
        userId: user.userId,
        tokenTenantId: user.tenantId,
        requestedTenantId: mspTenantId,
      });

      if (tenantResolution.errorResponse) {
        return tenantResolution.errorResponse;
      }

      tenantId = tenantResolution.tenantId;
    }

    if (!isSupabaseConfigured()) {
      const db = getDatabase();

      // Resolve through upload_history: it is the durable record of what is
      // deployed. Scanning packaging_jobs instead would lose the saved config
      // as soon as the user clears the Uploads list, because that soft-archives
      // job rows and getByUserId hides them.
      const history = await db.uploadHistory.getByUserId(user.userId, 1000);
      const deployment = history
        .filter((h) => h.winget_id === wingetId && (h.intune_tenant_id ?? '') === tenantId)
        .sort((a, b) => (b.deployed_at || '').localeCompare(a.deployed_at || ''))[0];

      // getById does not filter archived rows, so the configuration survives.
      let job = deployment?.packaging_job_id
        ? await db.jobs.getById(deployment.packaging_job_id)
        : null;

      if (!job?.package_config) {
        const jobs = await db.jobs.getByUserId(user.userId, 1000);
        job =
          jobs
            .filter(
              (j) =>
                (j.tenant_id ?? '') === tenantId &&
                j.winget_id === wingetId &&
                j.status === 'deployed' &&
                j.package_config
            )
            .sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''))[0] || null;
      }

      if (!deployment && !job) {
        return NextResponse.json({
          config: null,
          deployedAt: null,
          intuneAppId: null,
        });
      }

      return NextResponse.json({
        config: job?.package_config ?? null,
        deployedAt: deployment?.deployed_at ?? job?.completed_at ?? null,
        intuneAppId: deployment?.intune_app_id ?? job?.intune_app_id ?? null,
      });
    }

    const supabase = createServerClient();

    // Get the most recent successfully deployed job's package_config
    const { data, error } = await supabase
      .from('packaging_jobs')
      .select('package_config, completed_at, intune_app_id')
      .eq('user_id', user.userId)
      .eq('tenant_id', tenantId)
      .eq('winget_id', wingetId)
      .eq('status', 'deployed')
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      return NextResponse.json({
        config: null,
        deployedAt: null,
        intuneAppId: null,
      });
    }

    return NextResponse.json({
      config: data.package_config,
      deployedAt: data.completed_at,
      intuneAppId: data.intune_app_id || null,
    });
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
