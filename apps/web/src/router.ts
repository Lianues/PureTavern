import { createRouter, createWebHistory } from 'vue-router';

import LegacyUiView from './legacy-host/LegacyUiView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'legacy-ui',
      component: LegacyUiView,
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
});
