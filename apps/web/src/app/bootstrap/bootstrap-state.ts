import type { InjectionKey } from 'vue';

import type { ApplicationBootstrapState } from './bootstrap';

export const bootstrapStateKey: InjectionKey<Readonly<ApplicationBootstrapState>> =
  Symbol('bootstrap-state');
