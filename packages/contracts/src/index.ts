export type ModuleStatus =
  | 'inventory'
  | 'designed'
  | 'legacy-hosted'
  | 'migrating'
  | 'browser-ready'
  | 'backend-optional'
  | 'completed'
  | 'removed'
  | 'deferred';

export interface ModuleStateContract {
  moduleId: string;
  version: number;
  status: ModuleStatus;
  updatedAt: string;
  details?: string;
}
