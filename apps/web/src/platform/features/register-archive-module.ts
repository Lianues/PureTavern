import type { FeatureInstallContext } from './feature-module';
import { archiveParticipantRegistryCapability } from './standard-capabilities';

export interface ArchiveModuleDescriptor {
  moduleId: string;
  displayName: string;
  dataVersion?: number;
  sensitive?: boolean;
  defaultSelected?: boolean;
}

export function registerArchiveModule(
  context: FeatureInstallContext,
  descriptor: ArchiveModuleDescriptor,
): void {
  context.capabilities.get(archiveParticipantRegistryCapability)?.registerModule({
    moduleId: descriptor.moduleId,
    displayName: descriptor.displayName,
    dataVersion: descriptor.dataVersion ?? 1,
    sensitive: descriptor.sensitive ?? false,
    defaultSelected: descriptor.defaultSelected ?? true,
    records: context.records,
    blobs: context.blobs,
  });
}
