declare module "*operator-routes.js" {
  export interface OriginalRouteAlias {
    route: string;
    detailId?: string;
    detailTab?: string;
  }

  export interface ResolvedOriginalRouteAlias extends OriginalRouteAlias {
    organizationSlug: string | null;
  }

  export function originalRouteAlias(segments: string[]): OriginalRouteAlias | null;

  export function resolveOriginalRouteAlias(segments: string[]): ResolvedOriginalRouteAlias | null;
}
