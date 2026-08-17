import type { MediaCategory, ProcessingAction } from "@/lib/media-domain";

export type ProviderStatus =
  | "not_configured"
  | "disabled"
  | "ready"
  | "syncing"
  | "healthy"
  | "failed";

export type ProviderResult<T> =
  | { ok: true; data: T; externalId?: string }
  | { ok: false; safeErrorCode: string; retryable: boolean };

export interface VehicleDataProvider {
  readonly key: string;
  decodeVin(vin: string): Promise<ProviderResult<NormalizedVehicleData>>;
}

export interface InventoryImportProvider {
  readonly key: string;
  listChangedVehicles(
    cursor?: string,
  ): Promise<ProviderResult<{ vehicles: ImportedVehicle[]; nextCursor?: string }>>;
}

export interface InventoryPublishingProvider {
  readonly key: string;
  publishVehicle(vehicle: PublishableVehicle): Promise<ProviderResult<{ publishedAt: string }>>;
  unpublishVehicle(externalVehicleId: string): Promise<ProviderResult<{ unpublishedAt: string }>>;
}

export interface MediaPublishingProvider {
  readonly key: string;
  publishApprovedMedia(input: {
    externalVehicleId: string;
    media: PublishableMedia[];
  }): Promise<ProviderResult<{ publishedCount: number }>>;
}

export interface MediaProcessor {
  readonly key: string;
  process(input: {
    originalUrl: string;
    category: MediaCategory;
    action: ProcessingAction;
    options: Record<string, unknown>;
  }): Promise<ProviderResult<{ variantUrl: string }>>;
}

export type NormalizedVehicleData = {
  year?: number;
  make?: string;
  model?: string;
  trim?: string;
  series?: string;
  bodyStyle?: string;
  engine?: string;
  transmission?: string;
  drivetrain?: string;
  fuelType?: string;
  exteriorColor?: string;
  interiorColor?: string;
  equipment?: Array<{ category: string; code?: string; label: string; value?: string }>;
  warranty?: Record<string, number | string | null>;
};

export type ImportedVehicle = NormalizedVehicleData & {
  sourceExternalId: string;
  vin?: string;
  stockNumber?: string;
  sourceUpdatedAt?: string;
};

export type PublishableVehicle = {
  internalId: string;
  sourceExternalId?: string;
  vin?: string;
  stockNumber?: string;
  fields: Record<string, unknown>;
};

export type PublishableMedia = {
  internalId: string;
  approvedVariantUrl: string;
  order: number;
  label?: string;
};
