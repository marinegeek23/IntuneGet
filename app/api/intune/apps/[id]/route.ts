/**
 * Intune App Details API Route
 * Gets details for a specific Win32 app including assignments
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantForRequest, hasActiveTenantConsent } from '@/lib/msp/tenant-resolution';
import { parseAccessToken } from '@/lib/auth-utils';
import { getServicePrincipalToken } from '@/lib/intune/graph-client';
import type { IntuneAppWithAssignments, IntuneAppAssignment } from '@/types/inventory';

const GRAPH_API_BASE = 'https://graph.microsoft.com/beta';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    // Verify admin consent
    const mspTenantId = request.headers.get('X-MSP-Tenant-Id');

    const tenantResolution = await resolveTenantForRequest({
      userId: user.userId,
      tokenTenantId: user.tenantId,
      requestedTenantId: mspTenantId,
    });

    if (tenantResolution.errorResponse) {
      return tenantResolution.errorResponse;
    }

    const tenantId = tenantResolution.tenantId;

    if (!(await hasActiveTenantConsent(tenantId))) {
      return NextResponse.json(
        { error: 'Admin consent not found' },
        { status: 403 }
      );
    }

    // Get service principal token
    const graphToken = await getServicePrincipalToken(tenantId);

    if (!graphToken) {
      return NextResponse.json(
        { error: 'Failed to get Graph API token' },
        { status: 500 }
      );
    }

    // Fetch app details and assignments in parallel
    const [appResponse, assignmentsResponse] = await Promise.all([
      fetch(`${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${id}`, {
        headers: {
          Authorization: `Bearer ${graphToken}`,
          'Content-Type': 'application/json',
        },
      }),
      fetch(`${GRAPH_API_BASE}/deviceAppManagement/mobileApps/${id}/assignments`, {
        headers: {
          Authorization: `Bearer ${graphToken}`,
          'Content-Type': 'application/json',
        },
      }),
    ]);

    if (!appResponse.ok) {
      if (appResponse.status === 404) {
        return NextResponse.json(
          { error: 'App not found' },
          { status: 404 }
        );
      }
      return NextResponse.json(
        { error: 'Failed to fetch app details' },
        { status: appResponse.status }
      );
    }

    const appData = await appResponse.json();
    let assignments: IntuneAppAssignment[] = [];

    if (assignmentsResponse.ok) {
      const assignmentsData = await assignmentsResponse.json();
      assignments = assignmentsData.value || [];
    }

    const app: IntuneAppWithAssignments = {
      ...appData,
      assignments,
    };

    return NextResponse.json({ app });
  } catch {
    return NextResponse.json(
      { error: 'Failed to fetch app details' },
      { status: 500 }
    );
  }
}
