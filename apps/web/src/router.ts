import { createMemoryHistory, createRouter } from 'vue-router';

import ModernStatusView from './modern/ModernStatusView.vue';

export const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    {
      path: '/',
      name: 'modern-status',
      component: ModernStatusView,
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
});
