/**
 * Intune Categories API Route
 * Fetches available Intune mobile app categories for deployment configuration
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantForRequest, hasActiveTenantConsent } from '@/lib/msp/tenant-resolution';
import { parseAccessToken } from '@/lib/auth-utils';
import { getMobileAppCategories } from '@/lib/intune-api';
import { getServicePrincipalToken } from '@/lib/intune/graph-client';

export async function GET(request: NextRequest) {
  try {
    const user = await parseAccessToken(request.headers.get('Authorization'));
    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

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
        { error: 'Admin consent not found. Please complete the admin consent flow.' },
        { status: 403 }
      );
    }

    const graphToken = await getServicePrincipalToken(tenantId);
    if (!graphToken) {
      return NextResponse.json(
        { error: 'Failed to get Graph API token' },
        { status: 500 }
      );
    }

    const categories = await getMobileAppCategories(graphToken);

    return NextResponse.json({
      categories,
      count: categories.length,
    });
  } catch {
    return NextResponse.json(
      { error: 'Failed to fetch Intune app categories' },
      { status: 500 }
    );
  }
}
