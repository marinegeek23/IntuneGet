import { NextResponse } from 'next/server';
import { createServerClient, isSupabaseConfigured } from '@/lib/supabase';
import { canAccessPrimaryTenant, type AccessMode } from '@/lib/msp-permissions';

interface ResolveTargetTenantInput {
  supabase: ReturnType<typeof createServerClient>;
  userId: string;
  tokenTenantId: string;
  requestedTenantId: string | null;
}

interface ResolveTargetTenantResult {
  tenantId: string;
  errorResponse: NextResponse | null;
}

interface MembershipWithOrg {
  access_mode: AccessMode;
  msp_organization_id: string;
  msp_organizations: {
    primary_tenant_id: string;
  };
}

const CUSTOMER_ONLY_ERROR =
  'Your MSP membership is limited to customer tenants. Select a customer tenant to continue.';

/**
 * Resolve the effective tenant for MSP users and enforce tenant access checks.
 * Falls back to token tenant when no override is requested.
 *
 * For members with access_mode 'customer_only', the MSP organization's primary
 * tenant is rejected regardless of how it was targeted (explicit header or the
 * token tenant fallback), since every member's token tenant is the primary
 * tenant.
 */
export async function resolveTargetTenantId({
  supabase,
  userId,
  tokenTenantId,
  requestedTenantId,
}: ResolveTargetTenantInput): Promise<ResolveTargetTenantResult> {
  const { data: membershipData } = await supabase
    .from('msp_user_memberships')
    .select('access_mode, msp_organization_id, msp_organizations!inner(primary_tenant_id)')
    .eq('user_id', userId)
    .single();

  const membership = membershipData as unknown as MembershipWithOrg | null;

  const targetTenantId = requestedTenantId || tokenTenantId;

  // Members limited to customer tenants can never target the org's primary tenant
  if (
    membership &&
    !canAccessPrimaryTenant(membership.access_mode) &&
    targetTenantId === membership.msp_organizations.primary_tenant_id
  ) {
    return {
      tenantId: tokenTenantId,
      errorResponse: NextResponse.json(
        { error: CUSTOMER_ONLY_ERROR },
        { status: 403 }
      ),
    };
  }

  if (targetTenantId === tokenTenantId) {
    return { tenantId: tokenTenantId, errorResponse: null };
  }

  if (!membership) {
    return {
      tenantId: tokenTenantId,
      errorResponse: NextResponse.json(
        { error: 'Not authorized to access other tenants' },
        { status: 403 }
      ),
    };
  }

  const { data: managedTenant } = await supabase
    .from('msp_managed_tenants')
    .select('id')
    .eq('msp_organization_id', membership.msp_organization_id)
    .eq('tenant_id', targetTenantId)
    .eq('consent_status', 'granted')
    .eq('is_active', true)
    .single();

  if (!managedTenant) {
    return {
      tenantId: tokenTenantId,
      errorResponse: NextResponse.json(
        { error: 'Target tenant is not managed by your MSP organization or has not granted consent' },
        { status: 403 }
      ),
    };
  }

  return { tenantId: targetTenantId, errorResponse: null };
}

/**
 * Request-level tenant resolution that is safe in both database modes.
 *
 * Self-hosted sqlite deployments have no Supabase, which backs MSP membership
 * and managed-tenant records. createServerClient() throws outright when it is
 * not configured, so routes must not construct a client just to resolve a
 * tenant. In sqlite mode there is exactly one tenant - the signed-in user's -
 * so the token tenant is authoritative and no lookup is required.
 *
 * Prefer this over calling resolveTargetTenantId() with an eagerly-created
 * client; it keeps every route working in both modes without each one
 * repeating the mode check.
 */
export async function resolveTenantForRequest({
  userId,
  tokenTenantId,
  requestedTenantId,
}: Omit<ResolveTargetTenantInput, 'supabase'>): Promise<ResolveTargetTenantResult> {
  if (!isSupabaseConfigured()) {
    return { tenantId: tokenTenantId, errorResponse: null };
  }

  return resolveTargetTenantId({
    supabase: createServerClient(),
    userId,
    tokenTenantId,
    requestedTenantId,
  });
}

/**
 * Check whether a tenant has an active admin-consent record.
 *
 * The tenant_consent table only exists in Supabase deployments. In sqlite mode
 * there is no consent cache to consult, and consent is instead proven by the
 * service-principal token acquisition that every caller performs immediately
 * after this check - Entra will not issue an app-only token with the required
 * roles unless admin consent was actually granted. Returning true here defers
 * to that stronger, live check rather than blocking on a table that cannot
 * exist.
 */
export async function hasActiveTenantConsent(tenantId: string): Promise<boolean> {
  if (!isSupabaseConfigured()) {
    return true;
  }

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from('tenant_consent')
    .select('tenant_id')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .single();

  return Boolean(!error && data);
}
